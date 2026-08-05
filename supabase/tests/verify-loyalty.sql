-- End-to-end verification of customer loyalty points against a real database.
-- Everything runs inside one DO block whose EXCEPTION clause rolls the whole
-- lot back, so it leaves no rows behind.
--
-- Covers what the TypeScript suite cannot reach: the arithmetic inside
-- complete_sale, the ledger/counter trigger, the balance lock, and the way
-- refunds, edits and deletions move points back.
--
-- The check that matters most is #6, repeated after every step: the stored
-- balance must always equal the sum of the ledger. If those two ever drift,
-- every other number here is meaningless.

\set ON_ERROR_STOP on

do $$
declare
  v_user_id uuid := gen_random_uuid();
  v_shop_id uuid;
  v_location_id uuid;
  v_product_id uuid;
  v_customer_id uuid;
  v_free_id uuid;
  v_sale_id uuid;
  v_sale_3x_id uuid;
  v_redeemed_sale_id uuid;
  v_doomed_sale_id uuid;
  v_sale_c_id uuid;
  v_item_id uuid;
  v_refund_id uuid;
  v_items jsonb;
  v_earned integer;
  v_redeemed integer;
  v_redeemed_cents integer;
  v_total integer;
  v_balance integer;
  v_ledger_sum integer;
  v_count integer;
  v_raised boolean;
  v_detail text;
