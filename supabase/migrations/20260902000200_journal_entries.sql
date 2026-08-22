-- The general journal: the hand-posted half of the books.
--
-- The chart-of-accounts migration explains what does NOT come through here --
-- sales, expenses, bills and cash balances all report themselves through an
-- account's `feed`. What is left is everything a shop has to state rather than
-- transact: opening balances when the books move in, a loan drawn down, wages
-- accrued at month end, depreciation, and the correction someone makes when
-- last quarter turns out to have been wrong.
--
-- Two rules, and both are enforced in the database rather than the client:
--
--   **An entry balances or it does not exist.** Debits equal credits, checked
--   inside the same transaction that writes the lines. A ledger that can hold
--   an unbalanced entry has no trial balance worth drawing.
--
--   **A posted entry is never edited or deleted.** It is REVERSED: a second
--   entry, dated when the correction was made, with every line the other way
--   round. This is not ceremony -- an edited entry silently changes a period
--   that has already been reported on, and the reversal is the only version of
--   the story where both the mistake and the fix are visible.

create table public.journal_entries (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  -- Which store the entry belongs to. NULL = business-wide, matching every
  -- other accounting table (20260816000000): a head-office accrual has no one
  -- store to sit in, and per-store reporting excludes it rather than guessing.
  location_id uuid references public.shop_locations(id) on delete set null,
  -- The shop's own running number, unique and gapless per shop. Gapless is why
  -- it is allocated under a lock rather than from a sequence: a sequence burns
  -- numbers on rollback, and "where did JE-14 go" is a question an auditor
  -- genuinely asks.
  entry_no integer not null,
  -- When the entry belongs, which is what decides the period it reports in --
  -- distinct from `created_at`, when it was typed.
  entry_date date not null default current_date,
  memo text,
  -- The shop's own cross-reference: a cheque number, a bank statement line, a
  -- letter from the landlord.
  reference text,
  source text not null default 'manual' check (source in (
    'manual','opening_balance','transfer','reversal'
  )),
  -- The row that caused this entry, when something did. No foreign key: the
  -- sources are different tables, and an entry outliving the thing that caused
  -- it is correct behaviour, not a dangling reference.
  source_id uuid,
  -- Set on a reversal, pointing at what it undoes.
  reverses_id uuid references public.journal_entries(id) on delete set null,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  unique (shop_id, entry_no)
);
create index journal_entries_shop_date_idx on public.journal_entries(shop_id, entry_date desc);
-- Unique, not merely indexed: one reversal per entry, so a double tap cannot
-- undo the same entry twice and leave the books out by its own amount. It
-- serves the "what reverses this" lookup as well, so there is no second index.
create unique index journal_entries_reverses_idx
  on public.journal_entries(reverses_id) where reverses_id is not null;

create table public.journal_lines (
  id uuid primary key default gen_random_uuid(),
  entry_id uuid not null references public.journal_entries(id) on delete cascade,
  -- `restrict`, not cascade or set null: an account with lines against it
  -- cannot be deleted, because either alternative silently unbalances every
  -- entry it appeared in. The chart offers archiving instead.
  account_id uuid not null references public.ledger_accounts(id) on delete restrict,
  -- The order the person typed them in. A journal entry is READ as a block,
  -- and re-sorting the lines on every fetch makes an entry the writer
  -- recognises look like one they did not.
  line_no integer not null,
  debit_cents integer not null default 0 check (debit_cents >= 0),
  credit_cents integer not null default 0 check (credit_cents >= 0),
  memo text,
  -- A line is one side or the other, never both. A line carrying $50 of each
  -- is two lines someone collapsed, and it makes the account's own history
  -- unreadable.
  constraint journal_lines_one_side check (debit_cents = 0 or credit_cents = 0),
  constraint journal_lines_not_empty check (debit_cents + credit_cents > 0),
  unique (entry_id, line_no)
);
create index journal_lines_entry_idx on public.journal_lines(entry_id);
create index journal_lines_account_idx on public.journal_lines(account_id);

alter table public.journal_entries enable row level security;
alter table public.journal_lines enable row level security;

create policy "read journal_entries" on public.journal_entries for select
  using (has_any_shop_permission(shop_id, array['ledger.view', 'ledger.manage']));
create policy "read journal_lines" on public.journal_lines for select
  using (exists (
    select 1 from public.journal_entries e
     where e.id = entry_id
       and has_any_shop_permission(e.shop_id, array['ledger.view', 'ledger.manage'])
  ));

