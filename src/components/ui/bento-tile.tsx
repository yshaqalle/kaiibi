import { Children, cloneElement, isValidElement } from 'react';
import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';

import { BENTO_RADIUS_TILE, Colors } from '@/constants/theme';

// Pinned to the light palette for now — no dark-mode switching yet.
const theme = Colors.light;

// A figure on an inset panel, for the strips of numbers a bento card opens
// with.
//
// Deliberately not `StatTile`: that one is bordered cream and renders on
// Settings, the customer modal and staff self-service as well as the converted
// screens, so giving it a bento variant is a change to screens nobody asked
// about. This is the bento shape — `bentoSoft` fill, no border, tile radius —
// and nothing else reads it yet.
//
// `tone="warn"` is for a figure that is fine but wants noticing: shops in
// grace, trials about to lapse. It is not an error state and carries no glyph
// for that reason; where a figure genuinely means loss, use the sign or arrow
// in `value` itself.
export function BentoTile({
  label,
  value,
  hint,
  tone = 'default',
  style,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: 'default' | 'warn';
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <View style={[styles.tile, style]}>
      <Text style={styles.label} numberOfLines={1}>
        {label.toUpperCase()}
      </Text>
      <Text style={[styles.value, tone === 'warn' && styles.valueWarn]} numberOfLines={1}>
        {value}
      </Text>
      {/* Ternary, not `hint && …` — an empty string is a bare text node inside
          a View, which is a hard error on RN Web. */}
      {hint ? (
        <Text style={styles.hint} numberOfLines={2}>
          {hint}
        </Text>
      ) : null}
    </View>
  );
}

/**
 * The row tiles sit in. Wraps, and every tile grows to share the width.
 *
 * `minTileWidth` is how a card says how many tiles it wants per row, without
 * hardcoding a count that cannot reflow. It matters because of what a leftover
 * does: four tiles in a card only wide enough for three wrap 3 + 1, and the
 * orphan then GROWS to the full width, so it reads as a heading rather than the
 * fourth of four. Raising the minimum past a third of the row turns that into
 * an even 2 x 2.
 */
export function BentoTileRow({
  children,
  minTileWidth,
  style,
}: {
  children: React.ReactNode;
  minTileWidth?: number;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <View style={[styles.row, style]}>
      {minTileWidth == null
        ? children
        : Children.map(children, (child) =>
            // Cloned rather than passed down through context: a tile can also
            // be used on its own, and a context would make its width depend on
            // whether an ancestor happened to exist.
            isValidElement<{ style?: StyleProp<ViewStyle> }>(child)
              ? cloneElement(child, { style: [child.props.style, { minWidth: minTileWidth }] })
              : child
          )}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  tile: {
    backgroundColor: theme.bentoSoft,
    borderRadius: BENTO_RADIUS_TILE,
    padding: 13,
    minWidth: 118,
    flexGrow: 1,
    flexBasis: 0,
  },
  label: { fontSize: 10.5, fontWeight: '700', letterSpacing: 0.7, color: theme.bentoMuted },
  value: {
    fontSize: 20,
    fontWeight: '800',
    letterSpacing: -0.5,
    color: theme.bentoInk,
    marginTop: 4,
    fontVariant: ['tabular-nums'],
  },
  valueWarn: { color: theme.bentoWarn },
  hint: { fontSize: 10.5, color: theme.bentoMuted2, marginTop: 3 },
});
