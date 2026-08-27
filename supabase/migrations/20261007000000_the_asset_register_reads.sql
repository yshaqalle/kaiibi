-- What the register is worth, answered once, in the database.
--
-- 20261006000100 shipped `fixed_assets` and `depreciation_charges` readable
-- under RLS on ledger.view, and nothing that reads them. The screen the design
-- asks for (docs/design/accounting-standards-mockup.html, "Fixed Asset List")
-- shows three figures per row -- cost, depreciated so far, book value -- and
-- four across the top, and exactly one of those is a column: the cost. Every
-- other one is a sum.
--
-- ## WHY THIS IS A FUNCTION AND NOT A SCREEN SUMMING ITS OWN ROWS
--
-- Net book value is cost less accumulated depreciation, and accumulated
-- depreciation is the sum of an asset's charge rows. A screen that selects both
-- tables and subtracts is a SECOND IMPLEMENTATION of the number 1500 and 1590
-- already hold between them -- and this project has paid for that shape before
-- (20261006000100's header rejects an `accumulated_cents` column for the same
-- reason: two places holding one number, no cheap way to notice when they stop
-- agreeing).
--
-- The check that makes it worth stating: the total net book value returned here
-- must equal balance_sheet()'s fixed-asset section, because both are
-- 1500-1599 less 1590 by different routes -- this one over the register, that
-- one over the ledger. verify-asset-register-reads.sql asserts exactly that,
-- and it is the assertion that would catch a screen (or this function) drifting
-- from the books.
--
-- ## A DISPOSED ASSET HAS NO BOOK VALUE, AND SAYS SO IN NULL
--
-- Cost and accumulated depreciation are FACTS about a disposed asset and are
-- still returned: the shop did pay 5400 for the freezer and did write 1102 of
-- it off. Its book value is not a small number, it is NOT A NUMBER -- the asset
-- is off the balance sheet entirely, its cost credited out of 1500 at full cost
-- and its depreciation debited out of 1590 (dispose_fixed_asset). Returning
-- `cost - accumulated` for it would put a confident figure on a row describing
-- something the shop does not own, and every total that included it would stop
-- tying to the balance sheet.
--
-- So net_book_cents is NULL for a disposed asset and the totals below cover
-- live assets only. Null is the honest answer and it renders as an em dash,
-- which is what the design draws.
--
-- ## THE ONE THING THIS FUNCTION IS HERE TO STOP THE SCREEN LYING ABOUT
--
-- `reverse_journal_entry` (20260904000300) is a GENERIC door: it takes any
-- entry id, including an asset's acquisition entry, and voids it. It does not
-- know about `fixed_assets` and does not touch the register, so a shop can void
-- the purchase of the fridge and the fridge stays in the register. Measured, on
-- the live stack, against tasks 2-3; fixing it needs a change to a shipped
-- generic RPC and is out of this task's scope.
--
-- What is IN scope is not hiding it. `acquisition_status` is the status of the
-- entry that put the asset on the balance sheet:
--
--   'posted'    the ordinary case. The asset is in the register AND in 1500.
--   'reversed'  the purchase was voided. The asset is in the register and NOT
--               in 1500 -- so this row's cost is in no account, its book value
--               is in no statement, and the register total no longer equals the
--               balance sheet.
--   'draft'     unreachable today (post_journal_entry posts) and carried
--               rather than folded into 'posted', because folding it would make
--               a future draft path silently look correct.
--   'none'      the register row links no entry at all.
--
-- The screen gates a `wrong` caveat on the summary's `voided_count` and offers
-- the fix that exists -- delete_fixed_asset, which removes the row and no-ops
-- on the already-reversed entry. A number nobody can explain is worse than a
-- number with a warning attached to it.
--
-- ## THE GATE: ledger.view, RAISED
--
-- The same gate the three statements take, and raised rather than returning
-- nothing for the same reason they raise: a zero is a claim. Both functions are
-- security definer, so RLS on the two tables is not what protects them -- this
-- check is, and the shop filter inside it is.

create or replace function public.list_fixed_assets(p_shop_id uuid)
returns table (
  id uuid,
  name text,
  account_code text,
  account_name text,
  acquired_on date,
  life_months integer,
  cost_cents bigint,
  accumulated_cents bigint,
  -- NULL once the asset has gone. See the header: a disposed asset is off the
  -- balance sheet, so it has no book value rather than a book value of nothing.
  net_book_cents bigint,
  months_charged integer,
  disposed_on date,
  disposal_proceeds_cents bigint,
  acquisition_status text
)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.has_shop_permission(p_shop_id, 'ledger.view') then
    raise exception 'You do not have permission to see the books.' using errcode = 'P0001';
  end if;

  return query
  select fa.id,
         fa.name,
         fa.account_code,
         -- The shop's OWN chart. security definer bypasses RLS on accounts, so
         -- without the shop filter this join collects every shop's row at that
         -- code and names the asset account in someone else's words.
         a.name,
         fa.acquired_on,
         fa.life_months,
         fa.cost_cents::bigint,
         coalesce(dc.charged_cents, 0)::bigint,
         case when fa.disposed_on is null
              then (fa.cost_cents - coalesce(dc.charged_cents, 0))::bigint
         end,
         coalesce(dc.charge_count, 0)::integer,
         fa.disposed_on,
         fa.disposal_proceeds_cents::bigint,
         -- 'none' covers both "the row links no entry" and "the entry it links
         -- is gone". Neither is 'posted', which is all the screen branches on.
         coalesce(e.status, 'none')
    from public.fixed_assets fa
    left join lateral (
      select sum(c.amount_cents) as charged_cents, count(*)::integer as charge_count
        from public.depreciation_charges c
       where c.asset_id = fa.id
    ) dc on true
    left join public.accounts a
      on a.shop_id = fa.shop_id and a.code = fa.account_code
    left join public.journal_entries e on e.id = fa.journal_entry_id
   where fa.shop_id = p_shop_id
   -- Live assets first, newest purchase first inside each half. A shop's
   -- disposed assets accumulate forever and are history; what it owns today is
   -- what it opened the screen for.
   order by (fa.disposed_on is not null), fa.acquired_on desc, fa.name;
