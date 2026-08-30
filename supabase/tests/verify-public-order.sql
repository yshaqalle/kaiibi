-- get_public_order: what a customer holding a link may see.
--
-- One DO block, EXCEPTION rolls everything back, own fixture -- there is no
-- seed.sql. Every failure `raise exception`s; a `raise notice 'FAIL ...'`
-- would fail NOTHING, because run-all.sh:82 greps the whole output for the
-- verdict string. The verdict sits in the LAST block, after every check.
--
-- WRITTEN AS AN AUDIT OF AN EXPOSURE, not as a feature demo. This is the
-- FIFTH function on the anonymous surface -- a surface 20261009000100
-- deliberately narrowed to four -- and the caller is a stranger on the
-- internet holding a string. So the checks below are mostly about what the
-- payload must NOT contain, and each one names what it is defending.
--
--    1.  a valid token returns the order: number, status, totals.
--    2.  the lines come back, with name, quantity and line total.
--    3.  WHERE TO GO. A deliver order carries the landmark the customer
--        themselves gave; a collect order carries the SHOP's own address,
--        resolved the same way get_public_storefront resolves it
--        (20261010000100:224 -- is_primary desc, created_at asc). A rail
--        that says "Ready" without saying where to go is the failure the
--        confirmation screen already has.
--    4.  THE INTERNAL REASON IS ABSENT FROM THE WHOLE PAYLOAD. Asserted
--        against the serialised jsonb with a reason string that appears
--        nowhere else in the fixture, so a substring match is proof. The
--        customer_note IS present -- that is the field that may travel.
--    5.  NO COST, NO STOCK, NO SALE ID, AND NO UUID ANYWHERE. Shortfall
--        counts too: "only 3 left" is competitive information. The uuid
--        check is a shape match against the serialised payload, which
--        catches an id nobody thought to name.
--    6/7. an unknown token and an EXPIRED one return the IDENTICAL answer.
--        Compared to each other, not merely both checked for null: a
--        different message for the two turns the endpoint into an oracle
--        that tells a stranger which tokens are real.
--    8.  a cancelled order is READABLE -- the customer is owed that news --
--        but carries no cancellation_reason, which is written for the shop.
--    9.  anon holds EXECUTE. The whole public path is that one grant, and
--        Postgres hands EXECUTE to PUBLIC by default, so a `grant to anon`
--        with no `revoke from public` in front of it is a no-op that looks
--        like a decision. This is what goes red when the revoke is missing.
--   10.  anon still cannot select orders, order_items or order_amendments
--        directly. If it could, the capability design would be pointless --
--        it could read every order and harvest every token.

\set ON_ERROR_STOP on

do $$
declare
  v_owner_id uuid := gen_random_uuid();
  v_shop_id  uuid;
  v_loc_id   uuid;
  v_prod_a   uuid;
  v_prod_b   uuid;

  v_collect_id uuid;
  v_deliver_id uuid;
  v_cancel_id  uuid;
  v_expired_id uuid;

  -- Fixed tokens, so the assertions can name them. Real ones come from
  -- mint_order_share_token; these are the same shape.
  c_collect_token constant text := 'aaaaaaaaaaaaaaaaaaaaaaaaaa';
  c_deliver_token constant text := 'bbbbbbbbbbbbbbbbbbbbbbbbbb';
  c_cancel_token  constant text := 'cccccccccccccccccccccccccc';
  c_expired_token constant text := 'dddddddddddddddddddddddddd';

  -- A string that appears NOWHERE else in this fixture, so `not like` over
  -- the whole payload is proof rather than a hint.
  c_secret_reason constant text := 'ZZQ-internal-she-always-argues-about-the-price';

  v_payload  jsonb;
  v_unknown  jsonb;
  v_expired  jsonb;
  v_text     text;
  v_count    integer;
