import { AccessibilityInfo, type EmitterSubscription, Platform } from 'react-native';
import { act, create, type ReactTestRenderer, type ReactTestRendererJSON } from 'react-test-renderer';

// THE test the shipped defect needed and never got. Every other test that
// touches checkout (storefront-route.test.tsx, storefront-checkout-form.test.tsx)
// mocks '@/lib/storefront-order' wholesale -- which is correct for proving
// Task 8's WIRING, but it also means none of them can see all the way down
// to openExternalUrl, and the bug this file guards against lived exactly
// there: theme-shared.tsx chose placeOrderViaWhatsApp from whether the shop
// HAD a number, not from which button the customer pressed, so "Place
// order" silently opened a WhatsApp tab at any shop with one. Only
// storefront-order.ts's own openExternalUrl call, exercised for real, can
// prove that never happens -- so this file mocks just two things,
// '@/lib/supabase' (the RPC boundary) and '@/lib/external-url' (the DOM/tab
// boundary), and drives the real placeOrder/placeOrderViaWhatsApp
// (storefront-order.ts) through the real CheckoutForm and useCheckoutFlow
// (theme-shared.tsx), mounted via ThemeMarket.

const mockRpc = jest.fn();
jest.mock('@/lib/supabase', () => ({ supabase: { rpc: (...args: unknown[]) => mockRpc(...args) } }));

const mockOpenExternalUrl = jest.fn();
jest.mock('@/lib/external-url', () => ({ openExternalUrl: (...args: unknown[]) => mockOpenExternalUrl(...args) }));

// ThemeMarket mounts FlyerCarousel even with no flyers (its hooks run
// unconditionally); Task 4's mount effect calls
// AccessibilityInfo.isReduceMotionEnabled(). Nothing here is about motion.
jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(false);
jest.spyOn(AccessibilityInfo, 'addEventListener').mockReturnValue({ remove: jest.fn() } as unknown as EmitterSubscription);

import { ThemeMarket } from '@/components/storefront/theme-market';
import { paletteColors } from '@/lib/storefront-catalog';
import type { PublicStorefront, StorefrontProduct } from '@/types/models';

function textsIn(node: ReactTestRendererJSON | ReactTestRendererJSON[] | string | null): string[] {
  if (node == null) return [];
  if (typeof node === 'string') return [node];
  if (Array.isArray(node)) return node.flatMap(textsIn);
  return textsIn(node.children as ReactTestRendererJSON[] | null);
}

// Same helper storefront-route.test.tsx and storefront-theme-counter.test.tsx
// use: Pressable is composite and forwards testID down through a forwardRef
// View to its own host node, so only the outermost instance -- the one that
// actually carries `onPress` -- is the button itself.
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

// The same fake, clearable localStorage storefront-route.test.tsx sets up --
// storefront-cart.ts persists there on web, and the cart's native path is a
// module-level Map with no reset hook, so without this every cart added in
// one test would still be sitting there for the next.
const webStorage = new Map<string, string>();
const fakeLocalStorage = {
  getItem: (key: string) => webStorage.get(key) ?? null,
  setItem: (key: string, value: string) => void webStorage.set(key, value),
  removeItem: (key: string) => void webStorage.delete(key),
};
Object.defineProperty(window, 'localStorage', { configurable: true, value: fakeLocalStorage });
Object.defineProperty(Platform, 'OS', { value: 'web', configurable: true });

const storefront: PublicStorefront = {
  shopName: 'Xamdi Electronics',
  city: 'Hargeisa',
  slug: 'xamdi-wa-choice',
  whatsappE164: '+252634456789',
  theme: 'market',
  palette: 'ink',
  headline: null,
  about: null,
  heroImageUrl: null,
  offersDelivery: false,
  collectAddress: null,
  collectNeighborhood: null,
  paymentMode: 'on_collection',
  openingHours: {},
  tradingSince: null, highlights: [],
  // No flyers: these fixtures predate them, and a shop with none must
  // render exactly as it did before they existed.
  flyers: [],
  autoAdvance: false,
};

const products: StorefrontProduct[] = [
  { id: 'p1', name: 'Soap', description: null, category: null, priceCents: 500, stock: 5, imageUrl: null },
];

// The RPC's own RETURNING shape (snake_case), same as place_storefront_order
// -- see mapOrder in storefront-order.ts.
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

async function render(): Promise<ReactTestRenderer> {
  let tree: ReactTestRenderer | undefined;
  await act(async () => {
    tree = create(<ThemeMarket storefront={storefront} products={products} colors={paletteColors('ink')} areas={[]} />);
  });
  return tree!;
}

async function goToCheckout(tree: ReactTestRenderer) {
  press(tree, 'product-tile-add');
  await flush(tree);
  press(tree, 'storefront-checkout-bar');
  await flush(tree);
}

function fillRequiredCheckoutFields(tree: ReactTestRenderer) {
  setText(tree, 'checkout-form-name-input', 'Amina Warsame');
  setText(tree, 'checkout-form-phone-input', '0634456789');
}

describe('the WhatsApp choice at checkout, end to end through the real order functions', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    webStorage.clear();
    mockRpc.mockResolvedValue({ data: rpcOrderRow, error: null });
  });

  // THE regression test. `storefront` above has a WhatsApp number -- if this
  // ever regresses to choosing placeOrderViaWhatsApp from that number's mere
  // presence (the shipped defect), openExternalUrl fires and this fails.
  it('pressing "Place order" places the order and never opens an external URL, even with a WhatsApp number set', async () => {
    const tree = await render();

    await goToCheckout(tree);
    fillRequiredCheckoutFields(tree);
    press(tree, 'checkout-form-submit');
    await flush(tree);

    // The order really was placed -- reached confirmation, not stuck on an
    // error -- so a passing openExternalUrl assertion below isn't passing
    // for the wrong reason (the RPC call itself failing to fire).
    expect(mockRpc).toHaveBeenCalledTimes(1);
    expect(mockRpc).toHaveBeenCalledWith('place_storefront_order', expect.objectContaining({ p_slug: 'xamdi-wa-choice' }));
    const texts = textsIn(tree.toJSON() as ReactTestRendererJSON).join(' ');
    expect(texts).toContain('42');

    expect(mockOpenExternalUrl).not.toHaveBeenCalled();
  });

  it('pressing "Send this order on WhatsApp" places the order and then opens wa.me prefilled with it', async () => {
    const tree = await render();

    await goToCheckout(tree);
    fillRequiredCheckoutFields(tree);
    press(tree, 'checkout-form-submit-whatsapp');
    await flush(tree);

    expect(mockRpc).toHaveBeenCalledTimes(1);
    const texts = textsIn(tree.toJSON() as ReactTestRendererJSON).join(' ');
    expect(texts).toContain('42');

    expect(mockOpenExternalUrl).toHaveBeenCalledTimes(1);
    const [url] = mockOpenExternalUrl.mock.calls[0] as [string];
    expect(url).toContain('wa.me/252634456789');
    expect(url).toContain(encodeURIComponent('Order #42'));
  });
});
