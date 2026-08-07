import { useMemo, useState } from 'react';
import type { GestureResponderEvent, LayoutChangeEvent } from 'react-native';
import { Platform, StyleSheet, Text, View } from 'react-native';
import Svg, { G, Line, Rect } from 'react-native-svg';

import { Colors } from '@/constants/theme';

// Pinned to the light palette for now — no dark-mode switching yet.
const theme = Colors.light;

const W = 300;
const H = 100;
const PAD_TOP = 14;
// Matches TrendChart's, so a bar chart and a line chart stacked in one column
// have their plots starting at the same x.
const AXIS_WIDTH = 42;

// Same rule as TrendChart's `niceCeiling`, kept in step deliberately: a bar
// chart and a line chart of the same series must not label different maxima.
function niceCeiling(value: number): number {
  if (value <= 0) return 0;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 2, 2.5, 5, 10]) {
    const candidate = step * magnitude;
    if (candidate >= value) return candidate;
  }
  return 10 * magnitude;
}

export type BarPoint = { label: string; value: number };

/**
 * "How much on each day", with the busiest one called out.
 *
 * Bars rather than a line because an order count is a set of separate
 * quantities, not a continuous quantity sampled over time — a line between
 * Tuesday's 25 orders and Wednesday's 33 draws values at 2:30pm that were
 * never a thing.
 *
 * Only the peak takes the full-strength hue; the rest take `bentoSeriesSoft`.
 * That is a real second colour rather than an opacity of the first — an 18%
 * wash of the accent lands at 1.3:1 on white, which on a phone in daylight is
 * a bar you cannot see at all.
 */
export function BarChart({
  data,
  formatValue,
  emptyLabel = 'Nothing recorded in this range.',
}: {
  data: BarPoint[];
  formatValue: (value: number) => string;
  emptyLabel?: string;
}) {
  const [width, setWidth] = useState(W);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);

  const { bars, scale, peakIndex } = useMemo(() => {
    const values = data.map((d) => d.value);
    const top = Math.max(niceCeiling(Math.max(0, ...values)), 1);
    const slot = data.length > 0 ? W / data.length : W;
    // Capped as well as proportional: at 30 days a proportional bar is a
    // hairline, and at 1 day it is a block the width of the card.
    const barWidth = Math.max(3, Math.min(26, slot * 0.6));
    return {
      bars: data.map((d, i) => {
        // A 2px floor so a small-but-nonzero day is a bar, not a gap. Zero
        // stays zero -- a day with no sales must not draw a stub that reads
        // as a sale.
        const height = d.value > 0 ? Math.max(2, (d.value / top) * H) : 0;
        return { x: slot * i + slot / 2 - barWidth / 2, y: PAD_TOP + H - height, height, width: barWidth };
      }),
      scale: [top, top / 2, 0],
      peakIndex: values.length ? values.indexOf(Math.max(...values)) : -1,
    };
  }, [data]);

  if (data.length === 0) return <Text style={styles.empty}>{emptyLabel}</Text>;

  const active = activeIndex !== null ? bars[activeIndex] : null;
  const activePoint = activeIndex !== null ? data[activeIndex] : null;

  function handlePointer(x: number) {
    if (width === 0) return;
    const slot = width / data.length;
    setActiveIndex(Math.max(0, Math.min(data.length - 1, Math.floor(x / slot))));
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
    <View>
      <View style={styles.chartRow}>
        <View style={styles.axis}>
          {scale.map((value, i) => (
            <Text key={i} style={styles.axisLabel} numberOfLines={1}>
              {formatValue(value)}
            </Text>
          ))}
        </View>
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
            {/* preserveAspectRatio="none" is safe here in a way it is not on a
                line chart: a rectangle stretched horizontally is still a
                rectangle, where a circular marker becomes an ellipse. The
                axis LABELS are RN Text in the gutter for the same reason
                TrendChart puts them there — text would stretch too. */}
            <Svg width="100%" height={128} viewBox={`0 0 ${W} ${PAD_TOP + H}`} preserveAspectRatio="none">
              <Line x1={0} y1={PAD_TOP} x2={W} y2={PAD_TOP} stroke={theme.bentoLine} strokeWidth={1} />
              <Line x1={0} y1={PAD_TOP + H / 2} x2={W} y2={PAD_TOP + H / 2} stroke={theme.bentoLine} strokeWidth={1} />
              <Line x1={0} y1={PAD_TOP + H} x2={W} y2={PAD_TOP + H} stroke={theme.bentoRule} strokeWidth={1} />
              {bars.map((bar, i) => (
                <Rect
                  key={i}
                  x={bar.x}
                  y={bar.y}
                  width={bar.width}
                  height={bar.height}
                  rx={2}
                  fill={i === peakIndex || i === activeIndex ? theme.bentoSeries1 : theme.bentoSeriesSoft}
                />
              ))}
            </Svg>
          </View>
          {activePoint && active ? (
            <View
              pointerEvents="none"
              style={[
                styles.tooltip,
                { left: Math.min(Math.max(((active.x + active.width / 2) / W) * width - 34, 0), Math.max(width - 68, 0)) },
              ]}
            >
              <Text style={styles.tooltipValue}>{formatValue(activePoint.value)}</Text>
              <Text style={styles.tooltipLabel}>{activePoint.label}</Text>
            </View>
          ) : null}
        </View>
      </View>
      {data.length <= 10 ? (
        <View style={styles.daysRow}>
          {data.map((d, i) => (
            <Text key={i} style={styles.dayLabel}>
              {d.label}
            </Text>
          ))}
        </View>
      ) : null}
    </View>
  );
}

export type GroupedBarPoint = { label: string; a: number; b: number };