begin
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
    values (v_owner_id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            'verify-public-order-' || v_owner_id || '@example.test', '', now(), now(), now());

  insert into public.shops (owner_id, name, slug) values (v_owner_id, 'Link Shop', 'link-shop')
    returning id into v_shop_id;
  insert into public.storefronts (shop_id, offers_delivery, published_at)
    values (v_shop_id, true, now());

  -- The DECOY FIRST, exactly as verify-orders check 34 does it: both
  -- orderings this codebase uses are `is_primary desc, created_at asc`, so a
  -- non-primary branch inserted EARLIER means created_at alone picks the
  -- wrong one. Check 3 goes red if `is_primary desc` is ever dropped.
  insert into public.shop_locations (shop_id, name, address, is_primary)
    values (v_shop_id, 'Warehouse', 'Unit 4, Airport Road', false);
  insert into public.shop_locations (shop_id, name, address, is_primary)
    values (v_shop_id, 'Main', 'Shop 12, Bakaaro Market', true) returning id into v_loc_id;

  insert into public.storefront_delivery_areas (shop_id, name, fee_cents)
    values (v_shop_id, 'Xero Awr', 1500);

  insert into public.products (shop_id, name, price_cents, cost_cents, stock, is_listed_online)
    values (v_shop_id, 'Basmati rice', 2500, 911, 40, true) returning id into v_prod_a;
  insert into public.products (shop_id, name, price_cents, cost_cents, stock, is_listed_online)
    values (v_shop_id, 'Cooking oil', 1000, 422, 40, true) returning id into v_prod_b;

  -- A COLLECT order, amended once, so the diff and the note are exercised.
  insert into public.orders (shop_id, customer_name, customer_phone, fulfilment,
                             subtotal_cents, delivery_fee_cents, total_cents,
                             share_token, share_expires_at)
    values (v_shop_id, 'Hodan Ahmed', '+252634300111', 'collect', 7500, 0, 7500,
            c_collect_token, now() + interval '90 days')
    returning id into v_collect_id;
  insert into public.order_items (order_id, product_id, product_name, unit_price_cents, quantity, line_total_cents)
    values (v_collect_id, v_prod_a, 'Basmati rice', 2500, 3, 7500);

  insert into public.order_amendments (order_id, amended_by, reason, customer_note, pricing, before, after)
    values (v_collect_id, v_owner_id, c_secret_reason, 'We will have the rest on Thursday', 'agreed',
            jsonb_build_object('subtotal_cents', 12500, 'lines',
              jsonb_build_array(jsonb_build_object('product_id', v_prod_a, 'product_name', 'Basmati rice',
                                                   'unit_price_cents', 2500, 'quantity', 5))),
            jsonb_build_object('subtotal_cents', 7500, 'lines',
              jsonb_build_array(jsonb_build_object('product_id', v_prod_a, 'product_name', 'Basmati rice',
                                                   'unit_price_cents', 2500, 'quantity', 3))));

  -- A DELIVER order, never amended.
  insert into public.orders (shop_id, customer_name, customer_phone, fulfilment,
                             delivery_area, delivery_landmark,
                             subtotal_cents, delivery_fee_cents, total_cents,
                             share_token, share_expires_at)
    values (v_shop_id, 'Deka Yusuf', '+252634300222', 'deliver', 'Xero Awr', 'Behind the blue gate',
            2000, 1500, 3500, c_deliver_token, now() + interval '90 days')
    returning id into v_deliver_id;
  insert into public.order_items (order_id, product_id, product_name, unit_price_cents, quantity, line_total_cents)
    values (v_deliver_id, v_prod_b, 'Cooking oil', 1000, 2, 2000);

  -- Inserted PENDING and then transitioned, because it cannot be seeded
  -- cancelled: enforce_order_transition fires BEFORE INSERT as well as
  -- UPDATE, so an order always starts at 'pending' whatever the insert says.
  -- Going through transition_order is also the only way the cancellation
  -- reason gets written the way a real one does.
  insert into public.orders (shop_id, customer_name, customer_phone, fulfilment,
                             subtotal_cents, delivery_fee_cents, total_cents,
                             share_token, share_expires_at)
    values (v_shop_id, 'Cancelled Customer', '+252634300333', 'collect', 2500, 0, 2500,
            c_cancel_token, now() + interval '90 days')
    returning id into v_cancel_id;
  insert into public.order_items (order_id, product_id, product_name, unit_price_cents, quantity, line_total_cents)
    values (v_cancel_id, v_prod_a, 'Basmati rice', 2500, 1, 2500);

  -- EXPIRED: everything else identical to the collect order.
  insert into public.orders (shop_id, customer_name, customer_phone, fulfilment,
                             subtotal_cents, delivery_fee_cents, total_cents,
                             share_token, share_expires_at)
    values (v_shop_id, 'Expired Customer', '+252634300444', 'collect', 2500, 0, 2500,
            c_expired_token, now() - interval '1 day')
    returning id into v_expired_id;
  insert into public.order_items (order_id, product_id, product_name, unit_price_cents, quantity, line_total_cents)
    values (v_expired_id, v_prod_a, 'Basmati rice', 2500, 1, 2500);

  -- Cancel it the way a shop does. transition_order checks membership, so
  -- the owner's claim has to be on the session for the call.
  perform set_config('request.jwt.claims', json_build_object('sub', v_owner_id)::text, true);
  perform set_config('role', 'authenticated', true);
  perform public.transition_order(v_cancel_id, 'cancelled', 'ZZQ-never-showed-up-third-time');
  perform set_config('role', 'postgres', true);

  -- ------------------------------------------------ 9. anon holds EXECUTE
  if not has_function_privilege('anon', 'public.get_public_order(text)', 'EXECUTE') then
    raise exception 'FAIL 9: anon cannot execute get_public_order -- the customer''s link is the whole point of it';
  end if;

  -- ------------------------------------------------ 1. a valid token reads the order
  set local role anon;
  v_payload := public.get_public_order(c_collect_token);
  reset role;

  if v_payload is null then
    raise exception 'FAIL 1: a valid token returned nothing';
  end if;
  if (v_payload->>'number')::integer <> 1 then
    raise exception 'FAIL 1: number is %, expected 1', v_payload->>'number';
  end if;
  if v_payload->>'status' <> 'pending' then
    raise exception 'FAIL 1: status is %', v_payload->>'status';
  end if;
  if (v_payload->>'total_cents')::integer <> 7500 then
    raise exception 'FAIL 1: total is %, expected 7500', v_payload->>'total_cents';
  end if;
  if v_payload->>'shop_name' <> 'Link Shop' then
    raise exception 'FAIL 1: shop_name is %', quote_literal(v_payload->>'shop_name');
  end if;

  -- ------------------------------------------------ 2. the lines
  if jsonb_array_length(v_payload->'lines') <> 1 then
    raise exception 'FAIL 2: % lines, expected 1', jsonb_array_length(v_payload->'lines');
  end if;
  if v_payload->'lines'->0->>'product_name' <> 'Basmati rice'
     or (v_payload->'lines'->0->>'quantity')::integer <> 3
     or (v_payload->'lines'->0->>'line_total_cents')::integer <> 7500 then
    raise exception 'FAIL 2: the line reads %', v_payload->'lines'->0;
  end if;

  -- ------------------------------------------------ 3. where to go
  --
  -- A collect order gets the shop's PRIMARY address. The decoy Warehouse row
  -- was inserted first, so this is red if `is_primary desc` is dropped.
  if v_payload->>'where_to_go' <> 'Shop 12, Bakaaro Market' then
    raise exception 'FAIL 3: a collect order says where_to_go = % -- expected the shop''s primary address',
      coalesce(quote_literal(v_payload->>'where_to_go'), 'null');
  end if;

  set local role anon;
  v_payload := public.get_public_order(c_deliver_token);
  reset role;
  -- A deliver order gets the CUSTOMER's own landmark. Sending a delivery
  -- customer to the shop's counter is the opposite of useful.
  if v_payload->>'where_to_go' <> 'Behind the blue gate' then
    raise exception 'FAIL 3: a deliver order says where_to_go = % -- expected the customer''s landmark',
      coalesce(quote_literal(v_payload->>'where_to_go'), 'null');
  end if;
  if (v_payload->>'delivery_fee_cents')::integer <> 1500 or (v_payload->>'total_cents')::integer <> 3500 then
    raise exception 'FAIL 3: the delivery order''s money reads fee % / total %',
      v_payload->>'delivery_fee_cents', v_payload->>'total_cents';
  end if;
  -- Never amended, so there is no diff to show.
  if v_payload->'amendment' <> 'null'::jsonb and v_payload->'amendment' is not null then
    raise exception 'FAIL 3: an unamended order carries an amendment block: %', v_payload->'amendment';
  end if;

  -- ------------------------------------------------ 4. the note travels, the reason does not
  set local role anon;
  v_payload := public.get_public_order(c_collect_token);
  reset role;

  if v_payload->'amendment'->>'customer_note' <> 'We will have the rest on Thursday' then
    raise exception 'FAIL 4: the customer note is %', coalesce(quote_literal(v_payload->'amendment'->>'customer_note'), 'null');
  end if;
  if (v_payload->'amendment'->>'was_cents')::integer <> 12500
     or (v_payload->'amendment'->>'now_cents')::integer <> 7500 then
    raise exception 'FAIL 4: the diff reads was % / now %',
      v_payload->'amendment'->>'was_cents', v_payload->'amendment'->>'now_cents';
  end if;
  -- THE ONE THAT MATTERS. Over the WHOLE serialised payload, not one field:
  -- a reason leaked into a nested blob is just as forwarded as one in a
  -- top-level key.
  if v_payload::text like '%' || c_secret_reason || '%' then
    raise exception 'FAIL 4: THE INTERNAL AMENDMENT REASON IS IN THE CUSTOMER''S PAYLOAD';
  end if;

  -- ------------------------------------------------ 5. no cost, no stock, no ids
  if v_payload::text like '%911%' or v_payload::text like '%422%' then
    raise exception 'FAIL 5: a cost price reached the customer''s payload';
  end if;
  if v_payload::text like '%product_id%' or v_payload::text like '%sale_id%'
     or v_payload::text like '%shop_id%' or v_payload::text like '%order_id%' then
    raise exception 'FAIL 5: an internal id is named in the payload: %', v_payload::text;
  end if;
  -- A uuid by SHAPE, so an id nobody thought to name is caught anyway.
  if v_payload::text ~ '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' then
    raise exception 'FAIL 5: a uuid appears in the customer''s payload';
  end if;
  if v_payload::text like '%stock%' or v_payload::text like '%short%' then
    raise exception 'FAIL 5: stock or shortfall information reached the customer';
  end if;

  -- ------------------------------------------------ 8. a cancelled order is readable, its reason is not
  set local role anon;
  v_payload := public.get_public_order(c_cancel_token);
  reset role;
  if v_payload is null then
    raise exception 'FAIL 8: a cancelled order returned nothing -- the customer is owed that news';
  end if;
  if v_payload->>'status' <> 'cancelled' then
    raise exception 'FAIL 8: status reads %', v_payload->>'status';
  end if;
  if v_payload::text like '%ZZQ-never-showed-up%' then
    raise exception 'FAIL 8: the cancellation reason -- written for the shop -- reached the customer';
  end if;

  -- ------------------------------------------------ 6/7. unknown and expired are INDISTINGUISHABLE
  set local role anon;
  v_unknown := public.get_public_order('zzzzzzzzzzzzzzzzzzzzzzzzzz');
  v_expired := public.get_public_order(c_expired_token);
  reset role;

  if v_unknown is not null and v_unknown <> 'null'::jsonb then
    raise exception 'FAIL 6: an unknown token returned %', v_unknown;
  end if;
  -- Compared to EACH OTHER. Two different answers tell a stranger which
  -- tokens are real, which is exactly the oracle 20260924000100's header
  -- refuses to build for slugs.
  if v_expired is distinct from v_unknown then
    raise exception 'FAIL 7: an expired token answers % while an unknown one answers % -- the difference is an oracle',
      coalesce(v_expired::text, 'null'), coalesce(v_unknown::text, 'null');
  end if;

  -- ------------------------------------------------ 10. the tables stay shut to anon
  set local role anon;
  begin
    perform 1 from public.orders limit 1;
    raise exception 'FAIL 10: anon can read orders directly -- it could harvest every share_token';
  exception
    when insufficient_privilege then null;
    when others then if sqlerrm like 'FAIL 10%' then raise; end if;
  end;
  begin
    perform 1 from public.order_items limit 1;
    raise exception 'FAIL 10: anon can read order_items directly';
  exception
    when insufficient_privilege then null;
    when others then if sqlerrm like 'FAIL 10%' then raise; end if;
  end;
  begin
    perform 1 from public.order_amendments limit 1;
    raise exception 'FAIL 10: anon can read order_amendments directly -- every internal reason with it';
  exception
    when insufficient_privilege then null;
    when others then if sqlerrm like 'FAIL 10%' then raise; end if;
  end;
  reset role;

  raise notice 'PASS: public order link';
  raise exception 'rollback_marker';
exception
  when others then
    if sqlerrm = 'rollback_marker' then
      raise notice 'verify-public-order: all checks passed, rolled back';
    else
      raise;
    end if;
end $$;
