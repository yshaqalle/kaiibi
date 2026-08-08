import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { SegmentedControl } from '@/components/segmented-control';
import { BENTO_RADIUS_TILE, Colors } from '@/constants/theme';
import { formatCents, formatForeignCents, toCents } from '@/lib/currency';
import { OTHER_DENOMINATION, denominationsFor, tallyTotalMinor } from '@/lib/register-sessions';
import type { Currency, DrawerCountEntry } from '@/types/models';

// Pinned to the light palette for now — no dark-mode switching yet.
const theme = Colors.light;

// Counting a drawer, one currency per block.
//
// Two modes, because both are real. A kiosk with six notes in the till wants to
// type one number; a busy counter at 9pm wants to enter "$20 × 4" and not hold
// a running sum in their head, which is where the errors come from. Forcing
// either on the other makes the fast path slower or the careful path careless.
//
// The running tally IS the counted figure — there is no separate confirm step
// for the two to drift apart in.

export type DrawerCountValue = Record<string, { amount: string; counts: Record<string, string> }>;

type Mode = 'figure' | 'notes';

export function DrawerCount({
  currencyCodes,
  currencies,
  denominations,
  value,
  onChange,
  onAddCurrency,
  onRememberNote,
  autoFocusFirst,
}: {
  // Which currencies to ask about, in order. Base currency first — see
  // `currenciesToCount`, which decides this from what the session actually saw.
  currencyCodes: string[];
  currencies: Currency[];
  denominations: Record<string, number[]>;
  value: DrawerCountValue;
  onChange: (next: DrawerCountValue) => void;
  // Offered only when there is a currency the drawer could hold but isn't
  // counting yet. Absent on the close sheet when nothing else is available.
  onAddCurrency?: () => void;
  // Persists an ad-hoc note to the shop's list. Absent for someone without
  // settings access — they can still count with the note, they just cannot
  // rewrite a shop setting to do it.
  onRememberNote?: (currencyCode: string, minor: number) => void;
  autoFocusFirst?: boolean;
}) {
  if (currencyCodes.length === 0) {
    return (
      <View style={styles.nothing}>
        <Text style={styles.nothingTitle}>Nothing to count</Text>
        <Text style={styles.nothingBody}>
          This session took no cash and opened with no float. Everything settled through mobile money, which never
          passed through anyone&rsquo;s hands.
        </Text>
      </View>
    );
  }

  return (
    <View style={styles.stack}>
      {currencyCodes.map((code, index) => (
        <CurrencyBlock
          key={code}
          code={code}
          currency={currencies.find((c) => c.code === code) ?? null}
          notes={denominationsFor(denominations, code)}
          entry={value[code] ?? { amount: '', counts: {} }}
          onChange={(entry) => onChange({ ...value, [code]: entry })}
          onRememberNote={onRememberNote ? (minor) => onRememberNote(code, minor) : undefined}
          autoFocus={autoFocusFirst && index === 0}
        />
      ))}
      {onAddCurrency && (
        <Pressable onPress={onAddCurrency} style={styles.addCurrency}>
          <Text style={styles.addCurrencyText}>+ Add another currency</Text>
        </Pressable>
      )}
    </View>
  );
}

