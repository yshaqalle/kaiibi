import { AccessibilityInfo, type EmitterSubscription } from 'react-native';
import { act, create } from 'react-test-renderer';

import { CATEGORY_BAND_MINIMUM, CategoryBand } from '@/components/storefront/category-band';
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
  openingHours: {}, flyers: [], autoAdvance: false,
};

const products: StorefrontProduct[] = [
  { id: '1', name: 'Basmati Rice 5kg', description: null, category: 'Dry goods', priceCents: 1200, stock: 8, imageUrl: null },
  { id: '2', name: 'Dates 1kg', description: null, category: 'Produce', priceCents: 700, stock: 6, imageUrl: null },
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

describe('when the band is worth showing', () => {
  it('renders nothing for a single category, which would filter to everything', () => {
    const tree = render(
      <CategoryBand categories={categories.slice(0, 1)} colors={colors} active={null} onSelect={jest.fn()} />,
    );
    expect(tree.toJSON()).toBeNull();
  });

  it('renders nothing for a shop with no categories at all', () => {
    const tree = render(<CategoryBand categories={[]} colors={colors} active={null} onSelect={jest.fn()} />);
    expect(tree.toJSON()).toBeNull();
  });

  it('renders at the minimum and above', () => {
    expect(CATEGORY_BAND_MINIMUM).toBe(2);
    const tree = render(<CategoryBand categories={categories} colors={colors} active={null} onSelect={jest.fn()} />);
    expect(tree.root.findAll((n) => n.props?.testID === 'storefront-category-band').length).toBeGreaterThan(0);
  });

  // The no-photo tile is the majority case -- categories.image_url is nullable
  // and joined by name to a table a shop may never have written to. It must
  // read as designed, not as a missing image, so it still renders a tile.
  it('renders a tile for a category with no photo', () => {
    const tree = render(<CategoryBand categories={categories} colors={colors} active={null} onSelect={jest.fn()} />);
    expect(
      tree.root.findAll((n) => n.props?.testID === 'storefront-category-Dry goods' && typeof n.props?.onPress === 'function'),
    ).toHaveLength(1);
  });
});

// The point of the whole component: it drives the SAME state a flyer already
// sets, so the way back out (CategoryFilterBar) is already correct and there is
// one answer on the page to "what is on show".
describe('the band drives the existing category filter', () => {
  it('narrows the grid to the category tapped', async () => {
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

    const tile = tree.root.findAll(
      (n) => n.props?.testID === 'storefront-category-Dry goods' && typeof n.props?.onPress === 'function',
    );
    await act(async () => tile[0].props.onPress());

    expect(texts()).toContain('Basmati Rice 5kg');
    expect(texts()).not.toContain('Dates 1kg');
  });

  it('marks the tile doing the filtering as selected', () => {
    const tree = render(
      <CategoryBand categories={categories} colors={colors} active="Produce" onSelect={jest.fn()} />,
    );
    const tile = tree.root.findAll(
      (n) => n.props?.testID === 'storefront-category-Produce' && typeof n.props?.onPress === 'function',
    );
    expect(tile[0].props.accessibilityState).toEqual({ selected: true });
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
