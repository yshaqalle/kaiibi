import { act, create, type ReactTestRenderer, type ReactTestRendererJSON } from 'react-test-renderer';

import { OrderPlaced } from '@/components/storefront/order-placed';
import { paletteColors } from '@/lib/storefront-catalog';
import { orderAddress } from '@/lib/storefront-host';
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
  shareToken: null,
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

// ── The customer leaves checkout holding the link (Part 3) ──────────────
//
// This screen's own header used to say "no tracking page exists to link to,
// because plan 4 owns fulfilment state and has not built one yet." That is
// no longer true: 20261016000000 mints a share token on every order and
// place_storefront_order returns it in the same payload this screen already
// renders, so showing the link costs no second query and no loading state.
describe('OrderPlaced — the order link', () => {
  it('shows the address built by orderAddress, never a hand-built string', () => {
    const t = texts(renderPlaced({ order: { shareToken: 'a1b2c3d4e5f6g7h8j9k0mnpqrs' } })).join(' ');
    expect(t).toContain(orderAddress('a1b2c3d4e5f6g7h8j9k0mnpqrs'));
  });

  // THE #108 FAILURE, in the one place it would recur. An order placed before
  // the token existed -- or any response that did not carry one -- must render
  // NO link rather than `kaiibi.com/o/undefined`, which is a link that looks
  // real and goes nowhere.
  it('shows no link at all when the response carried no token', () => {
    const t = texts(renderPlaced({ order: { shareToken: null } })).join(' ');
    expect(t).not.toContain('/o/');
    expect(t).not.toContain('undefined');
    expect(t).not.toMatch(/kaiibi\.com/);
  });

  it('says what the link is for, so it is worth keeping', () => {
    const t = texts(renderPlaced({ order: { shareToken: 'a1b2c3d4e5f6g7h8j9k0mnpqrs' } })).join(' ');
    expect(t).toMatch(/check|track|follow|where/i);
  });
});
