-- Withdrawing a tier from sale, gracefully.
--
-- 20260818000000 put plans in a table so "pricing and packaging change from the
-- admin portal without a deploy". Withdrawing a tier was the exception: it took
-- a code edit (0be1bae removed Free from landing-plans.tsx and two i18n files),
-- and that edit only changed the marketing page -- the tier stayed in
-- listPlans() and was still offered inside the app.
--
-- Retirement is deliberately NOT `active = false`. That column stays the hard
-- "this plan is gone" switch, protected by the on delete restrict on
-- shop_subscriptions.plan_id. This is the graceful path that runs first:
-- hidden from the chooser now, stores moved on a date they were told about.

alter table public.plans
  -- The date stores MOVE, not the date the plan was hidden. Hiding is
  -- is_public = false and happens the moment the operator acts.
  add column retire_at          timestamptz,
  -- Where they land. References key rather than id because key is the stable
  -- identifier everything else in this schema hangs off (see
  -- platform_settings.post_trial_plan_key), and because the FK then guarantees
  -- the successor exists without the resolver having to check.
  add column successor_plan_key text references public.plans(key);

alter table public.plans
  -- A retirement with nowhere to go would strand every store on it at the
  -- moment the date passed.
  add constraint plans_retire_needs_successor
    check (retire_at is null or successor_plan_key is not null),
  -- Self-succession resolves to itself forever: the plan would read as retired
  -- and never actually move anyone.
  add constraint plans_successor_not_self
    check (successor_plan_key is distinct from key);
