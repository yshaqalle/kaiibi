create table public.sale_payments (
  id uuid primary key default gen_random_uuid(),
  sale_id uuid not null references public.sales(id) on delete cascade,
  method text not null check (method in ('cash','zaad','edahab','other')),
  amount_cents integer not null check (amount_cents >= 0),
  tendered_cents integer check (tendered_cents is null or tendered_cents >= 0),
  customer_name text,
  customer_phone text,
  created_at timestamptz not null default now()
);
create index sale_payments_sale_id_idx on public.sale_payments(sale_id);

alter table public.sale_payments enable row level security;

create policy "own sale_payments" on public.sale_payments for all
  using (exists (select 1 from public.sales s where s.id = sale_id and owns_shop(s.shop_id)));

grant select, insert, update, delete on public.sale_payments to authenticated;

-- Replaces the single payment_method/payment_note params with a jsonb array
-- of payment lines, so one sale can be split across multiple methods (e.g.
-- part cash, part ZAAD). `sales.payment_method` is kept as a quick summary
-- column (set to the first payment line's method) purely so existing
-- listings that read it don't break; the full breakdown lives in
-- sale_payments. Each payment line: { method, amount_cents, tendered_cents?,
-- customer_name?, customer_phone? }.
drop function if exists public.complete_sale(uuid, jsonb, text, text);

create or replace function public.complete_sale(
  p_shop_id uuid,
  p_items jsonb,
  p_payments jsonb
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

  insert into public.sales (shop_id, created_by, payment_method)
    values (p_shop_id, auth.uid(), v_primary_method)
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

grant execute on function public.complete_sale(uuid, jsonb, jsonb) to authenticated;
