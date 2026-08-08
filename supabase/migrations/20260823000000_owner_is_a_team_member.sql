-- The owner is a member of their own shop.
--
-- Until now an owner was identified only by shops.owner_id and had no
-- shop_members row at all -- adminship was ownership, and every permission
-- check ORs owns_shop() on top of the membership lookup (0017/0024). That works
-- for authority and fails for everything else: shifts.shop_member_id and
-- registers.shop_member_id are foreign keys into shop_members, so the owner
-- could not be given a shift or handed a till. In a one-person shop, which is
-- most shops on Free, that makes the schedule and register assignment unusable
-- by the only person who works there.
--
-- 20260822000200 and 20260822000300 met the same wall from the other side and
-- worked around it -- register_sessions.shop_member_id became nullable with
-- opened_by carrying the owner, and registers gained a user_id column. Both
-- rejected "provision a shop_members row for owners" explicitly, and both were
-- right to: doing it as a SIDE EFFECT of opening a till would have put the
-- owner on the payroll list and the roster to record that someone counted a
-- drawer. This migration makes that same claim deliberately and up front, which
-- is the case those comments were not arguing against.
--
-- The row grants nothing. Authority still comes from owner_id, so the role it
-- points at is a label. What the row buys is that the owner is addressable by
-- the foreign keys the rest of the schema already uses for people.

-- ---------------------------------------------------------------------------
-- Plan limits -- the owner occupies a seat, so every capped plan gains one
-- ---------------------------------------------------------------------------

-- Counting the owner as a seat is the simple reading (a seat is a seat), and
-- keeping the trigger untouched is worth a lot. What it must not do is quietly
-- take an employee away: a Standard shop was sold ten staff and still gets ten
-- alongside its owner. Trial and Pro are uncapped ({}), so they say nothing
-- about staff and are left alone.
update public.plans set limits = jsonb_set(limits, '{staff}', '3'::jsonb)
  where key = 'free' and limits ? 'staff';
update public.plans set limits = jsonb_set(limits, '{staff}', '11'::jsonb)
  where key = 'standard' and limits ? 'staff';

-- ---------------------------------------------------------------------------
-- Default roles and the owner's row, for every shop created from here on
-- ---------------------------------------------------------------------------

-- 0020_default_roles.sql seeded Cashier and Manager for the shops that existed
-- when it ran, and NOTHING has seeded them since -- createShop() in
-- src/lib/shops.ts writes currencies and the primary location and never touches
-- roles, so every shop created after 0020 has none at all. That was survivable
-- while roles were only a convenience; it is not survivable now that the
-- owner's row needs a role to point at (shop_members.role_id is NOT NULL).
--
-- So seeding moves into a trigger on shops, beside shops_start_trial, rather
-- than into the client. It then holds for every path that creates a shop --
-- signup, the platform portal, a future one -- instead of the one that
-- remembered to call it.

-- ONE definition of what the default roles are, because there are now two
-- callers (the trigger below and the backfill further down) and there was
-- already one drift: 0020 seeded Manager with six permissions, and five later
-- migrations topped it up in place with `update ... where name = 'Manager'`
-- (customers in 0024, expenses in 20260804000100, invoices in 20260804000300,
-- budgets in 20260804000500, registers in 20260822000000). A trigger holding
-- its own copy of the 0020 list would have handed every shop created from here
-- on a weaker Manager than every shop that predates it, and nothing would have
-- said so.
--
-- ANY FUTURE MIGRATION that grants a permission to a default role must add it
-- here too, not only in an `update public.roles` -- that update reaches the
-- shops that exist, this function reaches the ones that don't yet.
create or replace function public.default_shop_roles()
returns table (name text, permissions text[])
language sql immutable set search_path = public as $$
  values
    ('Cashier'::text, array['pos.access', 'inventory.view']::text[]),
    -- "Everything except settings and staff management", as 0020 put it, minus
    -- the pieces that were deliberately never granted: sales.refund is its own
    -- gate (see the catalog in src/lib/permissions.ts) and the people.* HR
    -- permissions read as staff management. This is exactly the set an existing
    -- shop's Manager holds today, so old and new shops agree.
    ('Manager'::text, array[
      'pos.access', 'inventory.view', 'inventory.edit', 'sales.view', 'sales.edit',
      'customers.view', 'customers.edit', 'dashboard.view',
      'expenses.view', 'expenses.manage', 'invoices.view', 'invoices.manage',
      'budgets.manage', 'registers.manage'
    ]::text[]),
    -- The whole catalog, so the Roles screen doesn't show the owner holding
    -- nothing. It changes no behaviour either way: user_has_shop_permission()
    -- answers true for an owner before it ever looks at a role.
    ('Owner'::text, array[
      'pos.access', 'inventory.view', 'inventory.edit', 'sales.view', 'sales.edit', 'sales.refund',
      'customers.view', 'customers.edit', 'dashboard.view', 'settings.access', 'staff.manage',
      'people.timeoff.approve', 'people.payroll.manage', 'people.timesheet.view', 'people.schedule.manage',
      'expenses.view', 'expenses.manage', 'invoices.view', 'invoices.manage', 'budgets.manage', 'registers.manage'
    ]::text[]);
