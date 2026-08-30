-- amend_order: a shop changes an order instead of cancelling it.
--
-- Same shape as verify-orders.sql -- one DO block, EXCEPTION rolls everything
-- back, so it leaves no rows behind. There is no seed.sql: this file builds
-- its own shop, storefront, roles, products and orders, and asserts nothing
-- about rows it did not create.
--
-- Every failure `raise exception`s. A `raise notice 'FAIL ...'` would fail
-- NOTHING -- run-all.sh:82 greps the whole output for the verdict string, so a
-- notice scrolls past and the script still reports pass. The verdict sits in
-- the LAST block's exception handler, after every check.
--
-- What this checks, and why each one is here:
--    1.  amending a `pending` order rewrites its lines and returns the new row.
--    2.  amending an `accepted` order succeeds -- an order already promised is
--        exactly the one a shop needs to reduce.
--    3/4. a `completed` or `cancelled` order raises `order_not_amendable`.
--        Completed is the one that matters: it has a sale posted against it,
--        and rewriting its lines would leave the shop's two records of one
--        transaction disagreeing forever.
--    5.  a blank or whitespace reason raises `amendment_reason_required` --
--        the same belt-and-braces the cancellation reason has
--        (orders_cancellation_reason_required, 20260928000100:81): a CHECK on
--        the table AND a guard in the function.
--    6.  the amended order still satisfies orders_total_is_subtotal_plus_
--        delivery, asserted ARITHMETICALLY off the row that was read back
--        rather than by trusting the constraint to have fired.
--    7a. THE DEFAULT HONOURS THE AGREED PRICE. The product is re-priced after
--        the order is placed; the amend keeps what the customer agreed to.
--    7b. p_pricing => 'current' re-prices to today's shelf, because a shop is
--        allowed to decide that -- and check 13 proves the choice is recorded.
--    8.  AN AMENDED ORDER CAN STILL BE COMPLETED, in BOTH pricing modes,
--        without `order_total_changed`. This is the check the whole design
--        exists to satisfy. That error now fires only when the order ROW
--        disagrees with the order's own LINES (20261011000000:1477), so an
--        amend that writes one and not the other is exactly what it catches.
--    9.  reducing every line to zero raises `order_has_no_items` rather than
--        leaving an order with nothing in it.
--   10.  a line whose product was deleted (order_items.product_id is null,
--        `on delete set null`) may be REMOVED by omission, but naming it
--        raises `order_product_deleted` -- complete_storefront_order refuses
--        such an order, so an amend that kept one would build an order that
--        cannot be handed over.
--   11.  deliver -> collect zeroes BOTH the fee and the area, satisfying
--        orders_delivery_matches_fulfilment.
--   12.  collect -> deliver re-resolves the fee from the shop's own
--        storefront_delivery_areas row. THE FEE IS NEVER A PARAMETER: a
--        caller who could name the fee could name zero.
--   13.  an order_amendments row is written, carrying the reason, the pricing
--        mode, and a before/after that DIFFER.
--   14.  a non-member is refused, and so is a member without `sales.edit`.
--        The second one needs a hand-built role: default_shop_roles seeds
--        Manager WITH sales.edit (0020_default_roles.sql:12), and the owner
--        bypasses every permission check by ownership alone.
--   15.  `authenticated` still cannot write orders or order_items directly --
--        20260928000300's lockdown is what makes this RPC the only writer,
--        and a future migration restoring that grant is the thing this
--        catches.
--   16.  a line over the agreed price's per-line ceiling (1,000,000,000
--        cents, 20260929000050) is refused AT AMEND TIME as
--        `order_line_out_of_range`, not left to fail at the till.
--   17.  an amend may not ADD a product the customer never ordered:
--        `order_line_not_in_order`.
--   18.  the customer's phone is validated as E.164 by the function rather
--        than reaching the column CHECK as a raw Postgres error.
--   19.  several lines EACH under the per-line ceiling can still sum past
--        int32, which orders.subtotal_cents cannot hold. Without a guard that
--        is a bare `integer out of range` raised from mid-function -- the
--        exact failure 20260929000050's header is about. 3 x (2 x
--        500,000,000) is 3,000,000,000: every line lands exactly ON the
--        1,000,000,000 line ceiling and is allowed, and the sum is not.

do $$
declare
  v_owner_id    uuid := gen_random_uuid();
  -- A member who MAY amend, and is not the owner -- so check 14's refusal is
  -- proven against the permission and not against membership.
  v_editor_id   uuid := gen_random_uuid();
  -- pos.access and nothing else: may ring up a sale, may not amend an order.
  v_clerk_id    uuid := gen_random_uuid();
  v_stranger_id uuid := gen_random_uuid();

  v_shop_id  uuid;
  v_loc_id   uuid;
  v_editor_role uuid;
  v_clerk_role  uuid;

  v_prod_rice  uuid;  -- 2500, re-priced to 3000 for checks 7a/7b
  v_prod_oil   uuid;  -- 1000
  v_prod_gone  uuid;  --  500, deleted mid-script for check 10
  v_prod_huge  uuid;  -- 600,000,000 for check 16
  v_prod_extra uuid;  --  900, never ordered, for check 17
  -- Three at 500,000,000 for check 19: doubling each puts every line exactly
  -- ON the per-line ceiling (allowed) while the sum passes int32.
  v_prod_big1  uuid;
  v_prod_big2  uuid;
  v_prod_big3  uuid;

  v_pending_id   uuid;
  v_accepted_id  uuid;
  v_completed_id uuid;
  v_cancelled_id uuid;
  v_agreed_id    uuid;
  v_current_id   uuid;
  v_zero_id      uuid;
  v_gone_id      uuid;
  v_deliver_id   uuid;
  v_collect_id   uuid;
  v_perm_id      uuid;
  v_huge_id      uuid;
  v_add_id       uuid;
  v_phone_id     uuid;
  v_big_id       uuid;
  v_oneway_id    uuid;

  v_order    public.orders%rowtype;
  v_count    integer;
  v_amount   bigint;
  v_text     text;
  v_msg      text;
  v_sale_id  uuid;
  v_before   jsonb;
  v_after    jsonb;
