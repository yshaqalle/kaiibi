-- The only two doors into the ledger.
--
-- journal_entries and journal_lines have no write policy, so these are not a
-- convenience over an insert -- they are the whole of how anything is written.
-- Modelled on receive_stock() and save_stock_count() down to the security
-- definer + no-policy posture, for the same reason: several things have to be
-- true together, and a caller that can do half of them can leave the books in
-- a state that no report knows how to describe.
--
-- ## Lines arrive as account CODES, not ids
--
-- Every future posting site -- complete_sale, receive_stock, the depreciation
-- run -- knows it wants "5100" and does not want to carry a per-shop lookup to
-- turn that into a uuid. Resolving here means one place gets it wrong at most,
-- and an unknown code is refused by the code the caller actually typed.

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

  -- Per shop per year, gapless enough to read. Taken under the lock the insert
  -- itself holds via the unique (shop_id, reference) index: two concurrent
  -- posts race, the loser violates the unique and retries at the application
  -- layer. A sequence would be gap-free but shared across shops, which would
  -- leak how many entries other shops post.
  select 'JE-' || v_year || '-' || lpad((count(*) + 1)::text, 4, '0')
    into v_ref
    from public.journal_entries
   where shop_id = p_shop_id and to_char(entry_date, 'YYYY') = v_year;

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

-- Correcting a posted entry, which is never an edit.
--
-- Writes a second entry whose lines are the first's, negated, and links the two
-- in both directions. Both stay on the record: the mistake and the correction.
-- That is the difference between a book and a document -- a document is
-- amended, a book is added to.
--
-- The reversal is dated to the ORIGINAL's date, not today. A correction to
-- August belongs in August; dating it to September would leave August
-- overstated and September understated, and every monthly comparison after that
-- would be wrong in two directions at once. If August is closed, the reversal
-- is refused by open_period_for and the caller must re-open it -- which is the
-- correct thing to make somebody decide, and is why 'closed' is reversible.
create or replace function public.reverse_journal_entry(
  p_entry_id uuid,
  p_reason text
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_shop uuid;
  v_status text;
  v_date date;
  v_ref text;
  v_loc uuid;
  v_new uuid;
begin
  select shop_id, status, entry_date, reference, location_id
    into v_shop, v_status, v_date, v_ref, v_loc
    from public.journal_entries where id = p_entry_id;

  if v_shop is null then
    raise exception 'No such journal entry.' using errcode = 'P0001';
  end if;
  if not has_shop_permission(v_shop, 'ledger.post') then
    raise exception 'You do not have permission to reverse journal entries.'
      using errcode = 'P0001';
  end if;
  if v_status = 'reversed' then
    raise exception 'That entry has already been reversed.' using errcode = 'P0001';
  end if;
  if v_status <> 'posted' then
    raise exception 'Only a posted entry can be reversed; this one is %.', v_status
      using errcode = 'P0001';
  end if;
  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'Say why this entry is being reversed.' using errcode = 'P0001';
  end if;

  -- Built by hand rather than through post_journal_entry: the reference has to
  -- be the original's with an R, so the pair reads as a pair in the journals
  -- list, and post_journal_entry allocates a fresh JE- number.
  insert into public.journal_entries
      (shop_id, period_id, entry_date, reference, description, source, status,
       location_id, reverses_entry_id, created_by)
    values (v_shop, public.open_period_for(v_shop, v_date), v_date, v_ref || 'R',
            'Reversal of ' || v_ref || ' — ' || trim(p_reason),
            'manual', 'posted', v_loc, p_entry_id, auth.uid())
    returning id into v_new;

  insert into public.journal_lines (entry_id, account_id, amount_cents, location_id, memo)
    select v_new, account_id, -amount_cents, location_id, memo
      from public.journal_lines where entry_id = p_entry_id;

  -- The one update refuse_posted_entry_edit() permits.
  update public.journal_entries
     set status = 'reversed', reverses_entry_id = v_new
   where id = p_entry_id;

  return v_new;
end;
$$;

grant execute on function public.reverse_journal_entry(uuid, text) to authenticated;
