-- A month of grace, not a week -- and the month applies to the shops that
-- already exist.
--
-- WHAT WAS WRONG. Nothing about how grace is HONOURED: a shop in grace
-- already keeps its own plan and therefore its own modules
-- (shop_effective_plan, 20260824000100:31, keeps the shop's plan for
-- 'trialing' | 'active' | 'grace' and falls back to `free` only for 'expired'
-- and 'suspended'). shop_has_module() names only `suspended` and never
-- mentions grace, which reads like a gap and is not one -- it is decided a
-- level down. What was wrong was the NUMBER: platform_settings
-- .default_grace_days was 7, and the decision is one month.
--
-- WHY A BACKFILL AND NOT JUST A NEW DEFAULT. grace_until is STAMPED FORWARD,
-- never recomputed: the trial trigger (20260818000100:32-39) writes trial end
-- + N days at signup, and extend_trial / record_payment
-- (supabase/functions/platform-admin/index.ts) rewrite it when an operator
-- extends or records money. There is no clock anywhere in this project -- no
-- pg_cron, no scheduled job -- that would revisit a stamped row. So changing
-- the default alone changes nothing for anybody who already has a
-- subscription, and today that is everybody: seven of eleven live shops are
-- on Trial with a seven-day window already written down, the first of them
-- lapsing 2 November 2026. The decision would take effect for nobody who
-- prompted it.
--
-- THE RULE. Each row's window is measured from the end of its paid-or-trial
-- time: the LATER of current_period_end and trial_ends_at, whichever that
-- turns out to be. `greatest`, not `coalesce`. The two writers above disagree
-- about which column is the base -- record_payment measures from coversTo
-- (index.ts:472), extend_trial measures from the trial end (index.ts:404-411)
-- -- so a row can legitimately carry both, and `coalesce` would take
-- current_period_end unconditionally even when it is in the past and the
-- trial runs on for another year. That row would be stamped with a window
-- that had ALREADY ENDED and would drop out of trialing into expired with
-- zero grace: the exact failure this migration exists to prevent. No writer
-- alive today produces that shape, but a migration cannot be amended after it
-- has run, so the base is the later date and the case is pinned in
-- verify-lapse.sql section D (the `inverted-dates` fixture).
--
-- `greatest` ignores NULLs and returns NULL only when every argument is NULL,
-- so a row with NEITHER date still comes out NULL and is left alone: there is
-- no end-of-time to measure a month from, and inventing one would hand a free
-- month to a row whose dates somebody deliberately cleared.
--
-- ONLY EVER LONGER. A row whose grace_until is already later than the rule
-- would make it is left untouched. extend_trial exists so an operator can
-- give a particular shop more room, and a migration that quietly claws that
-- back would be worse than the bug it fixes.
--
-- WHAT THIS VISIBLY CHANGES. A shop whose seven-day window has already run
-- out is, under a thirty-day one, back in grace -- so a storefront that is
-- dark today comes back. That is not a side effect to be engineered around;
-- it is the decision ("keep the data, show the way back") applied to the shop
-- that needed it first. The count is printed below so whoever runs this can
-- see how many shops it touches before it touches them.
--
-- NOT CHANGED HERE, deliberately: which plans include `storefront`, and
-- anything about unpublishing at the end of the month. Those are separate
-- decisions with separate tasks.
--
-- IDEMPOTENT ON PURPOSE. Every statement below is guarded, so the file can be
-- applied twice without doing anything the second time. supabase/tests/
-- verify-lapse.sql section D relies on that: it builds rows in the shape
-- production has today and re-runs THIS FILE over them, rather than testing a
-- copy of the backfill pasted into the test.

-- The forward-looking knob, for every shop created or paid for from now on.
-- The trial trigger and both edge-function writers already read this column,
-- so none of them needs touching.
alter table public.platform_settings
  alter column default_grace_days set default 30;

-- The one live row. `< 30` and not `= 7`: if an operator has already set this
-- higher from the platform portal, that is a deliberate choice and a wider
-- window than the decision asked for, so leave it.
update public.platform_settings
   set default_grace_days = 30,
       updated_at         = now()
 where id and default_grace_days < 30;

