-- The chart of accounts: the fixed set of places a journal entry can land.
--
-- ## What this fixes that a category enum could not
--
-- expenses.category has twelve values and three of them are not operating
-- expenses. inventory_purchase buys an ASSET. owner_draw reduces EQUITY.
-- stock_loss is the cost of goods that left without selling, which belongs in
-- cost of sales, above gross profit. NON_OPERATING_CATEGORIES in
-- src/lib/expense-reporting.ts reaches the right net profit today by excluding
-- the first two by name -- the right answer arrived at by a filter, which is
-- why a balance sheet has never been possible: there is nowhere for the asset
-- to sit once it stops being an expense.
--
-- Typing each account is what turns that filter into a consequence. An account
-- of type 'asset' is on the balance sheet because of its type, not because a
-- list in TypeScript remembered to leave it out of the P&L.
--
-- ## Six types, and is_contra as a flag rather than a seventh
--
-- Accumulated depreciation is an asset that reduces assets; owner's draw is
-- equity that reduces equity; sales returns are revenue that reduce revenue.
-- Making each a type of its own would triple the set and every report would
-- have to know that 'contra_asset' groups with 'asset'. A boolean on the row
-- says the same thing and leaves the six sections a statement actually has.

create table public.accounts (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  -- Text, not integer: codes are displayed, sorted and matched as written, and
  -- a shop that wants '1000-1' for a second till should not be blocked by a
  -- column type. Sorting is lexicographic, which is why the seeds are all the
  -- same width.
  code text not null,
  name text not null,
  type text not null check (type in ('asset','liability','equity','revenue','cost_of_sales','expense')),
  -- Reduces its own type rather than adding to it. See the header.
  is_contra boolean not null default false,
  -- Archived, never deleted. An account with entries cannot be removed without
  -- silently changing every past statement it appears in, and an account
  -- without entries is not worth a delete path of its own. Archiving takes it
  -- out of pickers and leaves history readable.
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (shop_id, code)
);
create index accounts_shop_idx on public.accounts(shop_id, code);

alter table public.accounts enable row level security;

create policy "read accounts" on public.accounts for select
  using (has_shop_permission(shop_id, 'ledger.view'));
-- Adding an account is a chart change, which is a closing-level decision:
-- a chart that anyone who can post can extend stops being a fixed set.
create policy "write accounts" on public.accounts for all
  using (has_shop_permission(shop_id, 'ledger.close'))
  with check (has_shop_permission(shop_id, 'ledger.close'));

grant select, insert, update on public.accounts to authenticated;

-- The seed. One function, called from two places -- the trigger below for
-- shops that do not exist yet, and the backfill at the foot of this file for
-- the ones that do -- because a chart that differs between old and new shops
-- would make every cross-shop report meaningless.
--
-- Ranges follow the convention every accountant expects: 1000s assets, 2000s
-- liabilities, 3000s equity, 4000s revenue, 5000s cost of sales, 6000s
-- expenses. The nine expense accounts are exactly the nine remaining
-- expenses.category values, so a bill coded today has somewhere to land.
create or replace function public.default_chart_of_accounts()
returns table (code text, name text, type text, is_contra boolean)
language sql immutable set search_path = public as $$
  values
    ('1000'::text, 'Cash on Hand'::text,            'asset'::text,         false),
    ('1010',       'Bank',                          'asset',               false),
    ('1020',       'Mobile Money — Zaad',           'asset',               false),
    ('1021',       'Mobile Money — eDahab',         'asset',               false),
    ('1100',       'Accounts Receivable',           'asset',               false),
    ('1200',       'Inventory',                     'asset',               false),
    ('1500',       'Equipment',                     'asset',               false),
    ('1510',       'Furniture and Fittings',        'asset',               false),
    ('1590',       'Accumulated Depreciation',      'asset',               true),
    ('2000',       'Accounts Payable',              'liability',           false),
    ('2100',       'Sales Tax Payable',             'liability',           false),
    ('2200',       'Wages Payable',                 'liability',           false),
    ('2300',       'Loyalty Points Liability',      'liability',           false),
    ('3000',       'Owner''s Capital',              'equity',              false),
    ('3100',       'Owner''s Draw',                 'equity',              true),
    ('3900',       'Retained Earnings',             'equity',              false),
    ('4000',       'Sales Revenue',                 'revenue',             false),
    ('4100',       'Sales Returns',                 'revenue',             true),
    ('4200',       'Discounts Given',               'revenue',             true),
    ('5000',       'Cost of Goods Sold',            'cost_of_sales',       false),
    ('5100',       'Inventory Shrinkage',           'cost_of_sales',       false),
    ('6000',       'Rent',                          'expense',             false),
    ('6100',       'Utilities',                     'expense',             false),
    ('6200',       'Salaries and Wages',            'expense',             false),
    ('6300',       'Marketing',                     'expense',             false),
    ('6400',       'Supplies',                      'expense',             false),
    ('6500',       'Transport and Delivery',        'expense',             false),
    ('6600',       'Maintenance and Repairs',       'expense',             false),
    ('6700',       'Fees and Charges',              'expense',             false),
    ('6800',       'Depreciation',                  'expense',             false),
    ('6900',       'Other',                         'expense',             false);
$$;

-- Reproduced verbatim from public.seed_shop_defaults() as defined in
-- 20260823000000_owner_is_a_team_member.sql, with exactly one change: the
-- accounts insert below the members insert. The trigger itself is unchanged and
-- is not redefined -- CREATE OR REPLACE FUNCTION replaces the body a trigger
-- already points at.
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

  -- THE ONE CHANGE. on conflict do nothing for the same reason the two inserts
  -- above have it: this trigger must survive being re-run against a shop that
  -- is partly seeded.
  insert into public.accounts (shop_id, code, name, type, is_contra)
    select new.id, c.code, c.name, c.type, c.is_contra from public.default_chart_of_accounts() c
  on conflict (shop_id, code) do nothing;

  return new;
end;
$$;

-- Shops that already exist. Same guard as the roles backfill in
-- 20260904000000: on conflict do nothing means a shop that somehow has a
-- partial chart gains the rest rather than erroring, and re-running is free.
insert into public.accounts (shop_id, code, name, type, is_contra)
  select s.id, c.code, c.name, c.type, c.is_contra
    from public.shops s
   cross join public.default_chart_of_accounts() c
on conflict (shop_id, code) do nothing;
