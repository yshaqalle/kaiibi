-- Help & support: one thread per conversation, either end can open it.
--
-- A store reporting a broken scanner and an operator saying "your payment
-- cleared" are the same object. Building outbound as a separate announcement
-- table would split each store's history across two places and double the
-- policy surface.
--
-- The visibility rules below are the reason this file exists rather than a
-- pair of naive owns_shop() policies. A cashier writing to us about a manager
-- must not be readable by that manager, and billing belongs to the owner
-- rather than to whoever was on the till.
--
-- DELIBERATELY NOT MODULE-GATED. Every other business table carries
-- enforce_shop_module() (20260818000400); support carries none. The shop most
-- likely to need us is the one whose plan just lapsed, and "your subscription
-- is wrong" is a support request we would otherwise be refusing to accept.

create sequence if not exists public.support_reference_seq start 2001;

-- Short enough to read down a phone line, which is how half of these get
-- followed up. security definer so the reference can be a column default
-- without every client session holding usage on the sequence.
create or replace function public.next_support_reference()
returns text
language sql
volatile
security definer
set search_path = public
as $$
  select 'KB-' || nextval('public.support_reference_seq')::text;
$$;
-- Postgres grants execute to PUBLIC on every new function, which on a definer
-- function means anon too -- here, a signed-out caller burning sequence values
-- for free. Every definer function in this file is revoked before the explicit
-- grant, so the grant is the whole list of who can call it.
revoke execute on function public.next_support_reference() from public;
grant execute on function public.next_support_reference() to authenticated;

create table public.support_threads (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  reference text not null unique default public.next_support_reference(),

  -- Which end started it. Drives who can read it (policies below) and which
  -- message sits at the top of the thread.
  opened_by text not null check (opened_by in ('shop', 'platform')),
  -- The person who wrote the first message. Null when an operator opened it.
  author_user_id uuid references auth.users(id) on delete set null,
  -- Who an operator-opened thread is for. Null means "the store" -- readable
  -- by settings.access holders rather than by one person.
  addressed_user_id uuid references auth.users(id) on delete set null,

  -- Mirrors SupportCategory in src/lib/support-taxonomy.ts. Duplicated here
  -- because a typo'd category is unfilterable in the back office and there is
  -- no screen that repairs one; `area` is left unconstrained precisely because
  -- its list is expected to churn as area_other gets read.
  category text not null check (category in (
    'broken', 'help', 'billing', 'access', 'data', 'hardware', 'feature', 'other'
  )),
  area text,
  -- The free-text capture behind every "something else". This is how the
  -- category list gets corrected from real traffic instead of guesses.
  area_other text,

  subject text not null check (length(btrim(subject)) > 0),
  status text not null default 'open' check (status in ('open', 'closed')),

  -- 'in_app' always works and is the default. 'whatsapp' and 'email' are
  -- flags for the operator, NOT delivery mechanisms -- nothing in this system
  -- sends a message on either channel.
  contact_preference text not null default 'in_app'
    check (contact_preference in ('in_app', 'whatsapp', 'email')),

  -- App version, platform, device class, the screen they were on, branch.
  -- Captured rather than asked for.
  client_context jsonb not null default '{}'::jsonb,

  created_at timestamptz not null default now(),
  last_message_at timestamptz not null default now(),
  -- Null means unread by that end. Compared against last_message_at rather
  -- than counted, so "unread" survives a message being edited or removed.
  shop_read_at timestamptz,
  platform_read_at timestamptz
);

create index support_threads_shop_idx on public.support_threads (shop_id, last_message_at desc);
create index support_threads_status_idx on public.support_threads (status, last_message_at desc);

create table public.support_messages (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references public.support_threads(id) on delete cascade,
  author_kind text not null check (author_kind in ('shop', 'platform')),
  author_user_id uuid references auth.users(id) on delete set null,
  -- The 4000 is the same number DETAILS_MAX names in src/lib/support.ts, and it
  -- is here so that number is a rule rather than a suggestion: the client holds
  -- an insert grant on `body`, so a limit that lives only in validateDraft() is
  -- one hand-rolled request away from an unbounded row. It binds an operator's
  -- reply through service_role too, which is intended -- a reply nobody can read
  -- to the end is not a better answer than a short one.
  body text not null check (length(btrim(body)) > 0 and length(body) <= 4000),
  created_at timestamptz not null default now()
);

