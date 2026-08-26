-- The income statement, at two levels of detail, from one query.
--
-- Profit & Loss and Income Statement are the same report: the owner wants five
-- lines, the accountant wants every account. The design settled this
-- explicitly -- "built as two reports they would eventually disagree, and
-- nobody would know which was right" -- so it is one aggregation with a flag,
-- not two functions that happen to agree today.
--
-- ## Signs
--
-- journal_lines is debit-positive, credit-negative. A revenue account
-- therefore sums NEGATIVE and an expense account sums POSITIVE. Every figure
-- this function returns is flipped into PRESENTATION sign -- income positive,
-- costs positive -- because a statement that renders raw ledger signs reads
-- upside down while balancing perfectly.
--
-- The netting of contra-revenue falls out of the same flip and needs no
-- reference to accounts.is_contra: 4200 Discounts Given is a DEBIT to a
-- revenue-type account, so it is positive in the ledger, negative after the
-- flip, and reduces net revenue exactly as it should.
--
-- ## Grouping
--
-- By accounts.type, never by a hardcoded list of codes: a shop can add its own
-- accounts and they must land in the right section without a migration.
--
--   revenue           -> revenue, netted (4100 Returns and 4200 Discounts are
--                        is_contra and reduce it)
--   cost_of_sales     -> cost_of_sales, which includes 5100 Inventory
--                        Shrinkage. That is deliberate and is the design's
--                        resolved position: a unit that is stolen or breaks is
--                        never sold, so its cost reaches COGS by no other path
--                        and gross profit reads high by exactly that amount,
--                        every month, invisibly.
--   operating_expenses-> expense
--
-- Note what is NOT here: 1200 Inventory and 3100 Owner's Draw. Stock purchases
-- and owner draws used to be expense categories and are now an asset and
-- contra-equity. That is what makes a balance sheet possible, and it is why
-- NON_OPERATING_CATEGORIES in expense-reporting.ts became a consequence of
-- where each account sits rather than a filter.
--
-- ## Two implementation notes that are not style
--
-- 1. Every internal column is named so it cannot collide with an OUT parameter
--    of the RETURNS TABLE clause. `group by section` inside the body would be
--    ambiguous between the CTE column and the OUT variable of the same name,
--    and plpgsql raises on that at RUN time, not at CREATE time.
-- 2. sum(bigint) returns NUMERIC in Postgres, and the declared result column is
--    bigint. Without the explicit ::bigint the function creates cleanly and
--    then fails on its first call with "structure of query does not match
--    function result type".

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
