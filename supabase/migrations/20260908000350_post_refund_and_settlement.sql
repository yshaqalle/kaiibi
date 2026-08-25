-- Refunds and balance settlements write their journal entry, in the same
-- transaction that writes the refund or the payment.
--
-- Both functions are reproduced IN FULL from 20260831000200_refund_goods_not_cash.sql
-- with a posting block added and nothing else changed. Verified against
-- 20260905000000_complete_sale_lock_order.sql, which patches functions by
-- substituting pg_proc.prosrc at runtime and therefore leaves its fix in no
-- migration text at all: that migration names only complete_sale and edit_sale,
-- so neither function below carries a live fix that copying forward would
-- silently revert.
--
-- ## Why a refund is not the sale's mirror image
--
-- kaiibi's refunds return GOODS, not cash, by default -- that is the whole
-- point of 20260831000200's goods_cents/total_cents split. Refunding a $100
-- sale nobody has paid a cent on must not take $100 out of the drawer. So the
-- entry has to say two things at once: what came back, and what was handed
-- over. They are the same figure on a sale paid in full and different on every
-- credit sale.
--
--   Dr 4100 Sales Returns      the merchandise coming back, net of tax
--   Dr 2100 Sales Tax Payable  the tax share coming back
--   Cr 1000/1010/1020/1021     the CASH actually handed over  (v_total_cents)
--   Cr 1100 Accounts Receivable the rest, which reduces what is still owed
--   Dr 1200 Inventory          the cost of the goods coming back
--   Cr 5000 Cost of Goods Sold the same
--
-- The two credit lines are the generalisation of "cash if it was paid,
-- receivable if it was not", and they are why the entry balances on a sale that
-- was PARTLY paid -- the case a straight if/else gets wrong in both directions.
-- $100 on credit with $40 collected, all the goods back: Cr cash 40, Cr
-- receivable 60. An if/else on "is anything still owed" would post the whole
-- 100 to one of them, either paying out $60 the shop never took or driving the
-- customer's balance to -40. v_total_cents is already `least(goods, collected -
-- already refunded in cash)`, so the split falls straight out of it and each
-- line is zero exactly when it should be omitted.
--
-- ## Why 4100 and not a negative 4000
--
-- A refund that reduced Sales Revenue would make a month's revenue depend on
-- when the return happened rather than when the sale did, and the Discounts &
-- Refunds report would have nothing to read. Returns are a contra-revenue
-- account for exactly this reason -- 20260904000100 seeds 4100 Sales Returns as
-- `is_contra`.
--
-- ## Why the tax is prorated rather than recomputed
--
-- The tax coming back is this refund's share of the tax the customer actually
-- paid, not `refund x today's rate`. The shop's tax_rate_percent may have
-- changed since the sale, and the customer is owed what they paid.
--
-- ## Why the cost is the FROZEN one
--
-- sale_items.unit_cost_cents, never products.cost_cents. The goods returning
-- are the goods that left; re-reading today's cost would rewrite the sale's
-- gross profit every time the shop restocked. Uncosted lines contribute
-- nothing rather than zero, the same distinction complete_sale draws.
--
-- ## A settlement posts no revenue
--
-- The revenue was recognised when the sale was rung up, and the receivable is
-- what recorded it. Recognising it again when the money arrives is the classic
-- double-count. So the entry is only ever `Dr cash / Cr 1100`, one per
-- instalment, dated when that instalment arrived -- lumping several settlements
-- into one entry would date the whole thing on the last payment.
--
-- ## Dates and sources
--
-- Both use public.shop_local_date(). Never now()::date, which resolves in the
-- session's timezone -- UTC on Supabase -- while every market kaiibi serves is
-- UTC+3, so a late-night refund would post to the wrong month and, once that
-- month closes, permanently.
--
-- Both pass an explicit p_source ('refund', 'settlement'), never 'manual'.
-- post_journal_entry gates only the manual source on ledger.post, and a cashier
-- holds sales.refund or pos.access and must not need a ledger permission to do
-- their job.