create index support_messages_thread_idx on public.support_messages (thread_id, created_at);

create table public.support_attachments (
  id uuid primary key default gen_random_uuid(),
  message_id uuid not null references public.support_messages(id) on delete cascade,
  storage_path text not null,
  file_name text not null,
  byte_size bigint not null,
  content_type text,
  created_at timestamptz not null default now()
);

create index support_attachments_message_idx on public.support_attachments (message_id);

-- Keeps last_message_at honest without every writer having to remember. The
-- unread comparison depends on it, so a missed update reads as "already seen".
-- security definer is what makes that possible from a client session: no client
-- holds update on support_threads at all (see the grants below).
--
-- now() and NOT new.created_at, which is a value the writer chose. Ordering the
-- operator's queue by a client-supplied timestamp lets a shop backdate a message
-- and sink its own thread below everything else -- or postdate one and pin it to
-- the top forever. created_at is left off the insert grant for the same reason,
-- so the two agree in practice; this is the half that holds even if it doesn't.
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
         platform_read_at = case when new.author_kind = 'platform' then v_now else platform_read_at end
   where id = new.thread_id;
  return new;
end;
$$;
revoke execute on function public.touch_support_thread() from public;

create trigger support_messages_touch_thread
  after insert on public.support_messages
  for each row execute function public.touch_support_thread();

-- storage_path is a string the client picks, and nothing about the attachment
-- row itself ties it to the shop that owns the message. An operator renders a
-- thread through service_role, which bypasses storage RLS entirely, so an
-- unchecked path is a member naming somebody else's file and having us fetch it
-- for them.
--
-- Both segments are checked, not just the shop: the storage policies below key
-- read and delete off <shop_id>/<thread_id>/, so a row pointing at another
-- thread's folder describes a file its own reader is refused. Keeping the row
-- and the object on the same path is what makes the two rules one rule.
--
-- A before-INSERT-only trigger would check the path once and then stop being
-- true: nothing here grants a client update on this table today, but the check
-- is only worth having if it survives the day somebody adds one.
create or replace function public.check_support_attachment_path()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_shop_id uuid;
  v_thread_id uuid;
  v_parts text[] := string_to_array(new.storage_path, '/');
begin
  select t.shop_id, t.id into v_shop_id, v_thread_id
    from public.support_messages m
    join public.support_threads t on t.id = m.thread_id
   where m.id = new.message_id;

  if v_shop_id is null then
    raise exception 'support attachment references a message that does not exist';
  end if;

  if array_length(v_parts, 1) < 3
     or v_parts[1] is distinct from v_shop_id::text
     or v_parts[2] is distinct from v_thread_id::text then
    -- check_violation rather than the default, so a caller can tell a bad path
    -- from any other failure without matching on the message text.
    raise exception 'support attachment storage_path must be <shop_id>/<thread_id>/<file>, got %',
      new.storage_path using errcode = 'check_violation';
  end if;

  return new;
end;
$$;
revoke execute on function public.check_support_attachment_path() from public;

create trigger support_attachments_check_path
  before insert or update of storage_path on public.support_attachments
  for each row execute function public.check_support_attachment_path();

------------------------------------------------------------------
-- Visibility
------------------------------------------------------------------
alter table public.support_threads enable row level security;
alter table public.support_messages enable row level security;
alter table public.support_attachments enable row level security;

