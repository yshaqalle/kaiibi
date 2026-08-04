import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { formatCents } from '@/lib/currency';
import { LIMIT_RESOURCES, MODULES, type SubscriptionStatus } from '@/lib/entitlements';
import {
  callPlatformAdmin,
  listAuditLog,
  listOperators,
  listPlatformShops,
  type PlatformAuditRow,
  type PlatformOperator,
  type PlatformShopRow,
} from '@/lib/platform';
import { listPlans, type Plan } from '@/lib/subscriptions';

type Tab = 'shops' | 'plans' | 'audit' | 'operators';

export default function PlatformHome() {
  const [tab, setTab] = useState<Tab>('shops');
  const [shops, setShops] = useState<PlatformShopRow[]>([]);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [audit, setAudit] = useState<PlatformAuditRow[]>([]);
  const [operators, setOperators] = useState<PlatformOperator[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);

  // Does not re-arm `loading`: the initial value covers the first load, and a
  // refresh after an action should update the table in place rather than
  // replacing the operator's screen with a spinner and losing their scroll
  // position mid-task.
  const reload = useCallback(async () => {
    const [shopRows, planRows, auditRows, operatorRows] = await Promise.all([
      listPlatformShops(),
      listPlans(),
      listAuditLog(),
      listOperators(),
    ]);
    setShops(shopRows);
    setPlans(planRows);
    setAudit(auditRows);
    setOperators(operatorRows);
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

  return (
    <View style={styles.root}>
      <View style={styles.sidebar}>
        <Text style={styles.brand}>KAIIBI</Text>
        <Text style={styles.brandSub}>PLATFORM</Text>
        <View style={styles.nav}>
          {(['shops', 'plans', 'audit', 'operators'] as Tab[]).map((t) => (
            <Pressable key={t} onPress={() => setTab(t)} style={[styles.navItem, tab === t && styles.navItemActive]}>
              <Text style={[styles.navText, tab === t && styles.navTextActive]}>{TAB_LABELS[t]}</Text>
            </Pressable>
          ))}
        </View>
      </View>

      <ScrollView style={styles.main} contentContainerStyle={styles.mainContent}>
        {loading ? (
          <ActivityIndicator style={{ marginTop: 40 }} />
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

            <View style={styles.tableHead}>
              <Text style={[styles.th, styles.colShop]}>SHOP</Text>
              <Text style={[styles.th, styles.colPlan]}>PLAN</Text>
              <Text style={[styles.th, styles.colStatus]}>STATUS</Text>
              <Text style={[styles.th, styles.colStores]}>STORES</Text>
              <Text style={[styles.th, styles.colUsage]}>PRODUCTS</Text>
            </View>
            {filtered.map((shop) => {
              const storeLimit = shop.limits.locations ?? null;
              const stores = shop.usage.locations ?? 0;
              const products = shop.usage.products ?? 0;
              const productLimit = shop.limits.products ?? null;
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
                  </View>
                  <Text style={[styles.td, styles.colStores, storeLimit != null && stores >= storeLimit && styles.tdAtLimit]}>
                    {stores}{storeLimit != null ? ` / ${storeLimit}` : ''}
                  </Text>
                  <Text style={[styles.td, styles.colUsage, productLimit != null && products >= productLimit && styles.tdAtLimit]}>
                    {products.toLocaleString()}{productLimit != null ? ` / ${productLimit.toLocaleString()}` : ' / ∞'}
                  </Text>
                </Pressable>
              );
            })}

            {selectedShop && <ShopDetail shop={selectedShop} plans={plans} onDone={reload} />}
          </>
        ) : tab === 'plans' ? (
          <PlansView plans={plans} shops={shops} />
        ) : tab === 'audit' ? (
          <AuditView rows={audit} shops={shops} />
        ) : (
          <OperatorsView operators={operators} />
        )}
      </ScrollView>
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
      <Text style={styles.detailTitle}>{shop.shopName}</Text>
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
        style={styles.reasonInput}
      />

      <View style={styles.actionRow}>
        {plans.map((p) => (
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

      <View style={styles.actionRow}>
        <Btn label="Change plan" disabled={busy || planKey === shop.planKey} onPress={() => run('set_plan', { planKey })} />
        <View style={styles.inlineDays}>
          <TextInput value={days} onChangeText={setDays} keyboardType="number-pad" style={styles.daysInput} />
          <Btn label="Extend trial" disabled={busy} onPress={() => run('extend_trial', { days: Number(days) || 0 })} />
        </View>
        {shop.manualStatus === 'suspended' ? (
          <Btn label="Unsuspend" disabled={busy} onPress={() => run('unsuspend', {})} />
        ) : (
          <Btn label="Suspend" danger disabled={busy} onPress={() => run('suspend', {})} />
        )}
      </View>

      {error && <Text style={styles.error}>{error}</Text>}
      <Text style={styles.privacyNote}>
        This portal cannot open this shop&apos;s products, sales, books, or schedule.
      </Text>
    </View>
  );
}

function PlansView({ plans, shops }: { plans: Plan[]; shops: PlatformShopRow[] }) {
  return (
    <View>
      <Text style={styles.h1}>Plans</Text>
      {plans.map((plan) => {
        const on = shops.filter((s) => s.planKey === plan.key).length;
        return (
          <View key={plan.id} style={styles.planCard}>
            <View style={styles.planHead}>
              <Text style={styles.planName}>{plan.name}</Text>
              <Text style={styles.planPrice}>
                {plan.priceCents === 0 ? 'Free' : `${formatCents(plan.priceCents)}/${plan.billingInterval ?? 'month'}`}
              </Text>
            </View>
            <Text style={styles.planMeta}>{on} shop{on === 1 ? '' : 's'} on this plan</Text>
            <Text style={styles.planModules}>{plan.modules.join(' · ')}</Text>
            <Text style={styles.planMeta}>
              {LIMIT_RESOURCES.map((r) => `${r.label}: ${plan.limits[r.key] ?? '∞'}`).join('  ·  ')}
            </Text>
            {on > 0 && (
              <Text style={styles.warn}>
                ⚠ Editing this plan changes what {on} shop{on === 1 ? '' : 's'} can do, immediately.
              </Text>
            )}
          </View>
        );
      })}
      <Text style={styles.privacyNote}>
        Plans are edited through the platform-admin function, which records every change. Editing from this screen is
        not built yet — change them in SQL and the audit log will show it.
      </Text>
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

const TAB_LABELS: Record<Tab, string> = { shops: 'Shops', plans: 'Plans', audit: 'Audit log', operators: 'Operators' };
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
  h1: { fontSize: 20, fontWeight: '800', color: '#111111', marginBottom: 16 },
  tiles: { flexDirection: 'row', gap: 10, marginBottom: 18, flexWrap: 'wrap' },
  tile: { borderWidth: 1, borderColor: '#EEEEEE', borderRadius: 10, padding: 14, minWidth: 120 },
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
  colShop: { flex: 3 },
  colPlan: { flex: 1.5 },
  colStatus: { flex: 1.5 },
  colStores: { flex: 1 },
  colUsage: { flex: 1.5 },
  status: { fontSize: 12, fontWeight: '700' },
  detail: { marginTop: 22, borderWidth: 1, borderColor: '#EEEEEE', borderRadius: 12, padding: 20 },
  detailTitle: { fontSize: 17, fontWeight: '800', color: '#111111' },
  detailMeta: { fontSize: 12, color: '#888888', marginTop: 2 },
  detailSection: { fontSize: 10, fontWeight: '800', color: '#999999', letterSpacing: 0.5, marginTop: 18, marginBottom: 8 },
  usageRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 4 },
  usageLabel: { fontSize: 13, color: '#555555' },
  usageValue: { fontSize: 13, color: '#111111', fontWeight: '700' },
  modules: { fontSize: 12, color: '#555555', lineHeight: 18 },
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
