import { StyleSheet, Text, View } from 'react-native';

const previewProducts = [
  { brand: 'ANUA', name: 'Heartleaf 77% Toner', price: '$19.99', status: 'In stock', tone: 'ok' as const, wash: '#E3EAE0', bottle: '#7E9470' },
  { brand: 'COSRX', name: 'Snail 96 Mucin Essence', price: '$21.00', status: 'Low stock', tone: 'warn' as const, wash: '#F3E3DD', bottle: '#C08D7B' },
];

const navTabs = ['Dashboard', 'POS', 'Inventory', 'Sales'];
const categoryChips = ['All', 'Toners', 'Serums', 'Sun Care'];
const cashierChips = ['Amina', 'Yusuf'];
const paymentChips = ['Cash', 'ZAAD', 'e-Dahab'];

export function PosPreviewMock() {
  return (
    <View style={styles.card}>
      <View style={styles.topRow}>
        <Text style={styles.brand}>● Ka Iibi POS</Text>
        <View style={styles.navPills}>
          {navTabs.map((tab) =>
            tab === 'POS' ? (
              <View key={tab} style={styles.navPillActive}><Text style={styles.navPillTextActive}>{tab}</Text></View>
            ) : (
              <Text key={tab} style={styles.navPillText}>{tab}</Text>
            )
          )}
        </View>
      </View>

      <View style={styles.search}><Text style={styles.searchText}>⌕  Search products or brands</Text></View>

      <View style={styles.chipsRow}>
        {categoryChips.map((chip, index) => (
          <View key={chip} style={index === 0 ? styles.chipActive : styles.chip}>
            <Text style={index === 0 ? styles.chipTextActive : styles.chipText}>{chip}</Text>
          </View>
        ))}
      </View>

      <View style={styles.body}>
        <View style={styles.products}>
          {previewProducts.map((product) => (
            <View key={product.name} style={styles.productCard}>
              <View style={[styles.productThumb, { backgroundColor: product.wash }]}>
                <View style={[styles.productBottleCap, { backgroundColor: product.bottle }]} />
                <View style={[styles.productBottleBody, { backgroundColor: product.bottle }]} />
              </View>
              <Text style={styles.productBrand}>{product.brand}</Text>
              <Text style={styles.productName} numberOfLines={1}>{product.name}</Text>
              <View style={styles.productFooter}>
                <Text style={styles.productPrice}>{product.price}</Text>
                <View style={product.tone === 'warn' ? styles.statusPillWarn : styles.statusPillOk}>
                  <Text style={styles.statusPillText}>{product.status}</Text>
                </View>
              </View>
            </View>
          ))}
        </View>

        <View style={styles.cart}>
          <Text style={styles.cartTitle}>Current sale</Text>

          <View style={styles.cartLine}>
            <View style={styles.cartLineTop}>
              <Text style={styles.cartLineName} numberOfLines={1}>Heartleaf 77% Toner</Text>
              <Text style={styles.cartLineQty}>×1</Text>
            </View>
            <View style={styles.cartLinePriceRow}>
              <Text style={styles.cartLinePriceStruck}>$19.99</Text>
              <Text style={styles.cartLinePrice}>$16.99</Text>
            </View>
            <Text style={styles.cartLinePromo}>🏷 Skincare Week</Text>
          </View>

          <View style={styles.summaryRow}>
            <Text style={styles.summaryLabel}>Subtotal</Text>
            <Text style={styles.summaryValue}>$19.99</Text>
          </View>
          <View style={styles.summaryRow}>
            <Text style={styles.summaryLabel}>Discount</Text>
            <Text style={styles.summaryValueDiscount}>-$3.00</Text>
          </View>
          <View style={styles.summaryRow}>
            <Text style={styles.summaryLabel}>Tax (5%)</Text>
            <Text style={styles.summaryValue}>$0.85</Text>
          </View>

          <View style={styles.cartTotalRow}>
            <Text style={styles.cartTotalLabel}>Total</Text>
            <Text style={styles.cartTotalValue}>$17.84</Text>
          </View>

          <View style={styles.cashierRow}>
            <Text style={styles.cashierLabel}>CASHIER</Text>
            <View style={styles.cashierChips}>
              {cashierChips.map((name, index) => (
                <View key={name} style={index === 0 ? styles.cashierChipActive : styles.cashierChip}>
                  <Text style={index === 0 ? styles.cashierChipTextActive : styles.cashierChipText}>{name}</Text>
                </View>
              ))}
            </View>
          </View>

          <View style={styles.payRow}>
            {paymentChips.map((chip, index) => (
              <View key={chip} style={index === 0 ? styles.payChipActive : styles.payChip}>
                <Text style={index === 0 ? styles.payChipTextActive : styles.payChipText}>{chip}</Text>
              </View>
            ))}
          </View>

          <View style={styles.checkoutButton}>
            <Text style={styles.checkoutButtonText}>Complete sale</Text>
          </View>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: '#FFFFFF', borderRadius: 20, borderWidth: 1, borderColor: '#ECECEC', padding: 16, width: '100%', maxWidth: 460 },
  topRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 },
  brand: { fontSize: 13, fontWeight: '800', color: '#111111', letterSpacing: -0.3 },
  navPills: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  navPillActive: { backgroundColor: '#111111', borderRadius: 10, paddingHorizontal: 9, paddingVertical: 4 },
  navPillTextActive: { color: '#FFFFFF', fontSize: 10, fontWeight: '800' },
  navPillText: { color: '#999999', fontSize: 10, fontWeight: '700' },
  search: { height: 34, borderRadius: 9, backgroundColor: '#F4F4F4', justifyContent: 'center', paddingHorizontal: 11, marginBottom: 10 },
  searchText: { color: '#999999', fontSize: 11 },
  chipsRow: { flexDirection: 'row', gap: 6, marginBottom: 14 },
  chip: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 12, backgroundColor: '#F4F4F4' },
  chipActive: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 12, backgroundColor: '#111111' },
  chipText: { fontSize: 10, fontWeight: '700', color: '#999999' },
  chipTextActive: { fontSize: 10, fontWeight: '700', color: '#FFFFFF' },
  body: { flexDirection: 'row', gap: 10 },
  products: { flex: 3, gap: 8 },
  productCard: { borderWidth: 1, borderColor: '#EDEDED', borderRadius: 12, padding: 9 },
  productThumb: { height: 34, borderRadius: 7, marginBottom: 7, alignItems: 'center', justifyContent: 'center', gap: 1.5 },
  productBottleCap: { width: 8, height: 4, borderRadius: 1.5 },
  productBottleBody: { width: 14, height: 17, borderRadius: 4 },
  productBrand: { fontSize: 8, fontWeight: '800', color: '#999999', letterSpacing: 0.4 },
  productName: { fontSize: 11, fontWeight: '700', color: '#111111', marginTop: 2 },
  productFooter: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 6 },
  productPrice: { fontSize: 11, fontWeight: '800', color: '#111111' },
  statusPillOk: { backgroundColor: '#F2F2F2', borderRadius: 8, paddingHorizontal: 6, paddingVertical: 2 },
  statusPillWarn: { backgroundColor: '#F2F2F2', borderRadius: 8, paddingHorizontal: 6, paddingVertical: 2 },
  statusPillText: { fontSize: 8, fontWeight: '800', color: '#666666' },
  cart: { flex: 3, backgroundColor: '#FAFAFA', borderRadius: 12, padding: 10 },
  cartTitle: { fontSize: 10, fontWeight: '800', color: '#111111', marginBottom: 8 },
  cartLine: { paddingBottom: 8, marginBottom: 6, borderBottomWidth: 1, borderBottomColor: '#EDEDED' },
  cartLineTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 6 },
  cartLineName: { flex: 1, fontSize: 11, fontWeight: '700', color: '#111111' },
  cartLineQty: { fontSize: 9, fontWeight: '700', color: '#999999' },
  cartLinePriceRow: { flexDirection: 'row', alignItems: 'baseline', gap: 6, marginTop: 2 },
  cartLinePriceStruck: { fontSize: 10, color: '#BBBBBB', textDecorationLine: 'line-through' },
  cartLinePrice: { fontSize: 11, fontWeight: '800', color: '#111111' },
  cartLinePromo: { fontSize: 9, fontWeight: '700', color: '#111111', marginTop: 2 },
  summaryRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 2 },
  summaryLabel: { fontSize: 9, color: '#999999' },
  summaryValue: { fontSize: 9, fontWeight: '600', color: '#111111' },
  summaryValueDiscount: { fontSize: 9, fontWeight: '700', color: '#C0392B' },
  cashierRow: { marginTop: 8 },
  cashierLabel: { fontSize: 8, letterSpacing: 0.6, fontWeight: '800', color: '#999999', marginBottom: 5 },
  cashierChips: { flexDirection: 'row', flexWrap: 'wrap', gap: 5 },
  cashierChipActive: { backgroundColor: '#111111', borderRadius: 8, paddingHorizontal: 8, paddingVertical: 3 },
  cashierChip: { backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#EDEDED', borderRadius: 8, paddingHorizontal: 8, paddingVertical: 3 },
  cashierChipTextActive: { fontSize: 9, fontWeight: '800', color: '#FFFFFF' },
  cashierChipText: { fontSize: 9, fontWeight: '700', color: '#666666' },
  checkoutButton: { backgroundColor: '#111111', borderRadius: 10, height: 34, alignItems: 'center', justifyContent: 'center', marginTop: 10 },
  checkoutButtonText: { fontSize: 11, fontWeight: '800', color: '#FFFFFF' },
  cartTotalRow: { flexDirection: 'row', justifyContent: 'space-between', borderTopWidth: 1, borderTopColor: '#EDEDED', paddingTop: 8, marginTop: 4 },
  cartTotalLabel: { fontSize: 10, fontWeight: '700', color: '#666666' },
  cartTotalValue: { fontSize: 13, fontWeight: '800', color: '#111111' },
  payRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 5, marginTop: 9 },
  payChipActive: { backgroundColor: '#111111', borderRadius: 8, paddingHorizontal: 8, paddingVertical: 4 },
  payChip: { backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#EDEDED', borderRadius: 8, paddingHorizontal: 8, paddingVertical: 4 },
  payChipTextActive: { fontSize: 9, fontWeight: '800', color: '#FFFFFF' },
  payChipText: { fontSize: 9, fontWeight: '700', color: '#666666' },
});
