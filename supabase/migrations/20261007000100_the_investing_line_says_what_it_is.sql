-- "Bought equipment: -6000" in a year the shop bought nothing.
--
-- ## THE READING, MEASURED
--
-- 20261006000300 fixed the arithmetic of the investing section and left its
-- LABEL alone. Its own header carries the reproduction: a shop that buys a
-- fridge for 10000, depreciates 6000 and sells it for 3000, read over the whole
-- year, now presents
--
--     Bought equipment            -6000
--     Cash used in investing      -6000
--
-- and every figure on the statement ties. The number is right. The sentence is
-- not, three times over:
--
--   1. The shop bought equipment for 10000, not 6000. No purchase in this
--      window was for 6000.
--   2. It also SOLD equipment, for 3000, and the row that is supposed to be
--      about equipment does not mention it.
--   3. Nothing here is 6000 except the depreciation, which the row above it
--      already added back -- so a reader trying to reconcile the two finds the
--      same number twice, meaning different things, one of them mislabelled.
--
-- The line is `-(movement in 1500-1599) - (movement in 6800)`: the carrying
-- amount of equipment that came in, less the carrying amount of equipment that
-- went out. In a window with no disposal that IS what was bought, which is why
-- the label was true for as long as nothing could be sold -- and nothing could
-- be sold until 20261006000100 shipped dispose_fixed_asset three migrations
-- ago. It stopped being true the moment the register did.
--
-- ## WHAT IT SHOULD SAY, AND WHAT IT DELIBERATELY DOES NOT SAY
--
--     'Equipment bought, less equipment sold'
--
-- Both halves named, and the subtraction that is actually being performed shown
-- rather than implied. It is the shortest sentence that no longer lies about a
-- disposal, and it stays correct in the ordinary window where nothing was sold:
-- less nothing.
--
-- WHAT IT STILL DOES NOT SAY is that "sold" here means AT BOOK VALUE and not at
-- the price it fetched. The gap between the two is the gain or loss, and that
-- is sitting in net profit at the top of this statement -- 20261006000300's
-- header names the presentation and explains why buying the textbook split
-- (proceeds in investing, the loss added back in operating) needs a dedicated
-- gain-on-disposal account in every shop's chart, which the per-shop seed does
-- not have. A LABEL CANNOT CARRY THAT SENTENCE. The screen does: the Cash Flow
-- view puts it in a `context` caveat beside the statement, where there is room
-- to say it in full and where it is a qualification on a figure rather than a
-- longer name for one.
--
-- ## THE LABEL IS A COLUMN, NOT A CONSTANT IN THE APP
--
-- cash_flow() returns `label` and the screen prints it, so this migration is the
-- whole of the change -- there is no second copy in TypeScript to keep in step,
-- which is the point of the statements returning their own labels. The section
-- TOTAL keeps its name: 'Cash used in investing' was never about equipment
-- specifically and is still exactly right.
--
-- Reproduced in full from 20261006000300 per this repo's convention that the
-- newest definition of a function is the whole of it. Changed: one label, and
-- the comment above it. Not a single figure moves; verify-fixed-assets and
-- verify-statements both pin the arithmetic and neither is touched by this.

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
    -- reproduced in 20261006000300's header. What is left after the charge is
    -- taken out is the CARRYING AMOUNT of equipment bought less that of
    -- equipment sold, WHICH IS WHAT THIS ROW IS NOW LABELLED. It read "Bought
    -- equipment" until 20261007000100, which was true only for as long as
    -- nothing could be sold.
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

      -- BOTH HALVES NAMED. This row is the carrying amount of equipment bought
      -- less that of equipment sold, and after a disposal neither the purchase
      -- price nor the sale price appears in it. See this migration's header.
      ('investing',       'Equipment bought, less equipment sold', v_equip,      false, 310),
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
  'The cash flow between p_from and p_to, indirect method: net profit from statement_lines(), plus the depreciation added back, plus the working-capital movements, then investing and financing. INVESTING is the movement of the whole fixed-asset section 1500-1599 -- the same range balance_sheet() calls fixed assets, 1590 INCLUDED -- LESS the movement in 6800, which is the depreciation charge and is already added back in operating. What remains is the carrying amount of equipment bought less that of equipment sold, and the row SAYS SO: it was labelled ''Bought equipment'' until 20261007000100, which was true only until dispose_fixed_asset shipped and then read -6000 in a year whose only equipment purchase was 10000. Excluding 1590 outright, as this function did until 20261006000300, left a DISPOSAL''s write-back of accumulated depreciation read by no section at all and the proof failed by exactly it. Excludes source = ''close'' from every movement it reads, as statement_lines() does: a close credits 6800 like any other expense account, and an add-back that saw it would subtract the closed month''s depreciation twice. An increase in an asset consumes cash and presents negative; an increase in a liability provides it and presents positive -- both are the negation of the ledger movement, because every entry sums to zero. Every movement is a balance at p_to less a balance at p_from - 1 day, both read with no lower bound exactly as balance_sheet() reads one. The proof section carries the OBSERVED movement in 1000/1010/1020/1021, which net change must equal; it is reached by none of the arithmetic above it and it is what catches a sign slip. Gated on ledger.view, which is the only protection: security definer bypasses RLS.';
