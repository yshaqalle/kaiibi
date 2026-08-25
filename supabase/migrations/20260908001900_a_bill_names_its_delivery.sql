-- A bill says which delivery it pays for, and the ledger stops guessing.
--
-- ## The guess, and the two ways it fails
--
-- receive_stock posts Dr 1200 Inventory / Cr 2000 Accounts Payable: goods
-- arrived, the supplier is owed. record_invoice_payment posts Dr 2000 / Cr the
-- wallet: the supplier is paid. Those two net out ONLY IF the bill being paid
-- is for the delivery that raised the payable -- and until this migration the
-- app decided that by CATEGORY. 20260908000800's branch reads
--
--     invoice_id set and category = 'inventory_purchase' -> post nothing
--
-- on the assumption that a delivery already raised the payable. That assumption
-- is about something the database was never told, and it is wrong in both
-- directions. 20260908000800 states both at length; in short:
--
--   UNDER-STATED. A goods bill with no delivery behind it credits 2000 nowhere,
--   so paying it drives Accounts Payable into DEBIT -- a negative liability on a
--   balance sheet. PR #76 put a `wrong`-toned Caveat on the Bills screen so it is
--   at least visible. This migration is what stops it happening.
--
--   OVER-STATED. A bill FOR GOODS entered under `supplies` -- one wrong tap on
--   the category picker -- takes the generic arm and posts Dr 6400 / Cr 2000 ON
--   TOP OF the delivery's Dr 1200 / Cr 2000. The payable is DOUBLED. The category
--   exclusion cannot see this, because the category is exactly what is wrong.
--
-- Both are one root cause -- no link between `invoices` and `stock_receipts` --
-- and every entry involved balances, so the trial balance zeroes throughout.
--
-- THE SHAPE HAS BITTEN THIS BRANCH BEFORE. 20260908000800 removed a wholesale
-- invoice_id exclusion whose stated premise ("the bill recognised the cost") was
-- false; the row it was skipping WAS the recognition. A guess about what another
-- door did, written as a comment and trusted for four migrations. So the column
-- below is a recorded fact, and the branch keys on it rather than on a category.
--
-- ## The decision: shut the door, do not post around the gap
--
-- The obvious branch once the column exists is "linked posts nothing, unlinked
-- posts Dr 1200 / Cr 2000". IT IS WRONG, and the reason is worth writing out
-- because it is what a reader reaches for first. THE TRIGGER CANNOT TELL THE TWO
-- UNLINKED CASES APART -- which is the whole problem, arriving one layer down:
--
--   A. The goods DID arrive and were recorded through Restock; only the link is
--      missing. Posting Dr 1200 / Cr 2000 DOUBLES both the stock and the payable
--      -- the over-stated failure above, in its most expensive form.
--
--   B. The goods arrived and were NEVER RECORDED AT ALL. products.stock has not
--      heard of them. Posting Dr 1200 makes the ledger say inventory value rose
--      while the quantity did not -- value and quantity diverge, invisibly. And
--      it is worse than it looks: opening_inventory_gap (20260908001300) is
--      "stock on hand less what the ledger holds against 1200", so a phantom
--      debit SHRINKS the opening balance by exactly the phantom -- permanently,
--      because the opening marker means a second replay can never correct it.
--      That is the negative-asset failure 20260908001800 was written to remove,
--      re-entering from the other end.
--
-- In case B the shop's stock records are ALREADY WRONG whatever the ledger does.
-- Posting Dr 1200 does not fix that; it hides it, by making the value side agree
-- with a quantity that is missing. Today's negative payable is at least visible
-- and flagged. 20260804000000's header states the house instinct plainly: a
-- precise-looking number that is simply wrong is worse than an admitted gap.
--
-- So: the link is REQUIRED AT INSERT for an inventory_purchase bill, OFFERED for
-- every other category, and IMMUTABLE afterwards.
--
-- ## Why immutable, and it is not conservatism
--
-- expenses_reverse_on_edit and expenses_post_to_ledger_on_edit (20260908001000)
-- fire on a FIXED COLUMN LIST on `expenses`, and nothing on `expenses` changes
-- when the INVOICE's link does -- sync_invoice_expense copies location, date,
-- amount, category, vendor and note, and none of those move. So the posting
-- would not follow the link even if the link were allowed to move. A mutable
-- link therefore means the live entry was written under one answer while the
-- replay reads another, for the same row: the exact live/replay divergence this
-- whole phase is built on not having. Set once, at insert, and the two cannot
-- disagree.
--
-- Correcting a mis-picked delivery is delete-and-re-enter, which is already a
-- complete remedy: 20260908001000's reverse_expense_entry and
-- reverse_invoice_payment_entry take the bill's cost AND its payments off
-- together (Task 7d).
--
-- ## What existing bills do: NOTHING CHANGES, and nothing is re-posted
--
-- Every invoice that exists on the day this ships has stock_receipt_id null. The
-- second arm of the branch below -- unlinked, inventory_purchase, post nothing --
-- is exactly what those rows do today, live and on replay, so no history moves
-- and no figure on any report changes. What that arm no longer does is CLAIM
-- that a delivery recognised the cost. It is an admitted gap for rows the link
-- cannot describe, and it is unreachable for a bill entered from now on.
--
-- ## The shop with no `inventory` module
--
-- receive_stock is gated on it (20260902000000), so such a shop cannot record a
-- delivery at all and requiring a link would brick stock-purchase bills for a
-- whole class of shop. The door therefore asks shop_has_module first, and a shop
-- without inventory keeps today's behaviour exactly -- posts nothing, admitted
-- gap. Stated rather than silent: it is the one shop shape this migration does
-- not improve.

-- ---------------------------------------------------------------------------
-- 1. The column
-- ---------------------------------------------------------------------------
--
-- ON DELETE SET NULL, and the choice is between three bad-looking options.
-- CASCADE would delete a bill because a delivery went, which loses a real
-- liability. RESTRICT/NO ACTION would fire during a shop delete, where invoices
-- and stock_receipts both cascade off `shops` in one statement and the order is
-- not ours to choose -- exactly the failure b2f66fd had to fix once already.
-- SET NULL leaves a bill that no longer names a delivery, which is honest: the
-- delivery's own Dr 1200 / Cr 2000 was reversed on the same cascade
-- (20260908001500), so there is nothing left for the bill to have been settling.
-- It also never fires in practice -- stock_receipts has no delete policy, no
-- client delete and no RPC that removes one.
--
-- The row it leaves violates no invariant this migration states, because the
-- invariant is about CREATION, not about the row for ever. See the guard below.
alter table public.invoices
  add column if not exists stock_receipt_id uuid references public.stock_receipts(id) on delete set null;

create index if not exists invoices_stock_receipt_id_idx on public.invoices(stock_receipt_id);

-- ONE BILL PER DELIVERY, and this is not tidiness. Two bills naming the same
-- delivery would each post nothing while each of their payments debits 2000, so
-- the payable goes negative by a whole delivery's value -- the very failure the
-- column exists to close, reached through the column itself.
--
-- Partial, so the nulls every existing bill carries do not collide.
create unique index if not exists invoices_stock_receipt_id_key
  on public.invoices(stock_receipt_id) where stock_receipt_id is not null;

comment on column public.invoices.stock_receipt_id is
  'The delivery this bill pays for. Set when the bill is entered and immutable afterwards -- what a bill posts is decided once, or the live entry and the replay disagree about the same row. A bill carrying one posts NOTHING, whatever its category: receive_stock already posted Dr 1200 / Cr 2000 for those goods and record_invoice_payment''s Dr 2000 clears it. Required for an inventory_purchase bill in a shop that has the inventory module.';

