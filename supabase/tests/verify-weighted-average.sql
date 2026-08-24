-- Stock is valued at a moving weighted average, not the latest price paid.
--
-- receive_stock used to REPLACE products.cost_cents with the newest line's
-- price -- the migration's own comment called it "latest wins". That is
-- replacement cost, and IAS 2.25 permits exactly two formulas for
-- interchangeable goods: FIFO and weighted average. This is neither. So these
-- checks are not a refinement of the old rule; they are the difference between
-- a permitted basis and an impermissible one.
--
-- Five checks, and each edge has a right answer that differs from the obvious
-- one:
--
--   1. the first delivery sets the cost outright. There is nothing to average
--      against, and averaging against zero stock is a division by zero.
--   2. THE ONE THAT MATTERS. A second delivery averages instead of replacing.
--   3. a delivery with no stated cost leaves the cost alone. A delivery that
--      did not say what it cost is not evidence that it was free.
--   4. the average is taken against SHOP-WIDE stock, not the receiving
--      location's. products.cost_cents is one figure per product, so averaging
--      against one branch would make the same delivery produce a different
--      cost depending on where it landed.
--   5. a null prior cost is REPLACED, not averaged as zero. Null means nobody
--      priced this product, and treating it as free would halve the cost of
--      everything a shop had not got round to.
--
-- Everything runs inside one DO block whose EXCEPTION clause rolls it all back.

\set ON_ERROR_STOP on

do $$
declare
  v_user_id  uuid := gen_random_uuid();
  v_shop_id  uuid;
  v_loc_id   uuid;
  v_loc2     uuid;
  v_prod     uuid;
  v_uncosted uuid;
  v_cost     integer;
begin
  -- shops.owner_id and stock_receipts.created_by both reference auth.users(id),
  -- so the fixture "person" needs a real row there before anything else.
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
    values (v_user_id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            'verify-weighted-average-' || v_user_id || '@example.test', '', now(), now(), now());

  insert into public.shops (owner_id, name) values (v_user_id, 'Average Shop') returning id into v_shop_id;

  -- A shop has no location until the fixture makes one; seed_shop_defaults does
  -- not create one. Two, because check 4 needs the average taken across both.
  insert into public.shop_locations (shop_id, name, is_primary) values (v_shop_id, 'Main', true)
    returning id into v_loc_id;
  insert into public.shop_locations (shop_id, name, is_primary) values (v_shop_id, 'Second', false)
    returning id into v_loc2;

  -- No cost and no stock: the clean slate check 1 needs.
  insert into public.products (shop_id, name, price_cents, cost_cents, stock)
    values (v_shop_id, 'Cetaphil Gentle Cleanser', 3000, null, 0) returning id into v_prod;

  -- 40 units on the shelf that nobody ever priced. product_opening_stock_trigger
  -- puts them at the primary location, so check 5 has a real prior quantity to
  -- average against -- which is the whole point: the quantity is there, it is
  -- the COST that is unknown.
  insert into public.products (shop_id, name, price_cents, cost_cents, stock)
    values (v_shop_id, 'Nivea Soft Cream', 1500, null, 40) returning id into v_uncosted;

  perform set_config('request.jwt.claims', json_build_object('sub', v_user_id)::text, true);
  perform set_config('role', 'authenticated', true);

  -- 1. The first delivery sets the cost outright. There is nothing to average
  -- against, and averaging against zero stock is a division by zero.
  perform public.receive_stock(v_shop_id, v_loc_id,
    jsonb_build_array(jsonb_build_object('product_id', v_prod, 'quantity', 300, 'unit_cost_cents', 1000)));
  select cost_cents into v_cost from public.products where id = v_prod;
  if v_cost is distinct from 1000 then
    raise exception 'FAIL: the first delivery did not set the cost, got %', v_cost;
  end if;

  -- 2. THE ONE THAT MATTERS. A second delivery averages instead of replacing.
  --
  -- 300 @ 1000 plus 100 @ 2000 is 500,000 over 400 units = 1250.
  --
  -- The quantities are chosen so all four candidate answers differ, and this
  -- took two attempts. The first draft used 200 @ 1410 then 10 @ 1490: correct
  -- gives 1414 and averaging against POST-UPSERT stock also gives 1414, so the
  -- most likely implementation bug would have sailed straight through. With a
  -- large second delivery the four separate cleanly:
  --
  --   1250  correct
  --   1200  averaged against post-upsert stock (the delivery counted twice)
  --   2000  "latest wins", the bug being fixed
  --   1500  a plain mean of the two costs, ignoring quantity
  perform public.receive_stock(v_shop_id, v_loc_id,
    jsonb_build_array(jsonb_build_object('product_id', v_prod, 'quantity', 100, 'unit_cost_cents', 2000)));
  select cost_cents into v_cost from public.products where id = v_prod;
  if v_cost is distinct from 1250 then
    raise exception 'FAIL: expected a weighted 1250, got % (2000 = latest wins, 1200 = averaged against post-upsert stock, 1500 = mean of costs)', v_cost;
  end if;

  -- 3. A delivery with NO stated cost leaves the cost alone. A delivery that
  -- did not say what it cost is not evidence that it was free.
  perform public.receive_stock(v_shop_id, v_loc_id,
    jsonb_build_array(jsonb_build_object('product_id', v_prod, 'quantity', 50)));
  select cost_cents into v_cost from public.products where id = v_prod;
  if v_cost is distinct from 1250 then
    raise exception 'FAIL: an uncosted delivery changed the cost to %', v_cost;
  end if;

  -- 4. The average is taken against SHOP-wide stock, not the receiving
  -- location's. 450 units sit at loc 1 (300 + 100 + the 50 uncosted); receiving
  -- 400 @ 2000 at loc 2 must average across both.
  --
  -- Correct: (450*1250 + 400*2000)/850 = 1603. Averaging against loc 2's own
  -- stock -- zero before this -- gives 2000 instead, so the two separate.
  perform public.receive_stock(v_shop_id, v_loc2,
    jsonb_build_array(jsonb_build_object('product_id', v_prod, 'quantity', 400, 'unit_cost_cents', 2000)));
  select cost_cents into v_cost from public.products where id = v_prod;
  if v_cost is distinct from 1603 then
    raise exception 'FAIL: expected 1603 averaging across both stores, got % (2000 = averaged against the receiving store only)', v_cost;
  end if;

  -- 5. A product whose cost was NULL takes the delivery's cost rather than
  -- averaging null as zero, which would halve the cost of anything nobody had
  -- got round to pricing.
  --
  -- v_uncosted already has 40 units on the shelf with no cost recorded, so a
  -- coalesce(cost_cents, 0) implementation would compute
  -- (40*0 + 5*800)/45 = 89 -- visibly, damningly different from 800.
  perform public.receive_stock(v_shop_id, v_loc_id,
    jsonb_build_array(jsonb_build_object('product_id', v_uncosted, 'quantity', 5, 'unit_cost_cents', 800)));
  select cost_cents into v_cost from public.products where id = v_uncosted;
  if v_cost is distinct from 800 then
    raise exception 'FAIL: a null prior cost was averaged rather than replaced, got % (89 = null treated as zero)', v_cost;
  end if;

  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims', null, true);
  raise notice 'ALL CHECKS PASSED';
  raise exception 'rollback fixture';
exception
  when others then
    perform set_config('role', 'postgres', true);
    perform set_config('request.jwt.claims', null, true);
    if sqlerrm = 'rollback fixture' then
      return;
    end if;
    raise;
end $$;
