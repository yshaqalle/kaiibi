-- The idempotence claim 20261006000200 rests on is false. This is the fix.
--
-- ## WHAT WAS WRONG, MEASURED
--
-- 20261006000200's header states the whole justification for the design:
--
--   "a unique constraint beats a look-before-you-write check on its own terms:
--    two runs racing each other both read 'not charged' and both post. One of
--    them now fails on the constraint and rolls back. THERE IS NO INTERLEAVING
--    THAT CHARGES A MONTH TWICE."
--
-- There is. The unique index makes a duplicate CHARGE ROW impossible; it says
-- nothing about a duplicate ENTRY, and run_depreciation posts the entry BEFORE
-- it writes the charge rows. run_depreciation is VOLATILE, so in READ COMMITTED
-- every statement inside it takes a FRESH SNAPSHOT. The serialisation point was
-- never the unique index -- it was the per-shop reference counter inside
-- post_journal_entry, which the first run holds for its whole transaction, and
-- that counter is taken AFTER the decision to post has already been made:
--
--   1. Runs A and B both evaluate the `due` CTE for month M. Neither sees the
--      other. Both decide M is due.
--   2. A posts M's entry and writes M's charge rows. B blocks inside
--      post_journal_entry on the reference counter.
--   3. A commits.
--   4. B wakes and posts ITS OWN entry for M -- a second Dr 6800 / Cr 1590.
--   5. B's charge-row `insert ... where not exists` re-evaluates under a NEW
--      snapshot, now sees A's committed rows, and inserts ZERO rows. No unique
--      violation is ever raised. B commits.
--
-- Measured on the live stack, twelve assets six months old, two overlapping
-- calls -- which is the Fixed Assets screen's "Run depreciation" button pressed
-- on two devices, or one device retrying after a timeout on a call that is
-- still running:
--
--   A returned 6      B returned 1      (neither raised)
--   depreciation entries: 7      distinct charge months: 6
--   1590 ledger: -840000         charge rows total: 720000
--
-- ## AND NOTHING COULD SEE IT, WHICH IS THE WHOLE PROBLEM
--
-- A duplicate charge moves 1590 by -X and 6800 by +X, and cash_flow()'s proof
-- row is `investing = -(1500-1599) - 6800`, so the duplicate contributes
-- `-(-X) - X = 0`. The proof still TIES. The entry balances, so every totals
-- check and the trial balance pass. A third run sees the charge row and returns
-- 0, so the function can neither detect nor repair it. Profit is understated by
-- a month's charge and 1590 is overstated by it, permanently, silently.
--
-- Wrong AND balanced is the failure mode this project has shipped repeatedly.
-- So this migration does two separate things, and both are wanted:
--
-- ## ONE: A LOCK TAKEN BEFORE THE DECISION, NOT AFTER IT
--
-- Every door that writes a shop's fixed_assets -- create, dispose, delete and
-- the run itself -- now takes `pg_advisory_xact_lock` on a key derived from the
-- SHOP ID, as its first act after the permission check. A transaction lock, so
-- it is released by commit or rollback and no path can leak it.
--
-- Why an advisory lock rather than `select ... for update` on the register,
-- which was the obvious shape and is what the review suggested:
--
--   * ROW LOCKS DO NOT STOP PHANTOMS. A run for a shop whose register is empty
--     at lock time locks nothing at all, and an asset created a moment later is
--     then visible to two runs neither of which locked it. The failure is rarer,
--     not absent -- and "narrowed" is what this migration exists to stop
--     accepting.
--   * The register's three reads are pinned in accumulated-rpc-edits.test.ts at
--     `where fa.shop_id = p_shop_id`, times 3, and `and fa.disposed_on is null`,
--     times 2. A fourth and third occurrence added by a locking query would
--     weaken both pins to the point where dropping the tenant filter from one of
--     the real queries stays green.
--
-- The key is md5 of the shop id folded to a bigint -- deterministic across
-- sessions and backends, derived from documented functions only. Two shops
-- could in principle collide in 64 bits and would then serialise each other's
-- month-ends unnecessarily; nothing is incorrect if they do.
--
-- The ordering is the same in all four doors -- SHOP LOCK FIRST, then whatever
-- post_journal_entry takes -- so there is no cycle and no deadlock. A door that
-- took the counter first and the shop lock second would introduce one.
--
-- With the lock, the interleaving above becomes: B blocks at the lock, A
-- commits, B's `due` CTE then runs under a snapshot that INCLUDES A's charge
-- rows, finds nothing due, posts nothing and returns 0. Which is what the
-- header always claimed happened.
--
-- ## TWO: THE RUN CHECKS ITS OWN WORK, AND ABORTS RATHER THAN LIES
--
-- A lock only holds over the doors that take it. reverse_journal_entry is a
-- shipped generic RPC that does not, and cannot be taught to without inverting
-- the lock order against post_journal_entry's counter and deadlocking. So the
-- run now asserts, for every month it posts, that the charge rows it actually
-- WROTE sum to the same figure the entry it just posted CREDITED to 1590:
--
--   if v_written <> v_total then raise
--
-- The insert returns its rows through a data-modifying CTE, so the figure is
-- what the database took and not what the function expected. This is the guard
-- that makes a silent, balanced disagreement impossible: whatever raced -- a
-- door added later that forgets the lock, a reversal landing mid-run, a snapshot
-- skew nobody has thought of -- the run raises 40001 and rolls the whole thing
-- back rather than committing a ledger and a register that disagree.
--
-- It is deliberately an assertion about TOTALS and not about row counts. Two
-- charge rows of the wrong amounts have the right count.
--
-- ## THREE: A VOIDED ACQUISITION STOPS THE DEPRECIATION TOO
--
-- reverse_journal_entry can void an asset's acquisition entry while the register
-- row survives -- 20261006000100 carries that as a known register-vs-ledger
-- disagreement, reported through acquisition_status / voided_count. The
-- consequence is worse than a disagreement. The asset's COST is now in no
-- account, and depreciation kept crediting 1590 every month for it:
--
--   after voiding the purchase, run_depreciation still wrote 5 monthly entries
--   BALANCE SHEET fixed_assets: 1590 Accumulated Depreciation = -50000
--   BALANCE SHEET fixed_assets: Total fixed assets            = -50000
--
-- -- going further negative every month for the rest of the asset's life, without
-- bound. That is the same shape 20261006000200's header calls "the exact
-- condition dispose_fixed_asset exists to prevent" and added `disposed_on is
-- null` for, and the remedy is one predicate in the same `where` clause that
-- already carries the sibling rule:
--
--   and exists (select 1 from public.journal_entries je
--                where je.id = fa.journal_entry_id and je.status = 'posted')
--
-- In BOTH derivations, like every other rule in this function. Leaving the
-- generic RPC alone is still defensible -- it is a shipped door and fixing it is
-- a separate change. Leaving the run charging an asset the books say was never
-- bought is not.
--
-- A null journal_entry_id fails the predicate too, and that is correct rather
-- than incidental: an asset with no acquisition entry has its cost in no account
-- either, so depreciating it drives the same figure negative by the same route.
-- No row can hold a null today -- delete_fixed_asset removes the row rather than
-- unlinking it -- so nothing in the register changes behaviour because of it.

-- The lock key, in one place so the four doors cannot derive it differently.
-- md5 rather than hashtext(): hashtext is an internal function with no
-- documented stability guarantee, and this value has to mean the same thing in
-- every backend that takes the lock.
create or replace function public.fixed_asset_lock_key(p_shop_id uuid)
returns bigint
language sql immutable set search_path = public as $$
  select ('x' || substr(md5('fixed_assets:' || p_shop_id::text), 1, 16))::bit(64)::bigint;
$$;

comment on function public.fixed_asset_lock_key(uuid) is
  'The advisory-lock key every fixed-asset door takes before it decides anything -- create_fixed_asset, dispose_fixed_asset, delete_fixed_asset and run_depreciation. One derivation in one place so the four cannot disagree about which lock they are taking. md5 of the shop id folded into a bigint: deterministic across backends, and built from documented functions rather than from hashtext(), which is internal.';

-- ── BUYING ────────────────────────────────────────────────────────────────
-- Copied forward from 20261006000100, which is its only previous definition.
-- The one change is the shop lock: without it an asset created between a run's
-- `due` CTE and its charge-row insert -- two statements, two snapshots -- lands
-- in one derivation and not the other, and the run's own assertion below then
-- aborts a month-end that had nothing wrong with it.
create or replace function public.create_fixed_asset(
  p_shop_id uuid,
  p_name text,
  p_cost_cents integer,
  p_acquired_on date,
  p_life_months integer,
  -- Null means ON CREDIT. See 20261006000100's header for why that is the
  -- default and not '1000'.
  p_paid_from_code text default null,
  p_account_code text default '1500'
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  -- Never now()::date or current_date: both resolve in the session's timezone,
  -- which is UTC on Supabase, while every market kaiibi serves is UTC+3. An
  -- asset recorded at 01:00 local on the 1st would be dated into the previous
  -- month, and once that month closes the date is wrong permanently.
  v_acquired date := coalesce(p_acquired_on, public.shop_local_date());
  v_name text := nullif(trim(coalesce(p_name, '')), '');
  v_credit_code text;
  v_asset_name text;
  v_credit_name text;
  v_period_status text;
  v_posted_date date;
  v_entry_id uuid;
  v_asset_id uuid;
begin
  -- FIRST, so a refusal has nothing to roll back.
  if not public.has_shop_permission(p_shop_id, 'ledger.post') then
    raise exception 'You do not have permission to record equipment in the books.'
      using errcode = 'P0001';
  end if;

  -- THE SHOP'S REGISTER, held for this transaction. Taken after the permission
  -- check so a refused caller queues for nothing, and before anything is read
  -- so a run cannot see this asset in one of its two derivations and not the
  -- other. Same order in all four doors -- shop lock, then the counter inside
  -- post_journal_entry -- so there is no cycle.
  perform pg_advisory_xact_lock(public.fixed_asset_lock_key(p_shop_id));

  if v_name is null then
    raise exception 'An asset needs a name.' using errcode = 'P0001';
  end if;

  -- journal_lines has check (amount_cents <> 0) and would refuse a zero with a
  -- constraint name. A NEGATIVE cost it would not refuse at all: it would post a
  -- backwards purchase that balances perfectly and puts a credit balance in
  -- 1500. Both are caught here, in a sentence naming what was asked for.
  if p_cost_cents is null or p_cost_cents <= 0 then
    raise exception 'An asset must cost more than zero; % was given.',
      coalesce(p_cost_cents::text, 'nothing') using errcode = 'P0001';
  end if;

  -- A zero or negative life divides by zero in run_depreciation. Refused at the
  -- door rather than at the arithmetic.
  if p_life_months is null or p_life_months <= 0 then
    raise exception 'An asset needs a useful life in months of at least 1; % was given.',
      coalesce(p_life_months::text, 'nothing') using errcode = 'P0001';
  end if;

  if v_acquired > public.shop_local_date() then
    raise exception 'An asset cannot be acquired in the future; % is after today.',
      to_char(v_acquired, 'YYYY-MM-DD') using errcode = 'P0001';
  end if;

  -- THE RANGE, and 1590 by name. 1500-1599 is what balance_sheet() calls fixed
  -- assets; 1590 is the contra account depreciation credits, so an asset booked
  -- there would present as a negative fixed asset and then depreciate itself.
  if p_account_code is null
     or p_account_code not between '1500' and '1599'
     or p_account_code = '1590' then
    raise exception
      'Equipment is held in accounts 1500-1599 and not in 1590 Accumulated Depreciation; % is not one.',
      coalesce(p_account_code, 'no account') using errcode = 'P0001';
  end if;

  -- The four cash accounts, the same list transfer_funds takes and the same
  -- list cash_flow() counts as cash. Null is not in the list and is not meant
  -- to be: it is the on-credit case, handled below.
  if p_paid_from_code is not null
     and p_paid_from_code <> all (array['1000', '1010', '1020', '1021']) then
    raise exception
      'Equipment is paid for from a cash account (1000, 1010, 1020, 1021), or left on credit; % is not one.',
      p_paid_from_code using errcode = 'P0001';
  end if;

  -- ON CREDIT when nothing was paid from. 2000 Accounts Payable, so the shop
  -- owes for it and the cash flow's investing section is cancelled by the
  -- payables movement rather than by cash that never left.
  v_credit_code := coalesce(p_paid_from_code, '2000');

  -- THE SHOP'S OWN. security definer bypasses RLS on accounts, so without this
  -- filter `max(a.name)` collects every shop's chart and the winner is whichever
  -- name sorts highest. What that leaks is the NAMES, which go into the entry's
  -- description -- not the posting: post_journal_entry resolves the code to an
  -- account id inside the shop itself, so a purchase cannot land in another
  -- shop's ledger by this route. Both names in one read so the two cannot
  -- disagree about which shop was asked about; verify-fixed-assets check 1
  -- renames shop B's till and asserts shop A's description says shop A's word
  -- for it.
  select max(a.name) filter (where a.code = p_account_code),
         max(a.name) filter (where a.code = v_credit_code)
    into v_asset_name, v_credit_name
    from public.accounts a
   where a.shop_id = p_shop_id
     and a.code in (p_account_code, v_credit_code)
     and a.archived_at is null;

  if v_asset_name is null or v_credit_name is null then
    raise exception 'No such account in this shop: %. Check the chart of accounts.',
      case when v_asset_name is null then p_account_code else v_credit_code end
      using errcode = 'P0001';
  end if;

  -- Only an EXISTING non-open period redirects; no row at all means
  -- open_period_for will create it open.
  select ap.status into v_period_status
    from public.accounting_periods ap
   where ap.shop_id = p_shop_id and v_acquired between ap.starts_on and ap.ends_on;

  if v_period_status is not null and v_period_status <> 'open' then
    v_posted_date := public.shop_local_date();
  else
    v_posted_date := v_acquired;
  end if;

  v_entry_id := public.post_journal_entry(
    p_shop_id, v_posted_date,
    'Bought ' || v_name
      || case when p_paid_from_code is null then ', on credit'
              else ', paid from ' || v_credit_name end
      || case when v_posted_date <> v_acquired
              then ' (acquired ' || to_char(v_acquired, 'YYYY-MM-DD')
                   || '; that period is ' || coalesce(v_period_status, 'not open')
                   || ', so it is recognised here)'
              else '' end,
    jsonb_build_array(
      -- Dr the asset: the shop owns something and an asset increases on the
      -- debit side.
      jsonb_build_object('code', p_account_code, 'amount_cents', p_cost_cents,
                         'memo', v_name),
      -- Cr the money, or Cr what is now owed for it.
      jsonb_build_object('code', v_credit_code, 'amount_cents', -p_cost_cents,
                         'memo', 'For ' || v_name)),
    -- No store. The signature carries no location and equipment belongs to the
    -- shop rather than to one of its branches; null is a real value here, the
    -- same as it is for a business-wide bill.
    null, 'asset');

  insert into public.fixed_assets
      (shop_id, name, cost_cents, acquired_on, life_months, account_code,
       journal_entry_id, created_by)
    values (p_shop_id, v_name, p_cost_cents, v_acquired, p_life_months,
            p_account_code, v_entry_id, auth.uid())
    returning id into v_asset_id;

  return v_asset_id;
end;
$$;

-- ── DISPOSING ─────────────────────────────────────────────────────────────
-- Copied forward from 20261006000100, its only previous definition. Two
-- changes, both about the same race.
--
-- `disposed_on is null` was introduced in 20261006000200 to stop a run charging
-- a month for an asset the disposal had already written back the accumulated
-- depreciation for -- and it closes the SEQUENTIAL case only. Concurrently,
-- neither door locked: the disposal writes back the depreciation IT CAN SEE and
-- a run charges a month the disposal never accounted for. Measured:
--
--   charges after the race: 4 rows, total 40000
--   BALANCE SHEET fixed_assets: 1590 Accumulated Depreciation = -40000
--   BALANCE SHEET fixed_assets: Total fixed assets            = -40000
--   register summary: live=0 disposed=1 cost=0 accum=0 nbv=0
--   cash flow: net_change=880000 observed=880000  -> TIES (invisible)
--
-- The register says the shop owns nothing; the balance sheet says it owns minus
-- 400.00, forever, because nothing will ever write it back. Precisely the
-- condition the rule was added to prevent, reached from the concurrent side.
create or replace function public.dispose_fixed_asset(
  p_asset_id uuid,
  p_on date,
  p_proceeds_cents integer default 0,
  -- Not in the plan's signature. See 20261006000100's header: proceeds have to
  -- arrive somewhere, and silently defaulting a Zaad payment into the till is
  -- the same mistake as defaulting a purchase to cash.
  p_received_into_code text default '1000'
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_asset public.fixed_assets%rowtype;
  v_on date;
  v_proceeds integer := coalesce(p_proceeds_cents, 0);
  -- What THIS asset has taken in depreciation, summed off its own charge rows.
  -- Not off 1590's balance, which is every asset's depreciation together, and
  -- not off a column, which would be the same number in two places.
  v_accumulated bigint;
  v_gain_loss bigint;
  v_period_status text;
  v_posted_date date;
  v_lines jsonb;
  v_entry_id uuid;
begin
  select * into v_asset from public.fixed_assets where id = p_asset_id;
  if v_asset.id is null then
    raise exception 'No such asset.' using errcode = 'P0001';
  end if;

  -- The permission is read against the ASSET'S shop, never against a shop id
  -- the caller passed: this function takes no shop argument, and looking one up
  -- from the row is what keeps a caller in one shop from disposing of another
  -- shop's van by id. security definer means RLS did not do it above.
  if not public.has_shop_permission(v_asset.shop_id, 'ledger.post') then
    raise exception 'You do not have permission to record equipment in the books.'
      using errcode = 'P0001';
  end if;

  -- THE SAME LOCK run_depreciation TAKES, on the same key, and the reason this
  -- door has one at all. See the header. shop_id is the one field of the read
  -- above that cannot change, so taking the lock from it is safe even though
  -- the rest of the row may be stale by the time we get it.
  perform pg_advisory_xact_lock(public.fixed_asset_lock_key(v_asset.shop_id));

  -- RE-READ UNDER THE LOCK, and `for update` so a second disposal of the same
  -- asset queues here rather than racing past the already-disposed check below.
  -- Everything decided from here down -- the accumulated depreciation, the gain
  -- or loss, the disposal date -- is decided from THIS read, taken after every
  -- other fixed-asset door for this shop has either finished or not started.
  select * into v_asset from public.fixed_assets where id = p_asset_id for update;
  if v_asset.id is null then
    raise exception 'This asset was removed from the register while it was being disposed of.'
      using errcode = 'P0001';
  end if;

  if v_asset.disposed_on is not null then
    raise exception 'This asset was already disposed of on %.',
      to_char(v_asset.disposed_on, 'YYYY-MM-DD') using errcode = 'P0001';
  end if;

  v_on := coalesce(p_on, public.shop_local_date());

  if v_on < v_asset.acquired_on then
    raise exception 'An asset cannot be disposed of before it was acquired; % is before %.',
      to_char(v_on, 'YYYY-MM-DD'), to_char(v_asset.acquired_on, 'YYYY-MM-DD')
      using errcode = 'P0001';
  end if;
  if v_on > public.shop_local_date() then
    raise exception 'An asset cannot be disposed of in the future; % is after today.',
      to_char(v_on, 'YYYY-MM-DD') using errcode = 'P0001';
  end if;

  if v_proceeds < 0 then
    raise exception 'Proceeds cannot be negative; % was given.', v_proceeds
      using errcode = 'P0001';
  end if;

  if v_proceeds > 0
     and (p_received_into_code is null
          or p_received_into_code <> all (array['1000', '1010', '1020', '1021'])) then
    raise exception
      'Proceeds arrive in a cash account (1000, 1010, 1020, 1021); % is not one.',
      coalesce(p_received_into_code, 'no account') using errcode = 'P0001';
  end if;

  select coalesce(sum(dc.amount_cents), 0) into v_accumulated
    from public.depreciation_charges dc
   where dc.asset_id = v_asset.id;

  -- Cost less what has been written off less what was received. POSITIVE is a
  -- LOSS (the shop got less than the asset was worth in the books) and negative
  -- is a gain. Computed, never plugged: the four lines below sum to zero by this
  -- arithmetic and not by whatever was left over.
  v_gain_loss := v_asset.cost_cents - v_accumulated - v_proceeds;

  -- Only an EXISTING non-open period redirects.
  select ap.status into v_period_status
    from public.accounting_periods ap
   where ap.shop_id = v_asset.shop_id and v_on between ap.starts_on and ap.ends_on;

  if v_period_status is not null and v_period_status <> 'open' then
    v_posted_date := public.shop_local_date();
  else
    v_posted_date := v_on;
  end if;

  -- Cr the asset account by its FULL COST. The register is at cost and the
  -- contra account carries the wear; taking the net book value out of 1500 would
  -- leave the accumulated depreciation of a sold asset on the balance sheet
  -- forever.
  v_lines := jsonb_build_array(
    jsonb_build_object('code', v_asset.account_code, 'amount_cents', -v_asset.cost_cents,
                       'memo', v_asset.name || ', at cost'));

  -- Dr 1590 by THIS asset's accumulated depreciation, removing it. Omitted when
  -- it is zero, because journal_lines refuses a zero line -- an asset sold in
  -- the month it was bought has never been depreciated.
  if v_accumulated > 0 then
    v_lines := v_lines || jsonb_build_object(
      'code', '1590', 'amount_cents', v_accumulated,
      'memo', 'Depreciation written off on ' || v_asset.name);
  end if;

  if v_proceeds > 0 then
    v_lines := v_lines || jsonb_build_object(
      'code', p_received_into_code, 'amount_cents', v_proceeds,
      'memo', 'Sale of ' || v_asset.name);
  end if;

  -- The difference, to 6900 Other. A debit is a loss; a CREDIT is a gain and
  -- presents as a negative expense, which statement_lines() already handles --
  -- it carries contra-revenue accounts at negative amounts for the same reason.
  -- Zero when the proceeds happen to equal the net book value, and then the
  -- line is omitted rather than posted as a zero.
  if v_gain_loss <> 0 then
    v_lines := v_lines || jsonb_build_object(
      'code', '6900', 'amount_cents', v_gain_loss,
      'memo', case when v_gain_loss > 0 then 'Loss on ' else 'Gain on ' end || v_asset.name);
  end if;

  v_entry_id := public.post_journal_entry(
    v_asset.shop_id, v_posted_date,
    'Disposed of ' || v_asset.name
      || case when v_proceeds > 0 then ' for ' || v_proceeds::text else ', for nothing' end
      || case when v_posted_date <> v_on
              then ' (disposed of ' || to_char(v_on, 'YYYY-MM-DD')
                   || '; that period is ' || coalesce(v_period_status, 'not open')
                   || ', so it is recognised here)'
              else '' end,
    v_lines, null, 'asset');

  update public.fixed_assets
     set disposed_on = v_on,
         disposal_entry_id = v_entry_id,
         disposal_proceeds_cents = v_proceeds
   where id = v_asset.id;

  return v_entry_id;
end;
$$;

-- ── DELETING ONE ENTERED IN ERROR ─────────────────────────────────────────
-- Copied forward from 20261006000100, its only previous definition. The change
-- is the lock and the re-read after it. Without them "this asset has not been
-- depreciated" is read under one snapshot and the row is deleted under another:
-- a run committing in between charges the asset, the delete's cascade then
-- takes the charge rows with the register row, and the depreciation ENTRY is
-- left standing with nothing to say which asset it belonged to -- 1590 carrying
-- wear for an asset the books now say was never bought, which is the same
-- unrepairable shape the header above describes.
create or replace function public.delete_fixed_asset(p_asset_id uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_asset public.fixed_assets%rowtype;
  v_old public.journal_entries%rowtype;
  v_old_period_status text;
  v_reversal_date date;
  v_reversal_id uuid;
begin
  select * into v_asset from public.fixed_assets where id = p_asset_id;
  if v_asset.id is null then
    raise exception 'No such asset.' using errcode = 'P0001';
  end if;

  if not public.has_shop_permission(v_asset.shop_id, 'ledger.post') then
    raise exception 'You do not have permission to record equipment in the books.'
      using errcode = 'P0001';
  end if;

  -- THE SAME LOCK, from the one field of the read above that cannot change.
  -- See the header.
  perform pg_advisory_xact_lock(public.fixed_asset_lock_key(v_asset.shop_id));

  -- RE-READ UNDER THE LOCK. The "has it been depreciated" check below is the
  -- whole reason: read under the first snapshot it answers no while a run is
  -- charging the asset, and the delete's cascade then takes the charge rows
  -- with the row while the depreciation ENTRY stands.
  select * into v_asset from public.fixed_assets where id = p_asset_id for update;
  if v_asset.id is null then
    raise exception 'This asset was already removed from the register.'
      using errcode = 'P0001';
  end if;

  if v_asset.disposed_on is not null then
    raise exception 'This asset was disposed of on %; a disposed asset is history and is not deleted.',
      to_char(v_asset.disposed_on, 'YYYY-MM-DD') using errcode = 'P0001';
  end if;

  if exists (select 1 from public.depreciation_charges dc where dc.asset_id = v_asset.id) then
    raise exception 'This asset has already been depreciated; dispose of it instead of deleting it.'
      using errcode = 'P0001';
  end if;

  if v_asset.journal_entry_id is not null then
    select * into v_old from public.journal_entries where id = v_asset.journal_entry_id;

    -- Already reversed is a no-op, not an error: the manual ledger screen's void
    -- can reach that state first.
    if v_old.id is not null and v_old.status = 'posted' then
      select status into v_old_period_status
        from public.accounting_periods
       where shop_id = v_old.shop_id and v_old.entry_date between starts_on and ends_on;
      if v_old_period_status is not null and v_old_period_status <> 'open' then
        v_reversal_date := public.shop_local_date();
      else
        v_reversal_date := v_old.entry_date;
      end if;

      insert into public.journal_entries
          (shop_id, period_id, entry_date, reference, description, source, status,
           location_id, reverses_entry_id, created_by)
        values (
          v_old.shop_id,
          public.open_period_for(v_old.shop_id, v_reversal_date),
          v_reversal_date,
          v_old.reference || 'R',
          'Reversal of ' || coalesce(v_old.reference, 'an unreferenced entry')
            || ' — ' || v_asset.name || ' was removed from the asset register'
            || case when v_reversal_date <> v_old.entry_date
                    then ' (originally dated ' || to_char(v_old.entry_date, 'YYYY-MM-DD')
                         || '; that period is ' || coalesce(v_old_period_status, 'not open')
                         || ', so the reversal is recognised here)'
                    else '' end,
          -- v_old.source, never a literal: a reversal files under the same
          -- source as the entry it reverses.
          v_old.source, 'posted', v_old.location_id, v_old.id, auth.uid())
        returning id into v_reversal_id;

      -- NEGATED. A mirror that copied the lines unchanged nets to double rather
      -- than to nothing, and every per-entry balance check still passes because
      -- both entries balance on their own.
      insert into public.journal_lines (entry_id, account_id, amount_cents, location_id, memo)
        select v_reversal_id, account_id, -amount_cents, location_id, memo
          from public.journal_lines where entry_id = v_old.id;

      update public.journal_entries
         set status = 'reversed', reverses_entry_id = v_reversal_id
       where id = v_old.id;
    end if;
  end if;

  delete from public.fixed_assets where id = v_asset.id;
  return v_reversal_id;
end;
$$;

-- ── DEPRECIATING ──────────────────────────────────────────────────────────
-- Copied forward from 20261006000200, its only previous definition. Three
-- changes, all argued in the header above: the shop lock, the posted-acquisition
-- predicate in BOTH derivations, and the assertion that what was written equals
-- what was posted.
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
  -- The first day of the last COMPLETE month. See 20261006000200's header.
  v_last_complete date := (date_trunc('month', v_today) - interval '1 month')::date;
  v_target date;
  v_month date;
  v_first date;
  v_lines jsonb;
  v_total bigint;
  -- What the charge-row insert ACTUALLY wrote, read back out of the insert
  -- itself rather than assumed. See the header.
  v_written bigint;
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

  -- THE LOCK, TAKEN BEFORE ANY DECISION IS READ. This is the whole of the fix
  -- for the double-posted month: a second run blocks HERE rather than inside
  -- post_journal_entry, and when it wakes its `due` CTE runs under a snapshot
  -- that already contains the first run's charge rows, so it finds nothing due,
  -- posts nothing and returns 0. See the header for the interleaving this
  -- replaces and the measurement of it.
  perform pg_advisory_xact_lock(public.fixed_asset_lock_key(p_shop_id));

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
         -- ...and NOTHING ONCE IT HAS GONE, for any month, including months the
         -- shop still owned it in. See "A DISPOSED ASSET STOPS" in
         -- 20261006000200's header: reading the disposal MONTH here instead was
         -- a measured defect.
         and fa.disposed_on is null
         -- ...and NOTHING ONCE THE PURCHASE HAS BEEN VOIDED. The sibling rule:
         -- an asset whose acquisition entry was reversed has its cost in no
         -- account, so every further charge drives Total fixed assets more
         -- negative, without bound. See the header.
         and exists (
           select 1 from public.journal_entries je
            where je.id = fa.journal_entry_id and je.status = 'posted')
         and not exists (
           select 1 from public.depreciation_charges dc
            where dc.asset_id = fa.id and dc.charge_month = v_month)
    ),
    charge as (
      select d.id, d.name,
             -- The last month of the life carries the remainder, so the total
             -- over the life is the cost exactly.
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
      -- from, and READ BACK through a data-modifying CTE so the check below is
      -- against what the database took rather than against what this function
      -- expected.
      with written as (
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
             and fa.disposed_on is null
             and exists (
               select 1 from public.journal_entries je
                where je.id = fa.journal_entry_id and je.status = 'posted')
             and not exists (
               select 1 from public.depreciation_charges dc
                where dc.asset_id = fa.id and dc.charge_month = v_month)
             and ((extract(year from v_month)::int - extract(year from fa.acquired_on)::int) * 12
                  + (extract(month from v_month)::int - extract(month from fa.acquired_on)::int)
                  + 1) between 1 and fa.life_months
             -- THE SAME `> 0` THE LINES ARE FILTERED BY, or this insert writes a
             -- zero-amount charge row for an asset whose cost is smaller than its
             -- life in months and dies on depreciation_charges' own check
             -- constraint, taking the whole run with it. The two derivations must
             -- agree on WHICH ROWS as well as on the amount.
             and (case when ((extract(year from v_month)::int - extract(year from fa.acquired_on)::int) * 12
                             + (extract(month from v_month)::int - extract(month from fa.acquired_on)::int)
                             + 1) < fa.life_months
                       then fa.cost_cents / fa.life_months
                       else fa.cost_cents - (fa.cost_cents / fa.life_months) * (fa.life_months - 1)
                  end) > 0
          returning amount_cents)
      select coalesce(sum(w.amount_cents), 0)::bigint into v_written from written w;

      -- THE ENTRY AND THE CHARGE ROWS ARE ONE FACT. Two statements, two
      -- snapshots: if anything committed in between -- an acquisition voided
      -- mid-run, a door added later that forgets the lock above -- the ledger
      -- and the register would part company by exactly the difference, and
      -- BALANCE, so no totals check, no trial balance and no cash-flow proof
      -- could see it. This is the check that makes that impossible: the run
      -- raises and rolls the whole month back instead.
      if v_written <> v_total then
        raise exception
          'Depreciation for % changed while it was being posted (% charged, % expected); nothing has been recorded. Run it again.',
          to_char(v_month, 'FMMonth YYYY'), v_written, v_total
          using errcode = '40001';
      end if;

      v_entries := v_entries + 1;
    end if;

    v_month := (v_month + interval '1 month')::date;
  end loop;

  return v_entries;
end;
$$;

-- The grants are re-stated because `create or replace function` keeps the
-- existing ACL -- but fixed_asset_lock_key is new and has PostgreSQL's default
-- grant to PUBLIC, which is the convention 20261005000400 set after that default
-- turned out to be why `anon` could reach post_journal_entry. It is immutable
-- and discloses nothing (it is md5 of an id the caller already has), but the
-- rule is that the grants below are the whole list.
revoke execute on function public.fixed_asset_lock_key(uuid) from public;
grant execute on function public.fixed_asset_lock_key(uuid) to authenticated;
grant execute on function public.fixed_asset_lock_key(uuid) to service_role;

revoke execute on function public.create_fixed_asset(uuid, text, integer, date, integer, text, text) from public;
grant execute on function public.create_fixed_asset(uuid, text, integer, date, integer, text, text) to authenticated;
grant execute on function public.create_fixed_asset(uuid, text, integer, date, integer, text, text) to service_role;

revoke execute on function public.dispose_fixed_asset(uuid, date, integer, text) from public;
grant execute on function public.dispose_fixed_asset(uuid, date, integer, text) to authenticated;
grant execute on function public.dispose_fixed_asset(uuid, date, integer, text) to service_role;

revoke execute on function public.delete_fixed_asset(uuid) from public;
grant execute on function public.delete_fixed_asset(uuid) to authenticated;
grant execute on function public.delete_fixed_asset(uuid) to service_role;

revoke execute on function public.run_depreciation(uuid, date) from public;
grant execute on function public.run_depreciation(uuid, date) to authenticated;
grant execute on function public.run_depreciation(uuid, date) to service_role;

comment on function public.run_depreciation(uuid, date) is
  'Posts straight-line monthly depreciation over the fixed-asset register -- Dr 6800 / Cr 1590, source ''depreciation'', one entry per month dated the month''s end -- and returns how many entries it wrote. The charge is floor(cost / life_months) for every month but the last of the asset''s life, which carries the remainder, so the total over the life is the cost EXACTLY; a month past the life is not charged at all, so 1590 can never exceed 1500 for an asset. A month whose charge rounds to ZERO -- an asset costing less than its life in months -- is not charged either, in the lines and in the charge rows alike. A full month in the month of acquisition, NOTHING ONCE THE ASSET HAS GONE, and NOTHING ONCE ITS ACQUISITION ENTRY HAS BEEN VOIDED -- a disposed asset has already had its whole remaining book value put through 6900, and a voided one has its cost in no account at all, so a further charge in either case drives Total fixed assets negative and nothing ever writes it back. p_through is CLAMPED to the last day of the last COMPLETE month, on 20261005000000''s rule that a month must end before the books do anything with it. RUNNING IT TWICE FOR THE SAME MONTH WRITES NOTHING AND RETURNS 0: it takes an advisory transaction lock on the shop before it reads anything, which every other fixed-asset door takes too, so a concurrent run blocks BEFORE the decision instead of inside post_journal_entry -- the unique constraint on depreciation_charges guards the charge rows and never guarded the ENTRY, which is how two overlapping runs used to post seven entries for six months while every totals check and the cash-flow proof still tied. It also asserts that the charge rows it wrote sum to what the entry it posted credited, and raises 40001 rather than commit a ledger and a register that disagree. Gated on ledger.post.';
