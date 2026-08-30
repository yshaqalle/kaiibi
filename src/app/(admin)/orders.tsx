import { useCallback, useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Badge } from '@/components/badge';
import { CategoryChip } from '@/components/category-chip';
import { withModuleWall } from '@/components/module-wall';
import { ORDER_STATUS_BADGE, OrderDetail } from '@/components/orders/order-detail';
import { ScreenHeader } from '@/components/screen-header';
import { StatTile } from '@/components/stat-tile';
import { BentoCard } from '@/components/ui/bento-card';
import { Caveat } from '@/components/ui/caveat';
import { DataTable, NameCell, ValueCell, type Column } from '@/components/ui/data-table';
import { Colors } from '@/constants/theme';
import { useAuth } from '@/hooks/use-auth';
import { formatCents, formatCompactCents } from '@/lib/currency';
import { describePlanError } from '@/lib/entitlements';
import type { OrderShortfall } from '@/lib/order-fulfilment';
// The states a shop still has something to do about -- what "unconfirmed"
// means for the caveat below. Deliberately NOT `pending` alone: an accepted
// or ready order is just as unconverted, it is only further along the same
// unfinished road. Same rule storefront-admin.ts calls ORDERS_NEEDING_ACTION
// (renamed on import for this screen's own vocabulary); imported from
// lib/order-status.ts rather than lib/storefront-admin.ts directly because
// this screen's own tests blanket-automock the latter
// (`jest.mock('@/lib/storefront-admin')`, no factory), which would silently
// replace a plain array export with an empty one.
import { ORDERS_NEEDING_ACTION as UNCONFIRMED } from '@/lib/order-status';
import { orderStats } from '@/lib/orders-reporting';
import {
  acceptOrder,
  cancelOrder,
  checkOrderFulfilment,
  completeOrder,
  getOrderItems,
  listOrders,
  markOrderReady,
  orderErrorMessage,
  type OrderLine,
  type OrderStatus,
  type PaymentMethod,
  type ShopOrder,
} from '@/lib/storefront-admin';

// Pinned to the light palette for now -- no dark-mode switching yet.
const theme = Colors.light;

// Task 9 made every order a customer has placed visible, read-only, on
// purpose -- Plan 4 owned accepting, readying and completing them, and a
// half-working control then would have been worse than no button at all.
// Task 6 is that plan: this screen is now the inbox a shop actually works
// from. The state machine it offers buttons for is not approximated here --
// it is read straight off 20260928000100_order_transitions.sql's own
// permitted-moves table and 20260928000200_complete_storefront_order.sql's
// one additional edge, both enforced again, unavoidably, by a trigger on the
// table itself. An order that cannot move to a state is never offered a
// button for it (order-detail.tsx's canAccept/canMarkReady/canComplete/
// canCancel), because a button that fails is worse than no button.
//
// A ledger is read down a column, so the list is a full-width DataTable in
// one card, OUTSIDE the grid (building-bento-screens.md).

const TABS: { key: OrderStatus; label: string; needsCount: boolean }[] = [
  { key: 'pending', label: 'New', needsCount: true },
  { key: 'accepted', label: 'Accepted', needsCount: true },
  { key: 'ready', label: 'Ready', needsCount: true },
  { key: 'completed', label: 'Done', needsCount: false },
  { key: 'cancelled', label: 'Cancelled', needsCount: false },
];

function fulfilmentLabel(order: ShopOrder): string {
  return order.fulfilment === 'deliver' ? `Deliver · ${order.deliveryArea ?? '—'}` : 'Collect';
}

// Fixed at render time from each row's own `createdAt`, not the wall clock --
// unlike an age ("3h ago") this never needs to be rebuilt on a timer, so
// there is nothing here for a stale render to get wrong.
function whenLabel(createdAt: string): string {
  const when = new Date(createdAt);
  const date = when.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  const time = when.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return `${date} · ${time}`;
}

