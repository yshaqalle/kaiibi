-- Pay data must not leave the database for roles that aren't allowed to see it.
--
-- Postgres RLS is row-level, not column-level, and this app authenticates every
-- signed-in user as the same `authenticated` DB role -- so the "read shop_members"
-- policy can only decide whether a caller sees the *row*, not which columns of it.
-- That meant `listStaff`'s `select('*')` shipped pay_type/pay_rate_cents to anyone
-- who could read the roster at all (staff.manage, people.timesheet.view,
-- people.timeoff.approve), even though the UI hid the values and the CSV export
-- stripped the columns. The data was still on the wire.
--
-- This function is the read path for the Team roster. It returns the same shape
-- as before but blanks the three pay columns unless the caller actually holds
-- people.payroll.manage, so the gate lives in the database rather than in the
-- client that renders it. security definer for the same reason
-- pos_search_customers is (migration 0025): it does its own explicit permission
-- check and hands back only what that check allows.
--
-- A member reading their OWN row (getMyMembership -> the /me self-service screen)
-- deliberately still goes through the table's "staff reads own membership" policy
-- and still sees their own rate -- showing an employee their own pay is the point.
create or replace function public.list_shop_staff(p_shop_id uuid)
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
  pay_rate_cents integer
)
language plpgsql security definer stable set search_path = public as $$
declare
  v_can_see_pay boolean;
begin
  -- Same set the "read shop_members" policy admits, so this function never
  -- widens who can see the roster -- it only narrows which columns they get.
  if not public.has_any_shop_permission(
    p_shop_id,
    array['staff.manage', 'people.payroll.manage', 'people.timesheet.view', 'people.timeoff.approve']
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
      -- hire_date is roster context (who started when), not compensation, so it
      -- stays visible to anyone who can see the roster -- matching the Team
      -- detail pane, which shows the hire-date tile ungated.
      m.hire_date,
      case when v_can_see_pay then m.pay_type else null end as pay_type,
      case when v_can_see_pay then m.pay_rate_cents else null end as pay_rate_cents
    from public.shop_members m
      left join public.roles r on r.id = m.role_id
    where m.shop_id = p_shop_id
    order by m.created_at;
end;
$$;

grant execute on function public.list_shop_staff(uuid) to authenticated;
