# People Section Restructure: Customers + Team (HR) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restructure the admin app's "Customers" tab into a **People** section with two sub-tabs — **Customers** and **Team (HR)** — sharing a two-pane list+detail layout (search/filter list on the left, rich detail pane on the right). Team gains real HR data it has zero of today: hire date, pay type/rate, shift clock-in/out, and time-off requests — plus a brand-new employee self-service tab (`/me`) reachable by *any* active staff member regardless of their operational permissions.

**Architecture:** `customers.tsx` is renamed to `people.tsx` and hosts a `SegmentedControl<'customers'|'team'>` over a shared two-pane list+detail shell. Team's roster management migrates out of Settings → "Staff and roles" (`StaffPanel`) into the new Team sub-tab; Settings keeps only Roles management (permission-set editing), relabeled. Three new HR tables (`time_entries`, `time_off_requests`, plus new columns on `shop_members`) back the Team tab's payroll/shifts sections and the new self-service `/me` screen. Three new `Permission` catalog entries (`people.timeoff.approve`, `people.payroll.manage`, `people.timesheet.view`) gate the manager-side HR features; `/me` itself is deliberately left **out** of the route-permission map (same mechanism `/marketplace-coming-soon` already uses) so it's reachable by active membership alone, not an operational permission. Full spec/mockup: see the Context section below and the published design mockup referenced in conversation (a two-frame web+mobile HTML preview — not checked into the repo).

**Tech Stack:** Expo Router v57, React Native, TypeScript, Supabase (Postgres + RLS), no component-level test suite in this repo (Jest covers pure-logic files only — `src/lib/__tests__/*.test.ts`).

## Context

The current "Customers" tab (`src/app/(admin)/(tabs)/customers.tsx`) is a single-pane sortable table with an overlay modal (`CustomerModal`) for add/edit. The target design reframes this as a **People** section with two sub-tabs, Customers and Team (HR), both using a two-pane list+detail layout: a searchable/filterable list on the left, a rich detail pane (stat tiles, notes/history, actions) on the right.

Today "Team" doesn't exist as a People-adjacent concept — staff roster management lives buried in Settings → "Staff and roles" (`StaffPanel`, `src/components/settings/panels/staff-panel.tsx`), with **zero** HR functionality: no hire date, pay info, shift tracking, time-off requests, or self-service for employees. This plan builds the full HR module in one pass (not phased), including real employee self-service (clock in/out, request time off, view own pay/hire-date/role), which is impossible today: staff and owners share one route tree gated purely by operational permissions (a Cashier with only `pos.access` can reach *only* `/pos`), and `useAuth()` doesn't expose a staff member's own roster record at all.

**Correction found during planning**: `src/app/(admin)/account.tsx` is dead code — still on disk and registered as a `Stack.Screen` in `(admin)/_layout.tsx`, but unreachable (confirmed via grep: nothing links to `/account`; `StaffPanel`'s own top comment says it was "ported from the previous `app/(admin)/account.tsx` (now unreached...)"). This plan deletes it.

## Global Constraints

- Read `AGENTS.md` at the repo root before touching any Expo API — this project pins to Expo SDK 57 and https://docs.expo.dev/versions/v57.0.0/ is the source of truth. This plan only reuses existing patterns already used identically elsewhere (`SegmentedControl`, `useWindowDimensions()` + `TABLET_BREAKPOINT` split, `NativeTabs.Trigger`, `expo-document-picker`/`xlsx` import flow), so no new Expo API surface is introduced.
- **Scope decisions locked in, do not re-litigate:**
  1. Customers: VIP/Regular/New/At-risk segmentation is derived client-side from the existing free-text `tags: string[]` field (e.g. a `"vip"`/`"at risk"` tag) — no new status column.
  2. Customers: exactly one new column, `customers.notes text` — the design's Notes textarea is worth it.
  3. Customers: **no loyalty points or "owes" balance** — no loyalty/AR subsystem exists and building one is out of scope. The detail pane's stat tiles are Lifetime spend / Orders / Last purchase (existing `getCustomerStats` shape), not a 4-tile row.
  4. Customers: itemized purchase history is a new query against existing `sales`/`sale_items` — no schema change beyond an RLS widening (Task 2).
  5. Team: full HR schema addition — `shop_members.hire_date/pay_type/pay_rate_cents`, new `time_entries` (simple tap-to-clock-in/out — **confirmed: no breaks, no geofencing, no photo verification**), new `time_off_requests` (**single-approval-level workflow** — no multi-level chain). Pay visibility for employees is **rate/type only**, never computed payroll (no rate×hours engine, no pay periods, no payslips).
  6. `staff.manage` **keeps its wire value** (only its label changes, to "Manage team roster") — renaming it would ripple through every stored `roles.permissions` row, RLS policies, and the `provision-staff` edge function for no real benefit.
  7. Self-service HR (`/me`) must be reachable by **any active staff member regardless of operational permissions** — gated on active `shop_members` membership, not on any `Permission`.
  8. Roles management (creating roles, editing their permission sets) **stays in Settings** — it's a distinct admin concern (what a role can do) from Team (who's on the roster and their HR data). Only the roster half of `StaffPanel` moves to the Team tab.
  9. Import/export extends to Team using the exact same generic `ExportMenu`/`CsvImportModal` machinery Customers already uses.
- **Next migration slot**: the latest migration on this branch is `20260802024247_refunds_require_refund_permission.sql` — this plan's migrations use later timestamps in the same `YYYYMMDDHHMMSS_name.sql` format (`20260802030000`, `20260802030100`, `20260802030200`), sequenced after it.
- `CREATE OR REPLACE FUNCTION` in Postgres can only add new parameters appended at the end with a default value, with every existing parameter staying byte-identical — irrelevant to most of this plan's SQL (no existing RPC signatures change), but Task 3's `has_any_shop_permission`-based policies must reproduce the **exact current policy bodies** being replaced (`drop policy` + `create policy`, not `alter policy`), matching this repo's own convention in `0024_permission_gates.sql`.
- This codebase has **no component-level test suite** for UI. Verification per task is `npx tsc --noEmit`, `npx eslint <file>` (where applicable), the existing Jest suite for logic files (`npm test`), and manual verification against the running dev server — never new Jest tests for React Native components.
- Every mutating Supabase call pattern in this codebase ends by re-running a `reload()`/re-fetch in the calling screen — keep that pattern in every new screen (see `customers.tsx`'s `reload()` for the exact shape).
- `TABLET_BREAKPOINT = 820` (`src/constants/layout.ts`) is the one shared responsive threshold — reuse it for `people.tsx`'s two-pane split, exactly like `pos.tsx` already does (`compact = width < TABLET_BREAKPOINT`).
- This project has `experiments.typedRoutes: true` (`app.json`) — route types are generated into `.expo/types/router.d.ts` by the Metro dev server at startup, not by `tsc` itself. Tasks that add new route files (`people.tsx`, `me.tsx`) may show a stale `Href` type error on `router.push`/`<Link href>` calls referencing them until `npx expo start` has run once to regenerate that file — treat that specific error class as not-real until confirmed against a fresh generated-types file.
- Every new/changed Supabase-calling function in this plan follows the existing `src/lib/*.ts` shape exactly: a `mapXRow(row: any): X` function, `{ data, error } = await supabase...`, `if (error) throw error;`, return the mapped value(s) — see `src/lib/customers.ts` and `src/lib/staff.ts` for the pattern being extended.

---

### Task 1: Migration `customers_notes` + `Customer.notes` + `src/lib/customers.ts` notes support

**Files:**
- Create: `supabase/migrations/20260802030000_customers_notes.sql`
- Modify: `src/types/models.ts` (`Customer` type, ~line 112-127)
- Modify: `src/lib/customers.ts` (`mapCustomerRow`, `toRow`)

**Interfaces:**
- Produces: `customers.notes` column, `Customer.notes: string | null`, `toRow()`/`mapCustomerRow()` handling it — consumed by Task 11 (Customer detail pane's Notes field, `CustomerForm`).

- [ ] **Step 1: Create the migration**

```sql
-- People section restructure: the Customers detail pane gets a persistent
-- free-text Notes field (design decision -- see docs/superpowers/plans/
-- 2026-08-02-people-team-hr.md Global Constraints #2). Covered by the
-- existing "read/insert/update/delete customers" policies from
-- 0024_permission_gates.sql -- no new RLS needed, this is just a column.
alter table public.customers add column notes text null;
```

- [ ] **Step 2: Apply the migration**

Run: `supabase db push`
Expected: prompts to confirm, then reports the migration applied. Verify with `supabase migration list` — the row's `remote` column should be populated.

- [ ] **Step 3: Add `notes` to the `Customer` type**

In `src/types/models.ts`, the `Customer` type currently reads:
```ts
export type Customer = {
  id: string;
  shopId: string;
  firstName: string;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  street: string | null;
  city: string | null;
  neighborhood: string | null;
  tags: string[];
  createdAt: string;
  updatedAt: string;
};
```
Add `notes` right after `tags`:
```ts
export type Customer = {
  id: string;
  shopId: string;
  firstName: string;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  street: string | null;
  city: string | null;
  neighborhood: string | null;
  tags: string[];
  notes: string | null;
  createdAt: string;
  updatedAt: string;
};
```

- [ ] **Step 4: Wire `notes` through `src/lib/customers.ts`**

In `mapCustomerRow`, add `notes: row.notes,` right after the `tags:` line:
```ts
function mapCustomerRow(row: any): Customer {
  return {
    id: row.id,
    shopId: row.shop_id,
    firstName: row.first_name,
    lastName: row.last_name,
    email: row.email,
    phone: row.phone,
    street: row.street,
    city: row.city,
    neighborhood: row.neighborhood,
    tags: row.tags ?? [],
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
```
In `toRow`, add a `notes` line right after `tags`:
```ts
function toRow(input: Partial<NewCustomerInput>) {
  return {
    ...(input.firstName !== undefined && { first_name: input.firstName }),
    ...(input.lastName !== undefined && { last_name: input.lastName }),
    ...(input.email !== undefined && { email: input.email }),
    ...(input.phone !== undefined && { phone: input.phone }),
    ...(input.street !== undefined && { street: input.street }),
    ...(input.city !== undefined && { city: input.city }),
    ...(input.neighborhood !== undefined && { neighborhood: input.neighborhood }),
    ...(input.tags !== undefined && { tags: input.tags }),
    ...(input.notes !== undefined && { notes: input.notes }),
  };
}
```
`NewCustomerInput = Omit<Customer, 'id' | 'shopId' | 'createdAt' | 'updatedAt'>` already picks up `notes` automatically since it's derived from `Customer` — no separate change needed there.

- [ ] **Step 5: Type-check**

Run: `npx tsc --noEmit`
Expected: no new errors. (`CustomerForm`/`CustomerModal` don't reference `notes` yet — Task 11 adds that — so nothing downstream breaks from adding an optional-in-practice-but-required-in-type field with `| null`, since every existing `NewCustomerInput` literal in the codebase is built via `toRow`'s spread, not a literal object requiring every key.)

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/20260802030000_customers_notes.sql src/types/models.ts src/lib/customers.ts
git commit -m "feat: add customers.notes column and thread it through Customer/customers.ts"
```

---

### Task 2: Migration `customer_purchase_history_access` + `CustomerPurchase` type + `listCustomerPurchases`/`getCustomersStatsBatch`

**Files:**
- Create: `supabase/migrations/20260802030100_customer_purchase_history_access.sql`
- Modify: `src/types/models.ts` (new `CustomerPurchase` type)
- Modify: `src/lib/customers.ts` (new `listCustomerPurchases`, `getCustomersStatsBatch`)

**Interfaces:**
- Consumes: `sales`/`sale_items` tables (existing).
- Produces: `CustomerPurchase` type, `listCustomerPurchases(customerId)`, `getCustomersStatsBatch(shopId)` — consumed by Task 11 (purchase history list, batched row-level stats).

- [ ] **Step 1: Create the migration**

The current `read sales`/`read sale_items` policies (from `0024_permission_gates.sql`) only accept `sales.view`/`dashboard.view`. Once People/Customers is its own screen, a role with only `customers.view` (no `sales.view`) is a realistic shape — widen both SELECT policies by one array entry, reproducing their exact current bodies (`drop` + `create`, per this repo's convention) with `customers.view` appended:

```sql
-- People section restructure: a role granting only customers.view (no
-- sales.view) is now a realistic shape -- widen read access to sales/
-- sale_items so getCustomerStats and the new listCustomerPurchases
-- (src/lib/customers.ts) work for it too. Reproduces the exact policy
-- bodies from 0024_permission_gates.sql with 'customers.view' appended.
drop policy "read sales" on public.sales;
create policy "read sales" on public.sales for select
  using (has_any_shop_permission(shop_id, array['sales.view', 'dashboard.view', 'customers.view']));

drop policy "read sale_items" on public.sale_items;
create policy "read sale_items" on public.sale_items for select
  using (exists (
    select 1 from public.sales s where s.id = sale_id
      and has_any_shop_permission(s.shop_id, array['sales.view', 'dashboard.view', 'customers.view'])
  ));
```

- [ ] **Step 2: Apply the migration**

Run: `supabase db push`. Verify with `supabase migration list`.

- [ ] **Step 3: Add `CustomerPurchase` type**

In `src/types/models.ts`, add near `Customer`/`NewCustomerInput`:
```ts
// One line item from a past sale attached to this customer -- powers the
// Customer detail pane's itemized purchase history (src/lib/customers.ts's
// listCustomerPurchases). Distinct from getCustomerStats, which is only
// the 3 aggregate numbers (total/visits/last purchase).
export type CustomerPurchase = {
  saleId: string;
  saleItemId: string;
  productName: string;
  quantity: number;
  unitPriceCents: number;
  lineTotalCents: number;
  paymentMethod: string;
  createdAt: string;
};
```

- [ ] **Step 4: Add `listCustomerPurchases` and `getCustomersStatsBatch` to `src/lib/customers.ts`**

Append to the file, after `getCustomerStats`:
```ts
function mapCustomerPurchaseRow(row: any): CustomerPurchase {
  return {
    saleId: row.sale_id,
    saleItemId: row.id,
    productName: row.product_name,
    quantity: row.quantity,
    unitPriceCents: row.unit_price_cents,
    lineTotalCents: row.line_total_cents,
    paymentMethod: row.sale.payment_method,
    createdAt: row.sale.created_at,
  };
}

// Itemized purchase history for the Customer detail pane. Embeds sales via
// PostgREST's `sale:sales!inner(...)` so the filter on customer_id can reach
// through sale_items -- sorted client-side (newest first) rather than via
// PostgREST's embedded-column order syntax, matching this file's existing
// client-side-reduce style (see getCustomerStats).
export async function listCustomerPurchases(customerId: string): Promise<CustomerPurchase[]> {
  const { data, error } = await supabase
    .from('sale_items')
    .select('id, sale_id, product_name, quantity, unit_price_cents, line_total_cents, sale:sales!inner(customer_id, payment_method, created_at)')
    .eq('sale.customer_id', customerId);
  if (error) throw error;
  return (data ?? [])
    .map(mapCustomerPurchaseRow)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

// Batched row-level stats for the Customers list (avoids one getCustomerStats
// query per row -- see Task 11). One query over every sale in the shop,
// reduced client-side into a per-customer map, same reduction shape as
// getCustomerStats itself.
export async function getCustomersStatsBatch(shopId: string): Promise<Map<string, { totalSpentCents: number; visitCount: number }>> {
  const { data, error } = await supabase.from('sales').select('customer_id, total_cents').eq('shop_id', shopId).not('customer_id', 'is', null);
  if (error) throw error;
  const stats = new Map<string, { totalSpentCents: number; visitCount: number }>();
  for (const row of data ?? []) {
    const id = row.customer_id as string;
    const current = stats.get(id) ?? { totalSpentCents: 0, visitCount: 0 };
    stats.set(id, { totalSpentCents: current.totalSpentCents + row.total_cents, visitCount: current.visitCount + 1 });
  }
  return stats;
}
```
Add `CustomerPurchase` to the existing `import type { Customer, NewCustomerInput } from '@/types/models';` line at the top of the file.

- [ ] **Step 5: Type-check**

Run: `npx tsc --noEmit`. Expected: no new errors.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/20260802030100_customer_purchase_history_access.sql src/types/models.ts src/lib/customers.ts
git commit -m "feat: widen sales/sale_items read access to customers.view, add purchase history + batched stats"
```

---

### Task 3: Migration `hr_schema` — `shop_members` HR columns, `time_entries`, `time_off_requests`

**Files:**
- Create: `supabase/migrations/20260802030200_hr_schema.sql`

**Interfaces:**
- Produces: `shop_members.hire_date/pay_type/pay_rate_cents`, `time_entries` table, `time_off_requests` table, split `shop_members`/`roles` RLS policies — consumed by Tasks 4, 5, 6, 12, 13.

- [ ] **Step 1: Create the migration**

```sql
-- Full HR module for the new Team (People) tab: pay/hire info on
-- shop_members, simple clock-in/out shifts, and single-approval-level
-- time-off requests. See docs/superpowers/plans/2026-08-02-people-team-hr.md
-- Global Constraints #5 -- deliberately no breaks/geofencing/photo
-- verification, no pay-periods/payslip engine, no multi-level approval.

alter table public.shop_members add column hire_date date null;
alter table public.shop_members add column pay_type text null
  check (pay_type in ('hourly','salary','fixed'));
alter table public.shop_members add column pay_rate_cents integer null;

create table public.time_entries (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  shop_member_id uuid not null references public.shop_members(id) on delete cascade,
  clock_in timestamptz not null default now(),
  clock_out timestamptz null,
  created_at timestamptz not null default now()
);
create index time_entries_shop_id_idx on public.time_entries(shop_id);
create index time_entries_shop_member_id_idx on public.time_entries(shop_member_id);
-- Powers "does this member have an open shift" lookups (getOpenTimeEntry).
create index time_entries_open_idx on public.time_entries(shop_member_id) where clock_out is null;

create table public.time_off_requests (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  shop_member_id uuid not null references public.shop_members(id) on delete cascade,
  start_date date not null,
  end_date date not null,
  reason text null,
  status text not null default 'pending' check (status in ('pending','approved','denied')),
  requested_at timestamptz not null default now(),
  decided_by uuid null references auth.users(id) on delete set null,
  decided_at timestamptz null,
  constraint time_off_requests_dates check (end_date >= start_date)
);
create index time_off_requests_shop_id_idx on public.time_off_requests(shop_id);
create index time_off_requests_shop_member_id_idx on public.time_off_requests(shop_member_id);

alter table public.time_entries enable row level security;
alter table public.time_off_requests enable row level security;

-- time_entries: a member manages their own rows outright -- this is the
-- "tap to clock in/out" affordance. Deliberately not restricted to
-- insert-then-only-clock_out-update (no trigger enforcing that shape): app
-- code only ever inserts a fresh row or updates clock_out on an open one,
-- and keeping this simple matches Global Constraints #5.
create policy "member manages own time entries" on public.time_entries for all
  using (exists (
    select 1 from public.shop_members m
    where m.id = shop_member_id and m.user_id = auth.uid() and m.active
  ))
  with check (exists (
    select 1 from public.shop_members m
    where m.id = shop_member_id and m.user_id = auth.uid() and m.active
  ));

-- Manager-side: read team-wide entries (people.timesheet.view covers both
-- "just view hours" and people.payroll.manage's broader access), and
-- correct a forgotten clock-out (people.payroll.manage only).
create policy "manager reads shop time entries" on public.time_entries for select
  using (has_any_shop_permission(shop_id, array['people.timesheet.view','people.payroll.manage']));
create policy "manager corrects shop time entries" on public.time_entries for update
  using (has_shop_permission(shop_id, 'people.payroll.manage'))
  with check (has_shop_permission(shop_id, 'people.payroll.manage'));

grant select, insert, update, delete on public.time_entries to authenticated;

-- time_off_requests: a member creates/reads their own (insert only ever as
-- 'pending' -- they can't self-approve by inserting a decided row); an
-- approver (people.timeoff.approve) gets full read/write to decide them.
-- No self-service edit/cancel of a submitted request in this pass.
create policy "member requests own time off" on public.time_off_requests for insert
  with check (
    status = 'pending'
    and exists (select 1 from public.shop_members m where m.id = shop_member_id and m.user_id = auth.uid() and m.active)
  );
create policy "member reads own time off requests" on public.time_off_requests for select
  using (exists (select 1 from public.shop_members m where m.id = shop_member_id and m.user_id = auth.uid()));
create policy "approver manages shop time off requests" on public.time_off_requests for all
  using (has_shop_permission(shop_id, 'people.timeoff.approve'))
  with check (has_shop_permission(shop_id, 'people.timeoff.approve'));

grant select, insert, update, delete on public.time_off_requests to authenticated;

-- shop_members: split the single "manage shop_members" policy from 0024 so
-- people.payroll.manage/people.timesheet.view roles can read the roster
-- (needed for Team tab list/detail + "Recent shifts" context) without
-- staff.manage, and people.payroll.manage can write pay/hire fields without
-- staff.manage either.
--
-- Explicit trade-off, not re-solved here: Postgres RLS is row-level, not
-- column-level, and this app uses one shared `authenticated` DB role for
-- every signed-in user (RLS differentiates via auth.uid(), not per-
-- permission Postgres roles) -- there is no clean way to let
-- people.payroll.manage write only hire_date/pay_type/pay_rate_cents while
-- blocking it from also writing role_id/active on the same row, short of a
-- trigger or a separate pay table. This accepts the same granularity the
-- rest of the app already uses elsewhere (e.g. sales.edit covers both edit
-- and delete): staff.manage OR people.payroll.manage can write the *whole*
-- shop_members row via "write shop_members roster" below.
drop policy "manage shop_members" on public.shop_members;
create policy "read shop_members" on public.shop_members for select
  using (has_any_shop_permission(shop_id, array['staff.manage','people.payroll.manage','people.timesheet.view']));
create policy "insert shop_members" on public.shop_members for insert
  with check (has_shop_permission(shop_id, 'staff.manage'));
create policy "write shop_members roster" on public.shop_members for update
  using (has_any_shop_permission(shop_id, array['staff.manage','people.payroll.manage']))
  with check (has_any_shop_permission(shop_id, array['staff.manage','people.payroll.manage']));
create policy "delete shop_members" on public.shop_members for delete
  using (has_shop_permission(shop_id, 'staff.manage'));
-- "staff reads own membership" (0017_roles_and_staff.sql) is untouched --
-- still how a member reads their own row, including the new pay fields.

-- roles: same read split, plus a new "staff reads own role" so any active
-- staff member (e.g. a Cashier with none of the People permissions) can
-- resolve their own role's name/permissions for the self-service /me
-- screen without needing staff.manage or any People-side permission.
drop policy "manage roles" on public.roles;
create policy "read roles" on public.roles for select
  using (has_any_shop_permission(shop_id, array['staff.manage','people.payroll.manage','people.timesheet.view']));
create policy "write roles" on public.roles for all
  using (has_shop_permission(shop_id, 'staff.manage'))
  with check (has_shop_permission(shop_id, 'staff.manage'));
create policy "staff reads own role" on public.roles for select
  using (exists (
    select 1 from public.shop_members m
    where m.role_id = roles.id and m.user_id = auth.uid() and m.active
  ));
```

- [ ] **Step 2: Apply the migration**

Run: `supabase db push`. Verify with `supabase migration list`.

**This is the highest-blast-radius change in the plan** (it touches who can read the existing staff roster) — before moving to Task 4, manually spot-check in the Supabase SQL editor or via `psql`:
- An owner can still `select * from shop_members` for their shop (unaffected — `has_any_shop_permission`'s admin bypass).
- A row with only `pos.access` in its role's `permissions` gets zero rows back from `select * from shop_members` (no `staff.manage`/`people.payroll.manage`/`people.timesheet.view`).
- A row with `people.timesheet.view` gets rows back from `shop_members` and `roles` but a permission-denied (empty result, RLS-filtered) on writing to either.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260802030200_hr_schema.sql
git commit -m "feat: add HR schema (shop_members pay/hire columns, time_entries, time_off_requests, permission-split RLS)"
```

---

### Task 4: HR types + `src/lib/staff.ts` additions

**Files:**
- Modify: `src/types/models.ts` (`StaffMember` type)
- Modify: `src/lib/staff.ts` (`mapStaffRow`, new `getMyMembership`, `updateStaffPay`)

**Interfaces:**
- Consumes: Task 3's new `shop_members` columns.
- Produces: `StaffMember.hireDate/payType/payRateCents`, `getMyMembership(shopId, userId)`, `updateStaffPay(memberId, patch)` — consumed by Task 6 (`useAuth()`'s `myMembership`), Task 12 (Team detail pane payroll), Task 13 (`/me`).

- [ ] **Step 1: Extend `StaffMember`**

In `src/types/models.ts`, the `StaffMember` type currently reads:
```ts
export type StaffMember = {
  id: string;
  shopId: string;
  userId: string;
  roleId: string;
  roleName: string;
  active: boolean;
  fullName: string | null;
  email: string | null;
  createdAt: string;
};
```
Replace with:
```ts
export type StaffMember = {
  id: string;
  shopId: string;
  userId: string;
  roleId: string;
  roleName: string;
  active: boolean;
  fullName: string | null;
  email: string | null;
  createdAt: string;
  hireDate: string | null;
  payType: 'hourly' | 'salary' | 'fixed' | null;
  payRateCents: number | null;
};
```

- [ ] **Step 2: Extend `mapStaffRow` in `src/lib/staff.ts`**

Current:
```ts
function mapStaffRow(row: any): StaffMember {
  return {
    id: row.id,
    shopId: row.shop_id,
    userId: row.user_id,
    roleId: row.role_id,
    roleName: row.role?.name ?? '',
    active: row.active,
    fullName: row.full_name,
    email: row.email,
    createdAt: row.created_at,
  };
}
```
Replace with:
```ts
function mapStaffRow(row: any): StaffMember {
  return {
    id: row.id,
    shopId: row.shop_id,
    userId: row.user_id,
    roleId: row.role_id,
    roleName: row.role?.name ?? '',
    active: row.active,
    fullName: row.full_name,
    email: row.email,
    createdAt: row.created_at,
    hireDate: row.hire_date,
    payType: row.pay_type,
    payRateCents: row.pay_rate_cents,
  };
}
```
`listStaff`'s `.select('*, role:roles(name)')` already returns `hire_date`/`pay_type`/`pay_rate_cents` via `select('*')` — no query change needed there.

- [ ] **Step 3: Add `getMyMembership` and `updateStaffPay`**

Append to `src/lib/staff.ts`, after `listStaff`:
```ts
// A staff member's own roster row -- the "am I on the team, and what's my
// role/pay/hire-date" lookup useAuth() has no equivalent of today (see
// migration 0017's "staff reads own membership" policy, previously unused
// client-side). Returns null for an admin (no shop_members row -- see
// getMyPermissions) and for anyone with no membership in this shop.
export async function getMyMembership(shopId: string, userId: string): Promise<StaffMember | null> {
  const { data, error } = await supabase
    .from('shop_members')
    .select('*, role:roles(name)')
    .eq('shop_id', shopId)
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw error;
  return data ? mapStaffRow(data) : null;
}

// Sets hire date / pay type / pay rate on a roster row -- gated at the DB
// by "write shop_members roster" (staff.manage OR people.payroll.manage,
// migration 20260802030200_hr_schema.sql).
export async function updateStaffPay(
  memberId: string,
  patch: { hireDate?: string | null; payType?: StaffMember['payType']; payRateCents?: number | null }
): Promise<void> {
  const { error } = await supabase
    .from('shop_members')
    .update({
      ...(patch.hireDate !== undefined && { hire_date: patch.hireDate }),
      ...(patch.payType !== undefined && { pay_type: patch.payType }),
      ...(patch.payRateCents !== undefined && { pay_rate_cents: patch.payRateCents }),
    })
    .eq('id', memberId);
  if (error) throw error;
}
```

- [ ] **Step 4: Type-check**

Run: `npx tsc --noEmit`. Expected: no new errors.

- [ ] **Step 5: Commit**

```bash
git add src/types/models.ts src/lib/staff.ts
git commit -m "feat: add hireDate/payType/payRateCents to StaffMember, getMyMembership, updateStaffPay"
```

---

### Task 5: New `src/lib/time-entries.ts` and `src/lib/time-off.ts`

**Files:**
- Create: `src/lib/time-entries.ts`
- Create: `src/lib/time-off.ts`
- Modify: `src/types/models.ts` (new `TimeEntry`, `TimeOffRequest` types)

**Interfaces:**
- Consumes: Task 3's `time_entries`/`time_off_requests` tables.
- Produces: `TimeEntry`, `TimeOffRequest` types; `getOpenTimeEntry`, `clockIn`, `clockOut`, `listMyTimeEntries`, `listShopTimeEntries`, `sumDurationHours`; `listMyTimeOffRequests`, `requestTimeOff`, `listShopTimeOffRequests`, `decideTimeOffRequest` — consumed by Task 12 (Team detail's Recent shifts/time-off approval), Task 13 (`/me`).

- [ ] **Step 1: Add `TimeEntry`/`TimeOffRequest` types**

In `src/types/models.ts`, add near `StaffMember`:
```ts
export type TimeEntry = {
  id: string;
  shopId: string;
  shopMemberId: string;
  clockIn: string;
  clockOut: string | null;
  createdAt: string;
};

export type TimeOffRequest = {
  id: string;
  shopId: string;
  shopMemberId: string;
  startDate: string;
  endDate: string;
  reason: string | null;
  status: 'pending' | 'approved' | 'denied';
  requestedAt: string;
  decidedBy: string | null;
  decidedAt: string | null;
};
```

- [ ] **Step 2: Create `src/lib/time-entries.ts`**

```ts
import { supabase } from '@/lib/supabase';
import type { TimeEntry } from '@/types/models';

function mapTimeEntryRow(row: any): TimeEntry {
  return {
    id: row.id,
    shopId: row.shop_id,
    shopMemberId: row.shop_member_id,
    clockIn: row.clock_in,
    clockOut: row.clock_out,
    createdAt: row.created_at,
  };
}

// The currently-open shift for a member, if any -- drives the /me clock
// widget's "Clock in" vs "Clock out" state.
export async function getOpenTimeEntry(shopMemberId: string): Promise<TimeEntry | null> {
  const { data, error } = await supabase
    .from('time_entries')
    .select('*')
    .eq('shop_member_id', shopMemberId)
    .is('clock_out', null)
    .maybeSingle();
  if (error) throw error;
  return data ? mapTimeEntryRow(data) : null;
}

export async function clockIn(shopId: string, shopMemberId: string): Promise<TimeEntry> {
  const { data, error } = await supabase
    .from('time_entries')
    .insert({ shop_id: shopId, shop_member_id: shopMemberId })
    .select('*')
    .single();
  if (error) throw error;
  return mapTimeEntryRow(data);
}

export async function clockOut(entryId: string): Promise<void> {
  const { error } = await supabase.from('time_entries').update({ clock_out: new Date().toISOString() }).eq('id', entryId);
  if (error) throw error;
}

// A member's own recent shifts (self-service /me "Recent shifts").
export async function listMyTimeEntries(shopMemberId: string, sinceIso?: string): Promise<TimeEntry[]> {
  let query = supabase.from('time_entries').select('*').eq('shop_member_id', shopMemberId).order('clock_in', { ascending: false });
  if (sinceIso) query = query.gte('clock_in', sinceIso);
  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []).map(mapTimeEntryRow);
}

// Shop-wide, optionally filtered to one member -- the Team detail pane's
// "Hours this period"/"Recent shifts" (gated on people.timesheet.view or
// people.payroll.manage at the RLS layer).
export async function listShopTimeEntries(shopId: string, opts?: { shopMemberId?: string; sinceIso?: string }): Promise<TimeEntry[]> {
  let query = supabase.from('time_entries').select('*').eq('shop_id', shopId).order('clock_in', { ascending: false });
  if (opts?.shopMemberId) query = query.eq('shop_member_id', opts.shopMemberId);
  if (opts?.sinceIso) query = query.gte('clock_in', opts.sinceIso);
  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []).map(mapTimeEntryRow);
}

// Pure reduction, no schema/query involved -- open shifts (clockOut null)
// are excluded from the total (an in-progress shift isn't "hours worked"
// yet); callers show those separately as "on shift now" if needed.
export function sumDurationHours(entries: TimeEntry[]): number {
  const totalMs = entries.reduce((sum, entry) => {
    if (!entry.clockOut) return sum;
    return sum + (new Date(entry.clockOut).getTime() - new Date(entry.clockIn).getTime());
  }, 0);
  return totalMs / (1000 * 60 * 60);
}
```

- [ ] **Step 3: Create `src/lib/time-off.ts`**

```ts
import { supabase } from '@/lib/supabase';
import type { TimeOffRequest } from '@/types/models';

function mapTimeOffRow(row: any): TimeOffRequest {
  return {
    id: row.id,
    shopId: row.shop_id,
    shopMemberId: row.shop_member_id,
    startDate: row.start_date,
    endDate: row.end_date,
    reason: row.reason,
    status: row.status,
    requestedAt: row.requested_at,
    decidedBy: row.decided_by,
    decidedAt: row.decided_at,
  };
}

export async function listMyTimeOffRequests(shopMemberId: string): Promise<TimeOffRequest[]> {
  const { data, error } = await supabase
    .from('time_off_requests')
    .select('*')
    .eq('shop_member_id', shopMemberId)
    .order('requested_at', { ascending: false });
  if (error) throw error;
  return (data ?? []).map(mapTimeOffRow);
}

export async function requestTimeOff(
  shopId: string,
  shopMemberId: string,
  input: { startDate: string; endDate: string; reason?: string | null }
): Promise<TimeOffRequest> {
  const { data, error } = await supabase
    .from('time_off_requests')
    .insert({ shop_id: shopId, shop_member_id: shopMemberId, start_date: input.startDate, end_date: input.endDate, reason: input.reason ?? null })
    .select('*')
    .single();
  if (error) throw error;
  return mapTimeOffRow(data);
}

// Shop-wide, optionally filtered by status -- the Team tab's approval list
// (gated on people.timeoff.approve at the RLS layer).
export async function listShopTimeOffRequests(shopId: string, opts?: { status?: TimeOffRequest['status'] }): Promise<TimeOffRequest[]> {
  let query = supabase.from('time_off_requests').select('*').eq('shop_id', shopId).order('requested_at', { ascending: false });
  if (opts?.status) query = query.eq('status', opts.status);
  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []).map(mapTimeOffRow);
}

// Approve/deny -- decided_by is the calling (approver) user, read from the
// current session rather than passed in, so a caller can't misattribute a
// decision to someone else.
export async function decideTimeOffRequest(requestId: string, decision: 'approved' | 'denied'): Promise<void> {
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError) throw userError;
  const { error } = await supabase
    .from('time_off_requests')
    .update({ status: decision, decided_by: userData.user?.id ?? null, decided_at: new Date().toISOString() })
    .eq('id', requestId);
  if (error) throw error;
}
```

- [ ] **Step 4: Type-check**

Run: `npx tsc --noEmit`. Expected: no new errors.

- [ ] **Step 5: Commit**

```bash
git add src/types/models.ts src/lib/time-entries.ts src/lib/time-off.ts
git commit -m "feat: add TimeEntry/TimeOffRequest types and their lib modules"
```

---

### Task 6: Permission catalog (`src/lib/permissions.ts`) + `useAuth()` `myMembership`/`canAny` + `permissions.test.ts`

**Files:**
- Modify: `src/lib/permissions.ts` (full file — every export changes)
- Modify: `src/hooks/use-auth.tsx` (full file)
- Modify: `src/lib/__tests__/permissions.test.ts` (full file)

**Interfaces:**
- Consumes: Task 4's `getMyMembership`.
- Produces: 3 new `Permission` values, `permissionForPath` now returns `Permission[] | null`, `useAuth().myMembership`/`canAny` — consumed by Task 7 (`(admin)/_layout.tsx`), Task 10 (nav components, `me.tsx` guard), Task 12, Task 13.

- [ ] **Step 1: Rewrite `src/lib/permissions.ts`**

Replace the `Permission` type:
```ts
export type Permission =
  | 'pos.access'
  | 'inventory.view'
  | 'inventory.edit'
  | 'sales.view'
  | 'sales.edit'
  | 'sales.refund'
  | 'customers.view'
  | 'customers.edit'
  | 'dashboard.view'
  | 'settings.access'
  | 'staff.manage';
