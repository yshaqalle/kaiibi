import { Pressable, StyleSheet, Text, View } from 'react-native';

import { BENTO_RADIUS_TILE, Colors } from '@/constants/theme';
import { formatCents } from '@/lib/currency';
import { BASE_CURRENCY, formatSessionWindow } from '@/lib/register-sessions';
import { shortPersonName } from '@/lib/user-identity';
import type { Register, RegisterSession, StaffMember } from '@/types/models';

// Pinned to the light palette for now — no dark-mode switching yet.
const theme = Colors.light;

// One line above the cart saying who is on the register and what they started
// with. Three states, and the difference between the first two is the whole
// adoption story:
//
//   - No registers at this store: renders NOTHING. Not a banner, not a dot. A
//     shop that has never set a register up is not using the feature, and
//     nagging them about it is how banners get ignored.
//   - Registers exist, none open: a dashed grey invitation. The POS still
//     sells; the sale simply carries no session.
//   - Open: solid, with the person, the window and the float.

export function RegisterBar({
  registers,
  session,
  register,
  member,
  fallbackName,
  saleCount,
  takenCents,
  onOpen,
  onClose,
  onHandover,
  onShowDetail,
  compact,
}: {
  registers: Register[];
  session: RegisterSession | null;
  register: Register | null;
  member: StaffMember | null;
  // Shown when the session has no roster row — an owner running their own
  // register. Their name comes from the signed-in profile instead.
  fallbackName?: string | null;
  // What this session has rung up so far, across every tender. Shown live
  // because "how is this till doing?" should not require starting to close it —
  // which was the only way to see it before.
  saleCount?: number;
  takenCents?: number;
  onOpen: () => void;
  onClose: () => void;
  onHandover: () => void;
  // Tapping the bar itself. The person standing at the till is the one who most
  // wants "how is this doing", and before this the only way to see it was to
  // leave the POS for Accounting and find the row.
  onShowDetail: () => void;
  // On a phone the two labelled buttons plus a name do not fit on one line, and
  // the bar must stay ONE line — so the labels drop and the glyphs carry them.
  // Squeezing the name to three characters instead would be a worse trade: the
  // buttons are recognisable by shape, a truncated person is not.
  compact?: boolean;
}) {
  if (registers.length === 0 && !session) return null;

  if (!session) {
    return (
      <View style={[styles.bar, styles.barShut]}>
        <View style={[styles.dot, styles.dotShut]} />
        <View style={styles.who}>
          <Text style={styles.titleShut} numberOfLines={1}>No register open</Text>
          <Text style={styles.meta}>
            {registers.length === 1 ? '1 register here' : `${registers.length} registers here`}
          </Text>
        </View>
        <Pressable onPress={onOpen} style={[styles.action, styles.actionDark, styles.actionAlone]} accessibilityLabel="Open register">
          <Text style={styles.actionDarkText}>{compact ? '⊕' : '⊕  Open register'}</Text>
        </Pressable>
      </View>
    );
  }

  const base = session.cash.find((row) => row.currencyCode === BASE_CURRENCY);
  const otherFloats = session.cash.filter((row) => row.currencyCode !== BASE_CURRENCY && row.openingFloatMinor > 0);

  return (
    <View style={styles.bar}>
      <View style={styles.dot} />
      <Pressable onPress={onShowDetail} style={styles.who} accessibilityRole="button" accessibilityLabel="Register details">
        <Text style={styles.title} numberOfLines={1}>{register?.name ?? 'Register'}</Text>
        <Text style={styles.name} numberOfLines={1}>
          {shortPersonName(member?.fullName ?? fallbackName, member?.email)}
        </Text>
        <Text style={styles.meta} numberOfLines={1}>
          {formatSessionWindow(session.openedAt)}
          {base ? ` · float ${formatCents(base.openingFloatMinor)}` : ''}
          {otherFloats.length > 0 ? ` +${otherFloats.length}` : ''}
        </Text>
        {(saleCount ?? 0) > 0 && (
          <Text style={styles.taken}>
            {saleCount === 1 ? '1 sale' : `${saleCount} sales`} · {formatCents(takenCents ?? 0)} taken
          </Text>
        )}
      </Pressable>
      <View style={styles.actions}>
        <Pressable onPress={onHandover} style={[styles.action, styles.actionDark]} accessibilityLabel="Handover">
          <Text style={styles.actionDarkText}>{compact ? '⇄' : '⇄  Handover'}</Text>
        </Pressable>
        <Pressable onPress={onClose} style={[styles.action, styles.actionDark]} accessibilityLabel="Close register">
          <Text style={styles.actionDarkText}>{compact ? '⊘' : '⊘  Close register'}</Text>
        </Pressable>
      </View>
    </View>
  );
}

