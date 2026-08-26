-- Closing a month, re-opening one, and the one thing a closed month still
-- accepts.
--
-- ## What a closing entry is, and why it is one entry
--
-- Debit every revenue account by its balance, credit every cost_of_sales and
-- expense account by its balance, and the difference to 3900 Retained
-- Earnings — credit on a profit, debit on a loss. After it, every P&L account
-- for the period reads zero and the period's result sits in equity.
--
-- Written as ONE entry rather than one per account, because a closing entry is
-- one act: half-closed books are a state no report knows how to describe, and
-- the deferred balance trigger (20260904000300) can only guarantee the whole of
-- it if the whole of it is one entry.
--
-- There is no per-type branch in the arithmetic below and that is deliberate.
-- Every line is `-balance`, for every P&L account alike; debiting revenue and
-- crediting expenses is what that ONE rule produces, because journal_lines is
-- debit-positive and revenue carries a credit balance. Two branches that are
-- algebraically identical is a mutation that cannot redden anything, and this
-- project has shipped several.
--
-- ## A period with no trading closes without an entry
--
-- Every line would be zero. `journal_lines` has `check (amount_cents <> 0)`, so
-- the entry could not be written at all — and the two-zero-line version that
-- somebody reaches for next WOULD sum to zero and pass the balance trigger
-- while recording nothing. So: no lines, no entry, `null` returned, status
-- flipped. The `having sum(...) <> 0` below is the same rule one account at a
-- time: an account that traded and then had it all reversed nets to zero and
-- must produce no line.
--
-- A period that traded to exactly break-even is the third case: it has P&L
-- lines, so there IS an entry, but its 3900 line would be zero. That line is
-- appended only when it is non-zero, and the entry still balances without it.
--
-- ## Closing twice is an error, not a no-op
--
-- The second close would zero accounts that are already zero — every `having`
-- would filter every account out, it would return null, and it would flip a
-- status that is already flipped while telling the caller nothing happened.
-- That reads like success. A locked period refuses harder, and separately,
-- because locked is not a state a re-open can leave.
--
-- ## Concurrency
--
-- A per-shop transaction advisory lock, taken BEFORE the period row is read, so
-- both guards below read committed state rather than racing a concurrent close.
-- Two taps on the button produce one closing entry and one error, never two
-- entries. `for update` on the period row alone is not enough: the second
-- transaction would block on the row, then re-read it and see 'closed', which
-- is the right answer — but only because the status is the thing being written.
-- The lock is what makes that true of anything else added here later.
--
-- ADVISORY LOCK CLASSID REGISTRY (20260908000500) — Postgres has ONE global
-- advisory keyspace, shared by every feature in the database:
--   74920 = payroll posting        (post_payroll_run)
--   74921 = ledger backfill        (backfill_shop_ledger, 20260908000700)
--   74922 = period close/reopen    (this migration)
--
-- ## Re-opening reverses; it never deletes
--
-- Corrections are reversing entries. The closing entry stays on the record and
-- a mirror of it is posted beside it, so the books say "this month was closed,
-- and then it was re-opened", which is the fact. Deleting would say nothing
-- happened.
--
-- The reversal is built INLINE rather than through reverse_journal_entry(), for
-- two reasons and both of them are defects if ignored:
--
--   1. reverse_journal_entry() files its reversal under source = 'manual' —
--      deliberately, because it is gated on ledger.post and a human really did
--      type it (20260904000500's header). A closing entry's reversal under
--      'manual' would be VISIBLE TO statement_lines(), which excludes only
--      'close': the reversal's credits to revenue and debits to expense would
--      land in the income statement as trading, and a re-opened month would
--      report its own profit inverted. It carries 'close', per the phase-2b
--      convention that a reversal takes the source of the entry it reverses.
--   2. reverse_journal_entry() calls open_period_for(), which refuses a closed
--      period — and the period is closed at exactly the moment reopen needs to
--      write. Every posting RPC that reverses does so inline for the same
--      reason.
--
-- ## What a closed month still accepts, and the phase-1 change it needed
--
-- The design (2026-08-22-accounting-standards-design.md) is explicit: closed
-- blocks ordinary posting but still permits an owner to post an ADJUSTING entry
-- dated into the month; only locked refuses everything. Without the middle
-- state a genuinely late bill has nowhere to go.
--
-- `open_period_for()` refused any non-open period, so there was no way to
-- express that. It now takes `p_adjusting`, and `post_journal_entry()` passes
-- it through. Both defaults are false, so every existing caller — every posting
-- RPC, every fixture, every screen — behaves exactly as before, including the
-- refusal message, which is unchanged word for word.
--
-- Two things have to be true together for an adjusting entry to land in a
-- closed month, and neither alone is enough:
--
--   * the caller SAID SO. p_adjusting is not a permission, it is an intent: an
--     owner ringing up an ordinary sale into a closed month is still refused,
--     which is what "closed" is for.
--   * the caller holds ledger.close. Whoever may close and re-open a month is
--     who may adjust one. ledger.post is not enough — that is the permission
--     for ordinary posting, and ordinary posting is the thing being refused.
--
-- An adjusting entry into a closed month lands in "Profit this period" on the
-- balance sheet rather than in 3900, because 3900 holds only what a closing
-- entry put there. The sheet still balances — that identity holds for ANY set
-- of entries (see 20261002000000's header) — and re-opening and re-closing the
-- month rolls the adjustment into retained earnings where an accountant would
-- want it. Both readings are defensible; this one is the one that cannot
-- silently disagree with the ledger.

-- ── open_period_for, now with an adjusting-entry door ──────────────────────
--
-- DROPPED and re-created rather than `create or replace`d: adding a defaulted
-- third argument makes a new signature, and leaving the two-argument version
-- behind would make every existing two-argument call AMBIGUOUS rather than
-- resolving to the default. Every caller is a plpgsql body, which resolves the
-- name at run time, so they pick up the new one with no edit.
drop function if exists public.open_period_for(uuid, date);

create or replace function public.open_period_for(
  p_shop_id uuid,
  p_on date,
  -- "This is a deliberate adjusting entry into a month that has closed."
  -- Default false, so nothing that exists today changes behaviour.
  p_adjusting boolean default false
)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_id uuid;
  v_status text;
  v_start date := date_trunc('month', p_on)::date;
begin
  select id, status into v_id, v_status
    from public.accounting_periods
   where shop_id = p_shop_id and p_on between starts_on and ends_on;

  if v_id is null then
    insert into public.accounting_periods (shop_id, starts_on, ends_on)
      values (p_shop_id, v_start, (v_start + interval '1 month - 1 day')::date)
    -- Two concurrent first-entries of a month race here. The loser takes the
    -- winner's row rather than failing, which is why this is on conflict and
    -- not a plain insert.
    on conflict (shop_id, starts_on) do update set starts_on = excluded.starts_on
    returning id, status into v_id, v_status;
  end if;

  -- LOCKED IS FINAL, and it is checked first and separately. p_adjusting does
  -- not reach it: an adjusting entry is what 'closed' exists to permit, and
  -- 'locked' exists to permit nothing.
  if v_status = 'locked' then
    raise exception 'This period is locked — posting into it is refused. Nothing re-opens a locked period.'
      using errcode = 'P0001';
  end if;

  if v_status = 'closed' then
    -- The message is verbatim what this function has always raised, so every
    -- caller's error handling and every test's expectation still hold.
    if not p_adjusting then
      raise exception 'This period is % — posting into it is refused. Re-open it first.', v_status
        using errcode = 'P0001';
    end if;
    -- Said so, but may not. ledger.close, not ledger.post: ordinary posting is
    -- precisely the thing a closed period refuses.
    if not public.has_shop_permission(p_shop_id, 'ledger.close') then
      raise exception 'You do not have permission to post an adjusting entry into a closed period.'
        using errcode = 'P0001';
    end if;
  end if;

  return v_id;
end;
$$;

grant execute on function public.open_period_for(uuid, date, boolean) to authenticated;

-- ── post_journal_entry, passing the intent through ─────────────────────────
--
-- Verbatim from 20260908000150 except the new trailing parameter and the one
-- line that forwards it. Reproduced in full rather than patched, per this
-- repo's convention: the newest definition of a function is the whole of it.
--
-- Dropped for the same reason open_period_for was — a defaulted seventh
-- argument is a new signature, and the six-argument version left behind would
-- make every existing call ambiguous. PostgREST callers pass named arguments
-- (src/lib/ledger.ts), which resolve against the new signature unchanged.
drop function if exists public.post_journal_entry(uuid, date, text, jsonb, uuid, text);

create or replace function public.post_journal_entry(
  p_shop_id uuid,
  p_entry_date date,
  p_description text,
  p_lines jsonb,
  p_location_id uuid default null,
  p_source text default 'manual',
  -- A deliberate adjusting entry into a month that has closed. See
  -- open_period_for above for the two conditions that must hold together.
  p_adjusting boolean default false
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_entry uuid;
  v_period uuid;
  v_sum bigint;
  v_count integer;
  v_missing text;
  v_ref text;
  v_seq integer;
  v_year text := to_char(p_entry_date, 'YYYY');
begin
  -- Manual entries need ledger.post. A posting phase's RPC will call this with
  -- p_source <> 'manual' from inside its own security definer function, where
  -- the caller has already been gated on the permission that door needs -- a
  -- cashier completing a sale holds pos.access and must not need ledger.post.
  if p_source = 'manual' and not has_shop_permission(p_shop_id, 'ledger.post') then
    raise exception 'You do not have permission to post journal entries.'
      using errcode = 'P0001';
  end if;

  if p_description is null or length(trim(p_description)) = 0 then
    raise exception 'A journal entry needs a description.' using errcode = 'P0001';
  end if;

  select count(*), coalesce(sum((l->>'amount_cents')::bigint), 0)
    into v_count, v_sum
    from jsonb_array_elements(p_lines) l;

  if v_count < 2 then
    raise exception 'A journal entry needs at least two lines; this one has %.', v_count
      using errcode = 'P0001';
  end if;

  -- Checked here as well as by the deferred trigger, and both are wanted. This
  -- one produces a message naming the difference, which is what the person
  -- typing the entry needs. The trigger produces the guarantee.
  if v_sum <> 0 then
    raise exception 'This entry does not balance: debits and credits differ by %.', v_sum
      using errcode = 'P0001';
  end if;

  select string_agg(distinct l->>'code', ', ') into v_missing
    from jsonb_array_elements(p_lines) l
   where not exists (
     select 1 from public.accounts a
      where a.shop_id = p_shop_id and a.code = l->>'code' and a.archived_at is null
   );
  if v_missing is not null then
    raise exception 'No such account: %. Check the chart of accounts.', v_missing
      using errcode = 'P0001';
  end if;

  -- Raises if the month is locked, or closed and this is not a deliberate
  -- adjusting entry from somebody holding ledger.close. Opens the month if it
  -- is the first entry of it.
  v_period := public.open_period_for(p_shop_id, p_entry_date, p_adjusting);

  -- Per shop per year, gapless, and serialised. ONE statement: the upsert takes
  -- a row lock on the counter, so a concurrent poster blocks here rather than
  -- reading the same number and losing a unique-violation race at the insert
  -- below. See 20260908000150's header for what that race did to a sale.
  --
  -- `next_number - 1` because the row is left holding the number the NEXT
  -- caller gets: the insert path stores 2 and returns 1, the update path stores
  -- N+1 and returns N.
  insert into public.journal_entry_sequences (shop_id, year, next_number)
    values (p_shop_id, v_year, 2)
    on conflict (shop_id, year) do update set next_number = public.journal_entry_sequences.next_number + 1
    returning next_number - 1 into v_seq;
  v_ref := public.journal_entry_reference(v_year, v_seq);

  insert into public.journal_entries
      (shop_id, period_id, entry_date, reference, description, source, status, location_id, created_by)
    values (p_shop_id, v_period, p_entry_date, v_ref, trim(p_description), p_source, 'posted',
            p_location_id, auth.uid())
    returning id into v_entry;

  insert into public.journal_lines (entry_id, account_id, amount_cents, location_id, memo)
    select v_entry,
           (select a.id from public.accounts a where a.shop_id = p_shop_id and a.code = l->>'code'),
           (l->>'amount_cents')::bigint,
           coalesce((l->>'location_id')::uuid, p_location_id),
           l->>'memo'
      from jsonb_array_elements(p_lines) l;

  return v_entry;
end;
$$;

grant execute on function public.post_journal_entry(uuid, date, text, jsonb, uuid, text, boolean) to authenticated;

-- ── close_accounting_period ────────────────────────────────────────────────
create or replace function public.close_accounting_period(
  p_shop_id uuid,
  p_period_id uuid,
  -- RESERVED, AND INERT TODAY. Task 3 of this phase adds period_exceptions()
  -- and the rule that a close names what was still outstanding; p_force is what
  -- overrides a refusal that does not exist yet, and the interface is fixed now
  -- so that adding it is not a signature change on a shipped RPC. Nothing in
  -- this function reads it, and nothing should pretend otherwise.
  p_force boolean default false
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_period  public.accounting_periods;
  v_lines   jsonb;
  v_sum     bigint;
  v_entry   uuid;
begin
  -- security definer bypasses RLS on accounting_periods, journal_entries and
  -- journal_lines alike, so this gate and the shop_id filters below are the
  -- whole of the tenant boundary.
  if not public.has_shop_permission(p_shop_id, 'ledger.close') then
    raise exception 'You do not have permission to close an accounting period.'
      using errcode = 'P0001';
  end if;

  -- Before the read, so both guards below see committed state. See the header's
  -- classid registry.
  perform pg_advisory_xact_lock(74922, hashtext(p_shop_id::text));

  select * into v_period from public.accounting_periods
   where id = p_period_id and shop_id = p_shop_id
     for update;

  -- One message for "no such period" and "not your period". A caller who can
  -- tell those apart can enumerate another shop's period ids.
  if v_period.id is null then
    raise exception 'No such accounting period.' using errcode = 'P0001';
  end if;

  if v_period.status = 'locked' then
    raise exception 'This period is locked. A locked period is final — it cannot be closed again or re-opened.'
      using errcode = 'P0001';
  end if;
  if v_period.status = 'closed' then
    -- coalesce because closed_at can be null: the RLS write policy on
    -- accounting_periods lets a ledger.close holder set the status by hand, and
    -- to_char(null) would leave the sentence ending in a bare full stop.
    raise exception 'This period was already closed on %. Re-open it before closing it again.',
      coalesce(to_char(v_period.closed_at, 'FMDD Mon YYYY'), 'an earlier date')
      using errcode = 'P0001';
  end if;

  -- EVERY P&L ACCOUNT'S BALANCE FOR THE PERIOD, NEGATED. One rule for all three
  -- types: revenue carries a credit balance so -balance is a debit, costs carry
  -- debit balances so -balance is a credit. No branch, nothing to get backwards.
  --
  -- `e.source <> 'close'`, so a period closed, re-opened and closed again is
  -- measured on its TRADING and not on the closing entry that was reversed out
  -- of it. (The reversed pair nets to zero, so it would come to the same figure
  -- today; stating it means it still comes to the same figure when it doesn't.)
  --
  -- Status filter and date bounds match statement_lines() exactly. Two
  -- derivations of "this period's profit" that read the ledger through
  -- different filters would disagree, and the disagreement would be permanent:
  -- the difference would sit in 3900 forever.
  --
  -- `having sum(...) <> 0` is load-bearing: journal_lines refuses a zero
  -- amount, and an account that traded and was fully reversed has a zero
  -- balance and must produce no line at all.
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
    -- A MONTH THAT DID NOT TRADE. Every line would be zero; there is nothing to
    -- roll into retained earnings and no honest entry to write. The status
    -- still flips — the month is closed, it just closed empty.
    update public.accounting_periods
       set status = 'closed', closed_at = now(), closed_by = auth.uid()
     where id = p_period_id;

    insert into public.accounting_audit_log
        (shop_id, actor_id, action, subject_table, subject_id, before, after)
      values (p_shop_id, auth.uid(), 'update', 'accounting_periods', p_period_id,
              jsonb_build_object('status', v_period.status),
              jsonb_build_object('status', 'closed', 'closing_entry_id', null,
                                 'profit_rolled_cents', 0));
    return null;
  end if;

  -- 3900's line is minus the sum of the others, which is the period's result in
  -- ledger sign: a profit is a credit (negative), a loss a debit. Appended only
  -- when non-zero — a month that broke even to the cent has P&L lines to zero
  -- but nothing to retain, and journal_lines refuses a zero amount.
  select coalesce(sum((l->>'amount_cents')::bigint), 0) into v_sum
    from jsonb_array_elements(v_lines) l;
  if v_sum <> 0 then
    v_lines := v_lines || jsonb_build_array(
      jsonb_build_object('code', '3900', 'amount_cents', -v_sum));
  end if;

  -- Posted through the front door: it allocates the reference, re-checks the
  -- balance, resolves the period and fires the audit triggers. p_source =
  -- 'close' does not gate on ledger.post (20260904000500) -- correctly, because
  -- this function gated on ledger.close at its own door. The period is still
  -- 'open' at this moment, which is why the status flip comes after.
  v_entry := public.post_journal_entry(
    p_shop_id, v_period.ends_on,
    'Closing entry — ' || to_char(v_period.starts_on, 'FMMonth YYYY'),
    v_lines, null, 'close');

  update public.accounting_periods
     set status = 'closed', closed_at = now(), closed_by = auth.uid()
   where id = p_period_id;

  -- The accounting_periods trigger (20260904000400) already logs the row's
  -- before and after. This row carries what the trigger cannot see: which entry
  -- closed the month, and how much went into retained earnings.
  --
  -- v_sum IS the period's profit, positive on a profit and negative on a loss,
  -- and it is not the ledger sign of anything. Each closing line is MINUS an
  -- account's balance, so their sum is minus the P&L total -- which is the
  -- definition of profit in a debit-positive ledger. The 3900 line then takes
  -- minus THAT, which is why a profit credits it.
  insert into public.accounting_audit_log
      (shop_id, actor_id, action, subject_table, subject_id, before, after)
    values (p_shop_id, auth.uid(), 'update', 'accounting_periods', p_period_id,
            jsonb_build_object('status', v_period.status),
            jsonb_build_object('status', 'closed', 'closing_entry_id', v_entry,
                               'profit_rolled_cents', v_sum));

  return v_entry;
end;
$$;

grant execute on function public.close_accounting_period(uuid, uuid, boolean) to authenticated;

comment on function public.close_accounting_period(uuid, uuid, boolean) is
  'Closes an accounting period: posts one source = ''close'' entry dated the period''s ends_on that zeroes every revenue, cost_of_sales and expense account for the period into 3900 Retained Earnings, then flips the period to closed. Returns the entry, or null when the period did not trade -- every line would be zero and journal_lines refuses a zero amount. Gated on ledger.close, under a per-shop advisory lock, so two concurrent taps produce one entry and one error. Closing a closed period is an error; a locked period refuses harder. p_force is reserved for phase 3b task 3 and is not read today.';

-- ── reopen_accounting_period ───────────────────────────────────────────────
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

  -- The closing entry that is still standing: source 'close', posted, and not
  -- already reversed. reverses_entry_id is set on BOTH halves of a reversed
  -- pair (20260904000500), so `is null` is what distinguishes an entry that has
  -- never been reversed from one that has, and from a reversal itself.
  select * into v_close from public.journal_entries
   where shop_id = p_shop_id
     and period_id = p_period_id
     and source = 'close'
     and status = 'posted'
     and reverses_entry_id is null
   order by created_at desc
   limit 1;

  if v_close.id is not null then
    -- Built here rather than through reverse_journal_entry(), which would file
    -- it under 'manual' -- visible to statement_lines(), which excludes only
    -- 'close' -- and would call open_period_for() on a period that is closed at
    -- exactly this moment. See the header.
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

    -- The one update refuse_posted_entry_edit() permits.
    update public.journal_entries
       set status = 'reversed', reverses_entry_id = v_new
     where id = v_close.id;
  end if;

  update public.accounting_periods
     set status = 'open', closed_at = null, closed_by = null
   where id = p_period_id;

  -- THE REASON HAS NOWHERE ELSE STRUCTURED TO LIVE. The accounting_periods
  -- trigger records the status going back to 'open' but not why, and the
  -- reversal entry's description carries it only as prose. This row is the one
  -- a "who re-opened August, and why" query reads.
  insert into public.accounting_audit_log
      (shop_id, actor_id, action, subject_table, subject_id, before, after)
    values (p_shop_id, auth.uid(), 'update', 'accounting_periods', p_period_id,
            jsonb_build_object('status', v_period.status,
                               'closing_entry_id', v_close.id),
            jsonb_build_object('status', 'open', 'reason', trim(p_reason),
                               'reversal_entry_id', v_new));
end;
$$;

grant execute on function public.reopen_accounting_period(uuid, uuid, text) to authenticated;

comment on function public.reopen_accounting_period(uuid, uuid, text) is
  'Re-opens a closed accounting period by REVERSING its closing entry -- never deleting it -- and flipping the status back to open. The reversal carries source = ''close'' so it stays invisible to statement_lines(), and is built inline because reverse_journal_entry() would file it as ''manual'' and would refuse a closed period. Requires a reason, which is written to accounting_audit_log. A period that closed without trading has no entry to reverse and only flips. Gated on ledger.close; a locked period refuses.';
