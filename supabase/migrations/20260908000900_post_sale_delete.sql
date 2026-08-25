-- Deleting a sale reverses every journal entry that sale is responsible for.
--
-- ## The hole this closes
--
-- 20260908000200 made complete_sale post a journal entry and stamp
-- sales.journal_entry_id with it. 20260908000350 did the same for refunds and
-- settlements. delete_sale -- reachable from Accounting → Transactions
-- (src/components/accounting/transactions-tab.tsx:224 → src/lib/sales.ts:123)
-- -- restores the stock, reverses the loyalty points and deletes the sale, and
-- knew nothing about any of it.
--
-- `sales.journal_entry_id` carries no ON DELETE, so the entry SURVIVED the sale,
-- still `status = 'posted'`, described by a uuid that now resolves to nothing.
-- `sale_payments` and `refunds` both cascade (0005_sale_payments.sql:3,
-- 20260802015200_refunds.sql:7), so a credit sale that was refunded and later
-- settled left THREE entries standing over no source rows at all.
--
-- A manager deleting a mis-rung 6,300 sale left 4000 holding 6,000 of revenue,
-- 5000 holding 2,200 of COGS, 1200 credited for stock that is back on the shelf
-- and 2100 holding the tax. Every entry still balances, so the trial balance
-- still zeroes and nothing anywhere goes red. And Task 8's backfill can never
-- repair it: the replay is driven by source rows, and there is no source row
-- left to replay.
--
-- ## The treatment, which is edit_sale's
--
-- 20260908000650 answered exactly this question for edit_sale: a correction is a
-- reversal plus (there) a fresh entry, never an edit of the original, because
-- journal_entries carries refuse_posted_entry_edit() and a book is added to
-- rather than amended. A deletion is the same thing without the replacement.
--
-- ## THE CASCADED ENTRIES ARE REVERSED TOO, AND THAT IS THE DECISION
--
-- A sale's own entry is not the only one pointing at rows that are about to
-- vanish. `refunds.journal_entry_id` and `sale_payments.journal_entry_id` name
-- separate journal_entries rows, written by refund_sale_items and
-- settle_sale_balance, whose source rows cascade away with the sale.
--
-- Reversing only the sale's entry would MOVE the orphan problem rather than fix
-- it, and would leave the books in a state strictly worse than doing nothing:
-- the sale's revenue and receivable come back out, while the refund's 4100
-- Sales Returns and the settlement's Dr Cash / Cr 1100 stay -- so the ledger
-- would show a shop that returned goods it never sold and collected cash
-- against a receivable that no longer exists. 1100 would end up permanently
-- NEGATIVE by the settled amount.
--
-- So all three kinds are reversed, in one loop, and each reversal is the mirror
-- of its own original. Nothing is netted: three postings become three postings
-- and three reversals, six rows that read as three pairs.
--
-- ## Inline, not reverse_journal_entry()
--
-- reverse_journal_entry requires `ledger.post`. delete_sale gates on
-- `sales.edit` -- which is the permission that really covers this door;
-- src/lib/permissions.ts:80 labels it "Edit/delete sales" and there is no
-- `sales.delete`. A manager removing a mis-rung sale holds sales.edit and must
-- never need a ledger permission as well, which is the same finding that has
-- every posting call pass p_source <> 'manual' rather than gate the till on
-- ledger.post. Routed through reverse_journal_entry, every sale deletion in
-- every shop would fail with "You do not have permission to reverse journal
-- entries."
--
-- So the reversal is written out INLINE, reproducing what reverse_journal_entry
-- does and nothing else: the mirrored lines, the R-suffixed reference, the link
-- in both directions, and `status = 'reversed'` on the original -- the one
-- update refuse_posted_entry_edit() permits. reverse_journal_entry itself is
-- deliberately NOT weakened: the manual-entry screen is its other caller and
-- that door must keep gating.
--
-- ## The reversal carries the source of the entry it reverses
--
-- 'sale' for the sale's entry, 'refund' for a refund's, 'settlement' for a
-- settlement's -- read off the original rather than written as a literal, so the
-- three cannot drift apart. This is the convention the final review pinned
-- across the whole phase (Global Constraints in the plan): a reversal files
-- under the same source as its original, so a report grouping by source shows
-- both halves of every pair. 20260908000650 originally wrote 'manual' here,
-- inherited from reverse_journal_entry, and has been corrected to match.
--
-- ## The closed-period redirect, for edit_sale's reason
--
-- reverse_journal_entry dates a reversal to the ORIGINAL entry's date, on
-- purpose: a correction to August belongs in August, and if August is shut it
-- says so. Right for a human at the ledger screen; wrong here, because it puts a
-- closed month between a manager and a mis-rung sale -- open_period_for refuses
-- and the whole delete fails with a ledger error on the Transactions screen.
-- Read rather than caught, so a broken chart of accounts is not swallowed and
-- retried into the current month as though the only thing wrong were the date.
--
-- ## CARRIED FORWARD IN FULL
--
-- delete_sale's newest definition is 20260820000100_loyalty_balance_rules.sql
-- and this file reproduces it verbatim from there, per this repo's convention.
-- It is NOT one of the two functions 20260905000000_complete_sale_lock_order.sql
-- patches by string-replacing pg_proc.prosrc -- that migration touches
-- complete_sale and edit_sale only -- so there is no invisible edit to carry.
-- The signature is unchanged, so this replaces rather than overloads.
--
-- One thing IS new besides the posting block, and it is stated rather than
-- smuggled: the sale row is now read `for update`. This function reads
-- sales.journal_entry_id and then writes journal_entries rows derived from it,
-- with nothing serialising the two. Without the lock, two concurrent deletes --
-- a double-tap on the Delete button, or a client retry after a dropped response
-- -- can both read the same entry ids and both write a reversal, leaving the
-- original reversed twice and the trial balance off by that pair's net effect.
-- Same shape as edit_sale's own `for update` (20260908000650) and
-- settle_sale_balance's (20260908000360), added for the same reason.

