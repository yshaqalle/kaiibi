-- What the backfill would replay, without replaying it.
--
-- backfill_shop_ledger has been dormant since 20260908000700: it exists, it
-- ties to the cent, it is idempotent, and NOTHING CALLS IT. Giving it a door
-- means a screen that can say, before anyone presses anything, how many rows
-- are unposted and of what kind. That question has to be answered by the
-- database, and it has to be answered by THE SAME PREDICATES the backfill uses.
--
-- WHY THIS IS NOT EIGHT COUNTS IN TYPESCRIPT. "Unposted" is not
-- `journal_entry_id is null`. It is that AND eight per-kind money predicates,
-- and every one of them is a trap:
--
--   * A sale_payments row that is NOT a settlement keeps journal_entry_id null
--     for ever -- complete_sale folds a sale's own tenders into the sale's
--     entry. Counting off the column alone over-reports by every till payment
--     the shop has ever taken.
--   * A zero-valued sale (free samples left on account) is DELIBERATELY never
--     posted, and "carries money" is a six-term disjunction over sale_items and
--     sale_payments, not `total_cents <> 0`.
--   * refunds and invoice_payments have no shop_id; tenancy comes through
--     sales and invoices.
--   * A payroll-derived or count-derived expense row, and the
--     inventory_purchase half of a bill, stay unposted PERMANENTLY by design.
--   * A pay run must be `status = 'posted'`; unpost_payroll_run clears the
--     pointer on purpose and a replay must not undo that.
--
-- A second copy of that in the client would give a door and an RPC that
-- disagree about the one word the whole screen is built on -- a number that is
-- plausible and wrong, which is the failure this phase has spent nine tasks
-- avoiding. So the predicates live once, here, and verify-backfill.sql pins the
-- view against the function in both directions: before a replay the view's row
-- count equals what backfill_shop_ledger returns, and after it the view is
-- empty.
--
-- Read-only. This view and the function over it write nothing and take no lock.