-- The whole visibility rule in one place, so the message and attachment
-- policies cannot drift from the thread's.
--
-- It takes the thread's COLUMNS rather than its id, and that is load-bearing
-- rather than stylistic: `insert ... returning` (which is what the client does
-- on every create) runs the select policy against the new row before it is
-- visible to any snapshot, so a rule that looks itself up by id answers false
-- and the insert fails. The by-id wrapper below is only for the message and
-- attachment policies, whose thread already exists.
create or replace function public.support_thread_is_visible(
  p_shop_id uuid,
  p_opened_by text,
  p_author_user_id uuid,
  p_addressed_user_id uuid
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
    -- A thread we addressed to one person is that person's.
    or p_addressed_user_id = auth.uid()
    -- A thread we addressed to the STORE is for whoever runs it.
    or (
      p_opened_by = 'platform'
      and p_addressed_user_id is null
      and public.has_shop_permission(p_shop_id, 'settings.access')
    );
$$;
revoke execute on function public.support_thread_is_visible(uuid, text, uuid, uuid) from public;
grant execute on function public.support_thread_is_visible(uuid, text, uuid, uuid) to authenticated;

-- Reads support_threads for the message and attachment policies. security
-- definer so the answer comes from the rule above rather than from whatever the
-- caller's own thread policy lets through -- otherwise one of the two quietly
-- becomes the real rule and the other is decoration.
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
             t.shop_id, t.opened_by, t.author_user_id, t.addressed_user_id)
  );
$$;
revoke execute on function public.can_see_support_thread(uuid) from public;
grant execute on function public.can_see_support_thread(uuid) to authenticated;

-- Every policy names its role. anon holds no grant on these tables, so today
-- this changes nothing -- but it holds every grant on storage.objects (Supabase
-- ships it that way), and the storage policies below are the same rules. Saying
-- who a policy is for beats inferring it from a grant somewhere else.
create policy "read a support thread you can see"
  on public.support_threads for select
  to authenticated
  using (public.support_thread_is_visible(shop_id, opened_by, author_user_id, addressed_user_id));

-- A store opens its own threads. Deliberately narrow: opened_by must be
-- 'shop' and the author must be you, so a member cannot forge a thread that
-- looks like it came from us -- which is what an operator-opened thread's
-- wider read policy would then expose to the whole shop.
create policy "a member opens their own support thread"
  on public.support_threads for insert
  to authenticated
  with check (
    opened_by = 'shop'
    and author_user_id = auth.uid()
    and addressed_user_id is null
    and public.is_shop_member(shop_id)
  );

create policy "read messages on a thread you can see"
  on public.support_messages for select
  to authenticated
  using (public.can_see_support_thread(thread_id));

create policy "reply to a thread you can see"
  on public.support_messages for insert
  to authenticated
  with check (
    author_kind = 'shop'
    and author_user_id = auth.uid()
    and public.can_see_support_thread(thread_id)
  );

create policy "read attachments on a thread you can see"
  on public.support_attachments for select
  to authenticated
  using (
    exists (
      select 1 from public.support_messages m
       where m.id = message_id and public.can_see_support_thread(m.thread_id)
    )
  );

create policy "attach to your own message"
  on public.support_attachments for insert
  to authenticated
  with check (
    exists (
      select 1 from public.support_messages m
       where m.id = message_id and m.author_user_id = auth.uid()
    )
  );

-- Table privileges are granted per table in this schema (0003, and every
-- migration since), so a policy alone grants nothing. Read and append only:
-- editing or deleting what either end already sent would rewrite the record of
-- a conversation, and the operator's side of it goes through service_role.
grant select on public.support_threads     to authenticated;
grant select on public.support_messages    to authenticated;
grant select on public.support_attachments to authenticated;

-- Insert is granted per COLUMN, because a with-check policy only constrains the
-- columns it names and the rest of the row is whatever the client sent. A
-- table-wide insert grant let a member open a thread that was already 'closed',
-- already marked read by us ten years from now, and carrying a reference of
-- their choosing squatting the unique index -- a support request an operator
-- would never see, forged with nothing but the insert every member is meant to
-- have.
--
-- What is left out is what only our end sets: reference, status, the read
-- stamps, last_message_at, created_at, and addressed_user_id (an operator
-- deciding whose thread this is). They keep their defaults on a client insert.
grant insert (
  shop_id, opened_by, author_user_id, category, area, area_other,
  subject, contact_preference, client_context
) on public.support_threads to authenticated;

grant insert (thread_id, author_kind, author_user_id, body)
  on public.support_messages to authenticated;

grant insert (message_id, storage_path, file_name, byte_size, content_type)
  on public.support_attachments to authenticated;

