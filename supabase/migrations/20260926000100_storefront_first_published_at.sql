-- A signal that survives unpublishing.
--
-- DesignStrip's "Chosen for you" badge (src/components/storefront/editor/
-- design-strip.tsx) is keyed off `neverPublished` -- literally "this shop
-- has never chosen a design", so it must stop the instant a shop HAS chosen
-- one, and never come back. published_at (20260924000000) cannot be that
-- signal on its own: unpublish (storefront-admin.ts's `unpublish`, T2) sets
-- it straight back to null, so a shop that published once and then pulled
-- its page down would be told all over again that its theme was picked for
-- it -- exactly backwards from the plan's own wording, "once a shop has
-- published, it has chosen".
--
-- first_published_at is published_at's own shape -- a nullable timestamp,
-- set by publish_storefront -- reused to answer a different, ONE-WAY
-- question: not "is the page live right now" (published_at) but "has this
-- shop EVER gone live" (this column). publish_storefront sets it once, via
-- coalesce, and never clears it; unpublish never touches it at all.
alter table public.storefronts add column first_published_at timestamptz;

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
    theme               = case when v_draft ? 'theme'          then v_draft->>'theme'                     else theme           end,
    palette             = case when v_draft ? 'palette'        then v_draft->>'palette'                   else palette         end,
    headline            = case when v_draft ? 'headline'       then v_draft->>'headline'                  else headline        end,
    about               = case when v_draft ? 'about'          then v_draft->>'about'                     else about           end,
    hero_image_url      = case when v_draft ? 'heroImageUrl'   then v_draft->>'heroImageUrl'               else hero_image_url  end,
    offers_delivery     = case when v_draft ? 'offersDelivery' then (v_draft->>'offersDelivery')::boolean  else offers_delivery end,
    published_at        = now(),
    -- Set once, kept forever: the second and every later publish leaves an
    -- already-set first_published_at exactly as it was.
    first_published_at  = coalesce(first_published_at, now()),
    draft                = null,
    updated_at           = now()
  where shop_id = p_shop_id;

  if v_draft ? 'whatsappE164' then
    update public.shops set whatsapp_e164 = v_draft->>'whatsappE164' where id = p_shop_id;
  end if;
end;
$$;
