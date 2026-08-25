-- What a customer owes is net of the cash the shop handed back.
--
-- 20260831000200 split one column into two: refunds.goods_cents is the VALUE of
-- what came back, refunds.total_cents is the CASH actually paid out, capped at
-- `least(goods, collected - already refunded in cash)`. It then moved
-- customer_balances and settle_sale_balance onto goods_cents, and stopped there.
--
-- Subtracting goods_cents is right. Not adding total_cents back is not: the cash
-- leaving the drawer is a payment RUNNING BACKWARDS. The customer's net position
-- is what they paid MINUS what they were handed, and the view counted only the
-- first half.
--
--   owed = total - goods_returned - paid            <- what shipped
--   owed = total - goods_returned - paid + cash_refunded
--
-- The two agree exactly when cash_refunded is zero -- an unpaid sale returned --
-- or when the sale is fully returned, where both fall to or below zero and the
-- view's own `owed > 0` filter hides the difference. A FULL return is what every
-- existing check exercised, which is why this never went red.
--
-- Worked example, confirmed against the shipped view:
--
--   Sale 6300. Customer pays 2000. One unit comes back, worth 3150; the cap
--   hands them their 2000 back.
--     the view said        6300 - 3150 - 2000            = 1150
--     the customer owes    6300 - 3150 - 2000 + 2000     = 3150
--     ledger 1100 reads    (6300-2000) - (3150-2000)     = 3150
--
--   settle_sale_balance computed v_owed the same wrong way, so it REFUSED more
--   than 1150 and then stamped settled_at -- stranding 2000 in Accounts
--   Receivable that no screen in the app could ever collect.
--
-- The ledger has been right the whole time. 20260908000200 debits 1100 with
-- (total - paid) when the sale is rung up and 20260908000360 credits it with
-- (goods - cash) on a refund, which is this migration's formula rearranged.
-- verify-backfill.sql check 3d says so in its own comment, and ties the ledger
-- out against the money rather than against the view for exactly this reason.
--
-- THE VIEW AND THE RPC MUST NOT DIVERGE. That they have always agreed is the
-- only reason this bug was consistent rather than random -- a cashier reading
-- one figure and a server enforcing another is worse than both being wrong. So
-- both move here, in one migration, and verify-balances check 33 asserts them
-- against each other rather than each against a constant.

-- ── customer_balances ─────────────────────────────────────────────────────
-- Reproduced from 20260831000200 with the cash term added in the two places it
-- has to appear -- the select list and the `owed > 0` filter -- and nothing
-- else. The refunds lateral now returns both halves in ONE subquery rather than
-- gaining a second join: two children joined directly multiply, which is the
-- regression verify-balances check 4 exists to catch.
--
-- No new column. The only reader is src/lib/balances.ts, which selects '*' and
-- maps four columns by name; paid_cents and refunded_cents keep meaning exactly
-- what they meant, so owed_cents is deliberately no longer their arithmetic
-- difference. It is what the customer owes.
create or replace view public.customer_balances
with (security_invoker = on) as
select
  s.shop_id,
  s.customer_id,
  coalesce(
    nullif(btrim(c.first_name || ' ' || coalesce(c.last_name, '')), ''),
    s.customer_name
  ) as customer_name,
  s.id as sale_id,
  s.created_at as sale_created_at,
  s.total_cents,
  coalesce(paid.total, 0)::integer as paid_cents,
  coalesce(returned.goods, 0)::integer as refunded_cents,
  (s.total_cents - coalesce(returned.goods, 0) - coalesce(paid.total, 0)
     + coalesce(returned.cash, 0))::integer as owed_cents
from public.sales s
left join public.customers c on c.id = s.customer_id
left join lateral (
  select sum(p.amount_cents) as total from public.sale_payments p where p.sale_id = s.id
) paid on true
left join lateral (
  select sum(r.goods_cents) as goods, sum(r.total_cents) as cash
    from public.refunds r where r.sale_id = s.id
) returned on true
where s.settled_at is null
  and s.customer_id is not null
  -- The same expression, and it has to be. Without the cash term here a sale
  -- half-paid and half-returned -- 6300 rung up, 3150 paid, 3150 of goods back
  -- and 3150 handed over -- computes to exactly 0 and DISAPPEARS from the
  -- receivables list entirely, owing 3150.
  and (s.total_cents - coalesce(returned.goods, 0) - coalesce(paid.total, 0)
         + coalesce(returned.cash, 0)) > 0;

