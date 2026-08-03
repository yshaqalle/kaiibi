-- Expenses: what the shop spends, the other half of the P&L.
--
-- `occurred_on` is a date, not a timestamp, and is separate from `created_at`:
-- a receipt is often logged days after the purchase, and it's the purchase
-- date that decides which period the cost belongs to.
--
-- Categories are a text column plus a check constraint rather than a native
-- enum -- matching how payment_method is handled on sales/sale_payments
-- (migrations 0001/0005), so the schema has one convention for a closed set of
-- string values rather than two.
--
-- Two categories are deliberately *not* operating expenses, and reporting
-- excludes both from that subtotal while still counting them as cash out:
--   * inventory_purchase -- stock is an asset until it sells, at which point it
--     becomes COGS (computed from sale_items.unit_cost_cents). Counting the
--     purchase as an expense too would double-count it.
--   * owner_draw -- money the owner takes out is an equity withdrawal, not a
--     cost of running the shop. Treating it as an expense understates profit.
create table public.expenses (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  occurred_on date not null default current_date,
  amount_cents integer not null check (amount_cents > 0),
  category text not null check (category in (
    'inventory_purchase','rent','utilities','salaries_wages','marketing',
    'supplies','transport_delivery','maintenance_repairs','fees_charges',
    'owner_draw','other'
  )),
  -- Set null rather than cascade: deleting a vendor must not delete the
  -- history of what was spent with them.
  vendor_id uuid references public.vendors(id) on delete set null,
  payment_method text not null default 'cash' check (payment_method in ('cash','zaad','edahab','other')),
  note text,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id)
);
create index expenses_shop_id_idx on public.expenses(shop_id);
-- Every reporting query filters by shop and date range together.
create index expenses_shop_occurred_idx on public.expenses(shop_id, occurred_on);
create index expenses_vendor_id_idx on public.expenses(vendor_id);

alter table public.expenses enable row level security;

-- sales.view also grants read. Reporting reads both sides of the P&L at once,
-- and the Accounting screen is gated on sales.view -- so without this, anyone
-- who can open Accounting but lacks expenses.view would see revenue with no
-- costs against it, which is worse than showing nothing. Mirrors the reasoning
-- in 0024 for dashboard.view being allowed to read the sales table.
create policy "read expenses" on public.expenses for select
  using (has_any_shop_permission(shop_id, array['expenses.view', 'expenses.manage', 'sales.view']));

create policy "insert expenses" on public.expenses for insert
  with check (has_shop_permission(shop_id, 'expenses.manage'));
create policy "update expenses" on public.expenses for update
  using (has_shop_permission(shop_id, 'expenses.manage'))
  with check (has_shop_permission(shop_id, 'expenses.manage'));
create policy "delete expenses" on public.expenses for delete
  using (has_shop_permission(shop_id, 'expenses.manage'));

grant select, insert, update, delete on public.expenses to authenticated;
