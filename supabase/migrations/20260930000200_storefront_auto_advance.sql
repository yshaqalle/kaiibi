-- Motion. One boolean, and the same public read extended again.
--
-- storefronts.auto_advance IS THE SHOP ASKING THE FLYER BAND TO MOVE ON ITS
-- OWN. `not null default false` -- a shop that has never touched the setting
-- gets a page that does not move, matching every other opt-in flag this
-- table carries (offers_delivery, 20260924000000).
--
-- THIS COLUMN IS NOT THE WHOLE ANSWER. It is the shop's half of a decision
-- the customer's device gets to veto in both directions --
-- src/components/storefront/flyer-carousel.tsx reads it alongside
-- AccessibilityInfo.isReduceMotionEnabled() (React Native Web's read of
-- `prefers-reduced-motion`) and refuses to move the band unless BOTH the
-- shop asked and the device has not asked for less motion; it also stops
-- for good the moment a customer hovers, touches or focuses the band, and
-- never moves a single flyer regardless of this value. None of that lives
-- in SQL -- there is nothing here for a database to enforce about a
-- customer's device or a customer's hover -- so this migration's job is
-- narrower than the client's: store the shop's request, and hand it back
-- on the one call that already carries everything else about the page.
--
-- ON THE EXISTING CALL, NOT A FIFTH ONE. Same anti-enumeration argument
-- 20260930000100's header makes for flyers: get_public_storefront is one of
-- three `security definer` reads granted to anon (20260924000100), built so
-- a draft shop and a nonexistent shop return byte-identical zero rows. A
-- separate get_public_auto_advance(slug) would hand that property back --
-- an unpublished shop, an unknown slug and a failed read would become
-- distinguishable by which of two calls errored, or by timing. auto_advance
-- travels inside the row that already exists.
--
-- REPRODUCED IN FULL, dropped first rather than `create or replace`d --
-- adding a column to a `returns table` function changes its result type,
-- which `replace` refuses. The drop takes the grants with it, so they are
-- re-issued below, same as 20260930000100.

alter table public.storefronts
  add column auto_advance boolean not null default false;

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
    f.offers_delivery, f.payment_mode,
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
                 'offer',      case when p.id is null then null
                                    else public.promotion_offer_copy(
                                           p.discount_type, p.discount_value,
                                           p.scope, p.scope_value,
                                           p.starts_at, p.ends_at) end
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
        and (fl.promotion_id is null or p.id is not null)
    ), '[]'::jsonb),
    -- The shop's request, unfiltered. The device's veto and the "stopped for
    -- this visit" rule are the client's job -- see this migration's header.
    f.auto_advance
  from public.shops s
  join public.storefronts f on f.shop_id = s.id
  left join public.shop_locations sl on sl.shop_id = s.id and sl.is_primary
  where s.slug = lower(p_slug)
    and f.published_at is not null
    and public.shop_has_module(s.id, 'storefront');
$$;

-- Postgres grants execute to PUBLIC on every new function, so a `grant`
-- without the matching `revoke` is a no-op that reads like a decision --
-- 20260924000100:99-105 and 20260930000100 make the same point, each time
-- this function is dropped and recreated.
revoke execute on function public.get_public_storefront(text) from public;
grant execute on function public.get_public_storefront(text) to anon, authenticated;
