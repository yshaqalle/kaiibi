import { type ReactNode } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

import { AboutPanel } from '@/components/storefront/about-panel';
import { FlyToCartLayer } from '@/components/storefront/fly-to-cart-layer';
import { ShopFooter } from '@/components/storefront/shop-footer';
import { ShopTabRail, availableTabs, type ShopTabKey } from '@/components/storefront/shop-tabs';
import { PROSE_MAX_WIDTH, SPACE } from '@/components/storefront/scale';
import { VisitPanel } from '@/components/storefront/visit-panel';
import type { PaletteColors } from '@/lib/storefront-catalog';
import type { PublicDeliveryArea, PublicStorefront, StorefrontCategory, StorefrontProduct } from '@/types/models';

// WHERE THE TABS LIVE, so that three themes gain them in one line each rather
// than in three copies of the same branch.
//
// All three themes render a page-level ScrollView (Market and Window nest a
// second, bounded FlatList inside it for the goods -- see theme-market.tsx's
// own comment on why that grid keeps its own real, independently-scrolling
// FlatList rather than folding into the page's scroll; Counter's price list
// has no grid to bound and stays one plain scroller top to bottom), and each
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
          to is a dead end on a long About tab.

          FULL-BLEED, NOT A SHOP_MAX_WIDTH COLUMN -- this used to wrap
          ShopTabRail in a bounded, centred column, which read fine while
          the page below it was bounded to the same measure. Once the grid
          (and then the header and footer) went full-bleed -- see
          SHOP_MAX_WIDTH's own comment in scale.ts -- a rail still capped at
          1320 stopped lining up with anything beneath it: at 1900px the
          first pill sat at x~=306 while the anchor card sat at x=16. A row
          of tab controls has no reading-column argument of its own (it is
          not a sentence, the way SHOP_MAX_WIDTH's history explains a header
          row is not either) -- it takes the page's own SPACE.page inset
          directly, via `rail`'s own `paddingHorizontal` (shop-tabs.tsx),
          the same way the goods grid takes its padding from `page` rather
          than from a second wrapper around it. */}
      <View style={[styles.rail, { backgroundColor: colors.ground }]}>
        <ShopTabRail colors={colors} tabs={tabs} active={active} onSelect={onSelectTab} />
      </View>

      {active === 'shop' ? (
        children
      ) : (
        // The panels bring their own scroller. The themes' own containers are
        // tuned for a grid -- column wrappers, a checkout-bar clearance, a
        // numColumns key -- and none of that applies to a page of prose.
        //
        // FULL-BLEED SCROLLER, PADDED BODY -- the same split the Shop tab's
        // own page ScrollView makes (theme-market.tsx's `scroller`/`page`):
        // this used to be the one still bounded to SHOP_MAX_WIDTH itself,
        // which put `ShopFooter` -- rendered as this scroller's own trailing
        // child, below -- at 1320 on the About/Visit tabs while the Shop
        // tab's identical footer ran full-bleed. `body`'s own
        // `paddingHorizontal: SPACE.page` now gives the footer (and the
        // prose below) the SAME inset the Shop tab's `page.padding` gives
        // its header/goods/footer, so the one footer component reads as one
        // width regardless of which tab is open.
        <ScrollView
          testID="storefront-panel-scroll"
          style={styles.scroller}
          contentContainerStyle={styles.body}
        >
          {/* PROSE_MAX_WIDTH, narrower again than the page's own SPACE.page
              inset above -- see scale.ts. The grid earned 1320 for a fifth
              column; a paragraph read at that width is unreadable, and
              neither panel bounds its own text. The footer below is
              deliberately OUTSIDE this View, at the SAME level as it is on
              the Shop tab (a plain trailing child of the padded body, not of
              a narrower prose wrapper) -- see this ScrollView's own comment
              above for why that is what keeps the one footer one width. */}
          <View style={styles.prose}>
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
          </View>
          <ShopFooter storefront={storefront} colors={colors} />
        </ScrollView>
      )}

      {/* Mounted once, here, rather than once per theme -- see its own
          header comment on why a single overlay covering the same box every
          theme's own outer View fills is enough to carry a dot from any
          tile in the browsing content to the slip each theme renders as its
          own sibling just outside this component. */}
      <FlyToCartLayer colors={colors} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  // Full-bleed, top to bottom -- `rail` is just the ground-tone strip
  // ShopTabRail paints itself into; the pills inside take their own
  // SPACE.page inset from `rail`'s own paddingHorizontal (shop-tabs.tsx),
  // not from a bounded column wrapped around them here (see this file's own
  // comment above, at the call site, for why that wrapper was the defect).
  rail: { width: '100%' },
  // FULL-BLEED, the same as the Shop tab's own page scroller
  // (theme-market.tsx's `scroller`) -- no `maxWidth` here, so `body` below
  // is what gives the footer (and, one level deeper, the prose) their
  // inset, exactly the split the Shop tab makes between its own full-bleed
  // scroller and its padded `page` contentContainerStyle.
  scroller: { flex: 1, width: '100%' },
  // SPACE.page, not SHOP_MAX_WIDTH -- see this file's own comment at the
  // ScrollView above. This is the inset the footer now shares with the Shop
  // tab's identical footer; `prose` below narrows further, but only for the
  // panel's own paragraph, never for the footer sitting outside it.
  body: { paddingHorizontal: SPACE.page, paddingBottom: 24 },
  // Narrower than `body`'s own inset -- see PROSE_MAX_WIDTH in scale.ts. No
  // `alignSelf: 'center'` needed beyond `body`'s own padding for this to
  // read as centred: at any width `body` already leaves the panel, this
  // bound is the one still doing work.
  prose: { width: '100%', maxWidth: PROSE_MAX_WIDTH, alignSelf: 'center' },
});
