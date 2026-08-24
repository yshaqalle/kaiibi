-- An expense written by a plain client-side INSERT reaches the ledger.
--
-- Expenses are the one money move in phase 2b with no RPC to add a posting
-- side to -- src/lib/expenses.ts:96 is `.from('expenses').insert()`. Task 7b
-- puts an AFTER INSERT trigger there instead. What is asserted, and why:
--
--   1. An ordinary expense posts Dr the account its CATEGORY maps to / Cr the
--      account its PAYMENT METHOD maps to, and points the row at the entry.
--      'transport_delivery' is 6500 and 'supplies' is 6400 -- adjacent codes,
--      so an off-by-one in the map is visible rather than plausible.
--   2. A zaad expense credits 1020, not 1000. Same defect
--      verify-posting-bills.sql check 2 catches on the supplier-payment side:
--      a wrong wallet balances perfectly and makes the till count disagree
--      with the ledger for a reason nobody can find.
--   3. THE CASE THAT MAKES A BALANCE SHEET POSSIBLE. 'inventory_purchase'
--      debits 1200 Inventory -- an ASSET -- and posts NO expense-type line at
--      all. Asserted as "no expense line exists" rather than as an amount,
--      because a 6900/1000 pair balances just as well and would sail past any
--      totals check. NON_OPERATING_CATEGORIES in expense-reporting.ts reaches
--      the right net profit today by EXCLUDING this category; here it is right
--      because of where the account sits.
--   4. 'owner_draw' debits 3100 Owner's Draw -- CONTRA-EQUITY. Also asserted
--      by account TYPE, not just code, so renumbering the chart cannot quietly
--      turn a draw back into a cost.
--   5. THE CHECK THAT CATCHES THE DOUBLE-COUNT. post_payroll_run writes BOTH a
--      journal entry AND an expenses row carrying payroll_run_id. A naive
--      trigger posts a second entry for that row and 6200 Salaries and Wages
--      reads double the wages actually paid -- WITH THE TRIAL BALANCE STILL
--      ZERO, because both entries individually balance, so nothing else in the
--      system catches it.
--   6. Same shape for a BILL. sync_invoice_expense mirrors every invoice into
--      expenses carrying invoice_id; the cost is recognised by the bill and
--      the liability by receive_stock / record_invoice_payment. Posting here
--      too would double every stocked cost the shop has.
--   7. An expense that already carries a journal_entry_id is left alone --
--      which is the state Task 8's backfill leaves every replayed row in.
--   8. A back-dated expense whose month has CLOSED posts to the open month
--      rather than raising. The expense editor has a free date field, so this
--      is the ordinary way last week's receipt is entered, and without the
--      redirect an insert that works today would start failing outright.
--
-- Deliberately NOT `set role authenticated`, for the same reason
-- verify-posting-bills.sql is not: this script stays superuser so RLS never
-- hides a journal_lines row from its own assertions. Nothing under test is an
-- RLS policy. post_payroll_run gates on has_shop_permission(), which reads
-- auth.uid() from the JWT claim set below.
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
  v_expense_id uuid;
  v_run_id     uuid;
  v_invoice_id uuid;
  v_entry      uuid;
  v_first      uuid;
  v_entry_loc  uuid;
  v_amount     bigint;
  v_rows       integer;
  v_before     integer;
  v_text       text;
  v_date       date;
  v_on         date;
  v_closed_on  date;
