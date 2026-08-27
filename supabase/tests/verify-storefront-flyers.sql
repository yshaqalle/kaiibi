-- Posters and offers on a shop's public page, checked against a real database.
--
-- Same shape as verify-storefront.sql: one DO block whose EXCEPTION clause
-- rolls the whole lot back, so it leaves no rows behind -- proven by the count
-- after the block rather than asserted in a comment.
--
-- Three of the checks below cannot be made as `postgres`, because postgres is
-- a superuser and bypasses RLS and table grants both:
--
--   * 12 (anon is refused at the table) and 13 (authenticated is NOT) switch
--     role with `set local role` and switch back immediately after, so the
--     setup writes around them keep running as postgres. 13 is the one that
--     matters most: 20260925000100_storefront_table_grants.sql exists only
--     because `storefronts` shipped with RLS policies and no table grant, so
--     every read from the app returned 42501 -- and nothing caught it, because
--     the public path goes through `security definer` functions that bypass
--     table privileges and every script in here runs as a superuser that no
--     grant can stop. has_table_privilege() alone is the paper record; the
--     live insert/update/delete underneath it is the proof.
--   * 14 (a non-member) needs an ordinary session for RLS to be consulted at
--     all.

\set ON_ERROR_STOP on

do $$
declare
  v_owner_id     uuid := gen_random_uuid();
  v_outsider_id  uuid := gen_random_uuid();
  v_shop_a       uuid; -- has a storefront; the main fixture
  v_shop_b       uuid; -- has a storefront; per-shop independence, then the storefronts cascade
  v_shop_c       uuid; -- NO storefront; a shop without a page cannot hold flyers
  v_shop_d       uuid; -- has a storefront; deleted whole, to prove the shop cascade
  v_shop_e       uuid; -- has a storefront, then moved to Free; the module gate
  v_promo_id     uuid;
  v_flyer_id     uuid;
  v_b_flyer_id   uuid;
  v_free_id      uuid;
  v_kind         text;
  v_raised       boolean;
  v_errmsg       text;
  v_detail       text;
  v_count        integer;
  -- The public read (checks 16 onwards).
  v_shop_f       uuid; -- has a storefront and a live flyer, NEVER published
  v_shop_g       uuid; -- published, and deliberately holds no flyers at all
  v_live_id      uuid; -- started in the past, no end: live today and every day after
  v_ended_id     uuid;
  v_paused_id    uuid;
  v_archived_id  uuid;
  v_future_id    uuid;
  v_doomed_id    uuid; -- live, then deleted, to separate "expired" from "deleted"
  v_foreign_id   uuid; -- a promotion belonging to a DIFFERENT shop
  v_plain_flyer  uuid;
  v_offer_flyer  uuid;
  v_doomed_flyer uuid;
  v_flyers       jsonb;
  v_auto_advance boolean; -- Task 4 (20260930000200): storefronts.auto_advance, read through the same public call.
  v_panel        jsonb;
  v_copy         jsonb;
  v_missing      text;
  v_present      text;
  v_case         record;
