# Ledger Foundations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put a double-entry general ledger under kaiibi — accounts, balanced journal entries, periods and an append-only audit log — so that the 16 reports that need one become possible.

**Architecture:** Five tables behind `security definer` RPCs with no write policies, exactly the posture `receive_stock` and `save_stock_count` already take. A journal line stores **one signed `amount_cents`** rather than a debit and a credit column, so "this entry balances" is literally `sum(amount_cents) = 0` and a line cannot be both. A deferred constraint trigger enforces that at commit, so an unbalanced entry cannot be written even by a bug that bypasses the RPC. The chart of accounts is seeded per shop from one fixed function, reused by both the new-shop trigger and the backfill.

**Tech Stack:** Postgres 15 (Supabase), plpgsql, TypeScript. Tests: `npm run test:db` for everything the database enforces, `npm test` (Jest) for pure arithmetic. No new dependencies.

## Global Constraints

Every task's requirements implicitly include this section.

### Scope — this plan is the database only

This is **phase 1a** of [the accounting design](../specs/2026-08-22-accounting-standards-design.md). It ships no screens. That is deliberate: every screen in the project reads these tables, all of the project's structural risk lives here, and this half is fully verifiable on its own with `npm run test:db`. The Chart of Accounts, Journals, Trial Balance and Audit Log screens are a second plan against the interfaces this one produces.

**Explicitly not in this plan**, and do not add them: cost layers, FIFO, any change to `complete_sale` / `receive_stock` / `save_stock_count` / `record_invoice_payment` / `post_payroll_run`, the historical backfill of past trading, fixed assets, depreciation, `create_bill`, `transfer_funds`, period close, or any React component. Phase 1a writes **no posting side for any existing RPC.** The only thing that can write a journal entry when this plan is done is a human using `post_journal_entry`.

### Baselines — green today, must be green at every commit

- `npx tsc --noEmit` → **clean, exit 0**
- `npm test` → **135 suites, 2086 tests, all passing**
- `npm run lint` → **76 problems (44 errors, 32 warnings)**. Do not add to this number, and do not "fix" pre-existing ones in this plan's commits.
- `npm run test:db` → requires `npx supabase start` first. Run it before every commit that touches `supabase/`.

### Migration conventions this repo enforces

- **Numbering.** The latest migration is `20260903000200`. This plan adds `20260904000000` through `20260904000500`, in order. Never renumber an existing file.
- **A migration that grants a permission to a default role must update `default_shop_roles()` too**, not only run an `update public.roles`. The update reaches shops that exist; the function reaches shops created tomorrow. Miss it and "Manager" means two different things either side of the migration date. This is stated at `20260903000000_inventory_verbs_and_stock_loss.sql:49-58`.
- **Backfills are guarded** so re-running is a no-op and a customised role is not overwritten — `not permissions && array[...]` means "holds neither".
- **`create or replace function` replaces the whole body.** When extending an existing function, reproduce it verbatim and state the single change in a comment. This repo says so in several places; `20260903000000:62-64` is the model to copy.
- **Comment density.** Read any migration from `20260903*` before writing one. These files explain *why*, at length, in prose. A migration here that only contains SQL will look wrong next to its neighbours.
- **`security definer` + `set search_path = public`** on every RPC, and `grant execute ... to authenticated`.

### Test conventions

- DB checks live in `supabase/tests/verify-*.sql` and are **auto-discovered by glob** — no runner edit is needed to add one.
- A script must print **`ALL CHECKS PASSED`** on success. The runner greps for that (or `all assertions passed`); a script that asserts correctly but prints neither is reported as FAIL.
- Each script builds its own fixture inside one `do $$ ... $$` block and rolls back via an `exception` clause. Copy the shape of `supabase/tests/verify-inventory-permissions.sql`.
- Failures raise `exception 'FAIL: ...'`.
- **These scripts run as the `postgres` superuser, so RLS does not apply to them.** Two consequences, and both are traps:
  1. **Never assert a policy by attempting the operation.** A `delete` that a policy should refuse will succeed anyway, and the check reports on nothing. Assert against `pg_policies` instead — the plan does this in Task 5.
  2. **An RPC that calls `has_shop_permission` will refuse**, because `auth.uid()` reads `request.jwt.claims->>'sub'` and there is no JWT. Before calling one, become a user:
     ```sql
     perform set_config('request.jwt.claims', json_build_object('sub', v_owner_id)::text, true);
     perform set_config('role', 'authenticated', true);
     ```
     `supabase/tests/verify-accounting-writes.sql:29-39` is the model. **Setting `role` also turns RLS on**, so any raw insert into a table with no write policy must happen *before* this, or be preceded by `perform set_config('role', 'postgres', true);`. This plan's checks 10–15 are raw writes and run as postgres; checks 16–21 go through the RPCs and run as `authenticated`.
- **Every test step below names the mutation that must turn it red.** After a test passes, apply the named mutation, watch it fail, revert. This is not optional. This branch has shipped tests that could not fail.

### Design rules that must not be quietly changed

- **A line stores one signed `amount_cents`. Debit positive, credit negative.** Never add a `debit_cents`/`credit_cents` pair — presenting two columns is the UI's job, and a schema with both invites a row that is somehow both.
- **`amount_cents <> 0`.** A zero line carries no information and would let an "entry" of two zero lines pass the balance check while meaning nothing.
- **Money is integer cents everywhere**, matching every existing table. Never `numeric`, never a float.
- **An account that has been posted to can never be deleted or re-typed.** Renaming and archiving are allowed. Deleting it would silently change every past statement it appears in.
- **Posted entries are immutable.** Correction is `reverse_journal_entry`, which writes a mirror entry linked to the original. Never an `update`.
- **`accounting_audit_log` has no update or delete policy and never gets one.**

## File Structure

| File | Responsibility |
|---|---|
| `supabase/migrations/20260904000000_ledger_permissions.sql` | The three `ledger.*` permissions, `default_shop_roles()`, the guarded backfill |
| `supabase/migrations/20260904000100_chart_of_accounts.sql` | `accounts`, `default_chart_of_accounts()`, seeding for new and existing shops |
| `supabase/migrations/20260904000200_accounting_periods.sql` | `accounting_periods`, `open_period_for()` |
| `supabase/migrations/20260904000300_journal.sql` | `journal_entries`, `journal_lines`, the deferred balance trigger, the immutability trigger |
| `supabase/migrations/20260904000400_accounting_audit_log.sql` | `accounting_audit_log` and the triggers that write it |
| `supabase/migrations/20260904000500_journal_rpcs.sql` | `post_journal_entry()`, `reverse_journal_entry()` |
| `supabase/tests/verify-ledger.sql` | Every assertion about the above that only Postgres can make |
| `src/types/models.ts` | `Account`, `JournalEntry`, `JournalLine`, `AccountType` (modify) |
| `src/lib/ledger.ts` | The Supabase-facing client: list accounts, list entries, post, reverse |
| `src/lib/ledger-math.ts` | Pure arithmetic — trial balance, account balances, entry validation. No Supabase import, so it is testable under Jest |
| `src/lib/__tests__/ledger-math.test.ts` | Jest tests for the above |
| `src/lib/permissions.ts` | Three new catalogue entries (modify) |
| `src/lib/permission-groups.ts` | Place them in the money group (modify) |

`ledger-math.ts` is separate from `ledger.ts` for the reason `expense-reporting.ts` is separate from `expenses.ts`, stated in that file's header: the client module pulls in AsyncStorage and cannot load outside a native runtime, so anything importing it is untestable under Jest.

---

### Task 1: The three ledger permissions

**Files:**
- Create: `supabase/migrations/20260904000000_ledger_permissions.sql`
- Modify: `src/lib/permissions.ts`
- Modify: `src/lib/permission-groups.ts`
- Test: `supabase/tests/verify-ledger.sql` (create — checks 1–3)

**Interfaces:**
- Consumes: nothing.
- Produces: the permission strings `'ledger.view'`, `'ledger.post'`, `'ledger.close'`, readable by `has_shop_permission(shop_id, 'ledger.view')`. Every later task's RLS depends on these existing.

- [ ] **Step 1: Write the failing test**

Create `supabase/tests/verify-ledger.sql`:

```sql
-- The ledger: permissions, chart of accounts, balanced entries, immutability.
--
-- None of this can be checked from TypeScript. Every assertion here is a fact
-- about a constraint, a trigger, an RLS policy or a security definer function,
-- and the client can only ever observe what those already decided.
--
-- Runs inside one DO block whose EXCEPTION clause rolls it all back.

\set ON_ERROR_STOP on

do $$
declare
  v_owner_id     uuid := gen_random_uuid();
  v_shop_id      uuid;
  v_perms        text[];
  -- Used from Task 4 onward. Declared here because this block grows one check
  -- at a time and a later task must not have to edit this header.
  v_raised       boolean;
begin
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
    values (v_owner_id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            'verify-ledger-' || v_owner_id || '@example.test', '', now(), now(), now());

  insert into public.shops (owner_id, name) values (v_owner_id, 'Ledger Shop') returning id into v_shop_id;

  -- 1. The seeded Owner holds all three verbs on a shop created after this
  -- migration. default_shop_roles() reaches shops that do not exist yet; the
  -- backfill below reaches the ones that do. Both are required and this checks
  -- the half that is easiest to forget.
  select permissions into v_perms from public.roles where shop_id = v_shop_id and name = 'Owner';
  if v_perms is null then
    raise exception 'FAIL: no seeded Owner role for the fixture shop';
  end if;
  if not v_perms @> array['ledger.view', 'ledger.post', 'ledger.close'] then
    raise exception 'FAIL: seeded Owner is missing a ledger permission: %', v_perms;
  end if;

  -- 2. The seeded Manager holds ledger.view and NOTHING else. Reading the books
  -- is ordinary; writing a manual journal entry is the one action that can put
  -- them into a state nobody can explain later, so it is granted deliberately
  -- or not at all.
  select permissions into v_perms from public.roles where shop_id = v_shop_id and name = 'Manager';
  if not v_perms @> array['ledger.view'] then
    raise exception 'FAIL: seeded Manager cannot read the books: %', v_perms;
  end if;
  if v_perms && array['ledger.post', 'ledger.close'] then
    raise exception 'FAIL: seeded Manager was handed a write verb: %', v_perms;
  end if;

  -- 3. The seeded Cashier holds none of them. A till role gains nothing here.
  select permissions into v_perms from public.roles where shop_id = v_shop_id and name = 'Cashier';
  if v_perms && array['ledger.view', 'ledger.post', 'ledger.close'] then
    raise exception 'FAIL: seeded Cashier was handed a ledger verb: %', v_perms;
  end if;

  raise notice 'ALL CHECKS PASSED';
  raise exception 'rollback fixture';
exception
  when others then
    if sqlerrm = 'rollback fixture' then return; end if;
    raise;
end $$;
```

