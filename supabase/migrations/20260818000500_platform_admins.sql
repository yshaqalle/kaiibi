-- The back office: who at Kaiibi may manage plans, extend trials, record
-- payments and suspend accounts.
--
-- This is a different kind of privilege from everything else in this schema.
-- Every existing role is scoped to one shop and granted by that shop's own
-- owner. These operators act ACROSS shops and are appointed by us, so the
-- design assumes an operator account is a high-value target and is built to
-- limit what a stolen one is worth.
--
-- Four decisions carry that weight.
--
-- 1. IT IS ITS OWN TABLE, NEVER A profiles.role VALUE. handle_new_user()
--    (0001_init.sql) copies raw_user_meta_data into profiles.role at signup,
--    and that metadata is supplied by the CLIENT calling signUp(). Any
--    privilege derived from it is self-assignable by anyone who can read the
--    signup request. A separate table with no write policy is not.
--
-- 2. MFA IS REQUIRED, not encouraged. is_platform_admin() demands aal2, so a
--    stolen operator password on its own buys nothing at all -- the attacker
--    also needs the TOTP device. This is the single highest-value control
--    here and it costs about ten lines.
--
-- 3. THE PORTAL CANNOT READ CUSTOMERS' BUSINESS DATA. The select policies
--    below cover billing state and usage counts, and deliberately stop there:
--    no products, sales, customers, expenses, shifts or payroll. Operators can
--    run the business without reading anyone's books, so a compromised
--    operator account leaks billing metadata rather than every shop's trade.
--
-- 4. EVERY MUTATION IS AUDITED, AND THE LOG CANNOT BE EDITED. platform_audit_log
--    has a select policy and no insert/update/delete policy for anyone --
--    rows are written by the service role inside the platform-admin edge
--    function, so they can be neither forged from a client nor scrubbed after
--    the fact.

create table public.platform_admins (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  -- 'owner' may appoint (by SQL) and change plans; 'support' may extend trials
  -- and grant overrides; 'billing' may record payments. Enforced in the edge
  -- function rather than here, since the split is about actions, not rows.
  role       text not null default 'support' check (role in ('owner', 'support', 'billing')),
  active     boolean not null default true,
  note       text,
  created_at timestamptz not null default now()
);

alter table public.platform_admins enable row level security;

-- Requires BOTH membership and a second factor. `aal` is the assurance level
-- Supabase puts in the JWT: 'aal1' is password-only, 'aal2' means an MFA
-- challenge was completed this session. coalesce defaults to aal1, so a token
-- that somehow lacks the claim fails closed rather than open.
--
-- This is what makes MFA mandatory rather than advisory: it is checked in the
-- database on every request, not in a login screen an attacker can skip by
-- talking to the API directly.
create or replace function public.is_platform_admin()
returns boolean
language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from public.platform_admins a
    where a.user_id = auth.uid() and a.active
  )
  and coalesce(auth.jwt() ->> 'aal', 'aal1') = 'aal2';
$$;

-- Membership without the MFA requirement. Used ONLY by the portal's own
-- sign-in screen, so it can tell "you are not an operator" (sign out) apart
-- from "you are, but you need to enrol/verify a second factor" (show the
-- challenge). It grants access to nothing.
create or replace function public.is_platform_admin_pending_mfa()
returns boolean
language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from public.platform_admins a
    where a.user_id = auth.uid() and a.active
  );
$$;

-- Operators can see the roster (who else has access, and whether they have
-- enrolled MFA) -- part of running the team. Nobody else sees it at all, so a
-- shop owner cannot enumerate our staff.
--
-- There is NO write policy, and there is deliberately no "add operator" action
-- anywhere in the product. Appointing an operator is a migration or a manual
-- SQL statement by someone with database access. A privilege-granting endpoint
-- is the one thing most worth not building: it is the step that turns a single
-- compromised operator into a permanent foothold.
create policy "operators read the roster" on public.platform_admins for select
  using (public.is_platform_admin());

create table public.platform_audit_log (
  id             uuid primary key default gen_random_uuid(),
  actor_user_id  uuid references auth.users(id),
  action         text not null,
  target_shop_id uuid references public.shops(id) on delete set null,
  -- The whole row before and after, so a change is reviewable without having
  -- to reconstruct it from the action name.
  before         jsonb,
  after          jsonb,
  -- Required by the edge function on every action. An audit trail that records
  -- what happened but not why answers the easy question and not the one asked
  -- during an investigation.
  reason         text,
  ip             text,
  created_at     timestamptz not null default now()
);

create index platform_audit_log_shop_idx on public.platform_audit_log(target_shop_id, created_at desc);
create index platform_audit_log_actor_idx on public.platform_audit_log(actor_user_id, created_at desc);

alter table public.platform_audit_log enable row level security;

create policy "operators read the audit log" on public.platform_audit_log for select
  using (public.is_platform_admin());

-- Operators' read access to billing state, across all shops. Each of these is
-- additive to the shop-scoped policies already on these tables -- Postgres ORs
-- them, so a shop member keeps exactly the access they had.
create policy "operators read subscriptions" on public.shop_subscriptions for select
  using (public.is_platform_admin());
create policy "operators read overrides" on public.shop_entitlement_overrides for select
  using (public.is_platform_admin());
create policy "operators read payments" on public.subscription_payments for select
  using (public.is_platform_admin());
create policy "operators read usage" on public.shop_usage_counters for select
  using (public.is_platform_admin());
create policy "operators read shops" on public.shops for select
  using (public.is_platform_admin());
-- Store COUNT, for the usage column. shop_locations carries a branch's address
-- and phone, which is more than billing needs -- but it is the shop's own
-- trading address, published on its receipts, not private customer data, and
-- an operator debugging a store-limit question needs to see the rows they are
-- counting.
create policy "operators read locations" on public.shop_locations for select
  using (public.is_platform_admin());

grant select on public.platform_admins    to authenticated;
grant select on public.platform_audit_log to authenticated;

grant execute on function public.is_platform_admin()             to authenticated;
grant execute on function public.is_platform_admin_pending_mfa() to authenticated;

-- No operator is seeded. The first one is appointed deliberately, by running
-- this against the target database with a known user id:
--
--   insert into public.platform_admins (user_id, role, note)
--   values ('<auth.users.id>', 'owner', 'bootstrap');
--
-- Left out of the migration on purpose: a hardcoded id would either be wrong
-- everywhere but one machine, or would appoint a developer's local account as
-- an operator on production.
