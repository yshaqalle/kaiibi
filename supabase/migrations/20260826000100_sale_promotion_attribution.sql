-- Which offer took the money off.
--
-- 0013 gave sale_items a discount_cents and stopped there, so the till could
-- say "20% came off" and never "which promotion did it". Every question about
-- whether a sale worked was unanswerable.
--
-- The name is stored beside the id for the same reason product_name sits
-- beside product_id in this table: expiring, renaming, archiving and deleting
-- are four different things an owner does to an old offer, and none of them
-- may touch a sale that already happened. `on delete set null` is the last
-- resort -- the link goes, the name and the money stay.
alter table public.sale_items
  add column promotion_id   uuid references public.promotions(id) on delete set null,
  add column promotion_name text;

create index sale_items_promotion_id_idx on public.sale_items (promotion_id)
  where promotion_id is not null;

-- ── complete_sale ────────────────────────────────────────────────────────
-- Reproduced verbatim from supabase/migrations/20260822000000_registers_and_sessions.sql
-- lines 734-1010, with exactly two edits:
--
--   1. In the `insert into public.sale_items (...)` statement, add
--      `promotion_id, promotion_name` to the column list and
--      `nullif(v_item->>'promotion_id','')::uuid,
--       nullif(v_item->>'promotion_name','')` to the values list.
--
--   2. The manual-discount guard below, added immediately after
--      `v_line_discount := greatest(...)` and again after
--      `v_discount_cents := greatest(...)`.
--
-- The signature does NOT change: attribution rides inside the existing
-- p_items jsonb, so there is no new overload and no new grant.
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
  p_points_redeemed integer default 0,
  p_register_session_id uuid default null
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
  v_session public.register_sessions%rowtype;
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

  -- The session, when the client sent one. Validated rather than trusted: a
  -- sale filed against a closed session would land in a drawer count somebody
  -- has already signed off, and one filed against another branch's session
  -- would put the money in the wrong till.
  if p_register_session_id is not null then
    select * into v_session from public.register_sessions where id = p_register_session_id;
    if v_session.id is null then
      raise exception 'register session % not found', p_register_session_id;
    end if;
    if v_session.shop_id <> p_shop_id then
      raise exception 'register session % does not belong to shop %', p_register_session_id, p_shop_id;
    end if;
    if v_session.location_id <> v_location_id then
      raise exception 'register session % is at a different location than this sale', p_register_session_id;
    end if;
    if v_session.closed_at is not null then
      raise exception 'register session % is already closed', p_register_session_id;
    end if;
  end if;

  -- A branch that requires an open register means it: without this the setting
  -- is advisory, and the client is the party it is meant to constrain. Read off
  -- the resolved location, so turning it on at one branch never stops another
  -- selling.
  if p_register_session_id is null
     and (select require_open_register from public.shop_locations where id = v_location_id) then
    raise exception 'this store requires an open register before a sale can be rung up';
  end if;

  v_primary_method := p_payments->0->>'method';
  if v_primary_method not in ('cash','zaad','edahab','other') then
    raise exception 'invalid payment method %', v_primary_method;
  end if;

  select tax_enabled, tax_rate_percent,
         loyalty_enabled, loyalty_points_per_usd, loyalty_cents_per_point
    into v_tax_enabled, v_tax_rate,
         v_loyalty_enabled, v_points_per_usd, v_cents_per_point
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

  insert into public.sales (shop_id, location_id, created_by, payment_method, customer_name, customer_phone, customer_email, cashier_name, discount_cents, customer_id, created_at, register_session_id)
    values (p_shop_id, v_location_id, auth.uid(), v_primary_method, nullif(p_customer_name, ''), nullif(p_customer_phone, ''), nullif(p_customer_email, ''), nullif(p_cashier_name, ''), v_discount_cents, p_customer_id, coalesce(p_created_at, now()), p_register_session_id)
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
    -- A line discount with no promotion behind it is a cashier typing a
    -- number, which is the one discount path nothing has ever recorded or
    -- restricted. Anyone may APPLY an offer; entering your own amount is a
    -- separate permission.
    if v_line_discount > 0
       and nullif(v_item->>'promotion_id','') is null
       and not public.has_shop_permission(p_shop_id, 'discounts.manual') then
      raise exception 'not authorized to enter a manual discount';
    end if;
    v_line := v_product.price_cents * v_qty - v_line_discount;
    if v_line < 0 then
      raise exception 'discount exceeds line total for %', v_product.name;
    end if;

    update public.product_location_stock set stock = stock - v_qty, updated_at = now()
      where product_id = v_product.id and location_id = v_location_id;

    insert into public.sale_items (sale_id, product_id, product_name, unit_price_cents, quantity, line_total_cents, discount_cents, unit_cost_cents, promotion_id, promotion_name)
      values (v_sale_id, v_product.id, v_product.name, v_product.price_cents, v_qty, v_line, v_line_discount, v_product.cost_cents, nullif(v_item->>'promotion_id','')::uuid, nullif(v_item->>'promotion_name',''));

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
    if v_points_redeemed > v_balance then
      raise exception 'customer has % points, cannot redeem %', v_balance, v_points_redeemed;
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

  if v_discount_cents > 0
     and not public.has_shop_permission(p_shop_id, 'discounts.manual') then
    raise exception 'not authorized to enter a manual discount';
  end if;

  return v_sale_id;
