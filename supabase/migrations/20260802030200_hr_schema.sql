-- Full HR module for the new Team (People) tab: pay/hire info on
-- shop_members, simple clock-in/out shifts, and single-approval-level
-- time-off requests. See docs/superpowers/plans/2026-08-02-people-team-hr.md
-- Global Constraints #5 -- deliberately no breaks/geofencing/photo
-- verification, no pay-periods/payslip engine, no multi-level approval.

alter table public.shop_members add column hire_date date null;
alter table public.shop_members add column pay_type text null
  check (pay_type in ('hourly','salary','fixed'));
alter table public.shop_members add column pay_rate_cents integer null;

create table public.time_entries (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  shop_member_id uuid not null references public.shop_members(id) on delete cascade,
  clock_in timestamptz not null default now(),
  clock_out timestamptz null,
  created_at timestamptz not null default now()
);
create index time_entries_shop_id_idx on public.time_entries(shop_id);
create index time_entries_shop_member_id_idx on public.time_entries(shop_member_id);
-- Powers "does this member have an open shift" lookups (getOpenTimeEntry).
-- unique: also enforces at most one open shift per member, so
-- getOpenTimeEntry's .maybeSingle() can never see more than one row.
create unique index time_entries_open_idx on public.time_entries(shop_member_id) where clock_out is null;

create table public.time_off_requests (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  shop_member_id uuid not null references public.shop_members(id) on delete cascade,
  start_date date not null,
  end_date date not null,
  reason text null,
  status text not null default 'pending' check (status in ('pending','approved','denied')),
  requested_at timestamptz not null default now(),
  decided_by uuid null references auth.users(id) on delete set null,
  decided_at timestamptz null,
  constraint time_off_requests_dates check (end_date >= start_date)
);
create index time_off_requests_shop_id_idx on public.time_off_requests(shop_id);
create index time_off_requests_shop_member_id_idx on public.time_off_requests(shop_member_id);

alter table public.time_entries enable row level security;
alter table public.time_off_requests enable row level security;

-- time_entries: a member manages their own rows outright -- this is the
-- "tap to clock in/out" affordance. Deliberately not restricted to
-- insert-then-only-clock_out-update (no trigger enforcing that shape): app
-- code only ever inserts a fresh row or updates clock_out on an open one,
-- and keeping this simple matches Global Constraints #5.
create policy "member manages own time entries" on public.time_entries for all
  using (exists (
    select 1 from public.shop_members m
    where m.id = shop_member_id and m.user_id = auth.uid() and m.active and m.shop_id = shop_id
  ))
  with check (exists (
    select 1 from public.shop_members m
    where m.id = shop_member_id and m.user_id = auth.uid() and m.active and m.shop_id = shop_id
  ));

-- Manager-side: read team-wide entries (people.timesheet.view covers both
-- "just view hours" and people.payroll.manage's broader access), and
-- correct a forgotten clock-out (people.payroll.manage only).
create policy "manager reads shop time entries" on public.time_entries for select
  using (has_any_shop_permission(shop_id, array['people.timesheet.view','people.payroll.manage']));
create policy "manager corrects shop time entries" on public.time_entries for update
  using (has_shop_permission(shop_id, 'people.payroll.manage'))
  with check (has_shop_permission(shop_id, 'people.payroll.manage'));

grant select, insert, update, delete on public.time_entries to authenticated;

-- time_off_requests: a member creates/reads their own (insert only ever as
-- 'pending' -- they can't self-approve by inserting a decided row); an
-- approver (people.timeoff.approve) gets full read/write to decide them.
-- No self-service edit/cancel of a submitted request in this pass.
create policy "member requests own time off" on public.time_off_requests for insert
  with check (
    status = 'pending'
    and exists (select 1 from public.shop_members m where m.id = shop_member_id and m.user_id = auth.uid() and m.active and m.shop_id = shop_id)
  );
create policy "member reads own time off requests" on public.time_off_requests for select
  using (exists (select 1 from public.shop_members m where m.id = shop_member_id and m.user_id = auth.uid()));
create policy "approver manages shop time off requests" on public.time_off_requests for all
  using (has_shop_permission(shop_id, 'people.timeoff.approve'))
  with check (has_shop_permission(shop_id, 'people.timeoff.approve'));

grant select, insert, update, delete on public.time_off_requests to authenticated;

-- shop_members: split the single "manage shop_members" policy from 0024 so
-- people.payroll.manage/people.timesheet.view roles can read the roster
-- (needed for Team tab list/detail + "Recent shifts" context) without
-- staff.manage, and people.payroll.manage can write pay/hire fields without
-- staff.manage either.
--
-- Explicit trade-off, not re-solved here: Postgres RLS is row-level, not
-- column-level, and this app uses one shared `authenticated` DB role for
-- every signed-in user (RLS differentiates via auth.uid(), not per-
-- permission Postgres roles) -- there is no clean way to let
-- people.payroll.manage write only hire_date/pay_type/pay_rate_cents while
-- blocking it from also writing role_id/active on the same row, short of a
-- trigger or a separate pay table. This accepts the same granularity the
-- rest of the app already uses elsewhere (e.g. sales.edit covers both edit
-- and delete): staff.manage OR people.payroll.manage can write the *whole*
-- shop_members row via "write shop_members roster" below.
drop policy "manage shop_members" on public.shop_members;
create policy "read shop_members" on public.shop_members for select
  using (has_any_shop_permission(shop_id, array['staff.manage','people.payroll.manage','people.timesheet.view','people.timeoff.approve']));
create policy "insert shop_members" on public.shop_members for insert
  with check (has_shop_permission(shop_id, 'staff.manage'));
create policy "write shop_members roster" on public.shop_members for update
  using (has_any_shop_permission(shop_id, array['staff.manage','people.payroll.manage']))
  with check (has_any_shop_permission(shop_id, array['staff.manage','people.payroll.manage']));
create policy "delete shop_members" on public.shop_members for delete
  using (has_shop_permission(shop_id, 'staff.manage'));
-- "staff reads own membership" (0017_roles_and_staff.sql) is untouched --
-- still how a member reads their own row, including the new pay fields.

-- roles: same read split, plus a new "staff reads own role" so any active
-- staff member (e.g. a Cashier with none of the People permissions) can
-- resolve their own role's name/permissions for the self-service /me
-- screen without needing staff.manage or any People-side permission.
drop policy "manage roles" on public.roles;
create policy "read roles" on public.roles for select
  using (has_any_shop_permission(shop_id, array['staff.manage','people.payroll.manage','people.timesheet.view','people.timeoff.approve']));
create policy "write roles" on public.roles for all
  using (has_shop_permission(shop_id, 'staff.manage'))
  with check (has_shop_permission(shop_id, 'staff.manage'));
create policy "staff reads own role" on public.roles for select
  using (exists (
    select 1 from public.shop_members m
    where m.role_id = roles.id and m.user_id = auth.uid() and m.active
  ));
