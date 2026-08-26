-- Equipment wearing out, posted month by month.
--
-- The income statement has had a Depreciation line since phase 3a and the cash
-- flow has had an `Add back depreciation` row whose own comment says out loud
-- that it is "normally zero until 3c ships". This is what makes them mean
-- something: Dr 6800 Depreciation / Cr 1590 Accumulated Depreciation, straight
-- line, one entry per month, over the register 20261006000100 built.
--
-- ## STRAIGHT LINE, MONTHLY, AND THE LAST MONTH CARRIES THE REMAINDER
--
-- cost / life_months rarely divides evenly. 100000 over 36 months is 2777.77…,
-- and 2777 x 36 is 99972 -- so an asset that depreciated at the rounded figure
-- for its whole life would sit on the balance sheet at 28 cents forever, and one
-- rounded the other way would depreciate to minus 8. Neither is a rounding
-- nicety; it is a number nobody can ever clear off a balance sheet.
--
-- So the charge is not "cost / life" every month. It is:
--
--     months 1 .. life-1 :  floor(cost / life)
--     month  life        :  cost - floor(cost / life) x (life - 1)
--
-- and the total over the life is cost EXACTLY, by construction rather than by
-- luck. verify-fixed-assets.sql runs an asset through its entire life and
-- asserts the sum, not one month's figure -- a check on one month passes for
-- every rounding rule there is.
--
-- ## THE MONTH INDEX IS COMPUTED FROM THE DATES, NOT COUNTED FROM THE ROWS
--
-- "How many months has this asset been charged" and "which month of its life is
-- this" are different questions and only the second one gives a stable answer.
-- Counting charge rows makes the amount depend on what has already been posted,
-- so an asset added late and caught up out of order would take its final
-- month's remainder in the wrong month. The index is
--
--     (year(m) - year(acquired)) x 12 + (month(m) - month(acquired)) + 1
--
-- which is a property of the calendar and of the asset, and is the same on every
-- run. NEVER PAST COST falls out of it: a month whose index exceeds life_months
-- is not charged at all, so 1590 cannot pass 1500 for an asset however many
-- times the run is asked for a later date.
--
-- ## A FULL MONTH IN THE MONTH IT ARRIVES, NONE IN THE MONTH IT LEAVES
--
-- The alternative is pro-rating by days, which for a shop buying a fridge on the
-- 14th produces a first charge nobody can check by hand and a life that ends
-- mid-month. Full month on arrival, none on disposal, is the convention small
-- ledgers use, it keeps every charge equal to every other, and it is symmetric:
-- an asset bought in March and sold in March takes one month's depreciation and
-- an asset bought in March and sold in April takes one month's depreciation.
--
-- ## A MONTH MUST END BEFORE IT IS DEPRECIATED
--
-- 20261005000000 established the rule for closing a month and it is the same
-- rule here: a charge for August posted on 12 August is dated 31 August, which
-- is in the future, and an entry dated in the future opens a period nobody has
-- traded in yet. So p_through is CLAMPED to the last day of the last COMPLETE
-- month. Passing today, or a date years out, both mean "everything you can
-- honestly post"; neither is an error, because "depreciate up to date X" is a
-- request about how far to go and not an assertion that X has happened.
--
-- ## IDEMPOTENCY: A CONSTRAINT, NOT A CHECK
--
-- 20261006000100 gives depreciation_charges `unique (asset_id, charge_month)`.
-- That is the whole of it. A second run for the same month finds every charge
-- row already there, has nothing to post, and writes NOTHING -- not a
-- zero-amount entry, not an entry with no lines, nothing, and it returns 0.
--
-- The alternative the plan names is to drive idempotency off what is already in
-- the ledger -- phase 2b's backfill pattern, `where journal_entry_id is null`.
-- It is the wrong instrument HERE, for a reason specific to this function: a
-- depreciation entry for a CLOSED month is redirected to today's date, exactly
-- as every other posting site with a user-chosen date is. After that redirect
-- the entry's date no longer says which month it belongs to, so a run that asked
-- the ledger "have I charged March?" would look at an entry dated in August and
-- answer no -- and charge March again, forever, once a month. The charge row
-- records the month as a fact separate from the date it was posted on, which is
-- the only structure that survives the redirect.
--
-- And a unique constraint beats a look-before-you-write check on its own terms:
-- two runs racing each other both read "not charged" and both post. One of them
-- now fails on the constraint and rolls back. There is no interleaving that
-- charges a month twice.
--
-- ## A DISPOSED ASSET STOPS
--
-- ...on the month of its disposal, not on the day. See the convention above.
-- dispose_fixed_asset removes the accumulated depreciation this function
-- charged, reading the same charge rows.
--
-- ## THE GATE: ledger.post, the same as the register's own doors
--
-- Depreciation is a month-end adjusting entry -- the archetype of what
-- ledger.post's catalog entry means by "Write manual entries to the ledger". It
-- is not a cash operation and no Manager has ever needed to run one. The
-- register it runs over gates on the same permission (20261006000100), and a
-- door that can create an asset but not depreciate it would be a strange half.

