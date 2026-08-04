-- What a shop is entitled to, and what it pays for. Until now the product was
-- free and unlimited: every shop got POS, inventory, customers, accounting,
-- payroll, scheduling and multi-store with no cap and no paying relationship.
--
-- The axis this adds is deliberately NOT the permission system. A permission
-- (0024_permission_gates.sql) answers "may this USER do X" and is set by the
-- shop's own admin. An entitlement answers "has this SHOP paid for X" and is
-- set by us. They are orthogonal and both must pass -- a cashier with
-- inventory.edit at a shop whose trial lapsed still can't add a product, and
-- an owner on the Pro plan still can't do what their role doesn't grant
-- (which, being the owner, is nothing -- but staff below them feel it).
--
-- The tenant is `shops`, unchanged. Multi-store (20260808000000) split the
-- physical store out into shop_locations but deliberately kept shops as the
-- single tenant every shop_id points at, so that is what a subscription hangs
-- off: one subscription per shop, covering all of its stores, with the store
-- count itself as a plan limit.
--
-- Writes: there are NO insert/update/delete policies on any table here, and
-- `authenticated` is granted select only. That is not an oversight -- it is
-- the security model. Every mutation goes through a service-role edge function
-- that re-checks platform-admin authority in the database and writes an audit
-- row. A client that could write its own subscription row could grant itself
-- the Pro plan.

-- Knobs we want to turn without shipping a build. One row, enforced by the
-- `check (id)` on a boolean primary key -- the standard singleton trick, and
-- cheaper to read than a key/value table when every caller wants all of it.
create table public.platform_settings (
  id                  boolean primary key default true check (id),
  -- 3 months. Long enough that a small shop gets through a full quarter's
  -- accounting cycle before deciding, which is when the product has actually
  -- proved itself.
  default_trial_days  integer not null default 90 check (default_trial_days >= 0),
  -- Grace after a period ends before writes stop. Mobile-money payment is
  -- manual and asynchronous here (see subscription_payments) -- a shop that
  -- paid on Thursday shouldn't be locked out on Friday because we hadn't
  -- recorded it yet.
  default_grace_days  integer not null default 7 check (default_grace_days >= 0),
  -- Where a lapsed shop lands. A key rather than a plan_id so seeding order
  -- doesn't matter and a missing plan degrades to "no modules" rather than a
  -- foreign-key failure at signup time.
  post_trial_plan_key text not null default 'free',
  updated_at          timestamptz not null default now()
);

insert into public.platform_settings (id) values (true) on conflict (id) do nothing;

