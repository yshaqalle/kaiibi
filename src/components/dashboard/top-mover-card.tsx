import { StyleSheet, Text, View } from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';

import { Card } from '@/components/card';
import { Colors } from '@/constants/theme';
import { formatCompactCents } from '@/lib/currency';
import type { ProductMover } from '@/lib/sales-reporting';

const theme = Colors.light;

/**
 * One product that moved, against the same-length window before this one.
 *
 * White, not ink, even though it sits directly under a dark band: three small
 * dark tiles beside a dark hero is where the screen stops having a ground.
 * Dark is the hero and the full-width bands — see `BentoBand`.
 *
 * Both the change and the SIZE are on the card. A percentage on its own
 * invites the reader to act on a product that is 1% of takings;
 * `productMovers` already drops the smallest of those, and the share printed
 * here is what lets a reader judge the ones that survive.
 */
export function TopMoverCard({
  mover,
  shareOfRevenue,
  dailyCents,
  rangeLabel,
  rank,
}: {
  mover: ProductMover;
  /** "Biggest move", "Second", "Third" — position within the row. */
  rank: string;
  /** This product's share of the range's product revenue, 0–100. */
  shareOfRevenue: number;
  /** Day-by-day take for the sparkline — is this a climb or one good afternoon? */
  dailyCents: number[];
  rangeLabel: string;
}) {
  const rising = (mover.changePct ?? 0) >= 0;
  const isNew = mover.changePct === null;

  return (
    <Card variant="bento" fill style={styles.card}>
      <View style={styles.head}>
        <View style={styles.chip}>
          <Svg width={15} height={15} viewBox="0 0 24 24" aria-hidden>
            <Path
              d="M11.5 3.5h6a2 2 0 0 1 2 2v6L10 21 3 14 11.5 3.5Z"
              stroke={theme.bentoInk2}
              strokeWidth={1.7}
              strokeLinejoin="round"
              fill="none"
            />
            <Circle cx={16} cy={8} r={1.3} fill={theme.bentoInk2} />
          </Svg>
        </View>
        <View style={styles.headText}>
          <Text style={styles.name} numberOfLines={2}>
            {mover.name}
          </Text>
          <Text style={styles.scope}>{`${rank} · vs. ${rangeLabel.toLowerCase()} before`}</Text>
        </View>
      </View>

      {/* The arrow, not the colour, is what says which way this went. Profit
          green and loss red sit at ΔE 4.0 for deutan viewers, so a figure in
          either has to carry a glyph or a sign as well. */}
      <Text style={[styles.change, isNew ? styles.changeNew : rising ? styles.changeUp : styles.changeDown]}>
        {isNew ? 'New' : `${rising ? '↑' : '↓'} ${Math.abs(mover.changePct ?? 0).toFixed(0)}%`}
      </Text>

      <View style={styles.metaRow}>
        <Text style={styles.amount}>{formatCompactCents(mover.revenueCents)}</Text>
        <Text style={styles.share}>{`${shareOfRevenue.toFixed(0)}% of sales`}</Text>
      </View>

      <Sparkline values={dailyCents} />
    </Card>
  );
}

// Deliberately axis-less and label-less: this is a shape, not a reading. The
// figures above it are the reading.
function Sparkline({ values }: { values: number[] }) {
  if (values.length < 2) return <View style={styles.sparkSpacer} />;
  const max = Math.max(1, ...values);
  const path = values
    .map((value, i) => {
      const x = (i / (values.length - 1)) * 100;
      const y = 24 - (value / max) * 20;
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');

  return (
    <View style={styles.spark}>
      <Svg width="100%" height={26} viewBox="0 0 100 26" preserveAspectRatio="none">
        {/* vectorEffect keeps the stroke 2px however far the viewBox is
            stretched — without it a wide card draws a hairline and a narrow
            one draws a slab. */}
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
    </View>
  );
}

const styles = StyleSheet.create({
  card: { padding: 16 },
  head: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  headText: { flex: 1, minWidth: 0 },
  chip: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: theme.bentoSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  name: { fontSize: 13.5, fontWeight: '800', color: theme.bentoInk, letterSpacing: -0.1 },
  scope: { fontSize: 11, color: theme.bentoMuted, marginTop: 2 },
  change: { fontSize: 26, fontWeight: '800', letterSpacing: -0.6, marginTop: 10, fontVariant: ['tabular-nums'] },
  changeUp: { color: theme.bentoProfit },
  changeDown: { color: theme.bentoLoss },
  // A product with no prior sales has no percentage, so it takes neither
  // status colour — there is no direction to report.
  changeNew: { color: theme.bentoInk },
  metaRow: { flexDirection: 'row', alignItems: 'baseline', flexWrap: 'wrap', gap: 8, marginTop: 6 },
  amount: {
    fontSize: 11.5,
    fontWeight: '800',
    color: theme.bentoInk2,
    backgroundColor: theme.bentoSoft,
    borderRadius: 999,
    paddingHorizontal: 9,
    paddingVertical: 3,
    overflow: 'hidden',
    fontVariant: ['tabular-nums'],
  },
  share: { fontSize: 11, color: theme.bentoMuted, fontVariant: ['tabular-nums'] },
  spark: { marginTop: 'auto', paddingTop: 12 },
  sparkSpacer: { height: 26, marginTop: 12 },
});
