# Inventory Count Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Open the fourth Stock door — a stock-take that replaces a count with what was actually found, records who said so and why, tells the shop what its shrinkage cost — and split `inventory.edit` so that writing stock off is a permission of its own.

**Architecture:** Mirrors the Restock feature that just shipped, at every layer. A new `save_stock_count()` `security definer` RPC **sets** an absolute per-store total and writes a `stock_counts` record in one transaction (exactly as `receive_stock()` **adds** one and writes a `stock_receipts` record). A new pure module `src/lib/count-import.ts` turns a parsed CSV plus current holdings into a plan, writing nothing — the same split that made `restock-import.ts` correct. A new `StockCountModal` has the same two tabs (`By hand` / `By sheet`) as `StockRestockModal`, holds its typed fields as raw text classified by `src/lib/restock-typed-input.ts`, and ends both tabs at the same commit. `StockActionsSheet`'s disabled `Count` row becomes live. Two new permissions, `inventory.count` and `inventory.transfer`, are backfilled **on** for every role that already holds `inventory.edit`, and the RPC checks `inventory.count` itself rather than trusting the sheet.

**Tech Stack:** Expo SDK 57 (read the versioned docs at https://docs.expo.dev/versions/v57.0.0/ before writing any Expo-facing code), React Native, TypeScript, Supabase (Postgres + RLS + `security definer` RPCs), Jest + `react-test-renderer`, `psql` verify scripts under `supabase/tests/`.

## Global Constraints

- **`products.stock` is an OUTPUT.** A direct write to it is silently replaced by the rollup (migration `20260810000000`). The only supported way to change a count is `product_location_stock`.
- **Count SETS an absolute total. It does not add.** This is the whole distinction from Restock and the reason the door exists. The RPC takes the counted total, reads what the store holds, and computes the variance itself.
- **A count covers only the lines it contains.** A product absent from a count keeps its number. Nothing is ever zeroed for being missing from a sheet.
- **`save_stock_count` must check `inventory.count` in the RPC**, via `has_shop_permission` — not rely on the UI. The sheet must not be the only thing standing between a cashier and a write-off.
- **The module gate is `inventory`, NEVER `multi_location`.** `stock_receipts` gets this right; `stock_transfers` is on `multi_location` because a movement needs two branches. A stock-take needs one, and a one-store shop on any plan must be able to do one.
- **Never normalise input inside `onChangeText` on a controlled `TextInput`.** Three separate silent 100× cost bugs came from this on the Restock branch. Hold the raw text; classify once from the whole string, at submit and for the footer figure. `src/lib/restock-typed-input.ts` already does this and Count extends it rather than growing a second reader.
- **Nothing writes before the commit button.** Both tabs build a plan first; `planCount()` performs no I/O.
- **Reasons are optional and the gap is reported**, never defaulted to `Miscount`.
- **Copy rule:** every string quoted in this plan from `docs/design/inventory-count-mockup.html` is a product decision and ships verbatim.
- **Never hardcode a hex in a screen.** New modal chrome copies the style objects already in `src/components/stock-restock-modal.tsx`.
- Run `npm test`, `npm run lint` and `npx tsc --noEmit` before every commit. Run `npm run test:db` for any task touching `supabase/`.

## Decisions locked in

Taken from the mockup ([docs/design/inventory-count-mockup.html](../../design/inventory-count-mockup.html)) and the four open questions it closes with. Each is isolated to one task so it can be reversed cheaply.

| Decision | Chosen | Where it lives |
|---|---|---|
| Stock-loss expense | **Unticked checkbox**, matching Restock's inventory-purchase sibling. Needs a new `stock_loss` category. **Hides rather than lies** when the count contains uncosted products, and says why | Task 1 (category), Task 9 (checkbox) |
| Is `stock_loss` an operating expense? | **Yes.** Unlike `inventory_purchase` (an asset that becomes COGS when it sells) and `owner_draw` (equity), shrinkage is stock that left at cost and will never be sold. It belongs in Operating expenses and in Net profit — that is the entire point of the feature | Task 1 |
| Partial counts | **Uncounted products are simply not in the count and keep their numbers.** Never zero anything absent from the sheet | Task 2 (RPC), Task 4 (planner) |
| Approval workflow | **None.** One person counts and saves. A shop wanting a second pair of eyes gets it by not granting `inventory.count` widely | — (not built) |
| Permissions | **In this pass.** `inventory.count` and `inventory.transfer`, nested under `inventory.edit`, backfilled **on** for every role that already holds it. Restock stays the base meaning of `inventory.edit` | Task 1 (migration + catalogue), Task 8 (editor UI) |
| Catalogue editing permission | **Out of scope.** The mockup draws the `Edit the catalogue` row to show where it sits, not to propose it. `inventory.edit` keeps governing product writes, and its description says so rather than pretending otherwise | Task 1 |
| Expense value | **Gross shortfall, not net variance.** The mockup's own numbers make this explicit: the footer nets to `−1 unit · −$4.61` while the checkbox offers `$13.83` — three units lost at $4.61, with the two found not deducted. Units found are not a negative expense | Task 4 (`summariseCount`), Task 9 |
| Reason picker | **Inline chips, never a nested sheet.** A sheet opened from a sheet is dropped by iOS without a word and needs `useStagedSheet`; five chips that expand under the line avoid the class entirely | Task 5 |
| Scanning inside the Count sheet | **Not built.** The mockup does not propose it, and the Restock branch's scan work (Task 9 there) cost a CRITICAL to get right. Inventory's own wedge still stands down while this sheet is open | Task 7 |

## File Structure

**Create**
- `supabase/migrations/20260903000000_inventory_verbs_and_stock_loss.sql` — `inventory.count` / `inventory.transfer` backfilled onto existing roles; `stock_loss` widened into the four category check constraints.
- `supabase/tests/verify-inventory-permissions.sql` — the backfill actually landed, a role without `inventory.edit` gained nothing, and `stock_loss` is accepted everywhere a category is stored.
- `supabase/migrations/20260903000100_stock_counts.sql` — `stock_counts`, `stock_count_items`, `save_stock_count()`, RLS, module gate.
- `supabase/tests/verify-stock-counts.sql` — self-contained fixture proving the RPC sets rather than adds, leaves absent products alone, refuses a member without `inventory.count`, and is *not* gated on `multi_location`.
- `src/lib/count-import.ts` — pure. Sheet columns, `countSheetRows()`, `planCount()`, `summariseCount()`.
- `src/lib/__tests__/count-import.test.ts` — every rule in `count-import.ts`, through the real CSV helpers.
- `src/components/stock-count-modal.tsx` — `StockCountModal`, both tabs.
- `src/components/__tests__/stock-count-modal.test.tsx` — the component's own handlers, driven one character at a time.

**Modify**
- `src/lib/permissions.ts` — two catalogue entries, their implications, and a `parent` field for nesting.
- `src/lib/permission-groups.ts` — the Inventory group gains both.
- `src/lib/__tests__/permissions.test.ts` — the nesting and the backfill shape.
- `src/lib/expense-reporting.ts` — `stock_loss` in the catalogue, deliberately *not* in `NON_OPERATING_CATEGORIES`.
- `src/lib/__tests__/expense-reporting.test.ts` — that it counts as operating.
- `src/types/models.ts` — `ExpenseCategory` gains `stock_loss`; add `StockCount`, `StockCountItem`, `StockCountReason`.
- `src/lib/products.ts` — add `saveStockCount()`.
- `src/components/stock-actions-sheet.tsx` — the `Count` row becomes a live `Pressable`.
- `src/components/__tests__/stock-actions-sheet.test.tsx` — Count is now offered, and hidden without the permission.
- `src/app/(admin)/(tabs)/inventory.tsx` — wire `StockCountModal`, extend the wedge stand-downs, gate the door's Count row.
- `src/components/settings/panels/roles-panel.tsx` — indent and cascade the nested permissions.
- `src/lib/restock-typed-input.ts` — add `readCountedQuantity`, sharing the guts of `readTypedQuantity`.
- `src/lib/__tests__/restock-typed-input.test.ts` — zero is a count and is not a delivery.

---

### Task 1: Two new permissions, and somewhere for shrinkage to land

**Files:**
- Create: `supabase/migrations/20260903000000_inventory_verbs_and_stock_loss.sql`
- Create: `supabase/tests/verify-inventory-permissions.sql`
- Modify: `src/lib/permissions.ts`
- Modify: `src/lib/permission-groups.ts:12`
- Modify: `src/lib/expense-reporting.ts:12-41`
- Modify: `src/types/models.ts:681-692` (the `ExpenseCategory` union)
- Test: `src/lib/__tests__/permissions.test.ts`, `src/lib/__tests__/expense-reporting.test.ts`

**Interfaces:**
- Consumes: `public.roles.permissions text[]`, `public.has_shop_permission` — both existing.
- Produces:
  - Permission strings `'inventory.count'` and `'inventory.transfer'`, present in `Permission`, `PERMISSIONS`, `ALL_PERMISSIONS` and `IMPLIED_PERMISSIONS`.
  - `PERMISSIONS` entries gain an optional `parent?: Permission` used by Task 8's editor.
  - `ExpenseCategory` gains `'stock_loss'`; `EXPENSE_CATEGORIES` gains `{ key: 'stock_loss', label: 'Stock loss' }`.

- [ ] **Step 1: Confirm the four constraint names before altering them**

The category check constraints were declared inline, so Postgres named them itself. Read the names rather than guessing — a `drop constraint` naming something that does not exist fails the whole migration chain.

Run:

```bash
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -qAt -c "
select conrelid::regclass, conname
  from pg_constraint
 where conname like '%category_check'
 order by 1;"
```

Expected, exactly these four lines:

```
budgets|budgets_category_check
expenses|expenses_category_check
invoices|invoices_category_check
recurring_bills|recurring_bills_category_check
```

If a name differs, use the name printed here in Step 3 rather than the one written below.

- [ ] **Step 2: Write the failing verify script**

Create `supabase/tests/verify-inventory-permissions.sql`:

```sql
-- Splitting inventory.edit, and letting shrinkage be an expense.
--
-- Four things are asserted, and none of them can be checked from TypeScript
-- because all four are facts about rows and constraints in this database:
--
--   1. every role that already held inventory.edit gained BOTH new
--      permissions. This is the one that decides whether a shop's staff lose
--      access on the morning this ships. The permission catalogue in
--      src/lib/permissions.ts is only what the client offers; roles.permissions
--      is what has_shop_permission actually reads.
--   2. a role that did NOT hold inventory.edit gained nothing. A backfill that
--      granted write-off to a Cashier would be worse than no backfill.
--   3. has_shop_permission resolves the new strings for a member, and the shop
--      OWNER holds them implicitly without any row being written -- which is
--      why the backfill deliberately does not touch owners.
--   4. stock_loss is accepted by every table that stores a category, and a
--      bogus category is still refused. The four are widened together because
--      EXPENSE_CATEGORIES is one list shared by the expense editor, the
--      recurring-bill modal, the invoice editor and the budget picker: adding
--      the category to the list while leaving a constraint behind would give a
--      raw Postgres error the first time someone picked it on a bill.
--
-- Everything runs inside one DO block whose EXCEPTION clause rolls it all back.

\set ON_ERROR_STOP on

do $$
declare
  v_owner_id    uuid := gen_random_uuid();
  v_staff_id    uuid := gen_random_uuid();
  v_shop_id     uuid;
  v_editor_role uuid;
  v_cashier_role uuid;
  v_perms       text[];
  v_raised      boolean;
begin
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
    select u, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
           'verify-inventory-permissions-' || u || '@example.test', '', now(), now(), now()
      from unnest(array[v_owner_id, v_staff_id]) u;

  insert into public.shops (owner_id, name) values (v_owner_id, 'Permissions Shop') returning id into v_shop_id;

  -- The seeding in 0020 runs at migration time, so a shop created now has no
  -- roles at all. Both roles below are written as they would have looked
  -- BEFORE this migration, and then the migration's own backfill statement is
  -- replayed against them -- which is what makes this a test of the statement
  -- rather than of the seed data.
  insert into public.roles (shop_id, name, permissions)
    values (v_shop_id, 'Stockroom', array['pos.access', 'inventory.view', 'inventory.edit'])
    returning id into v_editor_role;
  insert into public.roles (shop_id, name, permissions)
    values (v_shop_id, 'Till', array['pos.access', 'inventory.view'])
    returning id into v_cashier_role;

  update public.roles
    set permissions = permissions || array['inventory.count', 'inventory.transfer']
    where shop_id = v_shop_id
      and permissions @> array['inventory.edit']
      and not permissions && array['inventory.count', 'inventory.transfer'];

  -- 1. The role that could already change stock keeps being able to.
  select permissions into v_perms from public.roles where id = v_editor_role;
  if not v_perms @> array['inventory.count', 'inventory.transfer'] then
    raise exception 'FAIL: a role holding inventory.edit should have gained both verbs, got %', v_perms;
  end if;

  -- 2. And the one that could not, still cannot.
  select permissions into v_perms from public.roles where id = v_cashier_role;
  if v_perms && array['inventory.count', 'inventory.transfer'] then
    raise exception 'FAIL: a role without inventory.edit must gain nothing, got %', v_perms;
  end if;

  -- 3. The resolver reads them, for a member and for the owner.
  insert into public.shop_members (shop_id, user_id, role_id, active)
    values (v_shop_id, v_staff_id, v_editor_role, true);

  if not public.user_has_shop_permission(v_staff_id, v_shop_id, 'inventory.count') then
    raise exception 'FAIL: the stockroom member should resolve inventory.count';
  end if;
  -- The owner has no shop_members row at all (0017), and user_has_shop_permission
  -- short-circuits on shops.owner_id -- so an owner holds a permission that has
  -- existed for five minutes without anything being written for them.
  if not public.user_has_shop_permission(v_owner_id, v_shop_id, 'inventory.count') then
    raise exception 'FAIL: the owner should hold inventory.count implicitly';
  end if;

  -- 4. stock_loss is storable everywhere a category is stored.
  insert into public.expenses (shop_id, occurred_on, amount_cents, category)
    values (v_shop_id, current_date, 1383, 'stock_loss');
  insert into public.budgets (shop_id, category, limit_cents)
    values (v_shop_id, 'stock_loss', 50000);
  insert into public.recurring_bills (shop_id, name, category, frequency, amount_cents, next_due_date)
    values (v_shop_id, 'Shrinkage allowance', 'stock_loss', 'monthly', 5000, current_date);
  insert into public.invoices (shop_id, invoice_number, category, due_on, amount_cents)
    values (v_shop_id, 'SL-1', 'stock_loss', current_date, 1000);

  -- And the constraint is still a constraint.
  v_raised := false;
  begin
    insert into public.expenses (shop_id, occurred_on, amount_cents, category)
      values (v_shop_id, current_date, 100, 'shrinkage');
  exception when others then v_raised := true;
  end;
  if not v_raised then
    raise exception 'FAIL: widening the category list must not have removed the check';
  end if;

  raise notice 'ALL CHECKS PASSED';
  raise exception 'rollback fixture';
exception
  when others then
    if sqlerrm = 'rollback fixture' then
      return;
    end if;
    raise;
end $$;
```

- [ ] **Step 3: Run it and verify it fails**

Run: `npx supabase start && npm run test:db -- --no-reset`
Expected: `verify-inventory-permissions  FAIL` with `ERROR: new row for relation "expenses" violates check constraint "expenses_category_check"`.

- [ ] **Step 4: Write the migration**

Create `supabase/migrations/20260903000000_inventory_verbs_and_stock_loss.sql`:

```sql
-- Splitting inventory.edit into verbs, and giving shrinkage somewhere to land.
--
-- Both halves exist for the Count door, and both have to be in place before it
-- opens, which is why they ship as one migration.
--
-- ## Why inventory.edit was not enough
--
-- All four stock jobs sit behind one permission, so anyone who can receive a
-- delivery can also write stock off, move it between branches and rewrite the
-- catalogue. Those are different levels of trust, and Count is the one that
-- destroys value: a Restock overstating by 40 is caught by the invoice, while a
-- Count writing 11 down to 8 has no counterparty and no paperwork. It is one
-- person's word that three units are not there.
--
-- Two new permissions, not four. Restock stays the base meaning of
-- inventory.edit, because receiving is the ordinary case and a permission
-- everyone turns on is not a permission. Catalogue editing wants separating
-- too, but that is a wider change than this door.
--
-- ## Why they default ON
--
-- Every role that already holds inventory.edit gains both. A shop that granted
-- inventory.edit to its stockroom last year did so meaning "this person handles
-- stock", and shipping a split that silently narrows it would take a working
-- feature away from a shop that did nothing. The narrowing is offered, not
-- imposed: the role editor is where an owner decides to turn the child off.
--
-- Shop owners are deliberately untouched. user_has_shop_permission
-- (0024_permission_gates.sql) short-circuits on shops.owner_id, so an owner
-- holds every permission the moment it exists, with no row written for them --
-- the same reason 0017 gives them no shop_members row at all.

-- Guarded so re-running is a no-op and a customised role is not overwritten --
-- the same shape 20260804000500 used for budgets.manage and 20260822000000
-- used for registers.manage. `not permissions && array[...]` means "holds
-- neither", which is exact today because nothing can hold either yet.
update public.roles
  set permissions = permissions || array['inventory.count', 'inventory.transfer']
  where permissions @> array['inventory.edit']
    and not permissions && array['inventory.count', 'inventory.transfer'];

-- ---------------------------------------------------------------------------
-- stock_loss: the expense category shrinkage has never had
-- ---------------------------------------------------------------------------
--
-- COGS is built from sale_items.unit_cost_cents, frozen at sale time. A unit
-- that is stolen, breaks or expires is NEVER SOLD, so its cost never enters
-- COGS by any path. It leaves Stock at cost and is gone, and the P&L never
-- hears about it -- gross profit reads higher than it is by exactly the cost of
-- everything that walked out, every month, invisibly. Per-product stock could
-- already be edited inline on the Inventory list, which is a count one product
-- at a time with no reason, no record and no P&L effect, so this has been true
-- for as long as the app has had stock.
--
-- Unlike the two categories 20260804000200 deliberately holds out of the
-- operating subtotal, this one belongs IN it. inventory_purchase is excluded
-- because stock is an asset until it sells, at which point it becomes COGS, and
-- owner_draw is excluded because a draw is equity. Shrinkage is neither: it is
-- stock the shop paid for and will never sell, so it is a cost of trading and
-- it should reduce net profit. src/lib/expense-reporting.ts therefore adds it
-- to EXPENSE_CATEGORIES and deliberately NOT to NON_OPERATING_CATEGORIES.
--
-- All four constraints are widened together, not just expenses'. The client has
-- ONE category list (EXPENSE_CATEGORIES), and the expense editor, the
-- recurring-bill modal, the invoice editor and the budget picker all render it.
-- Widening only expenses would leave the other three offering a value their
-- table refuses, and the shop would meet it as a raw constraint violation.
alter table public.expenses drop constraint expenses_category_check;
alter table public.expenses add constraint expenses_category_check check (category in (
  'inventory_purchase','stock_loss','rent','utilities','salaries_wages','marketing',
  'supplies','transport_delivery','maintenance_repairs','fees_charges',
  'owner_draw','other'
));

alter table public.invoices drop constraint invoices_category_check;
alter table public.invoices add constraint invoices_category_check check (category in (
  'inventory_purchase','stock_loss','rent','utilities','salaries_wages','marketing',
  'supplies','transport_delivery','maintenance_repairs','fees_charges',
  'owner_draw','other'
));

alter table public.recurring_bills drop constraint recurring_bills_category_check;
alter table public.recurring_bills add constraint recurring_bills_category_check check (category in (
  'inventory_purchase','stock_loss','rent','utilities','salaries_wages','marketing',
  'supplies','transport_delivery','maintenance_repairs','fees_charges',
  'owner_draw','other'
));

alter table public.budgets drop constraint budgets_category_check;
alter table public.budgets add constraint budgets_category_check check (category in (
  'inventory_purchase','stock_loss','rent','utilities','salaries_wages','marketing',
  'supplies','transport_delivery','maintenance_repairs','fees_charges',
  'owner_draw','other'
));
```

- [ ] **Step 5: Run the database suite and verify it passes**

Run: `npm run test:db`
Expected: `verify-inventory-permissions  pass`, every other script still `pass`, and the run ends `N database checks passed.` with no FAIL. The full reset also proves the chain still applies from empty.

- [ ] **Step 6: Write the failing client tests**

In `src/lib/__tests__/permissions.test.ts`, add:

```ts
// The nesting is real, not visual: a role granting the child has to resolve
// the parent too, or someone who can count could not open the screen they
// count on. expandPermissions folds ONE level, so the parent's own implication
// (inventory.view) has to be listed here as well -- writing only
// ['inventory.edit'] and expecting the view to come along is the bug this case
// exists to catch.
describe('the inventory verbs', () => {
  it('resolves counting into editing and viewing', () => {
    expect(expandPermissions(['inventory.count'])).toEqual([
      'inventory.view',
      'inventory.edit',
      'inventory.count',
    ]);
  });

  it('resolves transferring the same way', () => {
    expect(expandPermissions(['inventory.transfer'])).toEqual([
      'inventory.view',
      'inventory.edit',
      'inventory.transfer',
    ]);
  });

  // What the migration's backfill produces, read back through the client.
  it('leaves a backfilled stockroom role holding all four', () => {
    expect(expandPermissions(['inventory.view', 'inventory.edit', 'inventory.count', 'inventory.transfer'])).toEqual([
      'inventory.view',
      'inventory.edit',
      'inventory.count',
      'inventory.transfer',
    ]);
  });

  // The seeded Cashier is already read-only and stays that way -- the gap this
  // split closes is inside edit, not at the edge of it.
  it('gives a cashier neither verb', () => {
    expect(expandPermissions(CASHIER)).not.toContain('inventory.count');
    expect(expandPermissions(CASHIER)).not.toContain('inventory.transfer');
  });

  // Task 8's editor indents from this, and cascades a parent's OFF through it.
  it('names its parent so the editor can nest it', () => {
    const byKey = new Map(PERMISSIONS.map((p) => [p.key, p]));
    expect(byKey.get('inventory.count')?.parent).toBe('inventory.edit');
    expect(byKey.get('inventory.transfer')?.parent).toBe('inventory.edit');
    expect(byKey.get('inventory.edit')?.parent).toBeUndefined();
  });
});
```

In `src/lib/__tests__/expense-reporting.test.ts`, add:

```ts
// The whole reason the category exists. inventory_purchase and owner_draw are
// held out of the operating subtotal because one is an asset that becomes COGS
// and the other is equity. Shrinkage is neither -- it is stock the shop paid
// for and will never sell -- so it has to reduce net profit, or Count reports a
// loss that the P&L still never hears about.
describe('stock loss', () => {
  it('is an operating expense, unlike the other two stock-shaped categories', () => {
    expect(isOperatingExpense('stock_loss')).toBe(true);
    expect(isOperatingExpense('inventory_purchase')).toBe(false);
    expect(isOperatingExpense('owner_draw')).toBe(false);
  });

  it('is offered in the catalogue, next to the purchase it is the other half of', () => {
    const keys = EXPENSE_CATEGORIES.map((c) => c.key);
    expect(keys[keys.indexOf('inventory_purchase') + 1]).toBe('stock_loss');
    expect(expenseCategoryLabel('stock_loss')).toBe('Stock loss');
  });
});
```

Add `expenseCategoryLabel` and `EXPENSE_CATEGORIES` to that file's imports if they are not already there.

- [ ] **Step 7: Run them and verify they fail**

Run: `npx jest src/lib/__tests__/permissions.test.ts src/lib/__tests__/expense-reporting.test.ts`
Expected: FAIL — `expandPermissions(['inventory.count'])` returns `[]` (the string is not in the catalogue, so it is dropped), and `isOperatingExpense('stock_loss')` is a type error.

- [ ] **Step 8: Extend the permission catalogue**

In `src/lib/permissions.ts`, add the two members to the `Permission` union directly after `'inventory.edit'`:

```ts
  | 'inventory.edit'
  | 'inventory.count'
  | 'inventory.transfer'
```

Widen the `PERMISSIONS` array's element type and add the two entries directly after `inventory.edit`'s:

```ts
export const PERMISSIONS: {
  key: Permission;
  label: string;
  description: string;
  // Which permission this one sits UNDER in the role editor. Presentation and
  // cascade only -- the stored array is always explicit, and the database reads
  // the child string on its own (save_stock_count checks 'inventory.count', not
  // 'inventory.edit'). Set on a child, absent on everything else.
  parent?: Permission;
}[] = [
  // ...
  {
    key: 'inventory.edit',
    label: 'Change stock',
    // Says what it covers TODAY rather than what the split would like it to
    // cover. The mockup draws a separate "Edit the catalogue" row above this
    // one, and until that exists inventory.edit is still what the products
    // insert/update/delete policies check (0024_permission_gates.sql:85-91) --
    // so a description naming only the stock verbs would be a lie on the one
    // screen a shop reads to decide who gets what.
    description:
      'Receive deliveries, count, and move between stores. Also covers adding and editing products, until catalogue editing gets its own permission.',
  },
  {
    key: 'inventory.count',
    label: '… count and write off',
    description:
      'Record a stock-take, including marking units as damaged, expired or lost. There is no invoice behind a write-off.',
    parent: 'inventory.edit',
  },
  {
    key: 'inventory.transfer',
    label: '… move between stores',
    description: 'Send units from one branch to another.',
    parent: 'inventory.edit',
  },
```

And extend `IMPLIED_PERMISSIONS`:

```ts
export const IMPLIED_PERMISSIONS: Partial<Record<Permission, Permission[]>> = {
  'inventory.edit': ['inventory.view'],
  // Both levels are listed, not just the parent. expandPermissions folds
  // exactly ONE level (it does not walk the graph), so 'inventory.edit' alone
  // here would resolve a count-only role as unable to open Inventory at all --
  // the screen it counts on. Listing both is also what makes roles-panel's
  // `dependents` filter work in the other direction: turning "Change stock"
  // off finds every permission that implies it and clears them too, which is
  // the nesting being real rather than visual.
  'inventory.count': ['inventory.edit', 'inventory.view'],
  'inventory.transfer': ['inventory.edit', 'inventory.view'],
  'sales.edit': ['sales.view'],
  // ... the rest unchanged
};
```

In `src/lib/permission-groups.ts:12`, extend the Inventory group so the Team pane's read-only grid shows them:

```ts
  { label: 'Inventory', permissions: ['inventory.view', 'inventory.edit', 'inventory.count', 'inventory.transfer'] },
```

- [ ] **Step 9: Add the expense category**

In `src/types/models.ts`, add to the `ExpenseCategory` union directly after `'inventory_purchase'`:

```ts
  | 'inventory_purchase'
  | 'stock_loss'
```

In `src/lib/expense-reporting.ts`, add the catalogue entry directly after `inventory_purchase`'s, and leave `NON_OPERATING_CATEGORIES` alone:

```ts
export const EXPENSE_CATEGORIES: { key: ExpenseCategory; label: string }[] = [
  { key: 'inventory_purchase', label: 'Inventory restock' },
  // Stock the shop paid for and will never sell -- stolen, broken, expired, or
  // simply never there. Written by the Count sheet, and by hand from the
  // expense editor like any other category.
  //
  // Deliberately NOT in NON_OPERATING_CATEGORIES below, which is where its
  // neighbour above sits. That exclusion is right for a purchase, because stock
  // is an asset that becomes COGS through sale_items.unit_cost_cents when it
  // sells. Shrinkage never sells, so its cost reaches the P&L by no other path
  // at all -- and excluding it here would rebuild, one line lower, exactly the
  // silence the Count door was built to end.
  { key: 'stock_loss', label: 'Stock loss' },
  { key: 'rent', label: 'Rent' },
  // ... the rest unchanged
];
```

- [ ] **Step 10: Run the tests and verify they pass**

Run: `npx jest src/lib/__tests__/permissions.test.ts src/lib/__tests__/expense-reporting.test.ts && npm test && npm run lint && npx tsc --noEmit`
Expected: the new cases pass, the whole Jest suite is green, no lint or type errors. `tsc` is the check that matters most here — widening `ExpenseCategory` makes every exhaustive `switch` over it fail to compile if one exists.

- [ ] **Step 11: Commit**

```bash
git add supabase/migrations/20260903000000_inventory_verbs_and_stock_loss.sql \
  supabase/tests/verify-inventory-permissions.sql \
  src/lib/permissions.ts src/lib/permission-groups.ts src/lib/expense-reporting.ts \
  src/types/models.ts src/lib/__tests__/permissions.test.ts src/lib/__tests__/expense-reporting.test.ts
git commit -m "feat(inventory): counting and moving stock are permissions of their own"
```

---

### Task 2: The count tables and the `save_stock_count()` RPC

**Files:**
- Create: `supabase/migrations/20260903000100_stock_counts.sql`
- Create: `supabase/tests/verify-stock-counts.sql`

**Interfaces:**
- Consumes: `public.has_shop_permission`, `public.enforce_shop_module`, `public.product_location_stock`, `public.shop_locations`, `public.products` — all existing. `'inventory.count'` from Task 1.
- Produces: `public.save_stock_count(p_shop_id uuid, p_location_id uuid, p_items jsonb, p_note text) returns uuid`. Each element of `p_items` is `{"product_id": uuid, "counted_quantity": int, "reason": text|null}`, where `reason` is one of `damaged`, `expired`, `theft_or_loss`, `miscount`, `other`, or null. Tables `public.stock_counts(id, shop_id, location_id, note, created_by, created_at)` and `public.stock_count_items(id, count_id, product_id, product_name, previous_quantity, counted_quantity, variance, reason, unit_cost_cents)`.

- [ ] **Step 1: Write the failing verify script**

Create `supabase/tests/verify-stock-counts.sql`:

```sql
-- A stock-take: what the count BECOMES, what is left alone, and who is allowed.
--
-- Eight groups of checks, none of which the TypeScript suite can make, because
-- every one is enforced by the database itself:
--
--   1. the count is REPLACED, not added to. This is the whole distinction from
--      receive_stock and the reason the Count door exists at all -- if these two
--      RPCs ever converge, one of them is silently wrong and no screen will say
--      which.
--   2. a count that finds MORE works the same way, and the variance is signed.
--   3. zero is a valid count and negative is refused. "The shelf was empty" is
--      a real finding; "minus three units" is not a quantity.
--   4. PRODUCTS ABSENT FROM THE COUNT ARE UNTOUCHED. A stock-take of one shelf
--      leaves the other two hundred products alone. The alternative -- treating
--      a count as authoritative for the whole store and zeroing anything not in
--      it -- would erase a shop's inventory from one afternoon's work on aisle
--      three, which is why it is asserted rather than assumed.
--   5. the RPC checks inventory.count ITSELF. A member holding inventory.edit
--      (and so able to receive a delivery) but not inventory.count is refused.
--      The sheet must not be the only thing between a cashier and a write-off.
--   6. another shop's location, and another shop's product, are both refused.
--   7. a reason is optional, and an unrecognised one is refused.
--   8. counting is gated on the `inventory` module, NOT on `multi_location`.
--      stock_transfers IS gated on multi_location because a movement needs two
--      branches; a stock-take needs one, and a one-store shop on any plan has
--      to be able to do one. stock_receipts already gets this right.
--
-- Everything runs inside one DO block whose EXCEPTION clause rolls it all back.

\set ON_ERROR_STOP on

do $$
declare
  v_owner_id      uuid := gen_random_uuid();
  v_counter_id    uuid := gen_random_uuid();
  v_receiver_id   uuid := gen_random_uuid();
  v_other_owner   uuid := gen_random_uuid();
  v_shop_id       uuid;
  v_location_id   uuid;
  v_other_shop    uuid;
  v_other_loc     uuid;
  v_other_product uuid;
  v_serum         uuid;
  v_centella      uuid;
  v_sun           uuid;
  v_count_role    uuid;
  v_edit_role     uuid;
  v_standard_id   uuid;
  v_count_id      uuid;
  v_stock         integer;
  v_previous      integer;
  v_variance      integer;
  v_cost          integer;
  v_reason        text;
  v_rows          integer;
  v_raised        boolean;
  v_message       text;
begin
  -- shops.owner_id, shop_members.user_id and stock_counts.created_by all
  -- reference auth.users(id), so every fixture "person" needs a real row there
  -- before anything else.
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
    select u, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
           'verify-stock-counts-' || u || '@example.test', '', now(), now(), now()
      from unnest(array[v_owner_id, v_counter_id, v_receiver_id, v_other_owner]) u;

  insert into public.shops (owner_id, name) values (v_owner_id, 'Count Shop') returning id into v_shop_id;
  insert into public.shop_locations (shop_id, name, is_primary) values (v_shop_id, 'Jaalala Skincare', true)
    returning id into v_location_id;

  -- Opening stock lands at the primary location by trigger (20260810000000),
  -- so each of these has a product_location_stock row at v_location_id.
  insert into public.products (shop_id, name, price_cents, cost_cents, stock)
    values (v_shop_id, 'Torriden Balanceful Serum', 1200, 461, 11) returning id into v_serum;
  insert into public.products (shop_id, name, price_cents, cost_cents, stock)
    values (v_shop_id, 'SKIN1004 Madagascar Centella', 900, 461, 24) returning id into v_centella;
  insert into public.products (shop_id, name, price_cents, cost_cents, stock)
    values (v_shop_id, 'Beauty of Joseon Relief Sun', 1500, null, 12) returning id into v_sun;

  perform set_config('request.jwt.claims', json_build_object('sub', v_owner_id)::text, true);
  perform set_config('role', 'authenticated', true);

  -- 1. Eleven becomes eight. Not nineteen.
  v_count_id := public.save_stock_count(
    v_shop_id, v_location_id,
    jsonb_build_array(
      jsonb_build_object('product_id', v_serum, 'counted_quantity', 8, 'reason', 'damaged')
    ),
    'monday shelf walk'
  );

  select stock into v_stock from public.product_location_stock
    where product_id = v_serum and location_id = v_location_id;
  if v_stock <> 8 then
    raise exception 'FAIL: a count of 8 against 11 should leave 8, got % (19 means it ADDED)', v_stock;
  end if;
  select stock into v_stock from public.products where id = v_serum;
  if v_stock <> 8 then
    raise exception 'FAIL: the products rollup should follow to 8, got %', v_stock;
  end if;

  select previous_quantity, variance, reason, unit_cost_cents
    into v_previous, v_variance, v_reason, v_cost
    from public.stock_count_items where count_id = v_count_id and product_id = v_serum;
  if v_previous <> 11 then
    raise exception 'FAIL: the line should record what the app believed (11), got %', v_previous;
  end if;
  if v_variance <> -3 then
    raise exception 'FAIL: the variance should be -3, got %', v_variance;
  end if;
  if v_reason <> 'damaged' then
    raise exception 'FAIL: the reason should be recorded, got %', v_reason;
  end if;
  -- Frozen at count time from products.cost_cents. Without it a count from six
  -- months ago cannot be valued at all once a delivery has moved the cost, and
  -- "what did last quarter's shrinkage cost" is unanswerable.
  if v_cost <> 461 then
    raise exception 'FAIL: the unit cost should be frozen at 461, got %', v_cost;
  end if;

  -- 2. Twenty-four becomes twenty-six, and the variance is signed.
  v_count_id := public.save_stock_count(
    v_shop_id, v_location_id,
    jsonb_build_array(jsonb_build_object('product_id', v_centella, 'counted_quantity', 26, 'reason', null)),
    null
  );
  select stock into v_stock from public.product_location_stock
    where product_id = v_centella and location_id = v_location_id;
  if v_stock <> 26 then
    raise exception 'FAIL: a count of 26 against 24 should leave 26, got %', v_stock;
  end if;
  select variance, reason into v_variance, v_reason
    from public.stock_count_items where count_id = v_count_id and product_id = v_centella;
  if v_variance <> 2 then
    raise exception 'FAIL: finding two extra should be +2, got %', v_variance;
  end if;
  -- 7a. A blank reason is stored as a blank reason. It is NOT defaulted to
  --     'miscount' -- a precise-looking answer to a question nobody asked, and
  --     the same instinct migration 20260804000000 refused when it would not
  --     backfill historical costs. The gap is the finding.
  if v_reason is not null then
    raise exception 'FAIL: a missing reason must stay missing, got %', v_reason;
  end if;

  -- 3. Zero is a real count; negative is not a quantity.
  v_count_id := public.save_stock_count(
    v_shop_id, v_location_id,
    jsonb_build_array(jsonb_build_object('product_id', v_centella, 'counted_quantity', 0, 'reason', 'theft_or_loss')),
    null
  );
  select stock into v_stock from public.product_location_stock
    where product_id = v_centella and location_id = v_location_id;
  if v_stock <> 0 then
    raise exception 'FAIL: an empty shelf counted as 0 should leave 0, got %', v_stock;
  end if;

  v_raised := false;
  v_message := null;
  begin
    perform public.save_stock_count(v_shop_id, v_location_id,
      jsonb_build_array(jsonb_build_object('product_id', v_serum, 'counted_quantity', -3, 'reason', null)),
      null);
  exception when others then
    v_raised := true;
    get stacked diagnostics v_message = message_text;
  end;
  if not v_raised then
    raise exception 'FAIL: a negative counted quantity should raise';
  end if;
  if v_message !~ 'counted quantity' then
    raise exception 'FAIL: expected the quantity guard to fire by name, got %', v_message;
  end if;

  -- 4. THE HEADLINE RULE: a count covers only the lines it contains.
  --
  --    v_sun has never appeared in any count above and must still hold 12. A
  --    regression that treated a count as authoritative for the whole store
  --    would leave it at 0 here, and nothing on any screen would say so until a
  --    shop tried to sell something it still had.
  select stock into v_stock from public.product_location_stock
    where product_id = v_sun and location_id = v_location_id;
  if v_stock <> 12 then
    raise exception 'FAIL: a product absent from every count must keep its 12, got %', v_stock;
  end if;
  select count(*) into v_rows from public.stock_count_items where product_id = v_sun;
  if v_rows <> 0 then
    raise exception 'FAIL: a product absent from every count must have no count lines, got %', v_rows;
  end if;

  -- 5. The permission is checked HERE, not on the sheet.
  perform set_config('role', 'postgres', true);
  insert into public.roles (shop_id, name, permissions)
    values (v_shop_id, 'Stock-taker', array['inventory.view', 'inventory.edit', 'inventory.count'])
    returning id into v_count_role;
  -- Exactly what a shop gets by turning the child OFF in the role editor:
  -- someone who can receive a delivery and cannot write anything off.
  insert into public.roles (shop_id, name, permissions)
    values (v_shop_id, 'Goods-in', array['inventory.view', 'inventory.edit'])
    returning id into v_edit_role;
  insert into public.shop_members (shop_id, user_id, role_id, active)
    values (v_shop_id, v_counter_id, v_count_role, true);
  insert into public.shop_members (shop_id, user_id, role_id, active)
    values (v_shop_id, v_receiver_id, v_edit_role, true);
  perform set_config('role', 'authenticated', true);

  perform set_config('request.jwt.claims', json_build_object('sub', v_receiver_id)::text, true);
  v_raised := false;
  v_message := null;
  begin
    perform public.save_stock_count(v_shop_id, v_location_id,
      jsonb_build_array(jsonb_build_object('product_id', v_sun, 'counted_quantity', 1, 'reason', null)),
      null);
  exception when others then
    v_raised := true;
    get stacked diagnostics v_message = message_text;
  end;
  if not v_raised then
    raise exception 'FAIL: inventory.edit alone must not be enough to write stock off';
  end if;
  if v_message !~ '^not authorized for shop' then
    raise exception 'FAIL: expected the permission guard to fire, got %', v_message;
  end if;
  -- And the refusal wrote nothing. A guard that raises after the count row is
  -- inserted would leave a stock-take on record that never happened.
  select stock into v_stock from public.product_location_stock
    where product_id = v_sun and location_id = v_location_id;
  if v_stock <> 12 then
    raise exception 'FAIL: a refused count must leave the shelf alone, got %', v_stock;
  end if;

  perform set_config('request.jwt.claims', json_build_object('sub', v_counter_id)::text, true);
  perform public.save_stock_count(v_shop_id, v_location_id,
    jsonb_build_array(jsonb_build_object('product_id', v_sun, 'counted_quantity', 10, 'reason', 'expired')),
    null);
  select stock into v_stock from public.product_location_stock
    where product_id = v_sun and location_id = v_location_id;
  if v_stock <> 10 then
    raise exception 'FAIL: a member holding inventory.count should be able to count, got %', v_stock;
  end if;
  -- An uncosted product records a null unit cost rather than a zero. Zero is a
  -- real answer (a free sample), and writing it here would let the shortfall
  -- total read as complete when it is not -- the exact lie the checkbox in
  -- Task 9 hides itself rather than tell.
  select unit_cost_cents into v_cost
    from public.stock_count_items where product_id = v_sun order by id desc limit 1;
  if v_cost is not null then
    raise exception 'FAIL: an uncosted product should freeze a NULL cost, got %', v_cost;
  end if;

  perform set_config('request.jwt.claims', json_build_object('sub', v_owner_id)::text, true);

  -- 6. Another shop's location, and another shop's product.
  perform set_config('role', 'postgres', true);
  insert into public.shops (owner_id, name) values (v_other_owner, 'Someone Else')
    returning id into v_other_shop;
  insert into public.shop_locations (shop_id, name, is_primary) values (v_other_shop, 'Theirs', true)
    returning id into v_other_loc;
  insert into public.products (shop_id, name, price_cents, cost_cents, stock)
    values (v_other_shop, 'Their Product', 500, null, 7) returning id into v_other_product;
  perform set_config('role', 'authenticated', true);

  v_raised := false;
  v_message := null;
  begin
    perform public.save_stock_count(v_shop_id, v_other_loc,
      jsonb_build_array(jsonb_build_object('product_id', v_serum, 'counted_quantity', 1, 'reason', null)),
      null);
  exception when others then
    v_raised := true;
    get stacked diagnostics v_message = message_text;
  end;
  if not v_raised then
    raise exception 'FAIL: counting into another shop''s location should raise';
  end if;
  if v_message !~ '^the counted location must belong to shop' then
    raise exception 'FAIL: expected the location guard to fire, got %', v_message;
  end if;

  v_raised := false;
  v_message := null;
  begin
    perform public.save_stock_count(v_shop_id, v_location_id,
      jsonb_build_array(jsonb_build_object('product_id', v_other_product, 'counted_quantity', 1, 'reason', null)),
      null);
  exception when others then
    v_raised := true;
    get stacked diagnostics v_message = message_text;
  end;
  if not v_raised then
    raise exception 'FAIL: counting another shop''s product should raise';
  end if;
  if v_message !~ '^product .* not found in this shop' then
    raise exception 'FAIL: expected the product guard to fire, got %', v_message;
  end if;
  -- Their shelf is untouched, which is what the guard is actually protecting.
  select stock into v_stock from public.product_location_stock
    where product_id = v_other_product and location_id = v_other_loc;
  if v_stock <> 7 then
    raise exception 'FAIL: another shop''s stock must not move, got %', v_stock;
  end if;

  -- 7b. An unrecognised reason is refused rather than stored as free text. The
  --     five are a closed set because the preview counts them ("9 with no
  --     reason") and a sixth spelling would quietly become a sixth category.
  v_raised := false;
  begin
    perform public.save_stock_count(v_shop_id, v_location_id,
      jsonb_build_array(jsonb_build_object('product_id', v_serum, 'counted_quantity', 5, 'reason', 'shrinkage')),
      null);
  exception when others then v_raised := true;
  end;
  if not v_raised then
    raise exception 'FAIL: an unrecognised reason should raise';
  end if;

  -- 8. Counting is gated on `inventory`, never on `multi_location`.

  -- 8a. Structural sanity: the trigger on stock_counts does not name
  --     multi_location. Necessary but not sufficient on its own -- this alone
  --     would still pass if the gate moved inside save_stock_count(), or if the
  --     inventory gate were removed entirely. 8b and 8c are the behaviour.
  if exists (
    select 1 from pg_trigger t
      join pg_class c on c.oid = t.tgrelid
    where c.relname = 'stock_counts'
      and pg_get_triggerdef(t.oid) ilike '%multi_location%'
  ) then
    raise exception 'FAIL: stock_counts must not be gated on multi_location';
  end if;

  -- 8b. A shop on the Standard tier -- which carries `inventory` and not
  --     `multi_location` -- must still be able to do a stock-take. The fixture
  --     shop is on a fresh trial granting every module, so the scenario has to
  --     be forced rather than assumed.
  select id into v_standard_id from public.plans where key = 'standard';
  perform set_config('role', 'postgres', true);
  update public.shop_subscriptions set plan_id = v_standard_id where shop_id = v_shop_id;
  perform set_config('role', 'authenticated', true);

  if public.shop_has_module(v_shop_id, 'multi_location') then
    raise exception 'FIXTURE: the standard plan unexpectedly grants multi_location';
  end if;
  if not public.shop_has_module(v_shop_id, 'inventory') then
    raise exception 'FIXTURE: the standard plan unexpectedly lacks inventory';
  end if;

  perform public.save_stock_count(v_shop_id, v_location_id,
    jsonb_build_array(jsonb_build_object('product_id', v_serum, 'counted_quantity', 4, 'reason', null)),
    null);
  select stock into v_stock from public.product_location_stock
    where product_id = v_serum and location_id = v_location_id;
  if v_stock <> 4 then
    raise exception 'FAIL: a one-store shop without multi_location should still count, got %', v_stock;
  end if;

  -- 8c. And the inventory gate genuinely bites: a shop that has lost every
  --     module (the operator's suspend switch, same mechanism as
  --     verify-entitlements.sql's kill-switch check) is refused by name.
  perform set_config('role', 'postgres', true);
  update public.shop_subscriptions set manual_status = 'suspended' where shop_id = v_shop_id;
  perform set_config('role', 'authenticated', true);

  v_raised := false;
  v_message := null;
  begin
    perform public.save_stock_count(v_shop_id, v_location_id,
      jsonb_build_array(jsonb_build_object('product_id', v_serum, 'counted_quantity', 3, 'reason', null)),
      null);
  exception when others then
    v_raised := true;
    get stacked diagnostics v_message = message_text;
  end;
  if not v_raised then
    raise exception 'FAIL: a shop lacking the inventory module should be refused';
  end if;
  if v_message <> 'module_not_included' then
    raise exception 'FAIL: expected module_not_included, got %', v_message;
  end if;

  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims', null, true);
  raise notice 'ALL CHECKS PASSED';
  raise exception 'rollback fixture';
exception
  when others then
    perform set_config('role', 'postgres', true);
    perform set_config('request.jwt.claims', null, true);
    if sqlerrm = 'rollback fixture' then
      return;
    end if;
    raise;
end $$;
```

- [ ] **Step 2: Run it and verify it fails**

Run: `npm run test:db -- --no-reset`
Expected: `verify-stock-counts  FAIL` with `ERROR: function public.save_stock_count(...) does not exist`.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/20260903000100_stock_counts.sql`:

```sql
-- A stock-take.
--
-- The fourth stock job, and the sharp one. The other three are recoverable:
-- Restock adds units against an invoice, Move relocates them and leaves the
-- shop total alone, Import creates catalogue rows. Count DESTROYS units against
-- nothing, and there is no counterparty and no paperwork -- a Restock
-- overstating by 40 is caught by the supplier's invoice, while a Count writing
-- 11 down to 8 is one person's word that three units are not there.
--
-- ## Why this is not receive_stock with a minus sign
--
-- receive_stock ADDS: `stock = stock + excluded.stock`. This one SETS:
-- `stock = excluded.stock`. That single line is the entire difference between
-- the two doors and the reason both exist -- a shop that walks a shelf knows
-- how many are on it, not how many have gone missing since Tuesday, and asking
-- them to subtract is asking them to do the arithmetic the app is for. The
-- variance is computed here, from what the shop holds at the moment of the
-- count, and recorded.
--
-- ## Why the shrinkage was invisible before this table existed
--
-- COGS is built from sale_items.unit_cost_cents, frozen at sale time. A unit
-- that is stolen, breaks or expires is NEVER SOLD, so its cost never enters
-- COGS by any path. It leaves Stock at cost and is simply gone, and the P&L
-- never hears about it -- gross profit reads higher than it is by exactly the
-- cost of everything that walked out, every month, invisibly. Per-product stock
-- could already be edited inline on the Inventory list, which is a count one
-- product at a time with no reason, no record and no P&L effect, so this has
-- been true for as long as the app has had stock. stock_count_items therefore
-- freezes unit_cost_cents alongside the variance: the value of what went
-- missing has to be answerable later, from the record, and not recomputed from
-- a cost some later delivery has since overwritten.
--
-- Modelled on receive_stock() deliberately, down to the lock ordering, because
-- the two are the same shape: change counts and write a record, in one
-- transaction, through a security definer function with no write policy behind
-- it. The differences are stated where they occur.

create table public.stock_counts (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  -- NO ACTION, not cascade -- the default, and the same choice stock_receipts
  -- and stock_transfers make. Deleting a location must not erase the history of
  -- what was counted there; a branch is deactivated, never deleted, once it has
  -- traded.
  location_id uuid not null references public.shop_locations(id),
  -- One free-text note for the whole count ("monday shelf walk", "after the
  -- flood"). The REASONS are per line and live on the items below: one
  -- stock-take finds different causes on different shelves -- sun cream
  -- expired, toner walked -- and a single reason across the whole count would
  -- be wrong on almost every line it covered.
  note text,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);
create index stock_counts_shop_idx on public.stock_counts(shop_id, created_at desc);
create index stock_counts_location_idx on public.stock_counts(location_id, created_at desc);

create table public.stock_count_items (
  id uuid primary key default gen_random_uuid(),
  count_id uuid not null references public.stock_counts(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete cascade,
  -- Frozen at count time, exactly as stock_receipt_items and sale_items freeze
  -- it: a later rename must not restate what a past stock-take found.
  product_name text not null,
  -- What the app believed, read under a row lock immediately before it was
  -- replaced. Recorded because "who said these three were gone, and when?" is
  -- the whole reason to build this door rather than keep editing counts inline,
  -- and that question cannot be answered from the new number alone.
  previous_quantity integer not null,
  -- Zero is allowed and negative is not. An empty shelf is a real finding and
  -- one of the most important a stock-take makes; minus three units is not a
  -- quantity anybody counted.
  counted_quantity integer not null check (counted_quantity >= 0),
  -- Generated rather than passed in, so the record and the arithmetic cannot
  -- disagree. A client that computed this itself would be a second opinion on a
  -- subtraction, and the two would eventually differ on some row nobody looks at.
  variance integer generated always as (counted_quantity - previous_quantity) stored,
  -- Optional, and a closed set. Optional because requiring a reason on every
  -- one of sixteen variances is how a 300-line stock-take stops getting done,
  -- or gets done with sixteen 'miscount's that mean nothing -- so a blank is
  -- allowed and the preview says "9 with no reason" out loud instead, because
  -- unexplained shrinkage is itself the finding. Closed because the preview
  -- COUNTS them, and a sixth spelling would quietly become a sixth category.
  reason text check (reason is null or reason in ('damaged', 'expired', 'theft_or_loss', 'miscount', 'other')),
  -- What a unit cost at the moment of the count, frozen. Null where the product
  -- is uncosted -- null, never zero, because zero is a real answer (a free
  -- sample) and isUncosted() in product-costing.ts is careful about exactly
  -- this. Without the freeze, valuing a count from six months ago would use
  -- whatever cost the most recent delivery happened to leave behind.
  unit_cost_cents integer check (unit_cost_cents is null or unit_cost_cents >= 0)
);
create index stock_count_items_count_idx on public.stock_count_items(count_id);
-- "What has this product been counted at, and how often did it come up short?"
-- is the question a shrinkage report asks, and it asks it per product.
create index stock_count_items_product_idx on public.stock_count_items(product_id);

alter table public.stock_counts enable row level security;
alter table public.stock_count_items enable row level security;

create policy "read stock_counts" on public.stock_counts for select using (is_shop_member(shop_id));
create policy "read stock_count_items" on public.stock_count_items for select
  using (exists (select 1 from public.stock_counts c where c.id = count_id and is_shop_member(c.shop_id)));

-- No insert/update/delete policy, on purpose and for the same reason as
-- stock_receipts and stock_transfers: a count is only ever created through
-- save_stock_count() below, which changes the numbers and writes the record in
-- one transaction. A direct insert would record a stock-take that never
-- happened -- and here that is worse than elsewhere, because the record IS the
-- accountability the door exists to provide.
grant select on public.stock_counts, public.stock_count_items to authenticated;

-- Gated on `inventory`, NOT on `multi_location`.
--
-- stock_transfers is gated on multi_location because a movement needs two
-- branches to exist at all. A stock-take needs one. Copying that trigger across
-- would lock every single-store shop out of the door -- and a single-store shop
-- is the most common shop on the platform and the one with nobody else to check
-- its shelves. stock_receipts already makes this same divergence for the same
-- reason; this is not a new judgement, it is the same one.
create trigger stock_counts_module before insert or update on public.stock_counts
  for each row execute function public.enforce_shop_module('inventory');

-- Replaces the count at one store with what was actually found, records the
-- variance and why, and leaves every product it was not given alone.
--
-- ## Why the permission is checked here and not only on the sheet
--
-- 'inventory.count', not 'inventory.edit'. Every other stock RPC checks the
-- broader permission because receiving and moving are recoverable; this one
-- destroys value against no counterparty, so the narrow one is the whole point
-- of it existing. Checking it in the client alone would make the sheet the only
-- thing standing between a cashier and a write-off, and the sheet is JavaScript
-- on a device the shop does not control.
--
-- ## What this deliberately does NOT do
--
-- It does not touch a product it was not given. A stock-take of one shelf
-- leaves the other two hundred products exactly as they were, and there is no
-- mode in which a count is "authoritative for the store". The alternative --
-- zeroing anything absent -- is a foot-gun that turns one afternoon on aisle
-- three into a wiped inventory, and it is not built, not flagged, and not
-- reachable.
create or replace function public.save_stock_count(
  p_shop_id uuid,
  p_location_id uuid,
  p_items jsonb,
  p_note text default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_count_id uuid;
  v_item jsonb;
  v_product public.products%rowtype;
  v_counted integer;
  v_previous integer;
  v_reason text;
  v_lines integer := 0;
begin
  -- Before anything is inserted, so a refusal leaves no half-written
  -- stock-take on record.
  if not public.has_shop_permission(p_shop_id, 'inventory.count') then
    raise exception 'not authorized for shop %', p_shop_id;
  end if;
  if not exists (select 1 from public.shop_locations where id = p_location_id and shop_id = p_shop_id) then
    raise exception 'the counted location must belong to shop %', p_shop_id;
  end if;
  if p_items is null or jsonb_array_length(p_items) = 0 then
    raise exception 'a count must include at least one line';
  end if;

  insert into public.stock_counts (shop_id, location_id, note, created_by)
    values (p_shop_id, p_location_id, nullif(p_note, ''), auth.uid())
    returning id into v_count_id;

  -- Ordered by product id so two concurrent counts touching the same products
  -- take their row locks in the same order and cannot deadlock -- the same
  -- reason receive_stock, transfer_stock and refund_sale_items order their
  -- loops. Ordinality is the tiebreaker: product id alone is not a total order
  -- when a sheet lists the same product twice, and without one the surviving
  -- count would be whichever line happened to sort second. With it, the last
  -- line in the sheet is the one that stands, which is the only reading a
  -- person can predict from what they are looking at.
  for v_item in
    select value from jsonb_array_elements(p_items) with ordinality as t(value, ord)
      order by (value->>'product_id'), ord
  loop
    v_counted := (v_item->>'counted_quantity')::integer;
    -- Zero passes. It is the finding a stock-take most often exists to make.
    if v_counted is null or v_counted < 0 then
      raise exception 'invalid counted quantity';
    end if;

    select * into v_product from public.products
      where id = (v_item->>'product_id')::uuid and shop_id = p_shop_id;
    if v_product.id is null then
      raise exception 'product % not found in this shop', v_item->>'product_id';
    end if;

    -- Read under a row lock and immediately replaced, so the number recorded as
    -- "what the app said" is the number this statement actually overwrote. A
    -- sale completing between the read and the write would otherwise be
    -- silently absorbed into the variance and attributed to shrinkage.
    --
    -- Null means the store has no row for this product at all -- it does not
    -- carry it. That is a legitimate thing to find three of on a shelf, so it
    -- counts as a previous of zero and the upsert creates the row.
    select stock into v_previous from public.product_location_stock
      where product_id = v_product.id and location_id = p_location_id
      for update;
    v_previous := coalesce(v_previous, 0);

    -- `= excluded.stock`, not `+`. THE line that makes this a Count.
    insert into public.product_location_stock (product_id, location_id, stock)
      values (v_product.id, p_location_id, v_counted)
      on conflict (product_id, location_id)
      do update set stock = excluded.stock, updated_at = now();

    -- nullif('') as well as a plain null: a client that sends an empty string
    -- for "no reason given" must not trip the check constraint, and an empty
    -- string is not a sixth reason.
    v_reason := nullif(v_item->>'reason', '');

    insert into public.stock_count_items
      (count_id, product_id, product_name, previous_quantity, counted_quantity, reason, unit_cost_cents)
      values (v_count_id, v_product.id, v_product.name, v_previous, v_counted, v_reason, v_product.cost_cents);

    v_lines := v_lines + 1;
  end loop;

  -- Unreachable, and kept anyway: jsonb_array_length above has already refused
  -- an empty array, and every element either records a line or raises. Mirrors
  -- receive_stock line for line so the two RPCs can be read side by side, and
  -- it is the backstop if either guard is ever loosened.
  if v_lines = 0 then
    raise exception 'cannot record a count with no lines';
  end if;
  return v_count_id;
end;
$$;

grant execute on function public.save_stock_count(uuid, uuid, jsonb, text) to authenticated;
```

- [ ] **Step 4: Run the database suite and verify it passes**

Run: `npm run test:db`
Expected: `verify-stock-counts  pass` and `verify-inventory-permissions  pass`, with the run ending `N database checks passed.` and no FAIL. The full reset also proves the migration chain still applies from empty.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260903000100_stock_counts.sql supabase/tests/verify-stock-counts.sql
git commit -m "feat(inventory): a stock-take has a table, a variance and an RPC"
```

---

### Task 3: `saveStockCount()` on the client

**Files:**
- Modify: `src/types/models.ts` (append directly after the `StockReceiptItem` type, around line 249)
- Modify: `src/lib/products.ts` (add directly after `receiveStock`, around line 206)

**Interfaces:**
- Consumes: `public.save_stock_count` from Task 2.
- Produces:
  - `type StockCountReason = 'damaged' | 'expired' | 'theft_or_loss' | 'miscount' | 'other'`
  - `type StockCount = { id: string; shopId: string; locationId: string; note: string | null; createdBy: string | null; createdAt: string }`
  - `type StockCountItem = { id: string; countId: string; productId: string; productName: string; previousQuantity: number; countedQuantity: number; variance: number; reason: StockCountReason | null; unitCostCents: number | null }`
  - `saveStockCount(shopId: string, locationId: string, lines: { productId: string; countedQuantity: number; reason: StockCountReason | null }[], options?: { note?: string | null }): Promise<string>` — returns the count id.

- [ ] **Step 1: Add the types**

In `src/types/models.ts`, directly after the `StockReceiptItem` type:

```ts
// Why a shop believes a line came up short (or long). Five, and a closed set,
// because the count preview reports how many lines have NONE ("9 with no
// reason") and a sixth spelling would quietly become a sixth category. The
// database stores exactly these strings (migration 20260903000100).
//
// A missing reason is `null` and stays null. It is deliberately never defaulted
// to 'miscount': that is a precise-looking answer to a question nobody asked,
// and unexplained shrinkage is itself the finding a shop needs to see.
export type StockCountReason = 'damaged' | 'expired' | 'theft_or_loss' | 'miscount' | 'other';

// A stock-take at one store. Written only by the save_stock_count RPC
// (migration 20260903000100) -- there is no write policy on the table, so a
// count always means numbers that actually changed, and by whom.
export type StockCount = {
  id: string;
  shopId: string;
  locationId: string;
  // One note for the whole walk. The reasons are per line, below: one
  // stock-take finds different causes on different shelves.
  note: string | null;
  createdBy: string | null;
  createdAt: string;
};

export type StockCountItem = {
  id: string;
  countId: string;
  productId: string;
  // Frozen at count time, like SaleItem's and StockReceiptItem's.
  productName: string;
  // What the app believed at the moment it was replaced. Without it the new
  // number alone cannot answer "who said these three were gone, and when?",
  // which is the whole reason this door exists rather than the inline stepper.
  previousQuantity: number;
  countedQuantity: number;
  // countedQuantity - previousQuantity, computed by the database as a generated
  // column so the record and the arithmetic cannot disagree. Negative is a
  // shortfall; positive means the app was wrong the other way.
  variance: number;
  reason: StockCountReason | null;
  // What a unit cost when it was counted, frozen. Null where the product is
  // uncosted -- null, never zero, because zero is a real answer (a free
  // sample). Frozen because valuing a count from six months ago must not use
  // whatever cost the most recent delivery happened to leave behind.
  unitCostCents: number | null;
};
```

- [ ] **Step 2: Add the client function**

In `src/lib/products.ts`, directly after `receiveStock`:

```ts
// Records a stock-take: SETS each line's count at one store to what was found,
// writes the variance and why, and leaves every product not in `lines` exactly
// as it was.
//
// The counterpart to receiveStock, and the one line of difference between them
// is the whole reason both exist. receiveStock ADDS to what a store holds --
// eleven becomes seventeen. This one REPLACES it -- eleven becomes eight, and
// the app records the −3. A shop walking a shelf knows how many are on it, not
// how many have gone missing since Tuesday.
//
// `reason` null means the shop did not say, and it is stored as not said. It is
// never defaulted: the count preview reports how many lines have no reason,
// because unexplained shrinkage is the finding.
//
// Gated on `inventory.count` inside the RPC, not on `inventory.edit` -- someone
// who can receive a delivery cannot necessarily write stock off.
export async function saveStockCount(
  shopId: string,
  locationId: string,
  lines: { productId: string; countedQuantity: number; reason: StockCountReason | null }[],
  options?: { note?: string | null }
): Promise<string> {
  const { data, error } = await supabase.rpc('save_stock_count', {
    p_shop_id: shopId,
    p_location_id: locationId,
    p_items: lines.map((line) => ({
      product_id: line.productId,
      counted_quantity: line.countedQuantity,
      reason: line.reason,
    })),
    p_note: options?.note ?? null,
  });
  if (error) throw error;
  return data as string;
}
```

Extend the file's existing type import so `StockCountReason` is in scope:

```ts
import type { NewProductInput, Product, ProductLocationStock, StockCountReason } from '@/types/models';
```

- [ ] **Step 3: Verify it typechecks and the suite is still green**

Run: `npx tsc --noEmit && npm test && npm run lint`
Expected: no TypeScript errors; the existing Jest suite passes unchanged.

Check by eye that the four RPC parameter names above (`p_shop_id`, `p_location_id`, `p_items`, `p_note`) match the `grant execute on function public.save_stock_count(uuid, uuid, jsonb, text)` signature in Task 2's migration. `tsc` cannot see across that boundary, and a misnamed parameter is a runtime "function does not exist" that only appears on a device.

- [ ] **Step 4: Commit**

```bash
git add src/types/models.ts src/lib/products.ts
git commit -m "feat(inventory): saveStockCount() calls the stock-take RPC"
```

---

### Task 4: `count-import.ts` — the pure plan, and the reader zero is allowed into

**Files:**
- Create: `src/lib/count-import.ts`
- Test: `src/lib/__tests__/count-import.test.ts`
- Modify: `src/lib/restock-typed-input.ts:187-192` (add `readCountedQuantity`, sharing `readTypedQuantity`'s guts)
- Test: `src/lib/__tests__/restock-typed-input.test.ts`

**Interfaces:**
- Consumes: `normalizeBarcode` from `@/lib/barcode`; `CsvColumn`, `ParsedCsv` from `@/lib/csv`; `RejectedRow`, `TemplateColumn` from `@/lib/import-shared`; `isUncosted` from `@/lib/product-costing`; `Product`, `ShopLocation`, `StockCountReason` from `@/types/models` (Task 3).
- Produces:
  - `readCountedQuantity(text: string): number | null` from `@/lib/restock-typed-input`
  - `COUNT_REASONS: { key: StockCountReason; label: string }[]`
  - `reasonLabel(key: StockCountReason): string`
  - `COUNT_TEMPLATE_COLUMNS: TemplateColumn[]`
  - `type CountSheetRow = { product: Product; location: ShopLocation; stock: number; shelfNumber: string | null }`
  - `COUNT_SHEET_COLUMNS: CsvColumn<CountSheetRow>[]`
  - `countSheetRows(locations: ShopLocation[], entries: CountSheetRow[]): CountSheetRow[]`
  - `type PlannedCountLine = { productId: string; productName: string; previousQuantity: number; countedQuantity: number; variance: number; reason: StockCountReason | null; unitCostCents: number | null }`
  - `type PlannedCount = { locationId: string; locationName: string; lines: PlannedCountLine[] }`
  - `type CountPlan = { counts: PlannedCount[]; rejected: RejectedRow[]; skipped: number }`
  - `planCount(parsed: ParsedCsv, context: { products: Product[]; locations: ShopLocation[]; stockAt: (productId: string, locationId: string) => number }): CountPlan`
  - `planLines(plan: CountPlan): PlannedCountLine[]`
  - `type CountSummary = { counted: number; matched: number; differ: number; varianceUnits: number; varianceCents: number | null; shortfallCents: number | null; uncostedDifferingLines: number; uncostedShortfallLines: number; reasonlessLines: number }`
  - `summariseCount(lines: PlannedCountLine[]): CountSummary`

- [ ] **Step 1: Write the failing test for the counted-quantity reader**

In `src/lib/__tests__/restock-typed-input.test.ts`, add:

```ts
// Zero is the one difference between the two readers, and it is not a detail.
//
// readTypedQuantity refuses 0 because a delivery of nothing is a mistake in a
// sheet, not a no-op. A COUNT of zero is the opposite: an empty shelf is one of
// the most important findings a stock-take makes, and refusing it would mean
// the door could record every loss except a total one.
//
// Everything else -- the digits-only rule, the Postgres integer ceiling, the
// refusal of a minus sign -- is shared, deliberately, so the two entry routes
// cannot drift the way the cost readers did.
describe('readCountedQuantity', () => {
  it('accepts an empty shelf where readTypedQuantity will not', () => {
    expect(readCountedQuantity('0')).toBe(0);
    expect(readTypedQuantity('0')).toBeNull();
  });

  it('reads an ordinary count', () => {
    expect(readCountedQuantity('8')).toBe(8);
    expect(readCountedQuantity(' 26 ')).toBe(26);
  });

  it('refuses everything readTypedQuantity refuses, for the same reasons', () => {
    expect(readCountedQuantity('')).toBeNull();
    expect(readCountedQuantity('   ')).toBeNull();
    expect(readCountedQuantity('-3')).toBeNull();
    expect(readCountedQuantity('2a')).toBeNull();
    expect(readCountedQuantity('2.5')).toBeNull();
    expect(readCountedQuantity('1e3')).toBeNull();
  });

  // stock_count_items.counted_quantity is a Postgres `integer`. A pasted cell
  // past it has to be caught here, while nothing has been written, rather than
  // inside the RPC halfway through a commit.
  it('refuses more units than the column can hold', () => {
    expect(readCountedQuantity('2147483647')).toBe(2147483647);
    expect(readCountedQuantity('2147483648')).toBeNull();
  });
});
```

Add `readCountedQuantity` to that file's import from `@/lib/restock-typed-input`.

- [ ] **Step 2: Run it and verify it fails**

Run: `npx jest src/lib/__tests__/restock-typed-input.test.ts`
Expected: FAIL — `readCountedQuantity is not a function`.

- [ ] **Step 3: Add the reader**

In `src/lib/restock-typed-input.ts`, replace the whole `readTypedQuantity` function at the foot of the file with this trio:

```ts
// The shared guts of both quantity readers. Digits only, no separators, no
// sign, and never past what the column can hold.
//
// `^[0-9]+$` already excludes a minus sign and anything with a decimal point,
// so `allowZero` is the ONLY axis the two callers differ on -- which is the
// point of factoring it: the ceiling, the digits rule and the safe-integer
// check are shared, so the by-hand field and the sheet cell cannot drift apart
// the way the two cost readers did before Task 5 of the restock plan merged
// them.
//
// The ceiling is the Postgres `integer` one, shared by
// stock_receipt_items.quantity (20260902000000:45) and
// stock_count_items.counted_quantity (20260903000100). Past it the RPC fails on
// the server with a raw "integer out of range", which reaches the shop as a
// Postgres error string on a screen that was otherwise explaining itself in
// sentences -- and, on a multi-store commit, after earlier stores have already
// gone through.
function readWholeNumber(text: string, options: { allowZero: boolean }): number | null {
  const trimmed = text.trim();
  if (!/^[0-9]+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value) || value > PG_INTEGER_MAX) return null;
  return options.allowZero || value > 0 ? value : null;
}

// null means "not a quantity that can be received" -- empty, zero, not a whole
// number, or more units than the column can hold. The caller blocks the commit
// and says so on screen; it does NOT delete the row, because the row carries a
// typed unit cost that would go with it, and clearing a field to retype it is
// an ordinary edit.
//
// Zero is refused because a delivery of nothing is a mistake in the sheet, not
// a no-op: skipping it silently would report a delivery larger than the one
// that actually landed.
export function readTypedQuantity(text: string): number | null {
  return readWholeNumber(text, { allowZero: false });
}

// The same reading, with zero allowed -- and the difference is the whole point.
//
// An empty shelf is a real finding, and often the most important one a
// stock-take makes. A reader that refused it would leave the Count door able to
// record every loss except a total one, and would push a shop towards typing 1
// for a product that is simply gone.
export function readCountedQuantity(text: string): number | null {
  return readWholeNumber(text, { allowZero: true });
}
```

- [ ] **Step 4: Run it and verify it passes**

Run: `npx jest src/lib/__tests__/restock-typed-input.test.ts src/lib/__tests__/restock-import.test.ts`
Expected: PASS — both suites, including every existing `readTypedQuantity` case unchanged. The restock suite matters here: it is the proof that factoring the shared body did not loosen the delivery reader.

- [ ] **Step 5: Write the failing test for the planner**

Create `src/lib/__tests__/count-import.test.ts`:

```ts
// The count sheet's rules, at the boundary a person actually meets them: a CSV
// generated the way the download button generates it, read back the way the
// picker reads it. Nothing here touches Supabase -- planCount is pure, which is
// what makes every rule below cheap enough to state as its own case.

import { parseCsvText, rowsToCsv, type ParsedCsv } from '@/lib/csv';
import {
  COUNT_SHEET_COLUMNS,
  COUNT_TEMPLATE_COLUMNS,
  countSheetRows,
  planCount,
  planLines,
  summariseCount,
  type CountSheetRow,
} from '@/lib/count-import';
import { missingRequiredColumns } from '@/lib/import-shared';
import type { Product, ShopLocation } from '@/types/models';

const MAIN = { id: 'loc-main', name: 'Jaalala Skincare', code: 'JL1', active: true } as ShopLocation;
const SECOND = { id: 'loc-2', name: 'Jaalala 2', code: 'JL2', active: true } as ShopLocation;
const CLOSED = { id: 'loc-closed', name: 'Jaalala Kiosk', code: 'JLK', active: false } as ShopLocation;
const LOCATIONS = [MAIN, SECOND, CLOSED];

const serum = {
  id: 'p-serum', name: 'Torriden Balanceful Serum', sku: 'TOR-BAL-100',
  barcode: '8809611860018', costCents: 461, shelfNumber: 'A3',
} as Product;
const centella = {
  id: 'p-centella', name: 'SKIN1004 Madagascar Centella', sku: 'SKIN1004',
  barcode: null, costCents: 461, shelfNumber: 'A3',
} as Product;
const sun = {
  id: 'p-sun', name: 'Beauty of Joseon Relief Sun', sku: 'BOJ-SUN-50',
  barcode: '8809611860025', costCents: null, shelfNumber: 'B1',
} as Product;
const PRODUCTS = [serum, centella, sun];

const STOCK: Record<string, number> = {
  'p-serum|loc-main': 11,
  'p-centella|loc-main': 24,
  'p-sun|loc-main': 12,
  'p-serum|loc-2': 4,
};
const stockAt = (productId: string, locationId: string) => STOCK[`${productId}|${locationId}`] ?? 0;

const CONTEXT = { products: PRODUCTS, locations: LOCATIONS, stockAt };

function sheet(rows: Partial<Record<string, string>>[]): ParsedCsv {
  const full = rows.map((row) => ({
    Product: '',
    SKU: '',
    Barcode: '',
    Store: 'Jaalala Skincare',
    Shelf: '',
    'App says': '',
    Counted: '',
    Reason: '',
    ...row,
  }));
  return parseCsvText(
    rowsToCsv(
      full,
      COUNT_TEMPLATE_COLUMNS.map((c) => ({ header: c.header, value: (r: Record<string, string>) => r[c.header] ?? '' }))
    )
  );
}

const entry = (product: Product, location: ShopLocation, stock: number, shelfNumber: string | null): CountSheetRow => ({
  product,
  location,
  stock,
  shelfNumber,
});

describe('the sheet the shop downloads', () => {
  it('clears the picker its own template has to pass', () => {
    const csv = parseCsvText(rowsToCsv([], COUNT_SHEET_COLUMNS));
    expect(missingRequiredColumns(COUNT_TEMPLATE_COLUMNS, csv.headers)).toEqual([]);
  });

  // THE difference from the restock sheet, and the reason the column exists on
  // this one. A delivery is unpacked from a box, so its sheet can come back in
  // whatever order the catalogue does. A stock-take is WALKED, shelf by shelf,
  // and a sheet in the order of the room is the difference between an hour and
  // an afternoon.
  it('sorts by shelf rather than by name', () => {
    const rows = countSheetRows(LOCATIONS, [
      entry(sun, MAIN, 12, 'B1'),
      entry(serum, MAIN, 11, 'A3'),
      entry(centella, MAIN, 24, 'A3'),
    ]);
    expect(rows.map((r) => [r.shelfNumber, r.product.name])).toEqual([
      ['A3', 'SKIN1004 Madagascar Centella'],
      ['A3', 'Torriden Balanceful Serum'],
      ['B1', 'Beauty of Joseon Relief Sun'],
    ]);
  });

  // A3, A10, A11 -- not A1, A10, A11, A2. A shelf label is a place in a room,
  // and plain string ordering sends the walker back down the aisle.
  it('reads a shelf number as a number, not as text', () => {
    const rows = countSheetRows(LOCATIONS, [
      entry(serum, MAIN, 1, 'A10'),
      entry(centella, MAIN, 1, 'A2'),
      entry(sun, MAIN, 1, 'A1'),
    ]);
    expect(rows.map((r) => r.shelfNumber)).toEqual(['A1', 'A2', 'A10']);
  });

  // Last, not first: an unshelved product is the one hunted for at the end of
  // the walk, and putting it at the top would start every stock-take with the
  // items nobody can find.
  it('puts products with no shelf at the end', () => {
    const rows = countSheetRows(LOCATIONS, [
      entry(serum, MAIN, 1, null),
      entry(centella, MAIN, 1, 'B1'),
    ]);
    expect(rows.map((r) => r.product.name)).toEqual([
      'SKIN1004 Madagascar Centella',
      'Torriden Balanceful Serum',
    ]);
  });

  // Shelf order across two stores is meaningless -- A3 in Jaalala is not near
  // A3 in Jaalala 2 -- so the store is the outer sort and the walk happens
  // within it.
  it('groups by store before it sorts by shelf', () => {
    const rows = countSheetRows(LOCATIONS, [
      entry(serum, SECOND, 4, 'A1'),
      entry(centella, MAIN, 24, 'B9'),
      entry(serum, MAIN, 11, 'A3'),
    ]);
    expect(rows.map((r) => [r.location.name, r.shelfNumber])).toEqual([
      ['Jaalala Skincare', 'A3'],
      ['Jaalala Skincare', 'B9'],
      ['Jaalala 2', 'A1'],
    ]);
  });

  it('leaves out closed stores', () => {
    const rows = countSheetRows(LOCATIONS, [entry(serum, CLOSED, 3, 'A1'), entry(serum, MAIN, 11, 'A3')]);
    expect(rows.some((r) => r.location.id === CLOSED.id)).toBe(false);
  });

  it('states what the app believes and leaves the two cells the shop fills empty', () => {
    const parsed = parseCsvText(rowsToCsv(countSheetRows(LOCATIONS, [entry(serum, MAIN, 11, 'A3')]), COUNT_SHEET_COLUMNS));
    expect(parsed.rows[0]).toMatchObject({
      Product: 'Torriden Balanceful Serum',
      SKU: 'TOR-BAL-100',
      Store: 'JL1',
      Shelf: 'A3',
      'App says': '11',
      Counted: '',
      Reason: '',
    });
  });
});

describe('planning a stock-take', () => {
  it('replaces the count rather than adding to it, and records the variance', () => {
    const plan = planCount(sheet([{ Product: 'Torriden Balanceful Serum', Counted: '8', Reason: 'Damaged' }]), CONTEXT);
    expect(plan.rejected).toEqual([]);
    expect(plan.counts[0].lines[0]).toEqual({
      productId: 'p-serum',
      productName: 'Torriden Balanceful Serum',
      previousQuantity: 11,
      countedQuantity: 8,
      variance: -3,
      reason: 'damaged',
      unitCostCents: 461,
    });
  });

  it('reads a count that found more as a positive variance', () => {
    const plan = planCount(sheet([{ Product: 'SKIN1004 Madagascar Centella', Counted: '26' }]), CONTEXT);
    expect(plan.counts[0].lines[0].variance).toBe(2);
    expect(plan.counts[0].lines[0].reason).toBeNull();
  });

  // The one that decides whether a shop can count one shelf. A row left blank
  // is a product NOT COUNTED, and a product not counted keeps its number -- it
  // never reaches the RPC at all.
  it('leaves blank rows out of the count entirely rather than zeroing them', () => {
    const plan = planCount(
      sheet([{ Product: 'Torriden Balanceful Serum', Counted: '8' }, {}, {}, {}]),
      CONTEXT
    );
    expect(plan.skipped).toBe(3);
    expect(plan.rejected).toEqual([]);
    expect(planLines(plan)).toHaveLength(1);
    expect(planLines(plan).map((l) => l.productId)).toEqual(['p-serum']);
  });

  // A zero IS a count, and the distinction from a blank cell is the whole
  // safety of the rule above.
  it('treats a counted zero as an empty shelf, not as a blank row', () => {
    const plan = planCount(sheet([{ Product: 'Torriden Balanceful Serum', Counted: '0' }]), CONTEXT);
    expect(plan.skipped).toBe(0);
    expect(plan.counts[0].lines[0]).toMatchObject({ countedQuantity: 0, variance: -11 });
  });

  // Nothing is trusted from the file's own "App says" column: it was true when
  // the sheet was downloaded, and a week of trading may have passed since.
  it('ignores the App says column and reads the live figure', () => {
    const plan = planCount(
      sheet([{ Product: 'Torriden Balanceful Serum', 'App says': '999', Counted: '8' }]),
      CONTEXT
    );
    expect(plan.counts[0].lines[0].previousQuantity).toBe(11);
  });

  it('groups by store, and reads each store’s own holding', () => {
    const plan = planCount(
      sheet([
        { Product: 'Torriden Balanceful Serum', Counted: '8' },
        { Product: 'Torriden Balanceful Serum', Store: 'JL2', Counted: '4' },
      ]),
      CONTEXT
    );
    expect(plan.counts).toHaveLength(2);
    expect(plan.counts[0].lines[0]).toMatchObject({ previousQuantity: 11, variance: -3 });
    expect(plan.counts[1]).toMatchObject({ locationName: 'Jaalala 2' });
    expect(plan.counts[1].lines[0]).toMatchObject({ previousQuantity: 4, variance: 0 });
  });

  it('matches by SKU before name, so a tidied name still finds its product', () => {
    const plan = planCount(
      sheet([{ Product: 'torriden balanceful serum (100ml)', SKU: 'TOR-BAL-100', Counted: '8' }]),
      CONTEXT
    );
    expect(plan.rejected).toEqual([]);
    expect(plan.counts[0].lines[0].productId).toBe('p-serum');
  });

  it('records an uncosted product with a null cost rather than a zero', () => {
    const plan = planCount(sheet([{ Product: 'Beauty of Joseon Relief Sun', Counted: '9' }]), CONTEXT);
    expect(plan.counts[0].lines[0].unitCostCents).toBeNull();
  });
});

describe('what a count sheet refuses', () => {
  it('rejects a reason with nothing counted', () => {
    const plan = planCount(sheet([{ Product: 'Torriden Balanceful Serum', Reason: 'Damaged' }]), CONTEXT);
    expect(plan.rejected[0].reason).toBe('Reason is filled in but Counted is empty — write down what you found.');
    expect(plan.skipped).toBe(0);
  });

  it('names Import products when the row is a product the shop does not carry', () => {
    const plan = planCount(sheet([{ Product: 'Anua Heartleaf Toner', Counted: '6' }]), CONTEXT);
    expect(plan.rejected[0].reason).toContain('Import products');
    expect(plan.rejected[0].row).toBe(2);
  });

  it('rejects a negative count and says what to write instead', () => {
    const plan = planCount(sheet([{ Product: 'Torriden Balanceful Serum', Counted: '-3' }]), CONTEXT);
    expect(plan.rejected[0].reason).toBe(
      'Counted cannot be negative — write down how many you found, and 0 if the shelf was empty.'
    );
  });

  it('rejects a count larger than the column can hold, separately from gibberish', () => {
    const big = planCount(sheet([{ Product: 'Torriden Balanceful Serum', Counted: '9999999999' }]), CONTEXT);
    expect(big.rejected[0].reason).toContain('larger than a count can be');
    const junk = planCount(sheet([{ Product: 'Torriden Balanceful Serum', Counted: 'about 8' }]), CONTEXT);
    expect(junk.rejected[0].reason).toContain('whole number');
  });

  it('refuses a store it does not recognise, and names the ones it has', () => {
    const plan = planCount(
      sheet([{ Product: 'Torriden Balanceful Serum', Store: 'Hargeisa', Counted: '8' }]),
      CONTEXT
    );
    expect(plan.rejected[0].reason).toContain('Jaalala Skincare, Jaalala 2');
  });

  it('rejects two rows counting the same product at the same store', () => {
    const plan = planCount(
      sheet([
        { Product: 'Torriden Balanceful Serum', Counted: '8' },
        { Product: 'Torriden Balanceful Serum', Counted: '9' },
      ]),
      CONTEXT
    );
    expect(planLines(plan)).toHaveLength(1);
    expect(plan.rejected[0].reason).toMatch(/^Row 2 already counts/);
  });

  // Five reasons, and only five. The preview REPORTS how many lines have none,
  // so a sixth spelling would quietly become a sixth category nobody chose.
  it('rejects a reason that is not one of the five, and names them', () => {
    const plan = planCount(
      sheet([{ Product: 'Torriden Balanceful Serum', Counted: '8', Reason: 'shrinkage' }]),
      CONTEXT
    );
    expect(plan.rejected[0].reason).toBe(
      '"shrinkage" is not one of the reasons. Use Damaged, Expired, Theft or loss, Miscount or Other, or leave it empty.'
    );
  });

  it('accepts a reason however it is capitalised, and its stored spelling too', () => {
    const plan = planCount(
      sheet([
        { Product: 'Torriden Balanceful Serum', Counted: '8', Reason: 'THEFT OR LOSS' },
        { Product: 'SKIN1004 Madagascar Centella', Counted: '20', Reason: 'theft_or_loss' },
      ]),
      CONTEXT
    );
    expect(plan.rejected).toEqual([]);
    expect(planLines(plan).map((l) => l.reason)).toEqual(['theft_or_loss', 'theft_or_loss']);
  });

  // A reason on a line that matched is kept, not dropped and not rejected. It
  // is the shop's own word about a product they looked at, the column has room
  // for it, and rejecting the row would block a 300-line stock-take over a cell
  // that changes no number.
  it('keeps a reason on a line whose count matched', () => {
    const plan = planCount(
      sheet([{ Product: 'Torriden Balanceful Serum', Counted: '11', Reason: 'Miscount' }]),
      CONTEXT
    );
    expect(plan.rejected).toEqual([]);
    expect(plan.counts[0].lines[0]).toMatchObject({ variance: 0, reason: 'miscount' });
  });
});

describe('what the count adds up to', () => {
  const linesOf = (rows: Partial<Record<string, string>>[]) => planLines(planCount(sheet(rows), CONTEXT));

  // The mockup's own by-hand frame, number for number: three counted, one
  // matched, two differ, netting −1 unit and −$4.61.
  it('nets the variance rather than reporting losses and finds separately', () => {
    const summary = summariseCount(
      linesOf([
        { Product: 'Torriden Balanceful Serum', Counted: '8', Reason: 'Damaged' },
        { Product: 'SKIN1004 Madagascar Centella', Counted: '26' },
        { Product: 'Beauty of Joseon Relief Sun', Counted: '12' },
      ])
    );
    expect(summary).toMatchObject({ counted: 3, matched: 1, differ: 2, varianceUnits: -1, varianceCents: -461 });
  });

  // The other number in that same frame, and it uses a DIFFERENT rule: the
  // checkbox offers $13.83 while the footer nets to −$4.61. Two units found are
  // not a negative expense -- nobody gets money back for stock that turned up
  // -- so the shortfall counts only the lines that came up short.
  it('values the shortfall gross, never netting the units that were found', () => {
    const summary = summariseCount(
      linesOf([
        { Product: 'Torriden Balanceful Serum', Counted: '8', Reason: 'Damaged' },
        { Product: 'SKIN1004 Madagascar Centella', Counted: '26' },
      ])
    );
    expect(summary.varianceCents).toBe(-461);
    expect(summary.shortfallCents).toBe(1383);
  });

  // Hide, don't lie. An uncosted product contributes nothing to the total, so a
  // count full of them would offer to log a shortfall far smaller than the real
  // one -- a wrong number wearing a right one's clothes.
  it('withholds the shortfall entirely when a line that came up short is uncosted', () => {
    const summary = summariseCount(
      linesOf([
        { Product: 'Torriden Balanceful Serum', Counted: '8' },
        { Product: 'Beauty of Joseon Relief Sun', Counted: '9' },
      ])
    );
    expect(summary.shortfallCents).toBeNull();
    expect(summary.varianceCents).toBeNull();
    expect(summary.uncostedShortfallLines).toBe(1);
  });

  // But an uncosted line that MATCHED lost nothing, so it withholds nothing.
  it('still values a shortfall when the only uncosted line matched', () => {
    const summary = summariseCount(
      linesOf([
        { Product: 'Torriden Balanceful Serum', Counted: '8' },
        { Product: 'Beauty of Joseon Relief Sun', Counted: '12' },
      ])
    );
    expect(summary.shortfallCents).toBe(1383);
    expect(summary.uncostedShortfallLines).toBe(0);
  });

  // And an uncosted line that came up LONG withholds the net figure without
  // withholding the shortfall -- they are two questions with two answers.
  it('withholds the net value but not the shortfall when an uncosted line came up long', () => {
    const STOCK_LONG = { ...CONTEXT, stockAt: (p: string, l: string) => (p === 'p-sun' ? 8 : stockAt(p, l)) };
    const plan = planCount(
      sheet([
        { Product: 'Torriden Balanceful Serum', Counted: '8' },
        { Product: 'Beauty of Joseon Relief Sun', Counted: '9' },
      ]),
      STOCK_LONG
    );
    const summary = summariseCount(planLines(plan));
    expect(summary.varianceCents).toBeNull();
    expect(summary.shortfallCents).toBe(1383);
  });

  // The gap is REPORTED, never filled. Defaulting a blank to Miscount would be
  // a precise-looking answer to a question nobody asked.
  it('counts the lines that differ with no reason given', () => {
    const summary = summariseCount(
      linesOf([
        { Product: 'Torriden Balanceful Serum', Counted: '8', Reason: 'Damaged' },
        { Product: 'SKIN1004 Madagascar Centella', Counted: '26' },
        { Product: 'Beauty of Joseon Relief Sun', Counted: '12' },
      ])
    );
    expect(summary.reasonlessLines).toBe(1);
  });

  // An empty count must report NOTHING, not a count worth 0.00 that Task 9's
  // checkbox would then offer to log as an expense. This is the same trap that
  // produced a delivery worth 0.00 on the restock sheet -- `[].every()` is
  // true, and `[].reduce((a, b) => a + b, 0)` is 0, so an empty list looks
  // exactly like a complete and worthless one unless it is asked about.
  it('reports an empty count as nothing rather than as nothing lost', () => {
    expect(summariseCount([])).toEqual({
      counted: 0,
      matched: 0,
      differ: 0,
      varianceUnits: 0,
      varianceCents: 0,
      shortfallCents: 0,
      uncostedDifferingLines: 0,
      uncostedShortfallLines: 0,
      reasonlessLines: 0,
    });
  });
});
```

- [ ] **Step 6: Run the test and verify it fails**

Run: `npx jest src/lib/__tests__/count-import.test.ts`
Expected: FAIL — `Cannot find module '@/lib/count-import'`.

- [ ] **Step 7: Write the module**

Create `src/lib/count-import.ts`:

```ts
import { normalizeBarcode } from '@/lib/barcode';
import type { CsvColumn, ParsedCsv } from '@/lib/csv';
import type { RejectedRow, TemplateColumn } from '@/lib/import-shared';
import { isUncosted } from '@/lib/product-costing';
import { readCountedQuantity } from '@/lib/restock-typed-input';
import type { Product, ShopLocation, StockCountReason } from '@/types/models';

// A stock-take by spreadsheet.
//
// A real one is 300 lines on a clipboard at 7am, not three products typed into
// a phone -- which is why this file exists at all, and why the sheet it
// describes is walked rather than read.
//
// Pure, like restock-import.ts: this turns a parsed sheet plus what the shop
// currently holds into a plan, and the caller commits that plan through
// save_stock_count. Nothing here writes. That split is the point -- every rule
// below is testable without a database, and the commit stays a thin loop.
//
// The one rule worth stating before any code: A ROW LEFT BLANK IS A PRODUCT NOT
// COUNTED, and a product not counted keeps its number. It does not reach the
// RPC at all. The alternative -- treating a whole-store sheet as authoritative
// and zeroing anything absent -- would wipe a shop's inventory from one
// afternoon spent on aisle three.

// Five, and only five. The preview REPORTS how many differing lines have none
// ("9 with no reason"), so a sixth spelling would quietly become a sixth
// category nobody chose. The labels are what a shop reads and types; the keys
// are what stock_count_items.reason stores.
export const COUNT_REASONS: { key: StockCountReason; label: string }[] = [
  { key: 'damaged', label: 'Damaged' },
  { key: 'expired', label: 'Expired' },
  { key: 'theft_or_loss', label: 'Theft or loss' },
  { key: 'miscount', label: 'Miscount' },
  { key: 'other', label: 'Other' },
];

const REASON_LABELS = new Map(COUNT_REASONS.map((r) => [r.key, r.label]));

export function reasonLabel(key: StockCountReason): string {
  return REASON_LABELS.get(key) ?? key;
}

// The five, as a sentence, for the rejection that has to name them.
const REASON_LIST = 'Damaged, Expired, Theft or loss, Miscount or Other';

// Accepts the label a shop reads off the screen, however they capitalise it,
// and the stored key too -- a sheet that has been round-tripped through an
// export, or a person copying what they saw in a report, both arrive with the
// underscore form. Anything else is `'unknown'`, which is rejected by name
// rather than dropped: a misspelt reason silently becoming "no reason" would
// show up in the preview as a shop failing to explain something they did.
function readReason(text: string): StockCountReason | null | 'unknown' {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  const key = trimmed.toLowerCase();
  const match = COUNT_REASONS.find((r) => r.key === key || r.label.toLowerCase() === key);
  return match ? match.key : 'unknown';
}

export const COUNT_TEMPLATE_COLUMNS: TemplateColumn[] = [
  { header: 'Product', required: true },
  { header: 'SKU', required: false },
  { header: 'Barcode', required: false },
  { header: 'Store', required: true },
  // Not read back. It is on the sheet so the walk has an order and so the
  // walker can find the shelf named on the row -- and `countSheetRows` sorts by
  // it, which is the actual feature.
  { header: 'Shelf', required: false },
  // Also not read back. Stated so the counter can see what they are
  // contradicting, and deliberately ignored on upload: it was true when the
  // sheet was downloaded, and a week of trading may have happened since.
  { header: 'App says', required: false },
  { header: 'Counted', required: true },
  { header: 'Reason', required: false },
];

// One line per product per store, for the products that store CARRIES.
//
// The deliberate opposite of restockSheetRows, which lists every product at
// every store INCLUDING the ones a store holds none of -- because a product at
// zero is the likeliest thing in the van. A stock-take is the other case: a
// product with no stock row at that store has no shelf to walk to, and 200 rows
// of things that are not in the room is how a 300-line sheet becomes a 500-line
// one. `listProducts(shopId, locationId)` already draws exactly this line, and
// keeps rows sitting at zero -- "we stock this and we're out" is a shelf worth
// looking at.
export type CountSheetRow = {
  product: Product;
  location: ShopLocation;
  stock: number;
  // The store's own shelf label for this product. Per store, not per product:
  // the same item sits in a different place in each branch
  // (product_location_stock.shelf_number, migration 20260810000000).
  shelfNumber: string | null;
};

export const COUNT_SHEET_COLUMNS: CsvColumn<CountSheetRow>[] = [
  { header: 'Product', value: (r) => r.product.name },
  { header: 'SKU', value: (r) => r.product.sku ?? '' },
  { header: 'Barcode', value: (r) => r.product.barcode ?? '' },
  // The code when there is one, so a store rename cannot orphan a sheet
  // someone downloaded last week -- which is what `code` is for.
  { header: 'Store', value: (r) => r.location.code || r.location.name },
  { header: 'Shelf', value: (r) => r.shelfNumber ?? '' },
  { header: 'App says', value: (r) => String(r.stock) },
  { header: 'Counted', value: () => '' },
  { header: 'Reason', value: () => '' },
];

// Natural order, so A3 comes before A10 rather than after A1 and before A2.
// A shelf label is a place in a room, and plain string ordering sends the
// walker back down the aisle. Rows with no shelf sort LAST: an unshelved
// product is the one hunted for at the end of the walk, and putting it at the
// top would start every stock-take with the items nobody can find.
function compareShelf(a: string | null, b: string | null): number {
  const left = a?.trim() ?? '';
  const right = b?.trim() ?? '';
  if (left === '' && right === '') return 0;
  if (left === '') return 1;
  if (right === '') return -1;
  return left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' });
}

// Sorted by shelf, not by name -- the single decision this sheet turns on.
//
// The restock sheet comes back in whatever order the catalogue does, because a
// delivery is unpacked from a box and the box has no order. A stock-take is
// WALKED, shelf by shelf, and a sheet in the order of the room is the
// difference between an hour and an afternoon.
//
// Store first, because shelf order across two stores is meaningless -- A3 in
// one branch is not near A3 in another. Store order is the caller's
// `locations` order (primary first, as the session hands it over) rather than
// anything derived, so the sheet opens on the store most shops are standing in.
export function countSheetRows(locations: ShopLocation[], entries: CountSheetRow[]): CountSheetRow[] {
  const stores = locations.filter((location) => location.active);
  const rank = new Map(stores.map((location, index) => [location.id, index]));
  return entries
    .filter((entry) => rank.has(entry.location.id))
    .slice()
    .sort(
      (a, b) =>
        rank.get(a.location.id)! - rank.get(b.location.id)! ||
        compareShelf(a.shelfNumber, b.shelfNumber) ||
        a.product.name.localeCompare(b.product.name)
    );
}

// --- Planning -------------------------------------------------------------

export type PlannedCountLine = {
  productId: string;
  productName: string;
  // What the app believes RIGHT NOW -- read from the caller's live `stockAt`,
  // never from the sheet's own "App says" column, which was true when the file
  // was downloaded. The RPC reads it a third time under a row lock at commit,
  // and that third reading is the one recorded: a sale completing while the
  // shop reads the preview must not be absorbed into the variance.
  previousQuantity: number;
  countedQuantity: number;
  variance: number;
  // null means the shop did not say, and it stays null all the way to the
  // column. Never defaulted to 'miscount' -- that is a precise-looking answer
  // to a question nobody asked.
  reason: StockCountReason | null;
  // What a unit costs today, or null where the product is uncosted. Null, never
  // zero: zero is a real answer (a free sample), which is the distinction
  // isUncosted exists to keep. Carried so the preview can value the shortfall
  // -- and, where it cannot, say so instead of quoting a smaller number.
  unitCostCents: number | null;
};

// One save_stock_count call. Lines are grouped by store because that RPC counts
// exactly one store per transaction -- and a shop reading its history should see
// one stock-take per store, not two blurred into one.
export type PlannedCount = {
  locationId: string;
  locationName: string;
  lines: PlannedCountLine[];
};

export type CountPlan = {
  counts: PlannedCount[];
  rejected: RejectedRow[];
  // Rows with nothing filled in. Counted rather than rejected, and NOT counted
  // as a line: the sheet is a download of everything the store carries, so most
  // of it is meant to come back untouched, and a product nobody counted keeps
  // its number.
  skipped: number;
};

export function planLines(plan: CountPlan): PlannedCountLine[] {
  return plan.counts.flatMap((count) => count.lines);
}

// Why `readCountedQuantity` refused a cell, in the shop's words.
//
// This chooses a SENTENCE and nothing else -- what is accepted is decided by
// readCountedQuantity alone, so the sheet and the by-hand field cannot drift
// apart. (The restock branch shipped exactly that drift twice: an unbounded
// sheet parser beside a capped by-hand one, and two different readings of
// "1,50" ending at the same column.)
function quantityRejection(text: string): string {
  const trimmed = text.trim();
  if (/^-[0-9]+$/.test(trimmed)) {
    return 'Counted cannot be negative — write down how many you found, and 0 if the shelf was empty.';
  }
  // Digits only, so the cell was a number -- just not one the column can hold.
  // Told apart from gibberish because the two ask for different corrections.
  if (/^[0-9]+$/.test(trimmed)) {
    return 'Counted is larger than a count can be — check for a stray digit or a pasted cell.';
  }
  return 'Counted must be a whole number — just the digits, with no units.';
}

function findLocation(locations: ShopLocation[], text: string): ShopLocation | undefined {
  const key = text.trim().toLowerCase();
  return locations.find((l) => l.name.trim().toLowerCase() === key || (l.code ?? '').trim().toLowerCase() === key);
}

// SKU first, then barcode, then name -- identical to the restock and move
// sheets, and for the same reasons: the identifiers survive someone tidying a
// name in a spreadsheet, and a name is the only one of the three that two
// products can share.
function findProduct(products: Product[], row: Record<string, string>): Product | 'none' | 'ambiguous' {
  const sku = row['SKU']?.trim().toLowerCase();
  if (sku) {
    const bySku = products.filter((p) => (p.sku ?? '').trim().toLowerCase() === sku);
    if (bySku.length === 1) return bySku[0];
    if (bySku.length > 1) return 'ambiguous';
  }

  const barcode = normalizeBarcode(row['Barcode'] ?? '').toLowerCase();
  if (barcode) {
    const byBarcode = products.filter((p) => normalizeBarcode(p.barcode ?? '').toLowerCase() === barcode);
    if (byBarcode.length === 1) return byBarcode[0];
    if (byBarcode.length > 1) return 'ambiguous';
  }

  const name = row['Product']?.trim().toLowerCase();
  if (!name) return 'none';
  const byName = products.filter((p) => p.name.trim().toLowerCase() === name);
  if (byName.length === 1) return byName[0];
  if (byName.length > 1) return 'ambiguous';
  return 'none';
}

export function planCount(
  parsed: ParsedCsv,
  context: {
    products: Product[];
    locations: ShopLocation[];
    stockAt: (productId: string, locationId: string) => number;
  }
): CountPlan {
  const stores = context.locations.filter((location) => location.active);
  const storeNames = stores.map((l) => l.name).join(', ');

  const rejected: RejectedRow[] = [];
  const byStore = new Map<string, PlannedCount>();
  // (product, store) -> the row that already counted it. Two rows counting the
  // same product at the same store are almost always a copy-paste slip, and one
  // of them would silently win -- the shop would read one number on screen and
  // find another on the shelf.
  const claimed = new Map<string, number>();
  let skipped = 0;

  parsed.rows.forEach((raw, i) => {
    const row = i + 2; // the header occupies row 1 of the uploaded file
    const reject = (reason: string) => rejected.push({ row, reason, data: raw });

    const countedText = raw['Counted']?.trim() ?? '';
    const reasonText = raw['Reason']?.trim() ?? '';
    // An untouched row. Not a rejection and not a line: this product was not
    // counted, and a product that was not counted keeps its number.
    if (!countedText && !reasonText) {
      skipped += 1;
      return;
    }
    if (!countedText) {
      return reject('Reason is filled in but Counted is empty — write down what you found.');
    }

    const product = findProduct(context.products, raw);
    if (product === 'none') {
      return reject(
        `No product matches "${raw['Product']?.trim() || raw['SKU']?.trim() || raw['Barcode']?.trim() || ''}" — check the spelling, or fill in the SKU column. If you don't sell it yet, use Import products, which creates it with its price and opening stock.`
      );
    }
    if (product === 'ambiguous') {
      return reject(`More than one product matches "${raw['Product']?.trim()}" — fill in the SKU column to say which.`);
    }

    const store = findLocation(stores, raw['Store'] ?? '');
    if (!store) {
      return reject(
        raw['Store']?.trim()
          ? `No active store called "${raw['Store'].trim()}". Your stores are ${storeNames}.`
          : 'Store is empty — say which store you counted.'
      );
    }

    // Read by readCountedQuantity, the SAME function the by-hand tab's Counted
    // field uses -- one reader means one answer, and in particular one ceiling
    // and one treatment of zero.
    const countedQuantity = readCountedQuantity(countedText);
    if (countedQuantity === null) return reject(quantityRejection(countedText));

    const claim = `${product.id}|${store.id}`;
    const earlier = claimed.get(claim);
    if (earlier !== undefined) {
      return reject(`Row ${earlier} already counts ${product.name} at ${store.name} — combine them into one row.`);
    }

    const reason = readReason(reasonText);
    if (reason === 'unknown') {
      return reject(`"${reasonText}" is not one of the reasons. Use ${REASON_LIST}, or leave it empty.`);
    }

    claimed.set(claim, row);

    const previousQuantity = context.stockAt(product.id, store.id);
    const count = byStore.get(store.id) ?? { locationId: store.id, locationName: store.name, lines: [] };
    count.lines.push({
      productId: product.id,
      productName: product.name,
      previousQuantity,
      countedQuantity,
      variance: countedQuantity - previousQuantity,
      // A reason on a line whose count MATCHED is kept, not dropped and not
      // rejected. It is the shop's own word about a product they looked at, the
      // column has room for it, and rejecting the row would block a 300-line
      // stock-take over a cell that changes no number.
      reason,
      unitCostCents: isUncosted(product) ? null : product.costCents,
    });
    byStore.set(store.id, count);
  });

  return { counts: [...byStore.values()], rejected, skipped };
}

