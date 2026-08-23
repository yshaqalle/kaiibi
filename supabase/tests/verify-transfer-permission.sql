-- transfer_stock() checks inventory.transfer, not only inventory.edit.
--
-- Three groups of checks, none of which the TypeScript suite can make, because
-- all three are facts about what a database function does when called with a
-- given role, not about what the client renders:
--
--   1. a role holding inventory.transfer can move stock, and the move lands at
--      both locations.
--   2. a role holding inventory.edit but NOT inventory.transfer -- exactly
--      what a shop gets by turning "move between stores" off in the role
--      editor -- is refused, and NOTHING moved: both locations read exactly
--      what they read before the call, and no stock_transfers row was
--      created for that attempt. The permission check is the function's
--      first statement, so the refusal has nothing to roll back, but this is
--      asserted rather than assumed.
--   3. a role holding inventory.transfer WITHOUT inventory.edit can still
--      move stock. This is the migration's replace-vs-join decision made
--      concrete: the header at 20260903000200_transfer_stock_permission.sql
--      argues the check should read the child string alone, the same way
--      save_stock_count reads 'inventory.count' alone, because the client's
--      `canEdit && can('inventory.transfer')` always reduces to
--      `can('inventory.transfer')` once expandPermissions folds the parent
--      back in. If a future edit ever changes the check to
--      `has_shop_permission(...,'inventory.edit') AND
--      has_shop_permission(...,'inventory.transfer')`, this is the check that
--      turns red.
--
-- Everything runs inside one DO block whose EXCEPTION clause rolls it all back.

\set ON_ERROR_STOP on

do $$
declare
  v_owner_id         uuid := gen_random_uuid();
  v_mover_id         uuid := gen_random_uuid();
  v_stocker_id       uuid := gen_random_uuid();
  v_transfer_only_id uuid := gen_random_uuid();
  v_shop_id          uuid;
  v_loc_a            uuid;
  v_loc_b            uuid;
  v_product_id       uuid;
  v_mover_role       uuid;
  v_stocker_role     uuid;
  v_transfer_only_role uuid;
  v_stock_a          integer;
  v_stock_b          integer;
  v_transfer_id      uuid;
  v_transfers_before integer;
  v_transfers_after  integer;
  v_items_count      integer;
  v_raised           boolean;
  v_message          text;
