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
    // The cool-grey/white world every main screen now uses — Dashboard,
    // Accounting, People, Inventory, POS and the Platform operator console.
    // Deliberately NOT a replacement for
    // `background` / `surface` / `border` above: Settings still reads those, as
    // do the modals across the app, and both stay cream until converted on
    // purpose. Two palettes coexist during the conversion; that is the agreed
    // interim state, not an oversight.
    //
    // Modals are a third case, not yet decided: every one in the app still
    // wears the stock white-card treatment, including the ones People opens.
    bentoPage: '#f4f4f5',
    bentoSurface: '#ffffff',
    bentoInk: '#0b0b0d',
    bentoInk2: '#1a1a1e',
    // Both steps are solved against `bentoSoft` #f6f6f7, NOT #ffffff. The KPI
    // tiles, the P&L total row and the selected-row inset all sit on the soft
    // grey, so white is the flattering surface and the wrong one to test on.
    //
    // The previous values failed WCAG AA for normal text: on that soft grey
    // #8b8b93 read 3.13:1 and #a8a8b0 just 2.19:1 (3.38:1 and 2.36:1 on the
    // white this pair is NOT solved against, which is the flattery the note
    // above is warning about) -- and muted2 is what chart axis labels wear, so
    // the least readable token was carrying the numbers on every chart. These
    // are the same cool hue re-stepped in OKLab holding hue and chroma; only
    // lightness moved, and the two steps stay 1.33:1 apart so the hierarchy
    // between a label and an axis tick survives.
    bentoMuted: '#5e5d65', // 6.02:1 on soft, 6.50:1 on white
    bentoMuted2: '#717078', // 4.53:1 on soft, 4.89:1 on white
    bentoLine: '#ececf0',
    // The line BETWEEN rows, deliberately firmer than `bentoLine`.
    //
    // One weight could not serve both jobs. A pill or chip is a small closed
    // shape and its hairline only has to hint at an edge, so `bentoLine` is
    // nearly invisible on purpose. A divider in a table has to separate two
    // 100px-tall rows across the full width of a card, and at that length the
    // same value disappears and the rows read as one block.
    bentoRule: '#dcdce4',
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
    // The receding step of `bentoSeries1`, for a chart where one mark is
    // emphasised and the rest are context -- the peak bar against the other
    // six days of the week.
    //
    // A real colour, not an opacity. The obvious way to draw "the same blue,
    // quieter" is rgba(47,107,255,.18), which lands at 1.3:1 on white: a mark
    // you can lose entirely on a sunlit phone, which is where this app is
    // read. This clears the 3:1 floor for a chart mark on both grounds it
    // sits on, so the quiet bars are still bars.
    bentoSeriesSoft: '#5f86ff', // 3.31:1 on white, 3.07:1 on soft
    // Status, not series. Green/red is ΔE 4.0 for deutan viewers -- the
    // classic red/green trap -- so anything wearing these MUST also carry a
    // signed figure or a direction glyph. The waterfall labels every bar and
    // StatementRow prints the minus sign; that labelling is load-bearing.
    //
    // Also re-stepped against `bentoSoft`. The old green was the subtle one:
    // #0f9d58 reads 3.25:1 there, which clears the 3:1 large-text bar and so
    // was legal on the 19px bold net-profit total, while failing the 4.5:1
    // normal-text bar on the 15px StatementRow directly above it -- one token
    // passing and failing inside a single card. Darkening it removes the size
    // question entirely. The red moved a hair for the same reason (4.42:1).
    //
    // These are the LIGHT steps. On a dark ground they are too dark to serve
    // as a chart mark (#008340 reads 2.93:1 on the #2a2a30 gauge track), so
    // anything drawn on `bentoInk` must take the dark mirrors below.
    bentoProfit: '#008340', // 4.50:1 on soft, 4.86:1 on white
    bentoLoss: '#d72b3e', // 4.52:1 on soft, 4.88:1 on white
    // The third status: needs noticing, but is not broken.
    //
    // Profit/loss is a two-state world, and some states are neither. A shop in
    // `grace` has paid and is fully usable -- somebody just has to record it.
    // Painting that green hides the task; painting it red says the shop is cut
    // off, which is the opposite of true. Also what `Caveat`'s `wrong` tone
    // wants: it currently hardcodes #8A5A05 beside a `warning` that belongs to
    // the cream palette.
    bentoWarn: '#b07206',
    // The delta badge — "up 12%" beside a figure. A washed pill rather than
    // coloured text, because a bare green number on a soft tile is a figure
    // that happens to be green, where a pill reads as a comparison. The ink
    // steps are solved against their own wash, NOT against `bentoSoft`: the
    // wash is what sits behind the glyph.
    //
    // The badge always carries an arrow as well as the colour — same rule as
    // `bentoProfit`/`bentoLoss` above, and for the same deutan reason.
    bentoUpWash: '#d9efe4',
    bentoUpInk: '#007a38', // 4.53:1 on its wash
    bentoDownWash: '#fbeaec',
    bentoDownInk: '#d12339', // 4.51:1 on its wash
    // The same pill shape in the neutral case — a figure being carried beside
    // a status one, with no status of its own. `bentoSoft` would be the
    // obvious choice and is wrong here: it is the tile fill, so a soft pill on
    // a soft tile disappears. This is `bentoSeries1` washed to the same
    // lightness as the pair above.
    bentoAccentWash: '#e6edff',
    bentoAccentInk: '#1b47b8', // 6.79:1 on its wash
    // A sale that came back. Amber for the same reason `bentoWarn` is amber:
    // this is the third status -- needs noticing, is not broken. Red would say
    // the sale is a loss, which it is not, and would sit next to a genuinely
    // negative profit figure crying the same wolf; green is nonsense for money
    // going out. Washed to the lightness of the delta pills above so the three
    // read as one family of badges rather than three unrelated marks.
    //
    // The badge carries a `↩` as well as the colour -- same deutan rule as
    // `bentoProfit`/`bentoLoss`, and the reason a partial refund is a count
    // ("1 of 4 back") rather than a differently-coloured dot.
    bentoRefundWash: '#f8efdc',
    bentoRefundInk: '#8a5a05', // 5.18:1 on its wash
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
    // Lighter than bentoLine here, not darker: on a dark surface a divider
    // separates by being brighter than its ground, which is the mirror of what
    // it does on white.
    bentoRule: '#33333d',
    bentoSoft: '#1e1e24',
    bentoSeries1: '#2f6bff',
    bentoSeries2: '#00a396',
    bentoSeries3: '#c8791a',
    bentoSeries4: '#d4457e',
    // The mirror recedes by going DARKER, where the light one recedes by going
    // lighter -- a paler blue on a dark ground is more prominent, not less,
    // which would invert what the token means. Still 3.54:1 on `bentoSurface`.
    bentoSeriesSoft: '#656f85',
    // These two are the exception to "nothing reads these yet". A dark card on
    // the LIGHT screen -- the takings hero, and the net-margin gauge sitting on
    // `bentoInk` -- needs a status colour chosen for a dark ground, and the
    // light steps are too dark to qualify (#008340 is 2.93:1 on the #2a2a30
    // gauge track, under the 3:1 chart-mark floor). Both of these clear it:
    // 5.58:1 and 3.92:1 on that track, 7.69:1 and 5.41:1 as text on the card.
    // So read them by surface, not by theme.
    bentoProfit: '#2eb872',
    bentoLoss: '#e8515f',
    bentoWarn: '#e0a244',
    // Dark mirrors of the delta wash. A pale mint pill on a dark card would be
    // the brightest thing in it, so the wash goes translucent-dark and the ink
    // goes light — the pill still reads as a pill, and no longer shouts.
    bentoUpWash: '#123a2a',
    bentoUpInk: '#7fe8bc',
    bentoDownWash: '#3d1a20',
    bentoDownInk: '#ff8a93',
    bentoAccentWash: '#1a2440',
    bentoAccentInk: '#8fb4ff',
    // Same inversion the delta washes take: the wash goes dark, the ink goes
    // light, so the pill still reads as a pill without being the brightest
    // thing on the card. 8.20:1 on its wash.
    bentoRefundWash: '#3a2c12',
    bentoRefundInk: '#f2c26a',
  },
} as const;

/** Card radius for the bento surfaces. The stock `Card` stays at 12. */
export const BENTO_RADIUS = 26;

/**
 * Radius for a small repeated TILE, not a panel — a POS product tile, a stat
 * inset, anything roughly 150px or under.
 *
 * 26 is tuned for a card that holds a heading and a list. On a tile it eats the
 * corners until the shape reads as a pill rather than a card, and a grid of
 * pills loses the sense of a grid. Two radii, chosen by the size of the thing,
 * rather than one radius misapplied.
 */
export const BENTO_RADIUS_TILE = 18;

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
