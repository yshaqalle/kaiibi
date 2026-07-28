# Brand & Category media (photo + description)

## Overview

Extend Brands and Categories management in Settings so each item can carry a photo and a
description, and rework how they're managed there to match how products are managed in
Inventory: a list of tile rows (thumbnail, name, description preview, usage count) that
open a detail editor on tap, instead of the current compact rename/delete rows. Tags and
Cashiers are unchanged in this pass — Cashiers has its own separate round of changes
planned for later.

## Goals

- Owner can attach a photo and a free-text description to each brand and category.
- Managing brands/categories in Settings feels like managing products: tap a row (or
  "+ Add") to open a detail editor with photo, name, description, and color.
- Existing rename-cascade behavior (renaming a brand/category updates every product using
  it) is preserved exactly, still going through the `rename_brand`/`rename_category` RPCs.
- Existing color coding (from `0012_taxonomy_colors.sql`) is preserved, just moved into the
  detail editor instead of today's separate color-swatch popover.

## Non-goals

- Tags and Cashiers — unchanged in this pass (Cashiers has a separate future round of
  changes, per user).
- Showing the photo/description anywhere outside Settings (customer-facing storefront,
  POS/inventory chips, product form suggestions) — out of scope for now.
- Bulk photo management, drag-reordering, or any brand/category hierarchy.
- Backfilling `description`/`image_url` for existing rows — both nullable, no backfill
  needed.

## Data model

New migration `0016_brand_category_media.sql`:

```sql
alter table public.brands add column if not exists description text;
alter table public.brands add column if not exists image_url text;
alter table public.categories add column if not exists description text;
alter table public.categories add column if not exists image_url text;
```

No RLS/grant changes needed — the existing policies and grants on `brands`/`categories`
already cover new columns on those tables.

`types/models.ts`: `Brand` and `Category` gain `description: string | null` and
`imageUrl: string | null`.

## Storage

Reuse the existing `product-images` bucket and `uploadImage(path, localUri)` helper
(`lib/storage.ts`) — the same bucket already serves product photos and shop logos, keyed
by shop id path segment for RLS. Add a thin wrapper in each lib file, same shape as
`uploadProductImage`/`uploadShopLogo`:

```ts
// lib/brands.ts
export async function uploadBrandImage(shopId: string, localUri: string): Promise<string> {
  return uploadImage(`${shopId}/brand-${Date.now()}`, localUri);
}
// lib/categories.ts
export async function uploadCategoryImage(shopId: string, localUri: string): Promise<string> {
  return uploadImage(`${shopId}/category-${Date.now()}`, localUri);
}
```

## `lib/brands.ts` / `lib/categories.ts` changes

- `mapBrandRow`/`mapCategoryRow` include `description: row.description` and
  `imageUrl: row.image_url`.
- `createBrand`/`createCategory` take an options object instead of the current lone
  `color` positional param: `{ color?, description?, imageUrl? }`. The one existing
  call site that doesn't pass color today (`product-form.tsx`'s auto-create-on-typed-value
  call) is unaffected — it just omits the options object.
- A new `updateBrand(shopId, name, input: Partial<{ color: string | null; description:
  string | null; imageUrl: string | null }>)` replaces the narrower `updateBrandColor` —
  same shape as the existing `updateCurrency`/`updatePromotion` partial-update functions.
  Same for `updateCategory` replacing `updateCategoryColor`.
- `renameBrand`/`renameCategory` (RPC-backed) are unchanged — still the only path that
  changes `name`, and still the only thing that cascades into `products.brand`/
  `products.category`.

## Components

### `TaxonomyManageModal` (new — `src/components/taxonomy-manage-modal.tsx`)

Replaces the Brands/Categories usages of `ManageModal` (which stays as-is for Tags and
Cashiers). Renders:

- The same search bar behavior as today.
- A list of tile rows, styled like `ProductTile`: thumbnail image (or a color-dot
  placeholder using the item's color when there's no photo), name, one-line description
  preview if present, usage count. Tapping a row opens `TaxonomyEditModal` in edit mode.
- A "+ Add" control that opens `TaxonomyEditModal` in create mode.

Its `items` prop changes shape from today's `string[]` to the full row objects
(`Brand[]`/`Category[]`), since tiles need photo/description/color, not just a name.

### `TaxonomyEditModal` (new — `src/components/taxonomy-edit-modal.tsx`)

Mirrors the `ProductModal`/`ProductForm` split (header with Save/Done, scrollable form
body, delete control when editing) but as one component — the field count here is small
enough that it doesn't need `ProductModal`'s ref-exposing header-save-button indirection.

- Photo picker — same `ImagePicker.launchImageLibraryAsync` config already used in
  `product-form.tsx`.
- Name field.
- Description field (multiline).
- Color palette (reuses the existing `taxonomyPalette` swatches from `lib/colors.ts`).
- Save, create mode: calls `createBrand`/`createCategory` with name and the color/
  description/imageUrl options (uploading a freshly-picked local photo first, using the
  same "already an https URL?" check already used in `product-form.tsx`/`ShopSection`).
- Save, edit mode: if the name field changed from `initial.name`, calls
  `renameBrand`/`renameCategory` first; either way, then calls `updateBrand`/
  `updateCategory` on the (possibly just-renamed) row with color/description/imageUrl,
  uploading a freshly-picked photo first as above.
- Delete (edit mode only): inline confirm-then-delete, matching today's `ManageModal`
  delete UX (not `ProductModal`'s immediate delete) — calls `deleteBrand`/`deleteCategory`.

### Settings screen (`src/app/(owner)/settings.tsx`)

- The BRANDS/CATEGORIES section header (title, hint, preview chips, "View/Update (n)"
  button) stays as it is today; only the modal it opens changes, from `ManageModal` to
  `TaxonomyManageModal`.
- `reload()` already refetches `listBrands`/`listCategories` via `select('*')`, so the
  rows already carry `description`/`image_url` once the migration lands — no changes
  needed there.
- Tags and Cashiers sections are untouched, still using `CategorySection`/`ManageModal`
  exactly as today.

## Error handling

Same `runOrShowError` pattern already used for every other Settings action — no new error
paths beyond what create/rename/delete/upload already handle elsewhere in the app (e.g.
`product-form.tsx`'s upload-then-save flow).

## Testing

- `tsc --noEmit` and lint clean.
- Manual verification in the running dev server: add a brand with a photo and
  description, confirm it renders correctly in the list; edit an existing brand's name
  and confirm the rename still cascades to its products; delete a brand and confirm its
  products' `brand` field clears afterward. Repeat for categories.

## Out of scope

- Tags, Cashiers (separate future work per user).
- Any customer-facing surface for these images/descriptions.
