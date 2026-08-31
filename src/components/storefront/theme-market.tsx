import { useState } from 'react';
import { FlatList, StyleSheet, Text, View, useWindowDimensions } from 'react-native';

import { CartSheet } from '@/components/storefront/cart-sheet';
import { FlyerCarousel } from '@/components/storefront/flyer-carousel';
import { ProductSheet } from '@/components/storefront/product-sheet';
import { ProductTile } from '@/components/storefront/product-tile';
import {
  CartButton, CategoryFilterBar, CHECKOUT_BAR_CLEARANCE, CheckoutBar, CheckoutScreen, ConfirmationScreen, EmptyState,
  NoSearchResults, SearchField, WhatsAppButton, filterByCategory, gridColumnsForWidth, useCheckoutFlow,
  useStorefrontCart, type ThemeProps,
} from '@/components/storefront/theme-shared';
import { searchProducts, shouldOfferSearch } from '@/lib/storefront-search';
import { LETTER, SPACE, TYPE } from '@/components/storefront/scale';
import { collectLocation } from '@/lib/storefront-collect';
import type { StorefrontProduct } from '@/types/models';

export function ThemeMarket({ storefront, products, colors, areas = [] }: ThemeProps) {
  const { width } = useWindowDimensions();
  const numColumns = gridColumnsForWidth(width);
  const { cart, addProduct, changeQuantity, clearCart, itemCount, subtotalCents } = useStorefrontCart(storefront.slug);
  const [cartOpen, setCartOpen] = useState(false);
  // The product whose sheet is open, or null. See product-sheet.tsx on
  // why this is the product itself and not a separate visible flag.
  const [openProduct, setOpenProduct] = useState<StorefrontProduct | null>(null);
  // Set by a flyer whose link_kind is 'category'. Lives here rather than in
  // the band because it is the GRID's state -- what is on show is this
  // screen's business, and a display component holding it would put the same
  // decision in two places.
  const [category, setCategory] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  // Search runs on top of the category filter, not instead of it: a
  // customer who arrived through a flyer and then searches expects to be
  // searching WITHIN what the flyer showed them. Both ways out stay
  // visible -- CategoryFilterBar for the category, Clear for the query.
  const inCategory = filterByCategory(products, category);
  const shown = searchProducts(inCategory, query);
  const checkout = useCheckoutFlow({
    slug: storefront.slug,
    shopName: storefront.shopName,
    whatsappE164: storefront.whatsappE164,
    onOrderPlaced: clearCart,
  });

  // Browse -> cart -> checkout -> confirmation all live on this one screen --
  // no route change, so a flaky connection mid-checkout never loses the
  // cart. `cart` (open/close) is CartSheet's own modal, layered over the
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
        onEditCart={() => {
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
      {shouldOfferSearch(products) ? (
        <SearchField colors={colors} value={query} onChange={setQuery} count={inCategory.length} />
      ) : null}

      {shown.length === 0 && query.trim() ? (
        <NoSearchResults colors={colors} query={query.trim()} onClear={() => setQuery('')} />
      ) : shown.length === 0 ? (
        <EmptyState
          colors={colors}
          storefront={storefront}
          category={category}
          onClearCategory={() => setCategory(null)}
        />
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
          // underneath the bar the moment the cart is non-empty.
          contentContainerStyle={[styles.grid, itemCount > 0 && styles.gridWithCheckoutBar]}
          renderItem={({ item }) => (
            <View style={styles.cell}>
              <ProductTile
                product={item}
                colors={colors}
                shopName={storefront.shopName}
                whatsappE164={storefront.whatsappE164}
                onAdd={addProduct}
                onOpen={setOpenProduct}
              />
            </View>
          )}
        />
      )}

      <ProductSheet
        product={openProduct}
        colors={colors}
        shopName={storefront.shopName}
        whatsappE164={storefront.whatsappE164}
        onClose={() => setOpenProduct(null)}
        onAdd={addProduct}
      />

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
  // the WhatsApp/Cart pair no longer both fit on one, rather than the row
  // running off the edge of the screen. `nameBlock`'s `flexShrink` is what
  // makes that possible for the name specifically: an unshrinkable View
  // would just overflow the wrapped line instead of wrapping its own text.
  nav: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', padding: SPACE.page, gap: SPACE.gap },
  nameBlock: { flexShrink: 1 },
  // `marginLeft: 'auto'` -- not `justifyContent: 'space-between'` on `nav`
  // -- is what keeps this pair pinned to the row's trailing edge whether it
  // shares line one with the name or has wrapped to a line of its own:
  // space-between only pushes a *second* item on the line away from the
  // first, so a lone wrapped item would land back at the left margin.
  navActions: { flexDirection: 'row', alignItems: 'center', gap: 8, marginLeft: 'auto', flexShrink: 0 },
  shopName: { fontSize: TYPE.name, fontWeight: '800', letterSpacing: LETTER.display },
  sub: { fontSize: TYPE.nameSub },
  headline: { fontSize: TYPE.headline, fontWeight: '800', letterSpacing: LETTER.display, paddingHorizontal: SPACE.page, paddingTop: 4 },
  about: { fontSize: TYPE.body, paddingHorizontal: SPACE.page, paddingTop: 5 },
  grid: { padding: SPACE.page, gap: SPACE.gap },
  gridWithCheckoutBar: { paddingBottom: SPACE.page + CHECKOUT_BAR_CLEARANCE },
  row: { gap: SPACE.gap },
  cell: { flex: 1 },
});
