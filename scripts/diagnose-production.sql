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
\echo '    20261010000100 and 20261014000000 are the two that matter today.'
\echo '    20261014000000, NOT 20261011000000 -- the same register fix under'
\echo '    a number db push can still reach. And READ THIS LIST FOR CONTEXT,'
\echo '    NEVER FOR A VERDICT: a recorded version proves a number was'
\echo '    written down, not that its body ran. Check 2 answers the register'
\echo '    question. This check cannot.'
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
--
-- THE LAST ARGUMENT NAME IS BACK, and only that one. Dropping the whole name
-- list to escape the pager left this check counting to fifteen and nothing
-- more, so a fifteen-argument complete_sale that was not this repo's
-- fifteen-argument complete_sale read as OK -- while the banner above went on
-- telling the reader to expect a name the output no longer showed. One name is
-- twenty characters, not a few hundred, so it cannot bring the pager back, and
-- the verdict TESTS it rather than leaving the comparison to the eye.
--
-- WHAT THIS DOES NOT DO, said plainly so nobody reads more into an OK than is
-- there: it pins the LAST argument and not the other fourteen. That is the
-- position the hole appeared in -- a trailing p_require_register with a
-- default, which is the only shape a new parameter can take without breaking
-- every existing caller -- so it is the position worth one cheap assertion.
-- A renamed argument in the middle would still read as OK here. The check
-- that would catch that is a full signature comparison, and it belongs in the
-- test suite against a known-good database, not in a script whose job is to
-- interrogate a production catalog it cannot diff against anything.
--
-- proargnames[pronargs] is the last INPUT argument: safe here because
-- complete_sale returns jsonb and declares no OUT parameters, so the two
-- arrays are indexed alike. Unnamed arguments give NULL, which `is distinct
-- from` sends to WRONG SHAPE rather than silently to OK.
select coalesce(string_agg(p.pronargs::text, ' + ' order by p.pronargs),
                'NONE -- complete_sale is missing entirely')       as arg_counts,
       coalesce(max(p.proargnames[p.pronargs]), '-')               as last_argument,
       case when count(*) = 0 then 'BROKEN -- complete_sale does not exist'
            when count(*) > 1 or max(p.pronargs) <> 15
                 then 'EXPOSED -- push 20261014000000'
            when max(p.proargnames[p.pronargs]) is distinct from 'p_prices_include_tax'
                 then 'WRONG SHAPE -- fifteen arguments, but not the ones this repo declares'
            else 'OK -- the register guard is not a parameter' end as verdict
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
\echo '    The surface was deliberately narrowed from 74 to 4, and every'
\echo '    addition since has had to argue for itself. An UNEXPECTED name is'
\echo '    a function that took the PUBLIC default nobody thought about --'
\echo '    that is how a post_journal_entry a stranger could post into once'
\echo '    shipped. A MISSING name is a revoke that landed; good news, but'
\echo '    say so out loud rather than letting the list quietly shrink.'
\echo '    TWO of these WRITE, and the other four only read.'
\echo '    place_storefront_order is the older and the larger: it creates the'
\echo '    order, its lines and its number, and has been anon-callable since'
\echo '    the storefront shipped. Its safety is that it writes only rows it'
\echo '    authors, never rows it was handed. confirm_public_order is the one'
\echo '    the order link added, and it stamps an agreement and nothing else'
\echo '    -- it cannot alter a line, a total, a status, or cancel anything.'
-- THE COUNT AND THE NAMES USED TO BE PROSE IN THE BANNER ABOVE, and prose is
-- the one thing in this file nothing checks. It said FOUR for the whole life
-- of a six-function surface, and later described a two-write surface as
-- having one write. Both were found by someone reading, which is the slowest
-- detector there is and the one this script exists to replace.
--
-- So the names are DATA now, and the query below compares them to the
-- catalog instead of asking the reader to. The banner keeps only what cannot
-- be checked -- why the surface is what it is, and what the two writes can
-- and cannot do -- and states no count at all.
--
-- Kept byte-identical to the array in supabase/tests/verify-anon-rpc-surface.sql,
-- which is the copy CI enforces on every migration. Two files still hold the
-- list because this script has to run standalone against a production URL,
-- with no repo and no test suite around it. supabase/tests/verify-diagnostic-
-- anon-list.sh is what makes that duplication safe: it fails the moment the
-- two lists disagree, so the fact is written twice but can only be true once.
-- Read the pin file for WHY each name is on the list; it carries the argument.
with expected(proname) as (values
  -- >>> PINNED ANON SURFACE >>>
  ('confirm_public_order'),
  ('get_public_delivery_areas'),
  ('get_public_order'),
  ('get_public_storefront'),
  ('get_public_storefront_products'),
  ('place_storefront_order')
  -- <<< PINNED ANON SURFACE <<<
),
actual(proname) as (
  select p.proname
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.prokind = 'f'
     and exists (select 1 from unnest(p.proacl) a where a::text like 'anon=%')
),
diff as (
  select coalesce(a.proname, e.proname) as anon_callable,
         case when e.proname is null then 'UNEXPECTED -- not pinned. Revoke it, or justify it in the pin file.'
              when a.proname is null then 'MISSING -- pinned but no longer anon-callable. Drop it from both lists.'
              else 'pinned and present' end as status
    from expected e
    full outer join actual a on a.proname = e.proname
)
-- The verdict is UNION'd in rather than run as a second query, so that this
-- check can never print zero rows the way check 2 once did. It sorts first
-- because '(' precedes every letter.
select anon_callable, status from diff
union all
select '(verdict)',
       case when exists (select 1 from diff where status <> 'pinned and present')
            then 'DRIFT -- read the UNEXPECTED or MISSING row above'
            else 'OK -- exactly the pinned surface, nothing more' end
 order by 1;

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
