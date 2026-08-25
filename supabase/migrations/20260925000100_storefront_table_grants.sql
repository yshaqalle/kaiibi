-- The grants 20260924000000 forgot.
--
-- That migration created `storefronts` and `storefront_delivery_areas`, enabled
-- RLS on both, and wrote member policies for them -- but never granted the
-- tables to `authenticated`. RLS narrows what a role may see; it does not grant
-- the role reach in the first place. So both policies were decorative: every
-- read and write from the app returned
--
--   42501 permission denied for table storefronts
--
-- It shipped and merged unnoticed because nothing exercised the path. The public
-- storefront reads go through `security definer` functions, which execute as the
-- owner and bypass table privileges entirely, and every check in
-- supabase/tests/ runs as `postgres`, a superuser that no grant can stop. The
-- first thing to actually read these tables as `authenticated` was the editor's
-- data layer, one plan later.
--
-- The house convention is an explicit per-table grant at creation --
-- 0003_grants.sql for the original tables, then each new table's own migration
-- (0004_categories_tags.sql:80-81, 0005_sale_payments.sql:18). There is no
-- `alter default privileges` making this automatic, which is exactly why a new
-- table that omits it fails silently rather than loudly.
--
-- `anon` deliberately gets nothing. Unauthenticated readers reach a published
-- storefront only through get_public_storefront() and its siblings, whose
-- explicit column lists are what keep products.cost_cents unreachable. Granting
-- anon direct table access would route around that.

grant select, insert, update, delete on public.storefronts to authenticated;
grant select, insert, update, delete on public.storefront_delivery_areas to authenticated;