// --- What it adds up to ---------------------------------------------------

export type CountSummary = {
  counted: number;
  matched: number;
  differ: number;
  // Net, signed, in units. The footer says "−1 unit", not "3 lost, 2 found",
  // so nobody reads a good day into a stock-take that lost three of one thing
  // and found two of another.
  varianceUnits: number;
  // Net, signed, in cents. Null when any DIFFERING line is uncosted: the honest
  // answer there is no answer, and a smaller number would be a lie with a
  // decimal point in it.
  varianceCents: number | null;
  // Gross, positive, in cents -- only the lines that came up SHORT. This is a
  // different question from varianceCents and it has a different answer: the
  // mockup's own frame nets to −$4.61 and offers $13.83, because two units that
  // turned up are not a refund. Null when any line that came up short is
  // uncosted, for the same reason as above.
  shortfallCents: number | null;
  uncostedDifferingLines: number;
  uncostedShortfallLines: number;
  // Lines that differ with no reason given. Reported, never filled -- a shop
  // that sees this figure every month knows something the app cannot tell it.
  reasonlessLines: number;
};

export function summariseCount(lines: PlannedCountLine[]): CountSummary {
  const differing = lines.filter((line) => line.variance !== 0);
  const short = lines.filter((line) => line.variance < 0);
  const uncostedDifferingLines = differing.filter((line) => line.unitCostCents === null).length;
  const uncostedShortfallLines = short.filter((line) => line.unitCostCents === null).length;

  return {
    counted: lines.length,
    matched: lines.length - differing.length,
    differ: differing.length,
    varianceUnits: lines.reduce((sum, line) => sum + line.variance, 0),
    // Guarded on the uncosted COUNT rather than written as `.every()`: `every`
    // on an empty array is true, and the equivalent shortcut on the restock
    // sheet reported an empty basket as a delivery worth 0.00 -- which the
    // expense checkbox then offered to log. Here an empty list genuinely is
    // worth nothing, and it reaches that answer by adding nothing up rather
    // than by passing a test it should not have been given.
    varianceCents:
      uncostedDifferingLines > 0
        ? null
        : differing.reduce((sum, line) => sum + line.variance * (line.unitCostCents ?? 0), 0),
    shortfallCents:
      uncostedShortfallLines > 0
        ? null
        : short.reduce((sum, line) => sum + -line.variance * (line.unitCostCents ?? 0), 0),
    uncostedDifferingLines,
    uncostedShortfallLines,
    reasonlessLines: differing.filter((line) => line.reason === null).length,
  };
}
```

- [ ] **Step 8: Run the test and verify it passes**

Run: `npx jest src/lib/__tests__/count-import.test.ts`
Expected: PASS — every case green.

- [ ] **Step 9: Run the whole suite and the linter**

Run: `npm test && npm run lint && npx tsc --noEmit`
Expected: no failures, no new lint warnings, no type errors.

- [ ] **Step 10: Commit**

```bash
git add src/lib/count-import.ts src/lib/__tests__/count-import.test.ts \
  src/lib/restock-typed-input.ts src/lib/__tests__/restock-typed-input.test.ts
