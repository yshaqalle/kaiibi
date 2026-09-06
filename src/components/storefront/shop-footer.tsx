import { Image, Pressable, StyleSheet, Text, View } from 'react-native';

import { pressable } from '@/components/storefront/press-feedback';
import { WhatsAppButton } from '@/components/storefront/theme-shared';
import { DISPLAY_FONT, LETTER, SPACE, TYPE } from '@/components/storefront/scale';
import { openExternalUrl } from '@/lib/external-url';
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

      {/* ATTRIBUTION, not acquisition: a colophon lockup below the terms --
          the confirmation screen is where the one ask lives. The eyebrow
          reuses the caps meta treatment the place line above already wears,
          so the signature belongs to this page's own type system. Drawn from
          the on-ink ramp + the monochrome mark: recolours with the palette
          and never outranks the shop's own accent. */}
      {storefront.hideBranding ? null : (
        <Pressable
          testID="storefront-powered-by"
          accessibilityRole="link"
          onPress={() => openExternalUrl('https://kaiibi.com')}
          style={pressable(styles.brand)}
        >
          <Image source={require('@/assets/images/kaiibi-mark-white.png')} style={styles.brandMark} />
          <View>
            <Text style={[styles.brandEyebrow, { color: colors.onDarkMuted }]}>Powered by</Text>
            <Text style={[styles.brandName, { color: colors.ground }]}>kaiibi</Text>
          </View>
        </Pressable>
      )}
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
  brand: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 19, alignSelf: 'flex-start' },
  brandMark: { width: 21, height: 21 },
  brandEyebrow: {
    fontSize: TYPE.metaSmall - 1, fontWeight: '800',
    letterSpacing: LETTER.meta, textTransform: 'uppercase',
  },
  brandName: { fontSize: 14.5, fontWeight: '800', letterSpacing: LETTER.display, marginTop: 1 },
});
