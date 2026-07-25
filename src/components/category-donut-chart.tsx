import { StyleSheet, Text, View } from 'react-native';
import Svg, { Circle, G } from 'react-native-svg';

import { Colors } from '@/constants/theme';

// Pinned to the light palette for now — no dark-mode switching yet.
const theme = Colors.light;

const SIZE = 128;
const STROKE = 22;
const RADIUS = (SIZE - STROKE) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
const GAP = 3;

const SLOT_COLORS = [theme.chartSeries1, theme.chartSeries2, theme.chartSeries3, theme.chartSeries4] as const;

export type CategorySlice = { category: string; value: number };

// Folds anything past the top 3 categories (by value) into "Other" so the
// donut never grows a 5th+ slot (dataviz series-count ladder) — the rest of
// the dashboard's categorical charts use the same rule.
function foldToTopThree(items: CategorySlice[]): CategorySlice[] {
  const sorted = [...items].sort((a, b) => b.value - a.value);
  const top = sorted.slice(0, 3);
  const otherValue = sorted.slice(3).reduce((sum, item) => sum + item.value, 0);
  return otherValue > 0 ? [...top, { category: 'Other', value: otherValue }] : top;
}

export function CategoryDonutChart({ items, totalLabel }: { items: CategorySlice[]; totalLabel: string }) {
  if (items.length === 0) {
    return <Text style={styles.empty}>No sales yet in this range.</Text>;
  }

  const slices = foldToTopThree(items);
  const total = slices.reduce((sum, item) => sum + item.value, 0);

  let cumulativePct = 0;
  const arcs = slices.map((slice, i) => {
    const pct = total > 0 ? (slice.value / total) * 100 : 0;
    const dashLength = (pct / 100) * CIRCUMFERENCE;
    const dashOffset = -(cumulativePct / 100) * CIRCUMFERENCE;
    cumulativePct += pct;
    return { ...slice, pct, dashLength, dashOffset, color: SLOT_COLORS[i] };
  });

  return (
    <View style={styles.row}>
      <View style={styles.donutWrap}>
        <Svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`}>
          <G transform={`rotate(-90, ${SIZE / 2}, ${SIZE / 2})`}>
            <Circle cx={SIZE / 2} cy={SIZE / 2} r={RADIUS} stroke={theme.surfaceMuted} strokeWidth={STROKE} fill="none" />
            {arcs.map((arc) => (
              <Circle
                key={arc.category}
                cx={SIZE / 2}
                cy={SIZE / 2}
                r={RADIUS}
                stroke={arc.color}
                strokeWidth={STROKE}
                fill="none"
                strokeDasharray={`${Math.max(0, arc.dashLength - GAP)} ${CIRCUMFERENCE}`}
                strokeDashoffset={arc.dashOffset}
              />
            ))}
          </G>
        </Svg>
        <View style={styles.centerLabel} pointerEvents="none">
          <Text style={styles.centerValue}>{total.toLocaleString()}</Text>
          <Text style={styles.centerCaption}>{totalLabel}</Text>
        </View>
      </View>
      <View style={styles.legend}>
        {arcs.map((arc) => (
          <View key={arc.category} style={styles.legendItem}>
            <View style={[styles.swatch, { backgroundColor: arc.color }]} />
            <Text style={styles.legendName} numberOfLines={1}>{arc.category}</Text>
            <Text style={styles.legendPct}>{Math.round(arc.pct)}%</Text>
          </View>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 20 },
  donutWrap: { width: SIZE, height: SIZE, alignItems: 'center', justifyContent: 'center' },
  centerLabel: { position: 'absolute', alignItems: 'center' },
  centerValue: { fontSize: 19, fontWeight: '800', color: theme.text, letterSpacing: -0.5 },
  centerCaption: { fontSize: 10, fontWeight: '700', color: theme.textSecondary, marginTop: 1 },
  legend: { flex: 1, gap: 9 },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  swatch: { width: 10, height: 10, borderRadius: 3 },
  legendName: { flex: 1, fontSize: 12, fontWeight: '700', color: theme.text },
  legendPct: { fontSize: 11.5, fontWeight: '700', color: theme.textSecondary },
  empty: { fontSize: 13, color: theme.textSecondary, paddingVertical: 4 },
});
