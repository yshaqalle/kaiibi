-- get_public_storefront_categories, checked against a real database.
--
-- Same shape as verify-storefront.sql: one DO block whose EXCEPTION clause
-- rolls the whole lot back, so it leaves no rows behind. And the same role
-- discipline -- the setup writes run as postgres (a superuser, which bypasses
-- RLS and grants both), and every call to the function under test is wrapped
-- in `set local role anon` / `reset role`, because the anon grant is half of
-- what this function IS and a superuser call would never exercise it.
--
-- What this function must get right, in one sentence: it is a way INTO a
-- catalogue, so it must never name a category the customer cannot then see
-- the products of.

\set ON_ERROR_STOP on

do $$
declare
  v_user_id uuid := gen_random_uuid();
  v_shop_id uuid;
  v_count integer;
  v_image text;
  v_free_id uuid;
begin
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
    values (v_user_id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            'verify-sfcat-' || v_user_id || '@example.test', '', now(), now(), now());

  insert into public.shops (owner_id, name, slug) values (v_user_id, 'Barwaaqo Grocers', 'barwaaqo-cat')
    returning id into v_shop_id;

  -- A new shop's plan carries the storefront module already (see
  -- shop_has_module / shop_effective_plan) -- there is no join table to insert
  -- into. Check 6 below revokes it the way verify-storefront.sql does: by
  -- moving the shop to Free.
  insert into public.storefronts (shop_id) values (v_shop_id);

  insert into public.products (shop_id, name, category, price_cents, cost_cents, stock, is_listed_online) values
    (v_shop_id, 'Basmati Rice 5kg',  'Dry goods', 1200, 700, 8, true),
    (v_shop_id, 'Sunflower Oil 3L',  'Dry goods',  900, 400, 4, true),
    (v_shop_id, 'Dates 1kg',         'Produce',    700, 300, 6, true),
    -- Excluded three different ways, one per row below.
    (v_shop_id, 'Trade-only sack',   'Wholesale', 5000, 3000, 9, false),  -- not listed online
    (v_shop_id, 'Sold-out tea',      'Beverages',  500, 200, 0, true),    -- no stock
    (v_shop_id, 'Uncategorised bit', null,         100,  50, 3, true);    -- no category

  -- ------------------------------------------------ 1. unpublished shows nothing
  set local role anon;
  if exists (select 1 from public.get_public_storefront_categories('barwaaqo-cat')) then
    raise exception 'FAIL: an unpublished storefront returned categories';
  end if;
  reset role;

  update public.storefronts set published_at = now() where shop_id = v_shop_id;

  -- ------------------------------------------------ 2. only the categories a customer can shop
  set local role anon;
  select count(*) into v_count from public.get_public_storefront_categories('barwaaqo-cat');
  if v_count <> 2 then
    raise exception 'FAIL: expected 2 shoppable categories, got % (unlisted, sold-out or null-category leaked)', v_count;
  end if;

  -- A category whose every product is sold out is a dead end with a photo on
  -- it, not a way in.
  if exists (
    select 1 from public.get_public_storefront_categories('barwaaqo-cat') where name = 'Beverages'
  ) then
    raise exception 'FAIL: a category with no stock was offered as a way in';
  end if;

  -- An is_listed_online = false product must not drag its category onto a
  -- public page -- the band would name a department the grid cannot show.
  if exists (
    select 1 from public.get_public_storefront_categories('barwaaqo-cat') where name = 'Wholesale'
  ) then
    raise exception 'FAIL: an unlisted product exposed its category';
  end if;

  -- ------------------------------------------------ 3. the count matches what is behind the tile
  select product_count into v_count
    from public.get_public_storefront_categories('barwaaqo-cat') where name = 'Dry goods';
  if v_count <> 2 then
    raise exception 'FAIL: Dry goods counted %, expected 2 (the count must match the grid)', v_count;
  end if;

  -- ------------------------------------------------ 4. an unknown slug is silent
  if exists (select 1 from public.get_public_storefront_categories('no-such-shop')) then
    raise exception 'FAIL: an unknown slug returned categories';
  end if;
  reset role;

  -- ------------------------------------------------ 5. a photo when there is one, and no row lost when there is not
  -- `categories` is a separate per-shop table joined BY NAME, and a shop can
  -- have typed a category onto products without ever creating a row in it.
  -- That category must still appear, just without a picture -- an inner join
  -- here would hide half the catalogue from the band while the grid still
  -- showed it.
  insert into public.categories (shop_id, name, image_url)
    values (v_shop_id, 'Dry goods', 'https://example.test/dry.jpg');

  set local role anon;
  select image_url into v_image
    from public.get_public_storefront_categories('barwaaqo-cat') where name = 'Dry goods';
  if v_image is distinct from 'https://example.test/dry.jpg' then
    raise exception 'FAIL: a category with a photo did not return it (got %)', v_image;
  end if;

  select image_url into v_image
    from public.get_public_storefront_categories('barwaaqo-cat') where name = 'Produce';
  if v_image is not null then
    raise exception 'FAIL: a category with no categories row returned a photo (got %)', v_image;
  end if;

  select count(*) into v_count from public.get_public_storefront_categories('barwaaqo-cat');
  if v_count <> 2 then
    raise exception 'FAIL: adding a categories row changed the category COUNT to % -- the join duplicated rows', v_count;
  end if;
  reset role;

  -- ------------------------------------------------ 6. the module gate, same as every other public read
  --
  -- A de-entitled-but-published shop must go silent HERE too. If this function
  -- skipped the gate, such a shop would keep leaking its department names --
  -- and, as verify-storefront.sql's own note on the same hazard says, that is
  -- also an enumeration oracle: it tells a de-entitled shop apart from a
  -- nonexistent one.
  select id into v_free_id from public.plans where key = 'free';
  update public.shop_subscriptions
  set plan_id = v_free_id, current_period_end = now() + interval '30 days'
  where shop_id = v_shop_id;

  if public.shop_has_module(v_shop_id, 'storefront') then
    raise exception 'FAIL: a shop on Free still has the storefront module';
  end if;

  set local role anon;
  if exists (select 1 from public.get_public_storefront_categories('barwaaqo-cat')) then
    raise exception 'FAIL: categories were readable with the storefront module off';
  end if;
  reset role;

  raise notice 'PASS: get_public_storefront_categories';
  raise exception 'rollback-verify-storefront-categories';
exception
  when others then
    if sqlerrm = 'rollback-verify-storefront-categories' then
      raise notice 'verify-storefront-categories: all checks passed, rolled back';
    else
      raise;
    end if;
end $$;
