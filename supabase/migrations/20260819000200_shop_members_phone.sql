-- A phone number for staff, so the roster can reach the person on it.
--
-- Customers have had one since 0023 and the Team tab had nothing: an admin who
-- needed to tell a cashier about a shift had to leave the app to find their
-- number. Free text, like customers.phone and shops.contact_phone -- merchants
-- write 063 xxx xxxx and whatsappLink() normalizes at link time, which is where
-- the country-code question actually has an answer.
--
-- Denormalized onto shop_members beside full_name/email (0019, 0021) rather
-- than read from profiles.phone: profiles is RLS-locked to `id = auth.uid()`,
-- so an admin listing the roster cannot see anyone's profile but their own.
-- update-staff writes both, the same way it already does for full_name.
alter table public.shop_members add column phone text;

-- ---------------------------------------------------------------------------
-- Roster listing
-- ---------------------------------------------------------------------------

-- list_shop_staff declares an explicit return column list, and a `returns
-- table` signature cannot gain a column through `create or replace` -- it has
-- to be dropped and recreated. Body is otherwise unchanged from
-- 20260814000000_staff_multi_store.sql; `phone` follows `email` because it is
-- the same kind of thing.
--
-- Deliberately NOT pay-gated. The three pay columns are blanked for callers
-- without people.payroll.manage; a phone number is contact detail like email
-- and hire_date, which every caller who can see the roster at all already
-- gets. Gating it would mean a scheduler could see who works Thursday but not
-- how to tell them.
drop function if exists public.list_shop_staff(uuid);

create function public.list_shop_staff(p_shop_id uuid)
returns table (
  id uuid,
  shop_id uuid,
  user_id uuid,
  role_id uuid,
  role_name text,
  location_ids uuid[],
  active boolean,
  full_name text,
  email text,
  phone text,
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
      coalesce(
        (select array_agg(ml.location_id) from public.shop_member_locations ml where ml.shop_member_id = m.id),
        '{}'::uuid[]
      ) as location_ids,
      m.active,
      m.full_name,
      m.email,
      m.phone,
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
