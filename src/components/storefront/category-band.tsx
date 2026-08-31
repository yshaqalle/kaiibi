import { Image, Pressable, StyleSheet, Text, View } from 'react-native';

import { pressable } from '@/components/storefront/press-feedback';
import { LETTER, SPACE, TYPE } from '@/components/storefront/scale';
import type { PaletteColors } from '@/lib/storefront-catalog';
import type { StorefrontCategory } from '@/types/models';

// The way into a long catalogue, for the two themes that had none.
//
// Market is the default theme and where every shop lands; it went from the
// about paragraph straight to an undifferentiated grid. Counter already groups
// by category and so gets no band -- the same reasoning that keeps flyers off
// it: a shop that picks Counter picked density, and a second navigation layer
// fights the one thing that layout exists to do.
//
// TAPPING A TILE SETS THE STATE A FLYER ALREADY SETS. Not a new filter, not a
// new route -- the same `category` useState that FlyerCarousel's
// `onSelectCategory` writes, read by the same `filterByCategory`, cleared by
// the same `CategoryFilterBar`. So the way back out already exists and is
// already correct, and there is exactly one answer on the page to "what is on
// show".
export const CATEGORY_BAND_MINIMUM = 2;

// One category is a filter to everything -- a control that always returns the
// whole catalogue is a control that never does anything. The RPC already drops
// categories with no stock, so this is counting shoppable ones.
export function shouldShowCategoryBand(categories: StorefrontCategory[]): boolean {
  return categories.length >= CATEGORY_BAND_MINIMUM;
}

// At most two rows. The RPC returns every shoppable category ordered biggest
// first, and a shop with twelve of them would otherwise push the actual goods
// six rows down the page -- a "way in" that has to be scrolled past is not one.
// The remainder is reachable through search, which is the tool built for a long
// catalogue.
const MAX_TILES = 4;

// The no-photo tile is the MAJORITY case and must not read as a broken one.
//
// `categories.image_url` is nullable, the table is one a shop may never have
// created a row in, and it is joined to `products.category` by name -- so most
// shops will have none of these. Rather than a grey box, the tile takes the
// palette's own accent, DARKENED by position so a row of them reads as a
// designed set rather than four identical rectangles.
//
// DARKENED, never faded, and that distinction is the whole point. The first
// version varied `opacity` on the tile, which cascades to the label inside it
// -- so the palest tile carried white text on a washed-out ground and the
// count line stopped being readable. Seen immediately in a browser, invisible
// to jest. These are black overlays, so every tile is at least as dark as the
// accent and the white label's contrast can only improve.
const SHADES = [0, 0.1, 0.2, 0.3];

function shadeFor(index: number): number {
  return SHADES[index % SHADES.length];
}

export function CategoryBand({
  categories, colors, active, onSelect,
}: {
  categories: StorefrontCategory[];
  colors: PaletteColors;
  // The category currently filtering the grid, so the band can show which tile
  // is doing it rather than leaving the chip below as the only signal.
  active: string | null;
  onSelect: (category: string) => void;
}) {
  if (!shouldShowCategoryBand(categories)) return null;

  return (
    <View style={styles.band} testID="storefront-category-band">
      <View style={styles.head}>
        <Text style={[styles.title, { color: colors.ink }]}>Shop by category</Text>
        <Text style={[styles.count, { color: colors.muted }]}>
          {categories.length} {categories.length === 1 ? 'department' : 'departments'}
        </Text>
      </View>

      <View style={styles.grid}>
        {categories.slice(0, MAX_TILES).map((category, i) => {
          const selected = active === category.name;
          return (
            <Pressable
              key={category.name}
              testID={`storefront-category-${category.name}`}
              accessibilityRole="button"
              accessibilityState={{ selected }}
              accessibilityLabel={`${category.name}, ${category.productCount} products`}
              onPress={() => onSelect(category.name)}
              style={pressable([
                styles.tile,
                { backgroundColor: colors.accent },
                selected && { borderColor: colors.ink, borderWidth: 2 },
              ])}
            >
              {category.imageUrl ? (
                <Image source={{ uri: category.imageUrl }} style={styles.photo} resizeMode="cover" />
              ) : null}
              {/* The scrim runs over BOTH branches -- a photo needs it to keep
                  the label readable over an unknown image, and the flat tint
                  needs it so the two look like the same component rather than
                  two different ones. */}
              <View
                style={[styles.scrim, { backgroundColor: `rgba(0,0,0,${0.34 + shadeFor(i)})` }]}
                pointerEvents="none"
              />
              <View style={styles.label}>
                <Text style={styles.name} numberOfLines={2}>{category.name}</Text>
                <Text style={styles.meta}>
                  {category.productCount} {category.productCount === 1 ? 'product' : 'products'}
                </Text>
              </View>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

// Type on the scrim, never on the palette -- the same fixed pair, and for the
// same reason, as theme-window.tsx's ON_SCRIM_INK: the ground underneath is an
// unknown photograph or a dark accent tint, so a palette's own ink would
// vanish into it.
const ON_SCRIM_INK = '#ffffff';

const styles = StyleSheet.create({
  band: { paddingHorizontal: SPACE.page, paddingTop: 18 },
  head: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 11 },
  title: { fontSize: TYPE.body + 0.5, fontWeight: '800', letterSpacing: LETTER.display },
  count: { fontSize: TYPE.metaSmall, fontWeight: '800', letterSpacing: LETTER.meta, textTransform: 'uppercase' },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.gap },
  // Two per row on a phone with the gap between them, without needing to
  // measure the window -- the same 48% trick the loading skeleton uses.
  tile: {
    width: '48%', aspectRatio: 4 / 5, borderRadius: 11, overflow: 'hidden',
    justifyContent: 'flex-end', borderWidth: 2, borderColor: 'transparent',
  },
  photo: { ...StyleSheet.absoluteFill },
  scrim: { ...StyleSheet.absoluteFill },
  label: { padding: 12 },
  name: { color: ON_SCRIM_INK, fontSize: TYPE.body, fontWeight: '800', letterSpacing: -0.2 },
  meta: {
    color: ON_SCRIM_INK, opacity: 0.86, fontSize: 9.5, fontWeight: '800',
    letterSpacing: LETTER.meta, textTransform: 'uppercase', marginTop: 2,
  },
});