create or replace function public.run_depreciation(
  p_shop_id uuid,
  -- Null means "as far as you honestly can". Clamped below either way.
  p_through date default null
) returns integer
language plpgsql security definer set search_path = public as $$
declare
  -- Never now()::date or current_date: both resolve in the session's timezone,
  -- which is UTC on Supabase, while every market kaiibi serves is UTC+3. On the
  -- 1st of a month at 01:00 local, UTC is still the last day of the previous
  -- month -- so a run would post another month's charge into a period that may
  -- already be shut, and the clamp below would let it.
  v_today date := public.shop_local_date();
  -- The first day of the last COMPLETE month. See the header.
  v_last_complete date := (date_trunc('month', v_today) - interval '1 month')::date;
  v_target date;
  v_month date;
  v_first date;
  v_lines jsonb;
  v_total bigint;
  v_period_status text;
  v_posted_date date;
  v_entry_id uuid;
  v_entries integer := 0;
begin
  -- FIRST, so a refusal has nothing to roll back.
  if not public.has_shop_permission(p_shop_id, 'ledger.post') then
    raise exception 'You do not have permission to run depreciation.'
      using errcode = 'P0001';
  end if;

  -- least() ignores nulls, so a null p_through resolves to the clamp on its own
  -- and needs no coalesce. A p_through inside the current month clamps back to
  -- the previous one; a p_through years out clamps to the same place.
  v_target := least(date_trunc('month', coalesce(p_through, v_last_complete))::date,
                    v_last_complete);

  -- The earliest month any of this shop's assets could be charged for. Nothing
  -- before the oldest acquisition can ever be due, and starting the walk there
  -- rather than at the shop's first entry keeps a shop with one new fridge from
  -- iterating over every month it has traded.
  select date_trunc('month', min(fa.acquired_on))::date into v_first
    from public.fixed_assets fa
   where fa.shop_id = p_shop_id;

  if v_first is null or v_first > v_target then
    return 0;
  end if;

  -- Ascending, one entry per month, so a shop catching up three months of
  -- depreciation gets three dated entries and not one lump nobody can tie to a
  -- month. The order matters to the reader, not to the arithmetic: the month
  -- index below is computed from the calendar, so a month posted out of order
  -- would still take the right charge.
  v_month := v_first;
  while v_month <= v_target loop
    -- Every asset with a charge DUE for this month and no charge row for it.
    -- The `not exists` is the fast path; unique (asset_id, charge_month) is the
    -- guarantee, and the two are not the same thing -- see the header.
    with due as (
      select fa.id, fa.name, fa.cost_cents, fa.life_months,
             ((extract(year from v_month)::int - extract(year from fa.acquired_on)::int) * 12
              + (extract(month from v_month)::int - extract(month from fa.acquired_on)::int)
              + 1) as month_index
        from public.fixed_assets fa
       where fa.shop_id = p_shop_id
         -- Acquired in this month or earlier: a full month in the month it
         -- arrives.
         and date_trunc('month', fa.acquired_on)::date <= v_month
         -- ...and nothing in the month it leaves, or after.
         and (fa.disposed_on is null
              or date_trunc('month', fa.disposed_on)::date > v_month)
         and not exists (
           select 1 from public.depreciation_charges dc
            where dc.asset_id = fa.id and dc.charge_month = v_month)
    ),
    charge as (
      select d.id, d.name,
             -- The last month of the life carries the remainder, so the total
             -- over the life is the cost exactly. See the header.
             (case when d.month_index < d.life_months
                   then d.cost_cents / d.life_months
                   else d.cost_cents - (d.cost_cents / d.life_months) * (d.life_months - 1)
              end)::bigint as amount_cents
        from due d
       -- NEVER PAST COST. A month past the asset's life is not charged, so
       -- 1590 cannot exceed 1500 for it however far the run is asked to go.
       where d.month_index between 1 and d.life_months
    )
    select coalesce(sum(c.amount_cents), 0),
           coalesce(jsonb_agg(jsonb_build_object(
             'code', '6800', 'amount_cents', c.amount_cents,
             'memo', c.name) order by c.name), '[]'::jsonb)
      into v_total, v_lines
      from charge c
     where c.amount_cents > 0;

    if v_total > 0 then
      -- The credit, aggregated: 1590 is the shop's accumulated depreciation and
      -- the ledger does not carry a per-asset dimension. Which asset took which
      -- share is depreciation_charges' job, and it is written below off the
      -- same numbers this entry is built from.
      v_lines := v_lines || jsonb_build_object(
        'code', '1590', 'amount_cents', -v_total,
        'memo', 'Depreciation for ' || to_char(v_month, 'FMMonth YYYY'));

      -- Only an EXISTING non-open period redirects; no row at all means
      -- open_period_for will create it open. coalesce on the status below, for
      -- the reason 20260908000300 found the hard way: a null operand nulls the
      -- whole description through `||` and post_journal_entry then refuses the
      -- entry for having no description.
      select ap.status into v_period_status
        from public.accounting_periods ap
       where ap.shop_id = p_shop_id
         and (v_month + interval '1 month - 1 day')::date between ap.starts_on and ap.ends_on;

      if v_period_status is not null and v_period_status <> 'open' then
        v_posted_date := v_today;
      else
        v_posted_date := (v_month + interval '1 month - 1 day')::date;
      end if;

      v_entry_id := public.post_journal_entry(
        p_shop_id, v_posted_date,
        'Depreciation for ' || to_char(v_month, 'FMMonth YYYY')
          || case when v_posted_date <> (v_month + interval '1 month - 1 day')::date
                  then ' (charged to ' || to_char(v_month, 'FMMonth YYYY')
                       || '; that period is ' || coalesce(v_period_status, 'not open')
                       || ', so it is recognised here)'
                  else '' end,
        v_lines,
        -- No store. Equipment belongs to the shop rather than to one of its
        -- branches, the same as the acquisition entry that bought it.
        null, 'depreciation');

      -- The charge rows, written from the same expression the lines were built
      -- from so the two cannot disagree. This is also the statement that makes a
      -- concurrent second run fail rather than double-charge.
      insert into public.depreciation_charges
          (shop_id, asset_id, charge_month, amount_cents, journal_entry_id)
        select p_shop_id, fa.id, v_month,
               (case when ((extract(year from v_month)::int - extract(year from fa.acquired_on)::int) * 12
                           + (extract(month from v_month)::int - extract(month from fa.acquired_on)::int)
                           + 1) < fa.life_months
                     then fa.cost_cents / fa.life_months
                     else fa.cost_cents - (fa.cost_cents / fa.life_months) * (fa.life_months - 1)
                end),
               v_entry_id
          from public.fixed_assets fa
         where fa.shop_id = p_shop_id
           and date_trunc('month', fa.acquired_on)::date <= v_month
           and (fa.disposed_on is null
                or date_trunc('month', fa.disposed_on)::date > v_month)
           and not exists (
             select 1 from public.depreciation_charges dc
              where dc.asset_id = fa.id and dc.charge_month = v_month)
           and ((extract(year from v_month)::int - extract(year from fa.acquired_on)::int) * 12
                + (extract(month from v_month)::int - extract(month from fa.acquired_on)::int)
                + 1) between 1 and fa.life_months;

      v_entries := v_entries + 1;
    end if;

    v_month := (v_month + interval '1 month')::date;
  end loop;

  return v_entries;
