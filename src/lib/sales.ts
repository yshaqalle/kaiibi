import { buildSalePayload, cartTotalCents } from '@/lib/cart';
import { supabase } from '@/lib/supabase';
import type { CartLine, PaymentLine, PaymentMethod, Promotion, Sale, SaleEdit, SaleItem, SaleItemSnapshot, SalePayment } from '@/types/models';

export type SaleCustomer = { name?: string | null; phone?: string | null; email?: string | null };

export async function completeSale(
  shopId: string,
  lines: CartLine[],
  payments: PaymentLine[],
  customer?: SaleCustomer,
  cashierName?: string | null,
  promotions: Promotion[] = [],
  transactionDiscountCents = 0
): Promise<string> {
  if (lines.length === 0) throw new Error('Cart is empty');
  if (payments.length === 0) throw new Error('At least one payment is required');
  const { data, error } = await supabase.rpc('complete_sale', {
    p_shop_id: shopId,
    p_items: buildSalePayload(lines, promotions),
    p_payments: buildPaymentPayload(payments),
    p_customer_name: customer?.name ?? null,
    p_customer_phone: customer?.phone ?? null,
    p_customer_email: customer?.email ?? null,
    p_cashier_name: cashierName ?? null,
    p_discount_cents: transactionDiscountCents,
  });
  if (error) throw error;
  return data as string;
}

