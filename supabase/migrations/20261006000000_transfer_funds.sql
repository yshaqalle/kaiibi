-- Moving a shop's own money from one place it keeps money to another.
--
-- The ledger has had four cash accounts since 20260904000100 -- 1000 Cash on
-- Hand, 1010 Bank, 1020 Zaad, 1021 eDahab -- and no door between them. A shop
-- that banks its till float at the end of the week, or tops the till up from
-- Zaad, has had two honest options: type a manual journal entry (which needs
-- ledger.post, which no default role except the owner holds), or leave the
-- books saying the money is still in the till. Both are worse than the third
-- thing that actually happens, which is that nobody records it at all and the
-- balance sheet's Cash on Hand drifts away from the drawer.
--
-- Dr the destination, Cr the source. Nothing else moves: this is not income,
-- not a cost, and not a change in what the shop is worth. Total cash before
-- equals total cash after, which is why cash_flow()'s observed movement is
-- unchanged by it -- see the "cash-like" note below, which is the whole reason
-- the account list here is the list it is.
--
-- ## WHAT COUNTS AS CASH: THE EXPLICIT FOUR, NOT A RANGE AND NOT A TYPE
--
-- A "transfer" is only a transfer if BOTH legs are money. Dr 1000 / Cr 4000 is
-- a balanced entry that invents revenue; Dr 1000 / Cr 1200 is a balanced entry
-- that makes inventory vanish. Three ways to constrain it were available:
--
--   * type = 'asset'      -- admits 1200 Inventory and 1500 Equipment. No.
--   * a code range        -- 1000-1099 admits any account a shop invents in
--                            that band. The chart is PER SHOP and the accounts
--                            table takes any code a ledger.close holder types,
--                            so this is not a closed set.
--   * THE EXPLICIT FOUR   -- chosen.
--
-- The deciding argument is not tidiness, it is that cash_flow() already carries
-- an explicit list of exactly these four codes for its observed-cash proof
-- (20261001000200:204, carried into 20261004000100), and that proof is what
-- catches a sign slip anywhere in the statement. If this function admitted a
-- code that the proof does not count as cash, a transfer would move one side of
-- the proof and not the other, and the cash flow would report a discrepancy
-- whose cause is not in its arithmetic at all -- the exact failure mode
-- 20261004000100 was written to close for a different reason. Two lists that
-- must agree are a liability; the mitigation is that verify-transfers.sql
-- enumerates EVERY account in a seeded chart, asserts this function accepts
-- exactly these four, and separately asserts a transfer leaves the proof's
-- movement untouched. A widened guard reddens the first; a leg landing off the
-- list reddens the second.
--
-- ## THE GATE: budgets.manage, NOT ledger.post
--
-- ledger.post is the obvious grant and it is the wrong one. Banking the float
-- is not a bookkeeping act in the owner's head, and the permission catalog
-- already has the one that means this: budgets.manage, "Manage budgets and
-- cash -- set category budgets, recurring bills, and cash-on-hand balances"
-- (src/lib/permissions.ts:97). It is what every Cash & Budgets door uses today
-- -- the RLS policies on cash_accounts, recurring_bills and budgets
-- (20260804000500:84-94) and the tab itself (cash-budgets-tab.tsx:78) -- and
-- this operation belongs on that screen.
--
-- It also lands on the right people. The default Manager
-- (20260823000000:78-83) holds budgets.manage and NO ledger permission at all,
-- which is precisely the person who takes the day's takings to the bank; under
-- ledger.post they would have to ask the owner. That a Manager thereby writes a
-- journal entry they cannot read is not a new shape: they already hold
-- expenses.manage, and an expense posts Dr the category / Cr cash through
-- post_expense_to_ledger without ledger.post either.
--
-- Nothing is opened up by this that was not already reachable: anyone holding
-- ledger.post can type these same two lines by hand and always could. The gate
-- decides who gets the door, not what the door can do.
--
-- post_journal_entry additionally requires MEMBERSHIP of the shop for every
-- source since 20261005000400, so the tenant boundary is checked twice -- once
-- here, because has_shop_permission is false for a non-member, and once there.
-- Both are wanted: this function is security definer and would otherwise be
-- the same hole in a new wrapper.
--
-- ## THE CLOSED-PERIOD REDIRECT APPLIES
--
-- p_on is a date the user types, and 20260908000500:181 names a user-chosen
-- date with no redirect as a defect it was fixed for: open_period_for raises on
-- a closed month, so a shop that closed July and then, in August, recorded a
-- transfer dated 28 July would be told to re-open the period. Same answer as
-- every other posting site with a free date field -- recognise it in the open
-- period, carry the true date and the period's status in the description.
-- coalesce on the status, for the reason 20260908000300 found the hard way: a
-- null operand nulls the whole description and post_journal_entry then refuses
-- the transfer for having no description, an error about descriptions for a bug
-- about dates.
--
-- ## NO DELETE OR EDIT PATH, DELIBERATELY
--
-- This function writes no row of its own -- it returns the journal entry id and
-- that entry IS the transfer. There is nothing to delete or edit, so there is
-- nothing to reverse; a transfer entered wrongly is corrected the way every
-- other posted entry is, by reversing it through the ledger. That is why no
-- reversal ships beside it, and the four holes 2b shipped by adding a delete
-- path without one do not have a fifth here.
create or replace function public.transfer_funds(
  p_shop_id uuid,
  p_from_code text,
  p_to_code text,
  p_amount_cents integer,
  -- Null, not shop_local_date() as the default expression, so that an explicit
  -- null from a client that always sends every argument behaves the same as an
  -- omitted one. Resolved below.
  p_on date default null,
  p_note text default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  -- Never now()::date or current_date: both resolve in the session's timezone,
  -- which is UTC on Supabase, while every market kaiibi serves is UTC+3. A
  -- transfer entered at 01:00 local would be dated yesterday and, on the 1st of
  -- a month, into a period that may already be shut.
  v_on date := coalesce(p_on, public.shop_local_date());
  v_from_name text;
  v_to_name text;
  -- The status of the period v_on falls in, or NULL when no row exists for that
  -- month. NULL is not closed and not open either -- it is "nobody has traded
  -- in this month", which open_period_for turns into an open period on demand.
  v_period_status text;
  v_posted_date date;
  v_note text := nullif(trim(coalesce(p_note, '')), '');
  v_entry_id uuid;
begin
  -- FIRST, so a refusal has nothing to roll back. See the header for why this
  -- permission and not the ledger one.
  if not public.has_shop_permission(p_shop_id, 'budgets.manage') then
    raise exception 'You do not have permission to move money between accounts.'
      using errcode = 'P0001';
  end if;

  -- journal_lines has check (amount_cents <> 0) and would refuse a zero anyway,
  -- with a constraint name. A negative amount it would NOT refuse: it would
  -- post a backwards transfer that balances perfectly. Both are caught here, in
  -- a sentence naming what was asked for.
  if p_amount_cents is null or p_amount_cents <= 0 then
    raise exception 'A transfer must be for more than zero; % was asked for.',
      coalesce(p_amount_cents::text, 'nothing') using errcode = 'P0001';
  end if;

  if p_from_code is null or p_to_code is null then
    raise exception 'A transfer needs an account to come from and an account to go to.'
      using errcode = 'P0001';
  end if;

  -- Two lines that sum to zero against the same account. It balances, it posts,
  -- and it means nothing -- and on a statement it reads as activity.
  if p_from_code = p_to_code then
    raise exception 'A transfer needs two different accounts; % was given for both.',
      p_from_code using errcode = 'P0001';
  end if;

  -- The list, and the header argues at length for its being a list.
  if p_from_code <> all (array['1000', '1010', '1020', '1021'])
     or p_to_code <> all (array['1000', '1010', '1020', '1021']) then
    raise exception
      'A transfer moves money between cash accounts (1000, 1010, 1020, 1021); % to % is not one.',
      p_from_code, p_to_code using errcode = 'P0001';
  end if;

  -- THE SHOP'S OWN. security definer bypasses RLS on accounts, so this filter
  -- is the whole of the tenant boundary at this door -- without it a caller
  -- holding the permission in their own shop reads another shop's chart. Both
  -- names in one read so the two cannot disagree about which shop was asked
  -- about. archived_at is null because post_journal_entry resolves codes the
  -- same way and would otherwise fail later with a message about the chart.
  select max(a.name) filter (where a.code = p_from_code),
         max(a.name) filter (where a.code = p_to_code)
    into v_from_name, v_to_name
    from public.accounts a
   where a.shop_id = p_shop_id
     and a.code in (p_from_code, p_to_code)
     and a.archived_at is null;

  if v_from_name is null or v_to_name is null then
    raise exception 'No such account in this shop: %. Check the chart of accounts.',
      case when v_from_name is null then p_from_code else p_to_code end
      using errcode = 'P0001';
  end if;

  -- Only an EXISTING non-open period redirects; no row at all means
  -- open_period_for will create it open.
  select ap.status into v_period_status
    from public.accounting_periods ap
   where ap.shop_id = p_shop_id and v_on between ap.starts_on and ap.ends_on;

  if v_period_status is not null and v_period_status <> 'open' then
    v_posted_date := public.shop_local_date();
  else
    v_posted_date := v_on;
  end if;

  v_entry_id := public.post_journal_entry(
    p_shop_id, v_posted_date,
    'Transferred from ' || v_from_name || ' to ' || v_to_name
      || coalesce(' — ' || v_note, '')
      || case when v_posted_date <> v_on
              then ' (moved ' || to_char(v_on, 'YYYY-MM-DD')
                   || '; that period is ' || coalesce(v_period_status, 'not open')
                   || ', so it is recognised here)'
              else '' end,
    jsonb_build_array(
      -- Dr the destination: the money arrives there and an asset increases on
      -- the debit side.
      jsonb_build_object('code', p_to_code, 'amount_cents', p_amount_cents,
                         'memo', 'Received from ' || v_from_name),
      -- Cr the source.
      jsonb_build_object('code', p_from_code, 'amount_cents', -p_amount_cents,
                         'memo', 'Sent to ' || v_to_name)),
    -- No store. The signature carries no location and a transfer between the
    -- shop's accounts is not an event at one of them; null is a real value here
    -- and not a gap, exactly as it is for a business-wide bill.
    null, 'transfer');

  return v_entry_id;
end;
$$;

-- Revoked from PUBLIC before it is granted, so the grants below are the entire
-- list of who can call this -- the convention 20261005000400 set after
-- PostgreSQL's default grant to PUBLIC turned out to be the reason `anon` could
-- reach post_journal_entry. This function is security definer too, and while
-- has_shop_permission answers false for a caller with no user, one barrier
-- being believed to be two is exactly how that hole shipped.
revoke execute on function public.transfer_funds(uuid, text, text, integer, date, text) from public;
grant execute on function public.transfer_funds(uuid, text, text, integer, date, text) to authenticated;
grant execute on function public.transfer_funds(uuid, text, text, integer, date, text) to service_role;

comment on function public.transfer_funds(uuid, text, text, integer, date, text) is
  'Moves money between two of the shop''s own cash accounts, posting Dr the destination / Cr the source with source ''transfer''. Both codes must be one of 1000, 1010, 1020 and 1021 -- the same four cash_flow() counts as cash, so a transfer leaves its observed-cash proof untouched -- must belong to THIS shop, and must differ. A zero or negative amount is refused. Gated on budgets.manage, not ledger.post: it is what every other Cash & Budgets door uses and what the default Manager who banks the float already holds. A date falling in a closed or locked period is recognised in the current one, carrying the true date and the period''s status in the description.';
