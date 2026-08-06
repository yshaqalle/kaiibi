import { StyleSheet, Text, View } from 'react-native';

import { Colors } from '@/constants/theme';
import type { SubscriptionStatus } from '@/lib/entitlements';

// Pinned to the light palette for now — no dark-mode switching yet.
const theme = Colors.light;

// One shop's subscription status, as a pill.
//
// This exists because the status was previously a STATUS_COLOR record and a
// STATUS_DOT record applied by hand at four call sites — the wide table, the
// phone card, the drawer header and the attention list. Any one of them could
// drop the glyph and nobody would notice, and two of these five are red and
// green: colour alone is not the signal, so the glyph is not decoration.
//
// Bento ships two status colours and rules the four series colours out of
// status use. Three of the five map straight onto what exists. The other two
// are argued:
//
//   grace     `bentoWarn`, added for this. Paid and fully usable, but somebody
//             has to record it. Green hides the task; red says they are cut
//             off, which is the opposite of true.
//   trialing  `bentoSeries1`, the one deliberate exception to "series are never
//             status". A trial is not good or bad, it is PENDING, and blue is
//             the only neutral-but-present colour in the ramp. If that
//             exception is ever withdrawn this falls back to plain ink on
//             `bentoSoft` and loses nothing but speed.
const GLYPH: Record<SubscriptionStatus, string> = {
  trialing: '●',
  active: '●',
  grace: '◐',
  expired: '○',
  suspended: '✕',
};

// Tints are the status colour at low alpha rather than a second set of hex
// literals, so a tint can never drift from the ink it belongs to.
const TONE: Record<SubscriptionStatus, { ink: string; fill: string }> = {
  trialing: { ink: theme.bentoSeries1, fill: `${theme.bentoSeries1}14` },
  active: { ink: theme.bentoProfit, fill: `${theme.bentoProfit}1A` },
  grace: { ink: theme.bentoWarn, fill: `${theme.bentoWarn}1A` },
  expired: { ink: theme.bentoMuted, fill: theme.bentoSoft },
  suspended: { ink: theme.bentoLoss, fill: `${theme.bentoLoss}14` },
};

export function SubscriptionStatusPill({ status }: { status: SubscriptionStatus }) {
  const tone = TONE[status];
  return (
    <View style={[styles.pill, { backgroundColor: tone.fill }]}>
      <Text style={[styles.glyph, { color: tone.ink }]}>{GLYPH[status]}</Text>
      <Text style={[styles.label, { color: tone.ink }]}>{status}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 5,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 3,
  },
  glyph: { fontSize: 9, lineHeight: 15 },
  label: { fontSize: 11.5, fontWeight: '700', lineHeight: 15 },
});
