import { useState } from 'react';
import { FlatList, Image, StyleSheet, Text, View, useWindowDimensions } from 'react-native';

import { CartSheet } from '@/components/storefront/cart-sheet';
import { FlyerCarousel } from '@/components/storefront/flyer-carousel';
import { ProductTile } from '@/components/storefront/product-tile';
import {
  CartButton, CategoryFilterBar, CHECKOUT_BAR_CLEARANCE, CheckoutBar, CheckoutScreen, ConfirmationScreen, EmptyState,
  WhatsAppButton, filterByCategory, gridColumnsForWidth, useCheckoutFlow, useStorefrontCart, type ThemeProps,
} from '@/components/storefront/theme-shared';
import { collectLocation } from '@/lib/storefront-collect';

// The only theme that reads hero_image_url. When there isn't one the hero falls
// back to a flat panel carrying the headline -- which still looks intentional.
// That is the test every theme in this set had to pass.
export function ThemeWindow({ storefront, products, colors, areas = [] }: ThemeProps) {
  const { width } = useWindowDimensions();
  const numColumns = gridColumnsForWidth(width);
  const { cart, addProduct, changeQuantity, clearCart, itemCount, subtotalCents } = useStorefrontCart(storefront.slug);
  const [cartOpen, setCartOpen] = useState(false);
  // See theme-market.tsx's comment on this pair -- what is on show is the
  // grid's state, and a flyer only reports the category it names.
  const [category, setCategory] = useState<string | null>(null);
  const shown = filterByCategory(products, category);
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
        errorCode={checkout.errorCode}
        onBack={checkout.backToBrowse}
        onSubmit={(details, via) => checkout.submit(cart, details, via)}
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
        collectLocation={collectLocation(storefront.collectAddress, storefront.collectNeighborhood, storefront.city)}
        colors={colors}
        onDone={checkout.backToBrowse}
      />
    );
  }

  return (
    <View style={{ backgroundColor: colors.ground, flex: 1 }}>
      <View style={styles.nav} testID="storefront-header">
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
          <Text testID="storefront-headline" style={[styles.heroHead, { color: colors.ink }]}>{storefront.headline}</Text>
        ) : null}
        {storefront.about ? (
          <Text testID="storefront-about" style={[styles.heroAbout, { color: colors.muted }]}>{storefront.about}</Text>
        ) : null}
      </View>

      {/* See theme-market.tsx's comment: below the name and the blurb -- here
          that means below the whole hero panel, which is where Window puts
          both -- and above the goods. */}
      <FlyerCarousel
        flyers={storefront.flyers}
        colors={colors}
        shopName={storefront.shopName}
        whatsappE164={storefront.whatsappE164}
        onSelectCategory={setCategory}
        autoAdvance={storefront.autoAdvance}
      />
      <CategoryFilterBar colors={colors} category={category} onClear={() => setCategory(null)} />

      {shown.length === 0 ? (
        <EmptyState colors={colors} />
      ) : (
        <FlatList
          testID="storefront-goods"
          data={shown}
          // See theme-market.tsx's comment on this same pattern.
          key={numColumns}
          numColumns={numColumns}
          keyExtractor={(p) => p.id}
          columnWrapperStyle={styles.row}
          // B6: see theme-market.tsx's identical comment -- the sticky
          // CheckoutBar below floats over this content and reserves no
          // space of its own.
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
  // See theme-market.tsx's identical comment on `nav`/`navActions`: `flexWrap`
  // is what lets WhatsApp + Basket drop to their own line rather than run
  // the row off a phone's edge, and `marginLeft: 'auto'` (not
  // `justifyContent: 'space-between'`) is what keeps that pair pinned to
  // the trailing edge whether it shares line one with the name or not.
  nav: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', padding: 16, gap: 12 },
  navActions: { flexDirection: 'row', alignItems: 'center', gap: 8, marginLeft: 'auto', flexShrink: 0 },
  // Window has no separate name wrapper (no city line under it, unlike
  // Market/Counter) -- `shopName` is the Text node itself, so it takes the
  // `flexShrink` Market puts on a wrapping View instead.
  shopName: { fontSize: 15, fontWeight: '800', letterSpacing: 2, flexShrink: 1 },
  hero: { marginHorizontal: 16, borderRadius: 20, padding: 24, overflow: 'hidden' },
  heroImage: { ...StyleSheet.absoluteFill },
  heroHead: { fontSize: 28, fontWeight: '800', letterSpacing: -0.8, lineHeight: 31 },
  heroAbout: { fontSize: 13.5, marginTop: 9 },
  grid: { padding: 16, gap: 16 },
  gridWithCheckoutBar: { paddingBottom: 16 + CHECKOUT_BAR_CLEARANCE },
  row: { gap: 16 },
  cell: { flex: 1 },
});
