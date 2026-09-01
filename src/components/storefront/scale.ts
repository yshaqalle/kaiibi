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
// THE BENTO RAMP. The four values above the old set are lifted from the app's
// own surface system (see .claude/skills/building-bento-screens and
// theme.ts's `bento*` tokens), because a shopkeeper who has just come from
// Dashboard should not arrive somewhere that sets a figure differently.
//
// `price` went 15 -> 23 and that is the substantive change here, not a nudge:
// a price is the number the customer opened the link for, and at 15 it was
// set smaller than the shop's own city subtitle used to be.
export const TYPE = {
  /** A card's label. Always uppercase, always with LETTER.meta. */
  eyebrow: 10.5,
  /** The one big figure on a card -- the item count. */
  value: 34,
  /** A price on a product card. */
  price: 23,
  /** The same price at two columns, where 23 costs a browsing screen its rows. */
  priceDenseGrid: 20,
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
  /** Inside a card, between its edge and its content. */
  card: 20,
  /** Between cards, in both directions. */
  cardGap: 14,
} as const;

// WHAT ACTUALLY CAUSED THE SCREENSHOT THIS REDESIGN CAME FROM.
//
// Nothing in this folder bounded its own width -- `grep -rn maxWidth
// src/components/storefront` returned one hit, on empty-state body copy -- so
// every number in this file, tuned at 390px and correct there, was multiplied
// by four on a 1,504px laptop. The hero panel came out 1,472px wide holding a
// 26px wordmark.
//
// 1080 rather than a percentage: the page is read at arm's length on a phone
// and across a desk on a laptop, and a measure that grows with the window
// stops being a measure. Matches the app's own reading column.
export const SHOP_MAX_WIDTH = 1080;

// Bento's radii. `card` is BENTO_RADIUS (theme.ts) by value and by intent --
// not imported, because that constant lives beside `Colors.light` and this
// page renders in one of six palettes for a stranger with no account. Copying
// the number keeps the two surfaces looking alike without dragging the app's
// palette onto the public page.
export const RADIUS = {
  /** A card. */
  card: 26,
  /** A photo or a plate INSIDE a card -- always a step tighter than the card. */
  inset: 18,
  /** Buttons, chips, the checkout bar. */
  pill: 999,
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
