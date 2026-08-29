-- One month of grace, and what a shop keeps while it lasts.
--
-- The decision this checks: when a plan lapses the shop gets a MONTH, not a
-- week, and through that month nothing about the shop changes -- the public
-- page still serves, the module still resolves, the data is all still there.
-- Only when the month is over does the page go dark, and even then the rows
-- stay.
--
-- Two of the checks here (section C) are REGRESSION GUARDS, not new
-- behaviour. Grace was already honoured before this work: shop_has_module()
-- names only `suspended`, but shop_effective_plan() (20260824000100:31) keeps
-- the shop's own plan for 'trialing' | 'active' | 'grace' and only falls back
-- to `free` for 'expired' | 'suspended'. Section C passed before
-- 20260930000400 landed and is expected to keep passing -- it exists so that
-- a later task that touches the gating cannot quietly take grace away.
--
-- What was actually wrong was the NUMBER: platform_settings.default_grace_days
-- was 7. Sections A, B and D are the new behaviour, and all three were red
-- before the migration. Section E is about what the migration SAYS at push
-- time: the count the owner reads is storefronts that come back, which is a
-- subset of the subscriptions that leave `expired` and can differ from it.
--
-- Section D re-runs THE MIGRATION FILE ITSELF (\ir) against hand-built
-- pre-migration rows. That is deliberate: a copy of the backfill's UPDATE
-- pasted into this file would prove only that the copy works. The migration
-- is written to be idempotent precisely so this is possible.

\set ON_ERROR_STOP on

-- Explicit transaction rather than the raise-'rollback_marker' trick the other
-- verify scripts use: \ir is a psql meta-command and cannot appear inside a DO
-- block, so section D needs a transaction psql itself can roll back.
begin;

-- ===========================================================================
-- A. The number, in both places it is written down
-- ===========================================================================
do $$
declare
  v_setting integer;
  v_default text;
begin
  select default_grace_days into v_setting from public.platform_settings where id;
  if v_setting is distinct from 30 then
    raise exception 'FAIL A1: platform_settings.default_grace_days is %, expected 30', v_setting;
  end if;

  -- The row and the column default are two separate facts. Changing only the
  -- row leaves the next database built from scratch back on the old number.
  select column_default into v_default
    from information_schema.columns
   where table_schema = 'public' and table_name = 'platform_settings'
     and column_name = 'default_grace_days';
  if v_default is distinct from '30' then
    raise exception 'FAIL A2: platform_settings.default_grace_days column default is %, expected 30', coalesce(v_default, '<null>');
  end if;

  raise notice 'A ok: the grace setting and its column default both say 30';
end $$;

-- ===========================================================================
-- B. A new shop is stamped with a month, not a week
-- ===========================================================================
-- Property 1 at the only place it is written for a NEW shop: the
-- start_shop_trial() trigger (20260818000100:32-39), which stamps
-- grace_until = trial end + default_grace_days at insert time. Nothing
-- recomputes it later, so the number has to be right when it is stamped.
do $$
declare
  v_user_id uuid := gen_random_uuid();
  v_shop_id uuid;
  v_gap     interval;
begin
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
    values (v_user_id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            'verify-lapse-b-' || v_user_id || '@example.test', '', now(), now(), now());

  insert into public.shops (owner_id, name) values (v_user_id, 'Lapse Trigger Shop')
    returning id into v_shop_id;

  select grace_until - trial_ends_at into v_gap
    from public.shop_subscriptions where shop_id = v_shop_id;

  if v_gap is null then
    raise exception 'FAIL B1: the trial trigger left trial_ends_at or grace_until null';
  end if;

  -- A window, not equality: the two dates are computed from the same now() so
  -- the gap is exact today, but an hour of slack costs nothing and this must
  -- never go red for a reason unrelated to the number.
  if v_gap < interval '29 days 23 hours' or v_gap > interval '30 days 1 hour' then
    raise exception 'FAIL B2: a new shop gets % of grace after its trial, expected 30 days', v_gap;
  end if;

  raise notice 'B ok: a new shop is stamped with % of grace', v_gap;
end $$;

-- ===========================================================================
-- C. Through the month nothing changes; after it, the page goes dark
-- ===========================================================================
-- REGRESSION GUARD (see the header). Expected to pass on the code that
-- existed before this migration as well as after it.
do $$
declare
  v_user_id       uuid := gen_random_uuid();
  v_shop_id       uuid;
  v_status        text;
  v_plan          text;
  v_rows          integer;
  v_products      integer;
  v_published     timestamptz;
  v_slug          text := 'lapse-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 12);
begin
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
    values (v_user_id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            'verify-lapse-c-' || v_user_id || '@example.test', '', now(), now(), now());

  insert into public.shops (owner_id, name, slug, whatsapp_e164)
    values (v_user_id, 'Lapse Grace Shop', v_slug, '+252634456789')
    returning id into v_shop_id;

  insert into public.shop_locations (shop_id, name, city, is_primary, active)
    values (v_shop_id, 'Road No.1', 'Hargeisa', true, true);

  insert into public.storefronts (shop_id, theme, palette, headline, published_at)
    values (v_shop_id, 'market', 'ink', 'Open 8am-9pm.', now());

  insert into public.products (shop_id, name, category, price_cents, cost_cents, stock, is_listed_online)
    values (v_shop_id, 'Solar lantern', 'Light', 1400, 900, 6, true);

  -- ------------------------------------------------- C1: one day into grace
  update public.shop_subscriptions
     set trial_ends_at      = now() - interval '1 day',
         current_period_end = null,
         grace_until        = now() + interval '29 days'
   where shop_id = v_shop_id;

  v_status := public.shop_effective_status(v_shop_id);
  if v_status <> 'grace' then
    raise exception 'FAIL C1: a shop one day past its trial with 29 days left reads %, expected grace', v_status;
  end if;

  -- The plan is what carries the module. A shop in grace keeps its OWN plan;
  -- falling back to `free` here is how the storefront would silently vanish.
  select key into v_plan from public.shop_effective_plan(v_shop_id);
  if v_plan <> 'trial' then
    raise exception 'FAIL C2: a shop in grace resolves to plan %, expected its own (trial)', v_plan;
  end if;

  if not public.shop_has_module(v_shop_id, 'storefront') then
    raise exception 'FAIL C3: a shop in grace does not resolve the storefront module';
  end if;

  -- Writes elsewhere in the product are gated the same way. If grace stopped
  -- honouring the plan, the till would stop too.
  if not public.shop_has_module(v_shop_id, 'pos') then
    raise exception 'FAIL C4: a shop in grace does not resolve the pos module';
  end if;

  select count(*) into v_rows from public.get_public_storefront(v_slug);
  if v_rows <> 1 then
    raise exception 'FAIL C5: a shop in grace serves % storefront rows, expected 1', v_rows;
  end if;

  select count(*) into v_products from public.get_public_storefront_products(v_slug);
  if v_products <> 1 then
    raise exception 'FAIL C6: a shop in grace serves % products, expected 1', v_products;
  end if;

  -- -------------------------------------------------- C7: the month is over
  update public.shop_subscriptions
     set grace_until = now() - interval '1 day'
   where shop_id = v_shop_id;

  v_status := public.shop_effective_status(v_shop_id);
  if v_status <> 'expired' then
    raise exception 'FAIL C7: a shop past its grace reads %, expected expired', v_status;
  end if;

  if public.shop_has_module(v_shop_id, 'storefront') then
    raise exception 'FAIL C8: a shop past its grace still resolves the storefront module';
  end if;

  select count(*) into v_rows from public.get_public_storefront(v_slug);
  if v_rows <> 0 then
    raise exception 'FAIL C9: a shop past its grace serves % storefront rows, expected 0', v_rows;
  end if;

  -- --------------------------------------------- C10: and the data is still there
  -- The whole decision is "keep the data". A page that stops serving because
  -- its rows were deleted is a different product from one that stops serving
  -- because the shop stopped paying, and only the second one can be undone by
  -- paying.
  select published_at into v_published from public.storefronts where shop_id = v_shop_id;
  if v_published is null then
    raise exception 'FAIL C10: lapsing unpublished the storefront -- published_at was cleared';
  end if;

  select count(*) into v_products from public.products where shop_id = v_shop_id;
  if v_products <> 1 then
    raise exception 'FAIL C11: lapsing removed the shop products -- % left, expected 1', v_products;
  end if;

  raise notice 'C ok: in grace the page serves and the modules resolve; past grace the page is dark and the rows remain';
end $$;

-- ===========================================================================
-- D. The backfill, run as the migration itself runs it
-- ===========================================================================
-- Property 4. The migration is re-applied here over rows shaped the way
-- production's are TODAY -- stamped with the old seven-day window -- because
-- a fresh `db reset` has no pre-migration rows to back-fill and an assertion
-- over an empty table proves nothing.
--
-- Re-applying is safe: every statement in 20260930000400 is guarded and
-- idempotent (see its header).
do $$
declare
  v_user_id uuid;
  v_shop_id uuid;
  v_name    text;
  v_row     record;
