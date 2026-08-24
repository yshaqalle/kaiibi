-- complete_sale takes its row locks in a fixed order.
--
-- ## The bug this pins
--
-- complete_sale looped over the cart with no ORDER BY, so it took
-- `select ... for update` on product_location_stock in CART order. Two tills
-- selling the same two products in opposite order take the same two locks in
-- opposite order, which is a deadlock -- one transaction holds A wanting B
-- while the other holds B wanting A, and Postgres kills one of them.
--
-- Every sibling stock RPC already orders its loop and says why:
-- receive_stock:131, transfer_stock:145, save_stock_count:189 and
-- refund_sale_items:148. complete_sale was the only one of the five that did
-- not.
--
-- ## Why this asserts an error MESSAGE rather than a deadlock
--
-- Demonstrating a deadlock needs two genuinely concurrent sessions and precise
-- timing; a test that tries is flaky, and a flaky test in a suite people run
-- before every commit is worse than none.
--
-- So this pins the same property through its one observable consequence.
-- When two products in one cart are BOTH short, the loop raises about
-- whichever it reaches first -- which is the cart's first line if unordered,
-- and the lowest product id if ordered. Build a cart where those two disagree
-- and the error message says which order the loop ran in.
--
-- It fails the moment the ORDER BY is removed, which is what it is for. The
-- deadlock itself is covered by the concurrency test in phase 2a, where cost
-- layers make the locking worth exercising under real parallelism.

\set ON_ERROR_STOP on

do $$
declare
  v_owner_id  uuid := gen_random_uuid();
  v_shop_id   uuid;
  v_loc_id    uuid;
  -- Chosen so the TEXT ordering the loop uses is unambiguous, and so the cart
  -- below can list them in the opposite order to it.
  v_low_id    uuid := '00000000-0000-4000-8000-000000000001';
  v_high_id   uuid := 'ffffffff-0000-4000-8000-000000000001';
  v_message   text;
begin
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
    values (v_owner_id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            'verify-lock-order-' || v_owner_id || '@example.test', '', now(), now(), now());

  insert into public.shops (owner_id, name) values (v_owner_id, 'Lock Order Shop') returning id into v_shop_id;
  insert into public.shop_locations (shop_id, name, is_primary) values (v_shop_id, 'Main', true)
    returning id into v_loc_id;

  -- Both out of stock, so whichever the loop reaches first is the one it
  -- names. Names rather than ids in the assertion, because the exception text
  -- carries the name.
  insert into public.products (id, shop_id, name, price_cents, cost_cents)
    values (v_low_id, v_shop_id, 'AAA sorts first', 1000, 500),
           (v_high_id, v_shop_id, 'ZZZ sorts last', 1000, 500);

  perform set_config('request.jwt.claims', json_build_object('sub', v_owner_id)::text, true);
  perform set_config('role', 'authenticated', true);

  -- The cart lists the HIGH id first. An unordered loop reaches it first and
  -- complains about "ZZZ"; an ordered loop reaches the low id first and
  -- complains about "AAA".
  begin
    perform public.complete_sale(
      v_shop_id,
      jsonb_build_array(
        jsonb_build_object('product_id', v_high_id, 'quantity', 1),
        jsonb_build_object('product_id', v_low_id,  'quantity', 1)
      ),
      jsonb_build_array(jsonb_build_object('method', 'cash', 'amount_cents', 2000)),
      null, null, null, null, 0, null, null, v_loc_id
    );
    raise exception 'FAIL: a sale with no stock for either product was accepted';
  exception
    when others then
      v_message := sqlerrm;
      if v_message = 'FAIL: a sale with no stock for either product was accepted' then
        raise;
      end if;
  end;

  if position('insufficient stock' in v_message) = 0 then
    raise exception 'FAIL: expected an insufficient-stock error, got: %', v_message;
  end if;

  if position('AAA sorts first' in v_message) = 0 then
    raise exception
      'FAIL: complete_sale processed the cart in cart order, not product order — it named "%" . The loop needs ORDER BY (value->>''product_id''), ord.',
      v_message;
  end if;

  raise notice 'ALL CHECKS PASSED';
  raise exception 'rollback fixture';
exception
  when others then
    if sqlerrm = 'rollback fixture' then return; end if;
    raise;
end $$;
