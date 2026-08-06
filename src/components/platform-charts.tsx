import { StyleSheet, Text, View } from 'react-native';
import Svg, { Circle, G } from 'react-native-svg';

import { Colors } from '@/constants/theme';

// Pinned to the light palette for now — no dark-mode switching yet.
const theme = Colors.light;

// Charts for the platform console. Purpose-built rather than reusing the
// shop-side ones, which are typed to shop domain shapes (CategorySlice,
// TrendPoint) and fold to a top three that would hide a plan.
//
// These used to carry their own seven hues — violet signups, green revenue,
// amber Pro — a palette that predated bento and collided with it twice. Its
// green sat a hair off `bentoProfit`, so a green bar and a green figure on the
// same screen disagreed by an amount you could see but not name; and "green
// always means money" is exactly the overload the series tokens exist to
// prevent, since green is status here and money is the subject of the whole
// screen.
//
// The property that comment actually cared about survives: a series keeps its
// colour wherever it appears.
export const CHART_COLORS = {
  signups: theme.bentoSeries1,
  revenue: theme.bentoSeries2,
} as const;

// Plans keep a stable colour across the donut, the tier cards and the
// revenue-by-plan bars, so a tier is recognisable by colour in all three. Keyed
// where we know the key, by position otherwise — a plan added in SQL still gets
// a colour rather than falling through to undefined.
const SERIES = [theme.bentoSeries1, theme.bentoSeries2, theme.bentoSeries3, theme.bentoSeries4];

const PLAN_COLORS: Record<string, string> = {
  trial: theme.bentoSeries1,
  free: theme.bentoMuted2,
  standard: theme.bentoSeries2,
  pro: theme.bentoSeries3,
};

export function planColor(key: string, index: number): string {
  return PLAN_COLORS[key] ?? SERIES[index % SERIES.length];
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
              <View style={[styles.bar, { height: h, backgroundColor: bar.value > 0 ? color : theme.bentoLine }]} />
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
          {/* An SVG `transform` string rather than react-native-svg's
              rotation/origin props: those compile to a `transform-origin` DOM
              attribute on web, which React rejects outright ("Invalid DOM
              property"). The rotate() form is understood by both renderers.
              -90° puts the first arc at 12 o'clock instead of 3. */}
          <G transform={`rotate(-90 ${size / 2} ${size / 2})`}>
            <Circle cx={size / 2} cy={size / 2} r={radius} stroke={theme.bentoSoft} strokeWidth={stroke} fill="none" />
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
  axisLabel: { flex: 1, textAlign: 'center', fontSize: 10, color: theme.bentoMuted2 },
  donutRow: { flexDirection: 'row', alignItems: 'center', gap: 24, flexWrap: 'wrap' },
  donutCenter: { position: 'absolute', alignItems: 'center', justifyContent: 'center' },
  donutValue: { fontSize: 22, fontWeight: '800', color: theme.bentoInk, letterSpacing: -0.6 },
  donutLabel: { fontSize: 10, color: theme.bentoMuted, marginTop: 1 },
  legend: { gap: 8, minWidth: 150 },
  legendRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  swatch: { width: 10, height: 10, borderRadius: 3 },
  legendLabel: { fontSize: 12.5, color: theme.bentoInk2, flex: 1 },
  legendValue: { fontSize: 12.5, fontWeight: '800', color: theme.bentoInk, fontVariant: ['tabular-nums'] },
});
