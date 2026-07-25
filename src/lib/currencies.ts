import { supabase } from '@/lib/supabase';
import type { Currency } from '@/types/models';

function mapCurrencyRow(row: any): Currency {
  return {
    id: row.id,
    shopId: row.shop_id,
    code: row.code,
    name: row.name,
    symbol: row.symbol,
    rateToUsd: Number(row.rate_to_usd),
    active: row.active,
    createdAt: row.created_at,
  };
}

export async function listCurrencies(shopId: string): Promise<Currency[]> {
  const { data, error } = await supabase
    .from('shop_currencies')
    .select('*')
    .eq('shop_id', shopId)
    .order('code', { ascending: true });
  if (error) throw error;
  return (data ?? []).map(mapCurrencyRow);
}

export async function createCurrency(
  shopId: string,
  input: { code: string; name: string; symbol: string; rateToUsd: number }
): Promise<void> {
  const { error } = await supabase.from('shop_currencies').insert({
    shop_id: shopId,
    code: input.code.toUpperCase(),
    name: input.name,
    symbol: input.symbol,
    rate_to_usd: input.rateToUsd,
  });
  if (error) throw error;
}

// Code is intentionally not editable here — it's the row's stable
// identity (unique per shop, referenced as a plain snapshot string on past
// payments), so changing it would be a rename with no cascading update to
// historical sale_payments rows, unlike renameBrand/renameCategory.
export async function updateCurrency(id: string, input: Partial<{ name: string; symbol: string; rateToUsd: number }>): Promise<void> {
  const { error } = await supabase
    .from('shop_currencies')
    .update({
      ...(input.name !== undefined && { name: input.name }),
      ...(input.symbol !== undefined && { symbol: input.symbol }),
      ...(input.rateToUsd !== undefined && { rate_to_usd: input.rateToUsd }),
    })
    .eq('id', id);
  if (error) throw error;
}

export async function setCurrencyActive(id: string, active: boolean): Promise<void> {
  const { error } = await supabase.from('shop_currencies').update({ active }).eq('id', id);
  if (error) throw error;
}

export async function deleteCurrency(id: string): Promise<void> {
  const { error } = await supabase.from('shop_currencies').delete().eq('id', id);
  if (error) throw error;
}
