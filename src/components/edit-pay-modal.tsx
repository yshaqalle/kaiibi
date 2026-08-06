import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { PayFields, payFieldsInitial, payFieldsToCents, type PayFieldsValue } from '@/components/pay-fields';
import { isValidRateInput } from '@/lib/pay-rate';
import type { StaffMember } from '@/types/models';
import { AppModal } from '@/components/ui/app-modal';

export function EditPayModal({
  visible,
  member,
  onClose,
  onSave,
}: {
  visible: boolean;
  member: StaffMember;
  onClose: () => void;
  onSave: (patch: { hireDate?: string | null; payType?: StaffMember['payType']; payRateCents?: number | null; payCadence?: StaffMember['payCadence'] }) => Promise<void>;
}) {
  const [hireDate, setHireDate] = useState(member.hireDate ?? '');
  const [pay, setPay] = useState<PayFieldsValue>(payFieldsInitial(member));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (visible) {
      setHireDate(member.hireDate ?? '');
      setPay(payFieldsInitial(member));
      setError(null);
    }
  }, [visible, member]);

  const save = async () => {
    setError(null);
    // payFieldsToCents delegates to toCents, which never fails to parse --
    // unparseable text like "abc" quietly collapses to 0 rather than null.
    // Validating the raw text with isValidRateInput (rather than gating on
    // the converted cents) is what catches that, without also rejecting a
    // legitimately-typed "0".
    if (!isValidRateInput(pay.rate)) {
      setError('Enter a valid pay rate, or leave it blank.');
      return;
    }
    const rateCents = payFieldsToCents(pay);
    setSaving(true);
    try {
      await onSave({
        hireDate: hireDate.trim() || null,
        payType: pay.payType ?? null,
        payRateCents: rateCents,
        payCadence: pay.payCadence,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save these changes.');
    } finally {
      setSaving(false);
    }
  };

  if (!visible) return null;

  return (
    <AppModal visible transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View style={styles.card}>
          <View style={styles.header}>
            <Text style={styles.title}>Edit payroll</Text>
            <View style={styles.headerActions}>
              <Pressable onPress={save} disabled={saving} style={[styles.addButton, saving && styles.buttonDisabled]}>
                <Text style={styles.addButtonText}>{saving ? 'Saving…' : 'Save'}</Text>
              </Pressable>
              <Pressable onPress={onClose} style={styles.close}>
                <Text style={styles.closeText}>Close</Text>
              </Pressable>
            </View>
          </View>
          <Text style={styles.fieldLabel}>HIRE DATE (YYYY-MM-DD)</Text>
          <TextInput value={hireDate} onChangeText={setHireDate} placeholder="2026-01-15" placeholderTextColor="#999999" style={styles.input} />
          <PayFields value={pay} onChange={setPay} />
          {error && <Text style={styles.error}>{error}</Text>}
        </View>
      </View>
    </AppModal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', alignItems: 'center', justifyContent: 'center', padding: 20 },
  card: { backgroundColor: '#FFFFFF', borderRadius: 18, padding: 20, width: '100%', maxWidth: 420 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  title: { fontSize: 16, fontWeight: '800', color: '#111111' },
  close: { backgroundColor: '#F2F2F2', borderRadius: 10, paddingHorizontal: 14, paddingVertical: 10 },
  closeText: { fontSize: 13, fontWeight: '700', color: '#111111' },
  fieldLabel: { fontSize: 10, letterSpacing: 0.6, fontWeight: '800', color: '#999999', marginBottom: 6 },
  input: { backgroundColor: '#F2F2F2', borderRadius: 10, height: 42, paddingHorizontal: 12, color: '#111111' },
  addButton: { backgroundColor: '#111111', borderRadius: 10, paddingHorizontal: 14, paddingVertical: 10 },
  addButtonText: { color: '#FFFFFF', fontWeight: '800', fontSize: 13 },
  buttonDisabled: { backgroundColor: '#CCCCCC' },
  error: { color: '#C0392B', fontSize: 13, fontWeight: '700', marginTop: 6 },
});
