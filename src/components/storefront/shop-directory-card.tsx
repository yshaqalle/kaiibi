import { LinearGradient } from 'expo-linear-gradient';
import { useEffect, useState } from 'react';
import {
  Image, Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle,
} from 'react-native';
import Animated, { FadeInUp, useReducedMotion } from 'react-native-reanimated';

import { supportsHover } from '@/components/storefront/mouse-pan';
import { pressable } from '@/components/storefront/press-feedback';
import {
  DISPLAY_FONT, HERO_SCRIM, LETTER, ON_SCRIM_INK, ON_SCRIM_MUTED, RADIUS, SPACE, TABULAR, TYPE,
} from '@/components/storefront/scale';
import { isConfigured, isOpenAt, nextOpeningLabel } from '@/lib/store-hours';
import { shopBlurb } from '@/lib/storefront-directory';
import {
  DIRECTORY_STATE_OPEN, DIRECTORY_STATE_SHUT, KAIIBI_BLUE, KAIIBI_INK, type PaletteColors,
} from '@/lib/storefront-catalog';
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
//
// ONCE PER SESSION, NOT PER RENDER OR PER CARD -- the SAME shape
// heroHasRisen/markHeroRisen/resetHeroRisenForTests give ShopAnchor
// (theme-shared.tsx), built again here rather than imported from there:
// that module drags checkout-form, storefront-order and @/lib/supabase in
// behind it, none of which a directory card has anything to do with -- the
// identical reasoning that split ON_SCRIM_INK/ON_SCRIM_MUTED out of
// theme-shared and into scale.ts instead of leaving CategoryBand to import
// them from there.
//
// Module-level and UNKEYED, unlike HERO_RISEN's per-slug Set: a shop's hero
// rises once per VISIT to that shop's own page, but this grid is one page a
// customer either has or hasn't already watched enter this session --
// narrowing by city or category re-renders the SAME grid, it does not open a
// new one, so a card that only now scrolls into view because a filter chip
// was tapped must not spend a rise the rest of the grid already used.
let DIRECTORY_ENTERED = false;

export function directoryHasEntered(): boolean {
  return DIRECTORY_ENTERED;
}

export function markDirectoryEntered(): void {
  DIRECTORY_ENTERED = true;
}

// TEST-ONLY SEAM, the same reason resetHeroRisenForTests exists: this module
// stays loaded for a whole Jest file's run, so one test's grid entering would
// otherwise leak into the next test that shares this module.
export function resetDirectoryEnteredForTests(): void {
  DIRECTORY_ENTERED = false;
}

// THE DECISION, pulled out on its own for the identical reason heroRiseDelay
// is (theme-shared.tsx): nothing about it can be asserted through a render,
// since jest/reanimated-mock.js renders Animated.View as a plain View and
// drops `entering` on the floor. Reduced motion means no animation at any
// index, never a faster one; an already-entered grid never replays.
export function directoryEntranceDelay(
  reducedMotion: boolean, alreadyEntered: boolean, index: number
): number | null {
  if (reducedMotion || alreadyEntered) return null;
  // A tighter step than the hero's 80ms (heroRiseDelay, theme-shared.tsx): a
  // grid can hold dozens of cards where the hero only ever had two or three
  // lines, and an 80ms step would leave a later row waiting whole seconds
  // for its turn.
  return index * 40;
}

// THE TRANSFORM COLLISION (press-feedback.ts's own header comment), MET HEAD
// ON RATHER THAN DODGED. ProductTile and CategoryTile's fix for the same
// problem is to put a hover lift and a press-scale on two DIFFERENT nodes --
// but this card has no narrower node to hang a press-scale on: the whole
// card, photo and body together, is one press target, so a mouse hovering it
// and a thumb pressing it land on the SAME `Pressable`. RN style flattening
// replaces a whole `transform` ARRAY on a key collision rather than merging
// it element-by-element, so `[hovered && { transform: [...] }, pressable(...)]`
// would lose the lift for the entire duration of a press -- the exact defect
// CategoryTile's own `tileHovered` still carries (category-band.tsx) and
// this card does not copy. Composed here instead, into ONE array built fresh
// from whichever of hovered/pressed are actually true, so a lift and a
// press-scale can both be present in it at once. 0.72/0.97 match
// press-feedback.ts's own `pressable()` values exactly, so a press here
// still reads identically to a press anywhere else on this page.
function cardMotionStyle(base: StyleProp<ViewStyle>, hovered: boolean) {
  return ({ pressed }: { pressed: boolean }): StyleProp<ViewStyle> => {
    const transform: Array<{ translateY: number } | { scale: number }> = [];
    if (hovered) transform.push({ translateY: -2 });
    if (pressed) transform.push({ scale: 0.97 });
    return [
      base,
      pressed ? { opacity: 0.72 } : null,
      transform.length > 0 ? { transform } : null,
    ];
  };
}

