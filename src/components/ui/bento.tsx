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
// Three step points, measured against THE GRID'S OWN WIDTH, not the window's:
//
//   >= 900   12 columns   desktop web
//   >= 560    6 columns   tablet, and the narrow desktop window
//   below     1 column    phone
//
// Reading the window was the bug this replaces. The grid never gets the
// window: the admin sidebar takes ~210pt and the page another ~36pt of
// padding, so a 1024pt iPad Pro handed the grid 777pt while the window-based
// check still called it a 1000pt desktop. Five Overview cards then had to
// share 777pt and the dark card's text wrapped one character per line.
//
// Because the thresholds now describe content rather than chrome, they are
// ~240pt below the window numbers they replace, and 12 columns asks for more
// than that again: the Overview row is five cards wide, and five cards need
// real room before that reads as a band rather than as five slivers.
const GRID_WIDE = 1050;
const GRID_TABLET = 700;

export type BentoColumns = 12 | 6 | 1;

function columnsForGridWidth(width: number): BentoColumns {
  if (width >= GRID_WIDE) return 12;
  if (width >= GRID_TABLET) return 6;
  return 1;
}

/**
 * The column count from the WINDOW, used only as the first-paint estimate
 * before the grid has measured itself. Subtracts the chrome the grid does not
 * get so the guess usually matches what the measurement will say, and the
 * layout does not visibly reflow.
 */
export function useBentoColumns(): BentoColumns {
  const { width } = useWindowDimensions();
  const sidebar = width >= TABLET_BREAKPOINT ? 210 : 0;
  return columnsForGridWidth(width - sidebar - 36);
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
  const estimate = useBentoColumns();
  // `null` until the first layout: the estimate above stands in, so the grid
  // paints at a sensible width rather than flashing one column.
  const [measured, setMeasured] = useState<BentoColumns | null>(null);

  return (
    <GridContext.Provider value={{ rowAlign, columns: measured ?? estimate }}>
      <View
        style={[styles.grid, rowAlign === 'stretch' && styles.gridStretch, style]}
        onLayout={(event) => {
          // The grid's own width is the only honest input to the column
          // count -- see the breakpoint note at the top of this file.
          setMeasured(columnsForGridWidth(event.nativeEvent.layout.width));
          onLayout?.(event);
        }}
      >
        {children}
      </View>
    </GridContext.Provider>
  );
}

// Lets a cell know how many columns its grid resolved to and whether its row
// stretches, without every caller having to pass either down. See `cellInner`
// below for why the cell cannot just always grow.
const GridContext = createContext<{ rowAlign: 'top' | 'stretch'; columns: BentoColumns | null }>({
  rowAlign: 'top',
  columns: null,
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
  const { rowAlign, columns: gridColumns } = useContext(GridContext);
  // A cell used outside a BentoGrid still has to size itself somehow, so the
  // window estimate remains the fallback.
  const windowColumns = useBentoColumns();
  const columns = gridColumns ?? windowColumns;
  const clamped = Math.max(1, Math.min(12, Math.round(span)));

  let fraction: number;
  if (columns === 1) {
    fraction = 1;
  } else if (columns === 6) {
    // Halve, round UP, then cap. A 7/12 card and a 5/12 card sitting in one
    // row both want the full width here; rounding down would give the 5 a
    // 2/6 sliver next to a 4/6 and break the pairing the design intends.
    //
    // Floored at 2/6. A `span={2}` card resolves to 1/6 at BOTH column counts,
    // so halving alone never widened the Overview row's small cards -- at a
    // 1120pt grid they came out 187pt and broke "Revenue" across two lines.
    // A third is the narrowest a card on this grid reads at, so six columns
    // hands out thirds and lets the row wrap rather than shaving slivers.
    fraction = Math.min(6, Math.max(2, Math.ceil(clamped / 2))) / 6;
  } else {
    fraction = clamped / 12;
  }

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
