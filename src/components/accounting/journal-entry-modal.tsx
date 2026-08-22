import { useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { DateInput, parseDateInput } from '@/components/date-input';
import { StorePicker } from '@/components/store-picker';
import { AppModal } from '@/components/ui/app-modal';
import { Colors } from '@/constants/theme';
import { useAuth } from '@/hooks/use-auth';
import { formatAccountingCents, toCents } from '@/lib/currency';
import { postJournalEntry } from '@/lib/ledger';
import { toDateColumn } from '@/lib/period';
import type { LedgerAccount } from '@/types/models';

const theme = Colors.light;

// Writing a general journal entry.
//
// The design problem this form has and no other form in the app has: the thing
// being typed is only valid AS A WHOLE. Every individual field can be
// reasonable while the entry is nonsense, and the reader has to be able to see
// why at a glance rather than on a failed save. So the running total sits at
// the bottom, always, saying what is out of balance and by how much, and the
// post button is simply unavailable until it says nothing.
//
// A blank line's amount is the other half of that. Each row is a debit box and
// a credit box, and typing in one clears the other, because a line carrying
// both is two lines someone collapsed -- which the database refuses anyway.

type DraftLine = {
  /** Local only. Rows are reordered and removed, so index is not an identity. */
  key: string;
  accountId: string | null;
  debit: string;
  credit: string;
  memo: string;
};

function blankLine(key: string): DraftLine {
  return { key, accountId: null, debit: '', credit: '', memo: '' };
}

function extractErrorMessage(err: unknown, fallback: string): string {
  if (err && typeof err === 'object' && 'message' in err && typeof (err as { message: unknown }).message === 'string') {
    return (err as { message: string }).message;
  }
  return fallback;
}

export function JournalEntryModal({
  accounts,
  onClose,
  onPosted,
}: {
  /** Already filtered to what may be posted to — see `postableAccounts`. */
  accounts: LedgerAccount[];
  onClose: () => void;
  onPosted: () => Promise<void> | void;
}) {
  const { shop } = useAuth();
  const [entryDate, setEntryDate] = useState(toDateColumn(new Date()));
  const [memo, setMemo] = useState('');
  const [reference, setReference] = useState('');
  const [locationId, setLocationId] = useState<string | null>(null);
  // Two, because two is the smallest entry that can balance and starting with
  // one row invites someone to try.
  const [lines, setLines] = useState<DraftLine[]>([blankLine('1'), blankLine('2')]);
  const [nextKey, setNextKey] = useState(3);
  const [picking, setPicking] = useState<string | null>(null);
  const [posting, setPosting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const accountsById = useMemo(() => new Map(accounts.map((a) => [a.id, a])), [accounts]);

  const totals = useMemo(() => {
    let debits = 0;
    let credits = 0;
    let filled = 0;
    for (const line of lines) {
      const debit = line.debit.trim() === '' ? 0 : toCents(line.debit);
      const credit = line.credit.trim() === '' ? 0 : toCents(line.credit);
      debits += debit;
      credits += credit;
      if (line.accountId && debit + credit > 0) filled += 1;
    }
    return { debits, credits, filled, difference: debits - credits };
  }, [lines]);

  const dateValid = parseDateInput(entryDate) !== null;
  const canPost = totals.filled >= 2 && totals.difference === 0 && totals.debits > 0 && dateValid && !posting;

  const patchLine = (key: string, patch: Partial<DraftLine>) => {
    setLines((current) => current.map((line) => (line.key === key ? { ...line, ...patch } : line)));
  };

  const addLine = () => {
    setLines((current) => [...current, blankLine(String(nextKey))]);
    setNextKey((n) => n + 1);
  };

  const removeLine = (key: string) => {
    // Never below two: the form would then be showing an entry that cannot be
    // posted with no way to see why.
    setLines((current) => (current.length <= 2 ? current : current.filter((line) => line.key !== key)));
  };

  const post = async () => {
    if (!canPost || !shop) return;
    setPosting(true);
    setError(null);
    try {
      await postJournalEntry(shop.id, {
        entryDate,
        memo: memo.trim() || null,
        reference: reference.trim() || null,
        locationId,
        lines: lines
          .filter((line) => line.accountId && (line.debit.trim() !== '' || line.credit.trim() !== ''))
          .map((line) => ({
            accountId: line.accountId!,
            debitCents: line.debit.trim() === '' ? 0 : toCents(line.debit),
            creditCents: line.credit.trim() === '' ? 0 : toCents(line.credit),
            memo: line.memo.trim() || null,
          })),
      });
      await onPosted();
    } catch (err) {
      setError(extractErrorMessage(err, 'Could not post this entry.'));
      setPosting(false);
    }
  };

  return (
    <AppModal visible animationType="fade" transparent onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View style={styles.card}>
          <View style={styles.header}>
            <Text style={styles.title}>New journal entry</Text>
            <Pressable onPress={onClose} style={styles.close}>
              <Text style={styles.closeText}>Close</Text>
            </Pressable>
          </View>

          <ScrollView style={styles.body}>
            <View style={styles.fieldRow}>
              <View style={styles.fieldHalf}>
                <Text style={styles.fieldLabel}>DATE</Text>
                <DateInput value={entryDate} onChangeText={setEntryDate} />
              </View>
              <View style={styles.fieldHalf}>
                <Text style={styles.fieldLabel}>REFERENCE</Text>
                <TextInput
                  value={reference}
                  onChangeText={setReference}
                  placeholder="Cheque no., statement line…"
                  placeholderTextColor={theme.bentoMuted2}
                  style={styles.input}
                />
              </View>
            </View>

            <Text style={[styles.fieldLabel, styles.fieldLabelSpaced]}>MEMO</Text>
            <TextInput
              value={memo}
              onChangeText={setMemo}
              placeholder="What is this entry for?"
              placeholderTextColor={theme.bentoMuted2}
              style={styles.input}
            />

            <View style={styles.storeBlock}>
              <StorePicker value={locationId} onChange={setLocationId} />
            </View>

            <Text style={[styles.fieldLabel, styles.fieldLabelSpaced]}>LINES</Text>
            {accounts.length === 0 ? (
              <Text style={styles.hint}>
                Every account in this chart reports a live figure, so there is nothing to post to by hand. Add an
                account — capital, a loan, an accrual — and it becomes available here.
              </Text>
            ) : null}

            {lines.map((line) => {
              const account = line.accountId ? accountsById.get(line.accountId) : null;
              return (
                <View key={line.key} style={styles.lineBlock}>
                  <View style={styles.lineTop}>
                    <Pressable
                      onPress={() => setPicking(picking === line.key ? null : line.key)}
                      style={styles.accountButton}
                    >
                      <Text style={[styles.accountButtonText, !account && styles.accountButtonPlaceholder]} numberOfLines={1}>
                        {account ? `${account.code}  ${account.name}` : 'Choose an account'}
                      </Text>
                    </Pressable>
                    {lines.length > 2 && (
                      <Pressable onPress={() => removeLine(line.key)} style={styles.removeButton}>
                        <Text style={styles.removeText}>✕</Text>
                      </Pressable>
                    )}
                  </View>

                  {picking === line.key && (
                    <View style={styles.accountList}>
                      {accounts.map((option) => (
                        <Pressable
                          key={option.id}
                          onPress={() => {
                            patchLine(line.key, { accountId: option.id });
                            setPicking(null);
                          }}
                          style={styles.accountOption}
                        >
                          <Text style={styles.accountOptionText} numberOfLines={1}>{`${option.code}  ${option.name}`}</Text>
                        </Pressable>
                      ))}
                    </View>
                  )}

                  <View style={styles.amountRow}>
                    <TextInput
                      value={line.debit}
                      // Typing in one side clears the other. A line carrying
                      // both is rejected by the database, and clearing beats
                      // explaining.
                      onChangeText={(text) => patchLine(line.key, { debit: text, credit: text.trim() === '' ? line.credit : '' })}
                      placeholder="Debit"
                      placeholderTextColor={theme.bentoMuted2}
                      keyboardType="decimal-pad"
                      style={[styles.input, styles.amountInput]}
                    />
                    <TextInput
                      value={line.credit}
                      onChangeText={(text) => patchLine(line.key, { credit: text, debit: text.trim() === '' ? line.debit : '' })}
                      placeholder="Credit"
                      placeholderTextColor={theme.bentoMuted2}
                      keyboardType="decimal-pad"
                      style={[styles.input, styles.amountInput]}
                    />
                  </View>

                  <TextInput
                    value={line.memo}
                    onChangeText={(text) => patchLine(line.key, { memo: text })}
                    placeholder="Line note (optional)"
                    placeholderTextColor={theme.bentoMuted2}
                    style={[styles.input, styles.lineMemoInput]}
                  />
                </View>
              );
            })}

            <Pressable onPress={addLine} style={styles.addLineButton}>
              <Text style={styles.addLineText}>+ Add line</Text>
            </Pressable>

            <View style={styles.totals}>
              <View style={styles.totalsRow}>
                <Text style={styles.totalsLabel}>Debits</Text>
                <Text style={styles.totalsValue}>{formatAccountingCents(totals.debits)}</Text>
              </View>
              <View style={styles.totalsRow}>
                <Text style={styles.totalsLabel}>Credits</Text>
                <Text style={styles.totalsValue}>{formatAccountingCents(totals.credits)}</Text>
              </View>
              <View style={[styles.totalsRow, styles.totalsRowLast]}>
                <Text style={styles.totalsLabelStrong}>
                  {totals.difference === 0 ? 'Balanced' : 'Out of balance'}
                </Text>
                <Text style={[styles.totalsValueStrong, totals.difference !== 0 && styles.totalsValueOff]}>
                  {totals.difference === 0 ? '✓' : formatAccountingCents(totals.difference)}
                </Text>
              </View>
            </View>

            {error ? <Text style={styles.error}>{error}</Text> : null}

            <Pressable onPress={post} disabled={!canPost} style={[styles.primaryButton, !canPost && styles.buttonDisabled]}>
              <Text style={styles.primaryButtonText}>{posting ? 'Posting…' : 'Post entry'}</Text>
            </Pressable>
            <Text style={styles.hint}>
              A posted entry is never edited. If it turns out to be wrong, reverse it — that leaves both the mistake
              and the correction on the record, which is what an entry someone has already reported on needs.
            </Text>
          </ScrollView>
        </View>
      </View>
    </AppModal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', alignItems: 'center', justifyContent: 'center', padding: 20 },
  card: { backgroundColor: theme.bentoSurface, borderRadius: 18, padding: 20, width: '100%', maxWidth: 620, maxHeight: '90%', overflow: 'hidden' },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 },
  title: { fontSize: 16, fontWeight: '800', color: theme.bentoInk },
  close: { backgroundColor: theme.bentoInk, borderRadius: 10, paddingHorizontal: 18, paddingVertical: 12 },
  closeText: { fontSize: 13, fontWeight: '800', color: theme.bentoSurface },
  body: { flexGrow: 0 },

  fieldRow: { flexDirection: 'row', gap: 10 },
  fieldHalf: { flex: 1 },
  fieldLabel: { fontSize: 10, letterSpacing: 0.6, fontWeight: '800', color: theme.bentoMuted, marginBottom: 6 },
  fieldLabelSpaced: { marginTop: 16 },
  input: { backgroundColor: theme.bentoSoft, borderRadius: 10, height: 42, paddingHorizontal: 12, color: theme.bentoInk },
  hint: { fontSize: 11, color: theme.bentoMuted, marginTop: 10, lineHeight: 16 },
  storeBlock: { marginTop: 16 },

  lineBlock: { backgroundColor: theme.bentoSoft, borderRadius: 14, padding: 10, marginTop: 8, gap: 8 },
  lineTop: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  accountButton: { flex: 1, backgroundColor: theme.bentoSurface, borderRadius: 10, height: 42, justifyContent: 'center', paddingHorizontal: 12 },
  accountButtonText: { fontSize: 13, fontWeight: '700', color: theme.bentoInk },
  accountButtonPlaceholder: { fontWeight: '400', color: theme.bentoMuted2 },
  removeButton: { width: 34, height: 34, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.bentoSurface },
  removeText: { fontSize: 13, fontWeight: '800', color: theme.bentoMuted },

  accountList: { backgroundColor: theme.bentoSurface, borderRadius: 10, paddingVertical: 4, maxHeight: 220 },
  accountOption: { paddingVertical: 10, paddingHorizontal: 12 },
  accountOptionText: { fontSize: 12.5, color: theme.bentoInk },

  amountRow: { flexDirection: 'row', gap: 8 },
  amountInput: { flex: 1, backgroundColor: theme.bentoSurface, textAlign: 'right' },
  lineMemoInput: { backgroundColor: theme.bentoSurface, height: 38 },

  addLineButton: { alignSelf: 'flex-start', marginTop: 10, paddingVertical: 8, paddingHorizontal: 12, borderRadius: 999, borderWidth: 1, borderColor: theme.bentoLine },
  addLineText: { fontSize: 12, fontWeight: '700', color: theme.bentoMuted },

  totals: { marginTop: 16, backgroundColor: theme.bentoSoft, borderRadius: 14, paddingHorizontal: 14, paddingVertical: 6 },
  totalsRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: theme.bentoLine },
  totalsRowLast: { borderBottomWidth: 0 },
  totalsLabel: { fontSize: 12.5, color: theme.bentoMuted },
  totalsLabelStrong: { fontSize: 13, fontWeight: '800', color: theme.bentoInk },
  totalsValue: { fontSize: 13, fontWeight: '700', color: theme.bentoInk, fontVariant: ['tabular-nums'] },
  totalsValueStrong: { fontSize: 15, fontWeight: '800', color: theme.bentoProfit, fontVariant: ['tabular-nums'] },
  totalsValueOff: { color: theme.bentoLoss },

  error: { color: theme.bentoLoss, fontSize: 12, fontWeight: '700', marginTop: 12 },
  primaryButton: { backgroundColor: theme.bentoInk, borderRadius: 12, paddingVertical: 14, alignItems: 'center', marginTop: 16 },
  primaryButtonText: { color: theme.bentoSurface, fontWeight: '800', fontSize: 13 },
  buttonDisabled: { backgroundColor: theme.bentoMuted2 },
});
