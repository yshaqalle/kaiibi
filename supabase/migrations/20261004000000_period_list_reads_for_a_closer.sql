-- The period list answers somebody who may close but may not view.
--
-- ## The gap, exactly
--
-- 20261003000100 gates `list_accounting_periods()` on `ledger.view` ALONE. The
-- Close a Period screen (Task 5) gates its card and its view on `ledger.close`,
-- which is right -- the seeded Manager holds `ledger.view` and NOT
-- `ledger.close` (20260904000000), and a Manager who reached a close screen
-- would only ever be refused by the RPC.
--
-- Those two gates do not overlap. `ledger.view` and `ledger.close` are separate
-- permissions and nothing anywhere makes one imply the other: shop_roles carries
-- whatever array a shop typed into it, and a role holding `ledger.close` alone
-- is one insert away. That role reaches the screen -- the card is gated on
-- exactly the permission it holds -- and then the first thing the screen does is
-- call `list_accounting_periods()`, which refuses it. The screen renders its
-- refusal state to a reader who holds the permission the screen exists for.
--
-- `period_exceptions()` (20261003000000) already got this right, and its header
-- says why in the words this migration is only repeating: "a role may be given
-- ledger.close alone, and a close that then failed on a read gate would be a
-- very confusing bug to find". So the predicate here is COPIED FROM IT rather
-- than written again -- one rule, in one form, in both places. A second
-- hand-written spelling of the same rule is how two doors start disagreeing.
--
-- ## What this does NOT widen
--
-- `close_due_periods()` keeps its own `ledger.close` check and keeps RETURNING
-- ZERO rather than raising, so a `ledger.view`-only Manager still gets the list
-- and still closes nothing. Widening the read gate changes who may READ; it
-- changes nobody's ability to write. The two gates are deliberately different
-- shapes -- the reader raises, the closer returns 0 -- and this touches only the
-- first.
--
-- Nothing else in the function moves: the lazy close, the grace column, the
-- standing-entry join, the shop_id filter, the ordering, the grant. Reproduced
-- in full per this repo's convention that the newest definition of a function is
-- the whole of it, and `accumulated-rpc-edits.test.ts` now pins this function's
-- edits so the next copy-forward cannot lose them.

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
  -- ledger.view OR ledger.close, the same predicate period_exceptions() uses
  -- and for the same reason: a role may hold ledger.close alone, and this is the
  -- first call the Close a Period screen makes.
  if not public.has_any_shop_permission(p_shop_id, array['ledger.view', 'ledger.close']) then
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
  'Every accounting period of a shop, newest first, with what it rolled into retained earnings, what was outstanding when it closed, what is outstanding now if it is still open, and the date it closes by itself. CLOSES ANY PERIOD PAST ITS GRACE BEFORE ANSWERING -- this is the whole of auto-close, there being no scheduler; a shop nobody opens never closes. Gated on ledger.view OR ledger.close, the same predicate period_exceptions() uses: the Close a Period screen is gated on ledger.close, so a role holding only that must be able to read the list it is about to close from. A caller without ledger.close gets the list and closes nothing.';
