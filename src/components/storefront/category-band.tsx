import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Image, Platform, Pressable, ScrollView, StyleSheet, Text, View,
  type LayoutChangeEvent, type NativeScrollEvent, type NativeSyntheticEvent,
} from 'react-native';
import Animated, {
  useAnimatedStyle, useReducedMotion, useSharedValue, withSpring, type SharedValue,
} from 'react-native-reanimated';
import { LinearGradient } from 'expo-linear-gradient';

import { pillMotion } from '@/components/storefront/shop-tabs';
import {
  clampOffset, nextWheelOffset, shouldConsumeWheel, supportsHover, wheelPanDelta,
} from '@/components/storefront/mouse-pan';
import { pressable } from '@/components/storefront/press-feedback';
import {
  LETTER, ON_SCRIM_INK, ON_SCRIM_MUTED, RADIUS, SCRIM_GRADIENT, SPACE, TABULAR, TYPE,
} from '@/components/storefront/scale';
import type { PaletteColors } from '@/lib/storefront-catalog';
import type { StorefrontCategory, StorefrontProduct } from '@/types/models';

// The way into a long catalogue, for the two themes that had none.
//
// Market is the default theme and where every shop lands; it went from the
// about paragraph straight to an undifferentiated grid. Counter already groups
// by category and so gets no band -- the same reasoning that keeps flyers off
// it: a shop that picks Counter picked density, and a second navigation layer
// fights the one thing that layout exists to do.
//
// TAPPING A TILE OR A PILL SETS THE STATE A FLYER ALREADY SETS. Not a new
// filter, not a new route -- the same `category` useState that FlyerCarousel's
// `onSelectCategory` writes, read by the same `filterByCategory`, cleared by
// the same `CategoryFilterBar`. So the way back out already exists and is
// already correct, and there is exactly one answer on the page to "what is on
// show". Task 15 (below) changed nothing about that state or the filtering it
// drives -- only which of the two shapes a category renders as.
export const CATEGORY_BAND_MINIMUM = 2;

// A CATEGORY'S OWN BOX, measured once at layout. `radius` travels with
// x/width for the reason ShopTabRail's identical TabLayout never needed one:
// three tabs are all the same shape, but a category can render as a
// squarish photo tile (`RADIUS.inset`) or a compact text pill
// (`RADIUS.pill`) -- see CategoryBand's own sliding-indicator comment below.
type CategoryLayout = { x: number; width: number; radius: number };

// THE SLIDING INDICATOR'S OWN DECISION: which box, if any, does the active
// category own right now. Pulled out for the identical reason shop-tabs.tsx
// pulls `pillMotion` out of ShopTabRail -- nothing about a shared value
// reaching a position can be asserted through a render of this component.
// Worse than ShopTabRail's case, in fact: the shared reanimated jest mock
// backs `useSharedValue` with a plain object rather than a ref, so it does
// not even survive a re-render triggered by something else (this band's own
// `indicatorBox` state update, for one) -- a render can show the indicator's
// WIDTH (real React state, persists correctly) but never its position
// reliably. This lookup is where "selecting a different category moves the
// indicator" actually lives, so it is what a test holds directly instead:
// two different `active` values against the same `layouts` map must produce
// two different boxes, which is the one fact a render cannot be trusted to
// show here.
export function activeCategoryBox(
  active: string | null,
  layouts: Partial<Record<string, CategoryLayout>>,
): CategoryLayout | null {
  return active ? layouts[active] ?? null : null;
}

// One category is a filter to everything -- a control that always returns the
// whole catalogue is a control that never does anything. The RPC already drops
// categories with no stock, so this is counting shoppable ones.
export function shouldShowCategoryBand(categories: StorefrontCategory[]): boolean {
  return categories.length >= CATEGORY_BAND_MINIMUM;
}