begin
  -- One shop per case the backfill has to get right. Each is created normally
  -- (so the trigger writes a well-formed row) and then rewritten to the
  -- pre-migration shape.
  foreach v_name in array array['trialing', 'paid', 'already-expired', 'hand-extended', 'no-dates', 'inverted-dates',
                               'extend-after-payment', 'revived-lit-page', 'revived-no-module'] loop
    v_user_id := gen_random_uuid();
    insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
      values (v_user_id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
              'verify-lapse-d-' || v_user_id || '@example.test', '', now(), now(), now());
    insert into public.shops (owner_id, name) values (v_user_id, 'Lapse Backfill ' || v_name)
      returning id into v_shop_id;
    update public.shop_subscriptions set notes = 'lapse-backfill:' || v_name where shop_id = v_shop_id;
  end loop;

  -- Still trialing, seven-day window: seven of the eleven live shops.
  update public.shop_subscriptions
     set trial_ends_at = now() + interval '66 days', current_period_end = null,
         grace_until   = now() + interval '73 days'
   where notes = 'lapse-backfill:trialing';

  -- Converted and paying: grace hangs off current_period_end, not the trial.
  update public.shop_subscriptions
     set trial_ends_at = now() - interval '30 days', current_period_end = now() + interval '10 days',
         grace_until   = now() + interval '17 days'
   where notes = 'lapse-backfill:paid';

  -- Trial ended 10 days ago, seven-day window already spent: currently dark.
  update public.shop_subscriptions
     set trial_ends_at = now() - interval '10 days', current_period_end = null,
         grace_until   = now() - interval '3 days'
   where notes = 'lapse-backfill:already-expired';

  -- Someone used extend_trial to give this one a year. The backfill must not
  -- take that away.
  update public.shop_subscriptions
     set trial_ends_at = now() + interval '5 days', current_period_end = null,
         grace_until   = now() + interval '365 days'
   where notes = 'lapse-backfill:hand-extended';

  -- Neither date. There is no end-of-paid-time to measure a month from.
  update public.shop_subscriptions
     set trial_ends_at = null, current_period_end = null, grace_until = now() - interval '3 days'
   where notes = 'lapse-backfill:no-dates';

  -- BOTH dates, and the period end is the EARLIER one. The two writers do not
  -- agree on which column is the base -- record_payment measures from
  -- coversTo, extend_trial from the trial end -- so a row can carry a stale
  -- current_period_end under a trial that runs on for another year. Reading
  -- the base with `coalesce` would take the stale one unconditionally and
  -- stamp a window that ended 70 days ago, dropping a trialing shop straight
  -- to expired with NO grace at all. This exact grace_until (null) is the
  -- worst case rather than a written one; the fixture below is the shape as an
  -- operator actually produces it.
  update public.shop_subscriptions
     set trial_ends_at = now() + interval '400 days', current_period_end = now() - interval '100 days',
         grace_until   = null
   where notes = 'lapse-backfill:inverted-dates';

  -- The same inverted shape, exactly as extend_trial leaves it -- because
  -- extend_trial writes trial_ends_at and grace_until and never touches
  -- current_period_end (platform-admin/index.ts:410-419). Record a payment
  -- covering to trial end + 30, then extend the trial by 90 days, and the row
  -- below is what is in the table: a period end 60 days behind the trial end,
  -- with the old seven-day window hanging off the NEW trial end.
  --
  -- Under `coalesce` this row is not stamped short, it is passed over
  -- altogether: base + 30 days = now + 80, which is before grace_until at
  -- now + 117, so the backfill's WHERE clause never matches it and the shop
  -- keeps seven days. That is the failure worth pinning -- silent, and on a
  -- shop somebody deliberately extended.
  update public.shop_subscriptions
     set trial_ends_at      = now() + interval '110 days',
         current_period_end = now() + interval '50 days',
         grace_until        = now() + interval '117 days'
   where notes = 'lapse-backfill:extend-after-payment';

  -- Two more shops that leave `expired`, to separate the status count from the
  -- storefront count. One has a published page on the trial plan, which
  -- carries `storefront`: its page is dark today and serves again after the
  -- backfill. The other has an identical published page but sits on
  -- `standard`, which does not carry the module (20260923000000), so it leaves
  -- `expired` and its page stays dark. The `already-expired` shop above is the
  -- third case: revived, with no storefronts row at all.
  --
  -- The pages are built FIRST, while both shops are still on their trial: the
  -- storefronts_module_gate trigger refuses a storefronts INSERT from a shop
  -- that does not currently have the module (the take-down exemption
  -- 20260930000500 adds is UPDATE-only, and pinned so in F8e), which is
  -- exactly the state the next two statements put them in. Publishing and then lapsing is also the
  -- order a real shop lives through.
  for v_row in
    select shop_id, notes from public.shop_subscriptions
     where notes in ('lapse-backfill:revived-lit-page', 'lapse-backfill:revived-no-module')
  loop
    update public.shops
       set slug = 'lapse-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 12)
     where id = v_row.shop_id;
    insert into public.storefronts (shop_id, theme, palette, headline, published_at)
      values (v_row.shop_id, 'market', 'ink', 'Open 8am-9pm.', now());
  end loop;

  update public.shop_subscriptions
     set plan_id = (select id from public.plans where key = 'standard')
   where notes = 'lapse-backfill:revived-no-module';

  update public.shop_subscriptions
     set trial_ends_at = now() - interval '10 days', current_period_end = null,
         grace_until   = now() - interval '3 days'
   where notes in ('lapse-backfill:revived-lit-page', 'lapse-backfill:revived-no-module');
end $$;

-- Roll the setting back to what production had, so the migration's own
-- guard on it is exercised rather than skipped.
update public.platform_settings set default_grace_days = 7 where id;

-- REPLAYING THE ORDER THE TWO MIGRATIONS ACTUALLY APPLY IN.
--
-- 20260930000500 adds an AFTER UPDATE trigger on shop_subscriptions that
-- unpublishes a page when a shop stops being past grace. The backfill below
-- revives shops from `expired` into `grace`, which is exactly that crossing --
-- so with the trigger live, re-running the backfill here takes down the very
-- pages section E is about to count.
--
-- In a real database that sequence CANNOT HAPPEN: 20260930000400 sorts before
-- 20260930000500, so the backfill runs at a point where this trigger does not
-- yet exist, and its push-time count of pages that come back is accurate.
-- Leaving the trigger enabled across this \ir would not test anything a
-- database will ever do; it would only make section D and E's fixtures
-- disagree with the migration they are re-running.
--
-- This is NOT sweeping the interaction under the rug -- section F7 pins it
-- head-on: a shop revived from expired into grace by an operator widening its
-- window, with the trigger in place, comes back as a draft.
alter table public.shop_subscriptions disable trigger shop_subscriptions_unpublish_storefront_on_return;

\ir ../migrations/20260930000400_storefront_grace_month.sql

alter table public.shop_subscriptions enable trigger shop_subscriptions_unpublish_storefront_on_return;

do $$
declare
  v_gap     interval;
  v_grace   timestamptz;
  v_status  text;
  v_setting integer;
begin
  select default_grace_days into v_setting from public.platform_settings where id;
  if v_setting <> 30 then
    raise exception 'FAIL D0: re-running the migration left default_grace_days at %', v_setting;
  end if;

  -- ------------------------------------------------ D1: trialing, extended
  select grace_until - trial_ends_at into v_gap
    from public.shop_subscriptions where notes = 'lapse-backfill:trialing';
  if v_gap < interval '29 days 23 hours' or v_gap > interval '30 days 1 hour' then
    raise exception 'FAIL D1: a trialing shop was left with % of grace, expected 30 days', v_gap;
  end if;

  -- ------------------------- D2: paid, measured from current_period_end
  select grace_until - current_period_end into v_gap
    from public.shop_subscriptions where notes = 'lapse-backfill:paid';
  if v_gap < interval '29 days 23 hours' or v_gap > interval '30 days 1 hour' then
    raise exception 'FAIL D2: a paying shop was left with % of grace after its period, expected 30 days', v_gap;
  end if;

  -- ---------------- D3: already expired, extended and therefore revived
  -- Stated plainly because it is the visible consequence: a shop whose
  -- seven-day window ran out is inside a thirty-day one, and its page comes
  -- back. That is what "keep the data, show the way back" means.
  select grace_until - trial_ends_at into v_gap
    from public.shop_subscriptions where notes = 'lapse-backfill:already-expired';
  if v_gap < interval '29 days 23 hours' or v_gap > interval '30 days 1 hour' then
    raise exception 'FAIL D3: an already-expired shop was left with % of grace, expected 30 days', v_gap;
  end if;

  select public.shop_effective_status(shop_id) into v_status
    from public.shop_subscriptions where notes = 'lapse-backfill:already-expired';
  if v_status <> 'grace' then
    raise exception 'FAIL D4: an already-expired shop 10 days past its trial reads %, expected grace', v_status;
  end if;

  -- -------------------------------- D5: a longer window is never shortened
  select grace_until into v_grace
    from public.shop_subscriptions where notes = 'lapse-backfill:hand-extended';
  if v_grace < now() + interval '364 days' then
    raise exception 'FAIL D5: a hand-extended window was shortened to %', v_grace;
  end if;

  -- ---------------------------- D6: no base date, nothing invented from air
  select grace_until into v_grace
    from public.shop_subscriptions where notes = 'lapse-backfill:no-dates';
  if v_grace > now() then
    raise exception 'FAIL D6: a row with no trial or period end was given a window ending %', v_grace;
  end if;

  -- ------------------- D7/D8: both dates, the period end the earlier of them
  -- The base is the LATER date, so this row's month hangs off its trial end
  -- 400 days out -- not off a period end that expired 100 days ago. Reading
  -- the base with `coalesce` puts D7's gap at about -470 days and D8's
  -- grace_until 70 days in the PAST, which is a trialing shop with a window
  -- that is already over: it would go dark the moment its trial ended.
  select grace_until - trial_ends_at into v_gap
    from public.shop_subscriptions where notes = 'lapse-backfill:inverted-dates';
  if v_gap < interval '29 days 23 hours' or v_gap > interval '30 days 1 hour' then
    raise exception 'FAIL D7: a shop whose period end predates its trial end got % of grace after that trial end, expected 30 days', v_gap;
  end if;

  select grace_until into v_grace
    from public.shop_subscriptions where notes = 'lapse-backfill:inverted-dates';
  if v_grace <= now() then
    raise exception 'FAIL D8: a shop still 400 days into its trial was stamped with a window that ended at %, i.e. no grace at all', v_grace;
  end if;

  -- ------------ D9: the shape extend_trial actually writes, not just the worst case
  -- `coalesce` would skip this row entirely rather than shorten it (see the
  -- fixture), leaving it on seven days. Measured from the trial end, which is
  -- the later of its two dates.
  select grace_until - trial_ends_at into v_gap
    from public.shop_subscriptions where notes = 'lapse-backfill:extend-after-payment';
  if v_gap < interval '29 days 23 hours' or v_gap > interval '30 days 1 hour' then
    raise exception 'FAIL D9: a shop extended after paying got % of grace after its trial end, expected 30 days', v_gap;
  end if;

  raise notice 'D ok: seven-day windows became thirty-day ones, a stale period end did not beat a live trial end, longer windows survived, and a dateless row was left alone';