git commit -m "feat(inventory): plan a stock-take from a sheet, without writing anything"
```

---

### Task 5: `StockCountModal` — the by-hand tab

**Files:**
- Create: `src/components/stock-count-modal.tsx`
- Test: `src/components/__tests__/stock-count-modal.test.tsx`

**Interfaces:**
- Consumes: `saveStockCount` and `listProducts` from `@/lib/products` (Task 3); `COUNT_REASONS`, `reasonLabel`, `summariseCount`, `type PlannedCountLine` from `@/lib/count-import` (Task 4); `readCountedQuantity` from `@/lib/restock-typed-input`; `AppModal`, `StoreDropdown`, `CategoryChip`; `useAuth`; `extractErrorMessage` from `@/lib/checkout-errors`; `describePlanError` from `@/lib/entitlements`; `formatCents` from `@/lib/currency`.
- Produces: `StockCountModal({ visible, shopId, onClose, onDone }: { visible: boolean; shopId: string; onClose: () => void; onDone: () => Promise<void> })`.

- [ ] **Step 1: Read the component this one mirrors**

Read `src/components/stock-restock-modal.tsx` end to end. Copy its `StyleSheet` block wholesale into the new file — the overlay, card, header, segment, label, body, basket, line, pill, footer and checkbox styles are the house chrome for this kind of sheet, and a second hand-rolled set is how two sheets start looking different. Note in particular:
- `linesRef` + `updateLines`, and why every basket write goes through one helper.
- `closeAndReset`, and why it exists: the screen renders this with `visible={false}` rather than unmounting it, so nothing resets itself.
- the comment above `submit`'s `try`, which is the record of a CRITICAL: `await onDone()` inside the try that had already committed left a full basket under a live button, and pressing it again committed twice.

- [ ] **Step 2: Write the failing component test**

Create `src/components/__tests__/stock-count-modal.test.tsx`:

```tsx
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { Text } from 'react-native';

