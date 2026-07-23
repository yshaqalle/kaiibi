import { buildSalePayload, cartTotalCents } from '@/lib/cart';
import { supabase } from '@/lib/supabase';
import type { CartLine, PaymentLine, Sale, SaleEdit, SaleItem, SaleItemSnapshot, SalePayment } from '@/types/models';

export async function completeSale(shopId: string, lines: CartLine[], payments: PaymentLine[]): Promise<string> {
  if (lines.length === 0) throw new Error('Cart is empty');
  if (payments.length === 0) throw new Error('At least one payment is required');
  const { data, error } = await supabase.rpc('complete_sale', {
    p_shop_id: shopId,
    p_items: buildSalePayload(lines),
    p_payments: buildPaymentPayload(payments),
  });
  if (error) throw error;
  return data as string;
}

// Editing doesn't need full `Product` objects for existing line items (only
// the product id + quantity), so it takes a lighter shape than `CartLine[]`
// — that lets the edit UI reuse existing sale items without re-fetching
// their full product record just to satisfy `CartLine`'s type.
export async function editSale(saleId: string, items: { productId: string; quantity: number }[], payments: PaymentLine[]): Promise<void> {
  if (items.length === 0) throw new Error('A sale must have at least one item');
  if (payments.length === 0) throw new Error('At least one payment is required');
  const { error } = await supabase.rpc('edit_sale', {
    p_sale_id: saleId,
    p_items: items.map((item) => ({ product_id: item.productId, quantity: item.quantity })),
    p_payments: buildPaymentPayload(payments),
  });
  if (error) throw error;
}

// Restores the stock the sale had deducted — see migration 0006.
export async function deleteSale(saleId: string): Promise<void> {
  const { error } = await supabase.rpc('delete_sale', { p_sale_id: saleId });
  if (error) throw error;
}

function buildPaymentPayload(payments: PaymentLine[]) {
  return payments.map((p) => ({
    method: p.method,
    amount_cents: p.amountCents,
    tendered_cents: p.tenderedCents,
    customer_name: p.customerName,
    customer_phone: p.customerPhone,
  }));
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
    edits: (row.sale_edits ?? [])
      .map((edit: any): SaleEdit => ({
        id: edit.id,
        saleId: edit.sale_id,
        editedBy: edit.edited_by,
        createdAt: edit.created_at,
        previousSnapshot: {
          totalCents: edit.previous_snapshot.total_cents,
          itemCount: edit.previous_snapshot.item_count,
          paymentMethod: edit.previous_snapshot.payment_method,
          items: (edit.previous_snapshot.items ?? []).map((item: any): SaleItemSnapshot => ({
            productId: item.product_id,
            productName: item.product_name,
            unitPriceCents: item.unit_price_cents,
            quantity: item.quantity,
            lineTotalCents: item.line_total_cents,
          })),
          payments: (edit.previous_snapshot.payments ?? []).map((payment: any): PaymentLine => ({
            method: payment.method,
            amountCents: payment.amount_cents,
            tenderedCents: payment.tendered_cents,
            customerName: payment.customer_name,
            customerPhone: payment.customer_phone,
          })),
        },
      }))
      .sort((a: SaleEdit, b: SaleEdit) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()),
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

// Powers the Sales screen: a date-bounded (default last 14 days), fuller
// fetch that also includes each sale's edit history. Kept separate from
// `listSales` (used by the dashboard's rolling daily-totals calculation)
// since that call doesn't need edit history and a shop with a long history
// shouldn't pay for fetching it on every dashboard load.
export async function listSalesInRange(shopId: string, sinceDate: Date, untilDate?: Date, limit = 300): Promise<Sale[]> {
  let query = supabase
    .from('sales')
    .select('*, sale_items(*), sale_payments(*), sale_edits(*)')
    .eq('shop_id', shopId)
    .gte('created_at', sinceDate.toISOString())
    .order('created_at', { ascending: false })
    .limit(limit);
  if (untilDate) query = query.lte('created_at', untilDate.toISOString());
  const { data, error } = await query;
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
