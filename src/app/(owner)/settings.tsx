import { useCallback, useEffect, useMemo, useState } from 'react';
import { Modal, Pressable, SafeAreaView, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { ScreenHeader } from '@/components/screen-header';
import { useAuth } from '@/hooks/use-auth';
import { createCategory, deleteCategory, listCategories, renameCategory } from '@/lib/categories';
import { updateProfile } from '@/lib/profile';
import { listProducts } from '@/lib/products';
import { updateShop } from '@/lib/shops';
import { createTag, deleteTag, listTags, renameTag } from '@/lib/tags';
import type { Product, Profile, Shop } from '@/types/models';

const previewCount = 6;

export default function SettingsScreen() {
  const { shop, profile, setProfile, refreshShop } = useAuth();
  const [categories, setCategories] = useState<string[]>([]);
  const [tags, setTags] = useState<string[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!shop) return;
    setLoading(true);
    try {
      const [cats, tagRows, productRows] = await Promise.all([listCategories(shop.id), listTags(shop.id), listProducts(shop.id)]);
      setCategories(cats.map((c) => c.name));
      setTags(tagRows.map((t) => t.name));
      setProducts(productRows);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load categories and tags.');
    } finally {
      setLoading(false);
    }
  }, [shop]);

  useEffect(() => { reload(); }, [reload]);

  const categoryUsage = useMemo(() => {
    const counts = new Map<string, number>();
    for (const p of products) if (p.category) counts.set(p.category, (counts.get(p.category) ?? 0) + 1);
    return counts;
  }, [products]);

  const tagUsage = useMemo(() => {
    const counts = new Map<string, number>();
    for (const p of products) for (const tag of p.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
    return counts;
  }, [products]);

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

        {profile && <ProfileSection profile={profile} onSaved={setProfile} />}
        <ShopSection shop={shop} onSaved={refreshShop} />

        {loading ? (
          <Text style={styles.hint}>Loading…</Text>
        ) : (
          <>
            <CategorySection
              title="CATEGORIES"
              itemLabel="category"
              hint="Group products in the POS and inventory screens. Renaming or removing a category updates every product using it."
              items={categories}
              usage={categoryUsage}
              onAdd={(name) => runOrShowError(async () => { await createCategory(shop.id, name); await reload(); })}
              onRename={(oldName, newName) => runOrShowError(async () => { await renameCategory(shop.id, oldName, newName); await reload(); })}
              onDelete={(name) => runOrShowError(async () => { await deleteCategory(shop.id, name); await reload(); })}
            />
            <CategorySection
              title="TAGS"
              itemLabel="tag"
              hint="Extra keywords for products, like bestseller or handmade."
              items={tags}
              usage={tagUsage}
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

function ProfileSection({ profile, onSaved }: { profile: Profile; onSaved: (profile: Profile) => void }) {
  const [fullName, setFullName] = useState(profile.fullName ?? '');
  const [phone, setPhone] = useState(profile.phone ?? '');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>YOUR PROFILE</Text>
      <Text style={styles.hint}>Your name and phone number.</Text>
      <View style={styles.formRow}>
        <View style={{ flex: 1 }}>
          <Text style={styles.fieldLabel}>FULL NAME</Text>
          <TextInput value={fullName} onChangeText={setFullName} placeholder="Full name" placeholderTextColor="#999999" style={styles.input} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.fieldLabel}>PHONE</Text>
          <TextInput value={phone} onChangeText={setPhone} placeholder="Phone number" placeholderTextColor="#999999" keyboardType="phone-pad" style={styles.input} />
        </View>
      </View>
      {error && <Text style={styles.error}>{error}</Text>}
      <Pressable onPress={save} disabled={!dirty || saving} style={[styles.saveButton, (!dirty || saving) && styles.saveButtonDisabled]}>
        <Text style={styles.saveButtonText}>{saving ? 'Saving…' : saved ? 'Saved ✓' : 'Save'}</Text>
      </Pressable>
    </View>
  );
}

function ShopSection({ shop, onSaved }: { shop: Shop; onSaved: () => Promise<void> }) {
  const [name, setName] = useState(shop.name ?? '');
  const [contactPhone, setContactPhone] = useState(shop.contactPhone ?? '');
  const [city, setCity] = useState(shop.city ?? '');
  const [neighborhood, setNeighborhood] = useState(shop.neighborhood ?? '');
  const [description, setDescription] = useState(shop.description ?? '');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dirty =
    name.trim() !== (shop.name ?? '') ||
    contactPhone.trim() !== (shop.contactPhone ?? '') ||
    city.trim() !== (shop.city ?? '') ||
    neighborhood.trim() !== (shop.neighborhood ?? '') ||
    description.trim() !== (shop.description ?? '');

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await updateShop(shop.id, {
        name: name.trim(),
        contactPhone: contactPhone.trim(),
        city: city.trim(),
        neighborhood: neighborhood.trim(),
        description: description.trim(),
      });
      await onSaved();
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save changes.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>SHOP</Text>
      <Text style={styles.hint}>Shown to customers and used across the app.</Text>
      <Text style={styles.fieldLabel}>SHOP NAME</Text>
      <TextInput value={name} onChangeText={setName} placeholder="Shop name" placeholderTextColor="#999999" style={styles.input} />
      <Text style={styles.fieldLabel}>DESCRIPTION</Text>
      <TextInput value={description} onChangeText={setDescription} placeholder="A short description of your shop" placeholderTextColor="#999999" style={[styles.input, styles.multilineInput]} multiline textAlignVertical="top" />
      <View style={styles.formRow}>
        <View style={{ flex: 1 }}>
          <Text style={styles.fieldLabel}>CITY</Text>
          <TextInput value={city} onChangeText={setCity} placeholder="City" placeholderTextColor="#999999" style={styles.input} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.fieldLabel}>NEIGHBORHOOD</Text>
          <TextInput value={neighborhood} onChangeText={setNeighborhood} placeholder="Neighborhood or landmark" placeholderTextColor="#999999" style={styles.input} />
        </View>
      </View>
      <Text style={styles.fieldLabel}>CONTACT PHONE</Text>
      <TextInput value={contactPhone} onChangeText={setContactPhone} placeholder="Phone number" placeholderTextColor="#999999" keyboardType="phone-pad" style={styles.input} />
      {error && <Text style={styles.error}>{error}</Text>}
      <Pressable onPress={save} disabled={!dirty || saving} style={[styles.saveButton, (!dirty || saving) && styles.saveButtonDisabled]}>
        <Text style={styles.saveButtonText}>{saving ? 'Saving…' : saved ? 'Saved ✓' : 'Save'}</Text>
      </Pressable>
    </View>
  );
}

