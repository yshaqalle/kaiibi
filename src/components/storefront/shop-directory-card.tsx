import { Image, Pressable, StyleSheet, Text, View } from 'react-native';

import { pressable } from '@/components/storefront/press-feedback';
import { DISPLAY_FONT, LETTER, RADIUS, SPACE, TABULAR, TYPE } from '@/components/storefront/scale';
import { isConfigured, isOpenAt } from '@/lib/store-hours';
import { shopBlurb } from '@/lib/storefront-directory';
import type { PaletteColors } from '@/lib/storefront-catalog';
import type { PublicShopSummary } from '@/types/models';

// One shop in the directory.
//
// Bento, the same as everything else on this surface: borderless, 26px, the
// page tone behind it doing the separating. What it must NOT be is a small
// storefront -- no shop palette, no shop theme. Eight cards each rendered in
// their owner's colours is eight competing brands on one page, and a customer
// scanning for a pharmacy would be reading eight designs instead of a list.
//
// The photo is the shop's, and it is the only thing on the card that is.
export function ShopDirectoryCard({
  shop, colors, onPress,
}: {
  shop: PublicShopSummary;
  colors: PaletteColors;
  onPress: (slug: string) => void;
}) {
  const blurb = shopBlurb(shop);
  // The initial, for a shop with no photograph. Not a placeholder image and not
  // an empty grey box: a monogram reads as designed, which is the test every
  // no-photo fallback in this folder has to pass (see ProductTile's plate and
  // CategoryBand's dropped image_url).
  const initial = shop.shopName.trim().charAt(0).toUpperCase() || '?';
  const open = isOpenAt(shop.openingHours ?? {}, new Date());

  return (
    <Pressable
      testID={`storefront-directory-card-${shop.slug}`}
      accessibilityRole="link"
    accessibilityLabel={[
        shop.shopName,
        shop.city,
        // Announced in the label rather than left to a coloured pill sighted
        // users read at a glance.
        isConfigured(shop.openingHours) ? (open ? 'open now' : 'closed now') : null,
        `${shop.productCount} items`,
      ].filter(Boolean).join(', ')}
      onPress={() => onPress(shop.slug)}
      style={pressable([styles.card, { backgroundColor: colors.ground }])}
    >
      <View style={[styles.photo, { backgroundColor: colors.soft }]}>
        {shop.heroImageUrl ? (
          <Image source={{ uri: shop.heroImageUrl }} style={styles.image} resizeMode="cover" />
        ) : (
          <Text style={[styles.monogram, { color: colors.muted }]}>{initial}</Text>
        )}
        {/* Computed HERE, on the device, and never on the server: the stored
            times are local wall-clock strings with no timezone, so only the
            reader's own clock can answer this. No badge at all for a shop that
            has never set hours -- absent is honest, "Closed" would not be.
            Sits on a fixed near-white plate rather than the palette's ground
            because it is over an unknown photograph. */}
        {isConfigured(shop.openingHours) ? (
          <View testID={`storefront-directory-state-${shop.slug}`} style={styles.state}>
            <Text style={[styles.stateText, open ? styles.stateOpen : styles.stateShut]}>
              {open ? 'Open' : 'Closed'}
            </Text>
          </View>
        ) : null}
      </View>

      <View style={styles.body}>
        <Text style={[styles.name, { color: colors.ink }]} numberOfLines={1}>{shop.shopName}</Text>
        {shop.city ? (
          <Text style={[styles.city, { color: colors.muted }]} numberOfLines={1}>{shop.city}</Text>
        ) : null}
        {/* Two lines, clamped. A shop that wrote three paragraphs into `about`
            gets the first two lines of it here and the rest on its own page --
            a card that grows with its copy makes a ragged grid. */}
        {blurb ? (
          <Text style={[styles.blurb, { color: colors.muted }]} numberOfLines={2}>{blurb}</Text>
        ) : null}

        <View style={styles.foot}>
          {/* The count is what is listed AND in stock (see the RPC), so it is a
              promise about what is behind the card rather than a catalogue
              size. A shop with nothing in stock says so plainly instead of
              showing "0 items", which reads as a broken card. */}
          <View style={[styles.chip, { backgroundColor: colors.soft }]}>
            <Text style={[styles.chipText, { color: colors.muted }]}>
              {shop.productCount === 0
                ? 'Nothing in today'
                : `${shop.productCount} ${shop.productCount === 1 ? 'item' : 'items'}`}
            </Text>
          </View>
          {shop.offersDelivery ? (
            <View style={[styles.chip, { backgroundColor: colors.soft }]}>
              <Text style={[styles.chipText, { color: colors.muted }]}>Delivers</Text>
            </View>
          ) : null}
        </View>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: RADIUS.card, padding: 12, flex: 1, minWidth: 0 },
  photo: {
    aspectRatio: 16 / 10, borderRadius: RADIUS.inset, overflow: 'hidden',
    alignItems: 'center', justifyContent: 'center',
  },
  image: { width: '100%', height: '100%' },
  monogram: { fontFamily: DISPLAY_FONT, fontSize: 34, fontWeight: '700', letterSpacing: LETTER.displayLoud },
  body: { paddingHorizontal: 6, paddingTop: 12, paddingBottom: 4 },
  name: { fontSize: 15, fontWeight: '800', letterSpacing: LETTER.display },
  city: {
    fontSize: TYPE.metaSmall, fontWeight: '800', letterSpacing: LETTER.meta,
    textTransform: 'uppercase', marginTop: 5,
  },
  blurb: { fontSize: 12.5, lineHeight: 17, marginTop: 8 },
  foot: { flexDirection: 'row', gap: 6, marginTop: 12, flexWrap: 'wrap' },
  chip: { borderRadius: RADIUS.pill, paddingHorizontal: 10, paddingVertical: 5 },
  chipText: { fontSize: 10.5, fontWeight: '800', letterSpacing: 0.4, ...TABULAR },
  // Fixed values, not palette ones: this sits over a photograph the palette
  // knows nothing about -- the same reasoning ON_SCRIM_INK follows in
  // theme-shared.tsx.
  state: {
    position: 'absolute', top: 10, right: 10,
    backgroundColor: 'rgba(255,255,255,0.94)',
    borderRadius: RADIUS.pill, paddingHorizontal: 11, paddingVertical: 5,
  },
  stateText: { fontSize: 10, fontWeight: '800', letterSpacing: 0.5 },
  stateOpen: { color: '#0b7a44' },
  stateShut: { color: '#5e5d65' },

  feature: { borderRadius: RADIUS.card, overflow: 'hidden' },
  featureArt: { width: '100%' },
  featureArtWide: { height: 220 },
  featureArtTall: { aspectRatio: 16 / 10 },
  featureText: { padding: SPACE.card },
  featureTextWide: { padding: 28 },
  featureTag: {
    fontSize: TYPE.metaSmall, fontWeight: '800', letterSpacing: LETTER.meta,
    textTransform: 'uppercase',
  },
  featureName: {
    fontFamily: DISPLAY_FONT, fontSize: 26, lineHeight: 30, fontWeight: '700',
    letterSpacing: LETTER.displayLoud, marginTop: 10,
  },
  featureCity: {
    fontSize: TYPE.metaSmall, fontWeight: '800', letterSpacing: LETTER.meta,
    textTransform: 'uppercase', marginTop: 8,
  },
  featureBlurb: { fontSize: TYPE.body, lineHeight: 20, marginTop: 10 },
  featureFoot: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 18, flexWrap: 'wrap' },
  featureChip: { borderRadius: RADIUS.pill, paddingHorizontal: 18, paddingVertical: 11 },
  featureChipText: { fontSize: 12.5, fontWeight: '800' },
  featureState: { fontSize: 12, fontWeight: '700' },
});

