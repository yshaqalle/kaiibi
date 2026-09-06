import { AccessibilityInfo, type EmitterSubscription } from 'react-native';
import { act, create } from 'react-test-renderer';

import { activeCategoryBox, CATEGORY_BAND_MINIMUM, CategoryBand, firstPhotoByCategory } from '@/components/storefront/category-band';
import { RADIUS } from '@/components/storefront/scale';
import { ThemeCounter } from '@/components/storefront/theme-counter';
import { ThemeMarket } from '@/components/storefront/theme-market';
import { paletteColors } from '@/lib/storefront-catalog';
import type { PublicStorefront, StorefrontCategory, StorefrontProduct } from '@/types/models';

jest.mock('@/lib/supabase', () => ({ supabase: {} }));

jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(false);
jest.spyOn(AccessibilityInfo, 'addEventListener').mockReturnValue({ remove: jest.fn() } as unknown as EmitterSubscription);

const colors = paletteColors('palm');

const shop: PublicStorefront = {
  shopName: 'Barwaaqo Grocers', city: 'Hargeisa', slug: 'barwaaqo-band', whatsappE164: '+252634456789',
  theme: 'market', palette: 'palm', headline: null, about: null, heroImageUrl: null,
  offersDelivery: true, collectAddress: null, collectNeighborhood: null,
  paymentMode: 'on_collection',
  openingHours: {},
  tradingSince: null, highlights: [], images: [],
  contactPhone: null, instagram: null, flyers: [], autoAdvance: false, hideBranding: false,
};

// Neither product has a photo -- both categories below must degrade to the
// pill. This is the fixture the pre-Task-15 suite already used, kept as-is
// so the ThemeMarket integration test below still proves a PILL filters the
// grid exactly as it always has.
const products: StorefrontProduct[] = [
  { id: '1', name: 'Basmati Rice 5kg', description: null, category: 'Dry goods', priceCents: 1200, stock: 8, imageUrl: null },
  { id: '2', name: 'Dates 1kg', description: null, category: 'Produce', priceCents: 700, stock: 6, imageUrl: null },
];

// Produce's first (and only) product has a photo -- Produce must render a
// TILE; Dry goods, still photo-less, must still render a PILL. A mixed row
// on purpose, the same mix the brief calls out as the intended look.
const productsWithPhoto: StorefrontProduct[] = [
  { id: '1', name: 'Basmati Rice 5kg', description: null, category: 'Dry goods', priceCents: 1200, stock: 8, imageUrl: null },
  {
    id: '2', name: 'Dates 1kg', description: null, category: 'Produce', priceCents: 700, stock: 6,
    imageUrl: 'https://example.test/dates.jpg',
  },
];

const categories: StorefrontCategory[] = [
  { name: 'Dry goods', imageUrl: null, productCount: 18 },
  { name: 'Produce', imageUrl: 'https://example.test/produce.jpg', productCount: 9 },
];

function render(el: React.ReactElement) {
  let tree!: ReturnType<typeof create>;
  act(() => { tree = create(el); });
  return tree;
}

// Every host node under `root`, so a test can find an <Image> or a scrim
// without knowing the exact composite tree shape above it.
function hostNodesUnder(root: ReturnType<typeof create>['root']) {
  return root.findAll(() => true);
}

describe('firstPhotoByCategory', () => {
  it('picks the first photographed product per category, in catalogue order', () => {
    const list: StorefrontProduct[] = [
      { id: '1', name: 'A', description: null, category: 'Shirts', priceCents: 100, stock: 1, imageUrl: null },
      { id: '2', name: 'B', description: null, category: 'Shirts', priceCents: 100, stock: 1, imageUrl: 'https://x/b.jpg' },
      { id: '3', name: 'C', description: null, category: 'Shirts', priceCents: 100, stock: 1, imageUrl: 'https://x/c.jpg' },
      { id: '4', name: 'D', description: null, category: 'Trousers', priceCents: 100, stock: 1, imageUrl: null },
    ];
    const photos = firstPhotoByCategory(list);
    expect(photos.get('Shirts')).toBe('https://x/b.jpg');
    expect(photos.has('Trousers')).toBe(false);
  });

  it('ignores products with no category and products with no photo', () => {
    const list: StorefrontProduct[] = [
      { id: '1', name: 'A', description: null, category: null, priceCents: 100, stock: 1, imageUrl: 'https://x/a.jpg' },
      { id: '2', name: 'B', description: null, category: 'Shirts', priceCents: 100, stock: 1, imageUrl: null },
    ];
    expect(firstPhotoByCategory(list).size).toBe(0);
  });
});

