-- The cash flow ignores a close too, and it always had to.
--
-- ## The claim that was wrong
--
-- 20261002000000 concluded that `cash_flow()` needed no change for phase 3b:
--
--     "m_3900 + m_Rclose cancel too: 3900's movement is -P1 and the P&L side of
--      the same closing entry is +P1, and +P1 is precisely what excluding the
--      entry from statement_lines() ADDS BACK to net profit."
--
-- The premise is true and the conclusion does not follow, because that
-- decomposition treats "the P&L side of the closing entry" as one term that no
-- section reads. **One account in it is read.** `Add back depreciation` is the
-- movement in 6800, and 6800 is an EXPENSE account -- so a closing entry credits
-- it by its balance like every other P&L account, and the add-back for any
-- window containing that close reads the depreciation LESS the closing credit.
--
-- Measured, on a shop with a van, 600 of depreciation in March and 600 in April,
-- March closed, over 1 March - 30 April:
--
--                        before the close      after
--     net profit               29800           29800    (excludes the close)
--     add back depreciation     1200             600    <-- March's is gone
--     net change               95000           94400
--     observed movement        95000           95000
--                                              ^^^^^ out by 600, the closed
--                                                    month's depreciation
--
-- Net profit still carries March's depreciation as a cost, because
-- statement_lines() excludes the closing entry. The add-back that is supposed to
-- cancel that cost no longer does, because it does NOT exclude the closing
-- entry. The same 600 is subtracted twice, and the proof -- the one row reached
-- by none of the arithmetic above it -- says so.
--
-- It is worse for the closed month read on its own: the add-back reads 0 and the
-- statement is out by the whole month's depreciation.
--
-- ## Why no fixture caught it
--
-- Nothing in kaiibi posts to 6800 until phase 3c ships `run_depreciation`, so
-- every fixture that closes a month has an empty add-back and the bug is
-- invisible: 0 - 0 = 0. verify-statements.sql posts a depreciation entry BY HAND
-- for exactly this reason, and verify-statements-across-a-close.sql -- the file
-- built to span a close -- did not. 3c will post to 6800 for real, on shops that
-- have been closing months for however long 3b has been live, and the statement
-- that stops tying will be a statement about a month nobody can re-derive.
--
-- ## The fix, which is the rule the plan stated in the first place
--
-- "All three statement functions must exclude source = 'close'." Two did. This
-- is the third, and the exclusion goes on the ONE pass this function makes over
-- the ledger rather than on the 6800 filter alone.
--
-- Globally rather than on 6800, deliberately. The sections are chosen by CODE,
-- not by type -- 1100, 1200, 2000, 2100, 2200, 1500-1599, 3000, 3100 -- and
-- nothing stops a shop numbering an expense account 1550, at which point a close
-- credits it and the investing line moves for the same reason. One rule stated
-- once cannot be true of one filter and false of the next.
--
-- ## What this does NOT change, and the checks that prove it
--
-- A closing entry touches revenue, cost_of_sales and expense accounts and 3900,
-- and nothing else -- close_accounting_period selects on
-- `a.type in ('revenue','cost_of_sales','expense')` and adds one 3900 line. Of
-- the codes this function reads, only 6800 is in that set. So:
--
--   * the OBSERVED cash movement is unchanged. 1000/1010/1020/1021 are assets
--     and no close has ever touched one. If this exclusion moved the proof row,
--     the proof would have stopped being independent of the arithmetic.
--   * receivables, inventory, payables, tax and wages, fixed assets, capital and
--     drawings are all unchanged, for the same reason.
--   * every figure for a shop that has never closed a month is unchanged, so
--     verify-statements.sql is unaffected in full.
--
-- ## AND NO RESIDUAL LINE, still
--
-- 3900's movement is STILL read by no section, and that is still correct. After
-- this, a close cannot move 3900 as far as this statement is concerned -- but an
-- 'opening' entry carrying pre-kaiibi retained earnings can, and if one ever
-- does, the proof will fail by exactly it and say so. That is the design's
-- position, unchanged: the unaccounted set is {2300, 3900 moved by anything that
-- is not a close, and whatever a shop adds itself}, and verify-statements.sql
-- check 28 still drives 1200 through 2300 and still watches the proof break.
--
-- Reproduced in full from 20261001000200 per this repo's convention. The ONLY
-- change is `and e.source <> 'close'` in the `posted` CTE and the note above it.

