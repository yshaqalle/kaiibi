-- Two doors disagreeing about how much is in the same till, and the reason
-- either could.
--
-- ## THE HOLE, MEASURED
--
-- Phase 3c added three doors that take a date the user types. Two of them refuse
-- a future one:
--
--   create_fixed_asset  (20261006000100:243)  'An asset cannot be acquired in the future'
--   dispose_fixed_asset (20261006000100:398)  'An asset cannot be disposed of in the future'
--   transfer_funds      (20261006000000)      -- nothing
--
-- transfer_funds checks zero and negative amounts, identical codes, the
-- four-code list, the shop's own chart and the closed-period redirect, and never
-- checks that the date is not in the future. The modal offers a free DateInput
-- with no maximum.
--
-- And list_transfer_accounts -- the picker the Manager banks against -- reads
-- balances with NO UPPER DATE BOUND, while its own header claims:
--
--   "THE BALANCE IS READ THE WAY cash_flow()'s PROOF ROW READS IT ... Identical
--    to 20261006000300:202 on purpose ... a screen showing a different figure
--    from the proof row for the same account would be a second definition of
--    'how much is in the till'."
--
-- It was not identical. cash_flow()'s `posted` CTE carries `e.entry_date <= p_to`
-- (20261006000300:152); this had no date predicate at all. Measured on the live
-- stack -- a shop with 500,000 in the till and 120,000 in the bank, one transfer
-- of 75,000 dated 400 days out:
--
--   ACCEPTED a transfer dated 2027-10-01
--   picker      1010 balance      = 195000
--   balance_sheet 1010 as of today = 120000
--   periods now: 2026-07-01, 2027-10-01
--
-- The picker says the bank holds 1,950.00; the balance sheet, the trial balance
-- and the cash flow all say 1,200.00. The transfer also opens an
-- accounting_periods row for October 2027, which the Close a Period screen then
-- lists as a month to close.
--
-- ## BOTH ARE FIXED, BECAUSE EITHER ALONE LEAVES THE SAME DISAGREEMENT
--
-- The future-date refusal on transfer_funds closes the door this branch opened.
-- It does not close the READ: post_journal_entry is a shipped generic door that
-- accepts any date, so a future-dated cash entry can still exist and the picker
-- would still count it while every statement did not. 20261003000000 made
-- period_exceptions() shared precisely so that two doors could not develop two
-- opinions about the same month; the same argument applies to two doors reading
-- the same till.
--
-- So the bound goes on as well, at shop_local_date() -- the shop's own today,
-- never now()::date, for the reason every other date in these files is: UTC is
-- three hours behind every market kaiibi serves, and at 01:00 local an entry
-- posted today would be excluded by a UTC bound. With it the reader is what its
-- header always claimed: cash_flow()'s proof row for the same four codes, as of
-- today -- posted and reversed entries, closes excluded, no lower bound, upper
-- bound today.
--
-- The message follows the two siblings word for word, because a shop that sees
-- one of the three refusals should recognise the other two.

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
  -- FIRST, so a refusal has nothing to roll back. See 20261006000000's header
  -- for why this permission and not the ledger one.
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

  -- THE FUTURE, refused the way its two siblings refuse it. Money the shop does
  -- not have yet cannot have been banked yet, an entry dated forward opens an
  -- accounting period nobody has traded in, and until it arrives the picker and
  -- every statement disagree about the same till. See the header.
  if v_on > public.shop_local_date() then
    raise exception 'A transfer cannot be dated in the future; % is after today.',
      to_char(v_on, 'YYYY-MM-DD') using errcode = 'P0001';
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

  -- The list, and 20261006000000's header argues at length for its being a list.
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

