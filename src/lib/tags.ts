import { supabase } from '@/lib/supabase';
import type { Tag } from '@/types/models';

function mapTagRow(row: any): Tag {
  return { id: row.id, shopId: row.shop_id, name: row.name, createdAt: row.created_at };
}

export async function listTags(shopId: string): Promise<Tag[]> {
  const { data, error } = await supabase
    .from('tags')
    .select('*')
    .eq('shop_id', shopId)
    .order('name', { ascending: true });
  if (error) throw error;
  return (data ?? []).map(mapTagRow);
}

// Upsert (ignoring the row if it already exists) rather than a plain insert:
// this is called both from Settings' explicit "Add" button and from the
// product form whenever someone types a tag that isn't in the table yet, so
// it must be safe to call redundantly without a duplicate-key error.
export async function createTag(shopId: string, name: string): Promise<void> {
  const { error } = await supabase
    .from('tags')
    .upsert({ shop_id: shopId, name }, { onConflict: 'shop_id,name', ignoreDuplicates: true });
  if (error) throw error;
}

// Renaming/deleting must go through the RPCs (not a plain `.update()`/
// `.delete()` on the table) so the change cascades atomically to every
// product's `tags` array — see migration 0004.
export async function renameTag(shopId: string, oldName: string, newName: string): Promise<void> {
  const { error } = await supabase.rpc('rename_tag', { p_shop_id: shopId, p_old_name: oldName, p_new_name: newName });
  if (error) throw error;
}

export async function deleteTag(shopId: string, name: string): Promise<void> {
  const { error } = await supabase.rpc('delete_tag', { p_shop_id: shopId, p_name: name });
  if (error) throw error;
}
