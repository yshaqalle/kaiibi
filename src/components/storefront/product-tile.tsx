import { useState } from 'react';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';

import { supportsHover } from '@/components/storefront/mouse-pan';
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

// The NEW badge's threshold, in days. The mockup's own call ("the web-store
// vocabulary", §4): "products carry a created-at; anything <=14 days wears an
// accent chip." Inclusive of the boundary itself -- a product added exactly
// 14*24h ago still reads as "new stock" to a customer who checks in weekly,
// and the alternative (exclusive) would quietly make the badge's own window
// 13 days wherever `now` lands mid-day.
const NEW_BADGE_WINDOW_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

// PURE: a function of (createdAt, now), never of Date.now() called inline --
// which is what keeps "is this new" a fact a test can pin at an exact instant
// rather than a moving target that only ever passes today.
//
// `createdAt` is nullable AND optional on purpose (see StorefrontProduct):
// get_public_storefront_products only started returning this column in
// 20261102000000, so a client running ahead of its own database gets rows
// with the key simply absent. Both that case and an explicit `null` fail
// CLOSED here -- no badge -- which is the same "a client shipped ahead of its
// database must not show something it cannot back up" rule hideBranding
// (storefront.ts) applies the other way around (must not HIDE something it
// cannot confirm the shop paid to hide). A malformed timestamp fails closed
// too: `new Date('garbage')` is Invalid Date, and Invalid Date arithmetic
// produces NaN, which every comparison below is false against -- guarded
// explicitly with Number.isNaN rather than left to rely on that accident.
export function isProductNew(createdAt: string | null | undefined, now: Date): boolean {
  if (!createdAt) return false;
  const created = new Date(createdAt);
  if (Number.isNaN(created.getTime())) return false;
  const ageMs = now.getTime() - created.getTime();
  return ageMs >= 0 && ageMs <= NEW_BADGE_WINDOW_DAYS * DAY_MS;
}

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
  // WEB HOVER-LIFT, NEVER NATIVE. `supportsHover()` (mouse-pan.ts) is the
  // same `(hover: hover)` gate CategoryBand and FlyerCarousel already arm
  // their own hover affordances with, checked once at mount rather than
  // trusted to fall out of "no mouse event fired" -- `Platform.OS==='web'`
  // alone is TRUE in a phone's browser too, and mobile WebKit/Chrome
  // synthesise a `mouseenter` after a tap ("ghost hover") that a
  // platform-only gate cannot tell apart from a real mouse.
  const [hoverCapable] = useState(supportsHover);
  const [hovered, setHovered] = useState(false);

  // NO COLLISION WITH PRESS-FEEDBACK, BY CONSTRUCTION rather than by
  // careful merging -- Task 15's own defect (RN style flattening replaces a
  // whole `transform` array on key collision, rather than merging it
  // element-by-element) only happens when two transforms share ONE style
  // array on ONE node. This hover lift lives on the OUTER `styles.tile`
  // View below; every pressable inside it (Info, Add, Ask) carries its own
  // `pressable()` press-scale on ITS OWN node. A mouse hovering the card
  // and a thumb (or a synthetic click) pressing Add inside it therefore
  // animate two different views, and neither's `transform` array is ever
  // the one RN flattens the other into.
  //
  // A plain boolean toggle, not a timed animation -- direct manipulation
  // (the pointer is still there, hovering) rather than unbidden movement,
  // the same reasoning press-feedback.ts gives for needing no
  // reduced-motion gate on its own press-scale, and CategoryTile's
  // identical `tileHovered` already relies on (category-band.tsx).
  // Cast to `any` at the spread site, the same idiom category-band.tsx's own
  // web-only pointer props use: RN's `ViewProps` has no `onMouseEnter`/
  // `onMouseLeave` -- react-native-web forwards them straight to the DOM
  // node regardless (its own `forwardedProps.mouseProps` list), which RN's
  // types were never written to describe.
  const hoverProps = hoverCapable
    ? ({ onMouseEnter: () => setHovered(true), onMouseLeave: () => setHovered(false) } as any)
    : {};

  const outOfStock = product.stock <= 0;
  const hasPhoto = Boolean(product.imageUrl);
  // Only on a photo, matching the mockup vocabulary this is drawn from: the
  // badge sits on the PHOTO ("top-right of the photo"), the same surface the
  // price pill below needs. A photoless product's box is the plate -- its own
  // category/name board, never asked to carry a chip that has no photo under
  // it either. `new Date()` is called exactly once, here, and never inside
  // isProductNew itself -- see that function's own comment for why.
  const isNew = hasPhoto && isProductNew(product.createdAt, new Date());

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
    <View
      testID="product-tile"
      style={[
        styles.tile,
        { backgroundColor: colors.ground, shadowColor: colors.ink },
        hovered && styles.tileHovered,
      ]}
      {...hoverProps}
    >
      <Info {...infoProps}>
        <View style={[styles.box, { backgroundColor: colors.soft }]}>
          {product.imageUrl ? (
            <>
              <Image source={{ uri: product.imageUrl }} style={styles.photo} resizeMode="cover" />
              {/* THE PRICE TAG ON THE PHOTO -- the mockup's own name for this
                  (the web-store vocabulary, §4): "a `ground` pill sitting on
                  the image, where the tag's shots put it." It is the ONLY
                  place the price renders once there is a photo -- see the
                  body below, which drops its own price line in that case --
                  so a photo tile never says the number twice. */}
              <View
                testID="product-tile-price-pill"
                style={[styles.pricePill, dense && styles.pricePillDense, { backgroundColor: colors.ground, shadowColor: colors.ink }]}
              >
                <Text style={[styles.pricePillText, dense && styles.pricePillTextDense, { color: colors.ink }]}>
                  {formatCents(product.priceCents)}
                </Text>
              </View>
              {isNew ? (
                <View testID="product-tile-new-badge" style={[styles.newBadge, { backgroundColor: colors.accent }]}>
                  <Text style={[styles.newBadgeText, { color: colors.ground }]}>NEW</Text>
                </View>
              ) : null}
            </>
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
              heights and no two names in a mixed row line up. */}
          <View style={styles.nameSlot}>
            {hasPhoto ? (
              <Text style={[styles.name, { color: colors.ink }]} numberOfLines={2}>
                {product.name}
              </Text>
            ) : null}
          </View>

          {/* THE SLOT IS RESERVED HERE TOO, for the identical reason
              nameSlot above is: without holding the space, a photo tile's
              body (name + stock, price left it) and a photoless tile's body
              (price + stock, price never had anywhere else to go -- "the
              price pill has nothing to sit on") end up different heights,
              and a grid row mixing the two -- an ordinary shop, some products
              photographed and some not -- would show their Add buttons at
              two different heights. So this stays name-slot's neighbour:
              filled with the price line only when there is no photo, empty
              and merely holding its height when there is (the photo case's
              price already rendered on the photo, as the pill, one row up).
              This is the "text block simplifies to name + stock word" the
              brief asks for -- simplifies to LOOK AT, not a taller or
              shorter box than its photoless neighbour. */}
          <View style={[styles.priceSlot, dense && styles.priceSlotDense]}>
            {hasPhoto ? null : (
              <Text style={[styles.price, dense && styles.priceDense, { color: colors.ink }]}>
                {formatCents(product.priceCents)}
              </Text>
            )}
          </View>

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
  //
  // "0 2 10 rgba(ink,.06)" -- the mockup's own tile shadow (.w3tile) --
  // expressed as RN's shadow* props plus `elevation` for Android, the same
  // idiom styles.slip and Task 13's styles.searchCard already use (both
  // below, in theme-shared.tsx): shadowColor passed inline at the call site
  // rather than a literal here, because a fixed black would look wrong
  // against a palette whose `ink` is not black (see searchCard's own comment
  // on why `colors.ink` needs no colour literal of its own).
  tile: {
    borderRadius: RADIUS.card, padding: 14,
    shadowOpacity: 0.06, shadowRadius: 10, shadowOffset: { width: 0, height: 2 }, elevation: 2,
  },
  // Web hover only (`hoverProps` above gates `hovered` itself to
  // `hoverCapable`) -- the mockup's own `.ktile:hover{transform:
  // translateY(-3px)}` plus a deeper shadow, on the OUTER card rather than
  // any pressable inside it. Transform + shadow only, no layout property,
  // so this never displaces a neighbour in the grid it sits in.
  tileHovered: { transform: [{ translateY: -3 }], shadowOpacity: 0.13, shadowRadius: 18, shadowOffset: { width: 0, height: 10 } },
  info: {},
  // Square, not 4:5. A taller box is better for photographs and worse for the
  // plate, and the plate is the majority case -- 4:5 spends the extra height
  // on empty soft.
  //
  // Radius 13, not RADIUS.inset (18): the mockup's own `.w3ph` -- the photo
  // container this tile is modelled on -- draws it a step tighter than the
  // system's general inset, and the price pill/NEW badge sitting in that
  // corner is what asks for it. This one View is also the plate's own
  // container (below), so the plate steps to 13 along with the photo rather
  // than gaining a second radius the brief never asked for; RADIUS.inset
  // stays 18 everywhere else this file and every other tile use it.
  box: { aspectRatio: 1, width: '100%', borderRadius: 13, overflow: 'hidden' },
  photo: { ...StyleSheet.absoluteFill },
  // Bottom-left, over the photo -- ".w3tag": a `ground` pill, never a colour
  // literal, so it reads correctly on every one of the seven palettes.
  // `overflow: hidden` on `box` above clips anything crossing its edge, so
  // the 7px inset keeps the pill's own shadow from being cut off by it.
  pricePill: {
    position: 'absolute', left: 7, bottom: 7,
    borderRadius: RADIUS.pill, paddingVertical: 3, paddingHorizontal: 10,
    shadowOpacity: 0.14, shadowRadius: 6, shadowOffset: { width: 0, height: 1 }, elevation: 1,
  },
  pricePillDense: { paddingVertical: 2.5, paddingHorizontal: 8 },
  // A compact chip, not the page's headline figure -- this is no longer the
  // number TYPE.price/priceDenseGrid were sized for (the big price a whole
  // card used to anchor on), so it takes its own literal rather than either.
  // TABULAR is still applied: a column of on-photo prices should line up the
  // same way the old inline price did.
  pricePillText: { fontSize: 15, fontWeight: '800', letterSpacing: -0.2, ...TABULAR },
  pricePillTextDense: { fontSize: 13 },
  // Top-right, over the photo -- ".w3new": the accent, always with `ground`
  // on it (the same "buttons and the active filter" pairing ProductActions'
  // Add button uses), never a fixed white -- a palette's accent is already
  // contrast-checked against its own ground, not against an arbitrary white.
  newBadge: { position: 'absolute', right: 7, top: 7, borderRadius: 7, paddingVertical: 2, paddingHorizontal: 7 },
  newBadgeText: { fontSize: 9, fontWeight: '800', letterSpacing: 0.4, textTransform: 'uppercase' },
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
  // Sized to roughly hold the taller (non-dense) price line, so the empty
  // slot on a photo tile costs the same vertical space the filled one on a
  // photoless tile does.
  priceSlot: { minHeight: 30 },
  priceSlotDense: { minHeight: 26 },
  price: { fontSize: TYPE.price, fontWeight: '800', letterSpacing: -0.8, marginTop: 2, ...TABULAR },
  priceDense: { fontSize: TYPE.priceDenseGrid, letterSpacing: -0.6 },
  stock: { fontSize: 11.5, fontWeight: '700', marginTop: 3 },
  stockRow: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  stockDot: { width: 8, height: 8, borderRadius: RADIUS.pill, borderWidth: 1.5, marginTop: 3 },
  actions: { paddingTop: 12 },
});