-- The catch-up, for rows stamped before the line above existed.
do $$
declare
  v_window    interval;
  v_extended  integer;
  v_revived   integer;
  v_dateless  integer;
  v_short     integer;
begin
  -- Read the setting rather than hardcoding, so the backfill and every future
  -- stamp agree on one number. coalesce only for the case where somebody has
  -- deleted the singleton settings row, which would otherwise make this a
  -- silent no-op.
  select make_interval(days => coalesce(max(default_grace_days), 30))
    into v_window
    from public.platform_settings where id;

  select count(*) into v_dateless
    from public.shop_subscriptions
   where greatest(current_period_end, trial_ends_at) is null;

  -- Counted BEFORE the update, because shop_effective_status() reads the rows
  -- that are about to change.
  --
  -- The only transition this update can cause is expired -> grace, which is
  -- why one number is enough to describe it. manual_status is untouched, so
  -- 'suspended' cannot move. 'trialing' and 'active' are both decided on
  -- dates tested BEFORE grace_until is ever looked at (20260818000200:21-28),
  -- so neither can move either. And a shop already in 'grace' has now() <
  -- grace_until, which stays true when grace_until only ever moves later.
  select count(*) into v_revived
    from public.shop_subscriptions s
   where public.shop_effective_status(s.shop_id) = 'expired'
     and greatest(s.current_period_end, s.trial_ends_at) is not null
     and (s.grace_until is null
          or s.grace_until < greatest(s.current_period_end, s.trial_ends_at) + v_window)
     and greatest(s.current_period_end, s.trial_ends_at) + v_window > now();

  -- Every row with a base date is widened, including rows so far past their
  -- window that a month more changes nothing -- the rule stays uniform, and a
  -- row whose grace_until disagrees with the rule is a row the next reader has
  -- to reason about twice. The cost is that v_extended counts those rewrites
  -- too, which is why the notice below reports them separately from the
  -- number a human would act on.
  update public.shop_subscriptions s
     set grace_until = greatest(s.current_period_end, s.trial_ends_at) + v_window,
         updated_at  = now()
   where greatest(s.current_period_end, s.trial_ends_at) is not null
     and (s.grace_until is null
          or s.grace_until < greatest(s.current_period_end, s.trial_ends_at) + v_window);
  get diagnostics v_extended = row_count;

  -- Two different numbers, said as two different numbers. v_extended is
  -- bookkeeping: most of it is a later date written onto a row whose status
  -- does not move, including long-dead rows that stay expired either way.
  -- v_revived is the one with a consequence in the world -- shops whose
  -- storefront is dark right now and is lit again by this statement -- so it
  -- is the number to read, and to check against afterwards.
  raise notice 'grace is now %: % subscription(s) had a wider window written (bookkeeping -- most change no status, and rows already long past grace stay expired). THE NUMBER THAT MATTERS: % of them come back out of expired and into grace, i.e. % dark storefront(s) return. % row(s) left alone for having neither a period end nor a trial end.',
    v_window, v_extended, v_revived, v_revived, v_dateless;

  -- The postcondition. Deliberately NOT the UPDATE's own predicate: measured
  -- against v_window it would be 0 by construction -- the same expression
  -- evaluated twice a few lines apart, which can only detect a typo between
  -- the two copies, never a fact about the data. It is measured instead
  -- against the DECISION, the literal 30 days, which nothing above derives
  -- from. That is safe against an operator who set the platform setting
  -- higher: the update two statements up raises the setting to at least 30,
  -- so v_window >= 30 days and base + v_window >= base + 30 days for every
  -- row, whether this backfill rewrote it or left it long.
  select count(*) into v_short
    from public.shop_subscriptions s
   where greatest(s.current_period_end, s.trial_ends_at) is not null
     and (s.grace_until is null
          or s.grace_until < greatest(s.current_period_end, s.trial_ends_at) + interval '30 days');
  if v_short > 0 then
    raise exception 'grace backfill left % subscription(s) with less than 30 days of grace after their period or trial end', v_short;
  end if;
end $$;
