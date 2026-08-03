import { StyleSheet, Text, View } from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';

import { Card } from '@/components/card';
import { Colors } from '@/constants/theme';

// Pinned to the light palette for now — no dark-mode switching yet.
const theme = Colors.light;

export function StatTile({
  value,
  label,
  delta,
  tone = 'default',
  sparkline,
}: {
  value: string;
  label: string;
  delta?: { text: string; direction: 'up' | 'down' };
  tone?: 'default' | 'warning';
  sparkline?: number[];
}) {
  return (
    <Card style={styles.tile}>
      <View style={styles.valueRow}>
        {/* Shrinks rather than overflows, and never wraps: a figure broken
            across two lines is harder to read than one scaled down. */}
        <Text
          style={[styles.value, { color: tone === 'warning' ? theme.warning : theme.text }]}
          numberOfLines={1}
          adjustsFontSizeToFit
          minimumFontScale={0.7}
        >
          {value}
        </Text>
        {delta ? (
          <Text style={[styles.delta, { color: delta.direction === 'up' ? theme.success : theme.danger }]}>{delta.text}</Text>
        ) : null}
      </View>
      {sparkline && sparkline.length > 1 ? <Sparkline values={sparkline} /> : null}
      {/* Two lines, so "Customers to check on" wraps between words instead of
          being broken mid-word by a column too narrow for the longest one. */}
      <Text style={[styles.label, { color: theme.textSecondary }]} numberOfLines={2}>
        {label}
      </Text>
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
      <Circle cx={w} cy={lastY} r={2.4} fill={theme.chartAccent} />
    </Svg>
  );
}

const styles = StyleSheet.create({
  // `minWidth` is what makes the surrounding `flexWrap` row actually wrap.
  // With `flex: 1` alone the tiles shrink without limit, so five of them
  // squeeze onto one phone-width line, clipping the value and breaking the
  // label mid-word. Now they drop to the next line instead — roughly two per
  // row on a phone, all five across on a tablet.
  tile: { flex: 1, minWidth: 132, minHeight: 90, padding: 14, justifyContent: 'flex-end' },
  // No wrapping here: the value and its delta stay on one line together, and
  // the value scales down if it has to.
  valueRow: { flexDirection: 'row', alignItems: 'baseline', gap: 4 },
  // flexShrink lets adjustsFontSizeToFit actually engage — without it the Text
  // keeps its intrinsic width and overflows the tile instead of scaling.
  value: { flexShrink: 1, fontSize: 22, letterSpacing: -1, fontWeight: '800' },
  delta: { fontSize: 10.5, fontWeight: '700' },
  spark: { marginTop: 6 },
  label: { marginTop: 4, fontSize: 11, lineHeight: 14 },
});
