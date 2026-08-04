import type { LimitResource, SubscriptionStatus } from '@/lib/entitlements';
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
  status: SubscriptionStatus;
  trialEndsAt: string | null;
  currentPeriodEnd: string | null;
  manualStatus: 'active' | 'suspended';
  usage: Partial<Record<LimitResource, number>>;
  limits: Partial<Record<LimitResource, number | null>>;
};

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

// One row per shop for the list, joined client-side from three narrow reads.
// A view would be tidier, but it would need its own policy and would be a
// second place for the operator/shop-member read split to drift.
export async function listPlatformShops(): Promise<PlatformShopRow[]> {
  const [shopsRes, subsRes, usageRes] = await Promise.all([
    supabase.from('shops').select('id, name, owner_id, created_at').order('created_at', { ascending: false }),
    supabase.from('shop_subscriptions').select('shop_id, plan_id, trial_ends_at, current_period_end, grace_until, manual_status, plans(key, name, limits)'),
    supabase.from('shop_usage_counters').select('shop_id, resource, count'),
  ]);
  if (shopsRes.error) throw shopsRes.error;
  if (subsRes.error) throw subsRes.error;
  if (usageRes.error) throw usageRes.error;

  const subs = new Map((subsRes.data ?? []).map((s: any) => [s.shop_id, s]));
  const usage = new Map<string, Partial<Record<LimitResource, number>>>();
  for (const row of usageRes.data ?? []) {
    const existing = usage.get(row.shop_id) ?? {};
    existing[row.resource as LimitResource] = row.count;
    usage.set(row.shop_id, existing);
  }

  return (shopsRes.data ?? []).map((shop: any) => {
    const sub = subs.get(shop.id);
    return {
      shopId: shop.id,
      shopName: shop.name,
      ownerId: shop.owner_id,
      createdAt: shop.created_at,
      planKey: sub?.plans?.key ?? 'free',
      planName: sub?.plans?.name ?? 'Free',
      // Derived client-side with the same rules as shop_effective_status(). The
      // server remains the authority for enforcement; this is just so the list
      // can be sorted and filtered without one RPC per row.
      status: deriveStatus(sub),
      trialEndsAt: sub?.trial_ends_at ?? null,
      currentPeriodEnd: sub?.current_period_end ?? null,
      manualStatus: sub?.manual_status ?? 'active',
      usage: usage.get(shop.id) ?? {},
      limits: sub?.plans?.limits ?? {},
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
