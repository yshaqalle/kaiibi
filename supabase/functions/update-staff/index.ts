import { createClient } from 'jsr:@supabase/supabase-js@2';

type RequestBody = {
  shopId: string;
  memberId: string;
  fullName: string;
  email: string;
  roleId: string;
  active: boolean;
  hireDate?: string | null;
  payType?: 'hourly' | 'salary' | 'fixed' | null;
  payRateCents?: number | null;
  payCadence?: 'weekly' | 'biweekly' | 'semimonthly' | 'monthly';
};

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function errorResponse(status: number, message: string) {
  return new Response(JSON.stringify({ error: 'unknown', message }), { status, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });
  if (req.method !== 'POST') return errorResponse(405, 'Method not allowed.');

  let body: RequestBody;
  try { body = await req.json(); } catch { return errorResponse(400, 'Invalid JSON body.'); }
  const { shopId, memberId, fullName, email, roleId, active, hireDate, payType, payRateCents, payCadence } = body;
  if (!shopId || !memberId || !fullName?.trim() || !email?.trim() || !roleId || typeof active !== 'boolean') return errorResponse(400, 'All member details are required.');

  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return errorResponse(401, 'Missing Authorization header.');
  const url = Deno.env.get('SUPABASE_URL')!;
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const caller = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: authHeader } } });
  const { data: callerData, error: callerError } = await caller.auth.getUser();
  if (callerError || !callerData.user) return errorResponse(401, 'Could not verify caller.');

  const admin = createClient(url, serviceRoleKey);
  const { data: canManage, error: permissionError } = await admin.rpc('user_has_shop_permission', { p_user_id: callerData.user.id, p_shop_id: shopId, p_permission: 'staff.manage' });
  if (permissionError) return errorResponse(500, permissionError.message);
  if (!canManage) return errorResponse(403, 'Not authorized to edit staff.');

  const { data: member, error: memberError } = await admin.from('shop_members').select('user_id').eq('id', memberId).eq('shop_id', shopId).maybeSingle();
  if (memberError) return errorResponse(500, memberError.message);
  if (!member) return errorResponse(404, 'Staff member not found in this shop.');

  const { data: role, error: roleError } = await admin.from('roles').select('id').eq('id', roleId).eq('shop_id', shopId).maybeSingle();
  if (roleError) return errorResponse(500, roleError.message);
  if (!role) return errorResponse(400, 'That role does not belong to this shop.');

  const editsPayroll = hireDate !== undefined || payType !== undefined || payRateCents !== undefined || payCadence !== undefined;
  if (editsPayroll) {
    const { data: canManagePayroll, error: payrollError } = await admin.rpc('user_has_shop_permission', { p_user_id: callerData.user.id, p_shop_id: shopId, p_permission: 'people.payroll.manage' });
    if (payrollError) return errorResponse(500, payrollError.message);
    if (!canManagePayroll) return errorResponse(403, 'Not authorized to edit payroll details.');
  }

  const normalizedName = fullName.trim();
  const normalizedEmail = email.trim().toLowerCase();
  const { error: authError } = await admin.auth.admin.updateUserById(member.user_id, { email: normalizedEmail, user_metadata: { full_name: normalizedName } });
  if (authError) return errorResponse(400, authError.message);

  const { error: profileError } = await admin.from('profiles').update({ full_name: normalizedName }).eq('id', member.user_id);
  if (profileError) return errorResponse(500, profileError.message);
  const { error: updateError } = await admin
    .from('shop_members')
    .update({ full_name: normalizedName, email: normalizedEmail, role_id: roleId, active, ...(editsPayroll ? { hire_date: hireDate ?? null, pay_type: payType ?? null, pay_rate_cents: payRateCents ?? null, pay_cadence: payCadence ?? 'monthly' } : {}) })
    .eq('id', memberId)
    .eq('shop_id', shopId);
  if (updateError) return errorResponse(500, updateError.message);

  return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json', ...corsHeaders } });
});
