import { StyleSheet } from 'react-native';
import { act, create, type ReactTestRendererJSON } from 'react-test-renderer';

import { ThemeCounter } from '@/components/storefront/theme-counter';
import { SHOP_MAX_WIDTH } from '@/components/storefront/scale';
import { CHECKOUT_BAR_CLEARANCE } from '@/components/storefront/theme-shared';
import { openExternalUrl } from '@/lib/external-url';
import { waLink } from '@/lib/storefront';
import { paletteColors } from '@/lib/storefront-catalog';
import { SEARCH_THRESHOLD } from '@/lib/storefront-search';
import type { PublicStorefront, StorefrontProduct } from '@/types/models';

jest.mock('@/lib/supabase', () => ({ supabase: {} }));
jest.mock('@/lib/external-url', () => ({ openExternalUrl: jest.fn() }));

const openMock = openExternalUrl as jest.MockedFunction<typeof openExternalUrl>;
beforeEach(() => openMock.mockReset());

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

// `findAll` matches a testID against every test instance carrying that prop
// -- Pressable is composite and forwards testID down through a forwardRef
// View to its own host node, so one on-screen button surfaces as three
// matches (the Pressable itself, the forwardRef wrapper, the host View).
// Only the outermost Pressable instance carries `onPress`; filtering on that
// gives exactly one match per button, and a node `.props.onPress()` can
// press.
function findByTestId(tree: ReturnType<typeof create>, testID: string) {
  return tree.root.findAll((node) => node.props?.testID === testID && typeof node.props?.onPress === 'function');
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
  collectAddress: null,
  collectNeighborhood: null,
  paymentMode: 'on_collection',
  openingHours: {},
  tradingSince: null, highlights: [], images: [],
  contactPhone: null, instagram: null,
  // No flyers: these fixtures predate them, and a shop with none must
  // render exactly as it did before they existed.
  flyers: [],
  autoAdvance: false,
  hideBranding: false,
};

const products: StorefrontProduct[] = [
  { id: 'p1', name: 'Anker 20W charger', description: null, category: 'Phone', priceCents: 1200, stock: 5, imageUrl: null },
];

function renderCounter(storefront: PublicStorefront, list: StorefrontProduct[] = products) {
  let tree!: ReturnType<typeof create>;
  act(() => {
    tree = create(<ThemeCounter storefront={storefront} products={list} colors={colors} />);
  });
  return tree;
}

