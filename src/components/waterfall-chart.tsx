import { useMemo, useState } from 'react';
import type { LayoutChangeEvent } from 'react-native';
import { StyleSheet, Text, View } from 'react-native';
import Svg, { G, Line, Rect, Text as SvgText } from 'react-native-svg';

import { Colors } from '@/constants/theme';

const theme = Colors.light;

// How revenue becomes profit, as a waterfall: each step either restates the
// running total (a subtotal bar rising from zero) or moves it (a floating bar
// spanning from the previous total to the new one).
//
// The point of the form is that the DROPS are visible as drops. A P&L states
// the same five figures in a column and is exact, but nothing in it shows that
// cost of goods ate two thirds of revenue -- you have to do that division
// yourself. This does it visually and keeps the exact figure on every bar.
//
// Every bar is directly labelled, and that is not decoration: profit green and
// loss red sit at ΔE 4.0 for deutan viewers, so the colour alone cannot be
// what tells a reader whether a step added or removed money. The signed label
// carries it; the colour reinforces it.

export type WaterfallStep = {
  label: string;
  /** Secondary caption under the label. Dropped on narrow layouts. */
  sub?: string;
  /**
   * For a step, the signed movement. For a subtotal (`total: true`), the
   * running total itself -- the bar is drawn from zero.
   */
  value: number;
  total?: boolean;
};

const VIEW_W = 620;
const VIEW_H = 230;
const PAD_L = 46;
const PAD_R = 14;
const PAD_T = 16;
const PAD_B = 44;

// Below this the five labels collide, so the captions go and the type steps
// up in user units -- an SVG scales its text with the viewBox, so a 10.5-unit
// label lands at about 5px on a 360px-wide phone.
const COMPACT_WIDTH = 520;

export function WaterfallChart({
  steps,
  formatValue,
}: {
  steps: WaterfallStep[];
  formatValue: (value: number) => string;
}) {
  const [width, setWidth] = useState(0);
  const compact = width > 0 && width < COMPACT_WIDTH;
  const onLayout = (event: LayoutChangeEvent) => setWidth(event.nativeEvent.layout.width);

  const geometry = useMemo(() => {
    const innerW = VIEW_W - PAD_L - PAD_R;
    const innerH = VIEW_H - PAD_T - PAD_B;

    // Walk the steps once to find where each bar starts and ends.
    //
    // A plain loop rather than `map` with an accumulator in the enclosing
    // scope: the running total is genuinely sequential state, and reassigning
    // it from inside a callback is what the immutability lint rule (rightly)
    // objects to.
    const bars: { from: number; to: number }[] = [];
    let running = 0;
    for (const step of steps) {
      if (step.total) {
        bars.push({ from: 0, to: step.value });
        running = step.value;
      } else {
        const to = running + step.value;
        bars.push({ from: running, to });
        running = to;
      }
    }

    // Zero is always in the scale: a waterfall that omits it can show a loss
    // as a bar that merely looks short.
    const values = bars.flatMap((bar) => [bar.from, bar.to]).concat([0]);
    const max = Math.max(...values);
    const min = Math.min(...values);
    const span = max - min || 1;
    const y = (value: number) => PAD_T + innerH - ((value - min) / span) * innerH;

    const slot = innerW / Math.max(1, steps.length);
    const barWidth = Math.min(56, slot * 0.56);

    return { bars, y, slot, barWidth, innerH, zeroY: y(0) };
  }, [steps]);

  const { bars, y, slot, barWidth, zeroY } = geometry;
  const labelSize = compact ? 15 : 11.5;
  const tickSize = compact ? 14 : 10.5;

  return (
    <View onLayout={onLayout}>
      <Svg viewBox={`0 0 ${VIEW_W} ${VIEW_H}`} width="100%" height={compact ? 210 : 230}>
        {/* The zero line, dashed so it reads as a reference rather than as
            another bar edge. */}
        <Line
          x1={PAD_L}
          y1={zeroY}
          x2={VIEW_W - PAD_R}
          y2={zeroY}
          stroke={theme.bentoMuted2}
          strokeDasharray="3 3"
        />

        {steps.map((step, index) => {
          const bar = bars[index];
          const centre = PAD_L + slot * index + slot / 2;
          const top = Math.min(y(bar.from), y(bar.to));
          // Never zero-height: a step of exactly nothing still has to be
          // visible as a step, or the chart silently loses a row of the P&L.
          const height = Math.max(3, Math.abs(y(bar.to) - y(bar.from)));
          const colour = step.total
            ? bar.to >= 0
              ? theme.bentoSeries1
              : theme.bentoLoss
            : step.value >= 0
              ? theme.bentoProfit
              : theme.bentoLoss;

          // Connect this bar's top to the next one's, so the eye follows the
          // running total across. Skipped before a subtotal, which starts
          // from zero and so does not continue from here.
          const next = steps[index + 1];
          const connector =
            next && !next.total ? (
              <Line
                x1={centre + barWidth / 2}
                y1={y(bar.to)}
                x2={centre + slot - barWidth / 2}
                y2={y(bar.to)}
                stroke={theme.bentoMuted2}
                strokeDasharray="3 3"
              />
            ) : null;

          return (
            // G, not a nested Svg: a nested Svg establishes its own viewport
            // and would re-origin every coordinate inside it.
            <G key={`${step.label}-${index}`}>
              {connector}
              <Rect x={centre - barWidth / 2} y={top} width={barWidth} height={height} rx={5} fill={colour} />
              <SvgText
                x={centre}
                y={top - 6}
                textAnchor="middle"
                fontSize={labelSize}
                fontWeight="800"
                fill={theme.bentoInk}
              >
                {formatValue(step.total ? bar.to : step.value)}
              </SvgText>
              <SvgText x={centre} y={VIEW_H - 24} textAnchor="middle" fontSize={tickSize} fill={theme.bentoMuted}>
                {step.label}
              </SvgText>
              {step.sub && !compact ? (
                <SvgText x={centre} y={VIEW_H - 10} textAnchor="middle" fontSize={9.5} fill={theme.bentoMuted2}>
                  {step.sub}
                </SvgText>
              ) : null}
            </G>
          );
        })}
      </Svg>
      {steps.length === 0 ? <Text style={styles.empty}>Nothing to chart yet.</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  empty: { color: theme.bentoMuted, fontSize: 13, textAlign: 'center', paddingVertical: 20 },
});
