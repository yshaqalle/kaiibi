-- A stranger can browse the shops.
--
-- Until now a customer needed a SLUG. Every public read on this database takes
-- one -- get_public_storefront(p_slug), _products(p_slug), _delivery_areas
-- (p_slug), _categories(p_slug) -- which means the only way to reach a shop is
-- a link somebody forwarded you. That is the whole distribution model, and it
-- has an obvious floor: a shop with no customers yet has nobody to forward it.
--
-- This is the read a directory needs: every published storefront, once, with
-- enough on each row to choose between them.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHAT IS ACTUALLY NEW HERE, stated plainly, because this widens the anonymous
-- surface and the last four times this codebase widened it by accident it
-- shipped a leak.
--
-- Every COLUMN below is already anon-readable for any shop whose slug you
-- know: shop_name, city, headline, about, hero_image_url and offers_delivery
-- are the exact columns get_public_storefront already returns, and the count is
-- narrower than get_public_storefront_categories, which already returns
-- per-category counts over the identical filter. No column here is new.
--
-- What IS new is ENUMERATION: you no longer have to know a slug to find a
-- shop. That is not a side effect to be minimised, it is the entire feature,
-- and it is safe for exactly one reason -- `published_at is not null` is a
-- shop's own decision to be public. A storefront is published by its owner,
-- from the editor, with a preview beforehand. This function tells a stranger
-- nothing about any shop that has not already chosen to tell them.
--
-- THE THREE GATES ARE THE SAME THREE, copied deliberately rather than
-- rewritten, so a shop hidden from one public read is hidden from all of them:
--
--   f.published_at is not null              -- the shop chose to be public
--   shop_has_module(s.id, 'storefront')     -- the plan still includes it
--   (no product data at all)                -- only a count, never a row
--
-- An unpublished shop, a shop whose plan lapsed, and a shop that never had the
-- module are all absent -- asserted in verify-public-storefront-directory.sql
-- rather than left to this comment.
--
-- WHAT IS DELIBERATELY NOT RETURNED. No whatsapp_e164: the directory card does
-- not message anybody, it links to the shop page, and a list of every
-- published shop's phone number is a spam list. It is one join away on the
-- shop's own page, where a customer has arrived deliberately. No theme or
-- palette either -- the directory renders in ITS own palette, not each shop's.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.list_public_storefronts(
  p_city  text default null,
  p_limit integer default 60
)
returns table (
  shop_name       text,
  slug            text,
  city            text,
  headline        text,
  about           text,
  hero_image_url  text,
  offers_delivery boolean,
  product_count   integer
)
language sql
stable
security definer
set search_path = public
as $$
  select
    s.name, s.slug, sl.city, f.headline, f.about, f.hero_image_url,
    f.offers_delivery, c.n
  from public.shops s
  join public.storefronts f on f.shop_id = s.id
  left join public.shop_locations sl on sl.shop_id = s.id and sl.is_primary
  -- LATERAL rather than a correlated subquery in the select list, because the
  -- count is needed twice -- once as a column and once to order by -- and a
  -- SQL function cannot safely ORDER BY an output column alias: RETURNS TABLE
  -- names are OUT parameters and would be ambiguous against it.
  cross join lateral (
    select count(*)::int as n
    from public.products p
    where p.shop_id = s.id
      and p.is_listed_online
      and p.stock > 0
  ) c
  where f.published_at is not null
    and public.shop_has_module(s.id, 'storefront')
    -- Case- and whitespace-insensitive for the same reason filterByCategory is
    -- (theme-shared.tsx): the two sides have different authors months apart --
    -- the shop typed its city at signup, the customer tapped a chip built from
    -- somebody else's -- and "hargeisa" not matching "Hargeisa" would be a dead
    -- end with no visible cause.
    and (p_city is null or lower(sl.city) = lower(btrim(p_city)))
  -- SHOPS WITH SOMETHING TO SELL FIRST. A directory whose first row is an empty
  -- shop teaches a customer that the directory is not worth scrolling. Ties
  -- break by name so the order is stable between calls rather than depending on
  -- what the planner happened to return -- a list that reshuffles on every
  -- refresh is one a customer cannot navigate back into.
  order by c.n desc, s.name
  -- Bounded, and clamped rather than trusted: `p_limit` arrives from an
  -- anonymous HTTP caller, and `limit null` is "no limit at all".
  limit least(greatest(coalesce(p_limit, 60), 1), 100);
$$;

-- The EXPLICIT anon grant, not the PUBLIC default -- the distinction
-- 20261009000100 exists to enforce. This is the EIGHTH function on that
-- surface -- the pin already held seven -- and verify-anon-rpc-surface.sql is
-- updated in the same change, so the count moving from seven to eight is a
-- decision somebody wrote down rather than a diff nobody read.
-- Postgres grants EXECUTE to PUBLIC on every NEW function, so the grant below
-- is only the whole list of who can call this once PUBLIC has been revoked --
-- 20260924000100:99-105 makes the same point every time a public RPC is
-- created. Without this the anon reach would come from the default rather than
-- from the decision, which is precisely the distinction 20261009000100 spent 70
-- revokes establishing.
revoke execute on function public.list_public_storefronts(text, integer) from public;
grant execute on function public.list_public_storefronts(text, integer) to anon, authenticated;
