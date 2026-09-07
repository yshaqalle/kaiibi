import { AccessibilityInfo, Dimensions, type EmitterSubscription, FlatList } from 'react-native';
import { act, create } from 'react-test-renderer';

import { ThemeMarket } from '@/components/storefront/theme-market';
import { ThemeWindow } from '@/components/storefront/theme-window';
import { SPACE } from '@/components/storefront/scale';
import {
  CHECKOUT_BAR_CLEARANCE, ESTIMATED_ROW_HEIGHT, goodsFitHeight, goodsRowBound, goodsScrollHeight, goodsThreeRowHeight,
} from '@/components/storefront/theme-shared';
import { paletteColors } from '@/lib/storefront-catalog';
import type { PublicStorefront, StorefrontProduct } from '@/types/models';

jest.mock('@/lib/supabase', () => ({ supabase: {} }));

// ThemeMarket/ThemeWindow mount FlyerCarousel even with no flyers (its hooks
// run unconditionally); Task 4's mount effect calls
// AccessibilityInfo.isReduceMotionEnabled(). Nothing here is about motion --
// see storefront-theme-market.test.tsx's identical setup.
jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(false);
jest.spyOn(AccessibilityInfo, 'addEventListener').mockReturnValue({ remove: jest.fn() } as unknown as EmitterSubscription);

// react-test-renderer's default window width is 750 (see jest's own
// react-native mock) -- gridColumnsForWidth(750) is 3, unless a test resizes
// the window. Every fixture below is sized off that so "one row" and "two
// rows" mean what they say regardless of which theme is rendering it.
const NUM_COLUMNS = 3;

function flatten(style: unknown): { maxHeight?: number } {
  return [style].flat(Infinity).reduce((acc, s) => ({ ...(acc as object), ...((s ?? {}) as object) }), {}) as {
    maxHeight?: number;
  };
}

const colors = paletteColors('ink');

function shopFor(theme: 'market' | 'window', slug: string): PublicStorefront {
  return {
    shopName: 'Xamdi Electronics',
    city: 'Hargeisa',
    slug,
    whatsappE164: '+252634456789',
    theme,
    palette: 'ink',
    headline: null,
    about: null,
    heroImageUrl: null,
    offersDelivery: true,
    collectAddress: null,
    collectNeighborhood: null,
    paymentMode: 'on_collection',
    openingHours: {},
    tradingSince: null, highlights: [], images: [],
    contactPhone: null, instagram: null,
    flyers: [],
    autoAdvance: false,
    hideBranding: false,
  };
}

function products(count: number): StorefrontProduct[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `p${i}`, name: `Product ${i}`, description: null, category: null, priceCents: 1000 + i, stock: 5, imageUrl: null,
  }));
}

// `data` is what tells the goods FlatList apart from its own forwardRef/host
// wrapper carrying the same testID -- storefront-flyer-placement.test.tsx's
// `gridNames` helper leans on the identical fact.
function goodsList(tree: ReturnType<typeof create>) {
  const matches = tree.root.findAll((n) => n.props?.testID === 'storefront-goods' && Array.isArray(n.props?.data));
  return matches[0];
}

async function renderTheme(Theme: typeof ThemeMarket, storefront: PublicStorefront, list: StorefrontProduct[]) {
  let tree!: ReturnType<typeof create>;
  await act(async () => {
    tree = create(<Theme storefront={storefront} products={list} colors={colors} />);
  });
  // Drains VirtualizedList's own post-mount cell-measurement timer -- see
  // storefront-theme-market.test.tsx's identical comment on why this runs
  // inside act() rather than firing later against whichever test is running.
  await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));
  return tree;
}

// THE PURE DECISION -- see theme-shared.tsx's own comment on why this and
// not a rendered height is the thing a test under this Jest harness can
// actually hold onto (onLayout never fires here at all).
describe('goodsScrollHeight', () => {
  it('is null for a grid with nothing to scroll to -- one row, or none', () => {
    expect(goodsScrollHeight(200, 14, 1)).toBeNull();
    expect(goodsScrollHeight(200, 14, 0)).toBeNull();
  });

  it('estimates two rows before anything has measured, rather than collapsing to zero', () => {
    expect(goodsScrollHeight(null, 14, 3)).toBe(ESTIMATED_ROW_HEIGHT * 2 + 14);
  });

  it('is exactly two measured rows plus one gap at the two-row boundary', () => {
    expect(goodsScrollHeight(200, 14, 2)).toBe(200 * 2 + 14);
  });

  it('does not keep growing past two rows -- the bound is the same at five rows as at two', () => {
    expect(goodsScrollHeight(200, 14, 2)).toBe(goodsScrollHeight(200, 14, 5));
  });
});

