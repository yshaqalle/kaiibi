import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { pressable } from '@/components/storefront/press-feedback';
import { formatCents } from '@/lib/currency';
import type { PublicOrder } from '@/lib/public-order';
import { paletteColors } from '@/lib/storefront-catalog';

// The page a customer reaches from their link. No login, no account, no shop
// context -- the token in the URL is the whole of their authority.
//
// PROPS ONLY. The route file (src/app/o/[token].tsx) owns the fetch, the
// token, and opening WhatsApp; this owns what is on screen. That split is
// what lets every case below be tested without expo-router or a network fake,
// and it is the same posture order-detail.tsx takes on the shop's side.
//
// NOT BENTO. Bento tokens are the admin app's. This screen is seen by
// customers, so it uses the storefront palette, the same one
// src/app/store/[slug].tsx renders under.
//
// TWO SHAPES, and the difference matters:
//
//   ORDINARY -- the stage, the lines, the total, where to go, and a way to
//     reach the shop. This is what will be opened most, and it is the whole
//     point of the feature: it answers "where is my order?" without a phone
//     call.
//
//   AMENDED -- the same, plus what the shop changed, what it used to cost,
//     what it costs now, and two buttons. "Yes, that's fine" writes. "Something
//     is wrong" WRITES NOTHING and opens WhatsApp -- see confirm_public_order's
//     header for why that asymmetry is the security argument for the whole
//     feature, not a UI preference.

const colors = paletteColors('ink');

type Props = {
  order: PublicOrder | null;
  loading: boolean;
  /** The token was unknown, expired, or a typo -- deliberately one state. */
  notFound?: boolean;
  /** A REQUEST failure, which is a different thing to say. */
  error?: string | null;
  confirming?: boolean;
  onConfirm: () => void;
  onMessageShop: () => void;
};

const STAGES: { key: string; label: string }[] = [
  { key: 'pending', label: 'Placed' },
  { key: 'accepted', label: 'Accepted' },
  { key: 'ready', label: 'Ready' },
  { key: 'completed', label: 'Done' },
];

function Stage({ status }: { status: string }) {
  if (status === 'cancelled') {
    return <Text style={[styles.stage, { color: colors.ink }]}>This order was cancelled.</Text>;
  }
  const current = STAGES.findIndex((s) => s.key === status);
  return (
    <View style={styles.stageRow}>
      {STAGES.map((s, i) => (
        <Text
          key={s.key}
          style={[
            styles.stageStep,
            { color: i <= current ? colors.ink : colors.muted },
            i === current && styles.stageCurrent,
          ]}
        >
          {s.label}
        </Text>
      ))}
    </View>
  );
}

