import { StyleSheet, Text, View } from 'react-native';
import Svg, { Circle } from 'react-native-svg';

import { BentoCard } from '@/components/ui/bento-card';
import { Colors } from '@/constants/theme';
import { formatCompactCents } from '@/lib/currency';

const theme = Colors.light;

const RING_SIZE = 116;
const RADIUS = 46;
const STROKE = 12;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
// The calendar month, averaged. 365/12/7 — not 4, which would set a weekly
// target 8.5% too high and report every shop as behind.
const WEEKS_PER_MONTH = 365 / 12 / 7;

type Pace = { label: string; valueCents: number; targetCents: number };

/**
 * Am I on track? — asked at three horizons.
 *
 * The revenue goal already answers it for the month. What it cannot say is
 * whether *today* is keeping up with the rate the month needs, which is the
 * only version of the question you can still act on. All three targets are
 * the one goal divided down; nothing here invents a number the shop never set.
 */
export function SalesPaceCard({
  todayCents,
  weekCents,
  monthToDateCents,
  monthlyGoalCents,
  daysLeftInMonth,
}: {
  todayCents: number;
  weekCents: number;
  monthToDateCents: number;
  monthlyGoalCents: number;
  daysLeftInMonth: number;
}) {
  const perDay = monthlyGoalCents / 30;
  const perWeek = monthlyGoalCents / WEEKS_PER_MONTH;

  const paces: Pace[] = [
    { label: 'Today', valueCents: todayCents, targetCents: perDay },
    { label: 'This week', valueCents: weekCents, targetCents: perWeek },
    { label: 'This month', valueCents: monthToDateCents, targetCents: monthlyGoalCents },
  ];

  return (
    <BentoCard title="Sales pace" scope="vs. the monthly goal">
      <View style={styles.row}>
        {paces.map((pace) => (
          <PaceRing key={pace.label} {...pace} />
        ))}
      </View>
      <Text style={styles.foot}>
        {`The monthly goal is the only figure you set — the day and week targets are it divided down ` +
          `(${formatCompactCents(perDay)} and ${formatCompactCents(perWeek)}). ` +
          `${daysLeftInMonth} ${daysLeftInMonth === 1 ? 'day' : 'days'} left in the month.`}
      </Text>
    </BentoCard>
  );
}

function PaceRing({ label, valueCents, targetCents }: Pace) {
  const pct = targetCents > 0 ? (valueCents / targetCents) * 100 : 0;
  const ahead = pct >= 100;
  const swept = Math.max(0, Math.min(100, pct));

  return (
    <View style={styles.pace}>
      <View style={styles.ringWrap}>
        <Svg width={RING_SIZE} height={RING_SIZE} viewBox={`0 0 ${RING_SIZE} ${RING_SIZE}`}>
          <Circle cx={RING_SIZE / 2} cy={RING_SIZE / 2} r={RADIUS} fill="none" stroke={theme.bentoLine} strokeWidth={STROKE} />
          <Circle
            cx={RING_SIZE / 2}
            cy={RING_SIZE / 2}
            r={RADIUS}
            fill="none"
            stroke={ahead ? theme.bentoProfit : theme.bentoSeries1}
            strokeWidth={STROKE}
            strokeLinecap="round"
            strokeDasharray={`${(swept / 100) * CIRCUMFERENCE} ${CIRCUMFERENCE}`}
            // Starts the sweep at twelve o'clock rather than three, which is
            // where a progress ring is read from.
            transform={`rotate(-90 ${RING_SIZE / 2} ${RING_SIZE / 2})`}
          />
        </Svg>
        <View style={styles.ringCentre} pointerEvents="none">
          <Text style={styles.ringValue}>{formatCompactCents(valueCents)}</Text>
          <Text style={styles.ringLabel}>{label}</Text>
        </View>
      </View>
      {/* The word, not the ring colour, is what says ahead or behind. */}
      <Text style={styles.caption}>
        <Text style={styles.captionFigure}>{`${pct.toFixed(0)}%`}</Text>
        {` of ${formatCompactCents(targetCents)} · `}
        <Text style={ahead ? styles.ahead : styles.behind}>{ahead ? 'ahead' : 'behind'}</Text>
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 18 },
  // flexBasis, not a fixed width: three rings fit a desktop card and stack on
  // a phone without a breakpoint being spelled out here.
  pace: { flexGrow: 1, flexShrink: 1, flexBasis: 150, alignItems: 'center' },
  ringWrap: { width: RING_SIZE, height: RING_SIZE, alignItems: 'center', justifyContent: 'center' },
  ringCentre: { position: "absolute", top: 0, right: 0, bottom: 0, left: 0, alignItems: 'center', justifyContent: 'center' },
  ringValue: { fontSize: 18, fontWeight: '800', letterSpacing: -0.4, color: theme.bentoInk, fontVariant: ['tabular-nums'] },
  ringLabel: { fontSize: 10.5, color: theme.bentoMuted, marginTop: 2 },
  caption: { fontSize: 11.5, color: theme.bentoMuted, marginTop: 9, textAlign: 'center', lineHeight: 16 },
  captionFigure: { fontWeight: '800', color: theme.bentoInk2, fontVariant: ['tabular-nums'] },
  ahead: { color: theme.bentoProfit, fontWeight: '700' },
  behind: { color: theme.bentoLoss, fontWeight: '700' },
  foot: { fontSize: 11.5, color: theme.bentoMuted, marginTop: 14, lineHeight: 17 },
});
