import { useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { taxonomyPalette } from '@/lib/colors';
import { AppModal } from '@/components/ui/app-modal';

const emptyColors = new Map<string, string | null>();

// Generic add/rename/delete(/color) modal for a flat list of plain string
// items — used by Tags (Catalog panel) and Cashiers (Sales panel). Ported
// unchanged from the previous settings.tsx (same component, same behavior),
// just extracted so both panels can share it.
export function ManageModal({
  visible,
  onClose,
  title,
  itemLabel,
  items,
  usage,
  colors = emptyColors,
  showUsage = true,
  onAdd,
  onRename,
  onDelete,
  onColorChange,
}: {
  visible: boolean;
  onClose: () => void;
  title: string;
  itemLabel: string;
  items: string[];
  usage: Map<string, number>;
  colors?: Map<string, string | null>;
  showUsage?: boolean;
  onAdd: (name: string) => void;
  onRename: (oldName: string, newName: string) => void;
  onDelete: (name: string) => void;
  onColorChange?: (name: string, color: string) => void;
}) {
  const [search, setSearch] = useState('');
  const [newValue, setNewValue] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);
  const [pickingColorFor, setPickingColorFor] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const sorted = [...items].sort((a, b) => (usage.get(b) ?? 0) - (usage.get(a) ?? 0));
    return q ? sorted.filter((item) => item.toLowerCase().includes(q)) : sorted;
  }, [items, usage, search]);

  const submitAdd = () => {
    const trimmed = newValue.trim();
    if (!trimmed) return;
    onAdd(trimmed);
    setNewValue('');
  };

  const startEdit = (name: string) => {
    setEditing(name);
    setEditValue(name);
    setConfirmingDelete(null);
  };
  const submitEdit = () => {
    const trimmed = editValue.trim();
    if (editing !== null && trimmed && trimmed !== editing) onRename(editing, trimmed);
    setEditing(null);
  };

  return (
    <AppModal visible={visible} animationType="fade" transparent onRequestClose={onClose}>
      <View style={styles.modalOverlay}>
        <View style={styles.modalCard}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>{title}</Text>
            <Pressable onPress={onClose} style={({ pressed }) => [styles.modalClose, pressed && styles.modalClosePressed]}>
              <Text style={styles.modalCloseText}>Done</Text>
            </Pressable>
          </View>

          <TextInput
            value={search}
            onChangeText={setSearch}
            placeholder={`Search ${title.toLowerCase()}…`}
            placeholderTextColor="#999999"
            style={styles.modalSearch}
          />

          <ScrollView style={styles.modalList}>
            {filtered.length === 0 && <Text style={styles.empty}>{search ? 'No matches.' : 'None yet — add one below.'}</Text>}
            {filtered.map((item) => (
              <View key={item}>
                <View style={styles.row}>
                  {editing === item ? (
                    <>
                      <TextInput value={editValue} onChangeText={setEditValue} autoFocus style={styles.editInput} onSubmitEditing={submitEdit} />
                      <Pressable onPress={submitEdit} style={styles.rowAction}>
                        <Text style={styles.rowActionText}>Save</Text>
                      </Pressable>
                      <Pressable onPress={() => setEditing(null)} style={styles.rowAction}>
                        <Text style={styles.rowActionTextMuted}>Cancel</Text>
                      </Pressable>
                    </>
                  ) : confirmingDelete === item ? (
                    <>
                      <Text style={[styles.rowLabel, { flex: 1 }]}>Delete &quot;{item}&quot;?</Text>
                      <Pressable
                        onPress={() => {
                          onDelete(item);
                          setConfirmingDelete(null);
                        }}
                        style={styles.rowAction}
                      >
                        <Text style={styles.rowActionTextDanger}>Confirm</Text>
                      </Pressable>
                      <Pressable onPress={() => setConfirmingDelete(null)} style={styles.rowAction}>
                        <Text style={styles.rowActionTextMuted}>Cancel</Text>
                      </Pressable>
                    </>
                  ) : (
                    <>
                      {onColorChange && (
                        <Pressable
                          onPress={() => setPickingColorFor((current) => (current === item ? null : item))}
                          style={[styles.colorDot, { backgroundColor: colors.get(item) ?? '#DDDDDD' }]}
                        />
                      )}
                      <Text style={styles.rowLabel}>{item}</Text>
                      {showUsage && <Text style={styles.rowCount}>{usage.get(item) ?? 0}</Text>}
                      <Pressable onPress={() => startEdit(item)} style={styles.rowAction}>
                        <Text style={styles.rowActionText}>Rename</Text>
                      </Pressable>
                      <Pressable onPress={() => setConfirmingDelete(item)} style={styles.rowAction}>
                        <Text style={styles.rowActionTextDanger}>Delete</Text>
                      </Pressable>
                    </>
                  )}
                </View>
                {pickingColorFor === item && (
                  <View style={styles.colorPalette}>
                    {taxonomyPalette.map((color) => (
                      <Pressable
                        key={color}
                        onPress={() => {
                          onColorChange?.(item, color);
                          setPickingColorFor(null);
                        }}
                        style={[styles.colorSwatch, { backgroundColor: color }, colors.get(item) === color && styles.colorSwatchSelected]}
                      />
                    ))}
                  </View>
                )}
              </View>
            ))}

            <View style={styles.addRow}>
              <TextInput
                value={newValue}
                onChangeText={setNewValue}
                placeholder={`Add a ${itemLabel}…`}
                placeholderTextColor="#999999"
                style={styles.addInput}
                onSubmitEditing={submitAdd}
              />
              <Pressable onPress={submitAdd} style={styles.addButton}>
                <Text style={styles.addButtonText}>Add</Text>
              </Pressable>
            </View>
          </ScrollView>
        </View>
      </View>
    </AppModal>
  );
}

