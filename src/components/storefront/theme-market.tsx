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

export function ThemeMarket({ storefront, products, colors, areas = [], categories = [], tab, onSelectTab }: ThemeProps) {
  // Controlled by the route when there is one, local otherwise -- see
  // useShopTab. One line here instead of a useState in all three themes.
  const [activeTab, selectTab] = useShopTab(tab, onSelectTab);
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
  // Search runs on top of the category filter, not instead of it: a
  // customer who arrived through a flyer and then searches expects to be
  // searching WITHIN what the flyer showed them. Both ways out stay
  // visible -- CategoryFilterBar for the category, Clear for the query.
  const inCategory = filterByCategory(products, category);
  const shown = searchProducts(inCategory, query);
  const cells = padFinalRow(shown, numColumns);
  // THE MEASUREMENT the goods region's own height is built from -- see
  // goodsScrollHeight's comment in theme-shared.tsx for why this cannot be a
  // constant. Reset on every column-count change: `key={numColumns}` below
  // already remounts the FlatList at that point, and a measurement taken at
  // the OLD column count (a different tile height) would otherwise survive
  // into the new one until a fresh layout happened to overwrite it.
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
        hideBranding={storefront.hideBranding}
      />
    );
  }

  // Floats over the anchor's own bottom edge -- the platform-shot move
  // docs/design/storefront-bold-motion-mockup.html's "The One" section
  // commits to (`.onesearch`, margin -21px). Narrow layout only: in the
  // wide 3-card row (see ShopHeader), ShopAnchor sits BESIDE
  // CollectingCard/StockCard rather than above them, and either one's
  // own button (Cart, WhatsApp) can be the last thing painted at that
  // row's bottom edge -- overlapping a real control there is a worse
  // defect than the 21px of breathing room a wide screen already has to
  // spare. Wide keeps the field in its old, non-overlapping spot below,
  // unchanged. Gated by the same `shouldOfferSearch` either way, so a
  // shop under the threshold gets neither placement and the anchor
  // sits flush with nothing above FlyerCarousel.
  //
  // Handed to ShopHeader as `narrowFloatingSearch` rather than rendered as
  // ShopHeader's sibling: ShopHeader's narrow branch nests ShopAnchor inside
  // its own View, ahead of headerPair (CollectingCard + StockCard) -- so a
  // sibling of the WHOLE header sits after headerPair, not after the
  // anchor, and the -21px pull lands on the light Collecting/Stock cards
  // instead of the anchor's dark card. Threading it through as a prop keeps
  // this exact gate (shouldOfferSearch, !wide) the only place that decision
  // is made, while letting ShopHeader paint it between the two children it
  // actually belongs between.
  const narrowFloatingSearch = !wide && shouldOfferSearch(products) ? (
    <SearchField colors={colors} value={query} onChange={setQuery} count={inCategory.length} floating />
  ) : null;

  // Built once as an element, same reason `header` below is: identity
  // matters. Which spot actually PAINTS it -- ShopHeader's narrow branch
  // (via the `narrowFlyerCarousel` slot, right after the floating search)
  // or here, as ThemeMarket's own sibling below the whole header -- depends
  // on `wide`, but the element itself, and FlyerCarousel's own "nothing
  // when the shop has no flyers" guard, is the exact same one either way.
  // See the ShopHeader render below for why narrow needs the slot at all:
  // the mockup (storefront-bold-motion-mockup.html, `.onesearch` immediately
  // followed by the flyer band) puts the carousel directly under the
  // floating search, ABOVE the Collecting/Stock pair -- and a sibling of
  // the WHOLE header lands after that pair, not after the search.
  const flyerCarousel = (
    <FlyerCarousel
      flyers={storefront.flyers}
      colors={colors}
      shopName={storefront.shopName}
      whatsappE164={storefront.whatsappE164}
      onSelectCategory={setCategory}
      autoAdvance={storefront.autoAdvance}
    />
  );

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
        narrowFloatingSearch={narrowFloatingSearch}
        narrowFlyerCarousel={flyerCarousel}
      />

      {/* Wide only -- ShopHeader's wide branch ignores narrowFlyerCarousel
          entirely (ShopAnchor sits beside the cards there, and the search
          does not float), so wide keeps painting the carousel here, as
          ThemeMarket's own sibling below the whole header, exactly as it
          did before this fix. Narrow paints the SAME element inside
          ShopHeader instead (see narrowFlyerCarousel above) -- never both,
          so FlyerCarousel mounts exactly once either way. */}
      {wide ? flyerCarousel : null}
      {/* Above the filter chip, not below: the band is how a customer
          CHOOSES a category and the chip is how they leave one, so the
          chip belongs next to the grid it is narrowing. */}
      <CategoryBand categories={categories} products={products} colors={colors} active={category} onSelect={setCategory} />
      <CategoryFilterBar colors={colors} category={category} onClear={() => setCategory(null)} />
      {wide && shouldOfferSearch(products) ? (
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
        tab={activeTab}
        onSelectTab={selectTab}
      >
      {/* THE PAGE is a plain ScrollView, and the goods below are the ONLY
          FlatList left in this tree -- which looks like it should be the
          other way around (nest the goods FlatList inside a page FlatList,
          so it inherits an ancestor VirtualizedList context and never trips
          RN's "VirtualizedLists should never be nested inside plain
          ScrollViews" warning). That was this file's first shape, and it was
          wrong: proven in the browser, not reasoned from the warning text
          alone.

          A VirtualizedList that finds a same-orientation VirtualizedList
          context above it does not merely suppress the warning -- RN reads
          that context as "an ancestor list already owns scrolling" and
          renders the nested one as a plain, non-scrolling View instead of a
          ScrollView (`_isNestedWithSameOrientation` gating
          `_defaultRenderScrollComponent` in
          @react-native/virtualized-lists/Lists/VirtualizedList.js). On web
          that showed up as the goods box having `overflow-y: visible` and no
          effect from setting `scrollTop` at all -- the exact mechanism
          SectionList relies on to fold many same-orientation lists into ONE
          physical scroll, and exactly wrong for a region that has to scroll
          on its OWN gesture, independently of the page. Nesting FlatList
          inside FlatList here would have silently shipped a goods box that
          cannot scroll.

          So: the goods FlatList keeps its own real ScrollView (nothing above
          it is a VirtualizedList) and the page is what changes shape
          instead. That does put a VirtualizedList under a plain ScrollView
          of the same orientation, which is what the warning's TEXT describes
          -- but the concern the warning exists for (a list that cannot tell
          it has a bounded viewport, and renders every row at once as a
          result) does not apply here: the goods FlatList has an explicit
          `maxHeight` of its own the moment there is more than one row (see
          goodsScrollHeight, and `goodsStyle` below), so its viewport is
          exactly as well-defined nested as it would be at the top of the
          tree. And on THIS platform the check is moot regardless --
          react-native-web's own copy of it
          (react-native-web/dist/.../VirtualizedList/index.js) is commented
          out pending a ScrollView.Context.Consumer it does not yet
          implement, so the console this task's brief says to read never
          prints it here either way. */}
      <ScrollView
        testID="storefront-page-scroll"
        // Centres the whole scroller rather than the content inside it, so the
        // page tone runs edge to edge behind a bounded reading column.
        style={styles.scroller}
        // B6: the sticky CheckoutBar below is `position: absolute` and so
        // reserves no space of its own -- without this, its last row sits
        // underneath the bar. The goods used to be the page's own
        // bottom-most scrolling content and carried this; now the FOOTER is
        // (the goods are a bounded box above it), so the clearance moves
        // here with it.
        // Unconditional: the first Add must not reflow the page under the
        // customer's finger. The cost is the clearance's worth of quiet
        // space at the bottom of an empty-cart scroll, which nothing sits
        // under.
        contentContainerStyle={[styles.page, styles.pageWithCheckoutBar]}
      >
        {header}
        {/* THE GOODS' OWN SCROLL, bounded to about two rows -- see
            goodsScrollHeight in theme-shared.tsx for the arithmetic and
            `rowHeight`/`goodsHeight` above for where the measurement that
            feeds it comes from. `goodsStyle` carries no maxHeight at all
            (and this FlatList is simply its own height, scrolling with the
            page rather than on its own) once the grid is one row or
            shorter, or empty -- see goodsScrollHeight's own `rowCount <= 1`
            branch. */}
        <FlatList
          testID="storefront-goods"
          // Padded so a short final row leaves a gap rather than
          // inflating its cells to fill the width -- the defect this
          // whole pass started from. See padFinalRow.
          data={cells}
          // FlatList refuses to change numColumns on the fly (RN warns
          // and ignores it) -- `key` forces a fresh mount whenever the
          // column count crosses a breakpoint, which is the pattern RN's
          // own error message for this points at. The same remount is
          // what clears `rowHeight` above back to null, so a stale
          // measurement from the OLD column count can never leak into
          // the new one.
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
          // Android only needs this to let the goods claim a vertical drag
          // over the page's own scroller rather than the page stealing it --
          // iOS and web coordinate nested scroll views without it.
          nestedScrollEnabled
          renderItem={({ item, index }) => (
            <View
              // Only the very first cell needs to report its height --
              // every cell in a row is stretched to match its tallest
              // sibling (columnWrapperStyle's row is the default
              // `alignItems: stretch`), so cell 0 already reports the
              // row's real height once RN finishes that pass.
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
        {/* Closes the page, scrolling with it rather than sitting pinned
            beneath -- a footer pinned under a 200-product grid would be
            chrome permanently occupying the bottom of every browsing screen.
            The page's own trailing sibling now, not a nested list's
            ListFooterComponent -- the footer belongs to the page, not
            inside the bounded goods box. */}
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
  // The reading column, now on the PAGE-level ScrollView -- `alignSelf`
  // centres the scroller inside the page, `maxWidth` stops it growing with
  // the window -- which is the whole of what made a 26px wordmark sit in
  // 1,472px of empty panel. The goods FlatList below sits inside this bound
  // rather than carrying its own copy of it.
  scroller: { flex: 1, width: '100%', maxWidth: SHOP_MAX_WIDTH, alignSelf: 'center' },
  sectionHead: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline',
    paddingTop: 26, paddingBottom: 10, marginBottom: 4, borderBottomWidth: 1,
  },
  sectionTitle: { fontSize: TYPE.eyebrow, fontWeight: '800', letterSpacing: LETTER.meta, textTransform: 'uppercase' },
  sectionCount: { fontSize: TYPE.metaSmall, fontWeight: '700' },
  // The page's own breathing room -- header, goods box and footer are three
  // plain children of the same ScrollView now, `gap` standing in for the
  // space that used to fall out of the single FlatList's own `gap` landing
  // between ListHeaderComponent, each row, and ListFooterComponent as if
  // they were all one flat list of items.
  page: { padding: SPACE.page, gap: SPACE.cardGap },
  // B6: the sticky CheckoutBar is `position: absolute` and reserves no space
  // of its own -- without this, the footer (now the page's own bottom-most
  // scrolling content) sits underneath it.
  pageWithCheckoutBar: { paddingBottom: SPACE.page + CHECKOUT_BAR_CLEARANCE },
  // The goods FlatList's own base style -- `width: '100%'` rather than
  // `flex: 1`, since unbounded (one row or shorter) it must be its own
  // height as a plain child of the page's ScrollView, not stretch to fill
  // one. `maxHeight` is layered on top of this, never replacing it, exactly
  // when goodsScrollHeight returns non-null.
  goods: { width: '100%' },
  // No padding of its own any more -- that moved to `page` above, which now
  // wraps the goods box the same way it wraps the header and footer. Left
  // bare like this, the goods FlatList's own rendered height is EXACTLY two
  // measured rows plus one gap when bounded, with nothing hidden inside a
  // padding figure -- which is what makes that height something a browser
  // can verify against goodsScrollHeight's own arithmetic.
  grid: { gap: SPACE.cardGap },
  row: { gap: SPACE.cardGap },
  cell: { flex: 1 },
});
