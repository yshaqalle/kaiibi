-- Phase 2 of multi-location: stock stops being one number per product and
-- becomes one number per product PER BRANCH.
--
-- The shape: a SHARED CATALOG with per-location counts. A product row stays
-- shop-wide (one SKU, one barcode, one price, one set of tags); only the count
-- splits. The rejected alternative was a location_id on `products`, which would
-- have duplicated a row per branch and fragmented every report, import and
-- barcode lookup by the number of branches a shop happens to have.
--
-- ## products.stock becomes derived, and stays correct
--
-- Roughly everything reads products.stock: the inventory list, CSV export, low
-- stock and expiry alerts, reporting. Rewriting all of it at once would be a
-- large change with no way to verify the halves independently. So instead
-- products.stock is kept as a trigger-maintained rollup -- the sum across
-- locations -- and every existing reader stays correct without being touched.
--
-- Three triggers hold that invariant, and it is worth being precise about why
-- each exists:
--
--   1. AFTER INSERT on products materialises an opening `stock` value into the
--      primary location. This is what keeps the existing product form and CSV
--      import working unchanged -- they still say "stock: 10" and mean it.
--   2. BEFORE UPDATE on products overwrites any direct write to `stock` with
--      the rollup. After this migration `stock` is an output, not an input;
--      without this a stray `update products set stock = ...` would desync the
--      two representations with no error.
--   3. AFTER INSERT/UPDATE/DELETE on product_location_stock recomputes the
--      rollup. This is the only path that actually changes products.stock.
--
-- These cannot recurse: (3) issues an update on products, which fires (2),
-- which computes the same rollup and writes no further rows.
--
-- ## The cost, stated plainly
--
-- Because products.stock is maintained, a sale at branch A still takes a row
-- lock on the shared product row, so concurrent sales of the same SKU at
-- different branches serialise on it. That is not a regression -- today ALL
-- sales of a product serialise -- but it is not the improvement per-location
-- stock could otherwise buy. Dropping products.stock entirely is what removes
-- it, and that is a follow-up once every reader has moved to the location rows.

-- ---------------------------------------------------------------------------
-- The stock table
-- ---------------------------------------------------------------------------

create table public.product_location_stock (
  product_id uuid not null references public.products(id) on delete cascade,
  location_id uuid not null references public.shop_locations(id) on delete cascade,
  stock integer not null default 0 check (stock >= 0),
  -- Per-branch overrides of the product's own reorder level and shelf: a
  -- flagship branch carries deeper stock than a kiosk, and the same SKU sits on
  -- a different shelf in each. Null means "use the product's value", so a shop
  -- that doesn't care sets nothing and behaves exactly as before.
  reorder_level integer check (reorder_level is null or reorder_level >= 0),
  shelf_number text,
  updated_at timestamptz not null default now(),
  primary key (product_id, location_id)
);
create index product_location_stock_location_idx on public.product_location_stock(location_id);

alter table public.product_location_stock enable row level security;

-- Mirrors the products policies from 0024: readable by anyone who can see the
-- catalog (the POS needs counts as much as Inventory does), writable with
-- inventory.edit. The shop is reached through the product, since this table has
-- no shop_id of its own -- deliberately, as it would be a second source of
-- truth for which shop a row belongs to.
create policy "read product_location_stock" on public.product_location_stock for select
  using (exists (select 1 from public.products p where p.id = product_id and is_shop_member(p.shop_id)));

create policy "write product_location_stock" on public.product_location_stock for all
  using (exists (select 1 from public.products p where p.id = product_id and has_shop_permission(p.shop_id, 'inventory.edit')))
  with check (exists (select 1 from public.products p where p.id = product_id and has_shop_permission(p.shop_id, 'inventory.edit')));

grant select, insert, update, delete on public.product_location_stock to authenticated;

