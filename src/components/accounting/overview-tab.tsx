import { useCallback, useEffect, useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { formatRangeLabel } from '@/components/accounting/transactions-tab';
import { Card } from '@/components/card';
import { PaymentMixChart, type PaymentMixItem } from '@/components/payment-mix-chart';
import type { DateRange } from '@/components/range-selector';
import { RankingChart, type RankingItem } from '@/components/ranking-chart';
import { StatTile } from '@/components/stat-tile';
import { TrendChart, type TrendPoint } from '@/components/trend-chart';
import { Colors } from '@/constants/theme';
import { useAuth } from '@/hooks/use-auth';
import { formatAccountingCents } from '@/lib/currency';
import { totalExpenseCents } from '@/lib/expense-reporting';
import { listExpensesInRange } from '@/lib/expenses';
import { getSalesAndRefundsInRange, getTopSellingProducts } from '@/lib/sales';
import { bucketDailyTotals, paymentMethodMix, type DailyBucket } from '@/lib/sales-reporting';

// Pinned to the light palette for now — no dark-mode switching yet.
const theme = Colors.light;

function extractErrorMessage(err: unknown): string {
  if (err && typeof err === 'object' && 'message' in err && typeof (err as { message: unknown }).message === 'string') {
    return (err as { message: string }).message;
  }
  return 'Something went wrong.';
}

export function OverviewTab({ dateRange }: { dateRange: DateRange }) {
  const { shop } = useAuth();
  const { since, until } = dateRange;

  const [daily, setDaily] = useState<DailyBucket[]>([]);
  const [expenseCents, setExpenseCents] = useState(0);
  const [paymentMix, setPaymentMix] = useState<PaymentMixItem[]>([]);
  const [topProducts, setTopProducts] = useState<{ name: string; revenueCents: number }[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!shop) return;
    setLoading(true);
    try {
      // The daily buckets and the payment mix are both derived from the same
      // sales set, so it is fetched once -- that query pulls five nested
      // relations and was previously run twice per screen load.
      const [{ sales, refunds }, expenses, top] = await Promise.all([
        getSalesAndRefundsInRange(shop.id, since, until),
        listExpensesInRange(shop.id, since, until),
        getTopSellingProducts(shop.id, since, until),
      ]);
      setDaily(bucketDailyTotals(sales, refunds, since, until));
      setExpenseCents(totalExpenseCents(expenses));
      setPaymentMix(paymentMethodMix(sales));
      setTopProducts(top.byRevenue);
      setError(null);
    } catch (err) {
      setError(extractErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [shop, since, until]);

  useEffect(() => { reload(); }, [reload]);

  // Revenue is already net of sales tax and refunds (see sales-reporting.ts),
  // so this subtraction is a like-for-like comparison rather than mixing
  // takings against costs.
  const revenueCents = useMemo(() => daily.reduce((sum, d) => sum + d.netRevenueCents, 0), [daily]);
  const refundCents = useMemo(() => daily.reduce((sum, d) => sum + d.refundCents, 0), [daily]);
  const taxCents = useMemo(() => daily.reduce((sum, d) => sum + d.taxCents, 0), [daily]);
  const netProfitCents = revenueCents - expenseCents;

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

  const rangeLabel = formatRangeLabel(dateRange);

  if (loading) return <Text style={styles.empty}>Loading…</Text>;

  return (
    <View>
      {error && <Text style={styles.error}>{error}</Text>}

      <View style={styles.metricRow}>
        <StatTile value={formatAccountingCents(revenueCents)} label="Revenue" />
        <StatTile value={formatAccountingCents(expenseCents)} label="Expenses" />
        <StatTile
          value={formatAccountingCents(netProfitCents)}
          label="Net profit"
          tone={netProfitCents < 0 ? 'warning' : 'default'}
        />
        <StatTile value={formatAccountingCents(taxCents)} label="Sales tax collected" />
      </View>

      {/* Revenue excludes tax the shop is only holding, so the two figures
          above never double-count. Said plainly because a shop owner checking
          against the till will otherwise wonder where the difference went. */}
      <Text style={styles.caption}>
        Revenue is what you earned — sales tax collected is held for the tax authority and is not counted as income.
        {refundCents > 0 ? ` ${formatAccountingCents(refundCents)} of refunds already deducted.` : ''}
      </Text>

      <Text style={styles.sectionTitle}>Revenue · {rangeLabel}</Text>
      <Card style={styles.chartCard}>
        <TrendChart data={trendData} formatValue={formatAccountingCents} />
      </Card>

      <Text style={styles.sectionTitle}>Payment methods</Text>
      <Card style={styles.chartCard}>
        <PaymentMixChart items={paymentMix} />
      </Card>

      <Text style={styles.sectionTitle}>Top products</Text>
      <Card style={styles.chartCard}>
        <RankingChart items={rankItems} formatValue={formatAccountingCents} emptyLabel="No sales yet in this range." />
      </Card>
    </View>
  );
}

const styles = StyleSheet.create({
  metricRow: { flexDirection: 'row', gap: 10, marginBottom: 12, flexWrap: 'wrap' },
  caption: { fontSize: 11.5, color: theme.textSecondary, lineHeight: 17, marginBottom: 18 },
  sectionTitle: { fontSize: 15, fontWeight: '800', color: theme.text, marginTop: 10, marginBottom: 12 },
  chartCard: { padding: 16, marginBottom: 8 },
  empty: { color: '#999999', fontSize: 13, marginTop: 20, textAlign: 'center' },
  error: { color: '#C0392B', fontSize: 12, fontWeight: '700', marginBottom: 12 },
});
