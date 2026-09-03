import { Image, Pressable, StyleSheet, Text, View } from 'react-native';

import { pressable } from '@/components/storefront/press-feedback';
import { ProductActions } from '@/components/storefront/theme-shared';
import { DISPLAY_FONT, LETTER, RADIUS, TABULAR, TYPE } from '@/components/storefront/scale';
import { formatCents } from '@/lib/currency';
import type { PaletteColors } from '@/lib/storefront-catalog';
import type { StorefrontProduct } from '@/types/models';

type Props = {
  product: StorefrontProduct;
  colors: PaletteColors;
  // The shop context Ask needs to prefill a wa.me message, and -- since the
  // plate below -- the label on a no-photo tile as well. Optional because
  // this tile is used from theme-market.tsx / theme-window.tsx, which do not
  // forward storefront context yet -- a later task wires that in. Without a
  // number Ask does not render at all (commit 302630a) -- the same "offer
  // nothing rather than a dead chat" rule WhatsAppButton applies by hiding
  // itself. An Ask that renders and silently does nothing is the worse half
  // of both options: the customer taps and the app shrugs.
  shopName?: string;
  whatsappE164?: string | null;
  // Deliberately a callback, not an import of storefront-cart.ts: a cart
  // held in a stranger's browser has no business living inside a display
  // component, and every other storefront component reaches its data this
  // same prop-driven way (see ThemeProps).
  onAdd?: (product: StorefrontProduct) => void;
  // Opens the product sheet -- the only place products.description has ever
  // been rendered. Optional so a caller that has no sheet to open (every
  // test predating it) still gets a tile, just a non-interactive one.
  onOpen?: (product: StorefrontProduct) => void;
  // Two columns rather than three or four -- i.e. a phone. The price steps
  // down, because the size that anchors a card on a laptop costs a browsing
  // screen half its rows at 390px. Passed from the theme, which already
  // measures the window to pick a column count, so this component never
  // subscribes to dimensions of its own once per tile.
  dense?: boolean;
};

