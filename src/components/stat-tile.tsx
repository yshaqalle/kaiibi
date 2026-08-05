import { StyleSheet, Text, View } from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';

import { Card } from '@/components/card';
import { Colors } from '@/constants/theme';

// Pinned to the light palette for now — no dark-mode switching yet.
const theme = Colors.light;

// A single headline figure.
//
// The label sits ABOVE the value now, small and uppercase, with an optional
// hint below. That order is what makes a row of these scannable: the eye runs
// along the big figures, and reads a label only when one of them stops it.
// With the label underneath, every tile had to be read top-to-bottom before
// you knew what it was.
//
// The hint is where the DEFINITION goes -- "net of tax & refunds", "20%
// margin". Same job as StatementRow's hint: a figure that doesn't say what is
// in and out of it invites an argument.
export function StatTile({
  value,
  label,
  hint,
  delta,
  tone = 'default',
  sparkline,
}: {
  value: string;
  label: string;
  hint?: string;
  delta?: { text: string; direction: 'up' | 'down' };
  tone?: 'default' | 'warning' | 'positive';
  sparkline?: number[];
}) {
  return (
    <Card style={styles.tile}>
      {/* Two lines, so "Customers to check on" wraps between words instead of
          being broken mid-word by a column too narrow for the longest one. */}
      <Text style={styles.label} numberOfLines={2}>
        {label.toUpperCase()}
      </Text>

      <View style={styles.valueRow}>
        {/* Shrinks rather than overflows, and never wraps: a figure broken
            across two lines is harder to read than one scaled down. */}
        <Text
          style={[styles.value, TONE[tone]]}
          numberOfLines={1}
          adjustsFontSizeToFit
          minimumFontScale={0.7}
        >
          {value}
        </Text>
        {delta ? (
          <Text style={[styles.delta, delta.direction === 'up' ? styles.deltaUp : styles.deltaDown]}>
            {delta.text}
          </Text>
        ) : null}
      </View>

      {hint ? <Text style={styles.hint} numberOfLines={2}>{hint}</Text> : null}
      {sparkline && sparkline.length > 1 ? <Sparkline values={sparkline} /> : null}
    </Card>
  );
}

function Sparkline({ values }: { values: number[] }) {
  const w = 80;
  const h = 16;
  const max = Math.max(...values);
  const min = Math.min(...values);
  const span = Math.max(1, max - min);
  const path = values
    .map((v, i) => {
      const x = (i / (values.length - 1)) * w;
      const y = h - ((v - min) / span) * h;
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  const lastY = h - ((values[values.length - 1] - min) / span) * h;

  return (
    <Svg width={w} height={h + 2} viewBox={`0 0 ${w} ${h + 2}`} style={styles.spark}>
      <Path d={path} fill="none" stroke={theme.textSecondary} strokeWidth={1.5} opacity={0.55} />
      {/* The endpoint is emphasised because "where it is now" is the thing a
          sparkline is actually asked. */}
      <Circle cx={w} cy={lastY} r={2.4} fill={theme.chartAccent} />
    </Svg>
  );
}

const TONE = StyleSheet.create({
  default: { color: theme.text },
  warning: { color: theme.warning },
  positive: { color: theme.success },
});

const styles = StyleSheet.create({
  // `minWidth` is what makes the surrounding `flexWrap` row actually wrap.
  // With `flex: 1` alone the tiles shrink without limit, so five of them
  // squeeze onto one phone-width line, clipping the value and breaking the
  // label mid-word. Now they drop to the next line instead.
  tile: { flex: 1, minWidth: 148, minHeight: 92, padding: 14 },
  label: {
    fontSize: 9.5,
    letterSpacing: 1.1,
    fontWeight: '700',
    color: theme.textSecondary,
    lineHeight: 13,
  },
  valueRow: { flexDirection: 'row', alignItems: 'baseline', gap: 6, marginTop: 7 },
  // flexShrink lets adjustsFontSizeToFit actually engage — without it the Text
  // keeps its intrinsic width and overflows the tile instead of scaling.
  value: { flexShrink: 1, fontSize: 24, letterSpacing: -1, fontWeight: '800', fontVariant: ['tabular-nums'] },
  delta: { fontSize: 11, fontWeight: '700' },
  deltaUp: { color: theme.success },
  deltaDown: { color: theme.danger },
  hint: { fontSize: 11, color: theme.textSecondary, marginTop: 3, lineHeight: 15 },
  spark: { marginTop: 8 },
});