begin
  ------------------------------------------------------------------
  -- Setup: a user, a shop, a store, a product with stock, a customer.
  ------------------------------------------------------------------
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
    values (v_user_id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            'verify-loyalty-' || v_user_id || '@example.test', '', now(), now(), now());

  insert into public.shops (owner_id, name) values (v_user_id, 'Loyalty Verify Shop') returning id into v_shop_id;

  perform set_config('request.jwt.claims', json_build_object('sub', v_user_id)::text, true);
  perform set_config('role', 'authenticated', true);

  insert into public.shop_locations (shop_id, name, is_primary)
    values (v_shop_id, 'Main', true) returning id into v_location_id;

  -- $19.99, chosen so the floor-vs-round question has a visible answer.
  insert into public.products (shop_id, name, price_cents, cost_cents)
    values (v_shop_id, 'Verify Soap', 1999, 800) returning id into v_product_id;

  insert into public.product_location_stock (product_id, location_id, stock)
    values (v_product_id, v_location_id, 1000);

  insert into public.customers (shop_id, first_name) values (v_shop_id, 'Loyal Larry')
    returning id into v_customer_id;

  v_items := jsonb_build_array(jsonb_build_object('product_id', v_product_id, 'quantity', 1, 'discount_cents', 0));

  ------------------------------------------------------------------
  raise notice '=== 1. Loyalty off earns nothing, even with a customer attached ===';
  ------------------------------------------------------------------
  select public.complete_sale(
    v_shop_id, v_items,
    jsonb_build_array(jsonb_build_object('method', 'cash', 'amount_cents', 1999, 'tendered_cents', 2000)),
    null, null, null, null, 0, v_customer_id, null, v_location_id, 0
  ) into v_sale_id;

  select points_earned into v_earned from public.sales where id = v_sale_id;
  if v_earned <> 0 then raise exception 'FAIL: loyalty off but the sale earned % points', v_earned; end if;

  select count(*) into v_count from public.customer_points_ledger where customer_id = v_customer_id;
  if v_count <> 0 then raise exception 'FAIL: loyalty off but % ledger rows were written', v_count; end if;
  raise notice 'OK: no points earned and no ledger rows while loyalty is off';

  -- The maturing window is switched OFF for the arithmetic checks below, which
  -- are about what a sale earns and refunds and would otherwise all trip over
  -- points that are seconds old. It gets its own section (11) where it is the
  -- thing under test.
  update public.shops
    set loyalty_enabled = true, loyalty_points_per_usd = 1, loyalty_cents_per_point = 1,
        loyalty_points_available_after_days = 0
    where id = v_shop_id;

  ------------------------------------------------------------------
  raise notice '=== 2. A $19.99 basket earns 20 points, not 19 ===';
  ------------------------------------------------------------------
  -- The defining case for round(): being a penny short of twenty dollars must
  -- not visibly cost a point at the counter.
  select public.complete_sale(
    v_shop_id, v_items,
    jsonb_build_array(jsonb_build_object('method', 'cash', 'amount_cents', 1999, 'tendered_cents', 2000)),
    null, null, null, null, 0, v_customer_id, null, v_location_id, 0
  ) into v_sale_id;

  select points_earned, loyalty_points_per_usd into v_earned, v_detail from public.sales where id = v_sale_id;
  if v_earned <> 20 then raise exception 'FAIL: $19.99 earned % points, expected 20', v_earned; end if;
  if v_detail is null then raise exception 'FAIL: the earn rate was not snapshotted onto the sale'; end if;
  raise notice 'OK: $19.99 earned 20 points at the frozen rate of %', v_detail;

  select points_balance into v_balance from public.customers where id = v_customer_id;
  if v_balance <> 20 then raise exception 'FAIL: balance % after earning 20', v_balance; end if;

  ------------------------------------------------------------------
  raise notice '=== 3. Tax does not change what a sale earns ===';
  ------------------------------------------------------------------
  -- Points are earned on the goods, not on money collected for the state.
  update public.shops set tax_enabled = true, tax_rate_percent = 5 where id = v_shop_id;

  select public.complete_sale(
    v_shop_id, v_items,
    -- 1999 + round(1999 * 5 / 100) = 1999 + 100
    jsonb_build_array(jsonb_build_object('method', 'cash', 'amount_cents', 2099, 'tendered_cents', 2100)),
    null, null, null, null, 0, v_customer_id, null, v_location_id, 0
  ) into v_sale_id;

  select points_earned, tax_cents into v_earned, v_total from public.sales where id = v_sale_id;
  if v_earned <> 20 then raise exception 'FAIL: with tax on, the same basket earned %, expected 20', v_earned; end if;
  if v_total <> 100 then raise exception 'FAIL: expected 100c of tax, got %', v_total; end if;
  raise notice 'OK: 20 points earned pre-tax, with 100c of tax charged on top';

  update public.shops set tax_enabled = false where id = v_shop_id;

  select points_balance into v_balance from public.customers where id = v_customer_id;
  if v_balance <> 40 then raise exception 'FAIL: balance % after two earning sales, expected 40', v_balance; end if;

  ------------------------------------------------------------------
  raise notice '=== 4. Redeeming takes money off before tax, and the payment must match ===';
  ------------------------------------------------------------------
  -- Paying the un-reduced total is refused: the redemption really did change
  -- what is owed, rather than being recorded and ignored.
  v_raised := false;
  begin
    perform public.complete_sale(
      v_shop_id, v_items,
      jsonb_build_array(jsonb_build_object('method', 'cash', 'amount_cents', 1999, 'tendered_cents', 2000)),
      null, null, null, null, 0, v_customer_id, null, v_location_id, 40
    );
  exception when others then
    v_raised := true; v_detail := sqlerrm;
  end;
  if not v_raised then raise exception 'FAIL: a payment ignoring the redemption was accepted'; end if;
  raise notice 'OK: over-payment refused (%)', v_detail;

  select public.complete_sale(
    v_shop_id, v_items,
    -- 1999 - (40 points x 1c) = 1959
    jsonb_build_array(jsonb_build_object('method', 'cash', 'amount_cents', 1959, 'tendered_cents', 2000)),
    null, null, null, null, 0, v_customer_id, null, v_location_id, 40
  ) into v_redeemed_sale_id;

  select points_redeemed, points_redeemed_cents, total_cents, points_earned, discount_cents
    into v_redeemed, v_redeemed_cents, v_total, v_earned, v_count
    from public.sales where id = v_redeemed_sale_id;
  if v_redeemed <> 40 then raise exception 'FAIL: points_redeemed % <> 40', v_redeemed; end if;
  if v_redeemed_cents <> 40 then raise exception 'FAIL: redemption worth %c, expected 40c', v_redeemed_cents; end if;
  if v_total <> 1959 then raise exception 'FAIL: total % <> 1959', v_total; end if;
  -- Kept out of discount_cents, so a receipt can print the two separately.
  if v_count <> 0 then raise exception 'FAIL: the redemption leaked into discount_cents (%)', v_count; end if;
  -- Earned on what was actually paid in money: round(19.59) = 20.
  if v_earned <> 20 then raise exception 'FAIL: earned % on the reduced total, expected 20', v_earned; end if;
  raise notice 'OK: 40 points took 40c off, and the reduced total earned 20';

  -- Two ledger rows for one sale, never one net row: "spent 38, earned 19" is
  -- what a customer disputing a balance needs to see.
  select count(*) into v_count from public.customer_points_ledger where sale_id = v_redeemed_sale_id;
  if v_count <> 2 then raise exception 'FAIL: expected a redeem row and an earn row, found %', v_count; end if;

  select points_balance into v_balance from public.customers where id = v_customer_id;
  if v_balance <> 20 then raise exception 'FAIL: balance % after 40 - 40 + 20, expected 20', v_balance; end if;

  ------------------------------------------------------------------
  raise notice '=== 5. Redeeming more than the balance is refused, and changes nothing ===';
  ------------------------------------------------------------------
  v_raised := false;
  begin
    perform public.complete_sale(
      v_shop_id, v_items,
      jsonb_build_array(jsonb_build_object('method', 'cash', 'amount_cents', 999, 'tendered_cents', 1000)),
      null, null, null, null, 0, v_customer_id, null, v_location_id, 1000
    );
  exception when others then
    v_raised := true; v_detail := sqlerrm;
  end;
  if not v_raised then raise exception 'FAIL: redeeming 1000 points against a balance of 20 succeeded'; end if;

  select points_balance into v_balance from public.customers where id = v_customer_id;
  if v_balance <> 20 then raise exception 'FAIL: a refused redemption moved the balance to %', v_balance; end if;
  raise notice 'OK: refused (%), balance untouched at 20', v_detail;

  ------------------------------------------------------------------
  raise notice '=== 6. The stored balance equals the ledger, always ===';
  ------------------------------------------------------------------
  select points_balance into v_balance from public.customers where id = v_customer_id;
  select coalesce(sum(delta_points), 0) into v_ledger_sum
    from public.customer_points_ledger where customer_id = v_customer_id;
  if v_balance <> v_ledger_sum then
    raise exception 'FAIL: counter % <> ledger sum % -- the trigger has drifted', v_balance, v_ledger_sum;
  end if;
  raise notice 'OK: counter and ledger agree at %', v_balance;

  ------------------------------------------------------------------
  raise notice '=== 7. A partial refund claws back in proportion, and N parts equal the whole ===';
  ------------------------------------------------------------------
  select public.complete_sale(
    v_shop_id,
    jsonb_build_array(jsonb_build_object('product_id', v_product_id, 'quantity', 3, 'discount_cents', 0)),
    jsonb_build_array(jsonb_build_object('method', 'cash', 'amount_cents', 5997, 'tendered_cents', 6000)),
    null, null, null, null, 0, v_customer_id, null, v_location_id, 0
  ) into v_sale_3x_id;

  select points_earned into v_earned from public.sales where id = v_sale_3x_id;
  if v_earned <> 60 then raise exception 'FAIL: $59.97 earned %, expected 60', v_earned; end if;

  select id into v_item_id from public.sale_items where sale_id = v_sale_3x_id;
  select points_balance into v_balance from public.customers where id = v_customer_id;
  if v_balance <> 80 then raise exception 'FAIL: balance % before refunds, expected 80', v_balance; end if;

  -- One of three back: floor(60 * 1999 / 5997) = 20.
  perform public.refund_sale_items(v_sale_3x_id,
    jsonb_build_array(jsonb_build_object('sale_item_id', v_item_id, 'quantity', 1)));

  select points_balance into v_balance from public.customers where id = v_customer_id;
  if v_balance <> 60 then raise exception 'FAIL: balance % after refunding 1 of 3, expected 60', v_balance; end if;
  raise notice 'OK: refunding 1 of 3 clawed back 20 of 60';

  -- The other two: the cumulative clawback must land on exactly 59, with no
  -- drift from having done it in two passes.
  perform public.refund_sale_items(v_sale_3x_id,
    jsonb_build_array(jsonb_build_object('sale_item_id', v_item_id, 'quantity', 2)));

  select coalesce(sum(-delta_points), 0) into v_count
    from public.customer_points_ledger
    where sale_id = v_sale_3x_id and reason = 'refund_clawback';
  if v_count <> 60 then
    raise exception 'FAIL: two partial refunds clawed back % of 60 earned -- rounding drift', v_count;
  end if;

  select points_balance into v_balance from public.customers where id = v_customer_id;
  if v_balance <> 20 then raise exception 'FAIL: balance % after refunding all 3, expected 20', v_balance; end if;
  raise notice 'OK: three units refunded one-then-two clawed back exactly the 60 earned';

  ------------------------------------------------------------------
  raise notice '=== 8. A full refund gives redeemed points back, exactly once ===';
  ------------------------------------------------------------------
  select id into v_item_id from public.sale_items where sale_id = v_redeemed_sale_id;
  perform public.refund_sale_items(v_redeemed_sale_id,
    jsonb_build_array(jsonb_build_object('sale_item_id', v_item_id, 'quantity', 1)));

  select count(*) into v_count from public.customer_points_ledger
    where sale_id = v_redeemed_sale_id and reason = 'redeem_reversed';
  if v_count <> 1 then raise exception 'FAIL: expected one redeem_reversed row, found %', v_count; end if;

  select coalesce(sum(delta_points), 0) into v_count from public.customer_points_ledger
    where sale_id = v_redeemed_sale_id and reason = 'redeem_reversed';
  if v_count <> 40 then raise exception 'FAIL: returned % redeemed points, expected 40', v_count; end if;

  -- Refunding again is refused on quantity grounds, which is the outer guard;
  -- the `not exists` check inside refund_sale_items is the inner one.
  v_raised := false;
  begin
    perform public.refund_sale_items(v_redeemed_sale_id,
      jsonb_build_array(jsonb_build_object('sale_item_id', v_item_id, 'quantity', 1)));
  exception when others then
    v_raised := true;
  end;
  if not v_raised then raise exception 'FAIL: the same unit was refunded twice'; end if;

  select count(*) into v_count from public.customer_points_ledger
    where sale_id = v_redeemed_sale_id and reason = 'redeem_reversed';
  if v_count <> 1 then raise exception 'FAIL: redeemed points were returned twice'; end if;
  raise notice 'OK: 40 redeemed points returned once, and only once';

  select points_balance into v_balance from public.customers where id = v_customer_id;
  select coalesce(sum(delta_points), 0) into v_ledger_sum
    from public.customer_points_ledger where customer_id = v_customer_id;
  if v_balance <> v_ledger_sum then
    raise exception 'FAIL: counter % <> ledger % after refunds', v_balance, v_ledger_sum;
  end if;

  ------------------------------------------------------------------
  raise notice '=== 9. Editing a sale keeps the redemption and re-earns at the frozen rate ===';
  ------------------------------------------------------------------
  -- Without subtracting points_redeemed_cents in edit_sale, the recomputed
  -- total jumps by the redeemed amount and the payments check rejects an edit
  -- that changed nothing about the money.
  select points_balance into v_balance from public.customers where id = v_customer_id;

  select public.complete_sale(
    v_shop_id, v_items,
    -- 1999 - 10c = 1989
    jsonb_build_array(jsonb_build_object('method', 'cash', 'amount_cents', 1989, 'tendered_cents', 2000)),
    null, null, null, null, 0, v_customer_id, null, v_location_id, 10
  ) into v_sale_id;

  select points_earned into v_earned from public.sales where id = v_sale_id;
  if v_earned <> 20 then raise exception 'FAIL: the edit fixture earned %, expected 20', v_earned; end if;

  -- The shop changes its programme between the sale and the correction. The
  -- edit must NOT re-earn at the new rate: an earn rate is a promise made at
  -- the till, unlike a tax rate, which edit_sale deliberately re-reads.
  update public.shops set loyalty_points_per_usd = 5 where id = v_shop_id;

  perform public.edit_sale(
    v_sale_id,
    jsonb_build_array(jsonb_build_object('product_id', v_product_id, 'quantity', 2, 'discount_cents', 0)),
    -- 3998 - 10c = 3988
    jsonb_build_array(jsonb_build_object('method', 'cash', 'amount_cents', 3988, 'tendered_cents', 4000)),
    null, null, null, 0, v_customer_id
  );

  select total_cents, points_earned, points_redeemed, points_redeemed_cents
    into v_total, v_earned, v_redeemed, v_redeemed_cents
    from public.sales where id = v_sale_id;
  if v_total <> 3988 then raise exception 'FAIL: edited total % <> 3988 -- the redemption was dropped', v_total; end if;
  if v_redeemed <> 10 or v_redeemed_cents <> 10 then
    raise exception 'FAIL: the edit lost the redemption (% points, %c)', v_redeemed, v_redeemed_cents;
  end if;
  -- round(39.88) at the ORIGINAL rate of 1, not the new rate of 5.
  if v_earned <> 40 then raise exception 'FAIL: edited sale earned %, expected 40 at the frozen rate', v_earned; end if;
  raise notice 'OK: the edit kept the 10c redemption and re-earned 40 at the frozen rate';

  select points_balance into v_ledger_sum from public.customers where id = v_customer_id;
  -- -10 redeemed, +20 earned, then +20 adjustment for the edit.
  if v_ledger_sum <> v_balance + 30 then
    raise exception 'FAIL: balance moved by %, expected 30', v_ledger_sum - v_balance;
  end if;

  select coalesce(sum(delta_points), 0) into v_count
    from public.customer_points_ledger where sale_id = v_sale_id and reason = 'adjustment';
  if v_count <> 20 then raise exception 'FAIL: edit posted an adjustment of %, expected +20', v_count; end if;

  update public.shops set loyalty_points_per_usd = 1 where id = v_shop_id;

  select points_balance into v_balance from public.customers where id = v_customer_id;
  select coalesce(sum(delta_points), 0) into v_ledger_sum
    from public.customer_points_ledger where customer_id = v_customer_id;
  if v_balance <> v_ledger_sum then
    raise exception 'FAIL: counter % <> ledger % after an edit', v_balance, v_ledger_sum;
  end if;

  ------------------------------------------------------------------
  raise notice '=== 10. Deleting a sale returns the balance to where it was ===';
  ------------------------------------------------------------------
  -- The ledger keeps sale_id `on delete set null`, so without the reversing
  -- rows delete_sale posts, a deleted sale's points would count forever.
  select points_balance into v_balance from public.customers where id = v_customer_id;

  select public.complete_sale(
    v_shop_id, v_items,
    jsonb_build_array(jsonb_build_object('method', 'cash', 'amount_cents', 1999, 'tendered_cents', 2000)),
    null, null, null, null, 0, v_customer_id, null, v_location_id, 0
  ) into v_doomed_sale_id;

  select points_balance into v_ledger_sum from public.customers where id = v_customer_id;
  if v_ledger_sum <> v_balance + 20 then
    raise exception 'FAIL: the doomed sale earned % rather than 20', v_ledger_sum - v_balance;
  end if;

  perform public.delete_sale(v_doomed_sale_id);

  select points_balance into v_ledger_sum from public.customers where id = v_customer_id;
  if v_ledger_sum <> v_balance then
    raise exception 'FAIL: balance % after deleting the sale, expected %', v_ledger_sum, v_balance;
  end if;
  raise notice 'OK: deleting the sale returned the balance to %', v_balance;

  select points_balance into v_balance from public.customers where id = v_customer_id;
  select coalesce(sum(delta_points), 0) into v_ledger_sum
    from public.customer_points_ledger where customer_id = v_customer_id;
  if v_balance <> v_ledger_sum then
    raise exception 'FAIL: counter % <> ledger % after a delete', v_balance, v_ledger_sum;
  end if;

  ------------------------------------------------------------------
  raise notice '=== 11. Earned points cannot be spent until they have matured ===';
  ------------------------------------------------------------------
  -- Without this window the loop is: buy, earn, spend the new points on a
  -- second basket, return the first. The clamp in check 12 means the shop can
  -- no longer claw those points back, so the two rules only work together.
  update public.shops set loyalty_points_available_after_days = 1 where id = v_shop_id;

  -- Everything on this balance was earned moments ago by this script, so all of
  -- it is inside the window.
  select points_balance into v_balance from public.customers where id = v_customer_id;
  if public.customer_points_available(v_customer_id) <> 0 then
    raise exception 'FAIL: % freshly earned points are already spendable', v_balance;
  end if;

  v_raised := false;
  begin
    perform public.complete_sale(
      v_shop_id, v_items,
      jsonb_build_array(jsonb_build_object('method', 'cash', 'amount_cents', 1998, 'tendered_cents', 2000)),
      null, null, null, null, 0, v_customer_id, null, v_location_id, 1
    );
  exception when others then
    v_raised := true; v_detail := sqlerrm;
  end;
  if not v_raised then raise exception 'FAIL: a point that had not matured was spent'; end if;
  raise notice 'OK: refused (%)', v_detail;

  -- Age the earn rows past the window. The ledger has no update policy at all,
  -- so this is postgres work.
  perform set_config('role', 'postgres', true);
  update public.customer_points_ledger
     set created_at = created_at - interval '2 days'
   where customer_id = v_customer_id and reason = 'earn';
  perform set_config('role', 'authenticated', true);

  if public.customer_points_available(v_customer_id) <> v_balance then
    raise exception 'FAIL: matured points still unavailable (% of %)',
      public.customer_points_available(v_customer_id), v_balance;
  end if;
  raise notice 'OK: once matured, all % points became spendable', v_balance;

  update public.shops set loyalty_points_available_after_days = 0 where id = v_shop_id;

  ------------------------------------------------------------------
  raise notice '=== 12. A clawback never drives the balance negative ===';
  ------------------------------------------------------------------
  -- Earn on one sale, spend it all on another, then send the first one back.
  -- The shop absorbs what it cannot recover rather than posting the customer a
  -- debt for a refund it agreed to give.
  select public.complete_sale(
    v_shop_id, v_items,
    jsonb_build_array(jsonb_build_object('method', 'cash', 'amount_cents', 1999, 'tendered_cents', 2000)),
    null, null, null, null, 0, v_customer_id, null, v_location_id, 0
  ) into v_sale_c_id;

  select points_balance into v_balance from public.customers where id = v_customer_id;
  perform set_config('role', 'postgres', true);
  update public.customer_points_ledger set created_at = created_at - interval '2 days'
   where customer_id = v_customer_id and reason = 'earn';
  perform set_config('role', 'authenticated', true);

  -- Spend the lot, leaving less on hand than sale C is about to want back.
  select public.complete_sale(
    v_shop_id, v_items,
    jsonb_build_array(jsonb_build_object('method', 'cash', 'amount_cents', 1999 - v_balance, 'tendered_cents', 2000)),
    null, null, null, null, 0, v_customer_id, null, v_location_id, v_balance
  ) into v_sale_id;

  select id into v_item_id from public.sale_items where sale_id = v_sale_c_id;
  perform public.refund_sale_items(v_sale_c_id,
    jsonb_build_array(jsonb_build_object('sale_item_id', v_item_id, 'quantity', 1)));

  select points_balance into v_balance from public.customers where id = v_customer_id;
  if v_balance < 0 then
    raise exception 'FAIL: the clawback drove the balance to %', v_balance;
  end if;
  raise notice 'OK: clawback clamped, balance sits at % rather than going negative', v_balance;

  select coalesce(sum(delta_points), 0) into v_ledger_sum
    from public.customer_points_ledger where customer_id = v_customer_id;
  if v_balance <> v_ledger_sum then
    raise exception 'FAIL: counter % <> ledger % after a clamped clawback', v_balance, v_ledger_sum;
  end if;

  ------------------------------------------------------------------
  raise notice '=== 13. A refund gives points back BEFORE it takes them away ===';
  ------------------------------------------------------------------
  -- The ordering check. Reversing these two lets the clawback hit an emptied
  -- balance, get clamped to nothing, and then the reversal lands on top --
  -- handing the customer points the shop meant to reclaim.
  perform set_config('role', 'postgres', true);
  select points_balance into v_balance from public.customers where id = v_customer_id;
  insert into public.customer_points_ledger (shop_id, customer_id, delta_points, reason, note)
    values (v_shop_id, v_customer_id, 100 - v_balance, 'adjustment', 'test: set balance to 100');
  update public.customer_points_ledger set created_at = created_at - interval '2 days'
   where customer_id = v_customer_id;
  perform set_config('role', 'authenticated', true);

  -- Redeem all 100; the sale earns round(18.99) = 19 back.
  select public.complete_sale(
    v_shop_id, v_items,
    jsonb_build_array(jsonb_build_object('method', 'cash', 'amount_cents', 1899, 'tendered_cents', 2000)),
    null, null, null, null, 0, v_customer_id, null, v_location_id, 100
  ) into v_redeemed_sale_id;

  select points_earned into v_earned from public.sales where id = v_redeemed_sale_id;

  -- Drain to nothing, so the refund below lands on an empty balance.
  select points_balance into v_balance from public.customers where id = v_customer_id;
  perform set_config('role', 'postgres', true);
  insert into public.customer_points_ledger (shop_id, customer_id, delta_points, reason, note)
    values (v_shop_id, v_customer_id, -v_balance, 'adjustment', 'test: drain to zero');
  perform set_config('role', 'authenticated', true);

  select points_balance into v_balance from public.customers where id = v_customer_id;
  if v_balance <> 0 then raise exception 'FAIL: could not drain the balance (at %)', v_balance; end if;

  select id into v_item_id from public.sale_items where sale_id = v_redeemed_sale_id;
  perform public.refund_sale_items(v_redeemed_sale_id,
    jsonb_build_array(jsonb_build_object('sale_item_id', v_item_id, 'quantity', 1)));

  -- Right order: +100 returned, then -19 clawed back = 81.
  -- Wrong order: clawback clamped to 0 against an empty balance, then +100 = 100.
  select points_balance into v_balance from public.customers where id = v_customer_id;
  if v_balance <> 100 - v_earned then
    raise exception 'FAIL: balance % after the refund, expected % -- the reversal and the clawback are the wrong way round',
      v_balance, 100 - v_earned;
  end if;
  raise notice 'OK: 100 returned then % clawed back, leaving %', v_earned, v_balance;

  ------------------------------------------------------------------
  raise notice '=== 14. A lapsed plan stops earning, and does NOT stop selling ===';
  ------------------------------------------------------------------
  -- The regression this exists to catch: public.customers carries
  -- enforce_shop_module('customers') as a BEFORE UPDATE trigger, and security
  -- definer does not bypass a trigger. Without the shop_has_module() gate
  -- inside complete_sale, the balance update would raise module_not_included
  -- and a shop that stopped paying could no longer ring up a sale at all.
  -- Billing tables have no write policy for anyone (every mutation goes through
  -- the audited platform-admin edge function), so lapsing the plan has to be
  -- done as postgres -- the same thing verify-entitlements.sql does.
  select id into v_free_id from public.plans where key = 'free';
  perform set_config('role', 'postgres', true);
  update public.shop_subscriptions
    set plan_id = v_free_id,
        trial_ends_at = now() - interval '100 days',
        grace_until = now() - interval '93 days',
        current_period_end = null
    where shop_id = v_shop_id;
  perform set_config('role', 'authenticated', true);

  if public.shop_has_module(v_shop_id, 'customers') then
    raise exception 'FAIL: the free plan still grants the customers module -- this check proves nothing';
  end if;

  select points_balance into v_balance from public.customers where id = v_customer_id;

  select public.complete_sale(
    v_shop_id, v_items,
    jsonb_build_array(jsonb_build_object('method', 'cash', 'amount_cents', 1999, 'tendered_cents', 2000)),
    null, null, null, null, 0, v_customer_id, null, v_location_id, 0
  ) into v_sale_id;

  select points_earned into v_earned from public.sales where id = v_sale_id;
  if v_earned <> 0 then raise exception 'FAIL: a lapsed shop earned % points', v_earned; end if;

  select points_balance into v_ledger_sum from public.customers where id = v_customer_id;
  if v_ledger_sum <> v_balance then
    raise exception 'FAIL: a lapsed shop moved the balance from % to %', v_balance, v_ledger_sum;
  end if;
  raise notice 'OK: a lapsed shop still completed the sale, earning nothing';

  -- And redeeming is refused outright rather than silently ignored.
  v_raised := false;
  begin
    perform public.complete_sale(
      v_shop_id, v_items,
      jsonb_build_array(jsonb_build_object('method', 'cash', 'amount_cents', 1989, 'tendered_cents', 2000)),
      null, null, null, null, 0, v_customer_id, null, v_location_id, 10
    );
  exception when others then
    v_raised := true; v_detail := sqlerrm;
  end;
  if not v_raised then raise exception 'FAIL: a lapsed shop accepted a redemption'; end if;
  raise notice 'OK: redemption refused on a lapsed plan (%)', v_detail;

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
