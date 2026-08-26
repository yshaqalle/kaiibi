-- Closing a month, re-opening it, and the doors that stay shut.
--
-- close_accounting_period() writes the only entry in this database that is not
-- a record of anything that happened. Everything about it is therefore a rule
-- rather than an observation, and every rule below is asserted with a named
-- mutation that turns it red.
--
-- ## The fixture, and why each month is shaped as it is
--
--   March 2026   traded, and PROFITED 14700. The ordinary case.
--                It also spends 800 on leaflets and gets it refunded, so 6300's
--                balance FOR THE MONTH is exactly zero: journal_lines has
--                `check (amount_cents <> 0)`, so an account that nets to zero
--                must produce no closing line at all. Without such an account
--                in the fixture, removing the `having sum(...) <> 0` from the
--                close reddens nothing.
--   April 2026   traded, and LOST 3800. The 3900 line is a credit on a profit
--                and a DEBIT on a loss; a fixture that only ever profits cannot
--                tell those apart. It is also the month that gets re-opened.
--   May 2026     did not trade at all. Every closing line would be zero, and
--                two zero lines would sum to zero and pass the balance trigger
--                while recording nothing. It must close with NO entry.
--   June 2026    traded to EXACTLY break even: 2600 of revenue against 2600 of
--                rent. It has P&L lines, so there is an entry -- but its 3900
--                line would be zero, so there must not be one.
--
-- Every figure is distinct from every other, including the subtotals, because
-- three checks on this project have passed against a wrong implementation
-- because two numbers in a fixture happened to match.
--
-- ## The people
--
--   the owner      holds every permission, by virtue of shops.owner_id
--   the bookkeeper ledger.view and ledger.post, and NOT ledger.close. The
--                  control that matters: every refusal below has to be about
--                  ledger.close specifically, and a member holding neither
--                  cannot distinguish that from being refused for ledger.view.
--   a stranger     no membership at all
--   shop B         a second shop with its own months and its own owner. All of
--                  this is `security definer`, so the shop_id filters ARE the
--                  tenant boundary and nothing else checks them.

\set ON_ERROR_STOP on

do $$
declare
  v_owner   uuid := gen_random_uuid();
  v_book    uuid := gen_random_uuid();
  v_strange uuid := gen_random_uuid();
  v_owner_b uuid := gen_random_uuid();
  v_role    uuid;
  v_shop    uuid;
  v_loc     uuid;
  v_shop_b  uuid;
  v_loc_b   uuid;
  v_mar     uuid;
  v_apr     uuid;
  v_may     uuid;
  v_jun     uuid;
  v_mar_b   uuid;
  v_close   uuid;
  v_close2  uuid;
  v_entry   uuid;
  v_amount  bigint;
  v_status  text;
  v_draft   uuid;
  v_ctx     text;
  v_frame   text;
  v_audit   jsonb;
