-- Attachments go both ways.
--
-- 20260825000000 gated storage INSERT on is_shop_member((foldername)[1]), which
-- was the right rule when only a store could write a file. An operator is not a
-- member of the shop they are answering -- deliberately, that is the whole
-- point of verify-platform-portal.sql -- so every upload from the console 403s
-- before it reaches the bucket. SELECT already admits is_platform_admin();
-- INSERT never did, so we could hand a store a receipt only by not being able
-- to.
--
-- WHY THE POLICY AND NOT THE EDGE FUNCTION. The alternative was to post the
-- bytes to platform-admin and upload them with the service-role client, which
-- bypasses storage RLS entirely. That moves this feature's one privacy rule --
-- an attachment is exactly as private as the thread it hangs on -- out of
-- can_see_support_thread(), where reads and deletes already ask it, and into a
-- TypeScript re-statement of it that only the write path consults. Two copies
-- of a rule is a rule that drifts, and the half that drifts silently is the one
-- nobody reads. It also means a 10 MB file becomes ~13.4 MB of base64 in an
-- edge function request body and crosses the wire twice, on connections this
-- product treats as scarce -- so the bucket's own 10 MB ceiling would be a
-- limit we advertise and cannot actually deliver.
--
-- The row still goes through platform-admin (that function is the only write
-- path for the console, and an attachment we sent a store belongs in the audit
-- log). This is about the OBJECT.
--
-- What does NOT change: the member branch. A cashier still cannot write outside
-- their own shop, and still cannot write into a thread they cannot see. Adding
-- an operator branch beside it changes nothing about who at a shop can reach
-- whose file.

-- The rule check_support_attachment_path() applies to the ROW, asked of the
-- path before the OBJECT is written.
--
-- The member branch never needed it: is_shop_member(seg1) and
-- can_see_support_thread(seg2) together already pin both segments to that one
-- person's shop. An operator can see EVERY thread, so for them
-- can_see_support_thread is always true and seg1 would be unconstrained --
-- an upload could land in another shop's folder, where the row insert then
-- fails the trigger and leaves the object orphaned in a folder it has no
-- business being in. Asking the same question in both places is what keeps the
-- object and its row describing one file.
create or replace function public.support_thread_in_shop(p_shop_id uuid, p_thread_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.support_threads t
     where t.id = p_thread_id and t.shop_id = p_shop_id
  );
$$;
-- Postgres grants execute to PUBLIC on every new function, which on a definer
-- function means anon too. Revoked before the one explicit grant, so the grant
-- is the whole list of who can call it.
revoke execute on function public.support_thread_in_shop(uuid, uuid) from public;
grant execute on function public.support_thread_in_shop(uuid, uuid) to authenticated;

drop policy "members upload their shop's support attachments" on storage.objects;

create policy "upload a support attachment on a thread you can see"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'support-attachments'
    -- Both segments, both branches. uuid_or_null rather than a raw cast for the
    -- reason 20260825000000 gives at length: a malformed segment must answer
    -- false, not raise.
    and public.support_thread_in_shop(
          public.uuid_or_null((storage.foldername(name))[1]),
          public.uuid_or_null((storage.foldername(name))[2]))
    and public.can_see_support_thread(public.uuid_or_null((storage.foldername(name))[2]))
    and (
      -- is_platform_admin() is the MFA check as well as the membership one: it
      -- reads the `aal` claim off the caller's own JWT (20260818000500). So an
      -- operator whose session has not passed a second factor cannot write a
      -- file into a store's conversation, enforced by the database on the
      -- object rather than by the console on the way to it.
      --
      -- Enforced TWICE, and that is deliberate rather than redundant: the
      -- can_see_support_thread() line above reaches the same function through
      -- support_thread_is_visible(), so an aal1 operator is refused by both.
      -- verify-support.sql check 19 asserts the refusal; weakening only one of
      -- the two leaves the check green (recorded in the gap-4 report), which is
      -- what defence in depth looks like from the outside.
      public.is_platform_admin()
      or public.is_shop_member(public.uuid_or_null((storage.foldername(name))[1]))
    )
  );
