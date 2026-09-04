-- What a shop sells, and the two ways to reach it that were never published.
--
-- THE CHIPS WERE READING A COLUMN NOTHING WRITES. `shops.categories` is a
-- text[] that createShop accepts and defaults to '{}', and NOTHING in the app
-- has ever set it -- not signup, not Settings (its "Brands and categories"
-- panel edits PRODUCT categories, a different thing entirely). So the
-- directory's category chips shipped correct and permanently empty: right
-- plumbing, no water.
--
-- They now derive from `products.category`, which every shop fills in as a
-- matter of course because it is what groups their own catalogue. It is also
-- the truer answer: what a shop actually has on the shelf today, not what
-- somebody ticked once at signup. Same three conditions as
-- get_public_storefront_categories -- listed online, in stock, shop published
-- -- so a chip can never offer a shop whose own category band would not show
-- that category.
--
-- `shops.categories` is left alone. It is not this migration's business
-- whether the admin side keeps using it.
--
-- AND THE PHONE WAS ALREADY THERE. `shop_locations.contact_phone` has existed
-- since 20260808000000 and is backfilled for every shop -- it is on receipts,
-- it is in Settings -- and no customer has ever been shown it. WhatsApp was
-- the only way to reach a shop from its own page. Exposing it costs a column
-- on a function that already reads that row.
--
-- Instagram is the only genuinely new field here, and the only contact on the
-- design's Visit tab that had nowhere to read from.
--
-- Two functions, no new ones: the anon surface stays at eight.

alter table public.storefronts
  add column instagram text
    -- A HANDLE, not a url, and 30 is Instagram's own limit. Stored without the
    -- leading @ (the client strips it) so the page can render one consistently
    -- rather than printing whatever punctuation a shop happened to type.
    check (instagram is null or (length(btrim(instagram)) between 1 and 30));

comment on column public.storefronts.instagram is
  'Instagram handle without the leading @, shown on the storefront Visit tab. Null means never set, which renders as nothing.';

drop function if exists public.get_public_storefront(text);