end $$;

-- ===========================================================================
-- E. The push-time number counts storefronts, not subscriptions
-- ===========================================================================
-- The migration prints two counts: subscriptions leaving `expired`, and dark
-- storefronts that serve again. They are not the same number, and the second
-- is the one the owner reads before deciding to push.
--
-- psql cannot read a NOTICE back into SQL, so this does not assert the printed
-- string. It pins the FACT the string reports -- that among shops this
-- backfill revives, the two counts differ, and which shops fall in the gap --
-- using the same public read path the migration counts through. Scoped to the
-- section D fixtures by `notes`, because sections B and C leave shops of their
-- own in this transaction.
do $$
declare
  v_revived integer;
  v_lit     integer;
  v_status  text;
begin
  select count(*) into v_revived
    from public.shop_subscriptions s
   where s.notes in ('lapse-backfill:already-expired', 'lapse-backfill:revived-lit-page',
                     'lapse-backfill:revived-no-module')
     and public.shop_effective_status(s.shop_id) = 'grace';
  if v_revived <> 3 then
    raise exception 'FAIL E1: % of the 3 revival fixtures came back into grace', v_revived;
  end if;

  select count(*) into v_lit
    from public.shops sh
    join public.shop_subscriptions s on s.shop_id = sh.id
   where s.notes in ('lapse-backfill:already-expired', 'lapse-backfill:revived-lit-page',
                     'lapse-backfill:revived-no-module')
     and exists (select 1 from public.get_public_storefront(sh.slug));
  if v_lit <> 1 then
    raise exception 'FAIL E2: % of the 3 revived shops serve a page again, expected 1 -- the storefront count must not track the status count', v_lit;
  end if;

  -- Named, so a future reader knows which shop is which rather than trusting
  -- the arithmetic. A revived shop on `standard` is in grace and still dark.
  select public.shop_effective_status(s.shop_id) into v_status
    from public.shop_subscriptions s where s.notes = 'lapse-backfill:revived-no-module';
  if v_status <> 'grace' then
    raise exception 'FAIL E3: the no-module fixture reads %, expected grace', v_status;
  end if;
  if exists (select 1 from public.get_public_storefront(
               (select sh.slug from public.shops sh
                  join public.shop_subscriptions s on s.shop_id = sh.id
                 where s.notes = 'lapse-backfill:revived-no-module'))) then
    raise exception 'FAIL E4: a revived shop on a plan without the storefront module serves a page';
  end if;

  raise notice 'E ok: 3 subscriptions left expired and 1 storefront came back -- the counts differ, and the notice says so';
end $$;

-- ===========================================================================
-- F. Coming back from expiry leaves the page a DRAFT, on purpose
-- ===========================================================================
-- The other half of the decision, and the one nothing in this project had a
-- place to put. Sections A-E are about the month a shop gets; this is about
-- what it comes back TO.
--
-- WHY A TRIGGER AND NOT A JOB. There is no clock in this project. Status is
-- computed on every read (shop_effective_status, 20260818000200:18) -- no
-- stored column, no pg_cron, no scheduled anything -- and a migration runs
-- once, at deploy. So "at the end of grace" has no seam to hang code off. The
-- two lazy readings both fail: a lapsed shop cannot reach the editor at all
-- (T3 greys the row and routes taps to the upgrade wall), and
-- get_public_storefront is `stable` and called by anonymous customers, so it
-- cannot write and must not be made to. The moment that IS observable is the
-- shop coming BACK -- an UPDATE on shop_subscriptions -- and that is where
-- 20260930000500 hangs the unpublish.
--
-- WHAT IT IS FOR (property 2 of the brief): today the page is dark only
-- because shop_has_module fails, so paying makes it reappear EXACTLY AS IT
-- WAS. After a month away that page may be advertising last month's prices to
-- a customer who then orders at them. Publishing again should be a deliberate
-- act.
--
-- Every check below is scoped to its own fixture shop. Sections B, C and D
-- leave shops of their own in this same transaction.

-- One fixture shop, built the way a real one lives: created on trial (which
-- carries `storefront`, so the storefronts insert gate lets it through),
-- given a page, and only then pushed past its grace. Returns the shop id.
create function pg_temp.lapse_shop(p_name text, p_publish boolean default true, p_plan text default 'trial',
                                   p_expire boolean default true)
returns uuid language plpgsql as $$
declare
  v_user uuid := gen_random_uuid();
  v_shop uuid;
