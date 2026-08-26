-- The five reconciliations, over a window that SPANS A PERIOD CLOSE.
--
-- verify-statements.sql proves the three statements agree with each other on a
-- shop that has never closed a month. Every shop reaches the day it closes one,
-- and a closing entry is the only entry in this database that moves money
-- between the income statement and the balance sheet without anything happening
-- in the shop. This file is that day.
--
-- ## What the decision was, and what it makes true
--
-- statement_lines() and therefore cash_flow() exclude source = 'close'; the
-- balance sheet reads 3900 as the ledger holds it and subtracts what has been
-- closed away from its profit line. 20261002000000's header works the
-- alternative through reconciliation by reconciliation. What that leaves true,
-- and what this file asserts:
--
--   1. income statement net profit over a SPANNING window is the shop's real
--      trading, P1 + P2 -- NOT the balance sheet's "Profit this period", which
--      after a close is P2 alone. Those are two different quantities and it
--      would be wrong for them to agree. The reconciliation that replaces it is
--      stronger: retained earnings + profit this period = all-time net profit.
--      Reconciliation 1 in its original form is asserted too, over the OPEN
--      period's own window, where it does hold.
--   2. holds exactly, for any window.
--   3. holds, against a derivation that excludes closing entries independently.
--   4. holds -- and it is the one that catches a balance sheet which excludes
--      closing entries naively: it would count the closed profit twice, once in
--      3900 and once in the profit line, and be out by exactly P1.
--   5. holds; a closing entry touches no cash account.
--
-- ## The fixture
--
-- Two months, both traded, the FIRST one closed. Dates are fixed calendar
-- months in the past rather than offsets from today: a fixture dated relative
-- to `now()` has made two dates coincide on this project before, and a period
-- close is entirely about which month a date falls in.
--
--   Shop A, March 2026            Shop A, April 2026
--     Cr 3000  60000 capital        Dr 1100   9000 sold on credit
--     Dr 1200  20000 stock          Cr 4000   9000
--     Cr 4000  31000 sales          Dr 5000   3300 cost of it
--     Dr 5000  12000 cost           Dr 6100   2100 utilities, on account
--     Dr 6000   4300 rent           Dr 6200   7400 wages, accrued
--     Dr 6300    800 marketing      Dr 6800    500 depreciation
--     Cr 6300    800 refunded       Dr 3100   1700 owner's draw
--     Dr 1500  24000 the van
--     Dr 6800    600 depreciation
--     ---------------------        ---------------------
--     PROFIT   14100               LOSS      -4300
--
-- March is closed. April is not.
--
-- ## THE DEPRECIATION, AND WHY IT IS POSTED BY HAND
--
-- 6800 is the one account this statement suite reads that a CLOSE ALSO TOUCHES.
-- `Add back depreciation` in the cash flow is 6800's movement, and 6800 is an
-- EXPENSE account, so a closing entry credits it by its balance like every other
-- P&L account. For a window containing a close the add-back therefore reads the
-- depreciation LESS the closing credit, while net profit -- which excludes the
-- closing entry -- still carries the full cost. The same amount is subtracted
-- twice and the proof row fails by exactly it. Read the closed month on its own
-- and the add-back reads 0 and the statement is out by the whole month's charge.
--
-- Nothing in kaiibi posts to 6800 until phase 3c ships run_depreciation, so a
-- fixture that closes a month has an empty add-back and the defect is invisible:
-- 0 - 0 = 0. verify-statements.sql posts a depreciation entry BY HAND for
-- exactly that reason and this file -- the one built to span a close -- did not,
-- which is why 20261004000100 shipped with the whole suite green either side of
-- it. So: a van, and a charge in BOTH months, hand-posted at source
-- 'depreciation' exactly as verify-statements.sql posts its own. The charges are
-- 600 and 500 rather than one figure twice, so an add-back that read one month
-- for the other could not pass.
--
-- The van is not decoration either. Accumulated depreciation with no asset
-- behind it is a fixture that could not happen, and 1500 is inside the
-- 1500-1599 range the investing line reads -- so `Bought equipment` is non-zero
-- across the close as well, and the closing entry must not move it.
--
-- The 800 of marketing, spent and refunded inside March, is not decoration: it
-- makes 6300's balance for the period exactly ZERO, which is the case
-- close_accounting_period()'s `having sum(...) <> 0` exists for. journal_lines
-- refuses a zero amount, so without that clause the close fails outright --
-- and with no such account in the fixture, removing it reddens nothing.
--
-- One month is a PROFIT and the other a LOSS on purpose, and shop B's closed
-- month is a loss as well: the 3900 line is a credit on a profit and a debit on
-- a loss, and a fixture that only ever profits cannot tell a sign error from a
-- correct one.
--
-- Shop B is the tenant boundary. It trades in the same two months, closes the
-- same one, and every figure it carries is unlike shop A's -- so a leak in
-- either direction moves a number that is pinned to the cent here.

\set ON_ERROR_STOP on

