-- The directory says what each shop sells.
--
-- `shops.categories` is a text[] the owner picks at signup and it has never
-- left the admin side: not on the storefront, not on the directory, not
-- anywhere a customer can see. It is also the only thing on this database that
-- answers "which of these is a pharmacy" without reading every product.
--
-- One more column on list_public_storefronts. No new function, no new grant --
-- the anon surface stays at eight -- but the function is dropped and recreated
-- again, so the revoke below is load-bearing for the reason 20261022000000
-- spells out: a drop throws the grants away and a create hands EXECUTE back to
-- PUBLIC.
--
-- COPIED FORWARD IN FULL from 20261022000000, per the convention.

drop function if exists public.list_public_storefronts(text, integer);

create function public.list_public_storefronts(
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
  -- NEW in this migration, and the only change to this function. The same
  -- column 20261020000000 put on get_public_storefront, for the same reason and
  -- one step earlier: "are they open" is what a customer checks BEFORE opening
  -- a shop page, so a directory that cannot answer it sends people to find out
  -- one tap at a time.
  --
  -- Off the same lateral the shop page reads it from, not off the `sl` join, so
  -- a card and the page it opens can never disagree about whose hours they are.
  opening_hours   jsonb,
  -- NEW in this migration. `shops.categories` is a text[] the owner picks at
  -- signup -- "Grocery", "Pharmacy", "Electronics" -- and it has never left the
  -- admin side. It is what the directory's category chips filter on.
  --
  -- The WHOLE array, not a primary: a shop that is both a pharmacy and a
  -- grocer is genuinely both, and picking one for it here would hide it from
  -- the chip a customer actually tapped. Filtering is the client's job (see
  -- storefront-directory.ts) for the same reason the city filter is: one
  -- bounded read, filtered in a frame, with no round trip behind a chip.
  --
  -- Safe to expose for the same reason every other column here is: it is the
  -- shop's own description of itself, chosen from a fixed list, and it is
  -- already on every product page as a category name.
  categories      text[],
  product_count   integer
)
language sql
stable
security definer
set search_path = public
as $$
  select
    s.name, s.slug, sl.city, f.headline, f.about, f.hero_image_url,
    f.offers_delivery, coalesce(pick.opening_hours, '{}'::jsonb),
    coalesce(s.categories, '{}'::text[]), c.n
  from public.shops s
  join public.storefronts f on f.shop_id = s.id
  left join public.shop_locations sl on sl.shop_id = s.id and sl.is_primary
  -- The same lateral get_public_storefront uses, and for the same reason: the
  -- `sl` join is `and sl.is_primary` with no fallback, so a shop whose rows
  -- carry no primary would get null hours from it while its own page, which
  -- orders by is_primary then created_at, showed a real branch's.
  left join lateral (
    select l.opening_hours
    from public.shop_locations l
    where l.shop_id = s.id
    order by l.is_primary desc, l.created_at asc
    limit 1
  ) pick on true
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
-- 20261009000100 exists to enforce. It is the EIGHTH function on that
-- surface, added by 20261019000000; this migration adds no function and no
-- grant, and the count is unchanged.
-- AND THE REVOKE IS LOAD-BEARING HERE, not ceremony. Dropping the function
-- above threw away its grants; creating it again hands EXECUTE straight back to
-- PUBLIC, which includes anon. Without this line the grant below would be a
-- no-op that reads like a decision, and the function would be anon-callable
-- through the default nobody chose -- the exact shape of the leak
-- 20261009000100 exists to have closed. Same pattern get_public_storefront
-- follows every time it is recreated.
revoke execute on function public.list_public_storefronts(text, integer) from public;
grant execute on function public.list_public_storefronts(text, integer) to anon, authenticated;
