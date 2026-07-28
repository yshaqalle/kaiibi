import { uploadImage } from '@/lib/storage';
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
    returnPolicy: row.return_policy,
    logoUrl: row.logo_url,
    categories: row.categories ?? [],
    monthlyRevenueGoalCents: row.monthly_revenue_goal_cents,
    taxEnabled: row.tax_enabled,
    taxRatePercent: Number(row.tax_rate_percent),
    createdAt: row.created_at,
  };
}

export async function uploadShopLogo(shopId: string, localUri: string): Promise<string> {
  return uploadImage(`${shopId}/logo-${Date.now()}`, localUri);
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
  if (data) return mapShopRow(data);

  // Not an admin (no shop they own) -- check if they're staff at one instead.
  const { data: membership, error: membershipError } = await supabase
    .from('shop_members')
    .select('shop:shops(*)')
    .eq('user_id', userData.user.id)
    .eq('active', true)
    .limit(1)
    .maybeSingle();
  if (membershipError) throw membershipError;
  return membership?.shop ? mapShopRow(membership.shop) : null;
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
  const shop = mapShopRow(data);
  // Same starting currencies the migration backfills for shops that
  // existed before this feature shipped — see migration 0015.
  const { error: currencyError } = await supabase.from('shop_currencies').insert([
    { shop_id: shop.id, code: 'SLSH', name: 'Somaliland Shilling', symbol: 'Sl Sh', rate_to_usd: 115, active: true },
    { shop_id: shop.id, code: 'ETB', name: 'Ethiopian Birr', symbol: 'Br', rate_to_usd: 130, active: false },
  ]);
  if (currencyError) throw currencyError;
  return shop;
}

export async function updateShop(id: string, input: Partial<{
  name: string; description: string; city: string; neighborhood: string; contactPhone: string; returnPolicy: string; logoUrl: string | null; categories: string[]; monthlyRevenueGoalCents: number | null; taxEnabled: boolean; taxRatePercent: number;
}>): Promise<Shop> {
  const { data, error } = await supabase
    .from('shops')
    .update({
      ...(input.name !== undefined && { name: input.name }),
      ...(input.description !== undefined && { description: input.description }),
      ...(input.city !== undefined && { city: input.city }),
      ...(input.neighborhood !== undefined && { neighborhood: input.neighborhood }),
      ...(input.contactPhone !== undefined && { contact_phone: input.contactPhone }),
      ...(input.returnPolicy !== undefined && { return_policy: input.returnPolicy }),
      ...(input.logoUrl !== undefined && { logo_url: input.logoUrl }),
      ...(input.categories !== undefined && { categories: input.categories }),
      ...(input.monthlyRevenueGoalCents !== undefined && { monthly_revenue_goal_cents: input.monthlyRevenueGoalCents }),
      ...(input.taxEnabled !== undefined && { tax_enabled: input.taxEnabled }),
      ...(input.taxRatePercent !== undefined && { tax_rate_percent: input.taxRatePercent }),
    })
    .eq('id', id)
    .select('*')
    .single();
  if (error) throw error;
  return mapShopRow(data);
}
