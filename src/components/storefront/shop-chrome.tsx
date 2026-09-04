import { type ReactNode } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

import { AboutPanel } from '@/components/storefront/about-panel';
import { ShopFooter } from '@/components/storefront/shop-footer';
import { ShopTabRail, availableTabs, type ShopTabKey } from '@/components/storefront/shop-tabs';
import { SHOP_MAX_WIDTH } from '@/components/storefront/scale';
import { VisitPanel } from '@/components/storefront/visit-panel';
import type { PaletteColors } from '@/lib/storefront-catalog';
import type { PublicDeliveryArea, PublicStorefront, StorefrontCategory, StorefrontProduct } from '@/types/models';

// WHERE THE TABS LIVE, so that three themes gain them in one line each rather
// than in three copies of the same branch.
//
// Market and Window render a FlatList, Counter renders a ScrollView, and each
// owns its own browsing layout -- which is the whole point of a theme. What
// none of them should own is the decision about which tabs exist, what happens
// when a customer picks one, or where the footer goes. Those are the same on a
// photo grid and a price list, exactly as CheckoutScreen and ConfirmationScreen
// already are.
//
// So the theme passes its browsing UI as `children` and gets the rail above it.
// On any tab but 'shop' the children are not rendered at all: the panels are a
// different page, not an overlay, and keeping a FlatList of 200 products
// mounted behind them would cost the memory and gain nothing.
export function ShopChrome({
  storefront, products, categories, areas, colors, wide, tab, onSelectTab, children,
}: {
  storefront: PublicStorefront;
  products: StorefrontProduct[];
  categories: StorefrontCategory[];
  areas: PublicDeliveryArea[];
  colors: PaletteColors;
  wide: boolean;
  tab: ShopTabKey;
  onSelectTab: (tab: ShopTabKey) => void;
  /** The theme's own browsing UI. Rendered only on the 'shop' tab. */
  children: ReactNode;
}) {
  const tabs = availableTabs(storefront, areas);
  // A tab can stop existing between renders -- a shop that clears its about
  // paragraph while a customer is reading it, or an area list that empties.
  // Falling back to 'shop' rather than rendering a panel nothing can navigate
  // back from.
  const active = tabs.includes(tab) ? tab : 'shop';

  return (
    <View style={styles.root}>
      {/* OUTSIDE the scroller, so it does not scroll away. It is the only way
          back to the goods from a panel, and a rail that has to be scrolled up
          to is a dead end on a long About tab. */}
      <View style={[styles.rail, { backgroundColor: colors.ground }]}>
        <View style={styles.column}>
          <ShopTabRail colors={colors} tabs={tabs} active={active} onSelect={onSelectTab} />
        </View>
      </View>

      {active === 'shop' ? (
        children
      ) : (
        // The panels bring their own scroller. The themes' own containers are
        // tuned for a grid -- column wrappers, a checkout-bar clearance, a
        // numColumns key -- and none of that applies to a page of prose.
        <ScrollView
          testID="storefront-panel-scroll"
          style={styles.scroller}
          contentContainerStyle={styles.body}
        >
          {active === 'about' ? (
            <AboutPanel
              storefront={storefront}
              products={products}
              categories={categories}
              areas={areas}
              colors={colors}
              wide={wide}
            />
          ) : (
            <VisitPanel storefront={storefront} areas={areas} colors={colors} wide={wide} />
          )}
          <ShopFooter storefront={storefront} colors={colors} />
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  // Full-bleed fill, bounded content -- the same split the themes' own
  // scrollers make, so the rail's tone runs edge to edge on a laptop while its
  // pills stay in the reading column with the goods below them.
  rail: { width: '100%' },
  column: { width: '100%', maxWidth: SHOP_MAX_WIDTH, alignSelf: 'center' },
  scroller: { flex: 1, width: '100%', maxWidth: SHOP_MAX_WIDTH, alignSelf: 'center' },
  body: { paddingBottom: 24 },
});
