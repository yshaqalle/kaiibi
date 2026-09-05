import { useCallback, useEffect, useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { ReportExport } from '@/components/accounting/reports/report-export';
import { useTabRefresh, type HeaderActionsSetter, type RefreshSetter } from '@/components/accounting/use-header-actions';
import { type DateRange } from '@/components/range-selector';
import { StatTile } from '@/components/stat-tile';
import { BentoCell, BentoGrid } from '@/components/ui/bento';
import { BentoCard } from '@/components/ui/bento-card';
import { Caveat } from '@/components/ui/caveat';
import { csvColumnsOf, DataTable, NameCell, ValueCell, type Column } from '@/components/ui/data-table';
import { useAuth } from '@/hooks/use-auth';
import { useRefreshOnFocus } from '@/hooks/use-refresh-on-focus';
import { formatCents, formatCompactCents } from '@/lib/currency';
import { methodLabel } from '@/lib/payment-methods';
import { averageCents, rollUpSales, sharesOfOwnTotal, type SaleGroupRow } from '@/lib/report-math';
import { loadSalesReport, salesByStore } from '@/lib/reports';
import {
  bucketDailyTotals,
  grossSalesCents,
  netRevenueCents,
  netTaxCollectedCents,
  paymentMethodMix,
  type DailyBucket,
  type PaymentMixEntry,
} from '@/lib/sales-reporting';

// Revenue by day, payment method and store.
//
// Every figure here comes out of sales-reporting.ts or report-math.ts. This file
// picks which ones to show and formats them, and does no arithmetic of its own
// -- see the note at the top of report-math.ts for why that line is drawn hard.
//
// One read for the whole screen (`loadSalesReport`), because the underlying
// query is the heaviest in the app and three panels asking separately would
// fetch the same rows three times.

const DAY_COLUMNS: Column<DailyBucket>[] = [
  {
    key: 'day',
    header: 'Day',
    // `bucket.day` is already a LOCAL day string (Date.toDateString via
    // dayKeyFor). Not re-parsed and not reformatted through toISOString: a
    // date-only string round-tripped through UTC renders as the day before
    // west of Greenwich, which is a bug this project has already shipped once.
    render: (row) => <NameCell title={row.day} />,
    text: (row) => row.day,
  },
  { key: 'orders', header: 'Orders', numeric: true, render: (row) => <ValueCell value={String(row.orderCount)} />, text: (row) => String(row.orderCount) },
  {
    key: 'gross',
    header: 'Takings',
    numeric: true,
    render: (row) => <ValueCell value={formatCents(row.grossCents)} tone={row.grossCents === 0 ? 'muted' : 'default'} />,
    text: (row) => formatCents(row.grossCents),
  },
  {
    key: 'refunds',
    header: 'Refunds',
    numeric: true,
    // An em dash on a day with none. A column of "$0.00" down every row is ink
    // spent hiding the two days that actually had a refund.
    render: (row) =>
      row.refundCents === 0 ? (
        <ValueCell value="—" tone="muted" />
      ) : (
        <ValueCell value={`−${formatCents(row.refundCents)}`} tone="danger" />
      ),
    // A real minus-hyphen, not the U+2212 the cell draws: the typographic one
    // is not a sign to any spreadsheet, so an exported refund would come back
    // as text or as a positive.
    text: (row) => (row.refundCents === 0 ? '—' : `-${formatCents(row.refundCents)}`),
  },
  {
    key: 'tax',
    header: 'Sales tax',
    numeric: true,
    render: (row) => <ValueCell value={row.taxCents === 0 ? '—' : formatCents(row.taxCents)} tone={row.taxCents === 0 ? 'muted' : 'default'} />,
    text: (row) => (row.taxCents === 0 ? '—' : formatCents(row.taxCents)),
  },
  {
    key: 'net',
    header: 'Revenue',
    numeric: true,
    render: (row) => <ValueCell value={formatCents(row.netRevenueCents)} strong />,
    text: (row) => formatCents(row.netRevenueCents),
  },
];

const PAYMENT_COLUMNS: Column<PaymentMixEntry>[] = [
  { key: 'method', header: 'Method', render: (row) => <NameCell title={methodLabel(row.method)} />, text: (row) => methodLabel(row.method) },
  { key: 'amount', header: 'Taken', numeric: true, render: (row) => <ValueCell value={formatCents(row.amountCents)} />, text: (row) => formatCents(row.amountCents) },
  {
    key: 'share',
    header: 'Share',
    numeric: true,
    render: (row) => <ValueCell value={`${row.pct.toFixed(1)}%`} tone="muted" />,
    text: (row) => `${row.pct.toFixed(1)}%`,
  },
];

export function SalesReportView({
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
  const [data, setData] = useState<{ days: DailyBucket[]; payments: PaymentMixEntry[]; stores: SaleGroupRow[]; grossCents: number; netCents: number; taxCents: number; orders: number } | null>(
    null
  );

  const { since, until } = dateRange;
  const reload = useCallback(async () => {
    if (!shop) return;
    const { sales, refunds, locations } = await loadSalesReport(shop.id, since, until, locationFilter);
    setData({
      days: bucketDailyTotals(sales, refunds, since, until),
      payments: paymentMethodMix(sales),
      stores: rollUpSales(salesByStore(sales, locations)),
      grossCents: grossSalesCents(sales),
      netCents: netRevenueCents(sales, refunds),
      taxCents: netTaxCollectedCents(sales, refunds),
      orders: sales.length,
    });
  }, [shop, since, until, locationFilter]);

  // See the note in chart-of-accounts-view.tsx: use-refresh-on-focus does not
  // fetch on the mounting focus, and depends on this effect having done it.
  useEffect(() => { reload(); }, [reload]);
  useRefreshOnFocus(reload);
  useTabRefresh(setRefresh, reload);

  const basketCents = useMemo(() => (data ? averageCents(data.netCents, data.orders) : null), [data]);

  // The denominator for the store shares, and it is deliberately the SUM OF THE
  // STORE ROWS rather than the `Revenue` tile above.
  //
  // This shipped wrong and a real shop caught it: the tile is
  // `netRevenueCents`, which subtracts refunds, while a store row is takings
  // less tax and does NOT -- a refund carries the sale it reverses but not that
  // sale's location, so it cannot be attributed to a branch without another
  // join. Dividing the un-netted numerator by the netted denominator put a
  // single-store shop at 124.7%, which is the kind of figure that costs a
  // reader their trust in the whole screen. Fixtures could not catch it because
  // fixtures had no refunds.
  //
  // The employee screen already divides by its own row total for exactly this
  // reason; this now matches it, and the card says which revenue it means.
  const storeShares = useMemo(() => {
    const rows = data?.stores ?? [];
    const shares = sharesOfOwnTotal(rows, (row) => row.revenueCents);
    return new Map(rows.map((row, i) => [row.key, shares[i]]));
  }, [data]);

  const storeColumns = useMemo<Column<SaleGroupRow>[]>(
    () => [
      { key: 'store', header: 'Store', render: (row) => <NameCell title={row.label} meta={`${row.sales} sales`} />, text: (row) => row.label },
      {
        key: 'revenue',
        header: 'Revenue',
        numeric: true,
        render: (row) => <ValueCell value={formatCents(row.revenueCents)} />,
        text: (row) => formatCents(row.revenueCents),
      },
      {
        key: 'share',
        header: 'Share',
        numeric: true,
        render: (row) => {
          // Null, not 0%, when these rows total nothing -- a share of nothing
          // is not zero percent, and sharesOfOwnTotal says so.
          const share = storeShares.get(row.key) ?? null;
          return <ValueCell value={share === null ? '—' : `${share.toFixed(1)}%`} tone="muted" />;
        },
        text: (row) => {
          const share = storeShares.get(row.key) ?? null;
          return share === null ? '—' : `${share.toFixed(1)}%`;
        },
      },
    ],
    [storeShares]
  );

  // This report shows three tables, and a CSV file is one grid -- so the file
  // takes the DAILY one, which is the grid people put in a spreadsheet, and the
  // PDF carries all three as sections. The filename says which, rather than the
  // screen growing a picker for the one report that needs it.
  const pdfSections = useMemo(
    () => [
      { title: 'By day', columns: csvColumnsOf(DAY_COLUMNS), rows: data?.days ?? [] },
      { title: 'By payment method', columns: csvColumnsOf(PAYMENT_COLUMNS), rows: data?.payments ?? [] },
      { title: 'By store', columns: csvColumnsOf(storeColumns), rows: data?.stores ?? [] },
    ],
    [data, storeColumns]
  );

  return (
    <View style={styles.wrap}>
      <ReportExport
        setHeaderActions={setHeaderActions}
        rows={data?.days ?? []}
        columns={DAY_COLUMNS}
        title="Sales Report"
        rangeLabel={rangeLabel}
        locationFilter={locationFilter}
        filenamePrefix="sales-by-day"
        pdfSections={pdfSections}
      />
      <BentoCard title="The period" scope="The chosen range">
        <View style={styles.tiles}>
          <StatTile
            value={formatCompactCents(data?.netCents ?? 0)}
            label="Revenue"
            hint="net of tax & refunds"
            variant="bento"
          />
          <StatTile value={String(data?.orders ?? 0)} label="Sales" variant="bento" />
          <StatTile
            // An em dash on a range with no sales in it. "Average basket
            // $0.00" is a claim about trading that did not happen.
            value={basketCents === null ? '—' : formatCompactCents(basketCents)}
            label="Average basket"
            hint="revenue ÷ sales"
            variant="bento"
          />
          <StatTile
            value={formatCompactCents(data?.taxCents ?? 0)}
            label="Sales tax"
            hint="owed onward, not income"
            variant="bento"
          />
        </View>
      </BentoCard>

      {/* Two breakdowns side by side, each half the band. A BentoCell rather
          than a flex-wrap row: a wrapping row gives every child flexGrow, so
          the payments card would stretch across the whole band on a shop with
          one store. */}
      <BentoGrid>
        <BentoCell span={6}>
          <BentoCard title="How it was paid" bodyStyle={styles.tableBody}>
            <DataTable
              columns={PAYMENT_COLUMNS}
              rows={data?.payments ?? []}
              keyExtractor={(row) => row.method}
              emptyLabel={data ? 'Nothing was taken in this period.' : 'Loading…'}
              minWidth={280}
            />
          </BentoCard>
        </BentoCell>
        <BentoCell span={6}>
          {/* "Before refunds" is not decoration: this card's Revenue column is
              a different figure from the Revenue tile above it, and a card
              showing two numbers under one word is how a reader stops
              believing either. */}
          <BentoCard title="Which store" scope="Before refunds" bodyStyle={styles.tableBody}>
            <DataTable
              columns={storeColumns}
              rows={data?.stores ?? []}
              keyExtractor={(row) => row.key}
              emptyLabel={data ? 'No sales in this period.' : 'Loading…'}
              minWidth={280}
            />
          </BentoCard>
        </BentoCell>
      </BentoGrid>

      {/* Full width and OUTSIDE the grid: a day-by-day table is read down a
          column, and a column read downwards wants the whole band. */}
      <BentoCard title="Day by day" bodyStyle={styles.tableBody}>
        <DataTable
          columns={DAY_COLUMNS}
          rows={data?.days ?? []}
          keyExtractor={(row) => row.day}
          emptyLabel={data ? 'No days in this range.' : 'Loading…'}
        />
      </BentoCard>

      <Caveat tone="context">
        Revenue excludes sales tax, which the shop collects on the government&apos;s behalf and owes onward, and is
        net of refunds — counted on the day the money went back, not the day of the original sale, so a closed
        month never changes after the fact. Takings is the whole amount that crossed the counter. The per-store
        figures are before refunds and will not match the Revenue tile when anything was handed back: a refund
        records the sale it reverses but not the branch that made it, so it cannot honestly be charged to one.
      </Caveat>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 14 },
  tiles: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  tableBody: { paddingHorizontal: 10 },
});
