import { Text } from 'react-native';
import { act, create, type ReactTestInstance, type ReactTestRenderer, type ReactTestRendererJSON } from 'react-test-renderer';
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

import { OrderDetail } from '@/components/orders/order-detail';
import { DataTable } from '@/components/ui/data-table';
import { useAuth } from '@/hooks/use-auth';
import {
  acceptOrder,
  cancelOrder,
  checkOrderFulfilment,
  completeOrder,
  getOrderItems,
  listOrders,
  markOrderReady,
  type ShopOrder,
} from '@/lib/storefront-admin';
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

function texts(tree: ReactTestRenderer): string {
  return textsIn(tree.toJSON() as ReactTestRendererJSON).join(' ');
}

// Matches the exact text of a tab chip (CategoryChip renders its whole label
// as one Text node, count included), then climbs to the nearest pressable
// ancestor -- the same pattern inventory-stock-door.test.tsx uses for a
// header pill.
function pressChip(tree: ReactTestRenderer, label: string) {
  const node = tree.root.findAllByType(Text).find((n) => n.props.children === label);
  if (!node) throw new Error(`no chip labelled "${label}"`);
  let owner: ReactTestInstance | null = node;
  while (owner && typeof owner.props.onPress !== 'function') owner = owner.parent;
  if (!owner) throw new Error(`chip "${label}" has no pressable ancestor`);
  act(() => owner!.props.onPress());
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
  note: null,
  status: 'pending',
  cancellationReason: null,
  itemCount: 3,
  totalCents: 4599,
  createdAt: '2026-08-20T10:00:00.000Z',
};

