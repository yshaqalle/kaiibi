import { useState } from 'react';
import { FlatList, StyleSheet, Text, View, useWindowDimensions } from 'react-native';

import { CartSheet } from '@/components/storefront/cart-sheet';
import { CategoryBand } from '@/components/storefront/category-band';
import { FlyerCarousel } from '@/components/storefront/flyer-carousel';
import { ProductSheet } from '@/components/storefront/product-sheet';
import { ProductTile } from '@/components/storefront/product-tile';
import { ShopChrome } from '@/components/storefront/shop-chrome';
import { ShopFooter } from '@/components/storefront/shop-footer';
import { type ShopTabKey } from '@/components/storefront/shop-tabs';
import {
  CategoryFilterBar, CHECKOUT_BAR_CLEARANCE, CheckoutBar, CheckoutScreen, ConfirmationScreen, EmptyState,
  NoSearchResults, SearchField, ShopHeader, filterByCategory, gridColumnsForWidth, isWideShop, padFinalRow,
  useCheckoutFlow, useStorefrontCart, type ThemeProps,
} from '@/components/storefront/theme-shared';
import { searchProducts, shouldOfferSearch } from '@/lib/storefront-search';
import { LETTER, SHOP_MAX_WIDTH, SPACE, TYPE } from '@/components/storefront/scale';
import { collectLocation } from '@/lib/storefront-collect';
import type { StorefrontProduct } from '@/types/models';

