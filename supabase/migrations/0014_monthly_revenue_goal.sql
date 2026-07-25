-- A shop-level monthly revenue target, editable in Settings and shown as a
-- progress meter on the dashboard.
alter table public.shops add column if not exists monthly_revenue_goal_cents integer;
