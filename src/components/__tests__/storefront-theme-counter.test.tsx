import { act, create, type ReactTestRendererJSON } from 'react-test-renderer';

import { ThemeCounter } from '@/components/storefront/theme-counter';
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
  // No flyers: these fixtures predate them, and a shop with none must
  // render exactly as it did before they existed.
  flyers: [],
  autoAdvance: false,
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
  // space of its own -- without this, its last-row content sits underneath
  // it the moment the cart goes from empty to non-empty.
  //
  // storefront-cart.ts's native-platform cache is a module-level Map with no
  // reset hook by design -- a slug this test does not share with any other
  // test in this file (rather than the shared `shop.slug`) keeps this one's
  // cart from leaking into, or being polluted by, another's.
  it('reserves extra bottom space for the sticky checkout bar once the cart is non-empty', () => {
    const tree = renderCounter({ ...shop, slug: 'xamdi-counter-b6' });
    const flatStyle = (style: unknown) =>
      [style].flat(Infinity).reduce((acc, s) => ({ ...(acc as object), ...(s as object) }), {}) as { paddingBottom: number };

    const scroller = () => tree.root.find((n) => n.props?.testID === 'storefront-counter-scroll');
    const before = flatStyle(scroller().props.contentContainerStyle);

    const addButtons = findByTestId(tree, 'product-tile-add');
    act(() => addButtons[0].props.onPress());

    const after = flatStyle(scroller().props.contentContainerStyle);
    expect(after.paddingBottom).toBeGreaterThan(before.paddingBottom);
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
