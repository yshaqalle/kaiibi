-- Resolving "what is this shop entitled to right now". These are the
-- entitlement twins of 0024_permission_gates.sql's has_shop_permission family
-- and are written to the same shape on purpose: security definer, stable, one
-- shop_id argument, safe to call from an RLS policy.
--
-- The design decision worth knowing before reading any of it: subscription
-- STATUS IS COMPUTED, NOT STORED. There is no status column anyone has to
-- remember to update and no nightly job whose failure leaves a lapsed shop
-- reading as active. now() is compared against the dates each time. The one
-- exception is manual_status, the operator's suspend switch, which is stored
-- precisely because a human sets it rather than time.

-- 'suspended' | 'trialing' | 'active' | 'grace' | 'expired'.
--
-- Order matters. A converted shop keeps its trial_ends_at (in the past) and
-- gains a current_period_end (in the future), so trialing must be tested on
-- the date being in the FUTURE rather than on the column being non-null.
create or replace function public.shop_effective_status(p_shop_id uuid)
returns text
language sql security definer stable set search_path = public as $$
  select case
    when s.id is null then 'expired'
    when s.manual_status = 'suspended' then 'suspended'
    when s.trial_ends_at is not null and now() < s.trial_ends_at then 'trialing'
    when s.current_period_end is not null and now() < s.current_period_end then 'active'
    when s.grace_until is not null and now() < s.grace_until then 'grace'
    else 'expired'
  end
  from (select null::uuid as id) empty
  left join public.shop_subscriptions s on s.shop_id = p_shop_id;
$$;

-- The plan whose modules and limits actually apply.
--
-- Never returns null. A shop with no subscription row at all -- one created
-- while the trial plan was missing, or a row deleted by hand -- resolves to
-- the post-trial plan, not to "everything". Failing closed is the same choice
-- getMyPermissions() makes on the client (src/lib/staff.ts) and for the same
-- reason: an unresolved entitlement set must never read as full access.
--
-- Suspended and expired both fall back to the post-trial plan. For suspended
-- that is belt and braces -- shop_has_module() already returns false outright
-- -- but it also quietly closes a gap: shop_locations is capped by a LIMIT
-- rather than gated by a module (see 20260818000400), so without this a
-- suspended shop could still open new branches.
create or replace function public.shop_effective_plan(p_shop_id uuid)
returns public.plans
language sql security definer stable set search_path = public as $$
  select p.* from public.plans p
  where p.key = case
    when public.shop_effective_status(p_shop_id) in ('trialing', 'active', 'grace')
      then (select pl.key from public.shop_subscriptions s join public.plans pl on pl.id = s.plan_id where s.shop_id = p_shop_id)
    else (select ps.post_trial_plan_key from public.platform_settings ps where ps.id)
  end;
$$;

-- Whether the shop may WRITE in this module. Reads are never gated on this:
-- a shop that stops paying keeps full read access to its own sales, books and
-- payroll history. Locking a business out of its own records because an
-- invoice lapsed is indistinguishable from destroying them.
create or replace function public.shop_has_module(p_shop_id uuid, p_module text)
returns boolean
language sql security definer stable set search_path = public as $$
  select case
    when public.shop_effective_status(p_shop_id) = 'suspended' then false
    else
      p_module = any((public.shop_effective_plan(p_shop_id)).modules)
      or exists (
        select 1 from public.shop_entitlement_overrides o
        where o.shop_id = p_shop_id and o.kind = 'module' and o.key = p_module
          and (o.expires_at is null or o.expires_at > now())
      )
  end;
$$;

-- The cap on a countable resource. NULL MEANS UNLIMITED, and a missing key in
-- the plan's limits jsonb means the same -- so adding a newly-limited resource
-- later cannot retroactively cap existing plans at zero and lock paying
-- customers out of something that worked yesterday.
--
-- An override wins over the plan even when its value is null, which is how
-- "unlimited products for this one shop" is expressed.
create or replace function public.shop_limit(p_shop_id uuid, p_resource text)
returns integer
language sql security definer stable set search_path = public as $$
  select case
    when exists (
      select 1 from public.shop_entitlement_overrides o
      where o.shop_id = p_shop_id and o.kind = 'limit' and o.key = p_resource
        and (o.expires_at is null or o.expires_at > now())
    )
    then (
      select (o.value #>> '{}')::integer from public.shop_entitlement_overrides o
      where o.shop_id = p_shop_id and o.kind = 'limit' and o.key = p_resource
        and (o.expires_at is null or o.expires_at > now())
    )
    else ((public.shop_effective_plan(p_shop_id)).limits ->> p_resource)::integer
  end;
$$;

-- Everything the client needs in one round trip -- the entitlement twin of
-- my_shop_permissions(). Modules are returned already resolved (plan plus
-- unexpired overrides) so the client never reimplements the precedence rules,
-- which is the same reason my_shop_permissions() exists rather than shipping
-- the roles table to the device.
--
-- `usage` is an empty object here and is filled in when shop_usage_counters
-- arrives in 20260818000300, which reproduces this function whole per the
-- convention documented in 0024_permission_gates.sql:240-259. Keeping the key
-- present from the start means the client's shape never changes.
create or replace function public.my_shop_entitlements(p_shop_id uuid)
returns jsonb
language sql security definer stable set search_path = public as $$
  select jsonb_build_object(
    'status', public.shop_effective_status(p_shop_id),
    'plan', jsonb_build_object(
      'key', pl.key,
      'name', pl.name,
      'price_cents', pl.price_cents,
      'currency', pl.currency,
      'billing_interval', pl.billing_interval
    ),
    'modules', (
      select coalesce(jsonb_agg(m), '[]'::jsonb) from (
        select unnest(pl.modules) as m
        union
        select o.key from public.shop_entitlement_overrides o
        where o.shop_id = p_shop_id and o.kind = 'module'
          and (o.expires_at is null or o.expires_at > now())
      ) resolved
      where public.shop_effective_status(p_shop_id) <> 'suspended'
    ),
    'limits', (
      select coalesce(jsonb_object_agg(r, public.shop_limit(p_shop_id, r)), '{}'::jsonb)
      from unnest(array['locations','products','staff','customers','vendors','sales_per_month']) r
    ),
    'usage', '{}'::jsonb,
    'trial_ends_at', s.trial_ends_at,
    'current_period_end', s.current_period_end,
    'grace_until', s.grace_until
  )
  from public.shop_effective_plan(p_shop_id) pl
  left join public.shop_subscriptions s on s.shop_id = p_shop_id;
$$;

grant execute on function public.shop_effective_status(uuid)   to authenticated;
grant execute on function public.shop_effective_plan(uuid)     to authenticated;
grant execute on function public.shop_has_module(uuid, text)   to authenticated;
grant execute on function public.shop_limit(uuid, text)        to authenticated;
grant execute on function public.my_shop_entitlements(uuid)    to authenticated;
