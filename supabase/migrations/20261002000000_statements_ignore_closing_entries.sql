-- A close is a bookkeeping act, not an economic event — so the statements
-- ignore it. Almost.
--
-- ## What a closing entry is
--
-- Dr every revenue account by its balance, Cr every cost_of_sales and expense
-- account by its balance, and the difference to 3900 Retained Earnings. After
-- it, every P&L account for that period reads zero and the period's profit sits
-- in equity where it belongs. Nothing happened in the shop. No cash moved, no
-- stock moved, nobody was owed anything.
--
-- ## The two candidates, and what each does to the five reconciliations
--
-- The five, as verify-statements.sql check 26 states them:
--
--   1. income statement net profit  =  balance sheet "Profit this period"
--   2. income statement net profit  =  cash flow's operating opening line
--   3. income statement net profit  =  revenue + cost_of_sales + expense,
--                                      netted independently off journal_lines
--   4. balance sheet total assets   =  total liabilities and equity
--   5. cash flow closing cash       =  balance sheet cash
--
-- Take a shop trading P1 in month one and P2 in month two, with month one
-- closed. Read every statement over a window spanning both.
--
-- All three columns below were MEASURED, not reasoned about: the same fixture
-- was run against each candidate. P1 = 14700 (a profit), P2 = -3800 (a loss).
--
-- ### (b) Count closing entries; give 3900 its own cash-flow section
--
--   1. IS net profit reads -3800 — P2 alone. The closing entry's debits to
--      revenue and credits to expense cancel month one exactly. Balance sheet
--      "Profit this period" also reads -3800, so the two AGREE. They agree on a
--      figure that is wrong: an income statement for March–April reports April.
--      There is no window a reader can ask for that shows March's trading
--      again. The stronger form (retained + profit = all-time trading) reads
--      14700 + -3800 = 10900 against an income statement of -3800: BREAKS.
--   2. Holds, trivially: cash_flow calls statement_lines, so it inherits the
--      same wrong number and prints it.
--   3. BREAKS: -3800 against 10900 netted independently. It can only be made to
--      hold by teaching the independent derivation to count closing entries
--      too — at which point reconciliation 3 has stopped being independent of
--      the decision it is meant to check.
--   4. Holds.
--   5. Holds; a close touches no cash account.
--   THE PROOF. Measured at net change 60000 against an observed cash movement
--      of 74700 — BREAKS by exactly P1, which is what the extra 3900 section is
--      for. With the section it ties, and the statement then carries a
--      financing line reporting 14700 of movement in a report whose subject is
--      cash that did not move. There is no honest label for that row.
--
-- ### (a) The statements exclude source = 'close'
--
--   1. IS net profit reads 10900 = P1 + P2. Balance sheet "Profit this period"
--      reads -3800 — the rest is retained. They DISAGREE over a spanning
--      window, and correctly so: after a close those are two different
--      quantities. Over the OPEN period's own window they agree exactly, and
--      the stronger form holds: 14700 + -3800 = 10900 = all-time trading.
--   2. Holds exactly, for any window: cash_flow's opening line IS
--      statement_lines'.
--   3. Holds, against a derivation that excludes closing entries — which is a
--      real independent statement of the same rule rather than a restatement of
--      the implementation.
--   4. Holds, PROVIDED the balance sheet's profit line is fixed as well. See
--      the next section.
--   5. Holds.
--   THE PROOF ties, with no new section. See "cash_flow() IS NOT TOUCHED".
--
-- (a) is chosen. It is the only one of the two that leaves an income statement
-- spanning a close readable, and the proof, reconciliation 2, 3 and 5 fall out
-- of it with no further work.
--
-- ## THE CORRECTION: what "the balance sheet excludes closing entries" costs
--
-- The plan says "all three statement functions must exclude source = 'close'".
-- Applied literally to balance_sheet() it means one of two things, and BOTH
-- were measured:
--
--   (i) exclude them EVERYWHERE in the balance sheet — from the account
--       balances as well as from the profit line. All five reconciliations then
--       tie. They tie because the close has become completely invisible: 3900
--       reads 0 forever and "Profit this period" reads all-time trading, so the
--       sheet is byte-identical to a shop that never closed anything. The one
--       line phase 3b exists to produce — "Retained earnings — prior periods",
--       not zero — can never be produced, and reconciliation 1's original form
--       holds over the SPANNING window while breaking over the open period's
--       own. Nothing is wrong; nothing has happened either.
--
--  (ii) exclude them from the profit line but keep 3900 as the ledger holds it,
--       which is the only version that reports retained earnings at all.
--       Reconciliation 4 then BREAKS by exactly the amount closed — measured at
--       total equity of 83900 against 69200 — because the closed profit is
--       counted twice, once in 3900 and once in the profit line.
--
-- So the balance sheet needs a third thing, which is what this migration does.
-- The arithmetic, in ledger signs (debit positive):
--
--   Every entry sums to zero, so over any set of posted lines
--       A + L + Q + R = 0
--   where A is the assets, L the liabilities, Q the equity accounts and R the
--   P&L accounts. The balance sheet presents assets as A, liabilities as -L,
--   equity accounts as -Q, and "Profit this period" as some v_profit. It
--   balances exactly when
--       A  =  -L - Q + v_profit,   i.e. when   v_profit = -R.
--
--   -R over the whole of history INCLUDING closing entries is the profit that
--   has not yet been retained, because a closing entry's P&L lines are exactly
--   the negation of what it moved into 3900. -R EXCLUDING them is all-time
--   trading profit, which after a close is too big by exactly the amount now
--   sitting in 3900 — and 3900's balance is in -Q as well. The closed profit
--   would be counted twice and the sheet would be out by P1.
--
-- So the balance sheet reads 3900 as it stands in the ledger — closing entries
-- and all, which is the whole point of the line "Retained earnings — prior
-- periods" — and its profit line is all-time trading profit LESS what has
-- already been closed away. Both halves come from the same closing entries, so
-- they cannot drift.
--
-- ## What replaces reconciliation 1 after a close
--
-- "Income statement net profit = balance sheet Profit this period" is true only
-- for a window that starts after the last close. Spanning a close, the true
-- statement is the stronger one:
--
--   income statement net profit (all time)
--     = balance sheet "Retained earnings — prior periods" + "Profit this period"
--
-- — for a shop whose 3900 has moved only through closing entries. That is what
-- verify-statements-across-a-close.sql asserts, in both forms.
--
-- ## cash_flow() IS NOT TOUCHED BY THIS MIGRATION, and that is a result
--
-- verify-statements.sql check 28 predicts that "any cash-flow window spanning a
-- close will fail here by exactly the amount closed until the statement gains a
-- section for it". It does not need one. Working the proof through:
--
--   net change =  m_cash + m_1590 + m_6800 + m_3900 + m_Rclose + (anything else
--                 no section reads)
--
-- where m_X is X's movement over the window. m_1590 + m_6800 cancel for a
-- depreciation pair, as they always did. And m_3900 + m_Rclose cancel too:
-- 3900's movement is -P1 and the P&L side of the same closing entry is +P1,
-- and +P1 is precisely what excluding the entry from statement_lines() ADDS
-- BACK to net profit. The exclusion in statement_lines() is what pays for
-- 3900's movement in the cash flow. A dedicated section would double-count it.
--
-- The residual set check 28 is built on is therefore unchanged — {2300, and
-- anything a shop adds itself} — so its negative test stays red where it
-- should. That check must stay green, and it does.
--
-- ## What this does NOT change
--
-- The status filter (`posted`, `reversed`, never `draft`), the shop_id
-- scoping, the signs, the sections, the grants, the gates. Both functions are
-- reproduced in full per this repo's convention rather than patched, so the
-- newest definition is the whole of it.

