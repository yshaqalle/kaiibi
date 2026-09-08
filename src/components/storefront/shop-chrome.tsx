import { type ReactNode } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

import { AboutPanel } from '@/components/storefront/about-panel';
import { FlyToCartLayer } from '@/components/storefront/fly-to-cart-layer';
import { ShopFooter } from '@/components/storefront/shop-footer';
import { ShopTabRail, availableTabs, type ShopTabKey } from '@/components/storefront/shop-tabs';
import { PROSE_MAX_WIDTH, SHOP_MAX_WIDTH, SPACE } from '@/components/storefront/scale';
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
  storefront, products, categories, areas, colors, wide, windowHeight, tab, onSelectTab, children, bounded = false,
}: {
  storefront: PublicStorefront;
  products: StorefrontProduct[];
  categories: StorefrontCategory[];
  areas: PublicDeliveryArea[];
  colors: PaletteColors;
  wide: boolean;
  // Threaded straight through to AboutPanel (Task 26), the same way `wide`
  // already is -- see that file's own comment on why the About tab's photo
  // carousel needs the window's HEIGHT and not just a wide/narrow boolean,
  // and why that is still cheaper than a second subscription. VisitPanel has
  // no photo carousel and never receives this.
  windowHeight: number;
  tab: ShopTabKey;
  onSelectTab: (tab: ShopTabKey) => void;
  /** The theme's own browsing UI. Rendered only on the 'shop' tab. */
  children: ReactNode;
  // TRUE ONLY FOR COUNTER (theme-counter.tsx), whose own page -- `scroll`
  // there -- never went full-bleed and still keeps `maxWidth: SHOP_MAX_WIDTH,
  // alignSelf: 'center'` top to bottom, deliberately (Counter has no grid to
  // free -- see scale.ts's own SHOP_MAX_WIDTH comment). Market and Window
  // leave this at its default `false`: their own pages went full-bleed and
  // this component's rail/panel should keep matching them exactly as before.
  //
  // Without this, the rail and the About/Visit panel below -- both shared,
  // unconditionally full-bleed -- agree with Market and Window's own
  // full-bleed pages but NOT with Counter's bounded one: at 1900px the first
  // tab pill sat at x=16 while Counter's own price-list card, inside its
  // bounded column, sat at x=306, and `ShopFooter` (this file's own trailing
  // child of the panel scroller) measured 1288px on the Shop tab against
  // 1868px on About/Visit -- the exact defect `4fdd886`'s commit message
  // said it had removed, reappearing on the one theme nobody had rendered
  // through this file's own test. `bounded` is what lets the rail and panel
  // agree with WHICHEVER page they are actually sitting on, rather than
  // assuming every theme's page looks like Market and Window's.
  bounded?: boolean;
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

          FULL-BLEED FOR MARKET AND WINDOW, BOUNDED FOR COUNTER -- this used
          to wrap ShopTabRail in an unconditional SHOP_MAX_WIDTH column,
          which read fine only while every theme's page was bounded to the
          same measure. Once the grid (and then the header and footer) went
          full-bleed for Market and Window -- see SHOP_MAX_WIDTH's own
          comment in scale.ts -- an unconditionally bounded rail stopped
          lining up with THEIR pages: at 1900px the first pill sat at
          x~=306 while the anchor card sat at x=16. But making the rail
          unconditionally full-bleed instead (as an earlier pass here did)
          just moved the same mismatch onto Counter, whose page never went
          full-bleed and still centres itself inside SHOP_MAX_WIDTH -- there
          the pill sat at x=16 while the price-list card sat at x=306. A row
          of tab controls has no reading-column argument of its own (it is
          not a sentence, the way SHOP_MAX_WIDTH's history explains a header
          row is not either); the column it takes, if any, is only ever a
          COPY of whatever the page underneath it is already doing.
          `bounded` (this file's own prop, set true only by Counter) is
          what makes that a fact this component reads rather than assumes.
          Full-bleed still takes the page's own SPACE.page inset directly,
          via `rail`'s own `paddingHorizontal` (shop-tabs.tsx), the same way
          the goods grid takes its padding from `page` rather than from a
          second wrapper around it -- `railBounded` below adds nothing to
          that when `bounded` is false. */}
      <View style={[styles.rail, { backgroundColor: colors.ground }]}>
        {bounded ? (
          <View style={styles.railBounded}>
            <ShopTabRail colors={colors} tabs={tabs} active={active} onSelect={onSelectTab} />
          </View>
        ) : (
          <ShopTabRail colors={colors} tabs={tabs} active={active} onSelect={onSelectTab} />
        )}
      </View>

      {active === 'shop' ? (
        children
      ) : (
        // The panels bring their own scroller. The themes' own containers are
        // tuned for a grid -- column wrappers, a checkout-bar clearance, a
        // numColumns key -- and none of that applies to a page of prose.
        //
        // FULL-BLEED SCROLLER FOR MARKET/WINDOW, BOUNDED FOR COUNTER -- the
        // same split the Shop tab's own page ScrollView makes
        // (theme-market.tsx's `scroller`/`page`): this used to be
        // unconditionally bounded to SHOP_MAX_WIDTH, which put `ShopFooter`
        // -- rendered as this scroller's own trailing child, below -- at
        // 1320 on the About/Visit tabs while the Shop tab's identical
        // footer ran full-bleed for Market and Window. Making it
        // unconditionally full-bleed instead fixed those two themes and
        // broke Counter the same way the rail did (see this file's own
        // comment there): Counter's own Shop-tab footer stays inside its
        // page's SHOP_MAX_WIDTH column, so an unconditionally full-bleed
        // panel scroller put IT at two widths instead. `bounded` (true only
        // for Counter) is what keeps the one footer one width on every
        // theme, by copying whichever page it is actually attached to
        // rather than assuming it is Market or Window's. `body`'s own
        // `paddingHorizontal: SPACE.page` still gives the footer (and the
        // prose below) the SAME inset the Shop tab's `page.padding` gives
        // its header/goods/footer either way.
        <ScrollView
          testID="storefront-panel-scroll"
          style={[styles.scroller, bounded && styles.scrollerBounded]}
          contentContainerStyle={styles.body}
        >
          {/* PROSE_MAX_WIDTH, narrower again than the page's own SPACE.page
              inset above -- see scale.ts. The grid earned 1320 for a fifth
              column; a paragraph read at that width is unreadable.

              ONLY ONE OF THESE TWO PANELS BOUNDS ITSELF HERE, AND IT IS NOT
              ABOUT (Task 25, still true after Task 26). This used to wrap
              BOTH panels in one `styles.prose` column, back when neither
              panel's own content had anything but text in it. Phase 4 put a
              photo gallery at the top of About, and About is handed the full,
              unbounded width below and narrows its OWN blocks instead: the
              gallery, the proof chips, the merged story card and the FAQ band
              each carry PROSE_MAX_WIDTH directly (about-panel.tsx's own
              `prose` style) -- Task 26 added the gallery to that list (it
              used to carry no bound at all; see about-panel.tsx's own
              comment on why a bounded, single-photo carousel is a different
              shape from the full-bleed cover-plus-thumbnail-strip row it
              replaced). Visit has no photographs -- hours, delivery chips and
              contact are still all prose, top to bottom -- so it keeps being
              bounded HERE, at the chrome level, exactly as before.

              The footer below is deliberately OUTSIDE either panel, at the
              SAME level as it is on the Shop tab (a plain trailing child of
              the padded body, not of a narrower prose wrapper) -- see this
              ScrollView's own comment above for why that is what keeps the
              one footer one width, regardless of which blocks inside either
              panel bound themselves narrower. */}
          {active === 'about' ? (
            <AboutPanel
              storefront={storefront}
              products={products}
              categories={categories}
              areas={areas}
              colors={colors}
              wide={wide}
              windowHeight={windowHeight}
            />
          ) : (
            <View style={styles.prose}>
              <VisitPanel storefront={storefront} areas={areas} colors={colors} wide={wide} />
            </View>
          )}
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
  // The strip itself stays full-bleed even for Counter -- it is only the
  // ground-tone background, and `railBounded` below is what bounds the
  // pills INSIDE it, the same way `body` (not `scroller`) is what bounds the
  // panel's own content.
  rail: { width: '100%' },
  // COUNTER ONLY (`bounded`, the call site's own prop) -- the identical
  // `width`/`maxWidth`/`alignSelf` triple Counter's own page (`scroll`,
  // theme-counter.tsx) and `searchInset` beside it already carry, so the
  // rail's pills sit in the SAME column as the price list underneath them
  // rather than a second one tuned to match it only by coincidence.
  railBounded: { width: '100%', maxWidth: SHOP_MAX_WIDTH, alignSelf: 'center' },
  // FULL-BLEED for Market and Window, the same as the Shop tab's own page
  // scroller (theme-market.tsx's `scroller`) -- no `maxWidth` here, so
  // `body` below is what gives the footer (and, one level deeper, the
  // prose) their inset, exactly the split the Shop tab makes between its
  // own full-bleed scroller and its padded `page` contentContainerStyle.
  // `scrollerBounded` below is what this becomes for Counter instead.
  scroller: { flex: 1, width: '100%' },
  // COUNTER ONLY -- added to `scroller` above via the call site's own
  // `bounded` prop, the same triple `railBounded` carries. This is what
  // keeps `ShopFooter` (this scroller's own trailing child) at the SAME
  // width the Shop tab's identical footer already has inside Counter's
  // bounded `scroll` (theme-counter.tsx), rather than the two disagreeing
  // by whichever tab happens to be open.
  scrollerBounded: { maxWidth: SHOP_MAX_WIDTH, alignSelf: 'center' },
  // SPACE.page, not SHOP_MAX_WIDTH -- see this file's own comment at the
  // ScrollView above. This is the inset the footer now shares with the Shop
  // tab's identical footer; `prose` below narrows further, but only where it
  // is still applied (Visit), never for the footer sitting outside it.
  body: { paddingHorizontal: SPACE.page, paddingBottom: 24 },
  // Narrower than `body`'s own inset -- see PROSE_MAX_WIDTH in scale.ts. No
  // `alignSelf: 'center'` needed beyond `body`'s own padding for this to
  // read as centred: at any width `body` already leaves the panel, this
  // bound is the one still doing work.
  //
  // VISIT ONLY, as of Task 25 -- see the call site's own comment above for
  // why About stopped taking this here and narrows its own blocks instead.
  // This style still exists, unchanged, for the one panel that is still
  // prose top to bottom.
  prose: { width: '100%', maxWidth: PROSE_MAX_WIDTH, alignSelf: 'center' },
});
