import { Image } from 'expo-image';
import { useCallback, useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View, useWindowDimensions } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { CategoryChip } from '@/components/category-chip';
import { CustomerPicker, type SelectedCustomer } from '@/components/customer-picker';
import { DiscountEditor } from '@/components/discount-editor';
import { PaymentMethodPicker } from '@/components/payment-method-picker';
import { QuantityStepper } from '@/components/quantity-stepper';
import { ReceiptModal } from '@/components/receipt-modal';
import { TABLET_BREAKPOINT } from '@/constants/layout';
import { useAuth } from '@/hooks/use-auth';
import { listCashiers } from '@/lib/cashiers';
import { listCategories } from '@/lib/categories';
import { cartTotalCents } from '@/lib/cart';
import { listCurrencies } from '@/lib/currencies';
import { formatCents } from '@/lib/currency';
import { appliedPromotionForLine, cartSubtotalCents, discountAmountCents, lineDiscountCents, lineGrossCents } from '@/lib/discounts';
import { listProducts } from '@/lib/products';
import { listPromotions } from '@/lib/promotions';
import type { ReceiptData } from '@/lib/receipt';
import { completeSale } from '@/lib/sales';
import { taxCentsFor } from '@/lib/tax';
import type { CartLine, Currency, Discount, PaymentLine, PaymentMethod, Product, Promotion } from '@/types/models';

// Real `Error` instances have `.message`, but Supabase's `rpc()`/query errors
// (e.g. PostgrestError from the complete_sale RPC — "insufficient stock for
// X: has 7, need 100") are plain `{code, details, hint, message}` objects
// that are never `instanceof Error`. Check for a string `.message` on either
// shape so the user sees the RPC's actual reason instead of a generic one.
function extractErrorMessage(err: unknown): string {
  if (err && typeof err === 'object' && 'message' in err && typeof (err as { message: unknown }).message === 'string') {
    return (err as { message: string }).message;
  }
  return 'Could not complete this sale.';
}

