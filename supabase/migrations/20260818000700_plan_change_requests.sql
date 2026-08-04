-- A shop asking to move tier, and an operator answering.
--
-- Deliberately a REQUEST rather than a switch. Payment here is ZAAD/eDahab
-- confirmed by hand, so a shop that could set its own plan could select Pro,
-- never send the money, and keep it -- the plan row is the entitlement, there
-- is no card to decline. An operator confirming is what ties the tier to
-- payment actually arriving.
--
-- Downgrades go through the same queue even though they carry no revenue risk.
-- Partly for one code path instead of two, and partly because a shop about to
-- leave is the one conversation worth having before it happens rather than
-- after.
--
-- The shop can raise a request and cancel its own. It can never resolve one:
-- there is no update policy at all, and approval runs through the
-- platform-admin edge function, which writes the audit row in the same breath.

create table public.plan_change_requests (
  id                uuid primary key default gen_random_uuid(),
  shop_id           uuid not null references public.shops(id) on delete cascade,
  requested_plan_id uuid not null references public.plans(id) on delete restrict,
  requested_by      uuid references auth.users(id),
  status            text not null default 'pending' check (status in ('pending', 'approved', 'declined')),
  -- The shop's own message: "paid by ZAAD, ref 634812" is the common case, and
  -- it is what lets an operator match a request to money that arrived.
  note              text,
  decided_by        uuid references auth.users(id),
  decided_at        timestamptz,
  decision_note     text,
  created_at        timestamptz not null default now()
);

-- One open request per shop. Without this, a shop tapping twice queues two and
-- an operator approves the same move twice, or worse approves the stale one.
create unique index plan_change_requests_one_pending
  on public.plan_change_requests(shop_id) where status = 'pending';

create index plan_change_requests_pending_idx
  on public.plan_change_requests(created_at desc) where status = 'pending';

alter table public.plan_change_requests enable row level security;

-- Reading is member-wide, matching shop_subscriptions: a cashier who hits a cap
-- benefits from seeing that an upgrade is already in flight, rather than
-- reporting it again.
create policy "read own plan requests" on public.plan_change_requests for select
  using (is_shop_member(shop_id));

-- Raising one is a billing act, so it needs the same permission as the rest of
-- Settings. `requested_by` is pinned to the caller so a request cannot be
-- attributed to someone else.
create policy "request a plan change" on public.plan_change_requests for insert
  with check (
    has_shop_permission(shop_id, 'settings.access')
    and status = 'pending'
    and requested_by = auth.uid()
  );

-- Cancelling is deleting your own pending request. Deliberately DELETE rather
-- than an update to 'declined': a shop marking its own request declined would
-- be indistinguishable in the log from an operator declining it.
create policy "cancel own pending plan request" on public.plan_change_requests for delete
  using (has_shop_permission(shop_id, 'settings.access') and status = 'pending');

create policy "operators read plan requests" on public.plan_change_requests for select
  using (public.is_platform_admin());

-- No update policy for anyone. Approving and declining go through the
-- platform-admin edge function under the service role.
grant select, insert, delete on public.plan_change_requests to authenticated;

-- The shop's view of where its request stands. A plain select would expose the
-- plan_id but not its name, and joining `plans` client-side for one row is a
-- second round trip on a screen that already made three.
create or replace function public.my_plan_change_request(p_shop_id uuid)
returns jsonb
language sql security definer stable set search_path = public as $$
  select jsonb_build_object(
    'id', r.id,
    'status', r.status,
    'plan_key', p.key,
    'plan_name', p.name,
    'note', r.note,
    'decision_note', r.decision_note,
    'created_at', r.created_at
  )
  from public.plan_change_requests r
  join public.plans p on p.id = r.requested_plan_id
  where r.shop_id = p_shop_id
    and public.is_shop_member(p_shop_id)
  order by r.created_at desc
  limit 1;
$$;

grant execute on function public.my_plan_change_request(uuid) to authenticated;
