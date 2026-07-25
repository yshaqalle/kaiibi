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
  },
} as const;

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
