-- The storefront module's plan packaging: granted to trial and pro, withheld
-- from free and standard.
--
-- src/lib/entitlements.test.ts only knows the catalog (that 'storefront'
-- exists and isn't in FREE_FALLBACK); it cannot see what the seeded plan rows
-- actually grant, and a plan misconfigured here would leave the module listed
-- in the catalog with nothing to unlock it. This is the counterpart check
-- against the real data, following the same shape as verify-entitlements.sql.

\set ON_ERROR_STOP on

do $$
declare
  v_user_id       uuid := gen_random_uuid();
  v_shop_id       uuid;
  v_free_modules  text[];
  v_std_modules   text[];
  v_trial_modules text[];
  v_pro_modules   text[];
  v_pro_id        uuid;
  v_std_id        uuid;
begin
  select modules into v_trial_modules from public.plans where key = 'trial';
  select modules into v_free_modules  from public.plans where key = 'free';
  select modules into v_std_modules   from public.plans where key = 'standard';
  select modules into v_pro_modules   from public.plans where key = 'pro';
  select id      into v_pro_id        from public.plans where key = 'pro';
  select id      into v_std_id        from public.plans where key = 'standard';

  -- ------------------------------------------------------- 1. the raw arrays
  if not ('storefront' = any(v_trial_modules)) then
    raise exception 'FAIL: trial does not grant storefront';
  end if;
  if not ('storefront' = any(v_pro_modules)) then
    raise exception 'FAIL: pro does not grant storefront';
  end if;
  if 'storefront' = any(v_free_modules) then
    raise exception 'FAIL: free grants storefront';
  end if;
  if 'storefront' = any(v_std_modules) then
    raise exception 'FAIL: standard grants storefront';
  end if;

  -- --------------------------------------- 2. end to end, through a real shop
  -- The array check above proves the seed; this proves the thing every write
  -- gate actually calls.
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
    values (v_user_id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            'verify-sfgrant-' || v_user_id || '@example.test', '', now(), now(), now());

  insert into public.shops (owner_id, name) values (v_user_id, 'Storefront Grant Shop') returning id into v_shop_id;

  -- A fresh shop starts on trial, which must already carry the module.
  if not public.shop_has_module(v_shop_id, 'storefront') then
    raise exception 'FAIL: a trialing shop does not have the storefront module';
  end if;

  -- Standard does not carry it.
  update public.shop_subscriptions
  set plan_id = v_std_id, current_period_end = now() + interval '30 days'
  where shop_id = v_shop_id;
  if public.shop_has_module(v_shop_id, 'storefront') then
    raise exception 'FAIL: a shop on Standard has the storefront module';
  end if;

  -- Pro carries it.
  update public.shop_subscriptions
  set plan_id = v_pro_id, current_period_end = now() + interval '30 days'
  where shop_id = v_shop_id;
  if not public.shop_has_module(v_shop_id, 'storefront') then
    raise exception 'FAIL: a shop on Pro does not have the storefront module';
  end if;

  raise notice 'ALL CHECKS PASSED';
  -- Deliberate rollback: everything above was throwaway.
  raise exception 'rollback_marker';
exception
  when others then
    if sqlerrm <> 'rollback_marker' then
      raise;
    end if;
end $$;
