import { useState } from 'react';
import { FlatList, StyleSheet, Text, View, useWindowDimensions } from 'react-native';

import { CartSheet } from '@/components/storefront/cart-sheet';
import { ProductTile } from '@/components/storefront/product-tile';
import {
  CartButton, CHECKOUT_BAR_CLEARANCE, CheckoutBar, CheckoutScreen, ConfirmationScreen, EmptyState, WhatsAppButton,
  gridColumnsForWidth, useCheckoutFlow, useStorefrontCart, type ThemeProps,
} from '@/components/storefront/theme-shared';

export function ThemeMarket({ storefront, products, colors, areas = [] }: ThemeProps) {
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

  // Browse -> cart -> checkout -> confirmation all live on this one screen --
  // no route change, so a flaky connection mid-checkout never loses the
  // basket. `cart` (open/close) is CartSheet's own modal, layered over the
  // browsing return below; `checkout.stage` swaps the WHOLE screen, since
  // checkout and confirmation are the same for every theme (see
  // CheckoutScreen/ConfirmationScreen in theme-shared.tsx).
  if (checkout.stage === 'checkout') {
    return (
      <CheckoutScreen
        storefront={storefront}
        cart={cart}
        areas={areas}
        colors={colors}
        submitting={checkout.submitting}
        error={checkout.error}
        errorCode={checkout.errorCode}
        onBack={checkout.backToBrowse}
        onSubmit={(details) => checkout.submit(cart, details)}
        onEditBasket={() => {
          checkout.backToBrowse();
          setCartOpen(true);
        }}
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
          // B6: the sticky CheckoutBar below is `position: absolute` and so
          // reserves no space of its own -- without this, its last row sits
          // underneath the bar the moment the basket is non-empty.
          contentContainerStyle={[styles.grid, itemCount > 0 && styles.gridWithCheckoutBar]}
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
        onCheckout={() => {
          setCartOpen(false);
          checkout.openCheckout();
        }}
      />

      <CheckoutBar colors={colors} itemCount={itemCount} subtotalCents={subtotalCents} onPress={checkout.openCheckout} />
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
  gridWithCheckoutBar: { paddingBottom: 14 + CHECKOUT_BAR_CLEARANCE },
  row: { gap: 12 },
  cell: { flex: 1 },
});
