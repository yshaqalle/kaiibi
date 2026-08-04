-- Who works when. The app recorded what already happened -- time_entries for
-- clocked hours, time_off_requests for approved leave -- but had no way to say
-- what is going to happen, so an owner couldn't tell staff when to come in and
-- staff couldn't look up their own next shift.
--
-- Times are 'HH:MM' local wall-clock text, the same convention opening_hours
-- uses: a shift at 09:00 is at 09:00 regardless of daylight saving or the
-- viewer's device. Zero-padding makes the lexicographic end > start comparison
-- correct, and one representation runs from here to the UI.
--
-- Format CHECKs are included here although they were declined for
-- shops.opening_hours. That is not inconsistency: this is a one-line regex on a
-- scalar column, not a recursive JSONB shape constraint that would need
-- rewriting the moment the shape gains split shifts.
--
-- Overnight shifts crossing midnight are rejected, the same limitation opening
-- hours has and for the same reason: an end before a start is more often a typo
-- than an intention.

create table public.shifts (
  id             uuid primary key default gen_random_uuid(),
  shop_id        uuid not null references public.shops(id) on delete cascade,
  shop_member_id uuid not null references public.shop_members(id) on delete cascade,
  shift_date     date not null,
  start_time     text not null check (start_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  end_time       text not null check (end_time   ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  note           text,
  created_by     uuid references auth.users(id),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint shifts_time_ordered check (end_time > start_time)
);

-- The week view queries one shop's shifts for a seven-day range; /me queries
-- one member's upcoming shifts.
create index shifts_shop_date_idx on public.shifts(shop_id, shift_date);
create index shifts_member_date_idx on public.shifts(shop_member_id, shift_date);

alter table public.shifts enable row level security;

-- security definer, like user_has_shop_permission/has_shop_permission/
-- is_shop_member above: an inline `exists (select 1 from shop_members ...)`
-- inside a WITH CHECK runs under the CALLER's RLS, not bypassing it, because
-- it is not itself a security definer function call -- only has_shop_permission
-- is. A scheduler holding only people.schedule.manage does not satisfy
-- "read shop_members" (staff.manage/people.payroll.manage/
-- people.timesheet.view/people.timeoff.approve -- see hr_schema.sql), and is
-- not reading their own row either, so an inline exists here would see zero
-- rows and reject the insert for every teammate but the caller themself. This
-- wraps the same lookup in security definer so it evaluates against the real
-- table contents instead of what the caller's RLS lets them see.
create or replace function public.shop_member_in_shop(p_member_id uuid, p_shop_id uuid)
returns boolean
language sql security definer stable set search_path = public as $$
  select exists (select 1 from public.shop_members m where m.id = p_member_id and m.shop_id = p_shop_id);
$$;
grant execute on function public.shop_member_in_shop(uuid, uuid) to authenticated;

-- Reading your own shifts needs no permission -- that is what makes the /me
-- view work for an ordinary cashier. The real precedent is time_entries
-- (20260802030200_hr_schema.sql), the sibling HR child table with the same
-- shop_id + shop_member_id shape, not shop_members' own-membership policy --
-- that one deliberately stays permissive because it guards the row you must
-- read to resolve your shop at login. Like time_entries, the own-row check
-- here requires the membership to be active (a deactivated member should
-- lose read access, not keep it) and requires the membership's shop_id to
-- agree with the shift's shop_id (without that, a shift row for a member of
-- a different shop would still be readable by that member, and would sit in
-- a shop's shift list under a member id that doesn't belong to that shop's
-- roster).
create policy "read own shifts" on public.shifts for select
  using (exists (
    select 1 from public.shop_members m
    where m.id = shop_member_id and m.user_id = auth.uid() and m.active and m.shop_id = shifts.shop_id
  ));

-- This predicate is identical to "write shop shifts" below, and since that
-- policy is `for all`, Postgres ORs the two together so each independently
-- grants SELECT -- the overlap is deliberate, matching payroll_runs, roles
-- and time_off_requests. Narrowing this policy alone would not narrow
-- anything: the write policy would keep granting the broader read.
create policy "read shop shifts" on public.shifts for select
  using (has_shop_permission(shop_id, 'people.schedule.manage'));

create policy "write shop shifts" on public.shifts for all
  using (has_shop_permission(shop_id, 'people.schedule.manage'))
  with check (
    has_shop_permission(shop_id, 'people.schedule.manage')
    and public.shop_member_in_shop(shop_member_id, shifts.shop_id)
  );

grant select, insert, update, delete on public.shifts to authenticated;
