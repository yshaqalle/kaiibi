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
  -- enforce_shop_module() trigger refuses a storefronts insert from a shop
  -- that does not currently have the module, which is exactly the state the
  -- next two statements put them in. Publishing and then lapsing is also the
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

\ir ../migrations/20260930000400_storefront_grace_month.sql

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

do $$ begin raise notice 'ALL CHECKS PASSED'; end $$;

rollback;