describe('Orders screen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (useAuth as jest.Mock).mockReturnValue({ shop: { id: 'shop-1' } });
    (getOrderItems as jest.Mock).mockResolvedValue([]);
    (checkOrderFulfilment as jest.Mock).mockResolvedValue([]);
  });

  // Property: "Each row shows what a shop needs to act: number, customer
  // name and phone, item count, collect-or-deliver with the area, total, and
  // when it arrived."
  it('shows what a shop needs to act on an order', async () => {
    (listOrders as jest.Mock).mockResolvedValue([ORDER]);
    const tree = await renderScreen();
    const t = texts(tree);
    expect(t).toContain('7');
    expect(t).toContain('Amina Yusuf');
    expect(t).toContain('+252634456789');
    expect(t).toContain('3');
    expect(t).toContain('Hargeisa - 26 June');
    expect(t).toContain('45.99');
  });

  it('shows a collect order as collect, without inventing a delivery area', async () => {
    (listOrders as jest.Mock).mockResolvedValue([{ ...ORDER, fulfilment: 'collect', deliveryArea: null }]);
    const tree = await renderScreen();
    expect(texts(tree)).toMatch(/collect/i);
  });

  // B4: the landmark is collected, validated and stored -- without showing
  // it here the shop still has to phone the customer to find out where to
  // go, the exact dead end "Hargeisa addresses are landmarks, not street
  // numbers" exists to avoid.
  it('shows the delivery landmark alongside the area, so the shop does not have to phone to find out where to go', async () => {
    (listOrders as jest.Mock).mockResolvedValue([ORDER]);
    const tree = await renderScreen();
    expect(texts(tree)).toContain('Behind Maansoor Hotel, blue gate');
  });

  it('shows no landmark for a collect order', async () => {
    (listOrders as jest.Mock).mockResolvedValue([
      { ...ORDER, fulfilment: 'collect', deliveryArea: null, deliveryLandmark: null },
    ]);
    const tree = await renderScreen();
    expect(texts(tree)).not.toContain('Behind Maansoor Hotel, blue gate');
  });

  // Property 2: the status column plan 3 deliberately left out. Without it a
  // fresh order and a finished one look alike.
  it('shows a status for each order', async () => {
    (listOrders as jest.Mock).mockResolvedValue([{ ...ORDER, status: 'ready' }]);
    const tree = await renderScreen();
    expect(texts(tree)).toMatch(/ready/i);
  });

  it('says so, rather than an empty table, when the shop has no orders yet', async () => {
    (listOrders as jest.Mock).mockResolvedValue([]);
    const tree = await renderScreen();
    expect(texts(tree)).toMatch(/no orders/i);
  });

  it('surfaces a failed fetch rather than silently showing an empty list', async () => {
    (listOrders as jest.Mock).mockRejectedValue(new Error('boom'));
    const tree = await renderScreen();
    expect(texts(tree)).toMatch(/could not load|try again/i);
  });

  // Property 1: tabs for the states a shop works, with a count on the ones
  // that need action.
  describe('status tabs', () => {
    const MIXED: ShopOrder[] = [
      { ...ORDER, id: 'o-pending-1', status: 'pending' },
      { ...ORDER, id: 'o-pending-2', number: 8, status: 'pending' },
      { ...ORDER, id: 'o-accepted', number: 9, status: 'accepted' },
      { ...ORDER, id: 'o-ready', number: 10, status: 'ready' },
      { ...ORDER, id: 'o-done', number: 11, status: 'completed' },
      { ...ORDER, id: 'o-cancelled', number: 12, status: 'cancelled', cancellationReason: 'Out of stock' },
    ];

    it('counts the tabs that need action -- new, accepted, ready -- but not done or cancelled', async () => {
      (listOrders as jest.Mock).mockResolvedValue(MIXED);
      const tree = await renderScreen();
      const t = texts(tree);
      expect(t).toContain('New 2');
      expect(t).toContain('Accepted 1');
      expect(t).toContain('Ready 1');
    });

    it('defaults to the New tab, showing only pending orders', async () => {
      (listOrders as jest.Mock).mockResolvedValue(MIXED);
      const tree = await renderScreen();
      expect(tree.root.findByType(DataTable).props.rows.map((r: ShopOrder) => r.id)).toEqual(['o-pending-1', 'o-pending-2']);
    });

    it('switches the visible rows when a different tab is pressed', async () => {
      (listOrders as jest.Mock).mockResolvedValue(MIXED);
      const tree = await renderScreen();
      pressChip(tree, 'Cancelled');
      expect(tree.root.findByType(DataTable).props.rows.map((r: ShopOrder) => r.id)).toEqual(['o-cancelled']);
    });
  });

  // Property 5: unconfirmed order value is never presented as revenue, and
  // this has to stay true once some orders have moved past "unconfirmed" --
  // a completed order's total already reached the books through
  // complete_storefront_order, so summing it in here alongside a still-open
  // order's total would make the caveat's own claim false.
  describe('the unconfirmed-value caveat', () => {
    it('never lets the total on screen be mistaken for revenue', async () => {
      (listOrders as jest.Mock).mockResolvedValue([ORDER]);
      const tree = await renderScreen();
      expect(texts(tree)).toMatch(/not (money|revenue|takings|a sale)/i);
    });

    it('sums only unconfirmed orders (pending, accepted, ready), excluding a completed order', async () => {
      (listOrders as jest.Mock).mockResolvedValue([
        { ...ORDER, id: 'o-open', status: 'pending', totalCents: 1000 },
        // Already reached the books -- must not be added to "not money the
        // shop has taken".
        { ...ORDER, id: 'o-done', status: 'completed', totalCents: 500000 },
      ]);
      const tree = await renderScreen();
      const t = texts(tree);
      expect(t).toContain('10.00');
      expect(t).not.toContain('5,010.00');
      expect(t).not.toContain('5000.00');
    });

    it('excludes a cancelled order -- it was never going to become revenue at all', async () => {
      (listOrders as jest.Mock).mockResolvedValue([
        { ...ORDER, id: 'o-open', status: 'pending', totalCents: 1000 },
        { ...ORDER, id: 'o-cancelled', status: 'cancelled', totalCents: 999999, cancellationReason: 'x' },
      ]);
      const tree = await renderScreen();
      expect(texts(tree)).not.toContain('9999.99');
    });

    it('says nothing when every order has already resolved (completed or cancelled)', async () => {
      (listOrders as jest.Mock).mockResolvedValue([
        { ...ORDER, id: 'o-done', status: 'completed' },
        { ...ORDER, id: 'o-cancelled', status: 'cancelled', cancellationReason: 'x' },
      ]);
      const tree = await renderScreen();
      expect(texts(tree)).not.toMatch(/not (money|revenue|takings|a sale)/i);
    });
  });

  // No order is open by default -- the detail sheet, and every action it
  // carries, exists only once a row is pressed.
  it('opens no order detail before any row is pressed', async () => {
    (listOrders as jest.Mock).mockResolvedValue([ORDER]);
    const tree = await renderScreen();
    expect(tree.root.findAllByType(OrderDetail)).toHaveLength(0);
  });

  describe('the order detail sheet', () => {
    it('opens on a row press, with that order and its items', async () => {
      (listOrders as jest.Mock).mockResolvedValue([ORDER]);
      (getOrderItems as jest.Mock).mockResolvedValue([
        { id: 'i1', productId: 'p1', productName: 'Rice 5kg', unitPriceCents: 1200, quantity: 2, lineTotalCents: 2400 },
      ]);
      const tree = await renderScreen();

      await act(async () => {
        tree.root.findByType(DataTable).props.onRowPress(ORDER);
      });

      const detail = tree.root.findByType(OrderDetail);
      expect(detail.props.order.id).toBe('order-1');
      expect(detail.props.items).toEqual([
        { id: 'i1', productId: 'p1', productName: 'Rice 5kg', unitPriceCents: 1200, quantity: 2, lineTotalCents: 2400 },
      ]);
      expect(getOrderItems).toHaveBeenCalledWith('order-1');
    });

    it('closes when the sheet reports Close', async () => {
      (listOrders as jest.Mock).mockResolvedValue([ORDER]);
      const tree = await renderScreen();
      await act(async () => {
        tree.root.findByType(DataTable).props.onRowPress(ORDER);
      });
      expect(tree.root.findAllByType(OrderDetail)).toHaveLength(1);

      await act(async () => {
        tree.root.findByType(OrderDetail).props.onClose();
      });
      expect(tree.root.findAllByType(OrderDetail)).toHaveLength(0);
    });

    // Property 4: actions match the state machine exactly -- Accept calls
    // acceptOrder (transition_order pending -> accepted, the only legal move)
    // via storefront-admin, then reloads the list and closes the sheet.
    it('accepting an order calls acceptOrder, reloads the list, and closes the sheet', async () => {
      (listOrders as jest.Mock).mockResolvedValue([ORDER]);
      (acceptOrder as jest.Mock).mockResolvedValue(undefined);
      const tree = await renderScreen();
      await act(async () => {
        tree.root.findByType(DataTable).props.onRowPress(ORDER);
      });

      await act(async () => {
        tree.root.findByType(OrderDetail).props.onAccept();
      });

      expect(acceptOrder).toHaveBeenCalledWith('order-1');
      expect(listOrders).toHaveBeenCalledTimes(2);
      expect(tree.root.findAllByType(OrderDetail)).toHaveLength(0);
    });

    it('marking ready calls markOrderReady', async () => {
      (listOrders as jest.Mock).mockResolvedValue([{ ...ORDER, status: 'accepted' }]);
      (markOrderReady as jest.Mock).mockResolvedValue(undefined);
      const tree = await renderScreen();
      await act(async () => {
        tree.root.findByType(DataTable).props.onRowPress({ ...ORDER, status: 'accepted' });
      });
      await act(async () => {
        tree.root.findByType(OrderDetail).props.onMarkReady();
      });
      expect(markOrderReady).toHaveBeenCalledWith('order-1');
    });

    it('cancelling carries the reason through to cancelOrder', async () => {
      (listOrders as jest.Mock).mockResolvedValue([ORDER]);
      (cancelOrder as jest.Mock).mockResolvedValue(undefined);
      const tree = await renderScreen();
      await act(async () => {
        tree.root.findByType(DataTable).props.onRowPress(ORDER);
      });
      await act(async () => {
        tree.root.findByType(OrderDetail).props.onCancel('Out of stock, customer notified');
      });
      expect(cancelOrder).toHaveBeenCalledWith('order-1', 'Out of stock, customer notified');
    });

    // Property 6: completion asks how the customer paid before it posts.
    it('completing carries the payment method through to completeOrder', async () => {
      const ready = { ...ORDER, status: 'ready' as const };
      (listOrders as jest.Mock).mockResolvedValue([ready]);
      (completeOrder as jest.Mock).mockResolvedValue(undefined);
      const tree = await renderScreen();
      await act(async () => {
        tree.root.findByType(DataTable).props.onRowPress(ready);
      });
      await act(async () => {
        tree.root.findByType(OrderDetail).props.onComplete('zaad');
      });
      expect(completeOrder).toHaveBeenCalledWith('order-1', 'zaad');
    });

    // A button that fails is worse than no button -- a rejected mutation
    // must surface an error and leave the sheet open, not close on failure.
    it('keeps the sheet open and surfaces the error when a move fails', async () => {
      (listOrders as jest.Mock).mockResolvedValue([ORDER]);
      (acceptOrder as jest.Mock).mockRejectedValue(new Error('invalid_order_transition'));
      const tree = await renderScreen();
      await act(async () => {
        tree.root.findByType(DataTable).props.onRowPress(ORDER);
      });
      await act(async () => {
        tree.root.findByType(OrderDetail).props.onAccept();
      });
      expect(tree.root.findAllByType(OrderDetail)).toHaveLength(1);
      expect(tree.root.findByType(OrderDetail).props.actionError).toBeTruthy();
    });
  });
});
