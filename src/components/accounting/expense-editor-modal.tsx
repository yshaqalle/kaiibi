import { useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { DateInput, parseDateInput } from '@/components/date-input';
import { VendorPicker, type SelectedVendor } from '@/components/vendor-picker';
import { toCents } from '@/lib/currency';
import { EXPENSE_CATEGORIES } from '@/lib/expense-reporting';
import { paymentMethods } from '@/lib/payment-methods';
import { toDateColumn } from '@/lib/period';
import type { Expense, ExpenseCategory, NewExpenseInput, PaymentMethod } from '@/types/models';

// One modal for both add and edit. The parent mounts it only while editing and
// keys it by expense id, so these fields initialise from props and never need
// an effect to resync.
export function ExpenseEditorModal({
  shopId,
  expense,
  onClose,
  onSave,
  onDelete,
}: {
  shopId: string;
  expense: Expense | null;
  onClose: () => void;
  onSave: (input: NewExpenseInput) => Promise<void>;
  onDelete?: () => Promise<void>;
}) {
  const [occurredOn, setOccurredOn] = useState(expense?.occurredOn ?? toDateColumn(new Date()));
  const [amount, setAmount] = useState(expense ? (expense.amountCents / 100).toFixed(2) : '');
  const [category, setCategory] = useState<ExpenseCategory>(expense?.category ?? 'inventory_purchase');
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>(expense?.paymentMethod ?? 'cash');
  const [vendor, setVendor] = useState<SelectedVendor | null>(
    expense?.vendorId ? { id: expense.vendorId, name: expense.vendorName ?? 'Vendor' } : null
  );
  const [note, setNote] = useState(expense?.note ?? '');
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const amountCents = toCents(amount);
  const dateValid = parseDateInput(occurredOn) !== null;
  // The DB enforces amount > 0 as well; catching it here keeps the user from
  // losing a filled-in form to a round trip.
  const canSave = amountCents > 0 && dateValid && !saving;

  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      await onSave({
        occurredOn,
        amountCents,
        category,
        vendorId: vendor?.id ?? null,
        paymentMethod,
        note: note.trim() || null,
      });
    } catch (err) {
      setError(extractErrorMessage(err, 'Could not save this expense.'));
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!onDelete) return;
    setSaving(true);
    setError(null);
    try {
      await onDelete();
    } catch (err) {
      setError(extractErrorMessage(err, 'Could not delete this expense.'));
      setSaving(false);
    }
  };

  return (
    <Modal visible animationType="fade" transparent onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View style={styles.card}>
          <View style={styles.header}>
            <Text style={styles.title}>{expense ? 'Edit expense' : 'New expense'}</Text>
            <View style={styles.headerActions}>
              <Pressable onPress={save} disabled={!canSave} style={[styles.primaryButton, !canSave && styles.buttonDisabled]}>
                <Text style={styles.primaryButtonText}>{saving ? 'Saving…' : 'Save'}</Text>
              </Pressable>
              <Pressable onPress={onClose} style={styles.close}>
                <Text style={styles.closeText}>Close</Text>
              </Pressable>
            </View>
          </View>

          <ScrollView style={styles.body}>
            <View style={styles.fieldRow}>
              <View style={styles.fieldHalf}>
                <Text style={styles.fieldLabel}>DATE</Text>
                <DateInput value={occurredOn} onChangeText={setOccurredOn} />
              </View>
              <View style={styles.fieldHalf}>
                <Text style={styles.fieldLabel}>AMOUNT</Text>
                <TextInput
                  value={amount}
                  onChangeText={setAmount}
                  placeholder="0.00"
                  placeholderTextColor="#9B9B9B"
                  keyboardType="decimal-pad"
                  style={styles.input}
                />
              </View>
            </View>

            <Text style={[styles.fieldLabel, styles.fieldLabelSpaced]}>CATEGORY</Text>
            <View style={styles.chipRow}>
              {EXPENSE_CATEGORIES.map((option) => {
                const active = option.key === category;
                return (
                  <Pressable
                    key={option.key}
                    onPress={() => setCategory(option.key)}
                    style={[styles.chip, active && styles.chipActive]}
                  >
                    <Text style={[styles.chipText, active && styles.chipTextActive]}>{option.label}</Text>
                  </Pressable>
                );
              })}
            </View>

            <Text style={[styles.fieldLabel, styles.fieldLabelSpaced]}>PAID WITH</Text>
            <View style={styles.chipRow}>
              {paymentMethods.map((option) => {
                const active = option.key === paymentMethod;
                return (
                  <Pressable
                    key={option.key}
                    onPress={() => setPaymentMethod(option.key)}
                    style={[styles.chip, active && styles.chipActive]}
                  >
                    <Text style={[styles.chipText, active && styles.chipTextActive]}>{option.label}</Text>
                  </Pressable>
                );
              })}
            </View>

            <View style={styles.vendorBlock}>
              <VendorPicker
                shopId={shopId}
                selected={vendor}
                onSelect={setVendor}
                onClear={() => setVendor(null)}
              />
            </View>

            <Text style={[styles.fieldLabel, styles.fieldLabelSpaced]}>NOTE</Text>
            <TextInput
              value={note}
              onChangeText={setNote}
              placeholder="What was this for?"
              placeholderTextColor="#9B9B9B"
              multiline
              textAlignVertical="top"
              style={[styles.input, styles.multiline]}
            />

            {error && <Text style={styles.error}>{error}</Text>}

            <View style={styles.formActions}>
              {onDelete ? (
                confirmingDelete ? (
                  <View style={styles.confirmRow}>
                    <Text style={styles.confirmText}>Delete this expense?</Text>
                    <Pressable onPress={remove} disabled={saving}><Text style={styles.dangerText}>Confirm</Text></Pressable>
                    <Pressable onPress={() => setConfirmingDelete(false)} disabled={saving}><Text style={styles.mutedText}>Cancel</Text></Pressable>
                  </View>
                ) : (
                  <Pressable onPress={() => setConfirmingDelete(true)} disabled={saving}>
                    <Text style={styles.dangerText}>Delete expense</Text>
                  </Pressable>
                )
              ) : (
                <View />
              )}
              <Pressable onPress={save} disabled={!canSave} style={[styles.primaryButton, !canSave && styles.buttonDisabled]}>
                <Text style={styles.primaryButtonText}>{saving ? 'Saving…' : 'Save'}</Text>
              </Pressable>
            </View>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

function extractErrorMessage(err: unknown, fallback: string): string {
  if (err && typeof err === 'object' && 'message' in err && typeof (err as { message: unknown }).message === 'string') {
    return (err as { message: string }).message;
  }
  return fallback;
}

const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', alignItems: 'center', justifyContent: 'center', padding: 20 },
  card: { backgroundColor: '#FFFFFF', borderRadius: 18, padding: 20, width: '100%', maxWidth: 560, maxHeight: '88%', overflow: 'hidden' },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  title: { fontSize: 16, fontWeight: '800', color: '#111111' },
  close: { backgroundColor: '#111111', borderRadius: 10, paddingHorizontal: 18, paddingVertical: 12, alignItems: 'center', justifyContent: 'center' },
  closeText: { fontSize: 13, fontWeight: '800', color: '#FFFFFF' },
  body: { flexGrow: 0 },
  fieldRow: { flexDirection: 'row', gap: 10 },
  fieldHalf: { flex: 1 },
  fieldLabel: { fontSize: 10, letterSpacing: 0.6, fontWeight: '800', color: '#999999', marginBottom: 6 },
  fieldLabelSpaced: { marginTop: 16 },
  input: { backgroundColor: '#F2F2F2', borderRadius: 10, height: 42, paddingHorizontal: 12, color: '#111111' },
  multiline: { height: 76, paddingTop: 11 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: { borderWidth: 1, borderColor: '#ECECEC', paddingVertical: 7, paddingHorizontal: 12, borderRadius: 999 },
  chipActive: { backgroundColor: '#111111', borderColor: '#111111' },
  chipText: { fontSize: 12, fontWeight: '700', color: '#777777' },
  chipTextActive: { color: '#FFFFFF' },
  vendorBlock: { marginTop: 16 },
  error: { color: '#C0392B', fontSize: 12, fontWeight: '700', marginTop: 12 },
  formActions: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 10, marginTop: 20 },
  confirmRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  confirmText: { fontSize: 12, fontWeight: '600', color: '#111111' },
  dangerText: { fontSize: 12, fontWeight: '700', color: '#C0392B' },
  mutedText: { fontSize: 12, fontWeight: '700', color: '#999999' },
  primaryButton: { backgroundColor: '#111111', borderRadius: 10, paddingHorizontal: 18, paddingVertical: 12, alignItems: 'center', justifyContent: 'center' },
  primaryButtonText: { color: '#FFFFFF', fontWeight: '800', fontSize: 13 },
  buttonDisabled: { backgroundColor: '#CCCCCC' },
});
