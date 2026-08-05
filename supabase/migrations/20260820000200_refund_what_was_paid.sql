-- A refund returns what the customer actually paid.
--
-- refund_sale_items has always apportioned sale_items.line_total_cents, which
-- is the line's own price net of its own discount -- and nothing else. It knows
-- nothing about the sale's ORDER-level discount, nothing about points redeemed
-- against the whole basket, and nothing about tax, which is charged on top and
-- is not in a line total at all.
--
-- Measured on a $19.99 sale carrying a $2.00 order discount, a 50-point
-- redemption and 5% tax:
--
--     line_total_cents ....... 1999
--     order discount ......... -200
--     points redeemed ........  -50
--     tax .................... + 87
--     ---------------------------------
--     customer paid .......... 1836
--     full refund returned ... 1999      <- 163 too much, 8.9% of the sale
--
-- Two errors pointing opposite ways, which is exactly why it survived this
-- long: the discount over-refunds, the tax under-refunds, they partly cancel,
-- and the number that comes out looks about right. It is not about right. Every
-- discounted sale that comes back costs the shop the discount a second time.
--
-- sales.total_cents is the one figure the customer actually handed over, so
-- that is what a refund apportions. The per-line loop still works in
-- line_total_cents, because that is what establishes the PROPORTION of the sale
-- going back; the money is then scaled to the paid total in one step at the
-- end.
--
-- ## THE CUMULATIVE RULE, AND THE ONE PLACE IT IS DELIBERATELY BROKEN
--
-- The scale is applied cumulatively and then differenced, the same discipline
-- the per-line amounts already use, so refunding a sale in pieces returns
-- exactly what refunding it in one go would: on the last unit the cumulative
-- gross equals the sale's gross, the ratio is exactly 1, and the running total
-- lands on total_cents to the cent.
--
-- The prior PAID figure, though, is read from the stored refund rows and never
-- recomputed. Refunds issued before this migration used the old gross number,
-- and recomputing them would make the next partial refund silently "correct" a
-- refund the customer received months ago -- an adjustment nobody can explain at
-- the counter. The consequence is honest and worth stating: the
-- paid-equals-refunded guarantee holds for sales refunded entirely after this
-- migration, not retroactively. Existing refunds are left exactly as they were.
--
-- ## WHAT IS NOT CHANGED
--
-- Historical refund rows are not backfilled. Those refunds happened, at those
-- amounts, and rewriting them would misstate what was actually paid out.
--
-- sale_items.line_total_cents keeps its current meaning. Allocating order-level
-- reductions onto the lines at sale time would fix this AND the per-line margin
-- figures in reporting, which are overstated for the same reason -- but it
-- changes a stored column, needs a backfill, and touches every reporting path.
-- That is its own piece of work, not a side effect of fixing refunds.
--
-- Points still claw back on the GROSS proportion returned rather than on the
-- scaled money, because points were never earned on the discount or the tax.

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
  v_sale_paid_cents integer;
  v_prior_gross_all integer;
  v_cum_gross_all integer;
  v_prior_paid_cents integer;
  v_cum_paid_cents integer;
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
    into v_shop_id, v_location_id, v_customer_id, v_points_earned, v_points_redeemed, v_sale_paid_cents
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

  -- Prior PAID is what was actually handed over, taken from the stored rows and
  -- never recomputed. Refunds issued before this migration used the old
  -- gross-based figure; recomputing would make the next partial refund quietly
  -- "correct" a refund the customer received months ago.
  select coalesce(sum(r.total_cents), 0) into v_prior_paid_cents
    from public.refunds r where r.sale_id = p_sale_id;

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
    v_cum_paid_cents := round(v_sale_paid_cents::numeric * v_cum_gross_all / v_sale_gross_cents);
  else
    -- A sale whose lines are entirely discounted away: nothing to apportion.
    v_cum_paid_cents := v_prior_paid_cents;
  end if;

  -- Never negative. A sale already over-refunded under the old maths can leave
  -- prior_paid above the cumulative figure; the shop does not claw that back
  -- from the customer on a later return.
  v_total_cents := greatest(v_cum_paid_cents - v_prior_paid_cents, 0);

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

  update public.refunds set total_cents = v_total_cents where id = v_refund_id;
  return v_refund_id;
end;
$$;
