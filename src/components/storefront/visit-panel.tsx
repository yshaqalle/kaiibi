import { Pressable, StyleSheet, Text, View } from 'react-native';

import { pressable } from '@/components/storefront/press-feedback';
import { WhatsAppButton, ShopCard } from '@/components/storefront/theme-shared';
import { LETTER, RADIUS, SPACE, TABULAR, TYPE } from '@/components/storefront/scale';
import { formatCents } from '@/lib/currency';
import { openExternalUrl } from '@/lib/external-url';
import {
  DAY_LABELS, WEEK_ORDER, formatDayHours, isConfigured, isOpenAt, rangesFor, weekdayKeyFor,
} from '@/lib/store-hours';
import { collectLocation } from '@/lib/storefront-collect';
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

// THE HIGHEST-VALUE STRING ON THIS PAGE, and it was sitting in the database
// unread. `shop_locations.opening_hours` has existed since 20260809000000 --
// the shop fills it in under Settings -> Locations, the dashboard shows it, the
// scheduler validates shifts against it -- and the one audience who most needs
// it, a stranger deciding whether to walk over, was never shown it.
//
// Renders NOTHING at all when the shop has not set hours. `isConfigured` is the
// guard: an empty object means "never filled in", and printing seven "Closed"
// rows for it would invent a claim the shop never made -- the same rule
// StockCard follows when it refuses to say "all in stock today" about a shop
// with nothing listed.
function HoursCard({ storefront, colors }: { storefront: PublicStorefront; colors: PaletteColors }) {
  // See availableTabs on why this is defended rather than trusted.
  const hours = storefront.openingHours ?? {};
  if (!isConfigured(hours)) return null;

  // `new Date()` at render, deliberately not memoised or frozen: this page is
  // opened, read and closed within a minute or two, and a stale "Open now" is
  // worse than one that re-evaluates on a re-render. The DEVICE's clock and
  // weekday are used because the times are local wall-clock strings with no
  // timezone (see the column comment) -- which is right for a customer standing
  // in the same city as the shop, and wrong for one abroad. That is the trade
  // the column's own design already made.
  const now = new Date();
  const today = weekdayKeyFor(now);
  const open = isOpenAt(hours, now);

  return (
    <ShopCard colors={colors} testID="storefront-visit-hours">
      <View style={styles.hoursHead}>
        <Text style={[styles.eyebrow, { color: colors.muted }]}>Opening hours</Text>
        {/* SHAPE AND WORD CARRY THE STATE, not colour alone -- the rule
            storefront-catalog.ts sets for the stock dots. The pill is filled
            with the palette's own accent when open and with `soft` when not,
            and it says which in words either way. */}
        <View
          testID="storefront-visit-open-now"
          style={[
            styles.statePill,
            open ? { backgroundColor: colors.accent } : { backgroundColor: colors.soft },
          ]}
        >
          <Text style={[styles.stateText, { color: open ? colors.ground : colors.muted }]}>
            {open ? 'Open now' : 'Closed now'}
          </Text>
        </View>
      </View>

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
                // Today gets the plate, because "is it open NOW" is the
                // question, and a customer should not have to work out which
                // row applies to them.
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
                {/* Split shifts print as "08:00 – 11:30, 14:00 – 21:00" --
                    formatDayHours already joins them, which is the whole
                    reason each day is a list rather than one range. */}
                {formatDayHours(ranges)}
              </Text>
            </View>
          );
        })}
      </View>
    </ShopCard>
  );
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
  const where = collectLocation(
    storefront.collectAddress, storefront.collectNeighborhood, storefront.city,
  );
  // Cheapest first, so the list opens with the best case and a customer
  // scanning for their own area meets the free one (if there is one) first.
  // Ties broken by name so the order is stable between renders rather than
  // depending on whatever the RPC happened to return.
  const sorted = [...areas].sort((a, b) => a.feeCents - b.feeCents || a.name.localeCompare(b.name));

  return (
    <View style={styles.panel} testID="storefront-visit-panel">
      <View style={styles.head}>
        <Text style={[styles.eyebrow, { color: colors.muted }]}>Visit &amp; deliver</Text>
        <Text style={[styles.title, wide && styles.titleWide, { color: colors.ink }]}>
          {/* Two sentences' worth of promise in one line, and it changes with
              what the shop actually offers -- a collection-only shop reaching
              this tab through its hours must not be told what delivery costs. */}
          {areas.length > 0
            ? 'Where to find us, and what it costs to come to you'
            : 'Where to find us, and when we are open'}
        </Text>
      </View>

      <View style={[styles.columns, wide && styles.columnsWide]}>
        <View style={[styles.column, wide && styles.columnMain]}>
      {where ? (
        <ShopCard colors={colors} testID="storefront-visit-collect">
          <Text style={[styles.eyebrow, { color: colors.muted }]}>Find us</Text>
          <Text style={[styles.place, { color: colors.ink }]}>{where}</Text>
          <Text style={[styles.note, { color: colors.muted }]}>
            Choose collection at checkout and pick your order up from the counter. Pay when you collect.
          </Text>
          {/* NO MAP, and that is deliberate rather than missing. A rendered
              map needs a tile provider and a key, and the shop has no
              coordinates on file -- only a neighbourhood string. Drawing a
              decorative grid with a pin on it, as the mockup does, would be a
              picture of a map rather than a map, and a customer would try to
              pinch it. This button does the thing the map was there for:
              hands the place to whatever maps app they already use. */}
          <Pressable
            testID="storefront-visit-directions"
            accessibilityRole="link"
            accessibilityLabel={`Open ${where} in Maps`}
            onPress={() => openExternalUrl(mapsUrlFor(where))}
            style={pressable([styles.mapsButton, { backgroundColor: colors.soft }])}
          >
            <Text style={[styles.mapsText, { color: colors.ink }]}>Open in Maps</Text>
          </Pressable>
        </ShopCard>
      ) : null}

      <HoursCard storefront={storefront} colors={colors} />
        </View>

        <View style={[styles.column, wide && styles.columnSide]}>

      {/* Gone entirely for a collection-only shop. This tab used to require
          areas to exist at all; now that hours can bring a customer here on
          their own, an empty "Delivery areas" card would be a heading with
          nothing under it. */}
      {sorted.length > 0 ? (
      <ShopCard colors={colors} testID="storefront-visit-areas">
        <Text style={[styles.eyebrow, { color: colors.muted }]}>Delivery areas</Text>
        <View style={styles.list}>
          {sorted.map((area, index) => (
            <View
              // Keyed by name: PublicDeliveryArea carries no id (see
              // types/models.ts), and a shop cannot price the same area twice.
              key={area.name}
              testID={`storefront-visit-area-${area.name}`}
              style={[
                styles.row,
                index < sorted.length - 1 && { borderBottomWidth: 1, borderBottomColor: colors.hairline },
              ]}
            >
              <Text style={[styles.areaName, { color: colors.ink }]} numberOfLines={2}>{area.name}</Text>
              {/* A free area says the word rather than "$0.00" -- a price of
                  zero is a fact about the fee, and "Free" is the fact about
                  the offer. Not coloured: the whole list is priced, and
                  tinting one row would make the rest look like a warning. */}
              <Text style={[styles.fee, { color: colors.ink }]}>
                {area.feeCents === 0 ? 'Free' : formatCents(area.feeCents)}
              </Text>
            </View>
          ))}
        </View>
        <Text style={[styles.note, { color: colors.muted }]}>
          Pay the shop when your order arrives.
        </Text>
      </ShopCard>
      ) : null}

      {storefront.whatsappE164 ? (
        <ShopCard colors={colors} testID="storefront-visit-contact">
          <Text style={[styles.eyebrow, { color: colors.muted }]}>Reach the shop</Text>
          <Text style={[styles.note, { color: colors.muted }]}>
            Not sure your area is covered? Ask before you order.
          </Text>
          <View style={styles.action}>
            <WhatsAppButton storefront={storefront} />
          </View>
        </ShopCard>
      ) : null}
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
  head: { gap: 10, marginBottom: 4 },
  title: { fontSize: 21, lineHeight: 26, fontWeight: '800', letterSpacing: LETTER.displayLoud },
  titleWide: { fontSize: 27, lineHeight: 32 },
  // One column on a phone; the design's 1.15fr / 1fr on a laptop. The cards
  // themselves are unchanged between the two -- only where they sit.
  columns: { gap: SPACE.cardGap },
  columnsWide: { flexDirection: 'row', alignItems: 'flex-start' },
  column: { gap: SPACE.cardGap },
  columnMain: { flex: 1.15 },
  columnSide: { flex: 1 },
  mapsButton: { borderRadius: RADIUS.pill, paddingHorizontal: 18, paddingVertical: 11, alignSelf: 'flex-start', marginTop: 14 },
  mapsText: { fontSize: 12.5, fontWeight: '800' },
  eyebrow: {
    fontSize: TYPE.eyebrow, fontWeight: '800', letterSpacing: LETTER.meta, textTransform: 'uppercase',
  },
  place: { fontSize: 17, fontWeight: '800', letterSpacing: LETTER.display, marginTop: 10 },
  note: { fontSize: TYPE.body, lineHeight: 19, marginTop: 10 },
  list: { marginTop: 12 },
  row: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    gap: 14, paddingVertical: 11,
  },
  areaName: { fontSize: TYPE.body, fontWeight: '700', flexShrink: 1 },
  fee: { fontSize: TYPE.body, fontWeight: '800', ...TABULAR },
  action: { flexDirection: 'row', marginTop: 14 },

  hoursHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  statePill: { borderRadius: RADIUS.pill, paddingHorizontal: 11, paddingVertical: 5 },
  stateText: { fontSize: TYPE.metaSmall, fontWeight: '800', letterSpacing: 0.4 },
  // Bleeds into the card's own padding so today reads as a highlighted ROW
  // rather than as a box sitting inside the list.
  today: { marginHorizontal: -12, paddingHorizontal: 12, borderRadius: RADIUS.inset },
  day: { fontSize: TYPE.body, fontWeight: '600' },
  dayToday: { fontWeight: '800' },
  time: { fontSize: TYPE.body, ...TABULAR },
  timeToday: { fontWeight: '800' },
});
