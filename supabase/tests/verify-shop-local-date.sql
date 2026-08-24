-- public.shop_local_date() converts a moment into the shop's local calendar
-- date, so it must cross a UTC/local day boundary correctly and must be
-- IMMUTABLE -- the property that lets a caller use it in an index or a
-- generated column later without it being re-planned per row.
--
-- Two timestamps, both on 2026-04-30 UTC, fifteen minutes apart, on either
-- side of the UTC+3 midnight boundary (21:00 UTC = 00:00 local):
--
--   1. THE ONE THAT MATTERS. 22:30 UTC is 01:30 local on 2026-05-01 -- UTC
--      and local land in different MONTHS, so a wrong implementation
--      (`p_at::date`, ignoring the timezone entirely) cannot pass by
--      coincidence.
--   2. 20:59 UTC is 23:59 local, still 2026-04-30. This sits right before
--      the same boundary, so a wrong implementation that always adds a day
--      (`p_at::date + 1`) cannot pass either -- only a real timezone
--      conversion gets both checks right.
--
-- Nothing here writes a row, so there is nothing to build or roll back, but
-- the DO block keeps this script in the same shape as every other verify
-- script in this directory.

\set ON_ERROR_STOP on

do $$
declare
  v_result   date;
  v_volatile "char";
begin
  -- 1. THE ONE THAT MATTERS: crosses the month boundary.
  --    Mutation: change the function body to `select p_at::date` (drop the
  --    `at time zone` conversion entirely). Expected:
  --    FAIL: 2026-04-30 22:30:00+00 should be 2026-05-01 local, got 2026-04-30
  v_result := public.shop_local_date('2026-04-30 22:30:00+00'::timestamptz);
  if v_result <> '2026-05-01'::date then
    raise exception 'FAIL: 2026-04-30 22:30:00+00 should be 2026-05-01 local, got %', v_result;
  end if;

  -- 2. Just inside the same day -- rules out an implementation that patches
  --    check 1 by always adding a day to the UTC date instead of doing a real
  --    timezone conversion.
  --    Mutation: change the function body to `select p_at::date + 1` (drop
  --    the `at time zone` conversion, shift the UTC date instead). This
  --    still passes check 1 (04-30 + 1 = 05-01, the expected answer) --
  --    only this check catches it. Expected:
  --    FAIL: 2026-04-30 20:59:00+00 should be 2026-04-30 local, got 2026-05-01
  v_result := public.shop_local_date('2026-04-30 20:59:00+00'::timestamptz);
  if v_result <> '2026-04-30'::date then
    raise exception 'FAIL: 2026-04-30 20:59:00+00 should be 2026-04-30 local, got %', v_result;
  end if;

  -- 3. IMMUTABLE, not merely correct. A caller who indexes on this function
  --    or puts it in a generated column relies on Postgres never needing to
  --    re-evaluate it once planned; STABLE or VOLATILE would silently make
  --    that unsafe without changing a single answer above.
  --    Mutation: change the function's volatility to `stable`. Expected:
  --    FAIL: shop_local_date should be IMMUTABLE (provolatile = 'i'), got s
  select provolatile into v_volatile
    from pg_proc
   where oid = 'public.shop_local_date(timestamptz)'::regprocedure;
  if v_volatile <> 'i' then
    raise exception 'FAIL: shop_local_date should be IMMUTABLE (provolatile = ''i''), got %', v_volatile;
  end if;

  raise notice 'ALL CHECKS PASSED';
  raise exception 'rollback fixture';
exception
  when others then
    if sqlerrm = 'rollback fixture' then return; end if;
    raise;
end $$;
