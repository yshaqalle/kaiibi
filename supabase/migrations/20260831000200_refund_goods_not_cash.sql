-- What came back, and what was handed over, are two different numbers now.
--
-- refunds.total_cents has always meant both: the VALUE of the goods returned and
-- the CASH given to the customer. Identical while every sale was paid in full,
-- which is the invariant 20260831000100 broke by allowing credit.
--
-- Left alone, refunding a $100 sale that nobody had paid a cent on took $100 out
-- of the drawer -- refund_sale_items apportions sales.total_cents, and the local
-- it apportions into is called v_sale_paid_cents, because when it was written
-- those were the same thing. registers.ts books total_cents as cash out and the
-- refund modal tells the cashier "$100 will be refunded". So the shop handed over
-- money it had never received.
--
-- The split:
--
--   refunds.goods_cents  what came back, priced as the sale priced it. Reduces
--                        what the customer owes. Equal to total_cents on every
--                        sale that was paid in full, which is every sale before
--                        this week -- hence the backfill below.
--   refunds.total_cents  cash actually handed over, capped at what was collected
--                        and not already refunded. Unchanged meaning, unchanged
--                        readers: the drawer, refundedCents, the modal.
--
-- customer_balances and settle_sale_balance therefore move to goods_cents:
-- returning goods must clear the debt whether or not any cash came back, or a
-- customer would be chased for something they handed in.

alter table public.refunds
  add column if not exists goods_cents integer not null default 0;

-- Every existing refund was against a sale paid in full, so the value returned
-- and the cash returned were the same figure. Written as "copy it" rather than
-- recomputed for the reason the function itself gives: recomputing would quietly
-- restate refunds customers received months ago.
update public.refunds set goods_cents = total_cents where goods_cents = 0;

comment on column public.refunds.goods_cents is
  'Value of the goods returned, priced as the sale priced them. Reduces what the customer owes. total_cents is the CASH handed back, which is capped at what was actually collected -- the two differ only on a sale taken on credit.';

-- ── refund_sale_items ─────────────────────────────────────────────────────
-- Reproduced from 20260820000200_refund_what_was_paid.sql with the goods/cash
-- split above and nothing else.
create or replace function public.refund_sale_items(p_sale_id uuid, p_items jsonb)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_shop_id uuid;
  v_location_id uuid;
  v_refund_id uuid;
  v_item jsonb;
  v_sale_item public.sale_items%rowtype;
  v_requested_qty integer;
  v_already_refunded_qty integer;
  v_new_cum_qty integer;
  v_cum_amount integer;
  v_prior_amount integer;
  v_refund_amount integer;
  -- GROSS money for this refund: the sum of line_total_cents shares going back,
  -- before the sale's order discount, points and tax are accounted for. It sets
  -- the PROPORTION of the sale being returned; it is not what anyone is paid.
  v_this_gross integer := 0;
  v_total_cents integer := 0;
  v_customer_id uuid;
  v_points_earned integer;
  v_points_redeemed integer;
  v_sale_gross_cents integer;
  -- What the sale CAME TO. Was called v_sale_paid_cents, which was true only
  -- while every sale was paid in full -- and reading it as "paid" is exactly
  -- how a credit sale came to refund cash nobody had handed over.
  v_sale_total_cents integer;
  -- What was actually collected on this sale, ever.
  v_collected_cents integer;
  -- This refund's two halves, which used to be one number.
  v_goods_cents integer;
  v_cum_goods_cents integer;
  v_prior_goods_cents integer;
  v_prior_cash_cents integer;
  v_prior_gross_all integer;
  v_cum_gross_all integer;
  v_allocated integer := 0;
  v_share integer;
  v_row record;
  v_largest_id uuid;
  v_prior_clawback integer;
  v_cum_clawback integer;
  v_remaining_qty integer;
  v_loyalty_active boolean := false;
  v_clawback integer;
  v_balance integer;
