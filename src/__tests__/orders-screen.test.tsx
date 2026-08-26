import { act, create, type ReactTestRenderer, type ReactTestRendererJSON } from 'react-test-renderer';
import { SafeAreaProvider } from 'react-native-safe-area-context';

// Lives here rather than beside the screen ON PURPOSE -- see
// inventory-caveats.test.tsx: expo-router builds its route table from
// `require.context(src/app)`, and nothing on that scan skips `.test.tsx`. A
// test file under src/app would become a real route shipped in the bundle.

jest.mock('@/lib/supabase', () => ({ supabase: {} }));
jest.mock('@/lib/storefront-admin');
// `useAuth()` throws outside an `<AuthProvider>` -- this screen owns no
// fetch of its own for WHICH shop it is showing orders for, same as every
// other (admin) route.
jest.mock('@/hooks/use-auth', () => ({
  useAuth: jest.fn(() => ({ shop: { id: 'shop-1' } })),
}));

import { useAuth } from '@/hooks/use-auth';
import { listOrders, type ShopOrder } from '@/lib/storefront-admin';
import OrdersScreen from '@/app/(admin)/orders';

// ScreenHeader (used by every non-tab (admin) route, including this one)
// calls useSafeAreaInsets(), which throws outside a provider -- unlike
// SafeAreaView the component, the hook has no built-in fallback.
const INITIAL_METRICS = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } };

function textsIn(node: ReactTestRendererJSON | ReactTestRendererJSON[] | string | null): string[] {
  if (node == null) return [];
  if (typeof node === 'string') return [node];
  if (Array.isArray(node)) return node.flatMap(textsIn);
  return textsIn(node.children as ReactTestRendererJSON[] | null);
}

async function renderScreen(): Promise<ReactTestRenderer> {
  let tree: ReactTestRenderer | undefined;
  await act(async () => {
    tree = create(
      <SafeAreaProvider initialMetrics={INITIAL_METRICS}>
        <OrdersScreen />
      </SafeAreaProvider>,
    );
  });
  return tree!;
}

// A real order a customer placed off the storefront -- fields drawn from
// PlacedOrder (storefront-order.ts) and orders (20260926000050_orders.sql).
const ORDER: ShopOrder = {
  id: 'order-1',
  number: 7,
  customerName: 'Amina Yusuf',
  customerPhone: '+252634456789',
  fulfilment: 'deliver',
  deliveryArea: 'Hargeisa - 26 June',
  deliveryLandmark: 'Behind Maansoor Hotel, blue gate',
  itemCount: 3,
  totalCents: 4599,
  createdAt: '2026-08-20T10:00:00.000Z',
};

describe('Orders screen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (useAuth as jest.Mock).mockReturnValue({ shop: { id: 'shop-1' } });
  });

  // Property: "Each row shows what a shop needs to act: number, customer
  // name and phone, item count, collect-or-deliver with the area, total, and
  // when it arrived."
  it('shows what a shop needs to act on an order', async () => {
    (listOrders as jest.Mock).mockResolvedValue([ORDER]);
    const tree = await renderScreen();
    const texts = textsIn(tree.toJSON() as ReactTestRendererJSON).join(' ');
    expect(texts).toContain('7');
    expect(texts).toContain('Amina Yusuf');
    expect(texts).toContain('+252634456789');
    expect(texts).toContain('3');
    expect(texts).toContain('Hargeisa - 26 June');
    expect(texts).toContain('45.99');
  });

  it('shows a collect order as collect, without inventing a delivery area', async () => {
    (listOrders as jest.Mock).mockResolvedValue([{ ...ORDER, fulfilment: 'collect', deliveryArea: null }]);
    const tree = await renderScreen();
    const texts = textsIn(tree.toJSON() as ReactTestRendererJSON).join(' ');
    expect(texts).toMatch(/collect/i);
  });

  // B4: the landmark is collected, validated and stored -- without showing
  // it here the shop still has to phone the customer to find out where to
  // go, the exact dead end "Hargeisa addresses are landmarks, not street
  // numbers" exists to avoid.
  it('shows the delivery landmark alongside the area, so the shop does not have to phone to find out where to go', async () => {
    (listOrders as jest.Mock).mockResolvedValue([ORDER]);
    const tree = await renderScreen();
    const texts = textsIn(tree.toJSON() as ReactTestRendererJSON).join(' ');
    expect(texts).toContain('Behind Maansoor Hotel, blue gate');
  });

  it('shows no landmark for a collect order', async () => {
    (listOrders as jest.Mock).mockResolvedValue([
      { ...ORDER, fulfilment: 'collect', deliveryArea: null, deliveryLandmark: null },
    ]);
    const tree = await renderScreen();
    const texts = textsIn(tree.toJSON() as ReactTestRendererJSON).join(' ');
    expect(texts).not.toContain('Behind Maansoor Hotel, blue gate');
  });

  // Property: "Unconfirmed order value is never presented as revenue. An
  // order is a customer's intention; a sale is a thing that happened."
  it('never lets the total on screen be mistaken for revenue', async () => {
    (listOrders as jest.Mock).mockResolvedValue([ORDER]);
    const tree = await renderScreen();
    const texts = textsIn(tree.toJSON() as ReactTestRendererJSON).join(' ');
    expect(texts).toMatch(/not (money|revenue|takings|a sale)/i);
  });

  // Property: "No state transitions, no buttons that change anything. Plan
  // 4 adds those." A half-working accept/complete button here would be
  // worse than none.
  it('offers no control that changes an order', async () => {
    (listOrders as jest.Mock).mockResolvedValue([ORDER]);
    const tree = await renderScreen();
    const texts = textsIn(tree.toJSON() as ReactTestRendererJSON).join(' ').toLowerCase();
    expect(texts).not.toMatch(/accept|complete|cancel|mark as ready|mark ready/);
  });

  it('says so, rather than an empty table, when the shop has no orders yet', async () => {
    (listOrders as jest.Mock).mockResolvedValue([]);
    const tree = await renderScreen();
    const texts = textsIn(tree.toJSON() as ReactTestRendererJSON).join(' ');
    expect(texts).toMatch(/no orders/i);
  });

  it('surfaces a failed fetch rather than silently showing an empty list', async () => {
    (listOrders as jest.Mock).mockRejectedValue(new Error('boom'));
    const tree = await renderScreen();
    const texts = textsIn(tree.toJSON() as ReactTestRendererJSON).join(' ');
    expect(texts).toMatch(/could not load|try again/i);
  });
});
