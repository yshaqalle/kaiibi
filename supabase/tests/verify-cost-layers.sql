-- Cost layers: what each delivery cost, and what a sale drew from.
--
-- Kaiibi keeps one cost_cents per product, overwritten every time stock
-- arrives. That is a weighted average, and it cannot answer "what did THESE
-- units cost" -- so FIFO is impossible and the balance sheet values stock at a
-- number that drifts from what was actually paid.
--
-- ## Two traps this file is written around
--
-- This script runs as the postgres superuser, so RLS does not apply to it.
--
--   1. A policy can never be asserted by attempting the operation -- a write
--      that a policy should refuse succeeds anyway here. Policies are asserted
--      against pg_policies.
--   2. Any RPC gating on has_shop_permission refuses until this script becomes
--      a user via set_config. Setting `role` also turns RLS ON, so raw inserts
--      into tables with no write policy must happen before that point.
--
-- And a shop has no location until the fixture makes one: seed_shop_defaults
-- does not create one, and complete_sale refuses without it.
--
-- Runs inside one DO block whose EXCEPTION clause rolls it all back.

\set ON_ERROR_STOP on

do $$
declare
  v_owner_id  uuid := gen_random_uuid();
  v_shop_id   uuid;
  v_loc_id    uuid;
  v_costed    uuid;
  v_uncosted  uuid;
  v_raised    boolean;
begin
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
    values (v_owner_id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            'verify-cost-layers-' || v_owner_id || '@example.test', '', now(), now(), now());

  insert into public.shops (owner_id, name) values (v_owner_id, 'Layers Shop') returning id into v_shop_id;
  insert into public.shop_locations (shop_id, name, is_primary) values (v_shop_id, 'Main', true)
    returning id into v_loc_id;

  insert into public.products (shop_id, name, price_cents, cost_cents)
    values (v_shop_id, 'Costed rice', 2000, 1450) returning id into v_costed;
  -- Null, not zero. isUncosted() in product-costing.ts is careful that the two
  -- are different answers: zero means the unit was free.
  insert into public.products (shop_id, name, price_cents, cost_cents)
    values (v_shop_id, 'Uncosted charger', 2000, null) returning id into v_uncosted;

  -- 1. A layer cannot remain more than it received. The invariant everything
  -- else rests on: consumption only ever decreases quantity_remaining, and a
  -- bug that increased it past the receipt would silently create stock.
  v_raised := false;
  begin
    insert into public.inventory_cost_layers
      (shop_id, product_id, location_id, unit_cost_cents, quantity_received, quantity_remaining, source)
      values (v_shop_id, v_costed, v_loc_id, 1450, 10, 11, 'receipt');
  exception when check_violation then v_raised := true;
  end;
  if not v_raised then
    raise exception 'FAIL: a layer with more remaining than received was accepted';
  end if;

  -- 2. Negative remaining is refused. Over-consumption would show up here
  -- first, and a table that permitted it would let the bug persist as data.
  v_raised := false;
  begin
    insert into public.inventory_cost_layers
      (shop_id, product_id, location_id, unit_cost_cents, quantity_received, quantity_remaining, source)
      values (v_shop_id, v_costed, v_loc_id, 1450, 10, -1, 'receipt');
  exception when check_violation then v_raised := true;
  end;
  if not v_raised then
    raise exception 'FAIL: a layer with negative remaining was accepted';
  end if;

  -- 3. A null unit cost is ALLOWED. An uncosted product is a real thing, and a
  -- layer that refused null would force a zero -- which means "free" and would
  -- overstate gross profit by the whole value of those units.
  insert into public.inventory_cost_layers
    (shop_id, product_id, location_id, unit_cost_cents, quantity_received, quantity_remaining, source)
    values (v_shop_id, v_uncosted, v_loc_id, null, 5, 5, 'receipt');

  -- 4. A bogus source is refused. The set is closed because reports group by
  -- it; a seventh spelling would become a seventh category nothing names.
  v_raised := false;
  begin
    insert into public.inventory_cost_layers
      (shop_id, product_id, location_id, unit_cost_cents, quantity_received, quantity_remaining, source)
      values (v_shop_id, v_costed, v_loc_id, 1450, 1, 1, 'magic');
  exception when check_violation then v_raised := true;
  end;
  if not v_raised then
    raise exception 'FAIL: a bogus layer source was accepted';
  end if;

  -- 5. Neither table has a write policy: the RPCs are the only door. Asserted
  -- against pg_policies rather than by attempting a write, because this script
  -- runs as superuser and the write would succeed however the policies read.
  if exists (
    select 1 from pg_policies
     where schemaname = 'public'
       and tablename in ('inventory_cost_layers', 'inventory_cost_consumption')
       and cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL')
  ) then
    raise exception 'FAIL: a layer table has a write policy; the RPCs are meant to be the only door';
  end if;

  raise notice 'ALL CHECKS PASSED';
  raise exception 'rollback fixture';
exception
  when others then
    if sqlerrm = 'rollback fixture' then return; end if;
    raise;
end $$;
