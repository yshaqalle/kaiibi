import { StyleSheet, Text, View } from 'react-native';

import { WhatsAppButton } from '@/components/storefront/theme-shared';
import { DISPLAY_FONT, LETTER, SPACE, TYPE } from '@/components/storefront/scale';
import { collectLocation } from '@/lib/storefront-collect';
import type { PaletteColors } from '@/lib/storefront-catalog';
import type { PublicStorefront } from '@/types/models';

// The page's second `ink` surface, and the thing that gives it an ending.
//
// Every theme currently stops: the last row of goods, then the edge of the
// screen. On a phone that reads as the page having been cut off, and on a
// laptop it leaves the browsing column floating in the page tone with nothing
// closing it.
//
// It is `ink` for the same reason the anchor card is -- Dashboard's one
// near-black card is what stops that page reading as a field of white
// rectangles, and a bookend at the bottom answers the anchor at the top. Which
// also means the two must not compete: the footer prints the shop's name at a
// fraction of the wordmark's size and adds no new claim, only the contact and
// the terms the page has already made.
export function ShopFooter({
  storefront, colors,
}: {
  storefront: PublicStorefront;
  colors: PaletteColors;
}) {
  const place = collectLocation(
    storefront.collectAddress, storefront.collectNeighborhood, storefront.city,
  ) ?? storefront.city;

  return (
    <View testID="storefront-footer" style={[styles.footer, { backgroundColor: colors.ink }]}>
      <View style={styles.top}>
        <View style={styles.who}>
          <Text style={[styles.name, { color: colors.ground }]} numberOfLines={2}>
            {storefront.shopName}
          </Text>
          {place ? (
            <Text style={[styles.place, { color: colors.onDarkMuted }]} numberOfLines={2}>{place}</Text>
          ) : null}
        </View>
        {/* The same fixed green as everywhere else on this page. It is the one
            control down here, and it is the one a customer who has scrolled the
            whole catalogue without finding what they wanted actually needs. */}
        {storefront.whatsappE164 ? <WhatsAppButton storefront={storefront} /> : null}
      </View>

      <View style={[styles.rule, { backgroundColor: ON_INK_RULE }]} />

      {/* Both halves are already true elsewhere on the page -- the Collecting
          card says "Pay: On collection" and the prices are already in the
          shop's currency. Repeating them at the foot is deliberate: this is
          where a customer lands after reading everything, and it is the last
          chance to answer "what am I actually committing to". */}
      <Text style={[styles.terms, { color: colors.onDarkMuted }]}>
        Pay on collection · Prices set by the shop
      </Text>
    </View>
  );
}

// Fixed white-at-low-alpha, not a palette value, for the same reason
// ON_INK_HAIRLINE in theme-shared.tsx is: it is drawn on `ink`, which is a
// near-black on every palette, so a derived token would be six values doing
// one job.
const ON_INK_RULE = 'rgba(255,255,255,0.14)';

const styles = StyleSheet.create({
  footer: { paddingHorizontal: SPACE.card, paddingTop: 26, paddingBottom: 30 },
  top: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' },
  who: { flexShrink: 1, minWidth: 160 },
  name: { fontFamily: DISPLAY_FONT, fontSize: 20, fontWeight: '700', letterSpacing: LETTER.display },
  place: { fontSize: TYPE.metaSmall, fontWeight: '800', letterSpacing: LETTER.meta, textTransform: 'uppercase', marginTop: 6 },
  rule: { height: 1, marginTop: 20 },
  terms: { fontSize: TYPE.metaSmall + 1, marginTop: 16 },
});