export function PublicOrderView({
  order,
  loading,
  notFound = false,
  error = null,
  confirming = false,
  onConfirm,
  onMessageShop,
}: Props) {
  if (loading) {
    return (
      <View style={[styles.page, styles.centred, { backgroundColor: colors.ground }]}>
        <Text style={[styles.body, { color: colors.muted }]}>Loading…</Text>
      </View>
    );
  }

  // A REQUEST that failed is not a missing order, and saying "not found" for
  // a dropped connection sends a customer to phone the shop about a link that
  // is perfectly good.
  if (error) {
    return (
      <View style={[styles.page, styles.centred, { backgroundColor: colors.ground }]}>
        <Text style={[styles.title, { color: colors.ink }]}>Something went wrong</Text>
        <Text style={[styles.body, { color: colors.muted }]}>{error}</Text>
        <Text style={[styles.body, { color: colors.muted }]}>Check your connection and try again.</Text>
      </View>
    );
  }

  if (notFound || !order) {
    return (
      <View style={[styles.page, styles.centred, { backgroundColor: colors.ground }]}>
        <Text style={[styles.title, { color: colors.ink }]}>Order not found</Text>
        {/* Does not blame the customer, and does not distinguish expired from
            unknown -- the server does not either, on purpose. */}
        <Text style={[styles.body, { color: colors.muted }]}>
          This link may have expired, or it may have been copied incompletely. Check the message your shop sent you,
          or get in touch with them.
        </Text>
      </View>
    );
  }

  const amendment = order.amendment;
  // Only an amendment the customer has NOT yet agreed to is a question. Once
  // agreed, it is history and the buttons would ask twice.
  const awaitingAgreement = amendment !== null && order.confirmedAt === null && order.status !== 'cancelled';

  return (
    <ScrollView contentContainerStyle={[styles.page, { backgroundColor: colors.ground }]}>
      <Text style={[styles.shop, { color: colors.muted }]}>{order.shopName}</Text>
      <Text style={[styles.title, { color: colors.ink }]}>Order #{order.number}</Text>

      <Stage status={order.status} />

      {order.whereToGo ? (
        <View style={styles.block}>
          <Text style={[styles.label, { color: colors.muted }]}>
            {order.fulfilment === 'deliver' ? 'Delivering to' : 'Collect from'}
          </Text>
          <Text style={[styles.body, { color: colors.ink }]}>{order.whereToGo}</Text>
        </View>
      ) : null}

      <View style={styles.block}>
        <Text style={[styles.label, { color: colors.muted }]}>Your order</Text>
        {order.lines.map((line) => (
          <View key={`${line.productName}-${line.quantity}-${line.lineTotalCents}`} style={styles.lineRow}>
            <Text style={[styles.body, { color: colors.ink }]}>{line.productName}</Text>
            <Text style={[styles.qty, { color: colors.muted }]}>×{line.quantity}</Text>
            <Text style={[styles.money, { color: colors.ink }]}>{formatCents(line.lineTotalCents)}</Text>
          </View>
        ))}
        {order.deliveryFeeCents > 0 ? (
          <View style={styles.lineRow}>
            <Text style={[styles.body, { color: colors.muted }]}>Delivery</Text>
            <Text style={[styles.qty, { color: colors.muted }]} />
            <Text style={[styles.money, { color: colors.ink }]}>{formatCents(order.deliveryFeeCents)}</Text>
          </View>
        ) : null}
        <View style={[styles.totalRow, { borderTopColor: colors.hairline }]}>
          <Text style={[styles.totalLabel, { color: colors.ink }]}>
            {order.fulfilment === 'deliver' ? 'Pay on delivery' : 'Pay on collection'}
          </Text>
          <Text style={[styles.totalValue, { color: colors.ink }]}>{formatCents(order.totalCents)}</Text>
        </View>
      </View>

      {/* WHAT THE SHOP CHANGED. Only ever the customer note -- the internal
          reason is not in this payload at all (get_public_order does not
          return it), and there is deliberately no field here that could hold
          it if it were. */}
      {amendment ? (
        <View style={styles.block}>
          <Text style={[styles.label, { color: colors.muted }]}>The shop changed this order</Text>
          {amendment.customerNote ? (
            <Text style={[styles.note, { color: colors.ink }]}>{amendment.customerNote}</Text>
          ) : null}
          <View style={styles.lineRow}>
            <Text style={[styles.body, { color: colors.muted }]}>Was</Text>
            <Text style={[styles.qty, { color: colors.muted }]} />
            <Text style={[styles.money, { color: colors.muted }]}>{formatCents(amendment.wasCents)}</Text>
          </View>
          <View style={styles.lineRow}>
            <Text style={[styles.body, { color: colors.ink }]}>Now</Text>
            <Text style={[styles.qty, { color: colors.muted }]} />
            <Text style={[styles.money, { color: colors.ink }]}>{formatCents(amendment.nowCents)}</Text>
          </View>
        </View>
      ) : null}

      {order.confirmedAt ? (
        <Text style={[styles.body, { color: colors.muted }]}>Thank you — the shop knows you have agreed.</Text>
      ) : null}

      <View style={styles.actions}>
        {awaitingAgreement ? (
          <Pressable
            onPress={onConfirm}
            disabled={confirming}
            accessibilityLabel="Yes, that's fine"
            accessibilityRole="button"
            style={pressable([styles.primary, { backgroundColor: colors.ink }, confirming && styles.disabled])}
          >
            <Text style={[styles.primaryText, { color: colors.ground }]}>
              {confirming ? 'Sending…' : "Yes, that's fine"}
            </Text>
          </Pressable>
        ) : null}

        {/* It writes NOTHING -- there is no RPC behind this, it opens
            WhatsApp. A link that has been forwarded or leaked must never be
            able to alter an order, so the destructive conversation stays in
            the channel where the shop can ask who it is talking to.
            Offered only when the shop has published a number: that channel
            needs someone at the other end of it, and a button opening an
            empty chat is worse than no button. */}
        {order.shopWhatsapp ? (
        <Pressable
          onPress={onMessageShop}
          accessibilityLabel="Something is wrong — message the shop"
          accessibilityRole="button"
          style={pressable([styles.secondary, { borderColor: colors.edge }])}
        >
          <Text style={[styles.secondaryText, { color: colors.ink }]}>Something is wrong — message the shop</Text>
        </Pressable>
        ) : null}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { padding: 22, gap: 14, minHeight: '100%' },
  centred: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10 },
  shop: { fontSize: 13, fontWeight: '800', letterSpacing: 0.6, textTransform: 'uppercase' },
  title: { fontSize: 26, fontWeight: '800', letterSpacing: -0.6 },
  stageRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  stage: { fontSize: 14, fontWeight: '700' },
  stageStep: { fontSize: 13, fontWeight: '700' },
  stageCurrent: { textDecorationLine: 'underline' },
  block: { gap: 5, marginTop: 6 },
  label: { fontSize: 11.5, fontWeight: '800', letterSpacing: 0.8, textTransform: 'uppercase' },
  body: { fontSize: 14.5, lineHeight: 20 },
  note: { fontSize: 14.5, lineHeight: 20, fontWeight: '700' },
  lineRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 4 },
  qty: { width: 42, textAlign: 'right', fontSize: 13 },
  money: { minWidth: 78, textAlign: 'right', fontSize: 14, fontWeight: '700' },
  totalRow: { flexDirection: 'row', justifyContent: 'space-between', borderTopWidth: 1, marginTop: 6, paddingTop: 10 },
  totalLabel: { fontSize: 15, fontWeight: '800' },
  totalValue: { fontSize: 17, fontWeight: '800' },
  actions: { gap: 10, marginTop: 18 },
  primary: { borderRadius: 14, paddingVertical: 15, alignItems: 'center' },
  primaryText: { fontSize: 15, fontWeight: '800' },
  secondary: { borderRadius: 14, borderWidth: 1, paddingVertical: 14, alignItems: 'center' },
  secondaryText: { fontSize: 14, fontWeight: '700' },
  disabled: { opacity: 0.45 },
});