begin
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
    select u, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
           'verify-period-close-' || u || '@example.test', '', now(), now(), now()
      from unnest(array[v_owner, v_book, v_strange, v_owner_b]) u;

  insert into public.shops (owner_id, name) values (v_owner, 'Closing Books') returning id into v_shop;
  insert into public.shop_locations (shop_id, name, is_primary) values (v_shop, 'Main', true)
    returning id into v_loc;
  insert into public.shops (owner_id, name) values (v_owner_b, 'Next Door Books') returning id into v_shop_b;
  insert into public.shop_locations (shop_id, name, is_primary) values (v_shop_b, 'Main', true)
    returning id into v_loc_b;

  -- ledger.post but NOT ledger.close, which is the whole point of this member:
  -- somebody who may write the books but may not shut them.
  insert into public.roles (shop_id, name, permissions)
    values (v_shop, 'Bookkeeper', array['ledger.view', 'ledger.post'])
    returning id into v_role;
  insert into public.shop_members (shop_id, user_id, role_id, active)
    values (v_shop, v_book, v_role, true);

  -- A DRAFT ENTRY DATED IN MARCH, left in place for the whole file.
  --
  -- journal_entries.status DEFAULTS to 'draft', so a half-written entry is the
  -- easiest thing in this database to produce -- and the close reads
  -- `status in ('posted','reversed')` exactly as the three statements do.
  -- Deleting that filter was a silent no-op until this entry existed: the
  -- fixture had no draft, so a close that counted drafts counted nothing extra.
  -- 777000 is chosen to be unmissable; if the close saw it, March's rent
  -- account would be over-credited by it and check 3b would read -777000.
  --
  -- Written by hand rather than through post_journal_entry, which posts. This
  -- runs before `set role authenticated`, so RLS is not yet in the way -- and
  -- open_period_for is called first because a draft still needs a period.
  insert into public.journal_entries
      (shop_id, period_id, entry_date, description, source, status, created_by)
    values (v_shop, public.open_period_for(v_shop, '2026-03-25'),
            '2026-03-25', 'A March expense nobody has posted', 'manual', 'draft', v_owner)
    returning id into v_draft;
  insert into public.journal_lines (entry_id, account_id, amount_cents)
    select v_draft, a.id, 777000 from public.accounts a where a.shop_id = v_shop and a.code = '6000';
  insert into public.journal_lines (entry_id, account_id, amount_cents)
    select v_draft, a.id, -777000 from public.accounts a where a.shop_id = v_shop and a.code = '1000';

  -- Everything above this line is a raw insert, and RLS starts applying at it.
  perform set_config('request.jwt.claims', json_build_object('sub', v_owner)::text, true);
  perform set_config('role', 'authenticated', true);

  -- ── MARCH: a profit of 14700 ──────────────────────────────────────────
  perform public.post_journal_entry(v_shop, '2026-03-01', 'Owner capital, in cash',
    jsonb_build_array(jsonb_build_object('code', '1000', 'amount_cents',  60000),
                      jsonb_build_object('code', '3000', 'amount_cents', -60000)),
    v_loc, 'opening');
  perform public.post_journal_entry(v_shop, '2026-03-02', 'Stock bought for cash',
    jsonb_build_array(jsonb_build_object('code', '1200', 'amount_cents',  20000),
                      jsonb_build_object('code', '1000', 'amount_cents', -20000)),
    v_loc, 'stock');
  perform public.post_journal_entry(v_shop, '2026-03-10', 'March sales, cash',
    jsonb_build_array(jsonb_build_object('code', '1000', 'amount_cents',  31000),
                      jsonb_build_object('code', '4000', 'amount_cents', -31000)),
    v_loc, 'sale');
  perform public.post_journal_entry(v_shop, '2026-03-10', 'Cost of March sales',
    jsonb_build_array(jsonb_build_object('code', '5000', 'amount_cents',  12000),
                      jsonb_build_object('code', '1200', 'amount_cents', -12000)),
    v_loc, 'sale');
  perform public.post_journal_entry(v_shop, '2026-03-15', 'March rent',
    jsonb_build_array(jsonb_build_object('code', '6000', 'amount_cents',  4300),
                      jsonb_build_object('code', '1000', 'amount_cents', -4300)),
    v_loc);
  perform public.post_journal_entry(v_shop, '2026-03-18', 'A leaflet run',
    jsonb_build_array(jsonb_build_object('code', '6300', 'amount_cents',  800),
                      jsonb_build_object('code', '1000', 'amount_cents', -800)),
    v_loc);
  perform public.post_journal_entry(v_shop, '2026-03-19', 'The leaflet run, refunded',
    jsonb_build_array(jsonb_build_object('code', '1000', 'amount_cents',  800),
                      jsonb_build_object('code', '6300', 'amount_cents', -800)),
    v_loc);

  -- ── APRIL: a loss of 3800 ─────────────────────────────────────────────
  perform public.post_journal_entry(v_shop, '2026-04-08', 'April sale, on credit',
    jsonb_build_array(jsonb_build_object('code', '1100', 'amount_cents',  9000),
                      jsonb_build_object('code', '4000', 'amount_cents', -9000)),
    v_loc, 'sale');
  perform public.post_journal_entry(v_shop, '2026-04-08', 'Cost of the April sale',
    jsonb_build_array(jsonb_build_object('code', '5000', 'amount_cents',  3300),
                      jsonb_build_object('code', '1200', 'amount_cents', -3300)),
    v_loc, 'sale');
  perform public.post_journal_entry(v_shop, '2026-04-12', 'April utilities, on account',
    jsonb_build_array(jsonb_build_object('code', '6100', 'amount_cents',  2100),
                      jsonb_build_object('code', '2000', 'amount_cents', -2100)),
    v_loc, 'bill');
  perform public.post_journal_entry(v_shop, '2026-04-18', 'April wages, accrued',
    jsonb_build_array(jsonb_build_object('code', '6200', 'amount_cents',  7400),
                      jsonb_build_object('code', '2200', 'amount_cents', -7400)),
    v_loc, 'payroll');

  -- ── JUNE: revenue and cost that cancel exactly ────────────────────────
  perform public.post_journal_entry(v_shop, '2026-06-05', 'June sales, cash',
    jsonb_build_array(jsonb_build_object('code', '1000', 'amount_cents',  2600),
                      jsonb_build_object('code', '4000', 'amount_cents', -2600)),
    v_loc, 'sale');
  perform public.post_journal_entry(v_shop, '2026-06-25', 'June rent',
    jsonb_build_array(jsonb_build_object('code', '6000', 'amount_cents',  2600),
                      jsonb_build_object('code', '1000', 'amount_cents', -2600)),
    v_loc);

  -- ── MAY: a period row and nothing in it ──────────────────────────────
  --    open_period_for creates the row without posting anything, which is the
  --    only way to reach a month that exists and did not trade.
  v_may := public.open_period_for(v_shop, '2026-05-15');

  -- ── SHOP B ────────────────────────────────────────────────────────────
  perform set_config('request.jwt.claims', json_build_object('sub', v_owner_b)::text, true);
  perform public.post_journal_entry(v_shop_b, '2026-03-05', 'Capital, in cash',
    jsonb_build_array(jsonb_build_object('code', '1000', 'amount_cents',  88000),
                      jsonb_build_object('code', '3000', 'amount_cents', -88000)),
    v_loc_b, 'opening');
  perform public.post_journal_entry(v_shop_b, '2026-03-20', 'March rent',
    jsonb_build_array(jsonb_build_object('code', '6000', 'amount_cents',  5900),
                      jsonb_build_object('code', '1000', 'amount_cents', -5900)),
    v_loc_b);
  select id into v_mar_b from public.accounting_periods
   where shop_id = v_shop_b and starts_on = '2026-03-01';
  perform set_config('request.jwt.claims', json_build_object('sub', v_owner)::text, true);

  select id into v_mar from public.accounting_periods where shop_id = v_shop and starts_on = '2026-03-01';
  select id into v_apr from public.accounting_periods where shop_id = v_shop and starts_on = '2026-04-01';
  select id into v_jun from public.accounting_periods where shop_id = v_shop and starts_on = '2026-06-01';
  if v_mar is null or v_apr is null or v_may is null or v_jun is null or v_mar_b is null then
    raise exception 'FAIL: the fixture is missing a period -- Mar %, Apr %, May %, Jun %, other shop''s Mar %',
      v_mar, v_apr, v_may, v_jun, v_mar_b;
  end if;
  --   ...and the four months really are four different rows.
  if (select count(distinct p) from unnest(array[v_mar, v_apr, v_may, v_jun]) p) <> 4 then
    raise exception 'FAIL: the fixture''s four months are not four distinct periods';
  end if;

  -- =====================================================================
  -- 1. THE GATE. ledger.close, on both RPCs, for a member who holds
  --    ledger.view AND ledger.post and not that one.
  --
  --    Both functions are security definer, so RLS on accounting_periods and
  --    journal_entries does not apply inside them and these gates are the only
  --    thing between a bookkeeper and a month they may not shut.
  --
  --    MUTATION: delete either permission check. Both reddens here.
  -- =====================================================================
  perform set_config('request.jwt.claims', json_build_object('sub', v_book)::text, true);

  --   Sanity first: this member really is in the shop, really may post, and
  --   really may not close. Without these three lines a membership that failed
  --   to insert would produce the same green for the wrong reason.
  if not public.has_shop_permission(v_shop, 'ledger.post') then
    raise exception 'FAIL: the bookkeeper cannot post, so nothing below is testing ledger.close';
  end if;
  if public.has_shop_permission(v_shop, 'ledger.close') then
    raise exception 'FAIL: the bookkeeper holds ledger.close, so nothing below is testing anything';
  end if;

  begin
    perform public.close_accounting_period(v_shop, v_mar);
    raise exception 'FAIL: a member without ledger.close closed a period';
  exception
    when others then
      if sqlerrm like 'FAIL:%' then raise; end if;
      if sqlerrm not like '%permission to close%' then
        raise exception 'FAIL: close refused the bookkeeper, but for the wrong reason: %', sqlerrm;
      end if;
  end;
  --   re-open's gate is NOT tested here. March is still open at this point, so
  --   a re-open with the gate deleted is refused by the "already open" guard
  --   underneath it -- red, but for a reason that is not the gate. It is
  --   asserted at check 3f-bis instead, against a period that really is closed.

  --   ...and a stranger, who is refused by the same gate and not by RLS.
  perform set_config('request.jwt.claims', json_build_object('sub', v_strange)::text, true);
  begin
    perform public.close_accounting_period(v_shop, v_mar);
    raise exception 'FAIL: a stranger closed somebody else''s period';
  exception
    when others then
      if sqlerrm like 'FAIL:%' then raise; end if;
      if sqlerrm not like '%permission to close%' then
        raise exception 'FAIL: close refused a stranger, but for the wrong reason: %', sqlerrm;
      end if;
  end;

  perform set_config('request.jwt.claims', json_build_object('sub', v_owner)::text, true);

  -- =====================================================================
  -- 2. THE TENANT BOUNDARY. The owner of shop A, holding ledger.close in
  --    shop A, naming shop B's period. The permission check passes -- it asks
  --    whether the caller may close, not which period -- so the shop_id filter
  --    on the period lookup is the only thing that refuses.
  --
  --    MUTATION: drop `and shop_id = p_shop_id` from the period select in
  --    close_accounting_period. This reddens.
  -- =====================================================================
  begin
    perform public.close_accounting_period(v_shop, v_mar_b);
    raise exception 'FAIL: shop A''s owner closed shop B''s period';
  exception
    when others then
      if sqlerrm like 'FAIL:%' then raise; end if;
      if sqlerrm not like 'No such accounting period%' then
        raise exception 'FAIL: closing another shop''s period was refused, but for the wrong reason: %', sqlerrm;
      end if;
  end;
  --   ...and shop B's March is still open, which is what "refused" has to mean.
  if (select status from public.accounting_periods where id = v_mar_b) <> 'open' then
    raise exception 'FAIL: shop B''s March is no longer open after shop A tried to close it';
  end if;

  -- =====================================================================
  -- 3. THE ORDINARY CLOSE: March, which profited 14700.
  -- =====================================================================
  v_close := public.close_accounting_period(v_shop, v_mar);
  if v_close is null then
    raise exception 'FAIL: closing a month that traded returned no entry';
  end if;

  --   3a. The entry is what it claims to be.
  --       MUTATION: date it `now()` instead of v_period.ends_on. Reddens.
  if not exists (select 1 from public.journal_entries e
                  where e.id = v_close and e.shop_id = v_shop and e.source = 'close'
                    and e.status = 'posted' and e.entry_date = '2026-03-31'
                    and e.period_id = v_mar and e.reference is not null) then
    raise exception 'FAIL: the closing entry is not a posted source=''close'' entry dated 2026-03-31 in March''s period';
  end if;

  --   3b. It zeroes every P&L account for the month, and 3900 holds the result.
  --       Read straight off journal_lines, INCLUDING closing entries, because
  --       statement_lines() excludes them and cannot see the zeroing.
  --       MUTATION: drop the negation -- `sum(l.amount_cents)` for `-sum(...)`.
  --       Reddens: the accounts double instead of zeroing.
  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l
    join public.journal_entries e on e.id = l.entry_id
    join public.accounts a on a.id = l.account_id
   where e.shop_id = v_shop and e.status in ('posted', 'reversed')
     and e.entry_date between '2026-03-01' and '2026-03-31'
     and a.type in ('revenue', 'cost_of_sales', 'expense');
  if v_amount <> 0 then
    raise exception 'FAIL: March''s P&L accounts hold % after the close, expected 0 (-777000 = the close counted the draft entry)', v_amount;
  end if;
  --       ...and the draft is really there, or the status filter above is
  --       being tested against a fixture that has nothing to filter.
  if not exists (select 1 from public.journal_entries
                  where id = v_draft and status = 'draft' and entry_date = '2026-03-25') then
    raise exception 'FAIL: the fixture holds no draft entry in March, so the close''s status filter is untested';
  end if;

  --   3900, in ledger sign: a profit is a CREDIT, so negative.
  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l
    join public.journal_entries e on e.id = l.entry_id
    join public.accounts a on a.id = l.account_id
   where e.shop_id = v_shop and e.status in ('posted', 'reversed') and a.code = '3900';
  if v_amount <> -14700 then
    raise exception 'FAIL: 3900 holds % in ledger sign, expected -14700 (14700 = the sign is inverted, 0 = nothing was rolled)', v_amount;
  end if;

  --   3c. THE ZERO-BALANCE ACCOUNT. 6300 traded 800 and got it back, so its
  --       balance for March is zero and it must have NO closing line -- a zero
  --       line violates journal_lines' check constraint outright.
  --       MUTATION: remove `having sum(...) <> 0`. Reddens with
  --       `violates check constraint "journal_lines_amount_cents_check"`.
  if exists (select 1 from public.journal_lines l
               join public.accounts a on a.id = l.account_id
              where l.entry_id = v_close and a.code = '6300') then
    raise exception 'FAIL: the closing entry carries a line for 6300, whose balance for the month is zero';
  end if;
  --       ...and 6300 really did move in March, or the line above is trivially
  --       satisfied by an account nothing ever touched.
  if (select count(*) from public.journal_lines l
        join public.journal_entries e on e.id = l.entry_id
        join public.accounts a on a.id = l.account_id
       where e.shop_id = v_shop and a.code = '6300'
         and e.entry_date between '2026-03-01' and '2026-03-31') <> 2 then
    raise exception 'FAIL: 6300 did not trade to zero in March, so the having clause is untested';
  end if;

  --   3d. Every closing line is a P&L account or 3900, and nothing else. A
  --       close that touched cash or stock would still balance.
  if exists (select 1 from public.journal_lines l
               join public.accounts a on a.id = l.account_id
              where l.entry_id = v_close
                and a.type not in ('revenue', 'cost_of_sales', 'expense')
                and a.code <> '3900') then
    raise exception 'FAIL: the closing entry touches an account that is neither P&L nor 3900: %',
      (select string_agg(a.code, ', ') from public.journal_lines l
         join public.accounts a on a.id = l.account_id
        where l.entry_id = v_close and a.type not in ('revenue', 'cost_of_sales', 'expense') and a.code <> '3900');
  end if;

  --   3e. The period flipped, and recorded who and when.
  select status into v_status from public.accounting_periods where id = v_mar;
  if v_status <> 'closed' then
    raise exception 'FAIL: March is % after being closed', v_status;
  end if;
  if not exists (select 1 from public.accounting_periods
                  where id = v_mar and closed_at is not null and closed_by = v_owner) then
    raise exception 'FAIL: March closed without recording who closed it or when';
  end if;

  --   3f. THE AUDIT ROW, carrying what the table trigger cannot see: which
  --       entry closed the month and how much was rolled.
  --       MUTATION: delete the insert into accounting_audit_log. Reddens.
  select after into v_audit from public.accounting_audit_log
   where shop_id = v_shop and subject_table = 'accounting_periods' and subject_id = v_mar
     and after ? 'closing_entry_id'
   order by created_at desc limit 1;
  if v_audit is null then
    raise exception 'FAIL: closing March wrote no audit row naming the closing entry';
  end if;
  if (v_audit->>'closing_entry_id')::uuid is distinct from v_close
     or (v_audit->>'profit_rolled_cents')::bigint is distinct from 14700
     or v_audit->>'status' <> 'closed' then
    raise exception 'FAIL: the audit row says %, expected the closing entry % and 14700 rolled', v_audit, v_close;
  end if;
  --       ...and the table trigger fired as well, which is what audits a
  --       change made by anything other than this RPC.
  if not exists (select 1 from public.accounting_audit_log
                  where shop_id = v_shop and subject_table = 'accounting_periods'
                    and subject_id = v_mar and action = 'update'
                    and before->>'status' = 'open' and after->>'status' = 'closed') then
    raise exception 'FAIL: the accounting_periods trigger did not record March going from open to closed';
  end if;

  --   3f-bis. THE RE-OPEN GATE, ON A PERIOD THAT IS ACTUALLY CLOSED.
  --       Check 1 pointed the bookkeeper at March while it was still open, so
  --       deleting reopen's ledger.close gate was caught only by the "already
  --       open" guard underneath it -- red, but for the wrong reason. March is
  --       closed now, so this is the gate and nothing else.
  --       MUTATION: delete reopen's permission check. Reddens here.
  perform set_config('request.jwt.claims', json_build_object('sub', v_book)::text, true);
  begin
    perform public.reopen_accounting_period(v_shop, v_mar, 'I would like March back');
    raise exception 'FAIL: a member without ledger.close re-opened a CLOSED period';
  exception
    when others then
      if sqlerrm like 'FAIL:%' then raise; end if;
      if sqlerrm not like '%permission to re-open%' then
        raise exception 'FAIL: re-open refused the bookkeeper on a closed period, but for the wrong reason: %', sqlerrm;
      end if;
  end;
  --       ...and a stranger, at the same door.
  perform set_config('request.jwt.claims', json_build_object('sub', v_strange)::text, true);
  begin
    perform public.reopen_accounting_period(v_shop, v_mar, 'I would like March back');
    raise exception 'FAIL: a stranger re-opened somebody else''s closed period';
  exception
    when others then
      if sqlerrm like 'FAIL:%' then raise; end if;
      if sqlerrm not like '%permission to re-open%' then
        raise exception 'FAIL: re-open refused a stranger, but for the wrong reason: %', sqlerrm;
      end if;
  end;
  if (select status from public.accounting_periods where id = v_mar) <> 'closed' then
    raise exception 'FAIL: the refused re-opens left March open anyway';
  end if;
  perform set_config('request.jwt.claims', json_build_object('sub', v_owner)::text, true);

  --   3g. THE ADVISORY LOCK IS ACTUALLY TAKEN. Transaction-scoped, so it is
  --       still held here. Two taps on a Close button must not write two
  --       closing entries, and a row lock alone would not stop anything added
  --       to this function later.
  --       MUTATION: delete the pg_advisory_xact_lock call. Reddens.
  if not exists (select 1 from pg_locks
                  where locktype = 'advisory' and classid = 74922
                    and objid = hashtext(v_shop::text)::oid and granted) then
    raise exception 'FAIL: close_accounting_period did not take the per-shop advisory lock (classid 74922)';
  end if;

  -- =====================================================================
  -- 4. CLOSING A CLOSED PERIOD IS AN ERROR, NOT A NO-OP.
  --    Without the guard the second close finds every account already zero,
  --    writes nothing, returns null and flips a status that is already
  --    flipped -- which reads exactly like success.
  --    MUTATION: delete the `status = 'closed'` branch. Reddens.
  --
  --    ASSERTED ON THE FRAME AS WELL AS THE MESSAGE, and that is not belt and
  --    braces. Delete the guard and the second close does not silently
  --    succeed -- it computes March's trading again (the exclusion of
  --    source = 'close' means the first closing entry is invisible to it) and
  --    is refused DOWNSTREAM by open_period_for, which will not post into a
  --    closed month. A message-only check goes red on that, but for a reason
  --    that has nothing to do with the guard it is meant to prove. The first
  --    frame of PG_EXCEPTION_CONTEXT names the function that actually raised,
  --    which is the technique verify-statement-permissions.sql uses on the
  --    three statements' gates.
  -- =====================================================================
  begin
    perform public.close_accounting_period(v_shop, v_mar);
    raise exception 'FAIL: closing an already-closed period succeeded';
  exception
    when others then
      if sqlerrm like 'FAIL:%' then raise; end if;
      get stacked diagnostics v_ctx = pg_exception_context;
      if sqlerrm not like '%already closed%' then
        raise exception 'FAIL: the second close was refused, but for the wrong reason: %', sqlerrm;
      end if;
      v_frame := split_part(coalesce(v_ctx, ''), E'\n', 1);
      if v_frame not like 'PL/pgSQL function close_accounting_period(%' then
        raise exception 'FAIL: the second close was refused by "%", not by close_accounting_period''s own guard', v_frame;
      end if;
  end;
  --    ...and it wrote nothing. One closing entry for March, not two.
  if (select count(*) from public.journal_entries
       where shop_id = v_shop and period_id = v_mar and source = 'close') <> 1 then
    raise exception 'FAIL: March has % closing entries, expected exactly 1',
      (select count(*) from public.journal_entries where shop_id = v_shop and period_id = v_mar and source = 'close');
  end if;

  -- =====================================================================
  -- 5. A MONTH THAT DID NOT TRADE closes with NO ENTRY.
  --    Every line would be zero; journal_lines refuses a zero amount, and the
  --    two-zero-line version somebody reaches for next would sum to zero and
  --    pass the balance trigger while recording nothing.
  --    MUTATION: replace `if v_lines is null` with `if false`. Reddens with
  --    `A journal entry needs at least two lines; this one has 0.`
  -- =====================================================================
  if public.close_accounting_period(v_shop, v_may) is not null then
    raise exception 'FAIL: closing a month with no trading wrote a closing entry';
  end if;
  if exists (select 1 from public.journal_entries
              where shop_id = v_shop and period_id = v_may) then
    raise exception 'FAIL: May has journal entries, so it is not the empty month this check needs';
  end if;
  if (select status from public.accounting_periods where id = v_may) <> 'closed' then
    raise exception 'FAIL: a month with no trading did not close -- it is %',
      (select status from public.accounting_periods where id = v_may);
  end if;
  --    ...and the empty close is audited too, at zero.
  if not exists (select 1 from public.accounting_audit_log
                  where subject_id = v_may and after ? 'closing_entry_id'
                    and after->>'closing_entry_id' is null
                    and (after->>'profit_rolled_cents')::bigint = 0) then
    raise exception 'FAIL: closing an empty month wrote no audit row saying nothing was rolled';
  end if;

  -- =====================================================================
  -- 6. A MONTH THAT BROKE EVEN gets an entry with NO 3900 LINE. It has P&L
  --    lines to zero, so there is an entry -- but nothing to retain, and a
  --    zero 3900 line is refused by the same check constraint.
  --    MUTATION: append the 3900 line unconditionally (drop `if v_sum <> 0`).
  --    Reddens with the check constraint.
  -- =====================================================================
  v_entry := public.close_accounting_period(v_shop, v_jun);
  if v_entry is null then
    raise exception 'FAIL: June traded 2600 in and 2600 out; it must still get a closing entry';
  end if;
  if exists (select 1 from public.journal_lines l
               join public.accounts a on a.id = l.account_id
              where l.entry_id = v_entry and a.code = '3900') then
    raise exception 'FAIL: a break-even month''s closing entry carries a 3900 line, which would have to be zero';
  end if;
  if (select count(*) from public.journal_lines where entry_id = v_entry) <> 2 then
    raise exception 'FAIL: June''s closing entry has % lines, expected 2 (4000 and 6000)',
      (select count(*) from public.journal_lines where entry_id = v_entry);
  end if;

  -- =====================================================================
  -- 7. A LOSS PUTS A DEBIT IN 3900. April lost 3800.
  --    MUTATION: any sign slip in the 3900 line. Check 3b's profit case and
  --    this one cannot both be satisfied by an inverted sign.
  -- =====================================================================
  v_close2 := public.close_accounting_period(v_shop, v_apr);
  if v_close2 is null then
    raise exception 'FAIL: closing April returned no entry';
  end if;
  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l
    join public.accounts a on a.id = l.account_id
   where l.entry_id = v_close2 and a.code = '3900';
  if v_amount <> 3800 then
    raise exception 'FAIL: April lost 3800, so its closing entry must DEBIT 3900 by 3800; it is %', v_amount;
  end if;

  -- =====================================================================
  -- 8. RE-OPENING REVERSES, AND NEVER DELETES.
  -- =====================================================================
  --   8a. It needs a reason.
  --       MUTATION: delete the reason check. Reddens.
  begin
    perform public.reopen_accounting_period(v_shop, v_apr, '   ');
    raise exception 'FAIL: a period was re-opened with a blank reason';
  exception
    when others then
      if sqlerrm like 'FAIL:%' then raise; end if;
      if sqlerrm not like '%Say why%' then
        raise exception 'FAIL: the blank reason was refused, but for the wrong reason: %', sqlerrm;
      end if;
  end;

  perform public.reopen_accounting_period(v_shop, v_apr, 'A supplier invoice for April arrived in May');

  --   8b. The closing entry is STILL THERE, marked reversed, pointing at its
  --       mirror -- both directions, as reverse_journal_entry leaves a pair.
  --       MUTATION: delete the entry instead of reversing it. Reddens.
  if not exists (select 1 from public.journal_entries
                  where id = v_close2 and status = 'reversed' and reverses_entry_id is not null) then
    raise exception 'FAIL: April''s closing entry was not left on the record as reversed -- corrections are reversals, never edits';
  end if;

  --   8c. The reversal carries source = 'close', NOT 'manual'.
  --       This is the defect reverse_journal_entry() would have introduced:
  --       statement_lines() excludes only 'close', so a 'manual' reversal
  --       would land in the income statement as trading and April would
  --       report its loss inverted.
  --       MUTATION: file the reversal as 'manual'. Reddens here AND in
  --       verify-statements-across-a-close check 9.
  select reverses_entry_id into v_entry from public.journal_entries where id = v_close2;
  if (select source from public.journal_entries where id = v_entry) <> 'close' then
    raise exception 'FAIL: the reversal of a closing entry is filed under ''%'', not ''close'' -- the income statement reads every source but that one',
      (select source from public.journal_entries where id = v_entry);
  end if;
  if (select entry_date from public.journal_entries where id = v_entry) <> '2026-04-30' then
    raise exception 'FAIL: the reversal is dated %, not the closing entry''s own 2026-04-30',
      (select entry_date from public.journal_entries where id = v_entry);
  end if;
  --       ...and its lines really are the mirror.
  if (select coalesce(sum(amount_cents), 0) from public.journal_lines
       where entry_id in (v_close2, v_entry)) <> 0 then
    raise exception 'FAIL: the closing entry and its reversal do not cancel';
  end if;
  if (select count(*) from public.journal_lines where entry_id = v_entry) = 0 then
    raise exception 'FAIL: the reversal has no lines, so cancelling to zero proves nothing';
  end if;

  --   8d. The period is open again, and the close is forgotten.
  if not exists (select 1 from public.accounting_periods
                  where id = v_apr and status = 'open' and closed_at is null and closed_by is null) then
    raise exception 'FAIL: April is not cleanly open again -- %',
      (select row(status, closed_at is null, closed_by is null)::text
         from public.accounting_periods where id = v_apr);
  end if;

  --   8e. THE REASON SURVIVES. It is the one thing about a re-open that no
  --       trigger can see, and it is why an explicit audit row is written.
  --       MUTATION: drop `reason` from the audit insert. Reddens.
  select after into v_audit from public.accounting_audit_log
   where shop_id = v_shop and subject_id = v_apr and after ? 'reason'
   order by created_at desc limit 1;
  if v_audit is null or v_audit->>'reason' <> 'A supplier invoice for April arrived in May' then
    raise exception 'FAIL: re-opening April recorded no reason -- the audit row is %', v_audit;
  end if;
  if (v_audit->>'reversal_entry_id')::uuid is distinct from v_entry then
    raise exception 'FAIL: the audit row does not name the reversal it wrote';
  end if;

  --   8f. Re-opening an already-open period is an error.
  --       MUTATION: delete the `status = 'open'` branch. Reddens.
  begin
    perform public.reopen_accounting_period(v_shop, v_apr, 'again');
    raise exception 'FAIL: an open period was re-opened';
  exception
    when others then
      if sqlerrm like 'FAIL:%' then raise; end if;
      if sqlerrm not like '%already open%' then
        raise exception 'FAIL: re-opening an open period was refused, but for the wrong reason: %', sqlerrm;
      end if;
  end;

  --   8g. Re-opening a month that closed WITHOUT an entry flips the status and
  --       reverses nothing. May is that month.
  perform public.reopen_accounting_period(v_shop, v_may, 'May needs a late bill');
  if (select status from public.accounting_periods where id = v_may) <> 'open' then
    raise exception 'FAIL: an empty closed month could not be re-opened';
  end if;
  if exists (select 1 from public.journal_entries where shop_id = v_shop and period_id = v_may) then
    raise exception 'FAIL: re-opening an empty month invented a reversal to write';
  end if;

  --   8h. And closing April again lands on the same figure, not on double.
  --       MUTATION: drop `e.source <> 'close'` from the balance query in the
  --       close. Does NOT redden -- a reversed pair nets to zero. Stated here
  --       so a reader does not mistake this check for covering it.
  v_close2 := public.close_accounting_period(v_shop, v_apr);
  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l
    join public.journal_entries e on e.id = l.entry_id
    join public.accounts a on a.id = l.account_id
   where e.shop_id = v_shop and e.status in ('posted', 'reversed') and a.code = '3900'
     and e.entry_date between '2026-04-01' and '2026-04-30';
  if v_amount <> 3800 then
    raise exception 'FAIL: after close, re-open, close, April''s share of 3900 is %, expected 3800', v_amount;
  end if;

  -- =====================================================================
  -- 9. WHAT A CLOSED MONTH STILL ACCEPTS.
  --
  --    The design: closed blocks ordinary posting but still permits an owner
  --    to post a deliberate ADJUSTING entry dated into the month. Only locked
  --    refuses everything. Two things must be true together and neither alone
  --    is enough -- the caller has to say so, and has to hold ledger.close.
  -- =====================================================================
  --   9a. Ordinary posting into a closed month is still refused, with the
  --       message this function has always raised.
  --       MUTATION: default p_adjusting to true. Reddens here and in
  --       verify-posting-bills / verify-posting-expenses.
  begin
    perform public.post_journal_entry(v_shop, '2026-03-20', 'An ordinary March expense',
      jsonb_build_array(jsonb_build_object('code', '6100', 'amount_cents',  500),
                        jsonb_build_object('code', '1000', 'amount_cents', -500)),
      v_loc);
    raise exception 'FAIL: an ordinary entry posted into a closed month';
  exception
    when others then
      if sqlerrm like 'FAIL:%' then raise; end if;
      if sqlerrm not like 'This period is closed — posting into it is refused%' then
        raise exception 'FAIL: an ordinary entry into a closed month was refused, but for the wrong reason: %', sqlerrm;
      end if;
  end;

  --   9b. Saying so is not enough. The bookkeeper holds ledger.post and may
  --       not adjust a closed month.
  --       MUTATION: gate the adjusting path on ledger.post instead of
  --       ledger.close. Reddens.
  perform set_config('request.jwt.claims', json_build_object('sub', v_book)::text, true);
  begin
    perform public.post_journal_entry(v_shop, '2026-03-20', 'A March adjustment',
      jsonb_build_array(jsonb_build_object('code', '6100', 'amount_cents',  500),
                        jsonb_build_object('code', '1000', 'amount_cents', -500)),
      v_loc, 'manual', true);
    raise exception 'FAIL: a member holding only ledger.post adjusted a closed month';
  exception
    when others then
      if sqlerrm like 'FAIL:%' then raise; end if;
      if sqlerrm not like '%permission to post an adjusting entry%' then
        raise exception 'FAIL: the bookkeeper''s adjusting entry was refused, but for the wrong reason: %', sqlerrm;
      end if;
  end;
  perform set_config('request.jwt.claims', json_build_object('sub', v_owner)::text, true);

  --   9c. Both together: it lands, and it lands IN MARCH.
  --       MUTATION: pass p_adjusting = false through post_journal_entry.
  --       Reddens.
  v_entry := public.post_journal_entry(v_shop, '2026-03-20', 'A late March supplier invoice',
    jsonb_build_array(jsonb_build_object('code', '6100', 'amount_cents',  500),
                      jsonb_build_object('code', '2000', 'amount_cents', -500)),
    v_loc, 'bill', true);
  if not exists (select 1 from public.journal_entries
                  where id = v_entry and period_id = v_mar and entry_date = '2026-03-20') then
    raise exception 'FAIL: the adjusting entry did not land in March''s closed period';
  end if;
  --       ...and March is still closed. An adjusting entry does not re-open a
  --       month by the back door.
  if (select status from public.accounting_periods where id = v_mar) <> 'closed' then
    raise exception 'FAIL: posting an adjusting entry re-opened March';
  end if;

  -- =====================================================================
  -- 10. LOCKED REFUSES EVERYTHING, INCLUDING AN ADJUSTING ENTRY.
  --     Set by hand: nothing writes 'locked' yet, and the RLS write policy on
  --     accounting_periods permits a ledger.close holder to do it.
  --     MUTATION: fold the locked branch into the closed one. Reddens three
  --     times below.
  -- =====================================================================
  update public.accounting_periods set status = 'locked' where id = v_jun;

  begin
    perform public.post_journal_entry(v_shop, '2026-06-10', 'A June adjustment',
      jsonb_build_array(jsonb_build_object('code', '6100', 'amount_cents',  700),
                        jsonb_build_object('code', '2000', 'amount_cents', -700)),
      v_loc, 'bill', true);
    raise exception 'FAIL: an adjusting entry posted into a LOCKED month';
  exception
    when others then
      if sqlerrm like 'FAIL:%' then raise; end if;
      if sqlerrm not like 'This period is locked%' then
        raise exception 'FAIL: the locked month refused, but for the wrong reason: %', sqlerrm;
      end if;
  end;

  --     Both of these are asserted on the FRAME as well as the message, for
  --     the reason check 4 gives at length: delete close_accounting_period's
  --     locked branch and a locked month is still refused -- by
  --     open_period_for, downstream, when the closing entry tries to post into
  --     it, with a message that also says "locked". The check went green
  --     against a function that had lost its guard entirely.
  begin
    perform public.close_accounting_period(v_shop, v_jun);
    raise exception 'FAIL: a locked period was closed';
  exception
    when others then
      if sqlerrm like 'FAIL:%' then raise; end if;
      get stacked diagnostics v_ctx = pg_exception_context;
      if sqlerrm not like '%locked%' then
        raise exception 'FAIL: closing a locked period was refused, but for the wrong reason: %', sqlerrm;
      end if;
      v_frame := split_part(coalesce(v_ctx, ''), E'\n', 1);
      if v_frame not like 'PL/pgSQL function close_accounting_period(%' then
        raise exception 'FAIL: the locked period was refused by "%", not by close_accounting_period''s own guard -- it has none', v_frame;
      end if;
  end;

  begin
    perform public.reopen_accounting_period(v_shop, v_jun, 'let me back in');
    raise exception 'FAIL: a locked period was re-opened';
  exception
    when others then
      if sqlerrm like 'FAIL:%' then raise; end if;
      get stacked diagnostics v_ctx = pg_exception_context;
      if sqlerrm not like '%locked%' then
        raise exception 'FAIL: re-opening a locked period was refused, but for the wrong reason: %', sqlerrm;
      end if;
      v_frame := split_part(coalesce(v_ctx, ''), E'\n', 1);
      if v_frame not like 'PL/pgSQL function reopen_accounting_period(%' then
        raise exception 'FAIL: the locked period''s re-open was refused by "%", not by reopen_accounting_period''s own guard', v_frame;
      end if;
  end;

  -- =====================================================================
  -- 11. AND SHOP B IS UNTOUCHED BY EVERY CLOSE ABOVE. Its March never closed,
  --     its 3900 never moved, and its books never reached shop A's closing
  --     entries.
  --     MUTATION: drop `e.shop_id = p_shop_id` AND `a.shop_id = p_shop_id`
  --     together from the balance query. Either alone confines the result --
  --     an account belongs to exactly one shop -- so both must go, and then
  --     this reddens.
  -- =====================================================================
  perform set_config('request.jwt.claims', json_build_object('sub', v_owner_b)::text, true);
  if (select status from public.accounting_periods where id = v_mar_b) <> 'open' then
    raise exception 'FAIL: shop B''s March closed while shop A was closing its own months';
  end if;
  if (select coalesce(sum(l.amount_cents), 0) from public.journal_lines l
        join public.journal_entries e on e.id = l.entry_id
        join public.accounts a on a.id = l.account_id
       where e.shop_id = v_shop_b and a.code = '3900') <> 0 then
    raise exception 'FAIL: shop B''s retained earnings moved when shop A closed a month';
  end if;
  if (select count(*) from public.journal_entries where shop_id = v_shop_b and source = 'close') <> 0 then
    raise exception 'FAIL: shop A''s close wrote an entry into shop B''s books';
  end if;
  --   ...and shop B can still close its own March, on its OWN figure: a loss
  --   of 5900, so a DEBIT of 5900 to 3900.
  perform public.close_accounting_period(v_shop_b, v_mar_b);
  if (select coalesce(sum(l.amount_cents), 0) from public.journal_lines l
        join public.journal_entries e on e.id = l.entry_id
        join public.accounts a on a.id = l.account_id
       where e.shop_id = v_shop_b and a.code = '3900') <> 5900 then
    raise exception 'FAIL: shop B''s 3900 is %, expected a debit of 5900 -- shop A''s 14700 has leaked in if it reads otherwise',
      (select coalesce(sum(l.amount_cents), 0) from public.journal_lines l
         join public.journal_entries e on e.id = l.entry_id
         join public.accounts a on a.id = l.account_id
        where e.shop_id = v_shop_b and a.code = '3900');
  end if;

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
