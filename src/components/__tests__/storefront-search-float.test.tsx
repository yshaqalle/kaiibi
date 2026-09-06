import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { ThemeMarket } from '@/components/storefront/theme-market';
import { SEARCH_THRESHOLD } from '@/lib/storefront-search';
import { paletteColors } from '@/lib/storefront-catalog';
import type { PublicStorefront, StorefrontProduct } from '@/types/models';

// theme-market.tsx transitively imports theme-shared.tsx -> '@/lib/storefront'
// -> '@/lib/storage' -> '@/lib/supabase', which throws at import time without
// real Supabase env vars -- the same mock every other suite that pulls in
// theme-shared.tsx carries (storefront-checkout-bar.test.tsx,
// storefront-shop-anchor.test.tsx, storefront-shop-footer.test.tsx).
jest.mock('@/lib/supabase', () => ({ supabase: {} }));

const colors = paletteColors('ink');

const baseShop: PublicStorefront = {
  shopName: 'Hargeisa Men’s Clothing Store',
  city: 'Hargeisa',
  slug: 'the-one-search',
  whatsappE164: null,
  theme: 'market',
  palette: 'ink',
  headline: null,
  about: null,
  heroImageUrl: null,
  offersDelivery: false,
  collectAddress: null,
  collectNeighborhood: null,
  paymentMode: 'on_collection',
  openingHours: { mon: [{ open: '08:00', close: '18:00' }] },
  tradingSince: null,
  highlights: [],
  images: [],
  contactPhone: null,
  instagram: null,
  flyers: [],
  autoAdvance: false,
  hideBranding: false,
};

function catalogue(n: number): StorefrontProduct[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `p${i}`,
    name: `Product ${i}`,
    description: null,
    category: null,
    priceCents: 1000 + i,
    stock: 5,
    imageUrl: null,
  }));
}

async function render(products: StorefrontProduct[], slug: string) {
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = create(<ThemeMarket storefront={{ ...baseShop, slug }} products={products} colors={colors} />);
  });
  return tree;
}

// A style array/tree walker in the same shape storefront-theme-header-overflow.test.tsx
// already uses -- flattens whatever RN handed a node (a plain object, an array
// of them, or both) into one object so a single property lookup covers every
// shape a style prop can take here.
function flatten(style: unknown): Record<string, unknown> {
  return [style]
    .flat(Infinity)
    .filter(Boolean)
    .reduce((acc, s) => ({ ...(acc as object), ...(s as object) }), {}) as Record<string, unknown>;
}

// Finds the floating wrapper by its `zIndex` alone -- `searchRowFloating` is
// the only style in this component that sets `zIndex: 1`, so this is a
// structural marker, not a magic-number match on the pull itself. Looking
// for `marginTop === -21` here (what this used to do) would only prove the
// STYLE VALUE was -21, which is not the same claim as "the card overlaps the
// anchor by 21px" -- `headerNarrow`, the wrapper's own parent, is a column
// flex container with `gap: SPACE.cardGap`, and RN sums a flex `gap` with a
// child's own negative `marginTop` rather than letting one replace the
// other. A -21 margin against a 14px gap renders as a 7px overlap, not 21 --
// exactly the regression this file exists to catch, and exactly what a
// bare `marginTop === -21` assertion cannot see, since it would pass
// identically whatever the gap happened to be. `effectiveSearchOverlap`
// below is what actually asserts the rendered offset.
function findFloatingSearchWrapper(tree: ReactTestRenderer) {
  return tree.root.findAll((n) => flatten(n.props?.style).zIndex === 1);
}

// `toJSON()` renders only HOST nodes -- a composite like `<ShopAnchor/>` or
// `<SearchField/>` that returns a single element is transparent in this
// tree, so ShopAnchor's own outer View (testID storefront-shop-card) and
// SearchField's own outer View (the -21/zIndex wrapper) show up as direct
// entries of whatever host View actually holds them, in render order. That
// is what makes this a real structural check of WHO is whose sibling,
// rather than a search that only proves the wrapper exists somewhere.
type JsonNode = { type: string; props: Record<string, unknown>; children: (JsonNode | string)[] | null };

