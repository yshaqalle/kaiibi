import { AccessibilityInfo, type EmitterSubscription } from 'react-native';
import { act, create } from 'react-test-renderer';

import { ProductSheet } from '@/components/storefront/product-sheet';
import { ThemeMarket } from '@/components/storefront/theme-market';
import { paletteColors } from '@/lib/storefront-catalog';
import type { PublicStorefront, StorefrontProduct } from '@/types/models';

jest.mock('@/lib/supabase', () => ({ supabase: {} }));

jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(false);
jest.spyOn(AccessibilityInfo, 'addEventListener').mockReturnValue({ remove: jest.fn() } as unknown as EmitterSubscription);

const colors = paletteColors('ink');

const shop: PublicStorefront = {
  shopName: 'Barwaaqo Grocers',
  city: 'Hargeisa',
  slug: 'barwaaqo-sheet',
  whatsappE164: '+252634456789',
  theme: 'market',
  palette: 'ink',
  headline: null,
  about: null,
  heroImageUrl: null,
  offersDelivery: true,
  collectAddress: null,
  collectNeighborhood: null,
  paymentMode: 'on_collection',
  openingHours: {},
  flyers: [],
  autoAdvance: false,
};

const rice: StorefrontProduct = {
  id: 'p1',
  name: 'Basmati Rice 5kg',
  description: 'Long-grain, aged twelve months. We can split a sack between two customers.',
  category: 'Dry goods',
  priceCents: 1200,
  stock: 6,
  imageUrl: null,
};

function textsOf(tree: ReturnType<typeof create>): string {
  return tree.root
    .findAll((n) => n.props?.children !== undefined)
    .flatMap((n) => [n.props.children].flat(Infinity))
    .filter((c): c is string => typeof c === 'string')
    .join(' ');
}

// products.description has been selected by the public RPC and mapped in
// storefront.ts since the storefront shipped, and was rendered by NO theme.
// Shopkeepers typed it; no customer ever saw a word of it. These assert that
// it now reaches one -- through the grid, the way a customer would get there.
describe('a product description reaches the customer', () => {
  it('shows the description once the tile is opened', async () => {
    let tree!: ReturnType<typeof create>;
    await act(async () => {
      tree = create(<ThemeMarket storefront={shop} products={[rice]} colors={colors} />);
    });

    // Nothing of it on the grid itself -- a tile has no room for a paragraph.
    expect(textsOf(tree)).not.toContain('aged twelve months');

    const tile = tree.root.findAll(
      (n) => n.props?.testID === 'product-tile-open' && typeof n.props?.onPress === 'function',
    );
    expect(tile.length).toBeGreaterThan(0);

    await act(async () => tile[0].props.onPress());

    expect(textsOf(tree)).toContain('aged twelve months');
  });

  it('renders no description block when the shop left the field empty', () => {
    let tree!: ReturnType<typeof create>;
    act(() => {
      tree = create(
        <ProductSheet
          product={{ ...rice, description: null }}
          colors={colors}
          shopName={shop.shopName}
          whatsappE164={shop.whatsappE164}
          onClose={jest.fn()}
          onAdd={jest.fn()}
        />,
      );
    });

    expect(tree.root.findAll((n) => n.props?.testID === 'product-sheet-description')).toHaveLength(0);
  });

  // `product` IS the open/closed state -- a second `visible` flag is how a
  // sheet ends up open with nothing in it.
  it('renders nothing at all with no product', () => {
    let tree!: ReturnType<typeof create>;
    act(() => {
      tree = create(
        <ProductSheet
          product={null}
          colors={colors}
          shopName={shop.shopName}
          whatsappE164={shop.whatsappE164}
          onClose={jest.fn()}
          onAdd={jest.fn()}
        />,
      );
    });

    expect(tree.toJSON()).toBeNull();
  });

  it('adds to the cart and closes, so the cart count is not hidden behind it', () => {
    const onAdd = jest.fn();
    const onClose = jest.fn();
    let tree!: ReturnType<typeof create>;
    act(() => {
      tree = create(
        <ProductSheet
          product={rice}
          colors={colors}
          shopName={shop.shopName}
          whatsappE164={shop.whatsappE164}
          onClose={onClose}
          onAdd={onAdd}
        />,
      );
    });

    const add = tree.root.findAll(
      (n) => n.props?.testID === 'product-tile-add' && typeof n.props?.onPress === 'function',
    );
    act(() => add[0].props.onPress());

    expect(onAdd).toHaveBeenCalledWith(rice);
    expect(onClose).toHaveBeenCalled();
  });
});
