import { useEffect, useState } from 'react';
import { StyleSheet, TextInput } from 'react-native';

// Multiline field that saves on blur, not on every keystroke -- no existing
// multiline text component in this codebase to reuse. Used by the Customer
// detail pane's Notes section (Task 11).
export function NotesField({
  value,
  onSave,
  placeholder = 'Add a note…',
}: {
  value: string | null;
  onSave: (value: string | null) => Promise<void>;
  placeholder?: string;
}) {
  const [draft, setDraft] = useState(value ?? '');

  useEffect(() => {
    setDraft(value ?? '');
  }, [value]);

  const commit = () => {
    const trimmed = draft.trim();
    if (trimmed === (value ?? '')) return;
    onSave(trimmed || null).catch(() => setDraft(value ?? ''));
  };

  return (
    <TextInput
      value={draft}
      onChangeText={setDraft}
      onBlur={commit}
      placeholder={placeholder}
      placeholderTextColor="#999999"
      multiline
      style={styles.input}
    />
  );
}

const styles = StyleSheet.create({
  input: { backgroundColor: '#F2F2F2', borderRadius: 10, padding: 11, minHeight: 64, color: '#111111', fontSize: 12.5, lineHeight: 18, textAlignVertical: 'top' },
});
