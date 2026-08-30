import { act, create, type ReactTestRenderer, type ReactTestRendererJSON } from 'react-test-renderer';

import { OrderDetail } from '@/components/orders/order-detail';
import type { OrderLine, ShopOrder } from '@/lib/storefront-admin';

// THE ONE ASSERTION A TEXT COMPARISON CANNOT MAKE.
//
// order-detail.test.tsx already checks the sheet shows orderAddress(token).
// That check passes just as happily against a hand-built
// `kaiibi.com/o/${token}` -- the two produce the identical string TODAY, and
// would diverge only on the day someone changes ORDER_SEGMENT or settles
// path-vs-subdomain. Found by mutation: replacing the call with a template
// literal left every test green.
//
// That is #108's post-mortem word for word: "the old tests pinned each surface
// to its own literal, so all of them could be wrong together". The fix there
// was one source; the check that keeps it one source is this -- stub the
// helper to return something no literal could coincidentally equal, and
// require the sheet to render THAT.
//
// It lives in its own file because the mock is module-wide, and the sibling
// suite needs the real helper. The imports above sit before the jest.mock
// below on purpose: babel-plugin-jest-hoist lifts the mock above them before
// anything runs, so the stub is registered either way, and `import/first`
// stays quiet.
jest.mock('@/lib/storefront-host', () => ({
  ...jest.requireActual('@/lib/storefront-host'),
  orderAddress: (token: string) => `STUBBED-ADDRESS-FOR:${token}`,
}));

function textsIn(node: ReactTestRendererJSON | ReactTestRendererJSON[] | string | number | null): string[] {
  if (node == null) return [];
  if (typeof node === 'string') return [node];
  if (typeof node === 'number') return [String(node)];
  if (Array.isArray(node)) return node.flatMap(textsIn);
  return textsIn(node.children as ReactTestRendererJSON[] | null);
}

const ORDER: ShopOrder = {
  id: 'o1',
  number: 7,
  customerName: 'Hodan Ahmed',
  customerPhone: '+252634300111',
  fulfilment: 'collect',
  deliveryArea: null,
  deliveryLandmark: null,
  note: null,
  status: 'pending',
  cancellationReason: null,
  itemCount: 3,
  subtotalCents: 7500,
  deliveryFeeCents: 0,
  totalCents: 7500,
  saleId: null,
  createdAt: '2026-08-30T09:00:00Z',
  shareToken: 'a1b2c3d4e5f6g7h8j9k0mnpqrs',
  confirmedAt: null,
  lastAmendedAt: null,
};

const ITEMS: OrderLine[] = [
  { id: 'i1', productId: 'p1', productName: 'Basmati rice', unitPriceCents: 2500, quantity: 3, lineTotalCents: 7500 },
];

it('renders the address the shared helper returns, rather than one of its own', () => {
  let tree!: ReactTestRenderer;
  act(() => {
    tree = create(
      <OrderDetail
        order={ORDER}
        items={ITEMS}
        itemsLoading={false}
        itemsError={null}
        shortfalls={[]}
        hasPosAccess
        canAmend={false}
        currentPrices={{}}
        onClose={jest.fn()}
        onAccept={jest.fn()}
        onMarkReady={jest.fn()}
        onCancel={jest.fn()}
        onComplete={jest.fn()}
        onAmend={jest.fn()}
        submitting={false}
        actionError={null}
      />
    );
  });

  const t = textsIn(tree.toJSON() as ReactTestRendererJSON).join(' ');
  expect(t).toContain('STUBBED-ADDRESS-FOR:a1b2c3d4e5f6g7h8j9k0mnpqrs');
  // And nothing that looks like a second, hand-rolled address beside it.
  expect(t).not.toContain('kaiibi.com/o/');
});
