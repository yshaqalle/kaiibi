-- A CHARACTERISATION of public.complete_sale, written before it is changed.
--
-- This script asserts nothing new. Every figure in it was read off the function
-- as it stands (newest full definition: 20260908000300_sale_entry_date.sql) and
-- is here for one reason: complete_sale is the write path every counter sale in
-- every shop goes through, and the next change to it adds two parameters that
-- let a storefront order be filed at the price the customer was quoted. That
-- change must not move the register by a single cent for any sale that does not
-- use them.
--
-- You cannot prove you did not move the register unless you first record where
-- it stands. This is that record.
--
-- WHAT IS PINNED, and why each one is here:
--
--   1. A PLAIN CASH SALE. The whole shape at once -- sales row, the single
--      sale_items row, the stock movement, and all four journal lines. Also
--      pins that p_location_id is OPTIONAL: this call passes none and the sale
--      lands at the shop's primary location.
--   2. AN ORDER-LEVEL DISCOUNT (p_discount_cents) comes off the TOTAL and never
--      touches the line. sale_items.line_total_cents stays at list, and the
--      contra lands on 4200.
--   3. A LINE-LEVEL DISCOUNT comes off the LINE. The opposite of 2, and the
--      distinction matters: v_gross_cents is already net of a line discount and
--      is NOT net of an order discount, which is the asymmetry that made the
--      posting block wrong the first time it was written.
--   4. A PROMOTION-BACKED line discount. The discount is verified against the
--      promotion row, and the name written onto the line is the PROMOTION'S
--      OWN, not whatever text the caller sent.
--   5. TAX IS ADDED ON TOP of the running total, not carved out of it, and it
--      never reaches sale_items.line_total_cents.
--   6. LOYALTY EARN. Points are round(total * rate / 100) on the goods, the rate
--      is snapshotted onto the sale, and customers.points_balance follows the
--      ledger.
--   7. A REDEMPTION comes off the TOTAL, not off the line, and posts to 4200
--      alongside the discounts. Two ledger rows -- "spent 60, earned 35" --
--      never one net row.
--   8. THE ORDER OF OPERATIONS, which is the single most breakable thing here
--      and which checks 5, 6 and 7 cannot see individually: redemption comes
--      off first, points are earned on what is left, and tax is charged on that
--      same figure. Charging tax on the un-reduced 3600 gives 180 rather than
--      178, and earning on the taxed figure gives 37 rather than 36. Both wrong
--      answers are reachable by a one-line edit and neither raises.
--
-- Every intermediate figure inside a check is deliberately distinct -- 2400 /
-- 900, 6000 / 5000 / 1000 / 2200, 3743 / 3600 / 178 / 35 -- so a check reading
-- the wrong account or the wrong column fails rather than coincidentally
-- passing.
--
-- STOCK is asserted on product_location_stock, never products.stock. The latter
-- is a DERIVED column recomputed by product_location_stock_sync_trigger, so
-- asserting on it tests the trigger rather than the sale.
--
-- No register session is used. p_register_session_id is optional and every
-- check the session drives is skipped when it is null, so requiring one here
-- would add fixture with nothing under test behind it.
--
-- Deliberately NOT `set role authenticated`, for the same reason
-- verify-posting-sales gives: this script stays superuser so RLS never hides a
-- journal_lines row from its own assertions. complete_sale gates on
-- has_shop_permission(), which reads auth.uid() from the JWT claim set below
-- and does not care which postgres role is executing.
--
-- Everything runs inside one DO block whose EXCEPTION clause rolls it all back.

\set ON_ERROR_STOP on

do $$
declare
  v_user_id     uuid := gen_random_uuid();
  v_shop_id     uuid;
  v_loc_id      uuid;
  v_prod_tea    uuid;   -- 1200 a unit, costing 450
  v_prod_coffee uuid;   -- 3000 a unit, costing 1100
  v_promo_id    uuid;
  v_customer_id uuid;
  v_sale_id     uuid;
  v_entry       uuid;
  v_amount      bigint;
  v_int         integer;
  v_num         numeric;
  v_text        text;
  v_ts          timestamptz;
  v_uuid        uuid;
  v_count       bigint;
