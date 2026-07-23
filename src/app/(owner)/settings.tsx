import { useCallback, useEffect, useState } from 'react';
import { Pressable, SafeAreaView, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { ScreenHeader } from '@/components/screen-header';
import { useAuth } from '@/hooks/use-auth';
import { createCategory, deleteCategory, listCategories, renameCategory } from '@/lib/categories';
import { createTag, deleteTag, listTags, renameTag } from '@/lib/tags';

export default function SettingsScreen() {
  const { shop } = useAuth();
  const [categories, setCategories] = useState<string[]>([]);
  const [tags, setTags] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!shop) return;
    setLoading(true);
    try {
      const [cats, tagRows] = await Promise.all([listCategories(shop.id), listTags(shop.id)]);
      setCategories(cats.map((c) => c.name));
      setTags(tagRows.map((t) => t.name));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load categories and tags.');
    } finally {
      setLoading(false);
    }
  }, [shop]);

  useEffect(() => { reload(); }, [reload]);

  const runOrShowError = async (action: () => Promise<void>) => {
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
    }
  };

  if (!shop) return null;

  return (
    <SafeAreaView style={styles.safeArea}>
      <ScreenHeader title="Settings" />
      <ScrollView contentContainerStyle={styles.content}>
        {error && <Text style={styles.error}>{error}</Text>}
        {loading ? (
          <Text style={styles.hint}>Loading…</Text>
        ) : (
          <>
            <EditableList
              title="CATEGORIES"
              itemLabel="category"
              hint="Group products in the POS and inventory screens. Renaming or removing a category updates every product using it."
              items={categories}
              onAdd={(name) => runOrShowError(async () => { await createCategory(shop.id, name); await reload(); })}
              onRename={(oldName, newName) => runOrShowError(async () => { await renameCategory(shop.id, oldName, newName); await reload(); })}
              onDelete={(name) => runOrShowError(async () => { await deleteCategory(shop.id, name); await reload(); })}
            />
            <EditableList
              title="TAGS"
              itemLabel="tag"
              hint="Extra keywords for products, like bestseller or handmade."
              items={tags}
              onAdd={(name) => runOrShowError(async () => { await createTag(shop.id, name); await reload(); })}
              onRename={(oldName, newName) => runOrShowError(async () => { await renameTag(shop.id, oldName, newName); await reload(); })}
              onDelete={(name) => runOrShowError(async () => { await deleteTag(shop.id, name); await reload(); })}
            />
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function EditableList({
  title,
  itemLabel,
  hint,
  items,
  onAdd,
  onRename,
  onDelete,
}: {
  title: string;
  itemLabel: string;
  hint: string;
  items: string[];
  onAdd: (name: string) => void;
  onRename: (oldName: string, newName: string) => void;
  onDelete: (name: string) => void;
}) {
  const [newValue, setNewValue] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);

  const submitAdd = () => {
    const trimmed = newValue.trim();
    if (!trimmed) return;
    onAdd(trimmed);
    setNewValue('');
  };

  const startEdit = (name: string) => { setEditing(name); setEditValue(name); setConfirmingDelete(null); };
  const submitEdit = () => {
    const trimmed = editValue.trim();
    if (editing !== null && trimmed && trimmed !== editing) onRename(editing, trimmed);
    setEditing(null);
  };

  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      <Text style={styles.hint}>{hint}</Text>

      {items.length === 0 && <Text style={styles.empty}>None yet — add one below.</Text>}

      <View style={styles.list}>
        {items.map((item) => (
          <View key={item} style={styles.row}>
            {editing === item ? (
              <>
                <TextInput value={editValue} onChangeText={setEditValue} autoFocus style={styles.editInput} onSubmitEditing={submitEdit} />
                <Pressable onPress={submitEdit} style={styles.rowAction}><Text style={styles.rowActionText}>Save</Text></Pressable>
                <Pressable onPress={() => setEditing(null)} style={styles.rowAction}><Text style={styles.rowActionTextMuted}>Cancel</Text></Pressable>
              </>
            ) : confirmingDelete === item ? (
              <>
                <Text style={[styles.rowLabel, { flex: 1 }]}>Delete &quot;{item}&quot;?</Text>
                <Pressable onPress={() => { onDelete(item); setConfirmingDelete(null); }} style={styles.rowAction}><Text style={styles.rowActionTextDanger}>Confirm</Text></Pressable>
                <Pressable onPress={() => setConfirmingDelete(null)} style={styles.rowAction}><Text style={styles.rowActionTextMuted}>Cancel</Text></Pressable>
              </>
            ) : (
              <>
                <Text style={styles.rowLabel}>{item}</Text>
                <Pressable onPress={() => startEdit(item)} style={styles.rowAction}><Text style={styles.rowActionText}>Rename</Text></Pressable>
                <Pressable onPress={() => setConfirmingDelete(item)} style={styles.rowAction}><Text style={styles.rowActionTextDanger}>Delete</Text></Pressable>
              </>
            )}
          </View>
        ))}
      </View>

      <View style={styles.addRow}>
        <TextInput value={newValue} onChangeText={setNewValue} placeholder={`Add a ${itemLabel}…`} placeholderTextColor="#999999" style={styles.addInput} onSubmitEditing={submitAdd} />
        <Pressable onPress={submitAdd} style={styles.addButton}><Text style={styles.addButtonText}>Add</Text></Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: '#FFFFFF' },
  content: { padding: 24, paddingBottom: 60, maxWidth: 640, width: '100%', alignSelf: 'center' },
  error: { color: '#C0392B', fontSize: 13, fontWeight: '700', marginBottom: 16 },
  section: { marginBottom: 36 },
  sectionTitle: { fontSize: 12, fontWeight: '800', color: '#111111', letterSpacing: 0.6, marginBottom: 4 },
  hint: { fontSize: 12, color: '#999999', lineHeight: 17, marginBottom: 14 },
  empty: { fontSize: 13, color: '#999999', marginBottom: 12 },
  list: { gap: 8, marginBottom: 14 },
  row: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#F2F2F2', borderRadius: 10, paddingVertical: 10, paddingHorizontal: 12, gap: 10 },
  rowLabel: { fontSize: 13, fontWeight: '700', color: '#111111', flex: 1 },
  rowAction: { paddingVertical: 4, paddingHorizontal: 4 },
  rowActionText: { fontSize: 12, fontWeight: '700', color: '#111111' },
  rowActionTextMuted: { fontSize: 12, fontWeight: '700', color: '#999999' },
  rowActionTextDanger: { fontSize: 12, fontWeight: '700', color: '#C0392B' },
  editInput: { flex: 1, backgroundColor: '#FFFFFF', borderRadius: 8, height: 34, paddingHorizontal: 10, color: '#111111', fontSize: 13 },
  addRow: { flexDirection: 'row', gap: 8 },
  addInput: { flex: 1, backgroundColor: '#F2F2F2', borderRadius: 10, height: 42, paddingHorizontal: 12, color: '#111111' },
  addButton: { backgroundColor: '#111111', borderRadius: 10, paddingHorizontal: 18, alignItems: 'center', justifyContent: 'center' },
  addButtonText: { color: '#FFFFFF', fontWeight: '800', fontSize: 13 },
});
