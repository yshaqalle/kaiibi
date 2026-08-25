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

  -- 1. Revenue is NET of returns and discounts, and excludes sales tax.
  --    9000 at list less the 500 discount = 8500.
  select amount_cents into v_amount from public.statement_lines(v_shop, '2000-01-01', '2100-01-01')
   where section = 'revenue' and is_total;
  if v_amount <> 8500 then
    raise exception 'FAIL: net revenue is %, expected 8500 (9000 = discount not deducted)', v_amount;
  end if;

  -- 2. Cost of sales carries COGS *and* shrinkage. 2600 + 900 = 3500.
  --    THE ONE THAT MATTERS for the shrinkage decision: 2600 here would mean
  --    5100 had been grouped into operating expenses instead.
  select amount_cents into v_amount from public.statement_lines(v_shop, '2000-01-01', '2100-01-01')
   where section = 'cost_of_sales' and is_total;
  if v_amount <> 3500 then
    raise exception 'FAIL: cost of sales is %, expected 3500 (2600 = shrinkage grouped into opex)', v_amount;
  end if;

  -- 3. Gross profit = 8500 - 3500 = 5000.
  select amount_cents into v_amount from public.statement_lines(v_shop, '2000-01-01', '2100-01-01')
   where section = 'gross_profit';
  if v_amount <> 5000 then
    raise exception 'FAIL: gross profit is %, expected 5000', v_amount;
  end if;

  -- 4. Operating expenses = 4000 + 1250 = 5250. Stock purchases and owner
  --    draws must NOT appear: they are an asset and equity respectively, and
  --    that is what makes a balance sheet possible.
  select amount_cents into v_amount from public.statement_lines(v_shop, '2000-01-01', '2100-01-01')
   where section = 'operating_expenses' and is_total;
  if v_amount <> 5250 then
    raise exception 'FAIL: operating expenses is %, expected 5250', v_amount;
  end if;

  -- 5. Net profit = 5000 - 5250 = -250. NEGATIVE, deliberately: a fixture that
  --    only ever produces a profit never exercises the sign.
  select amount_cents into v_amount from public.statement_lines(v_shop, '2000-01-01', '2100-01-01')
   where section = 'net_profit';
  if v_amount <> -250 then
    raise exception 'FAIL: net profit is %, expected -250 (a loss)', v_amount;
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
  --                    1200 Inventory           96500   100000 - 3500
  --                    total                    98450
  --   Fixed assets     1510 Furniture            6400
  --                    1590 Accum. depreciation   -200   contra, presents down
  --                    total                     6200
  --   TOTAL ASSETS                             104650
  --
  --   Liabilities      2000 Accounts Payable     6400
  --                    total                     6400
  --   Equity           3000 Owner's Capital    100000
  --                    3100 Owner's Draw         -1500   contra, reduces equity
  --                    3900 Retained earnings        0   nothing closed yet
  --                    Profit this period         -250   = the income statement
  --                    total                    98250
  --   TOTAL L + E                              104650
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
  if v_amount is distinct from 104650 then
    raise exception 'FAIL: total assets is %, expected 104650', v_amount;
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
  if v_amount is null or v_amount <> -250 then
    raise exception 'FAIL: profit this period reads %, expected the loss of -250', v_amount;
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
