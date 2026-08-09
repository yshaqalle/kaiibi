import type { LimitResource, SubscriptionStatus } from '@/lib/entitlements';
import type { Plan } from '@/lib/subscriptions';
import { supabase } from '@/lib/supabase';

// The back-office data layer. Reads come straight from the tables under the
// `operators read *` policies (migration 20260818000500); every WRITE goes
// through the platform-admin edge function, because none of these tables has an
// insert/update/delete policy for anyone.

export type PlatformShopRow = {
  shopId: string;
  shopName: string;
  ownerId: string;
  createdAt: string;
  planKey: string;
  planName: string;
  // What shop_subscriptions.plan_id still points at -- never rewritten by
  // retirement, so this is what the store is actually being billed and is the
  // key money (MRR, per-plan revenue) must be priced off. `planKey`/`planName`
  // above are the effective plan the server enforces; entitlements, limits and
  // usage denominators belong there instead. See the comment in
  // listPlatformShops for why the two diverge.
  storedPlanKey: string;
  storedPlanName: string;
  // The successor's NAME when this store's plan is retiring, else null. Drives
  // the "Retiring plan" filter and the row's countdown badge.
  retiringTo: string | null;
  status: SubscriptionStatus;
  trialEndsAt: string | null;
  currentPeriodEnd: string | null;
  manualStatus: 'active' | 'suspended';
  usage: Partial<Record<LimitResource, number>>;
  limits: Partial<Record<LimitResource, number | null>>;
  // From the shop's primary store. It is the number they print on their own
  // receipts, not a private contact detail, and it is what makes reaching a
  // customer on WhatsApp a click rather than a hunt.
  contactPhone: string | null;
  city: string | null;
};

export type SubscriptionPaymentRow = {
  id: string;
  shopId: string;
  amountCents: number;
  currency: string;
  method: string | null;
  paidAt: string;
  coversTo: string | null;
};

// What we have actually been paid. This is Kaiibi's revenue, not any shop's
// takings -- the portal cannot read those and deliberately never will.
export async function listSubscriptionPayments(): Promise<SubscriptionPaymentRow[]> {
  const { data, error } = await supabase
    .from('subscription_payments')
    .select('id, shop_id, amount_cents, currency, method, paid_at, covers_to')
    .order('paid_at', { ascending: false });
  if (error) throw error;
  return (data ?? []).map((row: any) => ({
    id: row.id,
    shopId: row.shop_id,
    amountCents: row.amount_cents,
    currency: row.currency,
    method: row.method,
    paidAt: row.paid_at,
    coversTo: row.covers_to,
  }));
}

// Moved to src/lib/whatsapp.ts so the admin app (customers, staff, receipts)
// and this portal normalize numbers identically. Re-exported rather than
// re-pointed at the call sites: this is the module the portal imports from.
export { whatsappLink } from '@/lib/whatsapp';

export type PlatformAuditRow = {
  id: string;
  actorUserId: string | null;
  action: string;
  targetShopId: string | null;
  before: unknown;
  after: unknown;
  reason: string | null;
  createdAt: string;
};

export type PendingPlanRequest = {
  id: string;
  shopId: string;
  requestedPlanId: string;
  planKey: string;
  planName: string;
  note: string | null;
  createdAt: string;
};

// The approval queue. Only pending ones -- a decided request belongs in the
// audit log, which records who decided it and why, rather than lingering here
// looking actionable.
export async function listPendingPlanRequests(): Promise<PendingPlanRequest[]> {
  const { data, error } = await supabase
    .from('plan_change_requests')
    .select('id, shop_id, requested_plan_id, note, created_at, plans(key, name)')
    .eq('status', 'pending')
    .order('created_at', { ascending: true });
  if (error) throw error;
  return (data ?? []).map((row: any) => ({
    id: row.id,
    shopId: row.shop_id,
    requestedPlanId: row.requested_plan_id,
    planKey: row.plans?.key ?? '',
    planName: row.plans?.name ?? '',
    note: row.note,
    createdAt: row.created_at,
  }));
}

export type PlatformSettings = {
  defaultTrialDays: number;
  defaultGraceDays: number;
  postTrialPlanKey: string;
};

