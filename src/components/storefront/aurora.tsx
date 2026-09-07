import { StyleSheet, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';

import { parseHex } from '@/lib/contrast';
import type { PaletteColors } from '@/lib/storefront-catalog';

// THE PHOTOLESS ANCHOR'S COUNTERPART TO THE HERO SCRIM.
//
// Task 12 established that the hero's gradient scrim (ShopAnchor's own
// `onPhoto` branch, theme-shared.tsx) renders ONLY when `heroImageUrl` is
// set. This is the same branch's mirror: a soft wash of the shop's own
// accent colour, painted behind the anchor card's text, ONLY while there is
// no photo to show instead. A shop that uploads a hero photo loses the
// aurora the same render it gains the photo -- there is exactly one branch
// (ShopAnchor's `!onPhoto`) that can ever mount this component, mirroring
// theme-shared.tsx's own comment on the scrim describes.
//
// STATIC, NOT ANIMATED. This used to run three rotating, scaling, clipped
// gradient blobs on a 14s `withRepeat` loop forever, on the reasoning that
// each blob was cheap (no image decode, no blur, no bridge traffic). It
// still was not free: a clipped (`overflow:'hidden'`), rounded
// (`borderRadius`), gradient-filled layer being rotated and scaled forces a
// fresh GPU clip-path composite every single frame, paid on the cheapest
// phones this product targets, forever, for a purely decorative fallback a
// shop sees only until it uploads one photo. The one-wash render below --
// what used to be the reduced-motion-only branch -- is the entire aurora
// now: no shared value, no scheduled loop, nothing to cancel on unmount.
export function auroraMotion(hasPhoto: boolean): 'static' | 'none' {
  return hasPhoto ? 'none' : 'static';
}

// Converts a palette hex token to an rgba() string at a given alpha,
// without inventing a new colour -- `parseHex` is the same hex reader
// contrast.ts already exports and storefront-catalog.ts's own contrast
// checks run through, so this reads the SAME six-digit value `colors.accent`
// already is rather than parsing it a second, divergent way. Falls back to
// the hex itself (fully opaque) if it somehow fails to parse -- fail open to
// a solid wash rather than a crash, since a palette hex has already passed
// through storefront-catalog's own tests by the time it reaches here.
export function withAlpha(hex: string, alpha: number): string {
  const rgb = parseHex(hex);
  const clamped = Math.max(0, Math.min(1, alpha));
  if (!rgb) return hex;
  return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${clamped})`;
}

// The ≤50% opacity ceiling the guardrail table sets.
const AURORA_OPACITY_CEILING = 0.5;

export function Aurora({ colors }: { colors: PaletteColors }) {
  const motion = auroraMotion(false);
  if (motion === 'none') return null;

  // ONE wash, centred and oversized (inset -20% on every side) so its own
  // soft edge never reads as a hard-edged circle sitting inside the card.
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

const styles = StyleSheet.create({
  staticBlob: { position: 'absolute', top: '-20%', left: '-20%', right: '-20%', bottom: '-20%', borderRadius: 999 },
});
