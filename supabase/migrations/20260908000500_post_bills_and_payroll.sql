-- Money going OUT posts to the ledger: paying a supplier, and paying staff.
--
-- ## Paying a supplier is not an expense
--
-- `Dr 2000 Accounts Payable / Cr the wallet it was paid from`, and NOTHING
-- else. The cost was recognised the moment the bill was recorded --
-- 20260804000300 makes a bill an unpaid expense and mirrors it into `expenses`
-- on insert, and 20260908000400 has receive_stock credit 2000 when goods
-- arrive. A payment only settles what that recognition created.
--
-- Posting a 6xxx line here as well would double EVERY cost the shop has. It is
-- the single most common double-count in a first ledger, and it is invisible
-- in a totals check because the wrong entry balances perfectly. So
-- verify-posting-bills.sql asserts that no expense-type line exists at all,
-- rather than asserting an amount.
--
-- ## A pay run is paid, not owed
--
-- `Dr 6200 Salaries and Wages / Cr 1000 Cash`. Cash, not `2200 Wages Payable`:
-- post_payroll_run records a run that HAS been paid -- the app's own button
-- reads "Post", and unposting deletes the expense again. Accruing wages that
-- are owed but unpaid is phase 3's work, and 2200 stays unused until then
-- rather than being written to speculatively. 6200/2200 balances just as
-- happily as 6200/1000 while saying the opposite thing about the staff.
--
-- ## Three plan corrections carried in this migration
--
--   1. `p_source => 'bill_payment'` is not a value journal_entries.source's
--      CHECK permits, and the call would have failed outright, taking the
--      payment with it. The permitted values are manual, sale, refund,
--      settlement, bill, payment, payroll, stock, count, transfer, asset,
--      depreciation, close, opening. This uses 'payment' and 'payroll'.
--   2. `coalesce(v_run.paid_on, current_date)` names a column payroll_runs
--      does not have -- there is no paid_on, and `record v_run has no field
--      paid_on` would have raised at runtime. The day a run is paid IS the day
--      it is posted (unpost/re-post is how a mistake is corrected), so the
--      coalesce collapses to its fallback -- corrected from `current_date`,
--      which resolves in the server's UTC timezone while Somalia is UTC+3, to
--      public.shop_local_date(). A late-evening pay run otherwise posts to the
--      wrong day and, at a month boundary, permanently into the wrong period.
--   3. record_invoice_payment's `p_paid_on` is a date parameter and is exempt
--      from the shop_local_date() rule -- there is no moment in time to
--      resolve. Its DEFAULT was not exempt. The app omits p_paid_on whenever
--      the user does not pick a date (src/lib/invoices.ts:167), so
--      `default current_date` decided the date in UTC for the common case.
--
-- ## Why unpost_payroll_run is here too, when the plan named only two functions
--
-- unpost_payroll_run is a button in the app (src/lib/payroll.ts:141). It
-- deletes the generated expense and returns the run to draft. Before this
-- migration there was no ledger for it to keep in step with; the moment
-- post_payroll_run writes one, unposting has to undo it -- or the next post
-- overwrites payroll_runs.journal_entry_id, orphans the first entry, and 6200
-- reads double the wages actually paid. The trial balance still zeroes,
-- because both entries individually balance, so nothing else would catch it.
--
-- The reversal is written out INLINE rather than calling
-- reverse_journal_entry(), for the reason 20260908000650 gives for edit_sale:
-- that function gates on `ledger.post`, and a manager unposting a mis-keyed
-- pay run holds people.payroll.manage + expenses.manage and must not need a
-- ledger permission. It is the same shape -- a mirror entry with negated
-- lines, then `status = 'reversed'` on the original, which is the one update
-- refuse_posted_entry_edit() permits.
--
-- Its reversal is filed under source 'payroll', matching the entry it reverses.
-- That is now the phase-wide convention rather than this file's local taste:
-- A REVERSAL CARRIES THE SAME SOURCE AS ITS ORIGINAL. 20260908000650 wrote
-- 'manual' here (inherited from reverse_journal_entry) and has been corrected;
-- 20260908000900's delete_sale reads the source off the original row. See the
-- plan's Global Constraints. reverse_journal_entry itself keeps 'manual', which
-- is correct for it and deliberate: it is the manual door, its caller typed the
-- reversal by hand, and it gates on ledger.post to prove it.
--
-- ## The closed-period redirect on record_invoice_payment
--
-- record_invoice_payment was the only posting site in the phase with a
-- USER-CHOSEN date and no redirect -- record-payment-modal.tsx has a free date
-- field, and post_journal_entry raises on a closed month. A back-dated supplier
-- payment into a closed January therefore started failing on the Bills screen
-- for an operation that worked before this branch. It now redirects to the open
-- period exactly as 20260908000300 and 20260908000650 do, with the true date and
-- the period's status in the description. Written out at the call site.

