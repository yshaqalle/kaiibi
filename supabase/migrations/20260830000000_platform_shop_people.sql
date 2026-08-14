-- Who works at a store, for the operator console.
--
-- A security-definer function rather than a select policy on shop_members, for
-- exactly the reason 20260825000400 replaced the profiles policy it had just
-- added: 0003_grants gives `authenticated` table-wide select on shop_members,
-- so a policy naming no columns hands back every column the table has -- which
-- since 20260802030200 includes pay_type, pay_rate_cents and hire_date. A
-- policy would make an operator's own API access wider than the app's query
-- string, and what an operator is bounded by is the policy, not the query.
--
-- Kaiibi operators have no business knowing what a shop pays its cashier. The
-- only way to guarantee that is to never select it.
--
-- Read-only by construction: `stable`, no write path anywhere, and the
-- platform-admin edge function gains no action that touches these tables. An
-- operator can see a store's roster and cannot change one row of it.

create or replace function public.platform_shop_people(p_shop_ids uuid[])
returns table (
  shop_id          uuid,
  user_id          uuid,
  full_name        text,
  email            text,
  phone            text,
  role_name        text,
  role_permissions text[],
  is_owner         boolean,
  active           boolean,
  joined_at        timestamptz,
  branch_names     text[]
)
language sql
stable
security definer
set search_path = public
as $$
  select
    m.shop_id,
    m.user_id,
    m.full_name,
    m.email,
    m.phone,
    r.name,
    r.permissions,
    (s.owner_id = m.user_id),
    m.active,
    m.created_at,
    -- An EMPTY array means every branch, not none. can_access_location()
    -- (20260814000000) treats a member with no assignment rows as reaching all
    -- of them, so the caller labels this off the array's length -- and getting
    -- that backwards would tell an operator the opposite of what the database
    -- enforces. Primary branch first, so "Main" leads the list it is in.
    coalesce(
      (select array_agg(l.name order by l.is_primary desc, l.name)
         from public.shop_member_locations ml
         join public.shop_locations l on l.id = ml.location_id
        where ml.shop_member_id = m.id),
      '{}'::text[]
    )
  from public.shop_members m
  join public.roles r on r.id = m.role_id
  join public.shops s on s.id = m.shop_id
  where public.is_platform_admin()
    and m.shop_id = any(p_shop_ids);
$$;

-- Postgres grants execute to PUBLIC on every new function, which on a definer
-- function means anon too. Revoked before the one explicit grant, so the grant
-- is the whole list of who can call it.
revoke execute on function public.platform_shop_people(uuid[]) from public;
grant execute on function public.platform_shop_people(uuid[]) to authenticated;
