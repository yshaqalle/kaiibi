import { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useHeaderActions, type HeaderActionsSetter } from '@/components/accounting/use-header-actions';
import { ExportMenu } from '@/components/export-menu';
import type { DateRange } from '@/components/range-selector';
import { StatTile } from '@/components/stat-tile';
import { BentoCard } from '@/components/ui/bento-card';
import { Caveat } from '@/components/ui/caveat';
import { DataTable, NameCell, ValueCell, type Column } from '@/components/ui/data-table';
import { Colors } from '@/constants/theme';
import { useAuth } from '@/hooks/use-auth';
import type { CsvColumn } from '@/lib/csv';
import { formatAccountingCents, formatCompactCents } from '@/lib/currency';
import { itemPerformance, type ItemPerformanceRow, type ItemPerformanceSort } from '@/lib/item-performance';
import { getSalesAndRefundsInRange } from '@/lib/sales';
import type { Sale } from '@/types/models';

const theme = Colors.light;

// What each product actually earned.
//
// The sort is the whole point of the screen, which is why it defaults to
// profit rather than revenue. The best-selling line is regularly not the
// best-earning one — a $40 bottle bought for $37 makes less than four $3
// packets bought for $1 — and a shop that reorders off a revenue ranking keeps
// buying its worst stock. Revenue is still one tap away, because "what moves"
// is a real question too, just a different one.

const SORTS: { key: ItemPerformanceSort; label: string }[] = [
  { key: 'profit', label: 'Most profit' },
  { key: 'revenue', label: 'Most revenue' },
  { key: 'units', label: 'Most units' },
  { key: 'margin', label: 'Best margin' },
];

const EXPORT_COLUMNS: CsvColumn<ItemPerformanceRow>[] = [
  { header: 'Product', value: (r) => r.name },
  { header: 'Units sold', value: (r) => String(r.unitsSold) },
  { header: 'Revenue', value: (r) => (r.revenueCents / 100).toFixed(2) },
  { header: 'Cost', value: (r) => (r.costCents / 100).toFixed(2) },
  { header: 'Gross profit', value: (r) => (r.grossProfitCents / 100).toFixed(2) },
  { header: 'Margin %', value: (r) => (r.marginPct === null ? '' : String(r.marginPct)) },
  { header: 'Average price', value: (r) => (r.averagePriceCents / 100).toFixed(2) },
  { header: 'Uncosted units', value: (r) => String(r.uncostedUnits) },
];

function extractErrorMessage(err: unknown): string {
  if (err && typeof err === 'object' && 'message' in err && typeof (err as { message: unknown }).message === 'string') {
    return (err as { message: string }).message;
  }
  return 'Something went wrong.';
}

