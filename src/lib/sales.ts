import { buildSalePayload, cartTotalCents } from '@/lib/cart';
import { supabase } from '@/lib/supabase';
import type { CartLine, PaymentMethod, Sale, SaleItem } from '@/types/models';

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

function mapSaleRow(row: any): Sale {
  return {
    id: row.id,
    shopId: row.shop_id,
    createdBy: row.created_by,
    paymentMethod: row.payment_method,
    paymentNote: row.payment_note,
    totalCents: row.total_cents,
    itemCount: row.item_count,
    createdAt: row.created_at,
    items: (row.sale_items ?? []).map(
      (item: any): SaleItem => ({
        id: item.id,
        saleId: item.sale_id,
        productId: item.product_id,
        productName: item.product_name,
        unitPriceCents: item.unit_price_cents,
        quantity: item.quantity,
        lineTotalCents: item.line_total_cents,
      })
    ),
  };
}

export async function listSales(shopId: string, limit = 50): Promise<Sale[]> {
  const { data, error } = await supabase
    .from('sales')
    .select('*, sale_items(*)')
    .eq('shop_id', shopId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []).map(mapSaleRow);
}
