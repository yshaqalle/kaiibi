-- The route-B delivery-fee entry becomes reachable by more than prose.
--
-- ## The hole this closes
--
-- 20260928000200_complete_storefront_order.sql posts the delivery fee as its
-- own journal entry (route B: "two lines, equal and opposite... it touches no
-- shared function"), tied to the sale it rode in with only by the
-- description string on each entry -- "Delivery on order #N (sale <uuid>)".
-- That is legible to a human reading the journal, and invisible to code.
--
-- delete_sale (20260908000900_post_sale_delete.sql) builds the set of entries
-- a deleted sale is responsible for from three real foreign keys --
-- sales.journal_entry_id, refunds.journal_entry_id,
-- sale_payments.journal_entry_id -- and reverses each one, inline, in the
-- same transaction as the delete. The fee entry names its sale in free text
-- only, so it was invisible to that query: deleting a completed storefront
-- sale reversed the goods (4000/5000/1200/2100/the tender) and left the fee's
-- 4300 credit and its matching asset debit standing, for a sale that no
-- longer exists. The shop's books would show delivery income it never
-- earned, on a sale it can no longer even look up.
--
-- ## Where the link belongs, and where it does not
--
-- `orders.delivery_entry_id`, not `sales` and not `journal_entries` itself.
-- The fee entry belongs to the ORDER -- it exists because an order carried a
-- delivery fee -- and the order already carries `sale_id`
-- (20260928000200), so this is the same relationship's other entry, on the
-- same row. Putting it on `sales` instead would mean teaching complete_sale
-- (or a second write against `sales` right after it) about a concept that is
-- entirely the storefront's, breaking route B's whole reason for existing:
-- "it touches no shared function, so the register's blast radius is zero".
--
-- refund_sale_items is deliberately UNTOUCHED. A refund does not delete the
-- sale -- the row survives, `orders.sale_id` still resolves, and the delivery
-- already happened whether or not some of the goods come back. Reversing the
-- fee automatically on every refund would be inventing a business rule this
-- review was not asked for (does returning one item out of a five-item
-- delivery refund the trip?) -- see this migration's companion finding in the
-- review, which asks only that DELETING a sale reverse everything that sale
-- is responsible for, fee included.
--
-- `on delete set null`, matching `orders.sale_id`'s own FK
-- (20260928000200's header): journal_entries are never hard-deleted anywhere
-- in this codebase (a correction reverses, per 20260908000650's whole
-- argument), so this is defensive rather than expected to fire, and SET NULL
-- over RESTRICT/CASCADE keeps a journal_entries row from ever being blocked
-- or torn down by an order pointing at it.
alter table public.orders
  add column delivery_entry_id uuid references public.journal_entries(id) on delete set null;

-- ── complete_storefront_order: capture the fee entry's id ────────────────
--
-- Reproduced in full, per this repo's convention. Exactly one line changes
-- inside the existing `if v_order.delivery_fee_cents > 0` block -- `perform`
-- becomes `select ... into v_fee_entry_id` so the id post_journal_entry
-- returns is kept rather than discarded -- and the closing UPDATE now sets
-- `delivery_entry_id` in the same statement it already sets `status` and
-- `sale_id` in. v_fee_entry_id stays NULL for a collect order (no fee, no
-- entry, nothing to link), which is exactly what an order with no delivery
-- fee should carry.
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
        -- have moved". See the concern in this migration's header.
        raise exception 'order_total_changed'
          using errcode = 'P0001',
                detail = json_build_object(
                  'quoted_cents', v_order.subtotal_cents,
                  'message',      v_msg)::text;
      else
        raise;
      end if;
  end;

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
    -- The id is now KEPT, not discarded -- into v_fee_entry_id, which the
    -- closing UPDATE below stamps onto orders.delivery_entry_id so the entry
    -- is reachable by more than the description string naming this order and
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

revoke execute on function public.complete_storefront_order(uuid, text) from public;
grant execute on function public.complete_storefront_order(uuid, text) to authenticated;

-- ── delete_sale: the fee entry reverses with everything else ─────────────
--
-- Reproduced in full, per this repo's convention (delete_sale's own header
-- names 20260820000100_loyalty_balance_rules.sql as the last full copy before
-- 20260908000900 added the posting side; this is that same posting side with
-- ONE fourth branch added to the UNION ALL that assembles which entries a
-- deleted sale is responsible for).
--
-- The new branch reads `orders.delivery_entry_id` for the order THIS sale
-- became (`orders.sale_id = p_sale_id`) -- at most one row, because
-- 20260928000300_orders_write_lockdown.sql's unique index guarantees a sale
-- settles at most one order. Read BEFORE the delete below, same reason the
-- other three branches already are: `orders.sale_id` is `on delete set null`
-- (20260928000200's header), so once the sale is gone the order can no longer
-- be found FROM it.
--
-- The reversal is filed under the same source as the entry it reverses --
-- 'sale', per 20260928000200's own header ("the fee entry's source is
-- 'sale', not a new value") -- which this loop already does for every branch
-- by reading `v_dead.source` off the row rather than writing a literal, so
-- the fee entry needed no special case here at all.
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
  -- ── the posting side, new in 20260908000900 ────────────────────────────
  -- One row per journal entry this sale is responsible for: its own, every
  -- refund's, every settlement's, and (20260928000400) its order's delivery
  -- fee, if it has one. Each carries the fields the mirror needs and the
  -- SOURCE it must be filed under.
  v_dead record;
  -- The status of the period the ORIGINAL entry sits in, or NULL when no row
  -- exists for that month. NULL is not "closed" and not "open" either -- it is
  -- "nobody has traded in this month", which open_period_for turns into an open
  -- period on demand. Getting that backwards redates reversals that never
  -- needed redating.
  v_old_period_status text;
  -- Where the reversal is actually recognised. Equal to the original's date
  -- except when that month has been closed or locked.
  v_reversal_date date;
  v_reversal_id uuid;
begin
  -- `for update` is new here -- see this migration's header for the race it
  -- closes. It also serialises the delete itself, which previously read the row
  -- unlocked and deleted it several statements later.
  select shop_id, location_id, customer_id, points_earned, points_redeemed
    into v_shop_id, v_location_id, v_customer_id, v_points_earned, v_points_redeemed
    from public.sales where id = p_sale_id for update;
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

  -- ── The posting side ────────────────────────────────────────────────────
  --
  -- BEFORE the delete below, and it has to be: `refunds` and `sale_payments`
  -- both cascade off `sales`, and `orders.sale_id` is set null by it, so
  -- after the delete there is nothing left to read the entry ids from and the
  -- entries are unreachable forever.
  --
  -- Inside the same transaction as the delete, deliberately. A sale that is
  -- removed but not reversed is a books-that-do-not-tie bug which only shows up
  -- at month end, with no way to find which sale caused it -- and no source row
  -- left for the backfill to replay. Failing the delete is louder and rarer.
  for v_dead in
    select e.id, e.status, e.entry_date, e.reference, e.location_id, e.source, d.what
      from (
        -- The sale's own entry. NULL on a sale rung up before 20260908000200
        -- shipped: reversing nothing is not an error.
        select s.journal_entry_id as entry_id, 'the sale' as what
          from public.sales s
         where s.id = p_sale_id and s.journal_entry_id is not null
        union all
        -- Every refund taken against it (Dr 4100 / Cr the tenders and 1100).
        select r.journal_entry_id, 'refund ' || r.id::text
          from public.refunds r
         where r.sale_id = p_sale_id and r.journal_entry_id is not null
        union all
        -- Every balance settlement (Dr the tender / Cr 1100). Only SETTLEMENT
        -- rows ever carry an entry of their own -- complete_sale folds a sale's
        -- own till payments into the sale's entry and leaves those rows null
        -- forever -- so filtering on the column is filtering on the right thing
        -- and no is_settlement test is needed or wanted: a backfilled row would
        -- carry one too.
        select sp.journal_entry_id, 'settlement ' || sp.id::text
          from public.sale_payments sp
         where sp.sale_id = p_sale_id and sp.journal_entry_id is not null
        union all
        -- 20260928000400: the delivery fee this sale carried, if this sale is
        -- what a storefront order became. At most one row -- a sale settles at
        -- most one order (20260928000300's unique index) -- but written as a
        -- query rather than a maybe-null variable so an order with no fee
        -- (delivery_entry_id null) or no order at all (a counter sale) both
        -- fall out as "nothing to add" for free.
        select o.delivery_entry_id, 'the delivery fee on order #' || o.number
          from public.orders o
         where o.sale_id = p_sale_id and o.delivery_entry_id is not null
      ) d
      join public.journal_entries e on e.id = d.entry_id
     order by e.entry_date, e.reference
  loop
    -- Loud rather than quiet. A source row pointing at a draft or an
    -- already-reversed entry is a state nothing in this codebase can produce,
    -- and silently writing a second mirror on top of it would leave the sale
    -- reversed twice with nothing on the record saying so.
    if v_dead.status <> 'posted' then
      raise exception 'the journal entry for % is %, so it cannot be reversed', v_dead.what, v_dead.status
        using errcode = 'P0001';
    end if;

    -- READ, not caught -- see the header. open_period_for raises for any
    -- non-open period, and catching that would also swallow a genuinely broken
    -- chart of accounts and retry it into the current month.
    select status into v_old_period_status
      from public.accounting_periods
     where shop_id = v_shop_id and v_dead.entry_date between starts_on and ends_on;

    -- No row means open_period_for will create it open, so only an EXISTING
    -- non-open period redirects.
    if v_old_period_status is not null and v_old_period_status <> 'open' then
      v_reversal_date := public.shop_local_date();
    else
      v_reversal_date := v_dead.entry_date;
    end if;

    -- What reverse_journal_entry(uuid, text) does, minus its ledger.post gate.
    --
    -- The reference is the original's with an R, not a fresh JE- number, so the
    -- pair reads as a pair in the journals list. coalesce in the DESCRIPTION
    -- only: `||` with a NULL operand yields NULL for the whole expression, and a
    -- null description is refused by `check (length(trim(description)) > 0)`.
    -- The reference itself may stay null -- unique (shop_id, reference) treats
    -- nulls as distinct -- which is the honest answer for the mirror of an
    -- unreferenced entry.
    --
    -- `v_dead.source`, never a literal: a reversal files under the same source
    -- as the entry it reverses, so a reader filtering `source = 'refund'` sees
    -- the refund AND its undoing rather than one of the two.
    insert into public.journal_entries
        (shop_id, period_id, entry_date, reference, description, source, status,
         location_id, reverses_entry_id, created_by)
      values (
        v_shop_id,
        public.open_period_for(v_shop_id, v_reversal_date),
        v_reversal_date,
        v_dead.reference || 'R',
        'Reversal of ' || coalesce(v_dead.reference, 'an unreferenced entry')
          || ' — sale ' || p_sale_id::text || ' was deleted'
          || case when v_dead.what <> 'the sale'
                  then ' (' || v_dead.what || ' went with it)'
                  else '' end
          -- coalesce on the status for the reason 20260908000300 found the hard
          -- way: the branch above cannot set v_reversal_date <> the original's
          -- date while v_old_period_status is NULL, but if that invariant is
          -- ever broken by an edit up there the whole description becomes NULL
          -- and the delete fails on a description constraint for a bug about
          -- dates.
          || case when v_reversal_date <> v_dead.entry_date
                  then ' (originally dated ' || to_char(v_dead.entry_date, 'YYYY-MM-DD')
                       || '; that period is ' || coalesce(v_old_period_status, 'not open')
                       || ', so the reversal is recognised here)'
                  else '' end,
        v_dead.source, 'posted', v_dead.location_id, v_dead.id, auth.uid())
      returning id into v_reversal_id;

    insert into public.journal_lines (entry_id, account_id, amount_cents, location_id, memo)
      select v_reversal_id, account_id, -amount_cents, location_id, memo
        from public.journal_lines where entry_id = v_dead.id;

    -- The one update refuse_posted_entry_edit() permits, and the link that
    -- makes neither entry readable without finding the other.
    update public.journal_entries
       set status = 'reversed', reverses_entry_id = v_reversal_id
     where id = v_dead.id;
  end loop;
  -- ── end posting side ────────────────────────────────────────────────────

  delete from public.sales where id = p_sale_id;
end;
$$;

comment on function public.delete_sale(uuid) is
  'Deletes a sale, restores its stock, reverses its loyalty points AND reverses every journal entry it is responsible for -- its own, every refund''s, every settlement''s and its order''s delivery fee, if it has one -- leaving the originals and their mirrors both on the record. The reversals are written inline rather than through reverse_journal_entry, which gates on ledger.post; this door gates on sales.edit. Each reversal carries the source of the entry it reverses.';

grant execute on function public.delete_sale(uuid) to authenticated;
