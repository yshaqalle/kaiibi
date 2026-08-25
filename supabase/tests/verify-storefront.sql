-- The storefront schema, checked against a real database.
--
-- Everything runs inside one DO block whose EXCEPTION clause rolls the whole lot
-- back, so it leaves no rows behind -- same shape as verify-entitlements.sql.
--
-- Most of this runs as postgres, which is a superuser and bypasses RLS and
-- grants both -- so by itself it only exercises each function's WHERE clause,
-- never the anon grant the three public functions actually depend on. The
-- checks that call get_public_storefront, get_public_storefront_products and
-- get_public_delivery_areas switch to `anon` with `set local role` immediately
-- beforehand and `reset role` immediately after, so the setup writes around
-- them keep running as postgres.

\set ON_ERROR_STOP on

do $$
declare
  v_user_id uuid := gen_random_uuid();
  v_shop_id uuid;
  v_other_id uuid;
  v_free_id uuid;
  v_raised boolean;
begin
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
    values (v_user_id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            'verify-sf-' || v_user_id || '@example.test', '', now(), now(), now());

  insert into public.shops (owner_id, name) values (v_user_id, 'Xamdi Electronics') returning id into v_shop_id;
  insert into public.shops (owner_id, name) values (v_user_id, 'Second Branch') returning id into v_other_id;

  -- ------------------------------------------------ 1. a shop starts with no page
  if exists (select 1 from public.storefronts where shop_id = v_shop_id) then
    raise exception 'FAIL: creating a shop created a storefront; it must be opt-in';
  end if;

  -- ------------------------------------------------ 2. slug is unique platform-wide
  update public.shops set slug = 'xamdi' where id = v_shop_id;
  v_raised := false;
  begin
    update public.shops set slug = 'xamdi' where id = v_other_id;
  exception when unique_violation then v_raised := true;
  end;
  if not v_raised then
    raise exception 'FAIL: two shops took the same slug';
  end if;

  -- ------------------------------------------------ 3. theme and palette are constrained
  insert into public.storefronts (shop_id) values (v_shop_id);

  if (select theme from public.storefronts where shop_id = v_shop_id) <> 'market' then
    raise exception 'FAIL: default theme is not market';
  end if;
  if (select palette from public.storefronts where shop_id = v_shop_id) <> 'ink' then
    raise exception 'FAIL: default palette is not ink';
  end if;

  v_raised := false;
  begin
    update public.storefronts set theme = 'editorial_film' where shop_id = v_shop_id;
  exception when check_violation then v_raised := true;
  end;
  if not v_raised then
    raise exception 'FAIL: an unknown theme was accepted';
  end if;

  v_raised := false;
  begin
    update public.storefronts set payment_mode = 'online' where shop_id = v_shop_id;
  exception when check_violation then v_raised := true;
  end;
  if not v_raised then
    raise exception 'FAIL: payment_mode online was accepted before online payment exists';
  end if;

  -- ------------------------------------------------ 4. a page starts unpublished
  if (select published_at from public.storefronts where shop_id = v_shop_id) is not null then
    raise exception 'FAIL: a new storefront was born published';
  end if;

  -- ------------------------------------------------ 5. delivery fees cannot be negative
  v_raised := false;
  begin
    insert into public.storefront_delivery_areas (shop_id, name, fee_cents, sort_order)
      values (v_shop_id, 'Ahmed Dhagah', -100, 0);
  exception when check_violation then v_raised := true;
  end;
  if not v_raised then
    raise exception 'FAIL: a negative delivery fee was accepted';
  end if;

  insert into public.storefront_delivery_areas (shop_id, name, fee_cents, sort_order)
    values (v_shop_id, 'Ahmed Dhagah', 100, 0);
  if (select fee_cents from public.storefront_delivery_areas where shop_id = v_shop_id) <> 100 then
    raise exception 'FAIL: delivery fee did not round-trip';
  end if;

  -- ------------------------------------------------ 6. a draft page is invisible
  -- Read as anon from here on, whenever the read goes through one of the three
  -- public functions -- this is the boundary the grant actually protects.
  set local role anon;
  if current_user <> 'anon' then
    raise exception 'FAIL: set local role anon did not take effect (current_user = %)', current_user;
  end if;
  if exists (select 1 from public.get_public_storefront('xamdi')) then
    raise exception 'FAIL: an unpublished storefront was readable';
  end if;
  reset role;

  update public.storefronts set published_at = now() where shop_id = v_shop_id;

  set local role anon;
  if not exists (select 1 from public.get_public_storefront('xamdi')) then
    raise exception 'FAIL: a published storefront was not readable';
  end if;

  -- ------------------------------------------------ 7. an unknown slug is silent
  if exists (select 1 from public.get_public_storefront('no-such-shop')) then
    raise exception 'FAIL: an unknown slug returned a row';
  end if;
  reset role;

  -- ------------------------------------------------ 8. only listed products, never cost
  insert into public.products (shop_id, name, price_cents, cost_cents, stock, is_listed_online)
    values (v_shop_id, 'Anker 20W charger', 1200, 700, 5, true);
  insert into public.products (shop_id, name, price_cents, cost_cents, stock, is_listed_online)
    values (v_shop_id, 'Trade-only cable', 500, 100, 5, false);

  set local role anon;
  if (select count(*) from public.get_public_storefront_products('xamdi')) <> 1 then
    raise exception 'FAIL: the public product list did not honour is_listed_online';
  end if;
  reset role;

  -- Postgres does not register a function's RETURNS TABLE columns in
  -- information_schema.columns -- there is no table there to register them
  -- under. They show up in information_schema.parameters instead, as OUT
  -- parameters. A check against .columns for a function name is silently
  -- vacuous: it always finds zero rows and always "passes". This checks the
  -- view that actually holds the declaration, for both money-bearing public
  -- functions, so a future `returns table` edit that widens either one to
  -- include a cost column is caught before it ships.
  if exists (
    select 1
    from information_schema.routines r
    join information_schema.parameters p
      on p.specific_schema = r.specific_schema
     and p.specific_name = r.specific_name
    where r.routine_schema = 'public'
      and r.routine_name in ('get_public_storefront_products', 'get_public_delivery_areas')
      and p.parameter_mode = 'OUT'
      and p.parameter_name like '%cost%'
  ) then
    raise exception 'FAIL: a public storefront function declares a cost column';
  end if;

  -- The belt-and-braces version: whatever the function returns, cost must not be
  -- findable in it. A future edit that adds `select p.*` fails here.
  set local role anon;
  if exists (
    select 1
    from public.get_public_storefront_products('xamdi') pp
    where (to_jsonb(pp) ? 'cost_cents')
  ) then
    raise exception 'FAIL: cost_cents leaked into the public product payload';
  end if;

  -- And the boundary the function exists to enforce in the first place: anon
  -- must not be able to read the table underneath it at all. The function's
  -- explicit column list is only a guarantee while it is the sole path in --
  -- a policy that let anon select from products directly would make this
  -- whole SECURITY DEFINER, explicit-column-list design moot, because a
  -- client could just widen its own query to `select *` and reach
  -- cost_cents. Confirmed by hand: this raises "permission denied for table
  -- products".
  v_raised := false;
  begin
    perform 1 from public.products limit 1;
  exception when insufficient_privilege then v_raised := true;
  end;
  if not v_raised then
    raise exception 'FAIL: anon could read the products table directly';
  end if;
  reset role;

  -- ------------------------------------------------ 9. delivery areas are gated by the storefront module too
  -- get_public_storefront and get_public_storefront_products both end their
  -- where clause with shop_has_module(s.id, 'storefront'). If
  -- get_public_delivery_areas skips that gate, a shop whose module is
  -- revoked or downgraded away -- but whose storefront row is still
  -- published with offers_delivery true -- turns invisible through the
  -- first two functions while its delivery areas keep leaking through the
  -- third. That is a cost/data leak, and it is also an enumeration oracle:
  -- it tells a caller apart a de-entitled-but-published shop from a
  -- genuinely nonexistent one, which is exactly what the silence in 6/7
  -- above exists to prevent.
  update public.storefronts set offers_delivery = true where shop_id = v_shop_id;

  set local role anon;
  if not exists (select 1 from public.get_public_delivery_areas('xamdi')) then
    raise exception 'FAIL: a published shop offering delivery did not expose its delivery areas';
  end if;
  reset role;

  select id into v_free_id from public.plans where key = 'free';
  update public.shop_subscriptions
  set plan_id = v_free_id, current_period_end = now() + interval '30 days'
  where shop_id = v_shop_id;

  if public.shop_has_module(v_shop_id, 'storefront') then
    raise exception 'FAIL: a shop on Free still has the storefront module';
  end if;

  set local role anon;
  if exists (select 1 from public.get_public_delivery_areas('xamdi')) then
    raise exception 'FAIL: delivery areas leaked for a shop whose storefront module was revoked';
  end if;
  reset role;

  -- ------------------------------------------------ 10. reserved slugs are rejected at the DB, not just the client
  -- validateSlug in src/lib/storefront-slug.ts has no production caller that
  -- runs before a write, so a reserved name like 'api' must be unreachable
  -- through PostgREST too, or a shop can permanently squat a subdomain the
  -- platform needs. See 20260924000200_storefront_reserved_slugs.sql.
  v_raised := false;
  begin
    update public.shops set slug = 'api' where id = v_other_id;
  exception when check_violation then v_raised := true;
  end;
  if not v_raised then
    raise exception 'FAIL: a reserved slug was accepted';
  end if;

  update public.shops set slug = 'ordinary-shop-name' where id = v_other_id;
  if (select slug from public.shops where id = v_other_id) <> 'ordinary-shop-name' then
    raise exception 'FAIL: an ordinary slug was rejected';
  end if;

  raise notice 'PASS: storefront schema';
  raise exception 'rollback_marker';
exception
  when others then
    if sqlerrm = 'rollback_marker' then
      raise notice 'verify-storefront: all checks passed, rolled back';
    else
      raise;
    end if;
end $$;
