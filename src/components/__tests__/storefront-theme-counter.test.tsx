import { act, create, type ReactTestRendererJSON } from 'react-test-renderer';

import { ThemeCounter } from '@/components/storefront/theme-counter';
import { paletteColors } from '@/lib/storefront-catalog';
import type { PublicStorefront, StorefrontProduct } from '@/types/models';

jest.mock('@/lib/supabase', () => ({ supabase: {} }));

// `@testing-library/react-native` is not installed in this repo (see
// storefront-product-tile.test.tsx for the same pattern) -- flatten the
// rendered tree to strings instead of reaching for a query library the repo
// does not have.
function textsIn(node: ReactTestRendererJSON | ReactTestRendererJSON[] | string | null): string[] {
  if (node == null) return [];
  if (typeof node === 'string') return [node];
  if (Array.isArray(node)) return node.flatMap(textsIn);
  return textsIn(node.children as ReactTestRendererJSON[] | null);
}

const colors = paletteColors('ink');

const shop: PublicStorefront = {
  shopName: 'Xamdi Electronics',
  city: 'Hargeisa',
  slug: 'xamdi',
  whatsappE164: '+252634456789',
  theme: 'counter',
  palette: 'ink',
  headline: 'Everything for the house and the phone.',
  about: 'Open 8am–9pm, closed Fridays.',
  heroImageUrl: null,
  offersDelivery: true,
  paymentMode: 'on_collection',
};

const products: StorefrontProduct[] = [
  { id: 'p1', name: 'Anker 20W charger', description: null, category: 'Phone', priceCents: 1200, stock: 5, imageUrl: null },
];

function renderCounter(storefront: PublicStorefront) {
  let tree!: ReturnType<typeof create>;
  act(() => {
    tree = create(<ThemeCounter storefront={storefront} products={products} colors={colors} />);
  });
  return textsIn(tree.toJSON() as ReactTestRendererJSON);
}

describe('ThemeCounter', () => {
  it('renders the about text under the headline', () => {
    const texts = renderCounter(shop);
    expect(texts).toContain('Everything for the house and the phone.');
    expect(texts).toContain('Open 8am–9pm, closed Fridays.');
  });

  it('renders no about line when the shop has none', () => {
    const texts = renderCounter({ ...shop, about: null });
    expect(texts).not.toContain('Open 8am–9pm, closed Fridays.');
  });
});
