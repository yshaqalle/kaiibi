import { useEffect, useRef, useState } from 'react';
import {
  Pressable, ScrollView, StyleSheet, Text, View, type LayoutChangeEvent,
} from 'react-native';
import Animated, {
  useAnimatedStyle, useReducedMotion, useSharedValue, withSpring, type SharedValue,
} from 'react-native-reanimated';

import { pressable } from '@/components/storefront/press-feedback';
import { useWheelPan } from '@/hooks/use-wheel-pan';
import { isConfigured } from '@/lib/store-hours';
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
//   visit -- with priced delivery areas OR opening hours. Either one says
//            something the Shop tab cannot: the Collecting card reduces every
//            area to the cheapest ("From $1.00"), which cannot answer "is MY
//            area on the list", and it has never shown hours at all. With
//            neither, the tab's whole content would be the Collecting card
//            repeated, and a tab that repeats the page you came from is worse
//            than no tab.
//
// A shop that has filled in neither gets `['shop']`, and ShopTabRail renders
// nothing at all for a single tab -- so the page is exactly what shipped
// before this existed, with no empty chrome to explain.
export function availableTabs(
  storefront: Pick<PublicStorefront, 'about'> & Partial<Pick<PublicStorefront, 'openingHours'>>,
  areas: PublicDeliveryArea[],
): ShopTabKey[] {
  const tabs: ShopTabKey[] = ['shop'];
  if (storefront.about?.trim()) tabs.push('about');
  // `isConfigured` is store-hours.ts's own test and means the shop has SAVED
  // hours at all -- `{}` is untouched, anything else was written by the editor
  // under Settings -> Locations. A week of explicitly empty days therefore
  // counts, and should: that is a shop stating it is closed, which is an
  // answer, and the panel prints it as seven honest "Closed" rows rather than
  // inventing one. Reused rather than re-derived here so this page and the
  // dashboard's own hours card cannot disagree about what "set" means.
  // `?? {}` at the boundary, not because the type admits undefined but because
  // reality does: getPublicStorefront maps a missing column to {} (a client
  // updates over the air, migrations do not), and every other caller that
  // builds a PublicStorefront by hand -- the editor's preview, a dozen test
  // fixtures -- is one omission away from handing this a hole. isConfigured
  // calls Object.keys, which throws on undefined, and a shop page that throws
  // is worse than one with no Visit tab.
  if (areas.length > 0 || isConfigured(storefront.openingHours ?? {})) tabs.push('visit');
  return tabs;
}

// THE SLIDING PILL'S OWN DECISION, pulled out for the same reason
// heroRiseDelay (theme-shared.tsx) is: nothing about a spring reaching its
// target can be asserted through a render of this component -- the shared
// reanimated jest mock (jest/reanimated-mock.js) resolves every `withSpring`
// synchronously, so a test that renders ShopTabRail and inspects the pill's
// style would only ever see it already AT its destination, springing or not.
//
// Two facts decide it: is reduced motion on, and is this the FIRST layout
// this pill has ever been told about. The second matters because the very
// first tab measured has nowhere to travel FROM -- `pillX`/`pillWidth` start
// at 0 on mount, and springing from (0, 0) to the Shop tab's real position
// would read as the pill flying in from off-screen rather than the page
// simply opening with Shop already selected.
export function pillMotion(reducedMotion: boolean, isFirstMeasurement: boolean): 'snap' | 'spring' {
  return reducedMotion || isFirstMeasurement ? 'snap' : 'spring';
}

type TabLayout = { x: number; width: number };

