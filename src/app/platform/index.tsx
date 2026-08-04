import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View, useWindowDimensions } from 'react-native';

import { PlatformOverview } from '@/components/platform-overview';
import { TABLET_BREAKPOINT } from '@/constants/layout';
import { formatCents } from '@/lib/currency';
import { LIMIT_RESOURCES, MODULES, type SubscriptionStatus } from '@/lib/entitlements';
import {
  callPlatformAdmin,
  listAuditLog,
  listOperators,
  listPendingPlanRequests,
  listPlatformShops,
  listSubscriptionPayments,
  type PendingPlanRequest,
  type PlatformAuditRow,
  type PlatformOperator,
  type PlatformShopRow,
  type SubscriptionPaymentRow,
} from '@/lib/platform';
import { listAllPlans, type Plan } from '@/lib/subscriptions';

type Tab = 'overview' | 'shops' | 'requests' | 'plans' | 'audit' | 'operators';

export default function PlatformHome() {
  const [tab, setTab] = useState<Tab>('overview');
  const [shops, setShops] = useState<PlatformShopRow[]>([]);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [audit, setAudit] = useState<PlatformAuditRow[]>([]);
  const [operators, setOperators] = useState<PlatformOperator[]>([]);
  const [requests, setRequests] = useState<PendingPlanRequest[]>([]);
  const [payments, setPayments] = useState<SubscriptionPaymentRow[]>([]);
  // When the data on screen was fetched. Passed to the dashboard so every
  // figure is measured against one instant, and so nothing reads the clock
  // during render.
  const [loadedAt, setLoadedAt] = useState(() => Date.now());
  const [selected, setSelected] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const { width } = useWindowDimensions();
  const compact = width < TABLET_BREAKPOINT;

  // Does not re-arm `loading`: the initial value covers the first load, and a
  // refresh after an action should update the table in place rather than
  // replacing the operator's screen with a spinner and losing their scroll
  // position mid-task.
  const reload = useCallback(async () => {
    const [shopRows, planRows, auditRows, operatorRows, requestRows, paymentRows] = await Promise.all([
      listPlatformShops(),
      listAllPlans(),
      listAuditLog(),
      listOperators(),
      listPendingPlanRequests(),
      listSubscriptionPayments(),
    ]);
    setShops(shopRows);
    setPlans(planRows);
    setAudit(auditRows);
    setOperators(operatorRows);
    setRequests(requestRows);
    setPayments(paymentRows);
    setLoadedAt(Date.now());
    setLoading(false);
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return shops;
    return shops.filter((s) => s.shopName.toLowerCase().includes(q) || s.planKey.includes(q) || s.status.includes(q));
  }, [shops, search]);

  const counts = useMemo(() => {
    const by = (status: SubscriptionStatus) => shops.filter((s) => s.status === status).length;
    // Monthly recurring revenue: only shops actually paying right now. Trials
    // and lapsed shops are excluded on purpose — counting them is how a
    // dashboard tells you the business is doing better than it is.
    const mrr = shops
      .filter((s) => s.status === 'active')
      .reduce((sum, s) => sum + (plans.find((p) => p.key === s.planKey)?.priceCents ?? 0), 0);
    return { trialing: by('trialing'), active: by('active'), grace: by('grace'), expired: by('expired'), suspended: by('suspended'), mrr };
  }, [shops, plans]);

  const selectedShop = shops.find((s) => s.shopId === selected) ?? null;

  const nav = (['overview', 'shops', 'requests', 'plans', 'audit', 'operators'] as Tab[]).map((t) => (
    <Pressable key={t} onPress={() => setTab(t)} style={[styles.navItem, tab === t && styles.navItemActive]}>
      <Text style={[styles.navText, tab === t && styles.navTextActive]}>
        {TAB_LABELS[t]}
        {t === 'requests' && requests.length > 0 ? `  ${requests.length}` : ''}
      </Text>
    </Pressable>
  ));

  return (
    <View style={[styles.root, compact && styles.rootCompact]}>
      {/* The 200px sidebar is a quarter of a phone screen, so on narrow it
          becomes a scrollable strip along the top — the same nav, laid out the
          way the space allows. */}
      {compact ? (
        <View style={styles.topBar}>
          <Text style={styles.brandCompact}>KAIIBI PLATFORM</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.topNav}>
            {nav}
          </ScrollView>
        </View>
      ) : (
        <View style={styles.sidebar}>
          <Text style={styles.brand}>KAIIBI</Text>
          <Text style={styles.brandSub}>PLATFORM</Text>
          <View style={styles.nav}>{nav}</View>
        </View>
      )}

      <ScrollView style={styles.main} contentContainerStyle={compact ? styles.mainContentCompact : styles.mainContent}>
        {loading ? (
          <ActivityIndicator style={{ marginTop: 40 }} />
        ) : tab === 'overview' ? (
          <PlatformOverview
            shops={shops}
            plans={plans}
            payments={payments}
            audit={audit}
            compact={compact}
            now={loadedAt}
            onOpenShop={(id) => {
              setSelected(id);
              setTab('shops');
            }}
          />
        ) : tab === 'shops' ? (
          <>
            <View style={styles.tiles}>
              <Tile label="MRR" value={formatCents(counts.mrr)} sub="paying shops only" />
              <Tile label="Paying" value={String(counts.active)} />
              <Tile label="On trial" value={String(counts.trialing)} />
              <Tile label="Grace" value={String(counts.grace)} />
              <Tile label="Expired" value={String(counts.expired)} />
            </View>

            <TextInput
              value={search}
              onChangeText={setSearch}
              placeholder="Search shop, plan, or status"
              placeholderTextColor="#AAAAAA"
              style={styles.search}
            />

            {!compact && (
              <View style={styles.tableHead}>
                <Text style={[styles.th, styles.colShop]}>SHOP</Text>
                <Text style={[styles.th, styles.colPlan]}>PLAN</Text>
                <Text style={[styles.th, styles.colStatus]}>STATUS</Text>
                <Text style={[styles.th, styles.colDate]}>JOINED</Text>
                <Text style={[styles.th, styles.colDate]}>ENDS</Text>
                <Text style={[styles.th, styles.colStores]}>STORES</Text>
                <Text style={[styles.th, styles.colUsage]}>PRODUCTS</Text>
              </View>
            )}
            {filtered.map((shop) => {
              const storeLimit = shop.limits.locations ?? null;
              const stores = shop.usage.locations ?? 0;
              const products = shop.usage.products ?? 0;
              const productLimit = shop.limits.products ?? null;
              // What their cover runs to, and what kind of date that is. A
              // trialing shop's clock is trial_ends_at; a paying one's is the
              // period they bought. Saying which avoids reading "2 Nov" as a
              // renewal when it is actually the day they lose access.
              const ends = shop.status === 'trialing' ? shop.trialEndsAt : shop.currentPeriodEnd ?? shop.trialEndsAt;
              const endsLabel = shop.status === 'trialing' ? 'trial ends' : 'renews';
              // A shop can sit on a paid plan while still inside its free
              // trial: the plan is what they GET, the status is how they are
              // PAYING. Shown as "trialing · Pro" rather than leaving the two
              // columns looking like they disagree.
              const onPaidPlanInTrial = shop.status === 'trialing' && shop.planKey !== 'trial';
              // Narrow: one card per shop, name on top and the numbers
              // beneath. Squeezing five columns onto a phone makes every one of
              // them unreadable, which is worse than stacking.
              if (compact) {
                return (
                  <Pressable
                    key={shop.shopId}
                    onPress={() => setSelected(shop.shopId === selected ? null : shop.shopId)}
                    style={styles.card}
                  >
                    <Text style={styles.cardName} numberOfLines={1}>{shop.shopName}</Text>
                    <View style={styles.cardMeta}>
                      <Text style={[styles.status, STATUS_COLOR[shop.status]]}>{STATUS_DOT[shop.status]} {shop.status}</Text>
                      <Text style={styles.cardPlan}>{shop.planName}</Text>
                    </View>
                    <Text style={styles.cardDates}>
                      joined {fmtDate(shop.createdAt)}
                      {ends ? ` · ${endsLabel} ${fmtDate(ends)}` : ''}
                    </Text>
                    <Text style={styles.cardUsage}>
                      <Text style={storeLimit != null && stores >= storeLimit ? styles.tdAtLimit : undefined}>
                        {stores}{storeLimit != null ? `/${storeLimit}` : ''} stores
                      </Text>
                      {'   ·   '}
                      <Text style={productLimit != null && products >= productLimit ? styles.tdAtLimit : undefined}>
                        {products.toLocaleString()}{productLimit != null ? `/${productLimit.toLocaleString()}` : ''} products
                      </Text>
                    </Text>
                  </Pressable>
                );
              }
              return (
                <Pressable
                  key={shop.shopId}
                  onPress={() => setSelected(shop.shopId === selected ? null : shop.shopId)}
                  style={[styles.tr, selected === shop.shopId && styles.trSelected]}
                >
                  <Text style={[styles.td, styles.colShop]} numberOfLines={1}>{shop.shopName}</Text>
                  <Text style={[styles.td, styles.colPlan]}>{shop.planName}</Text>
                  <View style={styles.colStatus}>
                    <Text style={[styles.status, STATUS_COLOR[shop.status]]}>{STATUS_DOT[shop.status]} {shop.status}</Text>
                    {onPaidPlanInTrial && <Text style={styles.statusNote}>free until trial ends</Text>}
                  </View>
                  <Text style={[styles.td, styles.colDate, styles.tdMuted]}>{fmtDate(shop.createdAt)}</Text>
                  <Text style={[styles.td, styles.colDate, endsSoon(ends) && styles.tdAtLimit]}>{fmtDate(ends)}</Text>
                  <Text style={[styles.td, styles.colStores, storeLimit != null && stores >= storeLimit && styles.tdAtLimit]}>
                    {stores}{storeLimit != null ? ` / ${storeLimit}` : ''}
                  </Text>
                  <Text style={[styles.td, styles.colUsage, productLimit != null && products >= productLimit && styles.tdAtLimit]}>
                    {products.toLocaleString()}{productLimit != null ? ` / ${productLimit.toLocaleString()}` : ' / ∞'}
                  </Text>
                </Pressable>
              );
            })}

            {/* The detail is always a modal now. Inline, it appended itself
                below a long table, so tapping a shop put the answer off-screen
                and left you scrolling to find what you had just clicked. */}
          </>
        ) : tab === 'requests' ? (
          <RequestsView requests={requests} shops={shops} onDone={reload} />
        ) : tab === 'plans' ? (
          <PlansView plans={plans} shops={shops} onDone={reload} />
        ) : tab === 'audit' ? (
          <AuditView rows={audit} shops={shops} />
        ) : (
          <OperatorsView operators={operators} />
        )}
      </ScrollView>

      {/* One modal, two presentations: a sheet rising from the bottom where
          the screen is narrow, a centred dialog where there is room for one.
          Same content either way. */}
      {selectedShop && (
        <Modal visible transparent animationType={compact ? 'slide' : 'fade'} onRequestClose={() => setSelected(null)}>
          <View style={[styles.sheetBackdrop, !compact && styles.dialogBackdrop]}>
            {/* Tapping the dimmed area closes — the expected way out when the
                button is below the fold. */}
            <Pressable style={compact ? styles.sheetDismiss : StyleSheet.absoluteFill} onPress={() => setSelected(null)} />
            <View style={compact ? styles.sheet : styles.dialog}>
              {compact && <View style={styles.sheetGrabber} />}
              <View style={styles.dialogHeader}>
                <Text style={styles.dialogTitle} numberOfLines={1}>{selectedShop.shopName}</Text>
                <Pressable onPress={() => setSelected(null)} hitSlop={10}>
                  <Text style={styles.dialogClose}>✕</Text>
                </Pressable>
              </View>
              <ScrollView contentContainerStyle={styles.sheetContent}>
                <ShopDetail shop={selectedShop} plans={plans} onDone={reload} />
              </ScrollView>
            </View>
          </View>
        </Modal>
      )}
    </View>
  );
}

