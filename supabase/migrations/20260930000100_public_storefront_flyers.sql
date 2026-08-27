-- The public page carries its flyers, and DERIVES every offer they claim.
--
-- 20260930000000 gave a shop somewhere to keep flyers. This is the half that
-- matters: what a stranger with no session sees at the shop's address.
--
-- THE OFFER IS COMPUTED ON EVERY READ, NEVER STORED. src/lib/poster.ts says
-- why for the printed sheet -- "a poster cannot contradict the till: if the
-- offer says 20% and runs through Saturday, so does the paper on the door" --
-- and the argument is strictly stronger here. A shop can take a poster off the
-- door. A page advertising a discount the till refuses does it around the
-- clock, to strangers, at the address printed on the shop's card. So the
-- flyer stores a promotion_id and nothing else about the offer; `value`,
-- `scope` and `when` are built from the promotion row at read time by the four
-- functions below.
--
-- ON THE EXISTING CALL, NOT A NEW ONE. get_public_storefront is one of three
-- `security definer` reads granted to anon (20260924000100), and its header
-- explains the property they were built around: a draft shop and a nonexistent
-- shop both return zero rows, so nobody can walk names and learn which shops
-- are on kaiibi before they open. A separate get_public_flyers(slug) would
-- hand that back -- an unpublished shop, an unknown slug and a failed read
-- would become distinguishable by which call errored, or by how long each
-- took. Flyers travel inside the one row that already exists.
--
-- WHICH RULE DECIDES "THE OFFER IS OVER", and where it comes from.
--
-- `promotions` carries four things that can each stop an offer: `active` (the
-- owner's hard off switch), `starts_at`, `ends_at` (scheduling, added by
-- 20260826000000) and `archived_at` ("kept only so old sales still read").
-- The till already collapses them, in src/lib/discounts.ts's isPromotionLive,
-- described there as "the one place 'is this offer running right now' is
-- decided":
--
--     active and archived_at is null
--       and (starts_at is null or starts_at <= now)
--       and (ends_at   is null or ends_at   >  now)
--
-- promotion_is_live below is that expression, in SQL, unchanged. A second rule
-- was not invented for this page.
--
-- complete_sale ALSO enforces the window, and deliberately differently: one
-- minute of slack on the start for clock skew, ten minutes on the end so a
-- cashier can finish a cart that was live when it was opened
-- (20260908000300:335-347). That slack is NOT copied here, on purpose. It is
-- permissive slack -- it makes the till accept an offer slightly outside its
-- window -- and the failure it protects against (a customer already told a
-- total) has no counterpart on a web page. Taking the strict rule means the
-- page stops claiming an offer at, or before, the moment the till stops
-- honouring it. That asymmetry is the safe one; the reverse would put a claim
-- on the internet that the till refuses.
--
-- EXPIRED AND DELETED ARE HANDLED DIFFERENTLY, AND THAT IS THE DESIGN.
--
--   Expired (or paused, or archived, or not yet started, or belonging to
--   another shop): THE FLYER DROPS OFF THE PAGE ENTIRELY. Not "renders without
--   the offer line" -- because the offer is not only in the derived line. It
--   is in the JPEG, which says 20% OFF in letters this database cannot read,
--   and in `subline`, which is free text the owner typed. Stripping the one
--   field we control while leaving the picture up would satisfy the letter of
--   "stops claiming a discount" and none of its point. The panel goes.
--
--   Deleted: THE FLYER STAYS, as a plain announcement. Not a choice so much as
--   a consequence: promotion_id is `on delete set null` (20260930000000, for
--   the reason 20260828000000_campaigns.sql gives -- deleting an offer must
--   not delete the record of having mentioned it), so a deleted promotion
--   leaves a flyer that is byte-for-byte a flyer which never had an offer.
--   There is nothing left to drop it on, and inventing a tombstone column to
--   restore the distinction would be adding state purely to hide a panel.
--
--   The asymmetry also lands the right way round on who is present. Deletion
--   is the attended case: an owner is in the editor, and the flyer staying is
--   how they see it and fix it. Expiry is the unattended case -- Saturday
--   midnight passes with nobody watching -- and that is the one that has to
--   fail safe on its own.
--
--   The cost of dropping an expired flyer, stated so it is not discovered
--   later: a shop's page quietly loses a panel when an offer ends. The owner's
--   own editor is unaffected (it reads the table, not this function), so the
--   flyer is still there to be re-pointed or removed.
--
-- THE WORDING IS PORTED FROM posterCopyFor, LINE FOR LINE, AND THAT IS A
-- DUPLICATION. src/lib/poster.ts:83 derives the same three fields in
-- TypeScript for the printed sheet. SQL cannot call it, and the paper and the
-- page must not read two ways about one offer, so the rules are reproduced
-- here: the day/month name arrays (poster.ts builds its own rather than using
-- toLocaleDateString, so the wording is identical on every device -- same
-- reason this does not use to_char's locale-dependent 'Day'/'Month'), the
-- "stored exclusive, printed inclusive" end-date shift (src/lib/
-- promotion-dates.ts), the same-month short form, and formatCents' '$0.00'.
-- src/lib/__tests__/poster.test.ts's cases are re-asserted against these
-- functions in verify-storefront-flyers.sql check 19 -- that is what keeps the
-- two copies honest, and it is where a change to either must be mirrored.
--
-- The local day is resolved in 'Africa/Mogadishu', the platform constant
-- 20260908000320_shop_local_date.sql establishes and explains. A bare cast
-- would resolve in the session's timezone -- UTC on Supabase -- and print an
-- offer's last day as the day before for every read after 21:00 local.

-- 'Saturday 16 August', or 'Saturday 16' when the month is redundant --
-- longDate/shortDate in src/lib/poster.ts:48-60.
create or replace function public.promotion_offer_day(p_day date, p_with_month boolean)
returns text
language sql immutable as $$
  select (array['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'])
           [extract(dow from p_day)::int + 1]
      || ' ' || extract(day from p_day)::int
      || case when p_with_month then ' ' ||
           (array['January','February','March','April','May','June',
                  'July','August','September','October','November','December'])
             [extract(month from p_day)::int]
         else '' end;
$$;

-- windowLine (poster.ts:62-75). `ends_at` is stored as the INSTANT the offer
-- stops -- local midnight of the day AFTER the last day it runs -- so the
-- printed end day is one day back. An offer stored as ending at midnight on
-- the 17th ran through the whole of the 16th, and the 16th is what a customer
-- standing in front of the sheet needs to read.
create or replace function public.promotion_offer_window(p_starts_at timestamptz, p_ends_at timestamptz)
returns text
language sql stable as $$
  with d as (
    select (p_starts_at at time zone 'Africa/Mogadishu')::date            as from_day,
           (p_ends_at   at time zone 'Africa/Mogadishu')::date - 1        as to_day
  )
  select case
    when from_day is null and to_day is null then null
    when to_day   is null then 'From '  || public.promotion_offer_day(from_day, true)
    when from_day is null then 'Until ' || public.promotion_offer_day(to_day, true)
    -- The left half drops its month only when both days share one, so a
    -- window inside August reads "Friday 14 — Sunday 16 August" rather than
    -- saying August twice.
    else public.promotion_offer_day(from_day, to_char(from_day, 'YYYY-MM') <> to_char(to_day, 'YYYY-MM'))
         || ' — ' || public.promotion_offer_day(to_day, true)
  end
  from d;
$$;

-- scopeLine (poster.ts:77-81). An empty scope_value falls back to the
-- store-wide wording, matching the JS truthiness check on the same field --
-- 'All ' with nothing after it is worse than saying nothing specific.
create or replace function public.promotion_offer_scope(p_scope text, p_scope_value text)
returns text
language sql immutable as $$
  select case
    when p_scope = 'category' and coalesce(p_scope_value, '') <> '' then 'All ' || p_scope_value
    when p_scope = 'brand'    and coalesce(p_scope_value, '') <> '' then 'Anything by ' || p_scope_value
    else 'Everything in store'
  end;
$$;

-- isPromotionLive (src/lib/discounts.ts:19-26), in SQL. Three separate ideas,
-- deliberately not collapsed: `active` is the owner's hard off switch, the
-- window is scheduling, and `archived_at` is "kept only so old sales still
-- read". A promotion has to clear all three. The end instant is the moment it
-- stops, not the last moment it runs -- an offer "until 21:00" must not still
-- be advertised at 21:00.
create or replace function public.promotion_is_live(
  p_active     boolean,
  p_archived_at timestamptz,
  p_starts_at  timestamptz,
  p_ends_at    timestamptz,
  p_at         timestamptz default now()
)
returns boolean
language sql stable as $$
  select coalesce(p_active, false)
     and p_archived_at is null
     and (p_starts_at is null or p_starts_at <= p_at)
     and (p_ends_at   is null or p_ends_at   >  p_at);
$$;

-- The three fields posterCopyFor derives from the promotion itself, as one
-- object. `when` is JSON null when the offer has no window, never a missing
-- key: two spellings of one state is how a renderer grows a branch that only
-- one of them takes (20260930000000 makes the same argument about link_kind).
create or replace function public.promotion_offer_copy(
  p_discount_type  text,
  p_discount_value integer,
  p_scope          text,
  p_scope_value    text,
  p_starts_at      timestamptz,
  p_ends_at        timestamptz
)
returns jsonb
language sql stable as $$
  select jsonb_build_object(
    -- formatCents (src/lib/currency.ts): '$2.50', no thousands separator.
    'value', case when p_discount_type = 'percentage'
                  then p_discount_value::text || '%'
                  else '$' || to_char(p_discount_value / 100.0, 'FM9999999990.00') end,
    'scope', public.promotion_offer_scope(p_scope, p_scope_value),
    'when',  public.promotion_offer_window(p_starts_at, p_ends_at)
  );
$$;

-- REPRODUCED IN FULL from 20260924000100_storefront_public_read.sql, per repo
-- convention, with `flyers` added and nothing else changed. Its header is
-- still the authority on why this is a definer function with an explicit
-- column list rather than an anon policy (products.cost_cents sits one column
-- from price_cents), on why a draft shop and a nonexistent shop both return
-- zero rows, and on the left join to shop_locations.
--
-- DROPPED FIRST, not `create or replace`d: adding a column to a `returns
-- table` changes the function's result type, which replace refuses. The drop
-- takes the grants with it, which is why they are re-issued below.
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
  flyers          jsonb
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
    ), '[]'::jsonb)
  from public.shops s
  join public.storefronts f on f.shop_id = s.id
  left join public.shop_locations sl on sl.shop_id = s.id and sl.is_primary
  where s.slug = lower(p_slug)
    and f.published_at is not null
    and public.shop_has_module(s.id, 'storefront');
$$;

-- Postgres grants execute to PUBLIC on every new function, so a `grant`
-- without the matching `revoke` is a no-op that reads like a decision --
-- 20260924000100:99-105 makes the same point. Revoked first, so what follows
-- is the whole list of who can call these.
--
-- The four derivation functions are granted to NOBODY. They are reached from
-- inside get_public_storefront, whose body runs as its owner, so anon needs no
-- privilege of its own -- and the offer wording stays behind the one call with
-- an explicit column list rather than becoming a second public API.
revoke execute on function public.promotion_offer_day(date, boolean) from public;
revoke execute on function public.promotion_offer_window(timestamptz, timestamptz) from public;
revoke execute on function public.promotion_offer_scope(text, text) from public;
revoke execute on function public.promotion_is_live(boolean, timestamptz, timestamptz, timestamptz, timestamptz) from public;
revoke execute on function public.promotion_offer_copy(text, integer, text, text, timestamptz, timestamptz) from public;

revoke execute on function public.get_public_storefront(text) from public;
grant execute on function public.get_public_storefront(text) to anon, authenticated;