function CurrencyBlock({
  code,
  currency,
  notes,
  entry,
  onChange,
  onRememberNote,
  autoFocus,
}: {
  code: string;
  currency: Currency | null;
  notes: number[];
  entry: { amount: string; counts: Record<string, string> };
  onChange: (entry: { amount: string; counts: Record<string, string> }) => void;
  onRememberNote?: (minor: number) => void;
  autoFocus?: boolean;
}) {
  const [mode, setMode] = useState<Mode>('figure');
  // Notes added here rather than in Settings. A seeded list is guaranteed to be
  // wrong somewhere, and when it is, the person is holding a note the app
  // refuses to acknowledge — so it goes into the catch-all, the breakdown stops
  // meaning anything, and the one artefact that solves next week's variance is
  // gone. This fixes it where the problem happens: in the drawer.
  const [added, setAdded] = useState<number[]>([]);
  const [adding, setAdding] = useState(false);
  const [newNote, setNewNote] = useState('');
  const [remembered, setRemembered] = useState(false);

  const rows = useMemo(() => {
    const all = [...new Set([...notes, ...added])];
    return all.sort((a, b) => b - a);
  }, [notes, added]);

  const tallyMinor = tallyTotalMinor(entry.counts);
  const isBase = currency == null;
  const format = (minor: number) => (isBase ? formatCents(minor) : formatForeignCents(minor, currency.symbol));

  const commitNote = () => {
    const minor = toCents(newNote);
    setNewNote('');
    setAdding(false);
    if (minor <= 0) return;
    if (rows.includes(minor)) return;
    setAdded((previous) => [...previous, minor]);
  };

  return (
    <View style={styles.block}>
      <View style={styles.blockHead}>
        <Text style={styles.blockTitle}>{currency ? currency.name : 'US Dollars'}</Text>
        <Text style={styles.blockTag}>{currency ? currency.symbol : '$'}</Text>
      </View>

      <SegmentedControl
        options={[
          { key: 'figure' as Mode, label: 'One figure' },
          { key: 'notes' as Mode, label: 'Note by note' },
        ]}
        value={mode}
        onChange={setMode}
      />

      {mode === 'figure' ? (
        <View style={styles.figureRow}>
          <Text style={styles.figureSymbol}>{currency ? currency.symbol : '$'}</Text>
          <TextInput
            value={entry.amount}
            onChangeText={(amount) => onChange({ ...entry, amount })}
            placeholder={isBase ? '0.00' : '0'}
            placeholderTextColor={theme.bentoMuted2}
            keyboardType="decimal-pad"
            autoFocus={autoFocus}
            style={styles.figureInput}
            accessibilityLabel={`Cash counted in ${code}`}
          />
        </View>
      ) : (
        <View>
          {rows.map((note) => (
            <View key={note} style={styles.noteRow}>
              <View style={[styles.notePill, added.includes(note) && styles.notePillAdded]}>
                <Text style={[styles.notePillText, added.includes(note) && styles.notePillTextAdded]}>
                  {format(note)}
                </Text>
              </View>
              <Text style={styles.times}>×</Text>
              <TextInput
                value={entry.counts[note] ?? ''}
                onChangeText={(count) => onChange({ ...entry, counts: { ...entry.counts, [note]: count } })}
                placeholder="0"
                placeholderTextColor={theme.bentoMuted2}
                keyboardType="number-pad"
                style={styles.countInput}
                accessibilityLabel={`How many ${format(note)} notes`}
              />
              <Text style={styles.extended}>
                {format(note * Math.max(0, Number.parseInt(entry.counts[note] ?? '0', 10) || 0))}
              </Text>
            </View>
          ))}

          {/* A plain amount, not a count. Coins, a torn note, anything that is
              not one of the shop's notes — so the tally can always reconcile to
              what is actually in the drawer instead of quietly disagreeing. */}
          <View style={styles.noteRow}>
            <View style={styles.notePill}>
              <Text style={styles.notePillOther}>Other</Text>
            </View>
            <Text style={styles.times}>=</Text>
            <TextInput
              value={entry.counts[OTHER_DENOMINATION] ?? ''}
              onChangeText={(amount) =>
                onChange({
                  ...entry,
                  counts: { ...entry.counts, [OTHER_DENOMINATION]: String(toCents(amount) || '') },
                })
              }
              placeholder="0"
              placeholderTextColor={theme.bentoMuted2}
              keyboardType="decimal-pad"
              style={styles.countInput}
              accessibilityLabel={`Coins and other cash in ${code}`}
            />
            <Text style={styles.extended}>{format(Number(entry.counts[OTHER_DENOMINATION] ?? 0) || 0)}</Text>
          </View>

          {adding ? (
            <View style={styles.noteRow}>
              <TextInput
                value={newNote}
                onChangeText={setNewNote}
                onBlur={commitNote}
                onSubmitEditing={commitNote}
                placeholder={isBase ? 'Note value, e.g. 200' : 'Note value, e.g. 10000'}
                placeholderTextColor={theme.bentoMuted2}
                keyboardType="decimal-pad"
                autoFocus
                style={styles.newNoteInput}
                accessibilityLabel={`New note value for ${code}`}
              />
              <Pressable onPress={commitNote} style={styles.addNoteConfirm}>
                <Text style={styles.addNoteConfirmText}>Add</Text>
              </Pressable>
            </View>
          ) : (
            <Pressable onPress={() => setAdding(true)} style={styles.addNote}>
              <Text style={styles.addNoteText}>+ Add a note</Text>
            </Pressable>
          )}

          {/* Offered only once a note has actually been added, and only to
              someone who may edit settings. Without it an added note is good for
              this count alone and has to be re-added tomorrow — and the stored
              breakdown, which is what solves a variance a week later, quietly
              loses a denomination. */}
          {added.length > 0 && onRememberNote && (
            <Pressable
              onPress={() => {
                added.forEach(onRememberNote);
                setRemembered(true);
              }}
              disabled={remembered}
              style={styles.remember}
            >
              <View style={[styles.rememberBox, remembered && styles.rememberBoxOn]}>
                <Text style={styles.rememberTick}>{remembered ? '✓' : ''}</Text>
              </View>
              <Text style={styles.rememberText}>
                {remembered
                  ? `Saved ${added.map((note) => format(note)).join(' and ')} for next time`
                  : `Remember ${added.map((note) => format(note)).join(' and ')} for next time`}
              </Text>
            </Pressable>
          )}

          <View style={styles.tallyTotal}>
            <Text style={styles.tallyLabel}>Counted</Text>
            <Text style={styles.tallyValue}>{format(tallyMinor)}</Text>
          </View>
        </View>
      )}
    </View>
  );
}

