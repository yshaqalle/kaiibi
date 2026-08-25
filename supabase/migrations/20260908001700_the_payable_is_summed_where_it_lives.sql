-- The Bills screen stops downloading the ledger to add it up.
--
-- 20260908001300's sibling change gave the Bills tab a `wrong`-toned caveat for
-- an Accounts Payable that has gone into DEBIT -- a liability claiming suppliers
-- owe the shop money. The number behind it was computed the only way the client
-- could compute anything at the time: `listPostedLines(shop, today)`, which
-- selects EVERY journal_lines row the shop has ever posted and nets them in
-- JavaScript. Two things are wrong with that, and the second is not a
-- performance complaint.
--
-- 1. IT IS THE WHOLE JOURNAL, ON EVERY LOAD. No limit, no aggregate, no
--    server-side sum -- and re-fetched whenever the date range moves, even
--    though the figure is deliberately range-independent (a liability that has
--    gone negative is a fact about the books as they stand, and slicing it by
--    window would let the reader make it disappear with a picker). A shop
--    trading for two years has hundreds of thousands of lines and the Bills
--    screen is a daily door.
--
-- 2. POSTGREST TRUNCATES SILENTLY AT `max-rows`. The Supabase default is 1000.
--    Past that the client is handed a PREFIX of the journal with no error and no
--    marker, nets the prefix, and reports the answer with total confidence. The
--    prefix is not a sample of the whole -- there is no ordering guarantee, and
--    the 2000 lines that landed early are the deliveries that CREDIT the account
--    -- so an ordinary shop whose payable is properly in credit can be shown a
--    `wrong` accusation with a destructive action attached to it. A wrong number
--    dressed as a certainty, on the screen whose entire job is to say when a
--    number is wrong.
--
-- So the sum happens where the rows are. One row out, two columns, no lines on
-- the wire.
--
-- ---------------------------------------------------------------------------
-- WHY THE SECOND COLUMN
-- ---------------------------------------------------------------------------
--
-- The caveat's copy names ONE cause -- a bill for goods paid without the
-- delivery ever being entered, so `record_invoice_payment` debits 2000 with
-- nothing having credited it -- and its action is "Record the delivery in
-- Inventory". That diagnosis is not exclusive, and the other cause makes the
-- action DESTRUCTIVE.
--
-- A bill of ANY category entered before auto-posting shipped posted no Cr 2000
-- at all; it reaches the ledger only when someone presses Post History. Paying
-- one of those TODAY posts a live Dr 2000. So a shop that has not yet replayed
-- its history can drive 2000 into debit by paying an old RENT bill -- and the
-- caveat would tell it to go and record a delivery, which for a rent bill means
-- inventing goods that never arrived: stock inflated, 1200 inflated, and 2000
-- credited for a delivery that does not exist. Data corruption offered as a
-- remedy, on a daily door.
--
-- The balance alone cannot tell the two apart -- both are a positive net on 2000
-- and the arithmetic is identical. What separates them is whether the shop has
-- history waiting, which is exactly what `unposted_ledger_source_rows` knows. So
-- it comes back beside the figure, and the screen chooses its sentence and its
-- action from the pair rather than from the amount alone.
--
-- EXISTS, not a count. The screen asks a yes/no question, and `exists` stops at
-- the first row of an eight-arm union rather than evaluating every arm to the
-- end. The `opening` arm of `unposted_ledger_sources` is deliberately NOT
-- included: it is an arithmetic question about stock (20260908001300) that
-- touches 1200 and 3000 and can never move 2000, and answering it means valuing
-- the whole product table on a screen that is asking about bills.
--
-- ---------------------------------------------------------------------------
-- PERMISSION, AND FAILING CLOSED
-- ---------------------------------------------------------------------------
--
-- `ledger.view`, which is exactly what RLS on journal_entries and journal_lines
-- enforced before -- so nobody gains or loses sight of this caveat. It has to be
-- checked explicitly here because SECURITY DEFINER is what makes the aggregate
-- possible at all, and a definer function with no gate would hand a shop's
-- payable balance to anyone who could name the shop.
--
-- A reader without it gets NO ROWS rather than an error or a zero. The client
-- treats no rows as "say nothing", which is the same degradation the old code
-- had by accident (RLS returned an empty set, which netted to zero, which showed
-- no caveat) and now has on purpose. Returning 0 would be worse than silence:
-- zero is a real answer here and it means "your payable is fine".
--
-- SECURITY DEFINER also puts the two reads on the same footing. The 2000 sum
-- would otherwise be visible to a reader with `ledger.view` while
-- `unposted_ledger_source_rows` -- security_invoker, and revoked from
-- `authenticated` -- returned nothing to them, so the screen would see "in
-- debit, nothing unposted" for a shop with a year of unposted history and offer
-- the destructive action. The gate and the two reads have to agree, and the only
-- way they do is if one function owns all three.

create or replace function public.accounts_payable_debit(p_shop_id uuid)
returns table (debit_cents bigint, has_unposted boolean)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.has_shop_permission(p_shop_id, 'ledger.view') then
    -- No rows. See the header: silence, not zero.
    return;
  end if;

  return query
  select
    -- HOW FAR 2000 HAS GONE THE WRONG WAY, in cents, or 0 when it sits where a
    -- liability belongs. Debit positive, matching the sign every journal line is
    -- stored in -- so a POSITIVE net on a liability is the defect.
    --
    -- Netted across every line first. Summing debits alone would report an
    -- ordinary shop -- which debits 2000 on every supplier payment it has ever
    -- made -- as permanently broken.
    --
    -- archived_at is deliberately NOT filtered on `accounts`: a line posted to
    -- 2000 moved the payable whether or not somebody archived the account
    -- afterwards, and excluding it would make this figure jump by the whole of
    -- that account's history the moment it was archived. Same reasoning as
    -- opening_inventory_gap's ledger term (20260908001300).
    greatest(coalesce((
      select sum(l.amount_cents)
        from public.journal_lines l
        join public.journal_entries e on e.id = l.entry_id
        join public.accounts a on a.id = l.account_id
       where e.shop_id = p_shop_id
         and a.code = '2000'
         -- Posted and reversed, matching the trial balance (listPostedLines in
         -- src/lib/ledger.ts). A draft has not reached the books, and a reversal
         -- and its mirror are both kept because they net to nothing.
         and e.status in ('posted', 'reversed')
         -- As of today, in the SHOP's calendar. Not the date range: this figure
         -- is a fact about the books as they stand, and a window would let the
         -- reader make a wrong number disappear by moving a picker.
         and e.entry_date <= public.shop_local_date()
    ), 0), 0)::bigint,
    exists (
      select 1 from public.unposted_ledger_source_rows u
       where u.shop_id = p_shop_id
    );
end;
$$;

comment on function public.accounts_payable_debit(uuid) is
  'How far 2000 Accounts Payable has gone into DEBIT for a shop, in cents, as of the shop''s today -- zero whenever it sits where a liability belongs -- together with whether the shop still has history waiting to be posted. One row, summed in the database: the Bills screen used to fetch every journal line and net them in the client, which PostgREST''s max-rows truncates silently past 1000. The second column exists because a positive figure has two causes and only one of them is fixed by recording a delivery; see the migration header. Gates on ledger.view and returns NO ROWS without it, so the caller says nothing rather than reporting zero.';

revoke all on function public.accounts_payable_debit(uuid) from anon;
grant execute on function public.accounts_payable_debit(uuid) to authenticated;
