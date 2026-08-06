import { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';

import { Colors } from '@/constants/theme';

const theme = Colors.light;

// Multiline field that saves on blur, not on every keystroke -- no existing
// multiline text component in this codebase to reuse. Used by the Customer
// detail pane's Notes section.
//
// Blur is not the only moment it has to save. The detail pane keys this on the
// customer id, so picking another customer UNMOUNTS a still-focused input, and
// a browser does not reliably fire blur/focusout for a node removed while it
// has focus. Without the unmount save below, the note you just typed vanished
// with no warning -- the field looked like it was working right up until the
// moment it lost your work.
export function NotesField({
  value,
  onSave,
  placeholder = 'Add a note…',
  readOnly = false,
}: {
  value: string | null;
  onSave: (value: string | null) => Promise<void>;
  placeholder?: string;
  readOnly?: boolean;
}) {
  return readOnly ? <ReadOnlyNote value={value} /> : <EditableNotesField value={value} onSave={onSave} placeholder={placeholder} />;
}

// Plain text rendering for a viewer who cannot edit. Deliberately a separate
// component rather than `editable={false}` on the TextInput below: that would
// still mount the commit-on-blur and save-on-unmount paths, which stay wired
// to `onSave` and can still fire. A read-only field that quietly tries to
// save on unmount is the same data-loss bug this file already fixed once,
// just harder to notice.
function ReadOnlyNote({ value }: { value: string | null }) {
  const trimmed = value?.trim();
  return (
    <View>
      <Text style={trimmed ? styles.readOnlyText : styles.readOnlyPlaceholder}>{trimmed || 'No notes.'}</Text>
    </View>
  );
}

function EditableNotesField({
  value,
  onSave,
  placeholder,
}: {
  value: string | null;
  onSave: (value: string | null) => Promise<void>;
  placeholder: string;
}) {
  const [draft, setDraft] = useState(value ?? '');
  const [error, setError] = useState<string | null>(null);
  // What has already been sent. Compared against rather than `value`, because
  // `value` only catches up once the save round-trips and the pane reloads --
  // blurring and then immediately switching customer would otherwise send the
  // same edit twice.
  const [committed, setCommitted] = useState(value ?? '');

  // Re-seed when the caller hands us a different customer's note. Done during
  // render rather than in an effect: an effect would paint one frame of the
  // previous person's note first, and React's own guidance is to adjust state
  // during render when it derives from a changed prop.
  const [seenValue, setSeenValue] = useState(value);
  if (value !== seenValue) {
    setSeenValue(value);
    setDraft(value ?? '');
    setCommitted(value ?? '');
    setError(null);
  }

  // Mirrored into a ref so the unmount cleanup can read the LATEST of each.
  // Without this the cleanup closes over its first render and would save
  // whatever the draft was when the field appeared. `onSave` is in here too
  // because the caller passes an inline arrow -- a new function identity every
  // render -- so depending on it directly would make the cleanup fire on every
  // render instead of only on a real unmount.
  const latest = useRef({ draft, committed, onSave });
  useEffect(() => {
    latest.current = { draft, committed, onSave };
  });

  const send = (next: string) => {
    setCommitted(next);
    setError(null);
    onSave(next || null).catch((err) => {
      // Every other action in this pane surfaces its failure; this one used to
      // swallow it and silently snap the text back, which reads as the app
      // deciding your note was not worth keeping.
      setCommitted(value ?? '');
      setDraft(value ?? '');
      setError(err instanceof Error ? err.message : 'Could not save this note.');
    });
  };

  const commit = () => {
    const trimmed = draft.trim();
    if (trimmed === committed) return;
    send(trimmed);
  };

  useEffect(() => {
    return () => {
      const { draft: pending, committed: sent, onSave: save } = latest.current;
      const trimmed = pending.trim();
      if (trimmed === sent) return;
      // No error handling on this path on purpose: the component is already
      // going away, so there is nowhere to show one. Attempting the save and
      // losing the error still beats dropping the edit without trying.
      save(trimmed || null).catch(() => {});
    };
  }, []);

  return (
    <View>
      <TextInput
        value={draft}
        onChangeText={setDraft}
        onBlur={commit}
        placeholder={placeholder}
        placeholderTextColor={theme.bentoMuted2}
        multiline
        style={styles.input}
      />
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  input: {
    backgroundColor: theme.bentoSoft,
    borderRadius: 10,
    padding: 11,
    minHeight: 64,
    color: theme.bentoInk,
    fontSize: 12.5,
    lineHeight: 18,
    textAlignVertical: 'top',
  },
  error: { marginTop: 6, fontSize: 12, color: theme.bentoLoss },
  readOnlyText: {
    backgroundColor: theme.bentoSoft,
    borderRadius: 10,
    padding: 11,
    minHeight: 64,
    color: theme.bentoInk,
    fontSize: 12.5,
    lineHeight: 18,
  },
  readOnlyPlaceholder: {
    backgroundColor: theme.bentoSoft,
    borderRadius: 10,
    padding: 11,
    minHeight: 64,
    color: theme.bentoMuted2,
    fontSize: 12.5,
    lineHeight: 18,
  },
});
