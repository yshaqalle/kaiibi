-- @no-verdict -- prints timings, asserts nothing. The runner skips it.
--
-- What the posting side costs complete_sale on a realistic basket. Run this
-- BEFORE 20260908000200 and AFTER it, and put both figures in the commit
-- message. "It is probably fine" is not a measurement.
--
-- 20 lines is the realistic worst case for a kaiibi shop -- a wholesale run,
-- not a corner-shop basket. 40 iterations, median reported, because the first
-- call in a session pays for plan caching and would skew a mean.

\set ON_ERROR_STOP on

do $$
declare
  v_user_id uuid := gen_random_uuid();
  v_shop_id uuid; v_loc_id uuid;
  v_items jsonb := '[]'::jsonb;
  v_prod uuid;
  v_start timestamptz; v_ms numeric;
  v_times numeric[] := '{}';
  i integer;
begin
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
    values (v_user_id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            'bench-' || v_user_id || '@example.test', '', now(), now(), now());
  insert into public.shops (owner_id, name) values (v_user_id, 'Bench Shop') returning id into v_shop_id;
  insert into public.shop_locations (shop_id, name, is_primary) values (v_shop_id, 'Main', true) returning id into v_loc_id;

  for i in 1..20 loop
    insert into public.products (shop_id, name, price_cents, cost_cents, stock)
      values (v_shop_id, 'Bench ' || i, 1000 + i, 400 + i, 100000) returning id into v_prod;
    v_items := v_items || jsonb_build_array(jsonb_build_object(
      'product_id', v_prod, 'quantity', 2, 'unit_price_cents', 1000 + i));
  end loop;

  perform set_config('request.jwt.claims', json_build_object('sub', v_user_id)::text, true);
  perform set_config('role', 'authenticated', true);

  for i in 1..40 loop
    v_start := clock_timestamp();
    perform public.complete_sale(
      v_shop_id, v_items,
      jsonb_build_array(jsonb_build_object('method', 'cash', 'amount_cents', 40420)),
      null, null, null, null, 0, null, null, v_loc_id);
    v_ms := extract(epoch from (clock_timestamp() - v_start)) * 1000;
    if i > 5 then v_times := v_times || v_ms; end if;  -- discard the warm-up
  end loop;

  select percentile_cont(0.5) within group (order by t) into v_ms from unnest(v_times) t;
  raise notice 'complete_sale, 20 lines, median of 35: % ms', round(v_ms, 2);
  select percentile_cont(0.95) within group (order by t) into v_ms from unnest(v_times) t;
  raise notice 'complete_sale, 20 lines, p95 of 35:    % ms', round(v_ms, 2);

  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims', null, true);
  raise exception 'rollback fixture';
exception
  when others then
    perform set_config('role', 'postgres', true);
    perform set_config('request.jwt.claims', null, true);
    if sqlerrm = 'rollback fixture' then return; end if;
    raise;
end $$;
