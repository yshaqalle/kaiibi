-- Staff photos. Nullable: a shop that never uploads one is not incomplete,
-- and the roster falls back to initials.
--
-- The URL is public to READ, like product images: the bucket itself is
-- public (migration 0002's "product images public read"), so no SELECT
-- policy change is needed for a photo to be viewable once uploaded.
--
-- Writing one is a different story. As of 0024_permission_gates.sql, the
-- `product-images` insert/delete policies are no longer "any shop member" --
-- they gate on `inventory.edit` or `settings.access`, because the bucket
-- also serves product photos and shop logos. Neither of those is implied by
-- `staff.manage` (see IMPLIED_PERMISSIONS in src/lib/permissions.ts), so an
-- HR-only role could open the roster and add a member but 403 the moment it
-- tried to upload their photo. The insert policy below is amended in place
-- (this migration is unapplied) to also admit `staff.manage`.
--
-- Delete is left alone: nothing in the staff-photo flow ever deletes a
-- storage object (a replacement re-uploads to a new timestamped path and
-- orphans the old one -- see uploadStaffPhoto in src/lib/staff.ts), so a
-- `staff.manage`-only role never needs delete on this bucket to add,
-- replace, or view a staff photo. There is also no UPDATE policy on
-- storage.objects for this bucket at all -- uploads are insert-only.
alter table public.shop_members add column if not exists photo_url text;

-- Re-admit staff.manage to the insert policy 0024_permission_gates.sql
-- defined. Everything else about it -- name, bucket check, structure -- is
-- reproduced verbatim; only the permission array gains a third entry.
drop policy "shop members upload their shop's product images" on storage.objects;
create policy "shop members upload their shop's product images"
  on storage.objects for insert
  with check (
    bucket_id = 'product-images'
    and public.has_any_shop_permission((storage.foldername(name))[1]::uuid, array['inventory.edit', 'settings.access', 'staff.manage'])
  );

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
