import { buildSalePayload, cartTotalCents } from '@/lib/cart';
import { containsPattern, orFilterValue } from '@/lib/like-pattern';
import { endOfDay, startOfDay } from '@/lib/period';
import { bucketDailyTotals, netRevenueCents, type DailyBucket, type PeriodRefund } from '@/lib/sales-reporting';
import { supabase } from '@/lib/supabase';
import type { CartLine, PaymentLine, Promotion, Refund, RefundItem, Sale, SaleEdit, SaleItem, SaleItemSnapshot, SalePayment } from '@/types/models';

export type SaleCustomer = { id?: string | null; name?: string | null; phone?: string | null; email?: string | null };

// `locationId` is which branch rang the sale up. Optional at this layer, and
// omitted rather than sent as null when absent: complete_sale falls back to the
// shop's primary location, which is the only correct answer for a
// single-location shop and keeps CSV sales import working unchanged.
export async function completeSale(
  shopId: string,
  lines: CartLine[],
  payments: PaymentLine[],
  customer?: SaleCustomer,
  cashierName?: string | null,
  promotions: Promotion[] = [],
  transactionDiscountCents = 0,
  locationId?: string | null,
  // Loyalty points the customer is spending on this sale. The server re-checks
  // the balance under a row lock and recomputes what they're worth, so this is
  // a request rather than an instruction -- if it no longer fits, the sale is
  // refused rather than quietly rung up for a different amount.
  pointsRedeemed = 0,
  // Which register session rang this up, when one is open. Omitted rather than
  // sent as null when absent, same as `locationId` above -- a shop that never
  // opens a register keeps working exactly as it does today. The server
  // validates that the session is open, belongs to this shop and sits at this
  // location; it is not taken on trust.
  registerSessionId?: string | null,
  // The instant this sale is priced as of. The caller passes the same value it
  // used to compute the total the cashier collected against, so a promotion
  // whose window closes mid-transaction cannot make the payload disagree with
  // the payments -- which the server refuses, at the payment screen, in front
  // of the customer. Defaulted so callers that never showed a total (imports,
  // tests) keep working.
  now: number = Date.now(),
  // Let the payments fall short of the total and carry the difference as a
  // balance against the customer. Off by default, so the server keeps refusing
  // every caller that has not explicitly asked -- which is the whole point of
  // the guard: an under-charge nobody chose is a bug, not a credit. The server
  // also refuses it with no customer attached, so this is a request rather
  // than an instruction.
  allowBalance = false
): Promise<string> {
  if (lines.length === 0) throw new Error('Cart is empty');
  if (payments.length === 0 && !allowBalance) throw new Error('At least one payment is required');
  const { data, error } = await supabase.rpc('complete_sale', {
    p_shop_id: shopId,
    p_items: buildSalePayload(lines, promotions, now),
    p_payments: buildPaymentPayload(payments),
    p_customer_name: customer?.name ?? null,
    p_customer_phone: customer?.phone ?? null,
    p_customer_email: customer?.email ?? null,
    p_cashier_name: cashierName ?? null,
    p_discount_cents: transactionDiscountCents,
    p_customer_id: customer?.id ?? null,
    p_points_redeemed: pointsRedeemed,
    ...(locationId ? { p_location_id: locationId } : {}),
    ...(registerSessionId ? { p_register_session_id: registerSessionId } : {}),
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
// `promotionId`, likewise, is carried through unchanged so re-saving a line
// preserves which offer produced its discount instead of silently detaching
// it -- see migration 20260826000100_sale_promotion_attribution and
// edit_sale's v_existing_promo_ids, which is what lets a promotion that has
// since ended/paused/archived still be re-saved on an old sale.
// `promotion_name` is deliberately NOT sent -- the server re-reads it
// authoritatively from the promotions row rather than trusting client text.
export async function editSale(
  saleId: string,
  items: { productId: string; quantity: number; discountCents?: number; promotionId?: string | null }[],
  payments: PaymentLine[],
  customer?: SaleCustomer,
  transactionDiscountCents = 0
): Promise<void> {
  if (items.length === 0) throw new Error('A sale must have at least one item');
  if (payments.length === 0) throw new Error('At least one payment is required');
  const { error } = await supabase.rpc('edit_sale', {
    p_sale_id: saleId,
    p_items: items.map((item) => ({
      product_id: item.productId,
      quantity: item.quantity,
      discount_cents: item.discountCents ?? 0,
      promotion_id: item.promotionId ?? null,
    })),
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

// Refunds the given quantity of one or more of a sale's items, restoring
// their stock — see refund_sale_items in the refunds migration. Amounts are
// computed server-side (cumulative, to avoid rounding drift across partial
// refunds of the same line); the client only sends quantities. Returns the
// new refund's id.
export async function refundSaleItems(saleId: string, items: { saleItemId: string; quantity: number }[]): Promise<string> {
  if (items.length === 0) throw new Error('Select at least one item to refund');
  const { data, error } = await supabase.rpc('refund_sale_items', {
    p_sale_id: saleId,
    p_items: items.map((i) => ({ sale_item_id: i.saleItemId, quantity: i.quantity })),
  });
  if (error) throw error;
  return data as string;
}

// Exported for balances.ts, which sends the same payment shape to
// settle_sale_balance. Duplicating the mapping would let the two drift, and a
// key this side renames silently arrives at the server as null.
export function buildPaymentPayload(payments: PaymentLine[]) {
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
    locationId: row.location_id,
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
    pointsEarned: row.points_earned ?? 0,
    pointsRedeemed: row.points_redeemed ?? 0,
    pointsRedeemedCents: row.points_redeemed_cents ?? 0,
    loyaltyPointsPerUsd:
      row.loyalty_points_per_usd !== null && row.loyalty_points_per_usd !== undefined ? Number(row.loyalty_points_per_usd) : null,
    totalCents: row.total_cents,
    itemCount: row.item_count,
    createdAt: row.created_at,
    // Left undefined rather than coerced when the column was not selected, so
    // "not loaded" stays distinguishable from "still owed".
    settledAt: row.settled_at,
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
        unitCostCents: item.unit_cost_cents ?? null,
        promotionId: item.promotion_id ?? null,
        promotionName: item.promotion_name ?? null,
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
    refunds: (row.refunds ?? [])
      .map((refund: any): Refund => ({
        id: refund.id,
        saleId: refund.sale_id,
        refundedBy: refund.refunded_by,
        totalCents: refund.total_cents,
        createdAt: refund.created_at,
        items: (refund.refund_items ?? []).map((ri: any): RefundItem => ({
          id: ri.id,
          refundId: ri.refund_id,
          saleItemId: ri.sale_item_id,
          productId: ri.product_id,
          quantity: ri.quantity,
          amountCents: ri.amount_cents,
        })),
      }))
      .sort((a: Refund, b: Refund) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()),
  };
}

// `locationId` narrows to one branch; omitted means every location, which is
// both the pre-multi-location behaviour and what the "All locations" view wants.
// Filtered in the query rather than after fetching so a shop with several busy
// branches doesn't pull the other branches' rows over the wire to discard them.
export async function listSales(shopId: string, limit = 50, locationId?: string | null): Promise<Sale[]> {
  let query = supabase
    .from('sales')
    .select('*, sale_items(*), sale_payments(*)')
    .eq('shop_id', shopId);
  if (locationId) query = query.eq('location_id', locationId);
  const { data, error } = await query.order('created_at', { ascending: false }).limit(limit);
  if (error) throw error;
  return (data ?? []).map(mapSaleRow);
}

// Type-ahead for global search.
//
// Matches the frozen customer name on the sale rather than the linked customer
// record: a walk-in sale has a typed name and no customer id, and that sale is
// exactly the one someone is trying to find again. Sale ITEMS are not searched
// -- finding "every sale containing rice" is a report, and Accounting →
// Transactions is where it belongs.
export async function searchSales(shopId: string, query: string, locationId?: string | null): Promise<Sale[]> {
  const q = query.trim();
  if (q.length < 2) return [];
  // Quoted for the `or` list -- a customer name with a comma in it would
  // otherwise break the filter rather than match. See orFilterValue.
  const pattern = orFilterValue(containsPattern(q));
  let request = supabase
    .from('sales')
    .select('*, sale_items(*), sale_payments(*)')
    .eq('shop_id', shopId)
    .or(`customer_name.ilike.${pattern},customer_phone.ilike.${pattern},cashier_name.ilike.${pattern}`);
  if (locationId) request = request.eq('location_id', locationId);
  const { data, error } = await request.order('created_at', { ascending: false }).limit(6);
  if (error) throw error;
  return (data ?? []).map(mapSaleRow);
}

// Powers the Sales screen (date-bounded, default last 14 days) and the
// dashboard's range-scoped aggregates — a fuller fetch that also includes
// each sale's edit history. Kept separate from `listSales` (used for a plain
// most-recent-N fetch, e.g. the dashboard's "recent transactions" list) since
// that caller doesn't need edit history.
function salesInRangeQuery(shopId: string, sinceDate: Date, untilDate?: Date, locationId?: string | null) {
  let query = supabase
    .from('sales')
    .select('*, sale_items(*), sale_payments(*), sale_edits(*), refunds(*, refund_items(*))')
    .eq('shop_id', shopId)
    .gte('created_at', sinceDate.toISOString())
    .order('created_at', { ascending: false });
  if (untilDate) query = query.lte('created_at', untilDate.toISOString());
  if (locationId) query = query.eq('location_id', locationId);
  return query;
}

export async function listSalesInRange(
  shopId: string,
  sinceDate: Date,
  untilDate?: Date,
  limit = 300,
  locationId?: string | null
): Promise<Sale[]> {
  const { data, error } = await salesInRangeQuery(shopId, sinceDate, untilDate, locationId).limit(limit);
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
async function listAllSalesInRange(shopId: string, sinceDate: Date, untilDate?: Date, locationId?: string | null): Promise<Sale[]> {
  const rows = await fetchAllRows<any>((from, to) => salesInRangeQuery(shopId, sinceDate, untilDate, locationId).range(from, to));
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



// Daily revenue/order/discount buckets between sinceDate and untilDate
// (defaults to now) — powers the dashboard's trend chart, which lets the
// viewer switch which of the three series is plotted without a refetch.
// Refunds that *happened* in the range, whatever period the original sale
// belongs to -- so reversing them never restates a closed month. Carries each
// line's frozen unit cost so COGS can be reversed alongside the revenue.
// `locationId` narrows through the parent sale, using the inner join that is
// already here. Deliberately NOT filtered in memory against the fetched sales:
// a refund inside the range can belong to a sale from before it, and matching
// on the fetched ids would silently drop exactly those.
async function listRefundsInRange(shopId: string, sinceDate: Date, untilDate?: Date, locationId?: string | null): Promise<PeriodRefund[]> {
  type RefundRow = {
    id: string;
    created_at: string;
    total_cents: number;
    // The parent sale was already joined to scope by shop; its total and tax
    // ride along so the refund's revenue share can be split out of what the
    // customer was handed. See PeriodRefund.
    sales: { total_cents: number; tax_cents: number } | null;
    refund_items: { quantity: number; sale_items: { unit_cost_cents: number | null } | null }[] | null;
  };
  const rows = await fetchAllRows<RefundRow>((from, to) => {
    let query = supabase
      .from('refunds')
      .select('id, created_at, total_cents, refund_items(quantity, sale_items(unit_cost_cents)), sales!inner(shop_id, total_cents, tax_cents)')
      .eq('sales.shop_id', shopId)
      .gte('created_at', startOfDay(sinceDate).toISOString());
    if (locationId) query = query.eq('sales.location_id', locationId);
    if (untilDate) query = query.lte('created_at', endOfDay(untilDate).toISOString());
    return query.range(from, to) as unknown as PromiseLike<{ data: RefundRow[] | null; error: unknown }>;
  });
  return rows.map((row) => ({
    id: row.id,
    createdAt: row.created_at,
    totalCents: row.total_cents,
    // Zero when the parent somehow didn't come back: refundPreTaxCents then
    // treats the refund as wholly revenue, which is the pre-tax-shop answer
    // and the safe direction -- it never inflates revenue.
    saleTotalCents: row.sales?.total_cents ?? 0,
    saleTaxCents: row.sales?.tax_cents ?? 0,
    items: (row.refund_items ?? []).map((item) => ({
      quantity: item.quantity,
      unitCostCents: item.sale_items?.unit_cost_cents ?? null,
    })),
  }));
}

// Sales and refunds for a range, fetched once.
//
// The sales query pulls five nested relations (items, payments, edits,
// refunds and their items), so it is by far the heaviest read in the app.
// Screens that need several aggregates should take this and derive them with
// the pure helpers in sales-reporting.ts rather than calling three functions
// that each refetch the same rows.
export async function getSalesAndRefundsInRange(
  shopId: string,
  sinceDate: Date,
  untilDate?: Date,
  locationId?: string | null
): Promise<{ sales: Sale[]; refunds: PeriodRefund[] }> {
  const [sales, refunds] = await Promise.all([
    listAllSalesInRange(shopId, startOfDay(sinceDate), untilDate, locationId),
    listRefundsInRange(shopId, sinceDate, untilDate, locationId),
  ]);
  return { sales, refunds };
}

// Per-day revenue for the trend chart and the period stat tiles.
//
// `netRevenueCents` is the figure to report as "revenue": gross minus the sales
// tax held on the government's behalf, minus refunds. `grossCents` is kept on
// each bucket for anything that genuinely wants takings rather than earnings.
// `locationId` null/undefined means the combined business view, matching
// scopeToLocation in lib/location-reporting.ts. Both underlying queries already
// took a location; this simply stopped dropping it on the floor, which is what
// let the Dashboard show one branch's goal directly beneath every branch's
// revenue.
export async function getDailyTotalsCents(
  shopId: string,
  sinceDate: Date,
  untilDate?: Date,
  locationId?: string | null
): Promise<DailyBucket[]> {
  const [sales, refunds] = await Promise.all([
    listAllSalesInRange(shopId, startOfDay(sinceDate), untilDate, locationId),
    listRefundsInRange(shopId, sinceDate, untilDate, locationId),
  ]);
  return bucketDailyTotals(sales, refunds, sinceDate, untilDate);
}


type SaleItemProductRow = {
  quantity: number;
  line_total_cents: number;
  // The cost frozen at sale time, not products.cost_cents -- see the
  // sale-item cost snapshot migration for why the live value must not be used
  // for anything historical.
  unit_cost_cents: number | null;
  products: { category: string | null } | null;
  sales: { created_at: string };
};

async function fetchSaleItemsWithProductInfo(shopId: string, sinceDate: Date, untilDate?: Date): Promise<SaleItemProductRow[]> {
  return fetchAllRows<SaleItemProductRow>((from, to) => {
    let query = supabase
      .from('sale_items')
      .select('quantity, line_total_cents, unit_cost_cents, products(category), sales!inner(shop_id, created_at)')
      .eq('sales.shop_id', shopId)
      .gte('sales.created_at', sinceDate.toISOString());
    if (untilDate) query = query.lte('sales.created_at', untilDate.toISOString());
    return query.range(from, to) as unknown as PromiseLike<{ data: SaleItemProductRow[] | null; error: unknown }>;
  });
}

// Units sold per product category over the range, for the dashboard's
// category donut. Line items whose product was deleted (`product_id` set
// null on delete) or was never categorized fall into "Uncategorized" rather
// than being dropped.
export async function getCategoryBreakdown(shopId: string, sinceDate: Date, untilDate?: Date) {
  const rows = await fetchSaleItemsWithProductInfo(shopId, sinceDate, untilDate);
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
  const rows = await fetchSaleItemsWithProductInfo(shopId, sinceDate, untilDate);
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
// `locationId` scopes this to one store, which the goal meter needs: the goal
// belongs to a store (migration 20260813000000), so measuring it against every
// store's combined takings would report a kiosk as hitting a flagship's target.
// Revenue proper, on the same terms as every other figure with that name:
// excluding tax, net of refunds.
//
// It used to sum `totalCents` raw -- tax included, refunds ignored entirely --
// which put two different "month to date" figures on one Dashboard. The goal
// ring and the pace card read this one; `open-hours-card` computes its own
// from `netRevenueCents` over the month's buckets. Same words, same screen,
// numbers that could not agree.
//
// Consequence worth stating: goal progress drops for a tax-charging shop, by
// the tax, and by any refunds. That is the shop's actual revenue against its
// goal, which is what the ring claims to show.
export async function getMonthToDateRevenueCents(shopId: string, locationId?: string | null): Promise<number> {
  const since = new Date();
  since.setDate(1);
  since.setHours(0, 0, 0, 0);
  const [sales, refunds] = await Promise.all([
    listAllSalesInRange(shopId, since, undefined, locationId),
    listRefundsInRange(shopId, since, undefined, locationId),
  ]);
  return netRevenueCents(sales, refunds);
}
