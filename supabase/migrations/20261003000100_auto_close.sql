-- Months close by themselves, ten days after they end.
--
-- ## WHAT RUNS IT: lazily, on the read, and not on a schedule
--
-- pg_cron IS NOT INSTALLED in this project -- `select count(*) from
-- pg_extension where extname = 'pg_cron'` returns 0 and no migration mentions
-- cron.schedule. Adding an extension is a production decision about a shared
-- database with its own failure modes (a job that runs as a superuser with no
-- caller, errors that go to a log nobody reads, a schedule that silently stops
-- after a restore), and it is a bigger decision than this task should make on
-- its own.
--
-- So this closes LAZILY: `list_accounting_periods()` -- the one door through
-- which anything reads a shop's periods -- closes every earlier period that is
-- past its grace before it answers.
--
-- THE TRADE-OFF, PLAINLY: a shop nobody opens never closes. If an owner does
-- not look at their accounting for four months, four months sit open, and they
-- all close at once the moment somebody does look. Three consequences worth
-- naming rather than discovering:
--
--   1. The books are not wrong in the meantime -- they are open, which is the
--      state they were already in. Nothing is lost, it is deferred.
--   2. It defers the PROTECTION, which is the actual cost. "Closed" is what
--      stops anybody editing an old month; a month that has not lazily closed
--      is still editable by anyone with ledger.post. A shop that never opens
--      its accounting is exactly the shop least likely to notice.
--   3. The first read after a long silence does N closes inside one
--      transaction. Each is a handful of statements against one month, they run
--      oldest-first, and they are all-or-nothing together -- but it is a write
--      on a read path, and any caller must be able to tolerate that.
--
-- If a scheduler is ever installed, `close_due_periods()` is already the whole
-- job: `select public.close_due_periods(id) from public.shops` on a nightly
-- cron and this door becomes redundant rather than wrong. That is why the
-- driver is a separate function from the reader.
--
-- ## THE SETTINGS, on `shops`, following the expiry precedent exactly
--
-- `expiry_tracking_enabled boolean` + `expiry_warning_lead_days integer`
-- (0030_inventory_alert_settings) is the shape: the switch and its number, on
-- `shops`, `not null` with a default and a CHECK, added with
-- `add column if not exists`.
--
-- The switch here is NOT a boolean, because the design names THREE states, not
-- two -- automatic, ask me, never -- and a boolean plus a second boolean is how
-- you end up with a fourth state that means nothing. It is a text column with a
-- CHECK, which is how every other three-state column in this database is
-- written (accounting_periods.status, payroll_runs.status).
--
--   'automatic'  close it, force past whatever is outstanding, record it
--   'ask'        never close by itself. A human closes from the screen, and an
--                un-forced close REFUSES while anything is outstanding and
--                names it -- which IS the asking. The screen shows the list and
--                closes again with p_force.
--   'never'      nothing automatic, ever.
--
-- DEFAULT 'automatic' WITH TEN DAYS, per the design, and that default applies
-- to every shop that already exists. The first accounting read after this
-- migration closes every one of their past months. That is a real consequence
-- and it is the intended one: the alternative is that the feature ships off and
-- the shops it was built for -- the ones who will never find a setting -- never
-- get it. Every close is reversible by reopen_accounting_period(), which is
-- what makes defaulting it on defensible rather than reckless.
--
-- Ten days and not the 31st, because August's electricity bill arrives in
-- September (design, 2026-08-22). Five and fifteen are the other two settings
-- the design permits, and the CHECK admits exactly those three so that a
-- typo'd 100 cannot quietly turn the feature off.
--
-- ## p_force STOPS BEING INERT
--
-- 20261002000100 shipped `p_force` accepted and unread, reserved for this task.
-- It is now WIRED rather than dropped, because there is a real thing for it to
-- override and the alternative -- always closing regardless -- throws away the
-- only moment at which a human can be told what they are about to close over.
--
--   p_force = false   refuses while period_exceptions() returns anything, and
--                     the refusal NAMES every item. This is the 'ask' path.
--   p_force = true    closes, and writes the list to
--                     accounting_periods.exceptions. This is "closed with
--                     exceptions", and it is what close_due_periods() passes.
--
-- The design's rule -- "a month closes even when the checklist is not clean,
-- refusing would mean shops that never do stock counts never close a month" --
-- is honoured by the AUTOMATIC path, which always forces. The refusal only ever
-- reaches a human who is standing at a screen able to be told and able to say
-- yes. A shop that never does stock counts still closes every month, by itself,
-- with 'stock_count_missing' recorded against each.
--
-- ## What goes IN accounting_periods.exceptions
--
-- The DETAIL strings, not the kinds. The array has to be self-contained: a pay
-- run that was in draft when August closed can be posted in October, at which
-- point period_exceptions() recomputed against August no longer reports it --
-- and the fact that August was closed over it would be gone. `kind` stays
-- available live from period_exceptions() for anything that wants to branch on
-- it; the recorded array is the human sentence, because "names them" is what
-- the design asked for.
--
-- Written on EVERY close, forced or not -- '{}' when there was nothing. A
-- period whose exceptions are empty because nothing was outstanding and one
-- whose exceptions are empty because nobody looked must not be the same row.
-- reopen_accounting_period clears it back to '{}', because the recorded list
-- describes a close and there is no longer a close.
--
-- ## The two audit rows, which are two on purpose
--
-- A close writes an accounting_audit_log row from the accounting_periods
-- trigger (20260904000400) AND one of its own. That is not a defect and it is
-- not the screen's problem to explain away; they record different facts:
--
--   the trigger's row   "this row changed, here is the whole of it before and
--                       after". Uniform across every audited table, written
--                       whether the change came through an RPC or a hand-typed
--                       update under RLS. It is the tamper-evidence record and
--                       it must not learn about closes specifically.
--   the explicit row    "a close happened, here is which entry did it, how much
--                       went to retained earnings, and what was outstanding".
--                       None of that is on the row, so the trigger cannot see
--                       any of it.
--
-- Losing either loses something. What WAS missing is a way to tell them apart
-- without a heuristic, so the explicit rows now carry `after->>'event'` --
-- 'close', 'reopen'. A history screen filters on it. `action` stays within
-- insert/update/delete: that CHECK is shared with journal_entries and
-- journal_lines and describes what happened to a ROW, which is what an audit
-- log's verb is for. Widening it to 'close' would make the verb mean two
-- different kinds of thing depending on the table.
--
-- ## Closing April while March is still open
--
-- Still permitted, and now deliberately so rather than by omission. Each
-- period's roll reads only entries dated inside its own bounds and excludes
-- source = 'close', so April's closing entry is the same whether March closed
-- before it, after it or never -- there is no accumulation to get out of order,
-- and the balance sheet identity holds for any set of entries at all
-- (20261002000000). close_due_periods() walks oldest-first anyway, so the
-- automatic path never produces a gap. Forbidding it would only take away the
-- legitimate case: a shop closing recent months while one old month is held
-- open on purpose, for a dispute or a late supplier. The cost of permitting it
-- is that "closed" does not imply "everything before it is closed", which is
-- why list_accounting_periods returns every period's status rather than a
-- high-water mark.