-- ---------------------------------------------------------------------------
-- record_invoice_payment -- reproduced from 20260804000300_invoices.sql, its
-- newest and only definition, with the posting block and the default fix added
-- and nothing removed.
-- ---------------------------------------------------------------------------

create or replace function public.record_invoice_payment(
  p_invoice_id uuid,
  p_amount_cents integer,
  -- shop_local_date(), not current_date: the server resolves current_date in
  -- UTC and every kaiibi market is UTC+3, so a payment entered before 03:00
  -- local defaulted to yesterday -- and on the 1st of a month, into a period
  -- that may already be closed.
  p_paid_on date default public.shop_local_date(),
  p_method text default 'cash',
  p_note text default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_invoice public.invoices%rowtype;
  v_payment_id uuid;
  v_entry_id uuid;
  -- The status of the period p_paid_on falls in, or NULL when no row exists for
  -- that month. NULL is not "closed" and not "open" either -- it is "nobody has
  -- traded in this month", which open_period_for turns into an open period on
  -- demand. Getting that backwards would redate every payment into a month
  -- nobody has posted to yet.
  v_period_status text;
  -- Where the entry is actually recognised. Equal to p_paid_on except when that
  -- month has been closed or locked.
  v_posted_date date;
begin
  select * into v_invoice from public.invoices where id = p_invoice_id for update;
  if v_invoice.id is null then
    raise exception 'bill % not found', p_invoice_id;
  end if;
  if not public.has_shop_permission(v_invoice.shop_id, 'invoices.manage') then
    raise exception 'not authorized for bill %', p_invoice_id;
  end if;
  if p_amount_cents is null or p_amount_cents <= 0 then
    raise exception 'payment amount must be greater than zero';
  end if;
  -- This list is also what keeps account_code_for_payment_method reachable
  -- only with values it maps. It raises on anything else -- notably 'unpaid',
  -- which is a sales.payment_method value and cost Task 5 a round trip -- and
  -- invoice_payments.method's own CHECK carries the same four.
  if p_method not in ('cash','zaad','edahab','other') then
    raise exception 'invalid payment method %', p_method;
  end if;
  if v_invoice.paid_cents + p_amount_cents > v_invoice.amount_cents then
    raise exception 'payment of % exceeds the % still outstanding',
      p_amount_cents, v_invoice.amount_cents - v_invoice.paid_cents;
  end if;

  insert into public.invoice_payments (invoice_id, amount_cents, paid_on, method, note, created_by)
    values (p_invoice_id, p_amount_cents, p_paid_on, p_method, nullif(p_note, ''), auth.uid())
    returning id into v_payment_id;

  update public.invoices
    set paid_cents = paid_cents + p_amount_cents, updated_at = now(), updated_by = auth.uid()
    where id = p_invoice_id;

  -- No expense line. The expense was recognised when the bill arrived; this
  -- moves money against the liability that recognition created. Posting 6xxx
  -- again here would double every cost the shop has.
  --
  -- Dated p_paid_on, which is the date the payment row itself carries -- so
  -- the ledger and the bill's payment history cannot disagree about when the
  -- money moved. UNLESS that month is shut; see the redirect below.
  --
  -- The bill's store travels onto the entry. The plan passed null; a payment
  -- against the Berbera store's bill would then post with no store at all and
  -- drop out of that store's cash picture, which is exactly the bug
  -- 20260816000000 exists to close on the expense side. Null stays null for a
  -- business-wide bill, which is a real value and not a gap.

  -- ── The closed-period redirect ──────────────────────────────────────────
  --
  -- THIS WAS THE ONE POSTING SITE WITH A USER-CHOSEN DATE AND NO REDIRECT.
  -- src/components/accounting/record-payment-modal.tsx gives the user a free
  -- date field, and post_journal_entry calls open_period_for, which RAISES on a
  -- closed or locked month. So a shop that closed January and then, in
  -- February, recorded a supplier payment dated 28 January got
  -- "This period is closed — posting into it is refused. Re-open it first."
  -- on the Bills screen -- for an operation that worked before this branch.
  --
  -- Task 7b's justification applies verbatim ("the expense editor has a free
  -- date field"), and this is the same answer 20260908000300 gave for a
  -- backdated sale and 20260908000650 for a correction to a closed month:
  -- recognise it in the OPEN period, with the true date and the period's status
  -- written into the description. Redating is what closing MEANS.
  --
  -- READ, not caught. open_period_for raises for any non-open period, and
  -- catching that exception would also swallow an unbalanced entry, an unknown
  -- account code or a missing chart of accounts -- and quietly retry them into
  -- the current month as though the only thing wrong were the date.
  --
  -- The PAYMENT ROW keeps p_paid_on either way. The money really did move that
  -- day; only its recognition moves, and the description says so.
  select status into v_period_status
    from public.accounting_periods
   where shop_id = v_invoice.shop_id and p_paid_on between starts_on and ends_on;

  -- No row means open_period_for will create it open, so only an EXISTING
  -- non-open period redirects.
  if v_period_status is not null and v_period_status <> 'open' then
    v_posted_date := public.shop_local_date();
  else
    v_posted_date := p_paid_on;
  end if;

  v_entry_id := public.post_journal_entry(
    v_invoice.shop_id, v_posted_date,
    -- coalesce on the status for the reason 20260908000300 found the hard way:
    -- the branch above cannot set v_posted_date <> p_paid_on while
    -- v_period_status is NULL, but if that invariant is ever broken by an edit
    -- up there the whole description becomes NULL and post_journal_entry
    -- refuses the payment with `A journal entry needs a description.` -- an
    -- error about descriptions for a bug about dates.
    'Supplier paid'
      || case when v_posted_date <> p_paid_on
              then ' (paid ' || to_char(p_paid_on, 'YYYY-MM-DD')
                   || '; that period is ' || coalesce(v_period_status, 'not open')
                   || ', so it is recognised here)'
              else '' end,
    jsonb_build_array(
      jsonb_build_object('code', '2000', 'amount_cents',  p_amount_cents, 'memo', 'Bill paid'),
      jsonb_build_object('code', public.account_code_for_payment_method(p_method),
                         'amount_cents', -p_amount_cents, 'memo', 'Paid by ' || p_method)),
    v_invoice.location_id, 'payment');
  update public.invoice_payments set journal_entry_id = v_entry_id where id = v_payment_id;

  return v_payment_id;
end;
$$;

comment on function public.record_invoice_payment(uuid, integer, date, text, text) is
  'Records a payment against a vendor bill and posts Dr 2000 Accounts Payable / Cr the account the payment method maps to. Deliberately posts NO expense: the cost was recognised when the bill was raised.';

grant execute on function public.record_invoice_payment(uuid, integer, date, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- post_payroll_run -- reproduced from 20260816000000_location_on_accounting.sql,
-- its newest definition (advisory lock, per-member overlap guard, blocking
-- warnings and the store on the expense all carried across verbatim), with the
-- posting block added.
-- ---------------------------------------------------------------------------

create or replace function public.post_payroll_run(p_run_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $$
declare
  v_run public.payroll_runs%rowtype;
  v_total integer;
  v_expense_id uuid;
  v_entry_id uuid;
  v_conflict_names text;
  v_conflict_count integer;
  v_blocked_names text;
  v_blocked_count integer;
  v_lock_shop uuid;
begin
  -- Serialises posting within a shop. The row lock below covers only THIS run,
  -- so two different overlapping runs sharing a member each locked a different
  -- row, neither saw the other's uncommitted 'posted' status, and both
  -- succeeded -- paying that member twice. Harmless while the old shop-wide
  -- guard rejected overlapping runs outright; per-member cadence makes
  -- overlapping drafts the normal mode, so the race became reachable.
  --
  -- The shop id is read separately because v_run isn't populated until the
  -- statement below, so the lock key can't be derived from it yet. Transaction-
  -- scoped, so it releases on commit or rollback with nothing to unlock
  -- explicitly. Keyed on the shop, so posts in different shops never block each
  -- other. Taken BEFORE the row lock so every guard below reads committed state
  -- rather than racing a concurrent post.
  --
  -- ADVISORY LOCK CLASSID REGISTRY -- Postgres has ONE global advisory keyspace,
  -- shared by every feature in the database. The two-argument form reserves a
  -- classid so a future caller can't collide with payroll posting:
  --   74920 = payroll posting (this function)
  --   74921 = ledger backfill (public.backfill_shop_ledger, 20260908000700)
  -- Pick a distinct, non-round classid for any new advisory lock. 1, 2 and 100
  -- are what a naive caller reaches for, which is exactly why they're unsafe.
  select shop_id into v_lock_shop from public.payroll_runs where id = p_run_id;
  if v_lock_shop is null then
    raise exception 'pay run % not found', p_run_id;
  end if;
  perform pg_advisory_xact_lock(74920, hashtext(v_lock_shop::text));

  select * into v_run from public.payroll_runs where id = p_run_id for update;
  if v_run.id is null then
    raise exception 'pay run % not found', p_run_id;
  end if;
  if not (public.has_shop_permission(v_run.shop_id, 'people.payroll.manage')
          and public.has_shop_permission(v_run.shop_id, 'expenses.manage')) then
    raise exception 'not authorized to post pay runs for shop %', v_run.shop_id;
  end if;
  if v_run.status = 'posted' then
    raise exception 'this pay run has already been posted';
  end if;
  -- A draft still pointing at a ledger entry is a state nothing can produce:
  -- unpost_payroll_run reverses the entry and clears the pointer in the same
  -- statement that returns the run to draft. Refused loudly rather than
  -- overwritten, because overwriting orphans the old entry and doubles 6200
  -- with a trial balance that still zeroes.
  if v_run.journal_entry_id is not null then
    raise exception 'this pay run already carries a ledger entry; unpost it before posting again'
      using errcode = 'P0001';
  end if;

  with conflicts as (
    select distinct coalesce(l.member_name, 'A staff member') as name
    from public.payroll_runs r
      join public.payroll_run_lines l on l.payroll_run_id = r.id
    where r.shop_id = v_run.shop_id
      and r.id <> v_run.id
      and r.status = 'posted'
      and r.period_start <= v_run.period_end
      and r.period_end   >= v_run.period_start
      and l.shop_member_id in (
        select shop_member_id from public.payroll_run_lines where payroll_run_id = p_run_id
      )
  )
  select
    (select string_agg(name, ', ' order by name) from (select name from conflicts order by name limit 6) top6),
    (select count(*) from conflicts)
  into v_conflict_names, v_conflict_count;
  if v_conflict_names is not null then
    raise exception '% was already paid for part of % to %',
      case when v_conflict_count > 6 then v_conflict_names || ' and others' else v_conflict_names end,
      v_run.period_start, v_run.period_end;
  end if;

  with blocked as (
    select distinct coalesce(member_name, 'A staff member') as name
    from public.payroll_run_lines
    where payroll_run_id = p_run_id
      and warning_blocking
      and amount_cents = 0
  )
  select
    (select string_agg(name, ', ' order by name) from (select name from blocked order by name limit 6) top6),
    (select count(*) from blocked)
  into v_blocked_names, v_blocked_count;
  if v_blocked_names is not null then
    raise exception 'no amount set for % — enter an amount, or set a pay rate in People',
      case when v_blocked_count > 6 then v_blocked_names || ' and others' else v_blocked_names end;
  end if;

  select coalesce(sum(amount_cents), 0) into v_total
    from public.payroll_run_lines where payroll_run_id = p_run_id;
  if v_total <= 0 then
    raise exception 'this pay run has nothing to pay';
  end if;

  insert into public.expenses (shop_id, location_id, occurred_on, amount_cents, category, payment_method, note, created_by, payroll_run_id)
    values (
      v_run.shop_id,
      -- The run's store travels onto the cost it produces. Without this a pay
      -- run for one store would post a business-wide expense, and that store's
      -- P&L would show its revenue with none of its labour against it.
      v_run.location_id,
      v_run.period_end,
      v_total,
      'salaries_wages',
      'cash',
      'Payroll ' || v_run.period_start || ' to ' || v_run.period_end,
      auth.uid(),
      v_run.id
    )
    returning id into v_expense_id;

  -- Cash, not 2200 Wages Payable: post_payroll_run records a run that HAS been
  -- paid. Accruing wages that are owed but unpaid is phase 3's work, and 2200
  -- stays unused until then rather than being written to speculatively.
  --
  -- Dated the shop's local date -- see this file's header. payroll_runs has no
  -- paid_on to prefer, and the day a run is paid is the day it is posted.
  --
  -- Deliberately NOT dated v_run.period_end, which is where the EXPENSE row
  -- above lands. period_end is often in a month somebody has already closed,
  -- and open_period_for raises on a closed month -- so dating the entry there
  -- would make an ordinary "post July's wages in August" fail outright, a new
  -- failure mode in an RPC that works today. The divergence between the two
  -- dates is real and belongs to Task 8, which decides one date for the
  -- backfill of both.
  v_entry_id := public.post_journal_entry(
    v_run.shop_id, public.shop_local_date(), 'Payroll',
    jsonb_build_array(
      jsonb_build_object('code', '6200', 'amount_cents',  v_total, 'memo', 'Wages'),
      jsonb_build_object('code', '1000', 'amount_cents', -v_total, 'memo', 'Paid out')),
    v_run.location_id, 'payroll');

  update public.payroll_runs set
    status = 'posted',
    total_cents = v_total,
    expense_id = v_expense_id,
    journal_entry_id = v_entry_id,
    posted_at = now(),
    posted_by = auth.uid(),
    updated_at = now()
  where id = p_run_id;

  -- Still the EXPENSE id, not the run id and not the entry id. src/lib/
  -- payroll.ts reads it, and the plan's own draft test assumed a run id --
  -- which silently looked up nothing.
  return v_expense_id;
end;
$$;

comment on function public.post_payroll_run(uuid) is
  'Posts a pay run: writes one salaries_wages expense and one journal entry (Dr 6200 Salaries and Wages / Cr 1000 Cash) for the run total, under a shop-wide advisory lock. Returns the EXPENSE id. Cash rather than 2200 Wages Payable because a posted run has been paid; accrual is phase 3.';

grant execute on function public.post_payroll_run(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- unpost_payroll_run -- reproduced from 20260804000400_payroll.sql, its newest
-- and only definition, with the ledger reversal added. See this file's header
-- for why it is in scope.
-- ---------------------------------------------------------------------------

create or replace function public.unpost_payroll_run(p_run_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_run public.payroll_runs%rowtype;
  v_old_status text;
  v_old_entry_date date;
  v_old_reference text;
  v_old_location_id uuid;
  v_old_period_status text;
  v_reversal_date date;
  v_reversal_id uuid;
begin
  select * into v_run from public.payroll_runs where id = p_run_id for update;
  if v_run.id is null then
    raise exception 'pay run % not found', p_run_id;
  end if;
  if not (public.has_shop_permission(v_run.shop_id, 'people.payroll.manage')
          and public.has_shop_permission(v_run.shop_id, 'expenses.manage')) then
    raise exception 'not authorized to change pay runs for shop %', v_run.shop_id;
  end if;
  if v_run.status <> 'posted' then
    raise exception 'this pay run is not posted';
  end if;

  delete from public.expenses where payroll_run_id = p_run_id;

  -- The ledger half of the same undoing. Null on a run posted before this
  -- migration shipped: there is nothing to reverse, and that is not an error.
  if v_run.journal_entry_id is not null then
    select status, entry_date, reference, location_id
      into v_old_status, v_old_entry_date, v_old_reference, v_old_location_id
      from public.journal_entries where id = v_run.journal_entry_id;

    if v_old_status <> 'posted' then
      raise exception 'the journal entry for this pay run is %, so it cannot be reversed', v_old_status
        using errcode = 'P0001';
    end if;

    -- READ, not caught. open_period_for raises for any non-open period, and
    -- catching that would also swallow a genuinely broken chart of accounts.
    -- No row means open_period_for will create the period open, so only an
    -- EXISTING non-open period redirects the reversal to today.
    select status into v_old_period_status
      from public.accounting_periods
     where shop_id = v_run.shop_id and v_old_entry_date between starts_on and ends_on;
    if v_old_period_status is not null and v_old_period_status <> 'open' then
      v_reversal_date := public.shop_local_date();
    else
      v_reversal_date := v_old_entry_date;
    end if;

    -- What reverse_journal_entry(uuid, text) does, minus its ledger.post gate
    -- -- see this file's header. The reference is the original's with an R so
    -- the pair reads as a pair; coalesce in the DESCRIPTION only, because `||`
    -- with a NULL operand yields NULL for the whole expression and a null
    -- description is refused by check (length(trim(description)) > 0). The
    -- reference itself may stay null: unique (shop_id, reference) treats nulls
    -- as distinct, which is the honest answer for the mirror of an
    -- unreferenced entry.
    --
    -- source 'payroll', not 'manual': this is the payroll door undoing its own
    -- entry, and a reader filtering the payroll source should see both halves.
    insert into public.journal_entries
        (shop_id, period_id, entry_date, reference, description, source, status,
         location_id, reverses_entry_id, created_by)
      values (
        v_run.shop_id,
        public.open_period_for(v_run.shop_id, v_reversal_date),
        v_reversal_date,
        v_old_reference || 'R',
        'Reversal of ' || coalesce(v_old_reference, 'an unreferenced entry')
          || ' — pay run ' || p_run_id::text || ' was unposted'
          || case when v_reversal_date <> v_old_entry_date
                  then ' (originally dated ' || to_char(v_old_entry_date, 'YYYY-MM-DD')
                       || '; that period is ' || coalesce(v_old_period_status, 'not open')
                       || ', so the reversal is recognised here)'
                  else '' end,
        'payroll', 'posted', v_old_location_id, v_run.journal_entry_id, auth.uid())
      returning id into v_reversal_id;

    insert into public.journal_lines (entry_id, account_id, amount_cents, location_id, memo)
      select v_reversal_id, account_id, -amount_cents, location_id, memo
        from public.journal_lines where entry_id = v_run.journal_entry_id;

    -- The one update refuse_posted_entry_edit() permits, and the link that
    -- makes neither entry readable without finding the other.
    update public.journal_entries
       set status = 'reversed', reverses_entry_id = v_reversal_id
     where id = v_run.journal_entry_id;
  end if;

  update public.payroll_runs set
    status = 'draft',
    expense_id = null,
    -- Cleared, or the next post overwrites it, orphans the entry above and
    -- doubles 6200 while the trial balance still zeroes.
    journal_entry_id = null,
    posted_at = null,
    posted_by = null,
    updated_at = now()
  where id = p_run_id;
end;
$$;

comment on function public.unpost_payroll_run(uuid) is
  'Returns a posted pay run to draft: deletes its generated expense AND reverses its journal entry, leaving both the original and the reversal on the record. Clearing journal_entry_id is what lets the run be posted again without doubling 6200.';

grant execute on function public.unpost_payroll_run(uuid) to authenticated;