```
with:
```ts
export type Permission =
  | 'pos.access'
  | 'inventory.view'
  | 'inventory.edit'
  | 'sales.view'
  | 'sales.edit'
  | 'sales.refund'
  | 'customers.view'
  | 'customers.edit'
  | 'dashboard.view'
  | 'settings.access'
  | 'staff.manage'
  | 'people.timeoff.approve'
  | 'people.payroll.manage'
  | 'people.timesheet.view';
```

Replace the `PERMISSIONS` array (relabels `staff.manage`, appends 3 entries):
```ts
export const PERMISSIONS: { key: Permission; label: string; description: string }[] = [
  { key: 'pos.access', label: 'Access POS', description: 'Use the register to ring up sales and take payment.' },
  { key: 'inventory.view', label: 'View inventory', description: 'See the product list and stock levels.' },
  { key: 'inventory.edit', label: 'Edit inventory', description: 'Add, edit, or delete products and adjust stock.' },
  { key: 'sales.view', label: 'View sales history', description: 'See past sales and receipts.' },
  { key: 'sales.edit', label: 'Edit/delete sales', description: 'Edit or delete a past sale.' },
  { key: 'sales.refund', label: 'Refund sales', description: 'Issue refunds against past sales and restore stock. Independent of sales editing.' },
  { key: 'customers.view', label: 'View customers', description: 'Browse the customer directory and its contact details.' },
  { key: 'customers.edit', label: 'Edit customers', description: 'Add, edit, or delete customer records.' },
  { key: 'dashboard.view', label: 'View dashboard', description: 'See revenue, trends, and other shop analytics.' },
  { key: 'settings.access', label: 'Access settings', description: 'View and change shop settings, tax, and catalog.' },
  { key: 'staff.manage', label: 'Manage team roster', description: 'Create roles and add or remove staff accounts.' },
  { key: 'people.timeoff.approve', label: 'Approve time off', description: 'Approve or deny staff time-off requests.' },
  { key: 'people.payroll.manage', label: 'Manage payroll', description: 'Set hire date, pay type, and pay rate for staff.' },
  { key: 'people.timesheet.view', label: 'View team hours', description: "See the whole team's clock-in history and shift hours, not just your own." },
];
```

Replace `IMPLIED_PERMISSIONS`:
```ts
export const IMPLIED_PERMISSIONS: Partial<Record<Permission, Permission[]>> = {
  'inventory.edit': ['inventory.view'],
  'sales.edit': ['sales.view'],
  'sales.refund': ['sales.view'],
  'customers.edit': ['customers.view'],
  'people.payroll.manage': ['people.timesheet.view'],
};
```

Replace `ROUTE_PERMISSIONS` and `permissionForPath` (the `/customers` entry becomes `/people` with an array of every permission that unlocks either sub-tab; `/account` is dropped since Task 7 deletes that route):
```ts
// Every route inside the `(admin)` group and the permission(s) it needs.
// Keys are matched longest-first as path prefixes, so `/product/new`
// resolves via `/product`. An array means "any of these" -- /people is
// valid with customers.view (Customers sub-tab) OR any of the People-
// manager permissions (Team sub-tab). Anything not listed here is
// unrestricted for a signed-in member (e.g. `/marketplace-coming-soon`,
// and deliberately `/me` -- self-service HR is gated on active membership,
// not a Permission; see (admin)/_layout.tsx).
const ROUTE_PERMISSIONS: { prefix: string; permission: Permission | Permission[] }[] = [
  { prefix: '/dashboard', permission: 'dashboard.view' },
  { prefix: '/pos', permission: 'pos.access' },
  { prefix: '/inventory', permission: 'inventory.view' },
  { prefix: '/product', permission: 'inventory.edit' },
  { prefix: '/people', permission: ['customers.view', 'staff.manage', 'people.timeoff.approve', 'people.payroll.manage', 'people.timesheet.view'] },
  { prefix: '/sales', permission: 'sales.view' },
  { prefix: '/settings', permission: 'settings.access' },
];

export function permissionForPath(pathname: string): Permission[] | null {
  const match = [...ROUTE_PERMISSIONS]
    .sort((a, b) => b.prefix.length - a.prefix.length)
    .find((entry) => pathname === entry.prefix || pathname.startsWith(`${entry.prefix}/`));
  if (!match) return null;
  return Array.isArray(match.permission) ? match.permission : [match.permission];
}
```

Replace `LANDING_ROUTES` (`/customers` → `/people`, still keyed on `customers.view` alone for landing-choice purposes — Team-only permissions don't make `/people` a sensible *first* landing tab for someone who lacks even `customers.view`):
```ts
const LANDING_ROUTES = [
  { href: '/dashboard', permission: 'dashboard.view' },
  { href: '/pos', permission: 'pos.access' },
  { href: '/inventory', permission: 'inventory.view' },
  { href: '/people', permission: 'customers.view' },
  { href: '/sales', permission: 'sales.view' },
] as const satisfies readonly { href: string; permission: Permission }[];
```
`firstAllowedRoute` itself is unchanged (still single-permission `.includes()` logic against `LANDING_ROUTES`).

- [ ] **Step 2: Rewrite `src/hooks/use-auth.tsx`**

Update the imports at the top — replace:
```ts
import type { Permission } from '@/lib/permissions';
import { getMyShop } from '@/lib/shops';
import { getMyPermissions } from '@/lib/staff';
import { supabase } from '@/lib/supabase';
import type { Profile, Shop } from '@/types/models';
```
with:
```ts
import type { Permission } from '@/lib/permissions';
import { getMyShop } from '@/lib/shops';
import { getMyMembership, getMyPermissions } from '@/lib/staff';
import { supabase } from '@/lib/supabase';
import type { Profile, Shop, StaffMember } from '@/types/models';
```

Replace the `AuthState` type — add `myMembership` and `canAny`:
```ts
type AuthState = {
  session: Session | null;
  profile: Profile | null;
  shop: Shop | null;
  // What this user's role grants in `shop` — the whole catalog for the admin
  // who owns it, their role's expanded permission set for staff, empty when
  // there's no shop resolved yet. Consumers should use `can()` rather than
  // reading this directly.
  permissions: Permission[];
  can: (permission: Permission) => boolean;
  // For routes/nav items valid under more than one permission (e.g. /people,
  // which needs customers.view OR any People-manager permission).
  canAny: (permissions: Permission[]) => boolean;
  // This user's own shop_members row -- null for an admin (owns the shop
  // instead of belonging to it) and while unresolved. Powers the
  // self-service /me tab, which is reachable by active membership alone,
  // not any Permission (see src/lib/permissions.ts's ROUTE_PERMISSIONS
  // comment).
  myMembership: StaffMember | null;
  loading: boolean;
  refreshShop: () => Promise<void>;
  // Settings' profile editor already gets the freshly-updated row back from
  // `updateProfile()`, so this just adopts it into context directly rather
  // than a refetch — same effect as `refreshShop`, one less round trip.
  setProfile: (profile: Profile) => void;
};
```

Replace `loadShopAndPermissions`:
```ts
async function loadShopAndPermissions(): Promise<{ shop: Shop | null; permissions: Permission[] }> {
  const [{ data: userData }, shop] = await Promise.all([supabase.auth.getUser(), getMyShop()]);
  const userId = userData.user?.id;
  if (!shop || !userId) return { shop, permissions: noPermissions };
  try {
    return { shop, permissions: await getMyPermissions(shop, userId) };
  } catch {
    // Fail closed: an unresolved permission set must never read as "allow
    // everything". Swallowed rather than rethrown so a failure here can't
    // reject loadForSession() and strand the app on its loading spinner —
    // the session still resolves, the user just lands on the "no access"
    // screen and can retry. Only staff can reach this: an admin's
    // permissions come from owning the shop, with no round trip to fail.
    return { shop, permissions: noPermissions };
  }
}
```
with:
```ts
async function loadShopAndPermissions(): Promise<{ shop: Shop | null; permissions: Permission[]; myMembership: StaffMember | null }> {
  const [{ data: userData }, shop] = await Promise.all([supabase.auth.getUser(), getMyShop()]);
  const userId = userData.user?.id;
  if (!shop || !userId) return { shop, permissions: noPermissions, myMembership: null };
  try {
    const [permissions, myMembership] = await Promise.all([getMyPermissions(shop, userId), getMyMembership(shop.id, userId)]);
    return { shop, permissions, myMembership };
  } catch {
    // Fail closed: an unresolved permission set must never read as "allow
    // everything". Swallowed rather than rethrown so a failure here can't
    // reject loadForSession() and strand the app on its loading spinner —
    // the session still resolves, the user just lands on the "no access"
    // screen (or signed out of /me) and can retry. Only staff can reach the
    // permissions half of this: an admin's permissions come from owning the
    // shop, with no round trip to fail. getMyMembership resolves to null
    // for an admin regardless (no shop_members row), so it never throws for
    // that case either.
    return { shop, permissions: noPermissions, myMembership: null };
  }
}
```

In `AuthProvider`, add a `myMembership` state next to `permissions` — replace:
```ts
  const [permissions, setPermissions] = useState<Permission[]>(noPermissions);
  const [loading, setLoading] = useState(true);
