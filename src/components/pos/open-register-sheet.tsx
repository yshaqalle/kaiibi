import { useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { DrawerCount, toDrawerEntries, type DrawerCountValue } from '@/components/pos/drawer-count';
import { StoreDropdown } from '@/components/store-dropdown';
import { AppModal } from '@/components/ui/app-modal';
import { useAuth } from '@/hooks/use-auth';
import { BENTO_RADIUS_TILE, Colors } from '@/constants/theme';
import { formatCents, formatForeignCents } from '@/lib/currency';
import { lastCloseFor, openRegisterSession } from '@/lib/registers';
import { BASE_CURRENCY, formatSessionWindow } from '@/lib/register-sessions';
import { shortPersonName } from '@/lib/user-identity';
import type { Currency, Register, RegisterSession, StaffMember } from '@/types/models';

// Pinned to the light palette for now — no dark-mode switching yet.
const theme = Colors.light;

// Two steps: pick a register, then count what is in it.
//
// A register already in use shows WHO has it and SINCE WHEN, so picking a busy
// one is not a mistake you discover after tapping. Whoever opens it is the
// person on it; opening it for somebody else is a supervisory act and needs
// registers.manage, which is why the person row only becomes a picker for
// someone holding that.

// Mounted only while it is open, and keyed by the parent — so every field below
// initialises straight from props on mount instead of needing an effect to reset
// them, which is the same reasoning LocationsPanel's editor modal gives.
export function OpenRegisterSheet({
  registers,
  sessionsByRegister,
  team,
  myMembership,
  fallbackName,
  canManageRegisters,
  currencies,
  denominations,
  onClose,
  onOpened,
}: {
  registers: Register[];
  sessionsByRegister: Record<string, RegisterSession>;
  team: StaffMember[];
  myMembership: StaffMember | null;
  // An owner has no membership, so `person` below resolves to null and this is
  // what names them. Without it the sheet reads "Signed in".
  fallbackName?: string | null;
  canManageRegisters: boolean;
  currencies: Currency[];
  denominations: Record<string, number[]>;
  onClose: () => void;
  onOpened: () => Promise<void>;
}) {
  // Which store's registers these are. A register belongs to a branch, so
  // choosing a store here MOVES THE COUNTER to it rather than just filtering the
  // list -- `activeLocation` is what a sale gets recorded against, and opening a
  // register at a branch the POS is not on would pass here and then have
  // complete_sale refuse every sale for being at a different location. The
  // cashier would meet that at checkout, with a customer waiting.
  //
  // StoreDropdown renders nothing for a single-store business, which is the
  // whole behaviour there: one store, no question to ask.
  const { locations, activeLocation, setActiveLocation } = useAuth();

  const free = registers.filter((register) => !sessionsByRegister[register.id]);

  const [step, setStep] = useState<'pick' | 'count'>('pick');
  const [pickedId, setPickedId] = useState<string | null>(free[0]?.id ?? null);
  // Switching store swaps the whole list underneath, so a register picked at the
  // previous branch is no longer a valid choice. Derived rather than reset in an
  // effect: falling back to the first free register here is one expression, and
  // an effect would fire a second render every time the store changed.
  const registerId = registers.some((register) => register.id === pickedId) ? pickedId : (free[0]?.id ?? null);
  const setRegisterId = setPickedId;
  const [memberId, setMemberId] = useState<string | null>(myMembership?.id ?? null);
  const [pickingPerson, setPickingPerson] = useState(false);
  const [count, setCount] = useState<DrawerCountValue>({});
  const [extraCodes, setExtraCodes] = useState<string[]>([]);
  const [note, setNote] = useState('');
  const [lastClose, setLastClose] = useState<RegisterSession | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The float pre-fills from what this register was last closed at, because
  // overnight that is physically the same money. Its provenance is shown next
  // to the field rather than presented as a bare default -- it is wrong the day
  // someone banks the takings, and the opener has to notice and correct it.
  useEffect(() => {
    let cancelled = false;
    if (!registerId || step !== 'count') return;
    lastCloseFor(registerId)
      .then((session) => {
        if (cancelled || !session) return;
        setLastClose(session);
        const seeded: DrawerCountValue = {};
        for (const row of session.cash) {
          if (row.closingCountedMinor == null || row.closingCountedMinor === 0) continue;
          seeded[row.currencyCode] = { amount: minorToInput(row.closingCountedMinor), counts: {} };
        }
        setCount((current) => (Object.keys(current).length > 0 ? current : seeded));
        setExtraCodes(session.cash.map((row) => row.currencyCode));
      })
      .catch(() => {
        // A missing previous close is not an error worth showing: it just means
        // this register has never been closed, so there is nothing to pre-fill.
      });
    return () => {
      cancelled = true;
    };
  }, [registerId, step]);

  const codes = useMemo(() => {
    const set = new Set<string>([BASE_CURRENCY, ...extraCodes, ...Object.keys(count)]);
    return [...set].sort((a, b) => (a === BASE_CURRENCY ? -1 : b === BASE_CURRENCY ? 1 : a.localeCompare(b)));
  }, [extraCodes, count]);

  const addableCurrency = currencies.find((currency) => currency.active && !codes.includes(currency.code));

  const submit = async () => {
    if (!registerId) return;
    setSubmitting(true);
    setError(null);
    try {
      await openRegisterSession(registerId, memberId, toDrawerEntries(count, codes, currencies), note);
      await onOpened();
      onClose();
    } catch (err) {
      setError(extractErrorMessage(err, 'Could not open this register.'));
    } finally {
      setSubmitting(false);
    }
  };

  const selected = registers.find((register) => register.id === registerId) ?? null;
  const person = team.find((member) => member.id === memberId) ?? myMembership;
  // Named on every row, not only in the dropdown above: the store is the thing
  // that decides where the money lands, and it should not require scrolling back
  // up to confirm. Only for a business with more than one -- a single-store shop
  // would just be reading its own name back on every line.
  const storeNames: Record<string, string> =
    locations.length > 1 ? Object.fromEntries(locations.map((l) => [l.id, l.name])) : {};

  return (
    <AppModal visible animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View style={styles.sheet}>
          <View style={styles.head}>
            <Text style={styles.headTitle}>{step === 'pick' ? 'Open a register' : 'Count the float'}</Text>
            <Pressable onPress={step === 'pick' ? onClose : () => setStep('pick')} style={styles.headBtn}>
              <Text style={styles.headBtnText}>{step === 'pick' ? 'Close' : 'Back'}</Text>
            </Pressable>
          </View>

          <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
            {step === 'pick' ? (
              <>
                <View style={styles.block}>
                  <Text style={styles.label}>Which store</Text>
                  <StoreDropdown
                    value={activeLocation?.id ?? null}
                    onChange={(locationId) => locationId && setActiveLocation(locationId)}
                    allowAll={false}
                    variant="field"
                    title="Open a register at"
                    placeholder="Choose a store"
                  />
                  <Text style={styles.hint}>
                    The counter moves with it: sales, stock and this register all belong to the store shown here.
                  </Text>
                </View>

                <View style={styles.block}>
                  <Text style={styles.label}>Which register</Text>
                  {registers.length === 0 && (
                    <Text style={styles.hint}>
                      No registers at this store yet. Someone with settings access can add one under Settings →
                      Registers.
                    </Text>
                  )}
                  {registers.map((register) => {
                    const busy = sessionsByRegister[register.id];
                    const on = register.id === registerId;
                    return (
                      <Pressable
                        key={register.id}
                        onPress={() => !busy && setRegisterId(register.id)}
                        style={[styles.registerRow, on && styles.registerRowOn, busy && styles.registerRowBusy]}
                      >
                        <View style={[styles.rowDot, busy && styles.rowDotBusy]} />
                        <View style={styles.registerBody}>
                          <Text style={styles.registerName}>
                            {register.name}
                            {register.kind === 'mobile' ? '  ·  mobile' : ''}
                          </Text>
                          <Text style={styles.registerMeta}>
                            {storeNames[register.locationId] ? `${storeNames[register.locationId]} · ` : ''}
                            {busy
                              ? `In use · ${formatSessionWindow(busy.openedAt)}`
                              : describeLastClose(register, null)}
                          </Text>
                        </View>
                        <Text style={[styles.registerTail, busy ? styles.tailTaken : styles.tailFree]}>
                          {busy ? 'In use' : 'Free'}
                        </Text>
                      </Pressable>
                    );
                  })}
                  <Text style={styles.hint}>
                    A register already in use can only be taken over by a manager, and taking it over closes it with a
                    count first — the money cannot change hands without a boundary.
                  </Text>
                </View>

                <View style={styles.block}>
                  <Text style={styles.label}>Who is on it</Text>
                  <View style={styles.person}>
                    <View style={styles.personBody}>
                      <Text style={styles.personName}>
                        {shortPersonName(person?.fullName ?? fallbackName, person?.email)}
                        {person?.id === myMembership?.id ? '  ·  you' : ''}
                      </Text>
                      <Text style={styles.personMeta}>{person?.roleName ?? 'Staff'}</Text>
                    </View>
                    {canManageRegisters && team.length > 1 && (
                      <Pressable onPress={() => setPickingPerson((open) => !open)} style={styles.headBtn}>
                        <Text style={styles.headBtnText}>{pickingPerson ? 'Done' : 'Change'}</Text>
                      </Pressable>
                    )}
                  </View>
                  {pickingPerson &&
                    team.map((member) => (
                      <Pressable
                        key={member.id}
                        onPress={() => {
                          setMemberId(member.id);
                          setPickingPerson(false);
                        }}
                        style={[styles.personOption, member.id === memberId && styles.personOptionOn]}
                      >
                        <Text style={styles.personOptionText}>{member.fullName ?? member.email ?? 'Staff'}</Text>
                      </Pressable>
                    ))}
                  {!canManageRegisters && (
                    <Text style={styles.hint}>
                      Opening a register for someone else needs the &ldquo;manage registers&rdquo; permission.
                    </Text>
                  )}
                </View>

                <Pressable
                  onPress={() => setStep('count')}
                  disabled={!registerId}
                  style={[styles.primary, !registerId && styles.primaryOff]}
                >
                  <Text style={[styles.primaryText, !registerId && styles.primaryTextOff]}>Next · count the float</Text>
                </Pressable>
              </>
            ) : (
              <>
                <Text style={styles.sub}>
                  {selected?.name}
                  {storeNames[selected?.locationId ?? ''] ? ` · ${storeNames[selected!.locationId]}` : ''} ·{' '}
                  {shortPersonName(person?.fullName ?? fallbackName, person?.email)}
                </Text>

                <DrawerCount
                  currencyCodes={codes}
                  currencies={currencies}
                  denominations={denominations}
                  value={count}
                  onChange={setCount}
                  onAddCurrency={addableCurrency ? () => setExtraCodes((c) => [...c, addableCurrency.code]) : undefined}
                  autoFocusFirst
                />

                {lastClose && <Text style={styles.hint}>{describeLastClose(selected, lastClose, currencies)}</Text>}

                <View style={styles.block}>
                  <Text style={styles.label}>Note — optional</Text>
                  <TextInput
                    value={note}
                    onChangeText={setNote}
                    placeholder="e.g. topped up with $30 from the safe"
                    placeholderTextColor={theme.bentoMuted2}
                    multiline
                    style={styles.textarea}
                  />
                </View>

                {error && <Text style={styles.error}>{error}</Text>}

                <Pressable onPress={submit} disabled={submitting} style={[styles.primary, submitting && styles.primaryOff]}>
                  <Text style={[styles.primaryText, submitting && styles.primaryTextOff]}>
                    {submitting ? 'Opening…' : `Open ${selected?.name ?? 'register'}`}
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

function describeLastClose(
  register: Register | null,
  session: RegisterSession | null,
  currencies: Currency[] = []
): string {
  if (!register) return '';
  if (!session) return 'Never opened yet';
  const parts = session.cash
    .filter((row) => row.closingCountedMinor != null)
    .map((row) => {
      const currency = currencies.find((c) => c.code === row.currencyCode);
      return currency
        ? formatForeignCents(row.closingCountedMinor ?? 0, currency.symbol)
        : formatCents(row.closingCountedMinor ?? 0);
    });
  if (parts.length === 0) return 'Last closed with nothing in the drawer';
  return `${register.name} was closed at ${parts.join(' + ')}. If the takings were banked or the float topped up, type what is actually there.`;
}

function minorToInput(minor: number): string {
  return (minor / 100).toFixed(2);
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
    paddingBottom: 4,
  },
  headTitle: { fontSize: 17, fontWeight: '800', letterSpacing: -0.4, color: theme.bentoInk },
  headBtn: { borderWidth: 1, borderColor: theme.bentoLine, borderRadius: 999, paddingHorizontal: 11, paddingVertical: 6 },
  headBtnText: { fontSize: 11.5, fontWeight: '700', color: theme.bentoInk2 },
  body: { padding: 16, paddingTop: 8, gap: 8 },
  sub: { fontSize: 12, color: theme.bentoMuted, marginBottom: 4 },
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
  registerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 11,
    borderWidth: 1,
    borderColor: theme.bentoLine,
    borderRadius: BENTO_RADIUS_TILE,
    padding: 12,
    marginBottom: 8,
  },
  registerRowOn: { borderWidth: 2, borderColor: theme.bentoInk, padding: 11 },
  registerRowBusy: { backgroundColor: theme.bentoSoft },
  rowDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: theme.bentoMuted2 },
  rowDotBusy: { backgroundColor: theme.bentoProfit },
  registerBody: { flex: 1, minWidth: 0 },
  registerName: { fontSize: 13.5, fontWeight: '800', letterSpacing: -0.1, color: theme.bentoInk },
  registerMeta: { fontSize: 11.5, color: theme.bentoMuted, marginTop: 1 },
  registerTail: { fontSize: 11, fontWeight: '800' },
  tailFree: { color: theme.bentoProfit },
  tailTaken: { color: theme.bentoMuted2 },
  person: { flexDirection: 'row', alignItems: 'center', gap: 11 },
  personBody: { flex: 1, minWidth: 0 },
  personName: { fontSize: 13.5, fontWeight: '700', color: theme.bentoInk },
  personMeta: { fontSize: 11.5, color: theme.bentoMuted, marginTop: 1 },
  personOption: {
    borderWidth: 1,
    borderColor: theme.bentoLine,
    borderRadius: 12,
    padding: 10,
    marginTop: 6,
  },
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
