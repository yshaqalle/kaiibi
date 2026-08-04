import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import { forwardRef, useEffect, useImperativeHandle, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';

import { CategoryChip } from '@/components/category-chip';
import { useAuth } from '@/hooks/use-auth';
import { primaryLocationOf } from '@/lib/location-selection';
import { createBrand, listBrands } from '@/lib/brands';
import { createCategory, listCategories } from '@/lib/categories';
import { formatCents, toCents } from '@/lib/currency';
import { uploadProductImage } from '@/lib/products';
import { createTag, listTags } from '@/lib/tags';
import type { NewProductInput, Product } from '@/types/models';

export type ProductFormHandle = {
  submit: () => void;
};

export const ProductForm = forwardRef<ProductFormHandle, {
  initial?: Product;
  // The store the opening stock lands at. Only asked for when a business has
  // more than one; the caller passes it straight to createProduct/updateProduct,
  // which is the only thing that can actually move a count.
  onSubmit: (input: NewProductInput, locationId: string | null) => Promise<void>;
  submitLabel: string;
  shopId: string;
  // Where the store selector starts. The caller passes the store being viewed
  // when the list is filtered; otherwise it is the main store.
  defaultLocationId?: string | null;
  onStatusChange?: (status: { valid: boolean; submitting: boolean }) => void;
}>(function ProductForm({
  initial,
  onSubmit,
  submitLabel,
  shopId,
  defaultLocationId,
  onStatusChange,
}, ref) {
  const { locations } = useAuth();
  const stores = locations.filter((location) => location.active);
  const [locationId, setLocationId] = useState<string | null>(
    defaultLocationId ?? primaryLocationOf(stores)?.id ?? null
  );
  const [name, setName] = useState(initial?.name ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [sku, setSku] = useState(initial?.sku ?? '');
  const [barcode, setBarcode] = useState(initial?.barcode ?? '');
  const [brand, setBrand] = useState(initial?.brand ?? '');
  const [category, setCategory] = useState(initial?.category ?? '');
  const [tags, setTags] = useState(initial?.tags?.join(', ') ?? '');
  const [brandSuggestions, setBrandSuggestions] = useState<string[]>([]);
  const [brandColors, setBrandColors] = useState<Map<string, string | null>>(new Map());
  const [categorySuggestions, setCategorySuggestions] = useState<string[]>([]);
  const [categoryColors, setCategoryColors] = useState<Map<string, string | null>>(new Map());
  const [tagSuggestions, setTagSuggestions] = useState<string[]>([]);
  const [tagColors, setTagColors] = useState<Map<string, string | null>>(new Map());

  useEffect(() => {
    listBrands(shopId).then((rows) => { setBrandSuggestions(rows.map((r) => r.name)); setBrandColors(new Map(rows.map((r) => [r.name, r.color]))); }).catch(() => {});
    listCategories(shopId).then((rows) => { setCategorySuggestions(rows.map((r) => r.name)); setCategoryColors(new Map(rows.map((r) => [r.name, r.color]))); }).catch(() => {});
    listTags(shopId).then((rows) => { setTagSuggestions(rows.map((r) => r.name)); setTagColors(new Map(rows.map((r) => [r.name, r.color]))); }).catch(() => {});
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

  // `toCents` leniently coerces anything it can't parse to 0 (see
  // src/lib/currency.ts) so a non-empty-but-garbage price (e.g. "abc") isn't
  // distinguishable from a real 0 by string-emptiness alone -- require the
  // parsed value to actually be positive.
  const valid = Boolean(name.trim() && priceInput.trim() && toCents(priceInput) > 0);

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

      const tagList = tags.split(',').map((tag) => tag.trim()).filter(Boolean);
      // A brand/category/tag typed here for the first time (via "+ Add …")
      // only exists as free text on this product until it's also in the
      // brands/categories/tags tables — persist it now so it shows up as a
      // suggestion and is manageable from Settings.
      await Promise.all([
        brand.trim() && !brandSuggestions.includes(brand.trim()) ? createBrand(shopId, brand.trim()) : null,
        category.trim() && !categorySuggestions.includes(category.trim()) ? createCategory(shopId, category.trim()) : null,
        ...tagList.filter((tag) => !tagSuggestions.includes(tag)).map((tag) => createTag(shopId, tag)),
      ]);

      await onSubmit(
        {
        name: name.trim(),
        description: description.trim() || null,
        sku: sku.trim() || null,
        barcode: barcode.trim() || null,
        brand: brand.trim() || null,
        category: category.trim() || null,
        tags: tagList,
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
        },
        locationId
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save this product.');
    } finally {
      setUploading(false);
      setSubmitting(false);
    }
  };

  useImperativeHandle(ref, () => ({ submit }), [submit]);
  useEffect(() => { onStatusChange?.({ valid, submitting }); }, [valid, submitting, onStatusChange]);

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
      <Field label="BRAND">
        <SearchableChipField
          value={brand}
          onChange={(next) => {
            setBrand(next);
            if (next && !brandSuggestions.includes(next)) setBrandSuggestions((prev) => [...prev, next].sort((a, b) => a.localeCompare(b)));
          }}
          suggestions={brandSuggestions}
          colors={brandColors}
          placeholder="Search or add a brand…"
        />
      </Field>
      <Field label="CATEGORY">
        <SearchableChipField
          value={category}
          onChange={(next) => {
            setCategory(next);
            if (next && !categorySuggestions.includes(next)) setCategorySuggestions((prev) => [...prev, next].sort((a, b) => a.localeCompare(b)));
          }}
          suggestions={categorySuggestions}
          colors={categoryColors}
          placeholder="Search or add a category…"
        />
      </Field>
      <Field label="TAGS">
        <TagsField
          value={tags}
          onChange={setTags}
          suggestions={tagSuggestions}
          colors={tagColors}
          onNewTag={(tag) => setTagSuggestions((prev) => [...prev, tag].sort((a, b) => a.localeCompare(b)))}
        />
      </Field>
      <Field label="SUPPLIER"><TextInput value={supplierName} onChangeText={setSupplierName} placeholder="Optional" placeholderTextColor="#999999" style={styles.input} /></Field>
      <Row>
        <Field label="PURCHASE COST" style={styles.half}><TextInput value={costInput} onChangeText={setCostInput} placeholder="0.00" placeholderTextColor="#999999" keyboardType="decimal-pad" style={styles.input} /></Field>
        <Field label="RETAIL PRICE *" style={styles.half}><TextInput value={priceInput} onChangeText={setPriceInput} placeholder="0.00" placeholderTextColor="#999999" keyboardType="decimal-pad" style={styles.input} /></Field>
      </Row>
      <Row>
        <Field label="STOCK" style={styles.half}><TextInput value={stock} onChangeText={setStock} placeholder="0" placeholderTextColor="#999999" keyboardType="number-pad" style={styles.input} /></Field>
        {/* Which store that stock is at. Defaults to the main store, or to the
            one being viewed if the list is filtered — but it is always shown
            once there are several, so nobody adds stock to a store they didn't
            mean to just because the register happened to be set there. */}
        {stores.length > 1 && (
          <Field label="STORE">
            <ScrollView horizontal contentContainerStyle={styles.chipRow} showsHorizontalScrollIndicator={false}>
              {stores.map((store) => (
                <CategoryChip
                  key={store.id}
                  label={store.name}
                  active={locationId === store.id}
                  onPress={() => setLocationId(store.id)}
                />
              ))}
            </ScrollView>
          </Field>
        )}
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
});

function Row({ children }: { children: React.ReactNode }) { return <View style={styles.row}>{children}</View>; }
function Field({ label, children, style }: { label: string; children: React.ReactNode; style?: object }) {
  return <View style={style}><Text style={styles.fieldLabel}>{label}</Text>{children}</View>;
}

// A single-value picker: type to search existing suggestions (shown as
// chips below), or add a brand-new value on the fly — used for both BRAND
// and CATEGORY, which behave identically (pick one, or create one).
function SearchableChipField({
  value,
  onChange,
  suggestions,
  colors,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  suggestions: string[];
  colors?: Map<string, string | null>;
  placeholder: string;
}) {
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const filtered = q ? suggestions.filter((item) => item.toLowerCase().includes(q)) : suggestions;
  const exactMatch = suggestions.some((item) => item.toLowerCase() === q);

  const select = (item: string) => { onChange(item); setQuery(''); };
  const toggle = (item: string) => select(value === item ? '' : item);

  return (
    <>
      <TextInput value={query} onChangeText={setQuery} placeholder={placeholder} placeholderTextColor="#999999" style={styles.input} />
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
        {filtered.map((item) => (
          <CategoryChip key={item} label={item} color={colors?.get(item)} active={value === item} onPress={() => toggle(item)} />
        ))}
        {q.length > 0 && !exactMatch && (
          <CategoryChip label={`+ Add "${query.trim()}"`} active={false} onPress={() => select(query.trim())} />
        )}
      </ScrollView>
      {Boolean(value) && <Text style={styles.categoryHint}>Selected: {value}</Text>}
    </>
  );
}

// Tags are multi-select, kept as a comma-separated value the user can also
// type into directly. The search box only filters which suggestion chips
// are shown; tapping one (or the "+ Add" chip) appends to the CSV.
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
      <TextInput value={value} onChangeText={onChange} placeholder="e.g. bestseller, toner" placeholderTextColor="#999999" style={styles.input} />
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
  chipRow: { flexDirection: 'row', gap: 6, paddingRight: 8 },
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
