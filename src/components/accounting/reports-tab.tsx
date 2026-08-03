import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { formatRangeLabel } from '@/components/accounting/transactions-tab';
import { useHeaderActions, type HeaderActionsSetter } from '@/components/accounting/use-header-actions';
import { Card } from '@/components/card';
import { CategoryDonutChart, type CategorySlice } from '@/components/category-donut-chart';
import { CategoryOverTimeChart, type MonthlyCategoryBucket } from '@/components/category-over-time-chart';
import type { DateRange } from '@/components/range-selector';
import { RankingChart } from '@/components/ranking-chart';
import { Colors } from '@/constants/theme';
import { useAuth } from '@/hooks/use-auth';
import { formatAccountingCents } from '@/lib/currency';
import { expenseCategoryLabel, expenseTotalsByCategory, operatingExpenseCents, totalExpenseCents } from '@/lib/expense-reporting';
import { listExpensesInRange } from '@/lib/expenses';
import { sharePdf } from '@/lib/export-file';
import { listPayrollRuns } from '@/lib/payroll';
import { accruedLaborCents } from '@/lib/payroll-reporting';
import { sumDurationHours } from '@/lib/shift-hours';
import { buildDashboardReportHtml, type ReportSection, type ReportStat } from '@/lib/report-pdf';
import { getCategoryBreakdown, getCategoryRevenueByMonth, getSalesAndRefundsInRange } from '@/lib/sales';
import {
  cashierPerformance,
  costOfGoodsSold,
  grossSalesCents,
  netRevenueCents,
  refundedCents,
  taxCollectedCents,
} from '@/lib/sales-reporting';
import { listStaff } from '@/lib/staff';
import { listShopTimeEntries } from '@/lib/time-entries';
import type { Expense } from '@/types/models';

type LaborPicture = {
  accruedCents: number;
  hours: number;
  fixedExcludedCount: number;
  nonHourlyCount: number;
  // Every hour clocked in the range, whether or not a pay run has settled it.
  // The accrual only counts unposted days, so it's the wrong denominator for
  // "what did an hour of work earn".
  totalHoursInRange: number;
};

// Pinned to the light palette for now — no dark-mode switching yet.
const theme = Colors.light;

type SalesPerformance = {
  grossSalesCents: number;
  taxCollectedCents: number;
  refundedCents: number;
  netRevenueCents: number;
  cogsCents: number;
  uncostedItemCount: number;
  uncostedRevenueCents: number;
};

function extractErrorMessage(err: unknown): string {
  if (err && typeof err === 'object' && 'message' in err && typeof (err as { message: unknown }).message === 'string') {
    return (err as { message: string }).message;
  }
  return 'Something went wrong.';
}

