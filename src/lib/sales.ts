import { buildSalePayload, cartTotalCents } from '@/lib/cart';
import { supabase } from '@/lib/supabase';
import type { CartLine, PaymentLine, PaymentMethod, Promotion, Sale, SaleEdit, SaleItem, SaleItemSnapshot, SalePayment } from '@/types/models';

export type SaleCustomer = { id?: string | null; name?: string | null; phone?: string | null; email?: string | null };

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
    p_customer_id: customer?.id ?? null,
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
    p_customer_id: customer?.id ?? null,
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
    currency_code: p.currencyCode,
    exchange_rate: p.exchangeRate,
    foreign_amount_cents: p.foreignAmountCents,
    foreign_change_cents: p.foreignChangeCents,
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
    customerId: row.customer_id,
    cashierName: row.cashier_name,
    discountCents: row.discount_cents ?? 0,
    taxCents: row.tax_cents ?? 0,
    taxRatePercent: row.tax_rate_percent !== null && row.tax_rate_percent !== undefined ? Number(row.tax_rate_percent) : null,
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
        currencyCode: payment.currency_code,
        exchangeRate: payment.exchange_rate !== null && payment.exchange_rate !== undefined ? Number(payment.exchange_rate) : null,
        foreignAmountCents: payment.foreign_amount_cents,
        foreignChangeCents: payment.foreign_change_cents,
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
            currencyCode: payment.currency_code ?? null,
            exchangeRate: payment.exchange_rate !== null && payment.exchange_rate !== undefined ? Number(payment.exchange_rate) : null,
            foreignAmountCents: payment.foreign_amount_cents ?? null,
            foreignChangeCents: payment.foreign_change_cents ?? null,
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
function salesInRangeQuery(shopId: string, sinceDate: Date, untilDate?: Date) {
  let query = supabase
    .from('sales')
    .select('*, sale_items(*), sale_payments(*), sale_edits(*)')
    .eq('shop_id', shopId)
    .gte('created_at', sinceDate.toISOString())
    .order('created_at', { ascending: false });
  if (untilDate) query = query.lte('created_at', untilDate.toISOString());
  return query;
}

export async function listSalesInRange(shopId: string, sinceDate: Date, untilDate?: Date, limit = 300): Promise<Sale[]> {
  const { data, error } = await salesInRangeQuery(shopId, sinceDate, untilDate).limit(limit);
  if (error) throw error;
  return (data ?? []).map(mapSaleRow);
}

// PostgREST caps any unbounded select at a server-side default (1000 rows),
// so a plain `.select()` silently truncates once a shop has more matching
// rows than that -- fine for a bounded "recent sales" list, but not for
// anything computing a total over the whole range. Pages through with
// `.range()` instead of trusting a single fetch to be complete.
const PAGE_SIZE = 1000;

