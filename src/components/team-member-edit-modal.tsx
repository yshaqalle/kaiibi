import * as ImagePicker from 'expo-image-picker';
import { useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { CategoryChip } from '@/components/category-chip';
import { MultiOptionPicker, OptionPicker } from '@/components/option-picker';
import { DateInput } from '@/components/date-input';
import { PayFields, payFieldsInitial, payFieldsToCents, type PayFieldsValue } from '@/components/pay-fields';
import { Avatar } from '@/components/ui/avatar';
import { Colors } from '@/constants/theme';
import { isValidRateInput } from '@/lib/pay-rate';
import { updateStaffPhoto, uploadStaffPhoto } from '@/lib/staff';
import type { Role, ShopLocation, StaffMember } from '@/types/models';

const theme = Colors.light;

type MemberEdits = {
  fullName: string;
  email: string;
  phone: string | null;
  roleId: string;
  locationIds: string[];
  active: boolean;
  hireDate?: string | null;
  payType?: StaffMember['payType'];
  payRateCents?: number | null;
  payCadence?: StaffMember['payCadence'];
};

type TeamMemberEditModalProps = {
  visible: boolean;
  shopId: string;
  member: StaffMember;
  roles: Role[];
  locations: ShopLocation[];
  canManagePayroll: boolean;
  onClose: () => void;
  onSave: (input: MemberEdits) => Promise<void>;
};

export function TeamMemberEditModal({ visible, shopId, member, roles, locations, canManagePayroll, onClose, onSave }: TeamMemberEditModalProps) {
  const [fullName, setFullName] = useState(member.fullName ?? '');
  const [email, setEmail] = useState(member.email ?? '');
  const [phone, setPhone] = useState(member.phone ?? '');
  const [roleId, setRoleId] = useState(member.roleId);
  const [locationIds, setLocationIds] = useState<string[]>(member.locationIds);
  const [active, setActive] = useState(member.active);
  const [hireDate, setHireDate] = useState(member.hireDate ?? '');
  const [pay, setPay] = useState<PayFieldsValue>(payFieldsInitial(member));
  // The existing remote URL to start, a local uri once a new photo is picked
  // -- distinguishing the two is what tells save() whether there is anything
  // new to upload.
  const [photoUri, setPhotoUri] = useState<string | null>(member.photoUrl);
  const [saving, setSaving] = useState(false);
  const [uploadingPhoto, setUploadingPhoto] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pickPhoto = async () => {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) return;
    const picked = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], allowsEditing: true, aspect: [1, 1], quality: 0.8 });
    if (!picked.canceled) setPhotoUri(picked.assets[0].uri);
  };

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
        // Blank clears the number rather than leaving the old one in place --
        // the field is optional, so emptying it is a real edit.
        phone: phone.trim() || null,
        roleId,
        locationIds,
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
      // Written AFTER onSave, not before: a freshly picked photo is a local
      // uri, not the http(s) URL already on the member -- written directly
      // against shop_members (like setStaffLocations below), not folded into
      // onSave's payload, because the update-staff Edge Function has no idea
      // this column exists and would silently drop it. It runs after onSave
      // rather than before/inside the same try so a photo failure can't take
      // the name/email/phone/role/active/location/pay write down with it --
      // matching TeamAddModal's submit(), where the same failure is caught
      // locally and reported as a partial success instead of failing the
      // whole save.
      if (photoUri && photoUri !== member.photoUrl) {
        setUploadingPhoto(true);
        try {
          const photoUrl = await uploadStaffPhoto(shopId, member.id, photoUri);
          await updateStaffPhoto(member.id, photoUrl);
        } catch (err) {
          setError(`Team member was saved, but their photo could not be saved (${err instanceof Error ? err.message : 'unknown error'}). Try again from their profile.`);
          return;
        } finally {
          setUploadingPhoto(false);
        }
      }
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
            <Text style={styles.label}>PHOTO</Text>
            <View style={styles.photoRow}>
              <Avatar photoUrl={photoUri} name={fullName || null} size={56} />
              <Pressable
                onPress={pickPhoto}
                style={styles.photoPicker}
                accessibilityRole="button"
                accessibilityLabel={photoUri ? 'Change staff photo' : 'Upload a staff photo'}
              >
                <Text style={styles.photoPickerText}>Click to upload a photo</Text>
              </Pressable>
            </View>
            <Text style={styles.label}>FULL NAME</Text>
            <TextInput value={fullName} onChangeText={setFullName} style={styles.input} />
            <Text style={styles.label}>EMAIL</Text>
            <TextInput value={email} onChangeText={setEmail} autoCapitalize="none" keyboardType="email-address" style={styles.input} />
            {/* Outside the payroll block below on purpose: a phone number is
                contact detail, so anyone who can edit the roster can set it. */}
            <Text style={styles.label}>PHONE</Text>
            <TextInput
              value={phone}
              onChangeText={setPhone}
              placeholder="e.g. 063 400 0000"
              placeholderTextColor="#999999"
              keyboardType="phone-pad"
              style={styles.input}
            />
            <Text style={styles.label}>ROLE</Text>
            <OptionPicker
              value={roleId}
              onChange={(id) => id && setRoleId(id)}
              options={roles.map((role) => ({ id: role.id, label: role.name }))}
              title="Which role?"
              placeholder="Choose a role"
            />
            {/* Access is (stores, role): the role above says what they may do,
                these say where. A multi-select, not one choice — someone can
                cover two of three stores. Hidden for a single-store business,
                where "which store" has one answer and this would be noise. */}
            {locations.length > 1 && (
              <>
                <Text style={styles.label}>STORES</Text>
                {/* Clearing the set IS "all stores" — the empty array is the
                    value, not a missing one, so it is a real choice rather than
                    a shortcut for selecting everything. */}
                <MultiOptionPicker
                  values={locationIds}
                  onChange={setLocationIds}
                  options={locations
                    .filter((location) => location.active)
                    .map((location) => ({ id: location.id, label: location.name }))}
                  allOption={{ label: 'All stores', hint: 'Can work anywhere' }}
                  title="Which stores can they work at?"
                />
                <Text style={styles.hint}>
                  {locationIds.length === 0
                    ? 'Can work at every store.'
                    : `Can sell, count stock and clock in at ${locationIds.length === 1 ? 'this store' : `these ${locationIds.length} stores`} only.`}
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
              <Text style={styles.saveText}>{uploadingPhoto ? 'Uploading photo…' : saving ? 'Saving…' : 'Save changes'}</Text>
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
  photoRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  photoPicker: {
    flex: 1,
    height: 56,
    borderWidth: 1,
    borderColor: theme.bentoLine,
    borderStyle: 'dashed',
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.bentoSoft,
  },
  photoPickerText: { fontSize: 12, fontWeight: '700', color: theme.bentoMuted },
  input: { backgroundColor: '#F2F2F2', height: 42, borderRadius: 10, paddingHorizontal: 12, color: '#111111' },
  chips: { flexDirection: 'row', gap: 8, paddingBottom: 2 },
  save: { backgroundColor: '#111111', borderRadius: 10, paddingVertical: 12, paddingHorizontal: 16, alignSelf: 'flex-start', marginTop: 20 },
  saveText: { color: '#FFFFFF', fontWeight: '800', fontSize: 13 },
  disabled: { opacity: 0.5 },
  error: { color: '#C0392B', fontWeight: '700', fontSize: 12, marginTop: 12 },
});
