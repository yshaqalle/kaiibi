import { useState } from 'react';
import { ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';

import { CartSheet } from '@/components/storefront/cart-sheet';
import {
  CHECKOUT_BAR_CLEARANCE, CheckoutBar, CheckoutScreen, ConfirmationScreen, EmptyState,
  NoSearchResults, ProductActions, SearchField, ShopCard, ShopHeader, isWideShop, useCheckoutFlow,
  useStorefrontCart, type ThemeProps,
} from '@/components/storefront/theme-shared';
import { searchProducts, shouldOfferSearch } from '@/lib/storefront-search';
import { LETTER, SHOP_MAX_WIDTH, SPACE, TABULAR, TYPE } from '@/components/storefront/scale';
import { collectLocation } from '@/lib/storefront-collect';
import { formatCents } from '@/lib/currency';
import type { StorefrontProduct } from '@/types/models';

// A price list, grouped by products.category -- which already exists and is
// already filled in for most shops. This is the theme that makes a 200-line
// pharmacy catalogue readable, and the one that would have been impossible if
// every theme led with photography.
//
// COUNTER RENDERS NO FLYERS, AND THAT IS THE DESIGN, not an omission waiting
// to be tidied up. `storefront.flyers` is deliberately never read here.
// Market and Window show the band; a shop that picks Counter picked density,
// and a carousel fights the one thing this layout exists to do. The flyers
// still exist, still upload and still show the moment the shop switches
// layout -- Task 5's editor says so rather than letting a shop build
// something invisible. Pinned in storefront-flyer-placement.test.tsx so it
// stays deliberate.
function groupByCategory(products: StorefrontProduct[]): [string, StorefrontProduct[]][] {
  const groups = new Map<string, StorefrontProduct[]>();
  for (const p of products) {
    const key = p.category ?? 'Other';
    const list = groups.get(key);
    if (list) list.push(p);
    else groups.set(key, [p]);
  }
  return [...groups.entries()];
}

export function ThemeCounter({ storefront, products, colors, areas = [] }: ThemeProps) {
  const { width } = useWindowDimensions();
  const wide = isWideShop(width);
  // The cart is keyed by shop slug, not by theme (see theme-shared.tsx's
  // useStorefrontCart) -- a customer can still arrive here with items a
  // grid theme already put in it, or a shop can switch themes with a cart
  // still in progress. Either way this entry point has to be here too.
  const { cart, addProduct, changeQuantity, clearCart, itemCount, subtotalCents } = useStorefrontCart(storefront.slug);
  const [cartOpen, setCartOpen] = useState(false);
  // Counter renders no flyers and so has no category filter to compose
  // with -- this is the only thing narrowing the list. It is also the theme
  // that needs it most: 'a long catalogue with no photos' is what a shop
  // picks Counter FOR.
  const [query, setQuery] = useState('');
  const shown = searchProducts(products, query);
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
    // Page tone, not card tone -- see theme-market.tsx. The price list itself
    // becomes a card floating on it below.
    <View style={{ backgroundColor: colors.soft, flex: 1 }}>
      {/* A plain View never scrolls on native, and Expo Router's web reset sets
          `body { overflow: hidden }` -- either way, a catalogue longer than one
          viewport is unreachable without an explicit scroll container. This is
          the theme built for a long, photo-free price list, so it is the one
          most likely to overflow. */}
      {/* B6: the sticky CheckoutBar below floats over this scroll view and
          reserves no space of its own -- see theme-market.tsx's identical
          comment. */}
      {shouldOfferSearch(products) ? (
        <SearchField colors={colors} value={query} onChange={setQuery} count={products.length} />
      ) : null}

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[styles.scrollContent, itemCount > 0 && styles.scrollContentWithCheckoutBar]}
      >
        <ShopHeader
          storefront={storefront}
          products={products}
          areas={areas}
          colors={colors}
          wide={wide}
          itemCount={itemCount}
          onOpenCart={() => setCartOpen(true)}
        />

        {shown.length === 0 && query.trim() ? (
          <NoSearchResults colors={colors} query={query.trim()} onClear={() => setQuery('')} />
        ) : shown.length === 0 ? (
          <EmptyState colors={colors} storefront={storefront} />
        ) : (
          // ONE card holding the whole list, not a card per category. A price
          // list is read DOWN, which is the case the bento skill says takes a
          // single full-width card rather than a grid -- a card per section
          // would put a 26px gap between rows a customer is scanning as one
          // column of prices.
          <ShopCard colors={colors} style={styles.listCard}>
            {groupByCategory(shown).map(([category, items]) => (
            <View key={category} style={styles.section}>
              <Text style={[styles.sectionHead, { color: colors.muted }]}>{category.toUpperCase()}</Text>
              {items.map((p) => (
                <View key={p.id} style={[styles.row, { borderBottomColor: colors.soft }]}>
                  <View style={styles.rowName}>
                    <Text style={[styles.name, { color: colors.ink }]}>{p.name}</Text>
                    {/* Actions live inside this flex:1 column, not after
                        price -- price is a separate flex item that always
                        hugs its own content, so nothing added in here ever
                        shifts it and the price column keeps scanning down
                        the same as before this row grew an Add/Ask pair. */}
                    <View style={styles.stateRow}>
                      {/* See product-tile.tsx's comment on this same pair.
                          Counter is where it matters most: on a 200-row
                          price list, a colour on every in-stock row buried
                          the handful of sold-out ones a customer is actually
                          scanning for. */}
                      {p.stock > 0 ? (
                        <Text style={[styles.state, { color: colors.ink }]}>In stock</Text>
                      ) : (
                        <View style={[styles.statePill, { backgroundColor: colors.soft }]}>
                          <Text style={[styles.statePillText, { color: colors.stockOut }]}>Out of stock</Text>
                        </View>
                      )}
                      <ProductActions
                        product={p}
                        colors={colors}
                        shopName={storefront.shopName}
                        whatsappE164={storefront.whatsappE164}
                        onAdd={addProduct}
                        compact
                      />
                    </View>
                  </View>
                  <Text style={[styles.price, { color: colors.ink }]}>{formatCents(p.priceCents)}</Text>
                </View>
              ))}
            </View>
            ))}
          </ShopCard>
        )}
      </ScrollView>

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
  // The reading column -- see theme-market.tsx's identical `scroller`.
  scroll: { flex: 1, width: '100%', maxWidth: SHOP_MAX_WIDTH, alignSelf: 'center' },
  scrollContent: { padding: SPACE.page, paddingBottom: 24 },
  // Less vertical padding than a normal card: the first thing inside is a
  // section eyebrow that brings its own leading, and the rows below it are
  // meant to run close together.
  listCard: { marginTop: SPACE.cardGap, paddingVertical: 8 },
  scrollContentWithCheckoutBar: { paddingBottom: 24 + CHECKOUT_BAR_CLEARANCE },
  // No horizontal padding of its own now that this sits INSIDE a card that
  // already has some -- it used to be the page gutter, and keeping it here
  // would indent every price twice.
  section: { paddingTop: SPACE.page },
  sectionHead: { fontSize: TYPE.eyebrow, fontWeight: '800', letterSpacing: LETTER.metaWide },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 11, borderBottomWidth: 1 },
  rowName: { flex: 1 },
  name: { fontSize: TYPE.bodyDense, fontWeight: '600' },
  stateRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginTop: 3 },
  state: { fontSize: TYPE.nameSub, fontWeight: '600' },
  statePill: { borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2 },
  statePillText: { fontSize: TYPE.metaSmall, fontWeight: '800', letterSpacing: 0.2 },
  price: { fontSize: TYPE.priceDense, fontWeight: '800', ...TABULAR },
});
