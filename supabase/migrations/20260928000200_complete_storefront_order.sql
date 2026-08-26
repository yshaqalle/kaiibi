-- Completing a storefront order: the one move in this whole feature that
-- reaches the books.
--
-- Everything Task 2 built moves an order between states and touches nothing
-- else. This move turns an order into a SALE -- stock comes off the shelf,
-- money lands in an account, revenue is recognised -- and it is therefore the
-- only place in Plan 4 where getting it wrong shows up in a shop's P&L rather
-- than in its order list.
--
-- ── There is exactly one sale-posting path, and it is complete_sale ──────
--
-- This function does not write `sales`, `sale_items`, `sale_payments`,
-- `product_location_stock` or `journal_entries` for the goods. It assembles a
-- payload and calls public.complete_sale (newest definition:
-- 20260908000300_sale_entry_date.sql:79), the same function the register
-- calls. A second posting path would drift from the first -- different COGS
-- rounding, a forgotten discount contra, a different entry date rule -- and
-- nobody would notice until a P&L looked wrong months later. An online order
-- and a counter sale must land in the ledger identically because they ARE the
-- same event: goods left the shop and money came in.
--
-- Three consequences of that choice, all deliberate:
--
--   * NO REGISTER SESSION. p_register_session_id defaults null and every
--     register check in complete_sale sits behind a not-null guard
--     (20260908000300:203-217), so passing none is already supported and is
--     the honest answer: nobody was at a till. A branch with
--     require_open_register set WILL still refuse (that guard is on
--     `p_register_session_id is null`), and that is correct -- see the
--     concern noted at the bottom of this header.
--   * NO LOCATION. p_location_id defaults to the shop's primary location
--     (20260908000300:182-191), which is the same location
--     checkOrderFulfilment (src/lib/storefront-admin.ts, Task 3) resolves
--     when it tells the shop up front which lines it cannot fill. The two
--     must agree, and they agree by both deferring to the same default rather
--     than by both re-deriving it.
--   * COMPLETE_SALE'S OWN PERMISSION STILL APPLIES. It gates on
--     has_shop_permission(shop, 'pos.access'). A shop member who cannot ring
--     up a sale at the counter cannot ring one up through the storefront
--     either, which is the same rule stated once.
--
-- ── The delivery fee: why a SECOND entry, and what was rejected ──────────
--
-- complete_sale takes items and payments. A delivery fee is neither, and
-- there is no parameter for it. Three routes were on the table:
--
--   A. PASS THE FEE AS A SYNTHETIC LINE ITEM. REJECTED, and this is the
--      important rejection. complete_sale prices every line from
--      products.price_cents, decrements product_location_stock for it, freezes
--      products.cost_cents onto the sale line and rolls that into the 5000/1200
--      COGS pair. A fee dressed as a product would therefore need a real
--      products row, would carry stock that could run out, and would post
--      delivery income into 4000 Sales Revenue with a COGS line beside it --
--      which is the precise distortion 20260928000000_delivery_income_account
--      created 4300 to prevent. It would flatter gross margin on every report
--      the accounting work already built, and it would do it invisibly.
--
--   B. POST A SEPARATE, SMALL JOURNAL ENTRY FOR THE FEE. CHOSEN. Two lines,
--      equal and opposite, so it balances by construction rather than by
--      arithmetic that could be got wrong. It touches no shared function, so
--      the register's blast radius is zero. Its cost is that one order's money
--      reaches the books through two entries -- which is why both entries name
--      the sale, and why `orders.sale_id` below ties the order to it in the
--      database rather than only in prose. A reader landing on either entry
--      can find the other.
--
--   C. EXTEND complete_sale WITH A DELIVERY-FEE PARAMETER. Conceptually the
--      cleanest -- one entry, one event -- but it edits the function every
--      till in every shop depends on, for a case only the storefront has. Not
--      taken. If storefront volume ever makes the two-entry split a real
--      reporting problem, C is the upgrade, and B leaves nothing behind that
--      makes it harder: the fee is already isolated in 4300 and already
--      linked to its sale.
--
-- B was tried and it holds: the entry balances (two lines, +fee and -fee) and
-- it ties (description names both the order number and the sale id; the order
-- row names the sale). There was no reason to fall back to C.
--
-- The fee entry's source is 'sale', not a new value. journal_entries.source
-- carries a CHECK constraint (20260904000300_journal.sql:48) listing fourteen
-- literals; 'delivery' is not among them, and adding an enum value to a table
-- that already has rows to describe half of one event is a worse trade than
-- calling it what it is -- money that arrived with a sale. It also keeps the
-- fee out of the 'manual' source, which post_journal_entry gates on
-- ledger.post: a shopkeeper handing over an order must not need a ledger
-- permission.
--
-- ── Why the state machine had to learn one new edge ──────────────────────
--
-- 20260928000100_order_transitions.sql refuses EVERY move to 'completed',
-- deliberately and for exactly one reason, in its own words: "a function here
-- that allowed it would let a shop mark an order done with nothing in the
-- books to show for it". That reason is not weakened here, it is enforced
-- directly. enforce_order_transition is re-created below with `ready ->
-- completed` added to the permitted-moves table AND CONDITIONED ON THE SALE
-- LINK BEING SET IN THE SAME STATEMENT. So:
--
--   * transition_order(order, 'completed') still raises
--     invalid_order_transition -- it sets no sale_id. verify-order-transitions
--     checks 3 and 4 go on passing unchanged, and they are the checks that
--     matter.
--   * A shop member's plain RLS `update orders set status = 'completed'`
--     still raises, for the same reason.
--   * Even a superuser cannot put an order in 'completed' with no sale
--     against it without disabling the trigger, which is exactly the strength
--     the original had.
--
-- What changes is that "an order can never be completed" becomes "an order can
-- never be completed without a sale", which is the invariant the original
-- comment was actually reaching for. Keeping the check in the trigger rather
-- than in this function is the same argument that migration already makes:
-- the trigger fires for every writer, security definer included, so the table
-- is enforced once in one place and a future RPC cannot forget it.
--
-- ── Typed errors, because a shopkeeper reads these ──────────────────────
--
-- complete_sale raises free-text messages written for a developer reading a
-- log: `insufficient stock for Rice at this location: has 1, need 5`,
-- `product  not found in this shop`. Those reach a phone in Hargeisa as a
-- wall of English with a uuid in it. Every failure this function can
-- anticipate is caught and re-raised as a short code with a JSON detail, the
-- same shape enforce_order_transition and place_storefront_order already use,
-- so the client turns it into a sentence in the shopkeeper's own words.
-- Anything NOT anticipated is re-raised untouched (`raise;`) rather than
-- flattened into a generic code -- a swallowed surprise is how a real bug
-- becomes invisible.

