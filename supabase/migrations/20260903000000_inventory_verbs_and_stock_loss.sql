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
-- "Shop owners are deliberately untouched" means the two statements below
-- carry no owner-specific exception, not that an owner's data goes unwritten.
-- An owner's Owner role already holds inventory.edit for every shop that has
-- one, so the `update public.roles` below and default_shop_roles() grant it
-- both new verbs exactly as they would any other role -- and since
-- 20260823000000 the owner has a shop_members row pointing at that role, so it
-- is that row's role whose permissions this migration writes to. That grant is
-- redundant, not load-bearing: user_has_shop_permission (0024_permission_gates.sql)
-- short-circuits on shops.owner_id, so an owner already holds every permission
-- that exists, whatever their Owner role's array says.

-- Guarded so re-running is a no-op and a customised role is not overwritten --
-- the same shape 20260804000500 used for budgets.manage and 20260822000000
-- used for registers.manage. `not permissions && array[...]` means "holds
-- neither", which is exact today because nothing can hold either yet.
update public.roles
  set permissions = permissions || array['inventory.count', 'inventory.transfer']
  where permissions @> array['inventory.edit']
    and not permissions && array['inventory.count', 'inventory.transfer'];

-- ── default_shop_roles(): reach the shops that do not exist yet ─────────────
-- 20260823000000 (lines 65-67) says it plainly, and 20260826000100 followed it
-- for the discount permissions: any migration that grants a permission to a
-- default role must update this function too, not only run an `update
-- public.roles`. That update reaches the shops that exist today; this function
-- reaches the ones created tomorrow. Without it the seeded Manager of every
-- shop opened after this migration would hold inventory.edit and neither verb,
-- while every shop opened before it holds all three -- two different meanings
-- of the word "Manager", and the newer shops' stockroom staff would find the
-- Count door shut for a reason nobody could name.
--
-- Reproduced verbatim from public.default_shop_roles() as defined in
-- 20260826000100_sale_promotion_attribution.sql, with exactly one change:
-- 'inventory.count' and 'inventory.transfer' are added to Manager and to Owner.
-- Cashier is deliberately left alone -- it does not hold inventory.edit, and
-- the whole point of the backfill's guard is that a till role gains nothing.
create or replace function public.default_shop_roles()
returns table (name text, permissions text[])
language sql immutable set search_path = public as $$
  values
    ('Cashier'::text, array['pos.access', 'inventory.view', 'discounts.apply', 'discounts.manual']::text[]),
    -- "Everything except settings and staff management", as 0020 put it, minus
    -- the pieces that were deliberately never granted: sales.refund is its own
    -- gate (see the catalog in src/lib/permissions.ts) and the people.* HR
    -- permissions read as staff management. This is exactly the set an existing
    -- shop's Manager holds today, so old and new shops agree.
    ('Manager'::text, array[
      'pos.access', 'inventory.view', 'inventory.edit', 'inventory.count', 'inventory.transfer',
      'sales.view', 'sales.edit',
      'customers.view', 'customers.edit', 'dashboard.view',
      'expenses.view', 'expenses.manage', 'invoices.view', 'invoices.manage',
      'budgets.manage', 'registers.manage', 'discounts.apply', 'discounts.manual'
    ]::text[]),
    -- The whole catalog, so the Roles screen doesn't show the owner holding
    -- nothing. It changes no behaviour either way: user_has_shop_permission()
    -- answers true for an owner before it ever looks at a role.
    ('Owner'::text, array[
      'pos.access', 'inventory.view', 'inventory.edit', 'inventory.count', 'inventory.transfer',
      'sales.view', 'sales.edit', 'sales.refund',
      'customers.view', 'customers.edit', 'dashboard.view', 'settings.access', 'staff.manage',
      'people.timeoff.approve', 'people.payroll.manage', 'people.timesheet.view', 'people.schedule.manage',
      'expenses.view', 'expenses.manage', 'invoices.view', 'invoices.manage', 'budgets.manage', 'registers.manage',
      'discounts.apply', 'discounts.manual'
    ]::text[]);
$$;

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