import { StockCountModal } from '@/components/stock-count-modal';

// The half of the count screen that a pure test cannot reach.
//
// count-import.test.ts tests planCount and summariseCount against finished
// values. Every input bug that shipped from the RESTOCK screen was
// finished-string-correct and lived here instead, in the component's own
// setter, where a normalising .replace() rewrote a controlled field between
// keystrokes so the next character landed on text the person never typed. A
// test that feeds whole strings to the classifier stays green through all of
// them.
//
// So every case below is driven the way a controlled TextInput actually drives
// it: read the field's current value, append or remove ONE character, hand that
// back to the component's own onChangeText, then read the field again. A helper
// that did `state + character` would never touch the component and could not
// catch the class it was written for.

jest.mock('@/hooks/use-auth', () => ({
  useAuth: () => ({
    locations: [{ id: 'loc-1', name: 'Main', active: true }],
    activeLocation: { id: 'loc-1', name: 'Main', active: true },
  }),
}));

jest.mock('@/lib/categories', () => ({ listCategories: jest.fn(async () => []) }));

const product = (over: Record<string, unknown>) => ({
  id: 'p-1',
  shopId: 'shop-1',
  name: 'QA widget',
  description: null,
  sku: 'QA-1',
  barcode: null,
  brand: null,
  category: null,
  tags: [],
  supplierName: null,
  costCents: 461,
  priceCents: 500,
  stock: 11,
  reorderLevel: null,
  shelfNumber: 'A3',
  expiryDate: null,
  batchNumber: null,
  imageUrl: null,
  isListedOnline: false,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  ...over,
});

