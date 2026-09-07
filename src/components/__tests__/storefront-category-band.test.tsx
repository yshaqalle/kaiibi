import { AccessibilityInfo, StyleSheet, type EmitterSubscription } from 'react-native';
import { act, create } from 'react-test-renderer';

import { CATEGORY_BAND_MINIMUM, CategoryBand, firstPhotoByCategory } from '@/components/storefront/category-band';
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

// Task 8 (wave-review-fixes.md item 8): both of these render inside
// theme-market.tsx's `header`, itself a plain, unpadded child of the page
// ScrollView's own `contentContainerStyle` (`page: { padding: SPACE.page }`)
// -- the SAME already-padded column the anchor card, the goods grid and the
// footer all sit in with no padding of their own. CategoryBand's `band` and
// CategoryFilterBar's `filterChip` each ALSO carried their own horizontal
// inset on top of that shared one -- 16 (page) + 16 (band) = 32 for the
// first tile, 16 + 14 = 30 for the chip, against everything else's 16. The
// fix is that neither style should add anything of its own; these assert
// exactly that, resolved through `pressable()`'s own style FUNCTION for the
// chip (see storefront-touch-targets.test.tsx's identical `resolvedStyle`
// for why calling it with `{ pressed: false }` first is required, not
// optional) rather than a browser-measured pixel number this harness cannot
// lay out to reproduce.
function resolvedStyle(node: { props?: { style?: unknown } }): Record<string, unknown> {
  const raw = node.props?.style;
  const style = typeof raw === 'function' ? raw({ pressed: false }) : raw;
  return (StyleSheet.flatten(style as never) ?? {}) as Record<string, unknown>;
}

describe('the band and the filter chip add no inset of their own', () => {
  it('CategoryBand carries no horizontal padding beyond the page it already sits in', async () => {
    let tree!: ReturnType<typeof create>;
    await act(async () => {
      tree = create(<ThemeMarket storefront={shop} products={products} colors={colors} categories={categories} />);
    });

    const band = tree.root.findAll((n) => n.props?.testID === 'storefront-category-band')[0];
    const style = resolvedStyle(band);
    expect(style.paddingHorizontal ?? 0).toBe(0);
    expect(style.paddingLeft ?? 0).toBe(0);
    expect(style.paddingRight ?? 0).toBe(0);
  });

  it('CategoryFilterBar carries no horizontal margin beyond the page it already sits in', async () => {
    let tree!: ReturnType<typeof create>;
    await act(async () => {
      tree = create(<ThemeMarket storefront={shop} products={products} colors={colors} categories={categories} />);
    });

    // The chip renders only while a category is active -- select one first.
    const pill = tree.root.findAll(
      (n) => n.props?.testID === 'storefront-category-Dry goods' && typeof n.props?.onPress === 'function',
    );
    await act(async () => pill[0].props.onPress());

    const chip = tree.root.findAll(
      (n) => n.props?.testID === 'storefront-category-clear' && typeof n.props?.onPress === 'function',
    )[0];
    const style = resolvedStyle(chip);
    expect(style.marginHorizontal ?? 0).toBe(0);
    expect(style.marginLeft ?? 0).toBe(0);
    expect(style.marginRight ?? 0).toBe(0);
  });
});

// THE SLIDING INDICATOR that used to live here is gone: Task 15 made photo
// tiles the default, so on any shop with photographed products the
// ink-filled box painted BEHIND the items was never visible, and in a mixed
// row it materialised from nowhere the instant selection moved from a tile
// to a pill. The active category already has a visible signal without it --
// the tile's own accent-filled chip (proven above) and, restored here, the
// pill's own ink fill.
describe('the pill fallback carries its own selected fill, with no indicator behind it', () => {
  function flattenStyle(style: unknown): Record<string, unknown> {
    return [style]
      .flat(Infinity)
      .filter(Boolean)
      .reduce((acc, s) => ({ ...(acc as object), ...(s as object) }), {}) as Record<string, unknown>;
  }

  // `styles.pill` reaches the Pressable through `pressable()` (press-
  // feedback.ts), which wraps a base style in a `({ pressed }) => style`
  // function rather than handing RN a plain array -- the same shape
  // storefront-product-tile-web.test.tsx's own `styleFn({ pressed: false })`
  // unwraps for the identical reason.
  function pillStyleOf(tree: ReturnType<typeof create>, name: string) {
    const pill = tree.root.findAll(
      (n) => n.props?.testID === `storefront-category-${name}` && typeof n.props?.onPress === 'function',
    )[0];
    const styleFn = pill.props.style as (state: { pressed: boolean }) => unknown;
    return flattenStyle(styleFn({ pressed: false }));
  }

  it('fills itself with the palette ink when selected -- there is no indicator underneath to supply one', () => {
    const tree = render(
      <CategoryBand categories={categories} products={products} colors={colors} active="Dry goods" onSelect={jest.fn()} />,
    );
    expect(pillStyleOf(tree, 'Dry goods').backgroundColor).toBe(colors.ink);
  });

  it('stays unfilled when not selected', () => {
    const tree = render(
      <CategoryBand categories={categories} products={products} colors={colors} active={null} onSelect={jest.fn()} />,
    );
    expect(pillStyleOf(tree, 'Dry goods').backgroundColor).toBe(colors.ground);
  });

  it('mounts no sliding indicator node at all, selected or not', () => {
    const tree = render(
      <CategoryBand categories={categories} products={productsWithPhoto} colors={colors} active="Produce" onSelect={jest.fn()} />,
    );
    expect(tree.root.findAll((n) => n.props?.testID === 'storefront-category-indicator')).toHaveLength(0);
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
