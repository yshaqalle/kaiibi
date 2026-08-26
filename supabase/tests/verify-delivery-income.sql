-- 4300 Delivery Income: a shop that starts taking storefront delivery orders
-- needs an account to post that income to that is not 4000 Sales Revenue.
--
-- Delivery carries no cost of sales. Posting it into 4000 mixes revenue with
-- no matching COGS into goods revenue and flatters gross margin on every
-- report -- a shopkeeper reading their own P&L would conclude their products
-- earn more than they do. See 20260928000000_delivery_income_account.sql.
--
-- What is asserted, and why each one exists:
--
--   1. A NEW shop's chart includes 4300, typed 'revenue', is_contra FALSE.
--      Getting is_contra backwards would subtract delivery income from the
--      shop's takings rather than adding to them -- 4100/4200 next to it in
--      the chart are exactly that mistake, made on purpose, for a different
--      account.
--   2. AN EXISTING SHOP -- one whose 4300 row is missing, standing in for a
--      shop that traded for months before this account existed -- is
--      BACKFILLED, not just new shops. The row is deleted (not the whole
--      chart) so this proves the backfill statement targets a specific gap in
--      an otherwise-complete chart, the real shape of the shops it has to
--      reach, rather than merely re-seeding a chart from empty.
--   3. THE OTHER TWENTY-NINE ACCOUNTS ON THAT SHOP ARE UNTOUCHED by the
--      backfill: same count, same ids. `on conflict (shop_id, code) do
--      nothing` skipping every code but the missing one is invisible in a
--      total count alone -- a backfill that deleted and reinserted the whole
--      chart would pass check 2 and change every other account's id under
--      it, which a report joined on account_id would not survive.
--   4. RE-RUNNING THE BACKFILL DOES NOT DUPLICATE 4300. The mistake this
--      guards against is silent: a second matching row does not fail
--      anything downstream by itself, it just makes SUM(...) FROM accounts
--      WHERE code = '4300' ambiguous between shops that ran the backfill
--      once and shops that ran it twice.
--   5. A second 4300 row for the same shop, inserted directly, is rejected by
--      the same (shop_id, code) unique constraint the seeding relies on --
--      the constraint the backfill's ON CONFLICT clause targets is real, not
--      assumed.
--
-- Everything runs inside one DO block whose EXCEPTION clause rolls the whole
-- lot back, so it leaves no rows behind -- same shape as verify-storefront.sql.

\set ON_ERROR_STOP on

do $$
declare
  v_user_id     uuid := gen_random_uuid();
  v_shop_id     uuid;
  v_account_id  uuid;
  v_type        text;
  v_is_contra   boolean;
  v_other_ids   uuid[];
  v_other_after uuid[];
  v_count       integer;
  v_raised      boolean;
begin
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
    values (v_user_id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            'verify-delivery-income-' || v_user_id || '@example.test', '', now(), now(), now());

  insert into public.shops (owner_id, name) values (v_user_id, 'Xamdi Wares')
    returning id into v_shop_id;

  ---------------------------------------------------------------------------
  -- 1. A brand new shop's chart carries 4300 Delivery Income, typed revenue,
  --    and NOT contra.
  ---------------------------------------------------------------------------
  select id, type, is_contra into v_account_id, v_type, v_is_contra
    from public.accounts where shop_id = v_shop_id and code = '4300';

  if v_account_id is null then
    raise exception 'FAIL: a new shop has no 4300 account';
  end if;
  if v_type <> 'revenue' then
    raise exception 'FAIL: 4300 is typed % instead of revenue', v_type;
  end if;
  if v_is_contra then
    raise exception 'FAIL: 4300 is marked contra -- it would subtract delivery income from the shop''s takings instead of adding it';
  end if;

  ---------------------------------------------------------------------------
  -- 2 & 3. AN EXISTING SHOP GETS BACKFILLED, and only the missing account
  --        moves. Delete 4300 alone -- the shape of a shop that traded before
  --        this account existed -- and record every other account's id first.
  ---------------------------------------------------------------------------
  select coalesce(array_agg(id order by code), '{}')
    into v_other_ids
    from public.accounts where shop_id = v_shop_id and code <> '4300';

  delete from public.accounts where shop_id = v_shop_id and code = '4300';

  if exists (select 1 from public.accounts where shop_id = v_shop_id and code = '4300') then
    raise exception 'FAIL: FIXTURE could not remove 4300 to simulate a pre-existing shop';
  end if;

  -- The exact statement 20260928000000_delivery_income_account.sql runs to
  -- reach shops that already exist: every shop, cross joined with the shared
  -- chart-of-accounts function, on conflict do nothing.
  insert into public.accounts (shop_id, code, name, type, is_contra)
    select s.id, c.code, c.name, c.type, c.is_contra
      from public.shops s
     cross join public.default_chart_of_accounts() c
     where s.id = v_shop_id
    on conflict (shop_id, code) do nothing;

  select type, is_contra into v_type, v_is_contra
    from public.accounts where shop_id = v_shop_id and code = '4300';

  if v_type is null then
    raise exception 'FAIL: the backfill did not restore 4300 for a shop that was missing it';
  end if;
  if v_type <> 'revenue' or v_is_contra then
    raise exception 'FAIL: the backfilled 4300 is wrong -- type %, is_contra %', v_type, v_is_contra;
  end if;

  select coalesce(array_agg(id order by code), '{}')
    into v_other_after
    from public.accounts where shop_id = v_shop_id and code <> '4300';

  if v_other_after <> v_other_ids then
    raise exception 'FAIL: the backfill disturbed accounts other than the missing 4300';
  end if;

  ---------------------------------------------------------------------------
  -- 4. RE-RUNNING THE BACKFILL DOES NOT DUPLICATE 4300.
  ---------------------------------------------------------------------------
  insert into public.accounts (shop_id, code, name, type, is_contra)
    select s.id, c.code, c.name, c.type, c.is_contra
      from public.shops s
     cross join public.default_chart_of_accounts() c
     where s.id = v_shop_id
    on conflict (shop_id, code) do nothing;

  select count(*) into v_count from public.accounts where shop_id = v_shop_id and code = '4300';
  if v_count <> 1 then
    raise exception 'FAIL: re-running the backfill left % rows for 4300 instead of 1', v_count;
  end if;

  ---------------------------------------------------------------------------
  -- 5. THE CONSTRAINT THE BACKFILL LEANS ON IS REAL: a direct duplicate
  --    insert for the same shop and code is rejected, not silently allowed.
  ---------------------------------------------------------------------------
  v_raised := false;
  begin
    insert into public.accounts (shop_id, code, name, type, is_contra)
      values (v_shop_id, '4300', 'Delivery Income', 'revenue', false);
  exception when unique_violation then v_raised := true;
  end;
  if not v_raised then
    raise exception 'FAIL: a second 4300 account for the same shop was accepted';
  end if;

  raise notice 'PASS: delivery income account';
  raise exception 'rollback_marker';
exception
  when others then
    if sqlerrm = 'rollback_marker' then
      raise notice 'verify-delivery-income: all checks passed, rolled back';
    else
      raise;
    end if;
end $$;
