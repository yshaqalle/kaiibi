-- Phase 3 of staff accounts & permissions: actually enforce the permission
-- catalog. 0018 deliberately shipped staff with blanket shop access
-- (is_shop_member = "allowed in this shop at all"), which meant a Cashier
-- role granting only ['pos.access','inventory.view'] still read every sale,
-- every dashboard aggregate, and every settings table. This migration makes
-- roles.permissions the thing that decides.
--
-- is_shop_member() stays (a few tables are legitimately shop-wide reference
-- data that any member needs -- categories/brands/tags/cashiers/promotions/
-- currencies), but every table holding actual business data now checks a
-- specific permission instead.

-- Resolves one permission for an arbitrary user. security definer so it can
-- read shop_members/roles regardless of the caller's own RLS -- same pattern
-- as is_shop_member() in 0018. The shop owner (admin) implicitly holds every
-- permission and deliberately has no shop_members row (see 0017).
create or replace function public.user_has_shop_permission(p_user_id uuid, p_shop_id uuid, p_permission text)
returns boolean
language sql security definer stable set search_path = public as $$
  select exists (select 1 from public.shops s where s.id = p_shop_id and s.owner_id = p_user_id)
    or exists (
      select 1 from public.shop_members m
        join public.roles r on r.id = m.role_id
      where m.shop_id = p_shop_id and m.user_id = p_user_id and m.active
        and p_permission = any(r.permissions)
    );
$$;
grant execute on function public.user_has_shop_permission(uuid, uuid, text) to authenticated, service_role;

-- The RLS/RPC-facing wrapper: same check for whoever is calling.
create or replace function public.has_shop_permission(p_shop_id uuid, p_permission text)
returns boolean
language sql security definer stable set search_path = public as $$
  select public.user_has_shop_permission(auth.uid(), p_shop_id, p_permission);
$$;
grant execute on function public.has_shop_permission(uuid, text) to authenticated;

-- "any of these" -- several surfaces are reachable from more than one
-- permission (products are readable from Inventory *or* the POS; customers
-- are writable from the Customers directory *or* the POS checkout picker).
create or replace function public.has_any_shop_permission(p_shop_id uuid, p_permissions text[])
returns boolean
language sql security definer stable set search_path = public as $$
  select exists (select 1 from public.shops s where s.id = p_shop_id and s.owner_id = auth.uid())
    or exists (
      select 1 from public.shop_members m
        join public.roles r on r.id = m.role_id
      where m.shop_id = p_shop_id and m.user_id = auth.uid() and m.active
        and r.permissions && p_permissions
    );
$$;
grant execute on function public.has_any_shop_permission(uuid, text[]) to authenticated;

-- What the signed-in user's role grants, for the client to build its nav and
-- route guards from (src/hooks/use-auth.tsx). Returns '{}' for the admin --
-- they have no shop_members row, and the client resolves "owns this shop" to
-- the full catalog itself rather than duplicating the catalog in SQL.
create or replace function public.my_shop_permissions(p_shop_id uuid)
returns text[]
language sql security definer stable set search_path = public as $$
  select coalesce((
    select r.permissions from public.shop_members m
      join public.roles r on r.id = m.role_id
    where m.shop_id = p_shop_id and m.user_id = auth.uid() and m.active
    limit 1
  ), '{}'::text[]);
