-- A platform admin can delete a shop that has ever paid a bill.
--
-- ## The defect, in production
--
-- `delete_shop` is a live platform-admin action -- src/components/platform/
-- shop-drawer.tsx calls callPlatformAdmin('delete_shop', ...), which reaches
-- supabase/functions/platform-admin/index.ts and issues a plain
-- `delete from public.shops where id = ...`, relying entirely on FK cascade.
-- Since 20260908001000 shipped, that statement fails outright for any shop that
-- has ever recorded a supplier payment:
--
--   ERROR: the journal entry for this payment is missing, so it cannot be
--   reversed
--   CONTEXT: PL/pgSQL function reverse_invoice_payment_entry() line .. at RAISE
--            SQL statement "delete from public.shops where id = ..."
--
-- Reproduced before anything here was written: seed a shop, enter a bill,
-- record_invoice_payment against it, delete the shop.
--
-- reverse_invoice_payment_entry() is an AFTER DELETE trigger on
-- `invoice_payments`. `journal_entries.shop_id` and `invoices.shop_id` both
-- cascade from `shops`, and `invoice_payments.invoice_id` cascades from
-- `invoices`. Postgres fires those RI actions in an order this schema does not
-- control, and it happens to tear the journal down first -- so by the time the
-- payment's own trigger runs, the entry it is holding a pointer to is already
-- gone and the function raises about an inconsistency that is not one.
--
-- This is the same class as 20260908001200: a delete_shop that a rule about
-- ordinary single-row correctness refuses, because that rule was written
-- without the cascade in mind. That migration fixed WHEN a foreign key is
-- checked; this one fixes WHAT a trigger does when its whole shop is going.
--
-- ## The distinction that has to survive
--
-- A missing entry while the shop still exists is a genuine inconsistency and
-- must still raise loudly -- the foreign key on invoice_payments.journal_entry_id
-- makes it unreachable, which is exactly why the failure mode should be loud
-- rather than plausible. A missing entry while the shop is being deleted is
-- expected, and must be a silent no-op: the entry is being destroyed by the
-- same statement, so there is no ledger left to keep straight.
--
-- Telling those apart needs the shop, and telling them apart BEFORE the entry
-- is read -- 20260908001500's own comment records that a guard placed after the
-- lookup is useless, having been caught doing exactly that.
--
-- ## Why invoice_payments gains a shop_id rather than reaching for one
--
-- reverse_stock_receipt_entry() (20260908001500) is the model: read the shop
-- off the row FIRST, and the question never arises. `stock_receipts` carries a
-- shop_id, so it can. `invoice_payments` does not, and the two parents it could
-- reach one through are BOTH gone by the time it needs them. Measured, not
-- assumed -- a diagnostic trigger printed what was standing at the moment it
-- fired:
--
--   deleting the INVOICE only (shop alive): invoice row present=f, entry row present=t
--   deleting the SHOP:                      invoice row present=f, entry row present=f
--
-- The invoice is gone in BOTH cases, because an RI cascade is an AFTER trigger
-- on the parent: by the time `invoice_payments` is reached, the `invoices` row
-- that reached it has already been deleted. So `invoices` cannot answer the
-- question in the failing case, and in the case where the ENTRY could answer it
-- the entry is exactly what is missing.
--
-- The remaining option is to give the row the answer. shop_id is denormalised
-- from the invoice and maintained by a trigger rather than by callers -- there
-- are already raw inserts into this table in verify-posting-bills.sql and
-- verify-backfill.sql, the `write invoice_payments` policy is `for all` so a
-- client insert is permitted, and record_invoice_payment is a third writer. A
-- derived column that no writer can get wrong is worth more than three writers
-- each remembering to set it, and it makes the not-null honest.
--
-- ON DELETE CASCADE, matching invoices.shop_id and stock_receipts.shop_id. It
-- gives `shops` a second route to these rows, alongside the one through
-- `invoices`. That is harmless in both orders: whichever fires, the `shops` row
-- is already gone when the trigger runs, which is the only fact the guard reads.

