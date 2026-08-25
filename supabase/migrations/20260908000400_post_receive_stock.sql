-- A delivery lands in the ledger: Dr 1200 Inventory, Cr 2000 Accounts Payable.
--
-- ## What was missing
--
-- receive_stock moved units and wrote a stock_receipts row and stopped there.
-- Stock arriving is the largest single thing that happens to a small shop's
-- balance sheet and the ledger never heard about it, so 1200 Inventory sat at
-- whatever the opening figure was while the shelves filled up, and 2000
-- Accounts Payable never showed what was owed to a supplier at all.
--
-- ## Payable, not cash
--
-- This RPC records goods ARRIVING. It has no payment method, no register and no
-- till session, and it says nothing whatever about whether the delivery was
-- paid for -- because in this trade it usually is not, not on the day. Crediting
-- cash here would assert a payment nobody made and would drain a drawer the
-- register never opened. Paying the supplier is record_invoice_payment, which
-- debits 2000 back down; the two meet in the middle and what is left in 2000 is
-- what the shop actually owes.
--
-- ## An uncosted line contributes nothing, and a wholly uncosted delivery posts
-- ## no entry at all
--
-- A line with no unit_cost_cents is not a free line. It is a line whose value
-- nobody wrote down, and posting 0 for it would understate stock on hand by
-- exactly the amount that is missing from the record -- silently, and in the one
-- direction a shop would never think to check. So the sum takes costed lines
-- only, and if that leaves nothing there is no entry: not a zero-value entry,
-- which journal_lines' `check (amount_cents <> 0)` would refuse anyway and which
-- would take the whole delivery down with it.
--
-- ## Why there is no closed-period redirect here
--
-- Task 3b gave complete_sale, refund_sale_items and record_sale_payment a
-- redirect: if the entry's own period exists and is not open, the entry is
-- posted into the CURRENT period instead, carrying its true date and the
-- blocking status in its description. That exists because those RPCs can be
-- handed a date in the past -- sales-import.ts backdates every historical sale
-- it brings in -- so the period an entry belongs to can be a period that has
-- since been closed.
--
-- receive_stock takes no such parameter. Its entry date is
-- public.shop_local_date(), which is today by construction, so the period being
-- posted into is always the current one and there is nowhere for a redirect to
-- redirect TO: the "true date" and the "posted date" would be the same date and
-- the branch would be unreachable code carrying a description nobody ever sees.
-- If the shop has closed the month it is standing in, open_period_for raises and
-- the delivery is refused -- which is the right answer, and the same answer a
-- manual entry gets. A closed month means "these books are final"; recording
-- new stock into it is precisely what that declaration rules out.
--
-- ## Copied forward from 20260907000000, NOT from 20260902000000
--
-- receive_stock is reproduced below in full, as this repo requires. The ancestor
-- is 20260907000000_moving_weighted_average.sql -- the newest definition -- and
-- the weighted-average block at the end of the item loop is carried over
-- unchanged, character for character.
--
-- This matters more than it looks. 20260902000000 set products.cost_cents to the
-- newest line's price outright ("latest wins"), which is replacement cost, and
-- IAS 2.25 permits exactly two formulas for interchangeable goods -- FIFO and
-- weighted average. Reproducing from that older file would restore an
-- impermissible cost basis, and it would do so INVISIBLY: every posting
-- assertion in verify-posting-inventory.sql passes either way, because none of
-- them reads products.cost_cents. verify-weighted-average.sql is what catches
-- it, and verify-posting-inventory.sql check 3 duplicates the guard at the point
-- of the change so the next person to copy this function forward trips over it
-- in the file they are editing.
--
-- The ONLY changes below are the two new declarations (v_value_cents,
-- v_entry_id) and the posting block after the item loop.

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
  -- bigint, not integer: 5000 units at a 60,000-cent cost is 300 million, which
  -- fits, but a wholesale delivery an order of magnitude larger does not, and
  -- overflowing here would raise mid-transaction on a delivery the shop can see
  -- on the pallet in front of them.
  v_value_cents bigint;
  v_entry_id uuid;
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

  -- ── posting side ────────────────────────────────────────────────────────
  --
  -- Total delivery value, costed lines only. An uncosted line is not a
  -- zero-value line: the delivery's value is unknown, and posting 0 would
  -- understate stock on hand by exactly what nobody wrote down.
  --
  -- Read back from stock_receipt_items rather than accumulated in the loop, so
  -- the figure posted is the figure that was RECORDED. A running total is a
  -- second opinion on the same arithmetic and the two would eventually differ
  -- on some delivery nobody looks at.
  --
  -- The `is not null` filter is redundant against sum(), which skips nulls
  -- anyway, and is written out because the rule it encodes -- an unpriced line
  -- is excluded, not zeroed -- is the thing a later reader has to not get wrong.
  select coalesce(sum(ri.unit_cost_cents::bigint * ri.quantity), 0)
    into v_value_cents
    from public.stock_receipt_items ri
   where ri.receipt_id = v_receipt_id and ri.unit_cost_cents is not null;

  -- Credit 2000 Payable, not cash: receive_stock records goods ARRIVING, and
  -- says nothing about whether they were paid for. Paying the supplier is
  -- record_invoice_payment, which debits 2000 back down.
  --
  -- shop_local_date(), never now()::date: the latter resolves in the SESSION's
  -- timezone, which is UTC on Supabase, so a delivery booked in at 01:30 local
  -- on the 1st would be dated into the month before -- and once that month
  -- closes the entry cannot be re-dated.
  --
  -- p_source is 'stock', not 'receipt'. The plan said 'receipt'; there is no
  -- such source. journal_entries.source carries a closed check constraint
  -- (20260904000300_journal.sql:48) whose members were all listed up front
  -- precisely so the posting phases would add none, and the one reserved for
  -- this door is 'stock'. 'receipt' fails the constraint outright and takes the
  -- delivery down with it.
  --
  -- Explicit, and never left at the 'manual' default: post_journal_entry gates
  -- ONLY 'manual' on ledger.post, so a default here would make a stockroom
  -- member's delivery depend on a ledger permission they have no business
  -- holding -- and would pass every test written by an owner, who holds it.
  if v_value_cents > 0 then
    v_entry_id := public.post_journal_entry(
      p_shop_id, public.shop_local_date(), 'Stock received',
      jsonb_build_array(
        jsonb_build_object('code', '1200', 'amount_cents',  v_value_cents, 'memo', 'Delivery received'),
        jsonb_build_object('code', '2000', 'amount_cents', -v_value_cents, 'memo', 'Owed to supplier')),
      p_location_id, 'stock');
    update public.stock_receipts set journal_entry_id = v_entry_id where id = v_receipt_id;
  end if;
  -- ── end posting side ────────────────────────────────────────────────────

  return v_receipt_id;
end;
$$;

grant execute on function public.receive_stock(uuid, uuid, jsonb, text, text, text) to authenticated;
