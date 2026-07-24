-- Customer info for the sale as a whole, independent of payment method —
-- `sale_payments.customer_name/customer_phone` only exist for ZAAD/e-Dahab
-- lines (where the mobile-money recipient matters for reconciliation), so a
-- cash sale had no way to note who bought it at all.
alter table public.sales add column if not exists customer_name text;
alter table public.sales add column if not exists customer_phone text;
alter table public.sales add column if not exists customer_email text;

-- Drops both possible prior signatures: the original 3-param version (if
-- this migration has never run) and the 5-param name/phone-only version
-- (if it has, since `create or replace` can't replace across a changed
-- signature — it would silently create a duplicate overload instead).
drop function if exists public.complete_sale(uuid, jsonb, jsonb);
drop function if exists public.complete_sale(uuid, jsonb, jsonb, text, text);

create or replace function public.complete_sale(
  p_shop_id uuid,
  p_items jsonb,
  p_payments jsonb,
  p_customer_name text default null,
  p_customer_phone text default null,
  p_customer_email text default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_sale_id uuid;
  v_item jsonb;
  v_payment jsonb;
  v_product public.products%rowtype;
  v_qty integer;
  v_line integer;
  v_total_cents integer := 0;
  v_item_count integer := 0;
  v_payments_total integer := 0;
  v_primary_method text;
begin
  if not public.owns_shop(p_shop_id) then
    raise exception 'not authorized for shop %', p_shop_id;
  end if;
  if p_payments is null or jsonb_array_length(p_payments) = 0 then
    raise exception 'at least one payment is required';
  end if;

  v_primary_method := p_payments->0->>'method';
  if v_primary_method not in ('cash','zaad','edahab','other') then
    raise exception 'invalid payment method %', v_primary_method;
  end if;

  insert into public.sales (shop_id, created_by, payment_method, customer_name, customer_phone, customer_email)
    values (p_shop_id, auth.uid(), v_primary_method, nullif(p_customer_name, ''), nullif(p_customer_phone, ''), nullif(p_customer_email, ''))
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

    v_line := v_product.price_cents * v_qty;

    update public.products set stock = stock - v_qty, updated_at = now() where id = v_product.id;

    insert into public.sale_items (sale_id, product_id, product_name, unit_price_cents, quantity, line_total_cents)
      values (v_sale_id, v_product.id, v_product.name, v_product.price_cents, v_qty, v_line);

    v_total_cents := v_total_cents + v_line;
    v_item_count := v_item_count + v_qty;
  end loop;

  if v_item_count = 0 then
    raise exception 'cannot complete a sale with no items';
  end if;

  for v_payment in select * from jsonb_array_elements(p_payments) loop
    if (v_payment->>'method') not in ('cash','zaad','edahab','other') then
      raise exception 'invalid payment method %', v_payment->>'method';
    end if;
    if (v_payment->>'amount_cents')::integer <= 0 then
      raise exception 'payment amount must be greater than zero';
    end if;
    v_payments_total := v_payments_total + (v_payment->>'amount_cents')::integer;

    insert into public.sale_payments (sale_id, method, amount_cents, tendered_cents, customer_name, customer_phone)
      values (
        v_sale_id,
        v_payment->>'method',
        (v_payment->>'amount_cents')::integer,
        (v_payment->>'tendered_cents')::integer,
        v_payment->>'customer_name',
        v_payment->>'customer_phone'
      );
  end loop;

  if v_payments_total <> v_total_cents then
    raise exception 'payments total % does not match sale total %', v_payments_total, v_total_cents;
  end if;

  update public.sales set total_cents = v_total_cents, item_count = v_item_count where id = v_sale_id;
  return v_sale_id;
end;
$$;

drop function if exists public.edit_sale(uuid, jsonb, jsonb);
drop function if exists public.edit_sale(uuid, jsonb, jsonb, text, text);

create or replace function public.edit_sale(
  p_sale_id uuid,
  p_items jsonb,
  p_payments jsonb,
  p_customer_name text default null,
  p_customer_phone text default null,
  p_customer_email text default null
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
  v_total_cents integer := 0;
  v_item_count integer := 0;
  v_payments_total integer := 0;
begin
  select shop_id into v_shop_id from public.sales where id = p_sale_id;
  if v_shop_id is null then
    raise exception 'sale % not found', p_sale_id;
  end if;
  if not public.owns_shop(v_shop_id) then
    raise exception 'not authorized for sale %', p_sale_id;
  end if;
  if p_items is null or jsonb_array_length(p_items) = 0 then
    raise exception 'a sale must have at least one item';
  end if;
  if p_payments is null or jsonb_array_length(p_payments) = 0 then
    raise exception 'at least one payment is required';
  end if;

  select jsonb_build_object(
    'total_cents', s.total_cents,
    'item_count', s.item_count,
    'payment_method', s.payment_method,
    'customer_name', s.customer_name,
    'customer_phone', s.customer_phone,
    'customer_email', s.customer_email,
    'items', (select coalesce(jsonb_agg(jsonb_build_object(
        'product_id', si.product_id, 'product_name', si.product_name,
        'unit_price_cents', si.unit_price_cents, 'quantity', si.quantity,
        'line_total_cents', si.line_total_cents
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

    v_line := v_product.price_cents * v_qty;
    update public.products set stock = stock - v_qty, updated_at = now() where id = v_product.id;

    insert into public.sale_items (sale_id, product_id, product_name, unit_price_cents, quantity, line_total_cents)
      values (p_sale_id, v_product.id, v_product.name, v_product.price_cents, v_qty, v_line);

    v_total_cents := v_total_cents + v_line;
    v_item_count := v_item_count + v_qty;
  end loop;

  if v_item_count = 0 then
    raise exception 'cannot save a sale with no items';
  end if;

  for v_payment in select * from jsonb_array_elements(p_payments) loop
    if (v_payment->>'method') not in ('cash','zaad','edahab','other') then
      raise exception 'invalid payment method %', v_payment->>'method';
    end if;
    if (v_payment->>'amount_cents')::integer <= 0 then
      raise exception 'payment amount must be greater than zero';
    end if;
    v_payments_total := v_payments_total + (v_payment->>'amount_cents')::integer;

    insert into public.sale_payments (sale_id, method, amount_cents, tendered_cents, customer_name, customer_phone)
      values (
        p_sale_id,
        v_payment->>'method',
        (v_payment->>'amount_cents')::integer,
        (v_payment->>'tendered_cents')::integer,
        v_payment->>'customer_name',
        v_payment->>'customer_phone'
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
    customer_email = nullif(p_customer_email, '')
  where id = p_sale_id;
end;
$$;

grant execute on function public.complete_sale(uuid, jsonb, jsonb, text, text, text) to authenticated;
grant execute on function public.edit_sale(uuid, jsonb, jsonb, text, text, text) to authenticated;