end;
$$;

-- ── edit_sale ────────────────────────────────────────────────────────────
-- Reproduced verbatim from supabase/migrations/20260820000100_loyalty_balance_rules.sql
-- lines 405-660, with the same two edits, plus one more:
--
--   3. The v_snapshot jsonb_build_object for 'items' gains
--      'promotion_id', si.promotion_id, 'promotion_name', si.promotion_name
--      so editing a sale does not silently drop which offer applied.
--
-- edit_sale resolves the shop as v_shop_id rather than p_shop_id -- use
-- v_shop_id in both permission checks here.
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
    -- A line discount with no promotion behind it is a cashier typing a
    -- number, which is the one discount path nothing has ever recorded or
    -- restricted. Anyone may APPLY an offer; entering your own amount is a
    -- separate permission.
    if v_line_discount > 0
       and nullif(v_item->>'promotion_id','') is null
       and not public.has_shop_permission(v_shop_id, 'discounts.manual') then
      raise exception 'not authorized to enter a manual discount';
    end if;
    v_line := v_product.price_cents * v_qty - v_line_discount;
    if v_line < 0 then
      raise exception 'discount exceeds line total for %', v_product.name;
    end if;

    update public.product_location_stock set stock = stock - v_qty, updated_at = now()
      where product_id = v_product.id and location_id = v_location_id;

    insert into public.sale_items (sale_id, product_id, product_name, unit_price_cents, quantity, line_total_cents, discount_cents, unit_cost_cents, promotion_id, promotion_name)
      values (p_sale_id, v_product.id, v_product.name, v_product.price_cents, v_qty, v_line, v_line_discount, v_product.cost_cents, nullif(v_item->>'promotion_id','')::uuid, nullif(v_item->>'promotion_name',''));

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

-- ── delete-or-archive has to be decided in here, not in the client ────────
-- Task 2 put this decision in deletePromotion(), which counts sale_items from
-- the browser. That count is subject to RLS: reading sale_items needs
-- sales.view or dashboard.view (0024), while reaching the promotions editor at
-- all needs only settings.access, and IMPLIED_PERMISSIONS joins neither to the
-- other. So the role most likely to be managing promotions sees a count of
-- zero for a promotion that HAS been used, and hard-deletes it -- silently
-- doing the exact thing the archive branch exists to prevent.
--
-- Security definer moves the count somewhere RLS cannot lie to it, and doing
-- both steps in one statement closes the window where a sale lands between the
-- count and the delete.
create or replace function public.delete_or_archive_promotion(p_id uuid)
returns text
language plpgsql security definer set search_path = public as $$
declare
  v_shop_id uuid;
  v_used boolean;
begin
  select shop_id into v_shop_id from public.promotions where id = p_id;
  if v_shop_id is null then
    raise exception 'promotion % not found', p_id;
  end if;
  -- The same gate the table's own write policy uses (0024). Security definer
  -- bypasses RLS, so this function must re-assert what RLS would have.
  if not public.has_shop_permission(v_shop_id, 'settings.access') then
    raise exception 'not authorized for shop %', v_shop_id;
  end if;

  select exists (select 1 from public.sale_items where promotion_id = p_id) into v_used;

  if v_used then
    update public.promotions set archived_at = now() where id = p_id;
    return 'archived';
  end if;

  delete from public.promotions where id = p_id;
  return 'deleted';
end;
$$;

grant execute on function public.delete_or_archive_promotion(uuid) to authenticated;

-- ── grant the new permission to every role that can already discount ──────
-- Nothing a shop currently does may stop working. Every role holding
-- pos.access is granted discounts.manual, which is exactly the set of people
-- who can reach the discount editor today. An owner narrows it deliberately
-- from Settings after this lands.
update public.roles
   set permissions = array_append(permissions, 'discounts.manual')
 where 'pos.access' = any(permissions)
   and not ('discounts.manual' = any(permissions));

update public.roles
   set permissions = array_append(permissions, 'discounts.apply')
 where 'pos.access' = any(permissions)
   and not ('discounts.apply' = any(permissions));
