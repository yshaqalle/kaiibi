-- orders and order_items: the schema a customer's cart lands in.
--
-- Same shape as verify-storefront.sql -- one DO block, EXCEPTION rolls
-- everything back, so it leaves no rows behind.
--
-- What this checks, and why each one is here:
--   1/2. the per-shop number starts at 1 and increments -- proven by inserting
--        twice for the same shop, then once for a second shop to prove the
--        counter is per-shop, not global.
--   3.   the anti-collision constraint that backs the number, isolated from
--        the trigger that would otherwise make it un-forceable -- same
--        disable-trigger technique verify-balances.sql uses at line 1242.
--   4/5. a negative quantity is rejected, and a positive one round-trips.
--   6.   the snapshot pattern: deleting a product null-safes order_items and
--        keeps the name/price it sold at, same as sale_items.
--   7/8. payment_mode is COPIED from storefronts at insert -- a client value
--        is silently overridden, then (trigger disabled) the CHECK behind it
--        is proven for real, same disable-trigger technique as check 3.
--   9/10. fulfilment <-> delivery_area/fee agreement.
--   11.  total_cents must equal subtotal + delivery -- the arithmetic
--        invariant a broken checkout would otherwise violate silently.
--   12.  status starts 'pending' and is CHECK-constrained.
--   13.  customer_phone must be E.164.
--   14/15. the grants this whole feature has twice shipped without: anon gets
--        nothing on either table, authenticated gets SELECT ONLY --
--        20260928000300_orders_write_lockdown.sql revoked insert/update/
--        delete after the money-handling review found a shop member could
--        reach `orders` through the "own orders" RLS policy directly and
--        complete an order with an arbitrary sale attached and nothing
--        posted -- and (belt and braces, matching verify-storefront.sql's
--        own check 8) both anon's refusal and authenticated's are proven for
--        real against Postgres, not merely un-granted on paper.
--   16.  anon holds no privilege at all on order_number_counters -- the same
--        class of gap as 14/15, for the table backing the order number that
--        Task 2's rate-limit lock (20260927000000_place_order.sql) now takes
--        BEFORE anything else touches this shop's row.
--   17.  to_e164 is granted to nobody, not even anon or authenticated --
--        place_storefront_order calls it as the function's owner and no
--        caller needs a grant of its own. This is the exact class of bug
--        that has shipped twice on this feature: a future
--        `drop function ... ` and recreate silently restores PUBLIC EXECUTE,
--        and nothing else here would notice.
--   18.  orders_module (20260926000050_orders.sql) refuses an insert for a
--        shop whose plan does not include the storefront module -- otherwise
--        the trigger's existence is only implied by every test shop here
--        happening to be on a plan that carries it.
--
-- ── place_storefront_order (20260927000000_place_order.sql) ──────────────
--
-- Checks 19-33 cover the application's FIRST UNAUTHENTICATED WRITE, so they
-- are written as attacks rather than as feature demos. Each one is a
-- defence, and the thing it defends against is named in its comment.
--
--   19.  anon holds EXECUTE on the function -- the whole anonymous path is
--        that one grant, and Postgres's default is to hand EXECUTE to PUBLIC,
--        so a `grant ... to anon` with no `revoke ... from public` in front of
--        it is a no-op that looks like a grant. This check is what goes red
--        when the grant is removed; if it does not, the revoke is missing.
--   20.  the happy path, priced by the SERVER: the returned figures and the
--        stored row are computed from products, and the phone is normalised.
--   21.  a client-supplied price is ignored, not honoured -- otherwise anyone
--        can grant themselves any discount they like.
--   22.  a product from ANOTHER shop fails the whole order, and writes
--        nothing. Not "is skipped": a silently shortened order is a customer
--        charged for something they did not receive.
--   23.  an unlisted product fails the whole order the same way.
--   24.  a quantity of zero or less, and an empty cart, are refused.
--   25.  an unknown delivery area is REJECTED, never defaulted to a zero fee.
--        Free delivery nobody authorised is a real loss.
--   26.  a known area's fee is looked up at order time and snapshotted, and
--        the total is subtotal + that fee -- and the area name stored on the
--        order is the SHOP's own (a.name), not the string the client sent to
--        find it, so a future case-insensitive lookup cannot store a casing
--        the shop never published.
--   27.  an unpublished shop and an unknown slug are refused with the SAME
--        message -- distinguishing them turns checkout into a slug oracle,
--        which is the thing 20260924000100's header refuses to build.
--   28.  a phone that will not normalise is refused; it is the only way the
--        shop reaches this customer.
--   29.  stock is neither reserved nor decremented, and ordering more than
--        the shop holds is allowed (Plan 4 owns fulfilment). The alternative
--        lets anyone empty a shop's shelves from a browser.
--   30.  the rate limit trips.
--   31.  and it is a WINDOW, not a lifetime cap -- orders older than the
--        window do not count, so a shop that succeeds is not locked out of
--        its own storefront forever.
--   32.  an internal failure surfaces as a fixed, generic message: no
--        constraint name, no shop id, nothing the customer cannot act on.
--   33.  a de-entitled shop stops taking orders, refused identically to 27.
--        Left last of the checks that use the storefront shop, because it
--        moves that shop onto the Free plan.
--
-- ── get_public_storefront's pick-up address (20261010000100) ────────────
--
--   34.  the public page can say WHERE to collect from. A shop that does not
--        deliver renders no fulfilment choice at all (checkout-form.tsx), so
--        the order is placed as a collection the customer was never told
--        about, to an address they were never given. This asserts the RPC
--        carries the PRIMARY location's address, that a shop which has not
--        filled one in gets null rather than a sibling branch's address or
--        an empty string, and that `is_primary` beats `created_at` -- proven
--        with a decoy location inserted FIRST, so dropping `is_primary desc`
--        from the ordering makes this red rather than leaving it green.
--
--        It builds its own shop. Check 33 above takes the storefront module
--        off v_store_id, and get_public_storefront returns nothing for a shop
--        without it -- a check that borrowed that shop would be asserting
--        against zero rows.

\set ON_ERROR_STOP on

