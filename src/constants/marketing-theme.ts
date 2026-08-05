/**
 * Palette and metrics for Kaiibi's PUBLIC marketing surfaces only — the
 * landing page, the public nav and footer, and the login hero that stands in
 * for the landing page on native.
 *
 * Deliberately separate from `constants/theme.ts`'s `Colors`, which is the
 * PRODUCT's palette (accent `#E45B37`) and drives everything a signed-in shop
 * sees. The two are allowed to disagree: marketing sells, the app operates.
 * Nothing under `src/app/(admin)` may import this file.
 *
 * Values are the approved landing design's tokens verbatim, so a change here
 * is a deliberate brand change rather than a drift.
 */
export const Marketing = {
  ink: '#0B0B0D',
  ink2: '#1F2430',

  gray700: '#374151',
  gray500: '#6B7280',
  gray400: '#9CA3AF',
  gray200: '#E5E7EB',
  gray100: '#F3F4F6',
  gray50: '#F9FAFB',

  white: '#FFFFFF',
  line: '#E8E8EE',

  brand: '#0F9D58',
  brandDark: '#0A7D45',
  brandSoft: '#EAF7F0',
  brandBorder: '#CFE9DC',
  /** Readable green for text on `brandSoft` — the plain brand green isn't. */
  brandInk: '#146C47',

  blue: '#2F6BFF',
  blueSoft: '#EEF4FF',
  amber: '#F59E0B',
  amberSoft: '#FFFBEB',
  purple: '#7C4DFF',
  teal: '#00B8A9',
  red: '#D92D3F',
} as const;

export const MarketingRadius = {
  sm: 10,
  md: 16,
  lg: 24,
  pill: 999,
} as const;

export const MarketingLayout = {
  /** The design's `--maxw`. Content wider than this centres inside it. */
  maxWidth: 1140,
  gutter: 24,
  /** Below this the nav collapses to a hamburger and the hero stacks. */
  compactBreakpoint: 940,
  /** Below this the plan cards and footer columns go single-file. */
  narrowBreakpoint: 560,
} as const;

// RN shadow props rather than the newer `boxShadow` string: react-native-web
// maps these reliably, and the string form's typings are less certain on RN
// 0.86. `elevation` is Android's separate channel for the same intent.
export const MarketingShadow = {
  shadowColor: '#000000',
  shadowOpacity: 0.06,
  shadowRadius: 3,
  shadowOffset: { width: 0, height: 1 },
  elevation: 1,
} as const;

export const MarketingShadowLg = {
  shadowColor: '#000000',
  shadowOpacity: 0.12,
  shadowRadius: 50,
  shadowOffset: { width: 0, height: 20 },
  elevation: 12,
} as const;
