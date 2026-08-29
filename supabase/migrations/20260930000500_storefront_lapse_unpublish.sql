-- Coming back from a lapse leaves the page a DRAFT.
--
-- THE DECISION. A shop that stops paying gets a month (20260930000400), keeps
-- every row it ever had, and its page goes dark. It goes dark whenever
-- shop_has_module() fails, and that is TWO statuses, not one: `expired` (the
-- shop resolves to the `free` plan, which carries no `storefront`) and
-- `suspended` (shop_has_module returns false outright). The trigger in section
-- 4 fires on both -- see its DARK, NOT EXPIRED note for why the difference
-- between the two still matters.
--
-- Whichever way it went dark, the day the shop pays again the page comes back
-- EXACTLY AS IT WAS. After a month away that page may be advertising last
-- month's prices to a customer who then orders at them, and the order path
-- honours the price the customer agreed to. Publishing again has to be a
-- deliberate act.
--
-- The one shop this is NOT true of, and the one exception below: an `expired`
-- shop that support has comped the `storefront` module to. Its page never
-- stopped serving, so its prices were never unseen, so there is nothing to
-- make deliberate -- section 4 skips it and takes nothing down. Suspension has
-- no such exception; no override survives it.
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
--
-- WHAT THIS FILE DOES TO SHOPS ALREADY IN THE DATABASE, ON THE PUSH ITSELF.
-- 20260930000400 (the grace month) sorts BEFORE this file, and its backfill
-- widens seven-day windows to thirty -- which is exactly the crossing this
-- trigger fires on. On a real `db push --include-all` that UPDATE runs while
-- this trigger does not yet exist, so THE PAGES IT REVIVES COME BACK LIVE,
-- NOT AS DRAFTS. That is a real exposure and it is accepted, because every
-- shop it revives satisfies `greatest(current_period_end, trial_ends_at) +
-- 30 days > now()` -- it is still INSIDE the new grace month, and the decision
-- (20260930000400) says a shop in grace serves its page. No shop that has
-- actually finished its month slips through: the widest gap the backfill can
-- close is 30 - 7 = 23 days, so the most this can do is relight a page that
-- has been dark for up to ~23 days of a month the shop still has. From the
-- push onward every return goes through this trigger, including a second
-- widening by an operator (verify-lapse F7).

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

-- WHEN is not enough, because the trigger below fires on SIX transitions and
-- they do not all mean the same thing. A shop whose plan ran out and a shop an
-- operator suspended both end up dark, both come back, and both have their page
-- taken down here -- but "your plan lapsed" said to a shop that was current on
-- its bill and was suspended by us is FALSE, and a false explanation is worse
-- than a vague one. It also loses the one piece of information a suspended shop
-- actually needs: that a person did this, and which person to talk to.
--
-- So the CAUSE is stored beside the timestamp, and the editor branches on it.
-- Two values, not free text, and constrained here rather than by convention:
-- the sentence on screen is a `case` over this column, and a third value
-- arriving would silently render nothing at all.
--
--   'lapsed'    -- the shop was past grace (status `expired`): a missed payment
--   'suspended' -- an operator had suspended the shop (status `suspended`)
--
-- The two columns are locked together by the check below: a reason with no
-- timestamp, or a timestamp with no reason, is a half-recorded cause and there
-- is no state of this table where either is meaningful. That is also what keeps
-- publish_storefront honest -- it clears the timestamp, so it MUST clear the
-- reason in the same statement or the write is refused outright rather than
-- leaving a message behind with nothing to hang it on.
alter table public.storefronts add column lapse_unpublished_reason text;

