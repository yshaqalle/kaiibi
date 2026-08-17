-- A sale may be left part-paid, on purpose, against a named customer.
--
-- complete_sale has always refused any payments total that did not equal the
-- sale total. That guard is not being removed -- it is the only thing standing
-- between a client that miscounts its own split and a shop that silently
-- writes off the difference. It is being made conditional on an explicit,
-- named intent: p_allow_balance, plus a customer to owe the money.
--
-- Both functions are reproduced VERBATIM from
-- supabase/migrations/20260826000100_sale_promotion_attribution.sql
-- (complete_sale lines 38-390, edit_sale lines 409-774), extracted
-- mechanically rather than retyped, with only the edits listed below.
--
-- Points are earned on money taken, not on goods handed over: a sale left on
-- account earns nothing until it is settled. Otherwise credit plus redemption
-- is a way to take value out of the shop without ever paying for it.
--
-- complete_sale, four edits:
--   1. trailing parameter `p_allow_balance boolean default false`
--   2. the payments guard split into over-payment (always refused) and
--      under-payment (refused unless asked for, against a customer)
--   3. `settled_at` stamped in the closing `update public.sales set ...`
--   4. points zeroed when the sale is not paid in full
--   5. no payments at all is allowed, as credit against a named customer, and
--      payment_method then reads 'unpaid' rather than naming a method that
--      never took anything
--
-- edit_sale, the same five, plus:
--   6. it no longer deletes settlement payments -- see the comment at the
--      delete for why that one matters more than the rest;
--   7. loyalty_points_per_usd is kept whenever loyalty is on rather than only
--      when points were earned, so a credit sale remembers the rate it will
--      earn at once it is paid.
--
-- Both are DROPPED first. `create or replace` with an extra defaulted
-- parameter does not replace anything -- it adds an overload, and every
-- existing 13-argument call would then resolve to two candidates and fail as
-- ambiguous. 0005 set this precedent when complete_sale last changed shape.

-- ── a settlement is not a till payment ────────────────────────────────────
-- Money taken against a sale that was rung up days ago, at whichever register
-- happened to be open. Flagged rather than inferred from timestamps: a sale
-- can be backdated (complete_sale takes p_created_at), so "later than the
-- sale" is not a fact about how the money arrived.
alter table public.sale_payments
  add column if not exists is_settlement boolean not null default false;

-- ── a sale nobody has paid anything on ────────────────────────────────────
-- sales.payment_method is NOT NULL and summarises how the money came in (0005:
-- "a quick summary column ... so existing listings that read it don't break").
-- On a sale taken entirely on credit no money has come in, and every existing
-- value would read in the transactions ledger as though it had. 'unpaid' says
-- the true thing; settle_sale_balance replaces it with the real method the
-- moment money arrives.
alter table public.sales drop constraint if exists sales_payment_method_check;
alter table public.sales add constraint sales_payment_method_check
  check (payment_method in ('cash','zaad','edahab','other','unpaid'));

drop function if exists public.complete_sale(uuid, jsonb, jsonb, text, text, text, text, integer, uuid, timestamptz, uuid, integer, uuid);
drop function if exists public.edit_sale(uuid, jsonb, jsonb, text, text, text, integer, uuid);

-- ── complete_sale ─────────────────────────────────────────────────────────
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
  p_register_session_id uuid default null,
  p_allow_balance boolean default false
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
  v_grace_days integer;
  v_pending_points integer := 0;
  v_points_available integer := 0;
  v_loyalty_active boolean := false;
  v_points_redeemed integer := greatest(coalesce(p_points_redeemed, 0), 0);
  v_redeem_cents integer := 0;
  v_balance integer;
  v_points_earned integer := 0;
  v_session public.register_sessions%rowtype;
  v_promo_id uuid;
  v_promo_name text;
  v_promo_type text;
  v_promo_value integer;
  v_promo_starts_at timestamptz;
  v_promo_ends_at timestamptz;
  v_expected_discount integer;