describe('when the band is worth showing', () => {
  it('renders nothing for a single category, which would filter to everything', () => {
    const tree = render(
      <CategoryBand categories={categories.slice(0, 1)} products={products} colors={colors} active={null} onSelect={jest.fn()} />,
    );
    expect(tree.toJSON()).toBeNull();
  });

  it('renders nothing for a shop with no categories at all', () => {
    const tree = render(<CategoryBand categories={[]} products={products} colors={colors} active={null} onSelect={jest.fn()} />);
    expect(tree.toJSON()).toBeNull();
  });

  it('renders at the minimum and above', () => {
    expect(CATEGORY_BAND_MINIMUM).toBe(2);
    const tree = render(<CategoryBand categories={categories} products={products} colors={colors} active={null} onSelect={jest.fn()} />);
    expect(tree.root.findAll((n) => n.props?.testID === 'storefront-category-band').length).toBeGreaterThan(0);
  });

  // The no-photo tile is the majority case -- most shops never photograph
  // every product in a category. It must read as designed, not as a missing
  // image, so it still renders the pill it always has -- NOT an empty tile
  // and NOT a placeholder image.
  it('renders the pill, not an empty tile, for a category with no photographed product', () => {
    const tree = render(<CategoryBand categories={categories} products={products} colors={colors} active={null} onSelect={jest.fn()} />);
    const control = tree.root.findAll(
      (n) => n.props?.testID === 'storefront-category-Dry goods' && typeof n.props?.onPress === 'function',
    );
    expect(control).toHaveLength(1);
    // No Image under it -- the pill, not a photo tile with a missing source.
    const images = hostNodesUnder(control[0]).filter((n) => n.props?.source?.uri);
    expect(images).toHaveLength(0);
  });
});

describe('the photo tile', () => {
  it('renders the category’s first photographed product as its photo', () => {
    const tree = render(
      <CategoryBand categories={categories} products={productsWithPhoto} colors={colors} active={null} onSelect={jest.fn()} />,
    );
    const control = tree.root.findAll(
      (n) => n.props?.testID === 'storefront-category-Produce' && typeof n.props?.onPress === 'function',
    )[0];
    const image = hostNodesUnder(control).find((n) => n.props?.source?.uri);
    expect(image?.props.source).toEqual({ uri: 'https://example.test/dates.jpg' });
  });

  function chipBackground(tree: ReturnType<typeof create>, name: string): unknown {
    const chip = tree.root.findAll((n) => n.props?.testID === `storefront-category-${name}-chip`)[0];
    const flat = [chip.props.style].flat(Infinity).filter(Boolean).reduce((acc, s) => ({ ...(acc as object), ...(s as object) }), {});
    return (flat as { backgroundColor?: unknown }).backgroundColor;
  }

  it('shows an accent-filled chip, not a ring or border, on the active tile', () => {
    const active = render(
      <CategoryBand categories={categories} products={productsWithPhoto} colors={colors} active="Produce" onSelect={jest.fn()} />,
    );
    expect(chipBackground(active, 'Produce')).toBe(colors.accent);

    const inactive = render(
      <CategoryBand categories={categories} products={productsWithPhoto} colors={colors} active={null} onSelect={jest.fn()} />,
    );
    expect(chipBackground(inactive, 'Produce')).toBeUndefined();
  });

  it('marks the tile itself, not only the chip, as the selected control', () => {
    const tree = render(
      <CategoryBand categories={categories} products={productsWithPhoto} colors={colors} active="Produce" onSelect={jest.fn()} />,
    );
    const tile = tree.root.findAll(
      (n) => n.props?.testID === 'storefront-category-Produce' && typeof n.props?.onPress === 'function',
    );
    expect(tile[0].props.accessibilityState).toEqual({ selected: true });
  });
});

