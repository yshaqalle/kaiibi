import { act, create, type ReactTestRenderer, type ReactTestRendererJSON } from 'react-test-renderer';

// Lives here rather than beside the screen ON PURPOSE -- see
// inventory-caveats.test.tsx: expo-router builds its route table from
// `require.context(src/app)`, and nothing on that scan skips `.test.tsx`. A
// test file under src/app would become a real route shipped in the bundle.

jest.mock('@/lib/supabase', () => ({ supabase: {} }));
jest.mock('expo-router', () => ({ useLocalSearchParams: () => ({ slug: 'xamdi' }) }));
jest.mock('@/lib/storefront', () => ({
  getPublicStorefront: jest.fn(),
  getPublicStorefrontProducts: jest.fn(),
  waLink: (e: string, m: string) => `https://wa.me/${e.replace(/^\+/, '')}?text=${encodeURIComponent(m)}`,
}));

import { getPublicStorefront, getPublicStorefrontProducts } from '@/lib/storefront';
import StorefrontScreen from '@/app/s/[slug]';

function textsIn(node: ReactTestRendererJSON | ReactTestRendererJSON[] | string | null): string[] {
  if (node == null) return [];
  if (typeof node === 'string') return [node];
  if (Array.isArray(node)) return node.flatMap(textsIn);
  return textsIn(node.children as ReactTestRendererJSON[] | null);
}

async function render(): Promise<ReactTestRenderer> {
  let tree: ReactTestRenderer | undefined;
  await act(async () => {
    tree = create(<StorefrontScreen />);
  });
  return tree!;
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

describe('storefront route', () => {
  beforeEach(() => jest.clearAllMocks());

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
});