alter table public.invoice_payments
  add column if not exists shop_id uuid references public.shops(id) on delete cascade;

-- Every existing row has a not-null invoice_id, so this reaches all of them.
update public.invoice_payments p
   set shop_id = i.shop_id
  from public.invoices i
 where i.id = p.invoice_id and p.shop_id is null;

alter table public.invoice_payments alter column shop_id set not null;

create index if not exists invoice_payments_shop_id_idx on public.invoice_payments(shop_id);

comment on column public.invoice_payments.shop_id is
  'The shop this payment belongs to, denormalised from its invoice and maintained by set_invoice_payment_shop() -- never written by a caller. It exists so reverse_invoice_payment_entry() can tell "the shop is being deleted" from "this payment''s entry has gone missing" without reading either parent, both of which are already gone by the time an RI cascade reaches this table.';

-- Derived, always, from the invoice the payment is against -- so the two cannot
-- disagree and no writer has to know the column exists.
--
-- BEFORE, so the value is in the row RLS then checks and the row the not-null
-- then sees.
--
-- EVERY UPDATE, NOT `update of invoice_id`. Narrowing it to the invoice column
-- looks like a saving -- moving a payment to another bill is the only edit that
-- can legitimately change the answer -- and it is a hole. The `write
-- invoice_payments` policy (20260804000300) is `for all`, and both its USING and
-- its WITH CHECK read the INVOICE's shop, never this row's shop_id. So a client
-- holding invoices.manage on two of their own shops could
-- `update invoice_payments set shop_id = <the other shop>` on a payment: the
-- policy sees the invoice unchanged and permits it, and a trigger listening only
-- for invoice_id never fires to put the value back. The column is documented as
-- derived and never written by a caller, and this is what makes that true rather
-- than merely intended.
--
-- The cost is one select on `invoices` per payment update. invoice_payments is
-- updated by nothing in the app -- payments are inserted and deleted, never
-- edited -- so the saving it buys is on a path that does not exist, while the
-- hole it opens is on one a client can reach directly over PostgREST.
create or replace function public.set_invoice_payment_shop() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  select shop_id into new.shop_id from public.invoices where id = new.invoice_id;
  -- The foreign key on invoice_id makes this unreachable; the not-null on
  -- shop_id would catch it a moment later with a message about a column rather
  -- than about a bill.
  if new.shop_id is null then
    raise exception 'bill % not found, so this payment has no shop', new.invoice_id
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;

comment on function public.set_invoice_payment_shop() is
  'BEFORE INSERT OR UPDATE on invoice_payments -- every update, not just one of invoice_id. Fills shop_id from the bill the payment is against, so the denormalised column cannot drift from its invoice whichever of the three writers -- record_invoice_payment, a client insert under the `write invoice_payments` policy, or a test fixture -- put the row there, and so a direct write to shop_id under that `for all` policy is overwritten rather than kept.';

drop trigger if exists invoice_payments_set_shop on public.invoice_payments;
create trigger invoice_payments_set_shop
  before insert or update on public.invoice_payments
  for each row execute function public.set_invoice_payment_shop();

