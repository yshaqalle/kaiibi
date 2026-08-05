// The CSS `clamp(min, Nvw, max)` idiom the marketing headings use, as a plain
// function of viewport width.
//
// Lives in lib/ rather than beside the components for the usual reason (see
// location-selection.ts): it is arithmetic, it is easy to get subtly wrong, and
// the mistake is invisible until someone opens a 320px phone or a 27" monitor.
// React Native has no viewport units, so this is the only place the scaling
// happens.

export function clampFont(min: number, vwFactor: number, max: number, width: number): number {
  return Math.min(max, Math.max(min, width * vwFactor));
}

// The design's three clamped sizes, so a caller passes one name rather than
// three magic numbers that must match the approved page.
export const FONT_SCALE = {
  /** `clamp(34px, 5vw, 54px)` — the hero headline. */
  h1: (width: number) => clampFont(34, 0.05, 54, width),
  /** `clamp(27px, 3.6vw, 38px)` — section headings. */
  h2: (width: number) => clampFont(27, 0.036, 38, width),
  /** `clamp(28px, 4vw, 42px)` — the stats band figures. */
  stat: (width: number) => clampFont(28, 0.04, 42, width),
} as const;
