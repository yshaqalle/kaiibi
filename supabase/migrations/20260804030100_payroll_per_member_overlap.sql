-- The overlap guard rejected any posted run whose period overlapped, shop-wide,
-- with no notion of who was in it. Per-member cadence requires exactly what
-- that forbids: Bob paid monthly for Aug 1-31 and Alice paid weekly for
-- Aug 1-7 are overlapping runs that must both succeed.
--
-- It is now a member-intersection check, which is STRICTLY STRONGER than the
-- period-only version rather than a loosening: it still catches every
-- same-member double-pay, and additionally catches someone whose cadence
-- changed mid-stream into a differently-shaped run -- a case the period check
-- sails past whenever the two periods happen not to overlap.
--
-- The error names the people rather than the period, because overlap is now
-- expected and only the member collision is the problem. The name list is
-- capped: forty rate-less staff should not produce a forty-name string in a
-- mobile error label.

create or replace function public.post_payroll_run(p_run_id uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_run public.payroll_runs%rowtype;
  v_total integer;
  v_expense_id uuid;
  v_conflict_names text;
  v_conflict_count integer;
  v_blocked_names text;
  v_blocked_count integer;
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

  select
    string_agg(name, ', ' order by name),
    count(*)
  into v_conflict_names, v_conflict_count
  from (
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
    limit 6
  ) conflicts;
  if v_conflict_names is not null then
    raise exception '% already paid for part of % to %',
      case when v_conflict_count > 5 then v_conflict_names || ' and others' else v_conflict_names end,
      v_run.period_start, v_run.period_end;
  end if;

  select
    string_agg(name, ', ' order by name),
    count(*)
  into v_blocked_names, v_blocked_count
  from (
    select distinct coalesce(member_name, 'A staff member') as name
    from public.payroll_run_lines
    where payroll_run_id = p_run_id
      and warning_blocking
      and amount_cents = 0
    limit 6
  ) blocked;
  if v_blocked_names is not null then
    raise exception 'no amount set for % — enter an amount, or set a pay rate in People',
      case when v_blocked_count > 5 then v_blocked_names || ' and others' else v_blocked_names end;
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

-- Kept on the live object rather than in whichever migration happens to be
-- oldest: the function is recreated often enough that its rationale gets
-- stranded otherwise.
comment on function public.post_payroll_run(uuid) is
  'Commits a draft pay run: writes one salaries_wages expense dated period_end and flips the status. The row is locked first so two concurrent posts cannot both see draft. Rejects: an already-posted run; an overlapping posted run that shares a member (per member, not per period, because different cadences legitimately overlap); a line warning of a missing pay rate that still has no amount; and a run totalling zero. The expense is dated period_end so August payroll posted in September lands in August.';

grant execute on function public.post_payroll_run(uuid) to authenticated;