// The singleton row from 20260818000000. Readable by any authenticated user by
// policy — the trial countdown needs default_grace_days to say when writes stop
// — so this needs no operator check of its own.
export async function getPlatformSettings(): Promise<PlatformSettings> {
  const { data, error } = await supabase
    .from('platform_settings')
    .select('default_trial_days, default_grace_days, post_trial_plan_key')
    .eq('id', true)
    .single();
  if (error) throw error;
  return {
    defaultTrialDays: data.default_trial_days,
    defaultGraceDays: data.default_grace_days,
    postTrialPlanKey: data.post_trial_plan_key,
  };
}

export type PlatformOperator = {
  userId: string;
  role: 'owner' | 'support' | 'billing';
  active: boolean;
  note: string | null;
};

// Whether the signed-in user is an operator, and whether they still owe a
// second factor. Two separate answers because the portal's front door has to
// tell "you don't work here" apart from "finish signing in" -- collapsing them
// would leave an enrolled operator staring at a dead end.
export async function getPlatformAccess(): Promise<{ isAdmin: boolean; pendingMfa: boolean }> {
  const [full, pending] = await Promise.all([
    supabase.rpc('is_platform_admin'),
    supabase.rpc('is_platform_admin_pending_mfa'),
  ]);
  return { isAdmin: full.data === true, pendingMfa: pending.data === true && full.data !== true };
}

// The client-side twin of shop_effective_plan()'s successor hop, in the same
// spirit as deriveStatus() below: the server remains the authority for
// enforcement, and this exists so the portal's list can be sorted, filtered and
// costed without one RPC per row.
//
// One hop, matching the SQL exactly. retire_plan re-points anything aimed at a
// plan it retires, so a two-hop chain should never exist -- and if one somehow
// does, stopping beats looping in a function that runs per row.
export function resolveRetiredPlan<
  T extends { key: string; retireAt: string | null; successorPlanKey: string | null },
>(planKey: string, plans: T[], now: number = Date.now()): string {
  const current = plans.find((p) => p.key === planKey);
  if (!current?.retireAt || !current.successorPlanKey) return planKey;
  if (new Date(current.retireAt).getTime() > now) return planKey;
  // An unknown successor means this build has not seen that plan row. Falling
  // back to the original key shows something stale rather than nothing at all.
  return plans.some((p) => p.key === current.successorPlanKey) ? current.successorPlanKey : planKey;
}

