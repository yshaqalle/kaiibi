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
  body text not null check (length(btrim(body)) > 0),
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
create or replace function public.touch_support_thread()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.support_threads
     set last_message_at = new.created_at,
         -- Writing marks it read for the end that wrote, and only that end.
         shop_read_at = case when new.author_kind = 'shop' then new.created_at else shop_read_at end,
         platform_read_at = case when new.author_kind = 'platform' then new.created_at else platform_read_at end
   where id = new.thread_id;
  return new;
end;
$$;

create trigger support_messages_touch_thread
  after insert on public.support_messages
  for each row execute function public.touch_support_thread();

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
grant execute on function public.can_see_support_thread(uuid) to authenticated;

create policy "read a support thread you can see"
  on public.support_threads for select
  using (public.support_thread_is_visible(shop_id, opened_by, author_user_id, addressed_user_id));

-- A store opens its own threads. Deliberately narrow: opened_by must be
-- 'shop' and the author must be you, so a member cannot forge a thread that
-- looks like it came from us -- which is what an operator-opened thread's
-- wider read policy would then expose to the whole shop.
create policy "a member opens their own support thread"
  on public.support_threads for insert
  with check (
    opened_by = 'shop'
    and author_user_id = auth.uid()
    and addressed_user_id is null
    and public.is_shop_member(shop_id)
  );

create policy "read messages on a thread you can see"
  on public.support_messages for select
  using (public.can_see_support_thread(thread_id));

create policy "reply to a thread you can see"
  on public.support_messages for insert
  with check (
    author_kind = 'shop'
    and author_user_id = auth.uid()
    and public.can_see_support_thread(thread_id)
  );

create policy "read attachments on a thread you can see"
  on public.support_attachments for select
  using (
    exists (
      select 1 from public.support_messages m
       where m.id = message_id and public.can_see_support_thread(m.thread_id)
    )
  );

create policy "attach to your own message"
  on public.support_attachments for insert
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
grant select, insert on public.support_threads     to authenticated;
grant select, insert on public.support_messages    to authenticated;
grant select, insert on public.support_attachments to authenticated;

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

-- First path segment is the shop id, so a member can only write under their
-- own shop and the object's owner is checkable without reading the row.
create policy "members upload their shop's support attachments"
  on storage.objects for insert
  with check (
    bucket_id = 'support-attachments'
    and public.is_shop_member((storage.foldername(name))[1]::uuid)
  );

create policy "members read their shop's support attachments"
  on storage.objects for select
  using (
    bucket_id = 'support-attachments'
    and (
      public.is_platform_admin()
      or public.is_shop_member((storage.foldername(name))[1]::uuid)
    )
  );

create policy "members delete their shop's support attachments"
  on storage.objects for delete
  using (
    bucket_id = 'support-attachments'
    and public.is_shop_member((storage.foldername(name))[1]::uuid)
  );