// THE PAGE'S OWN FIT -- see goodsFitHeight's own comment in theme-shared.tsx.
// goodsScrollHeight above answers "how tall CAN two rows be"; this answers
// "how tall may they actually GET on this window, without the page itself
// scrolling." Every case named in the brief this file's own task exists for,
// asserted directly against the pure function -- react-test-renderer never
// fires `onLayout`, so this is the only place any of this arithmetic can
// actually be held to a number.
describe('goodsFitHeight', () => {
  const rowHeight = 200;
  const twoRowHeight = goodsScrollHeight(rowHeight, SPACE.cardGap, 3)!; // 200*2+14 = 414
  const pagePadding = SPACE.page; // 16
  const pageGap = SPACE.cardGap; // 14 -- the SAME constant as the grid's own row gap today, but a distinct concept: the gap between the page's stacked header/goods/footer, not between two rows of tiles.
  const clearance = CHECKOUT_BAR_CLEARANCE; // 76, always reserved -- see pageWithCheckoutBar's own comment.

  it('is the room left after the header, the footer, the padding, the gaps and the clearance', () => {
    // 1200 - 100 - 100 - 32 - 28 - 76 = 864.
    expect(goodsFitHeight(1200, 100, 100, pagePadding, pageGap, clearance)).toBe(864);
  });

  // A NEGATIVE REMAINDER IS INFORMATION, not an error. A 14" laptop showing a
  // real shop has 157px of room against a 348px row -- the page scrolls there
  // no matter what, and this function's job is to say so rather than hide it
  // behind a clamp.
  it('reports a negative remainder rather than clamping it to zero', () => {
    // 400 - 100 - 100 - 32 - 28 - 76 = 64, and smaller windows go below zero.
    expect(goodsFitHeight(400, 100, 100, pagePadding, pageGap, clearance)).toBe(64);
    expect(goodsFitHeight(200, 100, 100, pagePadding, pageGap, clearance)).toBeLessThan(0);
  });

  it('returns null, never zero, when a measurement has not arrived yet', () => {
    expect(goodsFitHeight(null, 100, 100, pagePadding, pageGap, clearance)).toBeNull();
    expect(goodsFitHeight(900, null, 100, pagePadding, pageGap, clearance)).toBeNull();
    expect(goodsFitHeight(900, 100, null, pagePadding, pageGap, clearance)).toBeNull();
  });

  // THE ZERO-HEIGHT GUARD -- a header (or footer, or the page itself)
  // measured before it has painted fires a real onLayout event with height
  // 0, indistinguishable from "hasn't measured at all" to this arithmetic.
  // Both are treated identically -- see this function's own comment for why
  // that is the only reading that cannot turn a race between layout and
  // paint into a goods box collapsed to a sliver.
  it('treats a measurement that arrived as exactly zero the same as one that has not arrived at all', () => {
    expect(goodsFitHeight(900, 0, 100, pagePadding, pageGap, clearance)).toBeNull();
    expect(goodsFitHeight(900, 100, 0, pagePadding, pageGap, clearance)).toBeNull();
    expect(goodsFitHeight(0, 100, 100, pagePadding, pageGap, clearance)).toBeNull();
  });
});

