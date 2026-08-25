import ExpoHead from 'expo-router/head';
import { Platform } from 'react-native';
import { act, create, type ReactTestRenderer, type ReactTestRendererJSON } from 'react-test-renderer';

// Lives here rather than beside the screen ON PURPOSE -- see
// inventory-caveats.test.tsx: expo-router builds its route table from
// `require.context(src/app)`, and nothing on that scan skips `.test.tsx`. A
// test file under src/app would become a real route shipped in the bundle.

jest.mock('@/lib/supabase', () => ({ supabase: {} }));

// Prefixed `mock` -- babel-plugin-jest-hoist only permits identifiers with
// that prefix to be closed over by a jest.mock() factory (see
// storefront-order.ts's task-7 report for the same trap).
let mockSlug = 'xamdi';
jest.mock('expo-router', () => ({ useLocalSearchParams: jest.fn(() => ({ slug: mockSlug })) }));
jest.mock('@/lib/storefront', () => ({
  getPublicStorefront: jest.fn(),
  getPublicStorefrontProducts: jest.fn(),
  getPublicDeliveryAreas: jest.fn(),
  waLink: (e: string, m: string) => `https://wa.me/${e.replace(/^\+/, '')}?text=${encodeURIComponent(m)}`,
}));
// Placing an order is Task 7's job (storefront-order.test.ts covers the RPC
// call, the message and the cart-clearing rule) -- this route test only has
// to prove Task 8's wiring calls the right one of these two and reaches the
// confirmation screen, so the module is mocked wholesale rather than driven
// through a fake supabase.rpc.
jest.mock('@/lib/storefront-order', () => ({
  placeOrder: jest.fn(),
  placeOrderViaWhatsApp: jest.fn(),
}));

import { getPublicDeliveryAreas, getPublicStorefront, getPublicStorefrontProducts } from '@/lib/storefront';
import { placeOrder, placeOrderViaWhatsApp } from '@/lib/storefront-order';
import StorefrontScreen from '@/app/s/[slug]';

function textsIn(node: ReactTestRendererJSON | ReactTestRendererJSON[] | string | null): string[] {
  if (node == null) return [];
  if (typeof node === 'string') return [node];
  if (Array.isArray(node)) return node.flatMap(textsIn);
  return textsIn(node.children as ReactTestRendererJSON[] | null);
}

// Pressable is composite and forwards testID down through a forwardRef View
// to its own host node, so one on-screen button surfaces as several matches
// -- only the outermost instance carries `onPress`. Same helper
// storefront-theme-counter.test.tsx uses.
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

async function render(): Promise<ReactTestRenderer> {
  let tree: ReactTestRenderer | undefined;
  await act(async () => {
    tree = create(<StorefrontScreen />);
  });
  return tree!;
}

async function flush(tree: ReactTestRenderer) {
  await act(async () => {
    await Promise.resolve();
  });
  return tree;
}

const shop = {
  shopName: 'Xamdi Electronics',
  city: 'Hargeisa',
  slug: 'xamdi',
  whatsappE164: '+252634456789',
  theme: 'market',
  palette: 'ink',
  headline: 'Everything for the house and the phone.',
  about: null,
  heroImageUrl: null,
  offersDelivery: true,
  paymentMode: 'on_collection' as const,
};

const products = [
  { id: 'p1', name: 'Soap', description: null, category: null, priceCents: 500, stock: 5, imageUrl: null },
];

const placedOrder = {
  number: 42,
  status: 'placed',
  paymentMode: 'on_collection',
  fulfilment: 'collect' as const,
  deliveryArea: null,
  customerPhone: '+252634456789',
  subtotalCents: 500,
  deliveryFeeCents: 0,
  totalCents: 500,
  items: [{ productId: 'p1', name: 'Soap', unitPriceCents: 500, quantity: 1, lineTotalCents: 500 }],
};

async function addOneToCart(tree: ReactTestRenderer) {
  press(tree, 'product-tile-add');
  await flush(tree);
}

async function goToCheckout(tree: ReactTestRenderer) {
  await addOneToCart(tree);
  press(tree, 'storefront-checkout-bar');
  await flush(tree);
}

function fillRequiredCheckoutFields(tree: ReactTestRenderer) {
  setText(tree, 'checkout-form-name-input', 'Amina Warsame');
  setText(tree, 'checkout-form-phone-input', '0634456789');
}

