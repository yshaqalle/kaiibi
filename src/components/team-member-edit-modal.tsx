import { useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { CategoryChip } from '@/components/category-chip';
import { DateInput } from '@/components/date-input';
import { PayFields, payFieldsInitial, payFieldsToCents, type PayFieldsValue } from '@/components/pay-fields';
import { isValidRateInput } from '@/lib/pay-rate';
import type { Role, ShopLocation, StaffMember } from '@/types/models';

type MemberEdits = {
  fullName: string;
  email: string;
  roleId: string;
  locationId: string | null;
  active: boolean;
  hireDate?: string | null;
  payType?: StaffMember['payType'];
  payRateCents?: number | null;
  payCadence?: StaffMember['payCadence'];
};

type TeamMemberEditModalProps = {
  visible: boolean;
  member: StaffMember;
  roles: Role[];
  locations: ShopLocation[];
  canManagePayroll: boolean;
  onClose: () => void;
  onSave: (input: MemberEdits) => Promise<void>;
};

export function TeamMemberEditModal({ visible, member, roles, locations, canManagePayroll, onClose, onSave }: TeamMemberEditModalProps) {
  const [fullName, setFullName] = useState(member.fullName ?? '');
  const [email, setEmail] = useState(member.email ?? '');
  const [roleId, setRoleId] = useState(member.roleId);
  const [locationId, setLocationId] = useState<string | null>(member.locationId);
  const [active, setActive] = useState(member.active);
  const [hireDate, setHireDate] = useState(member.hireDate ?? '');
  const [pay, setPay] = useState<PayFieldsValue>(payFieldsInitial(member));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    if (!fullName.trim() || !email.trim() || !roleId) {
      setError('Name, email, and role are required.');
      return;
    }
    // payFieldsToCents delegates to toCents, which never fails to parse --
    // unparseable text like "abc" quietly collapses to 0 rather than null.
    // Validating the raw text with isValidRateInput (rather than gating on
    // the converted cents) is what catches that, without also rejecting a
    // legitimately-typed "0".
    if (!isValidRateInput(pay.rate)) {
      setError('Enter a valid pay rate.');
      return;
    }
    const rateCents = payFieldsToCents(pay);

    setSaving(true);
    setError(null);
    try {
      await onSave({
        fullName: fullName.trim(),
        email: email.trim(),
        roleId,
        locationId,
        active,
        ...(canManagePayroll
          ? {
              hireDate: hireDate || null,
              payType: pay.payType ?? null,
              payRateCents: rateCents,
              payCadence: pay.payCadence,
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
            {/* Access is (store, role): the role above says what they may do,
                this says where. Hidden for a single-store business, where
                "which store" has one answer and the choice would be noise. */}
            {locations.length > 1 && (
              <>
                <Text style={styles.label}>STORE</Text>
                <ScrollView horizontal contentContainerStyle={styles.chips} showsHorizontalScrollIndicator={false}>
                  <CategoryChip label="All stores" active={locationId === null} onPress={() => setLocationId(null)} />
                  {locations.filter((location) => location.active).map((location) => (
                    <CategoryChip
                      key={location.id}
                      label={location.name}
                      active={location.id === locationId}
                      onPress={() => setLocationId(location.id)}
                    />
                  ))}
                </ScrollView>
                <Text style={styles.hint}>
                  {locationId === null
                    ? 'Can work at every store.'
                    : 'Can only sell, count stock and clock in at this store.'}
                </Text>
              </>
            )}
            <Text style={styles.label}>STATUS</Text>
            <View style={styles.chips}>
              <CategoryChip label="Active" active={active} onPress={() => setActive(true)} />
              <CategoryChip label="Disabled" active={!active} onPress={() => setActive(false)} />
            </View>
            {canManagePayroll && (
              <>
                <Text style={styles.label}>HIRE DATE</Text>
                <DateInput value={hireDate} onChangeText={setHireDate} />
                <PayFields value={pay} onChange={setPay} />
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
  hint: { color: '#9CA3AF', fontSize: 12, lineHeight: 17, marginTop: 6 },
  input: { backgroundColor: '#F2F2F2', height: 42, borderRadius: 10, paddingHorizontal: 12, color: '#111111' },
  chips: { flexDirection: 'row', gap: 8, paddingBottom: 2 },
  save: { backgroundColor: '#111111', borderRadius: 10, paddingVertical: 12, paddingHorizontal: 16, alignSelf: 'flex-start', marginTop: 20 },
  saveText: { color: '#FFFFFF', fontWeight: '800', fontSize: 13 },
  disabled: { opacity: 0.5 },
  error: { color: '#C0392B', fontWeight: '700', fontSize: 12, marginTop: 12 },
});
