-- orders and order_items: the schema a customer's cart lands in.
--
-- Same shape as verify-storefront.sql -- one DO block, EXCEPTION rolls
-- everything back, so it leaves no rows behind.
--
-- What this checks, and why each one is here:
--   1/2. the per-shop number starts at 1 and increments -- proven by inserting
--        twice for the same shop, then once for a second shop to prove the
--        counter is per-shop, not global.
--   3.   the anti-collision constraint that backs the number, isolated from
--        the trigger that would otherwise make it un-forceable -- same
--        disable-trigger technique verify-balances.sql uses at line 1242.
--   4/5. a negative quantity is rejected, and a positive one round-trips.
--   6.   the snapshot pattern: deleting a product null-safes order_items and
--        keeps the name/price it sold at, same as sale_items.
--   7/8. payment_mode is COPIED from storefronts at insert -- a client value
--        is silently overridden, then (trigger disabled) the CHECK behind it
--        is proven for real, same disable-trigger technique as check 3.
--   9/10. fulfilment <-> delivery_area/fee agreement.
--   11.  total_cents must equal subtotal + delivery -- the arithmetic
--        invariant a broken checkout would otherwise violate silently.
--   12.  status starts 'pending' and is CHECK-constrained.
--   13.  customer_phone must be E.164.
--   14/15. the grants this whole feature has twice shipped without: anon gets
--        nothing, authenticated gets select+insert on both tables, and (belt
--        and braces, matching verify-storefront.sql's own check 8) anon is
--        actually refused by Postgres, not merely un-granted on paper.
--   16.  orders_module (20260926000050_orders.sql) refuses an insert for a
--        shop whose plan does not include the storefront module -- otherwise
--        the trigger's existence is only implied by every test shop here
--        happening to be on a plan that carries it.

\set ON_ERROR_STOP on

do $$
declare
  v_user_id    uuid := gen_random_uuid();
  v_shop_id    uuid;
  v_shop2_id   uuid;
  v_product_id uuid;
  v_order1_id  uuid;
  v_number     integer;
  v_payment_mode text;
  v_raised     boolean;
  v_free_id    uuid;
begin
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
    values (v_user_id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            'verify-orders-' || v_user_id || '@example.test', '', now(), now(), now());

  insert into public.shops (owner_id, name) values (v_user_id, 'Xamdi Electronics') returning id into v_shop_id;
  insert into public.shops (owner_id, name) values (v_user_id, 'Second Branch') returning id into v_shop2_id;

  insert into public.storefronts (shop_id) values (v_shop_id);
  insert into public.storefronts (shop_id) values (v_shop2_id);

  -- ------------------------------------------------ 1. a shop's first order is number 1
  insert into public.orders (shop_id, customer_name, customer_phone, fulfilment, subtotal_cents, total_cents)
    values (v_shop_id, 'Ahmed', '+252634000001', 'collect', 1000, 1000)
    returning id, number into v_order1_id, v_number;
  if v_number <> 1 then
    raise exception 'FAIL: a shop''s first order was not number 1 (got %)', v_number;
  end if;

  -- ------------------------------------------------ 2. the same shop's second order increments
  insert into public.orders (shop_id, customer_name, customer_phone, fulfilment, subtotal_cents, total_cents)
    values (v_shop_id, 'Hodan', '+252634000002', 'collect', 500, 500)
    returning number into v_number;
  if v_number <> 2 then
    raise exception 'FAIL: a shop''s second order was not number 2 (got %)', v_number;
  end if;

  -- a second shop starts its own numbering at 1 -- proves the counter is
  -- per-shop, not a single global sequence shared across tenants.
  insert into public.orders (shop_id, customer_name, customer_phone, fulfilment, subtotal_cents, total_cents)
    values (v_shop2_id, 'Faisal', '+252634000003', 'collect', 700, 700)
    returning number into v_number;
  if v_number <> 1 then
    raise exception 'FAIL: a second shop did not start its own numbering at 1 (got %) -- numbering is global, not per-shop', v_number;
  end if;

  -- ------------------------------------------------ 3. two orders for one shop cannot hold the same number
  -- The trigger that assigns `number` always wins, so the only way to reach
  -- the constraint behind it is to turn the trigger off and force a
  -- duplicate by hand -- proving unique(shop_id, number) is real, not just
  -- something the trigger happens to never violate.
  alter table public.orders disable trigger orders_assign_number;
  v_raised := false;
  begin
    insert into public.orders (shop_id, number, customer_name, customer_phone, fulfilment, subtotal_cents, total_cents)
      values (v_shop_id, 1, 'Duplicate', '+252634000004', 'collect', 100, 100);
  exception when unique_violation then v_raised := true;
  end;
  alter table public.orders enable trigger orders_assign_number;
  if not v_raised then
    raise exception 'FAIL: two orders for the same shop were allowed to hold the same number';
  end if;

  -- ------------------------------------------------ 4. a negative quantity is rejected
  v_raised := false;
  begin
    insert into public.order_items (order_id, product_name, unit_price_cents, quantity, line_total_cents)
      values (v_order1_id, 'Widget', 100, -1, -100);
  exception when check_violation then v_raised := true;
  end;
  if not v_raised then
    raise exception 'FAIL: a negative quantity order_item was accepted';
  end if;

  -- ------------------------------------------------ 5. a positive quantity round-trips
  insert into public.order_items (order_id, product_name, unit_price_cents, quantity, line_total_cents)
    values (v_order1_id, 'Widget', 100, 3, 300);
  if (select quantity from public.order_items where order_id = v_order1_id and product_name = 'Widget') <> 3 then
    raise exception 'FAIL: order_item quantity did not round-trip';
  end if;

  -- ------------------------------------------------ 6. the snapshot survives the product being deleted
  insert into public.products (shop_id, name, price_cents, stock)
    values (v_shop_id, 'Snapshot Widget', 250, 10) returning id into v_product_id;
  insert into public.order_items (order_id, product_id, product_name, unit_price_cents, quantity, line_total_cents)
    values (v_order1_id, v_product_id, 'Snapshot Widget', 250, 2, 500);

  delete from public.products where id = v_product_id;

  if (select product_id from public.order_items where order_id = v_order1_id and product_name = 'Snapshot Widget') is not null then
    raise exception 'FAIL: order_item.product_id was not null-ed when its product was deleted';
  end if;
  if (select unit_price_cents from public.order_items where order_id = v_order1_id and product_name = 'Snapshot Widget') <> 250 then
    raise exception 'FAIL: order_item lost its price snapshot when the product was deleted';
  end if;

  -- ------------------------------------------------ 7. payment_mode is copied, not accepted from the caller
  insert into public.orders (shop_id, customer_name, customer_phone, fulfilment, payment_mode, subtotal_cents, total_cents)
    values (v_shop_id, 'Sneaky', '+252634000005', 'collect', 'online', 100, 100)
    returning payment_mode into v_payment_mode;
  if v_payment_mode <> 'on_collection' then
    raise exception 'FAIL: a client-supplied payment_mode overrode the storefront''s value (got %)', v_payment_mode;
  end if;

  -- ------------------------------------------------ 8. the CHECK behind it, isolated the same way as check 3
  alter table public.orders disable trigger orders_copy_payment_mode;
  v_raised := false;
  begin
    insert into public.orders (shop_id, customer_name, customer_phone, fulfilment, payment_mode, subtotal_cents, total_cents)
      values (v_shop_id, 'Sneaky2', '+252634000006', 'collect', 'online', 100, 100);
  exception when check_violation then v_raised := true;
  end;
  alter table public.orders enable trigger orders_copy_payment_mode;
  if not v_raised then
    raise exception 'FAIL: payment_mode ''online'' was accepted before online payment exists';
  end if;

  -- ------------------------------------------------ 9. a collect order cannot carry a delivery area or fee
  v_raised := false;
  begin
    insert into public.orders (shop_id, customer_name, customer_phone, fulfilment, delivery_area, subtotal_cents, total_cents)
      values (v_shop_id, 'X', '+252634000007', 'collect', 'Some Area', 100, 100);
  exception when check_violation then v_raised := true;
  end;
  if not v_raised then
    raise exception 'FAIL: a collect order was allowed to carry a delivery area';
  end if;

  -- ------------------------------------------------ 10. a deliver order must name an area
  v_raised := false;
  begin
    insert into public.orders (shop_id, customer_name, customer_phone, fulfilment, subtotal_cents, total_cents)
      values (v_shop_id, 'X', '+252634000008', 'deliver', 100, 100);
  exception when check_violation then v_raised := true;
  end;
  if not v_raised then
    raise exception 'FAIL: a deliver order without a delivery area was accepted';
  end if;

  -- ------------------------------------------------ 11. total must equal subtotal + delivery fee
  v_raised := false;
  begin
    insert into public.orders (shop_id, customer_name, customer_phone, fulfilment, subtotal_cents, delivery_fee_cents, total_cents)
      values (v_shop_id, 'X', '+252634000009', 'collect', 100, 0, 999);
  exception when check_violation then v_raised := true;
  end;
  if not v_raised then
    raise exception 'FAIL: total_cents that does not equal subtotal + delivery was accepted';
  end if;

  -- ------------------------------------------------ 12. status starts pending and is constrained
  if (select status from public.orders where id = v_order1_id) <> 'pending' then
    raise exception 'FAIL: a new order''s default status is not pending';
  end if;
  v_raised := false;
  begin
    update public.orders set status = 'made_up_status' where id = v_order1_id;
  exception when check_violation then v_raised := true;
  end;
  if not v_raised then
    raise exception 'FAIL: an unknown status was accepted';
  end if;

  -- ------------------------------------------------ 13. customer_phone must be E.164
  v_raised := false;
  begin
    insert into public.orders (shop_id, customer_name, customer_phone, fulfilment, subtotal_cents, total_cents)
      values (v_shop_id, 'X', '0634000000', 'collect', 100, 100);
  exception when check_violation then v_raised := true;
  end;
  if not v_raised then
    raise exception 'FAIL: a non-E.164 phone number was accepted';
  end if;

  -- ------------------------------------------------ 14. anon has no table privilege on either table
  if has_table_privilege('anon', 'public.orders', 'SELECT') then
    raise exception 'FAIL: anon can select from orders';
  end if;
  if has_table_privilege('anon', 'public.orders', 'INSERT') then
    raise exception 'FAIL: anon can insert into orders';
  end if;
  if has_table_privilege('anon', 'public.order_items', 'SELECT') then
    raise exception 'FAIL: anon can select from order_items';
  end if;
  if has_table_privilege('anon', 'public.order_items', 'INSERT') then
    raise exception 'FAIL: anon can insert into order_items';
  end if;

  -- Belt and braces, matching verify-storefront.sql check 8: a grant that
  -- exists on paper but is somehow ineffective would still pass the
  -- has_table_privilege checks above, so also prove Postgres itself refuses
  -- anon at the table.
  set local role anon;
  v_raised := false;
  begin
    perform 1 from public.orders limit 1;
  exception when insufficient_privilege then v_raised := true;
  end;
  reset role;
  if not v_raised then
    raise exception 'FAIL: anon could read the orders table directly';
  end if;

  -- ------------------------------------------------ 15. authenticated has select and insert on both
  if not has_table_privilege('authenticated', 'public.orders', 'SELECT') then
    raise exception 'FAIL: authenticated cannot select from orders -- RLS policies without a table grant are decorative';
  end if;
  if not has_table_privilege('authenticated', 'public.orders', 'INSERT') then
    raise exception 'FAIL: authenticated cannot insert into orders';
  end if;
  if not has_table_privilege('authenticated', 'public.order_items', 'SELECT') then
    raise exception 'FAIL: authenticated cannot select from order_items';
  end if;
  if not has_table_privilege('authenticated', 'public.order_items', 'INSERT') then
    raise exception 'FAIL: authenticated cannot insert into order_items';
  end if;

  -- ------------------------------------------------ 16. an order is refused for a shop whose plan lacks storefront
  -- Move the second shop off whatever plan the seed put it on and onto Free,
  -- which 20260923000000_storefront_module_grant.sql deliberately does not
  -- grant storefront to. shop_has_module is asserted directly first so the
  -- setup is proven, not assumed -- if Free ever gained the module the insert
  -- below would silently succeed and this check would pass for the wrong
  -- reason.
  select id into v_free_id from public.plans where key = 'free';
  update public.shop_subscriptions
  set plan_id = v_free_id, current_period_end = now() + interval '30 days'
  where shop_id = v_shop2_id;

  if public.shop_has_module(v_shop2_id, 'storefront') then
    raise exception 'FAIL: a shop moved to the Free plan still has the storefront module';
  end if;

  -- The trigger raises a fixed message ('module_not_included', see
  -- enforce_shop_module in 20260818000400_module_write_gates.sql) rather than
  -- a distinct SQLSTATE, so catching `others` and checking sqlerrm is how
  -- this check tells the trigger's refusal apart from any other failure --
  -- a bare `when others` here would pass just as well if the insert failed
  -- for an unrelated reason, which is exactly the gap this check exists to
  -- close.
  v_raised := false;
  begin
    insert into public.orders (shop_id, customer_name, customer_phone, fulfilment, subtotal_cents, total_cents)
      values (v_shop2_id, 'Blocked', '+252634000010', 'collect', 100, 100);
  exception
    when others then
      if sqlerrm = 'module_not_included' then
        v_raised := true;
      else
        raise;
      end if;
  end;
  if not v_raised then
    raise exception 'FAIL: an order was inserted for a shop whose plan does not include the storefront module';
  end if;

  raise notice 'PASS: orders schema';
  raise exception 'rollback_marker';
exception
  when others then
    if sqlerrm = 'rollback_marker' then
      raise notice 'verify-orders: all checks passed, rolled back';
    else
      raise;
    end if;
end $$;
