import { buildSalePayload, cartTotalCents } from '@/lib/cart';
import { supabase } from '@/lib/supabase';
import type { CartLine, PaymentMethod } from '@/types/models';

export async function completeSale(
  shopId: string,
  lines: CartLine[],
  paymentMethod: PaymentMethod,
  paymentNote?: string
): Promise<string> {
  if (lines.length === 0) throw new Error('Cart is empty');
  const { data, error } = await supabase.rpc('complete_sale', {
    p_shop_id: shopId,
    p_items: buildSalePayload(lines),
    p_payment_method: paymentMethod,
    p_payment_note: paymentNote ?? null,
  });
  if (error) throw error;
  return data as string;
}

export { cartTotalCents };