- [ ] **Step 2: Run it and verify it fails**

Run: `npx supabase start && npm run test:db -- --no-reset`
Expected: `verify-ledger  FAIL` with `FAIL: seeded Owner is missing a ledger permission`.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/20260904000000_ledger_permissions.sql`:

```sql
-- Three verbs for the general ledger, and why they are not one.
--
-- Reading the books, writing to them by hand, and closing a month are three
-- different levels of trust. A manager reconciling a supplier statement needs
-- the first and neither of the others; a free-form debit/credit form is the one
-- screen in the app that can put the books into a state nobody can explain
-- later, and locking a period is irreversible by design.
--
-- ## Why these do NOT default on, where inventory.count did
--
-- 20260903000000 gave both new inventory verbs to every role already holding
-- inventory.edit, because narrowing a permission a shop had already granted
-- would take a working feature away from a shop that did nothing. Nothing is
-- being narrowed here: no role holds a ledger permission today because none
-- existed, so there is no working feature to protect and no shop to surprise.
-- ledger.post in particular is exactly the grant that should be made on
-- purpose rather than inherited from a permission granted for another reason.
--
-- Manager gets ledger.view only. Owner gets all three -- redundantly, since
-- user_has_shop_permission short-circuits on shops.owner_id, but the Roles
-- screen would otherwise show the owner holding nothing.
--
-- Staff who record sales need no grant at all. Once the posting phases land,
-- the ledger is written underneath them by security definer functions that do
-- not consult these.

-- Existing shops. Guarded so re-running is a no-op and a customised role is not
-- overwritten -- the shape 20260804000500 used for budgets.manage and
-- 20260903000000 used for the inventory verbs.
--
-- Keyed on sales.view rather than on any expense permission: the Accounting tab
-- is gated on sales.view today, so "already sees money" is the population that
-- should be able to read the books, and it is the same population the P&L was
-- opened to in 20260804000200.
update public.roles
  set permissions = permissions || array['ledger.view']
  where permissions @> array['sales.view']
    and not permissions && array['ledger.view'];

-- Shops that do not exist yet.
--
-- Reproduced verbatim from public.default_shop_roles() as defined in
-- 20260903000000_inventory_verbs_and_stock_loss.sql, with exactly two changes:
-- 'ledger.view' is added to Manager, and all three verbs are added to Owner.
-- Cashier is deliberately untouched -- it does not hold sales.view, and the
-- point of the backfill's guard is that a till role gains nothing.
create or replace function public.default_shop_roles()
returns table (name text, permissions text[])
language sql immutable set search_path = public as $$
  values
    ('Cashier'::text, array['pos.access', 'inventory.view', 'discounts.apply', 'discounts.manual']::text[]),
    ('Manager'::text, array[
      'pos.access', 'inventory.view', 'inventory.edit', 'inventory.count', 'inventory.transfer',
      'sales.view', 'sales.edit',
      'customers.view', 'customers.edit', 'dashboard.view',
      'expenses.view', 'expenses.manage', 'invoices.view', 'invoices.manage',
      'budgets.manage', 'registers.manage', 'discounts.apply', 'discounts.manual',
      'ledger.view'
    ]::text[]),
    ('Owner'::text, array[
      'pos.access', 'inventory.view', 'inventory.edit', 'inventory.count', 'inventory.transfer',
      'sales.view', 'sales.edit', 'sales.refund',
      'customers.view', 'customers.edit', 'dashboard.view', 'settings.access', 'staff.manage',
      'people.timeoff.approve', 'people.payroll.manage', 'people.timesheet.view', 'people.schedule.manage',
      'expenses.view', 'expenses.manage', 'invoices.view', 'invoices.manage', 'budgets.manage', 'registers.manage',
      'discounts.apply', 'discounts.manual',
      'ledger.view', 'ledger.post', 'ledger.close'
    ]::text[]);
$$;
```

- [ ] **Step 4: Add the three to the client catalogue**

In `src/lib/permissions.ts`, add to the `Permission` union after `'budgets.manage'`:

```ts
  | 'ledger.view'
  | 'ledger.post'
  | 'ledger.close'
```

and to the `PERMISSIONS` array, after the `budgets.manage` entry:

```ts
  { key: 'ledger.view', label: 'View the books', description: 'Read the chart of accounts, journals, trial balance and financial statements.' },
  { key: 'ledger.post', label: 'Post journal entries', description: 'Write manual entries to the ledger, and reverse posted ones. A posted entry can never be edited.' },
  { key: 'ledger.close', label: 'Close an accounting period', description: 'Lock a month so its numbers stop moving, and change how stock is valued.' },
```

In `src/lib/permission-groups.ts`, add all three to the group that already contains `'budgets.manage'`, immediately after it:

```ts
      'budgets.manage',
      'ledger.view',
      'ledger.post',
      'ledger.close',
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm run test:db`
Expected: `verify-ledger  pass`

- [ ] **Step 6: Prove the test can fail**

Mutation: in the migration, remove `'ledger.view'` from the Manager array in `default_shop_roles()`. Run `npm run test:db`. Expected: `FAIL: seeded Manager cannot read the books`. Revert.

Second mutation: add `'ledger.post'` to the Manager array. Expected: `FAIL: seeded Manager was handed a write verb`. Revert.

- [ ] **Step 7: Verify the rest is green and commit**

Run: `npx tsc --noEmit && npm test && npm run lint`
Expected: exit 0; 135 suites / 2086 tests; 76 lint problems.

```bash
git add supabase/migrations/20260904000000_ledger_permissions.sql supabase/tests/verify-ledger.sql src/lib/permissions.ts src/lib/permission-groups.ts
git commit -m "feat(accounting): three verbs for the ledger, granted on purpose"
```

---

### Task 2: The chart of accounts

**Files:**
- Create: `supabase/migrations/20260904000100_chart_of_accounts.sql`
- Modify: `supabase/tests/verify-ledger.sql` (checks 4–7)

**Interfaces:**
- Consumes: `ledger.view` / `ledger.close` from Task 1.
- Produces: `public.accounts (id, shop_id, code, name, type, is_contra, archived_at)` with `type` in `('asset','liability','equity','revenue','cost_of_sales','expense')`; and `public.default_chart_of_accounts()` returning `(code text, name text, type text, is_contra boolean)`. Task 4's `journal_lines.account_id` references this. Task 6 resolves accounts by `(shop_id, code)`.

- [ ] **Step 1: Write the failing test**

Insert before `raise notice 'ALL CHECKS PASSED';` in `supabase/tests/verify-ledger.sql`:

```sql
  -- 4. A new shop gets a full chart of accounts, seeded by the same trigger
  -- that seeds its roles.
  if (select count(*) from public.accounts where shop_id = v_shop_id) < 30 then
    raise exception 'FAIL: shop seeded with only % accounts', (select count(*) from public.accounts where shop_id = v_shop_id);
  end if;

  -- 5. The three accounts the whole design turns on exist, and are the type
  -- that makes a balance sheet possible. inventory_purchase must reach an
  -- ASSET, owner_draw must reach EQUITY, and stock_loss must reach COST OF
  -- SALES -- not the expense account each of them is filed under today.
  if not exists (select 1 from public.accounts where shop_id = v_shop_id and code = '1200' and type = 'asset') then
    raise exception 'FAIL: 1200 Inventory is missing or is not an asset';
  end if;
  if not exists (select 1 from public.accounts where shop_id = v_shop_id and code = '3100' and type = 'equity' and is_contra) then
    raise exception 'FAIL: 3100 Owner''s Draw is missing or is not contra-equity';
  end if;
  if not exists (select 1 from public.accounts where shop_id = v_shop_id and code = '5100' and type = 'cost_of_sales') then
    raise exception 'FAIL: 5100 Inventory Shrinkage is missing or is not cost of sales';
  end if;

  -- 6. Codes are unique per shop. Two accounts numbered 1000 would make every
  -- statement ambiguous and nothing would report the collision.
  begin
    insert into public.accounts (shop_id, code, name, type) values (v_shop_id, '1000', 'Duplicate', 'asset');
    raise exception 'FAIL: a duplicate account code was accepted';
  exception
    when unique_violation then null;
  end;

  -- 7. A bogus type is refused. The six are a closed set because every report
  -- groups by them; a seventh spelling would silently become a seventh section
  -- that no statement knows how to place.
  begin
    insert into public.accounts (shop_id, code, name, type) values (v_shop_id, '9999', 'Bogus', 'liabilities');
    raise exception 'FAIL: a bogus account type was accepted';
  exception
    when check_violation then null;
  end;
