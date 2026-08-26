-- What a close is unhappy about, and the months that close by themselves.
--
-- Companion to verify-period-close.sql, which owns the closing entry's
-- arithmetic. This file owns period_exceptions(), the p_force door in front of
-- it, and close_due_periods()/list_accounting_periods().
--
-- SEPARATE FILE, not an extension of verify-period-close.sql, and deliberately.
-- Every exception here is triggered by fixture data -- a product, a location, a
-- draft pay run -- and stock_count_missing fires on the ABSENCE of a stock
-- count, so a single product added to that file's shop would make every one of
-- its dozen closes start refusing for want of p_force. Its fixture is built to
-- say one thing about the arithmetic of a close; this one is built to say a
-- different thing about the checklist around it, and merging them would make
-- each harder to read for no gain.
--
-- ## The shops, and what each is for
--
--   E "Exception Books"     the shop under test. March 2026 has one of every
--                           exception; April 2026 has none, which is the case
--                           that proves the checks can go quiet. Set to 'ask',
--                           so nothing closes behind the tests' back.
--   F "Next Door Exceptions" THE SAME EXCEPTIONS, IN DIFFERENT NUMBERS -- 2
--                           draft runs, 3 uncounted locations, 2 open tills
--                           against E's 1, 1, 1. Every count below is therefore
--                           wrong in a visible way if any shop_id filter is
--                           dropped, which is the failure phase 3a shipped:
--                           removing a shop_id from three functions passed the
--                           whole suite because no fixture had two shops.
--                           Also the shop that gets SUSPENDED at the end, which
--                           is the only way in this database to take the
--                           inventory module away from a shop that has stock.
--   G "Sleepy Books"        auto-close. A month two calendar months back, which
--                           is past its grace on any day of any year, and the
--                           current month, which is not. Carries a member with
--                           ledger.view and NOT ledger.close: the read must
--                           answer them and must close nothing.
--   H "Grace Books"         one hand-made period ending exactly SEVEN days ago.
--                           Seven is inside a grace of ten and outside a grace
--                           of five, which is the only way to prove the shop's
--                           column is read rather than the number 10 typed
--                           into the query. Also where 'never' and 'ask' are
--                           tested.
--
-- ## Why the months are picked the way they are
--
-- E and F use fixed dates in 2026 because their assertions are about content,
-- not about time. G and H are RELATIVE TO TODAY, because they assert what is
-- due -- and a fixture that hardcodes a month is a fixture that starts failing
-- on a particular Tuesday. G's due month is `today - 2 months`, whose end is at
-- least 31 days before the start of this month, so it is past even a 15-day
-- grace on the 1st of the month. G's not-due month is the CURRENT one, whose
-- end is today or later, so it is not due under even a 5-day grace. Neither
-- depends on the day of the month, which is the trap: a fixture ten days old
-- so that two dates coincided has already produced a false green here.

\set ON_ERROR_STOP on

do $$
declare
  v_own_e   uuid := gen_random_uuid();
  v_own_f   uuid := gen_random_uuid();
  v_own_g   uuid := gen_random_uuid();
  v_own_h   uuid := gen_random_uuid();
  v_viewer  uuid := gen_random_uuid();
  v_strange uuid := gen_random_uuid();
  v_role    uuid;

  v_e uuid; v_f uuid; v_g uuid; v_h uuid;
  v_e_front uuid; v_e_back uuid; v_e_new uuid; v_e_old uuid;
  v_f_loc uuid; v_g_loc uuid; v_h_loc uuid;
  v_reg  uuid;

  v_e_mar uuid; v_e_apr uuid;
  v_f_mar uuid;
  v_g_due uuid; v_g_now uuid;
  v_h_per uuid := gen_random_uuid();

  v_today  date := public.shop_local_date();
  v_g_due_start date;
  v_g_now_start date;

  v_n      integer;
  v_kinds  text[];
  v_counts integer[];
  v_arr    text[];
  v_txt    text;
  v_status text;
  v_date   date;
  v_bigint bigint;