function ShopDetail({ shop, plans, onDone }: { shop: PlatformShopRow; plans: Plan[]; onDone: () => Promise<void> }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [planKey, setPlanKey] = useState(shop.planKey);
  const [days, setDays] = useState('14');

  const run = async (action: string, payload: Record<string, unknown>) => {
    if (!reason.trim()) {
      setError('A reason is required for every change.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await callPlatformAdmin(action, { shopId: shop.shopId, ...payload }, reason.trim());
      setReason('');
      await onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That change did not go through.');
    } finally {
      setBusy(false);
    }
  };

  // What a downgrade would actually cost this shop, computed before it is
  // applied. The difference between an informed support action and an angry
  // phone call.
  const target = plans.find((p) => p.key === planKey);
  const wouldExceed = target
    ? LIMIT_RESOURCES.filter((r) => {
        const limit = target.limits[r.key];
        return limit != null && (shop.usage[r.key] ?? 0) > limit;
      })
    : [];

  return (
    <View style={styles.detail}>
      <Text style={styles.detailMeta}>
        created {shop.createdAt.slice(0, 10)} · {shop.planName} · {shop.status}
      </Text>

      <Text style={styles.detailSection}>USAGE</Text>
      {LIMIT_RESOURCES.map((r) => {
        const limit = shop.limits[r.key] ?? null;
        const used = shop.usage[r.key] ?? 0;
        return (
          <View key={r.key} style={styles.usageRow}>
            <Text style={styles.usageLabel}>{r.label}</Text>
            <Text style={[styles.usageValue, limit != null && used >= limit && styles.tdAtLimit]}>
              {used.toLocaleString()} / {limit == null ? '∞' : limit.toLocaleString()}
            </Text>
          </View>
        );
      })}

      <Text style={styles.detailSection}>MODULES</Text>
      <Text style={styles.modules}>
        {MODULES.filter((m) => (plans.find((p) => p.key === shop.planKey)?.modules ?? []).includes(m.key))
          .map((m) => m.label)
          .join(' · ') || 'none'}
      </Text>

      <Text style={styles.detailSection}>ACTIONS</Text>
      <TextInput
        value={reason}
        onChangeText={setReason}
        placeholder="Reason (required — goes into the audit log)"
        placeholderTextColor="#AAAAAA"
        style={[styles.reasonInput, !reason.trim() && styles.reasonInputNeeded]}
      />

      <View style={styles.actionRow}>
        {plans.filter((p) => p.isPublic).map((p) => (
          <Pressable key={p.key} onPress={() => setPlanKey(p.key)} style={[styles.chip, planKey === p.key && styles.chipActive]}>
            <Text style={[styles.chipText, planKey === p.key && styles.chipTextActive]}>{p.name}</Text>
          </Pressable>
        ))}
      </View>

      {wouldExceed.length > 0 && (
        <Text style={styles.warn}>
          ⚠ {target?.name} would put this shop over {wouldExceed.length} limit{wouldExceed.length === 1 ? '' : 's'}:{' '}
          {wouldExceed.map((r) => `${r.label.toLowerCase()} ${shop.usage[r.key] ?? 0}/${target!.limits[r.key]}`).join(', ')}.
          Existing data is kept and stays editable; new records are blocked until they are back under.
        </Text>
      )}

      {!reason.trim() && <Text style={styles.hintNeeded}>Type a reason to enable these actions.</Text>}
      <View style={styles.actionRow}>
        <Btn label="Change plan" disabled={busy || !reason.trim() || planKey === shop.planKey} onPress={() => run('set_plan', { planKey })} />
        <View style={styles.inlineDays}>
          <TextInput value={days} onChangeText={setDays} keyboardType="number-pad" style={styles.daysInput} />
          <Btn label="Extend trial" disabled={busy || !reason.trim()} onPress={() => run('extend_trial', { days: Number(days) || 0 })} />
        </View>
        {shop.manualStatus === 'suspended' ? (
          <Btn label="Unsuspend" disabled={busy || !reason.trim()} onPress={() => run('unsuspend', {})} />
        ) : (
          <Btn label="Suspend" danger disabled={busy || !reason.trim()} onPress={() => run('suspend', {})} />
        )}
      </View>

      <Text style={styles.detailSection}>RECORD PAYMENT</Text>
      <RecordPayment shop={shop} plans={plans} reason={reason} busy={busy} onRun={run} />

      {error && <Text style={styles.error}>{error}</Text>}

      <DangerZone shop={shop} onDone={onDone} />

      <Text style={styles.privacyNote}>
        This portal cannot open this shop&apos;s products, sales, books, or schedule.
      </Text>
    </View>
  );
}

// Deleting a shop. `shops` is the cascade root, so this destroys the
// catalogue, every sale, refunds, customers, books, payroll, shifts, stock and
// every branch. There is no undo anywhere in the system.
//
// Three deliberate pieces of friction, because the cost of a misclick here is
// somebody's business records:
//   1. collapsed by default, so it is never one tap away
//   2. shows what will actually be destroyed, counted, before offering the button
//   3. requires the shop's exact name retyped — a confirm dialog gets dismissed
//      by reflex, typing a name cannot be
//
// The server enforces the name match and an owner-role operator independently,
// so none of this is load-bearing on the client.
function DangerZone({ shop, onDone }: { shop: PlatformShopRow; onDone: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const matches = typed.trim() === shop.shopName;
  const destroyed = LIMIT_RESOURCES.map((r) => ({ label: r.label.toLowerCase(), n: shop.usage[r.key] ?? 0 })).filter(
    (x) => x.n > 0 && x.label !== 'sales this month'
  );

  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      await callPlatformAdmin('delete_shop', { shopId: shop.shopId, confirmName: typed.trim() }, reason.trim());
      await onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete this shop.');
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <>
        <Text style={styles.detailSectionDanger}>DANGER ZONE</Text>
        <View style={styles.actionRow}>
          <Btn label="Delete store / business" danger onPress={() => setOpen(true)} />
        </View>
        <Text style={styles.planMeta}>Permanent. Use Suspend above if you only need to cut off access.</Text>
      </>
    );
  }

  return (
    <>
    <Text style={styles.detailSectionDanger}>DANGER ZONE</Text>
    <View style={styles.dangerBox}>
      <Text style={styles.dangerTitle}>Delete {shop.shopName}</Text>
      <Text style={styles.dangerBody}>
        This permanently destroys everything this business has recorded
        {destroyed.length > 0 ? ` — including ${destroyed.map((d) => `${d.n.toLocaleString()} ${d.label}`).join(', ')}` : ''}
        , along with its sales history, books and payroll. It cannot be undone, and we keep no copy.
      </Text>
      <Text style={styles.dangerBody}>
        If you only need to cut off access, <Text style={styles.dangerStrong}>Suspend</Text> above does that and is
        reversible.
      </Text>

      <TextInput
        value={reason}
        onChangeText={setReason}
        placeholder="Reason (required — goes into the audit log)"
        placeholderTextColor="#C89A9A"
        style={styles.dangerInput}
      />
      <TextInput
        value={typed}
        onChangeText={setTyped}
        placeholder={`Type "${shop.shopName}" to confirm`}
        placeholderTextColor="#C89A9A"
        style={styles.dangerInput}
      />

      {error && <Text style={styles.error}>{error}</Text>}
      <View style={styles.actionRow}>
        <Btn label={busy ? 'Deleting…' : 'Delete this shop forever'} danger disabled={busy || !matches || !reason.trim()} onPress={remove} />
        <Pressable onPress={() => setOpen(false)}>
          <Text style={styles.dangerCancel}>Cancel</Text>
        </Pressable>
      </View>
    </View>
    </>
  );
}

