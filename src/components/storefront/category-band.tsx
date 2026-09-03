import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { pressable } from '@/components/storefront/press-feedback';
import { LETTER, RADIUS, SPACE, TABULAR, TYPE } from '@/components/storefront/scale';
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

// A PILL ROW, NOT A ROW OF PICTURE TILES, and that is the one deliberate
// subtraction in this pass.
//
// The band used to be up to four accent-tinted tiles at 4:5, which is the shape
// of a product -- so a route INTO the goods was drawn at the same weight as the
// goods, and on a phone it pushed them a full screen down. The app solves the
// identical problem (the range row and the tab row on Dashboard) with pills,
// and pills scroll, so the cap that used to be needed is gone with them: every
// shoppable category is now reachable, not just the four biggest.
//
// What goes with the tiles: MAX_TILES, the four accent SHADES, and
// `categories.image_url`, which was nullable, usually null, and joined to
// `products.category` by name. Nothing reads that column here any more.

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
        <Text style={[styles.title, { color: colors.muted }]}>Shop by category</Text>
        <Text style={[styles.count, { color: colors.muted }]}>
          {categories.length} {categories.length === 1 ? 'category' : 'categories'}
        </Text>
      </View>

      {/* Horizontal rather than wrapping: a wrapping row of pills is a block
          of unpredictable height above the goods, which is the complaint the
          tiles had. `showsHorizontalScrollIndicator={false}` because on web
          the bar would sit over the last pill. */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.row}
      >
        {categories.map((category) => {
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
                styles.pill,
                { backgroundColor: selected ? colors.ink : colors.ground },
              ])}
            >
              <Text style={[styles.name, { color: selected ? colors.ground : colors.ink }]} numberOfLines={1}>
                {category.name}
              </Text>
              {/* The count is the reason a pill is worth tapping -- "Solar 11"
                  says how much is behind it. On the selected pill it takes the
                  on-ink muted step, which is the token that exists precisely
                  because `muted` is unreadable on an ink fill. */}
              <Text style={[styles.meta, { color: selected ? colors.onDarkMuted : colors.muted }]}>
                {category.productCount}
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  band: { paddingHorizontal: SPACE.page, paddingTop: 18 },
  head: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 11 },
  title: { fontSize: TYPE.eyebrow, fontWeight: '800', letterSpacing: LETTER.meta, textTransform: 'uppercase' },
  count: { fontSize: TYPE.metaSmall, fontWeight: '700' },
  row: { flexDirection: 'row', gap: 8, paddingRight: SPACE.page },
  pill: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    borderRadius: RADIUS.pill, paddingHorizontal: 16, paddingVertical: 10,
  },
  name: { fontSize: 12.5, fontWeight: '800' },
  meta: { fontSize: 12.5, fontWeight: '700', ...TABULAR },
});
