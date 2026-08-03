-- End-to-end verification of the accounting write paths against a real
-- database. Everything runs inside one DO block whose EXCEPTION clause rolls
-- the whole lot back, so it leaves no rows behind.
--
-- Covers the paths that unit tests can't reach: database triggers, RLS
-- policies, and the security-definer RPCs.

\set ON_ERROR_STOP on

do $$
declare
  v_user_id uuid := gen_random_uuid();
  v_shop_id uuid;
  v_vendor_id uuid;
  v_invoice_id uuid;
  v_expense_id uuid;
  v_run_id uuid;
  v_member_id uuid;
  v_role_id uuid;
  v_bill_id uuid;
  v_count integer;
  v_amount integer;
  v_date date;
  v_status text;
  v_note text;
  v_raised boolean;
begin
  -- A user and shop to act as. auth.uid() reads request.jwt.claims->>'sub',
  -- so setting that GUC is what makes has_shop_permission() behave as it
  -- would for a signed-in owner.
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
    values (v_user_id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            'verify-' || v_user_id || '@example.test', '', now(), now(), now());

  insert into public.shops (owner_id, name) values (v_user_id, 'Verify Shop') returning id into v_shop_id;

  perform set_config('request.jwt.claims', json_build_object('sub', v_user_id)::text, true);
  perform set_config('role', 'authenticated', true);

  raise notice '--- shop owner implicitly holds every permission (0024) ---';
  if not public.has_shop_permission(v_shop_id, 'invoices.manage') then
    raise exception 'FAIL: owner lacks invoices.manage';
  end if;

  ------------------------------------------------------------------
  raise notice '=== 1. Recording a bill posts a linked expense ===';
  ------------------------------------------------------------------
  insert into public.vendors (shop_id, name) values (v_shop_id, 'Verify Vendor') returning id into v_vendor_id;

  insert into public.invoices (shop_id, vendor_id, vendor_name, invoice_number, category, issued_on, due_on, amount_cents)
    values (v_shop_id, v_vendor_id, 'Verify Vendor', 'VERIFY-1', 'rent', '2026-08-01', '2026-08-20', 40000)
    returning id into v_invoice_id;

  select count(*), max(amount_cents), max(occurred_on) into v_count, v_amount, v_date
    from public.expenses where invoice_id = v_invoice_id;
  if v_count <> 1 then raise exception 'FAIL: expected 1 expense from the bill, got %', v_count; end if;
  if v_amount <> 40000 then raise exception 'FAIL: expense amount % <> bill amount 40000', v_amount; end if;
  -- Dated the issue date, not today: a bill dated last month is last month's
  -- cost however late it is entered.
  if v_date <> date '2026-08-01' then raise exception 'FAIL: expense dated %, expected the issue date', v_date; end if;
  raise notice 'OK: bill posted one expense of % dated %', v_amount, v_date;

  ------------------------------------------------------------------
  raise notice '=== 2. Editing the bill keeps its expense in step ===';
  ------------------------------------------------------------------
  update public.invoices set amount_cents = 45000, issued_on = '2026-08-02' where id = v_invoice_id;
  select amount_cents, occurred_on into v_amount, v_date from public.expenses where invoice_id = v_invoice_id;
  if v_amount <> 45000 or v_date <> date '2026-08-02' then
    raise exception 'FAIL: expense did not follow the bill (got %, %)', v_amount, v_date;
  end if;
  raise notice 'OK: expense followed the edit';

  ------------------------------------------------------------------
  raise notice '=== 3. A bill-generated expense is read-only ===';
  ------------------------------------------------------------------
  -- RLS only applies to non-superusers, so drop privileges for this check.
  set local role authenticated;
  v_raised := false;
  begin
    update public.expenses set amount_cents = 1 where invoice_id = v_invoice_id;
    get diagnostics v_count = row_count;
    if v_count > 0 then raise exception 'FAIL: RLS allowed editing a bill-generated expense'; end if;
    v_raised := true;  -- zero rows updated is the policy working
  exception when insufficient_privilege then
    v_raised := true;
  end;
  if not v_raised then raise exception 'FAIL: bill-generated expense was editable'; end if;

  v_raised := false;
  begin
    delete from public.expenses where invoice_id = v_invoice_id;
    get diagnostics v_count = row_count;
    if v_count > 0 then raise exception 'FAIL: RLS allowed deleting a bill-generated expense'; end if;
    v_raised := true;
  exception when insufficient_privilege then
    v_raised := true;
  end;
  if not v_raised then raise exception 'FAIL: bill-generated expense was deletable'; end if;

  -- Control: without this, a policy that blocked *every* expense edit would
  -- pass the two checks above and look correct. Prove it discriminates on
  -- invoice_id by editing a hand-entered row as the same role.
  declare v_manual_id uuid;
  begin
    insert into public.expenses (shop_id, occurred_on, amount_cents, category)
      values (v_shop_id, '2026-08-03', 1500, 'supplies') returning id into v_manual_id;
    update public.expenses set amount_cents = 1600 where id = v_manual_id;
    get diagnostics v_count = row_count;
    if v_count <> 1 then
      raise exception 'FAIL: the policy blocks ordinary expenses too — the read-only guard proves nothing';
    end if;
  end;
  reset role;
  raise notice 'OK: generated expense refused edit+delete, while a hand-entered one stayed editable';

  ------------------------------------------------------------------
  raise notice '=== 4. Paying a bill settles it without touching the P&L ===';
  ------------------------------------------------------------------
  select amount_cents into v_amount from public.expenses where invoice_id = v_invoice_id;
  perform public.record_invoice_payment(v_invoice_id, 20000, '2026-08-10', 'cash', null);

  select paid_cents into v_count from public.invoices where id = v_invoice_id;
  if v_count <> 20000 then raise exception 'FAIL: paid_cents = %, expected 20000', v_count; end if;

  -- The crucial one: the cost was recognised when the bill was raised, so
  -- paying it must not move the expense again.
  select amount_cents into v_count from public.expenses where invoice_id = v_invoice_id;
  if v_count <> v_amount then
    raise exception 'FAIL: paying the bill changed the expense (% -> %) — double counting', v_amount, v_count;
  end if;
  raise notice 'OK: balance moved to 20000, expense unchanged at %', v_amount;

  raise notice '--- overpaying is rejected ---';
  v_raised := false;
  begin
    perform public.record_invoice_payment(v_invoice_id, 999999, '2026-08-11', 'cash', null);
  exception when others then
    v_raised := true;
  end;
  if not v_raised then raise exception 'FAIL: an overpayment was accepted'; end if;
  raise notice 'OK: overpayment rejected';

  ------------------------------------------------------------------
  raise notice '=== 5. Payroll: post, guard, unpost ===';
  ------------------------------------------------------------------
  insert into public.roles (shop_id, name, permissions) values (v_shop_id, 'Verify Role', array['expenses.manage'])
    returning id into v_role_id;
  insert into public.shop_members (shop_id, user_id, role_id, active, full_name, pay_type, pay_rate_cents)
    values (v_shop_id, v_user_id, v_role_id, true, 'Verify Staff', 'hourly', 500)
    returning id into v_member_id;

  insert into public.payroll_runs (shop_id, period_start, period_end)
    values (v_shop_id, '2026-08-01', '2026-08-07') returning id into v_run_id;
  insert into public.payroll_run_lines (payroll_run_id, shop_member_id, member_name, pay_type, pay_rate_cents, hours_worked, amount_cents)
    values (v_run_id, v_member_id, 'Verify Staff', 'hourly', 500, 12, 6000);

  perform public.post_payroll_run(v_run_id);

  select status, total_cents into v_status, v_count from public.payroll_runs where id = v_run_id;
  if v_status <> 'posted' then raise exception 'FAIL: run status %, expected posted', v_status; end if;
  if v_count <> 6000 then raise exception 'FAIL: run total %, expected 6000', v_count; end if;

  select count(*), max(amount_cents), max(occurred_on), max(category) into v_count, v_amount, v_date, v_note
    from public.expenses where payroll_run_id = v_run_id;
  if v_count <> 1 then raise exception 'FAIL: expected 1 payroll expense, got %', v_count; end if;
  if v_amount <> 6000 then raise exception 'FAIL: payroll expense %, expected 6000', v_amount; end if;
  if v_note <> 'salaries_wages' then raise exception 'FAIL: payroll expense category %', v_note; end if;
  -- Dated period_end so an August run posted in September lands in August.
  if v_date <> date '2026-08-07' then raise exception 'FAIL: payroll expense dated %, expected period end', v_date; end if;
  raise notice 'OK: posted one % expense of % dated %', v_note, v_amount, v_date;

  raise notice '--- posting twice is rejected ---';
  v_raised := false;
  begin
    perform public.post_payroll_run(v_run_id);
  exception when others then
    v_raised := true;
  end;
  if not v_raised then raise exception 'FAIL: the same run posted twice'; end if;
  raise notice 'OK: double post rejected';

  raise notice '--- an overlapping period is rejected ---';
  declare v_overlap_id uuid;
  begin
    insert into public.payroll_runs (shop_id, period_start, period_end)
      values (v_shop_id, '2026-08-05', '2026-08-12') returning id into v_overlap_id;
    insert into public.payroll_run_lines (payroll_run_id, shop_member_id, member_name, amount_cents)
      values (v_overlap_id, v_member_id, 'Verify Staff', 1000);
    v_raised := false;
    begin
      perform public.post_payroll_run(v_overlap_id);
    exception when others then
      v_raised := true;
    end;
    if not v_raised then raise exception 'FAIL: an overlapping period was posted — wages could be paid twice'; end if;
    raise notice 'OK: overlapping period rejected';
  end;

  raise notice '--- a blocking warning with no amount is rejected ---';
  declare
    v_block_id uuid;
    v_err text;
  begin
    insert into public.payroll_runs (shop_id, period_start, period_end)
      values (v_shop_id, '2026-09-01', '2026-09-07') returning id into v_block_id;
    insert into public.payroll_run_lines (payroll_run_id, shop_member_id, member_name, amount_cents, warning, warning_blocking)
      values (v_block_id, v_member_id, 'Verify Staff', 0, 'No pay rate set', true);
    -- A second, healthy line so the run's total is positive. Without it the
    -- run would also trip the "nothing to pay" guard, and the test couldn't
    -- tell which guard actually fired.
    insert into public.payroll_run_lines (payroll_run_id, shop_member_id, member_name, amount_cents)
      values (v_block_id, v_member_id, 'Verify Staff Two', 5000);

    v_raised := false;
    begin
      perform public.post_payroll_run(v_block_id);
    exception when others then
      v_raised := true;
      v_err := sqlerrm;
    end;
    if not v_raised then raise exception 'FAIL: a blocking zero-amount line was posted'; end if;
    if v_err not like 'no amount set for Verify Staff%' then
      raise exception 'FAIL: blocking error did not name the member, got: %', v_err;
    end if;
    raise notice 'OK: blocking zero-amount line rejected';

    raise notice '--- entering an amount clears the block, warning survives ---';
    update public.payroll_run_lines set amount_cents = 3000
      where payroll_run_id = v_block_id and warning_blocking;
    perform public.post_payroll_run(v_block_id);

    select status into v_status from public.payroll_runs where id = v_block_id;
    if v_status <> 'posted' then raise exception 'FAIL: run status % after an amount was entered', v_status; end if;
    -- The guard tests the amount, not the warning, so the warning must still be
    -- on the row afterwards as audit history.
    select count(*) into v_count from public.payroll_run_lines
      where payroll_run_id = v_block_id and warning_blocking and warning is not null;
    if v_count <> 1 then raise exception 'FAIL: the warning did not survive posting'; end if;
    raise notice 'OK: amount unblocked the post and the warning survived';

    select count(*), max(amount_cents), max(occurred_on) into v_count, v_amount, v_date
      from public.expenses where payroll_run_id = v_block_id;
    if v_count <> 1 then raise exception 'FAIL: expected 1 expense for the blocked run, got %', v_count; end if;
    if v_amount <> 8000 then raise exception 'FAIL: blocked-run expense %, expected 8000 (3000 + 5000)', v_amount; end if;
    if v_date <> date '2026-09-07' then raise exception 'FAIL: blocked-run expense dated %, expected the period end', v_date; end if;
    raise notice 'OK: blocked run posted one expense of % dated %', v_amount, v_date;
  end;

  raise notice '--- unposting removes the generated expense ---';
  perform public.unpost_payroll_run(v_run_id);
  select count(*) into v_count from public.expenses where payroll_run_id = v_run_id;
  if v_count <> 0 then raise exception 'FAIL: % payroll expense(s) survived unposting', v_count; end if;
  select status into v_status from public.payroll_runs where id = v_run_id;
  if v_status <> 'draft' then raise exception 'FAIL: run status % after unpost', v_status; end if;
  raise notice 'OK: unpost cleared the expense and returned the run to draft';

  ------------------------------------------------------------------
  raise notice '=== 6. Logging a recurring bill posts it and advances the date ===';
  ------------------------------------------------------------------
  insert into public.recurring_bills (shop_id, name, category, frequency, amount_cents, next_due_date)
    values (v_shop_id, 'Verify Rent', 'rent', 'monthly', 40000, '2026-08-15') returning id into v_bill_id;

  select public.log_recurring_bill(v_bill_id) into v_expense_id;

  select amount_cents, occurred_on into v_amount, v_date from public.expenses where id = v_expense_id;
  if v_amount <> 40000 then raise exception 'FAIL: logged bill expense %, expected 40000', v_amount; end if;
  -- Dated the due date, not today, so logging late doesn't move the cost.
  if v_date <> date '2026-08-15' then raise exception 'FAIL: logged expense dated %, expected the due date', v_date; end if;

  select next_due_date into v_date from public.recurring_bills where id = v_bill_id;
  if v_date <> date '2026-09-15' then raise exception 'FAIL: next due date %, expected one month on', v_date; end if;
  raise notice 'OK: logged an expense dated 2026-08-15 and moved the due date to %', v_date;

  ------------------------------------------------------------------
  raise notice '=== 7. Sale item cost snapshot ===';
  ------------------------------------------------------------------
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'sale_items' and column_name = 'unit_cost_cents'
  ) then
    raise exception 'FAIL: sale_items.unit_cost_cents is missing';
  end if;
  raise notice 'OK: sale_items.unit_cost_cents present';

  raise notice '';
  raise notice '################  ALL CHECKS PASSED  ################';

  -- Everything above is deliberately discarded: raising here rolls the
  -- enclosing block's subtransaction back, so the database is left as found.
  raise exception 'VERIFY_ROLLBACK';
exception
  when others then
    if sqlerrm = 'VERIFY_ROLLBACK' then
      raise notice 'Rolled back — no rows left behind.';
    else
      raise;
    end if;
end $$;
