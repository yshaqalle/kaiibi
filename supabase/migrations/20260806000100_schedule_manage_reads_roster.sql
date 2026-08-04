-- shifts.sql (20260806000000) gated the schedule on people.schedule.manage,
-- but "read shop_members" and "read roles" (20260802030200_hr_schema.sql)
-- never learned about it: their permission arrays still enumerate only
-- staff.manage/people.payroll.manage/people.timesheet.view/
-- people.timeoff.approve. A scheduler holding only people.schedule.manage
-- could therefore write a rota but not resolve the names or roles behind
-- the shop_member_id values on it -- the week view would have shifts with
-- no way to label its rows.
--
-- This is a follow-up migration rather than an in-place edit of
-- hr_schema.sql: unlike shifts.sql, hr_schema.sql already shipped to
-- databases other than local (it is on main), so it can no longer be
-- amended.
--
-- Note this is independent of, and does not substitute for, the
-- shop_member_in_shop() fix in shifts.sql: granting roster read here does
-- not change what write shop shifts' WITH CHECK evaluates, it only lets a
-- scheduler look up who they're scheduling.
drop policy "read shop_members" on public.shop_members;
create policy "read shop_members" on public.shop_members for select
  using (has_any_shop_permission(shop_id, array['staff.manage','people.payroll.manage','people.timesheet.view','people.timeoff.approve','people.schedule.manage']));

drop policy "read roles" on public.roles;
create policy "read roles" on public.roles for select
  using (has_any_shop_permission(shop_id, array['staff.manage','people.payroll.manage','people.timesheet.view','people.timeoff.approve','people.schedule.manage']));
