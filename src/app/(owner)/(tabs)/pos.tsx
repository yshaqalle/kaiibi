import { Image } from 'expo-image';
import { useCallback, useEffect, useState } from 'react';
import { Pressable, SafeAreaView, ScrollView, StyleSheet, Text, TextInput, View, useWindowDimensions } from 'react-native';

import { CategoryChip } from '@/components/category-chip';
import { PaymentMethodPicker } from '@/components/payment-method-picker';
import { QuantityStepper } from '@/components/quantity-stepper';
import { useAuth } from '@/hooks/use-auth';
import { listCategories } from '@/lib/categories';
import { cartTotalCents } from '@/lib/cart';
import { formatCents } from '@/lib/currency';
import { listProducts } from '@/lib/products';
import { completeSale } from '@/lib/sales';
import type { CartLine, PaymentLine, Product } from '@/types/models';

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
  const { width } = useWindowDimensions();
  const compact = width < 820;
  const [products, setProducts] = useState<Product[]>([]);
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState<string | null>(null);
  const [cart, setCart] = useState<CartLine[]>([]);
  const [payments, setPayments] = useState<PaymentLine[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [categories, setCategories] = useState<string[]>([]);
  const [customerOpen, setCustomerOpen] = useState(false);
  const [customerName, setCustomerName] = useState('');
  const [customerPhone, setCustomerPhone] = useState('');
  const [customerEmail, setCustomerEmail] = useState('');

  const reload = useCallback(async () => {
    if (!shop) return;
    setProducts(await listProducts(shop.id));
  }, [shop]);

  useEffect(() => { reload(); }, [reload]);
  useEffect(() => { if (shop) listCategories(shop.id).then((rows) => setCategories(rows.map((r) => r.name))).catch(() => {}); }, [shop]);

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
  const paidCents = payments.reduce((sum, p) => sum + p.amountCents, 0);
  const fullyPaid = payments.length > 0 && paidCents === total;

  // Any cart change invalidates whatever's already been entered in the
  // payment picker (the amounts no longer sum to the new total), so clear
  // it rather than let a stale split silently under/over-cover the sale.
  useEffect(() => { setPayments([]); }, [total]);

  const checkout = async () => {
    if (!shop || cart.length === 0 || !fullyPaid) return;
    setSubmitting(true);
    setError(null);
    try {
      await completeSale(shop.id, cart, payments, {
        name: customerName.trim() || null,
        phone: customerPhone.trim() || null,
        email: customerEmail.trim() || null,
      });
      setCart([]);
      setPayments([]);
      setCustomerName('');
      setCustomerPhone('');
      setCustomerEmail('');
      setCustomerOpen(false);
      await reload();
    } catch (err) {
      setError(extractErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  // On desktop, browse + cart are independently-scrolling side-by-side
  // panes, each owning its own `ScrollView` for its category row / grid /
  // cart list. On mobile there's no room for two panes side by side, so the
  // whole screen becomes one vertical scroller instead — and nesting a nested
  // `ScrollView` inside that (even with `scrollEnabled={false}`) fights React
  // Native's own default flex sizing for `ScrollView` (it wants to flex/grow
  // along whichever axis its container scrolls) in ways that are very hard to
  // fully override, producing zero-height or overflowing panes. Swapping to
  // plain `View`s for those inner containers on mobile sidesteps that
  // entirely — they just flow with the outer page scroll like normal content.
  const Split = compact ? ScrollView : View;
  const splitProps = compact ? { contentContainerStyle: styles.splitCompactContent } : {};
  const CategoryList = compact ? View : ScrollView;
  const categoryListProps = compact
    ? { style: styles.categoryRowCompact }
    : { horizontal: true, showsHorizontalScrollIndicator: false, style: styles.categoryScroll, contentContainerStyle: styles.categoryRow };
  const GridList = compact ? View : ScrollView;
  const gridListProps = compact ? { style: styles.grid } : { contentContainerStyle: styles.grid };
  const CartList = compact ? View : ScrollView;
  const cartListProps = compact ? { style: styles.cartListCompact } : { style: styles.cartList };

  return (
    <SafeAreaView style={styles.safeArea}>
      <Split style={[styles.split, compact && styles.splitCompact]} {...splitProps}>
        <View style={[styles.browsePane, compact && styles.browsePaneCompact]}>
          <View style={styles.searchWrap}>
            <Text style={styles.searchIcon}>⌕</Text>
            <TextInput value={search} onChangeText={setSearch} placeholder="Search products or brands" placeholderTextColor="#9B9B9B" style={styles.search} />
          </View>
          <CategoryList {...categoryListProps}>
            <CategoryChip label="All" active={category === null} onPress={() => setCategory(null)} />
            {categories.map((item) => (
              <CategoryChip key={item} label={item} active={category === item} onPress={() => setCategory(item)} />
            ))}
          </CategoryList>
          <GridList {...gridListProps}>
            {filtered.map((product) => (
              <Pressable key={product.id} onPress={() => addToCart(product)} disabled={product.stock <= 0} style={[styles.gridTile, compact && styles.gridTileCompact, product.stock <= 0 && styles.gridTileDisabled]}>
                {product.imageUrl ? (
                  <Image source={{ uri: product.imageUrl }} contentFit="cover" style={styles.gridThumb} />
                ) : (
                  <View style={[styles.gridThumb, styles.gridThumbPlaceholder]} />
                )}
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
          </GridList>
        </View>
        <View style={[styles.cartPane, compact && styles.cartPaneCompact]}>
          <Text style={styles.cartTitle}>Current sale</Text>
          <CartList {...cartListProps}>
            {cart.length === 0 ? (
              <View style={styles.emptyWrap}>
                <Text style={styles.emptyIcon}>🛒</Text>
                <Text style={styles.empty}>Cart is empty.{'\n'}Tap a product to add it.</Text>
              </View>
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
          </CartList>
          <View style={styles.totalRow}>
            <Text style={styles.totalLabel}>Total</Text>
            <Text style={styles.totalValue}>{formatCents(total)}</Text>
          </View>

          <Pressable onPress={() => setCustomerOpen((v) => !v)} style={styles.customerToggle}>
            <Text style={styles.customerToggleText}>
              {customerOpen ? '▴' : '▾'} {customerName.trim() ? `Customer: ${customerName.trim()}` : 'Add customer info (optional)'}
            </Text>
          </Pressable>
          {customerOpen && (
            <View style={styles.customerFields}>
              <TextInput value={customerName} onChangeText={setCustomerName} placeholder="Name" placeholderTextColor="#9B9B9B" style={styles.customerInput} />
              <TextInput value={customerPhone} onChangeText={setCustomerPhone} placeholder="Phone" placeholderTextColor="#9B9B9B" keyboardType="phone-pad" style={styles.customerInput} />
              <TextInput value={customerEmail} onChangeText={setCustomerEmail} placeholder="Email" placeholderTextColor="#9B9B9B" keyboardType="email-address" autoCapitalize="none" style={styles.customerInput} />
            </View>
          )}

          <PaymentMethodPicker totalCents={total} payments={payments} onChange={setPayments} />
          {error && <Text style={styles.error}>{error}</Text>}
          <Pressable onPress={checkout} disabled={cart.length === 0 || !fullyPaid || submitting} style={[styles.checkout, (cart.length === 0 || !fullyPaid || submitting) && styles.checkoutDisabled]}>
            <Text style={styles.checkoutText}>{submitting ? 'Completing…' : 'Complete sale'}</Text>
          </Pressable>
        </View>
      </Split>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: '#FFFFFF' },
  split: { flex: 1, flexDirection: 'row' },
  splitCompact: { flex: 1 },
  splitCompactContent: { flexDirection: 'column', width: '100%', minWidth: 0 },
  browsePane: { flex: 2, padding: 32 },
  browsePaneCompact: { flexGrow: 0, flexShrink: 0, flexBasis: 'auto', width: '100%', minWidth: 0, padding: 20, paddingBottom: 12 },
  searchWrap: { position: 'relative', justifyContent: 'center', marginBottom: 20 },
  searchIcon: { position: 'absolute', left: 18, color: '#9B9B9B', fontSize: 18, zIndex: 1 },
  search: { backgroundColor: '#F4F4F4', borderRadius: 14, height: 52, paddingLeft: 42, paddingRight: 16, fontSize: 15, color: '#111111' },
  categoryScroll: { flexGrow: 0, flexShrink: 0 },
  categoryRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingBottom: 24 },
  categoryRowCompact: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginBottom: 20 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 18 },
  gridTile: { flexBasis: '31%', flexGrow: 1, minWidth: 190, backgroundColor: '#FFFFFF', borderRadius: 18, padding: 16, borderWidth: 1, borderColor: '#EDEDED' },
  gridTileCompact: { flexBasis: '47%', minWidth: 140 },
  gridTileDisabled: { opacity: 0.4 },
  gridThumb: { width: '100%', aspectRatio: 1, borderRadius: 14, marginBottom: 14 },
  gridThumbPlaceholder: { backgroundColor: '#F2F2F2' },
  gridBrand: { color: '#999999', fontSize: 11, fontWeight: '700', letterSpacing: 0.5 },
  gridName: { color: '#111111', fontSize: 15, fontWeight: '700', minHeight: 40, marginTop: 4 },
  gridFooter: { marginTop: 14, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  gridPrice: { color: '#111111', fontSize: 18, fontWeight: '800' },
  gridStock: { color: '#999999', fontSize: 12 },
  lowStockPill: { fontSize: 11, fontWeight: '700', color: '#B5793A', borderWidth: 1, borderColor: '#E8C99B', paddingVertical: 5, paddingHorizontal: 10, borderRadius: 12, alignSelf: 'flex-start' },
  outOfStockPill: { fontSize: 11, fontWeight: '700', color: '#FFFFFF', backgroundColor: '#111111', paddingVertical: 5, paddingHorizontal: 10, borderRadius: 12, alignSelf: 'flex-start' },
  cartPane: { flex: 1, backgroundColor: '#FFFFFF', borderLeftWidth: 1, borderLeftColor: '#ECECEC', padding: 28, minWidth: 320 },
  cartPaneCompact: { flexGrow: 0, flexShrink: 0, flexBasis: 'auto', width: '100%', minWidth: 0, borderLeftWidth: 0, borderTopWidth: 1, borderTopColor: '#ECECEC', padding: 20, paddingTop: 16 },
  cartTitle: { color: '#111111', fontSize: 22, fontWeight: '800', marginBottom: 20 },
  cartList: { flex: 1 },
  cartListCompact: { marginBottom: 4 },
  emptyWrap: { alignItems: 'center', marginTop: 56 },
  emptyIcon: { fontSize: 32, marginBottom: 12, opacity: 0.5 },
  empty: { color: '#BBBBBB', fontSize: 14, textAlign: 'center', lineHeight: 20 },
  cartLine: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#FAFAFA', borderRadius: 14, padding: 14, marginBottom: 10 },
  cartLineName: { color: '#111111', fontSize: 14, fontWeight: '700' },
  cartLinePrice: { color: '#999999', fontSize: 12, marginTop: 2 },
  totalRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', paddingVertical: 16, borderTopWidth: 1, borderTopColor: '#ECECEC', marginTop: 12 },
  totalLabel: { color: '#111111', fontSize: 15, fontWeight: '800' },
  totalValue: { color: '#111111', fontSize: 26, fontWeight: '800' },
  customerToggle: { paddingVertical: 4 },
  customerToggleText: { fontSize: 12, fontWeight: '700', color: '#999999' },
  customerFields: { gap: 8, marginTop: 10 },
  customerInput: { backgroundColor: '#F2F2F2', borderRadius: 10, height: 42, paddingHorizontal: 12, color: '#111111' },
  error: { color: '#C0392B', fontSize: 13, fontWeight: '700', marginTop: 10 },
  checkout: { backgroundColor: '#111111', height: 56, borderRadius: 14, alignItems: 'center', justifyContent: 'center', marginTop: 20 },
  checkoutDisabled: { backgroundColor: '#CCCCCC' },
  checkoutText: { color: '#FFFFFF', fontWeight: '800', fontSize: 16 },
});
