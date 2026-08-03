-- Payroll: turning worked hours and agreed pay rates into an actual cost in
-- the P&L.
--
-- Labour is usually a shop's largest cost after stock, but it was invisible
-- here: `shop_members` carries pay_type/pay_rate_cents and `time_entries`
-- carries clock in/out, yet nothing turned the two into money. Reporting only
-- read `expenses`, so wages showed up only if somebody remembered to type
-- them in by hand.
--
-- A pay run works the same way a vendor bill does: compute a draft, let it be
-- corrected, then **post** it -- which writes one real row into `expenses`.
-- Keeping `expenses` the single source of truth is what stops derived labour
-- and hand-entered wages from double-counting each other.
--
-- Why the draft is editable: proration for a mid-period joiner, a bonus, a
-- deduction, an agreed correction. Modelling each of those is a large amount
-- of machinery to get wrong; letting a human adjust the computed figure before
-- committing is how payroll actually works.

create table public.payroll_runs (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  period_start date not null,
  period_end date not null,
  status text not null default 'draft' check (status in ('draft','posted')),
  total_cents integer not null default 0 check (total_cents >= 0),
  -- The expense this run generated once posted; null while still a draft.
  expense_id uuid references public.expenses(id) on delete set null,
  posted_at timestamptz,
  posted_by uuid references auth.users(id),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint payroll_runs_period_ordered check (period_end >= period_start)
);
create index payroll_runs_shop_id_idx on public.payroll_runs(shop_id);
create index payroll_runs_shop_period_idx on public.payroll_runs(shop_id, period_start, period_end);

create table public.payroll_run_lines (
  id uuid primary key default gen_random_uuid(),
  payroll_run_id uuid not null references public.payroll_runs(id) on delete cascade,
  shop_member_id uuid not null references public.shop_members(id) on delete cascade,
  -- Frozen at draft time: a later pay rise must not silently restate what a
  -- past run paid, exactly as sale_items freezes unit price and cost.
  member_name text,
  pay_type text check (pay_type in ('hourly','salary','fixed')),
  pay_rate_cents integer,
  hours_worked numeric(10,2),
  -- Starts from the computed figure, then editable until the run is posted.
  amount_cents integer not null default 0 check (amount_cents >= 0),
  note text,
  created_at timestamptz not null default now()
);
create index payroll_run_lines_run_id_idx on public.payroll_run_lines(payroll_run_id);

alter table public.expenses add column if not exists payroll_run_id uuid references public.payroll_runs(id) on delete cascade;
create index expenses_payroll_run_id_idx on public.expenses(payroll_run_id);

comment on column public.expenses.payroll_run_id is
  'Set when this expense was posted by a pay run. Such rows cannot be edited or deleted directly -- unpost the run instead.';

alter table public.payroll_runs enable row level security;
alter table public.payroll_run_lines enable row level security;

-- Requires *both* permissions, and deliberately so: pay rates are sensitive
-- (people.payroll.manage already gates them -- see the pay-gate migration),
-- and posting writes a real expense (expenses.manage). Neither alone should be
-- enough to move money.
create policy "read payroll_runs" on public.payroll_runs for select
  using (has_shop_permission(shop_id, 'people.payroll.manage') and has_shop_permission(shop_id, 'expenses.manage'));
create policy "write payroll_runs" on public.payroll_runs for all
  using (has_shop_permission(shop_id, 'people.payroll.manage') and has_shop_permission(shop_id, 'expenses.manage'))
  with check (has_shop_permission(shop_id, 'people.payroll.manage') and has_shop_permission(shop_id, 'expenses.manage'));

create policy "read payroll_run_lines" on public.payroll_run_lines for select
  using (exists (
    select 1 from public.payroll_runs r
    where r.id = payroll_run_id
      and has_shop_permission(r.shop_id, 'people.payroll.manage')
      and has_shop_permission(r.shop_id, 'expenses.manage')
  ));
