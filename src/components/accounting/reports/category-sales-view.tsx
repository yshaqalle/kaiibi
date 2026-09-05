import { useCallback, useEffect, useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { ReportExport } from '@/components/accounting/reports/report-export';
import { useTabRefresh, type HeaderActionsSetter, type RefreshSetter } from '@/components/accounting/use-header-actions';
import { type DateRange } from '@/components/range-selector';
import { BentoCard } from '@/components/ui/bento-card';
import { Caveat } from '@/components/ui/caveat';
import { DataTable, NameCell, ValueCell, type Column } from '@/components/ui/data-table';
import { Colors } from '@/constants/theme';
import { useAuth } from '@/hooks/use-auth';
import { useRefreshOnFocus } from '@/hooks/use-refresh-on-focus';
import { formatCents } from '@/lib/currency';
import { rollUpLines, shareOfTotal, UNCATEGORISED, type RollUpRow } from '@/lib/report-math';
import { loadCategoryReport } from '@/lib/reports';

const theme = Colors.light;

// Revenue and margin by product category.
//
// UNCATEGORISED IS A ROW, NOT A FILTER. 175 of this shop's products have no
// category; hiding them would make every percentage in the Share column add to
// less than the shop took, and a reader checking the total against the day's
// takings would find the report short with nothing on screen to explain it.
// `categoryLabel` in report-math.ts puts them in the bucket, this screen
// renders the bucket as an ordinary row, and the caveat says what it is.

/** The share bar. A width, not a colour scale -- the figure is beside it. */
function ShareBar({ percent }: { percent: number | null }) {
  return (
    <View style={styles.shareCell}>
      <View style={styles.shareTrack}>
        {/* Clamped: a negative share is possible if a category's lines net out
            below zero after a refunded line, and a negative width crashes the
            layout on native rather than drawing nothing. */}
        <View style={[styles.shareFill, { width: `${Math.max(0, Math.min(100, percent ?? 0))}%` }]} />
      </View>
      <ValueCell value={percent === null ? '—' : `${percent.toFixed(1)}%`} tone="muted" />
    </View>
  );
}

export function CategorySalesView({
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
  const [rows, setRows] = useState<RollUpRow[] | null>(null);

  const { since, until } = dateRange;
  const reload = useCallback(async () => {
    if (!shop) return;
    setRows(rollUpLines(await loadCategoryReport(shop.id, since, until, locationFilter)));
  }, [shop, since, until, locationFilter]);

  // See the note in chart-of-accounts-view.tsx: use-refresh-on-focus does not
  // fetch on the mounting focus, and depends on this effect having done it.
  useEffect(() => { reload(); }, [reload]);
  useRefreshOnFocus(reload);
  useTabRefresh(setRefresh, reload);

  const totalCents = useMemo(() => (rows ?? []).reduce((sum, row) => sum + row.revenueCents, 0), [rows]);
  const uncategorisedCents = useMemo(
    () => (rows ?? []).find((row) => row.key === UNCATEGORISED)?.revenueCents ?? 0,
    [rows]
  );

  const columns = useMemo<Column<RollUpRow>[]>(
    () => [
      {
        key: 'category',
        header: 'Category',
        render: (row) => (
          <NameCell
            title={row.label}
            meta={row.key === UNCATEGORISED ? 'products with no category set' : `${row.units} units`}
          />
        ),
        text: (row) => row.label,
      },
      {
        key: 'revenue',
        header: 'Revenue',
        numeric: true,
        render: (row) => <ValueCell value={formatCents(row.revenueCents)} strong />,
        text: (row) => formatCents(row.revenueCents),
      },
      {
        key: 'margin',
        header: 'Margin',
        numeric: true,
        render: (row) => {
          if (row.marginPercent === null) return <ValueCell value="—" tone="muted" />;
          const partial = row.uncostedLines > 0;
          return (
            <ValueCell
              value={`${row.marginPercent.toFixed(1)}%${partial ? '*' : ''}`}
              tone={partial ? 'warning' : row.marginPercent < 0 ? 'danger' : 'default'}
            />
          );
        },
        text: (row) =>
          row.marginPercent === null ? '—' : `${row.marginPercent.toFixed(1)}%${row.uncostedLines > 0 ? '*' : ''}`,
      },
      {
        key: 'share',
        header: 'Share of revenue',
        width: 190,
        render: (row) => <ShareBar percent={shareOfTotal(row.revenueCents, totalCents)} />,
        // A bar is a picture of a number, so the file gets the number. Null
        // where there is no total to take a share of -- an em dash, never 0%,
        // which would read as "sold nothing" rather than "nothing to compare".
        text: (row) => {
          const share = shareOfTotal(row.revenueCents, totalCents);
          return share === null ? '—' : `${share.toFixed(1)}%`;
        },
      },
    ],
    [totalCents]
  );

  const uncosted = (rows ?? []).filter((row) => row.uncostedLines > 0).length;

  return (
    <View style={styles.wrap}>
      <ReportExport
        setHeaderActions={setHeaderActions}
        rows={rows ?? []}
        columns={columns}
        title="Sales by Category"
        rangeLabel={rangeLabel}
        locationFilter={locationFilter}
        filenamePrefix="sales-by-category"
      />
      <BentoCard title="By category" scope="The chosen range" bodyStyle={styles.tableBody}>
        <DataTable
          columns={columns}
          rows={rows ?? []}
          keyExtractor={(row) => row.key}
          emptyLabel={rows ? 'Nothing was sold in this period.' : 'Loading…'}
          minWidth={640}
        />
      </BentoCard>

      <Caveat tone="context">
        {uncategorisedCents > 0
          ? `${formatCents(uncategorisedCents)} of this revenue is on products with no category set, shown as its own row rather than left out — so the shares add up to the whole of what the shop took. A category is read as it is set today, so recategorising a product also restates its past sales.`
          : 'A category is read as it is set today, not frozen on the sale, so recategorising a product also restates its past sales. That is the right way round for asking how a section of the shelf is doing now.'}
      </Caveat>

      {uncosted > 0 ? (
        <Caveat tone="partial">
          {`${uncosted} ${uncosted === 1 ? 'category contains' : 'categories contain'} at least one product sold with no cost recorded, so ${uncosted === 1 ? 'its margin is' : 'those margins are'} higher than the truth. They are marked *. Revenue is unaffected — an uncosted sale still sold something.`}
        </Caveat>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 14 },
  tableBody: { paddingHorizontal: 10 },
  shareCell: { flexDirection: 'row', alignItems: 'center', gap: 8, minWidth: 0 },
  shareTrack: { flex: 1, height: 6, borderRadius: 999, backgroundColor: theme.bentoSoft, overflow: 'hidden' },
  shareFill: { height: '100%', borderRadius: 999, backgroundColor: theme.bentoSeries1 },
});
