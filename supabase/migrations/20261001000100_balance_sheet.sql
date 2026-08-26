-- The balance sheet, which balances because every entry does.
--
-- ## As-at a date, never over a range
--
-- statement_lines() takes p_from and p_to because an income statement is a
-- period: it answers "what happened between these dates". A balance sheet
-- answers "what is true right now", so it takes ONE date and sums EVERY posted
-- line from the beginning of the shop's history up to and including it. There
-- is no lower bound anywhere in this function, and there must not be: a
-- balance sheet windowed to a month would report the month's MOVEMENT in each
-- account and call it a balance, which is a different report entirely and one
-- that still balances, so nothing would look wrong.
--
-- ## Signs
--
-- journal_lines is debit-positive. Assets carry debit balances and already sum
-- positive, so they are presented UNTOUCHED. Liabilities and equity carry
-- credit balances and sum NEGATIVE, so they are NEGATED to present positive.
--
-- A contra account keeps its ledger sign AFTER whatever its section does,
-- which is the whole of what contra means and needs no reference to
-- accounts.is_contra:
--
--   * 1590 Accumulated Depreciation is a CREDIT inside assets, which are not
--     flipped, so it presents negative and reduces fixed assets. Correct.
--   * 3100 Owner's Draw is a DEBIT inside equity, which IS flipped, so it
--     presents negative and reduces equity. Correct.
--
-- Both fall out of the two rules above. Special-casing is_contra here would
-- produce a sheet that reads plausibly and does not balance.
--
-- ## Fixed vs current is decided by a CODE RANGE, and this is the one place
-- ## in this codebase where that is right
--
-- Everywhere else -- statement_lines() most recently -- sections are derived
-- from accounts.type and never from a hardcoded list of codes, so that a shop
-- can add its own account and have it land in the right section without a
-- migration. Here that rule cannot be followed, because `type` does not carry
-- the distinction: 1000 Cash and 1500 Equipment are both 'asset', and a
-- balance sheet that could not tell them apart would be wrong in the one way
-- an owner notices immediately.
--
-- So 1500-1599 is fixed and every other asset is current. It follows the
-- numbering convention the chart is built on (20260904000100: "1000s assets,
-- 2000s liabilities..."), a shop adding a fixed asset numbers it in the 1500s
-- like every accountant expects, and the alternative -- a `is_fixed` column on
-- accounts -- is a schema change carrying information the code already states.
--
-- ## Equity has four rows and only three come from account balances
--
--   3000 Owner's Capital              an account
--   3100 Owner's Draw                 an account, contra, negative
--   Retained earnings - prior periods  3900's balance
--   Profit this period                statement_lines()'s net profit
--
-- The last one CALLS statement_lines() rather than re-deriving revenue less
-- costs inline. That is deliberate and it is the same argument that made P&L
-- and Income Statement one query: two derivations of the same figure agree
-- until they don't, and then nobody knows which report is right. The one that
-- would be wrong here is this one, because an inline version has to remember
-- cost_of_sales -- including 5100 Inventory Shrinkage -- and a version that
-- forgets it reports a profit too high by exactly the shrinkage, forever.
--
-- statement_lines() is called with a lower bound of -infinity, which is the
-- correct bound BOTH before and after phase 3b ships the period close, for a
-- reason worth stating: a closing entry ZEROES the revenue and expense
-- accounts against 3900, so once a period is closed the all-time income
-- statement reports only the profit earned since. The lower bound never has to
-- move. Until 3b ships, no shop has closed anything, 3900 is zero for every
-- shop, and the whole profit sits in "profit this period" -- which is correct
-- and complete, not missing.
--
-- ## Zero rows are suppressed, except in equity
--
-- The seeded chart gives every shop thirty accounts and most shops will touch
-- eight. A balance sheet listing twenty-two zeroes is one nobody reads. The
-- four equity rows are always emitted regardless, because they are the shape
-- of the section and a reader looking for the draw needs to see that it is
-- nil rather than wonder whether it was dropped. Section TOTALS are computed
-- over every account, so suppression can never move a total.
--
-- ## Two implementation notes carried over from statement_lines()
--
-- 1. Every internal column is renamed so it cannot collide with an OUT
--    parameter of the RETURNS TABLE clause -- `where section = ...` inside the
--    body would be ambiguous between a CTE column and the OUT variable, and
--    plpgsql raises on that at RUN time, not at CREATE time.
-- 2. sum(bigint) returns NUMERIC and the declared columns are bigint, so every
--    aggregate is cast explicitly. Without it the function creates cleanly and
--    fails on its first call.

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

  return query
  with posted as (
    -- 'posted' AND 'reversed', matching statement_lines() exactly: a reversed
    -- entry's own lines still stand and its reversal cancels them. Two reports
    -- reading the ledger through different status filters would disagree while
    -- both balanced.
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
  'The balance sheet as at p_as_of, summing every posted and reversed line from the beginning of the shop''s history with no lower bound. Assets present as they sit in the ledger; liabilities and equity are negated out of their credit balances. Fixed assets are codes 1500-1599 -- the one place in this codebase a code range decides a section, because accounts.type does not carry the distinction. Profit this period is statement_lines()''s net profit, called rather than re-derived. Gated on ledger.view, which is the only protection: security definer bypasses RLS.';
