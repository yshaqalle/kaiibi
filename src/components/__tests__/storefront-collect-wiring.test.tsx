import { AccessibilityInfo, type EmitterSubscription, Platform } from 'react-native';
import { act, create, type ReactTestRenderer, type ReactTestRendererJSON } from 'react-test-renderer';

// THE JOINS, and nothing else. Every COMPONENT of "say where to collect from"
// was already bound and mutation-proven -- collectLocation's composition rule
// (storefront-collect.test.ts), CheckoutForm's line (storefront-checkout-form
// .test.tsx), OrderPlaced's sentence (storefront-order-placed.test.tsx), the
// RPC column (supabase/tests) and the mapper (storefront.test.ts). What had no
// test at all was the WIRING between them, and there are four seams:
//
//   theme-shared.tsx:474   CheckoutScreen  -> CheckoutForm       (checkout)
//   theme-market.tsx:62    ThemeMarket     -> ConfirmationScreen (confirmation)
//   theme-counter.tsx:79   ThemeCounter    -> ConfirmationScreen (confirmation)
//   theme-window.tsx:60    ThemeWindow     -> ConfirmationScreen (confirmation)
//
// Each is a single `collectLocation={collectLocation(...)}` prop, and each
// could be deleted without a red test or a tsc error -- the prop is OPTIONAL
// on both CheckoutForm (checkout-form.tsx:65) and ConfirmationScreen
// (theme-shared.tsx:495), which it must be, so the type system cannot help.
// Deleting any one of them silently takes the pick-up address off a theme and
// puts back the exact defect the feature was built to remove.
//
// So these tests mount the REAL theme with a shop that has all three place
// fields set, drive it through checkout to confirmation, and assert the
// composed line is on the screen. No theme-shared component is imported
// directly: reaching for CheckoutForm or ConfirmationScreen here would test
// the callee again and leave the call site exactly as loose as it was.

const mockRpc = jest.fn();
jest.mock('@/lib/supabase', () => ({ supabase: { rpc: (...args: unknown[]) => mockRpc(...args) } }));

// Nothing here is about motion; the flyer band mounts unconditionally in the
// grid themes and its mount effect asks about reduced motion.
jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(false);
jest.spyOn(AccessibilityInfo, 'addEventListener').mockReturnValue({ remove: jest.fn() } as unknown as EmitterSubscription);

import { ThemeCounter } from '@/components/storefront/theme-counter';
import { ThemeMarket } from '@/components/storefront/theme-market';
import { ThemeWindow } from '@/components/storefront/theme-window';
import { paletteColors } from '@/lib/storefront-catalog';
import type { PublicStorefront, StorefrontProduct } from '@/types/models';

function textsIn(node: ReactTestRendererJSON | ReactTestRendererJSON[] | string | null): string[] {
  if (node == null) return [];
  if (typeof node === 'string') return [node];
  if (Array.isArray(node)) return node.flatMap(textsIn);
  return textsIn(node.children as ReactTestRendererJSON[] | null);
}

// Runs of whitespace collapse to one space. `<Text>Collect from {value}</Text>`
// arrives as two adjacent string children -- "Collect from " and the value --
// so joining them raw yields the double space a reader of the rendered screen
// would never see, and an assertion written the way the JSX reads would fail
// for a reason that has nothing to do with the wiring under test.
function screenText(tree: ReactTestRenderer): string {
  return textsIn(tree.toJSON() as ReactTestRendererJSON).join(' ').replace(/\s+/g, ' ').trim();
}

// Pressable is composite and forwards testID down through a forwardRef View to
// its own host node, so filtering on `onPress` gives one match per button --
// the same helper storefront-checkout-whatsapp-choice.test.tsx uses.
function findByTestId(tree: ReactTestRenderer, testID: string) {
  return tree.root.findAll((node) => node.props?.testID === testID && typeof node.props?.onPress === 'function');
}

function press(tree: ReactTestRenderer, testID: string) {
  const [node] = findByTestId(tree, testID);
  act(() => node.props.onPress());
}

function setText(tree: ReactTestRenderer, testID: string, value: string) {
  const [node] = tree.root.findAll((n) => n.props?.testID === testID && typeof n.props?.onChangeText === 'function');
  act(() => node.props.onChangeText(value));
}

async function flush(tree: ReactTestRenderer) {
  await act(async () => {
    await Promise.resolve();
  });
  return tree;
}

// storefront-cart.ts persists to localStorage on web and to a module-level Map
// with no reset hook on native, so without a clearable fake one test's basket
// leaks into the next.
const webStorage = new Map<string, string>();
Object.defineProperty(window, 'localStorage', {
  configurable: true,
  value: {
    getItem: (key: string) => webStorage.get(key) ?? null,
    setItem: (key: string, value: string) => void webStorage.set(key, value),
    removeItem: (key: string) => void webStorage.delete(key),
  },
});
Object.defineProperty(Platform, 'OS', { value: 'web', configurable: true });

