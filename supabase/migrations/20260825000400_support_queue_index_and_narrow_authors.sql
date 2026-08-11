-- Two fixes to the Support tab (task 10), both found in review after
-- 20260825000300 shipped. A NEW file, not an edit to any of the three earlier
-- support migrations: 000000, 000100, 000200 and 000300 are all applied to
-- the remote project, so editing one of them would leave the deployed
-- database and this repository describing different schemas.

-- 1. listSupportThreads() ordered by last_message_at desc with no index that
-- covers it. EXPLAIN on that query showed Seq Scan + Sort: support_threads
-- carries (shop_id, last_message_at) and (status, last_message_at), and
-- neither is usable on a bare order-by with no equality filter in front of
-- last_message_at. The read is also unbounded -- closed threads never leave
-- the list -- so the table keeps growing under a query that gets slower with
-- it. Paired with a .limit(200) in listSupportThreads (src/lib/platform.ts).
create index if not exists support_threads_recent_idx
  on public.support_threads (last_message_at desc);

-- 2. The profiles policy 20260825000300 added was narrow in the one sense its
-- comment argued for -- ROWS: reachable only through support_threads.
-- author_user_id, so a profile that never wrote to support stayed invisible,
-- and verify-platform-portal.sql's negative check proved it. What the comment
-- did not claim, and what was true anyway, is that the GRANT behind it is not
-- narrow: 0003_grants gave `authenticated` table-wide select on `profiles`
-- (0017 narrowed `update` to (full_name, phone), never `select`), so a select
-- policy naming no columns hands back all six -- role and password_changed_at
-- along with the name and phone the console actually shows. Harmless while
-- the app's own query only ever asks for three, but the policy is what an
-- operator's own API access is bounded by, not the app's query string.
--
-- A column-level select grant cannot fix this: grants aren't policy-scoped,
-- so narrowing it would also cut off use-auth.tsx and profile.ts reading
-- their OWN role and password_changed_at through the unrelated "own profile"
-- policy. Replaced with a security-definer function instead, on the same
-- pattern as platform_open_support_thread() -- it returns exactly the three
-- columns the console needs, under its own predicate, regardless of what
-- `authenticated` is granted on the table underneath.
--
-- Widened at the same time to cover message AUTHORS, not just thread
-- OPENERS: someone who only ever replies (support_messages.author_user_id)
-- was nameless in this policy, which task 11's reply rail was going to read
-- as a bug rather than as a gap. support_threads_author_idx (20260825000300)
-- already covers the first exists below; the second gets its own index for
-- the same reason -- support_messages has no index on author_user_id today.
drop policy "operators read the profile of a support author" on public.profiles;

create index if not exists support_messages_author_idx
  on public.support_messages (author_user_id);

create or replace function public.support_author_profiles(p_author_ids uuid[])
returns table (id uuid, full_name text, phone text)
language sql
stable
security definer
set search_path = public
as $$
  select p.id, p.full_name, p.phone
  from public.profiles p
  where public.is_platform_admin()
    and p.id = any(p_author_ids)
    and (
      exists (select 1 from public.support_threads t where t.author_user_id = p.id)
      or exists (select 1 from public.support_messages m where m.author_user_id = p.id)
    );
$$;

-- Postgres grants execute to PUBLIC on every new function, which on a definer
-- function means anon too. Revoked before the one explicit grant, so the
-- grant is the whole list of who can call it.
revoke execute on function public.support_author_profiles(uuid[]) from public;
grant execute on function public.support_author_profiles(uuid[]) to authenticated;
