-- The page sends an offer's FACTS. The words are rendered once, in TypeScript.
--
-- WHAT MOVES, AND WHAT DOES NOT. This is the whole point of the migration, so
-- it is the first thing stated:
--
--   THE WORDING MOVES OUT OF SQL. '20%', '$2.50', 'All Shoes', 'Anything by
--   Somtel', 'Friday 14 — Sunday 16 August' -- every one of those strings is
--   now built by src/lib/poster.ts's offerCopyFor, on the client, from the raw
--   columns this function hands back.
--
--   WHETHER THE OFFER IS RUNNING STAYS IN SQL, AND STAYS EXACTLY AS IT WAS.
--   promotion_is_live (20260930000100) is untouched by this migration and is
--   still applied in the join below. An expired, paused, archived,
--   not-yet-started or other-shop promotion still drops THE WHOLE FLYER before
--   a single byte leaves the server. That decision is not a client's opinion
--   and must never become one: a browser's clock is the customer's to set, an
--   app bundle updates over the air weeks behind a migration, and "hide the
--   panel" is a line of JavaScript anyone can skip. The server refusing to
--   send the flyer is the only version of this property that holds against a
--   client that is wrong, old, or hostile.
--
--   So: the database rules on ENTITLEMENT, the client renders LANGUAGE. A
--   flyer that arrives is one the till would honour this second; all the
--   client decides is how to spell it.
--
-- WHY. 20260930000100 shipped promotion_offer_copy, promotion_offer_scope,
-- promotion_offer_window and promotion_offer_day: four functions that ported
-- posterCopyFor's wording line for line into SQL, because a printed poster and
-- a public page must not read two ways about one offer. Its own header called
-- that "A DUPLICATION", and verify-storefront-flyers.sql check 19 re-asserted
-- every case in src/lib/__tests__/poster.test.ts against the SQL to hold the
-- two copies in step.
--
-- A test that exists to catch two implementations drifting is a guard around a
-- problem, not a fix for it. It only ever fails AFTER someone has changed one
-- side; it cannot fail for the wording nobody thought to write a case for (the
-- cross-month range had to be added by hand, and was not in poster.test.ts at
-- all); and it is one `-- skip` away from being nothing. The duplication is
-- the defect. There is now ONE implementation of the wording, in the one
-- language that can be unit-tested against the poster it has to match, and the
-- cross-check is deleted along with the thing it was guarding.
--
-- WHAT THE CLIENT NOW HAS TO GET RIGHT, stated so it is not discovered later:
-- the date line resolves in the READER'S timezone rather than in
-- 'Africa/Mogadishu', because offerCopyFor builds it with the local-time Date
-- constructor (src/lib/promotion-dates.ts). For this page that is the better
-- answer, not merely an acceptable one -- it is the identical calculation the
-- shop's own printed poster makes, on the shop's own device, which is the
-- thing the page is forbidden to contradict. A customer standing in the
-- doorway is in Somaliland anyway; one reading from abroad sees the offer's
-- last day in their own reckoning, which is what a date shown to them should
-- mean. And it removes the failure the old code had to carry a comment about:
-- SQL casting in the session's timezone (UTC on Supabase) and printing an
-- offer's last day as the day before for every read after 21:00 local.
--
-- THE INSTANTS GO OUT AS EXPLICIT UTC ISO-8601, not as whatever to_jsonb's
-- timestamptz rendering makes of the session timezone. The value would be
-- unambiguous either way -- Postgres always writes the offset -- but the
-- BYTES would not be, and a wire format that shifts with a session setting is
-- a wire format that cannot be asserted against. `new Date(...)` in the client
-- parses this form exactly.
--
-- REPRODUCED IN FULL from 20260930000200_storefront_auto_advance.sql, per repo
-- convention, with the `offer` object changed and nothing else. That
-- migration's header, and 20260930000100's before it, remain the authority on
-- everything unchanged here: why this is a `security definer` read with an
-- explicit column list rather than an anon policy, why a draft shop and a
-- nonexistent shop must return byte-identical zero rows, why flyers and
-- auto_advance travel on THIS call rather than on RPCs of their own, why
-- flyers coalesce to '[]' and never to null, why the ordering carries
-- created_at and id, why the join is constrained on p.shop_id, and why a
-- DELETED promotion leaves the flyer standing as a plain announcement while an
-- EXPIRED one takes it off the page entirely.
--
-- DROPPED FIRST rather than `create or replace`d: the result type is unchanged
-- this time, but `flyers` is being redefined and the four wording functions
-- below cannot be dropped while a function body still references them by name
-- in a way a later reader would trust. The drop takes the grants with it,
-- which is why they are re-issued at the bottom.

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
  where s.slug = lower(p_slug)
    and f.published_at is not null
    and public.shop_has_module(s.id, 'storefront');
$$;

-- The four wording functions, gone. Nothing calls them now, and leaving them
-- standing would leave a second implementation of the poster's language in the
-- database for a future reader to reach for -- which is the exact defect this
-- migration exists to remove.
--
-- Dropped innermost-last: promotion_offer_copy calls _scope and _window, and
-- _window calls _day.
--
-- promotion_is_live is NOT in this list. It is the server-side liveness gate
-- and it stays.
drop function if exists public.promotion_offer_copy(text, integer, text, text, timestamptz, timestamptz);
drop function if exists public.promotion_offer_window(timestamptz, timestamptz);
drop function if exists public.promotion_offer_scope(text, text);
drop function if exists public.promotion_offer_day(date, boolean);

-- Postgres grants EXECUTE to PUBLIC on every new function, so a `grant`
-- without the matching `revoke` first is a no-op that reads like a decision --
-- 20260924000100:99-105, 20260930000100 and 20260930000200 each make the same
-- point, every time this function is dropped and recreated. The revoke is what
-- makes the grant below the whole list of who can call this.
--
-- anon keeps EXECUTE on this function and gets no table grant on
-- storefront_flyers -- the public page reads through the explicit column list
-- or not at all. verify-storefront-flyers.sql checks 24 and 28 hold both.
revoke execute on function public.get_public_storefront(text) from public;
grant execute on function public.get_public_storefront(text) to anon, authenticated;