// Recording money that arrived by ZAAD or eDahab. This is the step that turns
// an approved plan into a *paying* customer: approving a tier moves what they
// can do, this moves `current_period_end`, and only shops with a live period
// count toward MRR.
//
// Defaults do the arithmetic an operator would otherwise do by hand at the end
// of a long day: today's date, the plan's own price, and a period running from
// wherever their cover currently ends — so paying a month late buys a month
// from today rather than a month that already elapsed.
function RecordPayment({
  shop,
  plans,
  reason,
  busy,
  onRun,
}: {
  shop: PlatformShopRow;
  plans: Plan[];
  reason: string;
  busy: boolean;
  onRun: (action: string, payload: Record<string, unknown>) => Promise<void>;
}) {
  const plan = plans.find((p) => p.key === shop.planKey);
  const today = new Date().toISOString().slice(0, 10);
  // Paid time starts when free time ends. Taking the latest of their current
  // cover, their trial end, and today matters most for a shop that pays partway
  // through a trial: starting the period today would spend the month they just
  // bought against days they already had for nothing, and they would lapse
  // early having paid in good faith.
  const candidates = [today, shop.currentPeriodEnd?.slice(0, 10), shop.trialEndsAt?.slice(0, 10)].filter(
    (d): d is string => Boolean(d)
  );
  const from = candidates.sort().at(-1) as string;

  const [amount, setAmount] = useState(plan ? String(plan.priceCents / 100) : '');
  const [method, setMethod] = useState('ZAAD');
  const [ref, setRef] = useState('');
  const [paidAt, setPaidAt] = useState(today);
  const [coversFrom, setCoversFrom] = useState(from);
  const [coversTo, setCoversTo] = useState(addMonths(from, 1));
  // Off by default: the fair thing is to honour the free days a shop was
  // promised. On, it converts them today and they give up the remainder.
  const [startNow, setStartNow] = useState(false);

  const trialing = shop.status === 'trialing';
  // Counted between two fixed date strings rather than against the clock:
  // reading the clock during render is impure, and `today` is already fixed for
  // this render anyway, so both figures agree by construction.
  const freeDaysLeft = shop.trialEndsAt ? daysBetween(today, shop.trialEndsAt.slice(0, 10)) : 0;

  // Flipping the toggle rewrites the period in place, so the dates on screen
  // always match what will actually be recorded.
  const applyStartNow = (next: boolean) => {
    setStartNow(next);
    const start = next ? today : from;
    setCoversFrom(start);
    setCoversTo(addMonths(start, 1));
  };

  const submit = () =>
    onRun('record_payment', {
      payment: {
        amountCents: Math.round((Number(amount) || 0) * 100),
        currency: plan?.currency ?? 'USD',
        method,
        providerRef: ref.trim() || null,
        paidAt: new Date(paidAt).toISOString(),
        coversFrom: new Date(coversFrom).toISOString(),
        coversTo: new Date(coversTo).toISOString(),
        endTrialNow: startNow,
      },
    });

  return (
    <View>
      {trialing && (
        <>
          <Pressable onPress={() => applyStartNow(!startNow)} style={styles.convertRow}>
            <View style={[styles.checkbox, startNow && styles.checkboxOn]}>
              {startNow && <Text style={styles.checkboxTick}>✓</Text>}
            </View>
            <Text style={styles.convertLabel}>Start paying today — ends their trial now</Text>
          </Pressable>
          <Text style={styles.planMeta}>
            {startNow
              ? `They become a paying customer today and give up ${freeDaysLeft} free day${freeDaysLeft === 1 ? '' : 's'}. Only do this if they asked for it.`
              : `Their ${freeDaysLeft} remaining free day${freeDaysLeft === 1 ? '' : 's'} are kept — the paid period starts when the trial ends, and they count toward MRR from then.`}
          </Text>
        </>
      )}
      <View style={styles.actionRow}>
        {['ZAAD', 'eDahab', 'Cash', 'Bank'].map((m) => (
          <Pressable key={m} onPress={() => setMethod(m)} style={[styles.chip, method === m && styles.chipActive]}>
            <Text style={[styles.chipText, method === m && styles.chipTextActive]}>{m}</Text>
          </Pressable>
        ))}
      </View>
      <View style={styles.actionRow}>
        <View style={styles.limitField}>
          <Text style={styles.planMeta}>Amount ({plan?.currency ?? 'USD'})</Text>
          <TextInput value={amount} onChangeText={setAmount} keyboardType="decimal-pad" style={styles.payInput} />
        </View>
        <View style={styles.limitField}>
          {/* The ZAAD/eDahab transaction id. Optional, but it is the only thing
              that ties this row back to the money if a payment is disputed. */}
          <Text style={styles.planMeta}>Reference</Text>
          <TextInput value={ref} onChangeText={setRef} placeholder="634812" placeholderTextColor="#CCCCCC" style={styles.payInput} />
        </View>
        <View style={styles.limitField}>
          <Text style={styles.planMeta}>Paid on</Text>
          <TextInput value={paidAt} onChangeText={setPaidAt} style={styles.payInput} />
        </View>
        <View style={styles.limitField}>
          <Text style={styles.planMeta}>Covers from</Text>
          <TextInput value={coversFrom} onChangeText={setCoversFrom} style={styles.payInput} />
        </View>
        <View style={styles.limitField}>
          <Text style={styles.planMeta}>Covers to</Text>
          <TextInput value={coversTo} onChangeText={setCoversTo} style={styles.payInput} />
        </View>
      </View>
      <View style={styles.actionRow}>
        {[1, 3, 12].map((n) => (
          <Pressable key={n} onPress={() => setCoversTo(addMonths(coversFrom, n))} style={styles.chip}>
            <Text style={styles.chipText}>+{n} month{n === 1 ? '' : 's'}</Text>
          </Pressable>
        ))}
        <Btn label="Record payment" disabled={busy || !reason.trim()} onPress={submit} />
      </View>
      <Text style={styles.planMeta}>
        Their access runs to {coversTo}, plus the grace period. Recording a payment does not change their tier — use
        Change plan for that.
      </Text>
    </View>
  );
}

