import { ALL_PERMISSIONS, expandPermissions, type Permission } from '@/lib/permissions';
import { supabase } from '@/lib/supabase';
import type { Role, Shop, StaffMember } from '@/types/models';

// What the signed-in user is allowed to do in `shop`. The admin (the shop's
// owner_id) implicitly holds the whole catalog and deliberately has no
// shop_members row (see migration 0017), so that case is resolved here rather
// than duplicating the catalog in SQL. Staff go through the
// `my_shop_permissions` RPC because `roles` itself is only readable with
// staff.manage -- a cashier can't select its own role row directly.
export async function getMyPermissions(shop: Shop, userId: string): Promise<Permission[]> {
  if (shop.ownerId === userId) return [...ALL_PERMISSIONS];
  const { data, error } = await supabase.rpc('my_shop_permissions', { p_shop_id: shop.id });
  if (error) throw error;
  return expandPermissions((data as string[] | null) ?? []);
}

function mapRoleRow(row: any): Role {
  return { id: row.id, shopId: row.shop_id, name: row.name, permissions: row.permissions ?? [], createdAt: row.created_at };
}

export async function listRoles(shopId: string): Promise<Role[]> {
  const { data, error } = await supabase.from('roles').select('*').eq('shop_id', shopId).order('name', { ascending: true });
  if (error) throw error;
  return (data ?? []).map(mapRoleRow);
}

export async function createRole(shopId: string, name: string, permissions: string[]): Promise<Role> {
  const { data, error } = await supabase.from('roles').insert({ shop_id: shopId, name, permissions }).select('*').single();
  if (error) throw error;
  return mapRoleRow(data);
}

export async function updateRole(roleId: string, input: { name?: string; permissions?: string[] }): Promise<Role> {
  const { data, error } = await supabase
    .from('roles')
    .update({ ...(input.name !== undefined && { name: input.name }), ...(input.permissions !== undefined && { permissions: input.permissions }) })
    .eq('id', roleId)
    .select('*')
    .single();
  if (error) throw error;
  return mapRoleRow(data);
}

export async function deleteRole(roleId: string): Promise<void> {
  const { error } = await supabase.from('roles').delete().eq('id', roleId);
  if (error) throw error;
}

// How many staff currently use each role -- lets the Roles UI block/warn on
// deleting a role that's still assigned, mirroring the taxonomy usage-count
// pattern in settings.tsx.
export async function countStaffByRole(shopId: string): Promise<Map<string, number>> {
  const { data, error } = await supabase.from('shop_members').select('role_id').eq('shop_id', shopId);
  if (error) throw error;
  const counts = new Map<string, number>();
  for (const row of data ?? []) counts.set(row.role_id, (counts.get(row.role_id) ?? 0) + 1);
  return counts;
}

function mapStaffRow(row: any): StaffMember {
  return {
    id: row.id,
    shopId: row.shop_id,
    userId: row.user_id,
    roleId: row.role_id,
    // Two row shapes reach here: the `list_shop_staff` RPC returns a flat
    // `role_name` column, while the direct table selects (getMyMembership)
    // embed it as `role: { name }` via PostgREST.
    roleName: row.role?.name ?? row.role_name ?? '',
    // The RPC returns `location_ids`; the direct table select in
    // getMyMembership embeds the join rows instead. Empty means every store.
    locationIds: row.location_ids ?? (row.member_locations ?? []).map((entry: any) => entry.location_id),
    active: row.active,
    fullName: row.full_name,
    email: row.email,
    phone: row.phone ?? null,
    photoUrl: row.photo_url ?? null,
    createdAt: row.created_at,
    hireDate: row.hire_date,
    payType: row.pay_type,
    payRateCents: row.pay_rate_cents,
    // The RPC blanks pay columns for callers without people.payroll.manage, so
    // this can arrive null; 'monthly' is the schema default and the safe read.
    payCadence: (row.pay_cadence ?? 'monthly') as StaffMember['payCadence'],
  };
}

export async function listStaff(shopId: string): Promise<StaffMember[]> {
  // An RPC rather than a table select because RLS is row-level, not
  // column-level: reading `shop_members` directly hands pay_type/pay_rate_cents
  // to every role that can see the roster at all. `list_shop_staff` blanks
  // those two columns unless the caller holds people.payroll.manage, so the
  // pay gate is enforced in the database instead of only in the UI that
  // renders it. See migration 20260803010000.
  //
  // (`profiles` still isn't embeddable -- shop_members and profiles both
  // reference auth.users with no direct FK between them -- so full_name/email
  // remain denormalized onto shop_members at provision time, migrations
  // 0019/0021.)
  const { data, error } = await supabase.rpc('list_shop_staff', { p_shop_id: shopId });
  if (error) throw error;
  return ((data as any[] | null) ?? []).map(mapStaffRow);
}

