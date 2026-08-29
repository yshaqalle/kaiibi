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
  | 'open_support'
  | 'reply_support'
  | 'close_support'
  | 'attach_support'
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
  // Support. `reason` carries the message body for open_support and
  // reply_support -- see the note on those cases.
  support?: {
    threadId?: string;
    messageId?: string;
    addressedUserId?: string | null;
    category?: string;
    subject?: string;
    // Files the CONSOLE has already uploaded to the bucket. Only the row is
    // written here -- see the note on validateAttachments for why the bytes do
    // not travel through this function.
    attachments?: unknown;
  };
  // The shop's exact name, retyped by the operator. Only used by delete_shop.
  confirmName?: string;
};

// OPERATOR_CATEGORIES in src/lib/support-taxonomy.ts, restated because a Deno
// function cannot import from the app bundle. The database constrains these too
// (20260825000100); checking here as well is what turns a check violation --
// which surfaces as a bare 500 -- into a sentence naming the bad value.
const OPERATOR_CATEGORIES = ['billing', 'account', 'problem', 'changed', 'other'];

// support_messages.body's own ceiling (20260825000000). Same reasoning as the
// category list: the constraint is the guarantee, this is the error message.
const MESSAGE_MAX = 4000;

// Code points, because that is what Postgres length() counts. Plain .length is
// UTF-16 units, which counts every emoji twice -- a reply the column would
// accept refused with a character count the operator can see is wrong.
const messageLength = (text: string) => [...text].length;

// An id from the request body reaches Postgres as a uuid literal, and a
// malformed one raises `invalid input syntax for type uuid` -- which arrives as
// a bare 500 quoting a Postgres type name, the same leak the shop-exists lookup
// below was added to avoid. Checked before the value is spent on a query.
const isUuid = (value: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

// The bucket 20260825000000 created, and the two limits it carries. Restated
// here for the same reason OPERATOR_CATEGORIES is: the bucket is the rule, this
// copy is so a refusal is a sentence rather than a 400 quoting a bucket config.
const SUPPORT_BUCKET = 'support-attachments';
const MAX_SUPPORT_ATTACHMENTS = 5;
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const SUPPORT_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/heic',
  'image/heif',
  'application/pdf',
  'text/plain',
  'video/mp4',
  'video/quicktime',
  'video/3gpp',
];

