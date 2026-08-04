import { StyleSheet, Text, View } from 'react-native';
import Svg, { Circle, G } from 'react-native-svg';

// Charts for the platform dashboard. Purpose-built rather than reusing the
// shop-side ones, which are typed to shop domain shapes (CategorySlice,
// TrendPoint) and fold to a top three that would hide a plan.
//
// One palette, used consistently: a series keeps its colour wherever it
// appears, so "violet" always means signups and "green" always means money.
export const CHART_COLORS = {
  signups: '#7C5CFC',
  revenue: '#1E9E5A',
  trial: '#7C5CFC',
  free: '#94A3B8',
  standard: '#2563EB',
  pro: '#F59E0B',
  danger: '#DC2626',
} as const;

const PLAN_COLORS: Record<string, string> = {
  trial: CHART_COLORS.trial,
  free: CHART_COLORS.free,
  standard: CHART_COLORS.standard,
  pro: CHART_COLORS.pro,
};

export function planColor(key: string, index: number): string {
  return PLAN_COLORS[key] ?? [CHART_COLORS.standard, CHART_COLORS.pro, CHART_COLORS.signups, CHART_COLORS.free][index % 4];
}

export type Bar = { label: string; value: number };

// A column chart built from plain Views rather than SVG: the bars are
// rectangles, and flex heights reflow correctly at any width without having to
// measure the container first.
export function BarChart({
  bars,
  color,
  formatValue,
  height = 132,
}: {
  bars: Bar[];
  color: string;
  formatValue?: (v: number) => string;
  height?: number;
}) {
  const max = Math.max(1, ...bars.map((b) => b.value));
  const allZero = bars.every((b) => b.value === 0);

  return (
    <View>
      <View style={[styles.plot, { height }]}>
        {bars.map((bar, i) => {
          // A zero bar still gets 2px so the axis reads as a row of periods
          // rather than a gap someone has to count across.
          const h = allZero ? 2 : Math.max(2, (bar.value / max) * (height - 22));
          return (
            <View key={`${bar.label}-${i}`} style={styles.col}>
              {bar.value > 0 && (
                <Text style={[styles.barValue, { color }]} numberOfLines={1}>
                  {formatValue ? formatValue(bar.value) : bar.value}
                </Text>
              )}
              <View style={[styles.bar, { height: h, backgroundColor: bar.value > 0 ? color : '#E8E8EF' }]} />
            </View>
          );
        })}
      </View>
      <View style={styles.axis}>
        {bars.map((bar, i) => (
          <Text key={`${bar.label}-x-${i}`} style={styles.axisLabel} numberOfLines={1}>
            {bar.label}
          </Text>
        ))}
      </View>
    </View>
  );
}

export type Slice = { key: string; label: string; value: number; color: string };

// Donut drawn as one circle per slice using stroke-dasharray, the same
// technique as the shop-side category chart — no path maths, and it degrades
// cleanly to a single ring when only one plan has shops on it.
export function DonutChart({ slices, centerValue, centerLabel }: { slices: Slice[]; centerValue: string; centerLabel: string }) {
  const size = 148;
  const stroke = 20;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const total = slices.reduce((sum, s) => sum + s.value, 0);

  // Reduced rather than accumulated into a closed-over variable: each arc's
  // offset is the sum of the ones before it, which is a fold, not a mutation.
  const arcs = slices
    .filter((s) => s.value > 0)
    .reduce<{ key: string; color: string; dash: number; offset: number }[]>((acc, slice) => {
      const pct = total > 0 ? slice.value / total : 0;
      const usedPct = acc.reduce((sum, a) => sum + a.dash, 0) / circumference;
      return [...acc, { key: slice.key, color: slice.color, dash: pct * circumference, offset: -(usedPct * circumference) }];
    }, []);

  return (
    <View style={styles.donutRow}>
      <View>
        <Svg width={size} height={size}>
          <G rotation={-90} origin={`${size / 2}, ${size / 2}`}>
            <Circle cx={size / 2} cy={size / 2} r={radius} stroke="#F1F1F5" strokeWidth={stroke} fill="none" />
            {arcs.map((arc) => (
              <Circle
                key={arc.key}
                cx={size / 2}
                cy={size / 2}
                r={radius}
                stroke={arc.color}
                strokeWidth={stroke}
                fill="none"
                strokeDasharray={`${arc.dash} ${circumference - arc.dash}`}
                strokeDashoffset={arc.offset}
              />
            ))}
          </G>
        </Svg>
        <View style={[styles.donutCenter, { width: size, height: size }]}>
          <Text style={styles.donutValue}>{centerValue}</Text>
          <Text style={styles.donutLabel}>{centerLabel}</Text>
        </View>
      </View>

      <View style={styles.legend}>
        {slices.map((slice) => (
          <View key={slice.key} style={styles.legendRow}>
            <View style={[styles.swatch, { backgroundColor: slice.color }]} />
            <Text style={styles.legendLabel}>{slice.label}</Text>
            <Text style={styles.legendValue}>{slice.value}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  plot: { flexDirection: 'row', alignItems: 'flex-end', gap: 6 },
  col: { flex: 1, alignItems: 'center', justifyContent: 'flex-end', gap: 4 },
  bar: { width: '100%', maxWidth: 46, borderRadius: 5 },
  barValue: { fontSize: 10.5, fontWeight: '800' },
  axis: { flexDirection: 'row', gap: 6, marginTop: 6 },
  axisLabel: { flex: 1, textAlign: 'center', fontSize: 10, color: '#AAAAAA' },
  donutRow: { flexDirection: 'row', alignItems: 'center', gap: 24, flexWrap: 'wrap' },
  donutCenter: { position: 'absolute', alignItems: 'center', justifyContent: 'center' },
  donutValue: { fontSize: 22, fontWeight: '800', color: '#111111' },
  donutLabel: { fontSize: 10, color: '#999999', marginTop: 1 },
  legend: { gap: 8, minWidth: 150 },
  legendRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  swatch: { width: 10, height: 10, borderRadius: 3 },
  legendLabel: { fontSize: 12.5, color: '#555555', flex: 1 },
  legendValue: { fontSize: 12.5, fontWeight: '800', color: '#111111' },
});