```

- [ ] **Step 2: Run it and verify it fails**

Run: `npm run test:db -- --no-reset`
Expected: FAIL with `relation "public.accounts" does not exist`.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/20260904000100_chart_of_accounts.sql`:

```sql
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

  select u.email,
         coalesce(p.full_name, u.raw_user_meta_data->>'full_name', split_part(u.email, '@', 1))
    into v_email, v_name
    from auth.users u
    left join public.profiles p on p.id = u.id
   where u.id = new.owner_id;

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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test:db`
Expected: `verify-ledger  pass`

- [ ] **Step 5: Prove the test can fail**

Mutation: change `('1200', 'Inventory', 'asset', false)` to `('1200', 'Inventory', 'expense', false)` in `default_chart_of_accounts()`. Run `npm run test:db`. Expected: `FAIL: 1200 Inventory is missing or is not an asset`. Revert.

Second mutation: drop the `unique (shop_id, code)` line from the table. Expected: `FAIL: a duplicate account code was accepted`. Revert.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/20260904000100_chart_of_accounts.sql supabase/tests/verify-ledger.sql
git commit -m "feat(accounting): a chart of accounts, seeded for every shop"
```

---

### Task 3: Accounting periods

**Files:**
- Create: `supabase/migrations/20260904000200_accounting_periods.sql`
- Modify: `supabase/tests/verify-ledger.sql` (checks 8–9)

**Interfaces:**
- Consumes: `ledger.view` / `ledger.close` from Task 1.
- Produces: `public.accounting_periods (id, shop_id, starts_on, ends_on, status)` with `status` in `('open','closed','locked')`, and `public.open_period_for(p_shop_id uuid, p_on date) returns uuid` which **raises** if the date falls in a closed or locked period and **auto-creates** an open period if none exists. Task 6 calls it.

- [ ] **Step 1: Write the failing test**

Insert before `raise notice 'ALL CHECKS PASSED';`:

```sql
  -- 8. A month with no period row yet is open, and asking for it creates it.
  -- A shop should not have to be set up before it can trade; the first entry
  -- of a month opens that month.
  if public.open_period_for(v_shop_id, date '2026-08-15') is null then
    raise exception 'FAIL: open_period_for did not open a period for an untouched month';
  end if;
  if (select count(*) from public.accounting_periods
        where shop_id = v_shop_id and starts_on = date '2026-08-01') <> 1 then
    raise exception 'FAIL: open_period_for did not create exactly one August period';
  end if;

  -- 9. A closed month refuses. This is the whole point of closing, and it must
  -- be refused HERE rather than in the UI -- a period that only the client
  -- respects is not closed.
  update public.accounting_periods set status = 'closed'
    where shop_id = v_shop_id and starts_on = date '2026-08-01';
  begin
    perform public.open_period_for(v_shop_id, date '2026-08-15');
    raise exception 'FAIL: a closed period accepted a posting date';
  exception
    when sqlstate 'P0001' then
      if position('closed' in sqlerrm) = 0 then raise; end if;
  end;
  update public.accounting_periods set status = 'open'
    where shop_id = v_shop_id and starts_on = date '2026-08-01';
```

- [ ] **Step 2: Run it and verify it fails**

Run: `npm run test:db -- --no-reset`
Expected: FAIL with `function public.open_period_for(uuid, date) does not exist`.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/20260904000200_accounting_periods.sql`:

```sql
-- One row per month per shop, and the gate that decides whether anything may
-- be posted into it.
--
-- ## Three states, not two
--
--   open    -- everything posts
--   closed  -- ordinary posting is refused; an owner may still post an
--              adjusting entry dated into the month, and the month can be
--              re-opened. Reversible, and audited.
--   locked  -- nothing posts, ever. Manual, deliberate, final.
--
-- The middle state exists because August's electricity bill arrives in
-- September. With only open and locked, a month is either editable forever --
-- which is what closing exists to prevent -- or a genuinely late bill has
-- nowhere to go and the shop learns to backdate the next one instead.
--
-- ## Why rows are created on demand
--
-- A shop should not have to be configured before it can trade. Rather than
-- seeding twelve months per shop per year -- which would need a job, and would
-- be wrong for a shop that opens in March -- the first thing to ask about a
-- month opens it. That makes the absence of a row mean "nobody has traded in
-- this month yet", which is a true and useful thing for it to mean.

create table public.accounting_periods (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  -- Always the first and last day of one calendar month. Stored as a range
  -- rather than a year+month pair so a future non-calendar period (a 4-4-5
  -- retail month) needs no migration, and so the containment test below is an
  -- ordinary BETWEEN rather than date arithmetic.
  starts_on date not null,
  ends_on date not null,
  status text not null default 'open' check (status in ('open','closed','locked')),
  closed_at timestamptz,
  closed_by uuid references auth.users(id),
  -- What was still unresolved when it closed. A month closed with a stock count
  -- outstanding is still closed -- refusing would mean shops that never count
  -- never close -- but which corners were cut has to survive on the record.
  exceptions text[] not null default '{}',
  created_at timestamptz not null default now(),
  constraint accounting_periods_ordered check (ends_on >= starts_on),
  unique (shop_id, starts_on)
);
create index accounting_periods_shop_idx on public.accounting_periods(shop_id, starts_on desc);

alter table public.accounting_periods enable row level security;

create policy "read accounting_periods" on public.accounting_periods for select
  using (has_shop_permission(shop_id, 'ledger.view'));
create policy "write accounting_periods" on public.accounting_periods for all
  using (has_shop_permission(shop_id, 'ledger.close'))
  with check (has_shop_permission(shop_id, 'ledger.close'));

grant select, insert, update on public.accounting_periods to authenticated;

-- The gate. Returns the period a date belongs to, opening it if it is the
-- first time anyone has asked, and raising if it is shut.
--
-- security definer because it INSERTS: a member holding ledger.post but not
-- ledger.close must be able to post into a month nobody has opened yet, and
-- the write policy above would refuse them. What they cannot do is re-open a
-- closed one -- this function never changes an existing row's status.
create or replace function public.open_period_for(p_shop_id uuid, p_on date)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_id uuid;
  v_status text;
  v_start date := date_trunc('month', p_on)::date;
begin
  select id, status into v_id, v_status
    from public.accounting_periods
   where shop_id = p_shop_id and p_on between starts_on and ends_on;

  if v_id is null then
    insert into public.accounting_periods (shop_id, starts_on, ends_on)
      values (p_shop_id, v_start, (v_start + interval '1 month - 1 day')::date)
    -- Two concurrent first-entries of a month race here. The loser takes the
    -- winner's row rather than failing, which is why this is on conflict and
    -- not a plain insert.
    on conflict (shop_id, starts_on) do update set starts_on = excluded.starts_on
    returning id, status into v_id, v_status;
  end if;

  if v_status <> 'open' then
    raise exception 'This period is %  — posting into it is refused. Re-open it first.', v_status
      using errcode = 'P0001';
  end if;

  return v_id;
end;
$$;

grant execute on function public.open_period_for(uuid, date) to authenticated;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test:db`
Expected: `verify-ledger  pass`

- [ ] **Step 5: Prove the test can fail**

Mutation: delete the `if v_status <> 'open' then ... end if;` block. Run `npm run test:db`. Expected: `FAIL: a closed period accepted a posting date`. Revert.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/20260904000200_accounting_periods.sql supabase/tests/verify-ledger.sql
git commit -m "feat(accounting): months open on demand and refuse when closed"
```

---

### Task 4: Journal entries, lines, and the constraint that cannot be bypassed

**Files:**
- Create: `supabase/migrations/20260904000300_journal.sql`
- Modify: `supabase/tests/verify-ledger.sql` (checks 10–13)

**Interfaces:**
- Consumes: `accounts` (Task 2), `accounting_periods` (Task 3).
- Produces: `public.journal_entries (id, shop_id, period_id, entry_date, reference, description, source, status, location_id, reverses_entry_id, created_by, created_at)` with `source` in `('manual','sale','refund','settlement','bill','payment','payroll','stock','count','transfer','asset','depreciation','close','opening')` and `status` in `('draft','posted','reversed')`; and `public.journal_lines (id, entry_id, account_id, amount_cents, location_id, memo)` where **`amount_cents` is signed, debit positive**. Task 6 inserts through these.

- [ ] **Step 1: Write the failing test**

Insert before `raise notice 'ALL CHECKS PASSED';`:

```sql
  -- 10. A balanced entry is accepted. Deferred means the imbalance is legal
  -- BETWEEN the two inserts and only judged at commit, which is the only way
  -- to write two rows that must sum to zero.
  declare
    v_entry uuid;
    v_cash  uuid := (select id from public.accounts where shop_id = v_shop_id and code = '1000');
    v_shrink uuid := (select id from public.accounts where shop_id = v_shop_id and code = '5100');
  begin
    insert into public.journal_entries (shop_id, period_id, entry_date, description, source, status, created_by)
      values (v_shop_id, public.open_period_for(v_shop_id, date '2026-08-15'), date '2026-08-15',
              'balanced', 'manual', 'posted', v_owner_id)
      returning id into v_entry;
    insert into public.journal_lines (entry_id, account_id, amount_cents) values (v_entry, v_shrink,  84000);
    insert into public.journal_lines (entry_id, account_id, amount_cents) values (v_entry, v_cash,   -84000);
  end;

  -- 11. An UNBALANCED entry is refused, and refused for a write that never went
  -- near post_journal_entry. This is the assertion the whole design rests on.
  --
  -- SET CONSTRAINTS ... IMMEDIATE is what makes this testable inside a
  -- transaction that is going to roll back: the trigger is deferred to commit,
  -- and commit never arrives here. A flag rather than a raise-inside-a-raise,
  -- because plpgsql's exception handler cannot tell "the assertion tripped"
  -- from "the thing being asserted about tripped" when both are P0001 --
  -- the shape verify-inventory-permissions.sql uses for the same reason.
  v_raised := false;
  declare
    v_bad uuid;
    v_cash uuid := (select id from public.accounts where shop_id = v_shop_id and code = '1000');
  begin
    insert into public.journal_entries (shop_id, period_id, entry_date, description, source, status, created_by)
      values (v_shop_id, public.open_period_for(v_shop_id, date '2026-08-15'), date '2026-08-15',
              'unbalanced', 'manual', 'posted', v_owner_id)
      returning id into v_bad;
    insert into public.journal_lines (entry_id, account_id, amount_cents) values (v_bad, v_cash, 100);
    set constraints journal_entry_balances immediate;
  exception
    when others then v_raised := true;
  end;
  if not v_raised then
    raise exception 'FAIL: an unbalanced entry was accepted';
  end if;
  set constraints all deferred;

  -- 12. A zero line is refused. Two zero lines would sum to zero and pass the
  -- balance check while recording nothing.
  begin
    insert into public.journal_lines (entry_id, account_id, amount_cents)
      values ((select id from public.journal_entries where shop_id = v_shop_id and description = 'balanced'),
              (select id from public.accounts where shop_id = v_shop_id and code = '1000'), 0);
    raise exception 'FAIL: a zero-amount line was accepted';
  exception
    when check_violation then null;
  end;

  -- 13. A posted entry cannot be edited. Correction is a reversing entry; an
  -- UPDATE would rewrite history and leave no trace that it had been rewritten.
  begin
    update public.journal_entries set description = 'edited'
      where shop_id = v_shop_id and description = 'balanced';
    raise exception 'FAIL: a posted entry was edited';
  exception
    when sqlstate 'P0001' then
      if position('immutable' in sqlerrm) = 0 then raise; end if;
  end;