create function public.get_public_storefront(p_slug text)
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
  -- NEW in this migration, and the only change to this function. Placed beside
  -- offers_delivery because it is the other half of the same question: that
  -- column says whether the goods can come to you, these say where to go
  -- if they cannot. Callers read the result by NAME (src/lib/storefront.ts
  -- maps `row.collect_address` and `row.collect_neighborhood`), so their
  -- position here is for a reader, not for a client.
  collect_address text,
  -- AND THE NEIGHBOURHOOD, which for the common shop is the only one of the
  -- two that will hold anything. `address` is written in exactly one place and
  -- only by an owner who went looking for it; `neighborhood` is carried
  -- forward for EVERY shop by both paths that create a location --
  -- 20260808000000:134-135's backfill and createShop (src/lib/shops.ts:132,
  -- from signup's "area" box, signup.tsx:68). It is also the field this region
  -- navigates by rather than a nicety: 20260808000000:47-48 says a shop
  -- addresses itself "by neighborhood/landmark (e.g. 'Jigjiga Yar, near the
  -- main market')". Without it the pick-up line degrades from an address
  -- straight to a city of a million people.
  collect_neighborhood text,
  -- NEW in this migration, with `highlights` below. Both are the rest of the
  -- same answer `about` starts: who runs this and why buy here. Placed beside
  -- it for a reader; callers read by name.
  --
  -- A YEAR, not a date. "Trading since 2014" is what a shop says out loud, and
  -- storing a full date would invite a precision nobody has and a birthday
  -- nobody wants printed. Nullable, and null is the common case.
  trading_since   smallint,
  -- NEW in this migration, and the only change to this function.
  --
  -- Beside the collect_* pair because it answers the other half of the same
  -- question: those say WHERE to come, this says WHEN. A customer standing in
  -- the street with a forwarded link asks the second one first, and until now
  -- the page could not answer it at all -- the column has existed since
  -- 20260809000000 and nothing public has ever read it.
  --
  -- Shape is shops.opening_hours's, moved to shop_locations by that migration:
  -- { "mon": [{"open":"09:00","close":"18:00"}], "sun": [] }, local wall-clock
  -- strings, a LIST per day so a lunch or prayer closure is a UI change alone.
  -- Empty object means the shop has never set them, which the page must render
  -- as nothing rather than as "closed" -- see src/lib/store-hours.ts's
  -- isConfigured, which is the client-side guard this ships behind.
  opening_hours   jsonb,
  -- The primary location's phone, which has existed since 20260808000000 and
  -- is backfilled for every shop -- and has never been shown to a customer.
  -- WhatsApp was the only way to reach a shop from its own page; this is the
  -- one for somebody who would rather call, which in this market is most
  -- people over a certain age.
  --
  -- Off `pick`, the same single row the address and the hours come from, so
  -- the page cannot print one branch's street above another branch's number.
  contact_phone   text,
  -- NEW column (below). The one contact a shop had no way to publish.
  instagram       text,
  -- Up to three claims the shop writes about itself, ordered. Aggregated here
  -- rather than fetched separately for the reason `flyers` is: one round trip
  -- for one page, and a shop with none coalesces to '[]' so a renderer has one
  -- empty state rather than two.
  highlights      jsonb,
  -- NEW in this migration. Up to six photographs of the shop, in its own
  -- order. Paths, not URLs -- `image_path` stores whatever uploadImage
  -- returned, and publicImageUrl on the client turns it into an address, the
  -- same arrangement storefront_flyers already has. Coalesced to '[]' so a
  -- shop with none and a shop that was never asked read alike.
  images          jsonb,
  payment_mode    text,
  flyers          jsonb,
  auto_advance    boolean
)
language sql
stable
security definer
set search_path = public
as $$
  select
    s.name, sl.city, s.slug, s.whatsapp_e164,
    f.theme, f.palette, f.headline, f.about, f.hero_image_url,
    f.offers_delivery,
    -- The PRIMARY location's street address and neighbourhood, by the same
    -- ordering every other "the shop's location" rule in this codebase uses --
    -- complete_sale (20260908000300:182-186) and storefront-admin.ts's
    -- primaryLocation. Read off `pick`, the lateral below, rather than the
    -- `sl` join, because that join is `and sl.is_primary` with no fallback: a
    -- shop whose rows somehow carry no primary would get null from it, where
    -- the lateral picks the oldest branch and names a real counter.
    --
    -- ONE lateral for both columns, not a subquery each. Two subqueries with
    -- the same order-by would agree only as long as the ordering stays total,
    -- and `is_primary desc, created_at asc` is not: two branches created in
    -- the same transaction tie, and the two subqueries could then read a
    -- street off one row and a neighbourhood off another, composing an address
    -- that exists nowhere. Taking one row settles it.
    --
    -- `city` still comes from the `sl` join; the two are not made to agree
    -- here because changing what `city` returns is not this migration's
    -- business.
    pick.address, pick.neighborhood,
    f.trading_since,
    -- Off `pick`, deliberately, and not off the `sl` join that supplies
    -- `city`. `sl` is `and sl.is_primary` with no fallback; `pick` is the
    -- lateral that orders by is_primary then created_at and always names a
    -- real branch. Taking the hours from the same single row as the address
    -- is what stops the page printing one branch's street above another
    -- branch's opening times.
    coalesce(pick.opening_hours, '{}'::jsonb),
    pick.contact_phone,
    f.instagram,
    -- Ordered by sort_order then created_at then id: `sort_order` has no
    -- unique constraint (a reorder would fight one halfway through, the same
    -- reason 20260930000000 gives for flyers), and without a total order the
    -- three cards can swap places between two refreshes of the same page.
    coalesce((
      select jsonb_agg(
               jsonb_build_object('id', h.id, 'title', h.title, 'body', h.body)
               order by h.sort_order, h.created_at, h.id
             )
      from public.storefront_highlights h
      where h.shop_id = s.id
    ), '[]'::jsonb),
    -- Same total ordering as the highlights and the flyers, and for the same
    -- reason: `sort_order` carries no unique constraint, so without the
    -- created_at and id tiebreaks a gallery can reshuffle between two
    -- refreshes of the same page.
    coalesce((
      select jsonb_agg(
               jsonb_build_object('id', i.id, 'image_path', i.image_path)
               order by i.sort_order, i.created_at, i.id
             )
      from public.storefront_images i
      where i.shop_id = s.id
    ), '[]'::jsonb),
    f.payment_mode,
    -- coalesce to '[]', never null. A shop with no flyers, a shop whose
    -- flyers are all drafts and a shop whose only offer just expired all read
    -- alike, and a renderer has one empty state rather than two.
    coalesce((
      select jsonb_agg(
               jsonb_build_object(
                 'id',         fl.id,
                 'image_path', fl.image_path,
                 'headline',   fl.headline,
                 'subline',    fl.subline,
                 'link_kind',  fl.link_kind,
                 'link_value', fl.link_value,
                 'position',   fl.position,
                 -- THE PROMOTION'S RAW FACTS, no words. Six columns, read off
                 -- the row on this very read and never stored on the flyer,
                 -- for the reason 20260930000100 gives at length: a page
                 -- advertising a discount the till refuses does it around the
                 -- clock, to strangers, at the address printed on the shop's
                 -- card.
                 --
                 -- null (JSON null, never a missing key) when the flyer names
                 -- no promotion, so a renderer has ONE thing to test. It
                 -- cannot mean "expired" -- the where clause below has
                 -- already taken that flyer off the page.
                 'offer',      case when p.id is null then null
                                    else jsonb_build_object(
                                           'discount_type',  p.discount_type,
                                           'discount_value', p.discount_value,
                                           'scope',          p.scope,
                                           'scope_value',    p.scope_value,
                                           -- Explicit UTC, so the bytes do not
                                           -- move with the session timezone.
                                           -- to_char of null is null, which
                                           -- jsonb_build_object writes as JSON
                                           -- null -- an open-ended offer.
                                           'starts_at',      to_char(p.starts_at at time zone 'UTC',
                                                                     'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
                                           'ends_at',        to_char(p.ends_at   at time zone 'UTC',
                                                                     'YYYY-MM-DD"T"HH24:MI:SS"Z"')) end
               )
               -- created_at and id break the tie because `position` has no
               -- unique constraint (20260930000000 explains why: a
               -- non-deferrable unique index refuses a reorder halfway
               -- through). Without a total order a page can reshuffle
               -- between two refreshes.
               order by fl.position, fl.created_at, fl.id
             )
      from public.storefront_flyers fl
      -- The join carries the live test, so `p.id is null` below means one of
      -- three things at once: no promotion, a deleted one, or one that is not
      -- currently running. Only the middle case survives -- see the where.
      --
      -- THIS IS THE LINE THE FEATURE RESTS ON, and this migration does not
      -- touch it. promotion_is_live is src/lib/discounts.ts's isPromotionLive
      -- in SQL -- active, unarchived, started, not ended -- evaluated HERE, on
      -- the server, before the flyer is serialised. Moving the wording to the
      -- client moved no part of this decision with it.
      --
      -- `p.shop_id = fl.shop_id` is a tenancy boundary, not belt and braces.
      -- Nothing constrains a flyer's promotion_id to the flyer's own shop, so
      -- a member who knows another shop's promotion id could otherwise put
      -- that shop's discount on their own public page.
      left join public.promotions p
             on p.id = fl.promotion_id
            and p.shop_id = fl.shop_id
            and public.promotion_is_live(p.active, p.archived_at, p.starts_at, p.ends_at)
      where fl.shop_id = s.id
        and not fl.draft
        -- A flyer that names a promotion is only public while that promotion
        -- is live. A flyer that names none is always public: it is new stock,
        -- new hours, a photograph -- or an offer whose promotion was deleted,
        -- which `on delete set null` has already reduced to the same thing.
        --
        -- The flyer DROPS, rather than rendering without its offer line,
        -- because the offer is not only in the fields this function controls:
        -- it is in the JPEG, which says 20% OFF in letters this database
        -- cannot read, and in `subline`, which is free text the owner typed.
        and (fl.promotion_id is null or p.id is not null)
    ), '[]'::jsonb),
    -- The shop's request, unfiltered. The device's veto and the "stopped for
    -- this visit" rule are the client's job -- see 20260930000200's header.
    f.auto_advance
  from public.shops s
  join public.storefronts f on f.shop_id = s.id
  left join public.shop_locations sl on sl.shop_id = s.id and sl.is_primary
  -- LEFT join lateral, so a shop with no locations at all still returns its
  -- row with both columns null rather than dropping off the storefront
  -- entirely. `on true` because the correlation is already in the subquery's
  -- own where clause.
  left join lateral (
    select l.address, l.neighborhood, l.opening_hours, l.contact_phone
    from public.shop_locations l
    where l.shop_id = s.id
    order by l.is_primary desc, l.created_at asc
    limit 1
  ) pick on true
  where s.slug = lower(p_slug)
    and f.published_at is not null
    and public.shop_has_module(s.id, 'storefront');
$$;

-- Postgres grants EXECUTE to PUBLIC on every new function, so a `grant`
-- without the matching `revoke` first is a no-op that reads like a decision --
-- 20260924000100:99-105, 20260930000100, 20260930000200 and 20260930000300
-- each make the same point, every time this function is dropped and
-- recreated. The revoke is what makes the grant below the whole list of who
-- can call this.
--
-- anon keeps EXECUTE on this function and gets no table grant on
-- shop_locations -- the address leaves through this explicit column list or
-- not at all. shop_locations' own RLS is member-only (20260808000000:79-81);
-- this function reads past it as its owner, which is precisely why the column
-- list, and not a policy, is the boundary.
revoke execute on function public.get_public_storefront(text) from public;
grant execute on function public.get_public_storefront(text) to anon, authenticated;


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
  -- What the shop actually SELLS, derived from its listed, in-stock products.
  -- See the header on why this is not `shops.categories` any more.
  --
  -- The whole set, not a primary: a shop that stocks both medicine and food is
  -- genuinely both, and picking one for it here would hide it from the chip a
  -- customer actually tapped. Filtering is the client's job for the same reason
  -- the city filter is: one bounded read, filtered in a frame, no round trip
  -- behind a chip.
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
    -- The SAME three conditions get_public_storefront_categories uses --
    -- listed online, in stock, published shop -- so a chip can never offer a
    -- shop whose own category band would not show that category either.
    -- `distinct` because a shop with forty products has a handful of trades.
    coalesce((
      select array_agg(distinct btrim(p2.category) order by btrim(p2.category))
      from public.products p2
      where p2.shop_id = s.id
        and p2.is_listed_online
        and p2.stock > 0
        and p2.category is not null
        and btrim(p2.category) <> ''
    ), '{}'::text[]),
    c.n
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