// TWO ROWS ALWAYS, THREE WHEN THERE IS ROOM -- and the reason the box is
// bounded even when the page then scrolls is that the page's LENGTH must stop
// depending on the catalogue. A shop growing from 28 items to 280 must not
// grow a page ten times longer; the growth belongs inside the grid.
describe('goodsRowBound', () => {
  const rowHeight = 200;
  const gap = SPACE.cardGap;
  const two = goodsScrollHeight(rowHeight, gap, 3)!;        // 414
  const three = goodsThreeRowHeight(rowHeight, gap, 3)!;    // 628

  it('shows three rows when the remainder has room for three', () => {
    expect(goodsRowBound(two, three, three)).toBe(three);
    expect(goodsRowBound(two, three, three + 500)).toBe(three);
  });

  it('falls back to two rows when three will not fit, however little room is left', () => {
    expect(goodsRowBound(two, three, three - 1)).toBe(two);
    expect(goodsRowBound(two, three, 0)).toBe(two);
    // Negative room -- a 14" laptop. Still two rows: the page scrolls, but its
    // length stays the same whether the shop lists 28 items or 280.
    expect(goodsRowBound(two, three, -400)).toBe(two);
  });

  it('holds two rows while the window has not been measured', () => {
    expect(goodsRowBound(two, three, null)).toBe(two);
  });

  it('never bounds a grid with nothing to scroll to', () => {
    expect(goodsRowBound(null, null, 5000)).toBeNull();
  });

  it('does not offer a third row a shop does not have', () => {
    // Two rows of stock: goodsThreeRowHeight is null, so a tall window still
    // gets two -- a three-row box over two rows of tiles is dead space.
    expect(goodsThreeRowHeight(rowHeight, gap, 2)).toBeNull();
    expect(goodsRowBound(two, null, 5000)).toBe(two);
  });
});

// Task 10 (wave-review-fixes.md item 10): ESTIMATED_ROW_HEIGHT's own comment
// says it stands in for "two rows" for the one frame before a real
// measurement arrives -- but `goodsThreeRowHeight` fed it the SAME estimate,
// so on a tall enough window (remainder >= 3 * ESTIMATED_ROW_HEIGHT + 2 *
// gap) `goodsRowBound` picked three rows before any tile had ever been
// measured. The instant the real height arrived, three ESTIMATED-sized rows
// (260 each) became three ACTUAL-sized rows -- 330 each, in the case that
// prompted this -- and the box visibly snapped from 804px to 674px one frame
// after mounting. The estimate was answering a question ("two rows or
// three?") its own comment never claimed it was for.
describe('goodsThreeRowHeight: the estimate never gets to decide two-vs-three', () => {
  it('offers no third row at all until a real measurement exists, even with three rows of stock', () => {
    // rowCount 3 clears the `rowCount <= 2` guard on its own -- this is
    // asserting the SEPARATE, unmeasured-row guard the fix adds.
    expect(goodsThreeRowHeight(null, SPACE.cardGap, 3)).toBeNull();
  });

  it('keeps goodsRowBound at two rows off the estimate, even when the window is tall enough for three', () => {
    const twoRowHeight = goodsScrollHeight(null, SPACE.cardGap, 3);
    const threeRowHeight = goodsThreeRowHeight(null, SPACE.cardGap, 3);
    // A remainder tall enough to hold three rows even at the (larger, if it
    // answered) three-row estimate -- if `goodsThreeRowHeight` could still
    // decide the question unmeasured, this would return that non-null value
    // instead of falling back to `twoRowHeight`.
    expect(goodsRowBound(twoRowHeight, threeRowHeight, 5000)).toBe(twoRowHeight);
  });

  it('offers the third row again the moment a real measurement arrives', () => {
    // The fix narrows WHEN three rows can be offered -- it must not narrow
    // WHETHER, once there is a real number to answer with.
    expect(goodsThreeRowHeight(200, SPACE.cardGap, 3)).toBe(200 * 3 + SPACE.cardGap * 2);
  });
});

