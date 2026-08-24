-- A completed sale posts to the ledger.
--
-- complete_sale is reproduced VERBATIM from
-- supabase/migrations/20260831000100_complete_sale_allows_credit.sql
-- (lines 62-486), extracted mechanically rather than retyped, with only the
-- edits listed below. edit_sale and settle_sale_balance are NOT redefined here,
-- so 20260831000100 remains their newest definition.
--
-- Five declarations and one block:
--   1. v_cogs_cents, v_owed_cents, v_item_discount_cents, v_entry_id, v_lines
--      in the DECLARE section
--   2. a posting block after the sale, its items and its payments are written,
--      and before `return v_sale_id`
--
-- ...plus one edit that is NOT new here but had to be carried forward by hand:
--   3. the ORDER BY on the item loop, from 20260905000000_complete_sale_lock_order.
--      That migration patches complete_sale by TEXT SUBSTITUTION against the
--      live pg_proc source instead of re-creating it, so it is invisible both
--      to a grep for this function's CREATE OR REPLACE header and to
--      accumulated-rpc-edits.test.ts, which reads migration text. Copying this
--      function forward from 20260831000100 without it silently reverts a live
--      deadlock fix. See the comment at the loop itself. An entry has now been
--      added to COMPLETE_SALE_EDITS so the next copy-forward cannot lose it.
--
-- The signature is unchanged, so `create or replace` genuinely replaces rather
-- than adding an overload -- no drop is needed here, unlike 20260831000100.

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
  v_cogs_cents integer := 0;
  -- What is still owed at the end of the sale. NOT v_balance -- that one holds
  -- the customer's loyalty POINTS balance and is only ever assigned inside the
  -- redemption branch above, so reading it as money would post a receivable in
  -- points on a redeeming sale and none at all on a plain credit sale.
  v_owed_cents integer := 0;
  -- The line-level and promotion discounts, summed off the rows this sale just
  -- wrote. NOT derivable from v_gross_cents, which is already net of them --
  -- see the posting block for what that cost.
  v_item_discount_cents integer := 0;
  v_entry_id uuid;
  v_lines jsonb;
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

  -- Ordered by product id so two concurrent sales touching the same products
  -- take their row locks in the same order and cannot deadlock. Ordinality is
  -- the tiebreaker, because a cart can list the same product twice.
  --
  -- CARRIED FORWARD FROM 20260905000000_complete_sale_lock_order.sql, which is
  -- newer than the 20260831000100 definition this function is otherwise copied
  -- from. That migration applies its fix by TEXT SUBSTITUTION against the live
  -- pg_proc source rather than by re-creating the function, so it appears in no
  -- CREATE OR REPLACE block anywhere in this directory -- which is exactly how
  -- a grep for the newest definition, and accumulated-rpc-edits.test.ts along
  -- with it, both miss it. Re-creating this
  -- function from the 20260831000100 text WITHOUT this line silently reverts a
  -- live deadlock fix on the hottest path in the app. verify-sale-lock-order
  -- caught it; nothing else did.
  for v_item in
    select value from jsonb_array_elements(p_items) with ordinality as t(value, ord)
      order by (value->>'product_id'), ord
  loop
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

  -- ── The posting side ────────────────────────────────────────────────────
  --
  -- Inside the same transaction, deliberately: a sale that is recorded but not
  -- posted is a books-that-do-not-tie bug that only shows up at month end, and
  -- the shop has no way to find which sale it was. Failing the sale is louder
  -- and rarer.
  --
  -- p_source => 'sale', never 'manual'. post_journal_entry gates the manual
  -- source on ledger.post; a cashier holds pos.access and must not need more.

  -- COGS from the cost FROZEN on each line at sale time, never
  -- products.cost_cents -- otherwise a restock tomorrow rewrites this sale's
  -- cost, and with it every closed month's gross profit. That freeze is what
  -- 20260804000000 exists for.
  --
  -- Uncosted lines contribute nothing rather than zero. isUncosted() is careful
  -- that null and zero are different answers: a free sample really does cost
  -- nothing; an unpriced product is a question nobody answered. (sum() ignores
  -- nulls anyway; the filter states the intent for the next reader.)
  select coalesce(sum(si.unit_cost_cents::bigint * si.quantity), 0)
    into v_cogs_cents
    from public.sale_items si
   where si.sale_id = v_sale_id and si.unit_cost_cents is not null;

  -- Every discount taken on a LINE -- a cashier's typed amount and, far more
  -- often, a promotion. Read back off sale_items because there is no running
  -- total of it in this function: the item loop folds each line's discount
  -- straight into v_line (`price_cents * qty - v_line_discount`) before adding
  -- it to v_gross_cents, so by the time control reaches here v_gross_cents is
  -- already NET of it and the figure is unrecoverable from the variables.
  --
  -- sale_items.discount_cents is the per-line discount as written six lines
  -- into the loop's insert; it is 0, never null (0013 added it `not null
  -- default 0`), so no coalesce is needed inside the sum.
  select coalesce(sum(si.discount_cents), 0)
    into v_item_discount_cents
    from public.sale_items si
   where si.sale_id = v_sale_id;

  -- One debit line per payment, against the account that method maps to. A
  -- single lumped line would make the drawer and the wallet impossible to
  -- reconcile separately, which is most of what a cash position is for.
  select coalesce(jsonb_agg(jsonb_build_object(
           'code',         public.account_code_for_payment_method(sp.method),
           'amount_cents', sp.amount_cents,
           'memo',         'Payment by ' || sp.method)), '[]'::jsonb)
    into v_lines
    from public.sale_payments sp
   where sp.sale_id = v_sale_id and sp.amount_cents <> 0;

  -- What the customer still owes, which the guards above have already accepted
  -- as an under-payment made on purpose against a named customer. Both
  -- operands are final here: the payments loop has closed and the tax has been
  -- folded into v_total_cents.
  v_owed_cents := v_total_cents - v_payments_total;
  if v_owed_cents > 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'code', '1100', 'amount_cents', v_owed_cents, 'memo', 'Left on account'));
  end if;

  -- ALL THREE discounts are shown GROSS: revenue is credited at list price and
  -- every reduction is its own debit to 4200. Netting a discount into 4000
  -- would hide what the shop gave away, which is the one number a discount
  -- report exists to show.
  --
  -- The three are not symmetrical in this function, and the first version of
  -- this block got that wrong:
  --
  --   * v_discount_cents  -- the ORDER-level discount. Subtracted from
  --     v_gross_cents further down, so v_gross_cents is gross with respect to
  --     it and it has to be added back here.
  --   * v_redeem_cents    -- loyalty points spent. Same: subtracted after
  --     v_gross_cents is final.
  --   * v_item_discount_cents -- LINE and PROMOTION discounts. NOT the same.
  --     The item loop computes `v_line := price_cents * qty - v_line_discount`
  --     and accumulates THAT, so v_gross_cents is already net of it.
  --
  -- Crediting 4000 with a bare v_gross_cents therefore understated revenue by
  -- every promotion the shop ran and left 4200 reading zero for a shop whose
  -- discounts are all promotions -- which is the app's main discount
  -- mechanism. One item at 5000 with a 1000 promotion, no tax, 4000 cash,
  -- posted `Dr 1000 4000 / Cr 4000 4000` and no 4200 line at all.
  --
  -- So: revenue at list is v_gross_cents + v_item_discount_cents, and the
  -- contra is all three discounts together.
  --
  -- Still balanced by construction, and this is the whole proof. Writing D for
  -- v_discount_cents, R for v_redeem_cents, I for v_item_discount_cents, G for
  -- v_gross_cents and T for v_tax_cents, the function computes
  --     v_total_cents = G - D - R + T
  -- and the debits are the money in (payments + receivable = v_total_cents)
  -- plus the contra (D + R + I), which is G + T + I. The credits are revenue
  -- (G + I) plus tax (T), which is the same figure. The COGS pair below is a
  -- self-balancing debit/credit of one amount and does not disturb it.
  --
  -- A redemption lands in 4200 alongside the discounts rather than drawing down
  -- 2300 Loyalty Points Liability: posting the redemption as a liability
  -- drawdown without also posting the earn side would drive 2300 negative on
  -- the very first redemption. The earn side is a later phase's work.
  if (v_discount_cents + v_redeem_cents + v_item_discount_cents) > 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'code', '4200', 'amount_cents', v_discount_cents + v_redeem_cents + v_item_discount_cents,
      'memo', 'Discounts and points'));
  end if;

  if (v_gross_cents + v_item_discount_cents) > 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'code', '4000', 'amount_cents', -(v_gross_cents + v_item_discount_cents), 'memo', 'Sale at list'));
  end if;

  if v_tax_cents > 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'code', '2100', 'amount_cents', -v_tax_cents, 'memo', 'Sales tax'));
  end if;

  -- Omitted entirely when zero, not posted as a zero pair: journal_lines
  -- carries check (amount_cents <> 0), so a zero line fails the whole sale.
  if v_cogs_cents > 0 then
    v_lines := v_lines || jsonb_build_array(
      jsonb_build_object('code', '5000', 'amount_cents',  v_cogs_cents, 'memo', 'Cost of goods sold'),
      jsonb_build_object('code', '1200', 'amount_cents', -v_cogs_cents, 'memo', 'Stock sold'));
  end if;

  -- The description carries the sale id, so the link is readable in both
  -- directions. sales.journal_entry_id gets you from the sale to the entry; a
  -- bare 'Sale' got you nowhere back, and a journals list of four hundred rows
  -- all reading 'Sale' is not a journal anybody can audit. Task 8's backfill
  -- has to reconcile replayed entries against their source rows and wants the
  -- same link.
  v_entry_id := public.post_journal_entry(
    p_shop_id,
    coalesce(p_created_at, now())::date,
    'Sale ' || v_sale_id::text,
    v_lines,
    v_location_id,
    'sale');

  update public.sales set journal_entry_id = v_entry_id where id = v_sale_id;
  -- ── end posting side ────────────────────────────────────────────────────

  return v_sale_id;
end;
$$;

grant execute on function public.complete_sale(uuid, jsonb, jsonb, text, text, text, text, integer, uuid, timestamptz, uuid, integer, uuid, boolean) to authenticated;
