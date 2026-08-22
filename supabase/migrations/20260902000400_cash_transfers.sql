-- Moving money between the shop's own pots: the till banked at close, a float
-- taken out for the market stall, cash swept from a mobile-money wallet.
--
-- Today an owner does this by editing two balances by hand, and the two edits
-- are independent -- one can land and the other not, and nothing anywhere says
-- the two figures were meant to be one movement. That is how a shop ends up
-- looking $500 richer or poorer than it is and nobody can find the entry.
--
-- What this is NOT, and the reason is the whole design of the ledger (see the
-- chart-of-accounts migration): a transfer posts **no journal entry**. The cash
-- accounts are what the `cash_on_hand`, `bank` and `mobile_money` feeds report,
-- so the moment both balances move the ledger has already seen it, on both
-- sides, in the right direction. Posting an entry as well would count the
-- movement twice.
--
-- It also, correctly, changes nothing at all on the profit-and-loss statement
-- or in the cash-flow statement's bottom line. Banking your own takings is not
-- income and does not alter how much cash the business holds -- only where it
-- is sitting. The transfer list exists so a reader can SEE that, rather than
-- finding two unexplained balance changes on the same afternoon.

create table public.cash_transfers (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  -- `restrict`, not cascade: a cash account with transfers behind it cannot be
  -- deleted out from under them, because the transfer is the explanation for a
  -- balance change on the OTHER account and deleting it leaves that change
  -- unexplained.
  from_account_id uuid not null references public.cash_accounts(id) on delete restrict,
  to_account_id uuid not null references public.cash_accounts(id) on delete restrict,
  amount_cents integer not null check (amount_cents > 0),
  transferred_on date not null default current_date,
  -- The shop's own cross-reference: a deposit slip, a wallet transaction id.
  reference text,
  note text,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  -- Both halves of a movement to itself cancel, so the row would record a
  -- transfer that did nothing while looking like one that did something.
  constraint cash_transfers_distinct_accounts check (from_account_id <> to_account_id)
);
create index cash_transfers_shop_date_idx on public.cash_transfers(shop_id, transferred_on desc);
create index cash_transfers_from_idx on public.cash_transfers(from_account_id);
create index cash_transfers_to_idx on public.cash_transfers(to_account_id);

alter table public.cash_transfers enable row level security;

-- Same audience as the cash accounts themselves (20260804000500): they are one
-- planning surface, and a transfer is unreadable without the balances it moved
-- between.
create policy "read cash_transfers" on public.cash_transfers for select
  using (has_any_shop_permission(shop_id, array['budgets.manage', 'ledger.view', 'ledger.manage']));

-- No insert policy: a transfer written directly would move nothing, leaving a
-- record of a movement that never happened. It arrives through the RPC below,
-- which moves both balances in the same transaction.
--
-- No update or delete policy either. A transfer that was wrong is corrected by
-- transferring back -- the same reasoning that makes a journal entry reversible
-- rather than editable, and for the same reason: the balances have already
-- moved, and deleting the record does not move them back.
grant select on public.cash_transfers to authenticated;

-- No audit trigger on this table, unlike the others: the RPC below writes its
-- own entry, and it can name both ends of the movement ("Till → Bank"), which
-- a trigger looking at one row's columns cannot. Two entries for one transfer
-- would be worse than either alone.

-- Records the movement and moves both balances, atomically.
create or replace function public.record_cash_transfer(
  p_from_account_id uuid,
  p_to_account_id uuid,
  p_amount_cents integer,
  p_transferred_on date default current_date,
  p_reference text default null,
  p_note text default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_from public.cash_accounts%rowtype;
  v_to public.cash_accounts%rowtype;
  v_first uuid;
  v_second uuid;
  v_transfer_id uuid;
begin
  if p_from_account_id = p_to_account_id then
    raise exception 'a transfer needs two different accounts';
  end if;
  if p_amount_cents is null or p_amount_cents <= 0 then
    raise exception 'transfer amount must be greater than zero';
  end if;

  -- Locked in a fixed order, smallest id first. Two people transferring
  -- between the same pair in opposite directions at the same moment would
  -- otherwise each hold the row the other is waiting for -- a deadlock, which
  -- Postgres resolves by killing one of them at random.
  v_first := least(p_from_account_id, p_to_account_id);
  v_second := greatest(p_from_account_id, p_to_account_id);
  perform 1 from public.cash_accounts where id = v_first for update;
  perform 1 from public.cash_accounts where id = v_second for update;

  select * into v_from from public.cash_accounts where id = p_from_account_id;
  select * into v_to from public.cash_accounts where id = p_to_account_id;
  if v_from.id is null or v_to.id is null then
    raise exception 'cash account not found';
  end if;
  -- Both ends must be the same shop's. Without this a caller could push money
  -- out of one business and into another, since a security-definer function no
  -- longer sees RLS.
  if v_from.shop_id <> v_to.shop_id then
    raise exception 'both accounts must belong to the same shop';
  end if;
  if not public.has_shop_permission(v_from.shop_id, 'budgets.manage') then
    raise exception 'not authorized to move this shop''s cash';
  end if;

  -- Deliberately no "you don't have that much" check. A till really can be
  -- counted short and a bank account really can be overdrawn -- the accounts
  -- themselves allow a negative balance for exactly that reason
  -- (20260804000500) -- and refusing the entry would only push the owner into
  -- recording something they know to be false.

  update public.cash_accounts
     set balance_cents = balance_cents - p_amount_cents,
         balance_as_of = now(), updated_at = now(), updated_by = auth.uid()
   where id = p_from_account_id;
  update public.cash_accounts
     set balance_cents = balance_cents + p_amount_cents,
         balance_as_of = now(), updated_at = now(), updated_by = auth.uid()
   where id = p_to_account_id;

  insert into public.cash_transfers (shop_id, from_account_id, to_account_id, amount_cents, transferred_on, reference, note, created_by)
    values (v_from.shop_id, p_from_account_id, p_to_account_id, p_amount_cents, p_transferred_on, nullif(p_reference, ''), nullif(p_note, ''), auth.uid())
    returning id into v_transfer_id;

  -- Named rather than left to the generic trigger's `reference` label: a
  -- transfer with no deposit slip typed against it would otherwise appear in
  -- the audit log as the bare word "cash_transfer".
  perform public.write_accounting_audit(
    v_from.shop_id, 'create', 'cash_transfer', v_transfer_id,
    v_from.name || ' → ' || v_to.name, p_amount_cents, null
  );

  return v_transfer_id;
end;
$$;

grant execute on function public.record_cash_transfer(uuid, uuid, integer, date, text, text) to authenticated;
