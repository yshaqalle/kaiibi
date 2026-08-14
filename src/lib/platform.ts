import type { LimitResource, SubscriptionStatus } from '@/lib/entitlements';
import { sortPeople, type Branch, type ShopPerson } from '@/lib/shop-people';
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
  /** Every branch, primary first. Their trading addresses, not private data. */
  branches: Branch[];
  /**
   * Everyone who works here, owner first. Filled in by the console after
   * listShopPeople() resolves, so a roster that fails to load leaves this
   * empty rather than taking the whole store row down with it.
   */
  people: ShopPerson[];
  /** shops.owner_id's person, resolved once so callers do not search a list. */
  owner: ShopPerson | null;
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

// Re-exported so console components have one import site for everything the
// portal's data layer hands them, the same way whatsappLink is.
export type { Branch, ShopPerson } from '@/lib/shop-people';

// Who works at each of these stores, in ONE call for the whole console.
//
// Batched rather than fetched per drawer, the same shape listSupportThreads()
// uses for author profiles: the console already holds every store in memory,
// and a per-store read would be N+1 against the busiest screen in the portal.
//
// Goes through platform_shop_people() (20260830000000) rather than a select on
// shop_members: that table's select grant is column-unrestricted, so a
// row-scoped policy would hand back pay_type and pay_rate_cents along with the
// name and role the console shows. The function returns only what is drawn.
export async function listShopPeople(shopIds: string[]): Promise<Map<string, ShopPerson[]>> {
  const people = new Map<string, ShopPerson[]>();
  // `any` on an empty list is a request that can only return nothing.
  if (shopIds.length === 0) return people;

  const { data, error } = await supabase.rpc('platform_shop_people', { p_shop_ids: shopIds });
  if (error) throw error;

  for (const row of (data ?? []) as any[]) {
    const person: ShopPerson = {
      userId: row.user_id,
      shopId: row.shop_id,
      // Never an empty row: the provisioning trigger (20260823000000) already
      // falls back to the email's local part, so this is the last resort
      // rather than the common case -- and it never invents a name from the
      // store's.
      name: row.full_name?.trim() || (row.is_owner ? 'Owner' : 'Team member'),
      email: row.email,
      phone: row.phone,
      roleName: row.role_name,
      permissions: row.role_permissions ?? [],
      isOwner: row.is_owner,
      active: row.active,
      joinedAt: row.joined_at,
      // Empty means EVERY branch. Carried through untouched; the label is
      // computed by branchAccessLabel(), which knows that.
      branchNames: row.branch_names ?? [],
    };
    const existing = people.get(person.shopId);
    if (existing) existing.push(person);
    else people.set(person.shopId, [person]);
  }

  for (const [shopId, list] of people) people.set(shopId, sortPeople(list));
  return people;
}

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
    // Every branch, not just the primary one. The operator policy
    // ("operators read locations", 20260818000500) already covers all of them
    // -- this filter was throwing away rows the console was allowed to see and
    // then rendering "2 / 3 branches" as a number with no places in it.
    supabase.from('shop_locations').select('id, shop_id, name, contact_phone, city, neighborhood, is_primary'),
  ]);
  if (shopsRes.error) throw shopsRes.error;
  if (subsRes.error) throw subsRes.error;
  if (usageRes.error) throw usageRes.error;
  if (locationsRes.error) throw locationsRes.error;

  const branchesByShop = new Map<string, Branch[]>();
  for (const row of (locationsRes.data ?? []) as any[]) {
    const branch: Branch = {
      id: row.id,
      name: row.name,
      city: row.city,
      neighborhood: row.neighborhood,
      phone: row.contact_phone,
      isPrimary: row.is_primary,
    };
    const existing = branchesByShop.get(row.shop_id);
    if (existing) existing.push(branch);
    else branchesByShop.set(row.shop_id, [branch]);
  }
  // Primary first, then by name: the drawer reads this top to bottom and the
  // main branch is the one an operator is looking for.
  for (const [shopId, list] of branchesByShop) {
    branchesByShop.set(
      shopId,
      [...list].sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary) || a.name.localeCompare(b.name))
    );
  }

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
      // Kept for the callers that already read them, and still the PRIMARY
      // branch's -- the number on their receipts.
      contactPhone: branchesByShop.get(shop.id)?.find((b) => b.isPrimary)?.phone ?? null,
      city: branchesByShop.get(shop.id)?.find((b) => b.isPrimary)?.city ?? null,
      branches: branchesByShop.get(shop.id) ?? [],
      // Filled in by the console once listShopPeople() resolves, so a roster
      // that fails to load leaves these empty rather than failing the store.
      people: [],
      owner: null,
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

// One row per conversation for the operator queue.
//
// No `planName`: the only honest value here would come from a subscription join
// this query deliberately does not pay for, and a field the producer always
// leaves empty is a placeholder that type-checks. The console already holds
// `PlatformShopRow[]` and already joins by shopId for the store's name, exactly
// as PendingPlanRequest and RequestsTab do — the plan is one more column of
// that same join, resolved where the data is.
export type PlatformSupportThread = {
  id: string;
  reference: string;
  shopId: string;
  shopName: string;
  subject: string;
  category: string;
  area: string | null;
  areaOther: string | null;
  status: 'open' | 'closed';
  openedBy: 'shop' | 'platform';
  contactPreference: 'in_app' | 'whatsapp' | 'email';
  clientContext: Record<string, string>;
  lastMessageAt: string;
  platformReadAt: string | null;
  shopReadAt: string | null;
  // Null on a thread we started. Kept beside the name so the reply panel can
  // tell "nobody wrote this" apart from "we could not read who did".
  authorUserId: string | null;
  authorName: string | null;
  authorPhone: string | null;
  messageCount: number;
  attachmentCount: number;
  lastAuthorKind: 'shop' | 'platform';
};

