import { useCallback, useEffect, useState } from 'react';
import { SafeAreaView, ScrollView, StyleSheet, Text, View } from 'react-native';

import { Card } from '@/components/card';
import { StatTile } from '@/components/stat-tile';
import { useAuth } from '@/hooks/use-auth';
import { formatCents } from '@/lib/currency';
import { listSales } from '@/lib/sales';
import type { Sale } from '@/types/models';

const paymentLabels: Record<Sale['paymentMethod'], string> = { cash: 'Cash', zaad: 'ZAAD', edahab: 'e-Dahab', other: 'Other' };

export default function SalesScreen() {
  const { shop } = useAuth();
  const [sales, setSales] = useState<Sale[]>([]);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    if (!shop) return;
    setLoading(true);
    setSales(await listSales(shop.id));
    setLoading(false);
  }, [shop]);

  useEffect(() => { reload(); }, [reload]);

  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
  const todaySales = sales.filter((sale) => new Date(sale.createdAt) >= todayStart);
  const todayTotalCents = todaySales.reduce((sum, sale) => sum + sale.totalCents, 0);

  return (
    <SafeAreaView style={styles.safeArea}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.title}>Sales</Text>
        <View style={styles.metricRow}>
          <StatTile value={formatCents(todayTotalCents)} label="Sales today" />
          <StatTile value={String(todaySales.length)} label="Orders today" />
        </View>
        {loading ? (
          <Text style={styles.empty}>Loading…</Text>
        ) : sales.length === 0 ? (
          <Text style={styles.empty}>No sales yet.</Text>
        ) : (
          <Card style={styles.list}>
            {sales.map((sale) => (
              <View key={sale.id} style={styles.saleRow}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.saleItems} numberOfLines={1}>{sale.items?.map((item) => `${item.quantity}× ${item.productName}`).join(', ')}</Text>
                  <Text style={styles.saleMeta}>{new Date(sale.createdAt).toLocaleString()} · {paymentLabels[sale.paymentMethod]}</Text>
                </View>
                <Text style={styles.saleTotal}>{formatCents(sale.totalCents)}</Text>
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
  title: { color: '#111111', fontSize: 26, fontWeight: '800', letterSpacing: -1, marginBottom: 20 },
  metricRow: { flexDirection: 'row', gap: 10, marginBottom: 26 },
  list: { overflow: 'hidden' },
  saleRow: { flexDirection: 'row', alignItems: 'center', padding: 13, borderBottomWidth: 1, borderBottomColor: '#F4F4F4' },
  saleItems: { color: '#111111', fontSize: 13, fontWeight: '700' },
  saleMeta: { color: '#999999', fontSize: 11, marginTop: 3 },
  saleTotal: { color: '#111111', fontSize: 14, fontWeight: '800' },
  empty: { color: '#999999', fontSize: 13, marginTop: 20, textAlign: 'center' },
});
