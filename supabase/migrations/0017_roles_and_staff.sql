-- Phase 1 of staff accounts & permissions: rename the 'owner' role value to
-- 'admin' (add 'staff' for the accounts Phase 2's provisioning flow will
-- create), and lay down the roles/shop_members schema. Nothing here is
-- consumed by any gate yet -- existing admin behavior is unchanged. Direct
-- rename (no widen-then-narrow) is safe: this app is pre-launch, no
-- production rows exist yet.

alter table public.profiles drop constraint profiles_role_check;
update public.profiles set role = 'admin' where role = 'owner';
alter table public.profiles add constraint profiles_role_check check (role in ('admin','customer','staff'));

-- Closes a latent privilege-escalation gap: 0003_grants.sql granted blanket
-- `update` on profiles to authenticated, and the "own profile" policy lets
-- any signed-in user update their own row -- including `role`, which is now
-- a real access-control column instead of just a label. updateProfile()
-- (src/lib/profile.ts) only ever sends full_name/phone, so this narrows the
-- grant to match actual usage with no app-code changes required.
revoke update on public.profiles from authenticated;
grant update (full_name, phone) on public.profiles to authenticated;

-- A shop-scoped, admin-defined role. Permissions are validated against a
-- fixed catalog in code (src/lib/permissions.ts) -- not a DB-side enum or
-- table -- because the catalog itself isn't user-editable, only which of
-- its entries a given role grants.
create table public.roles (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  name text not null,
  permissions text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (shop_id, name)
);
create index roles_shop_id_idx on public.roles(shop_id);

-- Links a staff auth.users row to a shop + role. The admin (shops.owner_id)
-- deliberately has no row here -- adminship stays owner_id-based, exactly
-- as today; roles/shop_members only ever describe staff.
create table public.shop_members (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role_id uuid not null references public.roles(id) on delete restrict,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (shop_id, user_id)
);
create index shop_members_shop_id_idx on public.shop_members(shop_id);
create index shop_members_user_id_idx on public.shop_members(user_id);

alter table public.roles enable row level security;
alter table public.shop_members enable row level security;

create policy "admin manages roles" on public.roles for all
  using (owns_shop(shop_id)) with check (owns_shop(shop_id));

create policy "admin manages shop_members" on public.shop_members for all
  using (owns_shop(shop_id)) with check (owns_shop(shop_id));

-- Lets a staff member's own session read their own membership row (needed
-- to resolve their shop + permissions on login, wired up in Phase 2).
create policy "staff reads own membership" on public.shop_members for select
  using (user_id = auth.uid());

grant select, insert, update, delete on public.roles to authenticated;
grant select, insert, update, delete on public.shop_members to authenticated;
