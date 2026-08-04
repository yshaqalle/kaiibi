// The ONLY write path for the platform admin portal.
//
// None of the billing tables have an insert/update/delete policy for anyone
// (migration 20260818000000), so a client cannot change a subscription even
// with a valid operator session -- it has to come through here, where authority
// is re-checked against the database and the change is written to an
// append-only audit log in the same request.
//
// Security shape copied deliberately from provision-staff/index.ts: the
// caller's own JWT goes to an anon client for getUser(), and a separate
// service-role client does the privileged work. The service-role client is
// never asked "who is this" and the caller client is never asked to do
// anything.
import { createClient } from 'jsr:@supabase/supabase-js@2';

type Action =
  | 'set_plan'
  | 'extend_trial'
  | 'record_payment'
  | 'suspend'
  | 'unsuspend'
  | 'grant_override'
  | 'revoke_override'
  | 'upsert_plan'
  | 'set_platform_settings'
  | 'approve_plan_change'
  | 'decline_plan_change';

type RequestBody = {
  action: Action;
  reason: string;
  shopId?: string;
  planKey?: string;
  days?: number;
  payment?: { amountCents: number; currency?: string; method?: string; providerRef?: string; paidAt?: string; coversFrom?: string; coversTo?: string; note?: string };
  override?: { kind: 'module' | 'limit'; key: string; value?: unknown; expiresAt?: string | null };
  plan?: Record<string, unknown>;
  settings?: Record<string, unknown>;
  requestId?: string;
};

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function errorResponse(status: number, error: string, message: string) {
  return new Response(JSON.stringify({ error, message }), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  });
}