begin
  -- shops.owner_id references auth.users(id), so the fixture owner needs a real
  -- row there before anything else.
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
    values (v_user_id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            'verify-complete-sale-baseline-' || v_user_id || '@example.test', '', now(), now(), now());

  -- Tax and loyalty both OFF to begin with. Checks 5-8 turn them on one at a
  -- time, so each is measured against a sale that differs in exactly one way.
  insert into public.shops (owner_id, name, tax_enabled, loyalty_enabled)
    values (v_user_id, 'Baseline Wares', false, false)
    returning id into v_shop_id;

  -- A shop has no location until the fixture makes one; seed_shop_defaults does
  -- not create one. There is exactly ONE, so check 1's omitted p_location_id has
  -- an unambiguous right answer.
  insert into public.shop_locations (shop_id, name, is_primary)
    values (v_shop_id, 'Main', true) returning id into v_loc_id;

  -- complete_sale prices a line from products.price_cents, NEVER from the
  -- unit_price_cents in the cart JSON (see :363). Every payload below carries a
  -- unit_price_cents anyway, exactly as the client sends it, and the totals
  -- asserted are computed from the prices HERE. That is itself part of what this
  -- script pins: today, the cart's own price is ignored.
  insert into public.products (shop_id, name, price_cents, cost_cents)
    values (v_shop_id, 'Baseline Tea', 1200, 450) returning id into v_prod_tea;
  insert into public.products (shop_id, name, price_cents, cost_cents)
    values (v_shop_id, 'Baseline Coffee', 3000, 1100) returning id into v_prod_coffee;

  insert into public.product_location_stock (product_id, location_id, stock)
    values (v_prod_tea, v_loc_id, 1000), (v_prod_coffee, v_loc_id, 1000);

  insert into public.promotions (shop_id, name, discount_type, discount_value, scope, active)
    values (v_shop_id, 'Baseline Ten Percent', 'percentage', 10, 'store', true)
    returning id into v_promo_id;

  insert into public.customers (shop_id, first_name, last_name)
    values (v_shop_id, 'Hodan', 'Warsame') returning id into v_customer_id;

  -- has_shop_permission -> auth.uid() -> request.jwt.claims->>'sub'. Without
  -- this every call below is refused as unauthorized.
  perform set_config('request.jwt.claims', json_build_object('sub', v_user_id)::text, true);

  ---------------------------------------------------------------------------
  -- 1. A PLAIN CASH SALE, and the whole shape of it.
  --
  --    2 Tea at 1200 = 2400 gross. No tax, no discount, no loyalty, so the
  --    total is the gross. COGS is 2 x 450 = 900, from the cost FROZEN onto the
  --    line rather than from products.cost_cents.
  --
  --    p_location_id is deliberately OMITTED. complete_sale (:182-191) falls
  --    back to the shop's primary location, and this is the only check that
  --    would notice if that fallback were dropped -- every other call here
  --    names the location.
  ---------------------------------------------------------------------------
  v_sale_id := public.complete_sale(
    p_shop_id  => v_shop_id,
    p_items    => jsonb_build_array(jsonb_build_object(
                    'product_id', v_prod_tea, 'quantity', 2, 'unit_price_cents', 1200)),
    p_payments => jsonb_build_array(jsonb_build_object(
                    'method', 'cash', 'amount_cents', 2400, 'tendered_cents', 2400)));

  -- Read one column at a time, so each failure message names its own column.
  select count(*) into v_count from public.sales where id = v_sale_id;
  if v_count <> 1 then
    raise exception 'FAIL 1: complete_sale returned % but no sales row exists', v_sale_id;
  end if;

  select total_cents into v_amount from public.sales where id = v_sale_id;
  if v_amount <> 2400 then
    raise exception 'FAIL 1: expected total_cents 2400 on a plain 2 x 1200 sale, got %', v_amount;
  end if;

  select item_count into v_int from public.sales where id = v_sale_id;
  if v_int <> 2 then
    raise exception 'FAIL 1: expected item_count 2 (units, not lines), got %', v_int;
  end if;

  select tax_cents into v_int from public.sales where id = v_sale_id;
  if v_int <> 0 then
    raise exception 'FAIL 1: expected tax_cents 0 with tax disabled, got %', v_int;
  end if;

  select tax_rate_percent into v_num from public.sales where id = v_sale_id;
  if v_num is not null then
    raise exception 'FAIL 1: expected tax_rate_percent NULL with tax disabled, got %', v_num;
  end if;

  select discount_cents into v_int from public.sales where id = v_sale_id;
  if v_int <> 0 then
    raise exception 'FAIL 1: expected sales.discount_cents 0, got %', v_int;
  end if;

  select points_earned, points_redeemed, points_redeemed_cents
    into v_int, v_count, v_amount from public.sales where id = v_sale_id;
  if v_int <> 0 or v_count <> 0 or v_amount <> 0 then
    raise exception 'FAIL 1: expected 0/0/0 for earned/redeemed/redeemed_cents with loyalty off, got %/%/%',
      v_int, v_count, v_amount;
  end if;

  select loyalty_points_per_usd into v_num from public.sales where id = v_sale_id;
  if v_num is not null then
    raise exception 'FAIL 1: expected loyalty_points_per_usd NULL with loyalty off, got %', v_num;
  end if;

  select payment_method into v_text from public.sales where id = v_sale_id;
  if v_text <> 'cash' then
    raise exception 'FAIL 1: expected payment_method cash (the FIRST payment''s method), got %', v_text;
  end if;

  -- The optional-location fallback.
  select location_id into v_uuid from public.sales where id = v_sale_id;
  if v_uuid <> v_loc_id then
    raise exception 'FAIL 1: a sale with no p_location_id landed at % instead of the primary location %',
      v_uuid, v_loc_id;
  end if;

  -- Paid in full, so the sale is stamped settled and never appears on the
  -- receivables list.
  select settled_at into v_ts from public.sales where id = v_sale_id;
  if v_ts is null then
    raise exception 'FAIL 1: a sale paid in full was not stamped settled_at';
  end if;

  -- One sale_items row, and every column on it.
  select count(*) into v_count from public.sale_items where sale_id = v_sale_id;
  if v_count <> 1 then
    raise exception 'FAIL 1: expected 1 sale_items row, got %', v_count;
  end if;

  select unit_price_cents into v_int from public.sale_items where sale_id = v_sale_id;
  if v_int <> 1200 then
    raise exception 'FAIL 1: expected sale_items.unit_price_cents 1200 (the PRODUCT''s price), got %', v_int;
  end if;
  select quantity into v_int from public.sale_items where sale_id = v_sale_id;
  if v_int <> 2 then
    raise exception 'FAIL 1: expected sale_items.quantity 2, got %', v_int;
  end if;
  select line_total_cents into v_int from public.sale_items where sale_id = v_sale_id;
  if v_int <> 2400 then
    raise exception 'FAIL 1: expected sale_items.line_total_cents 2400, got %', v_int;
  end if;
  select discount_cents into v_int from public.sale_items where sale_id = v_sale_id;
  if v_int <> 0 then
    raise exception 'FAIL 1: expected sale_items.discount_cents 0, got %', v_int;
  end if;
  -- The frozen cost. If this ever reads null, COGS silently stops posting.
  select unit_cost_cents into v_int from public.sale_items where sale_id = v_sale_id;
  if v_int is distinct from 450 then
    raise exception 'FAIL 1: expected sale_items.unit_cost_cents 450 frozen onto the line, got %', v_int;
  end if;
  select product_name into v_text from public.sale_items where sale_id = v_sale_id;
  if v_text <> 'Baseline Tea' then
    raise exception 'FAIL 1: expected the product name copied onto the line, got %', v_text;
  end if;
  if exists (select 1 from public.sale_items
              where sale_id = v_sale_id and (promotion_id is not null or promotion_name is not null)) then
    raise exception 'FAIL 1: a sale with no promotion carries promotion columns';
  end if;

  -- Stock came off product_location_stock at the resolved location.
  -- products.stock is DERIVED by a trigger, so it is not what is asserted.
  select stock into v_int from public.product_location_stock
    where product_id = v_prod_tea and location_id = v_loc_id;
  if v_int <> 998 then
    raise exception 'FAIL 1: expected 998 Tea left at Main after selling 2 of 1000, got %', v_int;
  end if;

  -- One payment row, at the amount sent.
  select coalesce(sum(amount_cents), 0), count(*) into v_amount, v_count
    from public.sale_payments where sale_id = v_sale_id;
  if v_count <> 1 or v_amount <> 2400 then
    raise exception 'FAIL 1: expected one 2400 payment row, got % rows totalling %', v_count, v_amount;
  end if;

  -- The journal entry: four lines, no more.
  select journal_entry_id into v_entry from public.sales where id = v_sale_id;
  if v_entry is null then
    raise exception 'FAIL 1: the sale posted no journal entry';
  end if;
  select source into v_text from public.journal_entries where id = v_entry;
  if v_text <> 'sale' then
    raise exception 'FAIL 1: expected journal source sale, got % (manual would gate on ledger.post)', v_text;
  end if;

  select count(*) into v_count from public.journal_lines where entry_id = v_entry;
  if v_count <> 4 then
    raise exception 'FAIL 1: expected exactly 4 journal lines (cash, revenue, COGS, stock), got %', v_count;
  end if;
  select coalesce(sum(amount_cents), 0) into v_amount from public.journal_lines where entry_id = v_entry;
  if v_amount <> 0 then
    raise exception 'FAIL 1: the entry does not balance, off by %', v_amount;
  end if;

  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l join public.accounts a on a.id = l.account_id
   where l.entry_id = v_entry and a.code = '1000';
  if v_amount <> 2400 then
    raise exception 'FAIL 1: expected Dr 1000 Cash 2400, got %', v_amount;
  end if;
  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l join public.accounts a on a.id = l.account_id
   where l.entry_id = v_entry and a.code = '4000';
  if v_amount <> -2400 then
    raise exception 'FAIL 1: expected Cr 4000 Sales Revenue -2400, got %', v_amount;
  end if;
  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l join public.accounts a on a.id = l.account_id
   where l.entry_id = v_entry and a.code = '5000';
  if v_amount <> 900 then
    raise exception 'FAIL 1: expected Dr 5000 COGS 900 (2 x the frozen 450), got %', v_amount;
  end if;
  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l join public.accounts a on a.id = l.account_id
   where l.entry_id = v_entry and a.code = '1200';
  if v_amount <> -900 then
    raise exception 'FAIL 1: expected Cr 1200 Stock -900, got %', v_amount;
  end if;

  raise notice 'OK 1: a plain 2 x 1200 cash sale totals 2400 and posts four lines';

  ---------------------------------------------------------------------------
  -- 2. AN ORDER-LEVEL DISCOUNT comes off the TOTAL and leaves the line alone.
  --
  --    2 Coffee at 3000 = 6000 gross, less 1000 entered at checkout = 5000.
  --    COGS 2 x 1100 = 2200.
  --
  --    The line stays at 6000. That asymmetry -- an order discount is
  --    subtracted AFTER v_gross_cents is final, a line discount is folded in
  --    BEFORE (see check 3) -- is the whole reason the posting block reads
  --    sale_items.discount_cents back off the rows instead of using a running
  --    total. Both discounts land on 4200 all the same.
  ---------------------------------------------------------------------------
  v_sale_id := public.complete_sale(
    p_shop_id        => v_shop_id,
    p_items          => jsonb_build_array(jsonb_build_object(
                          'product_id', v_prod_coffee, 'quantity', 2, 'unit_price_cents', 3000)),
    p_payments       => jsonb_build_array(jsonb_build_object(
                          'method', 'cash', 'amount_cents', 5000, 'tendered_cents', 5000)),
    p_discount_cents => 1000,
    p_location_id    => v_loc_id);

  select total_cents into v_amount from public.sales where id = v_sale_id;
  if v_amount <> 5000 then
    raise exception 'FAIL 2: expected total_cents 5000 (6000 less a 1000 order discount), got %', v_amount;
  end if;
  select discount_cents into v_int from public.sales where id = v_sale_id;
  if v_int <> 1000 then
    raise exception 'FAIL 2: expected sales.discount_cents 1000, got %', v_int;
  end if;
  select line_total_cents into v_int from public.sale_items where sale_id = v_sale_id;
  if v_int <> 6000 then
    raise exception 'FAIL 2: an order discount moved the LINE to %, expected it to stay at list 6000', v_int;
  end if;
  select discount_cents into v_int from public.sale_items where sale_id = v_sale_id;
  if v_int <> 0 then
    raise exception 'FAIL 2: an order discount landed on sale_items.discount_cents as %, expected 0', v_int;
  end if;

  select journal_entry_id into v_entry from public.sales where id = v_sale_id;
  select count(*) into v_count from public.journal_lines where entry_id = v_entry;
  if v_count <> 5 then
    raise exception 'FAIL 2: expected 5 journal lines (cash, discount, revenue, COGS, stock), got %', v_count;
  end if;
  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l join public.accounts a on a.id = l.account_id
   where l.entry_id = v_entry and a.code = '1000';
  if v_amount <> 5000 then
    raise exception 'FAIL 2: expected Dr 1000 Cash 5000, got %', v_amount;
  end if;
  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l join public.accounts a on a.id = l.account_id
   where l.entry_id = v_entry and a.code = '4200';
  if v_amount <> 1000 then
    raise exception 'FAIL 2: expected Dr 4200 Discounts 1000, got %', v_amount;
  end if;
  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l join public.accounts a on a.id = l.account_id
   where l.entry_id = v_entry and a.code = '4000';
  if v_amount <> -6000 then
    raise exception 'FAIL 2: expected Cr 4000 Revenue -6000 at LIST, got % (-5000 = the discount netted into revenue)', v_amount;
  end if;
  select coalesce(sum(amount_cents), 0) into v_amount from public.journal_lines where entry_id = v_entry;
  if v_amount <> 0 then
    raise exception 'FAIL 2: the entry does not balance, off by %', v_amount;
  end if;

  raise notice 'OK 2: an order discount takes 1000 off 6000 and leaves the line at list';

  ---------------------------------------------------------------------------
  -- 3. A LINE-LEVEL DISCOUNT comes off the LINE.
  --
  --    1 Coffee at 3000 less 700 = 2300, which IS the total: the item loop
  --    computes `v_line := price_cents * qty - v_line_discount` and accumulates
  --    that, so v_gross_cents is already net of it.
  --
  --    Entered without a promotion behind it, which is the path that requires
  --    discounts.manual. The fixture owner holds every permission, so this is
  --    pinning the arithmetic, not the gate.
  ---------------------------------------------------------------------------
  v_sale_id := public.complete_sale(
    p_shop_id     => v_shop_id,
    p_items       => jsonb_build_array(jsonb_build_object(
                       'product_id', v_prod_coffee, 'quantity', 1,
                       'unit_price_cents', 3000, 'discount_cents', 700)),
    p_payments    => jsonb_build_array(jsonb_build_object(
                       'method', 'cash', 'amount_cents', 2300, 'tendered_cents', 2300)),
    p_location_id => v_loc_id);

  select total_cents into v_amount from public.sales where id = v_sale_id;
  if v_amount <> 2300 then
    raise exception 'FAIL 3: expected total_cents 2300 (3000 less a 700 line discount), got %', v_amount;
  end if;
  select discount_cents into v_int from public.sales where id = v_sale_id;
  if v_int <> 0 then
    raise exception 'FAIL 3: a LINE discount reached sales.discount_cents as %, expected 0', v_int;
  end if;
  select line_total_cents into v_int from public.sale_items where sale_id = v_sale_id;
  if v_int <> 2300 then
    raise exception 'FAIL 3: expected sale_items.line_total_cents 2300, got %', v_int;
  end if;
  select discount_cents into v_int from public.sale_items where sale_id = v_sale_id;
  if v_int <> 700 then
    raise exception 'FAIL 3: expected sale_items.discount_cents 700, got %', v_int;
  end if;
  -- The unit price on the line is still LIST. The discount is recorded beside
  -- it, not folded into it -- which is what lets the journal credit revenue at
  -- list and debit the contra separately.
  select unit_price_cents into v_int from public.sale_items where sale_id = v_sale_id;
  if v_int <> 3000 then
    raise exception 'FAIL 3: expected sale_items.unit_price_cents to stay at list 3000, got % (2300 = the discount folded into the price)', v_int;
  end if;

  select journal_entry_id into v_entry from public.sales where id = v_sale_id;
  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l join public.accounts a on a.id = l.account_id
   where l.entry_id = v_entry and a.code = '4000';
  if v_amount <> -3000 then
    raise exception 'FAIL 3: expected Cr 4000 Revenue -3000 at LIST, got % (-2300 = the line discount netted into revenue)', v_amount;
  end if;
  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l join public.accounts a on a.id = l.account_id
   where l.entry_id = v_entry and a.code = '4200';
  if v_amount <> 700 then
    raise exception 'FAIL 3: expected Dr 4200 Discounts 700, got % (0 = line discounts never reach 4200)', v_amount;
  end if;
  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l join public.accounts a on a.id = l.account_id
   where l.entry_id = v_entry and a.code = '1000';
  if v_amount <> 2300 then
    raise exception 'FAIL 3: expected Dr 1000 Cash 2300, got %', v_amount;
  end if;
  select coalesce(sum(amount_cents), 0) into v_amount from public.journal_lines where entry_id = v_entry;
  if v_amount <> 0 then
    raise exception 'FAIL 3: the entry does not balance, off by %', v_amount;
  end if;

  raise notice 'OK 3: a line discount takes 700 off the line and totals 2300';

  ---------------------------------------------------------------------------
  -- 4. A PROMOTION-BACKED discount.
  --
  --    1 Coffee at 3000 with a store-wide 10% offer. complete_sale recomputes
  --    what the offer allows -- round(3000 * 1 * 10 / 100) = 300 -- and refuses
  --    anything larger. 300 is claimed, so the line is 2700.
  --
  --    The payload deliberately sends a promotion_name of its own. The stored
  --    name must be the PROMOTION ROW'S, because a name taken on trust is text
  --    the caller chose written onto the sale forever.
  ---------------------------------------------------------------------------
  v_sale_id := public.complete_sale(
    p_shop_id     => v_shop_id,
    p_items       => jsonb_build_array(jsonb_build_object(
                       'product_id', v_prod_coffee, 'quantity', 1, 'unit_price_cents', 3000,
                       'discount_cents', 300, 'promotion_id', v_promo_id,
                       'promotion_name', 'Whatever The Caller Typed')),
    p_payments    => jsonb_build_array(jsonb_build_object(
                       'method', 'cash', 'amount_cents', 2700, 'tendered_cents', 2700)),
    p_location_id => v_loc_id);

  select total_cents into v_amount from public.sales where id = v_sale_id;
  if v_amount <> 2700 then
    raise exception 'FAIL 4: expected total_cents 2700 (3000 less a 10%% promotion), got %', v_amount;
  end if;
  select line_total_cents into v_int from public.sale_items where sale_id = v_sale_id;
  if v_int <> 2700 then
    raise exception 'FAIL 4: expected sale_items.line_total_cents 2700, got %', v_int;
  end if;
  select discount_cents into v_int from public.sale_items where sale_id = v_sale_id;
  if v_int <> 300 then
    raise exception 'FAIL 4: expected sale_items.discount_cents 300, got %', v_int;
  end if;
  select promotion_id into v_uuid from public.sale_items where sale_id = v_sale_id;
  if v_uuid is distinct from v_promo_id then
    raise exception 'FAIL 4: expected the promotion attributed on the line, got %', v_uuid;
  end if;
  select promotion_name into v_text from public.sale_items where sale_id = v_sale_id;
  if v_text <> 'Baseline Ten Percent' then
    raise exception 'FAIL 4: expected the PROMOTION''S own name on the line, got % (the caller''s text would mean it is taken on trust)', v_text;
  end if;

  select journal_entry_id into v_entry from public.sales where id = v_sale_id;
  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l join public.accounts a on a.id = l.account_id
   where l.entry_id = v_entry and a.code = '4000';
  if v_amount <> -3000 then
    raise exception 'FAIL 4: expected Cr 4000 Revenue -3000 at LIST, got %', v_amount;
  end if;
  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l join public.accounts a on a.id = l.account_id
   where l.entry_id = v_entry and a.code = '4200';
  if v_amount <> 300 then
    raise exception 'FAIL 4: expected Dr 4200 Discounts 300 for the promotion, got %', v_amount;
  end if;
  select coalesce(sum(amount_cents), 0) into v_amount from public.journal_lines where entry_id = v_entry;
  if v_amount <> 0 then
    raise exception 'FAIL 4: the entry does not balance, off by %', v_amount;
  end if;

  raise notice 'OK 4: a 10%% promotion takes 300 off 3000 and is attributed by name from the row';

  ---------------------------------------------------------------------------
  -- 5. TAX IS ADDED ON TOP.
  --
  --    2 Tea at 1200 = 2400 goods, 5% = 120, total 2520 (:450-453). Carved OUT
  --    of 2400 instead it would be 114 and the total would stay 2400 -- so the
  --    2520 here is what distinguishes the two readings.
  --
  --    And it never reaches the LINE: sale_items.line_total_cents stays 2400,
  --    which is what makes refunds and the discount report able to speak about
  --    merchandise separately from money collected for the state.
  ---------------------------------------------------------------------------
  update public.shops set tax_enabled = true, tax_rate_percent = 5 where id = v_shop_id;

  v_sale_id := public.complete_sale(
    p_shop_id     => v_shop_id,
    p_items       => jsonb_build_array(jsonb_build_object(
                       'product_id', v_prod_tea, 'quantity', 2, 'unit_price_cents', 1200)),
    p_payments    => jsonb_build_array(jsonb_build_object(
                       'method', 'cash', 'amount_cents', 2520, 'tendered_cents', 2520)),
    p_location_id => v_loc_id);

  select total_cents into v_amount from public.sales where id = v_sale_id;
  if v_amount <> 2520 then
    raise exception 'FAIL 5: expected total_cents 2520 (2400 goods + 120 tax ON TOP), got % (2400 = tax carved out of the total)', v_amount;
  end if;
  select tax_cents into v_int from public.sales where id = v_sale_id;
  if v_int <> 120 then
    raise exception 'FAIL 5: expected tax_cents 120, got % (114 = tax carved out of 2400 rather than added to it)', v_int;
  end if;
  select tax_rate_percent into v_num from public.sales where id = v_sale_id;
  if v_num <> 5 then
    raise exception 'FAIL 5: expected tax_rate_percent 5 snapshotted onto the sale, got %', v_num;
  end if;
  select line_total_cents into v_int from public.sale_items where sale_id = v_sale_id;
  if v_int <> 2400 then
    raise exception 'FAIL 5: tax reached the LINE -- expected sale_items.line_total_cents 2400, got %', v_int;
  end if;

  select journal_entry_id into v_entry from public.sales where id = v_sale_id;
  select count(*) into v_count from public.journal_lines where entry_id = v_entry;
  if v_count <> 5 then
    raise exception 'FAIL 5: expected 5 journal lines (cash, revenue, tax, COGS, stock), got %', v_count;
  end if;
  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l join public.accounts a on a.id = l.account_id
   where l.entry_id = v_entry and a.code = '1000';
  if v_amount <> 2520 then
    raise exception 'FAIL 5: expected Dr 1000 Cash 2520, got %', v_amount;
  end if;
  -- Revenue is the GOODS. 2520 here would book the tax as the shop's earnings.
  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l join public.accounts a on a.id = l.account_id
   where l.entry_id = v_entry and a.code = '4000';
  if v_amount <> -2400 then
    raise exception 'FAIL 5: expected Cr 4000 Revenue -2400, got % (-2520 = tax booked as revenue)', v_amount;
  end if;
  -- Tax is a LIABILITY: money held for the state, not earned.
  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l join public.accounts a on a.id = l.account_id
   where l.entry_id = v_entry and a.code = '2100';
  if v_amount <> -120 then
    raise exception 'FAIL 5: expected Cr 2100 Sales Tax Payable -120, got %', v_amount;
  end if;
  select coalesce(sum(amount_cents), 0) into v_amount from public.journal_lines where entry_id = v_entry;
  if v_amount <> 0 then
    raise exception 'FAIL 5: the entry does not balance, off by %', v_amount;
  end if;

  raise notice 'OK 5: 5%% tax adds 120 on top of 2400 for a total of 2520';

  ---------------------------------------------------------------------------
  -- 6. LOYALTY EARN.
  --
  --    Tax back OFF so this measures one thing. 5 Tea at 1200 = 6000, at one
  --    point per dollar: round(6000 * 1 / 100) = 60.
  --
  --    loyalty_points_available_after_days is set to 0 so check 7 can spend
  --    these immediately. The maturation window is verify-loyalty check 11's
  --    subject, not this script's.
  ---------------------------------------------------------------------------
  update public.shops
     set tax_enabled = false,
         loyalty_enabled = true,
         loyalty_points_per_usd = 1,
         loyalty_cents_per_point = 1,
         loyalty_points_available_after_days = 0
   where id = v_shop_id;

  v_sale_id := public.complete_sale(
    p_shop_id     => v_shop_id,
    p_items       => jsonb_build_array(jsonb_build_object(
                       'product_id', v_prod_tea, 'quantity', 5, 'unit_price_cents', 1200)),
    p_payments    => jsonb_build_array(jsonb_build_object(
                       'method', 'cash', 'amount_cents', 6000, 'tendered_cents', 6000)),
    p_customer_id => v_customer_id,
    p_location_id => v_loc_id);

  select total_cents into v_amount from public.sales where id = v_sale_id;
  if v_amount <> 6000 then
    raise exception 'FAIL 6: expected total_cents 6000, got %', v_amount;
  end if;
  select points_earned into v_int from public.sales where id = v_sale_id;
  if v_int <> 60 then
    raise exception 'FAIL 6: expected 60 points earned on 6000, got %', v_int;
  end if;
  -- The rate is FROZEN onto the sale, so a later settlement or edit earns at
  -- the rate the customer was quoted rather than the rate of the day.
  select loyalty_points_per_usd into v_num from public.sales where id = v_sale_id;
  if v_num <> 1 then
    raise exception 'FAIL 6: expected the earn rate 1 snapshotted onto the sale, got %', v_num;
  end if;

  select count(*) into v_count from public.customer_points_ledger where sale_id = v_sale_id;
  if v_count <> 1 then
    raise exception 'FAIL 6: expected exactly 1 ledger row for an earning sale, got %', v_count;
  end if;
  select delta_points, reason into v_int, v_text
    from public.customer_points_ledger where sale_id = v_sale_id;
  if v_int <> 60 or v_text <> 'earn' then
    raise exception 'FAIL 6: expected a +60 earn row, got % %', v_int, v_text;
  end if;

  select points_balance into v_int from public.customers where id = v_customer_id;
  if v_int <> 60 then
    raise exception 'FAIL 6: expected points_balance 60, got %', v_int;
  end if;
  -- The counter and the ledger agree. If these ever drift every other loyalty
  -- figure in this script is meaningless.
  select coalesce(sum(delta_points), 0) into v_amount
    from public.customer_points_ledger where customer_id = v_customer_id;
  if v_amount <> 60 then
    raise exception 'FAIL 6: the ledger sums to % against a balance of 60', v_amount;
  end if;

  -- Earning writes no contra: nothing was given away at the till.
  select journal_entry_id into v_entry from public.sales where id = v_sale_id;
  if exists (select 1 from public.journal_lines l join public.accounts a on a.id = l.account_id
              where l.entry_id = v_entry and a.code = '4200') then
    raise exception 'FAIL 6: an earning sale posted a 4200 contra line';
  end if;

  raise notice 'OK 6: 6000 of goods earns 60 points at the frozen rate of 1';

  ---------------------------------------------------------------------------
  -- 7. A REDEMPTION comes off the TOTAL and posts to 4200.
  --
  --    3 Tea at 1200 = 3600 gross. 60 points at 1 cent each = 60 off, so 3540
  --    is owed and 3540 is paid. The line stays at 3600: a redemption is not a
  --    discount on any particular product.
  --
  --    Points earned on the reduced figure: round(3540 * 1 / 100) = 35. So the
  --    balance goes 60 -> 0 -> 35, written as TWO ledger rows and never one net
  --    -25 row. "Spent 60, earned 35" is what a customer asking about their
  --    balance needs to see.
  --
  --    And the redemption is NOT counted into sales.discount_cents -- it is a
  --    liability being spent, not a price reduction.
  ---------------------------------------------------------------------------
  v_sale_id := public.complete_sale(
    p_shop_id         => v_shop_id,
    p_items           => jsonb_build_array(jsonb_build_object(
                           'product_id', v_prod_tea, 'quantity', 3, 'unit_price_cents', 1200)),
    p_payments        => jsonb_build_array(jsonb_build_object(
                           'method', 'cash', 'amount_cents', 3540, 'tendered_cents', 3540)),
    p_customer_id     => v_customer_id,
    p_location_id     => v_loc_id,
    p_points_redeemed => 60);

  select total_cents into v_amount from public.sales where id = v_sale_id;
  if v_amount <> 3540 then
    raise exception 'FAIL 7: expected total_cents 3540 (3600 less 60 points at 1c), got %', v_amount;
  end if;
  select points_redeemed into v_int from public.sales where id = v_sale_id;
  if v_int <> 60 then
    raise exception 'FAIL 7: expected points_redeemed 60, got %', v_int;
  end if;
  select points_redeemed_cents into v_int from public.sales where id = v_sale_id;
  if v_int <> 60 then
    raise exception 'FAIL 7: expected points_redeemed_cents 60, got %', v_int;
  end if;
  select points_earned into v_int from public.sales where id = v_sale_id;
  if v_int <> 35 then
    raise exception 'FAIL 7: expected 35 points earned on the REDUCED 3540, got % (36 = earned on the un-reduced 3600)', v_int;
  end if;
  select discount_cents into v_int from public.sales where id = v_sale_id;
  if v_int <> 0 then
    raise exception 'FAIL 7: a redemption landed in sales.discount_cents as %, expected 0', v_int;
  end if;
  select line_total_cents into v_int from public.sale_items where sale_id = v_sale_id;
  if v_int <> 3600 then
    raise exception 'FAIL 7: a redemption moved the LINE to %, expected it to stay 3600', v_int;
  end if;

  -- Two rows, never one net row.
  select count(*) into v_count from public.customer_points_ledger where sale_id = v_sale_id;
  if v_count <> 2 then
    raise exception 'FAIL 7: expected 2 ledger rows (one redeem, one earn), got % (1 = a single net row)', v_count;
  end if;
  select delta_points into v_int from public.customer_points_ledger
   where sale_id = v_sale_id and reason = 'redeem';
  if v_int is distinct from -60 then
    raise exception 'FAIL 7: expected a -60 redeem row, got %', v_int;
  end if;
  select delta_points into v_int from public.customer_points_ledger
   where sale_id = v_sale_id and reason = 'earn';
  if v_int is distinct from 35 then
    raise exception 'FAIL 7: expected a +35 earn row, got %', v_int;
  end if;

  select points_balance into v_int from public.customers where id = v_customer_id;
  if v_int <> 35 then
    raise exception 'FAIL 7: expected points_balance 35 after 60 - 60 + 35, got %', v_int;
  end if;
  select coalesce(sum(delta_points), 0) into v_amount
    from public.customer_points_ledger where customer_id = v_customer_id;
  if v_amount <> 35 then
    raise exception 'FAIL 7: the ledger sums to % against a balance of 35', v_amount;
  end if;

  -- The redemption rides in 4200 with the discounts, deliberately: drawing 2300
  -- Loyalty Points Liability down without an earn side would drive it negative
  -- on the very first redemption.
  select journal_entry_id into v_entry from public.sales where id = v_sale_id;
  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l join public.accounts a on a.id = l.account_id
   where l.entry_id = v_entry and a.code = '4200';
  if v_amount <> 60 then
    raise exception 'FAIL 7: expected Dr 4200 60 for the redemption, got %', v_amount;
  end if;
  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l join public.accounts a on a.id = l.account_id
   where l.entry_id = v_entry and a.code = '4000';
  if v_amount <> -3600 then
    raise exception 'FAIL 7: expected Cr 4000 Revenue -3600 at LIST, got %', v_amount;
  end if;
  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l join public.accounts a on a.id = l.account_id
   where l.entry_id = v_entry and a.code = '1000';
  if v_amount <> 3540 then
    raise exception 'FAIL 7: expected Dr 1000 Cash 3540, got %', v_amount;
  end if;
  if exists (select 1 from public.journal_lines l join public.accounts a on a.id = l.account_id
              where l.entry_id = v_entry and a.code = '2300') then
    raise exception 'FAIL 7: a redemption drew down 2300 Loyalty Points Liability, which has no earn side yet';
  end if;
  select coalesce(sum(amount_cents), 0) into v_amount from public.journal_lines where entry_id = v_entry;
  if v_amount <> 0 then
    raise exception 'FAIL 7: the entry does not balance, off by %', v_amount;
  end if;

  raise notice 'OK 7: 60 points take 60 off 3600 and the sale re-earns 35';

  ---------------------------------------------------------------------------
  -- 8. THE ORDER OF OPERATIONS, which is the whole of what a later change has
  --    to preserve. Tax back ON at 5%.
  --
  --    3 Tea at 1200 = 3600 gross.
  --      redeem 35 points at 1c  -> 3565   (redemption comes off FIRST)
  --      earn round(3565 / 100)  -> 36     (on the REDUCED, PRE-TAX figure)
  --      tax  round(3565 * 5/100)-> 178    (on that same figure)
  --      total 3565 + 178        -> 3743   (tax on top, last)
  --
  --    Every wrong ordering is reachable by a one-line edit and none of them
  --    raises:
  --      * tax before the redemption -> 180, total 3745
  --      * earn after tax            -> 37
  --      * earn on the gross 3600    -> 36 as well, which is why the tax figure
  --        is asserted alongside it -- 178 vs 180 is what separates them.
  --
  --    Balance goes 35 -> 0 -> 36.
  ---------------------------------------------------------------------------
  update public.shops set tax_enabled = true, tax_rate_percent = 5 where id = v_shop_id;

  v_sale_id := public.complete_sale(
    p_shop_id         => v_shop_id,
    p_items           => jsonb_build_array(jsonb_build_object(
                           'product_id', v_prod_tea, 'quantity', 3, 'unit_price_cents', 1200)),
    p_payments        => jsonb_build_array(jsonb_build_object(
                           'method', 'cash', 'amount_cents', 3743, 'tendered_cents', 3743)),
    p_customer_id     => v_customer_id,
    p_location_id     => v_loc_id,
    p_points_redeemed => 35);

  select total_cents into v_amount from public.sales where id = v_sale_id;
  if v_amount <> 3743 then
    raise exception 'FAIL 8: expected total_cents 3743 (3600 - 35 redeemed + 178 tax), got % (3745 = tax charged before the redemption)', v_amount;
  end if;
  select tax_cents into v_int from public.sales where id = v_sale_id;
  if v_int <> 178 then
    raise exception 'FAIL 8: expected tax_cents 178, charged on the post-redemption 3565, got % (180 = charged on the gross 3600)', v_int;
  end if;
  select points_redeemed_cents into v_int from public.sales where id = v_sale_id;
  if v_int <> 35 then
    raise exception 'FAIL 8: expected points_redeemed_cents 35, got %', v_int;
  end if;
  select points_earned into v_int from public.sales where id = v_sale_id;
  if v_int <> 36 then
    raise exception 'FAIL 8: expected 36 points earned on the pre-tax 3565, got % (37 = earned on the taxed 3743)', v_int;
  end if;

  select points_balance into v_int from public.customers where id = v_customer_id;
  if v_int <> 36 then
    raise exception 'FAIL 8: expected points_balance 36 after 35 - 35 + 36, got %', v_int;
  end if;

  select journal_entry_id into v_entry from public.sales where id = v_sale_id;
  select count(*) into v_count from public.journal_lines where entry_id = v_entry;
  if v_count <> 6 then
    raise exception 'FAIL 8: expected 6 journal lines (cash, discount, revenue, tax, COGS, stock), got %', v_count;
  end if;
  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l join public.accounts a on a.id = l.account_id
   where l.entry_id = v_entry and a.code = '1000';
  if v_amount <> 3743 then
    raise exception 'FAIL 8: expected Dr 1000 Cash 3743, got %', v_amount;
  end if;
  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l join public.accounts a on a.id = l.account_id
   where l.entry_id = v_entry and a.code = '4200';
  if v_amount <> 35 then
    raise exception 'FAIL 8: expected Dr 4200 35 for the redemption, got %', v_amount;
  end if;
  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l join public.accounts a on a.id = l.account_id
   where l.entry_id = v_entry and a.code = '4000';
  if v_amount <> -3600 then
    raise exception 'FAIL 8: expected Cr 4000 Revenue -3600 at LIST, got %', v_amount;
  end if;
  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l join public.accounts a on a.id = l.account_id
   where l.entry_id = v_entry and a.code = '2100';
  if v_amount <> -178 then
    raise exception 'FAIL 8: expected Cr 2100 Sales Tax Payable -178, got %', v_amount;
  end if;
  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l join public.accounts a on a.id = l.account_id
   where l.entry_id = v_entry and a.code = '5000';
  if v_amount <> 1350 then
    raise exception 'FAIL 8: expected Dr 5000 COGS 1350 (3 x the frozen 450), got %', v_amount;
  end if;
  select coalesce(sum(amount_cents), 0) into v_amount from public.journal_lines where entry_id = v_entry;
  if v_amount <> 0 then
    raise exception 'FAIL 8: the entry does not balance, off by %', v_amount;
  end if;

  raise notice 'OK 8: redeem 35, earn 36 on 3565, tax 178 on top, total 3743';

  ---------------------------------------------------------------------------
  -- The running totals, checked once at the end. Eight sales moved 15 Tea
  -- (2 + 2 + 5 + 3 + 3) and 4 Coffee (2 + 1 + 1) off Main.
  --
  -- Asserted on product_location_stock, NOT products.stock: the latter is
  -- recomputed by product_location_stock_sync_trigger and asserting on it would
  -- be testing the trigger rather than the sale.
  ---------------------------------------------------------------------------
  select stock into v_int from public.product_location_stock
    where product_id = v_prod_tea and location_id = v_loc_id;
  if v_int <> 985 then
    raise exception 'FAIL 9: expected 985 Tea left at Main after 15 units sold, got %', v_int;
  end if;
  select stock into v_int from public.product_location_stock
    where product_id = v_prod_coffee and location_id = v_loc_id;
  if v_int <> 996 then
    raise exception 'FAIL 9: expected 996 Coffee left at Main after 4 units sold, got %', v_int;
  end if;

  select count(*) into v_count from public.sales where shop_id = v_shop_id;
  if v_count <> 8 then
    raise exception 'FAIL 9: expected 8 sales in this fixture, got % -- a check ran twice or not at all', v_count;
  end if;

  -- Every entry this shop posted balances. Guaranteed by the deferred trigger;
  -- asserted anyway, because if the trigger is ever dropped this is where it
  -- shows.
  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l
    join public.journal_entries e on e.id = l.entry_id
   where e.shop_id = v_shop_id;
  if v_amount <> 0 then
    raise exception 'FAIL 9: the shop''s journal does not balance overall, off by %', v_amount;
  end if;

  raise notice 'ALL CHECKS PASSED: complete_sale baseline pinned (8 checks)';
  raise exception 'rollback_marker';
exception
  when others then
    if sqlerrm = 'rollback_marker' then
      raise notice 'verify-complete-sale-baseline: ALL CHECKS PASSED, rolled back';
    else
      raise;
    end if;
end $$;