do $$
declare
  v_user_id    uuid := gen_random_uuid();
  v_shop_id    uuid;
  v_shop2_id   uuid;
  v_product_id uuid;
  v_order1_id  uuid;
  v_number     integer;
  v_payment_mode text;
  v_raised     boolean;
  v_free_id    uuid;
  -- place_storefront_order fixtures (checks 19-33)
  v_store_id    uuid;   -- published, entitled, offers delivery
  v_draft_id    uuid;   -- has a slug, never published
  v_burst_id    uuid;   -- for the rate limit
  v_aged_id     uuid;   -- for the rate-limit WINDOW
  v_prod_a      uuid;
  v_prod_b      uuid;
  v_prod_hidden uuid;   -- listed = false, same shop
  v_prod_other  uuid;   -- listed = true, DIFFERENT shop
  v_prod_extra  uuid;   -- the rate-limit shops' one listed product
  v_prod_bulk   uuid;   -- check 29's, touched by nothing else
  v_result      jsonb;
  v_order_id    uuid;
  v_count       integer;
  v_before      integer;
  v_stock       integer;
  v_i           integer;
  v_msg_unknown  text;  -- check 27's shared "this shop is not taking orders"
  v_msg_draft    text;
  v_msg_internal text;
  -- Check 34's own fixture. Not v_store_id: check 33 takes that shop off the
  -- plan, and this check has to read a page that is still public.
  v_collect_id   uuid;   -- collection-only, published, entitled
  v_collect_addr text;
  -- Keep in step with the constants of the same name in
  -- 20260927000000_place_order.sql. They are duplicated here on purpose: a
  -- test that reads the limit out of the function under test would pass
  -- whatever the limit became, including 30000.
  c_rate_limit  constant integer := 30;
