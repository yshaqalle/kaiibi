import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { pressable } from '@/components/storefront/press-feedback';
import { LETTER, RADIUS, SPACE, TYPE } from '@/components/storefront/scale';
import type { PaletteColors } from '@/lib/storefront-catalog';
import type { PublicDeliveryArea, PublicStorefront } from '@/types/models';

// The one new control this redesign adds, and the reason the page can afford
// depth at all.
//
// The shop page's job on arrival has not changed: whose shop is this, what is
// in it, what does it cost. A customer arriving on a forwarded WhatsApp link
// must not scroll past a founder's story to reach a price. So About and Visit
// are one TAP away and zero SCROLL away, rather than appended to the bottom of
// the browsing page where they would push the goods down and still be missed.

export type ShopTabKey = 'shop' | 'about' | 'visit';

export const SHOP_TAB_LABELS: Record<ShopTabKey, string> = {
  shop: 'Shop',
  about: 'About',
  visit: 'Visit',
};

// A TAB HAS TO EARN ITS PLACE BY SAYING SOMETHING THE SHOP TAB DOES NOT.
//
// This is the whole of what keeps the rail honest. Nothing here is a setting a
// shopkeeper toggles -- it is derived from whether there is anything to show,
// the same rule `headline`, `about`, `heroImageUrl` and the flyer band already
// follow: render nothing rather than a placeholder.
//
//   about -- only with an about paragraph. Without one the tab would be a
//            headline the anchor card already prints, plus counts.
//   visit -- only with priced delivery areas. Without them its entire content
//            is the Collecting card, which is already on the Shop tab; a tab
//            that repeats the page you came from is worse than no tab.
//
// A shop that has filled in neither gets `['shop']`, and ShopTabRail renders
// nothing at all for a single tab -- so the page is exactly what shipped
// before this existed, with no empty chrome to explain.
export function availableTabs(
  storefront: Pick<PublicStorefront, 'about'>,
  areas: PublicDeliveryArea[],
): ShopTabKey[] {
  const tabs: ShopTabKey[] = ['shop'];
  if (storefront.about?.trim()) tabs.push('about');
  if (areas.length > 0) tabs.push('visit');
  return tabs;
}

export function ShopTabRail({
  colors, tabs, active, onSelect,
}: {
  colors: PaletteColors;
  tabs: ShopTabKey[];
  active: ShopTabKey;
  onSelect: (tab: ShopTabKey) => void;
}) {
  // One tab is not a choice, and a rail showing it is chrome that never does
  // anything -- the same reasoning CategoryFilterBar and the category band
  // already apply to their own minimums.
  if (tabs.length < 2) return null;

  return (
    <View style={[styles.rail, { backgroundColor: colors.ground, borderBottomColor: colors.hairline }]}>
      {/* Horizontal, for the reason CategoryBand is: three tabs fit a phone
          today, but a shop name is not length-limited and neither is a future
          fourth tab. A wrapping rail is a control of unpredictable height
          sitting above the goods. */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.row}>
        {tabs.map((tab) => {
          const selected = tab === active;
          return (
            <Pressable
              key={tab}
              testID={`storefront-tab-${tab}`}
              accessibilityRole="tab"
              accessibilityState={{ selected }}
              onPress={() => onSelect(tab)}
              style={pressable([
                styles.tab,
                selected
                  ? { backgroundColor: colors.ink }
                  // Unselected tabs take the page tone rather than a border:
                  // unlike a category pill they sit INSIDE a filled rail, so
                  // the rail's own edge already bounds the group and a border
                  // on each one would draw four lines to separate three words.
                  : { backgroundColor: colors.soft },
              ])}
            >
              <Text style={[styles.label, { color: selected ? colors.ground : colors.muted }]}>
                {SHOP_TAB_LABELS[tab]}
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  rail: { paddingHorizontal: SPACE.page, paddingVertical: 10, borderBottomWidth: 1 },
  row: { flexDirection: 'row', gap: 6, paddingRight: SPACE.page },
  tab: { borderRadius: RADIUS.pill, paddingHorizontal: 18, paddingVertical: 9 },
  label: { fontSize: TYPE.meta + 1.5, fontWeight: '800', letterSpacing: LETTER.display },
});
