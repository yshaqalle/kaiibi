import { useState } from 'react';
import { FlatList, Image, StyleSheet, Text, View, useWindowDimensions } from 'react-native';

import { CartSheet } from '@/components/storefront/cart-sheet';
import { CategoryBand } from '@/components/storefront/category-band';
import { FlyerCarousel } from '@/components/storefront/flyer-carousel';
import { ProductSheet } from '@/components/storefront/product-sheet';
import { ProductTile } from '@/components/storefront/product-tile';
import {
  CartButton, CategoryFilterBar, CHECKOUT_BAR_CLEARANCE, CheckoutBar, CheckoutScreen, ConfirmationScreen, EmptyState,
  NoSearchResults, SearchField, WhatsAppButton, filterByCategory, gridColumnsForWidth, useCheckoutFlow,
  useStorefrontCart, type ThemeProps,
} from '@/components/storefront/theme-shared';
import { searchProducts, shouldOfferSearch } from '@/lib/storefront-search';
import { DISPLAY_FONT, LETTER, SPACE, TYPE } from '@/components/storefront/scale';
import { collectLocation } from '@/lib/storefront-collect';
import type { StorefrontProduct } from '@/types/models';

// Type ON the scrim, not on any palette -- and so deliberately fixed, the same
// way WHATSAPP_BUTTON_GREEN is. The scrim's bottom is rgba(0,0,0,.55) over an
// unknown photograph, which is a dark ground in every case the branch can
// reach; a palette's own ink is near-black and would vanish into it. These are
// the two values that stay readable on that ground regardless of which of the
// six palettes the shop picked, so they are not derived from any of them.
const ON_SCRIM_INK = '#ffffff';
// The about line's quieter step. Off-white rather than an opacity on white:
// an opacity would composite differently against every photo, and this stays
// a value that can be reasoned about and tested.
const ON_SCRIM_MUTED = '#e8e6e0';

