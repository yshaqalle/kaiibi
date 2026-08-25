import { useState } from 'react';
import { FlatList, StyleSheet, Text, View, useWindowDimensions } from 'react-native';

import { CartSheet } from '@/components/storefront/cart-sheet';
import { ProductTile } from '@/components/storefront/product-tile';
import {
  CartButton, EmptyState, WhatsAppButton, gridColumnsForWidth, useStorefrontCart, type ThemeProps,
} from '@/components/storefront/theme-shared';

export function ThemeMarket({ storefront, products, colors }: ThemeProps) {
  const { width } = useWindowDimensions();
  const numColumns = gridColumnsForWidth(width);
  const { cart, addProduct, changeQuantity, itemCount } = useStorefrontCart(storefront.slug);
  const [cartOpen, setCartOpen] = useState(false);

  return (
    <View style={{ backgroundColor: colors.ground, flex: 1 }}>
      <View style={styles.nav}>
        <View>
          <Text style={[styles.shopName, { color: colors.ink }]}>{storefront.shopName}</Text>
          {storefront.city ? <Text style={[styles.sub, { color: colors.muted }]}>{storefront.city}</Text> : null}
        </View>
        <View style={styles.navActions}>
          <WhatsAppButton storefront={storefront} />
          <CartButton colors={colors} count={itemCount} onPress={() => setCartOpen(true)} />
        </View>
      </View>

      {storefront.headline ? (
        <Text style={[styles.headline, { color: colors.ink }]}>{storefront.headline}</Text>
      ) : null}
      {storefront.about ? <Text style={[styles.about, { color: colors.muted }]}>{storefront.about}</Text> : null}

      {products.length === 0 ? (
        <EmptyState colors={colors} />
      ) : (
        <FlatList
          data={products}
          // FlatList refuses to change numColumns on the fly (RN warns and
          // ignores it) -- `key` forces a fresh mount whenever the column
          // count crosses a breakpoint, which is the pattern RN's own error
          // message for this points at.
          key={numColumns}
          numColumns={numColumns}
          keyExtractor={(p) => p.id}
          columnWrapperStyle={styles.row}
          contentContainerStyle={styles.grid}
          renderItem={({ item }) => (
            <View style={styles.cell}>
              <ProductTile
                product={item}
                colors={colors}
                shopName={storefront.shopName}
                whatsappE164={storefront.whatsappE164}
                onAdd={addProduct}
              />
            </View>
          )}
        />
      )}

      <CartSheet
        visible={cartOpen}
        onClose={() => setCartOpen(false)}
        cart={cart}
        colors={colors}
        onChangeQuantity={changeQuantity}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  nav: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 14, gap: 12 },
  navActions: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  shopName: { fontSize: 19, fontWeight: '800', letterSpacing: -0.4 },
  sub: { fontSize: 11.5 },
  headline: { fontSize: 22, fontWeight: '800', letterSpacing: -0.5, paddingHorizontal: 14, paddingTop: 4 },
  about: { fontSize: 13, paddingHorizontal: 14, paddingTop: 5 },
  grid: { padding: 14, gap: 12 },
  row: { gap: 12 },
  cell: { flex: 1 },
});
