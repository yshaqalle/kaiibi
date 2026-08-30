import { StyleSheet, Text, View } from 'react-native';

import { formatCents } from '@/lib/currency';
import type { PaletteColors } from '@/lib/storefront-catalog';
import type { PlacedOrder } from '@/lib/storefront-order';

type Props = {
  order: PlacedOrder;
  shopName: string;
  // Where to come and get it, ALREADY COMPOSED by collectLocation
  // (storefront-collect.ts) -- not the raw shop_locations.address column,
  // which no automated path has ever written and which is therefore empty for
  // nearly every shop. That helper joins the typed address to the city and
  // degrades to the city alone.
  //
  // Null only when the shop has neither on file, in which case the sentence
  // falls back to exactly what it said before: a promise of a phone call,
  // which is at least true. Never an empty "Collect from".
  collectLocation?: string | null;
  colors: PaletteColors;
};

// What a stranger sees the moment their order lands, and everything it
// deliberately withholds. No account was created and none is offered; no
// tracking page exists to link to, because plan 4 owns fulfilment state and
// has not built one yet. This trade already worked on a short number and a
// phone call before there was an app, so that is the whole confirmation: the
// number the shop will read back, what happens next, and what to have ready
// to pay -- nothing this screen cannot honestly promise today.
export function OrderPlaced({ order, shopName, collectLocation, colors }: Props) {
  const nextStep =
    order.fulfilment === 'deliver'
      ? `${shopName} will call you to arrange delivery${order.deliveryArea ? ` to ${order.deliveryArea}` : ''}.`
      : collectLocation
        ? `${shopName} will call you when your order is ready. Collect from ${collectLocation}.`
        : `${shopName} will call you when your order is ready to collect.`;

  return (
    <View style={[styles.card, { backgroundColor: colors.ground }]}>
      <Text style={[styles.label, { color: colors.muted }]}>Order number</Text>
      <Text style={[styles.number, { color: colors.ink }]}>#{order.number}</Text>

      <Text style={[styles.next, { color: colors.ink }]}>{nextStep}</Text>

      <View style={[styles.payRow, { borderTopColor: colors.soft }]}>
        <Text style={[styles.payLabel, { color: colors.ink }]}>
          {order.fulfilment === 'deliver' ? 'Pay on delivery' : 'Pay on collection'}
        </Text>
        <Text style={[styles.payValue, { color: colors.ink }]}>{formatCents(order.totalCents)}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: 18, padding: 20, gap: 4 },
  label: { fontSize: 12.5, fontWeight: '800' },
  number: { fontSize: 30, fontWeight: '800', letterSpacing: -0.6 },
  next: { fontSize: 14, marginTop: 12, lineHeight: 19 },
  payRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 18,
    paddingTop: 14,
    borderTopWidth: 1,
  },
  payLabel: { fontSize: 14, fontWeight: '800' },
  payValue: { fontSize: 18, fontWeight: '800' },
});
