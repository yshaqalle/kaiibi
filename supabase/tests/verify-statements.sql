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

  -- Operating expenses: rent 4000 (6000), utilities 1250 (6100).
  insert into public.expenses (shop_id, location_id, occurred_on, amount_cents, category, payment_method)
    values (v_shop, v_loc, public.shop_local_date(), 4000, 'rent', 'cash'),
           (v_shop, v_loc, public.shop_local_date(), 1250, 'utilities', 'cash');

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
