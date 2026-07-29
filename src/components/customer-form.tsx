import { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { CategoryChip } from '@/components/category-chip';
import { createTag, listTags } from '@/lib/tags';
import type { Customer, NewCustomerInput } from '@/types/models';

export function CustomerForm({
  initial,
  onSubmit,
  onDelete,
  submitLabel,
  shopId,
}: {
  initial?: Customer;
  onSubmit: (input: NewCustomerInput) => Promise<void>;
  onDelete?: () => Promise<void>;
  submitLabel: string;
  shopId: string;
}) {
  const [firstName, setFirstName] = useState(initial?.firstName ?? '');
  const [lastName, setLastName] = useState(initial?.lastName ?? '');
  const [email, setEmail] = useState(initial?.email ?? '');
  const [phone, setPhone] = useState(initial?.phone ?? '');
  const [street, setStreet] = useState(initial?.street ?? '');
  const [city, setCity] = useState(initial?.city ?? '');
  const [neighborhood, setNeighborhood] = useState(initial?.neighborhood ?? '');
  const [tags, setTags] = useState(initial?.tags?.join(', ') ?? '');
  const [tagSuggestions, setTagSuggestions] = useState<string[]>([]);
  const [tagColors, setTagColors] = useState<Map<string, string | null>>(new Map());
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  useEffect(() => {
    listTags(shopId)
      .then((rows) => { setTagSuggestions(rows.map((r) => r.name)); setTagColors(new Map(rows.map((r) => [r.name, r.color]))); })
      .catch(() => {});
  }, [shopId]);

  const valid = Boolean(firstName.trim());

  const submit = async () => {
    if (!valid) return;
    setSubmitting(true);
    setError(null);
    try {
      const tagList = tags.split(',').map((tag) => tag.trim()).filter(Boolean);
      // A tag typed here for the first time (via "+ Add …") only exists as
      // free text on this customer until it's also in the tags table --
      // persist it now, same as product-form.tsx does for its own tags.
      await Promise.all(tagList.filter((tag) => !tagSuggestions.includes(tag)).map((tag) => createTag(shopId, tag)));

      await onSubmit({
        firstName: firstName.trim(),
        lastName: lastName.trim() || null,
        email: email.trim() || null,
        phone: phone.trim() || null,
        street: street.trim() || null,
        city: city.trim() || null,
        neighborhood: neighborhood.trim() || null,
        tags: tagList,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save this customer.');
    } finally {
      setSubmitting(false);
    }
  };

  const confirmDelete = async () => {
    if (!onDelete) return;
    setDeleting(true);
    setError(null);
    try {
      await onDelete();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete this customer.');
      setDeleting(false);
      setConfirmingDelete(false);
    }
  };

  return (
    <ScrollView contentContainerStyle={styles.content}>
      <Field label="FIRST NAME *"><TextInput value={firstName} onChangeText={setFirstName} placeholder="e.g. Amina" placeholderTextColor="#999999" style={styles.input} /></Field>
      <Field label="LAST NAME"><TextInput value={lastName} onChangeText={setLastName} placeholder="Optional" placeholderTextColor="#999999" style={styles.input} /></Field>
      <Row>
        <Field label="PHONE" style={styles.half}><TextInput value={phone} onChangeText={setPhone} placeholder="Optional" placeholderTextColor="#999999" keyboardType="phone-pad" style={styles.input} /></Field>
        <Field label="EMAIL" style={styles.half}><TextInput value={email} onChangeText={setEmail} placeholder="Optional" placeholderTextColor="#999999" keyboardType="email-address" autoCapitalize="none" style={styles.input} /></Field>
      </Row>
      <Field label="STREET"><TextInput value={street} onChangeText={setStreet} placeholder="Optional" placeholderTextColor="#999999" style={styles.input} /></Field>
      <Row>
        <Field label="CITY" style={styles.half}><TextInput value={city} onChangeText={setCity} placeholder="Optional" placeholderTextColor="#999999" style={styles.input} /></Field>
        <Field label="NEIGHBORHOOD" style={styles.half}><TextInput value={neighborhood} onChangeText={setNeighborhood} placeholder="Optional" placeholderTextColor="#999999" style={styles.input} /></Field>
      </Row>
      <Field label="INTEREST TAGS">
        <TagsField
          value={tags}
          onChange={setTags}
          suggestions={tagSuggestions}
          colors={tagColors}
          onNewTag={(tag) => setTagSuggestions((prev) => [...prev, tag].sort((a, b) => a.localeCompare(b)))}
        />
      </Field>
      {error && <Text style={styles.error}>{error}</Text>}
      <Pressable onPress={submit} style={[styles.save, (!valid || submitting) && styles.saveDisabled]} disabled={!valid || submitting}>
        <Text style={styles.saveText}>{submitting ? 'Saving…' : submitLabel}</Text>
      </Pressable>
      {onDelete && (
        confirmingDelete ? (
          <View style={styles.confirmRow}>
            <Text style={styles.confirmText}>Delete this customer?</Text>
            <Pressable onPress={confirmDelete} disabled={deleting}><Text style={styles.confirmDanger}>{deleting ? 'Deleting…' : 'Confirm'}</Text></Pressable>
            <Pressable onPress={() => setConfirmingDelete(false)}><Text style={styles.confirmCancel}>Cancel</Text></Pressable>
          </View>
        ) : (
          <Pressable onPress={() => setConfirmingDelete(true)} style={styles.deleteButton}>
            <Text style={styles.deleteText}>Delete customer</Text>
          </Pressable>
        )
      )}
    </ScrollView>
  );
}

function Row({ children }: { children: React.ReactNode }) { return <View style={styles.row}>{children}</View>; }
function Field({ label, children, style }: { label: string; children: React.ReactNode; style?: object }) {
  return <View style={style}><Text style={styles.fieldLabel}>{label}</Text>{children}</View>;
}

// Same multi-select tag chip pattern as product-form.tsx's own TagsField --
// reimplemented locally rather than imported/shared, matching that file's
// own note that it isn't currently exported.
function TagsField({
  value,
  onChange,
  suggestions,
  colors,
  onNewTag,
}: {
  value: string;
  onChange: (value: string) => void;
  suggestions: string[];
  colors?: Map<string, string | null>;
  onNewTag?: (tag: string) => void;
}) {
  const [query, setQuery] = useState('');
  const selected = value.split(',').map((t) => t.trim()).filter(Boolean);
  const q = query.trim().toLowerCase();
  const filtered = q ? suggestions.filter((tag) => tag.toLowerCase().includes(q)) : suggestions;
  const exactMatch = suggestions.some((tag) => tag.toLowerCase() === q);

  const addTag = (tag: string) => {
    if (!tag || selected.includes(tag)) return;
    onChange([...selected, tag].join(', '));
    if (!suggestions.includes(tag)) onNewTag?.(tag);
    setQuery('');
  };
  const removeTag = (tag: string) => onChange(selected.filter((t) => t !== tag).join(', '));
  const toggleTag = (tag: string) => (selected.includes(tag) ? removeTag(tag) : addTag(tag));

  return (
    <>
      <TextInput value={value} onChangeText={onChange} placeholder="e.g. loyal, wholesale" placeholderTextColor="#999999" style={styles.input} />
      <TextInput value={query} onChangeText={setQuery} placeholder="Search tags…" placeholderTextColor="#999999" style={styles.input} />
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
        {filtered.map((tag) => (
          <CategoryChip key={tag} label={tag} color={colors?.get(tag)} active={selected.includes(tag)} onPress={() => toggleTag(tag)} />
        ))}
        {q.length > 0 && !exactMatch && (
          <CategoryChip label={`+ Add "${query.trim()}"`} active={false} onPress={() => addTag(query.trim())} />
        )}
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  content: { padding: 16, paddingBottom: 60 },
  row: { flexDirection: 'row', gap: 8 },
  half: { flex: 1 },
  fieldLabel: { fontSize: 10, letterSpacing: 1, fontWeight: '800', color: '#999999', marginBottom: 7, marginTop: 3 },
  input: { backgroundColor: '#F2F2F2', borderRadius: 9, paddingHorizontal: 11, height: 43, color: '#111111', marginBottom: 8 },
  chips: { gap: 7, paddingBottom: 12 },
  error: { color: '#C0392B', fontSize: 12, fontWeight: '700', marginBottom: 10 },
  save: { backgroundColor: '#111111', height: 45, borderRadius: 9, alignItems: 'center', justifyContent: 'center' },
  saveDisabled: { backgroundColor: '#CCCCCC' },
  saveText: { color: '#fff', fontWeight: '800' },
  deleteButton: { alignItems: 'center', paddingVertical: 16 },
  deleteText: { color: '#C0392B', fontWeight: '800', fontSize: 13 },
  confirmRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 16, paddingVertical: 16 },
  confirmText: { color: '#555555', fontSize: 13, fontWeight: '600' },
  confirmDanger: { color: '#C0392B', fontWeight: '800', fontSize: 13 },
  confirmCancel: { color: '#999999', fontWeight: '700', fontSize: 13 },
});