// A staff member's own roster row -- the "am I on the team, and what's my
// role/pay/hire-date" lookup useAuth() has no equivalent of today (see
// migration 0017's "staff reads own membership" policy, previously unused
// client-side). Returns null for an admin (no shop_members row -- see
// getMyPermissions) and for anyone with no membership in this shop.
export async function getMyMembership(shopId: string, userId: string): Promise<StaffMember | null> {
  const { data, error } = await supabase
    .from('shop_members')
    .select('*, role:roles(name), member_locations:shop_member_locations(location_id)')
    .eq('shop_id', shopId)
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw error;
  return data ? mapStaffRow(data) : null;
}

// Sets hire date / pay type / pay rate on a roster row -- gated at the DB
// by "write shop_members roster" (staff.manage OR people.payroll.manage,
// migration 20260802030200_hr_schema.sql).
export async function updateStaffPay(
  memberId: string,
  patch: {
    hireDate?: string | null;
    payType?: StaffMember['payType'];
    payRateCents?: number | null;
    payCadence?: StaffMember['payCadence'];
  }
): Promise<void> {
  const { error, count } = await supabase
    .from('shop_members')
    .update(
      {
        ...(patch.hireDate !== undefined && { hire_date: patch.hireDate }),
        ...(patch.payType !== undefined && { pay_type: patch.payType }),
        ...(patch.payRateCents !== undefined && { pay_rate_cents: patch.payRateCents }),
        ...(patch.payCadence !== undefined && { pay_cadence: patch.payCadence }),
      },
      { count: 'exact' }
    )
    .eq('id', memberId);
  if (error) throw error;
  // RLS filters an update to zero rows without raising -- PostgREST returns 204
  // and the write silently does nothing. Without the count that reads as
  // success, and the value just fails to stick.
  if (count === 0) throw new Error('Could not save pay details — you may no longer have permission to edit this member.');
}

export async function updateStaffRole(memberId: string, roleId: string): Promise<void> {
  const { error, count } = await supabase
    .from('shop_members')
    .update({ role_id: roleId }, { count: 'exact' })
    .eq('id', memberId);
  if (error) throw error;
  // Same silent-failure shape as updateStaffPay: a policy-filtered update
  // returns 204 with no error, so without the count it looks like it worked.
  if (count === 0) throw new Error('Could not change this role — you may no longer have permission to edit this member.');
}

// Which stores this person works at. An EMPTY array restores "every store" —
// the state every member is in before anyone restricts them.
//
// Goes through an RPC rather than a delete-then-insert from here: between those
// two writes the member would have no rows, which under these semantics means
// "every store". That window is a real hole, so the swap happens in one
// transaction server-side (migration 20260814000000).
export async function setStaffLocations(memberId: string, locationIds: string[]): Promise<void> {
  const { error } = await supabase.rpc('set_member_locations', {
    p_member_id: memberId,
    p_location_ids: locationIds,
  });
  if (error) throw error;
}

export async function setStaffActive(memberId: string, active: boolean): Promise<void> {
  const { error, count } = await supabase
    .from('shop_members')
    .update({ active }, { count: 'exact' })
    .eq('id', memberId);
  if (error) throw error;
  if (count === 0) {
    throw new Error(`Could not ${active ? 'enable' : 'disable'} this member — you may no longer have permission to edit them.`);
  }
}

export async function updateStaffMember(input: {
  shopId: string; memberId: string; fullName: string; email: string; phone?: string | null; roleId: string; active: boolean;
  hireDate?: string | null; payType?: StaffMember['payType']; payRateCents?: number | null; payCadence?: StaffMember['payCadence'];
}): Promise<void> {
  const { data, error } = await supabase.functions.invoke<{ error?: string; message?: string }>('update-staff', { body: input });
  if (error) throw error;
  if (data?.error) throw new Error(data.message ?? 'Could not update this staff member.');
}

export type ProvisionStaffResult = {
  userId: string;
  email: string;
  temporaryPassword: string | null;
  member: { id: string; shopId: string; userId: string; roleId: string; active: boolean };
};

// 'limit_reached' is the shop's plan being out of seats, distinct from
// 'forbidden' (this user may not add staff). The database trigger on
// shop_members is the real gate; the edge function checks first only so the
// caller gets this typed reason instead of a 500 from a raised exception.
export type ProvisionStaffError = {
  error: 'forbidden' | 'invalid_role' | 'duplicate_email' | 'limit_reached' | 'unknown';
  message: string;
};

export async function provisionStaff(input: {
  shopId: string;
  fullName: string;
  email: string;
  phone?: string;
  password?: string;
  roleId: string;
}): Promise<ProvisionStaffResult> {
  // The body is an explicit whitelist, not a spread of `input` -- a field left
  // out here is silently dropped rather than rejected, so anything new has to
  // be added in both places.
  const { data, error } = await supabase.functions.invoke<ProvisionStaffResult | ProvisionStaffError>('provision-staff', {
    body: {
      shopId: input.shopId,
      fullName: input.fullName,
      email: input.email,
      phone: input.phone,
      password: input.password,
      roleId: input.roleId,
    },
  });
  if (error) throw error;
  if (data && 'error' in data) throw new Error(data.message);
  if (!data) throw new Error('No response from provision-staff.');
  return data;
}