// The point of the whole component: it drives the SAME state a flyer already
// sets, so the way back out (CategoryFilterBar) is already correct and there is
// one answer on the page to "what is on show". Task 15 changed presentation
// only -- these behaviours must be byte-identical to before it.
describe('the band drives the existing category filter, unchanged', () => {
  it('narrows the grid to the category tapped, via a pill', async () => {
    let tree!: ReturnType<typeof create>;
    await act(async () => {
      tree = create(<ThemeMarket storefront={shop} products={products} colors={colors} categories={categories} />);
    });

    const texts = () => tree.root
      .findAll((n) => n.props?.children !== undefined)
      .flatMap((n) => [n.props.children].flat(Infinity))
      .filter((c): c is string => typeof c === 'string')
      .join(' ');

    expect(texts()).toContain('Dates 1kg');

    const pill = tree.root.findAll(
      (n) => n.props?.testID === 'storefront-category-Dry goods' && typeof n.props?.onPress === 'function',
    );
    await act(async () => pill[0].props.onPress());

    expect(texts()).toContain('Basmati Rice 5kg');
    expect(texts()).not.toContain('Dates 1kg');
  });

  // Same assertion, tapping the PHOTO TILE this time -- proof that which
  // shape a category renders as never changes what tapping it does.
  it('narrows the grid to the category tapped, via a photo tile', async () => {
    let tree!: ReturnType<typeof create>;
    await act(async () => {
      tree = create(<ThemeMarket storefront={shop} products={productsWithPhoto} colors={colors} categories={categories} />);
    });

    const texts = () => tree.root
      .findAll((n) => n.props?.children !== undefined)
      .flatMap((n) => [n.props.children].flat(Infinity))
      .filter((c): c is string => typeof c === 'string')
      .join(' ');

    expect(texts()).toContain('Basmati Rice 5kg');

    const tile = tree.root.findAll(
      (n) => n.props?.testID === 'storefront-category-Produce' && typeof n.props?.onPress === 'function',
    );
    await act(async () => tile[0].props.onPress());

    expect(texts()).toContain('Dates 1kg');
    expect(texts()).not.toContain('Basmati Rice 5kg');

    // And clearing it via CategoryFilterBar's own chip is unchanged too.
    const clear = tree.root.findAll(
      (n) => n.props?.testID === 'storefront-category-clear' && typeof n.props?.onPress === 'function',
    );
    expect(clear).toHaveLength(1);
    await act(async () => clear[0].props.onPress());
    expect(texts()).toContain('Basmati Rice 5kg');
    expect(texts()).toContain('Dates 1kg');
  });
});

// FIX 1: the requirement ("sliding active pill on the category bar") names
// THIS surface, not ShopTabRail's page tabs -- see shop-tabs.tsx's own
// pillMotion tests for that surface's twin coverage.
//
// The indicator's WIDTH/SHAPE come from plain React state and can be read
// off a render, same as any other style. Its POSITION cannot: it lives on a
// Reanimated shared value, and this repo's shared reanimated jest mock backs
// `useSharedValue` with a bare object rather than a ref, so a mutation to it
// does not survive a re-render triggered by anything else -- including this
// band's OWN `indicatorBox` state update, which fires in the very same
// handler. That is a sharper version of the limitation shop-tabs.tsx's own
// comment already names ("nothing about a shared value reaching a position
// can be asserted through a render"), so `activeCategoryBox` -- the pure
// lookup that decides POSITION -- is what "selecting a different category
// moves it" is proven against directly, the same way shop-tabs.tsx proves
// its own spring-vs-snap decision through `pillMotion` rather than a render.
describe('the sliding indicator (Fix 1: lives on the category bar)', () => {
  function flattenStyle(style: unknown): Record<string, unknown> {
    return [style]
      .flat(Infinity)
      .filter(Boolean)
      .reduce((acc, s) => ({ ...(acc as object), ...(s as object) }), {}) as Record<string, unknown>;
  }

  function indicatorOf(tree: ReturnType<typeof create>) {
    return tree.root.findAll((n) => n.props?.testID === 'storefront-category-indicator')[0];
  }

  function fireLayout(tree: ReturnType<typeof create>, testID: string, x: number, width: number) {
    const target = tree.root.findAll(
      (n) => n.props?.testID === testID && typeof n.props?.onLayout === 'function',
    )[0];
    act(() => {
      (target.props.onLayout as (e: unknown) => void)({ nativeEvent: { layout: { x, y: 0, width, height: 0 } } });
    });
  }

  it('renders no indicator while nothing is selected', () => {
    const tree = render(
      <CategoryBand categories={categories} products={productsWithPhoto} colors={colors} active={null} onSelect={jest.fn()} />,
    );
    expect(tree.root.findAll((n) => n.props?.testID === 'storefront-category-indicator')).toHaveLength(0);
  });

  it('exists and sizes itself to the measured width of the active photo TILE', () => {
    const tree = render(
      <CategoryBand categories={categories} products={productsWithPhoto} colors={colors} active="Produce" onSelect={jest.fn()} />,
    );
    fireLayout(tree, 'storefront-category-Produce', 140, 136);

    const flat = flattenStyle(indicatorOf(tree).props.style);
    expect(flat.width).toBe(136);
    expect(flat.borderRadius).toBe(RADIUS.inset);
  });

  it('sizes itself to the measured width of the active text PILL, and reshapes to match', () => {
    const tree = render(
      <CategoryBand categories={categories} products={productsWithPhoto} colors={colors} active="Dry goods" onSelect={jest.fn()} />,
    );
    fireLayout(tree, 'storefront-category-Dry goods', 8, 92);

    const flat = flattenStyle(indicatorOf(tree).props.style);
    expect(flat.width).toBe(92);
    expect(flat.borderRadius).toBe(RADIUS.pill);
  });

  // The mix Task 15 introduced, and the exact case Fix 1's brief calls out:
  // one indicator has to track BOTH shapes as selection moves between them,
  // in the same mounted band (an `.update`, not a fresh `render`) -- a
  // remount would trivially "pass" by starting the new box from zero. This
  // is the WIDTH half of "moves" -- a render can show this much; see
  // `activeCategoryBox`, below, for the POSITION half it cannot.
  it('reshapes its width when selection moves from a photo tile to a text pill', () => {
    let tree!: ReturnType<typeof create>;
    act(() => {
      tree = create(
        <CategoryBand categories={categories} products={productsWithPhoto} colors={colors} active="Produce" onSelect={jest.fn()} />,
      );
    });
    fireLayout(tree, 'storefront-category-Produce', 0, 136);
    fireLayout(tree, 'storefront-category-Dry goods', 144, 92);

    const before = flattenStyle(indicatorOf(tree).props.style);
    expect(before.width).toBe(136);
    expect(before.borderRadius).toBe(RADIUS.inset);

    act(() => {
      tree.update(
        <CategoryBand categories={categories} products={productsWithPhoto} colors={colors} active="Dry goods" onSelect={jest.fn()} />,
      );
    });

    const after = flattenStyle(indicatorOf(tree).props.style);
    expect(after.width).toBe(92);
    expect(after.borderRadius).toBe(RADIUS.pill);
  });

  // The filter this band drives must stay byte-identical -- Fix 1's own
  // constraint. The indicator is purely decorative: proving the same tap
  // that now also moves a sliding box still narrows the grid exactly as the
  // pre-existing "the band drives the existing category filter" suite (just
  // below) already proves is the real regression guard; this adds only the
  // missing half, that the indicator itself picks up the RIGHT width for the
  // tapped item, via the real onPress -> onSelect -> active prop path rather
  // than a hand-fired layout event standing in for it.
  it('tracks the tile actually tapped, through the real onSelect callback', () => {
    let category: string | null = null;
    const onSelect = jest.fn((next: string) => { category = next; });
    let tree!: ReturnType<typeof create>;
    const renderWith = () => (
      <CategoryBand categories={categories} products={productsWithPhoto} colors={colors} active={category} onSelect={onSelect} />
    );
    act(() => { tree = create(renderWith()); });
    fireLayout(tree, 'storefront-category-Produce', 200, 136);

    const tile = tree.root.findAll(
      (n) => n.props?.testID === 'storefront-category-Produce' && typeof n.props?.onPress === 'function',
    )[0];
    act(() => { tile.props.onPress(); });
    act(() => { tree.update(renderWith()); });

    expect(onSelect).toHaveBeenCalledWith('Produce');
    expect(flattenStyle(indicatorOf(tree).props.style).width).toBe(136);
  });
});

