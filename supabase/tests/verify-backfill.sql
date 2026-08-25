-- The historical backfill ties to the existing report totals TO THE CENT.
--
-- This is the script that decides whether backfill_shop_ledger is trusted. A
-- replay that ties is trustworthy; one that is close is worse than none,
-- because it looks right.
--
-- THE FIXTURE WRITES ROWS DIRECTLY, bypassing the RPCs, because that is what
-- pre-phase-2b history looks like: a sale, a receipt, a refund, an expense,
-- with no journal_entry_id and no entry behind them. The one thing it does NOT
-- write directly is the settlement -- that goes through settle_sale_balance on
-- purpose, so the fixture reproduces the state trap 4 describes: an entry that
-- credits 1100 with no matching debit anywhere, because the sale that created
-- the receivable predates posting.
--
-- What is asserted, and why each one exists:
--
--   1. Before the backfill nothing is posted -- except the one settlement
--      entry, and 1100 reads NEGATIVE. That is the transient state the plan
--      names, it is not a defect, and it resolves the moment the sale is
--      replayed.
--  1a/1b. A MISSING OR ARCHIVED ACCOUNT STOPS THE REPLAY, BY NAME. The replay
--      does not go through post_journal_entry and therefore does not inherit
--      its 'No such account: 4200'. 1a covers the visible half (one line gone,
--      the entry no longer balances); 1b covers the half that is not visible at
--      all (a self-balancing 5000/1200 pair gone, the entry still balancing,
--      the COGS silently zero).
--   2. The backfill posts every unposted row and says how many.
--   3. THE ONES THAT MATTER. Revenue, COGS, discounts, receivables, operating
--      expenses, payables, EVERY TENDER ACCOUNT SEPARATELY, sales returns and
--      the tax that came back, and inventory and shrinkage -- each tie to the
--      figures the app reports today.
--      Revenue is asserted against unit_price_cents * quantity -- LIST price,
--      an expression the replay does not use -- because asserting it against
--      sum(line_total_cents) would be the same arithmetic twice and would pass
--      a replay that credits 4000 net of every promotion the shop ever ran.
--      Discounts are asserted the same way, as list + tax - what the customer
--      paid, so that deleting points_redeemed_cents from the replay cannot pass
--      by shrinking both sides.
--      The tenders are asserted ONE ACCOUNT AT A TIME because a replay that
--      lumped every method into 1000 Cash ties on every other total in this
--      file, and one-line-per-tender is the whole reason the drawer and the
--      wallet can be reconciled separately.
--   4. Every entry balances (forced with SET CONSTRAINTS, because the balance
--      trigger is DEFERRABLE INITIALLY DEFERRED and this script rolls back
--      rather than commits, so it would otherwise never fire) and the trial
--      balance is zero.
--   5. Nothing is left unposted. A backfill that quietly skipped rows would
--      pass every total above, because both sides would be short.
--   6. IDEMPOTENT. It will be re-run: the first run of a real backfill always
--      finds something check 3 disagrees with, and the fix is to correct the
--      mapping and run it again.
--   7. Entries are dated on their SOURCE ROW, in the SHOP'S local time. The old
--      sale is rung at 22:30 UTC, which is 01:30 the next day in Mogadishu, so
--      a replay using a bare ::date lands a day early and this check separates
--      it from a correct one -- as well as from one that stamped everything
--      today.
--   8. A CLOSED period does not abort the replay.
--   9. References come from journal_entry_sequences, so a live posting after
--      the backfill does not collide with it. This is what a parallel numbering
--      scheme -- a restart at 1, an 'R'/'E' prefix -- would break.
--  12. And a reference past 9,999 does not truncate back to four digits, on
--      either path. Check 8 pushes the counter to 9998 before its re-run, so
--      the backfill writes 'JE-YYYY-10000'; check 12 then posts live from the
--      same counter. lpad(n::text, 4, '0') cuts a longer string, so entry
--      10000 used to take entry 1000's reference.
--  10. THE DOUBLE-COUNTS. A settlement is not re-posted, and the expenses row
--      post_payroll_run writes is not replayed on top of the run's own entry.
--      (The bill's mirrored row used to be listed here too, and it did not
--      belong: nothing on this branch posts when an `invoices` row is
--      inserted, so that row is where a bill's cost is recognised. Excluding it
--      excluded the recognition, and 2000 went negative by every bill the shop
--      ever paid. See 3f and 3k.)
--  11. Backfilled entries carry their TRUE source, never a 'backfill' marker.
--  3j. THE TWO CLIENT PAIRS REPLAY EXACTLY AS THE LIVE PATH POSTS THEM, which
--      is the deliverable this whole phase turns on. The Restock sheet writes
--      an inventory_purchase expense carrying stock_receipt_id on top of a
--      receipt, and the Count sheet a stock_loss expense carrying
--      stock_count_id on top of a stock-take. verify-posting-expenses.sql
--      checks 9 and 10 assert what the LIVE trigger does with each; this file
--      asserts the REPLAY reaches the same figures, because a backfill that
--      posted history one way while the trigger posts new rows another way
--      would leave a shop's books changing shape on the date it was migrated.
--  3i-2. AND 1200 EQUALS WHAT IS ON THE SHELF, which no check in this file
--      asserted until the opening balance existed. The movements alone sum to
--      -8600 here: a NEGATIVE ASSET over a trial balance of exactly zero, which
--      is the state a real shop was found in after 54 entries that all
--      reconciled. Every check in this file passed while it was true.
--  17. THE SHOP IT WAS FOUND ON, in miniature: stock typed into a product form,
--      never received, partly sold. Its own shop, because "where did this stock
--      come from" is answered once per shop and for ever.
--  18. A SHOP WHOSE STOCK REALLY DID ARRIVE gets no opening entry at all --
--      the delivery already debited 1200 and an opening balance on top would
--      count the goods twice, with the trial balance still zero.
-- 18b. AND THE OTHER DIRECTION. A ledger claiming more stock than the shelf
--      holds is corrected the other way, Cr 1200 / Dr 3000. The only negative
--      gap in this file, and without it a `greatest(0, ...)` clamp survives
--      every check here while leaving an OVERSTATED asset -- the more dangerous
--      of the two directions.
--  19. NO STOCK, NO HISTORY: nothing is posted. journal_lines refuses a zero
--      amount, so an unconditional opening entry would fail every new shop's
--      first backfill with a constraint violation.
--  20. RE-RUNNING WRITES NO SECOND OPENING BALANCE, including after a
--      re-costing -- which is the half the amount guard cannot cover and the
--      marker exists for.
--  21. AN UNCOSTED PRODUCT CONTRIBUTES NOTHING, asserted against the plausible
--      wrong answer (its selling price) rather than against zero, because
--      "nothing" and "zero" are the same number and a check that could not tell
--      them apart would prove nothing.
--  3k. THE SAME EQUIVALENCE FOR A BILL AND ITS PAYMENT. Entering the bill
--      recognises Dr the category's account / Cr 2000; paying it debits 2000;
--      and what is left in 2000 across the pair is what the bill still owes.
--      verify-posting-bills.sql checks 11-13 assert the live half.
--
-- Deliberately NOT `set role authenticated`, for the reason
-- verify-posting-expenses.sql is not: this script stays superuser so RLS never
-- hides a journal_lines row from its own assertions. Nothing under test is an
-- RLS policy. backfill_shop_ledger gates on has_shop_permission(), which reads
-- auth.uid() from the JWT claim set below.
--
-- Everything runs inside one DO block whose EXCEPTION clause rolls it all back.

\set ON_ERROR_STOP on

do $$
declare
  v_user_id   uuid := gen_random_uuid();
  v_shop_id   uuid;
  v_loc_id    uuid;
  v_sale_a    uuid;
  v_sale_b    uuid;
  v_sale_c    uuid;
  v_item_c    uuid;
  v_sale_d    uuid;
  v_item_d    uuid;
  -- SALE E, the zero-valued one. Named here because check 5 has to exempt it
  -- by id: it is the one sale row that stays unposted for ever, by design.
  v_sale_e    uuid;
  v_refund_id uuid;
  v_refund_d  uuid;
  v_receipt   uuid;
  v_count_id  uuid;
  v_invoice   uuid;
  v_run_id    uuid;
  v_expense   uuid;
  -- The two client-written expense rows that sit ON TOP of an RPC that already
  -- posted the event. See the fixture block below and check 3j.
  v_recpt_exp uuid;
  v_count_exp uuid;
  v_entry     uuid;
  v_ledger    bigint;
  v_report    bigint;
  v_posted    integer;
  v_rows      integer;
  v_text      text;
  v_date      date;
  -- Checks 14 and 15: what the Post History door says is waiting, read off
  -- unposted_ledger_counts() before and after the replay.
  v_bf_kinds  integer;
  v_bf_oldest date;
  -- The old sale's day in the shop's own time, and the UTC instant that lands
  -- on it. 22:30 UTC is 01:30 the NEXT day in Mogadishu (UTC+3), so
  -- shop_local_date() and a bare ::date differ by one and any replay that
  -- reaches for the wrong one fails check 7 every day of the year.
  v_old_day   date := (date_trunc('month', public.shop_local_date()::timestamp)
                        - interval '3 months')::date + 13;
  v_old_at    timestamptz;
  v_old_local date;
  -- Check 8b: a month LOCKED as well as one closed, found from the view rather
  -- than named so it does not go stale when the fixture's dates move.
  v_lock_month date;
  -- Everything the ledger already held before the backfill ran -- which is the
  -- settlement's entry and nothing else. Check 8 tears down what the backfill
  -- wrote and must leave the live entry standing, or it would be testing a
  -- different shop.
  v_pre       uuid[];
  v_seq       integer;
  v_max_ref   text;
  v_product   uuid;
  -- The opening balance the door predicts before the replay runs, held so
  -- check 3i can assert the replay posted exactly it.
  v_open_expected bigint;
  -- Checks 17-21, the opening balance's own shops. Each is a different answer
  -- to "where did this stock come from", and they are separate shops rather
  -- than states of one because the question is settled per shop, once, for ever.
  v_shop_import uuid;   -- 17, 20: stock typed into a product form, never received
  v_shop_recvd  uuid;   -- 18: stock that really did arrive through a delivery
  v_shop_empty  uuid;   -- 19: no stock, no history
  v_shop_uncost uuid;   -- 21: costed and uncosted stock side by side
  v_shop_blind  uuid;   -- 21: nothing but uncosted stock
  v_shop_short  uuid;   -- 18b: a ledger claiming more stock than the shelf has
  v_loc2        uuid;
  v_prod2       uuid;