/**
 * Two series side by side, day by day — revenue against expenses.
 *
 * Grouped, not stacked. Stacking would put expenses on top of revenue and
 * make the combined height mean nothing: these two are compared, not summed.
 */
export function GroupedBarChart({
  data,
  formatValue,
  colorA = theme.bentoSeries1,
  colorB = theme.bentoSeries3,
  labelA,
  labelB,
  emptyLabel = 'Nothing recorded in this range.',
}: {
  data: GroupedBarPoint[];
  formatValue: (value: number) => string;
  colorA?: string;
  colorB?: string;
  labelA: string;
  labelB: string;
  emptyLabel?: string;
}) {
  const [width, setWidth] = useState(W);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);

  const { groups, scale } = useMemo(() => {
    const top = Math.max(niceCeiling(Math.max(0, ...data.flatMap((d) => [d.a, d.b]))), 1);
    const slot = data.length > 0 ? W / data.length : W;
    const groupWidth = Math.max(4, Math.min(30, slot * 0.66));
    const barWidth = groupWidth / 2 - 1;
    return {
      groups: data.map((d, i) => {
        const centre = slot * i + slot / 2;
        const bar = (value: number, offset: number) => ({
          x: centre - groupWidth / 2 + offset,
          y: PAD_TOP + H - (value > 0 ? Math.max(2, (value / top) * H) : 0),
          height: value > 0 ? Math.max(2, (value / top) * H) : 0,
          width: barWidth,
        });
        return { centre, a: bar(d.a, 0), b: bar(d.b, barWidth + 2) };
      }),
      scale: [top, top / 2, 0],
    };
  }, [data]);

  if (data.length === 0) return <Text style={styles.empty}>{emptyLabel}</Text>;

  const activePoint = activeIndex !== null ? data[activeIndex] : null;
  const activeGroup = activeIndex !== null ? groups[activeIndex] : null;

  function handlePointer(x: number) {
    if (width === 0) return;
    const slot = width / data.length;
    setActiveIndex(Math.max(0, Math.min(data.length - 1, Math.floor(x / slot))));
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
    <View>
      <View style={styles.chartRow}>
        <View style={styles.axis}>
          {scale.map((value, i) => (
            <Text key={i} style={styles.axisLabel} numberOfLines={1}>
              {formatValue(value)}
            </Text>
          ))}
        </View>
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
            <Svg width="100%" height={128} viewBox={`0 0 ${W} ${PAD_TOP + H}`} preserveAspectRatio="none">
              <Line x1={0} y1={PAD_TOP} x2={W} y2={PAD_TOP} stroke={theme.bentoLine} strokeWidth={1} />
              <Line x1={0} y1={PAD_TOP + H / 2} x2={W} y2={PAD_TOP + H / 2} stroke={theme.bentoLine} strokeWidth={1} />
              <Line x1={0} y1={PAD_TOP + H} x2={W} y2={PAD_TOP + H} stroke={theme.bentoRule} strokeWidth={1} />
              {/* `G`, not `View`: a View inside an Svg is not a group, it is
                  an element the SVG renderer has no idea what to do with. */}
              {groups.map((group, i) => (
                <G key={i}>
                  <Rect x={group.a.x} y={group.a.y} width={group.a.width} height={group.a.height} rx={2} fill={colorA} />
                  <Rect x={group.b.x} y={group.b.y} width={group.b.width} height={group.b.height} rx={2} fill={colorB} />
                </G>
              ))}
            </Svg>
          </View>
          {activePoint && activeGroup ? (
            <View
              pointerEvents="none"
              style={[
                styles.tooltipWide,
                { left: Math.min(Math.max((activeGroup.centre / W) * width - 52, 0), Math.max(width - 104, 0)) },
              ]}
            >
              <Text style={styles.tooltipLabel}>{activePoint.label}</Text>
              <Text style={styles.tooltipValue}>{`${labelA} ${formatValue(activePoint.a)}`}</Text>
              <Text style={styles.tooltipValue}>{`${labelB} ${formatValue(activePoint.b)}`}</Text>
            </View>
          ) : null}
        </View>
      </View>
      {data.length <= 10 ? (
        <View style={styles.daysRow}>
          {data.map((d, i) => (
            <Text key={i} style={styles.dayLabel}>
              {d.label}
            </Text>
          ))}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  chartRow: { flexDirection: 'row', alignItems: 'stretch' },
  chartArea: { position: 'relative', flex: 1, minWidth: 0 },
  axis: { width: AXIS_WIDTH, height: 128, justifyContent: 'space-between', paddingVertical: 4, paddingRight: 6 },
  axisLabel: { fontSize: 9, fontWeight: '600', textAlign: 'right', color: theme.bentoMuted2 },
  touchArea: { width: '100%' },
  tooltip: {
    position: 'absolute',
    top: -6,
    width: 68,
    paddingHorizontal: 8,
    paddingVertical: 5,
    borderRadius: 7,
    alignItems: 'center',
    backgroundColor: theme.bentoInk,
  },
  tooltipWide: {
    position: 'absolute',
    top: -6,
    width: 104,
    paddingHorizontal: 9,
    paddingVertical: 6,
    borderRadius: 8,
    alignItems: 'flex-start',
    backgroundColor: theme.bentoInk,
  },
  tooltipValue: { fontSize: 11, fontWeight: '700', color: '#ffffff' },
  tooltipLabel: { fontSize: 9, fontWeight: '600', color: '#a6a6ae', marginTop: 1 },
  daysRow: { flexDirection: 'row', marginTop: 6, paddingLeft: AXIS_WIDTH },
  dayLabel: { flex: 1, textAlign: 'center', fontSize: 9.5, fontWeight: '700', color: theme.bentoMuted2 },
  empty: { fontSize: 13, color: theme.bentoMuted, paddingVertical: 12 },
});