function findJsonByTestId(node: JsonNode | JsonNode[] | null, testID: string): JsonNode | null {
  if (!node) return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findJsonByTestId(child, testID);
      if (found) return found;
    }
    return null;
  }
  if (node.props?.testID === testID) return node;
  for (const child of node.children ?? []) {
    if (typeof child === 'string') continue;
    const found = findJsonByTestId(child, testID);
    if (found) return found;
  }
  return null;
}

// THE ACTUAL REGRESSION CHECK: the parent's `gap` and the wrapper's own
// `marginTop`, summed -- the number that lands on screen, not either style
// value in isolation. `storefront-header` (ShopHeader's narrow-branch View)
// is the wrapper's direct parent and carries `headerNarrow`'s `gap:
// SPACE.cardGap`; the wrapper is whichever of its children carries the
// `zIndex: 1` this component's floating style alone sets. Returns `null` if
// either half is missing, so a caller can tell "no overlap wrapper found" (a
// real assertion in its own right, above) apart from "found it, and the sum
// is wrong".
//
// This is what makes the test resistant to drift in EITHER direction:
// tightening `headerNarrow`'s gap without correspondingly loosening the
// margin (or vice versa) changes this sum, whereas the old
// `marginTop === -21` check would have passed unchanged either way.
function effectiveSearchOverlap(tree: ReactTestRenderer): number | null {
  const header = findJsonByTestId(tree.toJSON(), 'storefront-header');
  if (!header) return null;
  const gap = flatten(header.props?.style).gap;
  const wrapper = (header.children ?? []).find(
    (c): c is JsonNode => typeof c !== 'string' && flatten(c.props?.style).zIndex === 1,
  );
  if (typeof gap !== 'number' || !wrapper) return null;
  const marginTop = flatten(wrapper.props?.style).marginTop;
  if (typeof marginTop !== 'number') return null;
  return gap + marginTop;
}

