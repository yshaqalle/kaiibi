import { useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { DateInput, parseDateInput } from '@/components/date-input';
import { VendorPicker, type SelectedVendor } from '@/components/vendor-picker';
import { toCents } from '@/lib/currency';
import { EXPENSE_CATEGORIES } from '@/lib/expense-reporting';
import { toDateColumn } from '@/lib/period';
import type { ExpenseCategory, Invoice, NewInvoiceInput } from '@/types/models';

// One modal for raising and editing a vendor bill. Mounted only while editing
// and keyed by id, so fields initialise from props without an effect.
export function InvoiceEditorModal({
  shopId,
  invoice,
  onClose,
  onSave,
  onDelete,
}: {
  shopId: string;
  invoice: Invoice | null;
  onClose: () => void;
  onSave: (input: NewInvoiceInput) => Promise<void>;
  onDelete?: () => Promise<void>;
}) {
  const [vendor, setVendor] = useState<SelectedVendor | null>(
    invoice?.vendorId ? { id: invoice.vendorId, name: invoice.vendorName ?? 'Vendor' } : null
  );
  const [invoiceNumber, setInvoiceNumber] = useState(invoice?.invoiceNumber ?? '');
  const [category, setCategory] = useState<ExpenseCategory>(invoice?.category ?? 'inventory_purchase');
  const [description, setDescription] = useState(invoice?.description ?? '');
  const [issuedOn, setIssuedOn] = useState(invoice?.issuedOn ?? toDateColumn(new Date()));
  const [dueOn, setDueOn] = useState(invoice?.dueOn ?? '');
  const [amount, setAmount] = useState(invoice ? (invoice.amountCents / 100).toFixed(2) : '');
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const amountCents = toCents(amount);
  const issuedDate = parseDateInput(issuedOn);
  const dueDate = parseDateInput(dueOn);
  // The DB has no constraint that due >= issued (a shop may legitimately be
  // handed a bill already past due), so this is guidance rather than a block.
  const dueBeforeIssued = Boolean(issuedDate && dueDate && dueDate < issuedDate);
  // Reducing a bill below what's already been paid would violate the
  // not-overpaid constraint; catching it here explains why rather than
  // surfacing a raw Postgres error.
  const belowPaid = invoice ? amountCents < invoice.paidCents : false;

  const canSave = amountCents > 0 && Boolean(invoiceNumber.trim()) && Boolean(issuedDate) && Boolean(dueDate) && !belowPaid && !saving;

  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      await onSave({
        vendorId: vendor?.id ?? null,
        vendorName: vendor?.name ?? null,
        vendorPhone: null,
        invoiceNumber: invoiceNumber.trim(),
        category,
        description: description.trim() || null,
        issuedOn,
        dueOn,
        amountCents,
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
            <Text style={styles.title}>{invoice ? 'Edit bill' : 'New bill'}</Text>
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
            <VendorPicker
              shopId={shopId}
              selected={vendor}
              onSelect={setVendor}
              onClear={() => setVendor(null)}
              label="Who the bill is from"
            />

            <View style={styles.fieldRow}>
              <View style={styles.fieldHalf}>
                <Text style={[styles.fieldLabel, styles.fieldLabelSpaced]}>BILL NUMBER</Text>
                <TextInput
                  value={invoiceNumber}
                  onChangeText={setInvoiceNumber}
                  placeholder="Their reference"
                  placeholderTextColor="#9B9B9B"
                  style={styles.input}
                />
              </View>
              <View style={styles.fieldHalf}>
                <Text style={[styles.fieldLabel, styles.fieldLabelSpaced]}>AMOUNT</Text>
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

            <View style={styles.fieldRow}>
              <View style={styles.fieldHalf}>
                <Text style={[styles.fieldLabel, styles.fieldLabelSpaced]}>ISSUED</Text>
                <DateInput value={issuedOn} onChangeText={setIssuedOn} />
              </View>
              <View style={styles.fieldHalf}>
                <Text style={[styles.fieldLabel, styles.fieldLabelSpaced]}>DUE</Text>
                <DateInput value={dueOn} onChangeText={setDueOn} />
              </View>
            </View>
            {dueBeforeIssued && <Text style={styles.warning}>This bill is due before it was issued — it will show as overdue.</Text>}
            {belowPaid && invoice && (
              <Text style={styles.warning}>
                Can&apos;t be less than the {(invoice.paidCents / 100).toFixed(2)} already paid against it.
              </Text>
            )}

            <Text style={[styles.fieldLabel, styles.fieldLabelSpaced]}>WHAT IT&apos;S FOR</Text>
            <View style={styles.chipRow}>
              {EXPENSE_CATEGORIES.map((option) => {
                const active = option.key === category;
                return (
                  <Pressable key={option.key} onPress={() => setCategory(option.key)} style={[styles.chip, active && styles.chipActive]}>
                    <Text style={[styles.chipText, active && styles.chipTextActive]}>{option.label}</Text>
                  </Pressable>
                );
              })}
            </View>

            <Text style={[styles.fieldLabel, styles.fieldLabelSpaced]}>DESCRIPTION</Text>
            <TextInput
              value={description}
              onChangeText={setDescription}
              placeholder="e.g. Bulk restock — 40pc assorted"
              placeholderTextColor="#9B9B9B"
              multiline
              textAlignVertical="top"
              style={[styles.input, styles.multiline]}
            />

            <Text style={styles.note}>
              Recording a bill adds it to expenses straight away, so it counts against profit from the day it was issued.
              Paying it later settles the balance without changing your profit again.
            </Text>

            {error && <Text style={styles.error}>{error}</Text>}

            <View style={styles.formActions}>
              {onDelete ? (
                confirmingDelete ? (
                  <View style={styles.confirmRow}>
                    <Text style={styles.confirmText}>Delete this bill and its expense?</Text>
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
    const message = (err as { message: string }).message;
    if (message.includes('invoices_shop_id_invoice_number_key')) return 'A bill with that number already exists.';
    if (message.includes('invoices_not_overpaid')) return 'That amount is less than what has already been paid.';
    return message;
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
  multiline: { height: 72, paddingTop: 11 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: { borderWidth: 1, borderColor: '#ECECEC', paddingVertical: 7, paddingHorizontal: 12, borderRadius: 999 },
  chipActive: { backgroundColor: '#111111', borderColor: '#111111' },
  chipText: { fontSize: 12, fontWeight: '700', color: '#777777' },
  chipTextActive: { color: '#FFFFFF' },
  note: { fontSize: 11, color: '#999999', lineHeight: 16, marginTop: 16 },
  warning: { fontSize: 11, color: '#B5793A', fontWeight: '600', marginTop: 8 },
  error: { color: '#C0392B', fontSize: 12, fontWeight: '700', marginTop: 12 },
  formActions: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 10, marginTop: 20 },
  confirmRow: { flexDirection: 'row', alignItems: 'center', gap: 12, flexShrink: 1 },
  confirmText: { fontSize: 12, fontWeight: '600', color: '#111111', flexShrink: 1 },
  dangerText: { fontSize: 12, fontWeight: '700', color: '#C0392B' },
  mutedText: { fontSize: 12, fontWeight: '700', color: '#999999' },
  primaryButton: { backgroundColor: '#111111', borderRadius: 10, paddingHorizontal: 18, paddingVertical: 12, alignItems: 'center', justifyContent: 'center' },
  primaryButtonText: { color: '#FFFFFF', fontWeight: '800', fontSize: 13 },
  buttonDisabled: { backgroundColor: '#CCCCCC' },
});
