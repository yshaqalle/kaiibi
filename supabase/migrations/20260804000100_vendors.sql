-- Vendors: the shop's suppliers and service providers, reusable across
-- expenses and (later) vendor bills so "Nairobi Beauty Distributors" is typed
-- once rather than re-keyed as free text on every purchase.
--
-- Structurally the same class of entity as brands/cashiers/promotions
-- (migration 0024): shop-wide reference data any member may need to read,
-- managed from Settings. Deliberately *not* a replacement for
-- `products.supplier_name`, which is a per-product free-text label about where
-- stock comes from; this table is about who the shop pays.
create table public.vendors (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  name text not null,
  contact_person text,
  phone text,
  email text,
  address text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  unique (shop_id, name)
);
create index vendors_shop_id_idx on public.vendors(shop_id);

alter table public.vendors enable row level security;

-- Reads are member-wide: the vendor picker on the expense editor needs names,
-- and that editor is reachable with expenses.manage alone.
create policy "read vendors" on public.vendors for select using (is_shop_member(shop_id));

-- Insert is deliberately broader than update/delete. The expense/bill editors
-- offer an inline "+ New vendor" quick-add so a purchase can be recorded
-- without a detour through Settings -- the same reasoning that lets POS
-- checkout create a customer (pos_search_customers/quick add, migration 0025)
-- without granting the full customers.edit permission.
create policy "insert vendors" on public.vendors for insert
  with check (has_any_shop_permission(shop_id, array['settings.access', 'expenses.manage', 'invoices.manage']));

-- Editing or removing an existing vendor record stays a Settings-level action:
-- a rename affects every expense that references it, and a delete is only
-- safe because dependent rows use `on delete set null` plus a frozen name.
create policy "update vendors" on public.vendors for update
  using (has_shop_permission(shop_id, 'settings.access'))
  with check (has_shop_permission(shop_id, 'settings.access'));
create policy "delete vendors" on public.vendors for delete
  using (has_shop_permission(shop_id, 'settings.access'));

grant select, insert, update, delete on public.vendors to authenticated;

-- The seeded Manager role is "everything except settings and staff
-- management" (0020/0024), so it gets the accounting permissions but not
-- settings.access -- meaning it can quick-add a vendor while recording a
-- purchase, but manages the vendor list itself only if separately granted.
-- Guarded so re-running against an already-updated role is a no-op, and so a
-- shop that has since customised its Manager role isn't overwritten.
update public.roles
  set permissions = permissions || array['expenses.view', 'expenses.manage']
  where name = 'Manager'
    and permissions @> array['sales.edit', 'dashboard.view']
    and not permissions && array['expenses.manage'];