grant select on public.customer_balances to authenticated;

-- ── settle_sale_balance ───────────────────────────────────────────────────
-- Reproduced IN FULL from 20260908000360_settle_at_its_till_and_split_a_refund.sql
-- -- the newest definition, NOT 20260831000200 -- with one change: v_owed gains
-- the cash term, from a new v_cash_refunded read in the same statement as
-- v_refunded. The posting block and `coalesce(v_session.location_id,
-- v_sale.location_id)` are carried over untouched; the latter closed the bug
-- where a settlement taken at Branch B was credited to Branch A's till.
--
-- 20260905000000_complete_sale_lock_order.sql patches functions by substituting
-- pg_proc.prosrc at runtime and leaves its fix in no migration text -- but it
-- names complete_sale and edit_sale only, so there is no invisible edit here to
-- revert by copying forward.
create or replace function public.settle_sale_balance(
  p_sale_id uuid,
  p_payments jsonb,
  p_register_session_id uuid default null
) returns integer
language plpgsql security definer set search_path = public as $$
declare
  v_sale public.sales%rowtype;
  v_session public.register_sessions%rowtype;
  v_paid integer;
  v_refunded integer;
  -- The cash actually handed back on this sale's refunds. New here.
  v_cash_refunded integer;
  v_owed integer;
  v_payment jsonb;
  v_taking integer := 0;
  v_points integer := 0;
  -- The posting side, from 20260908000360.
  v_method text;
  v_amount integer;
  v_payment_id uuid;
  v_entry_id uuid;
