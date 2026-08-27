import { useEffect, useRef, useState } from 'react';
import {
  AccessibilityInfo, Image, Pressable, ScrollView, StyleSheet, Text, View,
  useWindowDimensions, type LayoutChangeEvent, type NativeScrollEvent, type NativeSyntheticEvent,
} from 'react-native';

import { openExternalUrl } from '@/lib/external-url';
import { offerCopyFor } from '@/lib/poster';
import { waLink } from '@/lib/storefront';
import type { PaletteColors } from '@/lib/storefront-catalog';
import type { StorefrontFlyer } from '@/types/models';

// The band of posters at the top of a shop's public page.
//
// Three shapes, and the difference between them is the whole component:
//
//   ZERO renders NOTHING -- not an empty frame, not an "add a flyer"
//   placeholder. That is the same photo-optional rule ProductTile follows for
//   products.image_url and ThemeWindow follows for hero_image_url: a shop
//   that has uploaded nothing must look deliberate, not abandoned.
//
//   ONE renders STATIC. No dots, no arrows. A single dot a customer can press
//   to arrive where they already are, or an arrow to nowhere, is a control
//   that lies about what is behind it -- worse than no control at all.
//
//   TWO OR MORE renders the carousel: swipe (a paging ScrollView), arrows and
//   dots, each of them a real button.
//
// COLOURS COME FROM THE SHOP'S OWN PALETTE, never bento tokens and never a
// hex literal -- `colors` is paletteColors(...) from storefront-catalog.ts,
// the same four-plus-two every theme renders through.
//
// MOTION (Task 4). `autoAdvance` (storefronts.auto_advance, 20260930000200)
// is the shop asking the band to move on its own -- off by default, and
// never sufficient on its own:
//
//   - `prefers-reduced-motion` WINS, in both directions. A shop with
//     auto_advance on gets no motion for a customer whose device asks for
//     less of it; a shop with it off gets none regardless of the device.
//     Read live via AccessibilityInfo.isReduceMotionEnabled() at mount and
//     kept live via its 'reduceMotionChanged' event, because a toggle
//     flipped mid-visit must stop the band immediately, not merely at the
//     next page load. UNKNOWN (the query has not resolved, or the platform
//     cannot answer it) fails SAFE -- treated as "reduce", never as "fine" --
//     so a device this call cannot reach is never moved against a
//     preference nobody could confirm.
//   - HOVER, TOUCH OR KEYBOARD FOCUS anywhere on the band stops it FOR THE
//     VISIT and it does not resume, even if the customer moves away again.
//     A carousel that starts moving again the moment somebody has settled in
//     to read is worse than one that never moved at all.
//   - A SINGLE FLYER NEVER ADVANCES, whatever the setting says -- there is
//     nowhere to go, and a timer firing against one slide is a bug waiting
//     to be filed as "the page flickers".
//   - MANUAL CONTROLS ARE UNCONDITIONAL. Dots, arrows and swipe work exactly
//     the same whether or not the band is auto-advancing, before a stop and
//     after one.

type Props = {
  flyers: StorefrontFlyer[];
  colors: PaletteColors;
  shopName: string;
  whatsappE164: string | null;
  // How a 'category' slide filters the page. The band does not reach into
  // the grid itself: which products are showing is the theme's state, and a
  // display component holding it would put the same decision in three
  // places. A theme that passes nothing makes category slides
  // non-interactive, which is the correct degradation -- see flyerAction.
  onSelectCategory?: (category: string) => void;
  // The shop's own request to move the band on its own (storefronts.auto_advance,
  // 20260930000200). Off by default, and never the only word on whether the
  // band actually moves -- see the motion effect below.
  autoAdvance?: boolean;
};

// The card's inset from the page edge. The paging ScrollView itself must span
// the full band width -- pagingEnabled snaps by VIEWPORT width, so an inset
// applied to the scroller would leave every slide after the first sitting a
// little further off than the last. The inset goes on the card inside each
// full-width slide instead.
const CARD_INSET = 14;

// How long a slide sits before the band moves on, when it is allowed to
// move at all. Long enough to read a headline, a subline and an offer's
// three derived lines on a phone before it changes -- this page is read "on
// a phone, in a shop doorway, often over a slow connection" (Task 4's
// brief), where a fast carousel is just as hostile as a moving one nobody
// asked for. Exported so the tests that drive fake timers assert against
// this value rather than a second copy of it that could drift.
export const AUTO_ADVANCE_INTERVAL_MS = 6000;