end;
$$;

-- Revoked from PUBLIC before it is granted, so the grants below are the entire
-- list of who can call this -- the convention 20261005000400 set after
-- PostgreSQL's default grant to PUBLIC turned out to be the reason `anon` could
-- reach post_journal_entry.
revoke execute on function public.run_depreciation(uuid, date) from public;
grant execute on function public.run_depreciation(uuid, date) to authenticated;
grant execute on function public.run_depreciation(uuid, date) to service_role;

comment on function public.run_depreciation(uuid, date) is
  'Posts straight-line monthly depreciation over the fixed-asset register -- Dr 6800 / Cr 1590, source ''depreciation'', one entry per month dated the month''s end -- and returns how many entries it wrote. The charge is floor(cost / life_months) for every month but the last of the asset''s life, which carries the remainder, so the total over the life is the cost EXACTLY; a month past the life is not charged at all, so 1590 can never exceed 1500 for an asset. A full month in the month of acquisition and none in the month of disposal. p_through is CLAMPED to the last day of the last COMPLETE month, on 20261005000000''s rule that a month must end before the books do anything with it. RUNNING IT TWICE FOR THE SAME MONTH WRITES NOTHING AND RETURNS 0, guaranteed by unique (asset_id, charge_month) on depreciation_charges rather than by a check inside this function -- which concurrency beats, and which could not survive the closed-period redirect anyway, since a redirected entry''s date no longer says which month it belongs to. Gated on ledger.post.';
