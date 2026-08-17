import { Pressable, StyleSheet, Text, View } from 'react-native';

import { BENTO_RADIUS_TILE, Colors } from '@/constants/theme';
import { formatCents } from '@/lib/currency';
import { secondaryAmount } from '@/lib/display-currency';
import type { Currency } from '@/types/models';

// Pinned to the light palette for now -- no dark-mode switching yet.
const theme = Colors.light;

/**
 * Let what the payments do not cover be carried on the customer's account.
 *
 * ONE control, not a choice between two. The first attempt offered "Collect it
 * now" beside "Pay later", which read as two behaviours when only one of them
 * was a behaviour -- collecting is the payment methods above this, and a tile
 * meaning "do nothing different" invites a cashier to look for a difference that
 * isn't there.
 *
 * It is also how "some now, the rest later" works, with no third option:
 * whatever has been entered above is what they are paying now, and this carries
 * the difference -- so the amount here moves as payments are entered.
 *
 * Nothing here is ever disabled. With no customer attached it becomes the way to
 * attach one, because "you cannot do this yet" with no way forward is the dead
 * end that made an earlier version of this look broken.
 *
 * Renders nothing when the payments already cover the bill, which is every
 * ordinary sale.
 */
export function RestChoice({
  remainingCents,
  collectedCents,
  chosen,
  customerName,
  currency,
  onChange,
  onNeedCustomer,
}: {
  remainingCents: number;
  collectedCents: number;
  chosen: boolean;
  customerName: string | null;
  currency: Currency | null;
  onChange: (chosen: boolean) => void;
  onNeedCustomer: () => void;
}) {
  if (remainingCents <= 0) return null;

  const amount = formatCents(remainingCents);
  const secondary = secondaryAmount(remainingCents, currency);
  // "the remaining" only once something has actually been taken. On an untouched
  // bill there is nothing remaining -- it is all of it.
  const what = collectedCents > 0 ? `the remaining ${amount}` : amount;

  // No customer yet. Live, in full ink, and its action opens the picker -- the
  // server refuses a nameless debt, so this is that rule turned into the next
  // step rather than into a locked door.
  if (!customerName) {
    return (
      <Pressable onPress={onNeedCustomer} accessibilityRole="button" style={styles.card}>
        <View style={styles.head}>
          <Text style={styles.title}>Pay later</Text>
          <Text style={styles.action}>Attach a customer</Text>
        </View>
        <Text style={styles.detail}>Carry {what} on a customer&apos;s account</Text>
      </Pressable>
    );
  }

  return (
    <Pressable
      onPress={() => onChange(!chosen)}
      accessibilityRole="switch"
      accessibilityState={{ checked: chosen }}
      style={[styles.card, chosen && styles.cardOn]}
    >
      <View style={styles.head}>
        <Text style={[styles.title, chosen && styles.titleOn]}>
          {chosen ? 'Paying later' : 'Pay later'}
        </Text>
        <Text style={[styles.action, chosen && styles.actionOn]}>{chosen ? 'Undo' : 'Choose'}</Text>
      </View>
      <Text style={[styles.detail, chosen && styles.detailOn]}>
        {chosen
          ? `${what} carried on ${customerName}'s account`
          : `Carry ${what} on ${customerName}'s account`}
      </Text>
      {/* The figure the customer will be told, in the words they hear it in. */}
      {chosen && secondary !== null && <Text style={styles.echo}>{secondary}</Text>}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    marginTop: 12,
    padding: 14,
    borderRadius: BENTO_RADIUS_TILE,
    backgroundColor: theme.bentoSoft,
  },
  // The accent wash is bento's "this is chosen" signal. Not a status colour, so
  // it says selected without saying good or bad.
  cardOn: { backgroundColor: theme.bentoAccentWash },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  title: { fontSize: 14, fontWeight: '800', color: theme.bentoInk },
  titleOn: { color: theme.bentoAccentInk },
  action: { flexShrink: 0, fontSize: 11.5, fontWeight: '800', color: theme.bentoMuted, letterSpacing: 0.3 },
  actionOn: { color: theme.bentoAccentInk },
  detail: { fontSize: 11.5, fontWeight: '600', color: theme.bentoMuted, marginTop: 3, lineHeight: 16 },
  detailOn: { color: theme.bentoAccentInk },
  echo: { fontSize: 10, fontWeight: '600', color: theme.bentoAccentInk, marginTop: 2, opacity: 0.85 },
});
