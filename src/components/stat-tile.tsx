import type { ReactNode } from 'react';
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
  badge,
  tone = 'default',
  sparkline,
  variant = 'default',
  density = 'default',
}: {
  value: string;
  label: string;
  hint?: string;
  delta?: { text: string; direction: 'up' | 'down' };
  /**
   * A rendered chip beside the figure — in practice `DeltaBadge`, which needs
   * the raw current/previous pair rather than a formatted string and already
   * knows to render nothing when there is no prior window.
   *
   * Kept separate from `delta` rather than replacing it: `delta` is the plain
   * coloured text the cream screens still use, and rewriting all of them to
   * pass a node is a bigger change than this one.
   */
  badge?: ReactNode;
  tone?: 'default' | 'warning' | 'positive';
  sparkline?: number[];
  /**
   * `bento` makes the tile an INSET panel rather than a card: soft grey fill,
   * 16px radius, no border.
   *
   * A default tile inside a bento card reads as a box within a box — a cream
   * hairline and a 12px corner sitting on a borderless 26px white card. On the
   * bento screens the card is already the container, so the tile only has to
   * separate itself from the card, which a fill does better than an outline.
   */
  variant?: 'default' | 'bento';
  /**
   * `dense` trims the tile's padding and figure size for a strip that has to
   * share the window with two scrolling panes below it (People). It changes
   * only the metrics -- the label, the value and the HINT all still render,
   * which is the point: a figure that doesn't say what is in and out of it
   * invites an argument, and that is exactly as true in a shorter tile.
   */
  density?: 'default' | 'dense';
}) {
  const bento = variant === 'bento';
  const dense = density === 'dense';

  return (
    <Card variant={bento ? 'bento' : 'default'} style={[styles.tile, bento && styles.tileBento, dense && styles.tileDense]}>
      {/* Two lines, so "Customers to check on" wraps between words instead of
          being broken mid-word by a column too narrow for the longest one. */}
      <Text style={[styles.label, bento && styles.labelBento]} numberOfLines={2}>
        {label.toUpperCase()}
      </Text>

      <View style={[styles.valueRow, dense && styles.valueRowDense]}>
        {/* Shrinks rather than overflows, and never wraps: a figure broken
            across two lines is harder to read than one scaled down. */}
        <Text
          style={[styles.value, dense && styles.valueDense, bento ? TONE_BENTO[tone] : TONE[tone]]}
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
        {badge}
      </View>

      {hint ? <Text style={[styles.hint, bento && styles.hintBento, dense && styles.hintDense]} numberOfLines={2}>{hint}</Text> : null}
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

// The bento ink ramp, not the cream one. `positive`/`warning` map to the
// status tokens, which stay legal here because a tile always shows the figure
// itself — the colour reinforces the number, it never replaces it.
const TONE_BENTO = StyleSheet.create({
  default: { color: theme.bentoInk },
  // bentoSeries3, not bentoLoss: red is reserved for a figure that IS negative,
  // and a signed number is always beside it. `warning` means "look at this" --
  // "Customers to check on: 4" is not a loss, and dressing it in the same red
  // as one spends the colour the screen needs for actual losses. Series 3 is an
  // already-validated amber, so this adds no unchecked hue.
  warning: { color: theme.bentoSeries3 },
  positive: { color: theme.bentoProfit },
});

const styles = StyleSheet.create({
  // `minWidth` is what makes the surrounding `flexWrap` row actually wrap.
  // With `flex: 1` alone the tiles shrink without limit, so five of them
  // squeeze onto one phone-width line, clipping the value and breaking the
  // label mid-word. Now they drop to the next line instead.
  tile: { flex: 1, minWidth: 148, minHeight: 92, padding: 14 },
  // 16, not BENTO_RADIUS: this is a panel inside a 26px card, and matching the
  // parent's corner makes the two read as the same surface.
  tileBento: { backgroundColor: theme.bentoSoft, borderRadius: 16 },
  // minWidth is deliberately NOT reduced: it is what makes the surrounding
  // flexWrap row actually wrap on a phone (see the comment on `tile`), and a
  // denser tile still needs a readable floor.
  tileDense: { minHeight: 74, padding: 9 },
  label: {
    fontSize: 9.5,
    letterSpacing: 1.1,
    fontWeight: '700',
    color: theme.textSecondary,
    lineHeight: 13,
  },
  labelBento: { color: theme.bentoMuted },
  valueRow: { flexDirection: 'row', alignItems: 'baseline', gap: 6, marginTop: 7 },
  valueRowDense: { marginTop: 5 },
  // flexShrink lets adjustsFontSizeToFit actually engage — without it the Text
  // keeps its intrinsic width and overflows the tile instead of scaling.
  value: { flexShrink: 1, fontSize: 24, letterSpacing: -1, fontWeight: '800', fontVariant: ['tabular-nums'] },
  valueDense: { fontSize: 20 },
  delta: { fontSize: 11, fontWeight: '700' },
  deltaUp: { color: theme.success },
  deltaDown: { color: theme.danger },
  hint: { fontSize: 11, color: theme.textSecondary, marginTop: 3, lineHeight: 15 },
  hintBento: { color: theme.bentoMuted2 },
  hintDense: { fontSize: 10.5, marginTop: 2, lineHeight: 14 },
  spark: { marginTop: 8 },
});
