-- Live unread count for the store side.
--
-- Without this the ☰ badge and the banner over the content are only ever as
-- fresh as their last mount: a reply typed by an operator while a tablet sits
-- open on the POS all day is a reply that shop is never told about, and now
-- that we can start a conversation ourselves, an unseen message is a message
-- that never happened.
--
-- Realtime evaluates the SUBSCRIBER's own row-level security, so a client can
-- subscribe to the whole table without a filter and still only ever be handed a
-- message on a thread "read messages on a thread you can see"
-- (20260825000000) already lets it read. The filter that matters is the one
-- already in the database, which is why this is safe to publish table-wide.
--
-- Deliberately narrow. This reaches a device that is awake with the app open;
-- it is not push, and docs/backlog/2026-08-01-notification-delivery.md records
-- the delivery infrastructure that would be as not existing.
--
-- Guarded rather than bare: supabase_realtime is a publication Supabase ships
-- and every project already carries, `add table` raises duplicate_object rather
-- than no-opping, and this file has to be replayable against a database where
-- somebody has already added the table by hand from the dashboard.
do $$
begin
  if not exists (
    select 1
      from pg_publication_tables
     where pubname = 'supabase_realtime'
       and schemaname = 'public'
       and tablename = 'support_messages'
  ) then
    alter publication supabase_realtime add table public.support_messages;
  end if;
end $$;