// "4h", "35m" -- an age, not a duration in words. Short because it sits inside
// a tile's hint line and beside it in a table cell.
function ageLabel(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h`;
}

function extractErrorMessage(err: unknown, fallback: string): string {
  if (err && typeof err === 'object' && 'message' in err && typeof (err as { message: unknown }).message === 'string') {
    return (err as { message: string }).message;
  }
  return fallback;
}

const COLUMNS: Column<ShopOrder>[] = [
  { key: 'number', header: 'Order', width: 66, render: (row) => <ValueCell value={`#${row.number}`} strong /> },
  {
    key: 'status',
    header: 'Status',
    width: 92,
    render: (row) => {
      const badge = ORDER_STATUS_BADGE[row.status];
      return <Badge label={badge.label} tone={badge.tone} variant="bento" />;
    },
  },
  { key: 'customer', header: 'Customer', render: (row) => <NameCell title={row.customerName} meta={row.customerPhone} /> },
  { key: 'items', header: 'Items', numeric: true, width: 56, render: (row) => <ValueCell value={String(row.itemCount)} tone="muted" /> },
  {
    key: 'fulfilment',
    header: 'Fulfilment',
    // B4: the landmark, not just the priced area -- "Hargeisa addresses are
    // landmarks, not street numbers" is checkout's whole delivery premise
    // (checkout-form.tsx), and without it here the shop still has to phone
    // the customer to find out where to actually go. NameCell's own meta
    // line already exists for exactly this "the thing, then what qualifies
    // it" shape; collect orders carry no landmark, so nothing renders below
    // the label for them.
    render: (row) => <NameCell title={fulfilmentLabel(row)} meta={row.fulfilment === 'deliver' ? row.deliveryLandmark ?? undefined : undefined} />,
  },
  { key: 'total', header: 'Total', numeric: true, width: 90, render: (row) => <ValueCell value={formatCents(row.totalCents)} strong /> },
  { key: 'when', header: 'When', numeric: true, width: 130, render: (row) => <ValueCell value={whenLabel(row.createdAt)} tone="muted" /> },
];