// One row per shop for the list, joined client-side from three narrow reads.
// A view would be tidier, but it would need its own policy and would be a
// second place for the operator/shop-member read split to drift.
//
// `postTrialPlanKey` is platform_settings' fallback -- the caller already loads
// it for the trial countdown, and shop_effective_plan() needs it for exactly
// the same expired/suspended branch this function mirrors below.
export async function listPlatformShops(plans: Plan[], postTrialPlanKey: string): Promise<PlatformShopRow[]> {
  const [shopsRes, subsRes, usageRes, locationsRes] = await Promise.all([
    supabase.from('shops').select('id, name, owner_id, created_at').order('created_at', { ascending: false }),
    supabase.from('shop_subscriptions').select('shop_id, plan_id, trial_ends_at, current_period_end, grace_until, manual_status, plans(key, name, limits)'),
    supabase.from('shop_usage_counters').select('shop_id, resource, count'),
    supabase.from('shop_locations').select('shop_id, contact_phone, city, is_primary').eq('is_primary', true),
  ]);
  if (shopsRes.error) throw shopsRes.error;
  if (subsRes.error) throw subsRes.error;
  if (usageRes.error) throw usageRes.error;
  if (locationsRes.error) throw locationsRes.error;
  const primary = new Map((locationsRes.data ?? []).map((l: any) => [l.shop_id, l]));

  const subs = new Map((subsRes.data ?? []).map((s: any) => [s.shop_id, s]));
  const usage = new Map<string, Partial<Record<LimitResource, number>>>();
  for (const row of usageRes.data ?? []) {
    const existing = usage.get(row.shop_id) ?? {};
    existing[row.resource as LimitResource] = row.count;
    usage.set(row.shop_id, existing);
  }

  return (shopsRes.data ?? []).map((shop: any) => {
    const sub = subs.get(shop.id);
    // Derived client-side with the same rules as shop_effective_status(). The
    // server remains the authority for enforcement; this is just so the list
    // can be sorted and filtered without one RPC per row.
    const status = deriveStatus(sub);

    // What the subscription row still points at. Never rewritten by
    // retirement, so this is what the store is actually being billed --
    // money must be priced off this, not off the effective plan below.
    const storedKey = sub?.plans?.key ?? 'free';
    const storedPlan = plans.find((p) => p.key === storedKey);

    // What actually applies, mirroring shop_effective_plan()'s own branch
    // (20260824000100): a trialing/active/grace store is entitled off its own
    // subscription, but an expired or suspended one falls back to
    // platform_settings.post_trial_plan_key regardless of what its
    // subscription still says. Feeding the wrong base into the retirement hop
    // would show a suspended store the dead plan's limits while the server
    // enforces the fallback's -- so this base has to split the same way before
    // resolveRetiredPlan ever runs.
    const baseKey = status === 'trialing' || status === 'active' || status === 'grace' ? storedKey : postTrialPlanKey;
    const effectiveKey = resolveRetiredPlan(baseKey, plans);
    const effectivePlan = plans.find((p) => p.key === effectiveKey);

    const retiringTo =
      storedPlan?.retireAt && storedPlan.successorPlanKey
        ? (plans.find((p) => p.key === storedPlan.successorPlanKey)?.name ?? null)
        : null;

    return {
      shopId: shop.id,
      shopName: shop.name,
      ownerId: shop.owner_id,
      createdAt: shop.created_at,
      planKey: effectiveKey,
      planName: effectivePlan?.name ?? sub?.plans?.name ?? 'Free',
      storedPlanKey: storedKey,
      storedPlanName: storedPlan?.name ?? sub?.plans?.name ?? 'Free',
      retiringTo,
      status,
      trialEndsAt: sub?.trial_ends_at ?? null,
      currentPeriodEnd: sub?.current_period_end ?? null,
      manualStatus: sub?.manual_status ?? 'active',
      usage: usage.get(shop.id) ?? {},
      limits: effectivePlan?.limits ?? sub?.plans?.limits ?? {},
      contactPhone: primary.get(shop.id)?.contact_phone ?? null,
      city: primary.get(shop.id)?.city ?? null,
    };
  });
}

function deriveStatus(sub: any): SubscriptionStatus {
  if (!sub) return 'expired';
  if (sub.manual_status === 'suspended') return 'suspended';
  const now = Date.now();
  if (sub.trial_ends_at && new Date(sub.trial_ends_at).getTime() > now) return 'trialing';
  if (sub.current_period_end && new Date(sub.current_period_end).getTime() > now) return 'active';
  if (sub.grace_until && new Date(sub.grace_until).getTime() > now) return 'grace';
  return 'expired';
}

export async function listAuditLog(limit = 100): Promise<PlatformAuditRow[]> {
  const { data, error } = await supabase
    .from('platform_audit_log')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []).map((row: any) => ({
    id: row.id,
    actorUserId: row.actor_user_id,
    action: row.action,
    targetShopId: row.target_shop_id,
    before: row.before,
    after: row.after,
    reason: row.reason,
    createdAt: row.created_at,
  }));
}

export async function listOperators(): Promise<PlatformOperator[]> {
  const { data, error } = await supabase.from('platform_admins').select('*').order('created_at');
  if (error) throw error;
  return (data ?? []).map((row: any) => ({
    userId: row.user_id,
    role: row.role,
    active: row.active,
    note: row.note,
  }));
}

export type PlatformActionError = { error: string; message: string };

// Every mutation. `reason` is mandatory at the API too, not just here -- an
// audit trail that records what happened but not why answers the easy question
// and not the one asked during an investigation.
export async function callPlatformAdmin(action: string, payload: Record<string, unknown>, reason: string): Promise<any> {
  const { data, error } = await supabase.functions.invoke('platform-admin', {
    body: { action, reason, ...payload },
  });
  if (error) throw error;
  if (data && typeof data === 'object' && 'error' in data) throw new Error((data as PlatformActionError).message);
  return data;
}
