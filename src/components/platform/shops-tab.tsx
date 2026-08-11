import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { BentoCard } from '@/components/ui/bento-card';
import { BentoTile, BentoTileRow } from '@/components/ui/bento-tile';
import { BentoCell, BentoGrid } from '@/components/ui/bento';
import { DataTable, NameCell, ValueCell, type Column } from '@/components/ui/data-table';
import { SubscriptionStatusPill } from '@/components/ui/subscription-status';
import { coverEnd, fmtDate } from '@/components/platform/labels';
import { Field } from '@/components/platform/kit';
import { Colors } from '@/constants/theme';
import { formatCents } from '@/lib/currency';
import type { SubscriptionStatus } from '@/lib/entitlements';
import type { PlatformShopRow } from '@/lib/platform';
import type { Plan } from '@/lib/subscriptions';

// Pinned to the light palette for now — no dark-mode switching yet.
const theme = Colors.light;

// Every business on Kaiibi. A roster you read DOWN, so the table is out of the
// grid entirely and takes the full width; only the stat strip above it is
// glanced at.

// 'retiring' is not a subscription status — it is a plan-lifecycle fact — but
// it belongs in the same control because it answers the same question the
// operator is asking: which stores need me to do something?
type StatusFilter = 'all' | 'retiring' | SubscriptionStatus;

const FILTERS: { key: StatusFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'active', label: 'Paying' },
  { key: 'trialing', label: 'Trialing' },
  { key: 'grace', label: 'Grace' },
  { key: 'expired', label: 'Expired' },
  { key: 'suspended', label: 'Suspended' },
  { key: 'retiring', label: 'Retiring plan' },
];

