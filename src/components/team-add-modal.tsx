import { useEffect, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { OptionPicker } from '@/components/option-picker';
import { provisionStaff } from '@/lib/staff';
import type { Role } from '@/types/models';

export function TeamAddModal({
  visible,
  shopId,
  roles,
  onClose,
  onChange,
}: {
  visible: boolean;
  shopId: string;
  roles: Role[];
  onClose: () => void;
  onChange: () => Promise<void>;
}) {
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [roleId, setRoleId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ email: string; temporaryPassword: string | null } | null>(null);

  useEffect(() => {
    if (visible) {
      setFullName('');
      setEmail('');
      setPhone('');
      setPassword('');
      setRoleId(roles[0]?.id ?? null);
      setError(null);
      setResult(null);
    }
  }, [visible, roles]);

  const submit = async () => {
    if (!fullName.trim() || !email.trim() || !roleId) return;
    setSaving(true);
    setError(null);
    try {
      const created = await provisionStaff({
        shopId,
        fullName: fullName.trim(),
        email: email.trim(),
        phone: phone.trim() || undefined,
        password: password.trim() || undefined,
        roleId,
      });
      await onChange();
      setResult({ email: created.email, temporaryPassword: created.temporaryPassword });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not add this staff member.');
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
            <Text style={styles.title}>Add staff</Text>
            <View style={styles.headerActions}>
              {!result && (
                <Pressable
                  onPress={submit}
                  disabled={saving || !fullName.trim() || !email.trim() || !roleId}
                  style={[styles.addButton, (saving || !fullName.trim() || !email.trim() || !roleId) && styles.buttonDisabled]}
                >
                  <Text style={styles.addButtonText}>{saving ? 'Adding…' : 'Add staff'}</Text>
                </Pressable>
              )}
              <Pressable onPress={onClose} style={styles.close}>
                <Text style={styles.closeText}>Close</Text>
              </Pressable>
            </View>
          </View>
          <ScrollView style={styles.list}>
            {result ? (
              <View>
                <Text style={styles.rowLabel}>Account created for {result.email}</Text>
                {result.temporaryPassword && (
                  <>
                    <Text style={styles.hint}>Share this password with them now — it won&apos;t be shown again.</Text>
                    <View style={styles.readOnlyField}>
                      <Text selectable style={styles.readOnlyFieldText}>
                        {result.temporaryPassword}
                      </Text>
                    </View>
                  </>
                )}
                <Pressable onPress={onClose} style={[styles.addButton, { marginTop: 16, alignSelf: 'flex-start' }]}>
                  <Text style={styles.addButtonText}>Done</Text>
                </Pressable>
              </View>
            ) : (
              <>
                <Text style={styles.fieldLabel}>FULL NAME</Text>
                <TextInput value={fullName} onChangeText={setFullName} placeholder="Full name" placeholderTextColor="#999999" style={styles.input} />
                <Text style={[styles.fieldLabel, { marginTop: 10 }]}>EMAIL</Text>
                <TextInput
                  value={email}
                  onChangeText={setEmail}
                  placeholder="you@example.com"
                  placeholderTextColor="#999999"
                  autoCapitalize="none"
                  keyboardType="email-address"
                  style={styles.input}
                />
                {/* Optional -- deliberately not in the submit guard below. It
                    is how the roster reaches this person on WhatsApp, not
                    part of their login. */}
                <Text style={[styles.fieldLabel, { marginTop: 10 }]}>PHONE (optional)</Text>
                <TextInput
                  value={phone}
                  onChangeText={setPhone}
                  placeholder="e.g. 063 400 0000"
                  placeholderTextColor="#999999"
                  keyboardType="phone-pad"
                  style={styles.input}
                />
                <Text style={[styles.fieldLabel, { marginTop: 10 }]}>PASSWORD (leave blank to generate one)</Text>
                <TextInput value={password} onChangeText={setPassword} placeholder="At least 6 characters" placeholderTextColor="#999999" style={styles.input} />
                <Text style={[styles.fieldLabel, { marginTop: 10 }]}>ROLE</Text>
                <OptionPicker
                  value={roleId}
                  onChange={(id) => id && setRoleId(id)}
                  options={roles.map((role) => ({ id: role.id, label: role.name }))}
                  title="Which role?"
                  placeholder="Choose a role"
                />
                {error && <Text style={styles.error}>{error}</Text>}
                <Pressable
                  onPress={submit}
                  disabled={saving || !fullName.trim() || !email.trim() || !roleId}
                  style={[
                    styles.addButton,
                    { marginTop: 16, alignSelf: 'flex-start' },
                    (saving || !fullName.trim() || !email.trim() || !roleId) && styles.buttonDisabled,
                  ]}
                >
                  <Text style={styles.addButtonText}>{saving ? 'Adding…' : 'Add staff'}</Text>
                </Pressable>
              </>
            )}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', alignItems: 'center', justifyContent: 'center', padding: 20 },
  card: { backgroundColor: '#FFFFFF', borderRadius: 18, padding: 20, width: '100%', maxWidth: 560, height: '80%', overflow: 'hidden' },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  title: { fontSize: 16, fontWeight: '800', color: '#111111' },
  close: { backgroundColor: '#111111', borderRadius: 10, paddingHorizontal: 18, paddingVertical: 12, alignItems: 'center', justifyContent: 'center' },
  closeText: { fontSize: 13, fontWeight: '800', color: '#FFFFFF' },
  list: { flex: 1 },
  hint: { fontSize: 12, color: '#9CA3AF', lineHeight: 17, marginTop: 8 },
  fieldLabel: { fontSize: 10, letterSpacing: 0.6, fontWeight: '800', color: '#999999', marginBottom: 6 },
  input: { backgroundColor: '#F2F2F2', borderRadius: 10, height: 42, paddingHorizontal: 12, color: '#111111' },
  chipRow: { gap: 8, paddingBottom: 11 },
  readOnlyField: { backgroundColor: '#F7F7F7', borderRadius: 10, paddingVertical: 12, paddingHorizontal: 12, marginTop: 8 },
  readOnlyFieldText: { color: '#111111', fontSize: 16, fontWeight: '700', letterSpacing: 0.5 },
  rowLabel: { fontSize: 13, fontWeight: '700', color: '#111111' },
  error: { color: '#C0392B', fontSize: 13, fontWeight: '700', marginTop: 6 },
  addButton: { backgroundColor: '#111111', borderRadius: 10, paddingHorizontal: 18, paddingVertical: 12, alignItems: 'center', justifyContent: 'center' },
  addButtonText: { color: '#FFFFFF', fontWeight: '800', fontSize: 13 },
  buttonDisabled: { backgroundColor: '#CCCCCC' },
});
