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
  v_owner_member uuid;
  v_register    uuid;
  v_session     uuid;
  v_left        integer;
  v_settle_sale uuid;
  v_settled     timestamptz;
  v_raised      boolean;
  v_detail      text;
  v_points      integer;
  v_bal         integer;
  v_ledger      integer;
  v_loyal_sale  uuid;
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
  -- Built the way the till builds it: asked for, against a name. Deleting a
  -- payment row behind the RPC's back would leave settled_at stamped and the
  -- sale hidden from the view -- which is correct behaviour, and not a shape
  -- the app can produce.
  select public.complete_sale(
    v_shop_id, v_items3,
    jsonb_build_array(jsonb_build_object('method', 'cash', 'amount_cents', 1000, 'tendered_cents', 1000)),
    'Bilan Warsame', null, null, null, 0, v_customer_id, null, v_location_id, 0, null, true
  ) into v_sale_id;

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
      jsonb_build_object('method', 'zaad', 'amount_cents', 1500)
    ),
    'Bilan Warsame', null, null, null, 0, v_customer_id, null, v_location_id, 0, null, true
  ) into v_sale_id;

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

    -- complete_sale refuses to create this (check 10), so the view's own
    -- customer_id predicate is reached directly. It is the last line of defence
    -- if a future caller ever writes an unpaid sale another way.
    delete from public.sale_payments where sale_id = v_anon_sale;
    update public.sales set settled_at = null where id = v_anon_sale;

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

  ------------------------------------------------------------------
  raise notice '=== 8. A shortfall nobody asked for is still refused ===';
  ------------------------------------------------------------------
  -- The guard is not being removed, only made conditional. This is the check
  -- that it still guards: the same call that worked before this migration must
  -- fail the same way after it.
  v_raised := false;
  begin
    perform public.complete_sale(
      v_shop_id, v_items2,
      jsonb_build_array(jsonb_build_object('method', 'cash', 'amount_cents', 1500)),
      'Bilan Warsame', null, null, null, 0, v_customer_id, null, v_location_id, 0, null, false
    );
  exception when others then v_raised := true; v_detail := sqlerrm;
  end;
  if not v_raised then raise exception 'FAIL: 1500 was accepted against a 2000 sale with no intent to'; end if;
  if v_detail not like 'payments total%does not match%' then
    raise exception 'FAIL: refused, but for the wrong reason: %', v_detail;
  end if;
  raise notice 'OK: refused (%)', v_detail;

  ------------------------------------------------------------------
  raise notice '=== 9. Over-payment is refused however it is asked for ===';
  ------------------------------------------------------------------
  -- A till that takes more than the bill has a bug. Change is tendered_cents,
  -- not a larger payment, and p_allow_balance must not become a way past this.
  v_raised := false;
  begin
    perform public.complete_sale(
      v_shop_id, v_items2,
      jsonb_build_array(jsonb_build_object('method', 'cash', 'amount_cents', 2500)),
      'Bilan Warsame', null, null, null, 0, v_customer_id, null, v_location_id, 0, null, true
    );
  exception when others then v_raised := true; v_detail := sqlerrm;
  end;
  if not v_raised then raise exception 'FAIL: 2500 was banked against a 2000 sale'; end if;
  if v_detail not like '%is more than sale total%' then
    raise exception 'FAIL: refused, but for the wrong reason: %', v_detail;
  end if;
  raise notice 'OK: refused (%)', v_detail;

  ------------------------------------------------------------------
  raise notice '=== 10. Credit needs a name, enforced by the server ===';
  ------------------------------------------------------------------
  -- An unpaid sale with nobody attached is a loss, not a debt. The UI can
  -- discourage it; only this can prevent it.
  v_raised := false;
  begin
    perform public.complete_sale(
      v_shop_id, v_items2,
      jsonb_build_array(jsonb_build_object('method', 'cash', 'amount_cents', 1500)),
      null, null, null, null, 0, null, null, v_location_id, 0, null, true
    );
  exception when others then v_raised := true; v_detail := sqlerrm;
  end;
  if not v_raised then raise exception 'FAIL: an anonymous walk-in was given credit'; end if;
  if v_detail not like '%only be left unpaid against a customer%' then
    raise exception 'FAIL: refused, but for the wrong reason: %', v_detail;
  end if;
  raise notice 'OK: refused (%)', v_detail;

  ------------------------------------------------------------------
  raise notice '=== 11. Asked for, against a name: the sale stands and owes ===';
  ------------------------------------------------------------------
  select public.complete_sale(
    v_shop_id, v_items3,
    jsonb_build_array(jsonb_build_object('method', 'cash', 'amount_cents', 1000, 'tendered_cents', 1000)),
    'Bilan Warsame', null, null, null, 0, v_customer_id, null, v_location_id, 0, null, true
  ) into v_settle_sale;

  select settled_at into v_settled from public.sales where id = v_settle_sale;
  if v_settled is not null then raise exception 'FAIL: a sale owing money was stamped settled'; end if;

  select owed_cents, paid_cents into v_owed, v_paid
    from public.customer_balances where sale_id = v_settle_sale;
  if v_owed <> 2000 or v_paid <> 1000 then
    raise exception 'FAIL: expected owed 2000 / paid 1000, got % / %', v_owed, v_paid;
  end if;
  raise notice 'OK: 3000 rung up, 1000 down, 2000 on the account';

  ------------------------------------------------------------------
  raise notice '=== 12. Paying in full stamps the sale settled ===';
  ------------------------------------------------------------------
  declare v_full_sale uuid;
  begin
    select public.complete_sale(
      v_shop_id, v_items2,
      jsonb_build_array(jsonb_build_object('method', 'cash', 'amount_cents', 2000, 'tendered_cents', 2000)),
      'Bilan Warsame', null, null, null, 0, v_customer_id, null, v_location_id, 0, null, true
    ) into v_full_sale;
    select settled_at into v_settled from public.sales where id = v_full_sale;
    if v_settled is null then
      raise exception 'FAIL: a sale paid in full was left unsettled, so it stays on the receivables list forever';
    end if;
  end;
  raise notice 'OK: asking for credit and not needing it settles anyway';

  ------------------------------------------------------------------
  raise notice '=== 13. Settling later, in two instalments ===';
  ------------------------------------------------------------------
  select public.settle_sale_balance(
    v_settle_sale,
    jsonb_build_array(jsonb_build_object('method', 'zaad', 'amount_cents', 800))
  ) into v_left;
  if v_left <> 1200 then raise exception 'FAIL: after taking 800 of 2000, expected 1200 left, got %', v_left; end if;

  select owed_cents into v_owed from public.customer_balances where sale_id = v_settle_sale;
  if v_owed <> 1200 then raise exception 'FAIL: the view says % owed, the RPC says 1200', v_owed; end if;

  select settled_at into v_settled from public.sales where id = v_settle_sale;
  if v_settled is not null then raise exception 'FAIL: a part-settled sale was stamped settled'; end if;
  raise notice 'OK: 800 taken, 1200 left, and the RPC and the view agree';

  select public.settle_sale_balance(
    v_settle_sale,
    jsonb_build_array(jsonb_build_object('method', 'cash', 'amount_cents', 1200, 'tendered_cents', 1200))
  ) into v_left;
  if v_left <> 0 then raise exception 'FAIL: expected nothing left, got %', v_left; end if;

  select settled_at into v_settled from public.sales where id = v_settle_sale;
  if v_settled is null then raise exception 'FAIL: the last payment did not settle the sale'; end if;

  select count(*) into v_rows from public.customer_balances where sale_id = v_settle_sale;
  if v_rows <> 0 then raise exception 'FAIL: a settled sale is still on the receivables list'; end if;
  raise notice 'OK: paid off, stamped, and off the list';

  ------------------------------------------------------------------
  raise notice '=== 14. A settlement cannot overshoot or repeat ===';
  ------------------------------------------------------------------
  v_raised := false;
  begin
    perform public.settle_sale_balance(v_settle_sale,
      jsonb_build_array(jsonb_build_object('method', 'cash', 'amount_cents', 100)));
  exception when others then v_raised := true; v_detail := sqlerrm;
  end;
  if not v_raised then raise exception 'FAIL: a settled sale took another payment'; end if;
  if v_detail not like '%already paid in full%' then
    raise exception 'FAIL: refused, but for the wrong reason: %', v_detail;
  end if;
  raise notice 'OK: paid twice is refused (%)', v_detail;

  ------------------------------------------------------------------
  raise notice '=== 15. Editing a sale does not erase a settlement ===';
  ------------------------------------------------------------------
  -- The one that would have gone unnoticed. edit_sale deletes a sale's payments
  -- and re-inserts whatever the client sent -- lossless while every payment was
  -- taken at the till in one go, and destructive the moment money can arrive
  -- days later. Wiping it would put the customer back in debt for cash they
  -- had already handed over, with no record that they ever paid.
  select public.complete_sale(
    v_shop_id, v_items3,
    jsonb_build_array(jsonb_build_object('method', 'cash', 'amount_cents', 1000, 'tendered_cents', 1000)),
    'Bilan Warsame', null, null, null, 0, v_customer_id, null, v_location_id, 0, null, true
  ) into v_settle_sale;

  perform public.settle_sale_balance(v_settle_sale,
    jsonb_build_array(jsonb_build_object('method', 'zaad', 'amount_cents', 800)));

  -- The client re-sends the till's payment and knows nothing of the settlement.
  perform public.edit_sale(
    v_settle_sale, v_items3,
    jsonb_build_array(jsonb_build_object('method', 'cash', 'amount_cents', 1000, 'tendered_cents', 1000)),
    'Bilan Warsame', null, null, 0, v_customer_id, true
  );

  select count(*) into v_rows from public.sale_payments
    where sale_id = v_settle_sale and is_settlement;
  if v_rows <> 1 then raise exception 'FAIL: the edit left % settlement rows, expected 1', v_rows; end if;

  select owed_cents, paid_cents into v_owed, v_paid
    from public.customer_balances where sale_id = v_settle_sale;
  if v_paid <> 1800 or v_owed <> 1200 then
    raise exception 'FAIL: after the edit expected paid 1800 / owed 1200, got % / % -- the settlement was eaten',
      v_paid, v_owed;
  end if;
  raise notice 'OK: the 800 survived the edit; still 1200 owed, not 2000';

  ------------------------------------------------------------------
  raise notice '=== 16. A settlement will not go into a closed drawer ===';
  ------------------------------------------------------------------
  -- Phase 1 shipped a whole recovery path for this on complete_sale. A
  -- settlement filed against a session someone has already counted and signed
  -- off is the same error arriving by a new road.
  select id into v_owner_member from public.shop_members
    where shop_id = v_shop_id and user_id = v_owner_id;
  insert into public.registers (shop_id, location_id, name)
    values (v_shop_id, v_location_id, 'Balance Register') returning id into v_register;
  select public.open_register_session(v_register, v_owner_member, '[]'::jsonb, null) into v_session;
  perform public.close_register_session(v_session, '[]'::jsonb, null);

  v_raised := false;
  begin
    perform public.settle_sale_balance(v_settle_sale,
      jsonb_build_array(jsonb_build_object('method', 'cash', 'amount_cents', 100)), v_session);
  exception when others then v_raised := true; v_detail := sqlerrm;
  end;
  if not v_raised then raise exception 'FAIL: money was filed into a closed register session'; end if;
  if v_detail not like '%already closed%' then
    raise exception 'FAIL: refused, but for the wrong reason: %', v_detail;
  end if;
  raise notice 'OK: refused (%)', v_detail;

  ------------------------------------------------------------------
  raise notice '=== 17. Reading a balance is not permission to take money ===';
  ------------------------------------------------------------------
  -- The role from check 6 can see what is owed, which is the point of widening
  -- those policies. Recording a payment is a till action and needs a till
  -- permission.
  perform set_config('request.jwt.claims', json_build_object('sub', v_staff_id)::text, true);
  v_raised := false;
  begin
    perform public.settle_sale_balance(v_settle_sale,
      jsonb_build_array(jsonb_build_object('method', 'cash', 'amount_cents', 100)));
  exception when others then v_raised := true; v_detail := sqlerrm;
  end;
  if not v_raised then raise exception 'FAIL: customers.view alone recorded a payment'; end if;
  if v_detail not like '%not authorized%' then
    raise exception 'FAIL: refused, but for the wrong reason: %', v_detail;
  end if;
  raise notice 'OK: refused (%)', v_detail;
  perform set_config('request.jwt.claims', json_build_object('sub', v_owner_id)::text, true);

  ------------------------------------------------------------------
  raise notice '=== 18. Goods on account earn no points until paid ===';
  ------------------------------------------------------------------
  -- Otherwise credit plus redemption is a way to take value out of the shop
  -- without ever paying for it: buy on account, earn, spend the points on a
  -- second basket, never settle the first.
  update public.shops set loyalty_enabled = true, loyalty_points_per_usd = 1,
                          loyalty_cents_per_point = 1, loyalty_points_available_after_days = 0
    where id = v_shop_id;

  select public.complete_sale(
    v_shop_id, v_items3,
    jsonb_build_array(jsonb_build_object('method', 'cash', 'amount_cents', 1000, 'tendered_cents', 1000)),
    'Bilan Warsame', null, null, null, 0, v_customer_id, null, v_location_id, 0, null, true
  ) into v_loyal_sale;

  select points_earned into v_points from public.sales where id = v_loyal_sale;
  if v_points <> 0 then
    raise exception 'FAIL: a sale with 2000 still owed credited % points', v_points;
  end if;

  select count(*) into v_rows from public.customer_points_ledger
    where sale_id = v_loyal_sale and reason = 'earn';
  if v_rows <> 0 then
    raise exception 'FAIL: an unpaid sale posted % earn rows to the ledger', v_rows;
  end if;

  -- The rate must survive anyway, or there is nothing to earn at later.
  select loyalty_points_per_usd into v_bal from public.sales where id = v_loyal_sale;
  if v_bal is null then
    raise exception 'FAIL: the sale forgot the rate it will earn at when settled';
  end if;
  raise notice 'OK: 3000 of goods on account, 0 points, rate remembered';

  ------------------------------------------------------------------
  raise notice '=== 19. Settling the balance earns them, at the frozen rate ===';
  ------------------------------------------------------------------
  -- The shop changes its rate between the sale and the settlement. The customer
  -- earns what they were promised at the till, not what the shop offers today.
  update public.shops set loyalty_points_per_usd = 5 where id = v_shop_id;

  perform public.settle_sale_balance(v_loyal_sale,
    jsonb_build_array(jsonb_build_object('method', 'cash', 'amount_cents', 1000)));

  select points_earned into v_points from public.sales where id = v_loyal_sale;
  if v_points <> 0 then
    raise exception 'FAIL: a part-settled sale credited % points', v_points;
  end if;

  perform public.settle_sale_balance(v_loyal_sale,
    jsonb_build_array(jsonb_build_object('method', 'cash', 'amount_cents', 1000)));

  select points_earned into v_points from public.sales where id = v_loyal_sale;
  if v_points <> 30 then
    raise exception 'FAIL: 3000 of goods at the sale''s own rate is 30 points, credited %', v_points;
  end if;

  select coalesce(sum(delta_points), 0) into v_ledger from public.customer_points_ledger
    where sale_id = v_loyal_sale and reason = 'earn';
  if v_ledger <> 30 then
    raise exception 'FAIL: the ledger says % where the sale says 30', v_ledger;
  end if;

  select points_balance into v_bal from public.customers where id = v_customer_id;
  select coalesce(sum(delta_points), 0) into v_ledger from public.customer_points_ledger
    where customer_id = v_customer_id;
  if v_bal <> v_ledger then
    raise exception 'FAIL: counter % <> ledger % -- every other figure here is meaningless', v_bal, v_ledger;
  end if;
  raise notice 'OK: paid off, 30 points at the frozen rate, counter and ledger agree';

  ------------------------------------------------------------------
  raise notice '=== 20. Paying in full at the till still earns immediately ===';
  ------------------------------------------------------------------
  -- The regression that matters most: the ordinary sale, which is every sale
  -- this shop has ever taken, must be untouched by any of the above.
  declare v_cash_sale uuid;
  begin
    select public.complete_sale(
      v_shop_id, v_items2,
      jsonb_build_array(jsonb_build_object('method', 'cash', 'amount_cents', 2000, 'tendered_cents', 2000)),
      'Bilan Warsame', null, null, null, 0, v_customer_id, null, v_location_id, 0
    ) into v_cash_sale;
    select points_earned into v_points from public.sales where id = v_cash_sale;
    if v_points <> 100 then
      raise exception 'FAIL: a cash sale of 2000 at rate 5 earned % points, expected 100', v_points;
    end if;
  end;
  raise notice 'OK: cash over the counter earns at the till, as it always did';

  ------------------------------------------------------------------
  raise notice '=== 21. Returned before it was paid for: no points ===';
  ------------------------------------------------------------------
  -- Buy three on account, bring one back, then settle. Crediting the full
  -- basket here would be the same loophole by a longer route, and proportioning
  -- it would have to agree with the refund clawback on a base it does not
  -- share -- so a sale returned against before it was settled earns nothing.
  select public.complete_sale(
    v_shop_id, v_items3,
    jsonb_build_array(jsonb_build_object('method', 'cash', 'amount_cents', 1000, 'tendered_cents', 1000)),
    'Bilan Warsame', null, null, null, 0, v_customer_id, null, v_location_id, 0, null, true
  ) into v_loyal_sale;

  select id into v_item_id from public.sale_items where sale_id = v_loyal_sale;
  perform public.refund_sale_items(v_loyal_sale,
    jsonb_build_array(jsonb_build_object('sale_item_id', v_item_id, 'quantity', 1)));

  -- 3000 of goods, 1000 returned, 1000 already down: 1000 left to settle.
  select owed_cents into v_owed from public.customer_balances where sale_id = v_loyal_sale;
  if v_owed <> 1000 then raise exception 'FAIL: expected 1000 owed, got %', v_owed; end if;

  perform public.settle_sale_balance(v_loyal_sale,
    jsonb_build_array(jsonb_build_object('method', 'cash', 'amount_cents', 1000)));

  select points_earned into v_points from public.sales where id = v_loyal_sale;
  if v_points <> 0 then
    raise exception 'FAIL: a sale returned against before settlement credited % points', v_points;
  end if;

  -- And the counter still reconciles, which is the check that a skipped earn
  -- did not leave a clawback to fire against somebody else's points.
  select points_balance into v_bal from public.customers where id = v_customer_id;
  select coalesce(sum(delta_points), 0) into v_ledger from public.customer_points_ledger
    where customer_id = v_customer_id;
  if v_bal <> v_ledger then
    raise exception 'FAIL: counter % <> ledger %', v_bal, v_ledger;
  end if;
  raise notice 'OK: brought back before paying earns nothing, and nothing drifted';

  ------------------------------------------------------------------
  raise notice '=== 22. Goods taken with nothing paid at all ===';
  ------------------------------------------------------------------
  -- The regular customer who takes the goods today and pays on Friday. Refused
  -- outright before this migration: complete_sale demanded at least one payment,
  -- and sales.payment_method is NOT NULL with no honest value for a sale where
  -- no money has come in.
  select public.complete_sale(
    v_shop_id, v_items2, '[]'::jsonb,
    'Bilan Warsame', null, null, null, 0, v_customer_id, null, v_location_id, 0, null, true
  ) into v_loyal_sale;

  select owed_cents into v_owed from public.customer_balances where sale_id = v_loyal_sale;
  if v_owed <> 2000 then raise exception 'FAIL: expected the whole 2000 owed, got %', v_owed; end if;

  select payment_method into v_detail from public.sales where id = v_loyal_sale;
  if v_detail <> 'unpaid' then
    raise exception 'FAIL: a sale nobody paid reads as % in the ledger, not unpaid', v_detail;
  end if;

  select points_earned into v_points from public.sales where id = v_loyal_sale;
  if v_points <> 0 then raise exception 'FAIL: goods taken on credit earned % points', v_points; end if;
  raise notice 'OK: 2000 of goods, nothing paid, reads as unpaid and earns nothing';

  ------------------------------------------------------------------
  raise notice '=== 23. Still refused with no name, and with no intent ===';
  ------------------------------------------------------------------
  v_raised := false;
  begin
    perform public.complete_sale(
      v_shop_id, v_items2, '[]'::jsonb,
      null, null, null, null, 0, null, null, v_location_id, 0, null, true
    );
  exception when others then v_raised := true; v_detail := sqlerrm;
  end;
  if not v_raised then raise exception 'FAIL: an anonymous walk-in walked out with the goods'; end if;
  raise notice 'OK: no name, no goods (%)', v_detail;

  v_raised := false;
  begin
    perform public.complete_sale(
      v_shop_id, v_items2, '[]'::jsonb,
      'Bilan Warsame', null, null, null, 0, v_customer_id, null, v_location_id, 0, null, false
    );
  exception when others then v_raised := true; v_detail := sqlerrm;
  end;
  if not v_raised then raise exception 'FAIL: an empty payment list was accepted without asking'; end if;
  if v_detail not like '%at least one payment is required%' then
    raise exception 'FAIL: refused, but for the wrong reason: %', v_detail;
  end if;
  raise notice 'OK: the old guard still guards (%)', v_detail;

  ------------------------------------------------------------------
  raise notice '=== 24. Settling replaces "unpaid" with the real method ===';
  ------------------------------------------------------------------
  -- Otherwise a sale paid off last week is still listed as unpaid in the
  -- transactions ledger forever.
  perform public.settle_sale_balance(v_loyal_sale,
    jsonb_build_array(jsonb_build_object('method', 'zaad', 'amount_cents', 2000)));

  select payment_method into v_detail from public.sales where id = v_loyal_sale;
  if v_detail <> 'zaad' then
    raise exception 'FAIL: settled by zaad, still reads as %', v_detail;
  end if;

  select points_earned into v_points from public.sales where id = v_loyal_sale;
  if v_points <> 100 then
    raise exception 'FAIL: 2000 of goods paid off should earn 100 points, earned %', v_points;
  end if;
  raise notice 'OK: reads as zaad, and the points landed on payment';

  ------------------------------------------------------------------
  raise notice '=== 25. Returning goods nobody paid for hands back no cash ===';
  ------------------------------------------------------------------
  -- The cash-loss bug. refunds.total_cents is booked as money OUT of the drawer
  -- (registers.ts) and quoted to the cashier as "$X will be refunded", and
  -- refund_sale_items apportioned sales.total_cents -- so a fully returned sale
  -- that nobody had paid a cent on handed over the whole of it.
  select public.complete_sale(
    v_shop_id, v_items3, '[]'::jsonb,
    'Bilan Warsame', null, null, null, 0, v_customer_id, null, v_location_id, 0, null, true
  ) into v_loyal_sale;

  select id into v_item_id from public.sale_items where sale_id = v_loyal_sale;
  perform public.refund_sale_items(v_loyal_sale,
    jsonb_build_array(jsonb_build_object('sale_item_id', v_item_id, 'quantity', 3)));

  select coalesce(sum(total_cents), 0), coalesce(sum(goods_cents), 0)
    into v_paid, v_refunded from public.refunds where sale_id = v_loyal_sale;
  if v_paid <> 0 then
    raise exception 'FAIL: % handed back on a sale nobody paid for', v_paid;
  end if;
  if v_refunded <> 3000 then
    raise exception 'FAIL: 3000 of goods came back, recorded as %', v_refunded;
  end if;

  -- And the debt is gone, which is the half that must NOT be capped: the customer
  -- gave the goods back, so they owe nothing.
  select count(*) into v_rows from public.customer_balances where sale_id = v_loyal_sale;
  if v_rows <> 0 then
    raise exception 'FAIL: the customer is still being chased for goods they returned';
  end if;
  raise notice 'OK: 3000 of goods back, 0 cash out, nothing owed';

  ------------------------------------------------------------------
  raise notice '=== 26. A part-paid sale hands back only what came in ===';
  ------------------------------------------------------------------
  -- 3000 of goods, 1000 collected. Return the lot: the customer is owed the 1000
  -- they actually paid, not the 3000 the goods were worth.
  select public.complete_sale(
    v_shop_id, v_items3,
    jsonb_build_array(jsonb_build_object('method', 'cash', 'amount_cents', 1000, 'tendered_cents', 1000)),
    'Bilan Warsame', null, null, null, 0, v_customer_id, null, v_location_id, 0, null, true
  ) into v_loyal_sale;

  select id into v_item_id from public.sale_items where sale_id = v_loyal_sale;
  perform public.refund_sale_items(v_loyal_sale,
    jsonb_build_array(jsonb_build_object('sale_item_id', v_item_id, 'quantity', 3)));

  select coalesce(sum(total_cents), 0), coalesce(sum(goods_cents), 0)
    into v_paid, v_refunded from public.refunds where sale_id = v_loyal_sale;
  if v_paid <> 1000 then
    raise exception 'FAIL: expected 1000 cash back, got %', v_paid;
  end if;
  if v_refunded <> 3000 then
    raise exception 'FAIL: expected 3000 of goods recorded, got %', v_refunded;
  end if;
  raise notice 'OK: 1000 in, 1000 out, 3000 of goods recorded against the debt';

  ------------------------------------------------------------------
  raise notice '=== 27. Returning in pieces never over-pays in total ===';
  ------------------------------------------------------------------
  -- The drift case: three separate returns on a part-paid sale must sum to the
  -- 1000 collected, not to 1000 three times.
  select public.complete_sale(
    v_shop_id, v_items3,
    jsonb_build_array(jsonb_build_object('method', 'cash', 'amount_cents', 1000, 'tendered_cents', 1000)),
    'Bilan Warsame', null, null, null, 0, v_customer_id, null, v_location_id, 0, null, true
  ) into v_loyal_sale;

  select id into v_item_id from public.sale_items where sale_id = v_loyal_sale;
  perform public.refund_sale_items(v_loyal_sale,
    jsonb_build_array(jsonb_build_object('sale_item_id', v_item_id, 'quantity', 1)));
  perform public.refund_sale_items(v_loyal_sale,
    jsonb_build_array(jsonb_build_object('sale_item_id', v_item_id, 'quantity', 1)));
  perform public.refund_sale_items(v_loyal_sale,
    jsonb_build_array(jsonb_build_object('sale_item_id', v_item_id, 'quantity', 1)));

  select coalesce(sum(total_cents), 0), coalesce(sum(goods_cents), 0)
    into v_paid, v_refunded from public.refunds where sale_id = v_loyal_sale;
  if v_paid <> 1000 then
    raise exception 'FAIL: three returns handed back % in total, not the 1000 collected', v_paid;
  end if;
  if v_refunded <> 3000 then
    raise exception 'FAIL: three returns recorded % of goods, not 3000', v_refunded;
  end if;
  raise notice 'OK: 1000 out across three returns, 3000 of goods';

  ------------------------------------------------------------------
  raise notice '=== 28. An unpaid sale can still be edited ===';
  ------------------------------------------------------------------
  -- 20260831000100 claimed this and did not do it, leaving a wholly unpaid sale
  -- permanently uneditable.
  select public.complete_sale(
    v_shop_id, v_items2, '[]'::jsonb,
    'Bilan Warsame', null, null, null, 0, v_customer_id, null, v_location_id, 0, null, true
  ) into v_loyal_sale;

  perform public.edit_sale(
    v_loyal_sale, v_items3, '[]'::jsonb,
    'Bilan Warsame', null, null, 0, v_customer_id, true
  );

  select owed_cents into v_owed from public.customer_balances where sale_id = v_loyal_sale;
  if v_owed <> 3000 then
    raise exception 'FAIL: after editing 2 units up to 3, expected 3000 owed, got %', v_owed;
  end if;
  raise notice 'OK: edited from 2000 to 3000, still wholly owed';

  ------------------------------------------------------------------
  raise notice '=== 29. Settlement cash counts at the till that took it ===';
  ------------------------------------------------------------------
  -- register_session_expected attributed every payment through the SALE's
  -- session, which was the only one a payment could have while all of a sale's
  -- money arrived at once. A settlement arrives days later at another till, so
  -- that till closed with a surplus it could not explain.
  declare
    v_reg2 uuid;
    v_sess2 uuid;
    v_expected integer;
    v_credit_sale uuid;
  begin
    insert into public.registers (shop_id, location_id, name)
      values (v_shop_id, v_location_id, 'Settlement Till') returning id into v_reg2;
    -- With a USD float row, so register_session_expected has a bucket to report:
    -- it returns one row per register_session_cash row, and a session opened with
    -- no floats has none.
    select public.open_register_session(v_reg2, v_owner_member,
      jsonb_build_array(jsonb_build_object('currency_code', 'USD', 'amount_minor', 0, 'rate_to_usd', 1)),
      null) into v_sess2;

    -- A credit sale rung up with NO session at all, so nothing can be attributed
    -- to it by the old path.
    select public.complete_sale(
      v_shop_id, v_items2, '[]'::jsonb,
      'Bilan Warsame', null, null, null, 0, v_customer_id, null, v_location_id, 0, null, true
    ) into v_credit_sale;

    select expected_minor into v_expected
      from public.register_session_expected(v_sess2) where currency_code = 'USD';
    if coalesce(v_expected, 0) <> 0 then
      raise exception 'FAIL: a fresh till expected % before taking anything', v_expected;
    end if;

    -- Settle it in cash at THIS till.
    perform public.settle_sale_balance(v_credit_sale,
      jsonb_build_array(jsonb_build_object('method', 'cash', 'amount_cents', 2000, 'tendered_cents', 2000)),
      v_sess2);

    select expected_minor into v_expected
      from public.register_session_expected(v_sess2) where currency_code = 'USD';
    if coalesce(v_expected, 0) <> 2000 then
      raise exception 'FAIL: the till took 2000 in cash and expects %', coalesce(v_expected, 0);
    end if;
  end;
  raise notice 'OK: 2000 settled in cash, and the till expects 2000';

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