do $$
declare
  v_user   uuid := gen_random_uuid();
  v_other  uuid := gen_random_uuid();
  v_shop   uuid;
  v_loc    uuid;
  v_shop_b uuid;
  v_loc_b  uuid;
  v_mar    uuid;   -- shop A's March period
  v_apr    uuid;   -- shop A's April period
  v_mar_b  uuid;
  v_close  uuid;   -- the closing entry
  v_amount bigint;

  -- Equity before and after the close. A close moves profit WITHIN equity; it
  -- must not create or destroy any.
  v_equity_before bigint;
  v_equity_after  bigint;

  -- The five, each named so a failure can print both sides.
  v_is_profit  bigint;   -- income statement, spanning window
  v_bs_profit  bigint;   -- balance sheet, "Profit this period"
  v_bs_retain  bigint;   -- balance sheet, "Retained earnings — prior periods"
  v_cf_profit  bigint;   -- cash flow, the operating opening line
  v_tb_profit  bigint;   -- netted independently off journal_lines
  v_tb_lines   bigint;
  v_bs_assets  bigint;
  v_bs_credits bigint;
  v_bs_cash    bigint;
  v_cf_cash    bigint;
  v_cf_dep     bigint;   -- cash flow, 'Add back depreciation'
  v_dep_lines  bigint;   -- how many 6800 lines the fixture actually posted
