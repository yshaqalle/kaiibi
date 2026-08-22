-- The chart of accounts: the named buckets every figure in Accounting rolls
-- up into, and the thing that makes a trial balance, a balance sheet and a
-- cash-flow statement possible at all.
--
-- The central decision, and the one everything else here follows from:
--
--   **The operational tables stay the record of truth.** A sale is the truth
--   about revenue, `expenses` about spend, `cash_accounts` about cash,
--   `invoices` about what is owed. The ledger does NOT re-record any of it.
--
-- The alternative -- posting a journal entry for every sale, refund, bill and
-- pay run -- is how a real general ledger works, and it is exactly what this
-- deliberately does not do. Retrofitting it onto a year of existing sales
-- means either backfilling entries that can drift from the rows they came
-- from, or having two numbers for one question and no way to say which is
-- right. A shopkeeper who counts the drawer and gets a different figure from
-- the app stops trusting the app.
--
-- So an account carries a `feed`: the name of the operational stream it
-- reports. `1000 Cash on hand` has feed `cash_on_hand`, and its balance IS the
-- sum of the cash accounts, computed when the statement is drawn (see
-- src/lib/trial-balance.ts). Accounts with no feed -- opening equity, a loan,
-- an accrual, a correction -- are hand-posted through the general journal in
-- the next migration.
--
-- That split is what lets both halves be honest: nothing is double-counted,
-- because each feed appears on exactly one account, and nothing is invented,
-- because a hand-posted balance had to be typed by a person who meant it.
--
-- The rule that keeps the split honest, enforced in post_journal_entry:
-- **a fed account cannot be hand-posted to.** An account is one or the other.
-- Allowing both is the single way this design can produce a wrong number --
-- credit `1000 Cash on hand` by hand and the shop's cash is counted twice, once
-- by the journal and once by the drawer the owner went on to re-count.

create table public.ledger_accounts (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  -- The shop's own numbering, typed by them and shown everywhere the account
  -- is. Text, not an integer: '1000' and '1000.1' are both real numbering
  -- schemes and leading zeros survive.
  code text not null,
  name text not null,
  type text not null check (type in ('asset','liability','equity','income','expense')),
  -- Where the account sits on a statement. `type` alone cannot place it: an
  -- asset is either current or fixed and a balance sheet must say which, and
  -- cost of sales has to sit above gross profit while an operating expense
  -- sits below it.
  subtype text not null check (subtype in (
    'current_asset','fixed_asset','other_asset',
    'current_liability','long_term_liability',
    'equity',
    'operating_income','other_income',
    'cost_of_sales','operating_expense','other_expense'
  )),
  -- The operational stream this account reports, or NULL for a hand-posted
  -- one. Enumerated rather than free text because each value is a query
  -- someone had to write: an unknown feed would silently report zero, which
  -- is the worst possible failure for a balance sheet.
  --
  -- Deliberately absent: `inventory_purchase` expenses. Buying stock is not a
  -- cost, it is one asset becoming another, and the stock it bought is already
  -- counted by the `inventory` feed. Giving restock spend an account of its
  -- own would count the same goods twice.
  feed text check (feed in (
    'cash_on_hand','bank','mobile_money',
    'accounts_receivable','inventory','fixed_assets','accumulated_depreciation',
    'accounts_payable','sales_tax_payable',
    'sales_revenue','cost_of_goods_sold','asset_disposal_result',
    'expense_rent','expense_utilities','expense_salaries_wages','expense_marketing',
    'expense_supplies','expense_transport_delivery','expense_maintenance_repairs',
    'expense_fees_charges','expense_other','expense_depreciation',
    'owner_draw'
  )),
  -- Sits under its parent and subtracts from it: accumulated depreciation
  -- against fixed assets, owner's draw against equity. A flag rather than a
  -- negative balance, because the statement has to PRINT it as a deduction --
  -- "less accumulated depreciation" is a line a reader looks for.
  contra boolean not null default false,
  -- What the account held on the day the shop started keeping books here.
  -- Signed in the account's normal direction, so a positive figure on an asset
  -- means the shop had that much. Without this, a business migrating in has a
  -- balance sheet that starts at zero and never balances.
  opening_balance_cents integer not null default 0,
  opening_balance_on date,
  -- Seeded by the default chart. Renamable and re-numberable -- a shop's own
  -- vocabulary matters -- but not deletable, because a feed with no account to
  -- report it would silently vanish from the balance sheet.
  is_system boolean not null default false,
  -- Kept, not deleted: an account with history behind it cannot go without
  -- taking the history with it. Archived accounts drop out of the pickers and
  -- out of any statement where they are zero.
  archived boolean not null default false,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id),
  updated_by uuid references auth.users(id),
  unique (shop_id, code),
  -- An opening balance on a fed account is the same double-count the header
  -- warns about, arriving through a different door: the feed already reports
  -- everything the account holds, including whatever it held on day one.
  constraint ledger_accounts_no_opening_on_feed
    check (feed is null or opening_balance_cents = 0)
);
create index ledger_accounts_shop_id_idx on public.ledger_accounts(shop_id);