export default function PosScreen() {
  const { shop } = useAuth();
  const { width } = useWindowDimensions();
  const compact = width < TABLET_BREAKPOINT;
  // 'other' is deliberately excluded here — PaymentMethodPicker always
  // offers it regardless, since it isn't a toggle a shop can turn off.
  const enabledPaymentMethods: PaymentMethod[] = [
    ...(shop?.paymentCashEnabled ?? true ? (['cash'] as const) : []),
    ...(shop?.paymentZaadEnabled ?? true ? (['zaad'] as const) : []),
    ...(shop?.paymentEdahabEnabled ?? true ? (['edahab'] as const) : []),
  ];
  const [products, setProducts] = useState<Product[]>([]);
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState<string | null>(null);
  const [cart, setCart] = useState<CartLine[]>([]);
  const [payments, setPayments] = useState<PaymentLine[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [categories, setCategories] = useState<string[]>([]);
  const [categoryColors, setCategoryColors] = useState<Map<string, string | null>>(new Map());
  const [selectedCustomer, setSelectedCustomer] = useState<SelectedCustomer | null>(null);
  const [receipt, setReceipt] = useState<ReceiptData | null>(null);
  const [cashiers, setCashiers] = useState<string[]>([]);
  // Unlike customer info (cleared after every sale), the cashier stays
  // selected across sales — whoever is running the register doesn't change
  // sale-to-sale, so re-picking it each time would just be busywork.
  const [cashierName, setCashierName] = useState<string | null>(null);
  const [promotions, setPromotions] = useState<Promotion[]>([]);
  const [editingLineDiscount, setEditingLineDiscount] = useState<string | null>(null);
  const [transactionDiscount, setTransactionDiscount] = useState<Discount | null>(null);
  const [editingTransactionDiscount, setEditingTransactionDiscount] = useState(false);
  const [currencies, setCurrencies] = useState<Currency[]>([]);
  // Height of a single compact grid tile, measured from the first rendered
  // tile — rows stretch every tile to match the tallest in that row, so this
  // doubles as the row height. Used to cap the mobile product grid at 2 rows.
  const [compactTileHeight, setCompactTileHeight] = useState<number | null>(null);

  const reload = useCallback(async () => {
    if (!shop) return;
    setProducts(await listProducts(shop.id));
  }, [shop]);

  useEffect(() => { reload(); }, [reload]);
  useEffect(() => {
    if (!shop) return;
    listCategories(shop.id)
      .then((rows) => {
        setCategories(rows.map((r) => r.name));
        setCategoryColors(new Map(rows.map((r) => [r.name, r.color])));
      })
      .catch(() => {});
  }, [shop]);
  useEffect(() => { if (shop) listCashiers(shop.id).then((rows) => setCashiers(rows.map((r) => r.name))).catch(() => {}); }, [shop]);
  useEffect(() => { if (shop) listPromotions(shop.id).then(setPromotions).catch(() => {}); }, [shop]);
  useEffect(() => {
    if (!shop) return;
    listCurrencies(shop.id).then((rows) => setCurrencies(rows.filter((c) => c.active))).catch(() => {});
  }, [shop]);

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

  const setLineDiscount = (productId: string, discount: Discount | null) => {
    setCart((current) => current.map((line) => (line.product.id === productId ? { ...line, manualDiscount: discount } : line)));
  };

  const grossCents = cartTotalCents(cart);
  const subtotalCents = cartSubtotalCents(cart, promotions);
  const transactionDiscountCents = discountAmountCents(subtotalCents, transactionDiscount);
  const preTaxTotalCents = subtotalCents - transactionDiscountCents;
  const taxCents = shop?.taxEnabled ? taxCentsFor(preTaxTotalCents, shop.taxRatePercent) : 0;
  const total = preTaxTotalCents + taxCents;
  const hasAnyDiscount = grossCents !== preTaxTotalCents;
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
      await completeSale(
        shop.id,
        cart,
        payments,
        {
          id: selectedCustomer?.id ?? null,
          name: selectedCustomer?.name ?? null,
          phone: selectedCustomer?.phone ?? null,
          email: selectedCustomer?.email ?? null,
        },
        cashierName,
        promotions,
        transactionDiscountCents
      );
      setReceipt({
        shopName: shop.name,
        shopLogoUrl: shop.receiptShowLogo ? shop.logoUrl : null,
        shopCity: shop.city,
        shopNeighborhood: shop.neighborhood,
        shopContactPhone: shop.contactPhone,
        cashierName: shop.receiptShowCashierName ? cashierName : null,
        returnPolicy: shop.returnPolicy,
        items: cart.map((line) => ({
          name: line.product.name,
          quantity: line.quantity,
          unitPriceCents: line.product.priceCents,
          discountCents: lineDiscountCents(line, promotions),
        })),
        payments,
        customer: { name: selectedCustomer?.name ?? null, phone: selectedCustomer?.phone ?? null, email: selectedCustomer?.email ?? null },
        subtotalCents: grossCents,
        discountCents: grossCents - preTaxTotalCents,
        taxCents,
        taxRatePercent: shop.taxEnabled ? shop.taxRatePercent : null,
        totalCents: total,
        createdAt: new Date().toISOString(),
      });
      setCart([]);
      setPayments([]);
      setSelectedCustomer(null);
      setTransactionDiscount(null);
      setEditingTransactionDiscount(false);
      setEditingLineDiscount(null);
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
  // whole screen becomes one vertical scroller instead — and nesting a
  // flex-sized `ScrollView` inside that (even with `scrollEnabled={false}`)
  // fights React Native's own default flex sizing for `ScrollView` (it wants
  // to flex/grow along whichever axis its container scrolls) in ways that
  // are very hard to fully override, producing zero-height or overflowing
  // panes. Swapping to plain `View`s for those inner containers on mobile
  // sidesteps that entirely — they just flow with the outer page scroll like
  // normal content.
  //
  // The product grid is the one exception: it's given an explicit pixel
  // height (2 rows, via `compactTileHeight`) rather than a flex size, so it
  // doesn't hit the sizing fight above — it can scroll on its own, letting
  // shoppers reach the cart without paging through every product first.
  const Split = compact ? ScrollView : View;
  const splitProps = compact ? { contentContainerStyle: styles.splitCompactContent } : {};
  const CategoryList = compact ? View : ScrollView;
  const categoryListProps = compact
    ? { style: styles.categoryRowCompact }
    : { horizontal: true, showsHorizontalScrollIndicator: false, style: styles.categoryScroll, contentContainerStyle: styles.categoryRow };
  const GridList = ScrollView;
  const compactGridHeight = compactTileHeight ? compactTileHeight * 2 + 8 : undefined;
  const gridListProps = compact
    ? {
        style: [styles.gridScrollCompact, compactGridHeight ? { maxHeight: compactGridHeight } : null],
        contentContainerStyle: [styles.grid, styles.gridCompact],
        nestedScrollEnabled: true,
      }
    : { contentContainerStyle: styles.grid };
  const CartList = compact ? View : ScrollView;
  const cartListProps = compact ? { style: styles.cartListCompact } : { style: styles.cartList };

  return (
    <SafeAreaView edges={['left', 'right', 'bottom']} style={styles.safeArea}>
      <Split style={[styles.split, compact && styles.splitCompact]} {...splitProps}>
        <View style={[styles.browsePane, compact && styles.browsePaneCompact]}>
          <View style={styles.searchWrap}>
            <Text style={styles.searchIcon}>⌕</Text>
            <TextInput value={search} onChangeText={setSearch} placeholder="Search products or brands" placeholderTextColor="#9B9B9B" style={styles.search} />
          </View>
          <CategoryList {...categoryListProps}>
            <CategoryChip label="All" active={category === null} onPress={() => setCategory(null)} />
            {categories.map((item) => (
              <CategoryChip key={item} label={item} color={categoryColors.get(item)} active={category === item} onPress={() => setCategory(item)} />
            ))}
          </CategoryList>
          <GridList {...gridListProps}>
            {filtered.map((product, index) => (
              <Pressable
                key={product.id}
                onPress={() => addToCart(product)}
                disabled={product.stock <= 0}
                onLayout={compact && index === 0 ? (e) => setCompactTileHeight(e.nativeEvent.layout.height) : undefined}
                style={[styles.gridTile, compact && styles.gridTileCompact, product.stock <= 0 && styles.gridTileDisabled]}
              >
                {product.imageUrl ? (
                  <Image source={{ uri: product.imageUrl }} contentFit="cover" style={[styles.gridThumb, compact && styles.gridThumbCompact]} />
                ) : (
                  <View style={[styles.gridThumb, compact && styles.gridThumbCompact, styles.gridThumbPlaceholder]}>
                    <View style={[styles.gridThumbDrop, compact && styles.gridThumbDropCompact, product.stock <= 0 && styles.gridThumbDropMuted]} />
                  </View>
                )}
                {product.brand && <Text style={[styles.gridBrand, compact && styles.gridBrandCompact]}>{product.brand.toUpperCase()}</Text>}
                <Text style={[styles.gridName, compact && styles.gridNameCompact]} numberOfLines={2}>{product.name}</Text>
                <View style={[styles.gridFooter, compact && styles.gridFooterCompact]}>
                  <Text style={[styles.gridPrice, compact && styles.gridPriceCompact]}>{formatCents(product.priceCents)}</Text>
                  {product.stock <= 0 ? (
                    <Text style={[styles.stockPill, compact && styles.stockPillCompact]}>⚠ Out of stock</Text>
                  ) : (
                    <View style={styles.gridStockWithBadge}>
                      <Text style={[styles.gridStock, compact && styles.gridStockCompact]}>{product.stock} in stock</Text>
                      {product.stock <= (product.reorderLevel ?? 5) && <Text style={[styles.stockPill, compact && styles.stockPillCompact]}>⚠ Low stock</Text>}
                    </View>
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
              cart.map((line) => {
                const gross = lineGrossCents(line);
                const discountCents = lineDiscountCents(line, promotions);
                const promo = appliedPromotionForLine(line, promotions);
                const isEditing = editingLineDiscount === line.product.id;
                return (
                  <View key={line.product.id} style={styles.cartLine}>
                    <View style={styles.cartLineRow}>
                      <View style={{ flex: 1 }}>
                        <Text style={styles.cartLineName}>{line.product.name}</Text>
                        <View style={styles.cartLinePriceRow}>
                          {discountCents > 0 ? (
                            <>
                              <Text style={styles.cartLinePriceStruck}>{formatCents(gross)}</Text>
                              <Text style={styles.cartLinePrice}>{formatCents(gross - discountCents)}</Text>
                            </>
                          ) : (
                            <Text style={styles.cartLinePrice}>{formatCents(line.product.priceCents)}</Text>
                          )}
                        </View>
                        {promo && !line.manualDiscount && <Text style={styles.cartLinePromo}>🏷 {promo.name}</Text>}
                        <Pressable onPress={() => setEditingLineDiscount(isEditing ? null : line.product.id)}>
                          <Text style={styles.cartLineDiscountToggle}>{line.manualDiscount ? 'Edit discount' : '+ Add discount'}</Text>
                        </Pressable>
                      </View>
                      <QuantityStepper quantity={line.quantity} onChange={(next) => setQuantity(line.product.id, next)} />
                    </View>
                    {isEditing && (
                      <DiscountEditor
                        initial={line.manualDiscount}
                        onApply={(discount) => { setLineDiscount(line.product.id, discount); setEditingLineDiscount(null); }}
                        onRemove={line.manualDiscount ? () => { setLineDiscount(line.product.id, null); setEditingLineDiscount(null); } : undefined}
                      />
                    )}
                  </View>
                );
              })
            )}
          </CartList>
          <View style={styles.discountSection}>
            {hasAnyDiscount && (
              <>
                <View style={styles.summaryRow}>
                  <Text style={styles.summaryLabel}>Subtotal</Text>
                  <Text style={styles.summaryValue}>{formatCents(grossCents)}</Text>
                </View>
                <View style={styles.summaryRow}>
                  <Text style={styles.summaryLabel}>Discount</Text>
                  <Text style={styles.summaryValueDiscount}>-{formatCents(grossCents - preTaxTotalCents)}</Text>
                </View>
              </>
            )}
            {taxCents > 0 && (
              <View style={styles.summaryRow}>
                <Text style={styles.summaryLabel}>Tax ({shop?.taxRatePercent}%)</Text>
                <Text style={styles.summaryValue}>{formatCents(taxCents)}</Text>
              </View>
            )}
            <Pressable onPress={() => setEditingTransactionDiscount((v) => !v)}>
              <Text style={styles.cartLineDiscountToggle}>
                {transactionDiscount ? 'Edit order discount' : '+ Add order discount'}
              </Text>
            </Pressable>
            {editingTransactionDiscount && (
              <DiscountEditor
                initial={transactionDiscount}
                onApply={(discount) => { setTransactionDiscount(discount); setEditingTransactionDiscount(false); }}
                onRemove={transactionDiscount ? () => { setTransactionDiscount(null); setEditingTransactionDiscount(false); } : undefined}
              />
            )}
          </View>
          <View style={styles.totalRow}>
            <Text style={styles.totalLabel}>Total</Text>
            <Text style={styles.totalValue}>{formatCents(total)}</Text>
          </View>

          {cashiers.length > 0 && (
            <View style={styles.cashierSection}>
              <Text style={styles.cashierLabel}>CASHIER</Text>
              <View style={styles.cashierChips}>
                {cashiers.map((name) => (
                  <CategoryChip key={name} label={name} active={cashierName === name} onPress={() => setCashierName((current) => (current === name ? null : name))} />
                ))}
              </View>
            </View>
          )}

          {shop && (
            <CustomerPicker
              shopId={shop.id}
              selected={selectedCustomer}
              onSelect={setSelectedCustomer}
              onClear={() => setSelectedCustomer(null)}
            />
          )}

          <PaymentMethodPicker
            totalCents={total}
            payments={payments}
            currencies={currencies}
            onChange={setPayments}
            enabledMethods={enabledPaymentMethods}
            allowSplit={shop?.paymentSplitEnabled ?? true}
          />
          {error && <Text style={styles.error}>{error}</Text>}
          <Pressable onPress={checkout} disabled={cart.length === 0 || !fullyPaid || submitting} style={[styles.checkout, (cart.length === 0 || !fullyPaid || submitting) && styles.checkoutDisabled]}>
            <Text style={styles.checkoutText}>{submitting ? 'Completing…' : 'Complete sale'}</Text>
          </Pressable>
        </View>
      </Split>
      <ReceiptModal
        receipt={receipt}
        onClose={() => setReceipt(null)}
        title="Sale complete ✓"
        autoPrint={shop?.receiptAutoPrint ?? false}
        autoSendWhatsApp={shop?.receiptAutoWhatsapp ?? false}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: '#FFFFFF' },
  split: { flex: 1, flexDirection: 'row' },
  splitCompact: { flex: 1, flexDirection: 'column' },
  splitCompactContent: { flexDirection: 'column', width: '100%', minWidth: 0 },
  browsePane: { flex: 2, padding: 32 },
  browsePaneCompact: { flex: 0, flexGrow: 0, flexShrink: 0, flexBasis: 'auto', width: '100%', minWidth: 0, padding: 20, paddingBottom: 12 },
  searchWrap: { position: 'relative', justifyContent: 'center', marginBottom: 20 },
  searchIcon: { position: 'absolute', left: 18, color: '#9B9B9B', fontSize: 18, zIndex: 1 },
  search: { backgroundColor: '#F4F4F4', borderRadius: 14, height: 52, paddingLeft: 42, paddingRight: 16, fontSize: 15, color: '#111111' },
  categoryScroll: { flexGrow: 0, flexShrink: 0 },
  categoryRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingBottom: 24 },
  categoryRowCompact: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginBottom: 20 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 18 },
  gridCompact: { gap: 8 },
  gridScrollCompact: { flexGrow: 0, flexShrink: 0 },
  gridTile: { flexBasis: '31%', flexGrow: 0, flexShrink: 0, minWidth: 190, backgroundColor: '#FFFFFF', borderRadius: 18, padding: 16, borderWidth: 1, borderColor: '#EDEDED' },
  gridTileCompact: { flexBasis: '31%', minWidth: 90, flexGrow: 0, flexShrink: 0, borderRadius: 12, padding: 8 },
  gridTileDisabled: { opacity: 0.4 },
  gridThumb: { width: '100%', aspectRatio: 1, borderRadius: 14, marginBottom: 14 },
  gridThumbCompact: { aspectRatio: 1.3, borderRadius: 8, marginBottom: 6 },
  gridThumbPlaceholder: { backgroundColor: '#F2F2F2', alignItems: 'center', justifyContent: 'center' },
  // A teardrop silhouette built from a rotated square with three rounded
  // corners — avoids pulling in an icon/SVG library just for one glyph, and
  // (unlike the 💧 emoji) its color is fully controllable to match the
  // monochrome palette and dim for out-of-stock items.
  gridThumbDrop: {
    width: 30,
    height: 30,
    backgroundColor: '#111111',
    borderTopLeftRadius: 15,
    borderTopRightRadius: 15,
    borderBottomRightRadius: 15,
    borderBottomLeftRadius: 0,
    transform: [{ rotate: '-45deg' }],
  },
  gridThumbDropCompact: { width: 16, height: 16, borderTopLeftRadius: 8, borderTopRightRadius: 8, borderBottomRightRadius: 8 },
  gridThumbDropMuted: { backgroundColor: '#C7C7C7' },
  gridBrand: { color: '#999999', fontSize: 11, fontWeight: '700', letterSpacing: 0.5 },
  gridBrandCompact: { fontSize: 8 },
  gridName: { color: '#111111', fontSize: 15, fontWeight: '700', minHeight: 40, marginTop: 4 },
  gridNameCompact: { fontSize: 11, minHeight: 15, marginTop: 2 },
  gridFooter: { marginTop: 14, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  gridFooterCompact: { marginTop: 5, flexDirection: 'column', alignItems: 'flex-start', gap: 2 },
  gridPrice: { color: '#111111', fontSize: 18, fontWeight: '800' },
  gridPriceCompact: { fontSize: 13 },
  gridStock: { color: '#999999', fontSize: 12 },
  gridStockCompact: { fontSize: 9 },
  gridStockWithBadge: { flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
  stockPill: { fontSize: 11, fontWeight: '700', color: '#555555', backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#D8D8D8', paddingVertical: 5, paddingHorizontal: 10, borderRadius: 12, alignSelf: 'flex-start' },
  stockPillCompact: { fontSize: 8, paddingVertical: 2, paddingHorizontal: 6, borderRadius: 8 },
  cartPane: { flex: 1, backgroundColor: '#FFFFFF', borderLeftWidth: 1, borderLeftColor: '#ECECEC', padding: 28, minWidth: 320 },
  cartPaneCompact: { flex: 0, flexGrow: 0, flexShrink: 0, flexBasis: 'auto', width: '100%', minWidth: 0, borderLeftWidth: 0, borderTopWidth: 1, borderTopColor: '#ECECEC', padding: 20, paddingTop: 16 },
  cartTitle: { color: '#111111', fontSize: 22, fontWeight: '800', marginBottom: 20 },
  cartList: { flex: 1 },
  cartListCompact: { marginBottom: 4 },
  emptyWrap: { alignItems: 'center', marginTop: 56 },
  emptyIcon: { fontSize: 32, marginBottom: 12, opacity: 0.5 },
  empty: { color: '#BBBBBB', fontSize: 14, textAlign: 'center', lineHeight: 20 },
  cartLine: { backgroundColor: '#FAFAFA', borderRadius: 14, padding: 14, marginBottom: 10 },
  cartLineRow: { flexDirection: 'row', alignItems: 'center' },
  cartLineName: { color: '#111111', fontSize: 14, fontWeight: '700' },
  cartLinePriceRow: { flexDirection: 'row', alignItems: 'baseline', gap: 6, marginTop: 2 },
  cartLinePrice: { color: '#999999', fontSize: 12 },
  cartLinePriceStruck: { color: '#BBBBBB', fontSize: 12, textDecorationLine: 'line-through' },
  cartLinePromo: { color: '#111111', fontSize: 11, fontWeight: '700', marginTop: 4 },
  cartLineDiscountToggle: { color: '#999999', fontSize: 11, fontWeight: '700', marginTop: 6 },
  discountSection: { marginTop: 4 },
  summaryRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 3 },
  summaryLabel: { color: '#999999', fontSize: 13 },
  summaryValue: { color: '#111111', fontSize: 13, fontWeight: '600' },
  summaryValueDiscount: { color: '#C0392B', fontSize: 13, fontWeight: '700' },
  totalRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', paddingVertical: 16, borderTopWidth: 1, borderTopColor: '#ECECEC', marginTop: 12 },
  totalLabel: { color: '#111111', fontSize: 15, fontWeight: '800' },
  totalValue: { color: '#111111', fontSize: 26, fontWeight: '800' },
  cashierSection: { marginTop: 14 },
  cashierLabel: { fontSize: 10, letterSpacing: 0.6, fontWeight: '800', color: '#999999', marginBottom: 8 },
  cashierChips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  customerToggle: { paddingVertical: 4, marginTop: 14 },
  customerToggleText: { fontSize: 12, fontWeight: '700', color: '#999999' },
  customerFields: { gap: 8, marginTop: 10 },
  customerInput: { backgroundColor: '#F2F2F2', borderRadius: 10, height: 42, paddingHorizontal: 12, color: '#111111' },
  error: { color: '#C0392B', fontSize: 13, fontWeight: '700', marginTop: 10 },
  checkout: { backgroundColor: '#111111', height: 56, borderRadius: 14, alignItems: 'center', justifyContent: 'center', marginTop: 20 },
  checkoutDisabled: { backgroundColor: '#CCCCCC' },
  checkoutText: { color: '#FFFFFF', fontWeight: '800', fontSize: 16 },
});