-- ── orders.sale_id: which sale this order became ────────────────────────
--
-- ON DELETE SET NULL, not RESTRICT and not CASCADE. Deleting the sale must
-- not delete the order (the order is the customer's record of what they
-- asked for and it still happened), and it must not be BLOCKED by the order
-- either: delete_sale (20260908000900) is a supported operation, and so is
-- delete_shop, whose cascade tears down `sales` and `orders` in one statement
-- in an order Postgres chooses. 20260908001200_delete_shop_fk_ordering.sql is
-- an entire migration about a new FK quietly breaking that cascade; this one
-- takes the same way out that migration took for journal_entries.location_id,
-- and for the same reason -- the link is a reference to something that
-- happened, not part of the order's identity.
alter table public.orders
  add column sale_id uuid references public.sales(id) on delete set null;

-- Belt and braces behind the trigger, the same relationship
-- orders_cancellation_reason_required already has with it: the trigger is what
-- makes a sale-less completion impossible through every door, this is what
-- makes a sale attached to an order that is NOT completed impossible even if
-- the trigger is ever disabled.
alter table public.orders add constraint orders_sale_only_when_completed
  check (sale_id is null or status = 'completed');

-- ── enforce_order_transition, re-created in full ────────────────────────
--
-- Reproduced whole rather than patched, per this repo's convention (see
-- 20260908000150_journal_entry_sequence.sql's header): the newest definition
-- of a function is the whole of it, in one place, so the next reader does not
-- have to replay a chain of substitutions to know what runs.
--
-- Three changes from 20260928000100_order_transitions.sql, all of them here:
--   1. INSERT also forces sale_id to null. A caller who could supply it at
--      insert time could not reach 'completed' with it (status is forced to
--      'pending' on the same line), but leaving a fabricated link on a pending
--      order is a lie in the audit trail for no benefit -- same reasoning as
--      status and cancellation_reason on the line above.
--   2. A sale link, once set, cannot be re-pointed at a DIFFERENT sale. This
--      sits ABOVE the same-status early return on purpose: `update orders set
--      sale_id = <some other sale>` changes no status and would otherwise
--      sail straight past. Re-pointing is how one sale's money could be made
--      to look like it settled two orders. Setting it to NULL is permitted,
--      because that is what the ON DELETE SET NULL above does and refusing it
--      would break delete_sale and delete_shop.
--   3. `ready -> completed` is permitted, and ONLY when the same statement
--      attaches a sale that was not there before. See this migration's header
--      for why this is the honest form of the original refusal rather than a
--      relaxation of it.
create or replace function public.enforce_order_transition()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if TG_OP = 'INSERT' then
    new.status := 'pending';
    new.cancellation_reason := null;
    new.sale_id := null;
    return new;
  end if;

  -- Above the same-status return, deliberately: re-pointing a sale link is
  -- not a status change and would otherwise never be looked at.
  if old.sale_id is not null
     and new.sale_id is not null
     and new.sale_id <> old.sale_id then
    raise exception 'order_sale_is_immutable'
      using errcode = 'P0001',
            detail = json_build_object('from', old.sale_id, 'to', new.sale_id)::text;
  end if;

  -- Not a status change at all -- some other column is being edited (or
  -- nothing changed). Nothing here to validate.
  if new.status is not distinct from old.status then
    return new;
  end if;

  -- Outside the five-word vocabulary: leave it to orders' own status CHECK.
  if new.status not in ('pending', 'accepted', 'ready', 'completed', 'cancelled') then
    return new;
  end if;

  if not (
    (old.status = 'pending'  and new.status = 'accepted') or
    (old.status = 'accepted' and new.status = 'ready') or
    (old.status in ('pending', 'accepted', 'ready') and new.status = 'cancelled') or
    -- The one edge Task 4 adds, and it is not reachable by wanting it: the
    -- same statement has to attach a sale that was not there a moment ago.
    -- transition_order sets no sale_id, a plain RLS update sets no sale_id,
    -- and so neither can complete an order -- which is the whole property
    -- 20260928000100 was protecting.
    (old.status = 'ready' and new.status = 'completed'
       and new.sale_id is not null and old.sale_id is null)
  ) then
    raise exception 'invalid_order_transition'
      using errcode = 'P0001',
            detail = json_build_object('from', old.status, 'to', new.status)::text;
  end if;

  if new.status = 'cancelled' and (new.cancellation_reason is null or btrim(new.cancellation_reason) = '') then
    raise exception 'cancellation_reason_required' using errcode = 'P0001';
  end if;

  return new;
