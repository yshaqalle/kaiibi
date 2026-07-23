import { useCallback, useEffect, useState } from 'react';
import { SafeAreaView, ScrollView, StyleSheet, Text, View } from 'react-native';

import { Card } from '@/components/card';
import { ProductTile } from '@/components/product-tile';
import { RevenueChart } from '@/components/revenue-chart';
import { StatTile } from '@/components/stat-tile';
import { useAuth } from '@/hooks/use-auth';
import { formatCents } from '@/lib/currency';
import { getLowStockProducts } from '@/lib/products';
import { getDailyTotalsCents, getTopSellingProducts, listSales } from '@/lib/sales';
import type { Product, Sale } from '@/types/models';

export default function DashboardScreen() {
  const { shop } = useAuth();
  const [recentSales, setRecentSales] = useState<Sale[]>([]);
  const [topProducts, setTopProducts] = useState<{ name: string; quantitySold: number; revenueCents: number }[]>([]);
  const [lowStock, setLowStock] = useState<Product[]>([]);
  const [dailyTotals, setDailyTotals] = useState<{ day: string; totalCents: number; orderCount: number }[]>([]);

  const reload = useCallback(async () => {
    if (!shop) return;
    const [sales, top, low, daily] = await Promise.all([
      listSales(shop.id, 5),
      getTopSellingProducts(shop.id),
      getLowStockProducts(shop.id),
      getDailyTotalsCents(shop.id),
    ]);
    setRecentSales(sales);
    setTopProducts(top);
    setLowStock(low);
    setDailyTotals(daily);
  }, [shop]);

  useEffect(() => { reload(); }, [reload]);

  const todayTotalCents = dailyTotals.at(-1)?.totalCents ?? 0;
  const todayOrders = dailyTotals.at(-1)?.orderCount ?? 0;

  return (
    <SafeAreaView style={styles.safeArea}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.greeting}>{shop?.name ?? 'Your shop'}</Text>

        <View style={styles.metricRow}>
          <StatTile value={formatCents(todayTotalCents)} label="Today's sales" />
          <StatTile value={String(todayOrders)} label="Orders" />
          <StatTile value={String(lowStock.length)} label="Low stock" />
        </View>

        <Text style={styles.sectionTitle}>Last 7 days</Text>
        <Card style={styles.chartCard}><RevenueChart data={dailyTotals} /></Card>

        <Text style={styles.sectionTitle}>Top selling products</Text>
        {topProducts.length === 0 ? (
          <Text style={styles.empty}>No sales yet this week.</Text>
        ) : (
          <Card style={styles.list}>
            {topProducts.map((product) => (
              <View key={product.name} style={styles.topRow}>
                <Text style={styles.topName} numberOfLines={1}>{product.name}</Text>
                <Text style={styles.topMeta}>{product.quantitySold} sold · {formatCents(product.revenueCents)}</Text>
              </View>
            ))}
          </Card>
        )}

        <Text style={styles.sectionTitle}>Inventory alerts</Text>
        {lowStock.length === 0 ? (
          <Text style={styles.empty}>Everything is well stocked.</Text>
        ) : (
          <Card style={styles.list}>
            {lowStock.map((product) => <ProductTile key={product.id} product={product} />)}
          </Card>
        )}

        <Text style={styles.sectionTitle}>Recent transactions</Text>
        {recentSales.length === 0 ? (
          <Text style={styles.empty}>No transactions yet.</Text>
        ) : (
          <Card style={styles.list}>
            {recentSales.map((sale) => (
              <View key={sale.id} style={styles.topRow}>
                <Text style={styles.topName} numberOfLines={1}>{sale.items?.map((item) => item.productName).join(', ')}</Text>
                <Text style={styles.topMeta}>{formatCents(sale.totalCents)}</Text>
              </View>
            ))}
          </Card>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: '#FFFFFF' },
  content: { padding: 24, paddingBottom: 42 },
  greeting: { color: '#111111', fontSize: 26, fontWeight: '800', letterSpacing: -1, marginBottom: 20 },
  metricRow: { flexDirection: 'row', gap: 10, marginBottom: 28 },
  sectionTitle: { color: '#111111', fontSize: 15, fontWeight: '800', marginTop: 10, marginBottom: 12 },
  chartCard: { padding: 16, marginBottom: 8 },
  list: { overflow: 'hidden', marginBottom: 8 },
  topRow: { padding: 13, borderBottomWidth: 1, borderBottomColor: '#ECECEC' },
  topName: { color: '#111111', fontSize: 13, fontWeight: '700' },
  topMeta: { color: '#999999', fontSize: 11, marginTop: 3 },
  empty: { color: '#999999', fontSize: 13, marginBottom: 8 },
});