$$;

create or replace function public.seed_shop_defaults()
returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_owner_role_id uuid;
  v_email text;
  v_name text;
begin
  insert into public.roles (shop_id, name, permissions)
    select new.id, d.name, d.permissions from public.default_shop_roles() d
  on conflict (shop_id, name) do nothing;

  select id into v_owner_role_id from public.roles where shop_id = new.id and name = 'Owner';

  -- At signup the shop can be created before the profile row lands, so the name
  -- falls back through the signup metadata to the local part of the email
  -- rather than showing a blank person on the roster.
  select u.email,
         coalesce(p.full_name, u.raw_user_meta_data->>'full_name', split_part(u.email, '@', 1))
    into v_email, v_name
    from auth.users u
    left join public.profiles p on p.id = u.id
   where u.id = new.owner_id;

  -- No shop_member_locations rows: an empty assignment means every store
  -- (20260814000000), which is what an owner should have.
  insert into public.shop_members (shop_id, user_id, role_id, active, full_name, email)
    values (new.id, new.owner_id, v_owner_role_id, true, v_name, v_email)
  on conflict (shop_id, user_id) do nothing;

  return new;
end;
$$;

-- Fires before shops_start_trial (triggers run in name order), so the shop has
-- no subscription yet and shop_limit() resolves through the post-trial plan.
-- Safe because the seat being taken is the first one and no plan caps staff
-- below one.
drop trigger if exists shops_seed_defaults on public.shops;
create trigger shops_seed_defaults after insert on public.shops
  for each row execute function public.seed_shop_defaults();

-- ---------------------------------------------------------------------------
-- Backfill: the shops that already exist
-- ---------------------------------------------------------------------------

-- The seat trigger is disabled for the duration rather than trusting the limit
-- bump above to have made room. A shop that is somehow already at its cap is a
-- data problem; it must not become a failed deploy. The counters are recomputed
-- from actual counts afterwards, so nothing drifts.
alter table public.shop_members disable trigger shop_members_limit;

-- `do nothing` and not `do update`: a shop that has renamed, re-scoped or
-- pared back its own Manager keeps exactly what it chose. This fills the gap
-- for shops created after 0020 (which have no roles at all); it is not a reset
-- of everyone's roles to the defaults.
insert into public.roles (shop_id, name, permissions)
  select s.id, d.name, d.permissions from public.shops s cross join public.default_shop_roles() d
  on conflict (shop_id, name) do nothing;

-- unique (shop_id, user_id) makes this idempotent, and an owner who somehow
-- already has a membership (they were staff somewhere that became theirs) keeps
-- the row and the role they already had.
insert into public.shop_members (shop_id, user_id, role_id, active, full_name, email)
  select s.id,
         s.owner_id,
         r.id,
         true,
         coalesce(p.full_name, u.raw_user_meta_data->>'full_name', split_part(u.email, '@', 1)),
         u.email
    from public.shops s
    join public.roles r on r.shop_id = s.id and r.name = 'Owner'
    join auth.users u on u.id = s.owner_id
    left join public.profiles p on p.id = s.owner_id
  on conflict (shop_id, user_id) do nothing;

alter table public.shop_members enable trigger shop_members_limit;

