-- The two money-out RPCs -- record_invoice_payment and post_payroll_run --
-- write a balanced double-entry journal entry in the same transaction that
-- moves the money.
--
-- What is asserted, and why each one is here rather than in a TypeScript test:
-- every one is a fact about rows this database wrote for itself.
--
--   1. Paying a supplier posts Dr 2000 Accounts Payable / Cr the wallet it was
--      actually paid from. It posts NO expense. The cost was recognised when
--      the bill arrived (20260804000300: "a bill is an unpaid expense"), and
--      posting 6xxx again here would double every cost the shop has -- the
--      single most common double-count in a first ledger. Asserted as "no
--      expense-type line exists at all", not as "the amount is right": a
--      6900/1020 pair balances perfectly and would sail past a totals check.
--   2. The credit lands on the account the METHOD maps to, not the till.
--      'zaad' is 1020 (20260908000000). The plan's own draft of this script
--      expected 1021 eDahab for a payment made by zaad -- 1021 is the eDahab
--      account, so that assertion would have been red against a correct
--      implementation.
--   3. The payment entry is dated p_paid_on, not today. p_paid_on is a date
--      parameter and is exempt from the shop_local_date() rule; its DEFAULT
--      was not, and is asserted structurally in check 8.
--   4. A pay run posts Dr 6200 Salaries and Wages / Cr 1000 Cash, for the
--      whole run. Cash, not 2200 Wages Payable: post_payroll_run records a run
--      that HAS been paid. 2200 is asserted ABSENT, because a 6200/2200 pair
--      balances just as happily while claiming the staff have not been paid.
--   5. Both entries carry their own source -- 'payment' and 'payroll', the two
--      values journal_entries.source's CHECK permits for these doors. The plan
--      said 'bill_payment', which is not in the constraint and would have
--      failed the whole transaction on the first call.
--   6. Re-posting an already-posted run writes no second entry. See the long
--      comment at that check: it exercises the PRE-EXISTING status guard, and
--      it structurally cannot see a second entry even if one were written.
--   7. THE ONE THAT ACTUALLY BITES. unpost then re-post -- the only path by
--      which a run can be posted twice for real -- leaves 6200 at the run's
--      total, not double it. Without the reversal this task adds to
--      unpost_payroll_run, the first entry is orphaned and wages double.
--   8. Both function bodies are read from pg_get_functiondef and checked for
--      current_date / now()::date. Somalia is UTC+3, so a value comparison
--      only separates the two answers for three hours a day.
--  11. ENTERING a bill recognises its cost: Dr the category's account /
--      Cr 2000, posted by the expenses row sync_invoice_expense mirrors from
--      the invoice. Nothing on this branch posts when an `invoices` row is
--      inserted, so that row is the whole of the recognition -- and until the
--      final review it was skipped, which made every check 1-10 above green
--      while a rent bill reached no expense account and paying it drove
--      Accounts Payable negative.
--  12. THE ONE WHOSE ABSENCE LET THAT THROUGH. A bill entered and then paid IN
--      FULL leaves 2000 at exactly zero, measured across the bill's entry and
--      its payments' together. Per entry both halves look perfect.
--  14. UNDOING A PAYMENT REVERSES ITS ENTRY. delete_invoice_payment deleted the
--      row and recomputed paid_cents and left the Dr 2000 / Cr wallet entry
--      standing, so the bill read unpaid while the ledger said the payable had
--      been cleared -- 2000 understated by the undone amount for ever. Closed by
--      re-asserting check 13's identity after an undo, which is the view it is
--      visible in.
--  15. AND A PAYMENT WHOSE MONTH HAS SINCE CLOSED IS REDATED, NOT REFUSED --
--      check 9 one step on: a payment that posted perfectly well at the time and
--      is undone after its month was shut.
--  13. And shop-wide, 2000 equals what `invoices` says is still outstanding --
--      asserted against amount_cents less paid_cents, columns no journal-line
--      statement reads, rather than re-derived from the ledger itself.
--
-- Deliberately NOT `set role authenticated`, for the same reason
-- verify-posting-inventory.sql is not: this script stays superuser so RLS never
-- hides a journal_lines row from its own assertions. Nothing under test is an
-- RLS policy -- both RPCs are security definer and gate on
-- has_shop_permission(), which reads auth.uid() from the JWT claim set below.
--
-- Everything runs inside one DO block whose EXCEPTION clause rolls it all back.

\set ON_ERROR_STOP on

do $$
declare
  v_user_id    uuid := gen_random_uuid();
  v_user_two   uuid := gen_random_uuid();
  v_user_three uuid := gen_random_uuid();
  v_shop_id    uuid;
  v_loc_id     uuid;
  v_role_id    uuid;
  v_member_one uuid;
  v_member_two uuid;
  v_member_3   uuid;
  v_invoice_id uuid;
  v_payment_id uuid;
  v_run_id     uuid;
  v_entry      uuid;
  v_entry_loc  uuid;
  v_amount     bigint;
  v_rows       integer;
  v_text       text;
  v_date       date;
  v_paid_on    date;
  v_src        text;
  v_raised     boolean;
  -- Checks 11-13: the bill that is entered and then paid off in full.
  v_bill_two   uuid;
  v_bill_entry uuid;
  v_was_2000   bigint;
  v_was_6100   bigint;
  v_outstanding bigint;
  -- Checks 14-15: undoing a payment.
  v_first_payment uuid;   -- check 1's 4300 zaad payment, undone by check 14.
  v_ctrl_payment  uuid;   -- check 9's control payment, undone by check 15.
  v_ctrl_on       date;   -- and the month it was recognised in, closed there.
  v_was_1020      bigint;
  v_rev           uuid;
  v_status        text;
  -- Checks 16-18: deleting a bill, in each of its three payment states.
  v_bill_del      uuid;
  v_bill_del_e    uuid;   -- the entry the bill's mirrored expense row posted.
  v_pay_one       uuid;
  v_pay_two       uuid;
  v_pay_one_e     uuid;
  v_pay_two_e     uuid;
  v_was_1000      bigint;
  -- Checks 22-24: the bill that names the delivery it pays for.
  v_prod          uuid;
  v_delivery      uuid;   -- costed, and the one the linked bill points at.
  v_dry_delivery  uuid;   -- received with no costs on it, so it reached no book.
  v_bill_linked   uuid;
  v_bill_hist     uuid;   -- the shape history is full of and the door refuses.
  v_2000_was      bigint;
  v_2000_now      bigint;
  v_6400_was      bigint;
  v_ap_now        bigint;
