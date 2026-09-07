-- The NEW badge (Task 16: "the price sits on the photo, and new stock says
-- so") needs a fact the public products read has never carried: when a
-- product was added. `products.created_at` has existed since 0001_init.sql;
-- this migration only hands it to the stranger already reading everything
-- else about the product through this same function.
--
-- COPIED FORWARD VERBATIM from 20260924000100_storefront_public_read.sql --
-- which is the ACTUAL latest definition of get_public_storefront_products,
-- confirmed by opening the file rather than trusting a name search on its
-- own. The obvious check --
--   grep -rln get_public_storefront_products supabase/migrations | sort | tail -1
-- -- returns 20261018000000_storefront_public_categories.sql, but that file
-- defines a DIFFERENT function (get_public_storefront_categories) and only
-- MENTIONS this one's name in a comment explaining why that sibling exists.
-- It contains no `create or replace function
-- public.get_public_storefront_products` at all -- grep -c against it for
-- that exact string is 0. 20260924000100 is the only migration that has ever
-- defined this function, so it is the one copied forward: explicit column
-- list, `security definer`, its own `set search_path`, its exact `where`
-- clause and `order by`. The only additions below are one return column
-- (`created_at timestamptz`) and its select expression (`p.created_at`).
-- Nothing else in this body is this migration's business.
--
-- `drop function` first, not `create or replace`: this widens the `returns
-- table` shape with a new column, which Postgres refuses to do in place
-- ("cannot change return type of existing function") -- the same rule
-- 20261025000000 and 20261022000000 hit before this one, and the same fix.
drop function if exists public.get_public_storefront_products(text);

create function public.get_public_storefront_products(p_slug text)
returns table (
  id          uuid,
  name        text,
  description text,
  category    text,
  price_cents integer,
  stock       integer,
  image_url   text,
  created_at  timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select
    p.id, p.name, p.description, p.category, p.price_cents, p.stock, p.image_url, p.created_at
  from public.products p
  join public.shops s on s.id = p.shop_id
  join public.storefronts f on f.shop_id = s.id
  where s.slug = lower(p_slug)
    and f.published_at is not null
    and p.is_listed_online
    and public.shop_has_module(s.id, 'storefront')
  order by (p.stock > 0) desc, p.category nulls last, p.name;
$$;

-- Postgres grants EXECUTE to PUBLIC on every new function, and on a SECURITY
-- DEFINER function that means anon can already call it whether or not anyone
-- said so. The revoke goes first; the grant below is then the entire list of
-- who may call this -- the same order 20260924000100 used and every
-- copy-forward of this function since has kept.
revoke execute on function public.get_public_storefront_products(text) from public;
grant execute on function public.get_public_storefront_products(text) to anon, authenticated;