begin
  select shop_id, location_id, customer_id, points_earned, points_redeemed, total_cents
    into v_shop_id, v_location_id, v_customer_id, v_points_earned, v_points_redeemed, v_sale_total_cents
    from public.sales where id = p_sale_id;
  if v_shop_id is null then
    raise exception 'sale % not found', p_sale_id;
  end if;
  if not public.has_shop_permission(v_shop_id, 'sales.refund') then
    raise exception 'not authorized for sale %', p_sale_id;
  end if;
  if p_items is null or jsonb_array_length(p_items) = 0 then
    raise exception 'a refund must include at least one item';
  end if;

  v_points_earned := coalesce(v_points_earned, 0);
  v_points_redeemed := coalesce(v_points_redeemed, 0);
  v_loyalty_active := v_customer_id is not null
    and public.shop_has_module(v_shop_id, 'customers');

  select coalesce(sum(line_total_cents), 0) into v_sale_gross_cents
    from public.sale_items where sale_id = p_sale_id;

  -- Both read before the new refund row exists, so they describe strictly what
  -- earlier refunds did.
  --
  -- Prior GROSS is rebuilt from quantities rather than from the stored amounts,
  -- because those amounts are now scaled money and no longer carry the
  -- proportion. Quantities are the durable fact.
  select coalesce(sum(round(si.line_total_cents::numeric * q.refunded_qty / si.quantity)), 0)
    into v_prior_gross_all
    from public.sale_items si
    join (select ri.sale_item_id, sum(ri.quantity) as refunded_qty
            from public.refund_items ri
            join public.sale_items s2 on s2.id = ri.sale_item_id
           where s2.sale_id = p_sale_id
           group by ri.sale_item_id) q on q.sale_item_id = si.id
   where si.sale_id = p_sale_id;

  -- Both halves of what earlier refunds on this sale already did, taken from the
  -- stored rows and never recomputed: refunds issued before 20260820000200 used
  -- the old gross-based figure, and recomputing would make the next partial
  -- refund quietly "correct" one the customer received months ago.
  select coalesce(sum(r.goods_cents), 0), coalesce(sum(r.total_cents), 0)
    into v_prior_goods_cents, v_prior_cash_cents
    from public.refunds r where r.sale_id = p_sale_id;

  -- The number this whole migration turns on. Before credit existed it was
  -- always equal to v_sale_total_cents, which is why one column could mean both
  -- "what came back" and "what was handed over".
  select coalesce(sum(sp.amount_cents), 0) into v_collected_cents
    from public.sale_payments sp where sp.sale_id = p_sale_id;

  insert into public.refunds (sale_id, refunded_by) values (p_sale_id, auth.uid())
    returning id into v_refund_id;

  for v_item in select value from jsonb_array_elements(p_items) as t(value) order by (value->>'sale_item_id') loop
    v_requested_qty := (v_item->>'quantity')::integer;
    if v_requested_qty is null or v_requested_qty <= 0 then
      raise exception 'invalid refund quantity';
    end if;

    select * into v_sale_item from public.sale_items
      where id = (v_item->>'sale_item_id')::uuid and sale_id = p_sale_id
      for update;
    if v_sale_item.id is null then
      raise exception 'sale item % not found on sale %', v_item->>'sale_item_id', p_sale_id;
    end if;

    select coalesce(sum(quantity), 0) into v_already_refunded_qty
      from public.refund_items where sale_item_id = v_sale_item.id;

    v_new_cum_qty := v_already_refunded_qty + v_requested_qty;
    if v_new_cum_qty > v_sale_item.quantity then
      raise exception 'refund exceeds remaining quantity for %', v_sale_item.product_name;
    end if;

    v_cum_amount := round(v_sale_item.line_total_cents::numeric * v_new_cum_qty / v_sale_item.quantity);
    v_prior_amount := round(v_sale_item.line_total_cents::numeric * v_already_refunded_qty / v_sale_item.quantity);
    v_refund_amount := v_cum_amount - v_prior_amount;

    if v_sale_item.product_id is not null then
      insert into public.product_location_stock (product_id, location_id, stock)
        values (v_sale_item.product_id, v_location_id, v_requested_qty)
        on conflict (product_id, location_id)
        do update set stock = public.product_location_stock.stock + excluded.stock, updated_at = now();
    end if;

    insert into public.refund_items (refund_id, sale_item_id, product_id, quantity, amount_cents)
      values (v_refund_id, v_sale_item.id, v_sale_item.product_id, v_requested_qty, v_refund_amount);

    v_this_gross := v_this_gross + v_refund_amount;
  end loop;

  -- Scale what is actually handed back to what was actually paid.
  --
  -- The loop above works in line_total_cents, which is gross of the sale's
  -- order discount and of any points redeemed, and net of tax. Paying that
  -- figure out over-refunds a discounted sale and under-refunds a taxed one --
  -- two errors in opposite directions, which is how this survived: the total
  -- looked plausible. sales.total_cents is the one number the customer actually
  -- handed over, so the refund is that number, in the proportion being returned.
  --
  -- Cumulative-then-differenced, the same discipline the per-line amounts use,
  -- so refunding a sale in pieces returns exactly what refunding it at once
  -- would: when the last unit goes back v_cum_gross_all equals v_sale_gross_cents,
  -- the ratio is exactly 1, and the running total lands on total_cents to the cent.
  v_cum_gross_all := v_prior_gross_all + v_this_gross;

  if v_sale_gross_cents > 0 then
    v_cum_goods_cents := round(v_sale_total_cents::numeric * v_cum_gross_all / v_sale_gross_cents);
  else
    -- A sale whose lines are entirely discounted away: nothing to apportion.
    v_cum_goods_cents := v_prior_goods_cents;
  end if;

  -- The VALUE coming back. Never negative: a sale already over-refunded under the
  -- old maths can leave the prior figure above the cumulative one, and the shop
  -- does not claw that back from the customer on a later return.
  v_goods_cents := greatest(v_cum_goods_cents - v_prior_goods_cents, 0);

  -- The CASH going out, which cannot exceed what came in. On a sale paid in full
  -- this is exactly v_goods_cents and nothing about refunds changes; on a sale
  -- taken on credit it is the difference between the two, and that difference is
  -- money the shop would otherwise have handed over having never received it.
  --
  -- Returning goods still clears the debt -- customer_balances subtracts
  -- goods_cents, not this -- so the customer is not charged for what they gave
  -- back. They simply are not paid for what they never paid for.
  v_total_cents := least(v_goods_cents, greatest(v_collected_cents - v_prior_cash_cents, 0));

  -- Spread it back over this refund's lines so the children still sum to the
  -- parent -- reconciliation reads both. Smallest first, with the largest line
  -- absorbing the rounding remainder, where a penny is least conspicuous.
  if v_this_gross > 0 then
    select id into v_largest_id from public.refund_items
      where refund_id = v_refund_id order by amount_cents desc, id limit 1;
    for v_row in select id, amount_cents from public.refund_items
                  where refund_id = v_refund_id and id <> v_largest_id
    loop
      v_share := round(v_total_cents::numeric * v_row.amount_cents / v_this_gross);
      update public.refund_items set amount_cents = v_share where id = v_row.id;
      v_allocated := v_allocated + v_share;
    end loop;
    update public.refund_items set amount_cents = v_total_cents - v_allocated
      where id = v_largest_id;
  end if;

  -- ORDER MATTERS HERE, and it is the reverse of what reads naturally.
  --
  -- Redeemed points are given back BEFORE earned points are taken away. A full
  -- refund of a sale that spent points does both, and the customer nets out
  -- correctly only in this order: clawing back first would hit a balance the
  -- redemption had already emptied, get clamped to nothing, and then the
  -- reversal would land on top -- handing back points the shop meant to keep.
  --
  -- Redeemed points come back only when the WHOLE sale has gone back -- all or
  -- nothing, exactly once. The redemption was an order-level price reduction
  -- attributable to no single line, so pro-rating it across a partial return
  -- would be an invented number; and a customer keeping half the basket keeps
  -- the discount they got on it.
  if v_loyalty_active and v_points_redeemed > 0 then
    select coalesce(sum(si.quantity), 0)
         - coalesce((select sum(ri.quantity)
                       from public.refund_items ri
                       join public.sale_items si2 on si2.id = ri.sale_item_id
                      where si2.sale_id = p_sale_id), 0)
      into v_remaining_qty
      from public.sale_items si where si.sale_id = p_sale_id;

    if v_remaining_qty <= 0 and not exists (
      select 1 from public.customer_points_ledger
       where sale_id = p_sale_id and reason = 'redeem_reversed'
    ) then
      insert into public.customer_points_ledger
        (shop_id, customer_id, sale_id, refund_id, delta_points, reason, created_by)
        values (v_shop_id, v_customer_id, p_sale_id, v_refund_id, v_points_redeemed,
                'redeem_reversed', auth.uid());
    end if;
  end if;

  -- Earned points claw back in proportion to the money going back. Computed
  -- cumulatively against everything ever refunded on this sale and then
  -- differenced -- the same technique the per-line amounts above use, so
  -- refunding three items one at a time claws back exactly what refunding all
  -- three at once would, with no rounding drift.
  --
  -- Clamped to the balance the customer actually has. If they already spent
  -- what this sale earned, the shop absorbs the difference rather than posting
  -- them a negative balance for a refund the shop agreed to give. The shortfall
  -- is deliberately NOT chased on a later refund: the per-refund share is
  -- computed from the formula, not from what was previously recovered, so a
  -- customer never loses points months later to settle an old clawback.
  -- Measured against the GROSS proportion returned, not the scaled money: the
  -- money now carries the sale's discount and tax, and points were never earned
  -- on either. This keeps "half the basket went back" meaning half the points,
  -- whatever the sale's pricing looked like.
  if v_loyalty_active and v_points_earned > 0 and v_sale_gross_cents > 0 then
    v_prior_clawback := least(v_points_earned,
      floor(v_points_earned::numeric * v_prior_gross_all / v_sale_gross_cents)::integer);
    v_cum_clawback := least(v_points_earned,
      floor(v_points_earned::numeric * v_cum_gross_all / v_sale_gross_cents)::integer);
    v_clawback := v_cum_clawback - v_prior_clawback;

    if v_clawback > 0 then
      -- The same lock a redemption takes, so a concurrent spend cannot slip
      -- between reading the balance and clamping to it.
      select points_balance into v_balance from public.customers
        where id = v_customer_id for update;
      v_clawback := least(v_clawback, greatest(coalesce(v_balance, 0), 0));

      if v_clawback > 0 then
        insert into public.customer_points_ledger
          (shop_id, customer_id, sale_id, refund_id, delta_points, reason, created_by)
          values (v_shop_id, v_customer_id, p_sale_id, v_refund_id,
                  -v_clawback, 'refund_clawback', auth.uid());
      end if;
    end if;
  end if;

  update public.refunds set total_cents = v_total_cents, goods_cents = v_goods_cents
    where id = v_refund_id;
  return v_refund_id;
