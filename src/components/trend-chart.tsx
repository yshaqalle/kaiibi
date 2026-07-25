import { useMemo, useState } from 'react';
import type { GestureResponderEvent, LayoutChangeEvent } from 'react-native';
import { Platform, StyleSheet, Text, View } from 'react-native';
import Svg, { Circle, Line, Path } from 'react-native-svg';

import { Colors } from '@/constants/theme';

// Pinned to the light palette for now — no dark-mode switching yet.
const theme = Colors.light;

const W = 300;
const H = 100;
const PAD_TOP = 14;

export type TrendPoint = { label: string; value: number };

export function TrendChart({ data, formatValue }: { data: TrendPoint[]; formatValue: (value: number) => string }) {
  const [width, setWidth] = useState(W);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);

  const points = useMemo(() => {
    const values = data.map((d) => d.value);
    const max = Math.max(1, ...values);
    const min = Math.min(0, ...values);
    const span = Math.max(1, max - min);
    return data.map((d, i) => ({
      x: data.length === 1 ? 0 : (i / (data.length - 1)) * W,
      y: PAD_TOP + (H - ((d.value - min) / span) * H),
    }));
  }, [data]);

  if (data.length === 0) return null;

  const linePath = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  const areaPath = `${linePath} L${points[points.length - 1].x.toFixed(1)},${PAD_TOP + H} L${points[0].x.toFixed(1)},${PAD_TOP + H} Z`;
  const last = points[points.length - 1];
  const active = activeIndex !== null ? points[activeIndex] : null;
  const activePoint = activeIndex !== null ? data[activeIndex] : null;

  function handlePointer(x: number) {
    if (width === 0) return;
    const relX = (x / width) * W;
    let best = 0;
    let bestDist = Infinity;
    points.forEach((p, i) => {
      const dist = Math.abs(p.x - relX);
      if (dist < bestDist) { bestDist = dist; best = i; }
    });
    setActiveIndex(best);
  }

  function handleTouch(e: GestureResponderEvent) {
    handlePointer(e.nativeEvent.locationX);
  }

  // Web has no press-and-drag convention for revealing a value — a plain
  // hover should show the tooltip, so mouse move/leave are wired alongside
  // the touch responder (which covers native drag-to-scrub).
  function handleMouseMove(e: { nativeEvent: { offsetX?: number; locationX?: number } }) {
    handlePointer(e.nativeEvent.offsetX ?? e.nativeEvent.locationX ?? 0);
  }
  const webHoverProps =
    Platform.OS === 'web' ? { onMouseMove: handleMouseMove, onMouseLeave: () => setActiveIndex(null) } : {};

  return (
    <View>
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
            <Line x1={0} y1={PAD_TOP + H} x2={W} y2={PAD_TOP + H} stroke={theme.border} strokeWidth={1} />
            <Path d={areaPath} fill={theme.chartAccent} opacity={0.1} />
            <Path d={linePath} fill="none" stroke={theme.chartAccent} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
            <Circle cx={last.x} cy={last.y} r={6} fill={theme.surface} />
            <Circle cx={last.x} cy={last.y} r={4} fill={theme.chartAccent} />
            {active ? (
              <>
                <Line x1={active.x} y1={PAD_TOP} x2={active.x} y2={PAD_TOP + H} stroke={theme.textSecondary} strokeWidth={1} opacity={0.5} />
                <Circle cx={active.x} cy={active.y} r={5} fill={theme.chartAccent} stroke={theme.surface} strokeWidth={2} />
              </>
            ) : null}
          </Svg>
        </View>
        {activePoint && active ? (
          <View
            pointerEvents="none"
            style={[
              styles.tooltip,
              { backgroundColor: theme.text, left: Math.min(Math.max((active.x / W) * width - 34, 0), Math.max(width - 68, 0)) },
            ]}
          >
            <Text style={[styles.tooltipValue, { color: theme.background }]}>{formatValue(activePoint.value)}</Text>
            <Text style={[styles.tooltipLabel, { color: theme.textSecondary }]}>{activePoint.label}</Text>
          </View>
        ) : null}
      </View>
      {data.length <= 10 ? (
        <View style={styles.daysRow}>
          {data.map((d, i) => (
            <Text key={i} style={[styles.dayLabel, { color: theme.textSecondary }]}>{d.label}</Text>
          ))}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  chartArea: { position: 'relative' },
  touchArea: { width: '100%' },
  tooltip: { position: 'absolute', top: -6, paddingHorizontal: 8, paddingVertical: 5, borderRadius: 7, alignItems: 'center', width: 68 },
  tooltipValue: { fontSize: 11, fontWeight: '700' },
  tooltipLabel: { fontSize: 9, fontWeight: '600', marginTop: 1 },
  daysRow: { flexDirection: 'row', marginTop: 6 },
  dayLabel: { flex: 1, textAlign: 'center', fontSize: 9.5, fontWeight: '700' },
});
