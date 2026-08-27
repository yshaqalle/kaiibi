import { useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { useTabRefresh, type RefreshSetter } from '@/components/accounting/use-header-actions';
import { BentoCard } from '@/components/ui/bento-card';
import { Caveat } from '@/components/ui/caveat';
import { DataTable, NameCell, ValueCell, type Column } from '@/components/ui/data-table';
import { useAuth } from '@/hooks/use-auth';
import { useRefreshOnFocus } from '@/hooks/use-refresh-on-focus';
import { lowStockReading, type LowStockEmptyReason, type LowStockRow, type StockUrgency } from '@/lib/report-math';
import { loadInventoryReport, type StockOnHandRow } from '@/lib/reports';

// Items at or below their reorder point, worst first.
//
// THE EMPTY STATE MEANS TWO DIFFERENT THINGS and must say which.
// `product_location_stock.reorder_level` is nullable, most shops leave it
// blank, and "nothing is low" and "nobody has set a level" are different facts.
// A report that is empty because no level exists anywhere, rendered as though
// the shelves were fine, tells a shop its stock is healthy on the strength of
// a question it never answered. `lowStockReading` returns which case it is;
// this screen renders the two differently.
//
// No `dateRange`, for the reason Inventory Balance has none: a shortfall is a
// position read at an instant.

type Row = LowStockRow<StockOnHandRow>;

const URGENCY: Record<StockUrgency, { label: string; tone: 'danger' | 'warning' }> = {
  out: { label: 'Out of stock', tone: 'danger' },
  critical: { label: 'Critical', tone: 'danger' },
  low: { label: 'Low', tone: 'warning' },
};

const COLUMNS: Column<Row>[] = [
  {
    key: 'product',
    header: 'Product',
    render: (row) => <NameCell title={row.productName} meta={row.locationName} />,
  },
  {
    key: 'urgency',
    header: 'State',
    width: 110,
    render: (row) => <ValueCell value={URGENCY[row.urgency].label} tone={URGENCY[row.urgency].tone} />,
  },
  { key: 'stock', header: 'On hand', numeric: true, render: (row) => <ValueCell value={String(row.stock)} /> },
  {
    key: 'level',
    header: 'Reorder at',
    numeric: true,
    // Non-null on every row here: a row with no level set has a null shortfall
    // and never reaches this table.
    render: (row) => <ValueCell value={String(row.reorderLevel)} tone="muted" />,
  },
  {
    key: 'shortfall',
    header: 'Order at least',
    numeric: true,
    render: (row) => <ValueCell value={String(row.shortfall)} strong />,
  },
];

/** What an empty report actually means, in the reader's words. */
const EMPTY_LABEL: Record<NonNullable<LowStockEmptyReason>, string> = {
  'nothing-low': 'Nothing is at or below its reorder level.',
  // Says the report is not answering the question, rather than answering it
  // with good news nobody has earned.
  'none-configured': 'No reorder levels have been set, so nothing can be judged low.',
};

export function LowStockView({
  locationFilter,
  setRefresh,
}: {
  locationFilter: string | null;
  setRefresh: RefreshSetter;
}) {
  const { shop } = useAuth();
  const router = useRouter();
  const [stock, setStock] = useState<StockOnHandRow[] | null>(null);

  const reload = useCallback(async () => {
    if (!shop) return;
    setStock(await loadInventoryReport(shop.id, locationFilter));
  }, [shop, locationFilter]);

  // See the note in chart-of-accounts-view.tsx: use-refresh-on-focus does not
  // fetch on the mounting focus, and depends on this effect having done it.
  useEffect(() => { reload(); }, [reload]);
  useRefreshOnFocus(reload);
  useTabRefresh(setRefresh, reload);

  const reading = useMemo(() => lowStockReading(stock ?? []), [stock]);
  const unconfigured = (stock?.length ?? 0) - reading.configured;

  return (
    <View style={styles.wrap}>
      <BentoCard
        title="To reorder"
        scope="As of today"
        bodyStyle={styles.tableBody}
      >
        <DataTable
          columns={COLUMNS}
          rows={reading.rows}
          keyExtractor={(row) => `${row.productId}:${row.locationId}`}
          emptyLabel={stock === null ? 'Loading…' : EMPTY_LABEL[reading.emptyReason ?? 'nothing-low']}
        />
      </BentoCard>

      {/* 'wrong', and it earns the tone: the report on screen is not answering
          the question the reader asked, the cause is removable, and the action
          removes it. Anything softer here reads as "all good". */}
      {stock !== null && reading.emptyReason === 'none-configured' ? (
        <Caveat tone="wrong" action={{ label: 'Set reorder levels in Inventory', onPress: () => router.push('/inventory') }}>
          This report is empty because no product has a reorder level, not because the shelves are healthy.
          Until a level is set somewhere there is nothing to measure stock against, and an empty reorder list
          means only that the question has not been asked.
        </Caveat>
      ) : null}

      {/* The partial case, and the one most likely to mislead: SOME levels are
          set, so the report looks authoritative while saying nothing at all
          about the products left out of it. */}
      {stock !== null && reading.emptyReason !== 'none-configured' && unconfigured > 0 ? (
        <Caveat tone="partial" action={{ label: 'Set reorder levels in Inventory', onPress: () => router.push('/inventory') }}>
          {`${unconfigured} of ${stock.length} stock rows have no reorder level set, so they cannot appear here however empty the shelf is. This list covers the ${reading.configured} that do.`}
        </Caveat>
      ) : null}

      {reading.rows.length > 0 ? (
        <Caveat tone="context">
          Worst shortfall first, so a buyer who stops halfway down has covered the worst of it. &ldquo;Order at
          least&rdquo; is what it takes to reach the reorder level, not a suggested order quantity — it carries
          no lead time, no pack size and no view of how fast the item sells. A level set for one branch is
          judged against that branch&apos;s shelf, never the shop-wide total.
        </Caveat>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 14 },
  tableBody: { paddingHorizontal: 10 },
});
