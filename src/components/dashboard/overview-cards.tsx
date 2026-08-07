import { StyleSheet, Text, View } from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';

import { Card } from '@/components/card';
import { DeltaBadge } from '@/components/ui/delta-badge';
import { Colors } from '@/constants/theme';
import { formatAccountingCents, formatCompactCents } from '@/lib/currency';

const theme = Colors.light;

/**
 * Money in and money out at full size, each with how it moved.
 *
 * The pair the reference design leads with, and the reason it works: two
 * figures that mean nothing apart. Revenue alone is a vanity number; revenue
 * beside what it cost to earn is a business.
 */
export function IncomePaidCard({
  revenueCents,
  expenseCents,
  previousRevenueCents,
  previousExpenseCents,
  canSeeExpenses,
  scope,
}: {
  revenueCents: number;
  expenseCents: number;
  previousRevenueCents: number | null;
  previousExpenseCents: number | null;
  canSeeExpenses: boolean;
  scope: string;
}) {
  return (
    <Card variant="bento" style={styles.card}>
      <View style={styles.headRow}>
        <Text style={styles.smallLabel}>Total income</Text>
        <Text style={styles.scopePill}>{scope}</Text>
      </View>
      <View style={styles.valueRow}>
        <Text style={styles.value}>{formatAccountingCents(revenueCents)}</Text>
        <DeltaBadge current={revenueCents} previous={previousRevenueCents} />
      </View>

      {canSeeExpenses ? (
        <>
          <View style={styles.rule} />
          <Text style={styles.smallLabel}>Total paid</Text>
          <View style={styles.valueRow}>
            <Text style={styles.value}>{formatAccountingCents(expenseCents)}</Text>
            {/* lowerIsBetter: expenses climbing reads red while the arrow
                still points up. */}
            <DeltaBadge current={expenseCents} previous={previousExpenseCents} lowerIsBetter />
          </View>
        </>
      ) : null}
    </Card>
  );
}

/**
 * Net margin, on the second dark surface.
 *
 * A ring rather than a number alone because margin is a share of something,
 * and a ring is the only shape on this screen that says so. The track and fill
 * are the DARK profit/loss steps: the light ones read 2.93:1 here, under the
 * 3:1 floor for a chart mark.
 */
export function MarginGaugeCard({ netProfitCents, revenueCents }: { netProfitCents: number; revenueCents: number }) {
  const margin = revenueCents > 0 ? (netProfitCents / revenueCents) * 100 : 0;
  const positive = margin >= 0;
  const size = 150;
  const radius = 57;
  const circumference = 2 * Math.PI * radius;
  const swept = Math.min(100, Math.abs(margin));

  return (
    <Card variant="bento" style={styles.gaugeCard}>
      <View style={styles.ring}>
        <Svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
          <Circle cx={size / 2} cy={size / 2} r={radius} fill={theme.bentoInk} />
          <Circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="#2a2a30" strokeWidth={16} />
          <Circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke={positive ? Colors.dark.bentoProfit : Colors.dark.bentoLoss}
            strokeWidth={16}
            strokeLinecap="round"
            strokeDasharray={`${(swept / 100) * circumference} ${circumference}`}
            transform={`rotate(-90 ${size / 2} ${size / 2})`}
          />
        </Svg>
        <View style={styles.ringCentre} pointerEvents="none">
          <Text style={styles.ringValue}>{`${Math.round(margin)}%`}</Text>
          {/* The word "loss" does the work, not the red. */}
          <Text style={styles.ringLabel}>{positive ? 'Net margin' : 'Net margin (loss)'}</Text>
        </View>
      </View>
    </Card>
  );
}

/**
 * One dot per product sold, filled when it has a cost recorded.
 *
 * A count would say "6 of 24 missing" and be forgotten. Twenty-four dots with
 * six of them hollow is a picture of how much of the margin on this screen is
 * guesswork, and it stops being abstract.
 */
export function CostedProductsCard({ soldCount, uncostedCount }: { soldCount: number; uncostedCount: number }) {
  const costed = Math.max(0, soldCount - uncostedCount);
  return (
    <Card variant="bento" style={styles.card}>
      <Text style={styles.costedValue}>{`${costed}/${soldCount}`}</Text>
      <Text style={styles.foot}>products sold have a cost set</Text>
      <View style={styles.dots}>
        {Array.from({ length: Math.min(soldCount, 48) }, (_, i) => (
          <View key={i} style={[styles.dot, i < costed && styles.dotOn]} />
        ))}
      </View>
    </Card>
  );
}

