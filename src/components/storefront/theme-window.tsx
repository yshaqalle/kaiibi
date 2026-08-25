import { FlatList, Image, StyleSheet, Text, View } from 'react-native';

import { ProductTile } from '@/components/storefront/product-tile';
import { EmptyState, WhatsAppButton, type ThemeProps } from '@/components/storefront/theme-shared';

// The only theme that reads hero_image_url. When there isn't one the hero falls
// back to a flat panel carrying the headline -- which still looks intentional.
// That is the test every theme in this set had to pass.
export function ThemeWindow({ storefront, products, colors }: ThemeProps) {
  return (
    <View style={{ backgroundColor: colors.ground, flex: 1 }}>
      <View style={styles.nav}>
        <Text style={[styles.shopName, { color: colors.ink }]}>{storefront.shopName.toUpperCase()}</Text>
        <WhatsAppButton storefront={storefront} />
      </View>

      <View style={[styles.hero, { backgroundColor: colors.soft }]}>
        {storefront.heroImageUrl ? (
          <Image source={{ uri: storefront.heroImageUrl }} style={styles.heroImage} resizeMode="cover" />
        ) : null}
        {storefront.headline ? (
          <Text style={[styles.heroHead, { color: colors.ink }]}>{storefront.headline}</Text>
        ) : null}
        {storefront.about ? <Text style={[styles.heroAbout, { color: colors.muted }]}>{storefront.about}</Text> : null}
      </View>

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
  nav: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 16, gap: 12 },
  shopName: { fontSize: 15, fontWeight: '800', letterSpacing: 2 },
  hero: { marginHorizontal: 16, borderRadius: 20, padding: 24, overflow: 'hidden' },
  heroImage: { ...StyleSheet.absoluteFill },
  heroHead: { fontSize: 28, fontWeight: '800', letterSpacing: -0.8, lineHeight: 31 },
  heroAbout: { fontSize: 13.5, marginTop: 9 },
  grid: { padding: 16, gap: 16 },
  row: { gap: 16 },
  cell: { flex: 1 },
});