// The only theme that reads hero_image_url. When there isn't one the hero falls
// back to a flat panel carrying the headline -- which still looks intentional.
// That is the test every theme in this set had to pass.
export function ThemeWindow({ storefront, products, colors, areas = [], categories = [] }: ThemeProps) {
  const { width } = useWindowDimensions();
  const numColumns = gridColumnsForWidth(width);
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
  // Named once rather than re-testing `storefront.heroImageUrl` at five call
  // sites: which hero renders is one decision, and it reads as one here.
  const onPhoto = Boolean(storefront.heroImageUrl);
  // collectLocation already composes [address, neighbourhood, city] and drops
  // the empties, so it ENDS with the city whenever there is one -- joining the
  // city to it as well printed "Hargeisa · Jigjiga Yar, Hargeisa". Prefer the
  // fuller line and fall back to the city alone; never both.
  const eyebrow =
    collectLocation(storefront.collectAddress, storefront.collectNeighborhood, storefront.city) ?? storefront.city;
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
      {/* WINDOW'S NAV CARRIES NO NAME, and that is the point of the hero below
          rather than an omission. The name used to sit here at 15px, tracked
          out, above a 28px headline -- so the loudest thing on the page was the
          shop's slogan and the quietest was whose shop it is. A customer
          arriving on a forwarded WhatsApp link needs the second one first.

          It moves into the hero as the wordmark. Repeating it in both places
          would be the same name twice on a 390px screen. Market and Counter
          keep theirs in the nav: neither has a hero panel to hand it to. */}
      <View style={styles.nav} testID="storefront-header">
        <View style={styles.navActions}>
          <WhatsAppButton storefront={storefront} />
          <CartButton colors={colors} count={itemCount} onPress={() => setCartOpen(true)} />
        </View>
      </View>

      {/* Two heroes in one panel, and which one renders is decided by whether
          the shop uploaded a photo -- NOT by a style flag a caller can get
          wrong.

          Over a photo: a scrim, then white type. Without it, the headline was
          set in `colors.ink` -- a near-black -- directly on whatever image the
          shop chose, so a dark or busy photo produced an unreadable headline
          and nothing in the editor warned them. A shop cannot be asked to only
          upload photos that happen to suit near-black text.

          Without a photo: the palette's own soft panel and ink type, unchanged.
          That branch is the MAJORITY case (most shops upload nothing) and is
          not a degraded version of the other one -- it has to look intentional
          on its own, which is the test every theme in this set had to pass. */}
      <View style={[styles.hero, { backgroundColor: colors.soft }, onPhoto && styles.heroWithPhoto]}>
        {onPhoto ? (
          <>
            <Image source={{ uri: storefront.heroImageUrl! }} style={styles.heroImage} resizeMode="cover" />
            {/* Sits between the photo and the type, and nowhere else -- a
                scrim on the no-photo panel would only dim the shop's own
                colour for no reason. */}
            <View testID="storefront-hero-scrim" style={styles.heroScrim} pointerEvents="none" />
          </>
        ) : null}
        {/* NO GRADIENT ON THE NO-PHOTO PANEL, and that is a reversal worth
            recording. It was built with react-native-svg (already a dependency)
            as a wash from `ground` down to `soft` -- and in a browser the Svg
            laid itself out at an intrinsic size instead of filling its
            absolutely-positioned parent, so a hard rectangular edge showed
            past the panel's rounded corner. Seen immediately on screen,
            invisible to jest.
            
            Rather than tune an SVG to fake a gradient, it is gone. The original
            complaint about this panel was that nothing justified its height,
            and what fixes that is the wordmark and the eyebrow now leading it
            -- not a wash almost nobody would consciously notice. A flat `soft`
            panel with type set on it is the cheaper and more robust answer. */}

        {/* The wordmark. The biggest thing on the page, because "whose shop is
            this" is the first question a forwarded link has to answer. */}
        <Text
          testID="storefront-wordmark"
          style={[
            styles.wordmark,
            onPhoto && styles.onScrimText,
            { color: onPhoto ? ON_SCRIM_INK : colors.ink },
          ]}
          numberOfLines={2}
          adjustsFontSizeToFit
          minimumFontScale={0.7}
        >
          {storefront.shopName}
        </Text>

        {/* Composed from what the page already holds -- city and the same
            collectLocation() the checkout and confirmation screens print -- so
            it is never an empty line. At least one of the two is populated for
            every shop (see PublicStorefront's own note on collectNeighborhood),
            and if somehow neither is, the line does not render at all rather
            than rendering a separator with nothing either side of it. */}
        {eyebrow ? (
          <Text
            testID="storefront-eyebrow"
            style={[
              styles.eyebrow,
              onPhoto && styles.onScrimText,
              { color: onPhoto ? ON_SCRIM_MUTED : colors.muted },
            ]}
          >
            {eyebrow}
          </Text>
        ) : null}

        {storefront.headline ? (
          <Text
            testID="storefront-headline"
            style={[
              styles.heroHead,
              onPhoto && styles.onScrimText,
              { color: onPhoto ? ON_SCRIM_INK : colors.ink },
            ]}
          >
            {storefront.headline}
          </Text>
        ) : null}
        {storefront.about ? (
          <Text
            testID="storefront-about"
            style={[
              styles.heroAbout,
              onPhoto && styles.onScrimText,
              { color: onPhoto ? ON_SCRIM_MUTED : colors.muted },
            ]}
          >
            {storefront.about}
          </Text>
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
      {/* Above the filter chip, not below: the band is how a customer
          CHOOSES a category and the chip is how they leave one, so the
          chip belongs next to the grid it is narrowing. */}
      <CategoryBand categories={categories} colors={colors} active={category} onSelect={setCategory} />
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
  // See theme-market.tsx's identical comment on `nav`/`navActions`: `flexWrap`
  // is what lets WhatsApp + Cart drop to their own line rather than run
  // the row off a phone's edge, and `marginLeft: 'auto'` (not
  // `justifyContent: 'space-between'`) is what keeps that pair pinned to
  // the trailing edge whether it shares line one with the name or not.
  nav: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', padding: SPACE.page, gap: SPACE.gap },
  navActions: { flexDirection: 'row', alignItems: 'center', gap: 8, marginLeft: 'auto', flexShrink: 0 },
  // Window has no separate name wrapper (no city line under it, unlike
  // Market/Counter) -- `shopName` is the Text node itself, so it takes the
  // `flexShrink` Market puts on a wrapping View instead.
  hero: { marginHorizontal: SPACE.page, borderRadius: 20, paddingHorizontal: 24, paddingTop: 34, paddingBottom: 28, overflow: 'hidden' },
  // A photo hero earns more height than a wash does -- there is something to
  // look at.
  heroWithPhoto: { paddingTop: 64, paddingBottom: 24 },
  // 26, not 30: a serif sets WIDER than the sans at the same size, and
  // "Xamdi Electronics" at 30 ran past the panel on a 390px screen. Shop names
  // are not length-limited anywhere, so `adjustsFontSizeToFit` carries the
  // genuinely long ones down rather than letting them wrap to three lines.
  wordmark: { fontFamily: DISPLAY_FONT, fontSize: 26, fontWeight: '700', letterSpacing: -0.4, lineHeight: 32 },
  eyebrow: { fontSize: TYPE.metaSmall, fontWeight: '800', letterSpacing: LETTER.meta, textTransform: 'uppercase', marginTop: 10 },
  heroImage: { ...StyleSheet.absoluteFill },
  // A FLAT scrim, not a gradient, and covering the whole panel rather than
  // weighted to one edge: the headline and the about line flow from the TOP of
  // this panel, so the area that needs darkening is the area the text is in,
  // which here is all of it. (The visual pass proposes moving the type to the
  // bottom as a wordmark -- when that lands, this becomes a bottom-weighted
  // gradient and needs react-native-svg or a gradient dependency. It is not
  // worth either today, for a rectangle.)
  //
  // WHAT 0.55 DOES AND DOES NOT BUY. Against a mid or dark photo it clears
  // 4.5:1 for white type comfortably. Against a near-WHITE photo it does not,
  // and no fixed alpha does without dimming the picture into a grey block --
  // a pure-white image under a 0.55 black scrim still leaves white text at
  // about 2:1. The textShadow below is what carries that worst case: an
  // outline that does not depend on the photo behind it. Guaranteeing the
  // ratio outright means not setting type over an arbitrary photo at all,
  // which is a layout decision for the visual pass, not a bug fix.
  heroScrim: { ...StyleSheet.absoluteFill, backgroundColor: 'rgba(0,0,0,0.55)' },
  // Steps DOWN from the wordmark now that the name leads -- the slogan is
  // the second thing said, not the first.
  heroHead: { fontSize: TYPE.headline, fontWeight: '700', letterSpacing: LETTER.display, lineHeight: 26, marginTop: 14 },
  heroAbout: { fontSize: TYPE.body, marginTop: 9 },
  // Applied only on the photo branch -- a shadow on the flat soft panel would
  // be a smudge under near-black type on a light ground, solving nothing.
  onScrimText: { textShadowColor: 'rgba(0,0,0,0.65)', textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 4 },
  grid: { padding: SPACE.page, gap: SPACE.page },
  gridWithCheckoutBar: { paddingBottom: SPACE.page + CHECKOUT_BAR_CLEARANCE },
  row: { gap: SPACE.page },
  cell: { flex: 1 },
});