function ok(payload: unknown) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });
  if (req.method !== 'POST') return errorResponse(405, 'unknown', 'Method not allowed.');

  let body: RequestBody;
  try {
    body = await req.json();
  } catch {
    return errorResponse(400, 'unknown', 'Invalid JSON body.');
  }

  const { action, reason } = body;
  if (!action) return errorResponse(400, 'unknown', 'action is required.');
  // Required on every action, not just the destructive ones. An audit trail
  // that records what happened but not why answers the easy question and not
  // the one asked during an investigation.
  if (!reason?.trim()) return errorResponse(400, 'reason_required', 'A reason is required for every change.');

  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return errorResponse(401, 'forbidden', 'Missing Authorization header.');

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

  const callerClient = createClient(supabaseUrl, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: callerData, error: callerError } = await callerClient.auth.getUser();
  if (callerError || !callerData.user) return errorResponse(401, 'forbidden', 'Could not verify caller.');

  // Asked of the DATABASE, using the caller's own client, so is_platform_admin()
  // evaluates against the caller's real JWT -- including its `aal` claim. This
  // is the MFA check: doing it with the service-role client instead would make
  // auth.uid() null and auth.jwt() empty, and the whole second factor would
  // silently evaporate. That subtlety is the reason this one check does not use
  // adminClient like everything else below.
  const { data: isAdmin, error: adminCheckError } = await callerClient.rpc('is_platform_admin');
  if (adminCheckError) return errorResponse(500, 'unknown', adminCheckError.message);
  if (!isAdmin) {
    // Deliberately does not distinguish "not an operator" from "operator
    // without MFA" -- the portal's sign-in screen asks
    // is_platform_admin_pending_mfa() itself for that. This endpoint tells an
    // unauthenticated prober nothing about who is on staff.
    return errorResponse(403, 'forbidden', 'Not authorized.');
  }

  const adminClient = createClient(supabaseUrl, serviceRoleKey);
  const actorId = callerData.user.id;
  const ip = req.headers.get('x-forwarded-for') ?? null;

  // Snapshot before, apply, snapshot after, log. The log write is part of the
  // request rather than fire-and-forget: an unlogged change is worse than a
  // refused one, so if the audit insert fails the caller hears about it.
  const audit = async (action: string, targetShopId: string | null, before: unknown, after: unknown) => {
    const { error } = await adminClient.from('platform_audit_log').insert({
      actor_user_id: actorId,
      action,
      target_shop_id: targetShopId,
      before,
      after,
      reason: reason.trim(),
      ip,
    });
    if (error) throw new Error(`audit write failed: ${error.message}`);
  };

  const loadSubscription = async (shopId: string) => {
    const { data, error } = await adminClient.from('shop_subscriptions').select('*').eq('shop_id', shopId).maybeSingle();
    if (error) throw new Error(error.message);
    return data;
  };

  try {
    switch (action) {
      case 'set_plan': {
        if (!body.shopId || !body.planKey) return errorResponse(400, 'unknown', 'shopId and planKey are required.');
        const { data: plan, error: planError } = await adminClient.from('plans').select('id, key').eq('key', body.planKey).maybeSingle();
        if (planError) return errorResponse(500, 'unknown', planError.message);
        if (!plan) return errorResponse(400, 'unknown', 'No such plan.');

        const before = await loadSubscription(body.shopId);
        const { data: after, error } = await adminClient
          .from('shop_subscriptions')
          .update({ plan_id: plan.id, updated_at: new Date().toISOString() })
          .eq('shop_id', body.shopId)
          .select('*')
          .single();
        if (error) return errorResponse(500, 'unknown', error.message);
        await audit('set_plan', body.shopId, before, after);
        return ok({ subscription: after });
      }

      case 'extend_trial': {
        if (!body.shopId || !body.days) return errorResponse(400, 'unknown', 'shopId and days are required.');
        const before = await loadSubscription(body.shopId);
        if (!before) return errorResponse(400, 'unknown', 'That shop has no subscription.');

        // Extends from whichever is later: the current trial end, or now. A
        // trial that lapsed three weeks ago extended by 14 days should give
        // 14 days from today, not expire again 7 days ago.
        const base = before.trial_ends_at && new Date(before.trial_ends_at) > new Date() ? new Date(before.trial_ends_at) : new Date();
        const trialEnd = new Date(base.getTime() + body.days * 86_400_000);
        const { data: settings } = await adminClient.from('platform_settings').select('default_grace_days').eq('id', true).maybeSingle();
        const graceDays = settings?.default_grace_days ?? 7;

        const { data: after, error } = await adminClient
          .from('shop_subscriptions')
          .update({
            trial_ends_at: trialEnd.toISOString(),
            grace_until: new Date(trialEnd.getTime() + graceDays * 86_400_000).toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq('shop_id', body.shopId)
          .select('*')
          .single();
        if (error) return errorResponse(500, 'unknown', error.message);
        await audit('extend_trial', body.shopId, before, after);
        return ok({ subscription: after });
      }

      case 'record_payment': {
        if (!body.shopId || !body.payment) return errorResponse(400, 'unknown', 'shopId and payment are required.');
        const p = body.payment;
        const before = await loadSubscription(body.shopId);

        const { error: payError } = await adminClient.from('subscription_payments').insert({
          shop_id: body.shopId,
          provider: 'manual',
          provider_ref: p.providerRef ?? null,
          amount_cents: p.amountCents,
          currency: p.currency ?? 'USD',
          method: p.method ?? null,
          paid_at: p.paidAt ?? new Date().toISOString(),
          covers_from: p.coversFrom ?? null,
          covers_to: p.coversTo ?? null,
          note: p.note ?? null,
          recorded_by: actorId,
        });
        if (payError) return errorResponse(500, 'unknown', payError.message);

        // Recording money received is what moves the period. Same
        // later-of-the-two rule as extend_trial, so paying a month late buys a
        // month from today rather than a month that already elapsed.
        let after = before;
        if (p.coversTo) {
          const graceRes = await adminClient.from('platform_settings').select('default_grace_days').eq('id', true).maybeSingle();
          const graceDays = graceRes.data?.default_grace_days ?? 7;
          const coversTo = new Date(p.coversTo);
          const { data: updated, error } = await adminClient
            .from('shop_subscriptions')
            .update({
              current_period_end: coversTo.toISOString(),
              grace_until: new Date(coversTo.getTime() + graceDays * 86_400_000).toISOString(),
              updated_at: new Date().toISOString(),
            })
            .eq('shop_id', body.shopId)
            .select('*')
            .single();
          if (error) return errorResponse(500, 'unknown', error.message);
          after = updated;
        }
        await audit('record_payment', body.shopId, before, { subscription: after, payment: p });
        return ok({ subscription: after });
      }

      case 'suspend':
      case 'unsuspend': {
        if (!body.shopId) return errorResponse(400, 'unknown', 'shopId is required.');
        const before = await loadSubscription(body.shopId);
        const { data: after, error } = await adminClient
          .from('shop_subscriptions')
          .update({ manual_status: action === 'suspend' ? 'suspended' : 'active', updated_at: new Date().toISOString() })
          .eq('shop_id', body.shopId)
          .select('*')
          .single();
        if (error) return errorResponse(500, 'unknown', error.message);
        await audit(action, body.shopId, before, after);
        return ok({ subscription: after });
      }

      case 'grant_override': {
        if (!body.shopId || !body.override) return errorResponse(400, 'unknown', 'shopId and override are required.');
        const o = body.override;
        const { data: after, error } = await adminClient
          .from('shop_entitlement_overrides')
          .upsert(
            {
              shop_id: body.shopId,
              kind: o.kind,
              key: o.key,
              value: o.value ?? null,
              expires_at: o.expiresAt ?? null,
              reason: reason.trim(),
              granted_by: actorId,
            },
            { onConflict: 'shop_id,kind,key' }
          )
          .select('*')
          .single();
        if (error) return errorResponse(500, 'unknown', error.message);
        await audit('grant_override', body.shopId, null, after);
        return ok({ override: after });
      }

      case 'revoke_override': {
        if (!body.shopId || !body.override) return errorResponse(400, 'unknown', 'shopId and override are required.');
        const { data: before } = await adminClient
          .from('shop_entitlement_overrides')
          .select('*')
          .eq('shop_id', body.shopId)
          .eq('kind', body.override.kind)
          .eq('key', body.override.key)
          .maybeSingle();
        const { error } = await adminClient
          .from('shop_entitlement_overrides')
          .delete()
          .eq('shop_id', body.shopId)
          .eq('kind', body.override.kind)
          .eq('key', body.override.key);
        if (error) return errorResponse(500, 'unknown', error.message);
        await audit('revoke_override', body.shopId, before, null);
        return ok({ revoked: true });
      }

      case 'upsert_plan': {
        if (!body.plan) return errorResponse(400, 'unknown', 'plan is required.');
        const key = body.plan.key as string | undefined;
        if (!key) return errorResponse(400, 'unknown', 'plan.key is required.');
        const { data: before } = await adminClient.from('plans').select('*').eq('key', key).maybeSingle();
        const { data: after, error } = await adminClient
          .from('plans')
          .upsert({ ...body.plan, updated_at: new Date().toISOString() }, { onConflict: 'key' })
          .select('*')
          .single();
        if (error) return errorResponse(500, 'unknown', error.message);
        // No target shop: editing a plan changes entitlements for every shop on
        // it at once, which is exactly why the portal shows how many that is
        // before saving.
        await audit('upsert_plan', null, before, after);
        return ok({ plan: after });
      }

      case 'set_platform_settings': {
        if (!body.settings) return errorResponse(400, 'unknown', 'settings is required.');
        const { data: before } = await adminClient.from('platform_settings').select('*').eq('id', true).maybeSingle();
        const { data: after, error } = await adminClient
          .from('platform_settings')
          .update({ ...body.settings, updated_at: new Date().toISOString() })
          .eq('id', true)
          .select('*')
          .single();
        if (error) return errorResponse(500, 'unknown', error.message);
        await audit('set_platform_settings', null, before, after);
        return ok({ settings: after });
      }

      case 'approve_plan_change':
      case 'decline_plan_change': {
        if (!body.requestId) return errorResponse(400, 'unknown', 'requestId is required.');
        const { data: request, error: requestError } = await adminClient
          .from('plan_change_requests')
          .select('*')
          .eq('id', body.requestId)
          .maybeSingle();
        if (requestError) return errorResponse(500, 'unknown', requestError.message);
        if (!request) return errorResponse(400, 'unknown', 'No such request.');
        // Guards the double-approve: two operators with the queue open, both
        // clicking. Without it the second one re-applies a decision that has
        // already been made and logs it as if it were new.
        if (request.status !== 'pending') {
          return errorResponse(409, 'already_decided', `That request was already ${request.status}.`);
        }

        const before = await loadSubscription(request.shop_id);
        let after = before;

        if (action === 'approve_plan_change') {
          const { data: updated, error } = await adminClient
            .from('shop_subscriptions')
            .update({ plan_id: request.requested_plan_id, updated_at: new Date().toISOString() })
            .eq('shop_id', request.shop_id)
            .select('*')
            .single();
          if (error) return errorResponse(500, 'unknown', error.message);
          after = updated;
        }

        const { error: closeError } = await adminClient
          .from('plan_change_requests')
          .update({
            status: action === 'approve_plan_change' ? 'approved' : 'declined',
            decided_by: actorId,
            decided_at: new Date().toISOString(),
            decision_note: reason.trim(),
          })
          .eq('id', body.requestId);
        if (closeError) return errorResponse(500, 'unknown', closeError.message);

        await audit(action, request.shop_id, before, after);
        return ok({ subscription: after });
      }

      default:
        return errorResponse(400, 'unknown', `Unknown action: ${action}`);
    }
  } catch (err) {
    return errorResponse(500, 'unknown', err instanceof Error ? err.message : 'Unexpected failure.');
  }
});