$$;
grant execute on function public.my_shop_permissions(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Table policies. Each `for all` policy from 0018 splits into a read policy
-- and write policies, because reading and writing the same table are now
-- separate permissions (inventory.view vs inventory.edit, and so on).
-- ---------------------------------------------------------------------------

-- products: the POS needs to read the catalog to ring up a sale and the
-- dashboard needs it for its low-stock panel and category breakdown, so
-- pos.access/dashboard.view grant read alongside inventory.view. Writes are
-- inventory.edit only -- checkout's stock decrement goes through
-- complete_sale (security definer, bypasses RLS), so a cashier never needs
-- table-level update here.
drop policy "own products" on public.products;
create policy "read products" on public.products for select
  using (has_any_shop_permission(shop_id, array['inventory.view', 'pos.access', 'dashboard.view']));
create policy "insert products" on public.products for insert
  with check (has_shop_permission(shop_id, 'inventory.edit'));
create policy "update products" on public.products for update
  using (has_shop_permission(shop_id, 'inventory.edit'))
  with check (has_shop_permission(shop_id, 'inventory.edit'));
create policy "delete products" on public.products for delete
  using (has_shop_permission(shop_id, 'inventory.edit'));

-- sales (+ its child tables): the dashboard's aggregates are plain selects
-- over these tables (see src/lib/sales.ts), so dashboard.view grants read
-- alongside sales.view. Table-level writes are sales.edit; every write the
-- app actually performs goes through complete_sale/edit_sale/delete_sale.
drop policy "own sales" on public.sales;
create policy "read sales" on public.sales for select
  using (has_any_shop_permission(shop_id, array['sales.view', 'dashboard.view']));
create policy "insert sales" on public.sales for insert
  with check (has_shop_permission(shop_id, 'sales.edit'));
create policy "update sales" on public.sales for update
  using (has_shop_permission(shop_id, 'sales.edit'))
  with check (has_shop_permission(shop_id, 'sales.edit'));
create policy "delete sales" on public.sales for delete
  using (has_shop_permission(shop_id, 'sales.edit'));

drop policy "own sale_items" on public.sale_items;
create policy "read sale_items" on public.sale_items for select
  using (exists (
    select 1 from public.sales s where s.id = sale_id
      and has_any_shop_permission(s.shop_id, array['sales.view', 'dashboard.view'])
  ));
create policy "write sale_items" on public.sale_items for all
  using (exists (select 1 from public.sales s where s.id = sale_id and has_shop_permission(s.shop_id, 'sales.edit')))
  with check (exists (select 1 from public.sales s where s.id = sale_id and has_shop_permission(s.shop_id, 'sales.edit')));

drop policy "own sale_payments" on public.sale_payments;
create policy "read sale_payments" on public.sale_payments for select
  using (exists (
    select 1 from public.sales s where s.id = sale_id
      and has_any_shop_permission(s.shop_id, array['sales.view', 'dashboard.view'])
  ));
create policy "write sale_payments" on public.sale_payments for all
  using (exists (select 1 from public.sales s where s.id = sale_id and has_shop_permission(s.shop_id, 'sales.edit')))
  with check (exists (select 1 from public.sales s where s.id = sale_id and has_shop_permission(s.shop_id, 'sales.edit')));

drop policy "own sale_edits" on public.sale_edits;
create policy "read sale_edits" on public.sale_edits for select
  using (exists (
    select 1 from public.sales s where s.id = sale_id
      and has_any_shop_permission(s.shop_id, array['sales.view', 'dashboard.view'])
  ));
create policy "write sale_edits" on public.sale_edits for all
  using (exists (select 1 from public.sales s where s.id = sale_id and has_shop_permission(s.shop_id, 'sales.edit')))
  with check (exists (select 1 from public.sales s where s.id = sale_id and has_shop_permission(s.shop_id, 'sales.edit')));

-- customers: PII, so reading the directory needs customers.view -- but the
-- POS checkout picker and the sale editor both search/create customers
-- inline, which is why pos.access/sales.edit also grant read+write here (the
-- same reasoning 0023 used for is_shop_member). Deleting a customer is only
-- ever offered from the directory, so it stays customers.edit.
drop policy "shop members access their customers" on public.customers;
create policy "read customers" on public.customers for select
  using (has_any_shop_permission(shop_id, array['customers.view', 'pos.access', 'sales.edit']));
create policy "insert customers" on public.customers for insert
  with check (has_any_shop_permission(shop_id, array['customers.edit', 'pos.access', 'sales.edit']));
create policy "update customers" on public.customers for update
  using (has_any_shop_permission(shop_id, array['customers.edit', 'pos.access', 'sales.edit']))
  with check (has_any_shop_permission(shop_id, array['customers.edit', 'pos.access', 'sales.edit']));
create policy "delete customers" on public.customers for delete
  using (has_shop_permission(shop_id, 'customers.edit'));

-- Shop-wide reference data (taxonomy, cashier names, promotions,
-- currencies). Reads stay is_shop_member: the POS can't render category
-- chips, auto-apply promotions, take foreign currency, or attribute a sale to
-- a cashier without them, and none of it is sensitive on its own. Writes need
-- the permission for the screen they're edited from.
drop policy "own categories" on public.categories;
create policy "read categories" on public.categories for select using (is_shop_member(shop_id));
create policy "write categories" on public.categories for all
  using (has_any_shop_permission(shop_id, array['inventory.edit', 'settings.access']))
  with check (has_any_shop_permission(shop_id, array['inventory.edit', 'settings.access']));

drop policy "own tags" on public.tags;
create policy "read tags" on public.tags for select using (is_shop_member(shop_id));
create policy "write tags" on public.tags for all
  using (has_any_shop_permission(shop_id, array['inventory.edit', 'settings.access']))
  with check (has_any_shop_permission(shop_id, array['inventory.edit', 'settings.access']));

drop policy "own brands" on public.brands;
create policy "read brands" on public.brands for select using (is_shop_member(shop_id));
create policy "write brands" on public.brands for all
  using (has_any_shop_permission(shop_id, array['inventory.edit', 'settings.access']))
  with check (has_any_shop_permission(shop_id, array['inventory.edit', 'settings.access']));

drop policy "own cashiers" on public.cashiers;
create policy "read cashiers" on public.cashiers for select using (is_shop_member(shop_id));
create policy "write cashiers" on public.cashiers for all
  using (has_shop_permission(shop_id, 'settings.access'))
  with check (has_shop_permission(shop_id, 'settings.access'));

drop policy "own promotions" on public.promotions;
create policy "read promotions" on public.promotions for select using (is_shop_member(shop_id));
create policy "write promotions" on public.promotions for all
  using (has_shop_permission(shop_id, 'settings.access'))
  with check (has_shop_permission(shop_id, 'settings.access'));

drop policy "own shop_currencies" on public.shop_currencies;
create policy "read shop_currencies" on public.shop_currencies for select using (is_shop_member(shop_id));
create policy "write shop_currencies" on public.shop_currencies for all
  using (has_shop_permission(shop_id, 'settings.access'))
  with check (has_shop_permission(shop_id, 'settings.access'));

-- shops: reading stays "any member" (0018). Updating was owner-only, which
-- would have made settings.access a permission that shows the Settings
-- screen but can't save the shop half of it -- so it now also accepts
-- settings.access. Insert/delete stay owner-only (0001): creating or
-- deleting a shop is never a staff action.
drop policy "own shops update" on public.shops;
create policy "own shops update" on public.shops for update
  using (owner_id = auth.uid() or has_shop_permission(id, 'settings.access'))
  with check (owner_id = auth.uid() or has_shop_permission(id, 'settings.access'));

-- roles/shop_members: 0017 made these owner-only and noted staff could never
-- manage staff. staff.manage is in the catalog, so honor it -- an admin who
-- grants it is knowingly delegating (including the ability to edit one's own
-- role, which is inherent to the permission).
drop policy "admin manages roles" on public.roles;
create policy "manage roles" on public.roles for all
  using (has_shop_permission(shop_id, 'staff.manage'))
  with check (has_shop_permission(shop_id, 'staff.manage'));

drop policy "admin manages shop_members" on public.shop_members;
create policy "manage shop_members" on public.shop_members for all
  using (has_shop_permission(shop_id, 'staff.manage'))
  with check (has_shop_permission(shop_id, 'staff.manage'));
-- "staff reads own membership" (0017) is untouched: a staff member still
-- needs to select their own row to resolve their shop on login.

-- Product image storage: one bucket serves product photos, shop logos, and
-- brand/category images (see src/lib/storage.ts), so uploads/deletes are
-- allowed for either of the permissions that own those screens.
drop policy "shop members upload their shop's product images" on storage.objects;
create policy "shop members upload their shop's product images"
  on storage.objects for insert
  with check (
    bucket_id = 'product-images'
    and public.has_any_shop_permission((storage.foldername(name))[1]::uuid, array['inventory.edit', 'settings.access'])
  );

drop policy "shop members delete their shop's product images" on storage.objects;
create policy "shop members delete their shop's product images"
  on storage.objects for delete
  using (
    bucket_id = 'product-images'
    and public.has_any_shop_permission((storage.foldername(name))[1]::uuid, array['inventory.edit', 'settings.access'])
  );

-- ---------------------------------------------------------------------------
-- Security-definer RPCs. These bypass table RLS and do their own internal
-- check, so each is reproduced below at its current (latest-migration)
-- signature and body with only that check swapped from is_shop_member to the
-- specific permission it needs. Nothing else about them changes -- see 0018's
-- note and this project's convention on CREATE OR REPLACE FUNCTION.
-- ---------------------------------------------------------------------------

-- Before re-gating them: drop the pre-0023 signatures of complete_sale and
-- edit_sale. Adding `p_customer_id` in 0023 used CREATE OR REPLACE FUNCTION
-- with an extra parameter, which overloads rather than replaces -- so the
-- older arities survived, still carrying 0018's is_shop_member check. Left in
-- place they'd be a way straight around everything above (and they never
-- learned about customer_id either, so nothing should be reaching them).
-- Dropping them also removes the "function is not unique" ambiguity when
-- either is called without the trailing arguments.
drop function if exists public.complete_sale(uuid, jsonb, jsonb, text, text, text, text, integer);
drop function if exists public.edit_sale(uuid, jsonb, jsonb, text, text, text, integer);

