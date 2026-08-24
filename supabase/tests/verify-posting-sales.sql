-- Every money-moving sale RPC writes a balanced double-entry journal entry, in
-- the same transaction that writes the sale, the refund or the settlement.
--
-- Eighteen things are asserted, and none of them can be checked from TypeScript
-- because all eighteen are facts about rows this database wrote for itself:
--
--   1. a cash sale posts one balanced entry, with the tax booked as a LIABILITY
--      and only the merchandise as revenue, and COGS taken from the cost frozen
--      on the line rather than from products.cost_cents.
--   2. a split payment produces one debit line per method. Two lines against
--      two accounts is the whole reason the drawer and the wallet can be
--      reconciled separately.
--   3. a part-paid sale debits 1100 Accounts Receivable for what is still owed.
--      This is the check that the ORIGINAL plan could not have passed: it named
--      `v_balance` for the money owed, but in complete_sale v_balance holds the
--      customer's loyalty POINTS balance and is only ever assigned inside the
--      redemption branch. The real figure is v_total_cents - v_payments_total.
--   4. an uncosted product posts no COGS pair at all rather than a zero one.
--      journal_lines carries check (amount_cents <> 0), so getting this wrong
--      is not a quiet inaccuracy -- the whole sale raises.
--   5. a cashier holding pos.access and NOT ledger.post can still sell. The
--      posting call passes p_source = 'sale', and post_journal_entry gates only
--      the 'manual' source on ledger.post. If this ever goes red, every sale in
--      every shop stops until someone grants a permission cashiers should not
--      need.
--   6. a LINE-level discount credits 4000 at LIST and debits 4200. The first
--      version of the posting block credited 4000 with v_gross_cents, which the
--      item loop has already netted every line and promotion discount out of --
--      so a shop whose discounts are all promotions (the app's main discount
--      mechanism) read 4200 Discounts Given as zero while Sales Revenue was
--      understated by the same amount. An ORDER-level discount would not have
--      caught it; only a line-level one does.
--   7. two entries posted back to back get two different references, and the
--      per-shop-per-year counter they come from advanced by exactly two. Plus a
--      direct assertion that the old count(*)-based formula is GONE from
--      post_journal_entry's source.
--   8. the COGS figure is frozen on the line. products.cost_cents is changed to
--      a clearly different value part-way through, and both the entry posted
--      before the change and the one posted after read their own frozen cost.
--   9. a sale dated into a CLOSED period still succeeds, and its entry lands in
--      the CURRENT period with the true sale date written into its description.
--      src/lib/sales-import.ts backdates every imported historical sale, so
--      without this a shop that has closed any month cannot import into it.
--  10. a sale dated into an OPEN month still posts to that month. Checks 9 and
--      10 are a pair: neither is worth anything without the other, because an
--      implementation that redated EVERYTHING would pass 9 alone.
--  11. the entry date is the SHOP'S local date. Somalia is UTC+3, so a sale at
--      22:30 UTC on the last day of a month is 01:30 on the FIRST of the next
--      one locally, and that is the period it belongs to. Dated in UTC it
--      disagreed permanently with src/lib/period.ts, which buckets the sales
--      report in device-local time.
--  12. a refund posts to 4100 Sales Returns and leaves 4000 Sales Revenue
--      alone, returns the tax in the same proportion the money goes back, and
--      brings the cost of the returned goods back out of COGS and into stock at
--      the cost FROZEN on the original sale line.
--  13. settling a balance moves the receivable to cash and posts no revenue.
--      The revenue was recognised when the sale was rung up; recognising it
--      again when the money arrives is the classic double-count, so 4000 is
--      asserted ABSENT rather than merely unchanged.
--  14. a refund on a PART-PAID sale splits its credit between the cash actually
--      handed over and the receivable that is cleared. Check 12 cannot see
--      this: on a sale paid in full those two figures are the same number, so
--      12 passes against a branch as readily as against a split.
--  15. both refunds and settlements date their entry from shop_local_date().
--      Asserted against the live function source, because a value comparison
--      only bites for the three hours a day when the UTC date and the shop's
--      date differ -- and neither RPC takes a date this script could choose.
--  16. a settlement's entry carries the location of the till that TOOK the
--      money, not of the branch that rang the sale. 20260831000300 already
--      fixed the drawer side of this; a ledger stamped with the sale's branch
--      puts the same cash in two branches that can never be reconciled.
--  17. a refund on a SPLIT-TENDER sale credits every tender it came in on, in
--      proportion. One lumped line against the biggest method disagrees with
--      register_session_expected, which pro-rates the same refund across the
--      same tenders -- so the drawer count and the ledger drift apart with
--      nothing to explain the difference.
--  18. the behavioural half of 15, which 15 cannot do: the same refund issued
--      under two session timezones 26 hours apart gets the SAME entry date, and
--      it is shop_local_date(). 15 reads the function text and would pass on a
--      body that said `now() :: date` or that called shop_local_date() for
--      something other than the entry date.
--
-- The figures are chosen so no two lines of check 1 share a value -- 7000, 350,
-- 7350 and 2500 are all distinct -- so a check that reads the wrong account
-- fails rather than coincidentally passing.
--
-- Deliberately NOT `set role authenticated`: this script stays superuser so RLS
-- never hides a journal_lines row from its own assertions. Nothing under test
-- here is an RLS policy -- complete_sale and post_journal_entry both gate on
-- has_shop_permission(), which reads auth.uid() from the JWT claim set below
-- and does not care which postgres role is executing.
--
-- Everything runs inside one DO block whose EXCEPTION clause rolls it all back.

\set ON_ERROR_STOP on

do $$
declare
  v_user_id        uuid := gen_random_uuid();
  v_staff_id       uuid := gen_random_uuid();
  v_shop_id        uuid;
  v_loc_id         uuid;
  v_prod_a         uuid;
  v_prod_b         uuid;
  v_prod_uncosted  uuid;
  v_customer_id    uuid;
  v_staff_role_id  uuid;
  v_sale_id        uuid;
  -- Check 1's sale and check 3's, kept because v_sale_id is overwritten by
  -- every later check and checks 12 and 13 come back to these two specifically:
  -- 12 needs a sale that was paid IN FULL (so the refund credits cash), 13 needs
  -- one that was not (so there is a receivable to settle).
  v_sale_id_cash   uuid;
  v_sale_id_credit uuid;
  v_item_a         uuid;
  v_refund_id      uuid;
  v_entry          uuid;
  -- Check 1's entry, kept so check 8 can come back to it after the fixture has
  -- moved products.cost_cents underneath it.
  v_entry_1        uuid;
  v_entry_a        uuid;
  v_entry_b        uuid;
  v_amount         bigint;
  v_text           text;
  v_ref_a          text;
  v_ref_b          text;
  v_next_before    integer;
  v_next_after     integer;
  -- Checks 9-11. All three months are computed RELATIVE to now() rather than
  -- written as literals, so the script keeps meaning the same thing next year
  -- and cannot accidentally pick the month it is being run in.
  v_month_tz       date;   -- 4 months back: the timezone fixture's month
  v_month_closed   date;   -- 2 months back: closed part-way through check 9
  v_month_open     date;   -- 1 month back: stays open, the control
  v_today_local    date;
  v_date           date;
  v_date_actual    date;
  v_expected       date;
  -- Check 15 reads function source, which is far too large to sit in v_text
  -- alongside the short descriptions the other checks put there.
  v_src            text;
  -- Check 16: a second branch, with a till of its own, to settle a Branch-A
  -- sale at.
  v_loc_b          uuid;
  v_register_b     uuid;
  v_session_b      uuid;
  v_member_id      uuid;
  v_loc_actual     uuid;
  -- Check 17's split-tender product, priced so the review's exact figures
  -- (600 = 100 cash + 500 zaad, refund 200) are reachable.
  v_prod_split     uuid;
  -- Check 18's two refunds, one per session timezone.
  v_entry_tz1      uuid;
  v_entry_tz2      uuid;
  v_date_tz1       date;
  v_date_tz2       date;
  v_tz_saved       text;
  -- Checks 19-22. The sale being edited, the entry it was posted with before
  -- the edit, and the reversal of that entry. Kept apart from v_entry/v_sale_id
  -- because all three have to be compared with each other after the edit has
  -- moved sales.journal_entry_id on.
  v_sale_id_edit   uuid;
  v_entry_orig     uuid;
  v_entry_rev      uuid;
  v_entry_settle   uuid;
  v_line_count     bigint;
