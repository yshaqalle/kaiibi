import { supabase } from '@/lib/supabase';
import type { FixedAsset, NewFixedAssetInput } from '@/types/models';

// Data access for the asset register. The depreciation arithmetic is in
// asset-depreciation.ts, which imports no Supabase client and is therefore
// unit-testable -- the split matters more here than anywhere else in
// Accounting, because nothing stores a depreciation figure and every statement
// recomputes it.

const SELECT_WITH_VENDOR = '*, vendor:vendors(name)';

function mapRow(row: any): FixedAsset {
  return {
    id: row.id,
    shopId: row.shop_id,
    locationId: row.location_id ?? null,
    name: row.name,
    category: row.category,
    acquiredOn: row.acquired_on,
    costCents: row.cost_cents,
    salvageValueCents: row.salvage_value_cents ?? 0,
    usefulLifeMonths: row.useful_life_months,
    vendorId: row.vendor_id ?? null,
    vendorName: row.vendor?.name ?? null,
    reference: row.reference ?? null,
    notes: row.notes ?? null,
    disposedOn: row.disposed_on ?? null,
    disposalProceedsCents: row.disposal_proceeds_cents ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toRow(input: Partial<NewFixedAssetInput>) {
  return {
    ...(input.locationId !== undefined && { location_id: input.locationId }),
    ...(input.name !== undefined && { name: input.name.trim() }),
    ...(input.category !== undefined && { category: input.category }),
    ...(input.acquiredOn !== undefined && { acquired_on: input.acquiredOn }),
    ...(input.costCents !== undefined && { cost_cents: input.costCents }),
    ...(input.salvageValueCents !== undefined && { salvage_value_cents: input.salvageValueCents }),
    ...(input.usefulLifeMonths !== undefined && { useful_life_months: input.usefulLifeMonths }),
    ...(input.vendorId !== undefined && { vendor_id: input.vendorId }),
    ...(input.reference !== undefined && { reference: input.reference }),
    ...(input.notes !== undefined && { notes: input.notes }),
    ...(input.disposedOn !== undefined && { disposed_on: input.disposedOn }),
    ...(input.disposalProceedsCents !== undefined && { disposal_proceeds_cents: input.disposalProceedsCents }),
  };
}

/**
 * The whole register, disposed assets included.
 *
 * All of it, always, and with no date filter: an asset bought four years ago
 * is still on today's balance sheet, so "the assets in this range" is not a
 * question the register can answer. The reporting date is applied by
 * `assetRegister` on the client, which is also what decides whether a disposal
 * has happened yet.
 */
export async function listFixedAssets(shopId: string): Promise<FixedAsset[]> {
  const { data, error } = await supabase
    .from('fixed_assets')
    .select(SELECT_WITH_VENDOR)
    .eq('shop_id', shopId)
    .order('acquired_on', { ascending: false })
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data ?? []).map(mapRow);
}

export async function createFixedAsset(shopId: string, input: NewFixedAssetInput): Promise<FixedAsset> {
  const { data: userData } = await supabase.auth.getUser();
  const { data, error } = await supabase
    .from('fixed_assets')
    .insert({ shop_id: shopId, ...toRow(input), created_by: userData.user?.id ?? null })
    .select(SELECT_WITH_VENDOR)
    .single();
  if (error) throw error;
  return mapRow(data);
}

export async function updateFixedAsset(id: string, patch: Partial<NewFixedAssetInput>): Promise<void> {
  const { data: userData } = await supabase.auth.getUser();
  const { error } = await supabase
    .from('fixed_assets')
    .update({ ...toRow(patch), updated_at: new Date().toISOString(), updated_by: userData.user?.id ?? null })
    .eq('id', id);
  if (error) throw error;
}

/**
 * Retires an asset. An ordinary update, not an RPC -- see the migration for
 * why there is nothing here to make atomic.
 *
 * Proceeds of zero are written as zero rather than left null: "scrapped for
 * nothing" and "nobody said what it fetched" are different facts, and the
 * disposal result depends on which one it was.
 */
export async function disposeFixedAsset(
  id: string,
  disposedOn: string,
  proceedsCents: number
): Promise<void> {
  await updateFixedAsset(id, { disposedOn, disposalProceedsCents: proceedsCents });
}

export async function deleteFixedAsset(id: string): Promise<void> {
  const { error } = await supabase.from('fixed_assets').delete().eq('id', id);
  if (error) throw error;
}
