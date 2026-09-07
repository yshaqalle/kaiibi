import { useEffect, useRef, useState } from 'react';
import { Easing, StyleSheet, View, type View as ViewType } from 'react-native';
import Animated, {
  runOnJS, useAnimatedStyle, useReducedMotion, useSharedValue, withTiming,
} from 'react-native-reanimated';

import {
  arcOpacity, arcPoint, arcScale, flyToCartMotion, getSlipTarget, registerFlyTrigger, unregisterFlyTrigger,
  type Point,
} from '@/components/storefront/fly-to-cart';
import type { PaletteColors } from '@/lib/storefront-catalog';

const DOT_SIZE = 14;
const ARC_DURATION_MS = 520;

// THE OVERLAY THE DOT FLIES INSIDE. Mounted exactly once, inside ShopChrome
// (shop-chrome.tsx), so all three themes carry it without each having to
// know it exists. A full-bleed, `pointerEvents="none"` sibling of the
// browsing content -- it paints nothing of its own until a fly is in
// flight, and never intercepts a touch meant for the grid under it.
//
// THE COORDINATE HANDOFF, resolved once here rather than at either end of
// it: ProductActions hands over a press's `pageX`/`pageY` (window space,
// unaffected by how far the grid has scrolled), and CheckoutBar's slip
// registers its own window-space centre the same way (fly-to-cart.ts's
// setSlipTarget). Both are converted to THIS view's own local space by
// subtracting its own window offset -- measured once, defensively, since
// `measureInWindow` is a real native method react-test-renderer's host
// instances do not implement, and every call here is optional-chained so a
// component that renders under Jest degrades to "no dot" instead of
// throwing. On a real device this view fills the same screen ShopChrome
// itself does, so its offset is ordinarily (0, 0) -- the conversion exists
// for the layouts (a laptop's centred reading column, a future nav header)
// where it is not.
export function FlyToCartLayer({ colors }: { colors: PaletteColors }) {
  const reducedMotion = useReducedMotion();
  const overlayRef = useRef<ViewType>(null);
  const overlayOffset = useRef<Point>({ x: 0, y: 0 });
  const [flying, setFlying] = useState(false);

  const progress = useSharedValue(0);
  const fromPoint = useSharedValue<Point>({ x: 0, y: 0 });
  const toPoint = useSharedValue<Point>({ x: 0, y: 0 });

  function handleLayout() {
    const node = overlayRef.current as unknown as {
      measureInWindow?: (cb: (x: number, y: number) => void) => void;
    } | null;
    node?.measureInWindow?.((x, y) => {
      overlayOffset.current = { x, y };
    });
  }

  useEffect(() => {
    function trigger(origin: Point) {
      // No target registered (the slip has never laid out -- see
      // fly-to-cart.ts's own comment on the very first Add of a session,
      // when the slip does not exist yet to fly to) or reduced motion is on:
      // no dot. The cart itself and CheckoutBar's own count-up/bump still
      // run either way -- they react to the cart's state, not to this.
      const target = getSlipTarget();
      if (!target || flyToCartMotion(reducedMotion) === 'jump') return;

      const offset = overlayOffset.current;
      fromPoint.value = { x: origin.x - offset.x, y: origin.y - offset.y };
      toPoint.value = { x: target.x - offset.x, y: target.y - offset.y };
      progress.value = 0;
      setFlying(true);
      progress.value = withTiming(
        1,
        { duration: ARC_DURATION_MS, easing: Easing.bezier(0.25, 0.6, 0.3, 1) },
        (finished) => {
          if (finished) runOnJS(setFlying)(false);
        },
      );
    }

    registerFlyTrigger(trigger);
    // `unregisterFlyTrigger`, not `registerFlyTrigger(null)` -- see that
    // function's own comment in fly-to-cart.ts. Comparing `trigger` (this
    // closure) against whatever is CURRENTLY registered is what stops an
    // outgoing ShopChrome's stale cleanup from wiping an incoming one's live
    // trigger during a route transition where both are briefly mounted.
    return () => unregisterFlyTrigger(trigger);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reducedMotion]);

  const dotStyle = useAnimatedStyle(() => {
    const point = arcPoint(fromPoint.value, toPoint.value, progress.value);
    const scale = arcScale(progress.value);
    return {
      opacity: arcOpacity(progress.value),
      transform: [
        { translateX: point.x - DOT_SIZE / 2 },
        { translateY: point.y - DOT_SIZE / 2 },
        { scale },
      ],
    };
  });

  return (
    <View ref={overlayRef} onLayout={handleLayout} style={StyleSheet.absoluteFill} pointerEvents="none">
      {flying ? (
        <Animated.View
          testID="storefront-fly-dot"
          style={[styles.dot, { backgroundColor: colors.accent }, dotStyle]}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  // `left`/`top` fixed at 0 -- ONLY `transform` (translateX/Y from the arc,
  // scale from arcScale) and `opacity` ever change, matching the branch's
  // transform/opacity-only guardrail.
  dot: {
    position: 'absolute', left: 0, top: 0, width: DOT_SIZE, height: DOT_SIZE, borderRadius: DOT_SIZE / 2,
  },
});