create or replace function public.delete_sale(p_sale_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_shop_id uuid;
  v_location_id uuid;
  v_item record;
  v_customer_id uuid;
  v_points_earned integer;
  v_points_redeemed integer;
  v_balance integer;
  v_clawback integer;
  -- ── the posting side, new in 20260908000900 ────────────────────────────
  -- One row per journal entry this sale is responsible for: its own, every
  -- refund's, and every settlement's. Each carries the fields the mirror needs
  -- and the SOURCE it must be filed under.
  v_dead record;
  -- The status of the period the ORIGINAL entry sits in, or NULL when no row
  -- exists for that month. NULL is not "closed" and not "open" either -- it is
  -- "nobody has traded in this month", which open_period_for turns into an open
  -- period on demand. Getting that backwards redates reversals that never
  -- needed redating.
  v_old_period_status text;
  -- Where the reversal is actually recognised. Equal to the original's date
  -- except when that month has been closed or locked.
  v_reversal_date date;
  v_reversal_id uuid;
begin
  -- `for update` is new here -- see this migration's header for the race it
  -- closes. It also serialises the delete itself, which previously read the row
  -- unlocked and deleted it several statements later.
  select shop_id, location_id, customer_id, points_earned, points_redeemed
    into v_shop_id, v_location_id, v_customer_id, v_points_earned, v_points_redeemed
    from public.sales where id = p_sale_id for update;
  if v_shop_id is null then
    raise exception 'sale % not found', p_sale_id;
  end if;
  if not public.has_shop_permission(v_shop_id, 'sales.edit') then
    raise exception 'not authorized for sale %', p_sale_id;
  end if;

  for v_item in select product_id, quantity from public.sale_items where sale_id = p_sale_id loop
    if v_item.product_id is not null then
      insert into public.product_location_stock (product_id, location_id, stock)
        values (v_item.product_id, v_location_id, v_item.quantity)
        on conflict (product_id, location_id)
        do update set stock = public.product_location_stock.stock + excluded.stock, updated_at = now();
    end if;
  end loop;

  -- sale_id is deliberately left null on these rows: the sale they would point
  -- at is about to stop existing.
  --
  -- Redeemed points are returned before earned points are taken back, for the
  -- same reason refund_sale_items does it in that order -- reversing the two
  -- would let the clamp swallow the clawback and then hand the points back.
  if v_customer_id is not null and public.shop_has_module(v_shop_id, 'customers') then
    if coalesce(v_points_redeemed, 0) > 0 then
      insert into public.customer_points_ledger
        (shop_id, customer_id, delta_points, reason, note, created_by)
        values (v_shop_id, v_customer_id, v_points_redeemed, 'adjustment',
                'sale deleted', auth.uid());
    end if;

    if coalesce(v_points_earned, 0) > 0 then
      select points_balance into v_balance from public.customers
        where id = v_customer_id for update;
      v_clawback := least(v_points_earned, greatest(coalesce(v_balance, 0), 0));
      if v_clawback > 0 then
        insert into public.customer_points_ledger
          (shop_id, customer_id, delta_points, reason, note, created_by)
          values (v_shop_id, v_customer_id, -v_clawback, 'adjustment',
                  'sale deleted', auth.uid());
      end if;
    end if;
  end if;

  -- ── The posting side ────────────────────────────────────────────────────
  --
  -- BEFORE the delete below, and it has to be: `refunds` and `sale_payments`
  -- both cascade off `sales`, so after the delete there is nothing left to read
  -- the entry ids from and the entries are unreachable forever.
  --
  -- Inside the same transaction as the delete, deliberately. A sale that is
  -- removed but not reversed is a books-that-do-not-tie bug which only shows up
  -- at month end, with no way to find which sale caused it -- and no source row
  -- left for the backfill to replay. Failing the delete is louder and rarer.
  for v_dead in
    select e.id, e.status, e.entry_date, e.reference, e.location_id, e.source, d.what
      from (
        -- The sale's own entry. NULL on a sale rung up before 20260908000200
        -- shipped: reversing nothing is not an error.
        select s.journal_entry_id as entry_id, 'the sale' as what
          from public.sales s
         where s.id = p_sale_id and s.journal_entry_id is not null
        union all
        -- Every refund taken against it (Dr 4100 / Cr the tenders and 1100).
        select r.journal_entry_id, 'refund ' || r.id::text
          from public.refunds r
         where r.sale_id = p_sale_id and r.journal_entry_id is not null
        union all
        -- Every balance settlement (Dr the tender / Cr 1100). Only SETTLEMENT
        -- rows ever carry an entry of their own -- complete_sale folds a sale's
        -- own till payments into the sale's entry and leaves those rows null
        -- forever -- so filtering on the column is filtering on the right thing
        -- and no is_settlement test is needed or wanted: a backfilled row would
        -- carry one too.
        select sp.journal_entry_id, 'settlement ' || sp.id::text
          from public.sale_payments sp
         where sp.sale_id = p_sale_id and sp.journal_entry_id is not null
      ) d
      join public.journal_entries e on e.id = d.entry_id
     order by e.entry_date, e.reference
  loop
    -- Loud rather than quiet. A source row pointing at a draft or an
    -- already-reversed entry is a state nothing in this codebase can produce,
    -- and silently writing a second mirror on top of it would leave the sale
    -- reversed twice with nothing on the record saying so.
    if v_dead.status <> 'posted' then
      raise exception 'the journal entry for % is %, so it cannot be reversed', v_dead.what, v_dead.status
        using errcode = 'P0001';
    end if;

    -- READ, not caught -- see the header. open_period_for raises for any
    -- non-open period, and catching that would also swallow a genuinely broken
    -- chart of accounts and retry it into the current month.
    select status into v_old_period_status
      from public.accounting_periods
     where shop_id = v_shop_id and v_dead.entry_date between starts_on and ends_on;

    -- No row means open_period_for will create it open, so only an EXISTING
    -- non-open period redirects.
    if v_old_period_status is not null and v_old_period_status <> 'open' then
      v_reversal_date := public.shop_local_date();
    else
      v_reversal_date := v_dead.entry_date;
    end if;

    -- What reverse_journal_entry(uuid, text) does, minus its ledger.post gate.
    --
    -- The reference is the original's with an R, not a fresh JE- number, so the
    -- pair reads as a pair in the journals list. coalesce in the DESCRIPTION
    -- only: `||` with a NULL operand yields NULL for the whole expression, and a
    -- null description is refused by `check (length(trim(description)) > 0)`.
    -- The reference itself may stay null -- unique (shop_id, reference) treats
    -- nulls as distinct -- which is the honest answer for the mirror of an
    -- unreferenced entry.
    --
    -- `v_dead.source`, never a literal: a reversal files under the same source
    -- as the entry it reverses, so a reader filtering `source = 'refund'` sees
    -- the refund AND its undoing rather than one of the two.
    insert into public.journal_entries
        (shop_id, period_id, entry_date, reference, description, source, status,
         location_id, reverses_entry_id, created_by)
      values (
        v_shop_id,
        public.open_period_for(v_shop_id, v_reversal_date),
        v_reversal_date,
        v_dead.reference || 'R',
        'Reversal of ' || coalesce(v_dead.reference, 'an unreferenced entry')
          || ' — sale ' || p_sale_id::text || ' was deleted'
          || case when v_dead.what <> 'the sale'
                  then ' (' || v_dead.what || ' went with it)'
                  else '' end
          -- coalesce on the status for the reason 20260908000300 found the hard
          -- way: the branch above cannot set v_reversal_date <> the original's
          -- date while v_old_period_status is NULL, but if that invariant is
          -- ever broken by an edit up there the whole description becomes NULL
          -- and the delete fails on a description constraint for a bug about
          -- dates.
          || case when v_reversal_date <> v_dead.entry_date
                  then ' (originally dated ' || to_char(v_dead.entry_date, 'YYYY-MM-DD')
                       || '; that period is ' || coalesce(v_old_period_status, 'not open')
                       || ', so the reversal is recognised here)'
                  else '' end,
        v_dead.source, 'posted', v_dead.location_id, v_dead.id, auth.uid())
      returning id into v_reversal_id;

    insert into public.journal_lines (entry_id, account_id, amount_cents, location_id, memo)
      select v_reversal_id, account_id, -amount_cents, location_id, memo
        from public.journal_lines where entry_id = v_dead.id;

    -- The one update refuse_posted_entry_edit() permits, and the link that
    -- makes neither entry readable without finding the other.
    update public.journal_entries
       set status = 'reversed', reverses_entry_id = v_reversal_id
     where id = v_dead.id;
  end loop;
  -- ── end posting side ────────────────────────────────────────────────────

  delete from public.sales where id = p_sale_id;
end;
$$;

comment on function public.delete_sale(uuid) is
  'Deletes a sale, restores its stock, reverses its loyalty points AND reverses every journal entry it is responsible for -- its own, every refund''s and every settlement''s -- leaving the originals and their mirrors both on the record. The reversals are written inline rather than through reverse_journal_entry, which gates on ledger.post; this door gates on sales.edit. Each reversal carries the source of the entry it reverses.';

grant execute on function public.delete_sale(uuid) to authenticated;
