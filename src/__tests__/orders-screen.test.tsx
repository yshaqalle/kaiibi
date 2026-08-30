import { Text, TextInput } from 'react-native';
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
  // `hasModule` because the screen's default export is wrapped in
  // `withModuleWall` now -- this fixture is a shop whose plan carries the
  // storefront.
  useAuth: jest.fn(() => ({ shop: { id: 'shop-1' }, can: () => true, hasModule: () => true })),
}));

import { OrderDetail } from '@/components/orders/order-detail';
import { StatTile } from '@/components/stat-tile';
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
  orderErrorMessage,
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

// `orders`, when given, is installed on the `listOrders` mock before the
// screen mounts -- every pre-existing call site sets that mock up itself and
// calls this with no argument, so the branch below is a pure addition, not a
// change to how those ~20 tests already behave.
async function renderScreen(orders?: ShopOrder[]): Promise<ReactTestRenderer> {
  if (orders) (listOrders as jest.Mock).mockResolvedValue(orders);
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

// `@testing-library/react-native` is not installed in this repo (see
// storefront-theme-counter.test.tsx for the same note) -- rather than match
// on flattened, concatenated page text (where a bare digit like "2" collides
// with a phone number, a date or an order number), find the actual `StatTile`
// instance by its label and assert on its real props. That is also a
// STRONGER check than text-matching would give: it reads the exact value and
// hint the screen handed the component, not a substring of everything on
// the page.
function statTile(tree: ReactTestRenderer, label: string): ReactTestInstance | undefined {
  return tree.root.findAllByType(StatTile).find((n) => n.props.label === label);
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

// The search box is the one TextInput on this screen while no order is
// selected -- OrderDetail (cancel reason, etc.) only mounts once a row is
// pressed, so this never collides with it in the tests below.
function searchInput(tree: ReactTestRenderer): ReactTestInstance {
  const node = tree.root.findByType(TextInput);
  return node;
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
  subtotalCents: 4499,
  deliveryFeeCents: 100,
  totalCents: 4599,
  createdAt: '2026-08-20T10:00:00.000Z',
};

// "4h ago", relative to whenever the test runs -- for the stat strip, which
// measures waiting time off the real clock (see orders-reporting.ts's own
// `now` parameter).
const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();

function makeOrder(over: Partial<ShopOrder> = {}): ShopOrder {
  return { ...ORDER, ...over };
}

describe('Orders screen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (useAuth as jest.Mock).mockReturnValue({ shop: { id: 'shop-1' }, can: () => true, hasModule: () => true });
    (getOrderItems as jest.Mock).mockResolvedValue([]);
    (checkOrderFulfilment as jest.Mock).mockResolvedValue([]);
  });

  // Property: "Each row shows what a shop needs to act: number, customer
  // name and phone, item count, collect-or-deliver with the area, total, and
  // how long it's been waiting."
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

  // The stat strip above the table (orders-reporting.ts's `orderStats`,
  // wired but not recomputed here) -- Property 1's tabs answer "how many are
  // in each state"; this answers "which of them needs me right now".
  describe('the stat strip', () => {
    it('leads with what nobody has looked at yet, and how long it has waited', async () => {
      const tree = await renderScreen([
        makeOrder({ id: 'a', status: 'pending', createdAt: hoursAgo(4) }),
        makeOrder({ id: 'b', status: 'pending', createdAt: hoursAgo(1) }),
        makeOrder({ id: 'c', status: 'ready' }),
      ]);
      const tile = statTile(tree, 'Needs you now');
      expect(tile).toBeTruthy();
      expect(tile?.props.value).toBe('2');
      expect(tile?.props.hint).toMatch(/oldest waiting 4h/i);
    });

    // The default tab is "New" (pending only). A wiring that fed the
    // FILTERED rows into orderStats instead of the full list would still
    // pass the test above -- both extra orders there are pending too -- but
    // would silently zero out any figure that depends on a status the open
    // tab is not showing. This fixture is built so that swap changes what
    // is on screen.
    it('counts every order the shop has, not just the ones on the open tab', async () => {
      const tree = await renderScreen([
        makeOrder({ id: 'p', status: 'pending', totalCents: 1000 }),
        makeOrder({ id: 'r', status: 'ready', totalCents: 2500 }),
        makeOrder({ id: 'done', status: 'completed', totalCents: 8000 }),
      ]);
      expect(statTile(tree, 'Ready to hand over')?.props.value).toBe('$25');
      expect(statTile(tree, 'Converted')?.props.value).toBe('$80');
    });

    it('never calls open order value revenue', async () => {
      const tree = await renderScreen([makeOrder({ status: 'pending', totalCents: 4750 })]);
      const tile = statTile(tree, 'Promised');
      expect(tile).toBeTruthy();
      expect(tile?.props.value).toBe('$48');
      expect(texts(tree)).not.toMatch(/revenue/i);
    });

    it('shows no waiting hint when nothing is pending', async () => {
      const tree = await renderScreen([makeOrder({ status: 'ready' })]);
      expect(statTile(tree, 'Needs you now')?.props.hint).not.toMatch(/oldest waiting/i);
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

    // B1: runAction chains orderErrorMessage (storefront-admin.ts) ahead of
    // its own per-action fallback, so a typed database code reaches the shop
    // as a sentence, not `err.message` verbatim. storefront-admin.ts is
    // automocked in this file (see the header comment) -- content coverage
    // for every code lives in storefront-admin.test.ts; this proves the
    // WIRING, that whatever orderErrorMessage returns wins over the fallback.
    it("uses orderErrorMessage's mapped sentence instead of the raw code or the generic fallback", async () => {
      (listOrders as jest.Mock).mockResolvedValue([ORDER]);
      (acceptOrder as jest.Mock).mockRejectedValue({ message: 'invalid_order_transition' });
      (orderErrorMessage as jest.Mock).mockReturnValue('Someone else on your team already moved this order.');
      const tree = await renderScreen();
      await act(async () => {
        tree.root.findByType(DataTable).props.onRowPress(ORDER);
      });
      await act(async () => {
        tree.root.findByType(OrderDetail).props.onAccept();
      });
      expect(tree.root.findByType(OrderDetail).props.actionError).toBe('Someone else on your team already moved this order.');
    });

    // N1: a shortfall check is only meaningful while an order still needs
    // filling -- a completed order's own completion already decremented that
    // exact stock, so there is nothing left to check.
    it('does not check fulfilment for a completed order -- there is nothing left to fill', async () => {
      const done = { ...ORDER, status: 'completed' as const };
      (listOrders as jest.Mock).mockResolvedValue([done]);
      const tree = await renderScreen();
      await act(async () => {
        tree.root.findByType(DataTable).props.onRowPress(done);
      });
      expect(checkOrderFulfilment).not.toHaveBeenCalled();
      expect(tree.root.findByType(OrderDetail).props.shortfalls).toEqual([]);
    });

    it('does not check fulfilment for a cancelled order either', async () => {
      const cancelled = { ...ORDER, status: 'cancelled' as const, cancellationReason: 'Out of stock' };
      (listOrders as jest.Mock).mockResolvedValue([cancelled]);
      const tree = await renderScreen();
      await act(async () => {
        tree.root.findByType(DataTable).props.onRowPress(cancelled);
      });
      expect(checkOrderFulfilment).not.toHaveBeenCalled();
    });

    it('still checks fulfilment for an order that needs action', async () => {
      (listOrders as jest.Mock).mockResolvedValue([ORDER]);
      const tree = await renderScreen();
      await act(async () => {
        tree.root.findByType(DataTable).props.onRowPress(ORDER);
      });
      expect(checkOrderFulfilment).toHaveBeenCalledWith('shop-1', 'order-1');
    });

    // B2: /orders is gated on settings.access, but completing an order needs
    // pos.access. This screen owns the one call to can() -- OrderDetail gets
    // told, not asked.
    describe('pos.access reaches OrderDetail', () => {
      it("passes hasPosAccess through from can('pos.access')", async () => {
        (useAuth as jest.Mock).mockReturnValue({
          shop: { id: 'shop-1' },
          can: (permission: string) => permission !== 'pos.access',
          hasModule: () => true,
        });
        (listOrders as jest.Mock).mockResolvedValue([ORDER]);
        const tree = await renderScreen();
        await act(async () => {
          tree.root.findByType(DataTable).props.onRowPress(ORDER);
        });
        expect(tree.root.findByType(OrderDetail).props.hasPosAccess).toBe(false);
      });

      it("passes hasPosAccess=true through when the member does have it", async () => {
        (listOrders as jest.Mock).mockResolvedValue([ORDER]);
        const tree = await renderScreen();
        await act(async () => {
          tree.root.findByType(DataTable).props.onRowPress(ORDER);
        });
        expect(tree.root.findByType(OrderDetail).props.hasPosAccess).toBe(true);
      });
    });
  });

  // Task 3: a search box, sortable headers, and a Waiting column that
  // replaces When. orders-reporting.ts (Task 1) owns every bit of the
  // filtering/sorting/age arithmetic these tests exercise -- searchOrders,
  // sortOrders, waitedMinutes, isStale -- so what is under test here is only
  // the screen's WIRING to those functions, never the arithmetic itself.
  describe('finding an order', () => {
    const AMINA = makeOrder({ id: 'a', number: 1042, customerName: 'Amina Warsame', customerPhone: '+252611110000' });
    const KHADRA = makeOrder({ id: 'b', number: 1041, customerName: 'Khadra Ismail', customerPhone: '+252622220000' });

    it('has a discoverable search box', async () => {
      const tree = await renderScreen([AMINA, KHADRA]);
      expect(searchInput(tree).props.placeholder).toMatch(/search/i);
    });

    it('narrows the visible rows to the one matching what was typed, and leaves the other out', async () => {
      const tree = await renderScreen([AMINA, KHADRA]);
      await act(async () => {
        searchInput(tree).props.onChangeText('khadra');
      });
      expect(tree.root.findByType(DataTable).props.rows.map((r: ShopOrder) => r.id)).toEqual(['b']);
    });

    it('says nothing matched, rather than showing an empty table with no explanation', async () => {
      const tree = await renderScreen([AMINA]);
      await act(async () => {
        searchInput(tree).props.onChangeText('zzz-does-not-exist');
      });
      expect(tree.root.findByType(DataTable).props.rows).toEqual([]);
      expect(tree.root.findByType(DataTable).props.emptyLabel).toMatch(/no orders match/i);
    });
  });

  describe('the waiting column', () => {
    function waitingColumn(tree: ReactTestRenderer) {
      const column = tree.root.findByType(DataTable).props.columns.find((c: { key: string }) => c.key === 'waiting');
      if (!column) throw new Error('no "waiting" column on the table');
      return column;
    }

    it('shows how long a still-open order has waited, quietly, under the stale threshold', async () => {
      const tree = await renderScreen([makeOrder({ status: 'pending', createdAt: hoursAgo(2) })]);
      const row = tree.root.findByType(DataTable).props.rows[0];
      const cell = waitingColumn(tree).render(row);
      expect(cell.props.value).toBe('2h');
      expect(cell.props.tone).toBe('muted');
      expect(cell.props.strong).toBeFalsy();
    });

    // STALE_AFTER_MINUTES is 180 (orders-reporting.ts); 4h = 240 minutes is
    // well past it. The screen must not leave a genuinely stale order
    // looking exactly like a fresh one.
    it('flags an order past the stale threshold instead of leaving it looking ordinary', async () => {
      const tree = await renderScreen([makeOrder({ status: 'pending', createdAt: hoursAgo(4) })]);
      const row = tree.root.findByType(DataTable).props.rows[0];
      const cell = waitingColumn(tree).render(row);
      expect(cell.props.value).toBe('4h');
      expect(cell.props.tone).toBe('warning');
      expect(cell.props.strong).toBe(true);
    });

    // A finished order is not waiting for anything -- an age here would read
    // as overdue forever, which is how a signal stops being trusted.
    it('shows an em dash, never an age, once an order is done', async () => {
      const tree = await renderScreen([makeOrder({ id: 'done', status: 'completed', createdAt: hoursAgo(200) })]);
      pressChip(tree, 'Done');
      const row = tree.root.findByType(DataTable).props.rows[0];
      expect(row.id).toBe('done');
      const cell = waitingColumn(tree).render(row);
      expect(cell.props.value).toBe('—');
      expect(cell.props.tone).toBe('muted');
      expect(cell.props.strong).toBeFalsy();
    });

    it('shows an em dash for a cancelled order too', async () => {
      const tree = await renderScreen([
        makeOrder({ id: 'x', status: 'cancelled', cancellationReason: 'Out of stock', createdAt: hoursAgo(500) }),
      ]);
      pressChip(tree, 'Cancelled');
      const row = tree.root.findByType(DataTable).props.rows[0];
      const cell = waitingColumn(tree).render(row);
      expect(cell.props.value).toBe('—');
    });
  });

  // DataTable itself gained an optional, defaulted-off `sort`/`onSortChange`
  // pair (src/components/ui/data-table.tsx) so the other ~19 callers are
  // unaffected -- see `npx jest src/components` in the task report. These
  // tests are about THIS screen's wiring: which columns it marks sortable,
  // what it opens sorted by, and what pressing a header does to row order.
  describe('sortable headers', () => {
    const LOW = makeOrder({ id: 'low', number: 10, customerName: 'Amina', totalCents: 500, createdAt: hoursAgo(1) });
    const HIGH = makeOrder({ id: 'high', number: 20, customerName: 'Zeynab', totalCents: 5000, createdAt: hoursAgo(5) });

    it('marks only Order, Customer, Total and Waiting sortable -- Status, Items and Fulfilment stay plain', async () => {
      const tree = await renderScreen([LOW]);
      const columns: { key: string; sortable?: boolean }[] = tree.root.findByType(DataTable).props.columns;
      const sortableKeys = columns.filter((c) => c.sortable).map((c) => c.key);
      expect(sortableKeys.sort()).toEqual(['customer', 'number', 'total', 'waiting']);
    });

    // Waiting, longest-waiting first, is the default -- it is the whole
    // reason this screen exists, per Task 3's brief.
    it('opens sorted by Waiting, longest-waiting order first', async () => {
      const tree = await renderScreen([LOW, HIGH]);
      const dataTable = tree.root.findByType(DataTable);
      expect(dataTable.props.sort).toEqual({ key: 'waiting', direction: 'desc' });
      expect(dataTable.props.rows.map((r: ShopOrder) => r.id)).toEqual(['high', 'low']);
    });

    it('sorts by Order ascending on the first press of that header', async () => {
      const tree = await renderScreen([HIGH, LOW]);
      await act(async () => {
        tree.root.findByType(DataTable).props.onSortChange('number');
      });
      expect(tree.root.findByType(DataTable).props.rows.map((r: ShopOrder) => r.id)).toEqual(['low', 'high']);
    });

    it('flips direction on a second press of the same header, rather than doing nothing', async () => {
      const tree = await renderScreen([HIGH, LOW]);
      await act(async () => {
        tree.root.findByType(DataTable).props.onSortChange('number');
      });
      expect(tree.root.findByType(DataTable).props.rows.map((r: ShopOrder) => r.id)).toEqual(['low', 'high']);

      await act(async () => {
        tree.root.findByType(DataTable).props.onSortChange('number');
      });
      expect(tree.root.findByType(DataTable).props.rows.map((r: ShopOrder) => r.id)).toEqual(['high', 'low']);
    });

    it('sorts by Total when that header is pressed', async () => {
      const tree = await renderScreen([HIGH, LOW]);
      await act(async () => {
        tree.root.findByType(DataTable).props.onSortChange('total');
      });
      expect(tree.root.findByType(DataTable).props.rows.map((r: ShopOrder) => r.id)).toEqual(['low', 'high']);
    });
  });
});
