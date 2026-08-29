-- A shop that does not deliver never told anyone where it is.
--
-- checkout-form.tsx hides the whole fulfilment choice unless the shop offers
-- delivery AND has priced an area (`canDeliver`), so a collection-only shop
-- shows the customer nothing at all: `fulfilment` sits at its default
-- 'collect' and the order is placed as a pick-up nobody was told about. And
-- order-placed.tsx then says "will call you when your order is ready to
-- collect" -- to collect from WHERE is never on the page.
--
-- The address exists. It is on shop_locations, not shops, and deliberately so
-- ("a business doesn't have a street, its branches do" -- src/types/models.ts
-- :30, and 20260808000000's own header). get_public_storefront has simply
-- never returned it. This adds it: the address of the PRIMARY location, which
-- is the same branch complete_sale files a storefront sale against
-- (20260908000300:182-191) and the same one checkOrderFulfilment checks stock
-- at, so the page names the counter the goods will actually be waiting on.
--
-- Nullable, and null is a real answer: a shop that has not filled its address
-- in gets no address line rather than an empty one, exactly the null-over-
-- empty-string convention the storefront types already follow.
--
-- AND NULL IS WHAT MOST SHOPS WILL RETURN TODAY, which the two migrations
-- that create these rows make plain and which nothing downstream should be
-- built as if it were otherwise. 20260808000000's backfill carries name,
-- city, neighborhood and contact_phone forward from `shops` and NOT address,
-- because `shops` never had one; createShop (src/lib/shops.ts:126-134) does
-- the same for every shop signed up since. `shop_locations.address` is
-- written in exactly one place -- the optional "Unit or building, street"
-- field in settings/panels/locations-panel.tsx -- so it holds something only
-- for a shop whose owner went and typed it. Tasks 4 and 5 must render the
-- pick-up line with no address at all in that case, not an empty one.
--
-- WHICH IS WHY `neighborhood` TRAVELS WITH IT. It is on the same row and is
-- the field both creation paths DO populate -- the backfill at :134-135 below
-- carries it for every pre-existing shop, createShop (shops.ts:132) writes it
-- from signup's "area" box (signup.tsx:68) for every shop since -- and
-- 20260808000000:47-48 says outright that a shop addresses itself "by
-- neighborhood/landmark (e.g. 'Jigjiga Yar, near the main market')". Adding
-- only the street would have left the common shop degrading straight to
-- `city`, which names a town of a million people and not a shop. With both,
-- src/lib/storefront-collect.ts composes [address, neighborhood, city] -- the
-- repo's own place-string order (locations-panel.tsx:138, poster-sheet.tsx:79,
-- location-switcher.tsx:45) -- dropping whichever parts are unset.
--
-- Anon reads this, which is the point -- a shop's street address is the one
-- fact it most wants a stranger to have. No new function and no fifth entry
-- on the anon surface: get_public_storefront is already one of the four
-- (20261009000100, pinned by verify-anon-rpc-surface.sql), and this migration
-- neither adds to that list nor takes anything off it.
--
-- DROPPED AND RECREATED rather than `create or replace`d, and not by choice:
-- the result type gains two columns, which `create or replace function`
-- refuses.
-- The drop takes the ACL with it, which is why the grants are re-issued at the
-- foot -- revoke before grant, because Postgres hands EXECUTE to PUBLIC on
-- every new function and a bare grant would be a no-op dressed as a decision.
--
-- REPRODUCED IN FULL from 20260930000300_flyer_offer_facts.sql, which this
-- established as the newest definition by grepping every migration for the
-- function rather than by trusting a pointer. That header, and 20260930000200
-- and 20260930000100 before it, remain the authority on everything unchanged
-- here: why this is a `security definer` read with an explicit column list
-- rather than an anon policy, why a draft shop and a nonexistent shop must
-- return byte-identical zero rows, why the offer travels as raw facts with
-- the wording built in TypeScript, why flyers coalesce to '[]' and never to
-- null, why the ordering carries created_at and id, why the join is
-- constrained on p.shop_id, and why an EXPIRED promotion takes the whole
-- flyer off the page.

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
    select l.address, l.neighborhood
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
