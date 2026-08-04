-- End-to-end verification of the entitlement system against a real database.
-- Everything runs inside one DO block whose EXCEPTION clause rolls the whole
-- lot back, so it leaves no rows behind.
--
-- Covers what unit tests can't reach: the trial trigger, the status resolver's
-- arithmetic against now(), override precedence, the limit triggers, and the
-- rule that matters most commercially and ethically -- an expired shop can
-- still READ everything it owns.

\set ON_ERROR_STOP on

do $$
declare
  v_user_id     uuid := gen_random_uuid();
  v_shop_id     uuid;
  v_location_id uuid;
  v_free_id     uuid;
  v_pro_id      uuid;
  v_status      text;
  v_plan_key    text;
  v_limit       integer;
  v_count       integer;
  v_raised      boolean;
  v_detail      text;
  v_ents        jsonb;
begin
  select id into v_free_id from public.plans where key = 'free';
  select id into v_pro_id  from public.plans where key = 'pro';

  insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
    values (v_user_id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            'verify-' || v_user_id || '@example.test', '', now(), now(), now());

  -- ---------------------------------------------------------------- 1. trial
  insert into public.shops (owner_id, name) values (v_user_id, 'Entitlement Shop') returning id into v_shop_id;

  if not exists (select 1 from public.shop_subscriptions where shop_id = v_shop_id) then
    raise exception 'FAIL: creating a shop did not start a trial';
  end if;

  if public.shop_effective_status(v_shop_id) <> 'trialing' then
    raise exception 'FAIL: a fresh shop is not trialing (got %)', public.shop_effective_status(v_shop_id);
  end if;

  if (public.shop_effective_plan(v_shop_id)).key <> 'trial' then
    raise exception 'FAIL: a fresh shop is not on the trial plan';
  end if;

  -- The trial grants everything, so an evaluating shop sees the whole product.
  if not public.shop_has_module(v_shop_id, 'payroll') or not public.shop_has_module(v_shop_id, 'multi_location') then
    raise exception 'FAIL: the trial does not grant full access';
  end if;

  if public.shop_limit(v_shop_id, 'products') is not null then
    raise exception 'FAIL: the trial caps products';
  end if;

  -- --------------------------------------------------- 2. expiry falls to free
  update public.shop_subscriptions
  set trial_ends_at = now() - interval '100 days', grace_until = now() - interval '93 days'
  where shop_id = v_shop_id;

  if public.shop_effective_status(v_shop_id) <> 'expired' then
    raise exception 'FAIL: a lapsed trial is not expired';
  end if;

  if (public.shop_effective_plan(v_shop_id)).key <> 'free' then
    raise exception 'FAIL: a lapsed shop did not fall back to free (got %)', (public.shop_effective_plan(v_shop_id)).key;
  end if;

  -- The direction that matters: failing closed, never open.
  if public.shop_has_module(v_shop_id, 'accounting') then
    raise exception 'FAIL: an expired shop still has accounting';
  end if;
  if not public.shop_has_module(v_shop_id, 'pos') then
    raise exception 'FAIL: free lost POS -- a lapsed shop must still be able to run its till';
  end if;

  -- ------------------------------------------------------------- 3. the grace
  update public.shop_subscriptions set grace_until = now() + interval '3 days' where shop_id = v_shop_id;
  if public.shop_effective_status(v_shop_id) <> 'grace' then
    raise exception 'FAIL: within grace_until but not in grace';
  end if;
  -- Grace keeps the paid plan: mobile-money payment is confirmed by hand, so a
  -- shop that paid yesterday must not be locked out today.
  if (public.shop_effective_plan(v_shop_id)).key <> 'trial' then
    raise exception 'FAIL: grace did not keep the subscribed plan';
  end if;

  -- ----------------------------------------------------- 4. converted = active
  update public.shop_subscriptions
  set plan_id = v_free_id, current_period_end = now() + interval '20 days', grace_until = now() + interval '27 days'
  where shop_id = v_shop_id;
  if public.shop_effective_status(v_shop_id) <> 'active' then
    raise exception 'FAIL: a paid period does not read as active';
  end if;

  -- -------------------------------------------------------- 5. the store limit
  -- Free includes one store. The shop already has the primary one its creation
  -- backfilled, so the next is the one that must be refused.
  select count(*) into v_count from public.shop_locations where shop_id = v_shop_id;
  if v_count <> 0 then
    raise exception 'FAIL: expected no auto-created location for a new shop, found %', v_count;
  end if;

  insert into public.shop_locations (shop_id, name, is_primary) values (v_shop_id, 'Main', true) returning id into v_location_id;

  v_raised := false;
  begin
    insert into public.shop_locations (shop_id, name) values (v_shop_id, 'Branch 2');
  exception when others then
    v_raised := true;
    v_detail := sqlerrm;
  end;
  if not v_raised then
    raise exception 'FAIL: a second store was allowed on the Free plan';
  end if;
  if v_detail <> 'limit_reached' then
    raise exception 'FAIL: the store cap raised the wrong error (%)', v_detail;
  end if;

  -- The first store must remain fully editable. A downgrade freezes growth; it
  -- never takes away what a shop already has.
  update public.shop_locations set name = 'Main (renamed)' where id = v_location_id;
  if not exists (select 1 from public.shop_locations where id = v_location_id and name = 'Main (renamed)') then
    raise exception 'FAIL: the existing store became uneditable at the cap';
  end if;

  -- ------------------------------------------------ 6. zero means zero, exactly
  -- Free grants vendors: 0 -- reachable, but nothing can be added.
  v_raised := false;
  begin
    insert into public.vendors (shop_id, name) values (v_shop_id, 'Acme');
  exception when others then v_raised := true;
  end;
  if not v_raised then
    raise exception 'FAIL: a zero limit did not block';
  end if;

  -- -------------------------------------------------- 7. counters track deletes
  insert into public.products (shop_id, name, price_cents)
  select v_shop_id, 'p' || g, 100 from generate_series(1, 50) g;

  select count into v_count from public.shop_usage_counters where shop_id = v_shop_id and resource = 'products';
  if v_count <> 50 then
    raise exception 'FAIL: the product counter says % after 50 inserts', v_count;
  end if;

  v_raised := false;
  begin
    insert into public.products (shop_id, name, price_cents) values (v_shop_id, 'one too many', 100);
  exception when others then v_raised := true;
  end;
  if not v_raised then
    raise exception 'FAIL: the 51st product was allowed on a 50 cap';
  end if;

  delete from public.products where shop_id = v_shop_id and name = 'p1';
  select count into v_count from public.shop_usage_counters where shop_id = v_shop_id and resource = 'products';
  if v_count <> 49 then
    raise exception 'FAIL: deleting a product left the counter at %', v_count;
  end if;
  -- Freed slot is genuinely reusable.
  insert into public.products (shop_id, name, price_cents) values (v_shop_id, 'now it fits', 100);

  -- ------------------------------------------------------ 8. override precedence
  insert into public.shop_entitlement_overrides (shop_id, kind, key, value, reason)
  values (v_shop_id, 'limit', 'products', '5000'::jsonb, 'verify');
  select public.shop_limit(v_shop_id, 'products') into v_limit;
  if v_limit <> 5000 then
    raise exception 'FAIL: a limit override did not beat the plan (got %)', v_limit;
  end if;

  insert into public.shop_entitlement_overrides (shop_id, kind, key, expires_at, reason)
  values (v_shop_id, 'module', 'payroll', now() + interval '30 days', 'verify');
  if not public.shop_has_module(v_shop_id, 'payroll') then
    raise exception 'FAIL: a module override did not grant the module';
  end if;

  -- An expired override must stop granting.
  update public.shop_entitlement_overrides set expires_at = now() - interval '1 day'
  where shop_id = v_shop_id and kind = 'module' and key = 'payroll';
  if public.shop_has_module(v_shop_id, 'payroll') then
    raise exception 'FAIL: an expired override still grants its module';
  end if;

  -- --------------------------------------------------------- 9. the kill switch
  update public.shop_subscriptions set manual_status = 'suspended' where shop_id = v_shop_id;
  if public.shop_effective_status(v_shop_id) <> 'suspended' then
    raise exception 'FAIL: manual_status is not honoured';
  end if;
  if public.shop_has_module(v_shop_id, 'pos') then
    raise exception 'FAIL: a suspended shop kept a module';
  end if;
  update public.shop_subscriptions set manual_status = 'active' where shop_id = v_shop_id;

  -- --------------------------------- 10. reads survive expiry (the ethical one)
  -- A shop that stops paying keeps full sight of its own records. This is the
  -- check that would catch someone "tidying up" by adding a module gate to a
  -- SELECT policy.
  update public.shop_subscriptions
  set plan_id = v_free_id, trial_ends_at = now() - interval '100 days',
      current_period_end = null, grace_until = now() - interval '93 days'
  where shop_id = v_shop_id;

  perform set_config('request.jwt.claims', json_build_object('sub', v_user_id)::text, true);
  perform set_config('role', 'authenticated', true);

  select count(*) into v_count from public.products where shop_id = v_shop_id;
  if v_count = 0 then
    raise exception 'FAIL: an expired shop cannot read its own products';
  end if;

  select count(*) into v_count from public.shop_locations where shop_id = v_shop_id;
  if v_count = 0 then
    raise exception 'FAIL: an expired shop cannot read its own stores';
  end if;

  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims', null, true);

  -- ------------------------------------------- 11. no subscription = fail closed
  delete from public.shop_subscriptions where shop_id = v_shop_id;
  if (public.shop_effective_plan(v_shop_id)).key <> 'free' then
    raise exception 'FAIL: a shop with no subscription did not fail closed to free';
  end if;
  if public.shop_has_module(v_shop_id, 'accounting') then
    raise exception 'FAIL: a shop with no subscription reads as entitled';
  end if;

  -- ------------------------------------------------- 12. the client payload
  v_ents := public.my_shop_entitlements(v_shop_id);
  if v_ents -> 'usage' ->> 'products' is null then
    raise exception 'FAIL: my_shop_entitlements reports no product usage';
  end if;
  if v_ents ->> 'status' is null or v_ents -> 'plan' ->> 'key' is null then
    raise exception 'FAIL: my_shop_entitlements is missing status or plan';
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

-- Proof the block left nothing behind.
select case when count(*) = 0 then 'CLEAN: no rows left behind'
            else 'WARNING: ' || count(*) || ' verify shops remain' end as cleanup
from public.shops where name = 'Entitlement Shop';