/**
 * Revenue as a shape, with the period's total and whether it was profitable.
 *
 * The smallest card in the row and the one that answers "was this a good
 * week" fastest — the trend chart further down answers "which day", which is
 * a different question.
 */
export function RevenueSparkCard({
  revenueCents,
  dailyCents,
  orderCount,
  netProfitCents,
  scope,
}: {
  revenueCents: number;
  dailyCents: number[];
  orderCount: number;
  netProfitCents: number;
  scope: string;
}) {
  const atALoss = netProfitCents < 0;
  const max = Math.max(1, ...dailyCents);
  const path = dailyCents
    .map((value, i) => {
      const x = dailyCents.length === 1 ? 50 : (i / (dailyCents.length - 1)) * 100;
      const y = 40 - (value / max) * 32;
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');

  return (
    <Card variant="bento" style={styles.card}>
      <Text style={styles.sparkValue}>{formatCompactCents(revenueCents)}</Text>
      <View style={styles.spark}>
        {dailyCents.length > 1 ? (
          <Svg width="100%" height={44} viewBox="0 0 100 44" preserveAspectRatio="none">
            <Path
              d={`${path} L100,44 L0,44 Z`}
              fill={theme.bentoSeries1}
              opacity={0.14}
              // The fill is only legible as a wash; the line above carries the
              // shape, so the area never has to clear a contrast floor.
            />
            <Path
              d={path}
              fill="none"
              stroke={theme.bentoSeries1}
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
            />
          </Svg>
        ) : null}
      </View>
      <View style={styles.sparkFootRow}>
        <View style={styles.sparkFootText}>
          <Text style={styles.sparkTitle}>Revenue</Text>
          <Text style={styles.foot}>{`${scope} · ${orderCount} ${orderCount === 1 ? 'order' : 'orders'}`}</Text>
        </View>
        <Text style={[styles.tag, atALoss && styles.tagSolid]}>{atALoss ? 'at a loss' : 'profitable'}</Text>
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  card: { padding: 16 },
  headRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 8 },
  smallLabel: { fontSize: 12, fontWeight: '600', color: theme.bentoMuted },
  scopePill: {
    fontSize: 11,
    fontWeight: '700',
    color: theme.bentoInk2,
    borderWidth: 1,
    borderColor: theme.bentoLine,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 3,
    overflow: 'hidden',
  },
  valueRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 9, marginTop: 4 },
  value: { fontSize: 24, fontWeight: '800', letterSpacing: -0.6, color: theme.bentoInk, fontVariant: ['tabular-nums'] },
  rule: { borderTopWidth: 1, borderTopColor: theme.bentoLine, marginVertical: 14 },

  gaugeCard: { padding: 16, alignItems: 'center', justifyContent: 'center' },
  ring: { width: 150, height: 150, alignItems: 'center', justifyContent: 'center' },
  ringCentre: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 22 },
  ringValue: { fontSize: 22, fontWeight: '800', color: '#ffffff', fontVariant: ['tabular-nums'], letterSpacing: -0.4 },
  ringLabel: { fontSize: 10, color: '#a6a6ae', marginTop: 3, textAlign: 'center', lineHeight: 13 },

  costedValue: { fontSize: 22, fontWeight: '800', letterSpacing: -0.5, color: theme.bentoInk, fontVariant: ['tabular-nums'] },
  foot: { fontSize: 11.5, color: theme.bentoMuted, marginTop: 3, lineHeight: 16 },
  dots: { flexDirection: 'row', flexWrap: 'wrap', gap: 5, marginTop: 12 },
  dot: { width: 9, height: 9, borderRadius: 5, backgroundColor: theme.bentoLine },
  dotOn: { backgroundColor: theme.bentoProfit },

  sparkValue: { fontSize: 20, fontWeight: '800', letterSpacing: -0.5, color: theme.bentoInk, fontVariant: ['tabular-nums'] },
  spark: { height: 44, marginVertical: 10 },
  sparkFootRow: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' },
  sparkFootText: { flexGrow: 1, flexShrink: 1 },
  sparkTitle: { fontSize: 14, fontWeight: '800', color: theme.bentoInk },
  tag: {
    fontSize: 10.5,
    fontWeight: '800',
    color: theme.bentoInk2,
    backgroundColor: theme.bentoSoft,
    borderWidth: 1,
    borderColor: theme.bentoLine,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 3,
    overflow: 'hidden',
  },
  // Inverted rather than red: "at a loss" is the sentence, and a red pill
  // beside a red net-profit figure is the same alarm twice.
  tagSolid: { backgroundColor: theme.bentoInk, color: '#ffffff', borderColor: theme.bentoInk },
});