describe('ThemeCounter', () => {
  it('renders the about text under the headline', () => {
    const tree = renderCounter(shop);
    const texts = textsIn(tree.toJSON() as ReactTestRendererJSON);
    expect(texts).toContain('Everything for the house and the phone.');
    expect(texts).toContain('Open 8am–9pm, closed Fridays.');
  });

  it('renders no about line when the shop has none', () => {
    const tree = renderCounter({ ...shop, about: null });
    const texts = textsIn(tree.toJSON() as ReactTestRendererJSON);
    expect(texts).not.toContain('Open 8am–9pm, closed Fridays.');
  });

  // Counter has its own row layout, not ProductTile's grid tile, but the same
  // rule applies: Add is offered only in stock (property 2 of ProductTile),
  // and it is a broken theme otherwise -- Counter is the theme a long,
  // photo-free catalogue picks, and "no Add" there means nothing can be
  // bought.
  it('offers Add for an in-stock product and not for an out-of-stock one', () => {
    const mixed: StorefrontProduct[] = [
      { id: 'p1', name: 'Anker 20W charger', description: null, category: 'Phone', priceCents: 1200, stock: 5, imageUrl: null },
      { id: 'p2', name: 'USB-C cable', description: null, category: 'Phone', priceCents: 500, stock: 0, imageUrl: null },
    ];
    const tree = renderCounter(shop, mixed);

    const addButtons = findByTestId(tree, 'product-tile-add');
    expect(addButtons).toHaveLength(1);

    // Ask always renders regardless of stock (property 2's other half) --
    // one per product, in-stock or not.
    const askButtons = findByTestId(tree, 'product-tile-ask');
    expect(askButtons).toHaveLength(2);
  });

  // B6: the sticky CheckoutBar is `position: absolute` and reserves no
  // space of its own. Task 5 made this unconditional -- the first Add must
  // not reflow the page under the customer's finger, so the scroller
  // carries the clearance from the very first render, empty cart or not,
  // and adding to the cart changes nothing about it.
  //
  // storefront-cart.ts's native-platform cache is a module-level Map with no
  // reset hook by design -- a slug this test does not share with any other
  // test in this file (rather than the shared `shop.slug`) keeps this one's
  // cart from leaking into, or being polluted by, another's.
  it('reserves the checkout bar clearance from the first render, unchanged by adding to the cart', () => {
    const tree = renderCounter({ ...shop, slug: 'xamdi-counter-b6' });
    const flatStyle = (style: unknown) =>
      [style].flat(Infinity).reduce((acc, s) => ({ ...(acc as object), ...(s as object) }), {}) as { paddingBottom: number };

    const scroller = () => tree.root.find((n) => n.props?.testID === 'storefront-counter-scroll');
    const before = flatStyle(scroller().props.contentContainerStyle);
    expect(before.paddingBottom).toBe(24 + CHECKOUT_BAR_CLEARANCE);

    const addButtons = findByTestId(tree, 'product-tile-add');
    act(() => addButtons[0].props.onPress());

    const after = flatStyle(scroller().props.contentContainerStyle);
    expect(after.paddingBottom).toBe(before.paddingBottom);
  });

  it('pressing Add on a row adds that product to the cart', () => {
    const tree = renderCounter(shop);
    const addButtons = findByTestId(tree, 'product-tile-add');
    expect(addButtons).toHaveLength(1);
    act(() => addButtons[0].props.onPress());

    const texts = textsIn(tree.toJSON() as ReactTestRendererJSON);
    expect(texts).toContain('Cart · 1');
  });

  it('pressing Ask on a row opens a wa.me link prefilled with the shop and product name', () => {
    const tree = renderCounter(shop);
    const askButtons = findByTestId(tree, 'product-tile-ask');
    expect(askButtons).toHaveLength(1);
    act(() => askButtons[0].props.onPress());

    const expected = waLink('+252634456789', 'Hi Xamdi Electronics, is Anker 20W charger available?');
    expect(openMock).toHaveBeenCalledWith(expected);
  });

  // No number to reach means nothing to open, so Ask does not render at all
  // (same as ProductTile) -- Add still works without a WhatsApp number.
  it('drops Ask when the shop has no WhatsApp number, but Add still works', () => {
    // Same rule as WhatsAppButton in theme-shared: lose the button rather than
    // render one that opens a chat with nobody. Selling is unaffected -- only
    // the question channel disappears.
    const tree = renderCounter({ ...shop, whatsappE164: null });
    expect(findByTestId(tree, 'product-tile-ask')).toHaveLength(0);
    expect(openMock).not.toHaveBeenCalled();

    const addButtons = findByTestId(tree, 'product-tile-add');
    expect(addButtons).toHaveLength(1);
  });
});

