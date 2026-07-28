# Brand & Category Media Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the owner attach a photo and description to each brand and category, and manage them in Settings via an inventory-style list (tile rows) that opens a detail editor on tap — matching how products are already managed.

**Architecture:** Add `description`/`image_url` columns to `brands`/`categories` (mirroring how `0012_taxonomy_colors.sql` added `color`). Add two new, generic (brand-or-category-agnostic) components: `TaxonomyManageModal` (list + search) and `TaxonomyEditModal` (photo/name/description/color form, embedded inside the list modal rather than as its own separate `<Modal>`). Wire them into `settings.tsx` via a new small `TaxonomySection` wrapper that reuses the existing section header/preview-chip markup. Tags and Cashiers keep using the existing `CategorySection`/`ManageModal` untouched.

**Tech Stack:** Expo Router v57, React Native, TypeScript, Supabase (Postgres + Storage), `expo-image-picker`, `expo-image`.

## Global Constraints

- Read `AGENTS.md` at the repo root before touching any Expo API — this project pins to Expo SDK 57 and the docs at https://docs.expo.dev/versions/v57.0.0/ are the source of truth for current API shapes. This plan only reuses `expo-image-picker`/`expo-image` exactly as already used in `product-form.tsx`/`settings.tsx`, so no new API surface is introduced.
- Reuse the existing `taxonomyPalette` colors from `src/lib/colors.ts` — do not invent new colors.
- This codebase has no component-level test suite (Jest is configured, but only for pure-logic files like `src/lib/__tests__/currency.test.ts`; UI components like `ProductModal`/`ManageModal` have no tests). Follow that existing convention: verification for this plan is `npx tsc --noEmit`, `npx eslint <file>`, and manual verification against the running dev server (the same way every other Settings feature in this codebase has been verified) — not new Jest tests for UI components or thin Supabase CRUD wrappers.
- Every mutating Supabase call in this codebase ends by re-running `reload()` in `settings.tsx` to refresh from the server — keep that pattern.
- Migrations in this repo are written to the repo but must be applied to the live Supabase project separately (there is no local Supabase CLI in this environment) — Task 1 ends with a reminder to run the SQL, the same way `0012_taxonomy_colors.sql` had to be applied manually earlier in this project's history.

---

### Task 1: Migration — add `description`/`image_url` columns

**Files:**
- Create: `supabase/migrations/0016_brand_category_media.sql`

**Interfaces:**
- Produces: `brands.description`, `brands.image_url`, `categories.description`, `categories.image_url` columns (both nullable `text`), used by every later task.

- [ ] **Step 1: Create the migration file**

```sql
-- Photo + description for brands/categories — same treatment as `color` in
-- migration 0012: nullable/optional throughout, so anything created before
-- this migration just renders with no photo/description.
alter table public.brands add column if not exists description text;
alter table public.brands add column if not exists image_url text;
alter table public.categories add column if not exists description text;
alter table public.categories add column if not exists image_url text;
```

- [ ] **Step 2: Verify no other migration already claims these column names**

