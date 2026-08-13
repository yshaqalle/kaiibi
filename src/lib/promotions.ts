import { supabase } from '@/lib/supabase';
import type { Promotion } from '@/types/models';

function mapPromotionRow(row: any): Promotion {
  return {
    id: row.id,
    shopId: row.shop_id,
    locationId: row.location_id ?? null,
    name: row.name,
    discountType: row.discount_type,
    discountValue: row.discount_value,
    scope: row.scope,
    scopeValue: row.scope_value,
    active: row.active,
    startsAt: row.starts_at ?? null,
    endsAt: row.ends_at ?? null,
    autoApply: row.auto_apply ?? true,
    archivedAt: row.archived_at ?? null,
    createdAt: row.created_at,
  };
}

// Archived promotions are excluded here rather than filtered by each caller:
// an archived offer exists only so a past receipt still reads, and every
// screen that lists promotions wants it gone.
export async function listPromotions(shopId: string): Promise<Promotion[]> {
  const { data, error } = await supabase
    .from('promotions')
    .select('*')
    .eq('shop_id', shopId)
    .is('archived_at', null)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data ?? []).map(mapPromotionRow);
}

export type NewPromotionInput = {
  name: string;
  discountType: 'percentage' | 'fixed';
  discountValue: number;
  scope: 'store' | 'brand' | 'category';
  scopeValue: string | null;
  active: boolean;
  startsAt: string | null;
  endsAt: string | null;
  autoApply: boolean;
};

export async function createPromotion(shopId: string, input: NewPromotionInput): Promise<Promotion> {
  const { data, error } = await supabase
    .from('promotions')
    .insert({
      shop_id: shopId,
      name: input.name,
      discount_type: input.discountType,
      discount_value: input.discountValue,
      scope: input.scope,
      scope_value: input.scopeValue,
      active: input.active,
      starts_at: input.startsAt,
      ends_at: input.endsAt,
      auto_apply: input.autoApply,
    })
    .select('*')
    .single();
  if (error) throw error;
  return mapPromotionRow(data);
}

export async function updatePromotion(id: string, input: Partial<NewPromotionInput>): Promise<Promotion> {
  const { data, error } = await supabase
    .from('promotions')
    .update({
      ...(input.name !== undefined && { name: input.name }),
      ...(input.discountType !== undefined && { discount_type: input.discountType }),
      ...(input.discountValue !== undefined && { discount_value: input.discountValue }),
      ...(input.scope !== undefined && { scope: input.scope }),
      ...(input.scopeValue !== undefined && { scope_value: input.scopeValue }),
      ...(input.active !== undefined && { active: input.active }),
      ...(input.startsAt !== undefined && { starts_at: input.startsAt }),
      ...(input.endsAt !== undefined && { ends_at: input.endsAt }),
      ...(input.autoApply !== undefined && { auto_apply: input.autoApply }),
    })
    .eq('id', id)
    .select('*')
    .single();
  if (error) throw error;
  return mapPromotionRow(data);
}

export async function archivePromotion(id: string): Promise<void> {
  const { error } = await supabase
    .from('promotions')
    .update({ archived_at: new Date().toISOString() })
    .eq('id', id);
  if (error) throw error;
}

// Removing a promotion means two different things depending on whether money
// has moved through it: destroy the untouched ones, archive the used ones so
// past sales keep their link. Both the count and the branch live in the
// database, because reading sale_items from here is subject to RLS — a role
// holding settings.access but not sales.view sees no rows, and would hard
// -delete a promotion that had been used on four hundred sales.
export async function deletePromotion(id: string): Promise<'deleted' | 'archived'> {
  const { data, error } = await supabase.rpc('delete_or_archive_promotion', { p_id: id });
  if (error) throw error;
  return data as 'deleted' | 'archived';
}
