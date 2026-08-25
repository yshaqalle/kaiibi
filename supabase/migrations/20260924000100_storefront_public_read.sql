-- The one path in this application that answers with no session at all.
--
-- Written as security definer functions with an EXPLICIT COLUMN LIST rather than
-- as an anon RLS policy on products, for one reason that outweighs the rest:
-- `products.cost_cents` sits one column from `price_cents`. A policy makes the
-- whole ROW readable and leaves the column list to whatever the client asks for,
-- so a `select *` anywhere -- ours or a future one -- publishes every shop's
-- margin. A function returns exactly the columns named here and nothing a caller
-- can widen.
--
-- A DRAFT SHOP AND A NONEXISTENT SHOP BOTH RETURN ZERO ROWS. Distinguishing them
-- would turn the subdomain into an oracle: anyone could walk names and learn
-- which shops are on kaiibi, and what they are called, before they open.
--
-- `city` no longer lives on `shops` -- 20260811000000 moved it to
-- `shop_locations`, one address in one place. get_public_storefront reads it
-- from the primary location (shop_locations_one_primary_idx guarantees at
-- most one), left-joined so a shop somehow missing one still returns its page
-- rather than vanishing from it.

create or replace function public.get_public_storefront(p_slug text)
returns table (
  shop_name       text,
  city            text,
  slug            text,
  whatsapp_e164   text,
  theme           text,
  palette         text,
  headline        text,
  about           text,
  hero_image_url  text,
  offers_delivery boolean,
  payment_mode    text
)
language sql
stable
security definer
set search_path = public
as $$
  select
    s.name, sl.city, s.slug, s.whatsapp_e164,
    f.theme, f.palette, f.headline, f.about, f.hero_image_url,
    f.offers_delivery, f.payment_mode
  from public.shops s
  join public.storefronts f on f.shop_id = s.id
  left join public.shop_locations sl on sl.shop_id = s.id and sl.is_primary
  where s.slug = lower(p_slug)
    and f.published_at is not null
    and public.shop_has_module(s.id, 'storefront');
$$;

-- Note `stock` is exposed and `cost_cents` is not. A customer needs to know
-- whether it is there; nobody outside the shop needs to know what it cost.
create or replace function public.get_public_storefront_products(p_slug text)
returns table (
  id          uuid,
  name        text,
  description text,
  category    text,
  price_cents integer,
  stock       integer,
  image_url   text
)
language sql
stable
security definer
set search_path = public
as $$
  select
    p.id, p.name, p.description, p.category, p.price_cents, p.stock, p.image_url
  from public.products p
  join public.shops s on s.id = p.shop_id
  join public.storefronts f on f.shop_id = s.id
  where s.slug = lower(p_slug)
    and f.published_at is not null
    and p.is_listed_online
    and public.shop_has_module(s.id, 'storefront')
  order by (p.stock > 0) desc, p.category nulls last, p.name;
$$;

create or replace function public.get_public_delivery_areas(p_slug text)
returns table (name text, fee_cents integer)
language sql
stable
security definer
set search_path = public
as $$
  select a.name, a.fee_cents
  from public.storefront_delivery_areas a
  join public.shops s on s.id = a.shop_id
  join public.storefronts f on f.shop_id = s.id
  where s.slug = lower(p_slug)
    and f.published_at is not null
    and f.offers_delivery
  order by a.sort_order, a.name;
$$;

grant execute on function public.get_public_storefront(text) to anon, authenticated;
grant execute on function public.get_public_storefront_products(text) to anon, authenticated;
grant execute on function public.get_public_delivery_areas(text) to anon, authenticated;
