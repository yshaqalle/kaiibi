-- The shop's public page.
--
-- Two tables and two columns. The reasoning worth keeping:
--
-- SLUG LIVES ON shops, NOT ON storefronts. It is an address, and an address has
-- to be reservable before there is anything at it -- a shop claims its name
-- first and writes its page afterwards. It is also unique platform-wide, which
-- is a property of the shops table and would be a lie enforced anywhere else.
--
-- A BRANCH IS A shops ROW (there is no stores table; multi_location means more
-- than one shop row under one owner). So a two-branch business gets two
-- storefronts and two subdomains, each with its own products, areas and fees.
-- That is right for delivery and right for stock.
--
-- storefronts IS SEPARATE FROM shops so the public, unauthenticated read can be
-- granted on it alone. Granting anonymous select on shops would expose every
-- shop's internals to reach four content columns.

alter table public.shops
  add column slug text unique,
  add column whatsapp_e164 text;

-- Enforced here as well as in storefront-slug.ts: the client rule is for the
-- person typing, this one is for everything else that can write a row.
alter table public.shops
  add constraint shops_slug_is_a_dns_label
  check (slug is null or slug ~ '^[a-z0-9]([a-z0-9-]{1,61}[a-z0-9])$');

alter table public.shops
  add constraint shops_whatsapp_is_e164
  check (whatsapp_e164 is null or whatsapp_e164 ~ '^\+[1-9][0-9]{7,14}$');

create table public.storefronts (
  shop_id uuid primary key references public.shops(id) on delete cascade,

  -- Keys into the catalogues in src/lib/storefront-catalog.ts. CHECK-constrained
  -- rather than free text so a typo cannot render an unstyled page; the client
  -- falls back to the default on an unknown value, and this stops one existing.
  theme text not null default 'market' check (theme in ('market', 'counter', 'window')),
  palette text not null default 'ink' check (palette in ('ink', 'palm', 'clay', 'sea', 'saffron', 'plum')),

  headline text,
  about text,
  hero_image_url text,

  offers_delivery boolean not null default false,

  -- Only one value is permitted today. Adding 'online' later is a constraint
  -- change and a new code path, not a migration across live shops. orders will
  -- COPY this value rather than read it live, so enabling online payment never
  -- rewrites what an earlier customer agreed to.
  payment_mode text not null default 'on_collection' check (payment_mode in ('on_collection')),

  -- Null means draft. A draft page and a nonexistent shop are indistinguishable
  -- to the public, which is enforced by the read path, not by this column.
  published_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.storefront_delivery_areas (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  name text not null,
  -- A child table rather than JSON precisely so this is a typed column that can
  -- be checked and summed. Zero is valid: it is how a shop says "free here".
  fee_cents integer not null default 0 check (fee_cents >= 0),
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  unique (shop_id, name)
);

create index storefront_delivery_areas_shop_idx
  on public.storefront_delivery_areas (shop_id, sort_order);

alter table public.storefronts enable row level security;
alter table public.storefront_delivery_areas enable row level security;

-- Members of the shop manage their own page. The anonymous READ path is granted
-- separately in 20260924000100 and is deliberately not a policy on these tables.
create policy storefronts_member_all on public.storefronts
  for all to authenticated
  using (public.is_shop_member(shop_id))
  with check (public.is_shop_member(shop_id));

create policy delivery_areas_member_all on public.storefront_delivery_areas
  for all to authenticated
  using (public.is_shop_member(shop_id))
  with check (public.is_shop_member(shop_id));

-- Modules gate by trigger, never by policy -- see 20260818000400 for why.
create trigger storefronts_module_gate
  before insert or update on public.storefronts
  for each row execute function public.enforce_shop_module('storefront');

create trigger delivery_areas_module_gate
  before insert or update on public.storefront_delivery_areas
  for each row execute function public.enforce_shop_module('storefront');