begin
  v_old_at    := (v_old_day + time '22:30')::timestamp at time zone 'UTC';
  v_old_local := public.shop_local_date(v_old_at);

  insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
    values (v_user_id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            'verify-backfill-' || v_user_id || '@example.test', '', now(), now(), now());

  insert into public.shops (owner_id, name) values (v_user_id, 'Backfill Shop')
    returning id into v_shop_id;

  -- A shop has no location until the fixture makes one. seed_shop_defaults DOES
  -- seed the chart of accounts, which is where every code below comes from.
  insert into public.shop_locations (shop_id, name, is_primary)
    values (v_shop_id, 'Main', true) returning id into v_loc_id;

  perform set_config('request.jwt.claims', json_build_object('sub', v_user_id)::text, true);

  -- The expense posting trigger is turned OFF for the fixture and back ON
  -- before the backfill runs. Off, because an expense inserted with the trigger
  -- live posts immediately and is therefore not history -- there would be
  -- nothing to replay. Back on, because the realistic case is a shop being
  -- backfilled WHILE the trigger is live, which is what makes
  -- `journal_entry_id is null` a correctness filter rather than an
  -- optimisation.
  alter table public.expenses disable trigger expenses_post_to_ledger;

  -- stock_receipt_items and stock_count_items both carry a NOT NULL product_id
  -- with a real foreign key, so the delivery and the count need a product to
  -- point at. The sale lines deliberately do NOT: a sale line's product_id is
  -- nullable (a product deleted since the sale sets it null), and leaving it
  -- null keeps refund_sale_items' stock movement out of a fixture that is
  -- about the ledger.
  --
  -- AND IT OPENS WITH EIGHT SACKS ON THE SHELF, which is the fixture's whole
  -- statement about the opening balance. `stock` on the products row is what
  -- the product form and CSV import write, and product_opening_stock
  -- (20260810000000) turns it into a product_location_stock row at the primary
  -- location. NO stock_receipts ROW IS WRITTEN, because nothing was received --
  -- the shopkeeper was describing what was already there. That is the hole
  -- 20260908001300 exists to fill: the replay records this stock leaving, in
  -- COGS and in shrinkage, and had no record of it ever arriving.
  --
  -- Eight at 200 = 1600, which is what 1200 Inventory must read once everything
  -- has posted. It is deliberately the same eight the stock count below counted,
  -- so the fixture describes one coherent shelf rather than two.
  insert into public.products (shop_id, name, price_cents, cost_cents, stock)
    values (v_shop_id, 'Sack of rice', 5000, 200, 8) returning id into v_product;

  ---------------------------------------------------------------------------
  -- SALE A -- the till sale, three months back, with a LINE-LEVEL discount.
  ---------------------------------------------------------------------------
  -- One line at 5000 x 2 = 10000 LIST, less a 1500 promotion = 8500 recorded in
  -- line_total_cents. Plus a 500 order discount and 400 of tax:
  -- total = 8500 - 500 + 400 = 8400, paid 6400 cash + 2000 zaad.
  --
  -- The 1500 is the whole point of this sale. complete_sale folds a line
  -- discount into line_total_cents before it ever reaches v_gross_cents, so a
  -- replay that credits 4000 with a bare sum(line_total_cents) understates
  -- revenue by exactly that 1500 and leaves 4200 reading 500 instead of 2000 --
  -- while balancing perfectly, because both sides move together.
  insert into public.sales
      (shop_id, location_id, created_by, payment_method, total_cents, item_count,
       created_at, discount_cents, tax_cents, points_redeemed_cents, settled_at)
    values (v_shop_id, v_loc_id, v_user_id, 'cash', 8400, 2,
            v_old_at, 500, 400, 0, v_old_at)
    returning id into v_sale_a;
  insert into public.sale_items
      (sale_id, product_name, unit_price_cents, quantity, line_total_cents, discount_cents, unit_cost_cents)
    values (v_sale_a, 'Sack of rice', 5000, 2, 8500, 1500, 3000);
  insert into public.sale_payments (sale_id, method, amount_cents, created_at)
    values (v_sale_a, 'cash', 6400, v_old_at), (v_sale_a, 'zaad', 2000, v_old_at);

  ---------------------------------------------------------------------------
  -- SALE B -- a credit sale, part paid, later SETTLED through the live RPC.
  --           AND THE ONLY SALE THAT REDEEMS LOYALTY POINTS.
  ---------------------------------------------------------------------------
  -- One line at 3000 LIST, less 500 redeemed in points: total = 3000 - 500 =
  -- 2500. 1000 taken at the till, 1500 left on account.
  --
  -- The 500 of points is the whole point of this sale. `points_redeemed_cents`
  -- is the third term in the 4200 contra and the second half of the headline
  -- defect the line-discount add-back is the first half of -- and while it was
  -- zero on every fixture sale, DELETING it from the replay's 4200 expression
  -- passed every check in this file. A replay that ignores points understates
  -- 4200 by every point any customer ever spent AND leaves the entry short on
  -- the debit side, so it does not even balance -- but nothing here saw it.
  insert into public.sales
      (shop_id, location_id, created_by, payment_method, total_cents, item_count,
       created_at, discount_cents, tax_cents, points_redeemed_cents)
    values (v_shop_id, v_loc_id, v_user_id, 'cash', 2500, 1,
            now() - interval '5 days', 0, 0, 500)
    returning id into v_sale_b;
  insert into public.sale_items
      (sale_id, product_name, unit_price_cents, quantity, line_total_cents, discount_cents, unit_cost_cents)
    values (v_sale_b, 'Cooking oil', 3000, 1, 3000, 0, 1000);
  insert into public.sale_payments (sale_id, method, amount_cents, created_at)
    values (v_sale_b, 'cash', 1000, now() - interval '5 days');

  ---------------------------------------------------------------------------
  -- SALE C -- paid in full, then partly refunded. The refund is UNPOSTED.
  ---------------------------------------------------------------------------
  insert into public.sales
      (shop_id, location_id, created_by, payment_method, total_cents, item_count,
       created_at, discount_cents, tax_cents, settled_at)
    values (v_shop_id, v_loc_id, v_user_id, 'cash', 8000, 2,
            now() - interval '2 days', 0, 0, now() - interval '2 days')
    returning id into v_sale_c;
  insert into public.sale_items
      (sale_id, product_name, unit_price_cents, quantity, line_total_cents, discount_cents, unit_cost_cents)
    values (v_sale_c, 'Tea chest', 4000, 2, 8000, 0, 1500)
    returning id into v_item_c;
  insert into public.sale_payments (sale_id, method, amount_cents, created_at)
    values (v_sale_c, 'cash', 8000, now() - interval '2 days');

  insert into public.refunds (sale_id, refunded_by, goods_cents, total_cents, created_at)
    values (v_sale_c, v_user_id, 4000, 4000, now() - interval '1 day')
    returning id into v_refund_id;
  insert into public.refund_items (refund_id, sale_item_id, quantity, amount_cents)
    values (v_refund_id, v_item_c, 1, 4000);

  ---------------------------------------------------------------------------
  -- SALE D -- TAXED, SPLIT-TENDER, AND PARTLY REFUNDED. All three at once.
  ---------------------------------------------------------------------------
  -- Two lines' worth at 3000 each = 6000 LIST, no discount, plus 300 of tax:
  -- total = 6300, paid 4300 cash + 2000 zaad, settled at the till.
  --
  -- Sale A is taxed but never refunded; sale C is refunded but carries no tax.
  -- So until this sale existed the refund's `4100 = goods - tax_back` split was
  -- only ever exercised with tax_back = 0 -- its degenerate form -- and a wrong
  -- proration basis moved money between 4100 Sales Returns and 2100 Sales Tax
  -- Payable, BALANCED (the two are on the same side of the same entry and sum
  -- to goods_cents whatever the split), and was asserted by nothing.
  --
  -- EXACTLY HALF the sale comes back, which is what makes the tax assertion
  -- independent of the replay's arithmetic: half the goods returning must bring
  -- back half the tax, 150, whatever expression computes it.
  insert into public.sales
      (shop_id, location_id, created_by, payment_method, total_cents, item_count,
       created_at, discount_cents, tax_cents, settled_at)
    values (v_shop_id, v_loc_id, v_user_id, 'cash', 6300, 2,
            now() - interval '6 days', 0, 300, now() - interval '6 days')
    returning id into v_sale_d;
  insert into public.sale_items
      (sale_id, product_name, unit_price_cents, quantity, line_total_cents, discount_cents, unit_cost_cents)
    values (v_sale_d, 'Sugar sack', 3000, 2, 6000, 0, 1000)
    returning id into v_item_d;
  -- Two tenders, so the refund's pro-rata credit has something to divide. The
  -- shares come out exact -- 3150 x 4300/6300 = 2150 and 3150 x 2000/6300 =
  -- 1000 -- so the assertions below are not hostage to the rounding rule.
  insert into public.sale_payments (sale_id, method, amount_cents, created_at)
    values (v_sale_d, 'cash', 4300, now() - interval '6 days'),
           (v_sale_d, 'zaad', 2000, now() - interval '6 days');

  -- Half the sale back. refund_sale_items would write goods_cents =
  -- round(6300 x 3000/6000) = 3150 and, the sale being paid in full,
  -- total_cents = 3150; those two figures are reproduced here rather than
  -- recomputed, because the replay reads the STORED row and never recomputes.
  insert into public.refunds (sale_id, refunded_by, goods_cents, total_cents, created_at)
    values (v_sale_d, v_user_id, 3150, 3150, now() - interval '5 days')
    returning id into v_refund_d;
  insert into public.refund_items (refund_id, sale_item_id, quantity, amount_cents)
    values (v_refund_d, v_item_d, 1, 3150);

  ---------------------------------------------------------------------------
  -- SALE E -- ZERO-VALUED. THE ONE THAT ABORTED THE WHOLE SHOP'S REPLAY.
  ---------------------------------------------------------------------------
  -- Free samples handed to a named customer and left on account. Legal since
  -- p_allow_balance shipped (20260831000100): item_count is 1, so complete_sale's
  -- "a sale must have at least one item" guard passes; the line is priced at 0
  -- with no frozen cost, so total_cents is 0 and there is no payment, no
  -- receivable, no tax, no discount and no COGS.
  --
  -- `sales` was the ONLY source kind in step 1 of the backfill with no "carries
  -- money" predicate -- every other one has had one since it was written. So this
  -- row was mapped, given an entry and a reference, produced not one journal line
  -- (every amount is zero and `amount_cents <> 0` throws them all away), and
  -- step 7's two-line guard then aborted THE ENTIRE SHOP'S REPLAY with
  -- "Backfill could not build a complete entry". One giveaway from two years ago
  -- and the shop cannot be backfilled at all.
  --
  -- It is not paid, not settled and not refunded, so it contributes zero to
  -- every tie-out in check 3 and cannot make any of them pass by coincidence.
  insert into public.sales
      (shop_id, location_id, created_by, payment_method, total_cents, item_count,
       created_at, discount_cents, tax_cents, points_redeemed_cents)
    values (v_shop_id, v_loc_id, v_user_id, 'unpaid', 0, 1,
            now() - interval '7 days', 0, 0, 0)
    returning id into v_sale_e;
  insert into public.sale_items
      (sale_id, product_name, unit_price_cents, quantity, line_total_cents, discount_cents, unit_cost_cents)
    values (v_sale_e, 'Free sample', 0, 1, 0, 0, null);

  ---------------------------------------------------------------------------
  -- A delivery and a stock count.
  ---------------------------------------------------------------------------
  insert into public.stock_receipts (shop_id, location_id, created_by, supplier_name, created_at)
    values (v_shop_id, v_loc_id, v_user_id, 'Berbera Wholesale', now() - interval '4 days')
    returning id into v_receipt;
  insert into public.stock_receipt_items (receipt_id, product_id, product_name, quantity, unit_cost_cents)
    values (v_receipt, v_product, 'Sack of rice', 10, 200);

  insert into public.stock_counts (shop_id, location_id, created_by, created_at)
    values (v_shop_id, v_loc_id, v_user_id, now() - interval '3 days')
    returning id into v_count_id;
  insert into public.stock_count_items
      (count_id, product_id, product_name, previous_quantity, counted_quantity, unit_cost_cents)
    values (v_count_id, v_product, 'Sack of rice', 10, 8, 200);

  ---------------------------------------------------------------------------
  -- A BILL and a payment against it. THE SECOND DOUBLE-COUNT TRAP.
  ---------------------------------------------------------------------------
  -- Inserting the invoice fires sync_invoice_expense, which mirrors it into
  -- expenses carrying invoice_id and category 'supplies' -> 6400. That row must
  -- NOT be replayed: the cost is recognised by the bill and its liability by
  -- receive_stock / record_invoice_payment, so replaying it would recognise
  -- every stocked cost twice -- with the trial balance still zero.
  insert into public.invoices
      (shop_id, location_id, vendor_name, invoice_number, category, issued_on, due_on,
       amount_cents, created_by)
    values (v_shop_id, v_loc_id, 'Berbera Wholesale', 'BW-1001', 'supplies',
            public.shop_local_date() - 10, public.shop_local_date() + 20, 5000, v_user_id)
    returning id into v_invoice;

  -- Paid by eDahab, not cash, so 1021 has something in it. The tender
  -- assertions below need every wallet the map knows about to be reachable:
  -- a replay that hardcoded 1000 for the payment side of a bill would tie on
  -- 2000 Accounts Payable, tie on every expense total, and put the shop's
  -- eDahab balance in the till.
  insert into public.invoice_payments (invoice_id, amount_cents, paid_on, method, created_by)
    values (v_invoice, 3000, public.shop_local_date() - 6, 'edahab', v_user_id);

  -- AND AN inventory_purchase BILL, which is the one bill that posts NOTHING.
  -- receive_stock already debited 1200 against 2000 for goods that arrive, and
  -- pairing a delivery with the supplier's bill for it is the app's own
  -- unpaid-delivery flow -- record_invoice_payment is the only door that draws
  -- that payable down and it needs an invoice. Replaying this row would put the
  -- delivery into 1200 twice and raise a second payable beside the real one.
  --
  -- IT IS HERE BECAUSE WITHOUT IT THAT BRANCH IS UNTESTED. With only the
  -- 'supplies' bill above, deleting the inventory_purchase clause from the
  -- replay's filter changed nothing anywhere and the mutation survived green --
  -- a finding about this file, not about the migration, and the same one the
  -- standalone stock_loss row below was added for. Left UNPAID and at 1300, so
  -- it cannot be confused with the 5000 bill, the 2000 delivery or the 3000
  -- payment, and so it moves no tender.
  insert into public.invoices
      (shop_id, location_id, vendor_name, invoice_number, category, issued_on, due_on,
       amount_cents, created_by)
    values (v_shop_id, v_loc_id, 'Berbera Wholesale', 'BW-1002', 'inventory_purchase',
            public.shop_local_date() - 9, public.shop_local_date() + 21, 1300, v_user_id);

  ---------------------------------------------------------------------------
  -- A POSTED PAY RUN and its expenses row. THE FIRST DOUBLE-COUNT TRAP.
  ---------------------------------------------------------------------------
  -- Written directly rather than through post_payroll_run, because that would
  -- post the run's entry and leave nothing to replay -- but the pair of rows it
  -- leaves behind is reproduced exactly: a posted run with no entry, and an
  -- expenses row carrying payroll_run_id and category 'salaries_wages', which
  -- the map sends to 6200. Replaying that row would make 6200 read 14000 for
  -- 7000 of wages actually paid, and the trial balance would still zero.
  insert into public.payroll_runs
      (shop_id, location_id, period_start, period_end, status, total_cents, posted_at, created_by)
    values (v_shop_id, v_loc_id, public.shop_local_date() - 30, public.shop_local_date() - 16,
            'posted', 7000, now() - interval '15 days', v_user_id)
    returning id into v_run_id;
  insert into public.expenses
      (shop_id, location_id, occurred_on, amount_cents, category, payment_method, note, created_by, payroll_run_id)
    values (v_shop_id, v_loc_id, public.shop_local_date() - 16, 7000, 'salaries_wages',
            'cash', 'Payroll', v_user_id, v_run_id);

  -- AND A DRAFT PAY RUN, which must NOT be replayed. A draft has paid nobody --
  -- and, more sharply, unpost_payroll_run returns a posted run to draft,
  -- reverses its entry and clears journal_entry_id, so a replay driven by that
  -- column alone would re-recognise wages the shop reversed on purpose and
  -- leave the reversal entry explaining nothing. 4000, so a replay that picked
  -- it up shows 11000 against 7000 of wages actually paid.
  insert into public.payroll_runs
      (shop_id, location_id, period_start, period_end, status, total_cents, created_by)
    values (v_shop_id, v_loc_id, public.shop_local_date() - 14, public.shop_local_date() - 1,
            'draft', 4000, v_user_id);

  ---------------------------------------------------------------------------
  -- A PLAIN expense -- the one the replay is genuinely responsible for.
  ---------------------------------------------------------------------------
  -- 'rent' -> 6000, and nothing else in this fixture touches 6000, so the
  -- expense tie-out separates a correct exclusion from a wrong one by account
  -- as well as by total.
  insert into public.expenses
      (shop_id, location_id, occurred_on, amount_cents, category, payment_method, note, created_by)
    values (v_shop_id, v_loc_id, public.shop_local_date() - 8, 2500, 'rent', 'cash', 'Shop rent', v_user_id)
    returning id into v_expense;

  ---------------------------------------------------------------------------
  -- THE TWO CLIENT PAIRS. THE THIRD AND FOURTH DOUBLE-COUNT TRAPS.
  ---------------------------------------------------------------------------
  -- These are the rows the Restock sheet and the Count sheet write when the
  -- "also log this" tick is on, reproduced as history: each sits on top of an
  -- RPC that has ALREADY posted the event, and each carries the link column
  -- 20260908000800 added so the replay can tell it from a hand-typed row.
  --
  --   * The delivery above is 10 sacks at 200 = 2000, recorded as
  --     Dr 1200 / Cr 2000. This row is the shop PAYING for it, so the replay
  --     must write Dr 2000 / Cr 1000 -- settling the payable, not buying the
  --     goods a second time. Without the branch it debits 1200 again and the
  --     shop's stock reads 2000 too high with a payable that is never cleared.
  --     2000 exactly, because a delivery paid IN FULL is the case where 2000
  --     nets to nothing and the arithmetic says so out loud.
  --   * The count above is 2 sacks short at 200 = 400, recorded as
  --     Dr 5100 / Cr 1200. Nothing was paid. This row must post NOTHING, and it
  --     is the only row in this fixture that stays unposted for ever by design
  --     (check 5 excludes it for that reason). Without the exclusion 5100 reads
  --     800 for 400 of shrinkage and 1000 Cash is credited for stock nobody
  --     sold.
  --
  -- Both are dated with their RPC's row so the replay's period arithmetic sees
  -- a realistic pair rather than two rows in the same day.
  insert into public.expenses
      (shop_id, location_id, occurred_on, amount_cents, category, payment_method, note,
       created_by, stock_receipt_id)
    values (v_shop_id, v_loc_id, public.shop_local_date() - 4, 2000, 'inventory_purchase',
            'cash', 'Paid on delivery', v_user_id, v_receipt)
    returning id into v_recpt_exp;

  insert into public.expenses
      (shop_id, location_id, occurred_on, amount_cents, category, payment_method, note,
       created_by, stock_count_id)
    values (v_shop_id, v_loc_id, public.shop_local_date() - 3, 400, 'stock_loss',
            'cash', 'Stock-take', v_user_id, v_count_id)
    returning id into v_count_exp;

  ---------------------------------------------------------------------------
  -- A STANDALONE stock_loss -- no count behind it. A crate dropped.
  ---------------------------------------------------------------------------
  -- This one the replay IS responsible for, and it must post Dr 5100 / Cr 1200:
  -- losing stock costs the shop the stock, not the till. Crediting the wallet
  -- the row's payment_method names -- which is what the replay did before
  -- 20260908000800 -- balances perfectly and ties every P&L total, while
  -- leaving 1200 carrying units that are not on the shelf and the drawer
  -- disagreeing with the ledger by the whole of the shop's shrinkage.
  --
  -- IT IS HERE BECAUSE WITHOUT IT THE STANDALONE BRANCH IS UNTESTED. The only
  -- other stock_loss row in this fixture carries stock_count_id and is excluded
  -- from the replay entirely, so deleting the Cr 1200 branch changed nothing
  -- anywhere -- a mutation that survives, which is a finding about this file
  -- and not about the migration. 700, so it cannot be confused with the count's
  -- 400 and 1100 is unmistakably the pair.
  insert into public.expenses
      (shop_id, location_id, occurred_on, amount_cents, category, payment_method, note, created_by)
    values (v_shop_id, v_loc_id, public.shop_local_date() - 2, 700, 'stock_loss',
            'cash', 'Crate dropped', v_user_id);

  alter table public.expenses enable trigger expenses_post_to_ledger;

  ---------------------------------------------------------------------------
  -- THE ONE LIVE POSTING: a settlement taken against sale B.
  ---------------------------------------------------------------------------
  -- Through the real RPC, so the fixture holds exactly the state trap 4
  -- describes: settle_sale_balance posts Dr 1000 / Cr 1100, but the debit that
  -- put the receivable there was never posted because the sale predates
  -- posting. 1100 therefore reads NEGATIVE until the sale is replayed.
  perform public.settle_sale_balance(v_sale_b, jsonb_build_array(
    jsonb_build_object('method', 'cash', 'amount_cents', 500)));

  select coalesce(array_agg(id), '{}') into v_pre
    from public.journal_entries where shop_id = v_shop_id;

  ---------------------------------------------------------------------------
  -- 1. Before the backfill, only the settlement is posted -- and 1100 is
  --    NEGATIVE. Expected, transient, and not something to "fix" in the RPCs.
  ---------------------------------------------------------------------------
  select count(*) into v_rows from public.journal_entries where shop_id = v_shop_id;
  if v_rows <> 1 then
    raise exception 'FIXTURE: expected exactly the settlement entry, found % entries', v_rows;
  end if;

  select coalesce(sum(l.amount_cents), 0) into v_ledger
    from public.journal_lines l
    join public.accounts a on a.id = l.account_id
    join public.journal_entries e on e.id = l.entry_id
   where e.shop_id = v_shop_id and a.code = '1100';
  if v_ledger <> -500 then
    raise exception 'FIXTURE: 1100 should read -500 before the backfill (a settlement with no sale behind it), got %', v_ledger;
  end if;

  ---------------------------------------------------------------------------
  -- 1a. A MISSING ACCOUNT STOPS THE REPLAY, BY NAME. The unbalancing case.
  ---------------------------------------------------------------------------
  -- The replay does not go through post_journal_entry, which raises
  -- 'No such account: 4200'. It builds its lines by joining the chart of
  -- accounts, and an INNER join silently DROPS a line whose account is missing
  -- or archived. That failure then surfaces -- if at all -- at COMMIT, from the
  -- deferred balance trigger, as "debits and credits differ by 2000": no entry
  -- named, no account named, and nothing to say an account was the cause.
  --
  -- 4200 is archived here, which is the visible half of the defect: one dropped
  -- line and the entry no longer balances. The backfill must raise NAMING 4200
  -- rather than write an unbalanced entry and leave the trigger to notice.
  --
  -- Both of these run inside their own BEGIN ... EXCEPTION block, whose implicit
  -- savepoint rolls back the archive AND everything the backfill wrote, so the
  -- fixture is restored for check 2 without a teardown.
  begin
    update public.accounts set archived_at = now()
     where shop_id = v_shop_id and code = '4200';
    v_posted := public.backfill_shop_ledger(v_shop_id);
    raise exception 'FAIL: the backfill wrote % entries with 4200 archived -- the 4200 line was dropped and the entry left unbalanced', v_posted;
  exception when others then
    if sqlerrm like 'FAIL:%' then raise; end if;
    if sqlerrm not like 'No such account: 4200%' then
      raise exception 'FAIL: archiving 4200 should stop the backfill naming that account, got: %', sqlerrm;
    end if;
  end;

  ---------------------------------------------------------------------------
  -- 1b. THE SAME, FOR A SELF-BALANCING PAIR. The invisible case.
  ---------------------------------------------------------------------------
  -- This is the one that matters. 5000 and 1200 are posted as a PAIR -- Dr 5000
  -- / Cr 1200 on a sale, the reverse on a refund, and 1200/5100 on a count.
  -- Drop both and the entry still balances, still has more than two lines,
  -- still passes check 4, still passes the "fewer than two lines" guard, and
  -- has silently lost every cent of cost of goods sold. A trial balance of zero
  -- over books with no COGS is exactly the "looks right" failure this whole
  -- script exists to separate from a correct replay.
  --
  -- Asserted on the MESSAGE, not merely on the raise: with both archived the
  -- old inner-join build did fail, but from the step-7 guard -- because the
  -- delivery's entry lost its only debit -- with a message that names a receipt
  -- and no account at all, while the sales quietly lost their COGS. Which of
  -- the two codes is reported first is not ordered, and either is a correct
  -- answer to "which account is missing".
  begin
    update public.accounts set archived_at = now()
     where shop_id = v_shop_id and code in ('5000', '1200');
    v_posted := public.backfill_shop_ledger(v_shop_id);
    raise exception 'FAIL: the backfill wrote % entries with the 5000/1200 pair archived -- every sale silently lost its COGS and still balanced', v_posted;
  exception when others then
    if sqlerrm like 'FAIL:%' then raise; end if;
    if sqlerrm not like 'No such account: 5000%' and sqlerrm not like 'No such account: 1200%' then
      raise exception 'FAIL: archiving the 5000/1200 pair should stop the backfill naming one of them, got: %', sqlerrm;
    end if;
  end;

  ---------------------------------------------------------------------------
  -- 2. The backfill posts every unposted row and says how many.
  ---------------------------------------------------------------------------
  -- Fourteen: four sales, two refunds, one receipt, one count, one supplier
  -- payment, one pay run, one rent expense, one standalone stock_loss, the
  -- delivery's payment, and THE BILL'S OWN MIRRORED EXPENSE ROW. NOT the
  -- settlement (already posted), NOT the payroll expense row, and NOT the
  -- count's stock_loss row -- save_stock_count already posted both sides of
  -- that one.
  --
  -- The bill's row was excluded until the final review, on the strength of "the
  -- cost is recognised by the bill" -- and nothing on this branch posts when an
  -- `invoices` row is inserted, so excluding the mirror row excluded the whole
  -- recognition. Replayed history reproduced the live defect to the cent.

  ---------------------------------------------------------------------------
  -- 14. THE DOOR AND THE REPLAY AGREE ON WHAT "UNPOSTED" MEANS -- BEFORE.
  ---------------------------------------------------------------------------
  -- The Post History screen has to say how many rows are waiting, and of what
  -- kind, BEFORE the replay runs. public.unposted_ledger_sources is where that
  -- answer comes from, and it carries a second copy of the eight per-kind
  -- predicates. Two copies of a definition is how a door comes to promise
  -- entries the replay will not write -- a number that is plausible and wrong,
  -- which is worse than no number.
  --
  -- So the view's total is asserted against what backfill_shop_ledger is about
  -- to RETURN, taken dynamically rather than restated, and the per-kind
  -- breakdown is asserted against the figures check 2's own comment names. The
  -- two sharpest rows:
  --
  --   settlement = 0. Every sale_payments row in this fixture that is NOT a
  --   settlement keeps journal_entry_id null for ever, because complete_sale
  --   folds a sale's own tenders into the sale's entry -- and the fixture's one
  --   real settlement was already posted by settle_sale_balance. A view driven
  --   off `journal_entry_id is null` without `is_settlement` reads 5 here.
  --
  --   expense = 4, not 6. The payroll-derived row and the count-derived
  --   stock_loss row are excluded PERMANENTLY by design (see check 5's two
  --   exemptions). A view that forgot either over-counts by exactly one.
  --
  -- And sale = 4, not 5: sale E carries no money and is never replayed, so a
  -- view missing the six-term "carries money" disjunction reads 5.
  --
  -- opening = 1, AND IT IS THE ONE ROW HERE WITH NO SOURCE ROW BEHIND IT. The
  -- opening balance is something a run WRITES, so the door has to count it or
  -- the button promises fewer entries than it posts -- and its existence
  -- depends on an AMOUNT the door cannot see directly, because part of that
  -- amount is lines the replay has not written yet. opening_inventory_gap()
  -- is the single definition both sides call; see 20260908001300's header. A
  -- door that simply omitted the ninth kind would say 14 and write 15.
  --
  -- MUTATION (proves this row): drop the opening arm from
  -- unposted_ledger_sources. Expected: FAIL: unposted_ledger_counts disagrees
  -- with the replay, got: ... (no opening=1).
  select sum(rows_unposted), min(oldest_on) into v_rows, v_bf_oldest
    from public.unposted_ledger_counts(v_shop_id);

  select string_agg(kind || '=' || rows_unposted, ' ' order by kind) into v_text
    from public.unposted_ledger_counts(v_shop_id);
  if v_text <> 'count=1 expense=4 invoice_payment=1 opening=1 payroll=1 receipt=1 refund=2 sale=4 settlement=0' then
    raise exception 'FAIL: unposted_ledger_counts disagrees with the replay, got: %', v_text;
  end if;

  -- All nine kinds come back even at zero: "nothing to do" is the state this
  -- door is in for ever after its first run, and a list that drops its empty
  -- rows cannot be told apart from one that failed to look.
  select count(*) into v_bf_kinds from public.unposted_ledger_counts(v_shop_id);
  if v_bf_kinds <> 9 then
    raise exception 'FAIL: unposted_ledger_counts returned % kinds, expected all 9 including the zeroes', v_bf_kinds;
  end if;

  -- AND THE AMOUNT THE DOOR PREDICTS IS THE AMOUNT THE REPLAY POSTS. Captured
  -- here, before anything is written, and asserted against the opening entry's
  -- own 1200 line further down (check 3i). This is the pin on the hardest part
  -- of 20260908001300: the door has to know the opening balance BEFORE the
  -- lines that determine it exist, which it does by predicting the replay's own
  -- inventory movement off the same eight predicates. If that prediction ever
  -- drifts from what the line statements actually write, this is what reddens
  -- rather than the door quietly promising the wrong figure.
  v_open_expected := public.opening_inventory_gap(v_shop_id);

  v_posted := public.backfill_shop_ledger(v_shop_id);
  if v_rows <> v_posted then
    raise exception 'FAIL: the door said % rows were unposted, the replay wrote % entries', v_rows, v_posted;
  end if;
  if v_posted <> 15 then
    raise exception 'FAIL: expected 15 entries (4 sales, 2 refunds, 1 receipt, 1 count, 1 supplier payment, 1 pay run, 3 expenses incl. the bill, 1 delivery payment, 1 opening balance), got %', v_posted;
  end if;

  ---------------------------------------------------------------------------
  -- 3a. REVENUE, AT LIST PRICE.
  ---------------------------------------------------------------------------
  -- Asserted against unit_price_cents * quantity, an expression the replay does
  -- not use. Against sum(line_total_cents) -- which is already NET of the line
  -- and promotion discounts -- this would be the same arithmetic twice and
  -- would happily pass a replay that credits 4000 with 19500 and leaves 4200
  -- short by every promotion the shop ever ran.
  select coalesce(sum(-l.amount_cents), 0) into v_ledger
    from public.journal_lines l
    join public.accounts a on a.id = l.account_id
    join public.journal_entries e on e.id = l.entry_id
   where e.shop_id = v_shop_id and a.code = '4000';
  select coalesce(sum(si.unit_price_cents::bigint * si.quantity), 0) into v_report
    from public.sale_items si join public.sales s on s.id = si.sale_id
   where s.shop_id = v_shop_id;
  if v_ledger <> v_report then
    raise exception 'FAIL: 4000 Revenue is % but the sale lines at list price say % -- off by %',
      v_ledger, v_report, v_ledger - v_report;
  end if;

  ---------------------------------------------------------------------------
  -- 3b. DISCOUNTS. The other half of the same defect.
  ---------------------------------------------------------------------------
  -- 4200 carries all three reductions gross: the order discount, the points
  -- redeemed, and the LINE discounts. A replay that forgets the last one ties
  -- on revenue only if revenue forgot it too.
  --
  -- DERIVED FROM THE IDENTITY, NOT FROM THE THREE COLUMNS THE REPLAY ADDS UP.
  -- complete_sale computes
  --   total = (lines, already net of item discount) - orderDiscount - points + tax
  -- and list price is (lines, already net) + itemDiscount. Rearranged:
  --
  --   orderDiscount + points + itemDiscount  =  list + tax - total
  --
  -- The right-hand side reads unit_price_cents, quantity, sales.tax_cents and
  -- sales.total_cents, and touches neither discount_cents nor
  -- points_redeemed_cents -- the two columns the replay's 4200 expression is
  -- built from. The old assertion added up those same two columns plus the line
  -- discounts, which is the replay's own arithmetic restated: DELETING
  -- points_redeemed_cents from the replay passed it, because both sides lost
  -- the same term. This form cannot, because the total the customer paid
  -- already has the points taken out of it.
  select coalesce(sum(l.amount_cents), 0) into v_ledger
    from public.journal_lines l
    join public.accounts a on a.id = l.account_id
    join public.journal_entries e on e.id = l.entry_id
   where e.shop_id = v_shop_id and a.code = '4200';
  select coalesce((select sum(si.unit_price_cents::bigint * si.quantity)
                     from public.sale_items si join public.sales s2 on s2.id = si.sale_id
                    where s2.shop_id = v_shop_id), 0)
       + coalesce(sum(s.tax_cents), 0)
       - coalesce(sum(s.total_cents), 0)
    into v_report
    from public.sales s where s.shop_id = v_shop_id;
  if v_ledger <> v_report then
    raise exception 'FAIL: 4200 Discounts is % but list price plus tax less what the customers paid says % -- off by %',
      v_ledger, v_report, v_ledger - v_report;
  end if;

  ---------------------------------------------------------------------------
  -- 3c. COGS against the frozen line costs, net of what came back.
  ---------------------------------------------------------------------------
  select coalesce(sum(l.amount_cents), 0) into v_ledger
    from public.journal_lines l
    join public.accounts a on a.id = l.account_id
    join public.journal_entries e on e.id = l.entry_id
   where e.shop_id = v_shop_id and a.code = '5000';
  select coalesce((select sum(si.unit_cost_cents::bigint * si.quantity)
                     from public.sale_items si join public.sales s on s.id = si.sale_id
                    where s.shop_id = v_shop_id and si.unit_cost_cents is not null), 0)
       - coalesce((select sum(si.unit_cost_cents::bigint * ri.quantity)
                     from public.refund_items ri
                     join public.sale_items si on si.id = ri.sale_item_id
                     join public.sales s on s.id = si.sale_id
                    where s.shop_id = v_shop_id and si.unit_cost_cents is not null), 0)
    into v_report;
  if v_ledger <> v_report then
    raise exception 'FAIL: 5000 COGS is % but the frozen line costs less returns say % -- off by %',
      v_ledger, v_report, v_ledger - v_report;
  end if;

  ---------------------------------------------------------------------------
  -- 3d. RECEIVABLES. THE TRAP-4 TIE-OUT.
  ---------------------------------------------------------------------------
  -- 1100 read -500 before the backfill. Afterwards it must equal what is still
  -- owed across every sale: the total, less every payment taken (settlements
  -- included, because those are payments), less the part of each refund that
  -- reduced the debt rather than handing cash back.
  --
  -- That last term is what separates this from customer_balances.owed_cents,
  -- which subtracts the WHOLE of refunds.goods_cents. On a sale paid in full
  -- and then partly returned, the shop hands the money back out of the till --
  -- refunds.total_cents -- and the customer owed nothing before or after, so
  -- the receivable never moves. The view drives that sale's owed_cents to
  -- NEGATIVE 4000 and only avoids showing it because it filters on
  -- `settled_at is null and owed > 0`. This is the divergence the plan records
  -- as the app's, not the backfill's; the ledger is right and the view's
  -- formula is the approximation, so the tie-out is written against the money
  -- rather than against the view.
  --
  -- This is also what proves the replay debits the receivable the sale
  -- ORIGINALLY created rather than what is left of it: netting the settlement
  -- or the refund into the sale's own line would leave 1100 short by exactly
  -- what the already-posted entries moved.
  select coalesce(sum(l.amount_cents), 0) into v_ledger
    from public.journal_lines l
    join public.accounts a on a.id = l.account_id
    join public.journal_entries e on e.id = l.entry_id
   where e.shop_id = v_shop_id and a.code = '1100';
  select coalesce(sum(s.total_cents
           - coalesce((select sum(r.goods_cents - r.total_cents) from public.refunds r where r.sale_id = s.id), 0)
           - coalesce((select sum(sp.amount_cents) from public.sale_payments sp where sp.sale_id = s.id), 0)
         ), 0) into v_report
    from public.sales s where s.shop_id = v_shop_id;
  if v_ledger <> v_report then
    raise exception 'FAIL: 1100 Receivables is % but the sales say % is still owed -- off by %',
      v_ledger, v_report, v_ledger - v_report;
  end if;

  ---------------------------------------------------------------------------
  -- 3e. OPERATING EXPENSES. BOTH DOUBLE-COUNT TRAPS IN ONE TOTAL.
  ---------------------------------------------------------------------------
  -- Compared shop-wide rather than per month, deliberately. Task 7b's trigger
  -- redirects a back-dated expense whose month has closed into the open one and
  -- the backfill does not redirect, so the two legitimately disagree about
  -- WHICH month a cost lands in. They must never disagree about the total.
  --
  -- The report side is every expenses row the replay is responsible for -- the
  -- exclusions applied -- plus the wages, which reach 6200 through the pay
  -- RUN's entry rather than through its expenses row. If the payroll row were
  -- replayed, 6200 would read 14000 and this is 7000 out.
  --
  -- THE BILL'S MIRRORED ROW IS ON BOTH SIDES, and it used to be on neither.
  -- It is a real cost the shop incurred and nothing else posts it, so the
  -- replay writes Dr 6400 Supplies / Cr 2000 for it and this total counts it.
  -- Excluding it -- which is what `and e2.invoice_id is null` did here, and
  -- what the replay itself did -- left the shop's supplies cost missing from
  -- the P&L while the payment against it debited 2000.
  --
  -- The two stock-linked rows come out of the report side as well, and for a
  -- reason that is NOT the exclusions: neither one lands on an account of type
  -- 'expense' at all. The delivery's payment debits 2000 Accounts Payable (a
  -- LIABILITY) and the count's stock_loss row posts nothing. This total is
  -- "operating expenses", so a row that is not one has no business on either
  -- side of it. 3j is where those two are checked, by the accounts they
  -- actually move.
  select coalesce(sum(l.amount_cents), 0) into v_ledger
    from public.journal_lines l
    join public.accounts a on a.id = l.account_id
    join public.journal_entries e on e.id = l.entry_id
   where e.shop_id = v_shop_id and a.type = 'expense';
  --
  -- The three NON-OPERATING categories come out too, and not because of any
  -- exclusion: account_code_for_expense_category sends 'inventory_purchase' to
  -- 1200 (an ASSET), 'owner_draw' to 3100 (CONTRA-EQUITY) and 'stock_loss' to
  -- 5100 (COST OF SALES), so none of the three ever lands on an account of type
  -- 'expense'. That is the whole point of the map -- they stop being expenses
  -- because of where they sit rather than because a reporting helper remembers
  -- to filter them -- and this total is about OPERATING expenses. 3i pins 5100.
  select coalesce((select sum(e2.amount_cents) from public.expenses e2
                    where e2.shop_id = v_shop_id
                      and e2.payroll_run_id is null
                      and e2.stock_receipt_id is null and e2.stock_count_id is null
                      and e2.category not in ('inventory_purchase', 'owner_draw', 'stock_loss')), 0)
       + coalesce((select sum(pr.total_cents) from public.payroll_runs pr
                    where pr.shop_id = v_shop_id and pr.status = 'posted'), 0)
    into v_report;
  if v_ledger <> v_report then
    raise exception 'FAIL: operating expenses are % in the ledger but % in the expenses and payroll tables -- off by %',
      v_ledger, v_report, v_ledger - v_report;
  end if;

  -- And by account, so a wrong exclusion cannot hide inside a right total.
  select coalesce(sum(l.amount_cents), 0) into v_ledger
    from public.journal_lines l
    join public.accounts a on a.id = l.account_id
    join public.journal_entries e on e.id = l.entry_id
   where e.shop_id = v_shop_id and a.code = '6200';
  if v_ledger <> 7000 then
    raise exception 'FAIL: 6200 Salaries and Wages is % for 7000 of wages -- post_payroll_run''s expenses row was replayed on top of its own entry', v_ledger;
  end if;

  select coalesce(sum(l.amount_cents), 0) into v_ledger
    from public.journal_lines l
    join public.accounts a on a.id = l.account_id
    join public.journal_entries e on e.id = l.entry_id
   where e.shop_id = v_shop_id and a.code = '6400';
  if v_ledger <> 5000 then
    raise exception 'FAIL: 6400 Supplies is % for a 5000 bill -- 0 means the bill''s mirrored expense row was skipped and its cost reached no account at all, 10000 means it was posted twice', v_ledger;
  end if;

  -- And the one expense the replay IS responsible for landed on the account its
  -- CATEGORY maps to. Without this, a replay that debited every expense to 6900
  -- Other would tie on the shop-wide total above and be wrong on every line of
  -- the P&L.
  select coalesce(sum(l.amount_cents), 0) into v_ledger
    from public.journal_lines l
    join public.accounts a on a.id = l.account_id
    join public.journal_entries e on e.id = l.entry_id
   where e.shop_id = v_shop_id and a.code = '6000';
  if v_ledger <> 2500 then
    raise exception 'FAIL: 6000 Rent is % for a 2500 rent expense -- the category map was not used', v_ledger;
  end if;

  ---------------------------------------------------------------------------
  -- 3f. THE SUPPLIER SIDE. 2000 Accounts Payable.
  ---------------------------------------------------------------------------
  -- 2000 MUST READ WHAT THE SHOP ACTUALLY OWES, and it is written that way --
  -- as a statement about the four source tables -- rather than as the sum of
  -- the credits and debits the replay wrote, which would be the replay's own
  -- arithmetic restated. Two things raise the payable and two draw it down:
  --
  --   raised by   a BILL being entered   (Dr the category / Cr 2000)
  --               a DELIVERY arriving    (Dr 1200 / Cr 2000)
  --   drawn down  a payment on the bill  (Dr 2000 / Cr the wallet)
  --               the Restock sheet's expense row for the delivery it paid
  --
  -- The bill is 5000 with 3000 paid, so 2000 is owed on it. The delivery is
  -- 2000 and was paid in full on the doorstep, so nothing is owed on it. 2000
  -- therefore reads -2000, a credit, which is what a liability looks like.
  --
  -- THE BILL TERM IS THE ONE THIS CHECK GAINED, and its absence was the whole
  -- of the defect: with the bill's mirror row skipped, the ledger read +1000 --
  -- a liability in DEBIT, saying suppliers owed the shop money -- and the
  -- report side was written to expect exactly that. Both sides quoted the same
  -- missing recognition, so this tie-out passed.
  --
  -- inventory_purchase bills are excluded from the bill term for the reason
  -- 20260908000800 gives: receive_stock's Cr 2000 IS their payable, and there
  -- is none in this fixture, so the exclusion is written out rather than
  -- silently true.
  select coalesce(sum(l.amount_cents), 0) into v_ledger
    from public.journal_lines l
    join public.accounts a on a.id = l.account_id
    join public.journal_entries e on e.id = l.entry_id
   where e.shop_id = v_shop_id and a.code = '2000';
  select coalesce((select sum(ip.amount_cents) from public.invoice_payments ip
                     join public.invoices i on i.id = ip.invoice_id where i.shop_id = v_shop_id), 0)
       - coalesce((select sum(i.amount_cents) from public.invoices i
                    where i.shop_id = v_shop_id and i.category <> 'inventory_purchase'), 0)
       + coalesce((select sum(e2.amount_cents) from public.expenses e2
                    where e2.shop_id = v_shop_id and e2.stock_receipt_id is not null), 0)
       - coalesce((select sum(ri.unit_cost_cents::bigint * ri.quantity)
                     from public.stock_receipt_items ri
                     join public.stock_receipts r on r.id = ri.receipt_id
                    where r.shop_id = v_shop_id and ri.unit_cost_cents is not null), 0)
    into v_report;
  if v_ledger <> v_report then
    raise exception 'FAIL: 2000 Accounts Payable is % but the bills, receipts, bill payments and delivery payments say % -- off by %',
      v_ledger, v_report, v_ledger - v_report;
  end if;
  -- Not vacuous, and not accidentally zero: this fixture owes 2000 on a bill it
  -- has part-paid. A ledger and a report side that were both blind to the bill
  -- would agree at +1000 -- the sign this assertion exists to notice.
  if v_ledger >= 0 then
    raise exception 'FAIL: 2000 Accounts Payable is % -- a liability in DEBIT means the shop''s bills were paid without ever being recognised', v_ledger;
  end if;

  ---------------------------------------------------------------------------
  -- 3g. THE TENDERS, ONE ACCOUNT AT A TIME.
  ---------------------------------------------------------------------------
  -- THE WHOLE POINT OF ONE LINE PER TENDER is that the drawer and the wallet
  -- reconcile separately. Until this check existed nothing in this script read
  -- 1000, 1010, 1020 or 1021 as a total -- so a replay that ignored
  -- account_code_for_payment_method entirely and lumped every tender into 1000
  -- Cash would balance, and would tie on revenue, COGS, discounts, receivables,
  -- payables and every expense account. Sale A alone is 6400 cash and 2000
  -- zaad; a shop counting its till against that ledger would be 2000 over,
  -- every day, with nothing anywhere to explain it.
  --
  -- Constants rather than a re-derivation, because every plausible derivation
  -- of "how much cash" restates either the payment map or the refund's
  -- pro-rata split, which are the two things being checked. The arithmetic:
  --
  --   1000 Cash   +6400 (sale A) +1000 (sale B till) +500 (sale B settlement)
  --               +8000 (sale C) +4300 (sale D)
  --               -4000 (refund C) -2150 (refund D's cash share)
  --               -7000 (pay run) -2500 (rent)
  --               -2000 (the delivery paid on the doorstep)      =  2550
  --
  --   THE STOCK-TAKE IS NOT IN THAT LIST, and its absence is the assertion.
  --   The Count sheet's stock_loss row is 400 and touches no wallet at all:
  --   nothing was paid for stock that walked out. A replay that posted it would
  --   read 2150 here -- the till 400 light, with the shop's shrinkage as the
  --   only explanation and no way to see that from a shrinkage total.
  --
  --   1020 Zaad   +2000 (sale A) +2000 (sale D) -1000 (refund D) =  3000
  --   1021 eDahab -3000 (the supplier paid by eDahab)            = -3000
  --   1010 Bank    nothing in this fixture uses the 'other'
  --                method, which is the only thing mapped here,
  --                so anything landing in it is a mis-mapped
  --                tender                                        =      0
  --
  -- The settlement's 500 is included because it is already in the ledger -- it
  -- was posted live by settle_sale_balance before the backfill ran.
  select coalesce(sum(l.amount_cents), 0) into v_ledger
    from public.journal_lines l
    join public.accounts a on a.id = l.account_id
    join public.journal_entries e on e.id = l.entry_id
   where e.shop_id = v_shop_id and a.code = '1000';
  if v_ledger <> 2550 then
    raise exception 'FAIL: 1000 Cash is %, expected 2550 -- the till and the ledger disagree by %', v_ledger, v_ledger - 2550;
  end if;

  select coalesce(sum(l.amount_cents), 0) into v_ledger
    from public.journal_lines l
    join public.accounts a on a.id = l.account_id
    join public.journal_entries e on e.id = l.entry_id
   where e.shop_id = v_shop_id and a.code = '1020';
  if v_ledger <> 3000 then
    raise exception 'FAIL: 1020 Zaad is %, expected 3000 -- zaad money was posted somewhere else, most likely lumped into 1000 Cash', v_ledger;
  end if;

  select coalesce(sum(l.amount_cents), 0) into v_ledger
    from public.journal_lines l
    join public.accounts a on a.id = l.account_id
    join public.journal_entries e on e.id = l.entry_id
   where e.shop_id = v_shop_id and a.code = '1021';
  if v_ledger <> -3000 then
    raise exception 'FAIL: 1021 eDahab is %, expected -3000 -- the bill paid by eDahab was posted against another wallet', v_ledger;
  end if;

  select coalesce(sum(l.amount_cents), 0) into v_ledger
    from public.journal_lines l
    join public.accounts a on a.id = l.account_id
    join public.journal_entries e on e.id = l.entry_id
   where e.shop_id = v_shop_id and a.code = '1010';
  if v_ledger <> 0 then
    raise exception 'FAIL: 1010 Bank is %, expected 0 -- nothing in this fixture is paid by the "other" method, so a tender was mis-mapped', v_ledger;
  end if;

  ---------------------------------------------------------------------------
  -- 3h. SALES RETURNS AND THE TAX THAT CAME BACK WITH THEM.
  ---------------------------------------------------------------------------
  -- The refund splits goods_cents into 4100 Sales Returns and 2100 Sales Tax
  -- Payable, and BOTH LINES ARE DEBITS ON THE SAME ENTRY that sum to
  -- goods_cents whatever the split is. So a wrong proration basis moves money
  -- between them, balances perfectly, ties on every other account, and was
  -- asserted by nothing at all -- neither account was read anywhere in this
  -- script before this check.
  --
  --   4100 = 4000 (refund C, a sale with no tax: the whole of goods_cents)
  --        + 3000 (refund D: 3150 of goods less the 150 of tax)  = 7000
  --   2100 = -400 (sale A's tax) -300 (sale D's tax)
  --        +150 (refund D's share coming back)                   = -550
  --
  -- The 150 is not this script quoting the replay's formula back at itself:
  -- refund D returns EXACTLY HALF of sale D (3150 of a 6300 total), so exactly
  -- half of the 300 of tax has to come back, on any correct basis. A refund
  -- prorated on the pre-tax figure instead gives 158 and this reddens.
  select coalesce(sum(l.amount_cents), 0) into v_ledger
    from public.journal_lines l
    join public.accounts a on a.id = l.account_id
    join public.journal_entries e on e.id = l.entry_id
   where e.shop_id = v_shop_id and a.code = '4100';
  if v_ledger <> 7000 then
    raise exception 'FAIL: 4100 Sales Returns is %, expected 7000 (4000 untaxed + 3150 less 150 of tax) -- off by %', v_ledger, v_ledger - 7000;
  end if;

  select coalesce(sum(l.amount_cents), 0) into v_ledger
    from public.journal_lines l
    join public.accounts a on a.id = l.account_id
    join public.journal_entries e on e.id = l.entry_id
   where e.shop_id = v_shop_id and a.code = '2100';
  if v_ledger <> -550 then
    raise exception 'FAIL: 2100 Sales Tax Payable is %, expected -550 (700 charged, 150 given back on half of sale D) -- off by %', v_ledger, v_ledger + 550;
  end if;

  ---------------------------------------------------------------------------
  -- 3i. INVENTORY AND SHRINKAGE.
  ---------------------------------------------------------------------------
  -- The stock count posts 1200 and 5100 as a self-balancing pair, and so does
  -- the receipt's 1200 against 2000. Both were unasserted, and both are
  -- therefore places where the WRONG ACCOUNT passes every other check in this
  -- file: a count that wrote its variance to 6900 Other still balances, still
  -- zeroes the trial balance, and moves a stock loss out of cost of sales and
  -- into operating expenses -- the exact presentation error 20260908000000
  -- exists to prevent.
  --
  --   1200 = +2000 (delivery) -400 (count, 2 sacks short at 200)
  --          -12000 (the cost of everything sold: 6000 + 1000 + 3000 + 2000)
  --          +2500 (the cost of what came back: 1500 + 1000)
  --          -700 (the standalone write-off's contra)            = -8600
  --   5100 = +400 (the count's other half)
  --          +700 (the standalone write-off)                     =   1100
  --
  -- NEITHER FIGURE CHANGED WHEN THE TWO CLIENT ROWS JOINED THE FIXTURE, AND
  -- THAT IS THE POINT. The delivery's payment settles 2000 and never touches
  -- 1200; the stock-take's write-off posts nothing at all. Before
  -- 20260908000800 those two rows added +2000 to 1200 and +400 to 5100 -- the
  -- shop's stock and its whole shrinkage, both doubled, with every entry
  -- balancing. These two assertions are what would have caught it.
  --
  -- 1200 is derived from the four source tables rather than pinned to -7900,
  -- because each of the four terms is written by a different lines statement
  -- and the total is what proves they agree.
  --
  -- THE OPENING ENTRY IS EXCLUDED FROM THIS ONE, and included in the two below
  -- it. What this figure measures is the MOVEMENTS -- the four lines statements
  -- agreeing with the rows they replay -- and it is exactly as sharp as it was
  -- before 20260908001300. What it is no longer is the shop's inventory: -8600
  -- is a negative asset, which is the whole defect that migration exists to
  -- remove, and asserting the total against it would pin the defect in place.
  select coalesce(sum(l.amount_cents), 0) into v_ledger
    from public.journal_lines l
    join public.accounts a on a.id = l.account_id
    join public.journal_entries e on e.id = l.entry_id
   where e.shop_id = v_shop_id and a.code = '1200' and e.source <> 'opening';
  select coalesce((select sum(ri.unit_cost_cents::bigint * ri.quantity)
                     from public.stock_receipt_items ri
                     join public.stock_receipts r on r.id = ri.receipt_id
                    where r.shop_id = v_shop_id and ri.unit_cost_cents is not null), 0)
       + coalesce((select sum(ci.unit_cost_cents::bigint * (ci.counted_quantity - ci.previous_quantity))
                     from public.stock_count_items ci
                     join public.stock_counts c on c.id = ci.count_id
                    where c.shop_id = v_shop_id and ci.unit_cost_cents is not null), 0)
       - coalesce((select sum(si.unit_cost_cents::bigint * si.quantity)
                     from public.sale_items si join public.sales s on s.id = si.sale_id
                    where s.shop_id = v_shop_id and si.unit_cost_cents is not null), 0)
       + coalesce((select sum(si.unit_cost_cents::bigint * ri2.quantity)
                     from public.refund_items ri2
                     join public.sale_items si on si.id = ri2.sale_item_id
                     join public.sales s on s.id = si.sale_id
                    where s.shop_id = v_shop_id and si.unit_cost_cents is not null), 0)
       - coalesce((select sum(e2.amount_cents) from public.expenses e2
                    where e2.shop_id = v_shop_id and e2.category = 'stock_loss'
                      and e2.stock_count_id is null), 0)
    into v_report;
  if v_ledger <> v_report then
    raise exception 'FAIL: the 1200 Inventory MOVEMENTS are % but the deliveries, count, sales, returns and write-offs say % -- off by %',
      v_ledger, v_report, v_ledger - v_report;
  end if;

  ---------------------------------------------------------------------------
  -- 3i-2. AND 1200 IS WHAT IS ACTUALLY ON THE SHELF. THE HEADLINE ASSERTION.
  ---------------------------------------------------------------------------
  -- The movements above sum to -8600: a NEGATIVE ASSET, over books whose trial
  -- balance is perfectly zero. That is the state a real shop was found in --
  -- 1200 in credit $1,100 after 54 entries that all reconciled -- and it is
  -- what 20260908001300 exists to end. Every check in this file passed while it
  -- was true, which is why this one had to be added rather than inferred.
  --
  -- 1600, spelled out: eight sacks of rice on the shelf at 200 each. The
  -- fixture's product is created with `stock: 8` and no stock_receipts row
  -- behind it, exactly as a product form or a CSV import leaves things, and the
  -- count above counted the same eight. ASSERTED AS A LITERAL, computed by hand
  -- from the fixture, NOT as sum(stock * cost_cents) -- that is the expression
  -- the migration itself uses, and re-running it here would be the same
  -- arithmetic twice: it would pass a build that valued stock at price_cents,
  -- or at zero, or not at all, as long as both sides moved together.
  select coalesce(sum(l.amount_cents), 0) into v_ledger
    from public.journal_lines l
    join public.accounts a on a.id = l.account_id
    join public.journal_entries e on e.id = l.entry_id
   where e.shop_id = v_shop_id and a.code = '1200';
  if v_ledger <> 1600 then
    raise exception 'FAIL: 1200 Inventory reads % after the replay, expected 1600 -- eight sacks at 200 is what is on the shelf. -8600 means no opening balance was posted and the asset is negative; 10200 means the opening balance was posted without the movements being netted off it', v_ledger;
  end if;

  -- ...and it got there through ONE opening entry, of the amount the door
  -- predicted before the run. 10200 = 1600 on the shelf + 8600 the ledger had
  -- taken out of it, and it is the value of the stock the shop must have opened
  -- with: 43 sacks' worth of goods that no delivery ever accounted for.
  --
  -- Both halves are asserted. The 1200 debit is what makes the balance sheet
  -- true; the 3000 credit is where it came from, and a build that debited 1200
  -- against 5100 or 4000 would pass every other check in this file while
  -- inventing profit or cost out of nothing.
  --
  -- MUTATION (proves the 1600): drop the "less what the ledger already holds
  -- against 1200" term from opening_inventory_gap, i.e. open with today's stock
  -- and nothing else -- the first framing 20260908001300's header rejects.
  -- Expected: FAIL: 1200 Inventory reads -7000 after the replay, expected 1600.
  --
  -- MUTATION (proves the door/replay pin below): drop the
  -- `- public.unposted_inventory_movement(p_shop_id)` term. THE REPLAY IS
  -- UNAFFECTED -- by the time it calls the function that term is already zero,
  -- which is the property the whole design rests on -- so only the DOOR moves,
  -- and the pin is the only thing in this file that can see it. Expected:
  -- FAIL: the door predicted an opening balance of 1600 and the replay posted
  -- 10200.
  select count(*) into v_rows from public.journal_entries
   where shop_id = v_shop_id and source = 'opening';
  if v_rows <> 1 then
    raise exception 'FAIL: % opening entries were written, expected exactly 1', v_rows;
  end if;

  select coalesce(sum(l.amount_cents), 0) into v_ledger
    from public.journal_lines l
    join public.accounts a on a.id = l.account_id
    join public.journal_entries e on e.id = l.entry_id
   where e.shop_id = v_shop_id and a.code = '1200' and e.source = 'opening';
  if v_ledger <> 10200 then
    raise exception 'FAIL: the opening entry debits % to 1200 Inventory, expected 10200 (1600 on the shelf plus the 8600 the replay took out of it)', v_ledger;
  end if;
  if v_ledger <> v_open_expected then
    raise exception 'FAIL: the door predicted an opening balance of % and the replay posted % -- the Post History card promises a figure the run does not write',
      v_open_expected, v_ledger;
  end if;

  select coalesce(sum(l.amount_cents), 0) into v_ledger
    from public.journal_lines l
    join public.accounts a on a.id = l.account_id
    join public.journal_entries e on e.id = l.entry_id
   where e.shop_id = v_shop_id and a.code = '3000';
  if v_ledger <> -10200 then
    raise exception 'FAIL: 3000 Owner''s Capital is % after the opening entry, expected -10200 -- opening stock is capital the owner put in, not revenue and not a reversal of cost', v_ledger;
  end if;

  -- And no location on either line. The amount is a shop-level residue: a large
  -- part of what it nets off carries no location at all (sales.location_id
  -- arrived in 20260809000000, expenses.location_id in 20260816000000), so a
  -- per-branch split would charge today's shelf to the branches while the
  -- shop's own history fell into a null bucket. See 20260908001300's header.
  if exists (select 1 from public.journal_lines l
               join public.journal_entries e on e.id = l.entry_id
              where e.shop_id = v_shop_id and e.source = 'opening'
                and (l.location_id is not null or e.location_id is not null)) then
    raise exception 'FAIL: the opening entry carries a location -- the plug is shop-level and a branch figure derived from it would be exact-looking and unfounded';
  end if;

  select coalesce(sum(l.amount_cents), 0) into v_ledger
    from public.journal_lines l
    join public.accounts a on a.id = l.account_id
    join public.journal_entries e on e.id = l.entry_id
   where e.shop_id = v_shop_id and a.code = '5100';
  if v_ledger <> 1100 then
    raise exception 'FAIL: 5100 Inventory Shrinkage is %, expected 1100 (400 from the count, 700 from the standalone write-off) -- 1500 = the count''s stock_loss expense was replayed on top of the count', v_ledger;
  end if;

  ---------------------------------------------------------------------------
  -- 3j. THE TWO CLIENT PAIRS, REPLAYED THE WAY THE LIVE PATH POSTS THEM.
  ---------------------------------------------------------------------------
  -- THIS IS THE EQUIVALENCE THE WHOLE PHASE TURNS ON. verify-posting-expenses
  -- checks 9 and 10 assert what the trigger does with a row written today;
  -- these assert the replay reaches the same accounts and the same figures for
  -- the same pair sitting in history. If the two ever part company, a shop's
  -- books change shape on the day it is migrated -- and the totals above would
  -- not show it, because a replay and a trigger that disagree still each
  -- balance.
  --
  -- Written per ENTRY rather than as a shop-wide total, deliberately: 3f and 3i
  -- already tie the totals, and a total cannot distinguish "the delivery's
  -- payment settled 2000" from "something else moved 2000 by the same amount".
  --
  -- (a) The delivery and its payment, together, leave 2000 at nothing. The
  --     receipt credited 2000 and the expense debits the same 2000 back: a shop
  --     that pays cash on the doorstep must not accumulate a payable that grows
  --     for ever.
  select coalesce(sum(l.amount_cents), 0) into v_ledger
    from public.journal_lines l
    join public.accounts a on a.id = l.account_id
   where a.code = '2000'
     and l.entry_id in (select journal_entry_id from public.stock_receipts where id = v_receipt
                        union all
                        select journal_entry_id from public.expenses where id = v_recpt_exp);
  if v_ledger <> 0 then
    raise exception 'FAIL: the delivery and the expense that paid for it leave 2000 Accounts Payable at %, expected 0 (-2000 = the payment debited 1200 instead of settling the payable)', v_ledger;
  end if;

  -- (b) ...and 1200 moved ONCE across the pair, by the delivery alone.
  select coalesce(sum(l.amount_cents), 0) into v_ledger
    from public.journal_lines l
    join public.accounts a on a.id = l.account_id
   where a.code = '1200'
     and l.entry_id in (select journal_entry_id from public.stock_receipts where id = v_receipt
                        union all
                        select journal_entry_id from public.expenses where id = v_recpt_exp);
  if v_ledger <> 2000 then
    raise exception 'FAIL: 1200 Inventory moved % across the delivery and its payment, expected 2000 (4000 = the goods were recognised twice)', v_ledger;
  end if;

  -- (c) The stock-take's expense row was not replayed at all. Asserted on the
  --     row rather than on 5100, which 3i already pins: this is the statement
  --     that the row is DELIBERATELY left unposted for ever, not one the replay
  --     happened to miss.
  select journal_entry_id into v_entry from public.expenses where id = v_count_exp;
  if v_entry is not null then
    raise exception 'FAIL: the stock-take''s stock_loss expense was replayed -- save_stock_count already posted Dr 5100 / Cr 1200 for it';
  end if;

  ---------------------------------------------------------------------------
  -- 3k. A HISTORICAL BILL AND ITS PAYMENT REPLAY TO THE SAME FIGURES THE LIVE
  --     PATH POSTS. verify-posting-bills.sql checks 11-13 are its other half.
  ---------------------------------------------------------------------------
  -- Written per ENTRY for the reason 3j is: 3e and 3f tie the totals, and a
  -- total cannot tell "the bill recognised 5000 of supplies against a payable"
  -- from "something else moved the same amount".
  --
  -- The bill is 5000 with 3000 paid by eDahab. Live, that is
  --   Dr 6400 Supplies 5000 / Cr 2000 Payable 5000   when it is entered
  --   Dr 2000 Payable  3000 / Cr 1021 eDahab 3000    when it is paid
  -- and the replay must reach exactly those two entries, leaving 2000 across
  -- the pair at -2000: the part of the bill still outstanding. Before this fix
  -- the first entry did not exist at all, and 2000 across the pair read +3000 --
  -- a supplier apparently owing the shop money it had just been paid.
  select journal_entry_id into v_entry from public.expenses where invoice_id = v_invoice;
  if v_entry is null then
    raise exception 'FAIL: the bill''s mirrored expense row was not replayed -- nothing else posts a bill, so its cost is nowhere in the replayed books';
  end if;

  select coalesce(sum(l.amount_cents), 0) into v_ledger
    from public.journal_lines l join public.accounts a on a.id = l.account_id
   where l.entry_id = v_entry and a.code = '6400';
  if v_ledger <> 5000 then
    raise exception 'FAIL: the replayed bill debits % to 6400 Supplies, expected 5000', v_ledger;
  end if;
  select coalesce(sum(l.amount_cents), 0) into v_ledger
    from public.journal_lines l join public.accounts a on a.id = l.account_id
   where l.entry_id = v_entry and a.code = '2000';
  if v_ledger <> -5000 then
    raise exception 'FAIL: the replayed bill credits % to 2000 Accounts Payable, expected -5000', v_ledger;
  end if;
  -- And no wallet. The mirror row's payment_method is the literal 'other'
  -- sync_invoice_expense writes for a bill that has no payment method, and
  -- 'other' maps to 1010 Bank -- so a replay that fell through to the generic
  -- branch would credit the shop's bank for a bill nobody has paid. 3g's 1010
  -- assertion catches it too; this says which statement did it.
  if exists (select 1 from public.journal_lines l join public.accounts a on a.id = l.account_id
              where l.entry_id = v_entry and a.code in ('1000', '1010', '1020', '1021')) then
    raise exception 'FAIL: the replayed bill credited a wallet -- entering a bill moves no money, and payment_method ''other'' lands in 1010 Bank';
  end if;

  -- The pair, and what it leaves outstanding. Read from `invoices` rather than
  -- re-derived from the lines this assertion is about.
  select coalesce(sum(l.amount_cents), 0) into v_ledger
    from public.journal_lines l join public.accounts a on a.id = l.account_id
   where a.code = '2000'
     and (l.entry_id = v_entry
          or l.entry_id in (select journal_entry_id from public.invoice_payments
                             where invoice_id = v_invoice));
  select i.amount_cents - coalesce((select sum(ip.amount_cents) from public.invoice_payments ip
                                     where ip.invoice_id = i.id), 0)
    into v_report
    from public.invoices i where i.id = v_invoice;
  if v_ledger <> -v_report then
    raise exception 'FAIL: the replayed bill and its payment leave 2000 Accounts Payable at %, but % of the bill is unpaid (+3000 = the bill never raised the payable the payment cleared)',
      v_ledger, v_report;
  end if;

  -- And the inventory_purchase bill was NOT replayed. Asserted on the row
  -- rather than on a total, for the reason 3j(c) gives about the count's
  -- write-off: this is the statement that the row is DELIBERATELY left unposted
  -- for ever, not one the replay happened to miss. receive_stock already put
  -- those goods into 1200 against 2000.
  select count(*) into v_rows
    from public.expenses e join public.invoices i on i.id = e.invoice_id
   where e.shop_id = v_shop_id and i.category = 'inventory_purchase'
     and e.journal_entry_id is not null;
  if v_rows <> 0 then
    raise exception 'FAIL: % inventory_purchase bills were replayed -- the delivery already debited 1200 against 2000 for those goods', v_rows;
  end if;
  -- Not vacuous: the fixture holds exactly one such bill.
  select count(*) into v_rows from public.invoices
   where shop_id = v_shop_id and category = 'inventory_purchase';
  if v_rows <> 1 then
    raise exception 'FAIL: the fixture holds % inventory_purchase bills, expected 1 -- the assertion above is looking at nothing', v_rows;
  end if;

  ---------------------------------------------------------------------------
  -- 4. EVERY entry balances, and the trial balance is zero.
  ---------------------------------------------------------------------------
  -- SET CONSTRAINTS IMMEDIATE, because journal_entry_balances is DEFERRABLE
  -- INITIALLY DEFERRED and fires at COMMIT -- and this script rolls back rather
  -- than committing, so without this the one guarantee the backfill relies on
  -- for inserting directly would never actually be exercised here.
  begin
    set constraints journal_entry_balances immediate;
  exception when others then
    raise exception 'FAIL: a backfilled entry does not balance -- %', sqlerrm;
  end;
  set constraints all deferred;

  select coalesce(sum(l.amount_cents), 0) into v_ledger
    from public.journal_lines l join public.journal_entries e on e.id = l.entry_id
   where e.shop_id = v_shop_id;
  if v_ledger <> 0 then
    raise exception 'FAIL: the trial balance does not zero, off by %', v_ledger;
  end if;

  -- No entry left standing with nothing under it. assert_journal_balances
  -- deliberately ALLOWS a zero-line entry, so this is the only thing that
  -- catches a replay whose lines were all dropped by a missing account.
  select count(*) into v_rows
    from public.journal_entries e
   where e.shop_id = v_shop_id
     and (select count(*) from public.journal_lines l where l.entry_id = e.id) < 2;
  if v_rows <> 0 then
    raise exception 'FAIL: % entries were written with fewer than two lines', v_rows;
  end if;

  ---------------------------------------------------------------------------
  -- 5. NOTHING IS LEFT UNPOSTED.
  ---------------------------------------------------------------------------
  -- A backfill that quietly skipped rows would pass every total above, because
  -- both sides would be short by the same amount.
  -- Sale E is exempt for the same reason the stock_count_id expense row below
  -- is: it carries no money, so there is no entry for it to point at and never
  -- will be. Exempted by ID rather than by re-stating the replay's own "carries
  -- money" predicate, which would be the same arithmetic twice and would pass a
  -- replay that skipped a sale that DOES carry money. Check 13 is what asserts
  -- this one was skipped for the right reason.
  select count(*) into v_rows from public.sales
   where shop_id = v_shop_id and journal_entry_id is null and id <> v_sale_e;
  if v_rows <> 0 then raise exception 'FAIL: % sales are still unposted', v_rows; end if;

  select count(*) into v_rows from public.refunds r
    join public.sales s on s.id = r.sale_id
   where s.shop_id = v_shop_id and r.journal_entry_id is null;
  if v_rows <> 0 then raise exception 'FAIL: % refunds are still unposted', v_rows; end if;

  select count(*) into v_rows from public.sale_payments sp
    join public.sales s on s.id = sp.sale_id
   where s.shop_id = v_shop_id and sp.is_settlement and sp.journal_entry_id is null;
  if v_rows <> 0 then raise exception 'FAIL: % settlements are still unposted', v_rows; end if;

  select count(*) into v_rows from public.stock_receipts
   where shop_id = v_shop_id and journal_entry_id is null;
  if v_rows <> 0 then raise exception 'FAIL: % stock receipts are still unposted', v_rows; end if;

  select count(*) into v_rows from public.stock_counts
   where shop_id = v_shop_id and journal_entry_id is null;
  if v_rows <> 0 then raise exception 'FAIL: % stock counts are still unposted', v_rows; end if;

  select count(*) into v_rows from public.invoice_payments ip
    join public.invoices i on i.id = ip.invoice_id
   where i.shop_id = v_shop_id and ip.journal_entry_id is null;
  if v_rows <> 0 then raise exception 'FAIL: % supplier payments are still unposted', v_rows; end if;

  select count(*) into v_rows from public.payroll_runs
   where shop_id = v_shop_id and status = 'posted' and journal_entry_id is null;
  if v_rows <> 0 then raise exception 'FAIL: % posted pay runs are still unposted', v_rows; end if;

  -- Two exemptions here, and both leave a row with journal_entry_id null FOR
  -- EVER by design. stock_count_id: save_stock_count posted both sides of that
  -- write-off itself. An inventory_purchase BILL: receive_stock already put the
  -- goods into 1200 against 2000. Dropping either clause would make this check
  -- red on a correct replay -- the exact shape of no-op-in-reverse this suite
  -- has been bitten by before.
  --
  -- invoice_id is NOT exempt on its own, and that is the change: an ordinary
  -- bill's mirrored row is replayed like any other cost, so leaving it unposted
  -- is now a failure this check catches rather than the behaviour it demanded.
  select count(*) into v_rows from public.expenses
   where shop_id = v_shop_id and journal_entry_id is null
     and payroll_run_id is null and stock_count_id is null
     and not (invoice_id is not null and category = 'inventory_purchase');
  if v_rows <> 0 then raise exception 'FAIL: % expenses are still unposted', v_rows; end if;

  ---------------------------------------------------------------------------
  -- 15. THE DOOR AND THE REPLAY AGREE -- AFTER, AND ON THE DATES.
  ---------------------------------------------------------------------------
  -- The other direction of check 14, and the one the empty state rests on:
  -- every kind now reads 0. This is not a restatement of check 5 -- check 5
  -- asks the eight BASE TABLES directly and exempts the permanently-unposted
  -- rows by hand; this asks THE VIEW, which must reach the same answer through
  -- its own copy of the predicates. A view whose exclusions are wrong reads
  -- non-zero here on rows check 5 has already excused.
  select coalesce(sum(rows_unposted), 0) into v_rows from public.unposted_ledger_counts(v_shop_id);
  if v_rows <> 0 then
    select string_agg(kind || '=' || rows_unposted, ' ' order by kind) into v_text
      from public.unposted_ledger_counts(v_shop_id) where rows_unposted <> 0;
    raise exception 'FAIL: the door still shows % rows unposted after a complete replay: %', v_rows, v_text;
  end if;

  -- And the date the door promised is the date the replay used. The view
  -- carries its own copy of shop_local_date(created_at) / occurred_on /
  -- paid_on, so a door reading a bare ::date would tell a shop its history
  -- starts a day earlier than the ledger says it does -- the same off-by-one
  -- check 7 exists for, on the other side of the glass.
  select min(entry_date) into v_date from public.journal_entries where shop_id = v_shop_id;
  if v_date <> v_bf_oldest then
    raise exception 'FAIL: the door said the oldest unposted row was %, the replay dated the oldest entry %', v_bf_oldest, v_date;
  end if;

  ---------------------------------------------------------------------------
  -- 6. IDEMPOTENT.
  ---------------------------------------------------------------------------
  v_posted := public.backfill_shop_ledger(v_shop_id);
  if v_posted <> 0 then
    raise exception 'FAIL: a second backfill wrote % more entries', v_posted;
  end if;
  select coalesce(sum(-l.amount_cents), 0) into v_ledger
    from public.journal_lines l
    join public.accounts a on a.id = l.account_id
    join public.journal_entries e on e.id = l.entry_id
   where e.shop_id = v_shop_id and a.code = '4000';
  if v_ledger <> 27000 then
    raise exception 'FAIL: revenue is % after a second run, expected 27000', v_ledger;
  end if;
  select count(*) into v_rows from public.journal_entries where shop_id = v_shop_id;
  if v_rows <> 16 then
    raise exception 'FAIL: a second run left % entries, expected 16', v_rows;
  end if;

  -- AND NO SECOND OPENING BALANCE. The eight replays are held down by
  -- journal_entry_id; the opening entry has no source row and therefore no
  -- pointer, so it is held down by opening_inventory_gap() returning 0 once one
  -- exists. Counted separately from the total above because a second opening
  -- entry would be balanced, would leave the trial balance at zero, and would
  -- simply double the shop's inventory -- the same shape of failure this file's
  -- check 10 exists for on settlements.
  select count(*) into v_rows from public.journal_entries
   where shop_id = v_shop_id and source = 'opening';
  if v_rows <> 1 then
    raise exception 'FAIL: a second backfill left % opening entries, expected 1', v_rows;
  end if;

  ---------------------------------------------------------------------------
  -- 7. Entries are dated on their SOURCE ROW, in the SHOP'S local time.
  ---------------------------------------------------------------------------
  if exists (
    select 1 from public.journal_entries e join public.sales s on s.journal_entry_id = e.id
     where e.shop_id = v_shop_id and e.entry_date <> public.shop_local_date(s.created_at)
  ) then
    raise exception 'FAIL: a backfilled entry is not dated on its sale''s local date';
  end if;

  -- Named explicitly, because the general check above would also pass a replay
  -- that used a bare ::date if every fixture sale happened mid-afternoon. Sale
  -- A is rung at 22:30 UTC, which is the NEXT day in Mogadishu.
  select entry_date into v_date from public.journal_entries e
    join public.sales s on s.journal_entry_id = e.id where s.id = v_sale_a;
  if v_date <> v_old_local then
    raise exception 'FAIL: the old sale should be dated % in the shop''s own time, got % (a bare ::date gives %)',
      v_old_local, v_date, v_old_at::date;
  end if;
  if v_date >= public.shop_local_date() then
    raise exception 'FAIL: a three-month-old sale was dated %, i.e. stamped when the backfill ran', v_date;
  end if;

  -- The pay run is dated when it was PAID, not on period_end and not today.
  select e.entry_date into v_date from public.journal_entries e
    join public.payroll_runs pr on pr.journal_entry_id = e.id where pr.id = v_run_id;
  if v_date <> public.shop_local_date(now() - interval '15 days') then
    raise exception 'FAIL: the pay run should be dated when it was posted (%), got %',
      public.shop_local_date(now() - interval '15 days'), v_date;
  end if;

  -- The expense is dated occurred_on, not created_at and not today.
  select e.entry_date into v_date from public.journal_entries e
    join public.expenses x on x.journal_entry_id = e.id where x.id = v_expense;
  if v_date <> public.shop_local_date() - 8 then
    raise exception 'FAIL: the expense should be dated occurred_on (%), got %',
      public.shop_local_date() - 8, v_date;
  end if;

  ---------------------------------------------------------------------------
  -- 9. References come from journal_entry_sequences.
  ---------------------------------------------------------------------------
  -- Checked before check 8 tears the ledger down. Two things: no two entries
  -- share a reference, and the counter was left holding the number the NEXT
  -- caller gets -- so a live posting after the backfill cannot collide with it.
  -- A parallel scheme (a restart at 1, an 'R' or 'E' prefix) passes neither.
  select count(*) into v_rows from (
    select reference from public.journal_entries
     where shop_id = v_shop_id group by reference having count(*) > 1) d;
  if v_rows <> 0 then
    raise exception 'FAIL: % references were allocated twice', v_rows;
  end if;

  select max(e.reference) into v_max_ref from public.journal_entries e
   where e.shop_id = v_shop_id and to_char(e.entry_date, 'YYYY') = to_char(public.shop_local_date(), 'YYYY');
  select next_number into v_seq from public.journal_entry_sequences
   where shop_id = v_shop_id and year = to_char(public.shop_local_date(), 'YYYY');
  if v_seq is null then
    raise exception 'FAIL: the backfill allocated no numbers from journal_entry_sequences';
  end if;
  if 'JE-' || to_char(public.shop_local_date(), 'YYYY') || '-' || lpad((v_seq - 1)::text, 4, '0') <> v_max_ref then
    raise exception 'FAIL: the counter says the last number was %, but the highest reference is % -- the backfill numbered outside journal_entry_sequences',
      v_seq - 1, v_max_ref;
  end if;

  -- And a live posting still works, without a unique violation on
  -- (shop_id, reference). This is the failure a parallel numbering scheme
  -- causes and nothing else in this script would see.
  v_entry := public.post_journal_entry(
    v_shop_id, public.shop_local_date(), 'A manual entry after the backfill',
    jsonb_build_array(
      jsonb_build_object('code', '1000', 'amount_cents',  100),
      jsonb_build_object('code', '3000', 'amount_cents', -100)));
  select reference into v_text from public.journal_entries where id = v_entry;
  if v_text <> 'JE-' || to_char(public.shop_local_date(), 'YYYY') || '-' || lpad(v_seq::text, 4, '0') then
    raise exception 'FAIL: the entry posted after the backfill took reference %, expected the counter''s next number %',
      v_text, 'JE-' || to_char(public.shop_local_date(), 'YYYY') || '-' || lpad(v_seq::text, 4, '0');
  end if;
  -- Kept out of check 8's teardown along with the settlement's entry: it was
  -- posted live, not backfilled, and deleting it would test a different shop.
  v_pre := v_pre || v_entry;

  ---------------------------------------------------------------------------
  -- 10. THE SETTLEMENT WAS NOT RE-POSTED.
  ---------------------------------------------------------------------------
  -- sale_payments.journal_entry_id is null on every till payment of every sale
  -- -- complete_sale folds those into the sale's own entry and never stamps the
  -- row. A replay driven by that column alone would post a second entry for
  -- each of them. There are four non-settlement payment rows in this fixture.
  select count(*) into v_rows from public.journal_entries
   where shop_id = v_shop_id and source = 'settlement';
  if v_rows <> 1 then
    raise exception 'FAIL: % settlement entries exist, expected exactly the one live RPC posted', v_rows;
  end if;

  ---------------------------------------------------------------------------
  -- 11. Backfilled entries carry their TRUE source.
  ---------------------------------------------------------------------------
  -- Not a 'backfill' marker: a P&L must not care whether an entry was posted
  -- live or replayed, and a report filtering on source would silently drop
  -- replayed history.
  select string_agg(distinct source, ',' order by source) into v_text
    from public.journal_entries where shop_id = v_shop_id;
  if v_text <> 'bill,count,manual,opening,payment,payroll,refund,sale,settlement,stock' then
    raise exception 'FAIL: the sources written are "%", expected bill,count,manual,opening,payment,payroll,refund,sale,settlement,stock', v_text;
  end if;

  ---------------------------------------------------------------------------
  -- 8. A CLOSED PERIOD DOES NOT ABORT THE REPLAY.
  ---------------------------------------------------------------------------
  -- The backfill inserts directly and never consults open_period_for, which
  -- raises on a closed month. Without that, a shop that closed a month during
  -- phase 1 would have its replay die half-way and be left in a state strictly
  -- worse than not having started.
  --
  -- Everything the backfill wrote is torn down first; the settlement's entry
  -- and the manual entry from check 9 stay, because they were not backfilled.
  update public.sales set journal_entry_id = null
   where shop_id = v_shop_id and not (journal_entry_id = any(v_pre));
  update public.refunds r set journal_entry_id = null
   where r.sale_id in (select id from public.sales where shop_id = v_shop_id)
     and not (r.journal_entry_id = any(v_pre));
  update public.sale_payments sp set journal_entry_id = null
   where sp.sale_id in (select id from public.sales where shop_id = v_shop_id)
     and not (sp.journal_entry_id = any(v_pre));
  update public.stock_receipts set journal_entry_id = null where shop_id = v_shop_id;
  update public.stock_counts   set journal_entry_id = null where shop_id = v_shop_id;
  update public.invoice_payments ip set journal_entry_id = null
   where ip.invoice_id in (select id from public.invoices where shop_id = v_shop_id);
  update public.payroll_runs set journal_entry_id = null where shop_id = v_shop_id;
  update public.expenses set journal_entry_id = null
   where shop_id = v_shop_id and not (journal_entry_id = any(v_pre));
  delete from public.journal_entries
   where shop_id = v_shop_id and not (id = any(v_pre));

  update public.accounting_periods set status = 'closed'
   where shop_id = v_shop_id and starts_on = date_trunc('month', v_old_local)::date;

  -- AND A SECOND MONTH IS LOCKED, which is the stronger half. `closed` is at
  -- least reversible and audited; `locked` is documented at 20260904000200 as
  -- "nothing posts, ever. Manual, deliberate, final" -- and the replay posts
  -- into it regardless.
  --
  -- IT HAS TO BE THE CURRENT MONTH, because this fixture spans exactly two:
  -- v_old_local's, three months back, which the line above just closed, and this
  -- one, which everything else sits in. It is put back to 'open' immediately
  -- after the replay's status assertions below -- checks 12 and 13 ring live
  -- sales, and a locked current month would refuse them. That restore is a
  -- fixture step, not a claim about the replay: the assertions that matter all
  -- read the period BEFORE it happens.
  v_lock_month := date_trunc('month', public.shop_local_date()::timestamp)::date;
  if v_lock_month = date_trunc('month', v_old_local)::date then
    raise exception 'FIXTURE: the closed month and the locked month are the same month, so check 8b proves nothing';
  end if;
  update public.accounting_periods set status = 'locked'
   where shop_id = v_shop_id and starts_on = v_lock_month;
  if not found then
    raise exception 'FIXTURE: no accounting_periods row starting % to lock', v_lock_month;
  end if;

  -- open_period_for raises on both months now. Asserted, so this check cannot
  -- quietly become a no-op if the periods never actually shut.
  begin
    perform public.open_period_for(v_shop_id, v_old_local);
    raise exception 'FIXTURE: the month of % is not actually closed, so check 8 proves nothing', v_old_local;
  exception when others then
    if sqlerrm like 'FIXTURE:%' then raise; end if;
  end;
  begin
    perform public.open_period_for(v_shop_id, v_lock_month);
    raise exception 'FIXTURE: the month of % is not actually locked, so check 8b proves nothing', v_lock_month;
  exception when others then
    if sqlerrm like 'FIXTURE:%' then raise; end if;
  end;

  ---------------------------------------------------------------------------
  -- 8b. AND THE DOOR SAYS SO BEFORE ANYONE PRESSES ANYTHING.
  ---------------------------------------------------------------------------
  -- The replay walking through a shut month is deliberate -- a per-row
  -- open_period_for is what would abort a shop's history half-way -- but until
  -- this function existed the screen said the opposite of what happens ("a month
  -- you have already closed is re-opened to receive it": it is not re-opened,
  -- not re-closed, and no audit row is written). An owner who locked a month on
  -- purpose is entitled to know before they press, not afterwards.
  --
  -- Both statuses always come back, zeroes included, for the reason the eight
  -- kinds do: "we looked and found none" and "we did not look" must not render
  -- the same.
  --
  -- MUTATION (proves this check): drop the `ap.status` join condition from
  -- unposted_ledger_period_exposure so every landing row counts as closed.
  -- Expected: FAIL: the door reports 0 locked months, expected 1.
  select count(*) into v_rows from public.unposted_ledger_period_exposure(v_shop_id);
  if v_rows <> 2 then
    raise exception 'FAIL: unposted_ledger_period_exposure returned % statuses, expected both closed and locked including the zeroes', v_rows;
  end if;
  select months, entries into v_bf_kinds, v_rows
    from public.unposted_ledger_period_exposure(v_shop_id) where status = 'closed';
  if v_bf_kinds <> 1 then
    raise exception 'FAIL: the door reports % closed months, expected 1 -- the replay is about to write into one', v_bf_kinds;
  end if;
  if v_rows <= 0 then
    raise exception 'FAIL: the door reports % entries landing in a closed month -- it found the month but not what lands in it', v_rows;
  end if;
  select months, entries into v_bf_kinds, v_rows
    from public.unposted_ledger_period_exposure(v_shop_id) where status = 'locked';
  if v_bf_kinds <> 1 then
    raise exception 'FAIL: the door reports % locked months, expected 1 -- a locked month is documented as final and the replay posts into it anyway', v_bf_kinds;
  end if;
  if v_rows <= 0 then
    raise exception 'FAIL: the door reports % entries landing in a locked month -- it found the month but not what lands in it', v_rows;
  end if;

  -- AND THE RE-RUN IS PUSHED PAST 9,999, which is the second thing this block
  -- now proves. lpad(n::text, 4, '0') TRUNCATES a longer string:
  -- lpad('10000', 4, '0') is '1000', entry 1000's reference, and the pair
  -- violates journal_entries_shop_id_reference_key. Four digits sounded like
  -- plenty until you notice that a backfill writes a shop's whole year in one
  -- statement -- 8,000 sales plus their refunds, receipts, counts, expenses and
  -- pay runs clears 9,999 inside a busy year, and this is exactly where a shop
  -- crosses it for the first time.
  --
  -- Set to 9998, so the fifteen entries this run writes span 9998, 9999 and then
  -- five digits. The assertion is on the reference TEXT, not on the unique
  -- index: 'JE-YYYY-1000' does not collide with anything in this fixture, so a
  -- truncating build would write it, look fine, and collide only on the shop
  -- whose thousandth entry already exists.
  update public.journal_entry_sequences set next_number = 9998
   where shop_id = v_shop_id and year = to_char(public.shop_local_date(), 'YYYY');

  v_posted := public.backfill_shop_ledger(v_shop_id);
  if v_posted <> 15 then
    raise exception 'FAIL: a closed period stopped the backfill, only % of 15 entries written', v_posted;
  end if;

  -- AND NEITHER SHUT MONTH MOVED. This is the behaviour the door now has to
  -- describe, pinned so a future change to the replay's period handling breaks
  -- the copy's test rather than quietly making the copy false again: the entries
  -- landed, and the periods were not re-opened, not re-closed and not stamped.
  select status into v_text from public.accounting_periods
   where shop_id = v_shop_id and starts_on = date_trunc('month', v_old_local)::date;
  if v_text <> 'closed' then
    raise exception 'FAIL: the replay left the closed month reading % -- the card says its status is untouched', v_text;
  end if;
  select status into v_text from public.accounting_periods
   where shop_id = v_shop_id and starts_on = v_lock_month;
  if v_text <> 'locked' then
    raise exception 'FAIL: the replay left the locked month reading % -- the card says its status is untouched', v_text;
  end if;
  -- And it really did write into them, or the two lines above pass vacuously.
  if not exists (select 1 from public.journal_entries e
                  join public.accounting_periods ap on ap.id = e.period_id
                 where e.shop_id = v_shop_id and ap.starts_on = v_lock_month) then
    raise exception 'FAIL: nothing landed in the locked month, so check 8b measured an exposure that does not exist';
  end if;

  -- FIXTURE RESTORE, not a claim. The locked month is the current one (see
  -- above) and checks 12 and 13 ring live sales into it.
  update public.accounting_periods set status = 'open'
   where shop_id = v_shop_id and starts_on = v_lock_month;

  if not exists (select 1 from public.journal_entries
                  where shop_id = v_shop_id
                    and reference = 'JE-' || to_char(public.shop_local_date(), 'YYYY') || '-10000') then
    select string_agg(reference, ', ' order by reference) into v_text
      from public.journal_entries
     where shop_id = v_shop_id and reference like 'JE-' || to_char(public.shop_local_date(), 'YYYY') || '-1%';
    raise exception 'FAIL: entry 10000 was not referenced JE-%-10000 -- lpad truncated it. The references starting 1 are: %',
      to_char(public.shop_local_date(), 'YYYY'), v_text;
  end if;

  select count(*) into v_rows from (
    select reference from public.journal_entries
     where shop_id = v_shop_id group by reference having count(*) > 1) d;
  if v_rows <> 0 then
    raise exception 'FAIL: % references were allocated twice once the counter passed 9999', v_rows;
  end if;

  -- And the entry landed in the closed month rather than being redirected to
  -- today. The backfill does NOT redirect -- a month closed over a ledger that
  -- did not yet hold this history is closed over nothing.
  select entry_date into v_date from public.journal_entries e
    join public.sales s on s.journal_entry_id = e.id where s.id = v_sale_a;
  if v_date <> v_old_local then
    raise exception 'FAIL: the sale in the closed month was redated to %, expected %', v_date, v_old_local;
  end if;

  -- It still ties, and it still balances, after the closed-period run.
  begin
    set constraints journal_entry_balances immediate;
  exception when others then
    raise exception 'FAIL: an entry written into a closed period does not balance -- %', sqlerrm;
  end;
  set constraints all deferred;

  select coalesce(sum(-l.amount_cents), 0) into v_ledger
    from public.journal_lines l
    join public.accounts a on a.id = l.account_id
    join public.journal_entries e on e.id = l.entry_id
   where e.shop_id = v_shop_id and a.code = '4000';
  if v_ledger <> 27000 then
    raise exception 'FAIL: revenue is % after the closed-period run, expected 27000', v_ledger;
  end if;

  select coalesce(sum(l.amount_cents), 0) into v_ledger
    from public.journal_lines l join public.journal_entries e on e.id = l.entry_id
   where e.shop_id = v_shop_id;
  if v_ledger <> 0 then
    raise exception 'FAIL: the trial balance does not zero after the closed-period run, off by %', v_ledger;
  end if;

  ---------------------------------------------------------------------------
  -- 12. AND THE LIVE PATH SURVIVES 9,999 TOO.
  ---------------------------------------------------------------------------
  -- post_journal_entry had the same lpad, and one collision there costs a
  -- cashier a sale: src/lib/sales.ts rethrows, src/lib/checkout-errors.ts
  -- passes the message through, and the basket is lost with
  -- "duplicate key value violates unique constraint" on the screen. So the
  -- format lives in one function, journal_entry_reference, and both paths call
  -- it -- but the assertion here spells the expected reference out in full
  -- rather than calling that function, or it would be the same arithmetic twice
  -- and would pass whatever the function did.
  --
  -- The counter is above 10,000 after the run above, so the very next live
  -- posting is the case that used to truncate.
  select next_number into v_seq from public.journal_entry_sequences
   where shop_id = v_shop_id and year = to_char(public.shop_local_date(), 'YYYY');
  if v_seq is null or v_seq <= 9999 then
    raise exception 'FIXTURE: the counter is at %, so check 12 is not testing anything past 9999', v_seq;
  end if;

  v_entry := public.post_journal_entry(
    v_shop_id, public.shop_local_date(), 'A manual entry past nine thousand nine hundred and ninety-nine',
    jsonb_build_array(
      jsonb_build_object('code', '1000', 'amount_cents',  100),
      jsonb_build_object('code', '3000', 'amount_cents', -100)));
  select reference into v_text from public.journal_entries where id = v_entry;
  if v_text <> 'JE-' || to_char(public.shop_local_date(), 'YYYY') || '-' || v_seq::text then
    raise exception 'FAIL: the entry numbered % took reference %, expected JE-%-% -- lpad truncated a five-digit number back to four',
      v_seq, v_text, to_char(public.shop_local_date(), 'YYYY'), v_seq;
  end if;

  -- And an existing four-digit reference keeps its shape, so a shop already
  -- holding JE-2026-0001 is not renumbered by the fix.
  if not exists (select 1 from public.journal_entries
                  where shop_id = v_shop_id and reference like 'JE-%-0001') then
    raise exception 'FAIL: no JE-YYYY-0001 survives -- the zero-padded four-digit form was not preserved';
  end if;

  ---------------------------------------------------------------------------
  -- 13. A ZERO-VALUED SALE IS SKIPPED, AND THE REPLAY COMPLETES.
  ---------------------------------------------------------------------------
  -- `sales` was the only source kind in step 1 with no "carries money"
  -- predicate. Sale E (see the fixture) produces no journal line at all, so it
  -- used to be given an entry with nothing under it and step 7 aborted THE WHOLE
  -- SHOP'S REPLAY -- every check above this one included.
  --
  -- That the replay completes is asserted by the mere fact that this line is
  -- reached: without the predicate, check 2's own call raises
  -- "Backfill could not build a complete entry for: sale <uuid>" and nothing
  -- after it runs. What is asserted HERE is that it was skipped rather than
  -- posted empty -- three ways, because "no entry" has three observable halves
  -- and a replay could get any one of them right by accident.
  if exists (select 1 from public.sales where id = v_sale_e and journal_entry_id is not null) then
    raise exception 'FAIL: the zero-valued sale was given a journal entry -- it moves no money and has no lines to put under one';
  end if;
  if exists (select 1 from public.journal_entries
              where shop_id = v_shop_id and description like '%' || v_sale_e::text || '%') then
    raise exception 'FAIL: an entry in the journal describes the zero-valued sale, which posted nothing';
  end if;
  -- And no referenced-but-empty entry survives anywhere in the shop. This is
  -- the state step 7 exists to refuse, and check 8's re-run has written the
  -- whole ledger a second time since check 2, so it covers both runs.
  if exists (select 1 from public.journal_entries e
              where e.shop_id = v_shop_id
                and (select count(*) from public.journal_lines l where l.entry_id = e.id) < 2) then
    raise exception 'FAIL: the shop holds a journal entry with fewer than two lines';
  end if;
  -- The positive control. If the predicate were simply "skip sales", checks 3a
  -- and 5 would have gone red -- but they are totals, and a total can be right
  -- for the wrong reason. This says the four money-carrying sales each got one.
  select count(*) into v_rows from public.sales
   where shop_id = v_shop_id and journal_entry_id is not null;
  if v_rows <> 4 then
    raise exception 'FAIL: % sales carry an entry, expected 4 (A, B, C and D) -- the "carries money" predicate is skipping sales that do', v_rows;
  end if;

  ---------------------------------------------------------------------------
  -- 14. THE CONCURRENCY GUARD: THE SHOP LOCK AND ALL EIGHT BACK-LINK RE-CHECKS.
  ---------------------------------------------------------------------------
  -- Read from the live function source, and this is one of the few places in
  -- this suite where that is the STRONGEST available assertion rather than a
  -- second-best one.
  --
  -- The defect is a race between two overlapping calls: both snapshot the same
  -- unposted rows, both build a complete set of entries, and the second blocks
  -- on the first's row locks at step 5 and then -- under READ COMMITTED --
  -- re-evaluates its WHERE against the row version the first committed. A WHERE
  -- that does not mention journal_entry_id matches anyway and OVERWRITES the
  -- pointer, leaving the first run's entries posted and orphaned and every
  -- account in the shop doubled, with the trial balance still at zero.
  --
  -- It cannot be reproduced from this script. Every fixture row here lives in an
  -- uncommitted transaction that is rolled back at the end, and a second session
  -- -- via dblink or otherwise -- opens a new connection that cannot see any of
  -- it. The sequential half IS behavioural and is check 6 (a second run writes
  -- nothing). What is left, and what actually decides whether the race is
  -- closed, is whether the guard is present at all: the lock, and the re-check
  -- on every one of the eight back-links. Missing ONE of the eight re-opens the
  -- hole for that table alone -- which is precisely the kind of partial fix a
  -- totals-based check cannot see.
  --
  -- Whitespace-normalised so the assertion does not depend on how the statement
  -- is wrapped, and comment-stripped first so a token cannot be satisfied by
  -- prose ABOUT the rule -- the trap that made verify-posting-sales check 15
  -- fail against correct code on its first run.
  select regexp_replace(
           regexp_replace(pg_get_functiondef('public.backfill_shop_ledger(uuid)'::regprocedure),
                          '--[^\n]*', '', 'g'),
           '\s+', ' ', 'g')
    into v_text;

  if v_text not like '%pg_advisory_xact_lock(74921, hashtext(p_shop_id::text))%' then
    raise exception 'FAIL: backfill_shop_ledger takes no per-shop advisory lock -- two overlapping replays each write a complete set of entries and one set is orphaned';
  end if;

  if v_text not like '%update public.sales s set journal_entry_id = m.entry_id from _bf_map m where m.source_kind = ''sale'' and m.source_id = s.id and s.journal_entry_id is null;%' then
    raise exception 'FAIL: the sales back-link does not re-check journal_entry_id is null -- a concurrent replay''s pointer can be overwritten';
  end if;
  if v_text not like '%update public.refunds r set journal_entry_id = m.entry_id from _bf_map m where m.source_kind = ''refund'' and m.source_id = r.id and r.journal_entry_id is null;%' then
    raise exception 'FAIL: the refunds back-link does not re-check journal_entry_id is null';
  end if;
  if v_text not like '%update public.sale_payments sp set journal_entry_id = m.entry_id from _bf_map m where m.source_kind = ''settlement'' and m.source_id = sp.id and sp.journal_entry_id is null;%' then
    raise exception 'FAIL: the settlements back-link does not re-check journal_entry_id is null';
  end if;
  if v_text not like '%update public.stock_receipts sr set journal_entry_id = m.entry_id from _bf_map m where m.source_kind = ''receipt'' and m.source_id = sr.id and sr.journal_entry_id is null;%' then
    raise exception 'FAIL: the stock receipts back-link does not re-check journal_entry_id is null';
  end if;
  if v_text not like '%update public.stock_counts sc set journal_entry_id = m.entry_id from _bf_map m where m.source_kind = ''count'' and m.source_id = sc.id and sc.journal_entry_id is null;%' then
    raise exception 'FAIL: the stock counts back-link does not re-check journal_entry_id is null';
  end if;
  if v_text not like '%update public.invoice_payments ip set journal_entry_id = m.entry_id from _bf_map m where m.source_kind = ''invoice_payment'' and m.source_id = ip.id and ip.journal_entry_id is null;%' then
    raise exception 'FAIL: the supplier payments back-link does not re-check journal_entry_id is null';
  end if;
  if v_text not like '%update public.payroll_runs pr set journal_entry_id = m.entry_id from _bf_map m where m.source_kind = ''payroll'' and m.source_id = pr.id and pr.journal_entry_id is null;%' then
    raise exception 'FAIL: the pay runs back-link does not re-check journal_entry_id is null';
  end if;
  if v_text not like '%update public.expenses e set journal_entry_id = m.entry_id from _bf_map m where m.source_kind = ''expense'' and m.source_id = e.id and e.journal_entry_id is null;%' then
    raise exception 'FAIL: the expenses back-link does not re-check journal_entry_id is null';
  end if;

  ---------------------------------------------------------------------------
  -- 17. THE SHOP THE WHOLE THING WAS FOUND ON: STOCK THAT NEVER ARRIVED.
  ---------------------------------------------------------------------------
  -- A separate shop, because "where did this stock come from" is answered once
  -- per shop and for ever, and four different answers cannot be four states of
  -- the same one.
  --
  -- This is the shape of every shop that started using kaiibi with a shelf
  -- already full: twenty bags of flour typed into the product form at 100 each,
  -- no stock_receipts row anywhere, five of them sold. The replay records the
  -- five leaving -- Cr 1200 by 500 -- and, before 20260908001300, recorded
  -- nothing arriving. 1200 read MINUS 500: a negative asset, over a trial
  -- balance of exactly zero, which is why fourteen checks above this one passed
  -- while it was true.
  --
  -- The figures are chosen so that every one can be read off the fixture rather
  -- than recomputed with the migration's own expression:
  --   opened with     20 x 100 = 2000   <- what the opening entry must say
  --   sold             5 x 100 =  500   <- what the sale's COGS took out
  --   on the shelf     15 x 100 = 1500  <- what 1200 must read at the end
  --
  -- THE MUTATIONS THIS SHOP OWNS ARE THE TWO AT ITS DATE ASSERTION BELOW. Its
  -- 1200 and 3000 figures are the same property check 3i-2 pins on the main
  -- fixture, and a mutation to the amount reddens there first -- valuing stock
  -- at nothing gives "1200 Inventory reads 0 after the replay, expected 1600"
  -- from check 3i-2, never from here. That is not a reason to drop these
  -- assertions: this shop's arithmetic is three numbers a reader can hold in
  -- their head (20 bought, 5 sold, 15 left), where the main fixture's is
  -- fourteen entries deep, so this is where the failure is legible.
  insert into public.shops (owner_id, name) values (v_user_id, 'Imported Shop')
    returning id into v_shop_import;
  insert into public.shop_locations (shop_id, name, is_primary)
    values (v_shop_import, 'Main', true) returning id into v_loc2;

  -- `stock: 20` on the products row is what the product form and CSV import
  -- write. product_opening_stock turns it into a product_location_stock row;
  -- nothing writes a stock_receipts row, because nothing was received.
  insert into public.products (shop_id, name, price_cents, cost_cents, stock)
    values (v_shop_import, 'Bag of flour', 900, 100, 20) returning id into v_prod2;

  -- RUNG THREE MONTHS AGO, reusing the main fixture's old instant, and the age
  -- is load-bearing rather than colour. Dated ten days ago -- which is what this
  -- shop had at first -- "the first of the month the ledger begins in" and "the
  -- first of the month the backfill was run in" ARE THE SAME DAY for most of
  -- any month, and a build that stamped the opening balance with the day of the
  -- run passed this check and every other one in the file. Three months back
  -- separates them every day of the year.
  insert into public.sales
      (shop_id, location_id, created_by, payment_method, total_cents, item_count,
       created_at, discount_cents, tax_cents, settled_at)
    values (v_shop_import, v_loc2, v_user_id, 'cash', 1500, 5,
            v_old_at, 0, 0, v_old_at)
    returning id into v_sale_a;
  insert into public.sale_items
      (sale_id, product_name, unit_price_cents, quantity, line_total_cents, discount_cents, unit_cost_cents)
    values (v_sale_a, 'Bag of flour', 300, 5, 1500, 0, 100);
  insert into public.sale_payments (sale_id, method, amount_cents, created_at)
    values (v_sale_a, 'cash', 1500, v_old_at);
  -- The five that were sold, taken off the shelf. Written directly for the
  -- reason the whole fixture is: this is what pre-phase-2b history looks like,
  -- and complete_sale would have posted the sale's entry and left nothing to
  -- replay.
  update public.product_location_stock set stock = 15
   where product_id = v_prod2 and location_id = v_loc2;

  v_posted := public.backfill_shop_ledger(v_shop_import);
  if v_posted <> 2 then
    raise exception 'FAIL: the imported shop''s replay wrote % entries, expected 2 (the sale and the opening balance)', v_posted;
  end if;

  -- THE ASSERTION THIS WHOLE TASK IS FOR. 1500, and above all NOT -500.
  select coalesce(sum(l.amount_cents), 0) into v_ledger
    from public.journal_lines l
    join public.accounts a on a.id = l.account_id
    join public.journal_entries e on e.id = l.entry_id
   where e.shop_id = v_shop_import and a.code = '1200';
  if v_ledger <> 1500 then
    raise exception 'FAIL: the imported shop''s 1200 Inventory reads %, expected 1500 (fifteen bags at 100 still on the shelf). -500 means no opening balance was posted and the asset is negative; 2000 means the sale''s cost was not netted off the opening figure', v_ledger;
  end if;
  if v_ledger < 0 then
    raise exception 'FAIL: 1200 Inventory is NEGATIVE at % -- a shop cannot hold less than no stock, and this is the exact state the opening balance exists to remove', v_ledger;
  end if;

  -- And the opening entry says what the shop OPENED with -- 20 x 100 -- which
  -- is a fact about the fixture and not about the migration's arithmetic.
  select coalesce(sum(l.amount_cents), 0) into v_ledger
    from public.journal_lines l
    join public.accounts a on a.id = l.account_id
    join public.journal_entries e on e.id = l.entry_id
   where e.shop_id = v_shop_import and a.code = '1200' and e.source = 'opening';
  if v_ledger <> 2000 then
    raise exception 'FAIL: the opening entry debits % to 1200, expected 2000 -- the twenty bags the shop started with, at 100 each', v_ledger;
  end if;

  -- Dated the first of the month the ledger begins in, never the day of the
  -- run. Stamped at run time, every balance sheet the shop could draw for any
  -- date before today would still show 1200 negative -- the defect, moved
  -- rather than fixed -- and it would come right only at the instant somebody
  -- happened to press the button.
  --
  -- MUTATION (proves this check): make opening_inventory_date read
  -- public.shop_local_date() instead of the ledger's own oldest date. Expected:
  -- FAIL: the opening entry is dated <the 1st of this month>, expected <the 1st
  -- of the sale's month>. THIS MUTATION SURVIVED THE FIRST TIME IT WAS RUN,
  -- because the shop's sale was ten days old and the two months coincided; the
  -- sale is three months back now for exactly that reason.
  --
  -- MUTATION (proves the date_trunc): drop it, giving the day of the first
  -- trade rather than the first of its month. Expected: FAIL: the opening
  -- entry is dated <the 14th>, expected <the 1st>.
  select e.entry_date into v_date from public.journal_entries e
   where e.shop_id = v_shop_import and e.source = 'opening';
  if v_date <> date_trunc('month', v_old_local::timestamp)::date then
    raise exception 'FAIL: the opening entry is dated %, expected % -- the first day of the month the shop''s ledger begins in',
      v_date, date_trunc('month', v_old_local::timestamp)::date;
  end if;
  if v_date > (select min(e2.entry_date) from public.journal_entries e2
                where e2.shop_id = v_shop_import and e2.source <> 'opening') then
    raise exception 'FAIL: the opening balance is dated after the first thing the shop did -- stock cannot be sold before it is on the books';
  end if;

  ---------------------------------------------------------------------------
  -- 18. A SHOP WHOSE STOCK REALLY DID ARRIVE. NO DOUBLE COUNT.
  ---------------------------------------------------------------------------
  -- The delivery already debits 1200. If the opening balance were "today's
  -- stock at today's cost" -- the first framing 20260908001300's header rejects
  -- -- this shop's inventory would read 5000 for 2500 of goods, and the trial
  -- balance would still be zero because 3000 Owner's Capital would carry the
  -- other half.
  --
  -- Nothing is posted here, and that is the point: under a moving weighted
  -- average the running total of 1200 IS quantity x cost, so on-hand less the
  -- ledger is zero and there is nothing to open with.
  --
  -- MUTATION (proves this check): drop the `if v_open_cents <> 0` guard around
  -- step 6b. This shop is the first one in the file with a gap of exactly zero,
  -- so it is where an unconditional opening entry stops being a design opinion
  -- and becomes a database error. Expected: ERROR: new row for relation
  -- "journal_lines" violates check constraint "journal_lines_amount_cents_check".
  --
  -- The other mutation this shop was written for -- dropping the "less what the
  -- ledger already holds against 1200" term, so the delivery is counted twice
  -- -- reddens check 3i-2 on the main fixture first, at -7000. Kept anyway,
  -- because a total on a fourteen-entry fixture cannot say WHICH double count
  -- happened and this can.
  insert into public.shops (owner_id, name) values (v_user_id, 'Delivered Shop')
    returning id into v_shop_recvd;
  insert into public.shop_locations (shop_id, name, is_primary)
    values (v_shop_recvd, 'Main', true) returning id into v_loc2;
  insert into public.products (shop_id, name, price_cents, cost_cents, stock)
    values (v_shop_recvd, 'Crate of tea', 1000, 250, 0) returning id into v_prod2;

  insert into public.stock_receipts (shop_id, location_id, created_by, supplier_name, created_at)
    values (v_shop_recvd, v_loc2, v_user_id, 'Berbera Wholesale', now() - interval '9 days')
    returning id into v_receipt;
  insert into public.stock_receipt_items (receipt_id, product_id, product_name, quantity, unit_cost_cents)
    values (v_receipt, v_prod2, 'Crate of tea', 10, 250);
  -- What receive_stock would have put on the shelf. Written directly for the
  -- same reason as everything else in this file.
  insert into public.product_location_stock (product_id, location_id, stock)
    values (v_prod2, v_loc2, 10);

  v_posted := public.backfill_shop_ledger(v_shop_recvd);
  if v_posted <> 1 then
    raise exception 'FAIL: the delivered shop''s replay wrote % entries, expected 1 (the delivery alone -- its stock is already accounted for)', v_posted;
  end if;
  select count(*) into v_rows from public.journal_entries
   where shop_id = v_shop_recvd and source = 'opening';
  if v_rows <> 0 then
    raise exception 'FAIL: a shop whose stock all arrived through deliveries was given % opening entries -- the goods would be counted twice', v_rows;
  end if;
  select coalesce(sum(l.amount_cents), 0) into v_ledger
    from public.journal_lines l
    join public.accounts a on a.id = l.account_id
    join public.journal_entries e on e.id = l.entry_id
   where e.shop_id = v_shop_recvd and a.code = '1200';
  if v_ledger <> 2500 then
    raise exception 'FAIL: the delivered shop''s 1200 Inventory reads %, expected 2500 (ten crates at 250) -- 5000 means the delivery was counted once by the receipt and again by an opening balance', v_ledger;
  end if;

  ---------------------------------------------------------------------------
  -- 18b. THE OTHER DIRECTION: A LEDGER CLAIMING MORE STOCK THAN THE SHELF HAS.
  ---------------------------------------------------------------------------
  -- Ten crates arrived at 250 and two are there now, with nothing recording
  -- what happened to the other eight -- a shelf re-imported downwards, or goods
  -- consumed by a shop that never ran a count. The ledger says 2500, the shelf
  -- says 500, and the correction runs the other way: Cr 1200 / Dr 3000.
  --
  -- THIS IS THE ONLY SHOP IN THIS FILE WITH A NEGATIVE GAP, and without it the
  -- sign clamp is untested. `greatest(0, ...)` -- "an opening balance cannot be
  -- negative", which sounds obviously true -- survives every other check here,
  -- including 17 and 18, and leaves exactly the shops whose books OVERSTATE an
  -- asset with a 1200 that lies. That is the more dangerous of the two
  -- directions and it was the one nothing looked at.
  --
  -- The counterpart is still 3000 and deliberately NOT 5100 Inventory
  -- Shrinkage, which is the more obvious reading. An opening entry states a
  -- balance-sheet position; routing this to 5100 would put a loss into the
  -- P&L of the shop's first month, back-dated, for stock mostly lost later than
  -- that -- and would make one entry mean two different things depending on its
  -- sign. A shop whose gap really is shrinkage has a better instrument: a stock
  -- count, which posts Dr 5100 / Cr 1200 with a date and a reason, after which
  -- this computes to zero. See 20260908001300's header.
  --
  -- MUTATION (proves this check): wrap opening_inventory_gap's result in
  -- greatest(0, ...). Expected: FAIL: the shrunken shop's replay wrote 1
  -- entries, expected 2.
  insert into public.shops (owner_id, name) values (v_user_id, 'Shrunken Shop')
    returning id into v_shop_short;
  insert into public.shop_locations (shop_id, name, is_primary)
    values (v_shop_short, 'Main', true) returning id into v_loc2;
  insert into public.products (shop_id, name, price_cents, cost_cents, stock)
    values (v_shop_short, 'Crate of tea', 1000, 250, 2) returning id into v_prod2;

  insert into public.stock_receipts (shop_id, location_id, created_by, supplier_name, created_at)
    values (v_shop_short, v_loc2, v_user_id, 'Berbera Wholesale', now() - interval '8 days')
    returning id into v_receipt;
  insert into public.stock_receipt_items (receipt_id, product_id, product_name, quantity, unit_cost_cents)
    values (v_receipt, v_prod2, 'Crate of tea', 10, 250);

  v_posted := public.backfill_shop_ledger(v_shop_short);
  if v_posted <> 2 then
    raise exception 'FAIL: the shrunken shop''s replay wrote % entries, expected 2 (the delivery and a NEGATIVE opening balance). 1 means the gap was clamped at zero and 1200 is left overstating the shelf by 2000', v_posted;
  end if;
  select coalesce(sum(l.amount_cents), 0) into v_ledger
    from public.journal_lines l
    join public.accounts a on a.id = l.account_id
    join public.journal_entries e on e.id = l.entry_id
   where e.shop_id = v_shop_short and a.code = '1200';
  if v_ledger <> 500 then
    raise exception 'FAIL: the shrunken shop''s 1200 Inventory reads %, expected 500 (two crates at 250 actually on the shelf)', v_ledger;
  end if;
  select coalesce(sum(l.amount_cents), 0) into v_ledger
    from public.journal_lines l
    join public.accounts a on a.id = l.account_id
    join public.journal_entries e on e.id = l.entry_id
   where e.shop_id = v_shop_short and a.code = '1200' and e.source = 'opening';
  if v_ledger <> -2000 then
    raise exception 'FAIL: the opening entry moves % on 1200, expected -2000 -- the books held stock the shelf does not', v_ledger;
  end if;
  select coalesce(sum(l.amount_cents), 0) into v_ledger
    from public.journal_lines l
    join public.accounts a on a.id = l.account_id
    join public.journal_entries e on e.id = l.entry_id
   where e.shop_id = v_shop_short and a.code = '5100';
  if v_ledger <> 0 then
    raise exception 'FAIL: 5100 Inventory Shrinkage reads % on the shrunken shop, expected 0 -- an opening entry states a balance-sheet position and must not put a loss into the first month''s cost of sales', v_ledger;
  end if;

  ---------------------------------------------------------------------------
  -- 19. NO STOCK, NO HISTORY: NOTHING IS POSTED AT ALL.
  ---------------------------------------------------------------------------
  -- A shop that has just been created. There is no opening position to record,
  -- and a zero opening entry is not merely pointless -- journal_lines carries
  -- check (amount_cents <> 0), so it cannot be written. A build that posted one
  -- unconditionally would fail every brand-new shop's first backfill with a
  -- constraint violation from the database, which is the worst possible place
  -- for this to be noticed.
  --
  -- The `if v_open_cents <> 0` guard is proved by check 18, which reaches a
  -- zero gap first. What is left for THIS shop is the case the guard is not
  -- enough for on its own: there is no ledger here at all, so
  -- opening_inventory_date falls back to the current month and step 6b would
  -- have to create the accounting period itself. A build that posted here would
  -- fail on the period before it ever reached the amount.
  insert into public.shops (owner_id, name) values (v_user_id, 'Empty Shop')
    returning id into v_shop_empty;
  insert into public.shop_locations (shop_id, name, is_primary)
    values (v_shop_empty, 'Main', true);

  v_posted := public.backfill_shop_ledger(v_shop_empty);
  if v_posted <> 0 then
    raise exception 'FAIL: a shop with no stock and no history had % entries written', v_posted;
  end if;
  select count(*) into v_rows from public.journal_entries where shop_id = v_shop_empty;
  if v_rows <> 0 then
    raise exception 'FAIL: a shop with no stock and no history holds % journal entries', v_rows;
  end if;

  ---------------------------------------------------------------------------
  -- 20. RE-RUNNING WRITES NO SECOND OPENING BALANCE -- INCLUDING AFTER A
  --     RE-COSTING, WHICH IS THE HALF THAT NEEDS THE MARKER.
  ---------------------------------------------------------------------------
  -- Two runs, and they test different guards. This matters, because ONE OF THEM
  -- IS UNTESTABLE BY THE OTHER and a check that only did the first would leave
  -- half the idempotency unasserted while looking complete.
  --
  --   (a) A PLAIN RE-RUN is held down by the AMOUNT. The opening entry's own
  --       Dr 1200 is part of what the ledger holds against 1200, so the gap
  --       recomputes to zero. Deleting the marker test entirely changes nothing
  --       here -- which is exactly why (b) exists.
  --   (b) AFTER A RE-COSTING the amount guard is gone: the product's
  --       cost_cents moves from 100 to 300, on-hand goes from 1500 to 4500, the
  --       ledger does not move, and the gap reads 3000. Without the marker a
  --       second "opening balance" is posted -- a correction, back-dated into
  --       the shop's first month, wearing the name of an opening balance and
  --       silently revaluing stock that phase 3 has not built the entry for.
  --
  -- MUTATION (proves (b), and nothing else in this file proves it): drop the
  -- `exists (an entry with source = 'opening' and a line on 1200)` case from
  -- opening_inventory_gap. Expected: FAIL: re-running after a re-costing wrote
  -- 1 more entries.
  v_posted := public.backfill_shop_ledger(v_shop_import);
  if v_posted <> 0 then
    raise exception 'FAIL: a second run on the imported shop wrote % more entries', v_posted;
  end if;

  update public.products set cost_cents = 300 where id = (
    select id from public.products where shop_id = v_shop_import limit 1);

  v_posted := public.backfill_shop_ledger(v_shop_import);
  if v_posted <> 0 then
    raise exception 'FAIL: re-running after a re-costing wrote % more entries -- a revaluation is not an opening balance, and back-dating one into the shop''s first month is not where it belongs', v_posted;
  end if;
  select count(*) into v_rows from public.journal_entries
   where shop_id = v_shop_import and source = 'opening';
  if v_rows <> 1 then
    raise exception 'FAIL: the imported shop holds % opening entries after three runs, expected 1', v_rows;
  end if;
  -- And the door agrees there is nothing left to do, which is what the empty
  -- state on the Post History card rests on.
  select coalesce(sum(rows_unposted), 0) into v_rows
    from public.unposted_ledger_counts(v_shop_import);
  if v_rows <> 0 then
    raise exception 'FAIL: the door still shows % rows waiting on a shop that has been backfilled three times', v_rows;
  end if;

  ---------------------------------------------------------------------------
  -- 21. AN UNCOSTED PRODUCT CONTRIBUTES NOTHING -- NOT ZERO, AND NOT ITS PRICE.
  ---------------------------------------------------------------------------
  -- isUncosted() draws this line everywhere in the codebase: null is a question
  -- nobody answered, zero is an answer. Here there is a reason sharper than
  -- consistency, and it is the one that decides it -- NOTHING WILL EVER TAKE AN
  -- UNCOSTED PRODUCT BACK OUT OF 1200. Selling it posts no COGS (its frozen
  -- unit_cost_cents is null), counting it posts no variance, receiving it is
  -- excluded from the delivery's value. So a shop opened with 50 uncosted units
  -- would carry their value for ever, growing with every uncosted line anybody
  -- imported.
  --
  -- The trap this check is written around: "contributes nothing" and
  -- "contributes zero" ARE THE SAME NUMBER, so a mutation swapping one for the
  -- other is invisible and asserting the total alone would prove nothing. What
  -- separates them is what a build would use INSTEAD of null, and the plausible
  -- wrong answer is price_cents -- valuing stock at what the shop hopes to sell
  -- it for, which capitalises unearned profit into an asset.
  --
  -- 8 costed at 200 = 1600, beside 50 uncosted the shop lists at 900. The
  -- uncosted line is worth 45000 at price, so the two answers are unmistakable.
  --
  -- MUTATION (proves this check): value stock at
  -- coalesce(p.cost_cents, p.price_cents). Expected: FAIL: the half-costed
  -- shop's opening balance is 46600, expected 1600.
  insert into public.shops (owner_id, name) values (v_user_id, 'Half-costed Shop')
    returning id into v_shop_uncost;
  insert into public.shop_locations (shop_id, name, is_primary)
    values (v_shop_uncost, 'Main', true);
  insert into public.products (shop_id, name, price_cents, cost_cents, stock)
    values (v_shop_uncost, 'Sack of rice', 5000, 200, 8);
  insert into public.products (shop_id, name, price_cents, cost_cents, stock)
    values (v_shop_uncost, 'Prayer mat', 900, null, 50);

  v_posted := public.backfill_shop_ledger(v_shop_uncost);
  if v_posted <> 1 then
    raise exception 'FAIL: the half-costed shop''s replay wrote % entries, expected 1 (the opening balance alone)', v_posted;
  end if;
  select coalesce(sum(l.amount_cents), 0) into v_ledger
    from public.journal_lines l
    join public.accounts a on a.id = l.account_id
    join public.journal_entries e on e.id = l.entry_id
   where e.shop_id = v_shop_uncost and a.code = '1200';
  if v_ledger <> 1600 then
    raise exception 'FAIL: the half-costed shop''s opening balance is %, expected 1600 (eight sacks at 200; the fifty uncosted mats contribute nothing). 46600 means uncosted stock was valued at its selling price', v_ledger;
  end if;

  -- ...and a shop with NOTHING BUT uncosted stock opens with nothing at all.
  -- The ledger has nothing to say about that stock, which is true; the place
  -- that says so is the Inventory Valuation report's uncosted disclosure, not a
  -- figure invented here.
  insert into public.shops (owner_id, name) values (v_user_id, 'Uncosted Shop')
    returning id into v_shop_blind;
  insert into public.shop_locations (shop_id, name, is_primary)
    values (v_shop_blind, 'Main', true);
  insert into public.products (shop_id, name, price_cents, cost_cents, stock)
    values (v_shop_blind, 'Prayer mat', 900, null, 50);

  v_posted := public.backfill_shop_ledger(v_shop_blind);
  if v_posted <> 0 then
    raise exception 'FAIL: a shop holding nothing but uncosted stock was given % entries -- the ledger has no figure for that stock and must not invent one', v_posted;
  end if;

  ---------------------------------------------------------------------------
  -- 16. THE DOOR GATES ON THE SAME PERMISSION THE REPLAY DOES.
  ---------------------------------------------------------------------------
  -- backfill_shop_ledger requires ledger.close, not ledger.post -- rewriting a
  -- shop's whole history is heavier than posting one entry, and only the Owner
  -- role carries it. unposted_ledger_counts must require the same thing: a
  -- counts function that answered freely would show a role a number it can
  -- never act on, and would leak one shop's trading volume to anyone who could
  -- guess a shop id.
  --
  -- Asserted with a user who is a member of NOTHING, which is the strongest
  -- form available here without building a second role: has_shop_permission is
  -- false for them on every permission, so a function with no gate at all
  -- returns eight rows and this check reddens.
  perform set_config('request.jwt.claims', json_build_object('sub', gen_random_uuid())::text, true);
  begin
    select count(*) into v_bf_kinds from public.unposted_ledger_counts(v_shop_id);
    raise exception 'FAIL: a non-member read % rows of unposted counts -- the ledger.close gate is missing', v_bf_kinds;
  exception when others then
    if sqlerrm like 'FAIL:%' then raise; end if;
    if sqlerrm not like '%ledger.close%' then
      raise exception 'FAIL: unposted_ledger_counts should refuse a caller without ledger.close by name, got: %', sqlerrm;
    end if;
  end;
  -- The exposure function is the same door onto the same view and must gate the
  -- same way -- which months a shop has locked, and how much trading is waiting
  -- in them, is the same leak as the counts.
  begin
    select count(*) into v_bf_kinds from public.unposted_ledger_period_exposure(v_shop_id);
    raise exception 'FAIL: a non-member read % rows of period exposure -- the ledger.close gate is missing', v_bf_kinds;
  exception when others then
    if sqlerrm like 'FAIL:%' then raise; end if;
    if sqlerrm not like '%ledger.close%' then
      raise exception 'FAIL: unposted_ledger_period_exposure should refuse a caller without ledger.close by name, got: %', sqlerrm;
    end if;
  end;
  perform set_config('request.jwt.claims', json_build_object('sub', v_user_id)::text, true);

  perform set_config('request.jwt.claims', null, true);
  raise notice 'ALL CHECKS PASSED';
  raise exception 'rollback fixture';
exception
  when others then
    perform set_config('request.jwt.claims', null, true);
    if sqlerrm = 'rollback fixture' then
      return;
    end if;
    raise;
end $$;