const styles = StyleSheet.create({
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', alignItems: 'center', justifyContent: 'center', padding: 20 },
  modalCard: { backgroundColor: '#FFFFFF', borderRadius: 18, padding: 20, width: '100%', maxWidth: 560, height: '80%', overflow: 'hidden' },
  modalHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 },
  modalTitle: { fontSize: 16, fontWeight: '800', color: '#111111' },
  modalClose: { backgroundColor: '#F2F2F2', paddingVertical: 7, paddingHorizontal: 14, borderRadius: 8 },
  modalClosePressed: { opacity: 0.6 },
  modalCloseText: { fontSize: 13, fontWeight: '700', color: '#111111' },
  modalSearch: { backgroundColor: '#F2F2F2', borderRadius: 10, height: 40, paddingHorizontal: 12, color: '#111111', marginBottom: 12 },
  modalList: { flex: 1, marginBottom: 12 },
  empty: { fontSize: 13, color: '#999999' },
  row: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#F2F2F2', borderRadius: 10, paddingVertical: 10, paddingHorizontal: 12, gap: 10, marginBottom: 8 },
  rowLabel: { fontSize: 13, fontWeight: '700', color: '#111111', flex: 1 },
  rowCount: { fontSize: 12, fontWeight: '700', color: '#999999' },
  rowAction: { paddingVertical: 4, paddingHorizontal: 4 },
  rowActionText: { fontSize: 12, fontWeight: '700', color: '#111111' },
  rowActionTextMuted: { fontSize: 12, fontWeight: '700', color: '#999999' },
  rowActionTextDanger: { fontSize: 12, fontWeight: '700', color: '#C0392B' },
  editInput: { flex: 1, backgroundColor: '#FFFFFF', borderRadius: 8, height: 34, paddingHorizontal: 10, color: '#111111', fontSize: 13 },
  colorDot: { width: 16, height: 16, borderRadius: 8 },
  colorPalette: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingVertical: 8, paddingHorizontal: 12, marginBottom: 8, backgroundColor: '#F2F2F2', borderRadius: 10 },
  colorSwatch: { width: 22, height: 22, borderRadius: 11 },
  colorSwatchSelected: { borderWidth: 2, borderColor: '#111111' },
  addRow: { flexDirection: 'row', gap: 8 },
  addInput: { flex: 1, backgroundColor: '#F2F2F2', borderRadius: 10, height: 42, paddingHorizontal: 12, color: '#111111' },
  addButton: { backgroundColor: '#111111', borderRadius: 10, paddingHorizontal: 18, alignItems: 'center', justifyContent: 'center' },
  addButtonText: { color: '#FFFFFF', fontWeight: '800', fontSize: 13 },
});
