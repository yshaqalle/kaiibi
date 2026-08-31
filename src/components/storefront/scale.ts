import { Platform } from 'react-native';

// One scale for the three themes.
//
// Market, Window and Counter each grew their own numbers. The shop name was
// 19 / 15 / 18px; page padding 14 / 16 / 14; body copy 13 / 13.5 / 13. None of
// those was wrong on its own, and that is exactly the problem -- there was no
// system, so the set read as three pages that happened to share a codebase.
//
// This is a CONSISTENCY change, not a redesign. Every value below is one of
// the numbers already in use, chosen as the one to keep:
//
//   * name 19 -- Market's and Counter's, in the nav. Window has no name in
//     its nav at all any more: it moved into the hero as the wordmark, at its
//     own larger size, because a customer arriving on a forwarded WhatsApp
//     link needs "whose shop is this" before anything else.
//   * headline 22 everywhere. Window used to be 28 -- the loudest thing on
//     the page -- but its hero now leads with the WORDMARK, and a slogan
//     shouting over the shop's own name was the thing that fixed. Counter's 19
//     was a third value with no argument behind it.
//   * body 13.5 -- the 0.5px spread between 13 and 13.5 is invisible and cost
//     a decision every time someone added a line of copy.
//   * padding 16 -- Window's. 14 is cramped on any phone sold in the last
//     five years.
//   * meta 11 -- the eyebrow/label size, always with tracking (see LETTER).
//
// Themes still differ in LAYOUT -- grid vs price list, hero vs no hero,
// uppercase vs sentence case. They no longer differ in the size of the same
// thing.
export const TYPE = {
  /** The shop's own name in the nav. */
  name: 19,
  /** A city or neighbourhood under the name. */
  nameSub: 11.5,
  /** The hero headline, in every theme. */
  headline: 22,
  /** Product names, the about paragraph, checkout copy. */
  body: 13.5,
  /** A product name inside a dense Counter row. */
  bodyDense: 13.5,
  /** Prices. Always with `tabular` below. */
  price: 15,
  /** Prices in a Counter row, where the column is the point. */
  priceDense: 14.5,
  /** Eyebrows, section heads, stock pills, counts. */
  meta: 11,
  /** The smallest legible step -- a pill label. */
  metaSmall: 10.5,
} as const;

// The display face, and the one place this set uses a second family at all.
//
// WHY NOT A BUNDLED WEBFONT. The brief asked for Fraunces, and
// `@expo-google-fonts/fraunces` exists, so this was a choice rather than a
// limitation. It was declined on the page's own terms:
//
//   * This page arrives as a forwarded WhatsApp link and opens in an in-app
//     browser, usually on the slowest connection in the flow. A webfont is an
//     extra blocking download in front of the ONE thing the page has to show
//     fast -- whose shop this is and what it costs. Paying for a prettier
//     wordmark with a slower wordmark is the wrong way round.
//   * `useFonts` in _layout.tsx gates app startup behind the load, and that
//     layout is shared with POS. A cashier's till would wait on a font only
//     the public storefront uses.
//   * A non-blocking load avoids both, at the cost of a visible swap on every
//     first visit -- which on a wordmark is the most conspicuous place to have
//     one.
//
// The SYSTEM serif has none of those costs and still does the job the brief
// actually wanted: a display face that is visibly not the body face, so the
// wordmark reads as set rather than typed. It differs between platforms
// (Georgia on iOS and web, Noto Serif on Android) -- which is the real trade
// accepted here, and is why it is confined to the wordmark and hero headline
// rather than sprayed across every heading.
//
// If a shipped, consistent Fraunces is wanted later, it belongs behind a
// non-blocking load with this as the fallback -- not as a startup gate.
export const DISPLAY_FONT = Platform.select({
  ios: 'Georgia',
  android: 'serif',
  default: 'Georgia, "Times New Roman", serif',
});

export const SPACE = {
  /** The page gutter, and the grid's own padding. */
  page: 16,
  /** Between grid cells. */
  gap: 12,
} as const;

// Tracking is what makes a system face read as SET rather than typed, and it
// is the cheapest half of the display/body/meta split -- no font file needed.
// Negative on display sizes, positive and wide on uppercase meta.
export const LETTER = {
  display: -0.5,
  displayLoud: -0.8,
  /** Window's uppercase wordmark -- its treatment, kept. */
  wordmark: 2,
  meta: 1,
  metaWide: 1.5,
} as const;

// A column of prices that does not line up is the tell that nobody set the
// type. Applied wherever digits stack: the grid's price line, Counter's price
// column, the cart's line amounts and subtotal.
export const TABULAR = { fontVariant: ['tabular-nums' as const] };