export function FlyerCarousel({
  flyers, colors, shopName, whatsappE164, onSelectCategory, autoAdvance = false,
}: Props) {
  const { width: windowWidth } = useWindowDimensions();
  // Seeded from the window so the first paint is already close, then
  // corrected by onLayout to the band's real width. Starting at 0 would give
  // every slide zero width for one frame, which on a slow connection is a
  // visible collapse rather than a subtle reflow.
  const [width, setWidth] = useState(windowWidth);
  const [index, setIndex] = useState(0);
  const scroller = useRef<ScrollView>(null);

  const count = flyers.length;

  // null = "not answered yet". Treated the same as `true` by `motionActive`
  // below -- see the header comment's "fails safe" note -- so the band
  // cannot move for the brief window before the device has actually said
  // motion is fine.
  const [reducedMotion, setReducedMotion] = useState<boolean | null>(null);
  // Set once, per mount, and never cleared: property 3's "does not resume
  // for the visit" IS this being one-way. A fresh mount (a new page load)
  // is a new visit and starts unstopped again.
  const [stoppedForVisit, setStoppedForVisit] = useState(false);

  useEffect(() => {
    let mounted = true;
    AccessibilityInfo.isReduceMotionEnabled()
      .then((value) => { if (mounted) setReducedMotion(value); })
      .catch(() => { if (mounted) setReducedMotion(true); });
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', (value) => {
      setReducedMotion(value);
    });
    return () => {
      mounted = false;
      subscription.remove();
    };
    // Mount only. A prop changing later (autoAdvance flipping) must not
    // re-ask the device something about ITSELF that has not changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function stopForVisit() {
    setStoppedForVisit(true);
  }

  // Every one of properties 1-5 in one expression, deliberately: the shop's
  // request, the device's veto (only once it has actually answered),
  // whether this visit has already stopped it, and whether there is
  // anywhere to go at all.
  const motionActive = autoAdvance && reducedMotion === false && !stoppedForVisit && count >= 2;

  useEffect(() => {
    if (!motionActive) return;
    const id = setInterval(() => {
      setIndex((current) => {
        const next = (current + 1) % count;
        scroller.current?.scrollTo({ x: next * width, animated: true });
        return next;
      });
    }, AUTO_ADVANCE_INTERVAL_MS);
    return () => clearInterval(id);
  }, [motionActive, count, width]);

  function goTo(next: number) {
    if (count < 2) return;
    // Wraps rather than clamping. An arrow that renders but refuses at the
    // end is the same lie a dot on a single flyer would be -- and on a phone,
    // where the arrows are small, "nothing happened" reads as broken.
    const target = ((next % count) + count) % count;
    setIndex(target);
    scroller.current?.scrollTo({ x: target * width, animated: true });
  }

  // The scroll position is the truth once a customer has swiped -- this is
  // what keeps the dots honest about which slide they are looking at.
  function handleMomentumEnd(event: NativeSyntheticEvent<NativeScrollEvent>) {
    const offset = event.nativeEvent.contentOffset.x;
    if (width <= 0) return;
    setIndex(Math.max(0, Math.min(count - 1, Math.round(offset / width))));
  }

  function handleLayout(event: LayoutChangeEvent) {
    const measured = event.nativeEvent.layout.width;
    if (measured > 0 && measured !== width) setWidth(measured);
  }

  const context = { shopName, whatsappE164, onSelectCategory };

  // Property 1. Before any frame, any wrapper, any padding.
  if (count === 0) return null;

  // Property 2. One flyer is a hero, not a carousel of one.
  if (count === 1) {
    return (
      <View style={styles.band} testID="storefront-flyer-band">
        <FlyerSlide flyer={flyers[0]} colors={colors} context={context} />
      </View>
    );
  }

  return (
    <View
      style={styles.band}
      testID="storefront-flyer-band"
      onLayout={handleLayout}
      // Hover, touch and keyboard focus, ANYWHERE on the band, stop
      // auto-advance for the visit (property 3). `onMouseEnter`/`onTouchStart`/
      // `onFocus` are forwarded straight through to the DOM on
      // react-native-web for any host component, not only Pressable -- no
      // wrapping Pressable needed, which matters here because one would
      // compete with the ScrollView below for the same touch gesture.
      // `onFocus` also bubbles (the browser's `focusin`), so tabbing to an
      // arrow, a dot or a slide inside the band reaches this handler too,
      // not only a focus on the band itself. `onMouseEnter` is spread rather
      // than typed directly: RN's own `ViewProps` (which this file compiles
      // against on every platform) has never had a mouse event, since native
      // RN has no mouse -- the same reason trend-chart.tsx spreads its own
      // hover handlers onto a plain View rather than typing them.
      {...{ onMouseEnter: stopForVisit }}
      onTouchStart={stopForVisit}
      onFocus={stopForVisit}
    >
      <ScrollView
        ref={scroller}
        testID="storefront-flyer-track"
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        onMomentumScrollEnd={handleMomentumEnd}
      >
        {/* Every slide is in the tree, in `position` order, whether or not it
            is the one on screen -- so a screen reader and the tab key walk
            the flyers in the order the shop arranged them, rather than
            reaching only whichever one happens to be showing. */}
        {flyers.map((flyer, i) => (
          <View key={flyer.id} style={{ width }}>
            <FlyerSlide flyer={flyer} colors={colors} context={context} onFocus={() => goTo(i)} />
          </View>
        ))}
      </ScrollView>

      <Pressable
        testID="storefront-flyer-prev"
        accessibilityRole="button"
        accessibilityLabel="Previous flyer"
        onPress={() => goTo(index - 1)}
        hitSlop={10}
        style={[styles.arrow, styles.arrowLeft, { backgroundColor: colors.ground }]}
      >
        <Text style={[styles.arrowGlyph, { color: colors.ink }]}>‹</Text>
      </Pressable>
      <Pressable
        testID="storefront-flyer-next"
        accessibilityRole="button"
        accessibilityLabel="Next flyer"
        onPress={() => goTo(index + 1)}
        hitSlop={10}
        style={[styles.arrow, styles.arrowRight, { backgroundColor: colors.ground }]}
      >
        <Text style={[styles.arrowGlyph, { color: colors.ink }]}>›</Text>
      </Pressable>

      <View style={styles.dots} testID="storefront-flyer-dots">
        {flyers.map((flyer, i) => (
          <Pressable
            key={flyer.id}
            testID="storefront-flyer-dot"
            accessibilityRole="button"
            // Which one is showing has to be READABLE, not only visible as a
            // filled circle -- a dot is otherwise indistinguishable from its
            // neighbours to anything that cannot see it.
            accessibilityState={{ selected: i === index }}
            accessibilityLabel={`Flyer ${i + 1} of ${count}`}
            onPress={() => goTo(i)}
            hitSlop={8}
            style={[styles.dot, { backgroundColor: i === index ? colors.accent : colors.soft }]}
          />
        ))}
      </View>
    </View>
  );
}