```
with:
```ts
  const [permissions, setPermissions] = useState<Permission[]>(noPermissions);
  const [myMembership, setMyMembership] = useState<StaffMember | null>(null);
  const [loading, setLoading] = useState(true);
```

In `loadForSession`, the signed-out branch — replace:
```ts
      if (!nextSession) {
        setProfile(null);
        setShop(null);
        setPermissions(noPermissions);
        setLoading(false);
        return;
      }
```
with:
```ts
      if (!nextSession) {
        setProfile(null);
        setShop(null);
        setPermissions(noPermissions);
        setMyMembership(null);
        setLoading(false);
        return;
      }
```

Further down in `loadForSession`, where `resolved` is applied — replace:
```ts
      const myShopId = ++shopSeq.current;
      const resolved = await loadShopAndPermissions();
      if (!active || loadSeq.current !== myLoadId) return;
      if (shopSeq.current === myShopId) {
        setShop(resolved.shop);
        setPermissions(resolved.permissions);
      }
      setLoading(false);
    };
```
with:
```ts
      const myShopId = ++shopSeq.current;
      const resolved = await loadShopAndPermissions();
      if (!active || loadSeq.current !== myLoadId) return;
      if (shopSeq.current === myShopId) {
        setShop(resolved.shop);
        setPermissions(resolved.permissions);
        setMyMembership(resolved.myMembership);
      }
      setLoading(false);
    };
```

Replace `refreshShop`:
```ts
  const refreshShop = async () => {
    const myShopId = ++shopSeq.current;
    const resolved = await loadShopAndPermissions();
    if (shopSeq.current !== myShopId) return;
    setShop(resolved.shop);
    setPermissions(resolved.permissions);
  };

  const can = (permission: Permission) => permissions.includes(permission);

  return (
    <AuthContext.Provider value={{ session, profile, shop, permissions, can, loading, refreshShop, setProfile }}>
      {children}
    </AuthContext.Provider>
  );
}
```
with:
```ts
  const refreshShop = async () => {
    const myShopId = ++shopSeq.current;
    const resolved = await loadShopAndPermissions();
    if (shopSeq.current !== myShopId) return;
    setShop(resolved.shop);
    setPermissions(resolved.permissions);
    setMyMembership(resolved.myMembership);
  };

  const can = (permission: Permission) => permissions.includes(permission);
  const canAny = (perms: Permission[]) => perms.some((p) => permissions.includes(p));

  return (
    <AuthContext.Provider value={{ session, profile, shop, permissions, can, canAny, myMembership, loading, refreshShop, setProfile }}>
      {children}
    </AuthContext.Provider>
  );
}
```

- [ ] **Step 3: Rewrite `src/lib/__tests__/permissions.test.ts`**

Replace the entire file:
```ts
import {
  ALL_PERMISSIONS,
  expandPermissions,
  firstAllowedRoute,
  permissionForPath,
  type Permission,
} from '@/lib/permissions';

// The seeded roles from migration 0020 (plus 0024's customers additions) are
// the concrete cases this gate has to get right.
const CASHIER: string[] = ['pos.access', 'inventory.view'];
const MANAGER: string[] = [
  'pos.access',
  'inventory.view',
  'inventory.edit',
  'sales.view',
  'sales.edit',
  'dashboard.view',
  'customers.view',
  'customers.edit',
];

describe('expandPermissions', () => {
  it('keeps a stored set as-is when it needs no implications', () => {
    expect(expandPermissions(CASHIER)).toEqual(['pos.access', 'inventory.view']);
  });

  it('folds in implied permissions so a writer can also read', () => {
    expect(expandPermissions(['inventory.edit'])).toEqual(['inventory.view', 'inventory.edit']);
    expect(expandPermissions(['sales.edit'])).toEqual(['sales.view', 'sales.edit']);
    expect(expandPermissions(['sales.refund'])).toEqual(['sales.view', 'sales.refund']);
    expect(expandPermissions(['customers.edit'])).toEqual(['customers.view', 'customers.edit']);
  });

  it('folds people.payroll.manage into also granting people.timesheet.view', () => {
    expect(expandPermissions(['people.payroll.manage'])).toEqual(['people.payroll.manage', 'people.timesheet.view']);
  });

  it('drops entries that are not in the catalog', () => {
    expect(expandPermissions(['pos.access', 'reports.export', ''])).toEqual(['pos.access']);
  });

  it('deduplicates and returns catalog order regardless of stored order', () => {
    expect(expandPermissions(['inventory.view', 'inventory.edit', 'pos.access', 'inventory.view'])).toEqual([
      'pos.access',
      'inventory.view',
      'inventory.edit',
    ]);
  });

  it('resolves an empty role to no permissions at all', () => {
    expect(expandPermissions([])).toEqual([]);
  });
});

describe('permissionForPath', () => {
  it.each([
    ['/dashboard', ['dashboard.view']],
    ['/pos', ['pos.access']],
    ['/inventory', ['inventory.view']],
    ['/sales', ['sales.view']],
    ['/settings', ['settings.access']],
  ] as const)('gates %s on %s', (path, permissions) => {
    expect(permissionForPath(path)).toEqual(permissions);
  });

  it('gates /people on any permission that unlocks Customers or Team', () => {
    expect(permissionForPath('/people')).toEqual([
      'customers.view',
      'staff.manage',
      'people.timeoff.approve',
      'people.payroll.manage',
      'people.timesheet.view',
    ]);
  });

  it('gates the product detail screens on inventory.edit, not inventory.view', () => {
    expect(permissionForPath('/product/new')).toEqual(['inventory.edit']);
    expect(permissionForPath('/product/abc-123')).toEqual(['inventory.edit']);
  });

  it('leaves routes outside the catalog ungated, including /me (self-service HR)', () => {
    expect(permissionForPath('/marketplace-coming-soon')).toBeNull();
    expect(permissionForPath('/login')).toBeNull();
    expect(permissionForPath('/me')).toBeNull();
  });

  it('does not treat a longer unrelated segment as a prefix match', () => {
    expect(permissionForPath('/salesperson')).toBeNull();
  });
});

describe('firstAllowedRoute', () => {
  it('lands an admin on the dashboard', () => {
    expect(firstAllowedRoute(ALL_PERMISSIONS)).toBe('/dashboard');
  });

  it('lands a cashier on the POS, since the dashboard is off-limits', () => {
    expect(firstAllowedRoute(expandPermissions(CASHIER))).toBe('/pos');
  });

  it('lands a manager on the dashboard', () => {
    expect(firstAllowedRoute(expandPermissions(MANAGER))).toBe('/dashboard');
  });

  it('returns null when a role grants nothing navigable', () => {
    expect(firstAllowedRoute([])).toBeNull();
    // settings.access has no tab of its own -- it's reached from the nav
    // footer, so it alone is not a landing spot.
    expect(firstAllowedRoute(['settings.access'])).toBeNull();
  });
});

describe('the cashier scope this gate exists to enforce', () => {
  const cashier = expandPermissions(CASHIER);
  const blocked: Permission[] = [
    'sales.view',
    'sales.edit',
    'sales.refund',
    'dashboard.view',
    'customers.view',
    'settings.access',
    'staff.manage',
    'inventory.edit',
    'people.timeoff.approve',
    'people.payroll.manage',
    'people.timesheet.view',
  ];

  it.each(blocked)('does not grant %s', (permission) => {
    expect(cashier).not.toContain(permission);
  });

  it('blocks every route a cashier should not reach', () => {
    for (const path of ['/dashboard', '/sales', '/people', '/settings', '/product/new']) {
      const required = permissionForPath(path);
      expect(required).not.toBeNull();
      expect((required as Permission[]).some((p) => cashier.includes(p))).toBe(false);
    }
  });

  it('still grants the two routes a cashier works from', () => {
    expect(permissionForPath('/pos')!.some((p) => cashier.includes(p))).toBe(true);
    expect(permissionForPath('/inventory')!.some((p) => cashier.includes(p))).toBe(true);
  });
});
```

- [ ] **Step 4: Type-check and run tests**

Run: `npx tsc --noEmit`
Expected: **new errors** in `src/app/(admin)/_layout.tsx` (`can(required)` no longer type-checks against `Permission[]`) and in any nav component still referencing `/customers`/`'customers.view'` as a single permission for that route — these are expected and fixed by Task 7 (`_layout.tsx`) and Task 10 (nav components). Confirm the *only* new errors are in those files, not elsewhere.

Run: `npm test -- src/lib/__tests__/permissions.test.ts`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/lib/permissions.ts src/hooks/use-auth.tsx src/lib/__tests__/permissions.test.ts
git commit -m "feat: add people.* permissions, array-valued permissionForPath, useAuth myMembership/canAny"
```

---

### Task 7: `(admin)/_layout.tsx` route guard + delete dead `account.tsx`

**Files:**
- Modify: `src/app/(admin)/_layout.tsx`
- Delete: `src/app/(admin)/account.tsx`

**Interfaces:**
- Consumes: Task 6's array-valued `permissionForPath`, `useAuth().myMembership`.
- Produces: the route guard any `/people`/`/me` visit goes through — consumed by nothing further (leaf of the permission-plumbing chain), but Task 10's `people.tsx`/`me.tsx` routes depend on this guard being correct first.

**`account.tsx` is confirmed dead**: `grep -rn "/account" src/` (excluding this file itself and its own `router.replace`/route-name references) returns nothing — no `Link href="/account"`, no nav item, no `router.push('/account')` anywhere. `StaffPanel`'s own top comment already documents it: *"Ported from the previous `app/(admin)/account.tsx` (now unreached from the Settings sidebar...)"*.

- [ ] **Step 1: Delete the dead route**

```bash
git rm "src/app/(admin)/account.tsx"
```

- [ ] **Step 2: Update the route guard**

In `src/app/(admin)/_layout.tsx`, replace the destructure:
```tsx
  const { loading, session, profile, permissions, can } = useAuth();
```
with:
```tsx
  const { loading, session, profile, permissions, can, myMembership } = useAuth();
```

Replace the gating block (everything from `const landing = ...` through the `if (!landing) return <NoAccessScreen />;` line) — currently:
```tsx
  const landing = firstAllowedRoute(permissions);
  const required = permissionForPath(pathname);
  if (required && !can(required)) {
    return landing ? <Redirect href={landing} /> : <NoAccessScreen />;
  }
  if (!landing) return <NoAccessScreen />;
```
with:
```tsx
  const landing = firstAllowedRoute(permissions);
  // /me (self-service HR) is reachable by any active staff member or the
  // admin regardless of operational permissions -- it's deliberately absent
  // from ROUTE_PERMISSIONS (permissionForPath returns null for it), gated
  // here on active shop_members membership instead. An active member with
  // no operational permissions at all now falls back here too, instead of
  // the dead-end NoAccessScreen below.
  const canReachMe = profile.role === 'admin' || Boolean(myMembership?.active);
  const fallback = landing ?? (canReachMe ? '/me' : null);

  const isMeRoute = pathname === '/me' || pathname.startsWith('/me/');
  const required = permissionForPath(pathname);
  const allowed = isMeRoute ? canReachMe : !required || required.some(can);
  if (!allowed) {
    return fallback ? <Redirect href={fallback} /> : <NoAccessScreen />;
  }
  if (!isMeRoute && !landing) {
    return fallback ? <Redirect href={fallback} /> : <NoAccessScreen />;
  }
```

Replace the final `Stack` (drops the deleted `account` screen):
```tsx
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="(tabs)" />
      <Stack.Screen name="product/new" />
      <Stack.Screen name="product/[id]" />
      <Stack.Screen name="settings" />
      <Stack.Screen name="account" />
    </Stack>
  );
```
with:
```tsx
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="(tabs)" />
      <Stack.Screen name="product/new" />
      <Stack.Screen name="product/[id]" />
      <Stack.Screen name="settings" />
    </Stack>
  );
```

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit`
Expected: the `_layout.tsx` errors from Task 6 are now gone. Any remaining errors should only be in Task 10's still-unmigrated nav components (`admin-tabs.tsx`, `admin-tabs.web.tsx`, `admin-sidebar.tsx`) if their `navItems` arrays still type as a single `Permission` against a route that now needs an array — confirm those are the only remaining errors.

- [ ] **Step 4: Commit**

```bash
git add "src/app/(admin)/_layout.tsx"
git rm "src/app/(admin)/account.tsx"
git commit -m "feat: route guard supports multi-permission routes, add /me membership fallback, delete dead account.tsx"
```

---

### Task 8: Settings cleanup — `StaffPanel` → `RolesPanel`, drop the roster half

**Files:**
- Delete: `src/components/settings/panels/staff-panel.tsx`
- Create: `src/components/settings/panels/roles-panel.tsx`
- Modify: `src/components/settings/settings-sidebar.tsx`
- Modify: `src/app/(admin)/settings.tsx`

**Interfaces:**
- Produces: `RolesPanel` component (roles-only) — consumed by `settings.tsx`. The removed `StaffSection`/`StaffRow`/`AddStaffModal` logic (staff roster CRUD, `provisionStaff` flow) is **not deleted from the app** — it's relocated into `team-add-modal.tsx` in Task 12, which imports `provisionStaff`/`updateStaffRole`/`setStaffActive` directly from `src/lib/staff.ts` (unchanged), not from this panel.

- [ ] **Step 1: Create `src/components/settings/panels/roles-panel.tsx`**

```tsx
import { useEffect, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';

import { Btn, PageHeader, Row, Section } from '@/components/settings/settings-primitives';
import { ALL_PERMISSIONS, expandPermissions, IMPLIED_PERMISSIONS, PERMISSIONS, type Permission } from '@/lib/permissions';
import { createRole, deleteRole, updateRole } from '@/lib/staff';
import type { Role } from '@/types/models';

// Role *definitions* only (what a role can do) -- roster management
// (adding/removing staff, assigning a role to someone) moved to the Team
// tab inside People (src/app/(admin)/(tabs)/people.tsx, see
// docs/superpowers/plans/2026-08-02-people-team-hr.md Task 12), a distinct
// admin concern from this one. Formerly StaffPanel; the removed
// StaffSection/StaffRow/AddStaffModal logic lives on in team-add-modal.tsx.

export function RolesPanel({
  shopId,
  roles,
  usage,
  onChange,
}: {
  shopId: string;
  roles: Role[];
  usage: Map<string, number>;
  onChange: () => Promise<void>;
}) {
  return (
    <View>
      <PageHeader title="Roles" />
      <RolesSection shopId={shopId} roles={roles} usage={usage} onChange={onChange} />
    </View>
  );
}

function RolesSection({
  shopId,
  roles,
  usage,
  onChange,
}: {
  shopId: string;
  roles: Role[];
  usage: Map<string, number>;
  onChange: () => Promise<void>;
}) {
  const [editing, setEditing] = useState<Role | 'new' | null>(null);

  return (
    <Section title={`Roles · ${roles.length}`}>
      <Text style={styles.hint}>Define what each role can do, then assign staff to it from the Team tab.</Text>
      {roles.length === 0 ? (
        <Text style={styles.empty}>No roles yet — create one to start adding staff.</Text>
      ) : (
        roles.map((role) => (
          <Row key={role.id} label={role.name} desc={`${role.permissions.length} permission${role.permissions.length === 1 ? '' : 's'} · ${usage.get(role.id) ?? 0} staff`}>
            <Btn onPress={() => setEditing(role)}>Edit</Btn>
          </Row>
        ))
      )}
      <View style={styles.actionsRow}>
        <Btn onPress={() => setEditing('new')}>New role</Btn>
      </View>

      <RoleEditorModal
        visible={editing !== null}
        role={editing === 'new' ? null : editing}
        usageCount={editing && editing !== 'new' ? (usage.get(editing.id) ?? 0) : 0}
        onClose={() => setEditing(null)}
        onSave={async (input) => {
          if (editing && editing !== 'new') await updateRole(editing.id, input);
          else await createRole(shopId, input.name!, input.permissions ?? []);
          await onChange();
          setEditing(null);
        }}
        onDelete={
          editing && editing !== 'new'
            ? async () => {
                await deleteRole(editing.id);
                await onChange();
                setEditing(null);
              }
            : undefined
        }
      />
    </Section>
  );
}

function RoleEditorModal({
  visible,
  role,
  usageCount,
  onClose,
  onSave,
  onDelete,
}: {
  visible: boolean;
  role: Role | null;
  usageCount: number;
  onClose: () => void;
  onSave: (input: { name?: string; permissions?: string[] }) => Promise<void>;
  onDelete?: () => Promise<void>;
}) {
  const [name, setName] = useState(role?.name ?? '');
  const [permissions, setPermissions] = useState<string[]>(role?.permissions ?? []);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (visible) {
      setName(role?.name ?? '');
      setPermissions(role?.permissions ?? []);
      setError(null);
    }
  }, [visible, role]);

  const togglePermission = (key: Permission) => {
    setPermissions((current) => {
      if (!current.includes(key)) return expandPermissions([...current, key]);
      const dependents = ALL_PERMISSIONS.filter((p) => (IMPLIED_PERMISSIONS[p] ?? []).includes(key));
      return current.filter((p) => p !== key && !dependents.includes(p as Permission));
    });
  };

  const save = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setSaving(true);
    setError(null);
    try {
      await onSave({ name: trimmed, permissions: expandPermissions(permissions) });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save this role.');
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!onDelete) return;
    if (usageCount > 0) {
      setError(`${usageCount} staff member${usageCount === 1 ? '' : 's'} still use this role — reassign them first.`);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onDelete();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete this role.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal visible={visible} animationType="fade" transparent onRequestClose={onClose}>
      <View style={modalStyles.overlay}>
        <View style={modalStyles.card}>
          <View style={modalStyles.header}>
            <Text style={modalStyles.title}>{role ? 'Edit role' : 'New role'}</Text>
            <View style={modalStyles.headerActions}>
              <Pressable onPress={save} disabled={saving || !name.trim()} style={[modalStyles.addButton, (saving || !name.trim()) && modalStyles.buttonDisabled]}>
                <Text style={modalStyles.addButtonText}>{saving ? 'Saving…' : 'Save'}</Text>
              </Pressable>
              <Pressable onPress={onClose} style={modalStyles.close}>
                <Text style={modalStyles.closeText}>Close</Text>
              </Pressable>
            </View>
          </View>
          <ScrollView style={modalStyles.list}>
            <Text style={modalStyles.fieldLabel}>ROLE NAME</Text>
            <TextInput value={name} onChangeText={setName} placeholder="e.g. Cashier" placeholderTextColor="#999999" style={modalStyles.input} />
            <Text style={[modalStyles.fieldLabel, { marginTop: 16 }]}>PERMISSIONS</Text>
            {PERMISSIONS.map((p) => (
              <Pressable key={p.key} onPress={() => togglePermission(p.key)} style={modalStyles.permissionRow}>
                <Switch value={permissions.includes(p.key)} pointerEvents="none" onValueChange={() => togglePermission(p.key)} />
                <View style={{ flex: 1 }}>
                  <Text style={modalStyles.rowLabel}>{p.label}</Text>
                  <Text style={modalStyles.rowSubLabel}>{p.description}</Text>
                </View>
              </Pressable>
            ))}
            {error && <Text style={styles.error}>{error}</Text>}
            <View style={modalStyles.formActions}>
              {onDelete && (
                <Pressable onPress={remove} disabled={saving} style={modalStyles.rowAction}>
                  <Text style={modalStyles.rowActionTextDanger}>Delete role</Text>
                </Pressable>
              )}
              <Pressable onPress={save} disabled={saving || !name.trim()} style={[modalStyles.addButton, (saving || !name.trim()) && modalStyles.buttonDisabled]}>
                <Text style={modalStyles.addButtonText}>{saving ? 'Saving…' : 'Save'}</Text>
              </Pressable>
            </View>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  hint: { fontSize: 12, color: '#9CA3AF', lineHeight: 17, marginBottom: 12 },
  empty: { fontSize: 13, color: '#9CA3AF', marginBottom: 12 },
  actionsRow: { flexDirection: 'row', gap: 8, marginTop: 4 },
  error: { color: '#C0392B', fontSize: 13, fontWeight: '700', marginTop: 6 },
});

