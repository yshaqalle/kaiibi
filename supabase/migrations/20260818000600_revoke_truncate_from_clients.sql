-- SECURITY FIX: `anon` and `authenticated` could TRUNCATE every table in the
-- public schema.
--
-- RLS does not apply to TRUNCATE. Every policy in this database guards SELECT,
-- INSERT, UPDATE and DELETE, and every one of them is bypassed by a single
-- `truncate table ...`. The privilege came from the Supabase project bootstrap
-- default (`alter default privileges ... grant all on tables to anon,
-- authenticated`, where ALL includes TRUNCATE) -- no migration in this repo
-- ever granted it, which is exactly why it went unnoticed: it is invisible in
-- the migration history and invisible in every policy review.
--
-- The anon key is embedded in the shipped client and readable from any
-- browser's network tab, so this was reachable by anyone who had ever opened
-- the app. Verified before the fix: as `anon`,
--
--   truncate table public.products cascade;
--
-- succeeded and cascaded into sale_items, refund_items,
-- product_location_stock and stock_transfer_items -- every shop's catalogue,
-- sales lines and per-branch stock, gone, with no authentication at all. The
-- same call against platform_admins would have locked every operator out of
-- the back office permanently.
--
-- 43 tables were exposed.
--
-- TRIGGER and REFERENCES go with it. Neither is used by the app at runtime --
-- triggers and foreign keys are created by migrations, which run as `postgres`
-- -- and TRIGGER on a table is an escalation primitive: it lets a caller attach
-- their own function to someone else's writes.
--
-- service_role deliberately keeps everything. It is the trusted backend
-- identity, its key never ships to a client, and 0022_service_role_grants.sql
-- exists precisely so edge functions can do privileged work.

revoke truncate, trigger, references on all tables in schema public from anon, authenticated;

-- Existing tables are only half of it. Without this, the next `create table` in
-- the next migration silently re-opens the hole for that table, and the fix
-- above reads as permanent when it is actually a one-time sweep.
alter default privileges for role postgres in schema public
  revoke truncate, trigger, references on tables from anon, authenticated;

-- The bootstrap defaults were installed by `supabase_admin`, and a default ACL
-- can only be changed by the role that owns it. `postgres` is not a member of
-- supabase_admin on a managed project, so this is attempted and allowed to
-- fail: the `for role postgres` clause above already covers every table this
-- project creates, since migrations run as postgres. Wrapped rather than
-- omitted so the intent is recorded, and so it takes effect anywhere the
-- permission does exist (a local stack, a self-hosted deployment).
do $$
begin
  execute 'alter default privileges for role supabase_admin in schema public '
       || 'revoke truncate, trigger, references on tables from anon, authenticated';
exception when insufficient_privilege or undefined_object then
  raise notice 'skipped supabase_admin default privileges (not permitted here) -- postgres defaults cover this project''s tables';
end $$;
