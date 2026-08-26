-- transfer_funds(): moving a shop's own money, and everything it must refuse.
--
-- Every assertion here is a fact about what a database function does when
-- called with a given role and a given pair of account codes. None of it is
-- reachable from the TypeScript suite, which cannot hold a permission.
--
-- ## The figures are deliberately all different, and that is load-bearing
--
-- Roughly thirty-five mutations on this project have been no-ops, and the
-- commonest cause is a fixture where two figures coincide: a sign flip on a
-- zero, or a swap between two accounts holding the same amount, changes
-- nothing observable. So shop A opens with 500000 in the till, 120000 in the
-- bank and 40000 in Zaad -- three different numbers, none of them zero, none a
-- multiple of the 75000 transferred -- and the shop next door opens with two
-- more figures that appear nowhere in shop A. After the transfer the till reads
-- 425000 and the bank 195000; a swapped debit and credit reads 575000 and
-- 45000, which is four distinct wrong numbers rather than a silent pass.
--
-- ## What the cash flow can and cannot catch here, said plainly
--
-- cash_flow()'s proof section carries the OBSERVED movement in 1000/1010/1020/
-- 1021, reached by none of the arithmetic above it, and it is what catches a
-- sign slip elsewhere in the statement. It CANNOT catch a swapped transfer:
-- both legs are cash, so the observed movement is zero either way round. That
-- is not a weakness to be papered over, it is the property being asserted --
-- check 2 pins that a transfer leaves the proof untouched and that no residual
-- section appeared to absorb it. The swap is caught by check 1, on the two
-- accounts' own balances.
--
-- ## Two shops
--
-- Phase 3a's review removed the tenant filter from three statement functions
-- and the whole suite stayed green because no fixture had a second shop. This
-- one has one, with its own owner, its own treasurer holding budgets.manage
-- legitimately THERE, and its own float -- and check 7 archives shop A's Zaad
-- account while leaving the neighbour's alone, so a lookup that forgot which
-- shop it was asking about would find the neighbour's and post into shop A.
--
-- Deliberately ordered: every raw insert happens BEFORE `set role
-- authenticated`, because these tests run as postgres and RLS only starts
-- applying once the role is switched.

\set ON_ERROR_STOP on

do $$
declare
  v_owner       uuid := gen_random_uuid();
  v_treasurer   uuid := gen_random_uuid();   -- budgets.manage only. The door's holder.
  v_book        uuid := gen_random_uuid();   -- ledger.view + ledger.post, NO budgets.manage.
  v_till        uuid := gen_random_uuid();   -- pos.access only.
  v_owner_b     uuid := gen_random_uuid();
  v_treasurer_b uuid := gen_random_uuid();   -- budgets.manage, but next door.
  v_shop        uuid;
  v_loc         uuid;
  v_shop_b      uuid;
  v_loc_b       uuid;
  v_role        uuid;
  v_entry       uuid;
  v_today       date := public.shop_local_date();
  v_month_start date := date_trunc('month', public.shop_local_date())::date;
  v_last_start  date := (date_trunc('month', public.shop_local_date()) - interval '1 month')::date;
  v_last_end    date := (date_trunc('month', public.shop_local_date()) - interval '1 day')::date;
  v_msg         text;
  v_desc        text;
  v_date        date;
  v_src         text;
  v_amt         bigint;
  v_before      bigint;
  v_after       bigint;
  v_entries     integer;
  v_entries2    integer;
  v_rows        integer;
  v_rows2       integer;
  v_sections    text;
  v_sections2   text;
  v_accepted    text[];
  v_candidates  text[];
  v_code        text;