begin
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
    values (v_owner_id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            'verify-flyers-owner-' || v_owner_id || '@example.test', '', now(), now(), now());
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
    values (v_outsider_id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            'verify-flyers-outsider-' || v_outsider_id || '@example.test', '', now(), now(), now());

  insert into public.shops (owner_id, name) values (v_owner_id, 'Flyer Shop A') returning id into v_shop_a;
  insert into public.shops (owner_id, name) values (v_owner_id, 'Flyer Shop B') returning id into v_shop_b;
  insert into public.shops (owner_id, name) values (v_owner_id, 'Flyer Shop C') returning id into v_shop_c;
  insert into public.shops (owner_id, name) values (v_owner_id, 'Flyer Shop D') returning id into v_shop_d;
  insert into public.shops (owner_id, name) values (v_owner_id, 'Flyer Shop E') returning id into v_shop_e;

  -- A fresh shop starts on trial, which carries the storefront module
  -- (verify-storefront-module-grant.sql), so every write below is expected to
  -- succeed on its own merits until check 15 takes the module away.
  update public.shops set slug = 'flyer-shop-a' where id = v_shop_a;
  insert into public.storefronts (shop_id) values (v_shop_a);
  insert into public.storefronts (shop_id) values (v_shop_b);
  insert into public.storefronts (shop_id) values (v_shop_d);
  insert into public.storefronts (shop_id) values (v_shop_e);
  -- Deliberately no storefronts row for v_shop_c.

  insert into public.promotions (shop_id, name, discount_type, discount_value, scope)
    values (v_shop_a, 'Ciid 20% off', 'percentage', 20, 'store')
    returning id into v_promo_id;

  -- ------------------------------------------------ 1. a flyer belongs to a shop that has a page
  -- The foreign key is to storefronts(shop_id), not shops(id), precisely so
  -- this is unrepresentable rather than merely discouraged: a poster with no
  -- page to hang on is an orphan the public read would never find.
  v_raised := false;
  begin
    insert into public.storefront_flyers (shop_id, image_path, position)
      values (v_shop_c, 'flyers/orphan.jpg', 0);
  exception when foreign_key_violation then v_raised := true;
  end;
  if not v_raised then
    raise exception 'FAIL: a shop with no storefront was allowed to hold a flyer';
  end if;

  -- ------------------------------------------------ 2. the defaults the editor will rely on
  insert into public.storefront_flyers (shop_id, image_path, headline, subline, position)
    values (v_shop_a, 'flyers/ciid.jpg', 'Ciid wanaagsan', 'Everything 20% off this week', 0)
    returning id into v_flyer_id;

  if (select link_kind from public.storefront_flyers where id = v_flyer_id) is distinct from 'none' then
    raise exception 'FAIL: link_kind did not default to none (got %)',
      (select link_kind from public.storefront_flyers where id = v_flyer_id);
  end if;
  if (select draft from public.storefront_flyers where id = v_flyer_id) is not true then
    raise exception 'FAIL: a new flyer was born published; draft must default to true';
  end if;
  if (select created_at from public.storefront_flyers where id = v_flyer_id) is null then
    raise exception 'FAIL: created_at was not stamped';
  end if;
  if (select promotion_id from public.storefront_flyers where id = v_flyer_id) is not null then
    raise exception 'FAIL: a flyer with no offer behind it did not start with a null promotion_id';
  end if;
  if (select headline from public.storefront_flyers where id = v_flyer_id) is distinct from 'Ciid wanaagsan' then
    raise exception 'FAIL: the headline did not round-trip';
  end if;
  if (select subline from public.storefront_flyers where id = v_flyer_id) is distinct from 'Everything 20% off this week' then
    raise exception 'FAIL: the subline did not round-trip';
  end if;

  -- ------------------------------------------------ 3. a flyer is a picture, so it must have one
  v_raised := false;
  begin
    insert into public.storefront_flyers (shop_id, image_path, position)
      values (v_shop_a, null, 1);
  exception when not_null_violation then v_raised := true;
  end;
  if not v_raised then
    raise exception 'FAIL: a flyer with no image was accepted';
  end if;

  -- ------------------------------------------------ 4. position is required and round-trips
  v_raised := false;
  begin
    insert into public.storefront_flyers (shop_id, image_path, position)
      values (v_shop_a, 'flyers/nowhere.jpg', null);
  exception when not_null_violation then v_raised := true;
  end;
  if not v_raised then
    raise exception 'FAIL: a flyer with no position was accepted -- the page could not order itself';
  end if;

  update public.storefront_flyers set position = 3 where id = v_flyer_id;
  if (select f.position from public.storefront_flyers f where f.id = v_flyer_id) is distinct from 3 then
    raise exception 'FAIL: position did not round-trip';
  end if;
  update public.storefront_flyers set position = 0 where id = v_flyer_id;

  -- ------------------------------------------------ 5. link_kind is a closed set
  -- CHECK-constrained rather than free text for the reason storefronts.theme
  -- gives (20260924000000): the client falls back on an unknown value, and
  -- this stops one existing to fall back from.
  v_raised := false;
  begin
    update public.storefront_flyers set link_kind = 'instagram' where id = v_flyer_id;
  exception when check_violation then v_raised := true;
  end;
  if not v_raised then
    raise exception 'FAIL: an unknown link_kind was accepted';
  end if;

  -- ...and the three that ARE permitted really are. Without this the check
  -- above passes just as well against a constraint that refuses everything.
  foreach v_kind in array array['none', 'category', 'whatsapp']
  loop
    begin
      update public.storefront_flyers set link_kind = v_kind where id = v_flyer_id;
    exception when others then
      raise exception 'FAIL: the permitted link_kind "%" was refused (%)', v_kind, sqlerrm;
    end;
    if (select link_kind from public.storefront_flyers where id = v_flyer_id) is distinct from v_kind then
      raise exception 'FAIL: the permitted link_kind "%" was refused or did not persist', v_kind;
    end if;
  end loop;
  update public.storefront_flyers set link_kind = 'none', link_value = null where id = v_flyer_id;

  -- ------------------------------------------------ 6. deleting an offer does not delete the flyer
  -- `on delete set null`, never cascade -- the same rule campaigns states for
  -- the same reason (20260828000000_campaigns.sql:11-14). A flyer's words are
  -- meant to be derived from the promotion row rather than copied (src/lib/
  -- poster.ts says why), so the link matters; but deleting an offer must not
  -- silently delete the poster that mentioned it, leaving the owner with a
  -- page that quietly lost a panel.
  update public.storefront_flyers set promotion_id = v_promo_id where id = v_flyer_id;
  if (select promotion_id from public.storefront_flyers where id = v_flyer_id) is distinct from v_promo_id then
    raise exception 'FAIL: promotion_id did not persist';
  end if;

  delete from public.promotions where id = v_promo_id;

  if not exists (select 1 from public.storefront_flyers where id = v_flyer_id) then
    raise exception 'FAIL: deleting a promotion cascaded away the flyer that mentioned it';
  end if;
  if (select promotion_id from public.storefront_flyers where id = v_flyer_id) is not null then
    raise exception 'FAIL: promotion_id was not set null when the promotion went';
  end if;

  -- ------------------------------------------------ 7. at most five per shop, refused by the database
  -- The UI will stop at five too. This is the check that the DATABASE does,
  -- because the UI is not the only writer -- an RPC, a script or a future
  -- import all reach this table without passing a screen.
  delete from public.storefront_flyers where shop_id = v_shop_a;

  for v_count in 1..5 loop
    insert into public.storefront_flyers (shop_id, image_path, position)
      values (v_shop_a, 'flyers/' || v_count || '.jpg', v_count);
  end loop;

  if (select count(*) from public.storefront_flyers where shop_id = v_shop_a) <> 5 then
    raise exception 'FAIL: five flyers did not all land (got %)',
      (select count(*) from public.storefront_flyers where shop_id = v_shop_a);
  end if;

  v_raised := false;
  v_errmsg := null;
  v_detail := null;
  begin
    insert into public.storefront_flyers (shop_id, image_path, position)
      values (v_shop_a, 'flyers/sixth.jpg', 6);
  exception when others then
    v_raised := true;
    v_errmsg := sqlerrm;
    get stacked diagnostics v_detail = pg_exception_detail;
  end;
  if not v_raised then
    raise exception 'FAIL: a sixth flyer was accepted';
  end if;
  -- A bare 403 or a raw constraint name is not something a client can turn
  -- into a sentence. This raises the same typed shape as enforce_shop_limit()
  -- (20260818000300), so the editor has one error vocabulary.
  if v_errmsg is distinct from 'flyer_limit_reached' then
    raise exception 'FAIL: the sixth flyer was refused with an untypeable message (got %)', v_errmsg;
  end if;
  if v_detail is null or (v_detail::jsonb->>'limit') is distinct from '5'
     or (v_detail::jsonb->>'usage') is distinct from '5' then
    raise exception 'FAIL: the refusal did not carry the limit and usage a client needs (detail = %)',
      coalesce(v_detail, '<null>');
  end if;
  if (select count(*) from public.storefront_flyers where shop_id = v_shop_a) <> 5 then
    raise exception 'FAIL: the refused insert changed the flyer count anyway';
  end if;

  -- The limit is a live count, not a high-water mark: removing one frees a
  -- genuinely reusable slot, or "remove one, or upgrade" is a dead end.
  delete from public.storefront_flyers
    where id = (select id from public.storefront_flyers where shop_id = v_shop_a order by position desc limit 1);
  insert into public.storefront_flyers (shop_id, image_path, position)
    values (v_shop_a, 'flyers/replacement.jpg', 5);
  if (select count(*) from public.storefront_flyers where shop_id = v_shop_a) <> 5 then
    raise exception 'FAIL: a slot freed by a delete was not reusable';
  end if;

  -- ------------------------------------------------ 8. the limit is per shop, not per platform
  -- Wrapped so a limit that counts across shops reports as this check rather
  -- than as a bare ERROR from a line of setup.
  begin
    for v_count in 1..5 loop
      insert into public.storefront_flyers (shop_id, image_path, position)
        values (v_shop_b, 'flyers/b-' || v_count || '.jpg', v_count);
    end loop;
  exception when others then
    raise exception 'FAIL: a second shop could not have its own five flyers while shop A was full (%)', sqlerrm;
  end;
  if (select count(*) from public.storefront_flyers where shop_id = v_shop_b) <> 5 then
    raise exception 'FAIL: a second shop could not have its own five flyers';
  end if;
  if (select count(*) from public.storefront_flyers where shop_id = v_shop_a) <> 5 then
    raise exception 'FAIL: filling shop B changed shop A''s flyers';
  end if;

  -- ------------------------------------------------ 9. an UPDATE cannot smuggle in a sixth
  -- A limit enforced only BEFORE INSERT is bypassed by moving an existing row
  -- into a shop that is already full -- five checks pass and the shop has six.
  select id into v_b_flyer_id from public.storefront_flyers where shop_id = v_shop_b order by position limit 1;

  v_raised := false;
  v_errmsg := null;
  begin
    update public.storefront_flyers set shop_id = v_shop_a where id = v_b_flyer_id;
  exception when others then
    v_raised := true;
    v_errmsg := sqlerrm;
  end;
  if not v_raised then
    raise exception 'FAIL: a flyer was moved into a shop that already had five';
  end if;
  if v_errmsg is distinct from 'flyer_limit_reached' then
    raise exception 'FAIL: the move was refused for the wrong reason (got %)', v_errmsg;
  end if;
  if (select count(*) from public.storefront_flyers where shop_id = v_shop_a) <> 5 then
    raise exception 'FAIL: shop A ended up with % flyers',
      (select count(*) from public.storefront_flyers where shop_id = v_shop_a);
  end if;

  -- ...and an ordinary update to a shop that is already at five still works.
  -- Without this, a trigger that refused EVERY update would pass the check
  -- above and break reordering entirely.
  begin
    update public.storefront_flyers set headline = 'Reordered' where id = v_b_flyer_id;
  exception when others then
    raise exception 'FAIL: an ordinary update to a full shop''s flyer was refused (%)', sqlerrm;
  end;
  if (select headline from public.storefront_flyers where id = v_b_flyer_id) is distinct from 'Reordered' then
    raise exception 'FAIL: an ordinary update to a full shop''s flyer was refused';
  end if;

  -- ------------------------------------------------ 10. the page goes, the flyers go
  begin
    delete from public.storefronts where shop_id = v_shop_b;
  exception when others then
    raise exception 'FAIL: deleting a storefront was blocked by its flyers instead of taking them with it (%)', sqlerrm;
  end;
  if exists (select 1 from public.storefront_flyers where shop_id = v_shop_b) then
    raise exception 'FAIL: deleting a storefront left % flyers behind',
      (select count(*) from public.storefront_flyers where shop_id = v_shop_b);
  end if;
  if (select count(*) from public.storefront_flyers where shop_id = v_shop_a) <> 5 then
    raise exception 'FAIL: deleting shop B''s storefront took shop A''s flyers with it';
  end if;

  -- ------------------------------------------------ 11. deleting the shop reaches them too
  -- Through storefronts' own cascade to shops -- the real-world path, and the
  -- one 20260908001200_delete_shop_fk_ordering.sql exists to keep working.
  insert into public.storefront_flyers (shop_id, image_path, position)
    values (v_shop_d, 'flyers/doomed.jpg', 0);
  begin
    delete from public.shops where id = v_shop_d;
  exception when others then
    raise exception 'FAIL: deleting a shop was blocked on the way to its flyers (%)', sqlerrm;
  end;
  if exists (select 1 from public.storefront_flyers where shop_id = v_shop_d) then
    raise exception 'FAIL: deleting a shop left its flyers behind';
  end if;

  -- ------------------------------------------------ 12. anon gets no table grant at all
  -- Every public storefront read goes through a `security definer` function
  -- with an explicit column list (20260924000100). A direct grant here would
  -- route around that the moment a later column is added that the public page
  -- is not meant to show -- a draft flyer, for one.
  if has_table_privilege('anon', 'public.storefront_flyers', 'SELECT')
     or has_table_privilege('anon', 'public.storefront_flyers', 'INSERT')
     or has_table_privilege('anon', 'public.storefront_flyers', 'UPDATE')
     or has_table_privilege('anon', 'public.storefront_flyers', 'DELETE') then
    raise exception 'FAIL: anon holds a table privilege on storefront_flyers';
  end if;

  -- Belt and braces: prove Postgres itself refuses, not merely that no grant
  -- is recorded.
  set local role anon;
  if current_user is distinct from 'anon' then
    raise exception 'FAIL: set local role anon did not take effect (current_user = %)', current_user;
  end if;
  v_raised := false;
  begin
    perform 1 from public.storefront_flyers limit 1;
  exception when insufficient_privilege then v_raised := true;
  end;
  reset role;
  if not v_raised then
    raise exception 'FAIL: anon could read the storefront_flyers table directly';
  end if;

  -- ------------------------------------------------ 13. authenticated DOES get one
  -- RLS narrows what a role may see; it does not grant the role reach.
  -- `storefronts` shipped with policies and no grant and every app read
  -- returned 42501 for a whole plan (20260925000100). This is that regression,
  -- asserted on paper and then for real.
  if not has_table_privilege('authenticated', 'public.storefront_flyers', 'SELECT') then
    raise exception 'FAIL: authenticated cannot select storefront_flyers -- RLS policies without a table grant are decorative';
  end if;
  if not has_table_privilege('authenticated', 'public.storefront_flyers', 'INSERT') then
    raise exception 'FAIL: authenticated cannot insert storefront_flyers';
  end if;
  if not has_table_privilege('authenticated', 'public.storefront_flyers', 'UPDATE') then
    raise exception 'FAIL: authenticated cannot update storefront_flyers';
  end if;
  if not has_table_privilege('authenticated', 'public.storefront_flyers', 'DELETE') then
    raise exception 'FAIL: authenticated cannot delete storefront_flyers';
  end if;

  -- The live version. A shop member ringing through the editor's data layer:
  -- read their own five, add a sixth-slot-freeing delete, insert, update,
  -- delete. Every statement here is one the editor will make.
  delete from public.storefront_flyers where shop_id = v_shop_a;
  perform set_config('request.jwt.claims', json_build_object('sub', v_owner_id)::text, true);
  set local role authenticated;

  begin
    insert into public.storefront_flyers (shop_id, image_path, headline, position)
      values (v_shop_a, 'flyers/by-the-owner.jpg', 'Written by a real session', 0)
      returning id into v_flyer_id;
  exception when others then
    raise exception 'FAIL: an authenticated member could not insert a flyer into their own shop (%)', sqlerrm;
  end;

  if (select count(*) from public.storefront_flyers where shop_id = v_shop_a) <> 1 then
    raise exception 'FAIL: an authenticated member could not read back the flyer they just wrote';
  end if;

  update public.storefront_flyers set headline = 'Edited by a real session' where id = v_flyer_id;
  if (select headline from public.storefront_flyers where id = v_flyer_id) is distinct from 'Edited by a real session' then
    raise exception 'FAIL: an authenticated member could not update their own flyer';
  end if;

  delete from public.storefront_flyers where id = v_flyer_id;
  if exists (select 1 from public.storefront_flyers where id = v_flyer_id) then
    raise exception 'FAIL: an authenticated member could not delete their own flyer';
  end if;

  reset role;
  perform set_config('request.jwt.claims', null, true);

  -- ------------------------------------------------ 14. a stranger reads nothing and writes nothing
  insert into public.storefront_flyers (shop_id, image_path, position)
    values (v_shop_a, 'flyers/private.jpg', 0);

  perform set_config('request.jwt.claims', json_build_object('sub', v_outsider_id)::text, true);
  set local role authenticated;

  if exists (select 1 from public.storefront_flyers where shop_id = v_shop_a) then
    raise exception 'FAIL: a non-member read another shop''s flyers';
  end if;

  v_raised := false;
  begin
    insert into public.storefront_flyers (shop_id, image_path, position)
      values (v_shop_a, 'flyers/hostile.jpg', 1);
  exception when insufficient_privilege then v_raised := true;
  end;

  reset role;
  perform set_config('request.jwt.claims', null, true);
  if not v_raised then
    raise exception 'FAIL: a non-member wrote a flyer onto another shop''s page';
  end if;
  if (select count(*) from public.storefront_flyers where shop_id = v_shop_a) <> 1 then
    raise exception 'FAIL: a non-member''s insert landed after all';
  end if;

  -- ------------------------------------------------ 15. the storefront module gates writes here too
  -- Every billable table carries the gate (20260818000400), and both existing
  -- storefront tables do. Without it, a shop that stopped paying keeps editing
  -- the page it is no longer entitled to.
  select id into v_free_id from public.plans where key = 'free';
  update public.shop_subscriptions
  set plan_id = v_free_id, current_period_end = now() + interval '30 days'
  where shop_id = v_shop_e;

  if public.shop_has_module(v_shop_e, 'storefront') then
    raise exception 'FAIL: a shop on Free still has the storefront module';
  end if;

  v_raised := false;
  v_errmsg := null;
  begin
    insert into public.storefront_flyers (shop_id, image_path, position)
      values (v_shop_e, 'flyers/unpaid.jpg', 0);
  exception when others then
    v_raised := true;
    v_errmsg := sqlerrm;
  end;
  if not v_raised then
    raise exception 'FAIL: a shop without the storefront module wrote a flyer';
  end if;
  if v_errmsg is distinct from 'module_not_included' then
    raise exception 'FAIL: the de-entitled write was refused for the wrong reason (got %)', v_errmsg;
  end if;

  -- ================================================================
  -- The public read (20260930000100). Everything above is the owner's
  -- side of the table; everything below is what a stranger with no
  -- session sees at the shop's address.
  -- ================================================================

  -- Shop A becomes the published fixture. Its flyers so far were written to
  -- prove RLS and the limit; the page is a different question, so it starts
  -- from an empty wall.
  delete from public.storefront_flyers where shop_id = v_shop_a;
  update public.storefronts set published_at = now() where shop_id = v_shop_a;

  -- Published, and holds nothing. The "no flyers" arm of check 22.
  insert into public.shops (owner_id, name) values (v_owner_id, 'Flyer Shop G') returning id into v_shop_g;
  update public.shops set slug = 'flyer-shop-g' where id = v_shop_g;
  insert into public.storefronts (shop_id, published_at) values (v_shop_g, now());

  -- Has a page and a live, non-draft flyer, and is NEVER published. The whole
  -- shop must stay invisible, flyers included.
  insert into public.shops (owner_id, name) values (v_owner_id, 'Flyer Shop F') returning id into v_shop_f;
  update public.shops set slug = 'flyer-shop-f' where id = v_shop_f;
  insert into public.storefronts (shop_id) values (v_shop_f);
  insert into public.storefront_flyers (shop_id, image_path, position, draft)
    values (v_shop_f, 'flyers/unpublished-shop.jpg', 0, false);

  -- The offers. `starts_at` on the live one is a FIXED instant in the past
  -- with no end, so its window line ("From Friday 14 August") is a constant
  -- this check can assert against forever -- a window built from now() would
  -- have to be re-derived by the test, which is how a check comes to assert
  -- the implementation against itself.
  insert into public.promotions (shop_id, name, discount_type, discount_value, scope, starts_at)
    values (v_shop_a, 'Running since Friday', 'percentage', 20, 'store', timestamptz '2026-08-14 00:00:00+03')
    returning id into v_live_id;
  insert into public.promotions (shop_id, name, discount_type, discount_value, scope, starts_at, ends_at)
    values (v_shop_a, 'Last week', 'percentage', 30, 'store', now() - interval '14 days', now() - interval '1 day')
    returning id into v_ended_id;
  insert into public.promotions (shop_id, name, discount_type, discount_value, scope, active)
    values (v_shop_a, 'Paused', 'percentage', 15, 'store', false)
    returning id into v_paused_id;
  insert into public.promotions (shop_id, name, discount_type, discount_value, scope, archived_at)
    values (v_shop_a, 'Archived', 'percentage', 15, 'store', now())
    returning id into v_archived_id;
  insert into public.promotions (shop_id, name, discount_type, discount_value, scope, starts_at)
    values (v_shop_a, 'Next week', 'percentage', 25, 'store', now() + interval '7 days')
    returning id into v_future_id;
  insert into public.promotions (shop_id, name, discount_type, discount_value, scope, scope_value)
    values (v_shop_a, 'Shoes', 'fixed', 250, 'category', 'Shoes')
    returning id into v_doomed_id;
  -- Live, and someone else's. A flyer is not entitled to advertise it.
  insert into public.promotions (shop_id, name, discount_type, discount_value, scope)
    values (v_shop_g, 'Another shop''s offer', 'percentage', 50, 'store')
    returning id into v_foreign_id;

  -- Inserted deliberately OUT OF POSITION ORDER. A read that came back in
  -- insertion order would otherwise pass check 16's ordering assertion by
  -- accident. created_at cannot break the tie either -- now() is frozen for
  -- the whole transaction, so all four share one timestamp.
  insert into public.storefront_flyers (shop_id, image_path, position, draft, promotion_id)
    values (v_shop_a, 'flyers/pub-doomed.jpg', 3, false, v_doomed_id) returning id into v_doomed_flyer;
  insert into public.storefront_flyers (shop_id, image_path, headline, subline, link_kind, link_value, position, draft)
    values (v_shop_a, 'flyers/pub-plain.jpg', 'Cusub', 'New stock in', 'category', 'Shoes', 0, false)
    returning id into v_plain_flyer;
  insert into public.storefront_flyers (shop_id, image_path, position, draft, promotion_id)
    values (v_shop_a, 'flyers/pub-offer.jpg', 2, false, v_live_id) returning id into v_offer_flyer;
  insert into public.storefront_flyers (shop_id, image_path, position, draft)
    values (v_shop_a, 'flyers/pub-draft.jpg', 1, true);

  -- ------------------------------------------------ 16. the page carries its live flyers, in position order
  -- On the EXISTING call, not a new one. A second RPC would let an
  -- unpublished shop, an unknown slug and a failed read be told apart by
  -- which call errors -- see check 23.
  select g.flyers into v_flyers from public.get_public_storefront('flyer-shop-a') g;

  if v_flyers is null then
    raise exception 'FAIL: get_public_storefront returned no flyers at all for a published shop that has three';
  end if;
  if jsonb_typeof(v_flyers) is distinct from 'array' then
    raise exception 'FAIL: flyers came back as % rather than an array', coalesce(jsonb_typeof(v_flyers), '<null>');
  end if;
  if jsonb_array_length(v_flyers) <> 3 then
    raise exception 'FAIL: expected 3 live flyers on the page, got % (%)',
      jsonb_array_length(v_flyers), v_flyers::text;
  end if;

  -- Position order, not insertion order.
  if (v_flyers->0->>'image_path') is distinct from 'flyers/pub-plain.jpg'
     or (v_flyers->1->>'image_path') is distinct from 'flyers/pub-offer.jpg'
     or (v_flyers->2->>'image_path') is distinct from 'flyers/pub-doomed.jpg' then
    raise exception 'FAIL: the flyers did not come back in position order (%)', v_flyers::text;
  end if;

  -- The panel's own fields, which the renderer needs and which nothing else
  -- above proves travel.
  v_panel := v_flyers->0;
  if (v_panel->>'id') is distinct from v_plain_flyer::text then
    raise exception 'FAIL: a flyer came back without its id -- a list has no stable key';
  end if;
  if (v_panel->>'headline') is distinct from 'Cusub' then
    raise exception 'FAIL: the headline did not travel to the page (got %)', coalesce(v_panel->>'headline', '<null>');
  end if;
  if (v_panel->>'subline') is distinct from 'New stock in' then
    raise exception 'FAIL: the subline did not travel to the page (got %)', coalesce(v_panel->>'subline', '<null>');
  end if;
  if (v_panel->>'link_kind') is distinct from 'category' or (v_panel->>'link_value') is distinct from 'Shoes' then
    raise exception 'FAIL: the link did not travel to the page (% / %)',
      coalesce(v_panel->>'link_kind', '<null>'), coalesce(v_panel->>'link_value', '<null>');
  end if;
  if (v_panel->>'position') is distinct from '0' then
    raise exception 'FAIL: position did not travel to the page (got %)', coalesce(v_panel->>'position', '<null>');
  end if;

  -- ------------------------------------------------ 17. a draft flyer is not on the page
  -- Named rather than counted. The count above would also be satisfied by the
  -- draft appearing and something else silently dropping out.
  if exists (select 1 from jsonb_array_elements(v_flyers) e where e->>'image_path' = 'flyers/pub-draft.jpg') then
    raise exception 'FAIL: a draft flyer was published to the street';
  end if;

  -- ------------------------------------------------ 18. the offer is DERIVED, in the printed poster's words
  -- src/lib/poster.ts: "a poster cannot contradict the till". Neither can the
  -- page. `value`, `scope` and `when` are computed from the promotion row on
  -- every read; nothing here is stored on the flyer.
  v_panel := v_flyers->1->'offer';
  if v_panel is null or jsonb_typeof(v_panel) is distinct from 'object' then
    raise exception 'FAIL: a flyer with a live promotion carried no offer (%)', (v_flyers->1)::text;
  end if;
  if (v_panel->>'value') is distinct from '20%' then
    raise exception 'FAIL: the offer value read % rather than 20%%', coalesce(v_panel->>'value', '<null>');
  end if;
  if (v_panel->>'scope') is distinct from 'Everything in store' then
    raise exception 'FAIL: the offer scope read % rather than "Everything in store"', coalesce(v_panel->>'scope', '<null>');
  end if;
  if (v_panel->>'when') is distinct from 'From Friday 14 August' then
    raise exception 'FAIL: the offer window read % rather than "From Friday 14 August"', coalesce(v_panel->>'when', '<null>');
  end if;

  -- The fixed-money, category-scoped one, so neither branch of value/scope is
  -- taken on trust from the percentage case alone.
  v_panel := v_flyers->2->'offer';
  if (v_panel->>'value') is distinct from '$2.50' then
    raise exception 'FAIL: a fixed discount read % rather than $2.50', coalesce(v_panel->>'value', '<null>');
  end if;
  if (v_panel->>'scope') is distinct from 'All Shoes' then
    raise exception 'FAIL: a category offer read % rather than "All Shoes"', coalesce(v_panel->>'scope', '<null>');
  end if;

  -- A flyer with no promotion behind it claims nothing -- and says so as JSON
  -- null rather than by omitting the key, so a renderer has one thing to test.
  if jsonb_typeof(v_flyers->0->'offer') is distinct from 'null' then
    raise exception 'FAIL: a flyer with no promotion carried an offer anyway (%)', (v_flyers->0)::text;
  end if;

  -- ------------------------------------------------ 19. the page's words and the paper's words are the same words
  -- Every case in src/lib/__tests__/poster.test.ts, against the SQL that
  -- derives the same three fields. If these two ever disagree, one offer reads
  -- two ways -- 20% on the door and 30% on the phone.
  for v_case in
    select * from (values
      ('percentage', 20, 'store',    null,      null::timestamptz, null::timestamptz,
       'value', '20%'),
      ('fixed',      250, 'store',    null,      null, null,
       'value', '$2.50'),
      ('percentage', 20, 'store',    null,      null, null,
       'scope', 'Everything in store'),
      ('percentage', 20, 'category', 'Shoes',   null, null,
       'scope', 'All Shoes'),
      ('percentage', 20, 'brand',    'Somtel',  null, null,
       'scope', 'Anything by Somtel'),
      ('percentage', 20, 'store',    null,      null, timestamptz '2026-08-17 00:00:00+03',
       'when', 'Until Sunday 16 August'),
      ('percentage', 20, 'store',    null,      timestamptz '2026-08-14 00:00:00+03', null,
       'when', 'From Friday 14 August'),
      ('percentage', 20, 'store',    null,      timestamptz '2026-08-14 00:00:00+03', timestamptz '2026-08-17 00:00:00+03',
       'when', 'Friday 14 — Sunday 16 August'),
      -- Not in poster.test.ts, but it is the other branch of `sameMonth`:
      -- the left half keeps its month when the window crosses one.
      ('percentage', 20, 'store',    null,      timestamptz '2026-07-30 00:00:00+03', timestamptz '2026-08-02 00:00:00+03',
       'when', 'Thursday 30 July — Saturday 1 August')
    ) as t(dtype, dvalue, scope, scope_value, starts_at, ends_at, field, expected)
  loop
    v_copy := public.promotion_offer_copy(v_case.dtype, v_case.dvalue, v_case.scope, v_case.scope_value,
                                          v_case.starts_at, v_case.ends_at);
    if (v_copy->>v_case.field) is distinct from v_case.expected then
      raise exception 'FAIL: the page and the poster disagree -- % read % rather than % (%)',
        v_case.field, coalesce(v_copy->>v_case.field, '<null>'), v_case.expected, v_copy::text;
    end if;
  end loop;

  -- An offer with no window prints no date line at all -- as JSON null, not
  -- the string "null" and not a missing key.
  v_copy := public.promotion_offer_copy('percentage', 20, 'store', null, null, null);
  if jsonb_typeof(v_copy->'when') is distinct from 'null' then
    raise exception 'FAIL: an offer with no window still printed a date line (%)', v_copy::text;
  end if;

  -- ------------------------------------------------ 20. AN OFFER THAT IS OVER STOPS BEING CLAIMED
  -- The property the whole feature exists for. A shop can take a poster off
  -- the door; a page advertising a discount the till refuses does it around
  -- the clock, to strangers, at the address printed on the shop's card.
  --
  -- The rule matched here is src/lib/discounts.ts's isPromotionLive -- active,
  -- unarchived, started, not ended -- which is the one place the till decides
  -- the same question. The migration header says why the page takes NO part of
  -- complete_sale's boundary slack.
  for v_case in
    select * from (values
      (v_ended_id,    'had ended'),
      (v_paused_id,   'had been paused'),
      (v_archived_id, 'had been archived'),
      (v_future_id,   'had not started yet'),
      (v_foreign_id,  'belonged to another shop')
    ) as t(promo_id, why)
  loop
    update public.storefront_flyers set promotion_id = v_case.promo_id where id = v_offer_flyer;
    select g.flyers into v_flyers from public.get_public_storefront('flyer-shop-a') g;

    if exists (select 1 from jsonb_array_elements(v_flyers) e where e->>'image_path' = 'flyers/pub-offer.jpg') then
      raise exception 'FAIL: a flyer whose promotion % was still on the page (%)', v_case.why, v_flyers::text;
    end if;
    -- ...and it took nothing else with it. Without this, a read that returned
    -- an empty array for any reason at all would pass the line above.
    if jsonb_array_length(v_flyers) <> 2 then
      raise exception 'FAIL: dropping a flyer whose promotion % left % panels rather than 2 (%)',
        v_case.why, jsonb_array_length(v_flyers), v_flyers::text;
    end if;
  end loop;

  -- The other direction, which is what stops the loop above passing against a
  -- function that simply never returns a flyer with a promotion on it.
  update public.storefront_flyers set promotion_id = v_live_id where id = v_offer_flyer;
  select g.flyers into v_flyers from public.get_public_storefront('flyer-shop-a') g;
  if not exists (select 1 from jsonb_array_elements(v_flyers) e where e->>'image_path' = 'flyers/pub-offer.jpg') then
    raise exception 'FAIL: a flyer whose promotion is live did not come back (%)', v_flyers::text;
  end if;

  -- ------------------------------------------------ 21. a DELETED promotion leaves a plain announcement
  -- Deliberately not the same outcome as expiry, and the migration header
  -- argues why: `on delete set null` (20260930000000) leaves the flyer with a
  -- null promotion_id, which is byte-for-byte a flyer that never had an offer
  -- -- there is nothing left to drop it on. Deletion is also the attended
  -- case: an owner is in the editor when it happens.
  select e into v_panel from jsonb_array_elements(v_flyers) e where e->>'image_path' = 'flyers/pub-doomed.jpg';
  if jsonb_typeof(v_panel->'offer') is distinct from 'object' then
    raise exception 'FAIL: the doomed flyer was not claiming an offer BEFORE its promotion was deleted -- check 21 would prove nothing';
  end if;

  delete from public.promotions where id = v_doomed_id;
  select g.flyers into v_flyers from public.get_public_storefront('flyer-shop-a') g;

  if not exists (select 1 from jsonb_array_elements(v_flyers) e where e->>'image_path' = 'flyers/pub-doomed.jpg') then
    raise exception 'FAIL: deleting a promotion took the flyer off the page (%)', v_flyers::text;
  end if;
  select e into v_panel from jsonb_array_elements(v_flyers) e where e->>'image_path' = 'flyers/pub-doomed.jpg';
  if jsonb_typeof(v_panel->'offer') is distinct from 'null' then
    raise exception 'FAIL: a flyer kept claiming an offer after the promotion was deleted (%)', v_panel::text;
  end if;
  if (select promotion_id from public.storefront_flyers where id = v_doomed_flyer) is not null then
    raise exception 'FAIL: the deleted promotion did not leave promotion_id null -- the premise of this check is gone';
  end if;

  -- ------------------------------------------------ 22. a shop with no flyers reads as an empty list, never as null
  -- Two states, not three. A null here would give a renderer a second way to
  -- spell "no flyers" and an anonymous caller a way to tell a shop that has
  -- never had one from a shop whose flyers are all drafts.
  select g.flyers into v_flyers from public.get_public_storefront('flyer-shop-g') g;
  if v_flyers is null or v_flyers::text is distinct from '[]' then
    raise exception 'FAIL: a published shop with no flyers returned % rather than []',
      coalesce(v_flyers::text, '<null>');
  end if;

  update public.storefront_flyers set draft = true where shop_id = v_shop_a;
  select g.flyers into v_flyers from public.get_public_storefront('flyer-shop-a') g;
  if v_flyers::text is distinct from '[]' then
    raise exception 'FAIL: a shop whose flyers are all drafts returned % rather than [] -- it is distinguishable from a shop with none',
      coalesce(v_flyers::text, '<null>');
  end if;
  update public.storefront_flyers set draft = false where shop_id = v_shop_a and image_path <> 'flyers/pub-draft.jpg';

  -- ------------------------------------------------ 23. the anti-enumeration property still holds
  -- Plan 1 built this deliberately: an unpublished shop and an unknown slug
  -- render byte-identically, so nobody can walk names and learn which shops
  -- are on kaiibi before they open. Flyers travel on the SAME call precisely
  -- so a second RPC cannot reintroduce the distinction by erroring, or by
  -- taking a different amount of time, on one of the two.
  if (select count(*) from public.get_public_storefront('flyer-shop-f')) <> 0 then
    raise exception 'FAIL: an unpublished shop answered the public read -- its flyer is on the street';
  end if;
  if (select count(*) from public.get_public_storefront('no-such-flyer-shop')) <> 0 then
    raise exception 'FAIL: an unknown slug answered the public read';
  end if;

  select coalesce((select row(g.*)::text from public.get_public_storefront('flyer-shop-f') g), '<no rows>')
    into v_missing;
  select coalesce((select row(g.*)::text from public.get_public_storefront('no-such-flyer-shop') g), '<no rows>')
    into v_present;
  -- Asserted to be the no-rows sentinel as well as equal: two identical ROWS
  -- would satisfy equality alone while both shops were being published.
  if v_missing is distinct from '<no rows>' or v_present is distinct from v_missing then
    raise exception 'FAIL: an unpublished shop (%) and an unknown slug (%) do not read alike', v_missing, v_present;
  end if;

  -- ------------------------------------------------ 24. anon may make the call, and still owns nothing
  -- The grant and the absence of a grant are one check, because either alone
  -- is satisfiable by the wrong thing: execute without a table grant is the
  -- design, a table grant is the design failing, and no execute at all is a
  -- public page nobody can load.
  if not has_function_privilege('anon', 'public.get_public_storefront(text)', 'EXECUTE') then
    raise exception 'FAIL: anon cannot execute get_public_storefront -- the public page is unreadable';
  end if;
  if has_table_privilege('anon', 'public.storefront_flyers', 'SELECT')
     or has_table_privilege('anon', 'public.storefront_flyers', 'INSERT')
     or has_table_privilege('anon', 'public.storefront_flyers', 'UPDATE')
     or has_table_privilege('anon', 'public.storefront_flyers', 'DELETE') then
    raise exception 'FAIL: the public read migration handed anon a table grant on storefront_flyers';
  end if;

  -- And for real, as anon, through the one path that is meant to work. The
  -- offer derivation is reached from inside a `security definer` function, so
  -- the helper functions need no grant of their own -- check 25 pins that.
  set local role anon;
  if current_user is distinct from 'anon' then
    raise exception 'FAIL: set local role anon did not take effect (current_user = %)', current_user;
  end if;
  select g.flyers into v_flyers from public.get_public_storefront('flyer-shop-a') g;
  reset role;

  if v_flyers is null or jsonb_array_length(v_flyers) <> 3 then
    raise exception 'FAIL: anon could not read the flyers through the function (%)',
      coalesce(v_flyers::text, '<null>');
  end if;
  if (v_flyers->1->'offer'->>'value') is distinct from '20%' then
    raise exception 'FAIL: anon got a flyer with no derived offer on it (%)', (v_flyers->1)::text;
  end if;

  -- ------------------------------------------------ 25. the derivation is not a second public API
  -- Postgres grants EXECUTE to PUBLIC on every new function. The migration
  -- revokes it, so the offer wording is reachable only through
  -- get_public_storefront's explicit column list -- and check 24 has already
  -- proven anon still gets its flyers regardless, because a definer function
  -- runs its body as the owner.
  if has_function_privilege('anon',
       'public.promotion_offer_copy(text,integer,text,text,timestamptz,timestamptz)', 'EXECUTE') then
    raise exception 'FAIL: anon can call promotion_offer_copy directly -- the revoke from public did not happen';
  end if;
  if has_function_privilege('anon', 'public.promotion_is_live(boolean,timestamptz,timestamptz,timestamptz,timestamptz)', 'EXECUTE') then
    raise exception 'FAIL: anon can call promotion_is_live directly -- the revoke from public did not happen';
  end if;

  -- ================================================================
  -- Task 4 (20260930000200): storefronts.auto_advance, read through the
  -- SAME public call as everything above -- no fifth RPC, same
  -- anti-enumeration reason checks 16-23 already established for flyers.
  -- ================================================================

  -- ------------------------------------------------ 26. off unless the shop asks (property 1)
  -- Flyer Shop A never touched the column, so the table's own
  -- `not null default false` is what a stranger reads.
  select g.auto_advance into v_auto_advance from public.get_public_storefront('flyer-shop-a') g;
  if v_auto_advance is distinct from false then
    raise exception 'FAIL: a shop that never touched auto_advance read % rather than false through the public call',
      coalesce(v_auto_advance::text, '<null>');
  end if;

  -- ------------------------------------------------ 27. the shop's own "on" travels
  update public.storefronts set auto_advance = true where shop_id = v_shop_a;
  select g.auto_advance into v_auto_advance from public.get_public_storefront('flyer-shop-a') g;
  if v_auto_advance is distinct from true then
    raise exception 'FAIL: turning auto_advance on did not travel to the public read (got %)',
      coalesce(v_auto_advance::text, '<null>');
  end if;
  -- ...and back off travels too -- without this, a function that hard-coded
  -- `true` once it saw ANY shop ask would still pass check 27 alone.
  update public.storefronts set auto_advance = false where shop_id = v_shop_a;
  select g.auto_advance into v_auto_advance from public.get_public_storefront('flyer-shop-a') g;
  if v_auto_advance is distinct from false then
    raise exception 'FAIL: turning auto_advance back off did not travel to the public read (got %)',
      coalesce(v_auto_advance::text, '<null>');
  end if;

  -- ------------------------------------------------ 28. PUBLIC keeps no default execute on the reproduced function
  -- Postgres grants EXECUTE to PUBLIC on every new function -- the same
  -- point check 25 makes for the derivation helpers, made here for
  -- get_public_storefront ITSELF, because 20260930000200 drops and
  -- recreates it (a `returns table` column addition forces a drop) and a
  -- `grant ... to anon, authenticated` with no matching `revoke ... from
  -- public` first is a no-op that reads like a decision. Checked directly
  -- against the function's ACL, not against one extra role's privilege,
  -- so this holds regardless of which auxiliary roles this Supabase
  -- project happens to define.
  if exists (
    select 1
    from pg_proc
    where oid = 'public.get_public_storefront(text)'::regprocedure
      and exists (
        select 1 from unnest(coalesce(proacl, '{}'::aclitem[])) as acl
        where acl::text like '=X/%'
      )
  ) then
    raise exception 'FAIL: PUBLIC still holds EXECUTE on get_public_storefront -- revoke ... from public did not run before the grant';
  end if;

  raise notice 'ALL CHECKS PASSED';
  -- Deliberate rollback: everything above was throwaway.
  raise exception 'rollback_marker';
exception
  when others then
    if sqlerrm = 'rollback_marker' then
      raise notice 'verify-storefront-flyers: rolled back';
    else
      raise;
    end if;
end $$;

-- Proof the block left nothing behind. Flyers are counted through their own
-- table rather than only through the shops, because a row whose parent rolled
-- back is exactly the kind of leftover this is looking for.
select case when (select count(*) from public.shops where name like 'Flyer Shop %') = 0
             and (select count(*) from public.storefront_flyers
                  where image_path like 'flyers/%') = 0
            then 'CLEAN: no rows left behind'
            else 'WARNING: verify-storefront-flyers left rows behind' end as cleanup;
