import { buildSalePayload, cartTotalCents } from '@/lib/cart';
import { supabase } from '@/lib/supabase';
import type { CartLine, PaymentLine, Sale, SaleItem, SalePayment } from '@/types/models';

export async function completeSale(shopId: string, lines: CartLine[], payments: PaymentLine[]): Promise<string> {
  if (lines.length === 0) throw new Error('Cart is empty');
  if (payments.length === 0) throw new Error('At least one payment is required');
  const { data, error } = await supabase.rpc('complete_sale', {
    p_shop_id: shopId,
    p_items: buildSalePayload(lines),
    p_payments: payments.map((p) => ({
      method: p.method,
      amount_cents: p.amountCents,
      tendered_cents: p.tenderedCents,
      customer_name: p.customerName,
      customer_phone: p.customerPhone,
    })),
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
    payments: (row.sale_payments ?? []).map(
      (payment: any): SalePayment => ({
        id: payment.id,
        saleId: payment.sale_id,
        method: payment.method,
        amountCents: payment.amount_cents,
        tenderedCents: payment.tendered_cents,
        customerName: payment.customer_name,
        customerPhone: payment.customer_phone,
        createdAt: payment.created_at,
      })
    ),
  };
}

export async function listSales(shopId: string, limit = 50): Promise<Sale[]> {
  const { data, error } = await supabase
    .from('sales')
    .select('*, sale_items(*), sale_payments(*)')
    .eq('shop_id', shopId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []).map(mapSaleRow);
}

export async function getTopSellingProducts(shopId: string, days = 7) {
  const since = new Date();
  since.setDate(since.getDate() - days);
  const { data, error } = await supabase
    .from('sale_items')
    .select('product_name, quantity, line_total_cents, sales!inner(shop_id, created_at)')
    .eq('sales.shop_id', shopId)
    .gte('sales.created_at', since.toISOString());
  if (error) throw error;

  const totals = new Map<string, { quantitySold: number; revenueCents: number }>();
  for (const row of data ?? []) {
    const current = totals.get(row.product_name) ?? { quantitySold: 0, revenueCents: 0 };
    current.quantitySold += row.quantity;
    current.revenueCents += row.line_total_cents;
    totals.set(row.product_name, current);
  }
  return Array.from(totals.entries())
    .map(([name, totalsForName]) => ({ name, ...totalsForName }))
    .sort((a, b) => b.quantitySold - a.quantitySold)
    .slice(0, 5);
}

export async function getDailyTotalsCents(shopId: string, days = 7) {
  const since = new Date();
  since.setDate(since.getDate() - (days - 1));
  since.setHours(0, 0, 0, 0);
  const sales = await listSales(shopId, 500);
  const buckets = new Map<string, { totalCents: number; orderCount: number }>();
  for (let i = 0; i < days; i++) {
    const day = new Date(since); day.setDate(since.getDate() + i);
    buckets.set(day.toDateString(), { totalCents: 0, orderCount: 0 });
  }
  for (const sale of sales) {
    const day = new Date(sale.createdAt);
    if (day < since) continue;
    const key = day.toDateString();
    const bucket = buckets.get(key);
    if (bucket) {
      bucket.totalCents += sale.totalCents;
      bucket.orderCount += 1;
    }
  }
  return Array.from(buckets.entries()).map(([day, bucket]) => ({ day, ...bucket }));
}
