-- @no-verdict: prints figures to read, rather than asserting PASS/FAIL itself.
-- Runtime proof for the server-side promotion window (finding B).
-- Everything happens inside one transaction and is rolled back.
\set ON_ERROR_STOP off
begin;

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, created_at, updated_at)
values ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-000000000000',
        'authenticated', 'authenticated', 'w@test.local', '', now(), now());

insert into public.shops (id, owner_id, name)
values ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000f1', 'Window Test Shop');

insert into public.shop_locations (id, shop_id, name, is_primary)
values ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000a1', 'Main', true);

-- The shop insert fires seed_shop_defaults, which creates the default roles
-- from default_shop_roles(). Use that seeded Owner rather than making one --
-- which also proves the CRITICAL fix: a shop created AFTER this migration
-- must seed an Owner that already holds discounts.manual.
\echo ''
\echo '=== CRITICAL: does a NEWLY seeded role carry the discount permissions? ==='
select name,
       'discounts.manual' = any(permissions) as has_manual,
       'discounts.apply'  = any(permissions) as has_apply
  from public.roles
 where shop_id = '00000000-0000-0000-0000-0000000000a1'
 order by name;

-- The owner is already a shop_member too (migration 20260823000000), so there
-- is nothing to insert; just point them at the seeded Owner role.
update public.shop_members
   set role_id = (select id from public.roles
                   where shop_id = '00000000-0000-0000-0000-0000000000a1' and name = 'Owner'),
       active = true
 where shop_id = '00000000-0000-0000-0000-0000000000a1'
   and user_id = '00000000-0000-0000-0000-0000000000f1';

insert into public.products (id, shop_id, name, price_cents, stock)
values ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000a1', 'Widget', 1000, 500);

-- Four promotions, differing only in their window / archived state.
insert into public.promotions (id, shop_id, name, discount_type, discount_value, scope, starts_at, ends_at, archived_at)
values
  ('00000000-0000-0000-0000-0000000000e1','00000000-0000-0000-0000-0000000000a1','Just Ended',   'percentage',10,'store', null, now() - interval '2 minutes', null),
  ('00000000-0000-0000-0000-0000000000e2','00000000-0000-0000-0000-0000000000a1','Long Over',    'percentage',10,'store', null, now() - interval '2 hours',   null),
  ('00000000-0000-0000-0000-0000000000e3','00000000-0000-0000-0000-0000000000a1','Starts Tomorrow','percentage',10,'store', now() + interval '1 day', null, null),
  ('00000000-0000-0000-0000-0000000000e4','00000000-0000-0000-0000-0000000000a1','Archived Later','percentage',10,'store', null, null, null);

select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000000f1","role":"authenticated"}', true);

\echo ''
\echo '=== (a) ended 2 minutes ago -> ACCEPTED (inside the 10-minute grace) ==='
do $$
declare v_id uuid;
begin
  v_id := public.complete_sale(
    '00000000-0000-0000-0000-0000000000a1',
    '[{"product_id":"00000000-0000-0000-0000-0000000000d1","quantity":1,"discount_cents":100,"promotion_id":"00000000-0000-0000-0000-0000000000e1","promotion_name":"x"}]'::jsonb,
    '[{"method":"cash","amount_cents":900,"tendered_cents":900}]'::jsonb);
  raise notice 'PASS: accepted, sale %', v_id;
exception when others then raise notice 'FAIL: refused -> %', sqlerrm;
end $$;

\echo ''
\echo '=== (b) ended 2 hours ago -> REJECTED ==='
do $$
begin
  perform public.complete_sale(
    '00000000-0000-0000-0000-0000000000a1',
    '[{"product_id":"00000000-0000-0000-0000-0000000000d1","quantity":1,"discount_cents":100,"promotion_id":"00000000-0000-0000-0000-0000000000e2","promotion_name":"x"}]'::jsonb,
    '[{"method":"cash","amount_cents":900,"tendered_cents":900}]'::jsonb);
  raise notice 'FAIL: a long-expired promotion was accepted';
exception when others then raise notice 'PASS: refused -> %', sqlerrm;
end $$;

\echo ''
\echo '=== (c) starts tomorrow -> REJECTED ==='
do $$
begin
  perform public.complete_sale(
    '00000000-0000-0000-0000-0000000000a1',
    '[{"product_id":"00000000-0000-0000-0000-0000000000d1","quantity":1,"discount_cents":100,"promotion_id":"00000000-0000-0000-0000-0000000000e3","promotion_name":"x"}]'::jsonb,
    '[{"method":"cash","amount_cents":900,"tendered_cents":900}]'::jsonb);
  raise notice 'FAIL: an unstarted promotion was accepted';
exception when others then raise notice 'PASS: refused -> %', sqlerrm;
end $$;

\echo ''
\echo '=== setup for edit: a sale using e4, which is then archived ==='
do $$
declare v_id uuid;
begin
  v_id := public.complete_sale(
    '00000000-0000-0000-0000-0000000000a1',
    '[{"product_id":"00000000-0000-0000-0000-0000000000d1","quantity":1,"discount_cents":100,"promotion_id":"00000000-0000-0000-0000-0000000000e4","promotion_name":"x"}]'::jsonb,
    '[{"method":"cash","amount_cents":900,"tendered_cents":900}]'::jsonb);
  create temp table t_sale as select v_id as id;
  raise notice 'seed sale %', v_id;
end $$;

update public.promotions set archived_at = now()
 where id in ('00000000-0000-0000-0000-0000000000e4','00000000-0000-0000-0000-0000000000e1');

\echo ''
\echo '=== (d) edit_sale PRESERVING e4 (already on the sale, now archived) -> ACCEPTED ==='
do $$
declare v_sale uuid;
begin
  select id into v_sale from t_sale;
  perform public.edit_sale(v_sale,
    '[{"product_id":"00000000-0000-0000-0000-0000000000d1","quantity":2,"discount_cents":200,"promotion_id":"00000000-0000-0000-0000-0000000000e4","promotion_name":"x"}]'::jsonb,
    '[{"method":"cash","amount_cents":1800,"tendered_cents":1800}]'::jsonb);
  raise notice 'PASS: archived promotion preserved through an edit';
exception when others then raise notice 'FAIL: refused -> %', sqlerrm;
end $$;

\echo ''
\echo '=== (e) edit_sale ATTACHING e1 (archived, never on this sale) -> REJECTED ==='
do $$
declare v_sale uuid;
begin
  select id into v_sale from t_sale;
  perform public.edit_sale(v_sale,
    '[{"product_id":"00000000-0000-0000-0000-0000000000d1","quantity":1,"discount_cents":100,"promotion_id":"00000000-0000-0000-0000-0000000000e1","promotion_name":"x"}]'::jsonb,
    '[{"method":"cash","amount_cents":900,"tendered_cents":900}]'::jsonb);
  raise notice 'FAIL: a newly attached archived promotion was accepted';
exception when others then raise notice 'PASS: refused -> %', sqlerrm;
end $$;

rollback;

\echo ''
\echo '=== after rollback, nothing persisted ==='
select count(*) as shops_left from public.shops where id = '00000000-0000-0000-0000-0000000000a1';
select count(*) as sales_left from public.sales where shop_id = '00000000-0000-0000-0000-0000000000a1';