// Visible sell-tags before the rest fold into one overflow chip -- the
// mockup's own count (two tags, then "+7").
const TAG_LIMIT = 2;

export function ShopDirectoryCard({
  shop, colors, onPress, index = 0,
}: {
  shop: PublicShopSummary;
  colors: PaletteColors;
  onPress: (slug: string) => void;
  // Which cell this card sits at in the grid's own flat data array --
  // FlatList's renderItem hands its own `index` straight through
  // (src/app/store/index.tsx) so directoryEntranceDelay above can space
  // cards out by position instead of every card firing on the same frame.
  // Defaulted: every other render of this component in this file's own test
  // suite is a lone card with no grid around it to number it, and 0 -- first
  // -- is the right answer for that.
  index?: number;
}) {
  // The initial, for a shop with no photograph. Not a placeholder image and not
  // an empty grey box: a monogram reads as designed, which is the test every
  // no-photo fallback in this folder has to pass (see ProductTile's plate and
  // CategoryBand's dropped image_url).
  const initial = shop.shopName.trim().charAt(0).toUpperCase() || '?';
  const hoursConfigured = isConfigured(shop.openingHours);
  const now = new Date();
  const open = isOpenAt(shop.openingHours ?? {}, now);
  // Only asked when the shop is shut -- an open shop has nothing to answer,
  // and a shop that has never set hours is filtered out by hoursConfigured
  // before this ever runs.
  const closedLabel = hoursConfigured && !open ? nextOpeningLabel(shop.openingHours ?? {}, now) : null;
  const stateWord = hoursConfigured ? (open ? 'Open' : 'Closed') : null;
  // Open: the city. Closed: WHEN IT REOPENS is the more useful half of the
  // line -- see nextOpeningLabel's own comment -- so it takes the city's
  // place there; a closed shop with nothing opening in the coming week (or
  // no city on file to fall back to) still ends the line cleanly rather than
  // leaving a trailing " · " with nothing after it.
  const metaSecondHalf = hoursConfigured ? (open ? shop.city : (closedLabel ?? shop.city)) : shop.city;

  // A shop with nothing in stock has no categories either -- both are
  // derived from the same listed, in-stock products
  // (list_public_storefronts) -- so an empty `categories` IS "nothing in
  // stock", the exact case the old `productCount === 0` copy existed to say
  // plainly rather than leave the row silently empty.
  const visibleTags = shop.categories.slice(0, TAG_LIMIT);
  const overflowCount = shop.categories.length - visibleTags.length;
  const nothingInStock = shop.categories.length === 0;

  // WEB HOVER-LIFT, NEVER NATIVE -- the same `supportsHover()` gate
  // CategoryBand and ProductTile arm theirs with, read once at mount rather
  // than trusted to fall out of "no mouse event fired": `Platform.OS ===
  // 'web'` alone is true in a phone's browser too, and mobile WebKit/Chrome
  // synthesise a hover event after a tap that a platform-only gate cannot
  // tell apart from a real mouse.
  const [hoverCapable] = useState(supportsHover);
  const [hovered, setHovered] = useState(false);

  // Reduced motion: no entrance at all, not a faster one -- see
  // directoryEntranceDelay above. `alreadyEntered` is read once per render so
  // the delay this card computes and the flag it later sets always agree
  // about whether THIS mount is the grid's first eligible one.
  const reducedMotion = useReducedMotion();
  const alreadyEntered = directoryHasEntered();
  // Marked spent only when the entrance actually played -- the same rule
  // ShopAnchor's own effect follows (theme-shared.tsx) and for the same
  // reason: a mount under reduced motion never showed a rise, so it must not
  // spend the one the rest of the session is still owed.
  useEffect(() => {
    if (!reducedMotion) markDirectoryEntered();
  }, [reducedMotion]);
  const enterDelay = directoryEntranceDelay(reducedMotion, alreadyEntered, index);
  const entering = enterDelay === null ? undefined : FadeInUp.duration(420).delay(enterDelay);

  return (
    // `flex: 1`, LOAD-BEARING: `cell` (src/app/store/index.tsx) is `{ flex: 1
    // }` and this Animated.View, not the Pressable below, is its actual JSX
    // child now that entrance motion wraps the card -- without a flex of its
    // own here, an unstyled View hugs its content on the vertical axis
    // (`columnWrapperStyle`'s default `alignItems: 'stretch'` still stretches
    // CELLS to the tallest row-mate, but stops there) and `card`'s own `flex:
    // 1` below has nothing left to grow INTO, so three shops with different
    // chip counts in one row draw three different-height rectangles instead
    // of one shared height. This is exactly the ragged grid `numberOfLines`
    // on the blurb used to prevent.
    <Animated.View entering={entering} style={styles.cardShell}>
      <Pressable
        testID={`storefront-directory-card-${shop.slug}`}
        accessibilityRole="link"
        accessibilityLabel={[
          shop.shopName,
          shop.city,
          // Announced in the label rather than left to a dot sighted users
          // read at a glance.
          hoursConfigured ? (open ? 'open now' : 'closed now') : null,
          `${shop.productCount} items`,
        ].filter(Boolean).join(', ')}
        onPress={() => onPress(shop.slug)}
        onHoverIn={() => { if (hoverCapable) setHovered(true); }}
        onHoverOut={() => setHovered(false)}
        style={cardMotionStyle([styles.card, { backgroundColor: colors.ground }], hoverCapable && hovered)}
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

          {/* THE STATE MOVES OFF THE PHOTOGRAPH AND INTO THIS LINE. It used
              to sit on a fixed near-white plate on the photo, because over a
              photograph of unknown brightness that plate was the only safe
              surface for it. On the card's own neutral ground that
              constraint is gone, and a dot beside the word reads as PART OF
              the card rather than a badge stuck onto it -- the mockup's own
              `.ct` line. The dot is never the only signal: the word says the
              same thing in text, for a reader who cannot tell the two dot
              colours apart. A shop that has never set hours gets neither --
              absent is honest, "Closed" would not be -- and keeps just the
              city. */}
          {stateWord || metaSecondHalf ? (
            <View testID={`storefront-directory-meta-${shop.slug}`} style={styles.meta}>
              {stateWord ? (
                <>
                  <View
                    testID={`storefront-directory-dot-${shop.slug}`}
                    style={[styles.dot, open ? styles.dotOpen : styles.dotShut]}
                  />
                  <Text
                    testID={`storefront-directory-state-${shop.slug}`}
                    style={[styles.metaText, { color: colors.muted }]}
                  >
                    {stateWord}
                  </Text>
                </>
              ) : null}
              {/* Its OWN Text node rather than folded into either
                  neighbour's string: this card's own `textOf` test helper
                  joins every text node it finds with a single space, so a
                  separator baked into one string (`` · ${city}``) would sit
                  beside that helper's own space and read as two. Three plain
                  strings compose cleanly either way a reader gets at them --
                  through this helper or through a screen reader walking the
                  row -- and a closed shop with nothing to say after the word
                  (no reopening estimate, no city) never renders a dangling
                  separator, because this only appears when BOTH sides of it
                  do. */}
              {stateWord && metaSecondHalf ? (
                <Text style={[styles.metaText, { color: colors.muted }]}>·</Text>
              ) : null}
              {metaSecondHalf ? (
                <Text style={[styles.metaText, { color: colors.muted }]} numberOfLines={1}>
                  {metaSecondHalf}
                </Text>
              ) : null}
            </View>
          ) : null}

          {/* SELL-TAGS, NOT A BLURB. `shop.categories` is what the shop
              actually has on the shelf today (see the field's own comment,
              types/models.ts), which says more about what is inside than a
              sentence of `about` copy does, and cannot go stale the way a
              paragraph nobody re-reads can. Capped at TAG_LIMIT visible, the
              remainder folded into one "+N" chip, so the card's height does
              not depend on whether a shop stocks two categories or twelve. */}
          {visibleTags.length > 0 ? (
            <View testID={`storefront-directory-tags-${shop.slug}`} style={styles.tags}>
              {visibleTags.map((category) => (
                <View key={category} style={[styles.tag, { backgroundColor: colors.soft }]}>
                  <Text style={[styles.tagText, { color: colors.muted }]} numberOfLines={1}>{category}</Text>
                </View>
              ))}
              {overflowCount > 0 ? (
                <View testID={`storefront-directory-tags-overflow-${shop.slug}`} style={[styles.tag, { backgroundColor: colors.soft }]}>
                  <Text style={[styles.tagText, { color: colors.muted }]}>{`+${overflowCount}`}</Text>
                </View>
              ) : null}
            </View>
          ) : null}

          {nothingInStock || shop.offersDelivery ? (
            <View style={styles.foot}>
              {/* Stands in for the tags row above, which a shop with nothing
                  in stock cannot have (categories are derived from in-stock
                  products) -- without this the row would just be silently
                  empty, which reads as a broken card, exactly what this copy
                  has always existed to prevent. */}
              {nothingInStock ? (
                <View style={[styles.chip, { backgroundColor: colors.soft }]}>
                  <Text style={[styles.chipText, { color: colors.muted }]}>Nothing in today</Text>
                </View>
              ) : null}
              {shop.offersDelivery ? (
                <View style={[styles.chip, { backgroundColor: colors.soft }]}>
                  <Text style={[styles.chipText, { color: colors.muted }]}>Delivers</Text>
                </View>
              ) : null}
            </View>
          ) : null}
        </View>
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  // The entrance wrapper's own flex -- see the comment at its call site above.
  cardShell: { flex: 1 },
  card: { borderRadius: RADIUS.card, padding: 12, flex: 1, minWidth: 0 },
  photo: {
    aspectRatio: 16 / 10, borderRadius: RADIUS.inset, overflow: 'hidden',
    alignItems: 'center', justifyContent: 'center',
  },
  image: { width: '100%', height: '100%' },
  monogram: { fontFamily: DISPLAY_FONT, fontSize: 34, fontWeight: '700', letterSpacing: LETTER.displayLoud },
  body: { paddingHorizontal: 6, paddingTop: 12, paddingBottom: 4 },
  name: { fontSize: 15, fontWeight: '800', letterSpacing: LETTER.display },
  // Sentence case, not the uppercase-and-tracked treatment the old lone
  // `city` style carried -- this line now reads as a short sentence ("Open ·
  // Hargeisa"), matching the mockup's own `.ct` (font-size 10, no
  // text-transform), where the old style was tuned for a city standing
  // completely alone.
  meta: { flexDirection: 'row', alignItems: 'center', marginTop: 6, flexWrap: 'wrap', gap: 5 },
  metaText: { fontSize: TYPE.nameSub, fontWeight: '700' },
  // 6px, matching the mockup's own `.dot3`. Fixed colour, never palette --
  // see DIRECTORY_STATE_OPEN/SHUT's own comment (storefront-catalog.ts) for
  // why this needs a pair that means the same thing on every palette, and
  // why it is not simply `stateOpen`/`stateShut` reused: those colour TEXT
  // on the featured card's on-photo plate, this fills a shape on the grid
  // card's own neutral ground.
  dot: { width: 6, height: 6, borderRadius: 3 },
  dotOpen: { backgroundColor: DIRECTORY_STATE_OPEN },
  dotShut: { backgroundColor: DIRECTORY_STATE_SHUT },
  // THE SELL-TAGS -- quiet on purpose, next to the louder pill chips below
  // (`chip`/`chipText`): a smaller radius, a smaller size, no letter-spacing.
  // The mockup's own `.tg` is the source (`border-radius:6px`; picked up here
  // a touch looser at 8 to sit closer to this file's own RADIUS scale without
  // inventing a third rounding value for one row).
  tags: { flexDirection: 'row', gap: 6, flexWrap: 'wrap', marginTop: 10 },
  tag: { borderRadius: 8, paddingHorizontal: 8, paddingVertical: 4 },
  tagText: { fontSize: 10.5, fontWeight: '700' },
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

  // Sized here rather than on an inner `Image` now: with a photo, this
  // `Pressable` IS the photo's own footprint, not a block sitting above one.
  feature: { borderRadius: RADIUS.card, overflow: 'hidden' },
  featureArtWide: { height: 220 },
  featureArtTall: { aspectRatio: 16 / 10 },
  // The photo and its scrim share this -- both fill whatever `feature`,
  // `featureArtWide` or `featureArtTall` above sized the card to.
  featurePhoto: { ...StyleSheet.absoluteFill },
  // The hero content, stacked on top of the photo+scrim by being their next
  // sibling (RN paints later siblings over earlier ones) rather than by any
  // z-index. `flex: 1` claims the whole card -- the photo and scrim are
  // absolutely positioned and out of flow, so nothing else competes for the
  // space -- and `justifyContent: 'flex-end'` is what puts the text at the
  // bottom of the photo instead of the top.
  featureScrimContent: { flex: 1, justifyContent: 'flex-end', padding: SPACE.card },
  featureScrimContentWide: { padding: 28 },
  featureNameRow: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', gap: 12 },
  // `minWidth: 0` is load-bearing: without it a long shop name refuses to
  // wrap inside a `flex: 1` row and pushes the Visit button off the card
  // instead of yielding to it.
  featureNameCol: { flex: 1, minWidth: 0 },
  // Filled `KAIIBI_BLUE` at the call site (never a hex here) -- this is the
  // third and, per the plan, last place on this page kaiibi's own blue
  // appears, after the mark plate and the selected filter chip in
  // src/app/store/index.tsx.
  featureVisit: { borderRadius: RADIUS.pill, paddingHorizontal: 16, paddingVertical: 10 },
  featureVisitText: { fontSize: 12.5, fontWeight: '800' },
  // Same fixed plate as `state` above, positioned top-left instead of
  // top-right -- see the call site's comment for why it needs its own style
  // rather than overriding `state`'s `right`.
  featurePill: {
    position: 'absolute', top: 10, left: 10,
    backgroundColor: 'rgba(255,255,255,0.94)',
    borderRadius: RADIUS.pill, paddingHorizontal: 11, paddingVertical: 5,
  },
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
  const hoursConfigured = isConfigured(shop.openingHours);
  const open = isOpenAt(shop.openingHours ?? {}, new Date());
  const hasPhoto = Boolean(shop.heroImageUrl);
  // The mockup's meta line is place AND trade together ("Main Stree ·
  // Menswear"). There is no separate "trade" field on a shop -- its first
  // listed `categories` entry stands in for one -- and either half can be
  // missing (a shop with no city on file, or one that has not listed
  // anything yet) without leaving a stray "·" behind.
  const trade = shop.categories[0];
  const metaLine = [shop.city, trade].filter(Boolean).join(' · ') || null;

  return (
    <Pressable
      testID={`storefront-directory-featured-${shop.slug}`}
      accessibilityRole="link"
      accessibilityLabel={[
        `Most to browse: ${shop.shopName}`,
        // Same reasoning the grid card already carries
        // (shop-directory-card.tsx:38-45): colour and a pill are not
        // available to a screen reader, so the open state has to be said in
        // words, not left to a pill sighted users read at a glance.
        hoursConfigured ? (open ? 'open now' : 'closed now') : null,
        `${shop.productCount} items`,
      ].filter(Boolean).join(', ')}
      onPress={() => onPress(shop.slug)}
      // `ink`, like the anchor card on a shop page and the Takings card on
      // Dashboard: one near-black surface is what stops a page of white
      // rectangles reading as a field of them. With a photo, the card's own
      // height becomes the photo's -- the wide/tall split that used to size
      // the `Image` now sizes this `Pressable`, because the photo is no
      // longer a block sitting above the text, it IS the card.
      style={pressable([
        styles.feature,
        hasPhoto && (wide ? styles.featureArtWide : styles.featureArtTall),
        { backgroundColor: colors.ink },
      ])}
    >
      {hasPhoto ? (
        <>
          <Image
            testID={`storefront-directory-featured-photo-${shop.slug}`}
            source={{ uri: shop.heroImageUrl! }}
            style={styles.featurePhoto}
            resizeMode="cover"
          />
          {/* Same treatment and the same constant as the shop page's own
              hero (`storefront-hero-scrim`, theme-shared.tsx) -- see
              HERO_SCRIM's own comment in scale.ts, which this card is the
              reason that comment now says "two surfaces" instead of one.
              Sibling of the photo, not a child of it, and rendered directly
              after it: RN paints later siblings on top, so this is what
              guarantees the scrim is always over the photograph and never
              floating loose without one -- the `hasPhoto` guard above is the
              only branch that can ever reach either node. */}
          <LinearGradient
            testID={`storefront-directory-featured-scrim-${shop.slug}`}
            colors={HERO_SCRIM.colors}
            locations={HERO_SCRIM.locations}
            style={styles.featurePhoto}
            pointerEvents="none"
          />
          {/* Same fixed near-white plate as the grid card's own `state`
              style above, and the same reasoning ("fixed, not palette,
              because the ground underneath is an unknown photograph") --
              reused rather than a second exception invented for this card.
              Its own style (`featurePill`) only because the mockup puts
              this one top-LEFT, not top-right: two absolute offsets on one
              box would stretch it edge to edge instead of moving it, so the
              position has to be its own style even though the plate and the
              text underneath it (`stateText`/`stateOpen`/`stateShut`) are
              shared as-is. */}
          {hoursConfigured ? (
            <View testID={`storefront-directory-featured-state-${shop.slug}`} style={styles.featurePill}>
              <Text style={[styles.stateText, open ? styles.stateOpen : styles.stateShut]}>
                {open ? 'Open now' : 'Closed now'}
              </Text>
            </View>
          ) : null}
          <View style={[styles.featureScrimContent, wide && styles.featureScrimContentWide]}>
            <Text style={[styles.featureTag, { color: ON_SCRIM_MUTED }]}>Most to browse</Text>
            <View style={styles.featureNameRow}>
              <View style={styles.featureNameCol}>
                <Text
                  testID={`storefront-directory-featured-name-${shop.slug}`}
                  style={[styles.featureName, { color: ON_SCRIM_INK }]}
                  numberOfLines={2}
                >
                  {shop.shopName}
                </Text>
                {metaLine ? (
                  <Text style={[styles.featureCity, { color: ON_SCRIM_MUTED }]} numberOfLines={1}>
                    {metaLine}
                  </Text>
                ) : null}
              </View>
              {/* A `View` styled as a button, not a second `Pressable`. The
                  whole card is already one press target with one
                  destination (`accessibilityRole="link"` above); a real
                  nested Pressable here would put two overlapping targets
                  over that one destination, and on RN web a press on this
                  inner one can fire both. The card IS the target -- this is
                  only what says so, and is hidden from screen readers for
                  the same reason the search glyph is (theme-shared.tsx):
                  the card's own accessibilityLabel already names the
                  destination. */}
              <View
                testID={`storefront-directory-featured-visit-${shop.slug}`}
                style={[styles.featureVisit, { backgroundColor: KAIIBI_BLUE }]}
                accessibilityElementsHidden
                importantForAccessibility="no"
              >
                <Text style={[styles.featureVisitText, { color: KAIIBI_INK }]}>Visit shop</Text>
              </View>
            </View>
          </View>
        </>
      ) : (
        // NO PHOTO: the ink-filled treatment this card has always had, kept
        // exactly as it was -- blurb, "Browse N items" chip and all. Its own
        // `View`, structurally apart from the photo branch above, so nothing
        // can ever paint a scrim (or the new hero content, sized for a
        // photograph that is not there) over a card with no photograph
        // underneath it.
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
            {hoursConfigured ? (
              <Text style={[styles.featureState, { color: colors.onDarkMuted }]}>
                {open ? 'Open now' : 'Closed now'}
              </Text>
            ) : null}
          </View>
        </View>
      )}
    </Pressable>
  );
}