// Shown instead of the cart when the shop requires an open register. The
// product grid stays browsable behind it on purpose — answering "do you have it
// in stock?" is harmless, and the cashier can keep serving while a supervisor
// walks over with the float.
export function RegisterGate({ onOpen }: { onOpen: () => void }) {
  return (
    <View style={styles.gate}>
      <Text style={styles.gateTitle}>Open a register to sell</Text>
      <Text style={styles.gateBody}>
        This store counts its drawer at the start and end of every session. Pick a register, count what is in it, and
        it opens.
      </Text>
      <Pressable onPress={onOpen} style={styles.gateButton}>
        <Text style={styles.gateButtonText}>⊕  Open register</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: theme.surface,
    borderRadius: BENTO_RADIUS_TILE,
    paddingHorizontal: 14,
    paddingVertical: 11,
    marginBottom: 12,
  },
  barShut: { backgroundColor: 'transparent', borderWidth: 1, borderStyle: 'dashed', borderColor: theme.bentoRule },
  dot: { width: 9, height: 9, borderRadius: 5, backgroundColor: theme.bentoProfit },
  dotShut: { backgroundColor: theme.bentoMuted2 },
  who: { flexDirection: 'row', alignItems: 'baseline', gap: 8, flex: 1, minWidth: 0, flexWrap: 'wrap' },
  title: { fontSize: 13.5, fontWeight: '800', letterSpacing: -0.1, color: theme.bentoInk },
  titleShut: { fontSize: 13.5, fontWeight: '800', letterSpacing: -0.1, color: theme.bentoInk2 },
  name: { fontSize: 13, fontWeight: '700', color: theme.bentoInk2 },
  meta: { fontSize: 11.5, color: theme.bentoMuted },
  // Louder than the rest of the meta line: it is the number someone glances at
  // mid-shift, and it changes while they watch.
  taken: { fontSize: 12, fontWeight: '800', color: theme.bentoInk2, fontVariant: ['tabular-nums'] },
  actions: { flexDirection: 'row', gap: 6, flexShrink: 0 },
  action: {
    borderWidth: 1,
    borderColor: theme.bentoLine,
    borderRadius: 999,
    paddingHorizontal: 11,
    paddingVertical: 6,
  },
  // Only for the shut state, where the button is a direct child of the bar and
  // has to push itself right. The open state's `actions` row does that already.
  actionAlone: { marginLeft: 'auto' },
  actionDark: { backgroundColor: theme.bentoInk, borderColor: theme.bentoInk },
  actionDarkText: { fontSize: 11.5, fontWeight: '700', color: '#fff' },
  gate: { backgroundColor: theme.surface, borderRadius: 26, padding: 34, alignItems: 'center' },
  gateTitle: { fontSize: 17, fontWeight: '800', letterSpacing: -0.3, color: theme.bentoInk, marginBottom: 5 },
  gateBody: { fontSize: 13, color: theme.bentoMuted, textAlign: 'center', maxWidth: 340, lineHeight: 19 },
  gateButton: {
    marginTop: 18,
    backgroundColor: theme.bentoInk,
    borderRadius: 16,
    height: 50,
    alignSelf: 'stretch',
    alignItems: 'center',
    justifyContent: 'center',
  },
  gateButtonText: { color: '#fff', fontSize: 14.5, fontWeight: '800' },
});
