-- Costing a product that already had stock is a REVALUATION, and a revaluation
-- has to reach the ledger.
--
-- ===========================================================================
-- THE RESIDUE THIS CLOSES
-- ===========================================================================
--
-- 20260908001300 gave every shop an opening inventory balance, and valued the
-- stock it opens with as
--
--   sum(products.stock * products.cost_cents) where cost_cents is not null
--
-- An uncosted product therefore contributes NOTHING, which is right and stays
-- right: there is no honest value to put on stock nobody has ever priced, and
-- the two candidates a build would reach for are both worse than the gap --
-- zero states a price somebody chose, and price_cents capitalises unearned
-- profit into an asset. That file argued the exclusion on a second ground as
-- well, and this is the one that was not true:
--
--   "NOTHING TAKES AN UNCOSTED PRODUCT BACK OUT OF 1200 WHILE IT STAYS
--    UNCOSTED."
--
-- Every word of that holds. The trouble is the last four. A product does not
-- have to stay uncosted, and the RPC that costs it is the one below.
--
--   receive_stock, on a delivery onto stock whose cost is null:
--
--     if v_prior_qty <= 0 or v_product.cost_cents is null then
--       v_new_cost := v_cost;
--
--   There is nothing to weight an average against, so the delivery's price
--   becomes the price of THE ENTIRE HOLDING -- the units delivered and the
--   units that were already on the shelf. That is the weighted-average rule
--   and it is correct. But the ledger only ever hears about the units
--   DELIVERED.
--
-- Worked through, on a shop that opens with 50 uncosted units of X:
--
--   opening balance                 X contributes 0        Dr 1200      0
--   a delivery of 10 @ 100          cost_cents := 100,     Dr 1200  1,000
--                                   stock := 60
--   all 60 sold, COGS at 100        the frozen unit cost   Cr 1200 -6,000
--                                                          -------------
--   1200 Inventory ends at                                       -5,000
--
-- A NEGATIVE ASSET -- the exact number PR #76 and 20260908001300 existed to
-- remove -- over books whose trial balance is perfectly zero, because both
-- halves of every entry were right. And the opening marker
-- (`source = 'opening'` with a line on 1200) means a second backfill can never
-- come back and correct it: opening_inventory_gap returns 0 for that shop for
-- ever.
--
-- 20260908001300 named this residue in its own header and verify-backfill.sql
-- check 21b pinned the number -3400 as a PRESENT defect so nobody could
-- re-derive "1200 can never go negative again" from a comment. Both are
-- corrected by this migration; the check now asserts 1200 ends at the value of
-- stock on hand.
--
-- ===========================================================================
-- WHAT THE ENTRY IS
-- ===========================================================================
--
--   Dr 1200 Inventory        v_prior_qty x v_new_cost
--   Cr 3000 Owner's Capital  the same
--
-- The units on the shelf acquired a value they never had. Nobody bought them
-- today, nobody owes a supplier for them, and nothing was lost. They were
-- already there, and the only thing that changed is that they are now
-- MEASURABLE.
--
-- ---------------------------------------------------------------------------
-- 3000 Owner's Capital, and why not any of the four alternatives
-- ---------------------------------------------------------------------------
--
-- The reasoning is 20260908001300's, applied to the same facts one step later,
-- and it is worth restating because this entry is easier to get wrong than the
-- opening balance was -- it happens on the hot path, in the middle of a
-- delivery, and its counterpart decides whether it lands on the balance sheet
-- or in the month's profit.
--
--   * NOT 2000 Accounts Payable, which is what the delivery's own entry
--     credits. Nothing is owed for these units. They were on the shelf before
--     this supplier was called, and crediting 2000 would state a debt that no
--     record of a bill supports and that record_invoice_payment would then be
--     unable to work off. It would also make the accounts-payable caveat
--     (20260908001700) accuse the shop of an unrecorded delivery.
--
--   * NOT 5100 Inventory Shrinkage, and not any 5xxx or 6xxx account. Those
--     sit in the P&L. Valuing stock upward is not income and valuing it at all
--     is not an expense: no goods moved, no cash moved, nothing was consumed.
--     Routing it through profit would put a gain into the month a delivery
--     happened to land in, for units bought long before it.
--
--   * NOT 4xxx revenue, for the same reason and worse. A shop cannot earn
--     money by noticing what its own stock cost.
--
--   * NOT a suspense or "inventory revaluation reserve" account. There is no
--     such account in the chart (20260904000100), and adding one would mean a
--     line on the balance sheet that no report knows how to present and that
--     nothing will ever clear.
--
-- 3000 is what is left, and it is not a residual choice for the population this
-- was written about: stock the shopkeeper put into the business before the app
-- could measure it. A product created with `stock: 40` writes no delivery and
-- no ledger row of any kind, and the opening entry credits 3000 for precisely
-- that. A revaluation of the opening holding and the opening balance itself are
-- the same transaction discovered at two different moments, and they must land
-- in the same place or a shop's capital account depends on whether it happened
-- to be costed before or after somebody pressed Post History.
--
-- THERE IS A SECOND POPULATION, AND 3000 IS ONLY THE BEST AVAILABLE ACCOUNT FOR
-- IT -- not a description of it. `v_prior_qty` is whatever is on the shelf, and
-- the in-app path that fills it is not opening stock at all: a delivery
-- RECORDED THROUGH RESTOCK WITH THE COST FIELD LEFT EMPTY (an ordinary outcome
-- -- stock-restock-modal.tsx leaves it empty on purpose and receive_stock
-- accepts a null cost), later costed by a second delivery of the same product.
-- Those units came from a supplier. They may still be owed for. Calling them
-- owner's capital says the shopkeeper contributed goods they in fact bought,
-- and if the first delivery is later billed the payable is raised against 2000
-- while its stock sits against 3000.
--
-- It is still 3000, because every alternative is worse and none of them is
-- knowable here: 2000 states a debt no bill supports (and makes the
-- accounts-payable caveat accuse the shop of an unrecorded delivery), and a
-- P&L account puts a gain into the month a later delivery happened to land in.
-- What the entry cannot do is claim to know which population a unit came from.
-- Its description -- 'Existing stock valued' -- is deliberately about the
-- MEASUREMENT rather than about where the goods came from, and this paragraph
-- is what a reader who finds 3000 moving on a trading shop should be sent to.
--
-- IT IS A PLUG, AND IT ABSORBS ERROR, the same way the opening balance does.
-- That is accepted for the same reason and mitigated the same way: it is ONE
-- NAMED ENTRY with its own description, not a quiet adjustment folded into the
-- delivery, so a reader can see it and ask about it.
--
-- ===========================================================================
-- TWO ENTRIES, NOT ONE -- AND THIS IS NOT A STYLE DECISION
-- ===========================================================================
--
-- The tempting shape is one entry:
--
--   Dr 1200  delivery + revaluation / Cr 2000  delivery / Cr 3000  revaluation
--
-- It balances, it is one row instead of two, and it is wrong on four counts.
--
--   1. A READER CANNOT TELL THE TWO EVENTS APART. "Goods arrived" and "stock
--      we already had is now valued" are different facts about different
--      units, and one is a transaction with an outside party while the other
--      is not. Merged, the entry's 1200 debit no longer equals what the
--      supplier is owed and no line in the journal states either fact.
--
--   2. DELETING THE DELIVERY WOULD REVERSE THE REVALUATION TOO, AND THAT IS A
--      BUG. stock_receipts_reverse_on_delete (20260908001500) mirrors the
--      entry stock_receipts.journal_entry_id points at. Deleting a delivery
--      does NOT un-cost the product -- nothing resets products.cost_cents --
--      so the units that were already on the shelf are still costed at 100 and
--      1200 must still carry their 5,000. Merged, the reversal would take that
--      back out too and leave 1200 short by the whole revaluation while the
--      shelf it describes is still valued. Separate, the delivery's 1,000
--      reverses and the revaluation stands, which is what is still true.
--      Asserted by verify-posting-inventory.sql check 13e.
--
--   3. stock_receipts.journal_entry_id IS THE DELIVERY'S ENTRY. Everything
--      downstream reads it as such: the reversal trigger, the idempotency test
--      in unposted_ledger_source_rows, and verify-backfill.sql's per-kind
--      tie-out, which matches a receipt entry's 1200 debit against the sum of
--      its stock_receipt_items. A merged entry breaks that tie-out on a shop
--      that has one uncosted product, and the failure would read as a backfill
--      defect.
--
--   4. THE REVALUATION IS SHOP-WIDE AND THE DELIVERY IS NOT. v_prior_qty is a
--      sum over every location (see the comment at the read, and below), so
--      the units being valued mostly are not at the receiving branch. The
--      delivery's entry carries p_location_id and should; this one carries no
--      location, because attributing another branch's stock to the branch that
--      happened to sign for a pallet is a per-location P&L that lies.
--
-- The delivery's entry is posted FIRST, and the revaluation second, so the
-- reference numbers read in the order the story happens: JE-n the goods
-- arriving, JE-n+1 the consequence of what they cost.
--
-- ===========================================================================
-- WHEN IT FIRES -- ALL THREE CONDITIONS, AND WHAT THE OTHER CASES DO
-- ===========================================================================
--
-- The transition is `the product was uncosted` AND `it already held stock` AND
-- `this line supplies a cost`. Every other combination is unchanged, and each
-- is unchanged for its own reason:
--
--   prior cost | prior qty | cost on line | what happens
--   -----------+-----------+--------------+--------------------------------
--   null       | > 0       | given        | THE NEW CASE. The whole holding is
--              |           |              | costed, so the units already on the
--              |           |              | shelf are revalued. Delivery entry
--              |           |              | + revaluation entry.
--   null       | > 0       | none         | Nothing. The product stays
--              |           |              | uncosted, cost_cents is not
--              |           |              | written, and there is nothing to
--              |           |              | revalue TO. No entry at all --
--              |           |              | the delivery's own value is 0 too.
--   null       | 0         | given        | Delivery entry only. There is
--              |           |              | nothing on the shelf to revalue;
--              |           |              | v_new_cost := v_cost prices the
--              |           |              | delivered units and they are
--              |           |              | already in the delivery's value.
--   null       | 0         | none         | Nothing. Same as row 2.
--   set        | > 0       | given        | Delivery entry only, and the
--              |           |              | weighted average moves. The units
--              |           |              | on the shelf already carry a cost
--              |           |              | and 1200 already holds it; a
--              |           |              | revaluation here would post the
--              |           |              | whole holding a SECOND time.
--   set        | > 0       | none         | Nothing. cost_cents is untouched
--              |           |              | and the delivery's value is 0.
--   set        | 0         | given        | Delivery entry only. v_new_cost :=
--              |           |              | v_cost because there is nothing to
--              |           |              | average against -- but there is
--              |           |              | also nothing on the shelf, so
--              |           |              | there is nothing to revalue.
--   set        | 0         | none         | Nothing.
--
-- The condition is written as `v_product.cost_cents is null and v_prior_qty >
-- 0`, INSIDE the branch that already fires for `v_prior_qty <= 0 or
-- v_product.cost_cents is null` -- which that branch is reached by two
-- different situations and only one of them is a revaluation.
--
-- BOTH CLAUSES ARE REDUNDANT AS THEY STAND, AND THAT IS SAID OUT LOUD RATHER
-- THAN DISCOVERED. Inside that branch `v_product.cost_cents is null` is
-- already implied whenever there is stock, and `v_prior_qty > 0` only stops an
-- expression that would evaluate to `0 * cost` anyway, which the `> 0` guard at
-- the foot suppresses. Deleting either one on its own is a no-op; both
-- mutations were run and both left every check green. They are kept because
-- the condition is the STATEMENT of when a revaluation happens, and a reader
-- who has to reconstruct it from the surrounding branch will reconstruct it
-- wrongly -- as the pair of mutations that DO bite shows: hoisting the block
-- out of the branch revalues costed stock, and pairing the post-upsert
-- quantity with a dropped `v_prior_qty > 0` revalues an empty shelf.
-- verify-posting-inventory.sql checks 13a and 13b carry both.
--
-- v_prior_qty IS SHOP-WIDE AND STAYS SHOP-WIDE. products.cost_cents is one
-- figure per product, so averaging against one branch's stock would make the
-- same delivery produce a different cost depending on where it landed -- and
-- for this entry the consequence is sharper still: revaluing one branch's
-- units would leave the others' silently unvalued while their cost had already
-- changed, which is the original defect in miniature.
--
-- ---------------------------------------------------------------------------
-- A ZERO REVALUATION POSTS NOTHING
-- ---------------------------------------------------------------------------
--
-- v_prior_qty is > 0 by the condition and v_new_cost is >= 0 by the guard
-- above it, so the product is never negative and is zero in exactly one case:
-- a FREE delivery, unit_cost_cents = 0, onto uncosted stock. That is a real
-- answer, not a missing one -- isUncosted() is careful about the difference --
-- and the honest treatment of it is that the shelf is worth nothing and 1200
-- should not move. Which is fortunate, because journal_lines carries
-- `check (amount_cents <> 0)`: a zero-value entry does not merely mislead, it
-- RAISES, and it would take the whole delivery down with it. The same
-- `> 0` guard the delivery's own posting block uses, for the same reason.
--
-- ---------------------------------------------------------------------------
-- ONE ENTRY PER DELIVERY, NOT ONE PER PRODUCT
-- ---------------------------------------------------------------------------
--
-- v_reval_cents accumulates across the item loop and one entry is posted at
-- the end, which is what the delivery's own entry does with v_value_cents. A
-- sheet that costs three previously-uncosted products for the first time is
-- one event, and three entries carrying three reference numbers for it would
-- read as three separate revaluations.
--
-- A product listed TWICE on one sheet revalues once, and falls out of the
-- ordering rather than needing a rule: v_product is re-read at the top of each
-- iteration, so the second line sees cost_cents already set by the first and
-- takes the `else` branch -- the weighted average -- like any other delivery
-- onto costed stock.
--
-- ===========================================================================
-- THE DATE, THE SOURCE, AND A CLOSED MONTH
-- ===========================================================================
--
-- public.shop_local_date(), never now()::date: the latter resolves in the
-- SESSION's timezone, which is UTC on Supabase, so a delivery booked in at
-- 01:30 local on the 1st would be dated into the month before. The same date
-- as the delivery's own entry, deliberately -- these are two halves of one
-- moment and dating them apart would let a month-end fall between them.
--
-- p_source is 'stock'. journal_entries.source carries a closed check
-- constraint (20260904000300:48) listing fourteen members, all declared up
-- front so the posting phases add none, and 'stock' is the one reserved for
-- this door. It is stated explicitly and never left at the 'manual' default,
-- because post_journal_entry gates ONLY 'manual' on ledger.post -- a default
-- here would make a stockroom member's delivery depend on a ledger permission
-- they have no business holding, and would pass every test written by an
-- owner, who holds it.
--
-- 'stock' AND NOT 'opening', WHICH IS THE TRAP. This entry is doing what an
-- opening balance does and the name fits the meaning, which is exactly why it
-- must not be used: opening_inventory_gap's idempotency marker is
-- `an entry with source = 'opening' AND a line on 1200`, so the first delivery
-- that revalued anything would tell every future backfill that this shop had
-- already been opened, and the shop's real opening balance -- its rice, its
-- everything-else -- would never be posted at all. The revaluation would have
-- suppressed the entry it was written to complete.
--
-- NO CLOSED-PERIOD REDIRECT, matching the delivery's own entry and for the
-- same reason (see 20260908000400's header at length). The entry date is
-- shop_local_date(), which is today by construction, so the period is always
-- the current one and there is nowhere for a redirect to redirect TO. If the
-- shop has closed the month it is standing in, open_period_for raises and the
-- whole delivery is refused -- both entries or neither, in one transaction,
-- which is the right answer and the same answer a manual entry gets.
--
-- ===========================================================================
-- THE BACKFILL AND THE DOOR NEED NO CHANGE, AND THAT IS A RESULT
-- ===========================================================================
--
-- The load-bearing property of this whole phase is that
-- unposted_ledger_sources (the door) and backfill_shop_ledger (the run) never
-- disagree about what a run will write. Neither is touched here, and the
-- reason is worth writing down because "no change" is the answer that gets
-- assumed rather than checked.
--
-- opening_inventory_gap is
--
--   on-hand at weighted-average cost
--     - what the ledger already holds against 1200
--     - what the replay is about to put through 1200
--
-- A revaluation entry is a POSTED entry with a line on 1200, so it lands in
-- the second term the moment it is written. It has no source row -- there is
-- no table of revaluations, and there could not be one, because the event is a
-- column changing value -- so it never appears in the third term and never
-- appears in the door. Both directions come out right:
--
--   * A SHOP THAT HAS ALREADY BEEN OPENED (the defect's own shop). The
--     revaluation is what the opening entry could no longer be allowed to do.
--     1200 gains the 5,000, and on-hand less ledger is zero again.
--
--   * A SHOP THAT HAS NOT BEEN OPENED YET. The delivery posts 1,000, the
--     revaluation posts 5,000, and when Post History is finally pressed the
--     gap is on-hand less those 6,000 -- which is the rest of the shelf and
--     nothing else. The opening balance does not double-count the revalued
--     units, because the arithmetic subtracts what the ledger holds rather
--     than reasoning about which units were which.
--
--   * A SHOP MID-REPLAY, with the delivery still unposted. The receipt arm of
--     unposted_inventory_movement carries the delivery's 1,000; the ledger
--     term carries the revaluation's 5,000 if one was written and does not if
--     one was not. Either way the gap is on-hand less everything that will
--     have reached 1200, which is the definition it started from.
--
-- The replay itself does not and cannot write revaluation entries for history
-- it never saw -- a shop whose product was costed by a delivery LAST YEAR has
-- no record of when the column changed. It does not need to: for that shop
-- the opening balance is computed from today's on-hand and today's ledger, so
-- the missing revaluation is inside the gap and gets posted as part of the
-- opening entry, under a heading that is true of it.
--
-- ===========================================================================
-- COPIED FORWARD FROM 20260908000400, NOT FROM 20260907000000
-- ===========================================================================
--
-- receive_stock is reproduced below IN FULL, as this repo requires, and its
-- newest ancestor is 20260908000400_post_receive_stock.sql -- NOT
-- 20260907000000_moving_weighted_average.sql, which is where the residue was
-- described and is the file a reader of that description would reach for.
--
-- Copying from 20260907000000 would silently delete the entire posting side: a
-- delivery would move stock and write no entry, 1200 would stop growing, and
-- verify-posting-inventory.sql check 1 catches it. Copying from
-- 20260902000000 would silently restore "latest wins" -- replacement cost,
-- which is not one of the two formulas IAS 2.25 permits -- and only
-- verify-weighted-average.sql and check 3 catch that. accumulated-rpc-edits
-- guards both from the SQL text, before anything is applied.
--
-- The ONLY changes below are the one new declaration (v_reval_cents), the
-- accumulation inside the null-cost branch of the average, and the second
-- posting block at the foot.

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
  -- bigint for a sharper version of the same reason: this one multiplies the
  -- shop's ENTIRE holding of a product by its new cost, which is the largest
  -- figure this function ever computes and is unbounded by the size of the
  -- delivery that triggered it.
  v_reval_cents bigint := 0;
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

    -- Read the prior quantity BEFORE the upsert below, which adds this delivery
    -- to the count. Averaging against the post-upsert figure double-counts the
    -- received quantity and lands between the two costs -- wrong in a way
    -- nobody would spot. (Subtracting v_qty back off afterwards would work too,
    -- and is a second place to get the sign wrong.)
    --
    -- Shop-wide, not this location's: products.cost_cents is one figure for the
    -- whole shop, so averaging against one branch's stock would make the same
    -- delivery produce a different cost depending on where it landed. It is
    -- also the quantity the revaluation at the foot of this function values,
    -- and for that it must be shop-wide too -- see this migration's header.
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

        -- THE CHANGE. This branch is reached by two different situations and
        -- only one of them is a revaluation, so BOTH halves of the condition
        -- are load-bearing:
        --
        --   nothing on the shelf -> the delivery prices the delivered units
        --                           and they are already in the delivery's
        --                           own entry. Nothing to revalue.
        --   uncosted, with stock -> the units that were ALREADY THERE have
        --                           just been given a cost they never had. The
        --                           ledger has never carried a cent for them
        --                           and nothing else will ever put one there.
        --
        -- Accumulated across the loop and posted once at the foot, against
        -- 3000 Owner's Capital -- the shopkeeper's own goods, measurable for
        -- the first time. See the header for why not 2000, not 5100, and not
        -- the merged single entry.
        if v_product.cost_cents is null and v_prior_qty > 0 then
          v_reval_cents := v_reval_cents + v_prior_qty::bigint * v_new_cost;
        end if;
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

  -- ── the revaluation, a SECOND entry ─────────────────────────────────────
  --
  -- Posted after the delivery's own entry, so the reference numbers read in
  -- the order the story happens, and NOT merged into it: see the header for
  -- the four reasons, of which the load-bearing one is that deleting the
  -- delivery must not take the revaluation with it.
  --
  -- No location. v_prior_qty is summed across every branch, so most of these
  -- units are not at the receiving one, and stamping them with it would give a
  -- per-location balance sheet that is wrong on both branches at once.
  --
  -- Its journal_entry_id is deliberately not stored anywhere. There is no row
  -- this entry belongs to -- the event is a column acquiring a value -- and
  -- stock_receipts.journal_entry_id means "the entry for this DELIVERY", which
  -- is what the reversal trigger and the backfill's tie-out both read it as.
  --
  -- `> 0`, never `<> 0`: v_prior_qty is positive by the condition and
  -- v_new_cost is non-negative by the guard, so the only excluded value is
  -- zero -- a free delivery onto uncosted stock -- and journal_lines'
  -- `check (amount_cents <> 0)` would refuse that entry outright and take the
  -- whole delivery down with it.
  if v_reval_cents > 0 then
    perform public.post_journal_entry(
      p_shop_id, public.shop_local_date(), 'Existing stock valued',
      jsonb_build_array(
        jsonb_build_object('code', '1200', 'amount_cents',  v_reval_cents, 'memo', 'Stock already held, now costed'),
        jsonb_build_object('code', '3000', 'amount_cents', -v_reval_cents, 'memo', 'Owner''s stock brought to account')),
      null, 'stock');
  end if;
  -- ── end posting side ────────────────────────────────────────────────────

  return v_receipt_id;
end;
$$;

grant execute on function public.receive_stock(uuid, uuid, jsonb, text, text, text) to authenticated;
