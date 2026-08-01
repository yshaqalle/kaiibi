-- Tracks when the account's password was last changed via Settings →
-- Security's Change Password flow (src/lib/profile.ts's markPasswordChanged,
-- called after a successful src/lib/auth.ts's updatePassword). Only
-- reflects changes made through that flow, not a reset via a
-- forgot-password email link.
alter table public.profiles add column if not exists password_changed_at timestamptz;
