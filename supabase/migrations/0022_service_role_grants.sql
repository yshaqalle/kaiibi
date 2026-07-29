-- service_role bypasses RLS but still needs ordinary table privileges to
-- touch anything. This project's 0003_grants.sql only ever granted to
-- `authenticated`, so every Edge Function using the service-role client
-- (e.g. provision-staff) gets "permission denied for table X" (42501) from
-- PostgREST. Restore the baseline Supabase normally sets up automatically.
grant usage on schema public to service_role;
grant all on all tables in schema public to service_role;
grant all on all routines in schema public to service_role;
grant all on all sequences in schema public to service_role;

alter default privileges for role postgres in schema public grant all on tables to service_role;
alter default privileges for role postgres in schema public grant all on routines to service_role;
alter default privileges for role postgres in schema public grant all on sequences to service_role;
