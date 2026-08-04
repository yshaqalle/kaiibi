import { supabase } from '@/lib/supabase';
import type { NewShopLocationInput, ShopLocation } from '@/types/models';

function mapLocationRow(row: any): ShopLocation {
  return {
    id: row.id,
    shopId: row.shop_id,
    name: row.name,
    code: row.code,
    city: row.city,
    neighborhood: row.neighborhood,
    address: row.address,
    contactPhone: row.contact_phone,
    openingHours: row.opening_hours ?? {},
    monthlyRevenueGoalCents: row.monthly_revenue_goal_cents,
    isPrimary: row.is_primary,
    active: row.active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toRow(input: Partial<NewShopLocationInput>) {
  return {
    ...(input.name !== undefined && { name: input.name }),
    ...(input.code !== undefined && { code: input.code }),
    ...(input.city !== undefined && { city: input.city }),
    ...(input.neighborhood !== undefined && { neighborhood: input.neighborhood }),
    ...(input.address !== undefined && { address: input.address }),
    ...(input.contactPhone !== undefined && { contact_phone: input.contactPhone }),
    ...(input.openingHours !== undefined && { opening_hours: input.openingHours }),
    ...(input.monthlyRevenueGoalCents !== undefined && { monthly_revenue_goal_cents: input.monthlyRevenueGoalCents }),
    ...(input.active !== undefined && { active: input.active }),
  };
}

// Every location, inactive ones included -- Settings has to list a closed
// branch to reopen or rename it. Callers that offer a *choice* (the switcher,
// the POS) filter to `active` themselves.
//
// Primary first, then alphabetical: the primary is the one most sessions want,
// and a stable order keeps the switcher from reshuffling as branches are added.
export async function listLocations(shopId: string): Promise<ShopLocation[]> {
  const { data, error } = await supabase
    .from('shop_locations')
    .select('*')
    .eq('shop_id', shopId)
    .order('is_primary', { ascending: false })
    .order('name', { ascending: true });
  if (error) throw error;
  return (data ?? []).map(mapLocationRow);
}

// The stores this user may actually operate at -- their assigned one, or all of
// them when unassigned. Every store remains *readable* (a receipt names one, a
// report lists them), so this narrows what the switcher and the POS offer, not
// what anyone can see.
//
// Offering a store the database will then refuse reads as a bug rather than as
// a permission, which is the whole reason this is a separate query rather than
// a client-side filter over `listLocations`.
export async function listMyLocations(shopId: string): Promise<ShopLocation[]> {
  const [{ data: allowedIds, error: idsError }, all] = await Promise.all([
    supabase.rpc('my_location_ids', { p_shop_id: shopId }),
    listLocations(shopId),
  ]);
  if (idsError) throw idsError;
  const allowed = new Set((allowedIds as string[] | null) ?? []);
  return all.filter((location) => allowed.has(location.id));
}

export async function createLocation(shopId: string, input: NewShopLocationInput): Promise<ShopLocation> {
  const { data, error } = await supabase
    .from('shop_locations')
    .insert({ shop_id: shopId, ...toRow(input) })
    .select('*')
    .single();
  if (error) throw error;
  return mapLocationRow(data);
}

export async function updateLocation(id: string, patch: Partial<NewShopLocationInput>): Promise<ShopLocation> {
  const { data, error } = await supabase
    .from('shop_locations')
    .update({ ...toRow(patch), updated_at: new Date().toISOString() })
    .eq('id', id)
    .select('*')
    .single();
  if (error) throw error;
  return mapLocationRow(data);
}

// Two writes, in this order, because the partial unique index permits only one
// `is_primary` row per shop -- setting the new one first would violate it while
// the old one still stands. So the old primary is cleared first, which leaves a
// one-statement window where the shop has no primary at all.
//
// That window is tolerable only because no reader treats "no primary" as an
// error: `primaryLocationOf` below falls back to the first location rather than
// returning null. If that ever changes, this needs to become an RPC doing both
// updates in one transaction.
export async function setPrimaryLocation(shopId: string, locationId: string): Promise<void> {
  const { error: clearError } = await supabase
    .from('shop_locations')
    .update({ is_primary: false, updated_at: new Date().toISOString() })
    .eq('shop_id', shopId)
    .eq('is_primary', true);
  if (clearError) throw clearError;
  const { error } = await supabase
    .from('shop_locations')
    .update({ is_primary: true, updated_at: new Date().toISOString() })
    .eq('id', locationId);
  if (error) throw error;
}

// Deleting is only safe while a location has nothing pointing at it. Once sales
// and shifts carry a location_id, closing a branch is `active: false` instead --
// which is why the Settings panel offers deactivate as the primary action and
// keeps delete for a branch created by mistake.
export async function deleteLocation(id: string): Promise<void> {
  const { error } = await supabase.from('shop_locations').delete().eq('id', id);
  if (error) throw error;
}
