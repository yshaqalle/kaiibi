import { useMemo, useState } from 'react';
import type { GestureResponderEvent, LayoutChangeEvent } from 'react-native';
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import Svg, { Circle, Line, Path } from 'react-native-svg';

import { BandFoot, BandSegment, BentoBand, ON_INK_MUTED } from '@/components/ui/bento-band';
import { Colors } from '@/constants/theme';
import { formatAccountingCents, formatCompactCents } from '@/lib/currency';
import { hourlyTakings, type DailyBucket } from '@/lib/sales-reporting';
import { tradingHourBounds, weekdayKeyFor, type OpeningHours } from '@/lib/store-hours';
import type { Sale } from '@/types/models';

const theme = Colors.light;

const W = 300;
const H = 96;
const PAD_TOP = 14;

type Granularity = 'hours' | 'days';

/**
 * When the money actually comes in.
 *
 * The one card here that needs nothing kaiibi does not already hold: every
 * sale carries `createdAt`, and Settings already knows the opening hours. The
 * decisions it answers are staffing and closing time, which nothing else on
 * this screen touches.
 *
 * Two views, because they answer different questions. *Hours* is about one
 * day and needs a day picked; *Days* is about the week and compares each day
 * against what that weekday usually takes — a flat average would call every
 * Saturday a triumph and every Monday a disaster.
 */
export function OpenHoursCard({
  sales,
  daily,
  openingHours,
  rangeLabel,
}: {
  /** Every sale in the range, with items — the same set the P&L consumed. */
  sales: Sale[];
  daily: DailyBucket[];
  openingHours: OpeningHours;
  rangeLabel: string;
}) {
  const [granularity, setGranularity] = useState<Granularity>('hours');
  // Which day of the strip is picked, as an index into `daily`. Null means
  // "the last day in the range", re-resolved on every render so changing the
  // date range cannot strand the selection on a day that is no longer in it.
  const [selectedDay, setSelectedDay] = useState<string | null>(null);

  const selected = useMemo(
    () => daily.find((bucket) => bucket.day === selectedDay) ?? daily[daily.length - 1],
    [daily, selectedDay]
  );

  const hourly = useMemo(() => {
    if (!selected) return null;
    const date = new Date(`${selected.day}T00:00:00`);
    const bounds = tradingHourBounds(openingHours, weekdayKeyFor(date));
    if (!bounds) return null;
    const onDay = sales.filter((sale) => sameDay(new Date(sale.createdAt), date));
    return { date, ...hourlyTakings(onDay, bounds.openHour, bounds.closeHour) };
  }, [sales, selected, openingHours]);

  const dayPoints = useMemo(
    () =>
      daily.map((bucket) => ({
        label: shortWeekday(new Date(`${bucket.day}T00:00:00`)),
        value: bucket.netRevenueCents,
      })),
    [daily]
  );

  const hourPoints = useMemo(
    () => hourly?.buckets.map((bucket) => ({ label: hourLabel(bucket.hour), value: bucket.grossCents })) ?? [],
    [hourly]
  );

  const showingHours = granularity === 'hours';
  const points = showingHours ? hourPoints : dayPoints;

  return (
    <BentoBand
      title="Open hours"
      blurb="When money comes through the till, against the hours you are open. Staffing and closing time are what this answers."
      actions={
        <BandSegment<Granularity>
          value={granularity}
          onChange={setGranularity}
          options={[
            { key: 'hours', label: 'Hours' },
            { key: 'days', label: 'Days' },
          ]}
        />
      }
    >
      {showingHours && daily.length > 1 ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.strip}>
          {daily.map((bucket) => {
            const date = new Date(`${bucket.day}T00:00:00`);
            const shut = tradingHourBounds(openingHours, weekdayKeyFor(date)) === null;
            const on = selected?.day === bucket.day;
            return (
              <Pressable
                key={bucket.day}
                // A closed day is not a quiet day, and pressing one must not
                // draw a flat line that reads as a catastrophic Sunday.
                disabled={shut}
                onPress={() => setSelectedDay(bucket.day)}
                style={[styles.dayPill, on && styles.dayPillOn, shut && styles.dayPillShut]}
                role="button"
                aria-selected={on}
              >
                <Text style={[styles.dayNum, on && styles.dayTextOn]}>{String(date.getDate()).padStart(2, '0')}</Text>
                <Text style={[styles.dayName, on && styles.dayTextOn]}>{shortWeekday(date)}</Text>
              </Pressable>
            );
          })}
        </ScrollView>
      ) : null}

      {showingHours && !hourly ? (
        <BandFoot>
          {selected
            ? `The shop is closed on ${longWeekday(new Date(`${selected.day}T00:00:00`))}, so there are no trading hours to plot. Pick another day, or set hours in Settings.`
            : 'No opening hours are set yet — add them in Settings and this fills in.'}
        </BandFoot>
      ) : (
        <InkAreaChart
          points={points}
          formatValue={showingHours ? formatAccountingCents : formatCompactCents}
        />
      )}

      <BandFoot>
        {showingHours
          ? hourly
            ? `${longWeekday(hourly.date)} ${hourly.date.getDate()} · takings by hour, tax included.` +
              (hourly.outsideCents > 0
                ? ` ${formatAccountingCents(hourly.outsideCents)} was rung up outside your posted hours and is shown in the nearest open hour.`
                : '')
            : ''
          : `Net revenue per day across the ${rangeLabel.toLowerCase()}.`}
      </BandFoot>
    </BentoBand>
  );
}