-- ---------------------------------------------------------------------------
-- 2. The door
-- ---------------------------------------------------------------------------
--
-- A trigger rather than a CHECK constraint, for three reasons that each rule the
-- constraint out on its own:
--
--   * A plain CHECK is validated against EVERY EXISTING ROW, and every existing
--     goods bill would fail it. The migration would not apply.
--   * A NOT VALID CHECK skips the existing rows but is still enforced on UPDATE,
--     so an old unlinked goods bill could never have its due date corrected
--     again -- and the error would be a raw constraint name.
--   * The condition reads another table (the delivery's costed value) and asks
--     shop_has_module. A CHECK may do neither.
--
-- The messages are written to be read by a shopkeeper, because they surface
-- verbatim: invoice-editor-modal.tsx's extractErrorMessage passes any message it
-- does not recognise straight through to the form.
create or replace function public.guard_invoice_delivery_link() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_receipt_shop uuid;
  v_value_cents  bigint;
begin
  -- The UPDATE arm. Reached only through the WHEN clause on the second trigger
  -- below, so an ordinary edit -- amount, dates, category, vendor -- never comes
  -- here and record_invoice_payment's paid_cents update never does either.
  if tg_op = 'UPDATE' then
    raise exception 'Which delivery a bill pays for is fixed when the bill is entered and cannot be changed afterwards. Delete this bill and enter it again against the right delivery -- that takes its cost and any payments off your books together.'
      using errcode = 'P0001';
  end if;

  if new.stock_receipt_id is null then
    -- shop_has_module FIRST. A shop without `inventory` cannot record a delivery
    -- at all, so demanding one would refuse a bill it has no way to satisfy.
    if new.category = 'inventory_purchase' and public.shop_has_module(new.shop_id, 'inventory') then
      raise exception 'A stock purchase has to say which delivery it pays for, so your stock and your books agree about the same goods. Receive the delivery in Inventory first and then enter this bill against it -- or, if this bill is not for goods, change what it is for.'
        using errcode = 'P0001';
    end if;
    return new;
  end if;

  -- Scoped to the bill's own shop. This function is SECURITY DEFINER, so
  -- without the shop test a caller who guessed a uuid could name another
  -- tenant's delivery and read back, through the error messages below, whether
  -- it exists and whether it was costed.
  select r.shop_id,
         coalesce((select sum(ri.unit_cost_cents::bigint * ri.quantity)
                     from public.stock_receipt_items ri
                    where ri.receipt_id = r.id and ri.unit_cost_cents is not null), 0)
    into v_receipt_shop, v_value_cents
    from public.stock_receipts r
   where r.id = new.stock_receipt_id;

  if v_receipt_shop is distinct from new.shop_id then
    raise exception 'That delivery does not belong to this shop.' using errcode = 'P0001';
  end if;

  -- AN UNCOSTED DELIVERY NEVER REACHED THE BOOKS, so there is no payable for
  -- this bill to be settling and linking to it would recreate the exact defect
  -- this migration closes -- nothing credits 2000, and paying the bill drives it
  -- into debit -- through the new column instead of the old category.
  --
  -- The predicate is the delivery's costed value being non-zero, which is
  -- character for character what unposted_ledger_source_rows' receipt arm and
  -- backfill_shop_ledger's receipt statement both use to decide whether a
  -- delivery is an accounting event at all. Three copies of one question would
  -- be two too many; this is the same question asked at the door.
  if v_value_cents = 0 then
    raise exception 'That delivery was received without any costs on it, so nothing was ever recorded as owed for it and this bill would have nothing to settle. Receive it again with what it cost, and enter this bill against that one.'
      using errcode = 'P0001';
  end if;

  return new;
end;
$$;

comment on function public.guard_invoice_delivery_link() is
  'BEFORE INSERT and BEFORE UPDATE on invoices. On insert: an inventory_purchase bill must name a delivery (unless the shop has no inventory module and therefore no way to record one), the delivery must belong to the same shop, and it must have been costed -- an uncosted delivery raised no payable for the bill to settle. On update: refuses any change to stock_receipt_id, because what a bill posts is decided when it is entered and a link that moved afterwards would make the live entry and the replay disagree about the same row.';

drop trigger if exists invoices_guard_delivery_link on public.invoices;
create trigger invoices_guard_delivery_link
  before insert on public.invoices
  for each row execute function public.guard_invoice_delivery_link();

-- WHEN, so an ordinary edit does not pay for this at all -- and so that
-- record_invoice_payment's `update invoices set paid_cents = ...`, which runs on
-- every supplier payment, never enters the function.
drop trigger if exists invoices_delivery_link_is_final on public.invoices;
create trigger invoices_delivery_link_is_final
  before update on public.invoices
  for each row when (old.stock_receipt_id is distinct from new.stock_receipt_id)
  execute function public.guard_invoice_delivery_link();

-- ---------------------------------------------------------------------------
-- 3. What the picker offers
-- ---------------------------------------------------------------------------
--
-- Deliveries that are not already on a bill, newest first, with the two figures
-- the person choosing needs: how many lines arrived and what the delivery was
-- worth. UNCOSTED DELIVERIES ARE RETURNED, at value 0, rather than filtered out
-- -- a shopkeeper looking for their delivery and not finding it concludes the
-- picker is broken, where a row that is present and refuses to be chosen
-- explains itself. The guard above is what refuses it; this only reports.
--
-- SECURITY DEFINER with an explicit permission check, matching
-- unposted_ledger_counts: the `not exists` against `invoices` has to see EVERY
-- bill to be true, and under invoker rights a reader whose RLS hid one bill
-- would be offered a delivery that is already on it.
create or replace function public.unbilled_stock_receipts(p_shop_id uuid, p_limit integer default 25)
returns table (id uuid, received_at timestamptz, supplier_name text, reference text,
               location_id uuid, item_count bigint, value_cents bigint)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.has_shop_permission(p_shop_id, 'invoices.manage') then
    raise exception 'Choosing the delivery a bill pays for needs invoices.manage.' using errcode = 'P0001';
  end if;

  return query
  select r.id, r.created_at, r.supplier_name, r.reference, r.location_id,
         (select count(*) from public.stock_receipt_items ri where ri.receipt_id = r.id)::bigint,
         coalesce((select sum(ri.unit_cost_cents::bigint * ri.quantity)
                     from public.stock_receipt_items ri
                    where ri.receipt_id = r.id and ri.unit_cost_cents is not null), 0)::bigint
    from public.stock_receipts r
   where r.shop_id = p_shop_id
     and not exists (select 1 from public.invoices bill where bill.stock_receipt_id = r.id)
   order by r.created_at desc
   limit greatest(coalesce(p_limit, 25), 0);
end;
$$;

comment on function public.unbilled_stock_receipts(uuid, integer) is
  'Deliveries this shop has received that are not yet on a bill, newest first, with their line count and costed value. Uncosted deliveries are returned at value 0 rather than hidden -- guard_invoice_delivery_link refuses to link one and says why, which is more useful than a delivery that is simply missing from the list. Gates on invoices.manage.';

grant execute on function public.unbilled_stock_receipts(uuid, integer) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. The branch, keyed on the link
-- ---------------------------------------------------------------------------
--
-- Reproduced in full from 20260908000800 with ONE addition: the invoice arm now
-- asks the bill whether it names a delivery, and answers that question BEFORE it
-- looks at the category.
--
--   payroll_run_id set   -> nothing   (post_payroll_run posted its own entry)
--   journal_entry_id set -> nothing   (already posted; the backfill sets this)
--   stock_count_id set   -> nothing   (save_stock_count posted both sides)
--   invoice_id, bill names a delivery -> nothing (receive_stock recognised it)
--   invoice_id, no delivery, inventory_purchase -> nothing (ADMITTED GAP)
--   invoice_id, no delivery, anything else      -> Dr the category's account / Cr 2000
--   stock_receipt_id set -> Dr 2000 / Cr wallet
--   standalone stock_loss        -> Dr 5100 / Cr 1200
--   standalone anything else     -> Dr the category's account / Cr wallet
--
-- THE ORDER OF THE TWO INVOICE ARMS IS THE WHOLE CHANGE. Asking about the link
-- first is what closes the over-stated direction: a bill for goods mis-tapped as
-- `supplies` and linked to its delivery now posts nothing, where before it posted
-- Dr 6400 / Cr 2000 on top of the delivery's own credit and doubled the payable.
-- The category arm survives only as a residual for rows the link cannot describe,
-- and it no longer claims that a delivery recognised anything.
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
  -- Which delivery the BILL behind this row names, if any. Read from `invoices`
  -- rather than carried on the expense row, because expenses_one_source_link
  -- (20260908000800) permits at most one of the four link columns and this row
  -- already carries invoice_id -- and because expenses.stock_receipt_id means
  -- something else entirely here (a delivery PAID, Dr 2000 / Cr wallet).
  v_bill_receipt uuid;
begin
  -- See the exclusion block in 20260908000750. Do not remove these without
  -- reading it; post_payroll_run is named there by name. The invoice_id
  -- exclusion that used to stand alongside them has been REMOVED -- see the
  -- correction in 20260908000800; it recognised nothing.
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
    select i.stock_receipt_id into v_bill_receipt
      from public.invoices i where i.id = new.invoice_id;

    -- THE DELIVERY ALREADY DID THIS. receive_stock posted Dr 1200 / Cr 2000 for
    -- these goods, so the payable exists and record_invoice_payment's Dr 2000
    -- clears it. Posting here would debit 1200 and credit 2000 a SECOND time:
    -- stock overstated by the whole delivery and a phantom payable beside the
    -- real one.
    --
    -- ASKED BEFORE THE CATEGORY, deliberately -- see the note above this
    -- function. Whatever the shopkeeper tapped, a bill that names a delivery is
    -- for that delivery.
    if v_bill_receipt is not null then return null; end if;

    -- ...AND A GOODS BILL THAT NAMES NO DELIVERY POSTS NOTHING, AS AN ADMITTED
    -- GAP RATHER THAN AS A CLAIM. guard_invoice_delivery_link refuses to create
    -- one, so only rows entered before that door existed reach this line. There
    -- is no honest entry for them: debiting 1200 would double a delivery that
    -- WAS recorded, or invent stock for one that was not, and either way the
    -- ledger's inventory value would stop matching the quantity on the shelf.
    -- Nothing is lost from the P&L that was not already lost -- 1200 is an
    -- asset, and its cost reaches the P&L as COGS when the goods sell.
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
  'AFTER INSERT and AFTER UPDATE on expenses. Posts nothing for a row carrying payroll_run_id, stock_count_id or an existing journal_entry_id -- something else already posted that event. A row carrying invoice_id asks the BILL whether it names a delivery: if it does, nothing is posted, because receive_stock already debited 1200 against 2000 for those goods and record_invoice_payment''s Dr 2000 clears it -- and that is asked BEFORE the category, so a goods bill mis-tapped as supplies no longer doubles the payable. A goods bill naming no delivery also posts nothing, as an admitted gap: guard_invoice_delivery_link refuses to create one, so only rows predating that door reach it. Every other bill posts Dr the category''s account / Cr 2000. A row carrying stock_receipt_id posts Dr 2000 / Cr the wallet, settling the payable receive_stock raised. A standalone stock_loss posts Dr 5100 / Cr 1200. Everything else posts Dr the category''s account / Cr the payment method''s wallet.';

-- Unchanged from 20260908000800, restated because the function was replaced and
-- a reader of this file should not have to open the last one to learn where the
-- trigger is. Row-level, so an insert of several expenses at once posts one
-- entry each.
drop trigger if exists expenses_post_to_ledger on public.expenses;
create trigger expenses_post_to_ledger
  after insert on public.expenses
  for each row execute function public.post_expense_to_ledger();

-- CARRIED FORWARD, and 20260908001000 says at the trigger that it must be: a
-- migration that re-creates post_expense_to_ledger and leaves this behind gives
-- a shop an edited expense that reverses and never re-posts. The WHEN clause is
-- character for character the one on expenses_reverse_on_edit -- if the two ever
-- diverge, one half of reverse-and-re-post fires without the other.
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

-- ---------------------------------------------------------------------------
-- 5. The door and the replay must not disagree about what a run will write
-- ---------------------------------------------------------------------------
--
-- unposted_ledger_source_rows (20260908001300, itself 20260908001100's eight
-- arms moved one layer down) is what the Post History card counts; the statement
-- in backfill_shop_ledger below is what the replay actually writes. They carry
-- the same predicates on purpose, and verify-backfill.sql pins them against each
-- other in both directions.
--
-- Reproduced in full, arms and comments together, because a copy-forward that
-- keeps the SQL and drops the reasoning leaves the next reader with eight
-- clauses that look like they could be simplified. ONE arm changes -- the last.
--
-- unposted_inventory_movement and opening_inventory_gap read this view rather
-- than the base tables, so they inherit the new exclusion and need no edit. That
-- is what the layer was split out for, and it is why an extra clause here is not
-- a fifth copy of anything.
create or replace view public.unposted_ledger_source_rows
with (security_invoker = true) as

  -- Sales. The money predicate is the exact disjunction of the six line groups
  -- backfill_shop_ledger builds, copied from it -- a false negative here would
  -- under-report a sale that really does carry money, and a false positive
  -- would promise an entry the replay will not write.
  select s.shop_id,
         'sale'::text as source_kind,
         s.id         as source_id,
         public.shop_local_date(s.created_at) as on_date
    from public.sales s
   where s.journal_entry_id is null
     and (coalesce(s.tax_cents, 0) <> 0
          or coalesce(s.discount_cents, 0) <> 0
          or coalesce(s.points_redeemed_cents, 0) <> 0
          or s.total_cents <> coalesce((select sum(sp.amount_cents)
                                          from public.sale_payments sp
                                         where sp.sale_id = s.id and not sp.is_settlement), 0)
          or exists (select 1 from public.sale_payments sp
                      where sp.sale_id = s.id and not sp.is_settlement and sp.amount_cents <> 0)
          or coalesce((select sum(si.unit_price_cents::bigint * si.quantity)
                         from public.sale_items si where si.sale_id = s.id), 0) <> 0
          or coalesce((select sum(si.discount_cents)
                         from public.sale_items si where si.sale_id = s.id), 0) <> 0
          or coalesce((select sum(si.unit_cost_cents::bigint * si.quantity)
                         from public.sale_items si
                        where si.sale_id = s.id and si.unit_cost_cents is not null), 0) <> 0)

  union all

  -- Refunds. No shop_id of their own -- tenancy comes through the sale.
  select s.shop_id, 'refund'::text, r.id, public.shop_local_date(r.created_at)
    from public.refunds r
    join public.sales s on s.id = r.sale_id
   where r.journal_entry_id is null
     and (r.goods_cents <> 0 or r.total_cents <> 0
          or exists (select 1 from public.refund_items ri
                       join public.sale_items si on si.id = ri.sale_item_id
                      where ri.refund_id = r.id and si.unit_cost_cents is not null))

  union all

  -- Settlements. is_settlement IS THE FILTER. A sale's own tenders are folded
  -- into the sale's entry and keep a null pointer for ever.
  select s.shop_id, 'settlement'::text, sp.id, public.shop_local_date(sp.created_at)
    from public.sale_payments sp
    join public.sales s on s.id = sp.sale_id
   where sp.is_settlement
     and sp.journal_entry_id is null
     and sp.amount_cents <> 0

  union all

  -- Stock receipts, at the delivery's costed value. An uncosted line is
  -- excluded rather than zeroed.
  select r.shop_id, 'receipt'::text, r.id, public.shop_local_date(r.created_at)
    from public.stock_receipts r
   where r.journal_entry_id is null
     and coalesce((select sum(ri.unit_cost_cents::bigint * ri.quantity)
                     from public.stock_receipt_items ri
                    where ri.receipt_id = r.id and ri.unit_cost_cents is not null), 0) <> 0

  union all

  -- Stock counts, at the net variance. A count that found what it expected is
  -- not an accounting event.
  select c.shop_id, 'count'::text, c.id, public.shop_local_date(c.created_at)
    from public.stock_counts c
   where c.journal_entry_id is null
     and coalesce((select sum(ci.unit_cost_cents::bigint * (ci.counted_quantity - ci.previous_quantity))
                     from public.stock_count_items ci
                    where ci.count_id = c.id and ci.unit_cost_cents is not null), 0) <> 0

  union all

  -- Supplier payments. No shop_id -- tenancy comes through the invoice. Dated
  -- paid_on, which is already a date. (20260908001600 later denormalises a
  -- shop_id onto this table for a cascade guard. The join stays: that column is
  -- maintained by a trigger for a delete-time question, and reading tenancy off
  -- the invoice is what makes the view's answer the invoice's answer.)
  select i.shop_id, 'invoice_payment'::text, ip.id, ip.paid_on
    from public.invoice_payments ip
    join public.invoices i on i.id = ip.invoice_id
   where ip.journal_entry_id is null and ip.amount_cents <> 0

  union all

  -- Pay runs. Posted only: a draft has paid nobody, and a run returned to draft
  -- had its pointer cleared on purpose.
  select r.shop_id, 'payroll'::text, r.id,
         public.shop_local_date(coalesce(r.posted_at, r.period_end::timestamptz))
    from public.payroll_runs r
   where r.journal_entry_id is null
     and r.status = 'posted' and r.total_cents > 0

  union all

  -- Expenses, with the exclusions the replay carries. Three of them -- rows from
  -- a stock count, goods bills that name no delivery, and bills that DO name one
  -- -- leave a row unposted for ever by design, and verify-backfill.sql check 5
  -- exempts them for that reason. They must be excluded HERE too or the door
  -- promises entries the replay will never write.
  --
  -- THE DELIVERY TEST IS NEW AND IT IS TESTED ALONGSIDE THE CATEGORY, not
  -- instead of it, because the two exclude different rows. A bill that names a
  -- delivery is excluded WHATEVER its category -- that is the over-stated
  -- direction closing, and it is why the live branch asks about the link first.
  -- A goods bill that names none is excluded because there is no honest entry
  -- for it; guard_invoice_delivery_link stops new ones being made, and the rows
  -- that reach here predate that door.
  select e.shop_id, 'expense'::text, e.id, e.occurred_on
    from public.expenses e
   where e.journal_entry_id is null
     and e.payroll_run_id is null
     and e.stock_count_id is null
     and not (e.invoice_id is not null
              and (e.category = 'inventory_purchase'
                   or exists (select 1 from public.invoices bi
                               where bi.id = e.invoice_id
                                 and bi.stock_receipt_id is not null)))
     and e.amount_cents <> 0;

comment on view public.unposted_ledger_source_rows is
  'The eight kinds of source row backfill_shop_ledger replays, with the same per-kind predicates and the same date expressions. Not the whole of what a run writes -- unposted_ledger_sources is this plus the opening balance, and that is what the Post History door reads. This layer exists so the opening arm can read the other eight without a view referencing itself.';

revoke all on public.unposted_ledger_source_rows from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 6. The replay, carrying the identical clause
-- ---------------------------------------------------------------------------
--
-- Reproduced in full from 20260908001300 -- NOT from 20260908000700, which
-- would delete the opening balance. One statement changes: step 1's expenses
-- filter, which grows the same delivery test the view above just grew.
--
-- NO EXISTING ROW CARRIES A LINK on the day this ships, so the replay writes
-- exactly what it wrote yesterday for every row that exists. The new arm can
-- only affect rows created after it, and the guard means those are correct by
-- construction. Nothing is re-posted and no history moves.

create or replace function public.backfill_shop_ledger(p_shop_id uuid)
returns integer
language plpgsql security definer set search_path = public as $$
declare
  v_year    text;
  v_count   integer;
  v_first   integer;
  v_written integer := 0;
  v_bad     text;
  -- Step 6b. The opening balance has no source row, so it carries its own id,
  -- its own date and its own amount rather than a _bf_map entry.
  v_open_id    uuid;
  v_open_date  date;
  v_open_cents bigint;
begin
  -- ledger.close, not ledger.post. Rewriting a shop's entire history is the
  -- heaviest thing anyone can do to these books -- heavier than posting one
  -- entry -- and only the Owner role carries it.
  if not public.has_shop_permission(p_shop_id, 'ledger.close') then
    raise exception 'Backfilling the ledger needs ledger.close.' using errcode = 'P0001';
  end if;

  -- ── Serialised per shop, and this is not belt-and-braces ─────────────────
  --
  -- The idempotency argument in this file's header ("driven entirely by
  -- journal_entry_id being null") is a statement about two runs SEPARATED IN
  -- TIME. It says nothing about two runs overlapping, and under READ COMMITTED
  -- two overlapping runs both work:
  --
  --   A snapshots every unposted row into its own _bf_map and starts writing.
  --   B, a moment later, snapshots THE SAME ROWS -- A has committed nothing --
  --   and builds a second complete set of entries with its own ids.
  --   B then blocks on A's row locks at the back-links in step 5, and when A
  --   commits, B RE-EVALUATES its WHERE against the new row versions. Before
  --   this change that WHERE did not mention journal_entry_id at all, so B's
  --   update matched anyway and OVERWROTE A's pointer.
  --
  -- The result is two complete sets of entries; every source row points at B's;
  -- A's are orphaned but posted; and every account in the shop reads double,
  -- with the trial balance still at zero because both sets individually
  -- balance. Nothing in the verification would catch it, because both runs
  -- return a positive count and the ledger self-consistently ties.
  --
  -- Two things close it, and both are wanted. The re-check on each back-link
  -- (`and <table>.journal_entry_id is null`, step 5) makes B's update a no-op
  -- rather than a clobber. This lock stops B from writing the entries at all,
  -- which is what keeps the ledger free of a set of orphans nobody can explain.
  -- Rewriting a shop's whole history is far heavier than posting one pay run,
  -- and post_payroll_run takes exactly this lock for a far smaller race.
  --
  -- IT ALSO COVERS STEP 6b, which needs it at least as much: the opening
  -- balance is derived from what the ledger holds against 1200, so two
  -- overlapping runs reading that sum before either had written would each
  -- compute the same gap and each post it.
  --
  -- Transaction-scoped, so it releases on commit or rollback with nothing to
  -- unlock explicitly. Keyed on the shop, so backfilling one shop never blocks
  -- another. classid 74921, registered in post_payroll_run's ADVISORY LOCK
  -- CLASSID REGISTRY (20260908000500) -- Postgres has one global advisory
  -- keyspace and a collision would make two unrelated features block each other.
  perform pg_advisory_xact_lock(74921, hashtext(p_shop_id::text));

  -- The map from source row to the entry it will get, carried across the three
  -- statements that need it (entries, back-links, lines). The entry id is
  -- generated HERE rather than taken from a RETURNING clause, because
  -- INSERT ... RETURNING cannot return a column it did not insert and the lines
  -- have to be joined back to their source row.
  --
  -- ON COMMIT DROP, so a second call in a later transaction starts clean and a
  -- failed call leaves nothing behind.
  --
  -- DROPPED FIRST, and explicitly qualified. pg_temp is searched BEFORE
  -- search_path whether or not it is listed, so a caller with a raw session
  -- could pre-create their own _bf_map -- carrying a trigger, or a rule -- and
  -- this SECURITY DEFINER function would write to it and fire that trigger as
  -- the definer. Not reachable through PostgREST, which gives no session to
  -- prepare, so this is defence in depth; it is also the only temp table in the
  -- migration set, so it is the only place the question arises. Dropping also
  -- removes the `_bf_map already exists, skipping` notice a second call in the
  -- same transaction used to print.
  -- to_regclass rather than `drop table if exists`, only so the first call in a
  -- session does not print `schema "pg_temp" does not exist, skipping` -- the
  -- temp schema is created lazily by the CREATE below.
  if to_regclass('pg_temp._bf_map') is not null then
    execute 'drop table pg_temp._bf_map';
  end if;
  create temporary table _bf_map (
    source_kind text,
    source_id   uuid,
    entry_id    uuid,
    on_date     date,
    location_id uuid,
    description text,
    source      text,
    reference   text
  ) on commit drop;

  -- ── 1. Every unposted row, of every kind ────────────────────────────────

  -- Sales. Dated the shop's local date of created_at, matching complete_sale.
  --
  -- ...AND FILTERED TO SALES THAT CARRY MONEY, which every other kind below has
  -- always been and this one was not. A zero-value sale is legal and reachable:
  -- p_allow_balance (20260831000100) lets a sale be left on account, and a
  -- basket of free samples priced at 0 against a named customer is exactly that
  -- -- item_count > 0, so complete_sale's own guard passes, and total_cents = 0.
  -- Such a sale produces no journal line at all (every amount below is zero and
  -- `amount_cents <> 0` throws them away), leaving a referenced entry with
  -- nothing under it -- and step 7 then aborts THE WHOLE SHOP'S REPLAY with
  -- "could not build a complete entry", over one giveaway from two years ago.
  --
  -- The predicate is the exact disjunction of the six line groups built in step
  -- 6, not a proxy for them, because a false negative here would silently skip a
  -- sale that does carry money:
  --   * a non-settlement payment      -> the tender debits
  --   * total_cents <> what the till took -> the 1100 receivable
  --   * order discount / points / line discount -> the 4200 contra
  --   * list price (unit_price * qty) -> the 4000 credit
  --   * tax_cents                     -> the 2100 credit
  --   * frozen cost                   -> the 5000/1200 pair
  -- At least one non-zero line means at least two, because the six groups are
  -- balanced by construction -- so this is also exactly the condition step 7's
  -- two-line guard tests for.
  --
  -- The same defect exists on the LIVE path and is fixed there too:
  -- complete_sale now skips post_journal_entry entirely when v_lines is empty
  -- (20260908000300), where before it failed the sale at the till with
  -- "A journal entry needs at least two lines; this one has 0."
  insert into _bf_map (source_kind, source_id, entry_id, on_date, location_id, description, source)
  select 'sale', s.id, gen_random_uuid(), public.shop_local_date(s.created_at),
         s.location_id, 'Sale ' || s.id::text, 'sale'
    from public.sales s
   where s.shop_id = p_shop_id and s.journal_entry_id is null
     and (coalesce(s.tax_cents, 0) <> 0
          or coalesce(s.discount_cents, 0) <> 0
          or coalesce(s.points_redeemed_cents, 0) <> 0
          or s.total_cents <> coalesce((select sum(sp.amount_cents)
                                          from public.sale_payments sp
                                         where sp.sale_id = s.id and not sp.is_settlement), 0)
          or exists (select 1 from public.sale_payments sp
                      where sp.sale_id = s.id and not sp.is_settlement and sp.amount_cents <> 0)
          or coalesce((select sum(si.unit_price_cents::bigint * si.quantity)
                         from public.sale_items si where si.sale_id = s.id), 0) <> 0
          or coalesce((select sum(si.discount_cents)
                         from public.sale_items si where si.sale_id = s.id), 0) <> 0
          or coalesce((select sum(si.unit_cost_cents::bigint * si.quantity)
                         from public.sale_items si
                        where si.sale_id = s.id and si.unit_cost_cents is not null), 0) <> 0);

  -- Refunds. refunds has NO shop_id column -- the tenancy comes through the
  -- sale, and so does the location, which is what refund_sale_items stamps.
  insert into _bf_map (source_kind, source_id, entry_id, on_date, location_id, description, source)
  select 'refund', r.id, gen_random_uuid(), public.shop_local_date(r.created_at),
         s.location_id, 'Refund ' || r.id::text || ' on sale ' || s.id::text, 'refund'
    from public.refunds r
    join public.sales s on s.id = r.sale_id
   where s.shop_id = p_shop_id and r.journal_entry_id is null
     and (r.goods_cents <> 0 or r.total_cents <> 0
          or exists (select 1 from public.refund_items ri
                       join public.sale_items si on si.id = ri.sale_item_id
                      where ri.refund_id = r.id and si.unit_cost_cents is not null));

  -- Settlements. `is_settlement` IS THE FILTER, not journal_entry_id alone.
  -- complete_sale folds a sale's initial payments into the sale's own entry and
  -- leaves those rows' journal_entry_id null forever, so driving off the column
  -- by itself would post a second entry for every till payment ever taken.
  --
  -- The location is the SETTLING till's, not the sale's: the money is handed
  -- over days later at whatever till is open, which may be another branch.
  -- 20260908000360 makes exactly this fix on the live path.
  insert into _bf_map (source_kind, source_id, entry_id, on_date, location_id, description, source)
  select 'settlement', sp.id, gen_random_uuid(), public.shop_local_date(sp.created_at),
         coalesce(rs.location_id, s.location_id),
         'Balance settled on sale ' || s.id::text, 'settlement'
    from public.sale_payments sp
    join public.sales s on s.id = sp.sale_id
    left join public.register_sessions rs on rs.id = sp.register_session_id
   where s.shop_id = p_shop_id
     and sp.is_settlement
     and sp.journal_entry_id is null
     and sp.amount_cents <> 0;

  -- Stock receipts, at the delivery's costed value. An uncosted line is
  -- excluded, not zeroed -- the delivery's value is unknown, and posting 0
  -- would understate stock by exactly what nobody wrote down.
  insert into _bf_map (source_kind, source_id, entry_id, on_date, location_id, description, source)
  select 'receipt', r.id, gen_random_uuid(), public.shop_local_date(r.created_at),
         r.location_id, 'Stock received', 'stock'
    from public.stock_receipts r
   where r.shop_id = p_shop_id and r.journal_entry_id is null
     and coalesce((select sum(ri.unit_cost_cents::bigint * ri.quantity)
                     from public.stock_receipt_items ri
                    where ri.receipt_id = r.id and ri.unit_cost_cents is not null), 0) <> 0;

  -- Stock counts, at the net variance. Exactly zero posts nothing: a count that
  -- found what it expected is not an accounting event.
  insert into _bf_map (source_kind, source_id, entry_id, on_date, location_id, description, source)
  select 'count', c.id, gen_random_uuid(), public.shop_local_date(c.created_at),
         c.location_id, 'Stock count variance', 'count'
    from public.stock_counts c
   where c.shop_id = p_shop_id and c.journal_entry_id is null
     and coalesce((select sum(ci.unit_cost_cents::bigint * (ci.counted_quantity - ci.previous_quantity))
                     from public.stock_count_items ci
                    where ci.count_id = c.id and ci.unit_cost_cents is not null), 0) <> 0;

  -- Supplier payments. invoice_payments has NO shop_id -- the tenancy and the
  -- store both come through the invoice. Dated paid_on, which is already a
  -- date: the ledger and the bill's payment history cannot then disagree about
  -- when the money moved.
  insert into _bf_map (source_kind, source_id, entry_id, on_date, location_id, description, source)
  select 'invoice_payment', ip.id, gen_random_uuid(), ip.paid_on,
         i.location_id, 'Supplier paid', 'payment'
    from public.invoice_payments ip
    join public.invoices i on i.id = ip.invoice_id
   where i.shop_id = p_shop_id and ip.journal_entry_id is null and ip.amount_cents <> 0;

  -- Pay runs. POSTED runs only: a draft has not paid anybody, and
  -- unpost_payroll_run clears journal_entry_id when it returns a run to draft,
  -- so a run that was posted and then unposted would otherwise be replayed as
  -- though it had never been undone -- re-recognising wages the shop reversed
  -- on purpose, and orphaning the reversal entry that explains why.
  --
  -- payroll_runs has NO paid_on column. See this file's header for why the date
  -- is shop_local_date(posted_at) and not period_end.
  insert into _bf_map (source_kind, source_id, entry_id, on_date, location_id, description, source)
  select 'payroll', r.id, gen_random_uuid(),
         public.shop_local_date(coalesce(r.posted_at, r.period_end::timestamptz)),
         r.location_id, 'Payroll', 'payroll'
    from public.payroll_runs r
   where r.shop_id = p_shop_id and r.journal_entry_id is null
     and r.status = 'posted' and r.total_cents > 0;

  -- Expenses. THE EXCLUSIONS, copied from post_expense_to_ledger() for its
  -- reasons -- see 1 in this file's header, and the exclusion blocks in
  -- 20260908000750 (which names post_payroll_run by name) and 20260908000800.
  --
  -- stock_count_id: save_stock_count posts Dr 5100 / Cr 1200 for the whole
  -- variance itself and nothing was paid, so a count's stock_loss expense row
  -- has no entry of its own. With the inventory_purchase half of the invoice
  -- clause below, it is one of the two exclusions here that leave a row
  -- permanently unposted by design -- verify-backfill.sql check 5 exempts both
  -- for that reason.
  --
  -- INVOICE-LINKED ROWS ARE NO LONGER EXCLUDED WHOLESALE, and that is the
  -- correction this replay carries alongside 20260908000800's. The old filter
  -- said `e.invoice_id is null` on the strength of "the bill recognised the
  -- cost" -- and no migration on this branch posts anything when an invoice is
  -- inserted, so nothing recognised it and the mirror row being skipped WAS the
  -- recognition. Replayed history reproduced the live defect exactly: a bill
  -- posted nothing, its payment posted Dr 2000, and Accounts Payable went
  -- negative by every non-stock bill the shop had ever entered.
  --
  -- inventory_purchase stays out, for the reason 20260908000800 gives at
  -- length: the delivery already debited 1200 against 2000, and pairing a bill
  -- with a receipt is the app's own unpaid-delivery flow rather than a
  -- double-entry a shop should have avoided. 20260908001900 narrows what that
  -- sentence CLAIMS -- it is an admitted gap for rows entered before a goods
  -- bill had to name its delivery, not a statement that one did -- and adds the
  -- clause beside it: A BILL THAT NAMES A DELIVERY IS EXCLUDED WHATEVER ITS
  -- CATEGORY. That is the over-stated direction closing. A bill for goods
  -- mis-tapped as `supplies` used to be replayed as Dr 6400 / Cr 2000 on top of
  -- the delivery's own Dr 1200 / Cr 2000, doubling the payable, and the category
  -- test could not see it because the category was what was wrong. The live
  -- branch in post_expense_to_ledger asks the same question in the same order.
  --
  -- FORWARD REFERENCE, AND IT IS SAFE. stock_count_id and stock_receipt_id are
  -- added by 20260908000800, which applies AFTER 20260908000700 where this
  -- statement was first written. A plpgsql body is only syntax-checked at
  -- CREATE time -- table and column names are resolved when the statement first
  -- executes -- and backfill_shop_ledger is never called during a migration
  -- run. (By this file both columns exist anyway; the note is kept because the
  -- reasoning is what makes the ordering safe rather than lucky.)
  --
  -- log_recurring_bill's rows set NONE of the four and are deliberately
  -- included: nothing else posts for them, and they are real costs the shop
  -- incurred.
  --
  -- occurred_on, not created_at: a receipt is often logged days after the
  -- purchase and it is the purchase that decides the period. For a bill's
  -- mirror row that is issued_on, which sync_invoice_expense copies across --
  -- a bill dated last month is last month's cost however late it is entered.
  insert into _bf_map (source_kind, source_id, entry_id, on_date, location_id, description, source)
  select 'expense', e.id, gen_random_uuid(), e.occurred_on,
         e.location_id, 'Expense ' || e.id::text, 'bill'
    from public.expenses e
   where e.shop_id = p_shop_id
     and e.journal_entry_id is null
     and e.payroll_run_id is null
     and e.stock_count_id is null
     and not (e.invoice_id is not null
              and (e.category = 'inventory_purchase'
                   or exists (select 1 from public.invoices bi
                               where bi.id = e.invoice_id
                                 and bi.stock_receipt_id is not null)))
     and e.amount_cents <> 0;

  select count(*) into v_written from _bf_map;

  -- NO EARLY RETURN HERE, AND THE `if v_written = 0 then return 0` THAT USED TO
  -- BE IS THE BUG THIS MIGRATION FIXES HALF OF.
  --
  -- It was only ever an optimisation: every statement from here to step 7
  -- reads _bf_map, so all of them are natural no-ops when it is empty. What it
  -- cost was step 6b, which does NOT read _bf_map -- and a shop whose only
  -- remaining work is its opening balance is not a hypothetical. It is
  -- yusefshop: already backfilled, nothing left unposted, 1200 sitting in
  -- credit $1,100, and an owner who presses the button again and is told
  -- "nothing needed posting" for ever.
  --
  -- The cost of removing it is a dozen statements that match no rows, once, on
  -- a door that is pressed by hand.

  -- ── 2. Every MISSING period the replay needs, created OPEN ──────────────
  --
  -- This is the statement that makes a closed month survivable. Doing it per
  -- row through open_period_for is what would abort the replay half-way.
  --
  -- READ THE CONFLICT CLAUSE BEFORE BELIEVING THE HEADING. This creates the
  -- months that DO NOT EXIST, open. A month that already exists is left exactly
  -- as it is -- and then receives entries anyway, because step 4 inserts
  -- journal_entries directly and never consults open_period_for. A closed month
  -- is NOT re-opened. A LOCKED month -- documented at 20260904000200 as "nothing
  -- posts, ever. Manual, deliberate, final" -- is not re-opened either, and is
  -- posted into all the same, with no closed_at change and no audit row.
  --
  -- That is deliberate and is not being revisited: a per-row gate is precisely
  -- what would leave a shop with half a ledger and no way to finish. What it is
  -- not is invisible. public.unposted_ledger_period_exposure (20260908001100)
  -- counts the shut months a replay would write into, off the same view the
  -- counts come from, and the Post History card names them before the button is
  -- pressed. If you change the semantics here, that function and the copy on
  -- backfill-view.tsx are what stop being true.
  insert into public.accounting_periods (shop_id, starts_on, ends_on)
  select distinct p_shop_id,
         date_trunc('month', m.on_date)::date,
         (date_trunc('month', m.on_date) + interval '1 month - 1 day')::date
    from _bf_map m
  on conflict (shop_id, starts_on) do nothing;

  -- ...and a check that every date is actually covered, because the insert
  -- above is `on conflict (shop_id, starts_on) do nothing` and the conflict
  -- target is starts_on ALONE. A period that already exists for the 1st of a
  -- month with a SHORTER ends_on -- a half-month period from a partial close,
  -- anything not month-shaped -- swallows the insert and leaves no row covering
  -- the back half of that month. journal_entries.period_id is NOT NULL, so the
  -- entry insert in step 4 would then abort with a null-violation naming a
  -- column, which says nothing about periods to whoever has to fix it.
  select string_agg(distinct to_char(m.on_date, 'YYYY-MM-DD'), ', ' order by to_char(m.on_date, 'YYYY-MM-DD'))
    into v_bad
    from _bf_map m
   where not exists (select 1 from public.accounting_periods ap
                      where ap.shop_id = p_shop_id
                        and m.on_date between ap.starts_on and ap.ends_on);
  if v_bad is not null then
    raise exception 'No accounting period covers: %. A period already starts on the 1st of that month but ends before the month does, so the backfill could not create one. Extend or remove that period and run again.', v_bad
      using errcode = 'P0001';
  end if;

  -- ── 3. References, from journal_entry_sequences ─────────────────────────
  --
  -- One reservation per YEAR, not per entry. The upsert takes a row lock on the
  -- counter, so a sale being rung up concurrently blocks here rather than
  -- reading a number this run has already taken.
  for v_year in select distinct to_char(m.on_date, 'YYYY') from _bf_map m order by 1 loop
    select count(*) into v_count from _bf_map m where to_char(m.on_date, 'YYYY') = v_year;

    insert into public.journal_entry_sequences (shop_id, year, next_number)
      values (p_shop_id, v_year, v_count + 1)
      on conflict (shop_id, year) do update
        set next_number = public.journal_entry_sequences.next_number + v_count
      returning next_number - v_count into v_first;

    -- Numbered by date within the year, so the journal reads in the order the
    -- shop actually traded. (kind, id) is the tiebreaker and the key: an id is
    -- unique within a table but two tables can hand out the same uuid in
    -- principle, and the pair is what _bf_map is keyed on everywhere else.
    -- journal_entry_reference, not an inline lpad: 20260908000150 owns the
    -- format, and lpad(n, 4, '0') TRUNCATES past 9999 -- 'JE-2026-1000' for
    -- entry 10000, colliding with entry 1000 on
    -- journal_entries_shop_id_reference_key. A backfill is precisely where a
    -- shop crosses 9999 for the first time, because it writes a year of history
    -- in one statement.
    update _bf_map m
       set reference = public.journal_entry_reference(v_year, (v_first + n.rn - 1)::integer)
      from (select source_kind, source_id,
                   row_number() over (order by on_date, source_kind, source_id) as rn
              from _bf_map where to_char(on_date, 'YYYY') = v_year) n
     where m.source_kind = n.source_kind and m.source_id = n.source_id;
  end loop;

  -- ── 4. The entries ──────────────────────────────────────────────────────
  --
  -- The period lookup is `order by starts_on desc limit 1` rather than a bare
  -- scalar subquery: step 2 only guarantees a month-shaped period exists, and a
  -- scalar subquery that found two overlapping periods would abort the whole
  -- replay with "more than one row returned by a subquery" -- an error about
  -- SQL for a problem about periods.
  insert into public.journal_entries
      (id, shop_id, period_id, entry_date, reference, description, source, status, location_id, created_by)
  select m.entry_id, p_shop_id,
         (select ap.id from public.accounting_periods ap
           where ap.shop_id = p_shop_id and m.on_date between ap.starts_on and ap.ends_on
           order by ap.starts_on desc limit 1),
         m.on_date, m.reference, m.description, m.source, 'posted', m.location_id, auth.uid()
    from _bf_map m;

  -- ── 5. The back-links, which are what make this idempotent ──────────────
  --
  -- EVERY ONE RE-CHECKS `journal_entry_id is null`, and dropping that from any
  -- of the eight re-opens the concurrency hole the advisory lock at the top of
  -- this function describes. Step 1's filter is not enough on its own: it was
  -- evaluated against a snapshot taken before anything else could have written,
  -- and under READ COMMITTED an UPDATE that blocks on another transaction's row
  -- lock re-evaluates its WHERE against the row version that transaction
  -- committed. A WHERE that no longer mentions the column matches anyway and
  -- CLOBBERS the pointer the other run just wrote -- leaving its entries posted
  -- and orphaned, and every account doubled with the trial balance still zero.
  --
  -- With the re-check, the losing update matches nothing and writes nothing.
  -- Belt AND braces, deliberately: the lock is what stops the orphan entries
  -- ever being written, this is what stops the pointer being taken away.
  update public.sales s set journal_entry_id = m.entry_id
    from _bf_map m where m.source_kind = 'sale' and m.source_id = s.id
     and s.journal_entry_id is null;
  update public.refunds r set journal_entry_id = m.entry_id
    from _bf_map m where m.source_kind = 'refund' and m.source_id = r.id
     and r.journal_entry_id is null;
  update public.sale_payments sp set journal_entry_id = m.entry_id
    from _bf_map m where m.source_kind = 'settlement' and m.source_id = sp.id
     and sp.journal_entry_id is null;
  update public.stock_receipts sr set journal_entry_id = m.entry_id
    from _bf_map m where m.source_kind = 'receipt' and m.source_id = sr.id
     and sr.journal_entry_id is null;
  update public.stock_counts sc set journal_entry_id = m.entry_id
    from _bf_map m where m.source_kind = 'count' and m.source_id = sc.id
     and sc.journal_entry_id is null;
  update public.invoice_payments ip set journal_entry_id = m.entry_id
    from _bf_map m where m.source_kind = 'invoice_payment' and m.source_id = ip.id
     and ip.journal_entry_id is null;
  update public.payroll_runs pr set journal_entry_id = m.entry_id
    from _bf_map m where m.source_kind = 'payroll' and m.source_id = pr.id
     and pr.journal_entry_id is null;
  update public.expenses e set journal_entry_id = m.entry_id
    from _bf_map m where m.source_kind = 'expense' and m.source_id = e.id
     and e.journal_entry_id is null;

  -- ── 6. The lines, one statement per kind ────────────────────────────────
  --
  -- Every one is a UNION ALL of the line kinds, filtered to non-zero at the
  -- end. That filter is what lets the COGS pair, the receivable and the
  -- discount line disappear rather than post a zero: journal_lines carries
  -- check (amount_cents <> 0), and a zero line would take the whole replay
  -- down.

  ---------------------------------------------------------------------------
  -- Sales -- 20260908000300's shape exactly.
  ---------------------------------------------------------------------------
  --
  -- THE ADD-BACK IS THE PART THAT IS EASY TO GET WRONG, and getting it wrong is
  -- invisible. complete_sale's item loop computes
  -- `v_line := price_cents * qty - line_discount` and accumulates THAT, so
  -- sale_items.line_total_cents is already NET of the line and promotion
  -- discounts. Revenue is credited at LIST, so the sum of
  -- sale_items.discount_cents has to be added back to it -- and the same figure
  -- has to appear in the 4200 contra, alongside the order discount and the
  -- points redeemed.
  --
  -- Crediting 4000 with a bare sum(line_total_cents) balances perfectly (both
  -- sides move by the same amount) and understates revenue by every promotion
  -- the shop ever ran, leaving 4200 reading zero for a shop whose discounts are
  -- all promotions -- which is the app's main discount mechanism. It also
  -- ties against a check that re-derives revenue from line_total_cents, which
  -- is the same arithmetic twice. verify-backfill.sql asserts 4000 against
  -- unit_price_cents * quantity for exactly that reason.
  --
  -- Balanced by construction, and this is the proof. Writing G for
  -- sum(line_total_cents), I for sum(item discount), D for sales.discount_cents,
  -- R for points_redeemed_cents, T for tax_cents and P for what the till took:
  -- complete_sale computed total = G - D - R + T. The debits are P plus the
  -- receivable (total - P) plus the contra (D + R + I) = total + D + R + I =
  -- G + I + T. The credits are revenue (G + I) plus tax (T). Equal. The COGS
  -- pair is a self-balancing debit and credit of one amount and does not
  -- disturb it.
  with agg as (
    select m.entry_id, m.location_id, m.source_id,
           s.total_cents, s.tax_cents, s.discount_cents, s.points_redeemed_cents,
           -- Settlements EXCLUDED: they arrive later and post their own entry
           -- against 1100. Including them here would shrink the receivable this
           -- sale created by money the settlement entry has already credited
           -- away, and 1100 would end up understated by every settlement ever
           -- taken. See 4 in this file's header.
           coalesce((select sum(sp.amount_cents) from public.sale_payments sp
                      where sp.sale_id = m.source_id and not sp.is_settlement), 0) as till_cents,
           coalesce((select sum(si.line_total_cents) from public.sale_items si
                      where si.sale_id = m.source_id), 0) as net_lines_cents,
           coalesce((select sum(si.discount_cents) from public.sale_items si
                      where si.sale_id = m.source_id), 0) as item_discount_cents,
           -- The cost FROZEN on the line at sale time, never products.cost_cents
           -- -- otherwise a restock rewrites this sale's gross profit and with
           -- it every closed month's. Uncosted lines contribute nothing rather
           -- than zero: a free sample really does cost nothing, an unpriced
           -- product is a question nobody answered.
           coalesce((select sum(si.unit_cost_cents::bigint * si.quantity) from public.sale_items si
                      where si.sale_id = m.source_id and si.unit_cost_cents is not null), 0) as cogs_cents
      from _bf_map m join public.sales s on s.id = m.source_id
     where m.source_kind = 'sale'
  )
  insert into public.journal_lines (entry_id, account_id, amount_cents, location_id, memo)
  select x.entry_id,
         coalesce(a.id, public.backfill_missing_account(x.code, x.src)),
         x.amount_cents, x.location_id, x.memo
    from (
      -- One debit per tender actually used. A single lumped line would make the
      -- drawer and the wallet impossible to reconcile separately, which is most
      -- of what a cash position is for.
      --
      -- ONE LINE PER METHOD, where complete_sale writes one line per PAYMENT
      -- ROW. A sale paid twice in cash gets two lines live and one here. The
      -- per-account totals are identical, which is what every report, the trial
      -- balance and the drawer reconciliation read, so this is a granularity
      -- difference and not a discrepancy -- recorded here so the next reader
      -- does not re-derive it and think one of the two is wrong.
      select m.entry_id, m.location_id, 'sale ' || m.source_id::text as src,
             public.account_code_for_payment_method(sp.method) as code,
             sum(sp.amount_cents)::bigint as amount_cents,
             'Payment by ' || sp.method as memo
        from _bf_map m
        join public.sale_payments sp on sp.sale_id = m.source_id
       where m.source_kind = 'sale' and not sp.is_settlement
       group by m.entry_id, m.location_id, m.source_id, sp.method

      union all
      -- What was left on account. DERIVED -- there is no sale_balances table;
      -- a balance is the sale's total less what the till took.
      select g.entry_id, g.location_id, 'sale ' || g.source_id::text, '1100',
             (g.total_cents - g.till_cents)::bigint, 'Left on account' from agg g

      union all
      select g.entry_id, g.location_id, 'sale ' || g.source_id::text, '4200',
             (g.discount_cents + g.points_redeemed_cents + g.item_discount_cents)::bigint,
             'Discounts and points' from agg g

      union all
      select g.entry_id, g.location_id, 'sale ' || g.source_id::text, '4000',
             -(g.net_lines_cents + g.item_discount_cents)::bigint, 'Sale at list' from agg g

      union all
      select g.entry_id, g.location_id, 'sale ' || g.source_id::text, '2100',
             -g.tax_cents::bigint, 'Sales tax' from agg g

      union all
      select g.entry_id, g.location_id, 'sale ' || g.source_id::text, '5000',
             g.cogs_cents, 'Cost of goods sold' from agg g
      union all
      select g.entry_id, g.location_id, 'sale ' || g.source_id::text, '1200',
             -g.cogs_cents, 'Stock sold' from agg g
    ) x
    left join public.accounts a on a.shop_id = p_shop_id and a.code = x.code and a.archived_at is null
   where x.amount_cents <> 0;

  ---------------------------------------------------------------------------
  -- Refunds -- 20260908000360's shape.
  ---------------------------------------------------------------------------
  --
  --   Dr 4100 Sales Returns       the merchandise coming back, net of tax
  --   Dr 2100 Sales Tax Payable   the tax share coming back
  --   Cr 1000/1010/1020/1021      the cash actually handed over, one line per
  --                               tender it came in on, pro-rated
  --   Cr 1100 Accounts Receivable the rest, which reduces what is still owed
  --   Dr 1200 / Cr 5000           the cost of the goods coming back
  --
  -- 4100, never a negative 4000: a refund that reduced Sales Revenue would make
  -- a month's revenue depend on when the return happened rather than when the
  -- sale did.
  --
  -- goods_cents and total_cents are read from the STORED refund row and never
  -- recomputed. Refunds issued before 20260820000200 used the old gross-based
  -- figure, and recomputing would quietly "correct" a refund the customer
  -- received months ago into something they did not get.
  --
  -- The tender denominator is what had been collected AT THE TIME OF THE REFUND
  -- (`sp.created_at <= r.created_at`), not everything ever collected on the
  -- sale. A settlement taken after the refund was not a tender the refund could
  -- have gone back out of. Either way the lines sum to total_cents exactly --
  -- largest remainder guarantees it -- so the tie-out is unaffected; the split
  -- across tenders is what improves.
  --
  -- ...WHICH IS TRUE ONLY WHILE THAT DENOMINATOR IS NON-ZERO. The live path
  -- cannot reach the empty case -- refund_sale_items computes its cash figure
  -- as `least(goods, collected - already refunded)`, so total_cents > 0
  -- REQUIRES collected > 0 -- but the replay adds `created_at <= r.created_at`
  -- on top, and a payment row whose created_at was back-dated past its own
  -- refund (an import, a repaired timestamp) leaves per_method empty while
  -- total_cents survives. No cash lines are emitted, the entry is short by
  -- exactly total_cents, and the failure arrives at COMMIT as an unbalanced
  -- entry naming nothing. Caught here instead, where the refund can be named.
  select string_agg(r.id::text, ', ' order by r.id::text) into v_bad
    from _bf_map m
    join public.refunds r on r.id = m.source_id
    join public.sales s on s.id = r.sale_id
   where m.source_kind = 'refund'
     and r.total_cents > 0
     and not exists (select 1 from public.sale_payments sp
                      where sp.sale_id = s.id and sp.amount_cents <> 0
                        and sp.created_at <= r.created_at);
  if v_bad is not null then
    raise exception 'These refunds hand cash back but no payment on their sale is dated before them, so the tenders it went out of cannot be reconstructed: %. A payment''s created_at is later than the refund it paid for -- fix the timestamps and run again.', v_bad
      using errcode = 'P0001';
  end if;

  with ref as (
    select m.entry_id, m.location_id, m.source_id, r.created_at as refunded_at,
           r.goods_cents, r.total_cents,
           case when s.total_cents > 0
                then round(r.goods_cents::numeric * coalesce(s.tax_cents, 0) / s.total_cents)::integer
                else 0 end as tax_back,
           coalesce((select sum(si.unit_cost_cents::bigint * ri.quantity)
                       from public.refund_items ri
                       join public.sale_items si on si.id = ri.sale_item_id
                      where ri.refund_id = m.source_id and si.unit_cost_cents is not null), 0) as cogs_back,
           coalesce((select sum(sp.amount_cents) from public.sale_payments sp
                      where sp.sale_id = s.id and sp.created_at <= r.created_at), 0) as collected_cents,
           s.id as sale_id
      from _bf_map m
      join public.refunds r on r.id = m.source_id
      join public.sales s on s.id = r.sale_id
     where m.source_kind = 'refund'
  ),
  -- LARGEST REMAINDER. Every tender gets floor(share) and the cents left over
  -- go one each to the largest fractional parts. Chosen over "give the whole
  -- difference to the biggest method" because every line then lands within a
  -- cent of its exact share and none can come out NEGATIVE -- a negative credit
  -- is a debit, i.e. a refund that puts money INTO a tender. Ties break on the
  -- bigger tender then the method name, so a replay is deterministic.
  per_method as (
    select f.entry_id, f.location_id, f.source_id, sp.method, sum(sp.amount_cents)::numeric as collected,
           f.total_cents, f.collected_cents
      from ref f
      join public.sale_payments sp on sp.sale_id = f.sale_id
     where sp.amount_cents <> 0 and sp.created_at <= f.refunded_at and f.total_cents > 0
     group by f.entry_id, f.location_id, f.source_id, sp.method, f.total_cents, f.collected_cents
  ),
  ranked as (
    select entry_id, location_id, source_id, method, total_cents,
           floor(total_cents::numeric * collected / collected_cents)::integer as base,
           sum(floor(total_cents::numeric * collected / collected_cents)::integer) over (partition by entry_id) as base_total,
           row_number() over (
             partition by entry_id
             order by (total_cents::numeric * collected / collected_cents)
                      - floor(total_cents::numeric * collected / collected_cents) desc,
                      collected desc, method) as rn
      from per_method
  )
  insert into public.journal_lines (entry_id, account_id, amount_cents, location_id, memo)
  select x.entry_id,
         coalesce(a.id, public.backfill_missing_account(x.code, x.src)),
         x.amount_cents, x.location_id, x.memo
    from (
      select f.entry_id, f.location_id, 'refund ' || f.source_id::text as src, '4100' as code,
             (f.goods_cents - f.tax_back)::bigint as amount_cents, 'Goods returned' as memo from ref f
      union all
      select f.entry_id, f.location_id, 'refund ' || f.source_id::text, '2100',
             f.tax_back::bigint, 'Tax on the return' from ref f
      union all
      select k.entry_id, k.location_id, 'refund ' || k.source_id::text,
             public.account_code_for_payment_method(k.method),
             -(k.base + case when k.rn <= k.total_cents - k.base_total then 1 else 0 end)::bigint,
             'Refunded by ' || k.method
        from ranked k
      union all
      -- The generalisation of "cash if it was paid, receivable if it was not".
      -- On a sale paid in full this is zero and omitted; on one nobody has paid,
      -- the cash lines are. An if/else on "is anything still owed" gets the
      -- part-paid sale wrong in both directions.
      select f.entry_id, f.location_id, 'refund ' || f.source_id::text, '1100',
             -(f.goods_cents - f.total_cents)::bigint, 'Reduced what is owed' from ref f
      union all
      select f.entry_id, f.location_id, 'refund ' || f.source_id::text, '1200',
             f.cogs_back, 'Stock returned' from ref f
      union all
      select f.entry_id, f.location_id, 'refund ' || f.source_id::text, '5000',
             -f.cogs_back, 'Cost reversed' from ref f
    ) x
    left join public.accounts a on a.shop_id = p_shop_id and a.code = x.code and a.archived_at is null
   where x.amount_cents <> 0;

  ---------------------------------------------------------------------------
  -- Settlements -- Dr the tender, Cr 1100. NO REVENUE.
  ---------------------------------------------------------------------------
  --
  -- The revenue was recognised when the sale was rung up and the receivable is
  -- what recorded it. Recognising it again when the money arrives is the
  -- classic double-count, and it would show up as a shop whose credit sales
  -- earn twice.
  insert into public.journal_lines (entry_id, account_id, amount_cents, location_id, memo)
  select x.entry_id,
         coalesce(a.id, public.backfill_missing_account(x.code, x.src)),
         x.amount_cents, x.location_id, x.memo
    from (
      select m.entry_id, m.location_id, 'settlement ' || m.source_id::text as src,
             public.account_code_for_payment_method(sp.method) as code,
             sp.amount_cents::bigint as amount_cents, 'Settlement received' as memo
        from _bf_map m join public.sale_payments sp on sp.id = m.source_id
       where m.source_kind = 'settlement'
      union all
      select m.entry_id, m.location_id, 'settlement ' || m.source_id::text, '1100',
             -sp.amount_cents::bigint, 'Cleared from receivables'
        from _bf_map m join public.sale_payments sp on sp.id = m.source_id
       where m.source_kind = 'settlement'
    ) x
    left join public.accounts a on a.shop_id = p_shop_id and a.code = x.code and a.archived_at is null
   where x.amount_cents <> 0;

  ---------------------------------------------------------------------------
  -- Stock receipts -- Dr 1200 Inventory, Cr 2000 Accounts Payable.
  ---------------------------------------------------------------------------
  --
  -- 2000, not cash: receive_stock records goods ARRIVING and says nothing about
  -- whether they were paid for. Paying the supplier is record_invoice_payment,
  -- replayed above, which debits 2000 back down.
  insert into public.journal_lines (entry_id, account_id, amount_cents, location_id, memo)
  select x.entry_id,
         coalesce(a.id, public.backfill_missing_account(x.code, x.src)),
         x.amount_cents, x.location_id, x.memo
    from (
      select m.entry_id, m.location_id, 'receipt ' || m.source_id::text as src, '1200' as code,
             sum(ri.unit_cost_cents::bigint * ri.quantity) as amount_cents,
             'Delivery received' as memo
        from _bf_map m join public.stock_receipt_items ri on ri.receipt_id = m.source_id
       where m.source_kind = 'receipt' and ri.unit_cost_cents is not null
       group by m.entry_id, m.location_id, m.source_id
      union all
      select m.entry_id, m.location_id, 'receipt ' || m.source_id::text, '2000',
             -sum(ri.unit_cost_cents::bigint * ri.quantity), 'Owed to supplier'
        from _bf_map m join public.stock_receipt_items ri on ri.receipt_id = m.source_id
       where m.source_kind = 'receipt' and ri.unit_cost_cents is not null
       group by m.entry_id, m.location_id, m.source_id
    ) x
    left join public.accounts a on a.shop_id = p_shop_id and a.code = x.code and a.archived_at is null
   where x.amount_cents <> 0;

  ---------------------------------------------------------------------------
  -- Stock counts -- 1200 by the variance, 5100 by its negative.
  ---------------------------------------------------------------------------
  --
  -- One signed pair covers both directions, and that is not a shortcut: short
  -- means variance < 0, so 1200 is credited and 5100 debited; found means
  -- variance > 0 and both flip. save_stock_count writes them as two branches
  -- purely so each has its own memo, which is reproduced here by a case.
  --
  -- 5100 sits in COST OF SALES, above gross profit -- not in operating
  -- expenses, where the Count door's stock_loss expense lands. A unit that is
  -- stolen or breaks is never sold, so its cost enters COGS by no other path
  -- and gross profit reads high by exactly that amount, every month, invisibly.
  insert into public.journal_lines (entry_id, account_id, amount_cents, location_id, memo)
  select x.entry_id,
         coalesce(a.id, public.backfill_missing_account(x.code, x.src)),
         x.amount_cents, x.location_id, x.memo
    from (
      select v.entry_id, v.location_id, 'count ' || v.source_id::text as src,
             '1200' as code, v.variance_cents as amount_cents,
             case when v.variance_cents < 0 then 'Written off' else 'Stock found' end as memo
        from (
          select m.entry_id, m.location_id, m.source_id,
                 sum(ci.unit_cost_cents::bigint * (ci.counted_quantity - ci.previous_quantity)) as variance_cents
            from _bf_map m join public.stock_count_items ci on ci.count_id = m.source_id
           where m.source_kind = 'count' and ci.unit_cost_cents is not null
           group by m.entry_id, m.location_id, m.source_id) v
      union all
      select v.entry_id, v.location_id, 'count ' || v.source_id::text, '5100', -v.variance_cents,
             case when v.variance_cents < 0 then 'Stock short' else 'Shrinkage reversed' end
        from (
          select m.entry_id, m.location_id, m.source_id,
                 sum(ci.unit_cost_cents::bigint * (ci.counted_quantity - ci.previous_quantity)) as variance_cents
            from _bf_map m join public.stock_count_items ci on ci.count_id = m.source_id
           where m.source_kind = 'count' and ci.unit_cost_cents is not null
           group by m.entry_id, m.location_id, m.source_id) v
    ) x
    left join public.accounts a on a.shop_id = p_shop_id and a.code = x.code and a.archived_at is null
   where x.amount_cents <> 0;

  ---------------------------------------------------------------------------
  -- Supplier payments -- Dr 2000 Accounts Payable, Cr the wallet.
  ---------------------------------------------------------------------------
  --
  -- NO expense line. The cost was recognised when the bill arrived -- by the
  -- bill's own mirror row, Dr the category's account / Cr 2000, replayed above.
  -- This statement moves money against the liability that recognition created.
  -- Posting 6xxx again here would double every cost the shop has.
  insert into public.journal_lines (entry_id, account_id, amount_cents, location_id, memo)
  select x.entry_id,
         coalesce(a.id, public.backfill_missing_account(x.code, x.src)),
         x.amount_cents, x.location_id, x.memo
    from (
      select m.entry_id, m.location_id, 'supplier payment ' || m.source_id::text as src,
             '2000' as code,
             ip.amount_cents::bigint as amount_cents, 'Bill paid' as memo
        from _bf_map m join public.invoice_payments ip on ip.id = m.source_id
       where m.source_kind = 'invoice_payment'
      union all
      select m.entry_id, m.location_id, 'supplier payment ' || m.source_id::text,
             public.account_code_for_payment_method(ip.method),
             -ip.amount_cents::bigint, 'Paid by ' || ip.method
        from _bf_map m join public.invoice_payments ip on ip.id = m.source_id
       where m.source_kind = 'invoice_payment'
    ) x
    left join public.accounts a on a.shop_id = p_shop_id and a.code = x.code and a.archived_at is null
   where x.amount_cents <> 0;

  ---------------------------------------------------------------------------
  -- Pay runs -- Dr 6200 Salaries and Wages, Cr 1000 Cash.
  ---------------------------------------------------------------------------
  --
  -- Cash, not 2200 Wages Payable: post_payroll_run records a run that HAS been
  -- paid. Accruing wages owed but unpaid is phase 3's work.
  --
  -- The run's own total_cents, which post_payroll_run wrote from the sum of its
  -- lines at post time. Re-summing payroll_run_lines would be a second opinion
  -- on the same arithmetic against rows that may have been edited since, and
  -- would post a figure that differs from the expense row the run produced.
  insert into public.journal_lines (entry_id, account_id, amount_cents, location_id, memo)
  select x.entry_id,
         coalesce(a.id, public.backfill_missing_account(x.code, x.src)),
         x.amount_cents, x.location_id, x.memo
    from (
      select m.entry_id, m.location_id, 'pay run ' || m.source_id::text as src,
             '6200' as code,
             pr.total_cents::bigint as amount_cents, 'Wages' as memo
        from _bf_map m join public.payroll_runs pr on pr.id = m.source_id
       where m.source_kind = 'payroll'
      union all
      select m.entry_id, m.location_id, 'pay run ' || m.source_id::text, '1000',
             -pr.total_cents::bigint, 'Paid out'
        from _bf_map m join public.payroll_runs pr on pr.id = m.source_id
       where m.source_kind = 'payroll'
    ) x
    left join public.accounts a on a.shop_id = p_shop_id and a.code = x.code and a.archived_at is null
   where x.amount_cents <> 0;

  ---------------------------------------------------------------------------
  -- Expenses -- THE SAME FOUR-WAY BRANCH THE LIVE TRIGGER TAKES.
  ---------------------------------------------------------------------------
  --
  -- 20260908000800 gave post_expense_to_ledger a branch, and this replay
  -- carries it character for character. If the two ever disagree, history and
  -- live behaviour disagree, and the whole of Task 8 turns on their not doing
  -- so -- verify-backfill.sql exists to hold them together.
  --
  --   invoice_id set        -> Dr the category's account / Cr 2000 Payable
  --   stock_receipt_id set  -> Dr 2000 Accounts Payable / Cr the wallet
  --   standalone stock_loss -> Dr 5100 Inventory Shrinkage / Cr 1200 Inventory
  --   anything else         -> Dr the category's account / Cr the wallet
  --
  -- (Rows carrying stock_count_id never reach here -- step 1 excluded them,
  -- because save_stock_count posted the whole entry itself. Nor do
  -- inventory_purchase bills, excluded by the same statement for the reason
  -- 20260908000800 sets out: the delivery already recognised them.)
  --
  -- THE TWO ARMS THAT REACH 1200 -- a standalone inventory_purchase debiting it
  -- through the category map, and a standalone stock_loss crediting it -- are
  -- mirrored in unposted_inventory_movement() so the opening balance can be
  -- predicted before this statement runs. The two case expressions there are
  -- copied from here on purpose and are meant to be diffed against these.
  --
  -- A BILL'S MIRROR ROW IS WHERE ITS COST IS RECOGNISED, and the credit is 2000
  -- rather than the wallet the row names. sync_invoice_expense writes the
  -- literal 'other' into payment_method because a bill has no payment method --
  -- routing that through account_code_for_payment_method credits 1010 Bank for
  -- a bill nobody has paid, and leaves the supplier payment's Dr 2000 with
  -- nothing to clear. This is the exact mirror of the receipt branch below.
  --
  -- A receipt-linked row SETTLES the payable receive_stock raised; it does not
  -- buy the goods again. Its category is 'inventory_purchase', which the map
  -- sends to 1200 -- and 1200 is exactly what the delivery already debited, so
  -- taking the category here is the double-count this branch exists to stop.
  --
  -- A standalone stock_loss credits 1200, never a wallet. Losing stock costs
  -- the shop the stock, not the till.
  --
  -- HISTORICAL ROWS PREDATE BOTH COLUMNS AND WILL HAVE THEM NULL, so they take
  -- the standalone path -- AND THAT IS RIGHT, not a gap the replay is papering
  -- over. Those rows were written before the ledger existed: there is no
  -- receipt entry for a null stock_receipt_id to settle, because receive_stock
  -- posted nothing at the time, and the replay posts that receipt's own
  -- Dr 1200 / Cr 2000 from stock_receipts in the same run. A historical
  -- inventory_purchase therefore has to debit 1200 on its own account, exactly
  -- as it does today. The only rows that carry a link are ones written after
  -- 20260908000800 shipped -- and for those the receipt entry exists, so the
  -- settlement has something to settle.
  --
  -- The mapping in the third branch is what makes a balance sheet possible:
  -- 'inventory_purchase' goes to 1200 Inventory (an ASSET) and 'owner_draw' to
  -- 3100 Owner's Draw (CONTRA-EQUITY), so they stop being expenses here rather
  -- than being filtered out of a subtotal by a list somebody has to remember to
  -- maintain.
  --
  -- Cr the account the PAYMENT METHOD maps to, not 1000 for everything.
  -- Hardcoding 1000 would make the till count disagree with the ledger for
  -- every zaad or eDahab expense.
  --
  -- THE REPLAY READS THE ROW AS IT STANDS TODAY, AND THAT IS NOW THE RIGHT
  -- ANSWER RATHER THAN A HOLE. This block used to say the opposite -- that
  -- expenses_post_to_ledger was AFTER INSERT only, so a live-posted expense kept
  -- its ORIGINAL figure while the row moved on, and the two paths disagreed for
  -- every edited expense. 20260908001000 closed that: an edit reverses and
  -- re-posts through post_expense_to_ledger itself, and a delete reverses. So a
  -- live-posted expense now carries its CURRENT figure too, which is exactly
  -- what the replay writes, and a deleted one has no surviving journal effect
  -- for the replay to disagree with. The two paths agree.
  --
  -- KEPT AS A NOTE RATHER THAN DELETED because the comment was cited as evidence
  -- once already: the next reader who finds "the replay reads the row as it
  -- stands today" should not go and re-solve a solved problem. If a future
  -- migration re-creates post_expense_to_ledger it must carry
  -- expenses_post_to_ledger_on_edit forward with it (20260908001000 says so at
  -- the trigger), or this paragraph becomes true again.
  insert into public.journal_lines (entry_id, account_id, amount_cents, location_id, memo)
  select x.entry_id,
         coalesce(a.id, public.backfill_missing_account(x.code, x.src)),
         x.amount_cents, x.location_id, x.memo
    from (
      select m.entry_id, m.location_id, 'expense ' || m.source_id::text as src,
             case when e.invoice_id is not null       then public.account_code_for_expense_category(e.category)
                  when e.stock_receipt_id is not null then '2000'
                  when e.category = 'stock_loss'      then '5100'
                  else public.account_code_for_expense_category(e.category)
             end as code,
             e.amount_cents::bigint as amount_cents,
             case when e.stock_receipt_id is not null then 'Delivery paid'
                  else replace(e.category, '_', ' ')
             end as memo
        from _bf_map m join public.expenses e on e.id = m.source_id
       where m.source_kind = 'expense'
      union all
      select m.entry_id, m.location_id, 'expense ' || m.source_id::text,
             case when e.invoice_id is not null then '2000'
                  when e.stock_receipt_id is null and e.category = 'stock_loss' then '1200'
                  else public.account_code_for_payment_method(e.payment_method)
             end,
             -e.amount_cents::bigint,
             case when e.invoice_id is not null then 'Owed to supplier'
                  when e.stock_receipt_id is null and e.category = 'stock_loss' then 'Written off'
                  else 'Paid by ' || e.payment_method
             end
        from _bf_map m join public.expenses e on e.id = m.source_id
       where m.source_kind = 'expense'
    ) x
    left join public.accounts a on a.shop_id = p_shop_id and a.code = x.code and a.archived_at is null
   where x.amount_cents <> 0;

  -- ── 6b. THE OPENING BALANCE ─────────────────────────────────────────────
  --
  --     Dr 1200 Inventory        the stock no delivery accounts for
  --     Cr 3000 Owner's Capital  the same
  --
  -- AFTER every other line statement, and that ordering is the whole design.
  -- The amount is "what stock is worth, less what the ledger holds against
  -- 1200", and only here is the second half complete. Computed before step 6 it
  -- would be short by everything this run just posted, and 1200 would end up
  -- reading (on hand + the run's own movements) instead of (on hand).
  --
  -- The full reasoning -- why this amount and not today's stock, why this date
  -- and not today, why per shop and not per location, what an uncosted product
  -- contributes, and why the idempotency guard is not `source = 'opening'`
  -- alone -- is in this migration's header. It is the number a shop's first
  -- balance sheet rests on and it is argued there at length rather than here.
  --
  -- Zero posts NOTHING, which is a requirement and not a shortcut:
  -- journal_lines carries check (amount_cents <> 0), so a shop with no stock
  -- and no history cannot be given a zero opening entry even if somebody wanted
  -- one. It is also the state every shop is in after its first run, which is
  -- what makes a second run write nothing.
  v_open_cents := public.opening_inventory_gap(p_shop_id);
  if v_open_cents <> 0 then
    v_open_date := public.opening_inventory_date(p_shop_id);
    v_open_id   := gen_random_uuid();

    -- The month may not exist yet -- a shop with stock and no ledger at all
    -- reaches here with nothing in _bf_map, so step 2 created nothing. Created
    -- OPEN, and an existing month keeps whatever status it has and receives the
    -- entry anyway, exactly as step 2 does and for the same reasons.
    insert into public.accounting_periods (shop_id, starts_on, ends_on)
      values (p_shop_id, date_trunc('month', v_open_date)::date,
              (date_trunc('month', v_open_date) + interval '1 month - 1 day')::date)
      on conflict (shop_id, starts_on) do nothing;

    if not exists (select 1 from public.accounting_periods ap
                    where ap.shop_id = p_shop_id
                      and v_open_date between ap.starts_on and ap.ends_on) then
      raise exception 'No accounting period covers % , where the opening balance belongs. A period already starts on the 1st of that month but ends before the month does. Extend or remove that period and run again.', v_open_date
        using errcode = 'P0001';
    end if;

    -- One number from the same counter, in the same read-and-increment. Never a
    -- separate series: see this file's header on references.
    v_year := to_char(v_open_date, 'YYYY');
    insert into public.journal_entry_sequences (shop_id, year, next_number)
      values (p_shop_id, v_year, 2)
      on conflict (shop_id, year) do update
        set next_number = public.journal_entry_sequences.next_number + 1
      returning next_number - 1 into v_first;

    -- No location, for the reason set out in the header: the amount is a
    -- shop-level residue and a per-branch split of it would be exact-looking
    -- and unfounded.
    insert into public.journal_entries
        (id, shop_id, period_id, entry_date, reference, description, source, status, location_id, created_by)
      values (v_open_id, p_shop_id,
              (select ap.id from public.accounting_periods ap
                where ap.shop_id = p_shop_id and v_open_date between ap.starts_on and ap.ends_on
                order by ap.starts_on desc limit 1),
              v_open_date, public.journal_entry_reference(v_year, v_first),
              'Opening stock', 'opening', 'posted', null, auth.uid());

    -- Same LEFT JOIN and same backfill_missing_account as every other line
    -- statement: a shop whose chart is missing 3000 must be told which account
    -- by name, not left with an entry that quietly lost half of itself.
    insert into public.journal_lines (entry_id, account_id, amount_cents, location_id, memo)
    select v_open_id,
           coalesce(a.id, public.backfill_missing_account(x.code, 'the opening balance')),
           x.amount_cents, null, x.memo
      from (values ('1200', v_open_cents, 'Stock on hand when the books begin'),
                   ('3000', -v_open_cents, 'Put in by the owner')) as x(code, amount_cents, memo)
      left join public.accounts a on a.shop_id = p_shop_id and a.code = x.code and a.archived_at is null;

    v_written := v_written + 1;
  end if;

  -- ── 7. Nothing was written half-way ─────────────────────────────────────
  --
  -- A BACKSTOP, not the first line of defence. The missing-account case -- which
  -- used to reach here, badly, as an entry silently short of lines -- now raises
  -- by name at the line statement itself (see backfill_missing_account above).
  -- What is left for this to catch is an entry whose lines all came out ZERO and
  -- were filtered by `amount_cents <> 0`: a source row carrying no money that
  -- the step-1 filters did not already exclude. The deferred balance trigger
  -- cannot see it, because assert_journal_balances deliberately ALLOWS a
  -- zero-line entry (that is the legitimate end state of a draft's lines being
  -- deleted), so an entry could be left standing with nothing under it and the
  -- trial balance would still zero.
  --
  -- Raised rather than skipped. If the replay cannot express a row, the mapping
  -- is wrong and the whole run should stop -- a backfill that quietly wrote a
  -- referenced-but-empty entry is exactly the "close is worse than none" state
  -- this task exists to avoid.
  --
  -- The opening entry is not checked here because it cannot fail this way: it
  -- is two lines of a non-zero amount and its negation, guarded by
  -- `v_open_cents <> 0` before either is written.
  select string_agg(m.source_kind || ' ' || m.source_id::text, ', ')
    into v_bad
    from _bf_map m
   where (select count(*) from public.journal_lines l where l.entry_id = m.entry_id) < 2;
  if v_bad is not null then
    raise exception 'Backfill could not build a complete entry for: %. The chart of accounts is missing something, or the source rows carry no money.', v_bad
      using errcode = 'P0001';
  end if;

  return v_written;
end;
$$;
comment on function public.backfill_shop_ledger(uuid) is
  'Replays every unposted sale, refund, settlement, stock receipt, stock count, supplier payment, pay run and expense into the ledger, then posts the shop''s opening inventory balance (Dr 1200 / Cr 3000) for stock that arrived before the app recorded deliveries, and returns how many entries it wrote. Idempotent -- the eight replays are driven by journal_entry_id being null and the opening balance by opening_inventory_gap(), which returns 0 once one exists -- so a second run writes nothing. Inserts journal_entries and journal_lines directly rather than through post_journal_entry, because open_period_for raises on a closed month and would abort the replay half-way; the deferred balance trigger still runs, and the wrapper''s missing-account check is reproduced by backfill_missing_account. References come from journal_entry_sequences, reserved a year at a time. A bill''s mirrored expense row is skipped when the bill names a delivery -- receive_stock recognised those goods -- and when it is an inventory_purchase naming none, which is the gap 20260908001900 states rather than posts.';

grant execute on function public.backfill_shop_ledger(uuid) to authenticated;