-- One account per feed per shop. This is the constraint that makes
-- double-counting impossible rather than merely discouraged: two accounts both
-- claiming `sales_revenue` would each report the full period's takings and the
-- trial balance would be out by exactly one period's revenue.
create unique index ledger_accounts_shop_feed_idx
  on public.ledger_accounts(shop_id, feed) where feed is not null;

comment on column public.ledger_accounts.feed is
  'The operational stream this account reports. Its balance is computed from that stream when a statement is drawn -- no rows are posted for it. NULL means hand-posted through the general journal.';

alter table public.ledger_accounts enable row level security;

-- Reading the chart rides on the same bar as reading Accounting at all: the
-- account names are the vocabulary of every statement on the screen, and a
-- reader who can see a balance sheet but not what "1200" is called has been
-- given a puzzle rather than a report.
create policy "read ledger_accounts" on public.ledger_accounts for select
  using (has_any_shop_permission(shop_id, array['ledger.view', 'ledger.manage', 'sales.view', 'expenses.view']));
create policy "insert ledger_accounts" on public.ledger_accounts for insert
  with check (has_shop_permission(shop_id, 'ledger.manage'));
create policy "update ledger_accounts" on public.ledger_accounts for update
  using (has_shop_permission(shop_id, 'ledger.manage'))
  with check (has_shop_permission(shop_id, 'ledger.manage'));
-- A system account cannot be deleted at all, by anyone. Enforced here rather
-- than in the client because the client is not what protects the balance
-- sheet -- see the comment on `is_system`.
create policy "delete ledger_accounts" on public.ledger_accounts for delete
  using (has_shop_permission(shop_id, 'ledger.manage') and not is_system);

grant select, insert, update, delete on public.ledger_accounts to authenticated;