-- One row per source row the backfill would replay. The columns are the ones a
-- door needs and no more: what kind of thing it is, which row, and the date the
-- entry would carry -- so the screen can say how far back the history reaches
-- using the SAME date expression the replay uses, rather than an approximation
-- of it.
--
-- security_invoker, so a caller who somehow reaches the view directly sees only
-- what RLS on the eight base tables lets them see. Belt and braces: select is
-- revoked below, and the only intended reader is the SECURITY DEFINER function
-- underneath, which does its own has_shop_permission check.
create or replace view public.unposted_ledger_sources
with (security_invoker = true) as

  -- Sales. The money predicate is the exact disjunction of the six line groups
  -- backfill_shop_ledger builds, copied from it -- a false negative here would
  -- under-report a sale that really does carry money, and a false positive
  -- would promise an entry the replay will not write.
  select s.shop_id,
         'sale'::text as source_kind,
         s.id         as source_id,
         public.shop_local_date(s.created_at) as on_date
    from public.sales s
   where s.journal_entry_id is null
     and (coalesce(s.tax_cents, 0) <> 0
          or coalesce(s.discount_cents, 0) <> 0
          or coalesce(s.points_redeemed_cents, 0) <> 0
          or s.total_cents <> coalesce((select sum(sp.amount_cents)
                                          from public.sale_payments sp
                                         where sp.sale_id = s.id and not sp.is_settlement), 0)
          or exists (select 1 from public.sale_payments sp
                      where sp.sale_id = s.id and not sp.is_settlement and sp.amount_cents <> 0)
          or coalesce((select sum(si.unit_price_cents::bigint * si.quantity)
                         from public.sale_items si where si.sale_id = s.id), 0) <> 0
          or coalesce((select sum(si.discount_cents)
                         from public.sale_items si where si.sale_id = s.id), 0) <> 0
          or coalesce((select sum(si.unit_cost_cents::bigint * si.quantity)
                         from public.sale_items si
                        where si.sale_id = s.id and si.unit_cost_cents is not null), 0) <> 0)

  union all

  -- Refunds. No shop_id of their own -- tenancy comes through the sale.
  select s.shop_id, 'refund'::text, r.id, public.shop_local_date(r.created_at)
    from public.refunds r
    join public.sales s on s.id = r.sale_id
   where r.journal_entry_id is null
     and (r.goods_cents <> 0 or r.total_cents <> 0
          or exists (select 1 from public.refund_items ri
                       join public.sale_items si on si.id = ri.sale_item_id
                      where ri.refund_id = r.id and si.unit_cost_cents is not null))

  union all

  -- Settlements. is_settlement IS THE FILTER. A sale's own tenders are folded
  -- into the sale's entry and keep a null pointer for ever.
  select s.shop_id, 'settlement'::text, sp.id, public.shop_local_date(sp.created_at)
    from public.sale_payments sp
    join public.sales s on s.id = sp.sale_id
   where sp.is_settlement
     and sp.journal_entry_id is null
     and sp.amount_cents <> 0

  union all

  -- Stock receipts, at the delivery's costed value. An uncosted line is
  -- excluded rather than zeroed.
  select r.shop_id, 'receipt'::text, r.id, public.shop_local_date(r.created_at)
    from public.stock_receipts r
   where r.journal_entry_id is null
     and coalesce((select sum(ri.unit_cost_cents::bigint * ri.quantity)
                     from public.stock_receipt_items ri
                    where ri.receipt_id = r.id and ri.unit_cost_cents is not null), 0) <> 0

  union all

  -- Stock counts, at the net variance. A count that found what it expected is
  -- not an accounting event.
  select c.shop_id, 'count'::text, c.id, public.shop_local_date(c.created_at)
    from public.stock_counts c
   where c.journal_entry_id is null
     and coalesce((select sum(ci.unit_cost_cents::bigint * (ci.counted_quantity - ci.previous_quantity))
                     from public.stock_count_items ci
                    where ci.count_id = c.id and ci.unit_cost_cents is not null), 0) <> 0

  union all

  -- Supplier payments. No shop_id -- tenancy comes through the invoice. Dated
  -- paid_on, which is already a date.
  select i.shop_id, 'invoice_payment'::text, ip.id, ip.paid_on
    from public.invoice_payments ip
    join public.invoices i on i.id = ip.invoice_id
   where ip.journal_entry_id is null and ip.amount_cents <> 0

  union all

  -- Pay runs. Posted only: a draft has paid nobody, and a run returned to draft
  -- had its pointer cleared on purpose.
  select r.shop_id, 'payroll'::text, r.id,
         public.shop_local_date(coalesce(r.posted_at, r.period_end::timestamptz))
    from public.payroll_runs r
   where r.journal_entry_id is null
     and r.status = 'posted' and r.total_cents > 0

  union all

  -- Expenses, with the four exclusions the replay carries. Two of them --
  -- count-derived rows, and the inventory_purchase half of a bill -- leave a
  -- row unposted for ever by design, and verify-backfill.sql check 5 exempts
  -- both for that reason. They must be excluded HERE too or the door promises
  -- entries the replay will never write.
  select e.shop_id, 'expense'::text, e.id, e.occurred_on
    from public.expenses e
   where e.journal_entry_id is null
     and e.payroll_run_id is null
     and e.stock_count_id is null
     and not (e.invoice_id is not null and e.category = 'inventory_purchase')
     and e.amount_cents <> 0;

comment on view public.unposted_ledger_sources is
  'One row per source row backfill_shop_ledger would replay, carrying the same eight per-kind predicates and the same date expressions. Read-only, and the single definition of "unposted" that the Post History door and the replay share. verify-backfill.sql pins the two together: before a replay this view''s row count equals what backfill_shop_ledger returns, and after it the view is empty.';

-- Not readable directly. The door goes through the function below, which gates
-- on the same permission the RPC does.
revoke all on public.unposted_ledger_sources from anon, authenticated;

-- What the screen calls. Returns ALL EIGHT KINDS ALWAYS, zeroes included:
-- "nothing to do" is the state this door is in for ever after its first run,
-- and eight named rows each reading 0 is a positive statement -- it looked in
-- eight places and all eight are clear -- where a list that drops its empty
-- rows is indistinguishable from one that failed to look.
--
-- ledger.close, not ledger.post, matching backfill_shop_ledger exactly. Two
-- doors onto the same act must not disagree about who may open them, and a
-- counts function that answered freely would let a role see a number it can
-- never act on.
create or replace function public.unposted_ledger_counts(p_shop_id uuid)
returns table (kind text, rows_unposted bigint, oldest_on date)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.has_shop_permission(p_shop_id, 'ledger.close') then
    raise exception 'Seeing what is waiting to be posted needs ledger.close.' using errcode = 'P0001';
  end if;

  -- The CTE is inlined (not MATERIALIZED), so `shop_id = p_shop_id` pushes down
  -- into each arm of the union rather than the whole view being built for every
  -- shop and filtered afterwards.
  return query
  with mine as (
    select s.source_kind, s.source_id, s.on_date
      from public.unposted_ledger_sources s
     where s.shop_id = p_shop_id
  )
  select k.k, count(m.source_id)::bigint, min(m.on_date)
    from (values ('sale', 1), ('refund', 2), ('settlement', 3), ('receipt', 4),
                 ('count', 5), ('invoice_payment', 6), ('payroll', 7), ('expense', 8)) as k(k, ord)
    left join mine m on m.source_kind = k.k
   group by k.k, k.ord
   order by k.ord;