```

- [ ] **Step 2: Run it and verify it fails**

Run: `npm run test:db -- --no-reset`
Expected: FAIL with `relation "public.journal_entries" does not exist`.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/20260904000300_journal.sql`:

```sql
-- The ledger itself.
--
-- ## One signed amount, not a debit column and a credit column
--
-- Every accounting textbook draws two columns, and the Trial Balance screen
-- will draw two columns. The TABLE stores one signed integer, debit positive,
-- because the property that has to be enforced is "these lines sum to zero"
-- and with two columns that is sum(debit) = sum(credit) plus a second rule
-- that no row may fill both. One column makes the first trivial and the second
-- impossible to violate. The two columns are a projection:
--
--   debit  = greatest(amount_cents, 0)
--   credit = greatest(-amount_cents, 0)
--
-- Debit positive rather than credit positive so an account's balance is
-- sum(amount_cents) and reads the way its type expects: assets and expenses
-- carry debit balances, so they come out positive.
--
-- ## Why the balance check is a DEFERRED constraint trigger
--
-- It cannot be a CHECK -- a CHECK sees one row and the property is about a set.
-- It cannot be a plain AFTER trigger either, because the first line of a
-- two-line entry is always unbalanced; a non-deferred trigger would refuse
-- every entry ever written. Deferring to commit is what makes the intermediate
-- state legal and the final state judged.
--
-- Putting it here rather than only inside post_journal_entry() is the point.
-- The RPC checks too, because a clear error beats a constraint violation. But
-- the RPC is code and code has bugs, and "the books balance" is the one
-- property that must survive a bug in the thing that writes them.

create table public.journal_entries (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  period_id uuid not null references public.accounting_periods(id),
  -- The date the entry BELONGS to, which is not created_at. A bill entered on
  -- 3 September for August utilities is dated in August; that is what accrual
  -- means and what the period gate is measured against.
  entry_date date not null,
  -- Human-facing, unique per shop, generated by post_journal_entry. Null while
  -- a draft, because a reference nobody can see yet is a number burned for
  -- nothing.
  reference text,
  description text not null check (length(trim(description)) > 0),
  -- Which door wrote it. Only 'manual' and 'opening' are reachable in this
  -- phase; the rest are listed now so the posting phases add no enum values to
  -- a table that by then has rows.
  source text not null default 'manual' check (source in (
    'manual','sale','refund','settlement','bill','payment','payroll',
    'stock','count','transfer','asset','depreciation','close','opening'
  )),
  status text not null default 'draft' check (status in ('draft','posted','reversed')),
  -- Optional dimension. A shop with one store leaves it null; a shop with three
  -- gets a P&L per branch without a second set of accounts.
  location_id uuid references public.shop_locations(id),
  -- Set on the ORIGINAL when it is reversed, and on the reversal pointing back.
  -- Both directions, so neither entry can be read without finding the other.
  reverses_entry_id uuid references public.journal_entries(id),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  unique (shop_id, reference)
);
create index journal_entries_shop_date_idx on public.journal_entries(shop_id, entry_date desc, created_at desc);
create index journal_entries_period_idx on public.journal_entries(period_id);

create table public.journal_lines (
  id uuid primary key default gen_random_uuid(),
  entry_id uuid not null references public.journal_entries(id) on delete cascade,
  -- No ON DELETE: an account that has been posted to must not be deletable, and
  -- the reference is what enforces it. Archiving is the supported way out.
  account_id uuid not null references public.accounts(id),
  -- Debit positive, credit negative. Never zero -- a zero line records nothing
  -- and two of them would sum to zero and pass the balance check.
  amount_cents bigint not null check (amount_cents <> 0),
  location_id uuid references public.shop_locations(id),
  memo text
);
create index journal_lines_entry_idx on public.journal_lines(entry_id);
-- Every report groups by account and filters by date, and the date lives on the
-- entry -- so the join is always lines → entries and this is the side that needs
-- the index.
create index journal_lines_account_idx on public.journal_lines(account_id);

-- ── the two rules that cannot be bypassed ──────────────────────────────────

create or replace function public.assert_journal_balances()
returns trigger
language plpgsql set search_path = public as $$
declare
  v_entry uuid := coalesce(new.entry_id, old.entry_id);
  v_sum bigint;
  v_lines integer;
begin
  select coalesce(sum(amount_cents), 0), count(*) into v_sum, v_lines
    from public.journal_lines where entry_id = v_entry;

  -- Zero lines is the legitimate end state of deleting a draft's lines, and of
  -- the cascade when an entry is removed. Only a non-empty entry must balance.
  if v_lines = 0 then return null; end if;

  if v_lines < 2 then
    raise exception 'A journal entry needs at least two lines; this one has %.', v_lines
      using errcode = 'P0001';
  end if;

  if v_sum <> 0 then
    raise exception 'This entry does not balance: debits and credits differ by %.', v_sum
      using errcode = 'P0001';
  end if;

  return null;
end;
$$;

create constraint trigger journal_entry_balances
  after insert or update or delete on public.journal_lines
  deferrable initially deferred
  for each row execute function public.assert_journal_balances();

create or replace function public.refuse_posted_entry_edit()
returns trigger
language plpgsql set search_path = public as $$
begin
  -- The one legal transition on a posted row: reverse_journal_entry marking it
  -- reversed and pointing it at its mirror. Everything else about the row must
  -- be identical, which is what the row comparison below checks -- listing
  -- columns by name would silently stop covering any column added later.
  if old.status = 'posted' and new.status = 'reversed'
     and new.reverses_entry_id is not null
     and (new.id, new.shop_id, new.period_id, new.entry_date, new.reference,
          new.description, new.source, new.location_id, new.created_by, new.created_at)
       = (old.id, old.shop_id, old.period_id, old.entry_date, old.reference,
          old.description, old.source, old.location_id, old.created_by, old.created_at) then
    return new;
  end if;

  if old.status = 'posted' then
    raise exception 'A posted entry is immutable. Reverse it instead of editing it.'
      using errcode = 'P0001';
  end if;

  return new;
end;
$$;

create trigger journal_entries_immutable
  before update on public.journal_entries
  for each row execute function public.refuse_posted_entry_edit();

create or replace function public.refuse_posted_line_change()
returns trigger
language plpgsql set search_path = public as $$
declare
  v_status text;
begin
  select status into v_status from public.journal_entries
    where id = coalesce(new.entry_id, old.entry_id);
  -- Null when the parent entry is already gone: this is the ON DELETE CASCADE
  -- tearing down a draft, not somebody editing a posted one.
  if v_status is not null and v_status <> 'draft' then
    raise exception 'The lines of a posted entry are immutable. Reverse the entry instead.'
      using errcode = 'P0001';
  end if;
  return coalesce(new, old);
end;
$$;

create trigger journal_lines_immutable
  before update or delete on public.journal_lines
  for each row execute function public.refuse_posted_line_change();

-- ── RLS ────────────────────────────────────────────────────────────────────
alter table public.journal_entries enable row level security;
alter table public.journal_lines enable row level security;

create policy "read journal_entries" on public.journal_entries for select
  using (has_shop_permission(shop_id, 'ledger.view'));
create policy "read journal_lines" on public.journal_lines for select
  using (exists (select 1 from public.journal_entries e
                  where e.id = entry_id and has_shop_permission(e.shop_id, 'ledger.view')));

-- No insert/update/delete policy, on purpose and for the same reason
-- stock_receipts, stock_transfers and stock_counts have none: an entry is only
-- ever written through post_journal_entry(), which resolves the period, checks
-- the balance, allocates the reference and writes the audit row in one
-- transaction. A direct insert would be an entry with no reference, possibly
-- in a closed month, that nothing recorded.
grant select on public.journal_entries, public.journal_lines to authenticated;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test:db`
Expected: `verify-ledger  pass`

