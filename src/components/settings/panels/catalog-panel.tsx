import { useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { ManageModal } from '@/components/settings/manage-modal';
import { Btn, PageHeader, Pill, Section } from '@/components/settings/settings-primitives';
import { TaxonomyManageModal, type TaxonomyInput, type TaxonomyRow } from '@/components/taxonomy-manage-modal';
import { nextTaxonomyColor } from '@/lib/colors';

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

const styles = StyleSheet.create({
  hint: { fontSize: 12, color: '#9CA3AF', lineHeight: 17, marginBottom: 12 },
  empty: { fontSize: 13, color: '#9CA3AF', marginBottom: 12 },
  pillRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 12 },
  actionsRow: { flexDirection: 'row', gap: 8 },
});
