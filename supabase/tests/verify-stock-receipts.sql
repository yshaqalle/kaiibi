-- Receiving a delivery: what the count becomes, what the cost becomes, and
-- what the RPC refuses.
--
-- The three things asserted here cannot be checked in the TypeScript suite,
-- because all three are enforced by the database itself:
--
--   * the count is INCREMENTED, not replaced. A restock that overwrote would be
--     a Count, and the two are the whole reason the Stock door exists.
--   * a filled unit cost overwrites products.cost_cents and a blank one leaves
--     it alone -- the "latest wins" rule. Getting this backwards silently
--     rewrites the shop's stock-at-cost and gross profit.
--   * receiving is gated on the `inventory` module, NOT on `multi_location`.
--     stock_transfers IS gated on multi_location, and copying that trigger
--     across would lock every single-store shop out of receiving deliveries --
--     which is the most common shop on the platform.
--
-- Everything runs inside one DO block whose EXCEPTION clause rolls it all back.

\set ON_ERROR_STOP on

do $$
declare
  v_user_id     uuid := gen_random_uuid();
  v_other_owner uuid := gen_random_uuid();
  v_shop_id     uuid;
  v_location_id uuid;
  v_other_shop  uuid;
  v_other_loc   uuid;
  v_serum       uuid;
  v_balm        uuid;
  v_receipt_id  uuid;
  v_stock       integer;
  v_cost        integer;
  v_rows        integer;
  v_raised      boolean;
begin
  -- shops.owner_id and stock_receipts.created_by both reference auth.users(id),
  -- so both fixture "people" need a real row there before anything else.
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
    select u, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
           'verify-stock-receipts-' || u || '@example.test', '', now(), now(), now()
      from unnest(array[v_user_id, v_other_owner]) u;

  insert into public.shops (owner_id, name) values (v_user_id, 'Restock Shop') returning id into v_shop_id;
  insert into public.shop_locations (shop_id, name, is_primary) values (v_shop_id, 'Main', true)
    returning id into v_location_id;

  insert into public.products (shop_id, name, price_cents, cost_cents, stock)
    values (v_shop_id, 'Torriden Balanceful Serum', 1200, 450, 11) returning id into v_serum;
  insert into public.products (shop_id, name, price_cents, cost_cents, stock)
    values (v_shop_id, 'Beauty of Joseon Relief Sun', 900, null, 0) returning id into v_balm;

  perform set_config('request.jwt.claims', json_build_object('sub', v_user_id)::text, true);
  perform set_config('role', 'authenticated', true);

  -- 1. The count is added to, and the receipt is recorded.
  v_receipt_id := public.receive_stock(
    v_shop_id, v_location_id,
    jsonb_build_array(
      jsonb_build_object('product_id', v_serum, 'quantity', 6, 'unit_cost_cents', 480),
      jsonb_build_object('product_id', v_balm,  'quantity', 12, 'unit_cost_cents', 210)
    ),
    'Torriden Wholesale', 'INV-8841', 'first delivery'
  );

  select stock into v_stock from public.product_location_stock
    where product_id = v_serum and location_id = v_location_id;
  if v_stock <> 17 then
    raise exception 'FAIL: expected 11 + 6 = 17 at the store, got %', v_stock;
  end if;

  select stock into v_stock from public.products where id = v_serum;
  if v_stock <> 17 then
    raise exception 'FAIL: the products rollup should be 17, got %', v_stock;
  end if;

  select count(*) into v_rows from public.stock_receipt_items where receipt_id = v_receipt_id;
  if v_rows <> 2 then
    raise exception 'FAIL: expected 2 receipt items, got %', v_rows;
  end if;

  -- 2. Latest cost wins, and only where a cost was given.
  select cost_cents into v_cost from public.products where id = v_serum;
  if v_cost <> 480 then
    raise exception 'FAIL: a filled unit cost should overwrite 450 with 480, got %', v_cost;
  end if;
  select cost_cents into v_cost from public.products where id = v_balm;
  if v_cost <> 210 then
    raise exception 'FAIL: an uncosted product should take the received cost, got %', v_cost;
  end if;

  perform public.receive_stock(
    v_shop_id, v_location_id,
    jsonb_build_array(jsonb_build_object('product_id', v_serum, 'quantity', 3, 'unit_cost_cents', null)),
    null, null, null
  );
  select cost_cents into v_cost from public.products where id = v_serum;
  if v_cost <> 480 then
    raise exception 'FAIL: a blank unit cost must leave the cost alone, got %', v_cost;
  end if;
  select stock into v_stock from public.product_location_stock
    where product_id = v_serum and location_id = v_location_id;
  if v_stock <> 20 then
    raise exception 'FAIL: a second receipt should take 17 to 20, got %', v_stock;
  end if;

  -- 3. Zero and negative quantities are refused, not silently skipped.
  v_raised := false;
  begin
    perform public.receive_stock(v_shop_id, v_location_id,
      jsonb_build_array(jsonb_build_object('product_id', v_serum, 'quantity', 0, 'unit_cost_cents', null)),
      null, null, null);
  exception when others then v_raised := true;
  end;
  if not v_raised then
    raise exception 'FAIL: receiving zero units should raise';
  end if;

  -- 4. A product from another shop cannot be received into this one.
  -- Built as postgres, not the authenticated v_user_id: "own shops insert"
  -- requires owner_id = auth.uid(), so v_user_id could never create a shop
  -- owned by someone else -- the same reason the accounting suite's
  -- cross-shop fixtures are built before switching role to authenticated.
  perform set_config('role', 'postgres', true);
  insert into public.shops (owner_id, name) values (v_other_owner, 'Someone Else')
    returning id into v_other_shop;
  insert into public.shop_locations (shop_id, name, is_primary) values (v_other_shop, 'Theirs', true)
    returning id into v_other_loc;
  perform set_config('role', 'authenticated', true);
  v_raised := false;
  begin
    perform public.receive_stock(v_shop_id, v_other_loc,
      jsonb_build_array(jsonb_build_object('product_id', v_serum, 'quantity', 1, 'unit_cost_cents', null)),
      null, null, null);
  exception when others then v_raised := true;
  end;
  if not v_raised then
    raise exception 'FAIL: receiving into another shop''s location should raise';
  end if;

  -- 5. Receiving is gated on `inventory`, never on `multi_location`. A
  --    single-store shop without the multi-location module must still receive.
  if exists (
    select 1 from pg_trigger t
      join pg_class c on c.oid = t.tgrelid
    where c.relname = 'stock_receipts'
      and pg_get_triggerdef(t.oid) ilike '%multi_location%'
  ) then
    raise exception 'FAIL: stock_receipts must not be gated on multi_location';
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