function CategorySection({
  title,
  itemLabel,
  hint,
  items,
  usage,
  onAdd,
  onRename,
  onDelete,
}: {
  title: string;
  itemLabel: string;
  hint: string;
  items: string[];
  usage: Map<string, number>;
  onAdd: (name: string) => void;
  onRename: (oldName: string, newName: string) => void;
  onDelete: (name: string) => void;
}) {
  const [modalOpen, setModalOpen] = useState(false);

  const mostUsed = useMemo(
    () => [...items].sort((a, b) => (usage.get(b) ?? 0) - (usage.get(a) ?? 0)).slice(0, previewCount),
    [items, usage]
  );

  return (
    <View style={styles.section}>
      <View style={styles.sectionHeaderRow}>
        <View style={{ flex: 1 }}>
          <Text style={styles.sectionTitle}>{title}</Text>
          <Text style={styles.hint}>{hint}</Text>
        </View>
        <Pressable onPress={() => setModalOpen(true)} style={styles.manageButton}>
          <Text style={styles.manageButtonText}>View/Update ({items.length})</Text>
        </Pressable>
      </View>

      {items.length === 0 ? (
        <Text style={styles.empty}>None yet.</Text>
      ) : (
        <View style={styles.previewRow}>
          {mostUsed.map((item) => (
            <View key={item} style={styles.previewChip}>
              <Text style={styles.previewChipText}>{item}</Text>
              <Text style={styles.previewChipCount}>{usage.get(item) ?? 0}</Text>
            </View>
          ))}
          {items.length > previewCount && <Text style={styles.previewMore}>+{items.length - previewCount} more</Text>}
        </View>
      )}

      <ManageModal
        visible={modalOpen}
        onClose={() => setModalOpen(false)}
        title={title}
        itemLabel={itemLabel}
        items={items}
        usage={usage}
        onAdd={onAdd}
        onRename={onRename}
        onDelete={onDelete}
      />
    </View>
  );
}

