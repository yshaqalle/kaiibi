import { useCallback, useEffect, useMemo, useState } from 'react';
import { StyleSheet, Text, useWindowDimensions, View } from 'react-native';

import { formatRangeLabel } from '@/components/accounting/transactions-tab';
import { Card } from '@/components/card';
import { PaymentMixChart, type PaymentMixItem } from '@/components/payment-mix-chart';
import type { DateRange } from '@/components/range-selector';
import { RankingChart, type RankingItem } from '@/components/ranking-chart';
import { StatTile } from '@/components/stat-tile';
import { TrendChart, type TrendPoint } from '@/components/trend-chart';
import { Caveat } from '@/components/ui/caveat';
import { Colors } from '@/constants/theme';
import { useAuth } from '@/hooks/use-auth';
import { formatAccountingCents, formatCompactCents } from '@/lib/currency';
import { totalExpenseCents } from '@/lib/expense-reporting';
import { listExpensesInRange } from '@/lib/expenses';
import { scopeToLocation } from '@/lib/location-reporting';
import { getSalesAndRefundsInRange, getTopSellingProducts } from '@/lib/sales';
import {
  bucketDailyTotals,
  cashierPerformance,
  costOfGoodsSold,
  paymentMethodMix,
  type DailyBucket,
} from '@/lib/sales-reporting';

// Pinned to the light palette for now — no dark-mode switching yet.
const theme = Colors.light;

function extractErrorMessage(err: unknown): string {
  if (err && typeof err === 'object' && 'message' in err && typeof (err as { message: unknown }).message === 'string') {
    return (err as { message: string }).message;
  }
  return 'Something went wrong.';
}

