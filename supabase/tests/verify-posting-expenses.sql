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
--   6. NOT the same shape for a BILL, and this check asserted the opposite
--      until the final review. sync_invoice_expense mirrors every invoice into
--      expenses carrying invoice_id, and NOTHING ELSE ON THIS BRANCH POSTS WHEN
--      AN INVOICE IS INSERTED -- so that mirror row is the only place a bill's
--      cost can be recognised, and skipping it meant a rent bill posted nothing
--      while paying it posted Dr 2000. It posts Dr the category's account /
--      Cr 2000 Accounts Payable, and credits NO wallet: the mirror row's
--      payment_method is the literal 'other' sync_invoice_expense writes for a
--      bill that has none, which maps to 1010 Bank.
--  6b. The one bill that still posts nothing is an inventory_purchase one:
--      receive_stock already debited 1200 against 2000 for the goods, and
--      pairing a delivery with a bill is the app's own unpaid-delivery flow
--      rather than a double entry. 1200 is an asset, so nothing is lost from
--      the P&L -- the cost arrives as COGS when the goods sell.
--   7. An expense that already carries a journal_entry_id is left alone --
--      which is the state Task 8's backfill leaves every replayed row in.
--   8. A back-dated expense whose month has CLOSED posts to the open month
--      rather than raising. The expense editor has a free date field, so this
--      is the ordinary way last week's receipt is entered, and without the
--      redirect an insert that works today would start failing outright.
--   9. THE RESTOCK DOUBLE-POST. The Restock sheet's "also log this as an
--      inventory purchase" tick writes an expenses row AFTER receive_stock has
--      already posted Dr 1200 Inventory / Cr 2000 Accounts Payable. Built here
--      as the real pair -- receive_stock, then the row with stock_receipt_id
--      set -- and asserted as "1200 moved ONCE and 2000 nets to zero". The row
--      is not a duplicate of the delivery, it is the shop PAYING for it, so it
--      settles the payable instead of buying the goods again.
--  10. THE COUNT DOUBLE-POST. save_stock_count posts BOTH sides of a write-off
--      and no money moves, so the Count sheet's stock_loss row posts nothing at
--      all. Asserted as "5100 moved ONCE and no wallet moved by a single cent".
--  11. A STANDALONE inventory_purchase -- no receipt behind it -- still debits
--      1200 and must NOT touch 2000. Check 3 owns the 1200 half; the 2000 half
--      is asserted there too, because a trigger that took check 9's branch for
--      every inventory_purchase would leave stock never entering the books.
--  13. AND ALL FOUR generated-row links are read-only from the Expenses
--      screen, asserted against pg_policies. The two 20260908000800 added
--      arrived without the bar the other two have, so a receipt-linked row
--      could be deleted out from under its own settlement entry -- and the
--      `with check` half let a client set or clear either link on an existing
--      row, flipping what the backfill does with it after the live path had
--      already posted under the old value.
--  14. DELETING A POSTED EXPENSE REVERSES ITS ENTRY. deleteExpense is a plain
--      `.delete()` behind a live button, and expenses.journal_entry_id carries
--      no ON DELETE, so the entry outlived the row: still posted, described by a
--      uuid resolving to nothing, the cost on the P&L for ever, and no source
--      row left for the backfill to replay. Asserted as the original reading
--      `reversed`, EVERY line mirrored and negated, the same source on both
--      halves, and the affected accounts netting to zero shop-wide.
--  15. EDITING ONE REVERSES AND RE-POSTS FROM THE EDITED FIGURES. The CATEGORY
--      is changed as well as the amount, because the category decides which
--      account is debited -- a re-post that kept the old account passes any
--      amount-only check. The payment method moves too, so the credit has to
--      follow. Plus: an edit that touches only the `note` churns nothing.
--  16. DELETING AN EXPENSE THAT POSTED NOTHING IS A CLEAN NO-OP -- both the
--      count-linked row (caught by the delete-side link exclusion) and a
--      standalone row with no entry at all (caught only by the null-pointer
--      arm), because a mutation removing one is invisible to the other.
--  17. A BILL'S MIRRORED ROW CASCADING AWAY DOES **NOT** REVERSE. The
--      deliberate limit of 20260908001000: `invoice_payments` cascades off the
--      same parent carrying its own Dr 2000 entries, so reversing the cost alone
--      leaves 2000 in debit by the whole bill -- worse than doing nothing.
--  18. A REVERSAL WHOSE MONTH HAS SINCE CLOSED IS REDATED, NOT REFUSED, with the
--      original date and the period's status in the description.
--  12. A STANDALONE stock_loss debits 5100 and credits 1200 -- NOT A WALLET.
--      This is wrong today even with the double-post gone: losing stock costs
--      the shop the stock, not the till, and crediting cash balances perfectly
--      while making the drawer disagree with the ledger by the whole of the
--      shop's shrinkage and leaving 1200 holding units that are not there.
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
  -- Checks 9 and 10: the real receive_stock / save_stock_count pair.
  v_prod_id    uuid;
  v_receipt_id uuid;
  v_count_id   uuid;
  -- Shop-wide opening balances, taken immediately before each pair. Every
  -- assertion in 9 and 10 is a DELTA rather than a total, because checks 1-8
  -- have already moved 1200 (the standalone purchase) and 1000 (nearly
  -- everything) and a total would be measuring this script's whole history.
  v_was_1000   bigint;
  v_was_1010   bigint;
  v_was_1020   bigint;
  v_was_1021   bigint;
  v_was_1200   bigint;
  v_was_2000   bigint;
  v_was_5100   bigint;
  -- Checks 14-17: the reverse-on-edit / reverse-on-delete doors.
  v_bill_one   uuid;   -- check 6's rent bill, kept for check 17's cascade.
  v_noop_id    uuid;   -- check 10's count-linked row, kept for check 16.
  v_entry_two  uuid;   -- the replacement entry an edit posts.
  v_rev        uuid;
  v_status     text;
  v_was_6300   bigint;
  v_was_6700   bigint;
  v_was_6900   bigint;
  -- Check 19: a second shop the same owner manages, to move a receipt into.
  v_shop_two   uuid;
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
  -- CHECK 11: and it does NOT touch 2000 Accounts Payable. This row has no
  -- receipt behind it -- nobody recorded a delivery, so no payable was ever
  -- raised and there is nothing to settle. A trigger that took check 9's
  -- receipt branch for EVERY inventory_purchase would debit 2000 here, drive a
  -- liability the shop does not have into a debit balance, and leave stock
  -- never entering the books at all. The `1200` assertion above catches that
  -- too; this names it, because the two branches are one `if` apart and this is
  -- the message that says which side of it went wrong.
  if exists (select 1 from public.journal_lines l join public.accounts a on a.id = l.account_id
              where l.entry_id = v_entry and a.code = '2000') then
    raise exception 'FAIL: a standalone stock purchase touched 2000 Accounts Payable -- it settled a payable no delivery ever raised';
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
  -- 6. A BILL-DERIVED EXPENSE ROW IS WHERE THE BILL'S COST IS RECOGNISED.
  ---------------------------------------------------------------------------
  -- THIS CHECK USED TO ASSERT THE OPPOSITE, and it was wrong. It said "a bill
  -- posts nothing, because the cost is recognised by the bill" -- and no
  -- migration on this branch posts anything when an `invoices` row is inserted.
  -- sync_invoice_expense (20260804000300) mirrors the bill into `expenses`
  -- carrying invoice_id, and THAT MIRROR ROW was the row being skipped. So a
  -- 61437 rent bill posted nothing at all, record_invoice_payment then posted
  -- Dr 2000 / Cr the wallet when it was paid, Accounts Payable read MINUS 61437
  -- and the P&L showed no rent. Every entry balanced. The trial balance zeroed.
  -- Every assertion in this file passed.
  --
  -- The bill now posts Dr the category's account / Cr 2000 Accounts Payable --
  -- the exact mirror of check 9's receipt-linked row (Dr 2000 / Cr the wallet)
  -- and the thing record_invoice_payment's Dr 2000 exists to clear.
  -- verify-posting-bills.sql check 11 is the one that closes the loop, by
  -- entering a bill and PAYING it and asserting 2000 lands back at zero.
  --
  -- 'rent' -> 6000, which nothing else in this script touches.
  select count(*) into v_before from public.journal_entries where shop_id = v_shop_id;
  v_on := public.shop_local_date() - 5;
  insert into public.invoices (shop_id, location_id, vendor_name, invoice_number,
                               category, issued_on, due_on, amount_cents)
    values (v_shop_id, v_loc_id, 'Expenses Vendor', 'EXP-1', 'rent',
            v_on, public.shop_local_date() + 10, 61437)
    returning id into v_invoice_id;
  -- Kept for check 17, which deletes this bill and reads what the cascade did
  -- to the entry its mirrored expense row posted. v_invoice_id is reused by 6b.
  v_bill_one := v_invoice_id;

  select count(*) into v_rows from public.journal_entries where shop_id = v_shop_id;
  if v_rows - v_before <> 1 then
    raise exception 'FAIL: recording a bill wrote % journal entries, expected exactly 1 (0 = the cost of the bill reaches no account at all)', v_rows - v_before;
  end if;
  select journal_entry_id into v_entry from public.expenses where invoice_id = v_invoice_id;
  if v_entry is null then
    raise exception 'FAIL: the bill''s mirrored expense row did not post -- nothing else posts for a bill, so its cost is nowhere in the books';
  end if;

  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l join public.accounts a on a.id = l.account_id
   where l.entry_id = v_entry and a.code = '6000';
  if v_amount <> 61437 then
    raise exception 'FAIL: expected Dr 6000 Rent 61437 when the bill was entered, got %', v_amount;
  end if;
  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l join public.accounts a on a.id = l.account_id
   where l.entry_id = v_entry and a.code = '2000';
  if v_amount <> -61437 then
    raise exception 'FAIL: expected Cr 2000 Accounts Payable -61437 for an unpaid bill, got % -- a payment has nothing to settle without it', v_amount;
  end if;

  -- AND NO WALLET AT ALL. This is the assertion that separates a correct
  -- implementation from the obvious wrong one rather than from doing nothing:
  -- sync_invoice_expense writes the literal 'other' into payment_method because
  -- a bill HAS no payment method, and 'other' maps to 1010 Bank. A trigger that
  -- fell through to the generic branch would credit 1010 for a bill nobody has
  -- paid -- the shop's bank balance down by every unpaid bill it holds, with
  -- the entry balancing and 6000 reading correctly above.
  if exists (select 1 from public.journal_lines l join public.accounts a on a.id = l.account_id
              where l.entry_id = v_entry and a.code in ('1000', '1010', '1020', '1021')) then
    raise exception 'FAIL: entering a bill credited a wallet -- no money has moved yet, and 1010 Bank is where payment_method ''other'' lands';
  end if;

  -- issued_on, not today: a bill dated last month is last month's cost.
  select source, entry_date into v_text, v_date from public.journal_entries where id = v_entry;
  if v_text <> 'bill' then
    raise exception 'FAIL: expected source ''bill'' for a bill, got %', v_text;
  end if;
  if v_date <> v_on then
    raise exception 'FAIL: the bill''s entry should be dated % (issued_on), got %', v_on, v_date;
  end if;

  ---------------------------------------------------------------------------
  -- 6b. AN inventory_purchase BILL IS THE ONE THAT POSTS NOTHING.
  ---------------------------------------------------------------------------
  -- The map sends 'inventory_purchase' to 1200 Inventory, and 1200 is exactly
  -- what receive_stock already debits (against Cr 2000) when the delivery
  -- lands. And that pairing is not a mistake a shop should have avoided: it is
  -- the app's ONLY unpaid-delivery flow, because record_invoice_payment is the
  -- one door that draws receive_stock's payable back down and it needs a bill.
  -- So a bill for goods adds nothing -- posting it would put the delivery into
  -- 1200 twice and raise a second payable beside the real one, with the entry
  -- balancing and the trial balance still at zero.
  --
  -- Nothing is lost from the P&L: 1200 is an asset, and its cost reaches the
  -- P&L as COGS when the goods sell. That is the whole difference between this
  -- row and check 6's rent, which has no other door at all.
  select count(*) into v_before from public.journal_entries where shop_id = v_shop_id;
  insert into public.invoices (shop_id, location_id, vendor_name, invoice_number,
                               category, issued_on, due_on, amount_cents)
    values (v_shop_id, v_loc_id, 'Expenses Vendor', 'EXP-2', 'inventory_purchase',
            public.shop_local_date() - 5, public.shop_local_date() + 10, 47119)
    returning id into v_invoice_id;
  select count(*) into v_rows from public.journal_entries where shop_id = v_shop_id;
  if v_rows <> v_before then
    raise exception 'FAIL: a bill for goods wrote % journal entries -- receive_stock already put the delivery into 1200 against 2000', v_rows - v_before;
  end if;
  select journal_entry_id into v_entry from public.expenses where invoice_id = v_invoice_id;
  if v_entry is not null then
    raise exception 'FAIL: an inventory_purchase bill carries a journal entry of its own -- the goods would be recognised twice';
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

  ---------------------------------------------------------------------------
  -- 9. THE RESTOCK DOUBLE-POST. A delivery and the expense that PAID for it.
  ---------------------------------------------------------------------------
  -- stock-restock-modal.tsx calls receiveStock and then, if the tick is on,
  -- createExpense('inventory_purchase'). receive_stock has already posted
  -- Dr 1200 Inventory / Cr 2000 Accounts Payable for these goods. Before
  -- 20260908000800 the trigger then posted Dr 1200 / Cr 1000 for the SAME
  -- goods: inventory recognised twice, and a payable invented against a
  -- supplier who was handed cash on the doorstep. Both entries balance, the
  -- trial balance still zeroes, and nothing anywhere goes red -- which is why
  -- this check has to be built as the REAL PAIR rather than as an assertion
  -- about one expense row in isolation.
  --
  -- The expense is not a duplicate of the delivery. The receipt says goods
  -- ARRIVED (and deliberately says nothing about payment -- see
  -- 20260908000400's "Payable, not cash"); the expense says the shop PAID. So
  -- the honest entry is Dr 2000 / Cr the wallet, settling what the receipt
  -- raised, exactly as record_invoice_payment does for a bill.
  --
  -- 30 at 431 = 12930. 431 is prime and 12930 is reached by no other pair of
  -- figures in this script, so a doubled 1200 (25860) cannot be mistaken for
  -- anything else.
  insert into public.products (shop_id, name, price_cents, cost_cents, stock)
    values (v_shop_id, 'Restock Rice', 9000, null, 0) returning id into v_prod_id;

  select coalesce(sum(l.amount_cents), 0) into v_was_1200
    from public.journal_lines l join public.accounts a on a.id = l.account_id
    join public.journal_entries e on e.id = l.entry_id
   where e.shop_id = v_shop_id and a.code = '1200';
  select coalesce(sum(l.amount_cents), 0) into v_was_2000
    from public.journal_lines l join public.accounts a on a.id = l.account_id
    join public.journal_entries e on e.id = l.entry_id
   where e.shop_id = v_shop_id and a.code = '2000';
  select coalesce(sum(l.amount_cents), 0) into v_was_1000
    from public.journal_lines l join public.accounts a on a.id = l.account_id
    join public.journal_entries e on e.id = l.entry_id
   where e.shop_id = v_shop_id and a.code = '1000';

  v_receipt_id := public.receive_stock(v_shop_id, v_loc_id, jsonb_build_array(
    jsonb_build_object('product_id', v_prod_id, 'quantity', 30, 'unit_cost_cents', 431)));

  -- THE LINK IS THE WHOLE FIX. Without stock_receipt_id this row takes the
  -- standalone path and debits 1200 a second time.
  insert into public.expenses (shop_id, location_id, occurred_on, amount_cents, category,
                               payment_method, note, created_by, stock_receipt_id)
    values (v_shop_id, v_loc_id, public.shop_local_date(), 12930, 'inventory_purchase', 'cash',
            'Paid on delivery', v_user_id, v_receipt_id)
    returning id into v_expense_id;

  select journal_entry_id into v_entry from public.expenses where id = v_expense_id;
  if v_entry is null then
    raise exception 'FAIL: the delivery''s inventory_purchase expense did not post -- the cash that left the till is nowhere in the ledger';
  end if;

  -- 1200 MOVED EXACTLY ONCE. Measured shop-wide across BOTH entries, which is
  -- the only way the double is visible: each entry balances on its own and a
  -- per-entry assertion would pass with the duplicate sitting beside it.
  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l join public.accounts a on a.id = l.account_id
    join public.journal_entries e on e.id = l.entry_id
   where e.shop_id = v_shop_id and a.code = '1200';
  if v_amount - v_was_1200 <> 12930 then
    raise exception 'FAIL: 1200 Inventory moved % across the delivery and its expense, expected 12930 (25860 = the goods were recognised twice)',
      v_amount - v_was_1200;
  end if;

  -- AND 2000 NETS TO ZERO. The receipt credited it 12930; the expense debits
  -- the same 12930 back down, because the delivery was paid in full. A shop
  -- that pays cash on delivery must not accumulate a payable that grows for
  -- ever.
  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l join public.accounts a on a.id = l.account_id
    join public.journal_entries e on e.id = l.entry_id
   where e.shop_id = v_shop_id and a.code = '2000';
  if v_amount - v_was_2000 <> 0 then
    raise exception 'FAIL: 2000 Accounts Payable moved % across a delivery paid in full, expected 0 (-12930 = the payable was raised and never settled)',
      v_amount - v_was_2000;
  end if;

  -- The cash really did leave.
  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l join public.accounts a on a.id = l.account_id
    join public.journal_entries e on e.id = l.entry_id
   where e.shop_id = v_shop_id and a.code = '1000';
  if v_amount - v_was_1000 <> -12930 then
    raise exception 'FAIL: 1000 Cash moved % paying for a 12930 delivery, expected -12930', v_amount - v_was_1000;
  end if;

  -- And the expense's OWN entry names 2000, not 1200. Asserted separately from
  -- the shop-wide delta because a pair of compensating lines -- Dr 1200 12930
  -- and Cr 1200 12930 on this entry -- would leave the delta at 12930 and be
  -- exactly the kind of thing a totals check cannot see.
  if exists (select 1 from public.journal_lines l join public.accounts a on a.id = l.account_id
              where l.entry_id = v_entry and a.code = '1200') then
    raise exception 'FAIL: the delivery''s payment touched 1200 Inventory -- it should settle 2000 Accounts Payable, not buy the goods again';
  end if;

  ---------------------------------------------------------------------------
  -- 10. THE COUNT DOUBLE-POST. A stock-take and its stock_loss expense.
  ---------------------------------------------------------------------------
  -- stock-count-modal.tsx calls saveStockCount and then, if the tick is on,
  -- createExpense('stock_loss'). save_stock_count has already posted
  -- Dr 5100 Inventory Shrinkage / Cr 1200 Inventory for the whole variance.
  -- Before 20260908000800 the trigger then posted Dr 5100 / Cr 1000: shrinkage
  -- doubled, and a till that never opened was credited for stock nobody sold.
  --
  -- Unlike check 9 this row IS a duplicate. Nothing was paid for; there is no
  -- second half of the event left to record. So it posts NOTHING, and the row
  -- stays in `expenses` for the Expenses screen and the expense reports, which
  -- read that table and not the ledger.
  --
  -- Check 9 left 30 units at a cost of 431 (nothing else in this shop has
  -- stock). Counting 18 is 12 short: 12 x 431 = 5172, and again no other figure
  -- in this script is near it, so a doubled 5100 (10344) is unmistakable.
  select coalesce(sum(l.amount_cents), 0) into v_was_5100
    from public.journal_lines l join public.accounts a on a.id = l.account_id
    join public.journal_entries e on e.id = l.entry_id
   where e.shop_id = v_shop_id and a.code = '5100';
  select coalesce(sum(l.amount_cents), 0) into v_was_1000
    from public.journal_lines l join public.accounts a on a.id = l.account_id
    join public.journal_entries e on e.id = l.entry_id
   where e.shop_id = v_shop_id and a.code = '1000';
  select coalesce(sum(l.amount_cents), 0) into v_was_1010
    from public.journal_lines l join public.accounts a on a.id = l.account_id
    join public.journal_entries e on e.id = l.entry_id
   where e.shop_id = v_shop_id and a.code = '1010';
  select coalesce(sum(l.amount_cents), 0) into v_was_1020
    from public.journal_lines l join public.accounts a on a.id = l.account_id
    join public.journal_entries e on e.id = l.entry_id
   where e.shop_id = v_shop_id and a.code = '1020';
  select coalesce(sum(l.amount_cents), 0) into v_was_1021
    from public.journal_lines l join public.accounts a on a.id = l.account_id
    join public.journal_entries e on e.id = l.entry_id
   where e.shop_id = v_shop_id and a.code = '1021';
  select count(*) into v_before from public.journal_entries where shop_id = v_shop_id;

  v_count_id := public.save_stock_count(v_shop_id, v_loc_id, jsonb_build_array(
    jsonb_build_object('product_id', v_prod_id, 'counted_quantity', 18, 'reason', 'theft_or_loss')));

  insert into public.expenses (shop_id, location_id, occurred_on, amount_cents, category,
                               payment_method, note, created_by, stock_count_id)
    values (v_shop_id, v_loc_id, public.shop_local_date(), 5172, 'stock_loss', 'cash',
            'Stock-take', v_user_id, v_count_id)
    returning id into v_expense_id;
  -- Kept for check 16: this is the row that posted NOTHING, and deleting it has
  -- to be a clean no-op rather than an error.
  v_noop_id := v_expense_id;

  -- ONE new entry, the count's. Not two.
  select count(*) into v_rows from public.journal_entries where shop_id = v_shop_id;
  if v_rows - v_before <> 1 then
    raise exception 'FAIL: a stock-take and its stock_loss expense wrote % entries, expected 1 (the count''s) -- the expense posted a second one',
      v_rows - v_before;
  end if;
  select journal_entry_id into v_entry from public.expenses where id = v_expense_id;
  if v_entry is not null then
    raise exception 'FAIL: the count''s stock_loss expense carries a journal entry of its own -- save_stock_count already posted both sides';
  end if;

  -- 5100 MOVED EXACTLY ONCE.
  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l join public.accounts a on a.id = l.account_id
    join public.journal_entries e on e.id = l.entry_id
   where e.shop_id = v_shop_id and a.code = '5100';
  if v_amount - v_was_5100 <> 5172 then
    raise exception 'FAIL: 5100 Inventory Shrinkage moved % across the count and its expense, expected 5172 (10344 = the loss was recognised twice)',
      v_amount - v_was_5100;
  end if;

  -- AND NO CASH ACCOUNT MOVED AT ALL. All four wallets, one at a time: nothing
  -- was bought, nothing was paid, and a stock-take that debits a drawer is the
  -- half of this defect a shrinkage total would never show. The four are
  -- checked separately because the trigger credits the account the row's
  -- payment_method maps to, and 'cash' is only the default -- a shop that left
  -- the picker on zaad would drain 1020 instead and a single 1000 assertion
  -- would pass.
  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l join public.accounts a on a.id = l.account_id
    join public.journal_entries e on e.id = l.entry_id
   where e.shop_id = v_shop_id and a.code = '1000';
  if v_amount <> v_was_1000 then
    raise exception 'FAIL: 1000 Cash moved % on a stock-take, expected 0 -- the till was credited for stock nobody sold', v_amount - v_was_1000;
  end if;
  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l join public.accounts a on a.id = l.account_id
    join public.journal_entries e on e.id = l.entry_id
   where e.shop_id = v_shop_id and a.code = '1010';
  if v_amount <> v_was_1010 then
    raise exception 'FAIL: 1010 Bank moved % on a stock-take, expected 0', v_amount - v_was_1010;
  end if;
  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l join public.accounts a on a.id = l.account_id
    join public.journal_entries e on e.id = l.entry_id
   where e.shop_id = v_shop_id and a.code = '1020';
  if v_amount <> v_was_1020 then
    raise exception 'FAIL: 1020 Zaad moved % on a stock-take, expected 0', v_amount - v_was_1020;
  end if;
  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l join public.accounts a on a.id = l.account_id
    join public.journal_entries e on e.id = l.entry_id
   where e.shop_id = v_shop_id and a.code = '1021';
  if v_amount <> v_was_1021 then
    raise exception 'FAIL: 1021 eDahab moved % on a stock-take, expected 0', v_amount - v_was_1021;
  end if;

  ---------------------------------------------------------------------------
  -- 12. A STANDALONE stock_loss debits 5100 and credits 1200. NOT A WALLET.
  ---------------------------------------------------------------------------
  -- Someone types a write-off straight into the Expenses screen with no count
  -- behind it -- a crate dropped, a fridge that failed overnight. Nothing else
  -- posts for it, so this row must, and it has to come out of INVENTORY:
  -- losing stock costs the shop the stock, not the till. Crediting a wallet
  -- balances perfectly, ties every P&L total, and leaves the drawer disagreeing
  -- with the ledger by the whole of the shop's shrinkage while 1200 goes on
  -- carrying units that are not on the shelf.
  --
  -- payment_method 'cash' deliberately: it is the column's default and the only
  -- honest value in a field that does not apply here, so a trigger that reaches
  -- for the wallet map has something to reach for. It must not.
  select coalesce(sum(l.amount_cents), 0) into v_was_1200
    from public.journal_lines l join public.accounts a on a.id = l.account_id
    join public.journal_entries e on e.id = l.entry_id
   where e.shop_id = v_shop_id and a.code = '1200';

  insert into public.expenses (shop_id, location_id, occurred_on, amount_cents, category,
                               payment_method, note, created_by)
    values (v_shop_id, v_loc_id, public.shop_local_date(), 3777, 'stock_loss', 'cash',
            'Crate dropped', v_user_id)
    returning id into v_expense_id;
  select journal_entry_id into v_entry from public.expenses where id = v_expense_id;
  if v_entry is null then
    raise exception 'FAIL: a standalone stock_loss did not post -- nothing else posts for it, so the loss is nowhere in the books';
  end if;

  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l join public.accounts a on a.id = l.account_id
   where l.entry_id = v_entry and a.code = '5100';
  if v_amount <> 3777 then
    raise exception 'FAIL: expected Dr 5100 Inventory Shrinkage 3777, got %', v_amount;
  end if;
  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l join public.accounts a on a.id = l.account_id
   where l.entry_id = v_entry and a.code = '1200';
  if v_amount <> -3777 then
    raise exception 'FAIL: expected Cr 1200 Inventory -3777 on a standalone stock_loss, got % -- a write-down comes out of stock, not out of a wallet', v_amount;
  end if;
  -- And no wallet at all. Named by TYPE-free code list rather than by 1000
  -- alone, for the reason check 10 gives: 'cash' is only the default.
  if exists (select 1 from public.journal_lines l join public.accounts a on a.id = l.account_id
              where l.entry_id = v_entry and a.code in ('1000', '1010', '1020', '1021')) then
    raise exception 'FAIL: a standalone stock_loss credited a wallet -- the shop did not pay anyone for stock that walked out';
  end if;
  -- The whole shop still zeroes, after everything checks 9-12 added.
  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l join public.journal_entries e on e.id = l.entry_id
   where e.shop_id = v_shop_id;
  if v_amount <> 0 then
    raise exception 'FAIL: the trial balance does not zero, off by %', v_amount;
  end if;

  ---------------------------------------------------------------------------
  -- 13. A GENERATED EXPENSE ROW IS READ-ONLY FROM THE EXPENSES SCREEN --
  --     ALL FOUR LINKS, NOT JUST THE TWO THAT HAD THE BAR.
  ---------------------------------------------------------------------------
  -- 20260804000300 and 20260804000400 made invoice- and payroll-linked rows
  -- read-only because "the total and its source drift apart" otherwise. The two
  -- link columns 20260908000800 added arrived without that bar, and the gap is
  -- not cosmetic:
  --
  --   * DELETING a receipt-linked row from the Expenses screen removes the
  --     source of a Dr 2000 / Cr wallet settlement and leaves the entry
  --     standing over nothing. The backfill can never repair it -- there is no
  --     row left to replay.
  --   * The `with check` half is sharper. Without it a client can SET or CLEAR
  --     either link on an existing row: clearing stock_receipt_id turns a
  --     settlement into a standalone purchase and the replay debits 1200 for
  --     goods already on the books; setting stock_count_id on a hand-typed
  --     write-off makes the replay skip it entirely. The live posting already
  --     happened under the OLD value, so only the replay moves -- and the two
  --     paths agreeing is the one property this whole phase turns on.
  --
  -- ASSERTED AGAINST pg_policies, never by attempting the operation: this
  -- script runs as the postgres superuser and RLS does not apply to it, so a
  -- DELETE here would succeed however the policies are written and the check
  -- would be reporting on nothing. Same trap verify-ledger.sql documents.
  --
  -- Both halves of the UPDATE policy are read. `qual` alone passes a policy that
  -- refuses to update a LINKED row while happily letting a client attach a link
  -- to an unlinked one, which is the direction that flips what the backfill does.
  for v_text in
    select unnest(array['invoice_id', 'payroll_run_id', 'stock_receipt_id', 'stock_count_id'])
  loop
    if not exists (
      select 1 from pg_policies
       where schemaname = 'public' and tablename = 'expenses' and policyname = 'update expenses'
         and qual like '%' || v_text || ' IS NULL%'
         and with_check like '%' || v_text || ' IS NULL%'
    ) then
      raise exception 'FAIL: the "update expenses" policy does not bar % on both halves -- a generated row can be edited, or a link set or cleared on an existing one', v_text;
    end if;
    if not exists (
      select 1 from pg_policies
       where schemaname = 'public' and tablename = 'expenses' and policyname = 'delete expenses'
         and qual like '%' || v_text || ' IS NULL%'
    ) then
      raise exception 'FAIL: the "delete expenses" policy does not bar % -- deleting the row leaves its journal entry standing over nothing', v_text;
    end if;
  end loop;

  ---------------------------------------------------------------------------
  -- 14. DELETING A POSTED EXPENSE REVERSES ITS ENTRY.
  ---------------------------------------------------------------------------
  -- deleteExpense (src/lib/expenses.ts:125) is a plain `.delete()` behind a live
  -- button on the Expenses screen. expenses.journal_entry_id carries no
  -- ON DELETE -- 20260908000100 protects the ENTRY deliberately -- so before
  -- 20260908001000 the entry outlived the row: still `status = 'posted'`,
  -- described by a uuid that resolved to nothing, with the cost on the P&L for
  -- ever and no source row left for the backfill to replay.
  --
  -- 'fees_charges' -> 6700, which nothing else in this script touches, so the
  -- account can be read as well as the amount. 9137 is prime and is reached by
  -- no other figure or pair of figures here.
  --
  -- MUTATION (proves this check): make reverse_expense_entry() `return null`
  -- immediately on DELETE. Expected: FAIL: deleting a posted expense left its
  -- entry posted.
  select coalesce(sum(l.amount_cents), 0) into v_was_6700
    from public.journal_lines l join public.accounts a on a.id = l.account_id
    join public.journal_entries e on e.id = l.entry_id
   where e.shop_id = v_shop_id and a.code = '6700';
  select coalesce(sum(l.amount_cents), 0) into v_was_1000
    from public.journal_lines l join public.accounts a on a.id = l.account_id
    join public.journal_entries e on e.id = l.entry_id
   where e.shop_id = v_shop_id and a.code = '1000';

  insert into public.expenses (shop_id, location_id, occurred_on, amount_cents, category,
                               payment_method, note, created_by)
    values (v_shop_id, v_loc_id, public.shop_local_date(), 9137, 'fees_charges', 'cash',
            'Bank charge', v_user_id)
    returning id into v_expense_id;
  select journal_entry_id into v_entry from public.expenses where id = v_expense_id;
  if v_entry is null then
    raise exception 'FAIL: the fees_charges expense did not post -- check 14 has nothing to reverse';
  end if;

  delete from public.expenses where id = v_expense_id;

  -- The original is marked, not deleted: a book is added to, not amended.
  select status into v_status from public.journal_entries where id = v_entry;
  if v_status is null then
    raise exception 'FAIL: deleting an expense deleted its journal entry -- a posted entry is a permanent record';
  end if;
  if v_status <> 'reversed' then
    raise exception 'FAIL: deleting a posted expense left its entry %, expected reversed -- 6700 now carries a cost with no source row to explain it', v_status;
  end if;

  select id into v_rev from public.journal_entries
   where shop_id = v_shop_id and reverses_entry_id = v_entry and status = 'posted';
  if v_rev is null then
    raise exception 'FAIL: no reversal entry points at the deleted expense''s entry';
  end if;

  -- EVERY line mirrored, not merely a balancing pair. A "reversal" that posted
  -- one line for the total against a suspense account would net the two
  -- assertions below to zero and be invisible to them.
  select count(*) into v_rows
    from public.journal_lines o
   where o.entry_id = v_entry
     and not exists (select 1 from public.journal_lines r
                      where r.entry_id = v_rev
                        and r.account_id = o.account_id
                        and r.amount_cents = -o.amount_cents);
  if v_rows <> 0 then
    raise exception 'FAIL: % line(s) of the deleted expense''s entry have no negated twin on the reversal', v_rows;
  end if;
  select count(*) into v_rows from public.journal_lines where entry_id = v_rev;
  select count(*) - v_rows into v_rows from public.journal_lines where entry_id = v_entry;
  if v_rows <> 0 then
    raise exception 'FAIL: the reversal has a different number of lines from the entry it mirrors (off by %)', v_rows;
  end if;

  -- A reversal carries the SAME SOURCE as the entry it reverses -- the
  -- convention pinned phase-wide. 'bill' here, read off the original.
  select source into v_text from public.journal_entries where id = v_rev;
  select source into v_status from public.journal_entries where id = v_entry;
  if v_text is distinct from v_status then
    raise exception 'FAIL: the reversal is filed under % but reverses an entry that is % -- a report grouping by source shows one half of the pair', v_text, v_status;
  end if;

  -- AND THE ACCOUNTS NET TO ZERO. Measured shop-wide, which is the only view a
  -- reversal that copied the lines WITHOUT negating them is visible in: it
  -- balances on its own and every per-entry assertion above would still pass.
  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l join public.accounts a on a.id = l.account_id
    join public.journal_entries e on e.id = l.entry_id
   where e.shop_id = v_shop_id and a.code = '6700';
  if v_amount - v_was_6700 <> 0 then
    raise exception 'FAIL: 6700 Fees and charges reads % after the expense was deleted, expected the % it started at (9137 = the cost is still on the P&L; 18274 = the reversal did not negate its lines)',
      v_amount, v_was_6700;
  end if;
  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l join public.accounts a on a.id = l.account_id
    join public.journal_entries e on e.id = l.entry_id
   where e.shop_id = v_shop_id and a.code = '1000';
  if v_amount - v_was_1000 <> 0 then
    raise exception 'FAIL: 1000 Cash moved % across an expense that was posted and then deleted, expected 0', v_amount - v_was_1000;
  end if;
  if exists (select 1 from public.expenses where id = v_expense_id) then
    raise exception 'FAIL: the expense row survived its own delete';
  end if;
  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l join public.journal_entries e on e.id = l.entry_id
   where e.shop_id = v_shop_id;
  if v_amount <> 0 then
    raise exception 'FAIL: the trial balance does not zero after a reversal, off by %', v_amount;
  end if;

  ---------------------------------------------------------------------------
  -- 15. EDITING A POSTED EXPENSE REVERSES AND RE-POSTS FROM THE EDITED FIGURES.
  ---------------------------------------------------------------------------
  -- updateExpense (src/lib/expenses.ts:116) is a plain `.update()`. A posted
  -- entry is immutable (refuse_posted_entry_edit), so from the moment posting
  -- shipped EVERY expense edit left the ledger reading the pre-edit figures with
  -- nothing anywhere saying so.
  --
  -- THE CATEGORY IS CHANGED AS WELL AS THE AMOUNT, and that is the point: the
  -- category decides WHICH ACCOUNT is debited, so a re-post that kept the old
  -- account -- or an "edit" that merely rewrote the amount on the old entry --
  -- fails here and passes an amount-only check. 'marketing' is 6300 and 'other'
  -- is 6900; the payment method moves cash -> zaad so the CREDIT has to follow
  -- as well. Nothing else in this script touches 6300 or 6900.
  --
  -- MUTATION (proves this check): drop `new.journal_entry_id := null` from
  -- reverse_expense_entry()'s UPDATE arm. Expected: FAIL: editing an expense
  -- did not re-post -- the row still points at the entry that was just reversed.
  select coalesce(sum(l.amount_cents), 0) into v_was_6300
    from public.journal_lines l join public.accounts a on a.id = l.account_id
    join public.journal_entries e on e.id = l.entry_id
   where e.shop_id = v_shop_id and a.code = '6300';
  select coalesce(sum(l.amount_cents), 0) into v_was_6900
    from public.journal_lines l join public.accounts a on a.id = l.account_id
    join public.journal_entries e on e.id = l.entry_id
   where e.shop_id = v_shop_id and a.code = '6900';
  select coalesce(sum(l.amount_cents), 0) into v_was_1000
    from public.journal_lines l join public.accounts a on a.id = l.account_id
    join public.journal_entries e on e.id = l.entry_id
   where e.shop_id = v_shop_id and a.code = '1000';
  select coalesce(sum(l.amount_cents), 0) into v_was_1020
    from public.journal_lines l join public.accounts a on a.id = l.account_id
    join public.journal_entries e on e.id = l.entry_id
   where e.shop_id = v_shop_id and a.code = '1020';

  insert into public.expenses (shop_id, location_id, occurred_on, amount_cents, category,
                               payment_method, note, created_by)
    values (v_shop_id, v_loc_id, public.shop_local_date(), 21400, 'marketing', 'cash',
            'Radio advert', v_user_id)
    returning id into v_expense_id;
  select journal_entry_id into v_entry from public.expenses where id = v_expense_id;
  if v_entry is null then
    raise exception 'FAIL: the marketing expense did not post -- check 15 has nothing to edit';
  end if;

  update public.expenses
     set amount_cents = 5062, category = 'other', payment_method = 'zaad',
         note = 'Actually a bank transfer', updated_at = now()
   where id = v_expense_id;

  select journal_entry_id into v_entry_two from public.expenses where id = v_expense_id;
  if v_entry_two is null then
    raise exception 'FAIL: editing an expense left the row with no journal entry at all -- the cost vanished from the books while the receipt is still on the Expenses screen';
  end if;
  if v_entry_two = v_entry then
    raise exception 'FAIL: editing an expense did not re-post -- the row still points at the entry that was just reversed';
  end if;
  select status into v_status from public.journal_entries where id = v_entry;
  if v_status <> 'reversed' then
    raise exception 'FAIL: editing a posted expense left its original entry %, expected reversed', v_status;
  end if;

  -- THE REPLACEMENT READS THE EDITED FIGURES, on the edited ACCOUNTS.
  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l join public.accounts a on a.id = l.account_id
   where l.entry_id = v_entry_two and a.code = '6900';
  if v_amount <> 5062 then
    raise exception 'FAIL: expected the replacement to debit 6900 Other 5062, got % (21400 = it re-posted the pre-edit amount)', v_amount;
  end if;
  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l join public.accounts a on a.id = l.account_id
   where l.entry_id = v_entry_two and a.code = '1020';
  if v_amount <> -5062 then
    raise exception 'FAIL: expected the replacement to credit 1020 Zaad -5062, got % -- the edited payment method did not reach the ledger', v_amount;
  end if;
  if exists (select 1 from public.journal_lines l join public.accounts a on a.id = l.account_id
              where l.entry_id = v_entry_two and a.code in ('6300', '1000')) then
    raise exception 'FAIL: the replacement still names the PRE-EDIT account -- the re-post did not go through the category and payment-method maps again';
  end if;

  -- Shop-wide: the old pair nets to nothing and only the new pair survives. This
  -- is the view a reversal that fired without a re-post (or a re-post without a
  -- reversal) is visible in.
  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l join public.accounts a on a.id = l.account_id
    join public.journal_entries e on e.id = l.entry_id
   where e.shop_id = v_shop_id and a.code = '6300';
  if v_amount - v_was_6300 <> 0 then
    raise exception 'FAIL: 6300 Marketing moved % across an expense that was re-categorised away from it, expected 0', v_amount - v_was_6300;
  end if;
  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l join public.accounts a on a.id = l.account_id
    join public.journal_entries e on e.id = l.entry_id
   where e.shop_id = v_shop_id and a.code = '6900';
  if v_amount - v_was_6900 <> 5062 then
    raise exception 'FAIL: 6900 Other moved % across the edit, expected the edited 5062', v_amount - v_was_6900;
  end if;
  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l join public.accounts a on a.id = l.account_id
    join public.journal_entries e on e.id = l.entry_id
   where e.shop_id = v_shop_id and a.code = '1000';
  if v_amount - v_was_1000 <> 0 then
    raise exception 'FAIL: 1000 Cash moved % across an expense whose payment method was edited to zaad, expected 0', v_amount - v_was_1000;
  end if;
  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l join public.accounts a on a.id = l.account_id
    join public.journal_entries e on e.id = l.entry_id
   where e.shop_id = v_shop_id and a.code = '1020';
  if v_amount - v_was_1020 <> -5062 then
    raise exception 'FAIL: 1020 Zaad moved % across the edit, expected -5062', v_amount - v_was_1020;
  end if;

  -- AND AN EDIT THAT CHANGES NOTHING THE ENTRY IS MADE OF CHURNS NOTHING.
  -- `note` reaches no journal line, so retyping one must not push a reversal and
  -- a replacement through the ledger for every typo. This is also the half that
  -- keeps post_expense_to_ledger's own `update ... set journal_entry_id` from
  -- re-entering the pair for ever.
  select count(*) into v_before from public.journal_entries where shop_id = v_shop_id;
  update public.expenses set note = 'Retyped', updated_at = now() where id = v_expense_id;
  select count(*) into v_rows from public.journal_entries where shop_id = v_shop_id;
  if v_rows <> v_before then
    raise exception 'FAIL: retyping an expense''s note wrote % journal entries, expected 0', v_rows - v_before;
  end if;
  if (select journal_entry_id from public.expenses where id = v_expense_id) is distinct from v_entry_two then
    raise exception 'FAIL: retyping an expense''s note repointed it at a different journal entry';
  end if;

  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l join public.journal_entries e on e.id = l.entry_id
   where e.shop_id = v_shop_id;
  if v_amount <> 0 then
    raise exception 'FAIL: the trial balance does not zero after an edit, off by %', v_amount;
  end if;

  ---------------------------------------------------------------------------
  -- 16. DELETING AN EXPENSE THAT POSTED NOTHING IS A CLEAN NO-OP.
  ---------------------------------------------------------------------------
  -- Check 10's row: linked to a stock-take, journal_entry_id NULL, because
  -- save_stock_count already posted both sides. The same shape covers a
  -- payroll-linked row, an inventory_purchase bill and any expense entered
  -- before 20260908000750 shipped and not yet backfilled. Reversing nothing is
  -- not an error -- and it must not be, or a shop tidying up its Expenses screen
  -- meets a ledger error on a row the ledger never heard of.
  --
  -- TWO ROWS, because they take DIFFERENT arms of the same function and a
  -- mutation that removes one is invisible to the other:
  --
  --   16a the count-linked row, which the DELETE link exclusion (check 17)
  --       catches before the null-pointer arm is ever reached;
  --   16b a STANDALONE row with no entry, which ONLY the null-pointer arm
  --       catches. This is the pre-20260908000750 expense the backfill has not
  --       reached yet, and it is the load-bearing half.
  --
  -- MUTATION (proves 16b): remove the `old.journal_entry_id is null` arm from
  -- reverse_expense_entry(). Expected: ERROR: the journal entry for this expense
  -- is missing, so it cannot be reversed. The same mutation leaves 16a green,
  -- which is why 16b exists.
  select count(*) into v_before from public.journal_entries where shop_id = v_shop_id;
  if (select journal_entry_id from public.expenses where id = v_noop_id) is not null then
    raise exception 'FAIL: check 16a''s fixture row carries an entry -- it is not testing the no-op path';
  end if;
  delete from public.expenses where id = v_noop_id;
  select count(*) into v_rows from public.journal_entries where shop_id = v_shop_id;
  if v_rows <> v_before then
    raise exception 'FAIL: deleting a count-linked expense wrote % journal entries', v_rows - v_before;
  end if;
  if exists (select 1 from public.expenses where id = v_noop_id) then
    raise exception 'FAIL: the count-linked expense row survived its own delete';
  end if;

  -- 16b. The posting trigger is switched off for one insert, which is the only
  -- honest way to reproduce a row written before 20260908000750 shipped -- the
  -- state every expense in every existing shop is in until the backfill reaches
  -- it. A row with no entry that is not linked to anything is precisely what the
  -- null-pointer arm exists for, and nothing else in this script has one.
  alter table public.expenses disable trigger expenses_post_to_ledger;
  insert into public.expenses (shop_id, location_id, occurred_on, amount_cents, category,
                               payment_method, note, created_by)
    values (v_shop_id, v_loc_id, public.shop_local_date(), 4417, 'fees_charges', 'cash',
            'Entered before posting shipped', v_user_id)
    returning id into v_noop_id;
  alter table public.expenses enable trigger expenses_post_to_ledger;
  if (select journal_entry_id from public.expenses where id = v_noop_id) is not null then
    raise exception 'FAIL: check 16b''s fixture row posted -- it is not testing the no-op path';
  end if;

  select count(*) into v_before from public.journal_entries where shop_id = v_shop_id;
  delete from public.expenses where id = v_noop_id;
  select count(*) into v_rows from public.journal_entries where shop_id = v_shop_id;
  if v_rows <> v_before then
    raise exception 'FAIL: deleting a standalone expense that never posted wrote % journal entries', v_rows - v_before;
  end if;
  if exists (select 1 from public.expenses where id = v_noop_id) then
    raise exception 'FAIL: the never-posted expense row survived its own delete';
  end if;

  ---------------------------------------------------------------------------
  -- 17. A BILL'S MIRRORED ROW CASCADING AWAY **DOES** REVERSE.
  ---------------------------------------------------------------------------
  -- THIS CHECK USED TO ASSERT THE OPPOSITE, and it was wrong in the same shape
  -- check 6 was. It said "deleting a bill leaves its entry posted, because its
  -- payments' entries are not reversed with it" -- and check 6's bill, the very
  -- fixture it used, IS NEVER PAID ANYWHERE IN THIS SCRIPT. There were no
  -- payment entries to be left standing. The failure message described a
  -- situation that did not exist, and what the check actually pinned was a
  -- 61,437 rent cost surviving for ever with no source row to explain it: the
  -- P&L carrying rent nobody incurred, the balance sheet carrying money owed to
  -- nobody, `invoices` saying the shop owes zero, and no in-app way to undo it
  -- (reverse_journal_entry has no caller in src/ at all).
  --
  -- The exclusion was sound ONLY for a bill paid in full, and it is not sound
  -- even then any more: reverse_invoice_payment_entry (20260908001000) reverses
  -- the payments on the SAME cascade, so both halves of a deleted bill come off
  -- together. verify-posting-bills checks 16-18 are the three payment states --
  -- unpaid, part-paid, paid in full -- each asserting check 13's invariant
  -- afterwards. This check is the expense half, on an UNPAID bill, which is the
  -- case the old exclusion could never have been right about.
  --
  -- The `delete expenses` policy bars all four link columns (check 13), so a
  -- cascade is the ONLY way a linked row reaches the trigger at all.
  --
  -- MUTATION (proves this check): put the tg_op = 'DELETE' link exclusion back
  -- into reverse_expense_entry(). Expected: FAIL: deleting a bill left its
  -- mirrored expense's entry posted.
  select journal_entry_id into v_entry from public.expenses where invoice_id = v_bill_one;
  if v_entry is null then
    raise exception 'FAIL: check 17''s bill has no entry -- it is not testing anything';
  end if;
  -- Not vacuous in the other direction either: if this bill had been paid, the
  -- check below would be measuring the payment reversal as well.
  if exists (select 1 from public.invoice_payments where invoice_id = v_bill_one) then
    raise exception 'FAIL: check 17''s bill has been paid -- it is no longer the unpaid case it exists to cover';
  end if;
  select coalesce(sum(l.amount_cents), 0) into v_before
    from public.journal_lines l join public.accounts a on a.id = l.account_id
    join public.journal_entries e on e.id = l.entry_id
   where e.shop_id = v_shop_id and a.code = '6000';
  if v_before <> 61437 then
    raise exception 'FAIL: 6000 Rent reads % before check 17, expected the 61437 the bill recognised', v_before;
  end if;

  delete from public.invoices where id = v_bill_one;

  if exists (select 1 from public.expenses where invoice_id = v_bill_one) then
    raise exception 'FAIL: deleting a bill did not cascade its mirrored expense row away';
  end if;
  select status into v_status from public.journal_entries where id = v_entry;
  if v_status is null then
    raise exception 'FAIL: deleting a bill deleted its journal entry -- a posted entry is a permanent record';
  end if;
  if v_status <> 'reversed' then
    raise exception 'FAIL: deleting a bill left its mirrored expense''s entry % -- 6000 Rent carries a cost with no bill and no expense row behind it, and nothing in the app can reverse it', v_status;
  end if;

  select id into v_rev from public.journal_entries
   where shop_id = v_shop_id and reverses_entry_id = v_entry and status = 'posted';
  if v_rev is null then
    raise exception 'FAIL: no reversal entry points at the deleted bill''s entry';
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
    raise exception 'FAIL: % line(s) of the deleted bill''s entry have no negated twin on the reversal', v_rows;
  end if;
  -- A reversal carries the SAME SOURCE as the entry it reverses -- 'bill' here.
  select source into v_text from public.journal_entries where id = v_rev;
  if v_text <> 'bill' then
    raise exception 'FAIL: the reversal of a deleted bill is filed under %, expected bill', v_text;
  end if;

  -- THE COST IS OFF THE P&L. 6000 is touched by nothing else in this script.
  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l join public.accounts a on a.id = l.account_id
    join public.journal_entries e on e.id = l.entry_id
   where e.shop_id = v_shop_id and a.code = '6000';
  if v_amount <> 0 then
    raise exception 'FAIL: 6000 Rent reads % after the bill that recognised it was deleted, expected 0', v_amount;
  end if;
  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l join public.journal_entries e on e.id = l.entry_id
   where e.shop_id = v_shop_id;
  if v_amount <> 0 then
    raise exception 'FAIL: the trial balance does not zero after a bill was deleted, off by %', v_amount;
  end if;

  ---------------------------------------------------------------------------
  -- 18. A REVERSAL WHOSE MONTH HAS SINCE CLOSED IS REDATED, NOT REFUSED.
  ---------------------------------------------------------------------------
  -- reverse_journal_entry dates a reversal to the ORIGINAL entry's date on
  -- purpose -- a correction to August belongs in August. Right for a human at
  -- the ledger screen; wrong at this door, because open_period_for RAISES for
  -- any non-open period, so without the redirect deleting a receipt from a
  -- closed month fails with a ledger error on the Expenses screen for an
  -- operation that worked before this branch.
  --
  -- Check 8's closed month cannot be used: an expense back-dated into it is
  -- already redated to today, so its ENTRY sits in an open period and reversing
  -- it exercises nothing. This needs a month that was OPEN when the cost posted
  -- and was closed afterwards -- which is the ordinary sequence, because that is
  -- what closing a month IS.
  --
  -- MUTATION (proves this check): change the redirect's condition in
  -- reverse_expense_entry() to `if false`. Expected: ERROR: This period is
  -- closed — posting into it is refused. Re-open it first.
  v_on := (date_trunc('month', public.shop_local_date()::timestamp) - interval '3 months')::date + 14;
  insert into public.expenses (shop_id, location_id, occurred_on, amount_cents, category,
                               payment_method, note, created_by)
    values (v_shop_id, v_loc_id, v_on, 5533, 'fees_charges', 'cash', 'Old bank charge', v_user_id)
    returning id into v_expense_id;
  select journal_entry_id into v_entry from public.expenses where id = v_expense_id;
  select entry_date into v_date from public.journal_entries where id = v_entry;
  if v_date <> v_on then
    raise exception 'FAIL: check 18''s fixture entry is dated %, expected % -- the month was not open when it posted', v_date, v_on;
  end if;

  update public.accounting_periods set status = 'closed'
   where shop_id = v_shop_id and v_on between starts_on and ends_on;
  if not found then
    raise exception 'FAIL: no accounting_periods row covering % to close', v_on;
  end if;

  delete from public.expenses where id = v_expense_id;

  select id into v_rev from public.journal_entries
   where shop_id = v_shop_id and reverses_entry_id = v_entry and status = 'posted';
  if v_rev is null then
    raise exception 'FAIL: deleting an expense whose month has closed wrote no reversal';
  end if;
  select entry_date, description into v_date, v_text from public.journal_entries where id = v_rev;
  if v_date <> public.shop_local_date() then
    raise exception 'FAIL: the reversal of an entry in a closed month is dated %, expected the current period (%)',
      v_date, public.shop_local_date();
  end if;
  -- The journal has to SAY why an old undoing is sitting in this month. This is
  -- also the assertion that catches the NULL-description trap: `||` with a NULL
  -- operand yields NULL for the WHOLE expression, so a missing coalesce on the
  -- period status fails the delete with "A journal entry needs a description" --
  -- an error about descriptions for a bug about dates.
  if v_text not like '%that period is closed%' then
    raise exception 'FAIL: the redated reversal does not say why it moved: %', v_text;
  end if;
  if v_text not like '%' || to_char(v_on, 'YYYY-MM-DD') || '%' then
    raise exception 'FAIL: the redated reversal does not carry the original entry''s date: %', v_text;
  end if;
  -- The pair still nets to nothing, in a different month from the one it posted.
  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l where l.entry_id in (v_entry, v_rev);
  if v_amount <> 0 then
    raise exception 'FAIL: a redated reversal and its original do not net to zero, off by %', v_amount;
  end if;

  ---------------------------------------------------------------------------
  -- 19. MOVING A RECEIPT BETWEEN TWO SHOPS MOVES ITS ENTRY WITH IT.
  ---------------------------------------------------------------------------
  -- post_journal_entry takes a SHOP ID, so the entry is derived from shop_id as
  -- surely as from the amount -- and shop_id was missing from both WHEN clauses
  -- on the reverse-and-re-post pair. The `update expenses` policy gates both
  -- halves on has_shop_permission(shop_id, 'expenses.manage'), which an owner of
  -- two shops satisfies for both, so this update is reachable from the app. With
  -- shop_id absent from the clause neither trigger fires: the entry stays in the
  -- OLD shop, unreversed, and the new shop never learns of the cost. One P&L
  -- keeps a receipt it does not have and the other is missing one it does.
  --
  -- location_id IS CLEARED FIRST, in a separate statement, so this check
  -- isolates shop_id. location_id was already in the clause; changing both at
  -- once would fire the triggers for the wrong reason and pass against a build
  -- that never learned about shop_id at all.
  --
  -- MUTATION (proves this check): remove `old.shop_id is distinct from
  -- new.shop_id` from both WHEN clauses. Expected: FAIL: moving an expense to
  -- another shop left its entry in the old shop.
  insert into public.shops (owner_id, name) values (v_user_id, 'Posting Expenses Shop Two')
    returning id into v_shop_two;

  insert into public.expenses (shop_id, location_id, occurred_on, amount_cents, category,
                               payment_method, note, created_by)
    values (v_shop_id, v_loc_id, public.shop_local_date(), 3311, 'fees_charges', 'cash',
            'Bank charge filed against the wrong shop', v_user_id)
    returning id into v_expense_id;
  select journal_entry_id into v_entry from public.expenses where id = v_expense_id;
  if v_entry is null then
    raise exception 'FAIL: check 19''s fixture row posted nothing -- it is not testing anything';
  end if;
  update public.expenses set location_id = null where id = v_expense_id;
  -- The clearing re-posted (location_id is in the clause), so re-read the
  -- pointer: the entry under test is the CURRENT one, not the first.
  select journal_entry_id into v_entry from public.expenses where id = v_expense_id;

  update public.expenses set shop_id = v_shop_two where id = v_expense_id;

  select status into v_status from public.journal_entries where id = v_entry;
  if v_status <> 'reversed' then
    raise exception 'FAIL: moving an expense to another shop left its entry % in the old shop -- % keeps a cost it no longer has a receipt for', v_status, 'Posting Expenses Shop';
  end if;
  select journal_entry_id into v_entry_two from public.expenses where id = v_expense_id;
  if v_entry_two is null or v_entry_two = v_entry then
    raise exception 'FAIL: moving an expense to another shop did not re-post it -- the new shop never learns of the cost';
  end if;
  select shop_id into v_rev from public.journal_entries where id = v_entry_two;
  if v_rev <> v_shop_two then
    raise exception 'FAIL: the replacement entry was posted into shop % rather than the shop the receipt moved to', v_rev;
  end if;
  -- The old shop is left exactly where it was, and the new one carries the cost.
  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l join public.journal_entries e on e.id = l.entry_id
   where e.shop_id = v_shop_id;
  if v_amount <> 0 then
    raise exception 'FAIL: the old shop''s trial balance does not zero after a receipt moved out, off by %', v_amount;
  end if;
  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l join public.accounts a on a.id = l.account_id
    join public.journal_entries e on e.id = l.entry_id
   where e.shop_id = v_shop_two and a.code = '6700';
  if v_amount <> 3311 then
    raise exception 'FAIL: 6700 in the shop the receipt moved to reads %, expected 3311', v_amount;
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