begin
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
  select u, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
         'verify-posting-expenses-' || u || '@example.test', '', now(), now(), now()
    from unnest(array[v_user_id, v_user_two, v_user_three]) u;

  insert into public.shops (owner_id, name) values (v_user_id, 'Posting Expenses Shop')
    returning id into v_shop_id;

  -- A shop has no location until the fixture makes one; seed_shop_defaults does
  -- not create one. It DOES seed the chart of accounts, which is where 1000,
  -- 1020, 1200, 3100, 6200, 6400 and 6500 come from.
  insert into public.shop_locations (shop_id, name, is_primary)
    values (v_shop_id, 'Main', true) returning id into v_loc_id;

  perform set_config('request.jwt.claims', json_build_object('sub', v_user_id)::text, true);

  ---------------------------------------------------------------------------
  -- 1. An ordinary expense posts Dr its category's account / Cr 1000 Cash.
  ---------------------------------------------------------------------------
  -- 7341 is not divisible by anything the other fixtures use and no pair of
  -- the amounts in this script sums to it. 'transport_delivery' is 6500; its
  -- neighbours in the map are 6400 supplies and 6600 maintenance_repairs, so a
  -- map read one row out lands on a real account and the amount check is what
  -- separates them -- hence the assertion that 6400 and 6600 are UNTOUCHED.
  --
  -- Dated three days back, so an implementation that reached for today instead
  -- of occurred_on separates from a correct one every day of the year.
  v_on := public.shop_local_date() - 3;
  insert into public.expenses (shop_id, location_id, occurred_on, amount_cents, category, payment_method, note, created_by)
    values (v_shop_id, v_loc_id, v_on, 7341, 'transport_delivery', 'cash', 'Delivery van fuel', v_user_id)
    returning id, journal_entry_id into v_expense_id, v_entry;

  -- Read back rather than trusted from RETURNING: the trigger is AFTER INSERT
  -- and writes journal_entry_id with its own UPDATE, so the RETURNING value is
  -- the pre-trigger NULL. An assertion on the returned value would fail a
  -- correct implementation -- which is exactly the shape of no-op this suite
  -- has been bitten by before.
  select journal_entry_id into v_entry from public.expenses where id = v_expense_id;
  if v_entry is null then
    raise exception 'FAIL: an ordinary expense did not post -- expenses.journal_entry_id is null';
  end if;
  v_first := v_entry;

  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l join public.accounts a on a.id = l.account_id
   where l.entry_id = v_entry and a.code = '6500';
  if v_amount <> 7341 then
    raise exception 'FAIL: expected Dr 6500 Transport and delivery 7341, got %', v_amount;
  end if;
  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l join public.accounts a on a.id = l.account_id
   where l.entry_id = v_entry and a.code = '1000';
  if v_amount <> -7341 then
    raise exception 'FAIL: expected Cr 1000 Cash -7341, got %', v_amount;
  end if;
  -- The neighbours the map could slip onto.
  if exists (select 1 from public.journal_lines l join public.accounts a on a.id = l.account_id
              where l.entry_id = v_entry and a.code in ('6400', '6600')) then
    raise exception 'FAIL: a transport_delivery expense touched 6400 or 6600 -- the category map is off by one';
  end if;

  select source, entry_date, location_id into v_text, v_date, v_entry_loc
    from public.journal_entries where id = v_entry;
  -- 'bill' -- a cost the shop has incurred. NOT 'payment', which
  -- record_invoice_payment already uses for a structurally different entry
  -- (Dr 2000 Accounts Payable, no expense line at all).
  if v_text <> 'bill' then
    raise exception 'FAIL: expected source ''bill'', got %', v_text;
  end if;
  -- occurred_on, not today. A receipt logged days late is still the purchase
  -- date's cost (20260804000200).
  if v_date <> v_on then
    raise exception 'FAIL: the expense entry should be dated % (occurred_on), got %', v_on, v_date;
  end if;
  if v_entry_loc is distinct from v_loc_id then
    raise exception 'FAIL: the expense entry should carry the expense''s store';
  end if;
  -- The link is readable in both directions. Task 8 reconciles replayed
  -- entries against their source rows through this.
  select description into v_text from public.journal_entries where id = v_entry;
  if v_text not like '%' || v_expense_id::text || '%' then
    raise exception 'FAIL: the entry description does not name the expense: %', v_text;
  end if;

  ---------------------------------------------------------------------------
  -- 2. The wallet the money actually left, not 1000 for everything.
  ---------------------------------------------------------------------------
  -- 'zaad' is 1020; 1021 is eDahab and belongs to a different method.
  insert into public.expenses (shop_id, location_id, occurred_on, amount_cents, category, payment_method, note, created_by)
    values (v_shop_id, v_loc_id, v_on, 4188, 'supplies', 'zaad', 'Till roll', v_user_id)
    returning id into v_expense_id;
  select journal_entry_id into v_entry from public.expenses where id = v_expense_id;
  if v_entry is null then raise exception 'FAIL: the zaad expense did not post'; end if;

  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l join public.accounts a on a.id = l.account_id
   where l.entry_id = v_entry and a.code = '6400';
  if v_amount <> 4188 then
    raise exception 'FAIL: expected Dr 6400 Supplies 4188, got %', v_amount;
  end if;
  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l join public.accounts a on a.id = l.account_id
   where l.entry_id = v_entry and a.code = '1020';
  if v_amount <> -4188 then
    raise exception 'FAIL: expected Cr 1020 Zaad -4188, got % (a zaad expense must not touch 1000 Cash)', v_amount;
  end if;
  if exists (select 1 from public.journal_lines l join public.accounts a on a.id = l.account_id
              where l.entry_id = v_entry and a.code = '1000') then
    raise exception 'FAIL: a zaad expense credited 1000 Cash -- the drawer and the ledger now disagree';
  end if;

  ---------------------------------------------------------------------------
  -- 3. inventory_purchase debits 1200 Inventory. AN ASSET, NOT A COST.
  ---------------------------------------------------------------------------
  -- This is the case that makes a balance sheet possible. Stock is an asset
  -- until it sells, at which point it becomes COGS through
  -- sale_items.unit_cost_cents; posting it as a cost here would count it
  -- twice, and the shop's net profit would be wrong by the whole of its
  -- purchasing.
  insert into public.expenses (shop_id, location_id, occurred_on, amount_cents, category, payment_method, note, created_by)
    values (v_shop_id, v_loc_id, v_on, 52193, 'inventory_purchase', 'cash', 'Sacks of rice', v_user_id)
    returning id into v_expense_id;
  select journal_entry_id into v_entry from public.expenses where id = v_expense_id;
  if v_entry is null then raise exception 'FAIL: the inventory_purchase expense did not post'; end if;

  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l join public.accounts a on a.id = l.account_id
   where l.entry_id = v_entry and a.code = '1200';
  if v_amount <> 52193 then
    raise exception 'FAIL: expected Dr 1200 Inventory 52193, got % (a stock purchase is an asset, not a cost)', v_amount;
  end if;
  -- Asserted as "no expense-type line at all", not as an amount: an entry that
  -- debited 6900 Other and credited 1000 balances perfectly, and a totals check
  -- would never see it.
  if exists (select 1 from public.journal_lines l join public.accounts a on a.id = l.account_id
              where l.entry_id = v_entry and a.type = 'expense') then
    raise exception 'FAIL: a stock purchase posted an expense line -- the P&L now double-counts every sack of rice';
  end if;
  -- By TYPE as well as code, so renumbering the chart cannot quietly turn an
  -- asset back into a cost.
  select a.type into v_text
    from public.journal_lines l join public.accounts a on a.id = l.account_id
   where l.entry_id = v_entry and l.amount_cents > 0;
  if v_text <> 'asset' then
    raise exception 'FAIL: the debit side of a stock purchase is a %, expected asset', v_text;
  end if;

  ---------------------------------------------------------------------------
  -- 4. owner_draw debits 3100 Owner's Draw. CONTRA-EQUITY, NOT A COST.
  ---------------------------------------------------------------------------
  insert into public.expenses (shop_id, location_id, occurred_on, amount_cents, category, payment_method, note, created_by)
    values (v_shop_id, v_loc_id, v_on, 31179, 'owner_draw', 'cash', 'Owner took cash', v_user_id)
    returning id into v_expense_id;
  select journal_entry_id into v_entry from public.expenses where id = v_expense_id;
  if v_entry is null then raise exception 'FAIL: the owner_draw expense did not post'; end if;

  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l join public.accounts a on a.id = l.account_id
   where l.entry_id = v_entry and a.code = '3100';
  if v_amount <> 31179 then
    raise exception 'FAIL: expected Dr 3100 Owner''s Draw 31179, got % (a draw is equity coming out, not a cost)', v_amount;
  end if;
  if exists (select 1 from public.journal_lines l join public.accounts a on a.id = l.account_id
              where l.entry_id = v_entry and a.type = 'expense') then
    raise exception 'FAIL: an owner draw posted an expense line -- net profit is now understated by the draw';
  end if;
  select a.type into v_text
    from public.journal_lines l join public.accounts a on a.id = l.account_id
   where l.entry_id = v_entry and l.amount_cents > 0;
  if v_text <> 'equity' then
    raise exception 'FAIL: the debit side of an owner draw is a %, expected equity', v_text;
  end if;

  ---------------------------------------------------------------------------
  -- 5. THE DOUBLE-COUNT. A payroll-derived expense row posts NOTHING.
  ---------------------------------------------------------------------------
  -- post_payroll_run writes BOTH a journal entry (Dr 6200 / Cr 1000) AND an
  -- expenses row carrying payroll_run_id and category 'salaries_wages' --
  -- which the category map sends to 6200. A trigger that does not skip that
  -- row posts a SECOND entry and 6200 reads double the wages actually paid,
  -- with the trial balance still zero because both entries balance on their
  -- own. Nothing else in this system catches that.
  --
  -- 13700 + 21100 + 9450 = 44250. No two of them sum to it, so a dropped
  -- member cannot pass by arithmetic coincidence, and 88500 (the double) is
  -- unmistakable.
  insert into public.roles (shop_id, name, permissions)
    values (v_shop_id, 'Posting Expenses Staff', array['expenses.manage'])
    returning id into v_role_id;
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
    values (v_run_id, v_member_one, 'Payroll One',   13700),
           (v_run_id, v_member_two, 'Payroll Two',   21100),
           (v_run_id, v_member_3,   'Payroll Three',  9450);

  -- Counted BEFORE, because 'bill' entries already exist from checks 1-4: an
  -- assertion of "no bill entries in this shop" would be red before the pay
  -- run was posted at all, and would therefore prove nothing about it.
  select count(*) into v_before from public.journal_entries
   where shop_id = v_shop_id and source = 'bill';

  -- PERFORM, not assignment: post_payroll_run returns the EXPENSE id.
  perform public.post_payroll_run(v_run_id);

  select count(*) into v_rows from public.journal_entries
   where shop_id = v_shop_id and source = 'bill';
  if v_rows <> v_before then
    raise exception 'FAIL: posting a pay run wrote % extra ''bill'' entries -- the trigger did not skip the payroll expense row', v_rows - v_before;
  end if;

  -- Exactly ONE entry for this run, whichever source it carries.
  select count(*) into v_rows from public.journal_entries
   where shop_id = v_shop_id and source = 'payroll';
  if v_rows <> 1 then
    raise exception 'FAIL: expected exactly 1 payroll entry, got %', v_rows;
  end if;

  -- 6200 debited ONCE, across the whole shop. Measured shop-wide rather than
  -- per entry, which is the only way a second entry is visible: every per-entry
  -- assertion in verify-posting-bills.sql would still pass with a duplicate
  -- sitting alongside.
  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l
    join public.accounts a on a.id = l.account_id
    join public.journal_entries e on e.id = l.entry_id
   where e.shop_id = v_shop_id and a.code = '6200';
  if v_amount <> 44250 then
    raise exception 'FAIL: 6200 Salaries reads % shop-wide, expected 44250 (88500 = the payroll expense row was posted a second time)', v_amount;
  end if;

  -- And the row itself carries no entry of its own -- post_payroll_run points
  -- payroll_runs.journal_entry_id at the entry, not the expense.
  select journal_entry_id into v_entry from public.expenses where payroll_run_id = v_run_id;
  if v_entry is not null then
    raise exception 'FAIL: the payroll-derived expense row carries a journal entry of its own';
  end if;

  -- The whole shop still zeroes.
  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l join public.journal_entries e on e.id = l.entry_id
   where e.shop_id = v_shop_id;
  if v_amount <> 0 then
    raise exception 'FAIL: the trial balance does not zero, off by %', v_amount;
  end if;

  ---------------------------------------------------------------------------
  -- 6. A bill-derived expense row posts nothing either.
  ---------------------------------------------------------------------------
  -- sync_invoice_expense (20260816000000) mirrors every invoice into expenses
  -- carrying invoice_id. The cost is recognised by the bill; receive_stock
  -- credits 2000 when the goods arrive and record_invoice_payment debits it
  -- when the money moves. Posting 6xxx here as well would double every stocked
  -- cost the shop has -- the most common double-count in a first ledger.
  select count(*) into v_before from public.journal_entries where shop_id = v_shop_id;
  insert into public.invoices (shop_id, location_id, vendor_name, invoice_number,
                               category, issued_on, due_on, amount_cents)
    values (v_shop_id, v_loc_id, 'Expenses Vendor', 'EXP-1', 'rent',
            public.shop_local_date() - 5, public.shop_local_date() + 10, 61437)
    returning id into v_invoice_id;
  select count(*) into v_rows from public.journal_entries where shop_id = v_shop_id;
  if v_rows <> v_before then
    raise exception 'FAIL: recording a bill wrote % journal entries via its mirrored expense row', v_rows - v_before;
  end if;
  select journal_entry_id into v_entry from public.expenses where invoice_id = v_invoice_id;
  if v_entry is not null then
    raise exception 'FAIL: the bill-derived expense row carries a journal entry of its own';
  end if;

  ---------------------------------------------------------------------------
  -- 7. An expense already carrying a journal_entry_id is left alone.
  ---------------------------------------------------------------------------
  -- This is the state Task 8's backfill leaves every replayed row in, and the
  -- guard is what stops a backfill that runs while this trigger is live from
  -- posting the same cost twice. v_first is check 1's entry, reused as a
  -- stand-in for one the backfill wrote.
  select count(*) into v_before from public.journal_entries where shop_id = v_shop_id;
  insert into public.expenses (shop_id, location_id, occurred_on, amount_cents, category,
                               payment_method, note, created_by, journal_entry_id)
    values (v_shop_id, v_loc_id, v_on, 8823, 'utilities', 'cash', 'Already posted', v_user_id, v_first)
    returning id into v_expense_id;
  select count(*) into v_rows from public.journal_entries where shop_id = v_shop_id;
  if v_rows <> v_before then
    raise exception 'FAIL: an expense that already carried a journal entry posted % more', v_rows - v_before;
  end if;
  select journal_entry_id into v_entry from public.expenses where id = v_expense_id;
  if v_entry is distinct from v_first then
    raise exception 'FAIL: the pre-set journal_entry_id was overwritten';
  end if;
  -- And nothing was added to the entry it pointed at: 6500 still reads check
  -- 1's amount, not check 1's plus 8823.
  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l join public.accounts a on a.id = l.account_id
   where l.entry_id = v_first and a.code = '6500';
  if v_amount <> 7341 then
    raise exception 'FAIL: lines were added to an already-posted entry -- 6500 reads %, expected 7341', v_amount;
  end if;

  ---------------------------------------------------------------------------
  -- 8. A back-dated expense whose month has CLOSED posts to the open month.
  ---------------------------------------------------------------------------
  -- The expense editor has a free date field, so back-dating is not an import
  -- edge case, it is how last week's receipt is entered. open_period_for
  -- raises for any non-open period, so without the redirect a plain expense
  -- insert -- something that works today -- would start failing outright the
  -- moment a shop closed a month.
  --
  -- Two months back, so the closed period cannot be the one shop_local_date()
  -- falls in and the redirect has somewhere to send it.
  v_closed_on := (date_trunc('month', public.shop_local_date()) - interval '2 months')::date;
  insert into public.accounting_periods (shop_id, starts_on, ends_on, status)
    values (v_shop_id, v_closed_on, (v_closed_on + interval '1 month - 1 day')::date, 'closed');

  insert into public.expenses (shop_id, location_id, occurred_on, amount_cents, category, payment_method, note, created_by)
    values (v_shop_id, v_loc_id, v_closed_on + 9, 6605, 'maintenance_repairs', 'cash', 'Late receipt', v_user_id)
    returning id into v_expense_id;
  select journal_entry_id into v_entry from public.expenses where id = v_expense_id;
  if v_entry is null then
    raise exception 'FAIL: an expense back-dated into a closed month did not post';
  end if;
  select entry_date, description into v_date, v_text
    from public.journal_entries where id = v_entry;
  if v_date <> public.shop_local_date() then
    raise exception 'FAIL: an expense in a closed month should be recognised on %, got %',
      public.shop_local_date(), v_date;
  end if;
  -- The journal says why an old cost is sitting in this month. Without it the
  -- only record lives on the source row, and the journal -- the thing an
  -- auditor reads -- shows an unexplained entry.
  if v_text not like '%incurred%' then
    raise exception 'FAIL: the redated entry does not say when the cost was incurred: %', v_text;
  end if;
  -- 6600 Maintenance, not 6500 or 6400.
  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l join public.accounts a on a.id = l.account_id
   where l.entry_id = v_entry and a.code = '6600';
  if v_amount <> 6605 then
    raise exception 'FAIL: expected Dr 6600 Maintenance and repairs 6605, got %', v_amount;
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
