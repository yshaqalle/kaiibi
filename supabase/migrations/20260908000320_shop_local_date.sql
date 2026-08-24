-- The shop's local calendar date, in one place.
--
-- `entry_date` on a journal entry must be the shop's LOCAL date, not the
-- database server's. A bare `now()::date` resolves in the session's
-- timezone -- UTC on Supabase -- and Somalia is UTC+3, so a sale rung up at
-- 01:30 local on the 1st is 22:30 UTC on the last day of the PREVIOUS month
-- and posts to the wrong period. Once that period closes, a posted entry
-- cannot be re-dated, so the mistake is permanent.
--
-- 'Africa/Mogadishu' is a PLATFORM CONSTANT, deliberately. Every market
-- kaiibi serves is UTC+3 -- Somalia, Somaliland, Ethiopia, Djibouti, Kenya --
-- so one constant is correct today for every shop on the system. There is
-- deliberately NO shops.timezone column: adding one means a migration, a
-- settings screen, a default for every existing shop, and a second source of
-- truth for src/lib/period.ts to learn about. That is a bigger change than
-- this problem justifies right now. It was considered and declined, not
-- missed -- do not "fix" it as an oversight. When kaiibi sells into a market
-- that is not UTC+3, this function is the one place that has to change to a
-- per-shop setting.
--
-- Why a function rather than the expression inlined at each call site: the
-- expression already exists in TWO places by construction (complete_sale's
-- entry date, and its "period is closed" redirect date), and this plan is
-- about to add it to five more RPCs. Two copies is how call sites come to
-- disagree; a function is how they cannot.
--
-- complete_sale (20260908000300_sale_entry_date.sql) still carries this
-- expression inline rather than calling this function. That is intentional
-- for now: complete_sale is a ~400-line function reproduced in full on every
-- edit, and switching two lines to a function call is not worth a
-- twentieth copy-forward on its own. Make the switch the next time
-- complete_sale is copied forward for a substantive reason, not before.
create or replace function public.shop_local_date(p_at timestamptz default now())
returns date
language sql immutable as $$
  select (p_at at time zone 'Africa/Mogadishu')::date;
$$;

grant execute on function public.shop_local_date(timestamptz) to authenticated;
