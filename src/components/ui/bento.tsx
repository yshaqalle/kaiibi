import { createContext, useContext, useState, type ReactNode } from 'react';
import { Platform, StyleSheet, Text, useWindowDimensions, View, type LayoutChangeEvent, type StyleProp, type ViewStyle } from 'react-native';

import { TABLET_BREAKPOINT } from '@/constants/layout';
import { Colors } from '@/constants/theme';
import { isTabletDevice } from '@/lib/device';

// Matches `sidebar.width` in admin-sidebar.tsx. Only ever used to GUESS the
// grid width before the first measurement, so a drift here costs one frame of
// wrong layout, never a wrong final layout.
const SIDEBAR_WIDTH = 220;

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

const GAP = 14;

/**
 * The share of the grid a cell takes. Exported for its tests: this is the one
 * rule the whole responsive behaviour rests on, and it is pure, so it is worth
 * pinning at the widths real devices actually produce.
 *
 * `gridWidth` is the width the grid REPORTS, which is a gutter wider than the
 * page it sits on -- see `styles.grid`. Two corrections follow from that, and
 * both were paid for on a 440pt phone, where Revenue, Revenue vs. expenses and
 * the profit waterfall all rendered at 58% of the screen with the other 42%
 * empty beside them:
 *
 *   - The floor is about the CARD, and a cell spends a full gutter on padding,
 *     so 7/12 of a 418pt grid is a 243.8pt cell holding a 229.8pt card. Testing
 *     the cell let that through by 3.8pt and cost 10.2pt.
 *   - A partial width is only worth taking if a partner FITS beside it. The
 *     rule resolves each cell alone, so the 7 kept 58% while the 5 next to it
 *     stepped up to full width and wrapped away -- leaving the 7 with a hole
 *     rather than a pairing. Requiring the remainder to clear the floor too is
 *     the same question asked on behalf of the neighbour, and it needs no
 *     knowledge of who that neighbour is.
 */
export function bentoCellFraction(span: number, gridWidth: number): number {
  const clamped = Math.max(1, Math.min(12, Math.round(span)));
  const asked = clamped / 12;
  const fits = (fraction: number) => fraction * gridWidth - GAP >= MIN_CARD;
  // A full-width cell has no remainder to seat anyone in, and is the last
  // resort anyway.
  const usable = (fraction: number) => fraction >= 1 || (fits(fraction) && fits(1 - fraction));

  // The design's own proportion first: on a wide grid nothing else applies.
  if (usable(asked)) return asked;
  for (const step of STEPS) {
    if (step > asked && usable(step)) return step;
  }
  return 1;
}

/**
 * The grid width to assume before the grid has measured itself, so the first
 * paint lands on the right layout instead of visibly reflowing. Subtracts the
 * chrome the grid does not get: the nav sidebar, and the screen's own padding.
 *
 * Whether that sidebar is there is answered DIFFERENTLY per platform, and both
 * answers are deliberate (see admin-tabs.tsx):
 *
 *   native — `isTabletDevice()`, a device-class test. A width test would swap
 *            navigators mid-rotation and used to crash the POS, so an iPad mini
 *            gets the sidebar at 744pt even though that is under the tablet
 *            breakpoint. Guessing on width here estimated 708pt where the grid
 *            actually had 502pt, and the layout visibly reflowed on first paint.
 *   web    — a live width breakpoint (admin-tabs.web.tsx), which the shell can
 *            afford because both of its branches render a Slot.
 */
function useEstimatedGridWidth(): number {
  const { width } = useWindowDimensions();
  const hasSidebar = Platform.OS === 'web' ? width >= TABLET_BREAKPOINT : isTabletDevice();
  // `+ GAP` so the estimate is in the same units the measurement will arrive
  // in: the grid hangs half a gutter off each side of the page (see
  // `styles.grid`), so the width it reports is a gutter wider than the page.
  // Without this the first paint is computed against a narrower grid than the
  // real one and can visibly reflow one frame later.
  return Math.max(1, width - (hasSidebar ? SIDEBAR_WIDTH : 0) - 36 + GAP);
}

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
   * `stretch` lets a card in a row be as tall as the tallest. Right for a row
   * that reads as ONE band — the Overview strip, where five cards answering
   * one question at five different heights reads as five leftovers rather than
   * a row.
   *
   * It is safe to put on a WHOLE grid, which is what the Dashboard does, and
   * the reason is worth knowing: this stretches the CELL, and only a card that
   * asks grows to fill it. `BentoCard` never asks, so every card built on it
   * still hugs its own content and a mixed row looks exactly as it does under
   * `top`. Opting in is `fill` on `Card` — today that is `overview-cards.tsx`
   * and `top-mover-card.tsx`, i.e. precisely the Overview band and the movers
   * row. Splitting the screen into two grids to scope this would buy nothing.
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
