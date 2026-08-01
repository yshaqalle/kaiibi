import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { Btn, EditableTextRow, PageHeader, ReadOnlyRow, Row, Section, Toggle } from '@/components/settings/settings-primitives';
import { updateProfile } from '@/lib/profile';
import type { Profile } from '@/types/models';

export function ProfilePanel({ profile, email, onSaved }: { profile: Profile; email: string | null; onSaved: (profile: Profile) => void }) {
  const [fullName, setFullName] = useState(profile.fullName ?? '');
  const [phone, setPhone] = useState(profile.phone ?? '');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Phase 2 placeholder — the app has no runtime theme switching yet
  // (Colors.dark exists but nothing reads it), so this toggle is local-only.
  const [darkMode, setDarkMode] = useState(false);

  const dirty = fullName.trim() !== (profile.fullName ?? '') || phone.trim() !== (profile.phone ?? '');

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const updated = await updateProfile(profile.id, { fullName: fullName.trim(), phone: phone.trim() });
      onSaved(updated);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save changes.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <View>
      <PageHeader title="Profile" actionLabel={saving ? 'Saving…' : saved ? 'Saved ✓' : 'Save changes'} onAction={save} actionDisabled={!dirty || saving} />
      {error && <Text style={styles.error}>{error}</Text>}
      <Section title="Your profile">
        <EditableTextRow label="Full name" value={fullName} onChangeText={setFullName} placeholder="Full name" />
        {email && <ReadOnlyRow label="Email" value={email} />}
        <EditableTextRow label="Phone" value={phone} onChangeText={setPhone} placeholder="Phone number" keyboardType="phone-pad" />
        {/* Phase 2 placeholder — no language setting exists yet. */}
        <Row label="Language" desc="English">
          <Btn onPress={() => {}}>Change</Btn>
        </Row>
      </Section>
      <Section title="Appearance">
        <Row label="Dark mode" desc="Switch the app to a dark theme">
          <Toggle value={darkMode} onValueChange={setDarkMode} />
        </Row>
      </Section>
    </View>
  );
}

const styles = StyleSheet.create({
  error: { color: '#C0392B', fontSize: 13, fontWeight: '700', marginBottom: 16 },
});
