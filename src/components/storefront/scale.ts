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
//   * name 19 -- Market's. Window's 15 was the smallest thing on a page whose
//     whole job is announcing whose shop it is, and a customer arriving on a
//     forwarded WhatsApp link needs that first. Window keeps its UPPERCASE
//     tracking treatment at the shared size: the treatment belongs to the
//     theme, the size does not.
//   * headline 22, with Window alone at 28 -- Window is deliberately the loud
//     one, that is what a shop picks it for. Counter's 19 was a third value
//     with no argument behind it.
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
  /** The hero headline everywhere except Window. */
  headline: 22,
  /** Window's hero only -- the one theme that leads with a statement. */
  headlineLoud: 28,
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