begin
  -- shops.owner_id and shop_members.user_id both reference auth.users(id), so
  -- the fixture "people" need real rows there before anything else.
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
  select u, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
         'verify-posting-bills-' || u || '@example.test', '', now(), now(), now()
    from unnest(array[v_user_id, v_user_two, v_user_three]) u;

  insert into public.shops (owner_id, name) values (v_user_id, 'Posting Bills Shop')
    returning id into v_shop_id;

  -- A shop has no location until the fixture makes one; seed_shop_defaults does
  -- not create one. It DOES seed the chart of accounts, which is where 1000,
  -- 1020, 2000, 2200 and 6200 come from.
  insert into public.shop_locations (shop_id, name, is_primary)
    values (v_shop_id, 'Main', true) returning id into v_loc_id;

  -- has_shop_permission -> auth.uid() -> request.jwt.claims->>'sub'. Without
  -- this every call below is refused as unauthorized.
  perform set_config('request.jwt.claims', json_build_object('sub', v_user_id)::text, true);

  ---------------------------------------------------------------------------
  -- 1-3, 5. Paying a supplier.
  ---------------------------------------------------------------------------
  -- The bill is 50000 and the payment 4300, so the payment is a part payment
  -- and cannot be confused with the bill's own amount anywhere below. Its
  -- category is 'rent', which account_code_for_expense_category maps to 6000 --
  -- an EXPENSE account -- so the "no expense line" assertion is testing the
  -- account a wrong implementation would really reach for.
  insert into public.invoices (shop_id, location_id, vendor_name, invoice_number,
                               category, issued_on, due_on, amount_cents)
    values (v_shop_id, v_loc_id, 'Posting Vendor', 'BILLS-1', 'rent',
            public.shop_local_date() - 5, public.shop_local_date() + 10, 50000)
    returning id into v_invoice_id;

  -- Two days back, so an implementation that reached for today's date instead
  -- of p_paid_on separates from a correct one on every day of the year rather
  -- than only in the three-hour window where UTC and Mogadishu disagree.
  v_paid_on := public.shop_local_date() - 2;

  v_payment_id := public.record_invoice_payment(v_invoice_id, 4300, v_paid_on, 'zaad');
  -- Kept for check 14, which undoes this payment. Paid by ZAAD deliberately:
  -- 1020 is touched by nothing else in this fixture, so the reversal's credit
  -- side can be read by account rather than only by amount.
  v_first_payment := v_payment_id;
  select journal_entry_id into v_entry from public.invoice_payments where id = v_payment_id;
  if v_entry is null then raise exception 'FAIL: the invoice payment did not post'; end if;

  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l join public.accounts a on a.id = l.account_id
   where l.entry_id = v_entry and a.code = '2000';
  if v_amount <> 4300 then
    raise exception 'FAIL: expected Dr 2000 Payable 4300, got % (50000 = the bill, not the payment)', v_amount;
  end if;

  -- Against the wallet it was actually paid from, not the till. 'zaad' is
  -- 1020; 1021 is eDahab and belongs to a different payment method.
  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l join public.accounts a on a.id = l.account_id
   where l.entry_id = v_entry and a.code = '1020';
  if v_amount <> -4300 then
    raise exception 'FAIL: expected Cr 1020 Zaad -4300, got % (paid by zaad should not touch 1000 Cash)', v_amount;
  end if;

  -- The whole point of the task. Asserted as "no expense line exists", not as
  -- an amount: an entry that debited 6000 Rent and credited 1020 balances, and
  -- every amount check above would still pass.
  if exists (select 1 from public.journal_lines l join public.accounts a on a.id = l.account_id
              where l.entry_id = v_entry and a.type = 'expense') then
    raise exception 'FAIL: paying a bill must not post an expense a second time';
  end if;

  select source, entry_date, location_id into v_text, v_date, v_entry_loc
    from public.journal_entries where id = v_entry;
  -- 'payment'. The plan said 'bill_payment', which journal_entries.source's
  -- CHECK does not permit -- the call would have failed outright, taking the
  -- payment with it.
  if v_text <> 'payment' then
    raise exception 'FAIL: expected source ''payment'', got %', v_text;
  end if;
  if v_date <> v_paid_on then
    raise exception 'FAIL: the payment entry should be dated %, got %', v_paid_on, v_date;
  end if;
  -- The bill's store travels onto the entry. A payment for the Berbera bill
  -- that posted with no store would drop out of that store's cash picture,
  -- which is the exact bug 20260816000000 exists to close on the expense side.
  if v_entry_loc is distinct from v_loc_id then
    raise exception 'FAIL: the payment entry should carry the bill''s store';
  end if;

  ---------------------------------------------------------------------------
  -- 4, 5. A pay run posts wages against cash.
  ---------------------------------------------------------------------------
  -- Three members at 15000, 22000 and 9000 = 46000. No two of them sum to it,
  -- so a dropped member cannot pass by arithmetic coincidence.
  insert into public.roles (shop_id, name, permissions)
    values (v_shop_id, 'Posting Bills Staff', array['expenses.manage'])
    returning id into v_role_id;

  -- The owner already has a shop_members row (20260823000000) and the table is
  -- unique on (shop_id, user_id), so member one is that row updated rather than
  -- a second one inserted.
  update public.shop_members
     set role_id = v_role_id, active = true, full_name = 'Payroll One'
   where shop_id = v_shop_id and user_id = v_user_id
   returning id into v_member_one;
  insert into public.shop_members (shop_id, user_id, role_id, active, full_name)
    values (v_shop_id, v_user_two, v_role_id, true, 'Payroll Two') returning id into v_member_two;
  insert into public.shop_members (shop_id, user_id, role_id, active, full_name)
    values (v_shop_id, v_user_three, v_role_id, true, 'Payroll Three') returning id into v_member_3;

  insert into public.payroll_runs (shop_id, location_id, period_start, period_end)
    values (v_shop_id, v_loc_id, public.shop_local_date() - 7, public.shop_local_date() - 1)
    returning id into v_run_id;
  insert into public.payroll_run_lines (payroll_run_id, shop_member_id, member_name, amount_cents)
    values (v_run_id, v_member_one, 'Payroll One',   15000),
           (v_run_id, v_member_two, 'Payroll Two',   22000),
           (v_run_id, v_member_3,   'Payroll Three',  9000);

  -- PERFORM, not assignment. post_payroll_run returns the EXPENSE id, not the
  -- run id (20260816000000). The plan's draft wrote
  -- `v_run_id := public.post_payroll_run(v_run_id)`, which replaced the run id
  -- with an expenses.id and made every lookup below find no row -- reported as
  -- "the pay run did not post" against a perfectly correct implementation.
  perform public.post_payroll_run(v_run_id);
  select journal_entry_id into v_entry from public.payroll_runs where id = v_run_id;
  if v_entry is null then raise exception 'FAIL: the pay run did not post'; end if;

  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l join public.accounts a on a.id = l.account_id
   where l.entry_id = v_entry and a.code = '6200';
  if v_amount <> 46000 then
    raise exception 'FAIL: expected Dr 6200 Salaries 46000, got % (37000/31000/24000 = a member dropped)', v_amount;
  end if;
  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l join public.accounts a on a.id = l.account_id
   where l.entry_id = v_entry and a.code = '1000';
  if v_amount <> -46000 then
    raise exception 'FAIL: expected Cr 1000 Cash -46000, got %', v_amount;
  end if;
  -- 2200 Wages Payable stays unused until phase 3's accrual work. Asserted
  -- absent rather than left unchecked: 6200 against 2200 balances exactly as
  -- well as 6200 against 1000, while saying the staff have NOT been paid --
  -- and post_payroll_run is only ever called for a run that has been.
  if exists (select 1 from public.journal_lines l join public.accounts a on a.id = l.account_id
              where l.entry_id = v_entry and a.code = '2200') then
    raise exception 'FAIL: a paid run must not credit 2200 Wages Payable -- the money has left';
  end if;

  select source, entry_date into v_text, v_date
    from public.journal_entries where id = v_entry;
  if v_text <> 'payroll' then
    raise exception 'FAIL: expected source ''payroll'', got %', v_text;
  end if;
  -- payroll_runs has NO paid_on column -- the plan's coalesce(v_run.paid_on,
  -- current_date) names a field that does not exist and would raise at
  -- runtime. The day a run is paid IS the day it is posted, so the coalesce
  -- collapses to its fallback, corrected from current_date (UTC) to the shop's
  -- local date.
  if v_date <> public.shop_local_date() then
    raise exception 'FAIL: the payroll entry should be dated %, got %', public.shop_local_date(), v_date;
  end if;

  ---------------------------------------------------------------------------
  -- 6. Posting the SAME posted run again writes no second entry.
  ---------------------------------------------------------------------------
  -- HONEST SCOPE OF THIS CHECK: it exercises the PRE-EXISTING status guard
  -- ("this pay run has already been posted"), which sits above every line this
  -- task added. It is kept because that ordering is a real property -- but it
  -- cannot fail for the reason the plan gave it. A plpgsql BEGIN ... EXCEPTION
  -- block is a subtransaction: if the posting call had written an entry before
  -- the status check raised, the raise would roll that entry back with
  -- everything else, and the count below would be unchanged anyway. Check 7 is
  -- the one that can see a second entry, because check 7's second post
  -- SUCCEEDS.
  select count(*) into v_rows from public.journal_entries
   where shop_id = v_shop_id and source = 'payroll';
  v_raised := false;
  begin
    perform public.post_payroll_run(v_run_id);
  exception when others then v_raised := true;
  end;
  if not v_raised then
    raise exception 'FAIL: a posted pay run was posted a second time';
  end if;
  select count(*) - v_rows into v_rows from public.journal_entries
   where shop_id = v_shop_id and source = 'payroll';
  if v_rows <> 0 then
    raise exception 'FAIL: re-posting a pay run wrote % extra entries', v_rows;
  end if;

  ---------------------------------------------------------------------------
  -- 7. THE REACHABLE DOUBLE-POST: unpost, then post again.
  ---------------------------------------------------------------------------
  -- unpost_payroll_run is a button in the app (payroll.ts:unpostPayrollRun).
  -- It deletes the generated expense and returns the run to draft. Before this
  -- task it had no ledger to keep in step; the moment post_payroll_run writes
  -- one, unposting has to undo it too -- otherwise the second post orphans the
  -- first entry and 6200 reads 92000 for 46000 of wages, with the trial
  -- balance still zero because both entries individually balance.
  --
  -- Measured across the WHOLE SHOP, not one entry, which is the only way the
  -- orphan is visible: the run points at the newest entry and every per-entry
  -- assertion above would still pass.
  perform public.unpost_payroll_run(v_run_id);
  if (select journal_entry_id from public.payroll_runs where id = v_run_id) is not null then
    raise exception 'FAIL: unposting left the run pointing at a ledger entry';
  end if;

  perform public.post_payroll_run(v_run_id);
  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l
    join public.accounts a on a.id = l.account_id
    join public.journal_entries e on e.id = l.entry_id
   where e.shop_id = v_shop_id and a.code = '6200';
  if v_amount <> 46000 then
    raise exception 'FAIL: 6200 Salaries reads % after unpost+repost, expected 46000 (92000 = the first entry was orphaned, not reversed)', v_amount;
  end if;
  -- And the undoing is on the record rather than deleted: a book is added to,
  -- not amended.
  select count(*) into v_rows from public.journal_entries
   where shop_id = v_shop_id and status = 'reversed';
  if v_rows <> 1 then
    raise exception 'FAIL: expected exactly 1 reversed entry after unpost+repost, got %', v_rows;
  end if;
  -- The whole shop still zeroes. A reversal that copied the lines without
  -- negating them would net 6200 to 46000 by luck and break this.
  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l join public.journal_entries e on e.id = l.entry_id
   where e.shop_id = v_shop_id;
  if v_amount <> 0 then
    raise exception 'FAIL: the trial balance does not zero, off by %', v_amount;
  end if;

  ---------------------------------------------------------------------------
  -- 8. Structural half of the date checks.
  ---------------------------------------------------------------------------
  -- Check 3 and the payroll date check above compare two values that are equal
  -- for 21 hours a day, so a body saying current_date would pass them outside
  -- the 21:00-24:00 UTC window. Read the live function source instead.
  --
  -- `--` comments are stripped before the regex runs, and that is not
  -- tidiness: both bodies explain in a comment why current_date is wrong, so a
  -- naive match reads the WARNING as the offence and fails a correct
  -- implementation.
  select regexp_replace(pg_get_functiondef(p.oid), '--[^' || chr(10) || ']*', '', 'g') into v_src
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'post_payroll_run';
  if v_src !~ 'shop_local_date' then
    raise exception 'FAIL: post_payroll_run must date its entry from shop_local_date()';
  end if;
  if v_src ~* '\mcurrent_date\M' or v_src ~* 'now\(\)\s*::\s*date' then
    raise exception 'FAIL: post_payroll_run still resolves a date in the server timezone';
  end if;

  -- record_invoice_payment's p_paid_on is a date PARAMETER and is exempt --
  -- there is no moment in time to resolve. Its DEFAULT is not exempt: the app
  -- omits p_paid_on whenever the user does not pick a date (invoices.ts:167),
  -- so `default current_date` decided the date in UTC for the common case.
  select regexp_replace(pg_get_functiondef(p.oid), '--[^' || chr(10) || ']*', '', 'g') into v_src
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'record_invoice_payment';
  if v_src ~* '\mcurrent_date\M' or v_src ~* 'now\(\)\s*::\s*date' then
    raise exception 'FAIL: record_invoice_payment still defaults p_paid_on in the server timezone';
  end if;

  ---------------------------------------------------------------------------
  -- 9. A BACK-DATED SUPPLIER PAYMENT INTO A CLOSED MONTH IS REDATED, NOT REFUSED.
  ---------------------------------------------------------------------------
  -- record_invoice_payment was the only posting site in this phase with a
  -- USER-CHOSEN date and no closed-period redirect.
  -- src/components/accounting/record-payment-modal.tsx gives the user a free
  -- date field and post_journal_entry calls open_period_for, which RAISES on a
  -- closed month -- so a shop that closed January and then, in February,
  -- recorded a supplier payment dated 28 January was told
  -- "This period is closed — posting into it is refused. Re-open it first."
  -- on the Bills screen, for an operation that worked before this branch.
  --
  -- Task 7b's justification for the expense trigger applies verbatim, and this
  -- is the answer 20260908000300 and 20260908000650 already give: recognise it
  -- in the OPEN period, carrying the true date and the period's status in the
  -- description. The PAYMENT ROW keeps p_paid_on either way -- the money really
  -- did move that day; only its recognition moves.
  --
  -- MUTATION (proves this check): change the redirect's condition to `if false`
  -- so the entry is always dated p_paid_on. Expected: open_period_for's own
  -- `This period is closed` before any assertion below is reached.
  v_date := (date_trunc('month', public.shop_local_date()::timestamp) - interval '2 months')::date + 12;
  perform public.open_period_for(v_shop_id, v_date);
  update public.accounting_periods set status = 'closed'
   where shop_id = v_shop_id and v_date between starts_on and ends_on;
  if not found then
    raise exception 'FAIL: no accounting_periods row covering % to close', v_date;
  end if;

  v_payment_id := public.record_invoice_payment(v_invoice_id, 1000, v_date, 'cash');
  select journal_entry_id into v_entry from public.invoice_payments where id = v_payment_id;
  if v_entry is null then
    raise exception 'FAIL: a payment back-dated into a closed month did not post';
  end if;

  select entry_date, description into v_date, v_text from public.journal_entries where id = v_entry;
  if v_date <> public.shop_local_date() then
    raise exception 'FAIL: a payment back-dated into a closed month posted on %, expected the current period (%)',
      v_date, public.shop_local_date();
  end if;
  -- The journal has to SAY why it is here. Without this, the only record of a
  -- January payment sitting in February lives on the source row, and the
  -- journal -- which is what an auditor reads -- shows an unexplained entry.
  if v_text not like '%that period is closed%' then
    raise exception 'FAIL: the redated payment entry does not say why it moved: %', v_text;
  end if;
  -- The payment ROW keeps the date the user chose.
  select paid_on into v_date from public.invoice_payments where id = v_payment_id;
  if v_date = public.shop_local_date() then
    raise exception 'FAIL: the redirect moved the payment row''s own paid_on, not just its recognition';
  end if;

  -- THE CONTROL, and checks 9 and this are a pair: neither is worth anything
  -- alone, because an implementation that redated EVERY payment to today would
  -- pass the half above. A month with no period row is not "closed" -- it is a
  -- month nobody has traded in, and open_period_for creates it open on demand.
  v_date := (date_trunc('month', public.shop_local_date()::timestamp) - interval '4 months')::date + 9;
  v_payment_id := public.record_invoice_payment(v_invoice_id, 700, v_date, 'cash');
  -- Kept for check 15. Its ENTRY is dated four months back in a month that is
  -- open right now -- which is exactly the state check 15 needs before it closes
  -- that month and undoes the payment.
  v_ctrl_payment := v_payment_id;
  v_ctrl_on := v_date;
  select journal_entry_id into v_entry from public.invoice_payments where id = v_payment_id;
  select entry_date into v_paid_on from public.journal_entries where id = v_entry;
  if v_paid_on <> v_date then
    raise exception 'FAIL: a payment dated into an OPEN month posted on %, expected its own date %', v_paid_on, v_date;
  end if;

  ---------------------------------------------------------------------------
  -- 10. A REVERSAL CARRIES THE SAME SOURCE AS THE ENTRY IT REVERSES.
  ---------------------------------------------------------------------------
  -- Nothing asserted this until the phase 2b final review, and the two sites
  -- that write reversals had drifted to OPPOSITE conventions: unpost_payroll_run
  -- filed its reversal as 'payroll' and said why, edit_sale filed its as
  -- 'manual' (inherited from reverse_journal_entry, whose 'manual' is correct
  -- for IT and deliberate -- see 20260904000500). The rule is now pinned:
  -- a reversal files under the SAME source as its original, so a reader
  -- filtering a source sees both halves of the pair rather than one.
  --
  -- Check 7's unpost+repost has already produced the reversal this reads.
  select string_agg(rev.reference || ' is ' || rev.source || ' but reverses an entry that is '
                    || orig.source, '; ') into v_text
    from public.journal_entries rev
    join public.journal_entries orig on orig.id = rev.reverses_entry_id
   where rev.shop_id = v_shop_id and rev.status = 'posted' and rev.source <> orig.source;
  if v_text is not null then
    raise exception 'FAIL: a reversal is filed under a different source from the entry it reverses -- %', v_text;
  end if;
  -- Not vacuous: check 7 produced exactly one, and it must be a payroll one.
  select count(*) into v_rows
    from public.journal_entries rev
    join public.journal_entries orig on orig.id = rev.reverses_entry_id
   where rev.shop_id = v_shop_id and rev.status = 'posted' and rev.source = 'payroll';
  if v_rows <> 1 then
    raise exception 'FAIL: % payroll reversals exist, expected 1 from check 7 -- check 10 is not looking at anything', v_rows;
  end if;

  ---------------------------------------------------------------------------
  -- 11. ENTERING A BILL RECOGNISES ITS COST. Dr the category / Cr 2000.
  ---------------------------------------------------------------------------
  -- THE HOLE THIS FILE HAD. Every assertion above check 11 reads 2000 on ONE
  -- entry -- the payment's own -- and asserts the amount that entry moved.
  -- Nothing read 2000 across the pair, and nothing read it against what the
  -- shop actually owes. So while `post_expense_to_ledger` skipped a bill's
  -- mirrored expenses row, this file was green with:
  --
  --   enter a 50000 rent bill  -> nothing posts at all
  --   pay it                   -> Dr 2000 50000 / Cr 1000 50000
  --   balance sheet            -> Accounts Payable MINUS 50000, and no rent
  --                               anywhere in the P&L
  --
  -- Every entry balanced, the trial balance zeroed, and every check above
  -- passed. The comment at the top of 20260908000500 asserted the cost was
  -- "recognised the moment the bill was recorded" -- and no migration on this
  -- branch posts anything when an `invoices` row is inserted. The mirror row
  -- sync_invoice_expense writes was the recognition, and it was the row being
  -- skipped.
  --
  -- 'utilities' -> 6100, which nothing else in this fixture touches, so the
  -- recognition can be read by account as well as by amount. 27700 is reached
  -- by no other figure or pair of figures here.
  select coalesce(sum(l.amount_cents), 0) into v_was_2000
    from public.journal_lines l join public.accounts a on a.id = l.account_id
    join public.journal_entries e on e.id = l.entry_id
   where e.shop_id = v_shop_id and a.code = '2000';
  select coalesce(sum(l.amount_cents), 0) into v_was_6100
    from public.journal_lines l join public.accounts a on a.id = l.account_id
    join public.journal_entries e on e.id = l.entry_id
   where e.shop_id = v_shop_id and a.code = '6100';

  insert into public.invoices (shop_id, location_id, vendor_name, invoice_number,
                               category, issued_on, due_on, amount_cents)
    values (v_shop_id, v_loc_id, 'Posting Vendor', 'BILLS-2', 'utilities',
            public.shop_local_date() - 3, public.shop_local_date() + 12, 27700)
    returning id into v_bill_two;

  select journal_entry_id into v_bill_entry from public.expenses where invoice_id = v_bill_two;
  if v_bill_entry is null then
    raise exception 'FAIL: entering a bill posted nothing -- its cost reaches no account and the payment below has no payable to settle';
  end if;

  -- THE P&L SIDE, BEFORE A SINGLE CENT HAS MOVED. This is the half that was
  -- missing outright: a bill is an unpaid EXPENSE, so the cost lands when it is
  -- incurred and the payment never touches the P&L again.
  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l join public.accounts a on a.id = l.account_id
    join public.journal_entries e on e.id = l.entry_id
   where e.shop_id = v_shop_id and a.code = '6100';
  if v_amount - v_was_6100 <> 27700 then
    raise exception 'FAIL: 6100 Utilities moved % when a 27700 utilities bill was entered, expected 27700 (0 = the bill''s cost reaches no expense account at all)',
      v_amount - v_was_6100;
  end if;

  -- ...and the liability side, which is what the payment will clear.
  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l join public.accounts a on a.id = l.account_id
    join public.journal_entries e on e.id = l.entry_id
   where e.shop_id = v_shop_id and a.code = '2000';
  if v_amount - v_was_2000 <> -27700 then
    raise exception 'FAIL: 2000 Accounts Payable moved % when an unpaid 27700 bill was entered, expected -27700', v_amount - v_was_2000;
  end if;

  ---------------------------------------------------------------------------
  -- 12. ENTER A BILL, PAY IT IN FULL, AND 2000 IS BACK AT EXACTLY ZERO.
  ---------------------------------------------------------------------------
  -- THE CHECK WHOSE ABSENCE LET THE DEFECT THROUGH. Measured across the pair --
  -- the bill's own entry and every payment entry against it -- because that is
  -- the only view in which a recognition that never happened is visible. Per
  -- entry, both halves look perfect: the payment moves 2000 by exactly what was
  -- paid, and the bill (posting nothing) has no entry to look at.
  --
  -- Paid in TWO parts, 9200 then 18500, so the part-payment path is exercised
  -- and neither figure is half of the other or of the bill.
  perform public.record_invoice_payment(v_bill_two, 9200, public.shop_local_date() - 1, 'cash');

  -- Half-way: 2000 across the pair reads what is still owed, and that figure is
  -- read from `invoices`, which record_invoice_payment maintains in a column --
  -- not re-derived from the journal lines the assertion is about.
  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l join public.accounts a on a.id = l.account_id
   where a.code = '2000'
     and (l.entry_id = v_bill_entry
          or l.entry_id in (select journal_entry_id from public.invoice_payments
                             where invoice_id = v_bill_two));
  select amount_cents - paid_cents into v_outstanding from public.invoices where id = v_bill_two;
  if v_amount <> -v_outstanding then
    raise exception 'FAIL: 2000 Accounts Payable reads % over a part-paid bill, but the bill says % is still outstanding',
      v_amount, v_outstanding;
  end if;

  perform public.record_invoice_payment(v_bill_two, 18500, public.shop_local_date(), 'cash');

  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l join public.accounts a on a.id = l.account_id
   where a.code = '2000'
     and (l.entry_id = v_bill_entry
          or l.entry_id in (select journal_entry_id from public.invoice_payments
                             where invoice_id = v_bill_two));
  if v_amount <> 0 then
    raise exception 'FAIL: a bill entered and then paid IN FULL leaves 2000 Accounts Payable at %, expected 0 (+27700 = the bill never raised the payable the payments cleared)', v_amount;
  end if;

  -- And the payments did not recognise the cost a second time. 6100 has not
  -- moved since check 11 -- the whole reason record_invoice_payment posts no
  -- 6xxx line.
  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l join public.accounts a on a.id = l.account_id
    join public.journal_entries e on e.id = l.entry_id
   where e.shop_id = v_shop_id and a.code = '6100';
  if v_amount - v_was_6100 <> 27700 then
    raise exception 'FAIL: 6100 Utilities reads % after the bill was paid, expected the 27700 the bill recognised -- paying it recognised the cost again',
      v_amount - v_was_6100;
  end if;

  ---------------------------------------------------------------------------
  -- 13. AND SHOP-WIDE, 2000 IS WHAT THE SHOP ACTUALLY OWES.
  ---------------------------------------------------------------------------
  -- The whole-shop form of check 12, and the one that cannot be satisfied by a
  -- pair that happens to cancel. Every bill in this fixture is here: BILLS-1 at
  -- 50000 with 6000 paid across checks 1 and 9, and BILLS-2 paid off. So 2000
  -- must read -44000, derived from `invoices` rather than written as a constant
  -- -- amount_cents and paid_cents are columns the RPCs maintain, and neither
  -- is read by anything that writes a journal line.
  --
  -- Nothing in this fixture receives stock, so `stock_receipts` contributes
  -- nothing to the payable and the bills are the whole of it.
  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l join public.accounts a on a.id = l.account_id
    join public.journal_entries e on e.id = l.entry_id
   where e.shop_id = v_shop_id and a.code = '2000';
  select coalesce(sum(amount_cents - paid_cents), 0) into v_outstanding
    from public.invoices where shop_id = v_shop_id;
  if v_amount <> -v_outstanding then
    raise exception 'FAIL: 2000 Accounts Payable reads % but the bills say % is outstanding -- off by %',
      v_amount, v_outstanding, v_amount + v_outstanding;
  end if;
  -- Not vacuous: a shop that owes nothing would pass the line above with both
  -- sides at zero, which is exactly the state the defect produced for a shop
  -- that paid every bill it entered.
  if v_outstanding <= 0 then
    raise exception 'FAIL: the fixture owes % -- check 13 is comparing zero against zero', v_outstanding;
  end if;

  ---------------------------------------------------------------------------
  -- 14. UNDOING A PAYMENT REVERSES ITS ENTRY, AND 2000 GOES BACK UP.
  ---------------------------------------------------------------------------
  -- delete_invoice_payment (20260804000600) is a live button on the Bills
  -- screen (invoices-tab.tsx:257). It deleted the payment row and recomputed
  -- invoices.paid_cents -- and left the Dr 2000 / Cr wallet entry standing. So
  -- the bill went back to reading unpaid while the ledger went on saying the
  -- payable had been cleared, and 2000 was UNDERSTATED by the undone amount for
  -- ever. Every entry balanced; the trial balance zeroed.
  --
  -- Check 13's identity -- shop-wide 2000 against what `invoices` says is
  -- outstanding -- is the assertion that sees it, and until this check nothing
  -- exercised the door, so check 13 was measuring a fixture where no payment had
  -- ever been undone.
  --
  -- MUTATION (proves this check): delete the `if v_entry_id is not null then`
  -- reversal block from delete_invoice_payment. Expected: FAIL: undoing a
  -- payment left its entry posted -- 2000 Accounts Payable is understated by the
  -- amount that was undone.
  select coalesce(sum(l.amount_cents), 0) into v_was_2000
    from public.journal_lines l join public.accounts a on a.id = l.account_id
    join public.journal_entries e on e.id = l.entry_id
   where e.shop_id = v_shop_id and a.code = '2000';
  select coalesce(sum(l.amount_cents), 0) into v_was_1020
    from public.journal_lines l join public.accounts a on a.id = l.account_id
    join public.journal_entries e on e.id = l.entry_id
   where e.shop_id = v_shop_id and a.code = '1020';
  select journal_entry_id into v_entry from public.invoice_payments where id = v_first_payment;
  if v_entry is null then
    raise exception 'FAIL: check 14''s payment has no entry -- it is not testing anything';
  end if;

  perform public.delete_invoice_payment(v_first_payment);

  -- The original is marked, not deleted: a book is added to, not amended.
  select status into v_status from public.journal_entries where id = v_entry;
  if v_status is null then
    raise exception 'FAIL: undoing a payment deleted its journal entry -- a posted entry is a permanent record';
  end if;
  if v_status <> 'reversed' then
    raise exception 'FAIL: undoing a payment left its entry %, expected reversed -- 2000 Accounts Payable is understated by the amount that was undone', v_status;
  end if;

  select id into v_rev from public.journal_entries
   where shop_id = v_shop_id and reverses_entry_id = v_entry and status = 'posted';
  if v_rev is null then
    raise exception 'FAIL: no reversal entry points at the undone payment''s entry';
  end if;
  -- EVERY line mirrored, not merely a balancing pair.
  select count(*) into v_rows
    from public.journal_lines o
   where o.entry_id = v_entry
     and not exists (select 1 from public.journal_lines r
                      where r.entry_id = v_rev
                        and r.account_id = o.account_id
                        and r.amount_cents = -o.amount_cents);
  if v_rows <> 0 then
    raise exception 'FAIL: % line(s) of the undone payment''s entry have no negated twin on the reversal', v_rows;
  end if;
  -- A reversal carries the SAME SOURCE as the entry it reverses -- 'payment'
  -- here, read off the original rather than written as a literal.
  select source into v_text from public.journal_entries where id = v_rev;
  if v_text <> 'payment' then
    raise exception 'FAIL: the reversal of a payment is filed under %, expected payment', v_text;
  end if;

  -- THE PAYABLE GOES BACK UP by exactly what was undone, and the wallet is put
  -- back. 4300 was paid by zaad, and 1020 is touched by nothing else here.
  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l join public.accounts a on a.id = l.account_id
    join public.journal_entries e on e.id = l.entry_id
   where e.shop_id = v_shop_id and a.code = '2000';
  if v_amount - v_was_2000 <> -4300 then
    raise exception 'FAIL: 2000 Accounts Payable moved % when a 4300 payment was undone, expected -4300 (0 = the entry was left standing and the shop''s payables read 4300 less than it owes)',
      v_amount - v_was_2000;
  end if;
  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l join public.accounts a on a.id = l.account_id
    join public.journal_entries e on e.id = l.entry_id
   where e.shop_id = v_shop_id and a.code = '1020';
  if v_amount - v_was_1020 <> 4300 then
    raise exception 'FAIL: 1020 Zaad moved % when a 4300 zaad payment was undone, expected 4300', v_amount - v_was_1020;
  end if;

  -- AND CHECK 13'S IDENTITY HOLDS AGAIN. This is the one that matters: 2000
  -- shop-wide equals what `invoices` says is outstanding, read from columns
  -- delete_invoice_payment maintains and no journal-line statement touches.
  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l join public.accounts a on a.id = l.account_id
    join public.journal_entries e on e.id = l.entry_id
   where e.shop_id = v_shop_id and a.code = '2000';
  select coalesce(sum(amount_cents - paid_cents), 0) into v_outstanding
    from public.invoices where shop_id = v_shop_id;
  if v_amount <> -v_outstanding then
    raise exception 'FAIL: after undoing a payment, 2000 reads % but the bills say % is outstanding -- off by %',
      v_amount, v_outstanding, v_amount + v_outstanding;
  end if;
  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l join public.journal_entries e on e.id = l.entry_id
   where e.shop_id = v_shop_id;
  if v_amount <> 0 then
    raise exception 'FAIL: the trial balance does not zero after a reversal, off by %', v_amount;
  end if;

  ---------------------------------------------------------------------------
  -- 15. UNDOING A PAYMENT WHOSE MONTH HAS SINCE CLOSED IS REDATED, NOT REFUSED.
  ---------------------------------------------------------------------------
  -- The mirror of check 9, one step further on. Check 9 covers a payment
  -- back-dated INTO a month that was already shut; this covers a payment that
  -- posted perfectly well at the time and is undone after its month was closed.
  -- reverse_journal_entry dates a reversal to the ORIGINAL entry's date on
  -- purpose, and open_period_for RAISES for any non-open period -- so without the
  -- redirect the Bills screen's Undo button starts failing outright the moment a
  -- shop closes a month, for a payment it recorded correctly.
  --
  -- Check 9's control payment is the fixture: 700, four months back, in a month
  -- that open_period_for created OPEN. Closing it now is what makes this
  -- different from check 14.
  --
  -- MUTATION (proves this check): change the redirect's condition in
  -- delete_invoice_payment to `if false`. Expected: ERROR: This period is
  -- closed — posting into it is refused. Re-open it first.
  update public.accounting_periods set status = 'closed'
   where shop_id = v_shop_id and v_ctrl_on between starts_on and ends_on;
  if not found then
    raise exception 'FAIL: no accounting_periods row covering % to close', v_ctrl_on;
  end if;
  select journal_entry_id into v_entry from public.invoice_payments where id = v_ctrl_payment;
  select entry_date into v_date from public.journal_entries where id = v_entry;
  if v_date <> v_ctrl_on then
    raise exception 'FAIL: check 15''s fixture entry is dated %, expected % -- it is not sitting in the month about to be closed', v_date, v_ctrl_on;
  end if;

  perform public.delete_invoice_payment(v_ctrl_payment);

  select id into v_rev from public.journal_entries
   where shop_id = v_shop_id and reverses_entry_id = v_entry and status = 'posted';
  if v_rev is null then
    raise exception 'FAIL: undoing a payment in a closed month wrote no reversal';
  end if;
  select entry_date, description into v_date, v_text from public.journal_entries where id = v_rev;
  if v_date <> public.shop_local_date() then
    raise exception 'FAIL: the reversal of a payment in a closed month is dated %, expected the current period (%)',
      v_date, public.shop_local_date();
  end if;
  -- The journal has to SAY why an old undoing is sitting in this month. Without
  -- it the journal -- which is what an auditor reads -- shows an unexplained
  -- entry. This is also the assertion that catches the NULL-description trap:
  -- `||` with a NULL operand yields NULL for the WHOLE expression, so a missing
  -- coalesce on the period status fails the undo with "A journal entry needs a
  -- description" -- an error about descriptions for a bug about dates.
  if v_text not like '%that period is closed%' then
    raise exception 'FAIL: the redated reversal does not say why it moved: %', v_text;
  end if;
  if v_text not like '%' || to_char(v_ctrl_on, 'YYYY-MM-DD') || '%' then
    raise exception 'FAIL: the redated reversal does not carry the original entry''s date: %', v_text;
  end if;
  -- And the identity still holds, with the 700 back on the bill.
  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l join public.accounts a on a.id = l.account_id
    join public.journal_entries e on e.id = l.entry_id
   where e.shop_id = v_shop_id and a.code = '2000';
  select coalesce(sum(amount_cents - paid_cents), 0) into v_outstanding
    from public.invoices where shop_id = v_shop_id;
  if v_amount <> -v_outstanding then
    raise exception 'FAIL: after a redated undo, 2000 reads % but the bills say % is outstanding -- off by %',
      v_amount, v_outstanding, v_amount + v_outstanding;
  end if;

  ---------------------------------------------------------------------------
  -- 16-18. DELETING A BILL TAKES EVERYTHING IT PUT IN THE LEDGER WITH IT.
  ---------------------------------------------------------------------------
  -- deleteInvoice (src/lib/invoices.ts:151, from invoices-tab.tsx:238) is a
  -- plain `.delete()` on `invoices`. Before a bill recognised its own cost this
  -- was a clean ledger no-op; the moment the mirrored `expenses` row started
  -- posting Dr <category> / Cr 2000 on insert, one tap on Delete began stranding
  -- that entry `posted` with no source row anywhere. A shopkeeper who enters a
  -- bill against the wrong vendor and deletes it leaves a cost on the P&L for
  -- ever, money owed to nobody on the balance sheet, `invoices` reading zero
  -- outstanding -- and no way back, because reverse_journal_entry has no caller
  -- in src/ at all. Every entry balances throughout, so nothing goes red.
  --
  -- THREE CHECKS, NOT ONE, BECAUSE THE THREE PAYMENT STATES FAIL DIFFERENTLY.
  -- The exclusion that used to sit in reverse_expense_entry was argued from the
  -- paid-in-full case (reversing the cost while the payments' Dr 2000 stood
  -- would leave Accounts Payable in debit). That argument never covered 16 --
  -- an unpaid bill has no payment entries at all -- and 18 is the case it did
  -- cover, which the payment-side trigger is what finally answers. 17 is the
  -- one where a half-fix shows: reverse the cost and not the payment, or the
  -- payment and not the cost, and check 13's identity goes red either way.
  --
  -- The identity is re-asserted after each, because it is the view all of this
  -- is visible in and it reads `invoices.amount_cents - paid_cents`, columns no
  -- journal-line statement touches.

  ---------------------------------------------------------------------------
  -- 16. AN UNPAID BILL.
  ---------------------------------------------------------------------------
  -- MUTATION (proves this check): put the tg_op = 'DELETE' link exclusion back
  -- into reverse_expense_entry(). Expected: FAIL: deleting an unpaid bill left
  -- its entry posted.
  select coalesce(sum(l.amount_cents), 0) into v_was_2000
    from public.journal_lines l join public.accounts a on a.id = l.account_id
    join public.journal_entries e on e.id = l.entry_id
   where e.shop_id = v_shop_id and a.code = '2000';

  -- 'supplies' -> 6400, which nothing else in this script touches.
  insert into public.invoices (shop_id, location_id, vendor_name, invoice_number,
                               category, issued_on, due_on, amount_cents)
    values (v_shop_id, v_loc_id, 'Delete Vendor', 'BILLS-DEL-1', 'supplies',
            public.shop_local_date(), public.shop_local_date() + 20, 12345)
    returning id into v_bill_del;
  select journal_entry_id into v_bill_del_e from public.expenses where invoice_id = v_bill_del;
  if v_bill_del_e is null then
    raise exception 'FAIL: check 16''s bill posted nothing -- it is not testing anything';
  end if;

  delete from public.invoices where id = v_bill_del;

  select status into v_status from public.journal_entries where id = v_bill_del_e;
  if v_status is null then
    raise exception 'FAIL: deleting a bill deleted its journal entry -- a posted entry is a permanent record';
  end if;
  if v_status <> 'reversed' then
    raise exception 'FAIL: deleting an unpaid bill left its entry % -- 6400 carries a cost nobody incurred and 2000 carries money owed to nobody, for ever', v_status;
  end if;
  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l join public.accounts a on a.id = l.account_id
    join public.journal_entries e on e.id = l.entry_id
   where e.shop_id = v_shop_id and a.code = '6400';
  if v_amount <> 0 then
    raise exception 'FAIL: 6400 Supplies reads % after the only bill that touched it was deleted, expected 0', v_amount;
  end if;
  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l join public.accounts a on a.id = l.account_id
    join public.journal_entries e on e.id = l.entry_id
   where e.shop_id = v_shop_id and a.code = '2000';
  if v_amount <> v_was_2000 then
    raise exception 'FAIL: 2000 Accounts Payable reads % after an unpaid bill was deleted, expected the % it read before it was ever entered',
      v_amount, v_was_2000;
  end if;
  select coalesce(sum(amount_cents - paid_cents), 0) into v_outstanding
    from public.invoices where shop_id = v_shop_id;
  if v_amount <> -v_outstanding then
    raise exception 'FAIL: after deleting an unpaid bill, 2000 reads % but the bills say % is outstanding -- off by %',
      v_amount, v_outstanding, v_amount + v_outstanding;
  end if;

  ---------------------------------------------------------------------------
  -- 17. A PART-PAID BILL -- BOTH HALVES COME OFF, OR NEITHER IS RIGHT.
  ---------------------------------------------------------------------------
  -- The case a half-fix cannot survive. `invoice_payments` cascades off the same
  -- parent as the mirrored expense row, so deleting the bill destroys both
  -- source rows; reversing one entry and not the other leaves 2000 wrong by the
  -- part that was paid AND the wallet wrong by the same amount.
  --
  -- MUTATION (proves this check): drop the invoice_payments_reverse_on_delete
  -- trigger. Expected: FAIL: after deleting a part-paid bill, 2000 reads ... but
  -- the bills say ... is outstanding.
  select coalesce(sum(l.amount_cents), 0) into v_was_2000
    from public.journal_lines l join public.accounts a on a.id = l.account_id
    join public.journal_entries e on e.id = l.entry_id
   where e.shop_id = v_shop_id and a.code = '2000';
  select coalesce(sum(l.amount_cents), 0) into v_was_1000
    from public.journal_lines l join public.accounts a on a.id = l.account_id
    join public.journal_entries e on e.id = l.entry_id
   where e.shop_id = v_shop_id and a.code = '1000';

  -- 'transport_delivery' -> 6500, untouched by anything else here.
  insert into public.invoices (shop_id, location_id, vendor_name, invoice_number,
                               category, issued_on, due_on, amount_cents)
    values (v_shop_id, v_loc_id, 'Delete Vendor', 'BILLS-DEL-2', 'transport_delivery',
            public.shop_local_date(), public.shop_local_date() + 20, 20000)
    returning id into v_bill_del;
  select journal_entry_id into v_bill_del_e from public.expenses where invoice_id = v_bill_del;
  v_pay_one := public.record_invoice_payment(v_bill_del, 7000, public.shop_local_date(), 'cash');
  select journal_entry_id into v_pay_one_e from public.invoice_payments where id = v_pay_one;
  if v_bill_del_e is null or v_pay_one_e is null then
    raise exception 'FAIL: check 17''s bill or its payment posted nothing -- it is not testing anything';
  end if;
  -- Genuinely part-paid, or this is check 18 wearing a different number.
  select amount_cents - paid_cents into v_outstanding from public.invoices where id = v_bill_del;
  if v_outstanding <> 13000 then
    raise exception 'FAIL: check 17''s bill has % outstanding, expected 13000 -- it is not part-paid', v_outstanding;
  end if;

  delete from public.invoices where id = v_bill_del;

  select status into v_status from public.journal_entries where id = v_bill_del_e;
  if v_status <> 'reversed' then
    raise exception 'FAIL: deleting a part-paid bill left its COST entry % -- the whole 20000 stays on the P&L for a bill that is gone', v_status;
  end if;
  select status into v_status from public.journal_entries where id = v_pay_one_e;
  if v_status <> 'reversed' then
    raise exception 'FAIL: deleting a part-paid bill left its PAYMENT entry % -- 2000 Accounts Payable is left in debit by 7000 and the cash is gone with no cost against it', v_status;
  end if;
  -- EVERY line of the payment's entry mirrored, not merely a balancing pair.
  select id into v_rev from public.journal_entries
   where shop_id = v_shop_id and reverses_entry_id = v_pay_one_e and status = 'posted';
  if v_rev is null then
    raise exception 'FAIL: no reversal entry points at the cascaded payment''s entry';
  end if;
  select count(*) into v_rows
    from public.journal_lines o
   where o.entry_id = v_pay_one_e
     and not exists (select 1 from public.journal_lines r
                      where r.entry_id = v_rev
                        and r.account_id = o.account_id
                        and r.amount_cents = -o.amount_cents);
  if v_rows <> 0 then
    raise exception 'FAIL: % line(s) of the cascaded payment''s entry have no negated twin on the reversal', v_rows;
  end if;
  -- The reversal carries the source of the entry it reverses, cascade or not.
  select source into v_text from public.journal_entries where id = v_rev;
  if v_text <> 'payment' then
    raise exception 'FAIL: the reversal of a cascaded payment is filed under %, expected payment', v_text;
  end if;

  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l join public.accounts a on a.id = l.account_id
    join public.journal_entries e on e.id = l.entry_id
   where e.shop_id = v_shop_id and a.code = '6500';
  if v_amount <> 0 then
    raise exception 'FAIL: 6500 Transport reads % after the only bill that touched it was deleted, expected 0', v_amount;
  end if;
  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l join public.accounts a on a.id = l.account_id
    join public.journal_entries e on e.id = l.entry_id
   where e.shop_id = v_shop_id and a.code = '1000';
  if v_amount <> v_was_1000 then
    raise exception 'FAIL: 1000 Cash reads % after a part-paid bill was deleted, expected the % it read before the payment -- the payment row is gone but the ledger still says the till paid it',
      v_amount, v_was_1000;
  end if;
  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l join public.accounts a on a.id = l.account_id
    join public.journal_entries e on e.id = l.entry_id
   where e.shop_id = v_shop_id and a.code = '2000';
  select coalesce(sum(amount_cents - paid_cents), 0) into v_outstanding
    from public.invoices where shop_id = v_shop_id;
  if v_amount <> -v_outstanding then
    raise exception 'FAIL: after deleting a part-paid bill, 2000 reads % but the bills say % is outstanding -- off by %',
      v_amount, v_outstanding, v_amount + v_outstanding;
  end if;

  ---------------------------------------------------------------------------
  -- 18. A BILL PAID IN FULL -- THE CASE THE OLD EXCLUSION WAS ARGUED FROM.
  ---------------------------------------------------------------------------
  -- Two payments, by two different wallets, so a reversal that fires once per
  -- BILL rather than once per PAYMENT is visible: 1000 and 1020 must each go
  -- back independently.
  --
  -- MUTATION (proves this check): make reverse_invoice_payment_entry() return
  -- null unconditionally. Expected: FAIL: deleting a bill paid in full left a
  -- payment entry posted.
  select coalesce(sum(l.amount_cents), 0) into v_was_2000
    from public.journal_lines l join public.accounts a on a.id = l.account_id
    join public.journal_entries e on e.id = l.entry_id
   where e.shop_id = v_shop_id and a.code = '2000';
  select coalesce(sum(l.amount_cents), 0) into v_was_1000
    from public.journal_lines l join public.accounts a on a.id = l.account_id
    join public.journal_entries e on e.id = l.entry_id
   where e.shop_id = v_shop_id and a.code = '1000';
  select coalesce(sum(l.amount_cents), 0) into v_was_1020
    from public.journal_lines l join public.accounts a on a.id = l.account_id
    join public.journal_entries e on e.id = l.entry_id
   where e.shop_id = v_shop_id and a.code = '1020';

  -- 'marketing' -> 6300, untouched by anything else here.
  insert into public.invoices (shop_id, location_id, vendor_name, invoice_number,
                               category, issued_on, due_on, amount_cents)
    values (v_shop_id, v_loc_id, 'Delete Vendor', 'BILLS-DEL-3', 'marketing',
            public.shop_local_date(), public.shop_local_date() + 20, 15000)
    returning id into v_bill_del;
  select journal_entry_id into v_bill_del_e from public.expenses where invoice_id = v_bill_del;
  v_pay_one := public.record_invoice_payment(v_bill_del, 9000, public.shop_local_date(), 'cash');
  v_pay_two := public.record_invoice_payment(v_bill_del, 6000, public.shop_local_date(), 'zaad');
  select journal_entry_id into v_pay_one_e from public.invoice_payments where id = v_pay_one;
  select journal_entry_id into v_pay_two_e from public.invoice_payments where id = v_pay_two;
  select amount_cents - paid_cents into v_outstanding from public.invoices where id = v_bill_del;
  if v_outstanding <> 0 then
    raise exception 'FAIL: check 18''s bill has % outstanding, expected 0 -- it is not paid in full', v_outstanding;
  end if;

  delete from public.invoices where id = v_bill_del;

  select status into v_status from public.journal_entries where id = v_bill_del_e;
  if v_status <> 'reversed' then
    raise exception 'FAIL: deleting a bill paid in full left its cost entry %', v_status;
  end if;
  select count(*) into v_rows from public.journal_entries
   where id in (v_pay_one_e, v_pay_two_e) and status <> 'reversed';
  if v_rows <> 0 then
    raise exception 'FAIL: deleting a bill paid in full left % of its 2 payment entries posted -- 2000 Accounts Payable is left in debit and the wallets short', v_rows;
  end if;

  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l join public.accounts a on a.id = l.account_id
    join public.journal_entries e on e.id = l.entry_id
   where e.shop_id = v_shop_id and a.code = '6300';
  if v_amount <> 0 then
    raise exception 'FAIL: 6300 Marketing reads % after the only bill that touched it was deleted, expected 0', v_amount;
  end if;
  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l join public.accounts a on a.id = l.account_id
    join public.journal_entries e on e.id = l.entry_id
   where e.shop_id = v_shop_id and a.code = '1000';
  if v_amount <> v_was_1000 then
    raise exception 'FAIL: 1000 Cash reads % after a fully paid bill was deleted, expected %', v_amount, v_was_1000;
  end if;
  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l join public.accounts a on a.id = l.account_id
    join public.journal_entries e on e.id = l.entry_id
   where e.shop_id = v_shop_id and a.code = '1020';
  if v_amount <> v_was_1020 then
    raise exception 'FAIL: 1020 Zaad reads % after a fully paid bill was deleted, expected % -- one wallet went back and the other did not, so the reversal fired once per bill rather than once per payment',
      v_amount, v_was_1020;
  end if;
  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l join public.accounts a on a.id = l.account_id
    join public.journal_entries e on e.id = l.entry_id
   where e.shop_id = v_shop_id and a.code = '2000';
  if v_amount <> v_was_2000 then
    raise exception 'FAIL: 2000 Accounts Payable reads % after a fully paid bill was deleted, expected the % it read before it was entered', v_amount, v_was_2000;
  end if;
  select coalesce(sum(amount_cents - paid_cents), 0) into v_outstanding
    from public.invoices where shop_id = v_shop_id;
  if v_amount <> -v_outstanding then
    raise exception 'FAIL: after deleting a fully paid bill, 2000 reads % but the bills say % is outstanding -- off by %',
      v_amount, v_outstanding, v_amount + v_outstanding;
  end if;
  -- Still not vacuous: BILLS-1 is still outstanding, so the identity above is
  -- comparing a real number against a real number rather than zero to zero.
  if v_outstanding <= 0 then
    raise exception 'FAIL: the fixture owes % after checks 16-18 -- the identity is comparing zero against zero', v_outstanding;
  end if;
  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l join public.journal_entries e on e.id = l.entry_id
   where e.shop_id = v_shop_id;
  if v_amount <> 0 then
    raise exception 'FAIL: the trial balance does not zero after three bills were deleted, off by %', v_amount;
  end if;

  ---------------------------------------------------------------------------
  -- 19. A BILL DELETED AFTER ITS MONTH WAS CLOSED IS REDATED, NOT REFUSED.
  ---------------------------------------------------------------------------
  -- Check 15 is this for the RPC path. This is the CASCADE path, which is a
  -- different function: reverse_invoice_payment_entry carries its own copy of
  -- the redirect, and without it the Bills screen's Delete button starts failing
  -- outright the moment a shop closes a month -- open_period_for RAISES for any
  -- non-open period, and a reversal is dated to the ORIGINAL entry's date by
  -- default. Both halves of the bill are exercised at once: the expense mirror
  -- and the payment both sit in the month that is closed underneath them.
  --
  -- THREE months back, which is the only month this fixture has not already
  -- shut: check 9 closed the two-months-back month and check 15 the
  -- four-months-back one. It has to be a month that is OPEN when the money moves
  -- and closed afterwards -- record_invoice_payment redirects a payment INTO a
  -- shut month (check 9), so the entry would never land there to begin with, and
  -- the assertion below catches exactly that if this month is ever shut too.
  -- Open when it posts, closed when it is deleted, which is the ordinary
  -- sequence, because that is what closing a month IS.
  --
  -- MUTATION (proves this check): change the redirect's condition in
  -- reverse_invoice_payment_entry() to `if false`. Expected: ERROR: This period
  -- is closed — posting into it is refused. Re-open it first.
  v_paid_on := (date_trunc('month', public.shop_local_date()::timestamp) - interval '3 months')::date + 14;
  insert into public.invoices (shop_id, location_id, vendor_name, invoice_number,
                               category, issued_on, due_on, amount_cents)
    values (v_shop_id, v_loc_id, 'Delete Vendor', 'BILLS-DEL-4', 'fees_charges',
            v_paid_on, v_paid_on + 20, 8800)
    returning id into v_bill_del;
  select journal_entry_id into v_bill_del_e from public.expenses where invoice_id = v_bill_del;
  v_pay_one := public.record_invoice_payment(v_bill_del, 8800, v_paid_on, 'cash');
  select journal_entry_id into v_pay_one_e from public.invoice_payments where id = v_pay_one;
  select entry_date into v_date from public.journal_entries where id = v_pay_one_e;
  if v_date <> v_paid_on then
    raise exception 'FAIL: check 19''s payment entry is dated %, expected % -- its month was not open when it posted', v_date, v_paid_on;
  end if;

  update public.accounting_periods set status = 'closed'
   where shop_id = v_shop_id and v_paid_on between starts_on and ends_on;
  if not found then
    raise exception 'FAIL: no accounting_periods row covering % to close', v_paid_on;
  end if;

  delete from public.invoices where id = v_bill_del;

  select id into v_rev from public.journal_entries
   where shop_id = v_shop_id and reverses_entry_id = v_pay_one_e and status = 'posted';
  if v_rev is null then
    raise exception 'FAIL: deleting a bill whose payment sits in a closed month wrote no payment reversal';
  end if;
  select entry_date, description into v_date, v_text from public.journal_entries where id = v_rev;
  if v_date <> public.shop_local_date() then
    raise exception 'FAIL: the cascaded payment reversal is dated %, expected the current period (%)', v_date, public.shop_local_date();
  end if;
  -- The journal has to SAY why an old undoing is sitting in this month -- and
  -- this is also the assertion that catches the NULL-description trap: `||` with
  -- a NULL operand yields NULL for the WHOLE expression, so a missing coalesce
  -- on the period status fails the delete with "A journal entry needs a
  -- description", an error about descriptions for a bug about dates.
  if v_text not like '%that period is closed%' then
    raise exception 'FAIL: the redated payment reversal does not say why it moved: %', v_text;
  end if;
  if v_text not like '%' || to_char(v_paid_on, 'YYYY-MM-DD') || '%' then
    raise exception 'FAIL: the redated payment reversal does not carry the original entry''s date: %', v_text;
  end if;
  -- And the expense half made the same journey.
  select status into v_status from public.journal_entries where id = v_bill_del_e;
  if v_status <> 'reversed' then
    raise exception 'FAIL: deleting a bill in a closed month left its cost entry %', v_status;
  end if;
  select coalesce(sum(amount_cents - paid_cents), 0) into v_outstanding
    from public.invoices where shop_id = v_shop_id;
  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l join public.accounts a on a.id = l.account_id
    join public.journal_entries e on e.id = l.entry_id
   where e.shop_id = v_shop_id and a.code = '2000';
  if v_amount <> -v_outstanding then
    raise exception 'FAIL: after a redated bill deletion, 2000 reads % but the bills say % is outstanding -- off by %',
      v_amount, v_outstanding, v_amount + v_outstanding;
  end if;

  ---------------------------------------------------------------------------
  -- 20. DELETING A PAYMENT THAT POSTED NOTHING IS A CLEAN NO-OP.
  ---------------------------------------------------------------------------
  -- The mirror of expenses check 16b, and it exists for the same reason: every
  -- invoice_payments row in every existing shop carries a NULL journal_entry_id
  -- until 20260908000500 shipped and the backfill reached it, and
  -- reverse_invoice_payment_entry must treat that as nothing to do rather than
  -- as a missing entry. Without this, a shop tidying up its bills meets a ledger
  -- error on a payment the ledger never heard of -- and the backfill can never
  -- repair it either, because the source row is gone.
  --
  -- The row is inserted DIRECTLY rather than through record_invoice_payment,
  -- which is the only honest way to reproduce a pre-posting payment. It is
  -- deleted again immediately and never touches paid_cents, so check 13's
  -- identity is not disturbed -- which is why this sits last.
  --
  -- MUTATION (proves this check): remove the `old.journal_entry_id is null` arm
  -- from reverse_invoice_payment_entry(). Expected: ERROR: the journal entry for
  -- this payment is missing, so it cannot be reversed.
  insert into public.invoice_payments (invoice_id, amount_cents, paid_on, method, created_by)
    values (v_invoice_id, 250, public.shop_local_date(), 'cash', v_user_id)
    returning id into v_payment_id;
  if (select journal_entry_id from public.invoice_payments where id = v_payment_id) is not null then
    raise exception 'FAIL: check 20''s fixture payment posted -- it is not testing the no-op path';
  end if;
  select count(*) into v_rows from public.journal_entries where shop_id = v_shop_id;
  delete from public.invoice_payments where id = v_payment_id;
  select count(*) into v_amount from public.journal_entries where shop_id = v_shop_id;
  if v_amount <> v_rows then
    raise exception 'FAIL: deleting a payment that never posted wrote % journal entries', v_amount - v_rows;
  end if;
  if exists (select 1 from public.invoice_payments where id = v_payment_id) then
    raise exception 'FAIL: the never-posted payment row survived its own delete';
  end if;

  ---------------------------------------------------------------------------
  -- 21. THE FIGURE THE BILLS SCREEN ACCUSES A SHOP WITH.
  ---------------------------------------------------------------------------
  -- accounts_payable_debit() (20260908001700) is what the Bills tab reads to
  -- decide whether to show its `wrong`-toned caveat -- "your books say suppliers
  -- owe YOU 412.50". It replaced a client-side sum over listPostedLines(), which
  -- fetched EVERY journal line the shop had ever posted and which PostgREST
  -- truncates at max-rows (1000) with no error: past that the accusation was
  -- computed over an arbitrary prefix of the journal.
  --
  -- Four things have to hold, and each is a different way of being confidently
  -- wrong.
  --
  --   a) it agrees with the ledger, clamped. A liability sitting in credit is
  --      not a defect and must read 0, not a negative number the screen would
  --      have to know to ignore.
  --   b) a DRAFT does not count. The trial balance beside it takes posted and
  --      reversed only, and a draft Dr 2000 that moved this figure would put a
  --      `wrong` on a screen while the trial balance said everything was fine.
  --   c) when the account really is in debit it reports the AMOUNT. "Something
  --      is wrong" is not actionable; a number is.
  --   d) it says whether the shop still has history waiting -- because the
  --      amount alone cannot tell a missing DELIVERY (fix: record it) from a
  --      bill entered before posting shipped (fix: Post History), and the first
  --      remedy applied to the second case invents stock that never arrived.
  --
  -- MUTATIONS: drop the `greatest(..., 0)` -> (a) fails, reporting the credit
  -- balance. Drop `e.status in ('posted','reversed')` -> (b) fails. Replace the
  -- `exists` with `false` -> (d) fails.
  declare
    v_ap_debit  bigint;
    v_ap_unpost boolean;
    v_ap_net    bigint;
    v_draft_e   uuid;
    v_ghost_pay uuid;
  begin
    -- (a) Against the ledger's own arithmetic rather than against a constant,
    -- so the twenty checks above cannot drift out from under this one.
    select coalesce(sum(l.amount_cents), 0) into v_ap_net
      from public.journal_lines l
      join public.journal_entries e on e.id = l.entry_id
      join public.accounts a on a.id = l.account_id
     where e.shop_id = v_shop_id and a.code = '2000'
       and e.status in ('posted', 'reversed')
       and e.entry_date <= public.shop_local_date();
    select debit_cents, has_unposted into v_ap_debit, v_ap_unpost
      from public.accounts_payable_debit(v_shop_id);
    if v_ap_debit <> greatest(v_ap_net, 0) then
      raise exception 'FAIL: accounts_payable_debit says % where 2000 nets to % (clamped: %)',
        v_ap_debit, v_ap_net, greatest(v_ap_net, 0);
    end if;

    -- (b) A draft big enough to be unmistakable, left in place: the figure must
    -- not move by a cent.
    insert into public.journal_entries
        (shop_id, period_id, entry_date, reference, description, source, status, created_by)
      values (v_shop_id, public.open_period_for(v_shop_id, public.shop_local_date()),
              public.shop_local_date(), 'AP-DRAFT-1', 'A draft nobody has posted', 'manual', 'draft', v_user_id)
      returning id into v_draft_e;
    insert into public.journal_lines (entry_id, account_id, amount_cents)
      select v_draft_e, a.id, 500000 from public.accounts a
       where a.shop_id = v_shop_id and a.code = '2000';
    insert into public.journal_lines (entry_id, account_id, amount_cents)
      select v_draft_e, a.id, -500000 from public.accounts a
       where a.shop_id = v_shop_id and a.code = '1000';
    select debit_cents into v_ap_debit from public.accounts_payable_debit(v_shop_id);
    if v_ap_debit <> greatest(v_ap_net, 0) then
      raise exception 'FAIL: a DRAFT Dr 2000 moved the payable to % -- the trial balance beside this screen does not count drafts', v_ap_debit;
    end if;

    -- (c) Now genuinely in debit, by an amount no other figure in this file
    -- shares. Posted as a manual entry rather than by paying a bill, because
    -- what is under test is the reading, not the route.
    perform public.post_journal_entry(v_shop_id, public.shop_local_date(),
      'Payable driven the wrong way round',
      jsonb_build_array(
        jsonb_build_object('code', '2000', 'amount_cents', 41250 - v_ap_net),
        jsonb_build_object('code', '1000', 'amount_cents', v_ap_net - 41250)),
      null);
    select debit_cents into v_ap_debit from public.accounts_payable_debit(v_shop_id);
    if v_ap_debit <> 41250 then
      raise exception 'FAIL: 2000 is 41250 into debit and the screen would say %', v_ap_debit;
    end if;

    -- (d) Nothing waiting, then something, then nothing again. The something is
    -- a payment row with a null pointer, which is exactly the shape every
    -- pre-posting shop is full of -- check 20 above is where it comes from.
    if v_ap_unpost then
      raise exception 'FAIL: the fixture shop has unposted rows before check 21 puts one there, so this check cannot tell the flag from a constant';
    end if;
    insert into public.invoice_payments (invoice_id, amount_cents, paid_on, method, created_by)
      values (v_invoice_id, 250, public.shop_local_date(), 'cash', v_user_id)
      returning id into v_ghost_pay;
    update public.invoice_payments set journal_entry_id = null where id = v_ghost_pay;
    select has_unposted into v_ap_unpost from public.accounts_payable_debit(v_shop_id);
    if not v_ap_unpost then
      raise exception 'FAIL: a payment that never reached the ledger is not reported as unposted -- the Bills screen would offer the destructive remedy';
    end if;
    delete from public.invoice_payments where id = v_ghost_pay;
    select has_unposted into v_ap_unpost from public.accounts_payable_debit(v_shop_id);
    if v_ap_unpost then
      raise exception 'FAIL: the flag stayed true after the only unposted row was removed';
    end if;

    -- And the gate. `ledger.view`, which is exactly what RLS on journal_lines
    -- enforced before the sum moved into a SECURITY DEFINER function -- so a
    -- reader who could not see this figure yesterday still cannot. NO ROWS, not
    -- a zero: zero is a real answer here and it means "your payable is fine".
    perform set_config('request.jwt.claims', json_build_object('sub', v_user_two)::text, true);
    select count(*) into v_rows from public.accounts_payable_debit(v_shop_id);
    if v_rows <> 0 then
      raise exception 'FAIL: a member holding only expenses.manage was given the shop''s payable balance';
    end if;
    perform set_config('request.jwt.claims', json_build_object('sub', v_user_id)::text, true);
  end;

  ---------------------------------------------------------------------------
  -- 22. A BILL THAT NAMES ITS DELIVERY POSTS NOTHING -- WHATEVER ITS CATEGORY.
  ---------------------------------------------------------------------------
  -- The whole of 20260908001900 in one check, and the direction 20260908000800
  -- could not close.
  --
  -- The bill below is categorised 'supplies', which the map sends to 6400 -- an
  -- EXPENSE account -- and it is for goods that arrived through Restock. That is
  -- one wrong tap on the category picker, and it is the tap a shopkeeper makes
  -- when `inventory_purchase` does not sound like what the paper in their hand
  -- says. Under the category-keyed branch it posted Dr 6400 / Cr 2000 ON TOP OF
  -- the delivery's own Dr 1200 / Cr 2000: the payable DOUBLED, the cost on the
  -- P&L while the goods were also on the balance sheet, and paying the bill once
  -- clearing half of what the books thought was owed. Every entry balanced and
  -- the trial balance zeroed throughout, which is why nothing caught it.
  --
  -- Asserted on 6400 as well as on 2000, and 6400 is the sharper of the two: a
  -- branch that posted the bill would move BOTH, and a check that only watched
  -- 2000 could not tell "the payable doubled" from "the payment did not land".
  --
  -- MUTATION (proves this check): delete the line
  --   if v_bill_receipt is not null then return null; end if;
  -- from post_expense_to_ledger. Run, and it reddens on the FIRST of the three
  -- assertions below: FAIL: a bill that names its delivery posted an entry of
  -- its own -- the goods would be recognised twice. (The 6400 assertion is the
  -- one that says WHICH account the double landed in, and it is kept for that:
  -- the entry could exist and be harmless, and 6400 is where it is not.)
  select coalesce(sum(l.amount_cents), 0) into v_2000_was
    from public.journal_lines l
    join public.accounts a on a.id = l.account_id
    join public.journal_entries e on e.id = l.entry_id
   where e.shop_id = v_shop_id and a.code = '2000' and e.status in ('posted', 'reversed');
  select coalesce(sum(l.amount_cents), 0) into v_6400_was
    from public.journal_lines l
    join public.accounts a on a.id = l.account_id
    join public.journal_entries e on e.id = l.entry_id
   where e.shop_id = v_shop_id and a.code = '6400' and e.status in ('posted', 'reversed');

  -- stock 0 and cost null, so receive_stock costs the product for the first time
  -- with nothing already on the shelf -- 20260908001800's revaluation entry
  -- needs a prior quantity and must not fire here, or this check would be
  -- measuring two entries and calling them one.
  insert into public.products (shop_id, name, price_cents, cost_cents, stock)
    values (v_shop_id, 'Sack of sugar', 9000, null, 0) returning id into v_prod;

  -- 7 at 5900 = 41300. No other figure in this file shares it, and it is not a
  -- round number two wrong answers could both land on.
  v_delivery := public.receive_stock(
    v_shop_id, v_loc_id,
    jsonb_build_array(jsonb_build_object('product_id', v_prod, 'quantity', 7, 'unit_cost_cents', 5900)),
    'Berbera Wholesale', 'BW-7788', null);

  select coalesce(sum(l.amount_cents), 0) into v_2000_now
    from public.journal_lines l
    join public.accounts a on a.id = l.account_id
    join public.journal_entries e on e.id = l.entry_id
   where e.shop_id = v_shop_id and a.code = '2000' and e.status in ('posted', 'reversed');
  if v_2000_now - v_2000_was <> -41300 then
    raise exception 'FAIL: the delivery moved 2000 by % , expected -41300 -- receive_stock raises the payable and check 22 rests on it',
      v_2000_now - v_2000_was;
  end if;

  insert into public.invoices (shop_id, location_id, vendor_name, invoice_number,
                               category, issued_on, due_on, amount_cents, stock_receipt_id)
    values (v_shop_id, v_loc_id, 'Berbera Wholesale', 'BW-7788', 'supplies',
            public.shop_local_date(), public.shop_local_date() + 14, 41300, v_delivery)
    returning id into v_bill_linked;

  if (select journal_entry_id from public.expenses where invoice_id = v_bill_linked) is not null then
    raise exception 'FAIL: a bill that names its delivery posted an entry of its own -- the goods would be recognised twice';
  end if;
  select coalesce(sum(l.amount_cents), 0) into v_2000_now
    from public.journal_lines l
    join public.accounts a on a.id = l.account_id
    join public.journal_entries e on e.id = l.entry_id
   where e.shop_id = v_shop_id and a.code = '6400' and e.status in ('posted', 'reversed');
  if v_2000_now <> v_6400_was then
    raise exception 'FAIL: a bill that names its delivery posted % to 6400 Supplies -- the delivery already recognised those goods',
      v_2000_now - v_6400_was;
  end if;

  -- ...AND PAYING IT PUTS 2000 BACK WHERE IT STARTED. This is the sentence the
  -- whole residue was about: the delivery raised the payable, the payment clears
  -- it, and the two net to nothing because they are about the same goods.
  perform public.record_invoice_payment(v_bill_linked, 41300, public.shop_local_date(), 'cash');
  select coalesce(sum(l.amount_cents), 0) into v_2000_now
    from public.journal_lines l
    join public.accounts a on a.id = l.account_id
    join public.journal_entries e on e.id = l.entry_id
   where e.shop_id = v_shop_id and a.code = '2000' and e.status in ('posted', 'reversed');
  if v_2000_now <> v_2000_was then
    raise exception 'FAIL: delivery then bill then payment left 2000 at % , expected % -- the two halves did not net out',
      v_2000_now, v_2000_was;
  end if;

  ---------------------------------------------------------------------------
  -- 23. THE ADMITTED GAP, ASSERTED AS A GAP.
  ---------------------------------------------------------------------------
  -- A goods bill with no delivery behind it posts nothing, and paying it drives
  -- 2000 into DEBIT by exactly its amount. That is wrong, it is what the Bills
  -- screen's `wrong`-toned Caveat exists to say, and it is asserted here rather
  -- than papered over -- because the alternative branch (post Dr 1200 / Cr 2000
  -- for an unlinked goods bill) is worse in both of its cases. It doubles a
  -- delivery that WAS recorded, or invents stock for one that was not, and in
  -- the second case it also shrinks opening_inventory_gap by the phantom, for
  -- ever. See 20260908001900's header.
  --
  -- The row is written with the door disabled: guard_invoice_delivery_link
  -- refuses to create one now, and this is the shape every shop's history holds.
  --
  -- MUTATION (proves this check): delete the line
  --   if new.category = 'inventory_purchase' then return null; end if;
  -- from post_expense_to_ledger's invoice arm, so the bill posts Dr 1200 /
  -- Cr 2000 instead. Expected, and observed: FAIL: a goods bill with no delivery
  -- behind it posted an entry -- there is no honest one to post. It is the FIRST
  -- assertion that reddens rather than the 2000 one, and that is worth knowing:
  -- the bill's Cr 2000 would cancel the payment's Dr exactly, so a check that
  -- only watched the payable would see nothing wrong at all while 1200 quietly
  -- carried 26400 of stock that is not on any shelf.
  alter table public.invoices disable trigger invoices_guard_delivery_link;
  insert into public.invoices (shop_id, location_id, vendor_name, invoice_number,
                               category, issued_on, due_on, amount_cents)
    values (v_shop_id, v_loc_id, 'Ghost Wholesale', 'BW-9001', 'inventory_purchase',
            public.shop_local_date(), public.shop_local_date() + 14, 26400)
    returning id into v_bill_hist;
  alter table public.invoices enable trigger invoices_guard_delivery_link;

  if (select journal_entry_id from public.expenses where invoice_id = v_bill_hist) is not null then
    raise exception 'FAIL: a goods bill with no delivery behind it posted an entry -- there is no honest one to post';
  end if;

  select coalesce(sum(l.amount_cents), 0) into v_2000_was
    from public.journal_lines l
    join public.accounts a on a.id = l.account_id
    join public.journal_entries e on e.id = l.entry_id
   where e.shop_id = v_shop_id and a.code = '2000' and e.status in ('posted', 'reversed');
  perform public.record_invoice_payment(v_bill_hist, 26400, public.shop_local_date(), 'cash');
  select coalesce(sum(l.amount_cents), 0) into v_2000_now
    from public.journal_lines l
    join public.accounts a on a.id = l.account_id
    join public.journal_entries e on e.id = l.entry_id
   where e.shop_id = v_shop_id and a.code = '2000' and e.status in ('posted', 'reversed');
  if v_2000_now - v_2000_was <> 26400 then
    raise exception 'FAIL: paying a bill nothing ever credited moved 2000 by % , expected +26400 -- this gap is admitted, not hidden',
      v_2000_now - v_2000_was;
  end if;

  -- And the screen would say so. accounts_payable_debit is what the Bills tab
  -- reads; it must carry this shop's whole debit position, not miss the part
  -- this check just created.
  select debit_cents into v_ap_now from public.accounts_payable_debit(v_shop_id);
  if v_ap_now <> greatest(v_2000_now, 0) then
    raise exception 'FAIL: the Bills screen would report % where 2000 nets to % -- the caveat and the ledger must not disagree',
      v_ap_now, v_2000_now;
  end if;

  ---------------------------------------------------------------------------
  -- 24. THE DOOR. FOUR REFUSALS, EACH ITS OWN FAILURE IF IT GOES.
  ---------------------------------------------------------------------------
  -- (a) A goods bill must name a delivery.
  --     MUTATION: delete the raise in guard_invoice_delivery_link's null arm.
  --     Expected: FAIL: a goods bill with no delivery was accepted.
  v_raised := false;
  begin
    insert into public.invoices (shop_id, location_id, vendor_name, invoice_number,
                                 category, issued_on, due_on, amount_cents)
      values (v_shop_id, v_loc_id, 'Ghost Wholesale', 'BW-9002', 'inventory_purchase',
              public.shop_local_date(), public.shop_local_date() + 14, 31700);
  exception when others then
    if sqlerrm not like 'A stock purchase has to say which delivery%' then raise; end if;
    v_raised := true;
  end;
  if not v_raised then
    raise exception 'FAIL: a goods bill with no delivery was accepted -- the gap check 23 admits is still creatable';
  end if;

  -- (b) An UNCOSTED delivery cannot be named. It never reached the books, so
  --     nothing was ever recorded as owed for it and linking would recreate the
  --     defect through the new column instead of the old category.
  --     MUTATION: delete the `if v_value_cents = 0` raise. Expected: FAIL: a
  --     bill was linked to a delivery that never reached the books.
  v_dry_delivery := public.receive_stock(
    v_shop_id, v_loc_id,
    jsonb_build_array(jsonb_build_object('product_id', v_prod, 'quantity', 3, 'unit_cost_cents', null)),
    'Berbera Wholesale', 'BW-7799', null);
  if (select journal_entry_id from public.stock_receipts where id = v_dry_delivery) is not null then
    raise exception 'FAIL: check 24b''s delivery posted an entry, so it is not testing the uncosted path';
  end if;
  v_raised := false;
  begin
    insert into public.invoices (shop_id, location_id, vendor_name, invoice_number,
                                 category, issued_on, due_on, amount_cents, stock_receipt_id)
      values (v_shop_id, v_loc_id, 'Berbera Wholesale', 'BW-9003', 'inventory_purchase',
              public.shop_local_date(), public.shop_local_date() + 14, 12800, v_dry_delivery);
  exception when others then
    if sqlerrm not like 'That delivery was received without any costs%' then raise; end if;
    v_raised := true;
  end;
  if not v_raised then
    raise exception 'FAIL: a bill was linked to a delivery that never reached the books -- paying it would drive 2000 into debit again';
  end if;

  -- (c) THE LINK IS FINAL. If it could move, the live entry would have been
  --     written under one answer while the replay read another -- for the same
  --     row. That is the one property this whole phase is built on, and it is
  --     not enforceable any other way: the reverse-and-re-post triggers on
  --     `expenses` fire on a fixed column list and nothing on `expenses` moves
  --     when the INVOICE's link does, so the posting could not follow.
  --     MUTATION: drop trigger invoices_delivery_link_is_final. Expected: FAIL:
  --     a bill's delivery link was changed after it was entered.
  v_raised := false;
  begin
    update public.invoices set stock_receipt_id = null where id = v_bill_linked;
  exception when others then
    if sqlerrm not like 'Which delivery a bill pays for is fixed%' then raise; end if;
    v_raised := true;
  end;
  if not v_raised then
    raise exception 'FAIL: a bill''s delivery link was changed after it was entered -- the live entry and the replay now disagree about that row';
  end if;

  -- ...and an ordinary edit still works. A guard that refused every update would
  -- pass (c) and make the bill uneditable, which is a worse bug than the one it
  -- closes and is invisible to a check that only tries the forbidden thing.
  update public.invoices set due_on = public.shop_local_date() + 30 where id = v_bill_linked;

  -- (d) ONE BILL PER DELIVERY. Two bills naming the same delivery each post
  --     nothing while each of their payments debits 2000, so the payable goes
  --     negative by a whole delivery's value -- this residue reached through the
  --     column that closes it.
  --     MUTATION: drop index invoices_stock_receipt_id_key. Expected: FAIL: two
  --     bills were allowed to name the same delivery.
  v_raised := false;
  begin
    insert into public.invoices (shop_id, location_id, vendor_name, invoice_number,
                                 category, issued_on, due_on, amount_cents, stock_receipt_id)
      values (v_shop_id, v_loc_id, 'Berbera Wholesale', 'BW-9004', 'inventory_purchase',
              public.shop_local_date(), public.shop_local_date() + 14, 41300, v_delivery);
  exception when unique_violation then v_raised := true;
  end;
  if not v_raised then
    raise exception 'FAIL: two bills were allowed to name the same delivery -- paying both would credit 2000 once and debit it twice';
  end if;

  perform set_config('request.jwt.claims', null, true);
  raise notice 'ALL CHECKS PASSED';
  raise exception 'rollback fixture';
exception
  when others then
    perform set_config('request.jwt.claims', null, true);
    if sqlerrm = 'rollback fixture' then
      return;
    end if;
    raise;
end $$;