- [ ] **Step 5: Prove the test can fail**

Mutation: change `if v_sum <> 0 then` to `if false then` in `assert_journal_balances()`. Run `npm run test:db`. Expected: `FAIL: an unbalanced entry was accepted`. Revert.

Second mutation: drop `check (amount_cents <> 0)` from `journal_lines`. Expected: `FAIL: a zero-amount line was accepted`. Revert.

Third mutation: drop the `journal_entries_immutable` trigger. Expected: `FAIL: a posted entry was edited`. Revert.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/20260904000300_journal.sql supabase/tests/verify-ledger.sql
git commit -m "feat(accounting): entries that cannot fail to balance, and cannot be edited once posted"
```

---

### Task 5: The append-only audit log

**Files:**
- Create: `supabase/migrations/20260904000400_accounting_audit_log.sql`
- Modify: `supabase/tests/verify-ledger.sql` (checks 14–15)

**Interfaces:**
- Consumes: `journal_entries` (Task 4), `accounts` (Task 2), `accounting_periods` (Task 3).
- Produces: `public.accounting_audit_log (id, shop_id, actor_id, action, subject_table, subject_id, before, after, created_at)`, written by triggers. Task 6 and 7 rely on it firing without calling it.

- [ ] **Step 1: Write the failing test**

Insert before `raise notice 'ALL CHECKS PASSED';`:

```sql
  -- 14. Posting wrote an audit row by itself. Written by a TRIGGER rather than
  -- by the RPC, so a change made by any route -- the app, a script, direct SQL
  -- -- still lands here.
  if not exists (
    select 1 from public.accounting_audit_log
     where shop_id = v_shop_id and subject_table = 'journal_entries' and action = 'insert'
  ) then
    raise exception 'FAIL: posting an entry wrote no audit row';
  end if;

  -- 15. There is no route by which a row leaves this table.
  --
  -- Asserted against pg_policies rather than by attempting a DELETE, because
  -- this script runs as the postgres superuser and RLS does not apply to it --
  -- a DELETE here would succeed no matter how the policies are written, and the
  -- check would be reporting on nothing. That is the trap this whole file has
  -- to be read for: every RLS assertion in these scripts must be a statement
  -- about the POLICY, not an attempt at the operation.
  if exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'accounting_audit_log'
       and cmd in ('DELETE', 'UPDATE', 'ALL')
  ) then
    raise exception 'FAIL: accounting_audit_log has a policy that can remove or rewrite a row';
  end if;

  -- The same, for the two ledger tables: they are written only through the
  -- RPCs, so a write policy on either would be a second door.
  if exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename in ('journal_entries', 'journal_lines')
       and cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL')
  ) then
    raise exception 'FAIL: a journal table has a write policy; the RPCs are meant to be the only door';
  end if;
```

- [ ] **Step 2: Run it and verify it fails**

Run: `npm run test:db -- --no-reset`
Expected: FAIL with `relation "public.accounting_audit_log" does not exist`.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/20260904000400_accounting_audit_log.sql`:

```sql
-- Who changed what, when, and what it was before.
--
-- ## Why triggers rather than the RPCs
--
-- post_journal_entry could write its own audit row in two lines. It does not,
-- because then only what goes through post_journal_entry is audited -- and the
-- reason to keep a log is precisely the change that did NOT come through the
-- front door. A trigger on the table records the app, a migration, a
-- maintenance script and a psql session alike.
--
-- ## Why there is no delete policy, and no update policy
--
-- Not an oversight and not a default to be tightened later. A log that the
-- shop owner can prune is a log that says whatever its owner wants it to say,
-- which is worse than no log because it looks like evidence. The only way a
-- row leaves this table is the shop being deleted.
--
-- platform_audit_log (20260818000500) is the operator-side equivalent and is
-- deliberately separate: that one records what Anthropic-side operators did to
-- a shop, this one records what the shop did to itself, and merging them would
-- put a support agent's actions and a bookkeeper's in one list where neither
-- audience can read theirs.

create table public.accounting_audit_log (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  -- Null for a change made by a migration or a maintenance script, which is a
  -- true and useful answer -- 'System' is what the reader is shown.
  actor_id uuid references auth.users(id),
  action text not null check (action in ('insert','update','delete')),
  subject_table text not null,
  subject_id uuid not null,
  -- The whole row, both sides. jsonb rather than a column list because this
  -- table outlives the shape of the tables it watches: a column added to
  -- journal_entries next year appears here with no migration.
  before jsonb,
  after jsonb,
  created_at timestamptz not null default now()
);
create index accounting_audit_log_shop_idx on public.accounting_audit_log(shop_id, created_at desc);
create index accounting_audit_log_subject_idx on public.accounting_audit_log(subject_table, subject_id);

create or replace function public.write_accounting_audit()
returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_row jsonb := to_jsonb(coalesce(new, old));
  v_shop uuid;
begin
  -- Every watched table carries shop_id directly except journal_lines, whose
  -- shop is on its entry. TG_ARGV[0] names the lookup rather than branching on
  -- TG_TABLE_NAME, so adding a fourth watched table is a trigger definition and
  -- not an edit to this function.
  if TG_ARGV[0] = 'via_entry' then
    select shop_id into v_shop from public.journal_entries
      where id = (v_row->>'entry_id')::uuid;
  else
    v_shop := (v_row->>'shop_id')::uuid;
  end if;

  -- The parent entry is already gone during a cascade delete. Nothing to
  -- attribute the row to, and the entry's own delete was audited a moment ago.
  if v_shop is null then return coalesce(new, old); end if;

  insert into public.accounting_audit_log (shop_id, actor_id, action, subject_table, subject_id, before, after)
    values (v_shop, auth.uid(), lower(TG_OP), TG_TABLE_NAME,
            (v_row->>'id')::uuid,
            case when TG_OP = 'INSERT' then null else to_jsonb(old) end,
            case when TG_OP = 'DELETE' then null else to_jsonb(new) end);

  return coalesce(new, old);
end;
$$;

create trigger journal_entries_audited
  after insert or update or delete on public.journal_entries
  for each row execute function public.write_accounting_audit('direct');

create trigger journal_lines_audited
  after insert or update or delete on public.journal_lines
  for each row execute function public.write_accounting_audit('via_entry');

create trigger accounts_audited
  after insert or update or delete on public.accounts
  for each row execute function public.write_accounting_audit('direct');

create trigger accounting_periods_audited
  after insert or update or delete on public.accounting_periods
  for each row execute function public.write_accounting_audit('direct');

alter table public.accounting_audit_log enable row level security;

create policy "read accounting_audit_log" on public.accounting_audit_log for select
  using (has_shop_permission(shop_id, 'ledger.view'));

-- Deliberately no insert policy either: rows arrive only from the security
-- definer trigger above, which is not subject to RLS.
grant select on public.accounting_audit_log to authenticated;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test:db`
Expected: `verify-ledger  pass`

- [ ] **Step 5: Prove the test can fail**

Mutation: drop the `journal_entries_audited` trigger. Run `npm run test:db`. Expected: `FAIL: posting an entry wrote no audit row`. Revert.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/20260904000400_accounting_audit_log.sql supabase/tests/verify-ledger.sql
git commit -m "feat(accounting): an audit log the database writes and nobody can prune"
```

---

### Task 6: `post_journal_entry()`

**Files:**
- Create: `supabase/migrations/20260904000500_journal_rpcs.sql`
- Modify: `supabase/tests/verify-ledger.sql` (checks 16–18)

**Interfaces:**
- Consumes: everything above.
- Produces:
  ```
  post_journal_entry(
    p_shop_id uuid, p_entry_date date, p_description text,
    p_lines jsonb,            -- [{"code":"5100","amount_cents":84000,"memo":null,"location_id":null}, ...]
    p_location_id uuid default null,
    p_source text default 'manual'
  ) returns uuid
  ```
  Reference format is `JE-YYYY-NNNN`, allocated per shop per year. Task 7 and `src/lib/ledger.ts` call this.

- [ ] **Step 1: Write the failing test**

Insert before `raise notice 'ALL CHECKS PASSED';`:

```sql
  -- From here on the checks go through the RPCs, which gate on
  -- has_shop_permission -> auth.uid() -> request.jwt.claims->>'sub'. Without
  -- this the owner is nobody and every call below refuses. Setting `role` also
  -- turns RLS on, which is why every raw insert above had to come first.
  perform set_config('request.jwt.claims', json_build_object('sub', v_owner_id)::text, true);
  perform set_config('role', 'authenticated', true);

  -- 16. The happy path: two lines by account CODE, posted, balanced, numbered.
  declare v_posted uuid;
  begin
    v_posted := public.post_journal_entry(
      v_shop_id, date '2026-08-20', 'Write off damaged stock',
      '[{"code":"5100","amount_cents":84000},{"code":"1200","amount_cents":-84000}]'::jsonb
    );
    if (select status from public.journal_entries where id = v_posted) <> 'posted' then
      raise exception 'FAIL: post_journal_entry left the entry unposted';
    end if;
    if (select reference from public.journal_entries where id = v_posted) !~ '^JE-2026-\d{4}$' then
      raise exception 'FAIL: reference is not JE-YYYY-NNNN: %',
        (select reference from public.journal_entries where id = v_posted);
    end if;
    if (select count(*) from public.journal_lines where entry_id = v_posted) <> 2 then
      raise exception 'FAIL: expected two lines';
    end if;
  end;

  -- 17. An unbalanced payload is refused BY THE RPC, with a message a person
  -- can act on -- not by the deferred trigger at commit, whose message is
  -- about the constraint rather than about what they typed.
  begin
    perform public.post_journal_entry(
      v_shop_id, date '2026-08-20', 'Lopsided',
      '[{"code":"5100","amount_cents":84000},{"code":"1200","amount_cents":-1}]'::jsonb
    );
    raise exception 'FAIL: an unbalanced payload was posted';
  exception
    when sqlstate 'P0001' then
      if position('balance' in sqlerrm) = 0 then raise; end if;
  end;

  -- 18. An unknown account code is refused by name. Resolving codes here rather
  -- than making the client send uuids is what lets every future posting site
  -- say '5100' and not hold a lookup.
  begin
    perform public.post_journal_entry(
      v_shop_id, date '2026-08-20', 'Nowhere',
      '[{"code":"9999","amount_cents":1},{"code":"1200","amount_cents":-1}]'::jsonb
    );
    raise exception 'FAIL: an unknown account code was posted';
  exception
    when sqlstate 'P0001' then
      if position('9999' in sqlerrm) = 0 then raise; end if;
  end;