export function ShopsTab({
  shops,
  plans,
  compact,
  selected,
  onSelect,
}: {
  shops: PlatformShopRow[];
  plans: Plan[];
  compact: boolean;
  selected: string | null;
  onSelect: (shopId: string | null) => void;
}) {
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<StatusFilter>('all');

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return shops.filter((shop) => {
      if (status === 'retiring') {
        if (!shop.retiringTo) return false;
      } else if (status !== 'all' && shop.status !== status) {
        return false;
      }
      if (!q) return true;
      return (
        shop.shopName.toLowerCase().includes(q) ||
        shop.planKey.includes(q) ||
        // A store still billed on a retired tier is displayed under its
        // successor (see the Store column below) -- without this, searching
        // the tier it is actually PAYING for finds nothing, while the MRR
        // tile above is pricing it off exactly that plan.
        shop.storedPlanKey.includes(q) ||
        shop.status.includes(q)
      );
    });
  }, [shops, search, status]);

  const counts = useMemo(() => {
    const by = (s: SubscriptionStatus) => shops.filter((shop) => shop.status === s).length;
    // Monthly recurring revenue: only shops actually paying right now. Trials
    // and lapsed shops are excluded on purpose — counting them is how a
    // dashboard tells you the business is doing better than it is. Priced off
    // storedPlanKey, not planKey's effective plan -- a store whose plan
    // retired keeps paying its stored price until it actually changes tier,
    // and the successor's price has not billed it yet.
    const mrr = shops
      .filter((s) => s.status === 'active')
      .reduce((sum, s) => sum + (plans.find((p) => p.key === s.storedPlanKey)?.priceCents ?? 0), 0);
    return {
      all: shops.length,
      trialing: by('trialing'),
      active: by('active'),
      grace: by('grace'),
      expired: by('expired'),
      suspended: by('suspended'),
      retiring: shops.filter((shop) => shop.retiringTo != null).length,
      mrr,
    };
  }, [shops, plans]);

  const columns: Column<PlatformShopRow>[] = [
    {
      key: 'shop',
      header: 'Store',
      render: (shop) => (
        // Two different divergences share this one line, in order:
        // - BEFORE `retire_at`: `retiringTo` names the successor while
        //   `planName` is still the current tier -- "current -> future".
        //   Once the date passes, `planName` has already resolved to the
        //   successor and `retiringTo` names that same plan, so drawing it
        //   would render "Starter -> Starter" forever -- `retire_at` is never
        //   cleared by time, only by an operator republishing.
        // - AFTER `retire_at`: `planName` (effective) has hopped to the
        //   successor but `storedPlanKey` -- what the store is still actually
        //   billed -- has not, so showing `planName` alone hides exactly the
        //   plan the MRR tile above is pricing this row off. "billed ->
        //   entitled" fills that gap the same way the pre-date arrow does.
        <NameCell
          title={shop.shopName}
          meta={
            shop.retiringTo && shop.retiringTo !== shop.planName
              ? `${shop.planName} → ${shop.retiringTo}`
              : shop.storedPlanKey !== shop.planKey
                ? `${shop.storedPlanName} → ${shop.planName}`
                : shop.planName
          }
        />
      ),
    },
    {
      key: 'status',
      header: 'Status',
      width: 168,
      render: (shop) => {
        const detail = statusDetail(shop);
        return (
          <View>
            <SubscriptionStatusPill status={shop.status} />
            {detail ? <Text style={[styles.statusNote, detail.paid && styles.statusNotePaid]}>{detail.label}</Text> : null}
          </View>
        );
      },
    },
    {
      key: 'joined',
      header: 'Joined',
      width: 118,
      render: (shop) => <ValueCell value={fmtDate(shop.createdAt)} tone="muted" />,
    },
    {
      key: 'ends',
      header: 'Ends',
      width: 168,
      render: (shop) => {
        const { ends, label } = coverEnd(shop);
        return <ValueCell value={ends ? `${label} ${fmtDate(ends)}` : '—'} tone={endsSoon(ends) ? 'warning' : 'muted'} />;
      },
    },
    {
      key: 'stores',
      header: 'Branches',
      numeric: true,
      width: 86,
      render: (shop) => {
        const limit = shop.limits.locations ?? null;
        const used = shop.usage.locations ?? 0;
        const atLimit = limit != null && used >= limit;
        return <ValueCell value={`${used}${limit != null ? ` / ${limit}` : ''}`} tone={atLimit ? 'danger' : 'default'} strong={atLimit} />;
      },
    },
    {
      key: 'products',
      header: 'Products',
      numeric: true,
      width: 118,
      render: (shop) => {
        const limit = shop.limits.products ?? null;
        const used = shop.usage.products ?? 0;
        const atLimit = limit != null && used >= limit;
        return (
          <ValueCell
            value={`${used.toLocaleString()} / ${limit == null ? '∞' : limit.toLocaleString()}`}
            tone={atLimit ? 'danger' : 'default'}
            strong={atLimit}
          />
        );
      },
    },
  ];

  return (
    <View>
      <BentoGrid>
        <BentoCell span={12}>
          <BentoCard>
            <BentoTileRow>
              <BentoTile label="MRR" value={formatCents(counts.mrr)} hint="paying stores only" />
              <BentoTile label="Paying" value={String(counts.active)} />
              <BentoTile label="On trial" value={String(counts.trialing)} />
              <BentoTile label="Grace" value={String(counts.grace)} tone={counts.grace > 0 ? 'warn' : 'default'} />
              <BentoTile label="Expired" value={String(counts.expired)} tone={counts.expired > 0 ? 'warn' : 'default'} />
              {/* Present even at zero. One tile per subscription status below
                  -- Paying, On trial, Grace, Expired, Suspended -- matching the
                  filter row's five status pills ('All' needs no tile of its
                  own). 'Retiring plan' is a sixth filter with none: it is a
                  plan-lifecycle fact, not a subscription status, so a store can
                  be both retiring and, say, Paying -- counting it here would
                  double-count rather than complete the strip. */}
              <BentoTile
                label="Suspended"
                value={String(counts.suspended)}
                tone={counts.suspended > 0 ? 'warn' : 'default'}
              />
            </BentoTileRow>
          </BentoCard>
        </BentoCell>
      </BentoGrid>

      <View style={styles.controls}>
        <Field
          value={search}
          onChangeText={setSearch}
          placeholder="Search store, plan, or status"
          // White, not the kit's `bentoSoft` default: this one sits on the grey
          // PAGE rather than inside a white card, and soft-on-page is two greys
          // 1% apart — the field disappeared entirely. It also matches the
          // filter pills beside it, which is what it is grouped with.
          style={styles.search}
        />
        <View style={styles.filters}>
          {FILTERS.map((filter) => {
            const n = counts[filter.key];
            const active = filter.key === status;
            return (
              <Pressable
                key={filter.key}
                onPress={() => setStatus(filter.key)}
                style={[styles.filter, active && styles.filterActive]}
              >
                <Text style={[styles.filterText, active && styles.filterTextActive]}>
                  {filter.label} · {n}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </View>

      {/* Narrow gets a card per shop rather than the table.
          `DataTable` scrolls sideways inside its card, which is the right
          answer for four columns and the wrong one for seven: it would put
          "when does this trial end" off the edge of the screen, which is the
          question the tab gets opened for. */}
      <BentoCard bodyStyle={compact ? undefined : styles.tableBody}>
        {compact ? (
          filtered.length === 0 ? (
            <Text style={styles.empty}>No stores match that.</Text>
          ) : (
            filtered.map((shop, i) => (
              <ShopCard key={shop.shopId} shop={shop} first={i === 0} onPress={() => onSelect(shop.shopId)} />
            ))
          )
        ) : (
          <DataTable
            columns={columns}
            rows={filtered}
            keyExtractor={(shop) => shop.shopId}
            onRowPress={(shop) => onSelect(shop.shopId === selected ? null : shop.shopId)}
            emptyLabel="No stores match that."
            minWidth={880}
          />
        )}
      </BentoCard>
    </View>
  );
}

// One shop, stacked. Squeezing seven columns onto a phone makes every one of
// them unreadable, which is worse than stacking.
function ShopCard({ shop, first, onPress }: { shop: PlatformShopRow; first: boolean; onPress: () => void }) {
  const storeLimit = shop.limits.locations ?? null;
  const stores = shop.usage.locations ?? 0;
  const products = shop.usage.products ?? 0;
  const productLimit = shop.limits.products ?? null;
  const overStores = storeLimit != null && stores >= storeLimit;
  const overProducts = productLimit != null && products >= productLimit;
  const { ends, label } = coverEnd(shop);

  return (
    <Pressable onPress={onPress} style={[styles.shopCard, first && styles.shopCardFirst]}>
      <View style={styles.shopHead}>
        <Text style={styles.shopName} numberOfLines={1}>
          {shop.shopName}
        </Text>
        <SubscriptionStatusPill status={shop.status} />
      </View>
      <Text style={styles.shopMeta}>
        {shop.planName} · joined {fmtDate(shop.createdAt)}
      </Text>
      {ends ? (
        <Text style={[styles.shopMeta, endsSoon(ends) && styles.shopMetaWarn]}>
          {label} {fmtDate(ends)}
        </Text>
      ) : null}
      <Text style={[styles.shopMeta, (overStores || overProducts) && styles.shopMetaOver]}>
        {stores}
        {storeLimit != null ? `/${storeLimit}` : ''} branches · {products.toLocaleString()}
        {productLimit != null ? `/${productLimit.toLocaleString()}` : ''} products
      </Text>
    </Pressable>
  );
}

// A shop can sit on a paid plan while still inside its free trial: the plan is
// what they GET, the status is how they are PAYING. Said out loud rather than
// leaving the two columns looking like they disagree.
function statusDetail(shop: PlatformShopRow): { label: string; paid: boolean } | null {
  if (shop.status !== 'trialing') return null;
  if (shop.currentPeriodEnd != null && new Date(shop.currentPeriodEnd) > new Date(shop.createdAt)) {
    return { label: `paid · starts ${fmtDate(shop.currentPeriodEnd)}`, paid: true };
  }
  if (shop.planKey !== 'trial') return { label: 'free until trial ends', paid: false };
  return null;
}

// Flags a date inside a week so a trial about to lapse stands out in the column
// rather than having to be worked out.
function endsSoon(iso: string | null): boolean {
  if (!iso) return false;
  const ms = new Date(iso).getTime() - Date.now();
  return ms > 0 && ms <= 7 * 86_400_000;
}

const styles = StyleSheet.create({
  controls: { gap: 10, marginBottom: 14 },
  search: { backgroundColor: theme.bentoSurface },
  filters: { flexDirection: 'row', flexWrap: 'wrap', gap: 7 },
  filter: {
    borderWidth: 1,
    borderColor: theme.bentoLine,
    backgroundColor: theme.bentoSurface,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  filterActive: { backgroundColor: theme.bentoInk, borderColor: theme.bentoInk },
  filterText: { fontSize: 11.5, fontWeight: '700', color: theme.bentoInk2 },
  filterTextActive: { color: theme.bentoSurface },

  // The table brings its own gutters, so the card gives up most of its 18.
  tableBody: { paddingHorizontal: 10 },

  statusNote: { fontSize: 10, color: theme.bentoMuted2, marginTop: 3 },
  statusNotePaid: { color: theme.bentoProfit, fontWeight: '700' },

  shopCard: { paddingVertical: 13, borderTopWidth: 1, borderTopColor: theme.bentoRule, gap: 3 },
  shopCardFirst: { borderTopWidth: 0, paddingTop: 0 },
  shopHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  shopName: { fontSize: 14, fontWeight: '800', color: theme.bentoInk, flexShrink: 1 },
  shopMeta: { fontSize: 11.5, color: theme.bentoMuted },
  shopMetaWarn: { color: theme.bentoWarn, fontWeight: '700' },
  shopMetaOver: { color: theme.bentoLoss, fontWeight: '700' },

  empty: { fontSize: 13, color: theme.bentoMuted },
});