// Jest's RN environment has a `window` but no real storage, and the cart's
// native path (storefront-cart.ts's `nativeCache`) is a module-level Map with
// no reset hook by design -- so without this, every basket added in one test
// would still be sitting there for the next. Forcing 'web' and giving it a
// fake, clearable localStorage is the same setup storefront-cart.test.ts
// uses, and it is also the platform that matters here: the storefront route
// only ever resolves by hostname, a web concept.
const webStorage = new Map<string, string>();
const fakeLocalStorage = {
  getItem: (key: string) => webStorage.get(key) ?? null,
  setItem: (key: string, value: string) => void webStorage.set(key, value),
  removeItem: (key: string) => void webStorage.delete(key),
};
Object.defineProperty(window, 'localStorage', { configurable: true, value: fakeLocalStorage });
Object.defineProperty(Platform, 'OS', { value: 'web', configurable: true });

describe('storefront route', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSlug = 'xamdi';
    webStorage.clear();
    (getPublicDeliveryAreas as jest.Mock).mockResolvedValue([]);
  });

  it('renders the shop once loaded', async () => {
    (getPublicStorefront as jest.Mock).mockResolvedValue(shop);
    (getPublicStorefrontProducts as jest.Mock).mockResolvedValue([]);
    const tree = await render();
    const texts = textsIn(tree.toJSON() as ReactTestRendererJSON);
    expect(texts).toContain('Xamdi Electronics');
  });

  // THE LOAD-BEARING CASE. If a draft shop rendered anything different from an
  // unknown slug, the subdomain would become an oracle: someone could walk
  // names and learn which shops exist on kaiibi before they open.
  it('shows the same page for a draft shop as for one that does not exist', async () => {
    (getPublicStorefront as jest.Mock).mockResolvedValue(null);
    (getPublicStorefrontProducts as jest.Mock).mockResolvedValue([]);
    const tree = await render();
    const texts = textsIn(tree.toJSON() as ReactTestRendererJSON);
    expect(texts).toContain("There's no shop at this address.");
  });

  // A failed read is the same case again -- an error page would confirm the
  // shop exists, so a thrown RPC must land on the identical missing page.
  it('shows the same missing page when the read throws', async () => {
    (getPublicStorefront as jest.Mock).mockRejectedValue(new Error('network down'));
    (getPublicStorefrontProducts as jest.Mock).mockResolvedValue([]);
    const tree = await render();
    const texts = textsIn(tree.toJSON() as ReactTestRendererJSON);
    expect(texts).toContain("There's no shop at this address.");
  });

  // The regression guard the brief asks for: a draft shop (null row) and a
  // failed read must produce the EXACT same tree, not merely the same
  // headline text -- any cart/checkout/confirmation markup this task adds
  // must never leak into either path.
  it('renders byte-identical trees for a draft shop and a failed read', async () => {
    (getPublicStorefront as jest.Mock).mockResolvedValueOnce(null);
    (getPublicStorefrontProducts as jest.Mock).mockResolvedValue([]);
    const draftTree = await render();
    const draftJson = JSON.stringify(draftTree.toJSON());

    (getPublicStorefront as jest.Mock).mockRejectedValueOnce(new Error('network down'));
    const failedTree = await render();
    const failedJson = JSON.stringify(failedTree.toJSON());

    expect(draftJson).toEqual(failedJson);
  });

  // No document head at all for the missing state -- not merely a blank
  // title. `expo-router/head`'s `Head` is a composite component; even though
  // it renders through react-helmet-async (which does not put a host node
  // into this tree either way), asserting it is absent from the *element*
  // tree via `findAllByType` is what actually proves `StorefrontHead` was
  // never reached, which `tree.toJSON()` text alone cannot show.
  it('mounts no Head component for a draft shop, an unknown slug, or a failed read', async () => {
    (getPublicStorefront as jest.Mock).mockResolvedValueOnce(null);
    (getPublicStorefrontProducts as jest.Mock).mockResolvedValue([]);
    const draftTree = await render();
    expect(draftTree.root.findAllByType(ExpoHead)).toHaveLength(0);

    (getPublicStorefront as jest.Mock).mockRejectedValueOnce(new Error('network down'));
    const failedTree = await render();
    expect(failedTree.root.findAllByType(ExpoHead)).toHaveLength(0);
  });

  it('mounts exactly one Head component once the shop has loaded', async () => {
    (getPublicStorefront as jest.Mock).mockResolvedValue(shop);
    (getPublicStorefrontProducts as jest.Mock).mockResolvedValue([]);
    const tree = await render();
    expect(tree.root.findAllByType(ExpoHead)).toHaveLength(1);
  });

  describe('cart, checkout and confirmation', () => {
    beforeEach(() => {
      (getPublicStorefront as jest.Mock).mockResolvedValue(shop);
      (getPublicStorefrontProducts as jest.Mock).mockResolvedValue(products);
    });

    it('goes from browsing to a placed order on the same screen, with no route change', async () => {
      (placeOrderViaWhatsApp as jest.Mock).mockResolvedValue(placedOrder);
      const tree = await render();

      await goToCheckout(tree);
      expect(textsIn(tree.toJSON() as ReactTestRendererJSON)).toContain('Checkout');

      fillRequiredCheckoutFields(tree);
      press(tree, 'checkout-form-submit');
      await flush(tree);

      // Still the very same StorefrontScreen instance -- render() was called
      // exactly once for this test, so reaching the confirmation text proves
      // the whole browse -> cart -> checkout -> confirmation journey happened
      // without expo-router ever being asked for a different route.
      const texts = textsIn(tree.toJSON() as ReactTestRendererJSON).join(' ');
      expect(texts).toContain('42');
      expect(placeOrderViaWhatsApp).toHaveBeenCalledWith(
        'xamdi',
        expect.objectContaining({ lines: expect.arrayContaining([expect.objectContaining({ productId: 'p1', quantity: 1 })]) }),
        expect.objectContaining({ name: 'Amina Warsame', phone: '+252634456789' }),
        'Xamdi Electronics',
        '+252634456789'
      );
      expect(placeOrder).not.toHaveBeenCalled();
    });

    // Property 4. Only Ask disappears without a number -- selling never
    // depends on the question channel.
    it('still takes the order when the shop has no WhatsApp number', async () => {
      (getPublicStorefront as jest.Mock).mockResolvedValue({ ...shop, whatsappE164: null });
      (placeOrder as jest.Mock).mockResolvedValue(placedOrder);
      const tree = await render();

      await goToCheckout(tree);
      fillRequiredCheckoutFields(tree);
      press(tree, 'checkout-form-submit');
      await flush(tree);

      const texts = textsIn(tree.toJSON() as ReactTestRendererJSON).join(' ');
      expect(texts).toContain('42');
      expect(placeOrder).toHaveBeenCalledWith('xamdi', expect.anything(), expect.objectContaining({ name: 'Amina Warsame' }));
      expect(placeOrderViaWhatsApp).not.toHaveBeenCalled();
    });

    it('keeps the cart and reports the failure rather than losing the basket on a rejected order', async () => {
      (placeOrderViaWhatsApp as jest.Mock).mockRejectedValue(new Error('rate limited'));
      const tree = await render();

      await goToCheckout(tree);
      fillRequiredCheckoutFields(tree);
      press(tree, 'checkout-form-submit');
      await flush(tree);

      // Still on checkout, not bounced back to an empty basket -- and the
      // typed name is still in the field because CheckoutForm never
      // unmounted.
      expect(textsIn(tree.toJSON() as ReactTestRendererJSON)).toContain('Checkout');
      const nameInput = tree.root.findAll((n) => n.props?.testID === 'checkout-form-name-input');
      expect(nameInput[0].props.value).toBe('Amina Warsame');
    });

    it('the cart survives a reload of the same shop\'s page', async () => {
      const first = await render();
      await addOneToCart(first);
      expect(textsIn(first.toJSON() as ReactTestRendererJSON)).toContain('Basket · 1');

      // A reload is a fresh mount of the same route, not a state carried
      // forward in memory -- storefront-cart.ts persists to
      // window.localStorage keyed by slug, so a brand new StorefrontScreen
      // instance for the same shop must still see it.
      const second = await render();
      expect(textsIn(second.toJSON() as ReactTestRendererJSON)).toContain('Basket · 1');
    });

    it("a second shop's cart stays separate", async () => {
      const first = await render();
      await addOneToCart(first);
      expect(textsIn(first.toJSON() as ReactTestRendererJSON)).toContain('Basket · 1');

      mockSlug = 'other-shop';
      (getPublicStorefront as jest.Mock).mockResolvedValue({ ...shop, slug: 'other-shop', shopName: 'Other Shop' });
      const second = await render();
      expect(textsIn(second.toJSON() as ReactTestRendererJSON)).not.toContain('Basket · 1');
    });
  });
});
