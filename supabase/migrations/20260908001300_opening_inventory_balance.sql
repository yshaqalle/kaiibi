-- The stock that was already on the shelf before the app started recording
-- deliveries -- and the entry that finally puts it into the ledger.
--
-- ===========================================================================
-- THE DEFECT, AS FOUND ON A REAL SHOP
-- ===========================================================================
--
-- backfill_shop_ledger (20260908000700) replays SOURCE ROWS. Every one of its
-- eight kinds starts from a row somebody wrote: a sale, a refund, a delivery, a
-- count, a bill. That is exactly right for everything the shop DID, and it has
-- one hole the size of the shop's whole starting position:
--
--   THERE IS NO SOURCE ROW FOR STOCK THAT WAS ALREADY THERE.
--
-- A product created with `stock: 40` writes products.stock and, through
-- product_opening_stock (20260810000000), one product_location_stock row. A CSV
-- import does the same, forty times. Neither writes a stock_receipts row,
-- because nothing was received -- the shopkeeper was describing what was
-- already on the shelf. So the replay records that stock LEAVING, in COGS and
-- in shrinkage, and has no record of it ever ARRIVING.
--
-- On the real `yusefshop`, after its 54 entries posted and every tie-out in
-- verify-backfill.sql reconciled to the cent:
--
--     Cr 1200 from COGS         234.00
--     Cr 1200 from shrinkage    866.00
--                             --------
--     total credits to 1200    1100.00      trial balance says 1100.00
--     debits to 1200              0.00      <-- nothing ever debited inventory
--
-- 1200 Inventory in CREDIT $1,100: a negative asset on the balance sheet, over
-- books whose trial balance is perfectly zero. Both halves of every entry were
-- right; the opening position was missing. That is why nothing caught it, and
-- it is the failure mode this whole phase keeps circling -- a number that is
-- plausible, internally consistent, and wrong.
--
-- The design called for the fix and the plan omitted it.
-- docs/superpowers/specs/2026-08-22-accounting-standards-design.md, Risks:
-- phase 2b "replays every existing sale, refund, bill, payment, pay run and
-- stock receipt into journal entries, THEN POSTS ONE OPENING-BALANCE ENTRY PER
-- SHOP".
--
-- Both accounts were provisioned for it and both were verified before this was
-- written: default_chart_of_accounts() (20260904000100) seeds
-- `3000 Owner's Capital` for every shop, and journal_entries.source's CHECK
-- already lists 'opening' alongside the thirteen others.
--
--     Dr 1200 Inventory        the stock no delivery accounts for
--     Cr 3000 Owner's Capital  the same
--
-- ===========================================================================
-- THE AMOUNT. THIS IS THE PART THAT HAD TO BE REASONED OUT.
-- ===========================================================================
--
-- Three framings were considered. Only the third survives.
--
-- REJECTED 1: "today's stock at today's cost". Stock on hand now is the
-- RESIDUE of the opening position, not the opening position: the shop has sold
-- and lost stock since, and every one of those movements is ALREADY POSTED by
-- the replay. Debiting 1200 with today's holding on top of them leaves 1200
-- reading (today's stock - everything that ever left), which is too low by the
-- whole of COGS and shrinkage. On yusefshop it would leave 1200 at
-- (stock - 1100.00) -- still negative for any shop that has sold more than it
-- currently holds, which is most shops.
--
-- REJECTED 2: "reconstruct the opening QUANTITY per product, then value it".
-- Opening units = units held today + units sold + units lost - units received
-- - units found. Attractive, and not reconstructible:
--   * a stock_loss EXPENSE carries an amount and no quantity at all, so units
--     lost is simply unavailable for the shop whose shrinkage was logged that
--     way -- which is yusefshop's 866.00;
--   * a CSV re-import or a product-form edit SETS stock and leaves no trace of
--     what it overwrote;
--   * a transfer moves units between locations with no cost record of its own.
-- Any reconstruction is therefore a guess dressed as arithmetic, and it would
-- be valued at TODAY's weighted average while the movements it is undoing were
-- posted at the costs FROZEN on their rows. The two disagree by exactly the
-- amount every re-costing has moved since, and the residue lands in 1200 --
-- which is the thing this entry exists to make true.
--
-- CHOSEN: THE AMOUNT THAT MAKES 1200 TELL THE TRUTH.
--
--   opening = (value of stock actually on hand)
--             - (everything the ledger has already put through 1200)
--
-- Read the second term as "every 1200 line the shop will hold once this run
-- finishes" -- the lines that were already there, plus the ones the eight
-- replays just wrote. Then by construction:
--
--   1200 after = already-there + just-written + opening
--              = already-there + just-written
--                + on-hand - already-there - just-written
--              = on-hand.
--
-- That is the whole derivation, and it is why this framing is not one candidate
-- among several: it is the only one whose result is GUARANTEED to leave the
-- balance sheet stating the stock the shop actually has. The other two land
-- near it and the difference is invisible.
--
-- Four consequences worth stating out loud, because each is a requirement
-- somebody would otherwise have to add separately:
--
--   * A SHOP WHOSE STOCK REALLY DID COME THROUGH receive_stock CANNOT BE
--     DOUBLE-COUNTED. Its deliveries already debited 1200; under a moving
--     weighted average the running total of 1200 IS quantity x average cost, so
--     on-hand minus the ledger is zero and NOTHING IS POSTED. The no-double-count
--     rule is not a special case here, it is arithmetic.
--   * A SHOP WITH NO STOCK AND NO HISTORY gets zero, and zero posts nothing --
--     which it must, because journal_lines carries check (amount_cents <> 0)
--     and a two-line entry of zeroes cannot be written at all.
--   * THE SIGN IS NOT FORCED POSITIVE. A shop that logged inventory_purchase
--     expenses for goods it no longer holds, or whose shelf was re-imported
--     downwards, has a ledger claiming more stock than exists; the correction is
--     Cr 1200 / Dr 3000, and it is posted. An opening entry that only ever ran
--     one way -- a greatest(0, ...) clamp, which is the tempting shape because
--     "an opening balance cannot be negative" sounds obviously true -- would
--     leave exactly half of the shops with a 1200 that lies, and the half it
--     abandoned is the one whose books OVERSTATE an asset, which is the more
--     dangerous direction of the two.
--
--     AND THE COUNTERPART IS STILL 3000, not 5100 Inventory Shrinkage, which
--     was the other candidate and is the more obvious reading of "the books
--     have stock the shelf does not". Rejected for two reasons. An opening
--     entry is a BALANCE SHEET entry by definition -- it states the position
--     the books start from -- and 5100 sits in cost of sales, so the shrinkage
--     reading would put a loss into the P&L of the shop's very first month,
--     back-dated, for stock that was mostly lost later than that. And it would
--     make one entry mean two different things depending on its sign, which is
--     how an entry becomes impossible to explain to the person whose capital
--     account it moved. A shop whose negative gap really is shrinkage has a
--     better instrument already: record a stock count. That posts Dr 5100 /
--     Cr 1200 with a date and a reason -- and the opening balance then computes
--     to zero, because the plug only ever picks up what nothing else recorded.
--   * IT IS A PLUG, AND A PLUG ABSORBS ERROR. If the replay's COGS were wrong,
--     this entry would silently make 1200 right and push the difference into
--     capital. That is accepted, for the reason every conversion accepts it:
--     opening capital IS the plug in a real set of opening balances (assets
--     less liabilities), the alternative is a knowingly wrong balance sheet,
--     and the replay's COGS is pinned independently by verify-backfill.sql's
--     3a-3i against the source rows. What this must never do is HIDE the plug,
--     which is why it is one named entry against Owner's Capital rather than a
--     quiet adjustment folded into a replayed entry.
--
-- ---------------------------------------------------------------------------
-- "VALUE OF STOCK ACTUALLY ON HAND" -- AND WHAT AN UNCOSTED PRODUCT CONTRIBUTES
-- ---------------------------------------------------------------------------
--
--   sum(products.stock * products.cost_cents) where cost_cents is not null
--
-- products.cost_cents is a WEIGHTED AVERAGE since 20260907000000, which is
-- what makes `quantity x cost` the right valuation rather than an approximation
-- of one: a moving average is defined so that quantity x average equals the
-- running total of what was paid, which is precisely what a delivery debits
-- into 1200. FIFO layers would need the layers; the average needs two columns.
--
-- products.stock, not product_location_stock, even though the location table is
-- the finer one. products.stock is the rollup the app itself shows everywhere,
-- it is maintained from the location rows by product_stock_is_derived, and it
-- survives the one case the location rows do not: product_opening_stock returns
-- early for a shop that has no location yet, leaving products.stock set and no
-- location row at all. Valuing from the location table would silently value
-- that shop's whole stock at nothing.
--
-- AN UNCOSTED PRODUCT CONTRIBUTES NOTHING, AND NOTHING IS NOT ZERO. The rule
-- holds throughout this codebase -- isUncosted() in src/lib/product-costing.ts,
-- costOfGoodsSold() in sales-reporting.ts, and every `unit_cost_cents is not
-- null` in the replay above. But there is a reason here sharper than
-- consistency, and it is the one that decides it:
--
--   NOTHING WILL EVER TAKE AN UNCOSTED PRODUCT BACK OUT OF 1200. A sale of it
--   posts no COGS (its frozen unit_cost_cents is null and the sales statement
--   excludes it); a count variance on it posts nothing; a delivery of it is
--   excluded from the receipt's value. Its whole life is invisible to account
--   1200. So a shop that opened with 50 uncosted units would carry their value
--   in 1200 FOR EVER -- inventory permanently overstated by a figure that can
--   never be worked off, growing every time somebody imports another uncosted
--   line. Valuing them at zero is the only treatment under which 1200 stays
--   equal to the stock it can actually account for.
--
-- Which is not the same as saying the stock is worthless. It is saying the
-- LEDGER has nothing to say about it, which is true, and the place that says so
-- is the Inventory Valuation report's uncosted disclosure -- not a number
-- invented here. In particular NOT price_cents: valuing stock at what the shop
-- hopes to sell it for capitalises unearned profit into an asset, which is the
-- one thing every inventory standard in existence forbids.
--
-- ---------------------------------------------------------------------------
-- THE DATE
-- ---------------------------------------------------------------------------
--
-- THE FIRST DAY OF THE MONTH THE SHOP'S LEDGER BEGINS IN.
--
--   date_trunc('month', least(oldest entry the shop has, oldest entry this run
--                             is about to write))
--
-- Dated TODAY it would be wrong in the way the original defect is wrong. Every
-- balance sheet the shop can draw for any date before today would show 1200
-- negative -- the whole of its trading history, every closed month, every
-- period an accountant might actually look at -- and the figure would only come
-- right at the instant the backfill happened to be run. The replay dates every
-- other entry from its source row precisely so that past months read truly
-- (20260908000700, ## Dates); an opening balance stamped at run time undoes
-- that for the one account this task is about.
--
-- Dated the first day of the FIRST MONTH rather than the day of the first
-- transaction, for two reasons. It is what an opening balance MEANS -- the
-- position the books start from, before the first day's trading, which is the
-- convention every accountant reading these statements will expect. And it is
-- unambiguous where "the same day as the first sale" is not: journal entries
-- carry a DATE and no intra-day ordering, so an opening balance sharing a date
-- with the sale that consumes it is a coin toss about which came first.
--
-- Not the day BEFORE the first entry either, which was the other candidate.
-- That falls into the previous MONTH whenever the shop's first trade was on the
-- 1st, creating an accounting period for a month the shop did not exist in and
-- putting the opening balance in a month with nothing else in it.
--
-- WHAT IF THAT MONTH IS CLOSED, OR LOCKED? It receives the entry, exactly as
-- every other back-dated entry in the replay does, and for the reason
-- 20260908000700 step 2 sets out at length: a per-row gate on open_period_for
-- is what would leave a shop with half a ledger and no way to finish. The
-- oldest month is the one MOST likely to be shut, so this is not a corner case
-- -- and it is not silent either. unposted_ledger_period_exposure reads off
-- unposted_ledger_sources, which now carries an 'opening' row with this date,
-- so the Post History card counts the opening entry among the entries a shut
-- month is about to receive, before the button is pressed, with no change to
-- that function at all.
--
-- The fallback, for a shop with stock and no ledger whatsoever -- a shop that
-- imported a catalogue and has not yet sold anything -- is the current month.
-- Its books begin now because there is nothing earlier for them to begin at.
--
-- ---------------------------------------------------------------------------
-- PER SHOP, NOT PER LOCATION -- AND THIS WAS THE CLOSE ONE
-- ---------------------------------------------------------------------------
--
-- ONE entry, ONE Dr 1200 line, ONE Cr 3000 line, no location on either.
--
-- The case for splitting it per location is real: stock lives in
-- product_location_stock, journal_lines carries location_id, every other
-- statement in the replay stamps the source row's location, and kaiibi reports
-- profit per branch. A per-location split would let each branch's 1200 equal
-- its own shelf.
--
-- It was rejected on three grounds, in increasing order of how much they matter.
--
--   1. NOTHING READS 1200 BY LOCATION. Trial Balance, Journals and the Chart of
--      Accounts are all shop-wide; not one component under
--      src/components/accounting/ledger/ mentions a location. A split would be
--      precision no reader can see, bought at the cost below.
--   2. THE RESIDUE IS NOT ATTRIBUTABLE. The amount is on-hand less what the
--      ledger already moved, and a large part of what the ledger already moved
--      CARRIES NO LOCATION AT ALL: sales.location_id was added by
--      20260809000000 and expenses.location_id by 20260816000000, so every row
--      older than those is null, and an expense can still be entered without
--      one today. Splitting the plug per location means every one of those
--      historical credits falls into a null bucket while today's shelf split is
--      charged to the branches -- so each branch's 1200 comes out overstated by
--      its share of the shop's own history, and a phantom null-location
--      liability holds the difference. Each branch figure would look exact and
--      be wrong.
--   3. TODAY'S SHELF IS NOT THE OPENING SHELF. Even with perfect location data,
--      splitting an OPENING position by where the stock sits TODAY attributes
--      it by an accident of the last transfer. A shop that moved its opening
--      stock from the warehouse to the kiosk last week would be told the kiosk
--      opened with all of it.
--
-- So the entry states the one thing that is actually known -- the shop as a
-- whole opened with this much stock -- and states it without a location, the
-- same way post_journal_entry leaves a manual entry. If per-location inventory
-- reporting is ever built, the honest fix is to give the MOVEMENTS their
-- locations, not to split this plug; a split here would make that work harder
-- by leaving a plausible-looking figure to reconcile against.
--
-- ---------------------------------------------------------------------------
-- IDEMPOTENCY: source = 'opening' IS NOT SUFFICIENT ON ITS OWN
-- ---------------------------------------------------------------------------
--
-- The requirement is that backfill_shop_ledger, which will be re-run, never
-- posts a second opening entry. Two things are checked, and the obvious handle
-- is only one of them.
--
--   * `exists (an entry with source = 'opening' AND A LINE ON 1200)`, not
--     `source = 'opening'` alone. 'opening' is the source for EVERY opening
--     balance, and phase 3 brings the rest of them -- opening cash, opening
--     receivables, opening payables, the whole conversion. The moment one of
--     those exists, a bare `source = 'opening'` test would report that
--     inventory had already been opened when it had not, and the shop would
--     keep its negative 1200 for ever with nothing to say why. Keyed on the
--     ACCOUNT, this stays true when the rest of the conversion arrives.
--   * AND the amount itself, which is self-cancelling. Once the entry is
--     posted, its own Dr 1200 is part of "what the ledger has already put
--     through 1200", so the gap recomputes to zero and a second run has nothing
--     to write even if the marker test were deleted.
--
-- Neither is redundant. The gap alone would fail on DRIFT: re-cost a product
-- and on-hand moves while the ledger does not, so a later run would post a
-- second "opening" entry -- a correction, back-dated into the shop's first
-- month, wearing the name of an opening balance. The marker alone would fail
-- for the reason above. Both, and an opening balance is written exactly once
-- per shop, for ever. (A re-costing does need to reach the ledger; that is
-- inventory revaluation, it is phase 3's, and it is not this entry.)
--
-- ---------------------------------------------------------------------------
-- THE DOOR AND THE RPC STILL AGREE, WHICH IS THIS PHASE'S LOAD-BEARING PROPERTY
-- ---------------------------------------------------------------------------
--
-- unposted_ledger_sources (20260908001100) exists so that the Post History card
-- and the replay cannot disagree about what "unposted" means. The opening entry
-- is something a run WRITES, so it has to appear there -- and it is the one
-- row whose existence depends on an AMOUNT rather than on a source row.
--
-- Which creates the difficulty this file's shape is a response to: the amount
-- is "on-hand less everything the ledger will hold AFTER the run", and before
-- the run that includes lines nobody has written yet. The door cannot see them.
--
-- Resolved by ONE definition called from BOTH sides, never two:
--
--   opening_inventory_gap(shop) = on-hand
--                               - 1200 lines that exist
--                               - 1200 lines the replay is ABOUT TO write
--
-- The third term is computed over unposted_ledger_source_rows, so it inherits
-- the eight per-kind predicates rather than copying them. Called by the door
-- BEFORE a run, all three terms are live. Called by the replay AFTER its lines
-- are in, the third term is EMPTY BY CONSTRUCTION -- every source row now
-- carries a journal_entry_id -- and its value has simply moved into the second.
-- Same function, same number, two moments. verify-backfill.sql asserts the two
-- against each other to the cent, so a drift in the prediction reddens a check
-- rather than quietly making the door's promise false.
--
-- The view is therefore split in two: unposted_ledger_source_rows holds the
-- eight arms exactly as 20260908001100 wrote them, and unposted_ledger_sources
-- becomes that plus the opening arm. A view cannot reference itself, and the
-- opening arm needs both the other arms' dates and their inventory movement --
-- so the layer is what lets the eight predicates stay written once.

-- ---------------------------------------------------------------------------
-- 1. The eight source arms, unchanged, under their own name
-- ---------------------------------------------------------------------------
--
-- Character for character what 20260908001100 defined, moved down one layer so
-- the opening arm can read it. Read that migration's header for why each of the
-- eight predicates is a trap; nothing about them has changed here.
create or replace view public.unposted_ledger_source_rows
with (security_invoker = true) as

  select s.shop_id,
         'sale'::text as source_kind,
         s.id         as source_id,
         public.shop_local_date(s.created_at) as on_date
    from public.sales s
   where s.journal_entry_id is null
     and (coalesce(s.tax_cents, 0) <> 0
          or coalesce(s.discount_cents, 0) <> 0
          or coalesce(s.points_redeemed_cents, 0) <> 0
          or s.total_cents <> coalesce((select sum(sp.amount_cents)
                                          from public.sale_payments sp
                                         where sp.sale_id = s.id and not sp.is_settlement), 0)
          or exists (select 1 from public.sale_payments sp
                      where sp.sale_id = s.id and not sp.is_settlement and sp.amount_cents <> 0)
          or coalesce((select sum(si.unit_price_cents::bigint * si.quantity)
                         from public.sale_items si where si.sale_id = s.id), 0) <> 0
          or coalesce((select sum(si.discount_cents)
                         from public.sale_items si where si.sale_id = s.id), 0) <> 0
          or coalesce((select sum(si.unit_cost_cents::bigint * si.quantity)
                         from public.sale_items si
                        where si.sale_id = s.id and si.unit_cost_cents is not null), 0) <> 0)

  union all

  select s.shop_id, 'refund'::text, r.id, public.shop_local_date(r.created_at)
    from public.refunds r
    join public.sales s on s.id = r.sale_id
   where r.journal_entry_id is null
     and (r.goods_cents <> 0 or r.total_cents <> 0
          or exists (select 1 from public.refund_items ri
                       join public.sale_items si on si.id = ri.sale_item_id
                      where ri.refund_id = r.id and si.unit_cost_cents is not null))

  union all

  select s.shop_id, 'settlement'::text, sp.id, public.shop_local_date(sp.created_at)
    from public.sale_payments sp
    join public.sales s on s.id = sp.sale_id
   where sp.is_settlement
     and sp.journal_entry_id is null
     and sp.amount_cents <> 0

  union all

  select r.shop_id, 'receipt'::text, r.id, public.shop_local_date(r.created_at)
    from public.stock_receipts r
   where r.journal_entry_id is null
     and coalesce((select sum(ri.unit_cost_cents::bigint * ri.quantity)
                     from public.stock_receipt_items ri
                    where ri.receipt_id = r.id and ri.unit_cost_cents is not null), 0) <> 0

  union all

  select c.shop_id, 'count'::text, c.id, public.shop_local_date(c.created_at)
    from public.stock_counts c
   where c.journal_entry_id is null
     and coalesce((select sum(ci.unit_cost_cents::bigint * (ci.counted_quantity - ci.previous_quantity))
                     from public.stock_count_items ci
                    where ci.count_id = c.id and ci.unit_cost_cents is not null), 0) <> 0

  union all

  select i.shop_id, 'invoice_payment'::text, ip.id, ip.paid_on
    from public.invoice_payments ip
    join public.invoices i on i.id = ip.invoice_id
   where ip.journal_entry_id is null and ip.amount_cents <> 0

  union all

  select r.shop_id, 'payroll'::text, r.id,
         public.shop_local_date(coalesce(r.posted_at, r.period_end::timestamptz))
    from public.payroll_runs r
   where r.journal_entry_id is null
     and r.status = 'posted' and r.total_cents > 0

  union all

  select e.shop_id, 'expense'::text, e.id, e.occurred_on
    from public.expenses e
   where e.journal_entry_id is null
     and e.payroll_run_id is null
     and e.stock_count_id is null
     and not (e.invoice_id is not null and e.category = 'inventory_purchase')
     and e.amount_cents <> 0;

comment on view public.unposted_ledger_source_rows is
  'The eight kinds of source row backfill_shop_ledger replays, with the same per-kind predicates and the same date expressions. Not the whole of what a run writes -- unposted_ledger_sources is this plus the opening balance, and that is what the Post History door reads. This layer exists so the opening arm can read the other eight without a view referencing itself.';

revoke all on public.unposted_ledger_source_rows from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. What the replay is about to move through 1200
-- ---------------------------------------------------------------------------
--
-- The third term of the gap. Five of the eight kinds touch inventory, and the
-- two case expressions in the expense arm are a DELIBERATE character-for-
-- character mirror of the ones in backfill_shop_ledger's expense statement --
-- written as the full branch rather than as the two arms that happen to reach
-- 1200, so a reader can diff them and so a future branch cannot be missed by
-- someone reasoning about which ones "matter".
--
-- Driven off unposted_ledger_source_rows rather than off the base tables, so
-- the eight exclusions -- a payroll-derived expense, a count-derived write-off,
-- an inventory_purchase bill, a zero-valued sale, a draft pay run -- are
-- inherited rather than restated. That is what keeps this from becoming the
-- second copy of a definition.
--
-- AFTER A REPLAY THIS IS ZERO, for every shop, because every row it reads has
-- been given a journal_entry_id. That is not a happy accident, it is the
-- property that lets the door and the replay call the same function at
-- different moments and get the same answer.
create or replace function public.unposted_inventory_movement(p_shop_id uuid)
returns bigint
language sql stable as $$
  select coalesce(sum(x.cents), 0)::bigint from (

    -- Sales: Cr 1200 by the cost FROZEN on the line. An uncosted line moves
    -- nothing, exactly as the replay's `si.unit_cost_cents is not null` does.
    select -coalesce(sum(si.unit_cost_cents::bigint * si.quantity), 0) as cents
      from public.unposted_ledger_source_rows u
      join public.sale_items si on si.sale_id = u.source_id
     where u.shop_id = p_shop_id and u.source_kind = 'sale'
       and si.unit_cost_cents is not null

    union all

    -- Refunds: Dr 1200 by the cost of what came back.
    select coalesce(sum(si.unit_cost_cents::bigint * ri.quantity), 0)
      from public.unposted_ledger_source_rows u
      join public.refund_items ri on ri.refund_id = u.source_id
      join public.sale_items si on si.id = ri.sale_item_id
     where u.shop_id = p_shop_id and u.source_kind = 'refund'
       and si.unit_cost_cents is not null

    union all

    -- Deliveries: Dr 1200 at the delivery's costed value.
    select coalesce(sum(ri.unit_cost_cents::bigint * ri.quantity), 0)
      from public.unposted_ledger_source_rows u
      join public.stock_receipt_items ri on ri.receipt_id = u.source_id
     where u.shop_id = p_shop_id and u.source_kind = 'receipt'
       and ri.unit_cost_cents is not null

    union all

    -- Counts: 1200 by the SIGNED variance -- short credits it, found debits it.
    select coalesce(sum(ci.unit_cost_cents::bigint * (ci.counted_quantity - ci.previous_quantity)), 0)
      from public.unposted_ledger_source_rows u
      join public.stock_count_items ci on ci.count_id = u.source_id
     where u.shop_id = p_shop_id and u.source_kind = 'count'
       and ci.unit_cost_cents is not null

    union all

    -- Expenses: the replay's own four-way branch, both sides, filtered to the
    -- lines that land on 1200. A standalone inventory_purchase debits it
    -- (account_code_for_expense_category maps that category to 1200); a
    -- standalone stock_loss credits it. An invoice-linked or receipt-linked row
    -- reaches 2000 on one side and never 1200 on the other.
    select coalesce(sum(
             (case when (case when e.invoice_id is not null       then public.account_code_for_expense_category(e.category)
                             when e.stock_receipt_id is not null then '2000'
                             when e.category = 'stock_loss'      then '5100'
                             else public.account_code_for_expense_category(e.category)
                        end) = '1200' then e.amount_cents::bigint else 0 end)
           - (case when (case when e.invoice_id is not null then '2000'
                             when e.stock_receipt_id is null and e.category = 'stock_loss' then '1200'
                             else public.account_code_for_payment_method(e.payment_method)
                        end) = '1200' then e.amount_cents::bigint else 0 end)
           ), 0)
      from public.unposted_ledger_source_rows u
      join public.expenses e on e.id = u.source_id
     where u.shop_id = p_shop_id and u.source_kind = 'expense'

  ) x;
$$;

comment on function public.unposted_inventory_movement(uuid) is
  'How much backfill_shop_ledger is about to move through 1200 Inventory, in cents, debits positive. Read over unposted_ledger_source_rows so the eight per-kind exclusions are inherited rather than copied. Zero for every shop once a replay has finished, which is what lets opening_inventory_gap give the same answer before and after.';

revoke all on function public.unposted_inventory_movement(uuid) from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. The gap -- the amount of the opening entry
-- ---------------------------------------------------------------------------
--
-- The whole derivation is in this file's header. In one line: what stock is
-- worth, less what the ledger will say it is worth once the replay finishes.
--
-- Returns 0 -- meaning "post nothing" -- for a shop that has already had one.
-- Keyed on an opening entry WITH A LINE ON 1200, not on source = 'opening'
-- alone, so phase 3's opening cash and opening receivables do not suppress it.
-- See the idempotency section of the header.
--
-- THE LEDGER TERM DOES NOT FILTER archived_at. A line posted to 1200 moved the
-- shop's inventory whether or not somebody archived the account afterwards, and
-- excluding it would make the gap jump by the whole of that account's history
-- the moment it was archived. This is the one place in the phase that reads
-- accounts WITHOUT the archived filter, and it is deliberate: the line
-- statements are asking "may I post here", this is asking "what has been
-- posted".
create or replace function public.opening_inventory_gap(p_shop_id uuid)
returns bigint
language sql stable as $$
  select case when exists (
           select 1 from public.journal_entries e
             join public.journal_lines l on l.entry_id = e.id
             join public.accounts a on a.id = l.account_id
            where e.shop_id = p_shop_id and e.source = 'opening' and a.code = '1200')
         then 0::bigint
         else
           -- What the shop actually holds, at weighted-average cost. An
           -- uncosted product contributes nothing -- see the header: nothing
           -- will ever take it back OUT of 1200 either.
           coalesce((select sum(p.stock::bigint * p.cost_cents)
                       from public.products p
                      where p.shop_id = p_shop_id and p.cost_cents is not null), 0)
           -- ...less what the ledger already holds against 1200...
           - coalesce((select sum(l.amount_cents)
                         from public.journal_lines l
                         join public.journal_entries e on e.id = l.entry_id
                         join public.accounts a on a.id = l.account_id
                        where e.shop_id = p_shop_id and a.code = '1200'), 0)
           -- ...less what the replay is about to add to it. Zero after a run.
           - public.unposted_inventory_movement(p_shop_id)
         end;
$$;

comment on function public.opening_inventory_gap(uuid) is
  'The opening inventory balance a shop still needs, in cents: the value of stock on hand less everything the ledger will have put through 1200 once backfill_shop_ledger finishes. Positive debits 1200 against 3000 Owner''s Capital; negative credits it; zero posts nothing. Zero also for a shop that already has an opening entry carrying a 1200 line, which is what makes the replay idempotent. Called by the Post History door before a run and by the replay after its other lines are in -- the same number at both moments, because the "about to add" term empties as the replay writes.';

revoke all on function public.opening_inventory_gap(uuid) from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. The date the opening entry carries
-- ---------------------------------------------------------------------------
--
-- The first day of the month the shop's ledger begins in -- see the header for
-- why not today, why not the day of the first trade, and why not the day
-- before it.
--
-- least() over two sources because the answer has to be the same before and
-- after the replay: BEFORE, the oldest thing is a source row waiting to be
-- posted; AFTER, that same row is an entry and the second term is empty. LEAST
-- ignores nulls, so each side simply drops out when it has nothing.
create or replace function public.opening_inventory_date(p_shop_id uuid)
returns date
language sql stable as $$
  select date_trunc('month', coalesce(
           least(
             (select min(e.entry_date) from public.journal_entries e
               where e.shop_id = p_shop_id),
             (select min(u.on_date) from public.unposted_ledger_source_rows u
               where u.shop_id = p_shop_id)),
           -- A shop with stock and no ledger at all: a catalogue imported,
           -- nothing sold yet. Its books begin now because there is nothing
           -- earlier for them to begin at.
           public.shop_local_date()))::date;
$$;

comment on function public.opening_inventory_date(uuid) is
  'The date backfill_shop_ledger gives a shop''s opening balance: the first day of the month its ledger begins in, taken across both the entries it already has and the source rows about to become entries, falling back to the current month for a shop with neither. Never the day of the run -- an opening balance stamped today leaves every past balance sheet showing the negative inventory this entry exists to remove.';

revoke all on function public.opening_inventory_date(uuid) from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5. The door's view: the eight arms, plus the opening balance
-- ---------------------------------------------------------------------------
--
-- One row per ENTRY a run will write, which is what the Post History card
-- counts and what verify-backfill.sql pins against the replay's return value in
-- both directions.
--
-- The opening arm carries the SHOP'S OWN ID as source_id. There is no source
-- row -- that is the entire point of this entry -- and the shop is the thing it
-- is about. It is also unique per shop, which keeps the row countable and
-- distinguishable like every other.
--
-- No `not exists (an opening entry)` clause here: opening_inventory_gap already
-- returns 0 in that case, and putting the test in one place is what stops the
-- door and the replay drifting apart on the question of whether a shop has been
-- opened.
create or replace view public.unposted_ledger_sources
with (security_invoker = true) as
  select u.shop_id, u.source_kind, u.source_id, u.on_date
    from public.unposted_ledger_source_rows u

  union all

  select s.id, 'opening'::text, s.id, public.opening_inventory_date(s.id)
    from public.shops s
   where public.opening_inventory_gap(s.id) <> 0;

comment on view public.unposted_ledger_sources is
  'One row per journal entry backfill_shop_ledger would write: the eight kinds of source row it replays, plus the shop''s opening inventory balance where one is still needed. Read-only, and the single definition of "unposted" that the Post History door and the replay share. verify-backfill.sql pins the two together: before a replay this view''s row count equals what backfill_shop_ledger returns, and after it the view is empty.';

revoke all on public.unposted_ledger_sources from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 6. The counts function, now with a ninth kind
-- ---------------------------------------------------------------------------
--
-- Recreated only to add ('opening', 9) to the list of kinds it always returns.
-- The reason it enumerates them rather than reading distinct values out of the
-- view is unchanged and is why this had to be edited at all: "we looked and
-- found none" and "we did not look" must not render the same, so a kind with
-- nothing waiting still gets a row reading 0.
--
-- LAST in the ordering, not first, although the entry it describes is dated
-- earliest. The card is read top-down by someone deciding whether to press, and
-- the eight replays are the bulk of what happens; the opening balance is one
-- entry and one sentence, and it reads as the closing statement of the list
-- rather than as a preamble to it.
create or replace function public.unposted_ledger_counts(p_shop_id uuid)
returns table (kind text, rows_unposted bigint, oldest_on date)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.has_shop_permission(p_shop_id, 'ledger.close') then
    raise exception 'Seeing what is waiting to be posted needs ledger.close.' using errcode = 'P0001';
  end if;

  return query
  with mine as (
    select s.source_kind, s.source_id, s.on_date
      from public.unposted_ledger_sources s
     where s.shop_id = p_shop_id
  )
  select k.k, count(m.source_id)::bigint, min(m.on_date)
    from (values ('sale', 1), ('refund', 2), ('settlement', 3), ('receipt', 4),
                 ('count', 5), ('invoice_payment', 6), ('payroll', 7), ('expense', 8),
                 ('opening', 9)) as k(k, ord)
    left join mine m on m.source_kind = k.k
   group by k.k, k.ord
   order by k.ord;
end;
$$;

comment on function public.unposted_ledger_counts(uuid) is
  'How many entries of each kind backfill_shop_ledger would write, and how far back the oldest reaches. Read-only; writes nothing and takes no lock. Always returns all nine kinds -- the eight replayed sources and the opening inventory balance -- zeroes included. Gates on ledger.close, the same permission the replay itself requires.';

grant execute on function public.unposted_ledger_counts(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 7. The replay, reproduced in full, with the opening balance at the end
-- ---------------------------------------------------------------------------
--
-- Reproduced in full because that is this repo's convention for a plpgsql
-- function: the newest migration holds the whole body, so a reader never has to
-- assemble one from a chain of patches. supabase/tests/accumulated-rpc-edits.
-- test.ts pins every edit ever made to it against exactly this hazard.
--
-- TWO CHANGES from 20260908000700, and nothing else:
--
--   A. THE EARLY `if v_written = 0 then return 0` IS GONE, and it had to go.
--      It was an optimisation -- every statement after it is naturally a no-op
--      over an empty _bf_map -- but it now skips the one thing that does NOT
--      come from a source row. The shop this whole task was found on is exactly
--      the case: yusefshop has already been backfilled, has nothing left
--      unposted, and needs an opening balance. With the early return it would
--      never get one, and re-running the replay -- which is what an owner will
--      do -- would go on answering 0 for ever while 1200 stayed in credit.
--   B. STEP 6b posts the opening entry, after every other line is written, for
--      the reason the header gives: only then is "what the ledger holds against
--      1200" complete, and only then does opening_inventory_gap return the
--      number the door promised before the run.

-- Replay every existing row into the ledger, so the books describe the shop's
-- whole life rather than only the period since phase 2b shipped.
--
-- ## Why this does not call post_journal_entry
--
-- Two structural reasons, not a preference:
--
--   1. open_period_for RAISES on a closed or locked month. A shop that closed a
--      period during phase 1 would abort the replay part-way, leaving the books
--      in a state strictly worse than not having started -- half a year of
--      history posted, the rest not, and no way to tell which half from the
--      ledger. The backfill therefore creates every period it needs UP FRONT
--      and never consults open_period_for.
--   2. open_period_for opens periods one at a time, on first use. Fine for the
--      interactive path it was written for; wasteful across three years of
--      history, where the whole set is known before the first entry is written.
--
-- The deferred balance trigger on journal_lines still runs -- it is a
-- constraint trigger on the table, not something post_journal_entry installs --
-- so the guarantee that every entry sums to zero is unchanged. Only the
-- convenience wrapper is skipped, and THIS IS THE ONLY THING IN THE CODEBASE
-- THAT SKIPS IT.
--
-- The wrapper does one other thing the trigger does not, and skipping it was a
-- real loss rather than a convenience: it RAISES 'No such account: 4200' for a
-- code the shop's chart does not have. That check is reproduced here by
-- backfill_missing_account, called from the line statements, for the reasons
-- written at that function.
--
-- ## References come from journal_entry_sequences, not from count(*)
--
-- 20260908000150 replaced post_journal_entry's `count(*) + 1` with an atomic
-- per-shop-per-year counter, because the count raced the
-- `unique (shop_id, reference)` index and failed concurrent sales. A backfill
-- that invented its own numbering -- a second series, a 'R'/'E' prefix, a
-- restart at 1 -- would collide with every reference the live path has already
-- allocated for that year, and the collision would surface as a unique
-- violation on whichever side ran second.
--
-- So this reads from the SAME counter, in the same one-statement
-- read-and-increment. The only difference is that it reserves a BLOCK of n
-- numbers instead of one:
--
--   ... do update set next_number = next_number + n returning next_number - n
--
-- which takes the same row lock, leaves the counter holding the number the next
-- caller gets, and hands this run a contiguous range nobody else can be inside.
-- One statement per year, not one per entry -- which is what makes the replay
-- linear instead of quadratic. The opening entry in step 6b takes its number
-- from the same counter, one at a time, because there is only ever one of it.
--
-- ## Backfilled entries carry their TRUE source
--
-- 'sale', 'refund', 'settlement', 'stock', 'count', 'payment', 'payroll',
-- 'bill' -- never a 'backfill' marker. A P&L must not care whether an entry was
-- posted live or replayed, and any report filtering on source would silently
-- drop replayed history. ('backfill' is not a permitted value anyway:
-- journal_entries.source's CHECK lists exactly manual, sale, refund,
-- settlement, bill, payment, payroll, stock, count, transfer, asset,
-- depreciation, close, opening.) The opening balance is 'opening', which is the
-- one value in that list this function did not previously use.
--
-- ## Idempotency
--
-- Driven entirely by journal_entry_id being null on the source row. Re-running
-- writes nothing and returns 0. This matters more than it sounds: the first run
-- of a real backfill always finds something the verification disagrees with,
-- and the fix is to correct the mapping and run it again. The opening balance
-- has no source row and therefore no pointer; it is guarded twice instead, and
-- both guards live inside opening_inventory_gap -- see this migration's header.
--
-- ## THE FOUR WAYS THIS DOUBLE-COUNTS, AND WHAT STOPS EACH
--
-- 1. EXPENSES MIRRORING SOMETHING ALREADY POSTED. post_payroll_run writes BOTH
--    a journal entry AND an expenses row carrying payroll_run_id. The Count
--    sheet writes a stock_loss row carrying stock_count_id on top of a
--    save_stock_count that already posted Dr 5100 / Cr 1200. Replaying either
--    would count 6200 Salaries and Wages or the shop's whole shrinkage TWICE --
--    with the trial balance still zero, because both entries individually
--    balance, so nothing else would catch it. And an inventory_purchase BILL
--    would recognise goods receive_stock already put into 1200 against 2000.
--    The expense replay below applies exactly the exclusions
--    post_expense_to_ledger() applies (20260908000750, extended by
--    20260908000800), for exactly their reasons -- and takes the same branch it
--    takes for the rows it does replay.
--
--    A BILL'S MIRROR ROW IS NOT ONE OF THEM, whatever the exclusion here used
--    to say. Nothing on this branch posts when an invoice is inserted, so the
--    row being skipped was the only place the cost was ever going to be
--    recognised; skipping it left the replay reproducing the live defect
--    exactly -- Accounts Payable driven negative by every non-stock bill in the
--    shop's history, with the trial balance ties all green.
--
-- 2. sale_payments.journal_entry_id IS NULL DOES NOT MEAN "UNPOSTED". Only
--    SETTLEMENT rows ever carry their own entry; complete_sale folds the
--    initial payments into the sale's entry and leaves those rows null forever.
--    The settlement replay filters `is_settlement and journal_entry_id is null`
--    -- never journal_entry_id alone, which would post a second entry for every
--    till payment on every sale in the shop's history.
--
-- 3. ANYTHING ALREADY CARRYING A journal_entry_id IS ALREADY POSTED. Every map
--    below is driven by that column being null. This is not an optimisation: a
--    shop is backfilled while Task 7b's expense trigger is live, so the filter
--    is what stops the two paths posting the same row.
--
-- 4. A PRE-TASK-3 SALE THAT WAS LATER REFUNDED OR SETTLED HAS ALREADY HAD A
--    ONE-SIDED ENTRY POSTED AGAINST IT. refund_sale_items credited 1100 and
--    settle_sale_balance cleared it, but the debit that put the receivable
--    there was never posted, because the sale predates posting -- so those
--    shops' 1100 currently reads negative.
--
--    THE FIX IS THE REPLAY ITSELF, and it needs nothing extra. The sale's own
--    entry supplies the missing debit, at the FULL original receivable
--    (total_cents less what the till took), because:
--      * settlement payments are excluded from the till total, so the 1100
--        debit is the receivable as it stood when the sale was rung up -- and
--        the settlement entries that already exist credit it back down;
--      * the receivable is NOT reduced by refunds, because the refund entry
--        that already exists has already credited 1100 by its own share.
--    Getting either of those wrong -- netting settlements or refunds into the
--    sale line -- would leave 1100 permanently understated by exactly the
--    amount the existing entries already moved. A sale is replayed on its own
--    terms; what happened to it afterwards was posted at the time.
--
--    THE SAME SHAPE OF HOLE EXISTS ON 1200, and the replay alone does NOT fix
--    that one, which is what this migration is for. There is no source row to
--    supply the missing debit, because the stock was never received -- it was
--    typed into a product form. Step 6b supplies it.
--
-- ## Dates
--
-- Every entry is dated from its SOURCE ROW, never from the run. A replay that
-- stamped everything today would put three years of trading into this month and
-- leave every past period empty.
--
-- Where the source carries a timestamptz, the date is public.shop_local_date()
-- of it -- the same expression the live path evaluates, applied at the moment
-- the live path would have evaluated it. Never a bare ::date, which resolves in
-- the session's timezone (UTC on Supabase) while every market kaiibi serves is
-- UTC+3, so a sale at 01:30 local on the 1st would land in the previous month.
-- Where the source carries a plain `date` (expenses.occurred_on,
-- invoice_payments.paid_on) it is used as-is: there is no moment in time to
-- resolve, and wrapping it would be a no-op cast through a function that
-- expects a timestamptz.
--
-- THE ONE DATE THAT HAD TO BE DECIDED. A pay run's live entry is dated
-- shop_local_date() -- the day it was POSTED -- while the expenses row it
-- writes alongside is dated period_end. 20260908000500 names the divergence and
-- leaves it to this task. The replay uses shop_local_date(posted_at): that IS
-- what the live path wrote, evaluated at the true moment rather than at replay
-- time, so a replayed pay run and a live one land on the same day. period_end
-- was rejected because it would put the replay in a different month from every
-- pay run posted since phase 2b shipped, making "wages by month" depend on when
-- the shop was backfilled. The expense row's period_end date never reaches the
-- ledger at all, because that row is excluded (see 1 above), so there is no
-- second date to reconcile.
--
-- THE SECOND DATE THAT HAD TO BE DECIDED is the opening balance's, and it is
-- the only entry here that has no source row to take one from. It is the first
-- day of the month the shop's ledger begins in -- opening_inventory_date() --
-- for the reasons set out at length in this migration's header.
--
-- ## What this does NOT redirect
--
-- Task 3b's complete_sale and Task 7b's expense trigger redirect a row whose
-- month has closed into the open one. This does not: it inserts periods
-- directly and leaves them open, and a month that a shop CLOSED during phase 1
-- is closed over a ledger that did not yet contain this history -- so re-dating
-- into it is the honest treatment, not a violation of the close. The
-- consequence for the tie-out is stated in verify-backfill.sql: an expense
-- total must be compared shop-wide, not per month, because the live trigger's
-- redirect and this replay legitimately put a back-dated expense in different
-- months.

-- ── The one thing that must never be silent ─────────────────────────────────
--
-- Every lines statement below LEFT JOINs the chart of accounts and hands the
-- miss to this, instead of inner-joining and letting a missing or archived
-- account quietly DROP the line. An inner join was the original shape and it
-- fails in two ways, one of them invisible:
--
--   * drop one line and the entry no longer balances -- caught, but only at
--     COMMIT, by the deferred trigger, saying "debits and credits differ by
--     2000" with no entry named and no hint that an account was missing;
--   * drop a SELF-BALANCING PAIR -- 5000/1200 on a sale or a refund, 1200/5100
--     on a count -- and the entry still balances, still has two or more lines,
--     still passes step 7's guard, and has silently lost its cost of goods.
--     That is exactly the "looks right" failure this whole task exists to stop.
--
-- post_journal_entry raises 'No such account: 4200. Check the chart of
-- accounts.' for the same case. The replay skips that wrapper, so it has to
-- carry the wrapper's check itself, and it names the SOURCE ROW as well as the
-- code because a replay that stops has to say which row it stopped on.
--
-- Called from inside COALESCE, which does not evaluate its later arguments once
-- one is non-null: the join stays set-based and this runs only for the rows
-- whose account really is missing. VOLATILE (the default) on purpose -- an
-- IMMUTABLE function with constant arguments can be folded at plan time, which
-- would raise for a line that the `amount_cents <> 0` filter was about to throw
-- away.
create or replace function public.backfill_missing_account(p_code text, p_source text)
returns uuid
language plpgsql as $$
begin
  raise exception 'No such account: %. The backfill needs it for %, and the shop''s chart of accounts does not have it (or it is archived). Check the chart of accounts.',
    coalesce(p_code, '<null>'), p_source
    using errcode = 'P0001';
end;
$$;

comment on function public.backfill_missing_account(text, text) is
  'Raises. Never returns. Called from COALESCE in backfill_shop_ledger''s line statements, so a missing or archived account stops the replay by name instead of silently dropping the line -- which, for a self-balancing pair like 5000/1200, would leave an entry that still balances and has silently lost its COGS.';

create or replace function public.backfill_shop_ledger(p_shop_id uuid)
returns integer
language plpgsql security definer set search_path = public as $$
declare
  v_year    text;
  v_count   integer;
  v_first   integer;
  v_written integer := 0;
  v_bad     text;
  -- Step 6b. The opening balance has no source row, so it carries its own id,
  -- its own date and its own amount rather than a _bf_map entry.
  v_open_id    uuid;
  v_open_date  date;
  v_open_cents bigint;
begin
  -- ledger.close, not ledger.post. Rewriting a shop's entire history is the
  -- heaviest thing anyone can do to these books -- heavier than posting one
  -- entry -- and only the Owner role carries it.
  if not public.has_shop_permission(p_shop_id, 'ledger.close') then
    raise exception 'Backfilling the ledger needs ledger.close.' using errcode = 'P0001';
  end if;

  -- ── Serialised per shop, and this is not belt-and-braces ─────────────────
  --
  -- The idempotency argument in this file's header ("driven entirely by
  -- journal_entry_id being null") is a statement about two runs SEPARATED IN
  -- TIME. It says nothing about two runs overlapping, and under READ COMMITTED
  -- two overlapping runs both work:
  --
  --   A snapshots every unposted row into its own _bf_map and starts writing.
  --   B, a moment later, snapshots THE SAME ROWS -- A has committed nothing --
  --   and builds a second complete set of entries with its own ids.
  --   B then blocks on A's row locks at the back-links in step 5, and when A
  --   commits, B RE-EVALUATES its WHERE against the new row versions. Before
  --   this change that WHERE did not mention journal_entry_id at all, so B's
  --   update matched anyway and OVERWROTE A's pointer.
  --
  -- The result is two complete sets of entries; every source row points at B's;
  -- A's are orphaned but posted; and every account in the shop reads double,
  -- with the trial balance still at zero because both sets individually
  -- balance. Nothing in the verification would catch it, because both runs
  -- return a positive count and the ledger self-consistently ties.
  --
  -- Two things close it, and both are wanted. The re-check on each back-link
  -- (`and <table>.journal_entry_id is null`, step 5) makes B's update a no-op
  -- rather than a clobber. This lock stops B from writing the entries at all,
  -- which is what keeps the ledger free of a set of orphans nobody can explain.
  -- Rewriting a shop's whole history is far heavier than posting one pay run,
  -- and post_payroll_run takes exactly this lock for a far smaller race.
  --
  -- IT ALSO COVERS STEP 6b, which needs it at least as much: the opening
  -- balance is derived from what the ledger holds against 1200, so two
  -- overlapping runs reading that sum before either had written would each
  -- compute the same gap and each post it.
  --
  -- Transaction-scoped, so it releases on commit or rollback with nothing to
  -- unlock explicitly. Keyed on the shop, so backfilling one shop never blocks
  -- another. classid 74921, registered in post_payroll_run's ADVISORY LOCK
  -- CLASSID REGISTRY (20260908000500) -- Postgres has one global advisory
  -- keyspace and a collision would make two unrelated features block each other.
  perform pg_advisory_xact_lock(74921, hashtext(p_shop_id::text));

  -- The map from source row to the entry it will get, carried across the three
  -- statements that need it (entries, back-links, lines). The entry id is
  -- generated HERE rather than taken from a RETURNING clause, because
  -- INSERT ... RETURNING cannot return a column it did not insert and the lines
  -- have to be joined back to their source row.
  --
  -- ON COMMIT DROP, so a second call in a later transaction starts clean and a
  -- failed call leaves nothing behind.
  --
  -- DROPPED FIRST, and explicitly qualified. pg_temp is searched BEFORE
  -- search_path whether or not it is listed, so a caller with a raw session
  -- could pre-create their own _bf_map -- carrying a trigger, or a rule -- and
  -- this SECURITY DEFINER function would write to it and fire that trigger as
  -- the definer. Not reachable through PostgREST, which gives no session to
  -- prepare, so this is defence in depth; it is also the only temp table in the
  -- migration set, so it is the only place the question arises. Dropping also
  -- removes the `_bf_map already exists, skipping` notice a second call in the
  -- same transaction used to print.
  -- to_regclass rather than `drop table if exists`, only so the first call in a
  -- session does not print `schema "pg_temp" does not exist, skipping` -- the
  -- temp schema is created lazily by the CREATE below.
  if to_regclass('pg_temp._bf_map') is not null then
    execute 'drop table pg_temp._bf_map';
  end if;
  create temporary table _bf_map (
    source_kind text,
    source_id   uuid,
    entry_id    uuid,
    on_date     date,
    location_id uuid,
    description text,
    source      text,
    reference   text
  ) on commit drop;

  -- ── 1. Every unposted row, of every kind ────────────────────────────────

  -- Sales. Dated the shop's local date of created_at, matching complete_sale.
  --
  -- ...AND FILTERED TO SALES THAT CARRY MONEY, which every other kind below has
  -- always been and this one was not. A zero-value sale is legal and reachable:
  -- p_allow_balance (20260831000100) lets a sale be left on account, and a
  -- basket of free samples priced at 0 against a named customer is exactly that
  -- -- item_count > 0, so complete_sale's own guard passes, and total_cents = 0.
  -- Such a sale produces no journal line at all (every amount below is zero and
  -- `amount_cents <> 0` throws them away), leaving a referenced entry with
  -- nothing under it -- and step 7 then aborts THE WHOLE SHOP'S REPLAY with
  -- "could not build a complete entry", over one giveaway from two years ago.
  --
  -- The predicate is the exact disjunction of the six line groups built in step
  -- 6, not a proxy for them, because a false negative here would silently skip a
  -- sale that does carry money:
  --   * a non-settlement payment      -> the tender debits
  --   * total_cents <> what the till took -> the 1100 receivable
  --   * order discount / points / line discount -> the 4200 contra
  --   * list price (unit_price * qty) -> the 4000 credit
  --   * tax_cents                     -> the 2100 credit
  --   * frozen cost                   -> the 5000/1200 pair
  -- At least one non-zero line means at least two, because the six groups are
  -- balanced by construction -- so this is also exactly the condition step 7's
  -- two-line guard tests for.
  --
  -- The same defect exists on the LIVE path and is fixed there too:
  -- complete_sale now skips post_journal_entry entirely when v_lines is empty
  -- (20260908000300), where before it failed the sale at the till with
  -- "A journal entry needs at least two lines; this one has 0."
  insert into _bf_map (source_kind, source_id, entry_id, on_date, location_id, description, source)
  select 'sale', s.id, gen_random_uuid(), public.shop_local_date(s.created_at),
         s.location_id, 'Sale ' || s.id::text, 'sale'
    from public.sales s
   where s.shop_id = p_shop_id and s.journal_entry_id is null
     and (coalesce(s.tax_cents, 0) <> 0
          or coalesce(s.discount_cents, 0) <> 0
          or coalesce(s.points_redeemed_cents, 0) <> 0
          or s.total_cents <> coalesce((select sum(sp.amount_cents)
                                          from public.sale_payments sp
                                         where sp.sale_id = s.id and not sp.is_settlement), 0)
          or exists (select 1 from public.sale_payments sp
                      where sp.sale_id = s.id and not sp.is_settlement and sp.amount_cents <> 0)
          or coalesce((select sum(si.unit_price_cents::bigint * si.quantity)
                         from public.sale_items si where si.sale_id = s.id), 0) <> 0
          or coalesce((select sum(si.discount_cents)
                         from public.sale_items si where si.sale_id = s.id), 0) <> 0
          or coalesce((select sum(si.unit_cost_cents::bigint * si.quantity)
                         from public.sale_items si
                        where si.sale_id = s.id and si.unit_cost_cents is not null), 0) <> 0);

  -- Refunds. refunds has NO shop_id column -- the tenancy comes through the
  -- sale, and so does the location, which is what refund_sale_items stamps.
  insert into _bf_map (source_kind, source_id, entry_id, on_date, location_id, description, source)
  select 'refund', r.id, gen_random_uuid(), public.shop_local_date(r.created_at),
         s.location_id, 'Refund ' || r.id::text || ' on sale ' || s.id::text, 'refund'
    from public.refunds r
    join public.sales s on s.id = r.sale_id
   where s.shop_id = p_shop_id and r.journal_entry_id is null
     and (r.goods_cents <> 0 or r.total_cents <> 0
          or exists (select 1 from public.refund_items ri
                       join public.sale_items si on si.id = ri.sale_item_id
                      where ri.refund_id = r.id and si.unit_cost_cents is not null));

  -- Settlements. `is_settlement` IS THE FILTER, not journal_entry_id alone.
  -- complete_sale folds a sale's initial payments into the sale's own entry and
  -- leaves those rows' journal_entry_id null forever, so driving off the column
  -- by itself would post a second entry for every till payment ever taken.
  --
  -- The location is the SETTLING till's, not the sale's: the money is handed
  -- over days later at whatever till is open, which may be another branch.
  -- 20260908000360 makes exactly this fix on the live path.
  insert into _bf_map (source_kind, source_id, entry_id, on_date, location_id, description, source)
  select 'settlement', sp.id, gen_random_uuid(), public.shop_local_date(sp.created_at),
         coalesce(rs.location_id, s.location_id),
         'Balance settled on sale ' || s.id::text, 'settlement'
    from public.sale_payments sp
    join public.sales s on s.id = sp.sale_id
    left join public.register_sessions rs on rs.id = sp.register_session_id
   where s.shop_id = p_shop_id
     and sp.is_settlement
     and sp.journal_entry_id is null
     and sp.amount_cents <> 0;

  -- Stock receipts, at the delivery's costed value. An uncosted line is
  -- excluded, not zeroed -- the delivery's value is unknown, and posting 0
  -- would understate stock by exactly what nobody wrote down.
  insert into _bf_map (source_kind, source_id, entry_id, on_date, location_id, description, source)
  select 'receipt', r.id, gen_random_uuid(), public.shop_local_date(r.created_at),
         r.location_id, 'Stock received', 'stock'
    from public.stock_receipts r
   where r.shop_id = p_shop_id and r.journal_entry_id is null
     and coalesce((select sum(ri.unit_cost_cents::bigint * ri.quantity)
                     from public.stock_receipt_items ri
                    where ri.receipt_id = r.id and ri.unit_cost_cents is not null), 0) <> 0;

  -- Stock counts, at the net variance. Exactly zero posts nothing: a count that
  -- found what it expected is not an accounting event.
  insert into _bf_map (source_kind, source_id, entry_id, on_date, location_id, description, source)
  select 'count', c.id, gen_random_uuid(), public.shop_local_date(c.created_at),
         c.location_id, 'Stock count variance', 'count'
    from public.stock_counts c
   where c.shop_id = p_shop_id and c.journal_entry_id is null
     and coalesce((select sum(ci.unit_cost_cents::bigint * (ci.counted_quantity - ci.previous_quantity))
                     from public.stock_count_items ci
                    where ci.count_id = c.id and ci.unit_cost_cents is not null), 0) <> 0;

  -- Supplier payments. invoice_payments has NO shop_id -- the tenancy and the
  -- store both come through the invoice. Dated paid_on, which is already a
  -- date: the ledger and the bill's payment history cannot then disagree about
  -- when the money moved.
  insert into _bf_map (source_kind, source_id, entry_id, on_date, location_id, description, source)
  select 'invoice_payment', ip.id, gen_random_uuid(), ip.paid_on,
         i.location_id, 'Supplier paid', 'payment'
    from public.invoice_payments ip
    join public.invoices i on i.id = ip.invoice_id
   where i.shop_id = p_shop_id and ip.journal_entry_id is null and ip.amount_cents <> 0;

  -- Pay runs. POSTED runs only: a draft has not paid anybody, and
  -- unpost_payroll_run clears journal_entry_id when it returns a run to draft,
  -- so a run that was posted and then unposted would otherwise be replayed as
  -- though it had never been undone -- re-recognising wages the shop reversed
  -- on purpose, and orphaning the reversal entry that explains why.
  --
  -- payroll_runs has NO paid_on column. See this file's header for why the date
  -- is shop_local_date(posted_at) and not period_end.
  insert into _bf_map (source_kind, source_id, entry_id, on_date, location_id, description, source)
  select 'payroll', r.id, gen_random_uuid(),
         public.shop_local_date(coalesce(r.posted_at, r.period_end::timestamptz)),
         r.location_id, 'Payroll', 'payroll'
    from public.payroll_runs r
   where r.shop_id = p_shop_id and r.journal_entry_id is null
     and r.status = 'posted' and r.total_cents > 0;

  -- Expenses. THE EXCLUSIONS, copied from post_expense_to_ledger() for its
  -- reasons -- see 1 in this file's header, and the exclusion blocks in
  -- 20260908000750 (which names post_payroll_run by name) and 20260908000800.
  --
  -- stock_count_id: save_stock_count posts Dr 5100 / Cr 1200 for the whole
  -- variance itself and nothing was paid, so a count's stock_loss expense row
  -- has no entry of its own. With the inventory_purchase half of the invoice
  -- clause below, it is one of the two exclusions here that leave a row
  -- permanently unposted by design -- verify-backfill.sql check 5 exempts both
  -- for that reason.
  --
  -- INVOICE-LINKED ROWS ARE NO LONGER EXCLUDED WHOLESALE, and that is the
  -- correction this replay carries alongside 20260908000800's. The old filter
  -- said `e.invoice_id is null` on the strength of "the bill recognised the
  -- cost" -- and no migration on this branch posts anything when an invoice is
  -- inserted, so nothing recognised it and the mirror row being skipped WAS the
  -- recognition. Replayed history reproduced the live defect exactly: a bill
  -- posted nothing, its payment posted Dr 2000, and Accounts Payable went
  -- negative by every non-stock bill the shop had ever entered.
  --
  -- inventory_purchase stays out, for the reason 20260908000800 gives at
  -- length: the delivery already debited 1200 against 2000, and pairing a bill
  -- with a receipt is the app's own unpaid-delivery flow rather than a
  -- double-entry a shop should have avoided.
  --
  -- FORWARD REFERENCE, AND IT IS SAFE. stock_count_id and stock_receipt_id are
  -- added by 20260908000800, which applies AFTER 20260908000700 where this
  -- statement was first written. A plpgsql body is only syntax-checked at
  -- CREATE time -- table and column names are resolved when the statement first
  -- executes -- and backfill_shop_ledger is never called during a migration
  -- run. (By this file both columns exist anyway; the note is kept because the
  -- reasoning is what makes the ordering safe rather than lucky.)
  --
  -- log_recurring_bill's rows set NONE of the four and are deliberately
  -- included: nothing else posts for them, and they are real costs the shop
  -- incurred.
  --
  -- occurred_on, not created_at: a receipt is often logged days after the
  -- purchase and it is the purchase that decides the period. For a bill's
  -- mirror row that is issued_on, which sync_invoice_expense copies across --
  -- a bill dated last month is last month's cost however late it is entered.
  insert into _bf_map (source_kind, source_id, entry_id, on_date, location_id, description, source)
  select 'expense', e.id, gen_random_uuid(), e.occurred_on,
         e.location_id, 'Expense ' || e.id::text, 'bill'
    from public.expenses e
   where e.shop_id = p_shop_id
     and e.journal_entry_id is null
     and e.payroll_run_id is null
     and e.stock_count_id is null
     and not (e.invoice_id is not null and e.category = 'inventory_purchase')
     and e.amount_cents <> 0;

  select count(*) into v_written from _bf_map;

  -- NO EARLY RETURN HERE, AND THE `if v_written = 0 then return 0` THAT USED TO
  -- BE IS THE BUG THIS MIGRATION FIXES HALF OF.
  --
  -- It was only ever an optimisation: every statement from here to step 7
  -- reads _bf_map, so all of them are natural no-ops when it is empty. What it
  -- cost was step 6b, which does NOT read _bf_map -- and a shop whose only
  -- remaining work is its opening balance is not a hypothetical. It is
  -- yusefshop: already backfilled, nothing left unposted, 1200 sitting in
  -- credit $1,100, and an owner who presses the button again and is told
  -- "nothing needed posting" for ever.
  --
  -- The cost of removing it is a dozen statements that match no rows, once, on
  -- a door that is pressed by hand.

  -- ── 2. Every MISSING period the replay needs, created OPEN ──────────────
  --
  -- This is the statement that makes a closed month survivable. Doing it per
  -- row through open_period_for is what would abort the replay half-way.
  --
  -- READ THE CONFLICT CLAUSE BEFORE BELIEVING THE HEADING. This creates the
  -- months that DO NOT EXIST, open. A month that already exists is left exactly
  -- as it is -- and then receives entries anyway, because step 4 inserts
  -- journal_entries directly and never consults open_period_for. A closed month
  -- is NOT re-opened. A LOCKED month -- documented at 20260904000200 as "nothing
  -- posts, ever. Manual, deliberate, final" -- is not re-opened either, and is
  -- posted into all the same, with no closed_at change and no audit row.
  --
  -- That is deliberate and is not being revisited: a per-row gate is precisely
  -- what would leave a shop with half a ledger and no way to finish. What it is
  -- not is invisible. public.unposted_ledger_period_exposure (20260908001100)
  -- counts the shut months a replay would write into, off the same view the
  -- counts come from, and the Post History card names them before the button is
  -- pressed. If you change the semantics here, that function and the copy on
  -- backfill-view.tsx are what stop being true.
  insert into public.accounting_periods (shop_id, starts_on, ends_on)
  select distinct p_shop_id,
         date_trunc('month', m.on_date)::date,
         (date_trunc('month', m.on_date) + interval '1 month - 1 day')::date
    from _bf_map m
  on conflict (shop_id, starts_on) do nothing;

  -- ...and a check that every date is actually covered, because the insert
  -- above is `on conflict (shop_id, starts_on) do nothing` and the conflict
  -- target is starts_on ALONE. A period that already exists for the 1st of a
  -- month with a SHORTER ends_on -- a half-month period from a partial close,
  -- anything not month-shaped -- swallows the insert and leaves no row covering
  -- the back half of that month. journal_entries.period_id is NOT NULL, so the
  -- entry insert in step 4 would then abort with a null-violation naming a
  -- column, which says nothing about periods to whoever has to fix it.
  select string_agg(distinct to_char(m.on_date, 'YYYY-MM-DD'), ', ' order by to_char(m.on_date, 'YYYY-MM-DD'))
    into v_bad
    from _bf_map m
   where not exists (select 1 from public.accounting_periods ap
                      where ap.shop_id = p_shop_id
                        and m.on_date between ap.starts_on and ap.ends_on);
  if v_bad is not null then
    raise exception 'No accounting period covers: %. A period already starts on the 1st of that month but ends before the month does, so the backfill could not create one. Extend or remove that period and run again.', v_bad
      using errcode = 'P0001';
  end if;

  -- ── 3. References, from journal_entry_sequences ─────────────────────────
  --
  -- One reservation per YEAR, not per entry. The upsert takes a row lock on the
  -- counter, so a sale being rung up concurrently blocks here rather than
  -- reading a number this run has already taken.
  for v_year in select distinct to_char(m.on_date, 'YYYY') from _bf_map m order by 1 loop
    select count(*) into v_count from _bf_map m where to_char(m.on_date, 'YYYY') = v_year;

    insert into public.journal_entry_sequences (shop_id, year, next_number)
      values (p_shop_id, v_year, v_count + 1)
      on conflict (shop_id, year) do update
        set next_number = public.journal_entry_sequences.next_number + v_count
      returning next_number - v_count into v_first;

    -- Numbered by date within the year, so the journal reads in the order the
    -- shop actually traded. (kind, id) is the tiebreaker and the key: an id is
    -- unique within a table but two tables can hand out the same uuid in
    -- principle, and the pair is what _bf_map is keyed on everywhere else.
    -- journal_entry_reference, not an inline lpad: 20260908000150 owns the
    -- format, and lpad(n, 4, '0') TRUNCATES past 9999 -- 'JE-2026-1000' for
    -- entry 10000, colliding with entry 1000 on
    -- journal_entries_shop_id_reference_key. A backfill is precisely where a
    -- shop crosses 9999 for the first time, because it writes a year of history
    -- in one statement.
    update _bf_map m
       set reference = public.journal_entry_reference(v_year, (v_first + n.rn - 1)::integer)
      from (select source_kind, source_id,
                   row_number() over (order by on_date, source_kind, source_id) as rn
              from _bf_map where to_char(on_date, 'YYYY') = v_year) n
     where m.source_kind = n.source_kind and m.source_id = n.source_id;
  end loop;

  -- ── 4. The entries ──────────────────────────────────────────────────────
  --
  -- The period lookup is `order by starts_on desc limit 1` rather than a bare
  -- scalar subquery: step 2 only guarantees a month-shaped period exists, and a
  -- scalar subquery that found two overlapping periods would abort the whole
  -- replay with "more than one row returned by a subquery" -- an error about
  -- SQL for a problem about periods.
  insert into public.journal_entries
      (id, shop_id, period_id, entry_date, reference, description, source, status, location_id, created_by)
  select m.entry_id, p_shop_id,
         (select ap.id from public.accounting_periods ap
           where ap.shop_id = p_shop_id and m.on_date between ap.starts_on and ap.ends_on
           order by ap.starts_on desc limit 1),
         m.on_date, m.reference, m.description, m.source, 'posted', m.location_id, auth.uid()
    from _bf_map m;

  -- ── 5. The back-links, which are what make this idempotent ──────────────
  --
  -- EVERY ONE RE-CHECKS `journal_entry_id is null`, and dropping that from any
  -- of the eight re-opens the concurrency hole the advisory lock at the top of
  -- this function describes. Step 1's filter is not enough on its own: it was
  -- evaluated against a snapshot taken before anything else could have written,
  -- and under READ COMMITTED an UPDATE that blocks on another transaction's row
  -- lock re-evaluates its WHERE against the row version that transaction
  -- committed. A WHERE that no longer mentions the column matches anyway and
  -- CLOBBERS the pointer the other run just wrote -- leaving its entries posted
  -- and orphaned, and every account doubled with the trial balance still zero.
  --
  -- With the re-check, the losing update matches nothing and writes nothing.
  -- Belt AND braces, deliberately: the lock is what stops the orphan entries
  -- ever being written, this is what stops the pointer being taken away.
  update public.sales s set journal_entry_id = m.entry_id
    from _bf_map m where m.source_kind = 'sale' and m.source_id = s.id
     and s.journal_entry_id is null;
  update public.refunds r set journal_entry_id = m.entry_id
    from _bf_map m where m.source_kind = 'refund' and m.source_id = r.id
     and r.journal_entry_id is null;
  update public.sale_payments sp set journal_entry_id = m.entry_id
    from _bf_map m where m.source_kind = 'settlement' and m.source_id = sp.id
     and sp.journal_entry_id is null;
  update public.stock_receipts sr set journal_entry_id = m.entry_id
    from _bf_map m where m.source_kind = 'receipt' and m.source_id = sr.id
     and sr.journal_entry_id is null;
  update public.stock_counts sc set journal_entry_id = m.entry_id
    from _bf_map m where m.source_kind = 'count' and m.source_id = sc.id
     and sc.journal_entry_id is null;
  update public.invoice_payments ip set journal_entry_id = m.entry_id
    from _bf_map m where m.source_kind = 'invoice_payment' and m.source_id = ip.id
     and ip.journal_entry_id is null;
  update public.payroll_runs pr set journal_entry_id = m.entry_id
    from _bf_map m where m.source_kind = 'payroll' and m.source_id = pr.id
     and pr.journal_entry_id is null;
  update public.expenses e set journal_entry_id = m.entry_id
    from _bf_map m where m.source_kind = 'expense' and m.source_id = e.id
     and e.journal_entry_id is null;

  -- ── 6. The lines, one statement per kind ────────────────────────────────
  --
  -- Every one is a UNION ALL of the line kinds, filtered to non-zero at the
  -- end. That filter is what lets the COGS pair, the receivable and the
  -- discount line disappear rather than post a zero: journal_lines carries
  -- check (amount_cents <> 0), and a zero line would take the whole replay
  -- down.

  ---------------------------------------------------------------------------
  -- Sales -- 20260908000300's shape exactly.
  ---------------------------------------------------------------------------
  --
  -- THE ADD-BACK IS THE PART THAT IS EASY TO GET WRONG, and getting it wrong is
  -- invisible. complete_sale's item loop computes
  -- `v_line := price_cents * qty - line_discount` and accumulates THAT, so
  -- sale_items.line_total_cents is already NET of the line and promotion
  -- discounts. Revenue is credited at LIST, so the sum of
  -- sale_items.discount_cents has to be added back to it -- and the same figure
  -- has to appear in the 4200 contra, alongside the order discount and the
  -- points redeemed.
  --
  -- Crediting 4000 with a bare sum(line_total_cents) balances perfectly (both
  -- sides move by the same amount) and understates revenue by every promotion
  -- the shop ever ran, leaving 4200 reading zero for a shop whose discounts are
  -- all promotions -- which is the app's main discount mechanism. It also
  -- ties against a check that re-derives revenue from line_total_cents, which
  -- is the same arithmetic twice. verify-backfill.sql asserts 4000 against
  -- unit_price_cents * quantity for exactly that reason.
  --
  -- Balanced by construction, and this is the proof. Writing G for
  -- sum(line_total_cents), I for sum(item discount), D for sales.discount_cents,
  -- R for points_redeemed_cents, T for tax_cents and P for what the till took:
  -- complete_sale computed total = G - D - R + T. The debits are P plus the
  -- receivable (total - P) plus the contra (D + R + I) = total + D + R + I =
  -- G + I + T. The credits are revenue (G + I) plus tax (T). Equal. The COGS
  -- pair is a self-balancing debit and credit of one amount and does not
  -- disturb it.
  with agg as (
    select m.entry_id, m.location_id, m.source_id,
           s.total_cents, s.tax_cents, s.discount_cents, s.points_redeemed_cents,
           -- Settlements EXCLUDED: they arrive later and post their own entry
           -- against 1100. Including them here would shrink the receivable this
           -- sale created by money the settlement entry has already credited
           -- away, and 1100 would end up understated by every settlement ever
           -- taken. See 4 in this file's header.
           coalesce((select sum(sp.amount_cents) from public.sale_payments sp
                      where sp.sale_id = m.source_id and not sp.is_settlement), 0) as till_cents,
           coalesce((select sum(si.line_total_cents) from public.sale_items si
                      where si.sale_id = m.source_id), 0) as net_lines_cents,
           coalesce((select sum(si.discount_cents) from public.sale_items si
                      where si.sale_id = m.source_id), 0) as item_discount_cents,
           -- The cost FROZEN on the line at sale time, never products.cost_cents
           -- -- otherwise a restock rewrites this sale's gross profit and with
           -- it every closed month's. Uncosted lines contribute nothing rather
           -- than zero: a free sample really does cost nothing, an unpriced
           -- product is a question nobody answered.
           coalesce((select sum(si.unit_cost_cents::bigint * si.quantity) from public.sale_items si
                      where si.sale_id = m.source_id and si.unit_cost_cents is not null), 0) as cogs_cents
      from _bf_map m join public.sales s on s.id = m.source_id
     where m.source_kind = 'sale'
  )
  insert into public.journal_lines (entry_id, account_id, amount_cents, location_id, memo)
  select x.entry_id,
         coalesce(a.id, public.backfill_missing_account(x.code, x.src)),
         x.amount_cents, x.location_id, x.memo
    from (
      -- One debit per tender actually used. A single lumped line would make the
      -- drawer and the wallet impossible to reconcile separately, which is most
      -- of what a cash position is for.
      --
      -- ONE LINE PER METHOD, where complete_sale writes one line per PAYMENT
      -- ROW. A sale paid twice in cash gets two lines live and one here. The
      -- per-account totals are identical, which is what every report, the trial
      -- balance and the drawer reconciliation read, so this is a granularity
      -- difference and not a discrepancy -- recorded here so the next reader
      -- does not re-derive it and think one of the two is wrong.
      select m.entry_id, m.location_id, 'sale ' || m.source_id::text as src,
             public.account_code_for_payment_method(sp.method) as code,
             sum(sp.amount_cents)::bigint as amount_cents,
             'Payment by ' || sp.method as memo
        from _bf_map m
        join public.sale_payments sp on sp.sale_id = m.source_id
       where m.source_kind = 'sale' and not sp.is_settlement
       group by m.entry_id, m.location_id, m.source_id, sp.method

      union all
      -- What was left on account. DERIVED -- there is no sale_balances table;
      -- a balance is the sale's total less what the till took.
      select g.entry_id, g.location_id, 'sale ' || g.source_id::text, '1100',
             (g.total_cents - g.till_cents)::bigint, 'Left on account' from agg g

      union all
      select g.entry_id, g.location_id, 'sale ' || g.source_id::text, '4200',
             (g.discount_cents + g.points_redeemed_cents + g.item_discount_cents)::bigint,
             'Discounts and points' from agg g

      union all
      select g.entry_id, g.location_id, 'sale ' || g.source_id::text, '4000',
             -(g.net_lines_cents + g.item_discount_cents)::bigint, 'Sale at list' from agg g

      union all
      select g.entry_id, g.location_id, 'sale ' || g.source_id::text, '2100',
             -g.tax_cents::bigint, 'Sales tax' from agg g

      union all
      select g.entry_id, g.location_id, 'sale ' || g.source_id::text, '5000',
             g.cogs_cents, 'Cost of goods sold' from agg g
      union all
      select g.entry_id, g.location_id, 'sale ' || g.source_id::text, '1200',
             -g.cogs_cents, 'Stock sold' from agg g
    ) x
    left join public.accounts a on a.shop_id = p_shop_id and a.code = x.code and a.archived_at is null
   where x.amount_cents <> 0;

  ---------------------------------------------------------------------------
  -- Refunds -- 20260908000360's shape.
  ---------------------------------------------------------------------------
  --
  --   Dr 4100 Sales Returns       the merchandise coming back, net of tax
  --   Dr 2100 Sales Tax Payable   the tax share coming back
  --   Cr 1000/1010/1020/1021      the cash actually handed over, one line per
  --                               tender it came in on, pro-rated
  --   Cr 1100 Accounts Receivable the rest, which reduces what is still owed
  --   Dr 1200 / Cr 5000           the cost of the goods coming back
  --
  -- 4100, never a negative 4000: a refund that reduced Sales Revenue would make
  -- a month's revenue depend on when the return happened rather than when the
  -- sale did.
  --
  -- goods_cents and total_cents are read from the STORED refund row and never
  -- recomputed. Refunds issued before 20260820000200 used the old gross-based
  -- figure, and recomputing would quietly "correct" a refund the customer
  -- received months ago into something they did not get.
  --
  -- The tender denominator is what had been collected AT THE TIME OF THE REFUND
  -- (`sp.created_at <= r.created_at`), not everything ever collected on the
  -- sale. A settlement taken after the refund was not a tender the refund could
  -- have gone back out of. Either way the lines sum to total_cents exactly --
  -- largest remainder guarantees it -- so the tie-out is unaffected; the split
  -- across tenders is what improves.
  --
  -- ...WHICH IS TRUE ONLY WHILE THAT DENOMINATOR IS NON-ZERO. The live path
  -- cannot reach the empty case -- refund_sale_items computes its cash figure
  -- as `least(goods, collected - already refunded)`, so total_cents > 0
  -- REQUIRES collected > 0 -- but the replay adds `created_at <= r.created_at`
  -- on top, and a payment row whose created_at was back-dated past its own
  -- refund (an import, a repaired timestamp) leaves per_method empty while
  -- total_cents survives. No cash lines are emitted, the entry is short by
  -- exactly total_cents, and the failure arrives at COMMIT as an unbalanced
  -- entry naming nothing. Caught here instead, where the refund can be named.
  select string_agg(r.id::text, ', ' order by r.id::text) into v_bad
    from _bf_map m
    join public.refunds r on r.id = m.source_id
    join public.sales s on s.id = r.sale_id
   where m.source_kind = 'refund'
     and r.total_cents > 0
     and not exists (select 1 from public.sale_payments sp
                      where sp.sale_id = s.id and sp.amount_cents <> 0
                        and sp.created_at <= r.created_at);
  if v_bad is not null then
    raise exception 'These refunds hand cash back but no payment on their sale is dated before them, so the tenders it went out of cannot be reconstructed: %. A payment''s created_at is later than the refund it paid for -- fix the timestamps and run again.', v_bad
      using errcode = 'P0001';
  end if;

  with ref as (
    select m.entry_id, m.location_id, m.source_id, r.created_at as refunded_at,
           r.goods_cents, r.total_cents,
           case when s.total_cents > 0
                then round(r.goods_cents::numeric * coalesce(s.tax_cents, 0) / s.total_cents)::integer
                else 0 end as tax_back,
           coalesce((select sum(si.unit_cost_cents::bigint * ri.quantity)
                       from public.refund_items ri
                       join public.sale_items si on si.id = ri.sale_item_id
                      where ri.refund_id = m.source_id and si.unit_cost_cents is not null), 0) as cogs_back,
           coalesce((select sum(sp.amount_cents) from public.sale_payments sp
                      where sp.sale_id = s.id and sp.created_at <= r.created_at), 0) as collected_cents,
           s.id as sale_id
      from _bf_map m
      join public.refunds r on r.id = m.source_id
      join public.sales s on s.id = r.sale_id
     where m.source_kind = 'refund'
  ),
  -- LARGEST REMAINDER. Every tender gets floor(share) and the cents left over
  -- go one each to the largest fractional parts. Chosen over "give the whole
  -- difference to the biggest method" because every line then lands within a
  -- cent of its exact share and none can come out NEGATIVE -- a negative credit
  -- is a debit, i.e. a refund that puts money INTO a tender. Ties break on the
  -- bigger tender then the method name, so a replay is deterministic.
  per_method as (
    select f.entry_id, f.location_id, f.source_id, sp.method, sum(sp.amount_cents)::numeric as collected,
           f.total_cents, f.collected_cents
      from ref f
      join public.sale_payments sp on sp.sale_id = f.sale_id
     where sp.amount_cents <> 0 and sp.created_at <= f.refunded_at and f.total_cents > 0
     group by f.entry_id, f.location_id, f.source_id, sp.method, f.total_cents, f.collected_cents
  ),
  ranked as (
    select entry_id, location_id, source_id, method, total_cents,
           floor(total_cents::numeric * collected / collected_cents)::integer as base,
           sum(floor(total_cents::numeric * collected / collected_cents)::integer) over (partition by entry_id) as base_total,
           row_number() over (
             partition by entry_id
             order by (total_cents::numeric * collected / collected_cents)
                      - floor(total_cents::numeric * collected / collected_cents) desc,
                      collected desc, method) as rn
      from per_method
  )
  insert into public.journal_lines (entry_id, account_id, amount_cents, location_id, memo)
  select x.entry_id,
         coalesce(a.id, public.backfill_missing_account(x.code, x.src)),
         x.amount_cents, x.location_id, x.memo
    from (
      select f.entry_id, f.location_id, 'refund ' || f.source_id::text as src, '4100' as code,
             (f.goods_cents - f.tax_back)::bigint as amount_cents, 'Goods returned' as memo from ref f
      union all
      select f.entry_id, f.location_id, 'refund ' || f.source_id::text, '2100',
             f.tax_back::bigint, 'Tax on the return' from ref f
      union all
      select k.entry_id, k.location_id, 'refund ' || k.source_id::text,
             public.account_code_for_payment_method(k.method),
             -(k.base + case when k.rn <= k.total_cents - k.base_total then 1 else 0 end)::bigint,
             'Refunded by ' || k.method
        from ranked k
      union all
      -- The generalisation of "cash if it was paid, receivable if it was not".
      -- On a sale paid in full this is zero and omitted; on one nobody has paid,
      -- the cash lines are. An if/else on "is anything still owed" gets the
      -- part-paid sale wrong in both directions.
      select f.entry_id, f.location_id, 'refund ' || f.source_id::text, '1100',
             -(f.goods_cents - f.total_cents)::bigint, 'Reduced what is owed' from ref f
      union all
      select f.entry_id, f.location_id, 'refund ' || f.source_id::text, '1200',
             f.cogs_back, 'Stock returned' from ref f
      union all
      select f.entry_id, f.location_id, 'refund ' || f.source_id::text, '5000',
             -f.cogs_back, 'Cost reversed' from ref f
    ) x
    left join public.accounts a on a.shop_id = p_shop_id and a.code = x.code and a.archived_at is null
   where x.amount_cents <> 0;

  ---------------------------------------------------------------------------
  -- Settlements -- Dr the tender, Cr 1100. NO REVENUE.
  ---------------------------------------------------------------------------
  --
  -- The revenue was recognised when the sale was rung up and the receivable is
  -- what recorded it. Recognising it again when the money arrives is the
  -- classic double-count, and it would show up as a shop whose credit sales
  -- earn twice.
  insert into public.journal_lines (entry_id, account_id, amount_cents, location_id, memo)
  select x.entry_id,
         coalesce(a.id, public.backfill_missing_account(x.code, x.src)),
         x.amount_cents, x.location_id, x.memo
    from (
      select m.entry_id, m.location_id, 'settlement ' || m.source_id::text as src,
             public.account_code_for_payment_method(sp.method) as code,
             sp.amount_cents::bigint as amount_cents, 'Settlement received' as memo
        from _bf_map m join public.sale_payments sp on sp.id = m.source_id
       where m.source_kind = 'settlement'
      union all
      select m.entry_id, m.location_id, 'settlement ' || m.source_id::text, '1100',
             -sp.amount_cents::bigint, 'Cleared from receivables'
        from _bf_map m join public.sale_payments sp on sp.id = m.source_id
       where m.source_kind = 'settlement'
    ) x
    left join public.accounts a on a.shop_id = p_shop_id and a.code = x.code and a.archived_at is null
   where x.amount_cents <> 0;

  ---------------------------------------------------------------------------
  -- Stock receipts -- Dr 1200 Inventory, Cr 2000 Accounts Payable.
  ---------------------------------------------------------------------------
  --
  -- 2000, not cash: receive_stock records goods ARRIVING and says nothing about
  -- whether they were paid for. Paying the supplier is record_invoice_payment,
  -- replayed above, which debits 2000 back down.
  insert into public.journal_lines (entry_id, account_id, amount_cents, location_id, memo)
  select x.entry_id,
         coalesce(a.id, public.backfill_missing_account(x.code, x.src)),
         x.amount_cents, x.location_id, x.memo
    from (
      select m.entry_id, m.location_id, 'receipt ' || m.source_id::text as src, '1200' as code,
             sum(ri.unit_cost_cents::bigint * ri.quantity) as amount_cents,
             'Delivery received' as memo
        from _bf_map m join public.stock_receipt_items ri on ri.receipt_id = m.source_id
       where m.source_kind = 'receipt' and ri.unit_cost_cents is not null
       group by m.entry_id, m.location_id, m.source_id
      union all
      select m.entry_id, m.location_id, 'receipt ' || m.source_id::text, '2000',
             -sum(ri.unit_cost_cents::bigint * ri.quantity), 'Owed to supplier'
        from _bf_map m join public.stock_receipt_items ri on ri.receipt_id = m.source_id
       where m.source_kind = 'receipt' and ri.unit_cost_cents is not null
       group by m.entry_id, m.location_id, m.source_id
    ) x
    left join public.accounts a on a.shop_id = p_shop_id and a.code = x.code and a.archived_at is null
   where x.amount_cents <> 0;

  ---------------------------------------------------------------------------
  -- Stock counts -- 1200 by the variance, 5100 by its negative.
  ---------------------------------------------------------------------------
  --
  -- One signed pair covers both directions, and that is not a shortcut: short
  -- means variance < 0, so 1200 is credited and 5100 debited; found means
  -- variance > 0 and both flip. save_stock_count writes them as two branches
  -- purely so each has its own memo, which is reproduced here by a case.
  --
  -- 5100 sits in COST OF SALES, above gross profit -- not in operating
  -- expenses, where the Count door's stock_loss expense lands. A unit that is
  -- stolen or breaks is never sold, so its cost enters COGS by no other path
  -- and gross profit reads high by exactly that amount, every month, invisibly.
  insert into public.journal_lines (entry_id, account_id, amount_cents, location_id, memo)
  select x.entry_id,
         coalesce(a.id, public.backfill_missing_account(x.code, x.src)),
         x.amount_cents, x.location_id, x.memo
    from (
      select v.entry_id, v.location_id, 'count ' || v.source_id::text as src,
             '1200' as code, v.variance_cents as amount_cents,
             case when v.variance_cents < 0 then 'Written off' else 'Stock found' end as memo
        from (
          select m.entry_id, m.location_id, m.source_id,
                 sum(ci.unit_cost_cents::bigint * (ci.counted_quantity - ci.previous_quantity)) as variance_cents
            from _bf_map m join public.stock_count_items ci on ci.count_id = m.source_id
           where m.source_kind = 'count' and ci.unit_cost_cents is not null
           group by m.entry_id, m.location_id, m.source_id) v
      union all
      select v.entry_id, v.location_id, 'count ' || v.source_id::text, '5100', -v.variance_cents,
             case when v.variance_cents < 0 then 'Stock short' else 'Shrinkage reversed' end
        from (
          select m.entry_id, m.location_id, m.source_id,
                 sum(ci.unit_cost_cents::bigint * (ci.counted_quantity - ci.previous_quantity)) as variance_cents
            from _bf_map m join public.stock_count_items ci on ci.count_id = m.source_id
           where m.source_kind = 'count' and ci.unit_cost_cents is not null
           group by m.entry_id, m.location_id, m.source_id) v
    ) x
    left join public.accounts a on a.shop_id = p_shop_id and a.code = x.code and a.archived_at is null
   where x.amount_cents <> 0;

  ---------------------------------------------------------------------------
  -- Supplier payments -- Dr 2000 Accounts Payable, Cr the wallet.
  ---------------------------------------------------------------------------
  --
  -- NO expense line. The cost was recognised when the bill arrived -- by the
  -- bill's own mirror row, Dr the category's account / Cr 2000, replayed above.
  -- This statement moves money against the liability that recognition created.
  -- Posting 6xxx again here would double every cost the shop has.
  insert into public.journal_lines (entry_id, account_id, amount_cents, location_id, memo)
  select x.entry_id,
         coalesce(a.id, public.backfill_missing_account(x.code, x.src)),
         x.amount_cents, x.location_id, x.memo
    from (
      select m.entry_id, m.location_id, 'supplier payment ' || m.source_id::text as src,
             '2000' as code,
             ip.amount_cents::bigint as amount_cents, 'Bill paid' as memo
        from _bf_map m join public.invoice_payments ip on ip.id = m.source_id
       where m.source_kind = 'invoice_payment'
      union all
      select m.entry_id, m.location_id, 'supplier payment ' || m.source_id::text,
             public.account_code_for_payment_method(ip.method),
             -ip.amount_cents::bigint, 'Paid by ' || ip.method
        from _bf_map m join public.invoice_payments ip on ip.id = m.source_id
       where m.source_kind = 'invoice_payment'
    ) x
    left join public.accounts a on a.shop_id = p_shop_id and a.code = x.code and a.archived_at is null
   where x.amount_cents <> 0;

  ---------------------------------------------------------------------------
  -- Pay runs -- Dr 6200 Salaries and Wages, Cr 1000 Cash.
  ---------------------------------------------------------------------------
  --
  -- Cash, not 2200 Wages Payable: post_payroll_run records a run that HAS been
  -- paid. Accruing wages owed but unpaid is phase 3's work.
  --
  -- The run's own total_cents, which post_payroll_run wrote from the sum of its
  -- lines at post time. Re-summing payroll_run_lines would be a second opinion
  -- on the same arithmetic against rows that may have been edited since, and
  -- would post a figure that differs from the expense row the run produced.
  insert into public.journal_lines (entry_id, account_id, amount_cents, location_id, memo)
  select x.entry_id,
         coalesce(a.id, public.backfill_missing_account(x.code, x.src)),
         x.amount_cents, x.location_id, x.memo
    from (
      select m.entry_id, m.location_id, 'pay run ' || m.source_id::text as src,
             '6200' as code,
             pr.total_cents::bigint as amount_cents, 'Wages' as memo
        from _bf_map m join public.payroll_runs pr on pr.id = m.source_id
       where m.source_kind = 'payroll'
      union all
      select m.entry_id, m.location_id, 'pay run ' || m.source_id::text, '1000',
             -pr.total_cents::bigint, 'Paid out'
        from _bf_map m join public.payroll_runs pr on pr.id = m.source_id
       where m.source_kind = 'payroll'
    ) x
    left join public.accounts a on a.shop_id = p_shop_id and a.code = x.code and a.archived_at is null
   where x.amount_cents <> 0;

  ---------------------------------------------------------------------------
  -- Expenses -- THE SAME FOUR-WAY BRANCH THE LIVE TRIGGER TAKES.
  ---------------------------------------------------------------------------
  --
  -- 20260908000800 gave post_expense_to_ledger a branch, and this replay
  -- carries it character for character. If the two ever disagree, history and
  -- live behaviour disagree, and the whole of Task 8 turns on their not doing
  -- so -- verify-backfill.sql exists to hold them together.
  --
  --   invoice_id set        -> Dr the category's account / Cr 2000 Payable
  --   stock_receipt_id set  -> Dr 2000 Accounts Payable / Cr the wallet
  --   standalone stock_loss -> Dr 5100 Inventory Shrinkage / Cr 1200 Inventory
  --   anything else         -> Dr the category's account / Cr the wallet
  --
  -- (Rows carrying stock_count_id never reach here -- step 1 excluded them,
  -- because save_stock_count posted the whole entry itself. Nor do
  -- inventory_purchase bills, excluded by the same statement for the reason
  -- 20260908000800 sets out: the delivery already recognised them.)
  --
  -- THE TWO ARMS THAT REACH 1200 -- a standalone inventory_purchase debiting it
  -- through the category map, and a standalone stock_loss crediting it -- are
  -- mirrored in unposted_inventory_movement() so the opening balance can be
  -- predicted before this statement runs. The two case expressions there are
  -- copied from here on purpose and are meant to be diffed against these.
  --
  -- A BILL'S MIRROR ROW IS WHERE ITS COST IS RECOGNISED, and the credit is 2000
  -- rather than the wallet the row names. sync_invoice_expense writes the
  -- literal 'other' into payment_method because a bill has no payment method --
  -- routing that through account_code_for_payment_method credits 1010 Bank for
  -- a bill nobody has paid, and leaves the supplier payment's Dr 2000 with
  -- nothing to clear. This is the exact mirror of the receipt branch below.
  --
  -- A receipt-linked row SETTLES the payable receive_stock raised; it does not
  -- buy the goods again. Its category is 'inventory_purchase', which the map
  -- sends to 1200 -- and 1200 is exactly what the delivery already debited, so
  -- taking the category here is the double-count this branch exists to stop.
  --
  -- A standalone stock_loss credits 1200, never a wallet. Losing stock costs
  -- the shop the stock, not the till.
  --
  -- HISTORICAL ROWS PREDATE BOTH COLUMNS AND WILL HAVE THEM NULL, so they take
  -- the standalone path -- AND THAT IS RIGHT, not a gap the replay is papering
  -- over. Those rows were written before the ledger existed: there is no
  -- receipt entry for a null stock_receipt_id to settle, because receive_stock
  -- posted nothing at the time, and the replay posts that receipt's own
  -- Dr 1200 / Cr 2000 from stock_receipts in the same run. A historical
  -- inventory_purchase therefore has to debit 1200 on its own account, exactly
  -- as it does today. The only rows that carry a link are ones written after
  -- 20260908000800 shipped -- and for those the receipt entry exists, so the
  -- settlement has something to settle.
  --
  -- The mapping in the third branch is what makes a balance sheet possible:
  -- 'inventory_purchase' goes to 1200 Inventory (an ASSET) and 'owner_draw' to
  -- 3100 Owner's Draw (CONTRA-EQUITY), so they stop being expenses here rather
  -- than being filtered out of a subtotal by a list somebody has to remember to
  -- maintain.
  --
  -- Cr the account the PAYMENT METHOD maps to, not 1000 for everything.
  -- Hardcoding 1000 would make the till count disagree with the ledger for
  -- every zaad or eDahab expense.
  --
  -- THE REPLAY READS THE ROW AS IT STANDS TODAY, AND THAT IS NOW THE RIGHT
  -- ANSWER RATHER THAN A HOLE. This block used to say the opposite -- that
  -- expenses_post_to_ledger was AFTER INSERT only, so a live-posted expense kept
  -- its ORIGINAL figure while the row moved on, and the two paths disagreed for
  -- every edited expense. 20260908001000 closed that: an edit reverses and
  -- re-posts through post_expense_to_ledger itself, and a delete reverses. So a
  -- live-posted expense now carries its CURRENT figure too, which is exactly
  -- what the replay writes, and a deleted one has no surviving journal effect
  -- for the replay to disagree with. The two paths agree.
  --
  -- KEPT AS A NOTE RATHER THAN DELETED because the comment was cited as evidence
  -- once already: the next reader who finds "the replay reads the row as it
  -- stands today" should not go and re-solve a solved problem. If a future
  -- migration re-creates post_expense_to_ledger it must carry
  -- expenses_post_to_ledger_on_edit forward with it (20260908001000 says so at
  -- the trigger), or this paragraph becomes true again.
  insert into public.journal_lines (entry_id, account_id, amount_cents, location_id, memo)
  select x.entry_id,
         coalesce(a.id, public.backfill_missing_account(x.code, x.src)),
         x.amount_cents, x.location_id, x.memo
    from (
      select m.entry_id, m.location_id, 'expense ' || m.source_id::text as src,
             case when e.invoice_id is not null       then public.account_code_for_expense_category(e.category)
                  when e.stock_receipt_id is not null then '2000'
                  when e.category = 'stock_loss'      then '5100'
                  else public.account_code_for_expense_category(e.category)
             end as code,
             e.amount_cents::bigint as amount_cents,
             case when e.stock_receipt_id is not null then 'Delivery paid'
                  else replace(e.category, '_', ' ')
             end as memo
        from _bf_map m join public.expenses e on e.id = m.source_id
       where m.source_kind = 'expense'
      union all
      select m.entry_id, m.location_id, 'expense ' || m.source_id::text,
             case when e.invoice_id is not null then '2000'
                  when e.stock_receipt_id is null and e.category = 'stock_loss' then '1200'
                  else public.account_code_for_payment_method(e.payment_method)
             end,
             -e.amount_cents::bigint,
             case when e.invoice_id is not null then 'Owed to supplier'
                  when e.stock_receipt_id is null and e.category = 'stock_loss' then 'Written off'
                  else 'Paid by ' || e.payment_method
             end
        from _bf_map m join public.expenses e on e.id = m.source_id
       where m.source_kind = 'expense'
    ) x
    left join public.accounts a on a.shop_id = p_shop_id and a.code = x.code and a.archived_at is null
   where x.amount_cents <> 0;

  -- ── 6b. THE OPENING BALANCE ─────────────────────────────────────────────
  --
  --     Dr 1200 Inventory        the stock no delivery accounts for
  --     Cr 3000 Owner's Capital  the same
  --
  -- AFTER every other line statement, and that ordering is the whole design.
  -- The amount is "what stock is worth, less what the ledger holds against
  -- 1200", and only here is the second half complete. Computed before step 6 it
  -- would be short by everything this run just posted, and 1200 would end up
  -- reading (on hand + the run's own movements) instead of (on hand).
  --
  -- The full reasoning -- why this amount and not today's stock, why this date
  -- and not today, why per shop and not per location, what an uncosted product
  -- contributes, and why the idempotency guard is not `source = 'opening'`
  -- alone -- is in this migration's header. It is the number a shop's first
  -- balance sheet rests on and it is argued there at length rather than here.
  --
  -- Zero posts NOTHING, which is a requirement and not a shortcut:
  -- journal_lines carries check (amount_cents <> 0), so a shop with no stock
  -- and no history cannot be given a zero opening entry even if somebody wanted
  -- one. It is also the state every shop is in after its first run, which is
  -- what makes a second run write nothing.
  v_open_cents := public.opening_inventory_gap(p_shop_id);
  if v_open_cents <> 0 then
    v_open_date := public.opening_inventory_date(p_shop_id);
    v_open_id   := gen_random_uuid();

    -- The month may not exist yet -- a shop with stock and no ledger at all
    -- reaches here with nothing in _bf_map, so step 2 created nothing. Created
    -- OPEN, and an existing month keeps whatever status it has and receives the
    -- entry anyway, exactly as step 2 does and for the same reasons.
    insert into public.accounting_periods (shop_id, starts_on, ends_on)
      values (p_shop_id, date_trunc('month', v_open_date)::date,
              (date_trunc('month', v_open_date) + interval '1 month - 1 day')::date)
      on conflict (shop_id, starts_on) do nothing;

    if not exists (select 1 from public.accounting_periods ap
                    where ap.shop_id = p_shop_id
                      and v_open_date between ap.starts_on and ap.ends_on) then
      raise exception 'No accounting period covers % , where the opening balance belongs. A period already starts on the 1st of that month but ends before the month does. Extend or remove that period and run again.', v_open_date
        using errcode = 'P0001';
    end if;

    -- One number from the same counter, in the same read-and-increment. Never a
    -- separate series: see this file's header on references.
    v_year := to_char(v_open_date, 'YYYY');
    insert into public.journal_entry_sequences (shop_id, year, next_number)
      values (p_shop_id, v_year, 2)
      on conflict (shop_id, year) do update
        set next_number = public.journal_entry_sequences.next_number + 1
      returning next_number - 1 into v_first;

    -- No location, for the reason set out in the header: the amount is a
    -- shop-level residue and a per-branch split of it would be exact-looking
    -- and unfounded.
    insert into public.journal_entries
        (id, shop_id, period_id, entry_date, reference, description, source, status, location_id, created_by)
      values (v_open_id, p_shop_id,
              (select ap.id from public.accounting_periods ap
                where ap.shop_id = p_shop_id and v_open_date between ap.starts_on and ap.ends_on
                order by ap.starts_on desc limit 1),
              v_open_date, public.journal_entry_reference(v_year, v_first),
              'Opening stock', 'opening', 'posted', null, auth.uid());

    -- Same LEFT JOIN and same backfill_missing_account as every other line
    -- statement: a shop whose chart is missing 3000 must be told which account
    -- by name, not left with an entry that quietly lost half of itself.
    insert into public.journal_lines (entry_id, account_id, amount_cents, location_id, memo)
    select v_open_id,
           coalesce(a.id, public.backfill_missing_account(x.code, 'the opening balance')),
           x.amount_cents, null, x.memo
      from (values ('1200', v_open_cents, 'Stock on hand when the books begin'),
                   ('3000', -v_open_cents, 'Put in by the owner')) as x(code, amount_cents, memo)
      left join public.accounts a on a.shop_id = p_shop_id and a.code = x.code and a.archived_at is null;

    v_written := v_written + 1;
  end if;

  -- ── 7. Nothing was written half-way ─────────────────────────────────────
  --
  -- A BACKSTOP, not the first line of defence. The missing-account case -- which
  -- used to reach here, badly, as an entry silently short of lines -- now raises
  -- by name at the line statement itself (see backfill_missing_account above).
  -- What is left for this to catch is an entry whose lines all came out ZERO and
  -- were filtered by `amount_cents <> 0`: a source row carrying no money that
  -- the step-1 filters did not already exclude. The deferred balance trigger
  -- cannot see it, because assert_journal_balances deliberately ALLOWS a
  -- zero-line entry (that is the legitimate end state of a draft's lines being
  -- deleted), so an entry could be left standing with nothing under it and the
  -- trial balance would still zero.
  --
  -- Raised rather than skipped. If the replay cannot express a row, the mapping
  -- is wrong and the whole run should stop -- a backfill that quietly wrote a
  -- referenced-but-empty entry is exactly the "close is worse than none" state
  -- this task exists to avoid.
  --
  -- The opening entry is not checked here because it cannot fail this way: it
  -- is two lines of a non-zero amount and its negation, guarded by
  -- `v_open_cents <> 0` before either is written.
  select string_agg(m.source_kind || ' ' || m.source_id::text, ', ')
    into v_bad
    from _bf_map m
   where (select count(*) from public.journal_lines l where l.entry_id = m.entry_id) < 2;
  if v_bad is not null then
    raise exception 'Backfill could not build a complete entry for: %. The chart of accounts is missing something, or the source rows carry no money.', v_bad
      using errcode = 'P0001';
  end if;

  return v_written;
end;
$$;

comment on function public.backfill_shop_ledger(uuid) is
  'Replays every unposted sale, refund, settlement, stock receipt, stock count, supplier payment, pay run and expense into the ledger, then posts the shop''s opening inventory balance (Dr 1200 / Cr 3000) for stock that arrived before the app recorded deliveries, and returns how many entries it wrote. Idempotent -- the eight replays are driven by journal_entry_id being null and the opening balance by opening_inventory_gap(), which returns 0 once one exists -- so a second run writes nothing. Inserts journal_entries and journal_lines directly rather than through post_journal_entry, because open_period_for raises on a closed month and would abort the replay half-way; the deferred balance trigger still runs, and the wrapper''s missing-account check is reproduced by backfill_missing_account. References come from journal_entry_sequences, reserved a year at a time.';

grant execute on function public.backfill_shop_ledger(uuid) to authenticated;
