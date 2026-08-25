-- A deleted delivery takes its journal entry with it.
--
-- ## The hole this closes, and why it is being closed before it opens
--
-- 20260908000400 made receive_stock post `Dr 1200 Inventory / Cr 2000 Accounts
-- Payable` for the whole costed value of a delivery and stamp
-- stock_receipts.journal_entry_id with the entry it wrote. Nothing anywhere
-- reverses that if the stock_receipts row is later destroyed.
--
-- TODAY THAT IS LATENT, AND VERIFIED SO RATHER THAN ASSUMED:
--
--   * `stock_receipts` has one policy, `read stock_receipts` (20260902000000),
--     and it is `for select`. There is no insert, update or delete policy, so
--     PostgREST refuses a client delete outright.
--   * grep of `src/` finds no `.from('stock_receipts')` at all -- the table is
--     written only through receive_stock() and read only through it. The
--     nineteen `.delete()` calls in `src/lib` are on other tables.
--   * the only route a stock_receipts row can leave by is therefore the cascade
--     from `shops` (`shop_id ... on delete cascade`), which is handled below and
--     must stay a no-op.
--
-- SO WHY BUILD IT NOW. This exact hole has been found and closed three times on
-- this branch, every time after it had already shipped: edit_sale
-- (20260908000650), delete_sale (20260908000900), and delete_invoice_payment
-- together with the `invoice_payments` cascade (20260908001000). Each time the
-- symptom was identical and each time it was invisible -- the stranded entry
-- still balances, so the trial balance goes on zeroing, every per-entry
-- assertion passes, and nothing in the app goes red. What actually happens is
-- that 1200 Inventory carries stock that is not on the shelf and 2000 Accounts
-- Payable carries money owed to a supplier for a delivery the shop says never
-- arrived -- permanently, because the backfill replays from SOURCE ROWS and
-- there is no source row left for it to replay.
--
-- 20260908001000's own comment names this file's job in advance: "If a delete
-- door for deliveries is ever added it will need the receipt's OWN entry
-- reversed alongside, the same pairing this migration builds for bills." A
-- Delete Delivery button is an ordinary afternoon's work on the Inventory
-- screen. The trigger below means whoever adds it does not also have to know
-- the ledger exists.
--
-- ## Inline, not reverse_journal_entry()
--
-- reverse_journal_entry gates on `ledger.post`. receive_stock gates on
-- `inventory.edit`, and whoever deletes a delivery holds a stockroom permission,
-- not a ledger one -- the same finding that has every posting door pass an
-- explicit p_source rather than gate the till on ledger.post. Routed through
-- reverse_journal_entry, every delivery deletion in every shop would fail with
-- "You do not have permission to reverse journal entries." So the mirror is
-- written out here, reproducing what reverse_journal_entry does and nothing
-- else. reverse_journal_entry itself is deliberately NOT weakened: the
-- manual-entry screen is its other caller and that door must keep gating.
--
-- ## A reversal carries the SAME SOURCE as the entry it reverses
--
-- Read off the original row (`'stock'`), never written as a literal. Pinned
-- phase-wide by the plan's Global Constraints and asserted by
-- verify-posting-sales.sql: a reader filtering `source = 'stock'` must see the
-- delivery's entry AND the reversal cancelling it, or a report grouping by
-- source shows that delivery twice.
--
-- ## The closed-period redirect, and the null-status trap inside it
--
-- receive_stock has no redirect of its own, on purpose: its entry date is
-- always shop_local_date(), so there is nowhere to redirect TO. A REVERSAL is
-- different -- the entry it mirrors may be weeks old and its month may since
-- have been closed, and open_period_for raises for any non-open period. Without
-- a redirect, deleting an old delivery would meet a ledger error on the
-- Inventory screen.
--
-- READ the period's status, never CATCH open_period_for's exception: a handler
-- around the post would also swallow an unbalanced entry or a missing chart of
-- accounts and retry them into the current month as though the only thing wrong
-- were the date.
--
-- coalesce(v_old_period_status, 'not open') in the DESCRIPTION, and it is
-- load-bearing rather than tidy. `||` with a NULL operand yields NULL for the
-- WHOLE expression, so an entry whose period row does not exist would be
-- inserted with no description at all and refused by journal_entries' own
-- not-null -- an error about descriptions for a bug about dates, which
-- 20260908000300 found the hard way on this project.
--
-- ## What a shop deletion means here, which is the one case that already exists
--
-- `stock_receipts.shop_id` cascades from `shops`, so today's ONLY route into
-- this trigger is a shop being deleted. A cascade fires as an AFTER trigger on
-- the parent, so by the time this function runs the `shops` row is already
-- gone -- and `journal_entries.shop_id` is `not null references public.shops(id)`
-- with no deferral, so inserting a mirror entry here would violate that foreign
-- key IMMEDIATELY and abort the entire shop deletion. delete_shop was broken
-- exactly once before by an FK reached through journal rows (20260908001200,
-- journal_lines.location_id) and it must not be broken again by the fix for a
-- hole that is not even reachable yet. Hence the skip, read off `old.shop_id` --
-- stock_receipts carries one, unlike invoice_payments, so there is no need to
-- go through the entry for it.
--
-- Nothing is lost by skipping: `journal_entries.shop_id` cascades too, so the
-- entry is being destroyed by the same statement. There is no ledger left to
-- keep straight.
--
-- ## The expense on the other side of the same delivery is NOT this file's job
--
-- `expenses.stock_receipt_id` is `on delete cascade` (20260908000800), so
-- deleting a receipt also destroys the `inventory_purchase` expense row that
-- recorded PAYING for it -- and reverse_expense_entry (20260908001000) already
-- fires on that cascade and reverses its `Dr 2000 / Cr wallet`. The two
-- reversals are independent inserts against two different entries; neither reads
-- the other's row and addition commutes, so the cascade order Postgres happens
-- to choose does not matter. Both halves of a deleted delivery come off
-- together, the same pairing 20260908001000 built for a deleted bill.

