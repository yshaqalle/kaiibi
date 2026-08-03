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
