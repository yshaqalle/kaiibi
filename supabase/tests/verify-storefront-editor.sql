-- Claiming a slug without leaking who owns what -- the DB side of the
-- storefront editor's first step, checked against a real database.
--
-- Same shape as verify-storefront.sql: one DO block whose EXCEPTION clause
-- rolls the whole lot back, so it leaves no rows behind.
--
-- Both public.is_slug_available and public.claim_shop_slug are shop-side
-- functions granted to `authenticated` only (never `anon`), so almost
-- everything below runs with `role` switched to `authenticated` and
-- `request.jwt.claims` carrying a `sub`, the way verify-entitlements.sql and
-- verify-balances.sql establish identity for a security-definer RPC that
-- checks membership internally. The one exception is moving a shop's plan --
-- a shop cannot do that to itself (see verify-entitlements.sql #13), so that
-- write happens as postgres, same as the module-downgrade step in
-- verify-storefront.sql.

\set ON_ERROR_STOP on

do $$
declare
  v_owner_id      uuid := gen_random_uuid();
  v_outsider_id   uuid := gen_random_uuid();
  v_shop_id       uuid; -- v_owner_id's shop; does the claiming
  v_rival_id      uuid; -- v_owner_id's second shop; tries to claim a slug v_shop_id already holds
  v_outsider_shop uuid; -- v_outsider_id's shop; v_owner_id is not a member of it
  v_free_id       uuid;
  v_raised        boolean;
  v_errmsg        text;
  v_result        text;
begin
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
    values (v_owner_id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            'verify-sfe-owner-' || v_owner_id || '@example.test', '', now(), now(), now());
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
    values (v_outsider_id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            'verify-sfe-outsider-' || v_outsider_id || '@example.test', '', now(), now(), now());

  insert into public.shops (owner_id, name) values (v_owner_id, 'Xamdi Editor Shop') returning id into v_shop_id;
  insert into public.shops (owner_id, name) values (v_owner_id, 'Xamdi Rival Branch') returning id into v_rival_id;
  insert into public.shops (owner_id, name) values (v_outsider_id, 'Outsider Shop') returning id into v_outsider_shop;

  -- Fresh shops start on trial, which already carries the storefront module
  -- (verify-storefront-module-grant.sql), so every claim below is expected
  -- to succeed on its own merits until the module check at the end.

  perform set_config('request.jwt.claims', json_build_object('sub', v_owner_id)::text, true);
  perform set_config('role', 'authenticated', true);

  -- ------------------------------------------------ 1. a fresh slug is available, then is not
  if not public.is_slug_available('xamdi-editor') then
    raise exception 'FAIL: a fresh slug reads as unavailable';
  end if;

  v_result := public.claim_shop_slug(v_shop_id, 'xamdi-editor');
  if v_result <> 'xamdi-editor' then
    raise exception 'FAIL: claim_shop_slug did not return the claimed slug (got %)', v_result;
  end if;
  if (select slug from public.shops where id = v_shop_id) <> 'xamdi-editor' then
    raise exception 'FAIL: the claimed slug did not persist on the shop';
  end if;

  if public.is_slug_available('xamdi-editor') then
    raise exception 'FAIL: a just-claimed slug still reads as available';
  end if;

  -- ------------------------------------------------ 2. a reserved name is never available
  if public.is_slug_available('api') then
    raise exception 'FAIL: the reserved slug "api" reads as available';
  end if;

  -- ------------------------------------------------ 3. availability is case-insensitive
  if public.is_slug_available('XAMDI-EDITOR') then
    raise exception 'FAIL: availability check is not case-insensitive';
  end if;

  -- ------------------------------------------------ 4. only a member of the shop may claim its slug
  v_raised := false;
  begin
    perform public.claim_shop_slug(v_outsider_shop, 'stolen-by-non-member');
  exception when others then
    v_raised := true;
  end;
  if not v_raised then
    raise exception 'FAIL: a non-member claimed a slug for another shop';
  end if;

  -- ------------------------------------------------ 5. claiming a slug another shop already holds
  -- raises a distinguishable, typed error -- not a bare unique_violation.
  v_raised := false;
  v_errmsg := null;
  begin
    perform public.claim_shop_slug(v_rival_id, 'xamdi-editor');
  exception when others then
    v_raised := true;
    v_errmsg := sqlerrm;
  end;
  if not v_raised then
    raise exception 'FAIL: two shops both claimed "xamdi-editor"';
  end if;
  if v_errmsg is distinct from 'slug_taken' then
    raise exception 'FAIL: claiming a taken slug did not raise slug_taken (got %)', v_errmsg;
  end if;
  if (select slug from public.shops where id = v_rival_id) is not null then
    raise exception 'FAIL: the rival shop ended up with a slug after a failed claim';
  end if;

  -- ------------------------------------------------ 6. claim_shop_slug is gated on the storefront module too
  -- The table triggers (storefronts_module_gate) only cover the storefronts
  -- table; this function writes shops directly, which they never see.
  select id into v_free_id from public.plans where key = 'free';

  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims', null, true);
  update public.shop_subscriptions
  set plan_id = v_free_id, current_period_end = now() + interval '30 days'
  where shop_id = v_rival_id;

  if public.shop_has_module(v_rival_id, 'storefront') then
    raise exception 'FAIL: the rival shop still has the storefront module after moving to Free';
  end if;

  perform set_config('request.jwt.claims', json_build_object('sub', v_owner_id)::text, true);
  perform set_config('role', 'authenticated', true);

  v_raised := false;
  begin
    perform public.claim_shop_slug(v_rival_id, 'rival-without-module');
  exception when others then
    v_raised := true;
  end;
  if not v_raised then
    raise exception 'FAIL: a shop without the storefront module claimed a slug';
  end if;
  if (select slug from public.shops where id = v_rival_id) is not null then
    raise exception 'FAIL: a slug was claimed despite the missing storefront module';
  end if;

  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims', null, true);

  -- ------------------------------- N. the tables are actually reachable
  -- RLS narrows what a role may see; it does not grant the role reach. A table
  -- with policies but no grant fails with 42501 for every caller, and neither a
  -- security definer function nor a superuser-run test can see that happen.
  if not has_table_privilege('authenticated', 'public.storefronts', 'SELECT') then
    raise exception 'FAIL: authenticated cannot select storefronts -- RLS policies without a table grant are decorative';
  end if;
  if not has_table_privilege('authenticated', 'public.storefronts', 'INSERT') then
    raise exception 'FAIL: authenticated cannot insert storefronts';
  end if;
  if not has_table_privilege('authenticated', 'public.storefronts', 'UPDATE') then
    raise exception 'FAIL: authenticated cannot update storefronts';
  end if;
  if not has_table_privilege('authenticated', 'public.storefront_delivery_areas', 'SELECT') then
    raise exception 'FAIL: authenticated cannot select storefront_delivery_areas';
  end if;
  if not has_table_privilege('authenticated', 'public.storefront_delivery_areas', 'DELETE') then
    raise exception 'FAIL: authenticated cannot delete storefront_delivery_areas';
  end if;

  -- anon must NOT get direct table reach; it reads only through the
  -- explicit-column-list functions that keep products.cost_cents unreachable.
  if has_table_privilege('anon', 'public.storefronts', 'SELECT') then
    raise exception 'FAIL: anon can read the storefronts table directly, routing around the public read functions';
  end if;

  raise notice 'PASS: storefront slug claim';
  raise exception 'rollback_marker';
exception
  when others then
    if sqlerrm = 'rollback_marker' then
      raise notice 'verify-storefront-editor: all checks passed, rolled back';
    else
      raise;
    end if;
end $$;
