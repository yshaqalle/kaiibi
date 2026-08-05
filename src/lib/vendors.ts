import { escapeLikePattern } from '@/lib/like-pattern';
import { supabase } from '@/lib/supabase';
import type { NewVendorInput, Vendor } from '@/types/models';

function mapVendorRow(row: any): Vendor {
  return {
    id: row.id,
    shopId: row.shop_id,
    name: row.name,
    contactPerson: row.contact_person,
    phone: row.phone,
    email: row.email,
    address: row.address,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toRow(input: Partial<NewVendorInput>) {
  return {
    ...(input.name !== undefined && { name: input.name }),
    ...(input.contactPerson !== undefined && { contact_person: input.contactPerson }),
    ...(input.phone !== undefined && { phone: input.phone }),
    ...(input.email !== undefined && { email: input.email }),
    ...(input.address !== undefined && { address: input.address }),
    ...(input.notes !== undefined && { notes: input.notes }),
  };
}

export async function listVendors(shopId: string): Promise<Vendor[]> {
  const { data, error } = await supabase
    .from('vendors')
    .select('*')
    .eq('shop_id', shopId)
    .order('name', { ascending: true });
  if (error) throw error;
  return (data ?? []).map(mapVendorRow);
}

// Type-ahead for the vendor picker on the expense/bill editors. A plain
// `ilike` rather than an RPC (unlike `pos_search_customers`): the customer
// lookup needs a bounded server-side search because POS roles can't read the
// customers table at all, whereas vendors are member-readable reference data
// -- and a shop has tens of vendors, not thousands of customers.
export async function searchVendors(shopId: string, query: string): Promise<Vendor[]> {
  const q = query.trim();
  if (!q) return [];
  const { data, error } = await supabase
    .from('vendors')
    .select('*')
    .eq('shop_id', shopId)
    .ilike('name', `%${escapeLikePattern(q)}%`)
    .order('name', { ascending: true })
    .limit(10);
  if (error) throw error;
  return (data ?? []).map(mapVendorRow);
}

export async function createVendor(shopId: string, input: NewVendorInput): Promise<Vendor> {
  const { data, error } = await supabase
    .from('vendors')
    .insert({ shop_id: shopId, ...toRow(input) })
    .select('*')
    .single();
  if (error) throw error;
  return mapVendorRow(data);
}

export async function updateVendor(id: string, patch: Partial<NewVendorInput>): Promise<void> {
  const { data: userData } = await supabase.auth.getUser();
  const { error } = await supabase
    .from('vendors')
    .update({ ...toRow(patch), updated_at: new Date().toISOString(), updated_by: userData.user?.id ?? null })
    .eq('id', id);
  if (error) throw error;
}

export async function deleteVendor(id: string): Promise<void> {
  const { error } = await supabase.from('vendors').delete().eq('id', id);
  if (error) throw error;
}

