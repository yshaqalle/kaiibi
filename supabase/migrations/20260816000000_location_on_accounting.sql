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

-- post_payroll_run writes the run's total into expenses. Reproduced from its
-- live definition -- lock ordering, overlap guards and all -- with only the
-- store carried onto the expense.
create or replace function public.post_payroll_run(p_run_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $$
declare
  v_run public.payroll_runs%rowtype;
  v_total integer;
  v_expense_id uuid;
  v_conflict_names text;
  v_conflict_count integer;
  v_blocked_names text;
  v_blocked_count integer;
  v_lock_shop uuid;
begin
  -- Serialises posting within a shop. The row lock below covers only THIS run,
  -- so two different overlapping runs sharing a member each locked a different
  -- row, neither saw the other's uncommitted 'posted' status, and both
  -- succeeded -- paying that member twice. Harmless while the old shop-wide
  -- guard rejected overlapping runs outright; per-member cadence makes
  -- overlapping drafts the normal mode, so the race became reachable.
  --
  -- The shop id is read separately because v_run isn't populated until the
  -- statement below, so the lock key can't be derived from it yet. Transaction-
  -- scoped, so it releases on commit or rollback with nothing to unlock
  -- explicitly. Keyed on the shop, so posts in different shops never block each
  -- other. Taken BEFORE the row lock so every guard below reads committed state
  -- rather than racing a concurrent post.
  --
  -- ADVISORY LOCK CLASSID REGISTRY -- Postgres has ONE global advisory keyspace,
  -- shared by every feature in the database. The two-argument form reserves a
  -- classid so a future caller can't collide with payroll posting:
  --   74920 = payroll posting (this function)
  -- Pick a distinct, non-round classid for any new advisory lock. 1, 2 and 100
  -- are what a naive caller reaches for, which is exactly why they're unsafe.
  select shop_id into v_lock_shop from public.payroll_runs where id = p_run_id;
  if v_lock_shop is null then
    raise exception 'pay run % not found', p_run_id;
  end if;
  perform pg_advisory_xact_lock(74920, hashtext(v_lock_shop::text));

  select * into v_run from public.payroll_runs where id = p_run_id for update;
  if v_run.id is null then
    raise exception 'pay run % not found', p_run_id;
  end if;
  if not (public.has_shop_permission(v_run.shop_id, 'people.payroll.manage')
          and public.has_shop_permission(v_run.shop_id, 'expenses.manage')) then
    raise exception 'not authorized to post pay runs for shop %', v_run.shop_id;
  end if;
  if v_run.status = 'posted' then
    raise exception 'this pay run has already been posted';
  end if;

  with conflicts as (
    select distinct coalesce(l.member_name, 'A staff member') as name
    from public.payroll_runs r
      join public.payroll_run_lines l on l.payroll_run_id = r.id
    where r.shop_id = v_run.shop_id
      and r.id <> v_run.id
      and r.status = 'posted'
      and r.period_start <= v_run.period_end
      and r.period_end   >= v_run.period_start
      and l.shop_member_id in (
        select shop_member_id from public.payroll_run_lines where payroll_run_id = p_run_id
      )
  )
  select
    (select string_agg(name, ', ' order by name) from (select name from conflicts order by name limit 6) top6),
    (select count(*) from conflicts)
  into v_conflict_names, v_conflict_count;
  if v_conflict_names is not null then
    raise exception '% was already paid for part of % to %',
      case when v_conflict_count > 6 then v_conflict_names || ' and others' else v_conflict_names end,
      v_run.period_start, v_run.period_end;
  end if;

  with blocked as (
    select distinct coalesce(member_name, 'A staff member') as name
    from public.payroll_run_lines
    where payroll_run_id = p_run_id
      and warning_blocking
      and amount_cents = 0
  )
  select
    (select string_agg(name, ', ' order by name) from (select name from blocked order by name limit 6) top6),
    (select count(*) from blocked)
  into v_blocked_names, v_blocked_count;
  if v_blocked_names is not null then
    raise exception 'no amount set for % — enter an amount, or set a pay rate in People',
      case when v_blocked_count > 6 then v_blocked_names || ' and others' else v_blocked_names end;
  end if;

  select coalesce(sum(amount_cents), 0) into v_total
    from public.payroll_run_lines where payroll_run_id = p_run_id;
  if v_total <= 0 then
    raise exception 'this pay run has nothing to pay';
  end if;

  insert into public.expenses (shop_id, location_id, occurred_on, amount_cents, category, payment_method, note, created_by, payroll_run_id)
    values (
      v_run.shop_id,
      -- The run's store travels onto the cost it produces. Without this a pay
      -- run for one store would post a business-wide expense, and that store's
      -- P&L would show its revenue with none of its labour against it.
      v_run.location_id,
      v_run.period_end,
      v_total,
      'salaries_wages',
      'cash',
      'Payroll ' || v_run.period_start || ' to ' || v_run.period_end,
      auth.uid(),
      v_run.id
    )
    returning id into v_expense_id;

  update public.payroll_runs set
    status = 'posted',
    total_cents = v_total,
    expense_id = v_expense_id,
    posted_at = now(),
    posted_by = auth.uid(),
    updated_at = now()
  where id = p_run_id;

  return v_expense_id;
end;
$$
