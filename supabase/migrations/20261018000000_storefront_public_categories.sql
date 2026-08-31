-- What a shop sells, as a way IN to what it sells.
--
-- Market is the default theme and where every shop lands. It went from the
-- about paragraph straight to an undifferentiated grid, so a sixty-product
-- shop was one long scroll with no way in. Counter already groups by
-- `products.category`; Market and Window read category only as a flyer filter
-- target. This is the read that lets them offer it directly.
--
-- JOINED BY NAME, NOT BY KEY, and that is the schema's own doing rather than a
-- shortcut here: `products.category` is free text (0001_init.sql), and
-- `categories` is a separate per-shop table whose rows are kept in step by
-- `rename_category` / `delete_category` (0004_categories_tags.sql: "products
-- .category/tags are free text"). So the count comes from `products` -- the
-- source of truth for what is actually listed -- and the picture comes from
-- `categories.image_url` (0016_brand_category_media.sql) when a row for that
-- name happens to exist.
--
-- A LEFT join, therefore, and deliberately: a category a shop typed onto
-- products but never created a `categories` row for still appears, just
-- without a photo. The alternative -- an inner join -- would silently hide
-- part of the catalogue from the band while the grid below still showed it.
--
-- COUNTS ONLY WHAT THE CUSTOMER CAN SEE. The same three conditions
-- `get_public_storefront_products` filters on -- published, listed online,
-- module on -- so the number on a tile always matches the number of products
-- behind it. A count that included unlisted or out-of-stock rows would be a
-- tile promising eleven things and showing four.
--
-- IN STOCK ONLY. A category whose every product is sold out is not a way in,
-- it is a dead end with a photo on it -- so it does not come back at all, and
-- `having count(*) > 0` is what drops it.
create or replace function public.get_public_storefront_categories(p_slug text)
returns table (
  name          text,
  image_url     text,
  product_count integer
)
language sql
stable
security definer
set search_path = public
as $$
  select
    p.category as name,
    max(c.image_url) as image_url,
    count(*)::integer as product_count
  from public.products p
  join public.shops s on s.id = p.shop_id
  join public.storefronts f on f.shop_id = s.id
  left join public.categories c on c.shop_id = s.id and c.name = p.category
  where s.slug = lower(p_slug)
    and f.published_at is not null
    and p.is_listed_online
    and p.category is not null
    and p.stock > 0
    and public.shop_has_module(s.id, 'storefront')
  group by p.category
  having count(*) > 0
  order by count(*) desc, p.category;
$$;

-- Postgres grants execute to PUBLIC on every new function, which on a definer
-- function means anon too regardless of the explicit grant below. Revoked
-- first, so the grant is the whole list of who can call this -- the same
-- discipline 20260924000100 applies to the other three public reads, and the
-- exact default that 20261009000100 had to go back and undo for seventy
-- functions.
--
-- This is a FIFTH name on the anon surface that verify-anon-rpc-surface.sql
-- pins, and it is added there in the same change with its reason. A logged-out
-- customer browsing a storefront genuinely calls it; that is the only
-- justification the pin accepts.
revoke execute on function public.get_public_storefront_categories(text) from public;
grant execute on function public.get_public_storefront_categories(text) to anon, authenticated;
