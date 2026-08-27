-- The three statements, and the five ways they must agree with each other.
--
-- One fixture, posted through the real RPCs rather than by hand, because a
-- statement that agrees with journal lines someone wrote for it proves nothing.
--
-- Every figure below is chosen so that no two are equal and no subtotal can be
-- reached by a wrong pairing. That is not fussiness: three checks on this
-- project have passed against a wrong implementation because two numbers in the
-- fixture happened to match.

\set ON_ERROR_STOP on

do $$
declare
  v_user   uuid := gen_random_uuid();
  v_other  uuid := gen_random_uuid();   -- check 9: somebody else's owner
  v_shop   uuid;
  v_loc    uuid;
  v_shop_b uuid;   -- check 27: the second shop, which IS the tenant boundary
  v_loc_b  uuid;
  v_draft  uuid;   -- check 9b: a draft no statement may see
  v_prod_a uuid;   -- cost 300, sells 1000
  v_prod_b uuid;   -- cost 700, sells 2500
  v_cust   uuid;
  v_sale   uuid;
  v_amount bigint;
  v_open   date;    -- the opening entry's date, 40 days back
  -- Check 26, the five reconciliations. Every one is asserted between two
  -- named figures so the failure message can print both and their difference.
  v_is_profit  bigint;   -- income statement, net profit
  v_bs_profit  bigint;   -- balance sheet, "Profit this period"
  v_cf_profit  bigint;   -- cash flow, the operating opening line
  v_tb_profit  bigint;   -- the trial balance, netted here from journal_lines
  v_tb_lines   bigint;   -- how many lines that derivation actually saw
  v_bs_assets  bigint;
  v_bs_credits bigint;   -- total liabilities and equity
  v_bs_cash    bigint;
  v_cf_cash    bigint;
  -- Check 29 (task 5): two more shops whose books are made ENTIRELY by the
  -- phase-3c RPCs. Shop A's asset and depreciation entries are hand-written, so
  -- its 1500-1599 balance can never be tied to the register; these two can.
  v_user_c uuid := gen_random_uuid();
  v_user_d uuid := gen_random_uuid();
  v_shop_c uuid;
  v_shop_d uuid;
  v_loc_c  uuid;
  v_loc_d  uuid;
  v_m1     date;   -- the first day of last month, the last COMPLETE month
  v_m2     date;   -- the first day of the month before that
  v_fridge uuid;
  v_shelf  uuid;
  v_oven   uuid;
  v_till   uuid;
  v_runs   integer;
  -- The transfer bracket: read before it, re-read after it, and nothing on any
  -- statement may have moved.
  v_t_profit  bigint;
  v_t_assets  bigint;
  v_t_change  bigint;
  v_t_1000    bigint;
  v_t_1010    bigint;
  v_codes  text[];
