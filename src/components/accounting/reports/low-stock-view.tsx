import { useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { ReportExport } from '@/components/accounting/reports/report-export';
import { useTabRefresh, type HeaderActionsSetter, type RefreshSetter } from '@/components/accounting/use-header-actions';
import { BentoCard } from '@/components/ui/bento-card';
import { Caveat } from '@/components/ui/caveat';
import { DataTable, NameCell, ValueCell, type Column } from '@/components/ui/data-table';
import { useAuth } from '@/hooks/use-auth';
import { useRefreshOnFocus } from '@/hooks/use-refresh-on-focus';
import { lowStockReading, type LowStockRow, type StockUrgency } from '@/lib/report-math';
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
    // Title and meta joined, because the file has one column where the cell
    // has two lines -- and which shelf is empty is the point of this report.
    text: (row) => (row.locationName ? `${row.productName} · ${row.locationName}` : row.productName),
  },
  {
    key: 'urgency',
    header: 'State',
    width: 110,
    render: (row) => <ValueCell value={URGENCY[row.urgency].label} tone={URGENCY[row.urgency].tone} />,
    // The word, not the tone: colour does not survive a CSV, and the label is
    // what carried the meaning on screen anyway.
    text: (row) => URGENCY[row.urgency].label,
  },
  { key: 'stock', header: 'On hand', numeric: true, render: (row) => <ValueCell value={String(row.stock)} />, text: (row) => String(row.stock) },
  {
    key: 'level',
    header: 'Reorder at',
    numeric: true,
    // Non-null on every row here: a row with no level set has a null shortfall
    // and never reaches this table.
    render: (row) => <ValueCell value={String(row.reorderLevel)} tone="muted" />,
    text: (row) => String(row.reorderLevel),
  },
  {
    key: 'shortfall',
    header: 'Order at least',
    numeric: true,
    render: (row) => <ValueCell value={String(row.shortfall)} strong />,
    text: (row) => String(row.shortfall),
  },
];

export function LowStockView({
  locationFilter,
  setRefresh,
  setHeaderActions,
}: {
  locationFilter: string | null;
  setRefresh: RefreshSetter;
  setHeaderActions: HeaderActionsSetter;
}) {
  const { shop } = useAuth();
  const router = useRouter();
  const [stock, setStock] = useState<StockOnHandRow[] | null>(null);

  // `defaultLowStockLevel` is what makes this screen agree with Inventory and
  // the Dashboard. It is not a fallback invented here: it is the shop setting
  // migration 0030 added to replace a hardcoded 5, and a product with no level
  // of its own has always been judged against it everywhere else in the app.
  const defaultLowStockLevel = shop?.defaultLowStockLevel ?? 5;

  const reload = useCallback(async () => {
    if (!shop) return;
    setStock(await loadInventoryReport(shop.id, locationFilter, defaultLowStockLevel));
  }, [shop, locationFilter, defaultLowStockLevel]);

  // See the note in chart-of-accounts-view.tsx: use-refresh-on-focus does not
  // fetch on the mounting focus, and depends on this effect having done it.
  useEffect(() => { reload(); }, [reload]);
  useRefreshOnFocus(reload);
  useTabRefresh(setRefresh, reload);

  const reading = useMemo(() => lowStockReading(stock ?? []), [stock]);
  // How many rows are judged against the shop default rather than a level of
  // their own. Not a warning -- that is the setting working as designed -- but
  // it is the number that explains where the list came from.
  const onShopDefault = useMemo(
    () => (stock ?? []).filter((row) => row.reorderLevel === defaultLowStockLevel).length,
    [stock, defaultLowStockLevel]
  );

  return (
    <View style={styles.wrap}>
      <ReportExport
        setHeaderActions={setHeaderActions}
        rows={reading.rows}
        columns={COLUMNS}
        title="Low Stock & Reorder"
        // Null on purpose: this screen reports a POSITION and ignores the
        // shell's range, so the file is stamped with the instant it was read
        // rather than a window it never honoured.
        rangeLabel={null}
        locationFilter={locationFilter}
        filenamePrefix="low-stock"
      />
      <BentoCard
        title="To reorder"
        scope="As of today"
        bodyStyle={styles.tableBody}
      >
        <DataTable
          columns={COLUMNS}
          rows={reading.rows}
          keyExtractor={(row) => `${row.productId}:${row.locationId}`}
          // One meaning, and it is the true one. This used to have a second
          // message for "no reorder levels have been set", which could not be
          // true of any shop -- `default_low_stock_level` always sets one.
          emptyLabel={stock === null ? 'Loading…' : 'Nothing is at or below its reorder level.'}
        />
      </BentoCard>

      {/* One string, not a fragment: Caveat takes its text as a single
          `children` string, so interleaving an explicit newline expression
          would make it an array and fail to typecheck. */}
      {reading.rows.length > 0 ? (
        <Caveat tone="context">
          {'Worst shortfall first, so a buyer who stops halfway down has covered the worst of it. “Order at least” is what it takes to reach the reorder level, not a suggested order quantity — it carries no lead time, no pack size and no view of how fast the item sells.\n\nOne row is one product at one branch, which is why this list can be longer than Inventory’s “low stock” count: that counts a product once against its total across every store, so a branch sitting at zero is hidden whenever another branch is holding plenty. Both use the same reorder level; they differ on whether the shelf or the shop is being judged, and an empty shelf is still an empty shelf.'}
        </Caveat>
      ) : null}

      {/* 'context', not 'wrong': being judged against the shop's own setting is
          the system working, not a fault to fix. It says which number is doing
          the work, because "low" means nothing to a reader who does not know
          the threshold, and points at where to change it. */}
      {stock !== null && onShopDefault > 0 ? (
        <Caveat
          tone="context"
          action={{ label: 'Change it in Settings → Inventory alerts', onPress: () => router.push('/settings') }}
        >
          {`${onShopDefault} of ${stock.length} stock rows have no reorder level of their own, so they are judged against this shop's default of ${defaultLowStockLevel} — the same number the Inventory tab and the Dashboard use. Set a level on a product, or on a product at one branch, to override it there.`}
        </Caveat>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 14 },
  tableBody: { paddingHorizontal: 10 },
});