// Whole days from one yyyy-mm-dd to another, floored at zero.
function daysBetween(fromIso: string, toIso: string): number {
  const ms = Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`);
  return Number.isNaN(ms) ? 0 : Math.max(0, Math.round(ms / 86_400_000));
}

// Calendar-month arithmetic on a yyyy-mm-dd string. Clamps the day so paying on
// the 31st cannot roll a one-month period into the month after next — a
// customer who pays on 31 January is covered to 28 February, not 3 March.
function addMonths(iso: string, months: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, lastDay));
  return target.toISOString().slice(0, 10);
}

// The approval queue. A shop cannot move itself between tiers — payment is
// ZAAD/eDahab confirmed by hand, so this is where a tier gets tied to money
// actually arriving.
function RequestsView({
  requests,
  shops,
  onDone,
}: {
  requests: PendingPlanRequest[];
  shops: PlatformShopRow[];
  onDone: () => Promise<void>;
}) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const decide = async (requestId: string, approve: boolean) => {
    // Kept as a guard even though the buttons are disabled without a reason:
    // the server requires one too, and a client-side disable is a courtesy,
    // not a rule.
    if (!reason.trim()) {
      setError('A reason is required — it is what the shop sees if you decline.');
      return;
    }
    setBusy(requestId);
    setError(null);
    try {
      await callPlatformAdmin(approve ? 'approve_plan_change' : 'decline_plan_change', { requestId }, reason.trim());
      setReason('');
      await onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That decision did not go through.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <View>
      <Text style={styles.h1}>Plan requests</Text>
      {requests.length === 0 && <Text style={styles.empty}>Nothing waiting.</Text>}
      {requests.length > 0 && (
        <>
          <TextInput
            value={reason}
            onChangeText={setReason}
            placeholder="Reason (required — a decline shows this to the shop)"
            placeholderTextColor="#AAAAAA"
            style={[styles.reasonInput, !reason.trim() && styles.reasonInputNeeded]}
          />
          {/* Says what's missing before the click rather than after it. The
              buttons below are disabled until this is filled, so the
              requirement is visible rather than discovered by failing. */}
          {!reason.trim() && <Text style={styles.hintNeeded}>Type a reason to enable Approve and Decline.</Text>}
        </>
      )}
      {requests.map((request) => {
        const shop = shops.find((s) => s.shopId === request.shopId);
        return (
          <View key={request.id} style={styles.requestCard}>
            <View style={styles.requestHead}>
              <Text style={styles.requestShop}>{shop?.shopName ?? request.shopId.slice(0, 8)}</Text>
              <Text style={styles.requestMove}>
                {shop?.planName ?? '—'} → <Text style={styles.requestTarget}>{request.planName}</Text>
              </Text>
            </View>
            <Text style={styles.planMeta}>
              asked {request.createdAt.slice(0, 10)}
              {request.note ? ` · “${request.note}”` : ''}
            </Text>
            <View style={styles.actionRow}>
              <Btn label="Approve" disabled={busy !== null || !reason.trim()} onPress={() => decide(request.id, true)} />
              <Btn label="Decline" danger disabled={busy !== null || !reason.trim()} onPress={() => decide(request.id, false)} />
            </View>
          </View>
        );
      })}
      {error && <Text style={styles.error}>{error}</Text>}
      <Text style={styles.privacyNote}>
        Approving moves the tier and records who decided it and why. A shop can raise and cancel its own request but can
        never resolve one — there is no update policy on the table at all, and both decisions run through the audited
        platform-admin function.
      </Text>
    </View>
  );
}

function PlansView({ plans, shops, onDone }: { plans: Plan[]; shops: PlatformShopRow[]; onDone: () => Promise<void> }) {
  const [editing, setEditing] = useState<string | null>(null);
  return (
    <View>
      <Text style={styles.h1}>Plans</Text>
      {plans.map((plan) => {
        const on = shops.filter((s) => s.planKey === plan.key).length;
        if (editing === plan.key) {
          return <PlanEditor key={plan.id} plan={plan} shopsOn={on} shops={shops} onClose={() => setEditing(null)} onDone={onDone} />;
        }
        return (
          <View key={plan.id} style={styles.planCard}>
            <View style={styles.planHead}>
              <Text style={styles.planName}>{plan.name}</Text>
              <View style={styles.actionRow}>
                <Text style={styles.planPrice}>
                  {plan.priceCents === 0 ? 'Free' : `${formatCents(plan.priceCents)}/${plan.billingInterval ?? 'month'}`}
                </Text>
                <Btn label="Edit" onPress={() => setEditing(plan.key)} />
              </View>
            </View>
            <Text style={styles.planMeta}>{on} shop{on === 1 ? '' : 's'} on this plan</Text>
            <Text style={styles.planModules}>{plan.modules.join(' · ')}</Text>
            <Text style={styles.planMeta}>
              {LIMIT_RESOURCES.map((r) => `${r.label}: ${plan.limits[r.key] ?? '∞'}`).join('  ·  ')}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

// Editing a plan changes entitlements for every shop on it at once, with no
// further confirmation anywhere — which is why the blast radius is computed and
// shown before saving rather than described in the abstract.
function PlanEditor({
  plan,
  shopsOn,
  shops,
  onClose,
  onDone,
}: {
  plan: Plan;
  shopsOn: number;
  shops: PlatformShopRow[];
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const [name, setName] = useState(plan.name);
  const [price, setPrice] = useState(String(plan.priceCents / 100));
  const [modules, setModules] = useState<string[]>(plan.modules);
  // Kept as raw text, blank meaning unlimited, so an operator clearing a field
  // says "no cap" rather than being forced to invent a number.
  const [limits, setLimits] = useState<Record<string, string>>(
    Object.fromEntries(LIMIT_RESOURCES.map((r) => [r.key, plan.limits[r.key] == null ? '' : String(plan.limits[r.key])]))
  );
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = (key: string) =>
    setModules((current) => (current.includes(key) ? current.filter((m) => m !== key) : [...current, key]));

  // Who this edit actually hurts, right now, by name.
  const losingModules = plan.modules.filter((m) => !modules.includes(m));
  const strandedByLimit = LIMIT_RESOURCES.flatMap((r) => {
    const raw = limits[r.key].trim();
    if (raw === '') return [];
    const next = Number(raw);
    if (!Number.isFinite(next)) return [];
    const over = shops.filter((s) => s.planKey === plan.key && (s.usage[r.key] ?? 0) > next);
    return over.length > 0 ? [`${over.length} over ${r.label.toLowerCase()}`] : [];
  });

  const save = async () => {
    if (!reason.trim()) {
      setError('A reason is required for every change.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await callPlatformAdmin(
        'upsert_plan',
        {
          plan: {
            key: plan.key,
            name: name.trim(),
            price_cents: Math.round((Number(price) || 0) * 100),
            modules,
            limits: Object.fromEntries(
              LIMIT_RESOURCES.map((r) => [r.key, limits[r.key].trim() === '' ? null : Number(limits[r.key])]).filter(
                ([, v]) => v !== null
              )
            ),
          },
        },
        reason.trim()
      );
      await onDone();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save that plan.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={[styles.planCard, styles.planCardEditing]}>
      <View style={styles.planHead}>
        <TextInput value={name} onChangeText={setName} style={styles.planNameInput} />
        <View style={styles.inlineDays}>
          <Text style={styles.planMeta}>$</Text>
          <TextInput value={price} onChangeText={setPrice} keyboardType="decimal-pad" style={styles.daysInput} />
          <Btn label="Cancel" onPress={onClose} />
        </View>
      </View>
      <Text style={styles.planMeta}>key `{plan.key}` — not editable, {shopsOn} shop{shopsOn === 1 ? '' : 's'} depend on it</Text>

      <Text style={styles.detailSection}>MODULES</Text>
      <View style={styles.actionRow}>
        {MODULES.map((m) => (
          <Pressable key={m.key} onPress={() => toggle(m.key)} style={[styles.chip, modules.includes(m.key) && styles.chipActive]}>
            <Text style={[styles.chipText, modules.includes(m.key) && styles.chipTextActive]}>{m.label}</Text>
          </Pressable>
        ))}
      </View>

      <Text style={styles.detailSection}>LIMITS — blank means unlimited</Text>
      <View style={styles.actionRow}>
        {LIMIT_RESOURCES.map((r) => (
          <View key={r.key} style={styles.limitField}>
            <Text style={styles.planMeta}>{r.label}</Text>
            <TextInput
              value={limits[r.key]}
              onChangeText={(v) => setLimits((c) => ({ ...c, [r.key]: v }))}
              keyboardType="number-pad"
              placeholder="∞"
              placeholderTextColor="#CCCCCC"
              style={styles.daysInput}
            />
          </View>
        ))}
      </View>

      {(losingModules.length > 0 || strandedByLimit.length > 0) && shopsOn > 0 && (
        <Text style={styles.warn}>
          ⚠ This affects {shopsOn} shop{shopsOn === 1 ? '' : 's'} immediately.
          {losingModules.length > 0 ? ` Removing ${losingModules.join(', ')} makes that data read-only for them at once.` : ''}
          {strandedByLimit.length > 0 ? ` Lowering caps strands ${strandedByLimit.join(', ')} — existing records are kept, new ones blocked.` : ''}
        </Text>
      )}

      <TextInput
        value={reason}
        onChangeText={setReason}
        placeholder="Reason (required — goes into the audit log)"
        placeholderTextColor="#AAAAAA"
        style={[styles.reasonInput, !reason.trim() && styles.reasonInputNeeded]}
      />
      {error && <Text style={styles.error}>{error}</Text>}
      <View style={styles.actionRow}>
        <Btn label={busy ? 'Saving…' : 'Save plan'} disabled={busy} onPress={save} />
      </View>
    </View>
  );
}

function AuditView({ rows, shops }: { rows: PlatformAuditRow[]; shops: PlatformShopRow[] }) {
  const shopName = (id: string | null) => shops.find((s) => s.shopId === id)?.shopName ?? (id ? id.slice(0, 8) : '—');
  return (
    <View>
      <Text style={styles.h1}>Audit log</Text>
      {rows.length === 0 && <Text style={styles.empty}>Nothing recorded yet.</Text>}
      {rows.map((row) => (
        <View key={row.id} style={styles.auditRow}>
          <Text style={styles.auditWhen}>{row.createdAt.slice(0, 16).replace('T', ' ')}</Text>
          <Text style={styles.auditAction}>{row.action}</Text>
          <Text style={styles.auditShop}>{shopName(row.targetShopId)}</Text>
          <Text style={styles.auditReason} numberOfLines={2}>{row.reason}</Text>
        </View>
      ))}
      <Text style={styles.privacyNote}>
        Append-only. No client has an insert, update, or delete policy on this table — rows are written by the service
        role inside each action, so they can be neither forged nor scrubbed.
      </Text>
    </View>
  );
}

function OperatorsView({ operators }: { operators: PlatformOperator[] }) {
  return (
    <View>
      <Text style={styles.h1}>Operators</Text>
      {operators.map((op) => (
        <View key={op.userId} style={styles.auditRow}>
          <Text style={styles.auditAction}>{op.role}</Text>
          <Text style={styles.auditShop}>{op.userId.slice(0, 8)}…</Text>
          <Text style={styles.auditReason}>{op.active ? 'active' : 'inactive'}{op.note ? ` · ${op.note}` : ''}</Text>
        </View>
      ))}
      <Text style={styles.privacyNote}>
        Read-only by design. There is no &quot;add operator&quot; button anywhere in this product — appointing one is a
        deliberate SQL statement, because a privilege-granting endpoint is what turns a single compromised operator
        into a permanent foothold. Everyone here must also hold a verified second factor; without it they can read
        nothing at all.
      </Text>
    </View>
  );
}

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <View style={styles.tile}>
      <Text style={styles.tileLabel}>{label}</Text>
      <Text style={styles.tileValue}>{value}</Text>
      {sub ? <Text style={styles.tileSub}>{sub}</Text> : null}
    </View>
  );
}

function Btn({ label, onPress, disabled, danger }: { label: string; onPress: () => void; disabled?: boolean; danger?: boolean }) {
  return (
    <Pressable onPress={onPress} disabled={disabled} style={[styles.btn, danger && styles.btnDanger, disabled && styles.btnDisabled]}>
      <Text style={[styles.btnText, danger && styles.btnTextDanger, disabled && styles.btnTextDisabled]}>{label}</Text>
    </Pressable>
  );
}

// "2 Aug 2026" rather than 2026-08-04: an operator scanning a column reads a
// month name faster than a numeric one, and it removes the day/month ambiguity
// entirely.
function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

// Flags a date inside a week so a trial about to lapse stands out in the column
// rather than having to be worked out.
function endsSoon(iso: string | null): boolean {
  if (!iso) return false;
  const ms = new Date(iso).getTime() - Date.now();
  return ms > 0 && ms <= 7 * 86_400_000;
}

const TAB_LABELS: Record<Tab, string> = { overview: 'Overview', shops: 'Shops', requests: 'Requests', plans: 'Plans', audit: 'Audit log', operators: 'Operators' };
const STATUS_DOT: Record<SubscriptionStatus, string> = { trialing: '●', active: '●', grace: '◐', expired: '○', suspended: '✕' };
const STATUS_COLOR: Record<SubscriptionStatus, object> = {
  trialing: { color: '#1B4FA8' },
  active: { color: '#1E7A3C' },
  grace: { color: '#9A6412' },
  expired: { color: '#999999' },
  suspended: { color: '#B03535' },
};

const styles = StyleSheet.create({
  root: { flex: 1, flexDirection: 'row', backgroundColor: '#FFFFFF' },
  rootCompact: { flexDirection: 'column' },
  topBar: { borderBottomWidth: 1, borderBottomColor: '#EEEEEE', paddingTop: 12, paddingHorizontal: 14, gap: 8 },
  brandCompact: { fontSize: 12, fontWeight: '800', color: '#111111', letterSpacing: 1.5 },
  topNav: { flexDirection: 'row', gap: 4, paddingBottom: 8 },
  card: { borderWidth: 1, borderColor: '#EEEEEE', borderRadius: 10, padding: 14, marginBottom: 8, gap: 6 },
  cardName: { fontSize: 15, fontWeight: '800', color: '#111111' },
  cardMeta: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  cardPlan: { fontSize: 12, color: '#777777', fontWeight: '700' },
  cardUsage: { fontSize: 12, color: '#777777' },
  cardDates: { fontSize: 11.5, color: '#999999' },
  sidebar: { width: 200, borderRightWidth: 1, borderRightColor: '#EEEEEE', padding: 20 },
  brand: { fontSize: 15, fontWeight: '800', color: '#111111', letterSpacing: 1 },
  brandSub: { fontSize: 10, fontWeight: '800', color: '#999999', letterSpacing: 2, marginBottom: 20 },
  nav: { gap: 2 },
  navItem: { paddingVertical: 8, paddingHorizontal: 10, borderRadius: 8 },
  navItemActive: { backgroundColor: '#F5F5F5' },
  navText: { fontSize: 13, fontWeight: '700', color: '#777777' },
  navTextActive: { color: '#111111' },
  main: { flex: 1 },
  mainContent: { padding: 24, paddingBottom: 60 },
  mainContentCompact: { padding: 14, paddingBottom: 40 },
  h1: { fontSize: 20, fontWeight: '800', color: '#111111', marginBottom: 16 },
  tiles: { flexDirection: 'row', gap: 10, marginBottom: 18, flexWrap: 'wrap' },
  tile: { borderWidth: 1, borderColor: '#EEEEEE', borderRadius: 10, padding: 12, minWidth: 96, flexGrow: 1 },
  tileLabel: { fontSize: 10, fontWeight: '800', color: '#999999', letterSpacing: 0.5 },
  tileValue: { fontSize: 20, fontWeight: '800', color: '#111111', marginTop: 4 },
  tileSub: { fontSize: 10, color: '#AAAAAA', marginTop: 2 },
  search: { borderWidth: 1, borderColor: '#DDDDDD', borderRadius: 10, paddingHorizontal: 12, paddingVertical: 9, fontSize: 13, marginBottom: 14, color: '#111111' },
  tableHead: { flexDirection: 'row', paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: '#EEEEEE' },
  th: { fontSize: 10, fontWeight: '800', color: '#999999', letterSpacing: 0.5 },
  tr: { flexDirection: 'row', paddingVertical: 11, borderBottomWidth: 1, borderBottomColor: '#F5F5F5', alignItems: 'center' },
  trSelected: { backgroundColor: '#FAFAFA' },
  td: { fontSize: 13, color: '#111111' },
  tdAtLimit: { color: '#B03535', fontWeight: '800' },
  colShop: { flex: 2.4 },
  colPlan: { flex: 1.5 },
  colStatus: { flex: 1.5 },
  colDate: { flex: 1.6 },
  tdMuted: { color: '#888888' },
  colStores: { flex: 1 },
  colUsage: { flex: 1.5 },
  status: { fontSize: 12, fontWeight: '700' },
  statusNote: { fontSize: 10, color: '#AAAAAA', marginTop: 1 },
  detail: { marginTop: 22, borderWidth: 1, borderColor: '#EEEEEE', borderRadius: 12, padding: 20 },
  detailTitle: { fontSize: 17, fontWeight: '800', color: '#111111' },
  detailMeta: { fontSize: 12, color: '#888888', marginTop: 2 },
  detailSection: { fontSize: 10, fontWeight: '800', color: '#999999', letterSpacing: 0.5, marginTop: 18, marginBottom: 8 },
  usageRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 4 },
  usageLabel: { fontSize: 13, color: '#555555' },
  usageValue: { fontSize: 13, color: '#111111', fontWeight: '700' },
  modules: { fontSize: 12, color: '#555555', lineHeight: 18 },
  reasonInputNeeded: { borderColor: '#E4C58A', backgroundColor: '#FFFDF7' },
  hintNeeded: { color: '#9A6412', fontSize: 11.5, marginBottom: 8 },
  reasonInput: { borderWidth: 1, borderColor: '#DDDDDD', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8, fontSize: 12, marginBottom: 10, color: '#111111' },
  actionRow: { flexDirection: 'row', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 8 },
  inlineDays: { flexDirection: 'row', gap: 6, alignItems: 'center' },
  daysInput: { borderWidth: 1, borderColor: '#DDDDDD', borderRadius: 8, paddingHorizontal: 8, paddingVertical: 7, width: 52, fontSize: 12, textAlign: 'center', color: '#111111' },
  chip: { borderWidth: 1, borderColor: '#DDDDDD', borderRadius: 20, paddingHorizontal: 12, paddingVertical: 6 },
  chipActive: { backgroundColor: '#111111', borderColor: '#111111' },
  chipText: { fontSize: 12, fontWeight: '700', color: '#555555' },
  chipTextActive: { color: '#FFFFFF' },
  btn: { backgroundColor: '#111111', borderRadius: 8, paddingHorizontal: 14, paddingVertical: 9 },
  btnDanger: { backgroundColor: '#FDF2F2', borderWidth: 1, borderColor: '#F0C2C2' },
  btnDisabled: { backgroundColor: '#EEEEEE' },
  btnText: { color: '#FFFFFF', fontSize: 12, fontWeight: '800' },
  btnTextDanger: { color: '#B03535' },
  btnTextDisabled: { color: '#AAAAAA' },
  warn: { color: '#9A6412', fontSize: 12, lineHeight: 18, marginVertical: 8 },
  error: { color: '#C0392B', fontSize: 12, fontWeight: '700', marginTop: 6 },
  privacyNote: { color: '#AAAAAA', fontSize: 11, lineHeight: 17, marginTop: 18 },
  planCard: { borderWidth: 1, borderColor: '#EEEEEE', borderRadius: 10, padding: 16, marginBottom: 10 },
  planCardEditing: { borderColor: '#111111' },
  planNameInput: { fontSize: 15, fontWeight: '800', color: '#111111', borderBottomWidth: 1, borderBottomColor: '#DDDDDD', paddingVertical: 2, minWidth: 160 },
  limitField: { gap: 4 },
  convertRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 6 },
  checkbox: { width: 17, height: 17, borderRadius: 4, borderWidth: 1.5, borderColor: '#BBBBBB', alignItems: 'center', justifyContent: 'center' },
  checkboxOn: { backgroundColor: '#111111', borderColor: '#111111' },
  checkboxTick: { color: '#FFFFFF', fontSize: 11, fontWeight: '800' },
  convertLabel: { fontSize: 12.5, color: '#111111', fontWeight: '700' },
  detailSectionDanger: { fontSize: 10, fontWeight: '800', color: '#B03535', letterSpacing: 0.5, marginTop: 24, marginBottom: 8 },
  dangerToggle: { alignSelf: 'flex-start', marginTop: 22, paddingVertical: 6 },
  dangerToggleText: { color: '#B03535', fontSize: 12, fontWeight: '800' },
  dangerBox: { marginTop: 22, borderWidth: 1, borderColor: '#F0C2C2', backgroundColor: '#FDF7F7', borderRadius: 10, padding: 16, gap: 10 },
  dangerTitle: { color: '#B03535', fontSize: 14, fontWeight: '800' },
  dangerBody: { color: '#7A4A4A', fontSize: 12.5, lineHeight: 19 },
  dangerStrong: { fontWeight: '800' },
  dangerInput: { borderWidth: 1, borderColor: '#E8BEBE', backgroundColor: '#FFFFFF', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8, fontSize: 12, color: '#111111' },
  dangerCancel: { color: '#7A4A4A', fontSize: 12, fontWeight: '700', paddingHorizontal: 8 },
  sheetBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.35)', justifyContent: 'flex-end' },
  dialogBackdrop: { justifyContent: 'center', alignItems: 'center', padding: 24 },
  dialog: { backgroundColor: '#FFFFFF', borderRadius: 16, width: '100%', maxWidth: 760, maxHeight: '88%', overflow: 'hidden' },
  dialogHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingTop: 16, paddingBottom: 4, gap: 12 },
  dialogTitle: { fontSize: 17, fontWeight: '800', color: '#111111', flex: 1 },
  dialogClose: { fontSize: 16, color: '#999999', fontWeight: '700' },
  sheetDismiss: { flex: 1 },
  sheet: { backgroundColor: '#FFFFFF', borderTopLeftRadius: 18, borderTopRightRadius: 18, maxHeight: '88%', paddingTop: 8 },
  sheetGrabber: { alignSelf: 'center', width: 38, height: 4, borderRadius: 2, backgroundColor: '#DDDDDD', marginBottom: 4 },
  sheetContent: { padding: 16, paddingBottom: 28 },
  sheetClose: { alignSelf: 'center', paddingVertical: 12, paddingHorizontal: 20, marginTop: 4 },
  sheetCloseText: { color: '#777777', fontSize: 12, fontWeight: '800' },
  payInput: { borderWidth: 1, borderColor: '#DDDDDD', borderRadius: 8, paddingHorizontal: 8, paddingVertical: 7, width: 108, fontSize: 12, color: '#111111' },
  requestCard: { borderWidth: 1, borderColor: '#EEEEEE', borderRadius: 10, padding: 16, marginBottom: 10 },
  requestHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 },
  requestShop: { fontSize: 15, fontWeight: '800', color: '#111111' },
  requestMove: { fontSize: 13, color: '#777777' },
  requestTarget: { color: '#111111', fontWeight: '800' },
  planHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  planName: { fontSize: 15, fontWeight: '800', color: '#111111' },
  planPrice: { fontSize: 13, fontWeight: '800', color: '#111111' },
  planMeta: { fontSize: 11, color: '#888888', marginTop: 4 },
  planModules: { fontSize: 11, color: '#555555', marginTop: 6, lineHeight: 16 },
  auditRow: { flexDirection: 'row', gap: 12, paddingVertical: 9, borderBottomWidth: 1, borderBottomColor: '#F5F5F5', alignItems: 'center' },
  auditWhen: { fontSize: 11, color: '#999999', width: 116 },
  auditAction: { fontSize: 12, fontWeight: '800', color: '#111111', width: 140 },
  auditShop: { fontSize: 12, color: '#555555', width: 160 },
  auditReason: { fontSize: 12, color: '#888888', flex: 1 },
  empty: { fontSize: 13, color: '#999999' },
});