function ManageModal({
  visible,
  onClose,
  title,
  itemLabel,
  items,
  usage,
  onAdd,
  onRename,
  onDelete,
}: {
  visible: boolean;
  onClose: () => void;
  title: string;
  itemLabel: string;
  items: string[];
  usage: Map<string, number>;
  onAdd: (name: string) => void;
  onRename: (oldName: string, newName: string) => void;
  onDelete: (name: string) => void;
}) {
  const [search, setSearch] = useState('');
  const [newValue, setNewValue] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);

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

  const startEdit = (name: string) => { setEditing(name); setEditValue(name); setConfirmingDelete(null); };
  const submitEdit = () => {
    const trimmed = editValue.trim();
    if (editing !== null && trimmed && trimmed !== editing) onRename(editing, trimmed);
    setEditing(null);
  };

  return (
    <Modal visible={visible} animationType="fade" transparent onRequestClose={onClose}>
      <View style={styles.modalOverlay}>
        <View style={styles.modalCard}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>{title}</Text>
            <Pressable onPress={onClose}><Text style={styles.modalClose}>Done</Text></Pressable>
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
                    <Text style={styles.rowCount}>{usage.get(item) ?? 0}</Text>
                    <Pressable onPress={() => startEdit(item)} style={styles.rowAction}><Text style={styles.rowActionText}>Rename</Text></Pressable>
                    <Pressable onPress={() => setConfirmingDelete(item)} style={styles.rowAction}><Text style={styles.rowActionTextDanger}>Delete</Text></Pressable>
                  </>
                )}
              </View>
            ))}
          </ScrollView>

          <View style={styles.addRow}>
            <TextInput value={newValue} onChangeText={setNewValue} placeholder={`Add a ${itemLabel}…`} placeholderTextColor="#999999" style={styles.addInput} onSubmitEditing={submitAdd} />
            <Pressable onPress={submitAdd} style={styles.addButton}><Text style={styles.addButtonText}>Add</Text></Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: '#FFFFFF' },
  content: { padding: 24, paddingBottom: 60, maxWidth: 640, width: '100%', alignSelf: 'center' },
  error: { color: '#C0392B', fontSize: 13, fontWeight: '700', marginBottom: 16 },
  section: { marginBottom: 32 },
  formRow: { flexDirection: 'row', gap: 12 },
  fieldLabel: { fontSize: 10, letterSpacing: 0.6, fontWeight: '800', color: '#999999', marginBottom: 6, marginTop: 10 },
  input: { backgroundColor: '#F2F2F2', borderRadius: 10, height: 42, paddingHorizontal: 12, color: '#111111' },
  multilineInput: { height: 76, paddingTop: 11 },
  saveButton: { backgroundColor: '#111111', borderRadius: 10, height: 42, alignItems: 'center', justifyContent: 'center', marginTop: 14, alignSelf: 'flex-start', paddingHorizontal: 22 },
  saveButtonDisabled: { backgroundColor: '#CCCCCC' },
  saveButtonText: { color: '#FFFFFF', fontWeight: '800', fontSize: 13 },
  sectionHeaderRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, marginBottom: 12 },
  sectionTitle: { fontSize: 12, fontWeight: '800', color: '#111111', letterSpacing: 0.6, marginBottom: 4 },
  hint: { fontSize: 12, color: '#999999', lineHeight: 17 },
  empty: { fontSize: 13, color: '#999999' },
  manageButton: { backgroundColor: '#111111', borderRadius: 10, paddingVertical: 9, paddingHorizontal: 14 },
  manageButtonText: { color: '#FFFFFF', fontWeight: '800', fontSize: 12 },

  previewRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignItems: 'center' },
  previewChip: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: '#F2F2F2', borderRadius: 16, paddingVertical: 7, paddingHorizontal: 12 },
  previewChipText: { fontSize: 12, fontWeight: '700', color: '#111111' },
  previewChipCount: { fontSize: 11, fontWeight: '700', color: '#999999' },
  previewMore: { fontSize: 12, fontWeight: '600', color: '#999999' },

  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', alignItems: 'center', justifyContent: 'center', padding: 20 },
  modalCard: { backgroundColor: '#FFFFFF', borderRadius: 18, padding: 20, width: '100%', maxWidth: 560, maxHeight: '80%' },
  modalHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 },
  modalTitle: { fontSize: 16, fontWeight: '800', color: '#111111' },
  modalClose: { fontSize: 13, fontWeight: '700', color: '#999999' },
  modalSearch: { backgroundColor: '#F2F2F2', borderRadius: 10, height: 40, paddingHorizontal: 12, color: '#111111', marginBottom: 12 },
  modalList: { marginBottom: 12 },

  list: { gap: 8, marginBottom: 14 },
  row: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#F2F2F2', borderRadius: 10, paddingVertical: 10, paddingHorizontal: 12, gap: 10, marginBottom: 8 },
  rowLabel: { fontSize: 13, fontWeight: '700', color: '#111111', flex: 1 },
  rowCount: { fontSize: 12, fontWeight: '700', color: '#999999' },
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
