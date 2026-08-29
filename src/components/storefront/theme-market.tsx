import { useState } from 'react';
import { FlatList, StyleSheet, Text, View, useWindowDimensions } from 'react-native';

import { CartSheet } from '@/components/storefront/cart-sheet';
import { FlyerCarousel } from '@/components/storefront/flyer-carousel';
import { ProductTile } from '@/components/storefront/product-tile';
import {
  CartButton, CategoryFilterBar, CHECKOUT_BAR_CLEARANCE, CheckoutBar, CheckoutScreen, ConfirmationScreen, EmptyState,
  WhatsAppButton, filterByCategory, gridColumnsForWidth, useCheckoutFlow, useStorefrontCart, type ThemeProps,
} from '@/components/storefront/theme-shared';
import { collectLocation } from '@/lib/storefront-collect';

export function ThemeMarket({ storefront, products, colors, areas = [] }: ThemeProps) {
  const { width } = useWindowDimensions();
  const numColumns = gridColumnsForWidth(width);
  const { cart, addProduct, changeQuantity, clearCart, itemCount, subtotalCents } = useStorefrontCart(storefront.slug);
  const [cartOpen, setCartOpen] = useState(false);
  // Set by a flyer whose link_kind is 'category'. Lives here rather than in
  // the band because it is the GRID's state -- what is on show is this
  // screen's business, and a display component holding it would put the same
  // decision in two places.
  const [category, setCategory] = useState<string | null>(null);
  const shown = filterByCategory(products, category);
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
        <View style={styles.nameBlock}>
          <Text style={[styles.shopName, { color: colors.ink }]}>{storefront.shopName}</Text>
          {storefront.city ? <Text style={[styles.sub, { color: colors.muted }]}>{storefront.city}</Text> : null}
        </View>
        <View style={styles.navActions}>
          <WhatsAppButton storefront={storefront} />
          <CartButton colors={colors} count={itemCount} onPress={() => setCartOpen(true)} />
        </View>
      </View>

      {storefront.headline ? (
        <Text testID="storefront-headline" style={[styles.headline, { color: colors.ink }]}>{storefront.headline}</Text>
      ) : null}
      {storefront.about ? (
        <Text testID="storefront-about" style={[styles.about, { color: colors.muted }]}>{storefront.about}</Text>
      ) : null}

      {/* Below the name and the blurb, above the goods. A customer arriving
          on a forwarded link needs to know whose page this is before the
          loudest thing on it speaks -- and the poster belongs next to what it
          points at, not stranded above the header. Renders nothing at all
          when the shop has no flyers; see FlyerCarousel. */}
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
  // B10: no fixed-width child here can outrun a 320px phone -- `flexWrap`
  // lets the actions drop to their own line the moment the shop name and
  // the WhatsApp/Basket pair no longer both fit on one, rather than the row
  // running off the edge of the screen. `nameBlock`'s `flexShrink` is what
  // makes that possible for the name specifically: an unshrinkable View
  // would just overflow the wrapped line instead of wrapping its own text.
  nav: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', padding: 14, gap: 12 },
  nameBlock: { flexShrink: 1 },
  // `marginLeft: 'auto'` -- not `justifyContent: 'space-between'` on `nav`
  // -- is what keeps this pair pinned to the row's trailing edge whether it
  // shares line one with the name or has wrapped to a line of its own:
  // space-between only pushes a *second* item on the line away from the
  // first, so a lone wrapped item would land back at the left margin.
  navActions: { flexDirection: 'row', alignItems: 'center', gap: 8, marginLeft: 'auto', flexShrink: 0 },
  shopName: { fontSize: 19, fontWeight: '800', letterSpacing: -0.4 },
  sub: { fontSize: 11.5 },
  headline: { fontSize: 22, fontWeight: '800', letterSpacing: -0.5, paddingHorizontal: 14, paddingTop: 4 },
  about: { fontSize: 13, paddingHorizontal: 14, paddingTop: 5 },
  grid: { padding: 14, gap: 12 },
  gridWithCheckoutBar: { paddingBottom: 14 + CHECKOUT_BAR_CLEARANCE },
  row: { gap: 12 },
  cell: { flex: 1 },
});