begin
  v_g_due_start := date_trunc('month', v_today - interval '2 months')::date;
  v_g_now_start := date_trunc('month', v_today)::date;

  insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
    select u, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
           'verify-period-exceptions-' || u || '@example.test', '', now(), now(), now()
      from unnest(array[v_own_e, v_own_f, v_own_g, v_own_h, v_viewer, v_strange]) u;

  insert into public.shops (owner_id, name) values (v_own_e, 'Exception Books') returning id into v_e;
  insert into public.shops (owner_id, name) values (v_own_f, 'Next Door Exceptions') returning id into v_f;
  insert into public.shops (owner_id, name) values (v_own_g, 'Sleepy Books') returning id into v_g;
  insert into public.shops (owner_id, name) values (v_own_h, 'Grace Books') returning id into v_h;

  -- E and F are on 'never', so every close in sections E1-E11 is one the test
  -- made and not one a read triggered behind it. 'never' rather than 'ask'
  -- deliberately: the p_force refusal at E8 does not read this column at all --
  -- close_accounting_period refuses on the exceptions, whatever the setting --
  -- and setting E to 'ask' would make the `<> 'automatic'` test at H4 redden
  -- here instead, on E's March, which is the wrong place to learn about it.
  update public.shops set auto_close_periods = 'never' where id = v_e;
  update public.shops set auto_close_periods = 'never' where id = v_f;

  -- ── E's four locations, each present for a reason ───────────────────────
  --   Front     counted in March, so it must NOT be reported. Without a counted
  --             location the `not exists` is untested: every location would be
  --             reported whether the sub-query worked or not.
  --   Back      counted in neither month until April. The one E's March reports.
  --   New Wing  OPENED IN APRIL. A branch that did not exist in March did not
  --             fail to count its stock in March.
  --   Old Kiosk INACTIVE, and never counted. A closed branch is not an
  --             outstanding task.
  insert into public.shop_locations (shop_id, name, is_primary, created_at)
    values (v_e, 'Front', true, '2026-01-05T08:00:00Z') returning id into v_e_front;
  insert into public.shop_locations (shop_id, name, created_at)
    values (v_e, 'Back', '2026-01-05T08:00:00Z') returning id into v_e_back;
  insert into public.shop_locations (shop_id, name, created_at)
    values (v_e, 'New Wing', '2026-04-15T08:00:00Z') returning id into v_e_new;
  insert into public.shop_locations (shop_id, name, active, created_at)
    values (v_e, 'Old Kiosk', false, '2026-01-05T08:00:00Z') returning id into v_e_old;

  insert into public.shop_locations (shop_id, name, is_primary, created_at)
    values (v_f, 'F One', true, '2026-01-05T08:00:00Z') returning id into v_f_loc;
  insert into public.shop_locations (shop_id, name, created_at)
    values (v_f, 'F Two', '2026-01-05T08:00:00Z');
  insert into public.shop_locations (shop_id, name, created_at)
    values (v_f, 'F Three', '2026-01-05T08:00:00Z');

  insert into public.shop_locations (shop_id, name, is_primary, created_at)
    values (v_g, 'G Main', true, v_g_due_start - 40) returning id into v_g_loc;
  insert into public.shop_locations (shop_id, name, is_primary, created_at)
    values (v_h, 'H Main', true, v_today - 90) returning id into v_h_loc;

  -- ── Products: the second gate on stock_count_missing ────────────────────
  -- E, F and G have one each, dated before every period they are asked about.
  -- H DELIBERATELY HAS NONE -- nothing to count is not a failure to count, and
  -- H is what turns that gate red when it is removed.
  insert into public.products (shop_id, name, price_cents, created_at)
    values (v_e, 'A thing E sells', 500, '2026-01-06T08:00:00Z');
  insert into public.products (shop_id, name, price_cents, created_at)
    values (v_f, 'A thing F sells', 500, '2026-01-06T08:00:00Z');
  insert into public.products (shop_id, name, price_cents, created_at)
    values (v_g, 'A thing G sells', 500, v_g_due_start - 40);

  -- ── E's stock counts ────────────────────────────────────────────────────
  --   Front, mid-March: unambiguous, and the reason March reports one location
  --   and not two.
  insert into public.stock_counts (shop_id, location_id, created_at)
    values (v_e, v_e_front, '2026-03-14T09:00:00Z');
  --   Front, 2026-03-31 21:30 UTC = 2026-04-01 00:30 IN MOGADISHU. This is
  --   APRIL'S count for Front. Read in UTC it lands on 31 March and April's
  --   Front goes uncounted, which turns check E7 (April is clean) red -- the
  --   only assertion in this file that catches shop_local_date() being dropped
  --   from the stock-count date comparison.
  insert into public.stock_counts (shop_id, location_id, created_at)
    values (v_e, v_e_front, '2026-03-31T21:30:00Z');
  insert into public.stock_counts (shop_id, location_id, created_at)
    values (v_e, v_e_back, '2026-04-10T09:00:00Z');
  insert into public.stock_counts (shop_id, location_id, created_at)
    values (v_e, v_e_new, '2026-04-20T09:00:00Z');

  -- ── E's pay runs ────────────────────────────────────────────────────────
  --   A run STRADDLING the month boundary: 24 Feb to 2 March is partly March's
  --   wages. Containment instead of overlap misses it entirely.
  insert into public.payroll_runs (shop_id, period_start, period_end, status)
    values (v_e, '2026-02-24', '2026-03-02', 'draft');
  --   ...and a POSTED run inside March, which is not an exception.
  insert into public.payroll_runs (shop_id, period_start, period_end, status)
    values (v_e, '2026-03-10', '2026-03-16', 'posted');
  --   ...and a draft run in May, which is not March's problem and not April's.
  insert into public.payroll_runs (shop_id, period_start, period_end, status)
    values (v_e, '2026-05-04', '2026-05-10', 'draft');

  -- ── E's register sessions ───────────────────────────────────────────────
  insert into public.registers (shop_id, location_id, name) values (v_e, v_e_front, 'Till 1')
    returning id into v_reg;
  --   Opened in FEBRUARY and never closed. Not March's, and the assertion that
  --   the date bound is doing something.
  insert into public.register_sessions (shop_id, location_id, register_id, opened_by, opened_at)
    values (v_e, v_e_front, v_reg, v_own_e, '2026-02-20T07:00:00Z');
  insert into public.registers (shop_id, location_id, name) values (v_e, v_e_front, 'Till 2')
    returning id into v_reg;
  --   Opened in March and never closed. THE ONE March reports.
  insert into public.register_sessions (shop_id, location_id, register_id, opened_by, opened_at)
    values (v_e, v_e_front, v_reg, v_own_e, '2026-03-20T07:00:00Z');
  insert into public.registers (shop_id, location_id, name) values (v_e, v_e_front, 'Till 3')
    returning id into v_reg;
  --   Opened in March AND CLOSED. Counted, so not an exception.
  insert into public.register_sessions (shop_id, location_id, register_id, opened_by, opened_at, closed_at, closed_by)
    values (v_e, v_e_front, v_reg, v_own_e, '2026-03-21T07:00:00Z', '2026-03-21T18:00:00Z', v_own_e);

  -- ── F: the same three kinds, in numbers that cannot be confused with E's ──
  insert into public.payroll_runs (shop_id, period_start, period_end, status)
    values (v_f, '2026-03-02', '2026-03-08', 'draft'), (v_f, '2026-03-09', '2026-03-15', 'draft');
  insert into public.registers (shop_id, location_id, name) values (v_f, v_f_loc, 'F Till 1')
    returning id into v_reg;
  insert into public.register_sessions (shop_id, location_id, register_id, opened_by, opened_at)
    values (v_f, v_f_loc, v_reg, v_own_f, '2026-03-05T07:00:00Z');
  insert into public.registers (shop_id, location_id, name) values (v_f, v_f_loc, 'F Till 2')
    returning id into v_reg;
  insert into public.register_sessions (shop_id, location_id, register_id, opened_by, opened_at)
    values (v_f, v_f_loc, v_reg, v_own_f, '2026-03-06T07:00:00Z');

  -- ── G: a member who may read the ledger and may not close it ────────────
  insert into public.roles (shop_id, name, permissions)
    values (v_g, 'Ledger viewer', array['ledger.view'])
    returning id into v_role;
  insert into public.shop_members (shop_id, user_id, role_id, active)
    values (v_g, v_viewer, v_role, true);

  -- ── H's hand-made period, ending exactly seven days ago ─────────────────
  --
  -- Written straight into accounting_periods rather than through
  -- open_period_for, which only ever makes calendar months -- and no calendar
  -- month ends a fixed number of days before today. The table constrains only
  -- `ends_on >= starts_on`, so a 30-day window is a period as far as
  -- close_accounting_period is concerned, and every date it reads comes off
  -- this row. H has no journal entries, so this period closes with no entry.
  insert into public.accounting_periods (id, shop_id, starts_on, ends_on)
    values (v_h_per, v_h, v_today - 37, v_today - 7);

  -- ...and ONE draft pay run inside it, so H is a month that has something
  -- outstanding AND NO TRADING AT ALL. Both together, which no other shop here
  -- manages: E and G both trade. close_accounting_period has two update
  -- statements -- one for a month with an entry and one for a month without --
  -- and a fixture where every exception-carrying month also traded exercises
  -- only the first. Removing `exceptions = v_exceptions` from the no-trading
  -- branch was a silent no-op against this file until this run existed.
  insert into public.payroll_runs (shop_id, period_start, period_end, status)
    values (v_h, v_today - 30, v_today - 24, 'draft');

  -- Everything above is a raw insert. RLS starts applying at this line.
  perform set_config('request.jwt.claims', json_build_object('sub', v_own_e)::text, true);
  perform set_config('role', 'authenticated', true);

  -- ── E and F trade, so that March and April are real periods ─────────────
  perform public.post_journal_entry(v_e, '2026-03-05', 'March sales, cash',
    jsonb_build_array(jsonb_build_object('code', '1000', 'amount_cents',  9100),
                      jsonb_build_object('code', '4000', 'amount_cents', -9100)),
    v_e_front, 'sale');
  perform public.post_journal_entry(v_e, '2026-03-06', 'March rent',
    jsonb_build_array(jsonb_build_object('code', '6000', 'amount_cents',  2300),
                      jsonb_build_object('code', '1000', 'amount_cents', -2300)),
    v_e_front);
  perform public.post_journal_entry(v_e, '2026-04-05', 'April sales, cash',
    jsonb_build_array(jsonb_build_object('code', '1000', 'amount_cents',  5400),
                      jsonb_build_object('code', '4000', 'amount_cents', -5400)),
    v_e_front, 'sale');

  perform set_config('request.jwt.claims', json_build_object('sub', v_own_f)::text, true);
  perform public.post_journal_entry(v_f, '2026-03-05', 'F''s March sales, cash',
    jsonb_build_array(jsonb_build_object('code', '1000', 'amount_cents',  1700),
                      jsonb_build_object('code', '4000', 'amount_cents', -1700)),
    v_f_loc, 'sale');

  -- ── G trades in a month long past its grace, and in this one ────────────
  perform set_config('request.jwt.claims', json_build_object('sub', v_own_g)::text, true);
  perform public.post_journal_entry(v_g, v_g_due_start + 4, 'G''s sales, cash',
    jsonb_build_array(jsonb_build_object('code', '1000', 'amount_cents',  8800),
                      jsonb_build_object('code', '4000', 'amount_cents', -8800)),
    v_g_loc, 'sale');
  perform public.post_journal_entry(v_g, v_g_due_start + 5, 'G''s rent',
    jsonb_build_array(jsonb_build_object('code', '6000', 'amount_cents',  1300),
                      jsonb_build_object('code', '1000', 'amount_cents', -1300)),
    v_g_loc);
  perform public.post_journal_entry(v_g, v_g_now_start, 'G''s sales this month, cash',
    jsonb_build_array(jsonb_build_object('code', '1000', 'amount_cents',  4400),
                      jsonb_build_object('code', '4000', 'amount_cents', -4400)),
    v_g_loc, 'sale');

  -- Read as postgres: RLS on accounting_periods gates on ledger.view, and no
  -- one of these four owners holds it in the other three shops. Every check
  -- below re-enters as the person it is about.
  perform set_config('role', 'postgres', true);

  select p.id into v_e_mar from public.accounting_periods p where p.shop_id = v_e and p.starts_on = '2026-03-01';
  select p.id into v_e_apr from public.accounting_periods p where p.shop_id = v_e and p.starts_on = '2026-04-01';
  select p.id into v_f_mar from public.accounting_periods p where p.shop_id = v_f and p.starts_on = '2026-03-01';
  select p.id into v_g_due from public.accounting_periods p where p.shop_id = v_g and p.starts_on = v_g_due_start;
  select p.id into v_g_now from public.accounting_periods p where p.shop_id = v_g and p.starts_on = v_g_now_start;

  if v_e_mar is null or v_e_apr is null or v_f_mar is null or v_g_due is null or v_g_now is null then
    raise exception 'FAIL: the fixture is missing a period -- E Mar %, E Apr %, F Mar %, G due %, G now %',
      v_e_mar, v_e_apr, v_f_mar, v_g_due, v_g_now;
  end if;
  --   G's two months really are two, which the whole of section G depends on.
  if v_g_due = v_g_now then
    raise exception 'FAIL: G''s due month and current month are the same period';
  end if;
  --   ...and the due one really is due while the current one really is not,
  --   under every grace the setting permits. If this ever fails the fixture has
  --   drifted into the trap it was built to avoid, and every G check below is
  --   green for the wrong reason.
  if not ((select p.ends_on from public.accounting_periods p where p.id = v_g_due) + 15 <= v_today) then
    raise exception 'FAIL: G''s "due" month is not past even a 15-day grace today (%)', v_today;
  end if;
  if (select p.ends_on from public.accounting_periods p where p.id = v_g_now) + 5 <= v_today then
    raise exception 'FAIL: G''s "current" month is already past a 5-day grace today (%)', v_today;
  end if;

  -- =====================================================================
  -- E1. THE GATE on period_exceptions: ledger.view OR ledger.close, and a
  --     stranger holds neither.
  --
  --     MUTATION: delete the has_any_shop_permission check. Reddens.
  -- =====================================================================
  perform set_config('request.jwt.claims', json_build_object('sub', v_strange)::text, true);
  perform set_config('role', 'authenticated', true);
  begin
    perform * from public.period_exceptions(v_e, v_e_mar);
    raise exception 'FAIL: a stranger read another shop''s period exceptions';
  exception
    when others then
      if sqlerrm like 'FAIL:%' then raise; end if;
      if sqlerrm not like '%permission to read%' then
        raise exception 'FAIL: period_exceptions refused a stranger for the wrong reason: %', sqlerrm;
      end if;
  end;

  --   ...and G's viewer, who holds ledger.view and NOT ledger.close, is
  --   ALLOWED. The gate is `has_any`, and a gate written as ledger.close alone
  --   would shut the screen out of its own list.
  --   MUTATION: narrow the gate to ledger.close only. Reddens here.
  perform set_config('request.jwt.claims', json_build_object('sub', v_viewer)::text, true);
  select count(*)::integer into v_n from public.period_exceptions(v_g, v_g_due) x;
  if v_n < 1 then
    raise exception 'FAIL: G''s ledger.view member reads % exceptions for a month with an uncounted branch, expected at least 1', v_n;
  end if;

  -- =====================================================================
  -- E2. THE TENANT BOUNDARY on period_exceptions. E's owner, holding
  --     ledger.close in E, naming F's period. The permission check passes --
  --     it asks whether the caller may read, not which period.
  --
  --     MUTATION: drop `and shop_id = p_shop_id` from the period lookup.
  --     Reddens: F's March is found and its exceptions are returned.
  -- =====================================================================
  perform set_config('request.jwt.claims', json_build_object('sub', v_own_e)::text, true);
  begin
    perform * from public.period_exceptions(v_e, v_f_mar);
    raise exception 'FAIL: E read F''s period exceptions';
  exception
    when others then
      if sqlerrm like 'FAIL:%' then raise; end if;
      if sqlerrm not like 'No such accounting period%' then
        raise exception 'FAIL: period_exceptions refused a foreign period for the wrong reason: %', sqlerrm;
      end if;
  end;

  -- =====================================================================
  -- E3. WHAT E'S MARCH IS UNHAPPY ABOUT: one of each, and exactly one.
  --
  --     F has 2 draft runs, 3 uncounted locations and 2 open tills against
  --     E's 1, 1, 1. Every count here is therefore visibly wrong if any of
  --     the four shop_id filters is dropped.
  --
  --     MUTATIONS, each reddening this check:
  --       * drop `r.shop_id = p_shop_id` from the pay-run count   → 3, not 1
  --       * drop `l.shop_id = p_shop_id` from the location count  → 4, not 1
  --       * drop `s.shop_id = p_shop_id` from the session count   → 3, not 1
  --       * drop `r.status = 'draft'`                             → 2, not 1
  --       * drop `s.closed_at is null`                            → 2, not 1
  --       * containment for overlap on the pay run                → 0, not 1
  --       * drop the `between` on opened_at                       → 2, not 1
  --       * drop `l.active`                                       → 2, not 1
  --       * drop `l.created_at <= ends_on`                        → 2, not 1
  --       * drop the `not exists` on stock_counts                 → 3, not 1
  -- =====================================================================
  select array_agg(x.kind order by x.kind), array_agg(x.count order by x.kind)
    into v_kinds, v_counts
    from public.period_exceptions(v_e, v_e_mar) x;

  if v_kinds is distinct from array['draft_payroll_run', 'register_session_open', 'stock_count_missing'] then
    raise exception 'FAIL: E''s March reports the kinds %, expected all three exactly once', v_kinds;
  end if;
  if v_counts is distinct from array[1, 1, 1] then
    raise exception 'FAIL: E''s March reports the counts %, expected {1,1,1}', v_counts;
  end if;

  --   The stock-count line names the branch that was not counted, and does not
  --   name the three that must not be there. "Names them" is what the design
  --   asked of a close, so the detail is asserted and not just the number.
  select x.detail into v_txt from public.period_exceptions(v_e, v_e_mar) x
   where x.kind = 'stock_count_missing';
  if v_txt not like '%Back%' or v_txt like '%Front%' or v_txt like '%New Wing%' or v_txt like '%Old Kiosk%' then
    raise exception 'FAIL: E''s March names the wrong branches: %', v_txt;
  end if;
  if v_txt not like '%March 2026%' then
    raise exception 'FAIL: E''s stock-count exception does not name the month: %', v_txt;
  end if;

  -- =====================================================================
  -- E4. F'S OWN COUNTS, from F's side. Without this the checks above could
  --     pass on a function that returns E's numbers for everybody.
  --
  --     MUTATION: hardcode any of the counts. Reddens on one side or the
  --     other; the two shops share no figure.
  -- =====================================================================
  perform set_config('request.jwt.claims', json_build_object('sub', v_own_f)::text, true);
  select array_agg(x.kind order by x.kind), array_agg(x.count order by x.kind)
    into v_kinds, v_counts
    from public.period_exceptions(v_f, v_f_mar) x;
  if v_counts is distinct from array[2, 2, 3] then
    raise exception 'FAIL: F''s March reports % for %, expected {2,2,3}', v_counts, v_kinds;
  end if;

  -- =====================================================================
  -- E5. THE MODULE GATE on stock_count_missing. F is suspended, which is the
  --     only way in this database to take `inventory` off a shop that already
  --     has products -- every plan includes it. A suspended shop cannot record
  --     a stock count (stock_counts carries enforce_shop_module('inventory')),
  --     so an exception it could never clear would be a permanent complaint.
  --
  --     The other two survive the suspension, which is what makes this a test
  --     of the gate and not of the fixture disappearing.
  --
  --     MUTATION: delete the shop_has_module check. Reddens: 3 kinds, not 2.
  -- =====================================================================
  perform set_config('role', 'postgres', true);
  update public.shop_subscriptions set manual_status = 'suspended' where shop_id = v_f;
  perform set_config('role', 'authenticated', true);

  if public.shop_has_module(v_f, 'inventory') then
    raise exception 'FAIL: F still has the inventory module after being suspended, so E5 tests nothing';
  end if;

  select array_agg(x.kind order by x.kind) into v_kinds
    from public.period_exceptions(v_f, v_f_mar) x;
  if v_kinds is distinct from array['draft_payroll_run', 'register_session_open'] then
    raise exception 'FAIL: a suspended F reports %, expected the two that do not need the inventory module', v_kinds;
  end if;

  -- =====================================================================
  -- E6. THE PRODUCTS GATE. H has a location, the inventory module and NO
  --     products, so its uncounted branch is NOT reported. Nothing to count is
  --     not a failure to count.
  --
  --     Asserted as "these kinds and not that one" rather than "no exceptions
  --     at all": H does have a draft pay run, and a check that expected zero
  --     would be a check that H's exceptions were broken as easily as gated.
  --
  --     MUTATION: delete the `exists (select 1 from products ...)`. Reddens:
  --     stock_count_missing appears for a shop that sells nothing.
  -- =====================================================================
  perform set_config('request.jwt.claims', json_build_object('sub', v_own_h)::text, true);
  if not public.shop_has_module(v_h, 'inventory') then
    raise exception 'FAIL: H has no inventory module, so E6 is not testing the products gate';
  end if;
  select array_agg(x.kind order by x.kind) into v_kinds
    from public.period_exceptions(v_h, v_h_per) x;
  if v_kinds is distinct from array['draft_payroll_run'] then
    raise exception 'FAIL: H reports % with no products at all, expected only its draft pay run', v_kinds;
  end if;

  -- =====================================================================
  -- E7. APRIL IS CLEAN. Every rule above can go quiet, and the fixture proves
  --     it rather than asserting it: April's Front count is timestamped
  --     2026-03-31 21:30 UTC, which is 1 April in Mogadishu.
  --
  --     MUTATIONS:
  --       * `c.created_at::date` for `shop_local_date(c.created_at)` → Front
  --         reads as counted in March and uncounted in April. Reddens.
  --       * remove the New Wing/Back April counts from the fixture → reddens,
  --         which is what makes this a real "can be empty" and not a month
  --         nothing was ever checked against.
  -- =====================================================================
  perform set_config('request.jwt.claims', json_build_object('sub', v_own_e)::text, true);
  select count(*)::integer into v_n from public.period_exceptions(v_e, v_e_apr) x;
  if v_n <> 0 then
    select string_agg(x.detail, ' | ') into v_txt from public.period_exceptions(v_e, v_e_apr) x;
    raise exception 'FAIL: E''s April reports % exceptions, expected none: %', v_n, v_txt;
  end if;

  -- =====================================================================
  -- E8. p_force = false REFUSES, AND NAMES EVERYTHING. This is what 'ask'
  --     means: the RPC is the thing that asks.
  --
  --     MUTATION: make close_accounting_period ignore p_force again, as it
  --     was shipped in 20261002000100. Reddens -- March closes silently.
  -- =====================================================================
  begin
    perform public.close_accounting_period(v_e, v_e_mar);
    raise exception 'FAIL: March closed without force while three items were outstanding';
  exception
    when others then
      if sqlerrm like 'FAIL:%' then raise; end if;
      if sqlerrm not like '%3 items%' then
        raise exception 'FAIL: the refusal does not count the outstanding items: %', sqlerrm;
      end if;
      --   All three, by name, in one message. A refusal that names two of
      --   three sends the shop to fix what it can see and be refused again.
      if sqlerrm not like '%pay run%' or sqlerrm not like '%Back%'
         or sqlerrm not like '%register session%' then
        raise exception 'FAIL: the refusal does not name all three outstanding items: %', sqlerrm;
      end if;
  end;
  --   ...and March really is still open. This is WEAKER THAN IT LOOKS and is
  --   here for the case it does cover rather than the one it seems to: the
  --   `begin ... exception` above is a subtransaction, so a refusal that had
  --   already flipped the status would have that flip rolled back and read
  --   green here anyway. What it does catch is a "refusal" that raises a notice
  --   and returns. The load-bearing assertion is the message, above.
  if (select p.status from public.accounting_periods p where p.id = v_e_mar) <> 'open' then
    raise exception 'FAIL: March is not open after a close that was supposed to be refused';
  end if;

  -- =====================================================================
  -- E9. A CLEAN MONTH CLOSES WITHOUT FORCE, and records an EMPTY list.
  --
  --     '{}' and not null matters: a period closed over nothing and a period
  --     nobody looked at must not be the same row.
  --
  --     MUTATION: refuse unconditionally rather than on `v_exceptions is not
  --     null`. Reddens -- April cannot close at all.
  -- =====================================================================
  perform public.close_accounting_period(v_e, v_e_apr);
  select p.status, p.exceptions into v_status, v_arr
    from public.accounting_periods p where p.id = v_e_apr;
  if v_status <> 'closed' then
    raise exception 'FAIL: a month with nothing outstanding did not close without force (status %)', v_status;
  end if;
  if v_arr is distinct from '{}'::text[] then
    raise exception 'FAIL: a clean close recorded %, expected an empty array', v_arr;
  end if;

  -- =====================================================================
  -- E10. CLOSED WITH EXCEPTIONS. Forced, March closes and the three sentences
  --      are written to the period -- the SAME sentences period_exceptions()
  --      returned at check E3, because they come from the same call.
  --
  --      MUTATIONS:
  --        * drop `exceptions = v_exceptions` from the update → '{}'. Reddens.
  --        * record kinds instead of details → the branch name goes. Reddens.
  --        * compute the list a second time for the record instead of reusing
  --          v_exceptions → still green today, and that is the point of it
  --          being one call: there is no second derivation to drift.
  -- =====================================================================
  select array_agg(x.detail order by x.kind) into v_arr
    from public.period_exceptions(v_e, v_e_mar) x;

  if public.close_accounting_period(v_e, v_e_mar, true) is null then
    raise exception 'FAIL: forcing a close of a month that traded returned no entry';
  end if;

  select p.status, p.exceptions into v_status, v_kinds
    from public.accounting_periods p where p.id = v_e_mar;
  if v_status <> 'closed' then
    raise exception 'FAIL: a forced close left March %', v_status;
  end if;
  if v_kinds is distinct from v_arr then
    raise exception 'FAIL: March recorded % but period_exceptions() said %', v_kinds, v_arr;
  end if;
  if cardinality(v_kinds) <> 3 then
    raise exception 'FAIL: March recorded % exceptions, expected 3', cardinality(v_kinds);
  end if;

  --   The audit row a close writes carries them too, and is marked as a close
  --   so a history screen can tell it from the trigger's row-diff beside it.
  --   MUTATION: drop the `event` key. Reddens.
  if not exists (
    select 1 from public.accounting_audit_log a
     where a.shop_id = v_e and a.subject_id = v_e_mar
       and a.after->>'event' = 'close'
       and (a.after->>'forced')::boolean
       and jsonb_array_length(a.after->'exceptions') = 3) then
    raise exception 'FAIL: no audit row marks March as a forced close carrying three exceptions';
  end if;
  --   ...and the trigger's row really is there beside it, unmarked. Both are
  --   wanted; what was missing was a way to tell them apart.
  if not exists (
    select 1 from public.accounting_audit_log a
     where a.shop_id = v_e and a.subject_id = v_e_mar
       and a.after ? 'created_at' and a.after->>'event' is null) then
    raise exception 'FAIL: the accounting_periods trigger wrote no row-diff for March''s close';
  end if;

  -- =====================================================================
  -- E11. RE-OPENING CLEARS THE RECORDED LIST. It described a close, and there
  --      is no longer a close.
  --
  --      MUTATION: drop `exceptions = '{}'` from reopen's update. Reddens.
  -- =====================================================================
  perform public.reopen_accounting_period(v_e, v_e_mar, 'A late supplier bill');
  select p.status, p.exceptions into v_status, v_arr
    from public.accounting_periods p where p.id = v_e_mar;
  if v_status <> 'open' then
    raise exception 'FAIL: March is % after being re-opened', v_status;
  end if;
  if v_arr is distinct from '{}'::text[] then
    raise exception 'FAIL: re-opening March left % recorded against it', v_arr;
  end if;

  -- =====================================================================
  -- G1. A LEDGER.VIEW MEMBER READS THE LIST AND CLOSES NOTHING.
  --
  --     This is the shape of the Critical phase 3a shipped: an ungated card
  --     calling an RPC that raises gave a Manager a permanent "Loading…".
  --     close_due_periods returns 0 for a caller without ledger.close instead
  --     of raising, precisely so that a read stays a read.
  --
  --     MUTATIONS:
  --       * raise instead of returning 0 in close_due_periods → this errors.
  --       * delete the ledger.close check in close_due_periods → the viewer's
  --         READ closes G's month. Reddens on the status assertion below.
  -- =====================================================================
  perform set_config('request.jwt.claims', json_build_object('sub', v_viewer)::text, true);
  select count(*)::integer into v_n from public.list_accounting_periods(v_g) p;
  if v_n <> 2 then
    raise exception 'FAIL: G''s viewer sees % periods, expected 2', v_n;
  end if;
  if (select p.status from public.accounting_periods p where p.id = v_g_due) <> 'open' then
    raise exception 'FAIL: a ledger.view member''s read closed G''s due month';
  end if;

  -- =====================================================================
  -- G2. THE LAZY CLOSE, from somebody who may. One month is past its grace
  --     and one is not, and the one that is closes WITH ITS EXCEPTIONS --
  --     G never counted its stock, and the design's whole point is that such
  --     a shop still closes.
  --
  --     MUTATIONS:
  --       * drop `p.ends_on + grace <= v_today` → 2, not 1. Reddens.
  --       * `p.status = 'open'` for `<> 'locked'` → the second call at G3
  --         tries to close a closed period and raises. Reddens.
  --       * pass false for p_force → the close is refused. Reddens.
  -- =====================================================================
  perform set_config('request.jwt.claims', json_build_object('sub', v_own_g)::text, true);
  select public.close_due_periods(v_g) into v_n;
  if v_n <> 1 then
    raise exception 'FAIL: close_due_periods closed % of G''s months, expected 1', v_n;
  end if;
  select p.status, p.exceptions into v_status, v_arr
    from public.accounting_periods p where p.id = v_g_due;
  if v_status <> 'closed' then
    raise exception 'FAIL: G''s due month is % after auto-close', v_status;
  end if;
  if cardinality(v_arr) <> 1 or v_arr[1] not like '%G Main%' then
    raise exception 'FAIL: G''s auto-closed month recorded %, expected the uncounted branch', v_arr;
  end if;
  if (select p.status from public.accounting_periods p where p.id = v_g_now) <> 'open' then
    raise exception 'FAIL: auto-close closed the month that is still running';
  end if;

  -- =====================================================================
  -- G3. RUNNING IT AGAIN CLOSES NOTHING. A read that happens twice must not
  --     be an error the second time -- this runs on the back of every read.
  -- =====================================================================
  select public.close_due_periods(v_g) into v_n;
  if v_n <> 0 then
    raise exception 'FAIL: a second auto-close pass closed % months, expected 0', v_n;
  end if;

  -- =====================================================================
  -- G4. WHAT THE SCREEN IS GIVEN. Every figure a period row shows is a column
  --     the function returned; the screen does no arithmetic, as phase 3a's
  --     do not.
  --
  --     G's due month made 8800 of revenue against 1300 of rent = 7500.
  --
  --     MUTATIONS:
  --       * drop the minus from profit_rolled_cents → -7500. Reddens.
  --       * drop `e.status = 'posted'` from the closing-entry lateral → a
  --         re-opened month would report a profit it gave back. Not reachable
  --         from G; asserted at G6 against E's re-opened March.
  --       * `p.ends_on + 10` for `p.ends_on + v_grace` → still green at 10 and
  --         red at H2's five. That is why H exists.
  --       * drop `where p.shop_id = p_shop_id` → G's owner sees E, F and H's
  --         periods too. Reddens on the row count at G1 and here.
  -- =====================================================================
  select p.profit_rolled_cents, p.closing_entry_id is not null, p.auto_close_due_on, p.outstanding
    into v_bigint, v_status, v_date, v_arr
    from public.list_accounting_periods(v_g) p where p.id = v_g_due;
  if v_bigint <> 7500 then
    raise exception 'FAIL: G''s closed month reports % rolled to retained earnings, expected 7500', v_bigint;
  end if;
  if v_status <> 'true' then
    raise exception 'FAIL: G''s closed month names no closing entry';
  end if;
  if v_date is not null then
    raise exception 'FAIL: a closed month has an auto-close date of %', v_date;
  end if;
  if v_arr is not null then
    raise exception 'FAIL: a closed month recomputed its outstanding items as %', v_arr;
  end if;

  --   ...and the month still running: nothing rolled, a date it will close on,
  --   and a live list of what closing it today would record.
  select p.profit_rolled_cents, p.auto_close_due_on, p.outstanding
    into v_bigint, v_date, v_arr
    from public.list_accounting_periods(v_g) p where p.id = v_g_now;
  if v_bigint <> 0 then
    raise exception 'FAIL: an open month reports % rolled, expected 0', v_bigint;
  end if;
  if v_date is distinct from (select p.ends_on + 10 from public.accounting_periods p where p.id = v_g_now) then
    raise exception 'FAIL: the open month closes on %, expected its end plus the ten-day default', v_date;
  end if;
  if v_arr is null or cardinality(v_arr) <> 1 then
    raise exception 'FAIL: the open month''s live outstanding list is %, expected one item', v_arr;
  end if;

  --   ...and the date MOVES WITH THE SETTING. Ten is the default, so a check
  --   against ten alone passes against `p.ends_on + 10` typed into the query.
  --   Fifteen is chosen because the fixture already guarantees G's current
  --   month is not due under it, so nothing closes while this is asked.
  --   MUTATION: hardcode ten in auto_close_due_on. Reddens here.
  update public.shops set period_close_grace_days = 15 where id = v_g;
  select p.auto_close_due_on into v_date
    from public.list_accounting_periods(v_g) p where p.id = v_g_now;
  if v_date is distinct from (select p.ends_on + 15 from public.accounting_periods p where p.id = v_g_now) then
    raise exception 'FAIL: with a fifteen-day grace the open month closes on %, expected its end plus fifteen', v_date;
  end if;
  update public.shops set period_close_grace_days = 10 where id = v_g;

  -- =====================================================================
  -- G5. THE TENANT BOUNDARY on list_accounting_periods: H's owner holds
  --     nothing in G.
  --
  --     MUTATION: delete the ledger.view gate. Reddens -- and note that the
  --     gate is the WHOLE boundary, because the function is security definer
  --     and RLS on accounting_periods does not apply inside it.
  -- =====================================================================
  perform set_config('request.jwt.claims', json_build_object('sub', v_own_h)::text, true);
  begin
    perform * from public.list_accounting_periods(v_g);
    raise exception 'FAIL: H''s owner listed G''s accounting periods';
  exception
    when others then
      if sqlerrm like 'FAIL:%' then raise; end if;
      if sqlerrm not like '%permission to view%' then
        raise exception 'FAIL: list_accounting_periods refused a stranger for the wrong reason: %', sqlerrm;
      end if;
  end;
  --   ...and close_due_periods, for the same stranger, is SILENT rather than
  --   loud -- and closes nothing.
  select public.close_due_periods(v_g) into v_n;
  if v_n <> 0 then
    raise exception 'FAIL: a stranger''s close_due_periods closed % of G''s months', v_n;
  end if;

  -- =====================================================================
  -- G6. A RE-OPENED MONTH ROLLED NOTHING. E's March was closed and re-opened
  --     at E11; its closing entry is still on the record, marked reversed.
  --
  --     MUTATION: drop `e.status = 'posted'` or `e.reverses_entry_id is null`
  --     from the lateral. Reddens: March reports the 6800 it gave back.
  -- =====================================================================
  perform set_config('request.jwt.claims', json_build_object('sub', v_own_e)::text, true);
  select p.profit_rolled_cents, p.closing_entry_id is not null
    into v_bigint, v_status
    from public.list_accounting_periods(v_e) p where p.id = v_e_mar;
  if v_bigint <> 0 or v_status <> 'false' then
    raise exception 'FAIL: E''s re-opened March still reports % rolled and entry-present %', v_bigint, v_status;
  end if;
  --   ...and the entry it wrote is genuinely still there, reversed, or the
  --   check above passes because nothing was ever posted.
  if not exists (select 1 from public.journal_entries e
                  where e.shop_id = v_e and e.period_id = v_e_mar
                    and e.source = 'close' and e.status = 'reversed') then
    raise exception 'FAIL: E''s March has no reversed closing entry, so G6 tests nothing';
  end if;

  -- =====================================================================
  -- H1/H2. THE GRACE IS A COLUMN, NOT THE NUMBER TEN.
  --
  --     H's period ended seven days ago. Seven is inside ten and outside five,
  --     so the same period is not due and then due, with nothing changing but
  --     the setting.
  --
  --     MUTATION: hardcode 10. H1 stays green and H2 goes red. This is the
  --     only check in the file that distinguishes the two.
  -- =====================================================================
  perform set_config('request.jwt.claims', json_build_object('sub', v_own_h)::text, true);
  if (select s.period_close_grace_days from public.shops s where s.id = v_h) <> 10 then
    raise exception 'FAIL: the shipped default grace is not ten days';
  end if;
  if (select s.auto_close_periods from public.shops s where s.id = v_h) <> 'automatic' then
    raise exception 'FAIL: the shipped default is not to close automatically';
  end if;

  select public.close_due_periods(v_h) into v_n;
  if v_n <> 0 then
    raise exception 'FAIL: a month that ended 7 days ago closed under a 10-day grace';
  end if;

  update public.shops set period_close_grace_days = 5 where id = v_h;
  select public.close_due_periods(v_h) into v_n;
  if v_n <> 1 then
    raise exception 'FAIL: a month that ended 7 days ago did not close under a 5-day grace (closed %)', v_n;
  end if;
  --   It closed with no entry, because H never traded -- the null-return path,
  --   reached here through the automatic door.
  if (select p.status from public.accounting_periods p where p.id = v_h_per) <> 'closed' then
    raise exception 'FAIL: H''s period is not closed after its grace expired';
  end if;
  if exists (select 1 from public.journal_entries e where e.period_id = v_h_per) then
    raise exception 'FAIL: a month that never traded wrote a closing entry';
  end if;
  --   ...AND IT RECORDED WHAT WAS OUTSTANDING. close_accounting_period has two
  --   update statements and this is the only assertion that reaches the second
  --   one: every other month here that carries exceptions also traded.
  --   MUTATION: drop `exceptions = v_exceptions` from the no-trading branch --
  --   which was a no-op against this file until H had a draft pay run in it.
  --   Reddens.
  select p.exceptions into v_arr from public.accounting_periods p where p.id = v_h_per;
  if cardinality(v_arr) <> 1 or v_arr[1] not like '%pay run%' then
    raise exception 'FAIL: a month that closed empty recorded %, expected its draft pay run', v_arr;
  end if;
  --   ...and the audit row for a close with no entry says so, and carries them.
  if not exists (
    select 1 from public.accounting_audit_log a
     where a.shop_id = v_h and a.subject_id = v_h_per
       and a.after->>'event' = 'close'
       and a.after->>'closing_entry_id' is null
       and jsonb_array_length(a.after->'exceptions') = 1) then
    raise exception 'FAIL: no audit row records H''s entry-less close and what it closed over';
  end if;

  -- =====================================================================
  -- H3/H4/H5. 'never' AND 'ask' MEAN NOTHING CLOSES BY ITSELF.
  --
  --     MUTATIONS:
  --       * delete the auto_close_periods check → H3 and H4 both close. Red.
  --       * test `= 'never'` instead of `<> 'automatic'` → H4 closes. Red.
  --         Two algebraically identical branches are a mutation that reddens
  --         nothing; these two are not identical, and H4 is what proves it.
  -- =====================================================================
  perform public.reopen_accounting_period(v_h, v_h_per, 'Testing the setting');

  update public.shops set auto_close_periods = 'never' where id = v_h;
  select public.close_due_periods(v_h) into v_n;
  if v_n <> 0 then
    raise exception 'FAIL: a shop set to never auto-close closed % months', v_n;
  end if;

  update public.shops set auto_close_periods = 'ask' where id = v_h;
  select public.close_due_periods(v_h) into v_n;
  if v_n <> 0 then
    raise exception 'FAIL: a shop set to ask closed % months by itself', v_n;
  end if;
  --   ...and its list carries no auto-close date, because there is no date on
  --   which it closes.
  --   MUTATION: return period_close_grace_days regardless of the setting.
  --   Reddens.
  select p.auto_close_due_on into v_date
    from public.list_accounting_periods(v_h) p where p.id = v_h_per;
  if v_date is not null then
    raise exception 'FAIL: a shop set to ask reports an auto-close date of %', v_date;
  end if;

  --   H5: back to automatic, and it closes again. Without this, H3 and H4
  --   would be green on a function that had simply stopped working.
  update public.shops set auto_close_periods = 'automatic' where id = v_h;
  select public.close_due_periods(v_h) into v_n;
  if v_n <> 1 then
    raise exception 'FAIL: H did not close again once set back to automatic (closed %)', v_n;
  end if;

  -- =====================================================================
  -- H6. THE READ IS THE THING THAT RUNS IT. Everything above called
  --     close_due_periods by hand; this is the door the app actually opens.
  --
  --     MUTATION: delete `perform public.close_due_periods(p_shop_id)` from
  --     list_accounting_periods. Reddens -- and with it, the whole feature,
  --     since nothing else calls the driver.
  -- =====================================================================
  perform public.reopen_accounting_period(v_h, v_h_per, 'Once more, through the front door');
  if (select p.status from public.accounting_periods p where p.id = v_h_per) <> 'open' then
    raise exception 'FAIL: H''s period is not open again, so H6 tests nothing';
  end if;
  select p.status into v_status from public.list_accounting_periods(v_h) p where p.id = v_h_per;
  if v_status <> 'closed' then
    raise exception 'FAIL: reading the period list did not close a month past its grace (it reads %)', v_status;
  end if;

  -- =====================================================================
  -- 12. E AND F ARE UNMOVED by everything G and H did, and by each other.
  --     Four shops, and no function above may reach across them.
  -- =====================================================================
  if (select count(*) from public.accounting_periods p where p.shop_id = v_f and p.status <> 'open') <> 0 then
    raise exception 'FAIL: one of F''s periods is no longer open';
  end if;
  if (select p.status from public.accounting_periods p where p.id = v_e_apr) <> 'closed' then
    raise exception 'FAIL: E''s April is no longer closed';
  end if;
  if (select p.status from public.accounting_periods p where p.id = v_e_mar) <> 'open' then
    raise exception 'FAIL: E''s re-opened March did not stay open';
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