-- THE `is not null` IN THE SECOND ARM IS LOAD-BEARING, and it is not the same
-- fact as the `in (...)` beside it. A CHECK refuses a row only when it
-- evaluates to FALSE; it PASSES on NULL. With the timestamp set and the reason
-- NULL, `lapse_unpublished_reason in ('lapsed','suspended')` is NULL rather
-- than false, so without this conjunct the second arm reads `true and NULL` =
-- NULL, the first arm is false, and `false or NULL` is NULL -- accepted. The
-- sentence above claims BOTH directions ("a reason with no timestamp, OR a
-- timestamp with no reason"), and only the first of them survived three-valued
-- logic; `update storefronts set lapse_unpublished_reason = null` on a
-- stamped row was taken. Both directions are pinned in verify-lapse F1l/F1m,
-- and the value set itself in F1k.
alter table public.storefronts add constraint storefronts_lapse_reason_matches_stamp
  check (
    (lapse_unpublished_at is null and lapse_unpublished_reason is null)
    or (lapse_unpublished_at is not null and lapse_unpublished_reason is not null
        and lapse_unpublished_reason in ('lapsed', 'suspended'))
  );

comment on column public.storefronts.lapse_unpublished_at is
  'When this page was taken down because the shop had gone dark -- its plan lapsed, or it was suspended -- and it then came back. Null for a page that is live, was never published, or was unpublished by the shop itself. Cleared by publish_storefront. Which of the two causes it was is in lapse_unpublished_reason.';

comment on column public.storefronts.lapse_unpublished_reason is
  'WHY this page was taken down: ''lapsed'' (the plan ran past grace) or ''suspended'' (an operator suspended the shop). The editor says a different sentence for each, because telling a shop that was current on its bill that its plan lapsed is untrue. Always null exactly when lapse_unpublished_at is null; cleared by publish_storefront.';

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
-- 3. Taking a page DOWN is always allowed, module or no module
-- ---------------------------------------------------------------------------
-- storefronts carries a BEFORE INSERT OR UPDATE gate, storefronts_module_gate
-- / enforce_shop_module('storefront') (20260924000000:93, 20260818000400:33),
-- which RAISES `module_not_included` for ANY write on behalf of a shop whose
-- plan lacks the module. That raise is not a quiet refusal: inside the trigger
-- below it propagates out and ABORTS THE SUBSCRIPTION UPDATE THAT FIRED IT --
-- record_payment returning a 500 for a shop the operator has just taken money
-- from. No trigger TIMING avoids it: while the shop is past grace it resolves
-- to `free` and has no module either way.
--
-- Guarding the unpublish on shop_has_module (which is what this file did
-- first) buys that safety by leaving the page UP on the two paths the portal
-- itself drives -- suspend/pay/unsuspend, and lapse-on-a-plan-without-the-
-- module then upgrade -- both of which end in a month-old page serving
-- month-old prices, which is the exact harm this file exists to prevent.
--
-- So the gate is relaxed instead, at the root: A SHOP THAT HAS LOST THE MODULE
-- MAY ALWAYS HAVE ITS PAGE TAKEN DOWN. Refusing that write protects no
-- revenue -- the page it refuses to take down is a page the shop is no longer
-- paying for -- and it is the only write a gate has no interest in blocking.
--
-- The exemption is deliberately narrow, and narrow in a way that cannot rot:
--
--   * UPDATE only. An INSERT without the module still raises.
--   * published_at must go from NOT NULL to NULL. Setting it to a non-null
--     value -- publishing, or re-stamping a live page -- still raises.
--   * EVERY OTHER COLUMN MUST BE UNCHANGED, compared as jsonb rather than as a
--     hand-written column list, so a column added to storefronts tomorrow is
--     protected by this gate on the day it is added rather than the day
--     somebody remembers to extend a list. The four exempted keys are the
--     take-down itself (published_at) and the three pieces of bookkeeping that
--     describe it (lapse_unpublished_at and lapse_unpublished_reason, the
--     recorded cause; updated_at). None of those is page CONTENT: no headline,
--     price, theme, image or delivery area can move through this door.
--
--     SAY IT PLAINLY: those keys are not merely EXEMPT FROM COMPARISON, THE
--     CALLER CHOOSES THEIR VALUES. A shop member without the module, riding an
--     otherwise-valid take-down, can write a backdated lapse_unpublished_at, a
--     forged updated_at, or either reason string the check constraint permits
--     -- once, on a page that was up, and only through RLS they already hold.
--     That is accepted: the worst it buys is a wrong sentence in that shop's
--     OWN editor, on a page they were entitled to take down anyway. It is not
--     a hole to widen, though -- a reason stamped on a page that is ALREADY
--     down is still refused, because published_at must move from non-null to
--     null for the exemption to apply at all (verify-lapse F8k).
--
-- Only public.storefronts changes gate. storefront_delivery_areas,
-- storefront_flyers, orders and the other eleven gated tables keep
-- enforce_shop_module() exactly as it is -- a shop without the module still
-- cannot touch any of them.
create or replace function public.enforce_storefront_module()
returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_allowed boolean := public.shop_has_module(new.shop_id, 'storefront');
begin
  -- OLD is only read under UPDATE; `and` is not guaranteed to short-circuit,
  -- so this is a nested if rather than one condition.
  if not v_allowed and tg_op = 'UPDATE' then
    v_allowed := old.published_at is not null
             and new.published_at is null
             and (to_jsonb(new) - 'published_at' - 'lapse_unpublished_at' - 'lapse_unpublished_reason' - 'updated_at')
               = (to_jsonb(old) - 'published_at' - 'lapse_unpublished_at' - 'lapse_unpublished_reason' - 'updated_at');
  end if;

  if not v_allowed then
    -- Byte-for-byte the shape enforce_shop_module() raises, so the client's
    -- upgrade prompt cannot tell the two apart.
    raise exception 'module_not_included'
      using errcode = 'P0001',
            detail = json_build_object('module', 'storefront')::text,
            hint = 'Upgrade the plan to make changes here.';
  end if;

  return new;
end;
$$;

revoke execute on function public.enforce_storefront_module() from public;

-- Same trigger name, same timing, same events -- only the function behind it
-- changes, so nothing that reads pg_trigger or fires in name order moves.
drop trigger storefronts_module_gate on public.storefronts;
create trigger storefronts_module_gate
  before insert or update on public.storefronts
  for each row execute function public.enforce_storefront_module();

-- ---------------------------------------------------------------------------
-- 4. The unpublish
-- ---------------------------------------------------------------------------
-- Fires when the page was DARK before the update and is not after it -- that
-- is, the shop came back, however it came back.
--
-- "DARK", NOT "EXPIRED". A page stops serving for two statuses, not one:
-- `expired` (the plan lapsed, the shop resolves to `free`, so it has no
-- `storefront` module) and `suspended` (shop_has_module, 20260818000200:63,
-- returns false outright). The two are dark in DIFFERENT WAYS, and the
-- difference matters below:
--
--   * `suspended` is dark UNCONDITIONALLY. shop_has_module short-circuits to
--     false on it before it looks at anything else, so no comp, no override
--     and no plan can keep the page up.
--   * `expired` is dark only BECAUSE the free plan carries no `storefront`.
--     shop_has_module (20260818000200:68-72) also honours an unexpired
--     `module`/`storefront` row in shop_entitlement_overrides -- so an expired
--     shop that support has comped the module to STILL SERVES ITS PAGE.
--     Measured, not assumed: verify-lapse F12a.
--
-- That is the one case where "the page was dark" is simply not true, and the
-- take-down is justified by nothing but that premise: the whole reason to make
-- the shop publish again is that a page nobody could see for a month may be
-- advertising a month-old price. A page that never stopped serving has no such
-- gap, its prices were on display the whole time, and tearing it down (and
-- telling its owner a lapse did it) is a take-down of a live page for no
-- reason. So a comped shop is SKIPPED below.
--
-- Writing the condition as `= 'expired'` / `<> 'expired'` reads as though it
-- meant "no longer dark" and does not: it counts a shop going INTO suspension
-- as coming back, and does not count a shop coming OUT of one. Both halves
-- matter, and the second is a hole the portal's own buttons walk through --
-- suspend a lapsed shop, take its payment, unsuspend it, and every individual
-- step is a non-crossing while the page ends up live with last month's prices
-- on it (verify-lapse F9).
--
-- The consequence, stated rather than discovered: a shop that was suspended
-- and is unsuspended comes back to a DRAFT, even if it never lapsed. That is
-- the rule working, not a side effect -- its page was dark for the length of
-- the suspension, and coming back from dark is what has to be deliberate. It
-- is pinned by verify-lapse F10, and the shopkeeper is told why and can
-- publish in one tap.
--
-- WHICH CAUSE IS RECORDED. The OLD status is the state the page was dark in at
-- the moment it came back, so that is what gets written: `suspended` -> the
-- shop was suspended, anything else (i.e. `expired`) -> the plan lapsed. A shop
-- that lapsed AND was then suspended (verify-lapse F9) records `suspended`,
-- because that is the state it was actually in when it came back and it is the
-- half that names a person to talk to; the lapse has by then already been
-- settled by the payment that is part of the same sequence.
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
--   the comped-override skip -- the premise above, enforced. Only under
--   `expired`, never under `suspended`, because suspension is dark whatever the
--   overrides table says (verify-lapse F12i/F12j pin that the skip does NOT
--   let a suspended shop through: F12i that a comped shop coming out of
--   suspension loses its page, F12j that it is stamped `suspended`). It reads
--   the overrides table rather than calling shop_has_module, which would
--   answer about the NEW subscription row and report the shop coming back
--   rather than the page that was serving.
--
--   AFTER, not BEFORE -- it writes a different table, and section 3's gate
--   needs shop_has_module to resolve against the NEW subscription row.
--   Measured: verify-lapse.sql F0.
--
-- There is deliberately NO shop_has_module guard here. Section 3 is what makes
-- that safe: the take-down this runs is the one write the gate now permits
-- without the module, so a shop coming back onto a plan that does not carry
-- `storefront` has its page taken down too -- and record_payment still
-- succeeds (verify-lapse F6). The two changes go together; removing the guard
-- without relaxing the gate is what turns a payment into a 500.
--
-- security definer because the party doing the UPDATE is a service-role edge
-- function or an operator, and taking the page down must not depend on which.
create or replace function public.unpublish_storefront_on_return()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_was text := public.subscription_effective_status(old);
begin
  if v_was in ('expired', 'suspended')
     and public.subscription_effective_status(new) not in ('expired', 'suspended')
  then
    -- The page never went dark: an expired shop holding a comped `storefront`
    -- module served throughout. Nothing to make deliberate, so nothing to take
    -- down -- and no cause to stamp on it either.
    if v_was = 'expired' and exists (
         select 1 from public.shop_entitlement_overrides o
          where o.shop_id = new.shop_id
            and o.kind = 'module'
            and o.key = 'storefront'
            and (o.expires_at is null or o.expires_at > now()))
    then
      return null;
    end if;

    update public.storefronts
       set published_at             = null,
           lapse_unpublished_at     = now(),
           lapse_unpublished_reason = case when v_was = 'suspended' then 'suspended' else 'lapsed' end,
           updated_at               = now()
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

-- The WHEN clause keeps an UPDATE that changed nothing out of plpgsql
-- altogether -- `update ... set updated_at = updated_at`, an upsert that
-- rewrites a row identically, a client PATCH with no diff. Such a row can
-- never satisfy the condition above (old and new are the same row, so they
-- have the same status), so this costs nothing and saves two function calls
-- per no-op write on a table the platform portal touches on every action.
create trigger shop_subscriptions_unpublish_storefront_on_return
  after update on public.shop_subscriptions
  for each row
  when (old.* is distinct from new.*)
  execute function public.unpublish_storefront_on_return();

-- ---------------------------------------------------------------------------
-- 5. Publishing again clears the reason
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
    -- THE NEW LINES. The page is live, so there is no longer a take-down to
    -- explain -- and BOTH halves of the record go, together. The check
    -- constraint on storefronts makes that structural rather than a habit:
    -- clearing one and leaving the other refuses the write.
    lapse_unpublished_at     = null,
    lapse_unpublished_reason = null,
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
