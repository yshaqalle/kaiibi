import { useCallback, useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
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
import { isStale, orderStats, searchOrders, sortOrders, waitedMinutes, type OrderSortField } from '@/lib/orders-reporting';
import {
  acceptOrder,
  cancelOrder,
  amendOrder,
  checkOrderFulfilment,
  completeOrder,
  getCurrentPrices,
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

// A function, not a module-scope constant, because the Waiting column needs
// `now` -- and `now` must be the ONE clock the whole render uses (see the
// comment beside `orderStats(orders, now)` below), never `new Date()` read
// fresh inside a cell. Defined at module scope, called once per render with
// the screen's own `now`: not a component, so it never becomes a component
// defined inside another component's render.
//
// Task 4 adds `hasPosAccess`, `onAction` and `busyId` for the row's own
// action column -- the same permitted-moves table order-detail.tsx's own
// canAccept/canMarkReady/canComplete already read from
// (20260928000100_order_transitions.sql), not a second guess at it.
// Task 5's own addition: `shortBy` is keyed by order id (see the `useEffect`
// in the component below) -- the 'items' column's own render reads it here
// rather than closing over the screen's state directly, same reasoning
// `hasPosAccess`/`onAction`/`busyId` already follow: columnsFor is called
// fresh every render, never memoized, so this closure can never go stale.
function columnsFor(
  now: Date,
  hasPosAccess: boolean,
  onAction: (order: ShopOrder) => void,
  busyId: string | null,
  shortBy: Record<string, number>
): Column<ShopOrder>[] {
  return [
    { key: 'number', header: 'Order', width: 66, sortable: true, render: (row) => <ValueCell value={`#${row.number}`} strong /> },
    {
      key: 'status',
      header: 'Status',
      width: 92,
      render: (row) => {
        const badge = ORDER_STATUS_BADGE[row.status];
        return <Badge label={badge.label} tone={badge.tone} variant="bento" />;
      },
    },
    { key: 'customer', header: 'Customer', sortable: true, render: (row) => <NameCell title={row.customerName} meta={row.customerPhone} /> },
    {
      key: 'items',
      header: 'Items',
      numeric: true,
      // Wider than a bare count (56) needs -- "short 2" beneath it is the
      // widest content this column now ever carries.
      width: 76,
      render: (row) => (
        <View style={styles.itemsCell}>
          <ValueCell value={String(row.itemCount)} tone="muted" />
          {/* A loss-toned figure, never colour alone (deuteranopia makes
              red/green nearly indistinguishable) -- the digit IS the
              signal; `shortBy[row.id] > 0` (not merely "is a key present")
              is what actually gates this, so a check that resolved to a
              real 0 can never render "short 0". */}
          {shortBy[row.id] > 0 ? <Text style={styles.shortFlag}>{`short ${shortBy[row.id]}`}</Text> : null}
        </View>
      ),
    },
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
    { key: 'total', header: 'Total', numeric: true, width: 90, sortable: true, render: (row) => <ValueCell value={formatCents(row.totalCents)} strong /> },
    {
      key: 'waiting',
      header: 'Waiting',
      numeric: true,
      width: 90,
      sortable: true,
      render: (row) => {
        // A finished order is not waiting for anything. An age here would
        // read as overdue forever, which is how a signal stops being
        // trusted -- so a completed or cancelled row gets a dash, never a
        // number of hours.
        if (row.status === 'completed' || row.status === 'cancelled') {
          return <ValueCell value="—" tone="muted" />;
        }
        const minutes = waitedMinutes(row, now);
        const stale = isStale(row, now);
        // The digits are always there; tone/weight are the second signal,
        // never the only one -- a shop scanning quickly should not have to
        // parse a number to notice a problem, but a colourblind or greyscale
        // read must still see the age itself.
        return <ValueCell value={ageLabel(minutes)} tone={stale ? 'warning' : 'muted'} strong={stale} />;
      },
    },
    {
      key: 'next',
      header: 'Next',
      numeric: true,
      width: 108,
      render: (row) => {
        // Read straight off the permitted-moves table
        // (20260928000100_order_transitions.sql), the same one
        // order-detail.tsx's own canAccept/canMarkReady/canComplete already
        // derive from -- 'ready' also needs pos.access, because completing
        // delegates to complete_sale (see that component's own comment).
        const label =
          row.status === 'pending'
            ? 'Accept'
            : row.status === 'accepted'
              ? 'Mark ready'
              : row.status === 'ready' && hasPosAccess
                ? 'Complete'
                : null;
        // An em dash, never a disabled button: a control that can never
        // work must not be drawn as one that might.
        if (!label) return <ValueCell value="—" tone="muted" />;
        return (
          <Pressable
            onPress={(event) => {
              // Without this, the tap reaches the row's own onPress too (the
              // "open this order's detail sheet" press) -- same fix as
              // promotions-tab.tsx's row toggle and date-input.tsx's inner
              // sheet, both nested inside a Pressable row of their own.
              event.stopPropagation();
              // `busyId` here is THIS render's own value -- columnsFor is
              // called fresh on every render (never memoized), so this
              // closure can never go stale the way one captured inside a
              // useCallback with an incomplete dependency list could. A
              // second tap landing while a move is already in flight is a
              // no-op, not a second call to acceptOrder/markOrderReady.
              if (busyId !== null) return;
              onAction(row);
            }}
            disabled={busyId !== null}
            accessibilityLabel={
              row.status === 'pending'
                ? `Accept order ${row.number}`
                : row.status === 'accepted'
                  ? `Mark order ${row.number} ready`
                  : `Complete order ${row.number}`
            }
            style={[styles.rowAction, busyId !== null && styles.rowActionBusy]}
          >
            <Text style={styles.rowActionText}>{busyId === row.id ? '…' : label}</Text>
          </Pressable>
        );
      },
    },
  ];
}

function OrdersScreen() {
  const { shop, can } = useAuth();
  const [orders, setOrders] = useState<ShopOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<OrderStatus>('pending');
  const [search, setSearch] = useState('');
  const [sortField, setSortField] = useState<OrderSortField>('waiting');
  // Longest-waiting first by default -- the reason this screen exists (see
  // the header comment).
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('desc');

  const [selectedOrder, setSelectedOrder] = useState<ShopOrder | null>(null);
  const [detailItems, setDetailItems] = useState<OrderLine[]>([]);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [shortfalls, setShortfalls] = useState<OrderShortfall[]>([]);
  // Today's shelf price per productId, for the amend sheet's pricing choice.
  // Empty until the detail load resolves, and empty for an order that cannot
  // be amended at all -- the sheet reads a missing entry as "cannot re-price
  // this line" rather than as free.
  const [currentPrices, setCurrentPrices] = useState<Record<string, number>>({});
  const [actionSubmitting, setActionSubmitting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  // Task 5: what the 'Items' column adds beside the count -- keyed by order
  // id, and only ever holding an id once its own shortfall is POSITIVE (see
  // the `.filter(([, n]) => n > 0)` below), so a row with nothing to flag is
  // simply absent rather than present with a 0. Only entries whose sum
  // survived a successful check are ever written here.
  const [shortBy, setShortBy] = useState<Record<string, number>>({});

  // B2's own gate, read once and shared by the row's own action column and
  // the detail sheet -- OrderDetail owns no query of its own, and neither
  // does the row.
  const hasPosAccess = can('pos.access');
  // Part 2: amend_order gates on `sales.edit` (20261012000000 -- the nearest
  // existing analogue to "change what a customer owes", since there is no
  // orders.* permission at all). Read here and passed through, exactly as
  // hasPosAccess is, so the sheet draws no button that can only fail.
  const canAmendOrders = can('sales.edit');

  // Which row (by id) has an accept/ready call in flight -- global across
  // the whole table, not just its own row: two rows firing at once would
  // both reload the list and race each other's close-and-reopen. `null`
  // means nothing is mid-flight and every row's action is live.
  const [busyId, setBusyId] = useState<string | null>(null);

  // The order + move an inline row action last failed on, so the caveat
  // below (no sheet open to retry from) can offer "Try again" rather than
  // leaving a shop with a banner and no way to finish what they started.
  // `null` whenever nothing inline has failed, or the last inline failure
  // was superseded by a later attempt succeeding -- see runRowAction.
  const [failedRowAction, setFailedRowAction] = useState<ShopOrder | null>(null);

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

  // Task 5: today checkOrderFulfilment (N1, openDetail below) only runs once
  // a shop OPENS one order -- a shop scanning several rows has no idea which
  // of them it is short on until it opens each one. This runs the same check
  // for every visible OPEN row instead, so the shortfall is on the row
  // itself while scanning. `orders.filter(status === statusFilter)`, not
  // `filteredOrders` -- the latter also depends on `search`, and re-querying
  // stock on every keystroke would ask the same question dozens of times for
  // an answer that has not changed; a search only narrows which already-open
  // rows are ON SCREEN, it can never surface a row this effect has not
  // already asked about.
  //
  // Only OPEN orders (UNCONFIRMED: pending, accepted, ready) are ever asked
  // about -- N1's exact reasoning, applied to the list: a completed order's
  // own completion already decremented the exact stock a check would report
  // on, and a cancelled order was never going to be filled at all.
  //
  // COST: checkOrderFulfilment has no batch form, and its own first line
  // (primaryLocation, storefront-admin.ts) re-resolves the shop's primary
  // location on every single call, plus its own two more queries
  // (order_items, product_location_stock) -- three Supabase round trips per
  // order, not one. N visible open rows is therefore ~3N round trips here,
  // fired concurrently via Promise.all rather than serialised, but not
  // reduced in COUNT by that. primaryLocation is a private, unexported
  // function of storefront-admin.ts and checkOrderFulfilment takes no
  // pre-resolved location -- there is no way to hoist or share that one
  // lookup across calls from this file without changing
  // checkOrderFulfilment's own contract, which is out of this task's scope
  // (Modify: orders.tsx only) and Part 2's territory, not this one's.
  useEffect(() => {
    if (!shop) return;
    const open = UNCONFIRMED.includes(statusFilter) ? orders.filter((o) => o.status === statusFilter) : [];
    if (open.length === 0) {
      setShortBy({});
      return;
    }
    let cancelled = false;
    Promise.all(
      open.map((o) =>
        checkOrderFulfilment(shop.id, o.id)
          .then((rows) => [o.id, rows.reduce((n, r) => n + r.shortBy, 0)] as const)
          // One row's failed check must not blank the whole column -- 0 here
          // reads as "nothing to flag", same as a genuinely fillable order,
          // rather than an error banner for what is a per-row enhancement,
          // not the row's reason for existing.
          .catch(() => [o.id, 0] as const)
      )
    ).then((pairs) => {
      if (!cancelled) setShortBy(Object.fromEntries(pairs.filter(([, n]) => n > 0)));
    });
    return () => {
      cancelled = true;
    };
  }, [shop, statusFilter, orders]);

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
      setCurrentPrices({});
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
        .then(async ([items, shortfallRows]) => {
          setDetailItems(items);
          setShortfalls(shortfallRows);
          // Part 2: today's prices, for the amend sheet's "use today's
          // prices" choice. Fetched only for an order that can still BE
          // amended -- a completed or cancelled one offers no amend button,
          // so the query would buy nothing. Chained after the lines rather
          // than run beside them because it needs their product ids.
          //
          // UNCONFIRMED is the right list by coincidence of definition, not
          // by luck: amend_order refuses `completed` and `cancelled`
          // (order_not_amendable), and ORDERS_NEEDING_ACTION is exactly the
          // other three. A second list naming the same statuses is a second
          // thing to keep in step.
          if (!UNCONFIRMED.includes(order.status)) return;
          const ids = items.map((i) => i.productId).filter((id): id is string => id !== null);
          // CAUGHT HERE, not by the shared .catch below. This lookup feeds one
          // optional control -- the amend sheet's "use today's prices" choice
          // -- and letting it reject would report "Could not load this order"
          // over an order whose lines and shortfalls both arrived fine, hiding
          // everything the shop came to see because a secondary query failed.
          //
          // Leaving the map empty is already a handled state: order-amendment
          // reads a missing price as "cannot re-price this line" and blocks
          // that one choice with its own sentence, which is the truth here.
          try {
            setCurrentPrices(await getCurrentPrices(ids));
          } catch {
            setCurrentPrices({});
          }
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
  // Returns whether the move succeeded -- runRowAction (below) needs that to
  // know whether to remember the row for a retry, since this function
  // already swallows the error into `actionError` rather than rethrowing it.
  const runAction = useCallback(
    async (fn: () => Promise<void>, fallback: string): Promise<boolean> => {
      setActionSubmitting(true);
      setActionError(null);
      try {
        await fn();
        await reload();
        closeDetail();
        return true;
      } catch (err) {
        // B1: every typed error the database raises (transition_order,
        // complete_storefront_order) reaches this catch as a raw snake_case
        // token in `err.message` -- describePlanError first, the house
        // pattern (entitlements.ts:273), for the two refusals that are a
        // plan/module problem rather than an order one; orderErrorMessage
        // second, for the order-specific codes this feature raises; the
        // per-action fallback last, for anything neither recognises.
        setActionError(describePlanError(err) ?? orderErrorMessage(err) ?? extractErrorMessage(err, fallback));
        return false;
      } finally {
        setActionSubmitting(false);
      }
    },
    [reload, closeDetail]
  );

  // The row's own one-tap move -- Accept or Mark ready fire straight
  // through runAction above, same as the sheet's own onAccept/onMarkReady
  // do; Complete does not, because completing needs a payment method and
  // that form already lives in the sheet (order-detail.tsx's "Paid with"
  // chips) -- the row's job is to get the shop there in one tap, not to
  // duplicate the form. Cancel is never offered here at all (see the
  // 'next' column above), so there is no third branch to guard.
  const runRowAction = useCallback(
    (order: ShopOrder) => {
      if (order.status === 'ready') {
        openDetail(order);
        return;
      }
      // The 'next' column's own onPress already refuses a second tap while
      // busyId is set (see its comment) -- by the time this runs, this is
      // the only in-flight row action.
      setBusyId(order.id);
      const move = order.status === 'pending' ? () => acceptOrder(order.id) : () => markOrderReady(order.id);
      runAction(move, order.status === 'pending' ? 'Could not accept this order.' : 'Could not mark this order ready.')
        // Remember this row on failure -- "Try again" below replays the same
        // move on the same order. A success (including a retry's success)
        // clears it, so the caveat's own action never outlives the failure
        // that produced it.
        .then((ok) => setFailedRowAction(ok ? null : order))
        .finally(() => {
          setBusyId(null);
        });
    },
    [openDetail, runAction]
  );

  // ONE clock for the whole render: two rows measured against two `new
  // Date()` calls can disagree, and the tiles would then disagree with the
  // column below them.
  const now = new Date();
  const stats = orderStats(orders, now);

  // Search and sort apply only within the open tab -- searching "khadra" on
  // the New tab must not surface her completed order from last week, and a
  // shop switching tabs mid-search keeps looking for the same thing.
  const filteredOrders = sortOrders(
    searchOrders(
      orders.filter((order) => order.status === statusFilter),
      search
    ),
    sortField,
    sortDirection
  );
  const activeTab = TABS.find((tab) => tab.key === statusFilter) ?? TABS[0];

  // stats.openCount / stats.openCents ARE this sum -- orderStats (
  // orders-reporting.ts) filters on the same isOpen predicate UNCONFIRMED
  // names here (ORDERS_NEEDING_ACTION). A second `orders.filter(...)` here
  // was a second implementation of that one sum: it agreed with `stats` today
  // only because both read isOpen, and would silently stop agreeing the day
  // either definition moved without the other.
  const unconfirmedCountLabel = stats.openCount === 1 ? '1 order' : `${stats.openCount} orders`;

  const emptyLabel = loading
    ? 'Loading…'
    : orders.length === 0
      ? 'No orders yet.'
      : search.trim()
        ? 'No orders match your search.'
        : `No ${activeTab.label.toLowerCase()} orders.`;

  // Pressing the header already driving the order flips direction; pressing
  // any other sortable header adopts it fresh, ascending -- the ordinary
  // convention, and the one the tests below hold it to.
  const handleSortChange = useCallback(
    (key: string) => {
      const field = key as OrderSortField;
      setSortDirection((current) => (field === sortField ? (current === 'asc' ? 'desc' : 'asc') : 'asc'));
      setSortField(field);
    },
    [sortField]
  );

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

        <TextInput
          value={search}
          onChangeText={setSearch}
          placeholder="Search order #, customer, phone or landmark"
          placeholderTextColor={theme.bentoMuted}
          style={styles.search}
          accessibilityLabel="Search orders"
        />

        {/* orders.tsx's `runAction` wrapper (below) sets `actionError` and
            renders it inside OrderDetail -- but Accept and Mark ready, fired
            from the row via `runRowAction`, never open that sheet at all
            (that's the whole point: four orders without opening four
            sheets). Without this, a failed inline action would fail
            SILENTLY -- the shop taps Accept, nothing visibly happens, no
            explanation. Gated on `!selectedOrder` so a failure that DOES
            happen with the sheet open (Cancel, Complete, or Accept/Mark
            ready pressed from inside the sheet itself) is not shown twice --
            OrderDetail already renders that copy of `actionError`.

            Gated on `failedRowAction` too, not just `actionError` -- a
            `wrong` caveat with no action trains people to ignore the whole
            family (caveat.tsx's own doc comment), and every other
            `tone="wrong"` site in this codebase pairs it with one. The
            shop's actual goal was to accept or ready this order, so "Try
            again" replays that exact move rather than just dismissing the
            banner and leaving the order stuck. `failedRowAction` and
            `actionError` are set together (runRowAction's `.then`, right
            after runAction's own catch) and cleared together (a later
            success clears both), so this can only be non-null here for a
            failure that actually came from an inline row action. */}
        {!selectedOrder && failedRowAction && actionError ? (
          <Caveat tone="wrong" action={{ label: 'Try again', onPress: () => runRowAction(failedRowAction) }}>
            {actionError}
          </Caveat>
        ) : null}

        <BentoCard title="Orders" scope={`${filteredOrders.length} order${filteredOrders.length === 1 ? '' : 's'}`} bodyStyle={styles.tableBody}>
          {error ? (
            <Caveat tone="wrong" action={{ label: 'Try again', onPress: () => { reload(); } }}>
              {error}
            </Caveat>
          ) : (
            <DataTable
              columns={columnsFor(now, hasPosAccess, runRowAction, busyId, shortBy)}
              rows={filteredOrders}
              keyExtractor={(row) => row.id}
              emptyLabel={emptyLabel}
              onRowPress={openDetail}
              sort={{ key: sortField, direction: sortDirection }}
              onSortChange={handleSortChange}
            />
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
        {!error && stats.openCount > 0 ? (
          <Caveat tone="context">
            {`${formatCents(stats.openCents)} across ${unconfirmedCountLabel} still open is what customers have asked for, not money the shop has taken -- none of it has reached the books.`}
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
          hasPosAccess={hasPosAccess}
          canAmend={canAmendOrders}
          currentPrices={currentPrices}
          onClose={closeDetail}
          onAccept={() => runAction(() => acceptOrder(selectedOrder.id), 'Could not accept this order.')}
          onMarkReady={() => runAction(() => markOrderReady(selectedOrder.id), 'Could not mark this order ready.')}
          onCancel={(reason) => runAction(() => cancelOrder(selectedOrder.id, reason), 'Could not cancel this order.')}
          onComplete={(method: PaymentMethod) => runAction(() => completeOrder(selectedOrder.id, method), 'Could not complete this order.')}
          onAmend={(lines, reason, options) =>
            runAction(() => amendOrder(selectedOrder.id, lines, reason, options).then(() => undefined), 'Could not change this order.')
          }
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
  search: { backgroundColor: theme.bentoSoft, borderRadius: 12, height: 42, paddingHorizontal: 13, color: theme.bentoInk, fontSize: 13 },
  rowAction: { backgroundColor: theme.bentoInk, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 6, alignItems: 'center' },
  rowActionBusy: { opacity: 0.5 },
  rowActionText: { color: '#FFFFFF', fontWeight: '800', fontSize: 11.5 },
  // flex-end, not the View default (stretch) -- once the count and the flag
  // share a column, `stretch` would widen the box to the flag's own width
  // and pull the plain item count off the right edge every other numeric
  // column in this table keeps it pinned to.
  itemsCell: { alignItems: 'flex-end' },
  // A loss-toned figure, never colour alone -- the digit itself is the
  // signal (see the 'items' column's own comment above).
  shortFlag: { fontSize: 10.5, fontWeight: '800', color: theme.bentoLoss, textAlign: 'right', marginTop: 2 },
});

// Same wall, and it brings a `ScreenHeader` because this screen is pushed over
// the admin shell rather than living inside it -- without one, a walled screen
// would have no Back and no Home. See components/module-wall.tsx.
export default withModuleWall('storefront', OrdersScreen, { title: 'Orders' });
