import { type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import Svg, { Path } from 'react-native-svg';

import { Marketing, MarketingRadius, MarketingShadow } from '@/constants/marketing-theme';
import { FONT_SCALE } from '@/lib/clamp-font';

// Shared pieces for the marketing surfaces. Everything here reads
// constants/marketing-theme.ts and nothing reads constants/theme.ts — see the
// header comment there for why the two palettes are separate.
//
// Note what is NOT set anywhere in this folder: `fontFamily`. React Native
// Web's default body stack is byte-for-byte the approved design's
// (`-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, ...`), so passing
// `Fonts.sans` would swap in Spline Sans and change the design. Leaving it
// unset is the deliberate choice, not an omission.

/** The K monogram, from the design's own favicon path. */
export function KaiibiMark({ size = 20, color = Marketing.white }: { size?: number; color?: string }) {
  // 100x120 viewBox, so height leads and width follows to keep it undistorted.
  return (
    <Svg width={(size * 100) / 120} height={size} viewBox="0 0 100 120">
      <Path
        fill={color}
        fillRule="evenodd"
        d="M12,8 H38 V52 L72,8 H96 L57,58 L98,112 H72 L38,70 V112 H12 Z M19,16 H31 V104 H19 Z M49.2,46.9 L76.2,11.9 L81.8,16.1 L54.8,51.1 Z M49.6,72.5 L77.3,107.9 L82.9,103.5 L55.2,68.1 Z"
      />
    </Svg>
  );
}

/** Mark in its rounded tile, as the nav and footer wordmark use it. */
export function KaiibiLockup({ tone = 'dark', size = 19 }: { tone?: 'dark' | 'light'; size?: number }) {
  const onDark = tone === 'light';
  return (
    <View style={styles.lockup}>
      <View style={[styles.lockupTile, onDark && styles.lockupTileOnDark]}>
        <KaiibiMark size={size} color={onDark ? Marketing.white : Marketing.white} />
      </View>
      <Text style={[styles.lockupText, onDark && styles.lockupTextOnDark]}>Kaiibi</Text>
    </View>
  );
}

type BtnVariant = 'primary' | 'ghost' | 'white' | 'outlineLight';

/**
 * The design's four button treatments.
 *
 * `onHoverIn`/`onHoverOut` are how react-native-web surfaces hover; they no-op
 * harmlessly on native. Kept on real buttons only — the static feature and plan
 * cards deliberately don't lift on hover, because wrapping nine non-interactive
 * cards in a Pressable would add phantom press targets and screen-reader noise
 * for a shadow.
 */
export function Btn({
  label,
  onPress,
  variant = 'primary',
  size = 'md',
  fullWidth,
  style,
}: {
  label: string;
  onPress?: () => void;
  variant?: BtnVariant;
  size?: 'md' | 'lg';
  fullWidth?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      style={({ pressed, hovered }) => [
        styles.btn,
        size === 'lg' ? styles.btnLg : styles.btnMd,
        VARIANT_BOX[variant],
        fullWidth && styles.btnFull,
        hovered && VARIANT_HOVER[variant],
        pressed && styles.btnPressed,
        style,
      ]}
    >
      <Text style={[styles.btnText, size === 'lg' && styles.btnTextLg, VARIANT_TEXT[variant]]} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

const VARIANT_BOX: Record<BtnVariant, ViewStyle> = {
  primary: { backgroundColor: Marketing.ink },
  ghost: { backgroundColor: 'transparent', borderWidth: 1, borderColor: Marketing.line },
  white: { backgroundColor: Marketing.white },
  outlineLight: { backgroundColor: 'transparent', borderWidth: 1, borderColor: 'rgba(255,255,255,0.35)' },
};

const VARIANT_HOVER: Record<BtnVariant, ViewStyle> = {
  primary: { backgroundColor: Marketing.ink2 },
  ghost: { backgroundColor: Marketing.gray50 },
  white: { backgroundColor: Marketing.gray50 },
  outlineLight: { backgroundColor: 'rgba(255,255,255,0.1)' },
};

const VARIANT_TEXT = StyleSheet.create({
  primary: { color: Marketing.white },
  ghost: { color: Marketing.ink },
  white: { color: Marketing.ink },
  outlineLight: { color: Marketing.white },
});

/** The small uppercase pill that heads each section. */
export function Tag({ label }: { label: string }) {
  return (
    <View style={styles.tag}>
      <Text style={styles.tagText}>{label}</Text>
    </View>
  );
}

/** Centred tag + heading + optional lede, as every section below the hero uses. */
export function SectionHead({
  tag,
  title,
  body,
  width,
}: {
  tag: string;
  title: string;
  body?: string;
  width: number;
}) {
  return (
    <View style={styles.sectionHead}>
      <Tag label={tag} />
      <Text style={[styles.sectionTitle, { fontSize: FONT_SCALE.h2(width) }]}>{title}</Text>
      {body ? <Text style={styles.sectionBody}>{body}</Text> : null}
    </View>
  );
}

/** The plain bordered card the feature grid and plan columns sit in. */
export function Card({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[styles.card, style]}>{children}</View>;
}

/**
 * A wrapped-flex stand-in for CSS grid.
 *
 * RN has no grid, and `gap` fights percentage widths — a row of three 33.333%
 * children plus a gap overflows. The negative-margin/padding technique gives
 * exact columns with true gutters instead.
 */
export function gridRowStyle(gutter: number): ViewStyle {
  return { flexDirection: 'row', flexWrap: 'wrap', marginHorizontal: -gutter / 2 };
}

export function gridCellStyle(columns: number, gutter: number): ViewStyle {
  return { width: `${100 / columns}%`, paddingHorizontal: gutter / 2, paddingBottom: gutter };
}

const styles = StyleSheet.create({
  lockup: { flexDirection: 'row', alignItems: 'center', gap: 11 },
  lockupTile: {
    width: 38,
    height: 38,
    borderRadius: 11,
    backgroundColor: Marketing.ink,
    alignItems: 'center',
    justifyContent: 'center',
  },
  lockupTileOnDark: { backgroundColor: 'rgba(255,255,255,0.13)' },
  lockupText: { fontSize: 19, fontWeight: '800', letterSpacing: -0.4, color: Marketing.ink },
  lockupTextOnDark: { color: Marketing.white },

  btn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderRadius: MarketingRadius.pill,
  },
  btnMd: { paddingVertical: 13, paddingHorizontal: 26 },
  btnLg: { paddingVertical: 16, paddingHorizontal: 32 },
  btnFull: { alignSelf: 'stretch' },
  btnPressed: { opacity: 0.82 },
  btnText: { fontSize: 14.5, fontWeight: '700' },
  btnTextLg: { fontSize: 15.5 },

  tag: {
    alignSelf: 'center',
    backgroundColor: Marketing.gray100,
    borderRadius: MarketingRadius.pill,
    paddingVertical: 6,
    paddingHorizontal: 14,
    marginBottom: 16,
  },
  tagText: {
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    color: Marketing.gray700,
  },

  sectionHead: { alignItems: 'center', maxWidth: 660, alignSelf: 'center', marginBottom: 50 },
  sectionTitle: {
    lineHeight: 44,
    letterSpacing: -1,
    fontWeight: '800',
    color: Marketing.ink,
    textAlign: 'center',
  },
  sectionBody: {
    color: Marketing.gray500,
    fontSize: 16.5,
    lineHeight: 26,
    marginTop: 14,
    textAlign: 'center',
  },

  card: {
    backgroundColor: Marketing.white,
    borderWidth: 1,
    borderColor: Marketing.line,
    borderRadius: MarketingRadius.lg,
    padding: 28,
    ...MarketingShadow,
  },
});