-- The tiers. Rows, not code, so pricing and packaging change from the admin
-- portal without a deploy -- which matters because the right cut of features
-- is not knowable up front and will be retuned against real conversion.
create table public.plans (
  id               uuid primary key default gen_random_uuid(),
  -- Stable identifier used by platform_settings.post_trial_plan_key and by the
  -- trial trigger. Names are display text and will change; keys must not.
  key              text not null unique,
  name             text not null,
  description      text,
  price_cents      integer not null default 0 check (price_cents >= 0),
  currency         text not null default 'USD',
  billing_interval text check (billing_interval in ('month', 'year')),
  -- Which modules this plan may WRITE. Validated in application code against
  -- src/lib/entitlements.ts rather than by a CHECK constraint, matching how
  -- roles.permissions text[] is validated against src/lib/permissions.ts --
  -- an unknown entry is ignored by the reader, so a plan row can outlive a
  -- catalog change without blocking the migration that makes it.
  modules          text[] not null default '{}',
  -- { "locations": 1, "products": 50, "staff": 2, ... }. A MISSING key or an
  -- explicit null means UNLIMITED, not zero. That direction matters: it means
  -- adding a newly-limited resource later doesn't retroactively cap every
  -- existing plan at zero and lock paying customers out of a feature they had
  -- yesterday. Zero is expressible, but only by saying so.
  limits           jsonb not null default '{}'::jsonb,
  -- Whether a shop can see and choose this plan. False for `trial` (nobody
  -- picks it, the trigger assigns it) and for one-off negotiated deals.
  is_public        boolean not null default true,
  active           boolean not null default true,
  sort_order       integer not null default 0,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- One per shop. The unique constraint is what makes "a shop's plan" a
-- well-defined question rather than a most-recent-row lookup.
create table public.shop_subscriptions (
  id                 uuid primary key default gen_random_uuid(),
  shop_id            uuid not null unique references public.shops(id) on delete cascade,
  -- restrict, not cascade: deleting a plan that shops are on should fail
  -- loudly rather than silently strip their entitlements. The portal
  -- deactivates plans (active = false) instead of deleting them.
  plan_id            uuid not null references public.plans(id) on delete restrict,
  -- Set by the trigger at shop creation. Kept after conversion rather than
  -- nulled, so "when did they start / did they convert" stays answerable.
  trial_ends_at      timestamptz,
  -- Extended by recording a payment. Null while trialing.
  current_period_end timestamptz,
  grace_until        timestamptz,
  -- The operator's kill switch, for fraud or abuse. Everything else about
  -- status is DERIVED from the dates above (see shop_effective_status in
  -- 20260818000200) -- this is the one piece of status a human sets, which is
  -- exactly why it is the only one stored.
  manual_status      text not null default 'active' check (manual_status in ('active', 'suspended')),
  notes              text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

-- Per-shop grants, so support can comp a customer without inventing a plan
-- for them. Without this, "give this shop payroll for a month while they
-- migrate" means either a bespoke plan row nobody will clean up, or moving
-- them to a tier that also changes five other things.
create table public.shop_entitlement_overrides (
  id         uuid primary key default gen_random_uuid(),
  shop_id    uuid not null references public.shops(id) on delete cascade,
  kind       text not null check (kind in ('module', 'limit')),
  -- The module name or the limit resource, e.g. 'payroll' or 'products'.
  key        text not null,
  -- For kind='module' the presence of an unexpired row is the grant and this
  -- is unused; for kind='limit' it is the numeric override (null = unlimited).
  value      jsonb,
  -- Null = permanent. An override that outlives its reason is how a comp
  -- quietly becomes free forever, so the portal defaults this to a date.
  expires_at timestamptz,
  reason     text,
  granted_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  unique (shop_id, kind, key)
);

-- What a shop actually paid. `provider` is 'manual' today: this region pays by
-- ZAAD and eDahab, an operator confirms receipt and records it here, and that
-- is what moves current_period_end. The column exists so a real payment
-- provider's webhook can insert rows alongside without a schema change.
create table public.subscription_payments (
  id          uuid primary key default gen_random_uuid(),
  shop_id     uuid not null references public.shops(id) on delete cascade,
  provider    text not null default 'manual',
  -- The ZAAD/eDahab transaction reference, so a disputed payment can be traced
  -- back to the money.
  provider_ref text,
  amount_cents integer not null check (amount_cents >= 0),
  currency    text not null default 'USD',
  method      text,
  paid_at     timestamptz not null default now(),
  covers_from timestamptz,
  covers_to   timestamptz,
  note        text,
  recorded_by uuid references auth.users(id),
  created_at  timestamptz not null default now()
);

create index shop_entitlement_overrides_shop_idx on public.shop_entitlement_overrides(shop_id);
create index subscription_payments_shop_idx on public.subscription_payments(shop_id, paid_at desc);

alter table public.platform_settings          enable row level security;
alter table public.plans                      enable row level security;
alter table public.shop_subscriptions         enable row level security;
alter table public.shop_entitlement_overrides enable row level security;
alter table public.subscription_payments      enable row level security;

-- Plans and settings are readable by anyone signed in: the upgrade screen has
-- to render the tiers to a shop that isn't on them yet, and the trial
-- countdown needs default_grace_days to say when writes stop.
create policy "read plans" on public.plans for select to authenticated using (true);
create policy "read platform settings" on public.platform_settings for select to authenticated using (true);

-- A shop's own billing state, to any member of it. Deliberately is_shop_member
-- and not a permission: a cashier hitting a product cap needs to be told the
-- shop is on Free, and gating that behind settings.access would leave them
-- staring at an unexplained failure.
create policy "read own subscription" on public.shop_subscriptions for select
  using (is_shop_member(shop_id));
create policy "read own overrides" on public.shop_entitlement_overrides for select
  using (is_shop_member(shop_id));
-- Payments are money, so this one IS narrowed -- a cashier has no business
-- reading what the owner paid or the transaction references behind it.
create policy "read own payments" on public.subscription_payments for select
  using (has_shop_permission(shop_id, 'settings.access'));

-- Select only. See the header: every write is a service-role edge function.
-- service_role is already covered by 0022_service_role_grants.sql's default
-- privileges, so it needs nothing here.
grant select on public.platform_settings          to authenticated;
grant select on public.plans                      to authenticated;
grant select on public.shop_subscriptions         to authenticated;
grant select on public.shop_entitlement_overrides to authenticated;
grant select on public.subscription_payments      to authenticated;

-- The starting tiers. Prices are placeholders and are expected to be retuned
-- from the portal before launch; the packaging is the part worth reviewing.
--
-- `trial` is not public: nobody chooses it, the trigger in the next migration
-- assigns it, and it grants everything so an evaluating shop sees the whole
-- product rather than a crippled version of it.
insert into public.plans (key, name, description, price_cents, billing_interval, modules, limits, is_public, sort_order) values
  ('trial', 'Trial', 'Full access while you evaluate Kaiibi.', 0, null,
   array['pos','inventory','customers','dashboard','accounting','payroll','budgets','promotions','scheduling','multi_location','multi_currency','data_export'],
   '{}'::jsonb, false, 0),

  -- Free keeps a real shop genuinely operable -- a till and a product list --
  -- because a free tier that can't run the shop isn't a funnel, it's a demo.
  -- What it withholds is everything that makes the business legible: books,
  -- payroll, a customer list, a second branch.
  ('free', 'Free', 'Run your till and your stock list, at one store.', 0, null,
   array['pos','inventory'],
   '{"locations": 1, "products": 50, "staff": 2, "customers": 100, "vendors": 0, "sales_per_month": 300}'::jsonb,
   true, 1),

  ('standard', 'Standard', 'The whole shop: customers, books, and your team''s schedule.', 1800, 'month',
   array['pos','inventory','customers','dashboard','accounting','promotions','scheduling'],
   '{"locations": 1, "products": 500, "staff": 10, "customers": 2000, "vendors": 50}'::jsonb,
   true, 2),

  -- Multi-store is the headline of this tier: it is the most valuable thing
  -- the product does and the clearest reason to move up from Standard.
  ('pro', 'Pro', 'Every branch, every module, no caps.', 4500, 'month',
   array['pos','inventory','customers','dashboard','accounting','payroll','budgets','promotions','scheduling','multi_location','multi_currency','data_export'],
   '{}'::jsonb, true, 3)
on conflict (key) do nothing;
