import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AccessibilityInfo, type EmitterSubscription } from 'react-native';
import { act, create, type ReactTestRendererJSON } from 'react-test-renderer';

import { StorefrontView } from '@/components/storefront/storefront-view';
import type { PublicStorefront, StorefrontProduct } from '@/types/models';

jest.mock('@/lib/supabase', () => ({ supabase: {} }));

// StorefrontView routes to ThemeMarket, which mounts FlyerCarousel even with
// no flyers (its hooks run unconditionally); Task 4's mount effect calls
// AccessibilityInfo.isReduceMotionEnabled(). Nothing here is about motion.
jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(false);
jest.spyOn(AccessibilityInfo, 'addEventListener').mockReturnValue({ remove: jest.fn() } as unknown as EmitterSubscription);

function textsIn(node: ReactTestRendererJSON | ReactTestRendererJSON[] | string | null): string[] {
  if (node == null) return [];
  if (typeof node === 'string') return [node];
  if (Array.isArray(node)) return node.flatMap(textsIn);
  return textsIn(node.children as ReactTestRendererJSON[] | null);
}

// ASYNC, and awaiting an async act(): StorefrontView routes through
// ThemeMarket/ThemeWindow, which mount FlyerCarousel unconditionally (Task
// 4's mount effect calls the mocked, promise-returning
// AccessibilityInfo.isReduceMotionEnabled()). A sync act() returns before
// that microtask settles, so its `.then` fires after the test -- and after
// Jest tears the test environment down -- producing exactly the "trying to
// `import` a file after the Jest environment has been torn down" warning
// this replaced.
async function renderView(storefront: PublicStorefront, products: StorefrontProduct[]): Promise<string[]> {
  let tree: ReturnType<typeof create> | undefined;
  await act(async () => {
    tree = create(
      // See storefront-view.tsx: it reads useSafeAreaInsets so the status bar
      // stops sitting on the WhatsApp and Cart buttons. react-navigation
      // supplies the provider around every screen in the real app; `create()`
      // mounts this component outside that tree, so the test supplies one.
      // Zero insets -- this file asserts on which theme rendered and what it
      // says, never on padding.
      <SafeAreaProvider
        initialMetrics={{
          frame: { x: 0, y: 0, width: 390, height: 844 },
          insets: { top: 0, left: 0, right: 0, bottom: 0 },
        }}
      >
        <StorefrontView storefront={storefront} products={products} />
      </SafeAreaProvider>,
    );
  });
  return textsIn(tree!.toJSON() as ReactTestRendererJSON);
}

const shop: PublicStorefront = {
  shopName: 'Xamdi Electronics',
  city: 'Hargeisa',
  slug: 'xamdi',
  whatsappE164: '+252634456789',
  theme: 'market',
  palette: 'ink',
  headline: 'Everything for the house and the phone.',
  about: 'Open 8am–9pm.',
  heroImageUrl: null,
  offersDelivery: true,
  collectAddress: null,
  collectNeighborhood: null,
  paymentMode: 'on_collection',
  openingHours: {},
  // No flyers: these fixtures predate them, and a shop with none must
  // render exactly as it did before they existed.
  flyers: [],
  autoAdvance: false,
};

const products: StorefrontProduct[] = [
  { id: 'p1', name: 'Anker 20W charger', description: null, category: 'Phone', priceCents: 1200, stock: 5, imageUrl: null },
  { id: 'p2', name: 'LED bulb 9W', description: null, category: 'Light', priceCents: 600, stock: 0, imageUrl: null },
];

describe('StorefrontView', () => {
  it.each(['market', 'counter', 'window'])('renders every product under the %s theme', async (theme) => {
    const texts = await renderView({ ...shop, theme }, products);
    // Case-insensitive: Window renders the shop name through an all-caps nav
    // style (storefront.shopName.toUpperCase()), a deliberate stylistic
    // transform the other two themes don't apply. The assertion cares that the
    // name is present, not which case it renders in.
    expect(texts.some((t) => t.toUpperCase() === shop.shopName.toUpperCase())).toBe(true);
    expect(texts.filter((t) => t === 'Anker 20W charger').length).toBeGreaterThan(0);
    expect(texts.filter((t) => t === 'LED bulb 9W').length).toBeGreaterThan(0);
  });

  it('falls back to Market when the stored theme is unknown', async () => {
    const texts = await renderView({ ...shop, theme: 'editorial_film' }, products);
    expect(texts).toContain('Xamdi Electronics');
    expect(texts.filter((t) => t === 'Anker 20W charger').length).toBeGreaterThan(0);
  });

  it('falls back to Market when the stored theme is an inherited prototype property, not thrown or garbage', async () => {
    let texts: string[] = [];
    await expect((async () => {
      texts = await renderView({ ...shop, theme: 'constructor' }, products);
    })()).resolves.not.toThrow();
    expect(texts).toContain('Xamdi Electronics');
    expect(texts.filter((t) => t === 'Anker 20W charger').length).toBeGreaterThan(0);
  });

  it('offers WhatsApp when there is a number', async () => {
    const texts = await renderView(shop, products);
    expect(texts.filter((t) => t === 'Message on WhatsApp').length).toBeGreaterThan(0);
  });

  it('offers no WhatsApp button when there is no number', async () => {
    const texts = await renderView({ ...shop, whatsappE164: null }, products);
    expect(texts.filter((t) => t === 'Message on WhatsApp').length).toBe(0);
  });

  it('shows an empty shop honestly rather than as a broken page', async () => {
    const texts = await renderView(shop, []);
    expect(texts).toContain('Nothing listed yet.');
  });
});
