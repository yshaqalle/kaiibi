import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

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
import { sharePdf } from '@/lib/export-file';
import { methodLabel } from '@/lib/payment-methods';
import { getExpiringProducts, getLowStockProducts } from '@/lib/products';
import { buildDashboardReportHtml, type ReportSection, type ReportStat } from '@/lib/report-pdf';
import type { DailyBucket } from '@/lib/sales-reporting';
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

type DashboardSection = 'trends' | 'breakdown' | 'activity';

const SECTION_OPTIONS: { key: DashboardSection; label: string }[] = [
  { key: 'trends', label: 'Trends' },
  { key: 'breakdown', label: 'Breakdown' },
  { key: 'activity', label: 'Activity' },
];

// Pinned to the light palette for now — no dark-mode switching yet.
const theme = Colors.light;

export default function DashboardScreen() {
  const { shop } = useAuth();

  const [dateRange, setDateRange] = useState<DateRange | null>(null);
  const [trendMetric, setTrendMetric] = useState<TrendMetric>('revenue');
  const [rankMetric, setRankMetric] = useState<RankMetric>('products');
  const [section, setSection] = useState<DashboardSection>('trends');

  const [recentSales, setRecentSales] = useState<Sale[]>([]);
  const [dailyMetrics, setDailyMetrics] = useState<DailyBucket[]>([]);
  const [topProducts, setTopProducts] = useState<{
    byRevenue: { name: string; quantitySold: number; revenueCents: number }[];
    byUnits: { name: string; quantitySold: number; revenueCents: number }[];
  }>({ byRevenue: [], byUnits: [] });
  const [cashierPerformance, setCashierPerformance] = useState<{ name: string; revenueCents: number }[]>([]);
  const [paymentMix, setPaymentMix] = useState<PaymentMixItem[]>([]);
  const [lowStock, setLowStock] = useState<Product[]>([]);
  const [expiringSoon, setExpiringSoon] = useState<Product[]>([]);
  const [categoryBreakdown, setCategoryBreakdown] = useState<{ category: string; unitsSold: number; revenueCents: number }[]>([]);
  const [categoryByMonth, setCategoryByMonth] = useState<MonthlyCategoryBucket[]>([]);
  const [monthToDateCents, setMonthToDateCents] = useState(0);

  const reload = useCallback(async () => {
    if (!shop || !dateRange) return;
    const { since, until } = dateRange;
    const [sales, daily, top, cashiers, mix, low, expiring, categories, categoriesByMonth] = await Promise.all([
      listSales(shop.id, 5),
      getDailyTotalsCents(shop.id, since, until),
      getTopSellingProducts(shop.id, since, until),
      getCashierPerformance(shop.id, since, until),
      getPaymentMethodMix(shop.id, since, until),
      getLowStockProducts(shop.id, shop.defaultLowStockLevel),
      shop.expiryTrackingEnabled ? getExpiringProducts(shop.id, shop.expiryWarningLeadDays) : Promise.resolve([]),
      getCategoryBreakdown(shop.id, since, until),
      getCategoryRevenueByMonth(shop.id, since, until),
    ]);
    setRecentSales(sales);
    setDailyMetrics(daily);
    setTopProducts(top);
    setCashierPerformance(cashiers);
    setPaymentMix(mix);
    setLowStock(low);
    setExpiringSoon(expiring);
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
  // Net of sales tax and refunds -- tax collected belongs to the government,
  // not the shop, so it was never revenue. This reads lower than the old
  // figure for tax-enabled shops; that's the correction, not a regression.
  const todayTotalCents = today?.netRevenueCents ?? 0;
  const todayOrders = today?.orderCount ?? 0;
  // `today` is really just the range's last bucket -- for the default preset
  // ranges that's always today, but a custom range (RangeSelector.applyCustom)
  // can end on any past date, and the tile below would otherwise caption a
  // historical day "Today's sales".
  const latestSalesLabel = today && today.day !== new Date().toDateString()
    ? `${new Date(today.day).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} sales`
    : "Today's sales";

  const salesDelta = useMemo(() => {
    if (!yesterday || yesterday.netRevenueCents <= 0) return undefined;
    const pct = Math.round(((todayTotalCents - yesterday.netRevenueCents) / yesterday.netRevenueCents) * 100);
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
        value: trendMetric === 'revenue' ? d.netRevenueCents : trendMetric === 'orders' ? d.orderCount : d.discountCents,
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

  const [exportingPdf, setExportingPdf] = useState(false);
  const exportReport = async () => {
    if (!shop || !dateRange) return;
    setExportingPdf(true);
    try {
      const rangeLabel = `${dateRange.since.toLocaleDateString()} – ${dateRange.until ? dateRange.until.toLocaleDateString() : 'today'}`;
      const stats: ReportStat[] = [
        { label: latestSalesLabel, value: formatCents(todayTotalCents) },
        { label: 'Orders', value: String(todayOrders) },
        { label: 'Low stock', value: String(lowStock.length) },
        { label: 'Month to date', value: formatCents(monthToDateCents) },
      ];
      const sections: ReportSection[] = [
        {
          title: 'Top products by revenue',
          columns: [
            { header: 'Product', value: (p: { name: string }) => p.name },
            { header: 'Units sold', value: (p: { quantitySold: number }) => String(p.quantitySold) },
            { header: 'Revenue', value: (p: { revenueCents: number }) => formatCents(p.revenueCents) },
          ],
          rows: topProducts.byRevenue,
        },
        {
          title: 'Cashier performance',
          columns: [
            { header: 'Cashier', value: (c: { name: string }) => c.name },
            { header: 'Revenue', value: (c: { revenueCents: number }) => formatCents(c.revenueCents) },
          ],
          rows: cashierPerformance,
        },
        {
          title: 'Payment mix',
          columns: [
            { header: 'Method', value: (p: PaymentMixItem) => methodLabel(p.method) },
            { header: 'Share', value: (p: PaymentMixItem) => `${Math.round(p.pct)}%` },
            { header: 'Amount', value: (p: PaymentMixItem) => formatCents(p.amountCents) },
          ],
          rows: paymentMix,
        },
        {
          title: 'Category breakdown',
          columns: [
            { header: 'Category', value: (c: { category: string }) => c.category },
            { header: 'Units sold', value: (c: { unitsSold: number }) => String(c.unitsSold) },
            { header: 'Revenue', value: (c: { revenueCents: number }) => formatCents(c.revenueCents) },
          ],
          rows: categoryBreakdown,
        },
        {
          title: 'Low stock',
          columns: [
            { header: 'Product', value: (p: Product) => p.name },
            { header: 'Stock', value: (p: Product) => String(p.stock) },
            { header: 'Reorder level', value: (p: Product) => String(p.reorderLevel ?? shop.defaultLowStockLevel) },
          ],
          rows: lowStock,
        },
        ...(shop.expiryTrackingEnabled
          ? [{
              title: 'Expiring soon',
              columns: [
                { header: 'Product', value: (p: Product) => p.name },
                { header: 'Expiry date', value: (p: Product) => p.expiryDate ?? '' },
              ],
              rows: expiringSoon,
            }]
          : []),
      ];
      await sharePdf(
        buildDashboardReportHtml({ title: `${shop.name} — Dashboard report`, subtitle: rangeLabel, stats, sections }),
        `${shop.name} dashboard report`
      );
    } finally {
      setExportingPdf(false);
    }
  };

  return (
    <SafeAreaView edges={['left', 'right', 'bottom']} style={[styles.safeArea, { backgroundColor: theme.surface }]}>
      <View style={styles.headerFixed}>
        <View style={styles.greetingRow}>
          <Text style={[styles.greeting, { color: theme.text }]}>Dashboard</Text>
          <Pressable onPress={exportReport} disabled={exportingPdf || !dateRange} style={styles.exportButton}>
            {exportingPdf ? <ActivityIndicator size="small" color="#FFFFFF" /> : <Text style={styles.exportButtonText}>Export PDF</Text>}
          </Pressable>
        </View>
        <View style={[styles.headerDivider, { backgroundColor: theme.border }]} />

        <View style={styles.metricRow}>
          <StatTile value={formatCents(todayTotalCents)} label={latestSalesLabel} delta={salesDelta} sparkline={dailyMetrics.map((d) => d.netRevenueCents)} />
          <StatTile value={String(todayOrders)} label="Orders" delta={ordersDelta} />
          <StatTile value={String(lowStock.length)} label="Low stock" tone={lowStock.length > 0 ? 'warning' : 'default'} />
        </View>

        <RangeSelector onChange={setDateRange} />

        {shop?.monthlyRevenueGoalCents ? (
          <>
            <Text style={[styles.sectionTitle, { color: theme.text }]}>Revenue goal this month</Text>
            <Card style={styles.chartCard}>
              <GoalMeter valueCents={monthToDateCents} goalCents={shop.monthlyRevenueGoalCents} />
            </Card>
          </>
        ) : null}
      </View>

      <View style={styles.sectionNav}>
        <SegmentedControl options={SECTION_OPTIONS} value={section} onChange={setSection} />
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        {section === 'trends' && (
          <TrendsSection
            trendMetric={trendMetric}
            onTrendMetricChange={setTrendMetric}
            trendData={trendData}
            trendFormatValue={trendFormatValue}
            rankMetric={rankMetric}
            onRankMetricChange={setRankMetric}
            insight={insight}
            rankItems={rankItems}
            rankFormatValue={rankFormatValue}
            rankEmptyLabel={rankEmptyLabel}
          />
        )}
        {section === 'breakdown' && (
          <BreakdownSection categorySlices={categorySlices} categoryByMonth={categoryByMonth} paymentMix={paymentMix} />
        )}
        {section === 'activity' && <ActivitySection lowStock={lowStock} expiringSoon={expiringSoon} recentSales={recentSales} />}
      </ScrollView>
    </SafeAreaView>
  );
}

type TrendsSectionProps = {
  trendMetric: TrendMetric;
  onTrendMetricChange: (metric: TrendMetric) => void;
  trendData: TrendPoint[];
  trendFormatValue: (value: number) => string;
  rankMetric: RankMetric;
  onRankMetricChange: (metric: RankMetric) => void;
  insight: string | null;
  rankItems: RankingItem[];
  rankFormatValue: (value: number) => string;
  rankEmptyLabel: string;
};

function TrendsSection({
  trendMetric,
  onTrendMetricChange,
  trendData,
  trendFormatValue,
  rankMetric,
  onRankMetricChange,
  insight,
  rankItems,
  rankFormatValue,
  rankEmptyLabel,
}: TrendsSectionProps) {
  return (
    <>
      <Text style={[styles.sectionTitle, { color: theme.text }]}>Overview</Text>
      <Card style={styles.chartCard}>
        <SegmentedControl options={TREND_OPTIONS} value={trendMetric} onChange={onTrendMetricChange} />
        <TrendChart data={trendData} formatValue={trendFormatValue} />
      </Card>

      <Text style={[styles.sectionTitle, { color: theme.text }]}>Rankings</Text>
      {insight ? <Text style={[styles.insight, { color: theme.textSecondary }]}>{insight}</Text> : null}
      <Card style={styles.chartCard}>
        <SegmentedControl options={RANK_OPTIONS} value={rankMetric} onChange={onRankMetricChange} />
        <RankingChart items={rankItems} formatValue={rankFormatValue} emptyLabel={rankEmptyLabel} />
      </Card>
    </>
  );
}

type BreakdownSectionProps = {
  categorySlices: CategorySlice[];
  categoryByMonth: MonthlyCategoryBucket[];
  paymentMix: PaymentMixItem[];
};

function BreakdownSection({ categorySlices, categoryByMonth, paymentMix }: BreakdownSectionProps) {
  return (
    <>
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
    </>
  );
}

type ActivitySectionProps = {
  lowStock: Product[];
  expiringSoon: Product[];
  recentSales: Sale[];
};

function ActivitySection({ lowStock, expiringSoon, recentSales }: ActivitySectionProps) {
  return (
    <>
      <Text style={[styles.sectionTitle, { color: theme.text }]}>Inventory alerts</Text>
      {lowStock.length === 0 ? (
        <Text style={[styles.empty, { color: theme.textSecondary }]}>Everything is well stocked.</Text>
      ) : (
        <Card style={styles.list}>
          {lowStock.map((product) => <ProductTile key={product.id} product={product} />)}
        </Card>
      )}

      {expiringSoon.length > 0 && (
        <>
          <Text style={[styles.sectionTitle, { color: theme.text }]}>Expiring soon</Text>
          <Card style={styles.list}>
            {expiringSoon.map((product) => <ProductTile key={product.id} product={product} />)}
          </Card>
        </>
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
    </>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1 },
  headerFixed: { paddingHorizontal: 24, paddingTop: 24 },
  sectionNav: { paddingHorizontal: 24, paddingTop: 16 },
  content: { padding: 24, paddingBottom: 42 },
  greetingRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 },
  greeting: { fontSize: 26, fontWeight: '800', letterSpacing: -1 },
  exportButton: { backgroundColor: '#111111', borderRadius: 10, paddingHorizontal: 12, paddingVertical: 9, alignItems: 'center' },
  exportButtonText: { color: '#FFFFFF', fontWeight: '800', fontSize: 11 },
  headerDivider: { height: 1, marginBottom: 20 },
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
