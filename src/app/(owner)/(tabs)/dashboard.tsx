import { useCallback, useEffect, useMemo, useState } from 'react';
import { SafeAreaView, ScrollView, StyleSheet, Text, View } from 'react-native';

import { Card } from '@/components/card';
import { CategoryDonutChart, type CategorySlice } from '@/components/category-donut-chart';
import { CategoryOverTimeChart, type MonthlyCategoryBucket } from '@/components/category-over-time-chart';
import { GoalMeter } from '@/components/goal-meter';
import { PaymentMixChart, type PaymentMixItem } from '@/components/payment-mix-chart';
import { ProductTile } from '@/components/product-tile';
import { RangeSelector, type DateRange } from '@/components/range-selector';
import { RankingChart, type RankingItem } from '@/components/ranking-chart';
import { SegmentedControl } from '@/components/segmented-control';
import { StatTile } from '@/components/stat-tile';
import { TrendChart, type TrendPoint } from '@/components/trend-chart';
import { Colors } from '@/constants/theme';
import { useAuth } from '@/hooks/use-auth';
import { formatCents } from '@/lib/currency';
import { getLowStockProducts } from '@/lib/products';
import {
  getCashierPerformance,
  getCategoryBreakdown,
  getCategoryRevenueByMonth,
  getDailyTotalsCents,
  getMonthToDateRevenueCents,
  getPaymentMethodMix,
  getTopSellingProducts,
  listSales,
} from '@/lib/sales';
import type { Product, Sale } from '@/types/models';

type TrendMetric = 'revenue' | 'orders' | 'discounts';
type RankMetric = 'products' | 'units' | 'cashiers';

const TREND_OPTIONS: { key: TrendMetric; label: string }[] = [
  { key: 'revenue', label: 'Revenue' },
  { key: 'orders', label: 'Orders' },
  { key: 'discounts', label: 'Discounts' },
];
const RANK_OPTIONS: { key: RankMetric; label: string }[] = [
  { key: 'products', label: 'Products' },
  { key: 'units', label: 'Units' },
  { key: 'cashiers', label: 'Cashiers' },
];

// Pinned to the light palette for now — no dark-mode switching yet.
const theme = Colors.light;

