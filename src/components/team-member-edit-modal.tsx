import { useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { CategoryChip } from '@/components/category-chip';
import { DateInput } from '@/components/date-input';
import type { Role, StaffMember } from '@/types/models';

type MemberEdits = {
  fullName: string;
  email: string;
  roleId: string;
  active: boolean;
  hireDate?: string | null;
  payType?: StaffMember['payType'];
  payRateCents?: number | null;
};

type TeamMemberEditModalProps = {
  visible: boolean;
  member: StaffMember;
  roles: Role[];
  canManagePayroll: boolean;
  onClose: () => void;
  onSave: (input: MemberEdits) => Promise<void>;
};

export function TeamMemberEditModal({ visible, member, roles, canManagePayroll, onClose, onSave }: TeamMemberEditModalProps) {
  const [fullName, setFullName] = useState(member.fullName ?? '');
  const [email, setEmail] = useState(member.email ?? '');
  const [roleId, setRoleId] = useState(member.roleId);
  const [active, setActive] = useState(member.active);
  const [hireDate, setHireDate] = useState(member.hireDate ?? '');
  const [payType, setPayType] = useState<StaffMember['payType']>(member.payType);
  const [rate, setRate] = useState(member.payRateCents != null ? (member.payRateCents / 100).toString() : '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    if (!fullName.trim() || !email.trim() || !roleId) {
      setError('Name, email, and role are required.');
      return;
    }
    if (rate.trim() && Number.isNaN(Number(rate))) {
      setError('Enter a valid pay rate.');
      return;
    }

    setSaving(true);
    setError(null);
    try {
      await onSave({
        fullName: fullName.trim(),
        email: email.trim(),
        roleId,
        active,
        ...(canManagePayroll
          ? {
              hireDate: hireDate || null,
              payType: payType ?? null,
              payRateCents: rate.trim() ? Math.round(Number(rate) * 100) : null,
            }
          : {}),
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save this team member.');
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
            <Text style={styles.title}>Edit team member</Text>
            <Pressable onPress={onClose} style={styles.close}>
              <Text style={styles.closeText}>Close</Text>
            </Pressable>
          </View>
          <ScrollView>
            <Text style={styles.label}>FULL NAME</Text>
            <TextInput value={fullName} onChangeText={setFullName} style={styles.input} />
            <Text style={styles.label}>EMAIL</Text>
            <TextInput value={email} onChangeText={setEmail} autoCapitalize="none" keyboardType="email-address" style={styles.input} />
            <Text style={styles.label}>ROLE</Text>
            <ScrollView horizontal contentContainerStyle={styles.chips} showsHorizontalScrollIndicator={false}>
              {roles.map((role) => (
                <CategoryChip key={role.id} label={role.name} active={role.id === roleId} onPress={() => setRoleId(role.id)} />
              ))}
            </ScrollView>
            <Text style={styles.label}>STATUS</Text>
            <View style={styles.chips}>
              <CategoryChip label="Active" active={active} onPress={() => setActive(true)} />
              <CategoryChip label="Disabled" active={!active} onPress={() => setActive(false)} />
            </View>
            {canManagePayroll && (
              <>
                <Text style={styles.label}>HIRE DATE</Text>
                <DateInput value={hireDate} onChangeText={setHireDate} />
                <Text style={styles.label}>PAY TYPE</Text>
                <View style={styles.chips}>
                  {(['hourly', 'salary', 'fixed'] as const).map((type) => (
                    <CategoryChip key={type} label={type[0].toUpperCase() + type.slice(1)} active={payType === type} onPress={() => setPayType(type)} />
                  ))}
                </View>
                <Text style={styles.label}>PAY RATE (DOLLARS)</Text>
                <TextInput value={rate} onChangeText={setRate} keyboardType="decimal-pad" style={styles.input} />
              </>
            )}
            {error && <Text style={styles.error}>{error}</Text>}
            <Pressable onPress={save} disabled={saving} style={[styles.save, saving && styles.disabled]}>
              <Text style={styles.saveText}>{saving ? 'Saving…' : 'Save changes'}</Text>
            </Pressable>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'center', padding: 20 },
  card: { backgroundColor: '#FFFFFF', borderRadius: 18, padding: 20, width: '100%', maxWidth: 520, maxHeight: '85%', alignSelf: 'center' },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 },
  title: { color: '#111111', fontSize: 17, fontWeight: '800' },
  close: { backgroundColor: '#F2F2F2', borderRadius: 9, paddingHorizontal: 12, paddingVertical: 9 },
  closeText: { color: '#111111', fontWeight: '800', fontSize: 12 },
  label: { color: '#999999', fontSize: 10, fontWeight: '800', letterSpacing: 0.6, marginTop: 12, marginBottom: 6 },
  input: { backgroundColor: '#F2F2F2', height: 42, borderRadius: 10, paddingHorizontal: 12, color: '#111111' },
  chips: { flexDirection: 'row', gap: 8, paddingBottom: 2 },
  save: { backgroundColor: '#111111', borderRadius: 10, paddingVertical: 12, paddingHorizontal: 16, alignSelf: 'flex-start', marginTop: 20 },
  saveText: { color: '#FFFFFF', fontWeight: '800', fontSize: 13 },
  disabled: { opacity: 0.5 },
  error: { color: '#C0392B', fontWeight: '700', fontSize: 12, marginTop: 12 },
});
