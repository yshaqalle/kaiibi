import { useCallback, useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ScreenHeader } from '@/components/screen-header';
import { BentoCard } from '@/components/ui/bento-card';
import { Caveat } from '@/components/ui/caveat';
import { DataTable, NameCell, ValueCell, type Column } from '@/components/ui/data-table';
import { Colors } from '@/constants/theme';
import { useAuth } from '@/hooks/use-auth';
import { formatCents } from '@/lib/currency';
import { listOrders, type ShopOrder } from '@/lib/storefront-admin';

// Pinned to the light palette for now -- no dark-mode switching yet.
const theme = Colors.light;

// Task 9: an order that lands in a table nobody can see is a lost sale. Plan
// 4 owns the inbox and fulfilment -- accepting, readying, completing -- so
// this screen does exactly one thing: make every order a customer has
// placed visible, read-only, with nothing that changes anything. A button
// here that only half-works would be worse than no button at all.
//
// A ledger is read down a column, so the list is a full-width DataTable in
// one card, OUTSIDE the grid (building-bento-screens.md) -- there is no
// glanceable KPI strip above it worth a BentoGrid of its own, only the one
// figure the Caveat below exists to keep honest.

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

const COLUMNS: Column<ShopOrder>[] = [
  { key: 'number', header: 'Order', width: 76, render: (row) => <ValueCell value={`#${row.number}`} strong /> },
  { key: 'customer', header: 'Customer', render: (row) => <NameCell title={row.customerName} meta={row.customerPhone} /> },
  { key: 'items', header: 'Items', numeric: true, width: 64, render: (row) => <ValueCell value={String(row.itemCount)} tone="muted" /> },
  { key: 'fulfilment', header: 'Fulfilment', render: (row) => <ValueCell value={fulfilmentLabel(row)} /> },
  { key: 'total', header: 'Total', numeric: true, width: 90, render: (row) => <ValueCell value={formatCents(row.totalCents)} strong /> },
  { key: 'when', header: 'When', numeric: true, width: 130, render: (row) => <ValueCell value={whenLabel(row.createdAt)} tone="muted" /> },
];

export default function OrdersScreen() {
  const { shop } = useAuth();
  const [orders, setOrders] = useState<ShopOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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

  const totalCents = orders.reduce((sum, order) => sum + order.totalCents, 0);
  const orderCountLabel = orders.length === 1 ? '1 order' : `${orders.length} orders`;

  return (
    <SafeAreaView style={styles.page} edges={['bottom', 'left', 'right']}>
      <ScreenHeader title="Orders" />
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.headerRow}>
          <Text style={styles.eyebrow}>STOREFRONT</Text>
          <Text style={styles.title}>Orders</Text>
          <Text style={styles.blurb}>Every order a customer has placed from your page.</Text>
        </View>

        <BentoCard title="Orders" scope={orderCountLabel} bodyStyle={styles.tableBody}>
          {error ? (
            <Caveat tone="wrong" action={{ label: 'Try again', onPress: () => { reload(); } }}>
              {error}
            </Caveat>
          ) : (
            <DataTable
              columns={COLUMNS}
              rows={orders}
              keyExtractor={(row) => row.id}
              emptyLabel={loading ? 'Loading…' : 'No orders yet.'}
            />
          )}
        </BentoCard>

        {/* Property 2's sharpest line: an order is a customer's intention,
            not a thing that happened, and nothing on this screen may read as
            "money the shop has taken". `context`, not `wrong` -- the figure
            is correct, it just needs the one sentence that keeps it from
            being misread as revenue. */}
        {!error && orders.length > 0 ? (
          <Caveat tone="context">
            {`${formatCents(totalCents)} across ${orderCountLabel} above is what customers have asked for, not money the shop has taken -- none of it has reached the books.`}
          </Caveat>
        ) : null}
      </ScrollView>
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
  // 10, not the card's usual 18 -- the table brings its own gutters
  // (building-bento-screens.md).
  tableBody: { paddingHorizontal: 10 },
});
