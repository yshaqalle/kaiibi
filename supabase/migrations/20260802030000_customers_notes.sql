-- People section restructure: the Customers detail pane gets a persistent
-- free-text Notes field (design decision -- see docs/superpowers/plans/
-- 2026-08-02-people-team-hr.md Global Constraints #2). Covered by the
-- existing "read/insert/update/delete customers" policies from
-- 0024_permission_gates.sql -- no new RLS needed, this is just a column.
alter table public.customers add column notes text null;
