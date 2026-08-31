import { useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { CartSheet } from '@/components/storefront/cart-sheet';
import {
  CartButton, CHECKOUT_BAR_CLEARANCE, CheckoutBar, CheckoutScreen, ConfirmationScreen, EmptyState,
  NoSearchResults, ProductActions, SearchField, WhatsAppButton, useCheckoutFlow, useStorefrontCart,
  type ThemeProps,
} from '@/components/storefront/theme-shared';
import { searchProducts, shouldOfferSearch } from '@/lib/storefront-search';
import { LETTER, SPACE, TABULAR, TYPE } from '@/components/storefront/scale';
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
    <View style={{ backgroundColor: colors.ground, flex: 1 }}>
      <View style={[styles.nav, { borderBottomColor: colors.ink }]} testID="storefront-header">
        <View style={styles.nameBlock}>
          <Text style={[styles.shopName, { color: colors.ink }]}>{storefront.shopName}</Text>
          {storefront.city ? <Text style={[styles.sub, { color: colors.muted }]}>{storefront.city}</Text> : null}
        </View>
        <View style={styles.navActions}>
          <WhatsAppButton storefront={storefront} />
          <CartButton colors={colors} count={itemCount} onPress={() => setCartOpen(true)} />
        </View>
      </View>

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
        {storefront.headline ? (
          <Text style={[styles.headline, { color: colors.ink }]}>{storefront.headline}</Text>
        ) : null}
        {storefront.about ? <Text style={[styles.about, { color: colors.muted }]}>{storefront.about}</Text> : null}

        {shown.length === 0 && query.trim() ? (
          <NoSearchResults colors={colors} query={query.trim()} onClear={() => setQuery('')} />
        ) : shown.length === 0 ? (
          <EmptyState colors={colors} storefront={storefront} />
        ) : (
          groupByCategory(shown).map(([category, items]) => (
            <View key={category} style={styles.section}>
              <Text style={[styles.sectionHead, { color: colors.accent }]}>{category.toUpperCase()}</Text>
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
          ))
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
  // See theme-market.tsx's identical comment: `flexWrap` lets WhatsApp +
  // Cart drop to their own line instead of overrunning a phone screen,
  // and `marginLeft: 'auto'` on `navActions` keeps that pair right-aligned
  // either way. `borderBottomWidth` is Counter's own treatment (Market and
  // Window have no border here) and stays untouched by this fix.
  nav: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', padding: SPACE.page, gap: SPACE.gap, borderBottomWidth: 2 },
  nameBlock: { flexShrink: 1 },
  navActions: { flexDirection: 'row', alignItems: 'center', gap: 8, marginLeft: 'auto', flexShrink: 0 },
  scroll: { flex: 1 },
  scrollContent: { paddingBottom: 24 },
  scrollContentWithCheckoutBar: { paddingBottom: 24 + CHECKOUT_BAR_CLEARANCE },
  shopName: { fontSize: TYPE.name, fontWeight: '800', letterSpacing: 0.4 },
  sub: { fontSize: TYPE.nameSub },
  headline: { fontSize: TYPE.headline, fontWeight: '700', paddingHorizontal: SPACE.page, paddingTop: 12 },
  about: { fontSize: TYPE.body, paddingHorizontal: SPACE.page, paddingTop: 5 },
  section: { paddingHorizontal: SPACE.page, paddingTop: SPACE.page },
  sectionHead: { fontSize: TYPE.meta, fontWeight: '800', letterSpacing: LETTER.metaWide },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 11, borderBottomWidth: 1 },
  rowName: { flex: 1 },
  name: { fontSize: TYPE.bodyDense, fontWeight: '600' },
  stateRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginTop: 3 },
  state: { fontSize: TYPE.nameSub, fontWeight: '600' },
  statePill: { borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2 },
  statePillText: { fontSize: TYPE.metaSmall, fontWeight: '800', letterSpacing: 0.2 },
  price: { fontSize: TYPE.priceDense, fontWeight: '800', ...TABULAR },
});
