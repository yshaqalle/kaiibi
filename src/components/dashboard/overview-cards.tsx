import { Pressable, StyleSheet, Text, View } from 'react-native';
import Svg, { Circle, Path, Polyline, Text as SvgText } from 'react-native-svg';

import { Card } from '@/components/card';
import { DeltaBadge } from '@/components/ui/delta-badge';
import { Colors } from '@/constants/theme';
import { formatAccountingCents, formatCompactCents } from '@/lib/currency';

const theme = Colors.light;

/**
 * The small circular glyph on an Overview card.
 *
 * Line icons drawn inline rather than an icon font: the app has no icon set,
 * and five glyphs do not justify one. Each is decorative — the card's own
 * heading says what it is — so they carry `aria-hidden` and never become the
 * only signal.
 */
function IconChip({ glyph }: { glyph: 'up' | 'down' | 'tag' | 'trend' | 'target' }) {
  return (
    <View style={styles.chip}>
      <Svg width={16} height={16} viewBox="0 0 24 24" aria-hidden>
        {glyph === 'up' ? (
          <>
            <Path d="M12 19V6" stroke={theme.bentoInk2} strokeWidth={1.9} strokeLinecap="round" fill="none" />
            <Polyline points="6,12 12,6 18,12" stroke={theme.bentoInk2} strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" fill="none" />
          </>
        ) : null}
        {glyph === 'down' ? (
          <>
            <Path d="M12 5v13" stroke={theme.bentoInk2} strokeWidth={1.9} strokeLinecap="round" fill="none" />
            <Polyline points="6,12 12,18 18,12" stroke={theme.bentoInk2} strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" fill="none" />
          </>
        ) : null}
        {glyph === 'tag' ? (
          <>
            <Path
              d="M11.5 3.5h6a2 2 0 0 1 2 2v6L10 21 3 14 11.5 3.5Z"
              stroke={theme.bentoInk2}
              strokeWidth={1.7}
              strokeLinejoin="round"
              fill="none"
            />
            <Circle cx={16} cy={8} r={1.4} fill={theme.bentoInk2} />
          </>
        ) : null}
        {glyph === 'trend' ? (
          <>
            <Polyline points="3,16 9,10 13,14 21,5" stroke={theme.bentoInk2} strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" fill="none" />
            <Polyline points="15,5 21,5 21,11" stroke={theme.bentoInk2} strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" fill="none" />
          </>
        ) : null}
        {glyph === 'target' ? (
          <>
            <Circle cx={12} cy={12} r={8.5} stroke={theme.bentoInk2} strokeWidth={1.75} fill="none" />
            <Circle cx={12} cy={12} r={4.5} stroke={theme.bentoInk2} strokeWidth={1.75} fill="none" />
            <Circle cx={12} cy={12} r={1} fill={theme.bentoInk2} />
          </>
        ) : null}
      </Svg>
    </View>
  );
}

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
    <Card variant="bento" fill style={styles.card}>
      <View style={styles.headRow}>
        <IconChip glyph="up" />
        <Text style={styles.scopePill}>{scope}</Text>
      </View>
      <Text style={styles.smallLabel}>Total income</Text>
      <View style={styles.valueRow}>
        <Text style={styles.value}>{formatAccountingCents(revenueCents)}</Text>
        <DeltaBadge current={revenueCents} previous={previousRevenueCents} />
      </View>

      {canSeeExpenses ? (
        <>
          <View style={styles.rule} />
          <View style={styles.headRow}>
            <IconChip glyph="down" />
          </View>
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
    <Card variant="bento" fill style={styles.gaugeCard}>
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
    <Card variant="bento" fill style={styles.card}>
      <IconChip glyph="tag" />
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
 * How far into the monthly revenue goal the shop is.
 *
 * A ring rather than a bar. The question is "how much of the month's target is
 * done", which is a proportion of a fixed whole — the shape a ring states
 * directly and a bar only states once you have read both ends of it. The old
 * bar spent its height printing the figure, the percentage, a zero and the
 * goal, four numbers for one fact.
 *
 * The percentage is drawn INSIDE the ring, and the money is spelled out in the
 * caption underneath, because a ring alone cannot be read to the dollar and
 * this is a figure people quote at each other.
 */
export function RevenueGoalCard({
  monthToDateCents,
  goalCents,
  daysLeftInMonth,
  onEdit,
}: {
  monthToDateCents: number;
  goalCents: number;
  daysLeftInMonth: number;
  onEdit: () => void;
}) {
  const pct = goalCents > 0 ? (monthToDateCents / goalCents) * 100 : 0;
  const remainingCents = Math.max(0, goalCents - monthToDateCents);
  const met = remainingCents === 0;

  return (
    <Card variant="bento" fill style={styles.goalCard}>
      <View style={styles.goalHead}>
        <IconChip glyph="target" />
        <Pressable onPress={onEdit} style={({ pressed }) => [styles.editPill, pressed && styles.editPillPressed]} role="button">
          <Text style={styles.editLabel}>Edit</Text>
        </Pressable>
      </View>

      <View style={styles.goalRing}>
        <GoalRing pct={pct} />
      </View>

      <Text style={styles.goalCaption}>
        {`${formatCompactCents(monthToDateCents)} of ${formatCompactCents(goalCents)} monthly goal · ` +
          // Dividing by the days left is what the run-rate means, and on the
          // last day of the month that divisor is zero. Both edges get a
          // sentence instead of an Infinity or a pointless "$0/day".
          (met
            ? 'already met'
            : daysLeftInMonth > 0
              ? `${formatCompactCents(Math.round(remainingCents / daysLeftInMonth))}/day to land it`
              : `${formatCompactCents(remainingCents)} short with the month over`)}
      </Text>
    </Card>
  );
}

const RING = 120;
const RING_R = 45.6;
const RING_STROKE = 13.2;
const RING_C = 2 * Math.PI * RING_R;

function GoalRing({ pct }: { pct: number }) {
  const swept = Math.max(0, Math.min(100, pct));
  return (
    <Svg
      width="100%"
      height="100%"
      viewBox={`0 0 ${RING} ${RING}`}
      role="img"
      aria-label={`${Math.round(pct)}% of the monthly revenue goal.`}
    >
      <Circle cx={60} cy={60} r={RING_R} fill="none" stroke={theme.bentoLine} strokeWidth={RING_STROKE} />
      <Circle
        cx={60}
        cy={60}
        r={RING_R}
        fill="none"
        stroke={theme.bentoSeries1}
        strokeWidth={RING_STROKE}
        strokeLinecap="round"
        strokeDasharray={`${((swept / 100) * RING_C).toFixed(1)} ${RING_C.toFixed(1)}`}
        // Twelve o'clock, not three — where a progress ring is read from.
        transform={`rotate(-90 60 60)`}
      />
      {/* SVG text, so it scales with the ring rather than needing its own
          absolute overlay to stay centred at every card width. */}
      <SvgText x={60} y={67} textAnchor="middle" fontSize={23} fontWeight="800" fill={theme.bentoInk}>
        {`${Math.round(pct)}%`}
      </SvgText>
    </Svg>
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
    <Card variant="bento" fill style={styles.card}>
      <View style={styles.headRow}>
        <IconChip glyph="trend" />
        <Text style={styles.sparkValue}>{formatCompactCents(revenueCents)}</Text>
      </View>
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
  goalCard: { paddingVertical: 16, paddingHorizontal: 18 },
  goalHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  // Capped and centred rather than filling the card: the ring is a proportion,
  // and a proportion does not get more readable by getting bigger. Squared by
  // aspectRatio so the SVG's own viewBox is never letterboxed.
  goalRing: { width: '100%', maxWidth: 112, aspectRatio: 1, alignSelf: 'center', marginTop: 8 },
  goalCaption: {
    fontSize: 11.5,
    color: theme.bentoMuted,
    lineHeight: 17,
    marginTop: 10,
    textAlign: 'center',
  },
  editPill: {
    borderWidth: 1,
    borderColor: theme.bentoLine,
    borderRadius: 999,
    paddingHorizontal: 13,
    paddingVertical: 6,
    overflow: 'hidden',
  },
  editPillPressed: { backgroundColor: theme.bentoSoft },
  editLabel: { fontSize: 12, fontWeight: '700', color: theme.bentoInk2 },
  chip: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: theme.bentoSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
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

  costedValue: { marginTop: 10, fontSize: 22, fontWeight: '800', letterSpacing: -0.5, color: theme.bentoInk, fontVariant: ['tabular-nums'] },
  foot: { fontSize: 11.5, color: theme.bentoMuted, marginTop: 3, lineHeight: 16 },
  dots: { flexDirection: 'row', flexWrap: 'wrap', gap: 5, marginTop: 12 },
  dot: { width: 9, height: 9, borderRadius: 5, backgroundColor: theme.bentoLine },
  dotOn: { backgroundColor: theme.bentoProfit },

  sparkValue: { fontSize: 20, fontWeight: '800', letterSpacing: -0.5, color: theme.bentoInk, fontVariant: ['tabular-nums'] },
  // marginTop auto pushes the shape and its caption to the bottom of a
  // stretched card, so the five Overview cards share a baseline.
  spark: { height: 44, marginTop: 'auto', marginBottom: 10 },
  sparkFootRow: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' },
  // `flexBasis` matters as much as the grow/shrink: without it the basis is
  // the text's own width, the tag beside it does not shrink, and the block
  // gets squeezed to ~57pt in a narrow cell -- which breaks "Revenue" across
  // two lines mid-word. A basis wider than the leftover makes the row wrap
  // the tag onto its own line instead, which is the readable answer. Same
  // fix, same reason, as `flowText` in takings-hero-card.
  sparkFootText: { flexGrow: 1, flexShrink: 1, flexBasis: 110 },
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

  glanceHead: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, marginBottom: 12 },
  glanceHeadText: { flex: 1, minWidth: 0 },
  glanceTitle: { fontSize: 13.5, fontWeight: '800', color: theme.bentoInk },
  glanceRow: { flexDirection: 'row', gap: 10, flexWrap: 'wrap' },
  glanceItem: { flexGrow: 1, flexShrink: 1, flexBasis: 60, minWidth: 0 },
  glanceValue: { fontSize: 20, fontWeight: '800', letterSpacing: -0.4, color: theme.bentoInk, fontVariant: ['tabular-nums'] },
  glanceValueBad: { color: theme.bentoLoss },
  glanceLabel: { fontSize: 10.5, color: theme.bentoMuted, marginTop: 2, lineHeight: 14 },
  // marginTop auto pins the actions to the bottom, so three cards of
  // different text lengths still line their buttons up.
  buttons: { gap: 8, marginTop: 'auto', paddingTop: 14 },
  button: {
    borderRadius: 999,
    paddingVertical: 10,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: theme.bentoLine,
    overflow: 'hidden',
  },
  buttonSolid: { backgroundColor: theme.bentoInk, borderColor: theme.bentoInk },
  buttonLabel: { fontSize: 12.5, fontWeight: '700', color: theme.bentoInk },
  buttonSolidLabel: { fontSize: 12.5, fontWeight: '700', color: '#ffffff' },
});

/**
 * The fourth card in the "what is selling" row — inventory, at a glance.
 *
 * Three counts and the two things you would do about them. It exists because
 * the row beside it is three products, and three products is not inventory:
 * without this the reader learns what moved and has nowhere to go with it.
 */
export function InventoryGlanceCard({
  productsSold,
  uncostedCount,
  lowStockCount,
  onSetCosts,
  onReviewLowStock,
}: {
  productsSold: number;
  uncostedCount: number;
  lowStockCount: number;
  onSetCosts: () => void;
  onReviewLowStock: () => void;
}) {
  return (
    <Card variant="bento" fill style={styles.card}>
      <View style={styles.glanceHead}>
        <View style={styles.chip}>
          <Svg width={15} height={15} viewBox="0 0 24 24" aria-hidden>
            <Path
              d="M12 3 20 7.2v9.6L12 21 4 16.8V7.2L12 3Z"
              stroke={theme.bentoInk2}
              strokeWidth={1.6}
              strokeLinejoin="round"
              fill="none"
            />
            <Polyline points="4,7.2 12,11.5 20,7.2" stroke={theme.bentoInk2} strokeWidth={1.6} fill="none" />
          </Svg>
        </View>
        <View style={styles.glanceHeadText}>
          <Text style={styles.glanceTitle}>Inventory at a glance</Text>
          {/* Not the range pill: what is on the shelf is a fact about now. */}
          <Text style={styles.foot}>As of today</Text>
        </View>
      </View>

      <View style={styles.glanceRow}>
        <View style={styles.glanceItem}>
          <Text style={styles.glanceValue}>{productsSold}</Text>
          <Text style={styles.glanceLabel}>products sold</Text>
        </View>
        <View style={styles.glanceItem}>
          <Text style={[styles.glanceValue, uncostedCount > 0 && styles.glanceValueBad]}>{uncostedCount}</Text>
          <Text style={styles.glanceLabel}>missing a cost</Text>
        </View>
        <View style={styles.glanceItem}>
          <Text style={styles.glanceValue}>{lowStockCount}</Text>
          <Text style={styles.glanceLabel}>low on stock</Text>
        </View>
      </View>

      {uncostedCount > 0 ? (
        <Text style={styles.foot}>
          {`${uncostedCount} of the ${productsSold} products sold have no cost, so every margin on this screen is flattering.`}
        </Text>
      ) : (
        <Text style={styles.foot}>Every product sold has a cost recorded, so the margins above are real.</Text>
      )}

      <View style={styles.buttons}>
        <Pressable onPress={onSetCosts} style={[styles.button, styles.buttonSolid]} role="button">
          <Text style={styles.buttonSolidLabel}>Set costs in Inventory</Text>
        </Pressable>
        <Pressable onPress={onReviewLowStock} style={styles.button} role="button">
          <Text style={styles.buttonLabel}>Review low stock</Text>
        </Pressable>
      </View>
    </Card>
  );
}
