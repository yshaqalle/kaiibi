-- Staff photos. Nullable: a shop that never uploads one is not incomplete,
-- and the roster falls back to initials.
--
-- The URL is public, like product images: it points into the same
-- `product-images` bucket, whose RLS is keyed off the first path segment
-- being the shop id rather than the kind of image (migration 0002), so no
-- new bucket or policy is needed.
alter table public.shop_members add column if not exists photo_url text;

-- Nothing to add to "write shop_members roster" (20260802030200_hr_schema.sql):
-- that policy is row-level, not column-scoped -- it already grants staff.manage
-- OR people.payroll.manage the whole shop_members row, photo_url included.

-- ---------------------------------------------------------------------------
-- Roster listing
-- ---------------------------------------------------------------------------

-- list_shop_staff declares an explicit return column list, and a `returns
-- table` signature cannot gain a column through `create or replace` -- it has
-- to be dropped and recreated. Body is otherwise unchanged from
-- 20260819000200_shop_members_phone.sql; `photo_url` follows `phone` because
-- it is the same kind of denormalized contact/identity detail.
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
  photo_url text,
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
      m.photo_url,
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
