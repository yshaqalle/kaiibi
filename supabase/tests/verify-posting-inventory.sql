-- The two inventory RPCs -- receive_stock and save_stock_count -- write a
-- balanced double-entry journal entry in the same transaction that moves the
-- stock.
--
-- Nine things are asserted, and none of them can be checked from TypeScript
-- because all nine are facts about rows this database wrote for itself:
--
--   1. a costed delivery posts Dr 1200 Inventory / Cr 2000 Accounts Payable for
--      the WHOLE delivery. Payable, not cash: receive_stock records goods
--      ARRIVING and says nothing about whether they were paid for.
--   2. a delivery with no stated cost posts NOTHING -- not a zero-value entry.
--      journal_lines carries check (amount_cents <> 0), so a zero line does not
--      merely mislead, it raises and takes the whole delivery with it.
--   3. THE ONE THIS TASK EXISTS FOR. products.cost_cents still moves on a
--      weighted average. receive_stock has to be copied forward from
--      20260907000000_moving_weighted_average.sql; copying it from
--      20260902000000_stock_receipts.sql instead silently restores "latest
--      wins" -- replacement cost, which is not one of the two formulas IAS 2.25
--      permits -- and EVERY OTHER CHECK IN THIS FILE STILL PASSES, because none
--      of them reads products.cost_cents.
--   4. a SHORT count debits 5100 Inventory Shrinkage, which sits in COST OF
--      SALES above gross profit, and credits 1200. Not an operating expense:
--      a unit that is stolen or breaks is never sold, so its cost never enters
--      COGS by any other path and gross profit reads high by exactly that
--      amount, every month, invisibly.
--   5. an OVER count REVERSES the direction rather than posting a negative
--      shrinkage. A negative debit and a negative credit sum to zero and pass
--      the balance trigger while meaning nothing a reader can act on.
--   6. an UNCOSTED product's variance posts nothing. There is no value to move,
--      and inventing one is what isUncosted() exists to prevent.
--   7. a count whose net variance is EXACTLY ZERO posts nothing. A count that
--      found what it expected is not an accounting event.
--   8. both entries carry their own source ('receipt', 'count'), never
--      'manual'. The fixture owner holds ledger.post, so a posting call that
--      left p_source at its 'manual' default would sail through the permission
--      gate in post_journal_entry and only bite for a member who does not --
--      i.e. in production, on someone else's shop.
--   9. both entries are dated from public.shop_local_date(), asserted against
--      the live function source. Somalia is UTC+3, so now()::date and the
--      shop's date differ for three hours a day and a value comparison would
--      only bite in that window.
--
-- Deliberately NOT `set role authenticated`, for the same reason
-- verify-posting-sales.sql is not: this script stays superuser so RLS never
-- hides a journal_lines row from its own assertions. Nothing under test here is
-- an RLS policy -- both RPCs are security definer and gate on
-- has_shop_permission(), which reads auth.uid() from the JWT claim set below
-- and does not care which postgres role is executing.
--
-- Everything runs inside one DO block whose EXCEPTION clause rolls it all back.

\set ON_ERROR_STOP on

do $$
declare
  v_user_id       uuid := gen_random_uuid();
  v_shop_id       uuid;
  v_loc_id        uuid;
  v_prod_a        uuid;
  v_prod_b        uuid;
  v_prod_uncosted uuid;
  v_receipt_id    uuid;
  v_count_id      uuid;
  v_entry         uuid;
  v_amount        bigint;
  v_text          text;
  v_date          date;
  v_src           text;