// What the console claims it has uploaded.
type AttachmentClaim = {
  storagePath: string;
  fileName: string;
  byteSize: number;
  contentType: string | null;
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

// The console's claim about a file it has already put in the bucket.
//
// THE BYTES DO NOT COME THROUGH HERE. An operator uploads straight to storage
// under the policy 20260825000700 widened, and only the row travels through
// this function -- because that row belongs in the audit log, and because a
// 10 MB file base64'd into a JSON body is ~13.4 MB crossing the wire twice.
// What that costs is that everything below is a claim, so everything below is
// checked. The path test is the one that matters: it is what
// check_support_attachment_path() enforces on the row anyway, asked here so the
// refusal names the file instead of arriving as a check violation.
function validateAttachments(
  raw: unknown,
  shopId: string,
  threadId: string
): { ok: true; claims: AttachmentClaim[] } | { ok: false; response: Response } {
  if (raw === undefined || raw === null) return { ok: true, claims: [] };
  if (!Array.isArray(raw)) {
    return { ok: false, response: errorResponse(400, 'unknown', 'attachments must be a list.') };
  }
  if (raw.length > MAX_SUPPORT_ATTACHMENTS) {
    return {
      ok: false,
      response: errorResponse(400, 'unknown', `A message can carry ${MAX_SUPPORT_ATTACHMENTS} files; that is ${raw.length}.`),
    };
  }

  const claims: AttachmentClaim[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) {
      return { ok: false, response: errorResponse(400, 'unknown', 'Each attachment must be an object.') };
    }
    const item = entry as Record<string, unknown>;
    const storagePath = typeof item.storagePath === 'string' ? item.storagePath : '';
    const fileName = typeof item.fileName === 'string' ? item.fileName.trim() : '';
    const byteSize = item.byteSize;
    const contentType = item.contentType == null ? null : String(item.contentType);

    // Exactly three segments, and the first two are this thread's. The trigger
    // accepts a deeper path whose first two segments happen to match; this does
    // not, because attachmentPath() in the app never writes one and a shape
    // nothing produces is a shape nobody has checked the storage rules against.
    const parts = storagePath.split('/');
    if (parts.length !== 3 || parts[0] !== shopId || parts[1] !== threadId || parts[2].length === 0) {
      return {
        ok: false,
        response: errorResponse(400, 'unknown', `\`${storagePath}\` is not a path on this conversation.`),
      };
    }
    if (!fileName) {
      return { ok: false, response: errorResponse(400, 'unknown', 'Every attachment needs a file name.') };
    }
    if (fileName.length > 255) {
      return { ok: false, response: errorResponse(400, 'unknown', 'That file name is too long to store.') };
    }
    if (typeof byteSize !== 'number' || !Number.isInteger(byteSize) || byteSize < 0) {
      return { ok: false, response: errorResponse(400, 'unknown', `\`${fileName}\` has no usable size.`) };
    }
    if (byteSize > MAX_ATTACHMENT_BYTES) {
      return {
        ok: false,
        response: errorResponse(400, 'attachment_too_large', `\`${fileName}\` is over 10 MB, which the bucket will not hold.`),
      };
    }
    if (contentType !== null && !SUPPORT_MIME_TYPES.includes(contentType)) {
      return {
        ok: false,
        response: errorResponse(400, 'attachment_type', `\`${fileName}\` is a kind of file this bucket does not accept.`),
      };
    }
    claims.push({ storagePath, fileName, byteSize, contentType });
  }
  return { ok: true, claims };
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

  // Turns a claim into a row, but only if the object is really there.
  //
  // Without this a request could write a paperclip pointing at nothing: the
  // store opens the thread, sees `receipt.pdf`, taps it, and gets a signing
  // error for a file that was never uploaded -- which reads as us having sent
  // something and them having broken it. The size and type are taken from what
  // storage actually holds rather than from what the caller said, on the same
  // principle as author_kind being set here and never accepted from the body.
  const resolveAttachments = async (
    shopId: string,
    threadId: string,
    claims: AttachmentClaim[]
  ): Promise<{ ok: true; rows: Record<string, unknown>[] } | { ok: false; response: Response }> => {
    if (claims.length === 0) return { ok: true, rows: [] };

    // One listing for the folder rather than one lookup per file. The cap is
    // far above what a conversation holds (5 files per message) and is here
    // only so a pathological folder cannot page forever; a file past it reads
    // as missing, which is the safe direction.
    const { data: objects, error } = await adminClient.storage
      .from(SUPPORT_BUCKET)
      .list(`${shopId}/${threadId}`, { limit: 1000 });
    if (error) return { ok: false, response: errorResponse(500, 'unknown', error.message) };

    const found = new Map((objects ?? []).map((o) => [o.name, o]));
    const rows: Record<string, unknown>[] = [];
    for (const claim of claims) {
      const object = found.get(claim.storagePath.split('/')[2]);
      if (!object) {
        return {
          ok: false,
          response: errorResponse(400, 'attachment_missing', `\`${claim.fileName}\` is not in the bucket — it did not finish uploading.`),
        };
      }
      const metadata = (object.metadata ?? {}) as { size?: number; mimetype?: string };
      rows.push({
        storage_path: claim.storagePath,
        file_name: claim.fileName,
        byte_size: typeof metadata.size === 'number' ? metadata.size : claim.byteSize,
        content_type: metadata.mimetype ?? claim.contentType,
      });
    }
    return { ok: true, rows };
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
        // 30, matching platform_settings.default_grace_days (20260930000400).
        // The fallback only fires if the singleton settings row cannot be
        // read at all, and a wrong number here is invisible -- it writes a
        // grace_until that looks deliberate.
        const graceDays = settings?.default_grace_days ?? 30;

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
          // Same 30 as extend_trial above, and for the same reason.
          const graceDays = graceRes.data?.default_grace_days ?? 30;
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

      // The audit log's rule is that every action carries a reason (see the
      // guard near the top of this file). For support, the message body IS the
      // reason: asking an operator to justify each reply separately would be
      // absurd, and passing the body keeps the log recording what was actually
      // said rather than carving out an exemption.
      //
      // Every check below is the only check. These three cases write through
      // the service-role client, which bypasses RLS entirely, so the policies
      // that make a store's own writes safe (20260825000000) are not consulted
      // for a single one of these rows.
      case 'open_support': {
        if (!body.shopId) return errorResponse(400, 'unknown', 'shopId is required.');
        if (!isUuid(body.shopId)) return errorResponse(400, 'unknown', 'shopId is not an id.');
        const subject = body.support?.subject?.trim();
        const category = body.support?.category?.trim();
        if (!subject) return errorResponse(400, 'unknown', 'A subject is required.');
        if (!category) return errorResponse(400, 'unknown', 'A category is required.');
        if (!OPERATOR_CATEGORIES.includes(category)) {
          return errorResponse(400, 'unknown', `\`${category}\` is not a category an operator can use.`);
        }
        const messageBody = reason.trim();
        if (messageLength(messageBody) > MESSAGE_MAX) {
          return errorResponse(400, 'message_too_long', `That message is ${messageLength(messageBody)} characters; the limit is ${MESSAGE_MAX}.`);
        }

        // shop_id is a foreign key, so an unknown one is refused either way --
        // but as a 500 quoting a constraint name. The owner is read here too,
        // for the addressee check below.
        const { data: shop, error: shopError } = await adminClient
          .from('shops')
          .select('id, owner_id')
          .eq('id', body.shopId)
          .maybeSingle();
        if (shopError) return errorResponse(500, 'unknown', shopError.message);
        if (!shop) return errorResponse(400, 'unknown', 'No such shop.');

        // addressed_user_id is who the thread BELONGS to, and
        // support_thread_is_visible() hands the thread to whoever it names with
        // no membership test of its own -- deliberately, so a cashier keeps
        // reading their own thread after they leave. That makes a mistyped id
        // here a stranger reading this shop's support conversation, which is
        // the one promise this feature makes. Checked against the shop's staff
        // where the mistake is still cheap.
        const addressedUserId = body.support?.addressedUserId ?? null;
        if (addressedUserId && !isUuid(addressedUserId)) {
          return errorResponse(400, 'unknown', 'addressedUserId is not an id.');
        }
        if (addressedUserId && addressedUserId !== shop.owner_id) {
          const { data: member, error: memberError } = await adminClient
            .from('shop_members')
            .select('user_id')
            .eq('shop_id', body.shopId)
            .eq('user_id', addressedUserId)
            .eq('active', true)
            .maybeSingle();
          if (memberError) return errorResponse(500, 'unknown', memberError.message);
          if (!member) return errorResponse(400, 'unknown', 'That person does not work at this shop.');
        }

        // One request, one transaction (20260825000200). The thread and the
        // message it is about are the same fact, and two PostgREST calls can
        // land the first and lose the second on a timeout, a dropped connection
        // or a killed isolate -- leaving a subject with no body at the top of
        // the store's list, unanswerable and undeletable by them. The rpc does
        // the two inserts and the re-read that
        // support_messages_touch_thread makes necessary; every rule above stays
        // here, so none of them gets a second copy that can drift.
        const { data: thread, error: openError } = await adminClient.rpc(
          'platform_open_support_thread',
          {
            p_shop_id: body.shopId,
            p_category: category,
            p_subject: subject,
            p_body: messageBody,
            p_addressed_user_id: addressedUserId,
            p_author_user_id: actorId,
            // Sent as its own value rather than left for the database to work
            // out from the id, because addressed_user_id is `on delete set
            // null` and a rule that reads it later reads a different answer
            // than the one chosen here. This is the only moment the operator's
            // choice is unambiguous, so it is the moment it gets written down
            // (20260825000600).
            p_addressed_scope: addressedUserId ? 'person' : 'store',
          },
        );
        if (openError) return errorResponse(500, 'unknown', openError.message);

        // The id of the message the rpc wrote alongside the thread, so the
        // composer can hang files off it.
        //
        // open_support takes no attachments of its own, and cannot: the storage
        // path is <shop_id>/<thread_id>/<file> and the thread id does not exist
        // until the line above. So the composer opens, uploads, then calls
        // attach_support -- the same three steps the store's compose form has
        // always taken, and the same failure it already handles (a message that
        // arrived, with a caveat naming the files that did not).
        //
        // Its failure is NOT this action's failure. The thread is written and
        // the store can read it; answering 500 here would have an operator
        // retry into a duplicate conversation.
        const { data: firstMessage } = await adminClient
          .from('support_messages')
          .select('id')
          .eq('thread_id', thread.id)
          .order('created_at', { ascending: true })
          .limit(1)
          .maybeSingle();

        await audit('open_support', body.shopId, null, thread);
        return ok({ thread, message: firstMessage ?? null });
      }

      case 'reply_support': {
        const threadId = body.support?.threadId;
        if (!threadId) return errorResponse(400, 'unknown', 'threadId is required.');
        if (!isUuid(threadId)) return errorResponse(400, 'unknown', 'threadId is not an id.');
        const messageBody = reason.trim();
        if (messageLength(messageBody) > MESSAGE_MAX) {
          return errorResponse(400, 'message_too_long', `That message is ${messageLength(messageBody)} characters; the limit is ${MESSAGE_MAX}.`);
        }

        const { data: thread, error: loadError } = await adminClient
          .from('support_threads')
          .select('*')
          .eq('id', threadId)
          .maybeSingle();
        if (loadError) return errorResponse(500, 'unknown', loadError.message);
        if (!thread) return errorResponse(404, 'unknown', 'No such conversation.');

        // Both attachment checks run BEFORE the message is written. A payload
        // this function is going to refuse must not leave a reply on the thread
        // first: the store would be told an answer had arrived and the operator
        // would be told it had not, and the retry would post it twice.
        const claims = validateAttachments(body.support?.attachments, thread.shop_id, threadId);
        if (!claims.ok) return claims.response;
        const resolved = await resolveAttachments(thread.shop_id, threadId, claims.claims);
        if (!resolved.ok) return resolved.response;

        // Replying reopens a closed thread. support-thread-view.tsx renders the
        // reply box only while status is 'open', and the touch trigger bumps
        // last_message_at without touching shop_read_at -- so appending to a
        // closed thread pins it to the top of the store's list, marked unread,
        // with no way to answer it. Reopening beats refusing: an operator
        // writing again means the conversation is alive.
        //
        // Before the message rather than after, because the two writes are not
        // one transaction either way and this order fails better. A reopen that
        // lands without its message leaves a thread that is open again but has
        // not moved in the store's list, and the retry writes the message
        // exactly once. The other order fails into the dead-end message this
        // guard exists to prevent.
        const reopened = thread.status === 'closed';
        if (reopened) {
          const { error: reopenError } = await adminClient
            .from('support_threads')
            .update({ status: 'open' })
            .eq('id', threadId);
          if (reopenError) return errorResponse(500, 'unknown', reopenError.message);
        }

        // author_kind 'platform' is what makes the trigger mark this read for
        // us and leave it unread for the shop -- it is the whole unread rule,
        // not a label, so it is set here and never taken from the request.
        const { data: message, error: messageError } = await adminClient
          .from('support_messages')
          .insert({
            thread_id: threadId,
            author_kind: 'platform',
            author_user_id: actorId,
            body: messageBody,
          })
          .select('*')
          .single();
        if (messageError) return errorResponse(500, 'unknown', messageError.message);

        // Written after the message because they hang off it, and reported
        // rather than raised because by now the reply has arrived. A 500 here
        // would tell an operator their answer failed when the store can already
        // read it -- and the retry would send it twice, which is the one thing
        // every guard in this case exists to prevent. The store gets the words
        // and the operator gets a caveat naming what to send again.
        let attachments: unknown[] = [];
        let missedAttachments: string[] = [];
        if (resolved.rows.length > 0) {
          const { data: attached, error: attachError } = await adminClient
            .from('support_attachments')
            .insert(resolved.rows.map((row) => ({ ...row, message_id: message.id })))
            .select('*');
          if (attachError) missedAttachments = resolved.rows.map((row) => String(row.file_name));
          else attachments = attached ?? [];
        }

        // Read back only when the status moved, so the audit row's before/after
        // say that it did. A reply that changes nothing about the thread keeps
        // the original shape: null before, the message after.
        let after: unknown = null;
        if (reopened) {
          const { data, error: afterError } = await adminClient
            .from('support_threads')
            .select('*')
            .eq('id', threadId)
            .single();
          if (afterError) return errorResponse(500, 'unknown', afterError.message);
          after = data;
        }

        await audit(
          'reply_support',
          thread.shop_id,
          reopened ? thread : null,
          reopened ? { thread: after, message, attachments } : { message, attachments },
        );
        return ok({ message, attachments, missedAttachments, ...(reopened ? { thread: after } : {}) });
      }

      // The composer's second step. open_support cannot carry files -- the
      // storage path needs the thread id it is in the act of creating -- so the
      // console opens, uploads, and links here.
      //
      // Deliberately NOT a general "write a support_attachments row" endpoint:
      // it refuses any message that is not one of OURS on the named thread. An
      // operator hanging a file off the STORE's message would make it look, in
      // the store's own conversation, like they had sent it themselves.
      case 'attach_support': {
        const threadId = body.support?.threadId;
        const messageId = body.support?.messageId;
        if (!threadId || !messageId) return errorResponse(400, 'unknown', 'threadId and messageId are required.');
        if (!isUuid(threadId)) return errorResponse(400, 'unknown', 'threadId is not an id.');
        if (!isUuid(messageId)) return errorResponse(400, 'unknown', 'messageId is not an id.');

        const { data: thread, error: threadError } = await adminClient
          .from('support_threads')
          .select('id, shop_id')
          .eq('id', threadId)
          .maybeSingle();
        if (threadError) return errorResponse(500, 'unknown', threadError.message);
        if (!thread) return errorResponse(404, 'unknown', 'No such conversation.');

        const { data: message, error: messageError } = await adminClient
          .from('support_messages')
          .select('id, thread_id, author_kind')
          .eq('id', messageId)
          .maybeSingle();
        if (messageError) return errorResponse(500, 'unknown', messageError.message);
        if (!message || message.thread_id !== threadId) {
          return errorResponse(404, 'unknown', 'No such message on that conversation.');
        }
        if (message.author_kind !== 'platform') {
          return errorResponse(400, 'unknown', 'A file can only be attached to a message we wrote.');
        }

        const claims = validateAttachments(body.support?.attachments, thread.shop_id, threadId);
        if (!claims.ok) return claims.response;
        if (claims.claims.length === 0) return errorResponse(400, 'unknown', 'No attachments were given.');

        // Counted against what the message ALREADY carries, not just against
        // this batch. Unlike reply_support -- whose message is one line old and
        // therefore empty -- this action can be called again on the same
        // message, so the batch check alone makes "up to 5 per message" a rule
        // that holds only for callers who ask once. Nothing in the database
        // enforces the five, so this is the enforcement.
        const { count: already, error: countError } = await adminClient
          .from('support_attachments')
          .select('id', { count: 'exact', head: true })
          .eq('message_id', messageId);
        if (countError) return errorResponse(500, 'unknown', countError.message);
        if ((already ?? 0) + claims.claims.length > MAX_SUPPORT_ATTACHMENTS) {
          return errorResponse(
            400,
            'unknown',
            `That message already carries ${already ?? 0} files; ${MAX_SUPPORT_ATTACHMENTS} is the limit.`
          );
        }

        const resolved = await resolveAttachments(thread.shop_id, threadId, claims.claims);
        if (!resolved.ok) return resolved.response;

        // Nothing has been written yet, so unlike the reply case a failure here
        // is a clean refusal the operator can retry without sending anything
        // twice.
        const { data: attached, error: attachError } = await adminClient
          .from('support_attachments')
          .insert(resolved.rows.map((row) => ({ ...row, message_id: messageId })))
          .select('*');
        if (attachError) return errorResponse(500, 'unknown', attachError.message);

        await audit('attach_support', thread.shop_id, null, attached);
        return ok({ attachments: attached ?? [] });
      }

      case 'close_support': {
        const threadId = body.support?.threadId;
        if (!threadId) return errorResponse(400, 'unknown', 'threadId is required.');
        if (!isUuid(threadId)) return errorResponse(400, 'unknown', 'threadId is not an id.');

        // Read for the audit row's `before` and to tell a missing conversation
        // from an already-closed one. It is NOT the guard: read-then-write is
        // two statements, and two operators with the queue open both read
        // 'open' and both write -- the second audit row carrying a different
        // operator's words against a change that did not happen, which is the
        // duplicate the 409 exists to prevent.
        const { data: before, error: beforeError } = await adminClient
          .from('support_threads')
          .select('*')
          .eq('id', threadId)
          .maybeSingle();
        if (beforeError) return errorResponse(500, 'unknown', beforeError.message);
        if (!before) return errorResponse(404, 'unknown', 'No such conversation.');

        // The guard is the WHERE: one statement decides and writes, so the
        // second operator matches no row and hears already_closed -- the same
        // refusal approve_plan_change's already_decided gives, and now for the
        // simultaneous case as well as the sequential one.
        const { data: after, error: updateError } = await adminClient
          .from('support_threads')
          .update({ status: 'closed' })
          .eq('id', threadId)
          .eq('status', 'open')
          .select('*')
          .maybeSingle();
        if (updateError) return errorResponse(500, 'unknown', updateError.message);
        if (!after) {
          return errorResponse(409, 'already_closed', 'That conversation is already closed.');
        }

        await audit('close_support', before.shop_id, before, after);
        return ok({ thread: after });
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
