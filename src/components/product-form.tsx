import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';

import { CategoryChip } from '@/components/category-chip';
import { formatCents, toCents } from '@/lib/currency';
import { listProducts, uploadProductImage } from '@/lib/products';
import { deriveCategories, deriveTags } from '@/lib/product-taxonomy';
import type { NewProductInput, Product } from '@/types/models';

export function ProductForm({
  initial,
  onSubmit,
  submitLabel,
  shopId,
}: {
  initial?: Product;
  onSubmit: (input: NewProductInput) => Promise<void>;
  submitLabel: string;
  shopId: string;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [sku, setSku] = useState(initial?.sku ?? '');
  const [barcode, setBarcode] = useState(initial?.barcode ?? '');
  const [brand, setBrand] = useState(initial?.brand ?? '');
  const [category, setCategory] = useState(initial?.category ?? '');
  const [addingNewCategory, setAddingNewCategory] = useState(false);
  const [tags, setTags] = useState(initial?.tags?.join(', ') ?? '');
  const [categorySuggestions, setCategorySuggestions] = useState<string[]>([]);
  const [tagSuggestions, setTagSuggestions] = useState<string[]>([]);

  useEffect(() => {
    listProducts(shopId).then((products) => {
      setCategorySuggestions(deriveCategories(products));
      setTagSuggestions(deriveTags(products));
    }).catch(() => {});
  }, [shopId]);
  const [supplierName, setSupplierName] = useState(initial?.supplierName ?? '');
  const [costInput, setCostInput] = useState(initial?.costCents ? formatCents(initial.costCents).replace('$', '') : '');
  const [priceInput, setPriceInput] = useState(initial?.priceCents ? formatCents(initial.priceCents).replace('$', '') : '');
  const [stock, setStock] = useState(initial?.stock ? String(initial.stock) : '');
  const [reorderLevel, setReorderLevel] = useState(initial?.reorderLevel ? String(initial.reorderLevel) : '');
  const [shelfNumber, setShelfNumber] = useState(initial?.shelfNumber ?? '');
  const [expiryDate, setExpiryDate] = useState(initial?.expiryDate ?? '');
  const [batchNumber, setBatchNumber] = useState(initial?.batchNumber ?? '');
  const [isListedOnline, setIsListedOnline] = useState(initial?.isListedOnline ?? false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [imageUri, setImageUri] = useState<string | null>(initial?.imageUrl ?? null);
  const [uploading, setUploading] = useState(false);

  const valid = Boolean(name.trim() && priceInput.trim());

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
      let imageUrl = initial?.imageUrl ?? null;
      // A freshly picked photo is a local URI, not the http(s) URL of an
      // already-uploaded image. On native this is `file://`; on web
      // expo-image-picker returns a `blob:` object URL instead, so check
      // for "not already a remote URL" rather than a specific scheme.
      if (imageUri && !/^https?:\/\//.test(imageUri)) {
        setUploading(true);
        imageUrl = await uploadProductImage(shopId, imageUri);
        setUploading(false);
      }
      await onSubmit({
        name: name.trim(),
        description: description.trim() || null,
        sku: sku.trim() || null,
        barcode: barcode.trim() || null,
        brand: brand.trim() || null,
        category,
        tags: tags.split(',').map((tag) => tag.trim()).filter(Boolean),
        supplierName: supplierName.trim() || null,
        costCents: costInput.trim() ? toCents(costInput) : null,
        priceCents: toCents(priceInput),
        stock: Number(stock) || 0,
        reorderLevel: reorderLevel.trim() ? Number(reorderLevel) : null,
        shelfNumber: shelfNumber.trim() || null,
        expiryDate: expiryDate.trim() || null,
        batchNumber: batchNumber.trim() || null,
        imageUrl,
        isListedOnline,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save this product.');
    } finally {
      setUploading(false);
      setSubmitting(false);
    }
  };

  return (
    <ScrollView contentContainerStyle={styles.content}>
      <Field label="PHOTO">
        <Pressable onPress={pickImage} style={styles.photoPicker}>
          {imageUri ? <Image source={{ uri: imageUri }} contentFit="cover" style={styles.photoPreview} /> : <Text style={styles.photoHint}>Add a product photo</Text>}
        </Pressable>
      </Field>
      <Field label="PRODUCT NAME *"><TextInput value={name} onChangeText={setName} placeholder="e.g. ANUA Heartleaf Toner" placeholderTextColor="#999999" style={styles.input} /></Field>
      <Field label="DESCRIPTION"><TextInput value={description} onChangeText={setDescription} placeholder="Materials, size, story…" placeholderTextColor="#999999" style={[styles.input, styles.multiline]} multiline textAlignVertical="top" /></Field>
      <Row>
        <Field label="SKU" style={styles.half}><TextInput value={sku} onChangeText={setSku} placeholder="SKU-001" placeholderTextColor="#999999" style={styles.input} /></Field>
        <Field label="BARCODE" style={styles.half}><TextInput value={barcode} onChangeText={setBarcode} placeholder="Optional" placeholderTextColor="#999999" style={styles.input} /></Field>
      </Row>
      <Field label="BRAND"><TextInput value={brand} onChangeText={setBrand} placeholder="e.g. ANUA" placeholderTextColor="#999999" style={styles.input} /></Field>
      <Field label="CATEGORY">
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
          {categorySuggestions.map((item) => (
            <CategoryChip key={item} label={item} active={category === item} onPress={() => { setCategory(item); setAddingNewCategory(false); }} />
          ))}
          <CategoryChip label="+ New" active={addingNewCategory} onPress={() => setAddingNewCategory(true)} />
        </ScrollView>
        {addingNewCategory && (
          <TextInput
            value={category}
            onChangeText={setCategory}
            placeholder="Type a new category"
            placeholderTextColor="#999999"
            autoFocus
            style={styles.input}
          />
        )}
        {!addingNewCategory && category && !categorySuggestions.includes(category) && (
          <Text style={styles.categoryHint}>Selected: {category}</Text>
        )}
      </Field>
      <Field label="TAGS">
        <TextInput value={tags} onChangeText={setTags} placeholder="e.g. bestseller, toner" placeholderTextColor="#999999" style={styles.input} />
        {tagSuggestions.length > 0 && (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
            {tagSuggestions.map((tag) => (
              <CategoryChip
                key={tag}
                label={tag}
                active={tags.split(',').map((t) => t.trim()).includes(tag)}
                onPress={() => {
                  const current = tags.split(',').map((t) => t.trim()).filter(Boolean);
                  if (current.includes(tag)) return;
                  setTags([...current, tag].join(', '));
                }}
              />
            ))}
          </ScrollView>
        )}
      </Field>
      <Field label="SUPPLIER"><TextInput value={supplierName} onChangeText={setSupplierName} placeholder="Optional" placeholderTextColor="#999999" style={styles.input} /></Field>
      <Row>
        <Field label="PURCHASE COST" style={styles.half}><TextInput value={costInput} onChangeText={setCostInput} placeholder="0.00" placeholderTextColor="#999999" keyboardType="decimal-pad" style={styles.input} /></Field>
        <Field label="RETAIL PRICE *" style={styles.half}><TextInput value={priceInput} onChangeText={setPriceInput} placeholder="0.00" placeholderTextColor="#999999" keyboardType="decimal-pad" style={styles.input} /></Field>
      </Row>
      <Row>
        <Field label="STOCK" style={styles.half}><TextInput value={stock} onChangeText={setStock} placeholder="0" placeholderTextColor="#999999" keyboardType="number-pad" style={styles.input} /></Field>
        <Field label="REORDER LEVEL" style={styles.half}><TextInput value={reorderLevel} onChangeText={setReorderLevel} placeholder="5" placeholderTextColor="#999999" keyboardType="number-pad" style={styles.input} /></Field>
      </Row>
      <Field label="SHELF / LOCATION"><TextInput value={shelfNumber} onChangeText={setShelfNumber} placeholder="e.g. A3" placeholderTextColor="#999999" style={styles.input} /></Field>
      <Row>
        <Field label="EXPIRY DATE" style={styles.half}><TextInput value={expiryDate} onChangeText={setExpiryDate} placeholder="YYYY-MM-DD" placeholderTextColor="#999999" style={styles.input} /></Field>
        <Field label="BATCH NUMBER" style={styles.half}><TextInput value={batchNumber} onChangeText={setBatchNumber} placeholder="Optional" placeholderTextColor="#999999" style={styles.input} /></Field>
      </Row>
      <View style={styles.toggleRow}>
        <View style={{ flex: 1 }}>
          <Text style={styles.toggleTitle}>Expose to customers</Text>
          <Text style={styles.toggleHint}>Show this product in the online Discover feed once it's live.</Text>
        </View>
        <Switch value={isListedOnline} onValueChange={setIsListedOnline} />
      </View>
      {error && <Text style={styles.error}>{error}</Text>}
      <Pressable onPress={submit} style={[styles.save, (!valid || submitting) && styles.saveDisabled]} disabled={!valid || submitting}>
        <Text style={styles.saveText}>{uploading ? 'Uploading photo…' : submitting ? 'Saving…' : submitLabel}</Text>
      </Pressable>
    </ScrollView>
  );
}

function Row({ children }: { children: React.ReactNode }) { return <View style={styles.row}>{children}</View>; }
function Field({ label, children, style }: { label: string; children: React.ReactNode; style?: object }) {
  return <View style={style}><Text style={styles.fieldLabel}>{label}</Text>{children}</View>;
}

const styles = StyleSheet.create({
  content: { padding: 16, paddingBottom: 60 },
  row: { flexDirection: 'row', gap: 8 },
  half: { flex: 1 },
  fieldLabel: { fontSize: 10, letterSpacing: 1, fontWeight: '800', color: '#999999', marginBottom: 7, marginTop: 3 },
  photoPicker: { height: 146, backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#EDEDED', borderStyle: 'dashed', borderRadius: 11, marginBottom: 12, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  photoPreview: { width: '100%', height: '100%' },
  photoHint: { color: '#999999', fontSize: 13 },
  input: { backgroundColor: '#F2F2F2', borderRadius: 9, paddingHorizontal: 11, height: 43, color: '#111111', marginBottom: 8 },
  multiline: { height: 78, paddingTop: 11 },
  chips: { gap: 7, paddingBottom: 12 },
  categoryHint: { color: '#999999', fontSize: 11, marginTop: 6 },
  toggleRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#F2F2F2', borderRadius: 12, padding: 13, marginTop: 6, marginBottom: 14, gap: 10 },
  toggleTitle: { color: '#111111', fontSize: 13, fontWeight: '800' },
  toggleHint: { color: '#999999', fontSize: 11, marginTop: 3 },
  error: { color: '#C0392B', fontSize: 12, fontWeight: '700', marginBottom: 10 },
  save: { backgroundColor: '#111111', height: 45, borderRadius: 9, alignItems: 'center', justifyContent: 'center' },
  saveDisabled: { backgroundColor: '#CCCCCC' },
  saveText: { color: '#fff', fontWeight: '800' },
});
