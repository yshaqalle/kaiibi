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

  -- From here on the checks go through the RPCs, which gate on
  -- has_shop_permission -> auth.uid() -> request.jwt.claims->>'sub'. Without
  -- this the owner is nobody and every call below refuses. Setting `role` also
  -- turns RLS ON, which is why every raw insert above had to come first.
  perform set_config('request.jwt.claims', json_build_object('sub', v_owner_id)::text, true);
  perform set_config('role', 'authenticated', true);

  -- 16. The happy path: two lines by account CODE, posted, balanced, numbered.
  declare v_posted uuid;
  begin
    v_posted := public.post_journal_entry(
      v_shop_id, date '2026-08-20', 'Write off damaged stock',
      '[{"code":"5100","amount_cents":84000},{"code":"1200","amount_cents":-84000}]'::jsonb
    );
    if (select status from public.journal_entries where id = v_posted) <> 'posted' then
      raise exception 'FAIL: post_journal_entry left the entry unposted';
    end if;
    if (select reference from public.journal_entries where id = v_posted) !~ '^JE-2026-\d{4}$' then
      raise exception 'FAIL: reference is not JE-YYYY-NNNN: %',
        (select reference from public.journal_entries where id = v_posted);
    end if;
    if (select count(*) from public.journal_lines where entry_id = v_posted) <> 2 then
      raise exception 'FAIL: expected two lines';
    end if;
    -- The signed amounts survived the round trip through jsonb. A cast that
    -- dropped the sign would give an entry whose lines both read as debits and
    -- whose sum is 168000, which the deferred trigger would catch -- but only
    -- at commit, and this asserts it at the door.
    if (select coalesce(sum(amount_cents), 0) from public.journal_lines where entry_id = v_posted) <> 0 then
      raise exception 'FAIL: the posted lines do not sum to zero';
    end if;
  end;

  -- 17. An unbalanced payload is refused BY THE RPC, with a message a person
  -- can act on -- not by the deferred trigger at commit, whose message is
  -- about the constraint rather than about what they typed.
  v_raised := false;
  begin
    perform public.post_journal_entry(
      v_shop_id, date '2026-08-20', 'Lopsided',
      '[{"code":"5100","amount_cents":84000},{"code":"1200","amount_cents":-1}]'::jsonb
    );
  exception
    when sqlstate 'P0001' then
      if position('balance' in sqlerrm) = 0 then raise; end if;
      v_raised := true;
  end;
  if not v_raised then
    raise exception 'FAIL: an unbalanced payload was posted';
  end if;

  -- 18. An unknown account code is refused by name. Resolving codes here rather
  -- than making the client send uuids is what lets every future posting site
  -- say '5100' and not hold a lookup.
  --
  -- Removing the guard does redden this, but not through this handler: the
  -- code resolves to null and journal_lines.account_id refuses it, so the
  -- caller gets "null value in column account_id violates not-null
  -- constraint". Which is the whole argument for the guard -- the row is
  -- refused either way, and only one of the two messages tells the person
  -- typing the entry that they mistyped an account number.
  v_raised := false;
  begin
    perform public.post_journal_entry(
      v_shop_id, date '2026-08-20', 'Nowhere',
      '[{"code":"9999","amount_cents":1},{"code":"1200","amount_cents":-1}]'::jsonb
    );
  exception
    when sqlstate 'P0001' then
      if position('9999' in sqlerrm) = 0 then raise; end if;
      v_raised := true;
  end;
  if not v_raised then
    raise exception 'FAIL: an unknown account code was posted';
  end if;

  -- 18b. A closed month refuses through the RPC too, not only through
  -- open_period_for called directly. The gate has to hold at the door people
  -- actually use.
  update public.accounting_periods set status = 'closed'
    where shop_id = v_shop_id and starts_on = date '2026-08-01';
  v_raised := false;
  begin
    perform public.post_journal_entry(
      v_shop_id, date '2026-08-20', 'Into a shut month',
      '[{"code":"5100","amount_cents":100},{"code":"1200","amount_cents":-100}]'::jsonb
    );
  exception
    when sqlstate 'P0001' then
      if position('closed' in sqlerrm) = 0 then raise; end if;
      v_raised := true;
  end;
  if not v_raised then
    raise exception 'FAIL: the RPC posted into a closed month';
  end if;
  update public.accounting_periods set status = 'open'
    where shop_id = v_shop_id and starts_on = date '2026-08-01';

  -- 19-21. Reversal: the mirror exists, both rows point at each other, and the
  -- pair nets to nothing.
  declare
    v_orig uuid;
    v_rev  uuid;
  begin
    v_orig := public.post_journal_entry(
      v_shop_id, date '2026-08-21', 'Mis-coded bill',
      '[{"code":"6400","amount_cents":9500},{"code":"2000","amount_cents":-9500}]'::jsonb
    );
    v_rev := public.reverse_journal_entry(v_orig, 'wrong expense account');

    if (select status from public.journal_entries where id = v_orig) <> 'reversed' then
      raise exception 'FAIL: the original was not marked reversed';
    end if;
    if (select reverses_entry_id from public.journal_entries where id = v_rev) <> v_orig then
      raise exception 'FAIL: the reversal does not point at its original';
    end if;
    if (select reverses_entry_id from public.journal_entries where id = v_orig) <> v_rev then
      raise exception 'FAIL: the original does not point at its reversal';
    end if;

    -- Per ACCOUNT, not over the pair as a whole.
    --
    -- Written as sum(amount_cents) over both entries first, and it was a test
    -- that could not fail: each entry balances on its own, so their combined
    -- total is zero whether or not the reversal negated anything. Copying the
    -- lines across unchanged left the check green. Found by mutation.
    --
    -- What actually has to hold is that the pair cancels ACCOUNT BY ACCOUNT --
    -- 6400 at +9500 against 6400 at -9500 -- which is the only thing that makes
    -- the correction undo the mistake rather than double it.
    if exists (
      select 1 from public.journal_lines
       where entry_id in (v_orig, v_rev)
       group by account_id
      having coalesce(sum(amount_cents), 0) <> 0
    ) then
      raise exception 'FAIL: the reversal does not cancel the original account by account';
    end if;

    -- The reversal is dated to the ORIGINAL's date, not today. A correction to
    -- August belongs in August; dating it now would leave August overstated and
    -- this month understated, and every monthly comparison after that wrong in
    -- two directions at once.
    if (select entry_date from public.journal_entries where id = v_rev) <> date '2026-08-21' then
      raise exception 'FAIL: the reversal is not dated to the original: %',
        (select entry_date from public.journal_entries where id = v_rev);
    end if;

    -- Reversing twice would create a second mirror and double the correction.
    v_raised := false;
    begin
      perform public.reverse_journal_entry(v_orig, 'again');
    exception
      when sqlstate 'P0001' then
        if position('already' in sqlerrm) = 0 then raise; end if;
        v_raised := true;
    end;
    if not v_raised then
      raise exception 'FAIL: an already-reversed entry was reversed again';
    end if;
  end;

  -- 22. delete_shop survives a shop that has traded.
  --
  -- journal_entries.location_id and journal_lines.location_id shipped with
  -- no ON DELETE (20260904000300). Almost every phase-1 manual entry left
  -- location_id null, so nothing exercised the gap until this branch (2b)
  -- made every sale, refund, settlement, delivery, count, payment and pay
  -- run stamp a real location on its entry and its lines. After that,
  -- delete_shop -- a plain `delete from shops where id = ...`
  -- (supabase/functions/platform-admin, case 'delete_shop', relying
  -- entirely on FK cascade) -- refused outright the first time a shop with
  -- history was deleted:
  --
  --   ERROR: update or delete on table "shop_locations" violates foreign
  --   key constraint "journal_lines_location_id_fkey"
  --
  -- Fixing that surfaced a second, OLDER defect one statement later:
  -- journal_lines.account_id -> accounts and journal_entries.period_id ->
  -- accounting_periods carry the same no-ON-DELETE shape and predate this
  -- branch entirely (same migration as location_id, 20260904000300) --
  -- delete_shop was already broken for any shop with even one posted entry,
  -- location or not, because account_id is NOT NULL on every line. Both
  -- were made DEFERRABLE INITIALLY DEFERRED rather than SET NULL: an
  -- account and a period are not optional dimensions the way a location is,
  -- and the row they reference is destroyed by the SAME delete_shop cascade
  -- a moment later, so the fix is WHEN the FK is checked, not what it does.
  -- See 20260908001200 for the full account.
  --
  -- A fresh shop, not v_shop_id -- this check deletes the shop it builds,
  -- and every check above and below still needs v_shop_id to exist.
  declare
    v_del_shop  uuid;
    v_del_owner uuid := gen_random_uuid();
    v_del_loc   uuid;
    v_del_entry uuid;
  begin
    -- Raw inserts need postgres, not authenticated -- RLS is on since check
    -- 16 turned it on, and neither auth.users nor a fresh shops row is
    -- reachable through it.
    perform set_config('role', 'postgres', true);
    insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
      values (v_del_owner, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
              'verify-ledger-delshop-' || v_del_owner || '@example.test', '', now(), now(), now());
    insert into public.shops (owner_id, name) values (v_del_owner, 'Deletable Shop') returning id into v_del_shop;
    insert into public.shop_locations (shop_id, name) values (v_del_shop, 'Main Branch') returning id into v_del_loc;
    perform set_config('role', 'authenticated', true);

    perform set_config('request.jwt.claims', json_build_object('sub', v_del_owner)::text, true);
    v_del_entry := public.post_journal_entry(
      v_del_shop, date '2026-08-22', 'Delete-shop fixture entry',
      '[{"code":"5100","amount_cents":42700},{"code":"1200","amount_cents":-42700}]'::jsonb,
      v_del_loc
    );
    perform set_config('request.jwt.claims', json_build_object('sub', v_owner_id)::text, true);

    -- delete_shop itself runs with the service-role key (platform-admin
    -- edge function), which bypasses RLS entirely -- back to postgres for
    -- the same reason.
    perform set_config('role', 'postgres', true);

    if (select location_id from public.journal_entries where id = v_del_entry) is distinct from v_del_loc then
      raise exception 'FAIL: fixture entry was not posted carrying a location';
    end if;

    -- THE MUTATION THAT MUST REDDEN THIS CHECK: restore
    -- journal_lines_location_id_fkey and journal_entries_location_id_fkey to
    -- plain `references shop_locations(id)` with no ON DELETE clause --
    -- 20260904000300's original text, before 20260908001200. Expected: this
    -- DELETE raises "violates foreign key constraint
    -- journal_lines_location_id_fkey" instead of succeeding. (Reverting the
    -- account_id/period_id half of 20260908001200 instead does NOT redden
    -- this check on its own -- location_id blocks first in the cascade
    -- order this fixture exercises, which is the whole reason the original
    -- bug report only ever saw the location_id error.)
    delete from public.shops where id = v_del_shop;

    -- The entry does NOT survive with location_id nulled -- it is gone,
    -- because journal_entries.shop_id cascades (20260904000300) and this
    -- whole shop went with the DELETE. That is the case this task's own
    -- instructions call out: "unless the shop cascade removes the entries
    -- entirely, in which case assert that". SET NULL's actual job is a
    -- different, narrower one -- a single branch closing while its shop and
    -- ledger live on, which check 22b exercises directly.
    if exists (select 1 from public.journal_entries where id = v_del_entry) then
      raise exception 'FAIL: the entry survived delete_shop; shop_id should have cascaded it away too';
    end if;
    if exists (select 1 from public.shop_locations where id = v_del_loc) then
      raise exception 'FAIL: the location survived delete_shop';
    end if;

    perform set_config('role', 'authenticated', true);
  end;

  -- 22b. SET NULL's actual job: one branch closes, the shop and its ledger
  -- do not. This is a live door, not a hypothetical one -- deleteLocation()
  -- (src/lib/locations.ts) is a direct `shop_locations` delete called from
  -- the "delete this branch" action in the Locations settings panel, and
  -- before this fix it would have failed with the same FK violation
  -- delete_shop did the moment the branch had ever posted. This is the only
  -- check in the file that exercises what ON DELETE SET NULL actually does,
  -- rather than only what it stops blocking.
  declare
    v_loc2   uuid;
    v_entry2 uuid;
  begin
    insert into public.shop_locations (shop_id, name) values (v_shop_id, 'Closing Branch') returning id into v_loc2;
    v_entry2 := public.post_journal_entry(
      v_shop_id, date '2026-08-22', 'Entry at the closing branch',
      '[{"code":"5100","amount_cents":51300},{"code":"1200","amount_cents":-51300}]'::jsonb,
      v_loc2
    );
    if (select location_id from public.journal_entries where id = v_entry2) is distinct from v_loc2 then
      raise exception 'FAIL: fixture entry was not posted carrying the closing branch';
    end if;
    if (select count(*) from public.journal_lines where entry_id = v_entry2 and location_id = v_loc2) <> 2 then
      raise exception 'FAIL: fixture lines were not posted carrying the closing branch';
    end if;

    delete from public.shop_locations where id = v_loc2;

    if not exists (select 1 from public.journal_entries where id = v_entry2) then
      raise exception 'FAIL: the entry vanished when only its location was deleted';
    end if;
    if (select location_id from public.journal_entries where id = v_entry2) is not null then
      raise exception 'FAIL: journal_entries.location_id did not go null';
    end if;
    if exists (select 1 from public.journal_lines where entry_id = v_entry2 and location_id is not null) then
      raise exception 'FAIL: a journal_lines row did not go null, or was dropped, when its location was deleted';
    end if;
    if (select count(*) from public.journal_lines where entry_id = v_entry2) <> 2 then
      raise exception 'FAIL: a journal_lines row vanished when its location was deleted -- CASCADE would unbalance the entry';
    end if;
  end;

  -- 23. delete_shop survives a shop that has PAID A BILL.
  --
  -- Check 22 above deletes a shop with one manual journal entry, and that is
  -- not enough: it exercises the foreign keys, not the triggers hanging off
  -- them. 20260908001000 added an AFTER DELETE trigger to `invoice_payments`
  -- and shipped in PR #74, and from that moment a platform operator could not
  -- delete any shop that had ever recorded a supplier payment:
  --
  --   ERROR: the journal entry for this payment is missing, so it cannot be
  --   reversed
  --   CONTEXT: SQL statement "delete from public.shops where id = ..."
  --
  -- `journal_entries.shop_id` and `invoices.shop_id` both cascade from `shops`,
  -- and the journal branch runs first -- so the entry the payment points at is
  -- already gone when the payment's own trigger fires. The function then raised
  -- about an inconsistency that was not one and took the whole deletion with
  -- it. The same shape as check 22's own bug, one layer up: a rule about
  -- single-row correctness that the cascade makes wrong.
  --
  -- THE MUTATION THAT MUST REDDEN THIS CHECK: in
  -- reverse_invoice_payment_entry() (20260908001600), delete the
  -- `if not exists (select 1 from public.shops where id = old.shop_id)` skip --
  -- or merely move it back below the `select * into v_old from
  -- public.journal_entries` lookup and have it read `v_old.shop_id`, which is
  -- where 20260908001000 had it. Expected either way: the DELETE below raises
  -- 'the journal entry for this payment is missing, so it cannot be reversed'.
  --
  -- Its own shop, its own owner, its own bill -- this check destroys what it
  -- builds and every check above still needs v_shop_id.
  declare
    v_paid_shop  uuid;
    v_paid_owner uuid := gen_random_uuid();
    v_paid_loc   uuid;
    v_paid_bill  uuid;
    v_paid_pay   uuid;
  begin
    -- postgres for the whole check, not authenticated: delete_shop runs from
    -- the platform-admin edge function on the service-role key, which bypasses
    -- RLS entirely, and the fixture rows (auth.users, a fresh shops row) are
    -- not reachable through RLS either. Nothing under test here is a policy.
    perform set_config('role', 'postgres', true);
    insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
      values (v_paid_owner, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
              'verify-ledger-paidbill-' || v_paid_owner || '@example.test', '', now(), now(), now());
    insert into public.shops (owner_id, name) values (v_paid_owner, 'Paid A Bill Shop')
      returning id into v_paid_shop;
    insert into public.shop_locations (shop_id, name, is_primary)
      values (v_paid_shop, 'Main', true) returning id into v_paid_loc;
    -- record_invoice_payment gates on has_shop_permission, which reads
    -- auth.uid() from this claim rather than from the database role.
    perform set_config('request.jwt.claims', json_build_object('sub', v_paid_owner)::text, true);

    insert into public.invoices (shop_id, location_id, vendor_name, invoice_number,
                                 category, issued_on, due_on, amount_cents)
      values (v_paid_shop, v_paid_loc, 'Doomed Vendor', 'DELSHOP-1', 'rent',
              public.shop_local_date() - 5, public.shop_local_date() + 10, 50000)
      returning id into v_paid_bill;
    v_paid_pay := public.record_invoice_payment(v_paid_bill, 4300, public.shop_local_date() - 2, 'zaad');

    -- Without this the check passes with the skip removed: a payment that
    -- posted nothing returns at the trigger's FIRST line and never reaches the
    -- guard at all.
    if (select journal_entry_id from public.invoice_payments where id = v_paid_pay) is null then
      raise exception 'FAIL: fixture -- the payment posted no entry, so check 23 would not reach the guard';
    end if;

    delete from public.shops where id = v_paid_shop;

    if exists (select 1 from public.shops where id = v_paid_shop) then
      raise exception 'FAIL: the shop survived its own deletion';
    end if;
    if exists (select 1 from public.invoice_payments where shop_id = v_paid_shop) then
      raise exception 'FAIL: a supplier payment outlived the shop it was made by';
    end if;
    if exists (select 1 from public.journal_entries where shop_id = v_paid_shop) then
      raise exception 'FAIL: a journal entry outlived the shop it belonged to';
    end if;

    perform set_config('request.jwt.claims', json_build_object('sub', v_owner_id)::text, true);
    perform set_config('role', 'authenticated', true);
  end;

  -- 24. delete_shop survives a shop that has traded in EVERY way that reverses
  -- an entry from a trigger -- one shop, all of them, because that is the shop
  -- a platform operator actually deletes.
  --
  -- Three functions reverse a journal entry from a trigger rather than from an
  -- RPC, which is what makes them reachable by a cascade no caller controls:
  -- reverse_expense_entry (expenses, 20260908001000),
  -- reverse_invoice_payment_entry (invoice_payments, 20260908001600) and
  -- reverse_stock_receipt_entry (stock_receipts, 20260908001500). Check 23
  -- covers the third route into the second. This one puts a delivery, a
  -- hand-entered expense, a paid bill, a sale and a pay run in ONE shop and
  -- deletes it, so no ordering between those cascade branches can be the thing
  -- that happens to be untested.
  --
  -- A REAL `vendors` ROW, not just a vendor_name: `vendors.shop_id` cascades
  -- from `shops` while `invoices.vendor_id` and `expenses.vendor_id` are ON
  -- DELETE SET NULL, so deleting this shop fires an UPDATE on `invoices` in the
  -- middle of the cascade -- which is what invoices_sync_expense listens for.
  -- A fixture with only a frozen vendor_name never reaches that branch.
  --
  -- THE MUTATION THAT MUST REDDEN THIS CHECK: delete the shop guard (`if not
  -- exists (select 1 from public.shops where id = old.shop_id) then return
  -- null; end if;`) from reverse_stock_receipt_entry() (20260908001500).
  -- Expected: check 23 above still passes and the DELETE below raises 'the
  -- journal entry for this delivery is missing, so it cannot be reversed'. The
  -- delivery is the one branch check 23's shop does not have, so this is the
  -- mutation that separates the two checks.
  --
  -- AND THE ONE THAT DOES NOT, WHICH IS WORTH RECORDING: deleting skip 2 from
  -- reverse_expense_entry() (20260908001000) reddens CHECK 23, not this one --
  -- 'the journal entry for this expense is missing, so it cannot be reversed'.
  -- Entering a bill mirrors an `expenses` row through sync_invoice_expense
  -- (20260804000300) and that row posts its own entry, so check 23's shop
  -- exercises the expense trigger as well as the payment one without ever
  -- inserting an expense. Check 24's hand-entered expense is therefore extra
  -- coverage rather than the thing that makes the expense guard tested. What
  -- this check adds over check 23 is every branch cascading in ONE statement,
  -- so no ordering between them is the one that happens never to be run.
  declare
    v_all_shop  uuid;
    v_all_owner uuid := gen_random_uuid();
    v_all_loc   uuid;
    v_all_vendor uuid;
    v_all_prod  uuid;
    v_all_recv  uuid;
    v_all_bill  uuid;
    v_all_pay   uuid;
    v_all_exp   uuid;
    v_all_sale  uuid;
    v_all_run   uuid;
    v_all_role  uuid;
    v_all_member uuid;
  begin
    perform set_config('role', 'postgres', true);
    insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
      values (v_all_owner, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
              'verify-ledger-traded-' || v_all_owner || '@example.test', '', now(), now(), now());
    insert into public.shops (owner_id, name) values (v_all_owner, 'Traded Everything Shop')
      returning id into v_all_shop;
    insert into public.shop_locations (shop_id, name, is_primary)
      values (v_all_shop, 'Main', true) returning id into v_all_loc;
    perform set_config('request.jwt.claims', json_build_object('sub', v_all_owner)::text, true);

    insert into public.vendors (shop_id, name) values (v_all_shop, 'Doomed Supplier')
      returning id into v_all_vendor;
    insert into public.products (shop_id, name, price_cents, cost_cents, stock)
      values (v_all_shop, 'Doomed Rice', 2500, null, 0) returning id into v_all_prod;

    -- A COSTED delivery. An uncosted one posts nothing and returns at
    -- reverse_stock_receipt_entry's first line, never reaching its guard.
    v_all_recv := public.receive_stock(v_all_shop, v_all_loc, jsonb_build_array(
      jsonb_build_object('product_id', v_all_prod, 'quantity', 4, 'unit_cost_cents', 1700)));
    if (select journal_entry_id from public.stock_receipts where id = v_all_recv) is null then
      raise exception 'FAIL: fixture -- the delivery posted no entry, so check 24 would not reach the delivery guard';
    end if;

    -- A bill against the real vendor, part-paid.
    insert into public.invoices (shop_id, location_id, vendor_id, vendor_name, invoice_number,
                                 category, issued_on, due_on, amount_cents)
      values (v_all_shop, v_all_loc, v_all_vendor, 'Doomed Supplier', 'TRADED-1', 'utilities',
              public.shop_local_date() - 4, public.shop_local_date() + 10, 30000)
      returning id into v_all_bill;
    v_all_pay := public.record_invoice_payment(v_all_bill, 12000, public.shop_local_date() - 1, 'cash');
    if (select journal_entry_id from public.invoice_payments where id = v_all_pay) is null then
      raise exception 'FAIL: fixture -- the payment posted no entry, so check 24 would not reach the payment guard';
    end if;

    -- A hand-entered expense, which is the row reverse_expense_entry actually
    -- reverses: a payroll-linked or count-linked one carries a NULL
    -- journal_entry_id and returns at that function's first line.
    insert into public.expenses (shop_id, location_id, amount_cents, category, payment_method,
                                 occurred_on, note, created_by)
      values (v_all_shop, v_all_loc, 7700, 'transport_delivery', 'cash',
              public.shop_local_date(), 'Doomed taxi', v_all_owner)
      returning id into v_all_exp;
    if (select journal_entry_id from public.expenses where id = v_all_exp) is null then
      raise exception 'FAIL: fixture -- the expense posted no entry, so check 24 would not reach the expense guard';
    end if;

    insert into public.product_location_stock (product_id, location_id, stock)
      values (v_all_prod, v_all_loc, 100)
      on conflict (product_id, location_id) do update set stock = 100;
    v_all_sale := public.complete_sale(
      v_all_shop,
      jsonb_build_array(jsonb_build_object('product_id', v_all_prod, 'quantity', 2, 'unit_price_cents', 2500)),
      jsonb_build_array(jsonb_build_object('method', 'cash', 'amount_cents', 5000)),
      null, null, null, null, 0, null, null, v_all_loc);
    if (select journal_entry_id from public.sales where id = v_all_sale) is null then
      raise exception 'FAIL: fixture -- the sale posted no entry';
    end if;

    insert into public.roles (shop_id, name, permissions)
      values (v_all_shop, 'Doomed Staff', array['expenses.manage']) returning id into v_all_role;
    -- The owner already has a shop_members row (20260823000000) and the table
    -- is unique on (shop_id, user_id), so this updates rather than inserts.
    update public.shop_members
       set role_id = v_all_role, active = true, full_name = 'Doomed One'
     where shop_id = v_all_shop and user_id = v_all_owner
    returning id into v_all_member;
    insert into public.payroll_runs (shop_id, location_id, period_start, period_end)
      values (v_all_shop, v_all_loc, public.shop_local_date() - 7, public.shop_local_date() - 1)
      returning id into v_all_run;
    insert into public.payroll_run_lines (payroll_run_id, shop_member_id, member_name, amount_cents)
      values (v_all_run, v_all_member, 'Doomed One', 15000);
    -- PERFORM, not assignment: post_payroll_run returns the EXPENSE id, not the
    -- run id (20260816000000).
    perform public.post_payroll_run(v_all_run);
    if (select journal_entry_id from public.payroll_runs where id = v_all_run) is null then
      raise exception 'FAIL: fixture -- the pay run posted no entry';
    end if;

    delete from public.shops where id = v_all_shop;

    if exists (select 1 from public.shops where id = v_all_shop) then
      raise exception 'FAIL: the shop survived its own deletion';
    end if;
    if exists (select 1 from public.journal_entries where shop_id = v_all_shop) then
      raise exception 'FAIL: a journal entry outlived the shop that traded it';
    end if;
    if exists (select 1 from public.expenses where shop_id = v_all_shop)
       or exists (select 1 from public.stock_receipts where shop_id = v_all_shop)
       or exists (select 1 from public.invoice_payments where shop_id = v_all_shop) then
      raise exception 'FAIL: a source row outlived the shop it belonged to';
    end if;

    perform set_config('request.jwt.claims', json_build_object('sub', v_owner_id)::text, true);
    perform set_config('role', 'authenticated', true);
  end;

  -- 25. The guard the two checks above add must not have bought their silence.
  --
  -- Standing down for a deleted shop is right; standing down for a payment
  -- whose entry has vanished while its shop is still trading is a books-do-not-
  -- tie bug going quiet. Both halves are asserted here, on a shop that lives.
  --
  --   a) deleting ONE invoice_payments row still reverses its entry -- the
  --      original goes to 'reversed', names its mirror, and the pair leaves
  --      2000 Accounts Payable back where it started.
  --   b) a payment pointing at an entry that is not there still RAISES.
  --
  -- (b) needs the foreign key on invoice_payments.journal_entry_id out of the
  -- way, because that key is precisely what makes the state unreachable in
  -- production -- which is why the raise is loud rather than plausible. Dropped
  -- inside this transaction and rolled back with the rest of the fixture.
  -- `set constraints all immediate` first: the deferred journal keys from
  -- 20260908001200 leave pending trigger events on `journal_entries`, and ALTER
  -- TABLE refuses to take its lock while any are outstanding.
  --
  -- THE MUTATION THAT MUST REDDEN THIS CHECK: in
  -- reverse_invoice_payment_entry(), replace the `raise exception 'the journal
  -- entry for this payment is missing...'` with `return null` -- the shortcut
  -- fix for check 23 that costs the loud failure. Expected: 'FAIL: a payment
  -- whose entry is genuinely missing was deleted in silence'. Checks 23 and 24
  -- both stay GREEN under that mutation, which is the whole reason this one
  -- exists. Dropping the invoice_payments_reverse_on_delete trigger instead
  -- reddens half (a): 'deleting a payment on a live shop left its entry posted'.
  declare
    v_live_loc  uuid;
    v_live_bill uuid;
    v_live_pay  uuid;
    v_live_e    uuid;
    v_live_rev  uuid;
    v_live_st   text;
    v_live_2000 bigint;
    v_orphan    uuid;
  begin
    perform set_config('role', 'postgres', true);
    insert into public.shop_locations (shop_id, name) values (v_shop_id, 'Bills Branch')
      returning id into v_live_loc;
    insert into public.invoices (shop_id, location_id, vendor_name, invoice_number,
                                 category, issued_on, due_on, amount_cents)
      values (v_shop_id, v_live_loc, 'Live Vendor', 'LIVE-1', 'rent',
              public.shop_local_date() - 3, public.shop_local_date() + 10, 60000)
      returning id into v_live_bill;
    v_live_pay := public.record_invoice_payment(v_live_bill, 5100, public.shop_local_date(), 'edahab');
    select journal_entry_id into v_live_e from public.invoice_payments where id = v_live_pay;
    if v_live_e is null then
      raise exception 'FAIL: fixture -- the live shop''s payment posted no entry';
    end if;

    -- (a) A plain DELETE of the row, which is the door the `write
    -- invoice_payments` policy leaves open and the one the trigger exists for.
    delete from public.invoice_payments where id = v_live_pay;

    select status, reverses_entry_id into v_live_st, v_live_rev
      from public.journal_entries where id = v_live_e;
    if v_live_st is distinct from 'reversed' then
      raise exception 'FAIL: deleting a payment on a live shop left its entry %', coalesce(v_live_st, 'missing');
    end if;
    if v_live_rev is null then
      raise exception 'FAIL: the reversed entry does not name the mirror that reversed it';
    end if;
    -- Measured across the pair, not per entry: a mirror that copied the lines
    -- without negating them balances just as happily on its own.
    select coalesce(sum(l.amount_cents), 0) into v_live_2000
      from public.journal_lines l join public.accounts a on a.id = l.account_id
     where l.entry_id in (v_live_e, v_live_rev) and a.code = '2000';
    if v_live_2000 <> 0 then
      raise exception 'FAIL: the payment and its reversal leave 2000 Accounts Payable at %, not 0', v_live_2000;
    end if;

    -- (b) The genuine inconsistency, which must still be loud.
    v_orphan := public.record_invoice_payment(v_live_bill, 2200, public.shop_local_date(), 'cash');
    set constraints all immediate;
    execute 'alter table public.invoice_payments drop constraint invoice_payments_journal_entry_id_fkey';
    update public.invoice_payments set journal_entry_id = gen_random_uuid() where id = v_orphan;

    v_raised := false;
    begin
      delete from public.invoice_payments where id = v_orphan;
    exception
      when others then
        if sqlerrm <> 'the journal entry for this payment is missing, so it cannot be reversed' then
          raise exception 'FAIL: expected the missing-entry raise, got: %', sqlerrm;
        end if;
        v_raised := true;
    end;
    if not v_raised then
      raise exception 'FAIL: a payment whose entry is genuinely missing was deleted in silence -- the shop-deletion guard has swallowed a real inconsistency';
    end if;

    -- 26. invoice_payments.shop_id is DERIVED, and a caller cannot write it.
    --
    -- The column is documented as "never written by a caller" and the reversal
    -- guard trusts it to say which shop a row belongs to. Nothing else enforces
    -- that: the `write invoice_payments` policy (20260804000300) is `for all`
    -- and both halves of it read the INVOICE's shop, never this row's shop_id --
    -- so an UPDATE that moves shop_id and leaves invoice_id alone passes RLS
    -- untouched. The only thing standing in front of it is the trigger, and a
    -- trigger scoped `update of invoice_id` would not even fire.
    --
    -- MUTATION (proves this check): put `of invoice_id` back on
    -- invoice_payments_set_shop. Expected: FAIL: a caller moved a payment's
    -- shop_id to another shop and it stuck.
    declare
      v_other_shop uuid;
      v_moved      uuid;
      v_after      uuid;
    begin
      insert into public.shops (owner_id, name) values (v_owner_id, 'Second Shop')
        returning id into v_other_shop;
      v_moved := public.record_invoice_payment(v_live_bill, 1300, public.shop_local_date(), 'cash');
      update public.invoice_payments set shop_id = v_other_shop where id = v_moved;
      select shop_id into v_after from public.invoice_payments where id = v_moved;
      if v_after <> v_shop_id then
        raise exception 'FAIL: a caller moved a payment''s shop_id to another shop and it stuck (now %)', v_after;
      end if;
    end;

    perform set_config('role', 'authenticated', true);
  end;

  raise notice 'ALL CHECKS PASSED';
  raise exception 'rollback fixture';
exception
  when others then
    if sqlerrm = 'rollback fixture' then return; end if;
    raise;
end $$;
