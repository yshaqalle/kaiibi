-- Read-only. Changes nothing. Safe to run against production.
--
--   psql "$PROD_DB_URL" -f scripts/diagnose-production.sql
--
-- Answers three questions the repo cannot answer about a deployed database:
-- which migrations it thinks it has, whether complete_sale carries the
-- register off-switch, and whether PUBLIC can execute anything it should not.
--
-- WHY A CATALOG READ AND NOT A FILE DIFF. Production recorded migration
-- 20261010000000 as applied while holding a DIFFERENT function body than the
-- file of that name in this repo -- a second branch deployed its own version
-- first. `db push` will never re-run a version it has already recorded, so
-- every file-based check said the database was correct while it was not. Only
-- pg_proc knows what is actually deployed.

-- PAGER OFF, and this line is load-bearing rather than tidy. Check 2 below
-- was silently swallowed on three separate production runs: it was the only
-- query here wide enough to trip psql's pager, and a paged result in a
-- scripted run prints the \echo header, no rows, and carries on to the next
-- check. The one answer this script exists to give was the one it never gave.
\pset pager off

\echo ''
\echo '=== 1. The last ten migrations this database records as applied ==='
\echo '    Compare against: ls supabase/migrations | tail -10'
\echo '    20261010000100 and 20261011000000 are the two that matter today.'
select version
  from supabase_migrations.schema_migrations
 order by version desc
 limit 10;

\echo ''
\echo '=== 2. complete_sale: is the register off-switch present? ==='
\echo '    EXPECT 15 arguments ending p_prices_include_tax.'
\echo '    16 arguments -- under ANY name -- means any member with pos.access'
\echo '    can defeat a shop''s require_open_register setting with one extra'
\echo '    JSON field. That is the hole 20261011000000 closes.'
-- AGGREGATED, so this ALWAYS returns exactly one row. The previous version
-- selected one row per overload and printed the full argument NAME LIST --
-- a few hundred characters wide, which is what tripped the pager. It also
-- meant "no output" was ambiguous between a swallowed result and a function
-- that does not exist. Now silence is impossible and a missing function says
-- so in words.
select coalesce(string_agg(p.pronargs::text, ' + ' order by p.pronargs),
                'NONE -- complete_sale is missing entirely')       as arg_counts,
       case when count(*) = 1 and max(p.pronargs) = 15 then 'OK -- the register guard is not a parameter'
            when count(*) = 0                          then 'BROKEN -- complete_sale does not exist'
            else 'EXPOSED -- push 20261014000000' end              as verdict
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname = 'complete_sale';

\echo ''
\echo '=== 3. Does PUBLIC hold EXECUTE on anything callable? ==='
\echo '    PUBLIC includes anon, so this is the unauthenticated surface.'
\echo '    Trigger functions are EXCLUDED: Postgres refuses to call one'
\echo '    directly ("trigger functions can only be called as triggers") and'
\echo '    PostgREST does not expose them at all, so a grant on one is inert.'
\echo '    EXPECT ZERO ROWS.'
select p.proname,
       pg_get_function_result(p.oid) as returns,
       case when p.prosecdef then 'SECURITY DEFINER -- runs as owner' else 'invoker' end as runs_as
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and p.prokind = 'f'
   and pg_get_function_result(p.oid) <> 'trigger'
   and (p.proacl is null                                             -- never granted IS public execute
        or exists (select 1 from unnest(p.proacl) a where a::text like '=%'))
 order by p.prosecdef desc, p.proname;

\echo ''
\echo '=== 4. The intended anon RPC surface ==='
\echo '    EXPECT EXACTLY SIX: get_public_storefront,'
\echo '    get_public_storefront_products, get_public_delivery_areas,'
\echo '    place_storefront_order, and -- since 20261017000000 --'
\echo '    get_public_order and confirm_public_order, the customer''s own'
\echo '    order link. A SEVENTH is a decision, not an accident: the surface'
\echo '    was deliberately narrowed from 74 to 4, and every addition since'
\echo '    has had to argue for itself in verify-anon-rpc-surface.sql.'
\echo '    confirm_public_order is the only WRITE on this list. It stamps an'
\echo '    agreement and nothing else -- it cannot alter a line, a total, a'
\echo '    status, or cancel anything.'
select p.proname
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and p.prokind = 'f'
   and exists (select 1 from unnest(p.proacl) a where a::text like 'anon=%')
 order by p.proname;

\echo ''
\echo '=== 5. Is the pick-up address live? ==='
\echo '    collect_address is what a collect order tells the customer. Absent'
\echo '    means 20261010000100 has not been applied.'
select case when pg_get_function_result(p.oid) like '%collect_address%'
            then 'OK -- a collect order can name the shop''s address'
            else 'MISSING -- push 20261010000100' end as pick_up_address
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname = 'get_public_storefront';

\echo ''
\echo '=== Done. Nothing was changed. ==='