describe('the floating search card', () => {
  it('placeholder reads the item count', async () => {
    const count = SEARCH_THRESHOLD + 2;
    const tree = await render(catalogue(count), 'the-one-search-placeholder');
    const field = tree.root.findAll((n) => n.props?.testID === 'storefront-search')[0];
    expect(field.props.placeholder).toBe(`Search ${count} items…`);
  });

  // THE REGRESSION A SILENT SHIP WOULD LOOK LIKE: a 3-product shop never
  // clears the threshold, so SearchField never renders -- but if the overlap
  // wrapper rendered anyway (empty, or wrapping nothing), the anchor would
  // still carry an orphaned -21px pull with nothing under it to overlap.
  it('below the threshold: no search field, and no overlap wrapper at all', async () => {
    const tree = await render(catalogue(SEARCH_THRESHOLD - 1), 'the-one-search-under');
    expect(tree.root.findAll((n) => n.props?.testID === 'storefront-search')).toHaveLength(0);
    expect(findFloatingSearchWrapper(tree)).toHaveLength(0);
  });

  // AT THE THRESHOLD, narrow layout (the default width react-test-renderer
  // renders at -- see storefront-theme-header-overflow.test.tsx's identical
  // reliance on that default resolving to the narrow header): the field
  // renders AND carries the overlap.
  it('at the threshold: the search field renders inside the floating wrapper', async () => {
    const tree = await render(catalogue(SEARCH_THRESHOLD), 'the-one-search-at');
    expect(tree.root.findAll((n) => n.props?.testID === 'storefront-search').length).toBeGreaterThan(0);
    expect(findFloatingSearchWrapper(tree).length).toBeGreaterThan(0);
  });

  // THE FIX ITSELF: 21px, not 7. `effectiveSearchOverlap` sums the parent
  // `headerNarrow`'s `gap` with the wrapper's own `marginTop` -- the two
  // numbers that combine, in RN's flex layout, to decide how far the card
  // actually climbs onto the anchor. Asserting the RAW `marginTop` alone (as
  // this suite used to) would pass identically whether `headerNarrow`'s gap
  // were 14 or 100 -- this is the assertion that actually fails if either
  // number moves without the other following it.
  it('the floating card overlaps the anchor by exactly 21px, gap and pull summed', async () => {
    const tree = await render(catalogue(SEARCH_THRESHOLD), 'the-one-search-overlap');
    expect(effectiveSearchOverlap(tree)).toBe(-21);
  });

  // THE DEFECT THIS PINS: the floating card's -21px pull must land on
  // ShopAnchor's own bottom edge (a dark `ink` card, per the mockup's
  // `.onesearch` under `.hero2`), not on the light `ground` Collecting/Stock
  // pair below it. `storefront-header` is ShopHeader's own narrow-branch
  // View (theme-shared.tsx), whose direct children are, in order: the
  // WhatsApp/Cart button row, ShopAnchor (testID storefront-shop-card), and
  // headerPair (Collecting + Stock). The floating wrapper belongs in the
  // middle slot -- ShopAnchor's very next sibling -- so a -21px pull placed
  // ABOVE it in the render always overlaps the anchor and never the pair.
  //
  // Reverting to rendering the field as a sibling of the whole <ShopHeader/>
  // (task 13's original bug) removes it from this node's children entirely,
  // so `floatingIndex` becomes -1 and this fails.
  it('the floating card is ShopAnchor\'s next sibling, not a sibling of the whole header', async () => {
    const tree = await render(catalogue(SEARCH_THRESHOLD), 'the-one-search-sibling');
    const header = findJsonByTestId(tree.toJSON(), 'storefront-header');
    expect(header).not.toBeNull();
    const kids = (header!.children ?? []).filter((c): c is JsonNode => typeof c !== 'string');
    const anchorIndex = kids.findIndex((k) => k.props?.testID === 'storefront-shop-card');
    const floatingIndex = kids.findIndex((k) => flatten(k.props?.style).zIndex === 1);
    expect(anchorIndex).toBeGreaterThanOrEqual(0);
    expect(floatingIndex).toBe(anchorIndex + 1);
  });
});

describe('the three trust facts, readable on the Shop tab without opening Visit', () => {
  it('open state: the anchor pill says Open now at a configured open hour', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-07T10:00:00')); // a Monday, 10am
    try {
      const tree = await render(catalogue(3), 'the-one-facts-open');
      const pills = tree.root.findAll((n) => n.props?.testID === 'storefront-anchor-open-pill');
      expect(pills.length).toBeGreaterThan(0);
      const texts = tree.root.findAll((n) => Array.isArray(n.children) && n.children.includes('Open now'));
      expect(texts.length).toBeGreaterThan(0);
    } finally {
      jest.useRealTimers();
    }
  });

  it('collection word: the anchor carries a Collection pill, unconditionally', async () => {
    const tree = await render(catalogue(3), 'the-one-facts-collection');
    const pills = tree.root.findAll((n) => n.props?.testID === 'storefront-anchor-collection-pill');
    expect(pills.length).toBeGreaterThan(0);
    const texts = tree.root.findAll((n) => Array.isArray(n.children) && n.children.includes('Collection'));
    expect(texts.length).toBeGreaterThan(0);
  });

  it('pay-on-collection: the footer already carries it, on the same Shop tab render', async () => {
    const tree = await render(catalogue(3), 'the-one-facts-pay');
    const texts = tree.root.findAll(
      (n) => Array.isArray(n.children) && n.children.includes('Pay on collection · Prices set by the shop'),
    );
    expect(texts.length).toBeGreaterThan(0);
  });
});