export const DIRECTORY_GAP = SPACE.cardGap;

// THE DIRECTORY GETS ITS OWN MEASURE, WIDER THAN A SHOP'S.
//
// This page was bounded by SHOP_MAX_WIDTH (1080), borrowed from the shop page,
// and on a 1,500px laptop that left a third of the screen empty on either side
// of the grid. The borrow was wrong, and the reason 1080 exists on a shop page
// is the reason it does not belong here: that number is a READING COLUMN --
// prose, a headline, a price list, all things a measure that grows with the
// window stops serving (scale.ts says so at length, and PR #124 exists because
// the shop page had no measure at all).
//
// A directory is not read down a column. It is a GRID of cards scanned across,
// and a grid has no measure to lose -- it gains a column. 1280 is the design's
// own frame width, at which it draws four.
//
// The HERO keeps its own narrow bound (640) inside this, because that half of
// the page IS prose. Wide grid, narrow sentence -- which is what the mockup
// does and what this was failing to do.
export const DIRECTORY_MAX_WIDTH = 1280;

// Same reasoning as gridColumnsForWidth in theme-shared.tsx, different numbers:
// a directory card is wider than a product tile (16:10 photo plus two lines of
// copy), so it climbs later at every step.
//
// The fourth column is what DIRECTORY_MAX_WIDTH above is FOR. Stopping at three
// while allowing 1280 of width would just make three cards fatter, which is the
// same defect as the empty margins wearing different clothes -- a 400px-wide
// card with a 16:10 photo is a poster, not a directory entry.
export function directoryColumnsForWidth(width: number): number {
  if (width < 620) return 1;
  if (width < 960) return 2;
  // Below this a fourth column puts the cards under ~290px, where a shop name
  // and a two-line blurb start wrapping badly.
  if (width < 1240) return 3;
  return 4;
}