create policy "write payroll_run_lines" on public.payroll_run_lines for all
  using (exists (
    select 1 from public.payroll_runs r
    where r.id = payroll_run_id
      and has_shop_permission(r.shop_id, 'people.payroll.manage')
      and has_shop_permission(r.shop_id, 'expenses.manage')
  ))
  with check (exists (
    select 1 from public.payroll_runs r
    where r.id = payroll_run_id
      and has_shop_permission(r.shop_id, 'people.payroll.manage')
      and has_shop_permission(r.shop_id, 'expenses.manage')
  ));

grant select, insert, update, delete on public.payroll_runs to authenticated;
grant select, insert, update, delete on public.payroll_run_lines to authenticated;

-- Extend the read-only guard on generated expense rows to payroll as well as
-- bills. Recreated in full rather than altered, matching 0024's convention.
drop policy "update expenses" on public.expenses;
create policy "update expenses" on public.expenses for update
  using (has_shop_permission(shop_id, 'expenses.manage') and invoice_id is null and payroll_run_id is null)
  with check (has_shop_permission(shop_id, 'expenses.manage') and invoice_id is null and payroll_run_id is null);

drop policy "delete expenses" on public.expenses;
create policy "delete expenses" on public.expenses for delete
  using (has_shop_permission(shop_id, 'expenses.manage') and invoice_id is null and payroll_run_id is null);

-- Commits a draft run: writes one salaries_wages expense for the whole run and
-- flips the status.
--
-- The guards are the point of this function. Paying the same period twice is
-- the easiest and most expensive mistake available here, so:
--   * the row is locked before anything is read, so two concurrent posts
--     can't both see 'draft';
--   * an already-posted run is rejected outright;
--   * a period overlapping another *posted* run is rejected -- catching the
--     "ran it again with slightly different dates" case that a status check
--     alone would sail straight past.
--
-- The expense is dated period_end, not today: posting August's payroll in
-- September must land the cost in August or both months are wrong.
create or replace function public.post_payroll_run(p_run_id uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_run public.payroll_runs%rowtype;
  v_total integer;
  v_expense_id uuid;
  v_overlap_count integer;
begin
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

  select count(*) into v_overlap_count
    from public.payroll_runs r
    where r.shop_id = v_run.shop_id
      and r.id <> v_run.id
      and r.status = 'posted'
      and r.period_start <= v_run.period_end
      and r.period_end >= v_run.period_start;
  if v_overlap_count > 0 then
    raise exception 'another posted pay run already covers part of % to %', v_run.period_start, v_run.period_end;
  end if;

  select coalesce(sum(amount_cents), 0) into v_total
    from public.payroll_run_lines where payroll_run_id = p_run_id;
  if v_total <= 0 then
    raise exception 'this pay run has nothing to pay';
  end if;

  insert into public.expenses (shop_id, occurred_on, amount_cents, category, payment_method, note, created_by, payroll_run_id)
    values (
      v_run.shop_id,
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
$$;

-- The correction path. Deletes the generated expense and returns the run to
-- draft, so a mistake is fixed by amending and re-posting rather than by
-- hand-editing a row that reporting depends on.
create or replace function public.unpost_payroll_run(p_run_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_run public.payroll_runs%rowtype;
begin
  select * into v_run from public.payroll_runs where id = p_run_id for update;
  if v_run.id is null then
    raise exception 'pay run % not found', p_run_id;
  end if;
  if not (public.has_shop_permission(v_run.shop_id, 'people.payroll.manage')
          and public.has_shop_permission(v_run.shop_id, 'expenses.manage')) then
    raise exception 'not authorized to change pay runs for shop %', v_run.shop_id;
  end if;
  if v_run.status <> 'posted' then
    raise exception 'this pay run is not posted';
  end if;

  delete from public.expenses where payroll_run_id = p_run_id;

  update public.payroll_runs set
    status = 'draft', expense_id = null, posted_at = null, posted_by = null, updated_at = now()
  where id = p_run_id;
end;
$$;

grant execute on function public.post_payroll_run(uuid) to authenticated;
grant execute on function public.unpost_payroll_run(uuid) to authenticated;