-- ── refund_sale_items ─────────────────────────────────────────────────────
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
  -- The posting side. All new in this migration.
  --
  -- The sale's tax, read alongside its total so the tax share coming back can
  -- be prorated from what the customer ACTUALLY paid rather than recomputed at
  -- today's rate.
  v_sale_tax_cents integer;
  -- Which tender the cash goes back out of. Read from sale_payments, not from
  -- sales.payment_method -- see where it is assigned.
  v_sale_method text;
  -- bigint, matching complete_sale: quantity x unit cost over a large refund
  -- can exceed integer, and post_journal_entry takes the amounts as jsonb
  -- numbers anyway.
  v_cogs_back bigint;
  v_tax_back integer;
  v_receivable_back integer;
  v_lines jsonb;
  v_entry_id uuid;
begin
  select shop_id, location_id, customer_id, points_earned, points_redeemed, total_cents, tax_cents
    into v_shop_id, v_location_id, v_customer_id, v_points_earned, v_points_redeemed, v_sale_total_cents, v_sale_tax_cents
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
  v_sale_tax_cents := coalesce(v_sale_tax_cents, 0);
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

  -- ── The posting side ──────────────────────────────────────────────────────
  --
  -- Below the update above, deliberately: v_goods_cents and v_total_cents are
  -- the two figures the entry is built from and the refund row is not correct
  -- until they are on it. Inside the same transaction, equally deliberately --
  -- a refund that is recorded but not posted is a books-that-do-not-tie bug
  -- that surfaces at month end with no way to find which refund it was.

  -- The cost of what physically came back, at the price frozen on the original
  -- sale line. Not today's cost: the goods returning are the goods that left,
  -- and re-reading products.cost_cents would rewrite the sale's gross profit
  -- every time the shop restocked. Uncosted lines contribute nothing rather
  -- than zero -- a free sample really does cost nothing, an unpriced product is
  -- a question nobody answered. (sum() ignores nulls anyway; the filter states
  -- the intent for the next reader.)
  select coalesce(sum(si.unit_cost_cents::bigint * ri.quantity), 0)
    into v_cogs_back
    from public.refund_items ri
    join public.sale_items si on si.id = ri.sale_item_id
   where ri.refund_id = v_refund_id and si.unit_cost_cents is not null;

  -- Tax comes back in the same proportion the money does. Computed from this
  -- refund's share of what the customer PAID rather than by re-deriving the
  -- rate: shops.tax_rate_percent may have changed since the sale, and the
  -- customer is owed the tax they actually handed over.
  --
  -- Prorated on v_goods_cents, the VALUE returned, not v_total_cents, the cash:
  -- returning goods on a credit sale reduces the tax the shop owes whether or
  -- not any money went back.
  if v_sale_total_cents > 0 then
    v_tax_back := round(v_goods_cents::numeric * v_sale_tax_cents / v_sale_total_cents)::integer;
  else
    v_tax_back := 0;
  end if;

  v_lines := '[]'::jsonb;

  -- 4100 Sales Returns, a contra-revenue account -- never a negative 4000. A
  -- refund that reduced Sales Revenue would make a month's revenue depend on
  -- when the return happened rather than when the sale did, and the Discounts &
  -- Refunds report would have nothing to read.
  if (v_goods_cents - v_tax_back) <> 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'code', '4100', 'amount_cents', v_goods_cents - v_tax_back, 'memo', 'Goods returned'));
  end if;

  if v_tax_back > 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'code', '2100', 'amount_cents', v_tax_back, 'memo', 'Tax on the return'));
  end if;

  -- The credit side, split rather than branched.
  --
  -- v_total_cents is the cash actually leaving the drawer and the remainder is
  -- what the customer no longer owes, and the two always sum to v_goods_cents
  -- -- so the entry balances on a sale that was PARTLY paid, which is the case
  -- an if/else on "is anything still owed" gets wrong in both directions. On a
  -- sale paid in full the receivable line is zero and omitted; on one nobody
  -- has paid, the cash line is.
  if v_total_cents > 0 then
    -- Which tender it goes back out of. Read from the sale's PAYMENTS, not from
    -- sales.payment_method: that column reads 'unpaid' until money arrives and
    -- account_code_for_payment_method raises on it, so a refund against a
    -- part-paid credit sale would die on the mapping rather than post. The
    -- method that brought the most in is the one it goes back out of, which is
    -- what the drawer sees happen. Guaranteed to find a row: v_total_cents > 0
    -- requires v_collected_cents > 0.
    select sp.method into v_sale_method
      from public.sale_payments sp
     where sp.sale_id = p_sale_id
     group by sp.method
     order by sum(sp.amount_cents) desc, sp.method
     limit 1;

    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'code', public.account_code_for_payment_method(v_sale_method),
      'amount_cents', -v_total_cents, 'memo', 'Refunded'));
  end if;

  v_receivable_back := v_goods_cents - v_total_cents;
  if v_receivable_back > 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'code', '1100', 'amount_cents', -v_receivable_back, 'memo', 'Reduced what is owed'));
  end if;

  -- Omitted entirely when zero, not posted as a zero pair: journal_lines
  -- carries check (amount_cents <> 0), so a zero line fails the whole refund.
  if v_cogs_back > 0 then
    v_lines := v_lines || jsonb_build_array(
      jsonb_build_object('code', '1200', 'amount_cents',  v_cogs_back, 'memo', 'Stock returned'),
      jsonb_build_object('code', '5000', 'amount_cents', -v_cogs_back, 'memo', 'Cost reversed'));
  end if;

  -- A refund can move nothing at all: an already fully-refunded sale, or one
  -- whose lines were entirely discounted away, with no costed items. There is
  -- then no entry to post, and post_journal_entry would refuse an empty one
  -- with "A journal entry needs at least two lines" -- an error about the
  -- ledger for a refund that is simply a no-op in money terms.
  if jsonb_array_length(v_lines) > 0 then
    -- shop_local_date(), never now()::date: that resolves in the session's
    -- timezone, UTC on Supabase, and Somalia is UTC+3 -- so a refund at 01:30
    -- local on the 1st posts into the previous month, permanently once that
    -- month closes.
    --
    -- The description names both rows, so the journal is readable in both
    -- directions -- refunds.journal_entry_id gets you one way, and a journals
    -- list of four hundred rows all reading 'Refund' names no refund at all.
    --
    -- p_source => 'refund', never 'manual'. post_journal_entry gates only the
    -- manual source on ledger.post, and a cashier holds sales.refund.
    v_entry_id := public.post_journal_entry(
      v_shop_id,
      public.shop_local_date(),
      'Refund ' || v_refund_id::text || ' on sale ' || p_sale_id::text,
      v_lines,
      v_location_id,
      'refund');

    update public.refunds set journal_entry_id = v_entry_id where id = v_refund_id;
  end if;
  -- ── end posting side ──────────────────────────────────────────────────────

  return v_refund_id;
end;
$$;

grant execute on function public.refund_sale_items(uuid, jsonb) to authenticated;

-- ── settle_sale_balance ───────────────────────────────────────────────────
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
  -- The posting side. All new in this migration.
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
    v_entry_id := public.post_journal_entry(
      v_sale.shop_id,
      public.shop_local_date(),
      'Balance settled on sale ' || p_sale_id::text,
      jsonb_build_array(
        jsonb_build_object('code', public.account_code_for_payment_method(v_method),
                           'amount_cents',  v_amount, 'memo', 'Settlement received'),
        jsonb_build_object('code', '1100', 'amount_cents', -v_amount, 'memo', 'Cleared from receivables')),
      v_sale.location_id,
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
