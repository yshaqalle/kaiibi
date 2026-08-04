import { Linking, Pressable, StyleSheet, Text, View } from 'react-native';

import { formatCents } from '@/lib/currency';
import { LIMIT_RESOURCES, type LimitResource } from '@/lib/entitlements';
import { whatsappLink, type PlatformAuditRow, type PlatformShopRow, type SubscriptionPaymentRow } from '@/lib/platform';
import type { Plan } from '@/lib/subscriptions';

// The operator's first screen: is the business growing, is money arriving, and
// who needs a conversation today.
//
// Every number here is OURS -- subscription revenue, signups, plan movement,
// and how heavily shops use what they pay for. None of it is any shop's
// takings: the portal cannot read sales, products, customers or expenses, and
// that boundary is the point rather than an omission.

const DAY = 86_400_000;

export function PlatformOverview({
  shops,
  plans,
  payments,
  audit,
  compact,
  now,
  onOpenShop,
}: {
  shops: PlatformShopRow[];
  plans: Plan[];
  payments: SubscriptionPaymentRow[];
  audit: PlatformAuditRow[];
  compact: boolean;
  // Stamped by the caller when this data was fetched, rather than read here.
  // Reading the clock during render is impure, and it also means every figure
  // on the screen is measured against the same instant instead of drifting
  // apart as the component re-renders.
  now: number;
  onOpenShop: (shopId: string) => void;
}) {
  const priceOf = (key: string) => plans.find((p) => p.key === key)?.priceCents ?? 0;

  // Only shops actually paying right now. Trials and lapsed shops are excluded
  // deliberately -- counting them is how a dashboard tells you the business is
  // doing better than it is.
  const paying = shops.filter((s) => s.status === 'active');
  const mrr = paying.reduce((sum, s) => sum + priceOf(s.planKey), 0);
  const arpu = paying.length > 0 ? Math.round(mrr / paying.length) : 0;

  const monthStart = new Date(now);
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);
  const collectedThisMonth = payments
    .filter((p) => new Date(p.paidAt).getTime() >= monthStart.getTime())
    .reduce((sum, p) => sum + p.amountCents, 0);

  // Movement. Signups come from the shops themselves; upgrades, downgrades and
  // suspensions come from the audit log, which is the only place a *change* is
  // recorded rather than just a current state.
  const since = (days: number) => now - days * DAY;
  const newIn = (days: number) => shops.filter((s) => new Date(s.createdAt).getTime() >= since(days)).length;
  const planMoves = audit.filter((a) => a.action === 'set_plan' || a.action === 'approve_plan_change');
  const movesIn30 = planMoves.filter((a) => new Date(a.createdAt).getTime() >= since(30));
  const direction = (row: PlatformAuditRow) => {
    const before = priceOf((row.before as any)?.plan_key ?? '');
    const after = priceOf((row.after as any)?.plan_key ?? '');
    return after > before ? 'up' : after < before ? 'down' : 'flat';
  };
  const upgrades = movesIn30.filter((a) => direction(a) === 'up').length;
  const downgrades = movesIn30.filter((a) => direction(a) === 'down').length;

  const trialing = shops.filter((s) => s.status === 'trialing');
  const expired = shops.filter((s) => s.status === 'expired');
  const suspended = shops.filter((s) => s.status === 'suspended');

  // Conversion: of the shops whose trial has already ended, how many are paying.
  // Shops still trialing are excluded -- they haven't had the chance to decide,
  // and including them would flatter the number early on.
  const decided = shops.filter((s) => s.status !== 'trialing');
  const conversion = decided.length > 0 ? Math.round((paying.length / decided.length) * 100) : 0;

  // Platform-wide usage: how much work the product is actually doing.
  const totalUsage = (resource: LimitResource) => shops.reduce((sum, s) => sum + (s.usage[resource] ?? 0), 0);

  // Shops pressed against a cap. The clearest upsell signal there is, because
  // it is a customer telling us what they need by bumping into it.
  const atCap = shops.filter((s) =>
    LIMIT_RESOURCES.some((r) => {
      const limit = s.limits[r.key];
      return limit != null && (s.usage[r.key] ?? 0) >= limit;
    })
  );

  const endingSoon = trialing
    .filter((s) => s.trialEndsAt && new Date(s.trialEndsAt).getTime() - now <= 7 * DAY)
    .sort((a, b) => (a.trialEndsAt ?? '').localeCompare(b.trialEndsAt ?? ''));

  const headline =
    paying.length === 0
      ? `No paying shops yet. ${trialing.length} on trial${endingSoon.length > 0 ? `, ${endingSoon.length} deciding within a week` : ''}.`
      : `${formatCents(mrr)} a month from ${paying.length} paying shop${paying.length === 1 ? '' : 's'}${
          endingSoon.length > 0 ? ` · ${endingSoon.length} trial${endingSoon.length === 1 ? '' : 's'} ending within a week` : ''
        }.`;

  return (
    <View style={styles.root}>
      <View style={styles.hero}>
        <Text style={styles.heroLabel}>OVERVIEW</Text>
        <Text style={[styles.heroLine, compact && styles.heroLineCompact]}>{headline}</Text>
      </View>

      <Text style={styles.section}>MONEY</Text>
      <View style={styles.tiles}>
        <Tile value={formatCents(mrr)} label="MRR" sub="paying shops only" />
        <Tile value={formatCents(collectedThisMonth)} label="Collected this month" sub={`${payments.filter((p) => new Date(p.paidAt) >= monthStart).length} payments`} />
        <Tile value={formatCents(arpu)} label="Average per shop" />
        <Tile value={`${conversion}%`} label="Trial → paid" sub={`of ${decided.length} decided`} tone={conversion === 0 && decided.length > 0 ? 'warn' : 'default'} />
      </View>

      <Text style={styles.section}>MOVEMENT</Text>
      <View style={styles.tiles}>
        <Tile value={`+${newIn(7)}`} label="New this week" sub={`+${newIn(30)} in 30 days`} />
        <Tile value={String(trialing.length)} label="On trial" />
        <Tile value={`↑${upgrades}  ↓${downgrades}`} label="Plan changes" sub="last 30 days" tone={downgrades > upgrades ? 'warn' : 'default'} />
        <Tile value={String(expired.length + suspended.length)} label="Lapsed or suspended" tone={expired.length + suspended.length > 0 ? 'warn' : 'default'} />
      </View>

      <Text style={styles.section}>PLAN MIX</Text>
      <View style={styles.mix}>
        {plans.map((plan) => {
          const on = shops.filter((s) => s.planKey === plan.key).length;
          const share = shops.length > 0 ? (on / shops.length) * 100 : 0;
          return (
            <View key={plan.id} style={styles.mixRow}>
              <Text style={styles.mixName}>{plan.name}</Text>
              <View style={styles.mixTrack}>
                <View style={[styles.mixFill, { width: `${share}%` }]} />
              </View>
              <Text style={styles.mixCount}>{on}</Text>
              <Text style={styles.mixRevenue}>{plan.priceCents > 0 ? formatCents(on * plan.priceCents) : '—'}</Text>
            </View>
          );
        })}
      </View>

      <Text style={styles.section}>USAGE ACROSS ALL SHOPS</Text>
      <View style={styles.tiles}>
        {LIMIT_RESOURCES.map((r) => (
          <Tile key={r.key} value={totalUsage(r.key).toLocaleString()} label={r.label} />
        ))}
      </View>

      <Text style={styles.section}>NEEDS ATTENTION</Text>
      {endingSoon.length === 0 && atCap.length === 0 && expired.length === 0 ? (
        <Text style={styles.empty}>Nothing pressing.</Text>
      ) : (
        <View style={styles.attention}>
          {endingSoon.map((shop) => (
            <AttentionRow
              key={`t-${shop.shopId}`}
              shop={shop}
              note={`Trial ends in ${Math.max(0, Math.ceil((new Date(shop.trialEndsAt!).getTime() - now) / DAY))} days`}
              message={`Hi ${shop.shopName} — your Kaiibi trial ends soon. Would you like to keep going?`}
              onOpen={onOpenShop}
            />
          ))}
          {atCap.map((shop) => {
            const hit = LIMIT_RESOURCES.filter((r) => {
              const limit = shop.limits[r.key];
              return limit != null && (shop.usage[r.key] ?? 0) >= limit;
            });
            return (
              <AttentionRow
                key={`c-${shop.shopId}`}
                shop={shop}
                note={`At their limit: ${hit.map((h) => h.label.toLowerCase()).join(', ')}`}
                message={`Hi ${shop.shopName} — you've reached your plan's limit on Kaiibi. Want to move up a tier?`}
                onOpen={onOpenShop}
              />
            );
          })}
          {expired.map((shop) => (
            <AttentionRow
              key={`e-${shop.shopId}`}
              shop={shop}
              note="Plan lapsed — can view but not change anything"
              message={`Hi ${shop.shopName} — your Kaiibi plan has lapsed. Everything is still saved; shall we get you running again?`}
              onOpen={onOpenShop}
            />
          ))}
        </View>
      )}
    </View>
  );
}

