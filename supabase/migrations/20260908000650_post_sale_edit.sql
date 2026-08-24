-- An edited sale reverses its journal entry and re-posts from the edited
-- figures.
--
-- ## The hole this closes
--
-- 20260908000200 made complete_sale post a journal entry and stamp
-- sales.journal_entry_id with it. edit_sale changes a sale's items, its totals,
-- its tax and its payments -- and never touched that entry. The entry is
-- immutable (refuse_posted_entry_edit), so from the moment posting shipped,
-- EVERY sale edit left revenue, COGS, tax and the receivable all reading the
-- pre-edit figures with nothing anywhere saying so. A cashier fixing a
-- mis-scanned quantity silently desynchronised the ledger from its own source.
--
-- A ledger that quietly disagrees with `sales` is worse than no ledger, and
-- that disagreement is the exact thing phase 1 was built to make impossible.
--
-- ## The treatment, which the design already fixed
--
-- "Corrections are reversing entries, never edits. Posted journals are
-- immutable. Voiding writes a mirror entry linked to the original with a stated
-- reason. Both stay on the record."
--
-- So an edit reverses the entry sales.journal_entry_id points at, posts a fresh
-- one from the edited figures, and repoints sales.journal_entry_id at the new
-- one. A sale edited three times leaves six entries -- three postings and three
-- reversals. That is correct, not noise: a book is added to, not amended.
--
-- ## Why the reversal is written out here rather than calling
--    reverse_journal_entry()
--
-- That function requires `ledger.post`. edit_sale gates on `sales.edit`. A
-- manager correcting a mis-rung sale holds sales.edit and must never need a
-- ledger permission as well -- which is the same finding that has every posting
-- call pass p_source <> 'manual' rather than gate the till on ledger.post.
-- Routed through reverse_journal_entry, every sale edit in every shop would
-- fail with "You do not have permission to reverse journal entries." until
-- someone granted till staff a permission they must not have.
--
-- So the reversal is done INLINE, inside this function's own security-definer
-- body, reproducing exactly what reverse_journal_entry does and nothing else:
-- the mirrored lines, the R-suffixed reference, the link in both directions,
-- and `status = 'reversed'` on the original -- the one update
-- refuse_posted_entry_edit() permits. reverse_journal_entry itself is
-- deliberately NOT weakened: the manual-entry screen is its other caller and
-- that door must keep gating.
--
-- ## Why a reversal can be redated, when reverse_journal_entry never redates
--
-- reverse_journal_entry dates a reversal to the ORIGINAL entry's date, on
-- purpose: a correction to August belongs in August, and if August is shut it
-- says so and makes somebody decide. That is right for a human at the ledger
-- screen. It is wrong here, because it puts a closed month between a manager
-- and a mis-rung sale: open_period_for refuses the reversal and the whole edit
-- fails with a ledger error on a POS screen.
--
-- 20260908000300 already answered this for backdated sales, and this is the
-- same answer: read the period's status first, and when the month is shut,
-- recognise the correction in the OPEN period with the true date and the
-- status written into the description. Redating is what closing MEANS.
--
-- Read rather than caught, for 20260908000300's reason: an exception handler
-- around the post would also swallow a broken chart of accounts, an unbalanced
-- entry or a missing account and retry them into the current month as though
-- the only thing wrong were the date.
--
-- The two dates are tested INDEPENDENTLY -- the reversal against the original
-- entry's period, the replacement against the sale's own period -- because they
-- are two different questions and can have two different answers: a sale whose
-- month was already closed when it was rung up has an entry dated in a LATER
-- month than the sale itself.
--
-- ## Why the replacement omits settlements
--
-- edit_sale deletes and re-inserts the till's own payments and leaves
-- settlements alone (20260831000100) -- money taken days later at another
-- register, which this call knows nothing about. So sale_payments after an edit
-- holds both kinds, and a posting block that debits cash for every row books
-- the settled money a SECOND time: the settlement already has its own entry
-- (Dr Cash / Cr Receivable, 20260908000350) and reversing the SALE's entry does
-- not touch it.
--
-- So the replacement carries the till's payments only and puts the whole of the
-- rest on 1100. Against the settlement entry still standing, cash nets to what
-- was actually collected and 1100 to what is actually owed. Pinned by check 22
-- of verify-posting-sales.
--
-- ## CARRIED FORWARD BY HAND: the ordered item loop
--
-- edit_sale's newest definition is 20260831000200_refund_goods_not_cash.sql,
-- and this file reproduces it in full from there. But
-- 20260905000000_complete_sale_lock_order.sql patches BOTH complete_sale and
-- edit_sale by TEXT SUBSTITUTION against the live pg_proc source rather than by
-- re-creating them -- so its fixed `ORDER BY (value->>'product_id'), ord` on
-- the item loop exists in NO migration's function text anywhere in this
-- directory, and copying edit_sale forward without it silently reverts a live
-- deadlock fix.
--
-- accumulated-rpc-edits.test.ts reads migration text and is blind to that by
-- construction. 20260908000200 duly reverted complete_sale's half of exactly
-- this fix on its first run, and only verify-sale-lock-order.sql caught it.
-- edit_sale was unguarded until this migration. It is guarded now, by an
-- EDIT_SALE_EDITS entry and by verify-sale-lock-order, which this task extends
-- to cover edit_sale as well as complete_sale.
--
-- Everything else in the function below is byte-for-byte 20260831000200. The
-- signature is unchanged, so this genuinely replaces rather than overloading
-- and no drop is needed.

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
  -- ── the posting side, new in 20260908000650 ────────────────────────────
  -- When the sale HAPPENED. The replacement entry is recognised on the sale's
  -- own local date, exactly as complete_sale posted it -- an edit corrects a
  -- transaction, it does not move it to today.
  v_created_at timestamptz;
  -- The entry this sale is posted with as we arrive, which the edit is about to
  -- reverse. NULL on a sale rung up before 20260908000200 shipped: reversing
  -- nothing is not an error, it just means this edit posts the first entry the
  -- sale has ever had.
  v_old_entry_id uuid;
  v_old_status text;
  v_old_entry_date date;
  v_old_reference text;
  v_old_location_id uuid;
  -- The status of the period the ORIGINAL entry sits in, or NULL when no row
  -- exists for that month. NULL is not "closed" and not "open" either -- it is
  -- "nobody has traded in this month", which open_period_for turns into an open
  -- period on demand. Getting that backwards redates corrections that never
  -- needed redating.
  v_old_period_status text;
  -- Where the reversal is actually recognised. Equal to the original's date
  -- except when that month has been closed or locked.
  v_reversal_date date;
  v_reversal_id uuid;
  v_entry_id uuid;
  v_lines jsonb;
  v_cogs_cents integer := 0;
  -- What is still owed after the edit. Deliberately NOT v_balance -- that one
  -- holds the customer's loyalty POINTS balance and is only ever assigned
  -- inside the clamping branches at the end of this function.
  v_owed_cents integer := 0;
  -- What the TILL has taken on this sale, settlements excluded. See the header:
  -- a settlement already has its own entry and re-debiting it here would book
  -- the same money twice.
  v_till_paid_cents integer := 0;
  -- The line-level and promotion discounts, summed off the rows this edit just
  -- wrote. NOT derivable from v_gross_cents, which is already net of them.
  v_item_discount_cents integer := 0;
  -- The sale's own local date, and the date the replacement is recognised on.
  -- The two differ only when the sale's month has already been closed.
  v_entry_date date;
  v_period_status text;
  v_posted_date date;
