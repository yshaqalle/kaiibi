import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { pressable } from '@/components/storefront/press-feedback';
import { WhatsAppButton, ShopCard } from '@/components/storefront/theme-shared';
import {
  DISPLAY_FONT, LETTER, RADIUS, SPACE, TABULAR, TOUCH_TARGET, TYPE,
} from '@/components/storefront/scale';
import { formatCents } from '@/lib/currency';
import { openExternalUrl } from '@/lib/external-url';
import {
  DAY_LABELS, WEEK_ORDER, closingLabel, formatDayHours, isConfigured, isOpenAt, nextOpeningLabel, rangesFor,
  weekdayKeyFor, type OpeningHours,
} from '@/lib/store-hours';
import { collectLocation } from '@/lib/storefront-collect';
import { storefrontAddress } from '@/lib/storefront-host';
import { shareOnWhatsApp } from '@/lib/whatsapp';
import type { PaletteColors } from '@/lib/storefront-catalog';
import type { PublicDeliveryArea, PublicStorefront } from '@/types/models';

// The Visit tab. Gated on there being priced delivery areas (see availableTabs)
// because that list is the one thing here the Shop tab genuinely cannot show.
//
// THE CHANGE THIS TAB IS FOR. `CollectingCard` reduces every priced area to the
// cheapest one -- "Delivery · From $1.00" -- because on a phone card there is
// room for one line. That is a fine summary and a bad answer: the question a
// customer actually has is whether THEIR neighbourhood is on the list and what
// it costs them, and the cheapest fee cannot answer it. On its own tab the
// whole list fits.
//
// The summary stays on the Shop tab. It is a summary now rather than the whole
// truth, which is what it was always trying to be.

// THE RE-WEIGHTING (Task 22). The customer's question here is single: can I
// get there before it closes, and where exactly. Four equal cards used to
// make them assemble that answer themselves; this page now leads with ONE
// decision card that answers it -- a landmark-first direction card, built to
// be screenshotted and shown to a bajaj driver, because that is how this city
// actually navigates (20260808000000's own comment on addressing by
// landmark/neighbourhood). Everything else -- the full week of hours, the
// priced delivery list, the ways to reach the shop -- is reference material
// beneath it, exactly the facts this tab always rendered, re-ordered rather
// than replaced.

