import { useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Pressable, SafeAreaView, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { ProductTile } from '@/components/product-tile';
import { useAuth } from '@/hooks/use-auth';
import { listProducts } from '@/lib/products';
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

  const filtered = products.filter((p) => p.name.toLowerCase().includes(search.toLowerCase()));

  return (
    <SafeAreaView style={styles.safeArea}>
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <View style={styles.header}>
          <Text style={styles.title}>Inventory</Text>
          <Pressable onPress={() => router.push('/product/new')} style={styles.addButton}>
            <Text style={styles.addButtonText}>+ Add product</Text>
          </Pressable>
        </View>
        <TextInput value={search} onChangeText={setSearch} placeholder="Search products…" placeholderTextColor="#89928B" style={styles.search} />
        {loading ? (
          <Text style={styles.empty}>Loading…</Text>
        ) : filtered.length === 0 ? (
          <Text style={styles.empty}>No products yet. Add your first one above.</Text>
        ) : (
          <View style={styles.list}>
            {filtered.map((product) => (
              <ProductTile key={product.id} product={product} onPress={() => router.push(`/product/${product.id}`)} />
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
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  title: { color: '#17261F', fontSize: 26, fontWeight: '800', letterSpacing: -1 },
  addButton: { backgroundColor: '#17261F', borderRadius: 10, paddingHorizontal: 13, paddingVertical: 10 },
  addButtonText: { color: '#fff', fontWeight: '800', fontSize: 12 },
  search: { backgroundColor: '#fff', borderRadius: 10, height: 43, paddingHorizontal: 13, marginTop: 16, marginBottom: 16, color: '#17261F' },
  list: { backgroundColor: '#fff', borderRadius: 16, overflow: 'hidden', borderWidth: 1, borderColor: '#EFEEE9' },
  empty: { color: '#7B837C', fontSize: 13, marginTop: 20, textAlign: 'center' },
});