describe.each([
  ['Market', ThemeMarket, 'market' as const],
  ['Window', ThemeWindow, 'window' as const],
])('%s: the goods region', (name, Theme, theme) => {
  it('is a FlatList that neither the header nor the footer sit inside', async () => {
    const tree = await renderTheme(Theme, shopFor(theme, `xamdi-goods-structure-${theme}`), products(NUM_COLUMNS * 2));

    const goods = goodsList(tree);
    expect(goods.type).toBe(FlatList);

    const inside = goods.findAll(() => true);
    expect(inside.some((n) => n.props?.testID === 'storefront-footer')).toBe(false);
    expect(inside.some((n) => n.props?.testID === 'storefront-header')).toBe(false);

    // The footer is still on the page -- just not inside this container.
    expect(tree.root.findAll((n) => n.props?.testID === 'storefront-footer').length).toBeGreaterThan(0);
    expect(tree.root.findAll((n) => n.props?.testID === 'storefront-header').length).toBeGreaterThan(0);
  });

  it('is not bounded when the shop has only one row of stock', async () => {
    const tree = await renderTheme(Theme, shopFor(theme, `xamdi-goods-onerow-${theme}`), products(NUM_COLUMNS));

    const flat = flatten(goodsList(tree).props.style);
    expect(flat.maxHeight).toBeUndefined();
  });

  // THE WIRING: a measured row height actually reaching the region's own
  // style. Two different measurements, on the same render, must produce two
  // different results -- a test that passed for both would only prove the
  // style key exists, not that anything real feeds it (the brief's own
  // words for this failure mode).
  it('carries a measured row height into its own maxHeight', async () => {
    const tree = await renderTheme(Theme, shopFor(theme, `xamdi-goods-wiring-${theme}`), products(NUM_COLUMNS * 2));

    // `View` forwards `testID`/`onLayout` from its composite instance down to
    // its own host node -- both carry the same two props, and both resolve
    // to the identical handler, so any one of them can fire it (the same
    // fact storefront-theme-market.test.tsx's own `findByTestId` comment
    // notes for Pressable's forwardRef layer).
    const cell = tree.root.findAll(
      (n) => n.props?.testID === 'storefront-goods-row' && typeof n.props?.onLayout === 'function',
    );
    expect(cell.length).toBeGreaterThan(0);

    act(() => cell[0].props.onLayout({ nativeEvent: { layout: { height: 100 } } }));
    const shortBound = flatten(goodsList(tree).props.style).maxHeight;

    act(() => cell[0].props.onLayout({ nativeEvent: { layout: { height: 300 } } }));
    const tallBound = flatten(goodsList(tree).props.style).maxHeight;

    expect(shortBound).not.toBe(tallBound);
    expect(shortBound).toBe(100 * 2 + SPACE.cardGap);
    expect(tallBound).toBe(300 * 2 + SPACE.cardGap);

    // Each maxHeight change re-lays the nested FlatList out, which schedules
    // its own post-update cell-measurement timer -- drained here, inside
    // act(), for the identical reason renderTheme's own drain exists: so it
    // fires against THIS test rather than logging later against whichever
    // one is running by then.
    await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));
  });

  // Task 7 (wave-review-fixes.md item 7): the comment above `pageHeight`'s
  // own reset effect (theme-market.tsx/theme-window.tsx) claims EVERY
  // measurement -- rowHeight included -- drops on any width change. The code
  // only ever dropped `rowHeight` on a COLUMN-COUNT change
  // (`useEffect(() => setRowHeight(null), [numColumns])`), and a resize that
  // stays inside one breakpoint band -- 1300 -> 1500 are both 5 columns per
  // gridColumnsForWidth -- changes `width` without changing `numColumns`, so
  // the row height measured at the OLD width survived exactly the resize
  // the comment claimed already handled it. `key={numColumns}` also does not
  // remount the FlatList across such a resize, so nothing re-measures cell 0
  // on its own either -- this is the "scrolled deep, cell 0 off-screen, no
  // fresh measurement arrives" case the brief names, reproduced here by
  // simply never calling `onLayout` a second time.
  // THE ANTI-STROBE RULE, and it replaces its own opposite.
  //
  // An earlier version of this test asserted that a width change DROPPED the
  // measured row height back to the estimate, so a resize inside one column
  // band could not keep a stale number. It did stop that -- and it made
  // dragging a window edge strobe, because a drag fires a resize dozens of
  // times a second and every one of them sent the goods box to the 534px
  // estimate and back to its measured 870. "It does not behave well when
  // changing the window size" was that, and the reset was the cause.
  //
  // So the rule inverted: a measurement is HELD until a fresh one replaces it.
  // Held is off by whatever the resize changed; the estimate is off by 336px
  // and always in the same direction. Both halves are asserted below, because
  // holding alone would be a stale layout and replacing alone is what the old
  // reset already did.
  it('holds the measured row height across a width change, and takes a fresh measurement when one arrives', async () => {
    await act(async () => {
      Dimensions.set({
        window: { width: 1300, height: 900, scale: 1, fontScale: 1 },
        screen: { width: 1300, height: 900, scale: 1, fontScale: 1 },
      });
    });

    try {
      // 5 columns at both 1300 and 1500 -- three rows of stock, so the
      // two-row bound actually depends on a real rowHeight rather than the
      // `rowCount <= 1` short-circuit that would pass regardless of the bug.
      const tree = await renderTheme(Theme, shopFor(theme, `xamdi-goods-band-${theme}`), products(5 * 3));

      const cell = tree.root.findAll(
        (n) => n.props?.testID === 'storefront-goods-row' && typeof n.props?.onLayout === 'function',
      );
      act(() => cell[0].props.onLayout({ nativeEvent: { layout: { height: 300 } } }));
      expect(flatten(goodsList(tree).props.style).maxHeight).toBe(300 * 2 + SPACE.cardGap);

      await act(async () => {
        Dimensions.set({
          window: { width: 1500, height: 900, scale: 1, fontScale: 1 },
          screen: { width: 1500, height: 900, scale: 1, fontScale: 1 },
        });
      });

      const afterResize = flatten(goodsList(tree).props.style).maxHeight;
      // HELD, not dropped: still the 300-measured bound, and specifically NOT
      // the estimate. This is the assertion that fails if the width-keyed
      // reset ever comes back, which is what made a drag strobe.
      expect(afterResize).toBe(300 * 2 + SPACE.cardGap);
      expect(afterResize).not.toBe(goodsScrollHeight(null, SPACE.cardGap, 3));

      // And replaced the moment a real measurement lands -- the half that
      // stops "held" from meaning "stale for ever". onLayout fires on the row
      // whenever the width changes (RN-web's ResizeObserver, native's layout
      // pass); here it is called directly, since it never fires under this
      // harness.
      const afterRelayout = tree.root.findAll(
        (n) => n.props?.testID === 'storefront-goods-row' && typeof n.props?.onLayout === 'function',
      );
      act(() => afterRelayout[0].props.onLayout({ nativeEvent: { layout: { height: 360 } } }));
      expect(flatten(goodsList(tree).props.style).maxHeight).toBe(360 * 2 + SPACE.cardGap);

      await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));
    } finally {
      // `Dimensions` is a process-global -- restore it for every test after
      // this one, the same obligation storefront-product-sheet.test.tsx's
      // own `afterEach` documents for the identical reason.
      await act(async () => {
        Dimensions.set({
          window: { width: 750, height: 1334, scale: 1, fontScale: 1 },
          screen: { width: 750, height: 1334, scale: 1, fontScale: 1 },
        });
      });
    }
  });

  // THE OTHER HALF OF THE WIRING: goodsFitHeight's three extra measurements
  // (the page scroller's own frame, the header, the footer) actually
  // reaching the region's own style, on top of the row height above. Two
  // different page heights, on the same render, must produce two different
  // results -- the identical bar the row-height wiring test above holds
  // itself to, applied to the new measurements this task added.
  it('keeps its two-row bound on a short page, and takes a third row only when there is room', async () => {
    // THREE rows of stock, not two: a third row is only ever offered when the
    // shop actually has one to show, so a two-row fixture would pass this test
    // for the wrong reason -- it would sit at two rows no matter how tall the
    // window got, and the tall case would prove nothing.
    const tree = await renderTheme(Theme, shopFor(theme, `xamdi-goods-fit-${theme}`), products(NUM_COLUMNS * 3));

    const cell = tree.root.findAll(
      (n) => n.props?.testID === 'storefront-goods-row' && typeof n.props?.onLayout === 'function',
    );
    act(() => cell[0].props.onLayout({ nativeEvent: { layout: { height: 200 } } }));

    const page = tree.root.findAll(
      (n) => n.props?.testID === 'storefront-page-scroll' && typeof n.props?.onLayout === 'function',
    )[0];
    const headerCol = tree.root.findAll(
      (n) => n.props?.testID === 'storefront-header-column' && typeof n.props?.onLayout === 'function',
    )[0];
    const footerCol = tree.root.findAll(
      (n) => n.props?.testID === 'storefront-footer-column' && typeof n.props?.onLayout === 'function',
    )[0];
    expect(page).toBeTruthy();
    expect(headerCol).toBeTruthy();
    expect(footerCol).toBeTruthy();

    // A tall window: remainder = 1400 - 300 - 200 - 32 - 28 - 76 = 764, which
    // clears three rows (628), so the box takes the third.
    act(() => {
      page.props.onLayout({ nativeEvent: { layout: { height: 1400 } } });
      headerCol.props.onLayout({ nativeEvent: { layout: { height: 300 } } });
      footerCol.props.onLayout({ nativeEvent: { layout: { height: 200 } } });
    });
    const tall = flatten(goodsList(tree).props.style).maxHeight;
    expect(tall).toBe(200 * 3 + SPACE.cardGap * 2);

    // A shorter window, same header/footer: remainder = 1000 - 300 - 200 -
    // 32 - 28 - 76 = 364, which cannot hold three rows (628) -- so the box
    // falls back to two and the page scrolls the difference. It does NOT
    // shrink below two: the point of the bound is that the page's length
    // stops depending on the catalogue, and that holds on every window.
    act(() => {
      page.props.onLayout({ nativeEvent: { layout: { height: 1000 } } });
    });
    const short = flatten(goodsList(tree).props.style).maxHeight;

    expect(short).not.toBe(tall);
    expect(short).toBe(200 * 2 + SPACE.cardGap);

    // And back again on a taller window, so this is a live decision rather
    // than a one-way door.
    act(() => {
      page.props.onLayout({ nativeEvent: { layout: { height: 1400 } } });
    });
    expect(flatten(goodsList(tree).props.style).maxHeight).toBe(200 * 3 + SPACE.cardGap * 2);

    await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));
  });

  // THE FAILURE MODE THE BRIEF NAMES BY NAME: a header measured before it has
  // painted reports height 0, not "no measurement yet" -- and the goods box
  // must not read that as licence to shrink toward nothing. Falls back to
  // the two-row cap it already had, exactly as if the header had not
  // measured at all.
  it('does not collapse the goods box when the header measures as zero before it has painted', async () => {
    const tree = await renderTheme(Theme, shopFor(theme, `xamdi-goods-zero-${theme}`), products(NUM_COLUMNS * 2));

    const cell = tree.root.findAll(
      (n) => n.props?.testID === 'storefront-goods-row' && typeof n.props?.onLayout === 'function',
    );
    act(() => cell[0].props.onLayout({ nativeEvent: { layout: { height: 200 } } }));

    const page = tree.root.findAll(
      (n) => n.props?.testID === 'storefront-page-scroll' && typeof n.props?.onLayout === 'function',
    )[0];
    const headerCol = tree.root.findAll(
      (n) => n.props?.testID === 'storefront-header-column' && typeof n.props?.onLayout === 'function',
    )[0];
    const footerCol = tree.root.findAll(
      (n) => n.props?.testID === 'storefront-footer-column' && typeof n.props?.onLayout === 'function',
    )[0];

    act(() => {
      page.props.onLayout({ nativeEvent: { layout: { height: 900 } } });
      headerCol.props.onLayout({ nativeEvent: { layout: { height: 0 } } });
      footerCol.props.onLayout({ nativeEvent: { layout: { height: 200 } } });
    });

    const bound = flatten(goodsList(tree).props.style).maxHeight;
    expect(bound).toBe(200 * 2 + SPACE.cardGap);

    await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));
  });

  // A single row of stock has nothing to scroll TO (goodsScrollHeight's own
  // rule) -- confirming that stays true even once the page has fully
  // measured is the guard against the OTHER failure direction: a fit
  // calculation that starts squeezing a shop with nothing to squeeze.
  it('stays unbounded on a single row of stock even once the page has measured', async () => {
    const tree = await renderTheme(Theme, shopFor(theme, `xamdi-goods-onerow-fit-${theme}`), products(NUM_COLUMNS));

    const page = tree.root.findAll(
      (n) => n.props?.testID === 'storefront-page-scroll' && typeof n.props?.onLayout === 'function',
    )[0];
    const headerCol = tree.root.findAll(
      (n) => n.props?.testID === 'storefront-header-column' && typeof n.props?.onLayout === 'function',
    )[0];
    const footerCol = tree.root.findAll(
      (n) => n.props?.testID === 'storefront-footer-column' && typeof n.props?.onLayout === 'function',
    )[0];

    act(() => {
      page.props.onLayout({ nativeEvent: { layout: { height: 400 } } });
      headerCol.props.onLayout({ nativeEvent: { layout: { height: 300 } } });
      footerCol.props.onLayout({ nativeEvent: { layout: { height: 200 } } });
    });

    expect(flatten(goodsList(tree).props.style).maxHeight).toBeUndefined();

    await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));
  });
});