// A COLLECT-ONLY shop with all three place fields set -- the shape this whole
// feature exists for. `offersDelivery: false` with no areas is what makes
// CheckoutForm hide the fulfilment chooser entirely and leave `fulfilment` at
// its 'collect' default, which is the case that used to tell the customer
// nothing about where to go.
const baseShop: Omit<PublicStorefront, 'slug' | 'theme'> = {
  shopName: 'Xamdi Electronics',
  city: 'Hargeisa',
  whatsappE164: null,
  palette: 'ink',
  headline: null,
  about: null,
  heroImageUrl: null,
  offersDelivery: false,
  collectAddress: 'Shop 12',
  collectNeighborhood: 'Jigjiga Yar',
  paymentMode: 'on_collection',
  flyers: [],
  autoAdvance: false,
};

// What collectLocation composes from the three fields above. Written out in
// full rather than by calling collectLocation, so this file fails if the
// composition changes AND if a join is cut -- a test that computed its own
// expectation from the same function under test could not tell the two apart.
const EXPECTED_LINE = 'Shop 12, Jigjiga Yar, Hargeisa';

const products: StorefrontProduct[] = [
  { id: 'p1', name: 'Soap', description: null, category: null, priceCents: 500, stock: 5, imageUrl: null },
];

// place_storefront_order's own RETURNING shape (snake_case) -- see mapOrder in
// storefront-order.ts.
const rpcOrderRow = {
  number: 42,
  status: 'placed',
  payment_mode: 'on_collection',
  fulfilment: 'collect',
  delivery_area: null,
  customer_phone: '+252634456789',
  subtotal_cents: 500,
  delivery_fee_cents: 0,
  total_cents: 500,
  items: [{ product_id: 'p1', name: 'Soap', unit_price_cents: 500, quantity: 1, line_total_cents: 500 }],
};

const THEMES = [
  { name: 'market', join: 'theme-market.tsx:62', Component: ThemeMarket },
  { name: 'counter', join: 'theme-counter.tsx:79', Component: ThemeCounter },
  { name: 'window', join: 'theme-window.tsx:60', Component: ThemeWindow },
] as const;

describe('the pick-up address is wired into every theme, at checkout and on the confirmation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    webStorage.clear();
    mockRpc.mockResolvedValue({ data: rpcOrderRow, error: null });
  });

  describe.each(THEMES)('$name', ({ name, join, Component }) => {
    async function render(slug: string) {
      let tree: ReactTestRenderer | undefined;
      await act(async () => {
        tree = create(
          <Component
            storefront={{ ...baseShop, slug, theme: name } as PublicStorefront}
            products={products}
            colors={paletteColors('ink')}
            areas={[]}
          />,
        );
      });
      return tree!;
    }

    async function goToCheckout(tree: ReactTestRenderer) {
      press(tree, 'product-tile-add');
      await flush(tree);
      press(tree, 'storefront-checkout-bar');
      await flush(tree);
    }

    // Binds theme-shared.tsx:474. CheckoutScreen is shared by all three
    // themes, so deleting that one line fails this test three times over --
    // which is the point: the seam is proven from every theme that crosses it,
    // not just from whichever one a future reader happens to open.
    it(`renders the pick-up address at checkout (join: theme-shared.tsx:474, via ${name})`, async () => {
      const tree = await render(`wiring-${name}-checkout`);
      await goToCheckout(tree);

      // The fixture really did reach checkout, so the assertion below cannot
      // pass for the wrong reason -- a negative or a substring test against a
      // screen that never rendered is the standing trap here.
      expect(screenText(tree)).toContain('Checkout');
      expect(screenText(tree)).toContain(`Collect from ${EXPECTED_LINE}`);
    });

    // Binds theme-{market,counter,window}.tsx's own ConfirmationScreen call.
    it(`renders the pick-up address on the confirmation (join: ${join})`, async () => {
      const tree = await render(`wiring-${name}-confirmation`);
      await goToCheckout(tree);
      setText(tree, 'checkout-form-name-input', 'Amina Warsame');
      setText(tree, 'checkout-form-phone-input', '0634456789');
      press(tree, 'checkout-form-submit');
      await flush(tree);

      // The order was actually placed and the screen really is the
      // confirmation -- otherwise "contains the line" could be passing off
      // the checkout screen it never left.
      expect(mockRpc).toHaveBeenCalledTimes(1);
      const texts = screenText(tree);
      expect(texts).toContain('42');
      expect(texts).toContain('Continue shopping');
      expect(texts).toContain(`Collect from ${EXPECTED_LINE}`);
    });
  });
});