jest.mock('@/lib/products', () => ({
  listProducts: jest.fn(async () => []),
  saveStockCount: jest.fn(async () => 'count-1'),
}));
const { listProducts, saveStockCount } = jest.requireMock('@/lib/products') as {
  listProducts: jest.Mock;
  saveStockCount: jest.Mock;
};

jest.mock('@/lib/pick-csv-file', () => ({ pickCsvFile: jest.fn() }));
jest.mock('@/lib/expenses', () => ({ createExpense: jest.fn(async () => ({})) }));

const COUNTED = 'Counted units of QA widget';

// Reassembles an interpolated <Text>, whose children React splits into several
// nodes ("Save ", 3, " counts").
function textOf(node: ReactTestInstance): string {
  return node.children.map((child) => (typeof child === 'string' ? child : '')).join('');
}

function fieldNamed(tree: ReactTestRenderer, label: string): ReactTestInstance {
  return tree.root.findAll((n) => n.props['aria-label'] === label)[0];
}

function pressableLabelled(tree: ReactTestRenderer, label: string): ReactTestInstance {
  return tree.root.findAll((n) => n.props.accessibilityLabel === label)[0];
}

function allText(tree: ReactTestRenderer): string {
  return tree.root
    .findAllByType(Text)
    .map((node) => node.children.map((c) => (typeof c === 'string' ? c : '')).join(''))
    .join(' | ');
}

// One character at a time, through the component's own handler.
async function type(tree: ReactTestRenderer, label: string, characters: string) {
  for (const character of characters) {
    const field = fieldNamed(tree, label);
    const next = String(field.props.value ?? '') + character;
    await act(async () => field.props.onChangeText(next));
  }
}

async function backspace(tree: ReactTestRenderer, label: string, times = 1) {
  for (let i = 0; i < times; i += 1) {
    const field = fieldNamed(tree, label);
    const current = String(field.props.value ?? '');
    await act(async () => field.props.onChangeText(current.slice(0, -1)));
  }
}

async function open(products = [product({})]): Promise<ReactTestRenderer> {
  listProducts.mockResolvedValue(products);
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = create(
      <StockCountModal visible shopId="shop-1" onClose={() => {}} onDone={async () => {}} />
    );
  });
  // The results list renders the whole (short) catalogue with no search term.
  await act(async () => pressableLabelled(tree, 'Count QA widget').props.onPress());
  return tree;
}

beforeEach(() => {
  saveStockCount.mockClear();
  saveStockCount.mockResolvedValue('count-1');
});

describe('a line added to a count', () => {
  // Difference 1 from Restock, and the reason the footer can say "3 counted"
  // while only 2 change anything: a stock-take mostly CONFIRMS, so the field
  // starts at the current figure and a row left untouched means "I looked, it
  // matched" -- which is real information.
  it('starts at what the app believes, not at zero or empty', async () => {
    const tree = await open();
    expect(fieldNamed(tree, COUNTED).props.value).toBe('11');
    expect(allText(tree)).toContain('App says 11');
  });

  it('counts an untouched row and reports that it changes nothing', async () => {
    const tree = await open();
    expect(allText(tree)).toContain('Save 1 count');
    expect(allText(tree)).toContain('0 will change a number');
  });

  // The regression class three separate 100x cost bugs came from on the restock
  // branch. If anything rewrites the text on its way into state, the recorded
  // value after some keystroke stops equalling what was typed.
  it('never rewrites the text between keystrokes', async () => {
    const tree = await open();
    await backspace(tree, COUNTED, 2);
    expect(fieldNamed(tree, COUNTED).props.value).toBe('');
    await type(tree, COUNTED, '108');
    expect(fieldNamed(tree, COUNTED).props.value).toBe('108');
    await backspace(tree, COUNTED, 1);
    expect(fieldNamed(tree, COUNTED).props.value).toBe('10');
  });

  // An empty field is just an empty field. Dropping the row at 0 -- the restock
  // screen's first attempt -- unmounted the focused input on the first
  // backspace, closed the keyboard, and took the reason chosen beside it.
  it('keeps the row and its reason when the field is emptied', async () => {
    const tree = await open();
    await act(async () => pressableLabelled(tree, 'Reason for QA widget').props.onPress());
    await act(async () => pressableLabelled(tree, 'Reason: Damaged').props.onPress());
    await backspace(tree, COUNTED, 2);
    expect(fieldNamed(tree, COUNTED).props.value).toBe('');
    expect(allText(tree)).toContain('Damaged');
    expect(allText(tree)).toContain('Type what you found on every line');
  });

  // Zero is a finding, not a blank. Refusing it would leave the door able to
  // record every loss except a total one.
  it('accepts a counted zero and reads it as an empty shelf', async () => {
    const tree = await open();
    await backspace(tree, COUNTED, 2);
    await type(tree, COUNTED, '0');
    expect(allText(tree)).toContain('−11');
    expect(allText(tree)).toContain('1 will change a number');
  });

  // The variance is the column, not a footnote: the person doing the
  // stock-take already knows the 8 -- what they will be asked about is how far
  // off the app was.
  it('shows the variance live and signed', async () => {
    const tree = await open();
    await backspace(tree, COUNTED, 2);
    await type(tree, COUNTED, '8');
    expect(allText(tree)).toContain('−3');
    await backspace(tree, COUNTED, 1);
    await type(tree, COUNTED, '14');
    expect(allText(tree)).toContain('+3');
  });
});

describe('saving a count', () => {
  // THE distinction from Restock, at the only layer a component test can see
  // it: the RPC is handed the TOTAL that was found, never the difference.
  it('sends the counted total, not the change', async () => {
    const tree = await open();
    await backspace(tree, COUNTED, 2);
    await type(tree, COUNTED, '8');
    await act(async () => pressableLabelled(tree, 'Reason for QA widget').props.onPress());
    await act(async () => pressableLabelled(tree, 'Reason: Damaged').props.onPress());
    await act(async () => pressableLabelled(tree, 'Save counts').props.onPress());

    expect(saveStockCount).toHaveBeenCalledWith(
      'shop-1',
      'loc-1',
      [{ productId: 'p-1', countedQuantity: 8, reason: 'damaged' }],
      { note: null }
    );
  });

  it('sends a null reason rather than defaulting one', async () => {
    const tree = await open();
    await backspace(tree, COUNTED, 2);
    await type(tree, COUNTED, '8');
    await act(async () => pressableLabelled(tree, 'Save counts').props.onPress());
    expect(saveStockCount.mock.calls[0][2]).toEqual([
      { productId: 'p-1', countedQuantity: 8, reason: null },
    ]);
  });

  // The CRITICAL from the restock branch, pinned here so it cannot be
  // reintroduced: `await onDone()` inside the try that had already committed
  // meant a reload failing on a network blip landed in the catch, showed an
  // error, cleared busy and LEFT THE BASKET FULL -- and pressing Save again
  // wrote the same count a second time.
  it('does not leave a live basket behind a failed reload', async () => {
    listProducts.mockResolvedValue([product({})]);
    let tree!: ReactTestRenderer;
    await act(async () => {
      tree = create(
        <StockCountModal
          visible
          shopId="shop-1"
          onClose={() => {}}
          onDone={async () => {
            throw new Error('network');
          }}
        />
      );
    });
    await act(async () => pressableLabelled(tree, 'Count QA widget').props.onPress());
    await backspace(tree, COUNTED, 2);
    await type(tree, COUNTED, '8');
    await act(async () => pressableLabelled(tree, 'Save counts').props.onPress());
    await act(async () => pressableLabelled(tree, 'Save counts').props.onPress());
    expect(saveStockCount).toHaveBeenCalledTimes(1);
  });

  // A failure that wrote NOTHING is the opposite case, and the basket must
  // survive it -- this is the one failure a shop fixes by pressing again.
  it('keeps the basket when the count itself was refused', async () => {
    saveStockCount.mockRejectedValueOnce(new Error('not authorized for shop shop-1'));
    const tree = await open();
    await backspace(tree, COUNTED, 2);
    await type(tree, COUNTED, '8');
    await act(async () => pressableLabelled(tree, 'Save counts').props.onPress());
    expect(fieldNamed(tree, COUNTED).props.value).toBe('8');
    expect(allText(tree)).toContain('not authorized');
  });
});
```

- [ ] **Step 3: Run it and verify it fails**

Run: `npx jest src/components/__tests__/stock-count-modal.test.tsx`
Expected: FAIL — `Cannot find module '@/components/stock-count-modal'`.

- [ ] **Step 4: Write the component's by-hand half**

Create `src/components/stock-count-modal.tsx`. Structure, in order — this mirrors `StockRestockModal` exactly except where commented.

```tsx
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { CategoryChip } from '@/components/category-chip';
import { StoreDropdown } from '@/components/store-dropdown';
import { AppModal } from '@/components/ui/app-modal';
import { useAuth } from '@/hooks/use-auth';
import { listCategories } from '@/lib/categories';
import { extractErrorMessage } from '@/lib/checkout-errors';
import {
  COUNT_REASONS,
  reasonLabel,
  summariseCount,
  type CountSummary,
  type PlannedCountLine,
} from '@/lib/count-import';
import { formatCents } from '@/lib/currency';
import { describePlanError } from '@/lib/entitlements';
import { isUncosted } from '@/lib/product-costing';
import { listProducts, saveStockCount } from '@/lib/products';
import { readCountedQuantity } from '@/lib/restock-typed-input';
import type { Product, StockCountReason } from '@/types/models';

