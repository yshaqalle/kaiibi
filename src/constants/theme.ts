/**
 * Below are the colors that are used in the app. The colors are defined in the light and dark mode.
 * There are many other ways to style your app. For example, [Nativewind](https://www.nativewind.dev/), [Tamagui](https://tamagui.dev/), [unistyles](https://reactnativeunistyles.vercel.app), etc.
 */

import '@/global.css';

import { Platform } from 'react-native';

export const Colors = {
  light: {
    text: '#17261F',
    textPrimary: '#17261F',
    textSecondary: '#5A665F',
    background: '#FAF9F5',
    backgroundElement: '#F0F0F3',
    backgroundSelected: '#E0E1E6',
    surface: '#FFFFFF',
    surfaceMuted: '#EEF2EB',
    border: '#EFEEE9',
    accent: '#E45B37',
    ownerAccentDark: '#17261F',
    success: '#438254',
    warning: '#D27631',
    danger: '#C0392B',
    green: '#47705C',
    greenDark: '#31533A',
    // Categorical chart series (e.g. payment-method mix) — a validated 4-hue
    // set (dataviz skill: OKLab CVD separation + contrast), kept distinct
    // from `accent`/status colors so a chart series never impersonates them.
    chartSeries1: '#2a78d6',
    chartSeries2: '#1baf7a',
    chartSeries3: '#eda100',
    chartSeries4: '#e87ba4',
    // ---- Bento surfaces (see docs/design/dashboard-mockup.html) ----
    //
    // The cool-grey/white world the Dashboard, Accounting and People have been
    // converted to. Deliberately NOT a replacement for `background` /
    // `surface` / `border` above: POS, Inventory and Settings still read those
    // and stay cream until each is converted on purpose. Two palettes coexist
    // during the conversion; that is the agreed interim state, not an
    // oversight.
    //
    // Modals are a third case, not yet decided: every one in the app still
    // wears the stock white-card treatment, including the ones People opens.
    bentoPage: '#f4f4f5',
    bentoSurface: '#ffffff',
    bentoInk: '#0b0b0d',
    bentoInk2: '#1a1a1e',
    bentoMuted: '#8b8b93',
    bentoMuted2: '#a8a8b0',
    bentoLine: '#ececf0',
    bentoSoft: '#f6f6f7',
    // Categorical series for bento charts. The source mockup's own hues
    // could not ship: its blue and purple sit at ΔE 0.1 for deutan viewers
    // and ΔE 10.2 for normal vision, under the floor of 15. These are the
    // same blue-led family re-stepped until all six checks pass, verified
    // with the dataviz validator against BOTH #ffffff and the dark surface
    // below -- so one set serves either ground.
    bentoSeries1: '#2f6bff',
    bentoSeries2: '#00a396',
    bentoSeries3: '#c8791a',
    bentoSeries4: '#d4457e',
    // Status, not series. Green/red is ΔE 4.0 for deutan viewers -- the
    // classic red/green trap -- so anything wearing these MUST also carry a
    // signed figure or a direction glyph. The waterfall labels every bar and
    // StatementRow prints the minus sign; that labelling is load-bearing.
    bentoProfit: '#0f9d58',
    bentoLoss: '#d92d3f',
    // Single-hue mark color for magnitude/trend charts (line, bars,
    // sparklines) — same blue as `chartSeries1`, the reference palette's
    // designated sequential default. Kept as its own name so single-series
    // chart code doesn't read "categorical slot 1" for what is, there, just
    // "the chart's ink." Deliberately not `accent`: that orange is reserved
    // for actionable UI (buttons, selected states), so data ink and
    // call-to-action never share a hue.
    chartAccent: '#2a78d6',
  },
  dark: {
    text: '#ffffff',
    textPrimary: '#ffffff',
    textSecondary: '#B0B4BA',
    background: '#000000',
    backgroundElement: '#212225',
    backgroundSelected: '#2E3135',
    surface: '#161816',
    surfaceMuted: '#1E211D',
    border: '#2A2D28',
    accent: '#E45B37',
    ownerAccentDark: '#FFFFFF',
    success: '#5CAE6E',
    warning: '#E08A46',
    danger: '#E0655A',
    green: '#6FA085',
    greenDark: '#5A8A6C',
    chartSeries1: '#3987e5',
    chartSeries2: '#199e70',
    chartSeries3: '#c98500',
    chartSeries4: '#d55181',
    chartAccent: '#3987e5',
    // Mirrors of the bento tokens above. Nothing reads these yet -- the app
    // pins Colors.light everywhere -- but ThemeColor is the INTERSECTION of
    // the two key sets, so a token missing here silently drops out of the
    // type. Kept in step so that stays honest.
    //
    // Chosen against the dark surface, not flipped from light: the series
    // hues are unchanged because they already pass all six checks on
    // #17171c, and re-stepping them would have cost separation for nothing.
    bentoPage: '#0e0e11',
    bentoSurface: '#17171c',
    bentoInk: '#f2f2f5',
    bentoInk2: '#c9c9d2',
    bentoMuted: '#8a8a94',
    bentoMuted2: '#6f6f78',
    bentoLine: '#26262e',
    bentoSoft: '#1e1e24',
    bentoSeries1: '#2f6bff',
    bentoSeries2: '#00a396',
    bentoSeries3: '#c8791a',
    bentoSeries4: '#d4457e',
    bentoProfit: '#2eb872',
    bentoLoss: '#e8515f',
  },
} as const;

/** Card radius for the bento surfaces. The stock `Card` stays at 12. */
export const BENTO_RADIUS = 26;

export type ThemeColor = keyof typeof Colors.light & keyof typeof Colors.dark;

export const Fonts = Platform.select({
  ios: {
    /** iOS `UIFontDescriptorSystemDesignDefault` */
    sans: 'system-ui',
    /** iOS `UIFontDescriptorSystemDesignSerif` */
    serif: 'ui-serif',
    /** iOS `UIFontDescriptorSystemDesignRounded` */
    rounded: 'ui-rounded',
    /** iOS `UIFontDescriptorSystemDesignMonospaced` */
    mono: 'ui-monospace',
  },
  default: {
    sans: 'normal',
    serif: 'serif',
    rounded: 'normal',
    mono: 'monospace',
  },
  web: {
    sans: 'var(--font-display)',
    serif: 'var(--font-serif)',
    rounded: 'var(--font-rounded)',
    mono: 'var(--font-mono)',
  },
});

export const Spacing = {
  half: 2,
  one: 4,
  two: 8,
  three: 16,
  four: 24,
  five: 32,
  six: 64,
} as const;

export const BottomTabInset = Platform.select({ ios: 50, android: 80 }) ?? 0;
export const MaxContentWidth = 800;