// THE POSITION HALF of "selecting a different category moves it" --
// `activeCategoryBox` is the pure lookup CategoryBand's effect calls to
// decide where the indicator travels to, pulled out for the reason its own
// header comment gives: a render cannot show a Reanimated shared value's
// position reliably under this repo's shared jest mock. Two different
// `active` values against the identical `layouts` map producing two
// different boxes is the whole of what "moves" means here -- the same shape
// of proof shop-tabs.tsx's `pillMotion` tests give their own surface.
describe('activeCategoryBox: which box the indicator targets', () => {
  const layouts = {
    Produce: { x: 0, width: 136, radius: RADIUS.inset },
    'Dry goods': { x: 144, width: 92, radius: RADIUS.pill },
  };

  it('targets the active category’s own measured box', () => {
    expect(activeCategoryBox('Produce', layouts)).toEqual({ x: 0, width: 136, radius: RADIUS.inset });
  });

  it('moves -- a different active category targets a different box entirely', () => {
    expect(activeCategoryBox('Dry goods', layouts)).toEqual({ x: 144, width: 92, radius: RADIUS.pill });
  });

  it('targets nothing while no category is selected', () => {
    expect(activeCategoryBox(null, layouts)).toBeNull();
  });

  it('targets nothing for a category that has never reported a layout', () => {
    expect(activeCategoryBox('Unlisted', layouts)).toBeNull();
  });
});

// Counter groups by category already, and a shop picks it for density -- the
// same reasoning that keeps flyers off it, pinned in
// storefront-flyer-placement.test.tsx.
describe('Counter gets no band', () => {
  it('renders none even when categories are passed', () => {
    let tree!: ReturnType<typeof create>;
    act(() => {
      tree = create(
        <ThemeCounter
          storefront={{ ...shop, theme: 'counter' }}
          products={products}
          colors={colors}
          categories={categories}
        />,
      );
    });
    expect(tree.root.findAll((n) => n.props?.testID === 'storefront-category-band')).toHaveLength(0);
  });
});
