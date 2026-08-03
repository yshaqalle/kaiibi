-- The overlap guard rejected any posted run whose period overlapped, shop-wide,
-- with no notion of who was in it. Per-member cadence requires exactly what
-- that forbids: Bob paid monthly for Aug 1-31 and Alice paid weekly for
-- Aug 1-7 are overlapping runs that must both succeed.
--
-- It is now a member-intersection check: the old period predicate plus an
-- `and l.shop_member_id in (...)` conjunct. A conjunction can only narrow the
-- set of rows a WHERE clause matches, so this is a deliberate, scoped
-- NARROWING of the guard, not a strengthening -- every run the new check
-- rejects, the old one also rejected, and not the reverse. It is required
-- because different cadences legitimately overlap (see Bob/Alice above); the
-- old guard made that impossible.
--
-- What this gives up: shop-wide catch-all protection. The old guard blocked
-- ANY two overlapping posted runs in the shop, regardless of who was on
-- them. This one only blocks it when the SAME shop_member_id shows up in
-- both, so any double-pay that doesn't route through a shared
-- shop_member_id now sails through unchecked.
--
-- Known residual risk that narrowing opens: the guard keys on
-- shop_member_id, and shop_members is unique on (shop_id, user_id) --
-- nothing stops two different rows (two staff records, two auth accounts)
-- from being the same human. Two shop_members rows for one person can each
-- be paid over overlapping periods with nothing here to catch it; the old
-- shop-wide guard blocked that case too, incidentally, as a side effect of
-- blocking everything. See the "two shop_members rows, one human" check in
-- verify-accounting-writes.sql, which pins this as known behaviour rather
-- than asserting it's desired.
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
  'Commits a draft pay run: writes one salaries_wages expense dated period_end and flips the status. The row is locked first, which guarantees only that two concurrent posts of the SAME run cannot both see draft; two concurrent posts of DIFFERENT overlapping runs that share a member each lock only their own row and can both succeed -- a pre-existing race, not introduced by the per-member overlap check. Rejects: a run id that does not exist; a caller missing people.payroll.manage or expenses.manage; an already-posted run; an overlapping posted run that shares a member (per member, not per period, because different cadences legitimately overlap); a line warning of a missing pay rate that still has no amount; and a run totalling zero. The expense is dated period_end so August payroll posted in September lands in August.';

grant execute on function public.post_payroll_run(uuid) to authenticated;
