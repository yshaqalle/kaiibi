import { AccessibilityInfo, type EmitterSubscription, FlatList } from 'react-native';
import { act, create } from 'react-test-renderer';

import { ThemeMarket } from '@/components/storefront/theme-market';
import { ThemeWindow } from '@/components/storefront/theme-window';
import { SPACE } from '@/components/storefront/scale';
import { ESTIMATED_ROW_HEIGHT, goodsScrollHeight } from '@/components/storefront/theme-shared';
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
});
