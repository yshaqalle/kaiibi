import { useCallback, useEffect, useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { useTabRefresh, type RefreshSetter } from '@/components/accounting/use-header-actions';
import { StatTile } from '@/components/stat-tile';
import { BentoCard } from '@/components/ui/bento-card';
import { Caveat } from '@/components/ui/caveat';
import { DataTable, NameCell, ValueCell, type Column } from '@/components/ui/data-table';
import { useAuth } from '@/hooks/use-auth';
import { useRefreshOnFocus } from '@/hooks/use-refresh-on-focus';
import { formatCents, formatCompactCents } from '@/lib/currency';
import { rollUpStock, stockValueCents, type StockGroupRow } from '@/lib/report-math';
import { loadInventoryReport, type StockOnHandRow } from '@/lib/reports';

// Stock on hand, and what it is worth at cost.
//
// NO `dateRange` PROP, deliberately. Stock on hand is a position read at an
// instant -- there is no such thing as the stock a shop held over the last
// seven days -- so this screen ignores the shell's picker, and its hub card
// says "As of today" rather than promising a window it does not keep.
//
// It still takes the store filter, because "what is on the shelves at the
// kiosk" is a real and different question from "what is on the shelves".

const COLUMNS: Column<StockGroupRow>[] = [
  {
    key: 'store',
    header: 'Store',
    render: (row) => <NameCell title={row.label} meta={`${row.rows} ${row.rows === 1 ? 'product' : 'products'} carried`} />,
  },
  { key: 'units', header: 'Units on hand', numeric: true, render: (row) => <ValueCell value={String(row.units)} /> },
  {
    key: 'value',
    header: 'Value at cost',
    numeric: true,
    render: (row) => <ValueCell value={formatCents(row.valueCents)} strong />,
  },
  {
    key: 'unvalued',
    header: 'Uncosted',
    numeric: true,
    // An em dash where there are none, so the stores that DO have a gap are
    // the ones the eye stops on.
    render: (row) =>
      row.unvalued === 0 ? <ValueCell value="—" tone="muted" /> : <ValueCell value={String(row.unvalued)} tone="warning" />,
  },
];

export function InventoryBalanceView({
  locationFilter,
  setRefresh,
}: {
  locationFilter: string | null;
  setRefresh: RefreshSetter;
}) {
  const { shop } = useAuth();
  const [rows, setRows] = useState<StockOnHandRow[] | null>(null);

  const reload = useCallback(async () => {
    if (!shop) return;
    setRows(await loadInventoryReport(shop.id, locationFilter));
  }, [shop, locationFilter]);

  // See the note in chart-of-accounts-view.tsx: use-refresh-on-focus does not
  // fetch on the mounting focus, and depends on this effect having done it.
  useEffect(() => { reload(); }, [reload]);
  useRefreshOnFocus(reload);
  useTabRefresh(setRefresh, reload);

  const stores = useMemo(
    () => rollUpStock((rows ?? []).map((row) => ({ key: row.locationId, label: row.locationName, stock: row.stock, costCents: row.costCents }))),
    [rows]
  );

  const totals = useMemo(() => {
    const list = rows ?? [];
    const { valueCents, unvalued } = stockValueCents(list);
    return {
      units: list.reduce((sum, row) => sum + row.stock, 0),
      valueCents,
      unvalued,
      // Distinct PRODUCTS, not rows. The same product held at three branches is
      // three rows and one thing the shop sells, and "products stocked: 258"
      // meaning 86 products across three stores would be a lie a reader can
      // check against the Inventory tab in ten seconds.
      products: new Set(list.map((row) => row.productId)).size,
    };
  }, [rows]);

  return (
    <View style={styles.wrap}>
      <BentoCard title="On the shelves" scope="As of today">
        <View style={styles.tiles}>
          <StatTile value={String(totals.units)} label="Units on hand" variant="bento" />
          <StatTile
            value={formatCompactCents(totals.valueCents)}
            label="Value at cost"
            hint={totals.unvalued > 0 ? 'understated — see below' : 'weighted average cost'}
            tone={totals.unvalued > 0 ? 'warning' : 'default'}
            variant="bento"
          />
          <StatTile value={String(totals.products)} label="Products stocked" variant="bento" />
          <StatTile
            value={String(totals.unvalued)}
            label="Uncosted rows"
            hint="held, but worth an unknown amount"
            tone={totals.unvalued > 0 ? 'warning' : 'default'}
            variant="bento"
          />
        </View>
      </BentoCard>

      <BentoCard title="By store" bodyStyle={styles.tableBody}>
        <DataTable
          columns={COLUMNS}
          rows={stores}
          keyExtractor={(row) => row.key}
          emptyLabel={rows ? 'No stock is recorded against any store.' : 'Loading…'}
        />
      </BentoCard>

      {/* 'context': the valuation is not wrong and there is nothing to go and
          fix. What needs saying is WHICH basis it is, because a reader who
          assumes FIFO will reconcile this against a figure it was never going
          to match. This is also the answer the hub's dimmed Inventory
          Valuation card points at. */}
      <Caveat tone="context">
        Stock is valued at each product&apos;s current cost, which deliveries maintain as a moving weighted
        average — not in FIFO layers. That basis is a choice IAS 2 permits, and it is the only one this app
        keeps, so there is no second valuation to reconcile against. The figure is what the shelves cost to
        replace at today&apos;s average, not what any particular delivery was invoiced at.
      </Caveat>

      {totals.unvalued > 0 ? (
        <Caveat tone="partial">
          {`${totals.unvalued} of these rows hold stock with no cost recorded against the product, so the value above is lower than the truth by an unknown amount. Their units are still counted — they are on the shelf whatever they cost.`}
        </Caveat>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 14 },
  tiles: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  tableBody: { paddingHorizontal: 10 },
});
