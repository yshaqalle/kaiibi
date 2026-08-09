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
  | 'retire_plan'
  | 'republish_plan'
  | 'publish_plan'
  | 'archive_plan'
  | 'restore_plan'
  | 'set_platform_settings'
  | 'approve_plan_change'
  | 'decline_plan_change'
  | 'delete_shop';

type RequestBody = {
  action: Action;
  reason: string;
  shopId?: string;
  planKey?: string;
  days?: number;
  payment?: {
    amountCents: number;
    currency?: string;
    method?: string;
    providerRef?: string;
    paidAt?: string;
    coversFrom?: string;
    coversTo?: string;
    note?: string;
    // Converts a trialing shop into a paying one straight away by ending the
    // trial early. Without it, a shop that pays mid-trial keeps reading as
    // `trialing` at zero MRR until their free window runs out, because
    // shop_effective_status checks the trial before the paid period.
    endTrialNow?: boolean;
  };
  override?: { kind: 'module' | 'limit'; key: string; value?: unknown; expiresAt?: string | null };
  plan?: Record<string, unknown>;
  // upsert_plan only. When set, the upsert must INSERT: an existing key is a
  // 409 rather than a silent overwrite, the key shape is validated, and the
  // row is forced non-public so a new plan can never appear in the store
  // picker before an operator has looked at its card and published it.
  create?: boolean;
  // retire_plan / republish_plan. successorPlanKey is where the stores on this
  // plan land when retireAt passes; postTrialPlanKey is only used when the plan
  // being retired is the platform-wide fallback (see the case below).
  successorPlanKey?: string;
  retireAt?: string;
  postTrialPlanKey?: string;
  settings?: Record<string, unknown>;
  requestId?: string;
  // The shop's exact name, retyped by the operator. Only used by delete_shop.
  confirmName?: string;
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
        const { data: plan, error: planError } = await adminClient.from('plans').select('id, key, name, retire_at, active').eq('key', body.planKey).maybeSingle();
        if (planError) return errorResponse(500, 'unknown', planError.message);
        if (!plan) return errorResponse(400, 'unknown', 'No such plan.');
        // Same hole approve_plan_change was hardened against: a retiring plan
        // is on its way out precisely so no more stores land on it. Without
        // this, an operator (or a client calling this endpoint directly) could
        // move a store onto a plan mid-sunset by a path that skips the queue
        // entirely.
        if (plan.retire_at) {
          return errorResponse(
            409,
            'plan_retiring',
            `${plan.name} is being retired, so stores cannot be moved onto it. Move them to its successor instead.`
          );
        }
        // An archived retired plan is already caught by the retire_at guard
        // above (nothing but republish clears retire_at), but an archived
        // never-launched draft has retire_at = null and would slip through --
        // pointing a subscription at an inactive plan by a path that skips
        // every archive_plan guard.
        if (!plan.active) {
          return errorResponse(409, 'plan_archived', `${plan.name} is archived, so stores cannot be moved onto it.`);
        }

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

        // The fairness rule the drawer already applies, enforced where it
        // cannot be edited around: paid time starts when free time ends. A
        // store that pays 40 days into a 90-day trial buys a month AFTER the
        // trial, not a month that overlaps days they already had. endTrialNow
        // is the deliberate opt-out, for a store that asks to convert early.
        if (p.coversTo && !p.endTrialNow && before?.trial_ends_at) {
          const trialEnd = new Date(before.trial_ends_at);
          if (trialEnd > new Date() && new Date(p.coversTo) < trialEnd) {
            return errorResponse(
              400,
              'covers_to_before_trial_end',
              `Cover cannot end before their trial does on ${trialEnd.toISOString().slice(0, 10)}. Tick "start paying today" if they asked to convert early.`
            );
          }
        }

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
              // Closing the trial is what actually flips the status to
              // `active`, so an early converter is recognised as paying from
              // the day they paid rather than the day their trial happened to
              // run out.
              ...(p.endTrialNow ? { trial_ends_at: new Date().toISOString() } : {}),
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

        // Allowlist, not a spread. Retirement has its own audited action
        // (retire_plan / republish_plan) and must not be settable here:
        // `retire_at` and `successor_plan_key` sent through this path would set
        // a retirement with no successor validation, which is exactly how a
        // two-hop chain gets created -- and shop_effective_plan() follows only
        // one hop. `is_public` is the other half of that same state (retiring
        // clears it, republishing restores it) and is likewise never accepted
        // here: publishing goes through publish_plan and its guards or not at
        // all. Create mode is the one place this handler touches the column,
        // and only to force it FALSE -- a new plan is born hidden as a server
        // property, not a portal convention. `active` belongs to
        // archive_plan / restore_plan for the same reason.
        const editable = ['key', 'name', 'description', 'price_cents', 'currency', 'billing_interval', 'modules', 'limits', 'sort_order'] as const;
        const planPayload: Record<string, unknown> = {};
        for (const column of editable) {
          if (column in body.plan) planPayload[column] = body.plan[column];
        }

        const { data: before, error: beforeError } = await adminClient.from('plans').select('*').eq('key', key).maybeSingle();
        if (beforeError) return errorResponse(500, 'unknown', beforeError.message);

        if (body.create) {
          // The key becomes the audit and billing identifier and can never
          // change, so a typo'd shape is refused rather than lived with.
          if (!/^[a-z][a-z0-9_]*$/.test(key)) {
            return errorResponse(400, 'unknown', 'Plan keys are lowercase letters, digits and underscores, starting with a letter.');
          }
          // Without this, typing `standard` into the create sheet would
          // silently rewrite Standard for every store on it.
          if (before) {
            return errorResponse(409, 'key_exists', `A plan with key \`${key}\` already exists.`);
          }
          planPayload.is_public = false;
        }

        if (!body.create) {
          // Without this, an edit-shaped call with an unknown key would
          // INSERT (upsert semantics) a row born with the column default
          // is_public = true -- the exact public-before-reviewed path create
          // mode exists to close. Editing creates nothing.
          if (!before) {
            return errorResponse(400, 'unknown', 'No such plan. Pass create: true to create one.');
          }
          // updated_at is the archived strip's "archived" date, and the strip
          // offers no Edit -- keep that honest server-side too.
          if (!before.active) {
            return errorResponse(409, 'plan_archived', `${before.name} is archived. Restore it before editing.`);
          }
        }

        const { data: after, error } = await adminClient
          .from('plans')
          .upsert({ ...planPayload, updated_at: new Date().toISOString() }, { onConflict: 'key' })
          .select('*')
          .single();
        if (error) return errorResponse(500, 'unknown', error.message);
        // No target shop: editing a plan changes entitlements for every shop on
        // it at once, which is exactly why the portal shows how many that is
        // before saving.
        await audit('upsert_plan', null, before, after);
        return ok({ plan: after });
      }

      case 'retire_plan': {
        if (!body.planKey || !body.successorPlanKey) {
          return errorResponse(400, 'unknown', 'planKey and successorPlanKey are required.');
        }
        if (body.planKey === body.successorPlanKey) {
          return errorResponse(400, 'unknown', 'A plan cannot succeed itself.');
        }
        // Checked on the request body, not on a DB read, and before isFallback
        // is even computed: at check time the plan being retired still has
        // retire_at = null, so a DB-state check here would pass
        // {planKey:'free', postTrialPlanKey:'free'} right up until the write --
        // the settings write becomes a no-op and the plan write retires it
        // anyway, leaving post_trial_plan_key naming a retired plan. The exact
        // state this whole block exists to make unreachable.
        if (body.postTrialPlanKey && body.postTrialPlanKey === body.planKey) {
          return errorResponse(400, 'unknown', 'A plan cannot be its own fallback.');
        }

        const { data: plan, error: planError } = await adminClient.from('plans').select('*').eq('key', body.planKey).maybeSingle();
        if (planError) return errorResponse(500, 'unknown', planError.message);
        if (!plan) return errorResponse(400, 'unknown', 'No such plan.');
        // The other half of republish_plan's `!before.retire_at` guard below,
        // not a redundant check: retiring a plan no store can choose is not a
        // meaningful operation. Without this, retire_plan(trial -> pro) passes
        // every other guard here (trial is not the fallback, so no
        // postTrialPlanKey is required) and sets trial.retire_at; a second call,
        // republish_plan(trial), then passes the other guard and sets
        // trial.is_public = true. `trial` is $0, carries every module, and its
        // `limits '{}'` means unlimited (20260818000000's own comment) -- two
        // audited calls would put a free unlimited-everything tier in front of
        // listPlans(), which filters on is_public and active alone.
        //
        // retire_at checked BEFORE is_public, same ordering and same reason as
        // the successor guards below: retiring clears is_public in the same
        // write that sets retire_at, so a plan that is already retiring fails
        // the is_public check first and gets told there is "nothing to
        // retire" -- true of `trial`, false and misleading of a plan an
        // operator just retired themselves.
        if (plan.retire_at) {
          return errorResponse(400, 'unknown', 'That plan is already being retired.');
        }
        if (!plan.is_public) {
          return errorResponse(400, 'unknown', 'That plan is not offered to stores, so there is nothing to retire.');
        }

        const { data: successor, error: successorError } = await adminClient
          .from('plans').select('*').eq('key', body.successorPlanKey).maybeSingle();
        if (successorError) return errorResponse(500, 'unknown', successorError.message);
        if (!successor) return errorResponse(400, 'unknown', 'No such successor plan.');
        if (!successor.active) {
          return errorResponse(400, 'unknown', 'That successor is deactivated — stores cannot be moved onto it.');
        }
        // Keeps every chain exactly one hop long, which is what lets
        // shop_effective_plan() resolve without recursing. Tested BEFORE the
        // is_public guard below: retiring through this endpoint clears
        // is_public in the same write that sets retire_at, so checking
        // visibility first would tell an operator to fix the wrong thing.
        if (successor.retire_at) {
          return errorResponse(400, 'unknown', 'That successor is itself being retired. Pick a plan that is staying.');
        }
        // `trial` is assigned by the signup trigger and can never be chosen, so
        // it can never be somewhere stores are moved TO. Still reached on its
        // own for a plan hidden by some other means than a retirement.
        if (!successor.is_public) {
          return errorResponse(400, 'unknown', 'That successor is not offered to stores, so nobody can be moved onto it.');
        }

        // Free is reached by falling THROUGH post_trial_plan_key, not by being
        // on it: shop_effective_status is dates-only, so an expired store
        // resolves to the fallback plan. Retiring the fallback without naming a
        // new one would hand every lapsed store on the platform the successor's
        // entitlements for nothing.
        const { data: settings, error: settingsReadError } = await adminClient
          .from('platform_settings').select('*').eq('id', true).maybeSingle();
        // Not swallowed: if this read fails, isFallback is false and the guard
        // below silently does not fire, which is the one failure this whole
        // case exists to prevent.
        if (settingsReadError) return errorResponse(500, 'unknown', settingsReadError.message);
        const isFallback = settings?.post_trial_plan_key === body.planKey;
        if (isFallback && !body.postTrialPlanKey) {
          return errorResponse(
            400,
            'unknown',
            'This plan is where lapsed stores land. Choose a new fallback plan before retiring it.'
          );
        }
        // postTrialPlanKey only ever means "replace the fallback I am retiring".
        // Accepting it while retiring some unrelated tier would relocate every
        // lapsed store on the platform as an undocumented side effect;
        // set_platform_settings is the audited action for moving the fallback.
        if (!isFallback && body.postTrialPlanKey) {
          return errorResponse(
            400,
            'unknown',
            'That plan is not where lapsed stores land, so a replacement fallback does not apply. Change the fallback from platform settings.'
          );
        }
        if (isFallback && body.postTrialPlanKey) {
          // is_public selected and checked here for the same reason the
          // successor guard above checks it: without it, postTrialPlanKey:
          // 'trial' passes every other check here, and `trial` is $0, carries
          // every module, and its `limits '{}'` means unlimited -- one call
          // would hand every lapsed store on the platform the entire product,
          // permanently.
          const { data: fallback, error: fallbackError } = await adminClient
            .from('plans').select('key, active, retire_at, is_public').eq('key', body.postTrialPlanKey).maybeSingle();
          if (fallbackError) return errorResponse(500, 'unknown', fallbackError.message);
          if (!fallback) return errorResponse(400, 'unknown', 'No such fallback plan.');
          if (!fallback.active || fallback.retire_at) {
            return errorResponse(400, 'unknown', 'The fallback plan must be one that is staying.');
          }
          if (!fallback.is_public) {
            return errorResponse(400, 'unknown', 'The fallback plan must be one that is offered to stores.');
          }
        }

        // 30 days: long enough for a store to be told, decide, and be moved by
        // hand if they ask. The portal offers no other value today; the field
        // exists so a longer sunset does not need a deploy.
        let retireAt = new Date(Date.now() + 30 * 86_400_000).toISOString();
        if (body.retireAt !== undefined) {
          const parsed = new Date(body.retireAt);
          if (!Number.isFinite(parsed.getTime())) {
            return errorResponse(400, 'unknown', 'retireAt is not a date I can read.');
          }
          // A date already past makes retire_at <= now() true immediately, so
          // every store on the plan moves to the successor with no notice --
          // the opposite of the graceful sunset this action exists to give.
          if (parsed.getTime() <= Date.now()) {
            return errorResponse(400, 'unknown', 'retireAt must be in the future — stores need notice before they are moved.');
          }
          retireAt = parsed.toISOString();
        }

        // Read the dependants BEFORE anything is written, so the audit row can
        // say what they pointed at. republish_plan does not restore them, so
        // this log is the only record of where they were.
        const { data: dependants, error: dependantsError } = await adminClient
          .from('plans')
          .select('key, successor_plan_key')
          .eq('successor_plan_key', body.planKey);
        if (dependantsError) return errorResponse(500, 'unknown', dependantsError.message);

        const now = new Date().toISOString();
        const planUpdate = {
          is_public: false,
          retire_at: retireAt,
          successor_plan_key: body.successorPlanKey,
          updated_at: now,
        };
        // `isFallback &&` here is redundant by invariant, not by accident: the
        // guard above already rejects `!isFallback && body.postTrialPlanKey`, so
        // a truthy body.postTrialPlanKey surviving to this line implies
        // isFallback is already true. Kept as belt-and-braces rather than
        // re-derived -- this single term is what both the settings-write
        // condition below (`if (settingsUpdate)`) and the audit ternary two
        // blocks down (`settingsUpdate ? ... : ...`) key off of.
        const settingsUpdate = isFallback && body.postTrialPlanKey
          ? { post_trial_plan_key: body.postTrialPlanKey, updated_at: now }
          : null;

        // Logged BEFORE the writes, the same way delete_shop does it. Three
        // tables change here and there is no transaction across them; if one
        // fails part-way the log still shows an attempt that did not complete,
        // which is recoverable. The other order leaves the platform's fallback
        // pointing at a retired plan with no record of how it got there.
        // The `after` side is therefore the intended state, not a re-read.
        //
        // Each early return below that follows this row writes a SECOND audit
        // row before returning -- action 'retire_plan_failed' -- naming the
        // step that failed. A log reader who only sees this first row cannot
        // tell a completed retirement from a partial one; the failure row is
        // what makes that distinguishable without inferring it from silence.
        await audit(
          'retire_plan',
          null,
          { plan, settings, repointed: dependants ?? [] },
          {
            plan: { ...plan, ...planUpdate },
            settings: settingsUpdate ? { ...settings, ...settingsUpdate } : settings,
            repointed: (dependants ?? []).map((d) => ({ key: d.key, successor_plan_key: body.successorPlanKey })),
          }
        );

        // Settings FIRST. A failure here leaves the plan un-retired and the
        // platform coherent; doing it last would leave the retired plan named
        // as the fallback, and every lapsed store would silently pick up the
        // successor's full module set the moment the date passed.
        //
        // This ordering has its own residual, though, and it is not a no-op:
        // if settings succeeds here and the plan update just below then fails,
        // the platform is left with settings already pointing at the NEW
        // fallback while the OLD plan is still un-retired (is_public still
        // true) -- every lapsed store is over-granted the new fallback's
        // entitlements immediately, not just once the retire date passes. It
        // is recoverable: retry the same request once the underlying failure
        // is fixed. But a naive retry with the same body is rejected by the
        // not-the-fallback guard above, because isFallback now reads false --
        // the operator has to drop postTrialPlanKey from the retry to get
        // past it. Strictly better than what this replaces (the old ordering
        // could leave the retired plan named as the fallback with no bound on
        // how long, rather than a bounded window ending at the next retry),
        // but it is a real residual, not nothing.
        if (settingsUpdate) {
          const { error: settingsError } = await adminClient
            .from('platform_settings')
            .update(settingsUpdate)
            .eq('id', true);
          if (settingsError) {
            await audit(
              'retire_plan_failed',
              null,
              { step: 'settings_write', planKey: body.planKey, attempted: settingsUpdate },
              { error: settingsError.message }
            );
            return errorResponse(500, 'unknown', settingsError.message);
          }
        }

        const { data: after, error } = await adminClient
          .from('plans')
          .update(planUpdate)
          .eq('key', body.planKey)
          .select('*')
          .single();
        if (error) {
          await audit(
            'retire_plan_failed',
            null,
            { step: 'plan_write', planKey: body.planKey, attempted: planUpdate },
            { error: error.message }
          );
          return errorResponse(500, 'unknown', error.message);
        }

        // Anything that pointed at this plan now points past it, so no chain is
        // ever two hops long. Without this, retiring A->B and later B->C would
        // leave A's stores landing on a plan that is itself gone. Must run
        // after the write above -- it depends on the retirement having happened.
        const { error: repointError } = await adminClient
          .from('plans')
          .update({ successor_plan_key: body.successorPlanKey, updated_at: now })
          .eq('successor_plan_key', body.planKey);
        if (repointError) {
          // The two-hop chain shop_effective_plan() cannot resolve: the target
          // is retired and pointed at its successor, but a dependant is still
          // pointed at the now-retired target. The pre-mutation row above
          // claims `repointed` landed; this row says plainly that it did not.
          //
          // Not recoverable from the UI as a retry of this same call -- the
          // plan write above already succeeded, so body.planKey is retired
          // and no longer a valid `retire_plan` target. Whoever reads this
          // audit row: republish the intermediate plan (undoes its retire_at,
          // restores is_public), then retire it again with successorPlanKey
          // set to the FINAL destination -- the one this failed write was
          // trying to repoint the dependant to. That collapses the chain back
          // to one hop directly, rather than leaving the dependant to be
          // fixed by a second, separate repoint.
          await audit(
            'retire_plan_failed',
            null,
            { step: 'repoint_write', planKey: body.planKey, attempted: { successor_plan_key: body.successorPlanKey } },
            { error: repointError.message }
          );
          return errorResponse(500, 'unknown', repointError.message);
        }

        return ok({ plan: after });
      }

      case 'republish_plan': {
        if (!body.planKey) return errorResponse(400, 'unknown', 'planKey is required.');
        const { data: before, error: beforeError } = await adminClient.from('plans').select('*').eq('key', body.planKey).maybeSingle();
        if (beforeError) return errorResponse(500, 'unknown', beforeError.message);
        if (!before) return errorResponse(400, 'unknown', 'No such plan.');
        // This action means "undo a retirement", not "publish anything". Without
        // this check it would set is_public = true on any plan named -- including
        // the seeded `trial` row, which is $0, carries every module and has no
        // limits, and which the store-facing chooser lists on is_public alone.
        // One call with a benign name would make the whole product free.
        if (!before.retire_at) {
          return errorResponse(400, 'unknown', 'That plan is not being retired, so there is nothing to republish.');
        }

        const { data: after, error } = await adminClient
          .from('plans')
          .update({
            is_public: true,
            retire_at: null,
            successor_plan_key: null,
            updated_at: new Date().toISOString(),
          })
          .eq('key', body.planKey)
          .select('*')
          .single();
        if (error) return errorResponse(500, 'unknown', error.message);

        // Deliberately does NOT restore post_trial_plan_key. That is a separate
        // deliberate setting, and silently moving the platform's fallback back
        // would relocate lapsed stores nobody asked to move. The portal says so.
        await audit('republish_plan', null, before, after);
        return ok({ plan: after });
      }

      case 'publish_plan': {
        if (!body.planKey) return errorResponse(400, 'unknown', 'planKey is required.');
        // The same tripwire republish_plan's retire_at guard provides, but
        // publish has no retirement state to hide behind: `trial` is $0,
        // carries every module and has no limits, and the store-facing chooser
        // lists on is_public alone. One benign-looking call would make the
        // whole product free, so the key is refused by name.
        if (body.planKey === 'trial') {
          return errorResponse(400, 'unknown', 'The trial plan is assigned by trigger and can never be published.');
        }
        const { data: before, error: beforeError } = await adminClient.from('plans').select('*').eq('key', body.planKey).maybeSingle();
        if (beforeError) return errorResponse(500, 'unknown', beforeError.message);
        if (!before) return errorResponse(400, 'unknown', 'No such plan.');
        if (!before.active) {
          return errorResponse(409, 'plan_archived', `${before.name} is archived. Restore it before publishing.`);
        }
        // Republish is the verb for a retiring plan -- it clears retire_at and
        // successor_plan_key in the same write. Publishing here instead would
        // mint a public-but-retiring plan, a state nothing else can produce.
        if (before.retire_at) {
          return errorResponse(409, 'plan_retiring', `${before.name} is being retired. Republish it instead — that clears the retirement.`);
        }
        if (before.is_public) return errorResponse(400, 'unknown', `${before.name} is already public.`);

        const { data: after, error } = await adminClient
          .from('plans')
          .update({ is_public: true, updated_at: new Date().toISOString() })
          .eq('key', body.planKey)
          .select('*')
          .single();
        if (error) return errorResponse(500, 'unknown', error.message);
        await audit('publish_plan', null, before, after);
        return ok({ plan: after });
      }

      case 'archive_plan': {
        if (!body.planKey) return errorResponse(400, 'unknown', 'planKey is required.');
        // The provisioning trigger selects `trial` by key at every shop
        // creation; archiving it would break signup platform-wide.
        if (body.planKey === 'trial') {
          return errorResponse(400, 'unknown', 'The trial plan is selected by the signup trigger and can never be archived.');
        }
        const { data: before, error: beforeError } = await adminClient.from('plans').select('*').eq('key', body.planKey).maybeSingle();
        if (beforeError) return errorResponse(500, 'unknown', beforeError.message);
        if (!before) return errorResponse(400, 'unknown', 'No such plan.');
        if (!before.active) return errorResponse(400, 'unknown', `${before.name} is already archived.`);
        // Off the picker first: retire it, or it was never published.
        if (before.is_public) {
          return errorResponse(409, 'plan_public', `${before.name} is still in the store-facing picker. Retire it first.`);
        }
        // All rows, any status -- plan_id's on-delete-restrict makes no status
        // distinction and neither does this. A lapsed store's subscription row
        // still names the plan it will return to.
        const { count, error: subsError } = await adminClient
          .from('shop_subscriptions')
          .select('id', { count: 'exact', head: true })
          .eq('plan_id', before.id);
        if (subsError) return errorResponse(500, 'unknown', subsError.message);
        if ((count ?? 0) > 0) {
          return errorResponse(409, 'plan_in_use', `${count} subscription${count === 1 ? ' still points' : 's still point'} at ${before.name}. Move them first.`);
        }
        // Lapsed stores resolve through post_trial_plan_key on every
        // entitlement read; archiving that plan strands all of them.
        const { data: settings, error: settingsError } = await adminClient
          .from('platform_settings').select('post_trial_plan_key').eq('id', true).maybeSingle();
        if (settingsError) return errorResponse(500, 'unknown', settingsError.message);
        if (settings?.post_trial_plan_key === body.planKey) {
          return errorResponse(409, 'plan_is_fallback', `${before.name} is the post-trial fallback plan. Point the fallback elsewhere first.`);
        }
        // retire_plan refuses an inactive successor at set time; this closes
        // the same hole from the other side -- an in-flight retirement must
        // not sweep its stores onto an archived plan on the retire date.
        // Active pointers only: an archived plan's successor pointer is inert
        // -- the archive guard proved it had zero subscriptions, and being
        // retired or hidden it can never gain any -- so it must not block,
        // and the client's canArchivePlan (which scans active plans) stays an
        // exact mirror.
        const { data: pointing, error: pointingError } = await adminClient
          .from('plans').select('name').eq('successor_plan_key', body.planKey).eq('active', true);
        if (pointingError) return errorResponse(500, 'unknown', pointingError.message);
        if (pointing && pointing.length > 0) {
          return errorResponse(
            409,
            'plan_is_successor',
            `${pointing.map((p) => p.name).join(', ')} retire${pointing.length === 1 ? 's' : ''} into ${before.name}. Republish or re-point ${pointing.length === 1 ? 'it' : 'them'} first.`
          );
        }

        const { data: after, error } = await adminClient
          .from('plans')
          .update({ active: false, updated_at: new Date().toISOString() })
          .eq('key', body.planKey)
          .select('*')
          .single();
        if (error) return errorResponse(500, 'unknown', error.message);
        await audit('archive_plan', null, before, after);
        return ok({ plan: after });
      }

      case 'restore_plan': {
        if (!body.planKey) return errorResponse(400, 'unknown', 'planKey is required.');
        const { data: before, error: beforeError } = await adminClient.from('plans').select('*').eq('key', body.planKey).maybeSingle();
        if (beforeError) return errorResponse(500, 'unknown', beforeError.message);
        if (!before) return errorResponse(400, 'unknown', 'No such plan.');
        if (before.active) return errorResponse(400, 'unknown', `${before.name} is not archived.`);

        // active = true and nothing else: is_public and retire_at are
        // untouched, so the plan comes back exactly as it went away -- hidden,
        // and still retired if it was -- and restoring can never surprise the
        // store-facing picker.
        const { data: after, error } = await adminClient
          .from('plans')
          .update({ active: true, updated_at: new Date().toISOString() })
          .eq('key', body.planKey)
          .select('*')
          .single();
        if (error) return errorResponse(500, 'unknown', error.message);
        await audit('restore_plan', null, before, after);
        return ok({ plan: after });
      }

      case 'set_platform_settings': {
        if (!body.settings) return errorResponse(400, 'unknown', 'settings is required.');

        // Allowlist, not a spread -- same reasoning as upsert_plan's. A bare
        // spread let post_trial_plan_key be pointed at ANY plan with no check
        // at all, including a retiring one: the exact entitlement hole
        // retire_plan's fallback guard exists to close, reopened through a
        // second door that skipped the guard entirely. `id` is the singleton
        // primary key and is not settable; `updated_at` is set below.
        const editableSettings = ['default_trial_days', 'default_grace_days', 'post_trial_plan_key'] as const;
        const settingsPayload: Record<string, unknown> = {};
        for (const column of editableSettings) {
          if (column in body.settings) settingsPayload[column] = body.settings[column];
        }

        // Same rules as retire_plan's fallback guard: must exist, be active,
        // be staying, and be offered to stores. Checked here too because this
        // is the OTHER path that writes post_trial_plan_key, and a lapsed
        // store's entitlements come from whatever this column names.
        if (typeof settingsPayload.post_trial_plan_key === 'string') {
          const { data: fallback, error: fallbackError } = await adminClient
            .from('plans').select('key, active, retire_at, is_public').eq('key', settingsPayload.post_trial_plan_key).maybeSingle();
          if (fallbackError) return errorResponse(500, 'unknown', fallbackError.message);
          if (!fallback) return errorResponse(400, 'unknown', 'No such fallback plan.');
          if (!fallback.active || fallback.retire_at) {
            return errorResponse(400, 'unknown', 'The fallback plan must be one that is staying.');
          }
          if (!fallback.is_public) {
            return errorResponse(400, 'unknown', 'The fallback plan must be one that is offered to stores.');
          }
        }

        const { data: before } = await adminClient.from('platform_settings').select('*').eq('id', true).maybeSingle();
        const { data: after, error } = await adminClient
          .from('platform_settings')
          .update({ ...settingsPayload, updated_at: new Date().toISOString() })
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

        // Same class of problem as already_decided: a decision made against
        // state that has since changed. plan_change_requests' insert policy
        // never checked is_public, so requests to move ONTO a plan survive its
        // retirement -- and approving one would move a store onto the very plan
        // we are shutting down. Declining still works; only approval is refused.
        if (action === 'approve_plan_change') {
          const { data: requestedPlan, error: requestedPlanError } = await adminClient
            .from('plans').select('name, retire_at, active').eq('id', request.requested_plan_id).maybeSingle();
          // Fail closed: if this read errors, `requestedPlan` would otherwise
          // be undefined and the retiring-plan guard below would silently not
          // fire, approving the move as if the plan were fine. A guard that
          // disables itself on an infrastructure error is worse than no guard,
          // because it reads as protection.
          if (requestedPlanError) return errorResponse(500, 'unknown', requestedPlanError.message);
          if (requestedPlan?.retire_at) {
            return errorResponse(
              409,
              'plan_retiring',
              `${requestedPlan.name} is being retired, so stores cannot be moved onto it. Decline this and move them to its successor instead.`
            );
          }
          // Same reasoning as set_plan's active guard: an archived
          // never-retired draft passes the retire_at check above.
          if (requestedPlan && !requestedPlan.active) {
            return errorResponse(409, 'plan_archived', `${requestedPlan.name} is archived, so stores cannot be moved onto it. Decline this request.`);
          }
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

      case 'delete_shop': {
        if (!body.shopId) return errorResponse(400, 'unknown', 'shopId is required.');

        // The most destructive action in the product: `shops` is the cascade
        // root, so this takes the catalogue, every sale and its lines, refunds,
        // customers, expenses, invoices, payroll, shifts, stock and every
        // branch with it. Irreversible, and no undo exists anywhere.
        //
        // Restricted to 'owner'. The role column is otherwise decorative, and
        // if any single action should distinguish a support agent from the
        // person who owns the business, it is this one.
        const { data: actor, error: actorError } = await adminClient
          .from('platform_admins')
          .select('role')
          .eq('user_id', actorId)
          .maybeSingle();
        if (actorError) return errorResponse(500, 'unknown', actorError.message);
        if (actor?.role !== 'owner') {
          return errorResponse(403, 'forbidden', 'Only an owner-role operator can delete a shop.');
        }

        const { data: shop, error: shopError } = await adminClient
          .from('shops')
          .select('id, name, owner_id, created_at')
          .eq('id', body.shopId)
          .maybeSingle();
        if (shopError) return errorResponse(500, 'unknown', shopError.message);
        if (!shop) return errorResponse(400, 'unknown', 'No such shop.');

        // Retyping the name is the whole safeguard. A confirm dialog is
        // dismissed by reflex; typing "Jaalala Skincare" cannot be. Compared
        // server-side so it holds even if someone calls this endpoint directly.
        if ((body.confirmName ?? '').trim() !== shop.name) {
          return errorResponse(400, 'name_mismatch', 'The typed name does not match this shop.');
        }

        // Everything about to be destroyed, captured as DATA rather than as a
        // reference. platform_audit_log.target_shop_id is `on delete set null`,
        // so after the cascade the row would otherwise point at nothing and the
        // record of what was deleted would be gone with it.
        const { data: usage } = await adminClient
          .from('shop_usage_counters')
          .select('resource, count')
          .eq('shop_id', body.shopId);
        const snapshot = { shop, usage: usage ?? [], subscription: await loadSubscription(body.shopId) };

        // Logged BEFORE the delete, deliberately. If the cascade then fails the
        // log shows an attempt that did not complete, which is recoverable; the
        // other order risks data gone with no record of who took it.
        await audit('delete_shop', body.shopId, snapshot, null);

        const { error: deleteError } = await adminClient.from('shops').delete().eq('id', body.shopId);
        if (deleteError) return errorResponse(500, 'unknown', deleteError.message);

        return ok({ deleted: true, shop: shop.name });
      }

      default:
        return errorResponse(400, 'unknown', `Unknown action: ${action}`);
    }
  } catch (err) {
    return errorResponse(500, 'unknown', err instanceof Error ? err.message : 'Unexpected failure.');
  }
});
