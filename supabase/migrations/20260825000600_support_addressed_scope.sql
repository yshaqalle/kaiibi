-- Who a thread is for is STORED, not inferred from a nullable foreign key.
--
-- support_thread_is_visible() (20260825000000) answered "this one is for the
-- whole store" by testing `addressed_user_id is null`. That column is
-- `on delete set null`, so the privacy rule was really a function of whether
-- the addressee's auth.users row still existed. Deleting a departed employee
-- from the Supabase dashboard -- ordinary tidying, no code involved, no way to
-- know this feature has an opinion about it -- rewrote an owner-only thread
-- into one every settings.access holder at that shop can read. No error,
-- nothing in any log, and the sentence the outbound composer shows the
-- operator before they send ("Nobody else there sees it -- not even colleagues
-- who can reach Settings") became retroactively false about a message already
-- sent.
--
-- With the scope in its own column the same deletion leaves a thread NOBODY
-- can read, which is the failure worth having: a conversation nobody can open
-- shows up as a problem and can be repaired, while one the wrong people can
-- read is invisible and permanent.
--
-- DO NOT collapse this back to `addressed_user_id is null`. The two agree on
-- every row at the moment it is written and disagree only later -- which is
-- precisely the case the column exists for, and precisely the case no test
-- catches unless it deletes a user (verify-support.sql section 18 does).
--
-- No client can set it: insert and update on support_threads are granted per
-- COLUMN (20260825000000) and this column is on neither list, so a store's own
-- inserts take the 'store' default and a shop-opened thread's scope is inert
-- anyway -- the store branch below also requires opened_by = 'platform'.
alter table public.support_threads
  add column addressed_scope text not null default 'store'
    check (addressed_scope in ('store', 'person'));

-- The old rule is still the right answer for every row that exists today:
-- nothing in the app deletes an auth user (only provision-staff's rollback,
-- which undoes a creation), so no existing null has lost an addressee yet.
update public.support_threads
   set addressed_scope = case when addressed_user_id is null then 'store' else 'person' end;

comment on column public.support_threads.addressed_scope is
  'Who an operator-opened thread is for, as chosen when it was sent. Read by support_thread_is_visible(); addressed_user_id must not be used for this, being on delete set null.';

------------------------------------------------------------------
-- Visibility
------------------------------------------------------------------
-- Takes the scope as a fifth column. Still the COLUMNS form and not a by-id
-- lookup, for the reason 20260825000000 gives: `insert ... returning` runs the
-- select policy against a row no snapshot can see yet.
create or replace function public.support_thread_is_visible(
  p_shop_id uuid,
  p_opened_by text,
  p_author_user_id uuid,
  p_addressed_user_id uuid,
  p_addressed_scope text
)
returns boolean
language sql
stable
set search_path = public
as $$
  select
    -- Operators see everything. This is the back office.
    public.is_platform_admin()
    -- You always see what you wrote.
    or p_author_user_id = auth.uid()
    -- A thread we addressed to one person is that person's. Once that person
    -- is deleted this stops matching anyone and the branch below no longer
    -- picks it up, so the thread falls out of everyone's reach rather than
    -- into everyone's.
    or p_addressed_user_id = auth.uid()
    -- A thread we addressed to the STORE is for whoever runs it.
    or (
      p_opened_by = 'platform'
      and p_addressed_scope = 'store'
      and public.has_shop_permission(p_shop_id, 'settings.access')
    );
$$;
revoke execute on function public.support_thread_is_visible(uuid, text, uuid, uuid, text) from public;
grant execute on function public.support_thread_is_visible(uuid, text, uuid, uuid, text) to authenticated;

create or replace function public.can_see_support_thread(p_thread_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
      from public.support_threads t
     where t.id = p_thread_id
       and public.support_thread_is_visible(
             t.shop_id, t.opened_by, t.author_user_id, t.addressed_user_id, t.addressed_scope)
  );
$$;

-- Recreated rather than left alone: a policy binds the function signature it
-- was written against, so the four-argument one would stay the live rule for
-- reads while the five-argument one sat unused.
drop policy "read a support thread you can see" on public.support_threads;
create policy "read a support thread you can see"
  on public.support_threads for select
  to authenticated
  using (public.support_thread_is_visible(
           shop_id, opened_by, author_user_id, addressed_user_id, addressed_scope));

drop policy "mark your own thread read" on public.support_threads;
create policy "mark your own thread read"
  on public.support_threads for update
  to authenticated
  using (public.support_thread_is_visible(
           shop_id, opened_by, author_user_id, addressed_user_id, addressed_scope))
  with check (public.support_thread_is_visible(
           shop_id, opened_by, author_user_id, addressed_user_id, addressed_scope));

-- Dropped, not left as an overload. Two functions with the same name and the
-- same first four arguments is an invitation to write the shorter call, and
-- the shorter call is the bug this migration exists to remove.
drop function public.support_thread_is_visible(uuid, text, uuid, uuid);

------------------------------------------------------------------
-- The operator's opening transaction now records the choice
------------------------------------------------------------------
-- Dropped and recreated because the argument list grows; leaving the old one
-- in place would let a six-argument call keep writing threads with no scope.
drop function public.platform_open_support_thread(uuid, text, text, text, uuid, uuid);

create or replace function public.platform_open_support_thread(
  p_shop_id uuid,
  p_category text,
  p_subject text,
  p_body text,
  p_addressed_user_id uuid default null,
  p_author_user_id uuid default null,
  p_addressed_scope text default null
)
returns public.support_threads
language plpgsql
security definer
set search_path = public
as $$
declare
  v_thread public.support_threads;
  -- Null means an older platform-admin is calling. Migrations reach the
  -- project before a function deploy does -- that gap is what left a stale
  -- edge function replying with a non-2xx for a day -- so the compatibility
  -- answer has to be the one the old caller meant, which is exactly what the
  -- old null test computed AT INSERT TIME. Inferring here is safe in a way
  -- inferring at read time never was: this runs once, while the addressee
  -- still exists and the caller's intent is still knowable.
  v_scope text := coalesce(
    p_addressed_scope,
    case when p_addressed_user_id is null then 'store' else 'person' end
  );
begin
  insert into public.support_threads (
    shop_id, opened_by, author_user_id, addressed_user_id, addressed_scope,
    category, subject
  ) values (
    -- author_user_id null: the thread is from Kaiibi, not from whichever
    -- operator happened to type it. The individual is recorded on the message.
    p_shop_id, 'platform', null, p_addressed_user_id, v_scope,
    p_category, btrim(p_subject)
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

revoke execute on function public.platform_open_support_thread(uuid, text, text, text, uuid, uuid, text) from public;
grant execute on function public.platform_open_support_thread(uuid, text, text, text, uuid, uuid, text) to service_role;

------------------------------------------------------------------
-- The one function in this chain that was not pinned
------------------------------------------------------------------
-- Every other function here sets search_path; this one was missed. It is not
-- security definer, so the exposure is narrower -- but it runs as part of an
-- UPDATE any authenticated member can trigger, and an unpinned search_path is
-- how a later definer caller inherits a resolution it did not choose. Pinned
-- so the rule is "every function in this chain", with no exception anyone has
-- to remember.
create or replace function public.stamp_shop_read_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.shop_read_at := now();
  return new;
end;
$$;
