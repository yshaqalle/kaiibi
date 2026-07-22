import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';

import { formatCents, toCents } from '@/lib/currency';
import type { NewProductInput, Product } from '@/types/models';

const categories = ['Skincare', 'Makeup', 'Hair', 'Body', 'Supplements'];

export function ProductForm({
  initial,
  onSubmit,
  submitLabel,
}: {
  initial?: Product;
  onSubmit: (input: NewProductInput) => Promise<void>;
  submitLabel: string;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [sku, setSku] = useState(initial?.sku ?? '');
  const [barcode, setBarcode] = useState(initial?.barcode ?? '');
  const [brand, setBrand] = useState(initial?.brand ?? '');
  const [category, setCategory] = useState(initial?.category ?? categories[0]);
  const [tags, setTags] = useState(initial?.tags?.join(', ') ?? '');
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

  const valid = Boolean(name.trim() && priceInput.trim());

  const submit = async () => {
    if (!valid) return;
    setSubmitting(true);
    setError(null);
    try {
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
        imageUrl: initial?.imageUrl ?? null,
        isListedOnline,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save this product.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <ScrollView contentContainerStyle={styles.content}>
      <Field label="PRODUCT NAME *"><TextInput value={name} onChangeText={setName} placeholder="e.g. ANUA Heartleaf Toner" placeholderTextColor="#89928B" style={styles.input} /></Field>
      <Field label="DESCRIPTION"><TextInput value={description} onChangeText={setDescription} placeholder="Materials, size, story…" placeholderTextColor="#89928B" style={[styles.input, styles.multiline]} multiline textAlignVertical="top" /></Field>
      <Row>
        <Field label="SKU" style={styles.half}><TextInput value={sku} onChangeText={setSku} placeholder="SKU-001" placeholderTextColor="#89928B" style={styles.input} /></Field>
        <Field label="BARCODE" style={styles.half}><TextInput value={barcode} onChangeText={setBarcode} placeholder="Optional" placeholderTextColor="#89928B" style={styles.input} /></Field>
      </Row>
      <Field label="BRAND"><TextInput value={brand} onChangeText={setBrand} placeholder="e.g. ANUA" placeholderTextColor="#89928B" style={styles.input} /></Field>
      <Field label="CATEGORY">
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
          {categories.map((item) => (
            <Pressable key={item} onPress={() => setCategory(item)} style={[styles.chip, category === item && styles.chipActive]}>
              <Text style={[styles.chipText, category === item && styles.chipTextActive]}>{item}</Text>
            </Pressable>
          ))}
        </ScrollView>
      </Field>
      <Field label="TAGS"><TextInput value={tags} onChangeText={setTags} placeholder="e.g. bestseller, toner" placeholderTextColor="#89928B" style={styles.input} /></Field>
      <Field label="SUPPLIER"><TextInput value={supplierName} onChangeText={setSupplierName} placeholder="Optional" placeholderTextColor="#89928B" style={styles.input} /></Field>
      <Row>
        <Field label="PURCHASE COST" style={styles.half}><TextInput value={costInput} onChangeText={setCostInput} placeholder="0.00" placeholderTextColor="#89928B" keyboardType="decimal-pad" style={styles.input} /></Field>
        <Field label="RETAIL PRICE *" style={styles.half}><TextInput value={priceInput} onChangeText={setPriceInput} placeholder="0.00" placeholderTextColor="#89928B" keyboardType="decimal-pad" style={styles.input} /></Field>
      </Row>
      <Row>
        <Field label="STOCK" style={styles.half}><TextInput value={stock} onChangeText={setStock} placeholder="0" placeholderTextColor="#89928B" keyboardType="number-pad" style={styles.input} /></Field>
        <Field label="REORDER LEVEL" style={styles.half}><TextInput value={reorderLevel} onChangeText={setReorderLevel} placeholder="5" placeholderTextColor="#89928B" keyboardType="number-pad" style={styles.input} /></Field>
      </Row>
      <Field label="SHELF / LOCATION"><TextInput value={shelfNumber} onChangeText={setShelfNumber} placeholder="e.g. A3" placeholderTextColor="#89928B" style={styles.input} /></Field>
      <Row>
        <Field label="EXPIRY DATE" style={styles.half}><TextInput value={expiryDate} onChangeText={setExpiryDate} placeholder="YYYY-MM-DD" placeholderTextColor="#89928B" style={styles.input} /></Field>
        <Field label="BATCH NUMBER" style={styles.half}><TextInput value={batchNumber} onChangeText={setBatchNumber} placeholder="Optional" placeholderTextColor="#89928B" style={styles.input} /></Field>
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
        <Text style={styles.saveText}>{submitting ? 'Saving…' : submitLabel}</Text>
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
  fieldLabel: { fontSize: 10, letterSpacing: 1, fontWeight: '800', color: '#657269', marginBottom: 7, marginTop: 3 },
  input: { backgroundColor: '#fff', borderRadius: 9, paddingHorizontal: 11, height: 43, color: '#17261F', marginBottom: 8 },
  multiline: { height: 78, paddingTop: 11 },
  chips: { gap: 7, paddingBottom: 12 },
  chip: { backgroundColor: '#FFFFFF', paddingVertical: 8, paddingHorizontal: 11, borderRadius: 16, borderWidth: 1, borderColor: '#D9E0D6' },
  chipActive: { backgroundColor: '#31533A', borderColor: '#31533A' },
  chipText: { fontSize: 11, fontWeight: '700', color: '#546158' },
  chipTextActive: { color: '#FFFFFF' },
  toggleRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#EEF2EB', borderRadius: 12, padding: 13, marginTop: 6, marginBottom: 14, gap: 10 },
  toggleTitle: { color: '#17261F', fontSize: 13, fontWeight: '800' },
  toggleHint: { color: '#657269', fontSize: 11, marginTop: 3 },
  error: { color: '#C0392B', fontSize: 12, fontWeight: '700', marginBottom: 10 },
  save: { backgroundColor: '#E45B37', height: 45, borderRadius: 9, alignItems: 'center', justifyContent: 'center' },
  saveDisabled: { backgroundColor: '#C8CCC6' },
  saveText: { color: '#fff', fontWeight: '800' },
});
