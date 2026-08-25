-- Claiming a slug -- the shop's web address, `<slug>.kaiibi.com` -- without
-- leaking who owns what.
--
-- A slug is globally unique (20260924000000_storefront.sql), so "is this
-- free?" is a question about rows the asker cannot see under RLS: a plain
-- `select` from a shop that isn't a member of the row holding that slug
-- returns nothing, which is indistinguishable from the slug never having
-- been claimed at all. Both functions here are security definer for exactly
-- that reason, and both answer with the least information that settles the
-- question -- a boolean, or the slug itself, never a shop id or a name.
--
-- Both are shop-side: granted to `authenticated` only, never `anon`. That is
-- different from the three functions in 20260924000100_storefront_public_read.sql,
-- which serve the storefront's public page and are deliberately reachable
-- with no session at all.

-- Whether a slug can be claimed right now -- reserved names are permanent
-- squats on subdomains the platform itself needs
-- (20260924000200_storefront_reserved_slugs.sql), so they read as
-- unavailable exactly like a slug some other shop already holds. The two
-- reasons are not distinguished in the return value: a boolean is the whole
-- point -- no shop id, no name, no error text that would let a caller tell
-- "someone has this" apart from "nobody may have this".
--
-- Keep this list identical to RESERVED_SLUGS in src/lib/storefront-slug.ts and
-- to the shops_slug_is_not_reserved CHECK. The three are not generated from
-- one another -- there is no migration-time access to the TS module, and a
-- CHECK constraint cannot be queried as a value list -- so a future addition
-- to any one of them must be copied by hand into the other two.
create or replace function public.is_slug_available(p_slug text)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select
    v.slug is not null
    and v.slug not in (
      'www', 'app', 'api', 'admin', 'platform', 'dashboard', 'account', 'accounts',
      'billing', 'support', 'help', 'status', 'blog', 'docs', 'mail', 'smtp',
      'ftp', 'cdn', 'static', 'assets', 'auth', 'login', 'signup', 'kaiibi'
    )
    and not exists (select 1 from public.shops s where s.slug = v.slug)
  from (select lower(trim(p_slug)) as slug) v;
$$;

-- Claims a slug for a shop. Membership is not enforced by RLS here --
-- security definer bypasses it entirely -- so this checks it itself, the
-- same way every other security-definer RPC in this codebase does
-- (public.complete_sale, public.rename_category, ... in
-- 0018_staff_shop_access.sql). The storefront module is checked too: the
-- storefronts_module_gate trigger only covers the storefronts table, and this
-- function writes shops directly, a row that trigger never sees.
--
-- is_slug_available is called first so an ordinary "someone got there first"
-- or a reserved-name attempt both come back as the same typed slug_taken
-- error before any write is attempted. The unique_violation handler below is
-- belt and braces for the genuine race it can't rule out: two concurrent
-- claims can both pass that check before either commits, and only the
-- database's unique constraint on shops.slug catches that. Either path lands
-- on the same typed error, never a raw constraint name.
create or replace function public.claim_shop_slug(p_shop_id uuid, p_slug text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_slug text := lower(trim(p_slug));
begin
  if not public.is_shop_member(p_shop_id) then
    raise exception 'not authorized for shop %', p_shop_id;
  end if;

  if not public.shop_has_module(p_shop_id, 'storefront') then
    raise exception 'shop % does not have the storefront module', p_shop_id;
  end if;

  if not public.is_slug_available(v_slug) then
    raise exception 'slug_taken' using errcode = 'P0001';
  end if;

  update public.shops set slug = v_slug where id = p_shop_id;

  return v_slug;
exception
  when unique_violation then
    raise exception 'slug_taken' using errcode = 'P0001';
end;
$$;

-- Postgres grants execute to PUBLIC on every new function, which on a
-- definer function means anyone -- including anon -- regardless of the
-- explicit grants below. Revoked first, so the grants are the whole list of
-- who can call these. Neither is granted to anon: both require a session
-- that can already prove shop membership.
revoke execute on function public.is_slug_available(text) from public;
revoke execute on function public.claim_shop_slug(uuid, text) from public;

grant execute on function public.is_slug_available(text) to authenticated;
grant execute on function public.claim_shop_slug(uuid, text) to authenticated;