const modalStyles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', alignItems: 'center', justifyContent: 'center', padding: 20 },
  card: { backgroundColor: '#FFFFFF', borderRadius: 18, padding: 20, width: '100%', maxWidth: 560, height: '80%', overflow: 'hidden' },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  title: { fontSize: 16, fontWeight: '800', color: '#111111' },
  close: { backgroundColor: '#111111', borderRadius: 10, paddingHorizontal: 18, paddingVertical: 12, alignItems: 'center', justifyContent: 'center' },
  closeText: { fontSize: 13, fontWeight: '800', color: '#FFFFFF' },
  list: { flex: 1 },
  fieldLabel: { fontSize: 10, letterSpacing: 0.6, fontWeight: '800', color: '#999999', marginBottom: 6 },
  input: { backgroundColor: '#F2F2F2', borderRadius: 10, height: 42, paddingHorizontal: 12, color: '#111111' },
  permissionRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: '#ECECEC' },
  rowLabel: { fontSize: 13, fontWeight: '700', color: '#111111' },
  rowSubLabel: { fontSize: 11, color: '#999999', marginTop: 2 },
  rowAction: { paddingVertical: 4, paddingHorizontal: 4 },
  rowActionTextDanger: { fontSize: 12, fontWeight: '700', color: '#C0392B' },
  formActions: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 10, marginTop: 16 },
  addButton: { backgroundColor: '#111111', borderRadius: 10, paddingHorizontal: 18, paddingVertical: 12, alignItems: 'center', justifyContent: 'center' },
  addButtonText: { color: '#FFFFFF', fontWeight: '800', fontSize: 13 },
  buttonDisabled: { backgroundColor: '#CCCCCC' },
});
```
(This is `staff-panel.tsx`'s exact `RolesSection`/`RoleEditorModal` bodies and `modalStyles`, unchanged — only `StaffPanel`→`RolesPanel`'s title/props/body and the top-level `styles` object (dropping the now-unused `chipRow` rule) changed.)

- [ ] **Step 2: Delete the old file**

```bash
git rm src/components/settings/panels/staff-panel.tsx
```

- [ ] **Step 3: Rename the nav id in `src/components/settings/settings-sidebar.tsx`**

Replace:
```ts
export type SettingsNavId =
  | 'profile'
  | 'security'
  | 'notifications'
  | 'store'
  | 'staff'
  | 'receipt'
  | 'catalog'
  | 'inventory'
  | 'promotions'
  | 'payments'
  | 'tax'
  | 'cashiers';
```
with:
```ts
export type SettingsNavId =
  | 'profile'
  | 'security'
  | 'notifications'
  | 'store'
  | 'roles'
  | 'receipt'
  | 'catalog'
  | 'inventory'
  | 'promotions'
  | 'payments'
  | 'tax'
  | 'cashiers';
```
Replace the `'staff'` nav item under the `'Store'` group:
```ts
      { id: 'staff', label: 'Staff and roles', icon: 'people-outline', permission: 'staff.manage' },
```
with:
```ts
      { id: 'roles', label: 'Roles', icon: 'shield-checkmark-outline', permission: 'staff.manage' },
```

- [ ] **Step 4: Update `src/app/(admin)/settings.tsx`**

Replace the import:
```ts
import { StaffPanel } from '@/components/settings/panels/staff-panel';
```
with:
```ts
import { RolesPanel } from '@/components/settings/panels/roles-panel';
```
Replace:
```ts
import { countStaffByRole, listRoles, listStaff } from '@/lib/staff';
```
with:
```ts
import { countStaffByRole, listRoles } from '@/lib/staff';
```
Replace the model import (drops `StaffMember`, no longer used in this file):
```ts
import type { Brand, Category, Currency, Product, Promotion, Role, StaffMember } from '@/types/models';
```
with:
```ts
import type { Brand, Category, Currency, Product, Promotion, Role } from '@/types/models';
```
Remove the `staff` state line:
```ts
  const [staff, setStaff] = useState<StaffMember[]>([]);
```
Replace the roles/staff fetch block inside `reload`:
```ts
    if (can('staff.manage')) {
      const [rolesResult, staffResult, roleUsageResult] = await Promise.allSettled([listRoles(shop.id), listStaff(shop.id), countStaffByRole(shop.id)]);
      if (rolesResult.status === 'fulfilled') setRoles(rolesResult.value);
      if (staffResult.status === 'fulfilled') setStaff(staffResult.value);
      if (roleUsageResult.status === 'fulfilled') setRoleUsage(roleUsageResult.value);
      results.push(rolesResult, staffResult, roleUsageResult);
    }
```
with:
```ts
    if (can('staff.manage')) {
      const [rolesResult, roleUsageResult] = await Promise.allSettled([listRoles(shop.id), countStaffByRole(shop.id)]);
      if (rolesResult.status === 'fulfilled') setRoles(rolesResult.value);
      if (roleUsageResult.status === 'fulfilled') setRoleUsage(roleUsageResult.value);
      results.push(rolesResult, roleUsageResult);
    }
```
Replace the `case 'staff':` branch in the `panel` switch:
```ts
      case 'staff':
        return loading ? (
          <Text style={styles.hint}>Loading…</Text>
        ) : (
          <StaffPanel shopId={shop.id} roles={roles} staff={staff} roleUsage={roleUsage} onChange={reload} />
        );
```
with:
```ts
      case 'roles':
        return loading ? (
          <Text style={styles.hint}>Loading…</Text>
        ) : (
          <RolesPanel shopId={shop.id} roles={roles} usage={roleUsage} onChange={reload} />
        );
```

- [ ] **Step 5: Type-check**

Run: `npx tsc --noEmit`. Expected: no errors.

- [ ] **Step 6: Manual verification**

Start the dev server, sign in as an owner, open Settings → confirm "Roles" appears where "Staff and roles" used to (under the Store group), and that creating/editing/deleting a role still works. Confirm there is no longer any staff roster UI inside Settings (Team tab doesn't exist until Task 12 — this is expected to be a temporary gap; the roster is reachable nowhere in the UI between this task and Task 12, only via direct Supabase access, which is fine for an in-progress branch).

- [ ] **Step 7: Commit**

```bash
git add src/components/settings/panels/roles-panel.tsx src/components/settings/settings-sidebar.tsx "src/app/(admin)/settings.tsx"
git rm src/components/settings/panels/staff-panel.tsx
git commit -m "refactor: split StaffPanel into roles-only RolesPanel, roster moves to Team tab"
```

---

### Task 9: New shared components — `Badge`, `NotesField`, `TwoPaneListDetail`, `openWhatsApp`, `customer-segments`, `permission-groups`

**Files:**
- Create: `src/components/badge.tsx`
- Create: `src/components/notes-field.tsx`
- Create: `src/components/two-pane-list-detail.tsx`
- Create: `src/lib/external-url.ts`
- Create: `src/lib/whatsapp.ts`
- Create: `src/lib/customer-segments.ts`
- Create: `src/lib/permission-groups.ts`
- Modify: `src/components/receipt-modal.tsx` (use the extracted `openExternalUrl`/`openWhatsApp` instead of its own inlined copy)

**Interfaces:**
- Consumes: Task 6's `Permission` type, Task 1's `Customer.notes`.
- Produces: `Badge`, `NotesField`, `TwoPaneListDetail`, `openWhatsApp`, `segmentForCustomer`, `CUSTOMER_SEGMENT_LABELS`, `PERMISSION_GROUPS`, `groupHasAny` — consumed by Task 10 (`people.tsx` shell), Task 11 (Customers tab), Task 12 (Team tab).

- [ ] **Step 1: Create `src/components/badge.tsx`**

```tsx
import { StyleSheet, Text, View } from 'react-native';

export type BadgeTone = 'default' | 'success' | 'warning' | 'danger';

// Static status pill -- VIP/Regular/New/At-risk on Customers rows, Active/
// On-leave on Team rows (Tasks 11, 12). Distinct from CategoryChip, which
// is an interactive/toggleable filter control, the wrong affordance here.
const TONE_COLORS: Record<BadgeTone, { background: string; text: string }> = {
  default: { background: '#EAEAEA', text: '#555555' },
  success: { background: '#E1F0E4', text: '#2E7D46' },
  warning: { background: '#F8EEDA', text: '#9A6B0C' },
  danger: { background: '#F7E1E2', text: '#B23B4E' },
};

export function Badge({ label, tone = 'default' }: { label: string; tone?: BadgeTone }) {
  const colors = TONE_COLORS[tone];
  return (
    <View style={[styles.badge, { backgroundColor: colors.background }]}>
      <Text style={[styles.text, { color: colors.text }]}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: { paddingHorizontal: 9, paddingVertical: 4, borderRadius: 999, alignSelf: 'flex-start' },
  text: { fontSize: 10.5, fontWeight: '700', letterSpacing: 0.2 },
});
```

- [ ] **Step 2: Create `src/components/notes-field.tsx`**

```tsx
import { useEffect, useState } from 'react';
import { StyleSheet, TextInput } from 'react-native';

// Multiline field that saves on blur, not on every keystroke -- no existing
// multiline text component in this codebase to reuse. Used by the Customer
// detail pane's Notes section (Task 11).
export function NotesField({
  value,
  onSave,
  placeholder = 'Add a note…',
}: {
  value: string | null;
  onSave: (value: string | null) => Promise<void>;
  placeholder?: string;
}) {
  const [draft, setDraft] = useState(value ?? '');

  useEffect(() => {
    setDraft(value ?? '');
  }, [value]);

  const commit = () => {
    const trimmed = draft.trim();
    if (trimmed === (value ?? '')) return;
    onSave(trimmed || null).catch(() => setDraft(value ?? ''));
  };

  return (
    <TextInput
      value={draft}
      onChangeText={setDraft}
      onBlur={commit}
      placeholder={placeholder}
      placeholderTextColor="#999999"
      multiline
      style={styles.input}
    />
  );
}

const styles = StyleSheet.create({
  input: { backgroundColor: '#F2F2F2', borderRadius: 10, padding: 11, minHeight: 64, color: '#111111', fontSize: 12.5, lineHeight: 18, textAlignVertical: 'top' },
});
```

- [ ] **Step 3: Create `src/components/two-pane-list-detail.tsx`**

```tsx
import type { ReactNode } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

// Shared list+detail shell for the People screen's two sub-tabs (Task 11
// Customers, Task 12 Team). Wide: list and detail render side by side, both
// always visible. Compact: stacked in a single scroll, detail below the
// list once something is selected -- the same responsive shape pos.tsx
// already uses (useWindowDimensions() + TABLET_BREAKPOINT). `compact` is
// computed by the caller and passed in rather than measured here, so this
// component owns no breakpoint logic of its own.
export function TwoPaneListDetail({ compact, list, detail }: { compact: boolean; list: ReactNode; detail: ReactNode }) {
  if (compact) {
    return (
      <ScrollView contentContainerStyle={styles.compactContent}>
        <View>{list}</View>
        <View style={styles.compactDetail}>{detail}</View>
      </ScrollView>
    );
  }
  return (
    <View style={styles.split}>
      <View style={styles.listPane}>{list}</View>
      <View style={styles.detailPane}>{detail}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  split: { flexDirection: 'row', gap: 18, flex: 1, minHeight: 0 },
  listPane: { width: 300, flexShrink: 0 },
  detailPane: { flex: 1, minWidth: 0 },
  compactContent: { paddingBottom: 24 },
  compactDetail: { marginTop: 14 },
});
```

- [ ] **Step 4: Create `src/lib/external-url.ts`**

Extracted verbatim from the local `openExternalUrl` function in `src/components/receipt-modal.tsx` (previously private to that file) — now shared between it and `src/lib/whatsapp.ts`:
```ts
import { Linking, Platform } from 'react-native';

// On web, `Linking.openURL` just calls `window.open(url, '_blank')` under
// the hood — and browsers (mobile ones especially, or with popups blocked)
// sometimes silently reuse the *current* tab for a blocked/failed
// `window.open` instead of a new one, navigating the whole app away to the
// mailto:/wa.me URL. A real `<a target="_blank" rel="noopener">` click is
// far more reliably respected as "open elsewhere, don't touch this tab" by
// browsers/popup blockers. Native has no such tab concept — `Linking.openURL`
// there goes through the OS bridge correctly.
export function openExternalUrl(url: string): void {
  if (Platform.OS !== 'web') {
    Linking.openURL(url).catch(() => {});
    return;
  }
  // @ts-ignore — web-only DOM APIs.
  const a = document.createElement('a');
  a.href = url;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  // @ts-ignore
  document.body.appendChild(a);
  a.click();
  a.remove();
}
```

- [ ] **Step 5: Create `src/lib/whatsapp.ts`**

```ts
import { openExternalUrl } from '@/lib/external-url';

export function openWhatsApp(phone: string, text?: string): void {
  const digits = phone.replace(/\D/g, '');
  const query = text ? `?text=${encodeURIComponent(text)}` : '';
  openExternalUrl(`https://wa.me/${digits}${query}`);
}
```

- [ ] **Step 6: Update `src/components/receipt-modal.tsx` to use the extracted helpers**

Delete the local `openExternalUrl` function entirely (it currently sits right before `export function ReceiptModal`):
```ts
function openExternalUrl(url: string) {
  if (Platform.OS !== 'web') {
    Linking.openURL(url).catch(() => {});
    return;
  }
  // @ts-ignore — web-only DOM APIs.
  const a = document.createElement('a');
  a.href = url;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  // @ts-ignore
  document.body.appendChild(a);
  a.click();
  a.remove();
}
```
Add `import { openExternalUrl } from '@/lib/external-url';` and `import { openWhatsApp } from '@/lib/whatsapp';` to the file's import block. `mailtoFallback` (unchanged, still calls `openExternalUrl` — now the imported one, same behavior) means the `Linking`/`Platform` imports from `'react-native'` may now be partly or fully unused in this file if they had no other call site — check with `npx eslint` (Step 8) and drop whichever of the two is no longer referenced elsewhere in the file (`Platform.OS === 'web'` is used elsewhere for the print/share logic, so `Platform` almost certainly stays; `Linking` is more likely to become unused since `openExternalUrl` was its only call site here).

Replace the auto-send effect's inline wa.me call:
```ts
    if (autoSendWhatsApp && receipt.customer.phone) {
      const digits = receipt.customer.phone.replace(/\D/g, '');
      openExternalUrl(`https://wa.me/${digits}?text=${encodeURIComponent(buildReceiptText(receipt))}`);
    }
```
with:
```ts
    if (autoSendWhatsApp && receipt.customer.phone) {
      openWhatsApp(receipt.customer.phone, buildReceiptText(receipt));
    }
```
Replace `shareWhatsApp`:
```ts
  const shareWhatsApp = () => {
    const digits = receipt.customer.phone?.replace(/\D/g, '') ?? '';
    openExternalUrl(`https://wa.me/${digits}?text=${encodeURIComponent(buildReceiptText(receipt))}`);
  };
```
with:
```ts
  const shareWhatsApp = () => {
    openWhatsApp(receipt.customer.phone ?? '', buildReceiptText(receipt));
  };
```

- [ ] **Step 7: Create `src/lib/customer-segments.ts`**

```ts
import type { Customer } from '@/types/models';

export type CustomerSegment = 'vip' | 'at-risk' | 'new' | 'regular';

const NEW_CUSTOMER_WINDOW_DAYS = 30;

// Pure client-side derivation -- no schema field for "status"/"segment"
// exists (Global Constraint #1). VIP/at-risk come from the existing
// free-text tags field; New/Regular fall out of account age. Shared by the
// Customers filter chips and each row's Badge (Task 11).
export function segmentForCustomer(customer: Pick<Customer, 'tags' | 'createdAt'>): CustomerSegment {
  const tags = customer.tags.map((t) => t.toLowerCase());
  if (tags.includes('vip')) return 'vip';
  if (tags.includes('at risk') || tags.includes('at-risk')) return 'at-risk';
  const ageMs = Date.now() - new Date(customer.createdAt).getTime();
  if (ageMs < NEW_CUSTOMER_WINDOW_DAYS * 24 * 60 * 60 * 1000) return 'new';
  return 'regular';
}

export const CUSTOMER_SEGMENT_LABELS: Record<CustomerSegment, string> = {
  vip: 'VIP',
  regular: 'Regular',
  new: 'New',
  'at-risk': 'At risk',
};
```

- [ ] **Step 8: Create `src/lib/permission-groups.ts`**

```ts
import type { Permission } from '@/lib/permissions';

// Groups the permission catalog into the 4 buckets the Team detail pane's
// read-only Access & permissions grid shows (Task 12) -- purely a display
// grouping, not a data-model concept.
export const PERMISSION_GROUPS: { label: string; permissions: Permission[] }[] = [
  { label: 'POS', permissions: ['pos.access'] },
  { label: 'Inventory', permissions: ['inventory.view', 'inventory.edit'] },
  {
    label: 'People',
    permissions: ['customers.view', 'customers.edit', 'staff.manage', 'people.timeoff.approve', 'people.payroll.manage', 'people.timesheet.view'],
  },
  { label: 'Accounting', permissions: ['sales.view', 'sales.edit', 'sales.refund', 'dashboard.view', 'settings.access'] },
];

export function groupHasAny(permissions: readonly string[], group: { permissions: Permission[] }): boolean {
  return group.permissions.some((p) => permissions.includes(p));
}
```

- [ ] **Step 9: Type-check and lint**

Run: `npx tsc --noEmit` and `npx eslint src/components/receipt-modal.tsx`.
Expected: no errors; the lint pass is specifically to catch an unused `Linking` import per Step 6's note.

- [ ] **Step 10: Commit**

```bash
git add src/components/badge.tsx src/components/notes-field.tsx src/components/two-pane-list-detail.tsx \
  src/lib/external-url.ts src/lib/whatsapp.ts src/lib/customer-segments.ts src/lib/permission-groups.ts \
  src/components/receipt-modal.tsx
git commit -m "feat: add Badge/NotesField/TwoPaneListDetail, extract openWhatsApp, add customer-segments/permission-groups"
```

---

### Task 10: Routing shell — `people.tsx` + `me.tsx` skeletons, nav wiring, `me.png` icon

**Files:**
- Rename: `src/app/(admin)/(tabs)/customers.tsx` → `src/app/(admin)/(tabs)/people.tsx` (skeleton only — placeholder sub-tab bodies; Tasks 11/12 replace them)
- Create: `src/app/(admin)/(tabs)/me.tsx` (skeleton only — Task 13 replaces the body)
- Create: `assets/images/tabIcons/me.png`, `assets/images/tabIcons/me@2x.png`, `assets/images/tabIcons/me@3x.png`
- Modify: `src/components/admin-tabs.tsx` (native `NativeTabs`, phone)
- Modify: `src/components/admin-tabs.web.tsx` (mobile-web bottom nav)
- Modify: `src/components/admin-sidebar.tsx` (shared wide sidebar — tablet native + desktop web)

**Interfaces:**
- Consumes: Task 6's `canAny`/`myMembership`.
- Produces: the `/people` and `/me` routes (bodies are placeholders), full nav visibility wiring for both — consumed by Task 11 (fills in `CustomersTab`), Task 12 (fills in `TeamTab`), Task 13 (fills in `MeScreen`'s body).

This task is deliberately thin: get the segmented-control shell, both new routes, and every nav surface's visibility rules verified correct **before** building real content, since a permission-matrix bug here would otherwise be masked by whichever sub-tab happens to render first.

- [ ] **Step 1: Generate `me.png` icon assets**

Mirrors the exact generation approach already used for `customers.png` (a flat black silhouette on transparent, at 24/48/72px) — a person bust inside a thin circle ring, so it reads as "your own profile" and stays visually distinct from the plain-bust `customers.png` now reused for the People tab:

```bash
python3 - <<'EOF'
from PIL import Image, ImageDraw

def draw_me_icon(size):
    img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    stroke = max(1, round(size * 0.09))
    margin = size * 0.06
    d.ellipse([margin, margin, size - margin, size - margin], outline=(17, 17, 17, 255), width=stroke)
    head_r = size * 0.13
    cx = size / 2
    head_cy = size * 0.38
    d.ellipse([cx - head_r, head_cy - head_r, cx + head_r, head_cy + head_r], fill=(17, 17, 17, 255))
    body_w = size * 0.46
    body_top = size * 0.56
    body_bottom = size * 0.80
    d.rounded_rectangle([cx - body_w / 2, body_top, cx + body_w / 2, body_bottom + body_w / 2], radius=body_w / 2, fill=(17, 17, 17, 255))
    d.rectangle([0, body_bottom, size, size], fill=(0, 0, 0, 0))
    return img

for suffix, size in [('', 24), ('@2x', 48), ('@3x', 72)]:
    draw_me_icon(size).save(f'assets/images/tabIcons/me{suffix}.png')
    print(f'wrote me{suffix}.png at {size}x{size}')
