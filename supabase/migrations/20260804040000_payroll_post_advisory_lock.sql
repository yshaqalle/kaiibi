-- The per-member overlap guard (20260804030100) checks committed state via
-- `select * into v_run ... for update`, but that row lock covers only the
-- run being posted. Two different overlapping runs that share a member each
-- lock a DIFFERENT payroll_runs row, so neither sees the other's uncommitted
-- 'posted' status and both can succeed -- paying that member twice. This was
-- harmless while the old shop-wide guard rejected any overlapping run
-- outright; per-member cadence makes overlapping drafts the normal mode, so
-- the race became routinely reachable.
--
-- Fix: a shop-scoped transaction advisory lock, taken before the row lock,
-- so every guard below reads committed state instead of racing a concurrent
-- post of a different run. See the inline comment below for why the shop id
-- is read separately and why the lock is transaction-scoped.
--
-- This closes the race under READ COMMITTED, which is the cluster default
-- and what PostgREST gives every client -- there is no way to request a
-- different isolation level through it. Under a snapshot isolation level
-- (REPEATABLE READ or SERIALIZABLE), the lock still serialises correctly,
-- but a transaction whose snapshot predates the other's commit would not
-- see it as posted and could still pay the member twice. Recorded here
-- because nothing in this repo or cluster can reach that path today, not
-- because it's a live risk.

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
  'Commits a draft pay run: writes one salaries_wages expense dated period_end and flips the status. A shop-scoped transaction advisory lock (keyed on shop_id) is taken before the row lock, serialising all posts within a shop; this closes a pre-existing race where two concurrent posts of DIFFERENT overlapping runs sharing a member each locked only their own row, neither saw the other''s uncommitted ''posted'' status, and both could succeed, paying that member twice. That guarantee holds under READ COMMITTED, which is the cluster default and what PostgREST clients always get; under a snapshot isolation level (REPEATABLE READ or SERIALIZABLE), a transaction whose snapshot predates the other post''s commit would not see it even with the lock held, so the double-pay could still occur there. That path is not reachable today -- nothing in this deployment changes isolation level and PostgREST offers no way to request one -- so it is noted rather than guarded against. Posts in different shops never block each other. Rejects: a run id that does not exist; a caller missing people.payroll.manage or expenses.manage; an already-posted run; an overlapping posted run that shares a member (per member, not per period, because different cadences legitimately overlap); a line warning of a missing pay rate that still has no amount; and a run totalling zero. The expense is dated period_end so August payroll posted in September lands in August.';

grant execute on function public.post_payroll_run(uuid) to authenticated;
