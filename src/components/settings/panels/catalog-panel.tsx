import { useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { ManageModal } from '@/components/settings/manage-modal';
import { Btn, EditableTextRow, PageHeader, Pill, Row, Section, Toggle } from '@/components/settings/settings-primitives';
import { TaxonomyManageModal, type TaxonomyInput, type TaxonomyRow } from '@/components/taxonomy-manage-modal';
import { nextTaxonomyColor } from '@/lib/colors';
import { updateShop } from '@/lib/shops';
import type { Shop } from '@/types/models';

const previewCount = 6;

function TaxonomyPillSection({
  title,
  itemLabel,
  hint,
  items,
  usage,
  onCreate,
  onUpdate,
  onDelete,
  uploadImage,
}: {
  title: string;
  itemLabel: string;
  hint: string;
  items: TaxonomyRow[];
  usage: Map<string, number>;
  onCreate: (input: TaxonomyInput) => Promise<void>;
  onUpdate: (item: TaxonomyRow, input: TaxonomyInput) => Promise<void>;
  onDelete: (item: TaxonomyRow) => Promise<void>;
  uploadImage: (localUri: string) => Promise<string>;
}) {
  const [modalOpen, setModalOpen] = useState(false);
  const mostUsed = useMemo(
    () => [...items].sort((a, b) => (usage.get(b.name) ?? 0) - (usage.get(a.name) ?? 0)).slice(0, previewCount),
    [items, usage]
  );

  return (
    <Section title={`${title} · ${items.length}`}>
      <Text style={styles.hint}>{hint}</Text>
      {items.length === 0 ? (
        <Text style={styles.empty}>None yet.</Text>
      ) : (
        <View style={styles.pillRow}>
          {mostUsed.map((item) => (
            <Pill key={item.id}>
              {item.name} {usage.get(item.name) ?? 0}
            </Pill>
          ))}
          {items.length > previewCount && <Pill>+{items.length - previewCount} more</Pill>}
        </View>
      )}
      <View style={styles.actionsRow}>
        <Btn onPress={() => setModalOpen(true)}>Manage ({items.length})</Btn>
      </View>
      <TaxonomyManageModal
        visible={modalOpen}
        onClose={() => setModalOpen(false)}
        title={title}
        itemLabel={itemLabel}
        items={items}
        usage={usage}
        nextColor={nextTaxonomyColor(items.length)}
        onCreate={onCreate}
        onUpdate={onUpdate}
        onDelete={onDelete}
        uploadImage={uploadImage}
      />
    </Section>
  );
}

function TagsPillSection({
  tags,
  tagColors,
  usage,
  onAdd,
  onRename,
  onDelete,
  onColorChange,
}: {
  tags: string[];
  tagColors: Map<string, string | null>;
  usage: Map<string, number>;
  onAdd: (name: string) => void;
  onRename: (oldName: string, newName: string) => void;
  onDelete: (name: string) => void;
  onColorChange: (name: string, color: string) => void;
}) {
  const [modalOpen, setModalOpen] = useState(false);
  const mostUsed = useMemo(() => [...tags].sort((a, b) => (usage.get(b) ?? 0) - (usage.get(a) ?? 0)).slice(0, previewCount), [tags, usage]);

  return (
    <Section title={`Tags · ${tags.length}`}>
      <Text style={styles.hint}>Extra keywords for products, like bestseller or handmade.</Text>
      {tags.length === 0 ? (
        <Text style={styles.empty}>None yet.</Text>
      ) : (
        <View style={styles.pillRow}>
          {mostUsed.map((t) => (
            <Pill key={t}>
              {t} {usage.get(t) ?? 0}
            </Pill>
          ))}
          {tags.length > previewCount && <Pill>+{tags.length - previewCount} more</Pill>}
        </View>
      )}
      <View style={styles.actionsRow}>
        <Btn onPress={() => setModalOpen(true)}>Manage tags</Btn>
      </View>
      <ManageModal
        visible={modalOpen}
        onClose={() => setModalOpen(false)}
        title="TAGS"
        itemLabel="tag"
        items={tags}
        usage={usage}
        colors={tagColors}
        onAdd={onAdd}
        onRename={onRename}
        onDelete={onDelete}
        onColorChange={onColorChange}
      />
    </Section>
  );
}

export function CatalogPanel({
  brandRows,
  categoryRows,
  tags,
  tagColors,
  brandUsage,
  categoryUsage,
  tagUsage,
  onCreateBrand,
  onUpdateBrand,
  onDeleteBrand,
  uploadBrandImage,
  onCreateCategory,
  onUpdateCategory,
  onDeleteCategory,
  uploadCategoryImage,
  onAddTag,
  onRenameTag,
  onDeleteTag,
  onTagColorChange,
}: {
  brandRows: TaxonomyRow[];
  categoryRows: TaxonomyRow[];
  tags: string[];
  tagColors: Map<string, string | null>;
  brandUsage: Map<string, number>;
  categoryUsage: Map<string, number>;
  tagUsage: Map<string, number>;
  onCreateBrand: (input: TaxonomyInput) => Promise<void>;
  onUpdateBrand: (item: TaxonomyRow, input: TaxonomyInput) => Promise<void>;
  onDeleteBrand: (item: TaxonomyRow) => Promise<void>;
  uploadBrandImage: (localUri: string) => Promise<string>;
  onCreateCategory: (input: TaxonomyInput) => Promise<void>;
  onUpdateCategory: (item: TaxonomyRow, input: TaxonomyInput) => Promise<void>;
  onDeleteCategory: (item: TaxonomyRow) => Promise<void>;
  uploadCategoryImage: (localUri: string) => Promise<string>;
  onAddTag: (name: string) => void;
  onRenameTag: (oldName: string, newName: string) => void;
  onDeleteTag: (name: string) => void;
  onTagColorChange: (name: string, color: string) => void;
}) {
  return (
    <View>
      <PageHeader title="Brands and categories" />
      <TaxonomyPillSection
        title="BRANDS"
        itemLabel="brand"
        hint="Brands you carry. Renaming or removing a brand updates every product using it."
        items={brandRows}
        usage={brandUsage}
        onCreate={onCreateBrand}
        onUpdate={onUpdateBrand}
        onDelete={onDeleteBrand}
        uploadImage={uploadBrandImage}
      />
      <TaxonomyPillSection
        title="CATEGORIES"
        itemLabel="category"
        hint="Group products in the POS and inventory screens. Renaming or removing a category updates every product using it."
        items={categoryRows}
        usage={categoryUsage}
        onCreate={onCreateCategory}
        onUpdate={onUpdateCategory}
        onDelete={onDeleteCategory}
        uploadImage={uploadCategoryImage}
      />
      <TagsPillSection tags={tags} tagColors={tagColors} usage={tagUsage} onAdd={onAddTag} onRename={onRenameTag} onDelete={onDeleteTag} onColorChange={onTagColorChange} />
    </View>
  );
}

// ─── Inventory alerts ────────────────────────────────────────────────────

// "Default low stock level" and expiry tracking are real (shops columns,
// migration 0030) and actually drive the ⚠ Low / ⏳ Expiring badges on
// ProductTile/ProductTableRow and the low-stock count on Inventory/Dashboard
// — see lib/products.ts's getLowStockProducts/getExpiringProducts.
// "Per-product overrides" isn't a separate UI here: every product already
// has its own Reorder Level field in the product edit form, so this just
// links to Inventory where that's set today.
export function InventoryAlertsPanel({ shop, onSaved }: { shop: Shop; onSaved: () => Promise<void> }) {
  const router = useRouter();
  const [defaultLowStockLevel, setDefaultLowStockLevel] = useState(String(shop.defaultLowStockLevel));
  const [expiryTrackingEnabled, setExpiryTrackingEnabled] = useState(shop.expiryTrackingEnabled);
  const [expiryWarningLeadDays, setExpiryWarningLeadDays] = useState(String(shop.expiryWarningLeadDays));
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dirty =
    defaultLowStockLevel.trim() !== String(shop.defaultLowStockLevel) ||
    expiryTrackingEnabled !== shop.expiryTrackingEnabled ||
    expiryWarningLeadDays.trim() !== String(shop.expiryWarningLeadDays);

  const save = async () => {
    const level = Number(defaultLowStockLevel);
    const leadDays = Number(expiryWarningLeadDays);
    if (!Number.isFinite(level) || level < 0) {
      setError('Default low stock level must be 0 or more.');
      return;
    }
    if (!Number.isFinite(leadDays) || leadDays < 0) {
      setError('Expiry warning lead time must be 0 or more.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await updateShop(shop.id, {
        defaultLowStockLevel: Math.round(level),
        expiryTrackingEnabled,
        expiryWarningLeadDays: Math.round(leadDays),
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
    <View>
      <PageHeader title="Inventory alerts" actionLabel={saving ? 'Saving…' : saved ? 'Saved ✓' : 'Save'} onAction={save} actionDisabled={!dirty || saving} />
      {error && <Text style={styles.error}>{error}</Text>}
      <Section title="Low stock thresholds">
        <EditableTextRow
          label="Default low stock level"
          value={defaultLowStockLevel}
          onChangeText={setDefaultLowStockLevel}
          placeholder="5"
          keyboardType="number-pad"
        />
        <Row label="Per-product overrides" desc="Set a custom threshold per product in Inventory">
          <Btn onPress={() => router.push('/inventory')}>Manage</Btn>
        </Row>
      </Section>
      <Section title="Expiry tracking">
        <Row label="Track expiry dates" desc="Flags products that already have an expiry date set — never products without one">
          <Toggle value={expiryTrackingEnabled} onValueChange={setExpiryTrackingEnabled} />
        </Row>
        <EditableTextRow
          label="Expiry warning lead time (days)"
          value={expiryWarningLeadDays}
          onChangeText={setExpiryWarningLeadDays}
          placeholder="30"
          keyboardType="number-pad"
        />
      </Section>
    </View>
  );
}

const styles = StyleSheet.create({
  hint: { fontSize: 12, color: '#9CA3AF', lineHeight: 17, marginBottom: 12 },
  empty: { fontSize: 13, color: '#9CA3AF', marginBottom: 12 },
  pillRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 12 },
  actionsRow: { flexDirection: 'row', gap: 8 },
  error: { color: '#C0392B', fontSize: 13, fontWeight: '700', marginBottom: 16 },
});