/**
 * Turns what was typed into the payload the RPCs take.
 *
 * The mode is not carried through: whichever one the person used, what leaves
 * here is a figure per currency plus, when they tallied, the breakdown that
 * produced it. Keeping the breakdown matters — "one $5 note fewer than the last
 * count" is the sentence that solves a $5 variance a week later.
 */
export function toDrawerEntries(
  value: DrawerCountValue,
  currencyCodes: string[],
  currencies: Currency[]
): DrawerCountEntry[] {
  return currencyCodes.map((code) => {
    const entry = value[code] ?? { amount: '', counts: {} };
    const tallied = tallyTotalMinor(entry.counts);
    const typed = toCents(entry.amount);
    const hasTally = Object.values(entry.counts).some((count) => (Number.parseInt(count, 10) || 0) > 0);
    const currency = currencies.find((c) => c.code === code) ?? null;
    return {
      currencyCode: code,
      amountMinor: hasTally ? tallied : typed,
      rateToUsd: currency ? currency.rateToUsd : 1,
      denominations: hasTally ? normalizeCounts(entry.counts) : null,
    };
  });
}

function normalizeCounts(counts: Record<string, string>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, raw] of Object.entries(counts)) {
    const value = Number.parseInt(raw, 10);
    if (!Number.isFinite(value) || value <= 0) continue;
    out[key] = value;
  }
  return out;
}