// Four states, each naming WHOSE MOVE IT IS. Sorting a one-operator queue by
// age buries an answered thread under an unanswered one; sorting by this does
// not. 'unread_by_them' is the one that matters for a message we started --
// an outbound message nobody has opened is a message that never happened.
export function supportQueueState(
  thread: PlatformSupportThread
): 'needs_reply' | 'waiting_on_them' | 'unread_by_them' | 'closed' {
  if (thread.status === 'closed') return 'closed';
  if (thread.lastAuthorKind === 'shop') return 'needs_reply';
  // A stamp older than the message it would cover is the store having read the
  // PREVIOUS reply. Comparing rather than counting is what makes that survive
  // a thread being replied to twice.
  if (!thread.shopReadAt || Date.parse(thread.shopReadAt) < Date.parse(thread.lastMessageAt)) {
    return 'unread_by_them';
  }
  return 'waiting_on_them';
}

// The whole queue, with enough of each thread to triage it without opening it.
//
// The author's name comes from a SECOND read rather than an embed:
// support_threads.author_user_id points at auth.users, and profiles.id points
// at auth.users too, which is not a relationship PostgREST can traverse -- an
// embed here fails at the API, not at the type. Two narrow reads, joined in
// memory, is the same shape listPlatformShops already uses. That second read
// goes through support_author_profiles() (20260825000400) rather than a plain
// select on `profiles`: the table's select grant is column-unrestricted, so a
// row-scoped policy alone would have hand back role and password_changed_at
// along with the name and phone the console shows. The function returns only
// those three.
//
// The 200-row cap, and support_threads_recent_idx (20260825000400) that makes
// it a cheap query rather than a slow one: this list has no status filter, so
// closed threads never age out of it, and an operator's console loading
// every message and attachment on every thread ever opened does not stay fast
// forever. `truncated` tells the caller when the cap actually bit, so a queue
// that quietly dropped its oldest rows is never mistaken for a short one.
const SUPPORT_QUEUE_LIMIT = 200;

export async function listSupportThreads(): Promise<{
  threads: PlatformSupportThread[];
  truncated: boolean;
}> {
  const { data, error } = await supabase
    .from('support_threads')
    .select(
      'id, reference, shop_id, author_user_id, subject, category, area, area_other, status, opened_by, contact_preference, client_context, last_message_at, platform_read_at, shop_read_at, shops(name), support_messages(author_kind, created_at, support_attachments(id))'
    )
    .order('last_message_at', { ascending: false })
    .limit(SUPPORT_QUEUE_LIMIT);
  if (error) throw error;
  const rows = data ?? [];

  // Skipped entirely when every thread is one we started -- `in` on an empty
  // list is a request that can only return nothing.
  const authorIds = [...new Set(rows.map((row: any) => row.author_user_id).filter(Boolean))] as string[];
  const authors = new Map<string, { full_name: string | null; phone: string | null }>();
  if (authorIds.length > 0) {
    const { data: profiles, error: profilesError } = await supabase.rpc('support_author_profiles', {
      p_author_ids: authorIds,
    });
    if (profilesError) throw profilesError;
    for (const profile of profiles ?? []) authors.set(profile.id, profile);
  }

  const threads = rows.map((row: any) => {
    const messages = (row.support_messages ?? []) as {
      author_kind: 'shop' | 'platform';
      created_at: string;
      support_attachments: unknown[];
    }[];
    // PostgREST does not order an embedded resource, so the last element of
    // what it returns is not the last message. Getting this wrong puts a thread
    // in the wrong queue, which is the one thing this list exists to get right.
    const sorted = [...messages].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
    const author = row.author_user_id ? authors.get(row.author_user_id) : undefined;
    return {
      id: row.id,
      reference: row.reference,
      shopId: row.shop_id,
      shopName: row.shops?.name ?? 'Unknown store',
      subject: row.subject,
      category: row.category,
      area: row.area,
      areaOther: row.area_other,
      status: row.status,
      openedBy: row.opened_by,
      contactPreference: row.contact_preference,
      clientContext: row.client_context ?? {},
      lastMessageAt: row.last_message_at,
      platformReadAt: row.platform_read_at,
      shopReadAt: row.shop_read_at,
      authorUserId: row.author_user_id ?? null,
      authorName: author?.full_name ?? null,
      authorPhone: author?.phone ?? null,
      messageCount: sorted.length,
      attachmentCount: sorted.reduce((sum, m) => sum + (m.support_attachments?.length ?? 0), 0),
      // A thread whose messages we cannot see at all still belongs in a queue,
      // and the end that opened it is the only end that can have written last.
      lastAuthorKind: sorted[sorted.length - 1]?.author_kind ?? row.opened_by,
    };
  });

  // Exactly SUPPORT_QUEUE_LIMIT rows is the signal: the query cannot ask
  // Postgres "was there a 201st" without fetching it, and a cap that bites
  // silently is worse than one the operator is told about.
  return { threads, truncated: threads.length === SUPPORT_QUEUE_LIMIT };
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
