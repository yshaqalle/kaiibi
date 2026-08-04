-- Every new shop starts on a full-access trial, set by the server.
--
-- This is a trigger and not a line in createShop() (src/lib/shops.ts) for one
-- reason: the client must not choose its own trial window. createShop() inserts
-- name, city, phone and categories straight from the signup form, and a
-- trial_ends_at written the same way would be a text field the user could set
-- to the year 3000. The date has to be computed somewhere the client cannot
-- reach, and this is the cheapest such place.
--
-- security definer is required, not stylistic: shop_subscriptions has no
-- insert policy for anyone and `authenticated` holds select only
-- (20260818000000), so this function would fail as the calling user. It runs as
-- owner to write the one row the caller is entitled to have but not to write.
create or replace function public.start_shop_trial()
returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_settings public.platform_settings;
  v_plan_id  uuid;
begin
  select * into v_settings from public.platform_settings where id;
  select id into v_plan_id from public.plans where key = 'trial';

  -- No trial plan seeded means someone deleted it. Let the shop be created
  -- anyway: shop_effective_plan() resolves a subscription-less shop to the
  -- post-trial plan rather than to "everything", so the failure mode is a shop
  -- on Free -- recoverable by an operator -- instead of a signup that 500s.
  if v_plan_id is null or v_settings is null then
    return new;
  end if;

  insert into public.shop_subscriptions (shop_id, plan_id, trial_ends_at, grace_until)
  values (
    new.id,
    v_plan_id,
    now() + make_interval(days => v_settings.default_trial_days),
    now() + make_interval(days => v_settings.default_trial_days + v_settings.default_grace_days)
  )
  on conflict (shop_id) do nothing;

  return new;
end;
$$;

create trigger shops_start_trial
  after insert on public.shops
  for each row execute function public.start_shop_trial();

-- Existing shops get the same trial, dated from now rather than from their
-- creation date. Dating it from created_at would mean every shop older than
-- three months is expired the moment this migration lands -- shipping billing
-- as an outage for exactly the customers who stuck around longest.
insert into public.shop_subscriptions (shop_id, plan_id, trial_ends_at, grace_until)
select
  s.id,
  p.id,
  now() + make_interval(days => ps.default_trial_days),
  now() + make_interval(days => ps.default_trial_days + ps.default_grace_days)
from public.shops s
cross join public.platform_settings ps
join public.plans p on p.key = 'trial'
where ps.id
on conflict (shop_id) do nothing;