// What a slide does when it is pressed, or null when it does nothing.
//
// Null is the interesting case: property 6 says a 'none' slide "is not
// interactive at all -- and must not look it", so this returning null is what
// removes the Pressable, the role AND the call-to-action chip in one place,
// rather than each of the three being remembered separately.
//
// A 'category' slide with nowhere to report to, and a 'whatsapp' slide at a
// shop with no number, land in the same place deliberately: it is the rule
// WhatsAppButton and ProductActions already follow -- lose the affordance
// rather than render one that opens a chat with nobody, or filters a page
// that is not listening.
type FlyerAction = { role: 'button' | 'link'; label: string; run: () => void };

type SlideContext = {
  shopName: string;
  whatsappE164: string | null;
  onSelectCategory?: (category: string) => void;
};

function flyerAction(flyer: StorefrontFlyer, context: SlideContext): FlyerAction | null {
  if (flyer.linkKind === 'category') {
    const category = flyer.linkValue?.trim();
    if (!category || !context.onSelectCategory) return null;
    const select = context.onSelectCategory;
    return { role: 'button', label: `See ${category}`, run: () => select(category) };
  }

  if (flyer.linkKind === 'whatsapp') {
    if (!context.whatsappE164) return null;
    const href = waLink(context.whatsappE164, enquiryFor(flyer, context.shopName));
    return { role: 'link', label: 'Ask on WhatsApp', run: () => openExternalUrl(href) };
  }

  return null;
}

// An enquiry about THIS offer, not a bare hello -- the shopkeeper reads it on
// a phone between customers and should not have to ask which poster it is
// about. `link_value` carries the owner's own wording when they typed one
// (that is what the column is for on a 'whatsapp' flyer); otherwise the
// headline names it, and failing that the derived offer does.
function enquiryFor(flyer: StorefrontFlyer, shopName: string): string {
  const own = flyer.linkValue?.trim();
  if (own) return own;
  const offer = flyer.offer ? offerCopyFor(flyer.offer) : null;
  const subject = flyer.headline?.trim()
    || (offer ? `${offer.value} off ${offer.scope.toLowerCase()}` : null);
  return subject
    ? `Hi ${shopName}, I saw "${subject}" on your page.`
    : `Hi ${shopName}, I have a question about your page.`;
}

