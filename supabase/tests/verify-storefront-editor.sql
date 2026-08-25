-- Claiming a slug without leaking who owns what -- the DB side of the
-- storefront editor's first step, checked against a real database.
--
-- Same shape as verify-storefront.sql: one DO block whose EXCEPTION clause
-- rolls the whole lot back, so it leaves no rows behind.
--
-- Both public.is_slug_available and public.claim_shop_slug are shop-side
-- functions granted to `authenticated` only (never `anon`), so almost
-- everything below runs with `role` switched to `authenticated` and
-- `request.jwt.claims` carrying a `sub`, the way verify-entitlements.sql and
-- verify-balances.sql establish identity for a security-definer RPC that
-- checks membership internally. The one exception is moving a shop's plan --
-- a shop cannot do that to itself (see verify-entitlements.sql #13), so that
-- write happens as postgres, same as the module-downgrade step in
-- verify-storefront.sql.

\set ON_ERROR_STOP on

do $$
declare
  v_owner_id      uuid := gen_random_uuid();
  v_outsider_id   uuid := gen_random_uuid();
  v_shop_id       uuid; -- v_owner_id's shop; does the claiming
  v_rival_id      uuid; -- v_owner_id's second shop; tries to claim a slug v_shop_id already holds
  v_outsider_shop uuid; -- v_outsider_id's shop; v_owner_id is not a member of it
  v_free_id       uuid;
  v_raised        boolean;
  v_errmsg        text;
  v_reserved_slug text;
  v_first_published timestamptz;
  v_result        text;
begin
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
    values (v_owner_id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            'verify-sfe-owner-' || v_owner_id || '@example.test', '', now(), now(), now());
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
    values (v_outsider_id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            'verify-sfe-outsider-' || v_outsider_id || '@example.test', '', now(), now(), now());

  insert into public.shops (owner_id, name) values (v_owner_id, 'Xamdi Editor Shop') returning id into v_shop_id;
  insert into public.shops (owner_id, name) values (v_owner_id, 'Xamdi Rival Branch') returning id into v_rival_id;
  insert into public.shops (owner_id, name) values (v_outsider_id, 'Outsider Shop') returning id into v_outsider_shop;

  -- Fresh shops start on trial, which already carries the storefront module
  -- (verify-storefront-module-grant.sql), so every claim below is expected
  -- to succeed on its own merits until the module check at the end.

  perform set_config('request.jwt.claims', json_build_object('sub', v_owner_id)::text, true);
  perform set_config('role', 'authenticated', true);

  -- ------------------------------------------------ 1. a fresh slug is available, then is not
  if not public.is_slug_available('xamdi-editor') then
    raise exception 'FAIL: a fresh slug reads as unavailable';
  end if;

  v_result := public.claim_shop_slug(v_shop_id, 'xamdi-editor');
  if v_result <> 'xamdi-editor' then
    raise exception 'FAIL: claim_shop_slug did not return the claimed slug (got %)', v_result;
  end if;
  if (select slug from public.shops where id = v_shop_id) <> 'xamdi-editor' then
    raise exception 'FAIL: the claimed slug did not persist on the shop';
  end if;

  if public.is_slug_available('xamdi-editor') then
    raise exception 'FAIL: a just-claimed slug still reads as available';
  end if;

  -- ------------------------------------------------ 2. a reserved name is never available
  if public.is_slug_available('api') then
    raise exception 'FAIL: the reserved slug "api" reads as available';
  end if;

  -- ------------------------------------------- 2b. reserved_slugs() is the one list both enforcement
  -- points actually use, not two copies that merely started out identical
  -- (T1). is_slug_available and the shops_slug_is_not_reserved CHECK are two
  -- different mechanisms -- a function called from SQL, and a constraint
  -- evaluated on write -- so proving they agree means driving BOTH of them
  -- from the same value (public.reserved_slugs()) and watching neither one
  -- diverge, not just spot-checking a name they were once hand-copied to
  -- share.
  --
  -- The CHECK itself is tested directly here (a raw UPDATE), not through
  -- claim_shop_slug -- that function calls is_slug_available first and would
  -- raise slug_taken before ever reaching the CHECK, which would prove
  -- nothing about the constraint at all. Runs as postgres so the only thing
  -- that can reject the write is the CHECK -- RLS is not the mechanism under
  -- test here.
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims', null, true);

  foreach v_reserved_slug in array public.reserved_slugs()
  loop
    if public.is_slug_available(v_reserved_slug) then
      raise exception 'FAIL: reserved slug "%" reads as available -- is_slug_available has drifted from reserved_slugs()', v_reserved_slug;
    end if;

    v_raised := false;
    begin
      update public.shops set slug = v_reserved_slug where id = v_shop_id;
    exception when others then
      v_raised := true;
    end;
    if not v_raised then
      raise exception 'FAIL: reserved slug "%" was accepted by shops_slug_is_not_reserved -- the CHECK has drifted from reserved_slugs()', v_reserved_slug;
    end if;
  end loop;

  -- v_shop_id's slug is untouched (every attempt above rolled back to its
  -- own savepoint on failure) -- restore the owner's session for the checks
  -- that follow, same as check 6 already does after its own postgres detour.
  perform set_config('request.jwt.claims', json_build_object('sub', v_owner_id)::text, true);
  perform set_config('role', 'authenticated', true);
  if (select slug from public.shops where id = v_shop_id) <> 'xamdi-editor' then
    raise exception 'FAIL: a rejected reserved-slug update left the shop''s real slug changed anyway';
  end if;

  -- ------------------------------------------------ 3. availability is case-insensitive
  if public.is_slug_available('XAMDI-EDITOR') then
    raise exception 'FAIL: availability check is not case-insensitive';
  end if;

  -- ------------------------------------------------ 4. only a member of the shop may claim its slug
  v_raised := false;
  begin
    perform public.claim_shop_slug(v_outsider_shop, 'stolen-by-non-member');
  exception when others then
    v_raised := true;
  end;
  if not v_raised then
    raise exception 'FAIL: a non-member claimed a slug for another shop';
  end if;

  -- ------------------------------------------------ 5. claiming a slug another shop already holds
  -- raises a distinguishable, typed error -- not a bare unique_violation.
  v_raised := false;
  v_errmsg := null;
  begin
    perform public.claim_shop_slug(v_rival_id, 'xamdi-editor');
  exception when others then
    v_raised := true;
    v_errmsg := sqlerrm;
  end;
  if not v_raised then
    raise exception 'FAIL: two shops both claimed "xamdi-editor"';
  end if;
  if v_errmsg is distinct from 'slug_taken' then
    raise exception 'FAIL: claiming a taken slug did not raise slug_taken (got %)', v_errmsg;
  end if;
  if (select slug from public.shops where id = v_rival_id) is not null then
    raise exception 'FAIL: the rival shop ended up with a slug after a failed claim';
  end if;

  -- ------------------------------------------------ 6. claim_shop_slug is gated on the storefront module too
  -- The table triggers (storefronts_module_gate) only cover the storefronts
  -- table; this function writes shops directly, which they never see.
  select id into v_free_id from public.plans where key = 'free';

  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims', null, true);
  update public.shop_subscriptions
  set plan_id = v_free_id, current_period_end = now() + interval '30 days'
  where shop_id = v_rival_id;

  if public.shop_has_module(v_rival_id, 'storefront') then
    raise exception 'FAIL: the rival shop still has the storefront module after moving to Free';
  end if;

  perform set_config('request.jwt.claims', json_build_object('sub', v_owner_id)::text, true);
  perform set_config('role', 'authenticated', true);

  v_raised := false;
  begin
    perform public.claim_shop_slug(v_rival_id, 'rival-without-module');
  exception when others then
    v_raised := true;
  end;
  if not v_raised then
    raise exception 'FAIL: a shop without the storefront module claimed a slug';
  end if;
  if (select slug from public.shops where id = v_rival_id) is not null then
    raise exception 'FAIL: a slug was claimed despite the missing storefront module';
  end if;

  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims', null, true);

  -- ------------------------------- N. the tables are actually reachable
  -- RLS narrows what a role may see; it does not grant the role reach. A table
  -- with policies but no grant fails with 42501 for every caller, and neither a
  -- security definer function nor a superuser-run test can see that happen.
  if not has_table_privilege('authenticated', 'public.storefronts', 'SELECT') then
    raise exception 'FAIL: authenticated cannot select storefronts -- RLS policies without a table grant are decorative';
  end if;
  if not has_table_privilege('authenticated', 'public.storefronts', 'INSERT') then
    raise exception 'FAIL: authenticated cannot insert storefronts';
  end if;
  if not has_table_privilege('authenticated', 'public.storefronts', 'UPDATE') then
    raise exception 'FAIL: authenticated cannot update storefronts';
  end if;
  if not has_table_privilege('authenticated', 'public.storefront_delivery_areas', 'SELECT') then
    raise exception 'FAIL: authenticated cannot select storefront_delivery_areas';
  end if;
  if not has_table_privilege('authenticated', 'public.storefront_delivery_areas', 'DELETE') then
    raise exception 'FAIL: authenticated cannot delete storefront_delivery_areas';
  end if;

  -- anon must NOT get direct table reach; it reads only through the
  -- explicit-column-list functions that keep products.cost_cents unreachable.
  if has_table_privilege('anon', 'public.storefronts', 'SELECT') then
    raise exception 'FAIL: anon can read the storefronts table directly, routing around the public read functions';
  end if;

  -- T5: the same grant regression this file already guards against for
  -- TABLES (above) is just as reachable through a FUNCTION -- Postgres
  -- grants EXECUTE to PUBLIC on every newly created function, which on a
  -- security-definer one means anon can call it regardless of any RLS
  -- policy, unless each migration remembers its own `revoke ... from
  -- public`. That revoke has had to be added by hand twice already
  -- (20260925000000, 20260925000200), which is exactly the bug class a
  -- test, not a migration-author's memory, should be catching. None of
  -- these four are meant to be reachable with no session at all -- unlike
  -- get_public_storefront and its siblings (20260924000100), which anon
  -- must reach, or the storefront's public page has nothing to call.
  if has_function_privilege('anon', 'public.is_slug_available(text)', 'EXECUTE') then
    raise exception 'FAIL: anon can execute is_slug_available -- it should require an authenticated session';
  end if;
  if has_function_privilege('anon', 'public.claim_shop_slug(uuid, text)', 'EXECUTE') then
    raise exception 'FAIL: anon can execute claim_shop_slug -- it should require an authenticated session';
  end if;
  if has_function_privilege('anon', 'public.save_storefront_draft(uuid, jsonb)', 'EXECUTE') then
    raise exception 'FAIL: anon can execute save_storefront_draft -- it should require an authenticated session';
  end if;
  if has_function_privilege('anon', 'public.publish_storefront(uuid)', 'EXECUTE') then
    raise exception 'FAIL: anon can execute publish_storefront -- an anonymous caller could publish any shop''s page';
  end if;

  -- ------------------------------------------------ 7. a draft the shop cannot lose, and cannot leak
  -- Nothing above ever created a storefronts row for v_shop_id -- claiming a
  -- slug only ever touches shops. This is the first check that needs one.
  insert into public.storefronts (shop_id) values (v_shop_id);

  -- Check 6 left role/jwt.claims reset to postgres/none; restore the owner's
  -- session so save_storefront_draft (invoker-rights, RLS-gated) and
  -- publish_storefront's own is_shop_member check both run as the party they
  -- are meant to authorize.
  perform set_config('request.jwt.claims', json_build_object('sub', v_owner_id)::text, true);
  perform set_config('role', 'authenticated', true);

  -- 7a. draft never reaches a customer, even while the row is published
  update public.storefronts
     set draft = '{"headline":"HALF WRITTEN, NOT FOR CUSTOMERS"}'::jsonb,
         published_at = now(),
         headline = 'The published headline'
   where shop_id = v_shop_id;

  if exists (
    select 1 from public.get_public_storefront('xamdi-editor') g
    where to_jsonb(g)::text like '%HALF WRITTEN%'
  ) then
    raise exception 'FAIL: an unpublished draft leaked into the public storefront payload';
  end if;

  if (select headline from public.get_public_storefront('xamdi-editor')) <> 'The published headline' then
    raise exception 'FAIL: the public page stopped showing the published headline once a draft existed';
  end if;

  -- 7b. saveDraft (save_storefront_draft) merges into the draft, never replaces it --
  -- editing the headline then the about text must not clobber the headline.
  update public.storefronts set draft = null where shop_id = v_shop_id;
  perform public.save_storefront_draft(v_shop_id, '{"headline":"Merged headline"}'::jsonb);
  perform public.save_storefront_draft(v_shop_id, '{"about":"Merged about"}'::jsonb);

  if (select draft->>'headline' from public.storefronts where shop_id = v_shop_id) <> 'Merged headline' then
    raise exception 'FAIL: a second draft save clobbered the first field instead of merging with it';
  end if;
  if (select draft->>'about' from public.storefronts where shop_id = v_shop_id) <> 'Merged about' then
    raise exception 'FAIL: the second draft save did not persist';
  end if;

  -- 7c. publishing copies the draft into the live columns (and onto shops.whatsapp_e164,
  -- which storefronts_module_gate never sees) and clears the draft, atomically
  update public.storefronts
     set draft = jsonb_build_object(
           'headline', 'Fresh headline from draft',
           'about', 'Fresh about from draft',
           'offersDelivery', true,
           'whatsappE164', '+252611222333'
         ),
         headline = 'Old headline',
         about = 'Old about',
         offers_delivery = false,
         published_at = null
   where shop_id = v_shop_id;

  perform public.publish_storefront(v_shop_id);

  if (select headline from public.storefronts where shop_id = v_shop_id) <> 'Fresh headline from draft' then
    raise exception 'FAIL: publish did not move the draft headline into the live column';
  end if;
  if (select about from public.storefronts where shop_id = v_shop_id) <> 'Fresh about from draft' then
    raise exception 'FAIL: publish did not move the draft about text into the live column';
  end if;
  if (select offers_delivery from public.storefronts where shop_id = v_shop_id) is not true then
    raise exception 'FAIL: publish did not move offers_delivery from the draft';
  end if;
  if (select whatsapp_e164 from public.shops where id = v_shop_id) <> '+252611222333' then
    raise exception 'FAIL: publish did not move the draft WhatsApp number onto the shop';
  end if;
  if (select draft from public.storefronts where shop_id = v_shop_id) is not null then
    raise exception 'FAIL: publish left the draft in place instead of clearing it';
  end if;
  if (select published_at from public.storefronts where shop_id = v_shop_id) is null then
    raise exception 'FAIL: publish did not set published_at';
  end if;

  -- 7c2. first_published_at (T3, 20260926000100) is set on this, the
  -- shop's first-ever publish, and stays set once "unpublished" --
  -- DesignStrip's "Chosen for you" badge (src/app/(admin)/storefront.tsx)
  -- depends on it being sticky where published_at itself is not.
  select first_published_at into v_first_published
    from public.storefronts where shop_id = v_shop_id;
  if v_first_published is null then
    raise exception 'FAIL: publish did not set first_published_at on the shop''s first publish';
  end if;

  -- Unpublishing is a plain update setting published_at back to null
  -- (storefront-admin.ts's unpublish, T2) -- first_published_at must not move.
  update public.storefronts set published_at = null where shop_id = v_shop_id;
  if (select first_published_at from public.storefronts where shop_id = v_shop_id) is distinct from v_first_published then
    raise exception 'FAIL: unpublishing changed first_published_at -- it must be sticky';
  end if;

  -- A second publish must not move it either -- it marks the FIRST publish,
  -- not the most recent one.
  perform pg_sleep(0.01); -- guarantees now() would differ if it wrongly moved
  perform public.publish_storefront(v_shop_id);
  if (select first_published_at from public.storefronts where shop_id = v_shop_id) is distinct from v_first_published then
    raise exception 'FAIL: a second publish moved first_published_at -- it should mark the first publish only';
  end if;

  -- 7d. a failed publish leaves neither half applied -- an unpublishable WhatsApp
  -- number in the draft must not leave a new headline live with the old number,
  -- or vice versa.
  update public.storefronts
     set draft = jsonb_build_object(
           'headline', 'New headline should not stick',
           'whatsappE164', 'not-a-number'
         ),
         headline = 'Headline before the failed publish'
   where shop_id = v_shop_id;
  update public.shops set whatsapp_e164 = '+252611222333' where id = v_shop_id;

  v_raised := false;
  begin
    perform public.publish_storefront(v_shop_id);
  exception when others then
    v_raised := true;
  end;
  if not v_raised then
    raise exception 'FAIL: publish succeeded despite an unpublishable WhatsApp number in the draft';
  end if;
  if (select headline from public.storefronts where shop_id = v_shop_id) <> 'Headline before the failed publish' then
    raise exception 'FAIL: a failed publish changed the live headline anyway';
  end if;
  if (select draft from public.storefronts where shop_id = v_shop_id) is null then
    raise exception 'FAIL: a failed publish cleared the draft anyway';
  end if;
  if (select whatsapp_e164 from public.shops where id = v_shop_id) <> '+252611222333' then
    raise exception 'FAIL: a failed publish changed the live WhatsApp number anyway';
  end if;

  -- 7e. publish_storefront is security definer and so bypasses storefronts_member_all
  -- entirely -- it must check membership itself, the same reasoning as
  -- claim_shop_slug above.
  v_raised := false;
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', v_outsider_id)::text, true);
    perform set_config('role', 'authenticated', true);
    perform public.publish_storefront(v_shop_id);
  exception when others then
    v_raised := true;
  end;
  perform set_config('request.jwt.claims', json_build_object('sub', v_owner_id)::text, true);
  perform set_config('role', 'authenticated', true);
  if not v_raised then
    raise exception 'FAIL: a non-member published another shop''s storefront';
  end if;

  raise notice 'PASS: storefront slug claim';
  raise exception 'rollback_marker';
exception
  when others then
    if sqlerrm = 'rollback_marker' then
      raise notice 'verify-storefront-editor: all checks passed, rolled back';
    else
      raise;
    end if;
end $$;