export function ItemPerformanceReport({
  dateRange,
  locationFilter,
  rangeLabel,
  setHeaderActions,
}: {
  dateRange: DateRange;
  locationFilter: string | null;
  rangeLabel: string;
  setHeaderActions: HeaderActionsSetter;
}) {
  const { shop } = useAuth();
  const [sales, setSales] = useState<Sale[]>([]);
  const [sort, setSort] = useState<ItemPerformanceSort>('profit');
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { since, until } = dateRange;

  const reload = useCallback(async () => {
    if (!shop) return;
    try {
      // Refunds come back with the sales but are not used directly: every sale
      // carries its own `refunds`, and that link points at the sale ITEM,
      // which is a firmer basis for a per-product figure than a period total
      // with no product identity on it. See `soldAfterRefunds`.
      const { sales: rows } = await getSalesAndRefundsInRange(shop.id, since, until, locationFilter);
      setSales(rows);
      setError(null);
    } catch (err) {
      setError(extractErrorMessage(err));
    } finally {
      setLoaded(true);
    }
  }, [shop, since, until, locationFilter]);

  useEffect(() => {
    reload();
  }, [reload]);

  const performance = useMemo(() => itemPerformance(sales, { sort }), [sales, sort]);

  const columns: Column<ItemPerformanceRow>[] = useMemo(
    () => [
      {
        key: 'product',
        header: 'Product',
        render: (row) => (
          <NameCell
            title={row.name}
            meta={[
              `${row.unitsSold} sold`,
              `${formatAccountingCents(row.averagePriceCents)} each`,
              row.uncostedUnits > 0 ? `${row.uncostedUnits} uncosted` : null,
            ]
              .filter(Boolean)
              .join(' · ')}
          />
        ),
      },
      {
        key: 'revenue',
        header: 'Revenue',
        numeric: true,
        width: 110,
        render: (row) => <ValueCell value={formatAccountingCents(row.revenueCents)} />,
      },
      {
        key: 'profit',
        header: 'Gross profit',
        numeric: true,
        width: 120,
        render: (row) => <ValueCell value={formatAccountingCents(row.grossProfitCents)} strong tone={row.grossProfitCents < 0 ? 'danger' : 'default'} />,
      },
      {
        key: 'margin',
        header: 'Margin',
        numeric: true,
        width: 90,
        render: (row) =>
          // A dash, not 0%. An item whose cost was never recorded has an
          // UNKNOWN margin, and printing zero would rank it as the worst thing
          // in the shop.
          row.marginPct === null ? (
            <ValueCell value="—" tone="muted" />
          ) : (
            <ValueCell value={`${row.marginPct}%`} tone={row.marginPct < 0 ? 'danger' : 'muted'} />
          ),
      },
    ],
    []
  );

  useHeaderActions(
    setHeaderActions,
    <ExportMenu rows={performance.rows} columns={EXPORT_COLUMNS} title="Item performance" subtitle={rangeLabel} filenamePrefix="item-performance" />,
    [performance.rows, rangeLabel]
  );

  const overallMargin =
    performance.totalRevenueCents > 0
      ? Math.round((performance.totalGrossProfitCents / performance.totalRevenueCents) * 100)
      : null;

  return (
    <>
      <BentoCard title="What the products earned" scope={rangeLabel}>
        <View style={styles.metricRow}>
          <StatTile variant="bento" value={formatCompactCents(performance.totalRevenueCents)} label="Revenue from goods" hint="net of returns" />
          <StatTile variant="bento" value={formatCompactCents(performance.totalCostCents)} label="What those goods cost" />
          <StatTile
            variant="bento"
            value={formatCompactCents(performance.totalGrossProfitCents)}
            label="Gross profit"
            hint={overallMargin === null ? undefined : `${overallMargin}% margin`}
          />
        </View>

        {performance.uncostedUnits > 0 ? (
          // `wrong`: profit really is overstated by whatever those units cost,
          // and there is a fix.
          <Caveat tone="wrong">
            {`${performance.uncostedUnits} unit${performance.uncostedUnits === 1 ? '' : 's'} sold had no cost recorded, so the gross profit above counts them as costing nothing. Set a cost on those products in Inventory — past sales keep the cost frozen at the time they were sold, so this corrects future periods rather than rewriting this one.`}
          </Caveat>
        ) : null}
      </BentoCard>

      <BentoCard title="Item performance" scope={rangeLabel} bodyStyle={styles.tableBody}>
        {error ? <Text style={styles.error}>{error}</Text> : null}

        <View style={styles.sortRow}>
          {SORTS.map((option) => {
            const active = option.key === sort;
            return (
              <Pressable key={option.key} onPress={() => setSort(option.key)} style={[styles.chip, active && styles.chipActive]}>
                <Text style={[styles.chipText, active && styles.chipTextActive]}>{option.label}</Text>
              </Pressable>
            );
          })}
        </View>

        <DataTable
          columns={columns}
          rows={performance.rows}
          keyExtractor={(row) => row.productId ?? `name:${row.name}`}
          emptyLabel={loaded ? 'Nothing sold in this range.' : 'Loading…'}
          minWidth={680}
        />
        <Text style={styles.footnote}>
          Units and revenue are net of returns, and a return is counted against the period the sale was made in — so
          last month&apos;s best seller can change if last month&apos;s goods come back. Names are as they were at the
          time of sale.
        </Text>
      </BentoCard>
    </>
  );
}

const styles = StyleSheet.create({
  tableBody: { paddingHorizontal: 10 },
  metricRow: { flexDirection: 'row', gap: 10, flexWrap: 'wrap' },
  sortRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 12, paddingHorizontal: 8 },
  chip: { borderWidth: 1, borderColor: theme.bentoLine, paddingVertical: 6, paddingHorizontal: 12, borderRadius: 999 },
  chipActive: { backgroundColor: theme.bentoSoft, borderColor: theme.bentoSoft },
  chipText: { fontSize: 11.5, fontWeight: '700', color: theme.bentoMuted },
  chipTextActive: { color: theme.bentoInk },
  footnote: { fontSize: 11, color: theme.bentoMuted, marginTop: 14, paddingHorizontal: 8, lineHeight: 16 },
  error: { color: theme.bentoLoss, fontSize: 12, fontWeight: '700', marginBottom: 10, paddingHorizontal: 8 },
});
