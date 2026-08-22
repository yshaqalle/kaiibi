-- Two kinds of bill, told apart.
--
-- Today every bill is a credit bill: raised now, due later, sitting in
-- accounts payable until someone records a payment. That is the right model
-- for the landlord and the wholesaler with an account. It is the wrong model
-- for the far commoner case -- a supplier hands over the goods, is paid on the
-- spot, and hands over a receipt.
--
-- An owner recording that today has two bad options. Log it as an expense and
-- the supplier's invoice number, the vendor and the due-date trail are lost.
-- Log it as a bill and it joins the outstanding list, where it makes the shop
-- look as though it owes money it has already handed over -- and then has to
-- be paid off by hand, in a second step that is easy to forget.
--
-- So a bill now says which it is. A cash bill is raised and settled in the
-- same transaction, is never outstanding for a moment, and is still a bill:
-- same vendor, same reference, same expense behind it, same place to look for
-- it in six months.
--
-- Nothing about the accounting changes. Both kinds already post their cost
-- through `expenses` when the bill is RAISED (see the invoices migration), so
-- a cash bill and a credit bill hit the profit-and-loss statement identically.
-- What differs is only how long the shop owes it: a moment, or a month.

alter table public.invoices
  add column if not exists payment_terms text not null default 'credit'
    check (payment_terms in ('credit','cash'));

comment on column public.invoices.payment_terms is
  'credit = raised now, paid later, sits in accounts payable. cash = paid on the spot, settled the moment it is recorded and never outstanding.';

-- A cash bill that is due later is a contradiction: it was paid when it was
-- raised. `not valid`, so the constraint applies to everything written from
-- here on without the migration having to guess at existing rows -- every one
-- of which is `credit` by the default above, and so passes anyway.
alter table public.invoices
  add constraint invoices_cash_is_due_on_issue
  check (payment_terms <> 'cash' or due_on = issued_on) not valid;

-- Raises a bill and, when it is a cash bill, settles it in the same
-- transaction.
--
-- An RPC rather than two client calls, and this is the whole reason it exists:
-- an insert followed by a separate `record_invoice_payment` can half-succeed,
-- and what it leaves behind is a cash bill sitting in the outstanding list
-- claiming the shop owes a supplier it has already paid. One transaction, or
-- neither half.
--
-- Credit bills go through it too, so there is one path a bill is created by
-- and the client is not choosing between two shapes of the same act.
create or replace function public.record_bill(
  p_shop_id uuid,
  p_invoice_number text,
  p_amount_cents integer,
  p_category text,
  p_due_on date,
  p_issued_on date default current_date,
  p_payment_terms text default 'credit',
  p_vendor_id uuid default null,
  p_vendor_name text default null,
  p_vendor_phone text default null,
  p_description text default null,
  p_location_id uuid default null,
  -- How the cash bill was settled. Ignored for a credit bill, which has not
  -- been paid by any method yet.
  p_payment_method text default 'cash'
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_invoice_id uuid;
  v_due_on date;
begin
  if not public.has_shop_permission(p_shop_id, 'invoices.manage') then
    raise exception 'not authorized to record bills for this shop';
  end if;
  if p_payment_terms not in ('credit','cash') then
    raise exception 'invalid payment terms %', p_payment_terms;
  end if;
  if p_amount_cents is null or p_amount_cents <= 0 then
    raise exception 'a bill must be for more than zero';
  end if;

  -- A cash bill's due date is the day it was issued, whatever the caller
  -- passed. Corrected rather than rejected: the client hides the due-date
  -- field for a cash bill, so a stale value here is the app's mistake to
  -- absorb, not something to hand back to the person typing.
  v_due_on := case when p_payment_terms = 'cash' then p_issued_on else p_due_on end;
  if v_due_on is null then
    raise exception 'a credit bill needs a due date';
  end if;
  if v_due_on < p_issued_on then
    raise exception 'a bill cannot be due before it was issued';
  end if;

  insert into public.invoices (
    shop_id, location_id, vendor_id, vendor_name, vendor_phone, invoice_number,
    category, description, issued_on, due_on, amount_cents, payment_terms, created_by
  ) values (
    p_shop_id, p_location_id, p_vendor_id, nullif(p_vendor_name, ''), nullif(p_vendor_phone, ''),
    p_invoice_number, p_category, nullif(p_description, ''), p_issued_on, v_due_on,
    p_amount_cents, p_payment_terms, auth.uid()
  ) returning id into v_invoice_id;

  -- Through the existing RPC rather than by writing `paid_cents` here: that
  -- function is what keeps a bill's paid total and its payment rows in step,
  -- and a second path that sets one without the other is exactly the drift the
  -- invoices migration was built to prevent.
  if p_payment_terms = 'cash' then
    perform public.record_invoice_payment(
      v_invoice_id, p_amount_cents, p_issued_on, p_payment_method,
      'Paid on issue'
    );
  end if;

  return v_invoice_id;
end;
$$;

grant execute on function public.record_bill(uuid, text, integer, text, date, date, text, uuid, text, text, text, uuid, text) to authenticated;
