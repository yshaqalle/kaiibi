import { useCallback, useEffect, useState } from 'react';
import { Pressable, SafeAreaView, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { QuantityStepper } from '@/components/quantity-stepper';
import { useAuth } from '@/hooks/use-auth';
import { cartTotalCents } from '@/lib/cart';
import { formatCents } from '@/lib/currency';
import { listProducts } from '@/lib/products';
import { completeSale } from '@/lib/sales';
import type { CartLine, PaymentMethod, Product } from '@/types/models';

const paymentMethods: { key: PaymentMethod; label: string }[] = [
  { key: 'cash', label: 'Cash' },
  { key: 'zaad', label: 'ZAAD' },
  { key: 'edahab', label: 'e-Dahab' },
  { key: 'other', label: 'Other' },
];

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

export default function SellScreen() {
  const { shop } = useAuth();
  const [products, setProducts] = useState<Product[]>([]);
  const [search, setSearch] = useState('');
  const [cart, setCart] = useState<CartLine[]>([]);
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>('cash');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!shop) return;
    setProducts(await listProducts(shop.id));
  }, [shop]);

  useEffect(() => { reload(); }, [reload]);

  const filtered = products.filter((p) => p.name.toLowerCase().includes(search.toLowerCase()));

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
    if (!shop || cart.length === 0) return;
    setSubmitting(true);
    setError(null);
    try {
      await completeSale(shop.id, cart, paymentMethod);
      setCart([]);
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
          <TextInput value={search} onChangeText={setSearch} placeholder="Search products…" placeholderTextColor="#89928B" style={styles.search} />
          <ScrollView contentContainerStyle={styles.grid}>
            {filtered.map((product) => (
              <Pressable key={product.id} onPress={() => addToCart(product)} disabled={product.stock <= 0} style={[styles.gridTile, product.stock <= 0 && styles.gridTileDisabled]}>
                <Text style={styles.gridName} numberOfLines={2}>{product.name}</Text>
                <Text style={styles.gridPrice}>{formatCents(product.priceCents)}</Text>
                <Text style={styles.gridStock}>{product.stock <= 0 ? 'Out of stock' : `${product.stock} in stock`}</Text>
              </Pressable>
            ))}
          </ScrollView>
        </View>
        <View style={styles.cartPane}>
          <Text style={styles.cartTitle}>Cart</Text>
          <ScrollView style={styles.cartList}>
            {cart.length === 0 ? (
              <Text style={styles.empty}>Tap a product to add it.</Text>
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
          <View style={styles.paymentRow}>
            {paymentMethods.map((method) => (
              <Pressable key={method.key} onPress={() => setPaymentMethod(method.key)} style={[styles.paymentChip, paymentMethod === method.key && styles.paymentChipActive]}>
                <Text style={[styles.paymentChipText, paymentMethod === method.key && styles.paymentChipTextActive]}>{method.label}</Text>
              </Pressable>
            ))}
          </View>
          {error && <Text style={styles.error}>{error}</Text>}
          <Pressable onPress={checkout} disabled={cart.length === 0 || submitting} style={[styles.checkout, (cart.length === 0 || submitting) && styles.checkoutDisabled]}>
            <Text style={styles.checkoutText}>{submitting ? 'Completing…' : 'Checkout'}</Text>
          </Pressable>
        </View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: '#FAF9F5' },
  split: { flex: 1, flexDirection: 'row' },
  browsePane: { flex: 2, padding: 16 },
  search: { backgroundColor: '#fff', borderRadius: 10, height: 43, paddingHorizontal: 13, marginBottom: 14, color: '#17261F' },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  gridTile: { width: 140, backgroundColor: '#fff', borderRadius: 12, padding: 12, borderWidth: 1, borderColor: '#EFEEE9' },
  gridTileDisabled: { opacity: 0.4 },
  gridName: { color: '#17261F', fontSize: 12, fontWeight: '700', minHeight: 32 },
  gridPrice: { color: '#E45B37', fontSize: 13, fontWeight: '800', marginTop: 6 },
  gridStock: { color: '#7B837C', fontSize: 10, marginTop: 3 },
  cartPane: { flex: 1, backgroundColor: '#EEF2EB', padding: 16, minWidth: 260 },
  cartTitle: { color: '#17261F', fontSize: 18, fontWeight: '800', marginBottom: 10 },
  cartList: { flex: 1 },
  empty: { color: '#7B837C', fontSize: 12, marginTop: 20, textAlign: 'center' },
  cartLine: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#fff', borderRadius: 10, padding: 10, marginBottom: 8 },
  cartLineName: { color: '#17261F', fontSize: 12, fontWeight: '700' },
  cartLinePrice: { color: '#7B837C', fontSize: 11, marginTop: 2 },
  totalRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 12, borderTopWidth: 1, borderTopColor: '#DCE2D9', marginTop: 8 },
  totalLabel: { color: '#17261F', fontSize: 14, fontWeight: '800' },
  totalValue: { color: '#17261F', fontSize: 18, fontWeight: '800' },
  paymentRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 12 },
  paymentChip: { backgroundColor: '#fff', paddingVertical: 8, paddingHorizontal: 12, borderRadius: 16, borderWidth: 1, borderColor: '#D9E0D6' },
  paymentChipActive: { backgroundColor: '#31533A', borderColor: '#31533A' },
  paymentChipText: { fontSize: 11, fontWeight: '700', color: '#546158' },
  paymentChipTextActive: { color: '#FFFFFF' },
  error: { color: '#C0392B', fontSize: 12, fontWeight: '700', marginBottom: 8 },
  checkout: { backgroundColor: '#E45B37', height: 46, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  checkoutDisabled: { backgroundColor: '#C8CCC6' },
  checkoutText: { color: '#fff', fontWeight: '800', fontSize: 14 },
});
