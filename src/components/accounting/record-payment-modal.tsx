import { useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { DateInput, parseDateInput } from '@/components/date-input';
import { formatAccountingCents, toCents } from '@/lib/currency';
import { balanceCents } from '@/lib/invoice-reporting';
import { methodLabel, paymentMethods } from '@/lib/payment-methods';
import { toDateColumn } from '@/lib/period';
import type { Invoice, PaymentMethod } from '@/types/models';

export function RecordPaymentModal({
  invoice,
  onClose,
  onRecord,
  onDeletePayment,
}: {
  invoice: Invoice;
  onClose: () => void;
  onRecord: (amountCents: number, opts: { paidOn: string; method: PaymentMethod; note: string | null }) => Promise<void>;
  onDeletePayment: (paymentId: string) => Promise<void>;
}) {
  const outstanding = balanceCents(invoice);
  // Pre-filled with the full outstanding balance: paying a bill off is the
  // common case, and it saves retyping a figure that's already on screen.
  const [amount, setAmount] = useState((outstanding / 100).toFixed(2));
  const [paidOn, setPaidOn] = useState(toDateColumn(new Date()));
  const [method, setMethod] = useState<PaymentMethod>('cash');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const amountCents = toCents(amount);
  const overpaying = amountCents > outstanding;
  const canSave = amountCents > 0 && !overpaying && parseDateInput(paidOn) !== null && !saving;

  const submit = async () => {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      await onRecord(amountCents, { paidOn, method, note: note.trim() || null });
    } catch (err) {
      setError(extractErrorMessage(err, 'Could not record this payment.'));
      setSaving(false);
    }
  };

  const removePayment = async (paymentId: string) => {
    setSaving(true);
    setError(null);
    try {
      await onDeletePayment(paymentId);
    } catch (err) {
      setError(extractErrorMessage(err, 'Could not remove this payment.'));
    } finally {
      setSaving(false);
    }
  };

  const payments = invoice.payments ?? [];

  return (
    <Modal visible animationType="fade" transparent onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View style={styles.card}>
          <View style={styles.header}>
            <Text style={styles.title}>Record payment</Text>
            <Pressable onPress={onClose} style={styles.close}>
              <Text style={styles.closeText}>Close</Text>
            </Pressable>
          </View>

          <ScrollView style={styles.body}>
            <Text style={styles.summaryVendor}>{invoice.vendorName ?? 'Vendor'} · {invoice.invoiceNumber}</Text>
            <View style={styles.summaryRow}>
              <Text style={styles.summaryLabel}>Bill total</Text>
              <Text style={styles.summaryValue}>{formatAccountingCents(invoice.amountCents)}</Text>
            </View>
            <View style={styles.summaryRow}>
              <Text style={styles.summaryLabel}>Already paid</Text>
              <Text style={styles.summaryValue}>{formatAccountingCents(invoice.paidCents)}</Text>
            </View>
            <View style={[styles.summaryRow, styles.summaryRowTotal]}>
              <Text style={styles.summaryLabelStrong}>Still owed</Text>
              <Text style={styles.summaryValueStrong}>{formatAccountingCents(outstanding)}</Text>
            </View>

            <View style={styles.fieldRow}>
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
              <View style={styles.fieldHalf}>
                <Text style={[styles.fieldLabel, styles.fieldLabelSpaced]}>DATE PAID</Text>
                <DateInput value={paidOn} onChangeText={setPaidOn} />
              </View>
            </View>
            {overpaying && (
              <Text style={styles.warning}>That&apos;s more than the {formatAccountingCents(outstanding)} still owed.</Text>
            )}

            <Text style={[styles.fieldLabel, styles.fieldLabelSpaced]}>PAID WITH</Text>
            <View style={styles.chipRow}>
              {paymentMethods.map((option) => {
                const active = option.key === method;
                return (
                  <Pressable key={option.key} onPress={() => setMethod(option.key)} style={[styles.chip, active && styles.chipActive]}>
                    <Text style={[styles.chipText, active && styles.chipTextActive]}>{option.label}</Text>
                  </Pressable>
                );
              })}
            </View>

            <Text style={[styles.fieldLabel, styles.fieldLabelSpaced]}>NOTE</Text>
            <TextInput
              value={note}
              onChangeText={setNote}
              placeholder="Reference, who paid it…"
              placeholderTextColor="#9B9B9B"
              style={styles.input}
            />

            {error && <Text style={styles.error}>{error}</Text>}

            <Pressable onPress={submit} disabled={!canSave} style={[styles.primaryButton, styles.submitButton, !canSave && styles.buttonDisabled]}>
              <Text style={styles.primaryButtonText}>{saving ? 'Recording…' : 'Record payment'}</Text>
            </Pressable>

            {payments.length > 0 && (
              <>
                <Text style={[styles.fieldLabel, styles.fieldLabelSpaced]}>PAYMENTS SO FAR</Text>
                {payments.map((payment) => (
                  <View key={payment.id} style={styles.paymentRow}>
                    <View style={styles.paymentMain}>
                      <Text style={styles.paymentAmount}>{formatAccountingCents(payment.amountCents)}</Text>
                      <Text style={styles.paymentMeta}>
                        {[payment.paidOn, methodLabel(payment.method), payment.note].filter(Boolean).join(' · ')}
                      </Text>
                    </View>
                    <Pressable onPress={() => removePayment(payment.id)} disabled={saving}>
                      <Text style={styles.mutedText}>Undo</Text>
                    </Pressable>
                  </View>
                ))}
              </>
            )}

            <Text style={styles.note}>
              Paying a bill moves money out but doesn&apos;t change your profit — the cost already counted when the bill was
              recorded.
            </Text>
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
  card: { backgroundColor: '#FFFFFF', borderRadius: 18, padding: 20, width: '100%', maxWidth: 480, maxHeight: '88%', overflow: 'hidden' },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 },
  title: { fontSize: 16, fontWeight: '800', color: '#111111' },
  close: { backgroundColor: '#111111', borderRadius: 10, paddingHorizontal: 18, paddingVertical: 12 },
  closeText: { fontSize: 13, fontWeight: '800', color: '#FFFFFF' },
  body: { flexGrow: 0 },

  summaryVendor: { fontSize: 13, fontWeight: '700', color: '#111111', marginBottom: 10 },
  summaryRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 6 },
  summaryRowTotal: { borderTopWidth: 1, borderTopColor: '#ECECEC', marginTop: 4, paddingTop: 10 },
  summaryLabel: { fontSize: 12, color: '#777777' },
  summaryValue: { fontSize: 12, fontWeight: '700', color: '#111111' },
  summaryLabelStrong: { fontSize: 13, fontWeight: '800', color: '#111111' },
  summaryValueStrong: { fontSize: 15, fontWeight: '800', color: '#111111' },

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

  paymentRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: '#F2F2F2' },
  paymentMain: { flex: 1, minWidth: 0 },
  paymentAmount: { fontSize: 13, fontWeight: '700', color: '#111111' },
  paymentMeta: { fontSize: 11, color: '#999999', marginTop: 2 },

  note: { fontSize: 11, color: '#999999', lineHeight: 16, marginTop: 16 },
  warning: { fontSize: 11, color: '#B5793A', fontWeight: '600', marginTop: 8 },
  error: { color: '#C0392B', fontSize: 12, fontWeight: '700', marginTop: 12 },
  mutedText: { fontSize: 12, fontWeight: '700', color: '#999999' },
  submitButton: { marginTop: 18 },
  primaryButton: { backgroundColor: '#111111', borderRadius: 10, paddingVertical: 13, alignItems: 'center', justifyContent: 'center' },
  primaryButtonText: { color: '#FFFFFF', fontWeight: '800', fontSize: 13 },
  buttonDisabled: { backgroundColor: '#CCCCCC' },
});