function OrdersScreen() {
  const { shop, can } = useAuth();
  const [orders, setOrders] = useState<ShopOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<OrderStatus>('pending');

  const [selectedOrder, setSelectedOrder] = useState<ShopOrder | null>(null);
  const [detailItems, setDetailItems] = useState<OrderLine[]>([]);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [shortfalls, setShortfalls] = useState<OrderShortfall[]>([]);
  const [actionSubmitting, setActionSubmitting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!shop) return;
    setLoading(true);
    try {
      setOrders(await listOrders(shop.id));
      setError(null);
    } catch {
      // Said rather than shown as an empty list: "no orders yet" and "this
      // did not load" look identical otherwise, and only one of them is true.
      setError('Could not load orders.');
    } finally {
      setLoading(false);
    }
  }, [shop]);

  useEffect(() => {
    reload();
  }, [reload]);

  const closeDetail = useCallback(() => {
    setSelectedOrder(null);
    setDetailItems([]);
    setDetailError(null);
    setShortfalls([]);
    setActionError(null);
  }, []);

  const openDetail = useCallback(
    (order: ShopOrder) => {
      if (!shop) return;
      setSelectedOrder(order);
      setDetailItems([]);
      setDetailError(null);
      setShortfalls([]);
      setActionError(null);
      setDetailLoading(true);
      // N1: a shortfall check is only meaningful while the order still needs
      // filling -- a completed order already had its stock decremented by
      // its own completion, and a cancelled order was never going to be
      // filled at all. Skipping the query entirely (rather than fetching and
      // letting order-detail.tsx's own gate hide it) is what actually saves
      // the round trip, not just the render.
      const fulfilmentCheck = UNCONFIRMED.includes(order.status)
        ? checkOrderFulfilment(shop.id, order.id)
        : Promise.resolve([]);
      Promise.all([getOrderItems(order.id), fulfilmentCheck])
        .then(([items, shortfallRows]) => {
          setDetailItems(items);
          setShortfalls(shortfallRows);
        })
        .catch(() => {
          // Said rather than shown as an empty list, same reasoning as the
          // list's own load failure -- "nothing to collect" and "this did not
          // load" must not look identical.
          setDetailError('Could not load this order.');
        })
        .finally(() => setDetailLoading(false));
    },
    [shop]
  );

  // Every accept/ready/cancel/complete move shares this shape: submit, and
  // only on success reload the list (so the row the shop is looking at next
  // reflects the move) and close the sheet. A failure surfaces on the sheet
  // itself and leaves it open -- a shop mid-cancellation must not lose what
  // it typed to a network blip.
  const runAction = useCallback(
    async (fn: () => Promise<void>, fallback: string) => {
      setActionSubmitting(true);
      setActionError(null);
      try {
        await fn();
        await reload();
        closeDetail();
      } catch (err) {
        // B1: every typed error the database raises (transition_order,
        // complete_storefront_order) reaches this catch as a raw snake_case
        // token in `err.message` -- describePlanError first, the house
        // pattern (entitlements.ts:273), for the two refusals that are a
        // plan/module problem rather than an order one; orderErrorMessage
        // second, for the order-specific codes this feature raises; the
        // per-action fallback last, for anything neither recognises.
        setActionError(describePlanError(err) ?? orderErrorMessage(err) ?? extractErrorMessage(err, fallback));
      } finally {
        setActionSubmitting(false);
      }
    },
    [reload, closeDetail]
  );

  // ONE clock for the whole render: two rows measured against two `new
  // Date()` calls can disagree, and the tiles would then disagree with the
  // column below them.
  const now = new Date();
  const stats = orderStats(orders, now);

  const filteredOrders = orders.filter((order) => order.status === statusFilter);
  const activeTab = TABS.find((tab) => tab.key === statusFilter) ?? TABS[0];

  const unconfirmedOrders = orders.filter((order) => UNCONFIRMED.includes(order.status));
  const unconfirmedTotalCents = unconfirmedOrders.reduce((sum, order) => sum + order.totalCents, 0);
  const unconfirmedCountLabel = unconfirmedOrders.length === 1 ? '1 order' : `${unconfirmedOrders.length} orders`;

  const emptyLabel = loading ? 'Loading…' : orders.length === 0 ? 'No orders yet.' : `No ${activeTab.label.toLowerCase()} orders.`;

  return (
    <SafeAreaView style={styles.page} edges={['bottom', 'left', 'right']}>
      <ScreenHeader title="Orders" />
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.headerRow}>
          <Text style={styles.eyebrow}>STOREFRONT</Text>
          <Text style={styles.title}>Orders</Text>
          <Text style={styles.blurb}>Every order a customer has placed from your page.</Text>
        </View>

        <View style={styles.tabRow}>
          {TABS.map((tab) => {
            const count = orders.filter((order) => order.status === tab.key).length;
            return (
              <CategoryChip
                key={tab.key}
                variant="bento"
                active={statusFilter === tab.key}
                onPress={() => setStatusFilter(tab.key)}
                label={tab.needsCount ? `${tab.label} ${count}` : tab.label}
              />
            );
          })}
        </View>

        <BentoCard title="Where these orders stand" scope={`${stats.openCount} open`}>
          <View style={styles.metricRow}>
            {/* First, because it is the only figure here a shop must act on
                within the hour. No `tone="accent"` -- StatTile's tone union
                is 'default' | 'warning' | 'positive' only, and being first
                in the row already carries the emphasis. */}
            <StatTile
              variant="bento"
              value={String(stats.needsAttention)}
              label="Needs you now"
              hint={stats.oldestWaitingMinutes === null ? 'nothing new' : `oldest waiting ${ageLabel(stats.oldestWaitingMinutes)}`}
            />
            {/* Deliberately not "revenue" -- the caveat below says why in
                words, and this label must not contradict it. */}
            <StatTile
              variant="bento"
              value={formatCompactCents(stats.openCents)}
              label="Promised"
              hint={`across ${stats.openCount} open ${stats.openCount === 1 ? 'order' : 'orders'}`}
            />
            <StatTile
              variant="bento"
              value={formatCompactCents(stats.readyCents)}
              label="Ready to hand over"
              hint={`${stats.readyCount} prepped, uncollected`}
            />
            <StatTile
              variant="bento"
              value={formatCompactCents(stats.convertedCents)}
              label="Converted"
              hint="reached the books as sales"
            />
          </View>
        </BentoCard>

        <BentoCard title="Orders" scope={`${filteredOrders.length} order${filteredOrders.length === 1 ? '' : 's'}`} bodyStyle={styles.tableBody}>
          {error ? (
            <Caveat tone="wrong" action={{ label: 'Try again', onPress: () => { reload(); } }}>
              {error}
            </Caveat>
          ) : (
            <DataTable columns={COLUMNS} rows={filteredOrders} keyExtractor={(row) => row.id} emptyLabel={emptyLabel} onRowPress={openDetail} />
          )}
        </BentoCard>

        {/* Property 5's sharpest line: an order is a customer's intention,
            not a thing that happened, and nothing on this screen may read as
            "money the shop has taken". Scoped to UNCONFIRMED orders only --
            once an order is completed its total has already reached the
            books through complete_storefront_order, and a cancelled order
            was never going to become revenue at all, so both would make this
            caveat's own claim false if they were still added in. `context`,
            not `wrong` -- the figure is correct, it just needs the one
            sentence that keeps it from being misread as revenue. */}
        {!error && unconfirmedOrders.length > 0 ? (
          <Caveat tone="context">
            {`${formatCents(unconfirmedTotalCents)} across ${unconfirmedCountLabel} still open is what customers have asked for, not money the shop has taken -- none of it has reached the books.`}
          </Caveat>
        ) : null}
      </ScrollView>

      {selectedOrder ? (
        <OrderDetail
          order={selectedOrder}
          items={detailItems}
          itemsLoading={detailLoading}
          itemsError={detailError}
          shortfalls={shortfalls}
          hasPosAccess={can('pos.access')}
          onClose={closeDetail}
          onAccept={() => runAction(() => acceptOrder(selectedOrder.id), 'Could not accept this order.')}
          onMarkReady={() => runAction(() => markOrderReady(selectedOrder.id), 'Could not mark this order ready.')}
          onCancel={(reason) => runAction(() => cancelOrder(selectedOrder.id, reason), 'Could not cancel this order.')}
          onComplete={(method: PaymentMethod) => runAction(() => completeOrder(selectedOrder.id, method), 'Could not complete this order.')}
          submitting={actionSubmitting}
          actionError={actionError}
        />
      ) : null}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: theme.bentoPage },
  content: { padding: 18, paddingBottom: 60, gap: 14 },
  headerRow: { marginBottom: 2 },
  eyebrow: { fontSize: 10.5, fontWeight: '800', letterSpacing: 1, color: theme.bentoMuted, marginBottom: 3 },
  title: { color: theme.bentoInk, fontSize: 26, fontWeight: '800', letterSpacing: -1 },
  blurb: { color: theme.bentoMuted, fontSize: 13, marginTop: 3 },
  tabRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  metricRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  // 10, not the card's usual 18 -- the table brings its own gutters
  // (building-bento-screens.md).
  tableBody: { paddingHorizontal: 10 },
});

// Same wall, and it brings a `ScreenHeader` because this screen is pushed over
// the admin shell rather than living inside it -- without one, a walled screen
// would have no Back and no Home. See components/module-wall.tsx.
export default withModuleWall('storefront', OrdersScreen, { title: 'Orders' });
