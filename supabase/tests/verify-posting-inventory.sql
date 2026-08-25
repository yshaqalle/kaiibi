-- The two inventory RPCs -- receive_stock and save_stock_count -- write a
-- balanced double-entry journal entry in the same transaction that moves the
-- stock.
--
-- Twelve things are asserted, and none of them can be checked from TypeScript
-- because all twelve are facts about rows this database wrote for itself:
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
--  10. A DELETED DELIVERY REVERSES ITS ENTRY (20260908001500). Measured as a
--      shop-wide 1200/2000 returning to a baseline taken before the delivery,
--      because a stranded entry balances on its own and every per-entry
--      assertion above passes while it stands.
--  11. an uncosted delivery deleted is a clean no-op -- there was no entry, so
--      reversing nothing must not raise.
--  12. deleting a SHOP that has deliveries still succeeds. The cascade is an
--      AFTER trigger on the parent, so the shops row is already gone when the
--      reversal trigger fires and a mirror entry would violate
--      journal_entries.shop_id immediately.
--  13. COSTING A PRODUCT THAT ALREADY HELD STOCK IS A REVALUATION, and it
--      posts its own entry: Dr 1200 / Cr 3000 Owner's Capital for the units
--      that were on the shelf before anyone priced them (20260908001800).
--      Five parts, on a shop of their own so that "1200 equals the value of
--      stock on hand" can be asserted SHOP-WIDE -- which is the property the
--      whole thing exists for, and the only one that cannot be satisfied by an
--      entry that merely balances. The three cases that must post NOTHING run
--      before the one that must post something, so a mutation that revalues
--      where it should not is reported by the check that is about it rather
--      than by the worked example's arithmetic downstream.
--        13a. a delivery onto ZERO stock posts no revaluation -- there is
--             nothing on the shelf to revalue, and the units arriving are
--             already carried by the delivery's own entry.
--        13b. a delivery onto COSTED stock posts no revaluation -- the units
--             on the shelf already carry a cost and 1200 already holds it.
--             The weighted average moving is not a revaluation.
--        13c. an UNCOSTED delivery onto uncosted stock posts nothing at all,
--             neither entry. The product stays unpriced and there is nothing
--             to revalue to.
--        13d. the worked example. 50 uncosted units, a delivery of 10 @ 100,
--             then all 60 sold. Without the revaluation 1200 ends at -5,000.
--        13e. deleting the delivery reverses the DELIVERY and leaves the
--             revaluation standing. Nothing un-costs the product, so those
--             units are still valued and 1200 must still say so. This is why
--             the revaluation is a second entry rather than two extra lines
--             on the delivery's own.
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
  -- Checks 10-12, the deletion side.
  v_base_1200     bigint;
  v_base_2000     bigint;
  v_reversal      uuid;
  v_entries       integer;
  v_del_shop      uuid;
  v_del_loc       uuid;
  v_del_prod      uuid;
  -- Check 13, the revaluation. Its own shop, so 1200 can be tied to the whole
  -- shelf rather than to one entry.
  v_rev_shop      uuid;
  v_rev_loc       uuid;
  v_rev_tea       uuid;   -- nothing on the shelf at all                (13a)
  v_rev_coffee    uuid;   -- costed by its first delivery, then a second (13b)
  v_rev_sample    uuid;   -- 30 uncosted, and an uncosted delivery       (13c)
  v_rev_mat       uuid;   -- 50 uncosted, costed later by a delivery     (13d)
  v_rev_entry     uuid;
  v_onhand        bigint;
  v_ledger        bigint;
  v_loc           uuid;
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

  -- 10. A DELETED DELIVERY TAKES ITS ENTRY WITH IT (20260908001500).
  --
  --     Measured shop-wide and against a baseline taken BEFORE the delivery,
  --     not per entry: a stranded entry balances on its own, so every
  --     per-entry assertion in this file passes while 1200 carries stock that
  --     is not on the shelf and 2000 carries money owed for a delivery the
  --     shop says never arrived. The only thing that can see it is the running
  --     total returning -- or not returning -- to where it started.
  --
  --     THE MUTATION THAT MUST REDDEN THIS CHECK: delete the
  --     `create trigger stock_receipts_reverse_on_delete` statement at the foot
  --     of 20260908001500. Run, and it fails at the first of the three
  --     assertions below: 'FAIL: the deleted delivery''s entry should read
  --     ''reversed'', it reads posted'. The 1200/2000 assertions further down
  --     are what catch a trigger that fires but gets the arithmetic wrong.
  select coalesce(sum(l.amount_cents), 0) into v_base_1200
    from public.journal_lines l
    join public.accounts a on a.id = l.account_id
    join public.journal_entries e on e.id = l.entry_id
   where e.shop_id = v_shop_id and a.code = '1200';
  select coalesce(sum(l.amount_cents), 0) into v_base_2000
    from public.journal_lines l
    join public.accounts a on a.id = l.account_id
    join public.journal_entries e on e.id = l.entry_id
   where e.shop_id = v_shop_id and a.code = '2000';

  --     7 @ 1300 = 9100. Chosen so no other figure in this file (19000, 2700,
  --     1800, 393) and no partial reading of the line reaches it.
  v_receipt_id := public.receive_stock(v_shop_id, v_loc_id, jsonb_build_array(
    jsonb_build_object('product_id', v_prod_a, 'quantity', 7, 'unit_cost_cents', 1300)));
  select journal_entry_id into v_entry from public.stock_receipts where id = v_receipt_id;
  if v_entry is null then raise exception 'FAIL: the delivery under test did not post'; end if;

  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l
    join public.accounts a on a.id = l.account_id
    join public.journal_entries e on e.id = l.entry_id
   where e.shop_id = v_shop_id and a.code = '1200';
  if v_amount <> v_base_1200 + 9100 then
    raise exception 'FAIL: fixture -- the delivery should have raised 1200 by 9100, it moved by %', v_amount - v_base_1200;
  end if;

  delete from public.stock_receipts where id = v_receipt_id;

  --     The original is marked reversed, not merely offset. A second entry that
  --     nets it out while the first still reads 'posted' leaves the journals
  --     list showing a live delivery that no longer exists.
  select status into v_text from public.journal_entries where id = v_entry;
  if v_text is distinct from 'reversed' then
    raise exception 'FAIL: the deleted delivery''s entry should read ''reversed'', it reads %', coalesce(v_text, 'gone');
  end if;

  select id into v_reversal from public.journal_entries where reverses_entry_id = v_entry and id <> v_entry;
  if v_reversal is null then
    raise exception 'FAIL: deleting a delivery wrote no mirror entry linked back to the original';
  end if;

  --     A reversal files under the SOURCE IT REVERSES, never a literal. Pinned
  --     phase-wide: a reader filtering source = 'stock' must see the delivery
  --     AND the reversal cancelling it, or a report grouped by source shows the
  --     delivery twice.
  --
  --     THE MUTATION: replace `v_old.source` in the mirror's insert with
  --     `'manual'`. Expected: 'FAIL: the reversal should file under ''stock'''.
  select source into v_text from public.journal_entries where id = v_reversal;
  if v_text <> 'stock' then
    raise exception 'FAIL: the reversal should file under ''stock'', the source it reverses; got %', v_text;
  end if;

  --     And the money is actually back. This is what a copied-rather-than-
  --     negated mirror fails: it doubles instead of cancelling, and both
  --     entries balance throughout.
  --
  --     THE MUTATION: change `-amount_cents` to `amount_cents` in the mirror's
  --     line insert. Expected: 'FAIL: deleting a delivery left 1200 Inventory
  --     at 18200 above where it started'.
  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l
    join public.accounts a on a.id = l.account_id
    join public.journal_entries e on e.id = l.entry_id
   where e.shop_id = v_shop_id and a.code = '1200';
  if v_amount <> v_base_1200 then
    raise exception 'FAIL: deleting a delivery left 1200 Inventory at % above where it started', v_amount - v_base_1200;
  end if;
  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l
    join public.accounts a on a.id = l.account_id
    join public.journal_entries e on e.id = l.entry_id
   where e.shop_id = v_shop_id and a.code = '2000';
  if v_amount <> v_base_2000 then
    raise exception 'FAIL: deleting a delivery left 2000 Accounts Payable % away from where it started', v_amount - v_base_2000;
  end if;

  -- 11. AN UNCOSTED DELIVERY DELETED IS A CLEAN NO-OP. receive_stock writes no
  --     entry at all when no line carries a cost (check 2), so there is nothing
  --     to reverse -- and reversing nothing must not raise, or deleting an
  --     ordinary uncosted delivery fails outright on a ledger the shop never
  --     used.
  --
  --     THE MUTATION: delete the `if old.journal_entry_id is null then return
  --     null; end if;` guard from reverse_stock_receipt_entry(). Expected: the
  --     DELETE below raises 'the journal entry for this delivery is missing, so
  --     it cannot be reversed' -- the lookup finds no row for a null id and the
  --     next guard fires.
  select count(*) into v_entries from public.journal_entries where shop_id = v_shop_id;
  v_receipt_id := public.receive_stock(v_shop_id, v_loc_id, jsonb_build_array(
    jsonb_build_object('product_id', v_prod_a, 'quantity', 4)));
  if (select journal_entry_id from public.stock_receipts where id = v_receipt_id) is not null then
    raise exception 'FAIL: fixture -- the uncosted delivery under test posted an entry';
  end if;
  delete from public.stock_receipts where id = v_receipt_id;
  if (select count(*) from public.journal_entries where shop_id = v_shop_id) <> v_entries then
    raise exception 'FAIL: deleting an uncosted delivery wrote a journal entry; it had nothing to reverse';
  end if;

  -- 12. DELETING A SHOP WITH DELIVERIES STILL WORKS.
  --
  --     `stock_receipts.shop_id` cascades from `shops`, and a cascade is an
  --     AFTER trigger on the parent -- so the shops row is already GONE when
  --     this trigger fires. journal_entries.shop_id is `not null references
  --     shops(id)` with no deferral, so writing a mirror entry here violates
  --     that key immediately and takes the whole shop deletion with it.
  --     delete_shop was broken exactly once before by an FK reached through
  --     journal rows (20260908001200) and must not be broken again by the fix
  --     for a hole that is not reachable yet.
  --
  --     A SEPARATE SHOP, because this deletes it. Its own location, product and
  --     costed delivery, so the trigger really is reached with an entry to
  --     reverse -- a shop with no posted delivery would pass this check with the
  --     skip removed.
  --
  --     THE MUTATION: delete the `if not exists (select 1 from public.shops
  --     where id = old.shop_id) then return null; end if;` skip from
  --     reverse_stock_receipt_entry(). Expected: the DELETE below raises
  --     'the journal entry for this delivery is missing, so it cannot be
  --     reversed'.
  --
  --     MERELY MOVING THE SKIP DOWN reddens this too, and that is the run this
  --     check was written for: with the skip left where
  --     reverse_invoice_payment_entry puts it -- after the entry lookup, reading
  --     v_old.shop_id -- the same message appears. `journal_entries.shop_id`
  --     cascades from `shops` in the SAME statement and its branch runs first,
  --     so the entry is already gone by the time the stock_receipts branch gets
  --     here. Both errors arrive with CONTEXT 'SQL statement "delete from
  --     public.shops"'.
  insert into public.shops (owner_id, name) values (v_user_id, 'Posting Stock Shop To Delete')
    returning id into v_del_shop;
  insert into public.shop_locations (shop_id, name, is_primary)
    values (v_del_shop, 'Main', true) returning id into v_del_loc;
  insert into public.products (shop_id, name, price_cents, cost_cents, stock)
    values (v_del_shop, 'Doomed Tea', 2000, null, 0) returning id into v_del_prod;
  v_receipt_id := public.receive_stock(v_del_shop, v_del_loc, jsonb_build_array(
    jsonb_build_object('product_id', v_del_prod, 'quantity', 3, 'unit_cost_cents', 1700)));
  if (select journal_entry_id from public.stock_receipts where id = v_receipt_id) is null then
    raise exception 'FAIL: fixture -- the doomed shop''s delivery did not post, so check 12 would not reach the skip';
  end if;

  delete from public.shops where id = v_del_shop;
  if exists (select 1 from public.shops where id = v_del_shop) then
    raise exception 'FAIL: the shop survived its own deletion';
  end if;
  if exists (select 1 from public.stock_receipts where shop_id = v_del_shop) then
    raise exception 'FAIL: a stock receipt outlived the shop it belonged to';
  end if;

  ---------------------------------------------------------------------------
  -- 13. COSTING STOCK THAT WAS ALREADY ON THE SHELF (20260908001800).
  ---------------------------------------------------------------------------
  --
  --     receive_stock costs the ENTIRE HOLDING at the delivery's price when the
  --     prior cost is null -- it has nothing to weight an average against. The
  --     units already on the shelf therefore acquire a value the ledger has
  --     never carried a cent of, and until 20260908001800 nothing ever put one
  --     there: a sale of an uncosted product posts no COGS, a count variance on
  --     it posts nothing, and an uncosted delivery is excluded from the
  --     receipt's value. So the shelf became valuable and 1200 did not, and the
  --     next sale credited 1200 for stock it had never been debited for.
  --
  --     A SHOP OF ITS OWN, and that is the design of this check rather than
  --     tidiness. The property being asserted is not "the entry balances" --
  --     every wrong version of this balances -- it is 1200 EQUALS THE VALUE OF
  --     THE STOCK ON HAND, shop-wide, after five deliveries and a sale. That
  --     can only be said about a shop whose whole ledger history was written
  --     here, so the four products below start with no ledger of any kind and
  --     every cent that reaches 1200 is put there by a call in this block.
  --
  --     THE THREE CASES THAT MUST POST NOTHING RUN FIRST, AND THE ORDER IS
  --     LOAD-BEARING. Every mutation that posts a revaluation where none
  --     belongs also disturbs the worked example's arithmetic, so with the
  --     worked example first it would be 13d's figures that reddened and the
  --     message would name the wrong defect. Running the negative cases ahead
  --     of it means each one is caught by the check that is actually about it.
  insert into public.shops (owner_id, name) values (v_user_id, 'Revalued Stock Shop')
    returning id into v_rev_shop;
  insert into public.shop_locations (shop_id, name, is_primary)
    values (v_rev_shop, 'Main', true) returning id into v_rev_loc;

  --     50 mats nobody ever priced -- the shopkeeper's own opening stock, of
  --     which the ledger can say nothing at all while it stays uncosted.
  insert into public.products (shop_id, name, price_cents, cost_cents, stock)
    values (v_rev_shop, 'Prayer mat', 900, null, 50) returning id into v_rev_mat;
  insert into public.products (shop_id, name, price_cents, cost_cents, stock)
    values (v_rev_shop, 'Coffee', 3000, null, 0) returning id into v_rev_coffee;
  insert into public.products (shop_id, name, price_cents, cost_cents, stock)
    values (v_rev_shop, 'Tea', 2000, null, 0) returning id into v_rev_tea;
  insert into public.products (shop_id, name, price_cents, cost_cents, stock)
    values (v_rev_shop, 'Sample', 400, null, 30) returning id into v_rev_sample;

  -- 13a. A DELIVERY ONTO ZERO STOCK POSTS NO REVALUATION. v_new_cost := v_cost
  --      here too -- there is nothing to average against -- but there is also
  --      nothing on the shelf, and the units that arrive are already carried by
  --      the delivery's own entry. Revaluing here counts the delivery twice.
  --
  --      MUTATION: value the whole holding AFTER the upsert and drop the
  --      quantity guard with it --
  --        if v_product.cost_cents is null then
  --          v_reval_cents := v_reval_cents + (v_prior_qty + v_qty)::bigint * v_new_cost;
  --        end if;
  --      which is the reading that follows from "all of these units now cost
  --      this, so value all of them". Expected: 'FAIL: a delivery onto an empty
  --      shelf posted 1 revaluation entries, expected 0'.
  --
  --      IT TAKES BOTH HALVES, and that is worth knowing before anyone
  --      simplifies either. Dropping `and v_prior_qty > 0` on its own is a
  --      NO-OP -- the arithmetic becomes `0 * v_new_cost`, which is 0, which
  --      the `if v_reval_cents > 0` guard at the foot suppresses exactly as
  --      before -- and it was run and confirmed green. Using the post-upsert
  --      quantity on its own never reaches an empty shelf at all, because the
  --      guard stops it; it is caught downstream by 13d's amount instead
  --      ('the revaluation debits 1200 by 6000, expected 5000'). Only together
  --      do they post a revaluation for stock that was not there, which is
  --      what this check is for and why the guard stays.
  perform public.receive_stock(v_rev_shop, v_rev_loc, jsonb_build_array(
    jsonb_build_object('product_id', v_rev_tea, 'quantity', 20, 'unit_cost_cents', 50)));
  select count(*) into v_entries from public.journal_entries
   where shop_id = v_rev_shop and description = 'Existing stock valued';
  if v_entries <> 0 then
    raise exception 'FAIL: a delivery onto an empty shelf posted % revaluation entries, expected 0', v_entries;
  end if;

  -- 13b. A DELIVERY ONTO COSTED STOCK POSTS NO REVALUATION. The units on the
  --      shelf already carry a cost and 1200 already holds it; revaluing them
  --      would post the whole holding a second time.
  --
  --      Coffee is costed by its first delivery (10 @ 300, onto nothing) and
  --      then receives a second (10 @ 500) against a prior cost. The weighted
  --      average moves 300 -> 400 and NOTHING is revalued, even though the cost
  --      of every unit on the shelf did change -- which is the distinction this
  --      check is for: a moving average is already in 1200 by construction,
  --      because every delivery that moved it debited what it paid.
  --
  --      MUTATION: hoist the revaluation out of the null-cost branch, so it
  --      runs after the whole `if v_prior_qty <= 0 or ... else ... end if` on
  --      whatever v_new_cost came out of it:
  --        if v_prior_qty > 0 then
  --          v_reval_cents := v_reval_cents + v_prior_qty::bigint * v_new_cost;
  --        end if;
  --      Run against this file it is CHECK 10 that goes red first -- 'FAIL:
  --      fixture -- the delivery should have raised 1200 by 9100, it moved by
  --      56350' -- because check 10's delivery also lands on costed stock and
  --      it is measuring 1200 shop-wide. That is the same defect reported
  --      earlier, and check 10 is incidentally a second guard on it. Run this
  --      case on its own and it reports what it is for: 'FAIL: a delivery onto
  --      costed stock posted 1 revaluation entries, expected 0' -- confirmed by
  --      running exactly the three statements below against the mutated
  --      function in a fixture of their own.
  --
  --      Note that leaving the block WHERE IT IS and merely dropping
  --      `v_product.cost_cents is null and` from its condition is a NO-OP, run
  --      and confirmed green: the block already sits inside the branch taken
  --      only when the prior cost is null or the shelf is empty, so the clause
  --      it loses was already implied there. The hoist is what changes an
  --      answer.
  perform public.receive_stock(v_rev_shop, v_rev_loc, jsonb_build_array(
    jsonb_build_object('product_id', v_rev_coffee, 'quantity', 10, 'unit_cost_cents', 300)));
  perform public.receive_stock(v_rev_shop, v_rev_loc, jsonb_build_array(
    jsonb_build_object('product_id', v_rev_coffee, 'quantity', 10, 'unit_cost_cents', 500)));
  select cost_cents into v_amount from public.products where id = v_rev_coffee;
  if v_amount <> 400 then
    raise exception 'FIXTURE: coffee costs % after two deliveries, expected a weighted 400', v_amount;
  end if;
  select count(*) into v_entries from public.journal_entries
   where shop_id = v_rev_shop and description = 'Existing stock valued';
  if v_entries <> 0 then
    raise exception 'FAIL: a delivery onto costed stock posted % revaluation entries, expected 0 -- 1200 already holds what those units cost', v_entries;
  end if;

  -- 13c. AN UNCOSTED DELIVERY ONTO UNCOSTED STOCK POSTS NOTHING AT ALL --
  --      neither the delivery's entry (check 2) nor a revaluation. The product
  --      is still unpriced afterwards, so there is no value to revalue TO, and
  --      inventing one is what isUncosted() exists to prevent.
  --
  --      MUTATION: hoist the revaluation out of the `if v_cost is not null`
  --      block and value the line at what the shop sells it for --
  --      `v_prior_qty::bigint * coalesce(v_cost, v_product.price_cents)` --
  --      which is the wrong answer this codebase warns about everywhere and the
  --      one a build reaches for when told an uncosted line is not free.
  --      Expected: 'FAIL: an uncosted delivery onto uncosted stock wrote a
  --      journal entry; there is no figure for either half of it'.
  --
  --      Note what that mutation does NOT redden. Check 2 above is the same
  --      shape and stays green, because product A is costed by the time it
  --      runs and the condition never fires for it -- so this is not a
  --      duplicate of check 2, it is the only place an uncosted line meets
  --      uncosted stock.
  select count(*) into v_entries from public.journal_entries where shop_id = v_rev_shop;
  v_receipt_id := public.receive_stock(v_rev_shop, v_rev_loc, jsonb_build_array(
    jsonb_build_object('product_id', v_rev_sample, 'quantity', 5)));
  if (select journal_entry_id from public.stock_receipts where id = v_receipt_id) is not null then
    raise exception 'FAIL: an uncosted delivery onto uncosted stock posted a delivery entry';
  end if;
  if (select count(*) from public.journal_entries where shop_id = v_rev_shop) <> v_entries then
    raise exception 'FAIL: an uncosted delivery onto uncosted stock wrote a journal entry; there is no figure for either half of it';
  end if;
  --      The reason it must post nothing, asserted rather than assumed: the
  --      product is STILL uncosted. A build that quietly treated the missing
  --      cost as 0 would leave cost_cents = 0 here and pass both assertions
  --      above, because a zero revaluation posts nothing either way.
  select cost_cents into v_amount from public.products where id = v_rev_sample;
  if v_amount is not null then
    raise exception 'FAIL: an uncosted delivery left the sample costed at % -- null is a question nobody answered, 0 is an answer', v_amount;
  end if;

  -- 13d. THE WORKED EXAMPLE. 50 uncosted mats, a delivery of 10 at 100 that
  --      prices all sixty, then all sixty out through the till.
  --
  --      Two entries are expected, not one:
  --        Dr 1200  1000 / Cr 2000  1000   the ten that arrived
  --        Dr 1200  5000 / Cr 3000  5000   the fifty that were already here
  --
  --      MUTATION: delete the `if v_reval_cents > 0 then ... end if;` block at
  --      the foot of receive_stock. Expected: 'FAIL: the delivery that first
  --      costed 50 mats posted 0 revaluation entries, expected exactly 1'.
  select coalesce(sum(l.amount_cents), 0) into v_base_1200
    from public.journal_lines l
    join public.accounts a on a.id = l.account_id
    join public.journal_entries e on e.id = l.entry_id
   where e.shop_id = v_rev_shop and a.code = '1200';

  v_receipt_id := public.receive_stock(v_rev_shop, v_rev_loc, jsonb_build_array(
    jsonb_build_object('product_id', v_rev_mat, 'quantity', 10, 'unit_cost_cents', 100)));

  --      The fixture's own premise, checked before anything is concluded from
  --      it. `is distinct from`, not `<>`: the plausible mutation here -- losing
  --      `or v_product.cost_cents is null` from the average -- leaves the
  --      product UNCOSTED, and `null <> 100` is null, so a `<>` test sails
  --      straight past the thing it was written to catch.
  select cost_cents into v_amount from public.products where id = v_rev_mat;
  if v_amount is distinct from 100 then
    raise exception 'FIXTURE: the mats cost % after the delivery, expected 100 -- receive_stock no longer costs an uncosted holding whole, and check 13 is arguing about something that has changed', v_amount;
  end if;

  select count(*) into v_entries from public.journal_entries
   where shop_id = v_rev_shop and description = 'Existing stock valued';
  if v_entries <> 1 then
    raise exception 'FAIL: the delivery that first costed 50 mats posted % revaluation entries, expected exactly 1', v_entries;
  end if;

  --      And it is a SECOND entry, not the delivery's own. Merged into it, the
  --      delivery's 1200 debit would stop equalling what the supplier is owed
  --      and deleting the delivery would take the revaluation with it (13e).
  select journal_entry_id into v_entry from public.stock_receipts where id = v_receipt_id;
  select id into v_rev_entry from public.journal_entries
   where shop_id = v_rev_shop and description = 'Existing stock valued';
  if v_rev_entry = v_entry then
    raise exception 'FAIL: the revaluation was folded into the delivery''s own entry; it must be a separate one';
  end if;
  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l join public.accounts a on a.id = l.account_id
   where l.entry_id = v_entry and a.code = '2000';
  if v_amount <> -1000 then
    raise exception 'FAIL: the delivery should owe the supplier 1000 -- ten mats at 100 -- got %. 6000 means the revaluation was credited to the supplier', -v_amount;
  end if;

  --      The amounts. 50 x 100 = 5000: the quantity that was already there, at
  --      the cost the delivery gave the whole holding.
  --
  --      MUTATION: change `v_prior_qty::bigint * v_new_cost` to
  --      `v_qty::bigint * v_new_cost` -- revaluing the delivered units instead
  --      of the ones on the shelf. Expected: 'FAIL: the revaluation debits 1200
  --      by 1000, expected 5000'.
  --
  --      SECOND MUTATION, the one that says why the quantity is read before the
  --      upsert: `(v_prior_qty + v_qty)::bigint * v_new_cost`, valuing the
  --      holding as it stands after the delivery. Expected: 'FAIL: the
  --      revaluation debits 1200 by 6000, expected 5000' -- the ten delivered
  --      units counted twice, once here and once in the delivery's own entry.
  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l join public.accounts a on a.id = l.account_id
   where l.entry_id = v_rev_entry and a.code = '1200';
  if v_amount <> 5000 then
    raise exception 'FAIL: the revaluation debits 1200 by %, expected 5000 (the fifty mats already on the shelf, at the 100 the delivery gave them)', v_amount;
  end if;

  --      3000 Owner's Capital. These goods are not owed to a supplier, are not
  --      a loss and are not income -- they are the shopkeeper's own stock,
  --      measurable for the first time, which is what the opening balance in
  --      20260908001300 credits 3000 for. Asserted against the ACCOUNT, and the
  --      P&L accounts asserted ABSENT: 5100 or a 4xxx would balance just as
  --      happily while putting a gain or a loss into the month a delivery
  --      happened to land in, for units bought long before it.
  --
  --      MUTATION: change the credit's `'code', '3000'` to `'code', '5100'`.
  --      Expected: 'FAIL: the revaluation credits 3000 Owner''s Capital by 0,
  --      expected -5000'.
  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l join public.accounts a on a.id = l.account_id
   where l.entry_id = v_rev_entry and a.code = '3000';
  if v_amount <> -5000 then
    raise exception 'FAIL: the revaluation credits 3000 Owner''s Capital by %, expected -5000', v_amount;
  end if;
  if exists (select 1 from public.journal_lines l join public.accounts a on a.id = l.account_id
              where l.entry_id = v_rev_entry and (a.code like '4%' or a.code like '5%' or a.code like '6%' or a.code = '2000')) then
    raise exception 'FAIL: a revaluation must not touch the P&L or a payable -- nothing was sold, lost or bought';
  end if;

  --      Source, date and location. 'stock', and emphatically NOT 'opening',
  --      which is the trap: opening_inventory_gap's idempotency marker is an
  --      entry with source 'opening' carrying a line on 1200, so a revaluation
  --      filed under it would tell every future backfill that this shop had
  --      already been opened and suppress the opening balance it exists to
  --      complete.
  --
  --      MUTATION: change the revaluation's p_source from 'stock' to 'opening'.
  --      Expected: 'FAIL: the revaluation files under ''opening'''.
  select source, entry_date, location_id into v_text, v_date, v_loc
    from public.journal_entries where id = v_rev_entry;
  if v_text <> 'stock' then
    raise exception 'FAIL: the revaluation files under ''%'', expected ''stock'' -- ''opening'' would set the backfill''s idempotency marker and suppress the shop''s real opening balance', v_text;
  end if;
  if v_date <> public.shop_local_date() then
    raise exception 'FAIL: the revaluation should be dated %, got %', public.shop_local_date(), v_date;
  end if;
  --      No location: v_prior_qty is summed across every branch, so most of
  --      these units are not at the one that signed for the pallet.
  if v_loc is not null then
    raise exception 'FAIL: the revaluation carries a location; the stock it values is shop-wide';
  end if;

  --      Mid-state, before anything is sold, and computed by hand: the delivery
  --      must have moved 1200 by sixty mats at 100 = 6000, of which 1000 is the
  --      ten that arrived and 5000 the fifty that were already there.
  select coalesce(sum(l.amount_cents), 0) into v_ledger
    from public.journal_lines l
    join public.accounts a on a.id = l.account_id
    join public.journal_entries e on e.id = l.entry_id
   where e.shop_id = v_rev_shop and a.code = '1200';
  if v_ledger - v_base_1200 <> 6000 then
    raise exception 'FAIL: the delivery moved 1200 by %, expected 6000 (sixty mats at 100). 1000 means only the delivered ten reached the ledger', v_ledger - v_base_1200;
  end if;

  --      ALL SIXTY OUT THROUGH THE TILL, at the 100 they now carry, and then
  --      the property the whole migration exists for:
  --
  --        1200 EQUALS THE VALUE OF THE STOCK ON HAND.
  --
  --      Computed independently of anything receive_stock does -- by hand, and
  --      cross-checked against the shelf:
  --        mats     60 sold of 60, 0 left            0
  --        coffee   20 at a weighted 400          8000
  --        tea      20 at 50                      1000
  --        sample   35, still unpriced               0
  --                                              -----
  --                                               9000
  --      and 1200 = 1000 (tea) + 8000 (coffee) + 6000 (mats) - 6000 (COGS).
  --
  --      WITHOUT THE REVALUATION 1200 READS 4000 AGAINST A SHELF WORTH 9000 --
  --      and on a shop holding nothing but the mats it reads -5,000 outright,
  --      a negative asset. That is the number this check is really about.
  select public.complete_sale(v_rev_shop,
    jsonb_build_array(jsonb_build_object('product_id', v_rev_mat, 'quantity', 60, 'discount_cents', 0)),
    jsonb_build_array(jsonb_build_object('method', 'cash', 'amount_cents', 54000, 'tendered_cents', 54000)),
    null, null, null, null, 0, null, null, v_rev_loc, 0) into v_entry;

  select coalesce(sum(p.stock::bigint * p.cost_cents), 0) into v_onhand
    from public.products p where p.shop_id = v_rev_shop and p.cost_cents is not null;
  if v_onhand <> 9000 then
    raise exception 'FIXTURE: the shelf is worth %, expected 9000 -- check 13''s arithmetic has moved', v_onhand;
  end if;
  select coalesce(sum(l.amount_cents), 0) into v_ledger
    from public.journal_lines l
    join public.accounts a on a.id = l.account_id
    join public.journal_entries e on e.id = l.entry_id
   where e.shop_id = v_rev_shop and a.code = '1200';
  if v_ledger <> v_onhand then
    raise exception 'FAIL: 1200 Inventory reads % against a shelf worth % -- they must agree. 4000 means the fifty mats that were costed after the fact never reached the ledger, and the shop''s inventory is understated by exactly the 5000 they were given', v_ledger, v_onhand;
  end if;

  -- 13e. DELETING THE DELIVERY REVERSES THE DELIVERY, AND LEAVES THE
  --      REVALUATION STANDING.
  --
  --      This is the reason the revaluation is a SECOND entry rather than two
  --      more lines on the delivery's own. stock_receipts_reverse_on_delete
  --      (20260908001500) mirrors whatever stock_receipts.journal_entry_id
  --      points at. Nothing un-costs a product when its delivery is deleted --
  --      products.cost_cents keeps the value the delivery gave it, and the
  --      units that were already on the shelf are still on it -- so the
  --      revaluation is still TRUE after the delivery is gone, and reversing it
  --      would leave 1200 short by the whole of it.
  --
  --      Its own shop, because it is asserting a shop-wide total after a
  --      deletion and 13d's shop has just had its arithmetic pinned.
  --
  --      MUTATION: merge the two entries -- give the delivery's
  --      post_journal_entry call a third line, `('3000', -v_reval_cents)`, add
  --      v_reval_cents to its 1200 debit, and delete the second call. Expected:
  --      13d's 'FAIL: the delivery that first costed 50 mats posted 0
  --      revaluation entries, expected exactly 1' fires first -- the merged
  --      entry is not called 'Existing stock valued' -- which is the same
  --      finding said earlier. Run this check on its own (comment 13a-13d out)
  --      and it reports 'FAIL: deleting the delivery moved 1200 by -6000,
  --      expected -1000'.
  insert into public.shops (owner_id, name) values (v_user_id, 'Revalued Then Deleted Shop')
    returning id into v_del_shop;
  insert into public.shop_locations (shop_id, name, is_primary)
    values (v_del_shop, 'Main', true) returning id into v_del_loc;
  insert into public.products (shop_id, name, price_cents, cost_cents, stock)
    values (v_del_shop, 'Bag of flour', 1200, null, 20) returning id into v_del_prod;

  --      4 @ 250 = 1000 delivered, 20 @ 250 = 5000 revalued. The two are
  --      different numbers so the assertion below can tell which one moved.
  v_receipt_id := public.receive_stock(v_del_shop, v_del_loc, jsonb_build_array(
    jsonb_build_object('product_id', v_del_prod, 'quantity', 4, 'unit_cost_cents', 250)));
  select journal_entry_id into v_entry from public.stock_receipts where id = v_receipt_id;
  select id into v_rev_entry from public.journal_entries
   where shop_id = v_del_shop and description = 'Existing stock valued';
  if v_entry is null or v_rev_entry is null then
    raise exception 'FIXTURE: check 13e expects both a delivery entry and a revaluation, got % and %', v_entry, v_rev_entry;
  end if;
  select coalesce(sum(l.amount_cents), 0) into v_base_1200
    from public.journal_lines l
    join public.accounts a on a.id = l.account_id
    join public.journal_entries e on e.id = l.entry_id
   where e.shop_id = v_del_shop and a.code = '1200';

  delete from public.stock_receipts where id = v_receipt_id;

  select status into v_text from public.journal_entries where id = v_entry;
  if v_text is distinct from 'reversed' then
    raise exception 'FAIL: the deleted delivery''s own entry should read ''reversed'', it reads %', coalesce(v_text, 'gone');
  end if;
  select status into v_text from public.journal_entries where id = v_rev_entry;
  if v_text is distinct from 'posted' then
    raise exception 'FAIL: the revaluation should still read ''posted'' after the delivery is deleted, it reads % -- nothing un-costed the product, so those units are still valued', coalesce(v_text, 'gone');
  end if;
  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l
    join public.accounts a on a.id = l.account_id
    join public.journal_entries e on e.id = l.entry_id
   where e.shop_id = v_del_shop and a.code = '1200';
  if v_amount - v_base_1200 <> -1000 then
    raise exception 'FAIL: deleting the delivery moved 1200 by %, expected -1000 -- the revaluation was reversed with it', v_amount - v_base_1200;
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
