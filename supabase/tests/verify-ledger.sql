-- The ledger: permissions, chart of accounts, balanced entries, immutability.
--
-- None of this can be checked from TypeScript. Every assertion here is a fact
-- about a constraint, a trigger, an RLS policy or a security definer function,
-- and the client can only ever observe what those already decided.
--
-- ## Two traps this file is written around
--
-- This script runs as the postgres superuser, so RLS does not apply to it.
--
--   1. A policy can never be asserted by attempting the operation. A DELETE
--      that a policy should refuse succeeds anyway here, and the check would be
--      reporting on nothing. Policies are asserted against pg_policies.
--   2. Any RPC gating on has_shop_permission refuses until this script becomes
--      a user: auth.uid() reads request.jwt.claims->>'sub', and there is no JWT
--      until set_config puts one there. Setting `role` at the same time turns
--      RLS ON, so every raw insert has to happen before that point.
--
-- Runs inside one DO block whose EXCEPTION clause rolls it all back.

\set ON_ERROR_STOP on

do $$
declare
  v_owner_id     uuid := gen_random_uuid();
  v_shop_id      uuid;
  v_perms        text[];
  -- Used from the journal checks onward. Declared here because this block grows
  -- one check at a time and a later addition must not have to edit this header.
  v_raised       boolean;
begin
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
    values (v_owner_id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            'verify-ledger-' || v_owner_id || '@example.test', '', now(), now(), now());

  insert into public.shops (owner_id, name) values (v_owner_id, 'Ledger Shop') returning id into v_shop_id;

  -- 1. The seeded Owner holds all three verbs on a shop created after this
  -- migration. default_shop_roles() reaches shops that do not exist yet; the
  -- backfill reaches the ones that do. Both are required and this checks the
  -- half that is easiest to forget.
  select permissions into v_perms from public.roles where shop_id = v_shop_id and name = 'Owner';
  if v_perms is null then
    raise exception 'FAIL: no seeded Owner role for the fixture shop';
  end if;
  if not v_perms @> array['ledger.view', 'ledger.post', 'ledger.close'] then
    raise exception 'FAIL: seeded Owner is missing a ledger permission: %', v_perms;
  end if;

  -- 2. The seeded Manager holds ledger.view and NOTHING else. Reading the books
  -- is ordinary; writing a manual journal entry is the one action that can put
  -- them into a state nobody can explain later, so it is granted deliberately
  -- or not at all.
  select permissions into v_perms from public.roles where shop_id = v_shop_id and name = 'Manager';
  if not v_perms @> array['ledger.view'] then
    raise exception 'FAIL: seeded Manager cannot read the books: %', v_perms;
  end if;
  if v_perms && array['ledger.post', 'ledger.close'] then
    raise exception 'FAIL: seeded Manager was handed a write verb: %', v_perms;
  end if;

  -- 3. The seeded Cashier holds none of them. A till role gains nothing here.
  select permissions into v_perms from public.roles where shop_id = v_shop_id and name = 'Cashier';
  if v_perms && array['ledger.view', 'ledger.post', 'ledger.close'] then
    raise exception 'FAIL: seeded Cashier was handed a ledger verb: %', v_perms;
  end if;

  -- 4. A new shop gets a full chart of accounts, seeded by the same trigger
  -- that seeds its roles.
  if (select count(*) from public.accounts where shop_id = v_shop_id) < 30 then
    raise exception 'FAIL: shop seeded with only % accounts', (select count(*) from public.accounts where shop_id = v_shop_id);
  end if;

  -- 5. The three accounts the whole design turns on exist, and are the type
  -- that makes a balance sheet possible. inventory_purchase must reach an
  -- ASSET, owner_draw must reach EQUITY, and stock_loss must reach COST OF
  -- SALES -- not the expense account each of them is filed under today.
  if not exists (select 1 from public.accounts where shop_id = v_shop_id and code = '1200' and type = 'asset') then
    raise exception 'FAIL: 1200 Inventory is missing or is not an asset';
  end if;
  if not exists (select 1 from public.accounts where shop_id = v_shop_id and code = '3100' and type = 'equity' and is_contra) then
    raise exception 'FAIL: 3100 Owner''s Draw is missing or is not contra-equity';
  end if;
  if not exists (select 1 from public.accounts where shop_id = v_shop_id and code = '5100' and type = 'cost_of_sales') then
    raise exception 'FAIL: 5100 Inventory Shrinkage is missing or is not cost of sales';
  end if;

  -- 6. Codes are unique per shop. Two accounts numbered 1000 would make every
  -- statement ambiguous and nothing would report the collision.
  v_raised := false;
  begin
    insert into public.accounts (shop_id, code, name, type) values (v_shop_id, '1000', 'Duplicate', 'asset');
  exception
    when unique_violation then v_raised := true;
  end;
  if not v_raised then
    raise exception 'FAIL: a duplicate account code was accepted';
  end if;

  -- 7. A bogus type is refused. The six are a closed set because every report
  -- groups by them; a seventh spelling would silently become a seventh section
  -- that no statement knows how to place.
  v_raised := false;
  begin
    insert into public.accounts (shop_id, code, name, type) values (v_shop_id, '9999', 'Bogus', 'liabilities');
  exception
    when check_violation then v_raised := true;
  end;
  if not v_raised then
    raise exception 'FAIL: a bogus account type was accepted';
  end if;

  -- 8. A month with no period row yet is open, and asking for it creates it.
  -- A shop should not have to be set up before it can trade; the first entry
  -- of a month opens that month.
  if public.open_period_for(v_shop_id, date '2026-08-15') is null then
    raise exception 'FAIL: open_period_for did not open a period for an untouched month';
  end if;
  if (select count(*) from public.accounting_periods
        where shop_id = v_shop_id and starts_on = date '2026-08-01') <> 1 then
    raise exception 'FAIL: open_period_for did not create exactly one August period';
  end if;

  -- 9. A closed month refuses. This is the whole point of closing, and it must
  -- be refused HERE rather than in the UI -- a period that only the client
  -- respects is not closed.
  update public.accounting_periods set status = 'closed'
    where shop_id = v_shop_id and starts_on = date '2026-08-01';
  v_raised := false;
  begin
    perform public.open_period_for(v_shop_id, date '2026-08-15');
  exception
    when sqlstate 'P0001' then
      if position('closed' in sqlerrm) = 0 then raise; end if;
      v_raised := true;
  end;
  if not v_raised then
    raise exception 'FAIL: a closed period accepted a posting date';
  end if;
  update public.accounting_periods set status = 'open'
    where shop_id = v_shop_id and starts_on = date '2026-08-01';

  raise notice 'ALL CHECKS PASSED';
  raise exception 'rollback fixture';
exception
  when others then
    if sqlerrm = 'rollback fixture' then return; end if;
    raise;
end $$;
