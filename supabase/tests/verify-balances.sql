-- What a customer still owes, and who is allowed to see it.
--
-- customer_balances computes one number across three tables (sales, payments,
-- refunds), which makes it wrong in two directions that both look fine:
--   * join both children directly and they multiply, so a sale with two
--     payments counts its one refund twice;
--   * read it as a role that can see sales but not payments and RLS silently
--     returns `owed = total` on a sale that was paid off months ago.
-- Neither raises. Both send someone to ask a customer for money they already
-- handed over, so both are asserted here on exact cents.
--
-- Everything runs inside one DO block whose EXCEPTION clause rolls it all back.

\set ON_ERROR_STOP on

do $$
declare
  v_owner_id    uuid := gen_random_uuid();
  v_staff_id    uuid := gen_random_uuid();
  v_outsider_id uuid := gen_random_uuid();
  v_shop_id     uuid;
  v_location_id uuid;
  v_product_id  uuid;
  v_customer_id uuid;
  v_role_id     uuid;
  v_sale_id     uuid;
  v_payment_id  uuid;
  v_item_id     uuid;
  v_owed        integer;
  v_paid        integer;
  v_refunded    integer;
  v_rows        integer;
  v_items2 jsonb;
  v_items3 jsonb;
  v_items4 jsonb;