const styles = StyleSheet.create({
  stack: { gap: 8 },
  block: { backgroundColor: theme.surface, borderRadius: BENTO_RADIUS_TILE, padding: 15 },
  blockHead: { flexDirection: 'row', alignItems: 'center', gap: 9, marginBottom: 10 },
  blockTitle: { fontSize: 14, fontWeight: '800', letterSpacing: -0.1, color: theme.bentoInk, flex: 1 },
  blockTag: {
    fontSize: 10.5,
    fontWeight: '800',
    letterSpacing: 0.6,
    color: theme.bentoMuted,
    backgroundColor: theme.bentoSoft,
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  figureRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderWidth: 1,
    borderColor: theme.bentoRule,
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  figureSymbol: { fontSize: 19, fontWeight: '800', color: theme.bentoMuted2 },
  figureInput: { flex: 1, fontSize: 28, fontWeight: '800', letterSpacing: -0.8, color: theme.bentoInk, padding: 0 },
  noteRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: theme.bentoRule,
  },
  notePill: {
    minWidth: 68,
    borderWidth: 1,
    borderColor: theme.bentoRule,
    backgroundColor: theme.bentoSoft,
    borderRadius: 8,
    paddingVertical: 5,
    paddingHorizontal: 6,
    alignItems: 'center',
  },
  notePillAdded: { borderStyle: 'dashed', borderColor: theme.bentoAccentInk, backgroundColor: theme.bentoAccentWash },
  notePillText: { fontSize: 12, fontWeight: '800', color: theme.bentoInk },
  notePillTextAdded: { color: theme.bentoAccentInk },
  notePillOther: { fontSize: 11, fontWeight: '700', color: theme.bentoMuted },
  times: { fontSize: 12, color: theme.bentoMuted2 },
  countInput: {
    width: 70,
    borderWidth: 1,
    borderColor: theme.bentoRule,
    borderRadius: 10,
    paddingVertical: 7,
    textAlign: 'center',
    fontSize: 15,
    fontWeight: '800',
    color: theme.bentoInk,
  },
  extended: { marginLeft: 'auto', fontSize: 13, fontWeight: '700', color: theme.bentoInk },
  newNoteInput: {
    flex: 1,
    borderWidth: 1,
    borderColor: theme.bentoRule,
    borderRadius: 10,
    paddingVertical: 8,
    paddingHorizontal: 12,
    fontSize: 14,
    color: theme.bentoInk,
  },
  addNoteConfirm: { backgroundColor: theme.bentoInk, borderRadius: 999, paddingVertical: 8, paddingHorizontal: 14 },
  addNoteConfirmText: { color: '#fff', fontSize: 12.5, fontWeight: '800' },
  addNote: {
    marginTop: 11,
    alignSelf: 'flex-start',
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: theme.bentoRule,
    borderRadius: 999,
    paddingVertical: 8,
    paddingHorizontal: 14,
  },
  addNoteText: { fontSize: 12.5, fontWeight: '700', color: theme.bentoInk2 },
  remember: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 11 },
  rememberBox: {
    width: 17,
    height: 17,
    borderRadius: 5,
    borderWidth: 1,
    borderColor: theme.bentoRule,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rememberBoxOn: { backgroundColor: theme.bentoInk, borderColor: theme.bentoInk },
  rememberTick: { color: '#fff', fontSize: 10, fontWeight: '800' },
  rememberText: { fontSize: 11.5, color: theme.bentoMuted, flex: 1 },
  addCurrency: {
    alignSelf: 'flex-start',
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: theme.bentoRule,
    borderRadius: 999,
    paddingVertical: 8,
    paddingHorizontal: 14,
  },
  addCurrencyText: { fontSize: 12.5, fontWeight: '700', color: theme.bentoInk2 },
  tallyTotal: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    marginTop: 11,
    paddingTop: 12,
    borderTopWidth: 2,
    borderTopColor: theme.bentoInk,
  },
  tallyLabel: { fontSize: 13, fontWeight: '800', color: theme.bentoInk },
  tallyValue: { fontSize: 26, fontWeight: '800', letterSpacing: -0.9, color: theme.bentoInk },
  nothing: { backgroundColor: theme.bentoSoft, borderRadius: BENTO_RADIUS_TILE, padding: 20, alignItems: 'center' },
  nothingTitle: { fontSize: 14, fontWeight: '800', color: theme.bentoInk, marginBottom: 4 },
  nothingBody: { fontSize: 12, color: theme.bentoMuted, textAlign: 'center', lineHeight: 18 },
});
