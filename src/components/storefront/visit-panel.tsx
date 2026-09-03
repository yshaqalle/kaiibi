import { StyleSheet, Text, View } from 'react-native';

import { WhatsAppButton, ShopCard } from '@/components/storefront/theme-shared';
import { LETTER, SPACE, TABULAR, TYPE } from '@/components/storefront/scale';
import { formatCents } from '@/lib/currency';
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

export function VisitPanel({
  storefront, areas, colors,
}: {
  storefront: PublicStorefront;
  areas: PublicDeliveryArea[];
  colors: PaletteColors;
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
      {where ? (
        <ShopCard colors={colors} testID="storefront-visit-collect">
          <Text style={[styles.eyebrow, { color: colors.muted }]}>Collect from</Text>
          <Text style={[styles.place, { color: colors.ink }]}>{where}</Text>
          <Text style={[styles.note, { color: colors.muted }]}>
            Choose collection at checkout and pick your order up from the counter. Pay when you collect.
          </Text>
        </ShopCard>
      ) : null}

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
  );
}

const styles = StyleSheet.create({
  panel: { padding: SPACE.page, gap: SPACE.cardGap },
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
});