-- Marking a thread read is the ONLY thing a store may change about it, and the
-- narrowing is a COLUMN grant rather than a clause in the policy for the same
-- reason as the insert grants above: a with-check constrains the columns it
-- names and leaves the rest of the row to whatever the client sent. Under a
-- table-wide update grant this policy is a member rewriting the subject of a
-- thread an operator has already answered, reopening one we closed, or setting
-- platform_read_at so their own request reads as seen and leaves the queue.
--
-- The COLUMNS form of the visibility rule and not the by-id wrapper: this is
-- one of support_threads' own policies, so the row is in hand, and the with
-- check gets the row as it will be rather than as it was.
create policy "mark your own thread read"
  on public.support_threads for update
  to authenticated
  using (public.support_thread_is_visible(shop_id, opened_by, author_user_id, addressed_user_id))
  with check (public.support_thread_is_visible(shop_id, opened_by, author_user_id, addressed_user_id));

revoke update on public.support_threads from authenticated;
grant update (shop_read_at) on public.support_threads to authenticated;

-- ...and the VALUE in that column is the server's, never the caller's. This
-- runs on shared shop tablets whose clocks drift, and the unread count is
-- last_message_at > shop_read_at where last_message_at is always now(). A
-- tablet an hour fast marks every operator reply of the next hour as already
-- read before it is written: the badge never rises and a real answer is lost,
-- which is the one failure this feature cannot have. (A slow clock is only a
-- badge that stays on until the next reply, so the asymmetry is the point --
-- there is no correctness to be had from trusting the device in either
-- direction, but one direction is silent.) Every other stamp here is now().
--
-- WHEN, rather than assigning on every update: touch_support_thread() rewrites
-- this row for each message and deliberately leaves shop_read_at alone when the
-- author was an operator. Stamping unconditionally would mark the store as
-- having read the reply that just arrived -- the same lost answer, reached
-- through the trigger instead of through the clock.
create or replace function public.stamp_shop_read_at()
returns trigger
language plpgsql
as $$
begin
  new.shop_read_at := now();
  return new;
end;
$$;

create trigger support_threads_stamp_shop_read_at
  before update on public.support_threads
  for each row
  when (new.shop_read_at is distinct from old.shop_read_at)
  execute function public.stamp_shop_read_at();

-- Opening a thread writes two rows -- the thread, and the message saying what
-- is actually wrong -- and a client that sends them as two requests can land
-- the first and lose the second on a bad connection. What the store gets then
-- is worse than an empty conversation: the screen reports failure, they try
-- again, and the subject-only orphan sits at the TOP of their list on a fresh
-- last_message_at, undeletable (no client holds delete here) and unanswerable
-- (an operator opens a request with no body). One transaction is the only place
-- that cannot half-happen.
--
-- The author is read from auth.uid() inside rather than taken as an argument.
-- A definer function writes with the owner's rights, so the insert policy that
-- pins author_user_id = auth.uid() is not consulted for these rows at all --
-- an author parameter would be any member opening a thread in a colleague's
-- name. The membership test and the fixed opened_by/addressed_user_id are that
-- same policy restated for the one path that bypasses it.
create or replace function public.open_support_thread(
  p_shop_id uuid,
  p_category text,
  p_subject text,
  p_details text,
  p_area text default null,
  p_area_other text default null,
  p_contact_preference text default 'in_app',
  p_client_context jsonb default '{}'::jsonb
)
returns public.support_threads
language plpgsql
security definer
set search_path = public
as $$
declare
  v_author uuid := auth.uid();
  v_thread public.support_threads;