function FlyerSlide({
  flyer, colors, context, onFocus,
}: { flyer: StorefrontFlyer; colors: PaletteColors; context: SlideContext; onFocus?: () => void }) {
  const action = flyerAction(flyer, context);
  // The offer's WORDS, derived here from the promotion's raw facts by the
  // very function the printed poster comes through -- src/lib/poster.ts's
  // offerCopyFor. The database sends the facts and decides, on its own,
  // whether the flyer is entitled to be on this page at all; it does not send
  // sentences, and there is no second copy of this wording anywhere for the
  // page to drift away from.
  const offer = flyer.offer ? offerCopyFor(flyer.offer) : null;
  const hasCopy = Boolean(offer || flyer.headline || flyer.subline || action);

  // The picture sits ABOVE the copy rather than behind it. The design note
  // (docs/design/storefront-address-and-flyers-mockup.html) draws the words
  // over a gradient panel, which works because the mockup chose the gradient;
  // a real flyer is whatever the shop photographed, and type laid over an
  // arbitrary photo has no contrast anyone can guarantee. Every palette's
  // ink-on-soft IS guaranteed -- storefront-catalog.test.ts checks all six
  // against the WCAG maths -- so the copy goes on `soft` below the image.
  // Same trade ProductTile makes, and for the same reason.
  const body = (
    <View style={[styles.card, { backgroundColor: colors.soft }]}>
      {flyer.imageUrl ? (
        <Image source={{ uri: flyer.imageUrl }} style={styles.image} resizeMode="cover" />
      ) : null}
      {hasCopy ? (
        <View style={styles.copy}>
          {/* The derived offer, printed VERBATIM -- offerCopyFor's three
              strings, unedited. Rewording them here is how the page starts
              disagreeing with the paper poster and the till. */}
          {offer ? (
            <>
              <Text testID="storefront-flyer-offer-value" style={[styles.offerValue, { color: colors.accent }]}>
                {offer.value}
              </Text>
              <Text testID="storefront-flyer-offer-scope" style={[styles.offerScope, { color: colors.ink }]}>
                {offer.scope}
              </Text>
              {offer.when ? (
                <Text testID="storefront-flyer-offer-when" style={[styles.offerWhen, { color: colors.muted }]}>
                  {offer.when}
                </Text>
              ) : null}
            </>
          ) : null}
          {flyer.headline ? (
            <Text style={[styles.headline, { color: colors.ink }]} numberOfLines={2}>{flyer.headline}</Text>
          ) : null}
          {flyer.subline ? (
            <Text style={[styles.subline, { color: colors.muted }]} numberOfLines={3}>{flyer.subline}</Text>
          ) : null}
          {/* Only ever rendered alongside a real handler -- see flyerAction. */}
          {action ? (
            <Text testID="storefront-flyer-cta" style={[styles.cta, { color: colors.accent }]}>{action.label} →</Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );

  if (!action) {
    // No Pressable, no role, no handler, no chip: a slide that goes nowhere
    // must not be reachable as a control OR look like one.
    return <View testID="storefront-flyer-slide" style={styles.slide}>{body}</View>;
  }

  return (
    <Pressable
      testID="storefront-flyer-slide"
      accessibilityRole={action.role}
      accessibilityLabel={action.label}
      onPress={action.run}
      // Tabbing to an off-screen slide has to bring it on screen, or the
      // keyboard route through the band is invisible to the person using it.
      onFocus={onFocus}
      style={styles.slide}
    >
      {body}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  // No margin of its own: the themes place the band, and each already has
  // its own vertical rhythm between the blurb and the goods.
  band: { paddingTop: 12 },
  slide: { paddingHorizontal: CARD_INSET },
  card: { borderRadius: 16, overflow: 'hidden' },
  // 16:9 rather than a fixed height -- a flyer is a poster the shop
  // photographed or exported, and a fixed height crops a different amount of
  // every one of them.
  image: { width: '100%', aspectRatio: 16 / 9 },
  copy: { paddingHorizontal: 14, paddingTop: 11, paddingBottom: 13 },
  offerValue: { fontSize: 30, fontWeight: '800', letterSpacing: -1 },
  offerScope: { fontSize: 14, fontWeight: '800', marginTop: 1 },
  offerWhen: { fontSize: 12, marginTop: 2 },
  headline: { fontSize: 16, fontWeight: '800', letterSpacing: -0.3, marginTop: 6 },
  subline: { fontSize: 12.5, marginTop: 4, lineHeight: 17 },
  cta: { fontSize: 12.5, fontWeight: '800', marginTop: 8 },
  // Centred on the card, inside its inset, so an arrow never floats over the
  // page's own margin.
  arrow: {
    position: 'absolute', top: '38%',
    width: 30, height: 30, borderRadius: 999,
    alignItems: 'center', justifyContent: 'center',
  },
  arrowLeft: { left: CARD_INSET + 8 },
  arrowRight: { right: CARD_INSET + 8 },
  arrowGlyph: { fontSize: 18, fontWeight: '800', lineHeight: 20 },
  dots: { flexDirection: 'row', justifyContent: 'center', gap: 6, paddingTop: 9 },
  dot: { width: 7, height: 7, borderRadius: 999 },
});