async function fetchAllRows<T>(runPage: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>): Promise<T[]> {
  const all: T[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await runPage(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    const rows = data ?? [];
    all.push(...rows);
    if (rows.length < PAGE_SIZE) break;
  }
  return all;
}

// Used by the dashboard's aggregate functions below, which need to see
// every sale in range rather than a capped/recent slice.
async function listAllSalesInRange(shopId: string, sinceDate: Date, untilDate?: Date): Promise<Sale[]> {
  const rows = await fetchAllRows<any>((from, to) => salesInRangeQuery(shopId, sinceDate, untilDate).range(from, to));
  return rows.map(mapSaleRow);
}

// Returns products ranked both ways from a single query — the dashboard's
// ranking chart switches between them instantly (no refetch) since a product
// popular by units isn't necessarily the one bringing in the most revenue.
export async function getTopSellingProducts(shopId: string, sinceDate: Date, untilDate?: Date) {
  const rows = await fetchAllRows<{ product_name: string; quantity: number; line_total_cents: number }>((from, to) => {
    let query = supabase
      .from('sale_items')
      .select('product_name, quantity, line_total_cents, sales!inner(shop_id, created_at)')
      .eq('sales.shop_id', shopId)
      .gte('sales.created_at', sinceDate.toISOString());
    if (untilDate) query = query.lte('sales.created_at', untilDate.toISOString());
    return query.range(from, to) as unknown as PromiseLike<{ data: { product_name: string; quantity: number; line_total_cents: number }[] | null; error: unknown }>;
  });

  const totals = new Map<string, { quantitySold: number; revenueCents: number }>();
  for (const row of rows) {
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
  const sales = await listAllSalesInRange(shopId, sinceDate, untilDate);
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
  const sales = await listAllSalesInRange(shopId, sinceDate, untilDate);
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
// viewer switch which of the three series is plotted without a refetch.
export async function getDailyTotalsCents(shopId: string, sinceDate: Date, untilDate?: Date) {
  const since = new Date(sinceDate);
  since.setHours(0, 0, 0, 0);
  const until = untilDate ? new Date(untilDate) : new Date();
  const dayCount = Math.max(1, Math.floor((until.getTime() - since.getTime()) / 86_400_000) + 1);
  const sales = await listAllSalesInRange(shopId, since, untilDate);
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

type SaleItemCategoryRow = { quantity: number; line_total_cents: number; products: { category: string | null } | null; sales: { created_at: string } };

async function fetchSaleItemsWithCategory(shopId: string, sinceDate: Date, untilDate?: Date): Promise<SaleItemCategoryRow[]> {
  return fetchAllRows<SaleItemCategoryRow>((from, to) => {
    let query = supabase
      .from('sale_items')
      .select('quantity, line_total_cents, products(category), sales!inner(shop_id, created_at)')
      .eq('sales.shop_id', shopId)
      .gte('sales.created_at', sinceDate.toISOString());
    if (untilDate) query = query.lte('sales.created_at', untilDate.toISOString());
    return query.range(from, to) as unknown as PromiseLike<{ data: SaleItemCategoryRow[] | null; error: unknown }>;
  });
}

// Units sold per product category over the range, for the dashboard's
// category donut. Line items whose product was deleted (`product_id` set
// null on delete) or was never categorized fall into "Uncategorized" rather
// than being dropped.
export async function getCategoryBreakdown(shopId: string, sinceDate: Date, untilDate?: Date) {
  const rows = await fetchSaleItemsWithCategory(shopId, sinceDate, untilDate);
  const totals = new Map<string, { unitsSold: number; revenueCents: number }>();
  for (const row of rows) {
    const category = row.products?.category ?? 'Uncategorized';
    const current = totals.get(category) ?? { unitsSold: 0, revenueCents: 0 };
    current.unitsSold += row.quantity;
    current.revenueCents += row.line_total_cents;
    totals.set(category, current);
  }
  return Array.from(totals.entries())
    .map(([category, totalsForCategory]) => ({ category, ...totalsForCategory }))
    .sort((a, b) => b.unitsSold - a.unitsSold);
}

// Revenue per product category, bucketed by calendar month across the
// range — powers the stacked-bar "revenue by category over time" chart.
// Only the top 3 categories (by total revenue across the whole range) get
// their own segment; the rest fold into "Other" so the chart never grows a
// 5th+ series (see dataviz series-count ladder).
export async function getCategoryRevenueByMonth(shopId: string, sinceDate: Date, untilDate?: Date) {
  const rows = await fetchSaleItemsWithCategory(shopId, sinceDate, untilDate);
  const until = untilDate ?? new Date();

  const categoryTotals = new Map<string, number>();
  const perMonth = new Map<string, Map<string, number>>();
  for (const row of rows) {
    const category = row.products?.category ?? 'Uncategorized';
    const created = new Date(row.sales.created_at);
    const monthKey = `${created.getFullYear()}-${created.getMonth()}`;
    categoryTotals.set(category, (categoryTotals.get(category) ?? 0) + row.line_total_cents);
    if (!perMonth.has(monthKey)) perMonth.set(monthKey, new Map());
    const monthMap = perMonth.get(monthKey)!;
    monthMap.set(category, (monthMap.get(category) ?? 0) + row.line_total_cents);
  }

  const topCategories = Array.from(categoryTotals.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([category]) => category);

  const months: { key: string; label: string }[] = [];
  const cursor = new Date(sinceDate.getFullYear(), sinceDate.getMonth(), 1);
  const end = new Date(until.getFullYear(), until.getMonth(), 1);
  while (cursor <= end) {
    months.push({ key: `${cursor.getFullYear()}-${cursor.getMonth()}`, label: cursor.toLocaleDateString(undefined, { month: 'short' }) });
    cursor.setMonth(cursor.getMonth() + 1);
  }

  return months.map((month) => {
    const monthMap = perMonth.get(month.key) ?? new Map<string, number>();
    const otherCents = Array.from(monthMap.entries())
      .filter(([category]) => !topCategories.includes(category))
      .reduce((sum, [, cents]) => sum + cents, 0);
    return {
      label: month.label,
      segments: [
        ...topCategories.map((category) => ({ category, revenueCents: monthMap.get(category) ?? 0 })),
        ...(otherCents > 0 ? [{ category: 'Other', revenueCents: otherCents }] : []),
      ],
    };
  });
}

// This calendar month's revenue to date, for the dashboard's goal meter —
// deliberately independent of the dashboard's own date-range selector, since
// a monthly goal is always measured against the current calendar month.
export async function getMonthToDateRevenueCents(shopId: string): Promise<number> {
  const since = new Date();
  since.setDate(1);
  since.setHours(0, 0, 0, 0);
  const sales = await listAllSalesInRange(shopId, since, undefined);
  return sales.reduce((sum, sale) => sum + sale.totalCents, 0);
}
