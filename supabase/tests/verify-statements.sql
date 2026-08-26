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
  v_prod_a uuid;   -- cost 300, sells 1000
  v_prod_b uuid;   -- cost 700, sells 2500
  v_cust   uuid;
  v_sale   uuid;
  v_amount bigint;
  v_open   date;    -- the opening entry's date, 40 days back
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

  --     ...and the check above CANNOT tell whose gate refused them, because
  --     balance_sheet calls statement_lines, statement_lines gates on the same
  --     permission with the same message, and security definer does not change
  --     auth.uid(). Deleting balance_sheet's own gate leaves the behavioural
  --     check green. So the gate is asserted to EXIST as well -- the only
  --     assertion in this file that reads source rather than behaviour, and it
  --     is here because the behavioural one provably cannot bite.
  if not exists (
    select 1 from pg_proc p
     where p.proname = 'balance_sheet'
       and p.pronamespace = 'public'::regnamespace
       and pg_get_functiondef(p.oid) like '%has_shop_permission(p_shop_id, ''ledger.view'')%') then
    raise exception 'FAIL: balance_sheet does not gate on ledger.view itself';
  end if;

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
  --       Operating   -250 + 200 + 3500 + 6400          =  9850
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
  --     which gates on the same permission with the same message. So the gate
  --     is asserted to EXIST as well.
  if not exists (
    select 1 from pg_proc p
     where p.proname = 'cash_flow'
       and p.pronamespace = 'public'::regnamespace
       and pg_get_functiondef(p.oid) like '%has_shop_permission(p_shop_id, ''ledger.view'')%') then
    raise exception 'FAIL: cash_flow does not gate on ledger.view itself';
  end if;

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