begin
  -- shops.owner_id references auth.users(id), so the fixture "people" need real
  -- rows there before anything else.
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
    select u, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
           'verify-posting-sales-' || u || '@example.test', '', now(), now(), now()
      from unnest(array[v_user_id, v_staff_id]) u;

  insert into public.shops (owner_id, name, tax_enabled, tax_rate_percent)
    values (v_user_id, 'Posting Shop', true, 5) returning id into v_shop_id;

  -- A shop has no location until the fixture makes one; seed_shop_defaults does
  -- not create one.
  insert into public.shop_locations (shop_id, name, is_primary)
    values (v_shop_id, 'Main', true) returning id into v_loc_id;

  -- complete_sale prices a line from products.price_cents, not from the
  -- unit_price_cents in the cart JSON, so the prices HERE are what the totals
  -- below are computed from.
  insert into public.products (shop_id, name, price_cents, cost_cents)
    values (v_shop_id, 'Posting Tea', 2000, 700) returning id into v_prod_a;
  insert into public.products (shop_id, name, price_cents, cost_cents)
    values (v_shop_id, 'Posting Coffee', 3000, 1100) returning id into v_prod_b;
  -- Cost NULL, not zero. isUncosted() is careful that these are different
  -- answers: a free sample really does cost nothing; an unpriced product is a
  -- question nobody answered. Check 4 turns on that distinction.
  insert into public.products (shop_id, name, price_cents, cost_cents)
    values (v_shop_id, 'Posting Sample', 900, null) returning id into v_prod_uncosted;

  insert into public.product_location_stock (product_id, location_id, stock)
    values (v_prod_a, v_loc_id, 1000), (v_prod_b, v_loc_id, 1000), (v_prod_uncosted, v_loc_id, 1000);

  insert into public.customers (shop_id, first_name, last_name)
    values (v_shop_id, 'Ayaan', 'Jama') returning id into v_customer_id;

  -- The cashier of checks 5 and 20: the two till permissions and nothing else.
  -- Written as a plain roles row plus a membership, which is what
  -- verify-inventory-permissions.sql does -- there is no
  -- grant_role_permissions() helper in this database. Created BEFORE the JWT is
  -- switched, while raw inserts are still possible.
  --
  -- 'sales.edit' is here for check 20, and it is the whole point of that check:
  -- a manager correcting a mis-rung sale holds sales.edit and must never need
  -- ledger.post as well. Neither permission is a ledger permission, which is
  -- what both checks assert against.
  insert into public.roles (shop_id, name, permissions)
    values (v_shop_id, 'Till Only', array['pos.access', 'sales.edit'])
    returning id into v_staff_role_id;
  insert into public.shop_members (shop_id, user_id, role_id, active)
    values (v_shop_id, v_staff_id, v_staff_role_id, true);

  -- has_shop_permission -> auth.uid() -> request.jwt.claims->>'sub'. Without
  -- this every call below is refused as unauthorized.
  perform set_config('request.jwt.claims', json_build_object('sub', v_user_id)::text, true);

  -- 1. A cash sale posts one balanced entry.
  --
  -- 2 @ 2000 (cost 700) plus 1 @ 3000 (cost 1100) = 7000 gross.
  -- Tax 5% of 7000 = 350. Total 7350. COGS = 2*700 + 1100 = 2500.
  v_sale_id := public.complete_sale(
    v_shop_id,
    jsonb_build_array(
      jsonb_build_object('product_id', v_prod_a, 'quantity', 2, 'unit_price_cents', 2000),
      jsonb_build_object('product_id', v_prod_b, 'quantity', 1, 'unit_price_cents', 3000)),
    jsonb_build_array(jsonb_build_object('method', 'cash', 'amount_cents', 7350)),
    null, null, null, null, 0, null, null, v_loc_id);

  select journal_entry_id into v_entry from public.sales where id = v_sale_id;
  if v_entry is null then
    raise exception 'FAIL: the sale did not post a journal entry';
  end if;
  v_entry_1 := v_entry;
  v_sale_id_cash := v_sale_id;

  -- The entry points BACK at its sale. sales.journal_entry_id gets you one way;
  -- without this every entry's description is the bare word 'Sale' and a
  -- journals list of four hundred of them names no sale at all.
  select description into v_text from public.journal_entries where id = v_entry;
  if v_text not like '%' || v_sale_id::text || '%' then
    raise exception 'FAIL: the entry description % does not name its sale %', v_text, v_sale_id;
  end if;

  select source into v_text from public.journal_entries where id = v_entry;
  if v_text <> 'sale' then
    raise exception 'FAIL: expected source=sale, got % (manual would mean it gated on ledger.post)', v_text;
  end if;

  -- Balanced. Guaranteed by the deferred trigger, asserted anyway: if this ever
  -- fails the trigger has been dropped, which is worth knowing here.
  select coalesce(sum(amount_cents), 0) into v_amount from public.journal_lines where entry_id = v_entry;
  if v_amount <> 0 then
    raise exception 'FAIL: the sale entry does not balance, off by %', v_amount;
  end if;

  -- Dr 1000 Cash 7350
  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l join public.accounts a on a.id = l.account_id
   where l.entry_id = v_entry and a.code = '1000';
  if v_amount <> 7350 then
    raise exception 'FAIL: expected Dr 1000 Cash 7350, got %', v_amount;
  end if;

  -- Cr 4000 Sales Revenue 7000 -- the GROSS, not the total. Posting 7350 here
  -- would book the tax as revenue, which is the mistake this check exists for.
  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l join public.accounts a on a.id = l.account_id
   where l.entry_id = v_entry and a.code = '4000';
  if v_amount <> -7000 then
    raise exception 'FAIL: expected Cr 4000 Revenue -7000, got % (-7350 = tax booked as revenue)', v_amount;
  end if;

  -- Cr 2100 Sales Tax Payable 350 -- owed, not earned.
  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l join public.accounts a on a.id = l.account_id
   where l.entry_id = v_entry and a.code = '2100';
  if v_amount <> -350 then
    raise exception 'FAIL: expected Cr 2100 Tax -350, got %', v_amount;
  end if;

  -- Dr 5000 COGS 2500 and Cr 1200 Inventory 2500, from the cost frozen on each
  -- line at sale time -- never products.cost_cents, which would let a later
  -- restock rewrite this sale's cost.
  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l join public.accounts a on a.id = l.account_id
   where l.entry_id = v_entry and a.code = '5000';
  if v_amount <> 2500 then
    raise exception 'FAIL: expected Dr 5000 COGS 2500, got %', v_amount;
  end if;
  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l join public.accounts a on a.id = l.account_id
   where l.entry_id = v_entry and a.code = '1200';
  if v_amount <> -2500 then
    raise exception 'FAIL: expected Cr 1200 Inventory -2500, got %', v_amount;
  end if;

  -- 2. A SPLIT payment produces one debit line per method, not one lumped line.
  --    Two lines against different accounts is the whole reason the drawer and
  --    the wallet can be reconciled separately.
  --
  --    1 @ 2000 = 2000 gross, tax 100, total 2100, taken as 1300 + 800.
  v_sale_id := public.complete_sale(
    v_shop_id,
    jsonb_build_array(jsonb_build_object('product_id', v_prod_a, 'quantity', 1, 'unit_price_cents', 2000)),
    jsonb_build_array(
      jsonb_build_object('method', 'cash', 'amount_cents', 1300),
      jsonb_build_object('method', 'zaad', 'amount_cents', 800)),
    null, null, null, null, 0, null, null, v_loc_id);
  select journal_entry_id into v_entry from public.sales where id = v_sale_id;

  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l join public.accounts a on a.id = l.account_id
   where l.entry_id = v_entry and a.code = '1000';
  if v_amount <> 1300 then
    raise exception 'FAIL: expected Dr 1000 Cash 1300 of the split, got %', v_amount;
  end if;
  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l join public.accounts a on a.id = l.account_id
   where l.entry_id = v_entry and a.code = '1020';
  if v_amount <> 800 then
    raise exception 'FAIL: expected Dr 1020 Zaad 800 of the split, got % (2100 = both lumped into one account)', v_amount;
  end if;

  -- 3. A CREDIT sale debits 1100 Receivable for the unpaid part.
  --    2 @ 2000 = 4000 gross, tax 200, total 4200. Paid 1500, owed 2700.
  v_sale_id := public.complete_sale(
    v_shop_id,
    jsonb_build_array(jsonb_build_object('product_id', v_prod_a, 'quantity', 2, 'unit_price_cents', 2000)),
    jsonb_build_array(jsonb_build_object('method', 'cash', 'amount_cents', 1500)),
    null, null, null, null, 0, v_customer_id, null, v_loc_id, 0, null, true);
  select journal_entry_id into v_entry from public.sales where id = v_sale_id;
  v_sale_id_credit := v_sale_id;

  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l join public.accounts a on a.id = l.account_id
   where l.entry_id = v_entry and a.code = '1100';
  if v_amount <> 2700 then
    raise exception 'FAIL: expected Dr 1100 Receivable 2700, got %', v_amount;
  end if;

  -- 4. An UNCOSTED product posts no COGS pair at all rather than posting zero.
  --    journal_lines refuses a zero amount, so getting this wrong is not a
  --    quiet inaccuracy -- the sale fails outright. Which is why it is checked.
  v_sale_id := public.complete_sale(
    v_shop_id,
    jsonb_build_array(jsonb_build_object('product_id', v_prod_uncosted, 'quantity', 1, 'unit_price_cents', 900)),
    jsonb_build_array(jsonb_build_object('method', 'cash', 'amount_cents', 945)),
    null, null, null, null, 0, null, null, v_loc_id);
  select journal_entry_id into v_entry from public.sales where id = v_sale_id;
  if exists (select 1 from public.journal_lines l join public.accounts a on a.id = l.account_id
              where l.entry_id = v_entry and a.code in ('5000', '1200')) then
    raise exception 'FAIL: an uncosted sale should post no COGS pair, not a zero one';
  end if;

  -- 5. A cashier does NOT need ledger.post. The whole phase turns on this: the
  --    posting call passes p_source <> 'manual', which skips that gate. If this
  --    raises, every sale in the shop stops until someone grants the permission.
  perform set_config('request.jwt.claims', json_build_object('sub', v_staff_id)::text, true);
  -- Asserted, not assumed: if the fixture ever drifted into handing the cashier
  -- ledger.post, check 5 would pass without proving anything at all.
  if public.has_shop_permission(v_shop_id, 'ledger.post') then
    raise exception 'FAIL: the fixture cashier holds ledger.post, so check 5 would prove nothing';
  end if;
  v_sale_id := public.complete_sale(
    v_shop_id,
    jsonb_build_array(jsonb_build_object('product_id', v_prod_a, 'quantity', 1, 'unit_price_cents', 2000)),
    jsonb_build_array(jsonb_build_object('method', 'cash', 'amount_cents', 2100)),
    null, null, null, null, 0, null, null, v_loc_id);
  if (select journal_entry_id from public.sales where id = v_sale_id) is null then
    raise exception 'FAIL: a cashier without ledger.post could not post a sale';
  end if;
  perform set_config('request.jwt.claims', json_build_object('sub', v_user_id)::text, true);

  -- 6. A LINE-level discount credits 4000 at LIST and debits 4200.
  --
  --    Deliberately a line discount and NOT an order-level one. The first
  --    version of the posting block credited 4000 with v_gross_cents, and the
  --    item loop computes `v_line := price_cents * qty - v_line_discount`
  --    before accumulating it -- so v_gross_cents is already net of every line
  --    and promotion discount. An order-level discount is subtracted later and
  --    would have passed against the broken code; a line-level one is the only
  --    shape that catches it. Promotions are the app's main discount mechanism
  --    and take exactly this path, so a shop using them read 4200 Discounts
  --    Given as flat zero with Sales Revenue understated by the same amount.
  --
  --    1 @ 2000 less 500 = 1500 net. Tax 5% of 1500 = 75. Total 1575.
  --    Correct:  Cr 4000 -2000 (list), Dr 4200 500.
  --    Broken:   Cr 4000 -1500 (net),  no 4200 line at all.
  --    Every figure here is distinct -- 1575, 2000, 500, 75, 700 -- so a check
  --    reading the wrong account fails rather than coincidentally passing.
  v_sale_id := public.complete_sale(
    v_shop_id,
    jsonb_build_array(jsonb_build_object(
      'product_id', v_prod_a, 'quantity', 1, 'unit_price_cents', 2000, 'discount_cents', 500)),
    jsonb_build_array(jsonb_build_object('method', 'cash', 'amount_cents', 1575)),
    null, null, null, null, 0, null, null, v_loc_id);
  select journal_entry_id into v_entry from public.sales where id = v_sale_id;

  -- Asserted, not assumed: if the line discount never reached sale_items the
  -- rest of this check would be measuring an undiscounted sale.
  select coalesce(sum(si.discount_cents), 0) into v_amount
    from public.sale_items si where si.sale_id = v_sale_id;
  if v_amount <> 500 then
    raise exception 'FAIL: the fixture line discount did not land on sale_items, got %', v_amount;
  end if;

  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l join public.accounts a on a.id = l.account_id
   where l.entry_id = v_entry and a.code = '4000';
  if v_amount <> -2000 then
    raise exception 'FAIL: expected Cr 4000 Revenue -2000 at LIST, got % (-1500 = the discount netted into revenue)', v_amount;
  end if;

  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l join public.accounts a on a.id = l.account_id
   where l.entry_id = v_entry and a.code = '4200';
  if v_amount <> 500 then
    raise exception 'FAIL: expected Dr 4200 Discounts Given 500, got % (0 = line discounts never reach 4200)', v_amount;
  end if;

  -- Still balances, which is the other half of the fix: adding the discount to
  -- both the revenue credit and the 4200 debit cannot move the total.
  select coalesce(sum(amount_cents), 0) into v_amount from public.journal_lines where entry_id = v_entry;
  if v_amount <> 0 then
    raise exception 'FAIL: the discounted entry does not balance, off by %', v_amount;
  end if;

  -- 7. Two entries in a row take two different references, from a counter.
  --
  --    A genuine two-session race CANNOT be exercised from this harness -- one
  --    DO block is one session, and the collision needs two overlapping
  --    transactions in READ COMMITTED. So this asserts the MECHANISM instead:
  --    that references come from a per-shop-per-year counter which advances
  --    once per post, and that the count(*)-based formula that raced is gone.
  --
  --    What it replaced: post_journal_entry used to build its reference as
  --    `count(*) + 1` over the shop's entries for the year and insert against
  --    unique (shop_id, reference). Two tills posting at once both counted N,
  --    both built the same reference, and the second died with a raw
  --    "duplicate key value violates unique constraint" -- which src/lib/sales.ts
  --    rethrows and src/lib/checkout-errors.ts passes through verbatim, so the
  --    cashier saw the constraint name and lost the basket.
  select next_number into v_next_before
    from public.journal_entry_sequences
   where shop_id = v_shop_id and year = to_char(now(), 'YYYY');
  if v_next_before is null then
    raise exception 'FAIL: no journal_entry_sequences row for this shop and year -- references are not coming from the counter';
  end if;

  v_entry_a := public.post_journal_entry(
    v_shop_id, now()::date, 'Sequence probe A',
    jsonb_build_array(
      jsonb_build_object('code', '1000', 'amount_cents', 100),
      jsonb_build_object('code', '4000', 'amount_cents', -100)),
    v_loc_id);
  v_entry_b := public.post_journal_entry(
    v_shop_id, now()::date, 'Sequence probe B',
    jsonb_build_array(
      jsonb_build_object('code', '1000', 'amount_cents', 100),
      jsonb_build_object('code', '4000', 'amount_cents', -100)),
    v_loc_id);

  select reference into v_ref_a from public.journal_entries where id = v_entry_a;
  select reference into v_ref_b from public.journal_entries where id = v_entry_b;
  if v_ref_a is null or v_ref_b is null then
    raise exception 'FAIL: a posted entry has no reference (% and %)', v_ref_a, v_ref_b;
  end if;
  if v_ref_a = v_ref_b then
    raise exception 'FAIL: two entries posted in a row share the reference % -- the allocator does not advance', v_ref_a;
  end if;

  select next_number into v_next_after
    from public.journal_entry_sequences
   where shop_id = v_shop_id and year = to_char(now(), 'YYYY');
  if v_next_after <> v_next_before + 2 then
    raise exception 'FAIL: the reference counter went % -> % over two posts, expected +2', v_next_before, v_next_after;
  end if;

  -- And directly: the racing formula is not in the function any more. Asserted
  -- against the LIVE definition rather than against migration text, because
  -- this repo has migrations that rewrite functions by text substitution and a
  -- grep of the .sql files would not see them.
  select pg_get_functiondef(
           'public.post_journal_entry(uuid, date, text, jsonb, uuid, text)'::regprocedure)
    into v_text;
  if position('count(*) + 1' in v_text) > 0 then
    raise exception 'FAIL: post_journal_entry still allocates its reference with count(*) + 1, which races two concurrent sales in one shop';
  end if;
  if position('journal_entry_sequences' in v_text) = 0 then
    raise exception 'FAIL: post_journal_entry does not read journal_entry_sequences';
  end if;

  -- 8. COGS is FROZEN on the line, never re-read from products.cost_cents.
  --
  --    The fixture now moves products.cost_cents to a clearly different value
  --    part-way through, which is what the earlier version of this check was
  --    missing: with the cost constant for the whole script, an implementation
  --    reading products.cost_cents produced the identical 2500 and the check
  --    whose comment said "never products.cost_cents" could not fail.
  --
  --    Two assertions, and both are needed. The new sale must cost 9999 -- so
  --    the fixture really did change and a stale-cost read would show 700 --
  --    and check 1's entry, posted before the change, must still read 2500.
  update public.products set cost_cents = 9999 where id = v_prod_a;

  v_sale_id := public.complete_sale(
    v_shop_id,
    jsonb_build_array(jsonb_build_object('product_id', v_prod_a, 'quantity', 1, 'unit_price_cents', 2000)),
    jsonb_build_array(jsonb_build_object('method', 'cash', 'amount_cents', 2100)),
    null, null, null, null, 0, null, null, v_loc_id);
  select journal_entry_id into v_entry from public.sales where id = v_sale_id;

  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l join public.accounts a on a.id = l.account_id
   where l.entry_id = v_entry and a.code = '5000';
  if v_amount <> 9999 then
    raise exception 'FAIL: expected Dr 5000 COGS 9999 from the new cost, got % (700 = the old one)', v_amount;
  end if;

  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l join public.accounts a on a.id = l.account_id
   where l.entry_id = v_entry_1 and a.code = '5000';
  if v_amount <> 2500 then
    raise exception 'FAIL: check 1''s COGS moved to % when products.cost_cents changed; it must stay 2500', v_amount;
  end if;

  -- 9. A sale dated into a CLOSED period posts to the CURRENT one, and the
  --    entry says why.
  --
  --    open_period_for refuses any non-open period, and src/lib/sales-import.ts
  --    passes p_created_at for every CSV-imported historical sale -- so before
  --    20260908000300, a shop that had closed any month could not import a sale
  --    into it: the whole row group failed with a ledger error on an import
  --    screen. Redating is the correct accounting treatment, not a workaround.
  --    A transaction that arrives after its month has closed posts to the open
  --    period; that is what closing means.
  --
  --    MUTATION (proves this check): in complete_sale, change
  --    `if v_period_status is not null and v_period_status <> 'open'` to
  --    `if false` -- i.e. never redate. Expected: this check fails with
  --    open_period_for's own `This period is closed` exception.
  v_today_local  := (now() at time zone 'Africa/Mogadishu')::date;
  v_month_closed := (date_trunc('month', (now() at time zone 'Africa/Mogadishu')) - interval '2 months')::date;
  v_month_open   := (date_trunc('month', (now() at time zone 'Africa/Mogadishu')) - interval '1 month')::date;
  v_month_tz     := (date_trunc('month', (now() at time zone 'Africa/Mogadishu')) - interval '4 months')::date;

  -- First a sale into that month while it is still OPEN, which both creates the
  -- period row for the update below to close and establishes the baseline: a
  -- backdated sale posts to its own month. Without this the redating in the
  -- next step could be nothing more than "backdating never works".
  v_date := v_month_closed + 14;
  v_sale_id := public.complete_sale(
    v_shop_id,
    jsonb_build_array(jsonb_build_object('product_id', v_prod_b, 'quantity', 1, 'unit_price_cents', 3000)),
    jsonb_build_array(jsonb_build_object('method', 'cash', 'amount_cents', 3150)),
    null, null, null, null, 0, null,
    (v_date + time '10:00') at time zone 'Africa/Mogadishu', v_loc_id);

  select e.entry_date into v_date_actual
    from public.journal_entries e
    join public.sales s on s.journal_entry_id = e.id
   where s.id = v_sale_id;
  if v_date_actual <> v_date then
    raise exception 'FAIL: a backdated sale into an OPEN month posted on %, expected its own date %',
      v_date_actual, v_date;
  end if;

  update public.accounting_periods set status = 'closed'
   where shop_id = v_shop_id and starts_on = v_month_closed;
  if not found then
    raise exception 'FAIL: no accounting_periods row for % to close -- the backdated sale did not open one',
      v_month_closed;
  end if;

  -- Now the same month, closed. The sale must SUCCEED.
  v_date := v_month_closed + 19;
  v_sale_id := public.complete_sale(
    v_shop_id,
    jsonb_build_array(jsonb_build_object('product_id', v_prod_b, 'quantity', 1, 'unit_price_cents', 3000)),
    jsonb_build_array(jsonb_build_object('method', 'cash', 'amount_cents', 3150)),
    null, null, null, null, 0, null,
    (v_date + time '10:00') at time zone 'Africa/Mogadishu', v_loc_id);

  select e.entry_date, e.description into v_date_actual, v_text
    from public.journal_entries e
    join public.sales s on s.journal_entry_id = e.id
   where s.id = v_sale_id;
  if v_date_actual is null then
    raise exception 'FAIL: a sale backdated into a closed month posted no entry';
  end if;
  if v_date_actual <> v_today_local then
    raise exception 'FAIL: a sale backdated into a CLOSED month posted on %, expected the current period (%)',
      v_date_actual, v_today_local;
  end if;

  -- The reason has to live on the ENTRY. sales.created_at knows the true date,
  -- but the journal is what an auditor reads, and an unexplained entry in the
  -- current month is exactly the thing they will ask about.
  if v_text not like '%' || to_char(v_date, 'YYYY-MM-DD') || '%' then
    raise exception 'FAIL: the redated entry''s description "%" does not name the true sale date %',
      v_text, to_char(v_date, 'YYYY-MM-DD');
  end if;

  -- And the sale row itself keeps its true date. Only the recognition moves;
  -- redating the source row would corrupt every sales report as well.
  select (s.created_at at time zone 'Africa/Mogadishu')::date into v_date_actual
    from public.sales s where s.id = v_sale_id;
  if v_date_actual <> v_date then
    raise exception 'FAIL: the sale row was redated to %; only the journal entry should move (%)',
      v_date_actual, v_date;
  end if;

  -- 10. ...and a sale dated into a month that is still OPEN still posts to that
  --     month. Without this, an implementation that redated EVERY backdated
  --     sale to today would pass check 9 while destroying the one thing
  --     p_created_at exists for.
  --
  --     MUTATION (proves this check): in complete_sale, change
  --     `if v_period_status is not null and v_period_status <> 'open'` to
  --     `if true` -- redate everything. It reddens with today's date where the
  --     backdated one should be. Note it fires at check 9's own open-month
  --     baseline a few lines up, which is the same assertion made earlier;
  --     neutralise that one to watch this line fail on its own.
  v_date := v_month_open + 9;
  v_sale_id := public.complete_sale(
    v_shop_id,
    jsonb_build_array(jsonb_build_object('product_id', v_prod_b, 'quantity', 1, 'unit_price_cents', 3000)),
    jsonb_build_array(jsonb_build_object('method', 'cash', 'amount_cents', 3150)),
    null, null, null, null, 0, null,
    (v_date + time '10:00') at time zone 'Africa/Mogadishu', v_loc_id);

  select e.entry_date into v_date_actual
    from public.journal_entries e
    join public.sales s on s.journal_entry_id = e.id
   where s.id = v_sale_id;
  if v_date_actual <> v_date then
    raise exception 'FAIL: a sale dated into an OPEN month posted on %, expected % (% = everything is being redated)',
      v_date_actual, v_date, v_today_local;
  end if;

  -- 11. The entry date is the SHOP'S local date, not the server's.
  --
  --     `coalesce(p_created_at, now())::date` resolves in the session's
  --     timezone, which is UTC on Supabase. Every market kaiibi serves is UTC+3,
  --     so a sale rung up at 01:30 local on the 1st is 22:30 UTC on the last day
  --     of the previous month -- and posted into the wrong period, while
  --     src/lib/period.ts put it in the right one on the sales report. The two
  --     disagreed permanently, because a closed period's entry cannot be
  --     re-dated.
  --
  --     22:30 UTC on the LAST day of a month is the deliberate choice: it is the
  --     only shape where the UTC answer and the local answer are in different
  --     months, so a wrong implementation cannot coincidentally pass.
  --
  --     MUTATION (proves this check): in complete_sale, put
  --     `coalesce(p_created_at, now())::date` back in place of the
  --     `at time zone 'Africa/Mogadishu'` cast. Expected: this check fails with
  --     the last day of the previous month.
  v_date     := (v_month_tz + interval '1 month - 1 day')::date;  -- last day of that month
  v_expected := (v_month_tz + interval '1 month')::date;          -- the 1st of the next
  -- Self-check: if these ever land in the same month the assertion below is
  -- satisfied by both the right and the wrong answer and proves nothing.
  if to_char(v_date, 'YYYY-MM') = to_char(v_expected, 'YYYY-MM') then
    raise exception 'FAIL: the timezone fixture dates % and % are in the same month', v_date, v_expected;
  end if;

  v_sale_id := public.complete_sale(
    v_shop_id,
    jsonb_build_array(jsonb_build_object('product_id', v_prod_b, 'quantity', 1, 'unit_price_cents', 3000)),
    jsonb_build_array(jsonb_build_object('method', 'cash', 'amount_cents', 3150)),
    null, null, null, null, 0, null,
    (v_date + time '22:30') at time zone 'UTC', v_loc_id);

  select e.entry_date into v_date_actual
    from public.journal_entries e
    join public.sales s on s.journal_entry_id = e.id
   where s.id = v_sale_id;
  if v_date_actual <> v_expected then
    raise exception 'FAIL: a sale at 22:30 UTC on % posted on %, expected % (% = the entry date resolved in UTC, not shop-local)',
      v_date, v_date_actual, v_expected, v_date;
  end if;

  -- 12. A refund posts RETURNS, not negative revenue. 4000 must not move: a
  --     refund that reduced Sales Revenue would make a month's revenue depend
  --     on when the return happened, and the Discounts & Refunds report would
  --     have nothing to read.
  --
  --     Check 1's sale, which was paid IN FULL in cash: 2 @ 2000 (cost 700)
  --     plus 1 @ 3000, gross 7000, tax 350, total 7350. One unit of product A
  --     goes back, which is 2000 of the 7000 gross -- so 2100 of the 7350 the
  --     customer handed over, of which 100 is tax and 2000 is merchandise, and
  --     700 of cost comes back into stock. Every one of those five figures is
  --     distinct, so a check reading the wrong account fails rather than
  --     coincidentally passing.
  --
  --     Note products.cost_cents for product A was moved to 9999 by check 8.
  --     The 700 asserted below is therefore also a second, independent proof
  --     that the refund reads the cost FROZEN on the sale line.
  select id into v_item_a from public.sale_items
   where sale_id = v_sale_id_cash and product_id = v_prod_a;
  if v_item_a is null then
    raise exception 'FAIL: check 1''s sale has no product-A line for the refund fixture';
  end if;

  v_refund_id := public.refund_sale_items(
    v_sale_id_cash,
    jsonb_build_array(jsonb_build_object('sale_item_id', v_item_a, 'quantity', 1)));
  select journal_entry_id into v_entry from public.refunds where id = v_refund_id;
  if v_entry is null then
    raise exception 'FAIL: the refund did not post';
  end if;

  select source into v_text from public.journal_entries where id = v_entry;
  if v_text <> 'refund' then
    raise exception 'FAIL: expected source=refund, got % (manual would mean it gated on ledger.post)', v_text;
  end if;

  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l join public.accounts a on a.id = l.account_id
   where l.entry_id = v_entry and a.code = '4000';
  if v_amount <> 0 then
    raise exception 'FAIL: a refund must not touch 4000 Sales Revenue, it moved by %', v_amount;
  end if;

  -- Dr 4100 Sales Returns 2000 -- the merchandise, net of the tax coming back.
  -- 2100 here would mean the tax was booked as a return; 0 would mean the
  -- return was netted into revenue instead.
  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l join public.accounts a on a.id = l.account_id
   where l.entry_id = v_entry and a.code = '4100';
  if v_amount <> 2000 then
    raise exception 'FAIL: expected Dr 4100 Sales Returns 2000, got % (2100 = the tax was returned as merchandise)', v_amount;
  end if;

  -- Dr 2100 Sales Tax Payable 100 -- the shop owes the tax authority less now.
  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l join public.accounts a on a.id = l.account_id
   where l.entry_id = v_entry and a.code = '2100';
  if v_amount <> 100 then
    raise exception 'FAIL: expected Dr 2100 Sales Tax Payable 100 coming back, got %', v_amount;
  end if;

  -- Cr 1000 Cash 2100 -- this sale was paid in full, so real money goes out.
  -- Nothing lands on 1100: there is no receivable on a sale nobody owes for,
  -- and crediting one would drive the customer's balance negative.
  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l join public.accounts a on a.id = l.account_id
   where l.entry_id = v_entry and a.code = '1000';
  if v_amount <> -2100 then
    raise exception 'FAIL: expected Cr 1000 Cash -2100 handed back, got %', v_amount;
  end if;
  if exists (select 1 from public.journal_lines l join public.accounts a on a.id = l.account_id
              where l.entry_id = v_entry and a.code = '1100') then
    raise exception 'FAIL: a refund on a fully-paid sale must not touch 1100 Receivable';
  end if;

  -- The goods came back, so their cost comes out of COGS and back into stock.
  -- One returned unit of product A: cost 700.
  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l join public.accounts a on a.id = l.account_id
   where l.entry_id = v_entry and a.code = '1200';
  if v_amount <> 700 then
    raise exception 'FAIL: expected Dr 1200 Inventory 700 for the returned unit, got % (9999 = today''s cost, not the frozen one)', v_amount;
  end if;
  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l join public.accounts a on a.id = l.account_id
   where l.entry_id = v_entry and a.code = '5000';
  if v_amount <> -700 then
    raise exception 'FAIL: expected Cr 5000 COGS -700 for the returned unit, got %', v_amount;
  end if;

  select coalesce(sum(amount_cents), 0) into v_amount from public.journal_lines where entry_id = v_entry;
  if v_amount <> 0 then
    raise exception 'FAIL: the refund entry does not balance, off by %', v_amount;
  end if;

  -- 13. Settling a balance moves receivable to cash and touches nothing else.
  --     Posting revenue again here is the classic double-count, so 4000 is
  --     asserted absent rather than merely unchanged.
  --
  --     Check 3's sale: total 4200, paid 1500, so 2700 is owed and 2700 was
  --     debited to 1100 when it was rung up. Settling it in full must credit
  --     exactly that back out.
  perform public.settle_sale_balance(
    v_sale_id_credit,
    jsonb_build_array(jsonb_build_object('method', 'cash', 'amount_cents', 2700)));

  select journal_entry_id into v_entry from public.sale_payments
   where sale_id = v_sale_id_credit and is_settlement order by created_at desc limit 1;
  if v_entry is null then
    raise exception 'FAIL: the settlement did not post';
  end if;

  select source into v_text from public.journal_entries where id = v_entry;
  if v_text <> 'settlement' then
    raise exception 'FAIL: expected source=settlement, got % (manual would mean it gated on ledger.post)', v_text;
  end if;

  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l join public.accounts a on a.id = l.account_id
   where l.entry_id = v_entry and a.code = '1100';
  if v_amount <> -2700 then
    raise exception 'FAIL: expected Cr 1100 Receivable -2700, got %', v_amount;
  end if;

  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l join public.accounts a on a.id = l.account_id
   where l.entry_id = v_entry and a.code = '1000';
  if v_amount <> 2700 then
    raise exception 'FAIL: expected Dr 1000 Cash 2700, got %', v_amount;
  end if;

  if exists (select 1 from public.journal_lines l join public.accounts a on a.id = l.account_id
              where l.entry_id = v_entry and a.code = '4000') then
    raise exception 'FAIL: a settlement must not post revenue again';
  end if;

  -- Exactly two lines, so the entry is the whole of the movement and not a
  -- balanced pair with something else quietly riding along.
  select count(*) into v_amount from public.journal_lines where entry_id = v_entry;
  if v_amount <> 2 then
    raise exception 'FAIL: expected a two-line settlement entry, got % lines', v_amount;
  end if;

  -- 14. A refund on a PART-PAID sale splits the credit between cash and the
  --     receivable, and check 12 cannot see this.
  --
  --     Check 12 refunds a sale paid in full, where the cash going out and the
  --     value coming back are the same figure -- so it passes against an
  --     implementation that branches ("all to 1100 if anything is still owed,
  --     otherwise all to cash") as readily as against one that splits. On a
  --     part-paid sale the two figures differ and the branch is wrong in both
  --     directions: it either hands over cash the shop never took, or drives
  --     the customer's balance negative by refunding a debt that was never
  --     incurred. refund_sale_items has capped the cash at what was collected
  --     since 20260831000200 -- an entry that ignores that cap does not balance
  --     against the refund row it is posted for.
  --
  --     2 @ 3000 (cost 1100 each) = 6000 gross, tax 300, total 6300. Paid 2000
  --     in cash, so 4300 is owed. Both units go back, so the whole 6300 of
  --     value returns -- but only the 2000 that was collected can be handed
  --     over, and the other 4300 comes off what is owed.
  --
  --     Product B, not A: check 8 moved product A's cost to 9999, and 2200 of
  --     COGS reads more plainly. Every figure is distinct -- 6000, 300, 2000,
  --     4300, 2200 -- so a check reading the wrong account fails rather than
  --     coincidentally passing.
  v_sale_id := public.complete_sale(
    v_shop_id,
    jsonb_build_array(jsonb_build_object('product_id', v_prod_b, 'quantity', 2, 'unit_price_cents', 3000)),
    jsonb_build_array(jsonb_build_object('method', 'cash', 'amount_cents', 2000)),
    null, null, null, null, 0, v_customer_id, null, v_loc_id, 0, null, true);

  select id into v_item_a from public.sale_items
   where sale_id = v_sale_id and product_id = v_prod_b;

  v_refund_id := public.refund_sale_items(
    v_sale_id,
    jsonb_build_array(jsonb_build_object('sale_item_id', v_item_a, 'quantity', 2)));
  select journal_entry_id into v_entry from public.refunds where id = v_refund_id;
  if v_entry is null then
    raise exception 'FAIL: the part-paid refund did not post';
  end if;

  -- Asserted, not assumed: if refund_sale_items ever stopped capping the cash
  -- at what was collected, the rest of this check would be measuring a refund
  -- that is not the one this check exists for.
  select total_cents into v_amount from public.refunds where id = v_refund_id;
  if v_amount <> 2000 then
    raise exception 'FAIL: the fixture refund handed back % in cash, expected 2000 -- the cap is gone', v_amount;
  end if;
  select goods_cents into v_amount from public.refunds where id = v_refund_id;
  if v_amount <> 6300 then
    raise exception 'FAIL: the fixture refund returned % of value, expected 6300', v_amount;
  end if;

  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l join public.accounts a on a.id = l.account_id
   where l.entry_id = v_entry and a.code = '1000';
  if v_amount <> -2000 then
    raise exception 'FAIL: expected Cr 1000 Cash -2000, the only money that came in, got % (-6300 = cash the shop never took)', v_amount;
  end if;

  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l join public.accounts a on a.id = l.account_id
   where l.entry_id = v_entry and a.code = '1100';
  if v_amount <> -4300 then
    raise exception 'FAIL: expected Cr 1100 Receivable -4300, got % (-6300 = the balance is driven negative; 0 = the debt is never cleared)', v_amount;
  end if;

  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l join public.accounts a on a.id = l.account_id
   where l.entry_id = v_entry and a.code = '4100';
  if v_amount <> 6000 then
    raise exception 'FAIL: expected Dr 4100 Sales Returns 6000, got %', v_amount;
  end if;

  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l join public.accounts a on a.id = l.account_id
   where l.entry_id = v_entry and a.code = '1200';
  if v_amount <> 2200 then
    raise exception 'FAIL: expected Dr 1200 Inventory 2200 for the two returned units, got %', v_amount;
  end if;

  select coalesce(sum(amount_cents), 0) into v_amount from public.journal_lines where entry_id = v_entry;
  if v_amount <> 0 then
    raise exception 'FAIL: the part-paid refund entry does not balance, off by %', v_amount;
  end if;

  -- 15. Both entry dates come from shop_local_date(), not from now()::date.
  --
  --     Asserted against the LIVE function source rather than by comparing the
  --     posted entry_date to an expected day, because a value comparison only
  --     bites for the three hours a day when the UTC date and the Mogadishu
  --     date differ -- 21:00-24:00 UTC. A refund takes no p_created_at, so
  --     unlike checks 9-11 this script cannot choose the moment: run at noon,
  --     `now()::date` and `shop_local_date()` agree and a value check passes
  --     while the bug is fully present. Confirmed by mutation: swapping every
  --     shop_local_date() in the migration for now()::date left this whole
  --     script green.
  --
  --     What that bug costs is why it is worth a source assertion. Somalia is
  --     UTC+3, so a refund at 01:30 local on the 1st is 22:30 UTC on the last
  --     day of the previous month -- it posts into the wrong period, and once
  --     that period closes a posted entry cannot be re-dated. Permanent, and
  --     invisible until someone reconciles a month.
  --
  --     Read from pg_get_functiondef, like check 7, rather than by grepping the
  --     migration files: this repo has migrations that rewrite functions by
  --     substituting pg_proc.prosrc at runtime, and a grep of the .sql files
  --     would not see them.
  foreach v_text in array array[
    'public.refund_sale_items(uuid, jsonb)',
    'public.settle_sale_balance(uuid, jsonb, uuid)'
  ] loop
    -- COMMENTS STRIPPED FIRST, and this is not tidiness. pg_get_functiondef
    -- returns the body verbatim, comments included, and both functions carry a
    -- comment reading "shop_local_date(), never now()::date" that explains the
    -- very rule being checked. Searching the raw source therefore matched the
    -- explanation rather than the code, and the check failed against a
    -- perfectly correct function. Caught the first time it was run.
    select regexp_replace(pg_get_functiondef(v_text::regprocedure), '--[^\n]*', '', 'g')
      into v_src;

    if position('shop_local_date' in v_src) = 0 then
      raise exception 'FAIL: % does not call shop_local_date(); its entry date is not the shop''s local date', v_text;
    end if;
    -- The bare cast, specifically. Both functions use now() legitimately
    -- elsewhere -- product_location_stock.updated_at, sales.settled_at -- so
    -- the needle is the DATE cast, which has no legitimate use here.
    if position('now()::date' in v_src) > 0 then
      raise exception 'FAIL: % still dates an entry with now()::date, which resolves in UTC', v_text;
    end if;
  end loop;

  -- 16. A settlement's entry belongs to the till that TOOK the money, not to
  --     the branch that rang the sale.
  --
  --     A balance is settled days later at whatever till happens to be open,
  --     and that till may be at another branch.
  --     20260831000300_settlement_cash_belongs_to_its_till.sql fixed the DRAWER
  --     side of exactly this -- register_session_expected now attributes a
  --     payment through coalesce(sp.register_session_id, s.register_session_id)
  --     -- because the till that took the cash was closing with a surplus
  --     variance it could not explain. Stamping the journal entry with the
  --     SALE's location re-opens the same bug one layer down: Branch B's till
  --     is credited with the cash while Branch A's 1000 Cash is debited with
  --     it, the two views disagree permanently, and a per-branch P&L is wrong
  --     in both branches.
  --
  --     Check 13 cannot see this: it settles a sale with no session at all, so
  --     the sale's location is also the right answer there.
  insert into public.shop_locations (shop_id, name) values (v_shop_id, 'Branch B')
    returning id into v_loc_b;
  insert into public.registers (shop_id, location_id, name)
    values (v_shop_id, v_loc_b, 'Counter B') returning id into v_register_b;
  -- The session is inserted directly rather than through
  -- open_register_session(): that RPC needs a shop_members row for the CALLER,
  -- and this fixture's owner deliberately has none (only the check-5 cashier
  -- does). Nothing under test here is the opening path.
  select id into v_member_id from public.shop_members
   where shop_id = v_shop_id and user_id = v_staff_id;
  insert into public.register_sessions (shop_id, location_id, register_id, shop_member_id, opened_by)
    values (v_shop_id, v_loc_b, v_register_b, v_member_id, v_user_id)
    returning id into v_session_b;

  -- Rung at Branch A: 1 @ 3000, tax 150, total 3150, of which 1000 is paid.
  -- 2150 is left owed and is what gets settled at Branch B.
  v_sale_id := public.complete_sale(
    v_shop_id,
    jsonb_build_array(jsonb_build_object('product_id', v_prod_b, 'quantity', 1, 'unit_price_cents', 3000)),
    jsonb_build_array(jsonb_build_object('method', 'cash', 'amount_cents', 1000)),
    null, null, null, null, 0, v_customer_id, null, v_loc_id, 0, null, true);

  -- Asserted, not assumed. If the sale ever stopped being rung at Branch A the
  -- two locations would coincide and everything below would pass while saying
  -- nothing.
  select location_id into v_loc_actual from public.sales where id = v_sale_id;
  if v_loc_actual is distinct from v_loc_id or v_loc_b = v_loc_id then
    raise exception 'FAIL: the fixture sale is not at a different branch from the settling till';
  end if;

  perform public.settle_sale_balance(
    v_sale_id,
    jsonb_build_array(jsonb_build_object('method', 'cash', 'amount_cents', 2150)),
    v_session_b);

  select journal_entry_id into v_entry from public.sale_payments
   where sale_id = v_sale_id and is_settlement order by created_at desc limit 1;
  if v_entry is null then
    raise exception 'FAIL: the cross-branch settlement did not post';
  end if;

  select location_id into v_loc_actual from public.journal_entries where id = v_entry;
  if v_loc_actual is distinct from v_loc_b then
    raise exception 'FAIL: the settlement entry is stamped with location %, expected the settling till''s % (% = the branch that rang the sale)',
      v_loc_actual, v_loc_b, v_loc_id;
  end if;

  -- The LINE too, not just the entry. post_journal_entry defaults each line's
  -- location_id from the entry's, so a line reading the sale's branch would
  -- mean the entry header was right and the money still landed in the wrong
  -- branch's cash column -- which is the figure a per-branch P&L reads.
  select l.location_id into v_loc_actual
    from public.journal_lines l join public.accounts a on a.id = l.account_id
   where l.entry_id = v_entry and a.code = '1000';
  if v_loc_actual is distinct from v_loc_b then
    raise exception 'FAIL: the settlement''s 1000 Cash line is at location %, expected the settling till''s % (% = the branch that rang the sale)',
      v_loc_actual, v_loc_b, v_loc_id;
  end if;

  -- 17. A refund on a SPLIT-TENDER sale credits every tender it came in on, in
  --     proportion to what that tender brought in.
  --
  --     complete_sale posts one debit line per payment method and check 2 pins
  --     that -- "two lines against two accounts is the whole reason the drawer
  --     and the wallet can be reconciled separately". A refund that credits the
  --     single largest method undoes it on the way out, and it disagrees with
  --     register_session_expected (20260831000300:44-59), which pro-rates the
  --     same refund across the same tenders. The drawer count and the ledger
  --     then differ with nothing anywhere to explain why.
  --
  --     The review's exact scenario: a sale of 600 paid 100 cash + 500 zaad,
  --     refunded 200. The cash share is 200 x 100/600 = 33 and the zaad share
  --     200 x 500/600 = 167 -- and 33 is exactly what register_session_expected
  --     takes out of the cash drawer for this refund. The lump posted 1020 Zaad
  --     -200 and 1000 Cash 0, so every figure below is visibly different under
  --     it.
  --
  --     TAX IS SWITCHED OFF FIRST, and it stays off for the rest of the script.
  --     A 5% tax cannot produce a total of exactly 600, and the review's
  --     figures are worth keeping literal -- 33 and 167 are the numbers the
  --     drawer will show. Every check that depends on tax (1, 3, 12, 14, 16)
  --     has already run by here; 18 below does not care.
  update public.shops set tax_enabled = false where id = v_shop_id;
  insert into public.products (shop_id, name, price_cents, cost_cents)
    values (v_shop_id, 'Posting Split', 200, 60) returning id into v_prod_split;
  insert into public.product_location_stock (product_id, location_id, stock)
    values (v_prod_split, v_loc_id, 100);

  v_sale_id := public.complete_sale(
    v_shop_id,
    jsonb_build_array(jsonb_build_object('product_id', v_prod_split, 'quantity', 3, 'unit_price_cents', 200)),
    jsonb_build_array(
      jsonb_build_object('method', 'cash', 'amount_cents', 100),
      jsonb_build_object('method', 'zaad', 'amount_cents', 500)),
    null, null, null, null, 0, null, null, v_loc_id);

  select total_cents into v_amount from public.sales where id = v_sale_id;
  if v_amount <> 600 then
    raise exception 'FAIL: the split-tender fixture sale totals %, expected 600 -- the tax is still on', v_amount;
  end if;

  select id into v_item_a from public.sale_items
   where sale_id = v_sale_id and product_id = v_prod_split;
  v_refund_id := public.refund_sale_items(
    v_sale_id,
    jsonb_build_array(jsonb_build_object('sale_item_id', v_item_a, 'quantity', 1)));
  select journal_entry_id into v_entry from public.refunds where id = v_refund_id;
  if v_entry is null then
    raise exception 'FAIL: the split-tender refund did not post';
  end if;

  select total_cents into v_amount from public.refunds where id = v_refund_id;
  if v_amount <> 200 then
    raise exception 'FAIL: the fixture refund handed back %, expected 200 -- the scenario is not the one this check is about', v_amount;
  end if;

  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l join public.accounts a on a.id = l.account_id
   where l.entry_id = v_entry and a.code = '1000';
  if v_amount <> -33 then
    raise exception 'FAIL: expected Cr 1000 Cash -33, the cash tender''s share of the 200 refunded, got % (0 = the whole refund went out of one method)', v_amount;
  end if;

  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l join public.accounts a on a.id = l.account_id
   where l.entry_id = v_entry and a.code = '1020';
  if v_amount <> -167 then
    raise exception 'FAIL: expected Cr 1020 Zaad -167, the zaad tender''s share of the 200 refunded, got % (-200 = the whole refund went out of one method)', v_amount;
  end if;

  -- The two together are the cash actually handed back, to the cent. Rounding
  -- 33.33 and 166.67 independently and posting both would be 200 here too, but
  -- 33 + 167 is the only pair that is both exact and never over-credits a
  -- tender -- and if the allocation ever loses or invents a cent, the entry
  -- stops balancing rather than quietly paying it out.
  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l join public.accounts a on a.id = l.account_id
   where l.entry_id = v_entry and a.code in ('1000', '1020');
  if v_amount <> -200 then
    raise exception 'FAIL: the tender lines sum to % , expected exactly -200, the cash the refund handed back', v_amount;
  end if;

  -- Paid in full, so nothing lands on the receivable.
  if exists (select 1 from public.journal_lines l join public.accounts a on a.id = l.account_id
              where l.entry_id = v_entry and a.code = '1100') then
    raise exception 'FAIL: a refund on a fully-paid split-tender sale must not touch 1100 Receivable';
  end if;

  select coalesce(sum(amount_cents), 0) into v_amount from public.journal_lines where entry_id = v_entry;
  if v_amount <> 0 then
    raise exception 'FAIL: the split-tender refund entry does not balance, off by %', v_amount;
  end if;

  -- 18. The behavioural half of check 15: the entry date is the SHOP's local
  --     date whatever the session's timezone is.
  --
  --     Check 15 reads the function text, which is all it can do for a value
  --     that only differs from now()::date for three hours a day -- and a body
  --     that wrote `now() :: date` with a spare shop_local_date() call
  --     elsewhere would sail through it. This is the deterministic version.
  --
  --     shop_local_date() is (p_at at time zone 'Africa/Mogadishu')::date and
  --     does not read the session's TimeZone at all. now()::date resolves
  --     against it -- and `set search_path = public` on these functions pins
  --     search_path, not TimeZone, so a value set here reaches inside them.
  --
  --     Etc/GMT+12 is UTC-12 and Pacific/Kiritimati is UTC+14: 26 hours apart,
  --     so their local dates differ at EVERY instant, and this check reddens at
  --     any hour of any day rather than only between 21:00 and 24:00 UTC.
  v_sale_id := public.complete_sale(
    v_shop_id,
    jsonb_build_array(jsonb_build_object('product_id', v_prod_split, 'quantity', 2, 'unit_price_cents', 200)),
    jsonb_build_array(jsonb_build_object('method', 'cash', 'amount_cents', 400)),
    null, null, null, null, 0, null, null, v_loc_id);
  select id into v_item_a from public.sale_items
   where sale_id = v_sale_id and product_id = v_prod_split;

  -- Self-check: if the two zones could ever agree, the assertion below would be
  -- satisfied by the bug as readily as by the fix.
  if (now() at time zone 'Etc/GMT+12')::date = (now() at time zone 'Pacific/Kiritimati')::date then
    raise exception 'FAIL: the two fixture timezones agree on today''s date, so this check proves nothing';
  end if;

  v_tz_saved := current_setting('timezone');

  perform set_config('timezone', 'Etc/GMT+12', true);
  v_refund_id := public.refund_sale_items(
    v_sale_id,
    jsonb_build_array(jsonb_build_object('sale_item_id', v_item_a, 'quantity', 1)));
  select journal_entry_id into v_entry_tz1 from public.refunds where id = v_refund_id;

  perform set_config('timezone', 'Pacific/Kiritimati', true);
  v_refund_id := public.refund_sale_items(
    v_sale_id,
    jsonb_build_array(jsonb_build_object('sale_item_id', v_item_a, 'quantity', 1)));
  select journal_entry_id into v_entry_tz2 from public.refunds where id = v_refund_id;

  -- Restored before the assertions, so a failure message is not itself printed
  -- under a fixture timezone.
  perform set_config('timezone', v_tz_saved, true);

  if v_entry_tz1 is null or v_entry_tz2 is null then
    raise exception 'FAIL: one of the two timezone refunds did not post';
  end if;
  select entry_date into v_date_tz1 from public.journal_entries where id = v_entry_tz1;
  select entry_date into v_date_tz2 from public.journal_entries where id = v_entry_tz2;

  if v_date_tz1 <> v_date_tz2 then
    raise exception 'FAIL: the same refund dated % under Etc/GMT+12 and % under Pacific/Kiritimati -- the entry date is resolving in the session timezone',
      v_date_tz1, v_date_tz2;
  end if;
  if v_date_tz1 <> public.shop_local_date() then
    raise exception 'FAIL: the refund posted on %, but the shop''s local date is %',
      v_date_tz1, public.shop_local_date();
  end if;

  -- 19. An EDITED sale reverses its entry and posts a new one from the edited
  --     figures. Three entries survive: what was posted, its undoing, and what
  --     is true now.
  --
  --     edit_sale changes items, totals, tax and payments, and a posted entry is
  --     immutable -- refuse_posted_entry_edit() sees to that. So without this,
  --     every sale edit leaves the ledger reading the PRE-edit figures with
  --     nothing anywhere saying so, which is the exact disagreement between the
  --     books and their source that phase 1 was built to make impossible.
  --
  --     Tax goes back ON for this check and the three after it. Check 17 turned
  --     it off to make 600 reachable and said it stays off "for the rest of the
  --     script"; that was written when 17 and 18 were the rest of the script.
  --     Nothing between here and the end depends on it being off, and an edit
  --     that silently dropped the tax line would otherwise be invisible.
  --
  --     2 @ 3000 (cost 1100) = 6000 gross, tax 300, total 6300, COGS 2200.
  --     Edited down to 1 @ 3000: 3000 gross, tax 150, total 3150, COGS 1100.
  --     EVERY figure differs from the original's, so an implementation that
  --     re-posted the pre-edit figures fails rather than coincidentally passing.
  update public.shops set tax_enabled = true where id = v_shop_id;

  v_sale_id_edit := public.complete_sale(
    v_shop_id,
    jsonb_build_array(jsonb_build_object('product_id', v_prod_b, 'quantity', 2, 'unit_price_cents', 3000)),
    jsonb_build_array(jsonb_build_object('method', 'cash', 'amount_cents', 6300)),
    null, null, null, null, 0, null, null, v_loc_id);

  select journal_entry_id into v_entry_orig from public.sales where id = v_sale_id_edit;
  if v_entry_orig is null then
    raise exception 'FAIL: the sale to be edited posted no entry to begin with';
  end if;

  -- Asserted, not assumed: if the fixture sale were not the 6000/300/2200 one
  -- described above, every net below would be measuring something else.
  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l join public.accounts a on a.id = l.account_id
   where l.entry_id = v_entry_orig and a.code = '4000';
  if v_amount <> -6000 then
    raise exception 'FAIL: the pre-edit entry credits 4000 with %, expected -6000 -- the tax is still off', v_amount;
  end if;

  perform public.edit_sale(
    v_sale_id_edit,
    jsonb_build_array(jsonb_build_object('product_id', v_prod_b, 'quantity', 1, 'unit_price_cents', 3000)),
    jsonb_build_array(jsonb_build_object('method', 'cash', 'amount_cents', 3150)));

  -- The sale points at a DIFFERENT entry now.
  select journal_entry_id into v_entry from public.sales where id = v_sale_id_edit;
  if v_entry is null then
    raise exception 'FAIL: the edited sale has no journal entry';
  end if;
  if v_entry = v_entry_orig then
    raise exception 'FAIL: the edit left sales.journal_entry_id on the original entry -- the ledger now disagrees with the sale';
  end if;

  -- The original is REVERSED, not deleted and not edited, and the reversal
  -- points back at it. A book is added to, not amended.
  select status into v_text from public.journal_entries where id = v_entry_orig;
  if v_text <> 'reversed' then
    raise exception 'FAIL: the original entry is %, expected reversed', v_text;
  end if;

  select id into v_entry_rev from public.journal_entries
   where reverses_entry_id = v_entry_orig and id <> v_entry_orig;
  if v_entry_rev is null then
    raise exception 'FAIL: no reversing entry points back at the original';
  end if;
  if v_entry_rev = v_entry then
    raise exception 'FAIL: the reversal and the replacement are the same entry';
  end if;

  -- The link runs both ways, which is what makes neither entry readable without
  -- finding the other.
  select reverses_entry_id into v_entry_a from public.journal_entries where id = v_entry_orig;
  if v_entry_a is distinct from v_entry_rev then
    raise exception 'FAIL: the original points at % rather than at its reversal %', v_entry_a, v_entry_rev;
  end if;

  -- The reference convention reverse_journal_entry established: the original's
  -- with an R, so the pair reads as a pair in the journals list.
  select e.reference into v_text from public.journal_entries e where e.id = v_entry_rev;
  select r.reference || 'R' into v_ref_a from public.journal_entries r where r.id = v_entry_orig;
  if v_text is distinct from v_ref_a then
    raise exception 'FAIL: the reversal is referenced %, expected % (the original''s with an R)', v_text, v_ref_a;
  end if;

  -- The reversal negates the original LINE FOR LINE. Asserted per account
  -- rather than in total, because a reversal that negated the wrong lines can
  -- still sum to zero overall.
  if exists (
    select 1 from public.journal_lines l
     where l.entry_id in (v_entry_orig, v_entry_rev)
     group by l.account_id
    having coalesce(sum(l.amount_cents), 0) <> 0
  ) then
    raise exception 'FAIL: the reversal does not negate the original account for account';
  end if;
  select count(*) into v_line_count from public.journal_lines where entry_id = v_entry_orig;
  select count(*) into v_amount    from public.journal_lines where entry_id = v_entry_rev;
  if v_amount <> v_line_count then
    raise exception 'FAIL: the original has % lines and its reversal %', v_line_count, v_amount;
  end if;

  -- The replacement is a SALE entry, not a manual one, and it names its sale.
  select source, description into v_text, v_src from public.journal_entries where id = v_entry;
  if v_text <> 'sale' then
    raise exception 'FAIL: the re-posted entry has source % (manual would mean it gated on ledger.post)', v_text;
  end if;
  if v_src not like '%' || v_sale_id_edit::text || '%' then
    raise exception 'FAIL: the re-posted entry description "%" does not name its sale %', v_src, v_sale_id_edit;
  end if;

  -- The three entries NET to the corrected figures. Asserted as a sum across
  -- all three rather than on the new entry alone: that is the property a trial
  -- balance actually reads, and it is the one a reversal that negated the wrong
  -- lines would break.
  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l
    join public.accounts a on a.id = l.account_id
   where a.code = '4000' and l.entry_id in (v_entry_orig, v_entry_rev, v_entry);
  if v_amount <> -3000 then
    raise exception 'FAIL: 4000 Revenue nets to % across the three entries, expected -3000 (-6000 = the edit never re-posted)', v_amount;
  end if;

  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l
    join public.accounts a on a.id = l.account_id
   where a.code = '2100' and l.entry_id in (v_entry_orig, v_entry_rev, v_entry);
  if v_amount <> -150 then
    raise exception 'FAIL: 2100 Sales Tax nets to % across the three entries, expected -150 (-300 = the old tax survived the edit)', v_amount;
  end if;

  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l
    join public.accounts a on a.id = l.account_id
   where a.code = '1000' and l.entry_id in (v_entry_orig, v_entry_rev, v_entry);
  if v_amount <> 3150 then
    raise exception 'FAIL: 1000 Cash nets to % across the three entries, expected 3150', v_amount;
  end if;

  -- COGS follows the goods, and from the cost FROZEN on the re-written line.
  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l
    join public.accounts a on a.id = l.account_id
   where a.code = '5000' and l.entry_id in (v_entry_orig, v_entry_rev, v_entry);
  if v_amount <> 1100 then
    raise exception 'FAIL: 5000 COGS nets to % across the three entries, expected 1100 (2200 = the returned unit''s cost is still expensed)', v_amount;
  end if;
  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l
    join public.accounts a on a.id = l.account_id
   where a.code = '1200' and l.entry_id in (v_entry_orig, v_entry_rev, v_entry);
  if v_amount <> -1100 then
    raise exception 'FAIL: 1200 Inventory nets to % across the three entries, expected -1100', v_amount;
  end if;

  -- And each of the two new entries balances on its own.
  select coalesce(sum(amount_cents), 0) into v_amount from public.journal_lines where entry_id = v_entry;
  if v_amount <> 0 then
    raise exception 'FAIL: the re-posted entry does not balance, off by %', v_amount;
  end if;
  select coalesce(sum(amount_cents), 0) into v_amount from public.journal_lines where entry_id = v_entry_rev;
  if v_amount <> 0 then
    raise exception 'FAIL: the reversing entry does not balance, off by %', v_amount;
  end if;

  -- 20. A cashier holding sales.edit and NOT ledger.post can still edit a sale.
  --
  --     reverse_journal_entry requires ledger.post; edit_sale requires
  --     sales.edit. If the reversal is done through that door, every edit in
  --     every shop stops until someone grants till staff a ledger permission
  --     they must not have -- which is the same failure check 5 exists to
  --     prevent on the selling side. So the reversal is done INLINE inside
  --     edit_sale's own security-definer body, exactly as complete_sale posts
  --     with p_source => 'sale' rather than gating the till on ledger.post.
  --
  --     Edited back UP to 2 @ 3000: 6000 gross, tax 300, total 6300. Going up
  --     rather than down so the second edit cannot pass by doing nothing.
  perform set_config('request.jwt.claims', json_build_object('sub', v_staff_id)::text, true);
  -- Asserted, not assumed, twice over: without the first the check passes while
  -- proving nothing, and without the second it would fail for the wrong reason.
  if public.has_shop_permission(v_shop_id, 'ledger.post') then
    raise exception 'FAIL: the fixture cashier holds ledger.post, so check 20 would prove nothing';
  end if;
  if not public.has_shop_permission(v_shop_id, 'sales.edit') then
    raise exception 'FAIL: the fixture cashier does not hold sales.edit, so check 20 cannot run';
  end if;

  perform public.edit_sale(
    v_sale_id_edit,
    jsonb_build_array(jsonb_build_object('product_id', v_prod_b, 'quantity', 2, 'unit_price_cents', 3000)),
    jsonb_build_array(jsonb_build_object('method', 'cash', 'amount_cents', 6300)));
  perform set_config('request.jwt.claims', json_build_object('sub', v_user_id)::text, true);

  -- The second edit reversed the FIRST edit's entry in its turn. Six entries
  -- after two edits -- three postings and three reversals -- is correct, not
  -- noise.
  select status into v_text from public.journal_entries where id = v_entry;
  if v_text <> 'reversed' then
    raise exception 'FAIL: the second edit left the first edit''s entry %, expected reversed', v_text;
  end if;
  select journal_entry_id into v_entry_a from public.sales where id = v_sale_id_edit;
  if v_entry_a is null or v_entry_a = v_entry then
    raise exception 'FAIL: the cashier''s edit did not re-post the sale';
  end if;

  -- 21. Editing a sale whose period has CLOSED redates both the reversal and
  --     the replacement into the current period, and both say why.
  --
  --     A reversal belongs in the period of the entry it undoes -- that is what
  --     reverse_journal_entry's own comment says and why it dates itself to the
  --     original. But open_period_for refuses any non-open period, so an edit
  --     to a sale whose month has since been closed would fail outright at the
  --     reversal, and a manager correcting last quarter's mis-rung sale would
  --     be told the ledger would not have it. That is 20260908000300's problem
  --     in a place 20260908000300 did not reach, and it gets the same answer: a
  --     correction that arrives after its month has closed is recognised in the
  --     open period. Redating is what closing MEANS.
  --
  --     MUTATION (proves this check): in edit_sale, drop the period-status test
  --     and date the reversal at the original entry's date unconditionally.
  --     Expected: this check fails with open_period_for's own
  --     `This period is closed`.
  v_date := v_month_open + 15;
  v_sale_id := public.complete_sale(
    v_shop_id,
    jsonb_build_array(jsonb_build_object('product_id', v_prod_b, 'quantity', 1, 'unit_price_cents', 3000)),
    jsonb_build_array(jsonb_build_object('method', 'cash', 'amount_cents', 3150)),
    null, null, null, null, 0, null,
    (v_date + time '10:00') at time zone 'Africa/Mogadishu', v_loc_id);

  select journal_entry_id into v_entry_orig from public.sales where id = v_sale_id;
  select entry_date into v_date_actual from public.journal_entries where id = v_entry_orig;
  if v_date_actual <> v_date then
    raise exception 'FAIL: the fixture sale for check 21 posted on % rather than into the month about to be closed (%)',
      v_date_actual, v_date;
  end if;

  update public.accounting_periods set status = 'closed'
   where shop_id = v_shop_id and starts_on = v_month_open;
  if not found then
    raise exception 'FAIL: no accounting_periods row for % to close', v_month_open;
  end if;

  perform public.edit_sale(
    v_sale_id,
    jsonb_build_array(jsonb_build_object('product_id', v_prod_b, 'quantity', 2, 'unit_price_cents', 3000)),
    jsonb_build_array(jsonb_build_object('method', 'cash', 'amount_cents', 6300)));

  select journal_entry_id into v_entry from public.sales where id = v_sale_id;
  select entry_date, description into v_date_actual, v_src
    from public.journal_entries where id = v_entry;
  if v_date_actual <> v_today_local then
    raise exception 'FAIL: the replacement entry for a closed-period sale posted on %, expected the current period (%)',
      v_date_actual, v_today_local;
  end if;
  if v_src not like '%' || to_char(v_date, 'YYYY-MM-DD') || '%' then
    raise exception 'FAIL: the redated replacement "%" does not name the sale''s true date %',
      v_src, to_char(v_date, 'YYYY-MM-DD');
  end if;

  select id, entry_date, description into v_entry_rev, v_date_actual, v_src
    from public.journal_entries where reverses_entry_id = v_entry_orig and id <> v_entry_orig;
  if v_entry_rev is null then
    raise exception 'FAIL: the closed-period edit posted no reversal';
  end if;
  if v_date_actual <> v_today_local then
    raise exception 'FAIL: the reversal of a closed-period entry posted on %, expected the current period (%)',
      v_date_actual, v_today_local;
  end if;
  if v_src not like '%' || to_char(v_date, 'YYYY-MM-DD') || '%' then
    raise exception 'FAIL: the redated reversal "%" does not name the original entry''s date %',
      v_src, to_char(v_date, 'YYYY-MM-DD');
  end if;
  -- The STATUS as well as the date, and this is the null trap 20260908000300
  -- was caught by: `||` with a NULL operand yields NULL for the whole
  -- expression, so a status read back as NULL nulls the entire description and
  -- post_journal_entry then refuses the edit with "A journal entry needs a
  -- description" -- an error about descriptions for a bug about dates.
  if v_src not like '%closed%' then
    raise exception 'FAIL: the redated reversal "%" does not say the original period was closed', v_src;
  end if;

  -- 22. An edit does NOT re-debit money that arrived as a SETTLEMENT.
  --
  --     edit_sale deletes and re-inserts the till's own payments and leaves
  --     settlements alone (20260831000100) -- so sale_payments after an edit
  --     holds both, and a posting block that debits cash for every row on it
  --     books the settled money a second time. The settlement already has its
  --     own entry (Dr Cash / Cr Receivable, check 13), and reversing the SALE's
  --     entry does not touch it. So the replacement carries the till's payments
  --     only, and puts the whole of the rest on 1100 -- which nets, against the
  --     settlement entry still standing, to exactly what is owed.
  --
  --     2 @ 3000 = 6000 gross, tax 300, total 6300, of which 2000 is paid at
  --     the till and 1500 settled later, leaving 2800 owed. Edited down to
  --     1 @ 3000: 3000 gross, tax 150, total 3150, till payment 1000. Collected
  --     is then 2500 and 650 is owed. Every figure is distinct.
  v_sale_id := public.complete_sale(
    v_shop_id,
    jsonb_build_array(jsonb_build_object('product_id', v_prod_b, 'quantity', 2, 'unit_price_cents', 3000)),
    jsonb_build_array(jsonb_build_object('method', 'cash', 'amount_cents', 2000)),
    null, null, null, null, 0, v_customer_id, null, v_loc_id, 0, null, true);
  select journal_entry_id into v_entry_orig from public.sales where id = v_sale_id;

  perform public.settle_sale_balance(
    v_sale_id,
    jsonb_build_array(jsonb_build_object('method', 'cash', 'amount_cents', 1500)));
  select journal_entry_id into v_entry_settle from public.sale_payments
   where sale_id = v_sale_id and is_settlement order by created_at desc limit 1;
  if v_entry_settle is null then
    raise exception 'FAIL: the fixture settlement for check 22 did not post';
  end if;

  perform public.edit_sale(
    v_sale_id,
    jsonb_build_array(jsonb_build_object('product_id', v_prod_b, 'quantity', 1, 'unit_price_cents', 3000)),
    jsonb_build_array(jsonb_build_object('method', 'cash', 'amount_cents', 1000)),
    null, null, null, 0, v_customer_id, true);

  select journal_entry_id into v_entry from public.sales where id = v_sale_id;
  select id into v_entry_rev from public.journal_entries
   where reverses_entry_id = v_entry_orig and id <> v_entry_orig;
  if v_entry is null or v_entry_rev is null then
    raise exception 'FAIL: the edit of a part-settled sale did not reverse and re-post';
  end if;

  -- Asserted, not assumed: if the settlement had been deleted by the edit the
  -- nets below would be describing a different sale from the one this check is
  -- about.
  select coalesce(sum(amount_cents), 0) into v_amount from public.sale_payments
   where sale_id = v_sale_id;
  if v_amount <> 2500 then
    raise exception 'FAIL: the part-settled sale has % collected against it, expected 2500', v_amount;
  end if;

  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l
    join public.accounts a on a.id = l.account_id
   where a.code = '1000'
     and l.entry_id in (v_entry_orig, v_entry_rev, v_entry_settle, v_entry);
  if v_amount <> 2500 then
    raise exception 'FAIL: 1000 Cash nets to % over this sale''s four entries, expected 2500, the money actually collected (4000 = the settlement was debited twice)', v_amount;
  end if;

  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l
    join public.accounts a on a.id = l.account_id
   where a.code = '1100'
     and l.entry_id in (v_entry_orig, v_entry_rev, v_entry_settle, v_entry);
  if v_amount <> 650 then
    raise exception 'FAIL: 1100 Receivable nets to % over this sale''s four entries, expected 650, what is still owed (-850 = the settlement cleared a debt the edit then never re-raised)', v_amount;
  end if;

  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l
    join public.accounts a on a.id = l.account_id
   where a.code = '4000'
     and l.entry_id in (v_entry_orig, v_entry_rev, v_entry_settle, v_entry);
  if v_amount <> -3000 then
    raise exception 'FAIL: 4000 Revenue nets to % over this sale''s four entries, expected -3000', v_amount;
  end if;

  raise notice 'ALL CHECKS PASSED';
  raise exception 'rollback fixture';
exception
  when others then
    if sqlerrm = 'rollback fixture' then return; end if;
    raise;
end $$;