export function ThemeMarket({ storefront, products, colors, areas = [], categories = [] }: ThemeProps) {
  const { width } = useWindowDimensions();
  const numColumns = gridColumnsForWidth(width);
  // Two measurements off one width: how many columns of goods, and whether the
  // three shop cards sit in a row or stack. Separate thresholds because the
  // point a header stops working is not the point a grid gains a column.
  const wide = isWideShop(width);
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
  // Which of Shop / About / Visit is on show. Lives here rather than in
  // ShopChrome for the same reason `category` lives here rather than in the
  // band: what the page is showing is the page's business, and a display
  // component holding it would put the same decision in two places.
  const [tab, setTab] = useState<ShopTabKey>('shop');
  // Search runs on top of the category filter, not instead of it: a
  // customer who arrived through a flyer and then searches expects to be
  // searching WITHIN what the flyer showed them. Both ways out stay
  // visible -- CategoryFilterBar for the category, Clear for the query.
  const inCategory = filterByCategory(products, category);
  const shown = searchProducts(inCategory, query);
  const cells = padFinalRow(shown, numColumns);
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

  // Built as an ELEMENT, not as a component passed to ListHeaderComponent.
  // An inline `() => <Header/>` is a new component type on every render, which
  // remounts the whole header each keystroke and takes the search field's focus
  // with it. An element reconciles by type and keeps it.
  const header = (
    <View>
      <ShopHeader
        storefront={storefront}
        products={products}
        areas={areas}
        colors={colors}
        wide={wide}
        itemCount={itemCount}
        onOpenCart={() => setCartOpen(true)}
      />

      {/* Below the shop card, above the goods. A customer arriving on a
          forwarded link needs to know whose page this is before the loudest
          thing on it speaks -- and the poster belongs next to what it points
          at, not stranded above the header. Renders nothing at all when the
          shop has no flyers; see FlyerCarousel. */}
      <FlyerCarousel
        flyers={storefront.flyers}
        colors={colors}
        shopName={storefront.shopName}
        whatsappE164={storefront.whatsappE164}
        onSelectCategory={setCategory}
        autoAdvance={storefront.autoAdvance}
      />
      {/* Above the filter chip, not below: the band is how a customer
          CHOOSES a category and the chip is how they leave one, so the
          chip belongs next to the grid it is narrowing. */}
      <CategoryBand categories={categories} colors={colors} active={category} onSelect={setCategory} />
      <CategoryFilterBar colors={colors} category={category} onClear={() => setCategory(null)} />
      {shouldOfferSearch(products) ? (
        <SearchField colors={colors} value={query} onChange={setQuery} count={inCategory.length} />
      ) : null}
      {shown.length > 0 ? (
        // Ruled, now that there is a token that shows up. This head is the only
        // thing standing between the filter controls and an undifferentiated
        // field of tiles, and unruled it read as a caption on the first row
        // rather than as the start of a section.
        <View style={[styles.sectionHead, { borderBottomColor: colors.hairline }]}>
          <Text style={[styles.sectionTitle, { color: colors.muted }]}>What&apos;s in today</Text>
          <Text style={[styles.sectionCount, { color: colors.muted }]}>
            {shown.length} {shown.length === 1 ? 'item' : 'items'}
          </Text>
        </View>
      ) : null}
    </View>
  );

  return (
    // The page is `soft` and the cards are `ground` -- bento's relationship,
    // in the shop's own palette. This View used to be `ground`, which is what
    // made a borderless card impossible: a card the same colour as the page
    // is not a card.
    <View style={{ backgroundColor: colors.soft, flex: 1 }}>
      <ShopChrome
        storefront={storefront}
        products={products}
        categories={categories}
        areas={areas}
        colors={colors}
        wide={wide}
        tab={tab}
        onSelectTab={setTab}
      >
      <FlatList
        testID="storefront-goods"
        // Padded so a short final row leaves a gap rather than inflating its
        // cells to fill the width -- the defect this whole pass started from.
        // See padFinalRow.
        data={cells}
        // FlatList refuses to change numColumns on the fly (RN warns and
        // ignores it) -- `key` forces a fresh mount whenever the column
        // count crosses a breakpoint, which is the pattern RN's own error
        // message for this points at.
        key={numColumns}
        numColumns={numColumns}
        keyExtractor={(p, i) => p?.id ?? `pad-${i}`}
        columnWrapperStyle={styles.row}
        ListHeaderComponent={header}
        ListEmptyComponent={
          query.trim() ? (
            <NoSearchResults colors={colors} query={query.trim()} onClear={() => setQuery('')} />
          ) : (
            <EmptyState
              colors={colors}
              storefront={storefront}
              category={category}
              onClearCategory={() => setCategory(null)}
            />
          )
        }
        // Centres the whole scroller rather than the content inside it, so the
        // page tone runs edge to edge behind a bounded reading column.
        style={styles.scroller}
        // B6: the sticky CheckoutBar below is `position: absolute` and so
        // reserves no space of its own -- without this, its last row sits
        // underneath the bar the moment the cart is non-empty.
        contentContainerStyle={[styles.grid, itemCount > 0 && styles.gridWithCheckoutBar]}
        // Closes the page. Inside the list rather than below it so it scrolls
        // with the goods -- a footer pinned under a 200-product grid would be
        // chrome permanently occupying the bottom of every browsing screen.
        ListFooterComponent={<ShopFooter storefront={storefront} colors={colors} />}
        renderItem={({ item }) => (
          <View style={styles.cell}>
            {item ? (
              <ProductTile
                product={item}
                colors={colors}
                shopName={storefront.shopName}
                whatsappE164={storefront.whatsappE164}
                onAdd={addProduct}
                onOpen={setOpenProduct}
                dense={numColumns <= 2}
              />
            ) : null}
          </View>
        )}
      />
      </ShopChrome>

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
  // The reading column. `alignSelf` centres the scroller inside the page,
  // `maxWidth` stops it growing with the window -- which is the whole of what
  // made a 26px wordmark sit in 1,472px of empty panel.
  scroller: { flex: 1, width: '100%', maxWidth: SHOP_MAX_WIDTH, alignSelf: 'center' },
  sectionHead: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline',
    paddingTop: 26, paddingBottom: 10, marginBottom: 4, borderBottomWidth: 1,
  },
  sectionTitle: { fontSize: TYPE.eyebrow, fontWeight: '800', letterSpacing: LETTER.meta, textTransform: 'uppercase' },
  sectionCount: { fontSize: TYPE.metaSmall, fontWeight: '700' },
  grid: { padding: SPACE.page, gap: SPACE.cardGap },
  gridWithCheckoutBar: { paddingBottom: SPACE.page + CHECKOUT_BAR_CLEARANCE },
  row: { gap: SPACE.cardGap },
  cell: { flex: 1 },
});
