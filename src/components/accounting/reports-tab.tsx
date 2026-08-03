import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { formatRangeLabel } from '@/components/accounting/transactions-tab';
import { Card } from '@/components/card';
import { CategoryDonutChart, type CategorySlice } from '@/components/category-donut-chart';
import type { DateRange } from '@/components/range-selector';
import { RankingChart } from '@/components/ranking-chart';
import { Colors } from '@/constants/theme';
import { useAuth } from '@/hooks/use-auth';
import { formatAccountingCents } from '@/lib/currency';
import { expenseCategoryLabel, expenseTotalsByCategory, operatingExpenseCents, totalExpenseCents } from '@/lib/expense-reporting';
import { listExpensesInRange } from '@/lib/expenses';
import { sharePdf } from '@/lib/export-file';
import { buildDashboardReportHtml, type ReportSection, type ReportStat } from '@/lib/report-pdf';
import { getCashierPerformance, getCategoryBreakdown, getSalesPerformance } from '@/lib/sales';
import type { Expense } from '@/types/models';

// Pinned to the light palette for now — no dark-mode switching yet.
const theme = Colors.light;

type SalesPerformance = Awaited<ReturnType<typeof getSalesPerformance>>;

function extractErrorMessage(err: unknown): string {
  if (err && typeof err === 'object' && 'message' in err && typeof (err as { message: unknown }).message === 'string') {
    return (err as { message: string }).message;
  }
  return 'Something went wrong.';
}

