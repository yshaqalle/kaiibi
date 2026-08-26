-- A month that can still take a sale is not final: refuse to close it.
--
-- ## WHAT WAS WRONG
--
-- close_accounting_period() checked that a period was not `locked` and not
-- already `closed`. It never checked that the period had ENDED. The RPC is
-- granted to `authenticated` and the Close a Period screen's primary, filled
-- call-to-action calls it, so closing the CURRENT month was one tap away.
--
-- That is not a cosmetic wrong. Every posting path in phase 2b handles a closed
-- month by REDATING the entry to today -- complete_sale, post_expense_to_ledger,
-- record_invoice_payment, edit_sale, unpost_payroll_run and the three
-- reverse_*_entry triggers, 66 references to v_period_status between them. That
-- escape assumes the current month is open. When the closed period IS the
-- current month, "redate to today" lands back inside the month that was just
-- closed and open_period_for() raises. Reproduced against the live stack with a
-- real product, real stock and a cash payment:
--
--   NOTICE:  CURRENT month closed
--   NOTICE:  TILL FAILED: This period is closed — posting into it is refused.
--
-- So the till stops. So do expenses, bills, supplier payments, deliveries and
-- payroll. It is recoverable -- reopen_accounting_period() takes a typed reason
-- and puts it all back -- but only once somebody finds the screen again, and in
-- the meantime nothing can be sold.
--
-- A second, smaller wrong in the same act: the closing entry is dated
-- v_period.ends_on, so closing August on the 26th posts an entry dated 31
-- August -- a future-dated entry in a live ledger. The guard below removes that
-- too, because ends_on is in the past for every close it now permits.
--
-- ## THE RULE, AND WHY REFUSING IS THE RIGHT ANSWER
--
--   ends_on >= shop_local_date()   refuse.
--
-- A shop that genuinely wants the current month shut cannot have it, and should
-- not: closing means "this month is final, nothing more will be booked into
-- it", and a month that has not ended can still receive trade. There is no
-- honest close of a month with days left in it -- the closing entry would roll a
-- profit that is not the month's profit, and the next sale would either be
-- refused or silently redated into it anyway. The refusal therefore names the
-- first day the month CAN be closed, so the answer to "how do I shut this
-- month" is a date rather than a dead end:
--
--   'August 2026 has not ended yet, so there is nothing final to close. It can
--    be closed from 1 September 2026. Until then the month can still take a
--    sale, and closing it would stop the till.'
--
-- shop_local_date() AND NEVER now()::date. now()::date resolves in UTC, and the
-- shop's day is Africa/Mogadishu (UTC+3): between midnight and 03:00 local the
-- two disagree, and on the 1st of a month they disagree about which month it
-- is. close_due_periods() already reads the same function for the same reason
-- (20261003000100), and verify-shop-local-date.sql exists because this has bitten
-- before.
--
-- `>=` and not `>`: a month is closeable the day AFTER it ends. On 31 August,
-- August can still take a sale, so August is not final.
--
-- ## THIS DOES NOT CHANGE AUTO-CLOSE, and that is provable rather than hoped
--
-- close_due_periods() selects `p.ends_on + v_shop.period_close_grace_days <=
-- v_today` with v_today = shop_local_date() and the grace column CHECKed into
-- (5, 10, 15). So every period it picks satisfies `ends_on <= today - 5`, which
-- is strictly less than today, which is exactly the complement of the guard
-- below. The automatic path can never select a period this refuses; the two
-- read the same clock through the same function, so they cannot drift apart
-- even if the grace values change. verify-period-exceptions-and-auto-close.sql
-- H1/H2/H5 close months through that door and stay green, and a new check in
-- verify-period-close.sql closes the day after a month ends, which is the
-- boundary itself.
--
-- ## WHY HERE AND NOT ON THE SCREEN
--
-- close_accounting_period is granted to `authenticated` and is reachable over
-- PostgREST with nothing but a logged-in account. The screen is a door, not the
-- boundary. It gets its own fix (it was offering the wrong month), but the rule
-- lives here.
--
-- Reproduced in full from 20261003000100 per this repo's convention that the
-- newest definition of a function is the whole of it. Changed: the ends_on
-- guard below, and nothing else.
create or replace function public.close_accounting_period(
  p_shop_id uuid,
  p_period_id uuid,
  -- Close over outstanding items rather than refusing. See 20261003000100.
  p_force boolean default false
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_period     public.accounting_periods;
  v_lines      jsonb;
  v_sum        bigint;
  v_entry      uuid;
  v_exceptions text[];
begin
  if not public.has_shop_permission(p_shop_id, 'ledger.close') then
    raise exception 'You do not have permission to close an accounting period.'
      using errcode = 'P0001';
  end if;

  perform pg_advisory_xact_lock(74922, hashtext(p_shop_id::text));

  select * into v_period from public.accounting_periods
   where id = p_period_id and shop_id = p_shop_id
     for update;

  if v_period.id is null then
    raise exception 'No such accounting period.' using errcode = 'P0001';
  end if;

  if v_period.status = 'locked' then
    raise exception 'This period is locked. A locked period is final — it cannot be closed again or re-opened.'
      using errcode = 'P0001';
  end if;
  if v_period.status = 'closed' then
    raise exception 'This period was already closed on %. Re-open it before closing it again.',
      coalesce(to_char(v_period.closed_at, 'FMDD Mon YYYY'), 'an earlier date')
      using errcode = 'P0001';
  end if;

  -- A MONTH THAT HAS NOT ENDED IS NOT FINAL. See the header: closing the
  -- current month stops the till, because phase 2b's escape from a closed month
  -- is to redate the entry to today and today is inside it. p_force does NOT
  -- override this -- force is about closing over an outstanding CHECKLIST, and
  -- there is no reading of "close it anyway" that makes a month that can still
  -- take a sale final.
  if v_period.ends_on >= public.shop_local_date() then
    raise exception '% has not ended yet, so there is nothing final to close. It can be closed from %. Until then the month can still take a sale, and closing it would stop the till.',
      to_char(v_period.starts_on, 'FMMonth YYYY'),
      to_char(v_period.ends_on + 1, 'FMDD FMMonth YYYY')
      using errcode = 'P0001';
  end if;

  -- WHAT IS OUTSTANDING, read once and used twice: to refuse with, and to
  -- record. One read, so the list refused with and the list recorded cannot be
  -- different lists. `order by kind` so the recorded array is stable and two
  -- closes of the same state produce the same array.
  --
  -- Computed AFTER the status guards: a locked period must refuse for being
  -- locked, not for having an uncounted branch.
  select array_agg(x.detail order by x.kind) into v_exceptions
    from public.period_exceptions(p_shop_id, p_period_id) x;

  if v_exceptions is not null and not p_force then
    raise exception 'Closing % would leave % outstanding: % Close it anyway to record them against the period.',
      to_char(v_period.starts_on, 'FMMonth YYYY'),
      case when cardinality(v_exceptions) = 1 then '1 item' else cardinality(v_exceptions) || ' items' end,
      array_to_string(v_exceptions, ' ')
      using errcode = 'P0001';
  end if;
  -- '{}' and not null from here down: accounting_periods.exceptions is
  -- `not null default '{}'`.
  v_exceptions := coalesce(v_exceptions, '{}'::text[]);

  select jsonb_agg(jsonb_build_object('code', x.acct_code, 'amount_cents', x.amt) order by x.acct_code)
    into v_lines
    from (
      select a.code as acct_code, (-sum(l.amount_cents))::bigint as amt
        from public.journal_lines l
        join public.journal_entries e on e.id = l.entry_id
        join public.accounts a on a.id = l.account_id
       where e.shop_id = p_shop_id
         and a.shop_id = p_shop_id
         and e.status in ('posted', 'reversed')
         and e.source <> 'close'
         and e.entry_date between v_period.starts_on and v_period.ends_on
         and a.type in ('revenue', 'cost_of_sales', 'expense')
       group by a.code
      having sum(l.amount_cents) <> 0
    ) x;

  if v_lines is null then
    -- A month that did not trade: no honest entry to write, but the month is
    -- closed and whatever was outstanding in it is still recorded.
    update public.accounting_periods
       set status = 'closed', closed_at = now(), closed_by = auth.uid(),
           exceptions = v_exceptions
     where id = p_period_id;

    insert into public.accounting_audit_log
        (shop_id, actor_id, action, subject_table, subject_id, before, after)
      values (p_shop_id, auth.uid(), 'update', 'accounting_periods', p_period_id,
              jsonb_build_object('status', v_period.status),
              jsonb_build_object('event', 'close', 'status', 'closed',
                                 'closing_entry_id', null, 'profit_rolled_cents', 0,
                                 'forced', p_force,
                                 'exceptions', to_jsonb(v_exceptions)));
    return null;
  end if;

  select coalesce(sum((l->>'amount_cents')::bigint), 0) into v_sum
    from jsonb_array_elements(v_lines) l;
  if v_sum <> 0 then
    v_lines := v_lines || jsonb_build_array(
      jsonb_build_object('code', '3900', 'amount_cents', -v_sum));
  end if;

  v_entry := public.post_journal_entry(
    p_shop_id, v_period.ends_on,
    'Closing entry — ' || to_char(v_period.starts_on, 'FMMonth YYYY'),
    v_lines, null, 'close');

  update public.accounting_periods
     set status = 'closed', closed_at = now(), closed_by = auth.uid(),
         exceptions = v_exceptions
   where id = p_period_id;

  insert into public.accounting_audit_log
      (shop_id, actor_id, action, subject_table, subject_id, before, after)
    values (p_shop_id, auth.uid(), 'update', 'accounting_periods', p_period_id,
            jsonb_build_object('status', v_period.status),
            jsonb_build_object('event', 'close', 'status', 'closed',
                               'closing_entry_id', v_entry, 'profit_rolled_cents', v_sum,
                               'forced', p_force,
                               'exceptions', to_jsonb(v_exceptions)));

  return v_entry;
end;
$$;

grant execute on function public.close_accounting_period(uuid, uuid, boolean) to authenticated;

comment on function public.close_accounting_period(uuid, uuid, boolean) is
  'Closes an accounting period: posts one source = ''close'' entry dated the period''s ends_on that zeroes every revenue, cost_of_sales and expense account for the period into 3900 Retained Earnings, then flips the period to closed. Returns the entry, or null when the period did not trade. REFUSES A PERIOD THAT HAS NOT ENDED in the shop''s own local date -- closing the current month would stop the till, because a closed month redates its postings to today and today is inside it -- and p_force does not override that. p_force = false also REFUSES while period_exceptions() returns anything, naming every item; p_force = true closes anyway and writes those items to accounting_periods.exceptions -- "closed with exceptions". Gated on ledger.close, under a per-shop advisory lock. Closing a closed period is an error; a locked period refuses harder.';
