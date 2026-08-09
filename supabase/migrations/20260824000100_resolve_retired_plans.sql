-- shop_effective_plan() follows a retired plan to its successor.
--
-- The alternative was a scheduled job that rewrites plan_id on every affected
-- subscription when the date lands. Rejected for three reasons: there is no
-- pg_cron in this project, 20260818000200's own header argues against "a
-- nightly job whose failure leaves a lapsed shop reading as active", and a
-- bulk rewrite cannot be undone -- once 218 rows have moved, republishing
-- brings nobody back. Resolving at read time means clearing retire_at restores
-- every store instantly, because nothing was destroyed.
--
-- ONE HOP, NOT A CHAIN. A recursive resolve would turn an operator's mistake
-- into an infinite loop inside a function called on every gated write. The
-- edge function refuses to retire into a plan that is itself retiring, and
-- when retiring B it re-points anything whose successor was B onto B's own
-- successor -- so chains are one hop long by construction and this never has
-- to walk one.
--
-- shop_effective_status() is deliberately NOT touched. Retirement changes
-- which plan applies, never what status a store is in: a store on a retired
-- plan has not lapsed and must not read as though it has.

create or replace function public.shop_effective_plan(p_shop_id uuid)
returns public.plans
language sql security definer stable set search_path = public as $$
  with base as (
    select case
      when public.shop_effective_status(p_shop_id) in ('trialing', 'active', 'grace')
        then (select pl.key from public.shop_subscriptions s
                join public.plans pl on pl.id = s.plan_id
               where s.shop_id = p_shop_id)
      else (select ps.post_trial_plan_key from public.platform_settings ps where ps.id)
    end as key
  ),
  hopped as (
    select coalesce(
      (select r.successor_plan_key from public.plans r
        where r.key = (select key from base)
          and r.retire_at is not null
          and r.retire_at <= now()),
      (select key from base)
    ) as key
  )
  select p.* from public.plans p where p.key = (select key from hopped);
$$;
