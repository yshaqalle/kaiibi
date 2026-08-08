-- The owner is a member of their own shop (migration 20260823000000).
--
-- The headline question is the last one: can the owner actually be given a
-- shift? That is what the whole change is for -- an owner with no roster row
-- could not be scheduled or handed a till, which made those features unusable
-- in a one-person shop. Everything before it establishes that the row exists,
-- costs a seat, and cannot be taken away.
--
-- Everything runs inside one DO block whose EXCEPTION clause rolls it all back.

\set ON_ERROR_STOP on

do $$
declare
  v_owner_id uuid := gen_random_uuid();
  v_staff_a  uuid := gen_random_uuid();
  v_staff_b  uuid := gen_random_uuid();
  v_staff_c  uuid := gen_random_uuid();
  v_shop_id uuid;
  v_location_id uuid;
  v_doomed_shop uuid;
  v_free_id uuid;
  v_owner_member uuid;
  v_cashier_role uuid;
  v_owner_role uuid;
  v_count integer;
  v_usage integer;
  v_raised boolean;
  v_ok boolean;
begin
  ------------------------------------------------------------------
  -- Fixture
  ------------------------------------------------------------------
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_user_meta_data)
    values (v_owner_id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            'verify-owner-' || v_owner_id || '@example.test', '', now(), now(), now(),
            jsonb_build_object('full_name', 'Hodan Warsame'));
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
    select u, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
           'verify-owner-staff-' || u || '@example.test', '', now(), now(), now()
      from unnest(array[v_staff_a, v_staff_b, v_staff_c]) u;

  insert into public.shops (owner_id, name) values (v_owner_id, 'Owner Membership Shop')
    returning id into v_shop_id;

  ------------------------------------------------------------------
  raise notice '=== 1. A new shop seeds its roles ===';
  ------------------------------------------------------------------
  -- 0020 seeded Cashier and Manager for the shops that existed when it ran and
  -- nothing seeded them since, so a shop created today had none at all. The
  -- owner's row needs one to point at, which is why seeding moved into a
  -- trigger rather than staying a one-off backfill.
  select count(*) into v_count from public.roles
    where shop_id = v_shop_id and name in ('Cashier', 'Manager', 'Owner');
  if v_count <> 3 then raise exception 'FAIL: expected 3 seeded roles, got %', v_count; end if;
  raise notice 'OK: Cashier, Manager and Owner all seeded with the shop';

  ------------------------------------------------------------------
  raise notice '=== 2. A new shop seeds the owner''s membership ===';
  ------------------------------------------------------------------
  select id into v_owner_role from public.roles where shop_id = v_shop_id and name = 'Owner';
  select id into v_cashier_role from public.roles where shop_id = v_shop_id and name = 'Cashier';

  select count(*) into v_count from public.shop_members
    where shop_id = v_shop_id and user_id = v_owner_id;
  if v_count <> 1 then raise exception 'FAIL: expected exactly 1 owner membership, got %', v_count; end if;

  select id, role_id = v_owner_role and active into v_owner_member, v_ok
    from public.shop_members where shop_id = v_shop_id and user_id = v_owner_id;
  if not v_ok then raise exception 'FAIL: the owner''s row should be active and hold the Owner role'; end if;

  -- The shop can be created before the profile row lands at signup, so the name
  -- falls through to the signup metadata rather than showing a blank person.
  select full_name = 'Hodan Warsame' and email like 'verify-owner-%' into v_ok
    from public.shop_members where id = v_owner_member;
  if not v_ok then raise exception 'FAIL: the owner''s row did not take their name and email'; end if;

  -- Empty means every store (20260814000000), which is what an owner should have.
  select count(*) into v_count from public.shop_member_locations where shop_member_id = v_owner_member;
  if v_count <> 0 then raise exception 'FAIL: the owner should not be pinned to a store, got % rows', v_count; end if;
  raise notice 'OK: one active owner row, named, on the Owner role, at every store';

  ------------------------------------------------------------------
  raise notice '=== 3. The owner occupies a seat ===';
  ------------------------------------------------------------------
  select count into v_usage from public.shop_usage_counters
    where shop_id = v_shop_id and resource = 'staff';
  if coalesce(v_usage, 0) <> 1 then raise exception 'FAIL: staff usage should be 1, got %', coalesce(v_usage, 0); end if;
  raise notice 'OK: the owner counts against the staff limit like anyone else';

  ------------------------------------------------------------------
  raise notice '=== 4. Free still fits the owner plus two employees ===';
  ------------------------------------------------------------------
  -- The seat the owner takes is why Free went from 2 to 3. A shop that could
  -- hire two people before this migration must still be able to hire two.
  select id into v_free_id from public.plans where key = 'free';
  update public.shop_subscriptions set plan_id = v_free_id, trial_ends_at = now() - interval '100 days',
         grace_until = now() - interval '93 days'
   where shop_id = v_shop_id;

  if public.shop_limit(v_shop_id, 'staff') <> 3 then
    raise exception 'FAIL: free should cap staff at 3, got %', public.shop_limit(v_shop_id, 'staff');
  end if;

  insert into public.shop_members (shop_id, user_id, role_id, full_name, active)
    values (v_shop_id, v_staff_a, v_cashier_role, 'Amina Hassan', true);
  insert into public.shop_members (shop_id, user_id, role_id, full_name, active)
    values (v_shop_id, v_staff_b, v_cashier_role, 'Hamse Jibril', true);
  raise notice 'OK: two employees hired alongside the owner';

  v_raised := false;
  begin
    insert into public.shop_members (shop_id, user_id, role_id, full_name, active)
      values (v_shop_id, v_staff_c, v_cashier_role, 'One Too Many', true);
  exception when others then
    if sqlerrm <> 'limit_reached' then raise; end if;
    v_raised := true;
  end;
  if not v_raised then raise exception 'FAIL: a fourth person was accepted on a 3-seat plan'; end if;
  raise notice 'OK: the seat after that is refused';

  ------------------------------------------------------------------
  raise notice '=== 5. The owner''s row cannot be deactivated or removed ===';
  ------------------------------------------------------------------
  -- An owner who deactivates themselves loses the /me tab, their own schedule
  -- and their register assignment while still owning the shop. There is no
  -- screen that puts them back.
  v_raised := false;
  begin
    update public.shop_members set active = false where id = v_owner_member;
  exception when others then
    v_raised := true;
  end;
  if not v_raised then raise exception 'FAIL: the owner was deactivated'; end if;

  v_raised := false;
  begin
    delete from public.shop_members where id = v_owner_member;
  exception when others then
    v_raised := true;
  end;
  if not v_raised then raise exception 'FAIL: the owner was removed from the team'; end if;
  raise notice 'OK: deactivate and delete both refused for the owner';

  -- A label, not a grant: user_has_shop_permission() answers true for an owner
  -- before it looks at a role, so moving them onto another one changes nothing
  -- and is allowed.
  update public.shop_members set role_id = v_cashier_role where id = v_owner_member;
  update public.shop_members set role_id = v_owner_role where id = v_owner_member;
  raise notice 'OK: the owner''s role can still be changed';

  ------------------------------------------------------------------
  raise notice '=== 5b. The owner''s roster name follows their profile ===';
  ------------------------------------------------------------------
  insert into public.profiles (id, role, full_name, phone)
    values (v_owner_id, 'admin', 'Hodan A. Warsame', '063 400 0001')
  on conflict (id) do update set full_name = excluded.full_name, phone = excluded.phone;

  select full_name = 'Hodan A. Warsame' and phone = '063 400 0001' into v_ok
    from public.shop_members where id = v_owner_member;
  if not v_ok then raise exception 'FAIL: the owner''s roster row did not follow their profile'; end if;

  -- A staff member's roster name is the roster manager's to set, so it must NOT
  -- be rewritten from that person's own profile.
  insert into public.profiles (id, role, full_name)
    values (v_staff_a, 'staff', 'Renamed Themselves')
  on conflict (id) do update set full_name = excluded.full_name;
  select full_name = 'Amina Hassan' into v_ok
    from public.shop_members where shop_id = v_shop_id and user_id = v_staff_a;
  if not v_ok then raise exception 'FAIL: a staff profile rewrote its own roster name'; end if;
  raise notice 'OK: the owner follows their profile, staff do not';

  ------------------------------------------------------------------
  raise notice '=== 6. Deleting a shop is not blocked by the guard ===';
  ------------------------------------------------------------------
  -- The cascade from shops deletes the owner's row, and the guard must not turn
  -- that into an error. It reads false because the parent is already gone --
  -- worth asserting, since the whole check hinges on that visibility.
  insert into public.shops (owner_id, name) values (v_owner_id, 'Doomed Shop')
    returning id into v_doomed_shop;
  delete from public.shops where id = v_doomed_shop;
  select count(*) into v_count from public.shop_members where shop_id = v_doomed_shop;
  if v_count <> 0 then raise exception 'FAIL: the owner''s row survived its shop'; end if;
  raise notice 'OK: a shop can still be deleted, owner row and all';

  ------------------------------------------------------------------
  raise notice '=== 7. The owner can be given a shift ===';
  ------------------------------------------------------------------
  -- The point of all of it. shifts.shop_member_id is a foreign key into
  -- shop_members, so before this migration there was nothing to point at and an
  -- owner could not appear on their own rota.
  --
  -- Onto Standard first: scheduling is not a Free module, and Standard is also
  -- where the other half of the seat change has to hold -- a shop sold "10
  -- staff" still gets ten of them alongside its owner.
  update public.shop_subscriptions
     set plan_id = (select id from public.plans where key = 'standard'),
         current_period_end = now() + interval '20 days',
         grace_until = now() + interval '27 days'
   where shop_id = v_shop_id;
  if public.shop_limit(v_shop_id, 'staff') <> 11 then
    raise exception 'FAIL: standard should cap staff at 11, got %', public.shop_limit(v_shop_id, 'staff');
  end if;

  perform set_config('request.jwt.claims', json_build_object('sub', v_owner_id)::text, true);
  perform set_config('role', 'authenticated', true);

  insert into public.shop_locations (shop_id, name, is_primary)
    values (v_shop_id, 'Only Store', true) returning id into v_location_id;

  insert into public.shifts (shop_id, shop_member_id, location_id, shift_date, start_time, end_time)
    values (v_shop_id, v_owner_member, v_location_id, '2026-08-10', '09:00', '17:00');

  select count(*) into v_count from public.shifts
    where shop_id = v_shop_id and shop_member_id = v_owner_member;
  if v_count <> 1 then raise exception 'FAIL: the owner has no shift, got % rows', v_count; end if;
  raise notice 'OK: the owner is on the schedule';

  perform set_config('role', 'postgres', true);

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
