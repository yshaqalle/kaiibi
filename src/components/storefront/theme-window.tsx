import { useState } from 'react';
import { FlatList, Image, StyleSheet, Text, View, useWindowDimensions } from 'react-native';

import { CartSheet } from '@/components/storefront/cart-sheet';
import { ProductTile } from '@/components/storefront/product-tile';
import {
  CartButton, CheckoutBar, CheckoutScreen, ConfirmationScreen, EmptyState, WhatsAppButton,
  gridColumnsForWidth, useCheckoutFlow, useStorefrontCart, type ThemeProps,
} from '@/components/storefront/theme-shared';

// The only theme that reads hero_image_url. When there isn't one the hero falls
// back to a flat panel carrying the headline -- which still looks intentional.
// That is the test every theme in this set had to pass.
export function ThemeWindow({ storefront, products, colors, areas = [] }: ThemeProps) {
  const { width } = useWindowDimensions();
  const numColumns = gridColumnsForWidth(width);
  const { cart, addProduct, changeQuantity, clearCart, itemCount, subtotalCents } = useStorefrontCart(storefront.slug);
  const [cartOpen, setCartOpen] = useState(false);
  const checkout = useCheckoutFlow({
    slug: storefront.slug,
    shopName: storefront.shopName,
    whatsappE164: storefront.whatsappE164,
    onOrderPlaced: clearCart,
  });

  // See theme-market.tsx's comment on this same branch -- browse -> cart ->
  // checkout -> confirmation, no route change, checkout/confirmation shared
  // verbatim across every theme.
  if (checkout.stage === 'checkout') {
    return (
      <CheckoutScreen
        storefront={storefront}
        cart={cart}
        areas={areas}
        colors={colors}
        submitting={checkout.submitting}
        error={checkout.error}
        onBack={checkout.backToBrowse}
        onSubmit={(details) => checkout.submit(cart, details)}
      />
    );
  }

  if (checkout.stage === 'confirmation' && checkout.order) {
    return (
      <ConfirmationScreen
        order={checkout.order}
        shopName={storefront.shopName}
        colors={colors}
        onDone={checkout.backToBrowse}
      />
    );
  }

  return (
    <View style={{ backgroundColor: colors.ground, flex: 1 }}>
      <View style={styles.nav}>
        <Text style={[styles.shopName, { color: colors.ink }]}>{storefront.shopName.toUpperCase()}</Text>
        <View style={styles.navActions}>
          <WhatsAppButton storefront={storefront} />
          <CartButton colors={colors} count={itemCount} onPress={() => setCartOpen(true)} />
        </View>
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
          // See theme-market.tsx's comment on this same pattern.
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

      <CheckoutBar colors={colors} itemCount={itemCount} subtotalCents={subtotalCents} onPress={checkout.openCheckout} />
    </View>
  );
}

const styles = StyleSheet.create({
  nav: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 16, gap: 12 },
  navActions: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  shopName: { fontSize: 15, fontWeight: '800', letterSpacing: 2 },
  hero: { marginHorizontal: 16, borderRadius: 20, padding: 24, overflow: 'hidden' },
  heroImage: { ...StyleSheet.absoluteFill },
  heroHead: { fontSize: 28, fontWeight: '800', letterSpacing: -0.8, lineHeight: 31 },
  heroAbout: { fontSize: 13.5, marginTop: 9 },
  grid: { padding: 16, gap: 16 },
  row: { gap: 16 },
  cell: { flex: 1 },
});
