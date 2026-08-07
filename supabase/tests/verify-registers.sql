-- Registers, sessions, and whether the drawer adds up.
--
-- The headline question is the last one: does a moving exchange rate change the
-- variance? It must not. Every other check here exists to make that one
-- trustworthy -- if expected cash is computed wrong, a rate-invariant variance
-- is just a consistently wrong number.
--
-- Everything runs inside one DO block whose EXCEPTION clause rolls it all back.

\set ON_ERROR_STOP on

do $$
declare
  v_owner_id uuid := gen_random_uuid();
  v_staff_user uuid := gen_random_uuid();
  v_shop_id uuid;
  v_location_id uuid;
  v_other_location_id uuid;
  v_product_id uuid;
  v_role_id uuid;
  v_owner_member uuid;
  v_staff_member uuid;
  v_register_a uuid;
  v_register_b uuid;
  v_mobile_a uuid;
  v_mobile_b uuid;
  v_session uuid;
  v_session2 uuid;
  v_sale_id uuid;
  v_item_id uuid;
  v_items jsonb;
  v_expected integer;
  v_variance integer;
  v_variance_slsh integer;
  v_base integer;
  v_count integer;
  v_registers integer;
  v_ok boolean;
begin
  ------------------------------------------------------------------
  -- Fixture
  ------------------------------------------------------------------
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
    values (v_owner_id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            'verify-registers-owner-' || v_owner_id || '@example.test', '', now(), now(), now());
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
    values (v_staff_user, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            'verify-registers-staff-' || v_staff_user || '@example.test', '', now(), now(), now());

  insert into public.shops (owner_id, name) values (v_owner_id, 'Register Verify Shop')
    returning id into v_shop_id;

  perform set_config('request.jwt.claims', json_build_object('sub', v_owner_id)::text, true);
  perform set_config('role', 'authenticated', true);

  insert into public.shop_locations (shop_id, name, is_primary)
    values (v_shop_id, 'Airport Road', true) returning id into v_location_id;
  insert into public.shop_locations (shop_id, name)
    values (v_shop_id, 'Hargeisa Central') returning id into v_other_location_id;

  insert into public.products (shop_id, name, price_cents, cost_cents)
    values (v_shop_id, 'Verify Cream', 1000, 400) returning id into v_product_id;
  insert into public.product_location_stock (product_id, location_id, stock)
    values (v_product_id, v_location_id, 100000);

  -- The owner has no shop_members row by design (adminship is shops.owner_id),
  -- but a session needs a member, so give them one.
  insert into public.roles (shop_id, name, permissions)
    values (v_shop_id, 'Cashier', array['pos.access']) returning id into v_role_id;
  insert into public.shop_members (shop_id, user_id, role_id, full_name, active)
    values (v_shop_id, v_owner_id, v_role_id, 'Owner Omar', true) returning id into v_owner_member;
  insert into public.shop_members (shop_id, user_id, role_id, full_name, active)
    values (v_shop_id, v_staff_user, v_role_id, 'Amina Hassan', true) returning id into v_staff_member;

  -- SLSH is seeded active at 115 for every shop by 0015; make the rate explicit
  -- so the rate-drift check below has a known starting point.
  update public.shop_currencies set rate_to_usd = 115, active = true
    where shop_id = v_shop_id and code = 'SLSH';

  insert into public.registers (shop_id, location_id, name)
    values (v_shop_id, v_location_id, 'Register 1') returning id into v_register_a;
  insert into public.registers (shop_id, location_id, name)
    values (v_shop_id, v_location_id, 'Register 2') returning id into v_register_b;

  v_items := jsonb_build_array(jsonb_build_object('product_id', v_product_id, 'quantity', 1, 'discount_cents', 0));

  ------------------------------------------------------------------
  raise notice '=== 1. Opening a register, and a second open is refused ===';
  ------------------------------------------------------------------
  select public.open_register_session(
    v_register_a, v_owner_member,
    jsonb_build_array(
      jsonb_build_object('currency_code', 'USD',  'amount_minor', 11850, 'rate_to_usd', 1),
      jsonb_build_object('currency_code', 'SLSH', 'amount_minor', 4000000, 'rate_to_usd', 115)
    ),
    'opening float'
  ) into v_session;
  if v_session is null then raise exception 'FAIL: no session returned'; end if;

  select count(*) into v_count from public.register_session_cash where session_id = v_session;
  if v_count <> 2 then raise exception 'FAIL: expected 2 cash rows, got %', v_count; end if;
  raise notice 'OK: session opened with two currencies';

  v_ok := false;
  begin
    perform public.open_register_session(v_register_a, v_owner_member, '[]'::jsonb, null);
  exception when others then v_ok := true;
  end;
  if not v_ok then raise exception 'FAIL: a second open on the same register was allowed'; end if;
  raise notice 'OK: second open on the same register refused';

  ------------------------------------------------------------------
  raise notice '=== 2. complete_sale refuses a foreign / closed session ===';
  ------------------------------------------------------------------
  v_ok := false;
  begin
    perform public.complete_sale(
      v_shop_id, v_items,
      jsonb_build_array(jsonb_build_object('method', 'cash', 'amount_cents', 1000)),
      null, null, null, null, 0, null, null, v_other_location_id, 0, v_session
    );
  exception when others then v_ok := true;
  end;
  if not v_ok then raise exception 'FAIL: a sale at another location accepted this session'; end if;
  raise notice 'OK: session at a different location refused';

  ------------------------------------------------------------------
  raise notice '=== 3. Expected cash: USD excludes foreign-settled cash ===';
  ------------------------------------------------------------------
  -- Two plain USD cash sales: $10.00 each, one with change given.
  perform public.complete_sale(
    v_shop_id, v_items,
    jsonb_build_array(jsonb_build_object('method', 'cash', 'amount_cents', 1000)),
    null, null, null, null, 0, null, null, v_location_id, 0, v_session);
  perform public.complete_sale(
    v_shop_id, v_items,
    jsonb_build_array(jsonb_build_object('method', 'cash', 'amount_cents', 1000, 'tendered_cents', 2000)),
    null, null, null, null, 0, null, null, v_location_id, 0, v_session);

  -- A ZAAD sale: never in the drawer, must not appear in either bucket.
  perform public.complete_sale(
    v_shop_id, v_items,
    jsonb_build_array(jsonb_build_object('method', 'zaad', 'amount_cents', 1000)),
    null, null, null, null, 0, null, null, v_location_id, 0, v_session);

  -- A SLSH cash sale. THE TRAP: amount_cents is the USD equivalent applied to
  -- the sale; the notes that entered the drawer are foreign_amount_cents. The
  -- customer hands over 2,000.00 SLSH and gets 850.00 SLSH back.
  perform public.complete_sale(
    v_shop_id, v_items,
    jsonb_build_array(jsonb_build_object(
      'method', 'cash', 'amount_cents', 1000,
      'currency_code', 'SLSH', 'exchange_rate', 115,
      'foreign_amount_cents', 200000, 'foreign_change_cents', 85000)),
    null, null, null, null, 0, null, null, v_location_id, 0, v_session);

  select expected_minor into v_expected
    from public.register_session_expected(v_session) where currency_code = 'USD';
  -- 11850 float + 1000 + 1000. NOT the shilling sale's 1000, and not the ZAAD.
  if v_expected <> 13850 then
    raise exception 'FAIL: USD expected should be 13850, got % (foreign cash double-counted?)', v_expected;
  end if;
  raise notice 'OK: USD expected % excludes foreign-settled and non-cash', v_expected;

  select expected_minor into v_expected
    from public.register_session_expected(v_session) where currency_code = 'SLSH';
  -- 4,000,000 float + 200,000 in - 85,000 change out.
  if v_expected <> 4115000 then
    raise exception 'FAIL: SLSH expected should be 4115000, got %', v_expected;
  end if;
  raise notice 'OK: SLSH expected % is notes in minus change out', v_expected;

  ------------------------------------------------------------------
  raise notice '=== 4. A cash refund comes out of the refunder''s drawer ===';
  ------------------------------------------------------------------
  select public.complete_sale(
    v_shop_id, v_items,
    jsonb_build_array(jsonb_build_object('method', 'cash', 'amount_cents', 1000)),
    null, null, null, null, 0, null, null, v_location_id, 0, v_session
  ) into v_sale_id;
  select id into v_item_id from public.sale_items where sale_id = v_sale_id;
  perform public.refund_sale_items(v_sale_id, jsonb_build_array(
    jsonb_build_object('sale_item_id', v_item_id, 'quantity', 1)));

  select register_session_id is not distinct from v_session into v_ok
    from public.refunds where sale_id = v_sale_id;
  if not v_ok then raise exception 'FAIL: refund was not attached to the open session'; end if;

  select expected_minor into v_expected
    from public.register_session_expected(v_session) where currency_code = 'USD';
  -- 13850 + 1000 for the new sale - 1000 refunded straight back out.
  if v_expected <> 13850 then
    raise exception 'FAIL: USD expected after sale+refund should be 13850, got %', v_expected;
  end if;
  raise notice 'OK: refund netted out of the drawer, expected still %', v_expected;

  ------------------------------------------------------------------
  raise notice '=== 5. THE HEADLINE: a moving rate must not move the variance ===';
  ------------------------------------------------------------------
  -- Close counting exactly what is expected in shillings and $5.00 short in
  -- dollars, at a rate that has drifted 115 -> 118 since the open.
  perform public.close_register_session(
    v_session,
    jsonb_build_array(
      jsonb_build_object('currency_code', 'USD',  'amount_minor', 13350, 'rate_to_usd', 1),
      jsonb_build_object('currency_code', 'SLSH', 'amount_minor', 4115000, 'rate_to_usd', 118)
    ),
    'gave the wrong change once');

  select variance_minor into v_variance
    from public.register_session_cash where session_id = v_session and currency_code = 'USD';
  if v_variance <> -500 then
    raise exception 'FAIL: USD variance should be -500, got %', v_variance;
  end if;

  select variance_minor into v_variance_slsh
    from public.register_session_cash where session_id = v_session and currency_code = 'SLSH';
  if v_variance_slsh <> 0 then
    raise exception 'FAIL: SLSH variance should be 0 despite the rate move, got %', v_variance_slsh;
  end if;
  raise notice 'OK: USD %, SLSH % -- the rate drift did not manufacture a variance',
    v_variance, v_variance_slsh;

  select variance_base_cents into v_base from public.register_sessions where id = v_session;
  -- -500 USD cents plus 0 shillings converted = -500. If the balances had been
  -- converted and differenced instead, this would read about -8000.
  if v_base <> -500 then
    raise exception 'FAIL: combined variance should be -500, got % (balances converted instead of variances?)', v_base;
  end if;
  raise notice 'OK: combined variance % is the sum of the per-currency ones', v_base;

  select count(*) into v_count from public.register_sessions
    where id = v_session and closed_at is not null and closed_by is not null;
  if v_count <> 1 then raise exception 'FAIL: session did not close cleanly'; end if;

  v_ok := false;
  begin
    perform public.close_register_session(v_session, '[]'::jsonb, null);
  exception when others then v_ok := true;
  end;
  if not v_ok then raise exception 'FAIL: closing an already-closed session was allowed'; end if;
  raise notice 'OK: double close refused';

  ------------------------------------------------------------------
  raise notice '=== 6. A sale cannot be filed against a closed session ===';
  ------------------------------------------------------------------
  v_ok := false;
  begin
    perform public.complete_sale(
      v_shop_id, v_items,
      jsonb_build_array(jsonb_build_object('method', 'cash', 'amount_cents', 1000)),
      null, null, null, null, 0, null, null, v_location_id, 0, v_session);
  exception when others then v_ok := true;
  end;
  if not v_ok then raise exception 'FAIL: a closed session accepted a sale'; end if;
  raise notice 'OK: closed session refused a sale';

  ------------------------------------------------------------------
  raise notice '=== 7. Handover: one count closes one session and opens the next ===';
  ------------------------------------------------------------------
  select public.open_register_session(
    v_register_b, v_owner_member,
    jsonb_build_array(jsonb_build_object('currency_code', 'USD', 'amount_minor', 5000, 'rate_to_usd', 1)),
    null) into v_session;
  perform public.complete_sale(
    v_shop_id, v_items,
    jsonb_build_array(jsonb_build_object('method', 'cash', 'amount_cents', 1000)),
    null, null, null, null, 0, null, null, v_location_id, 0, v_session);

  select public.handover_register_session(
    v_session, v_staff_member,
    jsonb_build_array(jsonb_build_object('currency_code', 'USD', 'amount_minor', 6000, 'rate_to_usd', 1)),
    'handing over') into v_session2;

  select count(*) into v_count from public.register_sessions
    where register_id = v_register_b and closed_at is null;
  if v_count <> 1 then raise exception 'FAIL: expected exactly 1 open session after handover, got %', v_count; end if;

  select opening_float_minor into v_expected
    from public.register_session_cash where session_id = v_session2 and currency_code = 'USD';
  if v_expected <> 6000 then
    raise exception 'FAIL: counted 6000 should become the new float, got %', v_expected;
  end if;
  select shop_member_id = v_staff_member into v_ok
    from public.register_sessions where id = v_session2;
  if not v_ok then raise exception 'FAIL: handover did not move the register to the incoming member'; end if;
  raise notice 'OK: handover closed one, opened one, carried 6000 across';

  -- 5000 float + 1000 cash sale = 6000 expected, counted 6000, so it balances.
  select variance_minor into v_variance
    from public.register_session_cash where session_id = v_session and currency_code = 'USD';
  if v_variance <> 0 then raise exception 'FAIL: handover close should balance, got %', v_variance; end if;
  raise notice 'OK: the outgoing session balanced';

  perform public.close_register_session(v_session2, jsonb_build_array(
    jsonb_build_object('currency_code', 'USD', 'amount_minor', 6000, 'rate_to_usd', 1)), null);

  ------------------------------------------------------------------
  raise notice '=== 8. A mobile register is created once and then reused ===';
  ------------------------------------------------------------------
  select public.ensure_mobile_register(v_shop_id, v_location_id, v_owner_member) into v_mobile_a;
  select public.ensure_mobile_register(v_shop_id, v_location_id, v_owner_member) into v_mobile_b;
  if v_mobile_a is distinct from v_mobile_b then
    raise exception 'FAIL: ensure_mobile_register created a second register (% vs %)', v_mobile_a, v_mobile_b;
  end if;
  select count(*) into v_registers from public.registers
    where shop_id = v_shop_id and kind = 'mobile' and shop_member_id = v_owner_member;
  if v_registers <> 1 then raise exception 'FAIL: expected 1 mobile register, got %', v_registers; end if;
  raise notice 'OK: mobile register reused, not duplicated';

  ------------------------------------------------------------------
  raise notice '=== 9. A session with no cash at all closes cleanly ===';
  ------------------------------------------------------------------
  select public.open_register_session(v_mobile_a, v_owner_member, '[]'::jsonb, null) into v_session;
  perform public.complete_sale(
    v_shop_id, v_items,
    jsonb_build_array(jsonb_build_object('method', 'zaad', 'amount_cents', 1000)),
    null, null, null, null, 0, null, null, v_location_id, 0, v_session);
  perform public.close_register_session(v_session, '[]'::jsonb, null);

  select variance_base_cents into v_base from public.register_sessions where id = v_session;
  if v_base <> 0 then raise exception 'FAIL: a ZAAD-only session should have zero variance, got %', v_base; end if;
  select count(*) into v_count from public.register_session_cash where session_id = v_session;
  if v_count <> 0 then raise exception 'FAIL: a no-cash session should have no cash rows, got %', v_count; end if;
  raise notice 'OK: nothing to count, closed with zero variance';

  ------------------------------------------------------------------
  raise notice '=== 10. require_open_register is per STORE, enforced server-side ===';
  ------------------------------------------------------------------
  update public.shop_locations set require_open_register = true where id = v_location_id;
  v_ok := false;
  begin
    perform public.complete_sale(
      v_shop_id, v_items,
      jsonb_build_array(jsonb_build_object('method', 'cash', 'amount_cents', 1000)),
      null, null, null, null, 0, null, null, v_location_id, 0, null);
  exception when others then v_ok := true;
  end;
  if not v_ok then raise exception 'FAIL: a sale with no session was allowed while this store requires one'; end if;
  raise notice 'OK: the store that requires a register refuses a sessionless sale';

  -- The point of putting the flag on the location rather than the shop: turning
  -- it on at one branch must not stop another branch selling.
  insert into public.product_location_stock (product_id, location_id, stock)
    values (v_product_id, v_other_location_id, 100)
    on conflict (product_id, location_id) do update set stock = 100;
  perform public.complete_sale(
    v_shop_id, v_items,
    jsonb_build_array(jsonb_build_object('method', 'cash', 'amount_cents', 1000)),
    null, null, null, null, 0, null, null, v_other_location_id, 0, null);
  raise notice 'OK: the OTHER store, with the rule off, still sells';

  update public.shop_locations set require_open_register = false where id = v_location_id;

  -- ...and with it off, the same sale goes through untouched. This is the check
  -- that every existing shop keeps working.
  perform public.complete_sale(
    v_shop_id, v_items,
    jsonb_build_array(jsonb_build_object('method', 'cash', 'amount_cents', 1000)),
    null, null, null, null, 0, null, null, v_location_id, 0, null);
  raise notice 'OK: enforced when on, invisible when off';

  ------------------------------------------------------------------
  raise notice '=== 11. Opening for someone else needs registers.manage ===';
  ------------------------------------------------------------------
  -- As the staff member, who holds only pos.access.
  perform set_config('request.jwt.claims', json_build_object('sub', v_staff_user)::text, true);
  v_ok := false;
  begin
    perform public.open_register_session(v_register_a, v_owner_member, '[]'::jsonb, null);
  exception when others then v_ok := true;
  end;
  if not v_ok then raise exception 'FAIL: a cashier opened a register for someone else'; end if;
  raise notice 'OK: opening for another person refused without registers.manage';

  -- Their own is fine.
  select public.open_register_session(v_register_a, v_staff_member, '[]'::jsonb, null) into v_session;
  raise notice 'OK: opening their own register allowed';

  -- And a cashier cannot close a colleague's.
  perform set_config('request.jwt.claims', json_build_object('sub', v_owner_id)::text, true);
  select public.open_register_session(v_register_b, v_owner_member, '[]'::jsonb, null) into v_session2;
  perform set_config('request.jwt.claims', json_build_object('sub', v_staff_user)::text, true);
  v_ok := false;
  begin
    perform public.close_register_session(v_session2, '[]'::jsonb, null);
  exception when others then v_ok := true;
  end;
  if not v_ok then raise exception 'FAIL: a cashier closed a colleague''s register'; end if;
  raise notice 'OK: closing a colleague''s register refused';

  ------------------------------------------------------------------
  raise notice '=== 12. A cashier reads only their own sessions ===';
  ------------------------------------------------------------------
  -- Counted rather than hardcoded: the staff member owns two sessions by now,
  -- their own from step 11 AND the one handed to them in step 7 -- which is
  -- itself worth asserting, since a handover must carry read access across with
  -- the register.
  perform set_config('role', 'authenticated', true);
  select count(*) into v_count from public.register_sessions where shop_id = v_shop_id;
  select count(*) into v_registers from public.register_sessions
    where shop_id = v_shop_id and shop_member_id = v_staff_member;
  if v_count <> v_registers then
    raise exception 'FAIL: cashier saw % sessions but owns only %', v_count, v_registers;
  end if;
  if v_registers < 2 then
    raise exception 'FAIL: expected the handed-over session to be readable too, own count is %', v_registers;
  end if;
  raise notice 'OK: cashier sees % sessions, exactly the ones they are on', v_count;

  -- And the owner, who can see everything, sees strictly more than that.
  perform set_config('request.jwt.claims', json_build_object('sub', v_owner_id)::text, true);
  select count(*) into v_count from public.register_sessions where shop_id = v_shop_id;
  if v_count <= v_registers then
    raise exception 'FAIL: the owner should see more than the cashier''s %, saw %', v_registers, v_count;
  end if;
  raise notice 'OK: owner sees all % sessions', v_count;

  raise notice 'ALL CHECKS PASSED';
  raise exception 'rollback: verification complete';
exception
  when others then
    if sqlerrm = 'rollback: verification complete' then
      raise notice 'Rolled back cleanly.';
    else
      raise;
    end if;
end $$;