// A stock-take, by hand or by spreadsheet.
//
// The sibling of StockRestockModal, and deliberately the same shape: a store
// picker, a search row, rows you type a number into, a running summary, one
// commit button, the same two tabs. A shop that has received a delivery once
// can count a shelf without reading anything.
//
// Two differences, and both follow from the fact that the number typed here is
// a TOTAL rather than an amount:
//
//  1. The field is PRE-FILLED with what the app believes. Restock's quantity
//     starts empty, because zero received is the honest default. A stock-take
//     mostly confirms, so a row left untouched means "I looked, it matched" --
//     real information, and the reason the footer counts three counted while
//     only two change anything.
//  2. The VARIANCE is a column, not a footnote. The person doing the count does
//     not need to be told the 8 they just counted. What they need to see, and
//     what they will be asked about, is how far off the app was.
//
// Not built here, deliberately: scanning. The mockup does not propose it, and
// the equivalent work on the restock sheet cost a CRITICAL to get right -- a
// scan landing in a number field while the same product's row was focused read
// the barcode as the quantity. Inventory's own wedge still stands down for the
// whole time this sheet is open (inventory.tsx's `enabled`), so a scan fired
// here does nothing rather than something wrong.

type Tab = 'hand' | 'sheet';
// `counted` is the RAW string the person typed, never a parsed number and never
// rewritten on the way in. See restock-typed-input.ts for why that is the whole
// design of this screen's input handling.
type Line = { product: Product; counted: string; reason: StockCountReason | null };
type LineReading = { line: Line; counted: number | null; variance: number | null };
```

The by-hand state and behaviour. Everything from `linesRef`/`updateLines` down to `closeAndReset` is transcribed from `stock-restock-modal.tsx` with `lines`/`Line` retyped — including the comments, which record why each exists:

```tsx
export function StockCountModal({ visible, shopId, onClose, onDone }: {
  visible: boolean;
  shopId: string;
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const { locations, activeLocation } = useAuth();
  const selectable = useMemo(() => locations.filter((location) => location.active), [locations]);

  const [tab, setTab] = useState<Tab>('hand');
  const [chosenLocationId, setLocationId] = useState<string | null>(activeLocation?.id ?? selectable[0]?.id ?? null);
  // Resolved on read rather than repaired in an effect: the initial value is
  // computed once, at first mount, which can be before the session's locations
  // have arrived -- and a one-store shop cannot correct it, because
  // StoreDropdown renders nothing for it.
  const locationId = chosenLocationId ?? activeLocation?.id ?? selectable[0]?.id ?? null;
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState<string | null>(null);
  const [categories, setCategories] = useState<string[]>([]);
  const [lines, setLines] = useState<Line[]>([]);
  // Every basket write goes through one helper that runs its updater
  // immediately and stores the result in both the ref and the state, so a
  // handler reading the basket never reads a render behind.
  const linesRef = useRef(lines);
  useEffect(() => {
    linesRef.current = lines;
  }, [lines]);
  const updateLines = useCallback((next: (current: Line[]) => Line[]) => {
    const value = next(linesRef.current);
    linesRef.current = value;
    setLines(value);
  }, []);
  const [catalogue, setCatalogue] = useState<Product[]>([]);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Which line's reason chips are expanded, by product id. Inline, never a
  // second modal: a sheet opened from a sheet is dropped by iOS without a word
  // and needs useStagedSheet to survive -- five chips that unfold under the row
  // avoid the whole class, and a reason is a five-way choice, not a screen.
  const [reasonOpenFor, setReasonOpenFor] = useState<string | null>(null);
  const [logExpense, setLogExpense] = useState(false);

  // Scoped to the store being counted, because "App says 11" is the number the
  // whole screen is about. Unlike Restock, the shop-wide list is NOT merged in:
  // a stock-take walks a room, and a product this store does not carry has no
  // shelf to walk to. listProducts(shopId, locationId) already draws exactly
  // that line and keeps rows sitting at zero.
  const load = useCallback(async () => {
    if (!locationId) return [] as Product[];
    return listProducts(shopId, locationId);
  }, [shopId, locationId]);

  // The basket is re-pointed at the reloaded rows as well as the picker: a line
  // keeps a whole Product snapshot taken when it was added, and "App says" is
  // read off that snapshot. Only `product` is replaced -- the typed count and
  // the chosen reason are the person's, not the server's.
  useEffect(() => {
    if (!visible) return;
    let active = true;
    load()
      .then((rows) => {
        if (!active) return;
        setCatalogue(rows);
        const byId = new Map(rows.map((product) => [product.id, product]));
        updateLines((current) =>
          current.map((line) => {
            const fresh = byId.get(line.product.id);
            return fresh ? { ...line, product: fresh } : line;
          })
        );
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [visible, load, updateLines]);

  useEffect(() => {
    if (!visible) return;
    listCategories(shopId)
      .then((rows) => setCategories(rows.map((r) => r.name)))
      .catch(() => {});
  }, [visible, shopId]);

  // Closing has to put everything back, because this component is never
  // unmounted -- the screen renders it with visible={false} and it returns
  // null, keeping all of its state.
  const closeAndReset = useCallback(() => {
    setBusy(false);
    updateLines(() => []);
    setNote('');
    setSearch('');
    setCategory(null);
    setError(null);
    setReasonOpenFor(null);
    setLogExpense(false);
    setPlan(null);
    setSheetFile(null);
    setSheetHeaders([]);
    setSheetNotice(null);
    setPartialCount(null);
    setTab('hand');
    onClose();
  }, [onClose, updateLines]);

  // PRE-FILLED, and this is the difference the whole screen turns on. Restock
  // seeds "1" because a delivery is at least one unit; a count seeds what the
  // app already holds, because most lines of a stock-take confirm it. Left
  // alone, the row reads as "I looked, it matched" and still counts.
  const addLine = (product: Product) => {
    updateLines((current) =>
      current.some((l) => l.product.id === product.id)
        ? current
        : [...current, { product, counted: String(product.stock), reason: null }]
    );
  };

  // Stores the keystrokes and nothing else. Rewriting text inside onChangeText
  // on a controlled input cannot work: the rewritten string is what the NEXT
  // keystroke is appended to, so a number is reinterpreted before it has
  // finished being typed. The row is NOT dropped at zero, and not at an empty
  // field either -- one backspace unmounting the focused input would close the
  // keyboard and take the reason chosen beside it. readCountedQuantity returns
  // null for an empty field, the commit is blocked, and the footer says why.
  const setCounted = (productId: string, text: string) => {
    updateLines((current) => current.map((l) => (l.product.id === productId ? { ...l, counted: text } : l)));
  };

  // Picking the reason a line already carries clears it, so a mis-tap is
  // undoable without a sixth "None" chip pretending to be a reason.
  const setReason = (productId: string, reason: StockCountReason) => {
    updateLines((current) =>
      current.map((l) => (l.product.id === productId ? { ...l, reason: l.reason === reason ? null : reason } : l))
    );
    setReasonOpenFor(null);
  };

  const removeLine = (productId: string) => {
    updateLines((current) => current.filter((l) => l.product.id !== productId));
  };

  const matches = useMemo(() => {
    const query = search.trim().toLowerCase();
    return catalogue
      .filter((p) => (category === null || p.category === category) && !lines.some((l) => l.product.id === p.id))
      .filter(
        (p) =>
          !query ||
          p.name.toLowerCase().includes(query) ||
          (p.sku ?? '').toLowerCase().includes(query) ||
          (p.barcode ?? '').toLowerCase().includes(query)
      )
      .slice(0, 12);
  }, [catalogue, search, category, lines]);

  // Every typed field read once, here, from the whole string -- the only place
  // in this component that turns text into numbers.
  const readings: LineReading[] = useMemo(
    () =>
      lines.map((line) => {
        const counted = readCountedQuantity(line.counted);
        return { line, counted, variance: counted === null ? null : counted - line.product.stock };
      }),
    [lines]
  );
  const everyCountReads = readings.every((reading) => reading.counted !== null);

  // The plan this basket amounts to, in exactly the shape the sheet tab builds
  // -- so one summariseCount serves both tabs and the two can never disagree
  // about what "2 differ" or "$13.83 of shortfall" means.
  //
  // Empty until every field reads, because a summary computed over half a
  // basket is a smaller number presented as the whole thing. `readings.length`
  // is checked separately in `canSubmit` below and NOT relied on here: `every`
  // on an empty array is true, so an empty basket produces an empty plan and a
  // summary of zeroes -- honest for a footer, and refused by the button.
  const handLines: PlannedCountLine[] = useMemo(
    () =>
      everyCountReads
        ? readings.map((reading) => ({
            productId: reading.line.product.id,
            productName: reading.line.product.name,
            previousQuantity: reading.line.product.stock,
            countedQuantity: reading.counted!,
            variance: reading.variance!,
            reason: reading.line.reason,
            unitCostCents: isUncosted(reading.line.product) ? null : reading.line.product.costCents,
          }))
        : [],
    [readings, everyCountReads]
  );
  const handSummary = useMemo(() => summariseCount(handLines), [handLines]);

  const canSubmit = Boolean(locationId) && readings.length > 0 && everyCountReads && !busy;

  const submit = async () => {
    if (!canSubmit || !locationId) return;
    setBusy(true);
    setError(null);
    // ONLY the write is inside the try, and the try ends the moment it
    // resolves. Everything after this point runs against a count that has
    // already committed, so nothing after it may reach a catch that leaves the
    // basket standing. On the restock sheet it did: `await onDone()` sat here,
    // onDone is the Inventory screen's reload, and a reload throwing on a
    // network blip landed in this catch -- an error beside a full basket and a
    // live Save button. Pressing it wrote the same count a second time.
    try {
      await saveStockCount(
        shopId,
        locationId,
        handLines.map((line) => ({
          productId: line.productId,
          countedQuantity: line.countedQuantity,
          reason: line.reason,
        })),
        { note: note.trim() || null }
      );
    } catch (err) {
      // save_stock_count is gated by enforce_shop_module('inventory'), which
      // raises the literal string "module_not_included" -- describePlanError
      // turns that into a sentence before the generic fallback sees it. It also
      // raises "not authorized for shop ..." for a member without
      // inventory.count, which extractErrorMessage passes through as written.
      //
      // Nothing was counted, so the basket is deliberately left exactly as it
      // is: this is the one failure a shop fixes by pressing again.
      setError(describePlanError(err) ?? extractErrorMessage(err));
      setBusy(false);
      return;
    }

    // The numbers are IN. The basket is spent from here on, and it is emptied
    // before anything that can fail.
    updateLines(() => []);
    setNote('');
    setLogExpense(false);
    // Swallowed on purpose: the caller's list refresh is not part of the
    // stock-take, and treating its failure as this screen's failure is what
    // produced the double-commit above.
    await onDone().catch(() => {});
    closeAndReset();
  };
```

Render, inside `AppModal` → overlay → card:

1. Header: title `Count`, a `Close` pill.
2. The `By hand` / `By sheet` segment, transcribed from the sibling.
3. `ScrollView` body:
   - Label `COUNTING AT`, then `<StoreDropdown value={locationId} onChange={setLocationId} allowAll={false} variant="field" title="Count stock at" placeholder="Choose a store" />`.
   - Label `ADD PRODUCTS`, then a plain `TextInput` with placeholder `Search by name, SKU or barcode…`. **Deliberately not `ScanSafeField`** — no scan path is offered here, and wrapping a field in a scan guard that can never fire is a component pretending to do something.
   - The category chips row, transcribed from the sibling (`chipScroll` carries `flexGrow: 0, flexShrink: 0, minWidth: 0`, without which a dozen categories stretch the sheet instead of scrolling).
   - `matches.map` → a `MatchRow` per product: the name, `App says {product.stock}`, and a `Count` affordance with `accessibilityLabel={`Count ${product.name}`}`.
   - The basket, when `lines.length > 0`, one `LineRow` each (below).
   - Label `NOTE`, then a `TextInput` with placeholder `Anything worth recording about this stock-take`.
4. The footer wrapper, matching the sibling's `footerWrap`.

`LineRow` renders, left to right:

| Element | Content |
|---|---|
| Name | `line.product.name` |
| Meta | `App says {line.product.stock}` |
| Remove | `Remove` |
| Field cap | `COUNTED` |
| Field | `TextInput`, `aria-label={`Counted units of ${line.product.name}`}`, `keyboardType="number-pad"`, `inputMode="numeric"`, `selectTextOnFocus`, `value={line.counted}`, `onChangeText={(text) => setCounted(line.product.id, text)}` |
| Variance | `varianceText(reading.variance)` — see below |
| Reason chip | `accessibilityLabel={`Reason for ${line.product.name}`}`, label `reasonLabel(line.reason)` when set and `Reason` when not |

with, directly beneath the row and only when `reasonOpenFor === line.product.id`, the five chips — each `accessibilityLabel={`Reason: ${label}`}` and `onPress={() => setReason(line.product.id, key)}`.

```tsx
// The typographic minus, not a hyphen -- it is the same glyph the mockup uses
// and it lines up under tabular figures, which a hyphen does not.
function varianceText(variance: number | null): string {
  if (variance === null) return '—';
  if (variance === 0) return '0';
  return variance > 0 ? `+${variance}` : `−${Math.abs(variance)}`;
}
```

Styling: reuse `lineMetaLow`'s amber for a positive variance? No — a shortfall is `#A3202F` (the sibling's `lineMetaMissing`), a surplus is `#007A38` (`pillText_ok`), and a match is the muted `#C9C9D1`. `+2` is shown in green because it is arithmetically the other direction, **and the footer nets the two** so nobody reads a good day into it.

The footer, in order:

1. The variance block, only when `lines.length > 0` — the sibling's `basket` styling with:
   - cap `VARIANCE`
   - total `{varianceUnitsText} · {varianceValueText}` where the value is `formatCents(handSummary.varianceCents)` when it is not null, and `value withheld` when it is
   - note `{counted} counted · {matched} matched · {differ} differ. Nothing changes until you press Save.`
2. The stock-loss checkbox — **Task 9 adds this; leave it out here.**
3. The button row:
   - left: `Save {counted} count{s}` over the hint `countHint(readings, handSummary)`
   - right: a `Pressable` with `accessibilityLabel="Save counts"`, disabled when `!canSubmit`, reading `Saving…` while busy and `Save counts` otherwise.

```tsx
// The line under the count, which is also the only place a blocked commit is
// explained. Ordered by what the person has to do next.
function countHint(readings: LineReading[], summary: CountSummary): string {
  if (readings.length === 0) return 'Nothing counted yet';
  if (readings.some((reading) => reading.counted === null)) return 'Type what you found on every line';
  return `${summary.differ} will change a number`;
}
```

Copy rules for this screen, all verbatim from the mockup:
- The button reads `Save counts` — never `Adjust`, and never `Adjust stock`. Save is what a person doing a stock-take thinks they are doing; "adjust" is the system's word for it, and it is the vocabulary that makes people reach for the wrong door in the first place.
- The row meta reads `App says {n}`.
- The field cap reads `COUNTED`.
- The unset reason chip reads `Reason`.
- The footer note reads `{n} counted · {n} matched · {n} differ. Nothing changes until you press Save.`
- The variance cap reads `VARIANCE`.

- [ ] **Step 5: Run the test and verify it passes**

Run: `npx jest src/components/__tests__/stock-count-modal.test.tsx`
Expected: PASS — all cases.

To prove the double-commit case is not passing for the wrong reason: temporarily move `await onDone()` back inside the `try`, re-run, and confirm `does not leave a live basket behind a failed reload` goes red. Then put it back.

- [ ] **Step 6: Typecheck, lint, and run the suite**

Run: `npx tsc --noEmit && npm run lint && npm test`
Expected: no errors; suite green.

- [ ] **Step 7: Verify in the running app**

The modal is not yet reachable from the Stock door (that is Task 7), so verify it by temporarily rendering `<StockCountModal visible shopId={shop.id} onClose={() => {}} onDone={reload} />` at the foot of `inventory.tsx`, then removing that line before committing.

Check on **web and iOS**: a product's row arrives pre-filled with its current count; changing 11 to 8 shows `−3` in red; the reason chips unfold under the row rather than opening a second sheet — **this is the check that matters on iOS**, because a nested modal there fails silently; pressing `Save counts` takes the product's stock to exactly 8, not to 3 and not to 19; and a product left out of the basket still holds the number it had.

- [ ] **Step 8: Commit**

```bash
git add src/components/stock-count-modal.tsx src/components/__tests__/stock-count-modal.test.tsx
git commit -m "feat(inventory): count a shelf by hand, and see how far off the app was"
```

---

### Task 6: `StockCountModal` — the sheet tab

**Files:**
- Modify: `src/components/stock-count-modal.tsx`
- Test: `src/components/__tests__/stock-count-modal.test.tsx`

**Interfaces:**
- Consumes: `planCount`, `planLines`, `summariseCount`, `countSheetRows`, `COUNT_SHEET_COLUMNS`, `COUNT_TEMPLATE_COLUMNS`, `reasonLabel`, and the types from Task 4; `rowsToCsv` from `@/lib/csv`; `shareCsv` from `@/lib/export-file`; `pickCsvFile` from `@/lib/pick-csv-file`; `downloadRejectedRowsCsv`, `type RejectedRow` from `@/lib/import-shared`.
- Produces: no new exports.

- [ ] **Step 1: Add the sheet-tab state and the four handlers**

Add to the component, mirroring `StockRestockModal`'s sheet tab:

```tsx
  // Sheet tab
  const [sheetFile, setSheetFile] = useState<string | null>(null);
  const [sheetHeaders, setSheetHeaders] = useState<string[]>([]);
  const [plan, setPlan] = useState<CountPlan | null>(null);
  const [sheetNotice, setSheetNotice] = useState<string | null>(null);
  // Set only by a commitPlan that partially failed, and read only by the
  // footer. commitPlan empties plan.counts on ANY failure so a re-press cannot
  // repeat a store that already went through -- but that same clearing is what
  // let the restock footer claim "nothing has changed yet" directly under an
  // error naming the store that just changed.
  const [partialCount, setPartialCount] = useState<{ lines: number; stores: number } | null>(null);

  // Everything every store carries, once. Three things need it: the download
  // states each count and each shelf, the sort walks the shelves, and the
  // preview compares each counted total against what the store holds now.
  //
  // `listProducts(shopId, locationId)` already resolves the store's own
  // shelf_number override (products.ts:112) as well as its stock, so the shelf
  // on the sheet is the shelf in THAT branch -- which is the whole reason the
  // column is per store rather than per product.
  const loadHoldings = useCallback(async (): Promise<{ byStore: Map<string, Product[]>; stockAt: Map<string, number> }> => {
    const byStore = new Map<string, Product[]>();
    const stockAt = new Map<string, number>();
    await Promise.all(
      selectable.map(async (location) => {
        const held = await listProducts(shopId, location.id);
        byStore.set(location.id, held);
        for (const product of held) stockAt.set(`${product.id}|${location.id}`, product.stock);
      })
    );
    return { byStore, stockAt };
  }, [shopId, selectable]);

  // Every store's own holdings, sorted for the walk. Rows already in the basket
  // come back pre-filled, so a shop that starts by hand and realises it is a
  // bigger job than it thought does not retype them.
  const downloadSheet = async () => {
    setBusy(true);
    setError(null);
    try {
      const { byStore } = await loadHoldings();
      const rows = countSheetRows(
        selectable,
        selectable.flatMap((location) =>
          (byStore.get(location.id) ?? []).map((product) => ({
            product,
            location,
            stock: product.stock,
            shelfNumber: product.shelfNumber,
          }))
        )
      );
      const columns = COUNT_SHEET_COLUMNS.map((column) =>
        column.header === 'Counted' || column.header === 'Reason'
          ? {
              header: column.header,
              value: (row: CountSheetRow) => {
                // Only the row for the store the basket is counting -- the same
                // product's row at another branch was not what was counted, and
                // pre-filling it would set that branch's shelf to a number
                // nobody walked to.
                const chosen =
                  row.location.id === locationId
                    ? lines.find((l) => l.product.id === row.product.id)
                    : undefined;
                if (!chosen) return '';
                // `counted` is already the raw string the person typed -- see
                // the Line type. It needs no converting on the way out.
                return column.header === 'Counted' ? chosen.counted : chosen.reason ? reasonLabel(chosen.reason) : '';
              },
            }
          : column
      );
      await shareCsv(rowsToCsv(rows, columns), 'count-sheet.csv', 'Count sheet');
    } catch (err) {
      setError(extractErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const uploadSheet = async () => {
    setError(null);
    setSheetNotice(null);
    const picked = await pickCsvFile(COUNT_TEMPLATE_COLUMNS);
    if (picked.status === 'cancelled') return;
    if (picked.status === 'error') {
      setError(picked.message);
      return;
    }
    const products = await listProducts(shopId);
    const { byStore, stockAt } = await loadHoldings();

    const next = planCount(picked.parsed, {
      products,
      locations: selectable,
      // The LIVE figure, not the sheet's own "App says" column, which was true
      // when the file was downloaded. The RPC reads it a third time under a row
      // lock at commit, and that reading is the one recorded.
      stockAt: (productId, locId) => stockAt.get(`${productId}|${locId}`) ?? 0,
    });
    // A fresh upload is a fresh attempt -- without this, re-uploading to retry
    // the rest after a partial failure would leave the previous attempt's
    // "N lines already counted" banner sitting under a brand new preview.
    setPartialCount(null);

    // A sheet that turns out to be one store is the same thing the by-hand tab
    // holds, so it lands there -- where a number can still be changed before
    // anything is written.
    const handedOver = next.counts.length === 1 && next.rejected.length === 0;
    // The plan is DROPPED when it is handed over, not merely stepped away
    // from. Left standing on the restock sheet it sat behind the `By sheet`
    // tab as a live preview of the ORIGINAL file with the button still
    // enabled, so a shop that corrected 8 to 12 on the by-hand tab and glanced
    // back could commit the 8 the file said.
    setSheetFile(handedOver ? null : picked.fileName);
    setSheetHeaders(handedOver ? [] : picked.parsed.headers);
    setPlan(handedOver ? null : next);

    if (handedOver) {
      const count = next.counts[0];
      // Scoped to THAT store, so each basket row's "App says" is the branch the
      // sheet counted rather than whichever store the dropdown was showing.
      const byId = new Map((byStore.get(count.locationId) ?? []).map((p) => [p.id, p]));
      setLocationId(count.locationId);
      updateLines(() =>
        count.lines.flatMap((line) =>
          byId.has(line.productId)
            ? [{
                product: byId.get(line.productId)!,
                // The basket field holds the RAW string a person typed, so a
                // planned number is turned back into text on the way in.
                counted: String(line.countedQuantity),
                reason: line.reason,
              }]
            : []
        )
      );
      setSheetNotice(
        `${picked.fileName} — ${count.lines.length} line${count.lines.length === 1 ? '' : 's'} ready. Change anything before saving.`
      );
      setTab('hand');
    }
  };

  // One save_stock_count call per store. A store that fails fails whole and is
  // named; the others still go through, because rolling back good work for a
  // problem the shop can fix by re-uploading one section helps nobody.
  const commitPlan = async () => {
    if (!plan || plan.counts.length === 0) return;
    setBusy(true);
    setError(null);
    const failures: string[] = [];
    const succeeded: PlannedCount[] = [];
    for (const count of plan.counts) {
      try {
        await saveStockCount(
          shopId,
          count.locationId,
          count.lines.map((line) => ({
            productId: line.productId,
            countedQuantity: line.countedQuantity,
            reason: line.reason,
          })),
          { note: note.trim() || null }
        );
        succeeded.push(count);
      } catch (err) {
        // Same RPC and same gates as the by-hand submit, so a plan-gated shop
        // and a member without inventory.count both read the same sentence
        // here that they would read there.
        failures.push(`${count.locationName}: ${describePlanError(err) ?? extractErrorMessage(err)}`);
      }
    }
    // The loop is over, so this list is SPENT -- every store in it either
    // counted or failed whole, and a store that failed is fixed by editing that
    // section of the sheet and uploading it again, never by pressing this
    // button a second time. Emptied here, before anything that can throw.
    setPlan({ ...plan, counts: [] });
    setPartialCount(
      succeeded.length > 0
        ? { lines: succeeded.reduce((sum, count) => sum + count.lines.length, 0), stores: succeeded.length }
        : null
    );
    await onDone().catch(() => {});
    setBusy(false);
    if (failures.length > 0) {
      setError(`Some of the count did not go through.\n${failures.join('\n')}`);
      return;
    }
    closeAndReset();
  };

  const downloadRejected = async () => {
    if (!plan || plan.rejected.length === 0) return;
    await downloadRejectedRowsCsv(plan.rejected, sheetHeaders, 'count-rejected.csv');
  };

  // The plan's own summary, computed by the same function the basket's is --
  // so "2 differ" and a shortfall value mean one thing on both tabs.
  const planSummary = useMemo(() => summariseCount(plan ? planLines(plan) : []), [plan]);
  const canCommitPlan = Boolean(plan) && (plan?.counts.length ?? 0) > 0 && !busy;
```

Add `CountPlan`, `CountSheetRow`, `PlannedCount`, `planCount`, `planLines`, `countSheetRows`, `COUNT_SHEET_COLUMNS`, `COUNT_TEMPLATE_COLUMNS` to the `@/lib/count-import` import; `rowsToCsv` from `@/lib/csv`; `shareCsv` from `@/lib/export-file`; `pickCsvFile` from `@/lib/pick-csv-file`; `downloadRejectedRowsCsv` and `type RejectedRow` from `@/lib/import-shared`.

- [ ] **Step 2: Render the sheet tab**

Under `tab === 'sheet'`, render a `SheetTab` sub-component (mirroring the sibling's) in this order:

1. Label `THE SHEET YOU GET BACK`, then one line of explanation: `Everything each store carries, with what the app says it has. Fill in Counted — and Reason, where you can.`
2. A `Download the sheet` button and an `Upload a filled sheet` button, in the sibling's `sheetActions` row.
3. The note that explains the sort, verbatim from the mockup:
   `Sorted by shelf, not by name. A stock-take is walked, and a sheet in the order of the room is the difference between an hour and an afternoon.`
4. `{fileName}` when one has been picked.
5. When `plan` is set, the pills — each rendered only when it has something to say:

| Pill | Tone | Text |
|---|---|---|
| counted | `ok` | `{planSummary.counted} counted` |
| matched | `ok` | `{planSummary.matched} matched` |
| differ | `bad` | `{differ} differ · {varianceUnitsText} units · {varianceValueText}` |
| no reason | `warn` | `{planSummary.reasonlessLines} with no reason` |
| skipped | `warn` | `{plan.skipped} rows left blank — skipped` |
| rejected | `bad` | `{plan.rejected.length} rejected` |

   where `varianceValueText` is `formatCents(planSummary.varianceCents)` when it is not null and `value withheld — some counted products have no cost` when it is.

6. Label `WHAT WILL CHANGE`, then one block per store, and inside it **only the lines whose variance is not zero**, as a table of Product / App / Counted / Variance / Reason. A line with no reason renders `— no reason given` in the amber `#8A5806`. Under the table, verbatim from the mockup:
   `Rows that matched are counted and not listed. Printing every "no change" row would bury the ones that need reading.`
7. The rejection list — row number and reason, first 8, then `…and {n} more, in the file below.` — plus a `Download the {n} rejected row(s)` button. Transcribed from the sibling.

The footer's button row, under `tab === 'sheet'`:
- left: `{planSummary.counted} counted` (or `{partialCount.lines} lines already counted` after a partial failure, or `No sheet yet`), over the hint `across {plan.counts.length} store(s) · nothing has changed yet` (or `to {partialCount.stores} store(s) before the failure above`, or `Download, fill it in, upload it back`).
- right: a `Pressable` with `accessibilityLabel="Save counts"`, disabled when `!canCommitPlan`, reading `Saving…` while busy and `Save counts` otherwise.

- [ ] **Step 3: Add the sheet-tab tests**

Append to `src/components/__tests__/stock-count-modal.test.tsx`:

```tsx
import { parseCsvText, rowsToCsv } from '@/lib/csv';
import { COUNT_TEMPLATE_COLUMNS } from '@/lib/count-import';

const { pickCsvFile } = jest.requireMock('@/lib/pick-csv-file') as { pickCsvFile: jest.Mock };

function uploaded(rows: Record<string, string>[]) {
  const csv = rowsToCsv(
    rows.map((row) => ({ Product: '', SKU: '', Barcode: '', Store: 'Main', Shelf: '', 'App says': '', Counted: '', Reason: '', ...row })),
    COUNT_TEMPLATE_COLUMNS.map((c) => ({ header: c.header, value: (r: Record<string, string>) => r[c.header] ?? '' }))
  );
  return { status: 'ok' as const, fileName: 'count-sheet.csv', parsed: parseCsvText(csv) };
}

describe('a count that arrives as a sheet', () => {
  // A one-store sheet is the same thing the basket holds, so it lands there --
  // where a number can still be corrected before anything is written.
  it('hands a single-store sheet to the by-hand tab and drops the plan behind it', async () => {
    listProducts.mockResolvedValue([product({})]);
    pickCsvFile.mockResolvedValue(uploaded([{ Product: 'QA widget', Counted: '8', Reason: 'Damaged' }]));
    let tree!: ReactTestRenderer;
    await act(async () => {
      tree = create(<StockCountModal visible shopId="shop-1" onClose={() => {}} onDone={async () => {}} />);
    });
    await act(async () => pressableLabelled(tree, 'By sheet').props.onPress());
    await act(async () => pressableLabelled(tree, 'Upload a filled sheet').props.onPress());

    expect(fieldNamed(tree, COUNTED).props.value).toBe('8');
    expect(allText(tree)).toContain('Damaged');
    // Corrected on the hand tab, then the sheet tab is looked at again: it must
    // show no live plan, because the basket is now the only copy of this count.
    await backspace(tree, COUNTED, 1);
    await type(tree, COUNTED, '12');
    await act(async () => pressableLabelled(tree, 'By sheet').props.onPress());
    expect(allText(tree)).toContain('No sheet yet');
  });

  it('never counts a product the sheet left blank', async () => {
    listProducts.mockResolvedValue([product({}), product({ id: 'p-2', name: 'QA other', sku: 'QA-2', stock: 5 })]);
    pickCsvFile.mockResolvedValue(
      uploaded([{ Product: 'QA widget', Counted: '8' }, { Product: 'QA other', Counted: '' }])
    );
    let tree!: ReactTestRenderer;
    await act(async () => {
      tree = create(<StockCountModal visible shopId="shop-1" onClose={() => {}} onDone={async () => {}} />);
    });
    await act(async () => pressableLabelled(tree, 'By sheet').props.onPress());
    await act(async () => pressableLabelled(tree, 'Upload a filled sheet').props.onPress());
    await act(async () => pressableLabelled(tree, 'Save counts').props.onPress());

    expect(saveStockCount).toHaveBeenCalledTimes(1);
    expect(saveStockCount.mock.calls[0][2]).toEqual([
      { productId: 'p-1', countedQuantity: 8, reason: null },
    ]);
  });
});
```

Note that the second case only reaches the sheet tab's own commit because the sheet has a rejected-free single store — so it hands over to the by-hand tab first. Give the second row a second store (`Store: 'Main'` on one and a second location in the `use-auth` mock) if the handover swallows it; the assertion that matters is the **one line** in the payload, wherever it commits from.

- [ ] **Step 4: Run everything**

Run: `npx jest src/components/__tests__/stock-count-modal.test.tsx && npm test && npm run lint && npx tsc --noEmit`
Expected: PASS throughout.

- [ ] **Step 5: Verify the round trip in the running app**

With the temporary render from Task 5 still in place: download the sheet and open it. Confirm it is **ordered by shelf within each store**, not alphabetically, and that products with no shelf sit at the bottom. Fill `Counted` on three rows at one store — one lower, one higher, one identical — put a `Reason` on only the lower one, and upload it. Confirm the preview shows `3 counted`, `1 matched`, `2 differ` and `1 with no reason`, that the matched row is **not** listed, and that committing leaves each product at exactly the number typed. Then confirm a product left blank in the sheet still holds the number it had. Remove the temporary render line.

- [ ] **Step 6: Commit**

```bash
git add src/components/stock-count-modal.tsx src/components/__tests__/stock-count-modal.test.tsx
git commit -m "feat(inventory): count a whole store from a sheet, walked in shelf order"
```

---

### Task 7: The Count row goes live, and the door starts checking who is asking

**Files:**
- Modify: `src/components/stock-actions-sheet.tsx`
- Modify: `src/components/__tests__/stock-actions-sheet.test.tsx`
- Modify: `src/app/(admin)/(tabs)/inventory.tsx` — the `can()` block around `:82`, the derived sheet flags at `:148-160`, the wedge `enabled` at `:319-338`, the `StockActionsSheet` render at `:984-1002`, and the modal renders after `:1013`

**Interfaces:**
- Consumes: `StockCountModal` (Tasks 5–6); `can` from `useAuth`.
- Produces: `type StockAction = 'restock' | 'count' | 'move' | 'import'`, and `StockActionsSheet` gains `showCount: boolean` beside its existing `showMove`.

- [ ] **Step 1: Write the failing test changes**

In `src/components/__tests__/stock-actions-sheet.test.tsx`, update the default render helper to pass `showCount` and add:

```tsx
const render = (over: Partial<React.ComponentProps<typeof StockActionsSheet>> = {}) =>
  textsIn(
    create(
      <StockActionsSheet visible onClose={() => {}} onPick={() => {}} showMove showCount {...over} />
    ).toJSON() as ReactTestRendererJSON
  );
```

```tsx
describe('the Count door', () => {
  // It shipped disabled with a "Coming next" badge, because the sheet cannot
  // teach the difference between adding and replacing with the replacing half
  // missing. The badge going away is the feature.
  it('no longer says it is coming', () => {
    expect(render().join(' ')).not.toContain('Coming next');
  });

  it('hands Count to onPick like any other door', () => {
    const picked: string[] = [];
    const tree = create(
      <StockActionsSheet visible onClose={() => {}} onPick={(a) => picked.push(a)} showMove showCount />
    );
    const row = tree.root.findAll((n) => n.props.accessibilityLabel === 'Count')[0];
    act(() => row.props.onPress());
    expect(picked).toEqual(['count']);
  });

  // The permission is enforced in the RPC, which is what actually stops a
  // write-off. This is the other half: a role that cannot do it is not offered
  // it, so nobody meets the refusal by pressing a button that looked live.
  it('is absent for someone without the permission', () => {
    const texts = render({ showCount: false });
    expect(texts).not.toContain('Count');
    // And the door does not become an empty room: Restock is the base meaning
    // of inventory.edit and is still there.
    expect(texts).toContain('Restock');
  });

  it('hides Move for someone without the transfer permission, one-store or not', () => {
    expect(render({ showMove: false })).not.toContain('Move');
  });
});
```

- [ ] **Step 2: Run it and verify it fails**

Run: `npx jest src/components/__tests__/stock-actions-sheet.test.tsx`
Expected: FAIL — `showCount` is not a prop, `Coming next` is still rendered, and the Count row is a `View` with no `onPress`.

- [ ] **Step 3: Open the door**

In `src/components/stock-actions-sheet.tsx`:

```tsx
export type StockAction = 'restock' | 'count' | 'move' | 'import';
```

Add `showCount: boolean` to the props, documented beside `showMove`:

```tsx
  // Whether this person may count. Gated on `inventory.count`, which every role
  // holding `inventory.edit` was granted when the split shipped -- so this is
  // false only where a shop has deliberately turned it off. The RPC checks the
  // same permission itself; this is the half that stops someone meeting the
  // refusal by pressing a button that looked live.
  showCount: boolean;
  // Whether this person may move stock between branches. Two conditions, and
  // the caller ANDs them: the shop has more than one store, and the role holds
  // `inventory.transfer`.
  showMove: boolean;
```

Replace the disabled `View` block with a live row, keeping the hint copy exactly as it already reads:

```tsx
          {/* Live at last. The hint is unchanged from the day this row shipped
              disabled, because the sentence was never the placeholder -- the
              room behind the door was. It is also the one place in the app
              where "adds" and "replaces" sit next to each other and the
              difference between them is visible at all. */}
          {showCount && (
            <Pressable onPress={() => onPick('count')} style={rowStyle} accessibilityLabel="Count">
              <Text style={styles.sheetRowLabel}>Count</Text>
              <Text style={styles.sheetRowHint}>
                A stock-take. Replaces the count with what you actually found — 11 becomes 8, and the app records the −3.
              </Text>
            </Pressable>
          )}
```

Delete `sheetRowDisabled`, `sheetRowHeading`, `sheetRowLabelDisabled`, `badge` and `badgeText` from the StyleSheet — nothing else uses them, and a disabled style left behind is an invitation to disable something else the same way.

Give the other three rows the same `accessibilityLabel` treatment (`Restock`, `Move`, `Import products`) so the test can find any of them by name.

- [ ] **Step 4: Run the test and verify it passes**

Run: `npx jest src/components/__tests__/stock-actions-sheet.test.tsx`
Expected: PASS.

- [ ] **Step 5: Wire the screen**

In `src/app/(admin)/(tabs)/inventory.tsx`:

Add the two permission reads beside `canEdit` (around `:82`):

```tsx
  const canEdit = can('inventory.edit');
  // Nested under canEdit and checked separately. Both were granted to every
  // role that already held inventory.edit when the split shipped, so these are
  // false only where a shop has deliberately turned one off -- and each is
  // re-checked by the database in the RPC behind it, because the sheet must not
  // be the only thing standing between a cashier and a write-off.
  const canCount = canEdit && can('inventory.count');
  const canTransfer = canEdit && can('inventory.transfer');
```

Add the derived flag beside `showRestock` (around `:148`):

```tsx
  const showCount = actionFromStock.value === 'count';
```

Change `transferOpen` so the permission is part of it, not only the module and the store count:

```tsx
  const transferOpen = moveFromImport.value !== null || actionFromStock.value === 'move';
```

(unchanged — the gate lives on the door's `showMove` below, and on `stock_transfers`' own RPC. Left alone deliberately so the Import escape hatch keeps working for a shop whose role does hold the permission.)

Pass both flags to the door (around `:984`):

```tsx
        <StockActionsSheet
          visible={stockDoorOpen && !actionFromStock.presenterSuppressed}
          showCount={canCount}
          showMove={showLocationFilter && canTransfer}
          onClose={() => { setShowStockActions(false); stockFromMore.close(); }}
          onDismissed={actionFromStock.onPresenterDismissed}
          onPick={(action) => {
            setShowStockActions(false);
            stockFromMore.close();
            // `true`, not `compact`: the thing being opened FROM is this sheet,
            // and it is a modal at every width -- an iPad wide enough for the
            // desktop header still presents the door as one. Passing `compact`
            // here would say "not from a modal" on that iPad and hand iOS the
            // second modal to drop, which is a dead button on the one device
            // where nothing is logged when it happens.
            actionFromStock.open(action, true);
          }}
        />
```

Render the modal directly after `StockRestockModal` (around `:1013`):

```tsx
      {shop && canCount && (
        <StockCountModal
          visible={showCount}
          shopId={shop.id}
          onClose={actionFromStock.close}
          onDone={reload}
        />
      )}
```

Add the import at the top, beside `StockRestockModal`'s:

```tsx
import { StockCountModal } from '@/components/stock-count-modal';
```

Extend the wedge stand-down at `:331-338`, adding the count sheet to the list and nothing else:

```tsx
    enabled:
      scanner.hardware &&
      !showAddModal &&
      editingProduct === null &&
      !importOpen &&
      !scannerOpen &&
      !stockDoorOpen &&
      !transferOpen &&
      !showRestock &&
      // The count sheet offers no scanning of its own, so unlike the other two
      // this is not about one code being read twice. It is the simpler rule the
      // app already follows: a scanner firing into the screen BEHIND an open
      // sheet adjusts a product nobody is looking at, and the count sheet is
      // the worst place for that to happen -- it would move the very number
      // being counted, out from under the person counting it.
      !showCount,
```

Apply the same addition to the `useWedgeSinkFallback` condition at the foot of the file (around `:889` in the pre-Count file), alongside the existing `!showRestock`.

- [ ] **Step 6: Verify in the running app, on web, iOS and Android**

Run the app.

- Wide window: the header reads `All stores ▾ | Export ▾ | Stock | + Add product`. `Stock` opens the door and **Count is now a live row with no badge**. Pressing it opens the count sheet.
- Phone-width window: `More` → `Stock` → `Count`. **This is the path that breaks on iOS if the staging is wrong**, so check it on an actual iOS simulator, not only on web. The Count modal must actually appear.
- iPad, wide enough for the desktop header: `Stock` → `Count` must also open. This is the case `compact` would have broken and `true` fixes.
- Sign in as a member whose role has `inventory.edit` but not `inventory.count` (create one in Settings → Roles after Task 8, or by editing `roles.permissions` directly against the local database): the `Stock` door opens, `Restock` is there, and `Count` is **absent**.
- With a hardware scanner attached on web: with the Count sheet open, scan something. Nothing should change on the Inventory list behind it.

- [ ] **Step 7: Run everything and commit**

Run: `npm test && npm run lint && npx tsc --noEmit`

```bash
git add src/components/stock-actions-sheet.tsx src/components/__tests__/stock-actions-sheet.test.tsx "src/app/(admin)/(tabs)/inventory.tsx"
git commit -m "feat(inventory): the fourth stock door opens"
```

---

### Task 8: The role editor, where the nesting becomes visible

**Files:**
- Modify: `src/components/settings/panels/roles-panel.tsx:172-201` (the permission list) and its `modalStyles`
- Modify: `src/lib/permission-groups.ts` (a grouping helper the editor can trust)
- Create: `src/components/settings/__tests__/roles-panel.test.tsx`
- Modify: `src/lib/__tests__/permissions.test.ts` (the grouping invariant)

**Interfaces:**
- Consumes: `PERMISSIONS` with its new `parent` field, `IMPLIED_PERMISSIONS`, `expandPermissions` (Task 1); `PERMISSION_GROUPS`.
- Produces: `groupedPermissions(): { label: string; rows: { permission: (typeof PERMISSIONS)[number]; children: (typeof PERMISSIONS)[number][] }[] }[]` from `@/lib/permission-groups`.

- [ ] **Step 1: Write the failing tests**

In `src/lib/__tests__/permissions.test.ts`:

```ts
// The editor renders from the groups, so a permission missing from every group
// would be a capability nobody could grant -- invisible, and only discoverable
// by a shop wondering why a feature never works for their staff.
it('files every permission in exactly one group', () => {
  const filed = PERMISSION_GROUPS.flatMap((g) => g.permissions);
  expect([...filed].sort()).toEqual([...ALL_PERMISSIONS].sort());
  expect(new Set(filed).size).toBe(filed.length);
});
```

Create `src/components/settings/__tests__/roles-panel.test.tsx`:

```tsx
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { RolesPanel } from '@/components/settings/panels/roles-panel';

// The nesting has to be REAL, not visual. Turning "Change stock" off must turn
// both children off and disable them -- otherwise a shop reads a role as
// count-free while roles.permissions still says otherwise, and the database
// believes the array.
//
// Driven through the panel's own toggle handler rather than through
// expandPermissions directly, because the bug this guards against lives in the
// component: `togglePermission` clears dependents when a parent goes off, and a
// child rendered from a flat list would keep its own switch live.

jest.mock('@/lib/staff', () => ({
  createRole: jest.fn(async () => {}),
  updateRole: jest.fn(async () => {}),
  deleteRole: jest.fn(async () => {}),
}));
const { updateRole } = jest.requireMock('@/lib/staff') as { updateRole: jest.Mock };

const STOCKROOM = {
  id: 'role-1',
  shopId: 'shop-1',
  name: 'Stockroom',
  permissions: ['inventory.view', 'inventory.edit', 'inventory.count', 'inventory.transfer'],
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
} as never;

function rowFor(tree: ReactTestRenderer, label: string): ReactTestInstance {
  return tree.root.findAll((n) => n.props.accessibilityLabel === `Permission: ${label}`)[0];
}

async function openEditor(): Promise<ReactTestRenderer> {
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = create(
      <RolesPanel shopId="shop-1" roles={[STOCKROOM]} usage={new Map()} onChange={async () => {}} />
    );
  });
  await act(async () => tree.root.findAll((n) => n.props.accessibilityLabel === 'Edit Stockroom')[0].props.onPress());
  return tree;
}

beforeEach(() => updateRole.mockClear());

describe('the nested inventory permissions', () => {
  it('shows the two verbs under the permission they sit inside', async () => {
    const tree = await openEditor();
    expect(rowFor(tree, '… count and write off').props.accessibilityState.checked).toBe(true);
    expect(rowFor(tree, '… move between stores').props.accessibilityState.checked).toBe(true);
  });

  // What a shop actually does with this screen: keep the stockroom receiving
  // deliveries, stop them writing stock off.
  it('turns one child off without touching the parent or its sibling', async () => {
    const tree = await openEditor();
    await act(async () => rowFor(tree, '… count and write off').props.onPress());
    await act(async () => tree.root.findAll((n) => n.props.accessibilityLabel === 'Save role')[0].props.onPress());
    expect(updateRole.mock.calls[0][1].permissions).toEqual([
      'inventory.view',
      'inventory.edit',
      'inventory.transfer',
    ]);
  });

  // The cascade. Not a courtesy: leaving a child on under an off parent stores
  // an array the database reads as "may count", on a role the screen shows as
  // unable to change stock at all.
  it('turns both children off when the parent goes off', async () => {
    const tree = await openEditor();
    await act(async () => rowFor(tree, 'Change stock').props.onPress());
    expect(rowFor(tree, '… count and write off').props.accessibilityState.checked).toBe(false);
    expect(rowFor(tree, '… count and write off').props.accessibilityState.disabled).toBe(true);
    await act(async () => tree.root.findAll((n) => n.props.accessibilityLabel === 'Save role')[0].props.onPress());
    expect(updateRole.mock.calls[0][1].permissions).toEqual(['inventory.view']);
  });

  // And a disabled child does nothing when pressed, rather than quietly
  // switching the parent back on behind it.
  it('ignores a press on a disabled child', async () => {
    const tree = await openEditor();
    await act(async () => rowFor(tree, 'Change stock').props.onPress());
    await act(async () => rowFor(tree, '… count and write off').props.onPress());
    expect(rowFor(tree, 'Change stock').props.accessibilityState.checked).toBe(false);
    expect(rowFor(tree, '… count and write off').props.accessibilityState.checked).toBe(false);
  });
});
```

- [ ] **Step 2: Run them and verify they fail**

Run: `npx jest src/lib/__tests__/permissions.test.ts src/components/settings/__tests__/roles-panel.test.tsx`
Expected: FAIL — the rows have no `accessibilityLabel`, no `accessibilityState`, and no notion of a disabled child.

- [ ] **Step 3: Add the grouping helper**

In `src/lib/permission-groups.ts`, add below `groupHasAny`:

```ts
// The catalogue as the role editor draws it: groups, each holding parent rows,
// each parent holding its children.
//
// Built from PERMISSION_GROUPS and PERMISSIONS rather than from a third list,
// so a new permission cannot be added to the catalogue and forgotten here --
// and anything filed in no group at all lands in a trailing "Other" rather than
// vanishing, which is what a plain `filter` would do to it. A permission nobody
// can see is a permission nobody can grant, and it fails as silence.
export function groupedPermissions(): {
  label: string;
  rows: { permission: PermissionEntry; children: PermissionEntry[] }[];
}[] {
  const childrenOf = (key: Permission) => PERMISSIONS.filter((p) => p.parent === key);
  const grouped = PERMISSION_GROUPS.map((group) => ({
    label: group.label,
    rows: PERMISSIONS.filter((p) => group.permissions.includes(p.key) && p.parent === undefined).map((permission) => ({
      permission,
      children: childrenOf(permission.key),
    })),
  }));
  const filed = new Set(PERMISSION_GROUPS.flatMap((g) => g.permissions));
  const orphans = PERMISSIONS.filter((p) => !filed.has(p.key) && p.parent === undefined);
  return orphans.length > 0
    ? [...grouped, { label: 'Other', rows: orphans.map((permission) => ({ permission, children: childrenOf(permission.key) })) }]
    : grouped;
}
```

with, at the top of the file:

```ts
import { PERMISSIONS, type Permission } from '@/lib/permissions';

type PermissionEntry = (typeof PERMISSIONS)[number];
```

- [ ] **Step 4: Render the nesting**

In `src/components/settings/panels/roles-panel.tsx`, replace the flat `PERMISSIONS.map(...)` block (`:176-184`) with groups and a shared row component:

```tsx
            {groupedPermissions().map((group) => (
              <View key={group.label}>
                <Text style={[modalStyles.fieldLabel, { marginTop: 16 }]}>{group.label.toUpperCase()}</Text>
                {group.rows.map(({ permission, children }) => (
                  <View key={permission.key}>
                    <PermissionRow
                      entry={permission}
                      checked={permissions.includes(permission.key)}
                      disabled={false}
                      onToggle={() => togglePermission(permission.key)}
                    />
                    {/* Indented and ruled, so a child reads as living INSIDE
                        the row above rather than beside it -- and disabled
                        when that row is off, because a child granted under an
                        absent parent is an array the database honours and the
                        screen denies. */}
                    {children.map((child) => (
                      <PermissionRow
                        key={child.key}
                        entry={child}
                        checked={permissions.includes(child.key)}
                        disabled={!permissions.includes(permission.key)}
                        onToggle={() => togglePermission(child.key)}
                        nested
                      />
                    ))}
                  </View>
                ))}
              </View>
            ))}
```

and add the row component beneath `RoleEditorModal`:

```tsx
function PermissionRow({
  entry,
  checked,
  disabled,
  onToggle,
  nested,
}: {
  entry: { key: Permission; label: string; description: string };
  checked: boolean;
  disabled: boolean;
  onToggle: () => void;
  nested?: boolean;
}) {
  return (
    <Pressable
      // The label, not the key: the tests and a screen reader both read the
      // sentence a shop reads.
      accessibilityLabel={`Permission: ${entry.label}`}
      accessibilityRole="switch"
      accessibilityState={{ checked, disabled }}
      // Guarded here as well as visually. A disabled row whose press still ran
      // would switch the child on under an off parent -- which is precisely the
      // state the disabling exists to prevent.
      onPress={disabled ? undefined : onToggle}
      style={[modalStyles.permissionRow, nested && modalStyles.permissionRowNested, disabled && modalStyles.permissionRowOff]}
    >
      <Switch value={checked} disabled={disabled} pointerEvents="none" onValueChange={() => {}} />
      <View style={{ flex: 1 }}>
        <Text style={modalStyles.rowLabel}>{entry.label}</Text>
        <Text style={modalStyles.rowSubLabel}>{entry.description}</Text>
      </View>
    </Pressable>
  );
}
```

Add to `modalStyles`:

```tsx
  permissionRowNested: { paddingLeft: 18, marginLeft: 2, borderLeftWidth: 2, borderLeftColor: '#F2F2F2' },
  permissionRowOff: { opacity: 0.45 },
```

Give the existing Edit and Save controls the labels the test looks for: `accessibilityLabel={`Edit ${role.name}`}` on the row's `Btn`, and `accessibilityLabel="Save role"` on both Save pressables.

Delete the now-unused `PERMISSIONS` import if nothing else in the file uses it, and import `groupedPermissions` from `@/lib/permission-groups` and `type Permission` from `@/lib/permissions`.

- [ ] **Step 5: Run the tests and verify they pass**

Run: `npx jest src/lib/__tests__/permissions.test.ts src/components/settings/__tests__/roles-panel.test.tsx`
Expected: PASS.

- [ ] **Step 6: Verify in the running app**

Settings → Roles → edit a role. The list is now grouped, with `INVENTORY` heading `See inventory`, `Change stock`, and its two indented children. Turn `Change stock` off and confirm both children grey out and clear. Save, reopen, and confirm they are still off. Turn `Change stock` back on, then turn only `… count and write off` off, save, and sign in as someone holding that role: the `Stock` door opens with `Restock` and no `Count`. Then confirm the other half of the gate by calling the RPC directly against the local database as that user — it must raise `not authorized for shop …` (already asserted by `verify-stock-counts.sql` check 5, so this is a spot-check that the UI and the RPC agree on which role is which).

- [ ] **Step 7: Run everything and commit**

Run: `npm test && npm run lint && npx tsc --noEmit`

```bash
git add src/components/settings/panels/roles-panel.tsx src/lib/permission-groups.ts \
  src/components/settings/__tests__/roles-panel.test.tsx src/lib/__tests__/permissions.test.ts
git commit -m "feat(settings): counting and moving are switches inside changing stock"
```

---

### Task 9: The optional stock-loss expense

**Files:**
- Modify: `src/components/stock-count-modal.tsx`
- Test: `src/components/__tests__/stock-count-modal.test.tsx`

**Interfaces:**
- Consumes: `createExpense` from `@/lib/expenses`; `NewExpenseInput` from `@/types/models`; `toDateColumn` from `@/lib/period`; `'stock_loss'` from Task 1.
- Produces: no new exports.

This task is deliberately last and self-contained. Drop it and everything before it still ships — the door still counts, still records the variance, and still says what it was worth. What it adds is the P&L finally hearing about it.

- [ ] **Step 1: Write the failing tests**

Append to `src/components/__tests__/stock-count-modal.test.tsx`:

```tsx
const { createExpense } = jest.requireMock('@/lib/expenses') as { createExpense: jest.Mock };

describe('logging the shortfall', () => {
  beforeEach(() => createExpense.mockClear());

  // Unticked, for the same reason Restock's sibling is: a silent write into
  // Accounting is a surprise, and opt-in is recoverable where opt-out is not.
  // (The double-count argument that justifies Restock's default does NOT apply
  // here -- nothing else in the app or in a shop's paperwork records shrinkage
  // -- which is exactly why it is worth stating that this is a deliberate
  // match rather than the same reasoning.)
  it('offers the write and does not make it', async () => {
    const tree = await open();
    await backspace(tree, COUNTED, 2);
    await type(tree, COUNTED, '8');
    expect(allText(tree)).toContain('Also log $13.83 of shortfall as stock loss');
    await act(async () => pressableLabelled(tree, 'Save counts').props.onPress());
    expect(createExpense).not.toHaveBeenCalled();
  });

  it('writes one stock_loss expense for the store when it is ticked', async () => {
    const tree = await open();
    await backspace(tree, COUNTED, 2);
    await type(tree, COUNTED, '8');
    await act(async () => pressableLabelled(tree, 'Log the shortfall as stock loss').props.onPress());
    await act(async () => pressableLabelled(tree, 'Save counts').props.onPress());

    expect(createExpense).toHaveBeenCalledTimes(1);
    expect(createExpense.mock.calls[0][1]).toMatchObject({
      locationId: 'loc-1',
      amountCents: 1383,
      category: 'stock_loss',
    });
  });

  // After the count, never before: an expense for a stock-take that failed is a
  // number in the P&L with no missing stock behind it.
  it('writes the expense only after the numbers have changed', async () => {
    const tree = await open();
    await backspace(tree, COUNTED, 2);
    await type(tree, COUNTED, '8');
    await act(async () => pressableLabelled(tree, 'Log the shortfall as stock loss').props.onPress());
    await act(async () => pressableLabelled(tree, 'Save counts').props.onPress());
    expect(saveStockCount.mock.invocationCallOrder[0]).toBeLessThan(createExpense.mock.invocationCallOrder[0]);
  });

  it('writes nothing when the count itself was refused', async () => {
    saveStockCount.mockRejectedValueOnce(new Error('not authorized for shop shop-1'));
    const tree = await open();
    await backspace(tree, COUNTED, 2);
    await type(tree, COUNTED, '8');
    await act(async () => pressableLabelled(tree, 'Log the shortfall as stock loss').props.onPress());
    await act(async () => pressableLabelled(tree, 'Save counts').props.onPress());
    expect(createExpense).not.toHaveBeenCalled();
  });

  // GROSS, not net. Two units found are not a refund, and the checkbox's figure
  // is deliberately larger than the variance line above it.
  it('offers the shortfall without netting off the units that were found', async () => {
    const tree = await open([product({}), product({ id: 'p-2', name: 'QA other', sku: 'QA-2', stock: 24, costCents: 461 })]);
    await act(async () => pressableLabelled(tree, 'Count QA other').props.onPress());
    await backspace(tree, COUNTED, 2);
    await type(tree, COUNTED, '8');
    await backspace(tree, 'Counted units of QA other', 2);
    await type(tree, 'Counted units of QA other', '26');
    expect(allText(tree)).toContain('−$4.61');
    expect(allText(tree)).toContain('Also log $13.83 of shortfall as stock loss');
  });

  // Hide, don't lie. An uncosted product contributes nothing to the total, so a
  // count full of them would offer a figure far below the real loss.
  it('hides the offer when a product that came up short has no cost, and says why', async () => {
    const tree = await open([product({ costCents: null })]);
    await backspace(tree, COUNTED, 2);
    await type(tree, COUNTED, '8');
    expect(allText(tree)).not.toContain('as stock loss');
    expect(allText(tree)).toContain('no cost recorded');
  });

  // The tick survives a tab switch and an edit, so the gate is re-read at
  // commit rather than trusted -- the checkbox merely disappearing must not
  // leave a stale yes behind it.
  it('does not write when an edit removes the honest total after ticking', async () => {
    const tree = await open();
    await backspace(tree, COUNTED, 2);
    await type(tree, COUNTED, '8');
    await act(async () => pressableLabelled(tree, 'Log the shortfall as stock loss').props.onPress());
    await backspace(tree, COUNTED, 1);
    await type(tree, COUNTED, '11');
    await act(async () => pressableLabelled(tree, 'Save counts').props.onPress());
    expect(createExpense).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run them and verify they fail**

Run: `npx jest src/components/__tests__/stock-count-modal.test.tsx`
Expected: FAIL — there is no checkbox and `createExpense` is never called.

- [ ] **Step 3: Add the checkbox and its explanation**

Add to `src/components/stock-count-modal.tsx`, beneath `ExpenseCheck`'s equivalent in the sibling:

```tsx
// The offer to write this stock-take into Accounting as well as into stock.
//
// `cents === null` renders NOTHING but the sentence beside it, and that is the
// whole design of this control. Shortfall is valued at cost, and any line whose
// product is uncosted contributes zero -- so a count full of uncosted products
// would offer to log a figure far below what actually went missing. A smaller
// number presented as the whole loss is worse than no number, because nothing
// downstream can tell it was partial. So it hides, and says why.
//
// Unticked, for the same reason its restock sibling is: a silent write into a
// shop's books is a surprise, and opt-in is recoverable where opt-out is not.
// The argument is genuinely weaker here -- Restock's default protects against
// double-counting a supplier invoice entered separately, and there is NO
// equivalent risk for shrinkage, because nothing else in the app or in a shop's
// paperwork records it at all. Matched to its sibling deliberately, so the two
// stock sheets do not disagree about how bold they are with somebody's P&L.
function StockLossCheck({
  cents,
  uncostedShortfallLines,
  on,
  onToggle,
}: {
  cents: number | null;
  uncostedShortfallLines: number;
  on: boolean;
  onToggle: () => void;
}) {
  if (cents === null) {
    return (
      <Text style={styles.checkWithheld}>
        {uncostedShortfallLines === 1
          ? '1 of the products that came up short has no cost recorded, so any stock-loss figure here would understate what was lost. Add its cost in Inventory.'
          : `${uncostedShortfallLines} of the products that came up short have no cost recorded, so any stock-loss figure here would understate what was lost. Add their costs in Inventory.`}
      </Text>
    );
  }
  if (cents <= 0) return null;
  return (
    <Pressable
      onPress={onToggle}
      accessibilityRole="checkbox"
      accessibilityLabel="Log the shortfall as stock loss"
      accessibilityState={{ checked: on }}
      style={styles.checkRow}
    >
      <View style={[styles.checkBox, on && styles.checkBoxOn]}>{on && <Text style={styles.checkMark}>✓</Text>}</View>
      <Text style={styles.checkLabel}>Also log {formatCents(cents)} of shortfall as stock loss</Text>
    </Pressable>
  );
}
```

with, in the StyleSheet:

```tsx
  checkWithheld: { fontSize: 12, color: '#9CA3AF', lineHeight: 17 },
```

Render it in the footer wrapper, above the button row, reading whichever tab's summary is on screen:

```tsx
            {/* Above the buttons rather than beside them: it is a question
                about the stock-take, and a shop should read it on the way to
                the button whose meaning it changes. */}
            <StockLossCheck
              cents={(tab === 'hand' ? handSummary : planSummary).shortfallCents}
              uncostedShortfallLines={(tab === 'hand' ? handSummary : planSummary).uncostedShortfallLines}
              on={logExpense}
              onToggle={() => setLogExpense((ticked) => !ticked)}
            />
```

- [ ] **Step 4: Write the expense, after the numbers**

Add the helper beside `submit`:

```tsx
  // After the count, never before: an expense for a stock-take that failed to
  // land is a number in the P&L with no missing stock behind it. This never
  // throws and never closes anything -- it RETURNS what went wrong so the
  // caller can say so while keeping the count, because the numbers really did
  // change and rolling them back to punish a failed expense loses the more
  // important of the two. (Returning rather than calling setError is what makes
  // that possible: both callers finish by resetting, which would wipe the
  // message.)
  const logStockLoss = async (locId: string, amountCents: number): Promise<string | null> => {
    try {
      await createExpense(shopId, {
        locationId: locId,
        // Local date, not toISOString().slice(0, 10) -- an evening stock-take
        // west of Greenwich would otherwise land in tomorrow's P&L.
        occurredOn: toDateColumn(new Date()),
        amountCents,
        category: 'stock_loss',
        vendorId: null,
        // There is no counterparty and nothing was paid today; `cash` is the
        // column's default and the only honest thing to put in a field that
        // does not apply. The note is what carries the meaning.
        paymentMethod: 'cash',
        note: note.trim() ? `Stock-take — ${note.trim()}` : 'Stock-take',
      } satisfies NewExpenseInput);
      return null;
    } catch (err) {
      return extractErrorMessage(err);
    }
  };
```

In `submit`, after the count succeeds and the basket is emptied, and **before** `await onDone()` — reading from this render's closure, so emptying the basket above does not change either value:

```tsx
    // Only after the numbers are in, and only if the offer was actually on
    // screen. `handSummary.shortfallCents` is re-read here rather than trusting
    // `logExpense` alone, because the tick survives an edit that turns a
    // shortfall into a match, and a checkbox merely disappearing must not leave
    // a stale yes behind it.
    const shortfall = handSummary.shortfallCents;
    const expenseProblem =
      logExpense && shortfall !== null && shortfall > 0 ? await logStockLoss(locationId, shortfall) : null;
    await onDone().catch(() => {});
    if (expenseProblem) {
      // The sheet stays open carrying the one sentence that says what happened
      // and what is left to do by hand. The basket is already empty, so the
      // button still on screen cannot count the same shelf again.
      setError(`The count was saved, but the stock loss was not logged: ${expenseProblem}`);
      setBusy(false);
      return;
    }
    closeAndReset();
```

In `commitPlan`, inside the per-store loop, immediately after that store's `saveStockCount` resolves — **not** after the loop:

```tsx
        succeeded.push(count);
        // Per store, not one lump. Each store's count is its own stock-take,
        // and per-store reporting (migration 20260816000000) would otherwise
        // attribute the whole loss to whichever store happened to be first.
        // `logStockLoss` cannot throw, which matters here: an expense failure
        // reaching the catch below would name this store as one whose count did
        // not go through, when it did.
        if (logExpense) {
          const storeShortfall = summariseCount(count.lines).shortfallCents;
          if (storeShortfall !== null && storeShortfall > 0) {
            const problem = await logStockLoss(count.locationId, storeShortfall);
            if (problem) expenseProblems.push(`${count.locationName}: ${problem}`);
          }
        }
```

with `const expenseProblems: string[] = [];` declared beside `failures`, and the final error assembled from both, kept apart because they say opposite things:

```tsx
    if (failures.length > 0 || expenseProblems.length > 0) {
      // An expense problem alone lands here too -- the numbers are in, so the
      // plan is spent either way, and the sentence says which store's stock
      // loss is left to add by hand. Kept separate from `failures`, which heads
      // its error with "Some of the count did not go through": folding the two
      // together would tell a shop its stock-take failed when it did not.
      setError(
        [
          failures.length > 0 ? `Some of the count did not go through.\n${failures.join('\n')}` : null,
          expenseProblems.length > 0
            ? `The count was saved, but the stock loss was not logged:\n${expenseProblems.join('\n')}`
            : null,
        ]
          .filter(Boolean)
          .join('\n\n')
      );
      return;
    }
```

Add `createExpense` from `@/lib/expenses`, `toDateColumn` from `@/lib/period`, and `type NewExpenseInput` to the component's imports.

- [ ] **Step 5: Run the tests and verify they pass**

Run: `npx jest src/components/__tests__/stock-count-modal.test.tsx`
Expected: PASS.

- [ ] **Step 6: Verify in the running app**

Count a shelf down with the box ticked, on a product that has a cost. Open Accounting → Expenses and confirm one `Stock loss` row for the shortfall, and — the point of the whole feature — that it appears **inside Operating expenses** and reduces Net profit, unlike the `Inventory restock` rows beside it which sit under "Stock & owner draws — excluded from profit". Count a second shelf with the box unticked and confirm no expense is written. Then count a product with no cost recorded down by three and confirm the checkbox is **absent** and the sentence naming the uncosted product appears in its place. Finally, upload a two-store sheet with a shortfall at each and confirm **two** expense rows, one per store, each for that store's own shortfall.

- [ ] **Step 7: Run everything and commit**

Run: `npm test && npm run lint && npx tsc --noEmit`

```bash
git add src/components/stock-count-modal.tsx src/components/__tests__/stock-count-modal.test.tsx
git commit -m "feat(inventory): a stock-take can tell the P&L what it cost"
```

---

## Final verification

- [ ] `npm test` — full Jest suite green
- [ ] `npm run test:db` — full migration chain applies from empty, every verify script passes (14 self-contained checks after this branch, up from 12)
- [ ] `npm run lint` and `npx tsc --noEmit` — clean
- [ ] Manual pass on **web, iOS simulator and Android emulator** (`/testing-kaiibi` drives all three):
  - The Stock door's `Count` row is live, with no `Coming next` badge
  - Phone path `More → Stock → Count` opens the modal on iOS
  - A wide iPad's `Stock → Count` also opens the modal
  - A count of 8 against 11 leaves **8**, not 19 and not 3
  - A count of **0** is accepted and empties the shelf
  - A product left out of a count still holds the number it had
  - The by-hand reason chips unfold **under the row**, never as a second sheet
  - The downloaded sheet is ordered by shelf within each store, with unshelved products last
  - The preview lists only the lines that differ, and reports `N with no reason`
  - A role with `inventory.edit` but not `inventory.count` sees the door without the Count row, and the RPC refuses it directly
  - A single-store shop on the Standard plan (no `multi_location`) can count
  - A ticked stock-loss box writes one `Stock loss` expense per store, inside Operating expenses
  - A count containing an uncosted shortfall shows the explanation instead of the checkbox
- [ ] Update `docs/design/inventory-count-mockup.html` with a STATUS block at its head saying what shipped, what did not, and why — matching what `docs/design/inventory-restock-mockup.html` gained at the end of the restock branch. It should record at minimum: the catalogue-editing permission was drawn but not built; the parent row's description diverges from the mockup because of that; and scanning inside the count sheet was never proposed and is not built.
- [ ] Add a `.superpowers/sdd/progress.md` ledger for this branch, or append a Count section to the existing one, before dispatching Task 1.

## Self-review

Run against the mockup with fresh eyes after writing. What it found, and what was changed inline:

**1. Spec coverage.** Every section of the mockup maps to a task:

| Mockup section | Task |
|---|---|
| §1 Why Count is the dangerous door — the shrinkage mechanism | Task 2 (the migration's header comment carries it verbatim in substance), Task 1 (the category), Task 9 (the write) |
| §2 Counting by hand — pre-filled field, variance column, `Save counts` | Task 5 |
| §3 Counting by sheet — download/fill/upload, shelf order, preview pills, matched rows unlisted | Tasks 4 and 6 |
| §4 Reasons — five, optional, per line, gap reported, positives netted | Tasks 2 (constraint), 4 (`readReason`, `summariseCount`), 5 (chips), 6 (pills) |
| §5 Where the loss goes — unticked checkbox, hides when uncosted | Tasks 1 and 9 |
| §6 Who is allowed — two permissions, nested, defaulting on, RPC-enforced | Tasks 1, 2, 7, 8 |
| §7 Open questions — all four closed in *Decisions locked in* | — |

Two gaps found and closed while reviewing:
- The mockup's §6 role editor draws a `Change stock` row whose description (`Receive deliveries, count, and move between stores.`) would be **false** while `inventory.edit` still governs catalogue writes (`0024_permission_gates.sql:85-91`). Task 1 now ships that copy with a trailing clause naming what it also covers, and the divergence is a row in *Decisions locked in* rather than a silent edit.
- Nothing in the mockup states what to show *instead of* the hidden checkbox. Task 9 invents the sentence, and it is flagged here as the one piece of user-facing copy in this plan that is not from the mockup.

**2. Placeholder scan.** No `TBD`, no "similar to Task N", no "add error handling". Every step that changes code shows the code. Two places deliberately describe render structure in prose plus a copy table rather than full JSX (Task 5 step 4, Task 6 step 2) — matching how the restock plan handled the same two screens, and every string in those tables is exact.

**3. Type consistency.** Three mismatches found and fixed inline:
- `countSheetRows` was first written taking only `entries`, which made store ordering unspecifiable; it now takes `(locations, entries)` and the Task 4 tests call it that way.
- `summariseCount` originally had one `uncostedLines`, which could not answer both "withhold the net value" and "hide the checkbox" — they are different line sets. Split into `uncostedDifferingLines` and `uncostedShortfallLines`, and both are used: the first by Task 6's pill, the second by Task 9's sentence.
- `saveStockCount`'s third argument is named `lines` (not `items`) in Task 3 and is called with `countedQuantity`/`reason` keys; Tasks 5, 6 and 9 all use exactly those names, and the RPC's four parameters are re-checked by eye in Task 3 step 3 because `tsc` cannot see across that boundary.

One thing checked and deliberately left: `readCountedQuantity` lives in `src/lib/restock-typed-input.ts`, whose name is now historical. Renaming it would touch four files for no behaviour, and a second parser is the outcome the shared module exists to prevent — so the file keeps its name and Task 4's comment says why the count reader is in it.
