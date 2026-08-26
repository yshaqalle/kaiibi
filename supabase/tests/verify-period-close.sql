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
--   NOBODY         check 14's caller: a request with no Authorization header,
--                  which has no user at all rather than a user who is a
--                  stranger. Every actor above is SIGNED IN, and that is why
--                  checks 1-13 were all green while post_journal_entry could be
--                  reached by anybody with a shop_id and no account. Being a
--                  stranger and having no identity are different tests.

\set ON_ERROR_STOP on

do $$
declare
  v_owner   uuid := gen_random_uuid();
  v_book    uuid := gen_random_uuid();
  v_strange uuid := gen_random_uuid();
  v_owner_b uuid := gen_random_uuid();
  -- Shop C exists only for check 12, whose subject is the CLOCK: its periods
  -- are measured from shop_local_date() rather than from the fixed 2026 dates
  -- the rest of this file is built on.
  v_owner_c uuid := gen_random_uuid();
  -- Shop D carries the two hand-built periods that sit ON the boundary -- one
  -- ending today, one ending yesterday. On its own shop so that neither can
  -- become the month shop C's sale opens.
  v_owner_d uuid := gen_random_uuid();
  -- A till-only member of shop A, for check 13: pos.access and nothing else.
  v_till    uuid := gen_random_uuid();
  v_role    uuid;
  v_role_till uuid;
  v_before  integer;
  v_shop    uuid;
  v_loc     uuid;
  v_shop_b  uuid;
  v_loc_b   uuid;
  v_shop_c  uuid;
  v_loc_c   uuid;
  v_shop_d  uuid;
  v_per_now uuid;
  v_per_today uuid;
  v_per_yest  uuid;
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
      from unnest(array[v_owner, v_book, v_strange, v_owner_b, v_till]) u;

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

  -- =====================================================================
  -- 12. A MONTH THAT HAS NOT ENDED CANNOT BE CLOSED.
  --
  --     This is the Critical the final review of phase 3b found: nothing
  --     stopped close_accounting_period() shutting the CURRENT month, and the
  --     screen's primary button did exactly that. A closed month is not merely
  --     shut -- phase 2b's escape from one is to REDATE the posting to today,
  --     and when the closed month is the current month "today" is inside it, so
  --     open_period_for raises and the till stops. Sales, expenses, bills,
  --     deliveries and payroll all fail at once.
  --
  --     Shop C, with periods measured from shop_local_date() rather than from
  --     the fixed 2026 dates above, because this rule is about the clock.
  --     TIMEZONE: shop_local_date() and never now()::date -- the shop's day is
  --     Africa/Mogadishu, and between midnight and 03:00 the two disagree about
  --     what day it is, and on the 1st about what MONTH it is.
  --
  --     MUTATIONS:
  --       * delete the ends_on guard          → 12a and 12b both close. Red.
  --       * `ends_on > shop_local_date()`     → 12b closes on its own last day.
  --                                             Red. (12a stays green, which is
  --                                             why 12b is here at all.)
  --       * `ends_on >= shop_local_date() + 1`→ 12c refuses. Red.
  --       * now()::date instead of the shop's → silent for 21 hours a day and
  --                                             wrong for three; not asserted
  --                                             here, see verify-shop-local-date.
  -- =====================================================================
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims', null, true);
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
    select u, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
           'verify-period-close-' || u || '@example.test', '', now(), now(), now()
      from unnest(array[v_owner_c, v_owner_d]) u;
  insert into public.shops (owner_id, name) values (v_owner_c, 'This Month''s Books') returning id into v_shop_c;
  insert into public.shop_locations (shop_id, name, is_primary) values (v_shop_c, 'Main', true)
    returning id into v_loc_c;
  insert into public.shops (owner_id, name) values (v_owner_d, 'The Boundary Itself') returning id into v_shop_d;

  --   SHOP D's two periods are shapes no calendar month could produce, inserted
  --   by hand so the boundary can be stood on exactly: one ending TODAY and one
  --   ending YESTERDAY. A real month's end lands on today only once a month, so
  --   a fixture built from open_period_for() alone could never test the `>=`.
  --   They are on their own shop so that neither can become the month shop C's
  --   sale below opens.
  insert into public.accounting_periods (shop_id, starts_on, ends_on)
    values (v_shop_d, public.shop_local_date() - 20, public.shop_local_date())
    returning id into v_per_today;
  insert into public.accounting_periods (shop_id, starts_on, ends_on)
    values (v_shop_d, public.shop_local_date() - 60, public.shop_local_date() - 1)
    returning id into v_per_yest;

  perform set_config('request.jwt.claims', json_build_object('sub', v_owner_c)::text, true);
  perform set_config('role', 'authenticated', true);

  --   The CURRENT month, opened the way anything opens one: by posting into it.
  perform public.post_journal_entry(v_shop_c, public.shop_local_date(), 'A sale today',
    jsonb_build_array(jsonb_build_object('code', '1000', 'amount_cents',  9100),
                      jsonb_build_object('code', '4000', 'amount_cents', -9100)),
    v_loc_c, 'sale');
  select id into v_per_now from public.accounting_periods
   where shop_id = v_shop_c and public.shop_local_date() between starts_on and ends_on;
  if v_per_now is null then
    raise exception 'FAIL: posting today did not open a current month for shop C, so 12a tests nothing';
  end if;

  -- 12a. The current month refuses, and says when it can be closed.
  v_ctx := null;
  begin
    perform public.close_accounting_period(v_shop_c, v_per_now);
  exception when others then v_ctx := sqlerrm;
  end;
  if v_ctx is null or v_ctx not like '%has not ended yet%' then
    raise exception 'FAIL: closing the CURRENT month was allowed (or refused for another reason): %', coalesce(v_ctx, 'no error at all');
  end if;
  --   ...and it names the day it CAN be closed, which is the whole difference
  --   between a refusal and a dead end.
  if v_ctx not like '%' || to_char((select ends_on + 1 from public.accounting_periods where id = v_per_now), 'FMDD FMMonth YYYY') || '%' then
    raise exception 'FAIL: the refusal does not name the day the month can be closed: %', v_ctx;
  end if;

  --   ...and p_force DOES NOT OVERRIDE IT. force is about closing over an
  --   outstanding checklist; there is no reading of "anyway" that makes a month
  --   which can still take a sale final.
  --   MUTATION: put the guard below the `if v_exceptions is not null and not
  --   p_force` block and gate it on p_force. Reddens here.
  v_ctx := null;
  begin
    perform public.close_accounting_period(v_shop_c, v_per_now, true);
  exception when others then v_ctx := sqlerrm;
  end;
  if v_ctx is null or v_ctx not like '%has not ended yet%' then
    raise exception 'FAIL: p_force closed the current month: %', coalesce(v_ctx, 'no error at all');
  end if;

  --   ...AND THE TILL STILL WORKS, which is the consequence the guard exists
  --   for. Without this the two refusals above could be green on a function
  --   that had simply stopped closing anything.
  perform public.post_journal_entry(v_shop_c, public.shop_local_date(), 'Another sale today',
    jsonb_build_array(jsonb_build_object('code', '1000', 'amount_cents',  4400),
                      jsonb_build_object('code', '4000', 'amount_cents', -4400)),
    v_loc_c, 'sale');

  -- 12b. A period ending TODAY refuses too: today can still take a sale.
  --      Shop D, whose two periods were built to sit on the boundary.
  perform set_config('request.jwt.claims', json_build_object('sub', v_owner_d)::text, true);
  v_ctx := null;
  begin
    perform public.close_accounting_period(v_shop_d, v_per_today);
  exception when others then v_ctx := sqlerrm;
  end;
  if v_ctx is null or v_ctx not like '%has not ended yet%' then
    raise exception 'FAIL: a period ending TODAY was closed: %', coalesce(v_ctx, 'no error at all');
  end if;

  -- 12c. A period ending YESTERDAY closes. The guard is a boundary, not a ban.
  perform public.close_accounting_period(v_shop_d, v_per_yest);
  if (select status from public.accounting_periods where id = v_per_yest) <> 'closed' then
    raise exception 'FAIL: a period that ended yesterday did not close';
  end if;
  --   ...and the period ending TODAY, on the same shop, is still open: 12b
  --   refused it rather than the close simply having stopped working.
  if (select status from public.accounting_periods where id = v_per_today) <> 'open' then
    raise exception 'FAIL: the period ending today is no longer open';
  end if;

  --   ...and shop A's own months are untouched by any of it.
  if (select status from public.accounting_periods where id = v_mar) <> 'closed'
     or (select count(*) from public.journal_entries where shop_id = v_shop_c and source = 'close') <> 0 then
    raise exception 'FAIL: shop C''s boundary checks reached shop A''s books';
  end if;

  -- =====================================================================
  -- 13. post_journal_entry() NEEDS A MEMBER OF THE SHOP, FOR EVERY SOURCE.
  --
  --     The other Critical the final review found, and it predates this branch
  --     (20260904000500): the ledger.post gate applied only when
  --     p_source = 'manual'. The function is security definer and granted to
  --     `authenticated`, so passing any other source let a logged-in stranger
  --     write entries into ANY shop. Phase 3b escalates it -- statement_lines()
  --     and cash_flow() now ignore source = 'close' while balance_sheet()
  --     subtracts its P&L side, so a forged 'close' entry moves the balance
  --     sheet while being invisible to the other two.
  --
  --     MUTATIONS:
  --       * delete the is_shop_member gate      → 13a, 13b and 13c all post. Red.
  --       * gate EVERY source on ledger.post    → 13d cannot sell. Red, and that
  --                                               is the fix that breaks the till.
  --       * drop `p_source = 'manual' and` from → 13d cannot sell. Red.
  --         the ledger.post gate
  --       * drop the ledger.post gate entirely  → 13e posts. Red.
  -- =====================================================================
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims', null, true);
  --   A till-only member of shop A: pos.access and NOTHING else. The control
  --   for 13d -- asserted rather than assumed, because a fixture that quietly
  --   handed this role ledger.post would make 13d prove nothing.
  insert into public.roles (shop_id, name, permissions)
    values (v_shop, 'Till Only', array['pos.access'])
    returning id into v_role_till;
  insert into public.shop_members (shop_id, user_id, role_id, active)
    values (v_shop, v_till, v_role_till, true);
  if public.user_has_shop_permission(v_till, v_shop, 'ledger.post') then
    raise exception 'FAIL: the fixture till user holds ledger.post, so 13d would prove nothing';
  end if;

  --   COUNTED AS postgres, not as the actor. journal_entries' RLS read policy
  --   is ledger.view, which neither the stranger nor the till user holds, so a
  --   count taken in their session is zero either way and every assertion built
  --   on it would pass without meaning anything.
  select count(*) into v_before from public.journal_entries where shop_id = v_shop;
  perform set_config('role', 'authenticated', true);

  -- 13a. A stranger -- no shop_members row anywhere -- posting a 'sale'.
  perform set_config('request.jwt.claims', json_build_object('sub', v_strange)::text, true);
  v_ctx := null;
  begin
    perform public.post_journal_entry(v_shop, public.shop_local_date(), 'Forged takings',
      jsonb_build_array(jsonb_build_object('code', '1000', 'amount_cents',  50000),
                        jsonb_build_object('code', '4000', 'amount_cents', -50000)),
      null, 'sale');
  exception when others then v_ctx := sqlerrm;
  end;
  if v_ctx is null then
    raise exception 'FAIL: a stranger posted a source = ''sale'' entry into a shop they are not a member of';
  end if;

  -- 13b. The same stranger filing it as 'close', which is the source this
  --      branch made invisible to two of the three statements.
  v_ctx := null;
  begin
    perform public.post_journal_entry(v_shop, public.shop_local_date(), 'Forged closing entry',
      jsonb_build_array(jsonb_build_object('code', '1000', 'amount_cents',  50000),
                        jsonb_build_object('code', '4000', 'amount_cents', -50000)),
      null, 'close');
  exception when others then v_ctx := sqlerrm;
  end;
  if v_ctx is null then
    raise exception 'FAIL: a stranger posted a source = ''close'' entry into a shop they are not a member of';
  end if;

  -- 13c. A REAL member -- of the WRONG shop. Membership somewhere is not
  --      membership here, and shop B's owner holds every permission in shop B.
  perform set_config('request.jwt.claims', json_build_object('sub', v_owner_b)::text, true);
  v_ctx := null;
  begin
    perform public.post_journal_entry(v_shop, public.shop_local_date(), 'Next door''s takings',
      jsonb_build_array(jsonb_build_object('code', '1000', 'amount_cents',  50000),
                        jsonb_build_object('code', '4000', 'amount_cents', -50000)),
      null, 'sale');
  exception when others then v_ctx := sqlerrm;
  end;
  if v_ctx is null then
    raise exception 'FAIL: the owner of shop B posted an entry into shop A''s books';
  end if;

  --   ...and none of the three wrote anything. A refusal that raised after the
  --   insert would pass every check above.
  perform set_config('role', 'postgres', true);
  if (select count(*) from public.journal_entries where shop_id = v_shop) <> v_before then
    raise exception 'FAIL: a refused post still wrote a journal entry';
  end if;
  perform set_config('role', 'authenticated', true);

  -- 13d. AND THE TILL STILL SELLS. A member holding pos.access and NOT
  --      ledger.post posts a 'sale' -- which is exactly what complete_sale does
  --      on their behalf. This is the check that fails if the gate is widened
  --      to every source, which is the wrong fix and the tempting one.
  perform set_config('request.jwt.claims', json_build_object('sub', v_till)::text, true);
  perform public.post_journal_entry(v_shop, public.shop_local_date(), 'Today''s takings',
    jsonb_build_array(jsonb_build_object('code', '1000', 'amount_cents',  50000),
                      jsonb_build_object('code', '4000', 'amount_cents', -50000)),
    null, 'sale');
  perform set_config('role', 'postgres', true);
  if (select count(*) from public.journal_entries where shop_id = v_shop) <> v_before + 1 then
    raise exception 'FAIL: a cashier holding pos.access and not ledger.post could not post a sale';
  end if;
  perform set_config('role', 'authenticated', true);

  -- 13e. ...and the ledger.post gate on 'manual' still bites for that same
  --      member, so 13d is not green because the gates all stopped working.
  v_ctx := null;
  begin
    perform public.post_journal_entry(v_shop, public.shop_local_date(), 'A hand-typed entry',
      jsonb_build_array(jsonb_build_object('code', '1000', 'amount_cents',  100),
                        jsonb_build_object('code', '4000', 'amount_cents', -100)),
      null, 'manual');
  exception when others then v_ctx := sqlerrm;
  end;
  if v_ctx is null or v_ctx not like '%permission to post journal entries%' then
    raise exception 'FAIL: a member without ledger.post typed a manual entry: %', coalesce(v_ctx, 'no error at all');
  end if;

  -- 14. AND THE CALLER WHO SENDS NO JWT AT ALL.
  --
  --     Check 13 tests an AUTHENTICATED stranger and an AUTHENTICATED member of
  --     the wrong shop, and that is precisely the gap 20261005000100 fell into:
  --     it gated on `auth.uid() is not null and not is_shop_member(…)`, so a
  --     caller with NO Authorization header had no uid, failed the first
  --     conjunct, and posted into any shop by id. Every check in 13 stayed
  --     green. The reproduction is in 20261005000400's header.
  --
  --     There are TWO barriers now and they are asserted separately, because a
  --     test that only proves the request fails cannot say which one held --
  --     and one of them silently doing nothing is how this got shipped twice.
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims', null, true);
  select count(*) into v_before from public.journal_entries where shop_id = v_shop;

  -- 14a. THE DOOR. `anon` is a member of PUBLIC, and PostgreSQL grants EXECUTE
  --      on every new function to PUBLIC by default. Nothing had ever revoked
  --      it, so the header's "anon HOLDS NO EXECUTE GRANT" was false for the
  --      function's whole life. It is true now because it is written down.
  if has_function_privilege('anon',
       'public.post_journal_entry(uuid,date,text,jsonb,uuid,text,boolean)', 'EXECUTE') then
    raise exception 'FAIL: anon holds EXECUTE on post_journal_entry -- the PUBLIC default grant is back';
  end if;
  if has_function_privilege('anon', 'public.open_period_for(uuid,date,boolean)', 'EXECUTE') then
    raise exception 'FAIL: anon holds EXECUTE on open_period_for -- it can open periods in any shop';
  end if;
  --      ...and the two roles that must keep it, kept it. A revoke that took
  --      the till out with it would be worse than the hole.
  if not has_function_privilege('authenticated',
       'public.post_journal_entry(uuid,date,text,jsonb,uuid,text,boolean)', 'EXECUTE') then
    raise exception 'FAIL: authenticated lost EXECUTE on post_journal_entry -- every sale in the app is now refused';
  end if;
  if not has_function_privilege('service_role',
       'public.post_journal_entry(uuid,date,text,jsonb,uuid,text,boolean)', 'EXECUTE') then
    raise exception 'FAIL: service_role lost EXECUTE on post_journal_entry';
  end if;

  -- 14b. THE GATE, tested WITHOUT the door in the way. The session is set up as
  --      PostgREST sets one up for a request carrying no Authorization header
  --      -- request.jwt.claims present, no `sub`, so auth.uid() is null --
  --      while the ROLE stays `authenticated`, which still holds EXECUTE. So
  --      this cannot pass merely because the grant is gone: it passes only if
  --      the predicate itself refuses a caller with no user. Verified over real
  --      HTTP that PostgREST sets exactly this for a header-less request.
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  perform set_config('role', 'authenticated', true);
  if auth.uid() is not null then
    raise exception 'FAIL: this fixture is not anonymous -- auth.uid() is %', auth.uid();
  end if;
  v_ctx := null;
  begin
    perform public.post_journal_entry(v_shop, public.shop_local_date(), 'Forged by nobody',
      jsonb_build_array(jsonb_build_object('code', '1000', 'amount_cents',  50000),
                        jsonb_build_object('code', '4000', 'amount_cents', -50000)),
      null, 'sale');
  exception when others then v_ctx := sqlerrm;
  end;
  if v_ctx is null or v_ctx not like '%do not have access to this shop%' then
    raise exception 'FAIL: a caller with NO JWT posted a source = ''sale'' entry into a shop: %',
      coalesce(v_ctx, 'no error at all');
  end if;

  --      The same caller filing it as 'close' -- the source balance_sheet()
  --      moves on and the other two statements ignore, which is the forgery
  --      that breaks reconciliation 5 without breaking the arithmetic.
  v_ctx := null;
  begin
    perform public.post_journal_entry(v_shop, public.shop_local_date(), 'Forged close by nobody',
      jsonb_build_array(jsonb_build_object('code', '4000', 'amount_cents',  50000),
                        jsonb_build_object('code', '3900', 'amount_cents', -50000)),
      null, 'close');
  exception when others then v_ctx := sqlerrm;
  end;
  if v_ctx is null or v_ctx not like '%do not have access to this shop%' then
    raise exception 'FAIL: a caller with NO JWT posted a source = ''close'' entry into a shop: %',
      coalesce(v_ctx, 'no error at all');
  end if;

  -- 14c. THE EXEMPTION STILL EXEMPTS, and it is the half a too-tight fix loses.
  --      A caller with no request.jwt.claims at all -- psql, a migration, or a
  --      trigger fired by one, which is how verify-entitlements and
  --      verify-inventory-permissions reach here through post_expense_to_ledger
  --      -- posts into a shop it is not a member of and MUST be allowed. A bare
  --      `not is_shop_member(…)` reddens exactly here.
  --      Note `set_config(…, null, …)`, which is how every script here stops
  --      impersonating: it leaves the GUC as the EMPTY STRING, not null. So a
  --      gate written `current_setting(…) is not null` reads this session as a
  --      PostgREST request and refuses it, and only `coalesce(…, '') <> ''`
  --      gets it right. That difference is asserted HERE and nowhere else.
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims', null, true);
  v_ctx := null;
  begin
    perform public.post_journal_entry(v_shop_b, public.shop_local_date(), 'A maintenance script''s entry',
      jsonb_build_array(jsonb_build_object('code', '1000', 'amount_cents',  1300),
                        jsonb_build_object('code', '4000', 'amount_cents', -1300)),
      null, 'sale');
  exception when others then v_ctx := sqlerrm;
  end;
  if v_ctx is not null then
    raise exception 'FAIL: a caller with no JWT at all -- a migration, a script, a superuser trigger -- was refused: %', v_ctx;
  end if;

  --      ...and neither refusal in 14b wrote anything. A gate that raises after
  --      the insert passes every assertion above.
  if (select count(*) from public.journal_entries where shop_id = v_shop) <> v_before then
    raise exception 'FAIL: a post refused for having no JWT still wrote a journal entry';
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
