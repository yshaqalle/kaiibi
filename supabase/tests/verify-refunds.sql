-- What a refund actually hands back.
--
-- One question, asked against every combination of pricing a sale can carry:
-- does refunding the whole thing return exactly what the customer paid? Before
-- 20260820000200 the answer was no for any sale with an order discount, a
-- points redemption, or tax -- refunds apportioned line_total_cents, which
-- knows about none of them.
--
-- Everything runs inside one DO block whose EXCEPTION clause rolls it all back.

\set ON_ERROR_STOP on

do $$
declare
  v_user_id uuid := gen_random_uuid();
  v_shop_id uuid;
  v_location_id uuid;
  v_product_id uuid;
  v_customer_id uuid;
  v_sale_id uuid;
  v_item_id uuid;
  v_paid integer;
  v_refunded integer;
  v_children integer;
  v_items jsonb;
  v_items3 jsonb;
begin
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
    values (v_user_id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            'verify-refunds-' || v_user_id || '@example.test', '', now(), now(), now());
  insert into public.shops (owner_id, name) values (v_user_id, 'Refund Verify Shop') returning id into v_shop_id;

  perform set_config('request.jwt.claims', json_build_object('sub', v_user_id)::text, true);
  perform set_config('role', 'authenticated', true);

  insert into public.shop_locations (shop_id, name, is_primary)
    values (v_shop_id, 'Main', true) returning id into v_location_id;
  insert into public.products (shop_id, name, price_cents, cost_cents)
    values (v_shop_id, 'Verify Soap', 1999, 800) returning id into v_product_id;
  insert into public.product_location_stock (product_id, location_id, stock)
    values (v_product_id, v_location_id, 10000);
  insert into public.customers (shop_id, first_name) values (v_shop_id, 'Refund Rita')
    returning id into v_customer_id;

  v_items  := jsonb_build_array(jsonb_build_object('product_id', v_product_id, 'quantity', 1, 'discount_cents', 0));
  v_items3 := jsonb_build_array(jsonb_build_object('product_id', v_product_id, 'quantity', 3, 'discount_cents', 0));

  ------------------------------------------------------------------
  raise notice '=== 1. A plain sale: refund equals the price ===';
  ------------------------------------------------------------------
  select public.complete_sale(
    v_shop_id, v_items,
    jsonb_build_array(jsonb_build_object('method', 'cash', 'amount_cents', 1999, 'tendered_cents', 2000)),
    null, null, null, null, 0, null, null, v_location_id, 0
  ) into v_sale_id;
  select total_cents into v_paid from public.sales where id = v_sale_id;
  select id into v_item_id from public.sale_items where sale_id = v_sale_id;
  perform public.refund_sale_items(v_sale_id, jsonb_build_array(jsonb_build_object('sale_item_id', v_item_id, 'quantity', 1)));
  select coalesce(sum(total_cents), 0) into v_refunded from public.refunds where sale_id = v_sale_id;
  if v_refunded <> v_paid then raise exception 'FAIL: paid %, refunded %', v_paid, v_refunded; end if;
  raise notice 'OK: paid %, refunded %', v_paid, v_refunded;

  ------------------------------------------------------------------
  raise notice '=== 2. An ORDER DISCOUNT is not refunded back to the customer ===';
  ------------------------------------------------------------------
  -- The headline regression. line_total_cents is 1999; the customer paid 1799.
  select public.complete_sale(
    v_shop_id, v_items,
    jsonb_build_array(jsonb_build_object('method', 'cash', 'amount_cents', 1799, 'tendered_cents', 1800)),
    null, null, null, null, 200, null, null, v_location_id, 0
  ) into v_sale_id;
  select total_cents into v_paid from public.sales where id = v_sale_id;
  if v_paid <> 1799 then raise exception 'FAIL: fixture paid %, expected 1799', v_paid; end if;
  select id into v_item_id from public.sale_items where sale_id = v_sale_id;
  perform public.refund_sale_items(v_sale_id, jsonb_build_array(jsonb_build_object('sale_item_id', v_item_id, 'quantity', 1)));
  select coalesce(sum(total_cents), 0) into v_refunded from public.refunds where sale_id = v_sale_id;
  if v_refunded <> 1799 then
    raise exception 'FAIL: refunded % on a discounted sale, expected 1799 (the shop paid the discount twice)', v_refunded;
  end if;
  raise notice 'OK: 1999 of goods, 200 off, refunded % rather than 1999', v_refunded;

  ------------------------------------------------------------------
  raise notice '=== 3. TAX comes back too ===';
  ------------------------------------------------------------------
  update public.shops set tax_enabled = true, tax_rate_percent = 5 where id = v_shop_id;
  select public.complete_sale(
    v_shop_id, v_items,
    jsonb_build_array(jsonb_build_object('method', 'cash', 'amount_cents', 2099, 'tendered_cents', 2100)),
    null, null, null, null, 0, null, null, v_location_id, 0
  ) into v_sale_id;
  select total_cents into v_paid from public.sales where id = v_sale_id;
  select id into v_item_id from public.sale_items where sale_id = v_sale_id;
  perform public.refund_sale_items(v_sale_id, jsonb_build_array(jsonb_build_object('sale_item_id', v_item_id, 'quantity', 1)));
  select coalesce(sum(total_cents), 0) into v_refunded from public.refunds where sale_id = v_sale_id;
  if v_refunded <> v_paid then
    raise exception 'FAIL: paid % including tax, refunded % -- the customer is short the tax', v_paid, v_refunded;
  end if;
  raise notice 'OK: paid % including 100 of tax, refunded %', v_paid, v_refunded;
  update public.shops set tax_enabled = false where id = v_shop_id;

  ------------------------------------------------------------------
  raise notice '=== 4. POINTS redeemed are not refunded as cash ===';
  ------------------------------------------------------------------
  update public.shops
    set loyalty_enabled = true, loyalty_points_per_usd = 1, loyalty_cents_per_point = 1,
        loyalty_points_available_after_days = 0
    where id = v_shop_id;
  perform set_config('role', 'postgres', true);
  insert into public.customer_points_ledger (shop_id, customer_id, delta_points, reason, note)
    values (v_shop_id, v_customer_id, 50, 'adjustment', 'test: seed');
  perform set_config('role', 'authenticated', true);

  select public.complete_sale(
    v_shop_id, v_items,
    jsonb_build_array(jsonb_build_object('method', 'cash', 'amount_cents', 1949, 'tendered_cents', 2000)),
    null, null, null, null, 0, v_customer_id, null, v_location_id, 50
  ) into v_sale_id;
  select total_cents into v_paid from public.sales where id = v_sale_id;
  if v_paid <> 1949 then raise exception 'FAIL: fixture paid %, expected 1949', v_paid; end if;
  select id into v_item_id from public.sale_items where sale_id = v_sale_id;
  perform public.refund_sale_items(v_sale_id, jsonb_build_array(jsonb_build_object('sale_item_id', v_item_id, 'quantity', 1)));
  select coalesce(sum(total_cents), 0) into v_refunded from public.refunds where sale_id = v_sale_id;
  if v_refunded <> 1949 then
    raise exception 'FAIL: refunded % on a sale part-paid in points, expected 1949', v_refunded;
  end if;
  raise notice 'OK: 50 points off, refunded % in cash rather than 1999', v_refunded;
  update public.shops set loyalty_enabled = false where id = v_shop_id;

  ------------------------------------------------------------------
  raise notice '=== 5. EVERYTHING AT ONCE, refunded one unit at a time ===';
  ------------------------------------------------------------------
  -- Three units, an order discount and tax, sent back in three separate
  -- refunds. The pieces must sum to exactly what was paid -- this is the check
  -- that catches rounding drift in the scaling.
  update public.shops set tax_enabled = true, tax_rate_percent = 5 where id = v_shop_id;
  -- 3 x 1999 = 5997, less 300 = 5697, tax round(284.85) = 285, total 5982
  select public.complete_sale(
    v_shop_id, v_items3,
    jsonb_build_array(jsonb_build_object('method', 'cash', 'amount_cents', 5982, 'tendered_cents', 6000)),
    null, null, null, null, 300, null, null, v_location_id, 0
  ) into v_sale_id;
  select total_cents into v_paid from public.sales where id = v_sale_id;
  select id into v_item_id from public.sale_items where sale_id = v_sale_id;

  perform public.refund_sale_items(v_sale_id, jsonb_build_array(jsonb_build_object('sale_item_id', v_item_id, 'quantity', 1)));
  perform public.refund_sale_items(v_sale_id, jsonb_build_array(jsonb_build_object('sale_item_id', v_item_id, 'quantity', 1)));
  perform public.refund_sale_items(v_sale_id, jsonb_build_array(jsonb_build_object('sale_item_id', v_item_id, 'quantity', 1)));

  select coalesce(sum(total_cents), 0) into v_refunded from public.refunds where sale_id = v_sale_id;
  if v_refunded <> v_paid then
    raise exception 'FAIL: paid %, three partial refunds returned % -- rounding drift', v_paid, v_refunded;
  end if;
  raise notice 'OK: paid %, returned in three pieces summing to %', v_paid, v_refunded;

  ------------------------------------------------------------------
  raise notice '=== 6. refund_items still sum to their refund ===';
  ------------------------------------------------------------------
  -- The scaling rewrites the child rows; if the allocation drops or invents a
  -- cent, reconciliation between the two tables breaks silently.
  select coalesce(sum(ri.amount_cents), 0) into v_children
    from public.refund_items ri join public.refunds r on r.id = ri.refund_id
   where r.sale_id = v_sale_id;
  if v_children <> v_refunded then
    raise exception 'FAIL: refund_items sum to % but their refunds sum to %', v_children, v_refunded;
  end if;
  raise notice 'OK: child rows sum to %, matching their parents', v_children;

  ------------------------------------------------------------------
  raise notice '=== 7. A refund never exceeds what is left to refund ===';
  ------------------------------------------------------------------
  begin
    perform public.refund_sale_items(v_sale_id, jsonb_build_array(jsonb_build_object('sale_item_id', v_item_id, 'quantity', 1)));
    raise exception 'FAIL: a fourth unit was refunded from a three-unit sale';
  exception when others then
    if sqlerrm like 'FAIL:%' then raise; end if;
    raise notice 'OK: refused (%)', sqlerrm;
  end;

  raise notice '';
  raise notice '################  ALL CHECKS PASSED  ################';

  raise exception 'VERIFY_ROLLBACK';
exception
  when others then
    if sqlerrm = 'VERIFY_ROLLBACK' then
      raise notice 'Rolled back — no rows left behind.';
    else
      raise;
    end if;
end $$;
