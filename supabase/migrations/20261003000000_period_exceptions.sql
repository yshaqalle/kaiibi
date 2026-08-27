-- What a close is allowed to be unhappy about, as ONE function that both the
-- RPC and the screen call.
--
-- ## Why one function and not two lists
--
-- The list a shop is SHOWN before it closes and the list RECORDED on the period
-- when it does must be the same list, or the screen tells the truth and the
-- ledger tells a different one. Phase 2b learned this expensively: the Post
-- History door and its RPC drifted apart and had to be pinned back together by
-- a check. This is the same shape of problem solved by not having two things.
--
-- So `close_accounting_period` calls this, `list_accounting_periods` calls
-- this, and the screen calls this. There is no second derivation to disagree
-- with.
--
-- ## WHAT IS HERE, AND WHAT IS NOT, AND WHY
--
-- The design (2026-08-22-accounting-standards-design.md) names three things:
-- draft bills, stock counts not done, bank not confirmed. Only one of those
-- three survives contact with the schema as it actually stands today.
--
-- An exception that CANNOT FIRE is worse than one that is absent. An absent
-- check is a gap the reader can see; a check wired to a column nothing ever
-- sets teaches the reader that the list is complete, and they stop looking.
-- Every rule below was checked against the live schema for a path that reaches
-- it, and the ones with no such path are named here rather than shipped dead.
--
-- SHIPPED:
--
--   draft_payroll_run     payroll_runs.status defaults to 'draft' and
--                         unpost_payroll_run(20260908000500) puts a run back
--                         there. A draft run overlapping the month is wages the
--                         shop has worked out and not put in its books, so the
--                         profit about to be rolled into 3900 is too high by
--                         them. This is the honest survivor of "draft bills".
--
--   stock_count_missing   Per LOCATION, not per shop: a shop that counted its
--                         warehouse and not its shop floor has not counted its
--                         stock. Exactly what the design names.
--
--   register_session_open A till opened inside the month and never closed. The
--                         cash for those days was never counted against what
--                         the register says it took, so 1000 Cash is a claim
--                         nobody has checked. Not the same act as confirming a
--                         bank balance -- it is named for what it is rather
--                         than dressed up as the bank line the design wanted.
--
-- DECLINED, each with the reason:
--
--   draft bills           THERE IS NO DRAFT BILL. A bill is an `invoices` row,
--                         and sync_invoice_expense mirrors it to `expenses` on
--                         insert, which post_expense_to_ledger posts in the
--                         same transaction (20260908000800). There is no state
--                         between "entered" and "in the ledger" for it to sit
--                         in. `invoices.settled` is about whether the bill has
--                         been PAID, which is a payable and not an exception:
--                         owing money at month end is ordinary accrual
--                         accounting, and flagging it would teach shops that
--                         2000 Accounts Payable is a fault.
--
--   draft journal entries `journal_entries.status` defaults to 'draft', which
--                         makes this look computable -- and the statements do
--                         filter it, so a draft really would be money missing
--                         from the close. But journal_entries carries a SELECT
--                         policy and NO insert or update policy at all, and
--                         every posting function writes 'posted' literally.
--                         Nothing outside a test fixture running as `postgres`
--                         can produce one. It is one `where` clause away the
--                         day a draft-entry screen exists; today it would fire
--                         for nobody, ever.
--
--   unposted source rows  expenses / stock_receipts / stock_counts all carry
--                         `journal_entry_id` and a partial index on it being
--                         null, which reads like a to-do list and is not one.
--                         post_expense_to_ledger returns null DELIBERATELY for
--                         a stock-count expense and for a goods bill that names
--                         its delivery, because the delivery already posted
--                         those goods -- so those rows keep a null
--                         journal_entry_id forever, correctly. An exception on
--                         that column would fire permanently, for every shop
--                         that has ever received stock against an invoice, and
--                         could never be cleared. A permanent false positive is
--                         the one failure mode worse than a check that cannot
--                         fire.
--
--   bank not confirmed    There is no record of the act. `cash_accounts` has
--                         `balance_cents` and `balance_as_of`, but balance_as_of
--                         moves whenever anybody edits the balance for any
--                         reason, and there is no "I have checked this against
--                         the statement" anywhere in the schema or the app.
--                         Deriving it from balance_as_of would report "nobody
--                         touched this number" as "the bank was not confirmed",
--                         which are different facts, and the shop cannot tell
--                         which one it is being told. It needs a reconciliation
--                         record first. Left out.
--
-- ## The two gates on stock_count_missing, and why an absence-exception needs them
--
-- The other two fire on the PRESENCE of something wrong. This one fires on the
-- ABSENCE of something right, which means it fires by default and has to earn
-- it:
--
--   * the inventory module must be on. Without it the shop cannot record a
--     stock count at all, so the exception could never be cleared -- the same
--     permanent-false-positive trap as the unposted rows above.
--   * the shop must have had at least one product by the end of the month.
--     Nothing to count is not a failure to count.
--
-- Both are conditions the shop can change, which is the test: an exception a
-- shop cannot act on is a complaint, not an exception.
--
-- ## One filter here cannot be turned red, and is kept anyway
--
-- `c.shop_id = p_shop_id` on the stock_counts sub-query is UNREACHABLE by
-- mutation: it sits under `c.location_id = l.id`, and l is already pinned to
-- this shop, so a stock count belonging to another shop cannot match the join
-- in the first place. Removing it passes every check in
-- verify-period-exceptions-and-auto-close.sql, which was verified rather than
-- assumed. It stays because it is the tenant boundary written where a reader
-- looks for it, and because the day somebody rewrites the correlation it stops
-- being redundant -- but nobody should go looking for the test that catches it,
-- because there cannot be one.
--
-- ## Dates
--
-- stock_counts.created_at and register_sessions.opened_at are timestamptz and
-- the periods are dates, so every comparison goes through shop_local_date()
-- (Africa/Mogadishu, UTC+3). A count entered at 01:00 on the 1st of September
-- is a September count; read in UTC it is an August one and would silently
-- clear August's exception. payroll_runs.period_start/period_end are already
-- dates and need no conversion.

