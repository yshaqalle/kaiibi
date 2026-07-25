import { supabase } from '@/lib/supabase';
import type { Promotion } from '@/types/models';

function mapPromotionRow(row: any): Promotion {
  return {
    id: row.id,
    shopId: row.shop_id,
    name: row.name,
    discountType: row.discount_type,
    discountValue: row.discount_value,
    scope: row.scope,
    scopeValue: row.scope_value,
    active: row.active,
    createdAt: row.created_at,
  };
}

export async function listPromotions(shopId: string): Promise<Promotion[]> {
  const { data, error } = await supabase
    .from('promotions')
    .select('*')
    .eq('shop_id', shopId)
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
    })
    .eq('id', id)
    .select('*')
    .single();
  if (error) throw error;
  return mapPromotionRow(data);
}

export async function deletePromotion(id: string): Promise<void> {
  const { error } = await supabase.from('promotions').delete().eq('id', id);
  if (error) throw error;
}
