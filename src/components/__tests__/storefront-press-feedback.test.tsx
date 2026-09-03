import { AccessibilityInfo, type EmitterSubscription } from 'react-native';
import { act, create } from 'react-test-renderer';

import { CartSheet } from '@/components/storefront/cart-sheet';
import { ThemeMarket } from '@/components/storefront/theme-market';
import { paletteColors } from '@/lib/storefront-catalog';
import type { PublicStorefront, StorefrontProduct } from '@/types/models';

jest.mock('@/lib/supabase', () => ({ supabase: {} }));

jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(false);
jest.spyOn(AccessibilityInfo, 'addEventListener').mockReturnValue({ remove: jest.fn() } as unknown as EmitterSubscription);

const colors = paletteColors('ink');

const shop: PublicStorefront = {
  shopName: 'Xamdi Electronics',
  city: 'Hargeisa',
  slug: 'xamdi-press',
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
  tradingSince: null, highlights: [],
  flyers: [],
  autoAdvance: false,
};

const products: StorefrontProduct[] = [
  { id: 'p1', name: 'Anker 20W charger', description: null, category: 'Phone', priceCents: 1200, stock: 5, imageUrl: null },
];

// A Pressable acknowledges a press by taking a FUNCTION for `style` -- RN
// calls it with `{ pressed }` and re-styles for the duration of the touch. A
// plain object cannot do that, so "is this style a function" is exactly the
// question "does this control respond to being pressed".
//
// Deliberately not asserting the specific opacity or transform: the point is
// that the control answers at all. Pinning the values here would make every
// future tuning of the press feel a test edit.
function respondsToPress(node: { props?: { style?: unknown } }): boolean {
  return typeof node.props?.style === 'function';
}

function pressablesIn(tree: ReturnType<typeof create>) {
  return tree.root.findAll(
    (n) => typeof n.props?.onPress === 'function' && n.props?.accessibilityRole === 'button',
  );
}

async function renderMarket() {
  let tree!: ReturnType<typeof create>;
  await act(async () => {
    tree = create(<ThemeMarket storefront={shop} products={products} colors={colors} />);
  });
  return tree;
}

// EVERY Pressable in the storefront used to take a plain style object, so a
// tap was registered and never acknowledged -- on a slow connection the
// customer taps Add again and orders two. This is the regression guard for
// that: not "the button we remembered to fix", but every button on the page.
describe('every storefront control acknowledges a press', () => {
  it('Market: no button is left with a static style', async () => {
    const tree = await renderMarket();
    const buttons = pressablesIn(tree);

    expect(buttons.length).toBeGreaterThan(0);
    const dead = buttons.filter((b) => !respondsToPress(b));
    expect(dead).toHaveLength(0);
  });

  it('the cart sheet: no button is left with a static style', async () => {
    let tree!: ReturnType<typeof create>;
    await act(async () => {
      tree = create(
        <CartSheet
          visible
          onClose={jest.fn()}
          cart={{ slug: shop.slug, lines: [{ productId: 'p1', name: 'Anker 20W charger', unitPriceCents: 1200, quantity: 2 }] }}
          colors={colors}
          onChangeQuantity={jest.fn()}
          onCheckout={jest.fn()}
        />,
      );
    });

    const buttons = pressablesIn(tree);
    expect(buttons.length).toBeGreaterThan(0);
    expect(buttons.filter((b) => !respondsToPress(b))).toHaveLength(0);
  });

  // The feedback must not swallow the thing it decorates. A style callback
  // that accidentally replaced onPress, or a Pressable wrapped in a
  // non-interactive View, would still satisfy the assertions above.
  it('still adds to the cart when pressed', async () => {
    const tree = await renderMarket();
    const add = tree.root.findAll(
      (n) => n.props?.testID === 'product-tile-add' && typeof n.props?.onPress === 'function',
    );

    await act(async () => add[0].props.onPress());

    const cartButton = tree.root.findAll(
      (n) => n.props?.testID === 'storefront-cart-button' && typeof n.props?.onPress === 'function',
    );
    expect(cartButton[0].props.accessibilityLabel).toBe('Open cart, 1 item');
  });
});
