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

      {/* The SIGN, not the colour, is what says which way this went. Profit
          green and loss red sit at ΔE 4.0 for deutan viewers, so a figure in
          either has to carry a glyph or a sign as well.
          A sign rather than an arrow: an arrow beside "0%" claims a direction
          the figure does not have, and a change of nothing is a real result
          that this card has to be able to state. */}
      {isNew ? (
        <Text style={[styles.change, styles.changeSolo, styles.changeNew]}>New</Text>
      ) : (
        <View style={styles.changeRow}>
          <Text style={[styles.change, rising ? styles.changeUp : styles.changeDown]}>
            {`${rising ? '+' : '−'}${Math.abs(mover.changePct ?? 0).toFixed(0)}`}
          </Text>
          {/* Raised rather than baseline-aligned, so the number is what the
              eye lands on and the unit stays subordinate to it. */}
          <Text style={[styles.changeUnit, rising ? styles.changeUp : styles.changeDown]}>%</Text>
        </View>
      )}

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
      const y = 48 - (value / max) * 42;
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');

  return (
    <View style={styles.spark}>
      <Svg width="100%" height={52} viewBox="0 0 100 52" preserveAspectRatio="none">
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
  // A rounded square, not a circle: circles on this screen are avatars and
  // date chips — things that stand for a person or a day. A product marker is
  // neither.
  chip: {
    width: 32,
    height: 32,
    borderRadius: 10,
    backgroundColor: theme.bentoSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  name: { fontSize: 13, fontWeight: '800', color: theme.bentoInk, letterSpacing: -0.1 },
  scope: { fontSize: 11, color: theme.bentoMuted, marginTop: 2 },
  changeRow: { flexDirection: 'row', alignItems: 'flex-start', marginTop: 12 },
  // No marginTop of its own — the row above owns the spacing, or `changeSolo`
  // supplies it when the figure stands alone.
  change: { fontSize: 26, fontWeight: '800', letterSpacing: -0.6, fontVariant: ['tabular-nums'] },
  changeSolo: { marginTop: 12 },
  changeUnit: { fontSize: 14, fontWeight: '700', marginTop: 1 },
  changeUp: { color: theme.bentoProfit },
  changeDown: { color: theme.bentoLoss },
  // A product with no prior sales has no percentage, so it takes neither
  // status colour — there is no direction to report.
  changeNew: { color: theme.bentoInk },
  metaRow: { flexDirection: 'row', alignItems: 'baseline', flexWrap: 'wrap', gap: 8, marginTop: 6 },
  amount: {
    fontSize: 11.5,
    fontWeight: '800',
    // The neutral wash, not `bentoSoft`: this pill sits on the card's white,
    // where a soft-grey pill beside a green or red figure reads as the one
    // that has been greyed out.
    color: theme.bentoAccentInk,
    backgroundColor: theme.bentoAccentWash,
    borderRadius: 999,
    paddingHorizontal: 9,
    paddingVertical: 3,
    overflow: 'hidden',
    fontVariant: ['tabular-nums'],
  },
  share: { fontSize: 11, color: theme.bentoMuted, fontVariant: ['tabular-nums'] },
  spark: { marginTop: 'auto', paddingTop: 12 },
  sparkSpacer: { height: 52, marginTop: 12 },
});
