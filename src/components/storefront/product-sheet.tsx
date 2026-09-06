import { Image, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';

import { pressable } from '@/components/storefront/press-feedback';
import { TABULAR, TYPE } from '@/components/storefront/scale';
import { ProductActions } from '@/components/storefront/theme-shared';
import { AppModal } from '@/components/ui/app-modal';
import { formatCents } from '@/lib/currency';
import type { PaletteColors } from '@/lib/storefront-catalog';
import type { StorefrontProduct } from '@/types/models';

// THE SHEET GETS ITS OWN MEASURE, NARROWER THAN EITHER SHOP_MAX_WIDTH OR
// PROSE_MAX_WIDTH (scale.ts).
//
// This is what actually produced the screenshot the fix came from: the sheet
// had no width bound at all, so on a 1512px window it spanned the window and
// a 4:3 photo took 4:3 OF THAT -- over a thousand pixels tall. PROSE_MAX_WIDTH
// (820) is picked for a page of running prose; a product sheet is one photo
// and a name and a price and a short paragraph, which is a narrower thing
// than a page of prose, the same way scale.ts argues PROSE_MAX_WIDTH is
// narrower than SHOP_MAX_WIDTH. 480 is not derived from either number --
// it's picked so the sheet reads as a CARD floating over the dimmed grid,
// which is what makes tapping outside it (or Close) feel like dismissing one
// thing, not leaving a second page.
//
// Math.min, not a fixed width: below 480 the sheet still fills the window
// edge-to-edge, because a phone is the shape this component was built for
// first, and a card narrower than the phone that opened it would wrap text
// for no reason.
export const SHEET_MAX_WIDTH = 480;

export function sheetWidthFor(windowWidth: number): number {
  return Math.min(windowWidth, SHEET_MAX_WIDTH);
}

// THE PHOTO'S CEILING IS THE WINDOW'S OWN HEIGHT, NOT A GUESS.
//
// The photo keeps its 4:3 shape (`styles.photo` below) up to this ceiling --
// it only bites when 4:3 of the sheet's own width would draw a photo taller
// than the window has room for underneath it.
//
// At phone heights this never fires. A 390px-wide sheet has a ~354px-wide
// photo column (body's 18px padding both sides), which draws a natural 4:3
// height around 265 -- comfortably under 40% of even the shortest phone this
// page supports, so the photo stays exactly the shape the rest of this file's
// comments describe.
//
// It fires on a SHORT, WIDE window instead -- the 1512x700 laptop the
// original screenshot came from. There the sheet is capped to
// SHEET_MAX_WIDTH (480), and 4:3 of that photo column still draws ~333px --
// taller than name, price, Add/Ask and Close have left to share in the 88%
// of 700px (`styles.sheet`'s own `maxHeight`) this sheet is allowed. 40% of
// 700 is 280: the fifty-some pixels handed back are exactly what put the
// Close button back on screen.
export function photoHeightCapFor(windowHeight: number): number {
  return Math.round(windowHeight * 0.4);
}

type Props = {
  product: StorefrontProduct | null;
  colors: PaletteColors;
  shopName: string;
  whatsappE164: string | null;
  onClose: () => void;
  onAdd: (product: StorefrontProduct) => void;
};

// The one place `products.description` has ever had somewhere to live.
//
// The column has been selected by get_public_storefront_products since the
// storefront shipped and mapped in storefront.ts, and no theme rendered it.
// Shopkeepers typed it and no customer ever saw a word -- data paid for on
// every page load and thrown away on arrival.
//
// It also gives the product tile a reason to be pressable, which is what a
// customer's thumb tries first on any shop page and which did nothing at all
// until now.
//
// WHAT THIS IS NOT: a route. Browsing, cart, checkout and confirmation all
// happen on one screen precisely so a flaky connection mid-order never loses
// the cart (see theme-market.tsx). A product detail PAGE would be the first
// thing on this page to break that rule, and a modal costs nothing by
// comparison -- back/Escape closes it, and the grid underneath keeps its
// scroll position.
export function ProductSheet({ product, colors, shopName, whatsappE164, onClose, onAdd }: Props) {
  // Driven by `product` rather than a separate `visible` flag: two sources of
  // truth for "is the sheet open" is how a sheet ends up open with nothing in
  // it after the list refreshes.
  // Read unconditionally, ahead of the early return below -- a hook cannot
  // follow one. See this file's own comments on `sheetWidthFor` and
  // `photoHeightCapFor` (above the `Props` type) for why these are
  // window-derived rather than fixed numbers.
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const sheetWidth = sheetWidthFor(windowWidth);
  const photoHeightCap = photoHeightCapFor(windowHeight);

  if (!product) return null;

  const outOfStock = product.stock <= 0;

  return (
    <AppModal visible transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View testID="product-sheet" style={[styles.sheet, { backgroundColor: colors.ground, width: sheetWidth }]}>
          <View style={styles.head}>
            {/* The grab handle is decorative -- the Close button below is the
                real affordance, because a drag-to-dismiss a customer has to
                discover is not one. */}
            <View style={[styles.grab, { backgroundColor: colors.soft }]} />
          </View>

          <ScrollView testID="product-sheet-scroll" style={styles.scroll} contentContainerStyle={styles.body}>
            {/* NO placeholder when there is no photo, which is the opposite of
                what ProductTile does -- and deliberately so.

                A tile is mostly picture, so its no-photo branch has to fill
                that space with something intentional (the name, set large on
                `soft`). A sheet is mostly WORDS: it already leads with the
                name at 22px, then the price, then the description. A 4:3 block
                here would repeat the name it sits directly above and push the
                description -- the entire reason this component exists -- below
                the fold on a phone.

                Verified in a browser at 400x880, which is where both of those
                problems were visible and neither was in jest. */}
            {product.imageUrl ? (
              <Image
                source={{ uri: product.imageUrl }}
                style={[styles.photo, { maxHeight: photoHeightCap }]}
                resizeMode="cover"
              />
            ) : null}

            <Text style={[styles.name, { color: colors.ink }]}>{product.name}</Text>

            <View style={styles.priceRow}>
              <Text style={[styles.price, { color: colors.ink }]}>{formatCents(product.priceCents)}</Text>
              {outOfStock ? (
                <View style={[styles.stockPill, { backgroundColor: colors.soft }]}>
                  <Text style={[styles.stockPillText, { color: colors.stockOut }]}>Out of stock</Text>
                </View>
              ) : (
                <Text style={[styles.stock, { color: colors.ink }]}>In stock</Text>
              )}
            </View>

            {/* The point of the whole component. Rendered only when there is
                one -- an empty paragraph gap under the price would read as a
                loading state that never resolves. */}
            {product.description ? (
              <Text testID="product-sheet-description" style={[styles.description, { color: colors.muted }]}>
                {product.description}
              </Text>
            ) : null}

            {product.category ? (
              <Text style={[styles.category, { color: colors.muted }]}>{product.category.toUpperCase()}</Text>
            ) : null}
          </ScrollView>

          {/* STRUCTURAL FURNITURE, NOT CONTENT -- a sibling of the ScrollView
              above rather than its last child.
              `description` (rendered above, inside the scroller) has no
              clamp, no `numberOfLines`, and no length limit in the schema --
              a shopkeeper can type as much of it as they like. When Add, Ask
              and Close lived at the bottom of that same scrolling body, a
              long-enough description pushed all three below the fold on a
              short window: the customer opens a product and cannot see the
              button that buys it without scrolling past their own product's
              description first. That is the same defect `sheetWidthFor` and
              `photoHeightCapFor` (above) fixed for the photo, reached instead
              through text. Pinning this row outside the scroller, at the
              sheet's own bottom edge, is what makes it structurally
              impossible for content -- a photo, a paragraph, or whatever the
              next thing added to the scroller turns out to be -- to cover it
              again. */}
          <View style={[styles.footer, { borderTopColor: colors.hairline }]}>
            <ProductActions
              product={product}
              colors={colors}
              shopName={shopName}
              whatsappE164={whatsappE164}
              // This sheet renders inside an AppModal (see this file's own
              // header comment) -- on iOS and Android a Modal is a
              // separate native window, so FlyToCartLayer's overlay (mounted
              // once in ShopChrome, under the grid) is not part of what
              // that window draws. The dot would arc across a surface
              // nobody looking at the sheet can see, and the slip it is
              // racing toward sits behind the sheet besides. The cart
              // update and the slip's own bump/count-up still happen --
              // only the dot's flight is skipped.
              canFlyToCart={false}
              // Add, then close: leaving the sheet open over a grid whose
              // cart button has just changed hides the only feedback the
              // action gives.
              onAdd={(p) => {
                onAdd(p);
                onClose();
              }}
            />

            <Pressable
              testID="product-sheet-close"
              accessibilityRole="button"
              accessibilityLabel="Close"
              onPress={onClose}
              style={pressable([styles.close, { backgroundColor: colors.soft }])}
            >
              <Text style={[styles.closeText, { color: colors.ink }]}>Close</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </AppModal>
  );
}

const styles = StyleSheet.create({
  // `alignItems: 'center'` is the horizontal half of "bound it and centre
  // it" (see `sheetWidthFor`'s own comment) -- `justifyContent: 'flex-end'`
  // stays untouched, because the sheet is still bottom-anchored.
  overlay: { flex: 1, backgroundColor: 'rgba(11,11,13,0.45)', justifyContent: 'flex-end', alignItems: 'center' },
  sheet: { borderTopLeftRadius: 24, borderTopRightRadius: 24, maxHeight: '88%', overflow: 'hidden' },
  head: { alignItems: 'center', paddingTop: 9, paddingBottom: 4 },
  grab: { width: 38, height: 4, borderRadius: 999 },
  // `flexShrink: 1`, not `flex: 1` -- this scroller has no reason to GROW
  // past its own content (a short product with no photo should not stretch
  // to fill the sheet), only to SHRINK when its content plus the footer
  // below would otherwise exceed `sheet`'s own `maxHeight: '88%'`. RN's
  // default `flexShrink` on a View is 0, unlike web's flexbox default of 1 --
  // leaving this off is exactly how the footer below was reachable through
  // `overflow: 'hidden'` clipping it off the bottom of the sheet rather than
  // through the scroller ever getting a chance to scroll past it.
  scroll: { flexShrink: 1 },
  body: { paddingHorizontal: 18, paddingBottom: 18, paddingTop: 6 },
  photo: { width: '100%', aspectRatio: 4 / 3, borderRadius: 14, marginBottom: 14 },
  name: { fontSize: TYPE.headline, fontWeight: '800', letterSpacing: -0.4, lineHeight: 27 },
  priceRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 9 },
  price: { fontSize: 22, fontWeight: '800', letterSpacing: -0.4, ...TABULAR },
  stock: { fontSize: TYPE.meta, fontWeight: '700' },
  stockPill: { borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2 },
  stockPillText: { fontSize: TYPE.metaSmall, fontWeight: '800', letterSpacing: 0.2 },
  description: { fontSize: TYPE.body, lineHeight: 20, marginTop: 12 },
  category: { fontSize: TYPE.metaSmall, fontWeight: '800', letterSpacing: 1, marginTop: 14 },
  // The hairline is the footer's own visual separation from whatever is
  // scrolled underneath it -- the same device `Fact` (theme-shared.tsx) uses
  // between bands of the same tone, drawn from `colors.hairline` rather than
  // a hex literal for the same reason: it is a palette value, not a fixed
  // one, because this sheet renders on top of one of seven palettes.
  footer: { paddingHorizontal: 18, paddingTop: 14, paddingBottom: 18, borderTopWidth: 1 },
  close: { borderRadius: 999, paddingVertical: 12, alignItems: 'center', marginTop: 10 },
  closeText: { fontSize: 13.5, fontWeight: '800' },
});
