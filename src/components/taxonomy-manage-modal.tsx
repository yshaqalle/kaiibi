import { Image } from 'expo-image';
import { useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { TaxonomyEditModal, type TaxonomyInput, type TaxonomyRow } from '@/components/taxonomy-edit-modal';
import { AppModal } from '@/components/ui/app-modal';

export type { TaxonomyInput, TaxonomyRow };

// List view for Brands/Categories — tile rows like ProductTile (thumbnail,
// name, description preview, usage count), tapping a row or "+ Add" swaps
// the card's body to TaxonomyEditModal's form (see that file for why it's
// embedded here rather than being its own `<AppModal>`).
export function TaxonomyManageModal({
  visible,
  onClose,
  title,
  itemLabel,
  items,
  usage,
  nextColor,
  onCreate,
  onUpdate,
  onDelete,
  uploadImage,
}: {
  visible: boolean;
  onClose: () => void;
  title: string;
  itemLabel: string;
  items: TaxonomyRow[];
  usage: Map<string, number>;
  nextColor: string;
  onCreate: (input: TaxonomyInput) => Promise<void>;
  onUpdate: (item: TaxonomyRow, input: TaxonomyInput) => Promise<void>;
  onDelete: (item: TaxonomyRow) => Promise<void>;
  uploadImage: (localUri: string) => Promise<string>;
}) {
  const [search, setSearch] = useState('');
  const [editingItem, setEditingItem] = useState<TaxonomyRow | 'new' | null>(null);

  const dismiss = () => {
    setEditingItem(null);
    setSearch('');
    onClose();
  };

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const sorted = [...items].sort((a, b) => (usage.get(b.name) ?? 0) - (usage.get(a.name) ?? 0));
    return q ? sorted.filter((item) => item.name.toLowerCase().includes(q)) : sorted;
  }, [items, usage, search]);

  return (
    <AppModal visible={visible} animationType="fade" transparent onRequestClose={dismiss}>
      <View style={styles.overlay}>
        <View style={styles.card}>
          {editingItem === null ? (
            <>
              <View style={styles.header}>
                <Text style={styles.title}>{title}</Text>
                <Pressable onPress={dismiss} style={({ pressed }) => [styles.close, pressed && styles.closePressed]}>
                  <Text style={styles.closeText}>Done</Text>
                </Pressable>
              </View>

              <TextInput
                value={search}
                onChangeText={setSearch}
                placeholder={`Search ${title.toLowerCase()}…`}
                placeholderTextColor="#999999"
                style={styles.search}
              />

              <ScrollView style={styles.list}>
                {filtered.length === 0 && <Text style={styles.empty}>{search ? 'No matches.' : 'None yet — add one below.'}</Text>}
                {filtered.map((item) => (
                  <Pressable key={item.id} onPress={() => setEditingItem(item)} style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}>
                    {item.imageUrl ? (
                      <Image source={{ uri: item.imageUrl }} contentFit="cover" style={styles.thumb} />
                    ) : (
                      <View style={[styles.thumb, { backgroundColor: item.color ?? '#DDDDDD' }]} />
                    )}
                    <View style={styles.rowInfo}>
                      <Text style={styles.rowName} numberOfLines={1}>{item.name}</Text>
                      {item.description ? <Text style={styles.rowDescription} numberOfLines={1}>{item.description}</Text> : null}
                    </View>
                    <Text style={styles.rowCount}>{usage.get(item.name) ?? 0}</Text>
                  </Pressable>
                ))}
              </ScrollView>

              <Pressable onPress={() => setEditingItem('new')} style={styles.addButton}>
                <Text style={styles.addButtonText}>+ Add a {itemLabel}</Text>
              </Pressable>
            </>
          ) : (
            <TaxonomyEditModal
              key={editingItem === 'new' ? 'new' : editingItem.id}
              onClose={() => setEditingItem(null)}
              itemLabel={itemLabel}
              initial={editingItem === 'new' ? undefined : editingItem}
              defaultColor={nextColor}
              uploadImage={uploadImage}
              onSubmit={(input) => (editingItem === 'new' ? onCreate(input) : onUpdate(editingItem, input))}
              onDelete={editingItem === 'new' ? undefined : () => onDelete(editingItem)}
            />
          )}
        </View>
      </View>
    </AppModal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', alignItems: 'center', justifyContent: 'center', padding: 20 },
  card: { backgroundColor: '#FFFFFF', borderRadius: 18, width: '100%', maxWidth: 560, height: '90%', overflow: 'hidden' },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingTop: 18, paddingBottom: 10, borderBottomWidth: 1, borderBottomColor: '#ECECEC' },
  title: { fontSize: 16, fontWeight: '800', color: '#111111' },
  close: { backgroundColor: '#F2F2F2', paddingVertical: 7, paddingHorizontal: 14, borderRadius: 8 },
  closePressed: { opacity: 0.6 },
  closeText: { fontSize: 13, fontWeight: '700', color: '#111111' },
  search: { backgroundColor: '#F2F2F2', borderRadius: 10, height: 40, marginHorizontal: 16, marginTop: 14, marginBottom: 6, paddingHorizontal: 13, color: '#111111' },
  list: { flex: 1, paddingHorizontal: 10 },
  empty: { color: '#999999', fontSize: 13, textAlign: 'center', marginTop: 20 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10, paddingHorizontal: 6, borderBottomWidth: 1, borderBottomColor: '#F2F2F2' },
  rowPressed: { opacity: 0.6 },
  thumb: { width: 40, height: 40, borderRadius: 8 },
  rowInfo: { flex: 1 },
  rowName: { fontSize: 13, fontWeight: '700', color: '#111111' },
  rowDescription: { fontSize: 11, color: '#999999', marginTop: 2 },
  rowCount: { fontSize: 12, color: '#999999', fontWeight: '700' },
  addButton: { margin: 16, backgroundColor: '#111111', height: 44, borderRadius: 9, alignItems: 'center', justifyContent: 'center' },
  addButtonText: { color: '#FFFFFF', fontWeight: '800', fontSize: 13 },
});