create or replace function public.reverse_stock_receipt_entry() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_old public.journal_entries%rowtype;
  v_old_period_status text;
  v_reversal_date date;
  v_reversal_id uuid;
begin
  -- AN UNCOSTED DELIVERY POSTED NOTHING, and that is an ordinary delivery, not
  -- an edge case: receive_stock writes no entry at all when no line carried a
  -- unit cost (a zero-value entry would be refused by journal_lines'
  -- `check (amount_cents <> 0)` anyway). A receipt recorded before
  -- 20260908000400 shipped is the same shape. Reversing nothing is a clean
  -- no-op -- raising here would make deleting an uncosted delivery fail outright.
  if old.journal_entry_id is null then return null; end if;

  -- THE SHOP ITSELF BEING DELETED, AND THIS SKIP COMES FIRST -- BEFORE THE
  -- ENTRY IS EVEN READ. That ordering is not stylistic; putting it where
  -- reverse_invoice_payment_entry puts it (after the entry lookup, reading
  -- v_old.shop_id) fails outright, and check 12 of verify-posting-inventory.sql
  -- caught it on the first run:
  --
  --   ERROR: the journal entry for this delivery is missing, so it cannot be
  --   reversed
  --   CONTEXT: SQL statement "delete from public.shops where id = ..."
  --
  -- `journal_entries.shop_id` and `stock_receipts.shop_id` BOTH cascade from
  -- `shops`, and Postgres fires those RI actions in an order this file does not
  -- control. The journal branch runs first, so by the time the stock_receipts
  -- branch reaches this trigger the entry row is already gone -- the receipt
  -- still points at it, but there is nothing to select. Read the shop first and
  -- the question never arises. (reverse_invoice_payment_entry has no choice:
  -- invoice_payments carries no shop_id, so it must go through the entry.
  -- stock_receipts carries one.)
  --
  -- Nothing is lost by skipping: the entry is being destroyed by the same
  -- statement. There is no ledger left to keep straight.
  if not exists (select 1 from public.shops where id = old.shop_id) then
    return null;
  end if;

  select * into v_old from public.journal_entries where id = old.journal_entry_id;
  -- Unreachable now that the shop skip above runs first -- the foreign key on
  -- stock_receipts.journal_entry_id covers every other route -- which is exactly
  -- why it is loud rather than plausible.
  if v_old.id is null then
    raise exception 'the journal entry for this delivery is missing, so it cannot be reversed'
      using errcode = 'P0001';
  end if;

  -- ALREADY REVERSED IS A NO-OP, NOT AN ERROR. The manual ledger screen's void
  -- (reverse_journal_entry) can reach this state first, and a future Delete
  -- Delivery RPC that reverses inline before deleting -- the shape
  -- delete_invoice_payment already has -- would reach it every single time.
  -- Raising here would break that door on the day it is written.
  if v_old.status = 'reversed' then return null; end if;

  if v_old.status <> 'posted' then
    raise exception 'the journal entry for this delivery is %, so it cannot be reversed',
      v_old.status using errcode = 'P0001';
  end if;

  -- READ, not caught -- see the header.
  select status into v_old_period_status
    from public.accounting_periods
   where shop_id = v_old.shop_id and v_old.entry_date between starts_on and ends_on;
  -- No row means open_period_for will create it open, so only an EXISTING
  -- non-open period redirects.
  if v_old_period_status is not null and v_old_period_status <> 'open' then
    v_reversal_date := public.shop_local_date();
  else
    v_reversal_date := v_old.entry_date;
  end if;

  -- The reference is the original's with an R, not a fresh JE- number, so the
  -- pair reads as a pair in the journals list. coalesce in the DESCRIPTION only:
  -- the reference itself may stay null -- unique (shop_id, reference) treats
  -- nulls as distinct -- which is the honest answer for the mirror of an
  -- unreferenced entry.
  --
  -- v_old.source, never a literal: a reversal files under the same source as the
  -- entry it reverses.
  insert into public.journal_entries
      (shop_id, period_id, entry_date, reference, description, source, status,
       location_id, reverses_entry_id, created_by)
    values (
      v_old.shop_id,
      public.open_period_for(v_old.shop_id, v_reversal_date),
      v_reversal_date,
      v_old.reference || 'R',
      'Reversal of ' || coalesce(v_old.reference, 'an unreferenced entry')
        || ' — delivery ' || old.id::text || ' was deleted'
        || case when v_reversal_date <> v_old.entry_date
                then ' (originally dated ' || to_char(v_old.entry_date, 'YYYY-MM-DD')
                     || '; that period is ' || coalesce(v_old_period_status, 'not open')
                     || ', so the reversal is recognised here)'
                else '' end,
      v_old.source, 'posted', v_old.location_id, v_old.id, auth.uid())
    returning id into v_reversal_id;

  -- NEGATED. A mirror that copied the lines unchanged nets to double rather than
  -- to nothing, and every per-entry check still passes because both entries
  -- balance on their own.
  insert into public.journal_lines (entry_id, account_id, amount_cents, location_id, memo)
    select v_reversal_id, account_id, -amount_cents, location_id, memo
      from public.journal_lines where entry_id = v_old.id;

  -- The one update refuse_posted_entry_edit() permits, and the link that makes
  -- neither entry readable without finding the other.
  update public.journal_entries
     set status = 'reversed', reverses_entry_id = v_reversal_id
   where id = v_old.id;

  return null;
end;
$$;

comment on function public.reverse_stock_receipt_entry() is
  'AFTER DELETE on stock_receipts. Reverses the Dr 1200 Inventory / Cr 2000 Accounts Payable entry the delivery posted, whichever door removes the row. Written inline rather than through reverse_journal_entry, which gates on ledger.post -- whoever deletes a delivery holds inventory.edit. A no-op for an uncosted delivery that posted nothing, for an entry already reversed, and for a shop being deleted (the only route that exists today). The delivery''s PAYMENT, an inventory_purchase expenses row, cascades off the same delete and is reversed by reverse_expense_entry -- both halves come off together.';

-- AFTER, so the ledger only ever learns about a deletion the table has already
-- accepted -- the mirror of receive_stock posting only after the units have
-- landed.
--
-- No `for update` anywhere above: the DELETE statement has already row-locked
-- the tuple its own trigger is firing for, the same reason reverse_expense_entry
-- and reverse_invoice_payment_entry need none.
drop trigger if exists stock_receipts_reverse_on_delete on public.stock_receipts;
create trigger stock_receipts_reverse_on_delete
  after delete on public.stock_receipts
  for each row execute function public.reverse_stock_receipt_entry();
