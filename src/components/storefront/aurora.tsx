import { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import Animated, {
  cancelAnimation, Easing, interpolate, useAnimatedStyle, useSharedValue, withRepeat, withTiming,
  type SharedValue,
} from 'react-native-reanimated';

import { parseHex } from '@/lib/contrast';
import type { PaletteColors } from '@/lib/storefront-catalog';

// THE PHOTOLESS ANCHOR'S COUNTERPART TO THE HERO SCRIM.
//
// Task 12 established that the hero's gradient scrim (ShopAnchor's own
// `onPhoto` branch, theme-shared.tsx) renders ONLY when `heroImageUrl` is
// set. This is the same branch's mirror: three soft, drifting washes of the
// shop's own accent colour, painted behind the anchor card's text, ONLY
// while there is no photo to show instead. A shop that uploads a hero photo
// loses the aurora the same render it gains the photo -- there is exactly
// one branch (ShopAnchor's `!onPhoto`) that can ever mount this component,
// mirroring the belt theme-shared.tsx's own comment on the scrim describes.
//
// TWO THINGS THE PLAN NAMES BUT DOES NOT SOLVE, ANSWERED HERE:
//
// 1. "Blurred radial blobs" is not literally buildable. `expo-linear-
//    gradient` is the one permitted dependency and it draws LINEAR
//    gradients only; `expo-blur` is explicitly forbidden on this branch.
//    So each "blob" here is a plain View clipped to a circle
//    (`borderRadius: size/2`) with a linear gradient fading across it on a
//    different angle -- a soft-edged disc of colour rather than a true
//    radial glow, and with no blur at all (a hard edge exists at the
//    circle's own boundary, softened only by the fade already reaching
//    near-zero alpha before it gets there). Three of these, overlapping at
//    different positions/angles/alphas, read as an ambient wash from a
//    normal viewing distance -- the honest approximation the brief asks
//    for, not the literal effect.
//
// 2. "The palette's own accent family" is derived from `colors.accent`
//    alone -- PaletteColors exposes exactly one accent hue per palette, not
//    a spread of related ones, and inventing two more hues out of nowhere
//    per palette would be a hex literal wearing a costume, not a "family".
//    So the family here is the SAME accent hue at three different alphas
//    and positions -- literally palette-derived, in the sense the
//    guardrail table demands ("palette-derived only"), rather than three
//    fixed blues borrowed from the mockup's own (Ink-only) hard-coded CSS.
//
// WHY THIS IS CHEAP ENOUGH TO RUN FOREVER (the one animation on this whole
// page that does not run once): every blob's motion is `useAnimatedStyle`
// reading ONE shared value (`t`, below) and computing a `transform` from
// plain-number `interpolate` calls -- no layout property is ever touched,
// no React state changes per frame, and nothing re-renders. `t` itself is
// driven by a single `withRepeat(withTiming(...))` scheduled ONCE, entirely
// on Reanimated's UI thread -- the JS thread is not involved again until
// the component unmounts (`cancelAnimation` in the effect's cleanup). Three
// small Views with a `LinearGradient` each is the entire native cost; there
// is no image to decode, no blur kernel, and no bridge traffic for the
// whole 14s loop, which is the actual reason this can be exempted from
// "every other animation on this page runs once" without paying for it on
// the low-end Android this product targets.
export function auroraMotion(hasPhoto: boolean, reducedMotion: boolean): 'loop' | 'static' | 'none' {
  if (hasPhoto) return 'none';
  return reducedMotion ? 'static' : 'loop';
}

// Converts a palette hex token to an rgba() string at a given alpha,
// without inventing a new colour -- `parseHex` is the same hex reader
// contrast.ts already exports and storefront-catalog.ts's own contrast
// checks run through, so this reads the SAME six-digit value `colors.accent`
// already is rather than parsing it a second, divergent way. Falls back to
// the hex itself (fully opaque) if it somehow fails to parse -- fail open to
// a solid wash rather than a crash, since a палette hex has already passed
// through storefront-catalog's own tests by the time it reaches here.
export function withAlpha(hex: string, alpha: number): string {
  const rgb = parseHex(hex);
  const clamped = Math.max(0, Math.min(1, alpha));
  if (!rgb) return hex;
  return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${clamped})`;
}

// The ≤50% opacity ceiling the guardrail table sets, applied at the
// strongest blob -- the other two sit under it, so the ceiling is never a
// per-blob cap so much as a peak the composite never exceeds by eye.
const AURORA_OPACITY_CEILING = 0.5;
const LOOP_DURATION_MS = 14000;

type BlobSpec = {
  top: `${number}%`; left: `${number}%`; size: `${number}%`; alpha: number; angle: number;
  driftX: number; driftY: number; driftRotate: number; driftScale: number;
};

// Position/angle/drift are hand-placed (not derived from anything), the
// same way the mockup's own three `radial-gradient(... at X% Y%)` stops
// are -- three overlapping discs read as one ambient field only if they are
// not concentric or identically sized.
//
// `size` is a PERCENTAGE of the card, not a fixed pixel count -- matching
// the mockup's own `.aur{inset:-40%}` (itself percentage-based) and, on
// this branch specifically, required by
// storefront-theme-header-overflow.test.tsx's own structural guardrail:
// nothing inside the header may carry a fixed pixel `width` a 320px phone
// could not hold. These blobs are absolutely positioned and clipped by the
// anchor card's own `overflow:'hidden'`, so a fixed width could never
// actually force the header to overflow -- but the test's own heuristic
// cannot tell "decorative and clipped" from "a real box" apart, and a
// percentage width is both the correct fix (it scales with the card
// instead of ever looking too large on a narrow phone) and the one the
// test already exempts.
const BLOBS: BlobSpec[] = [
  { top: '4%', left: '2%', size: '78%', alpha: AURORA_OPACITY_CEILING, angle: 40, driftX: 20, driftY: 16, driftRotate: 10, driftScale: 0.1 },
  { top: '42%', left: '46%', size: '68%', alpha: 0.34, angle: 135, driftX: -18, driftY: 18, driftRotate: -12, driftScale: 0.12 },
  { top: '0%', left: '38%', size: '58%', alpha: 0.26, angle: 205, driftX: 14, driftY: -12, driftRotate: 7, driftScale: 0.08 },
];

function gradientEndpoints(angleDegrees: number) {
  const rad = (angleDegrees * Math.PI) / 180;
  return {
    start: { x: 0.5 - Math.cos(rad) / 2, y: 0.5 - Math.sin(rad) / 2 },
    end: { x: 0.5 + Math.cos(rad) / 2, y: 0.5 + Math.sin(rad) / 2 },
  };
}

function Blob({ spec, colors, t }: { spec: BlobSpec; colors: PaletteColors; t: SharedValue<number> }) {
  // `t` ping-pongs 0 -> 1 -> 0 (withRepeat's own reverse, wired in Aurora
  // below) -- interpolate reads it directly, so every blob shares the same
  // clock without three independent timers drifting out of phase with each
  // other over a long session.
  const style = useAnimatedStyle(() => ({
    transform: [
      { translateX: interpolate(t.value, [0, 1], [0, spec.driftX]) },
      { translateY: interpolate(t.value, [0, 1], [0, spec.driftY]) },
      { rotate: `${interpolate(t.value, [0, 1], [0, spec.driftRotate])}deg` },
      { scale: interpolate(t.value, [0, 1], [1, 1 + spec.driftScale]) },
    ],
  }));
  const { start, end } = gradientEndpoints(spec.angle);
  return (
    <Animated.View
      style={[
        styles.blob,
        // `borderRadius: 9999`, not `size / 2` -- `size` is now a percentage
        // STRING (see BLOBS' own comment), and RN clips any borderRadius
        // larger than half the rendered box to that box's own actual size
        // regardless of units, so a fixed large radius still yields a true
        // circle at whatever pixel size the percentage resolves to.
        { top: spec.top, left: spec.left, width: spec.size, height: spec.size, borderRadius: 9999 },
        style,
      ]}
    >
      <LinearGradient colors={[withAlpha(colors.accent, spec.alpha), 'transparent']} start={start} end={end} style={StyleSheet.absoluteFill} />
    </Animated.View>
  );
}

// `reducedMotion` is a prop, not read from `useReducedMotion()` here --
// ShopAnchor (theme-shared.tsx) already calls that hook for the wordmark
// rise and hands the same value down, so every entering/looping decision on
// one render of the anchor agrees with every other.
export function Aurora({ colors, reducedMotion }: { colors: PaletteColors; reducedMotion: boolean }) {
  const motion = auroraMotion(false, reducedMotion);
  const t = useSharedValue(0);

  useEffect(() => {
    if (motion !== 'loop') return undefined;
    // `-1` repeats forever, `true` reverses each lap (ping-pong) -- the
    // mockup's own `infinite alternate`, so the blobs ease back through the
    // same path rather than snapping to the start every 14s.
    t.value = withRepeat(withTiming(1, { duration: LOOP_DURATION_MS, easing: Easing.inOut(Easing.ease) }), -1, true);
    return () => cancelAnimation(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- t is a stable shared-value ref
  }, [motion]);

  if (motion === 'none') return null;

  if (motion === 'static') {
    // ONE wash, not three, and never animated -- the brief's own "a single
    // static radial" under reduced motion. Centred and oversized (inset
    // -20% on every side) so its own soft edge never reads as a hard-edged
    // circle sitting inside the card.
    return (
      <View style={StyleSheet.absoluteFill} pointerEvents="none" testID="storefront-aurora-static">
        <LinearGradient
          colors={[withAlpha(colors.accent, AURORA_OPACITY_CEILING * 0.7), 'transparent']}
          start={{ x: 0.5, y: 0.1 }}
          end={{ x: 0.5, y: 1 }}
          style={styles.staticBlob}
        />
      </View>
    );
  }

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none" testID="storefront-aurora">
      {BLOBS.map((spec, i) => (
        <Blob key={i} spec={spec} colors={colors} t={t} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  blob: { position: 'absolute', overflow: 'hidden' },
  staticBlob: { position: 'absolute', top: '-20%', left: '-20%', right: '-20%', bottom: '-20%', borderRadius: 999 },
});
