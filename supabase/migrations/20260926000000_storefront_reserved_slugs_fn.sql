-- One list, not three.
--
-- RESERVED_SLUGS (src/lib/storefront-slug.ts), the shops_slug_is_not_reserved
-- CHECK (20260924000200), and the literal inside is_slug_available
-- (20260925000000) all named the same set of platform subdomains, hand-synced
-- with a comment on each asking the next person to copy any addition into the
-- other two. That only ever drifts one way that matters: if the TS list gains
-- a name the DB has not caught up to, `claim_shop_slug` (which checks
-- `is_slug_available` first) and the CHECK both still let a shop claim it --
-- a permanent squat on a subdomain the platform itself will eventually need,
-- because a slug is unique and claimed slugs are never released. The client
-- list merely failing to warn a shopkeeper away from a name is the safe
-- direction to drift in; the database accepting one is not.
--
-- Collapses the two SQL copies into one function both call. There is still no
-- migration-time access to the TS module -- RESERVED_SLUGS remains a
-- hand-copied third copy, same as its own comment already says -- but the two
-- places that can actually let a shop claim a reserved name now cannot drift
-- from each other: change the list once, here, and both the CHECK and
-- is_slug_available see it on their very next call.
create or replace function public.reserved_slugs()
returns text[]
language sql
immutable
as $$
  select array[
    'www', 'app', 'api', 'admin', 'platform', 'dashboard', 'account', 'accounts',
    'billing', 'support', 'help', 'status', 'blog', 'docs', 'mail', 'smtp',
    'ftp', 'cdn', 'static', 'assets', 'auth', 'login', 'signup', 'kaiibi'
  ];
$$;

-- Immutable and argument-free, so it is exactly as valid inside a CHECK as
-- the literal list it replaces -- Postgres requires a CHECK's functions be
-- immutable precisely so the constraint's meaning cannot change out from
-- under rows that already passed it, and this one no more reads live state
-- than the array literal it replaces did.
alter table public.shops drop constraint shops_slug_is_not_reserved;
alter table public.shops
  add constraint shops_slug_is_not_reserved
  check (slug is null or slug <> all (public.reserved_slugs()));

create or replace function public.is_slug_available(p_slug text)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select
    v.slug is not null
    and v.slug <> all (public.reserved_slugs())
    and not exists (select 1 from public.shops s where s.slug = v.slug)
  from (select lower(trim(p_slug)) as slug) v;
$$;