begin
  if not public.has_shop_permission(p_shop_id, 'pos.access') then
    raise exception 'not authorized for shop %', p_shop_id;
  end if;
  -- A transaction-level discount with no promotion behind it is a cashier
  -- typing an arbitrary number, the same as a line discount, and needs the
  -- same permission. Checked here, before anything is written, rather than
  -- at the end of the function: v_discount_cents is already known from the
  -- DECLARE section, so there is no reason to do the sale, the stock, the
  -- payments and the loyalty ledger first only to roll it all back.
  if v_discount_cents > 0
     and not public.has_shop_permission(p_shop_id, 'discounts.manual') then
    raise exception 'not authorized to enter a manual discount';
  end if;
  -- A sale with nothing paid on it is legitimate only as credit, against a
  -- named customer. Everything else still has to bring money to the counter.
  if p_payments is null or jsonb_array_length(p_payments) = 0 then
    if not coalesce(p_allow_balance, false) then
      raise exception 'at least one payment is required';
    end if;
    if p_customer_id is null then
      raise exception 'a sale can only be left unpaid against a customer';
    end if;
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

  -- 'unpaid', not a real method. sales.payment_method summarises how the money
  -- came in, and on a sale where none has, every other value is a lie that
  -- reads as collected in the transactions ledger. settle_sale_balance replaces
  -- it with the real method once money actually arrives.
  v_primary_method := coalesce(p_payments->0->>'method', 'unpaid');
  if v_primary_method not in ('cash','zaad','edahab','other','unpaid') then
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
    v_promo_id := nullif(v_item->>'promotion_id', '')::uuid;

    if v_promo_id is null then
      -- No promotion behind it means a cashier typed a number, which is the
      -- one discount path nothing has ever recorded or restricted. Anyone may
      -- APPLY an offer; entering your own amount is a separate permission.
      if v_line_discount > 0
         and not public.has_shop_permission(p_shop_id, 'discounts.manual') then
        raise exception 'not authorized to enter a manual discount';
      end if;
      v_promo_name := null;
    else
      -- A claimed promotion is verified against the row, not taken on trust:
      -- otherwise "attach any uuid" would be a way around the permission above,
      -- and the name written onto the sale forever would be the caller's text.
      -- `active and archived_at is null` so a paused or archived promotion's id
      -- cannot be attached to a new sale -- otherwise a cashier without
      -- discounts.manual could use a store-wide promotion's id, paused or not,
      -- to take a discount the permission exists to prevent.
      select name, discount_type, discount_value, starts_at, ends_at
        into v_promo_name, v_promo_type, v_promo_value, v_promo_starts_at, v_promo_ends_at
        from public.promotions
       where id = v_promo_id and shop_id = p_shop_id and active and archived_at is null;
      if not found then
        -- The lookup filters on shop, active and archived_at together, so a miss
        -- here means any of those -- naming only the shop sent readers hunting
        -- for a tenancy bug when the offer was simply paused.
        raise exception 'promotion % is not available to use (wrong shop, paused, or archived)', v_promo_id;
      end if;

      -- The window IS enforced here, with slack on both edges so a real cart
      -- is never refused at the boundary. One minute of slack on the start
      -- absorbs clock skew between a till and the server -- a device a
      -- minute fast must not be told an offer hasn't started yet. Ten
      -- minutes of slack on the end is a grace window: a cashier who opened
      -- the cart while the offer was live must be able to finish checking
      -- out a few minutes after it lapsed, rather than have the sale refused
      -- at the payment screen with a total the customer has already been
      -- told.
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
      values (v_sale_id, v_product.id, v_product.name, v_product.price_cents, v_qty, v_line, v_line_discount, v_product.cost_cents, v_promo_id, v_promo_name);

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
    -- RESTORED. This guard shipped in 20260820000100 and was dropped when
    -- 20260822000000 copied complete_sale forward from an older ancestor; it has
    -- been missing ever since, so the maturation window has not actually been
    -- enforced. verify-loyalty check 11 has been failing on main because of it.
    --
    -- Only points that have finished maturing can be spent. Computed inside the
    -- lock so a redemption cannot race a sale that is still earning, and
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
    v_points_earned := 0;
  end if;

  update public.sales set
    total_cents = v_total_cents,
    item_count = v_item_count,
    tax_cents = v_tax_cents,
    tax_rate_percent = case when v_tax_enabled then v_tax_rate else null end,
    points_redeemed = v_points_redeemed,
    points_redeemed_cents = v_redeem_cents,
    points_earned = v_points_earned,
    loyalty_points_per_usd = case when v_loyalty_active then v_points_per_usd else null end,
    -- Null while anything is still owed. This is the column customer_balances
    -- filters on, so a sale that forgets to stamp it never leaves the list.
    settled_at = case when v_payments_total >= v_total_cents then now() else null end
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

