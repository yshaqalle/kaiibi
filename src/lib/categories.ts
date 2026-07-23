import { supabase } from '@/lib/supabase';
import type { Category } from '@/types/models';

function mapCategoryRow(row: any): Category {
  return { id: row.id, shopId: row.shop_id, name: row.name, createdAt: row.created_at };
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
// `ignoreDuplicates` means a conflicting row comes back empty from
// `RETURNING`, so this doesn't try to select/return the row — callers that
// need the up-to-date list should re-fetch via `listCategories`.
export async function createCategory(shopId: string, name: string): Promise<void> {
  const { error } = await supabase
    .from('categories')
    .upsert({ shop_id: shopId, name }, { onConflict: 'shop_id,name', ignoreDuplicates: true });
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
