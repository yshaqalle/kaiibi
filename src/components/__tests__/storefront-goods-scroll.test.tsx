import { AccessibilityInfo, type EmitterSubscription, FlatList } from 'react-native';
import { act, create } from 'react-test-renderer';

import { ThemeMarket } from '@/components/storefront/theme-market';
import { ThemeWindow } from '@/components/storefront/theme-window';
import { SPACE } from '@/components/storefront/scale';
import {
  CHECKOUT_BAR_CLEARANCE, ESTIMATED_ROW_HEIGHT, goodsFitHeight, goodsScrollHeight,
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

  it('returns the two-row cap when the window leaves more room than two rows need', () => {
    // remainder = 1200 - 100 - 100 - 32 - 28 - 76 = 864, comfortably above 414.
    expect(goodsFitHeight(twoRowHeight, rowHeight, 1200, 100, 100, pagePadding, pageGap, clearance)).toBe(twoRowHeight);
  });

  it('returns the remainder itself when it lands between one row and two', () => {
    // remainder = 636 - 100 - 100 - 32 - 28 - 76 = 300, between 200 (one row) and 414 (two).
    expect(goodsFitHeight(twoRowHeight, rowHeight, 636, 100, 100, pagePadding, pageGap, clearance)).toBe(300);
  });

  it('floors at one row rather than collapsing further when the window is shorter still', () => {
    // remainder = 400 - 100 - 100 - 32 - 28 - 76 = 64, below the 200px floor.
    expect(goodsFitHeight(twoRowHeight, rowHeight, 400, 100, 100, pagePadding, pageGap, clearance)).toBe(rowHeight);
  });

  it('returns null, never zero, when a measurement has not arrived yet', () => {
    expect(goodsFitHeight(twoRowHeight, rowHeight, null, 100, 100, pagePadding, pageGap, clearance)).toBeNull();
    expect(goodsFitHeight(twoRowHeight, rowHeight, 900, null, 100, pagePadding, pageGap, clearance)).toBeNull();
    expect(goodsFitHeight(twoRowHeight, rowHeight, 900, 100, null, pagePadding, pageGap, clearance)).toBeNull();
    expect(goodsFitHeight(null, rowHeight, 900, 100, 100, pagePadding, pageGap, clearance)).toBeNull();
    expect(goodsFitHeight(twoRowHeight, null, 900, 100, 100, pagePadding, pageGap, clearance)).toBeNull();
  });

  // THE ZERO-HEIGHT GUARD -- a header (or footer, or the page itself)
  // measured before it has painted fires a real onLayout event with height
  // 0, indistinguishable from "hasn't measured at all" to this arithmetic.
  // Both are treated identically -- see this function's own comment for why
  // that is the only reading that cannot turn a race between layout and
  // paint into a goods box collapsed to a sliver.
  it('treats a measurement that arrived as exactly zero the same as one that has not arrived at all', () => {
    expect(goodsFitHeight(twoRowHeight, rowHeight, 900, 0, 100, pagePadding, pageGap, clearance)).toBeNull();
    expect(goodsFitHeight(twoRowHeight, rowHeight, 900, 100, 0, pagePadding, pageGap, clearance)).toBeNull();
    expect(goodsFitHeight(twoRowHeight, 0, 900, 100, 100, pagePadding, pageGap, clearance)).toBeNull();
    expect(goodsFitHeight(twoRowHeight, rowHeight, 0, 100, 100, pagePadding, pageGap, clearance)).toBeNull();
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

  // THE OTHER HALF OF THE WIRING: goodsFitHeight's three extra measurements
  // (the page scroller's own frame, the header, the footer) actually
  // reaching the region's own style, on top of the row height above. Two
  // different page heights, on the same render, must produce two different
  // results -- the identical bar the row-height wiring test above holds
  // itself to, applied to the new measurements this task added.
  it('shrinks its own bound to fit a shorter page, and grows again on a taller one', async () => {
    const tree = await renderTheme(Theme, shopFor(theme, `xamdi-goods-fit-${theme}`), products(NUM_COLUMNS * 2));

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

    // A tall window: the remainder comfortably clears two rows (414), so the
    // box stays at the two-row cap, unclipped.
    act(() => {
      page.props.onLayout({ nativeEvent: { layout: { height: 1400 } } });
      headerCol.props.onLayout({ nativeEvent: { layout: { height: 300 } } });
      footerCol.props.onLayout({ nativeEvent: { layout: { height: 200 } } });
    });
    const tall = flatten(goodsList(tree).props.style).maxHeight;
    expect(tall).toBe(200 * 2 + SPACE.cardGap);

    // A shorter window, same header/footer: remainder = 1000 - 300 - 200 -
    // 2*SPACE.page - 2*SPACE.cardGap - CHECKOUT_BAR_CLEARANCE = 364, between
    // one row (200) and two (414).
    act(() => {
      page.props.onLayout({ nativeEvent: { layout: { height: 1000 } } });
    });
    const short = flatten(goodsList(tree).props.style).maxHeight;

    expect(short).not.toBe(tall);
    expect(short).toBe(1000 - 300 - 200 - 2 * SPACE.page - 2 * SPACE.cardGap - CHECKOUT_BAR_CLEARANCE);

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
