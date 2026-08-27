-- The transfer door is gated on budgets.manage. Its account list was not.
--
-- ## THE GAP, AND WHY IT WOULD HAVE SHIPPED THE FEATURE UNREACHABLE
--
-- 20261006000000 gates transfer_funds on budgets.manage and argues the choice
-- at length: banking the float is a cash operation, every Cash & Budgets door
-- already gates on it, and the DEFAULT MANAGER -- the person who actually takes
-- the day's takings to the bank -- holds budgets.manage and NO ledger
-- permission at all (20260823000000:78-83).
--
-- A screen for that person has to offer them two accounts to pick between, by
-- the shop's own names for them: a shop that renamed 1010 to "Salaam, Hodan
-- branch" must see that, not "Bank". The names live in `accounts`, and
-- `accounts` has been readable on ledger.view alone since 20260904000100:51.
--
-- So the Manager the gate was chosen for could call transfer_funds and could
-- not read the list of accounts to call it with. The RPC would have accepted
-- them; the picker would have been empty. That is the same shape as the
-- auto-close settings phase 3b shipped with nothing able to write them -- a
-- door built for someone who cannot reach the handle.
--
-- Three ways out were available:
--
--   * WIDEN the RLS policy on `accounts` to admit budgets.manage. Rejected:
--     that hands the whole chart -- every revenue, expense and equity account a
--     shop has -- to a permission about cash, to fix a need for four names.
--   * HARDCODE the four names in the client. Rejected: it is right until a shop
--     renames one, and then the picker says "Bank" and the journal entry says
--     "Salaam, Hodan branch" about the same transfer.
--   * A NARROW READER gated on the same permission as the write. CHOSEN. It
--     returns EXACTLY the four accounts transfer_funds accepts, and nothing
--     else about the chart. The gate on it and the gate on the write are the
--     same string, so there is no state in which one works and the other does
--     not.
--
-- ## IT RETURNS THE BALANCE TOO, AND THAT IS A DELIBERATE DISCLOSURE
--
-- The design's transfer frame opens with "Where the money is" and says of it:
-- "These figures are now calculated, not typed." A person moving 3,200 out of a
-- till needs to know the till has it, and the alternative -- typing the amount
-- and finding out from a refusal -- is not a better answer.
--
-- What this discloses to budgets.manage that it did not hold before is the
-- LEDGER balance of four cash accounts. The same permission already reads
-- `cash_accounts.balance_cents` (20260804000500:84), which is the same fact
-- typed rather than derived, for the same four places money sits. It is a
-- narrower disclosure than the one being avoided above, to the person whose job
-- this is, and it is bounded by the same explicit four-code list -- so it can
-- never widen to an account somebody adds later.
--
-- THE BALANCE IS READ THE WAY cash_flow()'s PROOF ROW READS IT: status in
-- ('posted', 'reversed'), source <> 'close', no lower bound. Identical to
-- 20261006000300:202 on purpose -- these are the same four codes that statement
-- counts as cash, and a screen showing a different figure from the proof row
-- for the same account would be a second definition of "how much is in the
-- till". A close never posts to a cash account, so the source filter changes
-- nothing today; it is there so the two readings cannot drift if one ever does.
--
-- Archived accounts are EXCLUDED, matching transfer_funds' own lookup: it
-- resolves codes with `archived_at is null` and would refuse an archived one
-- with a message about the chart. Offering it would be offering a row that
-- raises.

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
           where e.status in ('posted', 'reversed') and e.source <> 'close'), 0)::bigint
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

-- Revoked from PUBLIC before granting, the convention 20261005000400 set after
-- PostgreSQL's default grant to PUBLIC turned out to be why `anon` could reach
-- post_journal_entry. This is security definer and reads balances.
revoke execute on function public.list_transfer_accounts(uuid) from public;
grant execute on function public.list_transfer_accounts(uuid) to authenticated;
grant execute on function public.list_transfer_accounts(uuid) to service_role;

comment on function public.list_transfer_accounts(uuid) is
  'The four cash accounts transfer_funds moves money between -- 1000, 1010, 1020 and 1021 -- by the SHOP''S OWN names for them, with each one''s ledger balance. Gated on budgets.manage, the same permission transfer_funds itself takes and NOT ledger.view: `accounts` is readable only on ledger.view, which the default Manager who banks the float does not hold, so without this function the person the transfer gate was chosen for could call the write and could not read the list to call it with. Returns exactly those four codes and nothing else about the chart, which is why widening the RLS policy on `accounts` was the wrong fix. Balances are read exactly as cash_flow()''s proof row reads them -- posted and reversed entries, excluding closes, with no lower bound -- so the two cannot say different things about the same till. Archived accounts are excluded, because transfer_funds refuses them.';
