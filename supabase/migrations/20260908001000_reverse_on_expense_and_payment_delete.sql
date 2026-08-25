-- An expense that is edited or deleted, and a supplier payment that is undone,
-- reverse the journal entry they already posted.
--
-- ## The hole this closes
--
-- 20260908000750 made an expenses INSERT post a journal entry and stamp
-- expenses.journal_entry_id with it. 20260908000800 branched that posting seven
-- ways. Neither touched the two doors that MUTATE or DESTROY the row afterwards,
-- and both doors are live buttons on the Expenses screen
-- (src/components/accounting/expenses-tab.tsx:265,273 ->
-- src/lib/expenses.ts:116,125):
--
--   * updateExpense is a plain `.update()`. Change 7,341 to 500 and the ledger
--     goes on reading 7,341. Change the CATEGORY and the ledger goes on debiting
--     the account the OLD category mapped to -- 6500 Transport for a cost that
--     is now 6400 Supplies. Change the date and it stays in the old month, which
--     survives a close.
--   * deleteExpense is a plain `.delete()`. expenses.journal_entry_id carries no
--     ON DELETE (20260908000100, deliberately -- the ENTRY is what is protected),
--     so the entry outlives the row: still `status = 'posted'`, described by a
--     uuid that now resolves to nothing. The cost stays on the P&L for ever with
--     no source row to explain it, and Task 8's backfill can never repair it --
--     the replay is driven by source rows and there is no source row left.
--
-- delete_invoice_payment (20260804000600) is the same shape on the bills side.
-- record_invoice_payment posts Dr 2000 Accounts Payable / Cr the wallet
-- (20260908000500) and stamps invoice_payments.journal_entry_id. Undoing the
-- payment deletes the row, recomputes invoices.paid_cents -- and leaves the
-- entry standing. The bill goes back to reading unpaid while the ledger goes on
-- saying the payable was cleared, so 2000 is UNDERSTATED by the undone amount
-- for ever, and verify-posting-bills check 13 (2000 against what `invoices` says
-- is outstanding) is the assertion that would have caught it if anything had
-- ever exercised the door.
--
--   * deleteInvoice (src/lib/invoices.ts:151, from invoices-tab.tsx:238) is a
--     plain `.delete()` on `invoices`, and BOTH the mirrored `expenses` row and
--     every `invoice_payments` row cascade off it. Before 20260908000800 a bill
--     posted nothing, so this door was a clean ledger no-op; the moment the
--     mirror row started posting Dr <category> / Cr 2000 on insert, deleting the
--     bill began stranding that entry `posted` with no source row anywhere. The
--     P&L then carries rent that was never incurred, the balance sheet carries
--     money owed to nobody, `invoices` says the shop owes zero, and check 13's
--     invariant is violated permanently. Nothing goes red: every entry balances.
--     There is no in-app remedy either -- reverse_journal_entry has no caller in
--     src/ at all.
--
-- Every one of these leaves entries that individually balance, so the trial
-- balance still zeroes and nothing anywhere goes red.
--
-- ## The treatment, which the design already fixed
--
-- "Corrections are reversing entries, never edits. Posted journals are
-- immutable. Voiding writes a mirror entry linked to the original with a stated
-- reason. Both stay on the record."
--
-- journal_entries carries refuse_posted_entry_edit(), so there is no other
-- option available: an edit reverses and re-posts (edit_sale, 20260908000650), a
-- delete reverses (delete_sale, 20260908000900). This file is those two
-- treatments applied to expenses and to invoice payments.
--
-- ## Inline, not reverse_journal_entry()
--
-- reverse_journal_entry requires `ledger.post`. The Expenses screen gates on
-- `expenses.manage` and the Bills screen on `invoices.manage`. Somebody deleting
-- a receipt holds an expense permission, not a ledger one, and must never need
-- one -- the same finding that has every posting call pass p_source <> 'manual'
-- rather than gate the till on ledger.post. Routed through
-- reverse_journal_entry, every expense edit in every shop would fail with "You
-- do not have permission to reverse journal entries."
--
-- So the mirror is written out inline, reproducing what reverse_journal_entry
-- does and nothing else: the negated lines, the R-suffixed reference, the link
-- in both directions, and `status = 'reversed'` on the original -- the one
-- update refuse_posted_entry_edit() permits. reverse_journal_entry itself is
-- deliberately NOT weakened: the manual-entry screen is its other caller and
-- that door must keep gating.
--
-- ## A reversal carries the SAME SOURCE as the entry it reverses
--
-- Read off the original row, never written as a literal. Pinned phase-wide by
-- the final review (the plan's Global Constraints) and asserted by
-- verify-posting-sales.sql: a reader filtering `source = 'bill'` must see the
-- expense's entry AND the reversal cancelling it, or a report grouping by source
-- shows that cost twice.
--
-- ## The closed-period redirect
--
-- reverse_journal_entry dates a reversal to the ORIGINAL entry's date, on
-- purpose. Right for a human at the ledger screen; wrong here, because it puts a
-- closed month between a shopkeeper and a mistyped receipt -- open_period_for
-- refuses and the whole delete fails with a ledger error on the Expenses screen.
-- READ, not caught, for 20260908000650's reason: an exception handler around the
-- post would also swallow an unbalanced entry or a missing chart of accounts and
-- retry them into the current month as though the only thing wrong were the
-- date. coalesce(v_old_period_status, 'not open') in the DESCRIPTION, because
-- `||` with a NULL operand yields NULL for the whole expression and
-- post_journal_entry then refuses the row for having no description -- an error
-- about descriptions for a bug about dates, which 20260908000300 found the hard
-- way.

-- ---------------------------------------------------------------------------
-- WHY A TRIGGER RATHER THAN TWO NEW RPCs, for the expenses half
-- ---------------------------------------------------------------------------
--
-- `expenses` is the one money move in this phase with no RPC to bolt a posting
-- side onto -- which is why 20260908000750 put the INSERT side in a trigger in
-- the first place. Four reasons the UPDATE and DELETE sides belong in the same
-- place rather than in a pair of new security-definer functions:
--
--   1. THE RE-POST GOES THROUGH post_expense_to_ledger ITSELF. That function is
--      a seven-way branch and its whole value is WHICH account each arm picks;
--      an RPC would have to re-derive the branch, and the two would drift the
--      first time one of them was corrected. Attaching the SAME trigger function
--      to AFTER UPDATE means there is exactly one implementation of the branch,
--      for the first posting and for every replacement. Its body is not touched
--      by this migration and its newest definition stays 20260908000800.
--   2. updateExpense sends a SPARSE PATCH. src/lib/expenses.ts:32 builds the row
--      out of whichever fields the caller set, so "undefined means leave alone"
--      is three-valued logic an RPC would have to reproduce in SQL for eight
--      columns. A trigger reads NEW, which is already the merged row.
--   3. RLS STAYS THE ONLY GATE. The `update expenses` and `delete expenses`
--      policies (20260908000800) already carry `expenses.manage` plus the bar on
--      all four generated-row links. A security-definer RPC bypasses RLS and
--      would have to re-implement both halves, in a second place, for a door
--      that is already correctly gated.
--   4. THE ROW LOCK IS FREE. edit_sale and delete_sale each had to add
--      `for update` to stop two concurrent calls both reading the same entry id
--      and both writing a mirror. An UPDATE or DELETE statement has already
--      row-locked the tuple its own trigger is firing for, so the race cannot
--      happen here.
--
-- delete_invoice_payment IS already an RPC, so its reversal goes inside it,
-- where the `for update` on the parent invoice already serialises the read.

-- ---------------------------------------------------------------------------
-- The reversal, for both expense doors
-- ---------------------------------------------------------------------------
--
-- One trigger function for UPDATE and DELETE rather than two, because the two
-- differ in a single sentence of the description and in what they return. `old`
-- is the right row in both cases: on UPDATE the pointer has not moved yet, and
-- on DELETE `new` does not exist.
create or replace function public.reverse_expense_entry() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_old public.journal_entries%rowtype;
  -- The status of the period the ORIGINAL entry sits in, or NULL when no row
  -- exists for that month. NULL is not "closed" and not "open" either -- it is
  -- "nobody has traded in this month", which open_period_for turns into an open
  -- period on demand. Getting that backwards redates reversals that never needed
  -- redating.
  v_old_period_status text;
  v_reversal_date date;
  v_reversal_id uuid;
begin
  -- ── The two rows this trigger must leave alone ──────────────────────────
  --
  -- 1. A ROW THAT POSTED NOTHING. Count-linked (save_stock_count posted both
  --    sides), payroll-linked (post_payroll_run posted its own entry) and an
  --    inventory_purchase bill (receive_stock already debited 1200 against 2000)
  --    all carry a NULL journal_entry_id, and so does any expense entered before
  --    20260908000750 shipped and not yet backfilled. Reversing nothing is not
  --    an error; it is a clean no-op, and it has to be, or deleting a
  --    stock-take's write-off row would start failing outright.
  if old.journal_entry_id is null then
    if tg_op = 'UPDATE' then return new; end if;
    return null;
  end if;

  -- 2. THE SHOP ITSELF BEING DELETED. `shops` is the cascade root
  --    (supabase/functions/platform-admin/index.ts:1538 deletes it outright) and
  --    BOTH `expenses` and `journal_entries` hang off it. A cascade is
  --    implemented as an AFTER DELETE trigger on the parent, so by the time this
  --    fires the shops row is already gone -- and inserting a reversal that
  --    references it would violate the foreign key and abort the whole deletion.
  --    Writing a mirror entry into a shop that is being destroyed is meaningless
  --    anyway; the entry it would mirror is going with it.
  if not exists (select 1 from public.shops where id = old.shop_id) then
    if tg_op = 'UPDATE' then return new; end if;
    return null;
  end if;

  -- THERE IS NO THIRD SKIP. There used to be: on DELETE, a row generated from a
  -- bill, a pay run, a delivery or a stock-take returned early, on the argument
  -- that reversing a paid bill's Dr 6100 / Cr 2000 while its payments' Dr 2000 /
  -- Cr 1000 entries stayed standing would leave Accounts Payable in DEBIT by the
  -- whole bill.
  --
  -- THE ARGUMENT WAS SOUND AND THE SKIP WAS OVER-APPLIED. It is true only for a
  -- bill that has been paid IN FULL. An UNPAID bill has no payment entries at
  -- all, so nothing was left standing and the skip simply stranded the cost for
  -- ever; a PART-PAID one was left carrying its whole cost when only a fraction
  -- had been settled. And the premise itself is now false: the payments no
  -- longer stay standing, because reverse_invoice_payment_entry() below reverses
  -- them on the same cascade. Both halves of a deleted bill come off together,
  -- 2000 returns to zero for that bill, and check 13's invariant holds.
  --
  -- THE OTHER THREE LINKS NEVER NEEDED THE SKIP. A payroll-linked row, a
  -- count-linked row and an inventory_purchase bill all carry a NULL
  -- journal_entry_id -- post_expense_to_ledger returns early for each
  -- (20260908000800's seven-way branch) -- so skip 1 above has already returned
  -- for them before this point is reached. The one link that DID reach here with
  -- an entry is an ordinary bill's mirror, which is exactly the row that must
  -- reverse. A delivery-linked row (Dr 2000 / Cr wallet, the delivery's payment)
  -- does post, but `stock_receipts` has no delete policy and no client delete --
  -- grep src/lib for one -- so the only cascade that can reach it is from
  -- `shops`, which skip 2 already returns for. If a delete door for deliveries
  -- is ever added it will need the receipt's OWN entry reversed alongside, the
  -- same pairing this migration builds for bills.
  --
  -- CASCADE ORDER IS NOT RELIED ON. Deleting an `invoices` row cascades to both
  -- `expenses` and `invoice_payments`, and Postgres fires those RI actions as
  -- AFTER triggers on the parent in constraint-creation order -- which this file
  -- does not control and must not depend on. It does not have to: the two
  -- reversals are independent inserts against two different journal entries.
  -- Neither reads the other's row, neither reads `invoices`, and addition
  -- commutes -- so whichever fires first, the ledger ends in the same place.
  -- The only ordering fact that IS load-bearing is skip 2 above, which needs the
  -- `shops` row to be gone by the time a cascade from `shops` reaches here, and
  -- that is guaranteed by cascades being AFTER triggers on the parent at all.
  --
  -- UPDATE never had the exclusion. sync_invoice_expense (20260816000000)
  -- rewrites the mirrored row whenever the bill's amount, category or issue date
  -- changes, and re-posting from the corrected figures is exactly right -- an
  -- edited bill's cost belongs to the edited bill. Recording a PAYMENT does not
  -- reach here at all: invoices_sync_expense fires `update of amount_cents,
  -- category, issued_on, description, vendor_id, invoice_number` and paid_cents
  -- is not in that list, and the WHEN clauses below would refuse it a second
  -- time.
  select * into v_old from public.journal_entries where id = old.journal_entry_id;

  -- Loud rather than quiet. An expense pointing at a draft or an
  -- already-reversed entry is a state nothing in this codebase can produce, and
  -- silently writing a second mirror on top of it would leave the cost reversed
  -- twice with nothing on the record saying so.
  -- IS DISTINCT FROM, not <>: a missing row leaves v_old.status NULL and
  -- `null <> 'posted'` is NULL, so a plain <> would fall THROUGH the guard and
  -- fail several statements later on a not-null constraint. The foreign key on
  -- expenses.journal_entry_id makes a missing row unreachable, which is exactly
  -- why the failure mode has to be loud rather than plausible.
  if v_old.status is distinct from 'posted' then
    raise exception 'the journal entry for this expense is %, so it cannot be reversed',
      coalesce(v_old.status, 'missing') using errcode = 'P0001';
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
        || ' — expense ' || old.id::text
        || case when tg_op = 'UPDATE' then ' was edited' else ' was deleted' end
        || case when v_reversal_date <> v_old.entry_date
                then ' (originally dated ' || to_char(v_old.entry_date, 'YYYY-MM-DD')
                     || '; that period is ' || coalesce(v_old_period_status, 'not open')
                     || ', so the reversal is recognised here)'
                else '' end,
      v_old.source, 'posted', v_old.location_id, v_old.id, auth.uid())
    returning id into v_reversal_id;

  insert into public.journal_lines (entry_id, account_id, amount_cents, location_id, memo)
    select v_reversal_id, account_id, -amount_cents, location_id, memo
      from public.journal_lines where entry_id = v_old.id;

  -- The one update refuse_posted_entry_edit() permits, and the link that makes
  -- neither entry readable without finding the other.
  update public.journal_entries
     set status = 'reversed', reverses_entry_id = v_reversal_id
   where id = v_old.id;

  if tg_op = 'UPDATE' then
    -- BEFORE UPDATE, so this assignment sticks. Clearing the pointer is what
    -- lets post_expense_to_ledger -- whose first act is to skip any row that
    -- already carries an entry -- post the replacement a moment later on the
    -- AFTER trigger. Without it the edit reverses and never re-posts, which is
    -- strictly worse than doing nothing: the cost disappears from the books
    -- while the receipt is still on the Expenses screen.
    new.journal_entry_id := null;
    return new;
  end if;
  return null;
end;
$$;

comment on function public.reverse_expense_entry() is
  'BEFORE UPDATE / AFTER DELETE on expenses. Reverses the entry the row posted, inline rather than through reverse_journal_entry (which gates on ledger.post; this door gates on expenses.manage). The reversal carries the source of the entry it reverses and is redated into the open period if the original''s month has closed. On UPDATE it clears journal_entry_id so post_expense_to_ledger re-posts from the edited figures. A no-op for a row that posted nothing and for a shop being deleted -- and nothing else: a bill''s mirrored row cascading away DOES reverse, paired with reverse_invoice_payment_entry() reversing the same bill''s payments.';

-- ---------------------------------------------------------------------------
-- The triggers, and the WHEN clause that is load-bearing
-- ---------------------------------------------------------------------------
--
-- THE WHEN CLAUSE IS NOT AN OPTIMISATION -- WITHOUT IT THIS RECURSES FOR EVER.
-- post_expense_to_ledger's last statement is
-- `update public.expenses set journal_entry_id = v_entry_id where id = new.id`,
-- so an unconditional AFTER UPDATE trigger would re-enter it on every post: the
-- stamp fires the reversal, the reversal clears the stamp, the re-post stamps
-- again. Listing exactly the columns the ENTRY is derived from -- and pointedly
-- not journal_entry_id -- makes the stamp invisible to both triggers.
--
-- It is also the right semantics on its own terms. `note` and `vendor_id` reach
-- no journal line, so retyping a note must not churn a reversal pair through the
-- ledger. The four link columns ARE listed even though the update policy bars
-- changing them: what a row posts turns on the links, so if that bar were ever
-- relaxed the posting would follow rather than silently keep the old branch.
--
-- shop_id IS LISTED, and it is the one that was missing. post_journal_entry
-- takes a shop id, so the entry is derived from it as surely as from the amount.
-- The `update expenses` policy gates both halves on has_shop_permission(shop_id,
-- 'expenses.manage'), which a user who manages two shops satisfies for both --
-- so moving a receipt from one to the other is reachable, and without shop_id in
-- the clause it would leave the entry in the OLD shop with no reversal and no
-- re-post. One shop's P&L keeps a cost it no longer has a receipt for and the
-- other never learns of it.
--
-- Both triggers carry the identical clause. If they ever diverge, one half of
-- reverse-and-re-post fires without the other.
drop trigger if exists expenses_reverse_on_edit on public.expenses;
create trigger expenses_reverse_on_edit
  before update on public.expenses
  for each row
  when (old.shop_id         is distinct from new.shop_id
     or old.amount_cents    is distinct from new.amount_cents
     or old.category        is distinct from new.category
     or old.payment_method  is distinct from new.payment_method
     or old.occurred_on     is distinct from new.occurred_on
     or old.location_id     is distinct from new.location_id
     or old.invoice_id      is distinct from new.invoice_id
     or old.payroll_run_id  is distinct from new.payroll_run_id
     or old.stock_receipt_id is distinct from new.stock_receipt_id
     or old.stock_count_id  is distinct from new.stock_count_id)
  execute function public.reverse_expense_entry();

-- The replacement, posted by the SAME function that posts the first entry --
-- see reason 1 in the note above. Its body is unchanged by this migration.
--
-- A SEPARATE TRIGGER from expenses_post_to_ledger rather than
-- `after insert or update`, because a WHEN clause naming `old` is not legal on
-- an INSERT trigger and the insert side must fire unconditionally.
--
-- CARRY THIS FORWARD. A future migration that re-creates post_expense_to_ledger
-- will re-create `expenses_post_to_ledger` with it (20260908000750 and
-- 20260908000800 both do). This trigger is easy to leave behind, and without it
-- an edited expense reverses and never re-posts.
drop trigger if exists expenses_post_to_ledger_on_edit on public.expenses;
create trigger expenses_post_to_ledger_on_edit
  after update on public.expenses
  for each row
  when (old.shop_id         is distinct from new.shop_id
     or old.amount_cents    is distinct from new.amount_cents
     or old.category        is distinct from new.category
     or old.payment_method  is distinct from new.payment_method
     or old.occurred_on     is distinct from new.occurred_on
     or old.location_id     is distinct from new.location_id
     or old.invoice_id      is distinct from new.invoice_id
     or old.payroll_run_id  is distinct from new.payroll_run_id
     or old.stock_receipt_id is distinct from new.stock_receipt_id
     or old.stock_count_id  is distinct from new.stock_count_id)
  execute function public.post_expense_to_ledger();

-- AFTER, so the ledger only ever learns about a deletion the table has already
-- accepted -- the mirror of the AFTER INSERT reasoning in 20260908000750.
drop trigger if exists expenses_reverse_on_delete on public.expenses;
create trigger expenses_reverse_on_delete
  after delete on public.expenses
  for each row execute function public.reverse_expense_entry();

-- ---------------------------------------------------------------------------
-- THE OTHER HALF OF A DELETED BILL: its payments
-- ---------------------------------------------------------------------------
--
-- A bill's cost and a bill's payments are one fact in two tables, and the only
-- honest treatment of `delete from invoices` is that BOTH come off. The expense
-- half is above; this is the payment half.
--
-- WHY A TRIGGER AND NOT MORE CODE IN delete_invoice_payment. That RPC is the
-- Undo button on the Bills screen and it never sees a cascade at all -- the rows
-- vanish underneath it. The trigger is on `invoice_payments` itself, so it fires
-- for every route a payment row can leave by: the RPC, the cascade from
-- deleteInvoice, the cascade from a shop being deleted, and a client `.delete()`
-- (which the `write invoice_payments` policy, being `for all`, permits and which
-- nothing else covered).
--
-- WHY delete_invoice_payment KEEPS ITS INLINE REVERSAL ANYWAY. Undoing a payment
-- is one decision -- reverse the entry, drop the row, recompute paid_cents --
-- and a reader of that door should find all three in the function they are
-- reading, under the lock it already takes. The two never both write: the RPC
-- marks the original `reversed` before its own delete, and the first thing this
-- trigger does with a `reversed` entry is return.
--
-- No `for update` here. The DELETE statement has already row-locked the tuple
-- its own trigger is firing for, so the race the RPC's parent lock exists for
-- cannot happen -- the same reason reverse_expense_entry needs none.
create or replace function public.reverse_invoice_payment_entry() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_old public.journal_entries%rowtype;
  v_old_period_status text;
  v_reversal_date date;
  v_reversal_id uuid;
begin
  -- A payment recorded before 20260908000500 shipped, or one the backfill has
  -- not reached, posted nothing. Reversing nothing is a clean no-op.
  if old.journal_entry_id is null then return null; end if;

  select * into v_old from public.journal_entries where id = old.journal_entry_id;
  -- The foreign key on invoice_payments.journal_entry_id makes this unreachable,
  -- which is exactly why it is loud rather than plausible.
  if v_old.id is null then
    raise exception 'the journal entry for this payment is missing, so it cannot be reversed'
      using errcode = 'P0001';
  end if;

  -- ALREADY REVERSED IS A NO-OP, NOT AN ERROR -- and it is the ordinary case.
  -- delete_invoice_payment reverses inline and then deletes, so this trigger
  -- fires immediately afterwards on an entry that is already mirrored. Raising
  -- here would break the Bills screen's Undo button outright. The manual ledger
  -- screen's void (reverse_journal_entry) reaches the same state by a different
  -- route and must be equally harmless.
  if v_old.status = 'reversed' then return null; end if;

  -- The shop itself being deleted -- reverse_expense_entry's skip 2, for the same
  -- reason: `shops` is the cascade root, a cascade is an AFTER trigger on the
  -- parent, and a mirror entry referencing a shops row that is already gone
  -- violates the foreign key and aborts the whole deletion. Read off the ENTRY,
  -- because invoice_payments has no shop_id and its invoice has gone too.
  if not exists (select 1 from public.shops where id = v_old.shop_id) then
    return null;
  end if;

  if v_old.status <> 'posted' then
    raise exception 'the journal entry for this payment is %, so it cannot be reversed',
      v_old.status using errcode = 'P0001';
  end if;

  -- READ, not caught -- see this migration's header. A bill deleted after its
  -- month was closed must not meet a ledger error on the Bills screen.
  select status into v_old_period_status
    from public.accounting_periods
   where shop_id = v_old.shop_id and v_old.entry_date between starts_on and ends_on;
  if v_old_period_status is not null and v_old_period_status <> 'open' then
    v_reversal_date := public.shop_local_date();
  else
    v_reversal_date := v_old.entry_date;
  end if;

  -- v_old.source ('payment'), read off the original rather than written as a
  -- literal, so the pair reads as a pair under the same filter.
  insert into public.journal_entries
      (shop_id, period_id, entry_date, reference, description, source, status,
       location_id, reverses_entry_id, created_by)
    values (
      v_old.shop_id,
      public.open_period_for(v_old.shop_id, v_reversal_date),
      v_reversal_date,
      v_old.reference || 'R',
      'Reversal of ' || coalesce(v_old.reference, 'an unreferenced entry')
        || ' — payment ' || old.id::text || ' was deleted'
        || case when v_reversal_date <> v_old.entry_date
                then ' (originally dated ' || to_char(v_old.entry_date, 'YYYY-MM-DD')
                     || '; that period is ' || coalesce(v_old_period_status, 'not open')
                     || ', so the reversal is recognised here)'
                else '' end,
      v_old.source, 'posted', v_old.location_id, v_old.id, auth.uid())
    returning id into v_reversal_id;

  insert into public.journal_lines (entry_id, account_id, amount_cents, location_id, memo)
    select v_reversal_id, account_id, -amount_cents, location_id, memo
      from public.journal_lines where entry_id = v_old.id;

  update public.journal_entries
     set status = 'reversed', reverses_entry_id = v_reversal_id
   where id = v_old.id;

  return null;
end;
$$;

comment on function public.reverse_invoice_payment_entry() is
  'AFTER DELETE on invoice_payments. Reverses the Dr 2000 / Cr wallet entry the payment posted, whichever door removed the row -- delete_invoice_payment, the cascade from deleting a bill, or a client delete. Written inline rather than through reverse_journal_entry, which gates on ledger.post. A no-op for a payment that posted nothing, for an entry already reversed (delete_invoice_payment does it inline first), and for a shop being deleted. Paired with reverse_expense_entry so both halves of a deleted bill come off together.';

drop trigger if exists invoice_payments_reverse_on_delete on public.invoice_payments;
create trigger invoice_payments_reverse_on_delete
  after delete on public.invoice_payments
  for each row execute function public.reverse_invoice_payment_entry();

-- ---------------------------------------------------------------------------
-- delete_invoice_payment
-- ---------------------------------------------------------------------------
--
-- CARRIED FORWARD IN FULL from 20260804000600, which a grep of the migrations
-- for this function's own `create or replace` line shows is its only previous
-- definition. (The incantation is described rather than written out: this file
-- defines three functions, and accumulated-rpc-edits.test.ts slices a function's
-- body from the first occurrence of its signature to the next `$$;` -- a
-- signature quoted in a comment above the real one moves that slice and makes
-- every token in it match for the wrong reason.)
-- It is NOT one of the two functions 20260905000000_complete_sale_lock_order.sql
-- patches by string-replacing pg_proc.prosrc -- that migration touches
-- complete_sale and edit_sale only -- so there is no invisible edit to carry.
-- The signature is unchanged, so this replaces rather than overloads.
--
-- The reversal block is the only addition, and it sits BEFORE the delete: once
-- the invoice_payments row is gone there is nothing left to read the entry id
-- from and the entry is unreachable for ever. Inside the same transaction,
-- deliberately -- a payment that is removed but not reversed is a
-- books-that-do-not-tie bug that only shows up at month end, with no source row
-- left for the backfill to replay. Failing the undo is louder and rarer.
--
-- A payment recorded before 20260908000500 shipped carries a NULL
-- journal_entry_id; reversing nothing is not an error.
create or replace function public.delete_invoice_payment(p_payment_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_invoice public.invoices%rowtype;
  v_invoice_id uuid;
  v_remaining integer;
  -- ── the posting side, new in 20260908001000 ────────────────────────────
  v_entry_id uuid;
  v_old public.journal_entries%rowtype;
  v_old_period_status text;
  v_reversal_date date;
  v_reversal_id uuid;
begin
  select invoice_id, journal_entry_id into v_invoice_id, v_entry_id
    from public.invoice_payments where id = p_payment_id;
  if v_invoice_id is null then
    raise exception 'payment % not found', p_payment_id;
  end if;

  -- Lock the parent before touching either table, so a concurrent
  -- record_invoice_payment can't slip between the delete and the recount. It
  -- serialises the reversal below for the same reason edit_sale and delete_sale
  -- added their own `for update`: without it two concurrent undos of the same
  -- payment can both read the entry id and both write a mirror.
  select * into v_invoice from public.invoices where id = v_invoice_id for update;
  if not public.has_shop_permission(v_invoice.shop_id, 'invoices.manage') then
    raise exception 'not authorized for bill %', v_invoice_id;
  end if;

  -- ── The posting side ────────────────────────────────────────────────────
  --
  -- Undoing a payment does not un-spend the money in the sense of a correction
  -- to the till -- it says the payment was never made. So the entry that said
  -- "Dr 2000 Accounts Payable, Cr the wallet" is mirrored: the payable goes back
  -- up by what was undone and the wallet is put back. 2000 then agrees with
  -- invoices.amount_cents - paid_cents again, which is what
  -- verify-posting-bills.sql check 13 measures.
  if v_entry_id is not null then
    select * into v_old from public.journal_entries where id = v_entry_id;
    -- IS DISTINCT FROM, not <>, for the reason reverse_expense_entry above
    -- gives: `null <> 'posted'` is NULL and would fall through the guard.
    if v_old.status is distinct from 'posted' then
      raise exception 'the journal entry for this payment is %, so it cannot be reversed',
        coalesce(v_old.status, 'missing') using errcode = 'P0001';
    end if;

    -- READ, not caught -- see this migration's header. record_invoice_payment
    -- has a user-chosen date (record-payment-modal.tsx) and 20260908000500
    -- already redirects the payment itself out of a closed month; its undoing
    -- needs the same treatment or the Bills screen's Undo button starts failing
    -- on a month that has since been shut.
    select status into v_old_period_status
      from public.accounting_periods
     where shop_id = v_old.shop_id and v_old.entry_date between starts_on and ends_on;
    if v_old_period_status is not null and v_old_period_status <> 'open' then
      v_reversal_date := public.shop_local_date();
    else
      v_reversal_date := v_old.entry_date;
    end if;

    -- What reverse_journal_entry(uuid, text) does, minus its ledger.post gate:
    -- this door gates on invoices.manage and a bookkeeper undoing a mistyped
    -- payment must not need a ledger permission as well.
    --
    -- v_old.source ('payment'), read off the original rather than written as a
    -- literal, so the pair reads as a pair under the same filter.
    insert into public.journal_entries
        (shop_id, period_id, entry_date, reference, description, source, status,
         location_id, reverses_entry_id, created_by)
      values (
        v_old.shop_id,
        public.open_period_for(v_old.shop_id, v_reversal_date),
        v_reversal_date,
        v_old.reference || 'R',
        'Reversal of ' || coalesce(v_old.reference, 'an unreferenced entry')
          || ' — payment ' || p_payment_id::text || ' was deleted'
          -- coalesce for the reason 20260908000300 found the hard way: `||`
          -- with a NULL operand yields NULL for the whole expression and the
          -- entry is then refused for having no description.
          || case when v_reversal_date <> v_old.entry_date
                  then ' (originally dated ' || to_char(v_old.entry_date, 'YYYY-MM-DD')
                       || '; that period is ' || coalesce(v_old_period_status, 'not open')
                       || ', so the reversal is recognised here)'
                  else '' end,
        v_old.source, 'posted', v_old.location_id, v_old.id, auth.uid())
      returning id into v_reversal_id;

    insert into public.journal_lines (entry_id, account_id, amount_cents, location_id, memo)
      select v_reversal_id, account_id, -amount_cents, location_id, memo
        from public.journal_lines where entry_id = v_old.id;

    update public.journal_entries
       set status = 'reversed', reverses_entry_id = v_reversal_id
     where id = v_old.id;
  end if;
  -- ── end posting side ────────────────────────────────────────────────────

  delete from public.invoice_payments where id = p_payment_id;

  -- Recomputes from the surviving rows rather than subtracting the deleted
  -- amount, so a double-undo can't drive the total negative.
  select coalesce(sum(amount_cents), 0) into v_remaining
    from public.invoice_payments where invoice_id = v_invoice_id;

  update public.invoices
    set paid_cents = v_remaining, updated_at = now(), updated_by = auth.uid()
    where id = v_invoice_id;
end;
$$;

comment on function public.delete_invoice_payment(uuid) is
  'Undoes a supplier payment: reverses the journal entry it posted, deletes the row and recomputes invoices.paid_cents from what survives. The reversal is written inline rather than through reverse_journal_entry, which gates on ledger.post; this door gates on invoices.manage. It carries the source of the entry it reverses and is redated into the open period if the original''s month has closed.';

grant execute on function public.delete_invoice_payment(uuid) to authenticated;
