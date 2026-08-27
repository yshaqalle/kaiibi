-- Posters and offers on the shop's public page.
--
-- The seasonal poster, "everything 20% off this week", a photo of new stock.
-- One table. The reasoning worth keeping:
--
-- THE FOREIGN KEY IS TO storefronts, NOT TO shops. A flyer is a panel on a
-- page; a shop with no page has nowhere to put one, and a row that named a
-- shop with no storefronts row would be an orphan the public read could never
-- find and no screen could ever show. Pointing at storefronts(shop_id) makes
-- that unrepresentable rather than merely discouraged, and it also gives the
-- five-per-shop trigger below a single row per shop to serialise on.
-- storefronts.shop_id already cascades from shops, so deleting a shop still
-- reaches these rows -- one hop further along, in the order
-- 20260908001200_delete_shop_fk_ordering.sql needs.
--
-- promotion_id IS `on delete set null`, NEVER cascade. Same rule campaigns
-- states for the same reason (20260828000000_campaigns.sql:11-14): deleting an
-- offer must not delete the record of having mentioned it. The link is the
-- point of the whole feature -- a flyer that claims a discount is meant to
-- derive its words from the promotion row rather than store a copy, which is
-- exactly what src/lib/poster.ts already does for printed posters ("a poster
-- then cannot contradict the till"). Null is allowed and means a flyer with no
-- discount behind it: new stock, new hours, a photograph.
--
-- anon GETS NO GRANT AT ALL. Every public storefront read goes through a
-- `security definer` function with an explicit column list (20260924000100),
-- and that design is only a guarantee while it is the sole path in. `draft`
-- alone makes the point: a direct grant would hand an unauthenticated caller
-- the half-written panels the owner has not published. `authenticated` DOES
-- get an explicit table grant, because RLS narrows what a role may see and
-- never grants it reach -- `storefronts` shipped with policies and no grant
-- and returned 42501 to every app read for a whole plan (20260925000100).

create table public.storefront_flyers (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.storefronts(shop_id) on delete cascade,

  -- A path into the storage bucket, not a URL: the bucket and its signing
  -- rules belong to the reader, and a stored absolute URL goes stale the day
  -- either changes.
  image_path text not null,

  -- The one thing that cannot be derived. Both optional: a flyer can be a
  -- photograph with no words on it at all.
  headline text,
  subline text,

  -- Where tapping the flyer goes. CHECK-constrained rather than free text for
  -- the reason storefronts.theme gives (20260924000000): the client falls back
  -- on an unknown value, and this stops one existing to fall back from.
  --
  -- NOT NULL DEFAULT 'none' rather than nullable. 'none' is in the set
  -- precisely to be the "goes nowhere" value, so a null would be a second way
  -- to spell it -- and two spellings of one state is how a renderer grows a
  -- branch that only one of them takes.
  link_kind text not null default 'none' check (link_kind in ('none', 'category', 'whatsapp')),
  -- The category name or the WhatsApp message, depending on link_kind. Null
  -- when link_kind is 'none'. Deliberately not constrained against link_kind
  -- here: the editor writes the two in either order, and a cross-column CHECK
  -- would refuse the intermediate state a half-filled form is in.
  link_value text,

  -- The order the panels appear in. No unique constraint on (shop_id,
  -- position): reordering swaps two rows, and a non-deferrable unique index
  -- refuses the swap halfway through.
  position integer not null default 0,

  -- Every flyer starts unpublished, matching storefronts.published_at being
  -- null on a new page. A poster the owner is still cropping is not a poster
  -- the street should see.
  draft boolean not null default true,

  promotion_id uuid references public.promotions(id) on delete set null,

  created_at timestamptz not null default now()
);

create index storefront_flyers_shop_idx
  on public.storefront_flyers (shop_id, position);

-- Reaches the offer's own rows when a promotion is deleted, and keeps the
-- "which flyers mention this offer?" read the editor will make off a scan.
create index storefront_flyers_promotion_idx
  on public.storefront_flyers (promotion_id)
  where promotion_id is not null;

-- AT MOST FIVE PER SHOP, IN THE DATABASE.
--
-- A trigger rather than an RLS `with check`, for the two reasons
-- 20260818000300_usage_counters.sql gives: a policy can only return a bare
-- 403, which the editor cannot turn into "you have five flyers -- remove one
-- to add another"; and a count(*) inside a WITH CHECK is not safe under
-- concurrency, because two transactions inserting the fifth both see four and
-- both pass.
--
-- No counter row, unlike the plan limits. Five is a fixed property of the
-- design rather than something a plan sells more of, and a per-shop count over
-- a table that holds at most five rows is not worth a second table to keep in
-- step. The lock the counter row provided is taken on the shop's storefronts
-- row instead -- which the foreign key guarantees exists, and which is exactly
-- as per-shop as the limit is, so concurrent inserts for one shop serialise
-- and no other shop's wait.
--
-- INSERT OR UPDATE, not insert alone. A limit checked only on insert is walked
-- straight past by moving an existing row into a shop that is already full.
create or replace function public.enforce_storefront_flyer_limit()
returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_limit integer := 5;
  v_count integer;
begin
  perform 1 from public.storefronts s where s.shop_id = new.shop_id for update;

  -- Excluding new.id covers both operations with one query: on INSERT it is a
  -- fresh id that matches nothing, and on UPDATE it stops a row being counted
  -- against the limit it is itself already inside.
  select count(*) into v_count
  from public.storefront_flyers f
  where f.shop_id = new.shop_id and f.id <> new.id;

  if v_count >= v_limit then
    raise exception 'flyer_limit_reached'
      using errcode = 'P0001',
            detail = json_build_object('resource', 'storefront_flyers', 'limit', v_limit, 'usage', v_count)::text,
            hint = 'Remove a flyer before adding another.';
  end if;

  return new;
end;
$$;

create trigger storefront_flyers_limit before insert or update on public.storefront_flyers
  for each row execute function public.enforce_storefront_flyer_limit();

alter table public.storefront_flyers enable row level security;

-- Members of the shop manage their own flyers, matching storefronts and
-- storefront_delivery_areas exactly (20260924000000). The anonymous read path
-- is a `security definer` function and deliberately not a policy here.
create policy storefront_flyers_member_all on public.storefront_flyers
  for all to authenticated
  using (public.is_shop_member(shop_id))
  with check (public.is_shop_member(shop_id));

-- The grant 20260924000000 forgot for its own two tables, made at creation
-- this time. See the header, and 20260925000100 for the whole story.
grant select, insert, update, delete on public.storefront_flyers to authenticated;
-- anon: nothing. Deliberately.

-- Modules gate by trigger, never by policy -- see 20260818000400 for why.
create trigger storefront_flyers_module_gate
  before insert or update on public.storefront_flyers
  for each row execute function public.enforce_shop_module('storefront');