// The helper is unit-tested in storefront-search.test.ts; this asserts the
// WIRING -- that Counter actually narrows its rows, and that the threshold
// keeps the control off a short catalogue.
describe('Counter search', () => {
  const many: StorefrontProduct[] = Array.from({ length: SEARCH_THRESHOLD }, (_, i) => ({
    id: `p${i}`,
    name: i === 0 ? 'Paracetamol 500mg' : `Filler ${i}`,
    description: null,
    category: 'Analgesics',
    priceCents: 250,
    stock: 4,
    imageUrl: null,
  }));

  it('offers no search box for a short catalogue', () => {
    const tree = renderCounter(shop, many.slice(0, 3));
    expect(tree.root.findAll((n) => n.props?.testID === 'storefront-search')).toHaveLength(0);
  });

  it('narrows the rows to what was typed', () => {
    const tree = renderCounter(shop, many);

    const field = tree.root.findAll(
      (n) => n.props?.testID === 'storefront-search' && typeof n.props?.onChangeText === 'function',
    );
    expect(field.length).toBeGreaterThan(0);

    act(() => field[0].props.onChangeText('paracet'));

    const texts = tree.root
      .findAll((n) => n.props?.children !== undefined)
      .flatMap((n) => [n.props.children].flat(Infinity))
      .filter((c): c is string => typeof c === 'string');

    expect(texts).toContain('Paracetamol 500mg');
    expect(texts.some((t) => t.startsWith('Filler'))).toBe(false);
  });

  it('says nothing matched, rather than claiming the shop is empty', () => {
    const tree = renderCounter(shop, many);
    const field = tree.root.findAll(
      (n) => n.props?.testID === 'storefront-search' && typeof n.props?.onChangeText === 'function',
    );

    act(() => field[0].props.onChangeText('bandage'));

    const texts = tree.root
      .findAll((n) => n.props?.children !== undefined)
      .flatMap((n) => [n.props.children].flat(Infinity))
      .filter((c): c is string => typeof c === 'string')
      .join(' ');

    expect(texts).toContain('bandage');
    expect(texts).not.toContain('Nothing listed yet');
  });
});

// Task 4 (wave-review-fixes.md item 4): the search field renders OUTSIDE
// `styles.scroll` (the reading column, bounded to SHOP_MAX_WIDTH and
// centred) so Counter can supply its own gutter -- see `searchInset`'s own
// comment in theme-counter.tsx. That gutter used to be a bare
// `paddingHorizontal` on an otherwise full-width View, which agreed with the
// column below 1320 (both read as "the window, minus one inset") and
// disagreed above it: at 1900px the field's own left edge sat at 16 while
// the price-list card's sat at 306, centred inside the 1320-wide column.
// These assert the STRUCTURE that fixes it -- the search sits in the same
// bounded, centred column the list does -- rather than a pixel number this
// harness cannot lay out to prove.
describe('Counter search lines up with the price list above 1320', () => {
  // SIBLING-ADJACENCY HELPER, the same pattern storefront-product-sheet.test.tsx
  // and storefront-shop-chrome.test.tsx both use for the same reason:
  // `toJSON()` yields HOST nodes only, so walking THAT tree (rather than
  // `tree.root.findAll`, which also returns every composite wrapper in
  // between) is what can tell "this node is wrapped in a bounded column" from
  // "a bounded column merely exists somewhere in the same tree."
  type HostNode = { type: string; props: Record<string, unknown>; children: unknown[] | null };

  function pathToTestId(root: HostNode, testID: string, path: HostNode[] = []): HostNode[] | null {
    const next = [...path, root];
    if (root.props?.testID === testID) return next;
    for (const child of root.children ?? []) {
      if (typeof child === 'string') continue;
      const found = pathToTestId(child as HostNode, testID, next);
      if (found) return found;
    }
    return null;
  }

  function maxWidthsAlong(path: HostNode[]): unknown[] {
    return path
      .map((n) => StyleSheet.flatten(n.props?.style as never) as { maxWidth?: unknown } | undefined)
      .map((s) => s?.maxWidth)
      .filter((w) => w != null);
  }

  it('bounds the search field to the same SHOP_MAX_WIDTH column as the price list, not just the window', () => {
    const many: StorefrontProduct[] = Array.from({ length: SEARCH_THRESHOLD }, (_, i) => ({
      id: `p${i}`, name: `Filler ${i}`, description: null, category: 'Analgesics', priceCents: 250, stock: 4, imageUrl: null,
    }));
    const tree = renderCounter(shop, many);
    const root = tree.toJSON() as HostNode;

    const searchPath = pathToTestId(root, 'storefront-search');
    expect(searchPath).not.toBeNull();
    expect(maxWidthsAlong(searchPath as HostNode[])).toContain(SHOP_MAX_WIDTH);

    const scroll = tree.root.findAll((n) => n.props?.testID === 'storefront-counter-scroll')[0];
    const scrollMaxWidth = (StyleSheet.flatten(scroll.props.style as never) as { maxWidth?: unknown }).maxWidth;
    expect(scrollMaxWidth).toBe(SHOP_MAX_WIDTH);
  });
});
