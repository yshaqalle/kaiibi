import { act, create, type ReactTestRendererJSON } from 'react-test-renderer';

import { ThemeCounter } from '@/components/storefront/theme-counter';
import { ThemeMarket } from '@/components/storefront/theme-market';
import { ThemeWindow } from '@/components/storefront/theme-window';
import { paletteColors } from '@/lib/storefront-catalog';
import type { PublicStorefront, StorefrontProduct } from '@/types/models';

jest.mock('@/lib/supabase', () => ({ supabase: {} }));

// Task 10: at a 390px viewport the header row (shop name + "Message on
// WhatsApp" + "Basket · N") did not fit, and the row overflowed the screen
// rather than dropping to a second line -- `right: 458` on a 390px viewport,
// with the basket button entirely off-screen and unreachable. A unit test
// cannot measure pixels or reproduce a real viewport, so this asserts the
// structural property that makes overflow possible in the first place: the
// header's own container must be allowed to wrap (`flexWrap: 'wrap'`), and
// nothing inside it may be pinned to a fixed pixel width that a 320-390px
// phone could not hold. Either regressing back to a rigid single-line row,
// or giving WhatsApp/Basket a fixed width wide enough to force one, fails
// this test before it ever needs a browser to catch it.
const colors = paletteColors('ink');

const shop: PublicStorefront = {
  shopName: 'Xamdi Electronics',
  city: 'Hargeisa',
  slug: 'xamdi-header-overflow',
  whatsappE164: '+252634456789',
  theme: 'market',
  palette: 'ink',
  headline: null,
  about: null,
  heroImageUrl: null,
  offersDelivery: true,
  paymentMode: 'on_collection',
};

const products: StorefrontProduct[] = [
  { id: 'p1', name: 'Anker 20W charger', description: null, category: 'Phone', priceCents: 1200, stock: 5, imageUrl: null },
];

function flatten(style: unknown): Record<string, unknown> {
  return [style].flat(Infinity).filter(Boolean).reduce((acc, s) => ({ ...(acc as object), ...(s as object) }), {}) as Record<
    string,
    unknown
  >;
}

// A rendered node is either a host element or a literal text string; the
// tree's `children` is a mix of both. Named so the two walkers below don't
// have to repeat react-test-renderer's own union.
type RenderedNode = ReactTestRendererJSON | string;

// The rendered tree has no query library (see storefront-theme-counter.test.tsx's
// identical note on `@testing-library/react-native` not being installed) --
// walk the plain JSON tree by hand instead.
function findByTestId(json: RenderedNode | RenderedNode[] | null, testID: string): ReactTestRendererJSON | null {
  if (json == null || typeof json === 'string') return null;
  if (Array.isArray(json)) {
    for (const child of json) {
      const found = findByTestId(child, testID);
      if (found) return found;
    }
    return null;
  }
  if (json.props?.testID === testID) return json;
  return findByTestId(json.children, testID);
}

// Every fixed pixel width anywhere inside the header -- a numeric `width` on
// any node in the subtree, however deep. Percentage widths (strings) are not
// collected: those already scale with the viewport and cannot be the cause
// of this defect class.
function fixedWidthsIn(json: RenderedNode | RenderedNode[] | null): number[] {
  if (json == null || typeof json === 'string') return [];
  if (Array.isArray(json)) return json.flatMap((child) => fixedWidthsIn(child));
  const width = flatten(json.props?.style).width;
  const own = typeof width === 'number' ? [width] : [];
  return [...own, ...fixedWidthsIn(json.children)];
}

describe.each([
  ['Market', ThemeMarket, () => ({ ...shop, theme: 'market' as const, slug: 'xamdi-header-overflow-market' })],
  ['Window', ThemeWindow, () => ({ ...shop, theme: 'window' as const, slug: 'xamdi-header-overflow-window' })],
  ['Counter', ThemeCounter, () => ({ ...shop, theme: 'counter' as const, slug: 'xamdi-header-overflow-counter' })],
] as const)('%s theme header row', (_name, Theme, makeShop) => {
  async function render() {
    let tree!: ReturnType<typeof create>;
    await act(async () => {
      tree = create(<Theme storefront={makeShop()} products={products} colors={colors} />);
    });
    return tree;
  }

  it('allows the header row to wrap instead of running off a phone-width screen', async () => {
    const tree = await render();
    const header = findByTestId(tree.toJSON(), 'storefront-header');
    expect(header).not.toBeNull();
    expect(flatten(header!.props.style).flexWrap).toBe('wrap');
  });

  it('pins nothing in the header to a fixed pixel width', async () => {
    const tree = await render();
    const header = findByTestId(tree.toJSON(), 'storefront-header');
    expect(header).not.toBeNull();
    expect(fixedWidthsIn(header)).toEqual([]);
  });
});
