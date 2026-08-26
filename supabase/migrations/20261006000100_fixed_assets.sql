-- The fixed-asset register, and the two doors that move an asset in and out.
--
-- balance_sheet() has split fixed assets out by the code range 1500-1599 since
-- 20261001000100 and cash_flow() has had an investing section reading the same
-- range since 20261001000200. Both have always read zero, because the only way
-- to put a fridge on kaiibi's balance sheet has been a manual journal entry --
-- which needs ledger.post, which no default role but the owner holds, and which
-- asks the person typing it to know that a fridge is 1500 and not 6400 Supplies.
-- What actually happens is that the fridge goes through as an expense, profit is
-- understated by the whole of it in the month it was bought and overstated every
-- month after, and the balance sheet never mentions it again.
--
-- ## TWO TABLES, AND WHY THE SECOND ONE IS HERE AND NOT IN 20261006000200
--
-- `fixed_assets` is the register. `depreciation_charges` is one row per asset
-- per month that has been depreciated, and it is what makes running depreciation
-- twice for the same month IMPOSSIBLE rather than merely unlikely -- see
-- 20261006000200's header for the argument. It is defined HERE because
-- dispose_fixed_asset() below has to read it: disposal removes the accumulated
-- depreciation belonging to THIS asset, and no other structure in this database
-- can answer how much of 1590's balance that is. journal_lines carries no asset
-- reference and never will -- tagging the ledger with a register's foreign key
-- is how a ledger stops being a ledger.
--
-- The alternative was an `accumulated_cents` column on fixed_assets maintained
-- by the depreciation run. It is one integer instead of a table and it is
-- exactly the shape that drifts: two places holding the same number, one of them
-- the ledger, and no cheap way to notice when they stop agreeing. Summing the
-- charge rows is the same answer derived once, and verify-fixed-assets.sql
-- asserts that sum equals the 1590 lines the run actually posted.
--
-- ## BUYING: Dr the asset / Cr the money, OR Cr 2000 WHEN THERE IS NO MONEY
--
-- p_paid_from_code null means ON CREDIT and posts Cr 2000 Accounts Payable.
-- Null is the default rather than '1000' deliberately: a shop that pays cash
-- says so, and a shop that does not say anything has, in this database's own
-- terms, not recorded a payment -- which is a payable. The reverse default
-- ('1000' unless told otherwise) invents a cash payment out of an omitted
-- argument and takes money out of a till that never opened.
--
-- p_paid_from_code, when given, is one of the same EXPLICIT FOUR cash accounts
-- transfer_funds takes (20261006000000's header argues that list at length): it
-- is cash_flow()'s own observed-cash list, and paying for a fridge out of an
-- account the proof does not count as cash would move one side of the proof and
-- not the other.
--
-- p_account_code must be in 1500-1599 AND must not be 1590. The range is the one
-- balance_sheet() calls fixed assets; 1590 is the contra account depreciation
-- credits, and an asset booked INTO it would present as a negative fixed asset
-- and depreciate itself.
--
-- ## DISPOSAL, THE GAIN OR LOSS, AND THE ACCOUNT IT LANDS IN
--
-- Removing an asset removes its cost, removes ITS accumulated depreciation,
-- takes the proceeds in cash, and the difference is a gain or a loss. There is
-- no `Gain on disposal` in the seeded chart and that is a real gap. Three
-- options were on the table:
--
--   * A NEW ACCOUNT. Rejected. The chart is PER SHOP: adding one means editing
--     default_chart_of_accounts() and backfilling every shop that already
--     exists, and a shop that has already invented its own account at that code
--     collides with it. That is a schema change to serve a line item.
--   * REFUSE PROCEEDS, write the asset off in full. Rejected, and not because it
--     is unhelpful -- because it does not avoid the problem. A write-off of a
--     part-depreciated asset produces a loss of exactly its net book value and
--     the same question about where the loss goes.
--   * 6900 OTHER, an expense, seeded in every chart. CHOSEN. A loss is a debit
--     to it and a gain is a CREDIT to it, presenting as a negative expense --
--     which statement_lines() already handles, because it already carries
--     contra-revenue accounts at negative amounts. The memo names the asset and
--     the entry's description says "sold"; nobody reading the ledger will think
--     the shop bought something.
--
-- The gain or loss is NOT a plug. It is computed as cost less accumulated
-- depreciation less proceeds and the entry balances by arithmetic, not by
-- whatever is left over.
--
-- p_received_into_code IS AN ADDITION TO THE SIGNATURE THE PLAN GIVES, which
-- names p_proceeds_cents and no account for them to land in. Proceeds have to
-- arrive somewhere and defaulting them silently into 1000 Cash on Hand for a
-- shop that was paid by Zaad is the same class of mistake as defaulting a
-- purchase to cash. Defaulted, so every call the plan writes still compiles.
--
-- ## THE CLOSED-PERIOD REDIRECT APPLIES TO BOTH
--
-- p_acquired_on and p_on are dates a user types, so 20260908000500's rule
-- applies: read the period's status BEFORE posting and, if it exists and is not
-- open, post into the current period carrying the true date and the status in
-- the description. coalesce on the status, because a null operand nulls the
-- whole description through `||` and post_journal_entry then refuses the entry
-- for having no description -- an error about descriptions for a bug about
-- dates, which is how 20260908000300 found it.
--
-- The REGISTER still records the true acquired_on and disposed_on. That
-- separation is the whole reason depreciation is driven off charge rows rather
-- than off entry dates: once an entry has been redirected, its date no longer
-- says which month it belongs to.
--
-- ## THE GATE: ledger.post
--
-- transfer_funds took budgets.manage because banking the float is a cash
-- operation, Cash & Budgets already gates on it, and the Manager who does the
-- banking holds it. This is the opposite case and takes the opposite answer.
-- Capitalising a purchase is a bookkeeping judgement -- whether the fridge is an
-- asset over four years or supplies this month changes this month's profit and
-- every month after it -- and the register lives on the Accounting screens,
-- whose every door already gates on a ledger.* permission. ledger.post is
-- described in the catalog as "Write manual entries to the ledger", which is
-- what this is: an entry no till and no bill produced.
--
-- post_journal_entry additionally requires MEMBERSHIP of the shop for every
-- source since 20261005000400, so the tenant boundary is checked twice. Both
-- are wanted: these functions are security definer and would otherwise be the
-- same hole in a new wrapper.

create table public.fixed_assets (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  name text not null check (length(trim(name)) > 0),
  -- Positive. A zero-cost asset posts nothing (journal_lines refuses a zero
  -- amount) and would sit in the register depreciating nothing forever.
  cost_cents integer not null check (cost_cents > 0),
  acquired_on date not null,
  -- Months, not years: a shop that buys a phone writes 24, not 2. The charge is
  -- monthly, so the life is stated in the same unit as the charge and nobody has
  -- to multiply.
  life_months integer not null check (life_months > 0),
  -- Which 15xx account it sits in. Stored rather than assumed, because a shop
  -- that books shelving to 1510 and a van to 1500 must get its cost back out of
  -- the same account on disposal.
  account_code text not null,
  -- The acquisition entry. The 2b pattern: the link is what makes posting twice
  -- visible and a reversal possible. Nullable because a reversal (see
  -- delete_fixed_asset) has to be able to say the entry is gone.
  journal_entry_id uuid references public.journal_entries(id),
  disposed_on date,
  disposal_entry_id uuid references public.journal_entries(id),
  disposal_proceeds_cents integer,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  -- An asset cannot leave before it arrives. Cheap, and it is the one date
  -- relationship every figure below depends on.
  check (disposed_on is null or disposed_on >= acquired_on),
  check (disposal_proceeds_cents is null or disposal_proceeds_cents >= 0)
);
create index fixed_assets_shop_idx on public.fixed_assets(shop_id, acquired_on desc);
-- The depreciation run's own working set: every asset of a shop that has not
-- been disposed of. Partial, because a shop's disposed assets accumulate
-- forever and the run never looks at them again.
create index fixed_assets_shop_live_idx on public.fixed_assets(shop_id)
  where disposed_on is null;

create table public.depreciation_charges (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  asset_id uuid not null references public.fixed_assets(id) on delete cascade,
  -- The FIRST DAY of the month the charge belongs to, never the entry's date.
  -- A charge for a closed month is posted at today's date and still belongs to
  -- that month; storing the entry date here would make the second run of a
  -- redirected month look like a different month and charge it again.
  charge_month date not null check (extract(day from charge_month) = 1),
  amount_cents integer not null check (amount_cents > 0),
  journal_entry_id uuid not null references public.journal_entries(id),
  created_at timestamptz not null default now(),
  -- THE WHOLE OF THE IDEMPOTENCY, and it is a constraint rather than a check
  -- inside the function on purpose. A function that looks before it writes is
  -- correct until two of them look at the same time; this one cannot be beaten
  -- by concurrency, by a caller that skips the RPC, or by a future second door.
  unique (asset_id, charge_month)
);
create index depreciation_charges_shop_month_idx
  on public.depreciation_charges(shop_id, charge_month);

alter table public.fixed_assets enable row level security;
alter table public.depreciation_charges enable row level security;

-- READ ONLY, on ledger.view, and no insert/update/delete policy at all -- the
-- same shape journal_entries takes (20260904000300:183). Every write goes
-- through the security definer functions below, which is where the accounting
-- lives; a register row that could be edited directly would part company with
-- the entry that put the asset on the balance sheet.
create policy "read fixed_assets" on public.fixed_assets for select
  using (public.has_shop_permission(shop_id, 'ledger.view'));
create policy "read depreciation_charges" on public.depreciation_charges for select
  using (public.has_shop_permission(shop_id, 'ledger.view'));

grant select on public.fixed_assets, public.depreciation_charges to authenticated;

-- ── BUYING ────────────────────────────────────────────────────────────────
create or replace function public.create_fixed_asset(
  p_shop_id uuid,
  p_name text,
  p_cost_cents integer,
  p_acquired_on date,
  p_life_months integer,
  -- Null means ON CREDIT. See the header for why that is the default and not
  -- '1000'.
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

  -- THE SHOP'S OWN. security definer bypasses RLS on accounts, so this filter is
  -- the whole of the tenant boundary at this door -- without it a caller holding
  -- the permission in their own shop reads another shop's chart. Both names in
  -- one read so the two cannot disagree about which shop was asked about.
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
create or replace function public.dispose_fixed_asset(
  p_asset_id uuid,
  p_on date,
  p_proceeds_cents integer default 0,
  -- Not in the plan's signature. See the header: proceeds have to arrive
  -- somewhere, and silently defaulting a Zaad payment into the till is the same
  -- mistake as defaulting a purchase to cash. Defaulted so the plan's calls
  -- still compile.
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

-- ── DELETING ONE ENTERED IN ERROR, AND ITS REVERSAL, IN THE SAME MIGRATION ─
--
-- Four holes shipped in phase 2b by adding a delete path and leaving its journal
-- entry standing -- edit_sale, delete_sale, delete_invoice_payment and expenses,
-- each found after the fact. So the reversal is here, in the same file as the
-- delete, and there is no route that removes a fixed_assets row without it: the
-- table has no delete policy, so RLS admits nobody, and the only other way a row
-- goes is the cascade from `shops`, which destroys the ledger in the same
-- statement.
--
-- WRITTEN INLINE rather than through reverse_journal_entry(), which gates on
-- ledger.post -- this door gates on ledger.post too, so that is not the reason
-- here; the reason is that a reversal must carry the SAME SOURCE as the entry it
-- reverses ('asset', not 'manual'), which verify-posting-sales.sql pins as a
-- convention and reverse_journal_entry does not do.
--
-- REFUSED once anything has happened to the asset. A depreciated or disposed
-- asset has other entries pointing at it and unwinding them is a different
-- operation with a different name; deleting the register row would leave 1590
-- carrying depreciation for an asset that, as far as the books are concerned,
-- was never bought. The message says to dispose of it instead.
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

-- Revoked from PUBLIC before it is granted, so the grants below are the entire
-- list of who can call these -- the convention 20261005000400 set after
-- PostgreSQL's default grant to PUBLIC turned out to be the reason `anon` could
-- reach post_journal_entry. All three are security definer, and while
-- has_shop_permission answers false for a caller with no user, one barrier being
-- believed to be two is exactly how that hole shipped.
revoke execute on function public.create_fixed_asset(uuid, text, integer, date, integer, text, text) from public;
grant execute on function public.create_fixed_asset(uuid, text, integer, date, integer, text, text) to authenticated;
grant execute on function public.create_fixed_asset(uuid, text, integer, date, integer, text, text) to service_role;

revoke execute on function public.dispose_fixed_asset(uuid, date, integer, text) from public;
grant execute on function public.dispose_fixed_asset(uuid, date, integer, text) to authenticated;
grant execute on function public.dispose_fixed_asset(uuid, date, integer, text) to service_role;

revoke execute on function public.delete_fixed_asset(uuid) from public;
grant execute on function public.delete_fixed_asset(uuid) to authenticated;
grant execute on function public.delete_fixed_asset(uuid) to service_role;

comment on table public.fixed_assets is
  'The fixed-asset register: what the shop owns that wears out. One row per asset, at cost, with the 15xx account it sits in and the acquisition entry that put it there. acquired_on and disposed_on are the TRUE dates the user gave; the journal entries may be dated later when the month they fall in has closed, which is why run_depreciation() is driven off depreciation_charges.charge_month and never off an entry date. Read-only under RLS on ledger.view; every write goes through create_fixed_asset, dispose_fixed_asset and delete_fixed_asset.';

comment on table public.depreciation_charges is
  'One row per asset per month that has been depreciated, carrying the entry that posted it. unique (asset_id, charge_month) is what makes a second depreciation run for the same month impossible rather than merely unlikely -- a constraint instead of a look-before-you-write check, which concurrency beats. It is also the only structure that can say how much of 1590''s balance belongs to ONE asset, which is what dispose_fixed_asset needs to remove.';

comment on function public.create_fixed_asset(uuid, text, integer, date, integer, text, text) is
  'Records equipment in the fixed-asset register and posts Dr the 15xx account / Cr the money, source ''asset''. p_paid_from_code null means ON CREDIT and credits 2000 Accounts Payable -- the default, because an omitted argument must not invent a cash payment; when given it must be one of 1000, 1010, 1020 and 1021, the same four cash_flow() counts as cash. p_account_code must be in 1500-1599 (the range balance_sheet() calls fixed assets) and must not be 1590, the contra account. Refuses a zero or negative cost, a life under one month, and an acquisition date in the future. Gated on ledger.post: capitalising a purchase is a bookkeeping judgement and the register lives on the Accounting screens. An acquisition date in a closed or locked period is recognised in the current one, carrying the true date in the description -- while the register keeps the true acquired_on, which is what depreciation is driven from.';

comment on function public.dispose_fixed_asset(uuid, date, integer, text) is
  'Takes an asset out of the register and posts the disposal, source ''asset'': Cr the 15xx account by its FULL COST, Dr 1590 by the depreciation charged against THIS asset (summed from depreciation_charges, not from 1590''s balance), Dr the cash account by the proceeds, and the difference to 6900 Other -- a debit for a loss, a CREDIT for a gain, presenting as a negative expense. The chart has no gain-on-disposal account and adding one would mean editing the per-shop seed and backfilling every shop; 6900 is seeded everywhere and the memo names the asset. The gain or loss is computed as cost less accumulated depreciation less proceeds, never plugged. p_received_into_code is an addition to the planned signature because proceeds must land in a named account; it defaults to 1000. Refuses a second disposal, a date before acquisition, a date in the future and negative proceeds. Gated on ledger.post against the ASSET''S shop, read from the row.';

comment on function public.delete_fixed_asset(uuid) is
  'Removes an asset entered in error and REVERSES its acquisition entry in the same breath -- a mirror entry with negated lines carrying the SAME source (''asset''), the original marked reversed and the two linked both ways. Written inline rather than through reverse_journal_entry, which posts under ''manual''. Refuses once the asset has been depreciated or disposed of: those have other entries pointing at the asset, and deleting the row would leave 1590 carrying depreciation for something the books say was never bought. Returns the reversal entry id, or null when the asset posted nothing to reverse. Gated on ledger.post against the asset''s shop.';
