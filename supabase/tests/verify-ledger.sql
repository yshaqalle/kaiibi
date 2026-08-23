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

  -- 10. A balanced entry is accepted. Deferred means the imbalance is legal
  -- BETWEEN the two inserts and only judged at commit, which is the only way
  -- to write two rows that must sum to zero.
  declare
    v_entry uuid;
    v_cash  uuid := (select id from public.accounts where shop_id = v_shop_id and code = '1000');
    v_shrink uuid := (select id from public.accounts where shop_id = v_shop_id and code = '5100');
  begin
    insert into public.journal_entries (shop_id, period_id, entry_date, description, source, status, created_by)
      values (v_shop_id, public.open_period_for(v_shop_id, date '2026-08-15'), date '2026-08-15',
              'balanced', 'manual', 'posted', v_owner_id)
      returning id into v_entry;
    insert into public.journal_lines (entry_id, account_id, amount_cents) values (v_entry, v_shrink,  84000);
    insert into public.journal_lines (entry_id, account_id, amount_cents) values (v_entry, v_cash,   -84000);
  end;

  -- 11. An UNBALANCED entry is refused, and refused for a write that never went
  -- near post_journal_entry. This is the assertion the whole design rests on.
  --
  -- SET CONSTRAINTS ... IMMEDIATE is what makes this testable inside a
  -- transaction that is going to roll back: the trigger is deferred to commit,
  -- and commit never arrives here. A flag rather than a raise-inside-a-raise,
  -- because plpgsql's exception handler cannot tell "the assertion tripped"
  -- from "the thing being asserted about tripped" when both are P0001.
  --
  -- TWO lines that do not cancel, not one line. Written with one line first,
  -- and it was a test that could not fail: assert_journal_balances refuses a
  -- single-line entry by the line-count rule before it ever reaches the sum,
  -- so the check stayed green with the balance rule commented out entirely.
  -- Found by mutation, not by reading. The line-count rule gets its own check
  -- below rather than being smuggled into this one.
  v_raised := false;
  declare
    v_bad uuid;
    v_cash uuid := (select id from public.accounts where shop_id = v_shop_id and code = '1000');
    v_shrink uuid := (select id from public.accounts where shop_id = v_shop_id and code = '5100');
  begin
    insert into public.journal_entries (shop_id, period_id, entry_date, description, source, status, created_by)
      values (v_shop_id, public.open_period_for(v_shop_id, date '2026-08-15'), date '2026-08-15',
              'unbalanced', 'manual', 'posted', v_owner_id)
      returning id into v_bad;
    insert into public.journal_lines (entry_id, account_id, amount_cents) values (v_bad, v_shrink, 84000);
    insert into public.journal_lines (entry_id, account_id, amount_cents) values (v_bad, v_cash,   -83999);
    set constraints journal_entry_balances immediate;
  exception
    when others then v_raised := true;
  end;
  if not v_raised then
    raise exception 'FAIL: an unbalanced entry was accepted';
  end if;
  set constraints all deferred;

  -- 11b. A one-line entry is refused too.
  --
  -- No single mutation turns this one red, and that is the finding rather than
  -- a defect: a lone line is caught by the line-count rule, and if that rule is
  -- removed it is caught by the sum instead, because one non-zero line cannot
  -- total zero. Two independent rules cover it. What the line-count rule buys
  -- is the MESSAGE -- "this entry needs two lines" rather than "debits and
  -- credits differ by 100", which describes the symptom of nobody having
  -- written the other side.
  --
  -- Kept because it asserts the behaviour a caller depends on. Both rules have
  -- to be disabled together before it fails, which is exactly what defence in
  -- depth is supposed to look like.
  v_raised := false;
  declare
    v_lonely uuid;
    v_cash uuid := (select id from public.accounts where shop_id = v_shop_id and code = '1000');
  begin
    insert into public.journal_entries (shop_id, period_id, entry_date, description, source, status, created_by)
      values (v_shop_id, public.open_period_for(v_shop_id, date '2026-08-15'), date '2026-08-15',
              'lonely', 'manual', 'posted', v_owner_id)
      returning id into v_lonely;
    insert into public.journal_lines (entry_id, account_id, amount_cents) values (v_lonely, v_cash, 100);
    set constraints journal_entry_balances immediate;
  exception
    when others then v_raised := true;
  end;
  if not v_raised then
    raise exception 'FAIL: a one-line entry was accepted';
  end if;
  set constraints all deferred;

  -- 12. A zero line is refused. Two zero lines would sum to zero and pass the
  -- balance check while recording nothing.
  v_raised := false;
  begin
    insert into public.journal_lines (entry_id, account_id, amount_cents)
      values ((select id from public.journal_entries where shop_id = v_shop_id and description = 'balanced'),
              (select id from public.accounts where shop_id = v_shop_id and code = '1000'), 0);
  exception
    when check_violation then v_raised := true;
  end;
  if not v_raised then
    raise exception 'FAIL: a zero-amount line was accepted';
  end if;

  -- 13. A posted entry cannot be edited. Correction is a reversing entry; an
  -- UPDATE would rewrite history and leave no trace that it had been rewritten.
  v_raised := false;
  begin
    update public.journal_entries set description = 'edited'
      where shop_id = v_shop_id and description = 'balanced';
  exception
    when sqlstate 'P0001' then
      if position('immutable' in sqlerrm) = 0 then raise; end if;
      v_raised := true;
  end;
  if not v_raised then
    raise exception 'FAIL: a posted entry was edited';
  end if;

  -- 14. Posting wrote an audit row by itself. Written by a TRIGGER rather than
  -- by the RPC, so a change made by any route -- the app, a script, direct SQL
  -- -- still lands here. Checks 10-13 above were raw inserts that never went
  -- near an RPC, which is exactly the population this has to cover.
  if not exists (
    select 1 from public.accounting_audit_log
     where shop_id = v_shop_id and subject_table = 'journal_entries' and action = 'insert'
  ) then
    raise exception 'FAIL: writing an entry wrote no audit row';
  end if;

  -- 14b. The before/after of an update is captured, not just the fact of it.
  -- "It changed" without "from what" is a log that records that something is
  -- missing without recording what.
  if not exists (
    select 1 from public.accounting_audit_log
     where shop_id = v_shop_id and subject_table = 'accounting_periods' and action = 'update'
       and before->>'status' = 'open' and after->>'status' = 'closed'
  ) then
    raise exception 'FAIL: the period close was logged without its before/after';
  end if;

  -- 15. There is no route by which a row leaves this table.
  --
  -- Asserted against pg_policies rather than by attempting a DELETE, because
  -- this script runs as the postgres superuser and RLS does not apply to it --
  -- a DELETE here would succeed no matter how the policies are written, and the
  -- check would be reporting on nothing. That is the trap this whole file has
  -- to be read for: every RLS assertion in these scripts must be a statement
  -- about the POLICY, not an attempt at the operation.
  if exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'accounting_audit_log'
       and cmd in ('DELETE', 'UPDATE', 'ALL')
  ) then
    raise exception 'FAIL: accounting_audit_log has a policy that can remove or rewrite a row';
  end if;

  -- The same, for the two ledger tables: they are written only through the
  -- RPCs, so a write policy on either would be a second door.
  if exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename in ('journal_entries', 'journal_lines')
       and cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL')
  ) then
    raise exception 'FAIL: a journal table has a write policy; the RPCs are meant to be the only door';
  end if;

  raise notice 'ALL CHECKS PASSED';
  raise exception 'rollback fixture';
exception
  when others then
    if sqlerrm = 'rollback fixture' then return; end if;
    raise;
end $$;