// A PHOTO TILE WHEN THERE IS A PHOTO TO SHOW, THE PLAIN PILL WHEN THERE IS
// NOT -- and that mix, in the same row, is the intended look.
//
// docs/design/storefront-bold-motion-mockup.html's "The One" section (and its
// own §4 vocabulary section) calls this "the single strongest steal" from the
// web-store Dribbble tag: categories as photo cards with a scrim and a count,
// not text pills. The photo is DERIVED, not authored -- see
// firstPhotoByCategory below -- each category borrows its first product that
// has one, so a shop that has never opened the Categories screen still gets a
// photo band the moment it has photographed a single product in a category.
// `categories.image_url` (the shop-set column
// get_public_storefront_categories joins in -- see that migration's own
// comment on why the picture and the count come from two different tables)
// is deliberately NOT what this reads: it is nullable, usually null, and
// asking a shop to fill in a second photo nobody asked for is exactly the new
// merchant work this pass avoids.
//
// A CATEGORY WITH NO PHOTOGRAPHED PRODUCT DEGRADES TO THE PILL this band
// rendered before this pass, unchanged in markup, colour or behaviour -- not
// a grey box, not a placeholder image. The same rule ProductTile already
// follows for `products.image_url` and FlyerCarousel follows for a flyer's
// photo: a thing with no picture behind it must look designed, not broken.
export function CategoryBand({
  categories, products, colors, active, onSelect,
}: {
  categories: StorefrontCategory[];
  // Read only to derive a tile's photo (firstPhotoByCategory) -- the band
  // does not filter or count from this list, `categories` already carries
  // the count the RPC computed server-side.
  products: StorefrontProduct[];
  colors: PaletteColors;
  // The category currently filtering the grid, so the band can show which
  // tile or pill is doing it rather than leaving the chip below as the only
  // signal.
  active: string | null;
  onSelect: (category: string) => void;
}) {
  // One pass over `products` per render of the band (memoised on the
  // reference `products` itself, which only changes when the theme refetches
  // the catalogue) -- O(products), not one `.find()` per category, which
  // would be O(categories * products). A shop with sixty categories and a few
  // hundred products is exactly where the second shape starts to cost
  // something the first does not.
  const photos = useMemo(() => firstPhotoByCategory(products), [products]);

  // THE SLIDING INDICATOR -- the requirement's "sliding active pill on the
  // category bar", built where the requirement actually names, not on
  // ShopTabRail's page tabs. Structured as the direct twin of that file's
  // pillX/applyLayout (shop-tabs.tsx), reusing its own `pillMotion` decision
  // so the two indicators cannot quietly disagree about when to spring vs
  // snap. What is different here is the ROW ITSELF: unlike three same-shaped
  // tabs, a category renders as either a squarish photo tile (`RADIUS.inset`)
  // or a compact text pill (`RADIUS.pill`) -- Task 15's own mixed row -- so
  // this indicator has to change SHAPE as well as position and width when
  // the active item changes type. `radius` is measured and carried alongside
  // x/width for exactly that, and -- like `width` in shop-tabs.tsx's own Fix
  // 2 -- is set directly as a plain style value, never animated; only the
  // travel (`indicatorX`) is a Reanimated spring.
  //
  // EVERY item -- tile AND pill -- reports its own layout on mount, whether
  // or not it is currently selected. That is what lets the indicator spring
  // smoothly FROM a tile's rect the instant a pill next to it is tapped,
  // rather than flying in from (0, 0) the way pillMotion's own comment warns
  // against for a first measurement.
  //
  // WHY THIS STAYS CORRECT UNDER A PHOTO TILE: the indicator draws an
  // ink-filled box exactly the size and shape of whichever item is active. A
  // selected PILL drops its own instant background fill in favour of this
  // (see CategoryPill below) so the indicator's slide is what a customer
  // actually sees move. A selected TILE's own photo and gradient scrim are
  // fully opaque, so the identical ink box sits harmlessly BEHIND it,
  // invisible -- the tile keeps its own already-tested selected treatment
  // (the accent-filled label chip) as the visible signal, unchanged. Nothing
  // here touches that chip, or `onSelect`/`active`, which is what keeps the
  // filter this band drives byte-identical.
  const reducedMotion = useReducedMotion();
  const indicatorX = useSharedValue(0);
  const [indicatorBox, setIndicatorBox] = useState<{ width: number; radius: number } | null>(null);
  const itemLayoutsRef = useRef<Partial<Record<string, CategoryLayout>>>({});
  const hasMeasuredIndicatorRef = useRef(false);

  function applyIndicatorLayout(layout: CategoryLayout) {
    const motion = pillMotion(reducedMotion, !hasMeasuredIndicatorRef.current);
    hasMeasuredIndicatorRef.current = true;
    setIndicatorBox({ width: layout.width, radius: layout.radius });
    if (motion === 'spring') {
      indicatorX.value = withSpring(layout.x, { damping: 18, stiffness: 180 });
    } else {
      indicatorX.value = layout.x;
    }
  }

  function handleItemLayout(name: string, radius: number, event: LayoutChangeEvent) {
    const { x, width } = event.nativeEvent.layout;
    itemLayoutsRef.current[name] = { x, width, radius };
    if (name === active) applyIndicatorLayout({ x, width, radius });
  }

  // Selection changed -- a tile/pill tapped, or a flyer's `onSelectCategory`
  // writing the same state from elsewhere on the page -- and the newly
  // active item's layout may already be cached from its own earlier onLayout
  // (every visible item lays out once at mount, whether or not it starts
  // selected).
  useEffect(() => {
    const layout = activeCategoryBox(active, itemLayoutsRef.current);
    if (layout) applyIndicatorLayout(layout);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- applyIndicatorLayout closes over stable refs/shared values
  }, [active]);

  const indicatorStyle = useAnimatedIndicatorStyle(indicatorX);

  // WEB MOUSE, REUSED FROM TASK 14, NOT REIMPLEMENTED. flyer-carousel.tsx
  // hit this exact problem first -- RN-web's horizontal ScrollView answers
  // touch and a drag scrollbar but not a mouse -- and its fix (a non-passive
  // `addEventListener('wheel', ...)`, pointer-capture drag gated on
  // `pointerType === 'mouse'`, hover gated on `matchMedia('(hover: hover)')`)
  // is the same fix this band needs now that a row of tiles and pills can
  // just as easily overflow a laptop viewport. The pure arithmetic
  // (`clampOffset`, `nextWheelOffset`, `supportsHover`) was lifted out of
  // flyer-carousel.tsx into mouse-pan.ts for exactly this reuse -- see that
  // file's own header comment. What is NOT shared is the effectful wiring:
  // the flyer carousel is PAGED and settles onto the nearest card
  // (`nearestIndex`), while this band is a free-scrolling row with no pages
  // to settle onto -- it only ever needs to stay between 0 and the end of its
  // own content, so `maxOffset` below is measured content-vs-viewport width
  // rather than card-count-times-card-width.
  const scroller = useRef<ScrollView>(null);
  const offsetXRef = useRef(0);
  const viewportWidthRef = useRef(0);
  const contentWidthRef = useRef(0);
  const dragRef = useRef<{ startX: number; startOffset: number } | null>(null);

  function maxOffset(): number {
    return Math.max(0, contentWidthRef.current - viewportWidthRef.current);
  }

  function handleLayout(event: LayoutChangeEvent) {
    viewportWidthRef.current = event.nativeEvent.layout.width;
  }

  function handleContentSizeChange(width: number) {
    contentWidthRef.current = width;
  }

  // Keeps `offsetXRef` honest against ANY scroll -- ours (wheel, drag) or the
  // browser's own (a plain touch-swipe on a web build). Web only: native
  // never drives the wheel/drag paths that read this ref.
  function handleScrollSync(event: NativeSyntheticEvent<NativeScrollEvent>) {
    offsetXRef.current = event.nativeEvent.contentOffset.x;
  }

  // Vertical wheel delta -> horizontal pan. `preventDefault` is the other
  // half of the affordance: without it the page behind the band scrolls
  // instead. See the `addEventListener` effect below for why this cannot be
  // wired through the JSX `onWheel` prop -- the exact defect Task 14 found
  // and fixed on the flyer carousel.
  //
  // `shouldConsumeWheel` runs FIRST, before `preventDefault()` -- the fix for
  // the dead zone a shop with only a few categories used to sit in. With few
  // enough categories to fit a 1320px column, `maxOffset()` is 0: there is
  // nowhere for this band to pan, so the tick must fall through and scroll
  // the page instead of being swallowed into nothing. See mouse-pan.ts's own
  // comment on `shouldConsumeWheel` for the full rule, including the end-of-
  // travel case.
  function handleWheel(event: { deltaX: number; deltaY: number; preventDefault: () => void }) {
    const delta = wheelPanDelta(event.deltaX, event.deltaY);
    if (!shouldConsumeWheel(offsetXRef.current, maxOffset(), delta)) return;
    event.preventDefault();
    const next = nextWheelOffset(offsetXRef.current, event.deltaX, event.deltaY, maxOffset());
    offsetXRef.current = next;
    scroller.current?.scrollTo({ x: next, animated: false });
  }

  // `handleWheelRef` exists only so the listener -- attached once per mount
  // of the scrollable node, not on every render -- always calls the LATEST
  // `handleWheel` closure instead of the stale one captured when the
  // listener was first attached. Same pattern flyer-carousel.tsx uses for
  // the identical reason.
  const handleWheelRef = useRef(handleWheel);
  useEffect(() => {
    handleWheelRef.current = handleWheel;
  });

  // A JSX `onWheel` prop is routed through React's own root-delegated,
  // `{ passive: true }` listener, which makes `preventDefault()` inside it a
  // silent no-op -- confirmed in this repo's own installed react-dom (see
  // flyer-carousel.tsx's identical comment) -- so the page keeps scrolling
  // behind the band regardless. `addEventListener` straight on the
  // scrollable DOM node, non-passively, is the one configuration that
  // actually prevents it. `scroller.current` on web IS that node --
  // react-native-web's ScrollView forwards its ref straight through -- and on
  // native `scroller.current` is an RN ScrollView instance with no such
  // method, so `Platform.OS !== 'web'` guards it twice over. Re-runs on
  // `categories.length` because that is what could change whether the
  // ScrollView mounts at all (`shouldShowCategoryBand` below).
  useEffect(() => {
    if (Platform.OS !== 'web') return undefined;
    const node = scroller.current as unknown as {
      addEventListener?: (type: 'wheel', cb: (event: WheelEvent) => void, options?: AddEventListenerOptions) => void;
      removeEventListener?: (type: 'wheel', cb: (event: WheelEvent) => void, options?: AddEventListenerOptions) => void;
    } | null;
    if (!node?.addEventListener) return undefined;
    const listener = (event: WheelEvent) => handleWheelRef.current(event);
    node.addEventListener('wheel', listener, { passive: false });
    return () => node.removeEventListener?.('wheel', listener, { passive: false });
  }, [categories.length]);

  // Drag-to-grab. Gated on `pointerType === 'mouse'` so a touch pointer
  // (which already scrolls the band natively, on both native and web) never
  // reaches any of this. `setPointerCapture` keeps the drag tracking after
  // the pointer leaves the band's own bounds.
  function handlePointerDown(event: {
    pointerType: string; pointerId: number; clientX: number;
    currentTarget?: { setPointerCapture?: (id: number) => void };
  }) {
    if (event.pointerType !== 'mouse') return;
    event.currentTarget?.setPointerCapture?.(event.pointerId);
    dragRef.current = { startX: event.clientX, startOffset: offsetXRef.current };
  }

  function handlePointerMove(event: { clientX: number }) {
    const drag = dragRef.current;
    if (!drag) return;
    const dx = event.clientX - drag.startX;
    const next = clampOffset(drag.startOffset - dx, maxOffset());
    offsetXRef.current = next;
    scroller.current?.scrollTo({ x: next, animated: false });
  }

  function handlePointerUp() {
    dragRef.current = null;
  }

  // Hover lift on a tile (docs/design/storefront-bold-motion-mockup.html's
  // `.catcard:hover{transform:translateY(-2px)}`) -- read once, at mount, via
  // `supportsHover`, the same `(hover: hover)` gate flyer-carousel.tsx arms
  // its arrows with. `Platform.OS === 'web'` alone is TRUE in a phone's
  // browser too, and mobile WebKit/Chrome synthesise `onHoverIn` after a tap
  // ("ghost hover") -- `hoverCapable` being `false` there is what keeps a
  // touch tap from lifting a tile it never actually hovered.
  const [hoverCapable] = useState(supportsHover);
  const [hoveredCategory, setHoveredCategory] = useState<string | null>(null);

  function armHover(name: string) {
    if (hoverCapable) setHoveredCategory(name);
  }

  if (!shouldShowCategoryBand(categories)) return null;

  return (
    <View style={styles.band} testID="storefront-category-band">
      <View style={styles.head}>
        <Text style={[styles.title, { color: colors.muted }]}>Shop by category</Text>
        <Text style={[styles.count, { color: colors.muted }]}>
          {categories.length} {categories.length === 1 ? 'category' : 'categories'}
        </Text>
      </View>

      {/* Horizontal rather than wrapping: a wrapping row is a block of
          unpredictable height above the goods. `showsHorizontalScrollIndicator=
          {false}` because on web the bar would sit over the last card. */}
      <ScrollView
        ref={scroller}
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.row}
        onLayout={handleLayout}
        onContentSizeChange={handleContentSizeChange}
        onScroll={Platform.OS === 'web' ? handleScrollSync : undefined}
        scrollEventThrottle={Platform.OS === 'web' ? 16 : undefined}
        // Web-only pointer props for drag-to-grab -- see the identical typing
        // comment in flyer-carousel.tsx: RN's `ScrollViewProps` declares
        // these against `NativeSyntheticEvent<NativePointerEvent>`, but
        // react-native-web hands the callback flat DOM synthetic events
        // (`event.clientX`, not `event.nativeEvent.clientX`) instead, so the
        // declared type describes a shape this platform never actually
        // provides.
        {...(Platform.OS === 'web' ? ({
          onPointerDown: handlePointerDown,
          onPointerMove: handlePointerMove,
          onPointerUp: handlePointerUp,
          onPointerCancel: handlePointerUp,
        } as any) : {})}
      >
        {/* THE SLIDING FILL. `pointerEvents="none"` so it never steals a tap
            meant for the tile/pill painted over it; rendered BEHIND them
            (first in this row -- later siblings paint on top) is what lets
            it show through a selected PILL's own now-transparent fill, and
            sit harmlessly hidden under a selected TILE's opaque photo -- see
            the header comment above for why that split is correct rather
            than a gap. Withheld entirely until something is selected and its
            layout measured (`active && indicatorBox`) -- there is nothing to
            draw a box around yet, the same reasoning that keeps
            ShopTabRail's own pill from flying in from off-screen on first
            paint. */}
        {active && indicatorBox ? (
          <Animated.View
            testID="storefront-category-indicator"
            pointerEvents="none"
            style={[
              styles.indicator,
              { width: indicatorBox.width, borderRadius: indicatorBox.radius, backgroundColor: colors.ink },
              indicatorStyle,
            ]}
          />
        ) : null}
        {categories.map((category) => {
          const selected = active === category.name;
          const photo = photos.get(category.name);
          return photo ? (
            <CategoryTile
              key={category.name}
              category={category}
              photoUrl={photo}
              colors={colors}
              selected={selected}
              hovered={hoverCapable && hoveredCategory === category.name}
              onHoverIn={() => armHover(category.name)}
              onHoverOut={() => setHoveredCategory(null)}
              onSelect={onSelect}
              onLayout={(event) => handleItemLayout(category.name, RADIUS.inset, event)}
            />
          ) : (
            <CategoryPill
              key={category.name}
              category={category}
              colors={colors}
              selected={selected}
              onSelect={onSelect}
              onLayout={(event) => handleItemLayout(category.name, RADIUS.pill, event)}
            />
          );
        })}
      </ScrollView>
    </View>
  );
}

