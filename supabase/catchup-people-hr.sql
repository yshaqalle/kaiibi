-- ---------------------------------------------------------------------------
-- Catch-up script: brings a live database that already has 20260802030200_hr_schema.sql
-- applied (time_entries / time_off_requests / shop_members pay columns exist)
-- up to the full state of the People + Team(HR) branch.
--
-- Safe to re-run: every statement is idempotent (IF NOT EXISTS / DROP ... IF EXISTS).
-- Covers the parts confirmed missing on the live DB plus the post-application
-- fixes to hr_schema that were made after it was applied by hand.
-- ---------------------------------------------------------------------------

-- 1. customers.notes  (20260802030000_customers_notes.sql)
--    THIS IS THE ONE CAUSING "Could not save this customer." -- the app writes
--    `notes` on every insert/update and the column does not exist yet.
alter table public.customers add column if not exists notes text null;

-- 2. Purchase-history read access (20260802030100_customer_purchase_history_access.sql)
--    Lets a customers.view-only role read the sales rows behind a customer's
--    stats / purchase history.
drop policy if exists "read sales" on public.sales;
create policy "read sales" on public.sales for select
  using (has_any_shop_permission(shop_id, array['sales.view', 'dashboard.view', 'customers.view']));

drop policy if exists "read sale_items" on public.sale_items;
create policy "read sale_items" on public.sale_items for select
  using (exists (
    select 1 from public.sales s where s.id = sale_id
      and has_any_shop_permission(s.shop_id, array['sales.view', 'dashboard.view', 'customers.view'])
  ));

-- 3. Non-contiguous date ranges (20260802030300_add_date_ranges_to_time_off.sql)
alter table public.time_off_requests add column if not exists date_ranges jsonb default '[]'::jsonb;

update public.time_off_requests
set date_ranges = jsonb_build_array(jsonb_build_object('startDate', start_date, 'endDate', end_date))
where start_date is not null and end_date is not null
  and (date_ranges is null or date_ranges = '[]'::jsonb);

create index if not exists idx_time_off_requests_date_ranges
  on public.time_off_requests using gin (date_ranges);

comment on column public.time_off_requests.date_ranges is
  'Array of date ranges: [{startDate: "YYYY-MM-DD", endDate: "YYYY-MM-DD"}, ...]';

-- 4. hr_schema corrections made after it was applied by hand.
--    4a. Cross-tenant write guard. The original subqueries compared an
--        unqualified `shop_id`, which Postgres resolves to shop_members.shop_id
--        (the INNER table) -- a tautology that let a member of shop A insert a
--        row carrying shop B's id. The outer table must be named explicitly.
drop policy if exists "member manages own time entries" on public.time_entries;
create policy "member manages own time entries" on public.time_entries for all
  using (exists (
    select 1 from public.shop_members m
    where m.id = shop_member_id and m.user_id = auth.uid() and m.active and m.shop_id = time_entries.shop_id
  ))
  with check (exists (
    select 1 from public.shop_members m
    where m.id = shop_member_id and m.user_id = auth.uid() and m.active and m.shop_id = time_entries.shop_id
  ));

--    4b. Roster/roles read access for a time-off approver, so the approval list
--        can resolve WHOSE request it is showing.
drop policy if exists "read shop_members" on public.shop_members;
create policy "read shop_members" on public.shop_members for select
  using (has_any_shop_permission(shop_id, array['staff.manage','people.payroll.manage','people.timesheet.view','people.timeoff.approve']));

drop policy if exists "read roles" on public.roles;
create policy "read roles" on public.roles for select
  using (has_any_shop_permission(shop_id, array['staff.manage','people.payroll.manage','people.timesheet.view','people.timeoff.approve']));

--    4c. One open shift per member. Without UNIQUE, two open rows make
--        getOpenTimeEntry()'s .maybeSingle() throw forever, permanently
--        breaking that employee's clock widget.
--        Close any pre-existing duplicate open shifts first, keeping the newest,
--        so the unique index can actually be created.
update public.time_entries t
set clock_out = now()
where t.clock_out is null
  and exists (
    select 1 from public.time_entries other
    where other.shop_member_id = t.shop_member_id
      and other.clock_out is null
      and other.clock_in > t.clock_in
  );

drop index if exists public.time_entries_open_idx;
create unique index time_entries_open_idx
  on public.time_entries(shop_member_id) where clock_out is null;

-- 5. Employees manage their own time-off requests
--    (20260803000000_allow_employee_timeoff_update.sql)
drop policy if exists "member requests own time off" on public.time_off_requests;
drop policy if exists "member creates own pending time off" on public.time_off_requests;
drop policy if exists "member reads own time off requests" on public.time_off_requests;
drop policy if exists "member updates own pending time off" on public.time_off_requests;
drop policy if exists "member deletes own time off" on public.time_off_requests;
drop policy if exists "approver manages shop time off requests" on public.time_off_requests;

create policy "member creates own pending time off" on public.time_off_requests for insert
  with check (
    status = 'pending'
    and exists (select 1 from public.shop_members m where m.id = shop_member_id and m.user_id = auth.uid() and m.active and m.shop_id = time_off_requests.shop_id)
  );

create policy "member reads own time off requests" on public.time_off_requests for select
  using (exists (select 1 from public.shop_members m where m.id = shop_member_id and m.user_id = auth.uid()));

create policy "member updates own pending time off" on public.time_off_requests for update
  using (
    status = 'pending'
    and exists (select 1 from public.shop_members m where m.id = shop_member_id and m.user_id = auth.uid() and m.active and m.shop_id = time_off_requests.shop_id)
  )
  with check (
    status = 'pending'
    and exists (select 1 from public.shop_members m where m.id = shop_member_id and m.user_id = auth.uid() and m.active and m.shop_id = time_off_requests.shop_id)
  );

create policy "member deletes own time off" on public.time_off_requests for delete
  using (
    exists (select 1 from public.shop_members m where m.id = shop_member_id and m.user_id = auth.uid() and m.active and m.shop_id = time_off_requests.shop_id)
  );

create policy "approver manages shop time off requests" on public.time_off_requests for all
  using (has_shop_permission(shop_id, 'people.timeoff.approve'))
  with check (has_shop_permission(shop_id, 'people.timeoff.approve'));