-- The picker, copied forward from 20261007000200, its only previous definition.
-- The one change is the upper date bound its header already claimed it had.
create or replace function public.list_transfer_accounts(p_shop_id uuid)
returns table (
  code text,
  name text,
  balance_cents bigint
)
language plpgsql stable security definer set search_path = public as $$
begin
  -- THE SAME PERMISSION transfer_funds ITSELF DEMANDS. Not ledger.view: the
  -- whole point of this function is that the person who banks the float does
  -- not have ledger.view, and a reader gated differently from the writer is a
  -- picker that is empty for exactly the people the door was built for.
  if not public.has_shop_permission(p_shop_id, 'budgets.manage') then
    raise exception 'You do not have permission to move money between accounts.'
      using errcode = 'P0001';
  end if;

  return query
  select a.code,
         a.name,
         coalesce(sum(l.amount_cents) filter (
           where e.status in ('posted', 'reversed')
             and e.source <> 'close'
             -- THE UPPER BOUND, which is what makes the sentence above this
             -- function true. cash_flow()'s proof row carries `e.entry_date <=
             -- p_to` and this had no date predicate at all, so one future-dated
             -- entry -- transfer_funds used to accept them, and
             -- post_journal_entry still does -- put a figure on the picker that
             -- no statement agreed with. shop_local_date() and never
             -- now()::date: UTC is three hours behind every market kaiibi
             -- serves, so a UTC bound drops an entry the shop posted today.
             and e.entry_date <= public.shop_local_date()), 0)::bigint
    from public.accounts a
    left join public.journal_lines l on l.account_id = a.id
    left join public.journal_entries e on e.id = l.entry_id
   where a.shop_id = p_shop_id
     -- THE EXPLICIT FOUR, the same list transfer_funds accepts and the same
     -- list cash_flow() counts as cash. Not a range and not `type = 'asset'`:
     -- 20261006000000's header argues that at length, and a reader that offered
     -- a fifth code would offer a row the write refuses.
     and a.code in ('1000', '1010', '1020', '1021')
     -- transfer_funds resolves codes with this same filter and would refuse an
     -- archived one with a message about the chart.
     and a.archived_at is null
   group by a.code, a.name
   order by a.code;
end;
$$;

-- `create or replace function` keeps the existing ACL, so these re-state rather
-- than change anything -- the convention 20261005000400 set is that the grants
-- beside a security definer function are the whole list of who can call it, and
-- a reader of this file should not have to open two others to see it.
revoke execute on function public.transfer_funds(uuid, text, text, integer, date, text) from public;
grant execute on function public.transfer_funds(uuid, text, text, integer, date, text) to authenticated;
grant execute on function public.transfer_funds(uuid, text, text, integer, date, text) to service_role;

revoke execute on function public.list_transfer_accounts(uuid) from public;
grant execute on function public.list_transfer_accounts(uuid) to authenticated;
grant execute on function public.list_transfer_accounts(uuid) to service_role;

comment on function public.transfer_funds(uuid, text, text, integer, date, text) is
  'Moves money between two of the shop''s own cash accounts, posting Dr the destination / Cr the source with source ''transfer''. Both codes must be one of 1000, 1010, 1020 and 1021 -- the same four cash_flow() counts as cash, so a transfer leaves its observed-cash proof untouched -- must belong to THIS shop, and must differ. A zero or negative amount is refused, and so is a DATE IN THE FUTURE, the same refusal create_fixed_asset and dispose_fixed_asset carry: money that has not moved yet cannot have been banked yet, and a forward-dated entry opens an accounting period nobody has traded in. Gated on budgets.manage, not ledger.post: it is what every other Cash & Budgets door uses and what the default Manager who banks the float already holds. A date falling in a closed or locked period is recognised in the current one, carrying the true date and the period''s status in the description.';

comment on function public.list_transfer_accounts(uuid) is
  'The four cash accounts transfer_funds moves money between -- 1000, 1010, 1020 and 1021 -- by the SHOP''S OWN names for them, with each one''s ledger balance. Gated on budgets.manage, the same permission transfer_funds itself takes and NOT ledger.view: `accounts` is readable only on ledger.view, which the default Manager who banks the float does not hold, so without this function the person the transfer gate was chosen for could call the write and could not read the list to call it with. Returns exactly those four codes and nothing else about the chart, which is why widening the RLS policy on `accounts` was the wrong fix. Balances are read exactly as cash_flow()''s proof row reads them AS OF TODAY -- posted and reversed entries, excluding closes, no lower bound and an upper bound at shop_local_date() -- so the two cannot say different things about the same till. The upper bound is not decoration: without it one future-dated entry showed the picker a figure no statement agreed with. Archived accounts are excluded, because transfer_funds refuses them.';
