import { Colors } from '@/constants/theme';

const theme = Colors.light;

/**
 * Which of the four marks a hub card's icon tile wears.
 *
 * A property of the CARD, not derived from its `group` string, for two
 * reasons. The bands do not map one-to-one onto the marks -- Sales and Ledger
 * both take `core`, Inventory and Assets both take `stock` -- so a lookup by
 * group name would be a second, lossier copy of the mapping below. And a group
 * heading is display copy that gets reworded; a band is a decision, and
 * renaming "Customers and suppliers" should not silently turn its cards grey.
 *
 * Null is a card with NO mark: it keeps the plain `bentoSoft` tile. That is
 * every dimmed card (the hub's greying already means "nothing to show", and a
 * coloured dimmed tile would make one appearance mean two things) and the
 * legacy "Until the ledger takes over" band, which is a signpost off the hub
 * rather than a band of it.
 */
export type HubBand = 'core' | 'stock' | 'attention' | 'statement' | null;

/**
 * The mark each band wears: a solid fill with the card's own white as the
 * glyph. See the `bentoBand*` block in theme.ts for why there are four of these
 * and not one per band, and for the CVD numbers behind the choice.
 *
 * ---- The marks are a PER-SCREEN language, not a global semantic ----
 *
 * These four meanings are the ACCOUNTING HUBS' meanings. A second screen that
 * bands its own groups draws from the same validated hue pool and gets its own
 * meanings, which will not all line up: Settings, worked through in
 * docs/design/hub-colour-rollout-mockup.html, keeps blue for Sales, teal for
 * Catalog and graphite for Books, but needs amber for "the shop's own setup"
 * rather than "has a clock on it", plus a fifth hue for Account.
 *
 * That is the rule, and it has to be stated rather than discovered: the hue
 * pool is shared because it is CVD-validated as a set, and the MEANINGS are
 * local to the screen the reader is looking at. Assuming otherwise is how amber
 * comes to mean "overdue" on one tab and "shop setup" on the next with nothing
 * on screen to tell them apart.
 *
 * Two things this is not. It is not status -- a group heading sits above every
 * band and each card carries its own name, so no mark is the only carrier of
 * anything, and none takes the sign-or-glyph rule `bentoProfit`/`bentoLoss`
 * carry. And it is not the action colour: `bentoAccentSolid` says "press this"
 * on every screen in the app, and that one IS global. See theme.ts.
 *
 * ONE map, imported by both hubs. The two card StyleSheets are already
 * deliberate duplicates -- hub-card-proportions.test.tsx asserts against both
 * renders precisely because a change made to one and not the other is invisible
 * until somebody opens both tabs -- and the whole argument for this scheme is
 * that a band reads the same on either hub. A second copy of these four pairs
 * is the one way to break that quietly.
 */
export const BAND_MARKS: Record<NonNullable<HubBand>, { fill: string; glyph: string }> = {
  // Each hub's own core work: Sales on Reports, Ledger and journals on The books.
  core: { fill: theme.bentoBandCore, glyph: theme.bentoSurface },
  // Things the shop holds: Inventory on Reports, Fixed Assets on The books.
  stock: { fill: theme.bentoBandStock, glyph: theme.bentoSurface },
  // Things with a clock on them: aging on Reports, closing and the audit trail
  // on The books.
  attention: { fill: theme.bentoBandAttention, glyph: theme.bentoSurface },
  // The three statements, which appear on BOTH hubs and must read the same on
  // each. Black rather than a fifth hue -- see theme.ts.
  statement: { fill: theme.bentoBandStatement, glyph: theme.bentoSurface },
};

/** The tile style for a card's band: its mark, or the plain soft tile. */
export function bandTile(band: HubBand): { backgroundColor: string } {
  return { backgroundColor: band ? BAND_MARKS[band].fill : theme.bentoSoft };
}

/** The glyph colour to match. Falls back to the ink a grey tile takes. */
export function bandGlyph(band: HubBand): string {
  return band ? BAND_MARKS[band].glyph : theme.bentoInk2;
}
