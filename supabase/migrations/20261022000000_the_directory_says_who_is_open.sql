-- The directory says which shops are open.
--
-- 20261020000000 put opening hours on the shop PAGE. This puts them one step
-- earlier, on the directory card, because "are they open" is what a customer
-- checks before deciding which shop to open -- and a directory that cannot
-- answer it makes them find out one tap at a time.
--
-- No new function and no new grant: this is one more column on
-- list_public_storefronts, which already carries an explicit anon grant. The
-- anon surface stays at seven.
--
-- WHAT THIS DOES NOT DO: change the ORDER. The list is still fullest-shop
-- first. Sorting open shops to the top is tempting and wrong here -- the
-- server has no reliable idea what time it is where the customer is standing
-- (the times are local wall-clock strings with no timezone, see the column
-- comment), so the openness a card shows is computed on the DEVICE. A server
-- ordering by it would disagree with the badges beside it.
--
-- COPIED FORWARD IN FULL from 20261019000000, per the convention.

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
  -- NEW in this migration, and the only change to this function. The same
  -- column 20261020000000 put on get_public_storefront, for the same reason and
  -- one step earlier: "are they open" is what a customer checks BEFORE opening
  -- a shop page, so a directory that cannot answer it sends people to find out
  -- one tap at a time.
  --
  -- Off the same lateral the shop page reads it from, not off the `sl` join, so
  -- a card and the page it opens can never disagree about whose hours they are.
  opening_hours   jsonb,
  product_count   integer
)
language sql
stable
security definer
set search_path = public
as $$
  select
    s.name, s.slug, sl.city, f.headline, f.about, f.hero_image_url,
    f.offers_delivery, coalesce(pick.opening_hours, '{}'::jsonb), c.n
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
-- 20261009000100 exists to enforce. This is the seventh function on that
-- surface and verify-anon-rpc-surface.sql is updated in the same change, so
-- the count moving from six to seven is a decision somebody wrote down rather
-- than a diff nobody read.
grant execute on function public.list_public_storefronts(text, integer) to anon, authenticated;
