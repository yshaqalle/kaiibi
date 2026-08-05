-- One-time backfill of `sale_items.unit_cost_cents` from the product's current
-- cost, for lines that were rung up before anyone recorded a cost.
--
-- This deliberately reverses the "not backfilled" decision taken in
-- 20260804000000_sale_item_cost_snapshot.sql. That decision was right about the
-- accounting principle -- today's cost is not evidence of what a past unit
-- actually cost -- but it assumed a shop that had costs on file all along and
-- gained the column later. The real case is the opposite: shops start selling
-- first and fill in cost prices afterwards, so every sale made before that
-- point reports as uncosted forever. The result is a Gross Profit tile equal to
-- revenue and a permanent "N sold items have no cost recorded" warning that no
-- amount of correct data entry can clear.
--
-- The trade-off, stated plainly: for these rows, cost is the product's cost
-- TODAY, not what the unit actually cost when it sold. That is an estimate. It
-- is a far better one than treating the cost as zero, which is what an
-- uncosted line effectively reports once someone reads the profit number.
--
-- Scope is limited on purpose:
--   * only rows where unit_cost_cents is null -- a cost already frozen at sale
--     time is real history and is never overwritten;
--   * only lines still linked to a product (product_id not null) -- a deleted
--     product leaves no cost to read;
--   * only products with a cost actually recorded (cost_cents not null) -- a
--     product nobody has costed stays uncosted, and the reporting warning keeps
--     telling the truth about it. Note cost_cents = 0 is a recorded cost (a
--     free sample, a giveaway) and is backfilled as zero; blank imports and
--     untouched products are null, not zero (see parseDollarsToCents in
--     src/lib/products-import.ts).
--
-- Sales made from here on need no backfill: complete_sale and edit_sale both
-- snapshot v_product.cost_cents onto the line at the moment of sale. The only
-- lines that can still come out uncosted are ones sold while the product had no
-- cost on file -- if that keeps happening, the fix is to record the cost in
-- Inventory before selling, not to re-run this.
update public.sale_items si
   set unit_cost_cents = p.cost_cents
  from public.products p
 where si.product_id = p.id
   and si.unit_cost_cents is null
   and p.cost_cents is not null;
