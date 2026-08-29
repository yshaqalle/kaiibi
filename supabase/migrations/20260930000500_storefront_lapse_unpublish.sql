-- Coming back from a lapse leaves the page a DRAFT.
--
-- THE DECISION. A shop that stops paying gets a month (20260930000400), keeps
-- every row it ever had, and its page goes dark. Today it goes dark for one
-- reason only -- shop_has_module() fails while the shop resolves to the `free`
-- plan -- so the day it pays again the page comes back EXACTLY AS IT WAS. After
-- a month away that page may be advertising last month's prices to a customer
-- who then orders at them, and the order path honours the price the customer
-- agreed to. Publishing again has to be a deliberate act.
--
-- WHERE THERE IS NO SEAM, AND WHY THIS IS A TRIGGER. "At the end of grace"
-- sounds like a scheduled job, and there is no clock anywhere in this project
-- to hang one off. Subscription status is COMPUTED ON EVERY READ
-- (shop_effective_status, 20260818000200:18 -- "status is DERIVED from the
-- dates above"): no stored status column, no pg_cron, no scheduled anything. A
-- migration runs once, at deploy. So nothing exists that could notice a month
-- passing.
--
-- The two lazy readings that look like the answer both fail:
--
--   * Check when the shopkeeper opens the editor. A lapsed shop CANNOT REACH
--     the editor -- the Storefront row is greyed and taps route to the upgrade
--     wall (T3, ROUTE_MODULES in src/lib/entitlements.ts). By the time they
--     can open it they have already paid, so the shop reads `active` and an
--     "unpublish if expired" check does nothing at all.
--   * Check inside the public read. get_public_storefront is `stable`, so it
--     cannot write, and it is called by anonymous customers. Writing on an
--     unauthenticated read is an abuse surface, not a seam.
--
-- The moment that IS observable is the shop coming BACK, and that is always an
-- UPDATE on shop_subscriptions. Putting it here rather than in
-- supabase/functions/platform-admin/index.ts catches every route: record_payment
-- (index.ts:472), extend_trial (index.ts:404-419), a plan change, and any
-- manual operator UPDATE. Editing the edge function would have covered the two
-- paths that exist today and nothing an operator does by hand.
--
-- THE TIMING TRAP THIS IS WRITTEN AROUND. shop_effective_status() takes a SHOP
-- ID and selects from shop_subscriptions itself, so inside a trigger it does
-- not report the row it was handed -- it reports whatever is in the table at
-- that instant. A BEFORE UPDATE trigger sees the OLD dates; an AFTER UPDATE
-- trigger sees the NEW ones; and in EITHER timing, calling it twice answers the
-- same thing twice. The obvious implementation -- call it once for "before" and
-- once for "after" -- therefore reduces to `x = 'expired' and x <> 'expired'`,
-- which is false for every row on earth: a trigger that never fires, whose
-- tests all pass because nothing ever changes. Both timings are MEASURED in
-- supabase/tests/verify-lapse.sql F0 rather than asserted here.
--
-- So the two sides are derived from OLD and NEW directly, through a row-shaped
-- twin of the same case expression. The case is MOVED, not copied:
-- shop_effective_status is redefined below to call it, so there is one
-- definition of "what status do these dates mean" and it cannot drift.

-- ---------------------------------------------------------------------------
-- 1. The reason, recorded
-- ---------------------------------------------------------------------------
-- Once published_at is null, nothing distinguishes "the plan lapsed and we
-- took it down" from "never published" or "the shop pulled it down itself" --
-- so the editor could show the page as a draft but could not say WHY, which is
-- the half of this that a shopkeeper actually experiences.
--
-- Same shape as published_at and first_published_at: a nullable timestamptz on
-- storefronts. Set by the trigger below, CLEARED by publish_storefront -- a
-- message that outlives its cause is worse than no message. Deliberately not
-- set by the shop's own `unpublish` (src/lib/storefront-admin.ts:594): that
-- page came down because somebody chose to, and it needs no explanation.
alter table public.storefronts add column lapse_unpublished_at timestamptz;

comment on column public.storefronts.lapse_unpublished_at is
  'When this page was taken down because the shop''s plan had lapsed and it then came back. Null for a page that is live, was never published, or was unpublished by the shop itself. Cleared by publish_storefront.';

-- ---------------------------------------------------------------------------
-- 2. "What do these dates mean", once, in a shape a trigger can use
-- ---------------------------------------------------------------------------
-- Identical to the case expression that was inlined in shop_effective_status
-- (20260818000200:21-28), moved verbatim so the two cannot disagree. It takes
-- a ROW, which is the whole point: OLD and NEW can each be handed to it and
-- answered about independently, with no second lookup to be caught by the
-- timing trap above.
--
-- `p_sub.id is null` reproduces the old `s.id is null` arm exactly: a shop with
-- no subscription row reaches this as a row of nulls from the LEFT JOIN below,
-- and must read `expired` rather than null. stable, not immutable: now().
-- Not security definer, because it reads no table -- the caller must already
-- hold the row.
create or replace function public.subscription_effective_status(p_sub public.shop_subscriptions)
returns text
language sql
stable
as $$
  select case
    when p_sub.id is null then 'expired'
    when p_sub.manual_status = 'suspended' then 'suspended'
    when p_sub.trial_ends_at is not null and now() < p_sub.trial_ends_at then 'trialing'
    when p_sub.current_period_end is not null and now() < p_sub.current_period_end then 'active'
    when p_sub.grace_until is not null and now() < p_sub.grace_until then 'grace'
    else 'expired'
  end;
$$;

revoke execute on function public.subscription_effective_status(public.shop_subscriptions) from public;
grant execute on function public.subscription_effective_status(public.shop_subscriptions) to authenticated;

-- Same signature, same volatility, same security posture, same answer -- the
-- body is now one call instead of an inlined case. Everything that already
-- depends on it (shop_effective_plan, shop_has_module, RLS policies, the
-- platform portal) is untouched, and verify-lapse.sql F0d pins that the two
-- functions agree row for row.
create or replace function public.shop_effective_status(p_shop_id uuid)
returns text
language sql security definer stable set search_path = public as $$
  select public.subscription_effective_status(s)
  from (select null::uuid as id) empty
  left join public.shop_subscriptions s on s.shop_id = p_shop_id;
$$;

-- ---------------------------------------------------------------------------
-- 3. The unpublish
-- ---------------------------------------------------------------------------
-- Fires when the row was PAST GRACE before the update and is not after it --
-- that is, the shop came back, however it came back.
--
-- THREE GUARDS, each of which is a bug if removed:
--
--   `published_at is not null` -- a shop that never published must not be
--   stamped with a reason. Without this, the editor would tell a shop that has
--   never had a page that its plan took its page down, which is simply untrue.
--   It is also what makes a test of this trigger non-vacuous: asserting
--   `published_at is null` after a return passes for a fixture that never
--   published at all.
--
--   `shop_has_module(new.shop_id, 'storefront')` -- storefronts carries a
--   BEFORE UPDATE gate, storefronts_module_gate / enforce_shop_module
--   ('storefront') (20260818000400:33), which RAISES `module_not_included` for
--   any write on behalf of a shop whose plan lacks the module. An unguarded
--   update here does not merely fail to unpublish: it raises, and the raise
--   propagates out of this trigger and ABORTS THE SUBSCRIPTION UPDATE THAT
--   FIRED IT -- record_payment returning a 500 for a shop the operator has
--   just taken money from. A shop that comes back onto a plan without
--   `storefront` therefore keeps published_at; its page stays dark either way,
--   because get_public_storefront ends in the same module check. The residual
--   case -- that shop later upgrading to a plan that does carry the module,
--   and its old page relighting -- is the pre-existing downgrade/upgrade
--   behaviour, unchanged by this file and not reachable through a lapse.
--
--   AFTER, not BEFORE -- it writes a different table, and it needs
--   shop_has_module to resolve against the NEW subscription row. Measured:
--   verify-lapse.sql F0.
--
-- security definer because the party doing the UPDATE is a service-role edge
-- function or an operator, and taking the page down must not depend on which.
create or replace function public.unpublish_storefront_on_return()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.subscription_effective_status(old) = 'expired'
     and public.subscription_effective_status(new) <> 'expired'
     and public.shop_has_module(new.shop_id, 'storefront')
  then
    update public.storefronts
       set published_at         = null,
           lapse_unpublished_at = now(),
           updated_at           = now()
     where shop_id = new.shop_id
       and published_at is not null;
  end if;
  return null;
end;
$$;

-- Trigger execution is authorised at CREATE TRIGGER time, not per firing, so
-- nothing needs EXECUTE on this and nobody should have it: it is security
-- definer and would otherwise be callable by anyone who could forge a trigger
-- context.
revoke execute on function public.unpublish_storefront_on_return() from public;

create trigger shop_subscriptions_unpublish_storefront_on_return
  after update on public.shop_subscriptions
  for each row
  execute function public.unpublish_storefront_on_return();

-- ---------------------------------------------------------------------------
-- 4. Publishing again clears the reason
-- ---------------------------------------------------------------------------
-- Otherwise the editor keeps saying "your plan lapsed and we took your page
-- down" over a page that is live -- the message outliving its cause.
--
-- Reproduced from 20260926000100 with one line added, because that is what
-- `create or replace function` requires; first_published_at's coalesce and
-- every other line are unchanged. It still refuses without the module
-- (20260926000100:33-35), which is exactly why a lapsed shop can only get its
-- page back by paying first.
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
    -- THE NEW LINE. The page is live, so there is no longer a lapse to explain.
    lapse_unpublished_at = null,
    draft                = null,
    updated_at           = now()
  where shop_id = p_shop_id;

  if v_draft ? 'whatsappE164' then
    update public.shops set whatsapp_e164 = v_draft->>'whatsappE164' where id = p_shop_id;
  end if;
end;
$$;

revoke execute on function public.publish_storefront(uuid) from public;
grant execute on function public.publish_storefront(uuid) to authenticated;