begin
  select * into v_sale from public.sales where id = p_sale_id for update;
  if not found then
    raise exception 'sale not found';
  end if;

  if not public.has_any_shop_permission(v_sale.shop_id, array['pos.access', 'sales.edit']) then
    raise exception 'not authorized to take payment for this sale';
  end if;

  if p_payments is null or jsonb_array_length(p_payments) = 0 then
    raise exception 'at least one payment is required';
  end if;

  if p_register_session_id is not null then
    select * into v_session from public.register_sessions where id = p_register_session_id;
    if v_session.id is null then
      raise exception 'register session % not found', p_register_session_id;
    end if;
    if v_session.shop_id <> v_sale.shop_id then
      raise exception 'register session % does not belong to shop %', p_register_session_id, v_sale.shop_id;
    end if;
    if v_session.closed_at is not null then
      raise exception 'register session % is already closed', p_register_session_id;
    end if;
  end if;

  select coalesce(sum(amount_cents), 0) into v_paid
    from public.sale_payments where sale_id = p_sale_id;
  -- BOTH halves of every refund, read in one statement so they cannot come from
  -- different sets of rows.
  --
  -- goods_cents is what came back: it reduces the debt whether or not any cash
  -- followed, which is the whole point of 20260831000200's split.
  --
  -- total_cents is the CASH handed over, and it ADDS BACK. Money leaving the
  -- drawer is a payment running backwards; subtracting the goods without
  -- restoring the cash forgave the customer the same amount twice, and this
  -- function then refused to collect the difference and stamped the sale
  -- settled. The view above computes the identical expression.
  select coalesce(sum(goods_cents), 0), coalesce(sum(total_cents), 0)
    into v_refunded, v_cash_refunded
    from public.refunds where sale_id = p_sale_id;
  v_owed := v_sale.total_cents - v_refunded - v_paid + v_cash_refunded;

  if v_owed <= 0 then
    raise exception 'this sale is already paid in full';
  end if;

  for v_payment in select * from jsonb_array_elements(p_payments) loop
    if (v_payment->>'method') not in ('cash','zaad','edahab','other') then
      raise exception 'invalid payment method %', v_payment->>'method';
    end if;
    if (v_payment->>'amount_cents')::integer <= 0 then
      raise exception 'payment amount must be greater than zero';
    end if;
    v_taking := v_taking + (v_payment->>'amount_cents')::integer;
  end loop;

  if v_taking > v_owed then
    raise exception 'taking % is more than the % still owed', v_taking, v_owed;
  end if;

  for v_payment in select * from jsonb_array_elements(p_payments) loop
    v_method := v_payment->>'method';
    v_amount := (v_payment->>'amount_cents')::integer;

    insert into public.sale_payments
      (sale_id, method, amount_cents, tendered_cents, customer_name, customer_phone,
       currency_code, exchange_rate, foreign_amount_cents, foreign_change_cents,
       register_session_id, is_settlement)
    values
      (p_sale_id, v_method, v_amount,
       (v_payment->>'tendered_cents')::integer, v_payment->>'customer_name',
       v_payment->>'customer_phone', nullif(v_payment->>'currency_code', ''),
       (v_payment->>'exchange_rate')::numeric, (v_payment->>'foreign_amount_cents')::integer,
       (v_payment->>'foreign_change_cents')::integer, p_register_session_id, true)
    returning id into v_payment_id;

    -- ── The posting side ────────────────────────────────────────────────────
    --
    -- The simplest entry in the phase, and the shape matters more than the
    -- size: Dr the cash account, Cr 1100. NO revenue. The revenue was
    -- recognised when the sale was rung up and the receivable is what recorded
    -- it; recognising it again when the money arrives is the classic
    -- double-count, and it would show up as a shop whose credit sales earn
    -- twice.
    --
    -- One entry PER INSTALMENT, inside this loop rather than once after it.
    -- Lumping several settlements into a single entry would date the whole
    -- thing on the last payment and make each tender unreconcilable against its
    -- own account.
    --
    -- v_amount is guaranteed > 0 by the validation loop above, so neither line
    -- can be zero -- journal_lines carries check (amount_cents <> 0).
    --
    -- shop_local_date(), never now()::date -- UTC+3 means a late-night
    -- settlement would otherwise post to the previous month, permanently once
    -- that month closes. p_source => 'settlement', never 'manual': a cashier
    -- holds pos.access and must not need ledger.post to take a payment.
    --
    -- THE SETTLING TILL'S LOCATION, not the sale's. The money is handed over
    -- days later at whatever till happens to be open, which may be a different
    -- branch from the one that rang the sale.
    -- 20260831000300_settlement_cash_belongs_to_its_till.sql already fixed the
    -- drawer side of exactly this, attributing a payment through
    -- `coalesce(sp.register_session_id, s.register_session_id)`; dating the
    -- ledger by the sale's branch would put the same cash in Branch B's till
    -- and Branch A's 1000 Cash, which is a disagreement no reconciliation can
    -- resolve and a per-branch P&L that is wrong in both branches.
    --
    -- register_sessions.location_id is NOT NULL, so the coalesce falls through
    -- only when no session was passed at all -- a settlement taken outside a
    -- till session, where the sale's own branch is the best answer there is.
    v_entry_id := public.post_journal_entry(
      v_sale.shop_id,
      public.shop_local_date(),
      'Balance settled on sale ' || p_sale_id::text,
      jsonb_build_array(
        jsonb_build_object('code', public.account_code_for_payment_method(v_method),
                           'amount_cents',  v_amount, 'memo', 'Settlement received'),
        jsonb_build_object('code', '1100', 'amount_cents', -v_amount, 'memo', 'Cleared from receivables')),
      coalesce(v_session.location_id, v_sale.location_id),
      'settlement');

    update public.sale_payments set journal_entry_id = v_entry_id where id = v_payment_id;
    -- ── end posting side ────────────────────────────────────────────────────
  end loop;

  if v_sale.payment_method = 'unpaid' then
    update public.sales set payment_method = p_payments->0->>'method' where id = p_sale_id;
  end if;

  if v_taking = v_owed then
    update public.sales set settled_at = now() where id = p_sale_id;

    if v_refunded = 0
       and v_sale.customer_id is not null
       and coalesce(v_sale.loyalty_points_per_usd, 0) > 0
       and public.shop_has_module(v_sale.shop_id, 'customers') then
      v_points := round((v_sale.total_cents - coalesce(v_sale.tax_cents, 0))
                        * v_sale.loyalty_points_per_usd / 100)::integer;
      if v_points > 0 then
        update public.sales set points_earned = v_points where id = p_sale_id;
        insert into public.customer_points_ledger
          (shop_id, customer_id, sale_id, delta_points, reason, points_per_usd, created_by)
          values (v_sale.shop_id, v_sale.customer_id, p_sale_id, v_points, 'earn',
                  v_sale.loyalty_points_per_usd, auth.uid());
      end if;
    end if;
  end if;

  return v_owed - v_taking;
end;
$$;

grant execute on function public.settle_sale_balance(uuid, jsonb, uuid) to authenticated;

