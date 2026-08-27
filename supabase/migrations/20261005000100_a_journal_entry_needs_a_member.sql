-- A stranger could post journal entries into any shop. They cannot now.
--
-- ## THE HOLE, EXACTLY
--
-- post_journal_entry() has gated on `ledger.post` since 20260904000500 -- but
-- only for one source:
--
--   if p_source = 'manual' and not has_shop_permission(p_shop_id, 'ledger.post')
--
-- The function is `security definer`, so it bypasses RLS on journal_entries,
-- journal_lines and accounting_periods alike, and it is `granted to
-- authenticated`, so it is reachable over PostgREST with nothing but a
-- logged-in account and the anon key -- src/lib/ledger.ts already calls it that
-- way. Pass any other permitted source and NOTHING checks that the caller has
-- ever heard of the shop. Reproduced against the live stack, session set up
-- exactly as PostgREST sets one up:
--
--   NOTICE:  CASHIER POSTED source=close: b59ad1c6-…   -- role holds pos.access only
--   NOTICE:  STRANGER POSTED source=sale: fa273365-…   -- no shop_members row at all
--
-- THIS PREDATES PHASE 3B (20260904000500) and is not phase 3b's mistake. It is
-- fixed here because phase 3b re-creates the function in full and because phase
-- 3b ESCALATES it: `'close'` used to be a value in a CHECK constraint that
-- nothing wrote and no reader treated specially. Now statement_lines() and
-- cash_flow() ignore `source = 'close'` entirely while balance_sheet() subtracts
-- its P&L side from "Profit this period" -- so a forged `Dr 1000 / Cr 4000`
-- filed as `'close'` was invisible to the income statement and the cash flow,
-- including cash_flow()'s observed-cash reading, and visible to the balance
-- sheet. Reconciliation 5 would then report a discrepancy whose cause is not in
-- the arithmetic at all.
--
-- ## THE OBVIOUS FIX IS WRONG, and it would stop the till
--
-- Gating every source on `ledger.post` breaks the cashier. complete_sale,
-- refund_sale_items, settle_sale_balance, receive_stock, save_stock_count,
-- record_invoice_payment, post_payroll_run, edit_sale, the expenses trigger and
-- close_accounting_period all call this AS THE ACTING USER, from inside their
-- own security definer bodies, having already gated on the permission THEIR
-- door needs. A cashier ringing up a sale holds `pos.access` and must not need
-- `ledger.post` -- that is the whole reason the source-specific gate was written
-- this way, and 20260904000500's comment says so. A fix that breaks a sale is
-- worse than the hole.
--
-- ## THE RULE CHOSEN: MEMBERSHIP FOR EVERY SOURCE, ledger.post ON TOP FOR MANUAL
--
--   a signed-in caller must be a MEMBER of the shop   every source, no exception
--   + has_shop_permission(…, 'ledger.post')           additionally, for 'manual'
--
-- "A SIGNED-IN CALLER", i.e. `auth.uid() is not null and not is_shop_member(…)`,
-- and the qualifier is deliberate rather than a loophole left open by accident.
-- There is exactly one way to reach this function with no user at all: to be
-- `postgres` or `service_role` already, or to be a trigger fired by one --
-- verify-entitlements.sql and verify-inventory-permissions.sql both insert an
-- `expenses` row as superuser and reach here through post_expense_to_ledger,
-- and so would any maintenance script or data-fixing migration. `anon` HOLDS NO
-- EXECUTE GRANT on this function and never has, so the anonymous storefront
-- cannot arrive here at all, and a role that can already write journal_entries
-- directly, RLS and all, is above the boundary this gate draws rather than
-- outside it. Refusing those would break honest backend writes to protect
-- against a caller who does not need the protection defeated. The codebase
-- already names this actor: closedByLabel() renders a close with no actor as
-- "System -- a migration or a maintenance script".
--
-- It is the minimum that closes the hole. `is_shop_member` is the existing
-- predicate -- owner, or an active row in shop_members -- and it is what every
-- RLS policy in this database already means by "belongs to this shop", so this
-- adds no new notion of access and no new place to keep one in step. Every real
-- caller listed above is reached by a member and only by a member:
--
--   * the RPCs are granted to `authenticated` and each gates on a permission
--     that only a member's role can carry (pos.access, inventory.receive,
--     ledger.close, …) -- a permission check already implies membership, so the
--     new check is redundant behind them and costs one index lookup;
--   * post_expense_to_ledger and the three reverse_*_entry triggers fire on
--     expenses, invoice_payments and stock_receipts -- tables whose RLS write
--     policies already require membership, so the row could not have been
--     written by a stranger in the first place;
--   * NO ANON PATH REACHES IT. place_order() -- the storefront's one write, the
--     only door open to `anon` -- posts nothing to the ledger; it writes an
--     order, and the ledger entry happens later when a member turns that order
--     into a sale. Checked against pg_proc: no function reachable by anon
--     mentions post_journal_entry.
--   * NO BACKFILL PATH REACHES IT EITHER. backfill_shop_ledger() deliberately
--     builds its entries by hand rather than through this wrapper (its header
--     says why: open_period_for raises on a closed month and would abort the
--     replay half-way), and reverse_journal_entry() likewise builds its own so
--     it can keep the original's reference. Both are gated on their own
--     permissions.
--
-- WHAT IT DOES NOT DO: it does not stop a member using a source their door
-- would not have used -- a cashier can still call post_journal_entry directly
-- with `source = 'close'`. Closing that needs the non-manual sources to be
-- unreachable from `authenticated` at all (a separate grant, or a session flag
-- set only by the calling definer function), which is a bigger change than a
-- tenant-boundary fix should smuggle in, and it is a MEMBER forging their own
-- shop's books rather than a stranger forging somebody else's. The tenant
-- boundary is the breach; this closes it. The intra-shop source discipline is
-- written down here as the next piece of work rather than left implied.
--
-- Reproduced in full from 20261002000100 per this repo's convention that the
-- newest definition of a function is the whole of it. Changed: the membership
-- gate, and nothing else.
create or replace function public.post_journal_entry(
  p_shop_id uuid,
  p_entry_date date,
  p_description text,
  p_lines jsonb,
  p_location_id uuid default null,
  p_source text default 'manual',
  -- A deliberate adjusting entry into a month that has closed. See
  -- open_period_for (20261002000100) for the two conditions that must hold
  -- together.
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
  -- MEMBERSHIP FIRST, FOR EVERY SOURCE. security definer bypasses RLS, so
  -- without this a logged-in stranger could write entries into any shop by
  -- passing any source other than 'manual'. `auth.uid() is not null` scopes it
  -- to a caller who HAS a user: a call with none is postgres or service_role,
  -- which could write journal_entries directly anyway, and anon holds no
  -- execute grant here. See the header.
  if auth.uid() is not null and not public.is_shop_member(p_shop_id) then
    raise exception 'You do not have access to this shop.' using errcode = 'P0001';
  end if;

  -- Manual entries need ledger.post ON TOP. A posting phase's RPC will call
  -- this with p_source <> 'manual' from inside its own security definer
  -- function, where the caller has already been gated on the permission that
  -- door needs -- a cashier completing a sale holds pos.access and must not
  -- need ledger.post.
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

comment on function public.post_journal_entry(uuid, date, text, jsonb, uuid, text, boolean) is
  'Posts a balanced journal entry, allocating its JE- reference from journal_entry_sequences and resolving its period through open_period_for(). REQUIRES MEMBERSHIP OF THE SHOP FOR EVERY SOURCE -- it is security definer and would otherwise let a logged-in stranger write into any shop by passing a source other than ''manual'' -- and ledger.post ON TOP for ''manual'', so that a cashier completing a sale needs pos.access and not ledger.post. Refuses an entry that does not balance, naming the difference, and an unknown account code, naming it.';