end;
$$;

grant execute on function public.refund_sale_items(uuid, jsonb) to authenticated;

-- ── customer_balances ─────────────────────────────────────────────────────
-- Same view as 20260831000000, reading goods_cents. A returned basket clears the
-- debt even when no cash went back, which is the whole point of the split.
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
  coalesce(returned.total, 0)::integer as refunded_cents,
  (s.total_cents - coalesce(returned.total, 0) - coalesce(paid.total, 0))::integer as owed_cents
from public.sales s
left join public.customers c on c.id = s.customer_id
left join lateral (
  select sum(p.amount_cents) as total from public.sale_payments p where p.sale_id = s.id
) paid on true
left join lateral (
  select sum(r.goods_cents) as total from public.refunds r where r.sale_id = s.id
) returned on true
where s.settled_at is null
  and s.customer_id is not null
  and (s.total_cents - coalesce(returned.total, 0) - coalesce(paid.total, 0)) > 0;

grant select on public.customer_balances to authenticated;

-- ── settle_sale_balance ───────────────────────────────────────────────────
-- Same function as 20260831000100, with v_refunded reading goods_cents so the
-- RPC and the view cannot disagree about what is owed.
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
  v_owed integer;
  v_payment jsonb;
  v_taking integer := 0;
  v_points integer := 0;
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
  -- goods_cents, not total_cents: what the customer owes falls by the value of
  -- what they brought back, not by whatever cash the shop was able to return.
  select coalesce(sum(goods_cents), 0) into v_refunded
    from public.refunds where sale_id = p_sale_id;
  v_owed := v_sale.total_cents - v_refunded - v_paid;

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
    insert into public.sale_payments
      (sale_id, method, amount_cents, tendered_cents, customer_name, customer_phone,
       currency_code, exchange_rate, foreign_amount_cents, foreign_change_cents,
       register_session_id, is_settlement)
    values
      (p_sale_id, v_payment->>'method', (v_payment->>'amount_cents')::integer,
       (v_payment->>'tendered_cents')::integer, v_payment->>'customer_name',
       v_payment->>'customer_phone', nullif(v_payment->>'currency_code', ''),
       (v_payment->>'exchange_rate')::numeric, (v_payment->>'foreign_amount_cents')::integer,
       (v_payment->>'foreign_change_cents')::integer, p_register_session_id, true);
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