begin
  select shop_id, location_id, customer_id, points_earned, points_redeemed_cents,
         loyalty_points_per_usd, created_at
    into v_shop_id, v_location_id, v_old_customer_id, v_points_earned_old,
         v_points_redeemed_cents, v_sale_points_per_usd, v_created_at
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

  -- Ordered by product id so an edit and a concurrent sale touching the same
  -- products take their row locks in the same order and cannot deadlock.
  -- Ordinality is the tiebreaker, because a cart can list the same product
  -- twice -- ordinary when a cashier scans an item a second time.
  --
  -- CARRIED FORWARD FROM 20260905000000_complete_sale_lock_order.sql, which
  -- patches this function by TEXT SUBSTITUTION against the live pg_proc source
  -- rather than re-creating it -- so it appears in no CREATE OR REPLACE block
  -- anywhere in this directory, and copying edit_sale forward from
  -- 20260831000200 without it silently reverts a live deadlock fix. An edit and
  -- a sale lock the same product_location_stock rows; unordered, they deadlock
  -- against each other and Postgres kills one of them. The same trap took
  -- complete_sale's half of this fix out on 20260908000200's first run, and
  -- only verify-sale-lock-order caught it.
  for v_item in
    select value from jsonb_array_elements(p_items) with ordinality as t(value, ord)
      order by (value->>'product_id'), ord
  loop
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

  -- ── The posting side ────────────────────────────────────────────────────
  --
  -- A correction is a reversal plus a fresh entry, never an edit of the
  -- original: journal_entries carries refuse_posted_entry_edit(), and a book is
  -- added to rather than amended. Three rows survive an edit -- what was
  -- posted, its undoing, and what is true now.
  --
  -- Inside the same transaction as the edit, deliberately. An edit that is
  -- recorded but not re-posted is a books-that-do-not-tie bug which only shows
  -- up at month end, with no way to find which sale caused it. Failing the edit
  -- is louder and rarer.
  select journal_entry_id into v_old_entry_id from public.sales where id = p_sale_id;

  -- A sale rung up before 20260908000200 shipped has no entry. Reversing
  -- nothing is not an error; it just means this edit posts the first entry the
  -- sale has ever had. Task 8's backfill fills the rest in.
  if v_old_entry_id is not null then
    select status, entry_date, reference, location_id
      into v_old_status, v_old_entry_date, v_old_reference, v_old_location_id
      from public.journal_entries where id = v_old_entry_id;

    -- Loud rather than quiet. A sale pointing at a draft or an already-reversed
    -- entry is a state nothing in this codebase can produce, and silently
    -- posting a second entry on top of it would leave the sale double-counted
    -- with nothing on the record saying so.
    if v_old_status <> 'posted' then
      raise exception 'the journal entry for this sale is %, so it cannot be reversed', v_old_status
        using errcode = 'P0001';
    end if;

    -- READ, not caught -- see the header. open_period_for raises for any
    -- non-open period, and catching that would also swallow a genuinely broken
    -- chart of accounts and retry it into the current month.
    select status into v_old_period_status
      from public.accounting_periods
     where shop_id = v_shop_id and v_old_entry_date between starts_on and ends_on;

    -- No row means open_period_for will create it open, so only an EXISTING
    -- non-open period redirects.
    if v_old_period_status is not null and v_old_period_status <> 'open' then
      v_reversal_date := public.shop_local_date();
    else
      v_reversal_date := v_old_entry_date;
    end if;

    -- What reverse_journal_entry(uuid, text) does, minus its ledger.post gate.
    -- Written out here rather than called because edit_sale gates on
    -- sales.edit and a manager correcting a mis-rung sale must not need a
    -- ledger permission -- the same reasoning that has the post below pass
    -- p_source => 'sale'. reverse_journal_entry keeps its gate for its own
    -- caller, the manual-entry screen.
    --
    -- The reference is the original's with an R, not a fresh JE- number, so
    -- the pair reads as a pair in the journals list. coalesce in the
    -- DESCRIPTION only: `||` with a NULL operand yields NULL for the whole
    -- expression, and a null description is refused by
    -- `check (length(trim(description)) > 0)`. The reference itself may stay
    -- null -- unique (shop_id, reference) treats nulls as distinct -- which is
    -- the honest answer for the mirror of an unreferenced entry.
    insert into public.journal_entries
        (shop_id, period_id, entry_date, reference, description, source, status,
         location_id, reverses_entry_id, created_by)
      values (
        v_shop_id,
        public.open_period_for(v_shop_id, v_reversal_date),
        v_reversal_date,
        v_old_reference || 'R',
        'Reversal of ' || coalesce(v_old_reference, 'an unreferenced entry')
          || ' — sale ' || p_sale_id::text || ' was edited'
          -- coalesce on the status for the reason 20260908000300 found the hard
          -- way: the branch above cannot set v_reversal_date <> v_old_entry_date
          -- while v_old_period_status is NULL, but if that invariant is ever
          -- broken by an edit up there the whole description becomes NULL and
          -- the edit fails on a description constraint for a bug about dates.
          || case when v_reversal_date <> v_old_entry_date
                  then ' (originally dated ' || to_char(v_old_entry_date, 'YYYY-MM-DD')
                       || '; that period is ' || coalesce(v_old_period_status, 'not open')
                       || ', so the reversal is recognised here)'
                  else '' end,
        'manual', 'posted', v_old_location_id, v_old_entry_id, auth.uid())
      returning id into v_reversal_id;

    insert into public.journal_lines (entry_id, account_id, amount_cents, location_id, memo)
      select v_reversal_id, account_id, -amount_cents, location_id, memo
        from public.journal_lines where entry_id = v_old_entry_id;

    -- The one update refuse_posted_entry_edit() permits, and the link that
    -- makes neither entry readable without finding the other.
    update public.journal_entries
       set status = 'reversed', reverses_entry_id = v_reversal_id
     where id = v_old_entry_id;
  end if;

  -- The replacement, built exactly as complete_sale builds its entry
  -- (20260908000300) but from the rows THIS call has just written.

  -- COGS from the cost FROZEN on each line, never products.cost_cents --
  -- otherwise a restock tomorrow rewrites this sale's cost, and with it every
  -- closed month's gross profit. Uncosted lines contribute nothing rather than
  -- zero: a free sample really does cost nothing, an unpriced product is a
  -- question nobody answered.
  select coalesce(sum(si.unit_cost_cents::bigint * si.quantity), 0)
    into v_cogs_cents
    from public.sale_items si
   where si.sale_id = p_sale_id and si.unit_cost_cents is not null;

  -- Every discount taken on a LINE -- a cashier's typed amount and, far more
  -- often, a promotion. Read back off sale_items because there is no running
  -- total of it here: the item loop folds each line's discount straight into
  -- v_line before adding it to v_gross_cents, so v_gross_cents is already NET
  -- of it and the figure is unrecoverable from the variables.
  select coalesce(sum(si.discount_cents), 0)
    into v_item_discount_cents
    from public.sale_items si where si.sale_id = p_sale_id;

  -- One debit line per payment method, against the account that method maps to.
  -- A single lumped line would make the drawer and the wallet impossible to
  -- reconcile separately, which is most of what a cash position is for.
  --
  -- `not sp.is_settlement`, and the sum below is taken over the SAME rows so
  -- the two cannot disagree: a settlement already carries its own entry, which
  -- reversing the sale's entry does not touch. See the header.
  --
  -- The method comes off sale_payments, never sales.payment_method:
  -- account_code_for_payment_method raises on 'unpaid', which is exactly what
  -- that column holds on a credit sale.
  select coalesce(jsonb_agg(jsonb_build_object(
           'code',         public.account_code_for_payment_method(sp.method),
           'amount_cents', sp.amount_cents,
           'memo',         'Payment by ' || sp.method)), '[]'::jsonb),
         coalesce(sum(sp.amount_cents), 0)
    into v_lines, v_till_paid_cents
    from public.sale_payments sp
   where sp.sale_id = p_sale_id and sp.amount_cents <> 0 and not sp.is_settlement;

  -- What is left to collect at the counter, which the guards above have already
  -- accepted as a deliberate under-payment against a named customer. Measured
  -- against the till's payments only: the settled part is cleared by the
  -- settlement's own entry, so charging it to 1100 here and there both would
  -- clear the same debt twice.
  v_owed_cents := v_total_cents - v_till_paid_cents;
  if v_owed_cents > 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'code', '1100', 'amount_cents', v_owed_cents, 'memo', 'Left on account'));
  end if;

  -- ALL THREE discounts are shown GROSS: revenue is credited at list price and
  -- every reduction is its own debit to 4200. Netting a discount into 4000
  -- would hide what the shop gave away, which is the one number a discount
  -- report exists to show.
  --
  -- The three are not symmetrical, and complete_sale's first version got it
  -- wrong: v_discount_cents (order level) and v_points_redeemed_cents (loyalty)
  -- are subtracted AFTER v_gross_cents is final, so v_gross_cents is gross with
  -- respect to them; v_item_discount_cents is folded into each line BEFORE it
  -- is accumulated, so v_gross_cents is already net of it. Hence revenue at
  -- list is v_gross_cents + v_item_discount_cents and the contra is all three.
  --
  -- Balanced by construction. Writing D for v_discount_cents, R for
  -- v_points_redeemed_cents, I for v_item_discount_cents, G for v_gross_cents,
  -- T for v_tax_cents and P for the till's payments, this function computes
  -- v_total_cents = G - D - R + T. The debits are P + (v_total_cents - P) plus
  -- the contra D + R + I, which is G + T + I. The credits are revenue (G + I)
  -- plus tax T, the same figure. The COGS pair is self-balancing and does not
  -- disturb it -- and none of it depends on how much was settled, because the
  -- settled money appears on neither side.
  if (v_discount_cents + v_points_redeemed_cents + v_item_discount_cents) > 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'code', '4200', 'amount_cents', v_discount_cents + v_points_redeemed_cents + v_item_discount_cents,
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
  -- carries check (amount_cents <> 0), so a zero line fails the whole edit.
  if v_cogs_cents > 0 then
    v_lines := v_lines || jsonb_build_array(
      jsonb_build_object('code', '5000', 'amount_cents',  v_cogs_cents, 'memo', 'Cost of goods sold'),
      jsonb_build_object('code', '1200', 'amount_cents', -v_cogs_cents, 'memo', 'Stock sold'));
  end if;

  -- The sale's own local date, from public.shop_local_date() -- never
  -- now()::date, which resolves in the session's timezone (UTC on Supabase)
  -- while every market kaiibi serves is UTC+3. An edit corrects a transaction;
  -- it does not move it to today.
  --
  -- Called rather than inlined as `at time zone 'Africa/Mogadishu'`:
  -- 20260908000320 exists so this expression has one home, and this is new
  -- posting code with none of complete_sale's copy-forward history excusing a
  -- second copy.
  v_entry_date := public.shop_local_date(v_created_at);

  select status into v_period_status
    from public.accounting_periods
   where shop_id = v_shop_id and v_entry_date between starts_on and ends_on;

  if v_period_status is not null and v_period_status <> 'open' then
    v_posted_date := public.shop_local_date();
  else
    v_posted_date := v_entry_date;
  end if;

  -- The description carries the sale id, so the link reads in both directions,
  -- and says the entry is a correction rather than an original posting. When
  -- the two dates differ it also carries the sale's TRUE date and the status
  -- that pushed it here -- without that, the only record of why an August sale
  -- is recognised in October lives on the source row, and the journal, which is
  -- what an auditor reads, shows an unexplained October entry.
  v_entry_id := public.post_journal_entry(
    v_shop_id,
    v_posted_date,
    'Sale ' || p_sale_id::text || ' (edited)'
      || case when v_posted_date <> v_entry_date
              then ' (sold ' || to_char(v_entry_date, 'YYYY-MM-DD')
                   || '; that period is ' || coalesce(v_period_status, 'not open')
                   || ', so it is recognised here)'
              else '' end,
    v_lines,
    v_location_id,
    -- 'sale', never 'manual'. post_journal_entry gates the manual source on
    -- ledger.post; the caller here holds sales.edit and must not need more.
    'sale');

  update public.sales set journal_entry_id = v_entry_id where id = p_sale_id;
  -- ── end posting side ────────────────────────────────────────────────────
end;
$$;

grant execute on function public.edit_sale(uuid, jsonb, jsonb, text, text, text, integer, uuid, boolean) to authenticated;
