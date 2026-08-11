-- Your messages: enough on a row to decide which conversation to open.
--
-- The list showed a subject and a reference, so the only way to find out
-- whether we had answered was to open every thread -- and the strongest control
-- on the screen was "New request". That combination is how one question becomes
-- three threads, which is what the live queue actually looks like.
--
-- The row now carries who spoke last and what they said. Both are denormalised
-- onto the thread rather than fetched as a second query, because the list is
-- read on a phone on a shop floor and one round trip is the difference between
-- a list that is there and a list that is arriving.
--
-- No new visibility surface: support_messages' select policy is
-- can_see_support_thread(thread_id), which is the same predicate as the
-- thread's own (20260825000000, 20260825000600). Anyone who can read this
-- column could already read the message it was copied from.
alter table public.support_threads
  add column last_message_preview text,
  -- Constrained to the same two values as support_messages.author_kind. A
  -- preview whose author is unknown renders as neither "You" nor "Kaiibi",
  -- which is the one thing the line exists to say.
  add column last_author_kind text check (last_author_kind in ('shop', 'platform'));

-- No new grant: select on support_threads is table-wide (20260825000000), and
-- update is granted per column -- shop_read_at only -- so neither of these is
-- writable by a client. The trigger below is the only writer, and it is
-- security definer.

-- Unchanged from 20260825000000 except for the two new assignments. Restated in
-- full rather than patched, because a create-or-replace is the whole body and a
-- reader of this file needs to see what the trigger does now, not a diff.
create or replace function public.touch_support_thread()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz := now();
begin
  update public.support_threads
     set last_message_at = v_now,
         -- Writing marks it read for the end that wrote, and only that end.
         shop_read_at = case when new.author_kind = 'shop' then v_now else shop_read_at end,
         platform_read_at = case when new.author_kind = 'platform' then v_now else platform_read_at end,
         last_author_kind = new.author_kind,
         -- Whitespace collapsed before truncating, so a body that opens with a
         -- blank line does not spend the whole preview on nothing. 160 is well
         -- past what one line of a phone-width row can show; the client
         -- truncates to the space it actually has, and this only bounds what
         -- travels.
         --
         -- Collapsed BEFORE trimming, not after: btrim() with no character list
         -- strips spaces and nothing else, so a body opening with a newline
         -- would survive a btrim and come out with a leading space.
         last_message_preview = left(btrim(regexp_replace(new.body, '\s+', ' ', 'g')), 160)
   where id = new.thread_id;
  return new;
end;
$$;
revoke execute on function public.touch_support_thread() from public;

-- Existing threads. Without this every conversation opened before today shows a
-- row with no preview line -- and the threads people are waiting on answers for
-- are exactly the old ones.
--
-- distinct on (thread_id) ordered by created_at desc: the same "last message"
-- the trigger will maintain from here. id breaks a tie between two messages
-- written in the same transaction, so the backfill is deterministic rather than
-- whichever row the planner reached first.
update public.support_threads t
   set last_message_preview = m.preview,
       last_author_kind = m.author_kind
  from (
    select distinct on (thread_id)
           thread_id,
           author_kind,
           left(btrim(regexp_replace(body, '\s+', ' ', 'g')), 160) as preview
      from public.support_messages
     order by thread_id, created_at desc, id desc
  ) m
 where m.thread_id = t.id;
