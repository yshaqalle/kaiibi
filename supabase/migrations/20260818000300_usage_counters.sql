-- Enforcing the numeric side of a plan: how many products, team members,
-- customers, vendors and stores a shop may have.
--
-- Two design choices worth the words.
--
-- 1. A TRIGGER, not an RLS `with check`. RLS would be the obvious home -- it is
--    where the module gates live -- but it fails this job twice. It can only
--    return a bare 403, so the client cannot tell "you hit the Free product
--    cap" from "you aren't allowed to do this" and cannot offer an upgrade;
--    and a `count(*)` subquery inside a WITH CHECK is not safe under
--    concurrency, because two transactions inserting the 50th product both see
--    49 and both pass. A trigger fixes both: it raises a typed error carrying
--    the resource, the limit and the usage, and it takes a row lock first.
--
-- 2. A COUNTER TABLE, not count(*) per insert. The app has never had a
--    server-side count of anything -- every count in the UI today is
--    array.length over a fully-fetched list -- so this is new machinery either
--    way. A counter row makes the check O(1) instead of a scan on a table that
--    only grows, and `select ... for update` on it is what makes the limit
--    EXACT rather than usually-right: concurrent inserts for the same shop and
--    resource serialise on that one row, and on no other shop's.
--
--    It also pays for itself twice: the Billing panel's usage bars and the
--    admin portal's per-shop usage both read it directly, with no scan.

create table public.shop_usage_counters (
  shop_id  uuid not null references public.shops(id) on delete cascade,
  -- Matches LimitResource in src/lib/entitlements.ts and the keys in
  -- plans.limits: 'locations' | 'products' | 'staff' | 'customers' | 'vendors'.
  resource text not null,
  count    integer not null default 0 check (count >= 0),
  primary key (shop_id, resource)
);

alter table public.shop_usage_counters enable row level security;

-- Readable by any member: a cashier who hits a cap needs to be shown what the
-- cap is, and the Billing panel renders these bars for anyone who opens it.
-- No write policy -- the triggers below are security definer and maintain it.
create policy "read own usage" on public.shop_usage_counters for select
  using (is_shop_member(shop_id));

grant select on public.shop_usage_counters to authenticated;

-- BEFORE INSERT. The resource name comes from TG_ARGV[0] so one function serves
-- every limited table.
--
-- security definer because shop_usage_counters has no write policy for anyone;
-- this runs as owner to maintain a table the caller may read but never write.
create or replace function public.enforce_shop_limit()
returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_resource text := TG_ARGV[0];
  v_limit    integer;
  v_count    integer;
begin
  v_limit := public.shop_limit(new.shop_id, v_resource);

  -- Materialise the row before locking it: `for update` on a row that doesn't
  -- exist yet locks nothing, which is exactly the race this guards against.
  insert into public.shop_usage_counters (shop_id, resource, count)
  values (new.shop_id, v_resource, 0)
  on conflict (shop_id, resource) do nothing;

  select c.count into v_count
  from public.shop_usage_counters c
  where c.shop_id = new.shop_id and c.resource = v_resource
  for update;

  -- null limit = unlimited. Still counted, because the Billing panel and the
  -- admin portal show usage for uncapped resources too, and because a plan
  -- change must not have to backfill.
  if v_limit is not null and v_count >= v_limit then
    raise exception 'limit_reached'
      using errcode = 'P0001',
            detail = json_build_object('resource', v_resource, 'limit', v_limit, 'usage', v_count)::text,
            hint = 'Upgrade the plan or remove an existing record.';
  end if;

  update public.shop_usage_counters
  set count = count + 1
  where shop_id = new.shop_id and resource = v_resource;

  return new;
end;
$$;

-- AFTER DELETE. `greatest(count - 1, 0)` rather than a bare decrement so a
-- counter that somehow drifted low can never go negative and trip the check
-- constraint, which would turn a bookkeeping slip into a failed delete.
create or replace function public.decrement_shop_usage()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update public.shop_usage_counters
  set count = greatest(count - 1, 0)
  where shop_id = old.shop_id and resource = TG_ARGV[0];
  return old;
