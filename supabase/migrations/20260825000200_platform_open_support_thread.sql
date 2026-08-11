-- The operator half of open_support_thread() (20260825000000), for the same
-- reason and against the same failure.
--
-- platform-admin opened a thread with two PostgREST requests -- the thread, then
-- the first message -- and compensated for a rejected message by deleting the
-- thread again. That covers exactly one of the ways two requests fail. A
-- timeout, a dropped connection, an isolate killed between them, or a delete
-- that itself fails all leave the same wreckage: a subject with no body sitting
-- at the top of the store's list on a fresh last_message_at, unanswerable and
-- undeletable (no client holds delete here), while the operator sees a 500 and
-- retries into a duplicate. One transaction is the only place that cannot
-- half-happen.
--
-- PURELY the transaction. The category allow-list, the shop lookup, the
-- addressee-is-staff test and the body length all stay in the edge function, and
-- deliberately do not get a second copy here: a rule written in two places is a
-- rule that drifts, and the one that drifts silently is the one nobody reads.
-- (The check constraints on the two tables are not that -- they are the
-- guarantee the validation is a friendlier restatement OF.)
--
-- The author is an argument, unlike the store-side twin which reads auth.uid().
-- The caller is service_role acting for an operator, so there is no session
-- identity to read -- which is also why execute is granted to service_role
-- alone. Granted to authenticated it would be any shop member opening a
-- platform-opened thread in Kaiibi's name: the exact forgery the insert policy
-- on support_threads refuses, handed back through a definer function that no
-- policy is consulted for.
create or replace function public.platform_open_support_thread(
  p_shop_id uuid,
  p_category text,
  p_subject text,
  p_body text,
  p_addressed_user_id uuid default null,
  p_author_user_id uuid default null
)
returns public.support_threads
language plpgsql
security definer
set search_path = public
as $$
declare
  v_thread public.support_threads;
begin
  insert into public.support_threads (
    shop_id, opened_by, author_user_id, addressed_user_id, category, subject
  ) values (
    -- author_user_id null: the thread is from Kaiibi, not from whichever
    -- operator happened to type it. The individual is recorded on the message.
    p_shop_id, 'platform', null, p_addressed_user_id, p_category, btrim(p_subject)
  )
  returning * into v_thread;

  insert into public.support_messages (thread_id, author_kind, author_user_id, body)
    values (v_thread.id, 'platform', p_author_user_id, btrim(p_body));

  -- Re-read, exactly as open_support_thread() does: support_messages_touch_thread
  -- moved last_message_at and platform_read_at after the row above was captured,
  -- and the stale copy has platform_read_at null -- an operator's own outbound
  -- thread reading as unread in their own queue.
  select * into v_thread from public.support_threads where id = v_thread.id;
  return v_thread;
end;
$$;

-- Postgres grants execute to PUBLIC on every new function, which on a definer
-- function means anon too. Revoked before the one explicit grant, so the grant
-- is the whole list of who can call it.
revoke execute on function public.platform_open_support_thread(uuid, text, text, text, uuid, uuid) from public;
grant execute on function public.platform_open_support_thread(uuid, text, text, text, uuid, uuid) to service_role;
