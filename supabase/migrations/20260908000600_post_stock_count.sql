-- A stock-take's variance lands in the ledger, valued at the cost frozen on
-- each count line.
--
-- ## What was missing, and why it was invisible
--
-- 20260903000100_stock_counts.sql already spelled this out and then could not
-- act on it, because there was no ledger yet: COGS is built from
-- sale_items.unit_cost_cents, frozen at sale time, so a unit that is stolen,
-- breaks or expires is NEVER SOLD and its cost never enters COGS by any path.
-- It leaves Stock at cost and is simply gone. Gross profit therefore reads
-- higher than it is by exactly the cost of everything that walked out, every
-- month, invisibly. save_stock_count froze unit_cost_cents on every line
-- specifically so this migration could exist; this is that debt being paid.
--
-- ## 5100 is in COST OF SALES, above gross profit -- not an operating expense
--
-- The Count door's own UI currently books shrinkage as a `stock_loss` EXPENSE
-- category, which lands in the 6000s, below gross profit. That is the wrong
-- shelf and it is wrong in the flattering direction: it leaves gross margin
-- reading as though every unit bought was either sold or still on the shelf.
-- Shrinkage is a cost of having sold goods at all -- it is what the trade costs
-- to run -- and IAS 2.34 puts write-downs and losses of inventories in the
-- period's cost of inventories recognised as expense. 5100 Inventory Shrinkage
-- sits beside 5000 COGS for that reason, and verify-posting-inventory.sql
-- check 4 asserts that no `6%` account appears on the entry, so a future edit
-- that moves it down cannot pass quietly.
--
-- ## An over-count REVERSES the entry; it does not post a negative shrinkage
--
-- Dr 5100 -1800 / Cr 1200 +1800 sums to zero and passes the balance trigger,
-- the sign convention and every arithmetic check that could be written about
-- it. It is still meaningless: a negative debit is not something a reader can
-- act on, a trial balance printing "Inventory Shrinkage (18.00)" tells nobody
-- that eighteen shillings of stock was FOUND, and any report that sums 5100
-- over a quarter silently nets real losses against clerical corrections. So
-- found stock debits 1200 and credits 5100, in that order, and the two
-- directions are separate branches rather than one branch with a sign in it.
--
-- ## Exactly zero posts nothing
--
-- A count that found what it expected is not an accounting event. It is also
-- not representable: the entry would be two zero lines, and journal_lines'
-- `check (amount_cents <> 0)` refuses those -- so getting this wrong does not
-- produce a noisy ledger, it stops the stock-take from being saved at all. The
-- same is true of a count whose only lines are UNCOSTED: there is no value to
-- move, and inventing one is exactly what isUncosted() in product-costing.ts
-- exists to prevent.
--
-- ## Why there is no closed-period redirect here
--
-- The same reason receive_stock has none, set out at length in
-- 20260908000400_post_receive_stock.sql: Task 3b's redirect exists for RPCs that
-- can be handed a date in the past, and save_stock_count cannot be. Its entry
-- date is public.shop_local_date(), which is today by construction, so the
-- period being posted into is always the current one and a redirect would have
-- nowhere to send it. A shop standing in a month it has closed gets
-- open_period_for's refusal, which is the correct answer for books that have
-- been declared final.
--
-- save_stock_count is reproduced below in full, as this repo requires, from its
-- only prior definition (20260903000100_stock_counts.sql). The ONLY changes are
-- the two new declarations (v_variance_cents, v_entry_id) and the posting block
-- after the item loop.

