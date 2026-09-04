-- Photographs of the shop.
--
-- The last block of the approved About design, and the one held back until now
-- because it needs more than a column: an upload flow, and a storage lifecycle
-- that does not leave orphans in the bucket every time a shop changes its mind.
--
-- SIX, capped by trigger for the same reason the highlights are capped at
-- three: the rule is about the SET, which a row-level check cannot see. Six is
-- the design's one-wide-plus-two grid twice over -- enough for a shop to show
-- its front, its counter and its shelves, and few enough that a customer on a
-- phone connection is not made to download a portfolio before they can see a
-- price.
--
-- WHATEVER uploadImage RETURNS, matching storefront_flyers.image_path exactly:
-- the column stores it and publicImageUrl on the client makes an address of it,
-- so nothing downstream needs to know which bucket a photograph lives in.
--
-- Today that value is an ABSOLUTE URL, not a bucket path -- this header said
-- "paths, not urls" and was wrong. It matters beyond pedantry: publicImageUrl
-- passes an absolute url straight back without asking storage anything, so a
-- row whose object has been deleted still yields a well-formed url and no
-- client-side null check can detect it. That is why removeGalleryImage's
-- ordering is defended by AboutPanel's `onError` and not by a url filter.
--
-- ORPHANS ARE THE CLIENT'S JOB and are handled in storefront-admin.ts, because
-- the bucket is not reachable from SQL: deleting a row here cannot delete the
-- object it points at, so removeGalleryImage deletes the object FIRST and the
-- row second. A failed object delete leaves the photo on the page, which is
-- recoverable; the other order leaves a row pointing at nothing, which is a
-- broken image on a customer's screen.
--
-- COPIED FORWARD IN FULL from 20261021000000, per the convention.

create table public.storefront_images (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  image_path text not null check (length(btrim(image_path)) > 0),
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

create index storefront_images_shop_idx
  on public.storefront_images (shop_id, sort_order);

alter table public.storefront_images enable row level security;

-- Members manage their own page; the anonymous read goes through
-- get_public_storefront below and is deliberately not a policy here -- the
-- split 20260924000000 makes for every other storefront table.
create policy storefront_images_member_all on public.storefront_images
  for all to authenticated
  using (public.is_shop_member(shop_id))
  with check (public.is_shop_member(shop_id));

create trigger storefront_images_module_gate
  before insert or update on public.storefront_images
  for each row execute function public.enforce_shop_module('storefront');

create or replace function public.enforce_gallery_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if (select count(*) from public.storefront_images where shop_id = new.shop_id) >= 6 then
    raise exception 'gallery_limit'
      using hint = 'A storefront shows at most six photographs.';
  end if;
  return new;
end;
$fn$;

create trigger storefront_images_limit
  before insert on public.storefront_images
  for each row execute function public.enforce_gallery_limit();

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
    select l.address, l.neighborhood, l.opening_hours
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