Run: `grep -n "description\|image_url" supabase/migrations/0004_categories_tags.sql supabase/migrations/0008_brands.sql supabase/migrations/0012_taxonomy_colors.sql`
Expected: no matches (confirms this migration isn't a duplicate).

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/0016_brand_category_media.sql
git commit -m "feat: add description and image_url columns to brands/categories"
```

**Note for whoever runs this against the live database:** this SQL must be pasted into the Supabase Dashboard → SQL Editor (or run via `supabase db push`) before Task 3/4's `createBrand`/`updateBrand` calls will work end-to-end — exactly like `0012_taxonomy_colors.sql` needed to be applied manually earlier. The rest of this plan's tasks (2 through 7) type-check and lint independently of whether the migration has been applied yet, but Task 8 (manual verification) requires it.

---

### Task 2: Update `Brand`/`Category` types

**Files:**
- Modify: `src/types/models.ts:212-226`

**Interfaces:**
- Consumes: nothing new.
- Produces: `Brand`/`Category` now carry `description: string | null` and `imageUrl: string | null`, consumed by Tasks 3, 4, 5, 6, 7.

- [ ] **Step 1: Add the two fields to both types**

Replace:
```ts
export type Category = {
  id: string;
  shopId: string;
  name: string;
  color: string | null;
  createdAt: string;
};

export type Brand = {
  id: string;
  shopId: string;
  name: string;
  color: string | null;
  createdAt: string;
};
```
with:
```ts
export type Category = {
  id: string;
  shopId: string;
  name: string;
  color: string | null;
  description: string | null;
  imageUrl: string | null;
  createdAt: string;
};

export type Brand = {
  id: string;
  shopId: string;
  name: string;
  color: string | null;
  description: string | null;
  imageUrl: string | null;
  createdAt: string;
};
```

- [ ] **Step 2: Type-check (expect new errors — that's the point, Tasks 3/4 fix them)**

Run: `npx tsc --noEmit`
Expected: errors in `src/lib/brands.ts` and `src/lib/categories.ts` where `mapBrandRow`/`mapCategoryRow` no longer satisfy the `Brand`/`Category` return type (missing `description`/`imageUrl`). This confirms the type change took effect.

- [ ] **Step 3: Commit**

```bash
git add src/types/models.ts
git commit -m "feat: add description and imageUrl fields to Brand/Category types"
```

---

### Task 3: Update `lib/brands.ts`

**Files:**
- Modify: `src/lib/brands.ts` (entire file, shown in full below)

**Interfaces:**
- Consumes: `Brand` type from Task 2; `uploadImage` from `src/lib/storage.ts` (existing, signature `(path: string, localUri: string) => Promise<string>`).
- Produces: `createBrand(shopId, name, options?)`, `updateBrand(shopId, name, input)`, `uploadBrandImage(shopId, localUri)` — consumed by Task 7 (`settings.tsx`) and, for `createBrand`, already consumed unchanged by `src/components/product-form.tsx:95` (`createBrand(shopId, brand.trim())` — still valid since `options` is optional).
- Removes: `updateBrandColor` (only call site was `settings.tsx`, replaced in Task 7).

- [ ] **Step 1: Replace the whole file**

```ts
import { uploadImage } from '@/lib/storage';
import { supabase } from '@/lib/supabase';
import type { Brand } from '@/types/models';

function mapBrandRow(row: any): Brand {
  return {
    id: row.id,
    shopId: row.shop_id,
    name: row.name,
    color: row.color,
    description: row.description,
    imageUrl: row.image_url,
    createdAt: row.created_at,
  };
}

export async function listBrands(shopId: string): Promise<Brand[]> {
  const { data, error } = await supabase
    .from('brands')
    .select('*')
    .eq('shop_id', shopId)
    .order('name', { ascending: true });
  if (error) throw error;
  return (data ?? []).map(mapBrandRow);
}

// Upsert (ignoring the row if it already exists) — see createCategory for
// why: called both from Settings' "Add" button and from the product form
// whenever someone types a brand that isn't in the table yet.
export async function createBrand(
  shopId: string,
  name: string,
  options?: { color?: string | null; description?: string | null; imageUrl?: string | null }
): Promise<void> {
  const { error } = await supabase.from('brands').upsert(
    {
      shop_id: shopId,
      name,
      color: options?.color ?? null,
      description: options?.description ?? null,
      image_url: options?.imageUrl ?? null,
    },
    { onConflict: 'shop_id,name', ignoreDuplicates: true }
  );
  if (error) throw error;
}

// Renaming/deleting must go through the RPCs so it cascades atomically to
// every product's free-text `brand` field — see migration 0008.
export async function renameBrand(shopId: string, oldName: string, newName: string): Promise<void> {
  const { error } = await supabase.rpc('rename_brand', { p_shop_id: shopId, p_old_name: oldName, p_new_name: newName });
  if (error) throw error;
}

export async function deleteBrand(shopId: string, name: string): Promise<void> {
  const { error } = await supabase.rpc('delete_brand', { p_shop_id: shopId, p_name: name });
  if (error) throw error;
}

// Color/description/photo aren't part of the rename/delete cascade concern
// (none of them appear anywhere on `products`), so this is a plain table
// write, not an RPC — same reasoning as the old updateBrandColor it replaces.
export async function updateBrand(
  shopId: string,
  name: string,
  input: Partial<{ color: string | null; description: string | null; imageUrl: string | null }>
): Promise<void> {
  const { error } = await supabase
    .from('brands')
    .update({
      ...(input.color !== undefined && { color: input.color }),
      ...(input.description !== undefined && { description: input.description }),
      ...(input.imageUrl !== undefined && { image_url: input.imageUrl }),
    })
    .eq('shop_id', shopId)
    .eq('name', name);
  if (error) throw error;
}

// Shares the `product-images` bucket with product photos and shop logos —
// its RLS is keyed off the first path segment being the shop id, not the
// kind of image (see migration 0002 and lib/storage.ts).
export async function uploadBrandImage(shopId: string, localUri: string): Promise<string> {
  return uploadImage(`${shopId}/brand-${Date.now()}`, localUri);
}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors referencing `src/lib/brands.ts`. (Errors may still remain in `src/lib/categories.ts` and `src/app/(owner)/settings.tsx` until Tasks 4 and 7 — that's expected at this point.)

- [ ] **Step 3: Lint**

Run: `npx eslint src/lib/brands.ts`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/lib/brands.ts
git commit -m "feat: add description/image support to brands lib"
```

---

### Task 4: Update `lib/categories.ts`

**Files:**
- Modify: `src/lib/categories.ts` (entire file, shown in full below)

**Interfaces:**
- Consumes: `Category` type from Task 2; `uploadImage` from `src/lib/storage.ts`.
- Produces: `createCategory(shopId, name, options?)`, `updateCategory(shopId, name, input)`, `uploadCategoryImage(shopId, localUri)` — consumed by Task 7, and (for `createCategory`) already consumed unchanged by `src/components/product-form.tsx:96`.
- Removes: `updateCategoryColor` (only call site was `settings.tsx`, replaced in Task 7).

- [ ] **Step 1: Replace the whole file**

```ts
import { uploadImage } from '@/lib/storage';
import { supabase } from '@/lib/supabase';
import type { Category } from '@/types/models';

function mapCategoryRow(row: any): Category {
  return {
    id: row.id,
    shopId: row.shop_id,
    name: row.name,
    color: row.color,
    description: row.description,
    imageUrl: row.image_url,
    createdAt: row.created_at,
  };
}

export async function listCategories(shopId: string): Promise<Category[]> {
  const { data, error } = await supabase
    .from('categories')
    .select('*')
    .eq('shop_id', shopId)
    .order('name', { ascending: true });
  if (error) throw error;
  return (data ?? []).map(mapCategoryRow);
}

// Upsert (ignoring the row if it already exists) rather than a plain insert:
// this is called both from Settings' explicit "Add" button and from the
// product form whenever someone types a category that isn't in the table
// yet, so it must be safe to call redundantly without a duplicate-key error.
export async function createCategory(
  shopId: string,
  name: string,
  options?: { color?: string | null; description?: string | null; imageUrl?: string | null }
): Promise<void> {
  const { error } = await supabase.from('categories').upsert(
    {
      shop_id: shopId,
      name,
      color: options?.color ?? null,
      description: options?.description ?? null,
      image_url: options?.imageUrl ?? null,
    },
    { onConflict: 'shop_id,name', ignoreDuplicates: true }
  );
  if (error) throw error;
}

// Renaming/deleting must go through the RPCs (not a plain `.update()`/
// `.delete()` on the table) so the rename/removal cascades atomically to
// every product's free-text `category` field — see migration 0004.
export async function renameCategory(shopId: string, oldName: string, newName: string): Promise<void> {
  const { error } = await supabase.rpc('rename_category', { p_shop_id: shopId, p_old_name: oldName, p_new_name: newName });
  if (error) throw error;
}

export async function deleteCategory(shopId: string, name: string): Promise<void> {
  const { error } = await supabase.rpc('delete_category', { p_shop_id: shopId, p_name: name });
  if (error) throw error;
}

// Color/description/photo aren't part of the rename/delete cascade concern
// (none of them appear anywhere on `products`), so this is a plain table
// write, not an RPC — same reasoning as the old updateCategoryColor it replaces.
export async function updateCategory(
  shopId: string,
  name: string,
  input: Partial<{ color: string | null; description: string | null; imageUrl: string | null }>
): Promise<void> {
  const { error } = await supabase
    .from('categories')
    .update({
      ...(input.color !== undefined && { color: input.color }),
      ...(input.description !== undefined && { description: input.description }),
      ...(input.imageUrl !== undefined && { image_url: input.imageUrl }),
    })
    .eq('shop_id', shopId)
    .eq('name', name);
  if (error) throw error;
}

// Shares the `product-images` bucket with product photos and shop logos —
// its RLS is keyed off the first path segment being the shop id, not the
// kind of image (see migration 0002 and lib/storage.ts).
export async function uploadCategoryImage(shopId: string, localUri: string): Promise<string> {
  return uploadImage(`${shopId}/category-${Date.now()}`, localUri);
}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors referencing `src/lib/categories.ts`.

- [ ] **Step 3: Lint**

Run: `npx eslint src/lib/categories.ts`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/lib/categories.ts
git commit -m "feat: add description/image support to categories lib"
```

---

### Task 5: Create `TaxonomyEditModal` (detail editor)

**Files:**
- Create: `src/components/taxonomy-edit-modal.tsx`

**Interfaces:**
- Consumes: `taxonomyPalette` from `src/lib/colors.ts` (existing, `string[]`).
- Produces: `TaxonomyRow` type, `TaxonomyInput` type, `TaxonomyEditModal` component — consumed by Task 6.

**Important:** despite the filename (kept consistent with the approved design doc), this component does **not** render its own `<Modal>` — it's a plain content view, embedded inside `TaxonomyManageModal`'s single `<Modal>` in Task 6. This mirrors how `ProductForm` (`src/components/product-form.tsx`) is a plain form embedded inside `ProductModal`'s one `<Modal>`, rather than two native modals stacked on top of each other (which this codebase has no existing precedent for and is safer to avoid, especially on Android).

- [ ] **Step 1: Create the file**

```tsx
import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { taxonomyPalette } from '@/lib/colors';

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
      // A freshly picked photo is a local URI, not the http(s) URL of an
      // already-uploaded one — same check as product-form.tsx/ShopSection.
      if (imageUri && !/^https?:\/\//.test(imageUri)) {
        setUploading(true);
        resolvedImageUrl = await uploadImage(imageUri);
        setUploading(false);
      } else if (imageUri === null) {
        resolvedImageUrl = null;
      }
      await onSubmit({ name: name.trim(), color, description: description.trim() || null, imageUrl: resolvedImageUrl });
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
        <View style={styles.backSpacer} />
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
  backSpacer: { width: 44 },
  title: { fontSize: 16, fontWeight: '800', color: '#111111' },
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
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors referencing `src/components/taxonomy-edit-modal.tsx`.

- [ ] **Step 3: Lint**

Run: `npx eslint src/components/taxonomy-edit-modal.tsx`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/components/taxonomy-edit-modal.tsx
git commit -m "feat: add TaxonomyEditModal detail editor for brands/categories"
```

---

### Task 6: Create `TaxonomyManageModal` (list view)

**Files:**
- Create: `src/components/taxonomy-manage-modal.tsx`

**Interfaces:**
- Consumes: `TaxonomyRow`, `TaxonomyInput`, `TaxonomyEditModal` from Task 5 (`src/components/taxonomy-edit-modal.tsx`).
- Produces: `TaxonomyManageModal` component — consumed by Task 7.

- [ ] **Step 1: Create the file**

```tsx
import { Image } from 'expo-image';
import { useMemo, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { TaxonomyEditModal, type TaxonomyInput, type TaxonomyRow } from '@/components/taxonomy-edit-modal';

export type { TaxonomyInput, TaxonomyRow };

// List view for Brands/Categories — tile rows like ProductTile (thumbnail,
// name, description preview, usage count), tapping a row or "+ Add" swaps
// the card's body to TaxonomyEditModal's form (see that file for why it's
// embedded here rather than being its own `<Modal>`).
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

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const sorted = [...items].sort((a, b) => (usage.get(b.name) ?? 0) - (usage.get(a.name) ?? 0));
    return q ? sorted.filter((item) => item.name.toLowerCase().includes(q)) : sorted;
  }, [items, usage, search]);

  return (
    <Modal visible={visible} animationType="fade" transparent onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View style={styles.card}>
          {editingItem === null ? (
            <>
              <View style={styles.header}>
                <Text style={styles.title}>{title}</Text>
                <Pressable onPress={onClose} style={({ pressed }) => [styles.close, pressed && styles.closePressed]}>
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
    </Modal>
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
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors referencing `src/components/taxonomy-manage-modal.tsx`.

- [ ] **Step 3: Lint**

Run: `npx eslint src/components/taxonomy-manage-modal.tsx`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/components/taxonomy-manage-modal.tsx
git commit -m "feat: add TaxonomyManageModal list view for brands/categories"
```

---

### Task 7: Wire `TaxonomyManageModal` into Settings

**Files:**
- Modify: `src/app/(owner)/settings.tsx`

**Interfaces:**
- Consumes: `TaxonomyManageModal`, `TaxonomyRow`, `TaxonomyInput` from Task 6; `createBrand`/`updateBrand`/`uploadBrandImage` from Task 3; `createCategory`/`updateCategory`/`uploadCategoryImage` from Task 4; `Brand`/`Category` types from Task 2.
- Produces: nothing consumed elsewhere — this is the integration point.

- [ ] **Step 1: Update imports (replace lines 1-22)**

Replace:
```tsx
import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { CategoryChip } from '@/components/category-chip';
import { ScreenHeader } from '@/components/screen-header';
import { SegmentedControl } from '@/components/segmented-control';
import { useAuth } from '@/hooks/use-auth';
import { createBrand, deleteBrand, listBrands, renameBrand, updateBrandColor } from '@/lib/brands';
import { createCashier, deleteCashier, listCashiers, renameCashier } from '@/lib/cashiers';
import { createCategory, deleteCategory, listCategories, renameCategory, updateCategoryColor } from '@/lib/categories';
import { nextTaxonomyColor, taxonomyPalette } from '@/lib/colors';
import { createCurrency, deleteCurrency, listCurrencies, setCurrencyActive, updateCurrency } from '@/lib/currencies';
import { formatCents, toCents } from '@/lib/currency';
import { updateProfile } from '@/lib/profile';
import { listProducts } from '@/lib/products';
import { createPromotion, deletePromotion, listPromotions, updatePromotion } from '@/lib/promotions';
import { updateShop, uploadShopLogo } from '@/lib/shops';
import { createTag, deleteTag, listTags, renameTag, updateTagColor } from '@/lib/tags';
import type { Currency, Product, Profile, Promotion, Shop } from '@/types/models';
```
with:
```tsx
import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { CategoryChip } from '@/components/category-chip';
import { ScreenHeader } from '@/components/screen-header';
import { SegmentedControl } from '@/components/segmented-control';
import { TaxonomyManageModal, type TaxonomyInput, type TaxonomyRow } from '@/components/taxonomy-manage-modal';
import { useAuth } from '@/hooks/use-auth';
import { createBrand, deleteBrand, listBrands, renameBrand, updateBrand, uploadBrandImage } from '@/lib/brands';
import { createCashier, deleteCashier, listCashiers, renameCashier } from '@/lib/cashiers';
import { createCategory, deleteCategory, listCategories, renameCategory, updateCategory, uploadCategoryImage } from '@/lib/categories';
import { nextTaxonomyColor, taxonomyPalette } from '@/lib/colors';
import { createCurrency, deleteCurrency, listCurrencies, setCurrencyActive, updateCurrency } from '@/lib/currencies';
import { formatCents, toCents } from '@/lib/currency';
import { updateProfile } from '@/lib/profile';
import { listProducts } from '@/lib/products';
import { createPromotion, deletePromotion, listPromotions, updatePromotion } from '@/lib/promotions';
import { updateShop, uploadShopLogo } from '@/lib/shops';
import { createTag, deleteTag, listTags, renameTag, updateTagColor } from '@/lib/tags';
import type { Brand, Category, Currency, Product, Profile, Promotion, Shop } from '@/types/models';
```

- [ ] **Step 2: Replace brand/category state and add derived name-only lists**

This block (state declarations through the `error` state, immediately followed by `const reload = useCallback(...)`) is unique in the file — this is the top of `SettingsScreen`, not one of the later per-section components that also declare an `error` state. Replace:
```tsx
  const [brands, setBrands] = useState<string[]>([]);
  const [brandColors, setBrandColors] = useState<Map<string, string | null>>(emptyColors);
  const [categories, setCategories] = useState<string[]>([]);
  const [categoryColors, setCategoryColors] = useState<Map<string, string | null>>(emptyColors);
  const [tags, setTags] = useState<string[]>([]);
  const [tagColors, setTagColors] = useState<Map<string, string | null>>(emptyColors);
  const [cashiers, setCashiers] = useState<string[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [promotions, setPromotions] = useState<Promotion[]>([]);
  const [currencies, setCurrencies] = useState<Currency[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
```
with:
```tsx
  const [brandRows, setBrandRows] = useState<Brand[]>([]);
  const [categoryRows, setCategoryRows] = useState<Category[]>([]);
  const [tags, setTags] = useState<string[]>([]);
  const [tagColors, setTagColors] = useState<Map<string, string | null>>(emptyColors);
  const [cashiers, setCashiers] = useState<string[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [promotions, setPromotions] = useState<Promotion[]>([]);
  const [currencies, setCurrencies] = useState<Currency[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // PromotionsSection's scope picker just needs plain names, same as before
  // this task's state change from string[] to full Brand[]/Category[] rows.
  const brands = useMemo(() => brandRows.map((b) => b.name), [brandRows]);
  const categories = useMemo(() => categoryRows.map((c) => c.name), [categoryRows]);

  const reload = useCallback(async () => {
```

- [ ] **Step 3: Update `reload()`'s brand/category handling**

Replace:
```tsx
    if (brandsResult.status === 'fulfilled') {
      setBrands(brandsResult.value.map((b) => b.name));
      setBrandColors(new Map(brandsResult.value.map((b) => [b.name, b.color])));
    }
    if (categoriesResult.status === 'fulfilled') {
      setCategories(categoriesResult.value.map((c) => c.name));
      setCategoryColors(new Map(categoriesResult.value.map((c) => [c.name, c.color])));
    }
```
with:
```tsx
    if (brandsResult.status === 'fulfilled') setBrandRows(brandsResult.value);
    if (categoriesResult.status === 'fulfilled') setCategoryRows(categoriesResult.value);
```

- [ ] **Step 4: Add the `TaxonomySection` wrapper component**

Add this new function directly above `function ProfileSection(...)` (i.e. right after the closing `}` of the main `SettingsScreen` function, before `function ProfileSection`):

```tsx
// Header + preview chips + "View/Update" button, same markup as
// CategorySection (below), but opens TaxonomyManageModal (photo/description
// support) instead of ManageModal — used for Brands/Categories only. Tags
// and Cashiers keep using CategorySection/ManageModal directly.
function TaxonomySection({
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
            <View key={item.id} style={styles.previewChip}>
              {item.color && <View style={[styles.previewDot, { backgroundColor: item.color }]} />}
              <Text style={styles.previewChipText}>{item.name}</Text>
              <Text style={styles.previewChipCount}>{usage.get(item.name) ?? 0}</Text>
            </View>
          ))}
          {items.length > previewCount && <Text style={styles.previewMore}>+{items.length - previewCount} more</Text>}
        </View>
      )}

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
    </View>
  );
}
```

- [ ] **Step 5: Replace the BRANDS/CATEGORIES `CategorySection` usages**

Replace (the two `CategorySection` blocks for BRANDS and CATEGORIES — TAGS stays untouched):
```tsx
            <CategorySection
              title="BRANDS"
              itemLabel="brand"
              hint="Brands you carry. Renaming or removing a brand updates every product using it."
              items={brands}
              usage={brandUsage}
              colors={brandColors}
              onAdd={(name) => runOrShowError(async () => { await createBrand(shop.id, name, nextTaxonomyColor(brands.length)); await reload(); })}
              onRename={(oldName, newName) => runOrShowError(async () => { await renameBrand(shop.id, oldName, newName); await reload(); })}
              onDelete={(name) => runOrShowError(async () => { await deleteBrand(shop.id, name); await reload(); })}
              onColorChange={(name, color) => runOrShowError(async () => { await updateBrandColor(shop.id, name, color); await reload(); })}
            />
            <CategorySection
              title="CATEGORIES"
              itemLabel="category"
              hint="Group products in the POS and inventory screens. Renaming or removing a category updates every product using it."
              items={categories}
              usage={categoryUsage}
              colors={categoryColors}
              onAdd={(name) => runOrShowError(async () => { await createCategory(shop.id, name, nextTaxonomyColor(categories.length)); await reload(); })}
              onRename={(oldName, newName) => runOrShowError(async () => { await renameCategory(shop.id, oldName, newName); await reload(); })}
              onDelete={(name) => runOrShowError(async () => { await deleteCategory(shop.id, name); await reload(); })}
              onColorChange={(name, color) => runOrShowError(async () => { await updateCategoryColor(shop.id, name, color); await reload(); })}
            />
```
with:
```tsx
            <TaxonomySection
              title="BRANDS"
              itemLabel="brand"
              hint="Brands you carry. Renaming or removing a brand updates every product using it."
              items={brandRows}
              usage={brandUsage}
              onCreate={async (input) => { await createBrand(shop.id, input.name, input); await reload(); }}
              onUpdate={async (item, input) => {
                if (input.name !== item.name) await renameBrand(shop.id, item.name, input.name);
                await updateBrand(shop.id, input.name, { color: input.color, description: input.description, imageUrl: input.imageUrl });
                await reload();
              }}
              onDelete={async (item) => { await deleteBrand(shop.id, item.name); await reload(); }}
              uploadImage={(localUri) => uploadBrandImage(shop.id, localUri)}
            />
            <TaxonomySection
              title="CATEGORIES"
              itemLabel="category"
              hint="Group products in the POS and inventory screens. Renaming or removing a category updates every product using it."
              items={categoryRows}
              usage={categoryUsage}
              onCreate={async (input) => { await createCategory(shop.id, input.name, input); await reload(); }}
              onUpdate={async (item, input) => {
                if (input.name !== item.name) await renameCategory(shop.id, item.name, input.name);
                await updateCategory(shop.id, input.name, { color: input.color, description: input.description, imageUrl: input.imageUrl });
                await reload();
              }}
              onDelete={async (item) => { await deleteCategory(shop.id, item.name); await reload(); }}
              uploadImage={(localUri) => uploadCategoryImage(shop.id, localUri)}
            />
```

Note these new `onCreate`/`onUpdate`/`onDelete` handlers are **not** wrapped in `runOrShowError` — unlike Tags/Cashiers, errors here are caught and shown inline inside `TaxonomyEditModal` itself (see Task 5), matching how `ProductForm` shows its own errors rather than bubbling to the page-level banner.

- [ ] **Step 6: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors. If any remain referencing `brands`/`categories` as arrays-of-strings elsewhere in the file (e.g. `PromotionsSection`/`PromotionsModal` scope pickers), they're already satisfied by the `useMemo` derived values from Step 3 — investigate any surviving error rather than assuming it's expected.

- [ ] **Step 7: Lint**

Run: `npx eslint "src/app/(owner)/settings.tsx"`
Expected: only the two pre-existing issues already present on `main` before this plan (a `react-hooks/set-state-in-effect` error on the `useEffect(() => { reload(); }, [reload]);` line, and an unused `uploadingLogo` warning in `ShopSection`) — no *new* errors/warnings introduced by this task.

- [ ] **Step 8: Commit**

```bash
git add "src/app/(owner)/settings.tsx"
git commit -m "feat: manage brand/category photos and descriptions in Settings"
```

---

### Task 8: Manual verification

**Files:** none (verification only).

**Prerequisite:** migration `0016_brand_category_media.sql` (Task 1) must already be applied to the live Supabase database — paste it into the Supabase Dashboard → SQL Editor if it hasn't been yet.

- [ ] **Step 1: Confirm the dev server is running and reload the app**

If `npx expo start` isn't already running, start it. Do a full reload (not just Fast Refresh) of the client under test — shake-and-reload on device, or a hard browser refresh on web — to pick up all of this plan's changes cleanly.

- [ ] **Step 2: Add a brand with a photo and description**

In Settings → Catalog → Brands → "+ Add a brand": add a new brand, pick a photo, type a description, pick a color, Save. Confirm:
- The new brand appears in the list with its thumbnail, name, and description.
- The modal returns to the list (stays open) rather than closing, so another item can be added immediately.

- [ ] **Step 3: Edit that brand's name and confirm the rename cascade still works**

Tap the new brand, change its name, Save. Then check Inventory: any product previously tagged with the old brand name should now show the new name (confirms `renameBrand` RPC still fires correctly through the new `onUpdate` wiring).

- [ ] **Step 4: Delete the test brand**

Tap it, Delete, Confirm. Confirm it disappears from the list and any product that had it now shows "No brand" (confirms `deleteBrand` RPC still cascades).

- [ ] **Step 5: Repeat steps 2-4 for Categories**

Same checks, using Settings → Catalog → Categories.

- [ ] **Step 6: Confirm Tags and Cashiers are unaffected**

Open Tags (Catalog tab) and Cashiers (Sales tab) — both should look and behave exactly as before this plan (compact rows, inline rename, no photo/description fields).

- [ ] **Step 7: Full verification sweep**

Run: `npx tsc --noEmit && npx eslint src/app "src/components/taxonomy-edit-modal.tsx" "src/components/taxonomy-manage-modal.tsx" src/lib/brands.ts src/lib/categories.ts src/types/models.ts`
Expected: no new errors beyond the two pre-existing `settings.tsx` issues noted in Task 7.

---

## Self-Review Notes

- **Spec coverage:** every section of `docs/superpowers/specs/2026-07-27-brand-category-media-design.md` is covered — data model (Task 1-2), storage (Task 3-4), components (Task 5-6), Settings integration (Task 7), delete-confirm UX decision (Task 5), name-edit-folds-into-editor decision (Task 7 `onUpdate`), Tags/Cashiers untouched (explicit in Tasks 6-7).
- **Type consistency checked:** `TaxonomyRow`/`TaxonomyInput` (Task 5) are used identically in Task 6 and Task 7; `createBrand`/`createCategory`'s new `options` parameter shape (Task 3/4) matches exactly what `TaxonomySection`'s `onCreate` (Task 7) passes; `updateBrand`/`updateCategory`'s `Partial<{...}>` input shape matches what `onUpdate` (Task 7) constructs.
- **No placeholders:** every step above contains complete, runnable code.