-- ---------------------------------------------------------------------------
-- The default chart
-- ---------------------------------------------------------------------------
-- Small on purpose. A shop that sells things over a counter needs about
-- twenty accounts, and handing it the two hundred a generic package ships
-- with is how a chart of accounts becomes something nobody maintains. Every
-- account here either has a feed -- so it fills itself in -- or is one a real
-- shop reaches for in its first month (owner's equity, a loan, a bank fee).
--
-- The numbering is the conventional one, and conventional is the point: an
-- accountant handed this recognises 1000s as assets and 4000s as income
-- without being told.
create or replace function public.default_ledger_accounts()
returns table (code text, name text, type text, subtype text, feed text, contra boolean)
language sql immutable as $$
  values
    -- 1000 assets
    ('1000'::text, 'Cash on hand'::text, 'asset'::text, 'current_asset'::text, 'cash_on_hand'::text, false),
    ('1010', 'Bank accounts', 'asset', 'current_asset', 'bank', false),
    ('1020', 'Mobile money', 'asset', 'current_asset', 'mobile_money', false),
    ('1100', 'Accounts receivable', 'asset', 'current_asset', 'accounts_receivable', false),
    ('1200', 'Inventory', 'asset', 'current_asset', 'inventory', false),
    ('1500', 'Fixed assets', 'asset', 'fixed_asset', 'fixed_assets', false),
    ('1510', 'Accumulated depreciation', 'asset', 'fixed_asset', 'accumulated_depreciation', true),
    -- 2000 liabilities
    ('2000', 'Accounts payable', 'liability', 'current_liability', 'accounts_payable', false),
    ('2100', 'Sales tax payable', 'liability', 'current_liability', 'sales_tax_payable', false),
    ('2200', 'Wages payable', 'liability', 'current_liability', null, false),
    ('2500', 'Loans', 'liability', 'long_term_liability', null, false),
    -- 3000 equity
    ('3000', 'Owner''s equity', 'equity', 'equity', null, false),
    ('3100', 'Owner''s draw', 'equity', 'equity', 'owner_draw', true),
    ('3200', 'Retained earnings', 'equity', 'equity', null, false),
    -- 4000 income
    ('4000', 'Sales revenue', 'income', 'operating_income', 'sales_revenue', false),
    ('4900', 'Other income', 'income', 'other_income', null, false),
    -- What an asset fetched, less what it was still worth on the books. Income
    -- rather than expense because it is signed: a loss is simply a negative
    -- gain, and giving a loss its own account would put the same disposal on
    -- two lines depending on how it went.
    ('4910', 'Gain or loss on asset disposal', 'income', 'other_income', 'asset_disposal_result', false),
    -- 5000 cost of sales
    ('5000', 'Cost of goods sold', 'expense', 'cost_of_sales', 'cost_of_goods_sold', false),
    -- 6000 operating expenses, one per expense category the app already has
    ('6000', 'Rent', 'expense', 'operating_expense', 'expense_rent', false),
    ('6010', 'Utilities', 'expense', 'operating_expense', 'expense_utilities', false),
    ('6020', 'Salaries and wages', 'expense', 'operating_expense', 'expense_salaries_wages', false),
    ('6030', 'Marketing', 'expense', 'operating_expense', 'expense_marketing', false),
    ('6040', 'Supplies', 'expense', 'operating_expense', 'expense_supplies', false),
    ('6050', 'Transport and delivery', 'expense', 'operating_expense', 'expense_transport_delivery', false),
    ('6060', 'Maintenance and repairs', 'expense', 'operating_expense', 'expense_maintenance_repairs', false),
    ('6070', 'Fees and charges', 'expense', 'operating_expense', 'expense_fees_charges', false),
    ('6080', 'Depreciation', 'expense', 'operating_expense', 'expense_depreciation', false),
    ('6900', 'Other expenses', 'expense', 'operating_expense', 'expense_other', false);
$$;

-- `on conflict do nothing` on BOTH unique keys, so this is safe to call for a
-- shop that already has a chart -- including one that renumbered an account
-- and would otherwise collide on the code.
create or replace function public.seed_ledger_accounts(p_shop_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  insert into public.ledger_accounts (shop_id, code, name, type, subtype, feed, contra, is_system)
    select p_shop_id, d.code, d.name, d.type, d.subtype, d.feed, d.contra, true
      from public.default_ledger_accounts() d
   where not exists (
     select 1 from public.ledger_accounts a
      where a.shop_id = p_shop_id and (a.code = d.code or (d.feed is not null and a.feed = d.feed))
   );
end;
$$;

create or replace function public.seed_shop_ledger() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform public.seed_ledger_accounts(new.id);
  return new;
end;
$$;

-- A trigger of its own rather than a line inside seed_shop_defaults(). That
-- function is defined in 20260823000000 and re-declaring it here to add one
-- statement would mean copying its whole body forward, where a later change to
-- either copy silently wins. Triggers fire in name order, and
-- `shops_seed_ledger` sorts after `shops_seed_defaults`, so the roles exist
-- first -- which matters only for readability, since this reads no roles.
drop trigger if exists shops_seed_ledger on public.shops;
create trigger shops_seed_ledger after insert on public.shops
  for each row execute function public.seed_shop_ledger();

-- Every shop that already exists.
do $$
declare v_shop record;
begin
  for v_shop in select id from public.shops loop
    perform public.seed_ledger_accounts(v_shop.id);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- The new permissions
-- ---------------------------------------------------------------------------
-- Two, not one. Reading a balance sheet and posting to the ledger are
-- genuinely different jobs: a shop's accountant reads, and only the person who
-- owns the books should be able to hand-post an entry that moves the bottom
-- line with no sale or receipt behind it.
--
-- Guarded updates so re-running is a no-op and a customised role is not
-- overwritten -- the shape 20260804000500 and 20260822000000 both used.
update public.roles
   set permissions = permissions || array['ledger.view', 'ledger.manage']
 where name = 'Owner'
   and not permissions && array['ledger.manage'];

-- A Manager already sets budgets and cash balances, which is the closest thing
-- the catalog has to keeping the books. Granting only `ledger.view` here
-- deliberately stops short of hand-posting: an owner widens it from Settings
-- if that is the shape of their business.
update public.roles
   set permissions = permissions || array['ledger.view']
 where 'budgets.manage' = any(permissions)
   and not ('ledger.view' = any(permissions));

-- The default roles a NEW shop gets, kept in step with the update above.
-- Copied forward from 20260826000100 with the two ledger permissions added --
-- the established shape for this function, which is redefined in full each
-- time the catalog grows.
create or replace function public.default_shop_roles()
returns table (name text, permissions text[])
language sql immutable as $$
  values
    ('Cashier'::text, array['pos.access', 'inventory.view', 'discounts.apply', 'discounts.manual']::text[]),
    ('Manager'::text, array[
      'pos.access', 'inventory.view', 'inventory.edit', 'sales.view', 'sales.edit',
      'customers.view', 'customers.edit', 'dashboard.view',
      'expenses.view', 'expenses.manage', 'invoices.view', 'invoices.manage',
      'budgets.manage', 'registers.manage', 'discounts.apply', 'discounts.manual',
      'ledger.view'
    ]::text[]),
    ('Owner'::text, array[
      'pos.access', 'inventory.view', 'inventory.edit', 'sales.view', 'sales.edit', 'sales.refund',
      'customers.view', 'customers.edit', 'dashboard.view', 'settings.access', 'staff.manage',
      'people.timeoff.approve', 'people.payroll.manage', 'people.timesheet.view', 'people.schedule.manage',
      'expenses.view', 'expenses.manage', 'invoices.view', 'invoices.manage', 'budgets.manage', 'registers.manage',
      'discounts.apply', 'discounts.manual', 'ledger.view', 'ledger.manage'
    ]::text[]);
$$;