begin
  if v_author is null or not public.is_shop_member(p_shop_id) then
    -- insufficient_privilege so the caller sees the refusal RLS would have
    -- given them, rather than a generic failure they might retry forever.
    raise exception 'not a member of this shop' using errcode = 'insufficient_privilege';
  end if;

  insert into public.support_threads (
    shop_id, opened_by, author_user_id, category, area, area_other,
    subject, contact_preference, client_context
  ) values (
    p_shop_id, 'shop', v_author, p_category, p_area, nullif(btrim(p_area_other), ''),
    btrim(p_subject), coalesce(p_contact_preference, 'in_app'),
    coalesce(p_client_context, '{}'::jsonb)
  )
  returning * into v_thread;

  insert into public.support_messages (thread_id, author_kind, author_user_id, body)
    values (v_thread.id, 'shop', v_author, btrim(p_details));

  -- Re-read: support_messages_touch_thread moved last_message_at and
  -- shop_read_at after the row above was captured, and returning the stale copy
  -- hands the caller a thread that unreadCount() reads as unread the instant
  -- its own author wrote it.
  select * into v_thread from public.support_threads where id = v_thread.id;
  return v_thread;
end;
$$;
revoke execute on function public.open_support_thread(uuid, text, text, text, text, text, text, jsonb) from public;
grant execute on function public.open_support_thread(uuid, text, text, text, text, text, text, jsonb) to authenticated;

------------------------------------------------------------------
-- Attachments bucket
------------------------------------------------------------------
-- NOT `product-images`. Two independent reasons: that bucket is public-read
-- (0002_storage.sql) and a support screenshot may show customer names and
-- sale totals; and its insert policy requires inventory.edit, settings.access
-- or staff.manage (0024, 20260820000300) -- precisely the permissions a stuck
-- cashier lacks, so their upload would 403.
insert into storage.buckets (id, name, public)
values ('support-attachments', 'support-attachments', false)
on conflict (id) do nothing;

-- A path segment is a string somebody else chose, and `text::uuid` on a bad one
-- raises rather than answering false. That is survivable in a with-check, where
-- the only row being tested is the one being written; it is not survivable in a
-- using clause, which a select runs over every row of storage.objects -- one
-- table for every bucket in the project. A single malformed object inside
-- support-attachments would take listing down for everybody, operators
-- included, and a policy is the wrong place to learn that.
--
-- The insert policy below cannot be relied on to prevent that, because it binds
-- `authenticated` and nothing else: the operator side of this feature writes
-- through service_role, which bypasses RLS entirely. So the cast is made total
-- here instead of being trusted upstream. `strict` keeps a null segment (a file
-- with too few folders) out of the exception block entirely.
create or replace function public.uuid_or_null(p_text text)
returns uuid
language plpgsql
immutable
strict
parallel safe
as $$
begin
  return p_text::uuid;
exception when invalid_text_representation then
  return null;
end;
$$;
revoke execute on function public.uuid_or_null(text) from public;
grant execute on function public.uuid_or_null(text) to authenticated;

-- The path is <shop_id>/<thread_id>/<file>, and both segments are load-bearing.
--
-- Shop-wide membership is the right test for WRITING (you may only put a file
-- under your own shop) and the wrong test for READING: this feature's one
-- promise is that a cashier's message about their manager is not the manager's
-- to read, and a screenshot of the till is the message. Gating reads on the
-- shop would have handed the manager the file while the row stayed hidden --
-- the same secret, leaked through the other door. So reads and deletes ask the
-- thread, through the same rule the tables use.
--
-- Insert asks the thread too, and not merely the shop. Shop-wide write against
-- thread-scoped read is a member dropping a file into a colleague's private
-- thread folder: they cannot read it back or remove it, but whoever the thread
-- does belong to is handed a file from someone with no business being there.
-- The thread always exists before its first upload, so this costs nothing.
create policy "members upload their shop's support attachments"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'support-attachments'
    and public.is_shop_member(public.uuid_or_null((storage.foldername(name))[1]))
    and public.can_see_support_thread(public.uuid_or_null((storage.foldername(name))[2]))
  );

create policy "members read support attachments on a thread they can see"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'support-attachments'
    and (
      public.is_platform_admin()
      or public.can_see_support_thread(public.uuid_or_null((storage.foldername(name))[2]))
    )
  );

-- Same rule again, because shop-wide delete is a member destroying another
-- member's evidence -- the complaint and its proof are worth as much as each
-- other.
create policy "members delete support attachments on a thread they can see"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'support-attachments'
    and public.can_see_support_thread(public.uuid_or_null((storage.foldername(name))[2]))
  );