begin
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
    select u, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
           'verify-transfers-' || u || '@example.test', '', now(), now(), now()
      from unnest(array[v_owner, v_treasurer, v_book, v_till, v_owner_b, v_treasurer_b]) u;

  insert into public.shops (owner_id, name) values (v_owner, 'Float and Bank') returning id into v_shop;
  insert into public.shop_locations (shop_id, name, is_primary) values (v_shop, 'Main', true)
    returning id into v_loc;

  insert into public.shops (owner_id, name) values (v_owner_b, 'The Shop Next Door')
    returning id into v_shop_b;
  insert into public.shop_locations (shop_id, name, is_primary) values (v_shop_b, 'Main', true)
    returning id into v_loc_b;

  -- budgets.manage and nothing else. Not ledger.view either: the person who
  -- banks the takings is a Manager, and the default Manager holds no ledger
  -- permission at all. If this role had to hold one, the gate would be wrong.
  insert into public.roles (shop_id, name, permissions)
    values (v_shop, 'Treasury', array['budgets.manage'])
    returning id into v_role;
  insert into public.shop_members (shop_id, user_id, role_id, active)
    values (v_shop, v_treasurer, v_role, true);

  -- The OTHER half of the gate choice, and the reason check 6b exists: somebody
  -- who can write the ledger by hand and cannot use this door. Swap the gate to
  -- ledger.post and check 1 fails; swap it and delete check 6b and this person
  -- silently gains a door the design did not give them.
  insert into public.roles (shop_id, name, permissions)
    values (v_shop, 'Books', array['ledger.view', 'ledger.post'])
    returning id into v_role;
  insert into public.shop_members (shop_id, user_id, role_id, active)
    values (v_shop, v_book, v_role, true);

  insert into public.roles (shop_id, name, permissions)
    values (v_shop, 'Till Only', array['pos.access'])
    returning id into v_role;
  insert into public.shop_members (shop_id, user_id, role_id, active)
    values (v_shop, v_till, v_role, true);

  -- Next door: budgets.manage held legitimately, somewhere else.
  insert into public.roles (shop_id, name, permissions)
    values (v_shop_b, 'Treasury', array['budgets.manage', 'ledger.view'])
    returning id into v_role;
  insert into public.shop_members (shop_id, user_id, role_id, active)
    values (v_shop_b, v_treasurer_b, v_role, true);

  -- ── Floats. Posted by each shop's own owner, who holds everything. ────────
  perform set_config('request.jwt.claims', json_build_object('sub', v_owner)::text, true);
  perform set_config('role', 'authenticated', true);
  perform public.post_journal_entry(v_shop, v_today, 'Opening float',
    jsonb_build_array(
      jsonb_build_object('code', '1000', 'amount_cents',  500000),
      jsonb_build_object('code', '1010', 'amount_cents',  120000),
      jsonb_build_object('code', '1020', 'amount_cents',   40000),
      jsonb_build_object('code', '3000', 'amount_cents', -660000)), v_loc, 'manual');

  perform set_config('request.jwt.claims', json_build_object('sub', v_owner_b)::text, true);
  perform public.post_journal_entry(v_shop_b, v_today, 'Opening float',
    jsonb_build_array(
      jsonb_build_object('code', '1000', 'amount_cents',  700000),
      jsonb_build_object('code', '1010', 'amount_cents',  310000),
      jsonb_build_object('code', '3000', 'amount_cents', -1010000)), v_loc_b, 'manual');

  -- =====================================================================
  -- 1. A budgets.manage holder can bank the float, and it lands the right
  --    way round: Dr the destination, Cr the source.
  -- =====================================================================
  perform set_config('request.jwt.claims', json_build_object('sub', v_treasurer)::text, true);
  v_entry := public.transfer_funds(v_shop, '1000', '1010', 75000);

  if v_entry is null then
    raise exception 'FAIL 1: transfer_funds returned no journal entry id';
  end if;

  -- Raw table reads go back to postgres. journal_entries and journal_lines are
  -- behind RLS on ledger.view, which the treasurer deliberately does not hold
  -- -- and an RLS-filtered read returns NO ROWS rather than an error, so every
  -- assertion below would compare NULL to NULL and pass. That is exactly the
  -- shape of a no-op check.
  perform set_config('role', 'postgres', true);

  select e.entry_date, e.source, e.description into v_date, v_src, v_desc
    from public.journal_entries e where e.id = v_entry;
  if v_src is distinct from 'transfer' then
    raise exception 'FAIL 1: the entry''s source is % rather than transfer', v_src;
  end if;
  if v_date is distinct from v_today then
    raise exception 'FAIL 1: p_on defaulted to % rather than shop_local_date() %', v_date, v_today;
  end if;
  if v_desc not like 'Transferred from Cash on Hand to Bank%' then
    raise exception 'FAIL 1: the description reads "%"', v_desc;
  end if;

  -- The lines themselves, before any statement function gets involved. A
  -- statement that summed them wrongly could hide a swap; this cannot.
  select l.amount_cents into v_amt
    from public.journal_lines l
    join public.accounts a on a.id = l.account_id
   where l.entry_id = v_entry and a.code = '1010';
  if v_amt is distinct from 75000 then
    raise exception 'FAIL 1: the destination 1010 was posted % rather than a 75000 DEBIT', v_amt;
  end if;
  select l.amount_cents into v_amt
    from public.journal_lines l
    join public.accounts a on a.id = l.account_id
   where l.entry_id = v_entry and a.code = '1000';
  if v_amt is distinct from -75000 then
    raise exception 'FAIL 1: the source 1000 was posted % rather than a 75000 CREDIT', v_amt;
  end if;

  -- And on the balance sheet, read by somebody who may read it.
  perform set_config('request.jwt.claims', json_build_object('sub', v_owner)::text, true);
  perform set_config('role', 'authenticated', true);
  if (select b.amount_cents from public.balance_sheet(v_shop, v_today) b where b.code = '1000')
       is distinct from 425000 then
    raise exception 'FAIL 1: 1000 reads % after banking 75000 of a 500000 float, not 425000',
      (select b.amount_cents from public.balance_sheet(v_shop, v_today) b where b.code = '1000');
  end if;
  if (select b.amount_cents from public.balance_sheet(v_shop, v_today) b where b.code = '1010')
       is distinct from 195000 then
    raise exception 'FAIL 1: 1010 reads % after receiving 75000 onto a 120000 balance, not 195000',
      (select b.amount_cents from public.balance_sheet(v_shop, v_today) b where b.code = '1010');
  end if;
  if (select b.amount_cents from public.balance_sheet(v_shop, v_today) b where b.code = '1020')
       is distinct from 40000 then
    raise exception 'FAIL 1: 1020 was not part of the transfer and reads % rather than 40000',
      (select b.amount_cents from public.balance_sheet(v_shop, v_today) b where b.code = '1020');
  end if;

  -- The neighbour, untouched. p_shop_id is the whole tenant boundary inside a
  -- security definer function.
  perform set_config('request.jwt.claims', json_build_object('sub', v_owner_b)::text, true);
  if (select b.amount_cents from public.balance_sheet(v_shop_b, v_today) b where b.code = '1000')
       is distinct from 700000
     or (select b.amount_cents from public.balance_sheet(v_shop_b, v_today) b where b.code = '1010')
       is distinct from 310000 then
    raise exception 'FAIL 1: the neighbour''s float moved -- 1000 % / 1010 %, not 700000 / 310000',
      (select b.amount_cents from public.balance_sheet(v_shop_b, v_today) b where b.code = '1000'),
      (select b.amount_cents from public.balance_sheet(v_shop_b, v_today) b where b.code = '1010');
  end if;
  raise notice '1 OK: Dr the destination, Cr the source, dated today, source transfer';

  -- =====================================================================
  -- 2. The cash flow does not notice. Both legs are cash, so the observed
  --    movement must be identical before and after, net change must still
  --    equal it, and NO NEW SECTION may appear to absorb the difference.
  -- =====================================================================
  perform set_config('request.jwt.claims', json_build_object('sub', v_owner)::text, true);
  select c.amount_cents into v_before
    from public.cash_flow(v_shop, v_month_start, v_today) c
   where c.section = 'proof' and c.is_total;
  select count(*), string_agg(distinct c.section, ',' order by c.section) into v_rows, v_sections
    from public.cash_flow(v_shop, v_month_start, v_today) c;

  perform set_config('request.jwt.claims', json_build_object('sub', v_treasurer)::text, true);
  perform public.transfer_funds(v_shop, '1020', '1010', 5000);

  perform set_config('request.jwt.claims', json_build_object('sub', v_owner)::text, true);
  select c.amount_cents into v_after
    from public.cash_flow(v_shop, v_month_start, v_today) c
   where c.section = 'proof' and c.is_total;
  select count(*), string_agg(distinct c.section, ',' order by c.section) into v_rows2, v_sections2
    from public.cash_flow(v_shop, v_month_start, v_today) c;

  if v_after is distinct from v_before then
    raise exception 'FAIL 2: moving 5000 from Zaad to the bank changed observed cash from % to %',
      v_before, v_after;
  end if;
  select c.amount_cents into v_amt
    from public.cash_flow(v_shop, v_month_start, v_today) c where c.section = 'net_change';
  if v_amt is distinct from v_after then
    raise exception 'FAIL 2: net change % no longer equals the observed movement %', v_amt, v_after;
  end if;
  if v_rows2 <> v_rows or v_sections2 is distinct from v_sections then
    raise exception 'FAIL 2: the cash flow grew -- % rows over [%], was % rows over [%]',
      v_rows2, v_sections2, v_rows, v_sections;
  end if;
  raise notice '2 OK: a transfer is invisible to the cash flow, and it grew no section';

  -- =====================================================================
  -- 3. From and to must differ, and the refusal posts nothing.
  -- =====================================================================
  perform set_config('role', 'postgres', true);
  select count(*) into v_entries from public.journal_entries e where e.shop_id = v_shop;
  perform set_config('request.jwt.claims', json_build_object('sub', v_treasurer)::text, true);
  perform set_config('role', 'authenticated', true);
  begin
    perform public.transfer_funds(v_shop, '1000', '1000', 25000);
    raise exception 'FAIL 3: a transfer from 1000 to 1000 was accepted';
  exception
    when others then
      if sqlerrm like 'FAIL 3%' then raise; end if;
      v_msg := sqlerrm;
  end;
  if v_msg not like '%two different accounts%' then
    raise exception 'FAIL 3: refused, but with "%"', v_msg;
  end if;
  perform set_config('role', 'postgres', true);
  select count(*) into v_entries2 from public.journal_entries e where e.shop_id = v_shop;
  perform set_config('role', 'authenticated', true);
  if v_entries2 <> v_entries then
    raise exception 'FAIL 3: the refusal left % entries behind', v_entries2 - v_entries;
  end if;
  raise notice '3 OK: a transfer to itself is refused and posts nothing';

  -- =====================================================================
  -- 4. A leg that is not cash is refused, in either direction. Dr 1000 /
  --    Cr 4000 balances perfectly and invents revenue.
  -- =====================================================================
  foreach v_code in array array['4000', '1200', '1500', '2000', '6000', '1100', '3000'] loop
    begin
      perform public.transfer_funds(v_shop, v_code, '1000', 1000);
      raise exception 'FAIL 4: a transfer FROM % was accepted', v_code;
    exception
      when others then
        if sqlerrm like 'FAIL 4%' then raise; end if;
        if sqlerrm not like '%between cash accounts%' then
          raise exception 'FAIL 4: from % refused, but with "%"', v_code, sqlerrm;
        end if;
    end;
    begin
      perform public.transfer_funds(v_shop, '1000', v_code, 1000);
      raise exception 'FAIL 4: a transfer TO % was accepted', v_code;
    exception
      when others then
        if sqlerrm like 'FAIL 4%' then raise; end if;
        if sqlerrm not like '%between cash accounts%' then
          raise exception 'FAIL 4: to % refused, but with "%"', v_code, sqlerrm;
        end if;
    end;
  end loop;
  raise notice '4 OK: revenue, inventory, equipment, payables, expenses, receivables and equity are all refused';

  -- =====================================================================
  -- 5. Zero and negative are refused before journal_lines gets a say. A
  --    negative would NOT be caught downstream: it posts a perfectly
  --    balanced backwards transfer.
  -- =====================================================================
  foreach v_code in array array['0', '-50000'] loop
    begin
      perform public.transfer_funds(v_shop, '1000', '1010', v_code::integer);
      raise exception 'FAIL 5: an amount of % was accepted', v_code;
    exception
      when others then
        if sqlerrm like 'FAIL 5%' then raise; end if;
        if sqlerrm not like '%more than zero%' then
          raise exception 'FAIL 5: % refused, but with "%"', v_code, sqlerrm;
        end if;
    end;
  end loop;
  begin
    perform public.transfer_funds(v_shop, '1000', '1010', null);
    raise exception 'FAIL 5: a null amount was accepted';
  exception
    when others then
      if sqlerrm like 'FAIL 5%' then raise; end if;
      if sqlerrm not like '%more than zero%' then
        raise exception 'FAIL 5: null refused, but with "%"', sqlerrm;
      end if;
  end;
  raise notice '5 OK: zero, negative and null amounts are refused with a sentence';

  -- =====================================================================
  -- 6. The gate, in both directions. 6a is the ordinary refusal; 6b is the
  --    one that pins WHICH permission was chosen.
  -- =====================================================================
  perform set_config('request.jwt.claims', json_build_object('sub', v_till)::text, true);
  begin
    perform public.transfer_funds(v_shop, '1000', '1010', 1000);
    raise exception 'FAIL 6a: a pos.access-only cashier moved the shop''s money';
  exception
    when others then
      if sqlerrm like 'FAIL 6a%' then raise; end if;
      if sqlerrm not like '%permission to move money%' then
        raise exception 'FAIL 6a: refused, but with "%"', sqlerrm;
      end if;
  end;

  -- Holds ledger.view AND ledger.post. Can type this entry by hand all day.
  -- Cannot use this door, because this door is a cash door.
  perform set_config('request.jwt.claims', json_build_object('sub', v_book)::text, true);
  begin
    perform public.transfer_funds(v_shop, '1000', '1010', 1000);
    raise exception 'FAIL 6b: ledger.post alone opened a budgets.manage door';
  exception
    when others then
      if sqlerrm like 'FAIL 6b%' then raise; end if;
      if sqlerrm not like '%permission to move money%' then
        raise exception 'FAIL 6b: refused, but with "%"', sqlerrm;
      end if;
  end;

  -- The positive control. Without it every refusal above would go on passing
  -- against a function that raised for absolutely everyone.
  perform set_config('request.jwt.claims', json_build_object('sub', v_owner)::text, true);
  if public.transfer_funds(v_shop, '1010', '1000', 1000) is null then
    raise exception 'FAIL 6c: the owner got no entry back';
  end if;
  perform set_config('request.jwt.claims', json_build_object('sub', v_treasurer)::text, true);
  perform public.transfer_funds(v_shop, '1000', '1010', 1000);
  raise notice '6 OK: budgets.manage opens it; pos.access and ledger.post do not';

  -- =====================================================================
  -- 7. A member of the shop next door, holding budgets.manage there.
  -- =====================================================================
  perform set_config('request.jwt.claims', json_build_object('sub', v_treasurer_b)::text, true);
  begin
    perform public.transfer_funds(v_shop, '1000', '1010', 1000);
    raise exception 'FAIL 7: the neighbour''s treasurer moved this shop''s money';
  exception
    when others then
      if sqlerrm like 'FAIL 7%' then raise; end if;
      if sqlerrm not like '%permission to move money%' then
        raise exception 'FAIL 7: refused, but with "%"', sqlerrm;
      end if;
  end;
  raise notice '7 OK: budgets.manage next door is not budgets.manage here';

  -- =====================================================================
  -- 8. The accepted set is EXACTLY the four cash codes -- enumerated over
  --    every account in the chart rather than spot-checked, in both
  --    argument positions, because a guard dropped from one of the two
  --    leaves the other looking correct.
  -- =====================================================================
  -- The candidate list is read as postgres: RLS on accounts is gated on
  -- ledger.view, which the treasurer does not hold, so reading it in role would
  -- yield an EMPTY chart and a sweep over nothing -- which finds an accepted
  -- set of {} and would then need the assertion inverted to notice. Read once,
  -- as superuser, and asserted non-trivial below.
  perform set_config('role', 'postgres', true);
  select array_agg(a.code order by a.code) into v_candidates
    from public.accounts a
   where a.shop_id = v_shop and a.archived_at is null and a.code <> '1000';
  if coalesce(array_length(v_candidates, 1), 0) < 20 then
    raise exception 'FAIL 8: the sweep has only % accounts to try; the chart seeds 30',
      coalesce(array_length(v_candidates, 1), 0);
  end if;

  perform set_config('request.jwt.claims', json_build_object('sub', v_treasurer)::text, true);
  perform set_config('role', 'authenticated', true);

  v_accepted := array[]::text[];
  foreach v_code in array v_candidates loop
    begin
      perform public.transfer_funds(v_shop, '1000', v_code, 100);
      v_accepted := v_accepted || v_code;
    exception when others then null;
    end;
  end loop;
  if v_accepted is distinct from array['1010', '1020', '1021'] then
    raise exception 'FAIL 8: as a DESTINATION the chart accepts %, not 1010/1020/1021', v_accepted;
  end if;

  v_accepted := array[]::text[];
  foreach v_code in array v_candidates loop
    begin
      perform public.transfer_funds(v_shop, v_code, '1000', 100);
      v_accepted := v_accepted || v_code;
    exception when others then null;
    end;
  end loop;
  if v_accepted is distinct from array['1010', '1020', '1021'] then
    raise exception 'FAIL 8: as a SOURCE the chart accepts %, not 1010/1020/1021', v_accepted;
  end if;

  -- The two sweeps are each other's inverse -- 100 out and 100 back for every
  -- accepted code -- so every balance is where check 6 left it. Asserted rather
  -- than assumed, because the checks below read exact figures.
  perform set_config('request.jwt.claims', json_build_object('sub', v_owner)::text, true);
  if (select b.amount_cents from public.balance_sheet(v_shop, v_today) b where b.code = '1000')
       is distinct from 425000 then
    raise exception 'FAIL 8: the sweeps left 1000 at % rather than 425000',
      (select b.amount_cents from public.balance_sheet(v_shop, v_today) b where b.code = '1000');
  end if;
  raise notice '8 OK: exactly 1010, 1020 and 1021 are reachable, in both directions';

  -- =====================================================================
  -- 9. THE SHOP'S OWN chart. Shop A's Zaad account is archived; the shop
  --    next door still has one. A lookup that forgot p_shop_id finds the
  --    neighbour's and posts a transfer into an account this shop retired.
  -- =====================================================================
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims', null, true);
  update public.accounts set archived_at = now() where shop_id = v_shop and code = '1020';

  perform set_config('request.jwt.claims', json_build_object('sub', v_treasurer)::text, true);
  perform set_config('role', 'authenticated', true);
  begin
    perform public.transfer_funds(v_shop, '1000', '1020', 1000);
    raise exception 'FAIL 9: a transfer into an archived account was accepted';
  exception
    when others then
      if sqlerrm like 'FAIL 9%' then raise; end if;
      if sqlerrm not like '%No such account in this shop%' then
        raise exception 'FAIL 9: refused, but with "%"', sqlerrm;
      end if;
  end;
  raise notice '9 OK: the accounts are looked up in THIS shop''s chart';

  -- =====================================================================
  -- 10. A date in a closed month is recognised in the open one, carrying
  --     the true date and the period's status -- the answer every other
  --     posting site with a free date field gives.
  -- =====================================================================
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims', null, true);
  insert into public.accounting_periods (shop_id, starts_on, ends_on, status, closed_at)
    values (v_shop, v_last_start, v_last_end, 'closed', now());

  perform set_config('request.jwt.claims', json_build_object('sub', v_treasurer)::text, true);
  perform set_config('role', 'authenticated', true);
  v_entry := public.transfer_funds(v_shop, '1010', '1000', 9000, v_last_start + 14,
                                   'Banked the takings');

  perform set_config('role', 'postgres', true);
  select e.entry_date, e.description into v_date, v_desc
    from public.journal_entries e where e.id = v_entry;
  if v_date is distinct from v_today then
    raise exception 'FAIL 10: a transfer dated into a closed month landed on % rather than today %',
      v_date, v_today;
  end if;
  if v_desc not like '%that period is closed%' then
    raise exception 'FAIL 10: the description does not say the period was closed: "%"', v_desc;
  end if;
  if v_desc not like '%' || to_char(v_last_start + 14, 'YYYY-MM-DD') || '%' then
    raise exception 'FAIL 10: the description has lost the true date: "%"', v_desc;
  end if;
  -- The note the user typed survives all of that.
  if v_desc not like '%Banked the takings%' then
    raise exception 'FAIL 10: the note is missing from "%"', v_desc;
  end if;
  raise notice '10 OK: a closed month redirects, keeping the true date, the status and the note';

  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims', null, true);
  raise notice 'ALL CHECKS PASSED';
  raise exception 'rollback fixture';
exception
  when others then
    perform set_config('role', 'postgres', true);
    perform set_config('request.jwt.claims', null, true);
    if sqlerrm = 'rollback fixture' then return; end if;
    raise;
end $$;
