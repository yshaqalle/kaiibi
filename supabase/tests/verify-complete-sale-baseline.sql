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
--   9. TAX IS ROUNDED, not floored. 3% of 2450 is 73.5, the one figure here
--      where round() and floor() disagree, so 74 is what tells them apart.
--      Every other tax figure in this script is exact and survives either.
--  10. A PERCENTAGE PROMOTION IS ROUNDED THE SAME WAY. 3% of 1250 is 37.5, so
--      the offer allows 38. Under floor() it allows 37 and refuses this sale.
--  11. A MULTI-LINE CART. Every other check here rings up ONE line, so nothing
--      else would notice a loop that stopped accumulating, wrote one row per
--      cart, or put a line's discount against the wrong product.
--  12. A SALE LEFT ON ACCOUNT (p_allow_balance) EARNS NOTHING. Points are for
--      money taken, not goods handed over, so an under-paid sale zeroes the
--      points it had already computed and the customer's balance stays put.
--  13. THE RUNNING TOTALS, checked once at the end.
--
-- CHECKS 14-19 WERE ADDED BY TASK 2 and are not characterisation: they assert
-- NEW behaviour, the per-line agreed price that lets a storefront order be
-- filed at what the customer was quoted. They are appended AFTER check 13 on
-- purpose -- 13 counts the fixture's sales and asserts its closing stock, so a
-- new sale rung up before it would move a figure Task 1 pinned. Checks 1-13 are
-- byte-for-byte what Task 1 wrote.
--
--  14. A LINE AT AN AGREED PRICE IS FILED AT THAT PRICE. The cart carries
--      agreed_unit_price_cents, and sale_items.unit_price_cents,
--      line_total_cents and the revenue credit all follow it rather than
--      products.price_cents. The frozen unit_cost_cents does NOT: cost is what
--      the shop paid, not part of what was quoted.
--  15. THE SAME CART WITHOUT ONE IS UNCHANGED. Identical in every respect
--      except the field, and it prices from the product exactly as check 1
--      does. This is the control that gives 14 its meaning.
--  16. AN AGREED PRICE PLUS A PROMOTION ON THE SAME LINE IS REFUSED, by a
--      message a client can match on, and the refusal writes nothing.
--  17. A NEGATIVE AGREED PRICE IS REFUSED. It arrives from a caller.
--  18. AN OUT-OF-RANGE AGREED PRICE IS REFUSED, including one whose LINE would
--      overflow a 32-bit integer -- which without a bound is a bare
--      `integer out of range` from the middle of the register's write path.
--  19. ZERO IS A PRICE, NOT AN ABSENCE, and an agreed price binds ONE line.
--      A cart with a promised free item beside a full-price one is the check
--      that separates `coalesce(v_agreed, price)` from the plausible-looking
--      `case when v_agreed > 0 ...`, which would silently charge 3000 for the
--      item the shop promised to give away.
--
-- CHECKS 20-22 WERE ADDED BY TASK 2'S FIRST FIX WAVE (20260929000050), and they
-- close three holes 14-19 left open. Appended after 19 for the same reason 14
-- was appended after 13: 16, 17 and 18 count this shop's sales, so a new sale
-- rung up before them would move a figure they assert.
--
--  20. AN UNDERCUT NEEDS discounts.manual. The first version of the agreed
--      price was ungated, so a cashier who may not take ONE CENT off through
--      `discount_cents` -- refused since 0024 -- could file the whole line at
--      ONE CENT through `agreed_unit_price_cents`. This is the only check in
--      this script that does not run as the shop's owner, and it is the only
--      one that can see the gate at all: the owner short-circuits every
--      permission in user_has_shop_permission.
--  21. THE GATE IS ON THE UNDERCUT, NOT ON THE FIELD, and an agreed price ABOVE
--      list is PERMITTED on purpose. Same un-privileged member: at list is
--      accepted, above list is accepted and filed as sent. The second half is a
--      recorded decision -- a shop that CUT its price after quoting still owes
--      the quote -- pinned here so it stays a decision rather than a gap.
--  22. THE CEILING PREVENTS WHAT IT CLAIMS TO. Check 18's two figures both
--      survive being read into an integer and are both caught by a bound on ONE
--      line. 3,000,000,000 a unit did not survive the parse and produced a
--      Postgres cast error naming a type; three lines of 1,000,000,000 each
--      passed the per-line bound and overflowed the accumulation with a bare
--      `integer out of range` from mid-function -- the exact failure the bound's
--      own comment claimed to prevent.
--
-- AGREED_UNIT_PRICE_CENTS IS A NEW FIELD, and it had to be. Carts have carried
-- a `unit_price_cents` since 0001 and complete_sale has always ignored it --
-- that is the very thing every payload above sends 9999 to prove. Making it
-- authoritative would change the price of every sale every existing caller
-- rings up, and checks 1-13 would go red by design. So the agreed price gets a
-- name of its own, and checks 14 and 19 send BOTH fields at once: 9999 for the
-- old one, which must still be ignored, and the agreed price beside it.
--
-- THE CART'S OWN PRICE IS IGNORED, and every payload below is written to prove
-- it. complete_sale prices each line from products.price_cents (:363, :372) and
-- never reads the unit_price_cents the client sent. A payload sending the SAME
-- figure as the product's price cannot tell those two sources apart -- a
-- baseline written that way passes just as happily against a function that
-- reads the cart, which is not a baseline at all -- so every cart here sends
-- 9999, a price no product has, while the assertions expect the product's. A
-- function that read the cart instead would move every total by thousands and
-- be refused by its own payments-equality check.
--
-- Every intermediate figure inside a check is deliberately distinct -- 2400 /
-- 900, 6000 / 5000 / 1000 / 2200, 3743 / 3600 / 178 / 35 -- so a check reading
-- the wrong account or the wrong column fails rather than coincidentally
-- passing.
--
-- Checks that read a sale_items row assert HOW MANY there are first. A bare
-- `select ... into` takes one arbitrary row when several match, so without the
-- count a loop that wrote a line twice would slip past every column assertion
-- that follows it.
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
  v_prod_cake   uuid;   -- 1250 a unit, costing 500
  v_promo_id    uuid;
  v_promo_odd   uuid;
  v_customer_id uuid;
  -- A member holding pos.access and NOTHING else, and the role that gives it to
  -- them. Only checks 20 and 21 use them: every check before those runs as the
  -- shop's OWNER, who short-circuits has_shop_permission entirely and so cannot
  -- see a permission gate at all.
  v_staff_id    uuid := gen_random_uuid();
  v_role_id     uuid;
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
  -- unit_price_cents in the cart JSON (see :363, :372). These prices are the
  -- ones every total below is computed from; the carts all send 9999. See the
  -- header: a cart that echoed the price here would leave the two sources
  -- indistinguishable and this whole script blind to the difference.
  insert into public.products (shop_id, name, price_cents, cost_cents)
    values (v_shop_id, 'Baseline Tea', 1200, 450) returning id into v_prod_tea;
  insert into public.products (shop_id, name, price_cents, cost_cents)
    values (v_shop_id, 'Baseline Coffee', 3000, 1100) returning id into v_prod_coffee;
  -- 1250 exists for ONE reason: check 10 needs a percentage of a line price to
  -- land on a half cent, and no whole percentage of 1200 or 3000 ever can --
  -- both are multiples of 100, so price * qty * value / 100 is always exact.
  insert into public.products (shop_id, name, price_cents, cost_cents)
    values (v_shop_id, 'Baseline Cake', 1250, 500) returning id into v_prod_cake;

  insert into public.product_location_stock (product_id, location_id, stock)
    values (v_prod_tea, v_loc_id, 1000), (v_prod_coffee, v_loc_id, 1000),
           (v_prod_cake, v_loc_id, 1000);

  insert into public.promotions (shop_id, name, discount_type, discount_value, scope, active)
    values (v_shop_id, 'Baseline Ten Percent', 'percentage', 10, 'store', true)
    returning id into v_promo_id;
  -- 3% is the rate that puts check 10's expected discount on a half cent.
  insert into public.promotions (shop_id, name, discount_type, discount_value, scope, active)
    values (v_shop_id, 'Baseline Three Percent', 'percentage', 3, 'store', true)
    returning id into v_promo_odd;

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
  --
  --    The cart says 9999 a unit and the answer is still 1200 a unit. That gap
  --    is the whole of what makes "the line is priced from the product" a
  --    checkable claim rather than a sentence in a comment.
  ---------------------------------------------------------------------------
  v_sale_id := public.complete_sale(
    p_shop_id  => v_shop_id,
    p_items    => jsonb_build_array(jsonb_build_object(
                    'product_id', v_prod_tea, 'quantity', 2, 'unit_price_cents', 9999)),
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
    raise exception 'FAIL 1: expected sale_items.unit_price_cents 1200 (the PRODUCT''s price), got % (9999 = the cart''s own price, which is meant to be ignored)', v_int;
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
                          'product_id', v_prod_coffee, 'quantity', 2, 'unit_price_cents', 9999)),
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
  -- How many rows, before reading one. A bare `select ... into` would take an
  -- arbitrary row of however many the loop wrote.
  select count(*) into v_count from public.sale_items where sale_id = v_sale_id;
  if v_count <> 1 then
    raise exception 'FAIL 2: expected 1 sale_items row for a one-line cart, got %', v_count;
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
                       'unit_price_cents', 9999, 'discount_cents', 700)),
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
  select count(*) into v_count from public.sale_items where sale_id = v_sale_id;
  if v_count <> 1 then
    raise exception 'FAIL 3: expected 1 sale_items row for a one-line cart, got %', v_count;
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
                       'product_id', v_prod_coffee, 'quantity', 1, 'unit_price_cents', 9999,
                       'discount_cents', 300, 'promotion_id', v_promo_id,
                       'promotion_name', 'Whatever The Caller Typed')),
    p_payments    => jsonb_build_array(jsonb_build_object(
                       'method', 'cash', 'amount_cents', 2700, 'tendered_cents', 2700)),
    p_location_id => v_loc_id);

  select total_cents into v_amount from public.sales where id = v_sale_id;
  if v_amount <> 2700 then
    raise exception 'FAIL 4: expected total_cents 2700 (3000 less a 10%% promotion), got %', v_amount;
  end if;
  select count(*) into v_count from public.sale_items where sale_id = v_sale_id;
  if v_count <> 1 then
    raise exception 'FAIL 4: expected 1 sale_items row for a one-line cart, got %', v_count;
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
                       'product_id', v_prod_tea, 'quantity', 2, 'unit_price_cents', 9999)),
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
  select count(*) into v_count from public.sale_items where sale_id = v_sale_id;
  if v_count <> 1 then
    raise exception 'FAIL 5: expected 1 sale_items row for a one-line cart, got %', v_count;
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
                       'product_id', v_prod_tea, 'quantity', 5, 'unit_price_cents', 9999)),
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
                           'product_id', v_prod_tea, 'quantity', 3, 'unit_price_cents', 9999)),
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
  select count(*) into v_count from public.sale_items where sale_id = v_sale_id;
  if v_count <> 1 then
    raise exception 'FAIL 7: expected 1 sale_items row for a one-line cart, got %', v_count;
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
                           'product_id', v_prod_tea, 'quantity', 3, 'unit_price_cents', 9999)),
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
  -- 9. TAX IS ROUNDED TO THE NEAREST CENT, not floored and not truncated.
  --
  --    Every tax figure above is exact -- 5% of 2400 is 120 and 5% of 3565 is
  --    178.25, and round(), floor() and trunc() agree on both -- so check 5 and
  --    check 8 would both pass against `floor(v_total_cents * v_tax_rate / 100)`.
  --    Task 3 rewrites that very line, so the rounding mode needs a figure that
  --    can tell the two apart.
  --
  --    3% of 2450 is 73.5 exactly: round -> 74, floor and trunc -> 73. 2450 of
  --    goods is 1 Coffee at 3000 less a 550 line discount, so the total is
  --    2524.
  --
  --    The call is wrapped because the payment is exact: under floor() the
  --    total is 2523, 2524 is an over-payment, and complete_sale refuses the
  --    sale before any assertion below can read tax_cents. Caught and re-raised
  --    under this check's number so the rounding mode is what the failure says,
  --    rather than a bare 'payments total is more than sale total'.
  ---------------------------------------------------------------------------
  update public.shops set tax_enabled = true, tax_rate_percent = 3 where id = v_shop_id;

  begin
    v_sale_id := public.complete_sale(
      p_shop_id     => v_shop_id,
      p_items       => jsonb_build_array(jsonb_build_object(
                         'product_id', v_prod_coffee, 'quantity', 1,
                         'unit_price_cents', 9999, 'discount_cents', 550)),
      p_payments    => jsonb_build_array(jsonb_build_object(
                         'method', 'cash', 'amount_cents', 2524, 'tendered_cents', 2524)),
      p_location_id => v_loc_id);
  exception
    when others then
      raise exception 'FAIL 9: 3%% of 2450 is 73.5, so the tax is 74 and the total 2524, and that sale was refused (2523 = tax floored). complete_sale said: %', sqlerrm;
  end;

  select tax_cents into v_int from public.sales where id = v_sale_id;
  if v_int <> 74 then
    raise exception 'FAIL 9: expected tax_cents 74 -- 3%% of 2450 is 73.5 and it rounds UP -- got % (73 = floor or trunc)', v_int;
  end if;
  select total_cents into v_amount from public.sales where id = v_sale_id;
  if v_amount <> 2524 then
    raise exception 'FAIL 9: expected total_cents 2524 (2450 goods + 74 tax), got % (2523 = tax floored)', v_amount;
  end if;
  select journal_entry_id into v_entry from public.sales where id = v_sale_id;
  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l join public.accounts a on a.id = l.account_id
   where l.entry_id = v_entry and a.code = '2100';
  if v_amount <> -74 then
    raise exception 'FAIL 9: expected Cr 2100 Sales Tax Payable -74, got %', v_amount;
  end if;
  select coalesce(sum(amount_cents), 0) into v_amount from public.journal_lines where entry_id = v_entry;
  if v_amount <> 0 then
    raise exception 'FAIL 9: the entry does not balance, off by %', v_amount;
  end if;

  raise notice 'OK 9: 3%% of 2450 is 73.5 and the sale is taxed 74, not 73';

  ---------------------------------------------------------------------------
  -- 10. A PERCENTAGE PROMOTION IS ROUNDED THE SAME WAY.
  --
  --     v_expected_discount is round(price_cents * qty * value / 100) (:352),
  --     and check 4's figure -- 10% of 3000 = 300 -- is exact, so that check
  --     passes just as happily against floor(). Task 2 rewrites this line.
  --
  --     3% of 1250 is 37.5, so the offer allows 38 and this cart claims 38.
  --     Under floor() the offer allows only 37 and complete_sale REFUSES the
  --     sale outright -- so the failure here is an exception from inside the
  --     function, caught and re-raised under this check's own number rather
  --     than surfacing as a bare 'discount 38 exceeds what promotion allows'
  --     with nothing to say which check asked for it.
  --
  --     Tax back OFF, so the only thing this check can fail on is the
  --     promotion.
  ---------------------------------------------------------------------------
  update public.shops set tax_enabled = false where id = v_shop_id;

  begin
    v_sale_id := public.complete_sale(
      p_shop_id     => v_shop_id,
      p_items       => jsonb_build_array(jsonb_build_object(
                         'product_id', v_prod_cake, 'quantity', 1, 'unit_price_cents', 9999,
                         'discount_cents', 38, 'promotion_id', v_promo_odd)),
      p_payments    => jsonb_build_array(jsonb_build_object(
                         'method', 'cash', 'amount_cents', 1212, 'tendered_cents', 1212)),
      p_location_id => v_loc_id);
  exception
    when others then
      raise exception 'FAIL 10: a 3%% promotion on a 1250 line must allow round(37.5) = 38 and the sale was refused (37 = the discount floored). complete_sale said: %', sqlerrm;
  end;

  select count(*) into v_count from public.sale_items where sale_id = v_sale_id;
  if v_count <> 1 then
    raise exception 'FAIL 10: expected 1 sale_items row for a one-line cart, got %', v_count;
  end if;
  select discount_cents into v_int from public.sale_items where sale_id = v_sale_id;
  if v_int <> 38 then
    raise exception 'FAIL 10: expected sale_items.discount_cents 38, got %', v_int;
  end if;
  select line_total_cents into v_int from public.sale_items where sale_id = v_sale_id;
  if v_int <> 1212 then
    raise exception 'FAIL 10: expected sale_items.line_total_cents 1212 (1250 less 38), got %', v_int;
  end if;
  select total_cents into v_amount from public.sales where id = v_sale_id;
  if v_amount <> 1212 then
    raise exception 'FAIL 10: expected total_cents 1212, got %', v_amount;
  end if;
  select promotion_name into v_text from public.sale_items where sale_id = v_sale_id;
  if v_text <> 'Baseline Three Percent' then
    raise exception 'FAIL 10: expected the 3%% promotion attributed by name, got %', v_text;
  end if;

  raise notice 'OK 10: a 3%% promotion on 1250 allows 38, not the floored 37';

  ---------------------------------------------------------------------------
  -- 11. A MULTI-LINE CART, which is what the register actually sends and what
  --     nothing else in this script rings up.
  --
  --     Every check above has exactly one line, so all of them would pass
  --     against a loop that stopped after the first item, wrote one row per
  --     cart rather than per line, or accumulated the last line instead of the
  --     sum. Task 2 rewrites that loop.
  --
  --       2 Tea    at 1200            = 2400
  --       1 Coffee at 3000 less 500   = 2500
  --                                     ----
  --       gross                         4900, and item_count 3 (UNITS, and
  --                                     across lines, not 2 lines)
  --
  --     The discount sits on the SECOND line only, so a loop that attributed
  --     it to the wrong row fails on the per-row assertions even though the
  --     total comes out right.
  --
  --     Wrapped for the same reason as check 9: a loop that accumulated only
  --     the last line makes 4900 an over-payment and the sale is refused before
  --     any assertion runs, so the failure has to name this check itself.
  ---------------------------------------------------------------------------
  begin
    v_sale_id := public.complete_sale(
      p_shop_id     => v_shop_id,
      p_items       => jsonb_build_array(
                         jsonb_build_object('product_id', v_prod_tea, 'quantity', 2,
                                            'unit_price_cents', 9999),
                         jsonb_build_object('product_id', v_prod_coffee, 'quantity', 1,
                                            'unit_price_cents', 9999, 'discount_cents', 500)),
      p_payments    => jsonb_build_array(jsonb_build_object(
                         'method', 'cash', 'amount_cents', 4900, 'tendered_cents', 4900)),
      p_location_id => v_loc_id);
  exception
    when others then
      raise exception 'FAIL 11: a two-line cart of 2400 + 2500 must total 4900 and that sale was refused (2500 = only the last line accumulated). complete_sale said: %', sqlerrm;
  end;

  select total_cents into v_amount from public.sales where id = v_sale_id;
  if v_amount <> 4900 then
    raise exception 'FAIL 11: expected total_cents 4900 (2400 + 2500 across two lines), got % (2500 = only the last line accumulated)', v_amount;
  end if;
  select item_count into v_int from public.sales where id = v_sale_id;
  if v_int <> 3 then
    raise exception 'FAIL 11: expected item_count 3 units across two lines, got % (2 = lines counted rather than units)', v_int;
  end if;
  select count(*) into v_count from public.sale_items where sale_id = v_sale_id;
  if v_count <> 2 then
    raise exception 'FAIL 11: expected 2 sale_items rows for a two-line cart, got %', v_count;
  end if;

  -- Each line's own row, addressed by product so the assertions cannot be
  -- satisfied by whichever row the planner happens to return first.
  select unit_price_cents, quantity, line_total_cents, discount_cents
    into v_int, v_num, v_amount, v_count
    from public.sale_items where sale_id = v_sale_id and product_id = v_prod_tea;
  if v_int <> 1200 or v_num <> 2 or v_amount <> 2400 or v_count <> 0 then
    raise exception 'FAIL 11: expected the Tea line 1200 x 2 = 2400 with no discount, got % x % = % less %',
      v_int, v_num, v_amount, v_count;
  end if;
  select unit_price_cents, quantity, line_total_cents, discount_cents
    into v_int, v_num, v_amount, v_count
    from public.sale_items where sale_id = v_sale_id and product_id = v_prod_coffee;
  if v_int <> 3000 or v_num <> 1 or v_amount <> 2500 or v_count <> 500 then
    raise exception 'FAIL 11: expected the Coffee line 3000 x 1 less 500 = 2500, got % x % = % less %',
      v_int, v_num, v_amount, v_count;
  end if;

  select journal_entry_id into v_entry from public.sales where id = v_sale_id;
  -- Revenue is BOTH lines at list: 2400 + 3000.
  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l join public.accounts a on a.id = l.account_id
   where l.entry_id = v_entry and a.code = '4000';
  if v_amount <> -5400 then
    raise exception 'FAIL 11: expected Cr 4000 Revenue -5400 (both lines at list), got %', v_amount;
  end if;
  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l join public.accounts a on a.id = l.account_id
   where l.entry_id = v_entry and a.code = '4200';
  if v_amount <> 500 then
    raise exception 'FAIL 11: expected Dr 4200 Discounts 500 from the second line, got %', v_amount;
  end if;
  -- COGS is both lines' frozen costs: 2 x 450 + 1 x 1100.
  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l join public.accounts a on a.id = l.account_id
   where l.entry_id = v_entry and a.code = '5000';
  if v_amount <> 2000 then
    raise exception 'FAIL 11: expected Dr 5000 COGS 2000 (2 x 450 + 1100), got %', v_amount;
  end if;
  select coalesce(sum(amount_cents), 0) into v_amount from public.journal_lines where entry_id = v_entry;
  if v_amount <> 0 then
    raise exception 'FAIL 11: the entry does not balance, off by %', v_amount;
  end if;

  raise notice 'OK 11: a two-line cart totals 4900, counts 3 units and keeps each line''s own figures';

  ---------------------------------------------------------------------------
  -- 12. A SALE LEFT ON ACCOUNT EARNS NOTHING, and is not settled.
  --
  --     p_allow_balance is the one parameter that reaches back and ZEROES a
  --     figure already computed (:501-503): points are earned on money taken,
  --     not on goods handed over, and settle_sale_balance credits them when the
  --     money actually arrives. Task 4 touches this path, and nothing else here
  --     under-pays a sale.
  --
  --     5 Tea at 1200 = 6000, of which 5000 is paid. Loyalty is still on at 1
  --     point per dollar, so the function computes 60 and then throws it away.
  --     The customer's balance stays at the 36 check 8 left it.
  ---------------------------------------------------------------------------
  v_sale_id := public.complete_sale(
    p_shop_id       => v_shop_id,
    p_items         => jsonb_build_array(jsonb_build_object(
                         'product_id', v_prod_tea, 'quantity', 5, 'unit_price_cents', 9999)),
    p_payments      => jsonb_build_array(jsonb_build_object(
                         'method', 'cash', 'amount_cents', 5000, 'tendered_cents', 5000)),
    p_customer_id   => v_customer_id,
    p_location_id   => v_loc_id,
    p_allow_balance => true);

  select total_cents into v_amount from public.sales where id = v_sale_id;
  if v_amount <> 6000 then
    raise exception 'FAIL 12: expected total_cents 6000 (the goods, not the money taken), got %', v_amount;
  end if;
  select points_earned into v_int from public.sales where id = v_sale_id;
  if v_int <> 0 then
    raise exception 'FAIL 12: expected 0 points earned on an under-paid sale, got % (60 = earned on the goods rather than on the money taken)', v_int;
  end if;
  select count(*) into v_count from public.customer_points_ledger where sale_id = v_sale_id;
  if v_count <> 0 then
    raise exception 'FAIL 12: an under-paid sale wrote % ledger rows, expected none', v_count;
  end if;
  select points_balance into v_int from public.customers where id = v_customer_id;
  if v_int <> 36 then
    raise exception 'FAIL 12: expected points_balance to stay at 36, got %', v_int;
  end if;
  -- Null while anything is owed: this is the column customer_balances filters
  -- on, so a sale that stamped it would vanish off the receivables list.
  select settled_at into v_ts from public.sales where id = v_sale_id;
  if v_ts is not null then
    raise exception 'FAIL 12: a sale with 1000 still owed was stamped settled_at %', v_ts;
  end if;
  -- The 1000 still owed is a receivable, not a discount.
  select journal_entry_id into v_entry from public.sales where id = v_sale_id;
  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l join public.accounts a on a.id = l.account_id
   where l.entry_id = v_entry and a.code = '1100';
  if v_amount <> 1000 then
    raise exception 'FAIL 12: expected Dr 1100 Receivable 1000 for what is still owed, got %', v_amount;
  end if;
  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l join public.accounts a on a.id = l.account_id
   where l.entry_id = v_entry and a.code = '1000';
  if v_amount <> 5000 then
    raise exception 'FAIL 12: expected Dr 1000 Cash 5000 (only the money actually taken), got %', v_amount;
  end if;
  select coalesce(sum(amount_cents), 0) into v_amount from public.journal_lines where entry_id = v_entry;
  if v_amount <> 0 then
    raise exception 'FAIL 12: the entry does not balance, off by %', v_amount;
  end if;

  raise notice 'OK 12: 1000 left on account earns no points and leaves the sale unsettled';

  ---------------------------------------------------------------------------
  -- 13. The running totals, checked once at the end. Twelve sales moved 22 Tea
  --     (2 + 2 + 5 + 3 + 3 + 2 + 5), 6 Coffee (2 + 1 + 1 + 1 + 1) and 1 Cake
  --     off Main.
  --
  -- Asserted on product_location_stock, NOT products.stock: the latter is
  -- recomputed by product_location_stock_sync_trigger and asserting on it would
  -- be testing the trigger rather than the sale.
  ---------------------------------------------------------------------------
  select stock into v_int from public.product_location_stock
    where product_id = v_prod_tea and location_id = v_loc_id;
  if v_int <> 978 then
    raise exception 'FAIL 13: expected 978 Tea left at Main after 22 units sold, got %', v_int;
  end if;
  select stock into v_int from public.product_location_stock
    where product_id = v_prod_coffee and location_id = v_loc_id;
  if v_int <> 994 then
    raise exception 'FAIL 13: expected 994 Coffee left at Main after 6 units sold, got %', v_int;
  end if;
  select stock into v_int from public.product_location_stock
    where product_id = v_prod_cake and location_id = v_loc_id;
  if v_int <> 999 then
    raise exception 'FAIL 13: expected 999 Cake left at Main after 1 unit sold, got %', v_int;
  end if;

  select count(*) into v_count from public.sales where shop_id = v_shop_id;
  if v_count <> 12 then
    raise exception 'FAIL 13: expected 12 sales in this fixture, got % -- a check ran twice or not at all', v_count;
  end if;

  -- Every entry this shop posted balances. Guaranteed by the deferred trigger;
  -- asserted anyway, because if the trigger is ever dropped this is where it
  -- shows.
  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l
    join public.journal_entries e on e.id = l.entry_id
   where e.shop_id = v_shop_id;
  if v_amount <> 0 then
    raise exception 'FAIL 13: the shop''s journal does not balance overall, off by %', v_amount;
  end if;

  raise notice 'OK 13: twelve sales left the expected stock and a balanced journal';

  ---------------------------------------------------------------------------
  -- 14. A LINE AT AN AGREED PRICE IS FILED AT THAT PRICE.
  --
  --     2 Coffee. products.price_cents says 3000, so the list line is 6000.
  --     The cart says agreed_unit_price_cents 2000 -- the price this customer
  --     was quoted when they ordered -- so the line is 4000 and 4000 is what
  --     is paid.
  --
  --     THE CART ALSO SENDS unit_price_cents 9999, exactly as every check above
  --     does. That field has been ignored since 0001 and must stay ignored:
  --     if the agreed price were bolted onto it instead, every one of checks
  --     1-13 would be ringing up 9999 a unit. Two fields, one authoritative,
  --     and this check sends both so the difference is observable.
  --
  --     unit_cost_cents is still 1100, the product's CURRENT cost. An agreed
  --     price is a promise about what the customer pays; it says nothing about
  --     what the shop paid, and folding it into the cost would misstate COGS
  --     and with it every gross-profit figure the shop reads.
  --
  --     Wrapped: a function that ignored the agreed price would price the line
  --     at 6000, make the 4000 payment an under-payment and refuse the sale
  --     before any assertion below could run.
  ---------------------------------------------------------------------------
  begin
    v_sale_id := public.complete_sale(
      p_shop_id     => v_shop_id,
      p_items       => jsonb_build_array(jsonb_build_object(
                         'product_id', v_prod_coffee, 'quantity', 2,
                         'unit_price_cents', 9999,
                         'agreed_unit_price_cents', 2000)),
      p_payments    => jsonb_build_array(jsonb_build_object(
                         'method', 'cash', 'amount_cents', 4000, 'tendered_cents', 4000)),
      p_location_id => v_loc_id);
  exception
    when others then
      raise exception 'FAIL 14: 2 Coffee at an agreed 2000 must total 4000 and that sale was refused (6000 = the agreed price ignored and the line priced from the product). complete_sale said: %', sqlerrm;
  end;

  select total_cents into v_amount from public.sales where id = v_sale_id;
  if v_amount <> 4000 then
    raise exception 'FAIL 14: expected total_cents 4000 (2 x the agreed 2000), got % (6000 = priced from products.price_cents)', v_amount;
  end if;
  select count(*) into v_count from public.sale_items where sale_id = v_sale_id;
  if v_count <> 1 then
    raise exception 'FAIL 14: expected 1 sale_items row for a one-line cart, got %', v_count;
  end if;
  select unit_price_cents into v_int from public.sale_items where sale_id = v_sale_id;
  if v_int <> 2000 then
    raise exception 'FAIL 14: expected sale_items.unit_price_cents 2000 (the AGREED price), got % (3000 = the product''s price, 9999 = the cart''s old ignored field)', v_int;
  end if;
  select line_total_cents into v_int from public.sale_items where sale_id = v_sale_id;
  if v_int <> 4000 then
    raise exception 'FAIL 14: expected sale_items.line_total_cents 4000, got %', v_int;
  end if;
  select discount_cents into v_int from public.sale_items where sale_id = v_sale_id;
  if v_int <> 0 then
    raise exception 'FAIL 14: an agreed price landed on sale_items.discount_cents as %, expected 0 -- it is a price, not a reduction', v_int;
  end if;
  -- The one column an agreed price must NOT reach.
  select unit_cost_cents into v_int from public.sale_items where sale_id = v_sale_id;
  if v_int is distinct from 1100 then
    raise exception 'FAIL 14: expected unit_cost_cents 1100 (the product''s CURRENT cost), got % -- an agreed price must never move the cost or COGS is misstated', v_int;
  end if;

  select journal_entry_id into v_entry from public.sales where id = v_sale_id;
  select count(*) into v_count from public.journal_lines where entry_id = v_entry;
  if v_count <> 4 then
    raise exception 'FAIL 14: expected exactly 4 journal lines (cash, revenue, COGS, stock), got % (5 = the gap to list posted as a discount)', v_count;
  end if;
  -- Revenue at the AGREED price. The 1000 a unit the shop is not charging is
  -- not a discount it gave at the till -- it is the price of this sale -- so
  -- nothing reaches 4200 and revenue is 4000, not 6000 with a 2000 contra.
  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l join public.accounts a on a.id = l.account_id
   where l.entry_id = v_entry and a.code = '4000';
  if v_amount <> -4000 then
    raise exception 'FAIL 14: expected Cr 4000 Revenue -4000 at the AGREED price, got % (-6000 = credited at the product''s list price)', v_amount;
  end if;
  if exists (select 1 from public.journal_lines l join public.accounts a on a.id = l.account_id
              where l.entry_id = v_entry and a.code = '4200') then
    raise exception 'FAIL 14: an agreed price posted a 4200 contra -- it is the price of this sale, not a discount off another one';
  end if;
  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l join public.accounts a on a.id = l.account_id
   where l.entry_id = v_entry and a.code = '1000';
  if v_amount <> 4000 then
    raise exception 'FAIL 14: expected Dr 1000 Cash 4000, got %', v_amount;
  end if;
  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l join public.accounts a on a.id = l.account_id
   where l.entry_id = v_entry and a.code = '5000';
  if v_amount <> 2200 then
    raise exception 'FAIL 14: expected Dr 5000 COGS 2200 (2 x the frozen 1100), got % -- COGS follows the cost, never the agreed price', v_amount;
  end if;
  select coalesce(sum(amount_cents), 0) into v_amount from public.journal_lines where entry_id = v_entry;
  if v_amount <> 0 then
    raise exception 'FAIL 14: the entry does not balance, off by %', v_amount;
  end if;

  raise notice 'OK 14: 2 Coffee at an agreed 2000 files at 2000 and credits revenue 4000';

  ---------------------------------------------------------------------------
  -- 15. THE SAME CART WITHOUT AN AGREED PRICE IS UNCHANGED.
  --
  --     Byte-for-byte check 14's call with the one field removed: same product,
  --     same quantity, same location, same ignored 9999. It prices from
  --     products.price_cents at 3000 a unit and totals 6000.
  --
  --     Checks 1-13 already prove the no-agreed-price path in thirteen ways.
  --     This one is here because it is the CONTROLLED pair for 14 -- the only
  --     difference between the two calls is the field itself, so 14's 4000
  --     cannot be coming from anywhere else.
  ---------------------------------------------------------------------------
  begin
    v_sale_id := public.complete_sale(
      p_shop_id     => v_shop_id,
      p_items       => jsonb_build_array(jsonb_build_object(
                         'product_id', v_prod_coffee, 'quantity', 2,
                         'unit_price_cents', 9999)),
      p_payments    => jsonb_build_array(jsonb_build_object(
                         'method', 'cash', 'amount_cents', 6000, 'tendered_cents', 6000)),
      p_location_id => v_loc_id);
  exception
    when others then
      raise exception 'FAIL 15: check 14''s cart WITHOUT an agreed price must total 6000 and that sale was refused. complete_sale said: %', sqlerrm;
  end;

  select total_cents into v_amount from public.sales where id = v_sale_id;
  if v_amount <> 6000 then
    raise exception 'FAIL 15: expected total_cents 6000 from products.price_cents, got % (4000 = check 14''s agreed price leaking onto a cart that sent none)', v_amount;
  end if;
  select count(*) into v_count from public.sale_items where sale_id = v_sale_id;
  if v_count <> 1 then
    raise exception 'FAIL 15: expected 1 sale_items row for a one-line cart, got %', v_count;
  end if;
  select unit_price_cents into v_int from public.sale_items where sale_id = v_sale_id;
  if v_int <> 3000 then
    raise exception 'FAIL 15: expected sale_items.unit_price_cents 3000 (the PRODUCT''s price), got % (9999 = the cart''s own price, still meant to be ignored)', v_int;
  end if;
  select line_total_cents into v_int from public.sale_items where sale_id = v_sale_id;
  if v_int <> 6000 then
    raise exception 'FAIL 15: expected sale_items.line_total_cents 6000, got %', v_int;
  end if;
  select unit_cost_cents into v_int from public.sale_items where sale_id = v_sale_id;
  if v_int is distinct from 1100 then
    raise exception 'FAIL 15: expected unit_cost_cents 1100, got %', v_int;
  end if;

  select journal_entry_id into v_entry from public.sales where id = v_sale_id;
  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l join public.accounts a on a.id = l.account_id
   where l.entry_id = v_entry and a.code = '4000';
  if v_amount <> -6000 then
    raise exception 'FAIL 15: expected Cr 4000 Revenue -6000, got %', v_amount;
  end if;
  select coalesce(sum(amount_cents), 0) into v_amount from public.journal_lines where entry_id = v_entry;
  if v_amount <> 0 then
    raise exception 'FAIL 15: the entry does not balance, off by %', v_amount;
  end if;

  raise notice 'OK 15: the same cart with no agreed price still prices from the product at 6000';

  ---------------------------------------------------------------------------
  -- 16. AN AGREED PRICE AND A PROMOTION ON THE SAME LINE IS REFUSED.
  --
  --     They are two answers to one question. A promotion's discount is
  --     recomputed server-side from products.price_cents (:350-354) and is a
  --     reduction OFF the list price; an agreed price REPLACES the list price.
  --     Applied together, either the promotion is taken off a price it was
  --     never written against, or the agreed price silently swallows it -- and
  --     whichever the code happens to do, the shop cannot say which price the
  --     customer was actually promised.
  --
  --     So it raises, and the message is stable text a client can match on and
  --     turn into a sentence in the shopkeeper's own words. Asserted on the
  --     PREFIX, so the product name at the end can change without breaking it.
  --
  --     And the refusal writes NOTHING: the sale count is unmoved after it.
  ---------------------------------------------------------------------------
  begin
    v_sale_id := public.complete_sale(
      p_shop_id     => v_shop_id,
      p_items       => jsonb_build_array(jsonb_build_object(
                         'product_id', v_prod_coffee, 'quantity', 1,
                         'unit_price_cents', 9999,
                         'agreed_unit_price_cents', 2000,
                         'discount_cents', 300, 'promotion_id', v_promo_id)),
      p_payments    => jsonb_build_array(jsonb_build_object(
                         'method', 'cash', 'amount_cents', 1700, 'tendered_cents', 1700)),
      p_location_id => v_loc_id);
    select total_cents into v_amount from public.sales where id = v_sale_id;
    raise exception 'FAIL 16: an agreed price of 2000 alongside a 10%% promotion was ACCEPTED, and the sale totalled % -- the two are different answers to what the customer pays and one of them is being silently discarded', v_amount;
  exception
    when others then
      if sqlerrm like 'FAIL 16:%' then
        raise;
      end if;
      if sqlerrm not like 'an agreed price cannot be combined with a promotion%' then
        raise exception 'FAIL 16: expected a refusal naming the agreed-price/promotion clash, got: %', sqlerrm;
      end if;
  end;

  select count(*) into v_count from public.sales where shop_id = v_shop_id;
  if v_count <> 14 then
    raise exception 'FAIL 16: expected 14 sales after a REFUSED one, got % -- the refusal left a sale behind', v_count;
  end if;

  raise notice 'OK 16: an agreed price alongside a promotion is refused by name and writes nothing';

  ---------------------------------------------------------------------------
  -- 17. A NEGATIVE AGREED PRICE IS REFUSED.
  --
  --     The agreed price arrives in a JSON payload from a caller. It is input,
  --     not truth, and it goes straight onto sale_items.unit_price_cents and
  --     into the revenue credit. A negative one is a line that PAYS the
  --     customer: the sale's total falls below the goods on it, the 4000 credit
  --     goes the wrong way, and nothing else in this function would notice --
  --     `v_line < 0` (:364) only catches it when the discount is the cause.
  ---------------------------------------------------------------------------
  begin
    v_sale_id := public.complete_sale(
      p_shop_id     => v_shop_id,
      p_items       => jsonb_build_array(
                         jsonb_build_object('product_id', v_prod_tea, 'quantity', 1,
                                            'unit_price_cents', 9999),
                         jsonb_build_object('product_id', v_prod_coffee, 'quantity', 1,
                                            'unit_price_cents', 9999,
                                            'agreed_unit_price_cents', -500)),
      p_payments    => jsonb_build_array(jsonb_build_object(
                         'method', 'cash', 'amount_cents', 700, 'tendered_cents', 700)),
      p_location_id => v_loc_id);
    select total_cents into v_amount from public.sales where id = v_sale_id;
    raise exception 'FAIL 17: an agreed price of -500 was ACCEPTED and the sale totalled % -- a line cannot pay the customer', v_amount;
  exception
    when others then
      if sqlerrm like 'FAIL 17:%' then
        raise;
      end if;
      if sqlerrm not like 'agreed price for % cannot be negative%' then
        raise exception 'FAIL 17: expected a refusal naming the negative agreed price, got: %', sqlerrm;
      end if;
  end;

  select count(*) into v_count from public.sales where shop_id = v_shop_id;
  if v_count <> 14 then
    raise exception 'FAIL 17: expected 14 sales after a REFUSED one, got %', v_count;
  end if;

  raise notice 'OK 17: a negative agreed price is refused by name and writes nothing';

  ---------------------------------------------------------------------------
  -- 18. AN OUT-OF-RANGE AGREED PRICE IS REFUSED, and the bound is on the LINE.
  --
  --     Two calls, because there are two ways to be absurd and only one of them
  --     is about the unit:
  --
  --       a) 2,000,000,000 cents a unit -- $20 million for a coffee. It fits in
  --          a 32-bit integer, so nothing downstream complains; it just files a
  --          sale for twenty million dollars and posts it to the shop's books.
  --       b) 1,000,000,000 a unit x 3 -- each unit is at the ceiling, and the
  --          LINE is 3,000,000,000, which does not fit. Unbounded, this is a
  --          bare `integer out of range` raised from the middle of the
  --          register's write path, with nothing to say which line or why.
  --
  --     Checked in bigint BEFORE the line is computed, which is what makes (b)
  --     a sentence rather than an overflow.
  ---------------------------------------------------------------------------
  begin
    v_sale_id := public.complete_sale(
      p_shop_id     => v_shop_id,
      p_items       => jsonb_build_array(jsonb_build_object(
                         'product_id', v_prod_coffee, 'quantity', 1,
                         'unit_price_cents', 9999,
                         'agreed_unit_price_cents', 2000000000)),
      p_payments    => jsonb_build_array(jsonb_build_object(
                         'method', 'cash', 'amount_cents', 2000000000, 'tendered_cents', 2000000000)),
      p_location_id => v_loc_id);
    select total_cents into v_amount from public.sales where id = v_sale_id;
    raise exception 'FAIL 18a: an agreed price of 2000000000 cents was ACCEPTED and the sale totalled %', v_amount;
  exception
    when others then
      if sqlerrm like 'FAIL 18a:%' then
        raise;
      end if;
      if sqlerrm not like 'agreed price for % is out of range%' then
        raise exception 'FAIL 18a: expected a refusal naming the out-of-range agreed price, got: %', sqlerrm;
      end if;
  end;

  begin
    v_sale_id := public.complete_sale(
      p_shop_id     => v_shop_id,
      p_items       => jsonb_build_array(jsonb_build_object(
                         'product_id', v_prod_coffee, 'quantity', 3,
                         'unit_price_cents', 9999,
                         'agreed_unit_price_cents', 1000000000)),
      p_payments    => jsonb_build_array(jsonb_build_object(
                         'method', 'cash', 'amount_cents', 1000, 'tendered_cents', 1000)),
      p_location_id => v_loc_id);
    raise exception 'FAIL 18b: a line of 3 x 1000000000 was ACCEPTED';
  exception
    when others then
      if sqlerrm like 'FAIL 18b:%' then
        raise;
      end if;
      if sqlerrm not like 'agreed price for % is out of range%' then
        raise exception 'FAIL 18b: expected the LINE to be refused as out of range before it overflowed, got: % (integer out of range = the bound is on the unit only, or is missing)', sqlerrm;
      end if;
  end;

  select count(*) into v_count from public.sales where shop_id = v_shop_id;
  if v_count <> 14 then
    raise exception 'FAIL 18: expected 14 sales after two REFUSED ones, got %', v_count;
  end if;

  raise notice 'OK 18: an absurd agreed price, and a line that would overflow, are both refused by name';

  ---------------------------------------------------------------------------
  -- 19. ZERO IS A PRICE, NOT AN ABSENCE -- and an agreed price binds ONE line.
  --
  --     A two-line cart:
  --       1 Coffee at an agreed 0 -- the item the shop promised to throw in
  --       1 Tea    with no agreed price at all, so 1200 from the product
  --                                        -----
  --       total                              1200, COGS 1100 + 450 = 1550
  --
  --     Two properties in one cart, and each fails a different mistake:
  --
  --       * `case when v_agreed > 0 then v_agreed else price end` -- which reads
  --         perfectly naturally -- charges 3000 for the free item and totals
  --         4200. The customer is billed for something they were promised.
  --       * an agreed price read once and applied to the whole cart prices the
  --         Tea at 0 too, and totals 0.
  --
  --     Neither is caught by any check above: 14 and 15 have one line each and
  --     never send a zero.
  --
  --     The cost side is the point again. The free Coffee still cost the shop
  --     1100, so 1550 of COGS is recognised against 1200 of revenue and this
  --     sale is correctly a loss. A cost that followed the agreed price would
  --     read 450 and make giving stock away look free.
  ---------------------------------------------------------------------------
  begin
    v_sale_id := public.complete_sale(
      p_shop_id     => v_shop_id,
      p_items       => jsonb_build_array(
                         jsonb_build_object('product_id', v_prod_coffee, 'quantity', 1,
                                            'unit_price_cents', 9999,
                                            'agreed_unit_price_cents', 0),
                         jsonb_build_object('product_id', v_prod_tea, 'quantity', 1,
                                            'unit_price_cents', 9999)),
      p_payments    => jsonb_build_array(jsonb_build_object(
                         'method', 'cash', 'amount_cents', 1200, 'tendered_cents', 1200)),
      p_location_id => v_loc_id);
  exception
    when others then
      raise exception 'FAIL 19: a promised-free Coffee beside a 1200 Tea must total 1200 and that sale was refused (4200 = zero read as "no agreed price", 0 = one line''s agreed price applied to the whole cart). complete_sale said: %', sqlerrm;
  end;

  select total_cents into v_amount from public.sales where id = v_sale_id;
  if v_amount <> 1200 then
    raise exception 'FAIL 19: expected total_cents 1200, got % (4200 = an agreed price of 0 treated as absent, 0 = it applied to both lines)', v_amount;
  end if;
  select count(*) into v_count from public.sale_items where sale_id = v_sale_id;
  if v_count <> 2 then
    raise exception 'FAIL 19: expected 2 sale_items rows for a two-line cart, got %', v_count;
  end if;

  -- Addressed by product, so neither row can satisfy the other's assertion.
  select unit_price_cents, line_total_cents, unit_cost_cents into v_int, v_num, v_amount
    from public.sale_items where sale_id = v_sale_id and product_id = v_prod_coffee;
  if v_int <> 0 or v_num <> 0 or v_amount is distinct from 1100 then
    raise exception 'FAIL 19: expected the Coffee line at an agreed 0 = 0 costing 1100, got % x qty = % costing % (3000/3000 = zero read as absent)',
      v_int, v_num, v_amount;
  end if;
  select unit_price_cents, line_total_cents, unit_cost_cents into v_int, v_num, v_amount
    from public.sale_items where sale_id = v_sale_id and product_id = v_prod_tea;
  if v_int <> 1200 or v_num <> 1200 or v_amount is distinct from 450 then
    raise exception 'FAIL 19: expected the Tea line at the product''s 1200 = 1200 costing 450, got % x qty = % costing % (0 = the other line''s agreed price reached this one)',
      v_int, v_num, v_amount;
  end if;

  select journal_entry_id into v_entry from public.sales where id = v_sale_id;
  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l join public.accounts a on a.id = l.account_id
   where l.entry_id = v_entry and a.code = '4000';
  if v_amount <> -1200 then
    raise exception 'FAIL 19: expected Cr 4000 Revenue -1200 (the Tea alone; the Coffee was promised free), got %', v_amount;
  end if;
  if exists (select 1 from public.journal_lines l join public.accounts a on a.id = l.account_id
              where l.entry_id = v_entry and a.code = '4200') then
    raise exception 'FAIL 19: a promised-free line posted a 4200 contra -- an agreed price is a price, not a discount';
  end if;
  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l join public.accounts a on a.id = l.account_id
   where l.entry_id = v_entry and a.code = '5000';
  if v_amount <> 1550 then
    raise exception 'FAIL 19: expected Dr 5000 COGS 1550 (1100 + 450 -- the free item still cost the shop 1100), got %', v_amount;
  end if;
  select coalesce(sum(amount_cents), 0) into v_amount from public.journal_lines where entry_id = v_entry;
  if v_amount <> 0 then
    raise exception 'FAIL 19: the entry does not balance, off by %', v_amount;
  end if;

  raise notice 'OK 19: an agreed price of 0 is honoured on its own line and the other line prices from the product';

  ---------------------------------------------------------------------------
  -- 20. AN AGREED PRICE BELOW THE SHELF PRICE NEEDS discounts.manual.
  --
  --     Every check above runs as the shop's OWNER, who short-circuits every
  --     permission in user_has_shop_permission -- so nothing above this line
  --     can see a gate at all. This one rings up as a member holding
  --     `pos.access` and NOTHING else.
  --
  --     The regression it pins is a straight bypass: `discount_cents` with no
  --     promotion behind it has needed `discounts.manual` since 0024, and the
  --     first version of the agreed price let the same cashier reach the same
  --     figure through a different field. One cent off through `discount_cents`
  --     is refused; the whole line at one cent through `agreed_unit_price_cents`
  --     went through.
  --
  --     Coffee is 3000. The agreed price is 100, so this is an undercut of 2900
  --     by a member who may not discount at all, and it must be refused by name.
  ---------------------------------------------------------------------------
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
    values (v_staff_id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            'verify-complete-sale-baseline-staff-' || v_staff_id || '@example.test', '', now(), now(), now());

  -- pos.access ALONE. Not a copy of the seeded Cashier role, which
  -- 20260826000100 gives discounts.manual -- that is the whole point of this
  -- check, and building the role from a default would make it assert nothing.
  insert into public.roles (shop_id, name, permissions)
    values (v_shop_id, 'Baseline Till Only', array['pos.access'])
    returning id into v_role_id;
  -- No shop_member_locations rows, so can_access_location resolves to every
  -- store in the shop and the refusal below cannot be about the location.
  insert into public.shop_members (shop_id, user_id, role_id, active)
    values (v_shop_id, v_staff_id, v_role_id, true);

  perform set_config('request.jwt.claims', json_build_object('sub', v_staff_id)::text, true);

  -- The gate is real for this member: they can ring up, and they cannot
  -- discount. Asserted directly, so a failure below can only be about the
  -- agreed price rather than about the fixture.
  if not public.has_shop_permission(v_shop_id, 'pos.access') then
    raise exception 'FAIL 20: the fixture member should hold pos.access';
  end if;
  if public.has_shop_permission(v_shop_id, 'discounts.manual') then
    raise exception 'FAIL 20: the fixture member must NOT hold discounts.manual, or this check asserts nothing';
  end if;

  begin
    v_sale_id := public.complete_sale(
      p_shop_id     => v_shop_id,
      p_items       => jsonb_build_array(jsonb_build_object(
                         'product_id', v_prod_coffee, 'quantity', 1,
                         'unit_price_cents', 9999,
                         'agreed_unit_price_cents', 100)),
      p_payments    => jsonb_build_array(jsonb_build_object(
                         'method', 'cash', 'amount_cents', 100, 'tendered_cents', 100)),
      p_location_id => v_loc_id);
    select total_cents into v_amount from public.sales where id = v_sale_id;
    raise exception 'FAIL 20: a member WITHOUT discounts.manual filed a 3000 line at an agreed 100 and the sale totalled % -- the agreed price is a way around the discount permission', v_amount;
  exception
    when others then
      if sqlerrm like 'FAIL 20:%' then
        raise;
      end if;
      if sqlerrm not like 'not authorized to file a line below the shelf price%' then
        raise exception 'FAIL 20: expected a refusal naming the missing discount permission, got: %', sqlerrm;
      end if;
  end;

  select count(*) into v_count from public.sales where shop_id = v_shop_id;
  if v_count <> 15 then
    raise exception 'FAIL 20: expected 15 sales after a REFUSED one, got % -- the refusal left a sale behind', v_count;
  end if;

  raise notice 'OK 20: a member without discounts.manual cannot undercut the shelf price through an agreed price';

  ---------------------------------------------------------------------------
  -- 21. THE GATE IS ON THE UNDERCUT, NOT ON THE FIELD -- and an agreed price
  --     ABOVE list is PERMITTED, deliberately.
  --
  --     Still the same pos.access-only member from check 20, which is what
  --     makes both halves mean something.
  --
  --     a) AT the shelf price. 1 Coffee, agreed 3000, list 3000. Nothing is
  --        leaving the shop, so nothing is asked for. A gate written on
  --        `v_agreed_price is not null` rather than on the direction refuses
  --        this and takes the whole feature away from every shop that has ever
  --        revoked discounts.manual -- which is 20260929000000's own stated
  --        objection to gating, and it is answered by the shape of the
  --        condition rather than by leaving the gate out.
  --
  --     b) ABOVE the shelf price. 1 Tea, list 1200, agreed 1500. Accepted, and
  --        filed at 1500 with revenue credited 1500.
  --
  --        THIS IS A DECISION, not an omission, and it is pinned here so it
  --        stays one. A shop that CUTS a price after quoting leaves the customer
  --        holding a quote above today's shelf price, and that quote is still
  --        what they agreed to -- refusing it would break storefront fulfilment
  --        in the mirror of the case the agreed price exists for. Nothing in
  --        this system gates charging MORE (a cashier could always ring up an
  --        extra unit), an overcharge cannot happen without the customer handing
  --        over the money the payments-equality check demands, and unlike a
  --        discount it leaves its own trace: 1500 on the receipt and 1500 in
  --        revenue. Bounded only by the ceiling check 22 exercises.
  ---------------------------------------------------------------------------
  begin
    v_sale_id := public.complete_sale(
      p_shop_id     => v_shop_id,
      p_items       => jsonb_build_array(jsonb_build_object(
                         'product_id', v_prod_coffee, 'quantity', 1,
                         'unit_price_cents', 9999,
                         'agreed_unit_price_cents', 3000)),
      p_payments    => jsonb_build_array(jsonb_build_object(
                         'method', 'cash', 'amount_cents', 3000, 'tendered_cents', 3000)),
      p_location_id => v_loc_id);
  exception
    when others then
      raise exception 'FAIL 21a: an agreed price EQUAL to the 3000 shelf price takes nothing out of the shop and must not need discounts.manual, and it was refused (the gate is on the field rather than on the undercut). complete_sale said: %', sqlerrm;
  end;

  select unit_price_cents into v_int from public.sale_items where sale_id = v_sale_id;
  if v_int <> 3000 then
    raise exception 'FAIL 21a: expected sale_items.unit_price_cents 3000, got %', v_int;
  end if;

  begin
    v_sale_id := public.complete_sale(
      p_shop_id     => v_shop_id,
      p_items       => jsonb_build_array(jsonb_build_object(
                         'product_id', v_prod_tea, 'quantity', 1,
                         'unit_price_cents', 9999,
                         'agreed_unit_price_cents', 1500)),
      p_payments    => jsonb_build_array(jsonb_build_object(
                         'method', 'cash', 'amount_cents', 1500, 'tendered_cents', 1500)),
      p_location_id => v_loc_id);
  exception
    when others then
      raise exception 'FAIL 21b: an agreed price of 1500 ABOVE the 1200 shelf price is permitted on purpose -- a shop that CUT its price after quoting still owes the quote -- and it was refused. complete_sale said: %', sqlerrm;
  end;

  select total_cents into v_amount from public.sales where id = v_sale_id;
  if v_amount <> 1500 then
    raise exception 'FAIL 21b: expected total_cents 1500 (the AGREED price, above the 1200 shelf price), got %', v_amount;
  end if;
  select unit_price_cents into v_int from public.sale_items where sale_id = v_sale_id;
  if v_int <> 1500 then
    raise exception 'FAIL 21b: expected sale_items.unit_price_cents 1500, got % (1200 = an above-list agreed price silently clamped to the shelf price)', v_int;
  end if;
  select journal_entry_id into v_entry from public.sales where id = v_sale_id;
  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l join public.accounts a on a.id = l.account_id
   where l.entry_id = v_entry and a.code = '4000';
  if v_amount <> -1500 then
    raise exception 'FAIL 21b: expected Cr 4000 Revenue -1500 at the agreed price, got %', v_amount;
  end if;

  select count(*) into v_count from public.sales where shop_id = v_shop_id;
  if v_count <> 17 then
    raise exception 'FAIL 21: expected 17 sales after two ACCEPTED ones, got %', v_count;
  end if;

  -- Back to the owner for what remains, so check 22 is measuring the ceiling
  -- rather than the permission check 20 just installed.
  perform set_config('request.jwt.claims', json_build_object('sub', v_user_id)::text, true);

  raise notice 'OK 21: an agreed price at or above the shelf price needs no discount permission and is filed as sent';

  ---------------------------------------------------------------------------
  -- 22. THE CEILING PREVENTS WHAT IT SAYS IT PREVENTS -- both ways.
  --
  --     Check 18 already refuses 2,000,000,000 on a unit and 3 x 1,000,000,000
  --     on a line. Both of those figures happen to survive being READ into an
  --     integer and happen to be caught by a bound on ONE line, and that is why
  --     they left two holes open:
  --
  --     a) 3,000,000,000 A UNIT does not survive being read. As
  --        `v_agreed_price integer` the parse itself raised
  --        `value "3000000000" is out of range for type integer` -- a Postgres
  --        cast error naming a type, from one statement BEFORE the bound written
  --        to catch it. The caller was told about a column type instead of about
  --        a price. Asserted on the message: it must be the sentence, and it
  --        must NOT be the cast error.
  --
  --     b) THREE LINES OF 1,000,000,000 each pass the per-line bound -- that is
  --        what per-line means -- and then overflow `v_gross_cents integer` in
  --        the accumulation, which is a bare `integer out of range` raised from
  --        the middle of the register's write path: exactly the failure the
  --        line bound's own comment claimed to have prevented. Every line here
  --        is individually legal, so nothing but a bound on the RUNNING TOTAL
  --        can refuse this cart.
  --
  --        Three DIFFERENT products, because the loop orders by product id and
  --        the same product three times would take the same row lock three
  --        times; and 1000 units of stock each, so the refusal cannot be
  --        insufficient stock wearing a different hat.
  ---------------------------------------------------------------------------
  begin
    v_sale_id := public.complete_sale(
      p_shop_id     => v_shop_id,
      p_items       => jsonb_build_array(jsonb_build_object(
                         'product_id', v_prod_coffee, 'quantity', 1,
                         'unit_price_cents', 9999,
                         'agreed_unit_price_cents', 3000000000)),
      p_payments    => jsonb_build_array(jsonb_build_object(
                         'method', 'cash', 'amount_cents', 1000, 'tendered_cents', 1000)),
      p_location_id => v_loc_id);
    raise exception 'FAIL 22a: an agreed price of 3000000000 was ACCEPTED';
  exception
    when others then
      if sqlerrm like 'FAIL 22a:%' then
        raise;
      end if;
      if sqlerrm not like 'agreed price for % is out of range%' then
        raise exception 'FAIL 22a: expected the out-of-range SENTENCE, got: % (a message about type integer means the value died at the parse, one statement before the bound meant to catch it)', sqlerrm;
      end if;
  end;

  begin
    v_sale_id := public.complete_sale(
      p_shop_id     => v_shop_id,
      p_items       => jsonb_build_array(
                         jsonb_build_object('product_id', v_prod_coffee, 'quantity', 1,
                                            'unit_price_cents', 9999,
                                            'agreed_unit_price_cents', 1000000000),
                         jsonb_build_object('product_id', v_prod_tea, 'quantity', 1,
                                            'unit_price_cents', 9999,
                                            'agreed_unit_price_cents', 1000000000),
                         jsonb_build_object('product_id', v_prod_cake, 'quantity', 1,
                                            'unit_price_cents', 9999,
                                            'agreed_unit_price_cents', 1000000000)),
      p_payments    => jsonb_build_array(jsonb_build_object(
                         'method', 'cash', 'amount_cents', 1000, 'tendered_cents', 1000)),
      p_location_id => v_loc_id);
    raise exception 'FAIL 22b: three lines of 1000000000 -- each individually legal -- were ACCEPTED';
  exception
    when others then
      if sqlerrm like 'FAIL 22b:%' then
        raise;
      end if;
      if sqlerrm not like 'this sale is out of range%' then
        raise exception 'FAIL 22b: expected the running total to be refused as out of range BEFORE it overflowed, got: % (integer out of range = the bound is on the line only, so an accumulation across lines still overflows mid-sale)', sqlerrm;
      end if;
  end;

  select count(*) into v_count from public.sales where shop_id = v_shop_id;
  if v_count <> 17 then
    raise exception 'FAIL 22: expected 17 sales after two REFUSED ones, got %', v_count;
  end if;

  raise notice 'OK 22: a unit past the 32-bit ceiling and an accumulation past it are both refused by name';

  raise notice 'ALL CHECKS PASSED: complete_sale baseline pinned (13 checks) + the agreed price (9 more)';
  raise exception 'rollback_marker';
exception
  when others then
    if sqlerrm = 'rollback_marker' then
      raise notice 'verify-complete-sale-baseline: ALL CHECKS PASSED, rolled back';
    else
      raise;
    end if;
end $$;
