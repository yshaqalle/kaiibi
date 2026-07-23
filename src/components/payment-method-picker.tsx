import { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { formatCents, toCents } from '@/lib/currency';
import type { PaymentLine, PaymentMethod } from '@/types/models';

const methods: { key: PaymentMethod; label: string; icon: string }[] = [
  { key: 'cash', label: 'Cash', icon: '💵' },
  { key: 'zaad', label: 'ZAAD', icon: '📱' },
  { key: 'edahab', label: 'e-Dahab', icon: '📱' },
  { key: 'other', label: 'Other', icon: '•' },
];

const methodLabel = (method: PaymentMethod) => methods.find((m) => m.key === method)?.label ?? method;

export function PaymentMethodPicker({
  totalCents,
  payments,
  onChange,
}: {
  totalCents: number;
  payments: PaymentLine[];
  onChange: (payments: PaymentLine[]) => void;
}) {
  const [draftMethod, setDraftMethod] = useState<PaymentMethod | null>(null);
  const [amountInput, setAmountInput] = useState('');
  const [customerName, setCustomerName] = useState('');
  const [customerPhone, setCustomerPhone] = useState('');

  const paidCents = payments.reduce((sum, p) => sum + p.amountCents, 0);
  const remainingCents = totalCents - paidCents;
  const isCash = draftMethod === 'cash';

  const startDraft = (method: PaymentMethod) => {
    setDraftMethod(method);
    setAmountInput(remainingCents > 0 ? (remainingCents / 100).toFixed(2) : '');
    setCustomerName('');
    setCustomerPhone('');
  };

  const cancelDraft = () => setDraftMethod(null);

  // For cash, the single amount field is what the customer actually handed
  // over: if it's less than what's still owed, that's a genuine partial
  // payment (apply exactly that much, no change); if it's more, the excess
  // is change due. Earlier this had a separate "amount applied" field
  // that defaulted to the full remaining balance regardless of what was
  // typed into "cash received" — so a partial cash tender still silently
  // queued a full payment. Every other method has no change concept, so
  // the amount entered must directly be what's applied (capped at what's
  // still owed).
  const enteredCents = toCents(amountInput || '0');
  const draftAppliedCents = isCash ? Math.min(enteredCents, remainingCents) : enteredCents;
  const draftChangeCents = isCash && enteredCents > remainingCents ? enteredCents - remainingCents : 0;
  const draftValid = enteredCents > 0 && draftAppliedCents > 0 && draftAppliedCents <= remainingCents;

  const addDraft = () => {
    if (!draftMethod || !draftValid) return;
    onChange([
      ...payments,
      {
        method: draftMethod,
        amountCents: draftAppliedCents,
        tenderedCents: draftChangeCents > 0 ? enteredCents : null,
        customerName: (draftMethod === 'zaad' || draftMethod === 'edahab') && customerName.trim() ? customerName.trim() : null,
        customerPhone: (draftMethod === 'zaad' || draftMethod === 'edahab') && customerPhone.trim() ? customerPhone.trim() : null,
      },
    ]);
    setDraftMethod(null);
  };

  const removePayment = (index: number) => onChange(payments.filter((_, i) => i !== index));

  return (
    <View>
      <Text style={styles.heading}>PAYMENT METHOD</Text>

      {payments.length > 0 && (
        <View style={styles.paidList}>
          {payments.map((payment, index) => (
            <View key={index} style={styles.paidRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.paidMethod}>{methodLabel(payment.method)} · {formatCents(payment.amountCents)}</Text>
                {payment.tenderedCents !== null && (
                  <Text style={styles.paidMeta}>Tendered {formatCents(payment.tenderedCents)} · Change {formatCents(payment.tenderedCents - payment.amountCents)}</Text>
                )}
                {payment.customerName && <Text style={styles.paidMeta}>{payment.customerName}{payment.customerPhone ? ` · ${payment.customerPhone}` : ''}</Text>}
              </View>
              <Pressable onPress={() => removePayment(index)} style={styles.removeButton}>
                <Text style={styles.removeButtonText}>✕</Text>
              </Pressable>
            </View>
          ))}
        </View>
      )}

      {remainingCents > 0 ? (
        <>
          {payments.length > 0 && <Text style={styles.remaining}>Remaining: {formatCents(remainingCents)}</Text>}
          {draftMethod === null ? (
            <View style={styles.row}>
              {methods.map((method) => (
                <Pressable key={method.key} onPress={() => startDraft(method.key)} style={styles.button}>
                  <Text style={styles.buttonText}>{method.icon} {method.label}</Text>
                </Pressable>
              ))}
            </View>
          ) : (
            <View style={styles.draftCard}>
              <View style={styles.draftHeader}>
                <Text style={styles.draftTitle}>{methodLabel(draftMethod)}</Text>
                <Pressable onPress={cancelDraft}><Text style={styles.draftCancel}>Cancel</Text></Pressable>
              </View>

              <Text style={styles.fieldLabel}>{isCash ? 'CASH RECEIVED' : 'AMOUNT'}</Text>
              <TextInput value={amountInput} onChangeText={setAmountInput} placeholder="0.00" placeholderTextColor="#9B9B9B" keyboardType="decimal-pad" style={styles.input} />
              {isCash && draftChangeCents > 0 && <Text style={styles.changeText}>Change due: {formatCents(draftChangeCents)}</Text>}
              {isCash && enteredCents > 0 && enteredCents < remainingCents && (
                <Text style={styles.partialText}>Applies {formatCents(enteredCents)} to this sale — {formatCents(remainingCents - enteredCents)} will still be owed.</Text>
              )}

              {(draftMethod === 'zaad' || draftMethod === 'edahab') && (
                <>
                  <Text style={styles.fieldLabel}>CUSTOMER NAME</Text>
                  <TextInput value={customerName} onChangeText={setCustomerName} placeholder="Optional" placeholderTextColor="#9B9B9B" style={styles.input} />
                  <Text style={styles.fieldLabel}>CUSTOMER PHONE</Text>
                  <TextInput value={customerPhone} onChangeText={setCustomerPhone} placeholder="Optional" placeholderTextColor="#9B9B9B" keyboardType="phone-pad" style={styles.input} />
                </>
              )}

              <Pressable onPress={addDraft} disabled={!draftValid} style={[styles.addButton, !draftValid && styles.addButtonDisabled]}>
                <Text style={styles.addButtonText}>Add payment</Text>
              </Pressable>
            </View>
          )}
        </>
      ) : (
        payments.length > 0 && <Text style={styles.fullyPaid}>✓ Fully paid</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  heading: { fontSize: 12, fontWeight: '700', color: '#999999', letterSpacing: 0.4, marginTop: 22, marginBottom: 10 },
  paidList: { gap: 8, marginBottom: 10 },
  paidRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#F2F2F2', borderRadius: 12, padding: 12, gap: 10 },
  paidMethod: { fontSize: 13, fontWeight: '700', color: '#111111' },
  paidMeta: { fontSize: 11, color: '#777777', marginTop: 2 },
  removeButton: { width: 26, height: 26, borderRadius: 13, backgroundColor: '#FFFFFF', alignItems: 'center', justifyContent: 'center' },
  removeButtonText: { fontSize: 12, color: '#999999', fontWeight: '700' },
  remaining: { fontSize: 12, fontWeight: '700', color: '#B5793A', marginBottom: 8 },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 10 },
  button: { flexGrow: 1, flexBasis: '47%', alignItems: 'center', paddingVertical: 14, paddingHorizontal: 10, borderRadius: 14, backgroundColor: '#F2F2F2' },
  buttonText: { fontSize: 14, fontWeight: '700', color: '#111111' },
  draftCard: { backgroundColor: '#F2F2F2', borderRadius: 14, padding: 14, marginBottom: 10 },
  draftHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 },
  draftTitle: { fontSize: 14, fontWeight: '800', color: '#111111' },
  draftCancel: { fontSize: 12, fontWeight: '700', color: '#999999' },
  fieldLabel: { fontSize: 10, letterSpacing: 0.6, fontWeight: '800', color: '#999999', marginBottom: 6, marginTop: 8 },
  input: { backgroundColor: '#FFFFFF', borderRadius: 10, height: 42, paddingHorizontal: 12, color: '#111111' },
  changeText: { fontSize: 12, fontWeight: '700', color: '#438254', marginTop: 8 },
  partialText: { fontSize: 12, fontWeight: '600', color: '#B5793A', marginTop: 8, lineHeight: 17 },
  addButton: { backgroundColor: '#111111', height: 44, borderRadius: 10, alignItems: 'center', justifyContent: 'center', marginTop: 12 },
  addButtonDisabled: { backgroundColor: '#CCCCCC' },
  addButtonText: { color: '#FFFFFF', fontWeight: '800', fontSize: 13 },
  fullyPaid: { fontSize: 13, fontWeight: '800', color: '#438254', textAlign: 'center', paddingVertical: 10 },
});