end;
$$;

comment on function public.unposted_ledger_counts(uuid) is
  'How many rows of each kind backfill_shop_ledger would replay, and how far back the oldest reaches. Read-only; writes nothing and takes no lock. Always returns all eight kinds, zeroes included. Gates on ledger.close, the same permission the replay itself requires.';

grant execute on function public.unposted_ledger_counts(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- WHICH SHUT MONTHS THE REPLAY WOULD WRITE INTO
-- ---------------------------------------------------------------------------
--
-- backfill_shop_ledger creates every period it needs UP FRONT and left open
-- (20260908000700, step 2), and that insert is `on conflict (shop_id, starts_on)
-- do nothing`. So a month that does not exist yet is created open -- fine -- and
-- a month that ALREADY EXISTS keeps whatever status it has and receives the
-- entries anyway. The replay never consults open_period_for, which is the whole
-- reason a closed month cannot abort it half-way, and that decision is not being
-- revisited here: a per-row gate would leave a shop with half a ledger.
--
-- But `locked` is documented (20260904000200) as "nothing posts, ever. Manual,
-- deliberate, final", and this walks straight through it -- no re-open, no
-- closed_at change, no audit row. An owner who deliberately locked last March is
-- entitled to know that before they press, not to find out afterwards, and the
-- screen was until now telling them the opposite ("a month you have already
-- closed is re-opened to receive it" -- false in both directions).
--
-- So the exposure is COUNTED HERE, beside the counts, off the same view. Not in
-- TypeScript, for the same reason the counts are not: "which month does this
-- entry land in" is a containment test against accounting_periods, and the
-- second copy would be the one that is wrong.
--
-- CONTAINMENT, not date_trunc. A period is stored as a range precisely so a
-- future non-calendar period needs no migration, and journal_entries.period_id
-- is resolved by `on_date between starts_on and ends_on`. Bucketing by month
-- start instead would miss a half-month period and report an exposure of zero
-- for a month that really does receive entries.
--
-- A source row whose date falls in NO existing period contributes nothing, and
-- that is right: the replay will create that period, open.
--
-- BOTH STATUSES ALWAYS, zeroes included, for the same reason the counts return
-- all eight kinds -- "we looked and there are none" and "we did not look" must
-- not render the same.
create or replace function public.unposted_ledger_period_exposure(p_shop_id uuid)
returns table (status text, months bigint, entries bigint)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.has_shop_permission(p_shop_id, 'ledger.close') then
    raise exception 'Seeing what is waiting to be posted needs ledger.close.' using errcode = 'P0001';
  end if;

  return query
  with landing as (
    select s.source_id, ap.id as period_id, ap.status as period_status
      from public.unposted_ledger_sources s
      join public.accounting_periods ap
        on ap.shop_id = p_shop_id
       and s.on_date between ap.starts_on and ap.ends_on
     where s.shop_id = p_shop_id
  )
  select k.k,
         count(distinct l.period_id)::bigint,
         count(l.source_id)::bigint
    from (values ('closed', 1), ('locked', 2)) as k(k, ord)
    left join landing l on l.period_status = k.k
   group by k.k, k.ord
   order by k.ord;
end;
$$;

comment on function public.unposted_ledger_period_exposure(uuid) is
  'How many already-closed and already-locked months backfill_shop_ledger would write entries into, and how many entries each would receive. The replay does not re-open them, does not re-close them and writes no audit row -- it posts through, by design, so that one shut month cannot abort a whole history. This is the door''s only way to say so before the button is pressed. Read-only, gated on ledger.close like the replay itself. Always returns both statuses, zeroes included.';

grant execute on function public.unposted_ledger_period_exposure(uuid) to authenticated;