grant execute on function public.complete_sale(uuid, jsonb, jsonb, text, text, text, text, integer, uuid, timestamptz, uuid, integer, uuid, boolean) to authenticated;

-- ── edit_sale ─────────────────────────────────────────────────────────────
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

-- ── settle_sale_balance ───────────────────────────────────────────────────
-- Paying off an older sale. Not a new kind of record: it inserts another
-- sale_payments row against the sale that is owed, which is what keeps this
-- from becoming a second ledger to reconcile against the first.
--
-- Returns what is still owed afterwards, so a till that takes a part-payment
-- can say so without a second round trip.
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
  -- for update: two cashiers taking the last of the same balance at two tills
  -- would otherwise both read the same shortfall and both be allowed it.
  select * into v_sale from public.sales where id = p_sale_id for update;
  if not found then
    raise exception 'sale not found';
  end if;

  -- Taking money is a till action, so this is complete_sale's own gate.
  -- sales.edit rides alongside it for the back office, which settles an
  -- account without standing at a register.
  if not public.has_any_shop_permission(v_sale.shop_id, array['pos.access', 'sales.edit']) then
    raise exception 'not authorized to take payment for this sale';
  end if;

  if p_payments is null or jsonb_array_length(p_payments) = 0 then
    raise exception 'at least one payment is required';
  end if;

  -- Validated, not trusted, for the reason complete_sale gives: money filed
  -- against a closed session lands in a drawer count somebody has already
  -- signed off, and against another shop's session it lands in the wrong till
  -- entirely.
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
  select coalesce(sum(total_cents), 0) into v_refunded
    from public.refunds where sale_id = p_sale_id;
  -- The same arithmetic as customer_balances, and it has to stay the same:
  -- goods that came back are not owed, so a customer who returned half a
  -- basket must not be asked to settle the whole of it.
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

  -- The sale said 'unpaid' because nothing had been taken. Something has now,
  -- so the summary column stops claiming otherwise -- the transactions ledger
  -- reads this, and a sale that was paid off last week should not still be
  -- listed as unpaid.
  if v_sale.payment_method = 'unpaid' then
    update public.sales set payment_method = p_payments->0->>'method' where id = p_sale_id;
  end if;

  if v_taking = v_owed then
    update public.sales set settled_at = now() where id = p_sale_id;

    -- The whole of a credit sale's earning happens here, because points are
    -- earned on money taken and not on goods handed over. Recomputed from the
    -- sale's own frozen rate rather than today's -- and from the pre-tax
    -- merchandise, because points are never earned on money collected for the
    -- state. That is the identical arithmetic complete_sale ran at ring-up:
    -- it stored total_cents as (that base + tax_cents), so subtracting the tax
    -- gets the base back exactly.
    --
    -- A sale that had something brought back before it was paid off earns
    -- nothing at all. Proportioning it would have to agree with the refund
    -- clawback's own proportioning against a base it does not share, and a
    -- basket half returned before the customer settled is not a purchase worth
    -- paying points on.
    if v_refunded = 0
       and v_sale.customer_id is not null
       and coalesce(v_sale.loyalty_points_per_usd, 0) > 0
       and public.shop_has_module(v_sale.shop_id, 'customers') then
      v_points := round((v_sale.total_cents - coalesce(v_sale.tax_cents, 0))
                        * v_sale.loyalty_points_per_usd / 100)::integer;
      if v_points > 0 then
        -- sales.points_earned means points CREDITED, which is what the refund
        -- clawback proportions against. Left at zero until now, a refund on an
        -- unpaid sale correctly claws back nothing.
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