-- complete_sale: reproduced from 0023. Ringing up a sale is pos.access.
create or replace function public.complete_sale(
  p_shop_id uuid,
  p_items jsonb,
  p_payments jsonb,
  p_customer_name text default null,
  p_customer_phone text default null,
  p_customer_email text default null,
  p_cashier_name text default null,
  p_discount_cents integer default 0,
  p_customer_id uuid default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_sale_id uuid;
  v_item jsonb;
  v_payment jsonb;
  v_product public.products%rowtype;
  v_qty integer;
  v_line integer;
  v_line_discount integer;
  v_gross_cents integer := 0;
  v_total_cents integer := 0;
  v_item_count integer := 0;
  v_payments_total integer := 0;
  v_primary_method text;
  v_discount_cents integer := greatest(coalesce(p_discount_cents, 0), 0);
  v_tax_enabled boolean;
  v_tax_rate numeric;
  v_tax_cents integer := 0;
begin
  if not public.has_shop_permission(p_shop_id, 'pos.access') then
    raise exception 'not authorized for shop %', p_shop_id;
  end if;
  if p_payments is null or jsonb_array_length(p_payments) = 0 then
    raise exception 'at least one payment is required';
  end if;

  v_primary_method := p_payments->0->>'method';
  if v_primary_method not in ('cash','zaad','edahab','other') then
    raise exception 'invalid payment method %', v_primary_method;
  end if;

  select tax_enabled, tax_rate_percent into v_tax_enabled, v_tax_rate
    from public.shops where id = p_shop_id;

  insert into public.sales (shop_id, created_by, payment_method, customer_name, customer_phone, customer_email, cashier_name, discount_cents, customer_id)
    values (p_shop_id, auth.uid(), v_primary_method, nullif(p_customer_name, ''), nullif(p_customer_phone, ''), nullif(p_customer_email, ''), nullif(p_cashier_name, ''), v_discount_cents, p_customer_id)
    returning id into v_sale_id;

  for v_item in select * from jsonb_array_elements(p_items) loop
    v_qty := (v_item->>'quantity')::integer;
    if v_qty is null or v_qty <= 0 then
      raise exception 'invalid quantity in cart item';
    end if;

    select * into v_product from public.products
      where id = (v_item->>'product_id')::uuid and shop_id = p_shop_id
      for update;

    if v_product.id is null then
      raise exception 'product % not found in this shop', v_item->>'product_id';
    end if;
    if v_product.stock < v_qty then
      raise exception 'insufficient stock for %: has %, need %', v_product.name, v_product.stock, v_qty;
    end if;

    v_line_discount := greatest(coalesce((v_item->>'discount_cents')::integer, 0), 0);
    v_line := v_product.price_cents * v_qty - v_line_discount;
    if v_line < 0 then
      raise exception 'discount exceeds line total for %', v_product.name;
    end if;

    update public.products set stock = stock - v_qty, updated_at = now() where id = v_product.id;

    insert into public.sale_items (sale_id, product_id, product_name, unit_price_cents, quantity, line_total_cents, discount_cents)
      values (v_sale_id, v_product.id, v_product.name, v_product.price_cents, v_qty, v_line, v_line_discount);

    v_gross_cents := v_gross_cents + v_line;
    v_item_count := v_item_count + v_qty;
  end loop;

  if v_item_count = 0 then
    raise exception 'cannot complete a sale with no items';
  end if;

  v_total_cents := v_gross_cents - v_discount_cents;
  if v_total_cents < 0 then
    raise exception 'discount exceeds sale total';
  end if;

  if v_tax_enabled then
    v_tax_cents := round(v_total_cents * v_tax_rate / 100)::integer;
  end if;
  v_total_cents := v_total_cents + v_tax_cents;

  for v_payment in select * from jsonb_array_elements(p_payments) loop
    if (v_payment->>'method') not in ('cash','zaad','edahab','other') then
      raise exception 'invalid payment method %', v_payment->>'method';
    end if;
    if (v_payment->>'amount_cents')::integer <= 0 then
      raise exception 'payment amount must be greater than zero';
    end if;
    v_payments_total := v_payments_total + (v_payment->>'amount_cents')::integer;

    insert into public.sale_payments (sale_id, method, amount_cents, tendered_cents, customer_name, customer_phone, currency_code, exchange_rate, foreign_amount_cents, foreign_change_cents)
      values (
        v_sale_id,
        v_payment->>'method',
        (v_payment->>'amount_cents')::integer,
        (v_payment->>'tendered_cents')::integer,
        v_payment->>'customer_name',
        v_payment->>'customer_phone',
        nullif(v_payment->>'currency_code', ''),
        (v_payment->>'exchange_rate')::numeric,
        (v_payment->>'foreign_amount_cents')::integer,
        (v_payment->>'foreign_change_cents')::integer
      );
  end loop;

  if v_payments_total <> v_total_cents then
    raise exception 'payments total % does not match sale total %', v_payments_total, v_total_cents;
  end if;

  update public.sales set
    total_cents = v_total_cents,
    item_count = v_item_count,
    tax_cents = v_tax_cents,
    tax_rate_percent = case when v_tax_enabled then v_tax_rate else null end
  where id = v_sale_id;
  return v_sale_id;
end;
$$;

-- edit_sale: reproduced from 0023. Rewriting a past sale is sales.edit.
create or replace function public.edit_sale(
  p_sale_id uuid,
  p_items jsonb,
  p_payments jsonb,
  p_customer_name text default null,
  p_customer_phone text default null,
  p_customer_email text default null,
  p_discount_cents integer default 0,
  p_customer_id uuid default null
) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_shop_id uuid;
  v_snapshot jsonb;
  v_old_item record;
  v_item jsonb;
  v_payment jsonb;
  v_product public.products%rowtype;
  v_qty integer;
  v_line integer;
  v_line_discount integer;
  v_gross_cents integer := 0;
  v_total_cents integer := 0;
  v_item_count integer := 0;
  v_payments_total integer := 0;
  v_discount_cents integer := greatest(coalesce(p_discount_cents, 0), 0);
  v_tax_enabled boolean;
  v_tax_rate numeric;
  v_tax_cents integer := 0;
begin
  select shop_id into v_shop_id from public.sales where id = p_sale_id;
  if v_shop_id is null then
    raise exception 'sale % not found', p_sale_id;
  end if;
  if not public.has_shop_permission(v_shop_id, 'sales.edit') then
    raise exception 'not authorized for sale %', p_sale_id;
  end if;
  if p_items is null or jsonb_array_length(p_items) = 0 then
    raise exception 'a sale must have at least one item';
  end if;
  if p_payments is null or jsonb_array_length(p_payments) = 0 then
    raise exception 'at least one payment is required';
  end if;

  select tax_enabled, tax_rate_percent into v_tax_enabled, v_tax_rate
    from public.shops where id = v_shop_id;

  select jsonb_build_object(
    'total_cents', s.total_cents,
    'item_count', s.item_count,
    'payment_method', s.payment_method,
    'customer_name', s.customer_name,
    'customer_phone', s.customer_phone,
    'customer_email', s.customer_email,
    'discount_cents', s.discount_cents,
    'items', (select coalesce(jsonb_agg(jsonb_build_object(
        'product_id', si.product_id, 'product_name', si.product_name,
        'unit_price_cents', si.unit_price_cents, 'quantity', si.quantity,
        'line_total_cents', si.line_total_cents, 'discount_cents', si.discount_cents
      )), '[]'::jsonb) from public.sale_items si where si.sale_id = p_sale_id),
    'payments', (select coalesce(jsonb_agg(jsonb_build_object(
        'method', sp.method, 'amount_cents', sp.amount_cents, 'tendered_cents', sp.tendered_cents,
        'customer_name', sp.customer_name, 'customer_phone', sp.customer_phone
      )), '[]'::jsonb) from public.sale_payments sp where sp.sale_id = p_sale_id)
  ) into v_snapshot
  from public.sales s where s.id = p_sale_id;

  insert into public.sale_edits (sale_id, edited_by, previous_snapshot)
    values (p_sale_id, auth.uid(), v_snapshot);

  for v_old_item in select product_id, quantity from public.sale_items where sale_id = p_sale_id loop
    if v_old_item.product_id is not null then
      update public.products set stock = stock + v_old_item.quantity, updated_at = now() where id = v_old_item.product_id;
    end if;
  end loop;

  delete from public.sale_items where sale_id = p_sale_id;
  delete from public.sale_payments where sale_id = p_sale_id;

  for v_item in select * from jsonb_array_elements(p_items) loop
    v_qty := (v_item->>'quantity')::integer;
    if v_qty is null or v_qty <= 0 then
      raise exception 'invalid quantity in sale item';
    end if;

    select * into v_product from public.products
      where id = (v_item->>'product_id')::uuid and shop_id = v_shop_id
      for update;

    if v_product.id is null then
      raise exception 'product % not found in this shop', v_item->>'product_id';
    end if;
    if v_product.stock < v_qty then
      raise exception 'insufficient stock for %: has %, need %', v_product.name, v_product.stock, v_qty;
    end if;

    v_line_discount := greatest(coalesce((v_item->>'discount_cents')::integer, 0), 0);
    v_line := v_product.price_cents * v_qty - v_line_discount;
    if v_line < 0 then
      raise exception 'discount exceeds line total for %', v_product.name;
    end if;

    update public.products set stock = stock - v_qty, updated_at = now() where id = v_product.id;

    insert into public.sale_items (sale_id, product_id, product_name, unit_price_cents, quantity, line_total_cents, discount_cents)
      values (p_sale_id, v_product.id, v_product.name, v_product.price_cents, v_qty, v_line, v_line_discount);

    v_gross_cents := v_gross_cents + v_line;
    v_item_count := v_item_count + v_qty;
  end loop;

  if v_item_count = 0 then
    raise exception 'cannot save a sale with no items';
  end if;

  v_total_cents := v_gross_cents - v_discount_cents;
  if v_total_cents < 0 then
    raise exception 'discount exceeds sale total';
  end if;

  if v_tax_enabled then
    v_tax_cents := round(v_total_cents * v_tax_rate / 100)::integer;
  end if;
  v_total_cents := v_total_cents + v_tax_cents;

  for v_payment in select * from jsonb_array_elements(p_payments) loop
    if (v_payment->>'method') not in ('cash','zaad','edahab','other') then
      raise exception 'invalid payment method %', v_payment->>'method';
    end if;
    if (v_payment->>'amount_cents')::integer <= 0 then
      raise exception 'payment amount must be greater than zero';
    end if;
    v_payments_total := v_payments_total + (v_payment->>'amount_cents')::integer;

    insert into public.sale_payments (sale_id, method, amount_cents, tendered_cents, customer_name, customer_phone, currency_code, exchange_rate, foreign_amount_cents, foreign_change_cents)
      values (
        p_sale_id,
        v_payment->>'method',
        (v_payment->>'amount_cents')::integer,
        (v_payment->>'tendered_cents')::integer,
        v_payment->>'customer_name',
        v_payment->>'customer_phone',
        nullif(v_payment->>'currency_code', ''),
        (v_payment->>'exchange_rate')::numeric,
        (v_payment->>'foreign_amount_cents')::integer,
        (v_payment->>'foreign_change_cents')::integer
      );
  end loop;

  if v_payments_total <> v_total_cents then
    raise exception 'payments total % does not match sale total %', v_payments_total, v_total_cents;
  end if;

  update public.sales set
    total_cents = v_total_cents,
    item_count = v_item_count,
    payment_method = p_payments->0->>'method',
    customer_name = nullif(p_customer_name, ''),
    customer_phone = nullif(p_customer_phone, ''),
    customer_email = nullif(p_customer_email, ''),
    customer_id = p_customer_id,
    discount_cents = v_discount_cents,
    tax_cents = v_tax_cents,
    tax_rate_percent = case when v_tax_enabled then v_tax_rate else null end
  where id = p_sale_id;
end;
$$;

-- delete_sale: reproduced from 0018. Deleting a past sale is sales.edit.
create or replace function public.delete_sale(p_sale_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_shop_id uuid;
  v_item record;
begin
  select shop_id into v_shop_id from public.sales where id = p_sale_id;
  if v_shop_id is null then
    raise exception 'sale % not found', p_sale_id;
  end if;
  if not public.has_shop_permission(v_shop_id, 'sales.edit') then
    raise exception 'not authorized for sale %', p_sale_id;
  end if;

  for v_item in select product_id, quantity from public.sale_items where sale_id = p_sale_id loop
    if v_item.product_id is not null then
      update public.products set stock = stock + v_item.quantity, updated_at = now() where id = v_item.product_id;
    end if;
  end loop;

  delete from public.sales where id = p_sale_id;
end;
$$;

-- Taxonomy rename/delete cascades: reproduced from 0018 (category/brand) and
-- 0023 (tag, which also rewrites customers.tags). Same gate as the taxonomy
-- tables' write policies above.
create or replace function public.rename_category(p_shop_id uuid, p_old_name text, p_new_name text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.has_any_shop_permission(p_shop_id, array['inventory.edit', 'settings.access']) then
    raise exception 'not authorized for shop %', p_shop_id;
  end if;
  update public.categories set name = p_new_name where shop_id = p_shop_id and name = p_old_name;
  update public.products set category = p_new_name, updated_at = now() where shop_id = p_shop_id and category = p_old_name;
end;
$$;

create or replace function public.delete_category(p_shop_id uuid, p_name text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.has_any_shop_permission(p_shop_id, array['inventory.edit', 'settings.access']) then
    raise exception 'not authorized for shop %', p_shop_id;
  end if;
  delete from public.categories where shop_id = p_shop_id and name = p_name;
  update public.products set category = null, updated_at = now() where shop_id = p_shop_id and category = p_name;
end;
$$;

create or replace function public.rename_tag(p_shop_id uuid, p_old_name text, p_new_name text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.has_any_shop_permission(p_shop_id, array['inventory.edit', 'settings.access']) then
    raise exception 'not authorized for shop %', p_shop_id;
  end if;
  update public.tags set name = p_new_name where shop_id = p_shop_id and name = p_old_name;
  update public.products set tags = array_replace(tags, p_old_name, p_new_name), updated_at = now()
    where shop_id = p_shop_id and p_old_name = any(tags);
  update public.customers set tags = array_replace(tags, p_old_name, p_new_name), updated_at = now()
    where shop_id = p_shop_id and p_old_name = any(tags);
end;
$$;

create or replace function public.delete_tag(p_shop_id uuid, p_name text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.has_any_shop_permission(p_shop_id, array['inventory.edit', 'settings.access']) then
    raise exception 'not authorized for shop %', p_shop_id;
  end if;
  delete from public.tags where shop_id = p_shop_id and name = p_name;
  update public.products set tags = array_remove(tags, p_name), updated_at = now()
    where shop_id = p_shop_id and p_name = any(tags);
  update public.customers set tags = array_remove(tags, p_name), updated_at = now()
    where shop_id = p_shop_id and p_name = any(tags);
end;
$$;

create or replace function public.rename_brand(p_shop_id uuid, p_old_name text, p_new_name text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.has_any_shop_permission(p_shop_id, array['inventory.edit', 'settings.access']) then
    raise exception 'not authorized for shop %', p_shop_id;
  end if;
  update public.brands set name = p_new_name where shop_id = p_shop_id and name = p_old_name;
  update public.products set brand = p_new_name, updated_at = now() where shop_id = p_shop_id and brand = p_old_name;
end;
$$;

create or replace function public.delete_brand(p_shop_id uuid, p_name text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.has_any_shop_permission(p_shop_id, array['inventory.edit', 'settings.access']) then
    raise exception 'not authorized for shop %', p_shop_id;
  end if;
  delete from public.brands where shop_id = p_shop_id and name = p_name;
  update public.products set brand = null, updated_at = now() where shop_id = p_shop_id and brand = p_name;
end;
$$;

-- customers.view/customers.edit are new catalog entries (the Customers
-- directory was previously ungated). Grant them to the seeded Manager role,
-- which is defined as "everything except settings and staff management" --
-- Cashier deliberately does not get them: its POS checkout picker works off
-- pos.access, so it can attach a customer to a sale without being able to
-- browse the whole directory.
update public.roles
  set permissions = permissions || array['customers.view', 'customers.edit']
  where name = 'Manager'
    and permissions @> array['sales.edit', 'dashboard.view']
    and not permissions && array['customers.view', 'customers.edit'];
