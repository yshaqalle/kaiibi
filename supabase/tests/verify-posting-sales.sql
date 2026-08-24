-- Every completed sale writes a balanced double-entry journal entry, in the
-- same transaction that writes the sale.
--
-- Five things are asserted, and none of them can be checked from TypeScript
-- because all five are facts about rows this database wrote for itself:
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
  v_amount         bigint;
  v_text           text;
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

  raise notice 'ALL CHECKS PASSED';
  raise exception 'rollback fixture';
exception
  when others then
    if sqlerrm = 'rollback fixture' then return; end if;
    raise;
end $$;