end;
$$;

create trigger shop_locations_limit before insert on public.shop_locations
  for each row execute function public.enforce_shop_limit('locations');
create trigger shop_locations_uncount after delete on public.shop_locations
  for each row execute function public.decrement_shop_usage('locations');

create trigger products_limit before insert on public.products
  for each row execute function public.enforce_shop_limit('products');
create trigger products_uncount after delete on public.products
  for each row execute function public.decrement_shop_usage('products');

create trigger shop_members_limit before insert on public.shop_members
  for each row execute function public.enforce_shop_limit('staff');
create trigger shop_members_uncount after delete on public.shop_members
  for each row execute function public.decrement_shop_usage('staff');

create trigger customers_limit before insert on public.customers
  for each row execute function public.enforce_shop_limit('customers');
create trigger customers_uncount after delete on public.customers
  for each row execute function public.decrement_shop_usage('customers');

create trigger vendors_limit before insert on public.vendors
  for each row execute function public.enforce_shop_limit('vendors');
create trigger vendors_uncount after delete on public.vendors
  for each row execute function public.decrement_shop_usage('vendors');

-- Sales are a rolling window, not a stock: "300 sales a month" resets, so there
-- is nothing to keep a running total of and a counter row would be wrong the
-- moment the month turned. This one really does count, but only over the
-- current month and only when the plan caps it -- so an uncapped shop (every
-- paid tier) pays nothing for it at all.
create or replace function public.enforce_sales_per_month()
returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_limit integer;
  v_count integer;
begin
  v_limit := public.shop_limit(new.shop_id, 'sales_per_month');
  if v_limit is null then
    return new;
  end if;

  select count(*) into v_count
  from public.sales s
  where s.shop_id = new.shop_id and s.created_at >= date_trunc('month', now());

  if v_count >= v_limit then
    raise exception 'limit_reached'
      using errcode = 'P0001',
            detail = json_build_object('resource', 'sales_per_month', 'limit', v_limit, 'usage', v_count)::text,
            hint = 'Upgrade the plan to keep selling this month.';
  end if;

  return new;
end;
$$;

create trigger sales_monthly_limit before insert on public.sales
  for each row execute function public.enforce_sales_per_month();

-- Seed the counters from what every shop already has. Without this every shop
-- reads as zero usage and the first insert is allowed regardless of how far
-- over the cap they already are.
insert into public.shop_usage_counters (shop_id, resource, count)
select s.id, 'locations', (select count(*) from public.shop_locations l where l.shop_id = s.id) from public.shops s
union all
select s.id, 'products',  (select count(*) from public.products p      where p.shop_id = s.id) from public.shops s
union all
select s.id, 'staff',     (select count(*) from public.shop_members m  where m.shop_id = s.id) from public.shops s
union all
select s.id, 'customers', (select count(*) from public.customers c     where c.shop_id = s.id) from public.shops s
union all
select s.id, 'vendors',   (select count(*) from public.vendors v       where v.shop_id = s.id) from public.shops s
on conflict (shop_id, resource) do nothing;

-- Reproduced whole (per 0024_permission_gates.sql:240-259) rather than patched,
-- now that shop_usage_counters exists to fill in `usage`. Only that one key
-- changes; everything else is identical to 20260818000200.
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
    'usage', (
      select coalesce(jsonb_object_agg(c.resource, c.count), '{}'::jsonb)
             || jsonb_build_object('sales_per_month', (
                  select count(*) from public.sales s
                  where s.shop_id = p_shop_id and s.created_at >= date_trunc('month', now())
                ))
      from public.shop_usage_counters c
      where c.shop_id = p_shop_id
    ),
    'trial_ends_at', s.trial_ends_at,
    'current_period_end', s.current_period_end,
    'grace_until', s.grace_until
  )
  from public.shop_effective_plan(p_shop_id) pl
  left join public.shop_subscriptions s on s.shop_id = p_shop_id;
$$;

grant execute on function public.my_shop_entitlements(uuid) to authenticated;