-- Backfill: every product's current count lands at its shop's primary location,
-- resolved by the same ordering the 20260809000000 sales backfill used so the
-- two can never disagree about which location "the shop" meant.
insert into public.product_location_stock (product_id, location_id, stock, reorder_level, shelf_number)
select p.id,
       (select l.id from public.shop_locations l
         where l.shop_id = p.shop_id
         order by l.is_primary desc, l.created_at asc
         limit 1),
       p.stock,
       null,
       null
from public.products p
where exists (select 1 from public.shop_locations l where l.shop_id = p.shop_id);

-- ---------------------------------------------------------------------------
-- Keeping products.stock a faithful rollup
-- ---------------------------------------------------------------------------

create or replace function public.recompute_product_stock(p_product_id uuid)
returns void
language sql security definer set search_path = public as $$
  update public.products p
    set stock = coalesce((select sum(s.stock) from public.product_location_stock s where s.product_id = p_product_id), 0)
    where p.id = p_product_id;
$$;

create or replace function public.product_location_stock_sync()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  -- On UPDATE the product_id cannot change (it is half the primary key), but
  -- handling both OLD and NEW costs nothing and makes a DELETE correct too.
  if tg_op = 'DELETE' then
    perform public.recompute_product_stock(old.product_id);
    return old;
  end if;
  perform public.recompute_product_stock(new.product_id);
  return new;
end;
$$;

create trigger product_location_stock_sync_trigger
  after insert or update or delete on public.product_location_stock
  for each row execute function public.product_location_stock_sync();

-- Opening stock: a product created with `stock: 10` still means ten units, and
-- they land at the primary location. This is what lets the product form and CSV
-- import keep speaking in a single number.
create or replace function public.product_opening_stock()
returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_location_id uuid;
begin
  if coalesce(new.stock, 0) = 0 then
    return new;
  end if;
  select l.id into v_location_id from public.shop_locations l
    where l.shop_id = new.shop_id
    order by l.is_primary desc, l.created_at asc
    limit 1;
  if v_location_id is null then
    return new;
  end if;
  insert into public.product_location_stock (product_id, location_id, stock)
    values (new.id, v_location_id, new.stock)
    on conflict (product_id, location_id) do update set stock = excluded.stock, updated_at = now();
  return new;
end;
$$;

create trigger product_opening_stock_trigger
  after insert on public.products
  for each row execute function public.product_opening_stock();

-- After this migration products.stock is an OUTPUT. A direct write to it is
-- silently replaced by the rollup rather than rejected, because rejecting would
-- break every existing caller that sends a whole product row back on an
-- unrelated edit (the product form does exactly that). Changing stock now means
-- writing product_location_stock -- see setLocationStock in src/lib/products.ts.
create or replace function public.product_stock_is_derived()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.stock := coalesce((select sum(s.stock) from public.product_location_stock s where s.product_id = new.id), 0);
  return new;
end;
$$;

create trigger product_stock_is_derived_trigger
  before update on public.products
  for each row execute function public.product_stock_is_derived();

-- ---------------------------------------------------------------------------
-- Moving stock between branches
-- ---------------------------------------------------------------------------

-- Without this, per-location stock is a dead end operationally: a shop that
-- receives a delivery centrally has no way to distribute it, and would resort
-- to editing both counts by hand -- two writes that can half-fail, with no
-- record of what moved.
create table public.stock_transfers (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  -- Restricted, not cascade: deleting a location must not erase the history of
  -- stock that moved through it. A branch is deactivated, never deleted, once
  -- it has traded (see the locations panel).
  from_location_id uuid not null references public.shop_locations(id),
  to_location_id uuid not null references public.shop_locations(id),
  note text,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  constraint stock_transfers_distinct_locations check (from_location_id <> to_location_id)
);
create index stock_transfers_shop_idx on public.stock_transfers(shop_id, created_at desc);