// THE FEATURED CARD, and the label is the whole argument.
//
// The design calls this "Shop of the week", which implies an editor: somebody
// chose this shop, this week, for a reason. Nobody does. Shipping that label
// over a deterministic pick would be a small lie told on the front page, and
// the first shopkeeper to ask "how do I get featured?" would find out there is
// no answer.
//
// So the pick is the FIRST ROW, which the RPC has already sorted fullest-shop
// first, and the label says what that means. It costs nothing to compute, it
// cannot disagree with the ordering below it, and it is true.
//
// Rendered only when there is a grid for it to lead. One card is not a
// selection, and a "most to browse" banner over a directory of two shops is a
// superlative about nothing.
export const FEATURE_MINIMUM = 3;

export function featuredShop(shops: PublicShopSummary[]): PublicShopSummary | null {
  if (shops.length < FEATURE_MINIMUM) return null;
  // A shop with nothing in stock cannot be the one with the most to browse,
  // even if it sorts first because every other shop is empty too.
  return shops[0].productCount > 0 ? shops[0] : null;
}

export function FeaturedShopCard({
  shop, colors, wide, onPress,
}: {
  shop: PublicShopSummary;
  colors: PaletteColors;
  wide: boolean;
  onPress: (slug: string) => void;
}) {
  const blurb = shopBlurb(shop);
  const open = isOpenAt(shop.openingHours ?? {}, new Date());

  return (
    <Pressable
      testID={`storefront-directory-featured-${shop.slug}`}
      accessibilityRole="link"
      accessibilityLabel={`Most to browse: ${shop.shopName}, ${shop.productCount} items`}
      onPress={() => onPress(shop.slug)}
      // `ink`, like the anchor card on a shop page and the Takings card on
      // Dashboard: one near-black surface is what stops a page of white
      // rectangles reading as a field of them.
      style={pressable([styles.feature, { backgroundColor: colors.ink }])}
    >
      {shop.heroImageUrl ? (
        <Image
          source={{ uri: shop.heroImageUrl }}
          style={[styles.featureArt, wide ? styles.featureArtWide : styles.featureArtTall]}
          resizeMode="cover"
        />
      ) : null}
      <View style={[styles.featureText, wide && styles.featureTextWide]}>
        <Text style={[styles.featureTag, { color: colors.onDarkMuted }]}>Most to browse</Text>
        <Text style={[styles.featureName, { color: colors.ground }]} numberOfLines={2}>{shop.shopName}</Text>
        {shop.city ? (
          <Text style={[styles.featureCity, { color: colors.onDarkMuted }]}>{shop.city}</Text>
        ) : null}
        {blurb ? (
          <Text style={[styles.featureBlurb, { color: colors.onDarkMuted }]} numberOfLines={2}>{blurb}</Text>
        ) : null}
        <View style={styles.featureFoot}>
          <View style={[styles.featureChip, { backgroundColor: colors.ground }]}>
            <Text style={[styles.featureChipText, { color: colors.ink }]}>
              Browse {shop.productCount} items
            </Text>
          </View>
          {isConfigured(shop.openingHours) ? (
            <Text style={[styles.featureState, { color: colors.onDarkMuted }]}>
              {open ? 'Open now' : 'Closed now'}
            </Text>
          ) : null}
        </View>
      </View>
    </Pressable>
  );
}
