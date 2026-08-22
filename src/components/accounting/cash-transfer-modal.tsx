import { useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { DateInput, parseDateInput } from '@/components/date-input';
import { AppModal } from '@/components/ui/app-modal';
import { Colors } from '@/constants/theme';
import { recordCashTransfer } from '@/lib/cash-transfers';
import { formatAccountingCents, toCents } from '@/lib/currency';
import { toDateColumn } from '@/lib/period';
import type { CashAccount } from '@/types/models';

const theme = Colors.light;

// Moving money between the shop's own pots.
//
// The preview at the bottom is what makes this form worth having over two
// hand-edited balances: it shows both accounts before and after, so a
// transposed amount or the wrong direction is visible before it is committed.
// Both balances move in one transaction, so a half-done transfer -- which two
// hand edits can leave behind, and which nothing on any screen would explain --
// is not a state this can produce.

function extractErrorMessage(err: unknown, fallback: string): string {
  if (err && typeof err === 'object' && 'message' in err && typeof (err as { message: unknown }).message === 'string') {
    return (err as { message: string }).message;
  }
  return fallback;
}

export function CashTransferModal({
  accounts,
  onClose,
  onTransferred,
}: {
  accounts: CashAccount[];
  onClose: () => void;
  onTransferred: () => Promise<void> | void;
}) {
  const [fromId, setFromId] = useState<string | null>(accounts[0]?.id ?? null);
  const [toId, setToId] = useState<string | null>(accounts[1]?.id ?? null);
  const [amount, setAmount] = useState('');
  const [transferredOn, setTransferredOn] = useState(toDateColumn(new Date()));
  const [reference, setReference] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const from = useMemo(() => accounts.find((a) => a.id === fromId) ?? null, [accounts, fromId]);
  const to = useMemo(() => accounts.find((a) => a.id === toId) ?? null, [accounts, toId]);

  const amountCents = amount.trim() === '' ? 0 : toCents(amount);
  const dateValid = parseDateInput(transferredOn) !== null;
  const canSave = Boolean(from && to) && fromId !== toId && amountCents > 0 && dateValid && !saving;

  const pickFrom = (id: string) => {
    setFromId(id);
    // Picking the account already on the other side would leave the form in a
    // state it can only be saved out of by changing the other one. Swapping is
    // what the person meant.
    if (id === toId) setToId(fromId);
  };
  const pickTo = (id: string) => {
    setToId(id);
    if (id === fromId) setFromId(toId);
  };

  const save = async () => {
    if (!canSave || !from || !to) return;
    setSaving(true);
    setError(null);
    try {
      await recordCashTransfer({
        fromAccountId: from.id,
        toAccountId: to.id,
        amountCents,
        transferredOn,
        reference: reference.trim() || null,
        note: note.trim() || null,
      });
      await onTransferred();
    } catch (err) {
      setError(extractErrorMessage(err, 'Could not record this transfer.'));
      setSaving(false);
    }
  };

  return (
    <AppModal visible animationType="fade" transparent onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View style={styles.card}>
          <View style={styles.header}>
            <Text style={styles.title}>Move money</Text>
            <Pressable onPress={onClose} style={styles.close}>
              <Text style={styles.closeText}>Close</Text>
            </Pressable>
          </View>

          <ScrollView style={styles.body}>
            {accounts.length < 2 ? (
              <Text style={styles.hint}>
                A transfer needs two accounts. Add a bank account or a mobile wallet alongside the till and this
                becomes available.
              </Text>
            ) : (
              <>
                <Text style={styles.fieldLabel}>OUT OF</Text>
                <View style={styles.chipRow}>
                  {accounts.map((account) => {
                    const active = account.id === fromId;
                    return (
                      <Pressable key={account.id} onPress={() => pickFrom(account.id)} style={[styles.chip, active && styles.chipActive]}>
                        <Text style={[styles.chipText, active && styles.chipTextActive]}>{account.name}</Text>
                      </Pressable>
                    );
                  })}
                </View>

                <Text style={[styles.fieldLabel, styles.fieldLabelSpaced]}>INTO</Text>
                <View style={styles.chipRow}>
                  {accounts.map((account) => {
                    const active = account.id === toId;
                    return (
                      <Pressable key={account.id} onPress={() => pickTo(account.id)} style={[styles.chip, active && styles.chipActive]}>
                        <Text style={[styles.chipText, active && styles.chipTextActive]}>{account.name}</Text>
                      </Pressable>
                    );
                  })}
                </View>

                <View style={styles.fieldRow}>
                  <View style={styles.fieldHalf}>
                    <Text style={[styles.fieldLabel, styles.fieldLabelSpaced]}>AMOUNT</Text>
                    <TextInput
                      value={amount}
                      onChangeText={setAmount}
                      placeholder="0.00"
                      placeholderTextColor={theme.bentoMuted2}
                      keyboardType="decimal-pad"
                      style={styles.input}
                    />
                  </View>
                  <View style={styles.fieldHalf}>
                    <Text style={[styles.fieldLabel, styles.fieldLabelSpaced]}>ON</Text>
                    <DateInput value={transferredOn} onChangeText={setTransferredOn} />
                  </View>
                </View>

                <Text style={[styles.fieldLabel, styles.fieldLabelSpaced]}>REFERENCE</Text>
                <TextInput
                  value={reference}
                  onChangeText={setReference}
                  placeholder="Deposit slip, wallet transaction id"
                  placeholderTextColor={theme.bentoMuted2}
                  style={styles.input}
                />

                <Text style={[styles.fieldLabel, styles.fieldLabelSpaced]}>NOTE</Text>
                <TextInput
                  value={note}
                  onChangeText={setNote}
                  placeholder="Banked the weekend's takings"
                  placeholderTextColor={theme.bentoMuted2}
                  style={styles.input}
                />

                {from && to && amountCents > 0 && (
                  <View style={styles.preview}>
                    <View style={styles.previewRow}>
                      <Text style={styles.previewLabel} numberOfLines={1}>{from.name}</Text>
                      <Text style={styles.previewValue}>
                        {`${formatAccountingCents(from.balanceCents)}  →  ${formatAccountingCents(from.balanceCents - amountCents)}`}
                      </Text>
                    </View>
                    <View style={[styles.previewRow, styles.previewRowLast]}>
                      <Text style={styles.previewLabel} numberOfLines={1}>{to.name}</Text>
                      <Text style={styles.previewValue}>
                        {`${formatAccountingCents(to.balanceCents)}  →  ${formatAccountingCents(to.balanceCents + amountCents)}`}
                      </Text>
                    </View>
                  </View>
                )}

                {error ? <Text style={styles.error}>{error}</Text> : null}

                <Pressable onPress={save} disabled={!canSave} style={[styles.primaryButton, !canSave && styles.buttonDisabled]}>
                  <Text style={styles.primaryButtonText}>{saving ? 'Moving…' : 'Move the money'}</Text>
                </Pressable>
                <Text style={styles.hint}>
                  Moving money between your own accounts is not income and not a cost — the shop still has exactly as
                  much. Nothing here changes profit, and nothing changes the total cash on hand.
                </Text>
              </>
            )}
          </ScrollView>
        </View>
      </View>
    </AppModal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', alignItems: 'center', justifyContent: 'center', padding: 20 },
  card: { backgroundColor: theme.bentoSurface, borderRadius: 18, padding: 20, width: '100%', maxWidth: 540, maxHeight: '88%', overflow: 'hidden' },
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
  hint: { fontSize: 11, color: theme.bentoMuted, marginTop: 12, lineHeight: 16 },

  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: { borderWidth: 1, borderColor: theme.bentoLine, paddingVertical: 7, paddingHorizontal: 12, borderRadius: 999 },
  chipActive: { backgroundColor: theme.bentoInk, borderColor: theme.bentoInk },
  chipText: { fontSize: 12, fontWeight: '700', color: theme.bentoMuted },
  chipTextActive: { color: theme.bentoSurface },

  preview: { marginTop: 18, backgroundColor: theme.bentoSoft, borderRadius: 14, paddingHorizontal: 14 },
  previewRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 12, paddingVertical: 11, borderBottomWidth: 1, borderBottomColor: theme.bentoLine },
  previewRowLast: { borderBottomWidth: 0 },
  previewLabel: { fontSize: 12.5, fontWeight: '700', color: theme.bentoInk, flex: 1, minWidth: 0 },
  previewValue: { fontSize: 12.5, fontWeight: '700', color: theme.bentoMuted, fontVariant: ['tabular-nums'] },

  error: { color: theme.bentoLoss, fontSize: 12, fontWeight: '700', marginTop: 12 },
  primaryButton: { backgroundColor: theme.bentoInk, borderRadius: 12, paddingVertical: 14, alignItems: 'center', marginTop: 18 },
  primaryButtonText: { color: theme.bentoSurface, fontWeight: '800', fontSize: 13 },
  buttonDisabled: { backgroundColor: theme.bentoMuted2 },
});