begin
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
    select u, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
           'verify-order-amendments-' || u || '@example.test', '', now(), now(), now()
      from unnest(array[v_owner_id, v_editor_id, v_clerk_id, v_stranger_id]) u;

  insert into public.shops (owner_id, name) values (v_owner_id, 'Amending Shop')
    returning id into v_shop_id;
  insert into public.storefronts (shop_id, offers_delivery) values (v_shop_id, true);
  insert into public.shop_locations (shop_id, name, is_primary)
    values (v_shop_id, 'Main', true) returning id into v_loc_id;

  insert into public.storefront_delivery_areas (shop_id, name, fee_cents)
    values (v_shop_id, 'Xero Awr', 1500);

  -- Built by hand, both of them. default_shop_roles() seeds Manager with
  -- `sales.edit` already on it (0020_default_roles.sql:12), so a role that
  -- LACKS it is the one a shop would have to make deliberately -- and it is
  -- the only fixture that can prove the gate.
  insert into public.roles (shop_id, name, permissions)
    values (v_shop_id, 'Order editor', array['pos.access', 'sales.edit'])
    returning id into v_editor_role;
  insert into public.roles (shop_id, name, permissions)
    values (v_shop_id, 'Clerk, no editing', array['pos.access'])
    returning id into v_clerk_role;

  insert into public.shop_members (shop_id, user_id, role_id, full_name, active)
    values (v_shop_id, v_editor_id, v_editor_role, 'Order Editor', true),
           (v_shop_id, v_clerk_id,  v_clerk_role,  'Plain Clerk',  true);

  insert into public.products (shop_id, name, price_cents, cost_cents)
    values (v_shop_id, 'Basmati rice', 2500, 900) returning id into v_prod_rice;
  insert into public.products (shop_id, name, price_cents, cost_cents)
    values (v_shop_id, 'Cooking oil', 1000, 400) returning id into v_prod_oil;
  insert into public.products (shop_id, name, price_cents, cost_cents)
    values (v_shop_id, 'Discontinued', 500, 200) returning id into v_prod_gone;
  insert into public.products (shop_id, name, price_cents, cost_cents)
    values (v_shop_id, 'Huge', 600000000, 1000) returning id into v_prod_huge;
  insert into public.products (shop_id, name, price_cents, cost_cents)
    values (v_shop_id, 'Never ordered', 900, 300) returning id into v_prod_extra;
  insert into public.products (shop_id, name, price_cents, cost_cents)
    values (v_shop_id, 'Big One', 500000000, 1000) returning id into v_prod_big1;
  insert into public.products (shop_id, name, price_cents, cost_cents)
    values (v_shop_id, 'Big Two', 500000000, 1000) returning id into v_prod_big2;
  insert into public.products (shop_id, name, price_cents, cost_cents)
    values (v_shop_id, 'Big Three', 500000000, 1000) returning id into v_prod_big3;

  insert into public.product_location_stock (product_id, location_id, stock)
    values (v_prod_rice, v_loc_id, 100), (v_prod_oil, v_loc_id, 100),
           (v_prod_gone, v_loc_id, 100), (v_prod_huge, v_loc_id, 100),
           (v_prod_extra, v_loc_id, 100);

  -- Every order below is quoted the way place_storefront_order quotes one:
  -- unit_price_cents copied from products.price_cents AS IT WAS, and
  -- subtotal_cents the sum of its own lines (20260927000000:409, :420).
  insert into public.orders (shop_id, customer_name, customer_phone, fulfilment, subtotal_cents, delivery_fee_cents, total_cents)
    values (v_shop_id, 'Pending Customer', '+252634300001', 'collect', 12500, 0, 12500)
    returning id into v_pending_id;
  insert into public.order_items (order_id, product_id, product_name, unit_price_cents, quantity, line_total_cents)
    values (v_pending_id, v_prod_rice, 'Basmati rice', 2500, 5, 12500);

  insert into public.orders (shop_id, customer_name, customer_phone, fulfilment, subtotal_cents, delivery_fee_cents, total_cents)
    values (v_shop_id, 'Accepted Customer', '+252634300002', 'collect', 5000, 0, 5000)
    returning id into v_accepted_id;
  insert into public.order_items (order_id, product_id, product_name, unit_price_cents, quantity, line_total_cents)
    values (v_accepted_id, v_prod_rice, 'Basmati rice', 2500, 2, 5000);

  insert into public.orders (shop_id, customer_name, customer_phone, fulfilment, subtotal_cents, delivery_fee_cents, total_cents)
    values (v_shop_id, 'Completed Customer', '+252634300003', 'collect', 2500, 0, 2500)
    returning id into v_completed_id;
  insert into public.order_items (order_id, product_id, product_name, unit_price_cents, quantity, line_total_cents)
    values (v_completed_id, v_prod_rice, 'Basmati rice', 2500, 1, 2500);

  insert into public.orders (shop_id, customer_name, customer_phone, fulfilment, subtotal_cents, delivery_fee_cents, total_cents)
    values (v_shop_id, 'Cancelled Customer', '+252634300004', 'collect', 2500, 0, 2500)
    returning id into v_cancelled_id;
  insert into public.order_items (order_id, product_id, product_name, unit_price_cents, quantity, line_total_cents)
    values (v_cancelled_id, v_prod_rice, 'Basmati rice', 2500, 1, 2500);

  -- Checks 7a and 8: four bags agreed at 2500. The shop re-prices to 3000
  -- below, and this order is amended to three bags.
  insert into public.orders (shop_id, customer_name, customer_phone, fulfilment, subtotal_cents, delivery_fee_cents, total_cents)
    values (v_shop_id, 'Agreed Customer', '+252634300005', 'collect', 10000, 0, 10000)
    returning id into v_agreed_id;
  insert into public.order_items (order_id, product_id, product_name, unit_price_cents, quantity, line_total_cents)
    values (v_agreed_id, v_prod_rice, 'Basmati rice', 2500, 4, 10000);

  -- Check 7b and 8: identical fixture, amended with p_pricing => 'current'.
  -- The two orders differ ONLY in the pricing mode their amend is given, so a
  -- function that ignored p_pricing would have to fail one of them.
  insert into public.orders (shop_id, customer_name, customer_phone, fulfilment, subtotal_cents, delivery_fee_cents, total_cents)
    values (v_shop_id, 'Current Customer', '+252634300006', 'collect', 10000, 0, 10000)
    returning id into v_current_id;
  insert into public.order_items (order_id, product_id, product_name, unit_price_cents, quantity, line_total_cents)
    values (v_current_id, v_prod_rice, 'Basmati rice', 2500, 4, 10000);

  insert into public.orders (shop_id, customer_name, customer_phone, fulfilment, subtotal_cents, delivery_fee_cents, total_cents)
    values (v_shop_id, 'Zero Customer', '+252634300007', 'collect', 5000, 0, 5000)
    returning id into v_zero_id;
  insert into public.order_items (order_id, product_id, product_name, unit_price_cents, quantity, line_total_cents)
    values (v_zero_id, v_prod_rice, 'Basmati rice', 2500, 2, 5000);

  -- Check 10: two lines, one of which loses its product below.
  insert into public.orders (shop_id, customer_name, customer_phone, fulfilment, subtotal_cents, delivery_fee_cents, total_cents)
    values (v_shop_id, 'Gone Customer', '+252634300008', 'collect', 3000, 0, 3000)
    returning id into v_gone_id;
  insert into public.order_items (order_id, product_id, product_name, unit_price_cents, quantity, line_total_cents)
    values (v_gone_id, v_prod_rice, 'Basmati rice', 2500, 1, 2500),
           (v_gone_id, v_prod_gone, 'Discontinued',  500, 1,  500);

  -- Check 11: a delivery order, 2 x 1000 of goods and a 1500 fee.
  insert into public.orders (shop_id, customer_name, customer_phone, fulfilment, delivery_area, delivery_landmark, subtotal_cents, delivery_fee_cents, total_cents)
    values (v_shop_id, 'Deliver Customer', '+252634300009', 'deliver', 'Xero Awr', 'By the blue gate', 2000, 1500, 3500)
    returning id into v_deliver_id;
  insert into public.order_items (order_id, product_id, product_name, unit_price_cents, quantity, line_total_cents)
    values (v_deliver_id, v_prod_oil, 'Cooking oil', 1000, 2, 2000);

  -- Check 12: a collect order switched TO delivery, so the fee must arrive
  -- from the shop's own area row.
  insert into public.orders (shop_id, customer_name, customer_phone, fulfilment, subtotal_cents, delivery_fee_cents, total_cents)
    values (v_shop_id, 'Collect Customer', '+252634300010', 'collect', 2000, 0, 2000)
    returning id into v_collect_id;
  insert into public.order_items (order_id, product_id, product_name, unit_price_cents, quantity, line_total_cents)
    values (v_collect_id, v_prod_oil, 'Cooking oil', 1000, 2, 2000);

  insert into public.orders (shop_id, customer_name, customer_phone, fulfilment, subtotal_cents, delivery_fee_cents, total_cents)
    values (v_shop_id, 'Permission Customer', '+252634300011', 'collect', 2500, 0, 2500)
    returning id into v_perm_id;
  insert into public.order_items (order_id, product_id, product_name, unit_price_cents, quantity, line_total_cents)
    values (v_perm_id, v_prod_rice, 'Basmati rice', 2500, 1, 2500);

  -- Check 16: one of these is storable (integer) and completable; two of them
  -- is storable and NOT completable, because the agreed price's per-line
  -- ceiling is 1,000,000,000 and 2 x 600,000,000 passes it.
  insert into public.orders (shop_id, customer_name, customer_phone, fulfilment, subtotal_cents, delivery_fee_cents, total_cents)
    values (v_shop_id, 'Huge Customer', '+252634300012', 'collect', 600000000, 0, 600000000)
    returning id into v_huge_id;
  insert into public.order_items (order_id, product_id, product_name, unit_price_cents, quantity, line_total_cents)
    values (v_huge_id, v_prod_huge, 'Huge', 600000000, 1, 600000000);

  insert into public.orders (shop_id, customer_name, customer_phone, fulfilment, subtotal_cents, delivery_fee_cents, total_cents)
    values (v_shop_id, 'Adding Customer', '+252634300013', 'collect', 2500, 0, 2500)
    returning id into v_add_id;
  insert into public.order_items (order_id, product_id, product_name, unit_price_cents, quantity, line_total_cents)
    values (v_add_id, v_prod_rice, 'Basmati rice', 2500, 1, 2500);

  insert into public.orders (shop_id, customer_name, customer_phone, fulfilment, subtotal_cents, delivery_fee_cents, total_cents)
    values (v_shop_id, 'Phone Customer', '+252634300014', 'collect', 2500, 0, 2500)
    returning id into v_phone_id;
  insert into public.order_items (order_id, product_id, product_name, unit_price_cents, quantity, line_total_cents)
    values (v_phone_id, v_prod_rice, 'Basmati rice', 2500, 1, 2500);

  -- Check 20: re-priced once, then amended again at 'agreed'.
  insert into public.orders (shop_id, customer_name, customer_phone, fulfilment, subtotal_cents, delivery_fee_cents, total_cents)
    values (v_shop_id, 'One-way Customer', '+252634300016', 'collect', 10000, 0, 10000)
    returning id into v_oneway_id;
  insert into public.order_items (order_id, product_id, product_name, unit_price_cents, quantity, line_total_cents)
    values (v_oneway_id, v_prod_rice, 'Basmati rice', 2500, 4, 10000);

  -- Check 19: 3 x 500,000,000 = 1,500,000,000, which fits int32 and is a
  -- storable order. Doubling every line does not.
  insert into public.orders (shop_id, customer_name, customer_phone, fulfilment, subtotal_cents, delivery_fee_cents, total_cents)
    values (v_shop_id, 'Big Customer', '+252634300015', 'collect', 1500000000, 0, 1500000000)
    returning id into v_big_id;
  insert into public.order_items (order_id, product_id, product_name, unit_price_cents, quantity, line_total_cents)
    values (v_big_id, v_prod_big1, 'Big One',   500000000, 1, 500000000),
           (v_big_id, v_prod_big2, 'Big Two',   500000000, 1, 500000000),
           (v_big_id, v_prod_big3, 'Big Three', 500000000, 1, 500000000);

  perform set_config('request.jwt.claims', json_build_object('sub', v_owner_id)::text, true);
  perform set_config('role', 'authenticated', true);

  perform public.transition_order(v_accepted_id, 'accepted', null);
  perform public.transition_order(v_completed_id, 'accepted', null);
  perform public.transition_order(v_completed_id, 'ready', null);
  v_sale_id := public.complete_storefront_order(v_completed_id, 'cash');
  perform public.transition_order(v_cancelled_id, 'cancelled', 'customer changed their mind');

  perform set_config('role', 'postgres', true);

  -- ------------------------------------------------ 1. a pending order is rewritten
  perform set_config('role', 'authenticated', true);
  v_order := public.amend_order(
    p_order_id => v_pending_id,
    p_lines    => jsonb_build_array(jsonb_build_object('product_id', v_prod_rice, 'quantity', 3)),
    p_reason   => 'only three bags on the shelf');
  perform set_config('role', 'postgres', true);

  if v_order.id <> v_pending_id then
    raise exception 'FAIL 1: amend_order returned order % for %', v_order.id, v_pending_id;
  end if;
  -- 3 x the agreed 2500. The returned ROW is asserted, not a re-read, because
  -- the client renders what it returns.
  if v_order.subtotal_cents <> 7500 or v_order.total_cents <> 7500 then
    raise exception 'FAIL 1: the returned row says subtotal % / total % -- expected 7500 / 7500',
      v_order.subtotal_cents, v_order.total_cents;
  end if;
  select count(*) into v_count
    from public.order_items where order_id = v_pending_id;
  if v_count <> 1 then
    raise exception 'FAIL 1: the amended order has % lines -- expected 1', v_count;
  end if;
  select quantity, line_total_cents into v_count, v_amount
    from public.order_items where order_id = v_pending_id;
  if v_count <> 3 or v_amount <> 7500 then
    raise exception 'FAIL 1: the line is % x, totalling % -- expected 3 x, 7500', v_count, v_amount;
  end if;
  select status into v_text from public.orders where id = v_pending_id;
  if v_text <> 'pending' then
    raise exception 'FAIL 1: amending moved the status to % -- an amend is not a transition', v_text;
  end if;

  -- ------------------------------------------------ 2. an accepted order is amendable
  perform set_config('role', 'authenticated', true);
  v_order := public.amend_order(
    p_order_id => v_accepted_id,
    p_lines    => jsonb_build_array(jsonb_build_object('product_id', v_prod_rice, 'quantity', 1)),
    p_reason   => 'customer wants one');
  perform set_config('role', 'postgres', true);
  if v_order.subtotal_cents <> 2500 then
    raise exception 'FAIL 2: an accepted order amended to subtotal % -- expected 2500', v_order.subtotal_cents;
  end if;
  select status into v_text from public.orders where id = v_accepted_id;
  if v_text <> 'accepted' then
    raise exception 'FAIL 2: the status moved to % -- expected it to stay accepted', v_text;
  end if;

  -- ------------------------------------------------ 3. a completed order is not amendable
  perform set_config('role', 'authenticated', true);
  begin
    perform public.amend_order(
      p_order_id => v_completed_id,
      p_lines    => jsonb_build_array(jsonb_build_object('product_id', v_prod_rice, 'quantity', 1)),
      p_reason   => 'too late');
    raise exception 'FAIL 3: amending a completed order was allowed -- it has a sale posted against it';
  exception
    when others then
      if sqlerrm <> 'order_not_amendable' then raise; end if;
  end;
  perform set_config('role', 'postgres', true);

  -- ------------------------------------------------ 4. a cancelled order is not amendable
  perform set_config('role', 'authenticated', true);
  begin
    perform public.amend_order(
      p_order_id => v_cancelled_id,
      p_lines    => jsonb_build_array(jsonb_build_object('product_id', v_prod_rice, 'quantity', 1)),
      p_reason   => 'too late');
    raise exception 'FAIL 4: amending a cancelled order was allowed';
  exception
    when others then
      if sqlerrm <> 'order_not_amendable' then raise; end if;
  end;
  perform set_config('role', 'postgres', true);

  -- ------------------------------------------------ 5. the reason is required
  perform set_config('role', 'authenticated', true);
  begin
    perform public.amend_order(
      p_order_id => v_pending_id,
      p_lines    => jsonb_build_array(jsonb_build_object('product_id', v_prod_rice, 'quantity', 2)),
      p_reason   => '   ');
    raise exception 'FAIL 5: a whitespace-only reason was accepted';
  exception
    when others then
      if sqlerrm <> 'amendment_reason_required' then raise; end if;
  end;
  -- And null, which is a different code path from a blank string.
  begin
    perform public.amend_order(
      p_order_id => v_pending_id,
      p_lines    => jsonb_build_array(jsonb_build_object('product_id', v_prod_rice, 'quantity', 2)),
      p_reason   => null);
    raise exception 'FAIL 5: a null reason was accepted';
  exception
    when others then
      if sqlerrm <> 'amendment_reason_required' then raise; end if;
  end;
  perform set_config('role', 'postgres', true);

  -- ------------------------------------------------ 6. total = subtotal + delivery, arithmetically
  --
  -- Read BACK off the row rather than trusting orders_total_is_subtotal_plus_
  -- delivery to have fired: a function that wrote a consistent pair of wrong
  -- numbers satisfies the constraint and fails here.
  perform set_config('role', 'authenticated', true);
  v_order := public.amend_order(
    p_order_id => v_deliver_id,
    p_lines    => jsonb_build_array(jsonb_build_object('product_id', v_prod_oil, 'quantity', 1)),
    p_reason   => 'one bottle left');
  perform set_config('role', 'postgres', true);
  if v_order.total_cents <> v_order.subtotal_cents + v_order.delivery_fee_cents then
    raise exception 'FAIL 6: % <> % + %',
      v_order.total_cents, v_order.subtotal_cents, v_order.delivery_fee_cents;
  end if;
  -- The fee SURVIVED an amend that did not mention fulfilment. A function
  -- that zeroed it would still satisfy the arithmetic above.
  if v_order.delivery_fee_cents <> 1500 then
    raise exception 'FAIL 6: the delivery fee is now % -- an amend of the lines must not move it', v_order.delivery_fee_cents;
  end if;
  if v_order.subtotal_cents <> 1000 or v_order.total_cents <> 2500 then
    raise exception 'FAIL 6: subtotal % / total % -- expected 1000 / 2500',
      v_order.subtotal_cents, v_order.total_cents;
  end if;

  -- ══════════════ THE SHOP RE-PRICES. Everything below is after the fact. ══
  update public.products set price_cents = 3000 where id = v_prod_rice;

  -- ------------------------------------------------ 7a. the default honours the agreed price
  perform set_config('role', 'authenticated', true);
  v_order := public.amend_order(
    p_order_id => v_agreed_id,
    p_lines    => jsonb_build_array(jsonb_build_object('product_id', v_prod_rice, 'quantity', 3)),
    p_reason   => 'one bag short');
  perform set_config('role', 'postgres', true);
  -- 3 x 2500 = 7500, the price the customer agreed to. NOT 3 x 3000 = 9000.
  -- The two figures are 1500 apart, so an implementation that re-priced by
  -- default cannot pass this by arithmetic coincidence.
  if v_order.subtotal_cents <> 7500 then
    raise exception 'FAIL 7a: the amended subtotal is % -- expected 7500 (3 x the agreed 2500), not 9000 (3 x today''s 3000)',
      v_order.subtotal_cents;
  end if;
  select unit_price_cents into v_amount from public.order_items where order_id = v_agreed_id;
  if v_amount <> 2500 then
    raise exception 'FAIL 7a: the line is filed at % -- the customer agreed to 2500', v_amount;
  end if;

  -- ------------------------------------------------ 7b. the shop may choose today's price
  perform set_config('role', 'authenticated', true);
  v_order := public.amend_order(
    p_order_id => v_current_id,
    p_lines    => jsonb_build_array(jsonb_build_object('product_id', v_prod_rice, 'quantity', 3)),
    p_reason   => 'one bag short, re-priced',
    p_pricing  => 'current');
  perform set_config('role', 'postgres', true);
  if v_order.subtotal_cents <> 9000 then
    raise exception 'FAIL 7b: p_pricing => current gave subtotal % -- expected 9000 (3 x today''s 3000)',
      v_order.subtotal_cents;
  end if;
  select unit_price_cents into v_amount from public.order_items where order_id = v_current_id;
  if v_amount <> 3000 then
    raise exception 'FAIL 7b: the line is filed at % -- expected today''s 3000', v_amount;
  end if;
  -- An unknown mode is refused rather than silently falling back to one of
  -- them. Without this, a typo in the client picks a price for the customer.
  perform set_config('role', 'authenticated', true);
  begin
    perform public.amend_order(
      p_order_id => v_pending_id,
      p_lines    => jsonb_build_array(jsonb_build_object('product_id', v_prod_rice, 'quantity', 1)),
      p_reason   => 'typo in the mode',
      p_pricing  => 'todays');
    raise exception 'FAIL 7b: an unknown pricing mode was accepted';
  exception
    when others then
      if sqlerrm <> 'invalid_pricing' then raise; end if;
  end;
  perform set_config('role', 'postgres', true);

  -- ------------------------------------------------ 8. an amended order still completes
  --
  -- BOTH pricing modes. order_total_changed now fires only when the order row
  -- disagrees with its own lines (20261011000000:1477), which is precisely
  -- what an amend that wrote one and not the other would produce.
  perform set_config('role', 'authenticated', true);
  perform public.transition_order(v_agreed_id, 'accepted', null);
  perform public.transition_order(v_agreed_id, 'ready', null);
  v_sale_id := public.complete_storefront_order(v_agreed_id, 'cash');
  perform set_config('role', 'postgres', true);
  if v_sale_id is null then
    raise exception 'FAIL 8: completing an amended (agreed-price) order returned no sale id';
  end if;
  select total_cents into v_amount from public.sales where id = v_sale_id;
  if v_amount <> 7500 then
    raise exception 'FAIL 8: the sale totals % -- the amended order says 7500', v_amount;
  end if;

  perform set_config('role', 'authenticated', true);
  perform public.transition_order(v_current_id, 'accepted', null);
  perform public.transition_order(v_current_id, 'ready', null);
  v_sale_id := public.complete_storefront_order(v_current_id, 'cash');
  perform set_config('role', 'postgres', true);
  if v_sale_id is null then
    raise exception 'FAIL 8: completing an amended (re-priced) order returned no sale id';
  end if;
  select total_cents into v_amount from public.sales where id = v_sale_id;
  if v_amount <> 9000 then
    raise exception 'FAIL 8: the re-priced sale totals % -- the amended order says 9000', v_amount;
  end if;

  -- ------------------------------------------------ 9. an order cannot be emptied
  perform set_config('role', 'authenticated', true);
  begin
    perform public.amend_order(
      p_order_id => v_zero_id,
      p_lines    => jsonb_build_array(jsonb_build_object('product_id', v_prod_rice, 'quantity', 0)),
      p_reason   => 'nothing left at all');
    raise exception 'FAIL 9: reducing every line to zero left an order with no items';
  exception
    when others then
      if sqlerrm <> 'order_has_no_items' then raise; end if;
  end;
  -- An empty array is the same question asked a second way.
  begin
    perform public.amend_order(
      p_order_id => v_zero_id,
      p_lines    => '[]'::jsonb,
      p_reason   => 'nothing left at all');
    raise exception 'FAIL 9: an empty lines array emptied the order';
  exception
    when others then
      if sqlerrm <> 'order_has_no_items' then raise; end if;
  end;
  perform set_config('role', 'postgres', true);
  -- The refused amend left the order exactly as it was.
  select sum(quantity) into v_amount from public.order_items where order_id = v_zero_id;
  if v_amount <> 2 then
    raise exception 'FAIL 9: the refused amend still changed the order -- % units remain, expected 2', v_amount;
  end if;

  -- ------------------------------------------------ 10. a deleted product's line
  delete from public.products where id = v_prod_gone;
  select count(*) into v_count
    from public.order_items where order_id = v_gone_id and product_id is null;
  if v_count <> 1 then
    raise exception 'FAIL 10: the fixture is wrong -- % null-product lines after the delete, expected 1', v_count;
  end if;

  -- Naming it is refused. A kept line with no product is an order
  -- complete_storefront_order will not hand over.
  perform set_config('role', 'authenticated', true);
  begin
    perform public.amend_order(
      p_order_id => v_gone_id,
      p_lines    => jsonb_build_array(
                      jsonb_build_object('product_id', v_prod_rice, 'quantity', 1),
                      jsonb_build_object('product_id', null, 'quantity', 1)),
      p_reason   => 'keeping the dead line');
    raise exception 'FAIL 10: a line with no product was kept';
  exception
    when others then
      if sqlerrm <> 'order_product_deleted' then raise; end if;
  end;

  -- Omitting it removes it, and the order survives.
  v_order := public.amend_order(
    p_order_id => v_gone_id,
    p_lines    => jsonb_build_array(jsonb_build_object('product_id', v_prod_rice, 'quantity', 1)),
    p_reason   => 'dropping the discontinued line');
  perform set_config('role', 'postgres', true);
  select count(*) into v_count from public.order_items where order_id = v_gone_id;
  if v_count <> 1 then
    raise exception 'FAIL 10: % lines survived -- expected the deleted-product line to be gone', v_count;
  end if;
  if v_order.subtotal_cents <> 2500 then
    raise exception 'FAIL 10: subtotal % after dropping the 500 line -- expected 2500', v_order.subtotal_cents;
  end if;

  -- ------------------------------------------------ 11. deliver -> collect zeroes fee AND area
  perform set_config('role', 'authenticated', true);
  v_order := public.amend_order(
    p_order_id   => v_deliver_id,
    p_lines      => jsonb_build_array(jsonb_build_object('product_id', v_prod_oil, 'quantity', 1)),
    p_reason     => 'customer will collect after all',
    p_fulfilment => jsonb_build_object('fulfilment', 'collect'));
  perform set_config('role', 'postgres', true);
  if v_order.fulfilment <> 'collect' then
    raise exception 'FAIL 11: fulfilment is % -- expected collect', v_order.fulfilment;
  end if;
  if v_order.delivery_fee_cents <> 0 then
    raise exception 'FAIL 11: a collect order still carries a % fee', v_order.delivery_fee_cents;
  end if;
  if v_order.delivery_area is not null then
    raise exception 'FAIL 11: a collect order still names the area %', v_order.delivery_area;
  end if;
  if v_order.total_cents <> 1000 then
    raise exception 'FAIL 11: total % -- expected 1000 with the fee gone', v_order.total_cents;
  end if;

  -- ------------------------------------------------ 12. collect -> deliver prices the fee from the shop's row
  perform set_config('role', 'authenticated', true);
  v_order := public.amend_order(
    p_order_id   => v_collect_id,
    p_lines      => jsonb_build_array(jsonb_build_object('product_id', v_prod_oil, 'quantity', 2)),
    p_reason     => 'customer asked for delivery',
    p_fulfilment => jsonb_build_object('fulfilment', 'deliver', 'delivery_area', 'Xero Awr', 'delivery_landmark', 'Behind the mosque'));
  perform set_config('role', 'postgres', true);
  -- 1500 is the SHOP's fee for that area, and no caller named it.
  if v_order.delivery_fee_cents <> 1500 then
    raise exception 'FAIL 12: the fee is % -- expected the shop''s own 1500 for Xero Awr', v_order.delivery_fee_cents;
  end if;
  if v_order.delivery_area <> 'Xero Awr' or v_order.delivery_landmark <> 'Behind the mosque' then
    raise exception 'FAIL 12: area % / landmark %', v_order.delivery_area, v_order.delivery_landmark;
  end if;
  if v_order.total_cents <> 3500 then
    raise exception 'FAIL 12: total % -- expected 2000 + 1500', v_order.total_cents;
  end if;
  -- An area this shop never published is refused, not silently priced at zero.
  perform set_config('role', 'authenticated', true);
  begin
    perform public.amend_order(
      p_order_id   => v_collect_id,
      p_lines      => jsonb_build_array(jsonb_build_object('product_id', v_prod_oil, 'quantity', 2)),
      p_reason     => 'somewhere else entirely',
      p_fulfilment => jsonb_build_object('fulfilment', 'deliver', 'delivery_area', 'Atlantis'));
    raise exception 'FAIL 12: an unpublished delivery area was accepted';
  exception
    when others then
      if sqlerrm <> 'unknown_delivery_area' then raise; end if;
  end;
  perform set_config('role', 'postgres', true);

  -- ------------------------------------------------ 13. the amendment is recorded
  select count(*) into v_count from public.order_amendments where order_id = v_agreed_id;
  if v_count <> 1 then
    raise exception 'FAIL 13: % amendment rows for the agreed-price order -- expected 1', v_count;
  end if;
  select reason, before, after, pricing
    into v_text, v_before, v_after, v_msg
    from public.order_amendments where order_id = v_agreed_id;
  if v_text <> 'one bag short' then
    raise exception 'FAIL 13: the recorded reason is % -- expected the one that was passed', quote_literal(v_text);
  end if;
  if v_msg <> 'agreed' then
    raise exception 'FAIL 13: the recorded pricing mode is % -- expected agreed', quote_literal(v_msg);
  end if;
  if v_before = v_after then
    raise exception 'FAIL 13: before and after are identical -- the row records nothing';
  end if;
  -- The before/after are about THIS order's money, not an empty envelope.
  if (v_before->>'subtotal_cents')::integer <> 10000 then
    raise exception 'FAIL 13: before says subtotal % -- expected the pre-amend 10000', v_before->>'subtotal_cents';
  end if;
  if (v_after->>'subtotal_cents')::integer <> 7500 then
    raise exception 'FAIL 13: after says subtotal % -- expected the post-amend 7500', v_after->>'subtotal_cents';
  end if;
  -- The re-priced one recorded the other mode, so the column discriminates.
  select pricing into v_msg from public.order_amendments where order_id = v_current_id;
  if v_msg <> 'current' then
    raise exception 'FAIL 13: the re-priced amend recorded pricing % -- expected current', quote_literal(v_msg);
  end if;
  -- amended_by is the member who did it, not the table owner.
  select amended_by into v_text from public.order_amendments where order_id = v_agreed_id;
  if v_text::uuid <> v_owner_id then
    raise exception 'FAIL 13: amended_by is % -- expected the acting member', v_text;
  end if;

  -- ------------------------------------------------ 14. membership and permission
  perform set_config('request.jwt.claims', json_build_object('sub', v_stranger_id)::text, true);
  perform set_config('role', 'authenticated', true);
  begin
    perform public.amend_order(
      p_order_id => v_perm_id,
      p_lines    => jsonb_build_array(jsonb_build_object('product_id', v_prod_rice, 'quantity', 1)),
      p_reason   => 'not my shop');
    raise exception 'FAIL 14: a non-member amended another shop''s order';
  exception
    when others then
      if sqlerrm not in ('not_authorized', 'order_not_found') then raise; end if;
  end;

  perform set_config('request.jwt.claims', json_build_object('sub', v_clerk_id)::text, true);
  begin
    perform public.amend_order(
      p_order_id => v_perm_id,
      p_lines    => jsonb_build_array(jsonb_build_object('product_id', v_prod_rice, 'quantity', 1)),
      p_reason   => 'no permission to do this');
    raise exception 'FAIL 14: a member without sales.edit amended an order';
  exception
    when others then
      if sqlerrm <> 'sales_edit_required' then raise; end if;
  end;

  -- And the member who DOES hold it succeeds -- without this the check above
  -- would pass against a function that refused everyone.
  perform set_config('request.jwt.claims', json_build_object('sub', v_editor_id)::text, true);
  v_order := public.amend_order(
    p_order_id => v_perm_id,
    p_lines    => jsonb_build_array(jsonb_build_object('product_id', v_prod_rice, 'quantity', 1)),
    p_reason   => 'a permitted member may amend');
  if v_order.id <> v_perm_id then
    raise exception 'FAIL 14: the permitted member got order % back', v_order.id;
  end if;
  perform set_config('role', 'postgres', true);
  select amended_by into v_text from public.order_amendments where order_id = v_perm_id;
  if v_text::uuid <> v_editor_id then
    raise exception 'FAIL 14: amended_by is % -- expected the editor who called it', v_text;
  end if;
  perform set_config('request.jwt.claims', json_build_object('sub', v_owner_id)::text, true);

  -- ------------------------------------------------ 15. the lockdown is intact
  --
  -- Proven against Postgres rather than read off a grant table, the same way
  -- verify-orders checks 14/15 do it.
  perform set_config('role', 'authenticated', true);
  begin
    update public.orders set subtotal_cents = 1 where id = v_perm_id;
    raise exception 'FAIL 15: authenticated updated orders directly -- the write lockdown is gone';
  exception
    when insufficient_privilege then null;
    when others then
      if sqlerrm like 'FAIL 15%' then raise; end if;
  end;
  begin
    update public.order_items set quantity = 99 where order_id = v_perm_id;
    raise exception 'FAIL 15: authenticated updated order_items directly';
  exception
    when insufficient_privilege then null;
    when others then
      if sqlerrm like 'FAIL 15%' then raise; end if;
  end;
  -- And the amendment log itself is not writable by a caller.
  begin
    insert into public.order_amendments (order_id, amended_by, reason, pricing, before, after)
      values (v_perm_id, v_owner_id, 'forged', 'agreed', '{}'::jsonb, '{}'::jsonb);
    raise exception 'FAIL 15: authenticated wrote an amendment row directly';
  exception
    when insufficient_privilege then null;
    when others then
      if sqlerrm like 'FAIL 15%' then raise; end if;
  end;
  perform set_config('role', 'postgres', true);

  -- ------------------------------------------------ 16. the per-line ceiling is enforced here
  --
  -- 2 x 600,000,000 stores fine (order_items.line_total_cents is `integer`)
  -- and is refused by complete_sale as an agreed price over c_max_line_cents
  -- (20260929000050). Catching it at amend time is the difference between a
  -- sentence in the amend sheet and a failure at the till.
  perform set_config('role', 'authenticated', true);
  begin
    perform public.amend_order(
      p_order_id => v_huge_id,
      p_lines    => jsonb_build_array(jsonb_build_object('product_id', v_prod_huge, 'quantity', 2)),
      p_reason   => 'doubling a very expensive line');
    raise exception 'FAIL 16: a line over the agreed-price ceiling was accepted';
  exception
    when others then
      if sqlerrm <> 'order_line_out_of_range' then raise; end if;
  end;
  -- One of them is still fine, so the bound is a ceiling and not a ban.
  v_order := public.amend_order(
    p_order_id => v_huge_id,
    p_lines    => jsonb_build_array(jsonb_build_object('product_id', v_prod_huge, 'quantity', 1)),
    p_reason   => 'leaving it at one');
  perform set_config('role', 'postgres', true);
  if v_order.subtotal_cents <> 600000000 then
    raise exception 'FAIL 16: a single huge line came to % -- expected 600000000', v_order.subtotal_cents;
  end if;

  -- ------------------------------------------------ 17. an amend may not add a product
  perform set_config('role', 'authenticated', true);
  begin
    perform public.amend_order(
      p_order_id => v_add_id,
      p_lines    => jsonb_build_array(
                      jsonb_build_object('product_id', v_prod_rice, 'quantity', 1),
                      jsonb_build_object('product_id', v_prod_extra, 'quantity', 1)),
      p_reason   => 'slipping in something they never ordered');
    raise exception 'FAIL 17: an amend added a product the customer never ordered';
  exception
    when others then
      if sqlerrm <> 'order_line_not_in_order' then raise; end if;
  end;
  perform set_config('role', 'postgres', true);
  select count(*) into v_count from public.order_items where order_id = v_add_id;
  if v_count <> 1 then
    raise exception 'FAIL 17: the refused amend still wrote lines -- % remain, expected 1', v_count;
  end if;

  -- ------------------------------------------------ 18. the contact is validated here
  perform set_config('role', 'authenticated', true);
  begin
    perform public.amend_order(
      p_order_id => v_phone_id,
      p_lines    => jsonb_build_array(jsonb_build_object('product_id', v_prod_rice, 'quantity', 1)),
      p_reason   => 'fixing the number',
      p_contact  => jsonb_build_object('customer_name', 'Fixed Name', 'customer_phone', '0634300014'));
    raise exception 'FAIL 18: a non-E.164 phone number was accepted';
  exception
    when others then
      if sqlerrm <> 'invalid_contact' then raise; end if;
  end;
  -- The correction itself lands.
  v_order := public.amend_order(
    p_order_id => v_phone_id,
    p_lines    => jsonb_build_array(jsonb_build_object('product_id', v_prod_rice, 'quantity', 1)),
    p_reason   => 'fixing the number',
    p_contact  => jsonb_build_object('customer_name', 'Fixed Name', 'customer_phone', '+252634399999'));
  perform set_config('role', 'postgres', true);
  if v_order.customer_phone <> '+252634399999' or v_order.customer_name <> 'Fixed Name' then
    raise exception 'FAIL 18: the contact is % / %', v_order.customer_name, v_order.customer_phone;
  end if;

  -- ------------------------------------------------ 19. the subtotal cannot overflow int32
  --
  -- Every line here is exactly ON the per-line ceiling and therefore allowed,
  -- so check 16's guard cannot be what refuses this. What refuses it is the
  -- sum, and without a guard the refusal is a bare `integer out of range`
  -- from inside the function rather than a code the sheet can render.
  perform set_config('role', 'authenticated', true);
  begin
    perform public.amend_order(
      p_order_id => v_big_id,
      p_lines    => jsonb_build_array(
                      jsonb_build_object('product_id', v_prod_big1, 'quantity', 2),
                      jsonb_build_object('product_id', v_prod_big2, 'quantity', 2),
                      jsonb_build_object('product_id', v_prod_big3, 'quantity', 2)),
      p_reason   => 'three lines that each fit and together do not');
    raise exception 'FAIL 19: a subtotal past int32 was accepted';
  exception
    when others then
      if sqlerrm <> 'order_total_out_of_range' then raise; end if;
  end;
  perform set_config('role', 'postgres', true);
  select subtotal_cents into v_amount from public.orders where id = v_big_id;
  if v_amount <> 1500000000 then
    raise exception 'FAIL 19: the refused amend moved the subtotal to %', v_amount;
  end if;

  -- ------------------------------------------------ 20. re-pricing is a one-way door
  --
  -- PINNED BECAUSE THE NAMES SUGGEST OTHERWISE. 'agreed' means "keep the
  -- prices on this order", and order_items.unit_price_cents is the only place
  -- those live -- so once a 'current' amend has rewritten it, a later
  -- 'agreed' amend keeps TODAY's price rather than restoring the original
  -- quote. Found by driving the real RPC over PostgREST, where an amend back
  -- to 'agreed' read 9000 and not the 7500 the name implies.
  --
  -- This is correct for a function whose contract is "the order's own numbers
  -- are authoritative", and order_amendments.before keeps every earlier state
  -- readable. It is asserted so that a future change quietly turning 'agreed'
  -- into "restore the original" has to come past this check and the two
  -- sentences of UI copy that promise otherwise.
  perform set_config('role', 'authenticated', true);
  v_order := public.amend_order(
    p_order_id => v_oneway_id,
    p_lines    => jsonb_build_array(jsonb_build_object('product_id', v_prod_rice, 'quantity', 2)),
    p_reason   => 'the shop re-prices',
    p_pricing  => 'current');
  if v_order.subtotal_cents <> 6000 then
    raise exception 'FAIL 20: the re-price gave % -- expected 6000 (2 x today''s 3000)', v_order.subtotal_cents;
  end if;
  v_order := public.amend_order(
    p_order_id => v_oneway_id,
    p_lines    => jsonb_build_array(jsonb_build_object('product_id', v_prod_rice, 'quantity', 2)),
    p_reason   => 'and back again');
  perform set_config('role', 'postgres', true);
  -- 6000, NOT 5000. The two figures are 1000 apart, so this cannot pass by
  -- coincidence whichever way the implementation goes.
  if v_order.subtotal_cents <> 6000 then
    raise exception 'FAIL 20: amending back at the agreed price gave % -- the order''s own price is now 3000, so 6000 was expected, not the original quote',
      v_order.subtotal_cents;
  end if;
  -- ...and the original is still readable, which is what makes the one-way
  -- door acceptable rather than a loss.
  --
  -- Asserted as "a row remembers 10000", NOT as "the earliest row does".
  -- amended_at defaults to now(), which is TRANSACTION time, so two amends
  -- inside this one DO block carry an identical timestamp and `order by
  -- amended_at limit 1` picked between them arbitrarily -- it returned the
  -- second one on the first run of this check. In production each amend is
  -- its own transaction and the ordering is real; here the property that
  -- matters is that the figure survives at all.
  select count(*) into v_count
    from public.order_amendments
   where order_id = v_oneway_id and (before->>'subtotal_cents')::integer = 10000;
  if v_count <> 1 then
    raise exception 'FAIL 20: % amendment rows remember the pre-amend 10000 -- expected exactly 1', v_count;
  end if;

  raise notice 'PASS: order amendments';
  raise exception 'rollback_marker';
exception
  when others then
    if sqlerrm = 'rollback_marker' then
      raise notice 'verify-order-amendments: all checks passed, rolled back';
    else
      raise;
    end if;
end $$;
