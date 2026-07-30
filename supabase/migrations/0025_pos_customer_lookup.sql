-- Closes the one place 0024 left deliberately loose. 0023 gave every shop
-- member read on `customers` because the POS checkout picker and the sale
-- editor search it inline, and 0024 preserved that by letting pos.access /
-- sales.edit read the table -- which meant a cashier could still pull the
-- whole customer directory (names, phones, emails, addresses) straight off
-- the API even with the Customers tab hidden.
--
-- Replace that table-wide read with two narrow security-definer RPCs. The
-- picker only ever needs "find the person in front of me" and "add them if
-- they're new", so those are the only two shapes exposed: matching needs a
-- real query, wildcards are escaped so a query can't match everything, and
-- results are capped. Browsing the directory is `customers.view` again, and
-- nothing else.

-- Bounded lookup. Returns at most 10 rows and only for a query of 2+
-- characters, so it can't be used to walk the table.
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
  -- A one-character query would return a big slice of any real directory,
  -- which is the enumeration this function exists to prevent.
  if length(v_query) < 2 then
    return;
  end if;
  -- Escape LIKE metacharacters before wrapping in %...%: without this a
  -- query of '%%' (or '__') matches every row and hands back the directory
  -- ten rows at a time.
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

-- Quick-add from the picker. Needed as an RPC rather than a plain insert
-- because the client reads the new row back (`.insert().select().single()`),
-- and the row it just wrote is no longer selectable without customers.view.
-- Only the four fields the picker collects; the full record is edited from
-- the directory.
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

-- With the picker served by the RPCs above, the table itself goes back to
-- being the directory's own surface: customers.view to read, customers.edit
-- to change. pos.access/sales.edit no longer reach it directly.
drop policy "read customers" on public.customers;
create policy "read customers" on public.customers for select
  using (has_shop_permission(shop_id, 'customers.view'));

drop policy "insert customers" on public.customers;
create policy "insert customers" on public.customers for insert
  with check (has_shop_permission(shop_id, 'customers.edit'));

drop policy "update customers" on public.customers;
create policy "update customers" on public.customers for update
  using (has_shop_permission(shop_id, 'customers.edit'))
  with check (has_shop_permission(shop_id, 'customers.edit'));
-- "delete customers" (0024) was already customers.edit only -- unchanged.