// THE DECISION CARD -- the page's ONE dark card, filled `colors.ink` the same
// way `ShopAnchor` and `ShopFooter` are: primary type in `colors.ground`,
// secondary in `colors.onDarkMuted`. It leads the panel at both widths (see
// `VisitPanel`'s own layout below) rather than sitting inside either column,
// so it never gets squeezed into the narrow side.
//
// Renders NOTHING when it would be empty -- no hours configured, no place to
// name and no WhatsApp number -- the rule every optional block on this page
// follows.
function DecisionCard({ storefront, colors }: { storefront: PublicStorefront; colors: PaletteColors }) {
  const hours = storefront.openingHours ?? {};
  const hoursConfigured = isConfigured(hours);
  const where = collectLocation(
    storefront.collectAddress, storefront.collectNeighborhood, storefront.city,
  );

  if (!hoursConfigured && !where && !storefront.whatsappE164) return null;

  // `new Date()` at render, deliberately not memoised -- the identical trade
  // HoursCard makes below, and for the identical reason: this page is opened,
  // read and closed within a minute or two, and a stale state is worse than
  // one that re-evaluates on a re-render.
  const now = new Date();
  const pill = decisionPillLabel(hours, now);
  const open = hoursConfigured && isOpenAt(hours, now);

  return (
    <View testID="storefront-visit-decision" style={[styles.decisionCard, { backgroundColor: colors.ink }]}>
      {/* SHAPE AND WORD CARRY THE STATE, not colour alone -- the rule
          storefront-catalog.ts sets for the stock dots and HoursCard already
          followed. NO PILL AT ALL when hours were never configured: printing
          a state for a shop that never set hours would invent a claim it
          never made. */}
      {pill ? (
        <View
          testID="storefront-visit-open-now"
          style={[styles.statePill, open ? { backgroundColor: colors.accent } : { backgroundColor: colors.soft }]}
        >
          <Text style={[styles.stateText, { color: open ? colors.ground : colors.muted }]}>{pill}</Text>
        </View>
      ) : null}

      {/* THE PLACE, set serif at direction-card size -- this is the
          screenshot. Omitted entirely when collectLocation has nothing to
          say. */}
      {where ? (
        <Text style={[styles.decisionPlace, { color: colors.ground }]}>{where}</Text>
      ) : null}

      {/* THE SUB-LINE, under the place -- what makes the screenshot legible
          to someone who did not open the page. Only makes sense captioning a
          place that is actually shown above it. */}
      {where && (storefront.city || storefront.shopName) ? (
        <Text style={[styles.decisionSub, { color: colors.onDarkMuted }]} numberOfLines={1}>
          {[storefront.city, storefront.shopName].filter(Boolean).join(' · ')}
        </Text>
      ) : null}

      {/* "Choose collection at checkout and pick your order up from the
          counter. Pay when you collect." used to print right here, on the
          old "Find us" card this one replaces. It is deliberately not
          restored: ShopFooter prints "Pay on collection · Prices set by the
          shop" on every page of this shop already, and the About tab's
          generated FAQ answers "How do I pay?" with the same fact in full --
          the fact is not lost from the site, only from a decision card whose
          entire job is answering ONE question without a paragraph under it. */}

      {where || storefront.whatsappE164 ? (
        <View style={styles.decisionActions}>
          {/* THE SHOP'S OWN ACCENT, not CHECKOUT_BLUE and not KAIIBI_BLUE --
              both of those are fixed colours reserved for a different job
              (the commit moment; kaiibi's own directory mark), and directions
              is neither. STEPPED rather than raw, though: this button sits
              on the page's ONE ink-filled card, and on the ink palette
              `accent` IS `ink`, byte for byte -- measured in a browser, the
              raw accent rendered as bare text with no plate at all, computed
              background rgb(20, 20, 24) identical to the card's. colors.
              onDarkAccent/onDarkAccentInk (storefront-catalog.ts) are that
              same accent walked away from `ink` until it clears WCAG
              1.4.11's 3:1 non-text floor, with a label walked to 4.5:1
              against THAT fill rather than assumed to be `ground` -- inert
              on azure, whose accent already cleared the floor unassisted,
              and a genuine (if smaller) correction on every other palette,
              ink included. */}
          {where ? (
            // NO MAP, and that is deliberate rather than missing. A rendered
            // map needs a tile provider and a key, and the shop has no
            // coordinates on file -- only a neighbourhood string. Drawing a
            // decorative grid with a pin on it, as the mockup does on this
            // very card, would be a picture of a map rather than a map, and a
            // customer would try to pinch it. This button does the thing the
            // map was there for: hands the place to whatever maps app they
            // already use.
            <Pressable
              testID="storefront-visit-directions"
              accessibilityRole="link"
              accessibilityLabel={`Open ${where} in Maps`}
              onPress={() => openExternalUrl(mapsUrlFor(where))}
              style={pressable([styles.directionsButton, styles.decisionAction, { backgroundColor: colors.onDarkAccent }])}
            >
              <Text style={[styles.directionsText, { color: colors.onDarkAccentInk }]}>Get directions</Text>
            </Pressable>
          ) : null}
          {/* WHATSAPP MOVES HERE from the contact card below -- the same
              fixed-green button. It prints the short label here and only here,
              so the pair actually fits one row on a phone; see WhatsAppButton's
              own comment for the measurement, and note the spoken label is
              unchanged. */}
          {storefront.whatsappE164 ? (
            <WhatsAppButton storefront={storefront} label="WhatsApp" style={styles.decisionAction} />
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

// Composes the decision card's pill text. Pulled out on its own because it is
// the one piece of copy this task adds real branching to, and a pure function
// is what a reader (and a future change) can reason about without a render.
//
// `!hoursConfigured` is the ONLY null case -- once hours exist, there is
// always something honest to say: open with a closing time, closed with a
// reopening time, or bare "Closed" when nothing reopens within the week
// nextOpeningLabel already looked at.
function decisionPillLabel(hours: OpeningHours, now: Date): string | null {
  if (!isConfigured(hours)) return null;
  if (isOpenAt(hours, now)) {
    // Non-null by construction: closingLabel selects its range by the
    // identical predicate isOpenAt just satisfied (see that function's own
    // comment), so a `true` here can never meet a `null` there.
    return `Open · ${closingLabel(hours, now)!}`;
  }
  const next = nextOpeningLabel(hours, now);
  return next ? `Closed · ${next}` : 'Closed';
}

// Opening hours, collapsed to today. `isConfigured` keeps its guard: a shop
// that never set hours renders no hours card whatsoever, unchanged from
// before this task -- printing seven "Closed" rows for it would invent a
// claim the shop never made, the same rule StockCard follows.
//
// The open/closed PILL that used to live in this card's own header has moved
// to the decision card above (1a in the brief) -- it is not rendered twice.
function HoursCard({ storefront, colors }: { storefront: PublicStorefront; colors: PaletteColors }) {
  // See availableTabs on why this is defended rather than trusted.
  const hours = storefront.openingHours ?? {};
  // Collapsed by default -- the seven-row week is reference material now, not
  // the decision. A disclosure hidden by default is exactly the shape that
  // slipped past this page's own sweep once already (see the Modal case in
  // storefront-touch-targets.test.tsx's own header comment); its own toggle is
  // named in that file's requiredId loop for exactly that reason.
  const [expanded, setExpanded] = useState(false);
  if (!isConfigured(hours)) return null;

  // `new Date()` at render, deliberately not memoised or frozen -- the DEVICE's
  // clock and weekday are used because the times are local wall-clock strings
  // with no timezone (see the column comment), which is right for a customer
  // standing in the same city as the shop, and wrong for one abroad. That is
  // the trade the column's own design already made.
  const now = new Date();
  const today = weekdayKeyFor(now);
  const todayRanges = rangesFor(hours, today);

  return (
    <ShopCard colors={colors} testID="storefront-visit-hours">
      <View style={styles.hoursHead}>
        <Text style={[styles.todayLine, { color: colors.ink }]}>
          Today: {formatDayHours(todayRanges)}
        </Text>
        <Pressable
          testID="storefront-visit-hours-toggle"
          accessibilityRole="button"
          accessibilityLabel="All hours"
          accessibilityState={{ expanded }}
          onPress={() => setExpanded((current) => !current)}
          style={pressable(styles.toggle)}
        >
          <Text style={[styles.toggleText, { color: colors.muted }]}>
            All hours {expanded ? '▴' : '▾'}
          </Text>
        </Pressable>
      </View>

      {/* THE HONEST SEVEN ROWS, unchanged in substance -- moved behind the
          toggle rather than rewritten. Same testIDs, same order, same
          today-plate treatment, same split-shift formatting. */}
      {expanded ? (
        <View style={styles.list}>
          {WEEK_ORDER.map((day, index) => {
            const isToday = day === today;
            const ranges = rangesFor(hours, day);
            return (
              <View
                key={day}
                testID={`storefront-visit-hours-${day}`}
                style={[
                  styles.row,
                  index < WEEK_ORDER.length - 1 && { borderBottomWidth: 1, borderBottomColor: colors.hairline },
                  isToday && [styles.today, { backgroundColor: colors.soft, borderBottomWidth: 0 }],
                ]}
              >
                <Text style={[styles.day, { color: colors.ink }, isToday && styles.dayToday]}>
                  {DAY_LABELS[day]}{isToday ? ' · today' : ''}
                </Text>
                <Text
                  style={[
                    styles.time,
                    { color: ranges.length === 0 ? colors.muted : colors.ink },
                    isToday && styles.timeToday,
                  ]}
                >
                  {formatDayHours(ranges)}
                </Text>
              </View>
            );
          })}
        </View>
      ) : null}
    </ShopCard>
  );
}

// A compact icon-row button -- Call, Instagram or Share shop. Pressable in
// full rather than the value alone: TOUCH_TARGET is a floor on the control
// itself, not on the glyph inside it.
function ContactButton({
  colors, testID, glyph, label, accessibilityLabel, onPress,
}: {
  colors: PaletteColors;
  testID: string;
  glyph: string;
  label: string;
  accessibilityLabel: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      testID={testID}
      accessibilityRole="link"
      accessibilityLabel={accessibilityLabel}
      onPress={onPress}
      style={pressable([styles.contactButton, { backgroundColor: colors.soft }])}
    >
      <Text style={styles.contactGlyph}>{glyph}</Text>
      <Text style={[styles.contactButtonText, { color: colors.ink }]}>{label}</Text>
    </Pressable>
  );
}

// A customer-voice message for forwarding the shop to a friend -- NOT
// publish-bar.tsx's sharePageMessage, which says the shop "is now online", a
// publish announcement that is false in a customer's mouth. Names the shop
// and ends on the address, so the address is the last thing read and the
// easy thing to tap. Exported so its composition is testable without a
// render -- the same reason mapsUrlFor below is exported.
export function shareMessage(storefront: PublicStorefront): string {
  return `Thought you'd like this shop — ${storefront.shopName}. `
    + `Order from your phone: ${storefrontAddress(storefront.slug)}`;
}

export function VisitPanel({
  storefront, areas, colors, wide,
}: {
  storefront: PublicStorefront;
  areas: PublicDeliveryArea[];
  colors: PaletteColors;
  // Two columns on a laptop, one on a phone -- the design's own split. Passed
  // rather than measured here, so a panel never subscribes to window
  // dimensions of its own (the rule ShopAnchor already follows).
  wide?: boolean;
}) {
  // Cheapest first, so the list opens with the best case and a customer
  // scanning for their own area meets the free one (if there is one) first.
  // Ties broken by name so the order is stable between renders rather than
  // depending on whatever the RPC happened to return.
  const sorted = [...areas].sort((a, b) => a.feeCents - b.feeCents || a.name.localeCompare(b.name));

  return (
    <View style={styles.panel} testID="storefront-visit-panel">
      {/* THE DECISION CARD LEADS AT BOTH WIDTHS -- outside the two-column
          split below, so it can never be squeezed into the narrow side
          column the way a card sitting inside `columnSide` would be. */}
      <DecisionCard storefront={storefront} colors={colors} />

      <View style={[styles.columns, wide && styles.columnsWide]}>
        <View style={[styles.column, wide && styles.columnMain]}>
          <HoursCard storefront={storefront} colors={colors} />
        </View>

        <View style={[styles.column, wide && styles.columnSide]}>
          {/* DELIVERY AREAS AS PRICED CHIPS. Gone entirely for a
              collection-only shop -- this tab used to require areas to exist
              at all; now that hours can bring a customer here on their own,
              an empty "Delivery areas" card would be a heading with nothing
              under it. */}
          {sorted.length > 0 ? (
            <ShopCard colors={colors} testID="storefront-visit-areas">
              <Text style={[styles.eyebrow, { color: colors.muted }]}>Delivery, if you&apos;d rather stay put</Text>
              <View style={styles.chips}>
                {sorted.map((area) => (
                  <View
                    // Keyed by name: PublicDeliveryArea carries no id (see
                    // types/models.ts), and a shop cannot price the same area
                    // twice.
                    key={area.name}
                    testID={`storefront-visit-area-${area.name}`}
                    style={[styles.chip, { backgroundColor: colors.soft }]}
                  >
                    {/* NOT A CONTROL -- plain View/Text, no onPress, no
                        accessibilityRole. Matches the ONE chip shape Task 21
                        introduced in about-panel.tsx (itself matching
                        shop-directory-card.tsx's sell tags): a card gets
                        exactly one chip vocabulary, not a second one invented
                        per surface. */}
                    <Text style={[styles.chipText, { color: colors.muted }]}>
                      {/* A free area says the word rather than "$0.00" -- a
                          price of zero is a fact about the fee, and "Free" is
                          the fact about the offer. */}
                      {area.name} · {area.feeCents === 0 ? 'Free' : formatCents(area.feeCents)}
                    </Text>
                  </View>
                ))}
              </View>
              <Text style={[styles.note, { color: colors.muted }]}>
                Pay the shop when your order arrives.
              </Text>
              {/* Moved here from the old contact card, which is where it sat
                  above the WhatsApp button before WhatsApp moved to the
                  decision card. The nudge is about DELIVERY AREAS, so its home
                  is this card now, not wherever WhatsApp itself ended up.

                  STILL GATED ON THERE BEING SOMEBODY TO ASK. It used to be
                  gated implicitly, by sitting inside the `whatsappE164`
                  branch; moving it out of that branch dropped the gate, so a
                  shop with no WhatsApp and no phone was told to "ask" with
                  nothing on the page to ask on. That is the failure
                  WhatsAppButton and ProductActions already refuse -- lose the
                  answer rather than print one that sends the customer
                  nowhere. Instagram is deliberately not in this test: a handle
                  is a profile to look at, not a channel this shop has promised
                  to answer on. */}
              {storefront.whatsappE164 || storefront.contactPhone ? (
                <Text style={[styles.note, { color: colors.muted }]}>
                  Not sure your area is covered? Ask before you order.
                </Text>
              ) : null}
            </ShopCard>
          ) : null}

          {/* CONTACT, FLATTENED TO ONE ICON ROW. Share shop has no optional
              datum to gate on -- forwarding a published shop's own address is
              always possible -- so this card is never actually empty; Call
              and Instagram render only when their own value exists. WhatsApp
              is NOT in this row any more; it moved to the decision card. */}
          <ShopCard colors={colors} testID="storefront-visit-contact" style={styles.contactCard}>
            <View style={styles.contactRow}>
              {storefront.contactPhone ? (
                <ContactButton
                  colors={colors}
                  testID="storefront-visit-call"
                  glyph="📞"
                  label="Call"
                  accessibilityLabel={`Call the shop: ${storefront.contactPhone}`}
                  // `tel:` is the one scheme every platform agrees on, and
                  // the OS decides what to do with it -- dialler on a phone, a
                  // prompt on a laptop. Stripped of spaces because a number
                  // typed for humans ("+252 63 000 0000") is not a valid
                  // tel: target.
                  onPress={() => openExternalUrl(`tel:${storefront.contactPhone!.replace(/[^\d+]/g, '')}`)}
                />
              ) : null}

              {storefront.instagram ? (
                <ContactButton
                  colors={colors}
                  testID="storefront-visit-instagram"
                  glyph="📷"
                  label="Instagram"
                  // The @ is printed, never stored -- see normalizeInstagram.
                  accessibilityLabel={`Instagram: @${storefront.instagram}`}
                  onPress={() => openExternalUrl(`https://instagram.com/${storefront.instagram}`)}
                />
              ) : null}

              <ContactButton
                colors={colors}
                testID="storefront-visit-share"
                glyph="↗"
                label="Share shop"
                accessibilityLabel={`Share ${storefront.shopName}`}
                onPress={() => shareOnWhatsApp(shareMessage(storefront))}
              />
            </View>
          </ShopCard>
        </View>
      </View>
    </View>
  );
}

// A universal maps link rather than a platform one: `https://www.google.com/
// maps/search/?api=1` is handed to the OS by openExternalUrl and opens in
// whatever the device actually uses -- Google Maps on Android, Apple Maps or
// Google on iOS, a browser tab on web. A `geo:` or `maps://` scheme would be
// right on exactly one of those and a dead link on the others.
//
// The query is the composed collect line ("Jigjiga Yar, Hargeisa"), which is
// how this region navigates -- see 20260808000000 on addressing by
// neighbourhood and landmark. It is a search, not a pin, and that is honest:
// the shop has no coordinates on file, so pretending to a precise location
// would send somebody to the wrong side of a neighbourhood with total
// confidence.
export function mapsUrlFor(place: string): string {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(place)}`;
}

const styles = StyleSheet.create({
  panel: { padding: SPACE.page, gap: SPACE.cardGap },
  // One column on a phone; an even two on a laptop (see columnMain/columnSide
  // below for why 1:1 replaced the old 1.15/1 split).
  columns: { gap: SPACE.cardGap },
  columnsWide: { flexDirection: 'row', alignItems: 'flex-start' },
  column: { gap: SPACE.cardGap },
  // RE-BALANCED TO 1:1 (Task 22). The old 1.15/1 split existed because the
  // main column held the "Find us" card AND the hours card, the two heaviest
  // things on the page, against a side column of areas and contact. The "Find
  // us" card is gone from both columns now -- it is the decision card, full
  // width above this row -- leaving a collapsed hours disclosure (a single
  // line plus a toggle, most of the time) against delivery chips and the
  // contact row. Neither side is reliably heavier than the other any more, so
  // an even split is the honest read rather than carrying a ratio tuned for a
  // card that no longer lives in either column.
  columnMain: { flex: 1 },
  columnSide: { flex: 1 },
  eyebrow: {
    fontSize: TYPE.eyebrow, fontWeight: '800', letterSpacing: LETTER.meta, textTransform: 'uppercase',
  },
  note: { fontSize: TYPE.body, lineHeight: 19, marginTop: 10 },
  list: { marginTop: 12 },
  row: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    gap: 14, paddingVertical: 11,
  },

  // THE DECISION CARD. `RADIUS.card`/`SPACE.card` match ShopCard's own card
  // style exactly (theme-shared.tsx) -- this one is not built from ShopCard
  // because ShopCard hard-codes a `colors.ground` fill, and this is the
  // page's one card filled with `colors.ink` instead, the same reason
  // ShopAnchor builds its own card rather than wrapping ShopCard.
  decisionCard: { borderRadius: RADIUS.card, padding: SPACE.card, gap: 10 },
  // ~1.4x today's flat-sans 17px, serif, and set to DOMINATE the card -- this
  // is the screenshot. DISPLAY_FONT rather than the body face, the same
  // display treatment about-panel.tsx's headline uses.
  decisionPlace: {
    fontFamily: DISPLAY_FONT, fontSize: 24, lineHeight: 29, fontWeight: '700', letterSpacing: LETTER.display,
  },
  decisionSub: {
    fontSize: TYPE.metaSmall, fontWeight: '800', letterSpacing: LETTER.meta, textTransform: 'uppercase',
  },
  // SIDE BY SIDE, and it has to be said in flex rather than left to intrinsic
  // widths. This was a `flexWrap: 'wrap'` row of two naturally-sized buttons,
  // which fits at 1440 and does NOT fit inside the card's 286px of usable width
  // at 390 -- measured, the pair wanted 309px and wrapped, so the phone got two
  // stacked buttons while the laptop got the design. `flex: 1` on both (with
  // the short WhatsApp label beside it) makes them share whatever width there
  // is, at every size, which is what the mockup's own `.btn { flex: 1 }` says.
  // No wrap: two buttons that shrink together cannot fall onto a second line.
  decisionActions: { flexDirection: 'row', gap: 10, marginTop: 2, alignItems: 'center' },
  decisionAction: { flex: 1 },
  directionsButton: {
    borderRadius: RADIUS.pill, paddingHorizontal: 18, paddingVertical: 11,
    minHeight: TOUCH_TARGET, justifyContent: 'center', alignItems: 'center',
  },
  directionsText: { fontSize: 12.5, fontWeight: '800' },

  // THE OPEN PILL -- lives on the decision card now, same shape HoursCard's
  // header used to draw (self-contained `soft`/`accent` fill, `muted`/`ground`
  // text), which is why it still reads correctly sitting on an `ink` card: the
  // pill supplies its own light surface rather than relying on the card's.
  statePill: { borderRadius: RADIUS.pill, paddingHorizontal: 11, paddingVertical: 5, alignSelf: 'flex-start' },
  stateText: { fontSize: TYPE.metaSmall, fontWeight: '800', letterSpacing: 0.4 },

  // THE HOURS CARD, collapsed.
  hoursHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  todayLine: { fontSize: TYPE.body, fontWeight: '700', flexShrink: 1 },
  toggle: { paddingHorizontal: 4, minHeight: TOUCH_TARGET, justifyContent: 'center' },
  toggleText: { fontSize: TYPE.metaSmall + 1, fontWeight: '800' },
  // Bleeds into the card's own padding so today reads as a highlighted ROW
  // rather than as a box sitting inside the list.
  today: { marginHorizontal: -12, paddingHorizontal: 12, borderRadius: RADIUS.inset },
  day: { fontSize: TYPE.body, fontWeight: '600' },
  dayToday: { fontWeight: '800' },
  time: { fontSize: TYPE.body, ...TABULAR },
  timeToday: { fontWeight: '800' },

  // THE DELIVERY CHIPS -- the ONE chip shape on this page, matching
  // about-panel.tsx's proof chips (which themselves match
  // shop-directory-card.tsx's sell tags) byte for byte: radius 8, weight 700,
  // size 10.5, `soft` fill, `muted` text.
  chips: { flexDirection: 'row', gap: 6, flexWrap: 'wrap', marginTop: 12 },
  chip: { borderRadius: 8, paddingHorizontal: 8, paddingVertical: 4 },
  chipText: { fontSize: 10.5, fontWeight: '700' },

  // THE CONTACT ICON ROW.
  contactCard: { padding: 12 },
  contactRow: { flexDirection: 'row', gap: 8 },
  // `minHeight: TOUCH_TARGET` states the floor directly rather than leaving
  // it implied by a glyph and some padding -- this row is more compact than
  // the 63px stacked ContactRows it replaces, which is exactly the risk this
  // page's own touch-target sweep exists to catch (see scale.ts's own
  // TOUCH_TARGET comment: "Open in Maps" shipped at 37px on this same file
  // behind a fully green suite).
  contactButton: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    borderRadius: RADIUS.pill, paddingHorizontal: 10, minHeight: TOUCH_TARGET,
  },
  contactGlyph: { fontSize: 15 },
  contactButtonText: { fontSize: TYPE.metaSmall + 1, fontWeight: '800' },
});