// Editing doesn't need full `Product` objects for existing line items (only
// the product id + quantity), so it takes a lighter shape than `CartLine[]`
// — that lets the edit UI reuse existing sale items without re-fetching
// their full product record just to satisfy `CartLine`'s type. `discountCents`
// per item is carried through unchanged from the original sale (the editor
// doesn't currently offer a way to change discounts, only quantities/items).
export async function editSale(
  saleId: string,
  items: { productId: string; quantity: number; discountCents?: number }[],
  payments: PaymentLine[],
  customer?: SaleCustomer,
  transactionDiscountCents = 0
): Promise<void> {
  if (items.length === 0) throw new Error('A sale must have at least one item');
  if (payments.length === 0) throw new Error('At least one payment is required');
  const { error } = await supabase.rpc('edit_sale', {
    p_sale_id: saleId,
    p_items: items.map((item) => ({ product_id: item.productId, quantity: item.quantity, discount_cents: item.discountCents ?? 0 })),
    p_payments: buildPaymentPayload(payments),
    p_customer_name: customer?.name ?? null,
    p_customer_phone: customer?.phone ?? null,
    p_customer_email: customer?.email ?? null,
    p_discount_cents: transactionDiscountCents,
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
    customerName: row.customer_name,
    customerPhone: row.customer_phone,
    customerEmail: row.customer_email,
    cashierName: row.cashier_name,
    discountCents: row.discount_cents ?? 0,
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
        discountCents: item.discount_cents ?? 0,
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
          customerName: edit.previous_snapshot.customer_name ?? null,
          customerPhone: edit.previous_snapshot.customer_phone ?? null,
          customerEmail: edit.previous_snapshot.customer_email ?? null,
          discountCents: edit.previous_snapshot.discount_cents ?? 0,
          items: (edit.previous_snapshot.items ?? []).map((item: any): SaleItemSnapshot => ({
            productId: item.product_id,
            productName: item.product_name,
            unitPriceCents: item.unit_price_cents,
            quantity: item.quantity,
            lineTotalCents: item.line_total_cents,
            discountCents: item.discount_cents ?? 0,
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

// Powers the Sales screen (date-bounded, default last 14 days) and the
// dashboard's range-scoped aggregates — a fuller fetch that also includes
// each sale's edit history. Kept separate from `listSales` (used for a plain
// most-recent-N fetch, e.g. the dashboard's "recent transactions" list) since
// that caller doesn't need edit history.
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

// Returns products ranked both ways from a single query — the dashboard's
// ranking chart switches between them instantly (no refetch) since a product
// popular by units isn't necessarily the one bringing in the most revenue.
export async function getTopSellingProducts(shopId: string, sinceDate: Date, untilDate?: Date) {
  let query = supabase
    .from('sale_items')
    .select('product_name, quantity, line_total_cents, sales!inner(shop_id, created_at)')
    .eq('sales.shop_id', shopId)
    .gte('sales.created_at', sinceDate.toISOString());
  if (untilDate) query = query.lte('sales.created_at', untilDate.toISOString());
  const { data, error } = await query;
  if (error) throw error;

  const totals = new Map<string, { quantitySold: number; revenueCents: number }>();
  for (const row of data ?? []) {
    const current = totals.get(row.product_name) ?? { quantitySold: 0, revenueCents: 0 };
    current.quantitySold += row.quantity;
    current.revenueCents += row.line_total_cents;
    totals.set(row.product_name, current);
  }
  const ranked = Array.from(totals.entries()).map(([name, totalsForName]) => ({ name, ...totalsForName }));
  return {
    byRevenue: [...ranked].sort((a, b) => b.revenueCents - a.revenueCents).slice(0, 5),
    byUnits: [...ranked].sort((a, b) => b.quantitySold - a.quantitySold).slice(0, 5),
  };
}

// Revenue per cashier over the range, for the ranking chart's "Cashiers"
// view. Sales rung up without a cashier assigned are excluded from the
// ranking rather than lumped into an "Unassigned" bar.
export async function getCashierPerformance(shopId: string, sinceDate: Date, untilDate?: Date) {
  const sales = await listSalesInRange(shopId, sinceDate, untilDate, 1000);
  const totals = new Map<string, number>();
  for (const sale of sales) {
    if (!sale.cashierName) continue;
    totals.set(sale.cashierName, (totals.get(sale.cashierName) ?? 0) + sale.totalCents);
  }
  return Array.from(totals.entries())
    .map(([name, revenueCents]) => ({ name, revenueCents }))
    .sort((a, b) => b.revenueCents - a.revenueCents)
    .slice(0, 5);
}

// Amount and share of revenue per payment method over the range, for the
// payment-mix chart. Multi-line (split) payments are summed by their own
// method rather than attributed whole to the sale's top-level method.
export async function getPaymentMethodMix(shopId: string, sinceDate: Date, untilDate?: Date) {
  const sales = await listSalesInRange(shopId, sinceDate, untilDate, 1000);
  const totals = new Map<PaymentMethod, number>();
  for (const sale of sales) {
    if (sale.payments && sale.payments.length > 0) {
      for (const payment of sale.payments) {
        totals.set(payment.method, (totals.get(payment.method) ?? 0) + payment.amountCents);
      }
    } else {
      totals.set(sale.paymentMethod, (totals.get(sale.paymentMethod) ?? 0) + sale.totalCents);
    }
  }
  const grandTotal = Array.from(totals.values()).reduce((sum, cents) => sum + cents, 0);
  return Array.from(totals.entries())
    .map(([method, amountCents]) => ({ method, amountCents, pct: grandTotal > 0 ? (amountCents / grandTotal) * 100 : 0 }))
    .sort((a, b) => b.amountCents - a.amountCents);
}

// Daily revenue/order/discount buckets between sinceDate and untilDate
// (defaults to now) — powers the dashboard's trend chart, which lets the
// owner switch which of the three series is plotted without a refetch.
export async function getDailyTotalsCents(shopId: string, sinceDate: Date, untilDate?: Date) {
  const since = new Date(sinceDate);
  since.setHours(0, 0, 0, 0);
  const until = untilDate ? new Date(untilDate) : new Date();
  const dayCount = Math.max(1, Math.floor((until.getTime() - since.getTime()) / 86_400_000) + 1);
  const sales = await listSalesInRange(shopId, since, untilDate, dayCount <= 7 ? 500 : 1000);
  const buckets = new Map<string, { totalCents: number; orderCount: number; discountCents: number }>();
  for (let i = 0; i < dayCount; i++) {
    const day = new Date(since); day.setDate(since.getDate() + i);
    buckets.set(day.toDateString(), { totalCents: 0, orderCount: 0, discountCents: 0 });
  }
  for (const sale of sales) {
    const key = new Date(sale.createdAt).toDateString();
    const bucket = buckets.get(key);
    if (bucket) {
      bucket.totalCents += sale.totalCents;
      bucket.orderCount += 1;
      bucket.discountCents += sale.discountCents + (sale.items ?? []).reduce((sum, item) => sum + item.discountCents, 0);
    }
  }
  return Array.from(buckets.entries()).map(([day, bucket]) => ({ day, ...bucket }));
}