create or replace function public.save_stock_count(
  p_shop_id uuid,
  p_location_id uuid,
  p_items jsonb,
  p_note text default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_count_id uuid;
  v_item jsonb;
  v_product public.products%rowtype;
  v_counted integer;
  v_previous integer;
  v_reason text;
  v_lines integer := 0;
  -- Signed, and bigint: a 300-line stock-take at four-figure costs is well
  -- inside int4, and a stock-take after a flood is not the moment to discover
  -- where the boundary is.
  v_variance_cents bigint;
  v_entry_id uuid;
begin
  -- Before anything is inserted, so a refusal leaves no half-written
  -- stock-take on record.
  if not public.has_shop_permission(p_shop_id, 'inventory.count') then
    raise exception 'not authorized for shop %', p_shop_id;
  end if;
  if not exists (select 1 from public.shop_locations where id = p_location_id and shop_id = p_shop_id) then
    raise exception 'the counted location must belong to shop %', p_shop_id;
  end if;
  if p_items is null or jsonb_array_length(p_items) = 0 then
    raise exception 'a count must include at least one line';
  end if;

  insert into public.stock_counts (shop_id, location_id, note, created_by)
    values (p_shop_id, p_location_id, nullif(p_note, ''), auth.uid())
    returning id into v_count_id;

  -- Ordered by product id so two concurrent counts touching the same products
  -- take their row locks in the same order and cannot deadlock -- the same
  -- reason receive_stock, transfer_stock and refund_sale_items order their
  -- loops. Ordinality is carried as the tiebreaker for the sort, not to pick a
  -- winner among duplicates: a sheet that lists the same product twice is
  -- refused outright by stock_count_items' `unique (count_id, product_id)`,
  -- the moment the second line tries to insert. There is no "last line wins"
  -- here, unlike a plain upsert -- a stock-take is a value judgement someone
  -- is accountable for, and silently picking one of two conflicting counts of
  -- the same shelf is a worse answer than refusing the whole sheet.
  for v_item in
    select value from jsonb_array_elements(p_items) with ordinality as t(value, ord)
      order by (value->>'product_id'), ord
  loop
    v_counted := (v_item->>'counted_quantity')::integer;
    -- Zero passes. It is the finding a stock-take most often exists to make.
    if v_counted is null or v_counted < 0 then
      raise exception 'invalid counted quantity';
    end if;

    select * into v_product from public.products
      where id = (v_item->>'product_id')::uuid and shop_id = p_shop_id;
    if v_product.id is null then
      raise exception 'product % not found in this shop', v_item->>'product_id';
    end if;

    -- Read under a row lock and immediately replaced, so the number recorded as
    -- "what the app said" is the number this statement actually overwrote. A
    -- sale completing between the read and the write would otherwise be
    -- silently absorbed into the variance and attributed to shrinkage.
    --
    -- Null means the store has no row for this product at all -- it does not
    -- carry it. That is a legitimate thing to find three of on a shelf, so it
    -- counts as a previous of zero and the upsert creates the row.
    select stock into v_previous from public.product_location_stock
      where product_id = v_product.id and location_id = p_location_id
      for update;
    v_previous := coalesce(v_previous, 0);

    -- `= excluded.stock`, not `+`. THE line that makes this a Count.
    insert into public.product_location_stock (product_id, location_id, stock)
      values (v_product.id, p_location_id, v_counted)
      on conflict (product_id, location_id)
      do update set stock = excluded.stock, updated_at = now();

    -- nullif('') as well as a plain null: a client that sends an empty string
    -- for "no reason given" must not trip the check constraint, and an empty
    -- string is not a sixth reason.
    v_reason := nullif(v_item->>'reason', '');

    insert into public.stock_count_items
      (count_id, product_id, product_name, previous_quantity, counted_quantity, reason, unit_cost_cents)
      values (v_count_id, v_product.id, v_product.name, v_previous, v_counted, v_reason, v_product.cost_cents);

    v_lines := v_lines + 1;
  end loop;

  -- Unreachable, and kept anyway: jsonb_array_length above has already refused
  -- an empty array, and every element either records a line or raises. Mirrors
  -- receive_stock line for line so the two RPCs can be read side by side, and
  -- it is the backstop if either guard is ever loosened.
  if v_lines = 0 then
    raise exception 'cannot record a count with no lines';
  end if;

  -- ── posting side ────────────────────────────────────────────────────────
  --
  -- The net variance in money, at the cost frozen on each count line -- never
  -- from products.cost_cents, which a delivery may already have moved since the
  -- shelf was walked. Signed: negative means stock is missing, positive means
  -- more was found.
  --
  -- Uncosted lines are EXCLUDED, not zeroed. The `is not null` filter is
  -- redundant against sum(), which skips nulls anyway, and is written out
  -- because the rule it encodes is the thing a later reader has to not get
  -- wrong: an unpriced product's variance has no value, and a value invented
  -- for it would be a loss the shop never had.
  select coalesce(sum(ci.unit_cost_cents::bigint * (ci.counted_quantity - ci.previous_quantity)), 0)
    into v_variance_cents
    from public.stock_count_items ci
   where ci.count_id = v_count_id and ci.unit_cost_cents is not null;

  -- shop_local_date(), never now()::date -- UTC+3 means a late-evening
  -- stock-take would otherwise be dated into the day before, and once that
  -- month closes the entry cannot be re-dated. p_source is 'count', explicit
  -- and never left at the 'manual' default: post_journal_entry gates only
  -- 'manual' on ledger.post, so a default here would make a stock-taker's count
  -- depend on a ledger permission the Count door never asked for.
  if v_variance_cents < 0 then
    -- Short. 5100 sits in COST OF SALES, above gross profit -- not in
    -- operating expenses, where the Count door's stock_loss expense lands
    -- today. A unit that is stolen or breaks is never sold, so its cost never
    -- enters COGS by any other path and gross profit reads high by exactly
    -- that amount, every month, invisibly.
    v_entry_id := public.post_journal_entry(
      p_shop_id, public.shop_local_date(), 'Stock count variance',
      jsonb_build_array(
        jsonb_build_object('code', '5100', 'amount_cents', -v_variance_cents, 'memo', 'Stock short'),
        jsonb_build_object('code', '1200', 'amount_cents',  v_variance_cents, 'memo', 'Written off')),
      p_location_id, 'count');
    update public.stock_counts set journal_entry_id = v_entry_id where id = v_count_id;
  elsif v_variance_cents > 0 then
    -- Found. Reversed rather than posted as a negative shrinkage: a negative
    -- debit and a negative credit sum to zero and pass every check while
    -- meaning nothing a reader could act on.
    v_entry_id := public.post_journal_entry(
      p_shop_id, public.shop_local_date(), 'Stock count variance',
      jsonb_build_array(
        jsonb_build_object('code', '1200', 'amount_cents',  v_variance_cents, 'memo', 'Stock found'),
        jsonb_build_object('code', '5100', 'amount_cents', -v_variance_cents, 'memo', 'Shrinkage reversed')),
      p_location_id, 'count');
    update public.stock_counts set journal_entry_id = v_entry_id where id = v_count_id;
  end if;
  -- Exactly zero posts nothing. A count that found what it expected is not an
  -- accounting event.
  -- ── end posting side ────────────────────────────────────────────────────

  return v_count_id;
end;
$$;

grant execute on function public.save_stock_count(uuid, uuid, jsonb, text) to authenticated;
