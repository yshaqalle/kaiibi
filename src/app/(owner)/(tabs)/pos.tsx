import { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, SafeAreaView, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { CategoryChip } from '@/components/category-chip';
import { PaymentMethodPicker } from '@/components/payment-method-picker';
import { QuantityStepper } from '@/components/quantity-stepper';
import { useAuth } from '@/hooks/use-auth';
import { cartTotalCents } from '@/lib/cart';
import { formatCents } from '@/lib/currency';
import { deriveCategories } from '@/lib/product-taxonomy';
import { listProducts } from '@/lib/products';
import { completeSale } from '@/lib/sales';
import type { CartLine, PaymentMethod, Product } from '@/types/models';

// Real `Error` instances have `.message`, but Supabase's `rpc()`/query errors
// (e.g. PostgrestError from the complete_sale RPC — "insufficient stock for
// X: has 7, need 100") are plain `{code, details, hint, message}` objects
// that are never `instanceof Error`. Check for a string `.message` on either
// shape so the owner sees the RPC's actual reason instead of a generic one.
function extractErrorMessage(err: unknown): string {
  if (err && typeof err === 'object' && 'message' in err && typeof (err as { message: unknown }).message === 'string') {
    return (err as { message: string }).message;
  }
  return 'Could not complete this sale.';
}

export default function PosScreen() {
  const { shop } = useAuth();
  const [products, setProducts] = useState<Product[]>([]);
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState<string | null>(null);
  const [cart, setCart] = useState<CartLine[]>([]);
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!shop) return;
    setProducts(await listProducts(shop.id));
  }, [shop]);

  useEffect(() => { reload(); }, [reload]);

  const categories = useMemo(() => deriveCategories(products), [products]);

  const filtered = products.filter((p) =>
    p.name.toLowerCase().includes(search.toLowerCase()) &&
    (category === null || p.category === category)
  );

  const addToCart = (product: Product) => {
    setCart((current) => {
      const existing = current.find((line) => line.product.id === product.id);
      if (existing) return current.map((line) => (line.product.id === product.id ? { ...line, quantity: line.quantity + 1 } : line));
      return [...current, { product, quantity: 1 }];
    });
  };

  const setQuantity = (productId: string, quantity: number) => {
    setCart((current) => (quantity === 0 ? current.filter((line) => line.product.id !== productId) : current.map((line) => (line.product.id === productId ? { ...line, quantity } : line))));
  };

  const total = cartTotalCents(cart);

  const checkout = async () => {
    if (!shop || cart.length === 0 || !paymentMethod) return;
    setSubmitting(true);
    setError(null);
    try {
      await completeSale(shop.id, cart, paymentMethod);
      setCart([]);
      setPaymentMethod(null);
      await reload();
    } catch (err) {
      setError(extractErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.split}>
        <View style={styles.browsePane}>
          <TextInput value={search} onChangeText={setSearch} placeholder="Search products or brands" placeholderTextColor="#999999" style={styles.search} />
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.categoryRow}>
            <CategoryChip label="All" active={category === null} onPress={() => setCategory(null)} />
            {categories.map((item) => (
              <CategoryChip key={item} label={item} active={category === item} onPress={() => setCategory(item)} />
            ))}
          </ScrollView>
          <ScrollView contentContainerStyle={styles.grid}>
            {filtered.map((product) => (
              <Pressable key={product.id} onPress={() => addToCart(product)} disabled={product.stock <= 0} style={[styles.gridTile, product.stock <= 0 && styles.gridTileDisabled]}>
                {product.brand && <Text style={styles.gridBrand}>{product.brand.toUpperCase()}</Text>}
                <Text style={styles.gridName} numberOfLines={2}>{product.name}</Text>
                <View style={styles.gridFooter}>
                  <Text style={styles.gridPrice}>{formatCents(product.priceCents)}</Text>
                  {product.stock <= 0 ? (
                    <Text style={styles.outOfStockPill}>Out of stock</Text>
                  ) : product.stock <= (product.reorderLevel ?? 5) ? (
                    <Text style={styles.lowStockPill}>⚠ Low stock</Text>
                  ) : (
                    <Text style={styles.gridStock}>{product.stock} in stock</Text>
                  )}
                </View>
              </Pressable>
            ))}
          </ScrollView>
        </View>
        <View style={styles.cartPane}>
          <Text style={styles.cartTitle}>Current sale</Text>
          <ScrollView style={styles.cartList}>
            {cart.length === 0 ? (
              <Text style={styles.empty}>Cart is empty.{'\n'}Tap a product to add it.</Text>
            ) : (
              cart.map((line) => (
                <View key={line.product.id} style={styles.cartLine}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.cartLineName}>{line.product.name}</Text>
                    <Text style={styles.cartLinePrice}>{formatCents(line.product.priceCents)}</Text>
                  </View>
                  <QuantityStepper quantity={line.quantity} onChange={(next) => setQuantity(line.product.id, next)} />
                </View>
              ))
            )}
          </ScrollView>
          <View style={styles.totalRow}>
            <Text style={styles.totalLabel}>Total</Text>
            <Text style={styles.totalValue}>{formatCents(total)}</Text>
          </View>
          <PaymentMethodPicker value={paymentMethod} onChange={setPaymentMethod} />
          {error && <Text style={styles.error}>{error}</Text>}
          <Pressable onPress={checkout} disabled={cart.length === 0 || !paymentMethod || submitting} style={[styles.checkout, (cart.length === 0 || !paymentMethod || submitting) && styles.checkoutDisabled]}>
            <Text style={styles.checkoutText}>{submitting ? 'Completing…' : 'Complete sale'}</Text>
          </Pressable>
        </View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: '#FFFFFF' },
  split: { flex: 1, flexDirection: 'row' },
  browsePane: { flex: 2, padding: 18 },
  search: { backgroundColor: '#F2F2F2', borderRadius: 10, height: 42, paddingHorizontal: 14, marginBottom: 14, color: '#111111' },
  categoryRow: { gap: 8, paddingBottom: 16 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  gridTile: { width: 160, backgroundColor: '#FFFFFF', borderRadius: 12, padding: 12, borderWidth: 1, borderColor: '#EDEDED' },
  gridTileDisabled: { opacity: 0.4 },
  gridBrand: { color: '#999999', fontSize: 9, fontWeight: '700', letterSpacing: 0.4 },
  gridName: { color: '#111111', fontSize: 12, fontWeight: '700', minHeight: 32, marginTop: 2 },
  gridFooter: { marginTop: 10, gap: 4 },
  gridPrice: { color: '#111111', fontSize: 14, fontWeight: '800' },
  gridStock: { color: '#999999', fontSize: 10 },
  lowStockPill: { fontSize: 9, fontWeight: '700', color: '#B5793A', borderWidth: 1, borderColor: '#E8C99B', paddingVertical: 3, paddingHorizontal: 7, borderRadius: 9, alignSelf: 'flex-start' },
  outOfStockPill: { fontSize: 9, fontWeight: '700', color: '#FFFFFF', backgroundColor: '#111111', paddingVertical: 3, paddingHorizontal: 7, borderRadius: 9, alignSelf: 'flex-start' },
  cartPane: { flex: 1, backgroundColor: '#FFFFFF', borderLeftWidth: 1, borderLeftColor: '#ECECEC', padding: 18, minWidth: 280 },
  cartTitle: { color: '#111111', fontSize: 18, fontWeight: '800', marginBottom: 12 },
  cartList: { flex: 1 },
  empty: { color: '#BBBBBB', fontSize: 12, marginTop: 40, textAlign: 'center' },
  cartLine: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#FAFAFA', borderRadius: 10, padding: 10, marginBottom: 7 },
  cartLineName: { color: '#111111', fontSize: 12, fontWeight: '700' },
  cartLinePrice: { color: '#999999', fontSize: 11, marginTop: 2 },
  totalRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', paddingVertical: 12, borderTopWidth: 1, borderTopColor: '#ECECEC', marginTop: 8 },
  totalLabel: { color: '#111111', fontSize: 14, fontWeight: '800' },
  totalValue: { color: '#111111', fontSize: 22, fontWeight: '800' },
  error: { color: '#C0392B', fontSize: 12, fontWeight: '700', marginTop: 8 },
  checkout: { backgroundColor: '#111111', height: 48, borderRadius: 10, alignItems: 'center', justifyContent: 'center', marginTop: 16 },
  checkoutDisabled: { backgroundColor: '#CCCCCC' },
  checkoutText: { color: '#FFFFFF', fontWeight: '800', fontSize: 14 },
});