// The tile's photo, derived rather than authored -- see the header comment on
// CategoryBand for why. One pass over `products`, building a name -> url map
// as it goes and keeping only the FIRST url seen per name, rather than one
// `products.find(p => p.category === c.name && p.imageUrl)` per category --
// same result (the first photographed product in catalogue order, per
// category), O(products) instead of O(categories * products).
export function firstPhotoByCategory(products: StorefrontProduct[]): Map<string, string> {
  const photos = new Map<string, string>();
  for (const product of products) {
    if (!product.category || !product.imageUrl) continue;
    if (!photos.has(product.category)) photos.set(product.category, product.imageUrl);
  }
  return photos;
}

const TILE_WIDTH = 136;
const TILE_HEIGHT = 92;

// THE WINDOW: a photograph, a bottom-weighted scrim, the label and the count
// on it. The scrim is `SCRIM_GRADIENT` (scale.ts) -- the SAME constant the
// shop card's own hero (`storefront-hero-scrim`, theme-shared.tsx) draws
// with, not merely two literals tuned to look alike. They used to be the
// latter: this tile's own colour and stop locations had drifted from the
// hero's (0.66 alpha at [0.3, 1] here, 0.82 at [0.3, 0.92] there) while this
// very comment claimed they matched. One shared constant is what makes "one
// gradient vocabulary for type over an unknown photo" true rather than
// aspirational.
function CategoryTile({
  category, photoUrl, colors, selected, hovered, onHoverIn, onHoverOut, onSelect, onLayout,
}: {
  category: StorefrontCategory;
  photoUrl: string;
  colors: PaletteColors;
  selected: boolean;
  hovered: boolean;
  onHoverIn: () => void;
  onHoverOut: () => void;
  onSelect: (category: string) => void;
  // Reports this tile's own box to CategoryBand's sliding indicator (see its
  // header comment) -- fired at mount whether or not this tile starts
  // selected, the same "every item measures itself" rule ShopTabRail's tabs
  // already follow.
  onLayout: (event: LayoutChangeEvent) => void;
}) {
  // KNOWN, NOT FIXED IN THIS PASS: Task 17's press-feedback audit found that
  // this Pressable's hover lift (`tileHovered`, below) and press-feedback's
  // own press-scale share one `style` array and so are exactly the
  // transform-array collision the audit warns about (RN style flattening
  // replaces a whole `transform` array on key collision rather than merging
  // it element-by-element) -- a mouse hovering this tile and then clicking
  // it loses the -2px lift for the duration of the press, snapping back on
  // release. Left as-is rather than restructured here: Task 17's own brief
  // scopes the fix to hover transforms it ADDS (ProductTile's new one, which
  // uses the collision-safe outer-View/inner-Pressable split this tile could
  // also adopt), not to retroactively reworking an already-shipped,
  // already-tested component whose test suite
  // (storefront-category-band-web.test.tsx) asserts hover state through
  // THIS exact node. Worth its own follow-up task.
  return (
    <Pressable
      testID={`storefront-category-${category.name}`}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      accessibilityLabel={`${category.name}, ${category.productCount} products`}
      onPress={() => onSelect(category.name)}
      onHoverIn={onHoverIn}
      onHoverOut={onHoverOut}
      onLayout={onLayout}
      style={pressable([styles.tile, hovered && styles.tileHovered])}
    >
      <Image source={{ uri: photoUrl }} style={styles.tilePhoto} resizeMode="cover" />
      <LinearGradient
        testID="storefront-category-scrim"
        colors={SCRIM_GRADIENT.colors}
        locations={SCRIM_GRADIENT.locations}
        style={StyleSheet.absoluteFill}
        pointerEvents="none"
      />
      <View style={styles.tileFoot}>
        {/* THE ACTIVE STATE: an accent-filled chip around the label, on the
            tile -- explicitly not a ring or a border (considered and
            rejected in the plan), so the accent keeps meaning exactly one
            thing on this page: "this is the filter that is on". Unselected,
            the label carries no chip at all -- plain on-scrim type, the same
            shape the mockup's own `.catcard .lb` is. */}
        <View
          testID={`storefront-category-${category.name}-chip`}
          style={[styles.tileChip, selected && styles.tileChipSelected, selected && { backgroundColor: colors.accent }]}
        >
          <Text
            style={[styles.tileChipText, { color: selected ? colors.ground : ON_SCRIM_INK }]}
            numberOfLines={1}
          >
            {category.name}
          </Text>
        </View>
        <Text style={[styles.tileCount, { color: ON_SCRIM_MUTED }]}>{category.productCount}</Text>
      </View>
    </Pressable>
  );
}

