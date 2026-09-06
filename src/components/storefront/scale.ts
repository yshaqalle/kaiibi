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
// 1080 -> 1320 (2026-09-05): 1080 matched the phone-era reading column and
// left a 1,600px window mostly gutter. 1320 is the admin shell's own desktop
// ceiling, so the shop and the app now agree on how wide "wide" is. Still a
// fixed number rather than a percentage -- a measure that grows with the
// window stops being a measure.
//
// THE GRID STOPPED READING THIS (2026-09-06): the goods grid was the one
// user this constant never should have had. DIRECTORY_MAX_WIDTH below
// already makes the argument -- a grid of cards, scanned across, is not a
// reading column and gains a column when it grows rather than losing one --
// for the store DIRECTORY's own grid; Task C applies the identical argument
// here. ThemeMarket and ThemeWindow's goods FlatList no longer sits inside
// this bound at all: it fills the window, less the page's own padding (see
// each theme's own `scroller`/`column` split), and gridColumnsForWidth grew
// five new rungs above 1280 so a tile stays roughly its designed size
// instead of five of them stretching to fill whatever the monitor allows.
//
// What still reads this constant on the shop page: the header (the three
// shop cards, search, the category band) and the footer -- both blocks of
// TEXT and short facts, never scanned the way a tile grid is, and the
// header specifically carries the one real paragraph on this tab (the
// anchor's own `about` copy) that PROSE_MAX_WIDTH's argument already covers.
// Keeping them at 1320 rather than letting them widen with the grid is a
// choice, not an oversight: a shopkeeper's headline and the collect/stock
// facts beside it were never the thing a wide monitor's empty gutters were
// about, and widening them today would only be trading one unread margin of
// whitespace for a name and a phone number spread across a 2,560px card.
export const SHOP_MAX_WIDTH = 1320;

// THE PANEL GETS ITS OWN MEASURE, NARROWER THAN THE GRID -- the same argument
// shop-directory-card.tsx makes for DIRECTORY_MAX_WIDTH, run the other way.
//
// The 1080 -> 1320 move above was reasoned about the GRID: a fifth column of
// goods, scanned across, which is right to keep growing toward whatever fits
// one more tile. shop-chrome.tsx bounds the About/Visit panel scroller by
// that same SHOP_MAX_WIDTH, and neither about-panel.tsx nor visit-panel.tsx
// bounds its own text (`grep -n maxWidth` on both returns nothing) -- so the
// widening the grid asked for also widened a page of PROSE that was never
// part of the argument, from roughly 1040px of measure to 1280px, which on a
// paragraph is not more room, it is a line nobody's eye can track back to its
// start.
//
// A grid gains a column when it grows; a sentence only gets harder to read.
// Two different questions, so two constants -- and this one is not a
// fraction of SHOP_MAX_WIDTH, because a fraction would keep them coupled and
// they have already needed to move independently once (1080 -> 1320 changed
// the grid's answer and should have changed nothing about the sentence's).
//
// 820 is picked the way a reading column is picked -- a comfortable line
// length for body text -- not derived from anything else in this file.
export const PROSE_MAX_WIDTH = 820;

// A SHEET GETS ITS OWN MEASURE, NARROWER THAN EITHER OF THE TWO ABOVE.
//
// This is the number that produced the defect it exists to fix: the product
// sheet had no width bound at all, so on a 1512px window it spanned the whole
// window and a 4:3 photo took 4:3 OF THAT -- over a thousand pixels tall,
// with the name, the price and the buy button shoved off the bottom.
//
// PROSE_MAX_WIDTH (820) is picked for a page of running prose. A sheet is one
// photo, a name, a price and a short paragraph -- a narrower thing again, the
// same way prose is narrower than the grid. 480 is not derived from either
// number: it is picked so the sheet reads as a CARD floating over the dimmed
// page behind it, which is what makes dismissing it feel like putting one
// thing down rather than leaving a second page.
//
// Shared by ProductSheet and CartSheet, which is why it lives here rather
// than in either of them: a cart of three lines stretched across a 1,500px
// window is a receipt printed on a bedsheet, and the two sheets floating at
// different widths would read as two different surfaces.
export const SHEET_MAX_WIDTH = 480;

// Bento's radii. `card` is BENTO_RADIUS (theme.ts) by value and by intent --
// not imported, because that constant lives beside `Colors.light` and this
// page renders in one of seven palettes for a stranger with no account. Copying
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

// Type ON a scrim -- a photo of unknown brightness, painted under it -- and so
// deliberately FIXED rather than palette-derived: the ground underneath is an
// unknown photograph, and a palette's own `ink` could vanish into a dark one.
// Lives here (moved from theme-shared.tsx, which re-exports both for the
// handful of importers that already reach for them there) so a display
// component that only needs these two strings -- CategoryBand, for one --
// does not have to import theme-shared.tsx's 1,750-line module to get them,
// dragging `checkout-form`, `storefront-order` and `@/lib/supabase` in behind
// it for no reason a category tile has anything to do with.
export const ON_SCRIM_INK = '#ffffff';
export const ON_SCRIM_MUTED = '#e8e6e0';

// TWO SCRIMS, NOT ONE -- one vocabulary ("type over an unknown photo, faded
// in from the top") but two strengths, because a small tile and a full-bleed
// hero are not the same surface. A single shared `SCRIM_GRADIENT` briefly
// stood in for both, after the two call sites (the shop card's own hero and
// a category tile's photo) had drifted apart on BOTH colour (0.82 vs 0.66
// alpha) and stop locations ([0.3, 0.92] vs [0.3, 1]) while a comment at the
// tile's call site claimed they already matched. But making them literally
// identical pushed the hero's own 0.82 alpha onto the tile too, and 0.82
// muddies a 136x92 photograph the tile exists to show: a small tile needs
// LESS scrim than a full-bleed hero to still read as a photo underneath it,
// not a photo the tile has darkened on its way to becoming legible. So the
// vocabulary is shared -- both fade in the same ink-blue from the same
// [0.3, ...] stop -- but the STRENGTH is two named constants, each owned by
// the CLASS of surface it fits (full-bleed vs a tile), not by a single call
// site. Nothing here claims the two classes are, or should be, the same
// value.
//
// THE HERO. Full-bleed, so it can afford to go dark enough to guarantee
// on-scrim text stays legible over any photo a shop uploads. Two call sites
// share it for exactly that reason, both full-bleed photographs of unknown
// brightness rather than tiles: the shop page's own hero
// (`storefront-hero-scrim`, theme-shared.tsx) and the store directory's
// featured card (`storefront-directory-featured-scrim-<slug>`,
// shop-directory-card.tsx).
export const HERO_SCRIM = {
  colors: ['transparent', 'rgba(16,22,35,0.82)'] as const,
  locations: [0.3, 0.92] as const,
};

// THE TILE. A category tile's photo (`storefront-category-scrim`,
// category-band.tsx) -- a fraction of the hero's size, so the hero's own
// 0.82 would read as darkening the photo rather than sitting over it.
// Lighter, and reaching further down the tile ([0.3, 1] rather than
// [0.3, 0.92]) -- the same value this constant carried before it was folded
// into the hero's own for one release; splitting it back out is a revert,
// not a new number.
export const TILE_SCRIM = {
  colors: ['transparent', 'rgba(16,22,35,0.66)'] as const,
  locations: [0.3, 1] as const,
};
