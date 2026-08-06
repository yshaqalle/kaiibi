import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { taxonomyPalette } from '@/lib/colors';
import { deleteImageByPublicUrl } from '@/lib/storage';

export type TaxonomyRow = {
  id: string;
  shopId: string;
  name: string;
  color: string | null;
  description: string | null;
  imageUrl: string | null;
  createdAt: string;
};

export type TaxonomyInput = {
  name: string;
  color: string | null;
  description: string | null;
  imageUrl: string | null;
};

// Add/edit form for a brand or category — mirrors ProductForm's photo +
// text-field pattern, but embedded directly inside TaxonomyManageModal's
// card rather than owning its own `<Modal>` (see file-level note in the
// implementation plan for why).
export function TaxonomyEditModal({
  onClose,
  itemLabel,
  initial,
  defaultColor,
  onSubmit,
  onDelete,
  uploadImage,
}: {
  onClose: () => void;
  itemLabel: string;
  initial?: TaxonomyRow;
  defaultColor: string;
  onSubmit: (input: TaxonomyInput) => Promise<void>;
  onDelete?: () => Promise<void>;
  uploadImage: (localUri: string) => Promise<string>;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [color, setColor] = useState(initial?.color ?? defaultColor);
  const [imageUri, setImageUri] = useState<string | null>(initial?.imageUrl ?? null);
  const [uploading, setUploading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const valid = Boolean(name.trim());

  const pickImage = async () => {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) return;
    const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], allowsEditing: true, aspect: [1, 1], quality: 0.8 });
    if (!result.canceled) setImageUri(result.assets[0].uri);
  };

  const submit = async () => {
    if (!valid) return;
    setSubmitting(true);
    setError(null);
    try {
      let resolvedImageUrl = initial?.imageUrl ?? null;
      // Set only when this submit actually replaces an already-uploaded
      // photo -- gates the cleanup below so a save that doesn't touch the
      // photo, or a "remove photo" (imageUri null, no new upload), never
      // tries to delete anything.
      let replacedImageUrl: string | null = null;
      // A freshly picked photo is a local URI, not the http(s) URL of an
      // already-uploaded one — same check as product-form.tsx/ShopSection.
      if (imageUri && !/^https?:\/\//.test(imageUri)) {
        setUploading(true);
        resolvedImageUrl = await uploadImage(imageUri);
        setUploading(false);
        replacedImageUrl = initial?.imageUrl ?? null;
      } else if (imageUri === null) {
        resolvedImageUrl = null;
      }
      await onSubmit({ name: name.trim(), color, description: description.trim() || null, imageUrl: resolvedImageUrl });
      // Only after the new URL is safely persisted (onSubmit above has
      // resolved) -- see storage.ts.
      if (replacedImageUrl) await deleteImageByPublicUrl(replacedImageUrl);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : `Could not save this ${itemLabel}.`);
    } finally {
      setUploading(false);
      setSubmitting(false);
    }
  };

  const confirmDelete = async () => {
    if (!onDelete) return;
    setSubmitting(true);
    setError(null);
    try {
      await onDelete();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : `Could not delete this ${itemLabel}.`);
      setSubmitting(false);
    }
  };

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <Pressable onPress={onClose} style={({ pressed }) => [styles.back, pressed && styles.backPressed]}>
          <Text style={styles.backText}>‹ Back</Text>
        </Pressable>
        <Text style={styles.title}>{initial ? `Edit ${itemLabel}` : `Add ${itemLabel}`}</Text>
        <Pressable onPress={submit} disabled={!valid || submitting} style={[styles.headerSave, (!valid || submitting) && styles.headerSaveDisabled]}>
          <Text style={styles.headerSaveText}>Save</Text>
        </Pressable>
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.fieldLabel}>PHOTO</Text>
        <Pressable onPress={pickImage} style={styles.photoPicker}>
          {imageUri ? <Image source={{ uri: imageUri }} contentFit="cover" style={styles.photoPreview} /> : <Text style={styles.photoHint}>Add a photo</Text>}
        </Pressable>
        {imageUri && (
          <Pressable onPress={() => setImageUri(null)}>
            <Text style={styles.removePhoto}>Remove photo</Text>
          </Pressable>
        )}

        <Text style={styles.fieldLabel}>NAME</Text>
        <TextInput value={name} onChangeText={setName} placeholder={`${itemLabel} name`} placeholderTextColor="#999999" style={styles.input} />

        <Text style={styles.fieldLabel}>DESCRIPTION</Text>
        <TextInput
          value={description}
          onChangeText={setDescription}
          placeholder="Optional"
          placeholderTextColor="#999999"
          style={[styles.input, styles.multiline]}
          multiline
          textAlignVertical="top"
        />

        <Text style={styles.fieldLabel}>COLOR</Text>
        <View style={styles.colorPalette}>
          {taxonomyPalette.map((swatch) => (
            <Pressable
              key={swatch}
              onPress={() => setColor(swatch)}
              style={[styles.colorSwatch, { backgroundColor: swatch }, color === swatch && styles.colorSwatchSelected]}
            />
          ))}
        </View>

        {error && <Text style={styles.error}>{error}</Text>}

        <Pressable onPress={submit} disabled={!valid || submitting} style={[styles.save, (!valid || submitting) && styles.saveDisabled]}>
          <Text style={styles.saveText}>{uploading ? 'Uploading photo…' : submitting ? 'Saving…' : initial ? 'Save changes' : `Save ${itemLabel}`}</Text>
        </Pressable>
      </ScrollView>

      {initial && onDelete && (
        confirmingDelete ? (
          <View style={styles.deleteConfirmRow}>
            <Text style={styles.deleteConfirmText}>Delete &quot;{initial.name}&quot;?</Text>
            <Pressable onPress={confirmDelete} style={styles.deleteConfirmButton}>
              <Text style={styles.deleteConfirmButtonText}>Confirm</Text>
            </Pressable>
            <Pressable onPress={() => setConfirmingDelete(false)} style={styles.deleteCancelButton}>
              <Text style={styles.deleteCancelButtonText}>Cancel</Text>
            </Pressable>
          </View>
        ) : (
          <Pressable onPress={() => setConfirmingDelete(true)} style={styles.deleteButton}>
            <Text style={styles.deleteText}>Delete {itemLabel}</Text>
          </Pressable>
        )
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingTop: 18, paddingBottom: 10, borderBottomWidth: 1, borderBottomColor: '#ECECEC' },
  back: { paddingVertical: 6, paddingHorizontal: 4 },
  backPressed: { opacity: 0.6 },
  backText: { fontSize: 14, fontWeight: '700', color: '#111111' },
  title: { fontSize: 16, fontWeight: '800', color: '#111111' },
  headerSave: { backgroundColor: '#111111', borderRadius: 8, paddingVertical: 7, paddingHorizontal: 14 },
  headerSaveDisabled: { backgroundColor: '#CCCCCC' },
  headerSaveText: { color: '#FFFFFF', fontSize: 13, fontWeight: '700' },
  content: { padding: 16, paddingBottom: 24 },
  fieldLabel: { fontSize: 10, letterSpacing: 1, fontWeight: '800', color: '#999999', marginBottom: 7, marginTop: 3 },
  photoPicker: { height: 146, backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#EDEDED', borderStyle: 'dashed', borderRadius: 11, marginBottom: 8, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  photoPreview: { width: '100%', height: '100%' },
  photoHint: { color: '#999999', fontSize: 13 },
  removePhoto: { color: '#C0392B', fontSize: 12, fontWeight: '700', marginBottom: 12 },
  input: { backgroundColor: '#F2F2F2', borderRadius: 9, paddingHorizontal: 11, height: 43, color: '#111111', marginBottom: 8 },
  multiline: { height: 78, paddingTop: 11 },
  colorPalette: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginBottom: 12 },
  colorSwatch: { width: 28, height: 28, borderRadius: 14 },
  colorSwatchSelected: { borderWidth: 3, borderColor: '#111111' },
  error: { color: '#C0392B', fontSize: 12, fontWeight: '700', marginBottom: 10 },
  save: { backgroundColor: '#111111', height: 45, borderRadius: 9, alignItems: 'center', justifyContent: 'center' },
  saveDisabled: { backgroundColor: '#CCCCCC' },
  saveText: { color: '#fff', fontWeight: '800' },
  deleteButton: { alignItems: 'center', paddingVertical: 14, borderTopWidth: 1, borderTopColor: '#ECECEC' },
  deleteText: { color: '#C0392B', fontWeight: '800', fontSize: 13 },
  deleteConfirmRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 14, paddingVertical: 14, borderTopWidth: 1, borderTopColor: '#ECECEC' },
  deleteConfirmText: { fontSize: 13, fontWeight: '700', color: '#111111' },
  deleteConfirmButton: { paddingVertical: 6, paddingHorizontal: 10 },
  deleteConfirmButtonText: { color: '#C0392B', fontWeight: '800', fontSize: 13 },
  deleteCancelButton: { paddingVertical: 6, paddingHorizontal: 10 },
  deleteCancelButtonText: { color: '#999999', fontWeight: '700', fontSize: 13 },
});
