-- Value stock at a moving weighted average, not the latest price paid.
--
-- ## What was wrong
--
-- receive_stock (20260902000000_stock_receipts.sql:173) REPLACED the cost with
-- the newest line's price:
--
--   update public.products set cost_cents = v_cost ... ;
--
-- That migration's own comment called it "latest wins". Buy 200 bags at 14.10
-- and 10 at 14.90, and all 210 are valued at 14.90 -- every subsequent sale's
-- COGS is the most recent price paid, whatever the units actually cost.
--
-- That is replacement cost. IAS 2.25 permits exactly two cost formulas for
-- interchangeable goods -- FIFO and weighted average -- and this is neither.
-- IFRS for SMEs 13.18 says the same. So this is not a refinement; it is the
-- difference between a permitted basis and an impermissible one.
--
-- ## Why weighted average rather than FIFO
--
-- The two are equals under the standard. Under inflation FIFO draws COGS from
-- the oldest and cheapest stock, raising reported profit and so raising tax.
-- The FIFO design and plan are merged (#65, #68) and stay available if it is
-- ever wanted; cost layers would then be an upgrade rather than a prerequisite,
-- and this migration's arithmetic is what they would replace.
--
-- ## What is NOT changed
--
-- complete_sale, save_stock_count, refund_sale_items and transfer_stock are all
-- untouched. So is stock_receipt_items.unit_cost_cents, which keeps the
-- DELIVERY's price rather than the new average: it is the record of what that
-- delivery cost, and rewriting it to the average would destroy the only
-- evidence the average was computed from. sale_items.unit_cost_cents is frozen
-- at sale time, so historical margins do not move either.
--
-- receive_stock is reproduced below in full, as this repo requires, with ONE
-- change: the cost write at the end of the loop.

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
  v_prior_qty integer;
  v_new_cost integer;
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
  -- lists the same product twice.
  --
  -- The tiebreaker matters more now, not less. Under "latest wins" it decided
  -- which of two lines' costs survived. Under an average it decides the ORDER
  -- the two lines compound in -- and because v_prior_qty is read fresh each
  -- iteration, the second line averages against the first line's result. Two
  -- lines for one product therefore give the same answer as two separate
  -- receipts, which is the only defensible reading of a sheet that lists a
  -- product twice.
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

    -- THE CHANGE. Read the prior quantity BEFORE the upsert below, which adds
    -- this delivery to the count. Averaging against the post-upsert figure
    -- double-counts the received quantity and lands between the two costs --
    -- wrong in a way nobody would spot. (Subtracting v_qty back off afterwards
    -- would work too, and is a second place to get the sign wrong.)
    --
    -- Shop-wide, not this location's: products.cost_cents is one figure for the
    -- whole shop, so averaging against one branch's stock would make the same
    -- delivery produce a different cost depending on where it landed.
    --
    -- coalesce covers a product with no product_location_stock row at all.
    -- greatest(...,0) is belt-and-braces: product_location_stock refuses
    -- negatives, and a negative here would drive the divisor toward zero.
    select greatest(coalesce(sum(stock), 0), 0) into v_prior_qty
      from public.product_location_stock where product_id = v_product.id;

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

      -- A true moving weighted average, which is one of the two formulas
      -- IAS 2.25 permits. The statement that used to be here set cost_cents to
      -- v_cost outright -- "latest wins" -- which is replacement cost and is
      -- not a permitted basis.
      --
      -- Nothing on the shelf, or a null prior cost, means there is nothing to
      -- average against and the delivery is the whole basis. Null is NOT
      -- treated as zero: it means nobody priced this product, and averaging it
      -- as free would halve the cost of everything they had not got to. This is
      -- the same care isUncosted() in product-costing.ts takes -- a free sample
      -- really does cost nothing, and an unpriced product is not a free one.
      if v_prior_qty <= 0 or v_product.cost_cents is null then
        v_new_cost := v_cost;
      else
        -- numeric, not integer: 450 * 1250 overflows nothing here, but a shop
        -- with six figures of units at a five-figure cost would overflow int4
        -- mid-multiplication and the average is worth more than the saving.
        v_new_cost := round(
          (v_prior_qty::numeric * v_product.cost_cents + v_qty::numeric * v_cost)
          / (v_prior_qty + v_qty)
        );
      end if;

      -- Safe despite product_stock_is_derived_trigger, which rewrites `stock`
      -- on every products UPDATE: the rollup it computes is the one the upsert
      -- above just produced, so this statement leaves the count where it is.
      update public.products set cost_cents = v_new_cost, updated_at = now() where id = v_product.id;
    end if;

    -- The DELIVERY's price, deliberately, not v_new_cost. This column is "what
    -- this delivery cost" and is never rewritten; products.cost_cents is "what
    -- it costs me now". Writing the average here would destroy the only
    -- evidence the average was computed from.
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
