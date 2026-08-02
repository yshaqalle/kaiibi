-- Refunds against a completed sale. Mirrors the sale_edits audit-trail shape
-- from 0006_sale_history.sql (a header row + child line items), but uses the
-- current (0024_permission_gates.sql) has_shop_permission/has_any_shop_permission
-- convention rather than 0006's now-superseded owns_shop.
create table public.refunds (
  id uuid primary key default gen_random_uuid(),
  sale_id uuid not null references public.sales(id) on delete cascade,
  refunded_by uuid references auth.users(id),
  total_cents integer not null default 0,
  created_at timestamptz not null default now()
);
create index refunds_sale_id_idx on public.refunds(sale_id);

create table public.refund_items (
  id uuid primary key default gen_random_uuid(),
  refund_id uuid not null references public.refunds(id) on delete cascade,
  sale_item_id uuid not null references public.sale_items(id) on delete cascade,
  product_id uuid references public.products(id) on delete set null,
  quantity integer not null check (quantity > 0),
  amount_cents integer not null check (amount_cents >= 0)
);
create index refund_items_refund_id_idx on public.refund_items(refund_id);
create index refund_items_sale_item_id_idx on public.refund_items(sale_item_id);

alter table public.refunds enable row level security;
alter table public.refund_items enable row level security;

create policy "read refunds" on public.refunds for select
  using (exists (select 1 from public.sales s where s.id = sale_id and has_any_shop_permission(s.shop_id, array['sales.view', 'dashboard.view'])));
create policy "write refunds" on public.refunds for all
  using (exists (select 1 from public.sales s where s.id = sale_id and has_shop_permission(s.shop_id, 'sales.edit')))
  with check (exists (select 1 from public.sales s where s.id = sale_id and has_shop_permission(s.shop_id, 'sales.edit')));

create policy "read refund_items" on public.refund_items for select
  using (exists (select 1 from public.refunds r join public.sales s on s.id = r.sale_id where r.id = refund_id and has_any_shop_permission(s.shop_id, array['sales.view', 'dashboard.view'])));
create policy "write refund_items" on public.refund_items for all
  using (exists (select 1 from public.refunds r join public.sales s on s.id = r.sale_id where r.id = refund_id and has_shop_permission(s.shop_id, 'sales.edit')))
  with check (exists (select 1 from public.refunds r join public.sales s on s.id = r.sale_id where r.id = refund_id and has_shop_permission(s.shop_id, 'sales.edit')));

grant select, insert, update, delete on public.refunds to authenticated;
grant select, insert, update, delete on public.refund_items to authenticated;

-- Refunds some quantity of one or more items on a sale: locks each sale_item
-- row before summing its prior refunds (so a concurrent refund of the same
-- line can't double-spend the remaining quantity), restores stock the same
-- way edit_sale/delete_sale do, and records the refund atomically.
--
-- The per-line amount is computed as a cumulative delta (amount owed for
-- refunded_so_far + this_call minus amount owed for refunded_so_far alone),
-- not a fresh proportional slice of line_total_cents each call -- a naive
-- `round(line_total_cents * qty / quantity)` recomputed per partial refund
-- loses cents (e.g. three separate 1-unit refunds of a $1.00/3-qty line give
-- 33+33+33 = 99, a penny short). The cumulative form telescopes exactly to
-- line_total_cents once a line is fully refunded, regardless of how many
-- partial calls got there.
create or replace function public.refund_sale_items(
  p_sale_id uuid,
  p_items jsonb
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_shop_id uuid;
  v_refund_id uuid;
  v_item jsonb;
  v_sale_item public.sale_items%rowtype;
  v_requested_qty integer;
  v_already_refunded_qty integer;
  v_new_cum_qty integer;
  v_cum_amount integer;
  v_prior_amount integer;
  v_refund_amount integer;
  v_total_cents integer := 0;
begin
  select shop_id into v_shop_id from public.sales where id = p_sale_id;
  if v_shop_id is null then
    raise exception 'sale % not found', p_sale_id;
  end if;
  if not public.has_shop_permission(v_shop_id, 'sales.edit') then
    raise exception 'not authorized for sale %', p_sale_id;
  end if;
  if p_items is null or jsonb_array_length(p_items) = 0 then
    raise exception 'a refund must include at least one item';
  end if;

  insert into public.refunds (sale_id, refunded_by) values (p_sale_id, auth.uid())
    returning id into v_refund_id;

  -- Ordered by sale_item_id so two concurrent refund calls touching
  -- overlapping lines always acquire their row locks in the same order,
  -- avoiding a deadlock between them.
  for v_item in select value from jsonb_array_elements(p_items) as t(value) order by (value->>'sale_item_id') loop
    v_requested_qty := (v_item->>'quantity')::integer;
    if v_requested_qty is null or v_requested_qty <= 0 then
      raise exception 'invalid refund quantity';
    end if;

    select * into v_sale_item from public.sale_items
      where id = (v_item->>'sale_item_id')::uuid and sale_id = p_sale_id
      for update;
    if v_sale_item.id is null then
      raise exception 'sale item % not found on sale %', v_item->>'sale_item_id', p_sale_id;
    end if;

    select coalesce(sum(quantity), 0) into v_already_refunded_qty
      from public.refund_items where sale_item_id = v_sale_item.id;

    v_new_cum_qty := v_already_refunded_qty + v_requested_qty;
    if v_new_cum_qty > v_sale_item.quantity then
      raise exception 'refund exceeds remaining quantity for %', v_sale_item.product_name;
    end if;

    v_cum_amount := round(v_sale_item.line_total_cents::numeric * v_new_cum_qty / v_sale_item.quantity);
    v_prior_amount := round(v_sale_item.line_total_cents::numeric * v_already_refunded_qty / v_sale_item.quantity);
    v_refund_amount := v_cum_amount - v_prior_amount;

    if v_sale_item.product_id is not null then
      update public.products set stock = stock + v_requested_qty, updated_at = now() where id = v_sale_item.product_id;
    end if;

    insert into public.refund_items (refund_id, sale_item_id, product_id, quantity, amount_cents)
      values (v_refund_id, v_sale_item.id, v_sale_item.product_id, v_requested_qty, v_refund_amount);

    v_total_cents := v_total_cents + v_refund_amount;
  end loop;

  update public.refunds set total_cents = v_total_cents where id = v_refund_id;
  return v_refund_id;
end;
$$;

grant execute on function public.refund_sale_items(uuid, jsonb) to authenticated;