create or replace function public.period_exceptions(
  p_shop_id uuid,
  p_period_id uuid
) returns table (kind text, detail text, count integer)
language plpgsql stable security definer set search_path = public as $$
declare
  v_period public.accounting_periods;
  v_month  text;
  v_n      integer;
  v_names  text;
begin
  -- ledger.view OR ledger.close, and both are needed. The screen's reader holds
  -- ledger.view; close_accounting_period's caller holds ledger.close, and there
  -- is no rule anywhere making one imply the other -- a role may be given
  -- ledger.close alone, and a close that then failed on a read gate would be a
  -- very confusing bug to find.
  if not public.has_any_shop_permission(p_shop_id, array['ledger.view', 'ledger.close']) then
    raise exception 'You do not have permission to read this shop''s accounting periods.'
      using errcode = 'P0001';
  end if;

  -- security definer, so this filter is the tenant boundary. One message for
  -- "no such period" and "not your period", as close_accounting_period does:
  -- a caller who can tell those apart can enumerate another shop's period ids.
  select * into v_period from public.accounting_periods
   where id = p_period_id and shop_id = p_shop_id;
  if v_period.id is null then
    raise exception 'No such accounting period.' using errcode = 'P0001';
  end if;

  v_month := to_char(v_period.starts_on, 'FMMonth YYYY');

  -- ── 1. Pay runs still in draft ──────────────────────────────────────────
  --
  -- OVERLAP, not containment: a run's period is a pay cycle and need not sit
  -- inside a calendar month. A weekly run from 29 August to 4 September is
  -- partly August's wages, and August closing without it is August closing on a
  -- number that is wrong.
  select count(*)::integer into v_n
    from public.payroll_runs r
   where r.shop_id = p_shop_id
     and r.status = 'draft'
     and r.period_start <= v_period.ends_on
     and r.period_end   >= v_period.starts_on;

  if v_n > 0 then
    kind   := 'draft_payroll_run';
    detail := v_n || case when v_n = 1 then ' pay run covering ' else ' pay runs covering ' end
              || v_month || case when v_n = 1 then ' is' else ' are' end
              || ' still in draft, so those wages are not in this month''s books.';
    count  := v_n;
    return next;
  end if;

  -- ── 2. Stock not counted ────────────────────────────────────────────────
  if public.shop_has_module(p_shop_id, 'inventory')
     and exists (select 1 from public.products p
                  where p.shop_id = p_shop_id
                    and public.shop_local_date(p.created_at) <= v_period.ends_on) then

    -- `l.created_at <= ends_on` so a branch that opened in September is not
    -- reported for having failed to count its stock in August.
    select count(*)::integer, string_agg(l.name, ', ' order by l.name)
      into v_n, v_names
      from public.shop_locations l
     where l.shop_id = p_shop_id
       and l.active
       and public.shop_local_date(l.created_at) <= v_period.ends_on
       and not exists (
         select 1 from public.stock_counts c
          where c.shop_id = p_shop_id
            and c.location_id = l.id
            and public.shop_local_date(c.created_at)
                between v_period.starts_on and v_period.ends_on);

    if v_n > 0 then
      kind   := 'stock_count_missing';
      detail := 'Nobody counted stock at ' || v_names || ' in ' || v_month
                || ', so what the books say is in stock has not been checked against the shelves.';
      count  := v_n;
      return next;
    end if;
  end if;

  -- ── 3. A till that was never closed ─────────────────────────────────────
  --
  -- Keyed on when it was OPENED. A session opened on 30 August and closed on
  -- 1 September is August's session and it was counted; a session opened on
  -- 30 August and still open is August's and was not.
  select count(*)::integer into v_n
    from public.register_sessions s
   where s.shop_id = p_shop_id
     and s.closed_at is null
     and public.shop_local_date(s.opened_at)
         between v_period.starts_on and v_period.ends_on;

  if v_n > 0 then
    kind   := 'register_session_open';
    detail := v_n || case when v_n = 1 then ' register session opened in ' else ' register sessions opened in ' end
              || v_month || case when v_n = 1 then ' was' else ' were' end
              || ' never closed, so that cash was never counted.';
    count  := v_n;
    return next;
  end if;

  return;
end;
$$;

grant execute on function public.period_exceptions(uuid, uuid) to authenticated;

comment on function public.period_exceptions(uuid, uuid) is
  'The outstanding items a close should name, as ONE list shared by close_accounting_period, list_accounting_periods and the screen -- so what a shop is shown and what is recorded on the period cannot disagree. Ships three: pay runs still in draft that overlap the month, active locations whose stock nobody counted in it, and register sessions opened in it and never closed. Draft bills, draft journal entries, unposted source rows and bank confirmation are DELIBERATELY absent -- see the migration header for the path that does not exist behind each. Gated on ledger.view or ledger.close; security definer, so its shop_id filters are the tenant boundary.';
