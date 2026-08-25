-- A draft the shop cannot lose, and cannot leak.
--
-- Task 7 shipped the editor holding every edit in React state and writing
-- nothing until Publish, because `storefronts` had one row and no draft/live
-- split -- writing on every keystroke would push a half-written headline onto
-- a page customers are reading. The cost was that a shopkeeper who writes
-- their page and taps Back loses all of it, silently. One nullable column
-- removes both problems: unpublished edits live in `draft`, the named live
-- columns keep serving customers untouched, and 20260924000100's public read
-- functions need no change at all -- they never select `draft`, so a future
-- edit that widens one of them to `select *` is exactly what check 7a below
-- exists to catch.
--
-- `draft` holds a `Partial<EditableFields>` (src/lib/storefront-admin.ts) as
-- plain camelCase JSON -- theme, palette, headline, about, heroImageUrl,
-- offersDelivery, whatsappE164 -- not a mirror of the table's own snake_case
-- columns. whatsappE164 lives here even though its live column
-- (shops.whatsapp_e164) sits on a different table, for the same reason slug
-- does NOT: a slug is claimed immediately because it is globally unique and
-- cannot be provisionally reserved (20260925000000's own comment), but a
-- WhatsApp number is unique to nobody -- it can sit unpublished like every
-- other field. payment_mode has exactly one permitted value today and so has
-- nothing to draft.
alter table public.storefronts add column draft jsonb;

-- Merges a patch into the draft -- coalesce(draft, '{}') || p_patch -- so that
-- editing the headline, then the about text, cannot clobber the headline. A
-- literal `update ... set draft = <value>` from the client cannot express
-- this (PostgREST takes a literal payload, not an expression referencing the
-- column's own current value), and reading the draft in the app and writing
-- a merged copy back would race two autosaves against each other; a single
-- UPDATE with the jsonb `||` operator is atomic per row and needs neither.
--
-- Deliberately NOT security definer. This only ever touches `storefronts`,
-- which storefronts_member_all (20260924000000) already restricts to a shop
-- member, and storefronts_module_gate (the same migration) already fires on
-- this UPDATE like any other -- there is nothing here that plain RLS and the
-- existing trigger do not already cover, unlike publish_storefront below,
-- which writes `shops` directly.
create or replace function public.save_storefront_draft(p_shop_id uuid, p_patch jsonb)
returns void
language sql
set search_path = public
as $$
  update public.storefronts
     set draft = coalesce(draft, '{}'::jsonb) || p_patch,
         updated_at = now()
   where shop_id = p_shop_id;
$$;

-- Copies the draft into the live columns, sets published_at, and clears the
-- draft. A key absent from the draft leaves its live column untouched (a
-- shop that only ever edited the headline must not have about/theme/etc
-- reset to null); a key present -- including an explicit JSON null, e.g. a
-- cleared headline -- overwrites it. `->>` on a JSON null correctly yields
-- SQL NULL, so `case when draft ? 'headline' then draft->>'headline' ...`
-- draft ? 'headline' else headline end` tells "cleared" apart from "never
-- touched" the same way `Object.prototype.hasOwnProperty` already does on
-- the client (see saveStorefront's old comment, and ContentDrawer's patches).
--
-- security definer, so it bypasses storefronts_member_all and
-- storefronts_module_gate's usual protection of *this table's* writes
-- entirely on its own account -- both are checked explicitly below. It also
-- writes shops.whatsapp_e164 directly, a write storefronts_module_gate never
-- sees at all (that trigger is only ever attached to storefronts and
-- storefront_delivery_areas) -- the same reason claim_shop_slug
-- (20260925000000) checks the module itself rather than trusting a trigger.
--
-- Both writes happen inside this one function body, i.e. one transaction: an
-- exception from either (most likely the shops_whatsapp_is_e164 CHECK, if a
-- draft somehow held an unnormalised number) aborts the whole call and rolls
-- both back, so a failure can never leave the live columns from one write and
-- the WhatsApp number from the other.
create or replace function public.publish_storefront(p_shop_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_draft jsonb;
begin
  if not public.is_shop_member(p_shop_id) then
    raise exception 'not authorized for shop %', p_shop_id;
  end if;

  if not public.shop_has_module(p_shop_id, 'storefront') then
    raise exception 'shop % does not have the storefront module', p_shop_id;
  end if;

  select coalesce(draft, '{}'::jsonb) into v_draft
    from public.storefronts
   where shop_id = p_shop_id;

  if v_draft is null then
    raise exception 'shop % has no storefront row', p_shop_id;
  end if;

  update public.storefronts set
    theme           = case when v_draft ? 'theme'          then v_draft->>'theme'                     else theme           end,
    palette         = case when v_draft ? 'palette'        then v_draft->>'palette'                   else palette         end,
    headline        = case when v_draft ? 'headline'       then v_draft->>'headline'                  else headline        end,
    about           = case when v_draft ? 'about'          then v_draft->>'about'                     else about           end,
    hero_image_url  = case when v_draft ? 'heroImageUrl'   then v_draft->>'heroImageUrl'               else hero_image_url  end,
    offers_delivery = case when v_draft ? 'offersDelivery' then (v_draft->>'offersDelivery')::boolean  else offers_delivery end,
    published_at    = now(),
    draft           = null,
    updated_at      = now()
  where shop_id = p_shop_id;

  if v_draft ? 'whatsappE164' then
    update public.shops set whatsapp_e164 = v_draft->>'whatsappE164' where id = p_shop_id;
  end if;
end;
$$;

-- Postgres grants execute to PUBLIC on every new function, which on a
-- security definer function means anyone -- including anon -- regardless of
-- the explicit grants below. Revoked first, so the grants are the whole list
-- of who can call these. Neither is granted to anon: both require a session
-- that can already prove shop membership, and publish_storefront in
-- particular writes a live, customer-facing page.
revoke execute on function public.save_storefront_draft(uuid, jsonb) from public;
revoke execute on function public.publish_storefront(uuid) from public;

grant execute on function public.save_storefront_draft(uuid, jsonb) to authenticated;
grant execute on function public.publish_storefront(uuid) to authenticated;
