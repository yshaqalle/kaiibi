import { useEffect, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { CategoryChip } from '@/components/category-chip';
import type { StaffMember } from '@/types/models';

export function EditPayModal({
  visible,
  member,
  onClose,
  onSave,
}: {
  visible: boolean;
  member: StaffMember;
  onClose: () => void;
  onSave: (patch: { hireDate?: string | null; payType?: StaffMember['payType']; payRateCents?: number | null }) => Promise<void>;
}) {
  const [hireDate, setHireDate] = useState(member.hireDate ?? '');
  const [payType, setPayType] = useState<StaffMember['payType']>(member.payType);
  const [rate, setRate] = useState(member.payRateCents != null ? (member.payRateCents / 100).toString() : '');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (visible) {
      setHireDate(member.hireDate ?? '');
      setPayType(member.payType);
      setRate(member.payRateCents != null ? (member.payRateCents / 100).toString() : '');
    }
  }, [visible, member]);

  const save = async () => {
    setSaving(true);
    try {
      await onSave({
        hireDate: hireDate.trim() || null,
        payType: payType ?? null,
        payRateCents: rate.trim() ? Math.round(parseFloat(rate) * 100) : null,
      });
    } finally {
      setSaving(false);
    }
  };

  if (!visible) return null;

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
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
          <Text style={[styles.fieldLabel, { marginTop: 10 }]}>PAY TYPE</Text>
          <View style={styles.chipRow}>
            {(['hourly', 'salary', 'fixed'] as const).map((t) => (
              <CategoryChip key={t} label={t[0].toUpperCase() + t.slice(1)} active={payType === t} onPress={() => setPayType(t)} />
            ))}
          </View>
          <Text style={[styles.fieldLabel, { marginTop: 10 }]}>PAY RATE (DOLLARS)</Text>
          <TextInput value={rate} onChangeText={setRate} placeholder="e.g. 8.50" placeholderTextColor="#999999" keyboardType="decimal-pad" style={styles.input} />
        </View>
      </View>
    </Modal>
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
  chipRow: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  addButton: { backgroundColor: '#111111', borderRadius: 10, paddingHorizontal: 14, paddingVertical: 10 },
  addButtonText: { color: '#FFFFFF', fontWeight: '800', fontSize: 13 },
  buttonDisabled: { backgroundColor: '#CCCCCC' },
});