create table public.stock_transfer_items (
  id uuid primary key default gen_random_uuid(),
  transfer_id uuid not null references public.stock_transfers(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete cascade,
  -- Frozen at transfer time, exactly as sale_items freezes product_name: a
  -- later rename must not restate what a past transfer moved.
  product_name text not null,
  quantity integer not null check (quantity > 0)
);
create index stock_transfer_items_transfer_idx on public.stock_transfer_items(transfer_id);

alter table public.stock_transfers enable row level security;
alter table public.stock_transfer_items enable row level security;

create policy "read stock_transfers" on public.stock_transfers for select using (is_shop_member(shop_id));
create policy "read stock_transfer_items" on public.stock_transfer_items for select
  using (exists (select 1 from public.stock_transfers t where t.id = transfer_id and is_shop_member(t.shop_id)));

-- No insert/update/delete policy on purpose: transfers are only ever created
-- through transfer_stock() below, which moves both sides in one transaction. A
-- direct insert would record a movement that never happened.
grant select on public.stock_transfers, public.stock_transfer_items to authenticated;

create or replace function public.transfer_stock(
  p_shop_id uuid,
  p_from_location_id uuid,
  p_to_location_id uuid,
  p_items jsonb,
  p_note text default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_transfer_id uuid;
  v_item jsonb;
  v_product public.products%rowtype;
  v_qty integer;
  v_available integer;
  v_moved integer := 0;
begin
  if not public.has_shop_permission(p_shop_id, 'inventory.edit') then
    raise exception 'not authorized for shop %', p_shop_id;
  end if;
  if p_from_location_id = p_to_location_id then
    raise exception 'cannot transfer stock to the same location';
  end if;
  if not exists (select 1 from public.shop_locations where id = p_from_location_id and shop_id = p_shop_id)
     or not exists (select 1 from public.shop_locations where id = p_to_location_id and shop_id = p_shop_id) then
    raise exception 'both locations must belong to shop %', p_shop_id;
  end if;
  if p_items is null or jsonb_array_length(p_items) = 0 then
    raise exception 'a transfer must include at least one item';
  end if;

  insert into public.stock_transfers (shop_id, from_location_id, to_location_id, note, created_by)
    values (p_shop_id, p_from_location_id, p_to_location_id, nullif(p_note, ''), auth.uid())
    returning id into v_transfer_id;

  -- Ordered by product id so two concurrent transfers touching the same pair of
  -- products always take their row locks in the same order and cannot deadlock
  -- against each other -- the same reason refund_sale_items orders its loop.
  for v_item in select value from jsonb_array_elements(p_items) as t(value) order by (value->>'product_id') loop
    v_qty := (v_item->>'quantity')::integer;
    if v_qty is null or v_qty <= 0 then
      raise exception 'invalid transfer quantity';
    end if;

    select * into v_product from public.products
      where id = (v_item->>'product_id')::uuid and shop_id = p_shop_id;
    if v_product.id is null then
      raise exception 'product % not found in this shop', v_item->>'product_id';
    end if;

    select stock into v_available from public.product_location_stock
      where product_id = v_product.id and location_id = p_from_location_id
      for update;

    if coalesce(v_available, 0) < v_qty then
      raise exception 'insufficient stock for % at the source location: has %, need %',
        v_product.name, coalesce(v_available, 0), v_qty;
    end if;

    update public.product_location_stock set stock = stock - v_qty, updated_at = now()
      where product_id = v_product.id and location_id = p_from_location_id;

    insert into public.product_location_stock (product_id, location_id, stock)
      values (v_product.id, p_to_location_id, v_qty)
      on conflict (product_id, location_id)
      do update set stock = public.product_location_stock.stock + excluded.stock, updated_at = now();

    insert into public.stock_transfer_items (transfer_id, product_id, product_name, quantity)
      values (v_transfer_id, v_product.id, v_product.name, v_qty);

    v_moved := v_moved + v_qty;
  end loop;

  if v_moved = 0 then
    raise exception 'cannot record a transfer that moves nothing';
  end if;
  return v_transfer_id;
end;
$$;

grant execute on function public.transfer_stock(uuid, uuid, uuid, jsonb, text) to authenticated;
