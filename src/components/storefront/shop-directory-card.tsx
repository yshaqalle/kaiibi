import { Image, Pressable, StyleSheet, Text, View } from 'react-native';

import { pressable } from '@/components/storefront/press-feedback';
import { DISPLAY_FONT, LETTER, RADIUS, SPACE, TABULAR, TYPE } from '@/components/storefront/scale';
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

  return (
    <Pressable
      testID={`storefront-directory-card-${shop.slug}`}
      accessibilityRole="link"
      accessibilityLabel={`${shop.shopName}${shop.city ? `, ${shop.city}` : ''}, ${shop.productCount} items`}
      onPress={() => onPress(shop.slug)}
      style={pressable([styles.card, { backgroundColor: colors.ground }])}
    >
      <View style={[styles.photo, { backgroundColor: colors.soft }]}>
        {shop.heroImageUrl ? (
          <Image source={{ uri: shop.heroImageUrl }} style={styles.image} resizeMode="cover" />
        ) : (
          <Text style={[styles.monogram, { color: colors.muted }]}>{initial}</Text>
        )}
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
});

export const DIRECTORY_GAP = SPACE.cardGap;

// Same reasoning as gridColumnsForWidth in theme-shared.tsx, different numbers:
// a directory card is wider than a product tile (16:10 photo plus two lines of
// copy), so it wants one fewer column at every step.
export function directoryColumnsForWidth(width: number): number {
  if (width < 620) return 1;
  if (width < 960) return 2;
  return 3;
}
