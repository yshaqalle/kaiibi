import { type ReactNode, useEffect, useRef, useState } from 'react';
import {
  Image, Pressable, ScrollView, StyleSheet, Text, TextInput, View, type StyleProp, type ViewStyle,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import Animated, {
  FadeInDown, runOnJS, useAnimatedReaction, useAnimatedStyle, useReducedMotion, useSharedValue, withSequence, withTiming,
} from 'react-native-reanimated';

import { Aurora } from '@/components/storefront/aurora';
import { type CheckoutDetails, CheckoutForm } from '@/components/storefront/checkout-form';
import {
  clearSlipTarget, countUpDuration, countUpValue, fireFlyToCart, setSlipTarget, slipBumpMotion,
} from '@/components/storefront/fly-to-cart';
import { OrderPlaced } from '@/components/storefront/order-placed';
import { pressable } from '@/components/storefront/press-feedback';
import {
  DISPLAY_FONT, HERO_SCRIM, LETTER, ON_SCRIM_INK, ON_SCRIM_MUTED, PROSE_MAX_WIDTH, RADIUS, SHOP_MAX_WIDTH, SPACE,
  TABULAR, TOUCH_TARGET, TYPE,
} from '@/components/storefront/scale';
import { formatCents } from '@/lib/currency';
import { openExternalUrl } from '@/lib/external-url';
import { isConfigured, isOpenAt } from '@/lib/store-hours';
import { waLink } from '@/lib/storefront';
import {
  addLine, cartItemCount, cartSubtotalCents, loadCart, saveCart, setQuantity, type StorefrontCart,
} from '@/lib/storefront-cart';
import { type ShopTabKey } from '@/components/storefront/shop-tabs';
import { collectLocation } from '@/lib/storefront-collect';
import { placeOrder, placeOrderViaWhatsApp, type PlacedOrder } from '@/lib/storefront-order';
import { CHECKOUT_BLUE, CHECKOUT_INK, WHATSAPP_BUTTON_GREEN, WHATSAPP_INK, type PaletteColors } from '@/lib/storefront-catalog';
import type { PublicDeliveryArea, PublicStorefront, StorefrontCategory, StorefrontProduct } from '@/types/models';

// The parts every theme needs. Kept out of any one theme so that Market is a
// theme and nothing else -- Counter importing its empty state from Market would
// make deleting or rewriting Market a change to the other two.
//
// `areas` is optional so a caller that has none to offer (the theme-level
// component tests predate Task 8 and never pass it) still type-checks and
// renders a collection-only checkout -- CheckoutForm already treats an empty
// list the same as `offersDelivery: false`.
export type ThemeProps = {
  storefront: PublicStorefront;
  products: StorefrontProduct[];
  colors: PaletteColors;
  areas?: PublicDeliveryArea[];
  // Optional and defaulting to [] for the same reason `areas` is: every
  // theme-level test predating the band passes none, and a theme with no
  // categories to offer must render exactly as it did before the band
  // existed -- CategoryBand returns null below its minimum anyway.
  categories?: StorefrontCategory[];
  // WHICH TAB IS SHOWING, and it is not the theme's state any more.
  //
  // All three themes held an identical `useState<ShopTabKey>`, which was fine
  // while a tab was a local toggle. It stopped being one the moment the tab
  // became part of the ADDRESS: /store/<slug>/about has to open on About, and
  // pressing About has to change the URL, and neither is something a theme can
  // do. StorefrontView owns it now -- from the route when there is one, from
  // its own state when there is not (the editor preview has no router).
  // Optional: a caller with no address to change (the editor preview, and
  // every test that renders a theme directly) omits them and useShopTab keeps
  // the state locally instead.
  tab?: ShopTabKey;
  onSelectTab?: (tab: ShopTabKey) => void;
};

// Returns null when the shop has no number. Publishing requires one, so this is
// the belt to that braces -- a page rendered from a row written before that rule
// existed should lose the button, not render one that opens a chat with nobody.
export function WhatsAppButton({ storefront }: { storefront: PublicStorefront }) {
  if (!storefront.whatsappE164) return null;
  const href = waLink(storefront.whatsappE164, `Hello ${storefront.shopName}, I have a question.`);
  return (
    <Pressable style={pressable(styles.wa)} onPress={() => openExternalUrl(href)} accessibilityRole="link">
      <Text style={styles.waText}>Message on WhatsApp</Text>
    </Pressable>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// BENTO SURFACES
//
// The app's own system, recoloured. Dashboard and Accounting are a page tone,
// borderless 26px cards floating on it, one inverted anchor card and an
// eyebrow/value type ramp; this page predated all of that. Bento is a SURFACE
// system rather than a colour scheme, which is exactly why it survives being
// recoloured six ways.
//
// Three roles out of two tokens the palette already stores, at bento's own
// proportion (`bentoPage` #f4f4f5 sits 3% from `bentoSurface` #ffffff):
//
//   page              = the palette's `soft`
//   card              = the palette's `ground`
//   a plate INSIDE a card = `soft` again, which reads as the page showing through
//   the anchor card   = the palette's `ink`, with its type in `ground`
//
// What is NOT taken: BentoGrid, BentoCard, StatTile, Badge. Every one of them
// pins `Colors.light` (the skill says so in as many words), and this page
// renders in one of seven palettes for a stranger with no account. The system
// comes across; the app's tokens do not.
// ─────────────────────────────────────────────────────────────────────────────

// Re-exported for backwards compatibility -- these two now live in scale.ts
// (see that file's own comment) so a display component that only needs
// them, CategoryBand chief among them, does not have to import this whole
// module -- and with it `checkout-form`, `storefront-order` and
// `@/lib/supabase` -- for two strings. This file still uses both directly
// (below, and in ShopAnchor's own scrim), so importing them back in rather
// than duplicating the values is what keeps this and scale.ts from being
// able to drift apart.
export { ON_SCRIM_INK, ON_SCRIM_MUTED };

// A card. Borderless and unshadowed on purpose: the separation is the page
// tone behind it, which is the whole of what makes a bento page read as
// floating rather than as boxes ruled onto a background.
export function ShopCard({
  colors, style, children, testID,
}: {
  colors: PaletteColors;
  style?: StyleProp<ViewStyle>;
  children: ReactNode;
  testID?: string;
}) {
  return (
    <View testID={testID} style={[styles.card, { backgroundColor: colors.ground }, style]}>
      {children}
    </View>
  );
}

// THE ANCHOR CARD, and the single decision this whole redesign turns on.
//
// Dashboard has exactly one near-black card (Takings) and it is what stops that
// page reading as a field of white rectangles. The storefront's equivalent is
// the shop itself -- so the wordmark, where it is, what it says and how to
// reach it all move onto one `ink` card, and the page finally has a centre of
// gravity instead of the 1,472px panel of `soft` that prompted this.
//
// The photo branch is Window's old hero, mostly unchanged in substance: the
// image fills the card and the type takes the two fixed on-scrim values
// above. What changed is the scrim itself -- see anchorScrim below -- and
// that it is now a card in a row of cards rather than a full-bleed panel of
// its own.

// ONCE PER VISIT, NOT ONCE PER RENDER.
//
// A `useRef` inside ShopAnchor would not do it: pressing About or Visit and
// coming back to Shop is not a re-render, it is a different ROUTE
// (`[slug]/index.tsx` vs `[slug]/[tab].tsx` -- see StorefrontScreen's own
// SHOP_CACHE comment on exactly this), and moving between routes unmounts
// ThemeMarket/Window/Counter -- and so this component -- and mounts a fresh
// one. A ref dies with the instance; a naive `entering` prop would replay the
// rise on every single tab press. Module-level and keyed by slug for the same
// reason SHOP_CACHE is: a shop's rise plays once per visit to its page, and a
// genuinely fresh page load is expected to play it again.
const HERO_RISEN = new Set<string>();

// Read and write ends of HERO_RISEN, named so ShopAnchor's own body never
// touches the Set directly. That indirection exists for one reason: it gives
// a test a way in. react-native-reanimated's Jest mock
// (jest/reanimated-mock.js, wrapping the library's own mock.ts) renders
// `Animated.View` as a plain `View` and drops the `entering` prop on the
// floor -- so no test that only renders ShopAnchor can tell a rise that
// played from one that never did. These two functions, plus
// resetHeroRisenForTests below, let a test observe and control the cache the
// same way ShopAnchor's effect does, without mounting anything.
export function heroHasRisen(slug: string): boolean {
  return HERO_RISEN.has(slug);
}

export function markHeroRisen(slug: string): void {
  HERO_RISEN.add(slug);
}

// TEST-ONLY SEAM. HERO_RISEN is module-level and, under Jest, lives for the
// whole of a test file's run -- so one test marking a slug risen would leak
// into every later test that reuses (or coincidentally picks) that slug. No
// app code calls this: a real page load gets a fresh module instance for
// free, which is the property the big comment above HERO_RISEN relies on.
export function resetHeroRisenForTests(): void {
  HERO_RISEN.clear();
}

// THE DECISION, pulled out on its own because nothing about it can be
// asserted through a render (see the comment on heroHasRisen above) -- it is
// a function of exactly two facts: is reduced motion on, and has this shop's
// hero already spent its rise this session. Returns the millisecond delay
// FadeInDown should carry for line `index`, or `null` when that line must
// render already in its final position -- reduced motion means no animation
// at all, never a faster one, and an already-risen shop must not replay it.
export function heroRiseDelay(reducedMotion: boolean, alreadyRisen: boolean, index: number): number | null {
  if (reducedMotion || alreadyRisen) return null;
  return index * 80;
}

export function ShopAnchor({
  storefront, colors, style, wide, children,
}: {
  storefront: PublicStorefront;
  colors: PaletteColors;
  style?: StyleProp<ViewStyle>;
  // One clamp, not two designs: the wordmark that anchors a 1,080px card would
  // wrap to three lines at 390px, and the one that fits 390px is lost on a
  // laptop. Passed rather than measured here so a tile-level component never
  // subscribes to window dimensions of its own.
  wide?: boolean;
  // The WhatsApp button, on the layouts that put it here. Narrow layouts pass
  // nothing and keep it in the button row above, because the same button in
  // both places is the same control twice on a 390px screen.
  children?: ReactNode;
}) {
  const onPhoto = Boolean(storefront.heroImageUrl);
  const ink = onPhoto ? ON_SCRIM_INK : colors.ground;
  const muted = onPhoto ? ON_SCRIM_MUTED : colors.onDarkMuted;
  // Composed the same way the checkout and confirmation screens compose it, so
  // the counter named at the top of the page is the one named at the bottom of
  // it. `?? city` rather than joining both -- collectLocation already ends with
  // the city whenever there is one.
  const place =
    collectLocation(storefront.collectAddress, storefront.collectNeighborhood, storefront.city) ?? storefront.city;

  // `?? {}` for the same reason availableTabs defends the identical read:
  // getPublicStorefront maps a missing column to {}, but a hand-built fixture
  // (the editor preview, a dozen tests) is one omission away from handing this
  // a hole, and isConfigured's Object.keys throws on undefined. Reused rather
  // than reimplemented -- visit-panel.tsx's HoursCard is the one other place
  // on this page that answers "is the shop open", and the two must never
  // disagree about what "configured" or "open" means.
  const hours = storefront.openingHours ?? {};
  const hoursConfigured = isConfigured(hours);
  // `new Date()` at render, deliberately not memoised -- the identical trade
  // HoursCard makes, and for the identical reason: this page is opened, read
  // and closed within a minute or two, and a stale "Open now" is worse than
  // one that re-evaluates on a re-render.
  const open = hoursConfigured && isOpenAt(hours, new Date());

  // Reduced motion: no rise at all, not a faster one -- the lines render in
  // their final position on the very first frame. `alreadyRisen` is read
  // once per render, same as `shouldRise` used to be, so every line in this
  // mount agrees on whether the hero has already spent its rise.
  const reducedMotion = useReducedMotion();
  const alreadyRisen = heroHasRisen(storefront.slug);
  // Only marked "spent" when the rise actually played. A visit that opened
  // under reduced motion never showed an animation, so it must not cost the
  // one this slug is owed -- a customer who later turns reduced motion off
  // and returns to this shop still gets to see it rise once. Runs after this
  // render commits, so `alreadyRisen` above still reflects whether THIS mount
  // -- the first eligible one for this slug -- gets to animate.
  useEffect(() => {
    if (!reducedMotion) markHeroRisen(storefront.slug);
  }, [storefront.slug, reducedMotion]);

  // `undefined` under either gate -- Animated.View treats a missing
  // `entering` prop as "already in its final state", which is exactly what a
  // skipped rise and an already-spent one both mean. The decision itself
  // (heroRiseDelay above) is what a test can actually hold onto.
  function riseIn(index: number) {
    const delay = heroRiseDelay(reducedMotion, alreadyRisen, index);
    return delay === null ? undefined : FadeInDown.duration(550).delay(delay);
  }

  return (
    <View
      testID="storefront-shop-card"
      style={[styles.card, styles.anchor, { backgroundColor: colors.ink }, style]}
    >
      {onPhoto ? (
        <>
          <Image source={{ uri: storefront.heroImageUrl! }} style={styles.anchorPhoto} resizeMode="cover" />
          {/* A BOTTOM-WEIGHTED GRADIENT, not the flat scrim this replaces, and
              ONLY here -- never on the no-photo branch below. That second
              half is the fix, not the gradient: the flat scrim used to be a
              sibling of the photo `Image` inside the SAME `onPhoto ? (...)`
              branch already, so it could never have painted over a photoless
              card by itself -- but a grey shape was still turning up over the
              no-photo fallback, which means whatever produced it lived
              somewhere this component doesn't render from. Anchoring the new
              gradient to the identical `onPhoto` guard the old scrim used is
              the belt this fix-class is about: there is now exactly one
              branch that can ever paint a scrim, and it is the one with a
              photograph under it. */}
          <LinearGradient
            testID="storefront-hero-scrim"
            colors={HERO_SCRIM.colors}
            locations={HERO_SCRIM.locations}
            style={styles.anchorScrim}
            pointerEvents="none"
          />
        </>
      ) : (
        // THE AURORA -- the photoless anchor's own counterpart to the scrim
        // above, gated on the identical `onPhoto` boolean so the two can
        // never both paint (a shop cannot have a photo AND no photo) and
        // never both skip (every card gets exactly one background
        // treatment). See aurora.tsx for what this actually renders, given
        // no radial gradient and no blur are available on this branch. A
        // static wash, not animated -- see that file's own header comment
        // for why it no longer takes a `reducedMotion` prop at all.
        <Aurora colors={colors} />
      )}

      <Text style={[styles.eyebrow, { color: muted }]}>The shop</Text>

      {/* The biggest thing on the page, because "whose shop is this" is the
          first question a forwarded link has to answer. adjustsFontSizeToFit
          carries the genuinely long names down rather than letting them wrap
          to three lines -- shop names are not length-limited anywhere. */}
      <Animated.View entering={riseIn(0)}>
        <Text
          testID="storefront-wordmark"
          style={[styles.wordmark, wide && styles.wordmarkWide, { color: ink }, onPhoto && styles.onScrimText]}
          numberOfLines={2}
          adjustsFontSizeToFit
          minimumFontScale={0.6}
        >
          {storefront.shopName}
        </Text>
      </Animated.View>

      {place ? (
        <Animated.View entering={riseIn(1)}>
          <Text testID="storefront-eyebrow" style={[styles.place, { color: muted }, onPhoto && styles.onScrimText]}>
            {place}
          </Text>
        </Animated.View>
      ) : null}

      {/* THE ONE TRUST FACT a customer reads here without opening Visit --
          whether the shop is open right now. (Collection and
          pay-on-collection are already said once each, lower down this same
          page -- CollectingCard's "Delivery / Collection only" and "Pay / On
          collection" rows, then the footer's unconditional "Pay on
          collection · Prices set by the shop". A ghost pill repeating just
          "Collection" up here, a third time in one narrow scroll, said
          nothing an anchor visitor did not already read twice more below --
          see this file's git history for the pill this replaced.)

          NO PILL AT ALL when the shop has not set hours -- the same rule
          HoursCard follows for the identical reason: `isConfigured` false
          means "never filled in", and a pill claiming a state the shop never
          gave would be invented, not reported. Word AND fill, never colour
          alone -- a customer who cannot tell accent from soft still reads
          "Open now" or "Closed now". */}
      {hoursConfigured ? (
        <Animated.View entering={riseIn(2)}>
          <View style={styles.pillRow}>
            <View
              testID="storefront-anchor-open-pill"
              style={[styles.openPill, { backgroundColor: open ? colors.accent : colors.soft }]}
            >
              <Text
                style={[
                  styles.openPillText,
                  { color: open ? colors.ground : colors.muted },
                  onPhoto && styles.onScrimText,
                ]}
              >
                {open ? 'Open now' : 'Closed now'}
              </Text>
            </View>
          </View>
        </Animated.View>
      ) : null}

      {storefront.headline ? (
        <Text
          testID="storefront-headline"
          style={[styles.anchorHead, { color: ink }, onPhoto && styles.onScrimText]}
        >
          {storefront.headline}
        </Text>
      ) : null}

      {storefront.about ? (
        <Text
          testID="storefront-about"
          style={[styles.anchorAbout, { color: muted }, onPhoto && styles.onScrimText]}
        >
          {storefront.about}
        </Text>
      ) : null}

      {children ? <View style={styles.anchorFoot}>{children}</View> : null}
    </View>
  );
}

// What a customer asks before they order, which is three lines this page has
// always held and never printed. Every value is already on PublicStorefront or
// on the areas the route already fetches -- nothing new is stored or read.
export function CollectingCard({
  storefront, areas, colors, style, stacked, children,
}: {
  storefront: PublicStorefront;
  areas: PublicDeliveryArea[];
  colors: PaletteColors;
  style?: StyleProp<ViewStyle>;
  // Label above value instead of label-left/value-right. On a phone this card
  // is half the screen -- about 150px of usable width -- and a two-column row
  // there wrapped BOTH sides: "Collect from" broke over two lines and so did
  // "Jiija, Hargeisa" beside it. Stacking gives each the full width and costs
  // one line per fact.
  stacked?: boolean;
  // The Cart button, on layouts that put it here.
  children?: ReactNode;
}) {
  const where = collectLocation(storefront.collectAddress, storefront.collectNeighborhood, storefront.city);
  // Named from the CHEAPEST area rather than a flat "Available": a customer
  // deciding whether to order wants the number, and the cheapest is the only
  // one that is true for at least somebody. A shop that offers delivery but
  // has no areas priced yet keeps the honest vaguer word.
  const cheapestCents = areas.length > 0 ? Math.min(...areas.map((a) => a.feeCents)) : null;
  const delivery = !storefront.offersDelivery
    ? 'Collection only'
    : cheapestCents === null
      ? 'Available'
      : cheapestCents === 0
        ? 'Free'
        : `From ${formatCents(cheapestCents)}`;

  return (
    <ShopCard colors={colors} style={style} testID="storefront-collecting-card">
      <Text style={[styles.eyebrow, { color: colors.muted }]}>Collecting</Text>
      <View style={styles.factList}>
        {where ? <Fact colors={colors} label="Collect from" value={where} stacked={stacked} /> : null}
        <Fact colors={colors} label="Delivery" value={delivery} stacked={stacked} />
        {/* storefronts.payment_mode is the single literal 'on_collection'
            today, so this is a fixed line rather than a branch -- and it is
            worth printing precisely because it is the answer to "do I need to
            pay now?", which is why a stranger hesitates. */}
        <Fact colors={colors} label="Pay" value="On collection" stacked={stacked} />
      </View>
      {children ? <View style={styles.cardFoot}>{children}</View> : null}
    </ShopCard>
  );
}

function Fact({
  colors, label, value, stacked,
}: { colors: PaletteColors; label: string; value: string; stacked?: boolean }) {
  return (
    <View style={[styles.fact, stacked && styles.factStacked, { borderBottomColor: colors.hairline }]}>
      <Text style={[styles.factLabel, { color: colors.muted }]}>{label}</Text>
      <Text
        style={[styles.factValue, stacked && styles.factValueStacked, { color: colors.ink }]}
        numberOfLines={2}
      >
        {value}
      </Text>
    </View>
  );
}

// A dot per product, hollow when it is out of stock -- the shape of the app's
// "7/7 products sold have a cost set" card, carrying the one fact a customer
// most wants at a glance.
//
// SHAPE CARRIES THE STATE AND COLOUR IS THE SECOND SIGNAL, which is the rule
// storefront-catalog.ts already sets by refusing to ship a `stockOk`: an
// out-of-stock dot is hollow AND amber, never amber alone.
export const MAX_STOCK_DOTS = 24;

export function StockCard({
  products, colors, style,
}: {
  products: StorefrontProduct[];
  colors: PaletteColors;
  style?: StyleProp<ViewStyle>;
}) {
  const total = products.length;
  const inStock = products.filter((p) => p.stock > 0).length;
  // A dot each stops being a glance somewhere past two rows of them, and a
  // 200-product shop would render 200. Past the cap the line alone says it.
  const showDots = total > 0 && total <= MAX_STOCK_DOTS;

  return (
    <ShopCard colors={colors} style={[styles.stockCard, style]} testID="storefront-stock-card">
      <Text style={[styles.eyebrow, { color: colors.muted }]}>In the shop</Text>
      <Text style={[styles.value, { color: colors.ink }]}>{total}</Text>
      <Text style={[styles.valueLabel, { color: colors.muted }]}>
        {total === 1 ? 'item listed' : 'items listed'}
      </Text>
      {/* `marginTop: 'auto'` on the wrapper, not on the dots: on a wide layout
          this card is stretched to the anchor card's height, and without the
          push the bottom third of it is dead air. */}
      <View style={styles.stockFoot}>
        {showDots ? (
          <View style={styles.dots} testID="storefront-stock-dots">
            {products.map((p) => (
              <View
                key={p.id}
                style={[
                  styles.dot,
                  p.stock > 0
                    ? { backgroundColor: colors.accent }
                    : { borderColor: colors.stockOut, borderWidth: 1.5 },
                ]}
              />
            ))}
          </View>
        ) : null}
        {/* NOTHING AT ALL ON AN EMPTY SHOP. `inStock === total` is true at
            zero, so this line shipped saying "all in stock today" on a shop
            that has listed nothing -- immediately above the EmptyState that
            says "Nothing listed yet." Two claims, one page, and the cheerful
            one is the lie. A shop with no goods has no stock news. */}
        {total > 0 ? (
          <Text style={[styles.stockLine, { color: colors.muted }]}>
            {inStock === total ? 'all in stock today' : `${inStock} of ${total} in stock`}
          </Text>
        ) : null}
      </View>
    </ShopCard>
  );
}

// A pill. The app's black "Show my tasks · 2" button, in the shop's own ink.
export function ShopPill({
  colors, label, onPress, tone = 'ink', style, testID, accessibilityLabel,
}: {
  colors: PaletteColors;
  label: string;
  onPress: () => void;
  // 'wa' takes WhatsApp's own fixed green -- a recognised affordance, never
  // the shop's palette. 'onDark' is the ground-filled pill for the anchor card.
  tone?: 'ink' | 'wa' | 'onDark' | 'quiet';
  style?: StyleProp<ViewStyle>;
  testID?: string;
  accessibilityLabel?: string;
}) {
  const fills: Record<string, { background: string; text: string }> = {
    ink: { background: colors.ink, text: colors.ground },
    wa: { background: WHATSAPP_BUTTON_GREEN, text: WHATSAPP_INK },
    onDark: { background: colors.ground, text: colors.ink },
    quiet: { background: colors.soft, text: colors.ink },
  };
  const fill = fills[tone];
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      onPress={onPress}
      style={pressable([styles.pill, { backgroundColor: fill.background }, style])}
    >
      <Text style={[styles.pillText, { color: fill.text }]}>{label}</Text>
    </Pressable>
  );
}

// The three cards, in the arrangement the width can carry. `wide` rather than
// a raw pixel test so the caller decides once, from the same measurement it
// already takes to pick a column count.
export function ShopHeader({
  storefront, products, areas, colors, wide, itemCount, onOpenCart, narrowFloatingSearch, narrowFlyerCarousel,
}: {
  storefront: PublicStorefront;
  products: StorefrontProduct[];
  areas: PublicDeliveryArea[];
  colors: PaletteColors;
  wide: boolean;
  itemCount: number;
  onOpenCart: () => void;
  // The floating SearchField element, or null -- computed and gated by the
  // CALLER (ThemeMarket, via shouldOfferSearch) so that decision keeps
  // living in exactly one place rather than being duplicated here. This
  // component's only job is where to paint it: right after ShopAnchor and
  // before headerPair, which is what makes its -21px pull land on the
  // anchor's own bottom edge instead of on the Collecting/Stock pair below.
  // Ignored entirely in the wide branch -- see ShopAnchor's placement there.
  narrowFloatingSearch?: ReactNode;
  // The FlyerCarousel element, same slot mechanism as narrowFloatingSearch
  // and for the same reason: the mockup (storefront-bold-motion-mockup.html,
  // .onesearch followed immediately by the flyer band) puts the carousel
  // directly under the floating search, ABOVE the Collecting/Stock pair --
  // not after the whole header, where it used to land as ThemeMarket's own
  // sibling with the pair wedged in between. Rendered here, between
  // narrowFloatingSearch and headerPair, so the caller keeps owning the
  // "does this shop even have flyers" question (FlyerCarousel's own
  // count === 0 guard) while this component owns only where the slot paints.
  // Ignored entirely in the wide branch, same as narrowFloatingSearch -- wide
  // keeps rendering the carousel as ThemeMarket's own sibling below the
  // header, unchanged from before this fix.
  narrowFlyerCarousel?: ReactNode;
}) {
  const cartLabel = itemCount > 0 ? `Cart · ${itemCount}` : 'Cart';
  const cartA11y = itemCount > 0 ? `Open cart, ${itemCount} item${itemCount === 1 ? '' : 's'}` : 'Open cart';

  if (wide) {
    return (
      <View style={styles.header} testID="storefront-header">
        <ShopAnchor storefront={storefront} colors={colors} wide style={styles.anchorWide}>
          {storefront.whatsappE164 ? <WhatsAppButton storefront={storefront} /> : null}
        </ShopAnchor>
        <CollectingCard storefront={storefront} areas={areas} colors={colors} style={styles.collectingWide}>
          <ShopPill
            colors={colors}
            label={cartLabel}
            accessibilityLabel={cartA11y}
            onPress={onOpenCart}
            testID="storefront-cart-button"
            style={styles.blockPill}
          />
        </CollectingCard>
        <StockCard products={products} colors={colors} style={styles.stockWide} />
      </View>
    );
  }

  // Narrow: the buttons lead, then the anchor full width, then the two smaller
  // cards side by side. The WhatsApp button is in the row and NOT in the card,
  // for the reason theme-window.tsx has always given about the wordmark -- the
  // same control twice on a 390px screen is one too many.
  return (
    <View style={styles.headerNarrow} testID="storefront-header">
      <View style={styles.buttonRow}>
        <WhatsAppButton storefront={storefront} />
        <ShopPill
          colors={colors}
          label={cartLabel}
          accessibilityLabel={cartA11y}
          onPress={onOpenCart}
          testID="storefront-cart-button"
          style={styles.tightPill}
        />
      </View>
      <ShopAnchor storefront={storefront} colors={colors} />
      {narrowFloatingSearch}
      {narrowFlyerCarousel}
      <View style={styles.headerPair}>
        <CollectingCard storefront={storefront} areas={areas} colors={colors} style={styles.pairCard} stacked />
        <StockCard products={products} colors={colors} style={styles.pairCard} />
      </View>
    </View>
  );
}

// Two different empties, and they must not say the same thing.
//
// This used to render one line -- "Nothing listed yet." -- for both of them: a
// shop that has listed nothing, and a grid a flyer has just filtered down to a
// category that happens to be sold out. The second case tells a customer
// standing in front of a FULL catalogue that the shop is empty, which is both
// wrong and a dead end.
//
// The shop-is-empty case is also the one place on this page where a full stop
// is worst. Every other screen here exists to start a conversation, and this
// one had a WhatsApp number in scope and declined to offer it.
export function EmptyState({
  colors, storefront, category, onClearCategory,
}: {
  colors: PaletteColors;
  // Optional so the theme-level tests that predate this still type-check, and
  // so a caller with no shop context degrades to the bare line rather than
  // failing to render.
  storefront?: PublicStorefront;
  // Set only while a flyer's category filter is applied -- see filterByCategory.
  category?: string | null;
  onClearCategory?: () => void;
}) {
  if (category) {
    return (
      <View style={styles.emptyBlock}>
        <Text style={[styles.emptyHead, { color: colors.ink }]}>Nothing in {category} right now.</Text>
        <Text style={[styles.emptyBody, { color: colors.muted }]}>
          The rest of the shop is still here.
        </Text>
        {onClearCategory ? (
          <Pressable
            testID="storefront-empty-clear-category"
            accessibilityRole="button"
            onPress={onClearCategory}
            style={pressable([styles.emptyAction, { backgroundColor: colors.accentWash }])}
          >
            <Text style={[styles.emptyActionText, { color: colors.accentInk }]}>Show everything</Text>
          </Pressable>
        ) : null}
      </View>
    );
  }

  const number = storefront?.whatsappE164;

  return (
    <View style={styles.emptyBlock}>
      <Text style={[styles.emptyHead, { color: colors.ink }]}>Nothing listed yet.</Text>
      {/* The second sentence is only true when there is somewhere to send
          them -- promising "message us" with no number to message would be
          the same dead end ProductActions refuses to render. */}
      <Text style={[styles.emptyBody, { color: colors.muted }]}>
        {number
          ? "We're still putting the shop online. Message us and we'll tell you what's in today."
          : "We're still putting the shop online. Check back shortly."}
      </Text>
      {number && storefront ? (
        <Pressable
          testID="storefront-empty-whatsapp"
          accessibilityRole="link"
          onPress={() => openExternalUrl(waLink(number, `Hello ${storefront.shopName}, what do you have in today?`))}
          style={pressable(styles.emptyWa)}
        >
          {/* NOT "Message on WhatsApp" -- that is already the label on the
              nav button a few pixels above, and two identical buttons on one
              screen make the reader work out whether they do the same thing.
              This one names the answer it gets back. */}
          <Text style={styles.emptyWaText}>Ask what&apos;s in today</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

type ProductActionsProps = {
  product: StorefrontProduct;
  colors: PaletteColors;
  // See the identical comment on ProductTile's Props in product-tile.tsx --
  // Ask does not render without a number, the same rule WhatsAppButton
  // above follows: lose the button rather than render one that opens a
  // chat with nobody.
  shopName?: string;
  whatsappE164?: string | null;
  onAdd?: (product: StorefrontProduct) => void;
  // ProductTile renders this pair full-width inside a grid tile; Counter
  // renders it inline in a dense price-list row, where a full-size button
  // pair would turn every row into a card. `compact` is the same two
  // buttons at row scale, not a different component.
  compact?: boolean;
  // Defaults to true -- the ordinary grid path (ProductTile, Counter's row)
  // is unchanged. ProductSheet is the one caller that passes `false`: it
  // renders this same component inside an AppModal, and on iOS and Android
  // a Modal is its OWN native window, layered above everything FlyToCartLayer
  // paints into. The dot would arc across a window nobody watching the sheet
  // can see, and the slip it is racing toward is sitting behind the sheet
  // besides -- so the flight is not merely pointless there, it is invisible
  // by construction, on every platform where a Modal is a real window rather
  // than a browser-only stacking context. A positive name (can it fly)
  // rather than a negative one (suppress the fly) so the ordinary case reads
  // as "yes, of course" rather than as a double negative at every call site
  // that doesn't opt out.
  canFlyToCart?: boolean;
};

// WHY `compact` GETS hitSlop RATHER THAN TOUCH_TARGET.
//
// `buttonCompact` (below) is `paddingVertical: 3` on a 10.5px label -- roughly
// 19px measured, in Counter's price-list row, the ONE place this pair renders
// beside a THIRD thing fighting the same line: `styles.price` sits to the
// right of this whole row, at Counter's own row scale, and the row's height
// is what a customer scans 200 times down one shop. Growing the button to 44
// would nearly triple that row's height on every single line -- undoing
// exactly the density Counter exists to offer (see theme-counter.tsx's own
// header comment: "the theme that makes a 200-line pharmacy catalogue
// readable"). That is the "genuinely cannot grow without breaking the
// design" case scale.ts's TOUCH_TARGET comment names, and hitSlop is the
// named alternative: it answers a tap without moving a pixel a customer
// scanning the list actually sees.
//
// The numbers: 19px measured tall, ~30px measured wide (9px horizontal
// padding either side of a 3-4 letter label at 10.5px bold). Top/bottom
// pushes the tap area to 19 + 2*13 = 45px; left/right to 30 + 2*8 = 46px --
// both just over TOUCH_TARGET, not merely "some slop".
const COMPACT_BUTTON_HIT_SLOP = { top: 13, bottom: 13, left: 8, right: 8 };

// The Add/Ask pair every theme with per-product actions needs. Originally
// lived only in ProductTile (Market, Window); Counter has its own row layout
// and so cannot reuse ProductTile itself, only the two rules its actions
// follow. Extracted here rather than copied a third time, so those rules have
// exactly one place to drift out of sync.
//
// The rules: Add only in stock -- an out-of-stock product keeps Ask, because
// the shop may be restocking and that enquiry is a sale. And Ask only when
// there is a number to ask, for the reason WhatsAppButton above states: lose
// the button rather than render one that opens a chat with nobody. An earlier
// version rendered Ask always and made it silently do nothing, which is the
// worse half of both options -- the customer taps and the app shrugs.
export function ProductActions({
  product, colors, shopName, whatsappE164, onAdd, compact, canFlyToCart = true,
}: ProductActionsProps) {
  const outOfStock = product.stock <= 0;

  function handleAsk() {
    // Unreachable now that Ask does not render without a number; kept as the
    // type narrow that lets waLink take a string.
    if (!whatsappE164) return;
    const message = shopName
      ? `Hi ${shopName}, is ${product.name} available?`
      : `Is ${product.name} available?`;
    openExternalUrl(waLink(whatsappE164, message));
  }

  return (
    <View style={[styles.actions, compact && styles.actionsCompact]}>
      {/* Add is only offered in stock -- accent is the palette's own
          "buttons and the active filter" colour, and ground stands in for
          the "always white on it" it's paired with, so this button needs no
          colour literal of its own. */}
      {outOfStock ? null : (
        <Pressable
          testID="product-tile-add"
          accessibilityRole="button"
          // TOUCH_TARGET on the ordinary (non-compact) button -- ProductTile's
          // grid tile, where Add is the reason this page exists and there is
          // nothing beside it competing for height. `compact` gets the
          // opposite treatment, `hitSlop` rather than the floor -- see
          // `COMPACT_BUTTON_HIT_SLOP`'s own comment below for the measurement
          // that makes minHeight the wrong tool there.
          style={pressable([styles.button, compact ? styles.buttonCompact : styles.buttonFloor, { backgroundColor: colors.accent }])}
          hitSlop={compact ? COMPACT_BUTTON_HIT_SLOP : undefined}
          // fireFlyToCart reads the press's own window-space coordinate --
          // pageX/pageY, unaffected by how far this tile's grid has been
          // scrolled -- and hands it to whatever FlyToCartLayer is mounted
          // for this page (fly-to-cart.ts's own header comment explains why
          // a registry rather than a threaded prop). It is deliberately
          // fire-and-forget: a shop with no dot to show (the slip has never
          // laid out, or reduced motion is on) is still a shop whose cart
          // gets the item, exactly as it did before this pass existed.
          //
          // `canFlyToCart` gates only THIS call -- the cart update
          // (`onAdd?.(product)`, next line) always runs regardless, because
          // an Add pressed inside ProductSheet's modal must still add to the
          // cart and still let the sheet's own onAdd close it; only the
          // dot's flight is skipped, since FlyToCartLayer paints into a
          // different native window a modal cannot see.
          onPress={(e) => {
            // `e` (and `e.nativeEvent`) is optional here on purpose: dozens
            // of existing tests across this suite call a captured
            // `.props.onPress()` with no argument at all to simulate a
            // press, and every one of them must keep passing exactly as it
            // did before this pass -- fireFlyToCart's own `origin` parameter
            // is already nullable for precisely this "no coordinate to
            // give" case.
            if (canFlyToCart) {
              fireFlyToCart(e?.nativeEvent ? { x: e.nativeEvent.pageX, y: e.nativeEvent.pageY } : null);
            }
            onAdd?.(product);
          }}
        >
          <Text style={[styles.buttonText, compact && styles.buttonTextCompact, { color: colors.ground }]}>Add</Text>
        </Pressable>
      )}
      {/* WhatsApp's own fixed brand colours -- never the shop's palette. */}
      {whatsappE164 ? (
        <Pressable
          testID="product-tile-ask"
          accessibilityRole="button"
          style={pressable([styles.button, compact ? styles.buttonCompact : styles.buttonFloor, { backgroundColor: WHATSAPP_BUTTON_GREEN }])}
          hitSlop={compact ? COMPACT_BUTTON_HIT_SLOP : undefined}
          onPress={handleAsk}
        >
          <Text style={[styles.buttonText, compact && styles.buttonTextCompact, { color: WHATSAPP_INK }]}>Ask</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

// The cart entry point every theme needs -- including Counter, which has no
// product grid and so no Add button of its own. The cart is keyed by shop
// slug, not by theme (see storefront-cart.ts), so a customer who added items
// under Market and then lands on Counter -- or whose shop simply switched
// themes -- still needs a way to see and change what is already in it.
export function CartButton({ colors, count, onPress }: { colors: PaletteColors; count: number; onPress: () => void }) {
  return (
    <Pressable
      testID="storefront-cart-button"
      accessibilityRole="button"
      accessibilityLabel={count > 0 ? `Open cart, ${count} item${count === 1 ? '' : 's'}` : 'Open cart'}
      onPress={onPress}
      style={pressable([styles.cart, { backgroundColor: colors.accent }])}
    >
      <Text style={[styles.cartText, { color: colors.ground }]}>{count > 0 ? `Cart · ${count}` : 'Cart'}</Text>
    </Pressable>
  );
}

// The way into a long catalogue. Renders only when there is enough of one to
// be worth a control -- see shouldOfferSearch in storefront-search.ts.
//
// A plain TextInput and no submit button: the list filters as you type, so
// there is nothing to submit, and a phone keyboard's own "search" key would
// only dismiss itself. `clearButtonMode` is iOS-only, so the explicit Clear
// below is what Android and web get -- and a filter with no visible way out
// is the same dead end CategoryFilterBar exists to avoid.
export function SearchField({
  colors, value, onChange, count, floating,
}: {
  colors: PaletteColors;
  value: string;
  onChange: (next: string) => void;
  count: number;
  // Pulls this field up to overlap whatever sits directly above it by the
  // mockup's own -21px (docs/design/storefront-bold-motion-mockup.html,
  // .onesearch) instead of sitting in plain flow beneath it. Only
  // ThemeMarket's narrow layout passes this -- see theme-market.tsx -- because
  // it is the only placement where "whatever sits above" is ShopAnchor's own
  // card and not the wide 3-card row, where the same 21px could land on a
  // real WhatsApp/Cart button rather than a card's own blank padding.
  floating?: boolean;
}) {
  return (
    <View style={[styles.searchRow, floating ? styles.searchRowFloating : styles.searchRowInline]}>
      <View
        style={[styles.searchCard, { backgroundColor: colors.ground, shadowColor: colors.ink }]}
      >
        {/* The mockup's own glyph (.onesearch i) -- a plain character rather
            than an icon font, so the floating card costs nothing new: no
            dependency, and the same glyph reads on every platform this page
            ships to. Hidden from screen readers -- the TextInput's own
            accessibilityLabel already says "Search N items". */}
        <Text
          style={[styles.searchGlyph, { color: colors.muted }]}
          accessibilityElementsHidden
          importantForAccessibility="no"
        >
          ⌕
        </Text>
        <TextInput
          testID="storefront-search"
          accessibilityLabel={`Search ${count} items`}
          placeholder={`Search ${count} items…`}
          placeholderTextColor={colors.muted}
          value={value}
          onChangeText={onChange}
          autoCorrect={false}
          autoCapitalize="none"
          returnKeyType="search"
          clearButtonMode="while-editing"
          style={[styles.searchInput, { color: colors.ink }]}
        />
      </View>
      {value.length > 0 ? (
        <Pressable
          testID="storefront-search-clear"
          accessibilityRole="button"
          accessibilityLabel="Clear search"
          onPress={() => onChange('')}
          style={pressable([styles.searchClear, { backgroundColor: colors.accentWash }])}
        >
          <Text style={[styles.searchClearText, { color: colors.accentInk }]}>Clear</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

// What a search that found nothing should say. Distinct from both other
// empties: the shop is not empty and no category is filtering -- the customer
// simply typed something this shop does not stock, and the useful next move is
// to ask rather than to keep typing.
export function NoSearchResults({
  colors, query, onClear,
}: { colors: PaletteColors; query: string; onClear: () => void }) {
  return (
    <View style={styles.emptyBlock}>
      <Text style={[styles.emptyHead, { color: colors.ink }]}>Nothing matches “{query}”.</Text>
      <Text style={[styles.emptyBody, { color: colors.muted }]}>
        Try a shorter word, or ask the shop — they may have it behind the counter.
      </Text>
      <Pressable
        testID="storefront-search-empty-clear"
        accessibilityRole="button"
        onPress={onClear}
        style={pressable([styles.emptyAction, { backgroundColor: colors.accentWash }])}
      >
        <Text style={[styles.emptyActionText, { color: colors.accentInk }]}>Show everything</Text>
      </Pressable>
    </View>
  );
}

// Property 6 of the flyers brief: a slide with `link_kind = 'category'`
// filters the page. Case- and whitespace-insensitive because the two sides
// have different authors -- `link_value` is what the shop typed on the flyer,
// `products.category` is what they typed on the product, months apart -- and
// "solar " not matching "Solar" would be a dead end a customer cannot see the
// cause of.
//
// Shared rather than written twice: Market and Window both do this, Counter
// renders no flyers and so never calls it.
export function filterByCategory(products: StorefrontProduct[], category: string | null): StorefrontProduct[] {
  if (!category) return products;
  const wanted = category.trim().toLowerCase();
  return products.filter((p) => (p.category ?? '').trim().toLowerCase() === wanted);
}

// The way back out of that filter. Renders only while one is applied -- a
// permanent "showing everything" chip would be a control that never does
// anything -- and says which category it is showing, because the flyer that
// set it may well have been scrolled past by now.
export function CategoryFilterBar({
  colors, category, onClear,
}: { colors: PaletteColors; category: string | null; onClear: () => void }) {
  if (!category) return null;
  return (
    <Pressable
      testID="storefront-category-clear"
      accessibilityRole="button"
      accessibilityLabel={`Showing ${category} only. Show everything`}
      onPress={onClear}
      style={pressable([styles.filterChip, { backgroundColor: colors.accentWash }])}
    >
      <Text style={[styles.filterChipText, { color: colors.accentInk }]}>{category} · Show everything ✕</Text>
    </Pressable>
  );
}

// A hardcoded numColumns=2 suits the 390px phone the plan was verified at,
// but leaves a 1280px laptop with a couple of oversized tiles and vast empty
// margins either side. Breakpoints roughly split phone / tablet / laptop --
// three columns is not "the" right answer for 768px so much as a deliberate
// one, same as the rest of the grid a theme renders through.
//
// EVERY THRESHOLD HERE IS A MULTIPLE OF 128 (640 = 5x, 1024 = 8x, 1280 =
// 10x, and every rung Task C added above it) -- not a house style for its
// own sake, a target: at each boundary the tile a column count draws lands
// in the same ~240-300px band the grid was designed around (see scale.ts's
// own SPACE/TYPE comments), whatever the raw window width that crossed it.
//
// FIVE USED TO BE THE LAST RUNG, because `width` never climbed past
// SHOP_MAX_WIDTH (1320) in practice -- the grid used to sit inside the
// page's own reading-column bound, so nothing wider than that ever reached
// this function. Task C moved the grid outside that bound (see
// theme-market.tsx/theme-window.tsx's own `scroller`/`column` styles and
// SHOP_MAX_WIDTH's comment in scale.ts) specifically so it could keep
// growing on a wide monitor -- and `width` is `useWindowDimensions()`'s raw
// figure, so it now genuinely climbs as far as the window does. Stopping at
// five with nothing above 1280 meant a 2,560px window drew five ~500px
// posters, which is worse than the fixed-width gutters this whole pass
// replaced -- five 250px tiles and a lot of empty margin at least still
// looked like a considered grid.
export function gridColumnsForWidth(width: number): number {
  if (width < 640) return 2;
  if (width < 1024) return 3;
  if (width < 1280) return 4;
  if (width < 1536) return 5;
  if (width < 1792) return 6;
  if (width < 2048) return 7;
  if (width < 2304) return 8;
  if (width < 2560) return 9;
  // 2,560px is the width named above -- ten columns there is a ~242px tile
  // (see this file's own test suite for the arithmetic), back in the
  // intended band. Left open-ended past this rung the same way five used to
  // be the open-ended rung before it: a single browsing window wider than
  // 2,560 logical px is not a screen size this page has ever been designed
  // for or seen in practice (a real 4K/5K display reports a scaled logical
  // width well under its native pixel count, not the raw figure), and a
  // somewhat larger tile there is an honest degradation, not a defect worth
  // chasing with another five thresholds.
  return 10;
}

// Where the three shop cards stop stacking and sit in a row. Deliberately its
// own number rather than reusing a grid breakpoint: the header is three cards
// of very different content widths, and the point it stops working is not the
// point a product grid gains a column.
export const WIDE_SHOP_WIDTH = 900;

export function isWideShop(width: number): boolean {
  return width >= WIDE_SHOP_WIDTH;
}

// A SHORT FINAL ROW MUST LEAVE A GAP, NOT INFLATE.
//
// This is the defect that produced the screenshot this redesign came from.
// FlatList lays a short final row out with only the cells it has, and the cell
// style is `flex: 1` -- so three products at four columns became three cells
// each a THIRD of the width rather than a quarter. With `aspectRatio: 1` on the
// image that made a 480px-tall tile whose name and price fell below the fold,
// and it read as a layout accident rather than as a shop with three things in
// it.
//
// Padding the data is the fix rather than sizing the cell by percentage:
// percentages have to account for the inter-column gap, which changes with the
// column count, and getting that arithmetic subtly wrong is how a grid ends up
// one pixel short and wraps. A placeholder cell is exact at every width.
export function padFinalRow<T>(items: T[], numColumns: number): (T | null)[] {
  if (numColumns <= 1 || items.length === 0) return items;
  const remainder = items.length % numColumns;
  if (remainder === 0) return items;
  return [...items, ...Array<null>(numColumns - remainder).fill(null)];
}

// THE GOODS GET THEIR OWN SCROLL, TWO ROWS TALL -- and how tall that actually
// is cannot be a number this file types in. A tile is a photo plus a name
// slot, a price slot and an actions row, `dense` changes several of those,
// and the image itself is `aspectRatio: 1` against a column width that moves
// at every breakpoint gridColumnsForWidth answers for -- so "two rows" is a
// question about whatever really got laid out, not a constant. Market and
// Window each measure their own first cell (`onLayout`, held in state) and
// hand the result here.
//
// Never rendered directly -- see ESTIMATED_ROW_HEIGHT below for what a caller
// shows before that measurement exists.
//
// `rowCount <= 1` is the other half of "about two rows": a shop with one
// row of stock has nothing to scroll TO, and bounding a single row's height
// to itself would draw a scroll region with dead space beneath it -- the
// exact defect padFinalRow's own comment names for the column axis, here on
// the row axis instead. `null` is the signal a caller reads as "let the
// FlatList be its own height," which is its ordinary unbounded behaviour.
export function goodsScrollHeight(
  measuredRowHeight: number | null,
  rowGap: number,
  rowCount: number,
): number | null {
  if (rowCount <= 1) return null;
  const rowHeight = measuredRowHeight ?? ESTIMATED_ROW_HEIGHT;
  return rowHeight * 2 + rowGap;
}

// THE SAME BOX, THREE ROWS TALL, for a window with the room to spare.
//
// `null` UNTIL A REAL MEASUREMENT EXISTS, deliberately NOT falling back to
// ESTIMATED_ROW_HEIGHT the way goodsScrollHeight (above) does. That
// constant's own comment says it stands in for "two rows" for the one frame
// before a measurement arrives -- it never claimed to answer the harder
// two-vs-three question, but feeding it into this function let it do exactly
// that: on a tall enough window, `goodsRowBound` picked a THREE-row box built
// from three ESTIMATED rows before any tile had ever been measured, and the
// instant the real height arrived, the box visibly snapped to whatever three
// rows of the ACTUAL tile height came to (804px -> 674px on the window that
// found this). Returning null here instead means an unmeasured grid can only
// ever be offered TWO rows -- goodsRowBound's own "holds two rows while the
// window has not been measured" fallback -- which is one frame of an
// under-estimate at worst, never an over-estimate that has to visibly
// shrink.
export function goodsThreeRowHeight(
  measuredRowHeight: number | null,
  rowGap: number,
  rowCount: number,
): number | null {
  if (rowCount <= 2 || measuredRowHeight == null) return null;
  return measuredRowHeight * 3 + rowGap * 2;
}

// HOW MANY ROWS THE GOODS BOX SHOWS, and the rule is a range rather than a
// number: never fewer than two, never more than three, three only when the
// window has the room for it.
//
// WHY IT IS ALWAYS BOUNDED, even when the page then has to scroll. The point
// of this box is not that the page fits -- on a 14" laptop it cannot, and the
// arithmetic saying so is in this file's history -- it is that the page's
// LENGTH STOPS DEPENDING ON THE CATALOGUE. Unbounded, a shop that grows from
// 28 items to 280 grows a page ten times longer, and every customer pays for
// that stock in scrolling before they reach the footer. Bounded, the page is
// the same short page either way and the growth goes where it belongs: inside
// the grid, which scrolls.
//
// That is the whole trade, and it is why "two rows or nothing" was wrong. It
// read the requirement as being about the WINDOW when it was about the
// CATALOGUE.
export function goodsRowBound(
  twoRowHeight: number | null,
  threeRowHeight: number | null,
  remainder: number | null,
): number | null {
  // Nothing to bound: one row of stock or none. The box is its own height.
  if (twoRowHeight == null) return null;
  // Three rows only when they genuinely fit, and only when a third row exists
  // to show -- a three-row box over two rows of stock is dead space.
  if (threeRowHeight != null && remainder != null && remainder >= threeRowHeight) return threeRowHeight;
  return twoRowHeight;
}

// What a caller renders for the one frame between "the grid mounted" and
// "the first row reported its own height" -- not a claim about any real
// tile's height (that is precisely the number goodsScrollHeight refuses to
// guess), just tall enough that the region shows something resembling two
// rows rather than collapsing to a sliver while the real measurement is in
// flight. Exported so a test can assert against THIS constant rather than a
// second copy of the number typed into the test file, which is exactly the
// "asserting a value you typed" failure this pass exists to stop shipping.
//
// TWO ROWS ONLY -- `goodsThreeRowHeight` (above) does NOT fall back to this
// the way `goodsScrollHeight` does, on purpose. This constant only ever
// stood in for the two-row estimate; feeding it into the three-row function
// too let it silently decide the two-vs-three question instead, and that
// decision would then visibly reverse itself the instant a real measurement
// arrived (see `goodsThreeRowHeight`'s own comment for the 804px -> 674px
// snap this produced).
export const ESTIMATED_ROW_HEIGHT = 260;

// HOW MUCH ROOM THE GOODS BOX HAS, which is a different question from how
// much it takes -- `goodsRowBound` above decides that, and only consults this
// to choose between two rows and three.
//
// THE ARITHMETIC: what the page scroller was laid out at (`pageHeight`), less
// the header and footer's own measured heights, less the page's own padding
// (top AND bottom -- `pagePadding * 2`), less the two gaps between three
// stacked children (`pageGap * 2` -- header-to-goods, goods-to-footer), less
// CHECKOUT_BAR_CLEARANCE (reserved unconditionally -- see
// `pageWithCheckoutBar`'s own comment in theme-market.tsx/theme-window.tsx).
//
// The result may be NEGATIVE, and that is information rather than an error: a
// 14" laptop showing this shop has 157px of room against a 348px row, which
// is precisely why the page there scrolls no matter what this returns. It is
// not this function's job to hide that.
//
// NULL, NEVER ZERO, when a measurement has not arrived -- any of
// pageHeight/headerHeight/footerHeight missing OR REPORTED AS EXACTLY ZERO. A
// header measured before it has painted fires a real onLayout with height 0,
// which this arithmetic cannot tell from a header that is genuinely nothing;
// reading it as "not measured yet" is the only choice that cannot hand back a
// remainder computed from a page that has not laid out. Callers treat null as
// "no opinion yet" and fall back to two rows.
export function goodsFitHeight(
  pageHeight: number | null,
  headerHeight: number | null,
  footerHeight: number | null,
  pagePadding: number,
  pageGap: number,
  checkoutClearance: number,
): number | null {
  if (!pageHeight || !headerHeight || !footerHeight) return null;
  return pageHeight - headerHeight - footerHeight - pagePadding * 2 - pageGap * 2 - checkoutClearance;
}

// The cart lives in `storefront-cart.ts`, keyed by shop slug, and every
// theme needs to read it, add to it, and change a line's quantity the same
// way -- so that logic is a hook here rather than copied into Market, Window
// and Counter separately. Deliberately not exported as a class or a context:
// nothing here needs to be shared ACROSS components on the same screen, only
// reused across the three that each render their own tree.
export function useStorefrontCart(slug: string) {
  const [cart, setCart] = useState<StorefrontCart>(() => loadCart(slug));

  function addProduct(product: StorefrontProduct) {
    setCart((prev) => {
      const next = addLine(prev, { productId: product.id, name: product.name, unitPriceCents: product.priceCents });
      saveCart(next);
      return next;
    });
  }

  function changeQuantity(productId: string, quantity: number) {
    setCart((prev) => {
      const next = setQuantity(prev, productId, quantity);
      saveCart(next);
      return next;
    });
  }

  // placeOrder (storefront-order.ts) already clears the STORED cart the
  // moment an order is accepted -- this brings the in-memory copy every theme
  // reads back in sync with that, so a customer who places a second order
  // doesn't see the first one's lines still sitting in the cart. Never
  // called on a rejected order: the caller only reaches this after
  // placeOrder/placeOrderViaWhatsApp has resolved, never from a catch block.
  function clearCart() {
    setCart((prev) => {
      const next: StorefrontCart = { ...prev, lines: [] };
      saveCart(next);
      return next;
    });
  }

  return {
    cart,
    addProduct,
    changeQuantity,
    clearCart,
    itemCount: cartItemCount(cart),
    subtotalCents: cartSubtotalCents(cart),
  };
}

// The direct path from a non-empty cart to checkout. CartSheet (the cart
// review modal) has a fixed prop surface --
// visible/onClose/cart/colors/onChangeQuantity, see cart-sheet.tsx -- and
// gained no checkout affordance of its own, so this sticky bar is what every
// theme renders instead: named after the subtotal, gone the moment the
// cart is empty, so it can never invite a checkout with nothing in it.
// B6: the bar itself is `position: absolute`, so it takes no space in the
// document flow it floats over -- nothing pushes the browsing view's own
// content up to make room for it. Each theme's scrollable container adds
// this much bottom padding of its own, but ONLY while `itemCount > 0` (the
// same condition CheckoutBar below uses to render at all): an empty cart
// must not carry dead space at the bottom of a page with no bar to clear.
// The slip's height is set by its TALLEST child, and that is `slipGo` (the
// Checkout pill), not the 30px thumb: paddingVertical 11 around 13.5px text
// (line-height ~17) is 11 + 17 + 11 = 39px, so the slip is 8 + 39 + 8 = 55px
// against `slip`'s own paddingVertical 8, sitting 14px off the bottom. 55 +
// 14 = 69 against a 76 clearance -- about 7px of headroom, not the ~22 a
// thumb-based count would suggest, plus whatever the `elevation: 6` Android
// shadow draws outside that box. Re-measure if the slip's vertical paddings
// or thumb size change.
export const CHECKOUT_BAR_CLEARANCE = 76;

// Up to three thumbnails, in cart order. A product with no photo degrades to
// a soft plate -- the same no-photo fallback the tiles use.
export function cartThumbnails(cart: StorefrontCart, products: StorefrontProduct[]): (string | null)[] {
  const byId = new Map(products.map((p) => [p.id, p.imageUrl]));
  return cart.lines.slice(0, 3).map((line) => byId.get(line.productId) ?? null);
}

// The SLIP. The old bar was the accent as a full-width field with four words
// on it -- the customer committed on trust, and on desktop the field ran the
// window rather than the column. Now the container is ground (a surface), the
// evidence sits on it (thumbnails, total, count, fulfilment), and the accent
// is a button-sized button again.
export function CheckoutBar({
  colors, itemCount, subtotalCents, thumbnails, fulfilment, onPress,
}: {
  colors: PaletteColors;
  itemCount: number;
  subtotalCents: number;
  thumbnails: (string | null)[];
  fulfilment: string | null;
  onPress: () => void;
}) {
  // Hooks run on EVERY render, including the itemCount===0 one that returns
  // null below -- React does not allow a conditional hook, and this
  // component's own instance is never unmounted just because the cart is
  // momentarily empty (the parent theme always renders <CheckoutBar/>; only
  // its OWN return decides whether that renders anything -- see
  // useStorefrontCart's neighbours in this file for the identical shape).
  const reducedMotion = useReducedMotion();
  const slipRef = useRef<View>(null);

  // THIS INSTANCE'S OWN CLAIM on the slip-target registry -- a plain object
  // created once per mount, compared only by `===`. What makes the cleanup
  // below identity-checked rather than unconditional: see
  // `clearSlipTarget`'s own comment in fly-to-cart.ts for the hazard (an
  // outgoing CheckoutBar's unmount racing an incoming one's mount, on a
  // route transition) this guards against.
  const slipOwnerRef = useRef({});

  // THE SLIP TARGET -- registered on every layout of this box (mount, and
  // any resize) rather than read once, so a laptop window resize or a
  // rotation keeps it honest. Window-space (measureInWindow), the same
  // space the press event ProductActions hands fireFlyToCart already
  // carries -- see fly-to-cart.ts's own header comment on why a
  // module-level value stands in for a ref threaded back up through three
  // themes. `+ 28, + height / 2` lands the target roughly where the first
  // thumbnail sits -- the mockup's own `sr.left+28` offset.
  //
  // Optional-chained throughout: `measureInWindow` is a real native method
  // react-test-renderer's host instances do not implement, and every test
  // that renders CheckoutBar must keep passing without it -- a shop with no
  // registered target just never gets a dot (ProductActions' own
  // fireFlyToCart already degrades to that outcome gracefully).
  function registerSlipTarget() {
    const node = slipRef.current as unknown as {
      measureInWindow?: (cb: (x: number, y: number, width: number, height: number) => void) => void;
    } | null;
    node?.measureInWindow?.((x, y, width, height) => {
      setSlipTarget({ x: x + 28, y: y + height / 2 }, slipOwnerRef.current);
    });
  }

  // Clears this instance's OWN claim on unmount -- `setSlipTarget` never had
  // a matching cleanup at all before this fix, so a CheckoutBar that
  // unmounted left a stale, unreachable target sitting in the registry
  // (harmless only by luck: the next CheckoutBar to lay out would overwrite
  // it before anything read it). Mount/unmount only (`[]`): this must not
  // re-run on every re-render, or it would clear the very target the effect
  // above just set.
  useEffect(() => {
    const owner = slipOwnerRef.current;
    return () => clearSlipTarget(owner);
  }, []);

  // THE BUMP. Two shared values, one per branch of slipBumpMotion, rather
  // than one animated between two different meanings -- each stays at its
  // own resting value (1) whichever branch is playing, so switching a
  // device's reduced-motion setting between two Add presses can never leave
  // one stuck mid-animation.
  const bumpScale = useSharedValue(1);
  const bumpOpacity = useSharedValue(1);
  const bumpStyle = useAnimatedStyle(() => ({
    opacity: bumpOpacity.value,
    transform: [{ scale: bumpScale.value }],
  }));

  // THE COUNT-UP. `displayCents` is what the slip actually PRINTS;
  // `subtotalCents` is the prop, the cart's real, already-updated total.
  // Tracking them separately is what lets the printed figure lag the real
  // one for exactly `countUpDuration` -- reading straight from the prop
  // would show the new total the instant the cart changed, with no tween at
  // all to see.
  //
  // DRIVEN OFF A REANIMATED SHARED VALUE, deliberately, rather than a raw
  // `requestAnimationFrame` loop on the JS thread: an earlier version of
  // this used one directly, and it left a scheduled frame callback that
  // could fire AFTER a test's render tree was done with it -- react-test-
  // renderer never unmounts a tree a test does not explicitly unmount, so
  // the callback survived into the next test file's module teardown and
  // threw "trying to import a file after the Jest environment has been torn
  // down". `progress` below is owned by Reanimated instead, which tears
  // itself down with the component; only its COMPLETION callback (fired
  // once, `finished` guaranteed true or false) ever touches React state, via
  // `runOnJS`, matching the pattern the bump above already uses.
  const [displayCents, setDisplayCents] = useState(subtotalCents);
  const previousSubtotal = useRef(subtotalCents);
  const everMounted = useRef(false);
  const progress = useSharedValue(0);

  // Read inside the reaction below via `runOnJS`, so the closure it calls
  // always sees the CURRENT from/to/duration for whichever tween is in
  // flight, without progress itself needing to carry anything but 0..1.
  const tweenFrom = useRef(subtotalCents);
  const tweenTo = useRef(subtotalCents);
  const tweenDuration = useRef(0);

  function applyProgress(k: number) {
    setDisplayCents(countUpValue(tweenFrom.current, tweenTo.current, k * tweenDuration.current, tweenDuration.current));
  }

  // Mirrors `progress` back onto the JS thread as it advances, for a smooth
  // read on a real device. A no-op under the shared reanimated jest mock
  // (`useAnimatedReaction: NOOP`) -- see the `withTiming` completion
  // callback below for how the FINAL value still lands under test, which is
  // the only part of this tween any test asserts on.
  useAnimatedReaction(
    () => progress.value,
    (current) => runOnJS(applyProgress)(current),
  );

  useEffect(() => {
    // First render only: show the real number outright. A cart that
    // survived from an earlier visit must not count up from zero on
    // arrival, and there is no CHANGE yet for the slip to acknowledge.
    if (!everMounted.current) {
      everMounted.current = true;
      previousSubtotal.current = subtotalCents;
      setDisplayCents(subtotalCents);
      return;
    }
    if (subtotalCents === previousSubtotal.current) return;
    const from = previousSubtotal.current;
    const to = subtotalCents;
    previousSubtotal.current = to;

    // Plays regardless of whether a dot ever reached the slip -- see
    // ProductActions' own comment: a customer on a device with no
    // registered target, or reduced motion on, is still a customer whose
    // slip must acknowledge that the total just changed.
    // Reanimated SharedValue `.value` assignments below -- the library's own
    // documented mutation API, not a React-owned value the experimental
    // react-hooks/immutability rule's model applies to.
    /* eslint-disable react-hooks/immutability */
    const motion = slipBumpMotion(reducedMotion);
    if (motion.kind === 'scale') {
      bumpScale.value = withSequence(withTiming(motion.amount, { duration: 120 }), withTiming(1, { duration: 230 }));
    } else {
      bumpOpacity.value = withSequence(withTiming(0.55, { duration: 90 }), withTiming(1, { duration: 180 }));
    }

    const duration = countUpDuration(reducedMotion);
    if (duration <= 0) {
      // Reduced motion: countUpValue would already collapse to `to`
      // immediately (its own `durationMs <= 0` guard), but setting it here
      // directly skips starting a Reanimated tween for it entirely.
      // eslint-disable-next-line react-hooks/set-state-in-effect -- syncing displayed state to the cart's own already-updated total, the same shape income-statement-view.tsx's identical suppression covers
      setDisplayCents(to);
      return;
    }
    tweenFrom.current = from;
    tweenTo.current = to;
    tweenDuration.current = duration;
    progress.value = 0;
    // `withTiming`'s own completion callback -- fired with `finished: true`
    // on a real device once the full duration elapses, and SYNCHRONOUSLY
    // under the shared reanimated mock (react-native-reanimated's own
    // mock.ts calls `callback?.(true)` immediately) -- is what guarantees
    // the slip always converges on the exact new total, whether or not
    // `useAnimatedReaction` above ever fired a single intermediate frame.
    progress.value = withTiming(1, { duration }, (finished) => {
      if (finished) runOnJS(setDisplayCents)(to);
    });
    /* eslint-enable react-hooks/immutability */
    // eslint-disable-next-line react-hooks/exhaustive-deps -- bumpScale/bumpOpacity/progress are stable shared-value refs
  }, [subtotalCents, reducedMotion]);

  if (itemCount === 0) return null;
  const line = `${itemCount} ${itemCount === 1 ? 'item' : 'items'}${fulfilment ? ` · ${fulfilment}` : ''}`;
  return (
    <View pointerEvents="box-none" style={styles.checkoutBarSlot}>
      {/* THE BUMP lives on this OUTER wrapper, never merged into the
          Pressable's own style array -- Task 15's collision (RN style
          flattening replaces a whole `transform` array on key collision,
          rather than merging it element-by-element) is exactly what would
          happen if this scale shared the same node press-feedback's own
          press-scale animates. Two nodes, two transforms, neither can ever
          wipe the other out. */}
      <Animated.View style={bumpStyle}>
        <Pressable
          ref={slipRef}
          onLayout={registerSlipTarget}
          testID="storefront-checkout-bar"
          accessibilityRole="button"
          onPress={onPress}
          style={pressable([styles.slip, { backgroundColor: colors.ground, shadowColor: '#000' }])}
        >
          <View style={styles.slipEvidence}>
            <View style={styles.slipThumbs}>
              {thumbnails.map((uri, i) => (
                <View
                  key={i}
                  style={[
                    styles.slipThumb,
                    i === 0 && styles.slipThumbFirst,
                    { backgroundColor: colors.soft, borderColor: colors.ground },
                  ]}
                >
                  {uri ? <Image source={{ uri }} style={styles.slipThumbImage} /> : null}
                </View>
              ))}
            </View>
            <View>
              {/* TABULAR (styles.slipTotal), so a figure that gains a digit
                  mid-count-up does not shift the layout around it. */}
              <Text style={[styles.slipTotal, { color: colors.ink }]} numberOfLines={1}>{formatCents(displayCents)}</Text>
              <Text style={[styles.slipLine, { color: colors.muted }]} numberOfLines={1}>{line}</Text>
            </View>
          </View>
          {/* CHECKOUT_BLUE, not colors.accent -- the affordance is fixed on
              every palette (Step 0). White type, the pair the constant is
              contrast-tested for; colors.ground would drift per palette. */}
          <View style={[styles.slipGo, { backgroundColor: CHECKOUT_BLUE }]}>
            <Text style={[styles.slipGoText, { color: CHECKOUT_INK }]}>Checkout</Text>
          </View>
        </Pressable>
      </Animated.View>
    </View>
  );
}

export type CheckoutStage = 'browse' | 'checkout' | 'confirmation';

// place_storefront_order's own client-error vocabulary
// (20260927000000_place_order.sql's `c_client_errors`) exists precisely so a
// rejection tells the customer what they can fix -- property 9 of the
// checkout brief. supabase-js surfaces a rejected RPC as an error whose
// `message` IS that fixed code word (e.g. 'unavailable_item'), never prose,
// so this is a lookup table from code to a sentence a shopkeeper's customer
// can act on. Anything not in this table -- an unrecognised code, a network
// error with no `message` at all, `order_failed` itself (the fallback the
// RPC degrades an unanticipated server error to) -- keeps the old generic
// sentence, which is still honest for those cases: there really is nothing
// more specific to say.
const GENERIC_ORDER_ERROR = "We couldn't place your order. Check your connection and try again.";

const ORDER_ERROR_MESSAGES: Record<string, string> = {
  shop_unavailable: "This shop isn't taking orders right now.",
  rate_limited: "This shop has had a lot of orders in the last hour. Please try again shortly.",
  name_required: 'Add your name so the shop knows who is ordering.',
  invalid_name: "That name isn't valid. Check it and try again.",
  invalid_phone: "We couldn't recognise that phone number. Check it and try again.",
  invalid_fulfilment: 'Choose collection or delivery and try again.',
  invalid_landmark: 'Describe the landmark near you and try again.',
  invalid_note: 'Shorten your note and try again.',
  delivery_unavailable: "This shop doesn't offer delivery. Choose collection instead.",
  unknown_delivery_area: "That delivery area isn't available any more. Pick another one.",
  empty_cart: 'Your cart is empty. Add something before checking out.',
  cart_too_large: 'There are too many items in your cart. Remove a few and try again.',
  invalid_quantity: 'One of the quantities in your cart looks wrong. Adjust it and try again.',
  // The one code the brief calls out by name: the action is to remove the
  // item, not just be told about it -- CheckoutScreen below renders an
  // "Edit cart" action whenever this exact code comes back, wired to
  // reopen CartSheet on top of the same cart rather than merely saying so.
  unavailable_item: 'One of the items in your cart is no longer available. Remove it to continue.',
};

// The RPC's error surfaces as `error.message` set to the fixed code word
// itself (a thrown PostgrestError, never a plain string) -- this is the one
// place that assumption lives, so a change to how the RPC is called only
// has to update here.
function orderErrorCode(err: unknown): string | null {
  if (err && typeof err === 'object' && 'message' in err) {
    const message = (err as { message?: unknown }).message;
    if (typeof message === 'string') return message;
  }
  return null;
}

function orderErrorMessage(code: string | null): string {
  return (code && ORDER_ERROR_MESSAGES[code]) || GENERIC_ORDER_ERROR;
}

// Owns everything past "browsing" that every theme needs, and nothing a
// theme should have to get right on its own: filling in checkout, submitting
// through the right one of Task 7's two order functions, and landing on a
// confirmation. Kept out of any one theme for the same reason
// useStorefrontCart is -- Market, Window and Counter all need the identical
// sequencing (place the order, THEN clear the cart, THEN show the
// confirmation; never the other order, and never on a rejected order -- see
// storefront-order.ts's own comments on why that ordering is structural
// there, not just tested behaviour here).
//
// Property 4: a shop with no WhatsApp number still takes orders -- and
// property 2: a shop WITH one offers a genuine choice, not a redirect. The
// choice between the two order functions is made by `via`, the argument
// CheckoutForm's onSubmit hands back to say which of its two controls the
// customer actually pressed -- never re-derived here from whether
// `opts.whatsappE164` merely exists. (It shipped once as exactly that
// re-derivation -- `opts.whatsappE164 ? viaWhatsApp : placeOrder` with no
// `via` at all -- which silently sent every order at a shop with a number
// through WhatsApp, because CheckoutForm only ever rendered the one button
// that could reach here. See submit() below for the fix.)
export function useCheckoutFlow(opts: {
  slug: string;
  shopName: string;
  whatsappE164: string | null;
  // Called once an order has actually been accepted, never on a rejection --
  // wired to useStorefrontCart's clearCart above.
  onOrderPlaced: () => void;
}) {
  const [stage, setStage] = useState<CheckoutStage>('browse');
  const [order, setOrder] = useState<PlacedOrder | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // B1: a `submitting` STATE guard is not enough. React applies the
  // `setSubmitting(true)` from a first tap's handler on the next render; a
  // second tap landing before that render -- a double tap, not two separate
  // user decisions -- would still close over the pre-update `submitting`
  // value and sail through submit() a second time, placing two orders
  // against the same rate limit. A ref is written synchronously, before any
  // `await`, so a re-entrant call always sees it regardless of render timing.
  const submittingRef = useRef(false);

  function openCheckout() {
    setError(null);
    setErrorCode(null);
    setStage('checkout');
  }

  function backToBrowse() {
    setStage('browse');
  }

  async function submit(cart: StorefrontCart, details: CheckoutDetails, via: 'direct' | 'whatsapp') {
    if (submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    setError(null);
    setErrorCode(null);
    try {
      // Branches on `via` -- what the customer pressed -- not on whether
      // `opts.whatsappE164` exists. The `&& opts.whatsappE164` here is only
      // a type narrow for placeOrderViaWhatsApp's required string param: the
      // WhatsApp control in CheckoutForm cannot render, and so `via` cannot
      // be 'whatsapp', unless a number is already present.
      const placed = via === 'whatsapp' && opts.whatsappE164
        ? await placeOrderViaWhatsApp(opts.slug, cart, details, opts.shopName, opts.whatsappE164)
        : await placeOrder(opts.slug, cart, details);
      opts.onOrderPlaced();
      setOrder(placed);
      setStage('confirmation');
    } catch (err) {
      // A rejected order (a stale product, a full cart, a rate limit)
      // leaves the cart exactly as placeOrder left it -- untouched, since
      // onOrderPlaced above is never reached -- and keeps the customer on
      // 'checkout' rather than bouncing them back to an empty-looking cart,
      // so what they typed is still on screen to retry with. B2: the message
      // itself is now the RPC's own client-error code translated into a
      // sentence the customer can act on (see ORDER_ERROR_MESSAGES above),
      // not a one-size-fits-all "check your connection".
      const code = orderErrorCode(err);
      setErrorCode(code);
      setError(orderErrorMessage(code));
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  return { stage, order, error, errorCode, submitting, openCheckout, backToBrowse, submit };
}

// Rendered by every theme in place of its own browsing UI once checkout
// begins. Deliberately theme-agnostic: collecting a name, phone and delivery
// address means the same thing on a photo grid or a price list, and only the
// palette should differ between them -- `colors` already carries that.
export function CheckoutScreen({
  storefront, cart, areas, colors, submitting, error, errorCode, onBack, onSubmit, onEditCart,
}: {
  storefront: PublicStorefront;
  cart: StorefrontCart;
  areas: PublicDeliveryArea[];
  colors: PaletteColors;
  submitting: boolean;
  error: string | null;
  // B2: which client-error code (if any) `error` was translated from -- only
  // 'unavailable_item' changes what renders below the message, everything
  // else is just the sentence.
  errorCode?: string | null;
  onBack: () => void;
  onSubmit: (details: CheckoutDetails, via: 'direct' | 'whatsapp') => void;
  // B2/B7: reopens the cart on 'unavailable_item' so removing the stale
  // line is one tap away, not a message the customer has to act on by
  // guessing where to go. Optional so a caller mid-migration (and every
  // existing test that predates this) still type-checks.
  onEditCart?: () => void;
}) {
  return (
    <View style={[styles.screen, { backgroundColor: colors.ground }]}>
      <View style={styles.screenNav}>
        {/* No background of its own -- `pressable(undefined)` still returns
            the callback, so the opacity/scale applies to the bare text. */}
        <Pressable
          testID="storefront-checkout-back"
          accessibilityRole="button"
          onPress={onBack}
          hitSlop={8}
          style={pressable(undefined)}
        >
          <Text style={[styles.screenBack, { color: colors.ink }]}>‹ Back</Text>
        </Pressable>
        <Text style={[styles.screenTitle, { color: colors.ink }]}>Checkout</Text>
      </View>
      <ScrollView contentContainerStyle={styles.screenBody}>
        {error ? <Text style={[styles.screenError, { color: colors.danger }]}>{error}</Text> : null}
        {/* B2: "remove the item" is the action -- so make it possible from
            right here, not just say it and leave the customer to work out
            that the cart is back through the nav bar. */}
        {errorCode === 'unavailable_item' && onEditCart ? (
          <Pressable
            testID="storefront-checkout-edit-cart"
            accessibilityRole="button"
            onPress={onEditCart}
            style={pressable([styles.editCart, { backgroundColor: colors.accentWash }])}
          >
            <Text style={[styles.editCartText, { color: colors.accentInk }]}>Edit cart</Text>
          </Pressable>
        ) : null}
        <CheckoutForm
          cart={cart}
          colors={colors}
          offersDelivery={storefront.offersDelivery}
          areas={areas}
          submitting={submitting}
          whatsappE164={storefront.whatsappE164}
          // Composed here, not in the form: `collectAddress` is null for
          // nearly every shop (see storefront-collect.ts), and
          // `collectNeighborhood` then `city` are the fallbacks that actually
          // are populated. The form receives a line worth printing or nothing
          // at all.
          collectLocation={collectLocation(storefront.collectAddress, storefront.collectNeighborhood, storefront.city)}
          onSubmit={onSubmit}
        />
        {submitting ? <Text style={[styles.screenHint, { color: colors.muted }]}>Placing your order…</Text> : null}
      </ScrollView>
    </View>
  );
}

// The last screen a customer sees on this page. "Continue shopping" is the
// only way onward -- there is no order history and no account, per
// order-placed.tsx's own header comment on what this trade can honestly
// promise today.
export function ConfirmationScreen({
  order, shopName, collectLocation, colors, onDone, hideBranding,
}: {
  order: PlacedOrder;
  shopName: string;
  // Composed by the caller from the storefront, the same way CheckoutScreen
  // does it -- so the counter named on the confirmation is the one named at
  // checkout. Optional so a caller that predates this still type-checks.
  collectLocation?: string | null;
  colors: PaletteColors;
  onDone: () => void;
  // Threaded rather than read: OrderPlaced deliberately has no storefront
  // prop, so this is passed straight through from the caller's own
  // `storefront.hideBranding`. Optional for the same reason collectLocation
  // is -- see OrderPlaced's own prop comment on why absence must mean shown.
  hideBranding?: boolean;
}) {
  return (
    <View style={[styles.screen, { backgroundColor: colors.ground }]}>
      <ScrollView contentContainerStyle={styles.screenBody}>
        <OrderPlaced
          order={order}
          shopName={shopName}
          collectLocation={collectLocation}
          colors={colors}
          hideBranding={hideBranding}
        />
        <Pressable
          testID="storefront-continue-shopping"
          accessibilityRole="button"
          onPress={onDone}
          style={pressable([styles.continueButton, { backgroundColor: colors.soft }])}
        >
          <Text style={[styles.continueText, { color: colors.ink }]}>Continue shopping</Text>
        </Pressable>
      </ScrollView>
    </View>
  );
}

// The hairline above the anchor card's button, and the only rule drawn on that
// card. Fixed white-at-low-alpha rather than a palette value for the same
// reason ON_SCRIM_INK is fixed: it is drawn on `ink`, which is a near-black on
// every palette, and a derived token would be six values doing one job.
const ON_INK_HAIRLINE = 'rgba(255,255,255,0.14)';

// THE FLOATING SEARCH CARD'S OVERLAP ONTO THE ANCHOR -- 21px, the number the
// mockup settled on. `headerNarrow` (below) is a column flex container with
// `gap: SPACE.cardGap` between its children, and RN's flex `gap` and a
// child's own negative `marginTop` SUM rather than one replacing the other --
// so a margin of `-21` on top of a `SPACE.cardGap` (14) gap rendered as only
// a 7px overlap, not 21, the whole time this shipped. Expressing the margin
// as `-(SEARCH_FLOAT_OVERLAP + SPACE.cardGap)` is what keeps the two numbers
// from being able to drift apart silently again: change the gap, and the
// margin below moves with it, still landing on exactly this many pixels of
// overlap.
const SEARCH_FLOAT_OVERLAP = 21;

const styles = StyleSheet.create({
  // ── bento surfaces ──
  card: { borderRadius: RADIUS.card, padding: SPACE.card },
  // `overflow: hidden` so a hero photograph is clipped to the card's own
  // radius rather than squaring off its corners.
  anchor: { overflow: 'hidden' },
  anchorPhoto: { ...StyleSheet.absoluteFill },
  // Positioning only -- the LinearGradient it sizes paints its own colours.
  // Bottom-weighted (`locations` biased toward the end) rather than the flat
  // scrim this replaces: the type sits at the BOTTOM of this card, so only the
  // area behind it needs to go dark, and the top of the photo now shows
  // through nearly untouched. The text shadow below still carries whatever a
  // near-white photo leaves the gradient short of.
  anchorScrim: { ...StyleSheet.absoluteFill },
  onScrimText: { textShadowColor: 'rgba(0,0,0,0.65)', textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 4 },
  eyebrow: {
    fontSize: TYPE.eyebrow, fontWeight: '800', letterSpacing: LETTER.meta, textTransform: 'uppercase',
  },
  wordmark: {
    fontFamily: DISPLAY_FONT, fontSize: 30, fontWeight: '700',
    letterSpacing: LETTER.displayLoud, lineHeight: 34, marginTop: 12,
  },
  wordmarkWide: { fontSize: 40, lineHeight: 44 },
  place: {
    fontSize: TYPE.eyebrow, fontWeight: '800', letterSpacing: LETTER.meta,
    textTransform: 'uppercase', marginTop: 10,
  },
  // Wraps the single open-state pill -- mockup's `.pills` (gap: 6). Kept as
  // its own row (rather than folding `openPill`'s own margin back in)
  // because it is the row that rises as one entering unit; a second pill
  // used to share it, removed once the collection word it repeated was
  // already said twice more, lower down this same page.
  pillRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 12, alignSelf: 'flex-start' },
  // Same shape as HoursCard's own `statePill`/`stateText` in visit-panel.tsx
  // -- one state, rendered the same way everywhere this page says it.
  openPill: { borderRadius: RADIUS.pill, paddingHorizontal: 11, paddingVertical: 5, alignSelf: 'flex-start' },
  openPillText: { fontSize: TYPE.metaSmall, fontWeight: '800', letterSpacing: 0.4 },
  // `maxWidth: PROSE_MAX_WIDTH` on both -- the two places on this card that
  // read as a SENTENCE rather than a name, a fact, or a pill. Bounding the
  // TEXT here rather than the row ShopHeader sits in (see that row's own
  // `header` style below, and SHOP_MAX_WIDTH's comment in scale.ts for why
  // the row itself stopped carrying a width bound) is what lets the row
  // widen with the grid on a wide monitor while a headline or an about
  // paragraph inside one of its cards still stops at a comfortable measure
  // instead of running the width of a 2,560px card.
  anchorHead: {
    fontSize: 17, fontWeight: '700', letterSpacing: LETTER.display, lineHeight: 23, marginTop: 16, maxWidth: PROSE_MAX_WIDTH,
  },
  anchorAbout: { fontSize: TYPE.body, lineHeight: 20, marginTop: 7, maxWidth: PROSE_MAX_WIDTH },
  anchorFoot: {
    marginTop: 18, paddingTop: 16, borderTopWidth: 1, borderTopColor: ON_INK_HAIRLINE,
    flexDirection: 'row', gap: 8, flexWrap: 'wrap',
  },
  factList: { marginTop: 14 },
  fact: { flexDirection: 'row', justifyContent: 'space-between', gap: 12, paddingVertical: 8, borderBottomWidth: 1 },
  factStacked: { flexDirection: 'column', gap: 1, alignItems: 'flex-start' },
  factLabel: { fontSize: 12.5, fontWeight: '600' },
  factValue: { fontSize: 12.5, fontWeight: '800', textAlign: 'right', flexShrink: 1 },
  factValueStacked: { textAlign: 'left' },
  cardFoot: { marginTop: 14 },
  stockCard: { flexDirection: 'column' },
  stockFoot: { marginTop: 'auto' },
  value: { fontSize: TYPE.value, fontWeight: '800', letterSpacing: -1.1, marginTop: 12, ...TABULAR },
  valueLabel: { fontSize: 12.5, marginTop: 2 },
  dots: { flexDirection: 'row', flexWrap: 'wrap', gap: 5, marginTop: 14 },
  dot: { width: 9, height: 9, borderRadius: RADIUS.pill },
  stockLine: { fontSize: 11.5, marginTop: 10 },
  // minHeight on the BASE style, not `tightPill` -- the narrow layout's own
  // override only touches padding, so the floor set here survives both call
  // sites (ShopHeader's `wide` branch keeps `pill` bare; the narrow branch
  // layers `tightPill`'s smaller padding on top, and RN's shallow per-key
  // merge leaves a key neither object repeats -- `minHeight` -- exactly as
  // this one set it). storefront-cart-button measured 31px through
  // `tightPill` before this; ShopPill has no other caller (`grep -rn
  // ShopPill src` turns up only this file's own definition and the two calls
  // in ShopHeader below), so there is no second button to check.
  pill: {
    borderRadius: RADIUS.pill, paddingHorizontal: 18, paddingVertical: 12,
    alignItems: 'center', justifyContent: 'center', minHeight: TOUCH_TARGET,
  },
  pillText: { fontSize: 13, fontWeight: '800' },
  blockPill: { alignSelf: 'stretch' },
  tightPill: { paddingHorizontal: 14, paddingVertical: 8 },
  // `flexWrap` on BOTH arrangements, and asserted by
  // storefront-theme-header-overflow.test.tsx: nothing in this row may run off
  // the side of a screen. The three cards take `flex: n` (grow n, basis 0), so
  // they have no hypothetical width of their own to overflow with and the wrap
  // is a backstop rather than the mechanism.
  header: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.cardGap, alignItems: 'stretch' },
  anchorWide: { flex: 5 },
  collectingWide: { flex: 4 },
  stockWide: { flex: 3 },
  headerNarrow: { flexWrap: 'wrap', gap: SPACE.cardGap },
  buttonRow: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8, flexWrap: 'wrap' },
  headerPair: { flexDirection: 'row', gap: SPACE.cardGap, alignItems: 'stretch' },
  pairCard: { flex: 1 },

  // Fixed green in every palette: a recognised affordance, not a brand colour.
  // Measured 31px before TOUCH_TARGET -- `paddingVertical: 8` chosen to look
  // right, the same way Cart's own padding was, never checked against a
  // thumb until now.
  wa: {
    backgroundColor: WHATSAPP_BUTTON_GREEN, borderRadius: 999, paddingHorizontal: 14, paddingVertical: 8,
    minHeight: TOUCH_TARGET, alignItems: 'center', justifyContent: 'center',
  },
  waText: { color: WHATSAPP_INK, fontSize: 12.5, fontWeight: '800' },
  empty: { fontSize: 14, fontWeight: '700', padding: 24, textAlign: 'center' },
  emptyBlock: { paddingHorizontal: 24, paddingVertical: 30, alignItems: 'center' },
  emptyHead: { fontSize: 16, fontWeight: '800', letterSpacing: -0.3, textAlign: 'center' },
  emptyBody: { fontSize: 13, lineHeight: 19, marginTop: 7, textAlign: 'center', maxWidth: 320 },
  // Shared by `storefront-empty-clear-category` and `storefront-search-empty-clear`
  // (both call sites pass this same key) -- the "show everything" way out of
  // an empty grid, one control fixed once for both.
  emptyAction: {
    borderRadius: 999, paddingHorizontal: 16, paddingVertical: 9, marginTop: 14,
    minHeight: TOUCH_TARGET, alignItems: 'center', justifyContent: 'center',
  },
  emptyActionText: { fontSize: 12.5, fontWeight: '800' },
  // WhatsApp's own fixed colours, same as WhatsAppButton above -- never the
  // shop's palette.
  emptyWa: {
    backgroundColor: WHATSAPP_BUTTON_GREEN, borderRadius: 999, paddingHorizontal: 16, paddingVertical: 10, marginTop: 14,
    minHeight: TOUCH_TARGET, alignItems: 'center', justifyContent: 'center',
  },
  emptyWaText: { color: WHATSAPP_INK, fontSize: 12.5, fontWeight: '800' },
  // NO HORIZONTAL PADDING OF ITS OWN. This carried `paddingHorizontal:
  // SPACE.page`, which was right when every theme dropped the field straight
  // onto an unpadded page. Market and Window now render it inside the page's
  // own padded column, so its 16 landed on top of the column's 16 and the
  // field sat inset 32 against a hero card, a goods grid and a footer all
  // sitting at 16. NOT "the one element on the page that did not line up
  // with the others", though an earlier version of this comment claimed
  // exactly that -- CategoryBand's own `band` style and CategoryFilterBar's
  // own `filterChip` carried the identical double-padding bug, in the same
  // already-padded column, at the same time this comment was written, and
  // neither was touched by this fix. See those two styles' own comments
  // (category-band.tsx, and `filterChip` below) for the fix that finally
  // reaches them. Counter still renders this field outside its own padded
  // scroller and supplies the inset there (`searchInset`), which is where
  // the decision belongs: a container knows its own margins, a shared field
  // cannot.
  searchRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  // The two placements this field ships in -- see the `floating` prop above.
  // Non-floating keeps the small gap this row always had above it
  // (CategoryBand/CategoryFilterBar, or Window and Counter's own header).
  // Floating replaces that gap with the mockup's own overlap instead, and
  // raises the field above whatever it overlaps -- `zIndex` rather than
  // relying on paint order, since Android's `elevation` on a sibling can
  // reorder that silently.
  // A SECTION BREAK, not a card gap. This was 10, then briefly cardGap's 14,
  // and both were still read as crowded against a 270px hero: cardGap is the
  // space between two cards in the SAME group, and the search is not another
  // card in the header's group -- it is where the page stops introducing the
  // shop and starts letting you look through it. 26 is the rhythm this page
  // already uses for exactly that move (`sectionHead`'s own paddingTop, the
  // "WHAT'S IN TODAY" rule below), so the field now sits on the same beat as
  // the other section boundary rather than inventing a third number.
  // The narrow layout is untouched: it overlaps on purpose
  // (`searchRowFloating`), which is the mockup's own move.
  searchRowInline: { marginTop: 26 },
  // The rendered overlap is `SEARCH_FLOAT_OVERLAP`, not this margin's own
  // magnitude -- `headerNarrow`'s `gap` adds back onto it (see
  // SEARCH_FLOAT_OVERLAP's own comment above). A bare `-21` here would be
  // exactly the bug that shipped: correct-looking, wrong once the parent's
  // gap is added in.
  searchRowFloating: { marginTop: -(SEARCH_FLOAT_OVERLAP + SPACE.cardGap), zIndex: 1 },
  searchCard: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderRadius: 13,
    paddingHorizontal: 14,
    paddingVertical: 11,
    // "0 8 24 rgba(ink, 0.13)" -- the mockup's own .onesearch shadow --
    // expressed as RN's shadow* props plus `elevation` for Android, the same
    // idiom styles.slip below already uses. `colors.ink` rather than a fixed
    // black: every palette's `ink` already reads as near-black (see the
    // comment on THE ANCHOR CARD decision above), so this shadow needs no
    // colour literal of its own.
    shadowOpacity: 0.13,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 8 },
    elevation: 8,
  },
  searchGlyph: { fontSize: TYPE.body, opacity: 0.7 },
  // `storefront-search` measured 16px -- the TextInput sizes to its own text
  // line, nothing else in this card asked it to be taller. minHeight here
  // (not more paddingVertical on `searchCard`, which would also puff up the
  // card sitting around every OTHER child) grows the field itself; the card
  // stays `alignItems: 'center'` so the glyph and Clear stay vertically
  // centred against the now-taller box rather than pinned to its old height.
  searchInput: { flex: 1, padding: 0, fontSize: TYPE.body, minHeight: TOUCH_TARGET },
  searchClear: {
    borderRadius: 999, paddingHorizontal: 13, paddingVertical: 8,
    minHeight: TOUCH_TARGET, alignItems: 'center', justifyContent: 'center',
  },
  searchClearText: { fontSize: 12.5, fontWeight: '800' },
  // `CartButton` below this point in the file has no caller left (`grep -rn
  // CartButton src/components/storefront` after ShopHeader moved to
  // `ShopPill` turns up only this definition) -- kept at TOUCH_TARGET anyway
  // for whichever future caller reaches for the obvious name, not because
  // anything renders it today. See `pill`'s own comment above for the button
  // actually on screen.
  cart: {
    borderRadius: 999, paddingHorizontal: 14, paddingVertical: 8,
    minHeight: TOUCH_TARGET, alignItems: 'center', justifyContent: 'center',
  },
  cartText: { fontSize: 12.5, fontWeight: '800' },
  // NO HORIZONTAL MARGIN OF ITS OWN. This carried `marginHorizontal: 14` --
  // Market and Window render it directly inside the page's own already-
  // padded column (see CategoryBand's `band` style, category-band.tsx, for
  // the identical bug on its sibling), so 16 (page) + 14 (this) put the chip
  // at 30 against the anchor card's 16. `alignSelf: 'flex-start'` means only
  // the LEFT half of that margin ever did anything -- the chip does not
  // stretch to fill its row, so a right margin here moved nothing.
  filterChip: {
    alignSelf: 'flex-start', borderRadius: 999, paddingHorizontal: 13, paddingVertical: 7,
    marginTop: 12, minHeight: TOUCH_TARGET, alignItems: 'center', justifyContent: 'center',
  },
  filterChipText: { fontSize: 12.5, fontWeight: '800' },
  // Full-size default: ProductTile's grid tile, where the pair fills the
  // tile's own width evenly.
  actions: { flexDirection: 'row', gap: 6 },
  button: { flex: 1, borderRadius: 9, paddingVertical: 6, alignItems: 'center' },
  // The floor, layered on top of `button` only for the non-`compact` call --
  // see `COMPACT_BUTTON_HIT_SLOP`'s own comment above for why `compact`
  // reaches for hitSlop instead of this.
  buttonFloor: { minHeight: TOUCH_TARGET, justifyContent: 'center' },
  buttonText: { fontSize: 12, fontWeight: '800' },
  // Row scale: Counter's dense price list, where the pair sits inline next
  // to the stock label rather than filling a row's width.
  actionsCompact: { gap: 4 },
  // `flexGrow/Shrink/Basis` spelled out rather than the `flex: 0` shorthand
  // this used to carry, because THE SHORTHAND DOES NOT MEAN THE SAME THING ON
  // THE TWO PLATFORMS.
  //
  // React Native reads `flex: 0` as grow 0 / shrink 0 / basis auto -- the
  // button hugs its label, which is what Counter's dense row wants. CSS reads
  // it as `0 1 0%`: basis ZERO, so on react-native-web the button collapsed to
  // its own horizontal padding and clipped the label -- "Add" rendered as
  // "Adc" on every Counter shop. Native was fine, so nothing in the app
  // surfaced it, and jest cannot see it because react-test-renderer does no
  // layout. It showed up the first time Counter was opened in a browser --
  // which is where nearly all of this page's traffic actually is.
  //
  // The longhand is identical on both.
  buttonCompact: { flexGrow: 0, flexShrink: 0, flexBasis: 'auto', borderRadius: 7, paddingVertical: 3, paddingHorizontal: 9 },
  buttonTextCompact: { fontSize: 10.5 },
  // The slot is what floats; the bar inside it carries its own width bound,
  // independent of whatever the grid or the header are doing (Task C freed
  // both of them from SHOP_MAX_WIDTH -- see that constant's own comment in
  // scale.ts -- but a floating action bar is a different question from a
  // grid or a row of cards: it is one button, and a 2000px-wide "Checkout"
  // pill is not a bigger button, it is a slip that has stopped reading as a
  // button at all). Absolute left/right anchor to the theme root, which is
  // the full window, so the maxWidth below is what stops that -- reusing
  // SHOP_MAX_WIDTH as a familiar ceiling rather than inventing a second
  // ad-hoc number for the same "not the whole window" judgment.
  checkoutBarSlot: { position: 'absolute', left: 14, right: 14, bottom: 14, alignItems: 'center' },
  slip: {
    width: '100%', maxWidth: SHOP_MAX_WIDTH - 28,
    borderRadius: 999, paddingVertical: 8, paddingLeft: 16, paddingRight: 8,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 14,
    shadowOpacity: 0.13, shadowRadius: 14, shadowOffset: { width: 0, height: 6 }, elevation: 6,
    // Content already carries this Pressable past 44 (the comment on
    // CHECKOUT_BAR_CLEARANCE above works the arithmetic: `slipGo`'s own
    // padding puts the box at 55px) -- but that height comes from a CHILD's
    // padding, not a literal number in THIS style, which is exactly what
    // storefront-touch-targets.test.tsx's rule cannot see without laying
    // out a single pixel. `minHeight` states the floor this box already
    // clears, rather than leaving it implied by a child the sweep does not
    // read into.
    minHeight: TOUCH_TARGET,
  },
  slipEvidence: { flexDirection: 'row', alignItems: 'center', gap: 11, flexShrink: 1 },
  slipThumbs: { flexDirection: 'row' },
  slipThumb: {
    width: 30, height: 30, borderRadius: 9, borderWidth: 2, marginLeft: -9, overflow: 'hidden',
  },
  slipThumbFirst: { marginLeft: 0 },
  slipThumbImage: { width: '100%', height: '100%' },
  // TABULAR: the count-up (fly-to-cart.ts's countUpValue) redraws this text
  // every animation frame, and a proportional face would shuffle digits
  // sideways as it climbed through $9.99 -> $10.00.
  slipTotal: { fontSize: 14, fontWeight: '800', ...TABULAR },
  slipLine: { fontSize: 11.5, fontWeight: '600', marginTop: 1 },
  slipGo: { borderRadius: 999, paddingHorizontal: 20, paddingVertical: 11 },
  slipGoText: { fontSize: 13.5, fontWeight: '800' },
  screen: { flex: 1 },
  screenNav: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14 },
  screenBack: { fontSize: 14, fontWeight: '700' },
  screenTitle: { fontSize: 16, fontWeight: '800' },
  screenBody: { paddingHorizontal: 14, paddingBottom: 24 },
  screenError: { fontSize: 13, fontWeight: '700', marginBottom: 10 },
  editCart: { alignSelf: 'flex-start', borderRadius: 999, paddingHorizontal: 14, paddingVertical: 7, marginBottom: 14 },
  editCartText: { fontSize: 12.5, fontWeight: '800' },
  screenHint: { fontSize: 12.5, marginTop: 10, textAlign: 'center' },
  continueButton: { marginTop: 16, borderRadius: 999, paddingVertical: 12, alignItems: 'center' },
  continueText: { fontSize: 14, fontWeight: '800' },
});
