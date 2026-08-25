-- The storefront schema, checked against a real database.
--
-- Everything runs inside one DO block whose EXCEPTION clause rolls the whole lot
-- back, so it leaves no rows behind -- same shape as verify-entitlements.sql.

\set ON_ERROR_STOP on

do $$
declare
  v_user_id uuid := gen_random_uuid();
  v_shop_id uuid;
  v_other_id uuid;
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
  if exists (select 1 from public.get_public_storefront('xamdi')) then
    raise exception 'FAIL: an unpublished storefront was readable';
  end if;

  update public.storefronts set published_at = now() where shop_id = v_shop_id;

  if not exists (select 1 from public.get_public_storefront('xamdi')) then
    raise exception 'FAIL: a published storefront was not readable';
  end if;

  -- ------------------------------------------------ 7. an unknown slug is silent
  if exists (select 1 from public.get_public_storefront('no-such-shop')) then
    raise exception 'FAIL: an unknown slug returned a row';
  end if;

  -- ------------------------------------------------ 8. only listed products, never cost
  insert into public.products (shop_id, name, price_cents, cost_cents, stock, is_listed_online)
    values (v_shop_id, 'Anker 20W charger', 1200, 700, 5, true);
  insert into public.products (shop_id, name, price_cents, cost_cents, stock, is_listed_online)
    values (v_shop_id, 'Trade-only cable', 500, 100, 5, false);

  if (select count(*) from public.get_public_storefront_products('xamdi')) <> 1 then
    raise exception 'FAIL: the public product list did not honour is_listed_online';
  end if;

  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'get_public_storefront_products'
      and column_name like '%cost%'
  ) then
    raise exception 'FAIL: the public product function exposes a cost column';
  end if;

  -- The belt-and-braces version: whatever the function returns, cost must not be
  -- findable in it. A future edit that adds `select p.*` fails here.
  if exists (
    select 1
    from public.get_public_storefront_products('xamdi') pp
    where (to_jsonb(pp) ? 'cost_cents')
  ) then
    raise exception 'FAIL: cost_cents leaked into the public product payload';
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
