-- Undoing a payment has to be atomic, for the same reason recording one is.
--
-- It was doing three separate client round-trips: delete the payment, re-read
-- what's left, then write the recomputed total back. Two people undoing
-- payments at once could interleave those steps and leave `paid_cents`
-- disagreeing with the payments actually on the bill -- and a stale total on
-- an accounts-payable record is the sort of error nobody notices until they
-- pay a supplier twice.
--
-- Recomputes from the surviving rows rather than subtracting the deleted
-- amount, so a double-undo can't drive the total negative.
create or replace function public.delete_invoice_payment(p_payment_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_invoice public.invoices%rowtype;
  v_invoice_id uuid;
  v_remaining integer;
begin
  select invoice_id into v_invoice_id from public.invoice_payments where id = p_payment_id;
  if v_invoice_id is null then
    raise exception 'payment % not found', p_payment_id;
  end if;

  -- Lock the parent before touching either table, so a concurrent
  -- record_invoice_payment can't slip between the delete and the recount.
  select * into v_invoice from public.invoices where id = v_invoice_id for update;
  if not public.has_shop_permission(v_invoice.shop_id, 'invoices.manage') then
    raise exception 'not authorized for bill %', v_invoice_id;
  end if;

  delete from public.invoice_payments where id = p_payment_id;

  select coalesce(sum(amount_cents), 0) into v_remaining
    from public.invoice_payments where invoice_id = v_invoice_id;

  update public.invoices
    set paid_cents = v_remaining, updated_at = now(), updated_by = auth.uid()
    where id = v_invoice_id;
end;
$$;

grant execute on function public.delete_invoice_payment(uuid) to authenticated;
