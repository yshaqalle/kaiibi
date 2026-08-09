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
-- into an infinite loop inside a function called on every gated write. A
-- later edge function will refuse to retire into a plan that is itself
-- retiring, and when retiring B will re-point anything whose successor was B
-- onto B's own successor -- so chains will be one hop long by construction
-- and this will never have to walk one. That edge function does not exist
-- yet, so today an operator could hand-enter a two-link chain by editing
-- plans directly; this function still lands safely on the intermediate
-- retired plan rather than looping or returning NULL, just without hopping
-- the second link.
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
    -- coalesce falls back to the base key whenever the inner select returns
    -- no row: either the base plan isn't retiring, or its retire_at hasn't
    -- landed yet. It can never fall back to a NULL successor_plan_key while a
    -- row does match, because plans_retire_needs_successor (20260824000000)
    -- makes retire_at is not null without a successor_plan_key unreachable.
    select coalesce(
      (select r.successor_plan_key from public.plans r
        where r.key = (select key from base)
          and r.retire_at is not null
          and r.retire_at <= now()),
      (select key from base)
    ) as key
  )
  -- The FK from plans.successor_plan_key to plans(key) is what guarantees the
  -- hop lands on a real row, so this select is what keeps the function from
  -- ever returning NULL instead of a plan.
  select p.* from public.plans p where p.key = (select key from hopped);
$$;
