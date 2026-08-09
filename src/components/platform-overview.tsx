import { useEffect } from 'react';
import { Linking, Pressable, StyleSheet, Text, View } from 'react-native';

import { BarChart, CHART_COLORS, DonutChart, planColor, type Bar } from '@/components/platform-charts';
import { BentoCard } from '@/components/ui/bento-card';
import { BentoTile, BentoTileRow } from '@/components/ui/bento-tile';
import { BentoCell, BentoGrid } from '@/components/ui/bento';
import { Caveat } from '@/components/ui/caveat';
import { Colors } from '@/constants/theme';
import { formatCents } from '@/lib/currency';
import { limitLabel } from '@/components/platform/labels';
import { LIMIT_RESOURCES, type LimitResource } from '@/lib/entitlements';
import { whatsappLink, type PlatformAuditRow, type PlatformShopRow, type SubscriptionPaymentRow } from '@/lib/platform';
import type { Plan } from '@/lib/subscriptions';

// Pinned to the light palette for now — no dark-mode switching yet.
const theme = Colors.light;

// The operator's first screen: is the business growing, is money arriving, and
// who needs a conversation today.
//
// Every number here is OURS -- subscription revenue, signups, plan movement,
// and how heavily shops use what they pay for. None of it is any shop's
// takings: the portal cannot read sales, products, customers or expenses, and
// that boundary is the point rather than an omission.
//
// Laid out on the bento grid, because every panel above "Needs attention" is
// glanced at rather than read. The attention list drops out of the grid: it is
// a worklist you read down, and the one thing on the tab you act on.

const DAY = 86_400_000;