begin
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
    values (v_user, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            'verify-lapse-f-' || v_user || '@example.test', '', now(), now(), now());

  insert into public.shops (owner_id, name, slug, whatsapp_e164)
    values (v_user, p_name, 'lapse-f-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 12), '+252634456789')
    returning id into v_shop;

  insert into public.shop_locations (shop_id, name, city, is_primary, active)
    values (v_shop, 'Road No.1', 'Hargeisa', true, true);

  insert into public.products (shop_id, name, category, price_cents, cost_cents, stock, is_listed_online)
    values (v_shop, 'Solar lantern', 'Light', 1400, 900, 6, true);

  -- The page, plus the things the decision says must SURVIVE it: a flyer and
  -- a delivery area. Both are built while the shop still has the module,
  -- because their own insert gates would refuse them afterwards.
  insert into public.storefronts (shop_id, theme, palette, headline, published_at, first_published_at)
    values (v_shop, 'window', 'palm', 'Open 8am-9pm.',
            case when p_publish then now() - interval '90 days' else null end,
            case when p_publish then now() - interval '90 days' else null end);

  insert into public.storefront_flyers (shop_id, image_path, headline, position, draft)
    values (v_shop, 'flyers/' || v_shop || '.jpg', 'Solar week', 0, false);

  insert into public.storefront_delivery_areas (shop_id, name, fee_cents, sort_order)
    values (v_shop, 'Ahmed Dhagah', 1500, 0);

  if p_plan <> 'trial' then
    update public.shop_subscriptions set plan_id = (select id from public.plans where key = p_plan)
     where shop_id = v_shop;
  end if;

  -- Past grace. Its page is dark right now, and its rows are all still here.
  --
  -- p_expire => false leaves the shop on its ordinary trial instead, for the
  -- checks that need a shop which has NOT yet been past grace -- putting one
  -- there and taking it back out is itself a crossing, so a fixture that
  -- expires first cannot be used to prove what a non-crossing update does.
  if p_expire then
    update public.shop_subscriptions
       set trial_ends_at = now() - interval '40 days', current_period_end = null,
           grace_until   = now() - interval '10 days'
     where shop_id = v_shop;

    if public.shop_effective_status(v_shop) <> 'expired' then
      raise exception 'FAIL F-fixture: % was built past grace but reads %', p_name, public.shop_effective_status(v_shop);
    end if;
  elsif public.shop_effective_status(v_shop) <> 'trialing' then
    raise exception 'FAIL F-fixture: % was built to stay on trial but reads %', p_name, public.shop_effective_status(v_shop);
  end if;

  return v_shop;
end $$;

-- ---------------------------------------------------------------------------
-- F0. WHICH ROW THE TRIGGER ACTUALLY SEES -- measured, not assumed
-- ---------------------------------------------------------------------------
-- shop_effective_status(shop_id) takes a SHOP ID and selects from
-- shop_subscriptions itself. So inside a trigger it does not report "the row
-- as passed in"; it reports whatever is in the table at that instant. A
-- BEFORE UPDATE trigger sees the OLD dates, an AFTER UPDATE trigger sees the
-- NEW ones, and in EITHER timing calling it twice yields the SAME answer
-- twice.
--
-- That is why 20260930000500 derives both sides from OLD and NEW directly
-- (through subscription_effective_status, which takes a ROW). The obvious
-- alternative -- call shop_effective_status before and after -- produces a
-- condition of the form `x = 'expired' and x <> 'expired'`, which is false for
-- every row, i.e. a trigger that never fires and whose tests all pass by
-- accident because nothing ever changes.
--
-- This block installs its own throwaway probes and records what each timing
-- sees, so the claim above is a measurement in this file rather than a comment
-- somebody has to trust.
create temp table lapse_probe_log (phase text, seen text);

create function pg_temp.lapse_probe_before() returns trigger language plpgsql as $$
begin
  insert into lapse_probe_log values ('before', public.shop_effective_status(new.shop_id));
  return new;
end $$;

create function pg_temp.lapse_probe_after() returns trigger language plpgsql as $$
begin
  insert into lapse_probe_log values ('after', public.shop_effective_status(new.shop_id));
  return null;
end $$;

-- Named to sort after the real trigger, so the real one has already run and
-- cannot be perturbed by these.
create trigger zzz_lapse_probe_before before update on public.shop_subscriptions
  for each row execute function pg_temp.lapse_probe_before();
create trigger zzz_lapse_probe_after after update on public.shop_subscriptions
  for each row execute function pg_temp.lapse_probe_after();

do $$
declare
  v_shop   uuid;
  v_before text;
  v_after  text;
begin
  v_shop := pg_temp.lapse_shop('Lapse Probe Shop');
  -- The fixture's own final UPDATE fired the probes too; only the crossing
  -- update below is being measured.
  delete from lapse_probe_log;

  update public.shop_subscriptions
     set current_period_end = now() + interval '30 days', grace_until = now() + interval '60 days'
   where shop_id = v_shop;

  select seen into v_before from lapse_probe_log where phase = 'before';
  select seen into v_after  from lapse_probe_log where phase = 'after';

  if v_before <> 'expired' then
    raise exception 'FAIL F0a: inside BEFORE UPDATE, shop_effective_status() read %, expected the PRE-update expired', v_before;
  end if;
  if v_after <> 'active' then
    raise exception 'FAIL F0b: inside AFTER UPDATE, shop_effective_status() read %, expected the POST-update active', v_after;
  end if;
  if v_before = v_after then
    raise exception 'FAIL F0c: both trigger timings read the same status (%), so before/after cannot come from two calls to it', v_before;
  end if;

  raise notice 'F0 ok: BEFORE UPDATE reads % and AFTER UPDATE reads % -- one timing cannot yield both, so the trigger reads OLD and NEW', v_before, v_after;
end $$;

drop trigger zzz_lapse_probe_before on public.shop_subscriptions;
drop trigger zzz_lapse_probe_after on public.shop_subscriptions;

-- ---------------------------------------------------------------------------
-- F0d. The refactor did not change what a status MEANS
-- ---------------------------------------------------------------------------
-- 20260930000500 moves the case expression out of shop_effective_status and
-- into subscription_effective_status, then redefines the former to call the
-- latter. Everything in this product that gates on a plan goes through
-- shop_effective_status -- shop_effective_plan, shop_has_module, the RLS
-- policies, the platform portal -- so a divergence of one arm would be a
-- silent entitlement change.
--
-- Checked over every subscription row in this transaction, which by now
-- includes the sections B, C and D fixtures: trialing, active, grace, expired,
-- a row with neither date, and rows with inverted dates. Not a hand-written
-- list of cases, which could only miss the arm somebody got wrong.
do $$
declare
  v_rows      integer;
  v_disagree  integer;
  v_statuses  integer;
begin
  select count(*), count(*) filter (
           where public.shop_effective_status(s.shop_id)
                 is distinct from public.subscription_effective_status(s))
    into v_rows, v_disagree
    from public.shop_subscriptions s;

  if v_disagree > 0 then
    raise exception 'FAIL F0d: % of % subscription rows get a different status from shop_effective_status() than from subscription_effective_status()', v_disagree, v_rows;
  end if;

  -- Otherwise "they agree" could mean "both say the same thing about
  -- everything", which a pair of functions that always returned `expired`
  -- would also satisfy.
  select count(distinct public.subscription_effective_status(s)) into v_statuses
    from public.shop_subscriptions s;
  if v_statuses < 3 then
    raise exception 'FAIL F0e: the fixtures only exercise % distinct status(es), so agreement between the two functions proves little', v_statuses;
  end if;

  -- A shop with no subscription row at all must still read `expired`, not
  -- null -- the arm the old body wrote as `s.id is null` off a LEFT JOIN.
  if public.shop_effective_status(gen_random_uuid()) is distinct from 'expired' then
    raise exception 'FAIL F0f: a shop with no subscription row reads %, expected expired', coalesce(public.shop_effective_status(gen_random_uuid()), '<null>');
  end if;

  raise notice 'F0d ok: both functions agree on all % rows across % distinct statuses, and a shop with no row still reads expired', v_rows, v_statuses;
end $$;

-- ---------------------------------------------------------------------------
-- F1. A payment brings the shop back, and the page comes back as a DRAFT
-- ---------------------------------------------------------------------------
do $$
declare
  v_shop      uuid;
  v_slug      text;
  v_row       record;
  v_flyers    integer;
  v_areas     integer;
  v_products  integer;
begin
  v_shop := pg_temp.lapse_shop('Lapse Paid Shop');
  select slug into v_slug from public.shops where id = v_shop;

  -- record_payment's shape (supabase/functions/platform-admin/index.ts:472):
  -- a period end in the future, and grace stamped past it.
  update public.shop_subscriptions
     set current_period_end = now() + interval '30 days', grace_until = now() + interval '60 days'
   where shop_id = v_shop;

  if public.shop_effective_status(v_shop) <> 'active' then
    raise exception 'FAIL F1a: the paid shop reads %, expected active', public.shop_effective_status(v_shop);
  end if;

  select * into v_row from public.storefronts where shop_id = v_shop;

  if v_row.published_at is not null then
    raise exception 'FAIL F1b: a shop that came back from expiry still has its page LIVE (published_at %) -- paying republished it silently', v_row.published_at;
  end if;

  if v_row.lapse_unpublished_at is null then
    raise exception 'FAIL F1c: the page was taken down with no reason recorded -- the editor cannot say WHY it is a draft';
  end if;

  -- WHICH reason, not merely that there is one. This shop's bill ran out; the
  -- editor's sentence for it is "your plan had lapsed", and F10 requires the
  -- OTHER value for a shop that was suspended instead. The two checks together
  -- are what a single shared sentence could not satisfy.
  if v_row.lapse_unpublished_reason is distinct from 'lapsed' then
    raise exception 'FAIL F1j: a shop whose PLAN ran out was recorded as %, expected lapsed -- the editor would explain the wrong cause', coalesce(v_row.lapse_unpublished_reason, '<null>');
  end if;

  -- ...and the cause is CONSTRAINED, not free text. The editor renders a
  -- `case` over exactly two values; a third would render nothing at all and
  -- put the shop back to guessing, silently. This shop has the module, so the
  -- module gate cannot be what refuses the write below -- only the constraint
  -- can be.
  begin
    update public.storefronts set lapse_unpublished_reason = 'paused' where shop_id = v_shop;
    raise exception 'FAIL F1k: storefronts accepted the cause "paused" -- the column is free text, so a value the editor has no sentence for can be written to it';
  exception when check_violation then
    null;
  end;

  -- The other half of the same constraint: the timestamp and the cause are one
  -- record. Clearing either alone leaves a message with nothing to hang it on,
  -- which is how publish_storefront is held to clearing both.
  begin
    update public.storefronts set lapse_unpublished_at = null where shop_id = v_shop;
    raise exception 'FAIL F1l: the take-down timestamp was cleared while the cause stayed behind -- half a record, and a sentence that outlives its cause';
  exception when check_violation then
    null;
  end;

  -- EVERYTHING ELSE STAYS. This is the whole decision: keep the data.
  if v_row.theme <> 'window' or v_row.palette <> 'palm' or v_row.headline <> 'Open 8am-9pm.' then
    raise exception 'FAIL F1d: the unpublish rewrote the page content -- theme %, palette %, headline %', v_row.theme, v_row.palette, v_row.headline;
  end if;

  -- first_published_at is deliberately never cleared (20260926000100), so the
  -- "Chosen for you" badge does not come back for a shop that has chosen.
  if v_row.first_published_at is null then
    raise exception 'FAIL F1e: the unpublish cleared first_published_at -- "Chosen for you" would come back for a shop that has already chosen';
  end if;

  select count(*) into v_flyers   from public.storefront_flyers where shop_id = v_shop;
  select count(*) into v_areas    from public.storefront_delivery_areas where shop_id = v_shop;
  select count(*) into v_products from public.products where shop_id = v_shop;
  if v_flyers <> 1 or v_areas <> 1 or v_products <> 1 then
    raise exception 'FAIL F1f: the unpublish took data with it -- % flyer(s), % delivery area(s), % product(s), expected 1 of each', v_flyers, v_areas, v_products;
  end if;

  if (select slug from public.shops where id = v_shop) is distinct from v_slug then
    raise exception 'FAIL F1g: the unpublish released the shop slug';
  end if;

  -- And the consequence a customer sees: the address does not serve, even
  -- though the shop is paying again and the module resolves.
  if not public.shop_has_module(v_shop, 'storefront') then
    raise exception 'FAIL F1h: the paid shop does not resolve the storefront module -- the rest of this check would pass for the wrong reason';
  end if;
  if exists (select 1 from public.get_public_storefront(v_slug)) then
    raise exception 'FAIL F1i: the page serves again the moment the shop pays -- it must be republished deliberately';
  end if;

  raise notice 'F1 ok: paying brought the shop back and the page came back as a draft, with the flyer, the area, the products, the theme and the slug all still there';
end $$;

-- ---------------------------------------------------------------------------
-- F2. An EXTENSION brings it back too -- the trigger is not keyed to one column
-- ---------------------------------------------------------------------------
-- extend_trial (platform-admin/index.ts:404-419) writes trial_ends_at and
-- grace_until and never touches current_period_end. A trigger written against
-- the payment path alone would miss it -- and so would an edit to
-- record_payment, which is why this lives in the database and not in the edge
-- function.
do $$
declare
  v_shop      uuid;
  v_published timestamptz;
begin
  v_shop := pg_temp.lapse_shop('Lapse Extended Shop');

  update public.shop_subscriptions
     set trial_ends_at = now() + interval '90 days', grace_until = now() + interval '120 days'
   where shop_id = v_shop;

  if public.shop_effective_status(v_shop) <> 'trialing' then
    raise exception 'FAIL F2a: the extended shop reads %, expected trialing', public.shop_effective_status(v_shop);
  end if;

  select published_at into v_published from public.storefronts where shop_id = v_shop;
  if v_published is not null then
    raise exception 'FAIL F2b: an operator extending the trial relit the page silently (published_at %)', v_published;
  end if;

  raise notice 'F2 ok: an extension brings the shop back and the page is a draft, same as a payment';
end $$;

-- ---------------------------------------------------------------------------
-- F3. An update that does not cross the boundary does NOTHING
-- ---------------------------------------------------------------------------
-- Property 4, the half that a passing test can hide: a trigger that fires on
-- EVERY update looks identical to a correct one in F1 and F2. These are the
-- three non-crossings a real database produces.
do $$
declare
  v_shop      uuid;
  v_published timestamptz;
  v_reason    timestamptz;
begin
  -- ---- F3a: still expired, and staying expired (grace pushed further back)
  v_shop := pg_temp.lapse_shop('Lapse Still Expired Shop');
  update public.shop_subscriptions
     set grace_until = now() - interval '200 days'
   where shop_id = v_shop;

  select published_at, lapse_unpublished_at into v_published, v_reason
    from public.storefronts where shop_id = v_shop;
  if v_published is null then
    raise exception 'FAIL F3a: an update that left the shop expired unpublished the page -- the page must survive the lapse itself';
  end if;
  if v_reason is not null then
    raise exception 'FAIL F3b: an update that changed nothing stamped a lapse reason';
  end if;

  -- ---- F3c: paying, and paying again. The second payment must be inert.
  v_shop := pg_temp.lapse_shop('Lapse Paid Twice Shop');
  update public.shop_subscriptions
     set current_period_end = now() + interval '30 days', grace_until = now() + interval '60 days'
   where shop_id = v_shop;
  select lapse_unpublished_at into v_reason from public.storefronts where shop_id = v_shop;
  if v_reason is null then
    raise exception 'FAIL F3c: the first payment did not unpublish -- the rest of this check would pass for the wrong reason';
  end if;

  -- A shop that publishes again while paying, then pays again. Both halves of
  -- the record clear together -- storefronts_lapse_reason_matches_stamp refuses
  -- a write that clears one and leaves the other.
  update public.storefronts
     set published_at = now(), lapse_unpublished_at = null, lapse_unpublished_reason = null
   where shop_id = v_shop;
  update public.shop_subscriptions
     set current_period_end = now() + interval '60 days', grace_until = now() + interval '90 days'
   where shop_id = v_shop;

  select published_at, lapse_unpublished_at into v_published, v_reason
    from public.storefronts where shop_id = v_shop;
  if v_published is null then
    raise exception 'FAIL F3d: a second payment from an ALREADY PAYING shop tore its live page down';
  end if;
  if v_reason is not null then
    raise exception 'FAIL F3e: a second payment from an already paying shop stamped a lapse reason on a live page';
  end if;

  -- ---- F3f: the lapse itself. Falling OUT of grace must not touch the page.
  -- Section C10 pins this for the whole grace path; restated here scoped to
  -- the trigger, because inverting its comparison is the single most likely
  -- way to get this wrong and it would show up exactly here.
  --
  -- Built to STAY on trial (p_expire => false): a shop pushed past grace and
  -- then pulled back into it has already crossed the boundary once, and would
  -- arrive at the lapse below with its page already down -- an assertion that
  -- passes no matter which direction the trigger runs in.
  v_shop := pg_temp.lapse_shop('Lapse Falling Out Shop', p_expire => false);
  update public.shop_subscriptions
     set trial_ends_at = now() - interval '1 day', current_period_end = null,
         grace_until = now() + interval '29 days'
   where shop_id = v_shop;
  if public.shop_effective_status(v_shop) <> 'grace' then
    raise exception 'FAIL F3f: the fixture did not land in grace, it reads %', public.shop_effective_status(v_shop);
  end if;
  -- ...and now out of it.
  update public.shop_subscriptions set grace_until = now() - interval '1 day' where shop_id = v_shop;
  select published_at into v_published from public.storefronts where shop_id = v_shop;
  if v_published is null then
    raise exception 'FAIL F3g: LAPSING unpublished the page -- the trigger is running in the wrong direction';
  end if;

  raise notice 'F3 ok: staying expired, paying twice and lapsing all leave the page exactly as they found it';
end $$;

-- ---------------------------------------------------------------------------
-- F4. A shop that never published is never told its plan took its page down
-- ---------------------------------------------------------------------------
-- The trap the brief names: a check that asserts `published_at is null` after
-- a return passes for a fixture that never published in the first place. The
-- REASON column is what separates the two, and stamping it here would put a
-- sentence on the editor that is simply untrue.
do $$
declare
  v_shop   uuid;
  v_reason timestamptz;
begin
  v_shop := pg_temp.lapse_shop('Lapse Never Published Shop', p_publish => false);
  update public.shop_subscriptions
     set current_period_end = now() + interval '30 days', grace_until = now() + interval '60 days'
   where shop_id = v_shop;

  select lapse_unpublished_at into v_reason from public.storefronts where shop_id = v_shop;
  if v_reason is not null then
    raise exception 'FAIL F4: a shop that has NEVER published was stamped as unpublished-by-lapse -- the editor would tell it a page it never had was taken down';
  end if;

  raise notice 'F4 ok: a shop that never published is not told its lapse took a page down';
end $$;

-- ---------------------------------------------------------------------------
-- F5. Publishing again clears the reason, and a SECOND cycle still works
-- ---------------------------------------------------------------------------
-- Property 3's second half: the message must not outlive its cause. And
-- property 4 at full length -- a shop that has since republished is not
-- damaged by the next lapse-and-return, it simply goes through it again.
do $$
declare
  v_shop      uuid;
  v_owner     uuid;
  v_published timestamptz;
  v_reason    timestamptz;
  v_first     timestamptz;
begin
  v_shop := pg_temp.lapse_shop('Lapse Republish Shop');
  select owner_id into v_owner from public.shops where id = v_shop;
  select first_published_at into v_first from public.storefronts where shop_id = v_shop;

  -- Cycle one: pay, get unpublished.
  update public.shop_subscriptions
     set current_period_end = now() + interval '30 days', grace_until = now() + interval '60 days'
   where shop_id = v_shop;
  select lapse_unpublished_at into v_reason from public.storefronts where shop_id = v_shop;
  if v_reason is null then
    raise exception 'FAIL F5a: cycle one did not unpublish -- everything after this would pass for the wrong reason';
  end if;

  -- The shop publishes again, through the real function, as the real owner.
  -- publish_storefront refuses without the module (20260926000100:33-35),
  -- which is exactly why this only works now that the shop has paid.
  perform set_config('request.jwt.claims', json_build_object('sub', v_owner)::text, true);
  perform set_config('role', 'authenticated', true);
  perform public.publish_storefront(v_shop);
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims', null, true);

  select published_at, lapse_unpublished_at into v_published, v_reason
    from public.storefronts where shop_id = v_shop;
  if v_published is null then
    raise exception 'FAIL F5b: publish_storefront did not put the page back up';
  end if;
  if v_reason is not null then
    raise exception 'FAIL F5c: the page is live again and still carries a lapse reason -- the editor would keep saying the plan took it down';
  end if;
  -- BOTH halves, behaviourally. storefronts_lapse_reason_matches_stamp already
  -- refuses a publish that clears one and not the other, but a constraint and
  -- the code it holds honest should not be each other's only test: drop the
  -- constraint and this is what still notices.
  if (select lapse_unpublished_reason from public.storefronts where shop_id = v_shop) is not null then
    raise exception 'FAIL F5i: publishing cleared the timestamp but left the CAUSE behind -- half a record, and the next take-down would report the old cause';
  end if;

  -- Cycle two: lapse again, then come back again. The page must go down
  -- again, and the earlier republish must not have broken anything.
  update public.shop_subscriptions
     set trial_ends_at = now() - interval '40 days', current_period_end = now() - interval '35 days',
         grace_until   = now() - interval '10 days'
   where shop_id = v_shop;
  if public.shop_effective_status(v_shop) <> 'expired' then
    raise exception 'FAIL F5d: the second lapse did not expire the shop, it reads %', public.shop_effective_status(v_shop);
  end if;
  select published_at into v_published from public.storefronts where shop_id = v_shop;
  if v_published is null then
    raise exception 'FAIL F5e: the second lapse took the page down by itself -- lapsing must keep the data';
  end if;

  update public.shop_subscriptions
     set current_period_end = now() + interval '30 days', grace_until = now() + interval '60 days'
   where shop_id = v_shop;
  select published_at, lapse_unpublished_at into v_published, v_reason
    from public.storefronts where shop_id = v_shop;
  if v_published is not null then
    raise exception 'FAIL F5f: the SECOND return left the page live -- the trigger only works once';
  end if;
  if v_reason is null then
    raise exception 'FAIL F5g: the second return recorded no reason';
  end if;

  if (select first_published_at from public.storefronts where shop_id = v_shop) is distinct from v_first then
    raise exception 'FAIL F5h: two cycles moved first_published_at, which is set once and never changed';
  end if;

  raise notice 'F5 ok: publishing again clears the reason, and a second lapse-and-return takes the page down again without damaging anything';
end $$;

-- ---------------------------------------------------------------------------
-- F6. THE SECOND REPRODUCTION: lapse on a plan without `storefront`, pay,
--     upgrade -- and the payment must still go through
-- ---------------------------------------------------------------------------
-- storefronts carries a BEFORE INSERT OR UPDATE gate -- storefronts_module_gate
-- (20260924000000:93) -- that raises `module_not_included` for ANY write from a
-- shop whose plan lacks the module. An unpublish inside an AFTER UPDATE trigger
-- therefore does not merely fail to unpublish: it RAISES, and the raise
-- propagates out of the trigger and aborts the subscription UPDATE that fired
-- it. That is record_payment returning a 500 for a shop the operator has just
-- taken money from. BOTH HALVES ARE PINNED HERE, and they are the same check:
--
--   * the payment must not raise (F6a) -- what the module guard used to buy;
--   * the page must come DOWN anyway (F6c/F6d) -- what the guard used to cost.
--
-- Because with the guard, this shop kept published_at, and the day it upgraded
-- to a plan that DOES carry `storefront` its month-old page relit with nobody
-- deciding anything (F6e/F6f). 20260930000500 section 3 is what lets both be
-- true at once: the gate now permits a take-down without the module, so the
-- trigger needs no guard.
do $$
declare
  v_shop  uuid;
  v_slug  text;
  v_row   record;
begin
  v_shop := pg_temp.lapse_shop('Lapse No Module Shop', p_plan => 'standard');
  select slug into v_slug from public.shops where id = v_shop;

  if public.shop_has_module(v_shop, 'storefront') then
    raise exception 'FAIL F6-fixture: the standard-plan fixture resolves the storefront module, so this check proves nothing';
  end if;

  begin
    update public.shop_subscriptions
       set current_period_end = now() + interval '30 days', grace_until = now() + interval '60 days'
     where shop_id = v_shop;
  exception when others then
    raise exception 'FAIL F6a: recording a payment for a revived shop on a plan without the storefront module raised % -- the trigger aborts the operator''s payment', sqlerrm;
  end;

  if public.shop_effective_status(v_shop) <> 'active' then
    raise exception 'FAIL F6b: the payment did not take -- the shop reads %', public.shop_effective_status(v_shop);
  end if;

  select * into v_row from public.storefronts where shop_id = v_shop;
  if v_row.published_at is not null then
    raise exception 'FAIL F6c: a shop that came back onto a plan WITHOUT the storefront module kept its page live (published_at %) -- it is dark only while the plan lacks the module, and relights the day it upgrades', v_row.published_at;
  end if;
  if v_row.lapse_unpublished_at is null then
    raise exception 'FAIL F6d: the page came down with no reason recorded';
  end if;
  if v_row.headline <> 'Open 8am-9pm.' then
    raise exception 'FAIL F6e: the take-down went through the gate and changed the page content -- headline reads %', v_row.headline;
  end if;

  -- ...and now the upgrade that used to relight it. `standard` -> `pro`, the
  -- ordinary plan change, which is another UPDATE on shop_subscriptions that
  -- crosses nothing (active before, active after).
  update public.shop_subscriptions
     set plan_id = (select id from public.plans where key = 'pro')
   where shop_id = v_shop;

  if not public.shop_has_module(v_shop, 'storefront') then
    raise exception 'FAIL F6f: the upgrade did not grant the storefront module, so the rest of this check would pass for the wrong reason';
  end if;
  if (select published_at from public.storefronts where shop_id = v_shop) is not null then
    raise exception 'FAIL F6g: upgrading onto a plan with the storefront module relit a month-old page';
  end if;
  if exists (select 1 from public.get_public_storefront(v_slug)) then
    raise exception 'FAIL F6h: the page serves after the upgrade -- last month''s prices are back with nobody deciding so';
  end if;

  raise notice 'F6 ok: a revived shop on a plan without the storefront module takes its payment without raising, its page comes down anyway, and upgrading does not relight it';
end $$;

-- ---------------------------------------------------------------------------
-- F7. Widening the WINDOW brings a shop back too, and that page is a draft
-- ---------------------------------------------------------------------------
-- The third way back, after a payment (F1) and an extension (F2): an operator
-- moving grace_until forward, which lands the shop in `grace` rather than
-- `active` or `trialing`. It is not hypothetical -- it is precisely what the
-- 20260930000400 backfill does, and section D above has to disable this
-- trigger to replay that migration in the order a real database applies it.
-- This block is where that interaction is stated outright instead: the ONLY
-- reason section D's pages survive is the apply order, and any widening that
-- happens after this migration is deployed takes the page down.
do $$
declare
  v_shop      uuid;
  v_published timestamptz;
  v_reason    timestamptz;
begin
  v_shop := pg_temp.lapse_shop('Lapse Widened Window Shop');

  -- grace_until forward and nothing else -- the shop has not paid and its
  -- trial has not moved. Exactly the backfill's own UPDATE.
  update public.shop_subscriptions
     set grace_until = now() + interval '20 days'
   where shop_id = v_shop;

  if public.shop_effective_status(v_shop) <> 'grace' then
    raise exception 'FAIL F7a: the widened shop reads %, expected grace', public.shop_effective_status(v_shop);
  end if;

  select published_at, lapse_unpublished_at into v_published, v_reason
    from public.storefronts where shop_id = v_shop;
  if v_published is not null then
    raise exception 'FAIL F7b: widening the grace window relit the page silently (published_at %) -- only `active` and `trialing` are being treated as coming back', v_published;
  end if;
  if v_reason is null then
    raise exception 'FAIL F7c: the page came down with no reason recorded';
  end if;

  raise notice 'F7 ok: an operator widening the window brings the shop back into grace and the page comes back as a draft';
end $$;

-- ---------------------------------------------------------------------------
-- F8. THE GATE ITSELF: a take-down passes, and NOTHING else does
-- ---------------------------------------------------------------------------
-- 20260930000500 section 3 relaxes storefronts_module_gate so that a shop
-- without the module may take its page DOWN. That is a security gate, so the
-- relaxation is only as good as its edges: this block walks each edge and
-- requires the raise to still be there.
--
-- The fixture is a shop on `standard` (no storefront module) that is NOT
-- expired -- it is trialing, with a live page. So every raise below is the
-- gate, not the subscription status, and the shop has a page to try to change.
do $$
declare
  v_shop      uuid;
  v_other     uuid;
  v_err       text;
  v_published timestamptz;
  v_headline  text;
begin
  v_shop := pg_temp.lapse_shop('Lapse Gate Shop', p_plan => 'standard', p_expire => false);
  if public.shop_has_module(v_shop, 'storefront') then
    raise exception 'FAIL F8-fixture: the gate fixture resolves the storefront module, so nothing below would raise for the right reason';
  end if;

  -- ---- F8a: page CONTENT still refused.
  v_err := null;
  begin
    update public.storefronts set headline = 'Half price this week.' where shop_id = v_shop;
  exception when others then v_err := sqlerrm;
  end;
  if v_err is distinct from 'module_not_included' then
    raise exception 'FAIL F8a: a shop without the storefront module edited its headline (error: %) -- the gate has been widened past a take-down', coalesce(v_err, '<none>');
  end if;

  -- ---- F8b: PUBLISHING still refused. The relaxation is one-directional.
  v_err := null;
  begin
    update public.storefronts set published_at = now() where shop_id = v_shop;
  exception when others then v_err := sqlerrm;
  end;
  if v_err is distinct from 'module_not_included' then
    raise exception 'FAIL F8b: a shop without the storefront module set published_at to a non-null value (error: %) -- the exemption must only take a page DOWN', coalesce(v_err, '<none>');
  end if;

  -- ---- F8c: a take-down with a content change smuggled alongside it.
  v_err := null;
  begin
    update public.storefronts set published_at = null, headline = 'Half price this week.' where shop_id = v_shop;
  exception when others then v_err := sqlerrm;
  end;
  if v_err is distinct from 'module_not_included' then
    raise exception 'FAIL F8c: a content edit rode through the gate alongside a take-down (error: %)', coalesce(v_err, '<none>');
  end if;
  select headline into v_headline from public.storefronts where shop_id = v_shop;
  if v_headline <> 'Open 8am-9pm.' then
    raise exception 'FAIL F8d: the refused write changed the headline anyway -- it reads %', v_headline;
  end if;

  -- ---- F8e: the DELETE-nothing case is not the point; the INSERT is. A shop
  -- without the module still cannot create a storefront row.
  delete from public.storefronts where shop_id = v_shop;
  v_err := null;
  begin
    insert into public.storefronts (shop_id, theme, palette, headline)
      values (v_shop, 'market', 'ink', 'A brand new page.');
  exception when others then v_err := sqlerrm;
  end;
  if v_err is distinct from 'module_not_included' then
    raise exception 'FAIL F8e: a shop without the storefront module created a storefront row (error: %) -- the exemption is UPDATE-only', coalesce(v_err, '<none>');
  end if;

  -- ---- F8f: and THE ONE WRITE THAT MUST PASS. Fresh fixture, because the
  -- row above was deleted.
  v_shop := pg_temp.lapse_shop('Lapse Gate Takedown Shop', p_plan => 'standard', p_expire => false);
  begin
    update public.storefronts
       set published_at = null, lapse_unpublished_at = now(),
           lapse_unpublished_reason = 'lapsed', updated_at = now()
     where shop_id = v_shop;
  exception when others then
    raise exception 'FAIL F8f: taking a page DOWN for a shop without the module raised % -- this is the write the trigger depends on, and refusing it protects nothing', sqlerrm;
  end;
  select published_at into v_published from public.storefronts where shop_id = v_shop;
  if v_published is not null then
    raise exception 'FAIL F8g: the take-down was accepted and the page is still live';
  end if;

  -- src/lib/storefront-admin.ts:594 writes published_at ALONE. The exemption
  -- has to cover that shape too, not only the trigger's three columns.
  v_other := pg_temp.lapse_shop('Lapse Gate Bare Takedown Shop', p_plan => 'standard', p_expire => false);
  begin
    update public.storefronts set published_at = null where shop_id = v_other;
  exception when others then
    raise exception 'FAIL F8h: the shop''s own unpublish (published_at alone) raised %', sqlerrm;
  end;

  -- ---- F8k: the exempted keys are not a free-standing door. The gate does
  -- not merely SKIP lapse_unpublished_at / lapse_unpublished_reason /
  -- updated_at in its comparison -- a caller riding a valid take-down chooses
  -- their values outright (see the header of section 3 in 20260930000500). What
  -- keeps that from being a forgery surface is that the take-down itself must
  -- be real: published_at has to move from non-null to NULL. v_other's page is
  -- already down from F8h, so stamping a cause on it now has no take-down to
  -- ride, and must be refused. Both columns are written together so the check
  -- constraint is satisfied and the ONLY thing that can refuse this is the gate.
  v_err := null;
  begin
    update public.storefronts
       set lapse_unpublished_at = now() - interval '400 days', lapse_unpublished_reason = 'suspended'
     where shop_id = v_other;
  exception when others then v_err := sqlerrm;
  end;
  if v_err is distinct from 'module_not_included' then
    raise exception 'FAIL F8k: a shop without the module stamped a take-down cause on a page that was ALREADY down (error: %) -- the exempted keys must only ride a real take-down', coalesce(v_err, '<none>');
  end if;

  -- ---- F8i: NOTHING ELSE MOVED. The sibling tables keep the unrelaxed gate.
  v_err := null;
  begin
    update public.storefront_delivery_areas set fee_cents = 9900 where shop_id = v_other;
  exception when others then v_err := sqlerrm;
  end;
  if v_err is distinct from 'module_not_included' then
    raise exception 'FAIL F8i: delivery areas stopped being gated (error: %) -- the relaxation was supposed to touch public.storefronts alone', coalesce(v_err, '<none>');
  end if;

  -- ---- F8j: and a shop that HAS the module still writes freely.
  v_other := pg_temp.lapse_shop('Lapse Gate Paying Shop', p_expire => false);
  begin
    update public.storefronts set headline = 'Now open Sundays.' where shop_id = v_other;
  exception when others then
    raise exception 'FAIL F8j: a shop WITH the storefront module can no longer edit its page (error: %) -- the new gate broke the ordinary path', sqlerrm;
  end;

  raise notice 'F8 ok: the gate lets a take-down through and still refuses content, publishing, inserts and the sibling tables';
end $$;

-- ---------------------------------------------------------------------------
-- F9. THE FIRST REPRODUCTION: suspend, take payment, unsuspend
-- ---------------------------------------------------------------------------
-- Three buttons in the platform portal, in an order an operator reaches for
-- every day: suspend a lapsed shop (index.ts:497), record its payment
-- (index.ts:471), unsuspend it (index.ts:497). Every step is a non-crossing if
-- "came back" is written as `expired -> not expired`:
--
--   1 lapsed      status=expired    published  -- the page is dark
--   2 suspended   status=suspended  published  -- expired -> suspended
--   3 paid        status=suspended  published  -- suspended -> suspended
--   4 unsuspended status=active     published  -- suspended -> active  <== here
--
-- ...and the page is live at the end of it with last month's prices on it. The
-- condition is written `dark -> not dark` (`in ('expired','suspended')` on both
-- sides) precisely so step 4 is the crossing it obviously is.
do $$
declare
  v_shop      uuid;
  v_slug      text;
  v_published timestamptz;
  v_reason    timestamptz;
  v_cause     text;
begin
  v_shop := pg_temp.lapse_shop('Lapse Suspended Shop');
  select slug into v_slug from public.shops where id = v_shop;

  -- ---- Step 2. Suspending a LAPSED shop must not tear its page down: the
  -- page is not coming back, it is going further away.
  update public.shop_subscriptions set manual_status = 'suspended' where shop_id = v_shop;
  if public.shop_effective_status(v_shop) <> 'suspended' then
    raise exception 'FAIL F9a: the suspended shop reads %', public.shop_effective_status(v_shop);
  end if;
  select published_at, lapse_unpublished_at into v_published, v_reason
    from public.storefronts where shop_id = v_shop;
  if v_published is null then
    raise exception 'FAIL F9b: SUSPENDING a lapsed shop took its page down -- the trigger is treating a shop going dark as a shop coming back';
  end if;
  if v_reason is not null then
    raise exception 'FAIL F9c: suspending a lapsed shop stamped a lapse reason on a page that is still up';
  end if;

  -- ---- Step 3. The payment lands while the shop is still suspended.
  update public.shop_subscriptions
     set current_period_end = now() + interval '30 days', grace_until = now() + interval '60 days'
   where shop_id = v_shop;
  if public.shop_effective_status(v_shop) <> 'suspended' then
    raise exception 'FAIL F9d: paying while suspended changed the status to % -- the fixture no longer reproduces the path', public.shop_effective_status(v_shop);
  end if;
  if (select published_at from public.storefronts where shop_id = v_shop) is null then
    raise exception 'FAIL F9e: a payment taken while the shop is suspended took the page down -- the page is still dark, nothing has come back yet';
  end if;

  -- ---- Step 4. The unsuspend. THIS is the shop coming back.
  update public.shop_subscriptions set manual_status = 'active' where shop_id = v_shop;
  if public.shop_effective_status(v_shop) <> 'active' then
    raise exception 'FAIL F9f: the unsuspended shop reads %, expected active', public.shop_effective_status(v_shop);
  end if;

  select published_at, lapse_unpublished_at, lapse_unpublished_reason
    into v_published, v_reason, v_cause
    from public.storefronts where shop_id = v_shop;
  if v_published is not null then
    raise exception 'FAIL F9g: suspend -> pay -> unsuspend left the page LIVE (published_at %) -- three portal buttons walked a month-old page back online with nobody deciding so', v_published;
  end if;
  if v_reason is null then
    raise exception 'FAIL F9h: the page came down with no reason recorded, so the editor cannot say why it is a draft';
  end if;
  -- The one path where BOTH causes are true at once: this shop lapsed AND was
  -- suspended. The tie-break is written down in 20260930000500 ("the OLD status
  -- is the state the page was dark in at the moment it came back") and pinned
  -- here, because it is a choice and not a consequence: at step 4 the shop had
  -- been suspended, its bill had already been settled at step 3, and the half
  -- it still needs is the half that names a person to talk to.
  if v_cause is distinct from 'suspended' then
    raise exception 'FAIL F9j: the crossing out of SUSPENSION was recorded as %, expected suspended -- the state the page was dark in at the moment it came back is what the editor has to explain', coalesce(v_cause, '<null>');
  end if;
  if exists (select 1 from public.get_public_storefront(v_slug)) then
    raise exception 'FAIL F9i: the address still serves after suspend -> pay -> unsuspend';
  end if;

  raise notice 'F9 ok: suspend, pay, unsuspend -- the page comes back as a draft, not as last month''s prices';
end $$;

-- ---------------------------------------------------------------------------
-- F10. The consequence of writing it as "dark", stated on purpose
-- ---------------------------------------------------------------------------
-- A shop that never lapsed, was suspended, and is unsuspended ALSO comes back
-- to a draft. That is the rule, not an accident: while suspended its page did
-- not serve, so it went dark, and coming back from dark is the thing this
-- decision makes deliberate. Pinned here so that nobody "fixes" it into
-- silence -- and so the cost is visible next to the benefit in F9.
--
-- WHY SUSPENSION IS DARK, EXACTLY. shop_has_module (20260818000200:63) returns
-- false for `suspended` in its FIRST arm, before it consults either the plan or
-- shop_entitlement_overrides -- so suspension is dark unconditionally, and no
-- comp can keep the page up through one. That is NOT true of `expired`, which
-- is dark only because the free plan lacks the module and which an override
-- therefore CAN keep serving (F12). The premise is measured either way: F10b
-- below stops the fixture serving before anything is concluded from it.
--
-- AND WHAT THE SHOP IS TOLD. This shop was current on its bill. "Your plan
-- lapsed" would be a flat lie to it, so F10d requires the SUSPENSION cause, not
-- merely that some cause was written -- which is what the editor branches on.
do $$
declare
  v_shop      uuid;
  v_slug      text;
  v_published timestamptz;
  v_reason    timestamptz;
  v_cause     text;
begin
  v_shop := pg_temp.lapse_shop('Lapse Suspended Paying Shop', p_expire => false);
  select slug into v_slug from public.shops where id = v_shop;

  -- It is live and serving before any of this.
  if not exists (select 1 from public.get_public_storefront(v_slug)) then
    raise exception 'FAIL F10a: the fixture is not serving before it is suspended, so nothing below is measuring a page going dark';
  end if;

  update public.shop_subscriptions set manual_status = 'suspended' where shop_id = v_shop;
  if exists (select 1 from public.get_public_storefront(v_slug)) then
    raise exception 'FAIL F10b: a suspended shop still serves its page -- then suspension is not darkness and this rule is written on a false premise';
  end if;

  update public.shop_subscriptions set manual_status = 'active' where shop_id = v_shop;

  select published_at, lapse_unpublished_at, lapse_unpublished_reason
    into v_published, v_reason, v_cause
    from public.storefronts where shop_id = v_shop;
  if v_published is not null then
    raise exception 'FAIL F10c: coming out of a suspension left the page live -- "dark -> not dark" is not being applied to suspension';
  end if;
  if v_reason is null then
    raise exception 'FAIL F10d: the page came down after a suspension with no reason recorded, so the shopkeeper is shown a draft and no explanation';
  end if;
  -- THE CHECK THAT WOULD NOT SURVIVE ONE SHARED SENTENCE. This fixture was
  -- built p_expire => false: it never lapsed, and it paid on time throughout.
  -- Recording 'lapsed' here would put "your plan had lapsed" in the editor of
  -- a shop with nothing wrong with its plan.
  if v_cause is distinct from 'suspended' then
    raise exception 'FAIL F10e: a shop that was SUSPENDED while current on its bill was recorded as %, expected suspended -- the editor would tell it its plan had lapsed, which is false', coalesce(v_cause, '<null>');
  end if;

  raise notice 'F10 ok: coming out of a suspension leaves the page a draft too, recorded as a suspension and not as a lapse';
end $$;

-- ---------------------------------------------------------------------------
-- F11. An UPDATE that changed nothing does not even enter the function
-- ---------------------------------------------------------------------------
-- shop_subscriptions is written on every portal action, and some of those
-- writes are no-ops (a PATCH with no diff, an upsert that rewrites a row
-- identically). Such a row cannot possibly satisfy the crossing condition --
-- OLD and NEW are the same row -- so the WHEN clause costs nothing and saves
-- two function calls per no-op. Asserted on the installed trigger rather than
-- inferred, because it is invisible in behaviour and would be dropped by the
-- next hand that rewrites the CREATE TRIGGER.
do $$
declare
  v_def       text;
  v_shop      uuid;
  v_published timestamptz;
begin
  select pg_get_triggerdef(t.oid) into v_def
    from pg_trigger t
   where t.tgrelid = 'public.shop_subscriptions'::regclass
     and t.tgname = 'shop_subscriptions_unpublish_storefront_on_return';

  if v_def is null then
    raise exception 'FAIL F11a: the unpublish trigger is not installed on shop_subscriptions at all';
  end if;
  if v_def !~* '\mwhen\M' then
    raise exception 'FAIL F11b: the unpublish trigger has no WHEN clause, so every no-op UPDATE on shop_subscriptions enters plpgsql -- def: %', v_def;
  end if;

  -- And the behaviour that clause must not change.
  v_shop := pg_temp.lapse_shop('Lapse No Op Shop', p_expire => false);
  update public.shop_subscriptions set manual_status = manual_status where shop_id = v_shop;
  select published_at into v_published from public.storefronts where shop_id = v_shop;
  if v_published is null then
    raise exception 'FAIL F11c: an UPDATE that changed nothing took the page down';
  end if;

  raise notice 'F11 ok: the trigger is skipped for an UPDATE that changed nothing, and such an update leaves the page alone';
end $$;

-- ---------------------------------------------------------------------------
-- F12. A page that never went dark is not torn down
-- ---------------------------------------------------------------------------
-- Every take-down in this file is justified by ONE premise: the page was dark,
-- so its prices sat unseen for a month and may be stale, so coming back has to
-- be deliberate. There is exactly one shop for which that premise is false.
--
-- shop_has_module (20260818000200:68-72) honours an unexpired
-- `module`/`storefront` row in shop_entitlement_overrides -- support comping a
-- shop the page while it sorts its bill out. An EXPIRED shop holding one keeps
-- the module, so get_public_storefront keeps serving, so its page never goes
-- dark at all. When it then pays, a trigger that fires anyway takes down a page
-- that was live the whole time and stamps a cause on it that did not happen.
--
-- The premise is MEASURED here (F12a) before anything is concluded from it,
-- because a fixture whose override silently failed to resolve would make every
-- assertion below pass for the wrong reason.
--
-- And the skip is narrow: it is keyed to `expired` alone. Suspension is dark
-- unconditionally -- shop_has_module short-circuits false on it before it looks
-- at overrides at all -- so a comped shop coming out of SUSPENSION must still
-- have its page taken down. F12e is that half, and it is what a skip written as
-- "any comped shop" would fail.
do $$
declare
  v_shop      uuid;
  v_slug      text;
  v_published timestamptz;
  v_cause     text;
begin
  -- ---- F12a: the premise. An expired shop with a comped module SERVES.
  v_shop := pg_temp.lapse_shop('Lapse Comped Shop');
  select slug into v_slug from public.shops where id = v_shop;

  insert into public.shop_entitlement_overrides (shop_id, kind, key, expires_at, reason)
    values (v_shop, 'module', 'storefront', now() + interval '60 days', 'comped while they sort the bill out');

  if not public.shop_has_module(v_shop, 'storefront') then
    raise exception 'FAIL F12a: the comped override did not resolve the storefront module for an expired shop -- the rest of this check would pass for the wrong reason';
  end if;
  if not exists (select 1 from public.get_public_storefront(v_slug)) then
    raise exception 'FAIL F12b: a comped expired shop does not serve its page, so there is no premise here to protect and this whole block is measuring nothing';
  end if;

  -- ---- The shop pays. This is the crossing the trigger fires on.
  update public.shop_subscriptions
     set current_period_end = now() + interval '30 days', grace_until = now() + interval '60 days'
   where shop_id = v_shop;
  if public.shop_effective_status(v_shop) <> 'active' then
    raise exception 'FAIL F12c: the comped shop reads % after paying, expected active', public.shop_effective_status(v_shop);
  end if;

  select published_at, lapse_unpublished_reason into v_published, v_cause
    from public.storefronts where shop_id = v_shop;
  if v_published is null then
    raise exception 'FAIL F12d: paying took down the page of a shop whose page NEVER WENT DARK -- its prices were on display the whole time, so there is nothing stale to make deliberate';
  end if;
  if v_cause is not null then
    raise exception 'FAIL F12e: a page that never came down was stamped with the cause "%" -- the editor would explain a take-down that did not happen', v_cause;
  end if;
  if not exists (select 1 from public.get_public_storefront(v_slug)) then
    raise exception 'FAIL F12f: the comped shop stopped serving the moment it PAID -- paying made things worse';
  end if;

  -- ---- F12g: and the half the skip must NOT cover. Same comp, but the shop
  -- goes dark through SUSPENSION, which no override survives.
  v_shop := pg_temp.lapse_shop('Lapse Comped Suspended Shop', p_expire => false);
  select slug into v_slug from public.shops where id = v_shop;
  insert into public.shop_entitlement_overrides (shop_id, kind, key, expires_at, reason)
    values (v_shop, 'module', 'storefront', now() + interval '60 days', 'comped, and then suspended anyway');

  update public.shop_subscriptions set manual_status = 'suspended' where shop_id = v_shop;
  if public.shop_has_module(v_shop, 'storefront') then
    raise exception 'FAIL F12g: a SUSPENDED shop still resolves the storefront module through its override -- then suspension is not unconditional darkness and the skip below is written on a false premise';
  end if;
  if exists (select 1 from public.get_public_storefront(v_slug)) then
    raise exception 'FAIL F12h: a suspended shop with a comped module still serves its page';
  end if;

  update public.shop_subscriptions set manual_status = 'active' where shop_id = v_shop;

  select published_at, lapse_unpublished_reason into v_published, v_cause
    from public.storefronts where shop_id = v_shop;
  if v_published is not null then
    raise exception 'FAIL F12i: coming out of a suspension left the page live because the shop holds an override -- the skip is keyed to `expired`, and suspension is dark whatever the overrides table says';
  end if;
  if v_cause is distinct from 'suspended' then
    raise exception 'FAIL F12j: the comped shop came out of suspension recorded as %, expected suspended', coalesce(v_cause, '<null>');
  end if;

  raise notice 'F12 ok: a comped page that never went dark survives the payment untouched, and the skip does not cover a suspension';
end $$;

do $$ begin raise notice 'ALL CHECKS PASSED'; end $$;

rollback;