export function ReportsTab({
  dateRange,
  setHeaderActions,
}: {
  dateRange: DateRange;
  setHeaderActions: HeaderActionsSetter;
}) {
  const { shop, can } = useAuth();
  const { since, until } = dateRange;
  // Pay data is RLS-protected. Without both permissions the labour figures
  // simply can't be read, so the P&L says so rather than quietly omitting a
  // cost and showing a different profit than a payroll manager would see.
  const canSeeLabor = can('people.payroll.manage') && can('expenses.manage');

  const [performance, setPerformance] = useState<SalesPerformance | null>(null);
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [categories, setCategories] = useState<{ category: string; unitsSold: number; revenueCents: number }[]>([]);
  const [cashiers, setCashiers] = useState<{ name: string; revenueCents: number }[]>([]);
  const [categoryByMonth, setCategoryByMonth] = useState<MonthlyCategoryBucket[]>([]);
  const [labor, setLabor] = useState<LaborPicture | null>(null);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!shop) return;
    setLoading(true);
    try {
      // One sales fetch, several aggregates. Previously the P&L figures and
      // the cashier ranking each pulled the whole nested sales set for the
      // range -- the same heavy query, twice per screen load.
      const [{ sales, refunds }, expenseRows, categoryRows, categoryMonths] = await Promise.all([
        getSalesAndRefundsInRange(shop.id, since, until),
        listExpensesInRange(shop.id, since, until),
        getCategoryBreakdown(shop.id, since, until),
        getCategoryRevenueByMonth(shop.id, since, until),
      ]);
      setPerformance({
        grossSalesCents: grossSalesCents(sales),
        taxCollectedCents: taxCollectedCents(sales),
        refundedCents: refundedCents(refunds),
        netRevenueCents: netRevenueCents(sales, refunds),
        ...costOfGoodsSold(sales, refunds),
      });
      setExpenses(expenseRows);
      setCategories(categoryRows);
      setCashiers(cashierPerformance(sales));
      setCategoryByMonth(categoryMonths);

      if (canSeeLabor) {
        // Labour worked on days no posted pay run covers. Coverage is now
        // per member, derived from each posted run's lines rather than its
        // period, so a run drops days only for the members it actually
        // paid — never for someone else's still-unpaid days — and the
        // accrual and the posted wages can never both count the same day
        // for the same person.
        const rangeEnd = until ?? new Date();
        const [members, entries, runs] = await Promise.all([
          listStaff(shop.id),
          listShopTimeEntries(shop.id, { sinceIso: since.toISOString() }),
          listPayrollRuns(shop.id),
        ]);
        const inRange = entries.filter((e) => {
          const at = new Date(e.clockIn).getTime();
          return at >= since.getTime() && at <= rangeEnd.getTime();
        });
        setLabor({
          ...accruedLaborCents(members, entries, since, rangeEnd, runs),
          totalHoursInRange: Number(sumDurationHours(inRange).toFixed(2)),
        });
      } else {
        setLabor(null);
      }
      setError(null);
    } catch (err) {
      setError(extractErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [shop, since, until, canSeeLabor]);

  useEffect(() => { reload(); }, [reload]);

  if (loading || !performance) return <Text style={styles.empty}>Loading…</Text>;

  const revenueCents = performance.netRevenueCents;
  const cogsCents = performance.cogsCents;
  const grossProfitCents = revenueCents - cogsCents;
  const postedOperatingCents = operatingExpenseCents(expenses);
  // Wages are earned as they're worked, so unpaid labour is a real cost of
  // this period even before a pay run settles it. Counting it here is what
  // keeps profit honest for a period payroll hasn't been run for yet.
  const accruedLabor = labor?.accruedCents ?? 0;
  const operatingCents = postedOperatingCents + accruedLabor;
  const netProfitCents = grossProfitCents - operatingCents;

  // Against the *posted* operating figure, not the accrual-inclusive one:
  // `expenses` holds only real rows, so subtracting accrued labour (which has
  // no row yet) would understate this and could drive it negative.
  const nonOperatingCents = totalExpenseCents(expenses) - postedOperatingCents;
  const categoryTotals = expenseTotalsByCategory(expenses);
  const rangeLabel = formatRangeLabel(dateRange);

  // Total labour: wages a pay run has already posted, plus hours worked that
  // no run has settled. Counting only one would swing the figure wildly
  // depending on whether payroll happened to have been run this period.
  const postedWagesCents = categoryTotals.find((c) => c.category === 'salaries_wages')?.totalCents ?? 0;
  const totalLaborCents = postedWagesCents + accruedLabor;
  const laborPctOfRevenue = revenueCents > 0 ? Math.round((totalLaborCents / revenueCents) * 100) : null;
  const revenuePerLaborHourCents =
    labor && labor.totalHoursInRange > 0 ? Math.round(revenueCents / labor.totalHoursInRange) : null;

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
            { label: 'Operating expenses', amount: `-${formatAccountingCents(postedOperatingCents)}` },
            ...(accruedLabor > 0
              ? [{ label: 'Wages earned, not yet paid', amount: `-${formatAccountingCents(accruedLabor)}` }]
              : []),
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
      // Caveats have to travel with the PDF: an exported report is the one
      // most likely to be read away from the screen that explained it.
      const notes: string[] = [rangeLabel];
      if (performance.uncostedItemCount > 0) {
        notes.push(
          `${performance.uncostedItemCount} sold item${performance.uncostedItemCount === 1 ? '' : 's'} had no cost recorded, so cost of goods sold is understated`
        );
      }
      if (accruedLabor > 0) {
        notes.push('includes wages earned but not yet paid');
      }
      if (!canSeeLabor) {
        notes.push('excludes labour costs (no payroll access)');
      }
      const subtitle = notes.join(' · ');
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
      <ReportsHeaderActions onExport={exportPdf} exporting={exporting} setHeaderActions={setHeaderActions} />

      {error && <Text style={styles.error}>{error}</Text>}

      <Text style={styles.sectionTitle}>Profit &amp; loss · {rangeLabel}</Text>
      <Card style={styles.card}>
        <PnlRow label="Revenue" hint="net of sales tax and refunds" amountCents={revenueCents} />
        <PnlRow
          label="Cost of goods sold"
          hint="what the items sold cost you"
          amountCents={-cogsCents}
        />
        <PnlRow label="Gross profit" amountCents={grossProfitCents} emphasis />
        <PnlRow label="Operating expenses" hint="excludes stock purchases and owner draws" amountCents={-postedOperatingCents} />
        {accruedLabor > 0 && (
          <PnlRow
            label="Wages earned, not yet paid"
            hint={labor && labor.hours > 0 ? `incl. ${labor.hours}h worked, no pay run yet` : 'no pay run yet'}
            amountCents={-accruedLabor}
          />
        )}
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
        {accruedLabor > 0 && (
          <Text style={styles.caveat}>
            Wages above are pay already earned — hourly or salaried — with no pay run posted yet. Post a run in Payroll
            and this line moves into operating expenses — the total won&apos;t change.
            {labor && labor.fixedExcludedCount > 0
              ? ` ${labor.fixedExcludedCount} fixed-pay ${labor.fixedExcludedCount === 1 ? 'person is' : 'people are'} not included — a flat per-run amount has no daily rate to accrue.`
              : ''}
          </Text>
        )}
        {!canSeeLabor && (
          <Text style={styles.caveat}>
            Wages aren&apos;t included — you don&apos;t have payroll access, so this profit figure leaves out labour costs.
          </Text>
        )}
      </Card>

      {canSeeLabor && totalLaborCents > 0 && (
        <>
          <Text style={styles.sectionTitle}>Labour</Text>
          <Card style={styles.card}>
            <PnlRow label="Wages posted by a pay run" amountCents={postedWagesCents} />
            {accruedLabor > 0 && <PnlRow label="Earned, not yet paid" amountCents={accruedLabor} />}
            <PnlRow label="Total labour cost" amountCents={totalLaborCents} emphasis />
            <View style={styles.kpiRow}>
              {laborPctOfRevenue !== null && (
                <View style={styles.kpi}>
                  <Text style={styles.kpiValue}>{laborPctOfRevenue}%</Text>
                  <Text style={styles.kpiLabel}>of revenue goes on wages</Text>
                </View>
              )}
              {revenuePerLaborHourCents !== null && (
                <View style={styles.kpi}>
                  <Text style={styles.kpiValue}>{formatAccountingCents(revenuePerLaborHourCents)}</Text>
                  <Text style={styles.kpiLabel}>earned per hour worked</Text>
                </View>
              )}
            </View>
            {labor && labor.totalHoursInRange > 0 && (
              <Text style={styles.caveat}>
                Based on {labor.totalHoursInRange}h clocked in this period.
                {labor.nonHourlyCount > 0
                  ? ` ${labor.nonHourlyCount} salaried or fixed-pay ${labor.nonHourlyCount === 1 ? 'person does' : 'people do'} not clock hours, so the per-hour figure reflects hourly staff only.`
                  : ''}
              </Text>
            )}
          </Card>
        </>
      )}

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

      <Text style={styles.sectionTitle}>Revenue by category over time</Text>
      <Card style={styles.chartCard}>
        <CategoryOverTimeChart months={categoryByMonth} />
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

// A child rather than a hook call in ReportsTab: that component returns early
// while loading, and `exportPdf` is only defined past that point, so the hook
// can't sit above it.
function ReportsHeaderActions({
  onExport,
  exporting,
  setHeaderActions,
}: {
  onExport: () => void;
  exporting: boolean;
  setHeaderActions: HeaderActionsSetter;
}) {
  useHeaderActions(
    setHeaderActions,
    <Pressable onPress={onExport} disabled={exporting} style={styles.exportButton}>
      {exporting ? <ActivityIndicator size="small" color="#FFFFFF" /> : <Text style={styles.exportButtonText}>Export PDF</Text>}
    </Pressable>,
    [onExport, exporting]
  );
  return null;
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

  kpiRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 24, marginTop: 14, paddingTop: 14, borderTopWidth: 1, borderTopColor: '#ECECEC' },
  kpi: { minWidth: 120 },
  kpiValue: { fontSize: 20, fontWeight: '800', color: '#111111', letterSpacing: -0.5 },
  kpiLabel: { fontSize: 11, color: '#999999', marginTop: 2 },
  caveat: { fontSize: 11, color: '#B5793A', lineHeight: 16, marginTop: 12 },
  empty: { color: '#999999', fontSize: 13, marginTop: 20, textAlign: 'center' },
  error: { color: '#C0392B', fontSize: 12, fontWeight: '700', marginBottom: 12 },
});