end;
$$;

-- ── complete_storefront_order ───────────────────────────────────────────
--
-- security definer, and so it decides for itself who may call it -- RLS does
-- not protect a security definer function, the same point transition_order's
-- own header makes. Membership and the module gate are checked explicitly,
-- before anything is read or written.
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
    perform public.post_journal_entry(
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
      'sale');
  end if;

  -- Last, and in the same transaction as everything above: a completion that
  -- posts a sale but leaves the order 'ready' is worse than one that fails
  -- cleanly, because the shop's only signal that anything happened is the
  -- order list. The status and the sale link move together, in one statement,
  -- which is also the only shape the trigger accepts.
  update public.orders
     set status = 'completed', sale_id = v_sale_id
   where id = p_order_id;

  return v_sale_id;
end;
$$;

-- ── Grants ──────────────────────────────────────────────────────────────
-- Postgres grants EXECUTE to PUBLIC on every new function, so `grant ... to
-- authenticated` on its own is a no-op dressed as a decision -- anon inherits
-- it through PUBLIC and the grant line looks like it decided something. The
-- revoke goes FIRST. Same gap named at 20260924000100_storefront_public_read
-- .sql:103-109 and at 20260928000100_order_transitions.sql's own grants.
--
-- Never anon. A customer does not hand themselves their own order, and this
-- function posts to the shop's ledger -- there is no session to attribute
-- that to.
revoke execute on function public.complete_storefront_order(uuid, text) from public;
grant execute on function public.complete_storefront_order(uuid, text) to authenticated;
