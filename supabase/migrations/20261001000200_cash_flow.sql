-- The cash flow, and the proof that it ties.
--
-- Profit and cash are not the same thing, and the gap between them is the
-- single most common way a profitable shop runs out of money. This is the
-- statement that shows the gap.
--
-- ## Indirect method, which means it is ASSEMBLED and therefore checkable
--
-- A direct cash flow lists the cash accounts' movements. This one starts at
-- net profit and reasons its way to the same number: add back the costs that
-- took no cash, subtract the cash that went into things which are not costs.
-- That reasoning is what makes the statement useful -- it says WHY the two
-- differ -- and it is also its whole risk, because every line is a delta and
-- any one of them can carry the wrong sign while the report still reads
-- plausibly.
--
-- So the proof section is not decoration. `Movement in cash accounts` is the
-- OBSERVED movement in 1000/1010/1020/1021, taken straight from the ledger and
-- reached by no part of the arithmetic above it. Net change must equal it. Any
-- sign slip anywhere in the statement lands there.
--
-- ## The sign convention, which is where this goes wrong
--
--   An increase in an ASSET consumes cash      -> presents NEGATIVE
--   An increase in a LIABILITY provides cash   -> presents POSITIVE
--
-- Both fall out of one rule, and it is worth stating because it is why this
-- function has no per-section sign logic: journal_lines is debit-positive, so
-- a rise in an asset is a positive movement and a rise in a liability is a
-- negative one, and **the cash effect of any non-cash account is the NEGATION
-- of its ledger movement.** Assets, liabilities and equity all obey it. That
-- is not a coincidence -- every entry sums to zero, so the movement in cash is
-- exactly minus the movement in everything else -- and it is the reason the
-- proof ties at all.
--
-- The one line that does NOT follow the rule is the depreciation add-back, and
-- it does not because it is adding back an EXPENSE rather than adjusting for a
-- balance: 6800's movement is already inside net profit as a cost, so it is
-- added back at its ledger sign. Numerically that equals -(1590's movement),
-- since depreciation posts Dr 6800 / Cr 1590 as a pair, which is why 1590 is
-- excluded BY NAME from investing below rather than counted twice.
--
-- ## Depreciation is normally zero, and that is correct rather than missing
--
-- Until phase 3c ships `run_depreciation`, nothing in kaiibi posts to 6800, so
-- this row reads 0 for every real shop. It is emitted anyway -- the row is the
-- shape of the statement and a reader looking for it needs to see it is nil
-- rather than wonder whether it was dropped. verify-statements.sql posts a
-- depreciation entry by hand so that the row is exercised rather than
-- trivially zero.
--
-- ## "Movement in X" is two as-at readings, not a windowed sum
--
-- X's balance at p_to less X's balance at p_from MINUS ONE DAY. The minus one
-- day is the whole of it: opening cash is the position at the START of p_from,
-- which is the close of the day before, and a function that read p_from itself
-- would swallow the first day's trading into the opening balance and report a
-- net change short by exactly it.
--
-- Both readings come out of ONE pass over the ledger, summed the same way
-- balance_sheet() sums -- same status filter, same absence of a lower bound,
-- `<= date` on both ends. Two queries with their own filters would drift, and
-- the drift would be invisible: both reports would still balance.
--
-- ## Which accounts each section reads
--
--   operating   6800 depreciation, 1100 receivables, 1200 inventory,
--               2000 payables, 2100 + 2200 tax and wages
--   investing   1500-1599 EXCEPT 1590, fixed assets AT COST. It is exactly
--               the range balance_sheet() calls fixed assets, less the one
--               account that is not a cash movement: 1590 Accumulated
--               Depreciation, which is already in the add-back. The two
--               statements MUST agree on the range or the proof stops tying
--               for any shop that numbers an asset in the 1590s.
--   financing   3000 capital introduced, 3100 owner drawings
--
-- **These are named codes, and that is a departure from the rule the other two
-- statements follow.** statement_lines() groups by accounts.type precisely so
-- that a shop can add its own account without a migration. Here `type` cannot
-- decide it: 1100 Receivables, 1200 Inventory and 1510 Furniture are all
-- 'asset', and they belong to three different sections of this statement.
--
-- The consequence is worth stating plainly rather than discovering: an account
-- that is neither cash, nor P&L, nor in the list above is UNACCOUNTED FOR, and
-- the statement will not prove out by exactly its movement. Today that set is
-- {2300 Loyalty Points Liability, 3900 Retained Earnings} plus anything a shop
-- adds itself. Nothing in kaiibi posts to either -- 2300 is seeded and never
-- written, 3900 is zero until 3b's period close -- so the statement ties for
-- every shop that exists. It is the proof row that will say so when that stops
-- being true, which is the correct place for it to be caught: a residual
-- "other movements" line would make the statement tie by construction and
-- destroy the only check that can detect a sign error.
--
-- ## Two implementation notes carried over from the other two statements
--
-- 1. Every internal column is renamed so it cannot collide with an OUT
--    parameter of the RETURNS TABLE clause -- `where section = ...` inside the
--    body is ambiguous between a CTE column and the OUT variable, and plpgsql
--    raises on that at RUN time, not at CREATE time.
-- 2. sum(bigint) returns NUMERIC and the declared columns are bigint, so every
--    aggregate is cast explicitly. Without it the function creates cleanly and
--    fails on its first call.

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
  'The cash flow between p_from and p_to, indirect method: net profit from statement_lines(), plus the depreciation added back, plus the working-capital movements, then investing (fixed assets 1500-1599 except 1590, the same range balance_sheet() calls fixed assets) and financing. An increase in an asset consumes cash and presents negative; an increase in a liability provides it and presents positive -- both are the negation of the ledger movement, because every entry sums to zero. Every movement is a balance at p_to less a balance at p_from - 1 day, both read with no lower bound exactly as balance_sheet() reads one. The proof section carries the OBSERVED movement in 1000/1010/1020/1021, which net change must equal; it is reached by none of the arithmetic above it and it is what catches a sign slip. Gated on ledger.view, which is the only protection: security definer bypasses RLS.';