export function ShopTabRail({
  colors, tabs, active, onSelect,
}: {
  colors: PaletteColors;
  tabs: ShopTabKey[];
  active: ShopTabKey;
  onSelect: (tab: ShopTabKey) => void;
}) {
  const reducedMotion = useReducedMotion();
  // Customer-facing, and a shop name is not length-limited -- which is the
  // reason this rail scrolls rather than wraps (see the note below). A mouse
  // could not move it. See use-wheel-pan.ts.
  const { ref: railScrollRef, wheelPanProps: railWheelProps } = useWheelPan([tabs.length]);

  // THE GUARDRAIL, RESOLVED WITHOUT FAKING A RADIUS. `left`/`width` -- the
  // mockup's own `.segpill` CSS transition -- are neither transform nor
  // opacity, so the pill's HORIZONTAL TRAVEL stays `translateX`, a
  // transform, animated by Reanimated exactly as before. But the pill's
  // WIDTH is now set directly, as a plain style value (`pillWidth`, React
  // state, not a shared value) taken from the active tab's measured layout
  // -- setting a style prop when the selection changes is not "animating
  // width": nothing tweens it, it steps to the new tab's own width the
  // instant selection changes, the same way this pill's `backgroundColor`
  // already does. Only the position travels; the guardrail is about motion,
  // not about which style properties may ever be set.
  //
  // This replaces an earlier version that gave the pill a fixed 1px base
  // width and grew it with `scaleX`. That does not work: border-radius
  // resolves against the PRE-transform box, so `borderRadius: 999` on a
  // 1px-wide box clamps to roughly a 0.5px corner, and `scaleX` then
  // stretches that already-rasterized corner rather than recomputing it at
  // the new size -- so the pill drew as a near-rectangle at every width,
  // including at rest, never the capsule the comment here used to claim.
  // Giving the pill its real width and letting `borderRadius: RADIUS.pill`
  // resolve against the correctly-sized box is what actually renders one.
  const pillX = useSharedValue(0);
  const [pillWidth, setPillWidth] = useState(0);
  const layoutsRef = useRef<Partial<Record<ShopTabKey, TabLayout>>>({});
  const hasMeasuredRef = useRef(false);

  function applyLayout(layout: TabLayout) {
    const motion = pillMotion(reducedMotion, !hasMeasuredRef.current);
    hasMeasuredRef.current = true;
    setPillWidth(layout.width);
    if (motion === 'spring') {
      pillX.value = withSpring(layout.x, { damping: 18, stiffness: 180 });
    } else {
      pillX.value = layout.x;
    }
  }

  function handleTabLayout(tab: ShopTabKey, event: LayoutChangeEvent) {
    const { x, width } = event.nativeEvent.layout;
    layoutsRef.current[tab] = { x, width };
    if (tab === active) applyLayout({ x, width });
  }

  // A tab pressed into existence: the active tab CHANGED, and its layout may
  // already be cached from its own earlier onLayout (every visible tab lays
  // out once at mount, whether or not it starts selected).
  useEffect(() => {
    const layout = layoutsRef.current[active];
    if (layout) applyLayout(layout);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- applyLayout closes over stable refs/shared values
  }, [active]);

  const pillStyle = useAnimatedPillStyle(pillX);

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
      <ScrollView ref={railScrollRef} horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.row} {...railWheelProps}>
        {/* THE SLIDING FILL. `pointerEvents="none"` so it never steals a tap
            meant for the transparent tab painted over it; `colors.ink`
            matches the flat fill this replaces exactly, so a device that
            somehow never fires a layout event (an empty ScrollView on a
            platform that skips it) still shows the CORRECT tab filled, just
            without ever having slid there. */}
        <Animated.View
          testID="storefront-tab-pill"
          style={[styles.pill, { backgroundColor: colors.ink, width: pillWidth }, pillStyle]}
        />
        {tabs.map((tab) => {
          const selected = tab === active;
          return (
            <Pressable
              key={tab}
              testID={`storefront-tab-${tab}`}
              accessibilityRole="tab"
              accessibilityState={{ selected }}
              onPress={() => onSelect(tab)}
              onLayout={(event) => handleTabLayout(tab, event)}
              style={pressable([
                styles.tab,
                // Unselected tabs take the page tone; the selected one goes
                // transparent so the sliding pill behind it -- not a
                // background colour of its own -- is what the eye reads as
                // "filled". Unlike a category pill these sit INSIDE a
                // filled rail, so the rail's own edge already bounds the
                // group and a border on each one would draw four lines to
                // separate three words.
                selected ? styles.tabActive : { backgroundColor: colors.soft },
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

// Pulled into its own tiny hook only so the animated-style callback -- which
// Reanimated's babel plugin needs to see as a worklet -- reads cleanly next
// to the two shared values it closes over, rather than being inlined where
// ShopTabRail's own already-long body would bury it.
function useAnimatedPillStyle(pillX: SharedValue<number>) {
  return useAnimatedStyle(() => ({
    transform: [{ translateX: pillX.value }],
  }));
}

const styles = StyleSheet.create({
  rail: { paddingHorizontal: SPACE.page, paddingVertical: 10, borderBottomWidth: 1 },
  // `position: relative` is what makes the pill's `position: absolute`
  // measure against THIS row rather than some further ancestor -- and its
  // own height, set only by the tallest child (the tabs), is exactly what
  // the pill's `top: 0, bottom: 0` needs to fill.
  row: { position: 'relative', flexDirection: 'row', gap: 6, paddingRight: SPACE.page },
  tab: { borderRadius: RADIUS.pill, paddingHorizontal: 18, paddingVertical: 9 },
  // Transparent, not a colour of its own -- the sliding pill underneath is
  // what a selected tab's fill IS now, see ShopTabRail's own comment.
  tabActive: { backgroundColor: 'transparent' },
  label: { fontSize: TYPE.meta + 1.5, fontWeight: '800', letterSpacing: LETTER.display },
  // `width` is set inline at the call site (`pillWidth` state, from the
  // active tab's measured layout) -- never here, and never animated. Only
  // `top: 0, bottom: 0` are structural: they stretch the pill to the row's
  // own height, whatever that is.
  pill: {
    position: 'absolute', left: 0, top: 0, bottom: 0,
    borderRadius: RADIUS.pill,
  },
});

// WHERE THE TAB LIVES WHEN NOBODY ELSE OWNS IT.
//
// The tab is part of the ADDRESS -- /store/<slug>/about opens on About, and
// pressing About changes the URL -- so on the public route it is owned by the
// route and handed down. But the same themes render in the storefront EDITOR's
// preview, which has no router and no address to change, and in a dozen tests
// that render a theme directly.
//
// So the props are optional and this is the fallback, in ONE place rather than
// once per theme: given a controlled pair, it returns them untouched; given
// nothing, it keeps its own state. The three themes call it in a line and stop
// caring which case they are in.
export function useShopTab(
  tab?: ShopTabKey,
  onSelectTab?: (tab: ShopTabKey) => void,
): [ShopTabKey, (tab: ShopTabKey) => void] {
  // Always called, never conditionally -- the hook rules do not care that the
  // value goes unused in the controlled case.
  const [ownTab, setOwnTab] = useState<ShopTabKey>('shop');
  return [tab ?? ownTab, onSelectTab ?? setOwnTab];
}
