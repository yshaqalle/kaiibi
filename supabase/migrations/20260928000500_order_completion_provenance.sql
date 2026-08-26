-- Closing the residual half of the money-handling review's Critical finding.
--
-- ## The gap 20260928000300 left open
--
-- That migration revoked `authenticated`'s insert/update/delete on `orders`
-- and `order_items` outright (the real fix) and taught the trigger two data
-- facts as a second, independent layer: the attached sale must belong to the
-- order's own shop, and a sale can settle at most one order. Both hold
-- regardless of privilege -- the trigger fires for any writer -- and both are
-- tested at verify-order-transitions.sql checks 39/40.
--
-- Tested against the actual belt, not just its stated shape: with the revoked
-- grant restored (or as postgres, which is how this file already stands in
-- for that -- see check 15), this still succeeds --
--
--   update orders set status='completed', sale_id='<that shop's OWN,
--     never-used-before sale>' where id='<a ready order>';
--
-- -- because it fails neither check. The same-shop rule passes (it IS the
-- same shop). The one-sale-one-order index passes (first use of that sale).
-- The order reads "completed, reconciled to sale X" and `complete_sale` --
-- the one function that decrements stock, prices the goods and posts the
-- journal entry FOR THIS ORDER -- was never called. Checks 39/40 each prove
-- one guard in isolation (another shop's sale; a sale already used); neither
-- uses a sale that is simultaneously the order's own shop's AND unused,
-- which is exactly what the review's own reproduction did. Check 43 below is
-- that reproduction, run for real.
--
-- The property actually wanted is narrower than "a plausible sale attached by
-- a shop member": only `complete_storefront_order` may move an order to
-- `completed`, full stop, regardless of what privileges exist on `orders`
-- itself.
--
-- ## Why this is NOT a `set_config` marker, even though that is usually right
--
-- The standard way to say "only this function may do this" in Postgres is a
-- transaction-local marker: the function calls `set_config('some.key',
-- <value>, true)` and the trigger requires `current_setting('some.key', true)`
-- to match the row being written. It was the first thing tried here, and it
-- was rejected on inspection, not on style.
--
-- `set_config` and `current_setting` carry NO privilege system for custom
-- (non-builtin) parameter names -- ANY role, `authenticated` included, can
-- call `set_config('some.key', <anything>, true)` for a key it read out of
-- this very file. And the two values a marker would need to name -- the order
-- id and the sale id -- are not secrets: they are exactly the two values
-- already sitting in the attacker's own `update orders set sale_id = ...
-- where id = ...`. A trigger check of the shape "the marker equals the row
-- being written" is therefore satisfiable by the same statement that is
-- supposed to be refused, just preceded by one extra line:
--
--   select set_config('storefront.completing_order', '<the ready order's own
--     id>', true);
--   update orders set status='completed', sale_id='<...>' where id='<...>';
--
-- No choice of key name, no bundling order id with sale id, no random nonce
-- changes this: for ANY predicate comparing a GUC value the attacker can set
-- against column values the attacker is already choosing, the attacker can
-- always choose both to agree. A same-session marker authenticates nothing
-- about WHO set it -- it authenticates only that a value was set, which the
-- attacker can always arrange for themselves. So: yes, `authenticated` can
-- call `set_config`, and no, a marker built on it would not have held. Point
-- 4's question is answered by not building one.
--
-- ## What actually holds: provenance in a table nobody but the owner can touch
--
-- `storefront_order_completions`, created below, records which sale
-- `complete_storefront_order` attached to which order, in which transaction.
-- It gets no grant to `anon` or `authenticated` -- not even SELECT -- which is
-- the exact idiom 20260928000300 already used for `orders`/`order_items`
-- itself (privilege removed outright, not merely checked), applied one level
-- deeper: this table has no policy anyone but its owner could exploit even if
-- a grant were mistakenly added, because it is also created with row level
-- security enabled and NOT ONE policy defined, the same two-independent-
-- layers posture `sales` and every permission-gated table already use
-- (0024_permission_gates.sql). Either layer alone stops `authenticated`; both
-- are here so neither one re-opening by accident (a grant restored, or a
-- stray permissive policy added later) is enough on its own.
--
-- Crucially, this is a SEPARATE grant from the one named in the review. The
-- scenario the task describes -- some future migration re-granting
-- insert/update/delete on `orders` to `authenticated`, copying an old pattern
-- without reading 20260928000300's header -- does nothing to THIS table's own
-- privileges. Reopening this hole again would need a second, independent,
-- much louder act: a migration explicitly granting on
-- `storefront_order_completions` by name, which nothing in this codebase has
-- any legitimate reason to ever do.
--
-- Only `complete_storefront_order` writes here, and it can, because it is
-- `security definer` -- the INSERT below runs as the function's owner, the
-- same reason it can already write `orders` itself without any grant to
-- `authenticated` (20260928000300's own header makes this exact point about
-- the other two writers).
--
-- ## Not leaking across transactions (point 3)
--
-- `xact_id` defaults to `pg_current_xact_id()`, captured at INSERT time. The
-- trigger does not just check that a row exists naming this order and this
-- sale -- it requires that row's `xact_id` to equal the CURRENT transaction's
-- `pg_current_xact_id()`. Postgres transaction ids are monotonically
-- increasing and never reused, so a row stamped by an earlier, already-
-- finished transaction can never equal a later transaction's id. This is what
-- stops a completion mark left behind by one call from authorising an
-- unrelated statement in a different transaction that happens to reuse the
-- same order id and sale id -- checked directly at verify-order-transitions
-- .sql check 44, which manufactures exactly such a stale row (as postgres,
-- the only role that could ever insert one) and proves it does not validate.
--
-- Within ONE transaction, `pg_current_xact_id()` is constant for its whole
-- duration (confirmed against the local stack: a value read before, during
-- and after several statements in the same transaction never changes), so
-- the ordinary path -- insert the mark, then update the order, both inside
-- one call to `complete_storefront_order` -- always sees them agree.
--
-- ## Reproduced whole, not patched
--
-- Per this repo's convention (20260908000150_journal_entry_sequence.sql's
-- header): both functions below are the newest definition of themselves in
-- full, each with exactly one new statement, so the next reader never has to
-- replay a chain of substitutions to know what runs.

-- ── storefront_order_completions: proof, not a claim ────────────────────
create table public.storefront_order_completions (
  order_id uuid primary key references public.orders(id) on delete cascade,
  sale_id  uuid not null references public.sales(id) on delete cascade,
  xact_id  xid8 not null default pg_current_xact_id()
);

alter table public.storefront_order_completions enable row level security;
-- No policy, on purpose -- with row level security enabled and zero policies
-- defined, Postgres denies every row to every role but the table owner for
-- every command, independent of any grant. Nobody but `complete_storefront_
-- order` (SECURITY DEFINER, runs as the owner, RLS never binds the owner
-- unless FORCE ROW LEVEL SECURITY is set, which it deliberately is not here)
-- and the trigger reading it (same reason) has any business with this table.

-- Belt to that layer's own braces: a fresh table in this project already
-- starts with no privilege for `anon`/`authenticated` (verified against the
-- local stack -- 20260818000600_revoke_truncate_from_clients.sql stripped
-- the Supabase bootstrap default that would otherwise hand every new table's
-- TRUNCATE/TRIGGER/REFERENCES to both), but that migration's own header
-- records that the `supabase_admin`-owned default privilege it also tried to
-- strip is allowed to fail silently on a managed project ("postgres is not a
-- member of supabase_admin on a managed project"). Stated here rather than
-- assumed: on a hosted project where that fallback never took, a brand new
-- table could still inherit `grant all` from the ORIGINAL bootstrap default.
-- This line makes the outcome the same everywhere, not merely on a local
-- stack that happens to already be clean.
revoke all on public.storefront_order_completions from anon, authenticated;

-- ── enforce_order_transition, re-created in full ────────────────────────
--
-- One change from 20260928000300_orders_write_lockdown.sql, inside the same
-- `ready -> completed` disjunct: the attached sale must also have a matching
-- row in storefront_order_completions, stamped by the CURRENT transaction.
-- Everything else -- the same-shop check, the immutability check above it,
-- the whole permitted-moves table -- is unchanged.
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
    -- The provenance condition this migration adds, ANDed onto the same-shop
    -- rule from 20260928000300: a sale that genuinely belongs to this shop
    -- and has never settled anything is no longer enough on its own -- there
    -- must ALSO be a row in storefront_order_completions naming this exact
    -- (order, sale) pair, stamped by the transaction that is running right
    -- now. `authenticated` cannot write that row under any grant restored on
    -- `orders` (it has no grant on this table at all, see above), and
    -- complete_storefront_order writes it, as the table owner, in the same
    -- transaction as this very UPDATE.
    (old.status = 'ready' and new.status = 'completed'
       and new.sale_id is not null and old.sale_id is null
       and exists (
         select 1 from public.sales s
          where s.id = new.sale_id and s.shop_id = new.shop_id
       )
       and exists (
         select 1 from public.storefront_order_completions c
          where c.order_id = new.id
            and c.sale_id = new.sale_id
            and c.xact_id = pg_current_xact_id()
       ))
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

-- ── complete_storefront_order, re-created in full ───────────────────────
--
-- One new statement from 20260928000400_delivery_fee_reversal_link.sql's own
-- definition (the newest one before this migration -- NOT 20260928000200's,
-- which this function has not been since 000400 gave it delivery_entry_id):
-- right after complete_sale succeeds and before the delivery-fee posting,
-- the provenance row is written. It has to happen before the final `update
-- orders` below -- that is the statement the trigger's new condition checks
-- it against -- and it has to name the REAL v_sale_id complete_sale just
-- returned, not anything the caller supplied (this function takes no sale id
-- parameter at all; v_sale_id only ever comes from complete_sale's own
-- return value, a few lines up).
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
