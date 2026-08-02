-- Splits refund authority out of sales.edit into its own sales.refund
-- permission (see src/lib/permissions.ts) -- a role that can edit/delete
-- past sales, or even one that can only view the sales report, should not
-- automatically be able to issue refunds unless separately granted. This
-- follows up 20260802015200_refunds.sql (which shipped gated on sales.edit)
-- rather than editing it in place, same as 0024 layered has_shop_permission
-- on top of 0006's owns_shop instead of rewriting that migration.
alter policy "write refunds" on public.refunds
  using (exists (select 1 from public.sales s where s.id = sale_id and has_shop_permission(s.shop_id, 'sales.refund')))
  with check (exists (select 1 from public.sales s where s.id = sale_id and has_shop_permission(s.shop_id, 'sales.refund')));

alter policy "write refund_items" on public.refund_items
  using (exists (select 1 from public.refunds r join public.sales s on s.id = r.sale_id where r.id = refund_id and has_shop_permission(s.shop_id, 'sales.refund')))
  with check (exists (select 1 from public.refunds r join public.sales s on s.id = r.sale_id where r.id = refund_id and has_shop_permission(s.shop_id, 'sales.refund')));

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
  if not public.has_shop_permission(v_shop_id, 'sales.refund') then
    raise exception 'not authorized for sale %', p_sale_id;
  end if;
  if p_items is null or jsonb_array_length(p_items) = 0 then
    raise exception 'a refund must include at least one item';
  end if;

  insert into public.refunds (sale_id, refunded_by) values (p_sale_id, auth.uid())
    returning id into v_refund_id;

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
