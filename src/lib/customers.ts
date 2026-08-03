import { supabase } from '@/lib/supabase';
import type { Customer, CustomerPurchase, NewCustomerInput } from '@/types/models';

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

export async function listCustomers(shopId: string): Promise<Customer[]> {
  const { data, error } = await supabase
    .from('customers')
    .select('*')
    .eq('shop_id', shopId)
    .order('first_name', { ascending: true })
    .order('last_name', { ascending: true });
  if (error) throw error;
  return (data ?? []).map(mapCustomerRow);
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
  const { data, error } = await supabase.from('sales').select('total_cents, created_at').eq('customer_id', customerId);
  if (error) throw error;
  const rows = data ?? [];
  return {
    totalSpentCents: rows.reduce((sum, row) => sum + row.total_cents, 0),
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
    .select('id, sale_id, product_name, quantity, unit_price_cents, line_total_cents, sale:sales!inner(customer_id, payment_method, created_at)')
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

export async function getCustomersStatsBatch(shopId: string): Promise<Map<string, CustomerStats>> {
  // created_at comes along for `lastOrderAt` -- the rows were already being
  // read, so tracking the most recent one costs nothing extra and is what
  // "haven't seen them in a while" needs.
  const { data, error } = await supabase
    .from('sales')
    .select('customer_id, total_cents, created_at')
    .eq('shop_id', shopId)
    .not('customer_id', 'is', null);
  if (error) throw error;
  const stats = new Map<string, CustomerStats>();
  for (const row of data ?? []) {
    const id = row.customer_id as string;
    const current = stats.get(id) ?? { totalSpentCents: 0, visitCount: 0, lastOrderAt: null };
    stats.set(id, {
      totalSpentCents: current.totalSpentCents + row.total_cents,
      visitCount: current.visitCount + 1,
      lastOrderAt:
        current.lastOrderAt === null || row.created_at > current.lastOrderAt ? (row.created_at as string) : current.lastOrderAt,
    });
  }
  return stats;
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
