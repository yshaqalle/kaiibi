import { supabase } from '@/lib/supabase';
import type { Cashier } from '@/types/models';

function mapCashierRow(row: any): Cashier {
  return { id: row.id, shopId: row.shop_id, locationId: row.location_id, name: row.name, createdAt: row.created_at };
}

export async function listCashiers(shopId: string): Promise<Cashier[]> {
  const { data, error } = await supabase
    .from('cashiers')
    .select('*')
    .eq('shop_id', shopId)
    .order('name', { ascending: true });
  if (error) throw error;
  return (data ?? []).map(mapCashierRow);
}

// `location_id` is NOT NULL since migration 20260815000000 and has no default,
// so the insert must carry one or Postgres rejects the row (23502). The name
// itself stays unique per SHOP, not per location -- listCashiers and the POS
// picker are both shop-wide, so the location is which store the profile was
// registered at, not a scope that lets two stores reuse a name.
export async function createCashier(shopId: string, locationId: string, name: string): Promise<void> {
  const { error } = await supabase
    .from('cashiers')
    .upsert({ shop_id: shopId, location_id: locationId, name }, { onConflict: 'shop_id,name', ignoreDuplicates: true });
  if (error) throw error;
}

// A cashier's name on a sale is a frozen snapshot (see migration 0009), so
// unlike categories/tags/brands there's nothing to cascade here — rename
// and delete are plain table writes, not RPCs.
export async function renameCashier(shopId: string, oldName: string, newName: string): Promise<void> {
  const { error } = await supabase.from('cashiers').update({ name: newName }).eq('shop_id', shopId).eq('name', oldName);
  if (error) throw error;
}

export async function deleteCashier(shopId: string, name: string): Promise<void> {
  const { error } = await supabase.from('cashiers').delete().eq('shop_id', shopId).eq('name', name);
  if (error) throw error;
}