```

- [ ] **Step 2: Run it and verify it fails**

Run: `npm run test:db -- --no-reset`
Expected: FAIL with `function public.post_journal_entry(...) does not exist`.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/20260904000500_journal_rpcs.sql`:

```sql
-- The only two doors into the ledger.
--
-- journal_entries and journal_lines have no write policy, so these are not a
-- convenience over an insert -- they are the whole of how anything is written.
-- Modelled on receive_stock() and save_stock_count() down to the security
-- definer + no-policy posture, for the same reason: several things have to be
-- true together, and a caller that can do half of them can leave the books in
-- a state that no report knows how to describe.
--
-- ## Lines arrive as account CODES, not ids
--
-- Every future posting site -- complete_sale, receive_stock, the depreciation
-- run -- knows it wants "5100" and does not want to carry a per-shop lookup to
-- turn that into a uuid. Resolving here means one place gets it wrong at most,
-- and an unknown code is refused by the code the caller actually typed.

create or replace function public.post_journal_entry(
  p_shop_id uuid,
  p_entry_date date,
  p_description text,
  p_lines jsonb,
  p_location_id uuid default null,
  p_source text default 'manual'
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_entry uuid;
  v_period uuid;
  v_sum bigint;
  v_count integer;
  v_missing text;
  v_ref text;
  v_year text := to_char(p_entry_date, 'YYYY');
begin
  -- Manual entries need ledger.post. A posting phase's RPC will call this with
  -- p_source <> 'manual' from inside its own security definer function, where
  -- the caller has already been gated on the permission that door needs -- a
  -- cashier completing a sale holds pos.access and must not need ledger.post.
  if p_source = 'manual' and not has_shop_permission(p_shop_id, 'ledger.post') then
    raise exception 'You do not have permission to post journal entries.'
      using errcode = 'P0001';
  end if;

  if p_description is null or length(trim(p_description)) = 0 then
    raise exception 'A journal entry needs a description.' using errcode = 'P0001';
  end if;

  select count(*), coalesce(sum((l->>'amount_cents')::bigint), 0)
    into v_count, v_sum
    from jsonb_array_elements(p_lines) l;

  if v_count < 2 then
    raise exception 'A journal entry needs at least two lines; this one has %.', v_count
      using errcode = 'P0001';
  end if;

  -- Checked here as well as by the deferred trigger, and both are wanted. This
  -- one produces a message naming the difference, which is what the person
  -- typing the entry needs. The trigger produces the guarantee.
  if v_sum <> 0 then
    raise exception 'This entry does not balance: debits and credits differ by %.', v_sum
      using errcode = 'P0001';
  end if;

  select string_agg(distinct l->>'code', ', ') into v_missing
    from jsonb_array_elements(p_lines) l
   where not exists (
     select 1 from public.accounts a
      where a.shop_id = p_shop_id and a.code = l->>'code' and a.archived_at is null
   );
  if v_missing is not null then
    raise exception 'No such account: %. Check the chart of accounts.', v_missing
      using errcode = 'P0001';
  end if;

  -- Raises if the month is closed or locked, and opens it if it is the first
  -- entry of that month.
  v_period := public.open_period_for(p_shop_id, p_entry_date);

  -- Per shop per year, gapless enough to read. Taken under the lock the insert
  -- itself holds via the unique (shop_id, reference) index: two concurrent
  -- posts race, the loser violates the unique and retries at the application
  -- layer. A sequence would be gap-free but shared across shops, which would
  -- leak how many entries other shops post.
  select 'JE-' || v_year || '-' || lpad((count(*) + 1)::text, 4, '0')
    into v_ref
    from public.journal_entries
   where shop_id = p_shop_id and to_char(entry_date, 'YYYY') = v_year;

  insert into public.journal_entries
      (shop_id, period_id, entry_date, reference, description, source, status, location_id, created_by)
    values (p_shop_id, v_period, p_entry_date, v_ref, trim(p_description), p_source, 'posted',
            p_location_id, auth.uid())
    returning id into v_entry;

  insert into public.journal_lines (entry_id, account_id, amount_cents, location_id, memo)
    select v_entry,
           (select a.id from public.accounts a where a.shop_id = p_shop_id and a.code = l->>'code'),
           (l->>'amount_cents')::bigint,
           coalesce((l->>'location_id')::uuid, p_location_id),
           l->>'memo'
      from jsonb_array_elements(p_lines) l;

  return v_entry;
end;
$$;

grant execute on function public.post_journal_entry(uuid, date, text, jsonb, uuid, text) to authenticated;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test:db`
Expected: `verify-ledger  pass`

- [ ] **Step 5: Prove the test can fail**

