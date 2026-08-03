-- Allow employees to update/cancel their own time off requests
-- Employees can update pending requests (before approval)
-- Employees can delete pending or approved requests (to change mind/cancel)

-- Drop old restrictive policies
drop policy if exists "member requests own time off" on public.time_off_requests;
drop policy if exists "member reads own time off requests" on public.time_off_requests;
-- Also recreated verbatim below, so it must be dropped first -- 20260802030200_hr_schema.sql
-- already created a policy with this exact name, and CREATE POLICY has no OR REPLACE form.
drop policy if exists "approver manages shop time off requests" on public.time_off_requests;

-- Member can create/insert pending requests
create policy "member creates own pending time off" on public.time_off_requests for insert
  with check (
    status = 'pending'
    and exists (select 1 from public.shop_members m where m.id = shop_member_id and m.user_id = auth.uid() and m.active and m.shop_id = time_off_requests.shop_id)
  );

-- Member can read their own requests
create policy "member reads own time off requests" on public.time_off_requests for select
  using (exists (select 1 from public.shop_members m where m.id = shop_member_id and m.user_id = auth.uid()));

-- Member can update pending requests (before approval)
create policy "member updates own pending time off" on public.time_off_requests for update
  using (
    status = 'pending'
    and exists (select 1 from public.shop_members m where m.id = shop_member_id and m.user_id = auth.uid() and m.active and m.shop_id = time_off_requests.shop_id)
  )
  with check (
    status = 'pending'
    and exists (select 1 from public.shop_members m where m.id = shop_member_id and m.user_id = auth.uid() and m.active and m.shop_id = time_off_requests.shop_id)
  );

-- Member can delete their own pending OR approved requests (cancel/withdraw)
create policy "member deletes own time off" on public.time_off_requests for delete
  using (
    exists (select 1 from public.shop_members m where m.id = shop_member_id and m.user_id = auth.uid() and m.active and m.shop_id = time_off_requests.shop_id)
  );

-- Approver still manages shop requests (approve/deny)
create policy "approver manages shop time off requests" on public.time_off_requests for all
  using (has_shop_permission(shop_id, 'people.timeoff.approve'))
  with check (has_shop_permission(shop_id, 'people.timeoff.approve'));
