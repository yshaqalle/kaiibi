-- shops.slug is globally unique and DNS-shaped (20260924000000), but nothing
-- stopped a shop from claiming a name the platform itself needs --
-- `api.kaiibi.com`, `www.kaiibi.com` -- and since slugs are unique, taking one
-- of those is a permanent squat: no other shop, and no future platform
-- subdomain, could ever use it. validateSlug in src/lib/storefront-slug.ts
-- rejects these client-side, but that function has no production caller that
-- runs before a write; a shop editing straight through PostgREST bypasses it
-- entirely. The DB is the only place this can actually be enforced, so it is
-- the authority -- RESERVED_SLUGS in storefront-slug.ts is the list a
-- shopkeeper sees while typing, this CHECK is the list nothing can get past.
--
-- Keep this list identical to RESERVED_SLUGS in src/lib/storefront-slug.ts.
-- The two are not generated from one another -- there is no migration-time
-- access to the TS module -- so a future addition to either list must be
-- copied by hand into the other, or a shop can end up able to claim in the DB
-- a name the client already refuses to suggest, or vice versa.
alter table public.shops
  add constraint shops_slug_is_not_reserved
  check (
    slug is null or slug not in (
      'www', 'app', 'api', 'admin', 'platform', 'dashboard', 'account', 'accounts',
      'billing', 'support', 'help', 'status', 'blog', 'docs', 'mail', 'smtp',
      'ftp', 'cdn', 'static', 'assets', 'auth', 'login', 'signup', 'kaiibi'
    )
  );
