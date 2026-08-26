-- Closing B2 of the final whole-branch review: `/orders` is gated on
-- `settings.access` (permissions.ts), but completing an order posts a sale,
-- and complete_sale has always required `pos.access`
-- (20260908000300_sale_entry_date.sql:158-159). A settings-only manager --
-- someone who can open Settings but was never given the till -- could open
-- an order and tap Complete, and the button would always fail. Today it
-- fails from deep inside complete_sale's own `raise exception 'not
-- authorized for shop %'`, a plain-text message naming a shop uuid that
-- reaches a shopkeeper's phone verbatim.
--
-- The client half of this fix hides the Complete button entirely once
-- `can('pos.access')` is false (order-detail.tsx's canComplete). This
-- migration is the server half: an explicit, typed check in
-- complete_storefront_order itself, so the refusal this function gives is
-- one it chose -- the same short-code contract every other anticipated
-- failure here already gets (see 20260928000200's own header, "Typed
-- errors, because a shopkeeper reads these") -- rather than one that arrives
-- unrecognisable from three calls away. Belt and braces: the UI must not
-- offer the button, and the database must not need the UI to have gotten
-- that right.
--
-- Checked immediately after the module gate and before anything else --
-- payment-method validation, the snapshot read, complete_sale itself -- for
-- the same reason the payment-method check already sits ahead of them:
-- getting authorization wrong must not cost a stock decrement or a journal
-- reference first.
--
-- Not a duplicate of complete_sale's own `pos.access` check. That one still
-- runs too (complete_sale is unchanged) and still fires if this were ever
-- skipped -- the same "belt and braces beneath the trigger" posture
-- 20260928000100 and 20260928000500 both already take, applied one level
-- up: two independent gates, so one being wrong is not enough to open the
-- door.
--
-- Reproduced whole, not patched, per this repo's convention
-- (20260908000150_journal_entry_sequence.sql's header): the newest
-- definition of complete_storefront_order is the whole of it, in one place.
-- One new statement from 20260928000500_order_completion_provenance.sql's
-- own definition -- everything else, byte for byte, unchanged.
create or replace function public.complete_storefront_order(
  p_order_id       uuid,
  p_payment_method text
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_order      public.orders%rowtype;
  v_items      jsonb;
  v_sale_id    uuid;
  v_location   uuid;
  v_entry_date date;
  v_missing    text;
  v_msg        text;
  v_fee_entry_id uuid;
begin
  -- FOR UPDATE, so two shop phones tapping "Handed over" at the same moment
  -- queue instead of both reading 'ready' and both posting a sale. The second
  -- one wakes up, re-reads 'completed', and is refused by the status guard
  -- below.
  select * into v_order from public.orders where id = p_order_id for update;
  if v_order.id is null then
    raise exception 'order % not found', p_order_id;
  end if;

  if not public.is_shop_member(v_order.shop_id) then
    raise exception 'not authorized for order %', p_order_id;
  end if;
  if not public.shop_has_module(v_order.shop_id, 'storefront') then
    raise exception 'module_not_included'
      using errcode = 'P0001',
            detail = json_build_object('module', 'storefront')::text,
            hint = 'Upgrade the plan to make changes here.';
  end if;

  -- The new check: a shop member who cannot ring up a sale at the counter
  -- cannot ring one up through the storefront either -- complete_sale's own
  -- rule (its header, point 3), stated here as a typed refusal instead of
  -- being discovered three calls deep. Checked before the payment-method
  -- validation below: a member with no till access is refused for that
  -- reason regardless of what they tapped for "paid with".
  if not public.has_shop_permission(v_order.shop_id, 'pos.access') then
    raise exception 'pos_access_required' using errcode = 'P0001';
  end if;

  -- Checked here rather than left to complete_sale's own payment-method
  -- validation, because getting this wrong must not cost a stock decrement
  -- and a journal reference first. The list is complete_sale's list
  -- (20260908000300:233) minus 'unpaid': an order handed over at the door has
  -- been paid for, and this function has no customer record to leave a
  -- balance against.
  if p_payment_method is null or p_payment_method not in ('cash', 'zaad', 'edahab', 'other') then
    raise exception 'invalid_payment_method'
      using errcode = 'P0001',
            detail = json_build_object('method', coalesce(p_payment_method, '<null>'))::text;
  end if;

  -- The trigger below would refuse this too, and it remains the enforcer --
  -- this is an early, cheaper refusal with the IDENTICAL error contract
  -- (same code, same detail shape), not a second copy of the moves table. It
  -- earns its place on one case the trigger cannot catch: an order already
  -- 'completed' would reach the trigger as completed -> completed, which the
  -- same-status early return waves through -- so without this guard a second
  -- call would post a whole second sale and only fail on the sale-link
  -- immutability check afterwards, if at all.
  if v_order.status <> 'ready' then
    raise exception 'invalid_order_transition'
      using errcode = 'P0001',
            detail = json_build_object('from', v_order.status, 'to', 'completed')::text;
  end if;

  -- THE SNAPSHOT, not a fresh lookup. order_items froze product_name,
  -- unit_price_cents and quantity at checkout (20260926000050_orders.sql's
  -- header) because that is what the customer agreed to.
  --
  -- A line whose product has since been DELETED (order_items.product_id is
  -- `on delete set null`) is caught here by name rather than handed to
  -- complete_sale, which would raise `product  not found in this shop` with
  -- an empty uuid in the middle of it. Same treatment Task 3's
  -- findShortfalls gives such a line: fully unfillable, never silently
  -- dropped.
  select string_agg(oi.product_name, ', ' order by oi.product_name)
    into v_missing
    from public.order_items oi
   where oi.order_id = p_order_id and oi.product_id is null;
  if v_missing is not null then
    raise exception 'order_product_deleted'
      using errcode = 'P0001',
            detail = json_build_object('products', v_missing)::text;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'product_id',       oi.product_id,
           'quantity',         oi.quantity,
           'unit_price_cents', oi.unit_price_cents)
         order by oi.product_name), '[]'::jsonb)
    into v_items
    from public.order_items oi
   where oi.order_id = p_order_id;

  if jsonb_array_length(v_items) = 0 then
    raise exception 'order_has_no_items' using errcode = 'P0001';
  end if;

  -- The goods, and only the goods. The delivery fee is deliberately NOT in
  -- this payment: complete_sale would refuse it as an over-payment against a
  -- total it computed from the items alone (20260908000300:481), and rightly
  -- so. The fee's own money movement is posted below.
  begin
    v_sale_id := public.complete_sale(
      p_shop_id             => v_order.shop_id,
      p_items               => v_items,
      p_payments            => jsonb_build_array(jsonb_build_object(
                                 'method',       p_payment_method,
                                 'amount_cents', v_order.subtotal_cents)),
      p_customer_name       => v_order.customer_name,
      p_customer_phone      => v_order.customer_phone,
      p_register_session_id => null);
  exception
    when others then
      -- Bare `when others` with an explicit message match and an unconditional
      -- `raise;` otherwise -- the house pattern. complete_sale raises with
      -- plain RAISE EXCEPTION, so every one of these arrives as P0001 and the
      -- sqlstate alone cannot tell them apart; the text is the only handle
      -- there is. Anything unrecognised goes back up untouched.
      v_msg := sqlerrm;
      if v_msg like 'insufficient stock for %' then
        -- The shop can act on this: put the stock right, or ring the customer.
        -- The original message is carried along so the client can name the
        -- product and the numbers without this function re-deriving them.
        raise exception 'insufficient_stock'
          using errcode = 'P0001',
                detail = json_build_object('message', v_msg)::text;
      elsif v_msg like 'payments total % does not match sale total %'
         or v_msg like 'payments total % is more than sale total %' then
        -- complete_sale prices every line from the CURRENT products.price_cents
        -- and adds the shop's tax on top; the order was quoted from a snapshot
        -- taken at checkout, tax-exclusive. When those two figures disagree --
        -- the shop re-priced a product, or the shop charges tax the storefront
        -- never showed -- this is the message that comes back, and on its own
        -- it reads as an arithmetic bug rather than as "this order's prices
        -- have moved". See the concern in 20260928000200's header.
        raise exception 'order_total_changed'
          using errcode = 'P0001',
                detail = json_build_object(
                  'quoted_cents', v_order.subtotal_cents,
                  'message',      v_msg)::text;
      else
        raise;
      end if;
  end;

  -- ── The completion is now provenanced, not merely stated ─────────────
  --
  -- Written as the table owner (this function is SECURITY DEFINER) before
  -- the order itself is touched, so the trigger fired by the UPDATE below
  -- finds it already there. `on conflict` rather than a bare insert only
  -- because this function's own status guard above already refuses a second
  -- call once the order is 'completed' -- this is defensive, not load-
  -- bearing: nothing in the ordinary path ever inserts the same order_id
  -- twice.
  insert into public.storefront_order_completions (order_id, sale_id)
    values (p_order_id, v_sale_id)
  on conflict (order_id) do update
    set sale_id = excluded.sale_id, xact_id = excluded.xact_id;

  -- ── The delivery fee, route B ─────────────────────────────────────────
  if v_order.delivery_fee_cents > 0 then
    select s.location_id into v_location from public.sales s where s.id = v_sale_id;

    -- The date the SALE was recognised on, read off the entry complete_sale
    -- just posted rather than recomputed. That inherits, for free and without
    -- a second copy, both the shop-local-date rule (Africa/Mogadishu, never a
    -- bare ::date -- 20260908000300:665) and the closed-period redirect that
    -- can push a sale's entry into the current month. Two entries for one
    -- order sitting in two different months would be a reconciliation problem
    -- with no fix once a period closes.
    --
    -- Null only when the sale posted no entry at all, which complete_sale
    -- deliberately allows for a sale that moved no money (a basket of free
    -- samples). A shop can still charge to deliver such a basket, so the fee
    -- entry falls back to the same shop-local date the sale would have used.
    select je.entry_date into v_entry_date
      from public.journal_entries je
      join public.sales s on s.journal_entry_id = je.id
     where s.id = v_sale_id;
    v_entry_date := coalesce(v_entry_date, public.shop_local_date());

    -- Two lines, equal and opposite. It balances by construction: there is no
    -- arithmetic here to get wrong, which is the main thing route B buys.
    --
    -- 4300 Delivery Income, NEVER 4000 Sales Revenue. Delivery carries no cost
    -- of sales, so putting it in 4000 mixes income with no matching COGS into
    -- goods revenue and flatters gross margin on every report -- the whole
    -- reason 20260928000000 created the account.
    --
    -- The id is KEPT, not discarded -- into v_fee_entry_id, which the closing
    -- UPDATE below stamps onto orders.delivery_entry_id
    -- (20260928000400_delivery_fee_reversal_link.sql) so the entry is
    -- reachable by more than the description string naming this order and
    -- this sale.
    select public.post_journal_entry(
      v_order.shop_id,
      v_entry_date,
      'Delivery on order #' || v_order.number || ' (sale ' || v_sale_id::text || ')',
      jsonb_build_array(
        jsonb_build_object(
          'code',         public.account_code_for_payment_method(p_payment_method),
          'amount_cents', v_order.delivery_fee_cents,
          'memo',         'Delivery paid by ' || p_payment_method),
        jsonb_build_object(
          'code',         '4300',
          'amount_cents', -v_order.delivery_fee_cents,
          'memo',         'Delivery on order #' || v_order.number)),
      v_location,
      'sale')
      into v_fee_entry_id;
  end if;

  -- Last, and in the same transaction as everything above: a completion that
  -- posts a sale but leaves the order 'ready' is worse than one that fails
  -- cleanly, because the shop's only signal that anything happened is the
  -- order list. The status, the sale link and the fee entry's link all move
  -- together, in one statement, which is also the only shape the trigger
  -- accepts.
  update public.orders
     set status = 'completed', sale_id = v_sale_id, delivery_entry_id = v_fee_entry_id
   where id = p_order_id;

  return v_sale_id;
end;
$$;
