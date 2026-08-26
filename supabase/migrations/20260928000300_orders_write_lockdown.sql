-- Closing the hole a money-handling review found: an order can reach
-- 'completed' with nothing posted to the shop's books.
--
-- ## The hole, in full
--
-- 20260926000050_orders.sql granted `authenticated` insert/update/delete on
-- `orders` for a plain-RLS write path that Task 2 onward never ended up
-- using -- place_storefront_order, transition_order and
-- complete_storefront_order are all `security definer` and write through
-- their own privileges, never through a caller's grant. The app's only touch
-- on `orders` today is the single `.select` in listOrders
-- (src/lib/storefront-admin.ts:406-412) -- it never inserts or updates. So
-- the grant was never load-bearing for anything the product does, and it left
-- the "own orders" RLS policy (`for all ... using (is_shop_member(shop_id))`)
-- as a real door: any shop member could reach the table directly and update
-- it however the policy and the CHECK constraints allowed.
--
-- 20260928000200_complete_storefront_order.sql taught the trigger to permit
-- `ready -> completed` "and only when the same statement attaches a sale that
-- was not there before" -- but it checked only that `sale_id` was being set,
-- never WHICH sale. Three consequences, all reachable through that same open
-- door:
--
--   1. NOTHING POSTS. `update orders set status = 'completed', sale_id = <any
--      existing sale> where id = <a ready order>` satisfies the trigger's
--      condition completely. The order reads "completed, reconciled to sale
--      X" and complete_sale -- the one function that decrements stock, prices
--      the goods and posts the journal entry -- was never called.
--   2. THE SALE CAN BE ANOTHER SHOP'S. `sale_id references public.sales(id)`
--      with no shop comparison anywhere -- not the trigger, not a CHECK -- so
--      the sale attached does not even have to belong to the order's own
--      shop.
--   3. ONE SALE CAN SETTLE MANY ORDERS. No unique index sat on `orders.
--      sale_id`, so the same sale id could be written onto a second order
--      once the immutability check (which only blocks RE-pointing an
--      ALREADY-set link) had nothing to say about a still-null one.
--
-- ## The fix, in two layers, on purpose
--
-- Layer 1, the real fix: `authenticated` loses insert/update/delete on
-- `orders` and `order_items` outright. `transition_order` and
-- `complete_storefront_order` are `security definer` -- they run as this
-- migration's owner, not as the calling role, so neither one needs the grant
-- being removed here. place_storefront_order is `security definer` too and
-- was never granted a table privilege to begin with
-- (20260927000000_place_order.sql's own grants comment: "no table grant is
-- added here, to anon or to anyone"). So after this migration the ONLY ways
-- to change a row in `orders` are those three functions, each of which
-- decides for itself who may call it before it writes anything. SELECT is
-- untouched -- listOrders and checkOrderFulfilment both still read the table
-- directly and must keep doing so.
--
-- Layer 2, belt to that layer's braces: a grant is one `grant` statement away
-- from being silently reintroduced by some future migration that copies an
-- old pattern without reading this comment. So the trigger itself is taught
-- the two invariants a grant can never encode: the attached sale must belong
-- to the SAME shop as the order, and a sale, once attached, occupies exactly
-- one order. Both hold even for a caller who bypasses every grant and every
-- policy there is -- the trigger fires for any writer, superuser included,
-- which is the same argument 20260928000100's own header makes for keeping
-- the permitted-moves table in the trigger rather than in transition_order.
--
-- ## Why insert is included in the revoke and not left alone
--
-- The three writers between them cover every legitimate insert
-- (place_storefront_order, the only door that creates an order) and every
-- legitimate update (transition_order, complete_storefront_order). There is
-- no supported path where a shop member inserts an order row directly --
-- Task 1's header describes the plain-RLS insert as infrastructure for "Task
-- 2, present and future", and Task 2 turned out to need none of it. Leaving
-- INSERT granted while revoking UPDATE/DELETE would still let any shop member
-- forge an order at an arbitrary status by inserting around
-- orders_status_transition's INSERT branch being the only thing stopping
-- them -- the same class of gap this migration exists to close, just moved
-- one verb over. So all three go.
--
-- ── What breaks if a future migration re-grants this ────────────────────
--
-- These two lines are the ENTIRE reason `transition_order` and
-- `complete_storefront_order` are the only doors onto this table. Undo them
-- -- even innocuously, by a future migration that copies an old
-- `grant insert, update, delete on public.orders to authenticated` pattern
-- without reading this far -- and Layer 1 is gone: any shop member can once
-- again write `orders`/`order_items` directly, through the "own orders" RLS
-- policy this migration deliberately left standing (it was never the real
-- defence, this revoke was).
--
-- Layer 2 does NOT fully cover for that. The same-shop and one-sale-one-order
-- checks below stop a re-granted `authenticated` from attaching another
-- shop's sale, or the same sale twice -- but NOT from attaching one of the
-- shop's OWN, never-used sales to mark a `ready` order 'completed' with
-- nothing posted for the order's own goods. That residual hole -- the exact
-- reproduction from the money-handling review -- is what
-- 20260928000500_order_completion_provenance.sql closes, with a check that
-- does not depend on any grant here either. Restoring the grant on `orders`
-- still degrades this table back to plain-RLS reachability for everything
-- Layer 2 does NOT independently re-derive (see that migration's header for
-- the rest), so restoring it is still a real regression, not a harmless
-- convenience -- just no longer a way to complete an order for free.
revoke insert, update, delete on public.orders from authenticated;
revoke insert, update, delete on public.order_items from authenticated;

-- ── enforce_order_transition, re-created in full ────────────────────────
--
-- Reproduced whole, per this repo's convention -- see
-- 20260908000150_journal_entry_sequence.sql's header. Two changes from
-- 20260928000200_complete_storefront_order.sql, both inside the one branch
-- that permits `ready -> completed`:
--
--   * the attached sale must belong to `new.shop_id`. Checked with `exists`
--     rather than pulled into a variable and compared, so a sale id that does
--     not exist at all is refused by the exact same branch as one that
--     exists but belongs to somebody else -- there is no separate "sale not
--     found" case to keep in step with this one.
--   * that shop-match condition sits INSIDE the disjunct that permits the
--     move, not as a separate raise beforehand: an order failing it falls
--     through to the same generic `invalid_order_transition` every other
--     illegal edge raises, rather than teaching a caller which shop a sale id
--     they should never have been able to guess belongs to.
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
    -- The sale-link condition from 20260928000200, now ALSO requiring the
    -- sale to be this order's own shop's -- the review's finding 2. A sale
    -- from another shop, or a sale id that resolves to nothing at all, both
    -- fail the `exists` and fall through to invalid_order_transition below,
    -- exactly as a missing sale_id already did.
    (old.status = 'ready' and new.status = 'completed'
       and new.sale_id is not null and old.sale_id is null
       and exists (
         select 1 from public.sales s
          where s.id = new.sale_id and s.shop_id = new.shop_id
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

-- ── one sale settles at most one order ──────────────────────────────────
--
-- The review's finding 3. `orders_sale_only_when_completed` already proves a
-- sale link cannot exist without `status = 'completed'`, and the immutability
-- check above already stops a SET sale_id from being re-pointed -- but
-- neither one stops the SAME sale id from being written, for the first time,
-- onto a SECOND order. This is what does: a partial unique index, so two
-- orders can each carry `sale_id is null` (the ordinary case, for every order
-- that has not been completed yet) without colliding, and the moment a
-- second order tries to claim a sale id already sitting on another order's
-- row, the insert/update fails on this index rather than silently
-- succeeding.
create unique index orders_sale_id_key on public.orders(sale_id) where sale_id is not null;