EOF
```
Verify: `sips -g pixelWidth -g pixelHeight assets/images/tabIcons/me.png assets/images/tabIcons/me@2x.png assets/images/tabIcons/me@3x.png` reports `24x24`, `48x48`, `72x72`.

- [ ] **Step 2: Rename `customers.tsx` to `people.tsx` with a placeholder shell**

```bash
git mv "src/app/(admin)/(tabs)/customers.tsx" "src/app/(admin)/(tabs)/people.tsx"
```
Replace the entire file content with:
```tsx
import { useState } from 'react';
import { StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { SegmentedControl } from '@/components/segmented-control';
import { TABLET_BREAKPOINT } from '@/constants/layout';
import { useAuth } from '@/hooks/use-auth';

type PeopleTab = 'customers' | 'team';

const TEAM_PERMISSIONS = ['staff.manage', 'people.timeoff.approve', 'people.payroll.manage', 'people.timesheet.view'] as const;

export default function PeopleScreen() {
  const { can, canAny } = useAuth();
  const { width } = useWindowDimensions();
  const compact = width < TABLET_BREAKPOINT;
  const canSeeCustomers = can('customers.view');
  const canSeeTeam = canAny([...TEAM_PERMISSIONS]);
  const [tab, setTab] = useState<PeopleTab>(canSeeCustomers ? 'customers' : 'team');

  const options = [
    ...(canSeeCustomers ? [{ key: 'customers' as const, label: 'Customers' }] : []),
    ...(canSeeTeam ? [{ key: 'team' as const, label: 'Team' }] : []),
  ];

  return (
    <SafeAreaView edges={['left', 'right', 'bottom']} style={styles.safeArea}>
      <View style={styles.header}>
        <Text style={styles.title}>People</Text>
        {options.length > 1 && <SegmentedControl options={options} value={tab} onChange={setTab} />}
      </View>
      <View style={styles.body}>
        {tab === 'customers' && canSeeCustomers ? <CustomersTab compact={compact} /> : null}
        {tab === 'team' && canSeeTeam ? <TeamTab compact={compact} /> : null}
      </View>
    </SafeAreaView>
  );
}

// Placeholder bodies -- Task 11 replaces CustomersTab (list+detail, filter
// chips, notes, purchase history) and Task 12 replaces TeamTab (roster
// list+detail, payroll, shifts, access grid, time-off approvals). Kept as
// separate named components here so those tasks swap a function body
// rather than restructuring this shell.
function CustomersTab({ compact }: { compact: boolean }) {
  return <Text style={styles.placeholder}>Customers — coming in Task 11.</Text>;
}
function TeamTab({ compact }: { compact: boolean }) {
  return <Text style={styles.placeholder}>Team — coming in Task 12.</Text>;
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: '#FFFFFF' },
  header: { paddingHorizontal: 24, paddingTop: 24 },
  title: { color: '#111111', fontSize: 24, fontWeight: '800', letterSpacing: -0.5, marginBottom: 14 },
  body: { flex: 1, paddingHorizontal: 24, paddingBottom: 24 },
  placeholder: { color: '#999999', fontSize: 13 },
});
```

- [ ] **Step 3: Create `src/app/(admin)/(tabs)/me.tsx` skeleton**

```tsx
import { StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

// Self-service HR -- Task 13 replaces this body with the clock in/out
// widget, recent shifts, time-off request+history, and pay display. This
// skeleton exists so the routing/nav/permission-matrix wiring in Task 10
// can be verified end-to-end before that content lands. Route-level access
// is deliberately NOT gated by a Permission -- see (admin)/_layout.tsx
// (Task 7) and src/lib/permissions.ts's ROUTE_PERMISSIONS comment (Task 6):
// any active shop_members row (or the admin) can reach this tab.
export default function MeScreen() {
  return (
    <SafeAreaView edges={['left', 'right', 'bottom']} style={styles.safeArea}>
      <View style={styles.header}>
        <Text style={styles.title}>Me</Text>
      </View>
      <Text style={styles.placeholder}>Self-service HR — coming in Task 13.</Text>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: '#FFFFFF' },
  header: { paddingHorizontal: 24, paddingTop: 24 },
  title: { color: '#111111', fontSize: 24, fontWeight: '800', letterSpacing: -0.5 },
  placeholder: { paddingHorizontal: 24, paddingTop: 14, color: '#999999', fontSize: 13 },
});
```

- [ ] **Step 4: Update `src/components/admin-tabs.tsx` (native, phone)**

Replace the destructure:
```tsx
  const { shop, refreshShop, can } = useAuth();
```
with:
```tsx
  const { shop, refreshShop, can, canAny, myMembership, profile } = useAuth();
```
Replace the `customers` and `sales` triggers:
```tsx
          <NativeTabs.Trigger name="customers" hidden={!can('customers.view')}>
            <NativeTabs.Trigger.Label>Customers</NativeTabs.Trigger.Label>
            <NativeTabs.Trigger.Icon src={require('@/assets/images/tabIcons/customers.png')} />
          </NativeTabs.Trigger>
          <NativeTabs.Trigger name="sales" hidden={!can('sales.view')}>
            <NativeTabs.Trigger.Label>Sales</NativeTabs.Trigger.Label>
            <NativeTabs.Trigger.Icon src={require('@/assets/images/tabIcons/chart.png')} />
          </NativeTabs.Trigger>
        </NativeTabs>
```
with:
```tsx
          <NativeTabs.Trigger name="people" hidden={!canAny(['customers.view', 'staff.manage', 'people.timeoff.approve', 'people.payroll.manage', 'people.timesheet.view'])}>
            <NativeTabs.Trigger.Label>People</NativeTabs.Trigger.Label>
            <NativeTabs.Trigger.Icon src={require('@/assets/images/tabIcons/customers.png')} />
          </NativeTabs.Trigger>
          <NativeTabs.Trigger name="sales" hidden={!can('sales.view')}>
            <NativeTabs.Trigger.Label>Sales</NativeTabs.Trigger.Label>
            <NativeTabs.Trigger.Icon src={require('@/assets/images/tabIcons/chart.png')} />
          </NativeTabs.Trigger>
          <NativeTabs.Trigger name="me" hidden={!(profile?.role === 'admin' || Boolean(myMembership?.active))}>
            <NativeTabs.Trigger.Label>Me</NativeTabs.Trigger.Label>
            <NativeTabs.Trigger.Icon src={require('@/assets/images/tabIcons/me.png')} />
          </NativeTabs.Trigger>
        </NativeTabs>
```

- [ ] **Step 5: Update `src/components/admin-sidebar.tsx` (shared wide sidebar)**

Replace the `navItems` definition and its type — currently:
```tsx
const navItems = [
  { href: '/dashboard', label: 'Dashboard', permission: 'dashboard.view', icon: require('@/assets/images/tabIcons/home.png') },
  { href: '/pos', label: 'POS', permission: 'pos.access', icon: require('@/assets/images/tabIcons/cart.png') },
  { href: '/inventory', label: 'Inventory', permission: 'inventory.view', icon: require('@/assets/images/tabIcons/grid.png') },
  { href: '/customers', label: 'Customers', permission: 'customers.view', icon: require('@/assets/images/tabIcons/customers.png') },
  { href: '/sales', label: 'Sales', permission: 'sales.view', icon: require('@/assets/images/tabIcons/chart.png') },
] as const satisfies readonly { href: string; label: string; permission: Permission; icon: unknown }[];

type NavItem = (typeof navItems)[number];
```
with:
```tsx
// One item's visibility can now depend on more than a single Permission
// (/people needs any of several) or on membership rather than a Permission
// at all (/me) -- isVisible replaces the old flat `permission` field so
// every item's rule is expressed the same way.
type NavVisibility = { can: (p: Permission) => boolean; canAny: (p: Permission[]) => boolean; isAdmin: boolean; myMembership: StaffMember | null };

const navItems = [
  { href: '/dashboard', label: 'Dashboard', icon: require('@/assets/images/tabIcons/home.png'), isVisible: (ctx: NavVisibility) => ctx.can('dashboard.view') },
  { href: '/pos', label: 'POS', icon: require('@/assets/images/tabIcons/cart.png'), isVisible: (ctx: NavVisibility) => ctx.can('pos.access') },
  { href: '/inventory', label: 'Inventory', icon: require('@/assets/images/tabIcons/grid.png'), isVisible: (ctx: NavVisibility) => ctx.can('inventory.view') },
  {
    href: '/people',
    label: 'People',
    icon: require('@/assets/images/tabIcons/customers.png'),
    isVisible: (ctx: NavVisibility) =>
      ctx.canAny(['customers.view', 'staff.manage', 'people.timeoff.approve', 'people.payroll.manage', 'people.timesheet.view']),
  },
  { href: '/sales', label: 'Sales', icon: require('@/assets/images/tabIcons/chart.png'), isVisible: (ctx: NavVisibility) => ctx.can('sales.view') },
  {
    href: '/me',
    label: 'Me',
    icon: require('@/assets/images/tabIcons/me.png'),
    isVisible: (ctx: NavVisibility) => ctx.isAdmin || Boolean(ctx.myMembership?.active),
  },
] as const satisfies readonly { href: string; label: string; icon: unknown; isVisible: (ctx: NavVisibility) => boolean }[];

type NavItem = (typeof navItems)[number];
```
Add `import type { StaffMember } from '@/types/models';` to the top import block.

`SidebarNavItem` is unchanged (still only reads `item.icon`/`item.href`/`item.label`).

Replace the destructure and filter inside `AdminSidebar`:
```tsx
  const { shop, refreshShop, can } = useAuth();
```
with:
```tsx
  const { shop, refreshShop, can, canAny, myMembership, profile } = useAuth();
```
```tsx
  const visibleNavItems = navItems.filter((item) => can(item.permission));
```
with:
```tsx
  const visibleNavItems = navItems.filter((item) => item.isVisible({ can, canAny, isAdmin: profile?.role === 'admin', myMembership }));
```

- [ ] **Step 6: Update `src/components/admin-tabs.web.tsx` (narrow/mobile-web bottom nav)**

Same treatment as Step 5, applied to this file's own separate `navItems` (emoji icons, narrow-only). Replace:
```tsx
const navItems = [
  { href: '/dashboard', label: 'Dashboard', permission: 'dashboard.view', icon: '🏠' },
  { href: '/pos', label: 'POS', permission: 'pos.access', icon: '🛒' },
  { href: '/inventory', label: 'Inventory', permission: 'inventory.view', icon: '▦' },
  { href: '/customers', label: 'Customers', permission: 'customers.view', icon: '👥' },
  { href: '/sales', label: 'Sales', permission: 'sales.view', icon: '📈' },
] as const satisfies readonly { href: string; label: string; permission: Permission; icon: string }[];
```
with:
```tsx
type NavVisibility = { can: (p: Permission) => boolean; canAny: (p: Permission[]) => boolean; isAdmin: boolean; myMembership: StaffMember | null };

const navItems = [
  { href: '/dashboard', label: 'Dashboard', icon: '🏠', isVisible: (ctx: NavVisibility) => ctx.can('dashboard.view') },
  { href: '/pos', label: 'POS', icon: '🛒', isVisible: (ctx: NavVisibility) => ctx.can('pos.access') },
  { href: '/inventory', label: 'Inventory', icon: '▦', isVisible: (ctx: NavVisibility) => ctx.can('inventory.view') },
  {
    href: '/people',
    label: 'People',
    icon: '👥',
    isVisible: (ctx: NavVisibility) =>
      ctx.canAny(['customers.view', 'staff.manage', 'people.timeoff.approve', 'people.payroll.manage', 'people.timesheet.view']),
  },
  { href: '/sales', label: 'Sales', icon: '📈', isVisible: (ctx: NavVisibility) => ctx.can('sales.view') },
  { href: '/me', label: 'Me', icon: '🙋', isVisible: (ctx: NavVisibility) => ctx.isAdmin || Boolean(ctx.myMembership?.active) },
] as const satisfies readonly { href: string; label: string; icon: string; isVisible: (ctx: NavVisibility) => boolean }[];
```
Add `import type { StaffMember } from '@/types/models';` to the top import block.

Replace the destructure and filter inside `AdminTabs`:
```tsx
  const { shop, refreshShop, can } = useAuth();
```
with:
```tsx
  const { shop, refreshShop, can, canAny, myMembership, profile } = useAuth();
```
```tsx
  const visibleNavItems = navItems.filter((item) => can(item.permission));
```
with:
```tsx
  const visibleNavItems = navItems.filter((item) => item.isVisible({ can, canAny, isAdmin: profile?.role === 'admin', myMembership }));
```

- [ ] **Step 7: Type-check**

Run: `npx tsc --noEmit`. Expected: no errors — this should also clear any remaining nav-related errors carried over from Task 6/7's type-check steps.

- [ ] **Step 8: Manual permission-matrix verification**

Run `npx expo start` (also regenerates `.expo/types/router.d.ts` for the new `people`/`me` routes — see Global Constraints) and spot-check, on both a phone-width and tablet/desktop-width viewport:
- **Owner**: sees People and Me tabs; People shows both Customers and Team segments (Team segment still shows its Task-12 placeholder for now).
- **Cashier-only role** (`pos.access`, `inventory.view`): does **not** see the People tab at all (no `customers.view` or People-manager permission); **does** see the Me tab and can open it.
- **A role with only `customers.view`**: sees People with only the Customers segment (no segmented control shown at all if that's the only option — confirm `options.length > 1` correctly hides the switcher).
- **A role with only `people.timesheet.view`**: sees People with only the Team segment.
- **A role with zero permissions but active membership**: lands on `/me` (via `(admin)/_layout.tsx`'s new fallback from Task 7) instead of the old `NoAccessScreen`.
- **A disabled (inactive) staff member**: does not see the Me tab, and hitting `/me` directly redirects/falls through to `NoAccessScreen` (no landing, no membership).

- [ ] **Step 9: Commit**

```bash
git add "src/app/(admin)/(tabs)/people.tsx" "src/app/(admin)/(tabs)/me.tsx" \
  assets/images/tabIcons/me.png assets/images/tabIcons/me@2x.png assets/images/tabIcons/me@3x.png \
  src/components/admin-tabs.tsx src/components/admin-tabs.web.tsx src/components/admin-sidebar.tsx
git commit -m "feat: rename Customers tab to People, add Me self-service tab, wire nav visibility for both"
```

---

### Task 11: Customers tab full UI

**Files:**
- Modify: `src/app/(admin)/(tabs)/people.tsx` (replace `CustomersTab`'s placeholder body; add module-level `CUSTOMER_EXPORT_COLUMNS`, `CustomerDetailPane`, and a `tabStyles` StyleSheet)
- Modify: `src/components/customer-form.tsx` (add the `notes` field)

**Interfaces:**
- Consumes: Task 1 (`Customer.notes`), Task 2 (`listCustomerPurchases`, `getCustomersStatsBatch`, `CustomerPurchase`), Task 9 (`Badge`, `NotesField`, `TwoPaneListDetail`, `openWhatsApp`, `segmentForCustomer`, `CUSTOMER_SEGMENT_LABELS`).
- Produces: the fully working Customers sub-tab — nothing downstream depends on it (Task 12/13 are independent sub-tabs/screens).

- [ ] **Step 1: Replace `people.tsx`'s `CustomersTab` and add its supporting code**

Add these imports to `people.tsx` (alongside the ones from Task 10's skeleton):
```tsx
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, useWindowDimensions, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Badge } from '@/components/badge';
import { Card } from '@/components/card';
import { CategoryChip } from '@/components/category-chip';
import { CsvImportModal, type ImportEntityConfig } from '@/components/csv-import-modal';
import { CustomerModal } from '@/components/customer-modal';
import { ExportMenu } from '@/components/export-menu';
import { NotesField } from '@/components/notes-field';
import { SegmentedControl } from '@/components/segmented-control';
import { StatTile } from '@/components/stat-tile';
import { TwoPaneListDetail } from '@/components/two-pane-list-detail';
import { TABLET_BREAKPOINT } from '@/constants/layout';
import { useAuth } from '@/hooks/use-auth';
import type { CsvColumn } from '@/lib/csv';
import { formatCents } from '@/lib/currency';
import { CUSTOMER_SEGMENT_LABELS, segmentForCustomer, type CustomerSegment } from '@/lib/customer-segments';
import { createCustomer, getCustomerStats, getCustomersStatsBatch, listCustomerPurchases, listCustomers, updateCustomer } from '@/lib/customers';
import { CUSTOMERS_EXAMPLE_ROW, CUSTOMERS_TEMPLATE_COLUMNS, runCustomersImport } from '@/lib/customers-import';
import { openWhatsApp } from '@/lib/whatsapp';
import type { Customer, CustomerPurchase } from '@/types/models';
```
(`useState`, `StyleSheet`, `Text`, `useWindowDimensions`, `View`, `SafeAreaView`, `SegmentedControl`, `TABLET_BREAKPOINT`, `useAuth` already exist from Task 10 — dedupe rather than double-import.)

Add this module-level constant near the top of the file (same pattern the old `customers.tsx` used for `CUSTOMER_EXPORT_COLUMNS`):
```tsx
const CUSTOMER_EXPORT_COLUMNS: CsvColumn<Customer>[] = [
  { header: 'First Name', value: (c) => c.firstName },
  { header: 'Last Name', value: (c) => c.lastName ?? '' },
  { header: 'Email', value: (c) => c.email ?? '' },
  { header: 'Phone', value: (c) => c.phone ?? '' },
  { header: 'Street', value: (c) => c.street ?? '' },
  { header: 'City', value: (c) => c.city ?? '' },
  { header: 'Neighborhood', value: (c) => c.neighborhood ?? '' },
  { header: 'Tags', value: (c) => c.tags.join('; ') },
  { header: 'Notes', value: (c) => c.notes ?? '' },
];
```

Replace the placeholder:
```tsx
function CustomersTab({ compact }: { compact: boolean }) {
  return <Text style={styles.placeholder}>Customers — coming in Task 11.</Text>;
}
```
with:
```tsx
function CustomersTab({ compact }: { compact: boolean }) {
  const { shop, can } = useAuth();
  const canEdit = can('customers.edit');
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [rowStats, setRowStats] = useState<Map<string, { totalSpentCents: number; visitCount: number }>>(new Map());
  const [search, setSearch] = useState('');
  const [segment, setSegment] = useState<CustomerSegment | 'all'>('all');
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showAddModal, setShowAddModal] = useState(false);
  const [editingCustomer, setEditingCustomer] = useState<Customer | null>(null);
  const [showImportModal, setShowImportModal] = useState(false);

  const reload = useCallback(async () => {
    if (!shop) return;
    setLoading(true);
    const [list, stats] = await Promise.all([listCustomers(shop.id), getCustomersStatsBatch(shop.id)]);
    setCustomers(list);
    setRowStats(stats);
    setLoading(false);
  }, [shop]);

  useEffect(() => {
    reload();
  }, [reload]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return customers.filter((c) => {
      if (segment !== 'all' && segmentForCustomer(c) !== segment) return false;
      if (!q) return true;
      return (
        c.firstName.toLowerCase().includes(q) ||
        (c.lastName ?? '').toLowerCase().includes(q) ||
        (c.phone ?? '').toLowerCase().includes(q) ||
        c.tags.some((tag) => tag.toLowerCase().includes(q))
      );
    });
  }, [customers, search, segment]);

  const selected = customers.find((c) => c.id === selectedId) ?? null;

  const segmentCounts = useMemo(() => {
    const counts: Record<CustomerSegment, number> = { vip: 0, regular: 0, new: 0, 'at-risk': 0 };
    for (const c of customers) counts[segmentForCustomer(c)]++;
    return counts;
  }, [customers]);

  const importConfig: ImportEntityConfig<Customer> | null = shop
    ? {
        title: 'customers',
        filenamePrefix: 'customers',
        templateColumns: CUSTOMERS_TEMPLATE_COLUMNS,
        exampleRows: [CUSTOMERS_EXAMPLE_ROW],
        run: (parsed) => runCustomersImport(shop.id, parsed),
      }
    : null;

  const list = (
    <>
      <View style={tabStyles.search}>
        <TextInput value={search} onChangeText={setSearch} placeholder="Search by name, phone, or tag" placeholderTextColor="#999999" style={tabStyles.searchInput} />
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={tabStyles.chips}>
        <CategoryChip label={`All · ${customers.length}`} active={segment === 'all'} onPress={() => setSegment('all')} />
        {(Object.keys(CUSTOMER_SEGMENT_LABELS) as CustomerSegment[]).map((key) => (
          <CategoryChip key={key} label={`${CUSTOMER_SEGMENT_LABELS[key]} · ${segmentCounts[key]}`} active={segment === key} onPress={() => setSegment(key)} />
        ))}
      </ScrollView>
      {loading ? (
        <Text style={tabStyles.empty}>Loading…</Text>
      ) : filtered.length === 0 ? (
        <Text style={tabStyles.empty}>No customers match.</Text>
      ) : (
        <Card style={tabStyles.list}>
          {filtered.map((customer) => {
            const stats = rowStats.get(customer.id);
            const segmentKey = segmentForCustomer(customer);
            return (
              <Pressable
                key={customer.id}
                onPress={() => setSelectedId(customer.id)}
                style={[tabStyles.row, customer.id === selectedId && tabStyles.rowSelected]}
              >
                <View style={tabStyles.rowMain}>
                  <Text style={tabStyles.rowName}>
                    {customer.firstName} {customer.lastName ?? ''}
                  </Text>
                  <Text style={tabStyles.rowSub}>
                    {stats ? `${stats.visitCount} order${stats.visitCount === 1 ? '' : 's'} · ${formatCents(stats.totalSpentCents)}` : 'No orders yet'}
                  </Text>
                </View>
                <Badge label={CUSTOMER_SEGMENT_LABELS[segmentKey]} tone={segmentKey === 'vip' ? 'danger' : segmentKey === 'at-risk' || segmentKey === 'new' ? 'warning' : 'default'} />
                {customer.phone && (
                  <Pressable onPress={() => openWhatsApp(customer.phone!)} style={tabStyles.waButton} hitSlop={6}>
                    <Text style={tabStyles.waIcon}>💬</Text>
                  </Pressable>
                )}
              </Pressable>
            );
          })}
        </Card>
      )}
    </>
  );

  const detail = selected ? (
    <CustomerDetailPane customer={selected} canEdit={canEdit} onEdit={() => setEditingCustomer(selected)} onChanged={reload} />
  ) : (
    <Card style={tabStyles.emptyDetail}>
      <Text style={tabStyles.empty}>Select a customer to see their details.</Text>
    </Card>
  );

  return (
    <View style={{ flex: 1 }}>
      <View style={tabStyles.tabHeader}>
        <Text style={tabStyles.subtitle}>{customers.length} customers</Text>
        <View style={tabStyles.headerActions}>
          <ExportMenu rows={filtered} columns={CUSTOMER_EXPORT_COLUMNS} title="Customers" subtitle={`${filtered.length} customers`} filenamePrefix="customers" />
          {canEdit && (
            <Pressable onPress={() => setShowImportModal(true)} style={tabStyles.actionButton}>
              <Text style={tabStyles.actionButtonText}>Import</Text>
            </Pressable>
          )}
          {canEdit && (
            <Pressable onPress={() => setShowAddModal(true)} style={tabStyles.actionButton}>
              <Text style={tabStyles.actionButtonText}>+ New</Text>
            </Pressable>
          )}
        </View>
      </View>
      <TwoPaneListDetail compact={compact} list={list} detail={detail} />
      {shop && canEdit && (
        <CustomerModal
          visible={showAddModal}
          onClose={() => setShowAddModal(false)}
          shopId={shop.id}
          onSubmit={async (input) => {
            await createCustomer(shop.id, input);
            await reload();
          }}
        />
      )}
      {shop && canEdit && (
        <CustomerModal
          visible={editingCustomer !== null}
          onClose={() => setEditingCustomer(null)}
          shopId={shop.id}
          initial={editingCustomer ?? undefined}
          onSubmit={async (input) => {
            if (editingCustomer) await updateCustomer(editingCustomer.id, input);
            await reload();
          }}
          onDeleted={reload}
        />
      )}
      {importConfig && <CsvImportModal visible={showImportModal} onClose={() => setShowImportModal(false)} config={importConfig} onImported={reload} />}
    </View>
  );
}

