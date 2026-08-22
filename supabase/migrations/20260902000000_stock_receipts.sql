-- Receiving a delivery.
--
-- Inventory could create products, move them between stores, and correct one
-- count at a time. It could not do the most ordinary thing a shop does all
-- week: take in more of something it already sells. The three ways out were all
-- wrong -- retype every count by hand; re-import the catalogue and have every
-- row rejected as a duplicate; or re-import under tweaked names and end up
-- owning two of every product. That last one is the same double-counting
-- 20260810000000's transfer_stock() was built to stop, arriving by another door.
--
-- Modelled on transfer_stock() deliberately, down to the lock ordering, because
-- the two are the same shape: change counts and write a record, in one
-- transaction, through a security definer function with no write policy behind
-- it. The differences are stated where they occur.

create table public.stock_receipts (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  -- NO ACTION, not cascade -- the default, and inherited deliberately from
  -- stock_transfers, which does the same. (It is not RESTRICT, whatever the
  -- wording carried over from that table used to say: the difference is only
  -- that NO ACTION defers to the end of the statement. Neither one lets the
  -- delete through.) Deleting a location must not erase the history of stock
  -- that came through it; a branch is deactivated, never deleted, once it has
  -- traded.
  location_id uuid not null references public.shop_locations(id),
  -- Free text, not a vendors FK. A delivery is often logged by whoever opened
  -- the box, and requiring them to create a vendor record first is how a
  -- feature stops being used. Accounting's vendor list stays the place where
  -- a supplier becomes a first-class record.
  supplier_name text,
  -- The shop's own handle on the delivery: an invoice number, a waybill, a
  -- purchase order. Free text because every supplier numbers things differently.
  reference text,
  note text,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);
create index stock_receipts_shop_idx on public.stock_receipts(shop_id, created_at desc);
create index stock_receipts_location_idx on public.stock_receipts(location_id, created_at desc);

