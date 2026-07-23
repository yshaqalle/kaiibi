import { useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Pressable, SafeAreaView, ScrollView, StyleSheet, Text, View } from 'react-native';

import { MetricTile } from '@/components/metric-tile';
import { ProductTile } from '@/components/product-tile';
import { RevenueChart } from '@/components/revenue-chart';
import { useAuth } from '@/hooks/use-auth';
import { signOut } from '@/lib/auth';
import { formatCents } from '@/lib/currency';
import { getLowStockProducts } from '@/lib/products';
import { getDailyTotalsCents, getTopSellingProducts, listSales } from '@/lib/sales';
import type { Product, Sale } from '@/types/models';

export default function DashboardScreen() {
  const router = useRouter();
  const { shop, profile } = useAuth();
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
        <Pressable
          onPress={async () => {
            await signOut();
            router.replace('/signup');
          }}
          style={styles.signOutButton}>
          <Text style={styles.signOutText}>Sign out</Text>
        </Pressable>

        <Text style={styles.greeting}>{shop?.name ?? 'Your shop'}</Text>

        <View style={styles.metricRow}>
          <MetricTile value={formatCents(todayTotalCents)} label="Today's sales" tone="#E6D8C0" />
          <MetricTile value={String(todayOrders)} label="Orders" tone="#D8E6D7" />
          <MetricTile value={String(lowStock.length)} label="Low stock" tone="#F3E9D8" />
        </View>

        <Text style={styles.sectionTitle}>Last 7 days</Text>
        <RevenueChart data={dailyTotals} />

        <Text style={styles.sectionTitle}>Top selling products</Text>
        {topProducts.length === 0 ? (
          <Text style={styles.empty}>No sales yet this week.</Text>
        ) : (
          <View style={styles.list}>
            {topProducts.map((product) => (
              <View key={product.name} style={styles.topRow}>
                <Text style={styles.topName} numberOfLines={1}>{product.name}</Text>
                <Text style={styles.topMeta}>{product.quantitySold} sold · {formatCents(product.revenueCents)}</Text>
              </View>
            ))}
          </View>
        )}

        <Text style={styles.sectionTitle}>Inventory alerts</Text>
        {lowStock.length === 0 ? (
          <Text style={styles.empty}>Everything is well stocked.</Text>
        ) : (
          <View style={styles.list}>
            {lowStock.map((product) => <ProductTile key={product.id} product={product} />)}
          </View>
        )}

        <Text style={styles.sectionTitle}>Recent transactions</Text>
        {recentSales.length === 0 ? (
          <Text style={styles.empty}>No transactions yet.</Text>
        ) : (
          <View style={styles.list}>
            {recentSales.map((sale) => (
              <View key={sale.id} style={styles.topRow}>
                <Text style={styles.topName} numberOfLines={1}>{sale.items?.map((item) => item.productName).join(', ')}</Text>
                <Text style={styles.topMeta}>{formatCents(sale.totalCents)}</Text>
              </View>
            ))}
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: '#FAF9F5' },
  content: { padding: 20, paddingBottom: 42 },
  signOutButton: { alignSelf: 'flex-end', marginBottom: 8 },
  signOutText: { color: '#7B837C', fontSize: 12, fontWeight: '700' },
  greeting: { color: '#17261F', fontSize: 26, fontWeight: '800', letterSpacing: -1, marginBottom: 16 },
  metricRow: { flexDirection: 'row', gap: 8, marginBottom: 26 },
  sectionTitle: { color: '#17261F', fontSize: 16, fontWeight: '800', marginTop: 10, marginBottom: 12 },
  list: { backgroundColor: '#fff', borderRadius: 16, overflow: 'hidden', borderWidth: 1, borderColor: '#EFEEE9', marginBottom: 8 },
  topRow: { padding: 13, borderBottomWidth: 1, borderBottomColor: '#F0EFEB' },
  topName: { color: '#26342D', fontSize: 13, fontWeight: '700' },
  topMeta: { color: '#8A908A', fontSize: 11, marginTop: 3 },
  empty: { color: '#7B837C', fontSize: 13, marginBottom: 8 },
});
