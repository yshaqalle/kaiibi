import { act, create, type ReactTestInstance, type ReactTestRenderer, type ReactTestRendererJSON } from 'react-test-renderer';

import { PublicOrderView } from '@/components/storefront/public-order-view';
import type { PublicOrder } from '@/lib/public-order';

// The route file itself is a thin shell around this component: it reads the
// token off the URL, fetches, and renders THIS. The component is what the
// tests drive, so none of them need expo-router or a network fake -- the same
// props-only posture order-detail.tsx takes on the shop's side.

function textsIn(node: ReactTestRendererJSON | ReactTestRendererJSON[] | string | number | null): string[] {
  if (node == null) return [];
  if (typeof node === 'string') return [node];
  if (typeof node === 'number') return [String(node)];
  if (Array.isArray(node)) return node.flatMap(textsIn);
  return textsIn(node.children as ReactTestRendererJSON[] | null);
}

const ORDINARY: PublicOrder = {
  shopName: 'Xamdi Stores',
  number: 7,
  status: 'ready',
  placedAt: '2026-08-30T09:00:00Z',
  fulfilment: 'collect',
  whereToGo: 'Shop 12, Bakaaro Market',
  lines: [{ productName: 'Basmati rice', quantity: 3, lineTotalCents: 7500 }],
  subtotalCents: 7500,
  deliveryFeeCents: 0,
  totalCents: 7500,
  confirmedAt: null,
  amendment: null,
};

const AMENDED: PublicOrder = {
  ...ORDINARY,
  status: 'accepted',
  amendment: {
    customerNote: 'Only three bags left, the rest on Thursday',
    wasCents: 12500,
    nowCents: 7500,
    before: [{ productName: 'Basmati rice', quantity: 5, lineTotalCents: 12500 }],
    after: [{ productName: 'Basmati rice', quantity: 3, lineTotalCents: 7500 }],
  },
};

function render(props: Partial<Parameters<typeof PublicOrderView>[0]> = {}): ReactTestRenderer {
  let tree!: ReactTestRenderer;
  act(() => {
    tree = create(
      <PublicOrderView
        order={ORDINARY}
        loading={false}
        notFound={false}
        confirming={false}
        error={null}
        onConfirm={jest.fn()}
        onMessageShop={jest.fn()}
        {...props}
      />
    );
  });
  return tree;
}

const texts = (tree: ReactTestRenderer) => textsIn(tree.toJSON() as ReactTestRendererJSON).join(' ');
const find = (tree: ReactTestRenderer, label: string): ReactTestInstance | undefined =>
  tree.root.findAll((n) => n.props.accessibilityLabel === label && typeof n.props.onPress === 'function')[0];

describe('PublicOrderView — the ordinary order', () => {
  // The case that will be opened most, and the one that kills the "where is
  // my order?" call.
  it('shows the shop, the number, the stage and the total', () => {
    const t = texts(render());
    expect(t).toContain('Xamdi Stores');
    expect(t).toContain('7');
    expect(t).toContain('$75.00');
    expect(t).toMatch(/ready/i);
  });

  it('shows the lines the customer is getting', () => {
    const t = texts(render());
    expect(t).toContain('Basmati rice');
    expect(t).toContain('3');
  });

  // A rail that says "Ready" without saying where to go is the failure the
  // confirmation screen already has.
  it('says where to go', () => {
    expect(texts(render())).toContain('Shop 12, Bakaaro Market');
  });

  it('says where to go on a delivery too, using the customer own landmark', () => {
    const t = texts(render({ order: { ...ORDINARY, fulfilment: 'deliver', whereToGo: 'Behind the blue gate', deliveryFeeCents: 1500, totalCents: 9000 } }));
    expect(t).toContain('Behind the blue gate');
    expect(t).toContain('$90.00');
  });

  // NOTHING TO AGREE TO. An unamended order must not ask the customer to
  // confirm anything -- there is no change to accept, and a confirm button
  // here would train people to tap it without reading.
  it('offers no confirm button when nothing has changed', () => {
    const tree = render();
    expect(find(tree, "Yes, that's fine")).toBeUndefined();
  });

  it('always offers a way to reach the shop', () => {
    expect(find(render(), 'Something is wrong — message the shop')).toBeDefined();
  });
});

