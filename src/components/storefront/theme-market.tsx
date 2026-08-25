import { FlatList, StyleSheet, Text, View } from 'react-native';

import { ProductTile } from '@/components/storefront/product-tile';
import { EmptyState, WhatsAppButton, type ThemeProps } from '@/components/storefront/theme-shared';

export function ThemeMarket({ storefront, products, colors }: ThemeProps) {
  return (
    <View style={{ backgroundColor: colors.ground, flex: 1 }}>
      <View style={styles.nav}>
        <View>
          <Text style={[styles.shopName, { color: colors.ink }]}>{storefront.shopName}</Text>
          {storefront.city ? <Text style={styles.sub}>{storefront.city}</Text> : null}
        </View>
        <WhatsAppButton storefront={storefront} />
      </View>

      {storefront.headline ? (
        <Text style={[styles.headline, { color: colors.ink }]}>{storefront.headline}</Text>
      ) : null}
      {storefront.about ? <Text style={styles.about}>{storefront.about}</Text> : null}

      {products.length === 0 ? (
        <EmptyState colors={colors} />
      ) : (
        <FlatList
          data={products}
          numColumns={2}
          keyExtractor={(p) => p.id}
          columnWrapperStyle={styles.row}
          contentContainerStyle={styles.grid}
          renderItem={({ item }) => (
            <View style={styles.cell}>
              <ProductTile product={item} colors={colors} />
            </View>
          )}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  nav: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 14, gap: 12 },
  shopName: { fontSize: 19, fontWeight: '800', letterSpacing: -0.4 },
  sub: { fontSize: 11.5, color: '#6a6a72' },
  headline: { fontSize: 22, fontWeight: '800', letterSpacing: -0.5, paddingHorizontal: 14, paddingTop: 4 },
  about: { fontSize: 13, color: '#57575e', paddingHorizontal: 14, paddingTop: 5 },
  grid: { padding: 14, gap: 12 },
  row: { gap: 12 },
  cell: { flex: 1 },
});
