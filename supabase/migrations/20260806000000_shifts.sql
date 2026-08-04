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

-- Reading your own shifts needs no permission -- that is what makes the /me
-- view work for an ordinary cashier, and it mirrors the existing
-- "staff reads own membership" policy on shop_members.
create policy "read own shifts" on public.shifts for select
  using (exists (
    select 1 from public.shop_members m
    where m.id = shop_member_id and m.user_id = auth.uid()
  ));

create policy "read shop shifts" on public.shifts for select
  using (has_shop_permission(shop_id, 'people.schedule.manage'));

create policy "write shop shifts" on public.shifts for all
  using (has_shop_permission(shop_id, 'people.schedule.manage'))
  with check (has_shop_permission(shop_id, 'people.schedule.manage'));

grant select, insert, update, delete on public.shifts to authenticated;
