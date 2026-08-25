-- An expenses row can say which delivery or which stock-take it belongs to,
-- and post_expense_to_ledger branches on the answer.
--
-- ## The defect this closes
--
-- Two client flows write an expenses row on top of an RPC that has ALREADY
-- posted the same economic event:
--
--   * stock-restock-modal.tsx ticks "Also log this as an inventory purchase"
--     and calls createExpense('inventory_purchase') after receive_stock.
--     receive_stock posted Dr 1200 Inventory / Cr 2000 Accounts Payable.
--     20260908000750's trigger then posted Dr 1200 / Cr 1000 for the SAME
--     goods -- inventory counted twice, and a payable invented against a
--     supplier who was paid in cash. Both entries balance, so the trial balance
--     still zeroes and nothing anywhere goes red.
--   * stock-count-modal.tsx does the same with 'stock_loss' after
--     save_stock_count, which posted Dr 5100 Shrinkage / Cr 1200 Inventory. The
--     trigger then posted Dr 5100 / Cr 1000: shrinkage doubled, and cash
--     credited for stock nobody sold.
--
-- ## Why the checkboxes and the rows stay
--
-- The Expenses screen and every expense report read the `expenses` table, not
-- the ledger. Deleting the rows -- or excluding both categories from the
-- trigger and leaving the rows unposted -- would either remove a line a shop
-- can see today or leave the ledger short of a cash movement that really
-- happened. What was wrong is not that the rows exist. It is WHAT THEY POST.
--
-- And the two cases are not the same defect:
--
--   * A RESTOCK EXPENSE IS NOT A DUPLICATE. The receipt records goods
--     ARRIVING; it says nothing about payment, which is exactly why it credits
--     2000 (see 20260908000400's own note on payable-not-cash). The expense
--     records that the shop PAID. So the honest entry for it is
--     Dr 2000 Accounts Payable / Cr the payment method's wallet -- settling the
--     payable the receipt just raised, which is precisely what
--     record_invoice_payment does for a bill. Debiting 1200 a second time is
--     the whole of the bug: it recognises the asset twice and never clears the
--     liability, so a shop that pays cash on delivery accumulates a payable
--     that grows for ever.
--   * A COUNT EXPENSE IS A DUPLICATE. save_stock_count posts BOTH sides of the
--     event and no money moves when stock walks out of the door. There is
--     nothing left to post, so it posts nothing.
--
-- ## But a STANDALONE row in either category must still post
--
-- Someone can type an inventory_purchase or a stock_loss straight into the
-- Expenses screen with no receipt and no count behind it, and both are real:
--
--   * standalone inventory_purchase -> Dr 1200 / Cr wallet. Goods bought and
--     paid for in one step. Unchanged, and already correct.
--   * standalone stock_loss -> Dr 5100 / Cr 1200. THIS IS A SECOND FIX, not a
--     restatement of the first. Losing stock does not spend money: crediting a
--     wallet asserts a payment nobody made and leaves 1200 carrying stock that
--     is not on the shelf. The write-down has to come out of inventory. This
--     was wrong before the double-post existed and would still be wrong with
--     the double-post gone.
--
-- Telling the two apart needs a link the table did not have. `expenses` knew
-- about invoices and pay runs and nothing else, which is why the trigger could
-- not tell a receipt's payment from a hand-typed stock purchase. That missing
-- link is the root cause; the two columns below are it.

-- on delete cascade, matching invoice_id (20260804000300) and payroll_run_id
-- (20260804000400). Neither parent is ever deleted in practice -- stock_receipts
-- and stock_counts have no delete policy at all and no RPC removes one, by the
-- same append-only design their own migrations set out -- so the only path that
-- reaches this cascade is a shop being deleted, where taking the expense with
-- it is right.
alter table public.expenses
  add column if not exists stock_receipt_id uuid references public.stock_receipts(id) on delete cascade;
alter table public.expenses
  add column if not exists stock_count_id uuid references public.stock_counts(id) on delete cascade;

create index if not exists expenses_stock_receipt_id_idx on public.expenses(stock_receipt_id);
create index if not exists expenses_stock_count_id_idx on public.expenses(stock_count_id);

comment on column public.expenses.stock_receipt_id is
  'The delivery this payment settles. Set by the Restock sheet''s "also log this as an inventory purchase" tick. Its entry is Dr 2000 Accounts Payable / Cr the wallet -- the receipt already debited 1200.';
comment on column public.expenses.stock_count_id is
  'The stock-take this write-off belongs to. Set by the Count sheet''s "also log this as a stock loss" tick. Posts NOTHING: save_stock_count already posted both sides and no money moved.';

-- The branch below reads the four link columns in a fixed order, so a row
-- carrying two of them would post whichever one is tested first and hide the
-- other. Nothing writes two today -- sync_invoice_expense sets invoice_id
-- alone, post_payroll_run payroll_run_id alone, and each modal one of the new
-- pair -- and this makes that an enforced fact rather than a habit.
alter table public.expenses
  drop constraint if exists expenses_one_source_link;
alter table public.expenses
  add constraint expenses_one_source_link
  check (num_nonnulls(invoice_id, payroll_run_id, stock_receipt_id, stock_count_id) <= 1);

-- ---------------------------------------------------------------------------
-- A BILL RECOGNISES ITS OWN COST. The exclusion that used to sit here was the
-- one wrong member of the set, and it was wrong in the most expensive
-- direction available.
-- ---------------------------------------------------------------------------
--
-- 20260908000750's exclusion block said an invoice-linked row posts nothing
-- because "the bill recognised the cost". NOTHING ON THIS BRANCH POSTS ANYTHING
-- WHEN AN INVOICE IS INSERTED -- grep every migration for post_journal_entry
-- and no invoices trigger appears. What sync_invoice_expense (20260804000300)
-- does on insert is mirror the bill into `expenses` carrying invoice_id, and
-- that mirror row was exactly the row being skipped. The recognition the
-- comment appealed to was the row it was refusing to post.
--
-- Meanwhile record_invoice_payment posts Dr 2000 Accounts Payable / Cr the
-- wallet (20260908000500). So: a shop enters a 5,000 rent bill and NOTHING
-- posts. It pays it, and Dr 2000 5,000 / Cr 1000 5,000 posts. The balance sheet
-- reads Accounts Payable MINUS 5,000 -- a liability in debit -- and the P&L
-- shows no rent at all. Every non-stock bill compounds it, for ever. Every
-- entry balances and the trial balance zeroes throughout, which is why nothing
-- caught it.
--
-- An invoice-linked row now posts
--   Dr the category's account / Cr 2000 Accounts Payable
-- which is the exact mirror of the stock_receipt_id branch below (Dr 2000 /
-- Cr wallet) and gives record_invoice_payment's Dr 2000 something to clear.
-- The cost is recognised when the BILL IS ENTERED; the payment SETTLES it.
--
-- ## The one category that still posts nothing, and why that is not the same
-- ## mistake wearing a different hat
--
-- inventory_purchase maps to 1200 Inventory, and 1200 is what receive_stock
-- already debits (against Cr 2000) when the goods land. A bill for goods that
-- arrived through Restock would debit 1200 and credit 2000 a SECOND time:
-- stock overstated by the whole delivery, a phantom payable beside the real
-- one, and record_invoice_payment's Dr 2000 clearing only half of it.
--
-- And that pairing is not a coincidence a shop has to avoid -- IT IS THE ONLY
-- ROUTE THE APP OFFERS. receive_stock deliberately credits a payable and says
-- nothing about payment (20260908000400's "Payable, not cash"). The only door
-- that draws that payable back down is record_invoice_payment, which needs an
-- invoice. So "receive the delivery, then enter the supplier's bill for it" is
-- the app's own unpaid-delivery flow, and it is the flow this branch must not
-- break.
--
-- Inventory is therefore recognised WHERE IT ARRIVES, and a bill for it adds
-- nothing to the ledger. Nothing is lost from the P&L either: 1200 is an asset,
-- and its cost reaches the P&L as COGS when the goods sell -- unlike rent,
-- which has no other door at all. That is the whole difference between the two
-- and the reason one posts and the other does not.
--
-- THE RESIDUE, STATED RATHER THAN HIDDEN: an inventory_purchase bill with no
-- delivery behind it raises no payable, so paying it drives 2000 negative by
-- that amount. It cannot be told apart from the paired case -- `invoices` has
-- no link to `stock_receipts` and this phase does not add one -- and it is a
-- shop whose stock records are already wrong, because the units it bought never
-- entered inventory by any door. Matching a bill to a delivery (a GRNI account,
-- or a receipt id on the invoice) is phase 3's work.
--
-- ---------------------------------------------------------------------------
-- The seven-way branch. Read 20260908000750's exclusion block before changing
-- it -- and read the correction above it before trusting what it says about
-- bills.
-- ---------------------------------------------------------------------------
--
--   payroll_run_id set   -> nothing   (post_payroll_run posted its own entry)
--   journal_entry_id set -> nothing   (already posted; the backfill sets this)
--   stock_count_id set   -> nothing   (save_stock_count posted both sides)
--   invoice_id, inventory_purchase -> nothing (receive_stock recognised it)
--   invoice_id, anything else      -> Dr the category's account / Cr 2000
--   stock_receipt_id set -> Dr 2000 / Cr wallet
--   standalone stock_loss        -> Dr 5100 / Cr 1200
--   standalone anything else     -> Dr the category's account / Cr wallet
--
-- The three unconditional `return null`s are kept as three separate statements
-- rather than one `or`: each is skipped for a DIFFERENT reason, and a reader
-- deciding whether one can be removed needs to see which.
create or replace function public.post_expense_to_ledger() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_debit_code   text;
  v_credit_code  text;
  v_debit_memo   text;
  v_credit_memo  text;
  v_period_status text;
  v_posted_date  date;
  v_entry_id     uuid;
begin
  -- See the exclusion block in 20260908000750. Do not remove these without
  -- reading it; post_payroll_run is named there by name. The invoice_id
  -- exclusion that used to stand alongside them has been REMOVED -- see the
  -- correction above this function; it recognised nothing.
  if new.payroll_run_id is not null then return null; end if;
  if new.journal_entry_id is not null then return null; end if;
  -- save_stock_count posts Dr 5100 / Cr 1200 for the whole variance in the same
  -- transaction that moved the units, and nothing was paid for -- so there is no
  -- second entry to write. Posting one here doubled 5100 and credited a till
  -- that never opened.
  if new.stock_count_id is not null then return null; end if;

  if new.invoice_id is not null then
    -- A BILL IS AN UNPAID EXPENSE (20260804000300), and this is where that
    -- sentence becomes an entry. Cr 2000, never a wallet: no money has moved,
    -- and the mirror row's payment_method is the literal 'other' that
    -- sync_invoice_expense writes because a bill has no payment method at all --
    -- so routing it through account_code_for_payment_method would credit 1010
    -- Bank for a bill nobody has paid. record_invoice_payment then debits 2000
    -- back down when the money really does leave, and what is left in 2000 is
    -- what the shop actually owes.
    --
    -- inventory_purchase is the one category that still posts nothing: the
    -- delivery already debited 1200 against 2000, and the ONLY way to settle
    -- that payable is a bill, so the pair is the app's flow rather than a
    -- mistake. See the long note above this function.
    if new.category = 'inventory_purchase' then return null; end if;
    v_debit_code  := public.account_code_for_expense_category(new.category);
    v_credit_code := '2000';
    v_debit_memo  := replace(new.category, '_', ' ');
    v_credit_memo := 'Owed to supplier';
  elsif new.stock_receipt_id is not null then
    -- SETTLING THE PAYABLE THE RECEIPT RAISED, not buying the goods again.
    -- receive_stock has already put the delivery into 1200 against 2000; this
    -- row is the money going out. Hardcoded '2000' rather than routed through
    -- account_code_for_expense_category, because the category on the row is
    -- 'inventory_purchase' (which maps to 1200) and it is the LINK, not the
    -- category, that decides what this is. record_invoice_payment writes the
    -- same shape for a bill.
    v_debit_code  := '2000';
    v_credit_code := public.account_code_for_payment_method(new.payment_method);
    v_debit_memo  := 'Delivery paid';
    v_credit_memo := 'Paid by ' || new.payment_method;
  elsif new.category = 'stock_loss' then
    -- A standalone write-off, with no count behind it. Cr 1200, NEVER a wallet:
    -- stock that is stolen, broken or expired costs the shop the stock, not the
    -- till. Crediting cash here balances perfectly and makes the drawer
    -- disagree with the ledger by the whole of the shop's shrinkage, while
    -- leaving 1200 carrying units that are not on the shelf.
    --
    -- 5100 rather than account_code_for_expense_category is a no-op today --
    -- the map sends 'stock_loss' to 5100 -- and is written out because the pair
    -- has to move together: the point of this branch is the CONTRA, and reading
    -- one side from the map would invite someone to "simplify" it back into the
    -- generic branch and take the 1200 with it.
    v_debit_code  := '5100';
    v_credit_code := '1200';
    v_debit_memo  := 'stock loss';
    v_credit_memo := 'Written off';
  else
    v_debit_code := public.account_code_for_expense_category(new.category);
    -- The wallet the money actually left, not 1000 Cash for everything.
    -- expenses.payment_method carries the same four values invoice_payments.method
    -- does and account_code_for_expense_category's sibling already maps them.
    -- Hardcoding 1000 would make the till count disagree with the ledger for
    -- every zaad or eDahab expense, and leave 1020/1021 permanently understated
    -- on the balance sheet this phase exists to make possible -- the exact defect
    -- verify-posting-bills.sql check 2 exists to catch on the supplier-payment
    -- side. For the common case (payment_method defaults to 'cash') this IS
    -- '1000'.
    v_credit_code := public.account_code_for_payment_method(new.payment_method);
    v_debit_memo  := replace(new.category, '_', ' ');
    v_credit_memo := 'Paid by ' || new.payment_method;
  end if;

  -- occurred_on, not today: 20260804000200 makes the point that a receipt is
  -- often logged days after the purchase and it is the PURCHASE date that
  -- decides the period. It is already a `date` column, so it is exempt from the
  -- shop_local_date() rule -- there is no moment in time to resolve against a
  -- server timezone, and wrapping it would be a no-op cast through a function
  -- that expects a timestamptz.
  --
  -- A BACK-DATED EXPENSE WHOSE MONTH HAS CLOSED POSTS TO THE OPEN ONE, which
  -- is Task 3b's treatment of a back-dated sale and is here for a stronger
  -- reason: the expense editor has a free date field
  -- (expense-editor-modal.tsx:101), so back-dating is not an import edge case,
  -- it is the ordinary way a receipt from last week gets entered. Without this,
  -- open_period_for would raise `This period is closed` and a plain expense
  -- insert -- something that works today -- would start failing outright.
  --
  -- READ, not caught. An exception handler around post_journal_entry would also
  -- swallow an unbalanced entry, an unknown account code or a missing chart of
  -- accounts and retry them into the current month as though the only thing
  -- wrong were the date.
  select status into v_period_status
    from public.accounting_periods
   where shop_id = new.shop_id and new.occurred_on between starts_on and ends_on;

  -- No row means open_period_for will create it open, so only an EXISTING
  -- non-open period redirects. Treating a missing row as shut would redate
  -- every expense in a month the shop has not traded in yet.
  if v_period_status is not null and v_period_status <> 'open' then
    v_posted_date := public.shop_local_date();
  else
    v_posted_date := new.occurred_on;
  end if;

  -- The description carries the expense id so the link is readable in both
  -- directions -- expenses.journal_entry_id gets you from the row to the entry,
  -- and a journal of four hundred lines all reading 'Expense' gets you nowhere
  -- back. Task 8's backfill reconciles replayed entries against their source
  -- rows and wants the same link.
  --
  -- coalesce on v_period_status even though the branch above cannot leave it
  -- NULL while the dates differ: `||` with a NULL operand yields NULL for the
  -- WHOLE expression, and post_journal_entry then refuses the row with
  -- "A journal entry needs a description." -- an error about descriptions for a
  -- bug about dates. The same trap 20260908000300 documents.
  v_entry_id := public.post_journal_entry(
    new.shop_id,
    v_posted_date,
    'Expense ' || new.id::text
      || case when v_posted_date <> new.occurred_on
              then ' (incurred ' || to_char(new.occurred_on, 'YYYY-MM-DD')
                   || '; that period is ' || coalesce(v_period_status, 'not open')
                   || ', so it is recognised here)'
              else '' end,
    jsonb_build_array(
      jsonb_build_object('code', v_debit_code,  'amount_cents',  new.amount_cents,
                         'memo', v_debit_memo),
      jsonb_build_object('code', v_credit_code, 'amount_cents', -new.amount_cents,
                         'memo', v_credit_memo)),
    -- The store the cost belongs to travels onto the entry, for the reason
    -- 20260816000000 exists: a cost with no store drops out of that store's
    -- P&L. Null stays null for a business-wide expense, which is a real value
    -- and not a gap.
    new.location_id,
    'bill');

  -- AFTER INSERT, so `new` is not writable -- assigning to it here would be
  -- silently discarded rather than rejected. The row is updated instead.
  --
  -- AFTER rather than BEFORE deliberately: post_journal_entry's description
  -- carries new.id, and in a BEFORE INSERT trigger that id is the default the
  -- row is ABOUT to get -- which is fine -- but the entry would also be written
  -- before the row's own constraints (amount_cents > 0, the category CHECK,
  -- enforce_shop_module) had all been proved. AFTER means the ledger only ever
  -- learns about an expense the table has already accepted.
  update public.expenses set journal_entry_id = v_entry_id where id = new.id;

  return null;
end;
$$;

comment on function public.post_expense_to_ledger() is
  'AFTER INSERT on expenses. Posts nothing for a row carrying payroll_run_id, stock_count_id or an existing journal_entry_id -- something else already posted that event. A row carrying invoice_id posts Dr the category''s account / Cr 2000 Accounts Payable, which is how a bill recognises its cost and what record_invoice_payment''s Dr 2000 later clears; an inventory_purchase bill is the exception and posts nothing, because receive_stock already debited 1200 against 2000 for the same goods. A row carrying stock_receipt_id posts Dr 2000 / Cr the wallet, settling the payable receive_stock raised. A standalone stock_loss posts Dr 5100 / Cr 1200. Everything else posts Dr the category''s account / Cr the payment method''s wallet.';

-- ---------------------------------------------------------------------------
-- The two new links get the same read-only bar the other two already have.
-- ---------------------------------------------------------------------------
--
-- 20260804000300:145-148 and 20260804000400:98-107 make invoice- and
-- payroll-generated rows read-only from the Expenses screen, because "the total
-- and its source drift apart" otherwise. stock_receipt_id and stock_count_id
-- arrived without that bar, and the gap is not cosmetic:
--
--   * DELETING a receipt-linked row from the Expenses screen removes the source
--     of a Dr 2000 / Cr wallet settlement and leaves the entry standing over
--     nothing. The delivery's payable reads as cleared with no record of who
--     cleared it, and the backfill can never repair it -- there is no row left
--     to replay.
--   * The `with check` half is the sharper one. Without these clauses a client
--     can SET or CLEAR either link column on an existing row: clearing
--     stock_receipt_id turns a settlement into a standalone purchase and the
--     replay debits 1200 for goods already on the books; setting stock_count_id
--     on a hand-typed write-off makes the replay skip it entirely. In both
--     directions the live posting has already happened under the OLD value and
--     only the replay moves -- which is the one property this phase is built on.
--
-- Recreated in full rather than altered, matching 0024's convention and the two
-- migrations above. The four columns are listed in the order they were added.
drop policy "update expenses" on public.expenses;
create policy "update expenses" on public.expenses for update
  using (has_shop_permission(shop_id, 'expenses.manage') and invoice_id is null and payroll_run_id is null
         and stock_receipt_id is null and stock_count_id is null)
  with check (has_shop_permission(shop_id, 'expenses.manage') and invoice_id is null and payroll_run_id is null
              and stock_receipt_id is null and stock_count_id is null);

drop policy "delete expenses" on public.expenses;
create policy "delete expenses" on public.expenses for delete
  using (has_shop_permission(shop_id, 'expenses.manage') and invoice_id is null and payroll_run_id is null
         and stock_receipt_id is null and stock_count_id is null);

-- Unchanged from 20260908000750, restated because the function was replaced and
-- a reader of this file should not have to open the last one to learn where the
-- trigger is. Row-level, so an insert of several expenses at once posts one
-- entry each.
drop trigger if exists expenses_post_to_ledger on public.expenses;
create trigger expenses_post_to_ledger
  after insert on public.expenses
  for each row execute function public.post_expense_to_ledger();
