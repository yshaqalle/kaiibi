-- 20260801221945_check_customer_rpc.sql dropped pos_search_customers and
-- pos_create_customer (added in 0025_pos_customer_lookup.sql) as part of an
-- unrelated diff and never recreated them, breaking the POS checkout
-- customer picker's search and quick-add. Restore both, unchanged from 0025.

create or replace function public.pos_search_customers(p_shop_id uuid, p_query text)
returns setof public.customers
language plpgsql security definer stable set search_path = public as $$
declare
  v_query text := btrim(coalesce(p_query, ''));
  v_pattern text;
begin
  if not public.has_any_shop_permission(p_shop_id, array['customers.view', 'pos.access', 'sales.edit']) then
    raise exception 'not authorized for shop %', p_shop_id;
  end if;
  if length(v_query) < 2 then
    return;
  end if;
  v_pattern := '%' || replace(replace(replace(v_query, '\', '\\'), '%', '\%'), '_', '\_') || '%';
  return query
    select c.*
    from public.customers c
    where c.shop_id = p_shop_id
      and (
        c.first_name ilike v_pattern escape '\'
        or coalesce(c.last_name, '') ilike v_pattern escape '\'
        or coalesce(c.phone, '') ilike v_pattern escape '\'
      )
    order by c.first_name, c.last_name
    limit 10;
end;
$$;
grant execute on function public.pos_search_customers(uuid, text) to authenticated;

create or replace function public.pos_create_customer(
  p_shop_id uuid,
  p_first_name text,
  p_last_name text default null,
  p_phone text default null,
  p_email text default null
) returns public.customers
language plpgsql security definer set search_path = public as $$
declare
  v_customer public.customers;
begin
  if not public.has_any_shop_permission(p_shop_id, array['customers.edit', 'pos.access', 'sales.edit']) then
    raise exception 'not authorized for shop %', p_shop_id;
  end if;
  if btrim(coalesce(p_first_name, '')) = '' then
    raise exception 'a customer needs a first name';
  end if;
  insert into public.customers (shop_id, first_name, last_name, phone, email)
    values (
      p_shop_id,
      btrim(p_first_name),
      nullif(btrim(coalesce(p_last_name, '')), ''),
      nullif(btrim(coalesce(p_phone, '')), ''),
      nullif(btrim(coalesce(p_email, '')), '')
    )
    returning * into v_customer;
  return v_customer;
end;
$$;
grant execute on function public.pos_create_customer(uuid, text, text, text, text) to authenticated;