begin
  -- shops.owner_id, stock_receipts.created_by and stock_counts.created_by all
  -- reference auth.users(id), so the fixture "person" needs a real row there
  -- before anything else.
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
    values (v_user_id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            'verify-posting-inventory-' || v_user_id || '@example.test', '', now(), now(), now());

  insert into public.shops (owner_id, name) values (v_user_id, 'Posting Stock Shop')
    returning id into v_shop_id;

  -- A shop has no location until the fixture makes one; seed_shop_defaults does
  -- not create one. It does seed the chart of accounts, which is where 1200,
  -- 2000 and 5100 come from.
  insert into public.shop_locations (shop_id, name, is_primary)
    values (v_shop_id, 'Main', true) returning id into v_loc_id;

  -- All three start with NO cost and NO stock, so every cost below is one this
  -- script's own deliveries put there and check 3's arithmetic has a known
  -- opening position. Cost NULL, never 0: isUncosted() is careful that these
  -- are different answers -- a free sample really does cost nothing, an
  -- unpriced product is a question nobody answered -- and checks 2 and 6 turn
  -- on the distinction.
  insert into public.products (shop_id, name, price_cents, cost_cents, stock)
    values (v_shop_id, 'Posting Tea', 2000, null, 0) returning id into v_prod_a;
  insert into public.products (shop_id, name, price_cents, cost_cents, stock)
    values (v_shop_id, 'Posting Coffee', 3000, null, 0) returning id into v_prod_b;
  insert into public.products (shop_id, name, price_cents, cost_cents, stock)
    values (v_shop_id, 'Posting Sample', 900, null, 0) returning id into v_prod_uncosted;

  -- has_shop_permission -> auth.uid() -> request.jwt.claims->>'sub'. Without
  -- this every call below is refused as unauthorized.
  perform set_config('request.jwt.claims', json_build_object('sub', v_user_id)::text, true);

  -- 1. A costed delivery posts Dr 1200 / Cr 2000.
  --    40 @ 250 plus 10 @ 900 = 10000 + 9000 = 19000.
  --    The two lines are chosen so the total cannot be reached by reading only
  --    one of them, and 19000 is not a multiple of either line.
  v_receipt_id := public.receive_stock(v_shop_id, v_loc_id, jsonb_build_array(
    jsonb_build_object('product_id', v_prod_a, 'quantity', 40, 'unit_cost_cents', 250),
    jsonb_build_object('product_id', v_prod_b, 'quantity', 10, 'unit_cost_cents', 900)));

  select journal_entry_id into v_entry from public.stock_receipts where id = v_receipt_id;
  if v_entry is null then raise exception 'FAIL: the receipt did not post'; end if;

  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l join public.accounts a on a.id = l.account_id
   where l.entry_id = v_entry and a.code = '1200';
  if v_amount <> 19000 then
    raise exception 'FAIL: expected Dr 1200 Inventory 19000, got % (10000 or 9000 = only one line read)', v_amount;
  end if;
  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l join public.accounts a on a.id = l.account_id
   where l.entry_id = v_entry and a.code = '2000';
  if v_amount <> -19000 then
    raise exception 'FAIL: expected Cr 2000 Payable -19000, got %', v_amount;
  end if;
  -- Payable, not cash. Asserted ABSENT rather than merely unchecked: crediting
  -- 1000 Cash would balance just as happily and would say the supplier had been
  -- paid on delivery, which is a statement receive_stock has no basis to make.
  if exists (select 1 from public.journal_lines l join public.accounts a on a.id = l.account_id
              where l.entry_id = v_entry and a.code in ('1000', '1010')) then
    raise exception 'FAIL: a delivery must not credit cash -- nothing here says it was paid for';
  end if;

  -- 8a. The receipt's own source, not the 'manual' default. The fixture owner
  --     holds ledger.post, so 'manual' would pass the gate here and only be
  --     discovered by a stockroom member who does not hold it.
  --
  --     'stock', not 'receipt'. The plan named 'receipt'; there is no such
  --     source. journal_entries.source is a closed check constraint
  --     (20260904000300_journal.sql:48) listing 'stock' for this door, and
  --     'receipt' fails it outright -- so the plan's own value would not have
  --     posted at all.
  select source, entry_date into v_text, v_date
    from public.journal_entries where id = v_entry;
  if v_text <> 'stock' then
    raise exception 'FAIL: expected source ''stock'', got %', v_text;
  end if;
  -- 9a. Behavioural half of check 9: the date the entry actually carries is the
  --     shop's local date, not the session's.
  if v_date <> public.shop_local_date() then
    raise exception 'FAIL: the receipt entry should be dated %, got %', public.shop_local_date(), v_date;
  end if;

  -- 2. A delivery with NO stated cost posts NOTHING. It is not a zero-value
  --    receipt; it is a receipt whose value is unknown, and inventing 0 for it
  --    would understate stock on hand by exactly the amount nobody recorded.
  v_receipt_id := public.receive_stock(v_shop_id, v_loc_id, jsonb_build_array(
    jsonb_build_object('product_id', v_prod_a, 'quantity', 5)));
  if (select journal_entry_id from public.stock_receipts where id = v_receipt_id) is not null then
    raise exception 'FAIL: an uncosted delivery should post no entry at all';
  end if;

  -- 3. THE ONE THAT MATTERS FOR TASK 6. The weighted average still works.
  --    Copying receive_stock forward from 20260902000000 instead of
  --    20260907000000 restores "latest wins" -- an impermissible basis -- and
  --    every other check in this file still passes, because none of them read
  --    products.cost_cents.
  --
  --    Product A: 40 @ 250 (check 1) then 5 uncosted (check 2) then 60 @ 500.
  --    Weighted: (45*250 + 60*500)/105 = (11250 + 30000)/105 = 41250/105
  --    = 392.857..., which round() takes to 393. The brief said 392; 41250 is
  --    not divisible by 105 and the RPC rounds to a whole cent, so 392 is one
  --    below the answer the shipped arithmetic actually produces. It does not
  --    weaken the check: "latest wins" gives 500 and the two still separate by
  --    107 cents.
  perform public.receive_stock(v_shop_id, v_loc_id, jsonb_build_array(
    jsonb_build_object('product_id', v_prod_a, 'quantity', 60, 'unit_cost_cents', 500)));
  select cost_cents into v_amount from public.products where id = v_prod_a;
  if v_amount <> 393 then
    raise exception 'FAIL: expected a weighted 393, got % (500 = receive_stock was copied forward from the wrong ancestor)', v_amount;
  end if;

  -- 4. A SHORT count posts shrinkage into cost of sales, not operating
  --    expenses. 5100 sits above gross profit: a shop losing stock does not
  --    have the margin its P&L would otherwise claim.
  --    Product B holds 10 at cost 900; counting 7 is a variance of -3 = 2700.
  v_count_id := public.save_stock_count(v_shop_id, v_loc_id, jsonb_build_array(
    jsonb_build_object('product_id', v_prod_b, 'counted_quantity', 7, 'reason', 'damaged')));
  select journal_entry_id into v_entry from public.stock_counts where id = v_count_id;
  if v_entry is null then raise exception 'FAIL: the stock count did not post'; end if;

  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l join public.accounts a on a.id = l.account_id
   where l.entry_id = v_entry and a.code = '5100';
  if v_amount <> 2700 then
    raise exception 'FAIL: expected Dr 5100 Shrinkage 2700, got %', v_amount;
  end if;
  -- The other side, asserted rather than left to the balance trigger: the
  -- trigger only knows the entry sums to zero, and 5100 against 6900 sums to
  -- zero just as well as 5100 against 1200 while leaving stock on the balance
  -- sheet that is not on the shelf.
  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l join public.accounts a on a.id = l.account_id
   where l.entry_id = v_entry and a.code = '1200';
  if v_amount <> -2700 then
    raise exception 'FAIL: expected Cr 1200 Inventory -2700, got %', v_amount;
  end if;
  if exists (select 1 from public.journal_lines l join public.accounts a on a.id = l.account_id
              where l.entry_id = v_entry and a.code like '6%') then
    raise exception 'FAIL: shrinkage must not post to an operating expense account';
  end if;

  -- 8b. And the count's source is its own too.
  select source, entry_date into v_text, v_date
    from public.journal_entries where id = v_entry;
  if v_text <> 'count' then
    raise exception 'FAIL: expected source ''count'', got %', v_text;
  end if;
  if v_date <> public.shop_local_date() then
    raise exception 'FAIL: the count entry should be dated %, got %', public.shop_local_date(), v_date;
  end if;

  -- 5. An OVER count reverses the direction rather than posting a negative
  --    shrinkage. Two lines that sum to zero would pass the balance check while
  --    meaning nothing.
  v_count_id := public.save_stock_count(v_shop_id, v_loc_id, jsonb_build_array(
    jsonb_build_object('product_id', v_prod_b, 'counted_quantity', 9, 'reason', 'miscount')));
  select journal_entry_id into v_entry from public.stock_counts where id = v_count_id;
  if v_entry is null then raise exception 'FAIL: an over-count did not post'; end if;
  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l join public.accounts a on a.id = l.account_id
   where l.entry_id = v_entry and a.code = '1200';
  if v_amount <> 1800 then
    raise exception 'FAIL: found stock should DEBIT 1200 by 1800, got %', v_amount;
  end if;
  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l join public.accounts a on a.id = l.account_id
   where l.entry_id = v_entry and a.code = '5100';
  if v_amount <> -1800 then
    raise exception 'FAIL: found stock should CREDIT 5100 by -1800, got % (a negative debit is not a credit)', v_amount;
  end if;
  -- The memo, and this is the only assertion in the file that can tell the two
  -- implementations apart.
  --
  -- The plan predicted that collapsing the two branches into one signed branch
  -- would make the 1200 line come out negative. It does not: with a POSITIVE
  -- variance the short branch's own expressions produce ('5100', -1800) and
  -- ('1200', +1800) -- byte-identical amounts to the reversed branch, because
  -- the sign convention flips the direction for free. Run as written, that
  -- mutation left this whole file green.
  --
  -- What actually differs is what the entry SAYS. A found-stock entry reading
  -- "Stock short / Written off" is a trial-balance line telling a reader the
  -- opposite of what happened, and no amount is wrong anywhere for them to
  -- catch it by. So the memo is what is asserted, and the elsif branch is
  -- load-bearing because of this line.
  select l.memo into v_text
    from public.journal_lines l join public.accounts a on a.id = l.account_id
   where l.entry_id = v_entry and a.code = '1200';
  if v_text <> 'Stock found' then
    raise exception 'FAIL: an over-count''s inventory line should read ''Stock found'', got % (''Written off'' = the short branch posted it)', v_text;
  end if;

  -- 6. An UNCOSTED product's variance posts nothing. There is no value to
  --    move, and inventing one is what isUncosted() exists to prevent.
  v_count_id := public.save_stock_count(v_shop_id, v_loc_id, jsonb_build_array(
    jsonb_build_object('product_id', v_prod_uncosted, 'counted_quantity', 3, 'reason', 'miscount')));
  if (select journal_entry_id from public.stock_counts where id = v_count_id) is not null then
    raise exception 'FAIL: an uncosted variance should post no entry';
  end if;

  -- 7. A count that finds exactly what it expected posts nothing. Product B
  --    stands at 9 after check 5; counting 9 again is a variance of zero, and
  --    an entry for it would be two zero lines -- which journal_lines' check
  --    (amount_cents <> 0) refuses outright, so getting this wrong does not
  --    produce a noisy ledger, it stops the stock-take from being saved at all.
  v_count_id := public.save_stock_count(v_shop_id, v_loc_id, jsonb_build_array(
    jsonb_build_object('product_id', v_prod_b, 'counted_quantity', 9, 'reason', 'miscount')));
  if (select journal_entry_id from public.stock_counts where id = v_count_id) is not null then
    raise exception 'FAIL: a count that found what it expected is not an accounting event';
  end if;

  -- 9b. Structural half of check 9, which 9a cannot do on its own: 9a compares
  --     two values that are equal for 21 hours a day, so a body that said
  --     now()::date would pass it outside the 21:00-24:00 UTC window. Read the
  --     live function source instead.
  --
  --     `--` comments are stripped before the regex runs, and that is not
  --     tidiness: both function bodies contain the sentence "never now()::date"
  --     in a comment explaining why, so a naive match reads the WARNING as the
  --     offence and fails a correct implementation. Caught on the first run of
  --     this check.
  select regexp_replace(pg_get_functiondef(p.oid), '--[^' || chr(10) || ']*', '', 'g') into v_src
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'receive_stock';
  if v_src !~ 'shop_local_date' then
    raise exception 'FAIL: receive_stock must date its entry from shop_local_date()';
  end if;
  if v_src ~ 'now\(\)\s*::\s*date' then
    raise exception 'FAIL: receive_stock still dates an entry with now()::date, which resolves in UTC';
  end if;
  select regexp_replace(pg_get_functiondef(p.oid), '--[^' || chr(10) || ']*', '', 'g') into v_src
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'save_stock_count';
  if v_src !~ 'shop_local_date' then
    raise exception 'FAIL: save_stock_count must date its entry from shop_local_date()';
  end if;
  if v_src ~ 'now\(\)\s*::\s*date' then
    raise exception 'FAIL: save_stock_count still dates an entry with now()::date, which resolves in UTC';
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