-- ── statement_lines(): the income statement never counts a closing entry ────
--
-- One added predicate, `e.source <> 'close'`, and it is the whole of the
-- decision. A reversal of a closing entry also carries source = 'close' (see
-- 20261002000100 — reopen builds its reversal inline rather than through
-- reverse_journal_entry, which would have filed it as 'manual' and let a
-- reopened month's reversal land in the income statement as trading), so a
-- closed-then-reopened period is invisible here in both halves.
create or replace function public.statement_lines(
  p_shop_id uuid,
  p_from date,
  p_to date,
  p_detail boolean default false
) returns table (
  section text,
  code text,
  label text,
  amount_cents bigint,
  is_total boolean,
  sort_order integer
)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
begin
  if not public.has_shop_permission(p_shop_id, 'ledger.view') then
    raise exception 'You do not have permission to see the books.' using errcode = 'P0001';
  end if;

  return query
  with posted as (
    -- 'posted' AND 'reversed': a reversed entry's own lines still stand and
    -- its reversal cancels them. Excluding 'reversed' would leave the
    -- correction in and the original out. 'draft' is excluded, matching the
    -- trial balance (src/lib/ledger.ts).
    select a.type as acct_type, a.code as acct_code, a.name as acct_name, l.amount_cents as amt
      from public.journal_lines l
      join public.journal_entries e on e.id = l.entry_id
      join public.accounts a on a.id = l.account_id
     where e.shop_id = p_shop_id
       and e.status in ('posted', 'reversed')
       -- A CLOSING ENTRY IS NOT TRADING. Without this, an income statement for
       -- any window containing a close reads near zero: the closing entry
       -- debits every revenue account and credits every expense account by
       -- exactly their balances, and the shop's real trading vanishes from its
       -- own income statement. See this migration's header.
       and e.source <> 'close'
       and e.entry_date between p_from and p_to
  ),
  by_account as (
    select (case p.acct_type
              when 'revenue' then 'revenue'
              when 'cost_of_sales' then 'cost_of_sales'
              when 'expense' then 'operating_expenses'
            end)::text as sec,
           p.acct_code, p.acct_name,
           -- The sign flip. Revenue credits are negative in the ledger and
           -- positive on the statement; costs are already positive.
           (case when p.acct_type = 'revenue' then -sum(p.amt)
                 else sum(p.amt) end)::bigint as amt
      from posted p
     where p.acct_type in ('revenue', 'cost_of_sales', 'expense')
     group by p.acct_type, p.acct_code, p.acct_name
  ),
  by_section as (
    select b.sec, sum(b.amt)::bigint as amt from by_account b group by b.sec
  )
  select * from (
    -- Per-account rows, only when detail was asked for.
    select b.sec, b.acct_code, b.acct_name, b.amt, false,
           (case b.sec when 'revenue' then 100
                       when 'cost_of_sales' then 300
                       else 600 end) + 1
      from by_account b
     where p_detail

    union all
    select 'revenue', null, 'Net revenue',
           coalesce((select s.amt from by_section s where s.sec = 'revenue'), 0), true, 200
    union all
    select 'cost_of_sales', null, 'Cost of sales',
           coalesce((select s.amt from by_section s where s.sec = 'cost_of_sales'), 0), true, 400
    union all
    select 'gross_profit', null, 'Gross profit',
           coalesce((select s.amt from by_section s where s.sec = 'revenue'), 0)
             - coalesce((select s.amt from by_section s where s.sec = 'cost_of_sales'), 0),
           true, 500
    union all
    select 'operating_expenses', null, 'Total operating expenses',
           coalesce((select s.amt from by_section s where s.sec = 'operating_expenses'), 0), true, 700
    union all
    select 'net_profit', null, 'Net profit',
           coalesce((select s.amt from by_section s where s.sec = 'revenue'), 0)
             - coalesce((select s.amt from by_section s where s.sec = 'cost_of_sales'), 0)
             - coalesce((select s.amt from by_section s where s.sec = 'operating_expenses'), 0),
           true, 800
  ) r (section, code, label, amount_cents, is_total, sort_order)
  order by r.sort_order, r.code nulls last;
end;
$$;

grant execute on function public.statement_lines(uuid, date, date, boolean) to authenticated;

comment on function public.statement_lines(uuid, date, date, boolean) is
  'The income statement between p_from and p_to, summary or per-account. Grouped by accounts.type, presented in statement signs. Excludes source = ''close'': a closing entry is a bookkeeping act, not trading, and counting it makes any window spanning a close read near zero. Gated on ledger.view, which is the only protection: security definer bypasses RLS.';

-- ── balance_sheet(): retained earnings, and the profit not yet retained ────
--
-- Reproduced in full from 20261001000100. The ONLY change is the two
-- statements that compute v_profit, and the header note above them.
create or replace function public.balance_sheet(
  p_shop_id uuid,
  p_as_of date
) returns table (
  section text,
  code text,
  label text,
  amount_cents bigint,
  is_total boolean,
  sort_order integer
)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare
  v_profit bigint;
  v_closed bigint;
begin
  -- security definer means RLS on journal_lines does not apply, so this check
  -- is the only thing between a stranger and another shop's books. It is not
  -- redundant with the identical gate inside statement_lines(): that one is
  -- reached only because this function happens to call it today.
  if not public.has_shop_permission(p_shop_id, 'ledger.view') then
    raise exception 'You do not have permission to see the books.' using errcode = 'P0001';
  end if;

  select s.amount_cents into v_profit
    from public.statement_lines(p_shop_id, '-infinity'::date, p_as_of) s
   where s.section = 'net_profit';
  v_profit := coalesce(v_profit, 0);

  -- WHAT HAS ALREADY BEEN CLOSED AWAY, in ledger sign: the P&L side of every
  -- closing entry up to p_as_of. statement_lines() no longer counts those, so
  -- the figure above is ALL-TIME TRADING PROFIT — and after a close that is too
  -- big by exactly the amount now sitting in 3900, which the equity section
  -- below also reports. Subtracting it here is what keeps total assets equal to
  -- total liabilities and equity. See this migration's header for the algebra.
  --
  -- Read as the P&L side of the closing entries rather than as 3900's balance,
  -- and the difference matters: a shop that carried pre-kaiibi retained
  -- earnings in via an 'opening' entry has a 3900 balance that was never
  -- anybody's trading profit here, and subtracting THAT would understate the
  -- profit line by it. This subtracts only what this ledger closed.
  --
  -- A closing entry's own reversal (a reopen) is also source = 'close', so a
  -- closed-then-reopened period nets to zero here and the profit comes back.
  select coalesce(sum(l.amount_cents), 0)::bigint into v_closed
    from public.journal_lines l
    join public.journal_entries e on e.id = l.entry_id
    join public.accounts a on a.id = l.account_id
   where e.shop_id = p_shop_id
     and e.status in ('posted', 'reversed')
     and e.source = 'close'
     and e.entry_date <= p_as_of
     and a.type in ('revenue', 'cost_of_sales', 'expense');
  v_profit := v_profit - v_closed;

  return query
  with posted as (
    -- 'posted' AND 'reversed', matching statement_lines() exactly: a reversed
    -- entry's own lines still stand and its reversal cancels them. Two reports
    -- reading the ledger through different status filters would disagree while
    -- both balanced.
    --
    -- NO source filter, unlike statement_lines(). This CTE reads only asset,
    -- liability and equity accounts, and a closing entry's line on 3900 is the
    -- retained earnings the sheet exists to report. Excluding it here would
    -- leave "Retained earnings — prior periods" reading zero forever, which is
    -- the one line an accountant looks at to know the books have ever closed.
    select l.account_id as acct_id, l.amount_cents as amt
      from public.journal_lines l
      join public.journal_entries e on e.id = l.entry_id
     where e.shop_id = p_shop_id
       and e.status in ('posted', 'reversed')
       and e.entry_date <= p_as_of      -- and NO lower bound. See the header.
  ),
  balances as (
    -- LEFT JOIN, so an account with no lines at all still has a row at zero.
    -- The four equity rows depend on it.
    select a.type as acct_type, a.code as acct_code, a.name as acct_name,
           coalesce(sum(p.amt), 0)::bigint as ledger_amt
      from public.accounts a
      left join posted p on p.acct_id = a.id
     where a.shop_id = p_shop_id
       and a.type in ('asset', 'liability', 'equity')
     group by a.type, a.code, a.name
  ),
  by_account as (
    select (case when b.acct_type = 'asset' and b.acct_code between '1500' and '1599'
                   then 'fixed_assets'
                 when b.acct_type = 'asset' then 'current_assets'
                 when b.acct_type = 'liability' then 'liabilities'
                 else 'equity' end)::text as sec,
           b.acct_code, b.acct_name,
           -- The flip, and the whole of it. Assets as they are; liabilities
           -- and equity negated out of their credit balances.
           (case when b.acct_type = 'asset' then b.ledger_amt
                 else -b.ledger_amt end)::bigint as amt
      from balances b
  ),
  by_section as (
    -- Over EVERY account including the zeroes, so that suppressing zero rows
    -- below can never change a total.
    select b.sec, sum(b.amt)::bigint as amt from by_account b group by b.sec
  )
  select * from (
    select b.sec, b.acct_code, b.acct_name, b.amt, false, 101
      from by_account b
     where b.sec = 'current_assets' and b.amt <> 0
    union all
    select 'current_assets', null, 'Total current assets',
           coalesce((select s.amt from by_section s where s.sec = 'current_assets'), 0), true, 200

    union all
    select b.sec, b.acct_code, b.acct_name, b.amt, false, 301
      from by_account b
     where b.sec = 'fixed_assets' and b.amt <> 0
    union all
    select 'fixed_assets', null, 'Total fixed assets',
           coalesce((select s.amt from by_section s where s.sec = 'fixed_assets'), 0), true, 400

    union all
    select 'total_assets', null, 'Total assets',
           coalesce((select s.amt from by_section s where s.sec = 'current_assets'), 0)
             + coalesce((select s.amt from by_section s where s.sec = 'fixed_assets'), 0),
           true, 500

    union all
    select b.sec, b.acct_code, b.acct_name, b.amt, false, 601
      from by_account b
     where b.sec = 'liabilities' and b.amt <> 0
    union all
    select 'liabilities', null, 'Total liabilities',
           coalesce((select s.amt from by_section s where s.sec = 'liabilities'), 0), true, 700

    union all
    -- Every equity account with a balance, plus 3000/3100/3900 whether or not
    -- they have one. A shop that adds its own equity account is included, or
    -- the sheet would stop balancing by exactly that account.
    select b.sec, b.acct_code,
           (case when b.acct_code = '3900' then 'Retained earnings — prior periods'
                 else b.acct_name end),
           b.amt, false, 801
      from by_account b
     where b.sec = 'equity' and (b.amt <> 0 or b.acct_code in ('3000', '3100', '3900'))
    union all
    select 'equity', null, 'Profit this period', v_profit, false, 801
    union all
    select 'equity', null, 'Total equity',
           coalesce((select s.amt from by_section s where s.sec = 'equity'), 0) + v_profit, true, 900

    union all
    select 'total_liabilities_equity', null, 'Total liabilities and equity',
           coalesce((select s.amt from by_section s where s.sec = 'liabilities'), 0)
             + coalesce((select s.amt from by_section s where s.sec = 'equity'), 0)
             + v_profit,
           true, 1000
  ) r (section, code, label, amount_cents, is_total, sort_order)
  -- code nulls last puts 'Profit this period' after the three numbered equity
  -- accounts, which is the order the mockup reads in.
  order by r.sort_order, r.code nulls last;
end;
$$;

grant execute on function public.balance_sheet(uuid, date) to authenticated;

comment on function public.balance_sheet(uuid, date) is
  'The balance sheet as at p_as_of, summing every posted and reversed line from the beginning of the shop''s history with no lower bound. Assets present as they sit in the ledger; liabilities and equity are negated out of their credit balances. Fixed assets are codes 1500-1599 -- the one place in this codebase a code range decides a section, because accounts.type does not carry the distinction. "Retained earnings — prior periods" is 3900 as the ledger holds it, closing entries included. "Profit this period" is statement_lines()''s all-time net profit -- which excludes closing entries -- LESS the P&L side of every closing entry, so profit already retained is reported once, in equity, and not twice. Gated on ledger.view, which is the only protection: security definer bypasses RLS.';
