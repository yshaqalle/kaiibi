import { StyleSheet, Text, View } from 'react-native';

const previewProducts = [
  { brand: 'ANUA', name: 'Heartleaf 77% Toner', price: '$19.99', status: 'In stock', tone: 'ok' as const },
  { brand: 'COSRX', name: 'Snail 96 Mucin Essence', price: '$21.00', status: 'Low stock', tone: 'warn' as const },
];

const categoryChips = ['All', 'Toners', 'Serums', 'Sun Care'];
const paymentChips = ['Cash', 'ZAAD', 'e-Dahab'];

export function PosPreviewMock() {
  return (
    <View style={styles.card}>
      <View style={styles.topRow}>
        <Text style={styles.brand}>● Ka Iibi POS</Text>
        <View style={styles.navPills}>
          <View style={styles.navPillActive}><Text style={styles.navPillTextActive}>Sale</Text></View>
          <Text style={styles.navPillText}>Inventory</Text>
          <Text style={styles.navPillText}>Reports</Text>
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
              <View style={styles.productThumb} />
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
          <View style={styles.cartEmpty}>
            <Text style={styles.cartEmptyText}>Tap a product{'\n'}to add it</Text>
          </View>
          <View style={styles.cartTotalRow}>
            <Text style={styles.cartTotalLabel}>Total</Text>
            <Text style={styles.cartTotalValue}>$0.00</Text>
          </View>
          <View style={styles.payRow}>
            {paymentChips.map((chip, index) => (
              <View key={chip} style={index === 0 ? styles.payChipActive : styles.payChip}>
                <Text style={index === 0 ? styles.payChipTextActive : styles.payChipText}>{chip}</Text>
              </View>
            ))}
          </View>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: '#FFFFFF', borderRadius: 20, borderWidth: 1, borderColor: '#ECEBE5', padding: 16, width: '100%', maxWidth: 460 },
  topRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 },
  brand: { fontSize: 13, fontWeight: '800', color: '#17261F', letterSpacing: -0.3 },
  navPills: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  navPillActive: { backgroundColor: '#17261F', borderRadius: 10, paddingHorizontal: 9, paddingVertical: 4 },
  navPillTextActive: { color: '#FFFFFF', fontSize: 10, fontWeight: '800' },
  navPillText: { color: '#9CA39B', fontSize: 10, fontWeight: '700' },
  search: { height: 34, borderRadius: 9, backgroundColor: '#F4F3EF', justifyContent: 'center', paddingHorizontal: 11, marginBottom: 10 },
  searchText: { color: '#9CA39B', fontSize: 11 },
  chipsRow: { flexDirection: 'row', gap: 6, marginBottom: 14 },
  chip: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 12, backgroundColor: '#F4F3EF' },
  chipActive: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 12, backgroundColor: '#17261F' },
  chipText: { fontSize: 10, fontWeight: '700', color: '#767C74' },
  chipTextActive: { fontSize: 10, fontWeight: '700', color: '#FFFFFF' },
  body: { flexDirection: 'row', gap: 10 },
  products: { flex: 3, gap: 8 },
  productCard: { borderWidth: 1, borderColor: '#EFEEE9', borderRadius: 12, padding: 9 },
  productThumb: { height: 34, borderRadius: 7, backgroundColor: '#EEF2EB', marginBottom: 7 },
  productBrand: { fontSize: 8, fontWeight: '800', color: '#9CA39B', letterSpacing: 0.4 },
  productName: { fontSize: 11, fontWeight: '700', color: '#26342D', marginTop: 2 },
  productFooter: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 6 },
  productPrice: { fontSize: 11, fontWeight: '800', color: '#17261F' },
  statusPillOk: { backgroundColor: '#E4F0E3', borderRadius: 8, paddingHorizontal: 6, paddingVertical: 2 },
  statusPillWarn: { backgroundColor: '#FBEADD', borderRadius: 8, paddingHorizontal: 6, paddingVertical: 2 },
  statusPillText: { fontSize: 8, fontWeight: '800', color: '#5A665F' },
  cart: { flex: 2, backgroundColor: '#FAF9F5', borderRadius: 12, padding: 10 },
  cartTitle: { fontSize: 10, fontWeight: '800', color: '#17261F', marginBottom: 8 },
  cartEmpty: { alignItems: 'center', paddingVertical: 10 },
  cartEmptyText: { fontSize: 9, color: '#9CA39B', textAlign: 'center', lineHeight: 13 },
  cartTotalRow: { flexDirection: 'row', justifyContent: 'space-between', borderTopWidth: 1, borderTopColor: '#EFEEE9', paddingTop: 8, marginTop: 4 },
  cartTotalLabel: { fontSize: 10, fontWeight: '700', color: '#5A665F' },
  cartTotalValue: { fontSize: 13, fontWeight: '800', color: '#17261F' },
  payRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 5, marginTop: 9 },
  payChipActive: { backgroundColor: '#17261F', borderRadius: 8, paddingHorizontal: 8, paddingVertical: 4 },
  payChip: { backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#EFEEE9', borderRadius: 8, paddingHorizontal: 8, paddingVertical: 4 },
  payChipTextActive: { fontSize: 9, fontWeight: '800', color: '#FFFFFF' },
  payChipText: { fontSize: 9, fontWeight: '700', color: '#5A665F' },
});