export function PlatformOverview({
  shops,
  plans,
  payments,
  audit,
  now,
  onHeadline,
  onOpenShop,
}: {
  shops: PlatformShopRow[];
  plans: Plan[];
  payments: SubscriptionPaymentRow[];
  audit: PlatformAuditRow[];
  // Stamped by the caller when this data was fetched, rather than read here.
  // Reading the clock during render is impure, and it also means every figure
  // on the screen is measured against the same instant instead of drifting
  // apart as the component re-renders.
  now: number;
  /**
   * The one-line summary, published up to the shell so it can sit in the
   * header's blurb slot beside the title -- the same shape accounting.tsx uses
   * for a tab's header actions. It is a sentence about the whole tab, so it
   * belongs with the title rather than in a card of its own.
   */
  onHeadline: (headline: string) => void;
  onOpenShop: (shopId: string) => void;
}) {
  const priceOf = (key: string) => plans.find((p) => p.key === key)?.priceCents ?? 0;

  // Only shops actually paying right now. Trials and lapsed shops are excluded
  // deliberately -- counting them is how a dashboard tells you the business is
  // doing better than it is.
  const billing = shops.filter((s) => s.status === 'active');

  // Paid, but still inside their free period: money has arrived and their
  // cover starts when the trial ends. They are customers, not prospects —
  // counting them as merely "on trial" under-reports a decision they have
  // already made and paid for.
  const committed = shops.filter(
    (s) => s.status === 'trialing' && s.currentPeriodEnd != null && new Date(s.currentPeriodEnd).getTime() > now
  );

  const paying = [...billing, ...committed];
  // MRR is what is billing NOW -- priced off storedPlanKey, what the
  // subscription row still points at, not planKey's effective plan. A store
  // whose plan retired keeps paying its stored price until it actually changes
  // tier; pricing this off the effective plan would bill it at the successor's
  // rate on the retirement date despite nothing having billed it yet.
  // Committed money is shown beside MRR rather than folded in, because a
  // figure that mixes "collecting today" with "collecting from November"
  // answers neither question.
  const mrr = billing.reduce((sum, s) => sum + priceOf(s.storedPlanKey), 0);
  const committedMrr = committed.reduce((sum, s) => sum + priceOf(s.storedPlanKey), 0);
  const arpu = paying.length > 0 ? Math.round((mrr + committedMrr) / paying.length) : 0;

  const monthStart = new Date(now);
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);
  const paymentsThisMonth = payments.filter((p) => new Date(p.paidAt).getTime() >= monthStart.getTime());
  const collectedThisMonth = paymentsThisMonth.reduce((sum, p) => sum + p.amountCents, 0);

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

  const trialing = shops.filter((s) => s.status === 'trialing' && !committed.includes(s));
  const expired = shops.filter((s) => s.status === 'expired');
  const suspended = shops.filter((s) => s.status === 'suspended');

  // Conversion: of the shops whose trial has already ended, how many are paying.
  // Shops still trialing are excluded -- they haven't had the chance to decide,
  // and including them would flatter the number early on.
  // A shop that has paid has decided, whether or not its trial has run out.
  const decided = shops.filter((s) => s.status !== 'trialing' || committed.includes(s));
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

  // `trialing` already excludes shops that have paid, so nobody gets chased
  // for a decision they have made.
  const endingSoon = trialing
    .filter((s) => s.trialEndsAt && new Date(s.trialEndsAt).getTime() - now <= 7 * DAY)
    .sort((a, b) => (a.trialEndsAt ?? '').localeCompare(b.trialEndsAt ?? ''));

  // Signups by week, oldest first. Weeks rather than days because at this
  // volume a daily chart is mostly empty columns.
  const signupBars: Bar[] = Array.from({ length: 8 }, (_, i) => {
    const weeksAgo = 7 - i;
    const start = now - (weeksAgo + 1) * 7 * DAY;
    const end = now - weeksAgo * 7 * DAY;
    const count = shops.filter((shop) => {
      const t = new Date(shop.createdAt).getTime();
      return t >= start && t < end;
    }).length;
    return { label: weeksAgo === 0 ? 'now' : `-${weeksAgo}w`, value: count };
  });

  // Money collected by calendar month, oldest first.
  const revenueBars: Bar[] = Array.from({ length: 6 }, (_, i) => {
    const monthsAgo = 5 - i;
    const d = new Date(now);
    d.setDate(1);
    d.setMonth(d.getMonth() - monthsAgo);
    const start = new Date(d);
    const next = new Date(d);
    next.setMonth(next.getMonth() + 1);
    const cents = payments
      .filter((p) => {
        const t = new Date(p.paidAt).getTime();
        return t >= start.getTime() && t < next.getTime();
      })
      .reduce((sum, p) => sum + p.amountCents, 0);
    return { label: start.toLocaleDateString('en-GB', { month: 'short' }), value: cents };
  });

  const planSlices = plans.map((plan, i) => ({
    key: plan.key,
    label: plan.name,
    value: shops.filter((s) => s.planKey === plan.key).length,
    color: planColor(plan.key, i),
  }));

  const headline =
    paying.length === 0
      ? `No paying stores yet. ${trialing.length} on trial${endingSoon.length > 0 ? `, ${endingSoon.length} deciding within a week` : ''}.`
      : `${formatCents(mrr + committedMrr)} a month from ${paying.length} paying store${paying.length === 1 ? '' : 's'}${
          committed.length > 0 ? ` (${formatCents(committedMrr)} of it starting after trials end)` : ''
        }${
          endingSoon.length > 0 ? ` · ${endingSoon.length} trial${endingSoon.length === 1 ? '' : 's'} ending within a week` : ''
        }.`;

  // In an effect rather than during render: publishing it inline would set
  // state on the parent mid-render, which React treats as a bug in dev and
  // which would loop here because the headline is recomputed every pass.
  useEffect(() => {
    onHeadline(headline);
  }, [headline, onHeadline]);

  // The instant every figure on this tab is measured against, said once on the
  // card that holds the money rather than left for the reader to assume.
  const asOf = new Date(now).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

  const attention = [
    ...endingSoon.map((shop) => ({
      key: `t-${shop.shopId}`,
      shop,
      note: `Trial ends in ${Math.max(0, Math.ceil((new Date(shop.trialEndsAt!).getTime() - now) / DAY))} days`,
      message: `Hi ${shop.shopName} — your Kaiibi trial ends soon. Would you like to keep going?`,
    })),
    ...atCap.map((shop) => {
      const hit = LIMIT_RESOURCES.filter((r) => {
        const limit = shop.limits[r.key];
        return limit != null && (shop.usage[r.key] ?? 0) >= limit;
      });
      return {
        key: `c-${shop.shopId}`,
        shop,
        note: `At their limit: ${hit.map((h) => h.label.toLowerCase()).join(', ')}`,
        message: `Hi ${shop.shopName} — you've reached your plan's limit on Kaiibi. Want to move up a tier?`,
      };
    }),
    ...expired.map((shop) => ({
      key: `e-${shop.shopId}`,
      shop,
      note: 'Plan lapsed — can view but not change anything',
      message: `Hi ${shop.shopName} — your Kaiibi plan has lapsed. Everything is still saved; shall we get you running again?`,
    })),
  ];

  return (
    <View>
      <BentoGrid>
        <BentoCell span={12}>
          <BentoCard title="Money" scope={`as of ${asOf}`}>
            <BentoTileRow>
              <BentoTile label="MRR" value={formatCents(mrr)} hint="billing right now" />
              {committedMrr > 0 ? (
                <BentoTile
                  label="Committed"
                  value={formatCents(committedMrr)}
                  hint={`${committed.length} paid, starts after trial`}
                />
              ) : null}
              <BentoTile
                label="Collected this month"
                value={formatCents(collectedThisMonth)}
                hint={`${paymentsThisMonth.length} payment${paymentsThisMonth.length === 1 ? '' : 's'}`}
              />
              <BentoTile label="Average per store" value={formatCents(arpu)} />
              <BentoTile
                label="Trial → paid"
                value={`${conversion}%`}
                hint={`of ${decided.length} decided`}
                tone={conversion === 0 && decided.length > 0 ? 'warn' : 'default'}
              />
            </BentoTileRow>
          </BentoCard>
        </BentoCell>

        <BentoCell span={6}>
          <BentoCard title="Movement" scope="last 30 days">
            {/* Four tiles in a half-width card: 2 x 2, not 3 + 1 with the
                fourth stretched across its own row. */}
            <BentoTileRow minTileWidth={150}>
              <BentoTile label="New this week" value={`+${newIn(7)}`} hint={`+${newIn(30)} in 30 days`} />
              <BentoTile
                label="On trial"
                value={String(trialing.length)}
                hint={committed.length > 0 ? `${committed.length} more already paid` : undefined}
              />
              <BentoTile
                label="Plan changes"
                value={`↑${upgrades}  ↓${downgrades}`}
                hint="up and down a tier"
                tone={downgrades > upgrades ? 'warn' : 'default'}
              />
              <BentoTile
                label="Lapsed or suspended"
                value={String(expired.length + suspended.length)}
                tone={expired.length + suspended.length > 0 ? 'warn' : 'default'}
              />
            </BentoTileRow>
          </BentoCard>
        </BentoCell>

        <BentoCell span={6}>
          <BentoCard title="Plan mix" scope="today">
            <DonutChart slices={planSlices} centerValue={String(shops.length)} centerLabel="stores" />
          </BentoCard>
        </BentoCell>

        <BentoCell span={6}>
          <BentoCard title="New stores" scope="per week">
            <BarChart bars={signupBars} color={CHART_COLORS.signups} />
          </BentoCard>
        </BentoCell>

        <BentoCell span={6}>
          <BentoCard title="Money collected" scope="per month">
            <BarChart bars={revenueBars} color={CHART_COLORS.revenue} formatValue={(v) => formatCents(v)} />
          </BentoCard>
        </BentoCell>

        <BentoCell span={7}>
          <BentoCard title="Revenue by plan" scope="paying stores only">
            <View style={styles.mix}>
              {plans
                .filter((p) => p.priceCents > 0)
                .map((plan, i) => {
                  // Stored, not effective -- a store whose plan retired to
                  // this one still belongs on its OLD tile until it is
                  // actually billed at the new rate.
                  const onPaying = paying.filter((s) => s.storedPlanKey === plan.key).length;
                  const revenue = onPaying * plan.priceCents;
                  const share = mrr > 0 ? (revenue / mrr) * 100 : 0;
                  return (
                    <View key={plan.id} style={styles.mixRow}>
                      <Text style={styles.mixName} numberOfLines={1}>
                        {plan.name}
                      </Text>
                      <View style={styles.mixTrack}>
                        <View style={[styles.mixFill, { width: `${share}%`, backgroundColor: planColor(plan.key, i) }]} />
                      </View>
                      <Text style={styles.mixCount}>{onPaying}</Text>
                      <Text style={styles.mixRevenue}>{formatCents(revenue)}</Text>
                    </View>
                  );
                })}
              {mrr === 0 ? <Text style={styles.empty}>No paying stores yet — this fills in as trials convert.</Text> : null}
            </View>
          </BentoCard>
        </BentoCell>

        <BentoCell span={5}>
          <BentoCard title="Usage across all stores" scope="right now">
            {/* Six tiles in a 5/12 card. Left to itself this wraps 3 + 3 at
                desktop and 2 + 2 + 2 lower down, both even; the floor just
                stops a lone seventh-of-a-row tile appearing between them. */}
            <BentoTileRow minTileWidth={104}>
              {LIMIT_RESOURCES.map((r) => (
                <BentoTile key={r.key} label={limitLabel(r.key)} value={totalUsage(r.key).toLocaleString()} />
              ))}
            </BentoTileRow>
          </BentoCard>
        </BentoCell>
      </BentoGrid>

      {/* Out of the grid: a worklist is read down a column, so it takes the
          full width and its rows get the whole card. */}
      <BentoCard
        title="Needs attention"
        scope={attention.length === 1 ? '1 store' : `${attention.length} stores`}
      >
        {attention.length === 0 ? (
          <Text style={styles.empty}>Nothing pressing.</Text>
        ) : (
          attention.map((item, i) => (
            <AttentionRow
              key={item.key}
              shop={item.shop}
              note={item.note}
              message={item.message}
              first={i === 0}
              onOpen={onOpenShop}
            />
          ))
        )}
        <Caveat tone="context">
          Every figure here is ours — subscriptions, signups and how heavily stores use what they pay for. None of it is
          any store&apos;s takings.
        </Caveat>
      </BentoCard>
    </View>
  );
}

