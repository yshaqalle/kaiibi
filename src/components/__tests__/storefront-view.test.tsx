import { act, create, type ReactTestRendererJSON } from 'react-test-renderer';

import { StorefrontView } from '@/components/storefront/storefront-view';
import type { PublicStorefront, StorefrontProduct } from '@/types/models';

jest.mock('@/lib/supabase', () => ({ supabase: {} }));

function textsIn(node: ReactTestRendererJSON | ReactTestRendererJSON[] | string | null): string[] {
  if (node == null) return [];
  if (typeof node === 'string') return [node];
  if (Array.isArray(node)) return node.flatMap(textsIn);
  return textsIn(node.children as ReactTestRendererJSON[] | null);
}

function renderView(storefront: PublicStorefront, products: StorefrontProduct[]): string[] {
  let tree: ReturnType<typeof create> | undefined;
  act(() => {
    tree = create(<StorefrontView storefront={storefront} products={products} />);
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
  paymentMode: 'on_collection',
  // No flyers: these fixtures predate them, and a shop with none must
  // render exactly as it did before they existed.
  flyers: [],
};

const products: StorefrontProduct[] = [
  { id: 'p1', name: 'Anker 20W charger', description: null, category: 'Phone', priceCents: 1200, stock: 5, imageUrl: null },
  { id: 'p2', name: 'LED bulb 9W', description: null, category: 'Light', priceCents: 600, stock: 0, imageUrl: null },
];

describe('StorefrontView', () => {
  it.each(['market', 'counter', 'window'])('renders every product under the %s theme', (theme) => {
    const texts = renderView({ ...shop, theme }, products);
    // Case-insensitive: Window renders the shop name through an all-caps nav
    // style (storefront.shopName.toUpperCase()), a deliberate stylistic
    // transform the other two themes don't apply. The assertion cares that the
    // name is present, not which case it renders in.
    expect(texts.some((t) => t.toUpperCase() === shop.shopName.toUpperCase())).toBe(true);
    expect(texts.filter((t) => t === 'Anker 20W charger').length).toBeGreaterThan(0);
    expect(texts.filter((t) => t === 'LED bulb 9W').length).toBeGreaterThan(0);
  });

  it('falls back to Market when the stored theme is unknown', () => {
    const texts = renderView({ ...shop, theme: 'editorial_film' }, products);
    expect(texts).toContain('Xamdi Electronics');
    expect(texts.filter((t) => t === 'Anker 20W charger').length).toBeGreaterThan(0);
  });

  it('falls back to Market when the stored theme is an inherited prototype property, not thrown or garbage', () => {
    let texts: string[] = [];
    expect(() => {
      texts = renderView({ ...shop, theme: 'constructor' }, products);
    }).not.toThrow();
    expect(texts).toContain('Xamdi Electronics');
    expect(texts.filter((t) => t === 'Anker 20W charger').length).toBeGreaterThan(0);
  });

  it('offers WhatsApp when there is a number', () => {
    const texts = renderView(shop, products);
    expect(texts.filter((t) => t === 'Message on WhatsApp').length).toBeGreaterThan(0);
  });

  it('offers no WhatsApp button when there is no number', () => {
    const texts = renderView({ ...shop, whatsappE164: null }, products);
    expect(texts.filter((t) => t === 'Message on WhatsApp').length).toBe(0);
  });

  it('shows an empty shop honestly rather than as a broken page', () => {
    const texts = renderView(shop, []);
    expect(texts).toContain('Nothing listed yet.');
  });
});
