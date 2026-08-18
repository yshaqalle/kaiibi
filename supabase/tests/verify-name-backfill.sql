-- The category/brand/tag backfill, against the real schema.
--
-- Migration 20260901000000 gives a row to every name that only ever existed as
-- free text on a product. It was written for a shop whose POS showed nine
-- category chips while its products carried far more -- reported as "no more
-- than 10 categories shows up", when nothing was capped at all: the importer
-- wrote products.category and never registered the name, and POS builds its
-- filter row from the categories TABLE.
--
-- The migration ran once, before this shop's data existed. So this re-runs its
-- exact statements against a fixture that reproduces the situation, which is
-- also what proves the migration is safe to re-run -- it is applied twice here
-- and the second pass must add nothing.
--
-- The traps, all of them real things in a shop's data: the same category in two
-- casings, names padded with spaces, an empty string, a null, an empty tag
-- inside a tags array, a name already in the table under a different casing,
-- and a second shop that must not receive any of it.
--
-- Everything runs inside one DO block whose EXCEPTION clause rolls it all back.

\set ON_ERROR_STOP on

do $$
declare
  v_owner_id uuid := gen_random_uuid();
  v_owner2_id uuid := gen_random_uuid();
  v_shop_id uuid;
  v_shop2_id uuid;
  v_count integer;
  v_name text;
  v_color text;
  v_before integer;
  v_after integer;
