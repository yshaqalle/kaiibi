import { Image, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';

import { pressable } from '@/components/storefront/press-feedback';
import { SHEET_MAX_WIDTH, SPACE, TABULAR, TOUCH_TARGET, TYPE } from '@/components/storefront/scale';
import { ProductActions } from '@/components/storefront/theme-shared';
import { AppModal } from '@/components/ui/app-modal';
import { formatCents } from '@/lib/currency';
import type { PaletteColors } from '@/lib/storefront-catalog';
import type { StorefrontProduct } from '@/types/models';

// SHEET_MAX_WIDTH now lives in scale.ts with the other measures, because
// CartSheet needs it too and importing it FROM here would have dragged this
// module's own import of theme-shared -- and behind that checkout-form,
// storefront-order and @/lib/supabase -- into a cart sheet that has no
// business with any of them. That is the same drag scale.ts was created to
// end (see ON_SCRIM_INK's comment there). Re-exported so this module's own
// callers and tests keep one obvious place to find it.
export { SHEET_MAX_WIDTH };

// A CEILING APPLIED TO `width: '100%'`, NOT A WIDTH SET DIRECTLY.
//
// This used to be handed straight to the sheet's own `width` -- a fixed
// pixel number that has no idea `overlay` (below) also carries
// `padding: SPACE.cardGap` on every side. A fixed-width child ignores a
// parent's padding; only a RELATIVE size (`100%`) shrinks to fit the padded
// content box a `padding` actually creates. At 390px that meant a 390-wide
// sheet inside a 390-wide window that ALSO had 14px of padding to fit on
// each side of it -- the sheet touched both edges, exactly the "ending short
// of that edge" `overlay`'s own comment (below) says a sheet must not do.
// `sheetWidth` (the call site, below) is now handed to `maxWidth` instead,
// capping how wide the sheet's own `width: '100%'` is allowed to grow once
// the overlay's padding has already been subtracted -- the identical
// `width: '100%', maxWidth: SHEET_MAX_WIDTH` pair CartSheet's own `sheet`
// style already uses against this same overlay shape.
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
        <View testID="product-sheet" style={[styles.sheet, { backgroundColor: colors.ground, maxWidth: sheetWidth }]}>
          <View style={styles.head}>
            {/* The grab handle is decorative -- a drag-to-dismiss a customer
                has to discover is not an affordance. The two REAL ways out are
                the dismiss button here and the Close button at the foot. */}
            <View style={[styles.grab, { backgroundColor: colors.soft }]} />
            {/* A VISIBLE WAY OUT AT THE TOP, not only at the bottom. Escape
                closes this sheet and nobody knows that; the foot's Close sits
                below a description that can be several screens long, so on a
                phone the customer who opened the wrong product had to scroll
                to leave it. A dismiss control belongs where the eye already is
                when the sheet appears. Absolutely positioned so it does not
                shift the handle off centre, and given a solid plate because it
                sits directly above a photograph whose colours it cannot know. */}
            <Pressable
              testID="product-sheet-dismiss"
              accessibilityRole="button"
              accessibilityLabel="Close"
              hitSlop={10}
              onPress={onClose}
              style={pressable([styles.dismiss, { backgroundColor: colors.ink }])}
            >
              <Text style={[styles.dismissGlyph, { color: colors.ground }]}>×</Text>
            </Pressable>
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
  // `alignItems: 'center'` is the horizontal half of "bound it and centre it";
  // `justifyContent: 'flex-end'` keeps the sheet bottom-anchored, which is
  // what makes it read as a sheet rather than a dialog.
  //
  // THE BOTTOM INSET IS NOT DECORATION. Flush against the window's bottom
  // edge, the Close button and the Add/Ask row are the first things a browser
  // download bar, a macOS dock, or a phone's home indicator covers -- and the
  // customer's report was exactly that, "we don't see the bottom", on a sheet
  // this file's own tests measured as ending precisely at the viewport edge.
  // Ending short of that edge costs one gap and means the last row of controls
  // is always visibly clear of whatever the operating system draws there.
  // The bottom inset is deliberately larger than the side ones: the sides only
  // have to clear the window, while the bottom has to clear whatever the
  // operating system draws over it, and a dock is taller than a gutter.
  overlay: {
    flex: 1, backgroundColor: 'rgba(11,11,13,0.45)',
    justifyContent: 'flex-end', alignItems: 'center',
    padding: SPACE.cardGap,
    paddingBottom: SPACE.cardGap + SPACE.card,
  },
  // Rounded on all four corners now that it floats: two square bottom corners
  // read as "cut off by the window" -- the very thing the inset above exists
  // to stop -- rather than as a card that ends.
  //
  // `width: '100%'`, capped by `maxWidth: sheetWidth` at the call site --
  // never a fixed `width` computed in JS. `overlay` above pads itself on
  // every side; only a relative width shrinks to fit the box that padding
  // leaves behind, which is what lets this sheet actually end short of the
  // window's edge on a phone rather than filling it corner to corner. The
  // identical pair CartSheet's own `sheet` style uses against the same
  // overlay shape (`width: '100%', maxWidth: SHEET_MAX_WIDTH`) -- see
  // `sheetWidthFor`'s own comment above for why this one is computed rather
  // than a bare re-export of that constant (the photo's height cap needs the
  // same window-derived treatment, and the two are documented together).
  sheet: { width: '100%', borderRadius: 24, maxHeight: '88%', overflow: 'hidden' },
  // Tall enough to hold the dismiss control that floats in it, so the button
  // sits in its own band rather than half over the photograph below.
  head: { alignItems: 'center', paddingTop: 9, paddingBottom: 4, justifyContent: 'center', minHeight: 42 },
  grab: { width: 38, height: 4, borderRadius: 999 },
  // INK, NOT `soft`. The first version of this filled with `soft` on a `ground`
  // sheet -- two near-whites, 1.05:1 apart -- and the customer's report was
  // "make the close icon visible", which is the only test that mattered. A
  // dismiss control is the one thing on a sheet that must be findable in the
  // first half-second, and it also has to survive sitting over the top of a
  // photograph whose colours it cannot know.
  //
  // 34px square: past the 24px a thumb needs, with `hitSlop` taking the real
  // target past 44. Inset far enough from the corner that it does not fight
  // the sheet's own 24px radius.
  dismiss: {
    position: 'absolute', right: 12, top: 4,
    width: 34, height: 34, borderRadius: 17,
    alignItems: 'center', justifyContent: 'center',
  },
  // Line height pinned to the box so the glyph sits optically centred -- '×'
  // carries its own descender-less bearing and drifts high without it.
  dismissGlyph: { fontSize: 20, fontWeight: '700', lineHeight: 22 },
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
  // TOUCH_TARGET, not a bigger padding number -- measured at 40px
  // (`paddingVertical: 12` around 13.5px text) before this floor existed.
  // Under 44, the same gap in the same sweep that missed `dismiss` above
  // reaching its own floor through `hitSlop` instead -- see this file's own
  // header comment on why that control took the other route.
  close: {
    borderRadius: 999, paddingVertical: 12, alignItems: 'center', marginTop: 10,
    minHeight: TOUCH_TARGET, justifyContent: 'center',
  },
  closeText: { fontSize: 13.5, fontWeight: '800' },
});