// THE NO-PHOTO BRANCH IS NOT AN ERROR STATE, and it is the majority case.
//
// products.image_url is nullable and most shops fill in a handful at best, so a
// grey box with a broken-image glyph would be what most shops look like and
// would make a working shop look abandoned.
//
// So the box becomes a price board instead: the product's own CATEGORY set
// small and tracked at the top, a hairline, and the product name in the display
// face centred below it.
//
// The label is the category and not the shop's name, which this first shipped
// as. A shop with twenty photo-less products would have printed its own name
// twenty-one times on one page -- and "say it once" is a rule this page already
// holds deliberately, pinned by the wordmark test in
// storefront-theme-window.test.tsx. The category is the label a real price
// board carries anyway, it differs between tiles, and it costs no new data:
// products.category is already fetched and already what Counter groups by.
export function ProductTile({ product, colors, shopName, whatsappE164, onAdd, onOpen, dense }: Props) {
  const outOfStock = product.stock <= 0;
  const hasPhoto = Boolean(product.imageUrl);

  // THE OPEN TARGET IS THE INFORMATION, NOT THE WHOLE TILE, and that is a
  // correctness constraint rather than a taste one.
  //
  // Wrapping the entire tile -- Add and Ask included -- put a Pressable inside
  // a Pressable, which react-native-web renders as a <button> inside a
  // <button>. That is invalid HTML and React reports it as a hydration error;
  // this page is opened in a browser far more often than in an app, so "works
  // on native" is not good enough. Nothing in jest catches it either, because
  // react-test-renderer does not validate HTML nesting -- it showed up the
  // first time this was loaded in a real browser.
  //
  // Splitting it is also the better interaction: a thumb going for Add should
  // never be ambiguous about whether it opens the sheet instead.
  const Info = onOpen ? Pressable : View;
  const infoProps = onOpen
    ? {
        testID: 'product-tile-open',
        accessibilityRole: 'button' as const,
        accessibilityLabel: `${product.name}, ${formatCents(product.priceCents)}`,
        onPress: () => onOpen(product),
        style: pressable(styles.info),
      }
    : { style: styles.info };

  return (
    <View style={[styles.tile, { backgroundColor: colors.ground }]}>
      <Info {...infoProps}>
        <View style={[styles.box, { backgroundColor: colors.soft }]}>
          {product.imageUrl ? (
            <Image source={{ uri: product.imageUrl }} style={styles.photo} resizeMode="cover" />
          ) : (
            <View style={styles.plate}>
              {product.category ? (
                <Text
                  style={[styles.plateLabel, { color: colors.muted, borderBottomColor: colors.ground }]}
                  numberOfLines={1}
                >
                  {product.category}
                </Text>
              ) : null}
              <View style={styles.plateBody}>
                <Text style={[styles.plateName, { color: colors.ink }]} numberOfLines={4}>
                  {product.name}
                </Text>
              </View>
            </View>
          )}
        </View>

        <View style={styles.body}>
          {/* THE NAME SLOT IS RESERVED WHETHER OR NOT IT IS FILLED. A plate
              tile carries its name on the plate, a photo tile carries it here
              -- and without holding the space, the two sit at different
              heights and no two prices in a mixed row line up. A grid of
              prices that does not line up is the tell that nobody set the
              type, which is the same reason TABULAR exists. */}
          <View style={styles.nameSlot}>
            {hasPhoto ? (
              <Text style={[styles.name, { color: colors.ink }]} numberOfLines={2}>
                {product.name}
              </Text>
            ) : null}
          </View>

          <Text style={[styles.price, dense && styles.priceDense, { color: colors.ink }]}>
            {formatCents(product.priceCents)}
          </Text>

          {/* Shape carries the state, colour is the second signal -- never the
              only one. In stock is the state nearly every product is in, so it
              is set in muted ink and spends no colour; sold out is the
              exception, so it gets a hollow dot AND the palette's own derived
              amber. See storefront-catalog.ts on why there is no stockOk to
              match stockOut.

              The dot is a VIEW, not a glyph in the string. A "○ " prefix would
              make the label "○ Out of stock" -- which a screen reader reads
              aloud, and which stops the visible text being the plain words any
              caller (or test) can match on. Same hollow dot the stock card
              uses for the same product. */}
          {outOfStock ? (
            <View style={styles.stockRow}>
              <View style={[styles.stockDot, { borderColor: colors.stockOut }]} />
              <Text style={[styles.stock, { color: colors.stockOut }]}>Out of stock</Text>
            </View>
          ) : (
            <Text style={[styles.stock, { color: colors.muted }]}>In stock</Text>
          )}
        </View>
      </Info>

      {/* A SIBLING of the open target, never a child -- see the comment above
          on nested buttons. */}
      <View style={styles.actions}>
        <ProductActions product={product} colors={colors} shopName={shopName} whatsappE164={whatsappE164} onAdd={onAdd} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  // Borderless: on a bento page the separation is the page tone behind the
  // card, and a hairline on top of that reads as a box drawn around nothing.
  tile: { borderRadius: RADIUS.card, padding: 14 },
  info: {},
  // Square, not 4:5. A taller box is better for photographs and worse for the
  // plate, and the plate is the majority case -- 4:5 spends the extra height
  // on empty soft.
  box: { aspectRatio: 1, width: '100%', borderRadius: RADIUS.inset, overflow: 'hidden' },
  photo: { ...StyleSheet.absoluteFill },
  plate: { flex: 1, padding: 13 },
  plateLabel: {
    fontSize: 9.5, fontWeight: '800', letterSpacing: LETTER.metaWide, textTransform: 'uppercase',
    paddingBottom: 9, borderBottomWidth: 1,
  },
  // Centred in what is left below the rule rather than pinned to an edge: a
  // short name pinned to the bottom left a plate that read as unfinished, and
  // pinned to the top it read as a caption with nothing under it.
  plateBody: { flex: 1, justifyContent: 'center' },
  plateName: { fontFamily: DISPLAY_FONT, fontSize: 20, fontWeight: '700', lineHeight: 24, letterSpacing: -0.4 },
  body: { paddingTop: 11 },
  // Two lines at 13/1.3, held whether or not there is a name to put in it.
  nameSlot: { minHeight: 34 },
  name: { fontSize: 13, fontWeight: '700', lineHeight: 17 },
  price: { fontSize: TYPE.price, fontWeight: '800', letterSpacing: -0.8, marginTop: 2, ...TABULAR },
  priceDense: { fontSize: TYPE.priceDenseGrid, letterSpacing: -0.6 },
  stock: { fontSize: 11.5, fontWeight: '700', marginTop: 3 },
  stockRow: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  stockDot: { width: 8, height: 8, borderRadius: RADIUS.pill, borderWidth: 1.5, marginTop: 3 },
  actions: { paddingTop: 12 },
});