begin
  ------------------------------------------------------------------
  -- Fixture
  ------------------------------------------------------------------
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
    values (v_owner_id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            'verify-backfill-owner-' || v_owner_id || '@example.test', '', now(), now(), now());
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
    values (v_owner2_id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            'verify-backfill-owner2-' || v_owner2_id || '@example.test', '', now(), now(), now());

  insert into public.shops (owner_id, name) values (v_owner_id, 'Backfill Verify Shop') returning id into v_shop_id;
  insert into public.shops (owner_id, name) values (v_owner2_id, 'Other Shop') returning id into v_shop2_id;

  perform set_config('request.jwt.claims', json_build_object('sub', v_owner_id)::text, true);

  -- The handful someone typed by hand, one of them with a colour chosen.
  insert into public.categories (shop_id, name, color) values (v_shop_id, 'Cleanser', '#7cc7e8');
  insert into public.brands (shop_id, name) values (v_shop_id, 'Anua');

  -- The catalogue that arrived by import.
  insert into public.products (shop_id, name, price_cents, category, brand, tags, created_at) values
    (v_shop_id, 'p1',  1000, 'Cleanser',   'Anua',       array['bestseller'],           now() - interval '10 day'),
    (v_shop_id, 'p2',  1000, 'cleanser',   'anua',       array['BESTSELLER','summer'],  now() - interval '9 day'),
    (v_shop_id, 'p3',  1000, 'Toner',      'Torriden',   array['summer'],               now() - interval '8 day'),
    (v_shop_id, 'p4',  1000, '  Toner  ',  '  Torriden ',array['  summer  '],           now() - interval '7 day'),
    (v_shop_id, 'p5',  1000, 'Sunscreen',  'Beauty of Joseon', array[]::text[],         now() - interval '6 day'),
    (v_shop_id, 'p6',  1000, '',           '',           array[''],                     now() - interval '5 day'),
    -- A null category and brand. `tags` is NOT NULL in the real schema, so the
    -- empty-array case is what stands in for "this product has no tags".
    (v_shop_id, 'p7',  1000, null,         null,         array[]::text[],               now() - interval '4 day'),
    (v_shop_id, 'p8',  1000, 'Sheet Mask', 'SKIN1004',   array['gift','summer'],        now() - interval '3 day'),
    (v_shop_id, 'p9',  1000, 'Essence',    'Round Lab',  array['new'],                  now() - interval '2 day'),
    (v_shop_id, 'p10', 1000, 'ESSENCE',    'ROUND LAB',  array['NEW'],                  now() - interval '1 day');

  perform set_config('request.jwt.claims', json_build_object('sub', v_owner2_id)::text, true);
  insert into public.products (shop_id, name, price_cents, category, brand, tags)
    values (v_shop2_id, 'q1', 1000, 'Toner', 'Torriden', array['summer']);
  perform set_config('request.jwt.claims', json_build_object('sub', v_owner_id)::text, true);

  ------------------------------------------------------------------
  -- The migration's statements, run as the migration runs them
  ------------------------------------------------------------------
  insert into public.categories (shop_id, name)
  select distinct on (p.shop_id, lower(btrim(p.category))) p.shop_id, btrim(p.category)
    from public.products p
   where p.category is not null and btrim(p.category) <> ''
     and not exists (select 1 from public.categories c where c.shop_id = p.shop_id and lower(c.name) = lower(btrim(p.category)))
   order by p.shop_id, lower(btrim(p.category)), p.created_at
  on conflict (shop_id, name) do nothing;

  insert into public.brands (shop_id, name)
  select distinct on (p.shop_id, lower(btrim(p.brand))) p.shop_id, btrim(p.brand)
    from public.products p
   where p.brand is not null and btrim(p.brand) <> ''
     and not exists (select 1 from public.brands b where b.shop_id = p.shop_id and lower(b.name) = lower(btrim(p.brand)))
   order by p.shop_id, lower(btrim(p.brand)), p.created_at
  on conflict (shop_id, name) do nothing;

  insert into public.tags (shop_id, name)
  select distinct on (t.shop_id, lower(t.name)) t.shop_id, t.name
    from (select p.shop_id, btrim(tag) as name, p.created_at
            from public.products p
            cross join lateral unnest(coalesce(p.tags, array[]::text[])) as tag) t
   where t.name <> ''
     and not exists (select 1 from public.tags existing where existing.shop_id = t.shop_id and lower(existing.name) = lower(t.name))
   order by t.shop_id, lower(t.name), t.created_at
  on conflict (shop_id, name) do nothing;

  ------------------------------------------------------------------
  -- 1. Every imported category now has a row
  ------------------------------------------------------------------
  -- Cleanser (already there), Essence, Sheet Mask, Sunscreen, Toner. The blank
  -- and the null contribute nothing, and the second casing of each is folded in.
  select count(*) into v_count from public.categories where shop_id = v_shop_id;
  if v_count <> 5 then
    raise exception 'FAIL 1: expected 5 categories (Cleanser, Essence, Sheet Mask, Sunscreen, Toner), got %', v_count;
  end if;
  raise notice 'check 1 ok: % categories, was 1', v_count;

  ------------------------------------------------------------------
  -- 2. A name already in the table keeps its colour, and gains no twin
  ------------------------------------------------------------------
  select count(*), max(color) into v_count, v_color
    from public.categories where shop_id = v_shop_id and lower(name) = 'cleanser';
  if v_count <> 1 then
    raise exception 'FAIL 2: "Cleanser"/"cleanser" made % rows, expected 1', v_count;
  end if;
  if v_color is distinct from '#7cc7e8' then
    raise exception 'FAIL 2: Cleanser lost its colour, got %', coalesce(v_color, 'null');
  end if;
  raise notice 'check 2 ok: existing row kept, colour intact';

  ------------------------------------------------------------------
  -- 3. Two casings of a NEW name collapse to one row, first use winning
  ------------------------------------------------------------------
  select count(*) into v_count from public.categories where shop_id = v_shop_id and lower(name) = 'essence';
  if v_count <> 1 then
    raise exception 'FAIL 3: "Essence"/"ESSENCE" made % rows, expected 1', v_count;
  end if;
  select name into v_name from public.categories where shop_id = v_shop_id and lower(name) = 'essence';
  if v_name <> 'Essence' then
    raise exception 'FAIL 3: expected the earlier product''s spelling "Essence", got "%"', v_name;
  end if;
  raise notice 'check 3 ok: one row, spelled as first used';

  ------------------------------------------------------------------
  -- 4. Padding is trimmed, and does not make a second row
  ------------------------------------------------------------------
  select count(*) into v_count from public.categories where shop_id = v_shop_id and name = 'Toner';
  if v_count <> 1 then
    raise exception 'FAIL 4: "Toner"/"  Toner  " made % rows, expected 1', v_count;
  end if;
  select count(*) into v_count from public.categories where shop_id = v_shop_id and name <> btrim(name);
  if v_count <> 0 then
    raise exception 'FAIL 4: % category names carry padding', v_count;
  end if;
  raise notice 'check 4 ok: trimmed, one row';

  ------------------------------------------------------------------
  -- 5. Empty strings and nulls produce nothing
  ------------------------------------------------------------------
  select count(*) into v_count from public.categories where shop_id = v_shop_id and btrim(name) = '';
  if v_count <> 0 then
    raise exception 'FAIL 5: % blank category rows created', v_count;
  end if;
  select count(*) into v_count from public.tags where shop_id = v_shop_id and btrim(name) = '';
  if v_count <> 0 then
    raise exception 'FAIL 5: % blank tag rows created', v_count;
  end if;
  raise notice 'check 5 ok: no blank rows';

  ------------------------------------------------------------------
  -- 6. Tags come out of the array, deduplicated across products
  ------------------------------------------------------------------
  select count(*) into v_count from public.tags where shop_id = v_shop_id;
  if v_count <> 4 then
    raise exception 'FAIL 6: expected 4 tags (bestseller, gift, new, summer), got %', v_count;
  end if;
  select count(*) into v_count from public.tags where shop_id = v_shop_id and lower(name) = 'summer';
  if v_count <> 1 then
    raise exception 'FAIL 6: "summer" appears on three products but made % rows', v_count;
  end if;
  raise notice 'check 6 ok: 4 tags, each once';

  ------------------------------------------------------------------
  -- 7. Brands behave the same as categories
  ------------------------------------------------------------------
  select count(*) into v_count from public.brands where shop_id = v_shop_id;
  if v_count <> 5 then
    raise exception 'FAIL 7: expected 5 brands, got %', v_count;
  end if;
  raise notice 'check 7 ok: % brands', v_count;

  ------------------------------------------------------------------
  -- 8. Nothing leaked into the other shop
  ------------------------------------------------------------------
  select count(*) into v_count from public.categories where shop_id = v_shop2_id;
  if v_count <> 1 then
    raise exception 'FAIL 8: other shop has % categories, expected only its own Toner', v_count;
  end if;
  select count(*) into v_count from public.tags where shop_id = v_shop2_id;
  if v_count <> 1 then
    raise exception 'FAIL 8: other shop has % tags, expected 1', v_count;
  end if;
  raise notice 'check 8 ok: shops kept separate';

  ------------------------------------------------------------------
  -- 9. Running it again adds nothing
  ------------------------------------------------------------------
  select (select count(*) from public.categories) + (select count(*) from public.brands) + (select count(*) from public.tags)
    into v_before;

  insert into public.categories (shop_id, name)
  select distinct on (p.shop_id, lower(btrim(p.category))) p.shop_id, btrim(p.category)
    from public.products p
   where p.category is not null and btrim(p.category) <> ''
     and not exists (select 1 from public.categories c where c.shop_id = p.shop_id and lower(c.name) = lower(btrim(p.category)))
   order by p.shop_id, lower(btrim(p.category)), p.created_at
  on conflict (shop_id, name) do nothing;

  insert into public.brands (shop_id, name)
  select distinct on (p.shop_id, lower(btrim(p.brand))) p.shop_id, btrim(p.brand)
    from public.products p
   where p.brand is not null and btrim(p.brand) <> ''
     and not exists (select 1 from public.brands b where b.shop_id = p.shop_id and lower(b.name) = lower(btrim(p.brand)))
   order by p.shop_id, lower(btrim(p.brand)), p.created_at
  on conflict (shop_id, name) do nothing;

  insert into public.tags (shop_id, name)
  select distinct on (t.shop_id, lower(t.name)) t.shop_id, t.name
    from (select p.shop_id, btrim(tag) as name, p.created_at
            from public.products p
            cross join lateral unnest(coalesce(p.tags, array[]::text[])) as tag) t
   where t.name <> ''
     and not exists (select 1 from public.tags existing where existing.shop_id = t.shop_id and lower(existing.name) = lower(t.name))
   order by t.shop_id, lower(t.name), t.created_at
  on conflict (shop_id, name) do nothing;

  select (select count(*) from public.categories) + (select count(*) from public.brands) + (select count(*) from public.tags)
    into v_after;
  if v_after <> v_before then
    raise exception 'FAIL 9: re-running added % rows, expected 0', v_after - v_before;
  end if;
  raise notice 'check 9 ok: re-run is a no-op';

  raise exception 'ROLLBACK: ALL CHECKS PASSED';
exception
  when others then
    if sqlerrm = 'ROLLBACK: ALL CHECKS PASSED' then
      raise notice '%', sqlerrm;
    else
      raise;
    end if;
end $$;
