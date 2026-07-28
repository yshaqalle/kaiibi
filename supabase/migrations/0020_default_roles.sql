-- Seeds two example roles per shop so the Roles screen isn't empty the
-- first time an admin opens it -- Cashier (checkout + inventory view, the
-- exact "cashier" scope described when this feature was scoped) and
-- Manager (everything except settings and staff management). Both are
-- ordinary rows an admin can rename, edit, or delete like any other role.
insert into public.roles (shop_id, name, permissions)
  select id, 'Cashier', array['pos.access', 'inventory.view']
  from public.shops
  on conflict (shop_id, name) do nothing;

insert into public.roles (shop_id, name, permissions)
  select id, 'Manager', array['pos.access', 'inventory.view', 'inventory.edit', 'sales.view', 'sales.edit', 'dashboard.view']
  from public.shops
  on conflict (shop_id, name) do nothing;