-- ---------------------------------------------------------------------------
-- The reversal, with the guard where it has to be
-- ---------------------------------------------------------------------------
--
-- CARRIED FORWARD IN FULL from 20260908001000. The ONLY change is the shop
-- skip: it now reads `old.shop_id` and it now runs BEFORE the entry is looked
-- up, instead of reading `v_old.shop_id` after. Everything else -- the
-- null-entry no-op, the already-reversed no-op, the non-posted raise, the
-- closed-period redirect, the R-suffixed reference, the source read off the
-- original, the negated lines, the two-way link -- is unchanged.
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

  -- THE SHOP ITSELF BEING DELETED, AND THIS SKIP COMES FIRST -- BEFORE THE
  -- ENTRY IS EVEN READ. `shops` is the cascade root
  -- (supabase/functions/platform-admin/index.ts deletes it outright) and a
  -- cascade is an AFTER trigger on the parent, so the shops row is already gone
  -- by the time this fires. Two things then go wrong at once if this is left
  -- until after the lookup, which is where 20260908001000 put it:
  --
  --   * the entry may ALSO already be gone -- `journal_entries.shop_id`
  --     cascades from the same `shops` row and Postgres tears that branch down
  --     first -- so the "missing entry" raise below fires and aborts the whole
  --     shop deletion. That is the production defect this migration exists for.
  --   * and if it were not gone, inserting a mirror entry referencing a shops
  --     row that no longer exists would violate journal_entries.shop_id and
  --     abort the deletion anyway.
  --
  -- Nothing is lost by skipping: the entry is being destroyed by the same
  -- statement. There is no ledger left to keep straight.
  if not exists (select 1 from public.shops where id = old.shop_id) then
    return null;
  end if;

  select * into v_old from public.journal_entries where id = old.journal_entry_id;
  -- The foreign key on invoice_payments.journal_entry_id makes this unreachable
  -- now that the shop skip above runs first, which is exactly why it is loud
  -- rather than plausible. A payment whose entry has vanished while its shop is
  -- still trading means the books no longer tie, and going quiet about it would
  -- leave 2000 Accounts Payable wrong with nothing on the record saying so.
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

  if v_old.status <> 'posted' then
    raise exception 'the journal entry for this payment is %, so it cannot be reversed',
      v_old.status using errcode = 'P0001';
  end if;

  -- READ, not caught -- see 20260908001000's header. A bill deleted after its
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
  'AFTER DELETE on invoice_payments. Reverses the Dr 2000 / Cr wallet entry the payment posted, whichever door removed the row -- delete_invoice_payment, the cascade from deleting a bill, or a client delete. Written inline rather than through reverse_journal_entry, which gates on ledger.post. A no-op for a payment that posted nothing, for an entry already reversed (delete_invoice_payment does it inline first), and for a shop being deleted -- that last check reads invoice_payments.shop_id and runs BEFORE the entry is looked up, because a shop cascade destroys the entry first and a guard after the lookup never gets to run. Paired with reverse_expense_entry so both halves of a deleted bill come off together.';

drop trigger if exists invoice_payments_reverse_on_delete on public.invoice_payments;
create trigger invoice_payments_reverse_on_delete
  after delete on public.invoice_payments
  for each row execute function public.reverse_invoice_payment_entry();

-- ---------------------------------------------------------------------------
-- The other two reversal triggers were audited alongside, and are left alone
-- ---------------------------------------------------------------------------
--
-- reverse_expense_entry() (20260908001000): `expenses` carries its own shop_id,
-- and its skip 2 already reads `old.shop_id` and already sits BEFORE the entry
-- lookup. Correct as written -- and held there now rather than trusted, by
-- CHECK 23 of verify-ledger.sql, which turns out to exercise it: entering a
-- bill mirrors an `expenses` row through sync_invoice_expense and that row
-- posts its own entry, so a shop that has paid a bill reaches BOTH triggers.
-- Deleting skip 2 reddens check 23 with 'the journal entry for this expense is
-- missing, so it cannot be reversed'. Verified by running that mutation.
--
-- reverse_stock_receipt_entry() (20260908001500): same shape, same reason, and
-- it was written knowing about this trap -- its comment names
-- reverse_invoice_payment_entry as the function that puts the guard in the
-- wrong place. Correct as written; held by check 24 of verify-ledger.sql (and
-- by check 12 of verify-posting-inventory.sql before it).
--
-- Those three are the whole set. A query of pg_trigger for non-internal DELETE
-- and UPDATE triggers in `public` finds exactly four rows whose function writes
-- a journal entry -- expenses_reverse_on_edit, expenses_reverse_on_delete,
-- invoice_payments_reverse_on_delete, stock_receipts_reverse_on_delete -- and
-- the first two share one function. Everything else that reverses (edit_sale,
-- delete_sale, delete_invoice_payment, unpost_payroll_run) is an RPC a human
-- calls, which a cascade never reaches.