end;
$$;

-- The four figures across the top of the screen, and the two the screen needs
-- to know whether to warn.
--
-- DERIVED FROM list_fixed_assets(), CALLED -- never from the tables again. Two
-- readings of one register agree until they don't, and then the total at the top
-- of the screen and the rows underneath it disagree with nobody able to say
-- which is right. Same argument balance_sheet() makes for calling
-- statement_lines() rather than re-deriving net profit.
--
-- LIVE ASSETS ONLY for cost, depreciation and book value, so the three tie to
-- the balance sheet: a disposal credits the full cost out of 1500 and debits
-- the whole of that asset's depreciation out of 1590, so neither is in the
-- ledger any more either.
--
-- `last_charge_month` / `last_charge_cents` are the most recent depreciation
-- actually POSTED, over every asset including disposed ones -- a charge that
-- was posted was posted. The design's fourth tile is "this month's charge",
-- which would mean re-deriving run_depreciation()'s straight-line rule out here
-- to predict a charge nobody has posted yet; that is a second implementation of
-- the one thing in this feature that has already been got wrong twice
-- (20261006000200's zero-charge and disposed-asset defects). What HAS happened
-- is a fact; what would happen if you pressed the button is the button's job to
-- say, and run_depreciation returns how many entries it wrote.
create or replace function public.fixed_asset_summary(p_shop_id uuid)
returns table (
  live_count integer,
  disposed_count integer,
  cost_cents bigint,
  accumulated_cents bigint,
  net_book_cents bigint,
  voided_count integer,
  voided_cost_cents bigint,
  last_charge_month date,
  last_charge_cents bigint
)
language plpgsql stable security definer set search_path = public as $$
begin
  -- list_fixed_assets gates too, and this is not redundant with it: this
  -- function is security definer in its own right and its `select` below would
  -- otherwise be reached before that check is, on a path a future edit could
  -- change. Both raise the same sentence.
  if not public.has_shop_permission(p_shop_id, 'ledger.view') then
    raise exception 'You do not have permission to see the books.' using errcode = 'P0001';
  end if;

  return query
  with register as (
    select * from public.list_fixed_assets(p_shop_id)
  ),
  charges as (
    select c.charge_month, sum(c.amount_cents)::bigint as amount_cents
      from public.depreciation_charges c
     where c.shop_id = p_shop_id
     group by c.charge_month
     order by c.charge_month desc
     limit 1
  )
  select count(*) filter (where r.disposed_on is null)::integer,
         count(*) filter (where r.disposed_on is not null)::integer,
         coalesce(sum(r.cost_cents) filter (where r.disposed_on is null), 0)::bigint,
         coalesce(sum(r.accumulated_cents) filter (where r.disposed_on is null), 0)::bigint,
         coalesce(sum(r.net_book_cents), 0)::bigint,
         -- Live assets whose purchase entry is no longer standing. A disposed
         -- asset's acquisition entry being reversed is a different and older
         -- mess that no total here claims to cover.
         count(*) filter (where r.disposed_on is null and r.acquisition_status <> 'posted')::integer,
         coalesce(sum(r.cost_cents) filter (
           where r.disposed_on is null and r.acquisition_status <> 'posted'), 0)::bigint,
         (select c.charge_month from charges c),
         (select c.amount_cents from charges c)
    from register r;
end;
$$;

-- Revoked from PUBLIC before granting, the convention 20261005000400 set after
-- PostgreSQL's default grant to PUBLIC turned out to be why `anon` could reach
-- post_journal_entry. Both are security definer.
revoke execute on function public.list_fixed_assets(uuid) from public;
grant execute on function public.list_fixed_assets(uuid) to authenticated;
grant execute on function public.list_fixed_assets(uuid) to service_role;

revoke execute on function public.fixed_asset_summary(uuid) from public;
grant execute on function public.fixed_asset_summary(uuid) to authenticated;
grant execute on function public.fixed_asset_summary(uuid) to service_role;

comment on function public.list_fixed_assets(uuid) is
  'The fixed-asset register with the two figures that are not columns: accumulated depreciation, summed from THIS asset''s depreciation_charges rows, and net book value. net_book_cents is NULL for a disposed asset -- it is off the balance sheet entirely, so it has no book value rather than a book value of nothing -- while its cost and accumulated depreciation are still reported as the facts they are. acquisition_status carries the status of the entry that bought the asset: reverse_journal_entry is a generic door that can void it while the register row survives, and a row reading ''reversed'' is in the register and NOT in 1500. Gated on ledger.view and RAISES without it, as the three statements do.';

comment on function public.fixed_asset_summary(uuid) is
  'The register''s totals, derived by calling list_fixed_assets() rather than by reading the tables a second time. Cost, accumulated depreciation and net book value cover LIVE assets only, so all three tie to balance_sheet()''s fixed-asset section. voided_count and voided_cost_cents are the live assets whose acquisition entry has been reversed, which is the one way this register and the ledger can legitimately disagree. last_charge_month and last_charge_cents are the most recent depreciation POSTED, not a prediction of the next one -- predicting it would mean re-deriving run_depreciation()''s straight-line rule in a second place. Gated on ledger.view and RAISES without it.';
