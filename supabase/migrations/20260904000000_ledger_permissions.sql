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
-- 20260823000000 (lines 65-67) states the rule and 20260903000000 followed it:
-- any migration that grants a permission to a default role must update this
-- function too, not only run an `update public.roles`. That update reaches the
-- shops that exist today; this function reaches the ones created tomorrow.
-- Without it, old and new shops would disagree about what "Manager" means.
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
