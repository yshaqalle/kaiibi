import { useEffect, useState } from 'react';
import { FlatList, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';

import { CartSheet } from '@/components/storefront/cart-sheet';
import { CategoryBand } from '@/components/storefront/category-band';
import { FlyerCarousel } from '@/components/storefront/flyer-carousel';
import { ProductSheet } from '@/components/storefront/product-sheet';
import { ProductTile } from '@/components/storefront/product-tile';
import { ShopChrome } from '@/components/storefront/shop-chrome';
import { useShopTab } from '@/components/storefront/shop-tabs';
import { ShopFooter } from '@/components/storefront/shop-footer';
import {
  CategoryFilterBar, CHECKOUT_BAR_CLEARANCE, CheckoutBar, CheckoutScreen, ConfirmationScreen, EmptyState,
  goodsScrollHeight, NoSearchResults, SearchField, ShopHeader, cartThumbnails, filterByCategory, gridColumnsForWidth,
  isWideShop, padFinalRow, useCheckoutFlow, useStorefrontCart, type ThemeProps,
} from '@/components/storefront/theme-shared';
import { searchProducts, shouldOfferSearch } from '@/lib/storefront-search';
import { LETTER, SHOP_MAX_WIDTH, SPACE, TYPE } from '@/components/storefront/scale';
import { collectLocation } from '@/lib/storefront-collect';
import type { StorefrontProduct } from '@/types/models';

// The only theme that reads hero_image_url. When there isn't one the hero falls
// back to a flat panel carrying the headline -- which still looks intentional.
// That is the test every theme in this set had to pass.
export function ThemeWindow({ storefront, products, colors, areas = [], categories = [], tab, onSelectTab }: ThemeProps) {
  // Controlled by the route when there is one, local otherwise -- see
  // useShopTab. One line here instead of a useState in all three themes.
  const [activeTab, selectTab] = useShopTab(tab, onSelectTab);
  const { width } = useWindowDimensions();
  const numColumns = gridColumnsForWidth(width);
  // See theme-market.tsx: two measurements off one width, separate thresholds.
  const wide = isWideShop(width);
  const { cart, addProduct, changeQuantity, clearCart, itemCount, subtotalCents } = useStorefrontCart(storefront.slug);
  const [cartOpen, setCartOpen] = useState(false);
  // The product whose sheet is open, or null. See product-sheet.tsx on
  // why this is the product itself and not a separate visible flag.
  const [openProduct, setOpenProduct] = useState<StorefrontProduct | null>(null);
  // See theme-market.tsx's comment on this pair -- what is on show is the
  // grid's state, and a flyer only reports the category it names.
  const [category, setCategory] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  // Search runs on top of the category filter, not instead of it: a
  // customer who arrived through a flyer and then searches expects to be
  // searching WITHIN what the flyer showed them. Both ways out stay
  // visible -- CategoryFilterBar for the category, Clear for the query.
  const inCategory = filterByCategory(products, category);
  const shown = searchProducts(inCategory, query);
  const cells = padFinalRow(shown, numColumns);
  // See theme-market.tsx's identical block: the measurement the goods
  // region's own height is built from, reset on every column-count change so
  // a stale measurement from the OLD breakpoint cannot survive into the new
  // one.
  const [rowHeight, setRowHeight] = useState<number | null>(null);
  useEffect(() => setRowHeight(null), [numColumns]);
  const rowCount = numColumns > 0 ? Math.ceil(cells.length / numColumns) : 0;
  const goodsHeight = goodsScrollHeight(rowHeight, SPACE.cardGap, rowCount);
  const goodsStyle = goodsHeight != null ? [styles.goods, { maxHeight: goodsHeight }] : styles.goods;
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
        hideBranding={storefront.hideBranding}
      />
    );
  }

  // See theme-market.tsx on why this is an element rather than a component.
  const header = (
    <View>
      {/* WINDOW'S IDENTITY IS NOW THE SHARED SHOP CARD, and the argument that
          used to live here survives it intact: the name is said once, as the
          wordmark, and never also in a button row. What changed is that the
          card is shared -- Market and Counter lead with the same three cards,
          because "whose shop is this, where is it, what is in it" is not a
          question one layout gets to answer better than another.

          What is still Window's own is the hero PHOTOGRAPH: it is the only
          theme that reads hero_image_url, and ShopAnchor renders it as the
          card's background with the same 0.55 scrim and the same fixed
          on-scrim type this file used to own. */}
      <ShopHeader
        storefront={storefront}
        products={products}
        areas={areas}
        colors={colors}
        wide={wide}
        itemCount={itemCount}
        onOpenCart={() => setCartOpen(true)}
      />

      {/* See theme-market.tsx's comment: below the shop card, above the
          goods. */}
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
      <CategoryBand categories={categories} products={products} colors={colors} active={category} onSelect={setCategory} />
      <CategoryFilterBar colors={colors} category={category} onClear={() => setCategory(null)} />
      {shouldOfferSearch(products) ? (
        <SearchField colors={colors} value={query} onChange={setQuery} count={inCategory.length} />
      ) : null}
      {shown.length > 0 ? (
        // See theme-market.tsx: ruled, now that there is a token that shows up.
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
    // Page tone, not card tone -- see theme-market.tsx.
    <View style={{ backgroundColor: colors.soft, flex: 1 }}>
      <ShopChrome
        storefront={storefront}
        products={products}
        categories={categories}
        areas={areas}
        colors={colors}
        wide={wide}
        tab={activeTab}
        onSelectTab={selectTab}
      >
      {/* THE PAGE is a plain ScrollView, and the goods below are the ONLY
          FlatList left in this tree -- see theme-market.tsx's identical
          block for why the other way round (nest the goods FlatList inside a
          page FlatList, to dodge RN's nested-list warning by inheriting an
          ancestor VirtualizedList context) was tried first and is wrong: RN
          reads that ancestor context as "something above me already owns
          scrolling" and renders the nested list as a plain, non-scrolling,
          non-clipping View instead of a ScrollView
          (`_isNestedWithSameOrientation` in
          @react-native/virtualized-lists/Lists/VirtualizedList.js) -- proven
          in the browser, not merely reasoned from the warning text. */}
      <ScrollView
        testID="storefront-page-scroll"
        style={styles.scroller}
        // B6: see theme-market.tsx's identical comment -- the sticky
        // CheckoutBar floats over this content and reserves no space of
        // its own. Unconditional for the same reason: the first Add must
        // not reflow the page under the customer's finger. The footer is now
        // the page's own bottom-most scrolling content (the goods are a
        // bounded box above it), so the clearance sits here with it.
        contentContainerStyle={[styles.page, styles.pageWithCheckoutBar]}
      >
        {header}
        {/* THE GOODS' OWN SCROLL -- see theme-market.tsx's identical block
            for the arithmetic (goodsScrollHeight) and the
            `rowHeight`/`goodsHeight` this style is built from. */}
        <FlatList
          testID="storefront-goods"
          // See padFinalRow: a short final row leaves a gap rather than
          // inflating its cells to fill the width.
          data={cells}
          // See theme-market.tsx's comment on this same pattern,
          // including why it is also what clears `rowHeight` above.
          key={numColumns}
          numColumns={numColumns}
          keyExtractor={(p, i) => p?.id ?? `pad-${i}`}
          columnWrapperStyle={styles.row}
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
          style={goodsStyle}
          contentContainerStyle={styles.grid}
          // See theme-market.tsx's identical comment -- Android-only,
          // lets the goods claim a vertical drag over the page's own
          // scroller.
          nestedScrollEnabled
          renderItem={({ item, index }) => (
            <View
              testID={index === 0 ? 'storefront-goods-row' : undefined}
              style={styles.cell}
              onLayout={index === 0 ? (e) => setRowHeight(e.nativeEvent.layout.height) : undefined}
            >
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
        {/* See theme-market.tsx: closes the page, scrolling with it -- the
            page's own trailing sibling now, not a nested list's
            ListFooterComponent. */}
        <ShopFooter storefront={storefront} colors={colors} />
      </ScrollView>
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

      <CheckoutBar
        colors={colors}
        itemCount={itemCount}
        subtotalCents={subtotalCents}
        thumbnails={cartThumbnails(cart, products)}
        fulfilment={storefront.offersDelivery ? null : 'collection'}
        onPress={checkout.openCheckout}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  // The reading column, now on the PAGE-level ScrollView -- see
  // theme-market.tsx's identical `scroller`.
  scroller: { flex: 1, width: '100%', maxWidth: SHOP_MAX_WIDTH, alignSelf: 'center' },
  sectionHead: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline',
    paddingTop: 26, paddingBottom: 10, marginBottom: 4, borderBottomWidth: 1,
  },
  sectionTitle: { fontSize: TYPE.eyebrow, fontWeight: '800', letterSpacing: LETTER.meta, textTransform: 'uppercase' },
  sectionCount: { fontSize: TYPE.metaSmall, fontWeight: '700' },
  // See theme-market.tsx's identical `page`/`pageWithCheckoutBar`/`goods`/
  // `grid` -- the page now owns the padding and the checkout-bar clearance;
  // the nested goods FlatList owns only its own row gap, so its rendered
  // height is exactly two measured rows plus one gap when bounded.
  page: { padding: SPACE.page, gap: SPACE.cardGap },
  pageWithCheckoutBar: { paddingBottom: SPACE.page + CHECKOUT_BAR_CLEARANCE },
  goods: { width: '100%' },
  grid: { gap: SPACE.cardGap },
  row: { gap: SPACE.cardGap },
  cell: { flex: 1 },
});