begin
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
    values (v_user_id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            'verify-orders-' || v_user_id || '@example.test', '', now(), now(), now());

  insert into public.shops (owner_id, name) values (v_user_id, 'Xamdi Electronics') returning id into v_shop_id;
  insert into public.shops (owner_id, name) values (v_user_id, 'Second Branch') returning id into v_shop2_id;

  insert into public.storefronts (shop_id) values (v_shop_id);
  insert into public.storefronts (shop_id) values (v_shop2_id);

  -- ------------------------------------------------ 1. a shop's first order is number 1
  insert into public.orders (shop_id, customer_name, customer_phone, fulfilment, subtotal_cents, total_cents)
    values (v_shop_id, 'Ahmed', '+252634000001', 'collect', 1000, 1000)
    returning id, number into v_order1_id, v_number;
  if v_number <> 1 then
    raise exception 'FAIL: a shop''s first order was not number 1 (got %)', v_number;
  end if;

  -- ------------------------------------------------ 2. the same shop's second order increments
  insert into public.orders (shop_id, customer_name, customer_phone, fulfilment, subtotal_cents, total_cents)
    values (v_shop_id, 'Hodan', '+252634000002', 'collect', 500, 500)
    returning number into v_number;
  if v_number <> 2 then
    raise exception 'FAIL: a shop''s second order was not number 2 (got %)', v_number;
  end if;

  -- a second shop starts its own numbering at 1 -- proves the counter is
  -- per-shop, not a single global sequence shared across tenants.
  insert into public.orders (shop_id, customer_name, customer_phone, fulfilment, subtotal_cents, total_cents)
    values (v_shop2_id, 'Faisal', '+252634000003', 'collect', 700, 700)
    returning number into v_number;
  if v_number <> 1 then
    raise exception 'FAIL: a second shop did not start its own numbering at 1 (got %) -- numbering is global, not per-shop', v_number;
  end if;

  -- ------------------------------------------------ 3. two orders for one shop cannot hold the same number
  -- The trigger that assigns `number` always wins, so the only way to reach
  -- the constraint behind it is to turn the trigger off and force a
  -- duplicate by hand -- proving unique(shop_id, number) is real, not just
  -- something the trigger happens to never violate.
  alter table public.orders disable trigger orders_assign_number;
  v_raised := false;
  begin
    insert into public.orders (shop_id, number, customer_name, customer_phone, fulfilment, subtotal_cents, total_cents)
      values (v_shop_id, 1, 'Duplicate', '+252634000004', 'collect', 100, 100);
  exception when unique_violation then v_raised := true;
  end;
  alter table public.orders enable trigger orders_assign_number;
  if not v_raised then
    raise exception 'FAIL: two orders for the same shop were allowed to hold the same number';
  end if;

  -- ------------------------------------------------ 4. a negative quantity is rejected
  v_raised := false;
  begin
    insert into public.order_items (order_id, product_name, unit_price_cents, quantity, line_total_cents)
      values (v_order1_id, 'Widget', 100, -1, -100);
  exception when check_violation then v_raised := true;
  end;
  if not v_raised then
    raise exception 'FAIL: a negative quantity order_item was accepted';
  end if;

  -- ------------------------------------------------ 5. a positive quantity round-trips
  insert into public.order_items (order_id, product_name, unit_price_cents, quantity, line_total_cents)
    values (v_order1_id, 'Widget', 100, 3, 300);
  if (select quantity from public.order_items where order_id = v_order1_id and product_name = 'Widget') <> 3 then
    raise exception 'FAIL: order_item quantity did not round-trip';
  end if;

  -- ------------------------------------------------ 6. the snapshot survives the product being deleted
  insert into public.products (shop_id, name, price_cents, stock)
    values (v_shop_id, 'Snapshot Widget', 250, 10) returning id into v_product_id;
  insert into public.order_items (order_id, product_id, product_name, unit_price_cents, quantity, line_total_cents)
    values (v_order1_id, v_product_id, 'Snapshot Widget', 250, 2, 500);

  delete from public.products where id = v_product_id;

  if (select product_id from public.order_items where order_id = v_order1_id and product_name = 'Snapshot Widget') is not null then
    raise exception 'FAIL: order_item.product_id was not null-ed when its product was deleted';
  end if;
  if (select unit_price_cents from public.order_items where order_id = v_order1_id and product_name = 'Snapshot Widget') <> 250 then
    raise exception 'FAIL: order_item lost its price snapshot when the product was deleted';
  end if;

  -- ------------------------------------------------ 7. payment_mode is copied, not accepted from the caller
  insert into public.orders (shop_id, customer_name, customer_phone, fulfilment, payment_mode, subtotal_cents, total_cents)
    values (v_shop_id, 'Sneaky', '+252634000005', 'collect', 'online', 100, 100)
    returning payment_mode into v_payment_mode;
  if v_payment_mode <> 'on_collection' then
    raise exception 'FAIL: a client-supplied payment_mode overrode the storefront''s value (got %)', v_payment_mode;
  end if;

  -- ------------------------------------------------ 8. the CHECK behind it, isolated the same way as check 3
  alter table public.orders disable trigger orders_copy_payment_mode;
  v_raised := false;
  begin
    insert into public.orders (shop_id, customer_name, customer_phone, fulfilment, payment_mode, subtotal_cents, total_cents)
      values (v_shop_id, 'Sneaky2', '+252634000006', 'collect', 'online', 100, 100);
  exception when check_violation then v_raised := true;
  end;
  alter table public.orders enable trigger orders_copy_payment_mode;
  if not v_raised then
    raise exception 'FAIL: payment_mode ''online'' was accepted before online payment exists';
  end if;

  -- ------------------------------------------------ 9. a collect order cannot carry a delivery area or fee
  v_raised := false;
  begin
    insert into public.orders (shop_id, customer_name, customer_phone, fulfilment, delivery_area, subtotal_cents, total_cents)
      values (v_shop_id, 'X', '+252634000007', 'collect', 'Some Area', 100, 100);
  exception when check_violation then v_raised := true;
  end;
  if not v_raised then
    raise exception 'FAIL: a collect order was allowed to carry a delivery area';
  end if;

  -- ------------------------------------------------ 10. a deliver order must name an area
  v_raised := false;
  begin
    insert into public.orders (shop_id, customer_name, customer_phone, fulfilment, subtotal_cents, total_cents)
      values (v_shop_id, 'X', '+252634000008', 'deliver', 100, 100);
  exception when check_violation then v_raised := true;
  end;
  if not v_raised then
    raise exception 'FAIL: a deliver order without a delivery area was accepted';
  end if;

  -- ------------------------------------------------ 11. total must equal subtotal + delivery fee
  v_raised := false;
  begin
    insert into public.orders (shop_id, customer_name, customer_phone, fulfilment, subtotal_cents, delivery_fee_cents, total_cents)
      values (v_shop_id, 'X', '+252634000009', 'collect', 100, 0, 999);
  exception when check_violation then v_raised := true;
  end;
  if not v_raised then
    raise exception 'FAIL: total_cents that does not equal subtotal + delivery was accepted';
  end if;

  -- ------------------------------------------------ 12. status starts pending and is constrained
  if (select status from public.orders where id = v_order1_id) <> 'pending' then
    raise exception 'FAIL: a new order''s default status is not pending';
  end if;
  v_raised := false;
  begin
    update public.orders set status = 'made_up_status' where id = v_order1_id;
  exception when check_violation then v_raised := true;
  end;
  if not v_raised then
    raise exception 'FAIL: an unknown status was accepted';
  end if;

  -- ------------------------------------------------ 13. customer_phone must be E.164
  v_raised := false;
  begin
    insert into public.orders (shop_id, customer_name, customer_phone, fulfilment, subtotal_cents, total_cents)
      values (v_shop_id, 'X', '0634000000', 'collect', 100, 100);
  exception when check_violation then v_raised := true;
  end;
  if not v_raised then
    raise exception 'FAIL: a non-E.164 phone number was accepted';
  end if;

  -- ------------------------------------------------ 14. anon has no table privilege on either table
  if has_table_privilege('anon', 'public.orders', 'SELECT') then
    raise exception 'FAIL: anon can select from orders';
  end if;
  if has_table_privilege('anon', 'public.orders', 'INSERT') then
    raise exception 'FAIL: anon can insert into orders';
  end if;
  if has_table_privilege('anon', 'public.order_items', 'SELECT') then
    raise exception 'FAIL: anon can select from order_items';
  end if;
  if has_table_privilege('anon', 'public.order_items', 'INSERT') then
    raise exception 'FAIL: anon can insert into order_items';
  end if;

  -- Belt and braces, matching verify-storefront.sql check 8: a grant that
  -- exists on paper but is somehow ineffective would still pass the
  -- has_table_privilege checks above, so also prove Postgres itself refuses
  -- anon at the table.
  set local role anon;
  v_raised := false;
  begin
    perform 1 from public.orders limit 1;
  exception when insufficient_privilege then v_raised := true;
  end;
  reset role;
  if not v_raised then
    raise exception 'FAIL: anon could read the orders table directly';
  end if;

  -- ------------------------------------------------ 15. authenticated can only SELECT -- every write goes through a security-definer function
  -- 20260928000300_orders_write_lockdown.sql (the money-handling review's
  -- Critical fix): a shop member could otherwise reach `orders` through the
  -- "own orders" RLS policy directly and mark an order 'completed' with an
  -- arbitrary sale attached and nothing posted to the ledger --
  -- verify-order-transitions.sql checks 40-42 reproduce that hole and prove
  -- it is now refused. listOrders (src/lib/storefront-admin.ts) is the
  -- app's only touch on this table and it only ever selects, so SELECT is
  -- the only grant with anything real depending on it.
  if not has_table_privilege('authenticated', 'public.orders', 'SELECT') then
    raise exception 'FAIL: authenticated cannot select from orders -- RLS policies without a table grant are decorative';
  end if;
  if has_table_privilege('authenticated', 'public.orders', 'INSERT') then
    raise exception 'FAIL: authenticated can insert into orders directly -- place_storefront_order is the only insert door and needs no grant of its own (it is security definer)';
  end if;
  if has_table_privilege('authenticated', 'public.orders', 'UPDATE') then
    raise exception 'FAIL: authenticated can update orders directly -- transition_order/complete_storefront_order are the only doors and need no grant of their own (both security definer)';
  end if;
  if has_table_privilege('authenticated', 'public.orders', 'DELETE') then
    raise exception 'FAIL: authenticated can delete from orders directly';
  end if;
  if not has_table_privilege('authenticated', 'public.order_items', 'SELECT') then
    raise exception 'FAIL: authenticated cannot select from order_items';
  end if;
  if has_table_privilege('authenticated', 'public.order_items', 'INSERT')
     or has_table_privilege('authenticated', 'public.order_items', 'UPDATE')
     or has_table_privilege('authenticated', 'public.order_items', 'DELETE') then
    raise exception 'FAIL: authenticated holds a write privilege on order_items -- place_storefront_order is the only writer and needs no grant of its own';
  end if;

  -- Belt and braces, same technique as check 14's anon proof: a grant that
  -- is somehow still effective (a future migration re-adding it, say) would
  -- pass the has_table_privilege checks above being absent and still fail
  -- here, for real, against Postgres itself.
  set local role authenticated;
  v_raised := false;
  begin
    insert into public.orders (shop_id, customer_name, customer_phone, fulfilment, subtotal_cents, total_cents)
      values (v_shop_id, 'Direct Insert Attempt', '+252634199999', 'collect', 100, 100);
  exception when insufficient_privilege then v_raised := true;
  end;
  reset role;
  if not v_raised then
    raise exception 'FAIL: authenticated could insert into orders directly';
  end if;

  set local role authenticated;
  v_raised := false;
  begin
    update public.orders set customer_name = 'Direct Update Attempt' where id = v_order1_id;
  exception when insufficient_privilege then v_raised := true;
  end;
  reset role;
  if not v_raised then
    raise exception 'FAIL: authenticated could update orders directly';
  end if;

  -- ------------------------------------------------ 16. anon holds no privilege at all on order_number_counters
  -- The same class of gap 14/15 closed for orders and order_items, for the
  -- table finding 1's rate-limit lock (20260927000000_place_order.sql) now
  -- takes a row lock on before anything else runs. A lock is only a boundary
  -- if the table underneath it stays shut to the caller it is meant to slow
  -- down.
  if has_table_privilege('anon', 'public.order_number_counters', 'SELECT')
     or has_table_privilege('anon', 'public.order_number_counters', 'INSERT')
     or has_table_privilege('anon', 'public.order_number_counters', 'UPDATE')
     or has_table_privilege('anon', 'public.order_number_counters', 'DELETE') then
    raise exception 'FAIL: anon holds a table privilege on order_number_counters';
  end if;

  -- Belt and braces, the same technique as check 14: prove Postgres itself
  -- refuses anon at the table, not merely that no grant exists on paper.
  set local role anon;
  v_raised := false;
  begin
    perform 1 from public.order_number_counters limit 1;
  exception when insufficient_privilege then v_raised := true;
  end;
  reset role;
  if not v_raised then
    raise exception 'FAIL: anon could read order_number_counters directly';
  end if;

  -- ------------------------------------------------ 17. to_e164 is granted to nobody
  -- Not anon, not authenticated -- place_storefront_order calls it as the
  -- function's own owner, so no caller needs a grant of its own
  -- (20260927000000_place_order.sql's grants comment). This is the exact
  -- class of bug that has shipped twice on this feature already: a future
  -- `drop function ... ` and recreate silently restores PUBLIC EXECUTE, and
  -- nothing else in this file would notice. Checked against both roles, not
  -- just anon, because an accidental grant to authenticated would slip past
  -- a check that only asked about anon.
  if has_function_privilege('anon', 'public.to_e164(text)', 'EXECUTE') then
    raise exception 'FAIL: anon can execute to_e164 directly';
  end if;
  if has_function_privilege('authenticated', 'public.to_e164(text)', 'EXECUTE') then
    raise exception 'FAIL: authenticated can execute to_e164 directly';
  end if;

  -- Belt and braces, same technique as check 14 and this section's check 16:
  -- a grant that exists on paper but is somehow ineffective would still pass
  -- the has_function_privilege checks above.
  set local role anon;
  v_raised := false;
  begin
    perform public.to_e164('0634000000');
  exception when insufficient_privilege then v_raised := true;
  end;
  reset role;
  if not v_raised then
    raise exception 'FAIL: anon could call to_e164 directly, not only through place_storefront_order';
  end if;

  -- ------------------------------------------------ 18. an order is refused for a shop whose plan lacks storefront
  -- Move the second shop off whatever plan the seed put it on and onto Free,
  -- which 20260923000000_storefront_module_grant.sql deliberately does not
  -- grant storefront to. shop_has_module is asserted directly first so the
  -- setup is proven, not assumed -- if Free ever gained the module the insert
  -- below would silently succeed and this check would pass for the wrong
  -- reason.
  select id into v_free_id from public.plans where key = 'free';
  update public.shop_subscriptions
  set plan_id = v_free_id, current_period_end = now() + interval '30 days'
  where shop_id = v_shop2_id;

  if public.shop_has_module(v_shop2_id, 'storefront') then
    raise exception 'FAIL: a shop moved to the Free plan still has the storefront module';
  end if;

  -- The trigger raises a fixed message ('module_not_included', see
  -- enforce_shop_module in 20260818000400_module_write_gates.sql) rather than
  -- a distinct SQLSTATE, so catching `others` and checking sqlerrm is how
  -- this check tells the trigger's refusal apart from any other failure --
  -- a bare `when others` here would pass just as well if the insert failed
  -- for an unrelated reason, which is exactly the gap this check exists to
  -- close.
  v_raised := false;
  begin
    insert into public.orders (shop_id, customer_name, customer_phone, fulfilment, subtotal_cents, total_cents)
      values (v_shop2_id, 'Blocked', '+252634000010', 'collect', 100, 100);
  exception
    when others then
      if sqlerrm = 'module_not_included' then
        v_raised := true;
      else
        raise;
      end if;
  end;
  if not v_raised then
    raise exception 'FAIL: an order was inserted for a shop whose plan does not include the storefront module';
  end if;

  -- ══ place_storefront_order ══════════════════════════════════════════════
  --
  -- A shop of its very own for these checks. Not v_shop_id: checks 1-13 left
  -- orders on that shop, and check 30's rate limit counts rows per shop, so
  -- sharing would make this section's results depend on how many checks
  -- happen to run above it.
  insert into public.shops (owner_id, name) values (v_user_id, 'Hargeisa Online')
    returning id into v_store_id;
  update public.shops set slug = 'hargeisa-online' where id = v_store_id;
  insert into public.storefronts (shop_id, offers_delivery, published_at)
    values (v_store_id, true, now());

  -- A location BEFORE the products, so product_opening_stock seeds
  -- product_location_stock and the `stock` these products carry is real
  -- rather than an unbacked number. Check 27 depends on that: with no
  -- location, products.stock is derived from nothing, and a check that stock
  -- did not move would be comparing zero to zero.
  insert into public.shop_locations (shop_id, name, is_primary)
    values (v_store_id, 'Main', true);

  insert into public.products (shop_id, name, price_cents, stock, is_listed_online)
    values (v_store_id, 'Anker 20W charger', 1200, 5, true) returning id into v_prod_a;
  insert into public.products (shop_id, name, price_cents, stock, is_listed_online)
    values (v_store_id, 'USB-C cable', 350, 40, true) returning id into v_prod_b;
  insert into public.products (shop_id, name, price_cents, stock, is_listed_online)
    values (v_store_id, 'Trade-only cable', 500, 5, false) returning id into v_prod_hidden;
  -- Listed online, in stock, priced -- and belonging to somebody else.
  insert into public.products (shop_id, name, price_cents, stock, is_listed_online)
    values (v_shop_id, 'Another shop''s radio', 900, 5, true) returning id into v_prod_other;

  -- Check 27's alone, so the stock it starts with is the stock it still has
  -- when that check runs, whatever the checks in between order.
  insert into public.products (shop_id, name, price_cents, stock, is_listed_online)
    values (v_store_id, 'Jerrycan', 1200, 5, true) returning id into v_prod_bulk;

  insert into public.storefront_delivery_areas (shop_id, name, fee_cents)
    values (v_store_id, 'Koodbuur', 2000);

  -- ------------------------------------------------ 19. anon may call it, and it is the only thing anon may do
  if not has_function_privilege('anon', 'public.place_storefront_order(text,jsonb,jsonb)', 'EXECUTE') then
    raise exception 'FAIL: anon cannot execute place_storefront_order -- the storefront has no checkout at all';
  end if;
  -- Restated here beside the grant it depends on, not left to check 14
  -- alone: the function is only a boundary if the tables behind it stay shut.
  if has_table_privilege('anon', 'public.orders', 'INSERT')
     or has_table_privilege('anon', 'public.order_items', 'INSERT') then
    raise exception 'FAIL: anon can write the order tables directly, so the function is not the only anonymous path';
  end if;

  -- ------------------------------------------------ 20. the happy path, priced by the server
  set local role anon;
  v_result := public.place_storefront_order(
    'hargeisa-online',
    jsonb_build_object('name', 'Ayaan Jama', 'phone', '063 400 0111', 'fulfilment', 'collect'),
    jsonb_build_array(
      jsonb_build_object('product_id', v_prod_a, 'quantity', 2),
      jsonb_build_object('product_id', v_prod_b, 'quantity', 1)
    ));
  reset role;

  if (v_result->>'number')::integer <> 1 then
    raise exception 'FAIL: the first order placed at a storefront was not number 1 (got %)', v_result->>'number';
  end if;
  if (v_result->>'subtotal_cents')::integer <> 2750 then
    raise exception 'FAIL: subtotal was not 2 x 1200 + 350 (got %)', v_result->>'subtotal_cents';
  end if;
  if (v_result->>'delivery_fee_cents')::integer <> 0 then
    raise exception 'FAIL: a collect order was charged a delivery fee (got %)', v_result->>'delivery_fee_cents';
  end if;
  if (v_result->>'total_cents')::integer <> 2750 then
    raise exception 'FAIL: total was not subtotal + delivery (got %)', v_result->>'total_cents';
  end if;
  if jsonb_array_length(v_result->'items') <> 2 then
    raise exception 'FAIL: the return did not carry both priced lines back to the client';
  end if;

  select id into v_order_id from public.orders where shop_id = v_store_id and number = 1;
  if v_order_id is null then
    raise exception 'FAIL: place_storefront_order returned a number for an order it never stored';
  end if;
  -- The row and the return must agree; a return computed separately from what
  -- was written is a receipt for an order that does not exist.
  if (select total_cents from public.orders where id = v_order_id) <> 2750 then
    raise exception 'FAIL: the stored order total does not match the total returned to the customer';
  end if;
  if (select customer_phone from public.orders where id = v_order_id) <> '+252634000111' then
    raise exception 'FAIL: customer_phone was not normalised to E.164 (got %)',
      (select customer_phone from public.orders where id = v_order_id);
  end if;
  select count(*) into v_count from public.order_items where order_id = v_order_id;
  if v_count <> 2 then
    raise exception 'FAIL: the order stored % lines instead of 2', v_count;
  end if;
  if (select line_total_cents from public.order_items where order_id = v_order_id and product_id = v_prod_a) <> 2400 then
    raise exception 'FAIL: a line total was not unit price x quantity';
  end if;

  -- ------------------------------------------------ 21. a client-supplied price is ignored
  -- Every money key a hopeful client might send, in BOTH payloads, at one
  -- cent. Both halves matter: a function that priced its lines from products
  -- and then took the customer payload's word for the delivery fee or the
  -- total would still hand out free goods.
  set local role anon;
  v_result := public.place_storefront_order(
    'hargeisa-online',
    jsonb_build_object('name', 'Sneaky', 'phone', '+252634000112', 'fulfilment', 'collect',
                       'delivery_fee_cents', 1, 'subtotal_cents', 1, 'total_cents', 1),
    jsonb_build_array(jsonb_build_object(
      'product_id', v_prod_a, 'quantity', 1,
      'unit_price_cents', 1, 'price_cents', 1, 'line_total_cents', 1,
      'subtotal_cents', 1, 'total_cents', 1, 'delivery_fee_cents', 1
    )));
  reset role;
  if (v_result->>'total_cents')::integer <> 1200 then
    raise exception 'FAIL: a client-supplied price set the order total (got %) -- anyone can price their own cart',
      v_result->>'total_cents';
  end if;
  if (v_result->>'delivery_fee_cents')::integer <> 0 then
    raise exception 'FAIL: a collect order was given the delivery fee its client asked for (got %)',
      v_result->>'delivery_fee_cents';
  end if;
  select id into v_order_id from public.orders where shop_id = v_store_id and number = 2;
  if (select unit_price_cents from public.order_items where order_id = v_order_id) <> 1200 then
    raise exception 'FAIL: a client-supplied unit price was written to order_items';
  end if;

  -- ------------------------------------------------ 22. a product from another shop fails the WHOLE order
  select count(*) into v_before from public.orders where shop_id = v_store_id;
  set local role anon;
  v_raised := false;
  begin
    perform public.place_storefront_order(
      'hargeisa-online',
      jsonb_build_object('name', 'Cross Shop', 'phone', '+252634000113', 'fulfilment', 'collect'),
      jsonb_build_array(
        jsonb_build_object('product_id', v_prod_a, 'quantity', 1),
        jsonb_build_object('product_id', v_prod_other, 'quantity', 1)
      ));
  exception
    when others then
      if sqlerrm = 'unavailable_item' then v_raised := true; else raise; end if;
  end;
  reset role;
  if not v_raised then
    raise exception 'FAIL: an order containing another shop''s product was accepted';
  end if;
  select count(*) into v_count from public.orders where shop_id = v_store_id;
  if v_count <> v_before then
    raise exception 'FAIL: the rejected order still wrote a row -- the good line was kept and the bad one dropped';
  end if;

  -- ------------------------------------------------ 23. an unlisted product fails the whole order too
  set local role anon;
  v_raised := false;
  begin
    perform public.place_storefront_order(
      'hargeisa-online',
      jsonb_build_object('name', 'Trade Only', 'phone', '+252634000114', 'fulfilment', 'collect'),
      jsonb_build_array(
        jsonb_build_object('product_id', v_prod_b, 'quantity', 1),
        jsonb_build_object('product_id', v_prod_hidden, 'quantity', 1)
      ));
  exception
    when others then
      if sqlerrm = 'unavailable_item' then v_raised := true; else raise; end if;
  end;
  reset role;
  if not v_raised then
    raise exception 'FAIL: a product that is not listed online was orderable through the storefront';
  end if;
  select count(*) into v_count from public.orders where shop_id = v_store_id;
  if v_count <> v_before then
    raise exception 'FAIL: an order holding an unlisted product wrote a row anyway';
  end if;

  -- ------------------------------------------------ 24. a nonsense quantity, and an empty cart
  set local role anon;
  v_raised := false;
  begin
    perform public.place_storefront_order(
      'hargeisa-online',
      jsonb_build_object('name', 'Zero', 'phone', '+252634000115', 'fulfilment', 'collect'),
      jsonb_build_array(jsonb_build_object('product_id', v_prod_a, 'quantity', 0)));
  exception
    when others then
      if sqlerrm = 'invalid_quantity' then v_raised := true; else raise; end if;
  end;
  reset role;
  if not v_raised then
    raise exception 'FAIL: a quantity of zero was accepted';
  end if;

  set local role anon;
  v_raised := false;
  begin
    perform public.place_storefront_order(
      'hargeisa-online',
      jsonb_build_object('name', 'Nobody', 'phone', '+252634000116', 'fulfilment', 'collect'),
      '[]'::jsonb);
  exception
    when others then
      if sqlerrm = 'empty_cart' then v_raised := true; else raise; end if;
  end;
  reset role;
  if not v_raised then
    raise exception 'FAIL: an empty cart was accepted as an order';
  end if;

  -- ------------------------------------------------ 25. an unknown delivery area is rejected, not free
  set local role anon;
  v_raised := false;
  begin
    perform public.place_storefront_order(
      'hargeisa-online',
      jsonb_build_object('name', 'Far Away', 'phone', '+252634000117', 'fulfilment', 'deliver',
                         'delivery_area', 'Somewhere The Shop Never Named'),
      jsonb_build_array(jsonb_build_object('product_id', v_prod_b, 'quantity', 1)));
  exception
    when others then
      if sqlerrm = 'unknown_delivery_area' then v_raised := true; else raise; end if;
  end;
  reset role;
  if not v_raised then
    raise exception 'FAIL: an unknown delivery area was accepted -- almost certainly at a fee of zero';
  end if;
  if exists (select 1 from public.orders where shop_id = v_store_id and fulfilment = 'deliver') then
    raise exception 'FAIL: an order for an unknown delivery area was stored';
  end if;

  -- ------------------------------------------------ 26. a known area's fee is looked up and snapshotted
  set local role anon;
  v_result := public.place_storefront_order(
    'hargeisa-online',
    -- delivery_fee_cents is sent and must be ignored: the fee comes from the
    -- shop's own row, looked up here, or the order does not happen.
    jsonb_build_object('name', 'Koodbuur Customer', 'phone', '+252634000118', 'fulfilment', 'deliver',
                       'delivery_area', 'Koodbuur', 'delivery_landmark', 'Behind the mosque',
                       'delivery_fee_cents', 1),
    jsonb_build_array(jsonb_build_object('product_id', v_prod_b, 'quantity', 1)));
  reset role;
  if (v_result->>'delivery_fee_cents')::integer <> 2000 then
    raise exception 'FAIL: the delivery fee was not the one the shop set for that area (got %)',
      v_result->>'delivery_fee_cents';
  end if;
  if (v_result->>'total_cents')::integer <> 2350 then
    raise exception 'FAIL: total was not subtotal + the looked-up delivery fee (got %)', v_result->>'total_cents';
  end if;
  select id into v_order_id from public.orders
    where shop_id = v_store_id and number = (v_result->>'number')::integer;
  if (select delivery_area from public.orders where id = v_order_id) <> 'Koodbuur' then
    raise exception 'FAIL: the delivery area name was not snapshotted onto the order';
  end if;
  -- The stored name is asserted against the delivery area's OWN name column,
  -- read fresh here rather than only against the literal the client
  -- happened to send: 20260927000000_place_order.sql selects a.name into
  -- v_area alongside the fee, not the client's v_area_in. Byte-equal to what
  -- the client sent today, because the lookup above is an exact match --
  -- this is the check that would go red the day that lookup is loosened to
  -- a case-insensitive one and a client's own casing is stored instead of
  -- the shop's.
  if (select delivery_area from public.orders where id = v_order_id)
     is distinct from (select a.name from public.storefront_delivery_areas a
                        where a.shop_id = v_store_id and a.name = 'Koodbuur') then
    raise exception 'FAIL: the stored delivery area is not the shop''s own name for it';
  end if;
  -- Snapshot, not a live join: re-pricing the area must not rewrite an order
  -- the customer already agreed to.
  update public.storefront_delivery_areas set fee_cents = 9999
    where shop_id = v_store_id and name = 'Koodbuur';
  if (select delivery_fee_cents from public.orders where id = v_order_id) <> 2000 then
    raise exception 'FAIL: re-pricing a delivery area changed an order that had already been placed';
  end if;
  update public.storefront_delivery_areas set fee_cents = 2000
    where shop_id = v_store_id and name = 'Koodbuur';

  -- ------------------------------------------------ 27. a draft shop and an unknown slug are indistinguishable
  insert into public.shops (owner_id, name) values (v_user_id, 'Not Open Yet')
    returning id into v_draft_id;
  update public.shops set slug = 'not-open-yet' where id = v_draft_id;
  insert into public.storefronts (shop_id) values (v_draft_id);  -- published_at stays null

  set local role anon;
  v_msg_unknown := null;
  begin
    perform public.place_storefront_order(
      'no-such-shop-anywhere',
      jsonb_build_object('name', 'Prober', 'phone', '+252634000119', 'fulfilment', 'collect'),
      jsonb_build_array(jsonb_build_object('product_id', v_prod_a, 'quantity', 1)));
  exception when others then v_msg_unknown := sqlerrm;
  end;

  v_msg_draft := null;
  begin
    perform public.place_storefront_order(
      'not-open-yet',
      jsonb_build_object('name', 'Prober', 'phone', '+252634000120', 'fulfilment', 'collect'),
      jsonb_build_array(jsonb_build_object('product_id', v_prod_a, 'quantity', 1)));
  exception when others then v_msg_draft := sqlerrm;
  end;
  reset role;

  if v_msg_unknown is null then
    raise exception 'FAIL: an order was accepted for a slug that belongs to nobody';
  end if;
  if v_msg_draft is null then
    raise exception 'FAIL: an unpublished storefront took an order';
  end if;
  if v_msg_unknown <> v_msg_draft then
    raise exception 'FAIL: an unknown slug (%) and a draft shop (%) answer differently -- checkout is a slug oracle',
      v_msg_unknown, v_msg_draft;
  end if;
  -- And the shared message must itself say nothing: no slug, no shop id.
  if v_msg_unknown like '%not-open-yet%' or v_msg_unknown like '%' || v_draft_id::text || '%' then
    raise exception 'FAIL: the refusal message leaks the slug or the shop id (%)', v_msg_unknown;
  end if;
  -- Pinned to the exact code, not merely "the two agree": the catch-all that
  -- turns an unrecognised error into 'order_failed' would make ANY pair of
  -- leaky messages agree, and the two checks above would pass on a function
  -- that had stopped telling customers anything at all.
  if v_msg_unknown <> 'shop_unavailable' then
    raise exception 'FAIL: a shop that is not taking orders answers with % rather than shop_unavailable', v_msg_unknown;
  end if;

  -- ------------------------------------------------ 28. a phone that will not normalise is refused
  set local role anon;
  v_raised := false;
  begin
    perform public.place_storefront_order(
      'hargeisa-online',
      jsonb_build_object('name', 'Unreachable', 'phone', '+0123', 'fulfilment', 'collect'),
      jsonb_build_array(jsonb_build_object('product_id', v_prod_a, 'quantity', 1)));
  exception
    when others then
      if sqlerrm = 'invalid_phone' then v_raised := true; else raise; end if;
  end;
  reset role;
  if not v_raised then
    raise exception 'FAIL: a phone number the shop cannot call was accepted';
  end if;

  -- public.to_e164 is a port of toE164 in src/lib/phone-e164.ts, and the two
  -- have to agree: the client normalises for the person typing and this one
  -- normalises for everything else that can reach the RPC. These are that
  -- file's own awkward cases -- a trunk zero, a `00` access code, a false
  -- international claim, and bare digits too long to be a local number --
  -- because those are the branches a rewrite gets wrong, not '+252...'.
  if public.to_e164('0634456789')      is distinct from '+252634456789' or
     public.to_e164('063 445 6789')    is distinct from '+252634456789' or
     public.to_e164('00252634456789')  is distinct from '+252634456789' or
     public.to_e164('634456789')       is distinct from '+252634456789' or
     public.to_e164('+1 415 555 2671') is distinct from '+14155552671'  or
     public.to_e164('+0634456789')     is distinct from null            or
     public.to_e164('0000634456789')   is distinct from null            or
     public.to_e164('1234567890')      is distinct from null            or
     public.to_e164('abc')             is distinct from null
  then
    raise exception 'FAIL: to_e164 has drifted from toE164 in src/lib/phone-e164.ts';
  end if;

  -- ------------------------------------------------ 29. stock is neither reserved nor decremented
  -- v_prod_bulk holds 5. Ordering 99 must succeed and must leave the 5 alone --
  -- Plan 4 decrements on fulfilment. Reserving here would let anyone empty a
  -- shop's shelves from a browser without ever collecting anything.
  --
  -- Asserted against product_location_stock, not products.stock, because
  -- products.stock is DERIVED: product_stock_is_derived_trigger recomputes it
  -- from the location rows on every update, so a function that decremented
  -- products.stock directly would have its write silently reverted and this
  -- check would pass while the real bug went in through the location table.
  -- The fixture is asserted first for the same reason -- an empty
  -- product_location_stock makes both sides of the comparison zero.
  select coalesce(sum(s.stock), 0) into v_stock
    from public.product_location_stock s where s.product_id = v_prod_bulk;
  if v_stock <> 5 then
    raise exception 'FAIL: the stock fixture is not what this check needs (% at the location, expected 5)', v_stock;
  end if;

  set local role anon;
  v_result := public.place_storefront_order(
    'hargeisa-online',
    jsonb_build_object('name', 'Bulk Buyer', 'phone', '+252634000121', 'fulfilment', 'collect'),
    jsonb_build_array(jsonb_build_object('product_id', v_prod_bulk, 'quantity', 99)));
  reset role;
  if (v_result->>'total_cents')::integer <> 99 * 1200 then
    raise exception 'FAIL: an order beyond stock was silently trimmed (total %)', v_result->>'total_cents';
  end if;
  select coalesce(sum(s.stock), 0) into v_count
    from public.product_location_stock s where s.product_id = v_prod_bulk;
  if v_count <> v_stock then
    raise exception 'FAIL: placing a storefront order moved stock -- % became % at the location',
      v_stock, v_count;
  end if;
  if (select stock from public.products where id = v_prod_bulk) <> v_stock then
    raise exception 'FAIL: placing a storefront order moved products.stock -- % became %',
      v_stock, (select stock from public.products where id = v_prod_bulk);
  end if;

  -- ------------------------------------------------ 30. the rate limit trips
  insert into public.shops (owner_id, name) values (v_user_id, 'Burst Shop')
    returning id into v_burst_id;
  update public.shops set slug = 'burst-shop' where id = v_burst_id;
  insert into public.storefronts (shop_id, published_at) values (v_burst_id, now());
  insert into public.products (shop_id, name, price_cents, stock, is_listed_online)
    values (v_burst_id, 'Sim card', 100, 1000, true) returning id into v_prod_extra;

  -- Filled by direct insert rather than by calling the function in a loop:
  -- the limit must be a property of the ORDERS ALREADY THERE, not a counter
  -- the function keeps to itself.
  for v_i in 1..c_rate_limit loop
    insert into public.orders (shop_id, customer_name, customer_phone, fulfilment, subtotal_cents, total_cents)
      values (v_burst_id, 'Flood ' || v_i, '+252634000200', 'collect', 100, 100);
  end loop;

  set local role anon;
  v_raised := false;
  begin
    perform public.place_storefront_order(
      'burst-shop',
      jsonb_build_object('name', 'One Too Many', 'phone', '+252634000201', 'fulfilment', 'collect'),
      jsonb_build_array(jsonb_build_object('product_id', v_prod_extra, 'quantity', 1)));
  exception
    when others then
      if sqlerrm = 'rate_limited' then v_raised := true; else raise; end if;
  end;
  reset role;
  if not v_raised then
    raise exception 'FAIL: order % for one shop inside the window was accepted -- the storefront has no rate limit',
      c_rate_limit + 1;
  end if;

  -- ------------------------------------------------ 31. and it is a window, not a lifetime cap
  insert into public.shops (owner_id, name) values (v_user_id, 'Busy Last Week')
    returning id into v_aged_id;
  update public.shops set slug = 'busy-last-week' where id = v_aged_id;
  insert into public.storefronts (shop_id, published_at) values (v_aged_id, now());
  insert into public.products (shop_id, name, price_cents, stock, is_listed_online)
    values (v_aged_id, 'Airtime', 500, 1000, true) returning id into v_prod_extra;

  -- Well past any window a checkout could sensibly use. A shop that took a
  -- hundred orders a fortnight ago is a successful shop, not an attacker.
  for v_i in 1..(c_rate_limit + 10) loop
    insert into public.orders (shop_id, customer_name, customer_phone, fulfilment, subtotal_cents, total_cents, created_at)
      values (v_aged_id, 'Last week ' || v_i, '+252634000202', 'collect', 100, 100, now() - interval '2 days');
  end loop;

  set local role anon;
  v_result := null;
  begin
    v_result := public.place_storefront_order(
      'busy-last-week',
      jsonb_build_object('name', 'Today''s Customer', 'phone', '+252634000203', 'fulfilment', 'collect'),
      jsonb_build_array(jsonb_build_object('product_id', v_prod_extra, 'quantity', 1)));
  exception
    when others then
      if sqlerrm = 'rate_limited' then
        reset role;
        raise exception 'FAIL: a shop that was busy two days ago is locked out today -- the limit is a lifetime cap, not a window';
      else
        raise;
      end if;
  end;
  reset role;
  if (v_result->>'total_cents')::integer <> 500 then
    raise exception 'FAIL: the order placed after the window had passed did not price normally (got %)',
      v_result->>'total_cents';
  end if;

  -- ------------------------------------------------ 32. an internal failure says nothing useful to an attacker
  -- Forced with the same disable-trigger technique as checks 3 and 8: without
  -- orders_assign_number the insert hits a NOT NULL on `number`. The customer
  -- must get a fixed phrase, never the column, the constraint or the shop id.
  alter table public.orders disable trigger orders_assign_number;
  set local role anon;
  v_msg_internal := null;
  begin
    perform public.place_storefront_order(
      'hargeisa-online',
      jsonb_build_object('name', 'Unlucky', 'phone', '+252634000122', 'fulfilment', 'collect'),
      jsonb_build_array(jsonb_build_object('product_id', v_prod_a, 'quantity', 1)));
  exception when others then v_msg_internal := sqlerrm;
  end;
  reset role;
  alter table public.orders enable trigger orders_assign_number;

  if v_msg_internal is null then
    raise exception 'FAIL: an order with no number was stored';
  end if;
  if v_msg_internal <> 'order_failed' then
    raise exception 'FAIL: an internal failure reached the customer verbatim (%)', v_msg_internal;
  end if;

  -- ------------------------------------------------ 33. a de-entitled shop stops taking orders
  -- Same move as check 18, and last on purpose: it takes the storefront shop
  -- off the plan every check above depends on.
  update public.shop_subscriptions
  set plan_id = v_free_id, current_period_end = now() + interval '30 days'
  where shop_id = v_store_id;

  if public.shop_has_module(v_store_id, 'storefront') then
    raise exception 'FAIL: a shop moved to the Free plan still has the storefront module';
  end if;

  set local role anon;
  v_msg_draft := null;
  begin
    perform public.place_storefront_order(
      'hargeisa-online',
      jsonb_build_object('name', 'Too Late', 'phone', '+252634000123', 'fulfilment', 'collect'),
      jsonb_build_array(jsonb_build_object('product_id', v_prod_a, 'quantity', 1)));
  exception when others then v_msg_draft := sqlerrm;
  end;
  reset role;

  if v_msg_draft is null then
    raise exception 'FAIL: a shop whose plan no longer includes storefront went on taking orders';
  end if;
  -- Refused with check 27's message, word for word: a customer learns nothing
  -- about the shop's billing from a checkout page.
  if v_msg_draft <> v_msg_unknown then
    raise exception 'FAIL: a de-entitled shop answers with its own distinct message (% vs %)',
      v_msg_draft, v_msg_unknown;
  end if;

  -- ------------------------------------------------ 34. the public storefront says where to collect from
  -- A COLLECTION-ONLY shop, which is the case the whole thing exists for:
  -- offers_delivery false, so checkout-form.tsx renders no fulfilment choice
  -- and the customer is never told the order is a pick-up, let alone from
  -- where.
  insert into public.shops (owner_id, name) values (v_user_id, 'Collect Only')
    returning id into v_collect_id;
  update public.shops set slug = 'collect-only' where id = v_collect_id;
  insert into public.storefronts (shop_id, offers_delivery, published_at)
    values (v_collect_id, false, now());

  -- The DECOY GOES IN FIRST, on purpose. Both orderings the codebase uses for
  -- "the shop's location" (complete_sale 20260908000300:182-186,
  -- storefront-admin.ts's primaryLocation) are `is_primary desc, created_at
  -- asc`. Inserting the non-primary branch earlier means created_at alone
  -- would pick the WRONG one, so this check goes red if `is_primary desc` is
  -- ever dropped from the ordering -- which a decoy inserted afterwards could
  -- not detect.
  insert into public.shop_locations (shop_id, name, address, is_primary)
    values (v_collect_id, 'Warehouse', 'Unit 4, Airport Road', false);
  insert into public.shop_locations (shop_id, name, address, is_primary)
    values (v_collect_id, 'Main', 'Shop 12, Bakaaro Market', true);

  -- The column first, named, so the red state reads as the missing feature
  -- rather than as a bare "column does not exist" from the query below.
  -- proargmodes 't' is an OUT column of a `returns table`.
  if not exists (
    select 1
    from pg_proc p, unnest(p.proargnames, p.proargmodes) as a(argname, argmode)
    where p.oid = 'public.get_public_storefront(text)'::regprocedure
      and a.argmode = 't'
      and a.argname = 'collect_address'
  ) then
    raise exception 'FAIL 34: get_public_storefront returns no collect_address column -- a collection-only shop still cannot say where the goods will be waiting';
  end if;

  -- count first: `max()` over ZERO rows is also null, so asserting the value
  -- alone would let a page that returns nothing at all pass the null case
  -- below.
  select count(*), max(g.collect_address)
    into v_count, v_collect_addr
    from public.get_public_storefront('collect-only') g;
  if v_count <> 1 then
    raise exception 'FAIL 34: get_public_storefront returned % rows for a published collection-only shop', v_count;
  end if;
  if v_collect_addr is distinct from 'Shop 12, Bakaaro Market' then
    raise exception 'FAIL 34: the pick-up address was % -- expected the PRIMARY location''s (Shop 12, Bakaaro Market)',
      coalesce(quote_literal(v_collect_addr), 'null');
  end if;

  -- A shop that has not filled its address in. null is the real answer: the
  -- pick-up line renders without an address rather than with an empty one,
  -- and it must NOT quietly fall through to another branch's address -- the
  -- Warehouse row is still there, and sending a customer to the wrong door is
  -- worse than sending them to none.
  update public.shop_locations set address = null
    where shop_id = v_collect_id and is_primary;
  select count(*), max(g.collect_address)
    into v_count, v_collect_addr
    from public.get_public_storefront('collect-only') g;
  if v_count <> 1 then
    raise exception 'FAIL 34: get_public_storefront returned % rows once the address was cleared', v_count;
  end if;
  if v_collect_addr is not null then
    raise exception 'FAIL 34: a shop with no address on its primary location answered % -- expected null, not an empty line and not another branch',
      quote_literal(v_collect_addr);
  end if;

  raise notice 'PASS: orders schema';
  raise exception 'rollback_marker';
exception
  when others then
    if sqlerrm = 'rollback_marker' then
      raise notice 'verify-orders: all checks passed, rolled back';
    else
      raise;
    end if;
end $$;