-- No insert, update or delete policy on either table, for anyone. Both rules
-- at the top of this file would otherwise be advice: a client that can insert
-- a line directly can post half an entry, and one that can update a line can
-- rewrite a period that has been filed. Writes go through the two
-- security-definer RPCs below and nowhere else.
grant select on public.journal_entries to authenticated;
grant select on public.journal_lines to authenticated;

-- ---------------------------------------------------------------------------
-- Posting
-- ---------------------------------------------------------------------------
-- `p_lines` is [{account_id, debit_cents, credit_cents, memo}, ...] in the
-- order they should read.
--
-- Everything is validated before anything is written, and the whole thing is
-- one transaction, so a rejected entry leaves no header behind for someone to
-- find later and wonder about.
create or replace function public.post_journal_entry(
  p_shop_id uuid,
  p_lines jsonb,
  p_entry_date date default current_date,
  p_memo text default null,
  p_reference text default null,
  p_location_id uuid default null,
  p_source text default 'manual',
  p_source_id uuid default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_entry_id uuid;
  v_entry_no integer;
  v_line jsonb;
  v_index integer := 0;
  v_debits bigint := 0;
  v_credits bigint := 0;
  v_account_id uuid;
  v_debit integer;
  v_credit integer;
begin
  if not public.has_shop_permission(p_shop_id, 'ledger.manage') then
    raise exception 'not authorized to post to this shop''s ledger';
  end if;
  if p_source not in ('manual','opening_balance','transfer') then
    raise exception 'invalid journal source %', p_source;
  end if;
  if jsonb_typeof(p_lines) is distinct from 'array' or jsonb_array_length(p_lines) < 2 then
    -- Two is the floor, not one: a single line cannot balance, and an entry
    -- that names only one account has not said where the money came from.
    raise exception 'a journal entry needs at least two lines';
  end if;

  for v_line in select * from jsonb_array_elements(p_lines) loop
    v_account_id := (v_line->>'account_id')::uuid;
    v_debit := coalesce((v_line->>'debit_cents')::integer, 0);
    v_credit := coalesce((v_line->>'credit_cents')::integer, 0);

    if v_debit < 0 or v_credit < 0 then
      raise exception 'a journal line cannot carry a negative amount';
    end if;
    if v_debit = 0 and v_credit = 0 then
      raise exception 'a journal line must carry an amount';
    end if;
    if v_debit > 0 and v_credit > 0 then
      raise exception 'a journal line is a debit or a credit, not both';
    end if;
    -- The account has to belong to THIS shop. Without this check a caller
    -- holding ledger.manage on one shop could post into another's chart, since
    -- the function is security definer and RLS no longer applies.
    if not exists (
      select 1 from public.ledger_accounts a
       where a.id = v_account_id and a.shop_id = p_shop_id and not a.archived
    ) then
      raise exception 'account % is not an active account of this shop', v_account_id;
    end if;
    -- The rule the whole hybrid rests on, checked here because here is the
    -- only place a hand-posted line can get in. A fed account reports its
    -- operational stream; a line posted against it is added to that stream
    -- rather than replacing it, and the account then states more than the shop
    -- has. See the chart-of-accounts migration.
    if exists (
      select 1 from public.ledger_accounts a where a.id = v_account_id and a.feed is not null
    ) then
      raise exception 'account % reports a live figure and cannot be posted to by hand', v_account_id;
    end if;

    v_debits := v_debits + v_debit;
    v_credits := v_credits + v_credit;
  end loop;

  if v_debits <> v_credits then
    raise exception 'entry does not balance: debits %, credits %', v_debits, v_credits;
  end if;

  -- Serialises number allocation per shop for the rest of the transaction, so
  -- two people posting at once cannot both read the same max and collide on
  -- the unique index. Transaction-scoped, so it is released by the commit or
  -- the rollback either way -- the shape 20260804040000 used for payroll.
  perform pg_advisory_xact_lock(hashtext('journal:' || p_shop_id::text));
  select coalesce(max(entry_no), 0) + 1 into v_entry_no
    from public.journal_entries where shop_id = p_shop_id;

  insert into public.journal_entries (shop_id, location_id, entry_no, entry_date, memo, reference, source, source_id, created_by)
    values (p_shop_id, p_location_id, v_entry_no, p_entry_date, nullif(p_memo, ''), nullif(p_reference, ''), p_source, p_source_id, auth.uid())
    returning id into v_entry_id;

  for v_line in select * from jsonb_array_elements(p_lines) loop
    v_index := v_index + 1;
    insert into public.journal_lines (entry_id, account_id, line_no, debit_cents, credit_cents, memo)
      values (
        v_entry_id,
        (v_line->>'account_id')::uuid,
        v_index,
        coalesce((v_line->>'debit_cents')::integer, 0),
        coalesce((v_line->>'credit_cents')::integer, 0),
        nullif(v_line->>'memo', '')
      );
  end loop;

  perform public.write_accounting_audit(
    p_shop_id, 'post', 'journal_entry', v_entry_id,
    'JE-' || v_entry_no || coalesce(' · ' || nullif(p_memo, ''), ''),
    v_debits::integer, null
  );

  return v_entry_id;
end;
$$;

grant execute on function public.post_journal_entry(uuid, jsonb, date, text, text, uuid, text, uuid) to authenticated;

-- Undoes an entry by posting its mirror image. See the header: the original
-- stays exactly as it was written.
create or replace function public.reverse_journal_entry(
  p_entry_id uuid,
  p_reversed_on date default current_date,
  p_memo text default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_entry public.journal_entries%rowtype;
  v_entry_id uuid;
  v_entry_no integer;
  v_total bigint;
begin
  select * into v_entry from public.journal_entries where id = p_entry_id;
  if v_entry.id is null then
    raise exception 'journal entry % not found', p_entry_id;
  end if;
  if not public.has_shop_permission(v_entry.shop_id, 'ledger.manage') then
    raise exception 'not authorized to post to this shop''s ledger';
  end if;
  if v_entry.source = 'reversal' then
    -- Reversing a reversal re-posts the original with a third entry number and
    -- no way to tell the chain apart. Post a fresh entry instead, which is
    -- what the reader will be able to follow.
    raise exception 'a reversal cannot itself be reversed';
  end if;
  -- Belt as well as the unique index: this gives the caller a sentence rather
  -- than a constraint violation.
  if exists (select 1 from public.journal_entries where reverses_id = p_entry_id) then
    raise exception 'this entry has already been reversed';
  end if;

  perform pg_advisory_xact_lock(hashtext('journal:' || v_entry.shop_id::text));
  select coalesce(max(entry_no), 0) + 1 into v_entry_no
    from public.journal_entries where shop_id = v_entry.shop_id;

  insert into public.journal_entries (shop_id, location_id, entry_no, entry_date, memo, reference, source, source_id, reverses_id, created_by)
    values (
      v_entry.shop_id, v_entry.location_id, v_entry_no, p_reversed_on,
      coalesce(nullif(p_memo, ''), 'Reversal of JE-' || v_entry.entry_no),
      v_entry.reference, 'reversal', v_entry.source_id, v_entry.id, auth.uid()
    )
    returning id into v_entry_id;

  -- Debits become credits and back. `line_no` is carried across so the
  -- reversal reads in the same order as the entry it undoes.
  insert into public.journal_lines (entry_id, account_id, line_no, debit_cents, credit_cents, memo)
    select v_entry_id, l.account_id, l.line_no, l.credit_cents, l.debit_cents, l.memo
      from public.journal_lines l where l.entry_id = p_entry_id
     order by l.line_no;

  select coalesce(sum(debit_cents), 0) into v_total from public.journal_lines where entry_id = v_entry_id;

  perform public.write_accounting_audit(
    v_entry.shop_id, 'reverse', 'journal_entry', v_entry_id,
    'JE-' || v_entry_no || ' reverses JE-' || v_entry.entry_no,
    -v_total::integer, null
  );

  return v_entry_id;
end;
$$;

grant execute on function public.reverse_journal_entry(uuid, date, text) to authenticated;

-- ---------------------------------------------------------------------------
-- What the trial balance reads
-- ---------------------------------------------------------------------------
-- Posted movement per account, as of a date. The `feed` half of an account's
-- balance is computed on the client from data it already holds (see
-- src/lib/trial-balance.ts) -- this is the half that has rows behind it.
--
-- security invoker, so the caller's own read policy on journal_lines decides
-- what comes back.
create or replace function public.ledger_account_movement(
  p_shop_id uuid,
  p_from date default null,
  p_to date default null
) returns table (account_id uuid, debit_cents bigint, credit_cents bigint, line_count bigint)
language sql stable set search_path = public as $$
  select l.account_id,
         sum(l.debit_cents)::bigint,
         sum(l.credit_cents)::bigint,
         count(*)::bigint
    from public.journal_lines l
    join public.journal_entries e on e.id = l.entry_id
   where e.shop_id = p_shop_id
     and (p_from is null or e.entry_date >= p_from)
     and (p_to is null or e.entry_date <= p_to)
   group by l.account_id;
$$;

grant execute on function public.ledger_account_movement(uuid, date, date) to authenticated;