begin
  ------------------------------------------------------------------
  -- Fixture
  ------------------------------------------------------------------
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
    select u, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
           'verify-balances-' || u || '@example.test', '', now(), now(), now()
      from unnest(array[v_owner_id, v_staff_id, v_outsider_id]) u;

  insert into public.shops (owner_id, name) values (v_owner_id, 'Balance Verify Shop')
    returning id into v_shop_id;

  perform set_config('request.jwt.claims', json_build_object('sub', v_owner_id)::text, true);
  perform set_config('role', 'authenticated', true);

  insert into public.shop_locations (shop_id, name, is_primary)
    values (v_shop_id, 'Main', true) returning id into v_location_id;
  insert into public.products (shop_id, name, price_cents, cost_cents)
    values (v_shop_id, 'Verify Sugar', 1000, 400) returning id into v_product_id;
  insert into public.product_location_stock (product_id, location_id, stock)
    values (v_product_id, v_location_id, 10000);
  insert into public.customers (shop_id, first_name, last_name)
    values (v_shop_id, 'Bilan', 'Warsame') returning id into v_customer_id;

  -- A member holding customers.view and NOTHING else. 20260802030100 calls this
  -- "a realistic shape" and widened sales/sale_items to it; check 6 is the whole
  -- reason 20260831000000 had to widen sale_payments and refunds to match.
  -- The owner cannot stand in: has_any_shop_permission() answers true for an
  -- owner before it reads a role at all.
  select id into v_role_id from public.roles where shop_id = v_shop_id and name = 'Cashier';
  update public.roles set permissions = array['customers.view'] where id = v_role_id;
  insert into public.shop_members (shop_id, user_id, role_id, full_name, active)
    values (v_shop_id, v_staff_id, v_role_id, 'Khadra Yusuf', true);

  v_items2 := jsonb_build_array(jsonb_build_object('product_id', v_product_id, 'quantity', 2, 'discount_cents', 0));
  v_items3 := jsonb_build_array(jsonb_build_object('product_id', v_product_id, 'quantity', 3, 'discount_cents', 0));
  v_items4 := jsonb_build_array(jsonb_build_object('product_id', v_product_id, 'quantity', 4, 'discount_cents', 0));

  ------------------------------------------------------------------
  raise notice '=== 1. A sale paid in full is not a balance ===';
  ------------------------------------------------------------------
  select public.complete_sale(
    v_shop_id, v_items2,
    jsonb_build_array(jsonb_build_object('method', 'cash', 'amount_cents', 2000, 'tendered_cents', 2000)),
    'Bilan Warsame', null, null, null, 0, v_customer_id, null, v_location_id, 0
  ) into v_sale_id;

  select count(*) into v_rows from public.customer_balances where sale_id = v_sale_id;
  if v_rows <> 0 then
    raise exception 'FAIL: a fully paid sale appeared as a balance';
  end if;
  raise notice 'OK: 2000 of 2000 taken, nothing outstanding';

  ------------------------------------------------------------------
  raise notice '=== 2. A part-paid sale owes exactly the shortfall ===';
  ------------------------------------------------------------------
  -- complete_sale still refuses a shortfall at this migration, so the only way
  -- to build one is to take a payment back off a completed sale. That is also
  -- the shape the next migration will create, so the view is being asked the
  -- same question either way.
  select public.complete_sale(
    v_shop_id, v_items3,
    jsonb_build_array(
      jsonb_build_object('method', 'cash', 'amount_cents', 1000, 'tendered_cents', 1000),
      jsonb_build_object('method', 'zaad', 'amount_cents', 2000)
    ),
    'Bilan Warsame', null, null, null, 0, v_customer_id, null, v_location_id, 0
  ) into v_sale_id;

  select id into v_payment_id from public.sale_payments
    where sale_id = v_sale_id and amount_cents = 2000;
  delete from public.sale_payments where id = v_payment_id;

  select owed_cents, paid_cents, refunded_cents into v_owed, v_paid, v_refunded
    from public.customer_balances where sale_id = v_sale_id;
  if v_owed is null then raise exception 'FAIL: a part-paid sale is not showing as a balance'; end if;
  if v_owed <> 2000 or v_paid <> 1000 or v_refunded <> 0 then
    raise exception 'FAIL: expected owed 2000 / paid 1000 / refunded 0, got % / % / %', v_owed, v_paid, v_refunded;
  end if;
  raise notice 'OK: 3000 rung up, 1000 taken, 2000 owed';

  ------------------------------------------------------------------
  raise notice '=== 3. Goods that come back are not a debt ===';
  ------------------------------------------------------------------
  select id into v_item_id from public.sale_items where sale_id = v_sale_id;
  perform public.refund_sale_items(v_sale_id,
    jsonb_build_array(jsonb_build_object('sale_item_id', v_item_id, 'quantity', 1)));

  select owed_cents, refunded_cents into v_owed, v_refunded
    from public.customer_balances where sale_id = v_sale_id;
  if v_owed <> 1000 or v_refunded <> 1000 then
    raise exception 'FAIL: after returning one unit expected owed 1000 / refunded 1000, got % / %', v_owed, v_refunded;
  end if;
  raise notice 'OK: one unit back, the debt fell 2000 -> 1000';

  -- Returning the rest cancels what is left. The customer owes nothing, and
  -- was never handed cash back, because none of this was ever paid.
  perform public.refund_sale_items(v_sale_id,
    jsonb_build_array(jsonb_build_object('sale_item_id', v_item_id, 'quantity', 2)));

  select count(*) into v_rows from public.customer_balances where sale_id = v_sale_id;
  if v_rows <> 0 then
    raise exception 'FAIL: a fully returned sale is still being chased';
  end if;
  raise notice 'OK: everything back, the balance is gone';

  ------------------------------------------------------------------
  raise notice '=== 4. Two payments and one refund do not multiply ===';
  ------------------------------------------------------------------
  -- The regression that a lateral subquery exists to prevent. Joined directly,
  -- two payment rows against one refund row give a two-row cross product and
  -- the refund is summed twice: refunded reads 2000, owed reads 500 less than
  -- it should. Every fixture with one payment and one refund passes anyway,
  -- which is why this one has two.
  select public.complete_sale(
    v_shop_id, v_items4,
    jsonb_build_array(
      jsonb_build_object('method', 'cash', 'amount_cents', 1000, 'tendered_cents', 1000),
      jsonb_build_object('method', 'zaad', 'amount_cents', 1500),
      jsonb_build_object('method', 'edahab', 'amount_cents', 1500)
    ),
    'Bilan Warsame', null, null, null, 0, v_customer_id, null, v_location_id, 0
  ) into v_sale_id;

  select id into v_payment_id from public.sale_payments
    where sale_id = v_sale_id and method = 'edahab';
  delete from public.sale_payments where id = v_payment_id;

  select id into v_item_id from public.sale_items where sale_id = v_sale_id;
  perform public.refund_sale_items(v_sale_id,
    jsonb_build_array(jsonb_build_object('sale_item_id', v_item_id, 'quantity', 1)));

  select owed_cents, paid_cents, refunded_cents into v_owed, v_paid, v_refunded
    from public.customer_balances where sale_id = v_sale_id;
  if v_paid <> 2500 or v_refunded <> 1000 or v_owed <> 500 then
    raise exception 'FAIL: expected paid 2500 / refunded 1000 / owed 500, got % / % / %', v_paid, v_refunded, v_owed;
  end if;
  raise notice 'OK: 4000 less 1000 returned less 2500 taken = 500, each counted once';

  ------------------------------------------------------------------
  raise notice '=== 5. No name, no debt ===';
  ------------------------------------------------------------------
  declare v_anon_sale uuid;
  begin
    select public.complete_sale(
      v_shop_id, v_items2,
      jsonb_build_array(jsonb_build_object('method', 'cash', 'amount_cents', 2000, 'tendered_cents', 2000)),
      null, null, null, null, 0, null, null, v_location_id, 0
    ) into v_anon_sale;

    delete from public.sale_payments where sale_id = v_anon_sale;

    select count(*) into v_rows from public.customer_balances where sale_id = v_anon_sale;
    if v_rows <> 0 then
      raise exception 'FAIL: an unpaid sale with nobody attached is showing as a receivable';
    end if;
  end;
  raise notice 'OK: an unpaid walk-in is a loss to write off, not a debt to collect';

  ------------------------------------------------------------------
  raise notice '=== 6. customers.view alone reads the TRUE figure ===';
  ------------------------------------------------------------------
  -- The check this migration exists for. Before it, this role could read the
  -- sale but neither its payments nor its refunds, so the view returned
  -- owed = 4000 on a sale owing 500 -- no error, just a number eight times too
  -- big, on the exact screen someone uses to ring a customer up.
  perform set_config('request.jwt.claims', json_build_object('sub', v_staff_id)::text, true);

  select owed_cents, paid_cents, refunded_cents into v_owed, v_paid, v_refunded
    from public.customer_balances where sale_id = v_sale_id;
  if v_owed is null then
    raise exception 'FAIL: customers.view reads no balances at all';
  end if;
  if v_owed <> 500 or v_paid <> 2500 or v_refunded <> 1000 then
    raise exception 'FAIL: customers.view reads owed % / paid % / refunded % where the owner reads 500 / 2500 / 1000',
      v_owed, v_paid, v_refunded;
  end if;
  raise notice 'OK: staff and owner read the same 500';

  ------------------------------------------------------------------
  raise notice '=== 7. Another shop reads nothing ===';
  ------------------------------------------------------------------
  perform set_config('request.jwt.claims', json_build_object('sub', v_outsider_id)::text, true);

  select count(*) into v_rows from public.customer_balances where shop_id = v_shop_id;
  if v_rows <> 0 then
    raise exception 'FAIL: an outsider read % balance rows', v_rows;
  end if;
  raise notice 'OK: nothing';

  perform set_config('request.jwt.claims', json_build_object('sub', v_owner_id)::text, true);

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
