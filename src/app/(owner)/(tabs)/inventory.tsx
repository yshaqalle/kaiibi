import { useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Pressable, SafeAreaView, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { Card } from '@/components/card';
import { ProductTile } from '@/components/product-tile';
import { useAuth } from '@/hooks/use-auth';
import { listProducts, updateProduct } from '@/lib/products';
import type { Product } from '@/types/models';

export default function InventoryScreen() {
  const router = useRouter();
  const { shop } = useAuth();
  const [products, setProducts] = useState<Product[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    if (!shop) return;
    setLoading(true);
    setProducts(await listProducts(shop.id));
    setLoading(false);
  }, [shop]);

  useEffect(() => { reload(); }, [reload]);

  const adjustStock = async (product: Product, nextStock: number) => {
    try {
      const updated = await updateProduct(product.id, { stock: nextStock });
      setProducts((current) => current.map((p) => (p.id === updated.id ? updated : p)));
    } catch {
      await reload();
    }
  };

  const filtered = products.filter((p) => p.name.toLowerCase().includes(search.toLowerCase()) || p.brand?.toLowerCase().includes(search.toLowerCase()) || p.sku?.toLowerCase().includes(search.toLowerCase()));
  const needsAttention = products.filter((p) => p.stock <= (p.reorderLevel ?? 5)).length;

  return (
    <SafeAreaView style={styles.safeArea}>
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <View style={styles.header}>
          <View>
            <Text style={styles.title}>Inventory</Text>
            <Text style={styles.subtitle}>{products.length} products · {needsAttention} need attention</Text>
          </View>
          <Pressable onPress={() => router.push('/product/new')} style={styles.addButton}>
            <Text style={styles.addButtonText}>+ Add product</Text>
          </Pressable>
        </View>
        <TextInput value={search} onChangeText={setSearch} placeholder="Search by name, brand, or SKU" placeholderTextColor="#999999" style={styles.search} />
        {loading ? (
          <Text style={styles.empty}>Loading…</Text>
        ) : filtered.length === 0 ? (
          <Text style={styles.empty}>No products yet. Add your first one above.</Text>
        ) : (
          <Card style={styles.list}>
            {filtered.map((product) => (
              <ProductTile
                key={product.id}
                product={product}
                onEdit={() => router.push(`/product/${product.id}`)}
                onStockChange={(next) => adjustStock(product, next)}
              />
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
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' },
  title: { color: '#111111', fontSize: 24, fontWeight: '800', letterSpacing: -0.5 },
  subtitle: { color: '#999999', fontSize: 12, marginTop: 3 },
  addButton: { backgroundColor: '#111111', borderRadius: 10, paddingHorizontal: 16, paddingVertical: 11 },
  addButtonText: { color: '#FFFFFF', fontWeight: '800', fontSize: 12 },
  search: { backgroundColor: '#F2F2F2', borderRadius: 10, height: 40, paddingHorizontal: 13, marginTop: 18, marginBottom: 18, color: '#111111' },
  list: { overflow: 'hidden' },
  empty: { color: '#999999', fontSize: 13, marginTop: 20, textAlign: 'center' },
});
