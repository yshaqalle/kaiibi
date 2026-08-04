-- A revenue goal belongs to a store, not to the business.
--
-- A flagship on the main road and a kiosk by the market do not carry the same
-- target, and a single business-wide number tells neither of them whether they
-- had a good month. The goal is also the one figure staff are actually managed
-- against, which makes "whose goal is this" a question with a real answer.
--
-- Moved rather than duplicated, for the reason 20260811000000 spells out about
-- the address: two writable copies of one fact drift, and the business-level
-- total is derivable by summing the stores whenever it is wanted. Adding a
-- separately-editable business goal on top would immediately raise "what if it
-- disagrees with the sum", which is a question with no good answer.

alter table public.shop_locations
  add column monthly_revenue_goal_cents integer
  check (monthly_revenue_goal_cents is null or monthly_revenue_goal_cents >= 0);

comment on column public.shop_locations.monthly_revenue_goal_cents is
  'This store''s monthly revenue target, in cents. Null until set — the dashboard goal meter is hidden rather than showing a zero target. The business-wide figure is the sum across stores, never stored separately.';

-- Every existing shop has exactly one store at this point (20260808000000
-- backfilled it), so the goal it already had is unambiguously that store's.
update public.shop_locations l
  set monthly_revenue_goal_cents = s.monthly_revenue_goal_cents
  from public.shops s
  where s.id = l.shop_id and s.monthly_revenue_goal_cents is not null;

alter table public.shops drop column monthly_revenue_goal_cents;