export function OverviewTab({
  dateRange,
  locationFilter,
}: {
  dateRange: DateRange;
  /** Owned by the Accounting shell so it survives a tab switch. null = every store. */
  locationFilter: string | null;
}) {
  const { shop } = useAuth();
  const { width } = useWindowDimensions();
  // Matches the admin sidebar's own desktop breakpoint.
  const wide = width >= 1000;
  const { since, until } = dateRange;

  const [daily, setDaily] = useState<DailyBucket[]>([]);
  const [expenseCents, setExpenseCents] = useState(0);
  const [paymentMix, setPaymentMix] = useState<PaymentMixItem[]>([]);
  const [topProducts, setTopProducts] = useState<{ name: string; revenueCents: number }[]>([]);
  const [cashiers, setCashiers] = useState<{ name: string; revenueCents: number }[]>([]);
  const [cogsCents, setCogsCents] = useState(0);
  const [uncostedItemCount, setUncostedItemCount] = useState(0);
  const [uncostedRevenueCents, setUncostedRevenueCents] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!shop) return;
    setLoading(true);
    try {
      // The daily buckets, the payment mix, the cashier ranking and now the
      // cost of goods are all derived from the SAME sales set, which is
      // already fetched once here. Cost of goods is therefore free — which is
      // why the profit figure below can be a real one rather than a
      // simplification.
      const [{ sales, refunds }, expenses, top] = await Promise.all([
        getSalesAndRefundsInRange(shop.id, since, until, locationFilter),
        listExpensesInRange(shop.id, since, until),
        getTopSellingProducts(shop.id, since, until),
      ]);
      setDaily(bucketDailyTotals(sales, refunds, since, until));
      setExpenseCents(totalExpenseCents(scopeToLocation(expenses, locationFilter)));
      setPaymentMix(paymentMethodMix(sales));
      setTopProducts(top.byRevenue);
      setCashiers(cashierPerformance(sales));
      const cogs = costOfGoodsSold(sales, refunds);
      setCogsCents(cogs.cogsCents);
      setUncostedItemCount(cogs.uncostedItemCount);
      setUncostedRevenueCents(cogs.uncostedRevenueCents);
      setError(null);
    } catch (err) {
      setError(extractErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [shop, since, until, locationFilter]);

  useEffect(() => { reload(); }, [reload]);

  const revenueCents = useMemo(() => daily.reduce((sum, d) => sum + d.netRevenueCents, 0), [daily]);
  const refundCents = useMemo(() => daily.reduce((sum, d) => sum + d.refundCents, 0), [daily]);
  const taxCents = useMemo(() => daily.reduce((sum, d) => sum + d.taxCents, 0), [daily]);

  // Revenue less what the goods cost. NOT net profit: operating expenses and
  // labour come off on Reports.
  //
  // This tile used to read "Net profit" and be `revenue - expenses`, with no
  // cost of goods in it at all — so Overview and Reports each showed a figure
  // called "Net profit" and they could differ by an order of magnitude, with
  // nothing on either screen to explain why. The data to do it properly was
  // already being fetched.
  const grossProfitCents = revenueCents - cogsCents;

  // Null rather than 0 when there is no revenue: "0% margin" on a quiet day
  // states something false about the shop, where no figure states nothing.
  const marginPct = revenueCents > 0 ? Math.round((grossProfitCents / revenueCents) * 100) : null;

  const trendData: TrendPoint[] = useMemo(
    () =>
      daily.map((d) => ({
        label: new Date(d.day).toLocaleDateString(undefined, { weekday: 'short' })[0],
        value: d.netRevenueCents,
      })),
    [daily]
  );

  const rankItems: RankingItem[] = useMemo(
    () => topProducts.map((p) => ({ name: p.name, value: p.revenueCents })),
    [topProducts]
  );

  const cashierItems: RankingItem[] = useMemo(
    () => cashiers.map((c) => ({ name: c.name, value: c.revenueCents })),
    [cashiers]
  );

  const rangeLabel = formatRangeLabel(dateRange);

  if (loading) return <Text style={styles.empty}>Loading…</Text>;

  return (
    <View>
      {error && <Text style={styles.error}>{error}</Text>}

      <View style={styles.metricRow}>
        <StatTile value={formatCompactCents(revenueCents)} label="Revenue" hint="net of sales tax & refunds" />
        <StatTile value={formatCompactCents(expenseCents)} label="Expenses" hint="operating" />
        <StatTile
          value={formatCompactCents(grossProfitCents)}
          label="Gross profit"
          hint={marginPct === null ? 'before operating expenses' : `${marginPct}% margin · before expenses`}
          tone="positive"
        />
        <StatTile value={formatCompactCents(taxCents)} label="Sales tax collected" hint="held for the tax authority" />
      </View>

      {/* Promoted from grey body text. Revenue excludes tax the shop is only
          holding, so the two figures above never double-count — said plainly
          because an owner checking against the till will otherwise wonder
          where the difference went. */}
      <Caveat tone="context">
        {`Revenue is what you earned — sales tax collected is held for the tax authority and is not counted as income.${
          refundCents > 0 ? ` ${formatAccountingCents(refundCents)} of refunds is already deducted.` : ''
        }`}
      </Caveat>

      <Caveat tone="context">
        Gross profit is revenue less what the goods cost. Operating expenses and wages come off on Reports, which is
        where the bottom line lives.
      </Caveat>

      {uncostedItemCount > 0 ? (
        <Caveat tone="wrong">
          {`${uncostedItemCount} sold ${uncostedItemCount === 1 ? 'item has' : 'items have'} no cost recorded (${formatAccountingCents(uncostedRevenueCents)} of revenue), so cost of goods is understated and gross profit looks higher than it is.`}
        </Caveat>
      ) : null}

      {/* Paired on a wide screen so the revenue shape and the payment split
          are read together — they answer "how much" and "how" about the same
          money. Stacks below the breakpoint, where side-by-side would crush
          both. */}
      <View style={[styles.row, wide && styles.rowWide]}>
        <View style={styles.col}>
          <Text style={styles.sectionTitle}>Revenue · {rangeLabel}</Text>
          <Card style={styles.chartCard}>
            <TrendChart data={trendData} formatValue={formatAccountingCents} />
          </Card>
        </View>
        <View style={styles.col}>
          <Text style={styles.sectionTitle}>Payment methods</Text>
          <Card style={styles.chartCard}>
            <PaymentMixChart items={paymentMix} formatValue={formatAccountingCents} />
          </Card>
        </View>
      </View>

      <View style={[styles.row, wide && styles.rowWide]}>
        <View style={styles.col}>
          <Text style={styles.sectionTitle}>Top products</Text>
          <Card style={styles.chartCard}>
            <RankingChart
              items={rankItems}
              formatValue={formatAccountingCents}
              emptyLabel="No sales yet in this range."
              showRank
            />
          </Card>
        </View>
        <View style={styles.col}>

          {/* Moved here from Reports: who served the most is a pulse question,
              not an analysis one, and it comes free from the sales set already
              loaded above. */}
          <Text style={styles.sectionTitle}>Who rang it up</Text>
          <Card style={styles.chartCard}>
            <RankingChart
              items={cashierItems}
              formatValue={formatAccountingCents}
              emptyLabel="No cashier activity in this range."
              showRank
            />
            <Caveat tone="context">
              Gross takings, not net — this ranks who served the most, so it reconciles against a till.
            </Caveat>
          </Card>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  metricRow: { flexDirection: 'row', gap: 10, marginBottom: 12, flexWrap: 'wrap' },
  sectionTitle: { fontSize: 15, fontWeight: '800', color: theme.text, marginTop: 18, marginBottom: 12 },
  chartCard: { padding: 16, marginBottom: 8 },
  row: { gap: 0 },
  rowWide: { flexDirection: 'row', gap: 14 },
  col: { flex: 1, minWidth: 0 },
  empty: { color: '#999999', fontSize: 13, marginTop: 20, textAlign: 'center' },
  error: { color: '#C0392B', fontSize: 12, fontWeight: '700', marginBottom: 12 },
});