function CustomerDetailPane({
  customer,
  canEdit,
  onEdit,
  onChanged,
}: {
  customer: Customer;
  canEdit: boolean;
  onEdit: () => void;
  onChanged: () => Promise<void>;
}) {
  const [stats, setStats] = useState<{ totalSpentCents: number; visitCount: number; lastPurchaseAt: string | null } | null>(null);
  const [purchases, setPurchases] = useState<CustomerPurchase[]>([]);

  useEffect(() => {
    getCustomerStats(customer.id).then(setStats).catch(() => setStats(null));
    listCustomerPurchases(customer.id).then(setPurchases).catch(() => setPurchases([]));
  }, [customer.id]);

  const segment = segmentForCustomer(customer);
  const isVip = segment === 'vip';

  const toggleVip = async () => {
    const nextTags = isVip ? customer.tags.filter((t) => t.toLowerCase() !== 'vip') : [...customer.tags, 'vip'];
    await updateCustomer(customer.id, { tags: nextTags });
    await onChanged();
  };

  return (
    <Card style={tabStyles.detailCard}>
      <View style={tabStyles.detHead}>
        <Text style={tabStyles.detName}>
          {customer.firstName} {customer.lastName ?? ''}
        </Text>
        <Badge label={CUSTOMER_SEGMENT_LABELS[segment]} tone={segment === 'vip' ? 'danger' : 'default'} />
      </View>
      {customer.phone && <Text style={tabStyles.detPhone}>{customer.phone}</Text>}
      <View style={tabStyles.tiles}>
        <StatTile value={stats ? formatCents(stats.totalSpentCents) : '—'} label="Lifetime spend" />
        <StatTile value={stats ? String(stats.visitCount) : '—'} label="Orders" />
        <StatTile value={stats?.lastPurchaseAt ? new Date(stats.lastPurchaseAt).toLocaleDateString() : '—'} label="Last purchase" />
      </View>
      <View style={tabStyles.actions}>
        {customer.phone && (
          <Pressable onPress={() => openWhatsApp(customer.phone!)} style={tabStyles.actionButton}>
            <Text style={tabStyles.actionButtonText}>WhatsApp</Text>
          </Pressable>
        )}
        {canEdit && (
          <Pressable onPress={onEdit} style={tabStyles.actionButtonGhost}>
            <Text style={tabStyles.actionButtonGhostText}>Edit</Text>
          </Pressable>
        )}
        {canEdit && (
          <Pressable onPress={toggleVip} style={tabStyles.actionButtonGhost}>
            <Text style={tabStyles.actionButtonGhostText}>{isVip ? 'Remove VIP' : 'Mark VIP'}</Text>
          </Pressable>
        )}
      </View>
      <View style={tabStyles.section}>
        <Text style={tabStyles.sectionTitle}>NOTES</Text>
        <NotesField value={customer.notes} onSave={async (notes) => { await updateCustomer(customer.id, { notes }); await onChanged(); }} />
      </View>
      <View style={tabStyles.section}>
        <Text style={tabStyles.sectionTitle}>PURCHASE HISTORY</Text>
        {purchases.length === 0 ? (
          <Text style={tabStyles.empty}>No purchases yet.</Text>
        ) : (
          purchases.map((p) => (
            <View key={p.saleItemId} style={tabStyles.histRow}>
              <View style={{ flex: 1 }}>
                <Text style={tabStyles.histTitle}>
                  {p.productName}
                  {p.quantity > 1 ? ` ×${p.quantity}` : ''}
                </Text>
                <Text style={tabStyles.histMeta}>
                  {new Date(p.createdAt).toLocaleDateString()} · {p.paymentMethod}
                </Text>
              </View>
              <Text style={tabStyles.histAmount}>{formatCents(p.lineTotalCents)}</Text>
            </View>
          ))
        )}
      </View>
    </Card>
  );
}
```

Add a `tabStyles` `StyleSheet` (shared by Task 12's `TeamTab` too — create it once here, Task 12 appends to it rather than creating a second sheet):
```tsx
const tabStyles = StyleSheet.create({
  tabHeader: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, marginBottom: 14 },
  subtitle: { color: '#999999', fontSize: 12 },
  headerActions: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, justifyContent: 'flex-end' },
  actionButton: { backgroundColor: '#111111', borderRadius: 10, paddingHorizontal: 12, paddingVertical: 9 },
  actionButtonText: { color: '#FFFFFF', fontWeight: '800', fontSize: 11 },
  actionButtonGhost: { backgroundColor: '#F2F2F2', borderRadius: 10, paddingHorizontal: 12, paddingVertical: 9 },
  actionButtonGhostText: { color: '#111111', fontWeight: '800', fontSize: 11 },
  search: { backgroundColor: '#F2F2F2', borderRadius: 10, height: 40, paddingHorizontal: 13, marginBottom: 10 },
  searchInput: { flex: 1, height: '100%', color: '#111111' },
  chips: { gap: 6, paddingBottom: 12 },
  list: { overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 12, paddingHorizontal: 13, borderBottomWidth: 1, borderBottomColor: '#ECECEC' },
  rowSelected: { backgroundColor: '#F7E1E2' },
  rowMain: { flex: 1, minWidth: 0 },
  rowName: { fontSize: 13.5, fontWeight: '700', color: '#111111' },
  rowSub: { fontSize: 11.5, color: '#999999', marginTop: 2 },
  waButton: { width: 28, height: 28, borderRadius: 8, backgroundColor: '#E1F0E4', alignItems: 'center', justifyContent: 'center' },
  waIcon: { fontSize: 13 },
  empty: { color: '#999999', fontSize: 13, textAlign: 'center', paddingVertical: 20 },
  emptyDetail: { padding: 24, alignItems: 'center' },
  detailCard: { padding: 18 },
  detHead: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 4 },
  detName: { fontSize: 17, fontWeight: '800', color: '#111111' },
  detPhone: { fontSize: 12.5, color: '#666666', marginBottom: 16 },
  tiles: { flexDirection: 'row', gap: 9, marginBottom: 16 },
  actions: { flexDirection: 'row', gap: 8, flexWrap: 'wrap', marginBottom: 18 },
  section: { marginBottom: 18 },
  sectionTitle: { fontSize: 10.5, fontWeight: '700', letterSpacing: 0.6, color: '#999999', marginBottom: 8 },
  histRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 9, borderBottomWidth: 1, borderBottomColor: '#ECECEC', gap: 10 },
  histTitle: { fontSize: 12.5, fontWeight: '600', color: '#111111' },
  histMeta: { fontSize: 11, color: '#999999', marginTop: 1 },
  histAmount: { fontSize: 12.5, fontWeight: '700', color: '#111111' },
});
```
- [ ] **Step 2: Add the `notes` field to `src/components/customer-form.tsx`**

Add state — after the existing `const [tagColors, ...]` line:
```tsx
  const [notes, setNotes] = useState(initial?.notes ?? '');
```
In `submit()`'s `onSubmit(...)` call, add `notes` after `tags`:
```tsx
      await onSubmit({
        firstName: firstName.trim(),
        lastName: lastName.trim() || null,
        email: email.trim() || null,
        phone: phone.trim() || null,
        street: street.trim() || null,
        city: city.trim() || null,
        neighborhood: neighborhood.trim() || null,
        tags: tagList,
        notes: notes.trim() || null,
      });
```
In the JSX, add a Notes field right after the `INTEREST TAGS` `Field` block and before `{error && ...}`:
```tsx
      <Field label="NOTES">
        <TextInput
          value={notes}
          onChangeText={setNotes}
          placeholder="Optional"
          placeholderTextColor="#999999"
          multiline
          style={[styles.input, styles.notesInput]}
        />
      </Field>
```
Add `notesInput: { minHeight: 64, textAlignVertical: 'top', paddingTop: 11 },` to the `styles` `StyleSheet` (any position is fine — e.g. right after the `input` rule).

- [ ] **Step 3: Type-check and lint**

Run: `npx tsc --noEmit` and `npx eslint "src/app/(admin)/(tabs)/people.tsx" src/components/customer-form.tsx`.
Expected: no errors.

- [ ] **Step 4: Manual verification**

Run the dev server. As a role with `customers.edit`:
- Search/filter by each segment chip; confirm counts match.
- Select a customer, confirm the 3 stat tiles, WhatsApp button (opens `wa.me` with the customer's number), Edit (opens `CustomerModal`), and Mark/Remove VIP (toggles the `vip` tag and the badge/chip counts) all work.
- Type in Notes, blur the field, reload the page, confirm it persisted.
- Complete a sale against this customer from POS, return to their detail pane, confirm the new purchase appears in Purchase history and the stat tiles update.
- Confirm Export/Import still work exactly as before (now including the `Notes` column in the CSV).
As a role with only `customers.view`: confirm the list/detail render but Edit/Import/+New/Mark VIP/Notes editing are all hidden or disabled (Notes field itself has no permission gate today — flag this as a known gap if `customers.view`-only roles shouldn't be able to edit notes; the simplest fix if needed is wrapping `NotesField` in `{canEdit && (...)}`/showing static text otherwise, matching the Edit/VIP buttons' existing gating).

- [ ] **Step 5: Commit**

```bash
git add "src/app/(admin)/(tabs)/people.tsx" src/components/customer-form.tsx
git commit -m "feat: build out Customers tab (list, filters, detail pane, notes, purchase history)"
```

---

### Task 12: Team tab full UI

**Files:**
- Modify: `src/app/(admin)/(tabs)/people.tsx` (replace `TeamTab`'s placeholder body; add `TeamDetailPane`; append Team-specific rules to the shared `tabStyles`)
- Create: `src/components/team-add-modal.tsx`
- Create: `src/components/edit-pay-modal.tsx`
- Create: `src/components/time-off-approval-modal.tsx`

**Interfaces:**
- Consumes: Task 4 (`getMyMembership`/`updateStaffPay` — the latter used here), Task 5 (`listShopTimeEntries`, `sumDurationHours`, `listShopTimeOffRequests`, `decideTimeOffRequest`), Task 9 (`PERMISSION_GROUPS`, `groupHasAny`, `Badge`), existing `src/lib/staff.ts` (`listStaff`, `listRoles`, `updateStaffRole`, `setStaffActive`, `provisionStaff`).
- Produces: the fully working Team sub-tab, minus import/export (Task 14 adds that). Nothing else depends on this task.

**Note on scope**: this task deliberately does **not** wire up Import/Export for Team (unlike Customers in Task 11) — that's Task 14, kept separate so this task's own type-check stays clean without depending on a not-yet-created `staff-import.ts`. The Team tab's header only gets a "+ Add staff" button here.

- [ ] **Step 1: Replace `people.tsx`'s `TeamTab` and add its supporting code**

Add these imports to `people.tsx` (alongside Task 10/11's):
```tsx
import { Modal } from 'react-native';

import { EditPayModal } from '@/components/edit-pay-modal';
import { TeamAddModal } from '@/components/team-add-modal';
import { TimeOffApprovalModal } from '@/components/time-off-approval-modal';
import { groupHasAny, PERMISSION_GROUPS } from '@/lib/permission-groups';
import { listRoles, listStaff, provisionStaff, setStaffActive, updateStaffPay, updateStaffRole } from '@/lib/staff';
import { listShopTimeEntries, sumDurationHours } from '@/lib/time-entries';
import { decideTimeOffRequest, listShopTimeOffRequests } from '@/lib/time-off';
import type { Role, StaffMember, TimeEntry, TimeOffRequest } from '@/types/models';
```
(`Modal` from `react-native` is only needed if you choose to inline any modal here — with the three modals in their own files per Step 2-4 below, `people.tsx` itself doesn't need it; omit that import if unused. `provisionStaff` is imported here only because `TeamAddModal` needs it passed no differently than any other lib call — actually `TeamAddModal` imports it directly itself, see Step 2, so drop `provisionStaff` from this list too.)

Replace the placeholder:
```tsx
function TeamTab({ compact }: { compact: boolean }) {
  return <Text style={styles.placeholder}>Team — coming in Task 12.</Text>;
}
```
with:
```tsx
function TeamTab({ compact }: { compact: boolean }) {
  const { shop, can, canAny } = useAuth();
  const canManageRoster = can('staff.manage');
  const canManagePayroll = can('people.payroll.manage');
  const canViewHours = canAny(['people.timesheet.view', 'people.payroll.manage']);
  const canApproveTimeOff = can('people.timeoff.approve');

  const [staff, setStaff] = useState<StaffMember[]>([]);
  const [roles, setRoles] = useState<Role[]>([]);
  const [timeOff, setTimeOff] = useState<TimeOffRequest[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showAddModal, setShowAddModal] = useState(false);
  const [showApprovalList, setShowApprovalList] = useState(false);

  const reload = useCallback(async () => {
    if (!shop) return;
    setLoading(true);
    const [staffList, roleList, timeOffList] = await Promise.all([
      listStaff(shop.id),
      listRoles(shop.id),
      canApproveTimeOff ? listShopTimeOffRequests(shop.id) : Promise.resolve([]),
    ]);
    setStaff(staffList);
    setRoles(roleList);
    setTimeOff(timeOffList);
    setLoading(false);
  }, [shop, canApproveTimeOff]);

  useEffect(() => {
    reload();
  }, [reload]);

  const onLeaveMemberIds = useMemo(() => {
    const today = new Date().toISOString().slice(0, 10);
    const onLeave = new Set<string>();
    for (const r of timeOff) {
      if (r.status === 'approved' && r.startDate <= today && r.endDate >= today) onLeave.add(r.shopMemberId);
    }
    return onLeave;
  }, [timeOff]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return staff;
    return staff.filter((m) => (m.fullName ?? '').toLowerCase().includes(q) || m.roleName.toLowerCase().includes(q));
  }, [staff, search]);

  const selected = staff.find((m) => m.id === selectedId) ?? null;
  const pendingCount = timeOff.filter((r) => r.status === 'pending').length;

  const list = (
    <>
      <View style={tabStyles.search}>
        <TextInput value={search} onChangeText={setSearch} placeholder="Search by name or role" placeholderTextColor="#999999" style={tabStyles.searchInput} />
      </View>
      {canApproveTimeOff && (
        <Pressable onPress={() => setShowApprovalList(true)} style={tabStyles.pendingButton}>
          <Text style={tabStyles.pendingButtonText}>Time off requests</Text>
          {pendingCount > 0 && (
            <View style={tabStyles.pendingCount}>
              <Text style={tabStyles.pendingCountText}>{pendingCount} pending</Text>
            </View>
          )}
        </Pressable>
      )}
      {loading ? (
        <Text style={tabStyles.empty}>Loading…</Text>
      ) : filtered.length === 0 ? (
        <Text style={tabStyles.empty}>No team members match.</Text>
      ) : (
        <Card style={tabStyles.list}>
          {filtered.map((member) => {
            const onLeave = onLeaveMemberIds.has(member.id);
            return (
              <Pressable
                key={member.id}
                onPress={() => setSelectedId(member.id)}
                style={[tabStyles.row, member.id === selectedId && tabStyles.rowSelected]}
              >
                <View style={tabStyles.rowMain}>
                  <Text style={tabStyles.rowName}>{member.fullName ?? member.email ?? 'Staff member'}</Text>
                  <Text style={tabStyles.rowSub}>{member.roleName}</Text>
                </View>
                <Badge
                  label={!member.active ? 'Disabled' : onLeave ? 'On leave' : 'Active'}
                  tone={!member.active ? 'default' : onLeave ? 'warning' : 'success'}
                />
              </Pressable>
            );
          })}
        </Card>
      )}
    </>
  );

  const detail = selected ? (
    <TeamDetailPane
      member={selected}
      roles={roles}
      onLeave={onLeaveMemberIds.has(selected.id)}
      canManageRoster={canManageRoster}
      canManagePayroll={canManagePayroll}
      canViewHours={canViewHours}
      onChanged={reload}
    />
  ) : (
    <Card style={tabStyles.emptyDetail}>
      <Text style={tabStyles.empty}>Select a team member to see their details.</Text>
    </Card>
  );

  return (
    <View style={{ flex: 1 }}>
      <View style={tabStyles.tabHeader}>
        <Text style={tabStyles.subtitle}>{staff.length} on the team</Text>
        <View style={tabStyles.headerActions}>
          {canManageRoster && (
            <Pressable
              onPress={() => setShowAddModal(true)}
              disabled={roles.length === 0}
              style={[tabStyles.actionButton, roles.length === 0 && tabStyles.actionButtonDisabled]}
            >
              <Text style={tabStyles.actionButtonText}>+ Add staff</Text>
            </Pressable>
          )}
        </View>
      </View>
      <TwoPaneListDetail compact={compact} list={list} detail={detail} />
      {shop && canManageRoster && (
        <TeamAddModal visible={showAddModal} shopId={shop.id} roles={roles} onClose={() => setShowAddModal(false)} onChange={reload} />
      )}
      {canApproveTimeOff && (
        <TimeOffApprovalModal visible={showApprovalList} requests={timeOff} staff={staff} onClose={() => setShowApprovalList(false)} onChange={reload} />
      )}
    </View>
  );
}

