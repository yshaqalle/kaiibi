import { supabase } from '@/lib/supabase';
import type { Customer, NewCustomerInput } from '@/types/models';

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
export async function searchCustomers(shopId: string, query: string): Promise<Customer[]> {
  const q = query.trim();
  if (!q) return [];
  const { data, error } = await supabase
    .from('customers')
    .select('*')
    .eq('shop_id', shopId)
    .or(`first_name.ilike.%${q}%,last_name.ilike.%${q}%,phone.ilike.%${q}%`)
    .order('first_name', { ascending: true })
    .limit(10);
  if (error) throw error;
  return (data ?? []).map(mapCustomerRow);
}

export async function getCustomer(id: string): Promise<Customer> {
  const { data, error } = await supabase.from('customers').select('*').eq('id', id).single();
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
