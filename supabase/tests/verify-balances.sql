-- What a customer still owes, and who is allowed to see it.
--
-- customer_balances computes one number across three tables (sales, payments,
-- refunds), which makes it wrong in three directions that all look fine:
--   * join both children directly and they multiply, so a sale with two
--     payments counts its one refund twice;
--   * read it as a role that can see sales but not payments and RLS silently
--     returns `owed = total` on a sale that was paid off months ago;
--   * subtract the VALUE of the goods returned without adding back the CASH
--     handed over for them, and the same money is forgiven twice -- the two
--     figures are equal only on a sale that was paid in full, which is every
--     sale the first twenty-nine checks here were written against.
-- None of them raises. The first two send someone to ask a customer for money
-- they already handed over; the third writes off money the shop is owed and
-- leaves it stranded in 1100 Accounts Receivable. All are asserted here on
-- exact cents.
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
  -- 3000 rung up, 1000 collected, one unit worth 1000 back. The cap hands the
  -- customer their whole 1000 over the counter, so the debt does NOT move: they
  -- are holding 2000 of goods and have paid nothing net.
  --
  -- This check read 1000 until 20260908001400. The view subtracted the goods
  -- without adding the cash back on, forgiving the same 1000 twice.
  select id into v_item_id from public.sale_items where sale_id = v_sale_id;
  perform public.refund_sale_items(v_sale_id,
    jsonb_build_array(jsonb_build_object('sale_item_id', v_item_id, 'quantity', 1)));

  select coalesce(sum(total_cents), 0) into v_paid from public.refunds where sale_id = v_sale_id;
  if v_paid <> 1000 then
    raise exception 'FAIL: fixture handed back % in cash, expected the 1000 collected', v_paid;
  end if;

  select owed_cents, refunded_cents into v_owed, v_refunded
    from public.customer_balances where sale_id = v_sale_id;
  if v_owed <> 2000 or v_refunded <> 1000 then
    raise exception 'FAIL: after returning one unit for cash expected owed 2000 / refunded 1000, got % / %', v_owed, v_refunded;
  end if;
  raise notice 'OK: one unit back, 1000 handed over, still 2000 of goods unpaid for';

  -- Returning the rest cancels what is left. The 1000 collected has already gone
  -- back out on the first refund, so this one hands over nothing and the debt
  -- falls by the whole value of the goods.
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
  -- the refund is summed twice: refunded reads double and owed reads 500 less
  -- than it should. Every fixture with one payment and one refund passes anyway,
  -- which is why this one has two.
  --
  -- THREE units back, not one, and that is load-bearing since 20260908001400.
  -- owed now subtracts goods_cents and adds total_cents back, so a fixture where
  -- the two are EQUAL has the doubling cancel itself out exactly and the cross
  -- product goes undetected. 3000 of goods against 2500 collected puts the cash
  -- cap to work -- goods 3000, cash 2500 -- and the two errors no longer agree.
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
    jsonb_build_array(jsonb_build_object('sale_item_id', v_item_id, 'quantity', 3)));

  select owed_cents, paid_cents, refunded_cents into v_owed, v_paid, v_refunded
    from public.customer_balances where sale_id = v_sale_id;
  if v_paid <> 2500 or v_refunded <> 3000 or v_owed <> 1000 then
    raise exception 'FAIL: expected paid 2500 / refunded 3000 / owed 1000, got % / % / %', v_paid, v_refunded, v_owed;
  end if;
  raise notice 'OK: 4000 less 3000 returned less 2500 taken plus 2500 handed back = 1000, each counted once';

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
  -- owed = 4000 on a sale owing 1000 -- no error, just a number four times too
  -- big, on the exact screen someone uses to ring a customer up.
  perform set_config('request.jwt.claims', json_build_object('sub', v_staff_id)::text, true);

  select owed_cents, paid_cents, refunded_cents into v_owed, v_paid, v_refunded
    from public.customer_balances where sale_id = v_sale_id;
  if v_owed is null then
    raise exception 'FAIL: customers.view reads no balances at all';
  end if;
  if v_owed <> 1000 or v_paid <> 2500 or v_refunded <> 3000 then
    raise exception 'FAIL: customers.view reads owed % / paid % / refunded % where the owner reads 1000 / 2500 / 3000',
      v_owed, v_paid, v_refunded;
  end if;
  raise notice 'OK: staff and owner read the same 1000';

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

  -- 3000 of goods, 1000 already down, one unit worth 1000 back -- and the cap
  -- hands that 1000 straight back over the counter, so 2000 is left to settle.
  -- This read 1000 until 20260908001400 counted the cash going out.
  select owed_cents into v_owed from public.customer_balances where sale_id = v_loyal_sale;
  if v_owed <> 2000 then raise exception 'FAIL: expected 2000 owed, got %', v_owed; end if;

  -- The whole of it, so the sale really does reach settled_at -- which is the
  -- only state in which points could be credited, and therefore the only state
  -- in which this check means anything.
  perform public.settle_sale_balance(v_loyal_sale,
    jsonb_build_array(jsonb_build_object('method', 'cash', 'amount_cents', 2000)));

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

  ------------------------------------------------------------------
  -- 30-34: the cash a refund hands over is a payment RUNNING BACKWARDS.
  ------------------------------------------------------------------
  -- 20260831000200 moved owed_cents onto refunds.goods_cents -- the VALUE of
  -- what came back -- and never added refunds.total_cents, the CASH, back on.
  -- So a return that was paid out in cash forgave the customer the same money
  -- twice: once by reducing the debt, once by handing them the notes.
  --
  -- The two formulas coincide on a FULL return (both fall to or below zero and
  -- the view's own `owed > 0` filter hides the difference) and on a return that
  -- paid out nothing, which is every case the checks above exercised. Checks 32
  -- and 33 pin those two so they cannot move; 30, 31 and 34 are the divergence.
  declare
    v_rice        uuid;
    v_rice_sale   uuid;
    v_rice_item   uuid;
    v_cash_back   integer;
    v_owed_before integer;
  begin
    -- 3150 a unit, so the worked example's figures are the shop's own and not a
    -- multiple of anything else in this file.
    insert into public.products (shop_id, name, price_cents, cost_cents)
      values (v_shop_id, 'Verify Rice', 3150, 1200) returning id into v_rice;
    insert into public.product_location_stock (product_id, location_id, stock)
      values (v_rice, v_location_id, 10000);

    ----------------------------------------------------------------
    raise notice '=== 30. Money handed back over the counter is still owed ===';
    ----------------------------------------------------------------
    -- 6300 rung up, 2000 paid, one unit worth 3150 returned. The cap hands the
    -- customer their 2000 back, because that is all the shop ever took.
    --
    --   the view said     6300 - 3150 - 2000        = 1150
    --   the customer owes 6300 - 3150 - 2000 + 2000 = 3150
    --
    -- and settle_sale_balance, computing the same wrong figure, REFUSED anything
    -- over 1150 and then stamped settled_at -- stranding 2000 in 1100 Accounts
    -- Receivable that no screen in the app could ever collect.
    select public.complete_sale(
      v_shop_id,
      jsonb_build_array(jsonb_build_object('product_id', v_rice, 'quantity', 2, 'discount_cents', 0)),
      jsonb_build_array(jsonb_build_object('method', 'cash', 'amount_cents', 2000, 'tendered_cents', 2000)),
      'Bilan Warsame', null, null, null, 0, v_customer_id, null, v_location_id, 0, null, true
    ) into v_rice_sale;

    select id into v_rice_item from public.sale_items where sale_id = v_rice_sale;
    perform public.refund_sale_items(v_rice_sale,
      jsonb_build_array(jsonb_build_object('sale_item_id', v_rice_item, 'quantity', 1)));

    -- The fixture itself, asserted: a check that silently stopped producing this
    -- shape would pass for the wrong reason.
    select coalesce(sum(goods_cents), 0), coalesce(sum(total_cents), 0)
      into v_refunded, v_cash_back from public.refunds where sale_id = v_rice_sale;
    if v_refunded <> 3150 or v_cash_back <> 2000 then
      raise exception 'FAIL: fixture returned goods % / cash %, expected 3150 / 2000', v_refunded, v_cash_back;
    end if;

    select owed_cents into v_owed from public.customer_balances where sale_id = v_rice_sale;
    if v_owed is distinct from 3150 then
      raise exception 'FAIL: 6300 less 3150 of goods less 2000 paid plus 2000 handed back is 3150, the view says %', v_owed;
    end if;

    -- And the RPC will now take it. This is the half that was stranding money.
    select public.settle_sale_balance(v_rice_sale,
      jsonb_build_array(jsonb_build_object('method', 'cash', 'amount_cents', 3150))) into v_left;
    if v_left <> 0 then
      raise exception 'FAIL: 3150 against 3150 owed left %', v_left;
    end if;
    select settled_at into v_settled from public.sales where id = v_rice_sale;
    if v_settled is null then raise exception 'FAIL: paying the whole 3150 did not settle the sale'; end if;
    raise notice 'OK: 3150 owed, 3150 collected, nothing stranded';

    ----------------------------------------------------------------
    raise notice '=== 31. The debt that disappeared off the list entirely ===';
    ----------------------------------------------------------------
    -- The `owed > 0` filter, which is the second place the cash term has to
    -- appear. 6300 rung up, 3150 paid, one unit worth 3150 back, 3150 handed
    -- over: the old expression computes to EXACTLY ZERO and the sale vanishes
    -- from the receivables list owing 3150. Nobody is chased for the wrong
    -- amount -- nobody is chased at all.
    select public.complete_sale(
      v_shop_id,
      jsonb_build_array(jsonb_build_object('product_id', v_rice, 'quantity', 2, 'discount_cents', 0)),
      jsonb_build_array(jsonb_build_object('method', 'cash', 'amount_cents', 3150, 'tendered_cents', 3150)),
      'Bilan Warsame', null, null, null, 0, v_customer_id, null, v_location_id, 0, null, true
    ) into v_rice_sale;

    select id into v_rice_item from public.sale_items where sale_id = v_rice_sale;
    perform public.refund_sale_items(v_rice_sale,
      jsonb_build_array(jsonb_build_object('sale_item_id', v_rice_item, 'quantity', 1)));

    select count(*) into v_rows from public.customer_balances where sale_id = v_rice_sale;
    if v_rows <> 1 then
      raise exception 'FAIL: a sale owing 3150 appears in % rows of the receivables list', v_rows;
    end if;
    select owed_cents into v_owed from public.customer_balances where sale_id = v_rice_sale;
    if v_owed <> 3150 then
      raise exception 'FAIL: expected 3150 owed, got %', v_owed;
    end if;
    raise notice 'OK: on the list, owing 3150, rather than gone';

    ----------------------------------------------------------------
    raise notice '=== 32. A FULL return behaves exactly as it always did ===';
    ----------------------------------------------------------------
    -- The case every existing check exercised, and the reason this bug never
    -- went red. Both formulas land at or below zero on a full return, so the
    -- filter hides the difference. It must not move.
    select public.complete_sale(
      v_shop_id,
      jsonb_build_array(jsonb_build_object('product_id', v_rice, 'quantity', 2, 'discount_cents', 0)),
      jsonb_build_array(jsonb_build_object('method', 'cash', 'amount_cents', 2000, 'tendered_cents', 2000)),
      'Bilan Warsame', null, null, null, 0, v_customer_id, null, v_location_id, 0, null, true
    ) into v_rice_sale;

    select id into v_rice_item from public.sale_items where sale_id = v_rice_sale;
    perform public.refund_sale_items(v_rice_sale,
      jsonb_build_array(jsonb_build_object('sale_item_id', v_rice_item, 'quantity', 2)));

    select count(*) into v_rows from public.customer_balances where sale_id = v_rice_sale;
    if v_rows <> 0 then
      raise exception 'FAIL: a fully returned sale is being chased for something';
    end if;

    v_raised := false;
    begin
      perform public.settle_sale_balance(v_rice_sale,
        jsonb_build_array(jsonb_build_object('method', 'cash', 'amount_cents', 100)));
    exception when others then v_raised := true; v_detail := sqlerrm;
    end;
    if not v_raised then raise exception 'FAIL: a fully returned sale took another payment'; end if;
    if v_detail not like '%already paid in full%' then
      raise exception 'FAIL: refused, but for the wrong reason: %', v_detail;
    end if;
    raise notice 'OK: nothing on the list, and the RPC still refuses (%)', v_detail;

    ----------------------------------------------------------------
    raise notice '=== 33. A return that paid out no cash moves only by the goods ===';
    ----------------------------------------------------------------
    -- The other case the two formulas share: nothing was ever collected, so
    -- nothing goes back and the debt falls by the full value of the goods. The
    -- fix must not disturb it.
    select public.complete_sale(
      v_shop_id,
      jsonb_build_array(jsonb_build_object('product_id', v_rice, 'quantity', 2, 'discount_cents', 0)),
      '[]'::jsonb,
      'Bilan Warsame', null, null, null, 0, v_customer_id, null, v_location_id, 0, null, true
    ) into v_rice_sale;

    select id into v_rice_item from public.sale_items where sale_id = v_rice_sale;
    perform public.refund_sale_items(v_rice_sale,
      jsonb_build_array(jsonb_build_object('sale_item_id', v_rice_item, 'quantity', 1)));

    select coalesce(sum(total_cents), 0) into v_cash_back
      from public.refunds where sale_id = v_rice_sale;
    if v_cash_back <> 0 then
      raise exception 'FAIL: % handed back on a sale nobody had paid for', v_cash_back;
    end if;

    select owed_cents into v_owed from public.customer_balances where sale_id = v_rice_sale;
    if v_owed <> 3150 then
      raise exception 'FAIL: 6300 less 3150 of goods with no cash out is 3150, the view says %', v_owed;
    end if;
    raise notice 'OK: 3150 of goods back, no cash, 3150 still owed';

    ----------------------------------------------------------------
    raise notice '=== 34. The view, the RPC and the ledger all say one number ===';
    ----------------------------------------------------------------
    -- Asserted against EACH OTHER, not each against a constant. The view and
    -- settle_sale_balance computing the same wrong figure is the only reason
    -- this bug was consistent rather than random, and a fix applied to one of
    -- them is worse than no fix at all.
    --
    -- The ledger is the third witness and the one that was right all along:
    -- complete_sale debits 1100 with (total - paid), refund_sale_items credits
    -- it with (goods - cash), and settle_sale_balance credits it with each
    -- instalment. Summed, that IS this migration's formula.
    select public.complete_sale(
      v_shop_id,
      jsonb_build_array(jsonb_build_object('product_id', v_rice, 'quantity', 3, 'discount_cents', 0)),
      jsonb_build_array(jsonb_build_object('method', 'cash', 'amount_cents', 4000, 'tendered_cents', 4000)),
      'Bilan Warsame', null, null, null, 0, v_customer_id, null, v_location_id, 0, null, true
    ) into v_rice_sale;

    select id into v_rice_item from public.sale_items where sale_id = v_rice_sale;
    perform public.refund_sale_items(v_rice_sale,
      jsonb_build_array(jsonb_build_object('sale_item_id', v_rice_item, 'quantity', 1)));

    select owed_cents into v_owed_before from public.customer_balances where sale_id = v_rice_sale;
    if coalesce(v_owed_before, 0) <= 0 then
      raise exception 'FAIL: the fixture owes % -- nothing left to compare', coalesce(v_owed_before, 0);
    end if;

    -- 1100 across every entry this sale has produced: its own, its refunds' and
    -- its settlements'. journal_entry_id is the only link back -- journal_entries
    -- carries no source_id.
    select coalesce(sum(l.amount_cents), 0) into v_ledger
      from public.journal_lines l
      join public.accounts a on a.id = l.account_id
     where a.code = '1100'
       and l.entry_id in (
         select journal_entry_id from public.sales
           where id = v_rice_sale and journal_entry_id is not null
         union all
         select journal_entry_id from public.refunds
           where sale_id = v_rice_sale and journal_entry_id is not null
         union all
         select journal_entry_id from public.sale_payments
           where sale_id = v_rice_sale and journal_entry_id is not null);
    if v_ledger <> v_owed_before then
      raise exception 'FAIL: 1100 Accounts Receivable holds % for this sale, the view says % is owed -- off by %',
        v_ledger, v_owed_before, v_ledger - v_owed_before;
    end if;

    -- The RPC's own v_owed, read through its return value rather than asserted
    -- against a number: take 100 and it must report exactly the view's figure
    -- less 100.
    select public.settle_sale_balance(v_rice_sale,
      jsonb_build_array(jsonb_build_object('method', 'cash', 'amount_cents', 100))) into v_left;
    if v_left <> v_owed_before - 100 then
      raise exception 'FAIL: the view said % owed; after taking 100 the RPC says % is left, not %',
        v_owed_before, v_left, v_owed_before - 100;
    end if;

    select owed_cents into v_owed from public.customer_balances where sale_id = v_rice_sale;
    if v_owed is distinct from v_left then
      raise exception 'FAIL: the RPC says % is left and the view says % -- they have diverged', v_left, v_owed;
    end if;

    -- And the ledger follows the settlement down, still to the cent.
    select coalesce(sum(l.amount_cents), 0) into v_ledger
      from public.journal_lines l
      join public.accounts a on a.id = l.account_id
     where a.code = '1100'
       and l.entry_id in (
         select journal_entry_id from public.sales
           where id = v_rice_sale and journal_entry_id is not null
         union all
         select journal_entry_id from public.refunds
           where sale_id = v_rice_sale and journal_entry_id is not null
         union all
         select journal_entry_id from public.sale_payments
           where sale_id = v_rice_sale and journal_entry_id is not null);
    if v_ledger <> v_owed then
      raise exception 'FAIL: after the settlement 1100 holds % and the view says % is owed', v_ledger, v_owed;
    end if;

    -- Paying off the rest closes it in all three places at once.
    select public.settle_sale_balance(v_rice_sale,
      jsonb_build_array(jsonb_build_object('method', 'zaad', 'amount_cents', v_left))) into v_left;
    if v_left <> 0 then raise exception 'FAIL: expected nothing left, got %', v_left; end if;
    select count(*) into v_rows from public.customer_balances where sale_id = v_rice_sale;
    if v_rows <> 0 then raise exception 'FAIL: a sale paid off is still on the receivables list'; end if;
    raise notice 'OK: view, RPC and 1100 agree on % throughout', v_owed_before;

    ----------------------------------------------------------------
    raise notice '=== 35. The sales the old formula closed too early ===';
    ----------------------------------------------------------------
    -- 20260908001400 ends with a one-shot UPDATE that clears settled_at on the
    -- sales the old figure closed with money still outstanding. That statement
    -- runs against an empty database at migration time and is therefore
    -- exercised by nothing -- while being the only destructive thing in the
    -- migration, on real money, on sales a shop has already told a customer are
    -- settled.
    --
    -- So it is re-executed here, VERBATIM, against a state built by hand to look
    -- like what the old code left behind. IF THE MIGRATION'S PREDICATE CHANGES,
    -- CHANGE THIS ONE TOO -- they are a pair, and the migration says so.
    --
    -- Three sales, and only the first may move:
    --   A  6300, 2000 paid, one unit worth 3150 back with 2000 handed over, then
    --      stamped after taking the 1150 the old formula allowed. 2000 is still
    --      sitting in 1100 and no screen can reach it.
    --   B  paid in full at the till, then a unit back for cash. Owed nothing
    --      before the return and owes nothing after it.
    --   C  A's money shape with nobody attached. The receivables list filters on
    --      customer_id, so clearing this would only offer an edit path for a
    --      debt no one can be asked for.
    declare
      v_a uuid; v_b uuid; v_c uuid;
    begin
      select public.complete_sale(v_shop_id,
        jsonb_build_array(jsonb_build_object('product_id', v_rice, 'quantity', 2, 'discount_cents', 0)),
        jsonb_build_array(jsonb_build_object('method','cash','amount_cents',2000,'tendered_cents',2000)),
        'Bilan Warsame', null, null, null, 0, v_customer_id, null, v_location_id, 0, null, true) into v_a;
      select id into v_rice_item from public.sale_items where sale_id = v_a;
      perform public.refund_sale_items(v_a,
        jsonb_build_array(jsonb_build_object('sale_item_id', v_rice_item, 'quantity', 1)));
      perform public.settle_sale_balance(v_a,
        jsonb_build_array(jsonb_build_object('method','cash','amount_cents',1150)));
      -- What the old RPC did once it had taken everything it believed was owed.
      update public.sales set settled_at = now() where id = v_a;

      select public.complete_sale(v_shop_id,
        jsonb_build_array(jsonb_build_object('product_id', v_rice, 'quantity', 2, 'discount_cents', 0)),
        jsonb_build_array(jsonb_build_object('method','cash','amount_cents',6300,'tendered_cents',6300)),
        'Bilan Warsame', null, null, null, 0, v_customer_id, null, v_location_id, 0, null, true) into v_b;
      select id into v_rice_item from public.sale_items where sale_id = v_b;
      perform public.refund_sale_items(v_b,
        jsonb_build_array(jsonb_build_object('sale_item_id', v_rice_item, 'quantity', 1)));

      select public.complete_sale(v_shop_id,
        jsonb_build_array(jsonb_build_object('product_id', v_rice, 'quantity', 2, 'discount_cents', 0)),
        jsonb_build_array(jsonb_build_object('method','cash','amount_cents',6300,'tendered_cents',6300)),
        null, null, null, null, 0, null, null, v_location_id, 0) into v_c;
      select id into v_rice_item from public.sale_items where sale_id = v_c;
      perform public.refund_sale_items(v_c,
        jsonb_build_array(jsonb_build_object('sale_item_id', v_rice_item, 'quantity', 1)));
      delete from public.sale_payments where sale_id = v_c and amount_cents = 6300;
      insert into public.sale_payments (sale_id, method, amount_cents) values (v_c, 'cash', 2000);

      -- ── 20260908001400's statement, verbatim ──────────────────────────────
      update public.sales s
         set settled_at = null
       where s.settled_at is not null
         and s.customer_id is not null
         and exists (select 1 from public.refunds r where r.sale_id = s.id and r.total_cents > 0)
         and (s.total_cents
              - coalesce((select sum(r.goods_cents) from public.refunds r where r.sale_id = s.id), 0)
              - coalesce((select sum(p.amount_cents) from public.sale_payments p where p.sale_id = s.id), 0)
              + coalesce((select sum(r.total_cents) from public.refunds r where r.sale_id = s.id), 0)) > 0;

      select settled_at into v_settled from public.sales where id = v_a;
      if v_settled is not null then
        raise exception 'FAIL: the sale with 2000 stranded in 1100 is still stamped settled';
      end if;
      select owed_cents into v_owed from public.customer_balances where sale_id = v_a;
      if v_owed is distinct from 2000 then
        raise exception 'FAIL: re-opened owing %, expected the 2000 that 1100 was holding', v_owed;
      end if;

      select settled_at into v_settled from public.sales where id = v_b;
      if v_settled is null then
        raise exception 'FAIL: a sale settled correctly under the old formula was re-opened';
      end if;

      select settled_at into v_settled from public.sales where id = v_c;
      if v_settled is null then
        raise exception 'FAIL: a sale with nobody attached was re-opened, and nobody can be asked for it';
      end if;

      -- Idempotent, because a migration gets re-run against a database someone
      -- has already migrated more often than anyone plans for.
      update public.sales s set settled_at = null
       where s.settled_at is not null
         and s.customer_id is not null
         and exists (select 1 from public.refunds r where r.sale_id = s.id and r.total_cents > 0)
         and (s.total_cents
              - coalesce((select sum(r.goods_cents) from public.refunds r where r.sale_id = s.id), 0)
              - coalesce((select sum(p.amount_cents) from public.sale_payments p where p.sale_id = s.id), 0)
              + coalesce((select sum(r.total_cents) from public.refunds r where r.sale_id = s.id), 0)) > 0;
      get diagnostics v_rows = row_count;
      if v_rows <> 0 then
        raise exception 'FAIL: a second run re-opened % more sales', v_rows;
      end if;
      raise notice 'OK: the stranded 2000 is collectable again; the other two are left alone';
    end;
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
