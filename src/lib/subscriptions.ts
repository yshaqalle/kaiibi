import {
  expandModules,
  FREE_FALLBACK,
  type Entitlements,
  type LimitResource,
  type SubscriptionStatus,
} from '@/lib/entitlements';
import { supabase } from '@/lib/supabase';

// A plan as the upgrade screen renders it. Only the public, active ones are
// ever listed -- `trial` is assigned by trigger and never chosen, and a
// negotiated one-off deal shouldn't appear on anyone else's pricing table.
export type Plan = {
  id: string;
  key: string;
  name: string;
  description: string | null;
  priceCents: number;
  currency: string;
  billingInterval: 'month' | 'year' | null;
  modules: string[];
  limits: Partial<Record<LimitResource, number | null>>;
  sortOrder: number;
};

function mapPlanRow(row: any): Plan {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    description: row.description,
    priceCents: row.price_cents,
    currency: row.currency,
    billingInterval: row.billing_interval,
    modules: row.modules ?? [],
    limits: row.limits ?? {},
    sortOrder: row.sort_order,
  };
}

// my_shop_entitlements() returns one jsonb blob rather than a row set, so this
// is a plain shape map rather than the usual column mapper.
function mapEntitlements(payload: any): Entitlements {
  return {
    resolved: true,
    status: payload.status as SubscriptionStatus,
    planKey: payload.plan?.key ?? FREE_FALLBACK.planKey,
    planName: payload.plan?.name ?? FREE_FALLBACK.planName,
    priceCents: payload.plan?.price_cents ?? 0,
    currency: payload.plan?.currency ?? 'USD',
    billingInterval: payload.plan?.billing_interval ?? null,
    // Filtered through the catalog rather than trusted verbatim: a plan row can
    // name a module this build has never heard of.
    modules: expandModules(payload.modules ?? []),
    limits: payload.limits ?? {},
    usage: payload.usage ?? {},
    trialEndsAt: payload.trial_ends_at ?? null,
    currentPeriodEnd: payload.current_period_end ?? null,
    graceUntil: payload.grace_until ?? null,
  };
}

// One round trip for status, plan, resolved modules, limits and usage --
// the entitlement twin of getMyPermissions()'s my_shop_permissions() call.
//
// Deliberately NOT fail-safe here: this throws, and use-auth's Promise.allSettled
// turns a rejection into FREE_FALLBACK. Swallowing the error into a default
// inside this function would make a real outage indistinguishable from a shop
// that genuinely is on Free, and the caller is where that distinction gets
// handled.
export async function getMyEntitlements(shopId: string): Promise<Entitlements> {
  const { data, error } = await supabase.rpc('my_shop_entitlements', { p_shop_id: shopId });
  if (error) throw error;
  if (!data) throw new Error('my_shop_entitlements returned no payload');
  return mapEntitlements(data);
}

export type PlanChangeRequest = {
  id: string;
  status: 'pending' | 'approved' | 'declined';
  planKey: string;
  planName: string;
  note: string | null;
  decisionNote: string | null;
  createdAt: string;
};

// The shop's own latest request, whatever its state — a declined one still has
// to be shown, or the shop is left waiting on an answer that already came.
export async function getMyPlanChangeRequest(shopId: string): Promise<PlanChangeRequest | null> {
  const { data, error } = await supabase.rpc('my_plan_change_request', { p_shop_id: shopId });
  if (error) throw error;
  if (!data) return null;
  const row = data as any;
  return {
    id: row.id,
    status: row.status,
    planKey: row.plan_key,
    planName: row.plan_name,
    note: row.note,
    decisionNote: row.decision_note,
    createdAt: row.created_at,
  };
}

// Asks to move tier. Deliberately not a switch: payment is confirmed by hand,
// so an operator approving is what ties the tier to money arriving. See
// migration 20260818000700.
export async function requestPlanChange(shopId: string, planId: string, note: string | null): Promise<void> {
  const { data: userData } = await supabase.auth.getUser();
  const userId = userData.user?.id;
  if (!userId) throw new Error('Must be signed in to request a plan change.');
  const { error } = await supabase.from('plan_change_requests').insert({
    shop_id: shopId,
    requested_plan_id: planId,
    requested_by: userId,
    note,
  });
  if (error) throw error;
}

// Cancelling is deleting the pending row — the shop withdrawing its own ask,
// which must not look like an operator's decision in the record.
export async function cancelPlanChangeRequest(requestId: string): Promise<void> {
  const { error } = await supabase.from('plan_change_requests').delete().eq('id', requestId);
  if (error) throw error;
}

// The tiers a shop can move to, in display order.
export async function listPlans(): Promise<Plan[]> {
  const { data, error } = await supabase
    .from('plans')
    .select('*')
    .eq('is_public', true)
    .eq('active', true)
    .order('sort_order', { ascending: true });
  if (error) throw error;
  return (data ?? []).map(mapPlanRow);
}
