-- LOCAL DEVELOPMENT SEED — not a migration, never run against production.
--
-- The platform console's People, Where-they-trade and team views need a store
-- with more than one person and more than one branch before any of them show
-- anything. A fresh local database has one shop, one owner and one branch, so
-- every new surface renders its thinnest possible state and none of the rules
-- worth checking (branch chips, the team summary, the "no longer here" group)
-- are visible at all.
--
-- This adds, to the FIRST shop in the database:
--   * a second branch, in a second neighbourhood
--   * a Manager with no branch assignment      -> "Both branches"
--   * a Cashier tied to the second branch only -> "Koodbuur"
--   * a Cashier with no phone                  -> mail glyph, no WhatsApp
--   * a deactivated Cashier                    -> "No longer here", no contact
-- and appoints the shop's owner as a platform operator so the console can be
-- opened at all. MFA is still required by is_platform_admin(); the portal's
-- own sign-in screen walks through enrolment.
--
-- Re-runnable: every insert is guarded, so running it twice changes nothing.
--
-- TO UNDO EVERYTHING THIS ADDED:
--   delete from public.shop_members where email like '%@kaiibi-demo.test';
--   delete from public.shop_locations where name = 'Koodbuur';
--   delete from public.platform_admins;
--   delete from auth.users where email like '%@kaiibi-demo.test';

\set ON_ERROR_STOP on

do $$
declare
  v_shop_id   uuid;
  v_owner_id  uuid;
  v_loc_two   uuid;
  v_cashier   uuid;
  v_manager   uuid;
  v_member_id uuid;
  v_person    record;
begin
  select id, owner_id into v_shop_id, v_owner_id from public.shops order by created_at limit 1;
  if v_shop_id is null then
    raise exception 'No shop in this database yet. Sign up in the app first, then re-run this.';
  end if;

  -- The operator account. Appointed deliberately, exactly as
  -- 20260818000500's comment describes -- by SQL, against a known user id.
  insert into public.platform_admins (user_id, role, note)
    values (v_owner_id, 'owner', 'local development')
    on conflict (user_id) do nothing;

  -- A second branch, so the branch-access chips have something to say. Without
  -- this, branchAccessLabel() correctly returns '' for every person and the
  -- whole "which store can they work at" feature is invisible.
  select id into v_loc_two from public.shop_locations where shop_id = v_shop_id and name = 'Koodbuur';
  if v_loc_two is null then
    insert into public.shop_locations (shop_id, name, city, neighborhood, contact_phone, is_primary)
      values (v_shop_id, 'Koodbuur', 'Hargeisa', 'Koodbuur', '0637710099', false)
      returning id into v_loc_two;
  end if;

  -- Give the primary branch a city and a number if it has none, so the Stores
  -- table's city label and the drawer's branch row are not both blank.
  update public.shop_locations
     set city = coalesce(city, 'Hargeisa'),
         neighborhood = coalesce(neighborhood, 'Jigjiga Yar'),
         contact_phone = coalesce(contact_phone, '0634418820')
   where shop_id = v_shop_id and is_primary;

  select id into v_manager from public.roles where shop_id = v_shop_id and name = 'Manager';
  select id into v_cashier from public.roles where shop_id = v_shop_id and name = 'Cashier';
  if v_manager is null or v_cashier is null then
    raise exception 'This shop has no default roles, which means it predates 20260823000000.';
  end if;

  -- Four people, each chosen to exercise one branch of the UI.
  for v_person in
    select * from (values
      ('Maxamed Aadan',   'maxamed@kaiibi-demo.test', '0637710043', v_manager, true,  false),
      ('Nasra Xasan',     'nasra@kaiibi-demo.test',   '0631184402', v_cashier, true,  true),
      ('Sahra Ismaaciil', 'sahra@kaiibi-demo.test',   null,         v_cashier, true,  false),
      ('Cabdi Jibriil',   'cabdi@kaiibi-demo.test',   '0639887711', v_cashier, false, false)
    ) as t(full_name, email, phone, role_id, active, one_branch_only)
  loop
    if not exists (select 1 from auth.users where email = v_person.email) then
      insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
        values (gen_random_uuid(), '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
                v_person.email, '', now(), now(), now());
    end if;

    insert into public.shop_members (shop_id, user_id, role_id, active, full_name, email, phone)
      select v_shop_id, u.id, v_person.role_id, v_person.active, v_person.full_name, v_person.email, v_person.phone
        from auth.users u where u.email = v_person.email
      on conflict (shop_id, user_id) do update
        set active = excluded.active, phone = excluded.phone
      returning id into v_member_id;

    -- Only ONE of them gets an assignment row. Everyone else is left with
    -- none, which can_access_location() reads as access to every branch --
    -- the rule the console's chip has to state the right way round.
    if v_person.one_branch_only then
      insert into public.shop_member_locations (shop_member_id, location_id)
        values (v_member_id, v_loc_two)
        on conflict do nothing;
    end if;
  end loop;

  raise notice 'seed-platform-people-demo: operator appointed, 2 branches, 5 people on shop %', v_shop_id;
end $$;
