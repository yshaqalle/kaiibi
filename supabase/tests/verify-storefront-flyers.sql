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
