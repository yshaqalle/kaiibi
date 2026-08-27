-- Selling equipment broke the cash flow's proof, and nothing could have noticed.
--
-- ## THE DEFECT, MEASURED BEFORE IT WAS FIXED
--
-- cash_flow()'s investing section reads `1500-1599 EXCLUDING 1590`, and
-- 20261001000200's own comment gives the reason: "accumulated depreciation is
-- not a cash movement and is already inside the add-back above". That sentence
-- is true of the depreciation CHARGE and false of the other thing that moves
-- 1590 -- a DISPOSAL, which debits it to take the sold asset's accumulated
-- depreciation back off the books.
--
-- 1590 is then read by NO section of this statement. Every other account in an
-- entry is read at minus its ledger movement, which is exactly what makes the
-- proof row tie: every entry sums to zero, so the negated non-cash lines add up
-- to the cash lines. An account nobody reads is a hole in that identity, and a
-- disposal falls straight through it.
--
-- Reproduced against the live stack before writing a line of this file. A shop
-- with 100000 of capital that buys a fridge for 10000, depreciates 6000, and
-- sells it for 3000 -- a loss of 1000 -- over 1 Jan to 31 Dec:
--
--     Net profit                  -7000
--     Add back depreciation        6000
--     Cash from operations        -1000
--     Bought equipment                0   <-- +10000 and -10000 cancelled
--     Owner capital introduced   100000
--     Net change in cash          99000
--     Movement in cash accounts   93000   <-- out by 6000
--
-- Out by exactly the accumulated depreciation removed. Not by the proceeds, not
-- by the loss: by the one line no section reads.
--
-- ## WHY NO FIXTURE COULD HAVE CAUGHT IT
--
-- Nothing in kaiibi has ever disposed of a fixed asset -- there was no register
-- until 20261006000100 -- and 1590 has only ever been moved by hand-posted
-- depreciation, where the charge and the add-back cancel and the hole is not on
-- any path. 0 - 0 = 0, which is how the sibling defect in this same section
-- survived a whole phase (20261004000100's header).
--
-- ## THE FIX, AND WHY IT IS THIS ONE
--
-- The investing line becomes the movement of the WHOLE fixed-asset section --
-- 1500-1599 including 1590, the carrying amount, cost less accumulated
-- depreciation -- with the period's DEPRECIATION CHARGE taken back out:
--
--     investing = -(movement in 1500-1599) - (movement in 6800)
--
-- Read it as: what happened to the shop's equipment at its book value, less the
-- part of it that was wear rather than buying and selling. Depreciation is not
-- an investing event and it is already added back in operating; what is left is
-- the carrying amount of what came in less the carrying amount of what went out.
--
-- Each case, worked:
--
--   * A PURCHASE. 1500 +C, 1590 0, 6800 0 -> investing -C. Unchanged.
--   * A MONTH'S DEPRECIATION. 1590 -D, 6800 +D -> -(-D) - D = 0. Unchanged, and
--     it has to be: the entry moves no cash and the add-back already cancels it
--     against net profit.
--   * A DISPOSAL. 1500 -C, 1590 +A, 6800 0 -> -(A - C) = C - A, the net book
--     value removed. Net profit carries the gain or loss, and NBV less the
--     loss (or plus the gain) is the proceeds. The proof ties.
--
-- Against the reproduction above: -(0) - 6000 = -6000, net change -1000 - 6000
-- + 100000 = 93000, and the proof row agrees.
--
-- WHAT IT IS NOT. It is not a residual line and it is not a new section --
-- verify-statements-across-a-close.sql:534 forbids both, and rightly: a residual
-- makes the proof tautological and destroys the only check in this statement
-- that can catch a sign error. Nothing is added here. One filter is widened and
-- one term is subtracted, and the proof row remains reached by none of it.
--
-- THE ONE THING IT DOES NOT DO, said out loud rather than discovered later: a
-- disposal's gain or loss is presented in INVESTING (inside the net book value)
-- rather than adjusted out of operating the way a full indirect statement would.
-- Textbook presentation splits it -- proceeds in investing, the loss added back
-- in operating -- and that needs the proceeds and the gain as separate known
-- quantities. The proceeds are a cash line inside a disposal entry and the gain
-- shares 6900 Other with everything else a shop books there, so neither is
-- readable from an account movement, and this function reads account movements
-- BY CODE on purpose. Buying it would cost a dedicated gain-on-disposal account
-- in every shop's chart and a new operating row. The figures all tie either way;
-- what differs is which section a disposal's profit is reported in.
--
-- Reproduced in full from 20261004000100 per this repo's convention that the
-- newest definition of a function is the whole of it. Changed: the investing
-- filter and the comment above it, and nothing else.

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
       -- the proof fails by exactly the closed month's depreciation. See
       -- 20261004000100's header for the measured figures.
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
    -- THE WHOLE FIXED-ASSET SECTION, 1590 INCLUDED, LESS THE DEPRECIATION
    -- CHARGE. 1500-1599 must be the same range balance_sheet() calls fixed
    -- assets -- an upper bound of '1589' was a real defect, not a stylistic one,
    -- because a shop numbering its van 1595 got fixed assets on one statement
    -- and investing of 0 on the other.
    --
    -- 1590 is IN the range now, and 6800 is subtracted. 1590 moves two ways and
    -- only one of them is the add-back's business: the monthly CHARGE (credit
    -- 1590, debit 6800, cancelling here) and a DISPOSAL writing accumulated
    -- depreciation back off (debit 1590, no 6800 line at all). Excluding the
    -- account wholesale left the disposal read by no section of this statement,
    -- and the proof failed by exactly the accumulated depreciation removed --
    -- reproduced in this migration's header. What is left after the charge is
    -- taken out is the CARRYING AMOUNT of equipment bought less that of
    -- equipment sold, which is what an investing section means.
    -coalesce(sum(m.mv_amt) filter (
       where m.acct_code between '1500' and '1599'), 0)::bigint
      - coalesce(sum(m.mv_amt) filter (where m.acct_code = '6800'), 0)::bigint,
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
  'The cash flow between p_from and p_to, indirect method: net profit from statement_lines(), plus the depreciation added back, plus the working-capital movements, then investing and financing. INVESTING is the movement of the whole fixed-asset section 1500-1599 -- the same range balance_sheet() calls fixed assets, 1590 INCLUDED -- LESS the movement in 6800, which is the depreciation charge and is already added back in operating. What remains is the carrying amount of equipment bought less that of equipment sold. Excluding 1590 outright, as this function did until 20261006000300, left a DISPOSAL''s write-back of accumulated depreciation read by no section at all and the proof failed by exactly it. Excludes source = ''close'' from every movement it reads, as statement_lines() does: a close credits 6800 like any other expense account, and an add-back that saw it would subtract the closed month''s depreciation twice. An increase in an asset consumes cash and presents negative; an increase in a liability provides it and presents positive -- both are the negation of the ledger movement, because every entry sums to zero. Every movement is a balance at p_to less a balance at p_from - 1 day, both read with no lower bound exactly as balance_sheet() reads one. The proof section carries the OBSERVED movement in 1000/1010/1020/1021, which net change must equal; it is reached by none of the arithmetic above it and it is what catches a sign slip. Gated on ledger.view, which is the only protection: security definer bypasses RLS.';