begin
  -- shops.owner_id, shop_members.user_id and stock_transfers.created_by all
  -- reference auth.users(id), so every fixture "person" needs a real row there
  -- before anything else -- the same setup verify-stock-counts.sql uses.
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
    select u, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
           'verify-transfer-permission-' || u || '@example.test', '', now(), now(), now()
      from unnest(array[v_owner_id, v_mover_id, v_stocker_id, v_transfer_only_id]) u;

  insert into public.shops (owner_id, name) values (v_owner_id, 'Transfer Shop') returning id into v_shop_id;
  -- A fresh shop lands on the `trial` plan, which grants every module
  -- (20260818000000), so multi_location is already on and stock_transfers'
  -- module trigger (stock_transfers_module, 20260818000400) does not need to
  -- be worked around here the way verify-stock-counts.sql has to downgrade a
  -- plan to prove the OPPOSITE (that stock_counts is not gated on it).
  insert into public.shop_locations (shop_id, name, is_primary) values (v_shop_id, 'Main Street', true)
    returning id into v_loc_a;
  insert into public.shop_locations (shop_id, name, is_primary) values (v_shop_id, 'Annex', false)
    returning id into v_loc_b;

  -- Opening stock lands at the primary location by trigger (20260810000000),
  -- so this product starts with a product_location_stock row at v_loc_a and
  -- none at v_loc_b.
  insert into public.products (shop_id, name, price_cents, cost_cents, stock)
    values (v_shop_id, 'Cosrx Snail Mucin', 1400, 512, 20) returning id into v_product_id;

  -- Three roles, reproducing the three states a shop's role editor can put a
  -- member in with respect to these two permissions:
  --   Mover           -- both, the ordinary post-backfill "can move stock" role.
  --   Stocker         -- edit but not transfer, exactly what turning the child
  --                      off in the role editor produces.
  --   Transfer-only   -- transfer but not edit. Not reachable through the
  --                      current role editor (which always saves through
  --                      expandPermissions and folds the parent back in), but
  --                      exactly the state the migration's header reasons
  --                      about: nothing stops a future write path from
  --                      producing it, and REPLACE vs JOIN is the difference
  --                      between this role moving stock and being refused.
  perform set_config('role', 'postgres', true);
  insert into public.roles (shop_id, name, permissions)
    values (v_shop_id, 'Mover', array['inventory.view', 'inventory.edit', 'inventory.transfer'])
    returning id into v_mover_role;
  insert into public.roles (shop_id, name, permissions)
    values (v_shop_id, 'Stocker', array['inventory.view', 'inventory.edit'])
    returning id into v_stocker_role;
  insert into public.roles (shop_id, name, permissions)
    values (v_shop_id, 'Transfer-only', array['inventory.view', 'inventory.transfer'])
    returning id into v_transfer_only_role;
  insert into public.shop_members (shop_id, user_id, role_id, active)
    values (v_shop_id, v_mover_id, v_mover_role, true);
  insert into public.shop_members (shop_id, user_id, role_id, active)
    values (v_shop_id, v_stocker_id, v_stocker_role, true);
  insert into public.shop_members (shop_id, user_id, role_id, active)
    values (v_shop_id, v_transfer_only_id, v_transfer_only_role, true);
  perform set_config('role', 'authenticated', true);

  -- 1. A role holding inventory.transfer moves stock, and it lands at both
  --    locations.
  perform set_config('request.jwt.claims', json_build_object('sub', v_mover_id)::text, true);
  v_transfer_id := public.transfer_stock(
    v_shop_id, v_loc_a, v_loc_b,
    jsonb_build_array(jsonb_build_object('product_id', v_product_id, 'quantity', 5)),
    'first shipment to the annex'
  );
  if v_transfer_id is null then
    raise exception 'FIXTURE: transfer_stock should have returned a transfer id';
  end if;

  select stock into v_stock_a from public.product_location_stock
    where product_id = v_product_id and location_id = v_loc_a;
  if not found then
    raise exception 'FIXTURE: expected a product_location_stock row for v_product_id at v_loc_a';
  end if;
  if v_stock_a <> 15 then
    raise exception 'FAIL: the source location should read 20 - 5 = 15, got %', v_stock_a;
  end if;

  select stock into v_stock_b from public.product_location_stock
    where product_id = v_product_id and location_id = v_loc_b;
  if not found then
    raise exception 'FIXTURE: expected a product_location_stock row for v_product_id at v_loc_b -- the transfer''s insert branch should have created it';
  end if;
  if v_stock_b <> 5 then
    raise exception 'FAIL: the destination location should read 5, got %', v_stock_b;
  end if;

  select count(*) into v_items_count from public.stock_transfer_items where transfer_id = v_transfer_id;
  if v_items_count <> 1 then
    raise exception 'FAIL: the successful transfer should have recorded exactly one item line, got %', v_items_count;
  end if;

  -- 2. THE GAP THIS MIGRATION CLOSES: a role holding inventory.edit but not
  --    inventory.transfer is refused, and nothing moves.
  select count(*) into v_transfers_before from public.stock_transfers where shop_id = v_shop_id;

  perform set_config('request.jwt.claims', json_build_object('sub', v_stocker_id)::text, true);
  v_raised := false;
  v_message := null;
  begin
    perform public.transfer_stock(
      v_shop_id, v_loc_a, v_loc_b,
      jsonb_build_array(jsonb_build_object('product_id', v_product_id, 'quantity', 3)),
      null
    );
  exception when others then
    v_raised := true;
    get stacked diagnostics v_message = message_text;
  end;
  if not v_raised then
    raise exception 'FAIL: inventory.edit alone must not be enough to move stock between stores';
  end if;
  if v_message !~ '^not authorized for shop' then
    raise exception 'FAIL: expected the permission guard to fire, got %', v_message;
  end if;

  -- Refused before anything was written: no new stock_transfers row for this
  -- shop, and neither location's stock moved from where check 1 left it. A
  -- guard that raised after inserting the stock_transfers header (or after
  -- decrementing the source) would still trip the exception above -- these
  -- three assertions are what actually prove the refusal happened FIRST, not
  -- merely that it happened.
  select count(*) into v_transfers_after from public.stock_transfers where shop_id = v_shop_id;
  if v_transfers_after <> v_transfers_before then
    raise exception 'FAIL: a refused transfer must not create a stock_transfers row, before % after %', v_transfers_before, v_transfers_after;
  end if;

  select stock into v_stock_a from public.product_location_stock
    where product_id = v_product_id and location_id = v_loc_a;
  if not found then
    raise exception 'FIXTURE: expected a product_location_stock row for v_product_id at v_loc_a';
  end if;
  if v_stock_a <> 15 then
    raise exception 'FAIL: a refused transfer must leave the source location alone, got %', v_stock_a;
  end if;

  select stock into v_stock_b from public.product_location_stock
    where product_id = v_product_id and location_id = v_loc_b;
  if not found then
    raise exception 'FIXTURE: expected a product_location_stock row for v_product_id at v_loc_b';
  end if;
  if v_stock_b <> 5 then
    raise exception 'FAIL: a refused transfer must leave the destination location alone, got %', v_stock_b;
  end if;

  -- 3. A role holding inventory.transfer WITHOUT inventory.edit can still
  --    move stock -- proving the check reads 'inventory.transfer' alone
  --    (REPLACE), not `inventory.edit AND inventory.transfer` (JOIN). See the
  --    migration header for why REPLACE is the choice that actually agrees
  --    with the client in every state, including this one.
  perform set_config('request.jwt.claims', json_build_object('sub', v_transfer_only_id)::text, true);
  v_transfer_id := public.transfer_stock(
    v_shop_id, v_loc_a, v_loc_b,
    jsonb_build_array(jsonb_build_object('product_id', v_product_id, 'quantity', 2)),
    null
  );
  if v_transfer_id is null then
    raise exception 'FAIL: a role holding inventory.transfer alone should be able to move stock';
  end if;

  select stock into v_stock_a from public.product_location_stock
    where product_id = v_product_id and location_id = v_loc_a;
  if not found then
    raise exception 'FIXTURE: expected a product_location_stock row for v_product_id at v_loc_a';
  end if;
  if v_stock_a <> 13 then
    raise exception 'FAIL: the source location should read 15 - 2 = 13, got %', v_stock_a;
  end if;

  select stock into v_stock_b from public.product_location_stock
    where product_id = v_product_id and location_id = v_loc_b;
  if not found then
    raise exception 'FIXTURE: expected a product_location_stock row for v_product_id at v_loc_b';
  end if;
  if v_stock_b <> 7 then
    raise exception 'FAIL: the destination location should read 5 + 2 = 7, got %', v_stock_b;
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
