import { useCallback, useEffect, useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { ReportExport } from '@/components/accounting/reports/report-export';
import { useTabRefresh, type HeaderActionsSetter, type RefreshSetter } from '@/components/accounting/use-header-actions';
import { type DateRange } from '@/components/range-selector';
import { BentoCard } from '@/components/ui/bento-card';
import { Caveat } from '@/components/ui/caveat';
import { DataTable, NameCell, ValueCell, type Column } from '@/components/ui/data-table';
import { useAuth } from '@/hooks/use-auth';
import { useRefreshOnFocus } from '@/hooks/use-refresh-on-focus';
import { formatCents } from '@/lib/currency';
import { rollUpSales, sharesOfOwnTotal, UNATTRIBUTED, type SaleGroupRow } from '@/lib/report-math';
import { loadSalesReport, salesByEmployee } from '@/lib/reports';

// Revenue and baskets per cashier.
//
// No KPI strip: a shop-wide total on this screen would be the Sales report's
// total with a different heading, and the only figures this screen adds are
// per-row. The caveat does the work a strip would have.

export function EmployeeSalesView({
  dateRange,
  locationFilter,
  setRefresh,
  setHeaderActions,
  rangeLabel,
}: {
  dateRange: DateRange;
  locationFilter: string | null;
  setRefresh: RefreshSetter;
  setHeaderActions: HeaderActionsSetter;
  /** The shell's range, for the export subtitle. */
  rangeLabel: string | null;
}) {
  const { shop } = useAuth();
  const [rows, setRows] = useState<SaleGroupRow[] | null>(null);

  const { since, until } = dateRange;
  const reload = useCallback(async () => {
    if (!shop) return;
    const { sales } = await loadSalesReport(shop.id, since, until, locationFilter);
    setRows(rollUpSales(salesByEmployee(sales)));
  }, [shop, since, until, locationFilter]);

  // See the note in chart-of-accounts-view.tsx: use-refresh-on-focus does not
  // fetch on the mounting focus, and depends on this effect having done it.
  useEffect(() => { reload(); }, [reload]);
  useRefreshOnFocus(reload);
  useTabRefresh(setRefresh, reload);

  // Shares of the rows shown, via the shared helper rather than a local total:
  // the store panel on the Sales report computed its own denominator and got a
  // different one, which rendered a single store at 124.7%.
  const shares = useMemo(() => {
    const list = rows ?? [];
    const pcts = sharesOfOwnTotal(list, (row) => row.revenueCents);
    return new Map(list.map((row, i) => [row.key, pcts[i]]));
  }, [rows]);
  // Whether any takings landed in the "Not recorded" row, which is the fact
  // that makes the rest of the column readable or not.
  const unattributedCents = useMemo(
    () => (rows ?? []).find((row) => row.key === UNATTRIBUTED)?.revenueCents ?? 0,
    [rows]
  );

  const columns = useMemo<Column<SaleGroupRow>[]>(
    () => [
      {
        key: 'cashier',
        header: 'Cashier',
        render: (row) => (
          <NameCell
            title={row.label}
            // The unattributed row says what it is on the row itself. A reader
            // who scrolls past the caveat still needs to know that "Not
            // recorded" is a gap in the data, not a person.
            meta={row.key === UNATTRIBUTED ? 'no cashier on the sale' : undefined}
          />
        ),
        text: (row) => row.label,
      },
      { key: 'sales', header: 'Baskets', numeric: true, render: (row) => <ValueCell value={String(row.sales)} />, text: (row) => String(row.sales) },
      { key: 'units', header: 'Units', numeric: true, render: (row) => <ValueCell value={String(row.units)} />, text: (row) => String(row.units) },
      {
        key: 'average',
        header: 'Average basket',
        numeric: true,
        render: (row) => <ValueCell value={formatCents(row.averageSaleCents)} tone="muted" />,
        text: (row) => formatCents(row.averageSaleCents),
      },
      {
        key: 'revenue',
        header: 'Revenue',
        numeric: true,
        render: (row) => <ValueCell value={formatCents(row.revenueCents)} strong />,
        text: (row) => formatCents(row.revenueCents),
      },
      {
        key: 'share',
        header: 'Share',
        numeric: true,
        render: (row) => {
          const share = shares.get(row.key) ?? null;
          return <ValueCell value={share === null ? '—' : `${share.toFixed(1)}%`} tone="muted" />;
        },
        text: (row) => {
          const share = shares.get(row.key) ?? null;
          return share === null ? '—' : `${share.toFixed(1)}%`;
        },
      },
    ],
    [shares]
  );

  return (
    <View style={styles.wrap}>
      <ReportExport
        setHeaderActions={setHeaderActions}
        rows={rows ?? []}
        columns={columns}
        title="Sales by Employee"
        rangeLabel={rangeLabel}
        locationFilter={locationFilter}
        filenamePrefix="sales-by-employee"
      />
      <BentoCard title="Per cashier" scope="The chosen range" bodyStyle={styles.tableBody}>
        <DataTable
          columns={columns}
          rows={rows ?? []}
          keyExtractor={(row) => row.key}
          emptyLabel={rows ? 'No sales in this period.' : 'Loading…'}
        />
      </BentoCard>

      {/* 'context', not 'wrong': nothing on this screen is incorrect and there
          is nothing for the reader to go and fix. What it needs saying is what
          the numbers do NOT mean. */}
      <Caveat tone="context">
        This is not a leaderboard. Who is on the till at the busy hour, which branch they work, and whether
        they are the one serving the queue or restocking the shelf all move these figures far more than how
        well anybody sells — and refunds are not charged against a cashier at all, because whoever handles the
        return is rarely whoever made the sale. Revenue excludes sales tax.
      </Caveat>

      {unattributedCents > 0 ? (
        <Caveat tone="partial">
          {`${formatCents(unattributedCents)} of these takings are on sales with no cashier recorded — a sale rung up before cashier profiles were set up, or on a till where nobody signed in. It is shown as its own row rather than dropped, so the column still adds up to what the shop took.`}
        </Caveat>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 14 },
  tableBody: { paddingHorizontal: 10 },
});