/** The area chart on ink. Its own component because every colour differs. */
function InkAreaChart({
  points,
  formatValue,
}: {
  points: { label: string; value: number }[];
  formatValue: (value: number) => string;
}) {
  const [width, setWidth] = useState(W);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);

  const plotted = useMemo(() => {
    const max = Math.max(1, ...points.map((p) => p.value));
    return points.map((point, i) => ({
      x: points.length === 1 ? W / 2 : (i / (points.length - 1)) * W,
      y: PAD_TOP + H - (point.value / max) * H,
    }));
  }, [points]);

  if (points.length === 0) return <Text style={styles.empty}>Nothing was rung up in this window.</Text>;

  const line = plotted.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  const area =
    plotted.length > 1
      ? `${line} L${plotted[plotted.length - 1].x.toFixed(1)},${PAD_TOP + H} L${plotted[0].x.toFixed(1)},${PAD_TOP + H} Z`
      : '';
  const peakIndex = points.reduce((best, p, i) => (p.value > points[best].value ? i : best), 0);
  const active = activeIndex !== null ? plotted[activeIndex] : null;
  const activePoint = activeIndex !== null ? points[activeIndex] : null;

  function handlePointer(x: number) {
    if (width === 0 || plotted.length === 0) return;
    const relX = (x / width) * W;
    let best = 0;
    plotted.forEach((p, i) => {
      if (Math.abs(p.x - relX) < Math.abs(plotted[best].x - relX)) best = i;
    });
    setActiveIndex(best);
  }
  const handleTouch = (e: GestureResponderEvent) => handlePointer(e.nativeEvent.locationX);
  const webHoverProps =
    Platform.OS === 'web'
      ? {
          onMouseMove: (e: { nativeEvent: { offsetX?: number; locationX?: number } }) =>
            handlePointer(e.nativeEvent.offsetX ?? e.nativeEvent.locationX ?? 0),
          onMouseLeave: () => setActiveIndex(null),
        }
      : {};

  return (
    <View style={styles.chartBlock}>
      <View style={styles.chartArea}>
        <View
          style={styles.touchArea}
          onLayout={(e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width)}
          onStartShouldSetResponder={() => true}
          onMoveShouldSetResponder={() => true}
          onResponderGrant={handleTouch}
          onResponderMove={handleTouch}
          onResponderRelease={() => setActiveIndex(null)}
          {...webHoverProps}
        >
          <Svg width="100%" height={124} viewBox={`0 0 ${W} ${PAD_TOP + H}`} preserveAspectRatio="none">
            <Line x1={0} y1={PAD_TOP} x2={W} y2={PAD_TOP} stroke="rgba(255,255,255,0.09)" strokeWidth={1} />
            <Line x1={0} y1={PAD_TOP + H / 2} x2={W} y2={PAD_TOP + H / 2} stroke="rgba(255,255,255,0.09)" strokeWidth={1} />
            <Line x1={0} y1={PAD_TOP + H} x2={W} y2={PAD_TOP + H} stroke="rgba(255,255,255,0.16)" strokeWidth={1} />
            {area ? <Path d={area} fill={theme.bentoSeries1} opacity={0.28} /> : null}
            <Path
              d={line}
              fill="none"
              stroke={theme.bentoSeries1}
              strokeWidth={2.5}
              strokeLinejoin="round"
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
            />
            {/* Only the busiest point is marked. A dot on all thirteen hours
                is a row of dots, not an emphasis. */}
            <Circle cx={plotted[peakIndex].x} cy={plotted[peakIndex].y} r={4} fill="#ffffff" />
            {active ? (
              <Line x1={active.x} y1={PAD_TOP} x2={active.x} y2={PAD_TOP + H} stroke="rgba(255,255,255,0.45)" strokeWidth={1} />
            ) : null}
          </Svg>
        </View>
        {activePoint && active ? (
          <View
            pointerEvents="none"
            style={[
              styles.tooltip,
              { left: Math.min(Math.max((active.x / W) * width - 40, 0), Math.max(width - 80, 0)) },
            ]}
          >
            <Text style={styles.tooltipValue}>{formatValue(activePoint.value)}</Text>
            <Text style={styles.tooltipLabel}>{activePoint.label}</Text>
          </View>
        ) : null}
      </View>

      {/* Labels are RN Text under the plot, not SVG text: the viewBox
          stretches horizontally, and stretched glyphs are unreadable. Thinned
          so they never collide — a 13-hour day prints every other hour. */}
      <View style={styles.labelRow}>
        {points.map((point, i) => (
          <Text key={i} style={styles.axisLabel} numberOfLines={1}>
            {i % labelStep(points.length) === 0 ? point.label : ''}
          </Text>
        ))}
      </View>
      <Text style={styles.peakNote}>
        {`Busiest ${points[peakIndex].label} · ${formatValue(points[peakIndex].value)}`}
      </Text>
    </View>
  );
}

