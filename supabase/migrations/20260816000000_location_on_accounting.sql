-- The money side: what each store costs and earns.
--
-- This is what makes per-store P&L real. Sales already carry a store
-- (20260809000000) and stock already moves per store (20260810000000), but
-- costs did not -- so a report could tell you what a store took and never what
-- it spent, which is half a picture and the less useful half.
--
-- ## Nullable here, required in 20260815000000, and that asymmetry is the point
--
-- A shift or a clock-in without a store is a gap in the data. A COST without a
-- store is often the truth: the annual licence, the accountant's fee, a
-- marketing push for the whole business. Forcing those onto a store would
-- quietly inflate that store's costs and flatter every other one.
--
-- So null means "business-wide", and it is a first-class value, not a missing
-- one. A per-store P&L shows a store's own costs; a business P&L shows
-- everything. Neither double-counts, and the difference between them is exactly
-- the unattributed overhead -- which is itself worth being able to see.
--
-- Existing rows are left NULL rather than backfilled to the primary store. That
-- is the one place this migration deliberately differs from every other
-- backfill so far: assigning historical costs to a store would be inventing an
-- attribution nobody recorded, and for a shop that has only ever had one store
-- the two readings are identical anyway.

-- ---------------------------------------------------------------------------
-- expenses -- the single source of truth for cost (see 20260804000200)
-- ---------------------------------------------------------------------------

alter table public.expenses add column location_id uuid references public.shop_locations(id);
comment on column public.expenses.location_id is
  'Which store incurred this cost. NULL = business-wide (head office, licences, group marketing) and is a real value, not a gap — per-store P&L excludes it, business P&L includes it.';
create index expenses_location_idx on public.expenses(shop_id, location_id, occurred_on);

-- ---------------------------------------------------------------------------
-- invoices -- vendor bills, which post into expenses when recorded
-- ---------------------------------------------------------------------------

-- A bill IS an unpaid expense (20260804000300), and sync_invoice_expense keeps
-- the two in step. The store has to travel with it, or a bill attributed to the
-- Berbera store would post a cost with no store at all and silently drop out of
-- that store's P&L.
alter table public.invoices add column location_id uuid references public.shop_locations(id);
create index invoices_location_idx on public.invoices(shop_id, location_id, due_on);

-- ---------------------------------------------------------------------------
-- The forward-looking half: bills to come, budgets, payroll, promotions
-- ---------------------------------------------------------------------------

alter table public.recurring_bills add column location_id uuid references public.shop_locations(id);
create index recurring_bills_location_idx on public.recurring_bills(shop_id, location_id);

alter table public.budgets add column location_id uuid references public.shop_locations(id);
create index budgets_location_idx on public.budgets(shop_id, location_id);

-- Payroll is per store because staffing is: a run for the Hargeisa store is the
-- labour cost of that store, and posting it produces an expense that should
-- land there too.
alter table public.payroll_runs add column location_id uuid references public.shop_locations(id);
create index payroll_runs_location_idx on public.payroll_runs(shop_id, location_id);

-- A promotion can be store-specific (clearing slow stock at one branch) or
-- business-wide (a seasonal campaign). Null is the latter, and stays the
-- default so every existing promotion keeps applying everywhere.
alter table public.promotions add column location_id uuid references public.shop_locations(id);
create index promotions_location_idx on public.promotions(shop_id, location_id);

-- ---------------------------------------------------------------------------
-- Carrying the store through the RPCs that create rows
-- ---------------------------------------------------------------------------

-- sync_invoice_expense mirrors a bill into expenses (20260804000300: "a bill is
-- an unpaid expense"). Reproduced at its current body with only the store
-- carried across -- without it, a bill attributed to one store would post a
-- cost with no store at all and drop out of that store's P&L.
create or replace function public.sync_invoice_expense() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    insert into public.expenses (shop_id, location_id, occurred_on, amount_cents, category, vendor_id, payment_method, note, created_by, invoice_id)
      values (
        new.shop_id,
        new.location_id,
        -- The issue date, not today: a bill dated last month is last month's
        -- cost however late it gets entered.
        new.issued_on,
        new.amount_cents,
        new.category,
        new.vendor_id,
        'other',
        coalesce(nullif(new.description, ''), 'Bill ' || new.invoice_number),
        new.created_by,
        new.id
      );
    return new;
  end if;

  update public.expenses set
    location_id = new.location_id,
    occurred_on = new.issued_on,
    amount_cents = new.amount_cents,
    category = new.category,
    vendor_id = new.vendor_id,
    note = coalesce(nullif(new.description, ''), 'Bill ' || new.invoice_number),
    updated_at = now()
  where invoice_id = new.id;
  return new;
end;
$$;

-- log_recurring_bill turns a recurring template into a real expense and rolls
-- the due date forward. Same treatment: the template's store travels onto the
-- cost it generates, so a rent template for one store keeps charging that store
-- every month without anyone re-picking it.
create or replace function public.log_recurring_bill(p_bill_id uuid, p_occurred_on date default null)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_bill public.recurring_bills%rowtype;
  v_expense_id uuid;
  v_interval interval;
begin
  select * into v_bill from public.recurring_bills where id = p_bill_id for update;
  if v_bill.id is null then
    raise exception 'recurring bill % not found', p_bill_id;
  end if;
  if not public.has_shop_permission(v_bill.shop_id, 'expenses.manage') then
    raise exception 'not authorized to log expenses for shop %', v_bill.shop_id;
  end if;

  insert into public.expenses (shop_id, location_id, occurred_on, amount_cents, category, vendor_id, payment_method, note, created_by)
    values (
      v_bill.shop_id,
      v_bill.location_id,
      -- Defaults to the date the bill was due, not today: logging last week's
      -- rent a few days late shouldn't move the cost into this week.
      coalesce(p_occurred_on, v_bill.next_due_date),
      v_bill.amount_cents,
      v_bill.category,
      v_bill.vendor_id,
      v_bill.payment_method,
      v_bill.name,
      auth.uid()
    )
    returning id into v_expense_id;

  v_interval := case v_bill.frequency
    when 'weekly' then interval '7 days'
    when 'biweekly' then interval '14 days'
    when 'monthly' then interval '1 month'
    when 'quarterly' then interval '3 months'
    else interval '1 year'
  end;

  update public.recurring_bills
    set next_due_date = next_due_date + v_interval, updated_at = now()
    where id = p_bill_id;

  return v_expense_id;
end;
$$;