-- ── edit_sale ─────────────────────────────────────────────────────────────
-- Reproduced from 20260831000100 with one change: the empty-payments guard
-- becomes conditional, which that migration's own header said it had done.
drop function if exists public.edit_sale(uuid, jsonb, jsonb, text, text, text, integer, uuid, boolean);
create or replace function public.edit_sale(
  p_sale_id uuid,
  p_items jsonb,
  p_payments jsonb,
  p_customer_name text default null,
  p_customer_phone text default null,
  p_customer_email text default null,
  p_discount_cents integer default 0,
  p_customer_id uuid default null,
  p_allow_balance boolean default false
) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_shop_id uuid;
  v_location_id uuid;
  v_snapshot jsonb;
  v_old_item record;
  v_item jsonb;
  v_payment jsonb;
  v_product public.products%rowtype;
  v_available integer;
  v_qty integer;
  v_line integer;
  v_line_discount integer;
  v_gross_cents integer := 0;
  v_total_cents integer := 0;
  v_item_count integer := 0;
  v_payments_total integer := 0;
  v_settled_cents integer := 0;
  v_discount_cents integer := greatest(coalesce(p_discount_cents, 0), 0);
  v_tax_enabled boolean;
  v_tax_rate numeric;
  v_tax_cents integer := 0;
  v_shop_points_per_usd numeric;
  v_sale_points_per_usd numeric;
  v_rate_used numeric;
  v_loyalty_enabled boolean;
  v_loyalty_active boolean := false;
  v_old_customer_id uuid;
  v_points_earned_old integer;
  v_points_redeemed_cents integer;
  v_points_earned_new integer := 0;
  v_points_delta integer;
  v_balance integer;
  v_promo_id uuid;
  v_promo_name text;
  v_promo_type text;
  v_promo_value integer;
  v_promo_starts_at timestamptz;
  v_promo_ends_at timestamptz;
  v_expected_discount integer;
  -- Promotions already attached to this sale before the edit -- captured
  -- below, right before the old sale_items are deleted. Re-saving one of
  -- these is PRESERVING history, not attaching a new offer, and is exempt
  -- from the active/archived_at/window checks a fresh attachment must pass:
  -- editing a sale from last month has to be able to re-save a promotion
  -- that has since ended, been paused, or been archived, or old sales would
  -- become uneditable.
  v_existing_promo_ids uuid[];
