-- An expense recorded from the Expenses screen posts to the ledger.
--
-- ## Why this is a trigger, when every other posting site in this phase is not
--
-- The design's premise for phase 2b is "every money move goes through an RPC,
-- so the posting side is added inside the existing function and no call site
-- changes". That is true of all seven RPCs in Tasks 3-7. It is NOT true of
-- expenses: src/lib/expenses.ts:96 does a plain `.from('expenses').insert()`.
-- There is no function to add a posting side to.
--
-- Without this migration, Task 8's backfill would post every historical
-- expense and the very next expense a shop records would go unposted. The P&L
-- would be complete up to the backfill date and progressively wrong after it --
-- the worst of the three possible states, because it looks right.
--
-- Three ways out were considered. Bringing create_bill forward from phase 3 is
-- correct and is what the design ultimately wants, but it is a new RPC plus a
-- screen change -- phase-3-sized work inside a phase-2b plan. Shipping the hole
-- behind a caveat on the Expenses screen invents a nightly job that does not
-- exist. This is option (1): the seam is where the row is written, so the
-- trigger goes there. It reuses the mapping 20260908000000 already built, and
-- it means the trial balance is complete on the day this phase ships rather
-- than on the day phase 3 does.
--
-- The cost of the choice, stated rather than hidden: this codebase has
-- deliberately kept money logic in RPCs rather than triggers, and a trigger
-- that can raise makes every expense insert able to fail on a ledger problem.
-- The closed-period redirect below is there because that failure mode is
-- otherwise reachable from an ordinary back-dated receipt.
--
-- ## The mapping is what makes a balance sheet possible
--
-- account_code_for_expense_category sends 'inventory_purchase' to 1200
-- Inventory -- an ASSET, not a cost -- and 'owner_draw' to 3100 Owner's Draw --
-- CONTRA-EQUITY, not a cost. NON_OPERATING_CATEGORIES in
-- src/lib/expense-reporting.ts reaches the right net profit today by EXCLUDING
-- those two from the operating subtotal: the right answer by the wrong route,
-- because a filter in a reporting helper cannot also produce a balance sheet.
-- Once these entries exist, the exclusion becomes a CONSEQUENCE of where each
-- account sits rather than a list somebody has to remember to keep in step.
-- 'stock_loss' goes to 5100, above gross profit, for the reason 20260908000000
-- gives at that line.
--
-- ## Source is 'bill', not 'payment'
--
-- journal_entries.source's CHECK permits manual, sale, refund, settlement,
-- bill, payment, payroll, stock, count, transfer, asset, depreciation, close,
-- opening. 'payment' is already taken by record_invoice_payment, whose entry
-- is Dr 2000 Accounts Payable / Cr a wallet and touches no expense account at
-- all. Reusing it here would make `where source = 'payment'` return two
-- structurally different entries, and any phase-3 report that groups by source
-- would mix a liability settlement with a cost recognition.
--
-- 'bill' is the recognition of a cost the shop has incurred, which is exactly
-- what an expenses row is -- 20260904000300's own comment on entry_date uses
-- "a bill entered on 3 September for August utilities" as the example. It is
-- unused by any other door today.