export default function DashboardScreen() {
  const { shop } = useAuth();

  const [dateRange, setDateRange] = useState<DateRange | null>(null);
  const [trendMetric, setTrendMetric] = useState<TrendMetric>('revenue');
  const [rankMetric, setRankMetric] = useState<RankMetric>('products');

  const [recentSales, setRecentSales] = useState<Sale[]>([]);
  const [dailyMetrics, setDailyMetrics] = useState<{ day: string; totalCents: number; orderCount: number; discountCents: number }[]>([]);
  const [topProducts, setTopProducts] = useState<{
    byRevenue: { name: string; quantitySold: number; revenueCents: number }[];
    byUnits: { name: string; quantitySold: number; revenueCents: number }[];
  }>({ byRevenue: [], byUnits: [] });
  const [cashierPerformance, setCashierPerformance] = useState<{ name: string; revenueCents: number }[]>([]);
  const [paymentMix, setPaymentMix] = useState<PaymentMixItem[]>([]);
  const [lowStock, setLowStock] = useState<Product[]>([]);
  const [categoryBreakdown, setCategoryBreakdown] = useState<{ category: string; unitsSold: number; revenueCents: number }[]>([]);
  const [categoryByMonth, setCategoryByMonth] = useState<MonthlyCategoryBucket[]>([]);
  const [monthToDateCents, setMonthToDateCents] = useState(0);

  const reload = useCallback(async () => {
    if (!shop || !dateRange) return;
    const { since, until } = dateRange;
    const [sales, daily, top, cashiers, mix, low, categories, categoriesByMonth] = await Promise.all([
      listSales(shop.id, 5),
      getDailyTotalsCents(shop.id, since, until),
      getTopSellingProducts(shop.id, since, until),
      getCashierPerformance(shop.id, since, until),
      getPaymentMethodMix(shop.id, since, until),
      getLowStockProducts(shop.id),
      getCategoryBreakdown(shop.id, since, until),
      getCategoryRevenueByMonth(shop.id, since, until),
    ]);
    setRecentSales(sales);
    setDailyMetrics(daily);
    setTopProducts(top);
    setCashierPerformance(cashiers);
    setPaymentMix(mix);
    setLowStock(low);
    setCategoryBreakdown(categories);
    setCategoryByMonth(categoriesByMonth);
  }, [shop, dateRange]);

  useEffect(() => { reload(); }, [reload]);

  // Independent of the range selector above — a monthly goal is always
  // measured against the current calendar month, not whatever range the
  // trend/rankings/category charts happen to be scoped to.
  useEffect(() => {
    if (!shop) return;
    getMonthToDateRevenueCents(shop.id).then(setMonthToDateCents);
  }, [shop]);

  const today = dailyMetrics.at(-1);
  const yesterday = dailyMetrics.at(-2);
  const todayTotalCents = today?.totalCents ?? 0;
  const todayOrders = today?.orderCount ?? 0;

  const salesDelta = useMemo(() => {
    if (!yesterday || yesterday.totalCents <= 0) return undefined;
    const pct = Math.round(((todayTotalCents - yesterday.totalCents) / yesterday.totalCents) * 100);
    const direction: 'up' | 'down' = pct >= 0 ? 'up' : 'down';
    return { text: `${pct >= 0 ? '▲' : '▼'}${Math.abs(pct)}%`, direction };
  }, [todayTotalCents, yesterday]);

  const ordersDelta = useMemo(() => {
    if (!yesterday) return undefined;
    const diff = todayOrders - yesterday.orderCount;
    const direction: 'up' | 'down' = diff >= 0 ? 'up' : 'down';
    return { text: `${diff >= 0 ? '▲' : '▼'}${Math.abs(diff)}`, direction };
  }, [todayOrders, yesterday]);

  const trendData: TrendPoint[] = useMemo(
    () =>
      dailyMetrics.map((d) => ({
        label: new Date(d.day).toLocaleDateString(undefined, { weekday: 'short' })[0],
        value: trendMetric === 'revenue' ? d.totalCents : trendMetric === 'orders' ? d.orderCount : d.discountCents,
      })),
    [dailyMetrics, trendMetric]
  );
  const trendFormatValue = useCallback(
    (value: number) => (trendMetric === 'orders' ? String(Math.round(value)) : formatCents(value)),
    [trendMetric]
  );

  const { rankItems, rankFormatValue, rankEmptyLabel }: { rankItems: RankingItem[]; rankFormatValue: (v: number) => string; rankEmptyLabel: string } =
    useMemo(() => {
      if (rankMetric === 'units') {
        return {
          rankItems: topProducts.byUnits.map((p) => ({ name: p.name, value: p.quantitySold })),
          rankFormatValue: (v: number) => String(v),
          rankEmptyLabel: 'No sales yet in this range.',
        };
      }
      if (rankMetric === 'cashiers') {
        return {
          rankItems: cashierPerformance.map((c) => ({ name: c.name, value: c.revenueCents })),
          rankFormatValue: formatCents,
          rankEmptyLabel: 'No cashier-attributed sales yet.',
        };
      }
      return {
        rankItems: topProducts.byRevenue.map((p) => ({ name: p.name, value: p.revenueCents })),
        rankFormatValue: formatCents,
        rankEmptyLabel: 'No sales yet in this range.',
      };
    }, [rankMetric, topProducts, cashierPerformance]);

  const insight = useMemo(() => {
    const top = topProducts.byRevenue.slice(0, 2);
    if (top.length === 0) return null;
    const names = top.map((p) => p.name).join(' and ');
    const revenue = top.reduce((sum, p) => sum + p.revenueCents, 0);
    return top.length > 1
      ? `${names} are your top sellers, generating ${formatCents(revenue)} this period.`
      : `${names} is your top seller, generating ${formatCents(revenue)} this period.`;
  }, [topProducts]);

  const categorySlices: CategorySlice[] = useMemo(
    () => categoryBreakdown.map((c) => ({ category: c.category, value: c.unitsSold })),
    [categoryBreakdown]
  );

  return (
    <SafeAreaView style={[styles.safeArea, { backgroundColor: theme.surface }]}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={[styles.greeting, { color: theme.text }]}>{shop?.name ?? 'Your shop'}</Text>

        <View style={styles.metricRow}>
          <StatTile value={formatCents(todayTotalCents)} label="Today's sales" delta={salesDelta} sparkline={dailyMetrics.map((d) => d.totalCents)} />
          <StatTile value={String(todayOrders)} label="Orders" delta={ordersDelta} />
          <StatTile value={String(lowStock.length)} label="Low stock" tone={lowStock.length > 0 ? 'warning' : 'default'} />
        </View>

        {shop?.monthlyRevenueGoalCents ? (
          <>
            <Text style={[styles.sectionTitle, { color: theme.text }]}>Revenue goal this month</Text>
            <Card style={styles.chartCard}>
              <GoalMeter valueCents={monthToDateCents} goalCents={shop.monthlyRevenueGoalCents} />
            </Card>
          </>
        ) : null}

        <Text style={[styles.sectionTitle, { color: theme.text }]}>Overview</Text>
        <Card style={styles.chartCard}>
          <SegmentedControl options={TREND_OPTIONS} value={trendMetric} onChange={setTrendMetric} />
          <RangeSelector onChange={setDateRange} />
          <TrendChart data={trendData} formatValue={trendFormatValue} />
        </Card>

        <Text style={[styles.sectionTitle, { color: theme.text }]}>Rankings</Text>
        {insight ? <Text style={[styles.insight, { color: theme.textSecondary }]}>{insight}</Text> : null}
        <Card style={styles.chartCard}>
          <SegmentedControl options={RANK_OPTIONS} value={rankMetric} onChange={setRankMetric} />
          <RankingChart items={rankItems} formatValue={rankFormatValue} emptyLabel={rankEmptyLabel} />
        </Card>

        <Text style={[styles.sectionTitle, { color: theme.text }]}>Category mix</Text>
        <Card style={styles.chartCard}>
          <CategoryDonutChart items={categorySlices} totalLabel="Units sold" />
        </Card>

        <Text style={[styles.sectionTitle, { color: theme.text }]}>Revenue by category</Text>
        <Card style={styles.chartCard}>
          <CategoryOverTimeChart months={categoryByMonth} />
        </Card>

        <Text style={[styles.sectionTitle, { color: theme.text }]}>Payment mix</Text>
        <Card style={styles.chartCard}>
          <PaymentMixChart items={paymentMix} />
        </Card>

        <Text style={[styles.sectionTitle, { color: theme.text }]}>Inventory alerts</Text>
        {lowStock.length === 0 ? (
          <Text style={[styles.empty, { color: theme.textSecondary }]}>Everything is well stocked.</Text>
        ) : (
          <Card style={styles.list}>
            {lowStock.map((product) => <ProductTile key={product.id} product={product} />)}
          </Card>
        )}

        <Text style={[styles.sectionTitle, { color: theme.text }]}>Recent transactions</Text>
        {recentSales.length === 0 ? (
          <Text style={[styles.empty, { color: theme.textSecondary }]}>No transactions yet.</Text>
        ) : (
          <Card style={styles.list}>
            {recentSales.map((sale) => (
              <View key={sale.id} style={[styles.topRow, { borderBottomColor: theme.border }]}>
                <Text style={[styles.topName, { color: theme.text }]} numberOfLines={1}>{sale.items?.map((item) => item.productName).join(', ')}</Text>
                <Text style={[styles.topMeta, { color: theme.textSecondary }]}>{formatCents(sale.totalCents)}</Text>
              </View>
            ))}
          </Card>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1 },
  content: { padding: 24, paddingBottom: 42 },
  greeting: { fontSize: 26, fontWeight: '800', letterSpacing: -1, marginBottom: 20 },
  metricRow: { flexDirection: 'row', gap: 10, marginBottom: 28 },
  sectionTitle: { fontSize: 15, fontWeight: '800', marginTop: 10, marginBottom: 12 },
  insight: { fontSize: 12.5, marginTop: -8, marginBottom: 10, lineHeight: 17 },
  chartCard: { padding: 16, marginBottom: 8 },
  list: { overflow: 'hidden', marginBottom: 8 },
  topRow: { padding: 13, borderBottomWidth: 1 },
  topName: { fontSize: 13, fontWeight: '700' },
  topMeta: { fontSize: 11, marginTop: 3 },
  empty: { fontSize: 13, marginBottom: 8 },
});
