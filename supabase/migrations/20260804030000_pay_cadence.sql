-- How often someone is paid, which the schema had no way to express: shop_members
-- recorded what a member earns (pay_type, pay_rate_cents -- monthly for salary)
-- but not the rhythm they receive it on. A shop needs the same person quoted
-- monthly and paid weekly or biweekly.
--
-- pay_cadence is `not null default 'monthly'` rather than nullable so every
-- member has a cadence, existing rows backfill, and there is no "null means
-- monthly" convention to remember. It applies to hourly staff too: cadence is
-- WHEN you are paid, independent of WHAT you are paid.

alter table public.shop_members
  add column pay_cadence text not null default 'monthly'
  check (pay_cadence in ('weekly','biweekly','semimonthly','monthly'));

comment on column public.shop_members.pay_cadence is
  'How often this member is paid. Independent of pay_type and pay_rate_cents, which say what they earn.';

-- Weekly and biweekly cycles need a start date -- "every 14 days from WHEN".
-- Shop-level because a real shop pays everyone on the same day; per-member
-- anchors would mean cutting a separate pay run per anchor. Null until the
-- owner sets one: a silently defaulted anchor would pick everybody's pay days.
-- Monthly and semi-monthly key off calendar boundaries and never read it.
alter table public.shops add column pay_period_anchor date null;

comment on column public.shops.pay_period_anchor is
  'Start date the weekly/biweekly pay cycles count from. Unused by monthly and semi-monthly cadences.';

-- Which cadence a run was built for. Set => the draft included only members on
-- that cadence. Null => an off-cycle run over hand-typed dates covering every
-- active member, which is how every run before this migration was built.
alter table public.payroll_runs
  add column cadence text null
  check (cadence in ('weekly','biweekly','semimonthly','monthly'));

-- post_payroll_run's overlap guard becomes a member-intersection check, which
-- scans payroll_run_lines by member. Only payroll_run_id is indexed today.
create index payroll_run_lines_member_idx on public.payroll_run_lines(shop_member_id);

-- list_shop_staff declares an explicit return column list and blanks pay
-- columns for callers without people.payroll.manage. A column added to the
-- table but not to this function comes back as undefined rather than
-- wrong-but-visible -- which would silently make every member look monthly.
-- Recreated in full, matching this file's convention of replacing rather than
-- patching. pay_cadence is gated with the other pay columns.
--
-- Postgres refuses `create or replace` when the `returns table (...)` column
-- list changes (adding pay_cadence here), so the old signature is dropped
-- first rather than replaced in place.
drop function if exists public.list_shop_staff(uuid);

create function public.list_shop_staff(p_shop_id uuid)
returns table (
  id uuid,
  shop_id uuid,
  user_id uuid,
  role_id uuid,
  role_name text,
  active boolean,
  full_name text,
  email text,
  created_at timestamptz,
  hire_date date,
  pay_type text,
  pay_rate_cents integer,
  pay_cadence text
)
language plpgsql security definer stable set search_path = public as $$
declare
  v_can_see_pay boolean;
begin
  if not public.has_any_shop_permission(
    p_shop_id,
    array['staff.manage', 'people.payroll.manage', 'people.timesheet.view', 'people.timeoff.approve', 'people.schedule.manage']
  ) then
    raise exception 'not authorized for shop %', p_shop_id;
  end if;

  v_can_see_pay := public.has_shop_permission(p_shop_id, 'people.payroll.manage');

  return query
    select
      m.id,
      m.shop_id,
      m.user_id,
      m.role_id,
      coalesce(r.name, '') as role_name,
      m.active,
      m.full_name,
      m.email,
      m.created_at,
      m.hire_date,
      case when v_can_see_pay then m.pay_type else null end as pay_type,
      case when v_can_see_pay then m.pay_rate_cents else null end as pay_rate_cents,
      case when v_can_see_pay then m.pay_cadence else null end as pay_cadence
    from public.shop_members m
      left join public.roles r on r.id = m.role_id
    where m.shop_id = p_shop_id
    order by m.created_at;
end;
$$;

grant execute on function public.list_shop_staff(uuid) to authenticated;