// Roughly seven labels, whatever the series length.
function labelStep(count: number): number {
  return Math.max(1, Math.ceil(count / 7));
}

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}
function shortWeekday(date: Date): string {
  return date.toLocaleDateString(undefined, { weekday: 'short' });
}
function longWeekday(date: Date): string {
  return date.toLocaleDateString(undefined, { weekday: 'long' });
}
function hourLabel(hour: number): string {
  const suffix = hour < 12 ? 'am' : 'pm';
  const twelve = hour % 12 === 0 ? 12 : hour % 12;
  return `${twelve}${suffix}`;
}

const styles = StyleSheet.create({
  strip: { gap: 7, paddingVertical: 14, paddingRight: 4 },
  dayPill: {
    width: 50,
    paddingVertical: 8,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.16)',
    backgroundColor: 'rgba(255,255,255,0.05)',
    alignItems: 'center',
  },
  dayPillOn: { backgroundColor: '#ffffff', borderColor: '#ffffff' },
  dayPillShut: { opacity: 0.4 },
  dayNum: { fontSize: 14, fontWeight: '800', color: '#ffffff', fontVariant: ['tabular-nums'] },
  dayName: { fontSize: 9.5, color: ON_INK_MUTED, marginTop: 2, textTransform: 'uppercase' },
  dayTextOn: { color: theme.bentoInk },

  chartBlock: { marginTop: 6 },
  chartArea: { position: 'relative' },
  touchArea: { width: '100%' },
  tooltip: {
    position: 'absolute',
    top: -8,
    width: 80,
    paddingHorizontal: 8,
    paddingVertical: 5,
    borderRadius: 8,
    alignItems: 'center',
    // White on ink, inverting the light-surface tooltip: a near-black bubble
    // on a near-black card has no edge.
    backgroundColor: '#ffffff',
  },
  tooltipValue: { fontSize: 11, fontWeight: '800', color: theme.bentoInk, fontVariant: ['tabular-nums'] },
  tooltipLabel: { fontSize: 9, fontWeight: '600', color: theme.bentoMuted, marginTop: 1 },
  labelRow: { flexDirection: 'row', marginTop: 6 },
  axisLabel: { flex: 1, textAlign: 'center', fontSize: 9.5, fontWeight: '700', color: ON_INK_MUTED },
  peakNote: { fontSize: 11.5, fontWeight: '700', color: '#ffffff', marginTop: 8, fontVariant: ['tabular-nums'] },
  empty: { fontSize: 13, color: ON_INK_MUTED, paddingVertical: 16 },
});