-- ── The settings ───────────────────────────────────────────────────────────
alter table public.shops add column if not exists auto_close_periods text not null default 'automatic'
  check (auto_close_periods in ('automatic', 'ask', 'never'));
alter table public.shops add column if not exists period_close_grace_days integer not null default 10
  check (period_close_grace_days in (5, 10, 15));

comment on column public.shops.auto_close_periods is
  'automatic = close past months by themselves, forcing past outstanding items and recording them; ask = never close by itself, and an un-forced close refuses while anything is outstanding; never = nothing automatic. Read by close_due_periods().';
comment on column public.shops.period_close_grace_days is
  'Days after a month ends before it closes by itself. 10 by default: closing on the 31st would be wrong, because August''s electricity bill arrives in September.';

-- ── close_accounting_period, with p_force doing something ──────────────────
--
-- Reproduced in full from 20261002000100 per this repo's convention that the
-- newest definition of a function is the whole of it. Changed: the exceptions
-- block below the status guards, `exceptions` on both updates, and the `event`
-- key on the explicit audit rows. The arithmetic is untouched -- see
-- 20261002000100's header, which remains the explanation of what a closing
-- entry is and why there is no per-type branch in it.
create or replace function public.close_accounting_period(
  p_shop_id uuid,
  p_period_id uuid,
  -- Close over outstanding items rather than refusing. See the header.
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
  'Closes an accounting period: posts one source = ''close'' entry dated the period''s ends_on that zeroes every revenue, cost_of_sales and expense account for the period into 3900 Retained Earnings, then flips the period to closed. Returns the entry, or null when the period did not trade. p_force = false REFUSES while period_exceptions() returns anything, naming every item; p_force = true closes anyway and writes those items to accounting_periods.exceptions -- "closed with exceptions". Gated on ledger.close, under a per-shop advisory lock. Closing a closed period is an error; a locked period refuses harder.';

-- ── reopen_accounting_period, clearing the recorded exceptions ─────────────
--
-- Reproduced in full from 20261002000100. Changed: `exceptions = '{}'` on the
-- update, and the `event` key on the audit row. The recorded list describes a
-- close; after this there is no close, so leaving it would say August is
-- carrying exceptions from a close that has been reversed out of the ledger.
-- The audit row below still holds them, which is where the history lives.
create or replace function public.reopen_accounting_period(
  p_shop_id uuid,
  p_period_id uuid,
  p_reason text
) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_period public.accounting_periods;
  v_close  public.journal_entries;
  v_new    uuid;
begin
  if not public.has_shop_permission(p_shop_id, 'ledger.close') then
    raise exception 'You do not have permission to re-open an accounting period.'
      using errcode = 'P0001';
  end if;

  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'Say why this period is being re-opened.' using errcode = 'P0001';
  end if;

  perform pg_advisory_xact_lock(74922, hashtext(p_shop_id::text));

  select * into v_period from public.accounting_periods
   where id = p_period_id and shop_id = p_shop_id
     for update;

  if v_period.id is null then
    raise exception 'No such accounting period.' using errcode = 'P0001';
  end if;
  if v_period.status = 'locked' then
    raise exception 'This period is locked. A locked period is final — it cannot be re-opened.'
      using errcode = 'P0001';
  end if;
  if v_period.status = 'open' then
    raise exception 'This period is already open.' using errcode = 'P0001';
  end if;

  select * into v_close from public.journal_entries
   where shop_id = p_shop_id
     and period_id = p_period_id
     and source = 'close'
     and status = 'posted'
     and reverses_entry_id is null
   order by created_at desc
   limit 1;

  if v_close.id is not null then
    insert into public.journal_entries
        (shop_id, period_id, entry_date, reference, description, source, status,
         location_id, reverses_entry_id, created_by)
      values (p_shop_id, v_close.period_id, v_close.entry_date, v_close.reference || 'R',
              'Reversal of ' || v_close.reference || ' — ' || trim(p_reason),
              'close', 'posted', v_close.location_id, v_close.id, auth.uid())
      returning id into v_new;

    insert into public.journal_lines (entry_id, account_id, amount_cents, location_id, memo)
      select v_new, account_id, -amount_cents, location_id, memo
        from public.journal_lines where entry_id = v_close.id;

    update public.journal_entries
       set status = 'reversed', reverses_entry_id = v_new
     where id = v_close.id;
  end if;

  update public.accounting_periods
     set status = 'open', closed_at = null, closed_by = null, exceptions = '{}'
   where id = p_period_id;

  insert into public.accounting_audit_log
      (shop_id, actor_id, action, subject_table, subject_id, before, after)
    values (p_shop_id, auth.uid(), 'update', 'accounting_periods', p_period_id,
            jsonb_build_object('status', v_period.status,
                               'closing_entry_id', v_close.id,
                               'exceptions', to_jsonb(v_period.exceptions)),
            jsonb_build_object('event', 'reopen', 'status', 'open',
                               'reason', trim(p_reason),
                               'reversal_entry_id', v_new));
end;
$$;

grant execute on function public.reopen_accounting_period(uuid, uuid, text) to authenticated;

comment on function public.reopen_accounting_period(uuid, uuid, text) is
  'Re-opens a closed accounting period by REVERSING its closing entry -- never deleting it -- flipping the status back to open and clearing the exceptions recorded by the close. The reversal carries source = ''close'' so it stays invisible to statement_lines(), and is built inline because reverse_journal_entry() would file it as ''manual'' and would refuse a closed period. Requires a reason, which is written to accounting_audit_log along with the exceptions being cleared. Gated on ledger.close; a locked period refuses.';

-- ── close_due_periods: the job, separated from the door that runs it ───────
create or replace function public.close_due_periods(p_shop_id uuid)
returns integer
language plpgsql security definer set search_path = public as $$
declare
  v_shop   public.shops;
  v_today  date := public.shop_local_date();
  v_period record;
  v_closed integer := 0;
begin
  -- RETURNS 0 RATHER THAN RAISING, and that is the whole reason this is not
  -- inlined into the reader. It runs on the back of somebody else's read: a
  -- Manager holding ledger.view and not ledger.close must get their period list
  -- and must not close anything. Raising here would give exactly the permanent
  -- "Loading…" that phase 3a shipped as a Critical.
  if not public.has_shop_permission(p_shop_id, 'ledger.close') then
    return 0;
  end if;

  select * into v_shop from public.shops where id = p_shop_id;
  if v_shop.id is null or v_shop.auto_close_periods <> 'automatic' then
    return 0;
  end if;

  -- OLDEST FIRST. It makes no arithmetic difference -- each period's roll reads
  -- only its own dates -- but a shop watching its own audit log should see its
  -- months close in the order they happened.
  --
  -- `<= v_today` and not `<`: ten days after a month ending on the 31st is the
  -- 10th, and the 10th is the day it closes.
  for v_period in
    select p.id from public.accounting_periods p
     where p.shop_id = p_shop_id
       and p.status = 'open'
       and p.ends_on + v_shop.period_close_grace_days <= v_today
     order by p.starts_on
  loop
    -- FORCED, always. This is the design's rule: refusing would mean a shop
    -- that never does a stock count never closes a month. What was outstanding
    -- is recorded on the period instead of blocking it.
    perform public.close_accounting_period(p_shop_id, v_period.id, true);
    v_closed := v_closed + 1;
  end loop;

  return v_closed;
end;
$$;

grant execute on function public.close_due_periods(uuid) to authenticated;

comment on function public.close_due_periods(uuid) is
  'Closes every open period of a shop whose end is more than shops.period_close_grace_days ago, oldest first, forcing past outstanding items and recording them. Returns how many it closed. Does nothing and returns 0 when the shop''s auto_close_periods is not ''automatic'', or when the caller does not hold ledger.close -- it runs on the back of a read and must never refuse one. This is the whole of the scheduled job, should a scheduler ever be installed; today list_accounting_periods() calls it.';

-- ── list_accounting_periods: the read that also closes ─────────────────────
create or replace function public.list_accounting_periods(p_shop_id uuid)
returns table (
  id uuid,
  starts_on date,
  ends_on date,
  status text,
  closed_at timestamptz,
  closed_by uuid,
  -- What was recorded WHEN IT CLOSED. Empty for an open period.
  exceptions text[],
  -- What is outstanding RIGHT NOW, for open periods only -- what closing this
  -- month today would record, and '{}' when that is nothing. NULL for a closed
  -- or locked one, where the recorded array above is the fact and a
  -- recomputation would be a different question answered in the same column.
  outstanding text[],
  closing_entry_id uuid,
  profit_rolled_cents bigint,
  auto_close_due_on date
)
language plpgsql security definer set search_path = public as $$
declare
  v_grace integer;
begin
  if not public.has_shop_permission(p_shop_id, 'ledger.view') then
    raise exception 'You do not have permission to view this shop''s accounting periods.'
      using errcode = 'P0001';
  end if;

  -- THE LAZY CLOSE. Before the read, so the answer already includes it.
  perform public.close_due_periods(p_shop_id);

  -- Null unless the shop is on 'automatic', which makes auto_close_due_on null
  -- for 'ask' and 'never' -- there is no date on which those close.
  select case when s.auto_close_periods = 'automatic' then s.period_close_grace_days end
    into v_grace from public.shops s where s.id = p_shop_id;

  -- THE SCREEN DOES NO ARITHMETIC. profit_rolled_cents and auto_close_due_on
  -- are computed here for that reason.
  return query
  select p.id,
         p.starts_on,
         p.ends_on,
         p.status,
         p.closed_at,
         p.closed_by,
         p.exceptions,
         -- coalesced to '{}' rather than left null, so that null means exactly
         -- one thing -- "not computed, this period is closed" -- and an open
         -- month with nothing outstanding is an empty array. array_agg over no
         -- rows is null, and null meaning both "nothing" and "not asked" is a
         -- distinction the screen would have to guess at.
         case when p.status = 'open'
              then coalesce((select array_agg(x.detail order by x.kind)
                               from public.period_exceptions(p_shop_id, p.id) x),
                            '{}'::text[])
         end,
         c.id,
         -- MINUS the 3900 line, because a profit is a credit and credits are
         -- negative. 0 when the month did not trade (no entry at all) and 0
         -- when it broke even exactly (an entry with no 3900 line).
         coalesce((select -sum(l.amount_cents)
                     from public.journal_lines l
                     join public.accounts a on a.id = l.account_id
                    where l.entry_id = c.id and a.code = '3900'), 0)::bigint,
         case when p.status = 'open' then p.ends_on + v_grace end
    from public.accounting_periods p
    -- The closing entry STILL STANDING. A re-opened month's entry is
    -- 'reversed', so it drops out here and the month reads as having rolled
    -- nothing -- which is what re-opening it did.
    left join lateral (
      select e.id from public.journal_entries e
       where e.shop_id = p_shop_id
         and e.period_id = p.id
         and e.source = 'close'
         and e.status = 'posted'
         and e.reverses_entry_id is null
       order by e.created_at desc
       limit 1
    ) c on true
   where p.shop_id = p_shop_id
   order by p.starts_on desc;
end;
$$;

grant execute on function public.list_accounting_periods(uuid) to authenticated;

comment on function public.list_accounting_periods(uuid) is
  'Every accounting period of a shop, newest first, with what it rolled into retained earnings, what was outstanding when it closed, what is outstanding now if it is still open, and the date it closes by itself. CLOSES ANY PERIOD PAST ITS GRACE BEFORE ANSWERING -- this is the whole of auto-close, there being no scheduler; a shop nobody opens never closes. Gated on ledger.view; a caller without ledger.close gets the list and closes nothing.';