function AttentionRow({
  shop,
  note,
  message,
  onOpen,
}: {
  shop: PlatformShopRow;
  note: string;
  message: string;
  onOpen: (shopId: string) => void;
}) {
  const link = whatsappLink(shop.contactPhone, message);
  return (
    <View style={styles.attentionRow}>
      <Pressable style={styles.attentionMain} onPress={() => onOpen(shop.shopId)}>
        <Text style={styles.attentionName} numberOfLines={1}>{shop.shopName}</Text>
        <Text style={styles.attentionNote} numberOfLines={2}>{note}</Text>
      </Pressable>
      {/* Opens WhatsApp with the shop's own number and a first line already
          written. The number is the one they print on their receipts, read from
          their primary store -- no new access, and no copying digits by hand. */}
      {link ? (
        <Pressable onPress={() => Linking.openURL(link)} style={styles.waButton}>
          <Text style={styles.waText}>WhatsApp</Text>
        </Pressable>
      ) : (
        <Text style={styles.waMissing}>no phone</Text>
      )}
    </View>
  );
}

function Tile({ value, label, sub, tone = 'default' }: { value: string; label: string; sub?: string; tone?: 'default' | 'warn' }) {
  return (
    <View style={[styles.tile, tone === 'warn' && styles.tileWarn]}>
      <Text style={[styles.tileValue, tone === 'warn' && styles.tileValueWarn]}>{value}</Text>
      <Text style={styles.tileLabel}>{label}</Text>
      {sub ? <Text style={styles.tileSub}>{sub}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { gap: 4 },
  hero: { marginBottom: 20 },
  heroLabel: { fontSize: 10, fontWeight: '800', color: '#999999', letterSpacing: 1 },
  heroLine: { fontSize: 24, fontWeight: '800', color: '#111111', lineHeight: 32, marginTop: 6, maxWidth: 720 },
  heroLineCompact: { fontSize: 18, lineHeight: 25 },
  section: { fontSize: 10, fontWeight: '800', color: '#999999', letterSpacing: 0.8, marginTop: 22, marginBottom: 10 },
  tiles: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  tile: { borderWidth: 1, borderColor: '#EEEEEE', borderRadius: 12, padding: 14, minWidth: 132, flexGrow: 1, backgroundColor: '#FBFBFB' },
  tileWarn: { borderColor: '#F2D8A8', backgroundColor: '#FFFCF5' },
  tileValue: { fontSize: 22, fontWeight: '800', color: '#111111' },
  tileValueWarn: { color: '#9A6412' },
  tileLabel: { fontSize: 12, color: '#555555', marginTop: 4, fontWeight: '600' },
  tileSub: { fontSize: 10.5, color: '#AAAAAA', marginTop: 2 },
  mix: { gap: 8 },
  mixRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  mixName: { fontSize: 13, fontWeight: '700', color: '#111111', width: 92 },
  mixTrack: { flex: 1, height: 8, borderRadius: 4, backgroundColor: '#F0F0F0', overflow: 'hidden' },
  mixFill: { height: 8, borderRadius: 4, backgroundColor: '#111111' },
  mixCount: { fontSize: 13, fontWeight: '800', color: '#111111', width: 34, textAlign: 'right' },
  mixRevenue: { fontSize: 12, color: '#777777', width: 76, textAlign: 'right' },
  attention: { gap: 8 },
  attentionRow: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    borderWidth: 1, borderColor: '#EEEEEE', borderRadius: 10, padding: 13,
  },
  attentionMain: { flex: 1, gap: 3 },
  attentionName: { fontSize: 14, fontWeight: '800', color: '#111111' },
  attentionNote: { fontSize: 12, color: '#777777', lineHeight: 17 },
  waButton: { backgroundColor: '#1E7A3C', borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8 },
  waText: { color: '#FFFFFF', fontSize: 11.5, fontWeight: '800' },
  waMissing: { color: '#BBBBBB', fontSize: 11 },
  empty: { fontSize: 13, color: '#999999' },
});
