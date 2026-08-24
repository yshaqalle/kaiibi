-- Journal references are allocated from a counter, not from count(*).
--
-- ## What was here before, and why it raced
--
-- 20260904000500 allocated an entry's reference by counting the shop's entries
-- for the year and adding one:
--
--   select 'JE-' || v_year || '-' || lpad((count(*) + 1)::text, 4, '0')
--     into v_ref
--     from public.journal_entries
--    where shop_id = p_shop_id and to_char(entry_date, 'YYYY') = v_year;
--
-- ...then inserted against `unique (shop_id, reference)` (20260904000300:61).
--
-- Under READ COMMITTED -- Postgres's default, and this database's -- a count()
-- sees only rows committed when the statement began. Two sales rung up in the
-- same shop at the same moment therefore both count N, both build
-- 'JE-2026-000(N+1)', and the second raises
--
--   duplicate key value violates unique constraint
--   "journal_entries_shop_id_reference_key"
--
-- the instant the first commits.
--
-- The old comment claimed "the loser violates the unique and retries at the
-- application layer". THERE IS NO SUCH RETRY. src/lib/sales.ts does
-- `if (error) throw error`, and src/lib/checkout-errors.ts passes an unknown
-- message through verbatim -- so the cashier is shown the raw constraint name
-- and loses the basket. That was survivable while only the manual-entry screen
-- called post_journal_entry, because two people typing a journal entry in the
-- same second is not a thing that happens. 20260908000200 makes EVERY SALE call
-- it, on the hottest path in the app, where two tills ringing up at once is the
-- normal case rather than the unlucky one.
--
-- ## What replaces it
--
-- A per-shop-per-year counter row, taken with a single INSERT ... ON CONFLICT
-- DO UPDATE ... RETURNING. That statement takes a row lock on the counter, so a
-- second transaction blocks until the first commits or rolls back and then
-- reads the updated value -- one number to one caller, no collision, no retry
-- loop to write.
--
-- A plain Postgres SEQUENCE would also be race-free, but a sequence is shared:
-- shop A's next number would jump by however many entries shop B posted in
-- between, which leaks one tenant's trading volume to another. It would also
-- leave gaps on rollback. This counter is a real table, so a transaction that
-- fails rolls its number back with everything else and the numbering stays
-- gapless -- which is what an auditor expects of a journal.
--
-- ## And it stops being O(entries)
--
-- The old count() was a sequential scan (there is no index on
-- (shop_id, to_char(entry_date,'YYYY'))) over every entry the shop had ever
-- posted, run once per post. A shop with 50,000 entries paid for all 50,000 to
-- ring up its 50,001st sale, and the cost grew forever. The counter is a single
-- primary-key lookup whose cost never changes.

create table if not exists public.journal_entry_sequences (
  shop_id uuid not null references public.shops(id) on delete cascade,
  year text not null,
  -- The number the NEXT entry will take. Read-and-increment in one statement;
  -- never read on its own and written back, which is the race all over again.
  next_number integer not null default 1,
  primary key (shop_id, year)
);

-- Existing shops keep their numbering. Without this the counter starts at 1 for
-- a shop that already has JE-2026-0001..0042 and the forty-third sale of the
-- year collides with an entry posted months ago -- the exact failure this
-- migration exists to remove, reintroduced by the fix for it.
insert into public.journal_entry_sequences (shop_id, year, next_number)
select shop_id, to_char(entry_date, 'YYYY'), count(*) + 1
  from public.journal_entries
 group by shop_id, to_char(entry_date, 'YYYY')
on conflict do nothing;

-- Written only through post_journal_entry, which is security definer. No policy
-- and no grant, for the same reason journal_entries has no write policy: a
-- caller who can bump this counter by hand can burn a reference number or hand
-- two entries the same one.
alter table public.journal_entry_sequences enable row level security;
revoke all on public.journal_entry_sequences from anon, authenticated;

-- ── post_journal_entry, verbatim from 20260904000500 except the reference ──
--
-- Reproduced in full rather than patched, per this repo's convention: the
-- newest definition of a function is the whole of it, in one place, so the next
-- reader does not have to replay a chain of substitutions to know what runs.
create or replace function public.post_journal_entry(
  p_shop_id uuid,
  p_entry_date date,
  p_description text,
  p_lines jsonb,
  p_location_id uuid default null,
  p_source text default 'manual'
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

  -- Raises if the month is closed or locked, and opens it if it is the first
  -- entry of that month.
  v_period := public.open_period_for(p_shop_id, p_entry_date);

  -- Per shop per year, gapless, and serialised. ONE statement: the upsert takes
  -- a row lock on the counter, so a concurrent poster blocks here rather than
  -- reading the same number and losing a unique-violation race at the insert
  -- below. See this migration's header for what that race did to a sale.
  --
  -- `next_number - 1` because the row is left holding the number the NEXT
  -- caller gets: the insert path stores 2 and returns 1, the update path stores
  -- N+1 and returns N.
  insert into public.journal_entry_sequences (shop_id, year, next_number)
    values (p_shop_id, v_year, 2)
    on conflict (shop_id, year) do update set next_number = public.journal_entry_sequences.next_number + 1
    returning next_number - 1 into v_seq;
  v_ref := 'JE-' || v_year || '-' || lpad(v_seq::text, 4, '0');

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

grant execute on function public.post_journal_entry(uuid, date, text, jsonb, uuid, text) to authenticated;