function TeamDetailPane({
  member,
  roles,
  onLeave,
  canManageRoster,
  canManagePayroll,
  canViewHours,
  onChanged,
}: {
  member: StaffMember;
  roles: Role[];
  onLeave: boolean;
  canManageRoster: boolean;
  canManagePayroll: boolean;
  canViewHours: boolean;
  onChanged: () => Promise<void>;
}) {
  const { shop } = useAuth();
  const [entries, setEntries] = useState<TimeEntry[]>([]);
  const [changingRole, setChangingRole] = useState(false);
  const [editingPay, setEditingPay] = useState(false);

  const role = roles.find((r) => r.id === member.roleId);
  const permissions = role?.permissions ?? [];

  useEffect(() => {
    if (!shop || !canViewHours) {
      setEntries([]);
      return;
    }
    const since = new Date();
    since.setDate(1);
    since.setHours(0, 0, 0, 0);
    listShopTimeEntries(shop.id, { shopMemberId: member.id, sinceIso: since.toISOString() })
      .then(setEntries)
      .catch(() => setEntries([]));
  }, [shop, member.id, canViewHours]);

  const hoursThisPeriod = sumDurationHours(entries);

  return (
    <Card style={tabStyles.detailCard}>
      <View style={tabStyles.detHead}>
        <Text style={tabStyles.detName}>{member.fullName ?? member.email ?? 'Staff member'}</Text>
        <Badge label={!member.active ? 'Disabled' : onLeave ? 'On leave' : 'Active'} tone={!member.active ? 'default' : onLeave ? 'warning' : 'success'} />
      </View>
      <Text style={tabStyles.detPhone}>
        {member.roleName}
        {member.hireDate ? ` · joined ${new Date(member.hireDate).toLocaleDateString()}` : ''}
      </Text>

      <View style={tabStyles.tiles}>
        <StatTile value={member.hireDate ? new Date(member.hireDate).toLocaleDateString() : '—'} label="Hire date" />
        <StatTile value={member.payType ? member.payType[0].toUpperCase() + member.payType.slice(1) : '—'} label="Pay type" />
        <StatTile value={canViewHours ? `${hoursThisPeriod.toFixed(1)}h` : '—'} label="Hours this period" />
      </View>

      {canManageRoster && (
        <View style={tabStyles.actions}>
          <Pressable onPress={() => setChangingRole((v) => !v)} style={tabStyles.actionButtonGhost}>
            <Text style={tabStyles.actionButtonGhostText}>Change role</Text>
          </Pressable>
          <Pressable
            onPress={async () => {
              await setStaffActive(member.id, !member.active);
              await onChanged();
            }}
            style={tabStyles.actionButtonGhost}
          >
            <Text style={tabStyles.actionButtonGhostText}>{member.active ? 'Disable' : 'Enable'}</Text>
          </Pressable>
        </View>
      )}
      {changingRole && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={tabStyles.chips}>
          {roles.map((r) => (
            <CategoryChip
              key={r.id}
              label={r.name}
              active={r.id === member.roleId}
              onPress={async () => {
                await updateStaffRole(member.id, r.id);
                await onChanged();
                setChangingRole(false);
              }}
            />
          ))}
        </ScrollView>
      )}

      <View style={tabStyles.section}>
        <View style={tabStyles.sectionHeadRow}>
          <Text style={tabStyles.sectionTitle}>PAYROLL</Text>
          {canManagePayroll && (
            <Pressable onPress={() => setEditingPay(true)}>
              <Text style={tabStyles.sectionLink}>Edit</Text>
            </Pressable>
          )}
        </View>
        <Text style={tabStyles.payrollValue}>
          {member.payType && member.payRateCents != null
            ? `${formatCents(member.payRateCents)}${member.payType === 'hourly' ? ' / hour' : member.payType === 'salary' ? ' / year' : ''}`
            : 'Not set'}
        </Text>
      </View>

      {canViewHours && (
        <View style={tabStyles.section}>
          <Text style={tabStyles.sectionTitle}>RECENT SHIFTS</Text>
          {entries.length === 0 ? (
            <Text style={tabStyles.empty}>No shifts logged this period.</Text>
          ) : (
            entries.slice(0, 8).map((e) => (
              <View key={e.id} style={tabStyles.shiftRow}>
                <Text style={tabStyles.shiftDate}>
                  {new Date(e.clockIn).toLocaleDateString()} · {new Date(e.clockIn).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
                  {e.clockOut ? `–${new Date(e.clockOut).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : ' (on shift)'}
                </Text>
                <Text style={tabStyles.shiftDuration}>{e.clockOut ? `${sumDurationHours([e]).toFixed(1)}h` : '—'}</Text>
              </View>
            ))
          )}
        </View>
      )}

      <View style={tabStyles.section}>
        <Text style={tabStyles.sectionTitle}>ACCESS &amp; PERMISSIONS</Text>
        <View style={tabStyles.permGrid}>
          {PERMISSION_GROUPS.map((group) => {
            const granted = groupHasAny(permissions, group);
            return (
              <View key={group.label} style={tabStyles.permTile}>
                <View style={[tabStyles.permIcon, granted ? tabStyles.permIconOn : tabStyles.permIconOff]}>
                  <Text style={tabStyles.permIconText}>{granted ? '✓' : '🔒'}</Text>
                </View>
                <Text style={tabStyles.permLabel}>{group.label}</Text>
              </View>
            );
          })}
        </View>
      </View>

      <EditPayModal
        visible={editingPay}
        member={member}
        onClose={() => setEditingPay(false)}
        onSave={async (patch) => {
          await updateStaffPay(member.id, patch);
          await onChanged();
          setEditingPay(false);
        }}
      />
    </Card>
  );
}
```

Append these rules to the shared `tabStyles` `StyleSheet` created in Task 11 (Team-specific, in addition to what's already there):
```tsx
  actionButtonDisabled: { opacity: 0.5 },
  pendingButton: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: '#F2F2F2', borderRadius: 10, paddingHorizontal: 13, paddingVertical: 12, marginBottom: 10 },
  pendingButtonText: { fontSize: 12.5, fontWeight: '700', color: '#111111' },
  pendingCount: { backgroundColor: '#F8EEDA', borderRadius: 999, paddingHorizontal: 9, paddingVertical: 3 },
  pendingCountText: { fontSize: 11, fontWeight: '700', color: '#9A6B0C' },
  sectionHeadRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 },
  sectionLink: { fontSize: 11.5, fontWeight: '700', color: '#B23B4E' },
  payrollValue: { fontSize: 14, fontWeight: '700', color: '#111111' },
  shiftRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: '#ECECEC' },
  shiftDate: { fontSize: 12, color: '#666666' },
  shiftDuration: { fontSize: 12, fontWeight: '700', color: '#111111' },
  permGrid: { flexDirection: 'row', gap: 8 },
  permTile: { flex: 1, alignItems: 'center', gap: 6, backgroundColor: '#F7F7F5', borderRadius: 11, paddingVertical: 11 },
  permIcon: { width: 26, height: 26, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  permIconOn: { backgroundColor: '#E1F0E4' },
  permIconOff: { backgroundColor: '#EAEAEA' },
  permIconText: { fontSize: 12 },
  permLabel: { fontSize: 10.5, fontWeight: '600', color: '#666666' },
  errorText: { color: '#C0392B', fontSize: 12, fontWeight: '700', marginTop: 6 },
  reqRow: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: '#ECECEC' },
  reqRange: { fontSize: 12.5, fontWeight: '600', color: '#111111' },
  reqReason: { fontSize: 11, color: '#999999', marginTop: 1 },
  reqActions: { flexDirection: 'row', gap: 10 },
  reqApprove: { fontSize: 12, fontWeight: '700', color: '#2E7D46' },
  reqDeny: { fontSize: 12, fontWeight: '700', color: '#B23B4E' },
```
- [ ] **Step 2: Create `src/components/team-add-modal.tsx`**

Ported from the deleted `AddStaffModal` in `staff-panel.tsx` (Task 8) — logic unchanged (still calls `provisionStaff`), only the surrounding component name/file changes:
```tsx
import { useEffect, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { CategoryChip } from '@/components/category-chip';
import { provisionStaff } from '@/lib/staff';
import type { Role } from '@/types/models';

export function TeamAddModal({
  visible,
  shopId,
  roles,
  onClose,
  onChange,
}: {
  visible: boolean;
  shopId: string;
  roles: Role[];
  onClose: () => void;
  onChange: () => Promise<void>;
}) {
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [roleId, setRoleId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ email: string; temporaryPassword: string | null } | null>(null);

  useEffect(() => {
    if (visible) {
      setFullName('');
      setEmail('');
      setPassword('');
      setRoleId(roles[0]?.id ?? null);
      setError(null);
      setResult(null);
    }
  }, [visible, roles]);

  const submit = async () => {
    if (!fullName.trim() || !email.trim() || !roleId) return;
    setSaving(true);
    setError(null);
    try {
      const created = await provisionStaff({ shopId, fullName: fullName.trim(), email: email.trim(), password: password.trim() || undefined, roleId });
      await onChange();
      setResult({ email: created.email, temporaryPassword: created.temporaryPassword });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not add this staff member.');
    } finally {
      setSaving(false);
    }
  };

  if (!visible) return null;

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View style={styles.card}>
          <View style={styles.header}>
            <Text style={styles.title}>Add staff</Text>
            <View style={styles.headerActions}>
              {!result && (
                <Pressable
                  onPress={submit}
                  disabled={saving || !fullName.trim() || !email.trim() || !roleId}
                  style={[styles.addButton, (saving || !fullName.trim() || !email.trim() || !roleId) && styles.buttonDisabled]}
                >
                  <Text style={styles.addButtonText}>{saving ? 'Adding…' : 'Add staff'}</Text>
                </Pressable>
              )}
              <Pressable onPress={onClose} style={styles.close}>
                <Text style={styles.closeText}>Close</Text>
              </Pressable>
            </View>
          </View>
          <ScrollView style={styles.list}>
            {result ? (
              <View>
                <Text style={styles.rowLabel}>Account created for {result.email}</Text>
                {result.temporaryPassword && (
                  <>
                    <Text style={styles.hint}>Share this password with them now — it won&apos;t be shown again.</Text>
                    <View style={styles.readOnlyField}>
                      <Text selectable style={styles.readOnlyFieldText}>
                        {result.temporaryPassword}
                      </Text>
                    </View>
                  </>
                )}
                <Pressable onPress={onClose} style={[styles.addButton, { marginTop: 16, alignSelf: 'flex-start' }]}>
                  <Text style={styles.addButtonText}>Done</Text>
                </Pressable>
              </View>
            ) : (
              <>
                <Text style={styles.fieldLabel}>FULL NAME</Text>
                <TextInput value={fullName} onChangeText={setFullName} placeholder="Full name" placeholderTextColor="#999999" style={styles.input} />
                <Text style={[styles.fieldLabel, { marginTop: 10 }]}>EMAIL</Text>
                <TextInput
                  value={email}
                  onChangeText={setEmail}
                  placeholder="you@example.com"
                  placeholderTextColor="#999999"
                  autoCapitalize="none"
                  keyboardType="email-address"
                  style={styles.input}
                />
                <Text style={[styles.fieldLabel, { marginTop: 10 }]}>PASSWORD (leave blank to generate one)</Text>
                <TextInput value={password} onChangeText={setPassword} placeholder="At least 6 characters" placeholderTextColor="#999999" style={styles.input} />
                <Text style={[styles.fieldLabel, { marginTop: 10 }]}>ROLE</Text>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipRow}>
                  {roles.map((role) => (
                    <CategoryChip key={role.id} label={role.name} active={role.id === roleId} onPress={() => setRoleId(role.id)} />
                  ))}
                </ScrollView>
                {error && <Text style={styles.error}>{error}</Text>}
                <Pressable
                  onPress={submit}
                  disabled={saving || !fullName.trim() || !email.trim() || !roleId}
                  style={[
                    styles.addButton,
                    { marginTop: 16, alignSelf: 'flex-start' },
                    (saving || !fullName.trim() || !email.trim() || !roleId) && styles.buttonDisabled,
                  ]}
                >
                  <Text style={styles.addButtonText}>{saving ? 'Adding…' : 'Add staff'}</Text>
                </Pressable>
              </>
            )}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', alignItems: 'center', justifyContent: 'center', padding: 20 },
  card: { backgroundColor: '#FFFFFF', borderRadius: 18, padding: 20, width: '100%', maxWidth: 560, height: '80%', overflow: 'hidden' },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  title: { fontSize: 16, fontWeight: '800', color: '#111111' },
  close: { backgroundColor: '#111111', borderRadius: 10, paddingHorizontal: 18, paddingVertical: 12, alignItems: 'center', justifyContent: 'center' },
  closeText: { fontSize: 13, fontWeight: '800', color: '#FFFFFF' },
  list: { flex: 1 },
  hint: { fontSize: 12, color: '#9CA3AF', lineHeight: 17, marginTop: 8 },
  fieldLabel: { fontSize: 10, letterSpacing: 0.6, fontWeight: '800', color: '#999999', marginBottom: 6 },
  input: { backgroundColor: '#F2F2F2', borderRadius: 10, height: 42, paddingHorizontal: 12, color: '#111111' },
  chipRow: { gap: 8, paddingBottom: 11 },
  readOnlyField: { backgroundColor: '#F7F7F7', borderRadius: 10, paddingVertical: 12, paddingHorizontal: 12, marginTop: 8 },
  readOnlyFieldText: { color: '#111111', fontSize: 16, fontWeight: '700', letterSpacing: 0.5 },
  rowLabel: { fontSize: 13, fontWeight: '700', color: '#111111' },
  error: { color: '#C0392B', fontSize: 13, fontWeight: '700', marginTop: 6 },
  addButton: { backgroundColor: '#111111', borderRadius: 10, paddingHorizontal: 18, paddingVertical: 12, alignItems: 'center', justifyContent: 'center' },
  addButtonText: { color: '#FFFFFF', fontWeight: '800', fontSize: 13 },
  buttonDisabled: { backgroundColor: '#CCCCCC' },
});
```

- [ ] **Step 3: Create `src/components/edit-pay-modal.tsx`**

```tsx
import { useEffect, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { CategoryChip } from '@/components/category-chip';
import type { StaffMember } from '@/types/models';

export function EditPayModal({
  visible,
  member,
  onClose,
  onSave,
}: {
  visible: boolean;
  member: StaffMember;
  onClose: () => void;
  onSave: (patch: { hireDate?: string | null; payType?: StaffMember['payType']; payRateCents?: number | null }) => Promise<void>;
}) {
  const [hireDate, setHireDate] = useState(member.hireDate ?? '');
  const [payType, setPayType] = useState<StaffMember['payType']>(member.payType);
  const [rate, setRate] = useState(member.payRateCents != null ? (member.payRateCents / 100).toString() : '');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (visible) {
      setHireDate(member.hireDate ?? '');
      setPayType(member.payType);
      setRate(member.payRateCents != null ? (member.payRateCents / 100).toString() : '');
    }
  }, [visible, member]);

  const save = async () => {
    setSaving(true);
    try {
      await onSave({
        hireDate: hireDate.trim() || null,
        payType: payType ?? null,
        payRateCents: rate.trim() ? Math.round(parseFloat(rate) * 100) : null,
      });
    } finally {
      setSaving(false);
    }
  };

  if (!visible) return null;

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View style={styles.card}>
          <View style={styles.header}>
            <Text style={styles.title}>Edit payroll</Text>
            <View style={styles.headerActions}>
              <Pressable onPress={save} disabled={saving} style={[styles.addButton, saving && styles.buttonDisabled]}>
                <Text style={styles.addButtonText}>{saving ? 'Saving…' : 'Save'}</Text>
              </Pressable>
              <Pressable onPress={onClose} style={styles.close}>
                <Text style={styles.closeText}>Close</Text>
              </Pressable>
            </View>
          </View>
          <Text style={styles.fieldLabel}>HIRE DATE (YYYY-MM-DD)</Text>
          <TextInput value={hireDate} onChangeText={setHireDate} placeholder="2026-01-15" placeholderTextColor="#999999" style={styles.input} />
          <Text style={[styles.fieldLabel, { marginTop: 10 }]}>PAY TYPE</Text>
          <View style={styles.chipRow}>
            {(['hourly', 'salary', 'fixed'] as const).map((t) => (
              <CategoryChip key={t} label={t[0].toUpperCase() + t.slice(1)} active={payType === t} onPress={() => setPayType(t)} />
            ))}
          </View>
          <Text style={[styles.fieldLabel, { marginTop: 10 }]}>PAY RATE (DOLLARS)</Text>
          <TextInput value={rate} onChangeText={setRate} placeholder="e.g. 8.50" placeholderTextColor="#999999" keyboardType="decimal-pad" style={styles.input} />
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', alignItems: 'center', justifyContent: 'center', padding: 20 },
  card: { backgroundColor: '#FFFFFF', borderRadius: 18, padding: 20, width: '100%', maxWidth: 420 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  title: { fontSize: 16, fontWeight: '800', color: '#111111' },
  close: { backgroundColor: '#F2F2F2', borderRadius: 10, paddingHorizontal: 14, paddingVertical: 10 },
  closeText: { fontSize: 13, fontWeight: '700', color: '#111111' },
  fieldLabel: { fontSize: 10, letterSpacing: 0.6, fontWeight: '800', color: '#999999', marginBottom: 6 },
  input: { backgroundColor: '#F2F2F2', borderRadius: 10, height: 42, paddingHorizontal: 12, color: '#111111' },
  chipRow: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  addButton: { backgroundColor: '#111111', borderRadius: 10, paddingHorizontal: 14, paddingVertical: 10 },
  addButtonText: { color: '#FFFFFF', fontWeight: '800', fontSize: 13 },
  buttonDisabled: { backgroundColor: '#CCCCCC' },
});
```

- [ ] **Step 4: Create `src/components/time-off-approval-modal.tsx`**

```tsx
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { Badge } from '@/components/badge';
import { decideTimeOffRequest } from '@/lib/time-off';
import type { StaffMember, TimeOffRequest } from '@/types/models';

export function TimeOffApprovalModal({
  visible,
  requests,
  staff,
  onClose,
  onChange,
}: {
  visible: boolean;
  requests: TimeOffRequest[];
  staff: StaffMember[];
  onClose: () => void;
  onChange: () => Promise<void>;
}) {
  if (!visible) return null;

  const nameFor = (shopMemberId: string) => staff.find((m) => m.id === shopMemberId)?.fullName ?? 'Staff member';

  const decide = async (id: string, decision: 'approved' | 'denied') => {
    await decideTimeOffRequest(id, decision);
    await onChange();
  };

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View style={styles.card}>
          <View style={styles.header}>
            <Text style={styles.title}>Time off requests</Text>
            <Pressable onPress={onClose} style={styles.close}>
              <Text style={styles.closeText}>Close</Text>
            </Pressable>
          </View>
          <ScrollView style={styles.list}>
            {requests.length === 0 ? (
              <Text style={styles.empty}>No time off requests yet.</Text>
            ) : (
              requests.map((r) => (
                <View key={r.id} style={styles.row}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.range}>
                      {nameFor(r.shopMemberId)} · {r.startDate} – {r.endDate}
                    </Text>
                    {r.reason && <Text style={styles.reason}>{r.reason}</Text>}
                  </View>
                  {r.status === 'pending' ? (
                    <View style={styles.actions}>
                      <Pressable onPress={() => decide(r.id, 'approved')}>
                        <Text style={styles.approve}>Approve</Text>
                      </Pressable>
                      <Pressable onPress={() => decide(r.id, 'denied')}>
                        <Text style={styles.deny}>Deny</Text>
                      </Pressable>
                    </View>
                  ) : (
                    <Badge label={r.status === 'approved' ? 'Approved' : 'Denied'} tone={r.status === 'approved' ? 'success' : 'danger'} />
                  )}
                </View>
              ))
            )}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', alignItems: 'center', justifyContent: 'center', padding: 20 },
  card: { backgroundColor: '#FFFFFF', borderRadius: 18, padding: 20, width: '100%', maxWidth: 480, height: '70%', overflow: 'hidden' },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 },
  title: { fontSize: 16, fontWeight: '800', color: '#111111' },
  close: { backgroundColor: '#F2F2F2', borderRadius: 10, paddingHorizontal: 14, paddingVertical: 10 },
  closeText: { fontSize: 13, fontWeight: '700', color: '#111111' },
  list: { flex: 1 },
  empty: { color: '#999999', fontSize: 13, textAlign: 'center', paddingVertical: 20 },
  row: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: '#ECECEC' },
  range: { fontSize: 13, fontWeight: '600', color: '#111111' },
  reason: { fontSize: 11.5, color: '#999999', marginTop: 2 },
  actions: { flexDirection: 'row', gap: 12 },
  approve: { fontSize: 12.5, fontWeight: '700', color: '#2E7D46' },
  deny: { fontSize: 12.5, fontWeight: '700', color: '#B23B4E' },
});
```

- [ ] **Step 5: Type-check**

Run: `npx tsc --noEmit`. Expected: no errors.

- [ ] **Step 6: Manual verification**

As an owner:
- Confirm the Team roster list loads, search filters by name/role, and selecting a member shows the detail pane.
- Add a staff member via "+ Add staff" (confirm this is the exact same `provisionStaff` flow as before — a generated password shown once if left blank), confirm the new member appears in the roster.
- Change a member's role, disable/re-enable a member, confirm both persist and the badge updates.
- With `people.payroll.manage`: edit a member's hire date/pay type/pay rate, confirm the Payroll section and Hire date/Pay type stat tiles update.
- With `people.timesheet.view` or `people.payroll.manage`: confirm "Hours this period"/"Recent shifts" render (will show empty until Task 13's clock-in exists — verify after that task, or manually insert a `time_entries` row for now).
- With `people.timeoff.approve`: open "Time off requests", approve one, confirm its member's badge flips to "On leave" if the approved range covers today, and the pending count decrements.
- As a Cashier-only role: confirm none of Change role/Disable/Payroll-edit/Recent shifts/Time off requests are visible, and the Access & permissions grid correctly shows only POS as granted.

- [ ] **Step 7: Commit**

```bash
git add "src/app/(admin)/(tabs)/people.tsx" src/components/team-add-modal.tsx src/components/edit-pay-modal.tsx src/components/time-off-approval-modal.tsx
git commit -m "feat: build out Team tab (roster, payroll, shifts, access grid, time-off approvals)"
```

---

### Task 13: Self-service `/me` full UI

**Files:**
- Modify: `src/app/(admin)/(tabs)/me.tsx` (replace the skeleton body)

**Interfaces:**
- Consumes: Task 5 (`clockIn`, `clockOut`, `getOpenTimeEntry`, `listMyTimeEntries`, `sumDurationHours`, `listMyTimeOffRequests`, `requestTimeOff`), Task 6 (`useAuth().myMembership`), Task 9 (`Badge`).
- Produces: the fully working self-service screen — nothing else depends on it.

- [ ] **Step 1: Replace `me.tsx`**

```tsx
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Badge } from '@/components/badge';
import { Card } from '@/components/card';
import { StatTile } from '@/components/stat-tile';
import { useAuth } from '@/hooks/use-auth';
import { formatCents } from '@/lib/currency';
import { clockIn, clockOut, getOpenTimeEntry, listMyTimeEntries, sumDurationHours } from '@/lib/time-entries';
import { listMyTimeOffRequests, requestTimeOff } from '@/lib/time-off';
import type { StaffMember, TimeEntry, TimeOffRequest } from '@/types/models';

export default function MeScreen() {
  const { shop, profile, myMembership } = useAuth();

  return (
    <SafeAreaView edges={['left', 'right', 'bottom']} style={styles.safeArea}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.title}>{profile?.role === 'admin' ? 'Me' : (myMembership?.fullName ?? 'Me')}</Text>
        {myMembership && (
          <Text style={styles.subtitle}>
            {myMembership.roleName}
            {myMembership.hireDate ? ` · joined ${new Date(myMembership.hireDate).toLocaleDateString()}` : ''}
          </Text>
        )}

        {!shop ? null : myMembership ? (
          <StaffSelfService shopId={shop.id} member={myMembership} />
        ) : (
          <Card style={styles.ownerCard}>
            <Text style={styles.ownerText}>You&apos;re the shop owner — clock in/out and time-off tracking are for your team, not you.</Text>
          </Card>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function StaffSelfService({ shopId, member }: { shopId: string; member: StaffMember }) {
  const [openEntry, setOpenEntry] = useState<TimeEntry | null>(null);
  const [entries, setEntries] = useState<TimeEntry[]>([]);
  const [requests, setRequests] = useState<TimeOffRequest[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const [showRequestModal, setShowRequestModal] = useState(false);
  const [clocking, setClocking] = useState(false);

  const reload = useCallback(async () => {
    const since = new Date();
    since.setDate(1);
    since.setHours(0, 0, 0, 0);
    const [open, myEntries, myRequests] = await Promise.all([
      getOpenTimeEntry(member.id),
      listMyTimeEntries(member.id, since.toISOString()),
      listMyTimeOffRequests(member.id),
    ]);
    setOpenEntry(open);
    setEntries(myEntries);
    setRequests(myRequests);
  }, [member.id]);

  useEffect(() => {
    reload();
  }, [reload]);

  // Keeps "Xh Ym today" ticking while a shift is open -- 30s is frequent
  // enough to feel live without re-rendering every second for something
  // nobody's staring at continuously.
  useEffect(() => {
    if (!openEntry) return;
    const interval = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(interval);
  }, [openEntry]);

  const toggleClock = async () => {
    setClocking(true);
    try {
      if (openEntry) await clockOut(openEntry.id);
      else await clockIn(shopId, member.id);
      await reload();
    } finally {
      setClocking(false);
    }
  };

  const elapsedLabel = useMemo(() => {
    if (!openEntry) return null;
    const ms = now - new Date(openEntry.clockIn).getTime();
    const hours = Math.floor(ms / (1000 * 60 * 60));
    const minutes = Math.floor((ms % (1000 * 60 * 60)) / (1000 * 60));
    return `${hours}h ${minutes}m today`;
  }, [openEntry, now]);

  const hoursThisPeriod = sumDurationHours(entries);

  return (
    <View>
      <Card style={styles.clockCard}>
        <Text style={styles.clockStatus}>
          {openEntry ? `Clocked in since ${new Date(openEntry.clockIn).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : 'Not clocked in'}
        </Text>
        {elapsedLabel && <Text style={styles.clockElapsed}>{elapsedLabel}</Text>}
        <Pressable onPress={toggleClock} disabled={clocking} style={[styles.clockButton, clocking && styles.clockButtonDisabled]}>
          <Text style={styles.clockButtonText}>{clocking ? 'Working…' : openEntry ? 'Clock out' : 'Clock in'}</Text>
        </Pressable>
      </Card>

      <View style={styles.tiles}>
        <StatTile value={member.hireDate ? new Date(member.hireDate).toLocaleDateString() : '—'} label="Hire date" />
        <StatTile value={member.payType ? member.payType[0].toUpperCase() + member.payType.slice(1) : '—'} label="Pay type" />
        <StatTile value={member.payRateCents != null ? formatCents(member.payRateCents) : '—'} label="Pay rate" />
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>RECENT SHIFTS</Text>
        {entries.length === 0 ? (
          <Text style={styles.empty}>No shifts logged this period.</Text>
        ) : (
          entries.slice(0, 8).map((e) => (
            <View key={e.id} style={styles.shiftRow}>
              <Text style={styles.shiftDate}>
                {new Date(e.clockIn).toLocaleDateString()} · {new Date(e.clockIn).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
                {e.clockOut ? `–${new Date(e.clockOut).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : ' (on shift)'}
              </Text>
              <Text style={styles.shiftDuration}>{e.clockOut ? `${sumDurationHours([e]).toFixed(1)}h` : '—'}</Text>
            </View>
          ))
        )}
        <Text style={styles.periodTotal}>{hoursThisPeriod.toFixed(1)}h logged this period</Text>
      </View>

      <View style={styles.section}>
        <View style={styles.sectionHeadRow}>
          <Text style={styles.sectionTitle}>TIME OFF</Text>
          <Pressable onPress={() => setShowRequestModal(true)}>
            <Text style={styles.sectionLink}>Request →</Text>
          </Pressable>
        </View>
        {requests.length === 0 ? (
          <Text style={styles.empty}>No requests yet.</Text>
        ) : (
          requests.map((r) => (
            <View key={r.id} style={styles.reqRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.reqRange}>
                  {r.startDate} – {r.endDate}
                </Text>
                {r.reason && <Text style={styles.reqReason}>{r.reason}</Text>}
              </View>
              <Badge
                label={r.status === 'pending' ? 'Pending' : r.status === 'approved' ? 'Approved' : 'Denied'}
                tone={r.status === 'pending' ? 'warning' : r.status === 'approved' ? 'success' : 'danger'}
              />
            </View>
          ))
        )}
      </View>

      <RequestTimeOffModal
        visible={showRequestModal}
        onClose={() => setShowRequestModal(false)}
        onSubmit={async (input) => {
          await requestTimeOff(shopId, member.id, input);
          await reload();
          setShowRequestModal(false);
        }}
      />
    </View>
  );
}

function RequestTimeOffModal({
  visible,
  onClose,
  onSubmit,
}: {
  visible: boolean;
  onClose: () => void;
  onSubmit: (input: { startDate: string; endDate: string; reason?: string | null }) => Promise<void>;
}) {
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (visible) {
      setStartDate('');
      setEndDate('');
      setReason('');
      setError(null);
    }
  }, [visible]);

  const submit = async () => {
    if (!startDate.trim() || !endDate.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await onSubmit({ startDate: startDate.trim(), endDate: endDate.trim(), reason: reason.trim() || null });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not submit this request.');
    } finally {
      setSaving(false);
    }
  };

  if (!visible) return null;

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <View style={modalStyles.overlay}>
        <View style={modalStyles.card}>
          <View style={modalStyles.header}>
            <Text style={modalStyles.title}>Request time off</Text>
            <View style={modalStyles.headerActions}>
              <Pressable
                onPress={submit}
                disabled={saving || !startDate.trim() || !endDate.trim()}
                style={[modalStyles.addButton, (saving || !startDate.trim() || !endDate.trim()) && modalStyles.buttonDisabled]}
              >
                <Text style={modalStyles.addButtonText}>{saving ? 'Sending…' : 'Send'}</Text>
              </Pressable>
              <Pressable onPress={onClose} style={modalStyles.close}>
                <Text style={modalStyles.closeText}>Close</Text>
              </Pressable>
            </View>
          </View>
          <Text style={modalStyles.fieldLabel}>START DATE (YYYY-MM-DD)</Text>
          <TextInput value={startDate} onChangeText={setStartDate} placeholder="2026-08-05" placeholderTextColor="#999999" style={modalStyles.input} />
          <Text style={[modalStyles.fieldLabel, { marginTop: 10 }]}>END DATE (YYYY-MM-DD)</Text>
          <TextInput value={endDate} onChangeText={setEndDate} placeholder="2026-08-09" placeholderTextColor="#999999" style={modalStyles.input} />
          <Text style={[modalStyles.fieldLabel, { marginTop: 10 }]}>REASON (OPTIONAL)</Text>
          <TextInput value={reason} onChangeText={setReason} placeholder="e.g. Family event" placeholderTextColor="#999999" style={modalStyles.input} />
          {error && <Text style={modalStyles.error}>{error}</Text>}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: '#FFFFFF' },
  content: { padding: 24, paddingBottom: 60 },
  title: { color: '#111111', fontSize: 24, fontWeight: '800', letterSpacing: -0.5 },
  subtitle: { color: '#999999', fontSize: 12, marginTop: 3, marginBottom: 20 },
  ownerCard: { padding: 18, marginTop: 10 },
  ownerText: { color: '#666666', fontSize: 13, lineHeight: 19 },
  clockCard: { padding: 20, alignItems: 'center', marginBottom: 20 },
  clockStatus: { fontSize: 11.5, fontWeight: '700', color: '#2E7D46', letterSpacing: 0.3, textTransform: 'uppercase', marginBottom: 4 },
  clockElapsed: { fontSize: 26, fontWeight: '800', color: '#111111', letterSpacing: -0.5, marginBottom: 14 },
  clockButton: { backgroundColor: '#111111', borderRadius: 999, paddingHorizontal: 26, paddingVertical: 11 },
  clockButtonDisabled: { opacity: 0.6 },
  clockButtonText: { color: '#FFFFFF', fontWeight: '700', fontSize: 13 },
  tiles: { flexDirection: 'row', gap: 9, marginBottom: 20 },
  section: { marginBottom: 20 },
  sectionHeadRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 },
  sectionTitle: { fontSize: 10.5, fontWeight: '700', letterSpacing: 0.6, color: '#999999', marginBottom: 8 },
  sectionLink: { fontSize: 11.5, fontWeight: '700', color: '#B23B4E' },
  empty: { color: '#999999', fontSize: 13 },
  shiftRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: '#ECECEC' },
  shiftDate: { fontSize: 12, color: '#666666' },
  shiftDuration: { fontSize: 12, fontWeight: '700', color: '#111111' },
  periodTotal: { fontSize: 11.5, color: '#999999', marginTop: 8 },
  reqRow: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10, paddingVertical: 9, borderBottomWidth: 1, borderBottomColor: '#ECECEC' },
  reqRange: { fontSize: 12.5, fontWeight: '600', color: '#111111' },
  reqReason: { fontSize: 11, color: '#999999', marginTop: 1 },
});

const modalStyles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', alignItems: 'center', justifyContent: 'center', padding: 20 },
  card: { backgroundColor: '#FFFFFF', borderRadius: 18, padding: 20, width: '100%', maxWidth: 420 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  title: { fontSize: 16, fontWeight: '800', color: '#111111' },
  close: { backgroundColor: '#F2F2F2', borderRadius: 10, paddingHorizontal: 14, paddingVertical: 10 },
  closeText: { fontSize: 13, fontWeight: '700', color: '#111111' },
  fieldLabel: { fontSize: 10, letterSpacing: 0.6, fontWeight: '800', color: '#999999', marginBottom: 6 },
  input: { backgroundColor: '#F2F2F2', borderRadius: 10, height: 42, paddingHorizontal: 12, color: '#111111' },
  addButton: { backgroundColor: '#111111', borderRadius: 10, paddingHorizontal: 14, paddingVertical: 10 },
  addButtonText: { color: '#FFFFFF', fontWeight: '800', fontSize: 13 },
  buttonDisabled: { backgroundColor: '#CCCCCC' },
  error: { color: '#C0392B', fontSize: 12, fontWeight: '700', marginTop: 10 },
});
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`. Expected: no errors.

- [ ] **Step 3: Manual verification**

Log in as a staff member (any role, including one with zero operational permissions — confirm they land here per Task 7). Clock in, confirm the elapsed-time card updates (wait ~30s or temporarily lower the interval while testing), clock out, confirm a completed shift appears under Recent Shifts with a correct duration. Submit a time-off request, then — logged in as an approver — confirm it shows up in the Team tab's approval list (Task 12) and that approving/denying it updates this screen's own request list and status badge. Log in as the owner and confirm the "you're the shop owner" message renders instead (no clock widget, since there's no `shop_members` row to attach shifts to).

- [ ] **Step 4: Commit**

```bash
git add "src/app/(admin)/(tabs)/me.tsx"
git commit -m "feat: build out self-service /me (clock in/out, recent shifts, time-off requests, pay display)"
```

---

### Task 14: Team import/export

**Files:**
- Create: `src/lib/staff-import.ts`
- Modify: `src/lib/staff.ts` (widen `ProvisionStaffResult` to include the `member` object the edge function already returns)
- Modify: `src/app/(admin)/(tabs)/people.tsx` (add Export/Import to `TeamTab`'s header)

**Interfaces:**
- Consumes: existing `ExportMenu`/`CsvImportModal`/`ImportEntityConfig` (Customers already established the pattern in Task 11), `provisionStaff`, `listRoles`.
- Produces: `runStaffImport`, `STAFF_TEMPLATE_COLUMNS`, `STAFF_EXAMPLE_ROW`, `TEAM_EXPORT_COLUMNS_BASIC`/`_WITH_PAY` — nothing downstream depends on this task; it's the last one in the plan.

- [ ] **Step 1: Widen `ProvisionStaffResult` in `src/lib/staff.ts`**

The `provision-staff` edge function's JSON response already includes a `member` object (`{ id, shopId, userId, roleId, active }`, see `supabase/functions/provision-staff/index.ts`'s final `Response`) — the client type just doesn't declare it yet. Replace:
```ts
export type ProvisionStaffResult = {
  userId: string;
  email: string;
  temporaryPassword: string | null;
};
```
with:
```ts
export type ProvisionStaffResult = {
  userId: string;
  email: string;
  temporaryPassword: string | null;
  member: { id: string; shopId: string; userId: string; roleId: string; active: boolean };
};
```
No other change needed in this file — `provisionStaff()`'s body already passes the full response through unmodified.

- [ ] **Step 2: Create `src/lib/staff-import.ts`**

```ts
import type { ParsedCsv } from '@/lib/csv';
import type { ImportReport, RejectedRow } from '@/lib/import-shared';
import { provisionStaff } from '@/lib/staff';
import type { Role, StaffMember } from '@/types/models';

export const STAFF_TEMPLATE_COLUMNS: { header: string; required: boolean }[] = [
  { header: 'Full Name', required: true },
  { header: 'Email', required: true },
  { header: 'Role', required: true },
  { header: 'Password', required: false },
];

export const STAFF_EXAMPLE_ROW: Record<string, string> = {
  'Full Name': 'Hamse Jibril',
  Email: 'hamse@example.com',
  Role: 'Cashier',
  Password: '',
};

// Unlike runCustomersImport, this can't bulk-insert -- provisioning a staff
// member mints a real login via the provision-staff Edge Function (one auth
// user + one shop_members row per call), so there's no batching RPC and
// shouldn't be one. Rows are processed sequentially; acceptable since staff
// imports are rare and small compared to customer imports.
export async function runStaffImport(shopId: string, roles: Role[], parsed: ParsedCsv): Promise<ImportReport<StaffMember>> {
  const roleByName = new Map(roles.map((r) => [r.name.toLowerCase(), r]));
  const rejected: RejectedRow[] = [];
  const accepted: StaffMember[] = [];

  for (let i = 0; i < parsed.rows.length; i++) {
    const raw = parsed.rows[i];
    const row = i + 2; // header occupies row 1 in the uploaded file
    const reject = (reason: string) => rejected.push({ row, reason, data: raw });

    const fullName = raw['Full Name']?.trim();
    const email = raw['Email']?.trim();
    const roleName = raw['Role']?.trim();
    if (!fullName) {
      reject('Full Name is required.');
      continue;
    }
    if (!email) {
      reject('Email is required.');
      continue;
    }
    if (!roleName) {
      reject('Role is required.');
      continue;
    }
    const role = roleByName.get(roleName.toLowerCase());
    if (!role) {
      reject(`Role "${roleName}" does not match an existing role — create it in Settings first.`);
      continue;
    }

    try {
      const created = await provisionStaff({ shopId, fullName, email, password: raw['Password']?.trim() || undefined, roleId: role.id });
      accepted.push({
        id: created.member.id,
        shopId,
        userId: created.userId,
        roleId: role.id,
        roleName: role.name,
        active: true,
        fullName,
        email: created.email,
        createdAt: new Date().toISOString(),
        hireDate: null,
        payType: null,
        payRateCents: null,
      });
    } catch (err) {
      reject(err instanceof Error ? err.message : 'Could not add this staff member.');
    }
  }

  return { accepted, rejected };
}
```

- [ ] **Step 3: Add Export/Import to `TeamTab` in `people.tsx`**

Add these imports:
```tsx
import type { CsvColumn } from '@/lib/csv';
import { STAFF_EXAMPLE_ROW, STAFF_TEMPLATE_COLUMNS, runStaffImport } from '@/lib/staff-import';
```

Add these module-level constants near `CUSTOMER_EXPORT_COLUMNS` (Task 11):
```tsx
const TEAM_EXPORT_COLUMNS_BASIC: CsvColumn<StaffMember>[] = [
  { header: 'Name', value: (m) => m.fullName ?? '' },
  { header: 'Email', value: (m) => m.email ?? '' },
  { header: 'Role', value: (m) => m.roleName },
  { header: 'Status', value: (m) => (m.active ? 'Active' : 'Disabled') },
  { header: 'Hire Date', value: (m) => m.hireDate ?? '' },
];

const TEAM_EXPORT_COLUMNS_WITH_PAY: CsvColumn<StaffMember>[] = [
  ...TEAM_EXPORT_COLUMNS_BASIC,
  { header: 'Pay Type', value: (m) => m.payType ?? '' },
  { header: 'Pay Rate', value: (m) => (m.payRateCents != null ? formatCents(m.payRateCents) : '') },
];
```

In `TeamTab`, add state (alongside the existing `showAddModal`/`showApprovalList`):
```tsx
  const [showImportModal, setShowImportModal] = useState(false);
```
Add, right before the component's `return`:
```tsx
  const importConfig: ImportEntityConfig<StaffMember> | null =
    shop && roles.length > 0
      ? {
          title: 'team',
          filenamePrefix: 'team',
          templateColumns: STAFF_TEMPLATE_COLUMNS,
          exampleRows: [STAFF_EXAMPLE_ROW],
          run: (parsed) => runStaffImport(shop.id, roles, parsed),
          unitLabel: 'staff member',
        }
      : null;
  // Exported pay data is sensitive -- someone who can only manage the
  // roster (staff.manage) but not payroll (people.payroll.manage) gets an
  // export without pay columns.
  const exportColumns = canManagePayroll ? TEAM_EXPORT_COLUMNS_WITH_PAY : TEAM_EXPORT_COLUMNS_BASIC;
```
Replace the header's `headerActions` block:
```tsx
        <View style={tabStyles.headerActions}>
          {canManageRoster && (
            <Pressable
              onPress={() => setShowAddModal(true)}
              disabled={roles.length === 0}
              style={[tabStyles.actionButton, roles.length === 0 && tabStyles.actionButtonDisabled]}
            >
              <Text style={tabStyles.actionButtonText}>+ Add staff</Text>
            </Pressable>
          )}
        </View>
```
with:
```tsx
        <View style={tabStyles.headerActions}>
          {canManageRoster && <ExportMenu rows={filtered} columns={exportColumns} title="Team" subtitle={`${filtered.length} team members`} filenamePrefix="team" />}
          {canManageRoster && (
            <Pressable onPress={() => setShowImportModal(true)} style={tabStyles.actionButton}>
              <Text style={tabStyles.actionButtonText}>Import</Text>
            </Pressable>
          )}
          {canManageRoster && (
            <Pressable
              onPress={() => setShowAddModal(true)}
              disabled={roles.length === 0}
              style={[tabStyles.actionButton, roles.length === 0 && tabStyles.actionButtonDisabled]}
            >
              <Text style={tabStyles.actionButtonText}>+ Add staff</Text>
            </Pressable>
          )}
        </View>
```
Add the import modal right after the existing `TimeOffApprovalModal` usage, inside the same returned JSX:
```tsx
      {importConfig && <CsvImportModal visible={showImportModal} onClose={() => setShowImportModal(false)} config={importConfig} onImported={reload} />}
```
(`ExportMenu` and `CsvImportModal`/`ImportEntityConfig` are already imported in this file from Task 11 — no new import needed for those two.)

- [ ] **Step 4: Type-check**

Run: `npx tsc --noEmit`. Expected: no errors.

- [ ] **Step 5: Manual verification**

As a role with `staff.manage` but not `people.payroll.manage`: export the team roster, confirm the CSV has no Pay Type/Pay Rate columns. As a role with both: confirm the CSV includes them. Download the import template, fill in a new row with a Role matching an existing role, import it, confirm the new staff member appears in the roster with a generated password shown once. Try importing a row with a Role that doesn't exist, confirm it's rejected with a clear reason and appears in the "download rejected rows" file.

- [ ] **Step 6: Commit**

```bash
git add src/lib/staff.ts src/lib/staff-import.ts "src/app/(admin)/(tabs)/people.tsx"
git commit -m "feat: add Team CSV import/export, gated pay columns on people.payroll.manage"
```

---

## Final Verification (whole branch)

After all 14 tasks: run `npx tsc --noEmit` and `npm test` clean from the repo root, then walk the full manual verification list in the plan's own "Verification" section under the Context/Global Constraints above — owner, cashier-only, customers.view-only, people.payroll.manage, people.timeoff.approve, and zero-permission-active-member accounts, on both compact and wide layouts, on both native tabs and the web sidebar/bottom-nav. Confirm Settings' Roles panel still works standalone, and that nothing in Sales/POS/Dashboard/Inventory regressed (none of those screens were touched by this plan, but `permissions.ts`/`use-auth.tsx` changes in Task 6 are load-bearing for the whole app).
