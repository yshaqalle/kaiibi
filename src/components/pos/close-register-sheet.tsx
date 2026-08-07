import { useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { DrawerCount, toDrawerEntries, type DrawerCountValue } from '@/components/pos/drawer-count';
import { AppModal } from '@/components/ui/app-modal';
import { BENTO_RADIUS_TILE, Colors } from '@/constants/theme';
import { formatCents, formatForeignCents } from '@/lib/currency';
import { closeRegisterSession, handoverRegisterSession } from '@/lib/registers';
import {
  BASE_CURRENCY,
  combinedVarianceBaseCents,
  currenciesToCount,
  expectedMinor,
  formatSessionWindow,
  fxDriftBaseCents,
  varianceMinor,
  varianceTone,
} from '@/lib/register-sessions';
import { shortPersonName } from '@/lib/user-identity';
import type { Currency, Register, RegisterSession, StaffMember } from '@/types/models';

// Pinned to the light palette for now — no dark-mode switching yet.
const theme = Colors.light;

// Closing a register, in two steps, and the order is the design.
//
// COUNT BEFORE REVEAL. Step one takes the counted cash and does NOT show what
// the register expected. Put the expected figure on screen first and a tired
// cashier at the end of a shift types it back in: the variance is then
// structurally always zero and the feature costs a minute a day while detecting
// nothing. They can still step back and change the number after the reveal —
// this refuses to LEAD with the answer, not to let them see it.
//
// Handover is the same sheet with an incoming person: one count closes the
// outgoing session and becomes the incoming float, because it is one pile of
// money with two people looking at it.

// Mounted only while it is open, and keyed by the parent — see the note on
// OpenRegisterSheet. Every field initialises from props on mount.
export function CloseRegisterSheet({
  mode,
  session,
  register,
  member,
  team,
  currencies,
  denominations,
  cashMovements,
  saleCount,
  nonCashTotals,
  onClose,
  onDone,
}: {
  mode: 'close' | 'handover';
  session: RegisterSession;
  register: Register | null;
  member: StaffMember | null;
  team: StaffMember[];
  currencies: Currency[];
  denominations: Record<string, number[]>;
  // Net cash into the drawer this session, per currency — from the session's
  // own sales. Used for the local preview only; the server recomputes all of it.
  cashMovements: Record<string, number>;
  saleCount: number;
  nonCashTotals: { label: string; cents: number }[];
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const [step, setStep] = useState<'count' | 'reveal'>('count');
  const [count, setCount] = useState<DrawerCountValue>({});
  const [note, setNote] = useState('');
  const [incomingId, setIncomingId] = useState<string | null>(
    team.find((m) => m.id !== session.shopMemberId)?.id ?? null
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Only the currencies this session actually saw: one it was given a float in,
  // or one it took cash in. A mobile session that only took ZAAD therefore has
  // nothing to count and closes in one tap — demanding a $0.00 confirmation
  // anyway just trains people to type zero without reading.
  const codes = useMemo(() => currenciesToCount(session.cash, cashMovements), [session.cash, cashMovements]);

  const entries = useMemo(() => toDrawerEntries(count, codes, currencies), [count, codes, currencies]);

  // The same arithmetic the server will do, run locally so the reveal is
  // immediate. The server's figures are authoritative and overwrite these the
  // moment the sheet reloads.
  const preview = useMemo(
    () =>
      codes.map((code) => {
        const row = session.cash.find((c) => c.currencyCode === code);
        const float = row?.openingFloatMinor ?? 0;
        const expected = expectedMinor(float, cashMovements[code] ?? 0);
        const counted = entries.find((e) => e.currencyCode === code)?.amountMinor ?? 0;
        const currency = currencies.find((c) => c.code === code) ?? null;
        const closingRate = currency ? currency.rateToUsd : 1;
        return {
          code,
          currency,
          float,
          movement: cashMovements[code] ?? 0,
          expected,
          counted,
          variance: varianceMinor(counted, expected),
          openingRate: row?.openingRateToUsd ?? closingRate,
          closingRate,
        };
      }),
    [codes, session.cash, cashMovements, entries, currencies]
  );

  const combined = combinedVarianceBaseCents(
    preview.map((row) => ({
      id: row.code,
      sessionId: session.id,
      currencyCode: row.code,
      openingFloatMinor: row.float,
      openingRateToUsd: row.openingRate,
      closingCountedMinor: row.counted,
      closingRateToUsd: row.closingRate,
      expectedMinor: row.expected,
      varianceMinor: row.variance,
      openingDenominations: null,
      closingDenominations: null,
    }))
  );

  const fxDrift = preview.reduce(
    (sum, row) =>
      sum +
      fxDriftBaseCents({
        id: row.code,
        sessionId: session.id,
        currencyCode: row.code,
        openingFloatMinor: row.float,
        openingRateToUsd: row.openingRate,
        closingCountedMinor: row.counted,
        closingRateToUsd: row.closingRate,
        expectedMinor: row.expected,
        varianceMinor: row.variance,
        openingDenominations: null,
        closingDenominations: null,
      }),
    0
  );

  // A gap nobody explained cannot be investigated a week later, and this is the
  // number that decides whether a conversation with an employee happens.
  const noteRequired = combined !== 0;
  const canSubmit = !submitting && (!noteRequired || note.trim().length > 0);

  const submit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      if (mode === 'handover') {
        if (!incomingId) {
          setError('Pick who is taking over.');
          setSubmitting(false);
          return;
        }
        await handoverRegisterSession(session.id, incomingId, entries, note);
      } else {
        await closeRegisterSession(session.id, entries, note);
      }
      await onDone();
      onClose();
    } catch (err) {
      setError(extractErrorMessage(err, 'Could not close this register.'));
    } finally {
      setSubmitting(false);
    }
  };

  const title = mode === 'handover' ? `Hand over ${register?.name ?? 'register'}` : `Close ${register?.name ?? 'register'}`;

  return (
    <AppModal visible animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View style={styles.sheet}>
          <View style={styles.head}>
            <Text style={styles.headTitle}>{title}</Text>
            <Pressable onPress={step === 'count' ? onClose : () => setStep('count')} style={styles.headBtn}>
              <Text style={styles.headBtnText}>{step === 'count' ? 'Cancel' : 'Back'}</Text>
            </Pressable>
          </View>
          <Text style={styles.sub}>
            {shortPersonName(member?.fullName, member?.email)} · {formatSessionWindow(session.openedAt)} ·{' '}
            {saleCount === 1 ? '1 sale' : `${saleCount} sales`}
          </Text>

          <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
            {step === 'count' ? (
              <>
                {mode === 'handover' && (
                  <View style={styles.block}>
                    <Text style={styles.label}>Coming on</Text>
                    {team
                      .filter((m) => m.id !== session.shopMemberId)
                      .map((m) => (
                        <Pressable
                          key={m.id}
                          onPress={() => setIncomingId(m.id)}
                          style={[styles.personOption, m.id === incomingId && styles.personOptionOn]}
                        >
                          <Text style={styles.personOptionText}>{m.fullName ?? m.email ?? 'Staff'}</Text>
                        </Pressable>
                      ))}
                    <Text style={styles.hint}>
                      One count closes {shortPersonName(member?.fullName, member?.email)}&rsquo;s session and becomes
                      the incoming float — it is the same notes, counted once, with both names on it.
                    </Text>
                  </View>
                )}

                <DrawerCount
                  currencyCodes={codes}
                  currencies={currencies}
                  denominations={denominations}
                  value={count}
                  onChange={setCount}
                  autoFocusFirst
                />

                {codes.length > 0 && (
                  <Text style={styles.hint}>
                    Count what is physically in the drawer, including the float you started with. What the register
                    expected is on the next step — counting against a number already on screen is not a count.
                  </Text>
                )}

                {nonCashTotals.length > 0 && (
                  <View style={styles.block}>
                    <Text style={styles.label}>Not in the drawer</Text>
                    <View style={styles.chips}>
                      {nonCashTotals.map((total) => (
                        <Text key={total.label} style={styles.chip}>
                          {total.label} {formatCents(total.cents)}
                        </Text>
                      ))}
                    </View>
                    <Text style={styles.hint}>
                      Taken on this session but never in your hand. Nothing here belongs in the count above.
                    </Text>
                  </View>
                )}

                <Pressable onPress={() => setStep('reveal')} style={styles.primary}>
                  <Text style={styles.primaryText}>Review the count</Text>
                </Pressable>
              </>
            ) : (
              <>
                <View style={styles.block}>
                  <VarianceCard cents={combined} label="across the whole drawer" />
                  {preview.length > 1 && (
                    <Text style={styles.hint}>
                      Each currency is compared against its own expected figure first — that arithmetic never touches a
                      rate. Only the resulting variances are converted and added.
                    </Text>
                  )}
                </View>

                {preview.map((row) => {
                  const format = (minor: number) =>
                    row.currency ? formatForeignCents(minor, row.currency.symbol) : formatCents(minor);
                  return (
                    <View key={row.code} style={styles.block}>
                      <Text style={styles.label}>{row.currency?.name ?? 'US Dollars'} — how that is worked out</Text>
                      <Row k="Opening float" v={format(row.float)} />
                      <Row k={row.movement >= 0 ? 'Cash taken' : 'Cash paid out'} v={format(row.movement)} />
                      <Row k="Expected in the drawer" v={format(row.expected)} strong rule />
                      <Row k="You counted" v={format(row.counted)} strong />
                      {row.code !== BASE_CURRENCY && (
                        <Text style={styles.hint}>
                          Notes in minus change handed back, in {row.code} — never the dollar equivalent.
                        </Text>
                      )}
                    </View>
                  );
                })}

                {fxDrift !== 0 && (
                  <View style={styles.fx}>
                    <Text style={styles.fxTitle}>The exchange rate moved</Text>
                    <Text style={styles.fxBody}>
                      What you are holding is worth {formatCents(Math.abs(fxDrift))}{' '}
                      {fxDrift < 0 ? 'less' : 'more'} than at open, with every note still in the drawer. That is the
                      shop&rsquo;s exchange exposure for the day, not a cash discrepancy — it is kept out of the
                      variance above.
                    </Text>
                  </View>
                )}

                <View style={styles.block}>
                  <Text style={styles.label}>
                    What happened{noteRequired ? '  ·  required' : '  ·  optional'}
                  </Text>
                  <TextInput
                    value={note}
                    onChangeText={setNote}
                    placeholder="e.g. gave $5 change from the wrong note at about 2pm"
                    placeholderTextColor={theme.bentoMuted2}
                    multiline
                    style={styles.textarea}
                  />
                  {noteRequired && (
                    <Text style={styles.hint}>
                      Required because the drawer does not balance. A gap with no explanation cannot be investigated a
                      week later.
                    </Text>
                  )}
                </View>

                {error && <Text style={styles.error}>{error}</Text>}

                <Pressable onPress={submit} disabled={!canSubmit} style={[styles.primary, !canSubmit && styles.primaryOff]}>
                  <Text style={[styles.primaryText, !canSubmit && styles.primaryTextOff]}>
                    {submitting ? 'Closing…' : mode === 'handover' ? 'Hand over' : `Close ${register?.name ?? 'register'}`}
                  </Text>
                </Pressable>
              </>
            )}
          </ScrollView>
        </View>
      </View>
    </AppModal>
  );
}

// Sign, word and glyph as well as colour. Colour alone fails deutan viewers,
// and this is the number that decides whether someone gets asked about their
// shift — it has to be unmistakable at a glance, in shop lighting.
function VarianceCard({ cents, label }: { cents: number; label: string }) {
  const tone = varianceTone(cents);
  const word = tone === 'balanced' ? 'Balances' : tone === 'short' ? 'Short' : 'Over';
  const glyph = tone === 'balanced' ? '✓' : tone === 'short' ? '↓' : '↑';
  const wash =
    tone === 'balanced' ? theme.bentoSoft : tone === 'short' ? theme.bentoDownWash : theme.bentoUpWash;
  const ink = tone === 'balanced' ? theme.bentoInk : tone === 'short' ? theme.bentoDownInk : theme.bentoUpInk;
  const sign = cents === 0 ? '' : cents < 0 ? '−' : '+';
  return (
    <View style={[styles.variance, { backgroundColor: wash }]}>
      <View style={[styles.varianceGlyph, { backgroundColor: ink }]}>
        <Text style={styles.varianceGlyphText}>{glyph}</Text>
      </View>
      <View>
        <Text style={[styles.varianceValue, { color: ink }]}>
          {sign}
          {formatCents(Math.abs(cents))}
        </Text>
        <Text style={[styles.varianceWord, { color: ink }]}>
          {word} — {label}
        </Text>
      </View>
    </View>
  );
}

function Row({ k, v, strong, rule }: { k: string; v: string; strong?: boolean; rule?: boolean }) {
  return (
    <View style={[styles.row, rule && styles.rowRule]}>
      <Text style={[styles.rowKey, strong && styles.rowKeyStrong]}>{k}</Text>
      <Text style={[styles.rowValue, strong && styles.rowValueStrong]}>{v}</Text>
    </View>
  );
}

function extractErrorMessage(err: unknown, fallback: string): string {
  if (err && typeof err === 'object' && 'message' in err && typeof (err as { message: unknown }).message === 'string') {
    return (err as { message: string }).message;
  }
  return fallback;
}

const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.35)', justifyContent: 'flex-end' },
  sheet: { backgroundColor: theme.bentoPage, borderTopLeftRadius: 24, borderTopRightRadius: 24, maxHeight: '92%' },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 16,
  },
  headTitle: { fontSize: 17, fontWeight: '800', letterSpacing: -0.4, color: theme.bentoInk },
  headBtn: { borderWidth: 1, borderColor: theme.bentoLine, borderRadius: 999, paddingHorizontal: 11, paddingVertical: 6 },
  headBtnText: { fontSize: 11.5, fontWeight: '700', color: theme.bentoInk2 },
  sub: { fontSize: 12, color: theme.bentoMuted, paddingHorizontal: 16, paddingTop: 4 },
  body: { padding: 16, paddingTop: 12, gap: 8 },
  block: { backgroundColor: theme.surface, borderRadius: BENTO_RADIUS_TILE, padding: 15 },
  label: {
    fontSize: 10.5,
    fontWeight: '700',
    letterSpacing: 0.7,
    textTransform: 'uppercase',
    color: theme.bentoMuted,
    marginBottom: 9,
  },
  hint: { fontSize: 11.5, color: theme.bentoMuted, marginTop: 9, lineHeight: 17 },
  chips: { flexDirection: 'row', gap: 7, flexWrap: 'wrap' },
  chip: {
    borderWidth: 1,
    borderColor: theme.bentoLine,
    borderRadius: 999,
    paddingHorizontal: 11,
    paddingVertical: 6,
    fontSize: 11.5,
    fontWeight: '700',
    color: theme.bentoInk2,
  },
  variance: { flexDirection: 'row', alignItems: 'center', gap: 13, borderRadius: BENTO_RADIUS_TILE, padding: 15 },
  varianceGlyph: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  varianceGlyphText: { color: '#fff', fontSize: 17, fontWeight: '800' },
  varianceValue: { fontSize: 26, fontWeight: '800', letterSpacing: -0.8 },
  varianceWord: { fontSize: 12, fontWeight: '700', marginTop: 1 },
  row: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: 10, paddingVertical: 6 },
  rowRule: { borderTopWidth: 1, borderTopColor: theme.bentoRule, marginTop: 6, paddingTop: 11 },
  rowKey: { fontSize: 13, color: theme.bentoMuted, flexShrink: 1 },
  rowKeyStrong: { color: theme.bentoInk, fontWeight: '800' },
  rowValue: { fontSize: 13, fontWeight: '700', color: theme.bentoInk },
  rowValueStrong: { fontWeight: '800' },
  fx: { backgroundColor: theme.bentoAccentWash, borderRadius: BENTO_RADIUS_TILE, padding: 15 },
  fxTitle: { fontSize: 13, fontWeight: '800', color: theme.bentoAccentInk, marginBottom: 3 },
  fxBody: { fontSize: 12, color: theme.bentoAccentInk, lineHeight: 18 },
  personOption: { borderWidth: 1, borderColor: theme.bentoLine, borderRadius: 12, padding: 10, marginBottom: 6 },
  personOptionOn: { borderColor: theme.bentoInk, borderWidth: 2, padding: 9 },
  personOptionText: { fontSize: 13, fontWeight: '700', color: theme.bentoInk2 },
  textarea: {
    borderWidth: 1,
    borderColor: theme.bentoRule,
    borderRadius: 14,
    paddingHorizontal: 13,
    paddingVertical: 11,
    fontSize: 13,
    color: theme.bentoInk,
    minHeight: 62,
  },
  primary: {
    marginTop: 4,
    backgroundColor: theme.bentoInk,
    borderRadius: 16,
    height: 54,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryOff: { backgroundColor: theme.bentoSoft },
  primaryText: { color: '#fff', fontSize: 15, fontWeight: '800', letterSpacing: -0.1 },
  primaryTextOff: { color: theme.bentoMuted2 },
  error: { color: theme.bentoLoss, fontSize: 12.5, fontWeight: '600' },
});
