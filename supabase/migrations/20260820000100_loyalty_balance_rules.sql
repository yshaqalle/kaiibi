-- Two corrections to how a points balance behaves, both learned by looking at
-- what the first cut actually does to a real customer.
--
-- ## 1. A BALANCE NEVER GOES NEGATIVE
--
-- 20260820000000 deliberately allowed it: a refund claws back the points the
-- sale earned, and if the customer had already spent them the balance went
-- below zero, which was defended as "the honest record of what happened".
--
-- It is honest and it is still wrong, for two reasons. A customer opening the
-- app to see MINUS twenty points has been handed a debt they never agreed to,
-- for a refund the shop chose to give them; and the balance is now a number the
-- shop cannot explain at the counter without a lecture about clawbacks. The
-- shop absorbs the difference, which is what every other loyalty scheme does
-- and what the shop would have done instinctively anyway.
--
-- So every negative movement is clamped to what is actually there. The clamp
-- reads the balance under the same `for update` lock a redemption takes, so a
-- concurrent spend cannot slip between the read and the write.
--
-- ORDERING CHANGED WITH IT, and this is the part that matters more than the
-- clamp. A full refund of a sale that redeemed points does two things: it gives
-- back the points that were spent, and it takes back the points that were
-- earned. Done in that order the customer nets out exactly right. Done the
-- other way round -- which is what the original did -- the clawback hits an
-- empty balance first, gets clamped to nothing, and then the reversal lands on
-- top, quietly handing the customer points the shop meant to reclaim. Give back
-- first, take back second.
--
-- ## 2. EARNED POINTS MATURE BEFORE THEY CAN BE SPENT
--
-- loyalty_points_available_after_days, default 1. Points earned on a sale are
-- visible immediately and spendable a day later.
--
-- Without it the cycle is: buy, earn, immediately spend the new points on the
-- next basket, then return the first basket. The clawback above now cannot go
-- negative, so the shop eats it every time -- the two changes in this migration
-- would combine into a hole if the second did not exist. A day is enough to
-- break that loop without being felt by an honest customer, who is not coming
-- back within the hour to spend eleven cents.
--
-- AVAILABILITY IS DERIVED, NOT STORED. customers.points_balance stays exactly
-- what it is -- the full counter, and the row a redemption locks. What is
-- spendable is that balance minus whatever was EARNED inside the window, which
-- is one indexed read on (customer_id, created_at desc), an index this schema
-- already has. Storing a second counter would mean a scheduled job to mature
-- points, and a balance that is wrong until the job runs.
--
-- Only `earn` rows wait. A reversal returns points the customer had already
-- held through the window, and a manual adjustment is someone deciding to grant
-- them -- neither should be made to sit again.

-- ---------------------------------------------------------------------------
-- The maturing window, and the balance comment 20260820000000 got wrong.
-- ---------------------------------------------------------------------------

alter table public.shops
  add column if not exists loyalty_points_available_after_days integer not null default 1
    check (loyalty_points_available_after_days >= 0);

comment on column public.shops.loyalty_points_available_after_days is
  'How long points earned on a sale must wait before they can be spent, in
   days. Default 1. Zero makes them spendable the moment they are earned, which
   re-opens the earn-spend-refund loop -- see the header of
   20260820000100_loyalty_balance_rules.sql.';

comment on column public.customers.points_balance is
  'Trigger-maintained sum of customer_points_ledger.delta_points, and the row a
   redemption locks. Never negative: every clawback is clamped to what is
   actually there. NOT the spendable figure -- points earned inside the shop''s
   maturing window are counted here but cannot yet be redeemed, which is what
   public.customer_points_available() returns.';

-- ---------------------------------------------------------------------------
-- What a customer can actually spend right now.
--
-- Read-only and stable within a statement, so the POS can call it when a
-- customer is attached and clamp the input box. complete_sale recomputes it
-- under the row lock regardless -- this is for the cashier's benefit, never for
-- the arithmetic.
-- ---------------------------------------------------------------------------

create or replace function public.customer_points_available(p_customer_id uuid)
returns integer
language plpgsql stable security definer set search_path = public as $$
declare
  v_shop_id uuid;
  v_balance integer;
  v_grace_days integer;
  v_pending integer;
