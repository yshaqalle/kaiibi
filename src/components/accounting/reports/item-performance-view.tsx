import { useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { useTabRefresh, type RefreshSetter } from '@/components/accounting/use-header-actions';
import { type DateRange } from '@/components/range-selector';
import { StatTile } from '@/components/stat-tile';
import { BentoCard } from '@/components/ui/bento-card';
import { Caveat } from '@/components/ui/caveat';
import { DataTable, NameCell, ValueCell, type Column } from '@/components/ui/data-table';
import { useAuth } from '@/hooks/use-auth';
import { useRefreshOnFocus } from '@/hooks/use-refresh-on-focus';
import { formatCents, formatCompactCents } from '@/lib/currency';
import { marginPercent, rollUpLines, type RollUpRow } from '@/lib/report-math';
import { linesByProduct, loadSalesReport } from '@/lib/reports';

// Top and bottom sellers by units and margin.
//
// The table is ranked by revenue, which puts the top sellers at the head and
// the bottom ones at the foot of the SAME list rather than splitting them into
// two panels. A product is only "bottom" relative to the rest, and two tables
// force the reader to hold both orderings in their head to see that.

const COLUMNS: Column<RollUpRow>[] = [
  {
    key: 'product',
    header: 'Product',
    render: (row) => <NameCell title={row.label} meta={`${row.lines} ${row.lines === 1 ? 'line' : 'lines'}`} />,
  },
  { key: 'units', header: 'Units', numeric: true, render: (row) => <ValueCell value={String(row.units)} /> },
  { key: 'revenue', header: 'Revenue', numeric: true, render: (row) => <ValueCell value={formatCents(row.revenueCents)} strong /> },
  {
    key: 'cost',
    header: 'Cost',
    numeric: true,
    // An uncosted product has no cost to show, and 0.00 would read as "free".
    // The row still carries its revenue, which is why it is here at all.
    render: (row) =>
      row.uncostedLines === row.lines ? (
        <ValueCell value="—" tone="muted" />
      ) : (
        <ValueCell value={formatCents(row.costCents)} />
      ),
  },
  {
    key: 'margin',
    header: 'Margin',
    numeric: true,
    render: (row) => {
      // Null margin -- nothing sold -- is an em dash, never 0%, because 0%
      // reads as "sold at cost". A partly-costed product's margin is
      // OVERSTATED and the caveat below says so; it is still shown, because
      // hiding it would leave the reader with no figure at all.
      if (row.marginPercent === null) return <ValueCell value="—" tone="muted" />;
      const partial = row.uncostedLines > 0;
      return (
        <ValueCell
          value={`${row.marginPercent.toFixed(1)}%${partial ? '*' : ''}`}
          tone={partial ? 'warning' : row.marginPercent < 0 ? 'danger' : 'default'}
        />
      );
    },
  },
];

export function ItemPerformanceView({
  dateRange,
  locationFilter,
  setRefresh,
}: {
  dateRange: DateRange;
  locationFilter: string | null;
  setRefresh: RefreshSetter;
}) {
  const { shop } = useAuth();
  const router = useRouter();
  const [rows, setRows] = useState<RollUpRow[] | null>(null);

  const { since, until } = dateRange;
  const reload = useCallback(async () => {
    if (!shop) return;
    const { sales } = await loadSalesReport(shop.id, since, until, locationFilter);
    setRows(rollUpLines(linesByProduct(sales)));
  }, [shop, since, until, locationFilter]);

  // See the note in chart-of-accounts-view.tsx: use-refresh-on-focus does not
  // fetch on the mounting focus, and depends on this effect having done it.
  useEffect(() => { reload(); }, [reload]);
  useRefreshOnFocus(reload);
  useTabRefresh(setRefresh, reload);

  const totals = useMemo(() => {
    const list = rows ?? [];
    const revenueCents = list.reduce((sum, row) => sum + row.revenueCents, 0);
    const costCents = list.reduce((sum, row) => sum + row.costCents, 0);
    return {
      products: list.length,
      units: list.reduce((sum, row) => sum + row.units, 0),
      revenueCents,
      marginPercent: marginPercent(revenueCents, costCents),
      // Products with at least one uncosted line, not uncosted LINES: the
      // caveat sends the reader to Inventory to fix products, so the figure it
      // quotes has to be a count of the things they will be fixing.
      uncostedProducts: list.filter((row) => row.uncostedLines > 0).length,
    };
  }, [rows]);

  return (
    <View style={styles.wrap}>
      <BentoCard title="The period" scope="The chosen range">
        <View style={styles.tiles}>
          <StatTile value={String(totals.products)} label="Products sold" variant="bento" />
          <StatTile value={String(totals.units)} label="Units" variant="bento" />
          <StatTile value={formatCompactCents(totals.revenueCents)} label="Revenue" hint="before tax" variant="bento" />
          <StatTile
            value={totals.marginPercent === null ? '—' : `${totals.marginPercent.toFixed(1)}%`}
            label="Gross margin"
            hint={totals.uncostedProducts > 0 ? 'overstated — see below' : 'revenue less cost of goods'}
            tone={totals.uncostedProducts > 0 ? 'warning' : 'default'}
            variant="bento"
          />
        </View>
      </BentoCard>

      <BentoCard title="Every product sold" bodyStyle={styles.tableBody}>
        <DataTable
          columns={COLUMNS}
          rows={rows ?? []}
          keyExtractor={(row) => row.key}
          emptyLabel={rows ? 'Nothing was sold in this period.' : 'Loading…'}
        />
      </BentoCard>

      {/* 'wrong', not 'context': the margin on screen IS overstated, the cause
          is removable, and the action removes it. The `nocost` filter is the
          same one the Overview tab's caveat uses, so both land the reader on
          exactly the products that need a cost. */}
      {totals.uncostedProducts > 0 ? (
        <Caveat
          tone="wrong"
          action={{ label: 'Set costs in Inventory', onPress: () => router.push({ pathname: '/inventory', params: { filter: 'nocost' } }) }}
        >
          {`${totals.uncostedProducts} of these ${totals.uncostedProducts === 1 ? 'product was' : 'products were'} sold with no cost recorded, so ${totals.uncostedProducts === 1 ? 'its' : 'their'} cost of goods counts as nothing and every margin above — including the total — is higher than the truth. Margins computed from at least one uncosted sale are marked *.`}
        </Caveat>
      ) : (
        <Caveat tone="context">
          Cost is what each unit cost at the moment it sold, frozen on the sale line — not what the product costs
          today. A delivery that arrived at a new price changes future margins, never past ones.
        </Caveat>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 14 },
  tiles: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  tableBody: { paddingHorizontal: 10 },
});