// THE FALLBACK: the pill this band rendered before this pass. Its shape,
// text and count are unchanged; its SELECTED fill is not -- see the inline
// comment on `styles.pill`'s selected branch below.
function CategoryPill({
  category, colors, selected, onSelect, onLayout,
}: {
  category: StorefrontCategory;
  colors: PaletteColors;
  selected: boolean;
  onSelect: (category: string) => void;
  // Reports this pill's own box to CategoryBand's sliding indicator -- see
  // CategoryTile's identical prop and CategoryBand's own header comment.
  onLayout: (event: LayoutChangeEvent) => void;
}) {
  return (
    <Pressable
      testID={`storefront-category-${category.name}`}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      accessibilityLabel={`${category.name}, ${category.productCount} products`}
      onPress={() => onSelect(category.name)}
      onLayout={onLayout}
      // A pill is a CONTROL, and an unselected one is `ground` sitting on
      // `soft` -- 1.04:1 on the ink palette, so it had no boundary at all and
      // read as a word floating on the page. `edge` is the token that clears
      // 3:1 for exactly this.
      //
      // Selected is TRANSPARENT, not an ink fill of its own -- the sliding
      // indicator underneath (CategoryBand's `indicatorStyle`) is what a
      // selected pill's fill IS now, the same substitution ShopTabRail
      // already made for its own selected tab (see that file's `tabActive`
      // comment). The border stays ink -- same colour as the indicator's own
      // fill, so it draws invisibly once the indicator has measured this
      // pill's box, and is what still outlines the pill correctly on the one
      // frame before that (a device that never fires a layout event). Pill
      // width/border stay identical to the unselected state either way, so
      // the row still never shifts by 2px when one is tapped.
      style={pressable([
        styles.pill,
        selected
          ? { backgroundColor: 'transparent', borderColor: colors.ink }
          : { backgroundColor: colors.ground, borderColor: colors.edge },
      ])}
    >
      <Text style={[styles.name, { color: selected ? colors.ground : colors.ink }]} numberOfLines={1}>
        {category.name}
      </Text>
      {/* The count is the reason a pill is worth tapping -- "Solar 11" says
          how much is behind it. On the selected pill it takes the on-ink
          muted step, which is the token that exists precisely because
          `muted` is unreadable on an ink fill. */}
      <Text style={[styles.meta, { color: selected ? colors.onDarkMuted : colors.muted }]}>
        {category.productCount}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  band: { paddingHorizontal: SPACE.page, paddingTop: 18 },
  head: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 11 },
  title: { fontSize: TYPE.eyebrow, fontWeight: '800', letterSpacing: LETTER.meta, textTransform: 'uppercase' },
  count: { fontSize: TYPE.metaSmall, fontWeight: '700' },
  // `position: 'relative'` is what makes the indicator's `position:
  // 'absolute'` measure against THIS row rather than some further ancestor
  // -- the identical technique ShopTabRail's own `row` uses for its pill.
  row: { position: 'relative', flexDirection: 'row', gap: 8, paddingRight: SPACE.page },
  // `width`/`borderRadius` are set inline at the call site (`indicatorBox`
  // state, from the active item's measured layout) -- never here, and never
  // animated. `top: 0, bottom: 0` stretch it to the row's own height,
  // matching whatever the active item's own height is.
  indicator: { position: 'absolute', left: 0, top: 0, bottom: 0 },
  pill: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    borderRadius: RADIUS.pill, paddingHorizontal: 16, paddingVertical: 10,
    borderWidth: 1,
  },
  name: { fontSize: 12.5, fontWeight: '800' },
  meta: { fontSize: 12.5, fontWeight: '700', ...TABULAR },
  tile: { width: TILE_WIDTH, height: TILE_HEIGHT, borderRadius: RADIUS.inset, overflow: 'hidden' },
  // Transform only, and a static toggle rather than a timed animation -- the
  // same "direct manipulation, not animation" reasoning press-feedback.ts
  // gives for its own press-scale, so this needs no reduced-motion gate: mouse
  // arrival over a control it is touching is not the unbidden movement that
  // guardrail exists for.
  tileHovered: { transform: [{ translateY: -2 }] },
  tilePhoto: { ...StyleSheet.absoluteFill },
  tileFoot: {
    position: 'absolute', left: 10, right: 10, bottom: 8,
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end', gap: 6,
  },
  tileChip: {},
  tileChipSelected: { borderRadius: RADIUS.pill, paddingHorizontal: 9, paddingVertical: 4 },
  tileChipText: { fontSize: 12, fontWeight: '800' },
  tileCount: { fontSize: 10.5, fontWeight: '700', ...TABULAR },
});

// Pulled into its own tiny hook for the identical reason shop-tabs.tsx's own
// useAnimatedPillStyle is: Reanimated's babel plugin needs to see this as a
// worklet, and it reads more cleanly next to the one shared value it closes
// over than inlined in CategoryBand's already-long body.
function useAnimatedIndicatorStyle(indicatorX: SharedValue<number>) {
  return useAnimatedStyle(() => ({
    transform: [{ translateX: indicatorX.value }],
  }));
}