begin
  select shop_id, location_id, customer_id, points_earned, points_redeemed_cents,
         loyalty_points_per_usd
    into v_shop_id, v_location_id, v_old_customer_id, v_points_earned_old,
         v_points_redeemed_cents, v_sale_points_per_usd
    from public.sales where id = p_sale_id;
  if v_shop_id is null then
    raise exception 'sale % not found', p_sale_id;
  end if;
  if not public.has_shop_permission(v_shop_id, 'sales.edit') then
    raise exception 'not authorized for sale %', p_sale_id;
  end if;
  -- A transaction-level discount with no promotion behind it is a cashier
  -- typing an arbitrary number, the same as a line discount, and needs the
  -- same permission. Without this, `sales.edit` alone could put a whole-sale
  -- discount on an existing sale even though creating one that way requires
  -- `discounts.manual`.
  if v_discount_cents > 0
     and not public.has_shop_permission(v_shop_id, 'discounts.manual') then
    raise exception 'not authorized to enter a manual discount';
  end if;
  if p_items is null or jsonb_array_length(p_items) = 0 then
    raise exception 'a sale must have at least one item';
  end if;
  -- The conditional the header of 20260831000100 claimed and did not apply, which
  -- left a wholly unpaid sale permanently uneditable -- and its 'unpaid' coalesce
  -- below unreachable.
  if p_payments is null or jsonb_array_length(p_payments) = 0 then
    if not coalesce(p_allow_balance, false) then
      raise exception 'at least one payment is required';
    end if;
    if p_customer_id is null then
      raise exception 'a sale can only be left unpaid against a customer';
    end if;
  end if;

  v_points_earned_old := coalesce(v_points_earned_old, 0);
  v_points_redeemed_cents := coalesce(v_points_redeemed_cents, 0);

  select tax_enabled, tax_rate_percent, loyalty_enabled, loyalty_points_per_usd
    into v_tax_enabled, v_tax_rate, v_loyalty_enabled, v_shop_points_per_usd
    from public.shops where id = v_shop_id;

  v_loyalty_active := coalesce(v_loyalty_enabled, false)
    and public.shop_has_module(v_shop_id, 'customers');
  v_rate_used := coalesce(v_sale_points_per_usd, v_shop_points_per_usd);

  select jsonb_build_object(
    'total_cents', s.total_cents,
    'item_count', s.item_count,
    'payment_method', s.payment_method,
    'customer_name', s.customer_name,
    'customer_phone', s.customer_phone,
    'customer_email', s.customer_email,
    'discount_cents', s.discount_cents,
    'customer_id', s.customer_id,
    'points_earned', s.points_earned,
    'points_redeemed', s.points_redeemed,
    'points_redeemed_cents', s.points_redeemed_cents,
    'items', (select coalesce(jsonb_agg(jsonb_build_object(
        'product_id', si.product_id, 'product_name', si.product_name,
        'unit_price_cents', si.unit_price_cents, 'quantity', si.quantity,
        'line_total_cents', si.line_total_cents, 'discount_cents', si.discount_cents,
        'unit_cost_cents', si.unit_cost_cents,
        'promotion_id', si.promotion_id, 'promotion_name', si.promotion_name
      )), '[]'::jsonb) from public.sale_items si where si.sale_id = p_sale_id),
    'payments', (select coalesce(jsonb_agg(jsonb_build_object(
        'method', sp.method, 'amount_cents', sp.amount_cents, 'tendered_cents', sp.tendered_cents,
        'customer_name', sp.customer_name, 'customer_phone', sp.customer_phone
      )), '[]'::jsonb) from public.sale_payments sp where sp.sale_id = p_sale_id)
  ) into v_snapshot
  from public.sales s where s.id = p_sale_id;

  insert into public.sale_edits (sale_id, edited_by, previous_snapshot)
    values (p_sale_id, auth.uid(), v_snapshot);

  for v_old_item in select product_id, quantity from public.sale_items where sale_id = p_sale_id loop
    if v_old_item.product_id is not null then
      insert into public.product_location_stock (product_id, location_id, stock)
        values (v_old_item.product_id, v_location_id, v_old_item.quantity)
        on conflict (product_id, location_id)
        do update set stock = public.product_location_stock.stock + excluded.stock, updated_at = now();
    end if;
  end loop;

  -- Captured before the delete below wipes the rows it would otherwise read
  -- from -- see v_existing_promo_ids's declaration for what this is for.
  select coalesce(array_agg(distinct promotion_id) filter (where promotion_id is not null), '{}')
    into v_existing_promo_ids
    from public.sale_items where sale_id = p_sale_id;

  delete from public.sale_items where sale_id = p_sale_id;
  -- Only the till's own payments. Before balances existed every payment row
  -- was written by this sale in one go, so deleting the lot and re-inserting
  -- what the client sent was lossless. A settlement is money taken days
  -- later at another register, which this call knows nothing about and the
  -- client has no reason to resend -- deleting it would erase a real payment
  -- and put the customer back in debt for money they had already handed over.
  delete from public.sale_payments where sale_id = p_sale_id and not is_settlement;
  select coalesce(sum(amount_cents), 0) into v_settled_cents
    from public.sale_payments where sale_id = p_sale_id and is_settlement;
  -- Settlements already collected count towards what this sale has been paid.
  v_payments_total := v_settled_cents;

  for v_item in select * from jsonb_array_elements(p_items) loop
    v_qty := (v_item->>'quantity')::integer;
    if v_qty is null or v_qty <= 0 then
      raise exception 'invalid quantity in sale item';
    end if;

    select * into v_product from public.products
      where id = (v_item->>'product_id')::uuid and shop_id = v_shop_id;

    if v_product.id is null then
      raise exception 'product % not found in this shop', v_item->>'product_id';
    end if;

    select stock into v_available from public.product_location_stock
      where product_id = v_product.id and location_id = v_location_id
      for update;

    if coalesce(v_available, 0) < v_qty then
      raise exception 'insufficient stock for % at this location: has %, need %',
        v_product.name, coalesce(v_available, 0), v_qty;
    end if;

    v_line_discount := greatest(coalesce((v_item->>'discount_cents')::integer, 0), 0);
    v_promo_id := nullif(v_item->>'promotion_id', '')::uuid;

    if v_promo_id is null then
      -- No promotion behind it means a cashier typed a number, which is the
      -- one discount path nothing has ever recorded or restricted. Anyone may
      -- APPLY an offer; entering your own amount is a separate permission.
      if v_line_discount > 0
         and not public.has_shop_permission(v_shop_id, 'discounts.manual') then
        raise exception 'not authorized to enter a manual discount';
      end if;
      v_promo_name := null;
    elsif v_promo_id = any(v_existing_promo_ids) then
      -- PRESERVED, not attached: this promotion was already on the sale
      -- before the edit, so re-saving it is history surviving an edit, not a
      -- new offer being claimed. Looked up by id/shop_id only -- no active,
      -- no archived_at, no window -- because a sale from last month has to
      -- stay editable even after the promotion behind it has since ended,
      -- been paused, or been archived. The amount is still capped: history
      -- may be kept, but it may not be inflated on the way back in.
      select name, discount_type, discount_value
        into v_promo_name, v_promo_type, v_promo_value
        from public.promotions
       where id = v_promo_id and shop_id = v_shop_id;
      if not found then
        raise exception 'promotion % does not belong to shop %', v_promo_id, v_shop_id;
      end if;

      v_expected_discount := case
        when v_promo_type = 'percentage'
          then round(v_product.price_cents::numeric * v_qty * v_promo_value / 100)::integer
        else least(v_promo_value, v_product.price_cents * v_qty)
      end;
      if v_line_discount > v_expected_discount then
        raise exception 'discount % exceeds what promotion % allows (%)',
          v_line_discount, v_promo_name, v_expected_discount;
      end if;
    else
      -- NEWLY attached: this promotion was not already on the sale, so it
      -- gets exactly the rules complete_sale applies to a fresh claim,
      -- window included. A claimed promotion is verified against the row,
      -- not taken on trust: otherwise "attach any uuid" would be a way
      -- around the permission above, and the name written onto the sale
      -- forever would be the caller's text. `active and archived_at is null`
      -- so a paused or archived promotion's id cannot be attached to a sale
      -- -- otherwise a cashier without discounts.manual could use a
      -- store-wide promotion's id, paused or not, to take a discount the
      -- permission exists to prevent.
      select name, discount_type, discount_value, starts_at, ends_at
        into v_promo_name, v_promo_type, v_promo_value, v_promo_starts_at, v_promo_ends_at
        from public.promotions
       where id = v_promo_id and shop_id = v_shop_id and active and archived_at is null;
      if not found then
        -- Newly attached, so it had to clear shop + active + archived_at as well.
        raise exception 'promotion % is not available to attach to a sale (wrong shop, paused, or archived)', v_promo_id;
      end if;

      -- Same slack as complete_sale: one minute absorbs clock skew on the
      -- start, ten minutes on the end gives a cashier mid-checkout room to
      -- finish after the offer lapses.
      if v_promo_starts_at is not null and v_promo_starts_at > now() + interval '1 minute' then
        raise exception 'promotion % has not started yet', v_promo_name;
      end if;
      if v_promo_ends_at is not null and v_promo_ends_at <= now() - interval '10 minutes' then
        raise exception 'promotion % has ended', v_promo_name;
      end if;

      v_expected_discount := case
        when v_promo_type = 'percentage'
          then round(v_product.price_cents::numeric * v_qty * v_promo_value / 100)::integer
        else least(v_promo_value, v_product.price_cents * v_qty)
      end;
      -- Greater-than rather than not-equal: a client rounding a percentage a
      -- cent differently must not fail a legitimate sale, but nobody may claim
      -- more than the offer actually gives.
      if v_line_discount > v_expected_discount then
        raise exception 'discount % exceeds what promotion % allows (%)',
          v_line_discount, v_promo_name, v_expected_discount;
      end if;
    end if;
    v_line := v_product.price_cents * v_qty - v_line_discount;
    if v_line < 0 then
      raise exception 'discount exceeds line total for %', v_product.name;
    end if;

    update public.product_location_stock set stock = stock - v_qty, updated_at = now()
      where product_id = v_product.id and location_id = v_location_id;

    insert into public.sale_items (sale_id, product_id, product_name, unit_price_cents, quantity, line_total_cents, discount_cents, unit_cost_cents, promotion_id, promotion_name)
      values (p_sale_id, v_product.id, v_product.name, v_product.price_cents, v_qty, v_line, v_line_discount, v_product.cost_cents, v_promo_id, v_promo_name);

    v_gross_cents := v_gross_cents + v_line;
    v_item_count := v_item_count + v_qty;
  end loop;

  if v_item_count = 0 then
    raise exception 'cannot save a sale with no items';
  end if;

  -- The redemption carries through untouched: the customer spent those points
  -- and got that money off, and an edit that corrects a quantity is not a
  -- reason to take the discount back.
  v_total_cents := v_gross_cents - v_discount_cents - v_points_redeemed_cents;
  if v_total_cents < 0 then
    raise exception 'discount exceeds sale total';
  end if;

  if v_loyalty_active and p_customer_id is not null then
    v_points_earned_new := round(v_total_cents * v_rate_used / 100)::integer;
  end if;

  if v_tax_enabled then
    v_tax_cents := round(v_total_cents * v_tax_rate / 100)::integer;
  end if;
  v_total_cents := v_total_cents + v_tax_cents;

  for v_payment in select * from jsonb_array_elements(p_payments) loop
    if (v_payment->>'method') not in ('cash','zaad','edahab','other') then
      raise exception 'invalid payment method %', v_payment->>'method';
    end if;
    if (v_payment->>'amount_cents')::integer <= 0 then
      raise exception 'payment amount must be greater than zero';
    end if;
    v_payments_total := v_payments_total + (v_payment->>'amount_cents')::integer;

    insert into public.sale_payments (sale_id, method, amount_cents, tendered_cents, customer_name, customer_phone, currency_code, exchange_rate, foreign_amount_cents, foreign_change_cents)
      values (
        p_sale_id,
        v_payment->>'method',
        (v_payment->>'amount_cents')::integer,
        (v_payment->>'tendered_cents')::integer,
        v_payment->>'customer_name',
        v_payment->>'customer_phone',
        nullif(v_payment->>'currency_code', ''),
        (v_payment->>'exchange_rate')::numeric,
        (v_payment->>'foreign_amount_cents')::integer,
        (v_payment->>'foreign_change_cents')::integer
      );
  end loop;

  -- Over-payment is still always wrong: a till that takes more than the bill
  -- has a bug, not a credit. Change is `tendered_cents`, not a bigger payment.
  if v_payments_total > v_total_cents then
    raise exception 'payments total % is more than sale total %', v_payments_total, v_total_cents;
  end if;

  -- Under-payment is a decision, and it has to be an explicit one made against
  -- a named customer. Without BOTH, this is exactly the accident the old
  -- unconditional guard existed to catch: a client that miscounted its own
  -- split and would otherwise have quietly written off the difference.
  if v_payments_total < v_total_cents then
    if not coalesce(p_allow_balance, false) then
      raise exception 'payments total % does not match sale total %', v_payments_total, v_total_cents;
    end if;
    if p_customer_id is null then
      raise exception 'a sale can only be left unpaid against a customer';
    end if;
  end if;

  -- Points are earned on money taken, not on goods handed over. A sale left on
  -- account earns nothing yet; settle_sale_balance credits it when the last of
  -- the money arrives, recomputed from this sale's own frozen rate.
  if v_payments_total < v_total_cents then
    v_points_earned_new := 0;
  end if;

  update public.sales set
    total_cents = v_total_cents,
    item_count = v_item_count,
    payment_method = coalesce(p_payments->0->>'method', 'unpaid'),
    customer_name = nullif(p_customer_name, ''),
    customer_phone = nullif(p_customer_phone, ''),
    customer_email = nullif(p_customer_email, ''),
    customer_id = p_customer_id,
    discount_cents = v_discount_cents,
    tax_cents = v_tax_cents,
    tax_rate_percent = case when v_tax_enabled then v_tax_rate else null end,
    points_earned = v_points_earned_new,
    -- Keyed off loyalty being on, not off points having been earned: a sale
    -- left on account earns nothing yet and still has to remember the rate it
    -- will earn at when it is paid off.
    loyalty_points_per_usd = case when v_loyalty_active and p_customer_id is not null then v_rate_used else null end,
    -- coalesce, not a bare now(): re-pricing a sale that was paid off last
    -- month must not move the date it was paid off.
    settled_at = case when v_payments_total >= v_total_cents then coalesce(settled_at, now()) else null end
  where id = p_sale_id;

  -- When the sale still belongs to the same person the two movements collapse
  -- into one delta row; when the edit reassigned it, the original earner gives
  -- the points back and the new one earns from scratch.
  -- Every negative movement below is clamped to the balance on hand, so an
  -- edit that reduces what a sale earned can never post a debt against a
  -- customer who has already spent it.
  if v_old_customer_id is not distinct from p_customer_id then
    v_points_delta := v_points_earned_new - v_points_earned_old;
    if v_points_delta < 0 then
      select points_balance into v_balance from public.customers
        where id = p_customer_id for update;
      v_points_delta := -least(-v_points_delta, greatest(coalesce(v_balance, 0), 0));
    end if;
    if v_points_delta <> 0 and p_customer_id is not null then
      insert into public.customer_points_ledger
        (shop_id, customer_id, sale_id, delta_points, reason, points_per_usd, note, created_by)
        values (v_shop_id, p_customer_id, p_sale_id, v_points_delta, 'adjustment',
                v_rate_used, 'sale edited', auth.uid());
    end if;
  else
    -- Reassigned to someone else: the original earner gives back what they can,
    -- and the new owner earns from scratch.
    if v_old_customer_id is not null and v_points_earned_old > 0 then
      select points_balance into v_balance from public.customers
        where id = v_old_customer_id for update;
      v_points_delta := least(v_points_earned_old, greatest(coalesce(v_balance, 0), 0));
      if v_points_delta > 0 then
        insert into public.customer_points_ledger
          (shop_id, customer_id, sale_id, delta_points, reason, note, created_by)
          values (v_shop_id, v_old_customer_id, p_sale_id, -v_points_delta,
                  'adjustment', 'sale reassigned to another customer', auth.uid());
      end if;
    end if;
    if p_customer_id is not null and v_points_earned_new > 0 then
      insert into public.customer_points_ledger
        (shop_id, customer_id, sale_id, delta_points, reason, points_per_usd, note, created_by)
        values (v_shop_id, p_customer_id, p_sale_id, v_points_earned_new, 'adjustment',
                v_rate_used, 'sale reassigned to this customer', auth.uid());
    end if;
  end if;
end;
$$;

grant execute on function public.edit_sale(uuid, jsonb, jsonb, text, text, text, integer, uuid, boolean) to authenticated;