Mutation: change `if v_sum <> 0 then` in `post_journal_entry` to `if false then`. Run `npm run test:db`. Expected: `FAIL: an unbalanced payload was posted` (the deferred trigger fires at commit with a different message, so the check catching `'balance'` still needs the RPC's own guard). Revert.

Second mutation: delete the `v_missing` block. Expected: `FAIL: an unknown account code was posted`. Revert.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/20260904000500_journal_rpcs.sql supabase/tests/verify-ledger.sql
git commit -m "feat(accounting): one door into the ledger, and it checks before it opens"
```

---

### Task 7: `reverse_journal_entry()`

**Files:**
- Modify: `supabase/migrations/20260904000500_journal_rpcs.sql` (append)
- Modify: `supabase/tests/verify-ledger.sql` (checks 19–21)

**Interfaces:**
- Consumes: `post_journal_entry` (Task 6).
- Produces: `reverse_journal_entry(p_entry_id uuid, p_reason text) returns uuid` — returns the id of the new mirror entry.

- [ ] **Step 1: Write the failing test**

Insert before `raise notice 'ALL CHECKS PASSED';`:

```sql
  -- 19-21. Reversal: the mirror exists, both rows point at each other, and the
  -- pair nets to nothing.
  declare
    v_orig uuid;
    v_rev  uuid;
  begin
    v_orig := public.post_journal_entry(
      v_shop_id, date '2026-08-21', 'Mis-coded bill',
      '[{"code":"6400","amount_cents":9500},{"code":"2000","amount_cents":-9500}]'::jsonb
    );
    v_rev := public.reverse_journal_entry(v_orig, 'wrong expense account');

    if (select status from public.journal_entries where id = v_orig) <> 'reversed' then
      raise exception 'FAIL: the original was not marked reversed';
    end if;
    if (select reverses_entry_id from public.journal_entries where id = v_rev) <> v_orig then
      raise exception 'FAIL: the reversal does not point at its original';
    end if;
    if (select reverses_entry_id from public.journal_entries where id = v_orig) <> v_rev then
      raise exception 'FAIL: the original does not point at its reversal';
    end if;

    if (select coalesce(sum(amount_cents), 0) from public.journal_lines
         where entry_id in (v_orig, v_rev)) <> 0 then
      raise exception 'FAIL: the reversed pair does not net to zero';
    end if;

    -- Reversing twice would create a second mirror and double the correction.
    begin
      perform public.reverse_journal_entry(v_orig, 'again');
      raise exception 'FAIL: an already-reversed entry was reversed again';
    exception
      when sqlstate 'P0001' then
        if position('already' in sqlerrm) = 0 then raise; end if;
    end;
  end;
```

- [ ] **Step 2: Run it and verify it fails**

Run: `npm run test:db -- --no-reset`
Expected: FAIL with `function public.reverse_journal_entry(uuid, text) does not exist`.

- [ ] **Step 3: Append the function**

Append to `supabase/migrations/20260904000500_journal_rpcs.sql`:

```sql
-- Correcting a posted entry, which is never an edit.
--
-- Writes a second entry whose lines are the first's, negated, and links the two
-- in both directions. Both stay on the record: the mistake and the correction.
-- That is the difference between a book and a document -- a document is
-- amended, a book is added to.
--
-- The reversal is dated to the ORIGINAL's date, not today. A correction to
-- August belongs in August; dating it to September would leave August
-- overstated and September understated, and every monthly comparison after that
-- would be wrong in two directions at once. If August is closed, the reversal
-- is refused by open_period_for and the caller must re-open it -- which is the
-- correct thing to make somebody decide, and is why 'closed' is reversible.
create or replace function public.reverse_journal_entry(
  p_entry_id uuid,
  p_reason text
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_shop uuid;
  v_status text;
  v_date date;
  v_ref text;
  v_loc uuid;
  v_new uuid;
begin
  select shop_id, status, entry_date, reference, location_id
    into v_shop, v_status, v_date, v_ref, v_loc
    from public.journal_entries where id = p_entry_id;

  if v_shop is null then
    raise exception 'No such journal entry.' using errcode = 'P0001';
  end if;
  if not has_shop_permission(v_shop, 'ledger.post') then
    raise exception 'You do not have permission to reverse journal entries.'
      using errcode = 'P0001';
  end if;
  if v_status = 'reversed' then
    raise exception 'That entry has already been reversed.' using errcode = 'P0001';
  end if;
  if v_status <> 'posted' then
    raise exception 'Only a posted entry can be reversed; this one is %.', v_status
      using errcode = 'P0001';
  end if;
  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'Say why this entry is being reversed.' using errcode = 'P0001';
  end if;

  -- Built by hand rather than through post_journal_entry: the reference has to
  -- be the original's with an R, so the pair reads as a pair in the journals
  -- list, and post_journal_entry allocates a fresh JE- number.
  insert into public.journal_entries
      (shop_id, period_id, entry_date, reference, description, source, status,
       location_id, reverses_entry_id, created_by)
    values (v_shop, public.open_period_for(v_shop, v_date), v_date, v_ref || 'R',
            'Reversal of ' || v_ref || ' — ' || trim(p_reason),
            'manual', 'posted', v_loc, p_entry_id, auth.uid())
    returning id into v_new;

  insert into public.journal_lines (entry_id, account_id, amount_cents, location_id, memo)
    select v_new, account_id, -amount_cents, location_id, memo
      from public.journal_lines where entry_id = p_entry_id;

  -- The one update refuse_posted_entry_edit() permits.
  update public.journal_entries
     set status = 'reversed', reverses_entry_id = v_new
   where id = p_entry_id;

  return v_new;
end;
$$;

grant execute on function public.reverse_journal_entry(uuid, text) to authenticated;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test:db`
Expected: `verify-ledger  pass`

- [ ] **Step 5: Prove the test can fail**

Mutation: change `-amount_cents` to `amount_cents` in the lines insert. Run `npm run test:db`. Expected: `FAIL: the reversed pair does not net to zero`. Revert.

Second mutation: delete the `if v_status = 'reversed'` block. Expected: `FAIL: an already-reversed entry was reversed again`. Revert.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/20260904000500_journal_rpcs.sql supabase/tests/verify-ledger.sql
git commit -m "feat(accounting): corrections are reversing entries, and say why"
```

---

### Task 8: The pure arithmetic — `ledger-math.ts`

**Files:**
- Create: `src/lib/ledger-math.ts`
- Create: `src/lib/__tests__/ledger-math.test.ts`
- Modify: `src/types/models.ts`

**Interfaces:**
- Consumes: nothing at runtime — this module imports no Supabase client, deliberately.
- Produces: `AccountType`, `Account`, `JournalEntry`, `JournalLine` from `src/types/models.ts`, and from `src/lib/ledger-math.ts`:
  ```ts
  export type PostedLine = { accountId: string; amountCents: number };
  export type TrialBalanceRow = { accountId: string; code: string; name: string; type: AccountType; debitCents: number; creditCents: number };
  export function debitOf(amountCents: number): number;
  export function creditOf(amountCents: number): number;
  export function entryDifferenceCents(lines: { amountCents: number }[]): number;
  export function isBalanced(lines: { amountCents: number }[]): boolean;
  export function trialBalance(accounts: Account[], lines: PostedLine[]): TrialBalanceRow[];
  ```
  Task 9's `ledger.ts` and the phase-1b screens consume these.

- [ ] **Step 1: Add the types**

In `src/types/models.ts`, append:

```ts
export type AccountType = 'asset' | 'liability' | 'equity' | 'revenue' | 'cost_of_sales' | 'expense';

export type Account = {
  id: string;
  shopId: string;
  code: string;
  name: string;
  type: AccountType;
  isContra: boolean;
  archivedAt: string | null;
};

export type JournalEntryStatus = 'draft' | 'posted' | 'reversed';

export type JournalEntry = {
  id: string;
  shopId: string;
  entryDate: string;
  reference: string | null;
  description: string;
  source: string;
  status: JournalEntryStatus;
  locationId: string | null;
  reversesEntryId: string | null;
  createdAt: string;
  lines: JournalLine[];
};

// amountCents is SIGNED: debit positive, credit negative. The two columns a
// reader expects are a projection of this one number -- see debitOf/creditOf in
// src/lib/ledger-math.ts. Never add a separate debit and credit field; a shape
// that can hold both is a shape that will eventually hold both.
export type JournalLine = {
  id: string;
  accountId: string;
  amountCents: number;
  locationId: string | null;
  memo: string | null;
};
```

- [ ] **Step 2: Write the failing test**

Create `src/lib/__tests__/ledger-math.test.ts`:

```ts
import { creditOf, debitOf, entryDifferenceCents, isBalanced, trialBalance } from '@/lib/ledger-math';
import type { Account } from '@/types/models';

const account = (code: string, type: Account['type'], id = code): Account => ({
  id,
  shopId: 'shop',
  code,
  name: code,
  type,
  isContra: false,
  archivedAt: null,
});

describe('debitOf / creditOf', () => {
  it('splits one signed amount into the two columns a reader expects', () => {
    expect(debitOf(84000)).toBe(84000);
    expect(creditOf(84000)).toBe(0);
    expect(debitOf(-84000)).toBe(0);
    expect(creditOf(-84000)).toBe(84000);
  });

  it('never reports the same amount in both columns', () => {
    for (const n of [-1, 1, -99999, 99999]) {
      expect(Math.min(debitOf(n), creditOf(n))).toBe(0);
    }
  });
});

describe('entryDifferenceCents', () => {
  it('is zero for a balanced entry', () => {
    expect(entryDifferenceCents([{ amountCents: 84000 }, { amountCents: -84000 }])).toBe(0);
    expect(isBalanced([{ amountCents: 84000 }, { amountCents: -84000 }])).toBe(true);
  });

  it('reports the signed gap so the UI can say which side is short', () => {
    expect(entryDifferenceCents([{ amountCents: 84000 }, { amountCents: -1 }])).toBe(83999);
    expect(entryDifferenceCents([{ amountCents: 1 }, { amountCents: -84000 }])).toBe(-83999);
    expect(isBalanced([{ amountCents: 84000 }, { amountCents: -1 }])).toBe(false);
  });

  it('treats a single line as unbalanced even when it sums to zero', () => {
    // An entry of one zero line sums to zero and is still not an entry.
    expect(isBalanced([{ amountCents: 0 }])).toBe(false);
    expect(isBalanced([])).toBe(false);
  });
});

describe('trialBalance', () => {
  const accounts = [account('1000', 'asset'), account('4000', 'revenue'), account('6000', 'expense')];

  it('puts each account on the side its balance falls', () => {
    const rows = trialBalance(accounts, [
      { accountId: '1000', amountCents: 500000 },
      { accountId: '4000', amountCents: -800000 },
      { accountId: '6000', amountCents: 300000 },
    ]);
    expect(rows.find((r) => r.code === '1000')).toMatchObject({ debitCents: 500000, creditCents: 0 });
    expect(rows.find((r) => r.code === '4000')).toMatchObject({ debitCents: 0, creditCents: 800000 });
    expect(rows.find((r) => r.code === '6000')).toMatchObject({ debitCents: 300000, creditCents: 0 });
  });

  it('nets multiple lines against one account before choosing a side', () => {
    const rows = trialBalance(accounts, [
      { accountId: '1000', amountCents: 500000 },
      { accountId: '1000', amountCents: -600000 },
    ]);
    // Overdrawn: an asset with a credit balance is a real thing and must not be
    // reported as a 100000 debit.
    expect(rows.find((r) => r.code === '1000')).toMatchObject({ debitCents: 0, creditCents: 100000 });
  });

  it('omits accounts with no movement, so the statement is readable', () => {
    const rows = trialBalance(accounts, [{ accountId: '1000', amountCents: 1 }, { accountId: '4000', amountCents: -1 }]);
    expect(rows.map((r) => r.code)).toEqual(['1000', '4000']);
  });

  it('sorts by code, because that is the order every accountant reads', () => {
    const rows = trialBalance(accounts, [
      { accountId: '6000', amountCents: 1 },
      { accountId: '1000', amountCents: 1 },
      { accountId: '4000', amountCents: -2 },
    ]);
    expect(rows.map((r) => r.code)).toEqual(['1000', '4000', '6000']);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx jest src/lib/__tests__/ledger-math.test.ts`
Expected: FAIL with `Cannot find module '@/lib/ledger-math'`.

- [ ] **Step 4: Write the implementation**

Create `src/lib/ledger-math.ts`:

```ts
import type { Account } from '@/types/models';

// The arithmetic of the ledger, as pure functions over already-fetched rows.
//
// Deliberately separate from `ledger.ts`, for the reason `expense-reporting.ts`
// gives for sitting apart from `expenses.ts`: that module imports the Supabase
// client, which pulls in AsyncStorage and cannot load outside a native runtime,
// so anything importing it is untestable under Jest. The numbers that decide
// whether the books balance are exactly the numbers that must be testable with
// no mocking at all.

// A journal line stores ONE signed amount, debit positive. These two are the
// projection into the pair of columns a statement shows. See the note on
// JournalLine in src/types/models.ts for why the storage is not two fields.
export function debitOf(amountCents: number): number {
  return amountCents > 0 ? amountCents : 0;
}

export function creditOf(amountCents: number): number {
  return amountCents < 0 ? -amountCents : 0;
}

// Signed on purpose: the sign tells the UI which side is short, which is the
// difference between "you are 839.99 out" and "add 839.99 to the credit side".
export function entryDifferenceCents(lines: { amountCents: number }[]): number {
  return lines.reduce((sum, line) => sum + line.amountCents, 0);
}

// Two lines is part of the definition, not a nicety. One line summing to zero
// is a zero line, which records nothing -- and the database refuses both, so a
// UI that called a single line balanced would offer a Post button that fails.
export function isBalanced(lines: { amountCents: number }[]): boolean {
  return lines.length >= 2 && entryDifferenceCents(lines) === 0;
}

export type PostedLine = { accountId: string; amountCents: number };

export type TrialBalanceRow = {
  accountId: string;
  code: string;
  name: string;
  type: Account['type'];
  debitCents: number;
  creditCents: number;
};

// Net first, then choose a side. Doing it the other way round -- summing debits
// and credits separately per account -- would report an overdrawn bank account
// as both a large debit and a slightly larger credit, and the reader would have
// to subtract to find out it was overdrawn at all.
export function trialBalance(accounts: Account[], lines: PostedLine[]): TrialBalanceRow[] {
  const balances = new Map<string, number>();
  for (const line of lines) {
    balances.set(line.accountId, (balances.get(line.accountId) ?? 0) + line.amountCents);
  }

  return accounts
    .filter((a) => (balances.get(a.id) ?? 0) !== 0)
    .map((a) => {
      const balance = balances.get(a.id) ?? 0;
      return {
        accountId: a.id,
        code: a.code,
        name: a.name,
        type: a.type,
        debitCents: debitOf(balance),
        creditCents: creditOf(balance),
      };
    })
    .sort((a, b) => a.code.localeCompare(b.code));
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx jest src/lib/__tests__/ledger-math.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 6: Prove the tests can fail**

Mutation: in `isBalanced`, change `lines.length >= 2` to `lines.length >= 1`. Run the suite. Expected: `treats a single line as unbalanced even when it sums to zero` fails. Revert.

Second mutation: in `trialBalance`, move the `.filter` after the `.map` and filter on `debitCents !== 0` only. Expected: `omits accounts with no movement` still passes but `nets multiple lines against one account` is unaffected — so instead change the reducer to `Math.abs(line.amountCents)`. Expected: `nets multiple lines against one account before choosing a side` fails. Revert.

- [ ] **Step 7: Verify everything and commit**

Run: `npx tsc --noEmit && npm test && npm run lint`
Expected: exit 0; **136 suites, 2095 tests**; 76 lint problems.

```bash
git add src/lib/ledger-math.ts src/lib/__tests__/ledger-math.test.ts src/types/models.ts
git commit -m "feat(accounting): the ledger's arithmetic, testable without a database"
```

---

### Task 9: The client — `ledger.ts`

**Files:**
- Create: `src/lib/ledger.ts`

**Interfaces:**
- Consumes: `ledger-math.ts` types (Task 8), the RPCs (Tasks 6–7).
- Produces:
  ```ts
  export async function listAccounts(shopId: string): Promise<Account[]>;
  export async function listJournalEntries(shopId: string, from: string, to: string): Promise<JournalEntry[]>;
  export async function listPostedLines(shopId: string, asOf: string): Promise<PostedLine[]>;
  export async function postJournalEntry(input: PostEntryInput): Promise<string>;
  export async function reverseJournalEntry(entryId: string, reason: string): Promise<string>;
  ```
  Phase 1b's screens consume exactly these and nothing else.

- [ ] **Step 1: Read the house pattern before writing**

Read `src/lib/expenses.ts` in full. Match its shape exactly: the `supabase` import, row-to-model mapping in a local `map*` function, `if (error) throw error`, and camelCase models over snake_case rows. Do not invent a different error convention.

- [ ] **Step 2: Write the module**

Create `src/lib/ledger.ts`:

```ts
import { supabase } from '@/lib/supabase';
import type { Account, JournalEntry, JournalLine } from '@/types/models';
import type { PostedLine } from '@/lib/ledger-math';

// The Supabase-facing half of the ledger. Every number this returns is computed
// by the database; nothing here decides anything. The arithmetic lives in
// ledger-math.ts so it can be tested without a runtime.

type AccountRow = {
  id: string; shop_id: string; code: string; name: string;
  type: Account['type']; is_contra: boolean; archived_at: string | null;
};

function mapAccount(row: AccountRow): Account {
  return {
    id: row.id,
    shopId: row.shop_id,
    code: row.code,
    name: row.name,
    type: row.type,
    isContra: row.is_contra,
    archivedAt: row.archived_at,
  };
}

// Archived accounts are included. A statement covering a period in which an
// account was still live must still be able to name it, and the caller filters
// for pickers -- which is a different question from "what happened".
export async function listAccounts(shopId: string): Promise<Account[]> {
  const { data, error } = await supabase
    .from('accounts')
    .select('id, shop_id, code, name, type, is_contra, archived_at')
    .eq('shop_id', shopId)
    .order('code');
  if (error) throw error;
  return (data ?? []).map(mapAccount);
}

type LineRow = {
  id: string; account_id: string; amount_cents: number;
  location_id: string | null; memo: string | null;
};

function mapLine(row: LineRow): JournalLine {
  return {
    id: row.id,
    accountId: row.account_id,
    amountCents: row.amount_cents,
    locationId: row.location_id,
    memo: row.memo,
  };
}

export async function listJournalEntries(shopId: string, from: string, to: string): Promise<JournalEntry[]> {
  const { data, error } = await supabase
    .from('journal_entries')
    .select(
      'id, shop_id, entry_date, reference, description, source, status, location_id, reverses_entry_id, created_at,' +
      'journal_lines (id, account_id, amount_cents, location_id, memo)'
    )
    .eq('shop_id', shopId)
    .gte('entry_date', from)
    .lte('entry_date', to)
    .order('entry_date', { ascending: false })
    .order('created_at', { ascending: false });
  if (error) throw error;

  return (data ?? []).map((row) => ({
    id: row.id,
    shopId: row.shop_id,
    entryDate: row.entry_date,
    reference: row.reference,
    description: row.description,
    source: row.source,
    status: row.status,
    locationId: row.location_id,
    reversesEntryId: row.reverses_entry_id,
    createdAt: row.created_at,
    lines: ((row.journal_lines ?? []) as LineRow[]).map(mapLine),
  }));
}

// Every posted line up to a date, for the trial balance. Reversals are included
// deliberately: a reversed entry and its mirror both stay on the books and net
// to nothing, so excluding either would unbalance the statement. Drafts are
// excluded because they have not reached the books.
export async function listPostedLines(shopId: string, asOf: string): Promise<PostedLine[]> {
  const { data, error } = await supabase
    .from('journal_lines')
    .select('account_id, amount_cents, journal_entries!inner (shop_id, entry_date, status)')
    .eq('journal_entries.shop_id', shopId)
    .lte('journal_entries.entry_date', asOf)
    .in('journal_entries.status', ['posted', 'reversed']);
  if (error) throw error;
  return (data ?? []).map((row) => ({
    accountId: row.account_id,
    amountCents: row.amount_cents,
  }));
}

export type PostEntryInput = {
  shopId: string;
  entryDate: string;
  description: string;
  // amountCents is signed: debit positive, credit negative.
  lines: { code: string; amountCents: number; memo?: string | null; locationId?: string | null }[];
  locationId?: string | null;
};

export async function postJournalEntry(input: PostEntryInput): Promise<string> {
  const { data, error } = await supabase.rpc('post_journal_entry', {
    p_shop_id: input.shopId,
    p_entry_date: input.entryDate,
    p_description: input.description,
    p_lines: input.lines.map((line) => ({
      code: line.code,
      amount_cents: line.amountCents,
      memo: line.memo ?? null,
      location_id: line.locationId ?? null,
    })),
    p_location_id: input.locationId ?? null,
  });
  if (error) throw error;
  return data as string;
}

export async function reverseJournalEntry(entryId: string, reason: string): Promise<string> {
  const { data, error } = await supabase.rpc('reverse_journal_entry', {
    p_entry_id: entryId,
    p_reason: reason,
  });
  if (error) throw error;
  return data as string;
}
```

- [ ] **Step 3: Verify it compiles and nothing regressed**

Run: `npx tsc --noEmit && npm test && npm run lint`
Expected: exit 0; 136 suites / 2095 tests; 76 lint problems.

There is no Jest test for this file, on purpose: it contains no decisions, and a test of it would assert that the Supabase mock was called with the arguments it was called with. Everything it returns is checked either by `verify-ledger.sql` (the database's behaviour) or by `ledger-math.test.ts` (the arithmetic).

- [ ] **Step 4: Run the whole database suite one last time**

Run: `npm run test:db`
Expected: every script passes, `verify-ledger` among them.

- [ ] **Step 5: Commit**

```bash
git add src/lib/ledger.ts
git commit -m "feat(accounting): the client half of the ledger"
```

---

## What phase 1b picks up

The screens, against exactly the interfaces above: Chart of Accounts, General Journal Entry, Journals List, Trial Balance and Audit Log — five destinations of the Accounting hub drawn in [`docs/design/accounting-standards-mockup.html`](../../design/accounting-standards-mockup.html). They need no further database work.

Phase 2a is cost layers. It is a separate plan and a separate spec, and it must land before any existing RPC gains a posting side — see the sequencing note in the design.
