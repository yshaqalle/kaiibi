import { keptSpendCents } from '@/lib/sales-reporting';
import { supabase } from '@/lib/supabase';
import type { Customer, CustomerPointsEntry, CustomerPurchase, NewCustomerInput } from '@/types/models';

// A customer is stored as first + optional last name, so every screen that
// shows one has to join them. Lived privately in customer-picker.tsx until
// global search needed the same thing; kept here so a third copy doesn't
// appear, and so "how a customer is named" is answered in one place.
export function customerDisplayName(customer: Pick<Customer, 'firstName' | 'lastName'>): string {
  return [customer.firstName, customer.lastName].filter(Boolean).join(' ');
}

function mapCustomerRow(row: any): Customer {
  return {
    id: row.id,
    shopId: row.shop_id,
    firstName: row.first_name,
    lastName: row.last_name,
    email: row.email,
    phone: row.phone,
    street: row.street,
    city: row.city,
    neighborhood: row.neighborhood,
    tags: row.tags ?? [],
    notes: row.notes,
    // Rides along on the `select('*')` every read here already does, and on
    // pos_search_customers' `setof public.customers` -- so a balance reaches
    // the customer list and the checkout picker with no extra query.
    pointsBalance: row.points_balance ?? 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toRow(input: Partial<NewCustomerInput>) {
  return {
    ...(input.firstName !== undefined && { first_name: input.firstName }),
    ...(input.lastName !== undefined && { last_name: input.lastName }),
    ...(input.email !== undefined && { email: input.email }),
    ...(input.phone !== undefined && { phone: input.phone }),
    ...(input.street !== undefined && { street: input.street }),
    ...(input.city !== undefined && { city: input.city }),
    ...(input.neighborhood !== undefined && { neighborhood: input.neighborhood }),
    ...(input.tags !== undefined && { tags: input.tags }),
    ...(input.notes !== undefined && { notes: input.notes }),
  };
}

// PostgREST caps any unbounded select at a server-side default (1000 rows) --
// the same cap getCustomersStatsBatch's own comment documents below, and this
// is the function that feeds it: campaigns-tab.tsx and send-queue.tsx both
// build their `customersById` map straight from this list, and every
// campaign metric (`reachableRecipientCount`, `hasRecipientsLeftToActOn`)
// keys off it. A customer who fell outside a truncated first 1000 rows would
// read as "unreachable" no matter how good their phone number is -- Reachable
// would undercount, the "N have no usable number" caveat would name the
// wrong people, and a campaign could be written 'done' while real,
// never-messaged customers were sitting at 'waiting' the whole time (see the
// CRITICAL fix on send-queue.tsx's status effect for why that's a one-way
// door once it happens). Paged with `.range()`, same shape as
// getCustomersStatsBatch just below and sales.ts's fetchAllRows.
const CUSTOMERS_PAGE_SIZE = 1000;

async function fetchAllRows<T>(runPage: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += CUSTOMERS_PAGE_SIZE) {
    const { data, error } = await runPage(from, from + CUSTOMERS_PAGE_SIZE - 1);
    if (error) throw error;
    const page = data ?? [];
    rows.push(...page);
    if (page.length < CUSTOMERS_PAGE_SIZE) break;
  }
  return rows;
}

export async function listCustomers(shopId: string): Promise<Customer[]> {
  // `id` is appended as a tiebreak, not just first_name/last_name -- two
  // customers can share both names, and `.range()` pagination over a query
  // whose order isn't fully deterministic has no guarantee page 2 picks up
  // exactly where page 1 left off (same reasoning getCustomersStatsBatch's
  // own comment gives for ordering by `id`).
  const rows = await fetchAllRows<any>((from, to) =>
    supabase
      .from('customers')
      .select('*')
      .eq('shop_id', shopId)
      .order('first_name', { ascending: true })
      .order('last_name', { ascending: true })
      .order('id', { ascending: true })
      .range(from, to)
  );
  return rows.map(mapCustomerRow);
}

// Powers the POS checkout picker's type-ahead -- server-side so it works
// against the full customer list, not just whatever listCustomers already
// fetched into a screen's local state.
//
// An RPC rather than a table query because the picker is reachable with only
// `pos.access`/`sales.edit`, which don't grant read on `customers` (that's
// `customers.view`, for the directory). `pos_search_customers` is a bounded
// lookup -- 2+ character query, wildcards escaped, 10 rows max -- so ringing
// up a sale can't double as a way to export the directory. See migration
// 0025.
export async function searchCustomers(shopId: string, query: string): Promise<Customer[]> {
  const q = query.trim();
  if (q.length < 2) return [];
  const { data, error } = await supabase.rpc('pos_search_customers', { p_shop_id: shopId, p_query: q });
  if (error) throw error;
  return ((data as any[] | null) ?? []).map(mapCustomerRow);
}

export async function getCustomer(id: string): Promise<Customer> {
  const { data, error } = await supabase.from('customers').select('*').eq('id', id).single();
  if (error) throw error;
  return mapCustomerRow(data);
}

// The picker's "+ New customer" quick-add. Separate from `createCustomer`
// below for the same reason `searchCustomers` is an RPC: the picker only has
// `pos.access`/`sales.edit`, so it can neither insert into `customers` nor
// read the row back. Takes only the four fields the picker collects -- the
// rest of the record is filled in from the directory.
export async function quickAddCustomer(
  shopId: string,
  input: { firstName: string; lastName?: string | null; phone?: string | null; email?: string | null }
): Promise<Customer> {
  const { data, error } = await supabase.rpc('pos_create_customer', {
    p_shop_id: shopId,
    p_first_name: input.firstName,
    p_last_name: input.lastName ?? null,
    p_phone: input.phone ?? null,
    p_email: input.email ?? null,
  });
  if (error) throw error;
  return mapCustomerRow(data);
}

export async function createCustomer(shopId: string, input: NewCustomerInput): Promise<Customer> {
  const { data, error } = await supabase
    .from('customers')
    .insert({ shop_id: shopId, ...toRow(input) })
    .select('*')
    .single();
  if (error) throw error;
  return mapCustomerRow(data);
}

// Bulk counterpart to createCustomer -- used by CSV import (src/lib/customers-import.ts)
// to insert every already-validated row in one round trip instead of one
// request per row.
export async function createCustomers(shopId: string, inputs: NewCustomerInput[]): Promise<Customer[]> {
  const { data, error } = await supabase
    .from('customers')
    .insert(inputs.map((input) => ({ shop_id: shopId, ...toRow(input) })))
    .select('*');
  if (error) throw error;
  return (data ?? []).map(mapCustomerRow);
}

export async function updateCustomer(id: string, patch: Partial<NewCustomerInput>): Promise<void> {
  const { error } = await supabase.from('customers').update(toRow(patch)).eq('id', id);
  if (error) throw error;
}

export async function deleteCustomer(id: string): Promise<void> {
  const { error } = await supabase.from('customers').delete().eq('id', id);
  if (error) throw error;
}

// Derived stats for the customer detail screen -- fetches this customer's
// sales and reduces client-side, same style as getMonthToDateRevenueCents
// in src/lib/sales.ts (no SQL aggregate/RPC for this in the codebase yet).
export async function getCustomerStats(customerId: string): Promise<{
  totalSpentCents: number;
  visitCount: number;
  lastPurchaseAt: string | null;
}> {
  // Refunds come along so spend is what the customer KEPT paying. A returned
  // order still counts as a visit -- they came in, and every "haven't seen
  // them" audience is built on that -- but it is no longer money they spent.
  const { data, error } = await supabase
    .from('sales')
    .select('total_cents, created_at, refunds(total_cents)')
    .eq('customer_id', customerId);
  if (error) throw error;
  const rows = data ?? [];
  return {
    totalSpentCents: keptSpendCents(
      rows.map((row) => ({
        totalCents: row.total_cents,
        refundedCents: (row.refunds ?? []).reduce((sum: number, refund: { total_cents: number }) => sum + refund.total_cents, 0),
      }))
    ),
    visitCount: rows.length,
    lastPurchaseAt: rows.reduce<string | null>((latest, row) => (!latest || row.created_at > latest ? row.created_at : latest), null),
  };
}

function mapCustomerPurchaseRow(row: any): CustomerPurchase {
  return {
    saleId: row.sale_id,
    saleItemId: row.id,
    productName: row.product_name,
    quantity: row.quantity,
    unitPriceCents: row.unit_price_cents,
    lineTotalCents: row.line_total_cents,
    paymentMethod: row.sale.payment_method,
    locationId: row.sale.location_id,
    createdAt: row.sale.created_at,
  };
}

// Itemized purchase history for the Customer detail pane. Embeds sales via
// PostgREST's `sale:sales!inner(...)` so the filter on customer_id can reach
// through sale_items -- sorted client-side (newest first) rather than via
// PostgREST's embedded-column order syntax, matching this file's existing
// client-side-reduce style (see getCustomerStats).
export async function listCustomerPurchases(customerId: string): Promise<CustomerPurchase[]> {
  const { data, error } = await supabase
    .from('sale_items')
    .select('id, sale_id, product_name, quantity, unit_price_cents, line_total_cents, sale:sales!inner(customer_id, payment_method, created_at, location_id)')
    .eq('sale.customer_id', customerId);
  if (error) throw error;
  return (data ?? [])
    .map(mapCustomerPurchaseRow)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

// Batched row-level stats for the Customers list (avoids one getCustomerStats
// query per row -- see Task 11). One query over every sale in the shop,
// reduced client-side into a per-customer map, same reduction shape as
// getCustomerStats itself.
export type CustomerStats = { totalSpentCents: number; visitCount: number; lastOrderAt: string | null };

// PostgREST caps any unbounded select at a server-side default (1000 rows) --
// same limit src/lib/sales.ts already documents and pages around with its own
// PAGE_SIZE/fetchAllRows, and the same shared `fetchAllRows` above (defined
// for listCustomers, which hits the identical cap on the same table's own
// row count). A shop past 1000 customer-attributed sales would otherwise have
// this read silently truncate, and it isn't a "recent list" like listSales --
// every campaign audience filter's "hasn't bought in N days" (matchesAudience
// in campaign-audience.ts) runs off the lastOrderAt this produces, and treats
// a MISSING one as "never bought" -- the strongest form of inactivity there
// is. A truncated read here doesn't just under-count a total, it can turn a
// shop's most loyal customers -- whose sales simply fell outside the first
// 1000 rows returned -- into "we miss you" targets. Paged with `.range()`
// instead of trusting one fetch to be complete.
export async function getCustomersStatsBatch(shopId: string): Promise<Map<string, CustomerStats>> {
  // created_at comes along for `lastOrderAt` -- the rows were already being
  // read, so tracking the most recent one costs nothing extra and is what
  // "haven't seen them in a while" needs.
  //
  // Ordered by id (a stable tiebreak, not a meaningful sort) rather than left
  // unordered: `.range()` pagination over an unordered query has no
  // guarantee that page 2 picks up where page 1 left off if the underlying
  // scan order isn't fixed -- a real risk for a query with no WHERE clause
  // selective enough to pin one index's scan order.
  const rows = await fetchAllRows<{
    customer_id: string;
    total_cents: number;
    created_at: string;
    refunds: { total_cents: number }[] | null;
  }>((from, to) =>
    supabase
      .from('sales')
      .select('customer_id, total_cents, created_at, refunds(total_cents)')
      .eq('shop_id', shopId)
      .not('customer_id', 'is', null)
      .order('id', { ascending: true })
      .range(from, to)
  );
  const stats = new Map<string, CustomerStats>();
  for (const row of rows) {
    const id = row.customer_id as string;
    const current = stats.get(id) ?? { totalSpentCents: 0, visitCount: 0, lastOrderAt: null };
    // Spend is what they kept paying; the visit still counts either way. See
    // `keptSpendCents` for why these two figures subtract without conversion.
    const refundedCents = (row.refunds ?? []).reduce((sum, refund) => sum + refund.total_cents, 0);
    stats.set(id, {
      totalSpentCents: current.totalSpentCents + keptSpendCents([{ totalCents: row.total_cents, refundedCents }]),
      visitCount: current.visitCount + 1,
      lastOrderAt:
        current.lastOrderAt === null || row.created_at > current.lastOrderAt ? (row.created_at as string) : current.lastOrderAt,
    });
  }
  return stats;
}

// What a customer can actually spend right now: their balance less anything
// earned inside the shop's maturing window. Not derivable from the customer row
// (it depends on the clock and on the ledger), so it's its own small RPC —
// called once when a customer is attached at checkout.
//
// Display and clamping only. complete_sale recomputes this under a row lock and
// refuses the sale if it no longer holds.
export async function customerPointsAvailable(customerId: string): Promise<number> {
  const { data, error } = await supabase.rpc('customer_points_available', { p_customer_id: customerId });
  if (error) throw error;
  return (data as number) ?? 0;
}

// The movements behind a customer's points balance, newest first. A plain
// table read rather than an RPC: the ledger's select policy already accepts
// customers.view, and nothing here needs definer rights.
//
// Capped at `limit` because this answers "why is my balance 148" at the
// counter, not "reconcile three years" -- the ledger is append-only and grows
// with every sale.
export async function listCustomerPointsHistory(customerId: string, limit = 20): Promise<CustomerPointsEntry[]> {
  const { data, error } = await supabase
    .from('customer_points_ledger')
    .select('id, sale_id, delta_points, reason, note, created_at')
    .eq('customer_id', customerId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []).map((row: any) => ({
    id: row.id,
    saleId: row.sale_id,
    deltaPoints: row.delta_points,
    reason: row.reason,
    note: row.note,
    createdAt: row.created_at,
  }));
}

// Repeat customers who've gone quiet -- the ones worth a message. Requires at
// least two prior orders on purpose: a single first-time buyer who hasn't
// returned is normal, not a lapsed regular.
export function dormantCustomers(
  customers: Customer[],
  stats: Map<string, CustomerStats>,
  opts?: { minOrders?: number; quietForDays?: number; now?: Date }
): { customer: Customer; lastOrderAt: string }[] {
  const minOrders = opts?.minOrders ?? 2;
  const quietForDays = opts?.quietForDays ?? 30;
  const cutoff = (opts?.now ?? new Date()).getTime() - quietForDays * 86_400_000;

  return customers
    .flatMap((customer) => {
      const stat = stats.get(customer.id);
      if (!stat || stat.visitCount < minOrders || !stat.lastOrderAt) return [];
      if (new Date(stat.lastOrderAt).getTime() >= cutoff) return [];
      return [{ customer, lastOrderAt: stat.lastOrderAt }];
    })
    .sort((a, b) => a.lastOrderAt.localeCompare(b.lastOrderAt));
}
