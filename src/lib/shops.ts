import { supabase } from '@/lib/supabase';
import type { Shop } from '@/types/models';

function mapShopRow(row: any): Shop {
  return {
    id: row.id,
    ownerId: row.owner_id,
    name: row.name,
    description: row.description,
    city: row.city,
    neighborhood: row.neighborhood,
    contactPhone: row.contact_phone,
    categories: row.categories ?? [],
    createdAt: row.created_at,
  };
}

export async function getMyShop(): Promise<Shop | null> {
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) return null;
  const { data, error } = await supabase
    .from('shops')
    .select('*')
    .eq('owner_id', userData.user.id)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data ? mapShopRow(data) : null;
}

export async function createShop(input: {
  name: string;
  description?: string;
  city?: string;
  neighborhood?: string;
  contactPhone?: string;
  categories?: string[];
}): Promise<Shop> {
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) throw new Error('Must be signed in to create a shop');
  const { data, error } = await supabase
    .from('shops')
    .insert({
      owner_id: userData.user.id,
      name: input.name,
      description: input.description ?? null,
      city: input.city ?? 'Hargeisa',
      neighborhood: input.neighborhood ?? null,
      contact_phone: input.contactPhone ?? null,
      categories: input.categories ?? [],
    })
    .select('*')
    .single();
  if (error) throw error;
  return mapShopRow(data);
}

export async function updateShop(id: string, input: Partial<{
  name: string; description: string; city: string; neighborhood: string; contactPhone: string; categories: string[];
}>): Promise<Shop> {
  const { data, error } = await supabase
    .from('shops')
    .update({
      ...(input.name !== undefined && { name: input.name }),
      ...(input.description !== undefined && { description: input.description }),
      ...(input.city !== undefined && { city: input.city }),
      ...(input.neighborhood !== undefined && { neighborhood: input.neighborhood }),
      ...(input.contactPhone !== undefined && { contact_phone: input.contactPhone }),
      ...(input.categories !== undefined && { categories: input.categories }),
    })
    .eq('id', id)
    .select('*')
    .single();
  if (error) throw error;
  return mapShopRow(data);
}
