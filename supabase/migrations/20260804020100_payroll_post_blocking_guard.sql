-- Refuses to post a run whose line warns of a missing pay rate and still has no
-- amount. That case pays a real person zero and records it in the P&L as fact.
--
-- The guard tests amount_cents = 0 rather than the presence of the warning, so
-- typing an amount into the run editor clears the block -- which is what the
-- editor is for (a one-off contractor, a mid-period joiner, an agreed
-- correction). The warning stays on the row afterwards as audit history, so
-- resolving it is not the same as erasing it.
--
-- Placed before the "nothing to pay" check: a run whose only lines are blocked
-- would trip both, and naming the person is more useful than "nothing to pay".

create or replace function public.post_payroll_run(p_run_id uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_run public.payroll_runs%rowtype;
  v_total integer;
  v_expense_id uuid;
  v_overlap_count integer;
  v_blocked_names text;
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

  select string_agg(coalesce(member_name, 'A staff member'), ', ' order by member_name)
    into v_blocked_names
    from public.payroll_run_lines
    where payroll_run_id = p_run_id
      and warning_blocking
      and amount_cents = 0;
  if v_blocked_names is not null then
    raise exception 'no amount set for % — enter an amount, or set a pay rate in People', v_blocked_names;
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

grant execute on function public.post_payroll_run(uuid) to authenticated;
