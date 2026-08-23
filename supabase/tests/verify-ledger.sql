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

  raise notice 'ALL CHECKS PASSED';
  raise exception 'rollback fixture';
exception
  when others then
    if sqlerrm = 'rollback fixture' then return; end if;
    raise;
end $$;