begin
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
    select u, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
           'verify-statements-' || u || '@example.test', '', now(), now(), now()
      from unnest(array[v_user, v_other]) u;
  insert into public.shops (owner_id, name) values (v_user, 'Statement Shop') returning id into v_shop;
  insert into public.shop_locations (shop_id, name, is_primary) values (v_shop, 'Main', true)
    returning id into v_loc;
  insert into public.products (shop_id, name, price_cents, cost_cents, stock)
    values (v_shop, 'Widget A', 1000, 300, 100) returning id into v_prod_a;
  insert into public.products (shop_id, name, price_cents, cost_cents, stock)
    values (v_shop, 'Widget B', 2500, 700, 100) returning id into v_prod_b;
  -- public.customers has no `name` column: it is first_name / last_name.
  insert into public.customers (shop_id, first_name) values (v_shop, 'Faduma') returning id into v_cust;

  -- ---------------------------------------------------------------------
  -- A SECOND SHOP, WITH ITS OWN BOOKS. This is the multi-tenant boundary,
  -- and until it existed there was nothing here to test.
  --
  -- All three functions are `security definer`, so RLS on journal_lines and
  -- accounts does not apply inside them: `shop_id` scoping IS the boundary.
  -- With one shop in the fixture, removing the scoping from all three at once
  -- left this file printing ALL CHECKS PASSED -- there was simply no other
  -- shop's data to leak.
  --
  -- Every figure below is deliberately UNLIKE shop A's and much larger, so a
  -- leak in either direction moves a number rather than hiding inside a
  -- rounding. Shop A's figures are pinned to the cent by checks 1-26; those
  -- checks are the leak detector, and check 27 asserts shop B's own figures so
  -- that a leak the other way is caught too.
  --
  -- Owned by v_other, who was already the stranger of checks 9/18/25 -- which
  -- makes those checks stronger as well: the stranger is now a real shop owner
  -- with real books, not a user who has never seen a ledger.
  insert into public.shops (owner_id, name) values (v_other, 'The Other Shop') returning id into v_shop_b;
  insert into public.shop_locations (shop_id, name, is_primary) values (v_shop_b, 'Main', true)
    returning id into v_loc_b;

  -- 1595 Vehicles, which the seeded chart does not carry and a shop that buys
  -- a van adds for itself. It is here because balance_sheet() calls
  -- 1500-1599 fixed assets while cash_flow()'s investing section was written
  -- 1500-1589: a shop with an account in the 1590s got fixed assets of 50000
  -- on one statement, investing of 0 on the other, and a cash flow that
  -- stopped proving out. Nothing in the seeded chart sits in that gap, so the
  -- fixture has to put something there. See check 27.
  insert into public.accounts (shop_id, code, name, type)
    values (v_shop_b, '1595', 'Vehicles', 'asset');

  -- ---------------------------------------------------------------------
  -- A DRAFT ENTRY IN SHOP A, left in place for the whole file.
  --
  -- journal_entries.status DEFAULTS to 'draft', so a half-written entry is
  -- the easiest thing in this database to produce -- and all three statements
  -- read `status in ('posted','reversed')`, which is a filter nothing tested:
  -- adding 'draft' to that list was a no-op in every one of them, because no
  -- fixture had ever written one.
  --
  -- 999000 is chosen to be unmissable. If any statement counted it, net
  -- revenue, cash, total assets and the cash flow's every total would each be
  -- wrong by a figure larger than the whole fixture. Check 9b says so
  -- explicitly; checks 1, 10, 11 and 20 would all redden anyway.
  --
  -- Written by hand rather than through post_journal_entry, which posts. This
  -- runs before `set role authenticated`, so RLS is not yet in the way.
  insert into public.journal_entries
      (shop_id, period_id, entry_date, description, source, status, created_by)
    values (v_shop, public.open_period_for(v_shop, public.shop_local_date()),
            public.shop_local_date(), 'A draft nobody has posted', 'manual', 'draft', v_user)
    returning id into v_draft;
  insert into public.journal_lines (entry_id, account_id, amount_cents)
    select v_draft, a.id, 999000 from public.accounts a where a.shop_id = v_shop and a.code = '1000';
  insert into public.journal_lines (entry_id, account_id, amount_cents)
    select v_draft, a.id, -999000 from public.accounts a where a.shop_id = v_shop and a.code = '4000';

  perform set_config('request.jwt.claims', json_build_object('sub', v_user)::text, true);
  perform set_config('role', 'authenticated', true);

  -- ---------------------------------------------------------------------
  -- THE BALANCE-SHEET HALF OF THE FIXTURE (added by task 2).
  --
  -- Checks 1-9 above only ever needed revenue, cost and expense, so the
  -- fixture as first written touched no liability, no fixed asset and no
  -- equity account at all -- every one of those balances was ZERO. Three of
  -- task 2's checks would have been no-ops against it and two of the
  -- mutations the plan names could not have reddened anything:
  --
  --   * presenting liabilities WITHOUT negating them is invisible when
  --     liabilities are 0, because -0 = 0;
  --   * the 1500-1599 fixed/current split cannot be asserted when no account
  --     in that range has a balance;
  --   * owner's draw cannot be shown to present negative when nobody drew.
  --
  -- So the fixture now carries an opening position, a fixed asset bought on
  -- credit, a depreciation charge and a draw. Every figure is still distinct
  -- from every other, including the new subtotals.
  -- ---------------------------------------------------------------------

  -- The opening position. Products were created holding stock that no
  -- delivery accounts for, so without this 1200 Inventory sits in CREDIT --
  -- the exact defect 20260908001300 was written for. Dr 1200 / Cr 3000, at
  -- the value on the shelf: 100*300 + 100*700 = 100000.
  --
  -- DATED 40 DAYS BACK, which is the point: the balance sheet has NO lower
  -- bound, so this must still be in today's figures. Check 12 pins it.
  v_open := public.shop_local_date() - 40;
  perform public.post_journal_entry(v_shop, v_open, 'Opening inventory',
    jsonb_build_array(
      jsonb_build_object('code', '1200', 'amount_cents',  100000),
      jsonb_build_object('code', '3000', 'amount_cents', -100000)),
    v_loc, 'opening');

  -- Trading, rung up WRONG and then corrected, because an edit is the only
  -- thing in this project that produces a 'reversed' entry and the function
  -- has to count one. Rung up as 5 of A; the customer only took 4.
  --   revenue at list   5*1000 + 2*2500 = 10000
  --   discount                              500
  select public.complete_sale(
    v_shop,
    jsonb_build_array(
      jsonb_build_object('product_id', v_prod_a, 'quantity', 5, 'unit_price_cents', 1000),
      jsonb_build_object('product_id', v_prod_b, 'quantity', 2, 'unit_price_cents', 2500)),
    jsonb_build_array(jsonb_build_object('method', 'cash', 'amount_cents', 9500)),
    null, null, null, null, 500, null, null, v_loc)
  into v_sale;

  -- The correction. edit_sale marks the original entry 'reversed', posts a
  -- reversal, and posts a replacement -- so the ledger now holds all three and
  -- only a function that reads BOTH 'posted' and 'reversed' nets them to the
  -- replacement. Reading 'posted' alone gives original-less-reversal, which is
  -- the correction without the thing it corrects.
  --   revenue at list   4*1000 + 2*2500 = 9000
  --   discount                              500
  --   COGS              4*300  + 2*700  = 2600
  perform public.edit_sale(
    v_sale,
    jsonb_build_array(
      jsonb_build_object('product_id', v_prod_a, 'quantity', 4, 'unit_price_cents', 1000),
      jsonb_build_object('product_id', v_prod_b, 'quantity', 2, 'unit_price_cents', 2500)),
    jsonb_build_array(jsonb_build_object('method', 'cash', 'amount_cents', 8500)),
    null, null, null, 500, null);

  -- Shrinkage: 3 of A missing. 3 * 300 = 900, into 5100 (cost of sales).
  perform public.save_stock_count(v_shop, v_loc,
    jsonb_build_array(jsonb_build_object('product_id', v_prod_a, 'counted_quantity', 93, 'reason', 'damaged')));

  -- Operating expenses: rent 3800 (6000), utilities 1250 (6100).
  --
  -- Rent is 3800 rather than 4000 so that the depreciation charge below can be
  -- 200 and leave operating expenses at 5250 and net profit at -250 --
  -- checks 4 and 5 keep the figures they were written with, and the balance
  -- sheet gets a contra-asset to present. 3800 is also chosen over 3500 so
  -- that no expense equals the 3500 cost of sales.
  insert into public.expenses (shop_id, location_id, occurred_on, amount_cents, category, payment_method)
    values (v_shop, v_loc, public.shop_local_date(), 3800, 'rent', 'cash'),
           (v_shop, v_loc, public.shop_local_date(), 1250, 'utilities', 'cash');

  -- A fixed asset bought ON CREDIT, which is one entry doing two jobs: it
  -- puts 6400 into 1510 (in the 1500-1599 fixed range) and 6400 into
  -- 2000 Accounts Payable, so the fixed/current split and the liability sign
  -- both have something to bite on.
  perform public.post_journal_entry(v_shop, public.shop_local_date(), 'Shop counter, on account',
    jsonb_build_array(
      jsonb_build_object('code', '1510', 'amount_cents',  6400),
      jsonb_build_object('code', '2000', 'amount_cents', -6400)),
    v_loc, 'asset');

  -- Depreciation. 1590 is the seeded CONTRA asset: it carries a credit
  -- balance and must present NEGATIVE inside fixed assets without any flip,
  -- because assets are not flipped at all.
  perform public.post_journal_entry(v_shop, public.shop_local_date(), 'Depreciation for the month',
    jsonb_build_array(
      jsonb_build_object('code', '6800', 'amount_cents',  200),
      jsonb_build_object('code', '1590', 'amount_cents', -200)),
    v_loc, 'depreciation');

  -- The owner takes 1500 out. 3100 is CONTRA equity: it holds a DEBIT, so it
  -- is the one account that must survive the equity sign flip still negative.
  perform public.post_journal_entry(v_shop, public.shop_local_date(), 'Owner drawing',
    jsonb_build_array(
      jsonb_build_object('code', '3100', 'amount_cents',  1500),
      jsonb_build_object('code', '1000', 'amount_cents', -1500)));

  -- ---------------------------------------------------------------------
  -- THE CASH-FLOW HALF OF THE FIXTURE (added by task 3), and added for
  -- exactly the reason task 2 added its own half.
  --
  -- The cash flow's operating section has six rows. Against the fixture as
  -- task 2 left it, THREE accounts behind those rows never moved -- 1100
  -- Accounts Receivable, 2100 Sales Tax Payable and 2200 Wages Payable -- so
  -- two of the six rows read zero no matter what the function did with them.
  -- Flipping the sign of "increase in receivables", which is the mutation the
  -- plan names for the sign convention, left the whole script GREEN: -0 = 0.
  --
  -- So the fixture now also sells on credit and accrues a wage. Both are
  -- posted by hand rather than through complete_sale, because complete_sale
  -- with a balance owing would also move cash and inventory and every figure
  -- in checks 1-18 with them.
  --
  -- The two entries are sized together so the fixture keeps the properties
  -- task 2 built into it: 3000 of revenue against 4000 of wages leaves net
  -- profit NEGATIVE (-1250), which is what makes check 5 exercise the sign,
  -- and leaves cash from operations at -90150 either way.
  --
  --   Dr 1100  3450   a customer takes 3000 of goods and the tax on them,
  --   Cr 4000  3000   and pays next week
  --   Cr 2100   450
  --
  --   Dr 6200  4000   a week's wages earned and not yet paid
  --   Cr 2200  4000
  --
  -- Neither touches cash, so checks 11 and 24's cash figures are untouched;
  -- neither touches inventory, so check 12 is untouched.
  perform public.post_journal_entry(v_shop, public.shop_local_date(), 'Sale on credit, with tax',
    jsonb_build_array(
      jsonb_build_object('code', '1100', 'amount_cents',  3450),
      jsonb_build_object('code', '4000', 'amount_cents', -3000),
      jsonb_build_object('code', '2100', 'amount_cents',  -450)),
    v_loc, 'sale');

  perform public.post_journal_entry(v_shop, public.shop_local_date(), 'Wages earned, not yet paid',
    jsonb_build_array(
      jsonb_build_object('code', '6200', 'amount_cents',  4000),
      jsonb_build_object('code', '2200', 'amount_cents', -4000)),
    v_loc, 'payroll');

  -- ---------------------------------------------------------------------
  -- SHOP B'S BOOKS, posted by its own owner. Three entries, sized so that
  -- every one of shop A's figures moves if either shop's ledger reaches the
  -- other's statements.
  --
  --   45 days back   Dr 1000  77000 / Cr 3000  77000   opening capital, in cash
  --   40 days back   Dr 6000   9100 / Cr 1000   9100   a month's rent, PAID
  --   today          Dr 1595  50000 / Cr 1000  50000   a van, bought for cash
  --
  -- The rent is DATED IN THE PAST on purpose and it is the only P&L entry in
  -- this file that is. balance_sheet() reads statement_lines('-infinity',
  -- p_as_of) and every P&L entry in shop A is dated today, so narrowing that
  -- lower bound to p_as_of changed nothing at all and was a no-op mutation.
  -- Shop B's rent is what makes it bite: see check 27.
  --
  -- The van is in the 1590s, which is the gap between balance_sheet()'s
  -- 1500-1599 and the 1500-1589 cash_flow() was first written with.
  perform set_config('request.jwt.claims', json_build_object('sub', v_other)::text, true);

  perform public.post_journal_entry(v_shop_b, v_open - 5, 'Opening capital',
    jsonb_build_array(
      jsonb_build_object('code', '1000', 'amount_cents',  77000),
      jsonb_build_object('code', '3000', 'amount_cents', -77000)),
    v_loc_b, 'opening');
  perform public.post_journal_entry(v_shop_b, v_open, 'Rent, paid',
    jsonb_build_array(
      jsonb_build_object('code', '6000', 'amount_cents',  9100),
      jsonb_build_object('code', '1000', 'amount_cents', -9100)),
    v_loc_b);
  perform public.post_journal_entry(v_shop_b, public.shop_local_date(), 'A van, for cash',
    jsonb_build_array(
      jsonb_build_object('code', '1595', 'amount_cents',  50000),
      jsonb_build_object('code', '1000', 'amount_cents', -50000)),
    v_loc_b, 'asset');

  perform set_config('request.jwt.claims', json_build_object('sub', v_user)::text, true);

  -- 1. Revenue is NET of returns and discounts, and excludes sales tax.
  --    9000 at list less the 500 discount = 8500, plus 3000 sold on credit --
  --    and NOT the 450 of tax on it, which is owed rather than earned.
  select amount_cents into v_amount from public.statement_lines(v_shop, '2000-01-01', '2100-01-01')
   where section = 'revenue' and is_total;
  if v_amount <> 11500 then
    raise exception 'FAIL: net revenue is %, expected 11500 (12000 = discount not deducted, 11950 = sales tax counted as income)', v_amount;
  end if;

  -- 2. Cost of sales carries COGS *and* shrinkage. 2600 + 900 = 3500.
  --    THE ONE THAT MATTERS for the shrinkage decision: 2600 here would mean
  --    5100 had been grouped into operating expenses instead.
  select amount_cents into v_amount from public.statement_lines(v_shop, '2000-01-01', '2100-01-01')
   where section = 'cost_of_sales' and is_total;
  if v_amount <> 3500 then
    raise exception 'FAIL: cost of sales is %, expected 3500 (2600 = shrinkage grouped into opex)', v_amount;
  end if;

  -- 3. Gross profit = 11500 - 3500 = 8000.
  select amount_cents into v_amount from public.statement_lines(v_shop, '2000-01-01', '2100-01-01')
   where section = 'gross_profit';
  if v_amount <> 8000 then
    raise exception 'FAIL: gross profit is %, expected 8000', v_amount;
  end if;

  -- 4. Operating expenses = 3800 rent + 1250 utilities + 200 depreciation
  --    + 4000 accrued wages = 9250. Stock purchases and owner draws must NOT
  --    appear: they are an asset and equity respectively, and that is what
  --    makes a balance sheet possible.
  select amount_cents into v_amount from public.statement_lines(v_shop, '2000-01-01', '2100-01-01')
   where section = 'operating_expenses' and is_total;
  if v_amount <> 9250 then
    raise exception 'FAIL: operating expenses is %, expected 9250', v_amount;
  end if;

  -- 5. Net profit = 8000 - 9250 = -1250. NEGATIVE, deliberately: a fixture
  --    that only ever produces a profit never exercises the sign. The credit
  --    sale and the accrued wage added by task 3 are sized against each other
  --    to keep it that way.
  select amount_cents into v_amount from public.statement_lines(v_shop, '2000-01-01', '2100-01-01')
   where section = 'net_profit';
  if v_amount <> -1250 then
    raise exception 'FAIL: net profit is %, expected -1250 (a loss)', v_amount;
  end if;

  -- 6. THE DETAIL FLAG. Summary and detail must produce the SAME net profit
  --    and the SAME section subtotals. Two reports that disagree is exactly
  --    what one query with a flag exists to prevent.
  if (select amount_cents from public.statement_lines(v_shop, '2000-01-01', '2100-01-01', true)
       where section = 'net_profit')
     <> (select amount_cents from public.statement_lines(v_shop, '2000-01-01', '2100-01-01', false)
          where section = 'net_profit') then
    raise exception 'FAIL: detail and summary disagree about net profit';
  end if;

  -- ...and detail carries per-account rows where summary does not.
  if (select count(*) from public.statement_lines(v_shop, '2000-01-01', '2100-01-01', true)
       where section = 'operating_expenses' and not is_total) < 2 then
    raise exception 'FAIL: detail should list rent and utilities separately';
  end if;
  if (select count(*) from public.statement_lines(v_shop, '2000-01-01', '2100-01-01', false)
       where section = 'operating_expenses' and not is_total) <> 0 then
    raise exception 'FAIL: summary should carry no per-account rows';
  end if;

  -- 7. The date window bites. Nothing in 2019.
  --
  --    Asserted over EVERY row, not just the per-account ones. Written as
  --    `not is_total and amount_cents <> 0` this check was a no-op: summary
  --    mode returns nothing BUT totals, so the predicate matched no row no
  --    matter what the function did with p_from and p_to, and deleting the
  --    date filter outright left the whole script green.
  if exists (select 1 from public.statement_lines(v_shop, '2019-01-01', '2019-12-31')
              where amount_cents <> 0) then
    raise exception 'FAIL: a window with no trading returned figures';
  end if;
  if exists (select 1 from public.statement_lines(v_shop, '2019-01-01', '2019-12-31', true)
              where amount_cents <> 0) then
    raise exception 'FAIL: a window with no trading returned figures in detail';
  end if;

  -- 8. The fixture really does contain a reversed entry, and a posted reversal
  --    of it. Asserted directly rather than inferred, because checks 1-5 only
  --    bite on the 'reversed' half of the status filter for as long as this is
  --    true -- and if edit_sale ever stopped reversing, they would go on
  --    passing while the ledger read silently changed underneath them.
  if not exists (select 1 from public.journal_entries e
                  where e.shop_id = v_shop and e.status = 'reversed') then
    raise exception 'FAIL: the fixture posted no reversed entry, so the status filter is untested';
  end if;
  if not exists (select 1 from public.journal_entries e
                  where e.shop_id = v_shop and e.status = 'posted' and e.reverses_entry_id is not null) then
    raise exception 'FAIL: the fixture posted no reversal, so the status filter is untested';
  end if;

  -- 8b. NO STATEMENT SEES A DRAFT. `status in ('posted','reversed')` excludes
  --     'draft', which is journal_entries' DEFAULT status and therefore the
  --     easiest state in the database to reach: any half-written entry sits
  --     there. Adding 'draft' to the filter in any of the three functions was
  --     a silent no-op until this fixture wrote one.
  --
  --     Asserted on all three statements, in one place, because the failure is
  --     one defect with three faces: a shop would see revenue it has not
  --     earned, cash it does not have, and a cash flow that still proves out
  --     because the draft balances like any other entry.
  if not exists (select 1 from public.journal_entries e
                  where e.shop_id = v_shop and e.status = 'draft') then
    raise exception 'FAIL: the fixture holds no draft entry, so the draft exclusion is untested in all three statements';
  end if;
  if (select amount_cents from public.statement_lines(v_shop, '2000-01-01', '2100-01-01')
       where section = 'revenue' and is_total) <> 11500 then
    raise exception 'FAIL: net revenue reads % -- either the 999000 draft was counted, or the other shop''s books have leaked in',
      (select amount_cents from public.statement_lines(v_shop, '2000-01-01', '2100-01-01')
        where section = 'revenue' and is_total);
  end if;
  if (select amount_cents from public.balance_sheet(v_shop, public.shop_local_date())
       where code = '1000') <> 1950 then
    raise exception 'FAIL: cash reads % -- either the 999000 draft was counted, or the other shop''s books have leaked in',
      (select amount_cents from public.balance_sheet(v_shop, public.shop_local_date()) where code = '1000');
  end if;
  if (select amount_cents from public.cash_flow(v_shop, '2000-01-01', '2100-01-01')
       where section = 'net_change') <> 1950 then
    raise exception 'FAIL: net change reads % -- either the 999000 draft was counted, or the other shop''s books have leaked in',
      (select amount_cents from public.cash_flow(v_shop, '2000-01-01', '2100-01-01') where section = 'net_change');
  end if;

  -- 9. THE GATE. statement_lines is security definer, so RLS on journal_lines
  --    does not protect it -- the ledger.view check inside the function is the
  --    only thing between another shop's owner and these books. Deleting that
  --    check reddened nothing at all until this was written.
  --
  --    A subtransaction is right here, unlike almost everywhere else in this
  --    project: what is being asserted is a RAISE, not a write, so there is no
  --    write for the rollback to undo.
  perform set_config('request.jwt.claims', json_build_object('sub', v_other)::text, true);
  begin
    perform 1 from public.statement_lines(v_shop, '2000-01-01', '2100-01-01');
    raise exception 'FAIL: a stranger read this shop''s income statement';
  exception
    when others then
      if sqlerrm like 'FAIL:%' then raise; end if;
      if sqlerrm <> 'You do not have permission to see the books.' then
        raise exception 'FAIL: the stranger was refused, but by something else: %', sqlerrm;
      end if;
  end;
  perform set_config('request.jwt.claims', json_build_object('sub', v_user)::text, true);

  -- =====================================================================
  -- THE BALANCE SHEET (task 2).
  --
  -- The figures it must produce, all of them distinct:
  --
  --   Current assets   1000 Cash on Hand         1950   8500 - 5050 - 1500
  --                    1100 Accounts Receivable  3450   the credit sale + tax
  --                    1200 Inventory           96500   100000 - 3500
  --                    total                   101900
  --   Fixed assets     1510 Furniture            6400
  --                    1590 Accum. depreciation   -200   contra, presents down
  --                    total                     6200
  --   TOTAL ASSETS                             108100
  --
  --   Liabilities      2000 Accounts Payable     6400
  --                    2100 Sales Tax Payable     450
  --                    2200 Wages Payable        4000
  --                    total                    10850
  --   Equity           3000 Owner's Capital    100000
  --                    3100 Owner's Draw         -1500   contra, reduces equity
  --                    3900 Retained earnings        0   nothing closed yet
  --                    Profit this period        -1250   = the income statement
  --                    total                    97250
  --   TOTAL L + E                              108100
  -- =====================================================================

  -- 10. THE ONE THAT MATTERS. Total assets equals total liabilities and
  --     equity. Not asserted as a tolerance and not computed by the screen:
  --     it is a consequence of every entry balancing, and showing it is the
  --     first thing an accountant looks for.
  if (select amount_cents from public.balance_sheet(v_shop, public.shop_local_date())
       where section = 'total_assets')
     <> (select amount_cents from public.balance_sheet(v_shop, public.shop_local_date())
          where section = 'total_liabilities_equity') then
    raise exception 'FAIL: the balance sheet does not balance -- assets % vs liabilities+equity %',
      (select amount_cents from public.balance_sheet(v_shop, public.shop_local_date()) where section = 'total_assets'),
      (select amount_cents from public.balance_sheet(v_shop, public.shop_local_date()) where section = 'total_liabilities_equity');
  end if;

  --     ...and it balances at a figure, not at zero. Check 10 alone passes
  --     against a function that returns nothing at all.
  select amount_cents into v_amount from public.balance_sheet(v_shop, public.shop_local_date())
   where section = 'total_assets';
  if v_amount is distinct from 108100 then
    raise exception 'FAIL: total assets is %, expected 108100', v_amount;
  end if;

  -- 11. Assets carry a POSITIVE presentation sign even though 1200 Inventory
  --     is credited by every sale. Getting this wrong produces a balance
  --     sheet that balances and reads upside down.
  select amount_cents into v_amount from public.balance_sheet(v_shop, public.shop_local_date())
   where code = '1000';
  if v_amount is null or v_amount <> 1950 then
    raise exception 'FAIL: Cash on Hand reads % -- expected 1950, and assets present positive', v_amount;
  end if;

  -- 12. NO LOWER BOUND. The opening entry is 40 days old and is still in
  --     today's inventory figure: 100000 opening less 3500 of COGS and
  --     shrinkage = 96500. A function that windowed from the start of the
  --     month, or from p_as_of, would read -3500 here and still balance.
  select amount_cents into v_amount from public.balance_sheet(v_shop, public.shop_local_date())
   where code = '1200';
  if v_amount is null or v_amount <> 96500 then
    raise exception 'FAIL: Inventory reads %, expected 96500 -- the opening entry 40 days back must still count', v_amount;
  end if;

  -- 13. FIXED vs CURRENT. 1510 Furniture is in the 1500-1599 range and must
  --     land in fixed assets; 1200 Inventory must not. Asserted explicitly
  --     because total assets is IDENTICAL either way -- only the split moves,
  --     so nothing else in this script can see the difference.
  if not exists (select 1 from public.balance_sheet(v_shop, public.shop_local_date())
                  where code = '1510' and section = 'fixed_assets') then
    raise exception 'FAIL: 1510 Furniture is not under fixed assets (it is %)',
      coalesce((select section from public.balance_sheet(v_shop, public.shop_local_date()) where code = '1510'), 'absent');
  end if;
  if not exists (select 1 from public.balance_sheet(v_shop, public.shop_local_date())
                  where code = '1200' and section = 'current_assets') then
    raise exception 'FAIL: 1200 Inventory is not under current assets';
  end if;

  --     1590 Accumulated Depreciation is a CONTRA asset: it presents negative
  --     inside fixed assets and reduces them. No flip is involved -- assets
  --     are never flipped -- so a function that "corrected" its sign would
  --     report fixed assets of 6600 and stop balancing.
  select amount_cents into v_amount from public.balance_sheet(v_shop, public.shop_local_date())
   where code = '1590';
  if v_amount is null or v_amount <> -200 then
    raise exception 'FAIL: accumulated depreciation reads %, expected -200', v_amount;
  end if;
  if (select amount_cents from public.balance_sheet(v_shop, public.shop_local_date())
       where section = 'fixed_assets' and is_total) <> 6200 then
    raise exception 'FAIL: fixed assets is %, expected 6200 (6600 = depreciation added instead of subtracted)',
      (select amount_cents from public.balance_sheet(v_shop, public.shop_local_date()) where section = 'fixed_assets' and is_total);
  end if;

  -- 14. LIABILITIES PRESENT POSITIVE, which means negating a credit balance.
  --     Asserted on the figure and not only through check 10, because a
  --     reader looking at check 10 cannot tell which side went wrong.
  select amount_cents into v_amount from public.balance_sheet(v_shop, public.shop_local_date())
   where code = '2000';
  if v_amount is null or v_amount <> 6400 then
    raise exception 'FAIL: Accounts Payable reads %, expected 6400 (-6400 = the credit balance was not negated)', v_amount;
  end if;

  -- 15. OWNER'S DRAW IS CONTRA-EQUITY and must REDUCE equity, so it presents
  --     negative -- it keeps its ledger sign after the flip that turns the
  --     rest of equity positive. That is what contra means, and a function
  --     that negated it uniformly would show equity of 101250.
  select amount_cents into v_amount from public.balance_sheet(v_shop, public.shop_local_date())
   where code = '3100';
  if v_amount is null or v_amount <> -1500 then
    raise exception 'FAIL: Owner''s Draw reads %, expected -1500 (a draw reduces equity)', v_amount;
  end if;
  if (select amount_cents from public.balance_sheet(v_shop, public.shop_local_date())
       where code = '3000') <> 100000 then
    raise exception 'FAIL: Owner''s Capital does not read 100000';
  end if;

  --     Retained earnings is 3900's balance and is ZERO for every shop until
  --     phase 3b ships the period close. That is correct, not missing: with
  --     nothing closed, the whole profit sits in "profit this period".
  if (select amount_cents from public.balance_sheet(v_shop, public.shop_local_date())
       where section = 'equity' and code = '3900') <> 0 then
    raise exception 'FAIL: retained earnings is not zero, but nothing has been closed';
  end if;

  --     ...and the four equity rows sum to the equity total.
  if (select coalesce(sum(amount_cents), 0) from public.balance_sheet(v_shop, public.shop_local_date())
       where section = 'equity' and not is_total)
     <> (select amount_cents from public.balance_sheet(v_shop, public.shop_local_date())
          where section = 'equity' and is_total) then
    raise exception 'FAIL: the equity rows do not sum to the equity total';
  end if;
  if (select count(*) from public.balance_sheet(v_shop, public.shop_local_date())
       where section = 'equity' and not is_total) <> 4 then
    raise exception 'FAIL: equity should carry four rows, it carries %',
      (select count(*) from public.balance_sheet(v_shop, public.shop_local_date()) where section = 'equity' and not is_total);
  end if;

  -- 16. PROFIT THIS PERIOD *IS* THE INCOME STATEMENT'S NET PROFIT. The first
  --     of the five reconciliations and the one a reader checks by eye. The
  --     balance sheet must CALL statement_lines rather than re-derive it: two
  --     derivations are how the two reports come to disagree.
  select amount_cents into v_amount from public.balance_sheet(v_shop, public.shop_local_date())
   where section = 'equity' and label = 'Profit this period';
  if v_amount is null or v_amount <> -1250 then
    raise exception 'FAIL: profit this period reads %, expected the loss of -1250', v_amount;
  end if;
  if v_amount <> (select amount_cents from public.statement_lines(v_shop, '2000-01-01', '2100-01-01')
                   where section = 'net_profit') then
    raise exception 'FAIL: the balance sheet and the income statement disagree about profit';
  end if;

  -- 17. AS-AT BITES, in both directions.
  --
  --     A balance sheet dated before any trading is empty...
  if (select amount_cents from public.balance_sheet(v_shop, '2019-01-01') where section = 'total_assets') <> 0 then
    raise exception 'FAIL: a balance sheet dated before the shop existed is not empty';
  end if;
  if (select amount_cents from public.balance_sheet(v_shop, '2019-01-01')
       where section = 'total_liabilities_equity') <> 0 then
    raise exception 'FAIL: an empty balance sheet has liabilities or equity';
  end if;

  --     ...and one dated the day after the opening entry, but before any
  --     trading, shows the opening position and nothing else. This is the
  --     check that a HARDCODED "everything, always" passes check 17's first
  --     half by accident and fails here.
  if (select amount_cents from public.balance_sheet(v_shop, v_open + 1) where section = 'total_assets') <> 100000 then
    raise exception 'FAIL: the balance sheet the day after the opening entry reads %, expected 100000',
      (select amount_cents from public.balance_sheet(v_shop, v_open + 1) where section = 'total_assets');
  end if;
  if (select amount_cents from public.balance_sheet(v_shop, v_open + 1)
       where section = 'equity' and label = 'Profit this period') <> 0 then
    raise exception 'FAIL: there was no trading before the opening entry, so there is no profit to report';
  end if;
  --     ...and the day BEFORE it is still empty: the bound includes p_as_of.
  if (select amount_cents from public.balance_sheet(v_shop, v_open - 1) where section = 'total_assets') <> 0 then
    raise exception 'FAIL: the balance sheet the day before the opening entry is not empty';
  end if;

  -- 18. THE GATE, again. balance_sheet is security definer, so RLS on
  --     journal_lines does not protect it either.
  perform set_config('request.jwt.claims', json_build_object('sub', v_other)::text, true);
  begin
    perform 1 from public.balance_sheet(v_shop, public.shop_local_date());
    raise exception 'FAIL: a stranger read this shop''s balance sheet';
  exception
    when others then
      if sqlerrm like 'FAIL:%' then raise; end if;
      if sqlerrm <> 'You do not have permission to see the books.' then
        raise exception 'FAIL: the stranger was refused, but by something else: %', sqlerrm;
      end if;
  end;
  perform set_config('request.jwt.claims', json_build_object('sub', v_user)::text, true);

  --     ...and the check above CANNOT tell WHOSE gate refused them, because
  --     balance_sheet calls statement_lines, statement_lines gates on the same
  --     permission with the same message, and security definer does not change
  --     auth.uid(). Deleting balance_sheet's own gate leaves this check green.
  --
  --     That is answered in verify-statement-permissions.sql, which reads
  --     PG_EXCEPTION_CONTEXT's innermost frame and so names the function that
  --     actually raised. A pg_get_functiondef assertion used to sit here as a
  --     stand-in; it has been REMOVED rather than kept alongside, because it
  --     matched the function's source TEXT including its comments and so stayed
  --     green against a gate that had been commented out -- which the final
  --     review demonstrated. A weak check beside a strong one reads as extra
  --     assurance and is the opposite.

  -- =====================================================================
  -- THE CASH FLOW (task 3), indirect method.
  --
  -- The ledger movements it reads, over all time:
  --
  --   1000 Cash          +1950     1100 Receivable   +3450
  --   1200 Inventory     -3500     1510 Furniture    +6400
  --   1590 Accum. dep.    -200     2000 Payables     -6400
  --   2100 Sales tax      -450     2200 Wages         -4000
  --   3000 Capital    -100000      3100 Draw         +1500
  --   P&L accounts, netting to a loss of 1250
  --
  -- Over the ALL-TIME window the statement therefore reads:
  --
  --   Operating   Net profit                       -1250
  --               Add back depreciation             +200   6800's movement
  --               Increase in receivables          -3450   the credit sale
  --               Increase in inventory           -96500   the opening stock
  --               Increase in payables             +6400   the counter, unpaid
  --               Increase in tax & wages payable  +4450   450 tax + 4000 wages
  --               Cash from operations            -90150
  --   Investing   Bought equipment                 -6400
  --               Cash used in investing           -6400
  --   Financing   Owner capital introduced       +100000
  --               Owner drawings                   -1500
  --               Cash used in financing          +98500
  --   NET CHANGE IN CASH                            +1950
  --   Proof       Cash at 31 Dec 1999                  0
  --               Cash at  1 Jan 2100               1950
  --               Movement in cash accounts        +1950
  --
  -- -90150 - 6400 + 98500 = 1950, which is the cash the shop actually holds.
  -- That equality is check 20 and it is the whole point of the statement.
  -- =====================================================================

  -- 19. Net profit is the opening line of the operating section. Second of the
  --     five reconciliations. The cash flow must CALL statement_lines rather
  --     than re-derive a profit figure, for the same reason the balance sheet
  --     does.
  if (select amount_cents from public.cash_flow(v_shop, '2000-01-01', '2100-01-01')
       where section = 'operating' and label = 'Net profit')
     is distinct from (select amount_cents from public.statement_lines(v_shop, '2000-01-01', '2100-01-01')
          where section = 'net_profit') then
    raise exception 'FAIL: the cash flow and the income statement disagree about net profit';
  end if;

  -- 20. THE PROOF. Net change in cash equals the movement in the cash
  --     accounts, OBSERVED rather than assembled. The indirect method's whole
  --     risk is that it is built from deltas -- net profit plus six
  --     adjustments, any of which can carry the wrong sign -- and every one of
  --     those slips lands here.
  if (select amount_cents from public.cash_flow(v_shop, '2000-01-01', '2100-01-01') where section = 'net_change')
     is distinct from (select amount_cents from public.cash_flow(v_shop, '2000-01-01', '2100-01-01')
          where section = 'proof' and label = 'Movement in cash accounts') then
    raise exception 'FAIL: the cash flow does not prove out -- net change % against observed movement %',
      (select amount_cents from public.cash_flow(v_shop, '2000-01-01', '2100-01-01') where section = 'net_change'),
      (select amount_cents from public.cash_flow(v_shop, '2000-01-01', '2100-01-01')
        where section = 'proof' and label = 'Movement in cash accounts');
  end if;

  --     ...and it proves out at 1950, not at zero. Check 20 alone passes
  --     against a function that returns zero for everything.
  select amount_cents into v_amount from public.cash_flow(v_shop, '2000-01-01', '2100-01-01')
   where section = 'net_change';
  if v_amount is distinct from 1950 then
    raise exception 'FAIL: net change in cash is %, expected 1950', v_amount;
  end if;

  -- 21. Closing cash on the cash flow IS the balance sheet's cash. Third
  --     reconciliation, and the one that ties the statement of flows to the
  --     statement of position.
  if (select amount_cents from public.cash_flow(v_shop, '2000-01-01', '2100-01-01')
       where section = 'proof' and label like 'Cash at%' order by sort_order desc limit 1)
     is distinct from (select coalesce(sum(amount_cents), 0) from public.balance_sheet(v_shop, public.shop_local_date())
          where code in ('1000', '1010', '1020', '1021')) then
    raise exception 'FAIL: the cash flow and the balance sheet disagree about closing cash';
  end if;

  -- 22. THE SIGN CONVENTION, asserted row by row. An increase in an ASSET
  --     consumes cash and must present NEGATIVE; an increase in a LIABILITY
  --     provides it and must present POSITIVE. Getting either backwards is
  --     the single most common defect in an indirect cash flow, and check 20
  --     cannot say WHICH row slipped -- only that something did.
  select amount_cents into v_amount from public.cash_flow(v_shop, '2000-01-01', '2100-01-01')
   where section = 'operating' and label = 'Increase in inventory';
  if v_amount is distinct from -96500 then
    raise exception 'FAIL: increase in inventory reads %, expected -96500 (stock consumes cash)', v_amount;
  end if;
  select amount_cents into v_amount from public.cash_flow(v_shop, '2000-01-01', '2100-01-01')
   where section = 'operating' and label = 'Increase in payables';
  if v_amount is distinct from 6400 then
    raise exception 'FAIL: increase in payables reads %, expected 6400 (an unpaid bill keeps cash)', v_amount;
  end if;

  --     The other two rows of the pair, and the reason this fixture sells on
  --     credit and accrues a wage at all: without them both read a zero that
  --     no sign error can disturb.
  select amount_cents into v_amount from public.cash_flow(v_shop, '2000-01-01', '2100-01-01')
   where section = 'operating' and label = 'Increase in receivables';
  if v_amount is distinct from -3450 then
    raise exception 'FAIL: increase in receivables reads %, expected -3450 (a customer who has not paid is cash you do not have)', v_amount;
  end if;
  select amount_cents into v_amount from public.cash_flow(v_shop, '2000-01-01', '2100-01-01')
   where section = 'operating' and label = 'Increase in tax & wages payable';
  if v_amount is distinct from 4450 then
    raise exception 'FAIL: increase in tax & wages payable reads %, expected 4450 (450 of tax and 4000 of wages, both owed and unpaid)', v_amount;
  end if;

  --     Depreciation is added BACK: it reduced net profit but no cash left.
  --     It is 6800's movement, and until phase 3c ships run_depreciation no
  --     shop will post one -- this fixture does, by hand, so that the row is
  --     exercised rather than trivially zero.
  select amount_cents into v_amount from public.cash_flow(v_shop, '2000-01-01', '2100-01-01')
   where section = 'operating' and label = 'Add back depreciation';
  if v_amount is distinct from 200 then
    raise exception 'FAIL: add back depreciation reads %, expected +200', v_amount;
  end if;

  --     ...and the six adjustments sum to cash from operations.
  select amount_cents into v_amount from public.cash_flow(v_shop, '2000-01-01', '2100-01-01')
   where section = 'operating' and is_total;
  if v_amount is distinct from -90150 then
    raise exception 'FAIL: cash from operations is %, expected -90150', v_amount;
  end if;
  if (select coalesce(sum(amount_cents), 0) from public.cash_flow(v_shop, '2000-01-01', '2100-01-01')
       where section = 'operating' and not is_total) <> v_amount then
    raise exception 'FAIL: the operating rows do not sum to cash from operations';
  end if;

  -- 23. INVESTING IS EXERCISED. The fixture buys the counter ON CREDIT, so no
  --     cash leaves for it -- and the section still has to carry -6400,
  --     because the +6400 in payables is what cancels it. Dropping the
  --     investing section leaves the payables row uncancelled and check 20
  --     goes red by 6400. Asserted on the figure as well, so a reader can see
  --     which side moved.
  --
  --     1590 Accumulated Depreciation is deliberately NOT in the 1500-1589
  --     range this section sums: it is not a cash movement, and it is already
  --     accounted for by the add-back above. Counting it here would report
  --     investing of -6200 and stop proving out.
  select amount_cents into v_amount from public.cash_flow(v_shop, '2000-01-01', '2100-01-01')
   where section = 'investing' and is_total;
  if v_amount is distinct from -6400 then
    raise exception 'FAIL: cash used in investing is %, expected -6400 (-6200 = 1590 was counted as investing)', v_amount;
  end if;

  --     Financing is 3000 AND 3100, not the draw alone. Over all time the
  --     opening capital of 100000 is a financing inflow, and a function that
  --     read only the draw would report a net change of -98500.
  select amount_cents into v_amount from public.cash_flow(v_shop, '2000-01-01', '2100-01-01')
   where section = 'financing' and is_total;
  if v_amount is distinct from 98500 then
    raise exception 'FAIL: cash from financing is %, expected 98500 (-1500 = capital introduced was ignored)', v_amount;
  end if;
  if (select amount_cents from public.cash_flow(v_shop, '2000-01-01', '2100-01-01')
       where section = 'financing' and label = 'Owner drawings') is distinct from -1500 then
    raise exception 'FAIL: owner drawings does not read -1500';
  end if;

  -- 24. OPENING CASH IS THE BALANCE AT p_from MINUS ONE DAY, not at p_from.
  --
  --     This CANNOT be asserted on the all-time window: nothing happened on
  --     1 Jan 2000, so opening cash is zero read either way and the mutation
  --     is invisible. Every entry in this fixture is dated either today or 40
  --     days back, so the window that bites is TODAY TO TODAY -- opening cash
  --     is 0 the day before and 1950 on the day itself.
  --
  --       Operating   net profit          -1250
  --                   depreciation         +200
  --                   receivables         -3450
  --                   inventory           +3500   (stock FELL today)
  --                   payables            +6400
  --                   tax & wages         +4450
  --                                     -------
  --                                       9850
  --       Investing   -6400        Financing  -1500
  --       Net change   9850 - 6400 - 1500               =  1950
  --
  --     Note the inventory row FLIPS SIGN between the two windows -- stock
  --     fell by 3500 today, so it RELEASED cash -- which is the second reason
  --     this window is worth its own check.
  if (select amount_cents from public.cash_flow(v_shop, public.shop_local_date(), public.shop_local_date())
       where section = 'proof' and label like 'Cash at%' order by sort_order limit 1) is distinct from 0 then
    raise exception 'FAIL: opening cash for a window starting today is %, expected 0 -- it is the balance the day BEFORE p_from',
      (select amount_cents from public.cash_flow(v_shop, public.shop_local_date(), public.shop_local_date())
        where section = 'proof' and label like 'Cash at%' order by sort_order limit 1);
  end if;
  if (select amount_cents from public.cash_flow(v_shop, public.shop_local_date(), public.shop_local_date())
       where section = 'net_change')
     is distinct from (select amount_cents from public.cash_flow(v_shop, public.shop_local_date(), public.shop_local_date())
          where section = 'proof' and label = 'Movement in cash accounts') then
    raise exception 'FAIL: the one-day cash flow does not prove out -- net change % against observed movement %',
      (select amount_cents from public.cash_flow(v_shop, public.shop_local_date(), public.shop_local_date())
        where section = 'net_change'),
      (select amount_cents from public.cash_flow(v_shop, public.shop_local_date(), public.shop_local_date())
        where section = 'proof' and label = 'Movement in cash accounts');
  end if;
  if (select amount_cents from public.cash_flow(v_shop, public.shop_local_date(), public.shop_local_date())
       where section = 'operating' and label = 'Increase in inventory') is distinct from 3500 then
    raise exception 'FAIL: today alone, stock FELL by 3500 and released cash -- the row should read +3500, it reads %',
      (select amount_cents from public.cash_flow(v_shop, public.shop_local_date(), public.shop_local_date())
        where section = 'operating' and label = 'Increase in inventory');
  end if;
  if (select amount_cents from public.cash_flow(v_shop, public.shop_local_date(), public.shop_local_date())
       where section = 'operating' and is_total) is distinct from 9850 then
    raise exception 'FAIL: cash from operations today is %, expected 9850',
      (select amount_cents from public.cash_flow(v_shop, public.shop_local_date(), public.shop_local_date())
        where section = 'operating' and is_total);
  end if;

  --     ...and a window with no trading at all is flat, every row of it.
  if exists (select 1 from public.cash_flow(v_shop, '2019-01-01', '2019-12-31') where amount_cents <> 0) then
    raise exception 'FAIL: a window with no trading returned a cash flow';
  end if;

  -- 25. THE GATE. cash_flow is security definer like the other two, so RLS on
  --     journal_lines does not protect it.
  perform set_config('request.jwt.claims', json_build_object('sub', v_other)::text, true);
  begin
    perform 1 from public.cash_flow(v_shop, '2000-01-01', '2100-01-01');
    raise exception 'FAIL: a stranger read this shop''s cash flow';
  exception
    when others then
      if sqlerrm like 'FAIL:%' then raise; end if;
      if sqlerrm <> 'You do not have permission to see the books.' then
        raise exception 'FAIL: the stranger was refused, but by something else: %', sqlerrm;
      end if;
  end;
  perform set_config('request.jwt.claims', json_build_object('sub', v_user)::text, true);

  --     ...and, exactly as for balance_sheet, the behavioural check above
  --     cannot tell whose gate refused them: cash_flow calls statement_lines,
  --     which gates on the same permission with the same message. That is
  --     answered by the frame assertion in verify-statement-permissions.sql,
  --     not by reading this function's source.

  -- =====================================================================
  -- 26. THE FIVE RECONCILIATIONS, ASSERTED TOGETHER (task 5).
  --
  -- Checks 1-25 each assert ONE statement. Every one of them can pass while
  -- the three reports contradict each other, because each report balances on
  -- its own: an income statement that is internally consistent, a balance
  -- sheet that balances, and a cash flow that proves out are three separate
  -- facts, and none of them is the fact that the three agree. A totals check
  -- cannot see the difference. This is the block that can.
  --
  -- Stated as the mockup states them to the reader:
  --
  --   1. income statement net profit  =  balance sheet "Profit this period"
  --   2. income statement net profit  =  cash flow's operating opening line
  --   3. income statement net profit  =  revenue + cost_of_sales + expense,
  --                                      netted straight off journal_lines
  --   4. balance sheet total assets   =  total liabilities and equity
  --   5. cash flow closing cash       =  balance sheet cash
  --
  -- Note the window. balance_sheet() reads statement_lines('-infinity', p_as_of)
  -- and cash_flow() reads statement_lines(p_from, p_to), so the income
  -- statement here is taken over the all-time window that contains every entry
  -- in this fixture -- the same rows all three functions see. A narrower
  -- window would make reconciliations 1 and 2 fail for a reason that is not a
  -- defect.
  --
  -- Expected, against the fixture as it now stands: net profit -1250, total
  -- assets 108100 = total liabilities and equity, cash 1950.
  -- =====================================================================

  select amount_cents into v_is_profit from public.statement_lines(v_shop, '2000-01-01', '2100-01-01')
   where section = 'net_profit';

  select amount_cents into v_bs_profit from public.balance_sheet(v_shop, public.shop_local_date())
   where section = 'equity' and label = 'Profit this period';

  select amount_cents into v_cf_profit from public.cash_flow(v_shop, '2000-01-01', '2100-01-01')
   where section = 'operating' and label = 'Net profit';

  --   RECONCILIATION 3'S DERIVATION, and the reason this block is worth
  --   writing. It is computed HERE, off journal_lines, and never calls
  --   statement_lines(): a check that asks the same function twice and finds
  --   it agrees with itself proves nothing at all. This is the trial balance's
  --   arithmetic, done the other way round -- one sum over all three P&L
  --   types, negated once, rather than a revenue flip plus two cost sections.
  --
  --   journal_lines is debit-positive, so revenue sums negative and costs sum
  --   positive; the net of all three, negated, is profit. If this and
  --   statement_lines() disagree, statement_lines() is wrong.
  select -coalesce(sum(l.amount_cents), 0)::bigint, count(*)
    into v_tb_profit, v_tb_lines
    from public.journal_lines l
    join public.journal_entries e on e.id = l.entry_id
    join public.accounts a on a.id = l.account_id
   where e.shop_id = v_shop
     and e.status in ('posted', 'reversed')
     and e.entry_date between '2000-01-01' and '2100-01-01'
     and a.type in ('revenue', 'cost_of_sales', 'expense');

  --   ...and the derivation is only worth anything if it saw rows. Under
  --   `set role authenticated` this select is subject to RLS on journal_lines,
  --   accounts and journal_entries; a policy change that hid them all would
  --   leave v_tb_profit at 0 and this reconciliation would then be asserting
  --   that zero equals zero for a shop that trades.
  if v_tb_lines = 0 then
    raise exception 'FAIL: the independent derivation read no journal lines at all, so reconciliation 3 is vacuous';
  end if;

  select amount_cents into v_bs_assets from public.balance_sheet(v_shop, public.shop_local_date())
   where section = 'total_assets';
  select amount_cents into v_bs_credits from public.balance_sheet(v_shop, public.shop_local_date())
   where section = 'total_liabilities_equity';
  select coalesce(sum(amount_cents), 0) into v_bs_cash from public.balance_sheet(v_shop, public.shop_local_date())
   where code in ('1000', '1010', '1020', '1021');
  select amount_cents into v_cf_cash from public.cash_flow(v_shop, '2000-01-01', '2100-01-01')
   where section = 'proof' and label like 'Cash at%' order by sort_order desc limit 1;

  --   Nothing below can reconcile a NULL against a NULL and call it agreement.
  if v_is_profit is null or v_bs_profit is null or v_cf_profit is null
     or v_bs_assets is null or v_bs_credits is null or v_cf_cash is null then
    raise exception 'FAIL: a figure the reconciliations need is missing -- income %, balance sheet %, cash flow %, assets %, liabilities+equity %, closing cash %',
      v_is_profit, v_bs_profit, v_cf_profit, v_bs_assets, v_bs_credits, v_cf_cash;
  end if;

  -- 26.1 Income statement net profit = balance sheet "Profit this period".
  if v_is_profit <> v_bs_profit then
    raise exception 'FAIL: reconciliation 1 -- income statement net profit % against balance sheet profit this period %, off by %',
      v_is_profit, v_bs_profit, v_is_profit - v_bs_profit;
  end if;

  -- 26.2 Income statement net profit = the cash flow's operating opening line.
  if v_is_profit <> v_cf_profit then
    raise exception 'FAIL: reconciliation 2 -- income statement net profit % against cash flow net profit %, off by %',
      v_is_profit, v_cf_profit, v_is_profit - v_cf_profit;
  end if;

  -- 26.3 Income statement net profit = the trial balance's revenue,
  --      cost_of_sales and expense accounts netted. THE ONE WITH TEETH:
  --      26.1 and 26.2 compare statement_lines() against two functions that
  --      CALL statement_lines(), by design, so they hold by construction and
  --      go green against any net profit whatsoever. This one does not.
  if v_is_profit <> v_tb_profit then
    raise exception 'FAIL: reconciliation 3 -- income statement net profit % against the trial balance netted independently %, off by % (over % journal lines)',
      v_is_profit, v_tb_profit, v_is_profit - v_tb_profit, v_tb_lines;
  end if;

  --      ...and it reconciles at the fixture's figure, not at zero. Two
  --      derivations that are both empty agree perfectly.
  if v_is_profit <> -1250 then
    raise exception 'FAIL: the three statements agree on a net profit of %, but the fixture makes a loss of -1250', v_is_profit;
  end if;

  -- 26.4 Balance sheet total assets = total liabilities and equity.
  if v_bs_assets <> v_bs_credits then
    raise exception 'FAIL: reconciliation 4 -- total assets % against total liabilities and equity %, off by %',
      v_bs_assets, v_bs_credits, v_bs_assets - v_bs_credits;
  end if;
  if v_bs_assets <> 108100 then
    raise exception 'FAIL: the balance sheet balances at %, but the fixture''s assets are 108100', v_bs_assets;
  end if;

  -- 26.5 Cash flow closing cash = balance sheet cash. The two statements are
  --      read side by side on the same screen and this is the figure a reader
  --      compares by eye first.
  if v_cf_cash <> v_bs_cash then
    raise exception 'FAIL: reconciliation 5 -- cash flow closing cash % against balance sheet cash %, off by %',
      v_cf_cash, v_bs_cash, v_cf_cash - v_bs_cash;
  end if;
  if v_cf_cash <> 1950 then
    raise exception 'FAIL: both statements agree cash is %, but the fixture holds 1950', v_cf_cash;
  end if;

  -- =====================================================================
  -- 27. THE SECOND SHOP: the tenant boundary, the balance sheet's missing
  --     lower bound, and the fixed-asset range the two statements must share.
  --
  --     Three findings meet in one fixture because they need the same thing --
  --     books that are not shop A's:
  --
  --     (a) TENANCY. All three functions are security definer, so RLS does not
  --         apply inside them and `shop_id` scoping is the only boundary. The
  --         detector is checks 1-26: shop B's figures are an order of
  --         magnitude away from shop A's, so any leak moves a pinned number.
  --         Worth stating precisely, because two of the three functions are
  --         scoped TWICE and neither filter is individually observable.
  --         balance_sheet() and cash_flow() filter the ledger on
  --         `e.shop_id = p_shop_id` AND join `accounts` filtered on
  --         `a.shop_id = p_shop_id`, then LEFT JOIN the two on `account_id`.
  --         An account belongs to exactly one shop, so either filter alone
  --         confines the result: deleting `e.shop_id` leaves the account join
  --         holding the line, deleting `a.shop_id` merges another shop's
  --         account rows in at zero, which changes no total. Delete BOTH and
  --         shop B's cash lands in shop A's balance sheet -- verified, and it
  --         reddens. That is defence in depth rather than a hole here, but it
  --         is worth writing down: a reviewer mutating one filter at a time
  --         will read the green as "untested" and be wrong.
  --         statement_lines() has only the entry-level filter, and removing
  --         that one alone reddens check 4.
  --
  --     (b) THE LOWER BOUND. balance_sheet() reads
  --         statement_lines('-infinity', p_as_of). Every P&L entry in shop A
  --         is dated today, so narrowing that to (p_as_of, p_as_of) changed
  --         nothing. Shop B's rent is 40 days old, and profit this period must
  --         still carry it.
  --
  --     (c) THE RANGE. balance_sheet() calls 1500-1599 fixed; cash_flow()'s
  --         investing section was written 1500-1589. Shop B's van is 1595, so
  --         the two disagreed by 50000 and the proof stopped tying.
  --
  --     Shop B's books, and every figure they produce:
  --
  --       1000 Cash    77000 - 9100 - 50000 = 17900
  --       1595 Vehicles                       50000
  --       TOTAL ASSETS                        67900
  --       3000 Capital                        77000
  --       Profit this period                  -9100   the rent, 40 days back
  --       TOTAL L + E                         67900
  --
  --       Cash flow, all time: operations -9100, investing -50000,
  --       financing +77000, net change 17900 = the cash it holds.
  -- =====================================================================
  perform set_config('request.jwt.claims', json_build_object('sub', v_other)::text, true);

  select amount_cents into v_amount from public.statement_lines(v_shop_b, '2000-01-01', '2100-01-01')
   where section = 'net_profit';
  if v_amount is distinct from -9100 then
    raise exception 'FAIL: the other shop''s net profit is %, expected -9100 -- shop A''s books have reached it', v_amount;
  end if;

  --  (b) THE LOWER BOUND BITES. The rent is 40 days old and is the only P&L
  --      entry in this file that is not dated today. A balance sheet that
  --      windowed its profit to p_as_of reads 0 here and still balances -- at
  --      77000 instead of 67900, which is why the total is asserted too.
  select amount_cents into v_amount from public.balance_sheet(v_shop_b, public.shop_local_date())
   where section = 'equity' and label = 'Profit this period';
  if v_amount is distinct from -9100 then
    raise exception 'FAIL: the other shop''s profit this period is %, expected -9100 -- the rent 40 days back must still count, so the lower bound must be -infinity', v_amount;
  end if;
  if (select amount_cents from public.balance_sheet(v_shop_b, public.shop_local_date())
       where section = 'total_assets') is distinct from 67900 then
    raise exception 'FAIL: the other shop''s total assets is %, expected 67900',
      (select amount_cents from public.balance_sheet(v_shop_b, public.shop_local_date()) where section = 'total_assets');
  end if;
  if (select amount_cents from public.balance_sheet(v_shop_b, public.shop_local_date())
       where section = 'total_assets')
     is distinct from (select amount_cents from public.balance_sheet(v_shop_b, public.shop_local_date())
          where section = 'total_liabilities_equity') then
    raise exception 'FAIL: the other shop''s balance sheet does not balance -- % against %',
      (select amount_cents from public.balance_sheet(v_shop_b, public.shop_local_date()) where section = 'total_assets'),
      (select amount_cents from public.balance_sheet(v_shop_b, public.shop_local_date()) where section = 'total_liabilities_equity');
  end if;

  --  (c) THE RANGE. 1595 is fixed on the balance sheet AND investing on the
  --      cash flow, or the proof does not tie. A cash flow reading 1500-1589
  --      reports investing of 0 and a net change of 67900 against an observed
  --      movement of 17900.
  if not exists (select 1 from public.balance_sheet(v_shop_b, public.shop_local_date())
                  where code = '1595' and section = 'fixed_assets') then
    raise exception 'FAIL: 1595 Vehicles is not under fixed assets (it is %)',
      coalesce((select section from public.balance_sheet(v_shop_b, public.shop_local_date()) where code = '1595'), 'absent');
  end if;
  select amount_cents into v_amount from public.cash_flow(v_shop_b, '2000-01-01', '2100-01-01')
   where section = 'investing' and is_total;
  if v_amount is distinct from -50000 then
    raise exception 'FAIL: the other shop''s investing is %, expected -50000 (0 = the van at 1595 fell outside cash_flow''s fixed-asset range while balance_sheet counted it)', v_amount;
  end if;
  if (select amount_cents from public.cash_flow(v_shop_b, '2000-01-01', '2100-01-01') where section = 'net_change')
     is distinct from (select amount_cents from public.cash_flow(v_shop_b, '2000-01-01', '2100-01-01')
          where section = 'proof' and label = 'Movement in cash accounts') then
    raise exception 'FAIL: the other shop''s cash flow does not prove out -- net change % against observed movement %',
      (select amount_cents from public.cash_flow(v_shop_b, '2000-01-01', '2100-01-01') where section = 'net_change'),
      (select amount_cents from public.cash_flow(v_shop_b, '2000-01-01', '2100-01-01')
        where section = 'proof' and label = 'Movement in cash accounts');
  end if;
  if (select amount_cents from public.cash_flow(v_shop_b, '2000-01-01', '2100-01-01')
       where section = 'net_change') is distinct from 17900 then
    raise exception 'FAIL: the other shop''s net change in cash is %, expected 17900',
      (select amount_cents from public.cash_flow(v_shop_b, '2000-01-01', '2100-01-01') where section = 'net_change');
  end if;

  perform set_config('request.jwt.claims', json_build_object('sub', v_user)::text, true);

  -- =====================================================================
  -- 28. THE PROOF FAILS WHEN AN UNACCOUNTED ACCOUNT MOVES. LAST, because it
  --     posts an entry the checks above must not see.
  --
  --     cash_flow() names the accounts each section reads, so an account that
  --     is neither cash, nor P&L, nor in one of those lists is UNACCOUNTED
  --     FOR: today that set is {2300 Loyalty Points Liability, 3900 Retained
  --     Earnings} plus anything a shop adds itself. The design's position is
  --     that the proof row is the right place for this to surface, and that a
  --     residual "other movements" line would be worse -- it would make the
  --     statement tie by construction and destroy the only check that can
  --     catch a sign error.
  --
  --     That is an argument, and until now it was only an argument: nothing
  --     demonstrated the proof CAN fail. Here it is. Dr 6100 / Cr 2300 for
  --     1200 puts 1200 into net profit as a cost and 1200 into a liability no
  --     section reads, so net change falls by 1200 while the observed cash
  --     movement -- which no part of the arithmetic touches -- does not move
  --     at all.
  --
  --     This was also written as 3b's collision in miniature -- "the period
  --     close posts to 3900, and any cash-flow window spanning a close will
  --     fail here by exactly the amount closed until the statement gains a
  --     section for it". That prediction was HALF right, and the half that was
  --     wrong is worth recording rather than quietly deleting.
  --
  --     3900 does move, and no cash-flow section reads it. But 20261002000000
  --     excludes source = 'close' from statement_lines(), which adds the SAME
  --     amount back into the net profit this statement opens with: the closing
  --     entry's P&L lines and its 3900 line are each other's negation, because
  --     the entry balances. They cancel, the proof ties across a close with no
  --     new section, and verify-statements-across-a-close.sql check 6.6 asserts
  --     exactly that -- including that no sixth section has appeared.
  --
  --     2300 is therefore still the whole of the unaccounted set, and this
  --     negative test still bites. It is the ONE below that would go green if
  --     somebody added the residual line the design argues against.
  perform public.post_journal_entry(v_shop, public.shop_local_date(), 'Loyalty points accrued',
    jsonb_build_array(
      jsonb_build_object('code', '6100', 'amount_cents',  1200),
      jsonb_build_object('code', '2300', 'amount_cents', -1200)),
    v_loc);

  if (select amount_cents from public.cash_flow(v_shop, '2000-01-01', '2100-01-01')
       where section = 'proof' and label = 'Movement in cash accounts') is distinct from 1950 then
    raise exception 'FAIL: the OBSERVED cash movement changed when 2300 moved -- it is read straight off the cash accounts and nothing here touched them; it reads %',
      (select amount_cents from public.cash_flow(v_shop, '2000-01-01', '2100-01-01')
        where section = 'proof' and label = 'Movement in cash accounts');
  end if;
  if (select amount_cents from public.cash_flow(v_shop, '2000-01-01', '2100-01-01')
       where section = 'net_change') is distinct from 750 then
    raise exception 'FAIL: net change should have fallen to 750 when 1200 went into an unaccounted liability, it reads %',
      (select amount_cents from public.cash_flow(v_shop, '2000-01-01', '2100-01-01') where section = 'net_change');
  end if;
  if (select amount_cents from public.cash_flow(v_shop, '2000-01-01', '2100-01-01') where section = 'net_change')
     = (select amount_cents from public.cash_flow(v_shop, '2000-01-01', '2100-01-01')
         where section = 'proof' and label = 'Movement in cash accounts') then
    raise exception 'FAIL: 1200 moved through 2300, which NO cash-flow section reads, and the statement still proved out. Either a residual line has been added -- which makes the proof tautological -- or 2300 has quietly been folded into a section.';
  end if;

  -- =====================================================================
  -- 29. THE FIVE RECONCILIATIONS ON A SHOP THAT USED PHASE 3C (task 5).
  --
  --     Checks 1-28 prove the statements against a fixture whose fixed asset
  --     and whose depreciation charge are HAND-WRITTEN journal entries. That was
  --     the only way to exercise those rows before 3c shipped, and it has two
  --     limits this block exists to remove:
  --
  --       * the register cannot be tied to the ledger, because shop A's 1510
  --         balance corresponds to no fixed_assets row at all; and
  --       * the investing section and the depreciation add-back are exercised
  --         only against lines someone wrote to make them non-zero, which is
  --         the thing this file's opening paragraph says proves nothing.
  --
  --     So: two more shops, C and D, whose ENTIRE fixed-asset position is
  --     created by create_fixed_asset, run_depreciation, dispose_fixed_asset
  --     and transfer_funds. Every figure below is a consequence of those calls.
  --
  --     WHY TWO, AND WHY INTERLEAVED. A second shop is necessary and it is not
  --     sufficient. Dropping BOTH tenant filters from run_depreciation left the
  --     suite green once before, because every run in the script happened before
  --     the other shop had any asset to steal -- the filters were untested for
  --     an ordering reason, not a coverage one. The sequence below therefore
  --     alternates: D owns an asset before C's first run, C owns two before D's
  --     second, and each shop's totals are asserted. An unfiltered run charges
  --     the other shop's asset into its own 6800 AND consumes the
  --     (asset_id, charge_month) row the rightful owner's later run needs, so
  --     both shops move and in opposite directions.
  --
  --     Placed after check 28 rather than before it: 28 posts into shop A only,
  --     and these are different shops, so neither can disturb the other.
  -- =====================================================================
  perform set_config('role', 'postgres', true);
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
    select u, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
           'verify-statements-' || u || '@example.test', '', now(), now(), now()
      from unnest(array[v_user_c, v_user_d]) u;
  insert into public.shops (owner_id, name) values (v_user_c, 'QA Register Shop') returning id into v_shop_c;
  insert into public.shop_locations (shop_id, name, is_primary) values (v_shop_c, 'Main', true)
    returning id into v_loc_c;
  insert into public.shops (owner_id, name) values (v_user_d, 'QA Register Shop Two') returning id into v_shop_d;
  insert into public.shop_locations (shop_id, name, is_primary) values (v_shop_d, 'Main', true)
    returning id into v_loc_d;
  perform set_config('role', 'authenticated', true);

  --     Both months are derived from shop_local_date(), never from a literal
  --     and never from now()::date. run_depreciation charges COMPLETE months
  --     only and clamps to the first day of last month, so a fixture that dated
  --     an acquisition "40 days back" would take one charge in some months of
  --     the year and two in others, and the expected figures below would be
  --     right roughly half the time. These two are the only dates used.
  v_m1 := (date_trunc('month', public.shop_local_date()) - interval '1 month')::date;
  v_m2 := (date_trunc('month', public.shop_local_date()) - interval '2 months')::date;

  --     C: 80000 of capital, in cash, two months back.
  perform set_config('request.jwt.claims', json_build_object('sub', v_user_c)::text, true);
  perform public.post_journal_entry(v_shop_c, v_m2, 'Opening capital',
    jsonb_build_array(
      jsonb_build_object('code', '1000', 'amount_cents',  80000),
      jsonb_build_object('code', '3000', 'amount_cents', -80000)),
    v_loc_c, 'opening');

  --     D FIRST, so that D owns an asset before C ever runs depreciation.
  perform set_config('request.jwt.claims', json_build_object('sub', v_user_d)::text, true);
  perform public.post_journal_entry(v_shop_d, v_m2, 'Opening capital',
    jsonb_build_array(
      jsonb_build_object('code', '1000', 'amount_cents',  250000),
      jsonb_build_object('code', '3000', 'amount_cents', -250000)),
    v_loc_d, 'opening');
  --     36000 over 12 months = 3000 a month, paid out of the till.
  v_oven := public.create_fixed_asset(v_shop_d, 'QA Oven', 36000, v_m2, 12, '1000', '1500');

  --     C buys a fridge: 9600 over 24 months = 400 a month, paid out of the
  --     till, so investing carries a CASH outflow and not only an accrual.
  perform set_config('request.jwt.claims', json_build_object('sub', v_user_c)::text, true);
  v_fridge := public.create_fixed_asset(v_shop_c, 'QA Fridge', 9600, v_m2, 24, '1000', '1500');

  --     D RUNS FIRST, while C's fridge exists and has never been charged. An
  --     unfiltered run takes it, and C's own run below then finds the month
  --     already charged and reads 600 instead of 1800.
  perform set_config('request.jwt.claims', json_build_object('sub', v_user_d)::text, true);
  v_runs := public.run_depreciation(v_shop_d, null);
  if v_runs <> 2 then
    raise exception 'FAIL: shop D''s first run wrote % entries, expected 2 (one for each complete month the oven has been owned)', v_runs;
  end if;

  --     C buys shelving on CREDIT: 7200 over 12 months = 600 a month, into 1510
  --     rather than 1500, so more than one account in the range is exercised.
  perform set_config('request.jwt.claims', json_build_object('sub', v_user_c)::text, true);
  v_shelf := public.create_fixed_asset(v_shop_c, 'QA Shelving', 7200, v_m1, 12, null, '1510');

  --     D buys a till counter on credit, 24000 over 24 months = 1000 a month.
  perform set_config('request.jwt.claims', json_build_object('sub', v_user_d)::text, true);
  v_till := public.create_fixed_asset(v_shop_d, 'QA Till Counter', 24000, v_m1, 24, null, '1500');

  --     NOW C runs, with two of D's assets sitting there and one of them
  --     uncharged. Two entries: 400 for the month before last (the fridge
  --     alone), 1000 for last month (fridge 400 + shelving 600).
  perform set_config('request.jwt.claims', json_build_object('sub', v_user_c)::text, true);
  v_runs := public.run_depreciation(v_shop_c, null);
  if v_runs <> 2 then
    raise exception 'FAIL: shop C''s run wrote % entries, expected 2 -- if it is 3 or more, run_depreciation is charging another shop''s assets', v_runs;
  end if;

  --     D runs again. IDEMPOTENCY, in the same breath as the tenant filter: the
  --     oven's two months are already charged and must not be charged twice, so
  --     exactly one entry is due -- last month, for the counter.
  perform set_config('request.jwt.claims', json_build_object('sub', v_user_d)::text, true);
  v_runs := public.run_depreciation(v_shop_d, null);
  if v_runs <> 1 then
    raise exception 'FAIL: shop D''s second run wrote % entries, expected 1 (the counter''s first month; the oven''s two months are already charged)', v_runs;
  end if;

  --     D SELLS THE COUNTER for 12800 into the bank. This is the case that
  --     found 3c's third unread account: a disposal DEBITS 1590, and while the
  --     investing section excluded 1590 that debit was read by no section of the
  --     cash flow at all and the proof failed by exactly it. Cost 24000 less
  --     1000 of accumulated depreciation is a book value of 23000; 12800 of
  --     proceeds makes a loss of 10200 into 6900.
  perform public.dispose_fixed_asset(v_till, public.shop_local_date(), 12800, '1010');

  --     C pays a month's rent, so that net profit is not depreciation alone and
  --     reconciliation 3 has something other than 6800 to net.
  perform set_config('request.jwt.claims', json_build_object('sub', v_user_c)::text, true);
  perform public.post_journal_entry(v_shop_c, v_m1, 'Rent, paid',
    jsonb_build_array(
      jsonb_build_object('code', '6000', 'amount_cents',  3300),
      jsonb_build_object('code', '1000', 'amount_cents', -3300)),
    v_loc_c);

  -- ---------------------------------------------------------------------
  -- 29.1 A TRANSFER MOVES NOTHING ON ANY STATEMENT.
  --
  --      Both legs are cash, so net profit, total assets and the cash flow's
  --      net change must all read exactly what they read before it. Task 1
  --      established that a Dr/Cr swap leaves the proof IDENTICAL -- the two
  --      lines cancel inside the same total -- so the proof cannot catch a
  --      transfer posted backwards and the two ACCOUNT BALANCES are what
  --      catch it. Both are asserted: the three totals must not move, and
  --      1000 must fall by exactly what 1010 rises by.
  -- ---------------------------------------------------------------------
  select amount_cents into v_t_profit from public.statement_lines(v_shop_c, '2000-01-01', '2100-01-01')
   where section = 'net_profit';
  select amount_cents into v_t_assets from public.balance_sheet(v_shop_c, public.shop_local_date())
   where section = 'total_assets';
  select amount_cents into v_t_change from public.cash_flow(v_shop_c, '2000-01-01', '2100-01-01')
   where section = 'net_change';
  select coalesce(sum(amount_cents) filter (where code = '1000'), 0),
         coalesce(sum(amount_cents) filter (where code = '1010'), 0)
    into v_t_1000, v_t_1010
    from public.balance_sheet(v_shop_c, public.shop_local_date());

  if v_t_1000 <> 67100 or v_t_1010 <> 0 then
    raise exception 'FAIL: before the transfer shop C holds % in the till and % in the bank, expected 67100 and 0',
      v_t_1000, v_t_1010;
  end if;

  perform public.transfer_funds(v_shop_c, '1000', '1010', 1350, public.shop_local_date(), 'QA banking the float');

  if (select amount_cents from public.statement_lines(v_shop_c, '2000-01-01', '2100-01-01')
       where section = 'net_profit') is distinct from v_t_profit then
    raise exception 'FAIL: a transfer changed net profit, from % to %', v_t_profit,
      (select amount_cents from public.statement_lines(v_shop_c, '2000-01-01', '2100-01-01') where section = 'net_profit');
  end if;
  if (select amount_cents from public.balance_sheet(v_shop_c, public.shop_local_date())
       where section = 'total_assets') is distinct from v_t_assets then
    raise exception 'FAIL: a transfer changed total assets, from % to %', v_t_assets,
      (select amount_cents from public.balance_sheet(v_shop_c, public.shop_local_date()) where section = 'total_assets');
  end if;
  if (select amount_cents from public.cash_flow(v_shop_c, '2000-01-01', '2100-01-01')
       where section = 'net_change') is distinct from v_t_change then
    raise exception 'FAIL: a transfer changed the cash flow''s net change, from % to %', v_t_change,
      (select amount_cents from public.cash_flow(v_shop_c, '2000-01-01', '2100-01-01') where section = 'net_change');
  end if;

  --      ...and the two balances DID move, in opposite directions and by the
  --      same 1350. A transfer posted Dr the source / Cr the destination passes
  --      all three assertions above and fails both of these.
  select coalesce(sum(amount_cents) filter (where code = '1000'), 0),
         coalesce(sum(amount_cents) filter (where code = '1010'), 0)
    into v_t_1000, v_t_1010
    from public.balance_sheet(v_shop_c, public.shop_local_date());
  if v_t_1000 <> 65750 then
    raise exception 'FAIL: the till reads % after sending 1350 to the bank, expected 65750 (68450 = the transfer was posted backwards)', v_t_1000;
  end if;
  if v_t_1010 <> 1350 then
    raise exception 'FAIL: the bank reads % after receiving 1350 from the till, expected 1350 (-1350 = the transfer was posted backwards)', v_t_1010;
  end if;

  -- ---------------------------------------------------------------------
  -- 29.2 THE FIVE RECONCILIATIONS, on shop C.
  --
  --      Shop C's ledger, in full, and every line of it written by a phase-3c
  --      RPC except the capital and the rent:
  --
  --        1000 Till       80000 - 9600 - 3300 - 1350 =  65750
  --        1010 Bank                                      1350
  --        1500 Equipment  the fridge                     9600
  --        1510 Fittings   the shelving                   7200
  --        1590 Accum dep  400 + 400 + 600               -1400
  --        2000 Payables   the shelving, unpaid          -7200
  --        3000 Capital                                 -80000
  --        6000 Rent                                      3300
  --        6800 Depreciation                              1400
  --
  --        Income statement   net profit                 -4700
  --        Balance sheet      current assets             67100
  --                           fixed assets 16800 - 1400  15400
  --                           TOTAL ASSETS               82500
  --                           payables                    7200
  --                           capital 80000, loss -4700  75300
  --                           TOTAL L + E                82500
  --        Cash flow          net profit                 -4700
  --                           add back depreciation      +1400
  --                           increase in payables       +7200
  --                           cash from operations        3900
  --                           investing -15400 - 1400   -16800
  --                           financing                 +80000
  --                           NET CHANGE                 67100  = the cash held
  --
  --      Note the investing figure: -16800 is the COST of what was bought, and
  --      it is reached as -(the movement in 1500-1599, 1590 included) less the
  --      movement in 6800. The two halves of that expression are what the
  --      add-back and the contra account would otherwise double-count.
  -- ---------------------------------------------------------------------
  select amount_cents into v_is_profit from public.statement_lines(v_shop_c, '2000-01-01', '2100-01-01')
   where section = 'net_profit';
  select amount_cents into v_bs_profit from public.balance_sheet(v_shop_c, public.shop_local_date())
   where section = 'equity' and label = 'Profit this period';
  select amount_cents into v_cf_profit from public.cash_flow(v_shop_c, '2000-01-01', '2100-01-01')
   where section = 'operating' and label = 'Net profit';
  select -coalesce(sum(l.amount_cents), 0)::bigint, count(*)
    into v_tb_profit, v_tb_lines
    from public.journal_lines l
    join public.journal_entries e on e.id = l.entry_id
    join public.accounts a on a.id = l.account_id
   where e.shop_id = v_shop_c
     and e.status in ('posted', 'reversed')
     and e.entry_date between '2000-01-01' and '2100-01-01'
     and a.type in ('revenue', 'cost_of_sales', 'expense');
  if v_tb_lines = 0 then
    raise exception 'FAIL: shop C''s independent derivation read no journal lines, so reconciliation 3 is vacuous';
  end if;
  select amount_cents into v_bs_assets from public.balance_sheet(v_shop_c, public.shop_local_date())
   where section = 'total_assets';
  select amount_cents into v_bs_credits from public.balance_sheet(v_shop_c, public.shop_local_date())
   where section = 'total_liabilities_equity';
  select coalesce(sum(amount_cents), 0) into v_bs_cash from public.balance_sheet(v_shop_c, public.shop_local_date())
   where code in ('1000', '1010', '1020', '1021');
  select amount_cents into v_cf_cash from public.cash_flow(v_shop_c, '2000-01-01', '2100-01-01')
   where section = 'proof' and label like 'Cash at%' order by sort_order desc limit 1;

  if v_is_profit is null or v_bs_profit is null or v_cf_profit is null
     or v_bs_assets is null or v_bs_credits is null or v_cf_cash is null then
    raise exception 'FAIL: shop C is missing a figure the reconciliations need -- income %, balance sheet %, cash flow %, assets %, liabilities+equity %, closing cash %',
      v_is_profit, v_bs_profit, v_cf_profit, v_bs_assets, v_bs_credits, v_cf_cash;
  end if;

  if v_is_profit <> v_bs_profit then
    raise exception 'FAIL: 29 reconciliation 1 -- income statement net profit % against balance sheet profit this period %, off by %',
      v_is_profit, v_bs_profit, v_is_profit - v_bs_profit;
  end if;
  if v_is_profit <> v_cf_profit then
    raise exception 'FAIL: 29 reconciliation 2 -- income statement net profit % against cash flow net profit %, off by %',
      v_is_profit, v_cf_profit, v_is_profit - v_cf_profit;
  end if;
  if v_is_profit <> v_tb_profit then
    raise exception 'FAIL: 29 reconciliation 3 -- income statement net profit % against the trial balance netted independently %, off by % (over % journal lines)',
      v_is_profit, v_tb_profit, v_is_profit - v_tb_profit, v_tb_lines;
  end if;
  if v_is_profit <> -4700 then
    raise exception 'FAIL: shop C''s three statements agree on a net profit of %, but 3300 of rent and 1400 of depreciation make a loss of -4700', v_is_profit;
  end if;
  if v_bs_assets <> v_bs_credits then
    raise exception 'FAIL: 29 reconciliation 4 -- total assets % against total liabilities and equity %, off by %',
      v_bs_assets, v_bs_credits, v_bs_assets - v_bs_credits;
  end if;
  if v_bs_assets <> 82500 then
    raise exception 'FAIL: shop C''s balance sheet balances at %, expected 82500', v_bs_assets;
  end if;
  if v_cf_cash <> v_bs_cash then
    raise exception 'FAIL: 29 reconciliation 5 -- cash flow closing cash % against balance sheet cash %, off by %',
      v_cf_cash, v_bs_cash, v_cf_cash - v_bs_cash;
  end if;
  if v_cf_cash <> 67100 then
    raise exception 'FAIL: shop C''s two statements agree cash is %, expected 67100', v_cf_cash;
  end if;

  -- ---------------------------------------------------------------------
  -- 29.3 THE PROOF, WITH INVESTING AND THE ADD-BACK BOTH NON-ZERO.
  --
  --      This is the assertion the whole phase is for. Every fixture before 3c
  --      had investing at 0 and the add-back at 0, and 0 - 0 = 0 hid a defect
  --      three separate times: the add-back reading an account a close credits
  --      (3b), and the investing section excluding the account a disposal
  --      debits (3c). Both figures are non-zero here, and they are asserted at
  --      their figures as well as through the proof, because a proof that ties
  --      cannot say which of the two rows was wrong.
  -- ---------------------------------------------------------------------
  select amount_cents into v_amount from public.cash_flow(v_shop_c, '2000-01-01', '2100-01-01')
   where section = 'operating' and label = 'Add back depreciation';
  if v_amount is distinct from 1400 then
    raise exception 'FAIL: shop C''s depreciation add-back reads %, expected 1400 -- three run_depreciation charges of 400, 400 and 600', v_amount;
  end if;
  select amount_cents into v_amount from public.cash_flow(v_shop_c, '2000-01-01', '2100-01-01')
   where section = 'investing' and is_total;
  if v_amount is distinct from -16800 then
    raise exception 'FAIL: shop C''s investing reads %, expected -16800 = the 9600 fridge and the 7200 shelving at cost (-15400 = the add-back was not subtracted, so accumulated depreciation was counted as a cash flow)', v_amount;
  end if;
  if (select amount_cents from public.cash_flow(v_shop_c, '2000-01-01', '2100-01-01') where section = 'net_change')
     is distinct from (select amount_cents from public.cash_flow(v_shop_c, '2000-01-01', '2100-01-01')
          where section = 'proof' and label = 'Movement in cash accounts') then
    raise exception 'FAIL: shop C''s cash flow does not prove out -- net change % against observed movement %',
      (select amount_cents from public.cash_flow(v_shop_c, '2000-01-01', '2100-01-01') where section = 'net_change'),
      (select amount_cents from public.cash_flow(v_shop_c, '2000-01-01', '2100-01-01')
        where section = 'proof' and label = 'Movement in cash accounts');
  end if;

  --      NO SIXTH SECTION. A residual "other movements" row would make every
  --      proof above tie by construction and destroy the only check that can
  --      catch a sign error. verify-statements-across-a-close.sql asserts the
  --      same thing for the same reason; it is asserted here too because this
  --      is the block whose figures would tempt someone to add one.
  if (select count(distinct section) from public.cash_flow(v_shop_c, '2000-01-01', '2100-01-01')) <> 5 then
    raise exception 'FAIL: the cash flow has % sections, expected exactly 5 -- a residual section makes the proof tautological',
      (select count(distinct section) from public.cash_flow(v_shop_c, '2000-01-01', '2100-01-01'));
  end if;

  -- ---------------------------------------------------------------------
  -- 29.4 THE INCOME STATEMENT'S DEPRECIATION LINE.
  --
  --      The design: "Depreciation is new. Equipment wearing out is a real cost
  --      of trading, and leaving it out overstated profit every month." Until
  --      run_depreciation shipped, no shop had a 6800 line and the statement
  --      simply did not show one -- statement_lines() emits a row per account
  --      that MOVED, so an absent charge is an absent row and not a zero.
  -- ---------------------------------------------------------------------
  select amount_cents into v_amount from public.statement_lines(v_shop_c, '2000-01-01', '2100-01-01', true)
   where code = '6800' and section = 'operating_expenses';
  if v_amount is distinct from 1400 then
    raise exception 'FAIL: the income statement''s depreciation line reads %, expected 1400', coalesce(v_amount::text, 'absent');
  end if;
  if (select label from public.statement_lines(v_shop_c, '2000-01-01', '2100-01-01', true) where code = '6800')
     is distinct from 'Depreciation' then
    raise exception 'FAIL: the 6800 line is labelled %, expected Depreciation',
      coalesce((select label from public.statement_lines(v_shop_c, '2000-01-01', '2100-01-01', true) where code = '6800'), 'nothing');
  end if;

  --      ...and the SUMMARY does not carry it as its own row, because the
  --      detail flag is what splits operating expenses per account. Asserted so
  --      that the check above is known to be reading the detail statement and
  --      not passing on a row the summary happens to emit.
  if exists (select 1 from public.statement_lines(v_shop_c, '2000-01-01', '2100-01-01', false) where code = '6800') then
    raise exception 'FAIL: the summary income statement carries a per-account 6800 row';
  end if;

  -- ---------------------------------------------------------------------
  -- 29.5 THE REGISTER AND THE LEDGER AGREE.
  --
  --      Cost less accumulated depreciation is net book value, and net book
  --      value is the balance sheet's fixed-asset total. Two independent
  --      derivations: the register sums depreciation_charges per asset, the
  --      balance sheet sums journal_lines over 1500-1599. They are written by
  --      the same call and read by different code, so a run_depreciation that
  --      wrote a charge row and a journal line of different sizes -- or wrote
  --      one and not the other -- separates them here and nowhere else.
  -- ---------------------------------------------------------------------
  select cost_cents, accumulated_cents, net_book_cents
    into v_amount, v_t_1000, v_t_1010
    from public.fixed_asset_summary(v_shop_c);
  if v_amount <> 16800 or v_t_1000 <> 1400 or v_t_1010 <> 15400 then
    raise exception 'FAIL: shop C''s register reads cost %, accumulated % and net book %, expected 16800, 1400 and 15400',
      v_amount, v_t_1000, v_t_1010;
  end if;
  if v_amount - v_t_1000 <> v_t_1010 then
    raise exception 'FAIL: the register''s own arithmetic does not hold -- % less % is not %', v_amount, v_t_1000, v_t_1010;
  end if;
  if (select amount_cents from public.balance_sheet(v_shop_c, public.shop_local_date())
       where section = 'fixed_assets' and is_total) is distinct from v_t_1010 then
    raise exception 'FAIL: the balance sheet''s fixed assets read % against the register''s net book value of %',
      (select amount_cents from public.balance_sheet(v_shop_c, public.shop_local_date())
        where section = 'fixed_assets' and is_total), v_t_1010;
  end if;

  -- ---------------------------------------------------------------------
  -- 29.6 SHOP D: THE DISPOSAL, AND THE OTHER HALF OF THE TENANT BOUNDARY.
  --
  --        1000 Till       250000 - 36000                214000
  --        1010 Bank       the counter's proceeds         12800
  --        1500 Equipment  the oven; the counter has gone 36000
  --        1590 Accum dep  3000 + 3000 + 1000, less the
  --                        1000 written back on disposal  -6000
  --        2000 Payables   the counter, never paid       -24000
  --        3000 Capital                                -250000
  --        6800 Depreciation                              7000
  --        6900 Other      the loss on disposal           10200
  --
  --        net profit                                   -17200
  --        TOTAL ASSETS 226800 + 30000                  256800
  --        TOTAL L + E  24000 + 232800                  256800
  --        cash flow    ops 13800, investing -37000,
  --                     financing 250000, net change    226800  = the cash held
  --
  --      Investing of -37000 is -(36000 - 6000) - 7000. The 1000 of accumulated
  --      depreciation the disposal wrote back is INSIDE that first bracket --
  --      it is what makes the figure -37000 rather than -38000 -- and while
  --      1590 was excluded from the range it was read by no section at all and
  --      the proof failed by exactly 1000.
  -- ---------------------------------------------------------------------
  perform set_config('request.jwt.claims', json_build_object('sub', v_user_d)::text, true);

  if (select amount_cents from public.statement_lines(v_shop_d, '2000-01-01', '2100-01-01')
       where section = 'net_profit') is distinct from -17200 then
    raise exception 'FAIL: shop D''s net profit is %, expected -17200 (7000 of depreciation and a 10200 loss on disposal)',
      (select amount_cents from public.statement_lines(v_shop_d, '2000-01-01', '2100-01-01') where section = 'net_profit');
  end if;
  if (select amount_cents from public.cash_flow(v_shop_d, '2000-01-01', '2100-01-01')
       where section = 'operating' and label = 'Add back depreciation') is distinct from 7000 then
    raise exception 'FAIL: shop D''s depreciation add-back reads %, expected 7000 -- if it reads 6000 the disposal''s write-back of 1590 has leaked into it',
      (select amount_cents from public.cash_flow(v_shop_d, '2000-01-01', '2100-01-01')
        where section = 'operating' and label = 'Add back depreciation');
  end if;
  if (select amount_cents from public.cash_flow(v_shop_d, '2000-01-01', '2100-01-01')
       where section = 'investing' and is_total) is distinct from -37000 then
    raise exception 'FAIL: shop D''s investing reads %, expected -37000 (-38000 = the 1000 of accumulated depreciation the disposal wrote back is read by no section)',
      (select amount_cents from public.cash_flow(v_shop_d, '2000-01-01', '2100-01-01') where section = 'investing' and is_total);
  end if;
  if (select amount_cents from public.cash_flow(v_shop_d, '2000-01-01', '2100-01-01') where section = 'net_change')
     is distinct from (select amount_cents from public.cash_flow(v_shop_d, '2000-01-01', '2100-01-01')
          where section = 'proof' and label = 'Movement in cash accounts') then
    raise exception 'FAIL: shop D''s cash flow does not prove out after a disposal -- net change % against observed movement %',
      (select amount_cents from public.cash_flow(v_shop_d, '2000-01-01', '2100-01-01') where section = 'net_change'),
      (select amount_cents from public.cash_flow(v_shop_d, '2000-01-01', '2100-01-01')
        where section = 'proof' and label = 'Movement in cash accounts');
  end if;
  if (select amount_cents from public.cash_flow(v_shop_d, '2000-01-01', '2100-01-01')
       where section = 'net_change') is distinct from 226800 then
    raise exception 'FAIL: shop D''s net change in cash is %, expected 226800',
      (select amount_cents from public.cash_flow(v_shop_d, '2000-01-01', '2100-01-01') where section = 'net_change');
  end if;
  if (select amount_cents from public.balance_sheet(v_shop_d, public.shop_local_date()) where section = 'total_assets')
     is distinct from (select amount_cents from public.balance_sheet(v_shop_d, public.shop_local_date())
          where section = 'total_liabilities_equity') then
    raise exception 'FAIL: shop D''s balance sheet does not balance -- % against %',
      (select amount_cents from public.balance_sheet(v_shop_d, public.shop_local_date()) where section = 'total_assets'),
      (select amount_cents from public.balance_sheet(v_shop_d, public.shop_local_date()) where section = 'total_liabilities_equity');
  end if;
  if (select amount_cents from public.balance_sheet(v_shop_d, public.shop_local_date())
       where section = 'total_assets') is distinct from 256800 then
    raise exception 'FAIL: shop D''s total assets is %, expected 256800',
      (select amount_cents from public.balance_sheet(v_shop_d, public.shop_local_date()) where section = 'total_assets');
  end if;

  --      A DISPOSED ASSET IS OFF THE BALANCE SHEET AND STILL IN THE REGISTER.
  --      The register's live totals must be the oven alone, and they must tie
  --      to the ledger just as shop C's do.
  select cost_cents, accumulated_cents, net_book_cents
    into v_amount, v_t_1000, v_t_1010
    from public.fixed_asset_summary(v_shop_d);
  if v_amount <> 36000 or v_t_1000 <> 6000 or v_t_1010 <> 30000 then
    raise exception 'FAIL: shop D''s register reads cost %, accumulated % and net book % -- expected 36000, 6000 and 30000, the oven alone',
      v_amount, v_t_1000, v_t_1010;
  end if;
  if (select amount_cents from public.balance_sheet(v_shop_d, public.shop_local_date())
       where section = 'fixed_assets' and is_total) is distinct from 30000 then
    raise exception 'FAIL: shop D''s fixed assets read % against the register''s net book value of 30000',
      (select amount_cents from public.balance_sheet(v_shop_d, public.shop_local_date())
        where section = 'fixed_assets' and is_total);
  end if;

  -- ---------------------------------------------------------------------
  -- 29.7 EVERY ACCOUNT PHASE 3C CAN MOVE IS READ BY SOME SECTION.
  --
  --      The proof identity is the whole reason this matters. Every journal
  --      entry sums to zero, so the negated movements of the non-cash accounts
  --      add up to the movement of the cash accounts -- EXACTLY when every
  --      non-cash account is read by exactly one section. An account read by
  --      none falls straight through, and the difference lands in the proof
  --      row. That has now happened three times on this project: 3a predicted
  --      3900, 3b found 6800 read by a section that a close also credits, and
  --      3c found 1590 debited by a disposal and excluded from investing.
  --
  --      This is the fourth attempt, done by enumeration rather than by
  --      waiting for a figure to be wrong: take every account the transfer,
  --      asset and depreciation sources actually touched across both shops --
  --      including the disposal, which is source 'asset' -- and check each one
  --      against the sections cash_flow() reads. The predicate below is a
  --      hand-maintained mirror of that function and is not proof on its own;
  --      what makes it worth having is that it names the offender, where the
  --      proof rows above only say that something is missing.
  -- ---------------------------------------------------------------------
  perform set_config('role', 'postgres', true);
  select array_agg(distinct a.code order by a.code) into v_codes
    from public.journal_lines l
    join public.journal_entries e on e.id = l.entry_id
    join public.accounts a on a.id = l.account_id
   where e.shop_id in (v_shop_c, v_shop_d)
     and e.source in ('transfer', 'asset', 'depreciation')
     and not (
          a.code in ('1000', '1010', '1020', '1021')                 -- the proof's observed cash
       or a.code in ('6800', '1100', '1200', '2000', '2100', '2200') -- operating
       or a.code between '1500' and '1599'                           -- investing
       or a.code in ('3000', '3100')                                 -- financing
       or a.type in ('revenue', 'cost_of_sales', 'expense')           -- inside net profit
     );
  if v_codes is not null then
    raise exception 'FAIL: phase 3c moved %, which no cash-flow section reads -- the proof will fail by whatever lands there', v_codes;
  end if;

  --      ...and the check is only worth anything if those sources moved
  --      accounts at all. Six is the count for this fixture: 1000, 1010, 1500,
  --      1510, 1590, 2000 and 6800 and 6900 -- eight, and asserted as a floor
  --      rather than a figure so that adding to the story above does not
  --      require editing this line.
  select count(distinct a.code) into v_amount
    from public.journal_lines l
    join public.journal_entries e on e.id = l.entry_id
    join public.accounts a on a.id = l.account_id
   where e.shop_id in (v_shop_c, v_shop_d)
     and e.source in ('transfer', 'asset', 'depreciation');
  if v_amount < 8 then
    raise exception 'FAIL: the phase-3c sources touched only % accounts, so the enumeration above is close to vacuous', v_amount;
  end if;

  --      THE UNACCOUNTED SET, pinned. Over a whole seeded chart the accounts no
  --      section reads are 2300 Loyalty Points Liability and 3900 Retained
  --      Earnings, and check 28 above demonstrates that the proof genuinely
  --      breaks when one of them moves. Pinning the set means a NEW seeded
  --      account that no section reads reddens here on the day it is added,
  --      rather than on the day a shop first posts to it.
  select array_agg(a.code order by a.code) into v_codes
    from public.accounts a
   where a.shop_id = v_shop_c
     and not (
          a.code in ('1000', '1010', '1020', '1021')
       or a.code in ('6800', '1100', '1200', '2000', '2100', '2200')
       or a.code between '1500' and '1599'
       or a.code in ('3000', '3100')
       or a.type in ('revenue', 'cost_of_sales', 'expense')
     );
  if v_codes is distinct from array['2300', '3900'] then
    raise exception 'FAIL: the accounts no cash-flow section reads are %, expected exactly {2300, 3900} -- a new one is a hole in the proof identity', v_codes;
  end if;
  perform set_config('role', 'authenticated', true);

  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims', null, true);
  raise notice 'ALL CHECKS PASSED';
  raise exception 'rollback fixture';
exception
  when others then
    perform set_config('role', 'postgres', true);
    perform set_config('request.jwt.claims', null, true);
    if sqlerrm = 'rollback fixture' then return; end if;
    raise;
end $$;
