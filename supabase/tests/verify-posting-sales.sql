-- Every completed sale writes a balanced double-entry journal entry, in the
-- same transaction that writes the sale.
--
-- Eight things are asserted, and none of them can be checked from TypeScript
-- because all eight are facts about rows this database wrote for itself:
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

  -- The cashier of check 5: pos.access and nothing else. Written as a plain
  -- roles row plus a membership, which is what verify-inventory-permissions.sql
  -- does -- there is no grant_role_permissions() helper in this database.
  -- Created BEFORE the JWT is switched, while raw inserts are still possible.
  insert into public.roles (shop_id, name, permissions)
    values (v_shop_id, 'Till Only', array['pos.access'])
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

  raise notice 'ALL CHECKS PASSED';
  raise exception 'rollback fixture';
exception
  when others then
    if sqlerrm = 'rollback fixture' then return; end if;
    raise;
end $$;