function AttentionRow({
  shop,
  note,
  message,
  first,
  onOpen,
}: {
  shop: PlatformShopRow;
  note: string;
  message: string;
  first: boolean;
  onOpen: (shopId: string) => void;
}) {
  const link = whatsappLink(shop.contactPhone, message);
  return (
    <View style={[styles.attentionRow, first && styles.attentionRowFirst]}>
      <Pressable style={styles.attentionMain} onPress={() => onOpen(shop.shopId)}>
        <Text style={styles.attentionName} numberOfLines={1}>
          {shop.shopName}
        </Text>
        <Text style={styles.attentionNote} numberOfLines={2}>
          {note}
        </Text>
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

const styles = StyleSheet.create({
  mix: { gap: 6 },
  mixRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  mixName: { fontSize: 12.5, fontWeight: '700', color: theme.bentoInk, width: 88 },
  mixTrack: { flex: 1, height: 8, borderRadius: 999, backgroundColor: theme.bentoSoft, overflow: 'hidden' },
  mixFill: { height: 8, borderRadius: 999 },
  mixCount: { fontSize: 12.5, fontWeight: '800', color: theme.bentoInk, width: 30, textAlign: 'right', fontVariant: ['tabular-nums'] },
  mixRevenue: { fontSize: 12, color: theme.bentoMuted, width: 74, textAlign: 'right', fontVariant: ['tabular-nums'] },

  // Rules between rows rather than a bordered box each: the card is already the
  // container, and eight bordered boxes inside one card is two frames deep.
  attentionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 12,
    borderTopWidth: 1,
    borderTopColor: theme.bentoRule,
  },
  attentionRowFirst: { borderTopWidth: 0, paddingTop: 0 },
  attentionMain: { flex: 1, gap: 3 },
  attentionName: { fontSize: 13.5, fontWeight: '800', color: theme.bentoInk },
  attentionNote: { fontSize: 11.5, color: theme.bentoMuted, lineHeight: 17 },
  waButton: { backgroundColor: `${theme.bentoProfit}1A`, borderRadius: 999, paddingHorizontal: 13, paddingVertical: 7 },
  waText: { color: theme.bentoProfit, fontSize: 11.5, fontWeight: '800' },
  waMissing: { color: theme.bentoMuted2, fontSize: 11 },
  empty: { fontSize: 13, color: theme.bentoMuted },
});