create table public.stock_receipt_items (
  id uuid primary key default gen_random_uuid(),
  receipt_id uuid not null references public.stock_receipts(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete cascade,
  -- Frozen at receipt time, exactly as stock_transfer_items and sale_items
  -- freeze it: a later rename must not restate what a past delivery contained.
  product_name text not null,
  quantity integer not null check (quantity > 0),
  -- What this delivery cost per unit, frozen. Distinct from products.cost_cents,
  -- which the RPC overwrites with this value: that column is "what it costs me
  -- now" and is rewritten by every priced delivery, while this one is "what
  -- this delivery cost" and is never rewritten. Without both, a shop that
  -- restocks at a new price loses any record of the old one.
  unit_cost_cents integer check (unit_cost_cents is null or unit_cost_cents >= 0)
);
create index stock_receipt_items_receipt_idx on public.stock_receipt_items(receipt_id);

alter table public.stock_receipts enable row level security;
alter table public.stock_receipt_items enable row level security;

create policy "read stock_receipts" on public.stock_receipts for select using (is_shop_member(shop_id));
create policy "read stock_receipt_items" on public.stock_receipt_items for select
  using (exists (select 1 from public.stock_receipts r where r.id = receipt_id and is_shop_member(r.shop_id)));

-- No insert/update/delete policy, on purpose and for the same reason as
-- stock_transfers: a receipt is only ever created through receive_stock()
-- below, which adds the units and writes the record in one transaction. A
-- direct insert would record a delivery whose stock never arrived.
grant select on public.stock_receipts, public.stock_receipt_items to authenticated;

-- Gated on `inventory`, NOT on `multi_location`.
--
-- This is the one place this feature deliberately diverges from the transfer it
-- is modelled on. stock_transfers is gated on multi_location because a movement
-- needs two branches to exist at all. Receiving needs one. Copying that trigger
-- across would lock every single-store shop out of the feature they need most,
-- which is most shops on the platform.
--
-- product_location_stock already carries the same inventory gate
-- (20260818000400), so the units cannot land without it either; this trigger
-- covers the receipt row itself and states the intent where someone adding a
-- new gate will read it.
create trigger stock_receipts_module before insert or update on public.stock_receipts
  for each row execute function public.enforce_shop_module('inventory');

-- Adds units to one store, records what arrived, and updates each product's
-- cost to what this delivery charged.
--
-- ## Why cost is written here rather than left to the caller
--
-- products.cost_cents is nullable, and isUncosted() in product-costing.ts is
-- careful that null is not zero -- a free sample really does cost nothing.
-- Passing unit_cost_cents null means "I did not say", and the column is left
-- exactly as it was. Passing a number means "this is what it costs me now", and
-- it wins. A delivery is the one moment the true cost is on the desk, and the
-- alternative -- a second round trip from the client -- could half-fail and
-- leave the units received at the old cost.
create or replace function public.receive_stock(
  p_shop_id uuid,
  p_location_id uuid,
  p_items jsonb,
  p_supplier_name text default null,
  p_reference text default null,
  p_note text default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_receipt_id uuid;
  v_item jsonb;
  v_product public.products%rowtype;
  v_qty integer;
  v_cost integer;
  v_received integer := 0;
begin
  if not public.has_shop_permission(p_shop_id, 'inventory.edit') then
    raise exception 'not authorized for shop %', p_shop_id;
  end if;
  if not exists (select 1 from public.shop_locations where id = p_location_id and shop_id = p_shop_id) then
    raise exception 'the receiving location must belong to shop %', p_shop_id;
  end if;
  if p_items is null or jsonb_array_length(p_items) = 0 then
    raise exception 'a receipt must include at least one item';
  end if;

  insert into public.stock_receipts (shop_id, location_id, supplier_name, reference, note, created_by)
    values (p_shop_id, p_location_id, nullif(p_supplier_name, ''), nullif(p_reference, ''), nullif(p_note, ''), auth.uid())
    returning id into v_receipt_id;

  -- Ordered by product id so two concurrent receipts touching the same products
  -- take their row locks in the same order and cannot deadlock -- the same
  -- reason transfer_stock and refund_sale_items order their loops. Ordinality
  -- is the tiebreaker: product id alone is not a total order when a sheet
  -- lists the same product twice, and without one, two lines for the same
  -- product with different unit_cost_cents would leave products.cost_cents at
  -- whichever line happened to sort second -- "latest wins" silently becoming
  -- "either wins". Breaking the tie by array position keeps it "the last line
  -- in the sheet wins", which is what "latest" is supposed to mean.
  for v_item in
    select value from jsonb_array_elements(p_items) with ordinality as t(value, ord)
      order by (value->>'product_id'), ord
  loop
    v_qty := (v_item->>'quantity')::integer;
    -- Zero is refused as well as negative. A line that changes nothing is a
    -- mistake in the sheet, not a no-op, and skipping it silently would report
    -- a delivery larger than the one that actually landed.
    if v_qty is null or v_qty <= 0 then
      raise exception 'invalid received quantity';
    end if;

    select * into v_product from public.products
      where id = (v_item->>'product_id')::uuid and shop_id = p_shop_id;
    if v_product.id is null then
      raise exception 'product % not found in this shop', v_item->>'product_id';
    end if;

    -- No availability check and no `for update` on the source: unlike a
    -- transfer, there is nothing to run out of. The upsert below takes the row
    -- lock it needs on the destination and nothing else.
    insert into public.product_location_stock (product_id, location_id, stock)
      values (v_product.id, p_location_id, v_qty)
      on conflict (product_id, location_id)
      do update set stock = public.product_location_stock.stock + excluded.stock, updated_at = now();

    v_cost := nullif(v_item->>'unit_cost_cents', '')::integer;
    if v_cost is not null then
      if v_cost < 0 then
        raise exception 'a unit cost cannot be negative';
      end if;
      -- Safe despite product_stock_is_derived_trigger, which rewrites `stock`
      -- on every products UPDATE: the rollup it computes is the one the upsert
      -- above just produced, so this statement leaves the count where it is.
      update public.products set cost_cents = v_cost, updated_at = now() where id = v_product.id;
    end if;

    insert into public.stock_receipt_items (receipt_id, product_id, product_name, quantity, unit_cost_cents)
      values (v_receipt_id, v_product.id, v_product.name, v_qty, v_cost);

    v_received := v_received + v_qty;
  end loop;

  -- Unreachable, and kept anyway: the loop above rejects every quantity below 1
  -- by raising, so reaching here with nothing received would need an EMPTY
  -- p_items -- which the `jsonb_array_length(p_items) = 0` guard at the top has
  -- already refused. Mirrors transfer_stock line for line so the two RPCs can be
  -- read side by side, and it is the backstop if either guard is ever loosened.
  if v_received = 0 then
    raise exception 'cannot record a receipt that receives nothing';
  end if;
  return v_receipt_id;
end;
$$;

grant execute on function public.receive_stock(uuid, uuid, jsonb, text, text, text) to authenticated;