-- ── The sales the old formula closed too early ────────────────────────────
--
-- A sale that reached settled_at under the understated figure still has money
-- outstanding. THIS IS NOT A HYPOTHETICAL STATE: it is the end of the worked
-- example above -- settle_sale_balance refused anything over 1150, took the
-- 1150, and stamped the sale. The 2000 is still sitting in 1100 Accounts
-- Receivable on the shop's own balance sheet, and every screen that could
-- collect it filters on `settled_at is null`.
--
-- SO THEY ARE RE-OPENED, and the consequence is stated plainly: these sales
-- reappear on the receivables list, and a customer who was told their account
-- was clear may be asked for money again. That is the correct direction. The
-- alternative is a debt the books assert and the app denies, permanently, with
-- no door to write it off through either -- and a shop reconciling its balance
-- sheet finds an unexplainable 1100 with nothing to attribute it to.
--
-- The predicate is the ledger's own arithmetic, so this touches exactly the
-- sales where 1100 says money is still owed and nothing else:
--
--   * `total_cents > 0` on some refund. No refund, no divergence -- the two
--     formulas are identical without one, so an ordinary settled sale is not
--     considered at all.
--   * the corrected figure is still positive. A sale paid in full and later
--     partly refunded computes to 0 or below and is left alone; so is one
--     settled correctly under the old formula because no cash went back.
--   * `customer_id is not null`, matching the view. A sale with nobody attached
--     cannot appear on the receivables list whatever settled_at says, so
--     clearing it would only make the transactions screen offer an edit path
--     for a debt no one can be asked for.
--
-- THE STATEMENT BELOW IS RE-EXECUTED VERBATIM BY verify-balances.sql CHECK 35,
-- against a state built by hand to look like what the old code left behind --
-- because this runs against an empty database at migration time and is
-- therefore exercised by nothing else, while being the only destructive thing
-- here. Change one and change the other; check 35 says the same.
--
-- Loyalty is unaffected in both directions: settle_sale_balance credits points
-- only when v_refunded = 0, and every sale here has a refund with
-- total_cents > 0 -- which forces goods_cents > 0, since the cash is
-- `least(goods, ...)`. No points were awarded when these settled and none will
-- be when they settle again.
--
-- THE TRIGGER DISABLE IS LOAD-BEARING, NOT DEFENSIVE. This is the same trap
-- 20260819000000 documents for `products`, one table over. `sales_module`
-- (20260818000400) fires BEFORE INSERT OR UPDATE and raises
-- `module_not_included` for any shop that may not write in `pos` -- and
-- shop_has_module() returns false OUTRIGHT for a suspended shop
-- (20260818000200), which is a live platform-admin switch
-- (supabase/functions/platform-admin). So one suspended shop holding one
-- part-paid, part-cash-refunded settled sale would abort this UPDATE on its
-- first row, roll the whole `supabase db push` back, and take every migration
-- after it with it.
--
-- This is a data repair performed by the system, not a write by a shop, so the
-- plan gate does not apply to it: the shop is not being allowed to do anything,
-- it is having money it was already owed handed back to it. Refusing that
-- because an invoice lapsed would be the billing status deciding what the books
-- say -- and 20260818000200 is explicit that a lapsed shop keeps full access to
-- its own records.
--
-- `sales_monthly_limit` is BEFORE INSERT, so it is not reachable from an UPDATE;
-- `sales_module` is the only trigger on this table that needs disabling. DO NOT
-- REMOVE THIS -- verify-balances check 36 re-opens a stranded sale on a shop
-- that has been suspended, and reddens with `module_not_included` if it goes.
alter table public.sales disable trigger sales_module;

update public.sales s
   set settled_at = null
 where s.settled_at is not null
   and s.customer_id is not null
   and exists (select 1 from public.refunds r where r.sale_id = s.id and r.total_cents > 0)
   and (s.total_cents
        - coalesce((select sum(r.goods_cents) from public.refunds r where r.sale_id = s.id), 0)
        - coalesce((select sum(p.amount_cents) from public.sale_payments p where p.sale_id = s.id), 0)
        + coalesce((select sum(r.total_cents) from public.refunds r where r.sale_id = s.id), 0)) > 0;

alter table public.sales enable trigger sales_module;

comment on view public.customer_balances is
  'One row per unsettled sale that still owes money. owed_cents is total - goods returned - paid + cash refunded: the cash a refund handed over is a payment running backwards, and leaving it out forgave the customer the same amount twice. Matches settle_sale_balance''s v_owed and the ledger''s 1100 for the sale exactly.';
