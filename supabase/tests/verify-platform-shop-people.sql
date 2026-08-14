-- Security verification for platform_shop_people() (migration
-- 20260830000000). One DO block, rolled back by its own exception clause, so
-- it leaves no rows behind.
--
-- Written as "the attacker got this far, and then could not", because that is
-- the question an operator-account compromise actually asks.

\set ON_ERROR_STOP on

do $$
declare
  v_operator uuid := gen_random_uuid();
  v_owner    uuid := gen_random_uuid();
  v_staff    uuid := gen_random_uuid();
  v_outsider uuid := gen_random_uuid();
  v_shop_id  uuid;
  v_loc_two  uuid;
  v_member   uuid;
  v_count    integer;
  v_names    text[];
begin
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at) values
    (v_operator, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'op-'   || v_operator || '@example.test', '', now(), now(), now()),
    (v_owner,    '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'own-'  || v_owner    || '@example.test', '', now(), now(), now()),
    (v_staff,    '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'staff-'|| v_staff    || '@example.test', '', now(), now(), now()),
    (v_outsider, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'out-'  || v_outsider || '@example.test', '', now(), now(), now());

  insert into public.shops (owner_id, name) values (v_owner, 'People Verify Shop') returning id into v_shop_id;
  -- The shops trigger (20260823000000) already seeds a primary location, the
  -- default roles, and the owner's own shop_members row. Only the SECOND
  -- branch and the cashier are this script's to create.
  insert into public.shop_locations (shop_id, name, city, is_primary)
    values (v_shop_id, 'Koodbuur', 'Hargeisa', false) returning id into v_loc_two;

  insert into public.platform_admins (user_id, role, note) values (v_operator, 'owner', 'verify');

  -- A cashier tied to ONE branch, with pay recorded. The pay is the thing the
  -- function must never hand back.
  insert into public.shop_members (shop_id, user_id, role_id, active, full_name, email, phone, pay_type, pay_rate_cents)
    values (
      v_shop_id, v_staff,
      (select id from public.roles where shop_id = v_shop_id and name = 'Cashier'),
      true, 'Sahra Ismaaciil', 'sahra@example.test', '0634418820', 'salary', 25000
    )
    returning id into v_member;
  insert into public.shop_member_locations (shop_member_id, location_id) values (v_member, v_loc_two);

  -- 1. A signed-in nobody gets nothing.
  perform set_config('request.jwt.claims', json_build_object('sub', v_outsider, 'aal', 'aal2')::text, true);
  perform set_config('role', 'authenticated', true);
  select count(*) into v_count from public.platform_shop_people(array[v_shop_id]);
  if v_count <> 0 then
    raise exception 'FAIL: a non-operator read % roster rows', v_count;
  end if;

  -- 2. An operator WITHOUT a second factor gets nothing.
  perform set_config('request.jwt.claims', json_build_object('sub', v_operator, 'aal', 'aal1')::text, true);
  select count(*) into v_count from public.platform_shop_people(array[v_shop_id]);
  if v_count <> 0 then
    raise exception 'FAIL: an operator at aal1 read % roster rows', v_count;
  end if;

  -- 3. An operator WITH aal2 sees the owner and the cashier, and nothing else.
  perform set_config('request.jwt.claims', json_build_object('sub', v_operator, 'aal', 'aal2')::text, true);
  select count(*) into v_count from public.platform_shop_people(array[v_shop_id]);
  if v_count <> 2 then
    raise exception 'FAIL: operator saw % roster rows, expected 2 (owner + cashier)', v_count;
  end if;

  -- 4. The owner's row is flagged, and carries an EMPTY branch array -- their
  --    access comes from owns_shop(), never from an assignment row.
  select p.branch_names into v_names from public.platform_shop_people(array[v_shop_id]) p where p.is_owner;
  if v_names <> '{}'::text[] then
    raise exception 'FAIL: owner carried branch assignments %, expected empty', v_names;
  end if;

  -- 5. The assigned cashier names exactly their one branch.
  select p.branch_names into v_names from public.platform_shop_people(array[v_shop_id]) p where not p.is_owner;
  if v_names <> array['Koodbuur'] then
    raise exception 'FAIL: cashier branches were %, expected {Koodbuur}', v_names;
  end if;

  -- 6. A shop id the caller did not ask for is not returned, so one operator
  --    query cannot become "every roster on the platform".
  select count(*) into v_count from public.platform_shop_people(array[gen_random_uuid()]);
  if v_count <> 0 then
    raise exception 'FAIL: asking for an unrelated shop returned % rows', v_count;
  end if;

  perform set_config('role', 'postgres', true);
  raise exception 'ROLLBACK: verification passed';
exception
  when others then
    if sqlerrm = 'ROLLBACK: verification passed' then
      raise notice 'verify-platform-shop-people: all assertions passed';
    else
      raise;
    end if;
end $$;

-- 7. Pay is not reachable through this function at all: its column list is
--    fixed, so asking for a column it does not return is an error rather than
--    a value. Outside the DO block because a failed parse aborts the
--    transaction it is in, which would take the rollback machinery with it.
do $$
begin
  perform pay_rate_cents from public.platform_shop_people(array[gen_random_uuid()]);
  raise exception 'FAIL: pay_rate_cents was reachable through platform_shop_people()';
exception
  when undefined_column then
    raise notice 'verify-platform-shop-people: pay is not reachable, as intended';
end $$;