begin
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
    select u, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
           'verify-across-close-' || u || '@example.test', '', now(), now(), now()
      from unnest(array[v_user, v_other]) u;

  insert into public.shops (owner_id, name) values (v_user, 'Closing Shop') returning id into v_shop;
  insert into public.shop_locations (shop_id, name, is_primary) values (v_shop, 'Main', true)
    returning id into v_loc;
  insert into public.shops (owner_id, name) values (v_other, 'The Other Closing Shop') returning id into v_shop_b;
  insert into public.shop_locations (shop_id, name, is_primary) values (v_shop_b, 'Main', true)
    returning id into v_loc_b;

  -- RLS starts applying here, so every raw insert above had to come first.
  perform set_config('request.jwt.claims', json_build_object('sub', v_user)::text, true);
  perform set_config('role', 'authenticated', true);

  -- ── SHOP A, MARCH 2026 ────────────────────────────────────────────────
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
  -- The van, bought for cash. 1500 is inside the 1500-1599 range the cash
  -- flow's investing line reads and the balance sheet calls fixed assets, and
  -- it is what the depreciation below depreciates.
  perform public.post_journal_entry(v_shop, '2026-03-05', 'A van, for cash',
    jsonb_build_array(jsonb_build_object('code', '1500', 'amount_cents',  24000),
                      jsonb_build_object('code', '1000', 'amount_cents', -24000)),
    v_loc, 'asset');
  perform public.post_journal_entry(v_shop, '2026-03-15', 'March rent',
    jsonb_build_array(jsonb_build_object('code', '6000', 'amount_cents',  4300),
                      jsonb_build_object('code', '1000', 'amount_cents', -4300)),
    v_loc);
  -- Spent and refunded inside the same month, so 6300's balance for the period
  -- is exactly zero. See the header.
  perform public.post_journal_entry(v_shop, '2026-03-18', 'A leaflet run',
    jsonb_build_array(jsonb_build_object('code', '6300', 'amount_cents',  800),
                      jsonb_build_object('code', '1000', 'amount_cents', -800)),
    v_loc);
  perform public.post_journal_entry(v_shop, '2026-03-19', 'The leaflet run, refunded',
    jsonb_build_array(jsonb_build_object('code', '1000', 'amount_cents',  800),
                      jsonb_build_object('code', '6300', 'amount_cents', -800)),
    v_loc);
  -- March's depreciation, hand-posted: see the header. 6800 is an EXPENSE, so
  -- the close below CREDITS it -- and this charge lands in the month that gets
  -- closed, which is the whole point of putting it here. 1590 is the seeded
  -- contra asset and is deliberately outside the investing range.
  perform public.post_journal_entry(v_shop, '2026-03-31', 'March depreciation on the van',
    jsonb_build_array(jsonb_build_object('code', '6800', 'amount_cents',  600),
                      jsonb_build_object('code', '1590', 'amount_cents', -600)),
    v_loc, 'depreciation');

  -- ── SHOP A, APRIL 2026 ────────────────────────────────────────────────
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
  -- April's depreciation, in the OPEN month, and a different figure from
  -- March's. With a charge in both months the add-back across the close reads
  -- 1100 when it is right and 500 when the closing entry is being counted --
  -- two non-zero numbers, so neither side of the comparison can pass by being
  -- empty.
  perform public.post_journal_entry(v_shop, '2026-04-30', 'April depreciation on the van',
    jsonb_build_array(jsonb_build_object('code', '6800', 'amount_cents',  500),
                      jsonb_build_object('code', '1590', 'amount_cents', -500)),
    v_loc, 'depreciation');
  perform public.post_journal_entry(v_shop, '2026-04-20', 'Owner drawing',
    jsonb_build_array(jsonb_build_object('code', '3100', 'amount_cents',  1700),
                      jsonb_build_object('code', '1000', 'amount_cents', -1700)),
    v_loc);

  -- ── SHOP B, ITS OWN TWO MONTHS ────────────────────────────────────────
  perform set_config('request.jwt.claims', json_build_object('sub', v_other)::text, true);
  perform public.post_journal_entry(v_shop_b, '2026-03-05', 'Capital, in cash',
    jsonb_build_array(jsonb_build_object('code', '1000', 'amount_cents',  88000),
                      jsonb_build_object('code', '3000', 'amount_cents', -88000)),
    v_loc_b, 'opening');
  perform public.post_journal_entry(v_shop_b, '2026-03-20', 'March rent',
    jsonb_build_array(jsonb_build_object('code', '6000', 'amount_cents',  5900),
                      jsonb_build_object('code', '1000', 'amount_cents', -5900)),
    v_loc_b);
  perform public.post_journal_entry(v_shop_b, '2026-04-14', 'April sales, cash',
    jsonb_build_array(jsonb_build_object('code', '1000', 'amount_cents',  12300),
                      jsonb_build_object('code', '4000', 'amount_cents', -12300)),
    v_loc_b, 'sale');
  -- Read while shop B's OWNER is the caller. accounting_periods has an RLS
  -- read policy on ledger.view, and this select is subject to it: shop A's
  -- owner reading it comes back null, silently, and every check below that
  -- needs the id would then be asserting against a null.
  select id into v_mar_b from public.accounting_periods
   where shop_id = v_shop_b and starts_on = '2026-03-01';
  perform set_config('request.jwt.claims', json_build_object('sub', v_user)::text, true);

  select id into v_mar from public.accounting_periods
   where shop_id = v_shop and starts_on = '2026-03-01';
  select id into v_apr from public.accounting_periods
   where shop_id = v_shop and starts_on = '2026-04-01';
  if v_mar is null or v_apr is null or v_mar_b is null then
    raise exception 'FAIL: the fixture did not open the periods it posted into -- March %, April %, other shop''s March %',
      v_mar, v_apr, v_mar_b;
  end if;

  -- 1. BEFORE THE CLOSE. Every figure that must survive it, taken first.
  --    3900 is zero for every shop until something closes; assert it, or
  --    "3900 holds the closed month's profit" below could be true of a fixture
  --    that had it all along.
  select amount_cents into v_equity_before from public.balance_sheet(v_shop, '2026-04-30')
   where section = 'equity' and is_total;
  if v_equity_before is distinct from 68100 then
    raise exception 'FAIL: total equity before the close is %, expected 68100', v_equity_before;
  end if;

  --    THE DEPRECIATION IS REALLY THERE, IN BOTH MONTHS, BEFORE ANYTHING
  --    CLOSES. Every assertion below about the add-back compares two figures
  --    that would both be zero if these entries were dropped, and 0 - 0 = 0 is
  --    exactly how the defect 20261004000100 fixes stayed invisible for a
  --    release. So pin the charge per month, off journal_lines, at source.
  select coalesce(sum(l.amount_cents) filter (where e.entry_date <= '2026-03-31'), 0),
         count(*)
    into v_amount, v_dep_lines
    from public.journal_lines l
    join public.journal_entries e on e.id = l.entry_id
    join public.accounts a on a.id = l.account_id
   where e.shop_id = v_shop and e.status in ('posted', 'reversed')
     and a.code = '6800';
  if v_dep_lines <> 2 or v_amount <> 600 then
    raise exception 'FAIL: the fixture must post depreciation in BOTH months -- % lines in 6800 totalling % up to 31 March, expected 2 and 600. Without a non-zero charge in the CLOSED month every add-back check below is 0 - 0 = 0 and proves nothing.',
      v_dep_lines, v_amount;
  end if;
  if (select coalesce(sum(l.amount_cents), 0) from public.journal_lines l
        join public.journal_entries e on e.id = l.entry_id
        join public.accounts a on a.id = l.account_id
       where e.shop_id = v_shop and e.status in ('posted', 'reversed')
         and a.code = '6800' and e.entry_date between '2026-04-01' and '2026-04-30') <> 500 then
    raise exception 'FAIL: the OPEN month must carry depreciation too, and a different figure from the closed month''s';
  end if;
  if (select amount_cents from public.balance_sheet(v_shop, '2026-04-30') where code = '3900')
     is distinct from 0 then
    raise exception 'FAIL: 3900 is % before anything has closed, expected 0',
      (select amount_cents from public.balance_sheet(v_shop, '2026-04-30') where code = '3900');
  end if;
  if (select amount_cents from public.statement_lines(v_shop, '2026-03-01', '2026-04-30')
       where section = 'net_profit') is distinct from 9800 then
    raise exception 'FAIL: the two months'' trading is %, expected 9800 (14100 profit less a 4300 loss)',
      (select amount_cents from public.statement_lines(v_shop, '2026-03-01', '2026-04-30') where section = 'net_profit');
  end if;

  -- ── THE CLOSE ─────────────────────────────────────────────────────────
  v_close := public.close_accounting_period(v_shop, v_mar);
  if v_close is null then
    raise exception 'FAIL: closing a month that traded returned no entry';
  end if;
  perform set_config('request.jwt.claims', json_build_object('sub', v_other)::text, true);
  perform public.close_accounting_period(v_shop_b, v_mar_b);
  perform set_config('request.jwt.claims', json_build_object('sub', v_user)::text, true);

  -- 2. THE CLOSING ENTRY IS WHAT IT CLAIMS TO BE: source 'close', dated the
  --    period's last day, and it really did zero the P&L accounts.
  if not exists (select 1 from public.journal_entries e
                  where e.id = v_close and e.shop_id = v_shop
                    and e.source = 'close' and e.status = 'posted'
                    and e.entry_date = '2026-03-31' and e.period_id = v_mar) then
    raise exception 'FAIL: the closing entry is not a posted source=''close'' entry dated 2026-03-31 in March''s period -- it is %',
      (select row(e.source, e.status, e.entry_date, e.period_id = v_mar)::text
         from public.journal_entries e where e.id = v_close);
  end if;

  --    Read straight off journal_lines INCLUDING closing entries, which is the
  --    only place the zeroing is visible: statement_lines() excludes them, so
  --    the income statement for March still reads 14700 -- which is the entire
  --    point of the decision and is asserted at check 5.
  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l
    join public.journal_entries e on e.id = l.entry_id
    join public.accounts a on a.id = l.account_id
   where e.shop_id = v_shop and e.status in ('posted', 'reversed')
     and e.entry_date between '2026-03-01' and '2026-03-31'
     and a.type in ('revenue', 'cost_of_sales', 'expense');
  if v_amount <> 0 then
    raise exception 'FAIL: March''s P&L accounts still hold % after the close -- a closing entry that does not zero them has done nothing', v_amount;
  end if;

  --    ...and it is not vacuously zero: March really did trade.
  if (select count(*) from public.journal_lines l
        join public.journal_entries e on e.id = l.entry_id
        join public.accounts a on a.id = l.account_id
       where e.shop_id = v_shop and e.entry_date between '2026-03-01' and '2026-03-31'
         and a.type in ('revenue', 'cost_of_sales', 'expense')) < 4 then
    raise exception 'FAIL: March has almost no P&L lines, so zeroing them proves nothing';
  end if;

  -- 3. 3900 HOLDS THE CLOSED MONTH'S PROFIT. A credit balance, presented
  --    positive in equity.
  select amount_cents into v_bs_retain from public.balance_sheet(v_shop, '2026-04-30')
   where code = '3900';
  if v_bs_retain is distinct from 14100 then
    raise exception 'FAIL: retained earnings reads %, expected March''s profit of 14100 (0 = the balance sheet excludes closing entries, -14100 = the sign is inverted)', v_bs_retain;
  end if;
  if (select label from public.balance_sheet(v_shop, '2026-04-30') where code = '3900')
     <> 'Retained earnings — prior periods' then
    raise exception 'FAIL: 3900 is not labelled as retained earnings from prior periods';
  end if;

  -- 4. A CLOSE IS EQUITY-NEUTRAL. It moves profit from the profit line into
  --    3900 and creates none. If this moves, the close invented money.
  select amount_cents into v_equity_after from public.balance_sheet(v_shop, '2026-04-30')
   where section = 'equity' and is_total;
  if v_equity_after is distinct from v_equity_before then
    raise exception 'FAIL: total equity was % before the close and % after, off by % -- a close moves profit within equity and must create none',
      v_equity_before, v_equity_after, v_equity_after - v_equity_before;
  end if;

  -- 5. THE INCOME STATEMENT STILL SHOWS THE SHOP'S TRADING. The whole reason
  --    for excluding source = 'close'. A window spanning the close reads
  --    14100 - 4300 = 9800, and March on its own still reads 14100.
  select amount_cents into v_is_profit from public.statement_lines(v_shop, '2026-03-01', '2026-04-30')
   where section = 'net_profit';
  if v_is_profit is distinct from 9800 then
    raise exception 'FAIL: the income statement spanning the close reads %, expected 9800. -4300 means closing entries are being counted and March vanished from its own income statement.', v_is_profit;
  end if;
  if (select amount_cents from public.statement_lines(v_shop, '2026-03-01', '2026-03-31')
       where section = 'net_profit') is distinct from 14100 then
    raise exception 'FAIL: March''s own income statement reads %, expected 14100 (0 = the closing entry is being counted)',
      (select amount_cents from public.statement_lines(v_shop, '2026-03-01', '2026-03-31') where section = 'net_profit');
  end if;
  --    ...and revenue is not netted to nothing either. Net profit could be
  --    right while the closing entry's debit to 4000 cancelled the sale.
  if (select amount_cents from public.statement_lines(v_shop, '2026-03-01', '2026-03-31')
       where section = 'revenue' and is_total) is distinct from 31000 then
    raise exception 'FAIL: March''s revenue reads %, expected 31000',
      (select amount_cents from public.statement_lines(v_shop, '2026-03-01', '2026-03-31')
        where section = 'revenue' and is_total);
  end if;

  -- =====================================================================
  -- 6. THE FIVE RECONCILIATIONS, OVER A WINDOW THAT SPANS THE CLOSE.
  -- =====================================================================
  select amount_cents into v_bs_profit from public.balance_sheet(v_shop, '2026-04-30')
   where section = 'equity' and label = 'Profit this period';
  select amount_cents into v_cf_profit from public.cash_flow(v_shop, '2026-03-01', '2026-04-30')
   where section = 'operating' and label = 'Net profit';

  --   Reconciliation 3's derivation, computed HERE off journal_lines and never
  --   calling statement_lines(). It excludes closing entries by the same rule
  --   and states it independently: a check that asks the same function twice
  --   and finds it agrees with itself proves nothing.
  select -coalesce(sum(l.amount_cents), 0)::bigint, count(*)
    into v_tb_profit, v_tb_lines
    from public.journal_lines l
    join public.journal_entries e on e.id = l.entry_id
    join public.accounts a on a.id = l.account_id
   where e.shop_id = v_shop
     and e.status in ('posted', 'reversed')
     and e.source <> 'close'
     and e.entry_date between '2026-03-01' and '2026-04-30'
     and a.type in ('revenue', 'cost_of_sales', 'expense');
  if v_tb_lines = 0 then
    raise exception 'FAIL: the independent derivation read no journal lines at all, so reconciliation 3 is vacuous';
  end if;

  select amount_cents into v_bs_assets from public.balance_sheet(v_shop, '2026-04-30')
   where section = 'total_assets';
  select amount_cents into v_bs_credits from public.balance_sheet(v_shop, '2026-04-30')
   where section = 'total_liabilities_equity';
  select coalesce(sum(amount_cents), 0) into v_bs_cash from public.balance_sheet(v_shop, '2026-04-30')
   where code in ('1000', '1010', '1020', '1021');
  select amount_cents into v_cf_cash from public.cash_flow(v_shop, '2026-03-01', '2026-04-30')
   where section = 'proof' and label like 'Cash at%' order by sort_order desc limit 1;

  if v_is_profit is null or v_bs_profit is null or v_cf_profit is null or v_bs_retain is null
     or v_bs_assets is null or v_bs_credits is null or v_cf_cash is null then
    raise exception 'FAIL: a figure the reconciliations need is missing -- income %, profit this period %, cash flow %, retained %, assets %, liabilities+equity %, closing cash %',
      v_is_profit, v_bs_profit, v_cf_profit, v_bs_retain, v_bs_assets, v_bs_credits, v_cf_cash;
  end if;

  -- 6.1 RECONCILIATION 1, IN THE FORM A CLOSE LEAVES TRUE.
  --
  --     "Income statement net profit = balance sheet Profit this period" holds
  --     only for a window starting after the last close, because after a close
  --     they are different quantities: one is what the shop traded, the other
  --     is what it has not yet retained. Both forms are asserted.
  --
  --     (a) the open period's own window, where the original form holds.
  if v_bs_profit is distinct from -4300 then
    raise exception 'FAIL: balance sheet "Profit this period" is %, expected April''s loss of -4300. 9800 means the closed profit is being counted twice -- once here and once in 3900.',
      v_bs_profit;
  end if;
  if (select amount_cents from public.statement_lines(v_shop, '2026-04-01', '2026-04-30')
       where section = 'net_profit') is distinct from v_bs_profit then
    raise exception 'FAIL: reconciliation 1 -- the open period''s income statement % against balance sheet profit this period %',
      (select amount_cents from public.statement_lines(v_shop, '2026-04-01', '2026-04-30') where section = 'net_profit'),
      v_bs_profit;
  end if;

  --     (b) the stronger form, which holds over the spanning window: everything
  --         the shop has ever earned is either retained or still in the profit
  --         line, and it is in exactly one of them.
  if v_bs_retain + v_bs_profit is distinct from v_is_profit then
    raise exception 'FAIL: reconciliation 1 -- retained earnings % plus profit this period % is %, but the shop''s all-time trading is %, off by %',
      v_bs_retain, v_bs_profit, v_bs_retain + v_bs_profit, v_is_profit,
      v_bs_retain + v_bs_profit - v_is_profit;
  end if;

  -- 6.2 Income statement net profit = the cash flow's operating opening line.
  if v_is_profit is distinct from v_cf_profit then
    raise exception 'FAIL: reconciliation 2 -- income statement net profit % against cash flow net profit %, off by %',
      v_is_profit, v_cf_profit, v_is_profit - v_cf_profit;
  end if;

  -- 6.3 Income statement net profit = the P&L accounts netted independently.
  if v_is_profit is distinct from v_tb_profit then
    raise exception 'FAIL: reconciliation 3 -- income statement net profit % against the trial balance netted independently %, off by % (over % journal lines)',
      v_is_profit, v_tb_profit, v_is_profit - v_tb_profit, v_tb_lines;
  end if;

  -- 6.4 Balance sheet total assets = total liabilities and equity.
  --
  --     THE ONE THAT CATCHES THE NAIVE READING. A balance sheet that simply
  --     excluded source = 'close' everywhere would count March's 14100 twice --
  --     in 3900 and in the profit line -- and be out by exactly that.
  if v_bs_assets is distinct from v_bs_credits then
    raise exception 'FAIL: reconciliation 4 -- total assets % against total liabilities and equity %, off by % (14100 = the closed profit counted twice)',
      v_bs_assets, v_bs_credits, v_bs_assets - v_bs_credits;
  end if;
  if v_bs_assets is distinct from 77600 then
    raise exception 'FAIL: the balance sheet balances at %, but the fixture''s assets are 77600 (41000 cash + 9000 receivables + 4700 stock + 24000 van - 1100 accumulated depreciation)', v_bs_assets;
  end if;

  -- 6.5 Cash flow closing cash = balance sheet cash.
  if v_cf_cash is distinct from v_bs_cash then
    raise exception 'FAIL: reconciliation 5 -- cash flow closing cash % against balance sheet cash %, off by %',
      v_cf_cash, v_bs_cash, v_cf_cash - v_bs_cash;
  end if;
  if v_cf_cash is distinct from 41000 then
    raise exception 'FAIL: both statements agree cash is %, but the fixture holds 41000', v_cf_cash;
  end if;

  -- 6.6 AND THE CASH FLOW STILL PROVES OUT ACROSS THE CLOSE.
  --
  --     The proof row is the observed movement in 1000/1010/1020/1021, reached
  --     by no part of the arithmetic above it. 3900 moved by -14700 in this
  --     window and NO cash-flow section reads 3900 -- verify-statements.sql
  --     check 28 predicted the statement would therefore fail by exactly that
  --     until it gained a section for it. It does not need one: excluding the
  --     closing entry from statement_lines() adds the same 14100 back into net
  --     profit, and the two cancel. That cancellation is what this asserts, and
  --     no residual line was added to make it true.
  --
  --     It also carries the DEPRECIATION load now. The add-back is 6800's
  --     movement and the close credits 6800; if the cash flow read the closing
  --     entry, March's 600 would be subtracted from net profit and never added
  --     back, and this row would fail by exactly 600. See the header.
  if (select amount_cents from public.cash_flow(v_shop, '2026-03-01', '2026-04-30') where section = 'net_change')
     is distinct from (select amount_cents from public.cash_flow(v_shop, '2026-03-01', '2026-04-30')
                        where section = 'proof' and label = 'Movement in cash accounts') then
    raise exception 'FAIL: the cash flow does not prove out across the close -- net change % against observed movement %, off by % (14100 = 3900''s movement is unaccounted; -600 = the closed month''s depreciation is subtracted twice, because the add-back reads 6800 through the closing entry that credited it)',
      (select amount_cents from public.cash_flow(v_shop, '2026-03-01', '2026-04-30') where section = 'net_change'),
      (select amount_cents from public.cash_flow(v_shop, '2026-03-01', '2026-04-30')
        where section = 'proof' and label = 'Movement in cash accounts'),
      (select amount_cents from public.cash_flow(v_shop, '2026-03-01', '2026-04-30') where section = 'net_change')
        - (select amount_cents from public.cash_flow(v_shop, '2026-03-01', '2026-04-30')
            where section = 'proof' and label = 'Movement in cash accounts');
  end if;
  if (select amount_cents from public.cash_flow(v_shop, '2026-03-01', '2026-04-30') where section = 'net_change')
     is distinct from 41000 then
    raise exception 'FAIL: net change in cash across the close is %, expected 41000',
      (select amount_cents from public.cash_flow(v_shop, '2026-03-01', '2026-04-30') where section = 'net_change');
  end if;

  --     AND THE ADD-BACK ITSELF, NAMED. The proof row above catches this
  --     defect, but only ever reports "off by 600" -- this says which line
  --     moved. Both months' depreciation is trading depreciation and the close
  --     is not allowed to net any of it away: 600 + 500.
  select amount_cents into v_cf_dep from public.cash_flow(v_shop, '2026-03-01', '2026-04-30')
   where section = 'operating' and label = 'Add back depreciation';
  if v_cf_dep is distinct from 1100 then
    raise exception 'FAIL: add back depreciation across the close reads %, expected 1100 (600 March + 500 April). 500 means the add-back is reading 6800 through the closing entry that credited it, so March''s 600 is subtracted from net profit and never added back.',
      v_cf_dep;
  end if;

  --     ...and NO residual line has appeared in the cash flow to make it tie.
  --     Five sections, and no sixth.
  if exists (select 1 from public.cash_flow(v_shop, '2026-03-01', '2026-04-30')
              where section not in ('operating', 'investing', 'financing', 'net_change', 'proof')) then
    raise exception 'FAIL: the cash flow has grown a section (%) -- a residual line makes the proof tautological and destroys the only check that can catch a sign error',
      (select string_agg(distinct section, ', ') from public.cash_flow(v_shop, '2026-03-01', '2026-04-30')
        where section not in ('operating', 'investing', 'financing', 'net_change', 'proof'));
  end if;

  -- 6.7 A WINDOW THAT IS ENTIRELY INSIDE THE CLOSED MONTH still proves out.
  --     The closing entry is dated 31 March, so this window contains it -- and
  --     this is the WORST case for the defect, not a milder one. Over the
  --     spanning window April's 500 keeps the add-back non-zero and the miss is
  --     600 out of 1100; here the close credits away the whole of the month's
  --     own charge, the add-back reads 0, and the statement is out by the
  --     entire 600. This is the reading a shop gets when it asks for the month
  --     it just closed, which is when anyone actually asks.
  if (select amount_cents from public.cash_flow(v_shop, '2026-03-01', '2026-03-31') where section = 'net_change')
     is distinct from (select amount_cents from public.cash_flow(v_shop, '2026-03-01', '2026-03-31')
                        where section = 'proof' and label = 'Movement in cash accounts') then
    raise exception 'FAIL: the cash flow for the closed month alone does not prove out -- net change % against observed movement %, off by % (-600 = the closed month''s own depreciation, subtracted in net profit and added back nowhere because the close credited 6800 to zero)',
      (select amount_cents from public.cash_flow(v_shop, '2026-03-01', '2026-03-31') where section = 'net_change'),
      (select amount_cents from public.cash_flow(v_shop, '2026-03-01', '2026-03-31')
        where section = 'proof' and label = 'Movement in cash accounts'),
      (select amount_cents from public.cash_flow(v_shop, '2026-03-01', '2026-03-31') where section = 'net_change')
        - (select amount_cents from public.cash_flow(v_shop, '2026-03-01', '2026-03-31')
            where section = 'proof' and label = 'Movement in cash accounts');
  end if;
  --     ...and the closed month's add-back is the month's OWN charge, whole.
  select amount_cents into v_cf_dep from public.cash_flow(v_shop, '2026-03-01', '2026-03-31')
   where section = 'operating' and label = 'Add back depreciation';
  if v_cf_dep is distinct from 600 then
    raise exception 'FAIL: add back depreciation for the closed month read on its own is %, expected 600. 0 is the defect: the closing entry credited 6800 by the month''s balance and the add-back netted itself away, while net profit still carries the cost.',
      v_cf_dep;
  end if;
  --     Both figures pinned, so the proof-row check above cannot be satisfied
  --     by a window in which nothing happened.
  if (select amount_cents from public.cash_flow(v_shop, '2026-03-01', '2026-03-31') where section = 'net_change')
     is distinct from 42700 then
    raise exception 'FAIL: net change in cash for the closed month is %, expected 42700',
      (select amount_cents from public.cash_flow(v_shop, '2026-03-01', '2026-03-31') where section = 'net_change');
  end if;
  --     The investing line is non-zero across the close too. A close touches
  --     only revenue, cost_of_sales, expense and 3900, so it must not move
  --     this -- and an assertion that the van is still there passes for a
  --     reason rather than because the line was empty.
  if (select amount_cents from public.cash_flow(v_shop, '2026-03-01', '2026-04-30')
       where section = 'investing' and is_total) is distinct from -24000 then
    raise exception 'FAIL: cash used in investing across the close is %, expected -24000 (the van). 0 = the fixed-asset range stopped being read; -24600 = 1590 is being counted as investing and the depreciation is in there twice.',
      (select amount_cents from public.cash_flow(v_shop, '2026-03-01', '2026-04-30')
        where section = 'investing' and is_total);
  end if;

  -- =====================================================================
  -- 7. THE SECOND SHOP. It closed a month too, and its closed month made a
  --    LOSS -- so 3900 carries a DEBIT balance and presents negative. A sign
  --    error in the 3900 line that a profit hides shows up here.
  --
  --      1000 Cash   88000 - 5900 + 12300 = 94400 = total assets
  --      3000 Capital                       88000
  --      3900 Retained (March's loss)       -5900
  --      Profit this period (April)         12300
  --      TOTAL L + E                        94400
  -- =====================================================================
  perform set_config('request.jwt.claims', json_build_object('sub', v_other)::text, true);

  if (select amount_cents from public.balance_sheet(v_shop_b, '2026-04-30') where code = '3900')
     is distinct from -5900 then
    raise exception 'FAIL: the other shop''s retained earnings is %, expected -5900 (a closed month that LOST money puts a debit in 3900); 5900 means the sign is inverted',
      (select amount_cents from public.balance_sheet(v_shop_b, '2026-04-30') where code = '3900');
  end if;
  if (select amount_cents from public.balance_sheet(v_shop_b, '2026-04-30')
       where section = 'equity' and label = 'Profit this period') is distinct from 12300 then
    raise exception 'FAIL: the other shop''s profit this period is %, expected 12300',
      (select amount_cents from public.balance_sheet(v_shop_b, '2026-04-30')
        where section = 'equity' and label = 'Profit this period');
  end if;
  if (select amount_cents from public.balance_sheet(v_shop_b, '2026-04-30') where section = 'total_assets')
     is distinct from (select amount_cents from public.balance_sheet(v_shop_b, '2026-04-30')
                        where section = 'total_liabilities_equity') then
    raise exception 'FAIL: the other shop''s balance sheet does not balance across its close -- % against %',
      (select amount_cents from public.balance_sheet(v_shop_b, '2026-04-30') where section = 'total_assets'),
      (select amount_cents from public.balance_sheet(v_shop_b, '2026-04-30') where section = 'total_liabilities_equity');
  end if;
  if (select amount_cents from public.balance_sheet(v_shop_b, '2026-04-30') where section = 'total_assets')
     is distinct from 94400 then
    raise exception 'FAIL: the other shop''s total assets is %, expected 94400',
      (select amount_cents from public.balance_sheet(v_shop_b, '2026-04-30') where section = 'total_assets');
  end if;
  if (select amount_cents from public.statement_lines(v_shop_b, '2026-03-01', '2026-04-30')
       where section = 'net_profit') is distinct from 6400 then
    raise exception 'FAIL: the other shop''s trading across the close is %, expected 6400',
      (select amount_cents from public.statement_lines(v_shop_b, '2026-03-01', '2026-04-30') where section = 'net_profit');
  end if;
  if (select amount_cents from public.cash_flow(v_shop_b, '2026-03-01', '2026-04-30') where section = 'net_change')
     is distinct from (select amount_cents from public.cash_flow(v_shop_b, '2026-03-01', '2026-04-30')
                        where section = 'proof' and label = 'Movement in cash accounts') then
    raise exception 'FAIL: the other shop''s cash flow does not prove out across its close -- % against %',
      (select amount_cents from public.cash_flow(v_shop_b, '2026-03-01', '2026-04-30') where section = 'net_change'),
      (select amount_cents from public.cash_flow(v_shop_b, '2026-03-01', '2026-04-30')
        where section = 'proof' and label = 'Movement in cash accounts');
  end if;

  perform set_config('request.jwt.claims', json_build_object('sub', v_user)::text, true);

  -- 8. AND SHOP A IS UNMOVED BY ALL OF IT. Re-read after the other shop traded
  --    and closed. Every one of these is pinned above; re-asserting them here
  --    is what makes the second shop a leak detector rather than decoration.
  if (select amount_cents from public.balance_sheet(v_shop, '2026-04-30') where code = '3900')
     is distinct from 14100
     or (select amount_cents from public.balance_sheet(v_shop, '2026-04-30') where section = 'total_assets')
        is distinct from 77600
     or (select amount_cents from public.statement_lines(v_shop, '2026-03-01', '2026-04-30')
          where section = 'net_profit') is distinct from 9800 then
    raise exception 'FAIL: shop A''s figures moved when the other shop closed a month -- retained %, assets %, profit %',
      (select amount_cents from public.balance_sheet(v_shop, '2026-04-30') where code = '3900'),
      (select amount_cents from public.balance_sheet(v_shop, '2026-04-30') where section = 'total_assets'),
      (select amount_cents from public.statement_lines(v_shop, '2026-03-01', '2026-04-30') where section = 'net_profit');
  end if;

  -- 9. RE-OPENING PUTS EVERYTHING BACK. The reversal carries source = 'close'
  --    too, so both halves stay invisible to the income statement -- and if the
  --    reversal were filed as 'manual' (which is what reverse_journal_entry
  --    would have done) it would land in the income statement as trading and
  --    March would report its profit INVERTED.
  perform public.reopen_accounting_period(v_shop, v_mar, 'The March stock count came in late');

  if (select amount_cents from public.balance_sheet(v_shop, '2026-04-30') where code = '3900')
     is distinct from 0 then
    raise exception 'FAIL: retained earnings is % after re-opening March, expected 0 -- the reversal must undo the roll',
      (select amount_cents from public.balance_sheet(v_shop, '2026-04-30') where code = '3900');
  end if;
  if (select amount_cents from public.statement_lines(v_shop, '2026-03-01', '2026-03-31')
       where section = 'net_profit') is distinct from 14100 then
    raise exception 'FAIL: March''s income statement reads % after a close and a re-open, expected 14100. -14100 means the reversal was filed under a source the income statement reads.',
      (select amount_cents from public.statement_lines(v_shop, '2026-03-01', '2026-03-31') where section = 'net_profit');
  end if;
  if (select amount_cents from public.balance_sheet(v_shop, '2026-04-30')
       where section = 'equity' and label = 'Profit this period') is distinct from 9800 then
    raise exception 'FAIL: profit this period is % after re-opening March, expected 9800 -- nothing is retained any more',
      (select amount_cents from public.balance_sheet(v_shop, '2026-04-30')
        where section = 'equity' and label = 'Profit this period');
  end if;
  if (select amount_cents from public.balance_sheet(v_shop, '2026-04-30') where section = 'total_assets')
     is distinct from (select amount_cents from public.balance_sheet(v_shop, '2026-04-30')
                        where section = 'total_liabilities_equity') then
    raise exception 'FAIL: the balance sheet stopped balancing after a re-open -- % against %',
      (select amount_cents from public.balance_sheet(v_shop, '2026-04-30') where section = 'total_assets'),
      (select amount_cents from public.balance_sheet(v_shop, '2026-04-30') where section = 'total_liabilities_equity');
  end if;
  if (select amount_cents from public.cash_flow(v_shop, '2026-03-01', '2026-04-30') where section = 'net_change')
     is distinct from (select amount_cents from public.cash_flow(v_shop, '2026-03-01', '2026-04-30')
                        where section = 'proof' and label = 'Movement in cash accounts') then
    raise exception 'FAIL: the cash flow stopped proving out after a re-open -- % against %',
      (select amount_cents from public.cash_flow(v_shop, '2026-03-01', '2026-04-30') where section = 'net_change'),
      (select amount_cents from public.cash_flow(v_shop, '2026-03-01', '2026-04-30')
        where section = 'proof' and label = 'Movement in cash accounts');
  end if;

  -- 10. AND CLOSING IT AGAIN LANDS ON THE SAME FIGURE, not on double.
  perform public.close_accounting_period(v_shop, v_mar);
  if (select amount_cents from public.balance_sheet(v_shop, '2026-04-30') where code = '3900')
     is distinct from 14100 then
    raise exception 'FAIL: retained earnings is % after close, re-open, close, expected 14100 (28200 = the second close counted the first one''s entry as trading)',
      (select amount_cents from public.balance_sheet(v_shop, '2026-04-30') where code = '3900');
  end if;
  if (select amount_cents from public.balance_sheet(v_shop, '2026-04-30') where section = 'total_assets')
     is distinct from (select amount_cents from public.balance_sheet(v_shop, '2026-04-30')
                        where section = 'total_liabilities_equity') then
    raise exception 'FAIL: the balance sheet stopped balancing after a re-close';
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