create or replace function public.cash_flow(
  p_shop_id uuid,
  p_from date,
  p_to date
) returns table (
  section text,
  label text,
  amount_cents bigint,
  is_total boolean,
  sort_order integer
)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare
  v_prior      date := p_from - 1;   -- the close of the day before p_from
  v_profit     bigint;
  v_dep        bigint;
  v_recv       bigint;
  v_inv        bigint;
  v_pay        bigint;
  v_taxwages   bigint;
  v_equip      bigint;
  v_capital    bigint;
  v_draw       bigint;
  v_open_cash  bigint;
  v_close_cash bigint;
  v_ops        bigint;
  v_fin        bigint;
begin
  -- security definer means RLS on journal_lines does not apply, so this check
  -- is the only thing between a stranger and another shop's books. It is not
  -- redundant with the identical gate inside statement_lines(): that one is
  -- reached only because this function happens to call it today.
  if not public.has_shop_permission(p_shop_id, 'ledger.view') then
    raise exception 'You do not have permission to see the books.' using errcode = 'P0001';
  end if;

  -- Net profit is CALLED, not re-derived. Two derivations of the same figure
  -- agree until they don't, and then nobody knows which report is right --
  -- the same argument that made the balance sheet call it.
  select s.amount_cents into v_profit
    from public.statement_lines(p_shop_id, p_from, p_to) s
   where s.section = 'net_profit';
  v_profit := coalesce(v_profit, 0);

  -- One pass. Every figure below is either a movement (close less open) or an
  -- as-at reading, and they all come from the same rows so they cannot drift.
  with posted as (
    -- 'posted' AND 'reversed', matching statement_lines() and balance_sheet()
    -- exactly: a reversed entry's own lines still stand and its reversal
    -- cancels them. 'draft' never counts.
    select l.account_id as acct_id, l.amount_cents as amt, e.entry_date as edate
      from public.journal_lines l
      join public.journal_entries e on e.id = l.entry_id
     where e.shop_id = p_shop_id
       and e.status in ('posted', 'reversed')
       -- A CLOSING ENTRY IS NOT A CASH EVENT, and this statement opens with a
       -- net profit that already excludes it. `Add back depreciation` is the
       -- movement in 6800, an EXPENSE account that a close credits like any
       -- other -- so without this the same depreciation is subtracted twice and
       -- the proof fails by exactly the closed month's depreciation. See the
       -- header for the measured figures.
       and e.source <> 'close'
       and e.entry_date <= p_to
  ),
  by_account as (
    -- LEFT JOIN so an account with no lines still has a row at zero, and both
    -- readings have NO lower bound: each is a balance from the beginning of
    -- the shop's history, exactly as balance_sheet() reads one.
    select a.code as acct_code,
           coalesce(sum(p.amt), 0)::bigint as close_amt,
           coalesce(sum(p.amt) filter (where p.edate <= v_prior), 0)::bigint as open_amt
      from public.accounts a
      left join posted p on p.acct_id = a.id
     where a.shop_id = p_shop_id
     group by a.code
  ),
  mv as (
    select b.acct_code, b.close_amt, b.open_amt,
           (b.close_amt - b.open_amt)::bigint as mv_amt
      from by_account b
  )
  select
    -- The add-back, at its ledger sign: an expense that took no cash.
    coalesce(sum(m.mv_amt) filter (where m.acct_code = '6800'), 0)::bigint,
    -- Everything else NEGATED. See the header: the cash effect of any
    -- non-cash account is minus its ledger movement, and that one rule gives
    -- assets a negative sign on an increase and liabilities a positive one.
    -coalesce(sum(m.mv_amt) filter (where m.acct_code = '1100'), 0)::bigint,
    -coalesce(sum(m.mv_amt) filter (where m.acct_code = '1200'), 0)::bigint,
    -coalesce(sum(m.mv_amt) filter (where m.acct_code = '2000'), 0)::bigint,
    -coalesce(sum(m.mv_amt) filter (where m.acct_code in ('2100', '2200')), 0)::bigint,
    -- 1500-1599 EXCLUDING 1590, which must be the SAME range balance_sheet()
    -- calls fixed assets, minus the one account that is not a cash movement.
    --
    -- It was written as 1500-1589 and that was a real defect rather than a
    -- stylistic one: balance_sheet() takes 1500-1599, so a shop numbering its
    -- van 1595 got fixed assets of 50000 on the balance sheet and investing of
    -- 0 here, and the proof below stopped tying by exactly the van. Excluding
    -- 1590 by NAME says what is meant -- accumulated depreciation is not a cash
    -- movement and is already inside the add-back above -- where an upper bound
    -- of '1589' only said it by accident of text ordering.
    -coalesce(sum(m.mv_amt) filter (
       where m.acct_code between '1500' and '1599' and m.acct_code <> '1590'), 0)::bigint,
    -coalesce(sum(m.mv_amt) filter (where m.acct_code = '3000'), 0)::bigint,
    -coalesce(sum(m.mv_amt) filter (where m.acct_code = '3100'), 0)::bigint,
    -- The observed cash, which no part of the arithmetic above touches.
    coalesce(sum(m.open_amt) filter (where m.acct_code in ('1000', '1010', '1020', '1021')), 0)::bigint,
    coalesce(sum(m.close_amt) filter (where m.acct_code in ('1000', '1010', '1020', '1021')), 0)::bigint
    into v_dep, v_recv, v_inv, v_pay, v_taxwages, v_equip, v_capital, v_draw, v_open_cash, v_close_cash
    from mv m;

  v_ops := v_profit + v_dep + v_recv + v_inv + v_pay + v_taxwages;
  v_fin := v_capital + v_draw;

  return query
  select * from (
    values
      ('operating'::text, 'Net profit'::text,                      v_profit,     false, 100),
      ('operating',       'Add back depreciation',                 v_dep,        false, 110),
      ('operating',       'Increase in receivables',               v_recv,       false, 120),
      ('operating',       'Increase in inventory',                 v_inv,        false, 130),
      ('operating',       'Increase in payables',                  v_pay,        false, 140),
      ('operating',       'Increase in tax & wages payable',       v_taxwages,   false, 150),
      ('operating',       'Cash from operations',                  v_ops,        true,  200),

      ('investing',       'Bought equipment',                      v_equip,      false, 310),
      ('investing',       'Cash used in investing',                v_equip,      true,  400),

      ('financing',       'Owner capital introduced',              v_capital,    false, 510),
      ('financing',       'Owner drawings',                        v_draw,       false, 520),
      ('financing',       'Cash used in financing',                v_fin,        true,  600),

      ('net_change',      'Net change in cash',                    v_ops + v_equip + v_fin, true, 700),

      -- The proof. Labelled with the dates they are read at, so that the
      -- opening row says 31 Dec and not 1 Jan and nobody has to guess which
      -- convention was used. The two are never the same date, even for a
      -- one-day report.
      ('proof',           'Cash at ' || to_char(v_prior, 'FMDD Mon YYYY'), v_open_cash,  false, 810),
      ('proof',           'Cash at ' || to_char(p_to,    'FMDD Mon YYYY'), v_close_cash, false, 820),
      ('proof',           'Movement in cash accounts',             v_close_cash - v_open_cash, true, 830)
  ) r (section, label, amount_cents, is_total, sort_order)
  order by r.sort_order;
end;
$$;

grant execute on function public.cash_flow(uuid, date, date) to authenticated;

comment on function public.cash_flow(uuid, date, date) is
  'The cash flow between p_from and p_to, indirect method: net profit from statement_lines(), plus the depreciation added back, plus the working-capital movements, then investing (fixed assets 1500-1599 except 1590, the same range balance_sheet() calls fixed assets) and financing. Excludes source = ''close'' from every movement it reads, as statement_lines() does: a close credits 6800 like any other expense account, and an add-back that saw it would subtract the closed month''s depreciation twice. An increase in an asset consumes cash and presents negative; an increase in a liability provides it and presents positive -- both are the negation of the ledger movement, because every entry sums to zero. Every movement is a balance at p_to less a balance at p_from - 1 day, both read with no lower bound exactly as balance_sheet() reads one. The proof section carries the OBSERVED movement in 1000/1010/1020/1021, which net change must equal; it is reached by none of the arithmetic above it and it is what catches a sign slip. Gated on ledger.view, which is the only protection: security definer bypasses RLS.';
