import { type ReactNode } from 'react';
import { StyleSheet, Text, useWindowDimensions, View, type LayoutChangeEvent, type StyleProp, type ViewStyle } from 'react-native';

import { TABLET_BREAKPOINT } from '@/constants/layout';
import { Colors } from '@/constants/theme';

const theme = Colors.light;

// The bento grid the Dashboard and Accounting are laid out on.
//
// Flexbox with percentage widths, NOT CSS grid: this renders on native as
// well as web, and `display: grid` exists only in react-native-web. The cost
// is that cells do not stretch to a shared row height the way grid cells do --
// each row is as tall as its tallest cell and shorter cells sit at the top,
// which is what `alignItems: 'flex-start'` below makes explicit rather than
// accidental.
//
// Three step points, matching what the rest of the app already uses:
//
//   >= 1000            12 columns   desktop web, sidebar alongside
//   >= TABLET_BREAKPOINT 6 columns  tablet and the narrow desktop window
//   below               1 column    phone, native and mobile web
//
// 1000 is the same threshold Accounting's Overview already reads for its
// two-up layout (overview-tab.tsx), and TABLET_BREAKPOINT is the nav shell's
// own switch, so a screen never disagrees with the chrome around it.
const WIDE_BREAKPOINT = 1000;

export type BentoColumns = 12 | 6 | 1;

export function useBentoColumns(): BentoColumns {
  const { width } = useWindowDimensions();
  if (width >= WIDE_BREAKPOINT) return 12;
  if (width >= TABLET_BREAKPOINT) return 6;
  return 1;
}

const GAP = 14;

export function BentoGrid({
  children,
  style,
  onLayout,
  rowAlign = 'top',
}: {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  onLayout?: (event: LayoutChangeEvent) => void;
  /**
   * `top` (the default) lets each card be as tall as its own content, with
   * shorter ones sitting at the top of the row. Right for most of a screen:
   * a table and a three-line statement have no business being the same height.
   *
   * `stretch` makes every card in a row as tall as the tallest. Right for a
   * row that reads as ONE band — the Overview strip, where five cards
   * answering one question at five different heights reads as five leftovers
   * rather than a row. A card in a stretched row has to fill it: see the
   * `fill` prop on `Card`.
   */
  rowAlign?: 'top' | 'stretch';
}) {
  return (
    <View style={[styles.grid, rowAlign === 'stretch' && styles.gridStretch, style]} onLayout={onLayout}>
      {children}
    </View>
  );
}

/**
 * The other body layout: full-width cards stacked down the page, no grid.
 *
 * For screens you READ rather than glance at — the ledgers (Transactions,
 * Bills, Expenses, Payroll). A table in a `BentoCell` spans all twelve
 * columns anyway, so the grid buys nothing while costing the cell's 36px of
 * horizontal padding; on a phone it also puts a horizontally-scrolling table
 * inside a horizontally-scrolling card.
 *
 * `gap` is safe here in a way it isn't in `BentoGrid`: the warning is about
 * WRAPPING rows, and this never wraps.
 */
export function BentoFlow({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[styles.flow, style]}>{children}</View>;
}

/**
 * One cell. `span` is in TWELFTHS regardless of the active column count --
 * callers describe the layout once, in the vocabulary of the design, and the
 * cell resolves it for the width it actually has.
 *
 * At 6 columns a span is halved (rounded up, so a 5-wide and a 7-wide both
 * become full-width rather than one of them collapsing to a sliver). At 1
 * column everything is full width.
 */
export function BentoCell({
  span = 12,
  children,
  style,
  onLayout,
}: {
  span?: number;
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  /**
   * Fires with the cell's position WITHIN THE GRID, not within the screen --
   * a caller scrolling to a cell has to add the grid's own offset.
   */
  onLayout?: (event: LayoutChangeEvent) => void;
}) {
  const columns = useBentoColumns();
  const clamped = Math.max(1, Math.min(12, Math.round(span)));

  let fraction: number;
  if (columns === 1) {
    fraction = 1;
  } else if (columns === 6) {
    // Halve, round UP, then cap. A 7/12 card and a 5/12 card sitting in one
    // row both want the full width here; rounding down would give the 5 a
    // 2/6 sliver next to a 4/6 and break the pairing the design intends.
    fraction = Math.min(6, Math.ceil(clamped / 2)) / 6;
  } else {
    fraction = clamped / 12;
  }

  // The gap is subtracted in proportion to the span so a row of cells whose
  // fractions sum to 1 lands exactly on the container width. Without this a
  // 6+6 row overflows by one gap and wraps to two rows.
  return (
    <View style={[{ width: `${fraction * 100}%` }, styles.cellOuter, style]} onLayout={onLayout}>
      <View style={styles.cellInner}>{children}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'flex-start',
    // Negative margin + matching cell padding rather than `gap`: `gap` on a
    // wrapping row is supported unevenly across the RN versions this app
    // targets, and the half-gutter trick works identically everywhere.
    marginHorizontal: -GAP / 2,
  },
  gridStretch: { alignItems: 'stretch' },
  flow: { gap: GAP },
  cellOuter: { paddingHorizontal: GAP / 2, marginBottom: GAP },
  // Lets a card inside stretch to the cell's width without the caller
  // remembering to set it.
  cellInner: { width: '100%', height: '100%' },
  // Takes the cell's half-gutter so the label's left edge lines up with the
  // cards below it rather than sitting 7px out.
  zoneOuter: { width: '100%', paddingHorizontal: GAP / 2, paddingTop: 4, marginBottom: GAP },
  zone: {
    fontSize: 10.5,
    fontWeight: '800',
    letterSpacing: 1.1,
    textTransform: 'uppercase',
    color: theme.bentoMuted,
  },
});

/**
 * An uppercase rule grouping the cards under it into one question.
 *
 * The cheapest improvement on this screen and the one that carries the most:
 * twenty-odd cards read as a wall, and six labelled zones read as six answers.
 * Always full-bleed, at every column count — a zone heading indented to a
 * cell's width reads as that cell's title rather than the group's.
 */
export function BentoZone({ children }: { children: ReactNode }) {
  return (
    <View style={styles.zoneOuter}>
      <Text style={styles.zone}>{children}</Text>
    </View>
  );
}
