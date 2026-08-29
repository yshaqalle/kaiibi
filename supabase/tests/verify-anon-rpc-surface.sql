-- The anon RPC surface, pinned.
--
-- WHAT THIS IS FOR. Postgres grants EXECUTE on a new function to PUBLIC by
-- default, and PUBLIC includes `anon` -- a caller with no session at all. That
-- default is how #83 shipped a `post_journal_entry` a stranger could post
-- into, and how six more functions were leaking a shop's plan, usage and
-- billing dates until 20261009000000. Both were found by someone going
-- looking. This check means the next one is found by CI instead.
--
-- WHY A PIN AND NOT A PROBE. The obvious version calls every RPC as anon and
-- looks at the status code. It is the wrong tool twice over: several of these
-- functions MUTATE -- `recompute_product_stock`, `place_storefront_order` --
-- so a probe that actually invokes them has side effects, and a 401/200 tells
-- you nothing about a function whose own body does the authorising. What
-- actually recurs is a function shipping with the DEFAULT grant nobody thought
-- about, and that is visible in the catalog without calling anything.
--
-- WHAT A FAILURE MEANS. Not "you have a vulnerability". It means the set of
-- functions reachable without a session CHANGED, and somebody has to say which
-- of the two it is:
--
--   added   -- a new function took the PUBLIC default. Almost always an
--              oversight: revoke it, or add it here with a reason.
--   removed -- a revoke landed. Good; drop the name from this list.
--
-- THE LIST IS NOW THE WHOLE LEGITIMATE ANON SURFACE, not just "the surface as
-- it stands". An earlier version of this file pinned 74 functions and said the
-- narrowing was real work nobody had done. It has been done:
-- 20261009000100 revoked anon from the other 70, each verified to have no
-- pre-authentication caller (seven adversarial reading passes plus a
-- completeness map of every public route). What remains is four functions with
-- an EXPLICIT anon grant, because a logged-out customer genuinely calls them to
-- browse a storefront and place an order. Anything else appearing here is a
-- regression: a new function that took the PUBLIC default, or an anon grant
-- added without a public flow to justify it.
--
-- Trigger functions are excluded: PostgREST will not call them and they are
-- not reachable as RPCs, so pinning them would be noise that changes whenever
-- a trigger is added.

\set ON_ERROR_STOP on

do $$
declare
  v_expected text[] := array[
    -- The deliberate public storefront: a logged-out customer browses a shop
    -- and places an order. These four carry an EXPLICIT anon grant, not the
    -- PUBLIC default, and are the entire legitimate anonymous RPC surface.
    'get_public_delivery_areas',
    'get_public_storefront',
    'get_public_storefront_products',
    'place_storefront_order'
  ];
  v_actual  text[];
  v_added   text[];
  v_removed text[];
begin
  select coalesce(array_agg(distinct p.proname order by p.proname), '{}')
    into v_actual
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    join pg_type t on t.oid = p.prorettype
   where n.nspname = 'public'
     and p.prokind = 'f'
     and t.typname <> 'trigger'
     and has_function_privilege('anon', p.oid, 'EXECUTE');

  select coalesce(array_agg(x order by x), '{}') into v_added
    from unnest(v_actual) x where x <> all (v_expected);

  select coalesce(array_agg(x order by x), '{}') into v_removed
    from unnest(v_expected) x where x <> all (v_actual);

  -- Reported separately, because they are different events with different
  -- responses. A single "the list changed" would let an addition hide behind
  -- a removal in the same migration.
  if array_length(v_added, 1) is not null then
    raise exception 'FAIL: % function(s) became callable by anon and are not pinned: %. Revoke EXECUTE from PUBLIC, or add them here with a reason.',
      array_length(v_added, 1), array_to_string(v_added, ', ');
  end if;

  if array_length(v_removed, 1) is not null then
    raise exception 'FAIL: % pinned function(s) are no longer callable by anon: %. That is progress -- remove them from the list in this file.',
      array_length(v_removed, 1), array_to_string(v_removed, ', ');
  end if;

  raise notice 'ALL CHECKS PASSED: % functions reachable by anon, all pinned', array_length(v_actual, 1);
end $$;
