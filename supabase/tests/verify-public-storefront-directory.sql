-- list_public_storefronts, checked against a real database.
--
-- Same shape as verify-storefront-categories.sql: one DO block whose EXCEPTION
-- clause rolls the whole lot back, so it leaves no rows behind. And the same
-- role discipline -- the setup writes run as postgres (a superuser, which
-- bypasses RLS and grants both), and every call to the function under test is
-- wrapped in `set local role anon` / `reset role`, because the anon grant is
-- half of what this function IS and a superuser call would never exercise it.
--
-- What this function must get right, in one sentence: it is the first public
-- read on this database that is not keyed by a slug, so it must never list a
-- shop that has not chosen to be listed.

\set ON_ERROR_STOP on

do $$
declare
  v_user_id uuid := gen_random_uuid();
  v_alpha   uuid;
  v_beta    uuid;
  v_count   integer;
  v_name    text;
  v_free_id uuid;
  v_result  text;
begin
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
    values (v_user_id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            'verify-sfdir-' || v_user_id || '@example.test', '', now(), now(), now());

  insert into public.shops (owner_id, name, slug) values (v_user_id, 'Alpha Hardware', 'dir-alpha')
    returning id into v_alpha;
  insert into public.shops (owner_id, name, slug) values (v_user_id, 'Beta Grocers', 'dir-beta')
    returning id into v_beta;

  insert into public.storefronts (shop_id) values (v_alpha);
  insert into public.storefronts (shop_id) values (v_beta);

  insert into public.shop_locations (shop_id, name, city, is_primary) values
    (v_alpha, 'Main', 'Hargeisa', true),
    (v_beta,  'Main', 'Borama',   true);

  -- Alpha: two shoppable, plus one unlisted and one sold out that must not be
  -- counted. Beta: one shoppable, so Alpha sorts first on count.
  insert into public.products (shop_id, name, category, price_cents, cost_cents, stock, is_listed_online) values
    (v_alpha, 'Hammer',        'Tools', 900,  400, 5, true),
    (v_alpha, 'Nails 1kg',     'Tools', 300,  100, 9, true),
    (v_alpha, 'Trade-only',    'Bulk',  5000, 3000, 9, false),
    (v_alpha, 'Sold-out saw',  'Tools', 1200, 600, 0, true),
    (v_beta,  'Dates 1kg',     'Food',  700,  300, 6, true);

  -- ------------------------------------------------ 1. unpublished lists nothing
  set local role anon;
  if exists (select 1 from public.list_public_storefronts() where slug in ('dir-alpha', 'dir-beta')) then
    raise exception 'FAIL: an unpublished storefront was listed in the directory';
  end if;
  reset role;

  update public.storefronts set published_at = now() where shop_id in (v_alpha, v_beta);

  -- ------------------------------------------------ 2. published shops are listed
  set local role anon;
  select count(*) into v_count
    from public.list_public_storefronts() where slug in ('dir-alpha', 'dir-beta');
  if v_count <> 2 then
    raise exception 'FAIL: expected 2 published shops, got %', v_count;
  end if;

  -- ------------------------------------------------ 3. the count is what a customer can actually buy
  -- Unlisted and sold-out products must not inflate it: the number on the card
  -- is a promise about what is behind it, and 4 here would be a lie twice over.
  select product_count into v_count
    from public.list_public_storefronts() where slug = 'dir-alpha';
  if v_count <> 2 then
    raise exception 'FAIL: dir-alpha counted % items, expected 2 (unlisted or sold-out leaked)', v_count;
  end if;

  -- ------------------------------------------------ 4. shops with stock come first
  select shop_name into v_name
    from public.list_public_storefronts()
    where slug in ('dir-alpha', 'dir-beta')
    limit 1;
  if v_name <> 'Alpha Hardware' then
    raise exception 'FAIL: expected the fuller shop first, got %', v_name;
  end if;

  -- ------------------------------------------------ 5. the city filter, case- and space-insensitively
  if not exists (select 1 from public.list_public_storefronts('  hArGeIsA ') where slug = 'dir-alpha') then
    raise exception 'FAIL: the city filter did not match on case and whitespace';
  end if;
  if exists (select 1 from public.list_public_storefronts('Hargeisa') where slug = 'dir-beta') then
    raise exception 'FAIL: the city filter returned a shop from another city';
  end if;

  -- ------------------------------------------------ 6. p_limit is clamped, never trusted
  -- `limit null` is no limit at all, and a zero or negative limit from an
  -- anonymous caller must not error either.
  select count(*) into v_count from public.list_public_storefronts(null, null);
  if v_count < 1 then
    raise exception 'FAIL: a null limit returned nothing';
  end if;
  select count(*) into v_count from public.list_public_storefronts(null, 0);
  if v_count <> 1 then
    raise exception 'FAIL: a zero limit was not clamped to 1, got %', v_count;
  end if;
  select count(*) into v_count from public.list_public_storefronts(null, 100000);
  if v_count > 100 then
    raise exception 'FAIL: an absurd limit was not capped at 100, got %', v_count;
  end if;
  reset role;

  -- ------------------------------------------------ 7. no phone number, by shape
  -- A list of every published shop's WhatsApp number is a spam list. Asserted
  -- against the function's declared result rather than a row, so it fails even
  -- when no fixture happens to have a number set.
  select pg_get_function_result(p.oid) into v_result
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'list_public_storefronts';
  if v_result ilike '%whatsapp%' then
    raise exception 'FAIL: the directory returns a phone number: %', v_result;
  end if;

  -- ------------------------------------------------ 8. the module gate, same as every other public read
  select id into v_free_id from public.plans where key = 'free';
  update public.shop_subscriptions
     set plan_id = v_free_id, current_period_end = now() + interval '30 days'
   where shop_id = v_alpha;

  if public.shop_has_module(v_alpha, 'storefront') then
    raise exception 'FAIL: a shop on Free still has the storefront module';
  end if;

  set local role anon;
  if exists (select 1 from public.list_public_storefronts() where slug = 'dir-alpha') then
    raise exception 'FAIL: a shop was listed with the storefront module off';
  end if;
  -- And the shop that still has it is unaffected.
  if not exists (select 1 from public.list_public_storefronts() where slug = 'dir-beta') then
    raise exception 'FAIL: revoking one shop''s module hid another shop';
  end if;
  reset role;

  raise notice 'PASS: list_public_storefronts';
  raise exception 'rollback-verify-public-storefront-directory';
exception
  when others then
    if sqlerrm = 'rollback-verify-public-storefront-directory' then
      raise notice 'verify-public-storefront-directory: all checks passed, rolled back';
    else
      raise;
    end if;
end $$;