-- Recomputed rather than incremented: the disabled trigger skipped its own
-- bookkeeping, and a count that disagrees with the table is how a shop ends up
-- unable to add the staff it is entitled to.
insert into public.shop_usage_counters (shop_id, resource, count)
  select s.id, 'staff', (select count(*) from public.shop_members m where m.shop_id = s.id)
    from public.shops s
  on conflict (shop_id, resource) do update set count = excluded.count;

-- ---------------------------------------------------------------------------
-- Backfill: the owner's own history, so they are one person and not two
-- ---------------------------------------------------------------------------

-- Sessions an owner ran before today name them through opened_by, with a null
-- shop_member_id; sessions from now on will carry the membership. Left alone,
-- anything grouping register history by member would show the owner twice --
-- once as a member and once as a null -- with the split invisible in exactly
-- the reports where it matters. The columns stay as they are: a nullable
-- shop_member_id is still correct, it just stops being the owner's path.
update public.register_sessions rs
   set shop_member_id = m.id
  from public.shops s
  join public.shop_members m on m.shop_id = s.id and m.user_id = s.owner_id
 where rs.shop_id = s.id
   and rs.shop_member_id is null
   and rs.opened_by = s.owner_id;

-- Same for the phone register 20260822000300 gave owners through registers.user_id.
update public.registers rg
   set shop_member_id = m.id,
       user_id = null
  from public.shops s
  join public.shop_members m on m.shop_id = s.id and m.user_id = s.owner_id
 where rg.shop_id = s.id
   and rg.shop_member_id is null
   and rg.user_id = s.owner_id;

-- ---------------------------------------------------------------------------
-- The owner's name on the roster follows their profile
-- ---------------------------------------------------------------------------

-- Their member row is seeded from the profile once, at signup, and would then
-- sit frozen at whatever the name was that day -- an owner who fixes their name
-- in Settings would still be the old one on the team list and the schedule.
--
-- Only the OWNER's row follows the profile. A staff member's name on the roster
-- is set by whoever manages the team, and letting the person themselves rewrite
-- it from their own profile would take that away.
create or replace function public.sync_owner_membership_identity()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update public.shop_members m
     set full_name = new.full_name,
         phone = coalesce(new.phone, m.phone)
    from public.shops s
   where s.id = m.shop_id
     and s.owner_id = new.id
     and m.user_id = new.id;
  return new;
end;
$$;

drop trigger if exists profiles_sync_owner_membership on public.profiles;
create trigger profiles_sync_owner_membership after update of full_name, phone on public.profiles
  for each row execute function public.sync_owner_membership_identity();

-- ---------------------------------------------------------------------------
-- The owner's row cannot be deactivated or removed
-- ---------------------------------------------------------------------------

-- An owner who deactivates themselves loses the /me tab, their own schedule and
-- their register assignment while still owning the shop -- an unrecoverable
-- state reachable from an ordinary-looking button on the team screen. The UI
-- hides those actions for this row; this is what makes it true.
create or replace function public.protect_owner_membership()
returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_is_owner boolean;
begin
  -- Both cascade paths have to keep working: deleting a shop cascades to its
  -- members, and deleting an auth user cascades to theirs. In each case the
  -- parent row is already gone and invisible to this snapshot, so the guard
  -- reads false and the cascade proceeds -- which is why it tests for BOTH
  -- parents rather than just the shop.
  select exists (
    select 1 from public.shops s
     where s.id = old.shop_id and s.owner_id = old.user_id
  ) and exists (
    select 1 from auth.users u where u.id = old.user_id
  ) into v_is_owner;

  if not v_is_owner then
    return case when TG_OP = 'DELETE' then old else new end;
  end if;

  if TG_OP = 'DELETE' then
    raise exception 'the shop owner cannot be removed from the team'
      using errcode = 'P0001', hint = 'Transfer the shop first.';
  end if;

  if old.active and not new.active then
    raise exception 'the shop owner cannot be deactivated'
      using errcode = 'P0001', hint = 'Transfer the shop first.';
  end if;

  -- Changing the owner's role is allowed. It is a label; nothing reads it to
  -- decide what they may do.
  return new;
end;
$$;

drop trigger if exists shop_members_protect_owner on public.shop_members;
create trigger shop_members_protect_owner before update or delete on public.shop_members
  for each row execute function public.protect_owner_membership();