describe('PublicOrderView — the amended order', () => {
  it('shows the shop message, and the diff, and both totals', () => {
    const t = texts(render({ order: AMENDED }));
    expect(t).toContain('Only three bags left, the rest on Thursday');
    expect(t).toContain('$125.00');
    expect(t).toContain('$75.00');
  });

  it('offers both moves', () => {
    const tree = render({ order: AMENDED });
    expect(find(tree, "Yes, that's fine")).toBeDefined();
    expect(find(tree, 'Something is wrong — message the shop')).toBeDefined();
  });

  it('agreeing calls confirm', () => {
    const onConfirm = jest.fn();
    const tree = render({ order: AMENDED, onConfirm });
    act(() => find(tree, "Yes, that's fine")!.props.onPress());
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  // THE ASYMMETRY, ASSERTED. "Something's wrong" must write NOTHING -- it
  // opens WhatsApp. A leaked link that could reject an order is the whole
  // thing confirm_public_order's design refuses.
  it('“something is wrong” writes nothing at all', () => {
    const onConfirm = jest.fn();
    const onMessageShop = jest.fn();
    const tree = render({ order: AMENDED, onConfirm, onMessageShop });
    act(() => find(tree, 'Something is wrong — message the shop')!.props.onPress());
    expect(onMessageShop).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('shows the agreement instead of the buttons once it is given', () => {
    const tree = render({ order: { ...AMENDED, confirmedAt: '2026-08-30T10:00:00Z' } });
    expect(find(tree, "Yes, that's fine")).toBeUndefined();
    expect(texts(tree)).toMatch(/thank|agreed|confirmed/i);
  });

  it('disables agreeing while a confirmation is in flight', () => {
    const tree = render({ order: AMENDED, confirming: true });
    expect(find(tree, "Yes, that's fine")?.props.disabled).toBe(true);
  });

  // The internal reason never leaves the database (get_public_order does not
  // return it), so this asserts the component cannot invent a place for it:
  // it renders customerNote and nothing else from the amendment prose.
  it('renders only the customer note, never any other prose', () => {
    const t = texts(render({ order: AMENDED }));
    expect(t).toContain('Only three bags left, the rest on Thursday');
    expect(t).not.toMatch(/reason/i);
  });
});

describe('PublicOrderView — the states that are not an order', () => {
  it('says not found for an unknown or expired link, without blaming the customer', () => {
    const t = texts(render({ order: null, notFound: true }));
    expect(t).toMatch(/not found|expired|no longer/i);
  });

  it('shows a loading state rather than an empty page', () => {
    expect(texts(render({ order: null, loading: true }))).toMatch(/loading|…/i);
  });

  // "They are not byte-identical" was the first version of this, and it was
  // too weak: renaming only the heading kept the bodies different and the
  // check green. What actually matters is that a dropped connection must
  // never CLAIM the order is missing -- that sends a customer to phone their
  // shop about a link which is perfectly good.
  it('never tells a customer their link is invalid when the request merely failed', () => {
    const failed = texts(render({ order: null, error: 'Could not load this order.' }));
    expect(failed).toContain('Could not load this order.');
    expect(failed).not.toMatch(/not found|expired/i);
    // ...and it points at the thing that is actually wrong.
    expect(failed).toMatch(/connection|try again/i);
  });

  it('reports a missing order without mentioning a failure', () => {
    const missing = texts(render({ order: null, notFound: true }));
    expect(missing).toMatch(/not found|expired/i);
    expect(missing).not.toMatch(/connection/i);
  });
});
