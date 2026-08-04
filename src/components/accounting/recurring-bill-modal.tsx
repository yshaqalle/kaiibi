import { useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { DateInput, parseDateInput } from '@/components/date-input';
import { VendorPicker, type SelectedVendor } from '@/components/vendor-picker';
import { BILL_FREQUENCY_LABELS } from '@/lib/cash-budget-reporting';
import { StorePicker } from '@/components/store-picker';
import { toCents } from '@/lib/currency';
import { EXPENSE_CATEGORIES } from '@/lib/expense-reporting';
import { paymentMethods } from '@/lib/payment-methods';
import { toDateColumn } from '@/lib/period';
import type { ExpenseCategory, NewRecurringBillInput, PaymentMethod, RecurringBill } from '@/types/models';

export function RecurringBillModal({
  shopId,
  bill,
  onClose,
  onSave,
  onDelete,
}: {
  shopId: string;
  bill: RecurringBill | null;
  onClose: () => void;
  onSave: (input: NewRecurringBillInput) => Promise<void>;
  onDelete?: () => Promise<void>;
}) {
  const [locationId, setLocationId] = useState<string | null>(bill?.locationId ?? null);
  const [name, setName] = useState(bill?.name ?? '');
  const [amount, setAmount] = useState(bill ? (bill.amountCents / 100).toFixed(2) : '');
  const [category, setCategory] = useState<ExpenseCategory>(bill?.category ?? 'rent');
  const [frequency, setFrequency] = useState<RecurringBill['frequency']>(bill?.frequency ?? 'monthly');
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>(bill?.paymentMethod ?? 'cash');
  const [nextDueDate, setNextDueDate] = useState(bill?.nextDueDate ?? toDateColumn(new Date()));
  const [vendor, setVendor] = useState<SelectedVendor | null>(bill?.vendorId ? { id: bill.vendorId, name: 'Vendor' } : null);
  const [active, setActive] = useState(bill?.active ?? true);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const amountCents = toCents(amount);
  const canSave = Boolean(name.trim()) && amountCents > 0 && parseDateInput(nextDueDate) !== null && !saving;

  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      await onSave({
        locationId,
        name: name.trim(),
        category,
        frequency,
        amountCents,
        paymentMethod,
        nextDueDate,
        vendorId: vendor?.id ?? null,
        active,
        notes: null,
      });
    } catch (err) {
      setError(extractErrorMessage(err, 'Could not save this bill.'));
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
      setError(extractErrorMessage(err, 'Could not delete this bill.'));
      setSaving(false);
    }
  };

  return (
    <Modal visible animationType="fade" transparent onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View style={styles.card}>
          <View style={styles.header}>
            <Text style={styles.title}>{bill ? 'Edit recurring bill' : 'New recurring bill'}</Text>
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
            <Text style={styles.fieldLabel}>NAME</Text>
            <TextInput value={name} onChangeText={setName} placeholder="e.g. Mall rent" placeholderTextColor="#9B9B9B" style={styles.input} />

            <View style={styles.fieldRow}>
              <View style={styles.fieldHalf}>
                <Text style={[styles.fieldLabel, styles.fieldLabelSpaced]}>AMOUNT</Text>
                <TextInput value={amount} onChangeText={setAmount} placeholder="0.00" placeholderTextColor="#9B9B9B" keyboardType="decimal-pad" style={styles.input} />
              </View>
              <View style={styles.fieldHalf}>
                <Text style={[styles.fieldLabel, styles.fieldLabelSpaced]}>NEXT DUE</Text>
                <DateInput value={nextDueDate} onChangeText={setNextDueDate} />
              </View>
            </View>

            <Text style={[styles.fieldLabel, styles.fieldLabelSpaced]}>HOW OFTEN</Text>
            <View style={styles.chipRow}>
              {(Object.keys(BILL_FREQUENCY_LABELS) as RecurringBill['frequency'][]).map((key) => (
                <Pressable key={key} onPress={() => setFrequency(key)} style={[styles.chip, frequency === key && styles.chipActive]}>
                  <Text style={[styles.chipText, frequency === key && styles.chipTextActive]}>{BILL_FREQUENCY_LABELS[key]}</Text>
                </Pressable>
              ))}
            </View>

            <StorePicker value={locationId} onChange={setLocationId} />

            <Text style={[styles.fieldLabel, styles.fieldLabelSpaced]}>CATEGORY</Text>
            <View style={styles.chipRow}>
              {EXPENSE_CATEGORIES.map((option) => (
                <Pressable key={option.key} onPress={() => setCategory(option.key)} style={[styles.chip, category === option.key && styles.chipActive]}>
                  <Text style={[styles.chipText, category === option.key && styles.chipTextActive]}>{option.label}</Text>
                </Pressable>
              ))}
            </View>

            <Text style={[styles.fieldLabel, styles.fieldLabelSpaced]}>PAID WITH</Text>
            <View style={styles.chipRow}>
              {paymentMethods.map((option) => (
                <Pressable key={option.key} onPress={() => setPaymentMethod(option.key)} style={[styles.chip, paymentMethod === option.key && styles.chipActive]}>
                  <Text style={[styles.chipText, paymentMethod === option.key && styles.chipTextActive]}>{option.label}</Text>
                </Pressable>
              ))}
            </View>

            <View style={styles.vendorBlock}>
              <VendorPicker shopId={shopId} selected={vendor} onSelect={setVendor} onClear={() => setVendor(null)} />
            </View>

            <Pressable onPress={() => setActive((v) => !v)} style={styles.activeRow}>
              <View style={[styles.checkbox, active && styles.checkboxOn]}>{active && <Text style={styles.checkmark}>✓</Text>}</View>
              <Text style={styles.activeLabel}>Still active — include in monthly commitments</Text>
            </Pressable>

            <Text style={styles.note}>
              This is a reminder, not a cost — nothing counts against profit until you log it, which records it as an
              expense dated its due date.
            </Text>

            {error && <Text style={styles.error}>{error}</Text>}

            <View style={styles.formActions}>
              {onDelete ? (
                confirmingDelete ? (
                  <View style={styles.confirmRow}>
                    <Text style={styles.confirmText}>Delete this bill?</Text>
                    <Pressable onPress={remove} disabled={saving}><Text style={styles.dangerText}>Confirm</Text></Pressable>
                    <Pressable onPress={() => setConfirmingDelete(false)} disabled={saving}><Text style={styles.mutedText}>Cancel</Text></Pressable>
                  </View>
                ) : (
                  <Pressable onPress={() => setConfirmingDelete(true)} disabled={saving}>
                    <Text style={styles.dangerText}>Delete bill</Text>
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
  close: { backgroundColor: '#111111', borderRadius: 10, paddingHorizontal: 18, paddingVertical: 12 },
  closeText: { fontSize: 13, fontWeight: '800', color: '#FFFFFF' },
  body: { flexGrow: 0 },
  fieldRow: { flexDirection: 'row', gap: 10 },
  fieldHalf: { flex: 1 },
  fieldLabel: { fontSize: 10, letterSpacing: 0.6, fontWeight: '800', color: '#999999', marginBottom: 6 },
  fieldLabelSpaced: { marginTop: 16 },
  input: { backgroundColor: '#F2F2F2', borderRadius: 10, height: 42, paddingHorizontal: 12, color: '#111111' },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: { borderWidth: 1, borderColor: '#ECECEC', paddingVertical: 7, paddingHorizontal: 12, borderRadius: 999 },
  chipActive: { backgroundColor: '#111111', borderColor: '#111111' },
  chipText: { fontSize: 12, fontWeight: '700', color: '#777777' },
  chipTextActive: { color: '#FFFFFF' },
  vendorBlock: { marginTop: 16 },
  activeRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 18 },
  checkbox: { width: 20, height: 20, borderRadius: 6, borderWidth: 1, borderColor: '#CCCCCC', alignItems: 'center', justifyContent: 'center' },
  checkboxOn: { backgroundColor: '#111111', borderColor: '#111111' },
  checkmark: { color: '#FFFFFF', fontSize: 12, fontWeight: '800' },
  activeLabel: { fontSize: 12.5, color: '#111111', flexShrink: 1 },
  note: { fontSize: 11, color: '#999999', lineHeight: 16, marginTop: 16 },
  error: { color: '#C0392B', fontSize: 12, fontWeight: '700', marginTop: 12 },
  formActions: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 10, marginTop: 20 },
  confirmRow: { flexDirection: 'row', alignItems: 'center', gap: 12, flexShrink: 1 },
  confirmText: { fontSize: 12, fontWeight: '600', color: '#111111' },
  dangerText: { fontSize: 12, fontWeight: '700', color: '#C0392B' },
  mutedText: { fontSize: 12, fontWeight: '700', color: '#999999' },
  primaryButton: { backgroundColor: '#111111', borderRadius: 10, paddingHorizontal: 18, paddingVertical: 12, alignItems: 'center', justifyContent: 'center' },
  primaryButtonText: { color: '#FFFFFF', fontWeight: '800', fontSize: 13 },
  buttonDisabled: { backgroundColor: '#CCCCCC' },
});
