-- Receiving a delivery: what the count becomes, what the cost becomes, and
-- what the RPC refuses.
--
-- Six groups of checks, none of which can be made in the TypeScript suite,
-- because every one of them is enforced by the database itself. Checks 1 and 2
-- carry the rules the whole feature turns on; 3 to 6 are what it refuses:
--
--   1. the count is INCREMENTED, not replaced. A restock that overwrote would
--      be a Count, and the two are the whole reason the Stock door exists.
--   2. a filled unit cost is AVERAGED into products.cost_cents and a blank one
--      leaves it alone. Getting this backwards silently rewrites the shop's
--      stock-at-cost and gross profit. (2b pins that two lines for one product
--      compound rather than one of them winning.)
--
--      These checks used to assert the opposite -- "latest wins", the filled
--      cost overwriting outright. That was replacement cost, which IAS 2.25
--      does not permit; 20260907000000_moving_weighted_average.sql replaced it
--      with a moving weighted average and these assertions moved with it. The
--      arithmetic itself is proved in verify-weighted-average.sql; what is
--      proved HERE is that the surrounding behaviour -- blank costs, two lines
--      for one product, the counts -- survived the change.
--   3. a zero or negative quantity is refused with a sentence, not skipped.
--   4. a receiving location belonging to another shop is refused.
--   5. a product belonging to another shop is refused, by its own guard.
--   6. receiving is gated on the `inventory` module, NOT on `multi_location`.
--      stock_transfers IS gated on multi_location, and copying that trigger
--      across would lock every single-store shop out of receiving deliveries --
--      which is the most common shop on the platform.
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
  v_other_product uuid;
  v_standard_id uuid;
  v_receipt_id  uuid;
  v_stock       integer;
  v_cost        integer;
  v_rows        integer;
  v_raised      boolean;
  v_message     text;
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

  -- 2. The received cost is averaged in, and only where a cost was given.
  --
  -- The serum had 11 units at 450 and took 6 more at 480:
  -- (11*450 + 6*480)/17 = 7830/17 = 461. Not 480, which is what this check
  -- asserted while receive_stock replaced the cost instead of averaging it.
  select cost_cents into v_cost from public.products where id = v_serum;
  if v_cost <> 461 then
    raise exception 'FAIL: 11 @ 450 plus 6 @ 480 should average to 461, got % (480 = the old "latest wins")', v_cost;
  end if;
  -- The balm had no cost and no stock, so the delivery is the whole basis and
  -- there is nothing to average against. Null is not zero: averaging an
  -- unpriced product as free would halve its cost.
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
  if v_cost <> 461 then
    raise exception 'FAIL: a blank unit cost must leave the cost alone, got %', v_cost;
  end if;
  select stock into v_stock from public.product_location_stock
    where product_id = v_serum and location_id = v_location_id;
  if v_stock <> 20 then
    raise exception 'FAIL: a second receipt should take 17 to 20, got %', v_stock;
  end if;

  -- 2b. Two lines for the same product in one delivery must COMPOUND -- each
  --     line averaging against the result of the one before -- so that a sheet
  --     listing a product twice gives the same answer as two separate
  --     receipts. Neither line may be lost or overwrite the other.
  --
  --     Under "latest wins" this check pinned which line was "latest", and the
  --     ordinality tiebreaker in receive_stock's loop was what decided it.
  --     Averaging is commutative up to rounding, so order no longer changes the
  --     answer -- which is a better property, not a weaker one. What is still
  --     worth pinning is that BOTH lines land.
  --
  --     The balm has 12 units at 210. Taking 1 @ 111 then 100 @ 900:
  --       line 1: (12*210 + 1*111)/13   = 2631/13    = 202
  --       line 2: (13*202 + 100*900)/113 = 92626/113 = 820
  --
  --     The quantities are lopsided on purpose, so every way of getting this
  --     wrong gives a visibly different figure:
  --       820  correct
  --       900  "latest wins", the bug that was fixed
  --       826  only the second line counted
  --       202  only the first line counted
  --       825  v_prior_qty hoisted out of the loop, so line 2 averaged against
  --            the count from before line 1 landed
  --       530  averaged against post-upsert stock
  perform public.receive_stock(
    v_shop_id, v_location_id,
    jsonb_build_array(
      jsonb_build_object('product_id', v_balm, 'quantity', 1, 'unit_cost_cents', 111),
      jsonb_build_object('product_id', v_balm, 'quantity', 100, 'unit_cost_cents', 900)
    ),
    null, null, null
  );
  select cost_cents into v_cost from public.products where id = v_balm;
  if v_cost <> 820 then
    raise exception 'FAIL: two lines for one product should compound to 820, got % (900 = latest wins, 826 = only the second line, 202 = only the first, 825 = v_prior_qty hoisted out of the loop)', v_cost;
  end if;
  select stock into v_stock from public.product_location_stock
    where product_id = v_balm and location_id = v_location_id;
  if v_stock <> 113 then
    raise exception 'FAIL: both lines'' units should land, expected 12 + 1 + 100 = 113, got %', v_stock;
  end if;

  -- 3. Zero and negative quantities are refused, not silently skipped, and a
  --    negative unit cost is refused too.
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

  v_raised := false;
  begin
    perform public.receive_stock(v_shop_id, v_location_id,
      jsonb_build_array(jsonb_build_object('product_id', v_serum, 'quantity', -3, 'unit_cost_cents', null)),
      null, null, null);
  exception when others then v_raised := true;
  end;
  if not v_raised then
    raise exception 'FAIL: receiving a negative quantity should raise';
  end if;

  v_raised := false;
  begin
    perform public.receive_stock(v_shop_id, v_location_id,
      jsonb_build_array(jsonb_build_object('product_id', v_serum, 'quantity', 1, 'unit_cost_cents', -50)),
      null, null, null);
  exception when others then v_raised := true;
  end;
  if not v_raised then
    raise exception 'FAIL: a negative unit cost should raise';
  end if;

  -- 4. A receiving location belonging to another shop is refused (the guard
  --    at receive_stock's location check, 20260902000000_stock_receipts.sql:115-117).
  -- Built as postgres, not the authenticated v_user_id: "own shops insert"
  -- requires owner_id = auth.uid(), so v_user_id could never create a shop
  -- owned by someone else -- the same reason the accounting suite's
  -- cross-shop fixtures are built before switching role to authenticated.
  perform set_config('role', 'postgres', true);
  insert into public.shops (owner_id, name) values (v_other_owner, 'Someone Else')
    returning id into v_other_shop;
  insert into public.shop_locations (shop_id, name, is_primary) values (v_other_shop, 'Theirs', true)
    returning id into v_other_loc;
  insert into public.products (shop_id, name, price_cents, cost_cents, stock)
    values (v_other_shop, 'Their Product', 500, null, 0) returning id into v_other_product;
  perform set_config('role', 'authenticated', true);

  v_raised := false;
  v_message := null;
  begin
    perform public.receive_stock(v_shop_id, v_other_loc,
      jsonb_build_array(jsonb_build_object('product_id', v_serum, 'quantity', 1, 'unit_cost_cents', null)),
      null, null, null);
  exception when others then
    v_raised := true;
    get stacked diagnostics v_message = message_text;
  end;
  if not v_raised then
    raise exception 'FAIL: receiving into another shop''s location should raise';
  end if;
  if v_message !~ '^the receiving location must belong to shop' then
    raise exception 'FAIL: expected the location guard to fire, got %', v_message;
  end if;

  -- 5. A product belonging to another shop cannot be received into this one,
  --    even into one of THIS shop's own locations -- the guard at
  --    receive_stock's product lookup
  --    (20260902000000_stock_receipts.sql:149-151), distinct from check 4's
  --    location guard. Asserted on the message text, not a bare `others`
  --    catch, so this proves it is that guard that fired and not check 4's.
  v_raised := false;
  v_message := null;
  begin
    perform public.receive_stock(v_shop_id, v_location_id,
      jsonb_build_array(jsonb_build_object('product_id', v_other_product, 'quantity', 1, 'unit_cost_cents', null)),
      null, null, null);
  exception when others then
    v_raised := true;
    get stacked diagnostics v_message = message_text;
  end;
  if not v_raised then
    raise exception 'FAIL: receiving another shop''s product should raise';
  end if;
  if v_message !~ '^product .* not found in this shop' then
    raise exception 'FAIL: expected the product guard to fire, got %', v_message;
  end if;

  -- 6. Receiving is gated on `inventory`, never on `multi_location`.

  -- 6a. Structural sanity: the trigger on stock_receipts does not name
  --     multi_location. Necessary but not sufficient on its own -- this alone
  --     would still pass if someone moved the gate inside receive_stock()
  --     itself, or removed the inventory gate entirely. 6b and 6c below are
  --     the behavioural proof.
  if exists (
    select 1 from pg_trigger t
      join pg_class c on c.oid = t.tgrelid
    where c.relname = 'stock_receipts'
      and pg_get_triggerdef(t.oid) ilike '%multi_location%'
  ) then
    raise exception 'FAIL: stock_receipts must not be gated on multi_location';
  end if;

  -- 6b. A shop on a plan that carries `inventory` but not `multi_location`
  --     (the Standard tier) must still be able to receive -- the exact
  --     scenario the whole trigger exists for. The fixture shop is on a
  --     fresh trial, which grants every module including multi_location, so
  --     that scenario has to be forced deliberately rather than assumed.
  select id into v_standard_id from public.plans where key = 'standard';
  perform set_config('role', 'postgres', true);
  update public.shop_subscriptions set plan_id = v_standard_id where shop_id = v_shop_id;
  perform set_config('role', 'authenticated', true);

  if public.shop_has_module(v_shop_id, 'multi_location') then
    raise exception 'FIXTURE: the standard plan unexpectedly grants multi_location';
  end if;
  if not public.shop_has_module(v_shop_id, 'inventory') then
    raise exception 'FIXTURE: the standard plan unexpectedly lacks inventory';
  end if;

  perform public.receive_stock(v_shop_id, v_location_id,
    jsonb_build_array(jsonb_build_object('product_id', v_serum, 'quantity', 1, 'unit_cost_cents', null)),
    null, null, null);
  select stock into v_stock from public.product_location_stock
    where product_id = v_serum and location_id = v_location_id;
  if v_stock <> 21 then
    raise exception 'FAIL: a shop without multi_location should still receive, got %', v_stock;
  end if;

  -- 6c. The inventory gate genuinely bites: a shop that has lost every module
  --     (the operator's suspend switch, same mechanism as
  --     verify-entitlements.sql's kill-switch check) is refused, naming the
  --     missing module. Without this, 6a/6b only prove multi_location is
  --     absent, never that inventory is required at all -- strip the
  --     `inventory` gate from stock_receipts_module entirely and 6a/6b would
  --     both still pass.
  perform set_config('role', 'postgres', true);
  update public.shop_subscriptions set manual_status = 'suspended' where shop_id = v_shop_id;
  perform set_config('role', 'authenticated', true);

  v_raised := false;
  v_message := null;
  begin
    perform public.receive_stock(v_shop_id, v_location_id,
      jsonb_build_array(jsonb_build_object('product_id', v_serum, 'quantity', 1, 'unit_cost_cents', null)),
      null, null, null);
  exception when others then
    v_raised := true;
    get stacked diagnostics v_message = message_text;
  end;
  if not v_raised then
    raise exception 'FAIL: a shop lacking the inventory module should be refused';
  end if;
  if v_message <> 'module_not_included' then
    raise exception 'FAIL: expected module_not_included, got %', v_message;
  end if;

  -- (No restoring the subscription here. Nothing below reads it, and the
  -- `raise exception` two lines down rolls the whole fixture away -- including
  -- the shop the row belongs to.)
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
