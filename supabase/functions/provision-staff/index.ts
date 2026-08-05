// Lets a shop admin create a staff login directly (name + email + role,
// admin sets or generates the password on the spot) -- no invite-email
// round trip. Runs with the service role so it can create the auth.users
// row itself; a plain client can only ever create *its own* account via
// supabase.auth.signUp().
import { createClient } from 'jsr:@supabase/supabase-js@2';

type RequestBody = {
  shopId: string;
  fullName: string;
  email: string;
  // Optional, and deliberately absent from the required-field check below: a
  // login needs an email, not a phone.
  phone?: string;
  password?: string;
  roleId: string;
};

// The web client calls this cross-origin (e.g. localhost:8081 -> supabase.co),
// so the browser preflights with OPTIONS before the real POST. Without these
// headers on every response, the browser blocks the request before our
// handler logic ever runs.
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function errorResponse(status: number, error: string, message: string) {
  return new Response(JSON.stringify({ error, message }), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  });
}

function generatePassword(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(9));
  return btoa(String.fromCharCode(...bytes)).replace(/[+/=]/g, '').slice(0, 12);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });
  if (req.method !== 'POST') return errorResponse(405, 'unknown', 'Method not allowed.');

  let body: RequestBody;
  try {
    body = await req.json();
  } catch {
    return errorResponse(400, 'unknown', 'Invalid JSON body.');
  }

  const { shopId, fullName, email, roleId } = body;
  const password = body.password?.trim() || generatePassword();
  if (!shopId || !fullName?.trim() || !email?.trim() || !roleId) {
    return errorResponse(400, 'unknown', 'shopId, fullName, email, and roleId are required.');
  }

  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return errorResponse(401, 'forbidden', 'Missing Authorization header.');

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

  // Forwards the caller's own JWT so getUser() resolves *them*, not the
  // service role -- this client is never used for privileged operations.
  const callerClient = createClient(supabaseUrl, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: callerData, error: callerError } = await callerClient.auth.getUser();
  if (callerError || !callerData.user) return errorResponse(401, 'forbidden', 'Could not verify caller.');

  // Service-role client for everything privileged below. RLS doesn't apply
  // to it, so every check it needs to make (ownership, role validity) is
  // done explicitly rather than relying on policies.
  const adminClient = createClient(supabaseUrl, serviceRoleKey);

  // The shop owner or anyone whose role grants `staff.manage` (migration
  // 0024). Asked of the DB rather than compared here, so this stays the same
  // check the roles/shop_members RLS policies apply -- the service-role
  // client bypasses RLS, so auth.uid() is null for it and the caller's id has
  // to be passed explicitly.
  const { data: canManageStaff, error: permissionError } = await adminClient.rpc('user_has_shop_permission', {
    p_user_id: callerData.user.id,
    p_shop_id: shopId,
    p_permission: 'staff.manage',
  });
  if (permissionError) return errorResponse(500, 'unknown', permissionError.message);
  if (!canManageStaff) {
    return errorResponse(403, 'forbidden', 'Not authorized to add staff to this shop.');
  }

  // Seat check before creating anything. The BEFORE INSERT trigger on
  // shop_members (migration 20260818000300) is what actually enforces this --
  // asking here is about the failure MODE, not the rule. Without it the seat
  // cap would be hit at the shop_members insert, which is after
  // auth.admin.createUser() has already succeeded: the rollback below would
  // fire and the admin would see a bare 500 for what is really "your plan is
  // full". Checking first turns that into a typed, actionable reason and
  // avoids creating a login we're about to delete.
  const { data: seatLimit, error: seatLimitError } = await adminClient.rpc('shop_limit', {
    p_shop_id: shopId,
    p_resource: 'staff',
  });
  if (seatLimitError) return errorResponse(500, 'unknown', seatLimitError.message);
  if (seatLimit !== null) {
    const { count, error: countError } = await adminClient
      .from('shop_members')
      .select('id', { count: 'exact', head: true })
      .eq('shop_id', shopId);
    if (countError) return errorResponse(500, 'unknown', countError.message);
    if ((count ?? 0) >= seatLimit) {
      return errorResponse(
        409,
        'limit_reached',
        `Your plan includes ${seatLimit} team member${seatLimit === 1 ? '' : 's'}. Upgrade under Settings → Plan and billing to add more.`
      );
    }
  }

  const { data: role, error: roleError } = await adminClient
    .from('roles')
    .select('id')
    .eq('id', roleId)
    .eq('shop_id', shopId)
    .maybeSingle();
  if (roleError) return errorResponse(500, 'unknown', roleError.message);
  if (!role) return errorResponse(400, 'invalid_role', 'That role does not belong to this shop.');

  const { data: created, error: createError } = await adminClient.auth.admin.createUser({
    email: email.trim(),
    password,
    email_confirm: true,
    user_metadata: { role: 'staff', full_name: fullName.trim() },
  });
  if (createError) {
    const duplicate = createError.message.toLowerCase().includes('already been registered') || createError.status === 422;
    return errorResponse(duplicate ? 409 : 500, duplicate ? 'duplicate_email' : 'unknown', createError.message);
  }
  const newUserId = created.user.id;

  const { data: member, error: memberError } = await adminClient
    .from('shop_members')
    .insert({
      shop_id: shopId,
      user_id: newUserId,
      role_id: roleId,
      active: true,
      email: email.trim(),
      full_name: fullName.trim(),
      phone: body.phone?.trim() || null,
    })
    .select('id, shop_id, user_id, role_id, active')
    .single();
  if (memberError) {
    // The auth user now exists but has no membership -- best-effort cleanup
    // so a failed provision doesn't leave an orphaned login behind.
    await adminClient.auth.admin.deleteUser(newUserId);
    return errorResponse(500, 'unknown', memberError.message);
  }

  return new Response(
    JSON.stringify({
      userId: newUserId,
      email: email.trim(),
      temporaryPassword: body.password?.trim() ? null : password,
      member: { id: member.id, shopId: member.shop_id, userId: member.user_id, roleId: member.role_id, active: member.active },
    }),
    { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
  );
});
