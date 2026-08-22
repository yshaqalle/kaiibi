-- End-to-end verification of the ledger against a real database.
--
-- Everything runs inside one DO block whose EXCEPTION clause rolls the whole
-- lot back, so it leaves no rows behind -- the same shape
-- verify-accounting-writes.sql uses.
--
-- What is checked here is precisely what a unit test cannot reach: the rules
-- that live in the database because the client is not what protects the books.
-- Every one of these has a comment in its migration saying why it is enforced
-- there; this is where that claim gets tested.

\set ON_ERROR_STOP on

do $$
declare
  v_user_id uuid := gen_random_uuid();
  v_other_user_id uuid := gen_random_uuid();
  v_shop_id uuid;
  v_other_shop_id uuid;
  v_location_id uuid;
  v_entry_id uuid;
  v_reversal_id uuid;
  v_asset_id uuid;
  v_bill_id uuid;
  v_transfer_id uuid;
  v_till_id uuid;
  v_bank_id uuid;
  v_cash_account uuid;
  v_equity_account uuid;
  v_loan_account uuid;
  v_count integer;
  v_seeded integer;
  v_amount integer;
  v_text text;
  v_raised boolean;
begin
  -- A user and shop to act as. auth.uid() reads request.jwt.claims->>'sub',
  -- so setting that GUC is what makes has_shop_permission() behave as it would
  -- for a signed-in owner.
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
    values (v_user_id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            'verify-ledger-' || v_user_id || '@example.test', '', now(), now(), now());
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
    values (v_other_user_id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            'verify-ledger-other-' || v_other_user_id || '@example.test', '', now(), now(), now());

  insert into public.shops (owner_id, name) values (v_user_id, 'Verify Ledger Shop') returning id into v_shop_id;
  insert into public.shops (owner_id, name) values (v_other_user_id, 'Someone Else''s Shop') returning id into v_other_shop_id;

  perform set_config('request.jwt.claims', json_build_object('sub', v_user_id)::text, true);
  perform set_config('role', 'authenticated', true);

  insert into public.shop_locations (shop_id, name, is_primary)
    values (v_shop_id, 'Verify Store', true) returning id into v_location_id;

  ------------------------------------------------------------------
  raise notice '=== 1. A new shop is given a chart of accounts ===';
  ------------------------------------------------------------------
  select count(*) into v_seeded from public.ledger_accounts where shop_id = v_shop_id;
  if v_seeded = 0 then
    raise exception 'FAIL: the shops_seed_ledger trigger did not seed a chart';
  end if;
  raise notice 'OK: % accounts seeded', v_seeded;

  -- Every seeded account is marked system, because a feed with no account to
  -- report it would vanish from the balance sheet silently.
  select count(*) into v_count from public.ledger_accounts where shop_id = v_shop_id and not is_system;
  if v_count <> 0 then raise exception 'FAIL: % seeded accounts are not marked is_system', v_count; end if;

  -- Re-seeding is a no-op. The backfill in the migration runs over every shop,
  -- including ones the trigger has already covered.
  perform public.seed_ledger_accounts(v_shop_id);
  select count(*) into v_amount from public.ledger_accounts where shop_id = v_shop_id;
  if v_amount <> v_seeded then
    raise exception 'FAIL: seeding twice left % accounts, was %', v_amount, v_seeded;
  end if;
  raise notice 'OK: seeding twice leaves % accounts, not double', v_amount;

  select id into v_cash_account from public.ledger_accounts where shop_id = v_shop_id and feed = 'cash_on_hand';
  select id into v_equity_account from public.ledger_accounts where shop_id = v_shop_id and code = '3000';
  select id into v_loan_account from public.ledger_accounts where shop_id = v_shop_id and code = '2500';
  if v_cash_account is null or v_equity_account is null or v_loan_account is null then
    raise exception 'FAIL: the default chart is missing one of 1000/3000/2500';
  end if;

  ------------------------------------------------------------------
  raise notice '=== 2. A fed account cannot carry an opening balance ===';
  ------------------------------------------------------------------
  -- The feed already reports everything the account holds, opening figure
  -- included, so an opening balance on top of it is a double count arriving
  -- through a different door.
  v_raised := false;
  begin
    update public.ledger_accounts set opening_balance_cents = 5000 where id = v_cash_account;
  exception when check_violation then
    v_raised := true;
  end;
  if not v_raised then raise exception 'FAIL: a fed account accepted an opening balance'; end if;
  raise notice 'OK: refused';

  ------------------------------------------------------------------
  raise notice '=== 3. A system account cannot be deleted ===';
  ------------------------------------------------------------------
  delete from public.ledger_accounts where id = v_cash_account;
  select count(*) into v_count from public.ledger_accounts where id = v_cash_account;
  if v_count <> 1 then raise exception 'FAIL: a system account was deleted'; end if;
  raise notice 'OK: the delete policy filtered it out';

  ------------------------------------------------------------------
  raise notice '=== 4. An unbalanced entry is refused ===';
  ------------------------------------------------------------------
  v_raised := false;
  begin
    perform public.post_journal_entry(
      v_shop_id,
      jsonb_build_array(
        jsonb_build_object('account_id', v_equity_account, 'debit_cents', 0, 'credit_cents', 10000),
        jsonb_build_object('account_id', v_loan_account, 'debit_cents', 9999, 'credit_cents', 0)
      )
    );
  exception when others then
    v_raised := true;
    v_text := sqlerrm;
  end;
  if not v_raised then raise exception 'FAIL: an unbalanced entry was posted'; end if;
  raise notice 'OK: %', v_text;

  -- And nothing was left behind. A rejected entry that leaves a header is
  -- something somebody finds later and wonders about.
  select count(*) into v_count from public.journal_entries where shop_id = v_shop_id;
  if v_count <> 0 then raise exception 'FAIL: a rejected entry left % header(s) behind', v_count; end if;
  raise notice 'OK: no header left behind';

  ------------------------------------------------------------------
  raise notice '=== 5. A fed account cannot be posted to by hand ===';
  ------------------------------------------------------------------
  -- The rule the whole hybrid rests on: credit "Cash on hand" by hand and the
  -- shop's money is counted twice, once by the journal and once by the drawer
  -- the owner went on to re-count.
  v_raised := false;
  begin
    perform public.post_journal_entry(
      v_shop_id,
      jsonb_build_array(
        jsonb_build_object('account_id', v_cash_account, 'debit_cents', 10000, 'credit_cents', 0),
        jsonb_build_object('account_id', v_equity_account, 'debit_cents', 0, 'credit_cents', 10000)
      )
    );
  exception when others then
    v_raised := true;
    v_text := sqlerrm;
  end;
  if not v_raised then raise exception 'FAIL: a line was posted against a fed account'; end if;
  raise notice 'OK: %', v_text;

  ------------------------------------------------------------------
  raise notice '=== 6. A balanced entry posts, numbered from 1 ===';
  ------------------------------------------------------------------
  v_entry_id := public.post_journal_entry(
    v_shop_id,
    jsonb_build_array(
      jsonb_build_object('account_id', v_loan_account, 'debit_cents', 0, 'credit_cents', 50000, 'memo', 'Loan drawn'),
      jsonb_build_object('account_id', v_equity_account, 'debit_cents', 50000, 'credit_cents', 0, 'memo', 'Into the business')
    ),
    '2026-08-01'::date,
    'Opening loan',
    'CHQ-001',
    v_location_id
  );
  select entry_no into v_count from public.journal_entries where id = v_entry_id;
  if v_count <> 1 then raise exception 'FAIL: first entry numbered %, expected 1', v_count; end if;
  select count(*) into v_count from public.journal_lines where entry_id = v_entry_id;
  if v_count <> 2 then raise exception 'FAIL: expected 2 lines, got %', v_count; end if;
  raise notice 'OK: JE-1 posted with 2 lines';

  ------------------------------------------------------------------
  raise notice '=== 7. Posting writes an audit entry ===';
  ------------------------------------------------------------------
  select count(*) into v_count from public.accounting_audit_log
   where shop_id = v_shop_id and entity = 'journal_entry' and action = 'post' and entity_id = v_entry_id;
  if v_count <> 1 then raise exception 'FAIL: expected 1 audit entry for the posting, got %', v_count; end if;
  select actor_name into v_text from public.accounting_audit_log
   where entity_id = v_entry_id and action = 'post';
  if v_text is null then raise exception 'FAIL: the audit entry froze no actor name'; end if;
  raise notice 'OK: logged, by %', v_text;

  ------------------------------------------------------------------
  raise notice '=== 8. The audit log is append-only, for everyone ===';
  ------------------------------------------------------------------
  -- Not "the client does not offer it": the table is granted SELECT and nothing
  -- else, and carries no update or delete policy either, so even the shop's own
  -- owner is stopped twice over. Caught rather than asserted directly, because
  -- the grant refuses before RLS ever gets a chance to filter -- and a check
  -- that only proved the second layer would pass a table that had lost the
  -- first.
  v_raised := false;
  begin
    update public.accounting_audit_log set summary = 'tampered' where shop_id = v_shop_id;
  exception when insufficient_privilege then
    v_raised := true;
  end;
  select count(*) into v_count from public.accounting_audit_log where shop_id = v_shop_id and summary = 'tampered';
  if v_count <> 0 then raise exception 'FAIL: % audit entries were rewritten', v_count; end if;
  if not v_raised then raise notice 'note: the update was filtered rather than refused outright'; end if;

  v_raised := false;
  begin
    delete from public.accounting_audit_log where shop_id = v_shop_id;
  exception when insufficient_privilege then
    v_raised := true;
  end;
  select count(*) into v_count from public.accounting_audit_log where shop_id = v_shop_id;
  if v_count = 0 then raise exception 'FAIL: the audit log was deleted'; end if;
  raise notice 'OK: % entries survived an update and a delete', v_count;

  ------------------------------------------------------------------
  raise notice '=== 9. A posted entry is reversed, never edited ===';
  ------------------------------------------------------------------
  v_reversal_id := public.reverse_journal_entry(v_entry_id, '2026-08-15'::date);
  select count(*) into v_count from public.journal_lines l
    join public.journal_entries e on e.id = l.entry_id
   where e.id = v_reversal_id and l.account_id = v_loan_account and l.debit_cents = 50000;
  if v_count <> 1 then raise exception 'FAIL: the reversal did not flip the loan line'; end if;

  -- The original is untouched. That is the whole reason a reversal exists
  -- instead of an edit: both halves stay readable.
  select credit_cents into v_amount from public.journal_lines
   where entry_id = v_entry_id and account_id = v_loan_account;
  if v_amount <> 50000 then raise exception 'FAIL: the original entry was altered'; end if;
  raise notice 'OK: reversed, original intact';

  ------------------------------------------------------------------
  raise notice '=== 10. An entry can only be reversed once ===';
  ------------------------------------------------------------------
  v_raised := false;
  begin
    perform public.reverse_journal_entry(v_entry_id, '2026-08-16'::date);
  exception when others then
    v_raised := true;
    v_text := sqlerrm;
  end;
  if not v_raised then raise exception 'FAIL: an entry was reversed twice, leaving the books out by its own amount'; end if;
  raise notice 'OK: %', v_text;

  -- And a reversal cannot itself be reversed: that re-posts the original with
  -- a third number and no way to follow the chain.
  v_raised := false;
  begin
    perform public.reverse_journal_entry(v_reversal_id, '2026-08-17'::date);
  exception when others then
    v_raised := true;
  end;
  if not v_raised then raise exception 'FAIL: a reversal was reversed'; end if;
  raise notice 'OK: a reversal cannot be reversed';

  ------------------------------------------------------------------
  raise notice '=== 11. Journal lines cannot be written directly ===';
  ------------------------------------------------------------------
  -- Both rules at the top of the journal migration would be advice otherwise:
  -- a client that can insert a line can post half an entry.
  v_raised := false;
  begin
    insert into public.journal_lines (entry_id, account_id, line_no, debit_cents, credit_cents)
      values (v_entry_id, v_equity_account, 99, 100, 0);
  exception when others then
    v_raised := true;
  end;
  if not v_raised then raise exception 'FAIL: a journal line was inserted directly'; end if;

  v_raised := false;
  begin
    update public.journal_lines set debit_cents = 1 where entry_id = v_entry_id;
  exception when insufficient_privilege then
    v_raised := true;
  end;
  select count(*) into v_count from public.journal_lines where entry_id = v_entry_id and debit_cents = 1;
  if v_count <> 0 then raise exception 'FAIL: a posted line was rewritten'; end if;
  raise notice 'OK: refused';

  ------------------------------------------------------------------
  raise notice '=== 12. An account with history cannot be deleted ===';
  ------------------------------------------------------------------
  -- `restrict`, because either alternative silently unbalances every entry the
  -- account appeared in. Archiving is what the chart offers instead.
  -- A shop-created account, so the is_system delete policy is not what refuses
  -- it. Set up OUTSIDE the exception block below, because a raise there rolls
  -- its whole subtransaction back -- including the setup, which check 19 then
  -- goes looking for.
  insert into public.ledger_accounts (shop_id, code, name, type, subtype)
    values (v_shop_id, '2510', 'Second loan', 'liability', 'long_term_liability');
  perform public.post_journal_entry(
    v_shop_id,
    jsonb_build_array(
      jsonb_build_object('account_id', (select id from public.ledger_accounts where shop_id = v_shop_id and code = '2510'), 'debit_cents', 0, 'credit_cents', 1000),
      jsonb_build_object('account_id', v_equity_account, 'debit_cents', 1000, 'credit_cents', 0)
    )
  );

  v_raised := false;
  begin
    delete from public.ledger_accounts where shop_id = v_shop_id and code = '2510';
  exception when foreign_key_violation then
    v_raised := true;
  end;
  if not v_raised then raise exception 'FAIL: an account with journal lines was deleted'; end if;
  raise notice 'OK: refused';

  ------------------------------------------------------------------
  raise notice '=== 13. A cash bill is settled the moment it is raised ===';
  ------------------------------------------------------------------
  v_bill_id := public.record_bill(
    v_shop_id, 'CASH-1', 25000, 'supplies', null, '2026-08-05'::date, 'cash',
    null, 'Corner wholesaler', null, 'Cleaning supplies', v_location_id, 'cash'
  );
  select paid_cents into v_amount from public.invoices where id = v_bill_id;
  if v_amount <> 25000 then raise exception 'FAIL: a cash bill was left % of 25000 unpaid', 25000 - v_amount; end if;
  select due_on::text into v_text from public.invoices where id = v_bill_id;
  if v_text <> '2026-08-05' then raise exception 'FAIL: a cash bill is due %, not the day it was issued', v_text; end if;
  raise notice 'OK: raised and settled in one transaction';

  -- It still posts its cost the day it was issued, exactly like a credit bill.
  select count(*) into v_count from public.expenses where invoice_id = v_bill_id and occurred_on = '2026-08-05';
  if v_count <> 1 then raise exception 'FAIL: a cash bill did not post its expense on the issue date'; end if;
  raise notice 'OK: the cost still lands on the issue date';

  -- A credit bill through the same path is NOT settled.
  v_bill_id := public.record_bill(
    v_shop_id, 'CREDIT-1', 40000, 'rent', '2026-09-01'::date, '2026-08-05'::date, 'credit',
    null, 'Landlord', null, 'August rent', v_location_id
  );
  select paid_cents into v_amount from public.invoices where id = v_bill_id;
  if v_amount <> 0 then raise exception 'FAIL: a credit bill was settled on creation'; end if;
  raise notice 'OK: a credit bill is left outstanding';

  ------------------------------------------------------------------
  raise notice '=== 14. A transfer moves both balances or neither ===';
  ------------------------------------------------------------------
  insert into public.cash_accounts (shop_id, location_id, name, account_type, balance_cents)
    values (v_shop_id, v_location_id, 'Till', 'cash', 100000) returning id into v_till_id;
  insert into public.cash_accounts (shop_id, location_id, name, account_type, balance_cents)
    values (v_shop_id, v_location_id, 'Bank', 'bank', 500000) returning id into v_bank_id;

  v_transfer_id := public.record_cash_transfer(v_till_id, v_bank_id, 40000, '2026-08-10'::date, 'SLIP-1', 'Banked the takings');
  select balance_cents into v_amount from public.cash_accounts where id = v_till_id;
  if v_amount <> 60000 then raise exception 'FAIL: the till reads % after a 40000 transfer out of 100000', v_amount; end if;
  select balance_cents into v_amount from public.cash_accounts where id = v_bank_id;
  if v_amount <> 540000 then raise exception 'FAIL: the bank reads % after a 40000 transfer into 500000', v_amount; end if;
  raise notice 'OK: both ends moved';

  -- And it named both ends in the log, which a generic trigger could not.
  select summary into v_text from public.accounting_audit_log
   where entity = 'cash_transfer' and entity_id = v_transfer_id;
  if v_text is null or v_text not like '%Till%' or v_text not like '%Bank%' then
    raise exception 'FAIL: the transfer logged "%", which names neither end', coalesce(v_text, '<nothing>');
  end if;
  raise notice 'OK: logged as "%"', v_text;

  ------------------------------------------------------------------
  raise notice '=== 15. A transfer cannot be written directly ===';
  ------------------------------------------------------------------
  -- A row written by hand records a movement that never happened, because no
  -- balance moved with it.
  v_raised := false;
  begin
    insert into public.cash_transfers (shop_id, from_account_id, to_account_id, amount_cents)
      values (v_shop_id, v_till_id, v_bank_id, 1000);
  exception when others then
    v_raised := true;
  end;
  if not v_raised then raise exception 'FAIL: a transfer row was inserted directly'; end if;
  raise notice 'OK: refused';

  ------------------------------------------------------------------
  raise notice '=== 16. Money cannot be moved between two shops ===';
  ------------------------------------------------------------------
  -- A security-definer function no longer sees RLS, so this check is the only
  -- thing standing between the two businesses.
  declare
    v_foreign_account uuid;
    v_foreign_location uuid;
  begin
    -- Set up as the OTHER owner: this user's own policies would (correctly)
    -- refuse to create a cash account in a shop they have no part in, and
    -- that refusal is not what this check is about.
    perform set_config('request.jwt.claims', json_build_object('sub', v_other_user_id)::text, true);
    insert into public.shop_locations (shop_id, name, is_primary)
      values (v_other_shop_id, 'Their Store', true) returning id into v_foreign_location;
    insert into public.cash_accounts (shop_id, location_id, name, account_type, balance_cents)
      values (v_other_shop_id, v_foreign_location, 'Their till', 'cash', 100000)
      returning id into v_foreign_account;
    perform set_config('request.jwt.claims', json_build_object('sub', v_user_id)::text, true);

    v_raised := false;
    begin
      perform public.record_cash_transfer(v_till_id, v_foreign_account, 1000);
    exception when others then
      v_raised := true;
      v_text := sqlerrm;
    end;
    if not v_raised then raise exception 'FAIL: money was moved into another business'; end if;
    raise notice 'OK: %', v_text;

    -- And nothing moved on the way to being refused.
    select balance_cents into v_amount from public.cash_accounts where id = v_till_id;
    if v_amount <> 60000 then raise exception 'FAIL: the till moved to % during a refused transfer', v_amount; end if;
  end;

  ------------------------------------------------------------------
  raise notice '=== 17. An asset cannot be worth more at the end than it cost ===';
  ------------------------------------------------------------------
  v_raised := false;
  begin
    insert into public.fixed_assets (shop_id, location_id, name, cost_cents, salvage_value_cents, useful_life_months, acquired_on)
      values (v_shop_id, v_location_id, 'Impossible fridge', 100000, 200000, 60, '2026-01-15');
  exception when check_violation then
    v_raised := true;
  end;
  if not v_raised then raise exception 'FAIL: an asset was saved with salvage above cost'; end if;
  raise notice 'OK: refused';

  insert into public.fixed_assets (shop_id, location_id, name, cost_cents, salvage_value_cents, useful_life_months, acquired_on)
    values (v_shop_id, v_location_id, 'Display fridge', 300000, 0, 60, '2026-01-15')
    returning id into v_asset_id;

  -- Proceeds only mean anything once the asset has gone. Without this a live
  -- asset could carry a sale price and the disposal report would count money
  -- nobody has received.
  v_raised := false;
  begin
    update public.fixed_assets set disposal_proceeds_cents = 50000 where id = v_asset_id;
  exception when check_violation then
    v_raised := true;
  end;
  if not v_raised then raise exception 'FAIL: a live asset accepted disposal proceeds'; end if;
  raise notice 'OK: proceeds need a disposal';

  -- A disposal before acquisition is not a thing that happened.
  v_raised := false;
  begin
    update public.fixed_assets set disposed_on = '2025-01-01' where id = v_asset_id;
  exception when check_violation then
    v_raised := true;
  end;
  if not v_raised then raise exception 'FAIL: an asset was disposed of before it was acquired'; end if;
  raise notice 'OK: refused';

  ------------------------------------------------------------------
  raise notice '=== 18. Editing a bill is logged with what moved ===';
  ------------------------------------------------------------------
  update public.invoices set amount_cents = 45000 where id = v_bill_id;
  select changes->'amount_cents'->>'to' into v_text from public.accounting_audit_log
   where entity = 'invoice' and entity_id = v_bill_id and action = 'update'
   order by occurred_at desc limit 1;
  if v_text is distinct from '45000' then
    raise exception 'FAIL: the edit logged "%" as the new amount', coalesce(v_text, '<nothing>');
  end if;
  raise notice 'OK: logged 40000 → 45000';

  -- A save that changed nothing a reader cares about writes no entry, or the
  -- log fills with "someone opened this and pressed save".
  select count(*) into v_count from public.accounting_audit_log
   where entity = 'invoice' and entity_id = v_bill_id and action = 'update';
  update public.invoices set updated_at = now() where id = v_bill_id;
  select count(*) into v_amount from public.accounting_audit_log
   where entity = 'invoice' and entity_id = v_bill_id and action = 'update';
  if v_amount <> v_count then raise exception 'FAIL: a no-op save wrote an audit entry'; end if;
  raise notice 'OK: a no-op save writes nothing';

  ------------------------------------------------------------------
  raise notice '=== 19. Posted movement rolls up per account ===';
  ------------------------------------------------------------------
  select debit_cents into v_amount from public.ledger_account_movement(v_shop_id)
   where account_id = v_equity_account;
  -- 50,000 from the loan entry, 50,000 back from its reversal, 1,000 from the
  -- second-loan entry in check 12.
  if v_amount <> 51000 then raise exception 'FAIL: equity debits roll up to %, expected 51000', v_amount; end if;
  raise notice 'OK: % debited to equity across every entry', v_amount;

  raise notice '';
  raise notice '################  ALL CHECKS PASSED  ################';

  -- Everything above is deliberately discarded: raising here rolls the
  -- enclosing block's subtransaction back, so the database is left as found.
  raise exception 'VERIFY_ROLLBACK';
exception
  when others then
    if sqlerrm = 'VERIFY_ROLLBACK' then
      raise notice 'Rolled back — no rows left behind.';
    else
      raise;
    end if;
end $$;
