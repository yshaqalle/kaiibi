import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { Btn, PageHeader, Row, Section } from '@/components/settings/settings-primitives';
import { signOutEverywhere, updatePassword } from '@/lib/auth';
import { markPasswordChanged } from '@/lib/profile';
import type { Profile } from '@/types/models';

function timeAgo(iso: string): string {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days} days ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} month${months === 1 ? '' : 's'} ago`;
  const years = Math.floor(months / 12);
  return `${years} year${years === 1 ? '' : 's'} ago`;
}

// Real Supabase Auth calls throughout — no mock state. "Active sessions" is
// necessarily all-or-nothing (`signOutEverywhere` = auth.signOut with
// `scope: 'global'`): listing or revoking individual devices needs the
// service-role admin API, which isn't available from the client.
export function SecurityPanel({ profile, onProfileSaved }: { profile: Profile; onProfileSaved: (profile: Profile) => void }) {
  const router = useRouter();
  const [changingPassword, setChangingPassword] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const signOutAll = async () => {
    setSigningOut(true);
    setError(null);
    try {
      await signOutEverywhere();
      router.replace('/login');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not sign out.');
      setSigningOut(false);
    }
  };

  return (
    <View>
      <PageHeader title="Security" />
      {error && <Text style={styles.error}>{error}</Text>}
      <Section title="Password">
        <Row label="Password" desc={profile.passwordChangedAt ? `Last changed ${timeAgo(profile.passwordChangedAt)}` : 'Never changed here'}>
          <Btn onPress={() => setChangingPassword(true)}>Change</Btn>
        </Row>
      </Section>
      <Section title="Sessions">
        <Row label="Active sessions" desc="Sign out of this account on every device it's currently signed in on">
          <Btn danger onPress={signOutAll} disabled={signingOut}>
            {signingOut ? 'Signing out…' : 'Sign out all'}
          </Btn>
        </Row>
      </Section>
      <ChangePasswordModal
        visible={changingPassword}
        onClose={() => setChangingPassword(false)}
        onChanged={async () => {
          const updated = await markPasswordChanged(profile.id);
          onProfileSaved(updated);
        }}
      />
    </View>
  );
}

function ChangePasswordModal({
  visible,
  onClose,
  onChanged,
}: {
  visible: boolean;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const close = () => {
    setNewPassword('');
    setConfirmPassword('');
    setError(null);
    setDone(false);
    onClose();
  };

  const submit = async () => {
    if (newPassword.length < 6) {
      setError('Password must be at least 6 characters.');
      return;
    }
    if (newPassword !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await updatePassword(newPassword);
      await onChanged();
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update password.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal visible={visible} animationType="fade" transparent onRequestClose={close}>
      <View style={modalStyles.overlay}>
        <View style={modalStyles.card}>
          <View style={modalStyles.header}>
            <Text style={modalStyles.title}>Change password</Text>
            <Pressable onPress={close} style={modalStyles.close}>
              <Text style={modalStyles.closeText}>Close</Text>
            </Pressable>
          </View>
          {done ? (
            <>
              <Text style={modalStyles.doneText}>Password updated.</Text>
              <Pressable onPress={close} style={modalStyles.saveButton}>
                <Text style={modalStyles.saveButtonText}>Done</Text>
              </Pressable>
            </>
          ) : (
            <>
              <Text style={modalStyles.fieldLabel}>NEW PASSWORD</Text>
              <TextInput
                value={newPassword}
                onChangeText={setNewPassword}
                secureTextEntry
                placeholder="At least 6 characters"
                placeholderTextColor="#999999"
                style={modalStyles.input}
              />
              <Text style={modalStyles.fieldLabel}>CONFIRM NEW PASSWORD</Text>
              <TextInput
                value={confirmPassword}
                onChangeText={setConfirmPassword}
                secureTextEntry
                placeholder="Re-enter password"
                placeholderTextColor="#999999"
                style={modalStyles.input}
              />
              {error && <Text style={styles.error}>{error}</Text>}
              <Pressable onPress={submit} disabled={saving} style={[modalStyles.saveButton, saving && modalStyles.saveButtonDisabled]}>
                <Text style={modalStyles.saveButtonText}>{saving ? 'Saving…' : 'Save password'}</Text>
              </Pressable>
            </>
          )}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  error: { color: '#C0392B', fontSize: 13, fontWeight: '700', marginBottom: 16 },
});

const modalStyles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', alignItems: 'center', justifyContent: 'center', padding: 20 },
  card: { backgroundColor: '#FFFFFF', borderRadius: 18, padding: 20, width: '100%', maxWidth: 420 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 },
  title: { fontSize: 16, fontWeight: '800', color: '#111111' },
  close: { backgroundColor: '#F2F2F2', paddingVertical: 7, paddingHorizontal: 14, borderRadius: 8 },
  closeText: { fontSize: 13, fontWeight: '700', color: '#111111' },
  fieldLabel: { fontSize: 10, letterSpacing: 0.6, fontWeight: '800', color: '#999999', marginBottom: 6, marginTop: 10 },
  input: { backgroundColor: '#F2F2F2', borderRadius: 10, height: 42, paddingHorizontal: 12, color: '#111111' },
  saveButton: { backgroundColor: '#111111', borderRadius: 10, height: 44, alignItems: 'center', justifyContent: 'center', marginTop: 16 },
  saveButtonDisabled: { backgroundColor: '#CCCCCC' },
  saveButtonText: { color: '#FFFFFF', fontWeight: '800', fontSize: 13 },
  doneText: { fontSize: 14, color: '#111111', marginBottom: 4 },
});