-- ---------------------------------------------------------------------------
-- The exclusion. Read this before changing anything below it.
-- ---------------------------------------------------------------------------
--
-- WHICH RPCs WRITE `expenses` ROWS, and what each one sets:
--
--   * post_payroll_run (newest definition: 20260908000500) writes an expenses
--     row carrying payroll_run_id AND posts its own journal entry
--     (Dr 6200 Salaries and Wages / Cr 1000 Cash) in the same call.
--   * sync_invoice_expense (newest definition: 20260816000000), the AFTER
--     INSERT trigger on invoices, mirrors a bill into expenses carrying
--     invoice_id -- 20260804000300: "a bill is an unpaid expense". The
--     liability side is posted by receive_stock (Cr 2000) and settled by
--     record_invoice_payment (Dr 2000). The cost is recognised by the bill.
--   * log_recurring_bill (newest definition: 20260816000000) writes a plain
--     expenses row with NEITHER column set. It is deliberately NOT excluded:
--     nothing else posts for it, and it is a real cost the shop just incurred.
--
-- SO THIS TRIGGER MUST SKIP payroll_run_id IS NOT NULL AND invoice_id IS NOT
-- NULL. Removing either exclusion double-posts:
--
--   * payroll: 6200 Salaries and Wages and 1000 Cash would each be counted
--     TWICE for one pay run -- once by post_payroll_run's own entry and once
--     by this trigger. The trial balance would still zero, because both
--     entries individually balance, so nothing else in the system would catch
--     it. Check 4 of verify-posting-expenses.sql is the check that does.
--   * bills: the cost would be recognised when the bill arrives (here) and
--     AGAIN when the goods arrive (receive_stock's Cr 2000 against Dr 1200),
--     doubling every stocked cost the shop has.
--
-- journal_entry_id IS NOT NULL is skipped for the same reason
-- 20260908000100 added the column: a row that already carries an entry has
-- already been posted, and Task 8's backfill sets exactly that column. Without
-- this, a backfill that ran while this trigger was live would post twice.
--
-- Task 8's backfill must apply THE SAME THREE EXCLUSIONS to its expense
-- replay, for the same reasons.

create or replace function public.post_expense_to_ledger() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_debit_code   text;
  v_credit_code  text;
  v_period_status text;
  v_posted_date  date;
  v_entry_id     uuid;
begin
  -- See the exclusion block above this function. Do not remove these three
  -- without reading it; post_payroll_run is named there by name.
  if new.payroll_run_id is not null then return null; end if;
  if new.invoice_id is not null then return null; end if;
  if new.journal_entry_id is not null then return null; end if;

  v_debit_code := public.account_code_for_expense_category(new.category);

  -- The wallet the money actually left, not 1000 Cash for everything.
  -- expenses.payment_method carries the same four values invoice_payments.method
  -- does and account_code_for_expense_category's sibling already maps them.
  -- Hardcoding 1000 would make the till count disagree with the ledger for
  -- every zaad or eDahab expense, and leave 1020/1021 permanently understated
  -- on the balance sheet this phase exists to make possible -- the exact defect
  -- verify-posting-bills.sql check 2 exists to catch on the supplier-payment
  -- side. For the common case (payment_method defaults to 'cash') this IS
  -- '1000'.
  v_credit_code := public.account_code_for_payment_method(new.payment_method);

  -- occurred_on, not today: 20260804000200 makes the point that a receipt is
  -- often logged days after the purchase and it is the PURCHASE date that
  -- decides the period. It is already a `date` column, so it is exempt from the
  -- shop_local_date() rule -- there is no moment in time to resolve against a
  -- server timezone, and wrapping it would be a no-op cast through a function
  -- that expects a timestamptz.
  --
  -- A BACK-DATED EXPENSE WHOSE MONTH HAS CLOSED POSTS TO THE OPEN ONE, which
  -- is Task 3b's treatment of a back-dated sale and is here for a stronger
  -- reason: the expense editor has a free date field
  -- (expense-editor-modal.tsx:101), so back-dating is not an import edge case,
  -- it is the ordinary way a receipt from last week gets entered. Without this,
  -- open_period_for would raise `This period is closed` and a plain expense
  -- insert -- something that works today -- would start failing outright.
  --
  -- READ, not caught. An exception handler around post_journal_entry would also
  -- swallow an unbalanced entry, an unknown account code or a missing chart of
  -- accounts and retry them into the current month as though the only thing
  -- wrong were the date.
  select status into v_period_status
    from public.accounting_periods
   where shop_id = new.shop_id and new.occurred_on between starts_on and ends_on;

  -- No row means open_period_for will create it open, so only an EXISTING
  -- non-open period redirects. Treating a missing row as shut would redate
  -- every expense in a month the shop has not traded in yet.
  if v_period_status is not null and v_period_status <> 'open' then
    v_posted_date := public.shop_local_date();
  else
    v_posted_date := new.occurred_on;
  end if;

  -- The description carries the expense id so the link is readable in both
  -- directions -- expenses.journal_entry_id gets you from the row to the entry,
  -- and a journal of four hundred lines all reading 'Expense' gets you nowhere
  -- back. Task 8's backfill reconciles replayed entries against their source
  -- rows and wants the same link.
  --
  -- coalesce on v_period_status even though the branch above cannot leave it
  -- NULL while the dates differ: `||` with a NULL operand yields NULL for the
  -- WHOLE expression, and post_journal_entry then refuses the row with
  -- "A journal entry needs a description." -- an error about descriptions for a
  -- bug about dates. The same trap 20260908000300 documents.
  v_entry_id := public.post_journal_entry(
    new.shop_id,
    v_posted_date,
    'Expense ' || new.id::text
      || case when v_posted_date <> new.occurred_on
              then ' (incurred ' || to_char(new.occurred_on, 'YYYY-MM-DD')
                   || '; that period is ' || coalesce(v_period_status, 'not open')
                   || ', so it is recognised here)'
              else '' end,
    jsonb_build_array(
      jsonb_build_object('code', v_debit_code,  'amount_cents',  new.amount_cents,
                         'memo', replace(new.category, '_', ' ')),
      jsonb_build_object('code', v_credit_code, 'amount_cents', -new.amount_cents,
                         'memo', 'Paid by ' || new.payment_method)),
    -- The store the cost belongs to travels onto the entry, for the reason
    -- 20260816000000 exists: a cost with no store drops out of that store's
    -- P&L. Null stays null for a business-wide expense, which is a real value
    -- and not a gap.
    new.location_id,
    'bill');

  -- AFTER INSERT, so `new` is not writable -- assigning to it here would be
  -- silently discarded rather than rejected. The row is updated instead.
  --
  -- AFTER rather than BEFORE deliberately: post_journal_entry's description
  -- carries new.id, and in a BEFORE INSERT trigger that id is the default the
  -- row is ABOUT to get -- which is fine -- but the entry would also be written
  -- before the row's own constraints (amount_cents > 0, the category CHECK,
  -- enforce_shop_module) had all been proved. AFTER means the ledger only ever
  -- learns about an expense the table has already accepted.
  update public.expenses set journal_entry_id = v_entry_id where id = new.id;

  return null;
end;
$$;

comment on function public.post_expense_to_ledger() is
  'AFTER INSERT on expenses: posts Dr the account the category maps to / Cr the account the payment method maps to, and points the row at the entry. Skips rows carrying payroll_run_id or invoice_id -- post_payroll_run and the bill/receive_stock pair already post those, and posting again would double them.';

-- Row-level, so an insert of several expenses at once posts one entry each.
-- One entry per row rather than one per statement: each expense has its own
-- date, store and category, and the ledger is read per account per period.
drop trigger if exists expenses_post_to_ledger on public.expenses;
create trigger expenses_post_to_ledger
  after insert on public.expenses
  for each row execute function public.post_expense_to_ledger();
