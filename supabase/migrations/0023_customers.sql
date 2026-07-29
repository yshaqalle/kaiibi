-- Customer management (CRM): a persistent customers directory, replacing
-- sales' free-text customer_name/phone/email-only history. See design spec
-- docs/superpowers/specs/2026-07-28-customer-management-design.md.
create table public.customers (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  first_name text not null,
  last_name text,
  email text,
  phone text,
  street text,
  city text,
  neighborhood text,
  tags text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index customers_shop_id_idx on public.customers(shop_id);

alter table public.customers enable row level security;

-- is_shop_member (not owns_shop) -- matches every other shop-scoped table's
-- current policy since 0018_staff_shop_access.sql: cashiers need to
-- search/create customers from the POS checkout picker, not just the owner.
create policy "shop members access their customers" on public.customers for all
  using (is_shop_member(shop_id)) with check (is_shop_member(shop_id));

grant select, insert, update, delete on public.customers to authenticated;

alter table public.sales add column if not exists customer_id uuid references public.customers(id) on delete set null;
create index if not exists sales_customer_id_idx on public.sales(customer_id);

-- Extend the existing tag rename/delete cascade (0004, is_shop_member check
-- added in 0018) so it also rewrites customers.tags -- the same
-- denormalized-by-name array products.tags already uses.
create or replace function public.rename_tag(p_shop_id uuid, p_old_name text, p_new_name text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_shop_member(p_shop_id) then
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
  if not public.is_shop_member(p_shop_id) then
    raise exception 'not authorized for shop %', p_shop_id;
  end if;
  delete from public.tags where shop_id = p_shop_id and name = p_name;
  update public.products set tags = array_remove(tags, p_name), updated_at = now()
    where shop_id = p_shop_id and p_name = any(tags);
  update public.customers set tags = array_remove(tags, p_name), updated_at = now()
    where shop_id = p_shop_id and p_name = any(tags);
end;
$$;

-- complete_sale/edit_sale each gain p_customer_id, stored directly on the
-- sales row alongside the existing frozen customer_name/phone/email
-- snapshot (unchanged -- editing a customer's phone later must never
-- rewrite a past receipt). Reproduced here at their full current (0018)
-- signature/body, only appending the new default-valued parameter -- see
-- this plan's Global Constraints on CREATE OR REPLACE FUNCTION.
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
  if not public.is_shop_member(p_shop_id) then
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
  if not public.is_shop_member(v_shop_id) then
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
