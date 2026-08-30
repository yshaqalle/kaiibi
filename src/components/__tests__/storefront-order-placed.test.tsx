import { act, create, type ReactTestRenderer, type ReactTestRendererJSON } from 'react-test-renderer';

import { OrderPlaced } from '@/components/storefront/order-placed';
import { paletteColors } from '@/lib/storefront-catalog';
import type { PlacedOrder } from '@/lib/storefront-order';

// `@testing-library/react-native` is not installed in this repo -- flatten the
// rendered tree to strings instead, the same helper storefront-checkout-form
// .test.tsx and cart-sheet.test.tsx use.
// Numbers are kept, unlike in the sibling helpers: this screen renders the
// order number as `#{order.number}`, which reaches the tree as a '#' string
// and a separate NUMERIC child. Dropping numbers would silently lose the one
// figure the customer is asked to quote on the phone.
function textsIn(node: ReactTestRendererJSON | ReactTestRendererJSON[] | string | number | null): string[] {
  if (node == null) return [];
  if (typeof node === 'string') return [node];
  if (typeof node === 'number') return [String(node)];
  if (Array.isArray(node)) return node.flatMap(textsIn);
  return textsIn(node.children as ReactTestRendererJSON[] | null);
}

const colors = paletteColors('ink');

const placedOrder: PlacedOrder = {
  number: 1042,
  status: 'placed',
  paymentMode: 'on_collection',
  fulfilment: 'collect',
  deliveryArea: null,
  customerPhone: '+252634456789',
  subtotalCents: 2200,
  deliveryFeeCents: 0,
  totalCents: 2200,
  items: [{ productId: 'p1', name: 'Soap', unitPriceCents: 500, quantity: 2, lineTotalCents: 1000 }],
};

function renderPlaced(opts?: { order?: Partial<PlacedOrder>; collectLocation?: string | null }) {
  let tree!: ReactTestRenderer;
  act(() => {
    tree = create(
      <OrderPlaced
        order={{ ...placedOrder, ...opts?.order }}
        shopName="Hodan Grocery"
        collectLocation={opts?.collectLocation ?? null}
        colors={colors}
      />,
    );
  });
  return tree;
}

function texts(tree: ReactTestRenderer): string[] {
  return textsIn(tree.toJSON() as ReactTestRendererJSON);
}

describe('OrderPlaced', () => {
  // The defect: this screen promised a phone call and never said where to go.
  it('tells a collecting customer where to come', () => {
    const tree = renderPlaced({ collectLocation: 'Shop 12, Bakaaro Market, Hargeisa' });
    expect(texts(tree).some((t) => /Shop 12, Bakaaro Market, Hargeisa/.test(t))).toBe(true);
  });

  // Paired positive: proves the fixture really rendered the confirmation, so
  // the negatives below cannot pass by rendering nothing at all.
  it('still shows the order number and the shop name', () => {
    const tree = renderPlaced({ collectLocation: 'Shop 12, Bakaaro Market, Hargeisa' });
    const t = texts(tree);
    expect(t.join('')).toMatch(/#1042/);
    expect(t.some((s) => /Hodan Grocery/.test(s))).toBe(true);
  });

  // Null is the common case -- collectLocation is only null when the shop has
  // neither a typed address nor a city. The old sentence is at least true.
  it('falls back to the old sentence when there is nothing to name', () => {
    const tree = renderPlaced({ collectLocation: null });
    expect(texts(tree).some((t) => /ready to collect/.test(t))).toBe(true);
  });

  it('never says "Collect from" with nothing after it', () => {
    const tree = renderPlaced({ collectLocation: null });
    const t = texts(tree);
    expect(t.some((s) => /Collect from/.test(s))).toBe(false);
    // and the surface was really there
    expect(t.join('')).toMatch(/#1042/);
  });

  // A delivery order is coming to the customer. Naming the shop's counter on
  // it would send them to the wrong place.
  it('never names the pick-up place on a delivery order', () => {
    const tree = renderPlaced({
      order: { fulfilment: 'deliver', deliveryArea: 'Koodbuur' },
      collectLocation: 'Shop 12, Bakaaro Market, Hargeisa',
    });
    const t = texts(tree);
    expect(t.some((s) => /Bakaaro Market/.test(s))).toBe(false);
    expect(t.some((s) => /arrange delivery to Koodbuur/.test(s))).toBe(true);
  });
});
