-- Where the work happened: the operational half of "make every table store
-- aware".
--
-- These four are REQUIRED, not nullable, because each one is inherently a thing
-- that happened at a place. A shift is worked somewhere; a clock-in happens at
-- a door; a till sits on a counter; a cashier profile belongs to a register.
-- Allowing null would mean "we don't know where", which for these is never a
-- legitimate state -- only a gap in the data.
--
-- The accounting tables get the same column NULLABLE in the next migration, and
-- for the opposite reason: rent for the whole business genuinely has no single
-- store, and forcing one would be a lie that quietly distorts per-store P&L.
--
-- Every existing row is backfilled to its shop's primary store, which is
-- correct: a shop only has more than one store from the moment it creates one,
-- and everything recorded before that happened at the one store it had.

-- ---------------------------------------------------------------------------
-- time_entries -- where someone clocked in
-- ---------------------------------------------------------------------------

alter table public.time_entries add column location_id uuid references public.shop_locations(id);

update public.time_entries t
  set location_id = (
    select l.id from public.shop_locations l
    where l.shop_id = t.shop_id
    order by l.is_primary desc, l.created_at asc
    limit 1
  )
  where t.location_id is null;

alter table public.time_entries alter column location_id set not null;
create index time_entries_location_idx on public.time_entries(location_id);

-- ---------------------------------------------------------------------------
-- shifts -- where someone is scheduled to work
-- ---------------------------------------------------------------------------

-- This also retires the interim in src/components/schedule/schedule-tab.tsx,
-- which validated every shift against whichever store the DEVICE was set to.
-- With a store on the shift, validation reads that store's opening hours, which
-- is what makes "outside opening hours" mean anything once two stores keep
-- different ones.
alter table public.shifts add column location_id uuid references public.shop_locations(id);

update public.shifts s
  set location_id = (
    select l.id from public.shop_locations l
    where l.shop_id = s.shop_id
    order by l.is_primary desc, l.created_at asc
    limit 1
  )
  where s.location_id is null;

alter table public.shifts alter column location_id set not null;
create index shifts_location_date_idx on public.shifts(location_id, shift_date);

-- ---------------------------------------------------------------------------
-- cashiers -- which register a cashier profile belongs to
-- ---------------------------------------------------------------------------

alter table public.cashiers add column location_id uuid references public.shop_locations(id);

update public.cashiers c
  set location_id = (
    select l.id from public.shop_locations l
    where l.shop_id = c.shop_id
    order by l.is_primary desc, l.created_at asc
    limit 1
  )
  where c.location_id is null;

alter table public.cashiers alter column location_id set not null;
create index cashiers_location_idx on public.cashiers(location_id);

-- ---------------------------------------------------------------------------
-- cash_accounts -- where the money physically is
-- ---------------------------------------------------------------------------

-- The most literal of the four: 20260804000500 describes this table as "where
-- the shop's money physically is", a drawer someone counts. A drawer is at a
-- store, and two stores each counting their own till is the entire point.
alter table public.cash_accounts add column location_id uuid references public.shop_locations(id);

update public.cash_accounts a
  set location_id = (
    select l.id from public.shop_locations l
    where l.shop_id = a.shop_id
    order by l.is_primary desc, l.created_at asc
    limit 1
  )
  where a.location_id is null;

alter table public.cash_accounts alter column location_id set not null;
create index cash_accounts_location_idx on public.cash_accounts(location_id);

-- The old constraint made one account name unique per SHOP, so two stores could
-- not each have a "Till". Scoped to the store, which is what the name describes.
alter table public.cash_accounts drop constraint if exists cash_accounts_shop_id_name_key;
alter table public.cash_accounts add constraint cash_accounts_location_name_key unique (location_id, name);