export function ReportsTab({ dateRange }: { dateRange: DateRange }) {
  const { shop } = useAuth();
  const { since, until } = dateRange;

  const [performance, setPerformance] = useState<SalesPerformance | null>(null);
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [categories, setCategories] = useState<{ category: string; unitsSold: number; revenueCents: number }[]>([]);
  const [cashiers, setCashiers] = useState<{ name: string; revenueCents: number }[]>([]);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!shop) return;
    setLoading(true);
    try {
      const [perf, expenseRows, categoryRows, cashierRows] = await Promise.all([
        getSalesPerformance(shop.id, since, until),
        listExpensesInRange(shop.id, since, until),
        getCategoryBreakdown(shop.id, since, until),
        getCashierPerformance(shop.id, since, until),
      ]);
      setPerformance(perf);
      setExpenses(expenseRows);
      setCategories(categoryRows);
      setCashiers(cashierRows);
      setError(null);
    } catch (err) {
      setError(extractErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [shop, since, until]);

  useEffect(() => { reload(); }, [reload]);

  if (loading || !performance) return <Text style={styles.empty}>Loading…</Text>;

  const revenueCents = performance.netRevenueCents;
  const cogsCents = performance.cogsCents;
  const grossProfitCents = revenueCents - cogsCents;
  const operatingCents = operatingExpenseCents(expenses);
  const netProfitCents = grossProfitCents - operatingCents;

  const nonOperatingCents = totalExpenseCents(expenses) - operatingCents;
  const categoryTotals = expenseTotalsByCategory(expenses);
  const rangeLabel = formatRangeLabel(dateRange);

  const categorySlices: CategorySlice[] = categories.map((c) => ({ category: c.category, value: c.unitsSold }));

  const exportPdf = async () => {
    if (!shop) return;
    setExporting(true);
    try {
      const stats: ReportStat[] = [
        { label: 'Revenue', value: formatAccountingCents(revenueCents) },
        { label: 'Gross profit', value: formatAccountingCents(grossProfitCents) },
        { label: 'Operating expenses', value: formatAccountingCents(operatingCents) },
        { label: 'Net profit', value: formatAccountingCents(netProfitCents) },
      ];
      const sections: ReportSection[] = [
        {
          title: 'Profit and loss',
          columns: [
            { header: 'Line', value: (r: { label: string }) => r.label },
            { header: 'Amount', value: (r: { amount: string }) => r.amount },
          ],
          rows: [
            { label: 'Revenue (net of tax and refunds)', amount: formatAccountingCents(revenueCents) },
            { label: 'Cost of goods sold', amount: `-${formatAccountingCents(cogsCents)}` },
            { label: 'Gross profit', amount: formatAccountingCents(grossProfitCents) },
            { label: 'Operating expenses', amount: `-${formatAccountingCents(operatingCents)}` },
            { label: 'Net profit', amount: formatAccountingCents(netProfitCents) },
          ],
        },
        {
          title: 'Sales tax collected (owed, not income)',
          columns: [
            { header: 'Line', value: (r: { label: string }) => r.label },
            { header: 'Amount', value: (r: { amount: string }) => r.amount },
          ],
          rows: [
            { label: 'Gross takings', amount: formatAccountingCents(performance.grossSalesCents) },
            { label: 'Sales tax collected', amount: formatAccountingCents(performance.taxCollectedCents) },
            { label: 'Refunds issued', amount: formatAccountingCents(performance.refundedCents) },
          ],
        },
        {
          title: 'Expenses by category',
          columns: [
            { header: 'Category', value: (r: { category: string }) => expenseCategoryLabel(r.category as never) },
            { header: 'Amount', value: (r: { totalCents: number }) => formatAccountingCents(r.totalCents) },
          ],
          rows: categoryTotals,
        },
        {
          title: 'Sales by product category',
          columns: [
            { header: 'Category', value: (c: { category: string }) => c.category },
            { header: 'Units sold', value: (c: { unitsSold: number }) => String(c.unitsSold) },
            { header: 'Revenue', value: (c: { revenueCents: number }) => formatAccountingCents(c.revenueCents) },
          ],
          rows: categories,
        },
        {
          title: 'Cashier performance',
          columns: [
            { header: 'Cashier', value: (c: { name: string }) => c.name },
            { header: 'Takings', value: (c: { revenueCents: number }) => formatAccountingCents(c.revenueCents) },
          ],
          rows: cashiers,
        },
      ];
      // The uncosted caveat has to travel with the PDF: an exported report is
      // the one most likely to be read away from the screen that explained it.
      const subtitle =
        performance.uncostedItemCount > 0
          ? `${rangeLabel} · ${performance.uncostedItemCount} sold item${performance.uncostedItemCount === 1 ? '' : 's'} had no cost recorded, so cost of goods sold is understated`
          : rangeLabel;
      await sharePdf(
        buildDashboardReportHtml({ title: `${shop.name} — Financial report`, subtitle, stats, sections }),
        `${shop.name} financial report`
      );
    } finally {
      setExporting(false);
    }
  };

  return (
    <View>
      {error && <Text style={styles.error}>{error}</Text>}

      <View style={styles.headerRow}>
        <Pressable onPress={exportPdf} disabled={exporting} style={styles.exportButton}>
          {exporting ? <ActivityIndicator size="small" color="#FFFFFF" /> : <Text style={styles.exportButtonText}>Export PDF</Text>}
        </Pressable>
      </View>

      <Text style={styles.sectionTitle}>Profit &amp; loss · {rangeLabel}</Text>
      <Card style={styles.card}>
        <PnlRow label="Revenue" hint="net of sales tax and refunds" amountCents={revenueCents} />
        <PnlRow
          label="Cost of goods sold"
          hint="what the items sold cost you"
          amountCents={-cogsCents}
        />
        <PnlRow label="Gross profit" amountCents={grossProfitCents} emphasis />
        <PnlRow label="Operating expenses" hint="excludes stock purchases and owner draws" amountCents={-operatingCents} />
        <PnlRow label="Net profit" amountCents={netProfitCents} emphasis total />
        {performance.uncostedItemCount > 0 && (
          <Text style={styles.caveat}>
            {performance.uncostedItemCount} sold item{performance.uncostedItemCount === 1 ? '' : 's'} had no cost recorded
            ({formatAccountingCents(performance.uncostedRevenueCents)} of revenue), so cost of goods sold is understated and
            profit looks higher than it is. Set a cost on those products in Inventory.
          </Text>
        )}
        {nonOperatingCents > 0 && (
          <Text style={styles.caveat}>
            {formatAccountingCents(nonOperatingCents)} of stock purchases and owner draws is excluded above — stock becomes a
            cost when it sells, and an owner draw isn&apos;t a business cost. Both still leave the bank account.
          </Text>
        )}
      </Card>

      <Text style={styles.sectionTitle}>Sales tax collected</Text>
      <Card style={styles.card}>
        <PnlRow label="Gross takings" amountCents={performance.grossSalesCents} />
        <PnlRow label="Sales tax collected" hint="held for the tax authority" amountCents={performance.taxCollectedCents} />
        {performance.refundedCents > 0 && <PnlRow label="Refunds issued" amountCents={-performance.refundedCents} />}
        <Text style={styles.caveat}>
          Tax collected is money you owe onward, not income — it is excluded from revenue and profit above.
          {shop?.taxEnabled ? ` Your current rate is ${shop.taxRatePercent}%; past sales keep the rate they were charged at.` : ''}
        </Text>
      </Card>

      {categoryTotals.length > 0 && (
        <>
          <Text style={styles.sectionTitle}>Where the money went</Text>
          <Card style={styles.card}>
            {categoryTotals.map((row) => (
              <PnlRow key={row.category} label={expenseCategoryLabel(row.category)} amountCents={row.totalCents} />
            ))}
          </Card>
        </>
      )}

      <Text style={styles.sectionTitle}>Sales by product category</Text>
      <Card style={styles.chartCard}>
        <CategoryDonutChart items={categorySlices} totalLabel="Units sold" />
      </Card>

      <Text style={styles.sectionTitle}>Cashier performance</Text>
      <Card style={styles.chartCard}>
        <RankingChart
          items={cashiers.map((c) => ({ name: c.name, value: c.revenueCents }))}
          formatValue={formatAccountingCents}
          emptyLabel="No cashier-attributed sales yet."
        />
      </Card>
    </View>
  );
}

