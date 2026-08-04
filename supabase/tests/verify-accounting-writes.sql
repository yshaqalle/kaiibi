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
  v_err text;
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

  raise notice '--- a DIFFERENT member may be paid over an overlapping period ---';
  declare
    v_other_member uuid;
    v_other_user uuid;
    v_parallel_id uuid;
  begin
    -- Brief defect found and authorized fix: a bare gen_random_uuid() here has
    -- no matching auth.users row, so the shop_members insert trips its
    -- user_id FK before the guard under test is ever reached. Mirror lines
    -- 32-34, which create v_user_id's auth.users row the same way. A fresh
    -- user (not v_user_id) because shop_members is unique on (shop_id,
    -- user_id) and reusing v_user_id would trip that constraint instead.
    v_other_user := gen_random_uuid();
    insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
      values (v_other_user, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
              'verify-' || v_other_user || '@example.test', '', now(), now(), now());
    insert into public.shop_members (shop_id, user_id, role_id, active, full_name, pay_type, pay_rate_cents, pay_cadence)
      values (v_shop_id, v_other_user, v_role_id, true, 'Parallel Staff', 'hourly', 500, 'weekly')
      returning id into v_other_member;
    insert into public.payroll_runs (shop_id, period_start, period_end, cadence)
      values (v_shop_id, '2026-08-03', '2026-08-09', 'weekly') returning id into v_parallel_id;
    insert into public.payroll_run_lines (payroll_run_id, shop_member_id, member_name, amount_cents)
      values (v_parallel_id, v_other_member, 'Parallel Staff', 2500);

    -- This overlaps the already-posted Aug 1-7 run. Under the old shop-wide
    -- guard it was rejected; that is exactly what made per-member cadence
    -- impossible, so accepting it is the behaviour worth proving.
    perform public.post_payroll_run(v_parallel_id);
    select status into v_status from public.payroll_runs where id = v_parallel_id;
    if v_status <> 'posted' then raise exception 'FAIL: a different member was blocked by an overlapping period'; end if;
    raise notice 'OK: overlapping period accepted for a different member';

    raise notice '--- the SAME member is still refused over an overlapping period ---';
    declare v_dupe_id uuid;
    begin
      insert into public.payroll_runs (shop_id, period_start, period_end)
        values (v_shop_id, '2026-08-05', '2026-08-11') returning id into v_dupe_id;
      insert into public.payroll_run_lines (payroll_run_id, shop_member_id, member_name, amount_cents)
        values (v_dupe_id, v_other_member, 'Parallel Staff', 2500);
      v_raised := false;
      begin
        perform public.post_payroll_run(v_dupe_id);
      exception when others then
        v_raised := true;
        v_err := sqlerrm;
      end;
      if not v_raised then raise exception 'FAIL: the same member was paid twice for overlapping periods'; end if;
      if v_err not like '%was already paid for part of%' then
        raise exception 'FAIL: the error should be the double-pay guard, got: %', v_err;
      end if;
      raise notice 'OK: same-member overlap refused, naming the member';
    end;
  end;

  raise notice '--- KNOWN LIMITATION (not a goal, do not "fix" without reading the migration header): two shop_members rows for the same human both get paid over an overlapping period ---';
  declare
    v_bob_one_user uuid;
    v_bob_one_member uuid;
    v_bob_one_run_id uuid;
    v_bob_two_user uuid;
    v_bob_two_member uuid;
    v_bob_two_run_id uuid;
  begin
    -- The per-member overlap guard keys on shop_member_id, and shop_members
    -- is unique on (shop_id, user_id) -- not on "is this the same human".
    -- Two shop_members rows for one person (duplicate hire record, second
    -- auth account) collide with nothing in the guard, so both can be paid
    -- over overlapping periods. The old shop-wide guard caught this
    -- incidentally, as a side effect of blocking every overlap; the
    -- per-member guard does not, by design (see the migration header in
    -- 20260804030100_payroll_per_member_overlap.sql). This test PINS that
    -- known behaviour so it doesn't silently change; it is not asserting
    -- this is desired. If a future change closes this gap, this test should
    -- be rewritten to assert the block, not deleted.
    --
    -- Each row needs its own auth.users row (mirrors lines 32-34) and its
    -- own user_id, since shop_members is unique on (shop_id, user_id).
    v_bob_one_user := gen_random_uuid();
    insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
      values (v_bob_one_user, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
              'verify-' || v_bob_one_user || '@example.test', '', now(), now(), now());
    insert into public.shop_members (shop_id, user_id, role_id, active, full_name, pay_type, pay_rate_cents)
      values (v_shop_id, v_bob_one_user, v_role_id, true, 'Bob', 'hourly', 500)
      returning id into v_bob_one_member;

    v_bob_two_user := gen_random_uuid();
    insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
      values (v_bob_two_user, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
              'verify-' || v_bob_two_user || '@example.test', '', now(), now(), now());
    insert into public.shop_members (shop_id, user_id, role_id, active, full_name, pay_type, pay_rate_cents)
      values (v_shop_id, v_bob_two_user, v_role_id, true, 'Bob', 'hourly', 500)
      returning id into v_bob_two_member;

    insert into public.payroll_runs (shop_id, period_start, period_end)
      values (v_shop_id, '2026-10-01', '2026-10-07') returning id into v_bob_one_run_id;
    insert into public.payroll_run_lines (payroll_run_id, shop_member_id, member_name, amount_cents)
      values (v_bob_one_run_id, v_bob_one_member, 'Bob', 2000);
    perform public.post_payroll_run(v_bob_one_run_id);

    insert into public.payroll_runs (shop_id, period_start, period_end)
      values (v_shop_id, '2026-10-03', '2026-10-09') returning id into v_bob_two_run_id;
    insert into public.payroll_run_lines (payroll_run_id, shop_member_id, member_name, amount_cents)
      values (v_bob_two_run_id, v_bob_two_member, 'Bob', 2000);
    perform public.post_payroll_run(v_bob_two_run_id);

    select status into v_status from public.payroll_runs where id = v_bob_two_run_id;
    if v_status <> 'posted' then
      raise exception 'FAIL: known-limitation test drifted -- the second "Bob" run was blocked. The guard behaviour changed; update this test (and the migration header) rather than treating this failure as a regression to revert.';
    end if;
    raise notice 'OK (known limitation, not desired behaviour): two distinct shop_members rows both named Bob were both paid over overlapping periods 2026-10-01..07 and 2026-10-03..09';
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

  ------------------------------------------------------------------
  raise notice '=== 8. Shifts: a member reads their own, not a colleague''s ===';
  ------------------------------------------------------------------
  declare
    v_own_user uuid := gen_random_uuid();
    v_own_id uuid;
    v_mate_user uuid := gen_random_uuid();
    v_mate_id uuid;
    v_mine_id uuid;
    v_theirs_id uuid;
    v_seen integer;
    -- shifts.location_id became NOT NULL when multi-store landed (migration
    -- 20260815000000): a shift is worked at a branch, not at a business.
    -- Migration 20260808000000 backfilled one location per shop that existed
    -- at the time, but nothing creates one for a shop inserted afterwards --
    -- so this throwaway shop has none and has to make its own.
    v_shift_location uuid;
  begin
    select id into v_shift_location from public.shop_locations where shop_id = v_shop_id and is_primary limit 1;
    if v_shift_location is null then
      insert into public.shop_locations (shop_id, name, is_primary)
        values (v_shop_id, 'Verify Store', true) returning id into v_shift_location;
    end if;
    -- Brief defect found and authorized fix: the brief's own-shift reader was
    -- v_member_id, which belongs to v_user_id -- the SHOP OWNER (see line 36:
    -- `insert into public.shops (owner_id, ...) values (v_user_id, ...)`).
    -- user_has_shop_permission() (0024_permission_gates.sql) gives the owner
    -- every permission unconditionally, so "read shop shifts" would match for
    -- the owner regardless of v_role_id's grants, and the colleague-hidden
    -- assertion below would fail for the wrong reason -- masking exactly the
    -- bug this test exists to catch. Use a fresh, non-owner member on the
    -- same expenses.manage-only role instead, so it's the own-rows policy
    -- actually being exercised, not the owner bypass.
    insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
      values (v_own_user, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
              'verify-' || v_own_user || '@example.test', '', now(), now(), now());
    insert into public.shop_members (shop_id, user_id, role_id, active, full_name)
      values (v_shop_id, v_own_user, v_role_id, true, 'Rota Self')
      returning id into v_own_id;

    -- A second member, with their own auth user (shop_members is unique on
    -- (shop_id, user_id), and user_id references auth.users).
    insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
      values (v_mate_user, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
              'verify-' || v_mate_user || '@example.test', '', now(), now(), now());
    insert into public.shop_members (shop_id, user_id, role_id, active, full_name)
      values (v_shop_id, v_mate_user, v_role_id, true, 'Rota Mate')
      returning id into v_mate_id;

    insert into public.shifts (shop_id, location_id, shop_member_id, shift_date, start_time, end_time)
      values (v_shop_id, v_shift_location, v_own_id, '2026-08-03', '09:00', '17:00') returning id into v_mine_id;
    insert into public.shifts (shop_id, location_id, shop_member_id, shift_date, start_time, end_time)
      values (v_shop_id, v_shift_location, v_mate_id, '2026-08-03', '09:00', '17:00') returning id into v_theirs_id;

    -- The role held by both members grants only expenses.manage, so neither
    -- has people.schedule.manage and each must fall back to the own-rows
    -- policy.
    set local role authenticated;
    perform set_config('request.jwt.claims', json_build_object('sub', v_own_user)::text, true);

    select count(*) into v_seen from public.shifts where id = v_mine_id;
    if v_seen <> 1 then raise exception 'FAIL: a member cannot read their own shift'; end if;

    select count(*) into v_seen from public.shifts where id = v_theirs_id;
    if v_seen <> 0 then raise exception 'FAIL: a member read a colleague''s shift without people.schedule.manage'; end if;

    v_raised := false;
    begin
      insert into public.shifts (shop_id, location_id, shop_member_id, shift_date, start_time, end_time)
        values (v_shop_id, v_shift_location, v_own_id, '2026-08-04', '09:00', '17:00');
    exception when others then
      v_raised := true;
    end;
    if not v_raised then raise exception 'FAIL: a member wrote a shift without people.schedule.manage'; end if;

    reset role;
    perform set_config('request.jwt.claims', json_build_object('sub', v_user_id)::text, true);
    raise notice 'OK: own shift readable, colleague''s hidden, writes refused';

    -- Now the positive case: a member WHO HOLDS people.schedule.manage must
    -- see the whole team's shifts, not just their own. Nothing above proves
    -- "read shop shifts" does anything at all -- mutating it to `using
    -- (false)` still leaves every assertion above green, since the own-rows
    -- policy alone satisfies them.
    declare
      v_manager_role_id uuid;
      v_manager_user uuid := gen_random_uuid();
      v_manager_id uuid;
      v_new_shift_id uuid;
      v_outsider_shop_id uuid;
      v_outsider_owner uuid := gen_random_uuid();
      v_outsider_role_id uuid;
      v_outsider_user uuid := gen_random_uuid();
      v_outsider_id uuid;
    begin
      insert into public.roles (shop_id, name, permissions)
        values (v_shop_id, 'Verify Schedule Manager', array['people.schedule.manage'])
        returning id into v_manager_role_id;

      insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
        values (v_manager_user, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
                'verify-' || v_manager_user || '@example.test', '', now(), now(), now());
      insert into public.shop_members (shop_id, user_id, role_id, active, full_name)
        values (v_shop_id, v_manager_user, v_manager_role_id, true, 'Rota Manager')
        returning id into v_manager_id;

      -- A second shop with its own member, for the cross-shop rejection
      -- assertion below. Built while still superuser (before "set local role
      -- authenticated") so these inserts aren't themselves subject to RLS.
      insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
        values (v_outsider_owner, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
                'verify-' || v_outsider_owner || '@example.test', '', now(), now(), now());
      insert into public.shops (owner_id, name) values (v_outsider_owner, 'Verify Shop Two') returning id into v_outsider_shop_id;
      insert into public.roles (shop_id, name, permissions)
        values (v_outsider_shop_id, 'Verify Outsider Role', array['expenses.manage'])
        returning id into v_outsider_role_id;
      insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
        values (v_outsider_user, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
                'verify-' || v_outsider_user || '@example.test', '', now(), now(), now());
      insert into public.shop_members (shop_id, user_id, role_id, active, full_name)
        values (v_outsider_shop_id, v_outsider_user, v_outsider_role_id, true, 'Outsider')
        returning id into v_outsider_id;

      -- An approved leave request for the colleague, built here (still
      -- superuser, so not itself subject to RLS) for the list_shop_time_off
      -- assertions below. reason is deliberately sensitive-looking, so the
      -- "no reason column" assertion actually proves something.
      insert into public.time_off_requests (shop_id, shop_member_id, start_date, end_date, status, reason)
        values (v_shop_id, v_mate_id, '2026-08-10', '2026-08-12', 'approved', 'medical, not a scheduler''s business');

      set local role authenticated;
      perform set_config('request.jwt.claims', json_build_object('sub', v_manager_user)::text, true);

      select count(*) into v_seen from public.shifts where id = v_mine_id;
      if v_seen <> 1 then raise exception 'FAIL: a manager with people.schedule.manage cannot see a member''s own shift'; end if;

      select count(*) into v_seen from public.shifts where id = v_theirs_id;
      if v_seen <> 1 then raise exception 'FAIL: a manager with people.schedule.manage cannot see a colleague''s shift'; end if;

      -- Now the write side. Nothing above proves "write shop shifts" can
      -- ever succeed for anyone but the shop owner -- the owner branch of
      -- user_has_shop_permission() also satisfies "read shop_members", so an
      -- inline `exists` in the WITH CHECK would pass for the owner and fail
      -- silently for every teammate, and a rejection-only assertion would
      -- never catch that. Prove the positive: a member holding ONLY
      -- people.schedule.manage inserts a shift for a teammate in their own
      -- shop, and the row exists afterwards.
      insert into public.shifts (shop_id, location_id, shop_member_id, shift_date, start_time, end_time)
        values (v_shop_id, v_shift_location, v_mate_id, '2026-08-05', '09:00', '17:00')
        returning id into v_new_shift_id;
      select count(*) into v_seen from public.shifts
        where id = v_new_shift_id and shop_id = v_shop_id and shop_member_id = v_mate_id;
      if v_seen <> 1 then
        raise exception 'FAIL: a manager with people.schedule.manage could not insert a shift for a teammate';
      end if;
      raise notice 'OK: a member with people.schedule.manage inserted a shift for a teammate';

      -- And the other direction, beside it: the same manager must not be
      -- able to insert a shift naming a shop_member_id from a DIFFERENT
      -- shop. This is what shop_member_in_shop(shop_member_id, shop_id)
      -- guards in the WITH CHECK.
      v_raised := false;
      begin
        insert into public.shifts (shop_id, location_id, shop_member_id, shift_date, start_time, end_time)
          values (v_shop_id, v_shift_location, v_outsider_id, '2026-08-05', '09:00', '17:00');
      exception when others then
        v_raised := true;
      end;
      if not v_raised then
        raise exception 'FAIL: a manager inserted a shift for a member of a different shop';
      end if;
      raise notice 'OK: a manager could not insert a shift for a member of a different shop';

      -- Fix 4 regression: shop_members carries pay_rate_cents and RLS is
      -- row-level, not column-level, so the pay gate for a scheduler lives
      -- ONLY inside list_shop_staff (20260803010000), never in "read
      -- shop_members" itself. Nothing above proves that -- re-adding
      -- people.schedule.manage to that policy would leave every check so far
      -- green. Assert the manager (who holds only people.schedule.manage)
      -- reads zero rows querying the table directly.
      select count(*) into v_seen from public.shop_members where id = v_mate_id;
      if v_seen <> 0 then
        raise exception 'FAIL: a schedule manager read a colleague''s shop_members row (pay columns are not gated at row level)';
      end if;
      raise notice 'OK: a schedule manager cannot read shop_members rows directly';

      -- Fix 3: the on_leave warning (scheduling.ts, unit tested) needs
      -- approved leave, but the only shop-wide read policy on
      -- time_off_requests -- "approver manages shop time off requests" -- is
      -- gated on people.timeoff.approve alone. A scheduler holding only
      -- people.schedule.manage is neither approver nor requester, so RLS
      -- would silently drop every row through the table. list_shop_time_off
      -- (20260807000000) is the wider, security-definer read path; assert
      -- the manager CAN see the colleague's approved leave through it, and
      -- that the result never carries the free-text reason column.
      select count(*) into v_seen
        from public.list_shop_time_off(v_shop_id, '2026-08-01'::date, '2026-08-31'::date) t
        where t.shop_member_id = v_mate_id and t.start_date = '2026-08-10' and t.end_date = '2026-08-12';
      if v_seen <> 1 then
        raise exception 'FAIL: a schedule manager could not see approved leave through list_shop_time_off';
      end if;

      v_raised := false;
      begin
        perform reason from public.list_shop_time_off(v_shop_id, '2026-08-01'::date, '2026-08-31'::date);
      exception when undefined_column then
        v_raised := true;
      end;
      if not v_raised then
        raise exception 'FAIL: list_shop_time_off exposed a reason column';
      end if;
      raise notice 'OK: a schedule manager sees approved leave via list_shop_time_off, with no reason column returned';

      reset role;
      perform set_config('request.jwt.claims', json_build_object('sub', v_user_id)::text, true);
      raise notice 'OK: a member with people.schedule.manage sees the whole team''s shifts';
    end;
  end;

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
