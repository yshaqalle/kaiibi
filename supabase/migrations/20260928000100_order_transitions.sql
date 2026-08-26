-- The order state machine: the moves a shop makes that touch nothing.
--
-- 20260926000050_orders.sql committed to the vocabulary (pending, accepted,
-- ready, completed, cancelled) and the starting point (pending) but left
-- every move between them to Plan 4. This migration is those moves, minus
-- one: completing an order. Task 4 owns `ready -> completed` alone, because
-- that is the single move that writes a sale into the ledger, and a
-- function here that allowed it would let a shop mark an order done with
-- nothing in the books to show for it. So 'completed' is not merely refused
-- as a destination -- it is simply never listed as one. Omitted, not
-- special-cased: there is one fewer place a future edit could quietly
-- re-open it.
--
-- ── The table itself ────────────────────────────────────────────────────
--   pending  -> accepted
--   accepted -> ready
--   {pending, accepted, ready} -> cancelled
-- Everything else -- backwards, out of either terminal state (cancelled or
-- the completed a forced row might carry once Task 4 exists), or a hop
-- straight to completed -- is refused.
--
-- ── Where the table lives: a trigger, not just the function ────────────
-- `orders` already carries an RLS policy from Task 1 ("own orders") that
-- lets any shop member UPDATE any column of their shop's orders directly,
-- status included -- that policy is not being narrowed here, and does not
-- need to be. transition_order below is security definer and is the
-- intended door, but a trigger is what makes the table itself honest
-- regardless of which door a write comes through, the same reasoning
-- orders_module already applies to the module gate (that trigger's own
-- comment: "the only thing that also covers the plain RLS ... path, and it
-- cannot be skipped by a future RPC that forgets to"). enforce_order_
-- transition applies to BOTH the RLS path and transition_order's own
-- UPDATE -- Postgres triggers fire for every writer, security definer
-- included -- so the permitted-moves table above is enforced once, in one
-- place, for anyone who can reach the row at all. This is also why
-- transition_order's own body does not re-encode the table: duplicating it
-- in two places is exactly the kind of drift a later edit gets subtly
-- wrong in one copy and not the other.
--
-- A value outside the five-word vocabulary entirely (a typo, a stale
-- client) is deliberately NOT this trigger's problem. It steps aside and
-- lets orders' own `status` CHECK constraint (unchanged since Task 1) raise
-- check_violation, exactly as it already did before this migration existed
-- -- see verify-orders.sql check 12. Folding unknown-value handling into
-- this trigger too would just be re-implementing that CHECK badly.
--
-- ── Same-state is a no-op, not an error ─────────────────────────────────
-- transition_order(order, 'accepted') on an order already 'accepted'
-- returns the row unchanged rather than raising. This is a deliberate
-- choice, not an oversight: a shop's phone on a bad connection retries, and
-- the retry should read as "yes, done" rather than a scary error for
-- something that already happened. It is also not really a "move" at all
-- -- the table above has no entry that starts and ends on the same state,
-- so treating a same-state call as outside that table, rather than a
-- rejected member of it, is the more honest reading. This decision lives in
-- transition_order alone (see below for why it cannot live in the trigger:
-- SQL cannot tell "caller explicitly set status to what it already was"
-- apart from "caller did not touch status at all", and the second one must
-- keep working -- editing an order's customer_name must not trip a
-- transition guard).
--
-- ── Cancellation always says why ────────────────────────────────────────
-- The shop will be asked what happened on the phone weeks later, so
-- cancellation_reason is required, trimmed, and enforced twice: by the
-- trigger (the ordinary path) and by a table CHECK (orders_cancellation_
-- reason_required, below) that holds even if the trigger is ever disabled
-- -- the same belt-and-braces relationship verify-orders.sql already proves
-- between orders_assign_number and unique(shop_id, number).
--
-- ── A client cannot fabricate a finished order from birth ───────────────
-- The trigger also runs BEFORE INSERT and forces status to 'pending' and
-- cancellation_reason to null on every new row, exactly the way
-- orders_copy_payment_mode already overrides a client-supplied payment_mode
-- (20260926000050_orders.sql) -- a status accepted from the caller at
-- insert time would let a shop write an order straight into 'completed' or
-- 'cancelled', skipping this whole state machine and, for 'completed',
-- skipping Task 4's ledger post entirely.

alter table public.orders add column cancellation_reason text;

alter table public.orders add constraint orders_cancellation_reason_required
  check (status <> 'cancelled' or (cancellation_reason is not null and btrim(cancellation_reason) <> ''));

create or replace function public.enforce_order_transition()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if TG_OP = 'INSERT' then
    new.status := 'pending';
    new.cancellation_reason := null;
    return new;
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
    (old.status in ('pending', 'accepted', 'ready') and new.status = 'cancelled')
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

create trigger orders_status_transition
  before insert or update on public.orders
  for each row execute function public.enforce_order_transition();

-- ── transition_order ────────────────────────────────────────────────────
-- Authorization and lookup live here, deliberately duplicated from nothing:
-- this function is security definer, so it bypasses the "own orders" RLS
-- policy entirely and must decide for itself who may call it, the same way
-- complete_sale/edit_sale/delete_sale (0018_staff_shop_access.sql) already
-- do for their own tables. is_shop_member and shop_has_module are called
-- explicitly for that reason -- RLS does not protect this function, and
-- orders_module (20260926000050_orders.sql) only re-confirms the module
-- gate after the fact, on the write itself.
--
-- The permitted-moves table itself is NOT re-checked here -- see this
-- migration's header for why that lives in the trigger alone. This
-- function's own job is: who is allowed to ask, and (for a same-state call)
-- whether there is anything to do at all.
create or replace function public.transition_order(
  p_order_id             uuid,
  p_status               text,
  p_cancellation_reason  text default null
) returns public.orders
language plpgsql security definer set search_path = public as $$
declare
  v_order public.orders%rowtype;
begin
  select * into v_order from public.orders where id = p_order_id for update;
  if v_order.id is null then
    raise exception 'order % not found', p_order_id;
  end if;

  if not public.is_shop_member(v_order.shop_id) then
    raise exception 'not authorized for order %', p_order_id;
  end if;
  if not public.shop_has_module(v_order.shop_id, 'storefront') then
    raise exception 'module_not_included' using errcode = 'P0001';
  end if;

  if p_status is null then
    raise exception 'status_required' using errcode = 'P0001';
  end if;

  -- Same-state: see the header. Nothing to do, nothing to raise.
  if p_status = v_order.status then
    return v_order;
  end if;

  update public.orders
    set status = p_status,
        cancellation_reason = case
          when p_status = 'cancelled' then nullif(btrim(p_cancellation_reason), '')
          else cancellation_reason
        end
    where id = p_order_id
    returning * into v_order;

  return v_order;
end;
$$;

-- ── Grants ──────────────────────────────────────────────────────────────
-- Postgres grants EXECUTE to PUBLIC on every new function, so `grant ... to
-- authenticated` alone would be a no-op dressed as a decision -- the same
-- gap 20260924000100_storefront_public_read.sql:103 and
-- 20260927000000_place_order.sql's own grants comment both name. The
-- revoke goes first. Never anon: a customer does not move their own order,
-- and has no session to attribute the move to if they somehow could.
revoke execute on function public.transition_order(uuid, text, text) from public;
grant execute on function public.transition_order(uuid, text, text) to authenticated;