function PnlRow({
  label,
  hint,
  amountCents,
  emphasis,
  total,
}: {
  label: string;
  hint?: string;
  amountCents: number;
  emphasis?: boolean;
  total?: boolean;
}) {
  return (
    <View style={[styles.pnlRow, total && styles.pnlRowTotal]}>
      <View style={styles.pnlLabelWrap}>
        <Text style={[styles.pnlLabel, emphasis && styles.pnlLabelEmphasis]}>{label}</Text>
        {hint ? <Text style={styles.pnlHint}>{hint}</Text> : null}
      </View>
      <Text style={[styles.pnlAmount, emphasis && styles.pnlAmountEmphasis, amountCents < 0 && styles.pnlAmountNegative]}>
        {formatAccountingCents(amountCents)}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  headerRow: { flexDirection: 'row', justifyContent: 'flex-end', marginBottom: 8 },
  exportButton: { backgroundColor: '#111111', borderRadius: 10, paddingHorizontal: 14, paddingVertical: 10, minWidth: 96, alignItems: 'center' },
  exportButtonText: { color: '#FFFFFF', fontWeight: '800', fontSize: 11 },
  sectionTitle: { fontSize: 15, fontWeight: '800', color: theme.text, marginTop: 10, marginBottom: 12 },
  card: { padding: 16, marginBottom: 8 },
  chartCard: { padding: 16, marginBottom: 8 },

  pnlRow: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, paddingVertical: 10 },
  pnlRowTotal: { borderTopWidth: 1, borderTopColor: '#ECECEC', marginTop: 4, paddingTop: 14 },
  pnlLabelWrap: { flex: 1, minWidth: 0 },
  pnlLabel: { fontSize: 13, color: '#111111' },
  pnlLabelEmphasis: { fontWeight: '800' },
  pnlHint: { fontSize: 11, color: '#999999', marginTop: 2 },
  pnlAmount: { fontSize: 13, fontWeight: '700', color: '#111111' },
  pnlAmountEmphasis: { fontSize: 15, fontWeight: '800' },
  pnlAmountNegative: { color: '#C0392B' },

  caveat: { fontSize: 11, color: '#B5793A', lineHeight: 16, marginTop: 12 },
  empty: { color: '#999999', fontSize: 13, marginTop: 20, textAlign: 'center' },
  error: { color: '#C0392B', fontSize: 12, fontWeight: '700', marginBottom: 12 },
});
