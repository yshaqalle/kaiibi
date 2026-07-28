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
