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
--   2. The backfill posts every unposted row and says how many.
--   3. THE ONES THAT MATTER. Revenue, COGS, discounts, receivables and
--      operating expenses each tie to the figures the app reports today.
--      Revenue is asserted against unit_price_cents * quantity -- LIST price,
--      an expression the replay does not use -- because asserting it against
--      sum(line_total_cents) would be the same arithmetic twice and would pass
--      a replay that credits 4000 net of every promotion the shop ever ran.
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
--  10. THE DOUBLE-COUNTS. A settlement is not re-posted; the expenses row
--      post_payroll_run writes is not replayed on top of the run's own entry;
--      the expenses row sync_invoice_expense mirrors from a bill is not
--      replayed on top of the bill's liability.
--  11. Backfilled entries carry their TRUE source, never a 'backfill' marker.
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
  v_refund_id uuid;
  v_receipt   uuid;
  v_count_id  uuid;
  v_invoice   uuid;
  v_run_id    uuid;
  v_expense   uuid;
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
  ---------------------------------------------------------------------------
  -- 3000 total, 1000 taken at the till, 2000 left on account.
  insert into public.sales
      (shop_id, location_id, created_by, payment_method, total_cents, item_count,
       created_at, discount_cents, tax_cents)
    values (v_shop_id, v_loc_id, v_user_id, 'cash', 3000, 1,
            now() - interval '5 days', 0, 0)
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

  insert into public.invoice_payments (invoice_id, amount_cents, paid_on, method, created_by)
    values (v_invoice, 3000, public.shop_local_date() - 6, 'cash', v_user_id);

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
  -- 2. The backfill posts every unposted row and says how many.
  ---------------------------------------------------------------------------
  -- Nine: three sales, one refund, one receipt, one count, one supplier
  -- payment, one pay run, one expense. NOT the settlement (already posted),
  -- NOT the payroll expense row, NOT the invoice's mirrored expense row.
  v_posted := public.backfill_shop_ledger(v_shop_id);
  if v_posted <> 9 then
    raise exception 'FAIL: expected 9 entries (3 sales, 1 refund, 1 receipt, 1 count, 1 supplier payment, 1 pay run, 1 expense), got %', v_posted;
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
  select coalesce(sum(l.amount_cents), 0) into v_ledger
    from public.journal_lines l
    join public.accounts a on a.id = l.account_id
    join public.journal_entries e on e.id = l.entry_id
   where e.shop_id = v_shop_id and a.code = '4200';
  select coalesce(sum(s.discount_cents + s.points_redeemed_cents), 0)
       + coalesce((select sum(si.discount_cents) from public.sale_items si
                     join public.sales s2 on s2.id = si.sale_id where s2.shop_id = v_shop_id), 0)
    into v_report
    from public.sales s where s.shop_id = v_shop_id;
  if v_ledger <> v_report then
    raise exception 'FAIL: 4200 Discounts is % but the sales and their lines say % -- off by %',
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
  select coalesce(sum(l.amount_cents), 0) into v_ledger
    from public.journal_lines l
    join public.accounts a on a.id = l.account_id
    join public.journal_entries e on e.id = l.entry_id
   where e.shop_id = v_shop_id and a.type = 'expense';
  select coalesce((select sum(e2.amount_cents) from public.expenses e2
                    where e2.shop_id = v_shop_id
                      and e2.payroll_run_id is null and e2.invoice_id is null), 0)
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
  -- The delivery raises 2000 by its costed value and the payment draws it back
  -- down: 2000 received, 3000 paid, so 2000 nets to -1000 (a debit balance,
  -- because this fixture pays a bill for goods that arrived on a different
  -- delivery -- which is exactly what a real shop's two tables look like).
  select coalesce(sum(l.amount_cents), 0) into v_ledger
    from public.journal_lines l
    join public.accounts a on a.id = l.account_id
    join public.journal_entries e on e.id = l.entry_id
   where e.shop_id = v_shop_id and a.code = '2000';
  select coalesce((select sum(ip.amount_cents) from public.invoice_payments ip
                     join public.invoices i on i.id = ip.invoice_id where i.shop_id = v_shop_id), 0)
       - coalesce((select sum(ri.unit_cost_cents::bigint * ri.quantity)
                     from public.stock_receipt_items ri
                     join public.stock_receipts r on r.id = ri.receipt_id
                    where r.shop_id = v_shop_id and ri.unit_cost_cents is not null), 0)
    into v_report;
  if v_ledger <> v_report then
    raise exception 'FAIL: 2000 Accounts Payable is % but the receipts and payments say % -- off by %',
      v_ledger, v_report, v_ledger - v_report;
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
  select count(*) into v_rows from public.sales
   where shop_id = v_shop_id and journal_entry_id is null;
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

  select count(*) into v_rows from public.expenses
   where shop_id = v_shop_id and journal_entry_id is null
     and payroll_run_id is null and invoice_id is null;
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
  if v_ledger <> 21000 then
    raise exception 'FAIL: revenue is % after a second run, expected 21000', v_ledger;
  end if;
  select count(*) into v_rows from public.journal_entries where shop_id = v_shop_id;
  if v_rows <> 10 then
    raise exception 'FAIL: a second run left % entries, expected 10', v_rows;
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
   where shop_id = v_shop_id and not (id = any(v_pre)) and id <> v_entry;

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

  v_posted := public.backfill_shop_ledger(v_shop_id);
  if v_posted <> 9 then
    raise exception 'FAIL: a closed period stopped the backfill, only % of 9 entries written', v_posted;
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
  if v_ledger <> 21000 then
    raise exception 'FAIL: revenue is % after the closed-period run, expected 21000', v_ledger;
  end if;

  select coalesce(sum(l.amount_cents), 0) into v_ledger
    from public.journal_lines l join public.journal_entries e on e.id = l.entry_id
   where e.shop_id = v_shop_id;
  if v_ledger <> 0 then
    raise exception 'FAIL: the trial balance does not zero after the closed-period run, off by %', v_ledger;
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
