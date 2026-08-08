import { createContext, useContext, useState, type ReactNode } from 'react';
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
// Cells are sized by ONE rule: a card is never narrower than `MIN_CARD`.
//
// This replaces three fixed pixel breakpoints, and it replaces them because
// those needed a new patch for every device anyone happened to open. Two
// things went wrong with them repeatedly:
//
//   - They read the WINDOW. The grid never gets the window -- the admin
//     sidebar takes ~210pt and the page another ~36pt -- so a 1024pt iPad was
//     handed 777pt while a window-based check still called it a desktop.
//   - Dropping 12 columns to 6 does not widen a small card at all: `span={2}`
//     resolves to one sixth at BOTH counts. That is why the revenue spark card
//     kept breaking "Revenue" mid-word no matter which threshold moved.
//
// So the question a cell asks is not "how wide is this device" but "does the
// proportion the design asked for still leave me readable here". It keeps that
// proportion wherever it fits, and steps up to the next fraction that clears
// the floor -- a third, a half, full width -- where it does not. Rows wrap on
// their own. Wide screens are untouched; only cramped ones degrade, and they
// degrade identically everywhere, including on sizes nobody has opened yet.
//
// 240 is a design decision, not a device measurement: it is roughly where a
// bento card stops holding a heading, a figure and a caption on one line each.
const MIN_CARD = 240;

// The fractions a cell may take. Anything coarser than a third is not worth
// having -- two cards of 1/3 and 2/3 read as a pairing, four of 1/4 read as a
// row, and a 1/5 is a sliver whatever the screen.
const STEPS = [1 / 3, 1 / 2, 1];

/**
 * The share of the grid a cell takes. Exported for its tests: this is the one
 * rule the whole responsive behaviour rests on, and it is pure, so it is worth
 * pinning at the widths real devices actually produce.
 */
export function bentoCellFraction(span: number, gridWidth: number): number {
  const clamped = Math.max(1, Math.min(12, Math.round(span)));
  const asked = clamped / 12;
  // The design's own proportion first: on a wide grid nothing else applies.
  if (asked * gridWidth >= MIN_CARD) return asked;
  for (const step of STEPS) {
    if (step > asked && step * gridWidth >= MIN_CARD) return step;
  }
  return 1;
}

/**
 * The grid width to assume before the grid has measured itself, so the first
 * paint lands on the right layout instead of visibly reflowing. Subtracts the
 * chrome the grid does not get: the sidebar the nav shell draws at tablet
 * width and up, and the screen's own page padding.
 */
function useEstimatedGridWidth(): number {
  const { width } = useWindowDimensions();
  const sidebar = width >= TABLET_BREAKPOINT ? 210 : 0;
  return Math.max(1, width - sidebar - 36);
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
  const estimate = useEstimatedGridWidth();
  // `null` until the first layout, when the estimate above stands in.
  const [measured, setMeasured] = useState<number | null>(null);

  return (
    <GridContext.Provider value={{ rowAlign, width: measured ?? estimate }}>
      <View
        style={[styles.grid, rowAlign === 'stretch' && styles.gridStretch, style]}
        onLayout={(event) => {
          // The grid's OWN width is the only honest input here. Reading the
          // window instead is what put a desktop layout in 777pt of space.
          setMeasured(event.nativeEvent.layout.width);
          onLayout?.(event);
        }}
      >
        {children}
      </View>
    </GridContext.Provider>
  );
}

// Lets a cell know how much room its grid actually has, and whether its row
// stretches, without every caller having to pass either down. See `cellInner`
// below for why the cell cannot just always grow.
const GridContext = createContext<{ rowAlign: 'top' | 'stretch'; width: number | null }>({
  rowAlign: 'top',
  width: null,
});

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
 * One cell. `span` is in TWELFTHS, always — callers describe the layout once,
 * in the vocabulary of the design, and the cell resolves it for the width it
 * actually has.
 *
 * The span is what the cell takes wherever that still leaves it readable. Below
 * `MIN_CARD` it widens to a third, then a half, then the full row, and the row
 * wraps. So `span={2}` is a fifth of a desktop band and a third of a tablet,
 * and the caller never says so.
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
  const { rowAlign, width: gridWidth } = useContext(GridContext);
  // A cell used outside a BentoGrid still has to size itself somehow, so the
  // window estimate remains the fallback.
  const estimate = useEstimatedGridWidth();
  const fraction = bentoCellFraction(span, gridWidth ?? estimate);

  // The gap is subtracted in proportion to the span so a row of cells whose
  // fractions sum to 1 lands exactly on the container width. Without this a
  // 6+6 row overflows by one gap and wraps to two rows.
  return (
    <View style={[{ width: `${fraction * 100}%` }, styles.cellOuter, style]} onLayout={onLayout}>
      <View style={[styles.cellInner, rowAlign === 'stretch' && styles.cellInnerFill]}>{children}</View>
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
  cellInner: { width: '100%' },
  // Fills the height `rowAlign="stretch"` handed the cell. Gated on stretch,
  // and NOT expressed as `height: '100%'` -- both halves of that matter, and
  // both were learned the hard way on native:
  //
  // `height: '100%'` is a no-op on web, where CSS resolves a percentage
  // height to `auto` against an auto-height parent. Yoga resolves it against
  // the owner height threaded down through layout, and inside a ScrollView
  // that chain ends at the SCROLLVIEW'S OWN FRAME -- so every cell became a
  // viewport tall, the dark hero card filled one, and the rest of the
  // Dashboard was pushed below the fold.
  //
  // `flexGrow` fixes that but must NOT be unconditional. In a `top` grid the
  // row is `alignItems: 'flex-start'`, the cell has no row height to fill,
  // and Yoga hands the grow the available height instead -- which made
  // Accounting's first card a viewport tall and pushed every chart under it
  // off-screen. A cell only grows where there is a stretched row to grow
  // into.
  cellInnerFill: { flexGrow: 1 },
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
