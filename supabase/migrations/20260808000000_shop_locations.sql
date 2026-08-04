-- Physical stores. Until now `shops` was doing two jobs at once: the tenant
-- (what every table's shop_id points at, what RLS is built on) and the single
-- physical store (its city, neighborhood, phone, opening hours -- the things a
-- receipt prints). That conflation is why a shop could never have a second
-- branch.
--
-- This splits the second job out. `shops` keeps being the tenant and nothing
-- about it changes: every existing shop_id column, every RLS policy, the whole
-- permission system in 0024, the catalog, customers, vendors, roles and
-- accounting all stay exactly where they are. `shop_locations` becomes the
-- place, and only the tables where "which store" genuinely differs will gain a
-- location_id (in later migrations -- this one adds none).
--
-- The rejected alternative was a shop row per branch under an organizations
-- parent. It would have fragmented the catalog, customer list, vendor list,
-- roles and books per branch, forced cross-tenant RLS everywhere, and made a
-- rolled-up report a join across tenants.
--
-- The split in settings mirrors this: "Business" holds what the company is
-- (name, logo, return policy, tax, goals), "Store locations" holds each place
-- it trades from -- its own store name, address, phone, hours and code. That is
-- why a store carries a `name` of its own rather than inheriting the shop's.
--
-- Every existing shop is backfilled with one primary location carrying the name
-- and address it already had, so nothing is location-less and no reader has to
-- handle a null.

create table public.shop_locations (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  name text not null,
  -- A short, stable branch identifier -- "002", "AR", "HQ". Optional, because a
  -- two-branch shop refers to its branches by name and needs nothing more, and
  -- a mandatory code would be pure friction for the small shops this serves.
  --
  -- It earns its place once a name stops being a reliable key: a code survives
  -- a rename, which is what a CSV import column, an export column and a
  -- per-branch accounting row all need to key on. Distinct from the unit number
  -- in `address` ("Shop 12, Bakaaro Market") -- that is part of where the branch
  -- physically is, this is what the business calls it.
  --
  -- Deliberately not printed on a customer receipt: a customer needs "Airport
  -- Road" to find their way back, not an internal code.
  code text,
  city text,
  neighborhood text,
  -- Street address, kept separate from neighborhood: `shops` addresses by
  -- neighborhood/landmark (see 0001's 'e.g. Jigjiga Yar, near the main
  -- market'), which is how this app's region actually navigates. A branch in a
  -- mall or on a numbered street can use this instead without either field
  -- having to mean both things.
  address text,
  contact_phone text,
  -- Exactly one per shop, enforced by the partial unique index below. This is
  -- the fallback whenever a location isn't otherwise resolvable -- the backfill
  -- target here, and the default a new device picks before anyone chooses.
  is_primary boolean not null default false,
  -- Closing a branch must not delete it: its sales, shifts and expenses stay
  -- readable and keep pointing at a real row. Deactivating hides it from the
  -- switcher and from anywhere new work can be assigned.
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (shop_id, name),
  -- Nullable and unique together: Postgres treats NULLs as distinct, so every
  -- branch that declines a code coexists happily while any two that pick one
  -- can't collide -- which is the whole point of a key you can key on.
  unique (shop_id, code)
);
create index shop_locations_shop_id_idx on public.shop_locations(shop_id);
create unique index shop_locations_one_primary_idx
  on public.shop_locations(shop_id) where is_primary;

alter table public.shop_locations enable row level security;

-- Reads are member-wide, like every other piece of shop reference data
-- (brands/cashiers/promotions/currencies in 0024): a cashier needs the name and
-- address of the branch they're ringing sales at, and a receipt prints it.
create policy "read shop_locations" on public.shop_locations for select
  using (is_shop_member(shop_id));

-- Writes are a Settings action, matching cashiers/promotions/shop_currencies
-- rather than the owner-only gate on shops itself. settings.access already
-- carries the authority to rename the shop and change its address (0024
-- widened `shops` update for exactly that reason), so withholding it here would
-- only mean a manager can edit the address of a one-branch shop but not of a
-- two-branch one.
create policy "write shop_locations" on public.shop_locations for all
  using (has_shop_permission(shop_id, 'settings.access'))
  with check (has_shop_permission(shop_id, 'settings.access'));

grant select, insert, update, delete on public.shop_locations to authenticated;

-- The location-level sibling of is_shop_member(). Later migrations gate POS,
-- inventory, timeclock and shift writes on this so a member assigned to one
-- branch can't ring a sale or move stock at another.
--
-- security definer, and for the reason spelled out at length in
-- 20260806000000_shifts.sql: an inline `exists (select 1 from shop_members ...)`
-- inside a policy runs under the CALLER's RLS, and shop_members is readable
-- only with staff.manage and friends -- so for an ordinary cashier the subquery
-- would see zero rows and deny everything. Wrapping it here evaluates against
-- the real table contents instead.
--
-- A null shop_members.location_id means "works at every location", which is
-- what every member has until the assignment column exists. That default is
-- what keeps this function from silently locking anyone out when it starts
-- being enforced.
create or replace function public.can_access_location(p_location_id uuid)
returns boolean
language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from public.shop_locations l
    where l.id = p_location_id
      and (
        public.owns_shop(l.shop_id)
        or exists (
          select 1 from public.shop_members m
          where m.shop_id = l.shop_id and m.user_id = auth.uid() and m.active
        )
      )
  );
$$;
grant execute on function public.can_access_location(uuid) to authenticated;

-- Backfill: one primary location per existing shop, carrying the address the
-- shop row already holds.
--
-- Named after the shop rather than a placeholder like "Main", because a store
-- carries its own name under this model -- "Ka Iibi Hargeisa" and "Ka Iibi
-- Berbera" can sit under one business. For a shop that has only ever had one
-- store the two names are simply the same, which is true and needs no edit;
-- when a second store opens the owner renames them to tell them apart.
insert into public.shop_locations (shop_id, name, city, neighborhood, contact_phone, is_primary)
select s.id, s.name, s.city, s.neighborhood, s.contact_phone, true
from public.shops s
where not exists (select 1 from public.shop_locations l where l.shop_id = s.id);

-- shops.city/neighborhood/contact_phone are deliberately NOT dropped here --
-- receipts and the settings panel still read them at this point, and this
-- migration is meant to be safe to apply on its own. 20260811000000 drops them
-- once the store-location editor owns the address outright.