begin
  select c.shop_id, c.points_balance into v_shop_id, v_balance
    from public.customers c where c.id = p_customer_id;
  if v_shop_id is null then
    return 0;
  end if;
  -- Same permission surface as reading the customer at all.
  if not public.has_any_shop_permission(v_shop_id, array['customers.view', 'pos.access', 'sales.view']) then
    raise exception 'not authorized for customer %', p_customer_id;
  end if;

  select s.loyalty_points_available_after_days into v_grace_days
    from public.shops s where s.id = v_shop_id;

  select coalesce(sum(l.delta_points), 0) into v_pending
    from public.customer_points_ledger l
   where l.customer_id = p_customer_id
     and l.reason = 'earn'
     and l.created_at > now() - make_interval(days => coalesce(v_grace_days, 0));

  return greatest(coalesce(v_balance, 0) - v_pending, 0);
end;
$$;

grant execute on function public.customer_points_available(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- complete_sale: a redemption now spends AVAILABLE points, not the raw balance.
-- Reproduced whole per the house convention; the delta is the maturing check.
-- ---------------------------------------------------------------------------

create or replace function public.complete_sale(
  p_shop_id uuid,
  p_items jsonb,
  p_payments jsonb,
  p_customer_name text default null,
  p_customer_phone text default null,
  p_customer_email text default null,
  p_cashier_name text default null,
  p_discount_cents integer default 0,
  p_customer_id uuid default null,
  p_created_at timestamptz default null,
  p_location_id uuid default null,
  p_points_redeemed integer default 0
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_sale_id uuid;
  v_location_id uuid;
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
  v_primary_method text;
  v_discount_cents integer := greatest(coalesce(p_discount_cents, 0), 0);
  v_tax_enabled boolean;
  v_tax_rate numeric;
  v_tax_cents integer := 0;
  v_loyalty_enabled boolean;
  v_points_per_usd numeric;
  v_cents_per_point integer;
  v_loyalty_active boolean := false;
  v_points_redeemed integer := greatest(coalesce(p_points_redeemed, 0), 0);
  v_redeem_cents integer := 0;
  v_balance integer;
  v_points_earned integer := 0;
  v_grace_days integer;
  v_pending_points integer;
  v_points_available integer;
begin
  if not public.has_shop_permission(p_shop_id, 'pos.access') then
    raise exception 'not authorized for shop %', p_shop_id;
  end if;
  if p_payments is null or jsonb_array_length(p_payments) = 0 then
    raise exception 'at least one payment is required';
  end if;

  if p_location_id is null then
    select l.id into v_location_id from public.shop_locations l
      where l.shop_id = p_shop_id
      order by l.is_primary desc, l.created_at asc
      limit 1;
    if v_location_id is null then
      raise exception 'shop % has no location to record this sale against', p_shop_id;
    end if;
  else
    select l.id into v_location_id from public.shop_locations l
      where l.id = p_location_id and l.shop_id = p_shop_id;
    if v_location_id is null then
      raise exception 'location % does not belong to shop %', p_location_id, p_shop_id;
    end if;
    if not public.can_access_location(v_location_id) then
      raise exception 'not authorized for location %', p_location_id;
    end if;
  end if;

  v_primary_method := p_payments->0->>'method';
  if v_primary_method not in ('cash','zaad','edahab','other') then
    raise exception 'invalid payment method %', v_primary_method;
  end if;

  select tax_enabled, tax_rate_percent,
         loyalty_enabled, loyalty_points_per_usd, loyalty_cents_per_point,
         loyalty_points_available_after_days
    into v_tax_enabled, v_tax_rate,
         v_loyalty_enabled, v_points_per_usd, v_cents_per_point,
         v_grace_days
    from public.shops where id = p_shop_id;

  -- The module check is not belt and braces. public.customers and
  -- customer_points_ledger both carry enforce_shop_module('customers') as a
  -- BEFORE trigger, and security definer does not bypass a trigger -- so
  -- touching either on a lapsed shop would raise module_not_included and refuse
  -- the whole sale. A shop that stops paying must still be able to sell.
  v_loyalty_active := coalesce(v_loyalty_enabled, false)
    and p_customer_id is not null
    and public.shop_has_module(p_shop_id, 'customers');

  if v_points_redeemed > 0 and not v_loyalty_active then
    raise exception 'loyalty points cannot be redeemed on this sale';
  end if;

  insert into public.sales (shop_id, location_id, created_by, payment_method, customer_name, customer_phone, customer_email, cashier_name, discount_cents, customer_id, created_at)
    values (p_shop_id, v_location_id, auth.uid(), v_primary_method, nullif(p_customer_name, ''), nullif(p_customer_phone, ''), nullif(p_customer_email, ''), nullif(p_cashier_name, ''), v_discount_cents, p_customer_id, coalesce(p_created_at, now()))
    returning id into v_sale_id;

  for v_item in select * from jsonb_array_elements(p_items) loop
    v_qty := (v_item->>'quantity')::integer;
    if v_qty is null or v_qty <= 0 then
      raise exception 'invalid quantity in cart item';
    end if;

    select * into v_product from public.products
      where id = (v_item->>'product_id')::uuid and shop_id = p_shop_id;

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
    v_line := v_product.price_cents * v_qty - v_line_discount;
    if v_line < 0 then
      raise exception 'discount exceeds line total for %', v_product.name;
    end if;

    update public.product_location_stock set stock = stock - v_qty, updated_at = now()
      where product_id = v_product.id and location_id = v_location_id;

    insert into public.sale_items (sale_id, product_id, product_name, unit_price_cents, quantity, line_total_cents, discount_cents, unit_cost_cents)
      values (v_sale_id, v_product.id, v_product.name, v_product.price_cents, v_qty, v_line, v_line_discount, v_product.cost_cents);

    v_gross_cents := v_gross_cents + v_line;
    v_item_count := v_item_count + v_qty;
  end loop;

  if v_item_count = 0 then
    raise exception 'cannot complete a sale with no items';
  end if;

  v_total_cents := v_gross_cents - v_discount_cents;
  if v_total_cents < 0 then
    raise exception 'discount exceeds sale total';
  end if;

  if v_points_redeemed > 0 then
    -- The lock that makes the balance check atomic across two registers. Taken
    -- on the counter rather than by summing the ledger, for the reason
    -- shop_usage_counters gives: a sum is neither O(1) nor safe under
    -- concurrency -- both tills read the same balance and both pass.
    select points_balance into v_balance from public.customers
      where id = p_customer_id and shop_id = p_shop_id
      for update;
    if v_balance is null then
      raise exception 'customer % not found in this shop', p_customer_id;
    end if;

    -- Only points that have finished maturing can be spent. Computed inside
    -- the lock so a redemption cannot race a sale that is still earning, and
    -- restricted to `earn` rows -- a reversal or a manual grant is not made to
    -- wait again. The points THIS sale is about to earn are written further
    -- down, so they correctly play no part in its own redemption.
    select coalesce(sum(l.delta_points), 0) into v_pending_points
      from public.customer_points_ledger l
     where l.customer_id = p_customer_id
       and l.reason = 'earn'
       and l.created_at > now() - make_interval(days => coalesce(v_grace_days, 0));
    v_points_available := greatest(v_balance - v_pending_points, 0);

    if v_points_redeemed > v_points_available then
      -- Reported as balance-minus-available rather than the raw sum of earn
      -- rows in the window: spends and clawbacks have already reduced the
      -- balance, so the raw figure can exceed it and read as nonsense ("160 of
      -- 70 still maturing"). This way available + on-hold always equals the
      -- balance the customer can see.
      if v_balance > v_points_available then
        raise exception 'customer has % points available to spend (% of % still maturing), cannot redeem %',
          v_points_available, v_balance - v_points_available, v_balance, v_points_redeemed;
      else
        raise exception 'customer has % points, cannot redeem %', v_points_available, v_points_redeemed;
      end if;
    end if;

    v_redeem_cents := v_points_redeemed * v_cents_per_point;

    -- Raise rather than clamp. The client has already collected payment against
    -- a total computed with this redemption, so quietly spending fewer points
    -- would leave the payments short and fail the equality check below with a
    -- message that names neither the cause nor the fix.
    if v_redeem_cents > v_total_cents then
      raise exception 'redeeming % points is worth % cents, more than the % cents owed',
        v_points_redeemed, v_redeem_cents, v_total_cents;
    end if;

    v_total_cents := v_total_cents - v_redeem_cents;
  end if;

  -- Earned on merchandise actually paid for in money: after every discount
  -- including the redemption, and before tax. Rounded to the nearest whole
  -- point, so $19.99 earns 20.
  if v_loyalty_active then
    v_points_earned := round(v_total_cents * v_points_per_usd / 100)::integer;
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
        v_sale_id,
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

  if v_payments_total <> v_total_cents then
    raise exception 'payments total % does not match sale total %', v_payments_total, v_total_cents;
  end if;

  update public.sales set
    total_cents = v_total_cents,
    item_count = v_item_count,
    tax_cents = v_tax_cents,
    tax_rate_percent = case when v_tax_enabled then v_tax_rate else null end,
    points_redeemed = v_points_redeemed,
    points_redeemed_cents = v_redeem_cents,
    points_earned = v_points_earned,
    loyalty_points_per_usd = case when v_loyalty_active then v_points_per_usd else null end
  where id = v_sale_id;

  -- Two rows, never one net row. "Spent 200, earned 3" is what a customer
  -- querying their balance needs to see; a net -197 hides both facts and
  -- answers no question anyone actually asks.
  --
  -- Written after the payments check, so a sale that gets refused moves no
  -- points.
  if v_points_redeemed > 0 then
    insert into public.customer_points_ledger
      (shop_id, customer_id, sale_id, delta_points, reason, cents_per_point, created_by)
      values (p_shop_id, p_customer_id, v_sale_id, -v_points_redeemed, 'redeem',
              v_cents_per_point, auth.uid());
  end if;
  if v_points_earned > 0 then
    insert into public.customer_points_ledger
      (shop_id, customer_id, sale_id, delta_points, reason, points_per_usd, created_by)
      values (p_shop_id, p_customer_id, v_sale_id, v_points_earned, 'earn',
              v_points_per_usd, auth.uid());
  end if;

  return v_sale_id;
end;
$$;

grant execute on function public.complete_sale(uuid, jsonb, jsonb, text, text, text, text, integer, uuid, timestamptz, uuid, integer) to authenticated;

grant execute on function public.complete_sale(uuid, jsonb, jsonb, text, text, text, text, integer, uuid, timestamptz, uuid, integer) to authenticated;

-- ---------------------------------------------------------------------------
-- edit_sale: negative adjustments clamped.
-- ---------------------------------------------------------------------------

create or replace function public.edit_sale(
  p_sale_id uuid,
  p_items jsonb,
  p_payments jsonb,
  p_customer_name text default null,
  p_customer_phone text default null,
  p_customer_email text default null,
  p_discount_cents integer default 0,
  p_customer_id uuid default null
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
  if p_items is null or jsonb_array_length(p_items) = 0 then
    raise exception 'a sale must have at least one item';
  end if;
  if p_payments is null or jsonb_array_length(p_payments) = 0 then
    raise exception 'at least one payment is required';
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
        'unit_cost_cents', si.unit_cost_cents
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

  delete from public.sale_items where sale_id = p_sale_id;
  delete from public.sale_payments where sale_id = p_sale_id;

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
    v_line := v_product.price_cents * v_qty - v_line_discount;
    if v_line < 0 then
      raise exception 'discount exceeds line total for %', v_product.name;
    end if;

    update public.product_location_stock set stock = stock - v_qty, updated_at = now()
      where product_id = v_product.id and location_id = v_location_id;

    insert into public.sale_items (sale_id, product_id, product_name, unit_price_cents, quantity, line_total_cents, discount_cents, unit_cost_cents)
      values (p_sale_id, v_product.id, v_product.name, v_product.price_cents, v_qty, v_line, v_line_discount, v_product.cost_cents);

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

  if v_payments_total <> v_total_cents then
    raise exception 'payments total % does not match sale total %', v_payments_total, v_total_cents;
  end if;

  update public.sales set
    total_cents = v_total_cents,
    item_count = v_item_count,
    payment_method = p_payments->0->>'method',
    customer_name = nullif(p_customer_name, ''),
    customer_phone = nullif(p_customer_phone, ''),
    customer_email = nullif(p_customer_email, ''),
    customer_id = p_customer_id,
    discount_cents = v_discount_cents,
    tax_cents = v_tax_cents,
    tax_rate_percent = case when v_tax_enabled then v_tax_rate else null end,
    points_earned = v_points_earned_new,
    loyalty_points_per_usd = case when v_points_earned_new > 0 then v_rate_used else null end
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

-- ---------------------------------------------------------------------------
-- delete_sale: reversal first, clamped clawback second.
-- ---------------------------------------------------------------------------

create or replace function public.delete_sale(p_sale_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_shop_id uuid;
  v_location_id uuid;
  v_item record;
  v_customer_id uuid;
  v_points_earned integer;
  v_points_redeemed integer;
  v_balance integer;
  v_clawback integer;
begin
  select shop_id, location_id, customer_id, points_earned, points_redeemed
    into v_shop_id, v_location_id, v_customer_id, v_points_earned, v_points_redeemed
    from public.sales where id = p_sale_id;
  if v_shop_id is null then
    raise exception 'sale % not found', p_sale_id;
  end if;
  if not public.has_shop_permission(v_shop_id, 'sales.edit') then
    raise exception 'not authorized for sale %', p_sale_id;
  end if;

  for v_item in select product_id, quantity from public.sale_items where sale_id = p_sale_id loop
    if v_item.product_id is not null then
      insert into public.product_location_stock (product_id, location_id, stock)
        values (v_item.product_id, v_location_id, v_item.quantity)
        on conflict (product_id, location_id)
        do update set stock = public.product_location_stock.stock + excluded.stock, updated_at = now();
    end if;
  end loop;

  -- sale_id is deliberately left null on these rows: the sale they would point
  -- at is about to stop existing.
  --
  -- Redeemed points are returned before earned points are taken back, for the
  -- same reason refund_sale_items does it in that order -- reversing the two
  -- would let the clamp swallow the clawback and then hand the points back.
  if v_customer_id is not null and public.shop_has_module(v_shop_id, 'customers') then
    if coalesce(v_points_redeemed, 0) > 0 then
      insert into public.customer_points_ledger
        (shop_id, customer_id, delta_points, reason, note, created_by)
        values (v_shop_id, v_customer_id, v_points_redeemed, 'adjustment',
                'sale deleted', auth.uid());
    end if;

    if coalesce(v_points_earned, 0) > 0 then
      select points_balance into v_balance from public.customers
        where id = v_customer_id for update;
      v_clawback := least(v_points_earned, greatest(coalesce(v_balance, 0), 0));
      if v_clawback > 0 then
        insert into public.customer_points_ledger
          (shop_id, customer_id, delta_points, reason, note, created_by)
          values (v_shop_id, v_customer_id, -v_clawback, 'adjustment',
                  'sale deleted', auth.uid());
      end if;
    end if;
  end if;

  delete from public.sales where id = p_sale_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- refund_sale_items: give back, then take back -- and never below zero.
-- ---------------------------------------------------------------------------

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
  v_total_cents integer := 0;
  v_customer_id uuid;
  v_points_earned integer;
  v_points_redeemed integer;
  v_sale_gross_cents integer;
  v_prior_refunded_cents integer;
  v_cum_refunded_cents integer;
  v_prior_clawback integer;
  v_cum_clawback integer;
  v_remaining_qty integer;
  v_loyalty_active boolean := false;
  v_clawback integer;
  v_balance integer;
begin
  select shop_id, location_id, customer_id, points_earned, points_redeemed
    into v_shop_id, v_location_id, v_customer_id, v_points_earned, v_points_redeemed
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

  -- Read before the new refund row exists, so this is strictly what earlier
  -- refunds took.
  select coalesce(sum(ri.amount_cents), 0) into v_prior_refunded_cents
    from public.refund_items ri
    join public.refunds r on r.id = ri.refund_id
   where r.sale_id = p_sale_id;
  select coalesce(sum(line_total_cents), 0) into v_sale_gross_cents
    from public.sale_items where sale_id = p_sale_id;

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

    v_total_cents := v_total_cents + v_refund_amount;
  end loop;

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
  if v_loyalty_active and v_points_earned > 0 and v_sale_gross_cents > 0 then
    v_cum_refunded_cents := v_prior_refunded_cents + v_total_cents;
    v_prior_clawback := least(v_points_earned,
      floor(v_points_earned::numeric * v_prior_refunded_cents / v_sale_gross_cents)::integer);
    v_cum_clawback := least(v_points_earned,
      floor(v_points_earned::numeric * v_cum_refunded_cents / v_sale_gross_cents)::integer);
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
