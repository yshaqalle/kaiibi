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
--  10. THE DOUBLE-COUNTS. A settlement is not re-posted; the expenses row
--      post_payroll_run writes is not replayed on top of the run's own entry;
--      the expenses row sync_invoice_expense mirrors from a bill is not
--      replayed on top of the bill's liability.
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
  -- The old sale's day in the shop's own time, and the UTC instant that lands
  -- on it. 22:30 UTC is 01:30 the NEXT day in Mogadishu (UTC+3), so
  -- shop_local_date() and a bare ::date differ by one and any replay that
  -- reaches for the wrong one fails check 7 every day of the year.
  v_old_day   date := (date_trunc('month', public.shop_local_date()::timestamp)
                        - interval '3 months')::date + 13;
  v_old_at    timestamptz;
  v_old_local date;
  -- Everything the ledger already held before the backfill ran -- which is the
  -- settlement's entry and nothing else. Check 8 tears down what the backfill
  -- wrote and must leave the live entry standing, or it would be testing a
  -- different shop.
  v_pre       uuid[];
  v_seq       integer;
  v_max_ref   text;
  v_product   uuid;
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
  insert into public.products (shop_id, name, price_cents, cost_cents)
    values (v_shop_id, 'Sack of rice', 5000, 200) returning id into v_product;

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
  -- Thirteen: four sales, two refunds, one receipt, one count, one supplier
  -- payment, one pay run, one rent expense, one standalone stock_loss, and the
  -- delivery's payment. NOT the settlement (already posted), NOT the payroll
  -- expense row, NOT the invoice's mirrored expense row, and NOT the count's
  -- stock_loss row -- save_stock_count already posted both sides of that one.
  v_posted := public.backfill_shop_ledger(v_shop_id);
  if v_posted <> 13 then
    raise exception 'FAIL: expected 13 entries (4 sales, 2 refunds, 1 receipt, 1 count, 1 supplier payment, 1 pay run, 2 expenses, 1 delivery payment), got %', v_posted;
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
  -- replayed, 6200 would read 14000 and this is 7000 out; if the invoice's
  -- mirrored row were replayed, 6400 would read 5000 and this is 5000 out.
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
                      and e2.payroll_run_id is null and e2.invoice_id is null
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
  if v_ledger <> 0 then
    raise exception 'FAIL: 6400 Supplies is % -- the expenses row sync_invoice_expense mirrors from the bill was replayed, doubling a stocked cost', v_ledger;
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
  -- The delivery raises 2000 by its costed value and TWO things draw it back
  -- down: the supplier payment recorded against the bill, and the Restock
  -- sheet's expense row settling the delivery it was written for. 2000
  -- received, 3000 paid on the bill, 2000 paid on delivery, so 2000 nets to
  -- +3000 (a DEBIT balance on a liability account, because this fixture pays a
  -- bill for goods that arrived on a different delivery -- which is exactly
  -- what a real shop's two tables look like).
  --
  -- The third term is the one this check gained. Without it -- i.e. with the
  -- replay debiting 1200 for a receipt-linked expense, as it did before
  -- 20260908000800 -- the ledger reads +1000, the report side reads +3000, and
  -- this is 2000 out in the direction that says the shop still owes a supplier
  -- it paid on the doorstep.
  select coalesce(sum(l.amount_cents), 0) into v_ledger
    from public.journal_lines l
    join public.accounts a on a.id = l.account_id
    join public.journal_entries e on e.id = l.entry_id
   where e.shop_id = v_shop_id and a.code = '2000';
  select coalesce((select sum(ip.amount_cents) from public.invoice_payments ip
                     join public.invoices i on i.id = ip.invoice_id where i.shop_id = v_shop_id), 0)
       + coalesce((select sum(e2.amount_cents) from public.expenses e2
                    where e2.shop_id = v_shop_id and e2.stock_receipt_id is not null), 0)
       - coalesce((select sum(ri.unit_cost_cents::bigint * ri.quantity)
                     from public.stock_receipt_items ri
                     join public.stock_receipts r on r.id = ri.receipt_id
                    where r.shop_id = v_shop_id and ri.unit_cost_cents is not null), 0)
    into v_report;
  if v_ledger <> v_report then
    raise exception 'FAIL: 2000 Accounts Payable is % but the receipts, bill payments and delivery payments say % -- off by %',
      v_ledger, v_report, v_ledger - v_report;
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
  select coalesce(sum(l.amount_cents), 0) into v_ledger
    from public.journal_lines l
    join public.accounts a on a.id = l.account_id
    join public.journal_entries e on e.id = l.entry_id
   where e.shop_id = v_shop_id and a.code = '1200';
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
    raise exception 'FAIL: 1200 Inventory is % but the deliveries, count, sales, returns and write-offs say % -- off by %',
      v_ledger, v_report, v_ledger - v_report;
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

  -- stock_count_id is excluded here and nowhere else in check 5: it is the one
  -- exclusion that leaves a row with journal_entry_id null FOR EVER by design.
  -- save_stock_count posted both sides of that write-off itself, so there is no
  -- entry for the row to point at and never will be. Dropping the clause would
  -- make this check red on a correct replay -- the exact shape of no-op-in-
  -- reverse this suite has been bitten by before.
  select count(*) into v_rows from public.expenses
   where shop_id = v_shop_id and journal_entry_id is null
     and payroll_run_id is null and invoice_id is null and stock_count_id is null;
  if v_rows <> 0 then raise exception 'FAIL: % expenses are still unposted', v_rows; end if;

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
  if v_rows <> 14 then
    raise exception 'FAIL: a second run left % entries, expected 14', v_rows;
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
  if v_text <> 'bill,count,manual,payment,payroll,refund,sale,settlement,stock' then
    raise exception 'FAIL: the sources written are "%", expected bill,count,manual,payment,payroll,refund,sale,settlement,stock', v_text;
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

  -- open_period_for raises on that month now. Asserted, so this check cannot
  -- quietly become a no-op if the period never actually closed.
  begin
    perform public.open_period_for(v_shop_id, v_old_local);
    raise exception 'FIXTURE: the month of % is not actually closed, so check 8 proves nothing', v_old_local;
  exception when others then
    if sqlerrm like 'FIXTURE:%' then raise; end if;
  end;

  -- AND THE RE-RUN IS PUSHED PAST 9,999, which is the second thing this block
  -- now proves. lpad(n::text, 4, '0') TRUNCATES a longer string:
  -- lpad('10000', 4, '0') is '1000', entry 1000's reference, and the pair
  -- violates journal_entries_shop_id_reference_key. Four digits sounded like
  -- plenty until you notice that a backfill writes a shop's whole year in one
  -- statement -- 8,000 sales plus their refunds, receipts, counts, expenses and
  -- pay runs clears 9,999 inside a busy year, and this is exactly where a shop
  -- crosses it for the first time.
  --
  -- Set to 9998, so the thirteen entries this run writes span 9998, 9999 and then
  -- five digits. The assertion is on the reference TEXT, not on the unique
  -- index: 'JE-YYYY-1000' does not collide with anything in this fixture, so a
  -- truncating build would write it, look fine, and collide only on the shop
  -- whose thousandth entry already exists.
  update public.journal_entry_sequences set next_number = 9998
   where shop_id = v_shop_id and year = to_char(public.shop_local_date(), 'YYYY');

  v_posted := public.backfill_shop_ledger(v_shop_id);
  if v_posted <> 13 then
    raise exception 'FAIL: a closed period stopped the backfill, only % of 13 entries written', v_posted;
  end if;

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
