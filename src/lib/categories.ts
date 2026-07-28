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
