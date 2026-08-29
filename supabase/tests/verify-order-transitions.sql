-- transition_order: the moves a shop makes that touch nothing -- and
-- complete_storefront_order: the one move that reaches the books.
--
-- Same shape as verify-orders.sql -- one DO block, EXCEPTION rolls everything
-- back, specific exception classes wherever Postgres offers one, `when
-- others` + an exact/like sqlerrm match (never bare) for the custom messages
-- this function and its trigger raise themselves.
--
-- ── The transition table ────────────────────────────────────────────────
--   pending  -> accepted
--   accepted -> ready
--   {pending, accepted, ready} -> cancelled
--   ready    -> completed, AND ONLY when the same statement attaches the sale
--               the order became (20260928000200_complete_storefront_order)
-- Nothing else. transition_order cannot reach 'completed' and neither can a
-- shop member's plain RLS update, because neither of them sets a sale_id --
-- so the property 20260928000100 was protecting ("a shop must not mark an
-- order done with nothing in the books to show for it") is enforced
-- directly rather than by refusing the word outright. Checks 3, 4 and 35
-- are the ones that hold that line.
--
-- ── Same-state is a no-op, not an error ─────────────────────────────────
-- Calling transition_order(order, 'accepted') on an order that is already
-- 'accepted' returns the row unchanged rather than raising. A shop's phone
-- on a bad connection retries; the retry should read as "yes, done", not as
-- a scary error for an action that already succeeded. It also is not really
-- a "move" at all -- the permitted-moves list above has no entry that starts
-- and ends on the same state, so treating it as outside that table (rather
-- than a rejected member of it) is the more honest reading. See check 12.
--
-- ── What each check proves ──────────────────────────────────────────────
--   1/2.  the two ordinary forward moves succeed.
--   3/4.  the one hop this whole feature exists to block: ready and pending
--         both refuse a direct jump to completed.
--   5-7.  cancellation from each of the three live states, each carrying a
--         reason; check 7 proves the reason is actually stored, trimmed.
--   8/9.  cancelling with no reason, and with a whitespace-only one, are both
--         refused -- the shop will be asked what happened on the phone weeks
--         later, so an empty answer is not an answer.
--   10/11. moving backwards is refused both directions.
--   12.   same-state is a no-op (see above), proven by no error and an
--         unchanged row.
--   13.   a value outside the status vocabulary entirely hits the orders
--         table's own CHECK constraint (unchanged since Task 1) rather than
--         this migration's own logic -- check_violation, not a custom
--         message, because the trigger explicitly steps aside for anything
--         it does not recognise as one of the five known words.
--   14.   moving out of the OTHER terminal state, cancelled, is refused.
--   15.   moving out of completed is refused too -- forced into existence
--         with the disable-trigger technique verify-orders.sql already uses
--         for orders_assign_number/orders_copy_payment_mode, because nothing
--         built so far can put a row there any other way.
--   16.   an order inserted with status/cancellation_reason supplied by the
--         caller is forced to pending/null regardless -- the same override
--         orders_copy_payment_mode already applies to payment_mode
--         (verify-orders.sql check 7), extended here to status so a shop
--         cannot fabricate a finished order from birth.
--   17.   the cancellation-reason CHECK constraint is real on its own, not
--         merely implied by the trigger -- proven the same disable-trigger
--         way as check 15.
--   18.   the table is honest in two independent layers: a shop member's own
--         direct UPDATE (the plain RLS path, nothing to do with this
--         function) is refused OUTRIGHT now that authenticated holds no
--         write privilege on `orders` at all (20260928000300), and even a
--         writer that bypasses that grant is still refused an illegal edge
--         by the trigger itself -- the belt behind that grant's braces.
--   19.   an unknown order id is refused, distinctly from an existing one
--         belonging to someone else.
--   20.   a shop member of a DIFFERENT shop may not move this order.
--   21/22. the grant: authenticated holds EXECUTE, anon does not -- on
--         paper and for real (belt and braces, same technique as
--         verify-orders.sql check 14/16/17).
--
-- ── complete_storefront_order: the move that reaches the books ──────────
--   23.   a ready order completes: a sale id comes back, the order lands
--         'completed', and it records WHICH sale it became. Without that
--         last part the two records can never be reconciled again.
--   24.   the sale's lines are the ORDER'S SNAPSHOT -- product_name,
--         unit_price_cents, quantity and line_total_cents, line for line.
--         That is what the customer agreed to.
--   25.   a collect order (no delivery) posts ONE balanced entry and never
--         touches 4300 at all. The control for check 26: an
--         implementation that credited 4300 unconditionally would pass 26
--         and fail here.
--   26.   THE DELIVERY FEE CREDITS 4300 AND NOT 4000. Asserted both ways --
--         4300 holds exactly the fee, and the sale's own entry has no 4300
--         line while the fee's entry has no 4000 line -- because a fee
--         posted to 4000 mixes revenue carrying no cost of sales into goods
--         revenue and flatters gross margin on every report the accounting
--         work already built.
--   27.   THE FEE'S ENTRY BALANCES on its own, and names both the order
--         number and the sale id. Route B (a second, small entry beside the
--         sale) is only defensible if a reader landing on either entry can
--         find the other; the entry balancing is what makes it a journal
--         entry rather than a note.
--   28.   the fee is debited to the account of the method the shop ACTUALLY
--         TOOK -- 1020 for zaad here, never a hardcoded 1000 Cash -- and the
--         two entries together bring in exactly orders.total_cents. Both
--         entries also carry the same date and the same location, so one
--         order's money can never straddle two months or two branches.
--   29.   A SHORTFALL LEAVES THE ORDER UNTOUCHED. `insufficient_stock`, a
--         code a client can turn into a sentence, and afterwards the order
--         is still 'ready' with no sale against it and the stock is exactly
--         where it was. Half-completed is the one outcome worse than
--         failing.
--   30.   completing the same order twice is refused and writes no second
--         sale. Not hypothetical: 'completed' -> 'completed' is a
--         same-status move, which the trigger's early return waves through,
--         so only the function's own status guard stands between a retry and
--         a duplicate posting.
--   31.   an order that is not 'ready' (pending here) cannot be completed --
--         the ledger is reached from one state only.
--   32.   a member of another shop cannot complete this shop's order.
--   33.   a line whose product has since been deleted raises
--         `order_product_deleted`, not complete_sale's raw `product  not
--         found in this shop` with an empty uuid in the middle of it.
--   34.   AN ORDER WHOSE PRICES HAVE MOVED completes AT THE PRICE THE
--         CUSTOMER AGREED TO. Re-founded by 20260929000200: this check used
--         to prove the opposite -- refusal with `order_total_changed` --
--         because complete_sale re-priced every line from the CURRENT
--         products.price_cents, so a shop's own price rise stranded its open
--         orders. The order's snapshot is now authoritative. The refusal is
--         not gone, it is narrower: check 50 below.
--   35.   TWO INDEPENDENT LAYERS HOLD THE LINE, NOT JUST THE FUNCTION. A shop
--         member's plain RLS `update ... set status = 'completed'` is
--         refused outright now (20260928000300 revoked the grant), and --
--         belt and braces -- a writer that bypassed the grant would still be
--         refused because it attaches no sale; a sale link already set
--         cannot be re-pointed at a different sale, refused the same two
--         ways; and the orders_sale_only_when_completed CHECK is real on its
--         own, proven with the same disable-trigger technique as checks 15
--         and 17.
--   36.   the grant on complete_storefront_order: authenticated holds
--         EXECUTE, anon does not, on paper and for real.
--
-- ── Task 5: cancelling writes nothing to the books ───────────────────────
--
-- transition_order's whole body (20260928000100) is one UPDATE against
-- orders and nothing else -- it never calls complete_sale or
-- post_journal_entry, so a pre-completion cancellation cannot reach the
-- ledger by construction. Checks 37 and 38 do not exist because that was in
-- doubt; they exist so a future edit that DID make transition_order post
-- something (a "helpful" stock-release entry, say) would turn one of them
-- red, and so property 2 (the shop can still explain a cancelled order weeks
-- later) is proven on a fixture that actually carries items, not just a
-- bare order row.
--
--   37.   cancelling an order that carries items writes NOTHING to the
--         ledger and keeps its lines. Proven by count, not by inference:
--         shop-wide sales and journal_entries counts are snapshotted
--         immediately before the cancel and compared immediately after, so
--         an entry posted for ANY reason during the call would move the
--         count and fail this check -- not merely "no entry with this
--         order's number in it", which a differently-worded entry would
--         slip past. order_items is asserted unchanged the same way. Ties
--         to journal_entries the same way check 25 does for a real sale: by
--         count, at the shop, around the one call under test.
--   38.   THE PROPERTY THAT MATTERS MOST: a completed order -- a REAL one,
--         with an actual sale and a posted journal entry behind it, not a
--         forced-empty row like check 15's v_forced_id -- cannot be
--         cancelled, through either door (transition_order or a plain RLS
--         update), and the attempt leaves the sale's entry exactly as
--         posted: same status, same balance, AND (belt and braces beneath
--         those two) the same NUMBER of entries at the shop. The status and
--         balance assertions alone are real but toothless on their own: a
--         BALANCED entry sums to zero whether it was touched or not, and
--         status/balance checks that only ever look AT v_entry_collect
--         cannot see a second, mirroring reversal entry a regression might
--         append beside it. The shop-wide journal_entries count,
--         snapshotted immediately before the two refused attempts and
--         compared immediately after, is what would actually catch that.
--         Check 15 already proves the state machine refuses completed ->
--         cancelled in the abstract; this proves the refusal holds for a
--         real posting and that nothing about it moves when the refusal
--         fires -- the concern this migration's brief names by name: "a
--         cancellation that silently unposted a sale would leave the books
--         wrong in a way nobody would notice until a P&L looked odd."
--
-- ── The money-handling review's Critical finding ──────────────────────────
--
-- Checks 18/35/38 above prove `authenticated` cannot write `orders` directly
-- at all now. These two prove the deeper claim: even a writer that bypasses
-- that grant entirely -- run here as postgres, the same way the review's own
-- reproduction did -- is refused by the TRIGGER's own invariants, which is
-- what actually closes the hole rather than the grant alone.
--
--   39.   THE EXACT REPRODUCTION. A ready order, an unrelated sale
--         belonging to a DIFFERENT shop, one direct `update ... set status =
--         'completed', sale_id = ...` -- refused, the order left exactly as
--         it was, and the shop's journal_entries count unmoved. This is also
--         the same-shop rule proven in isolation: the sale used here has
--         never been attached to anything, so there is no reuse for the
--         refusal to be ambiguous about.
--   40.   ONE SALE SETTLES AT MOST ONE ORDER, proven independently of check
--         39: the sale attached here already belongs to THIS shop (it is
--         already sitting on a different order of it), so the same-shop rule
--         has nothing to say and the partial unique index on
--         orders.sale_id is what refuses it.
--
-- ── The review's IMPORTANT finding 1 ──────────────────────────────────────
--
--   41.   DELETING A STOREFRONT SALE REVERSES THE DELIVERY FEE TOO, not just
--         the goods. 20260928000400_delivery_fee_reversal_link.sql gave the
--         fee entry a real link (orders.delivery_entry_id) rather than only
--         a description string naming its sale, and taught delete_sale a
--         fourth branch. Both entries are asserted reversed BY NAME (a
--         half-fix that reverses only the goods says exactly which one it
--         forgot), and 4300's net effect across the fee's original entry and
--         its mirror is asserted to be exactly zero -- not merely "some
--         entry somewhere changed status".
--
--   44.   20260928000600: pos.access is required to COMPLETE an order, even
--         though transition_order needs none -- a settings-only manager
--         (settings.access, no pos.access, on a role of its own) can still
--         accept an order but is refused by name at completion, before
--         complete_sale is ever reached.
--   45.   a shop whose plan no longer includes storefront may neither move
--         an order NOR complete one, even one already sitting in its queue.
--         Left last, same reason verify-orders.sql leaves its own version
--         last: it moves the shop off the plan every check above depends on.

\set ON_ERROR_STOP on

do $$
declare
  v_owner_id    uuid := gen_random_uuid();
  v_staff_id    uuid := gen_random_uuid();
  v_outsider_id uuid := gen_random_uuid();
  -- Check 44: a member of THIS shop, active, module included -- everything
  -- transition_order/complete_storefront_order's own membership and module
  -- gates already wave through -- but holding a role with no `pos.access`.
  -- 20260928000600's whole point is that this member is refused for a
  -- reason of its own rather than by a check borrowed from complete_sale.
  v_manager_id  uuid := gen_random_uuid();
  v_shop_id     uuid;
  v_other_shop_id uuid;
  v_role_id     uuid;
  v_manager_role_id uuid;  -- check 44: settings.access only, no pos.access
  v_free_id     uuid;

  v_order_id    uuid;  -- the main fixture, walked pending -> accepted -> ready
  v_cancel1_id  uuid;  -- cancelled straight from pending
  v_cancel2_id  uuid;  -- cancelled from accepted
  v_cancel3_id  uuid;  -- cancelled from ready
  v_forced_id   uuid;  -- forced into 'completed' by disabling the trigger

  v_result   public.orders;
  v_raised   boolean;
  v_detail   text;
  v_count    integer;

  -- ── Checks 23-36: completion, which reaches the ledger ────────────────
  -- A shop has no location until a fixture makes one (seed_shop_defaults does
  -- not), and complete_sale defaults p_location_id to the primary one -- so
  -- without this every completion below fails with "shop % has no location".
  v_loc_id     uuid;
  -- Priced so no two figures in any one entry coincide: a check reading the
  -- wrong account then FAILS rather than coincidentally passing.
  v_prod_tea    uuid;  -- 2000, cost 700   -- the collect order
  v_prod_coffee uuid;  -- 3000, cost 1100  -- the deliver order
  v_prod_rice   uuid;  -- 500,  stock 1    -- the shortfall
  v_prod_ghost  uuid;  -- 900,  deleted mid-script
  v_prod_drift  uuid;  -- 700,  re-priced to 1300 mid-script: check 34
  v_drift_id    uuid;  -- its order was quoted at the old price
  v_drift_sale_id uuid;  -- and completes at it (20260929000200)
  v_collect_id  uuid;  -- 2 x tea    = 4000, no fee,   total 4000, paid cash
  v_deliver_id  uuid;  -- 1 x coffee = 3000, fee 1500, total 4500, paid zaad
  v_short_id    uuid;  -- 5 x rice, and the shop holds one
  v_pending_id  uuid;  -- never accepted: check 31
  v_ghost_id    uuid;  -- its only product is deleted before completion
  v_sale_collect uuid;
  v_sale_deliver uuid;
  v_entry_sale   uuid;
  v_entry_fee    uuid;
  v_amount       bigint;
  v_sales_before integer;
  v_stock_before integer;
  v_date_sale    date;
  v_date_fee     date;
  v_loc_sale     uuid;
  v_loc_fee      uuid;

  -- ── Checks 37-38: cancelling writes nothing to the books ──────────────
  v_cancel_items_id     uuid;  -- carries items, cancelled from 'ready'
  v_items_before        integer;
  v_je_before           integer;
  v_entry_status_before text;
  v_entry_status_after  text;
  v_line_sum_before      bigint;
  v_line_sum_after       bigint;
  -- v_collect_id's OWN entry, kept apart from v_entry_sale -- which check 26
  -- onward reassigns to v_sale_deliver's entry -- so check 38, which runs
  -- long after that reassignment, tests the entry it actually claims to.
  v_entry_collect        uuid;
  v_je_shop_before38     integer;
  v_je_shop_after38      integer;

  -- ── Checks 39-40: the Critical fix -- same-shop and one-sale-one-order ──
  v_other_sale_id  uuid;  -- belongs to v_other_shop_id, never attached to anything
  v_other_loc_id   uuid;  -- a location for v_other_shop_id -- sales.location_id is not null
  v_je_before_39   integer;
  v_je_after_39    integer;

  -- ── Check 41: deleting a storefront sale reverses the delivery fee too ──
  v_prod_delfee     uuid;
  v_delfee_id       uuid;
  v_sale_delfee     uuid;
  v_entry_goods_del uuid;  -- the sale's own entry (4000/5000/1200/the tender)
  v_entry_fee_del   uuid;  -- the fee's entry (4300/the tender), from orders.delivery_entry_id
  v_bad             text;

  -- ── Checks 43-44: the residual half of the Critical fix -- provenance ──
  v_counter_sale_id    uuid;  -- a REAL counter sale, v_shop_id's own, never attached to any order
  v_je_before_43       integer;
  v_je_after_counter43 integer;
  v_je_after_43        integer;
begin
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
    select u, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
           'verify-order-transitions-' || u || '@example.test', '', now(), now(), now()
      from unnest(array[v_owner_id, v_staff_id, v_outsider_id, v_manager_id]) u;

  insert into public.shops (owner_id, name) values (v_owner_id, 'Order Transitions Shop')
    returning id into v_shop_id;
  insert into public.shops (owner_id, name) values (v_outsider_id, 'Somebody Else''s Shop')
    returning id into v_other_shop_id;

  -- orders_copy_payment_mode (20260926000050_orders.sql) requires a
  -- storefronts row to copy payment_mode from -- every insert below goes
  -- through it.
  insert into public.storefronts (shop_id) values (v_shop_id);

  select id into v_role_id from public.roles where shop_id = v_shop_id and name = 'Cashier';
  insert into public.shop_members (shop_id, user_id, role_id, full_name, active)
    values (v_shop_id, v_staff_id, v_role_id, 'Staff Member', true);

  -- Check 44: a real role, granting exactly `settings.access` -- the same
  -- permission /orders itself is gated on client-side (permissions.ts) --
  -- and deliberately no `pos.access`. This is the settings-only manager the
  -- migration's own header describes: can open the order, cannot ring up
  -- the sale it would become.
  insert into public.roles (shop_id, name, permissions)
    values (v_shop_id, 'Settings-only Manager', array['settings.access'])
    returning id into v_manager_role_id;
  insert into public.shop_members (shop_id, user_id, role_id, full_name, active)
    values (v_shop_id, v_manager_id, v_manager_role_id, 'Settings Manager', true);

  -- Fixtures inserted as postgres (bypasses RLS, same as verify-orders.sql's
  -- own checks 1-13) so their starting state is exactly what each check
  -- needs, independent of anything this migration's own guards do.
  insert into public.orders (shop_id, customer_name, customer_phone, fulfilment, subtotal_cents, total_cents)
    values (v_shop_id, 'Fadumo', '+252634100001', 'collect', 1000, 1000) returning id into v_order_id;
  insert into public.orders (shop_id, customer_name, customer_phone, fulfilment, subtotal_cents, total_cents)
    values (v_shop_id, 'Cancel One', '+252634100002', 'collect', 1000, 1000) returning id into v_cancel1_id;
  insert into public.orders (shop_id, customer_name, customer_phone, fulfilment, subtotal_cents, total_cents)
    values (v_shop_id, 'Cancel Two', '+252634100003', 'collect', 1000, 1000) returning id into v_cancel2_id;
  insert into public.orders (shop_id, customer_name, customer_phone, fulfilment, subtotal_cents, total_cents)
    values (v_shop_id, 'Cancel Three', '+252634100004', 'collect', 1000, 1000) returning id into v_cancel3_id;
  insert into public.orders (shop_id, customer_name, customer_phone, fulfilment, subtotal_cents, total_cents)
    values (v_shop_id, 'Forced Complete', '+252634100005', 'collect', 1000, 1000) returning id into v_forced_id;

  -- ── Fixtures for checks 23-36 ────────────────────────────────────────
  insert into public.shop_locations (shop_id, name, is_primary)
    values (v_shop_id, 'Main', true) returning id into v_loc_id;

  insert into public.products (shop_id, name, price_cents, cost_cents)
    values (v_shop_id, 'Storefront Tea', 2000, 700) returning id into v_prod_tea;
  insert into public.products (shop_id, name, price_cents, cost_cents)
    values (v_shop_id, 'Storefront Coffee', 3000, 1100) returning id into v_prod_coffee;
  insert into public.products (shop_id, name, price_cents, cost_cents)
    values (v_shop_id, 'Storefront Rice', 500, 100) returning id into v_prod_rice;
  insert into public.products (shop_id, name, price_cents, cost_cents)
    values (v_shop_id, 'Storefront Ghost', 900, 200) returning id into v_prod_ghost;
  insert into public.products (shop_id, name, price_cents, cost_cents)
    values (v_shop_id, 'Storefront Drift', 700, 150) returning id into v_prod_drift;

  -- Rice is stocked at ONE against an order for five. That is the shortfall
  -- check 29 turns on, and it is a real shape: Plan 3 deliberately does not
  -- reserve stock at checkout, so an order can outlive the stock behind it.
  insert into public.product_location_stock (product_id, location_id, stock)
    values (v_prod_tea, v_loc_id, 100), (v_prod_coffee, v_loc_id, 100),
           (v_prod_rice, v_loc_id, 1),  (v_prod_ghost, v_loc_id, 100),
           (v_prod_drift, v_loc_id, 100);

  insert into public.orders (shop_id, customer_name, customer_phone, fulfilment, subtotal_cents, delivery_fee_cents, total_cents)
    values (v_shop_id, 'Collect Customer', '+252634100010', 'collect', 4000, 0, 4000)
    returning id into v_collect_id;
  insert into public.order_items (order_id, product_id, product_name, unit_price_cents, quantity, line_total_cents)
    values (v_collect_id, v_prod_tea, 'Storefront Tea', 2000, 2, 4000);

  insert into public.orders (shop_id, customer_name, customer_phone, fulfilment, delivery_area, delivery_landmark, subtotal_cents, delivery_fee_cents, total_cents)
    values (v_shop_id, 'Deliver Customer', '+252634100011', 'deliver', 'Xero Awr', 'By the blue gate', 3000, 1500, 4500)
    returning id into v_deliver_id;
  insert into public.order_items (order_id, product_id, product_name, unit_price_cents, quantity, line_total_cents)
    values (v_deliver_id, v_prod_coffee, 'Storefront Coffee', 3000, 1, 3000);

  insert into public.orders (shop_id, customer_name, customer_phone, fulfilment, subtotal_cents, delivery_fee_cents, total_cents)
    values (v_shop_id, 'Short Customer', '+252634100012', 'collect', 2500, 0, 2500)
    returning id into v_short_id;
  insert into public.order_items (order_id, product_id, product_name, unit_price_cents, quantity, line_total_cents)
    values (v_short_id, v_prod_rice, 'Storefront Rice', 500, 5, 2500);

  insert into public.orders (shop_id, customer_name, customer_phone, fulfilment, subtotal_cents, delivery_fee_cents, total_cents)
    values (v_shop_id, 'Pending Customer', '+252634100013', 'collect', 900, 0, 900)
    returning id into v_pending_id;
  insert into public.order_items (order_id, product_id, product_name, unit_price_cents, quantity, line_total_cents)
    values (v_pending_id, v_prod_tea, 'Storefront Tea', 2000, 1, 2000);

  insert into public.orders (shop_id, customer_name, customer_phone, fulfilment, subtotal_cents, delivery_fee_cents, total_cents)
    values (v_shop_id, 'Ghost Customer', '+252634100014', 'collect', 900, 0, 900)
    returning id into v_ghost_id;
  insert into public.order_items (order_id, product_id, product_name, unit_price_cents, quantity, line_total_cents)
    values (v_ghost_id, v_prod_ghost, 'Storefront Ghost', 900, 1, 900);

  insert into public.orders (shop_id, customer_name, customer_phone, fulfilment, subtotal_cents, delivery_fee_cents, total_cents)
    values (v_shop_id, 'Drift Customer', '+252634100015', 'collect', 700, 0, 700)
    returning id into v_drift_id;
  insert into public.order_items (order_id, product_id, product_name, unit_price_cents, quantity, line_total_cents)
    values (v_drift_id, v_prod_drift, 'Storefront Drift', 700, 1, 700);

  perform set_config('request.jwt.claims', json_build_object('sub', v_owner_id)::text, true);
  perform set_config('role', 'authenticated', true);

  -- Walked to 'ready' through the ordinary door, not forced: an order these
  -- checks complete must have got there the way a real one does.
  perform public.transition_order(v_collect_id, 'accepted', null);
  perform public.transition_order(v_collect_id, 'ready', null);
  perform public.transition_order(v_deliver_id, 'accepted', null);
  perform public.transition_order(v_deliver_id, 'ready', null);
  perform public.transition_order(v_short_id, 'accepted', null);
  perform public.transition_order(v_short_id, 'ready', null);
  perform public.transition_order(v_ghost_id, 'accepted', null);
  perform public.transition_order(v_ghost_id, 'ready', null);
  perform public.transition_order(v_drift_id, 'accepted', null);
  perform public.transition_order(v_drift_id, 'ready', null);

  -- ------------------------------------------------ 1. pending -> accepted
  v_result := public.transition_order(v_order_id, 'accepted', null);
  if v_result.status <> 'accepted' then
    raise exception 'FAIL: pending -> accepted did not land (got %)', v_result.status;
  end if;

  -- ------------------------------------------------ 2. accepted -> ready
  v_result := public.transition_order(v_order_id, 'ready', null);
  if v_result.status <> 'ready' then
    raise exception 'FAIL: accepted -> ready did not land (got %)', v_result.status;
  end if;

  -- ------------------------------------------------ 3. ready -> completed is refused
  -- The single most important property this migration has: Task 4 owns
  -- completion because it is the one move that writes to the ledger.
  v_raised := false;
  begin
    perform public.transition_order(v_order_id, 'completed', null);
  exception
    when others then
      if sqlerrm = 'invalid_order_transition' then v_raised := true; else raise; end if;
  end;
  if not v_raised then
    raise exception 'FAIL: ready -> completed was accepted -- this function can bypass Task 4''s posting';
  end if;
  if (select status from public.orders where id = v_order_id) <> 'ready' then
    raise exception 'FAIL: a refused completion still changed the stored status';
  end if;

  -- ------------------------------------------------ 4. pending -> completed is refused too
  v_raised := false;
  begin
    perform public.transition_order(v_cancel1_id, 'completed', null);
  exception
    when others then
      if sqlerrm = 'invalid_order_transition' then v_raised := true; else raise; end if;
  end;
  if not v_raised then
    raise exception 'FAIL: pending -> completed was accepted';
  end if;

  -- ------------------------------------------------ 5. cancel from pending, with a reason
  v_result := public.transition_order(v_cancel1_id, 'cancelled', 'Customer changed their mind');
  if v_result.status <> 'cancelled' then
    raise exception 'FAIL: pending -> cancelled did not land (got %)', v_result.status;
  end if;

  -- ------------------------------------------------ 6. cancel from accepted, with a reason
  v_result := public.transition_order(v_cancel2_id, 'accepted', null);
  v_result := public.transition_order(v_cancel2_id, 'cancelled', 'Out of stock after all');
  if v_result.status <> 'cancelled' then
    raise exception 'FAIL: accepted -> cancelled did not land (got %)', v_result.status;
  end if;

  -- ------------------------------------------------ 7. cancel from ready, and the reason is stored
  v_result := public.transition_order(v_cancel3_id, 'accepted', null);
  v_result := public.transition_order(v_cancel3_id, 'ready', null);
  v_result := public.transition_order(v_cancel3_id, 'cancelled', '  Customer never came to collect  ');
  if v_result.status <> 'cancelled' then
    raise exception 'FAIL: ready -> cancelled did not land (got %)', v_result.status;
  end if;
  if (select cancellation_reason from public.orders where id = v_cancel3_id) <> 'Customer never came to collect' then
    raise exception 'FAIL: the cancellation reason was not stored (trimmed), got %',
      (select cancellation_reason from public.orders where id = v_cancel3_id);
  end if;

  -- ------------------------------------------------ 8. cancelling with no reason is refused
  v_raised := false;
  begin
    perform public.transition_order(v_order_id, 'cancelled', null);
  exception
    when others then
      if sqlerrm = 'cancellation_reason_required' then v_raised := true; else raise; end if;
  end;
  if not v_raised then
    raise exception 'FAIL: an order was cancelled with no reason recorded';
  end if;

  -- ------------------------------------------------ 9. cancelling with a whitespace-only reason is refused
  v_raised := false;
  begin
    perform public.transition_order(v_order_id, 'cancelled', '    ');
  exception
    when others then
      if sqlerrm = 'cancellation_reason_required' then v_raised := true; else raise; end if;
  end;
  if not v_raised then
    raise exception 'FAIL: an order was cancelled with a whitespace-only reason';
  end if;

  -- ------------------------------------------------ 10/11. backwards moves are refused, both directions
  v_raised := false;
  begin
    perform public.transition_order(v_order_id, 'accepted', null); -- v_order_id is 'ready'
  exception
    when others then
      if sqlerrm = 'invalid_order_transition' then v_raised := true; else raise; end if;
  end;
  if not v_raised then
    raise exception 'FAIL: ready -> accepted (backwards) was accepted';
  end if;

  v_raised := false;
  begin
    perform public.transition_order(v_cancel2_id, 'pending', null); -- v_cancel2_id is 'cancelled'
  exception
    when others then
      if sqlerrm = 'invalid_order_transition' then v_raised := true; else raise; end if;
  end;
  if not v_raised then
    raise exception 'FAIL: cancelled -> pending (backwards, and out of a terminal state) was accepted';
  end if;

  -- ------------------------------------------------ 12. same-state is a no-op, not an error
  -- v_order_id is 'ready'. Calling transition_order(order, 'ready') again
  -- must not raise -- see this file's header for why -- and must not
  -- disturb the row.
  v_result := public.transition_order(v_order_id, 'ready', null);
  if v_result.status <> 'ready' then
    raise exception 'FAIL: a same-state call did not return the current row';
  end if;
  if (select cancellation_reason from public.orders where id = v_order_id) is not null then
    raise exception 'FAIL: a same-state call wrote a cancellation reason';
  end if;

  -- ------------------------------------------------ 13. a value outside the vocabulary hits the base CHECK, not this migration
  v_raised := false;
  begin
    perform public.transition_order(v_order_id, 'made_up_status', null);
  exception when check_violation then v_raised := true;
  end;
  if not v_raised then
    raise exception 'FAIL: an unknown status value was accepted';
  end if;

  -- ------------------------------------------------ 14. moving out of cancelled is refused
  v_raised := false;
  begin
    perform public.transition_order(v_cancel1_id, 'accepted', null); -- already 'cancelled'
  exception
    when others then
      if sqlerrm = 'invalid_order_transition' then v_raised := true; else raise; end if;
  end;
  if not v_raised then
    raise exception 'FAIL: cancelled -> accepted was accepted';
  end if;

  -- ------------------------------------------------ 15. moving out of completed is refused
  -- Nothing built so far can legitimately put a row into 'completed' -- that
  -- is the whole point -- so it is forced into existence the same way
  -- verify-orders.sql forces its own trigger-backed invariants: disable the
  -- trigger, force the value by hand, re-enable it, then prove the
  -- transition guard refuses to move it anywhere from there.
  -- ALTER TABLE ... DISABLE TRIGGER needs table ownership, which
  -- `authenticated` does not have -- drop back to postgres for the two
  -- statements that need it, same as verify-orders.sql's own use of this
  -- technique.
  perform set_config('role', 'postgres', true);
  alter table public.orders disable trigger orders_status_transition;
  update public.orders set status = 'completed' where id = v_forced_id;
  alter table public.orders enable trigger orders_status_transition;
  perform set_config('role', 'authenticated', true);

  v_raised := false;
  begin
    perform public.transition_order(v_forced_id, 'cancelled', 'Too late');
  exception
    when others then
      if sqlerrm = 'invalid_order_transition' then v_raised := true; else raise; end if;
  end;
  if not v_raised then
    raise exception 'FAIL: completed -> cancelled was accepted';
  end if;

  -- ------------------------------------------------ 16. a client-supplied status/reason at insert is overridden
  -- Same override orders_copy_payment_mode already applies to payment_mode
  -- (verify-orders.sql check 7), extended to status: whatever a caller sends
  -- at insert time, the row lands 'pending' with no cancellation reason.
  --
  -- As postgres, not authenticated: 20260928000300_orders_write_lockdown.sql
  -- revoked authenticated's INSERT on `orders` entirely (verify-orders.sql
  -- check 15 proves that directly), so there is no supported direct-insert
  -- door left for a shop member to try this through -- place_storefront_order
  -- is the only insert door and accepts no status/cancellation_reason of its
  -- own to override. This is belt and braces: the trigger's own INSERT
  -- override still holds for a writer that bypasses the grant.
  perform set_config('role', 'postgres', true);
  declare
    v_new_id uuid;
  begin
    insert into public.orders (shop_id, customer_name, customer_phone, fulfilment, subtotal_cents, total_cents, status, cancellation_reason)
      values (v_shop_id, 'Sneaky Insert', '+252634100006', 'collect', 100, 100, 'completed', 'not really')
      returning id into v_new_id;
    if (select status from public.orders where id = v_new_id) <> 'pending' then
      raise exception 'FAIL: a client-supplied status at insert overrode the default (got %)',
        (select status from public.orders where id = v_new_id);
    end if;
    if (select cancellation_reason from public.orders where id = v_new_id) is not null then
      raise exception 'FAIL: a client-supplied cancellation_reason at insert was kept';
    end if;
  end;
  perform set_config('role', 'authenticated', true);

  -- ------------------------------------------------ 17. the cancellation-reason CHECK is real on its own
  perform set_config('role', 'postgres', true);
  alter table public.orders disable trigger orders_status_transition;
  v_raised := false;
  begin
    update public.orders set status = 'cancelled', cancellation_reason = null where id = v_cancel1_id;
  exception when check_violation then v_raised := true;
  end;
  alter table public.orders enable trigger orders_status_transition;
  perform set_config('role', 'authenticated', true);
  if not v_raised then
    raise exception 'FAIL: a cancelled order with no reason was accepted at the CHECK level';
  end if;

  -- ------------------------------------------------ 18. the table itself is honest, in two independent layers
  -- (a) 20260928000300_orders_write_lockdown.sql revoked authenticated's
  --     insert/update/delete on `orders`, so a shop member's own plain
  --     UPDATE (RLS, nothing to do with transition_order) is refused before
  --     it ever reaches the trigger -- insufficient_privilege, not
  --     invalid_order_transition.
  v_raised := false;
  begin
    update public.orders set status = 'ready' where id = v_cancel2_id; -- v_cancel2_id is 'cancelled'
  exception when insufficient_privilege then v_raised := true;
  end;
  if not v_raised then
    raise exception 'FAIL: a direct UPDATE as authenticated bypassed the revoked grant';
  end if;

  -- (b) Belt and braces: even a writer that DOES hold the table privilege --
  --     a future migration that re-grants it, or postgres itself -- is still
  --     refused by the trigger, because the trigger fires for every writer
  --     regardless of grant. This is what actually enforces the
  --     permitted-moves table; (a) merely closes the door most callers would
  --     have used to reach it.
  perform set_config('role', 'postgres', true);
  v_raised := false;
  begin
    update public.orders set status = 'ready' where id = v_cancel2_id; -- v_cancel2_id is 'cancelled'
  exception
    when others then
      if sqlerrm = 'invalid_order_transition' then v_raised := true; else raise; end if;
  end;
  perform set_config('role', 'authenticated', true);
  if not v_raised then
    raise exception 'FAIL: a direct UPDATE bypassed the transition guard';
  end if;

  -- ------------------------------------------------ 19. an unknown order id is refused
  v_raised := false;
  v_detail := null;
  begin
    perform public.transition_order(gen_random_uuid(), 'accepted', null);
  exception when others then v_raised := true; v_detail := sqlerrm;
  end;
  if not v_raised then
    raise exception 'FAIL: an unknown order id was accepted';
  end if;
  if v_detail not like 'order % not found' then
    raise exception 'FAIL: refused, but not for the expected reason (%)', v_detail;
  end if;

  -- ------------------------------------------------ 20. a member of a DIFFERENT shop may not move this order
  perform set_config('request.jwt.claims', json_build_object('sub', v_outsider_id)::text, true);
  v_raised := false;
  v_detail := null;
  begin
    perform public.transition_order(v_cancel3_id, 'accepted', null); -- already 'cancelled', but auth must fail first
  exception when others then v_raised := true; v_detail := sqlerrm;
  end;
  perform set_config('request.jwt.claims', json_build_object('sub', v_owner_id)::text, true);
  if not v_raised then
    raise exception 'FAIL: an outsider moved another shop''s order';
  end if;
  if v_detail not like 'not authorized for order%' then
    raise exception 'FAIL: refused, but not for the expected reason (%)', v_detail;
  end if;

  -- ------------------------------------------------ 21. authenticated holds EXECUTE
  if not has_function_privilege('authenticated', 'public.transition_order(uuid,text,text)', 'EXECUTE') then
    raise exception 'FAIL: authenticated cannot execute transition_order';
  end if;

  -- ------------------------------------------------ 22. anon never does -- a customer does not move their own order
  if has_function_privilege('anon', 'public.transition_order(uuid,text,text)', 'EXECUTE') then
    raise exception 'FAIL: anon can execute transition_order on paper';
  end if;
  set local role anon;
  v_raised := false;
  begin
    perform public.transition_order(v_order_id, 'ready', null);
  exception when insufficient_privilege then v_raised := true;
  end;
  reset role;
  if not v_raised then
    raise exception 'FAIL: anon could call transition_order directly';
  end if;

  -- ══════════════════════════════════════════════════════════════════════
  -- complete_storefront_order: the one move that reaches the books.
  --
  -- `reset role` in check 22 left this block running as postgres, which is
  -- what the ledger assertions below want -- RLS must not hide a
  -- journal_lines row from a script asserting about it, the same posture
  -- verify-posting-sales.sql takes for the whole of itself. Nothing under
  -- test here is a policy: complete_storefront_order gates on
  -- is_shop_member/shop_has_module, both of which read auth.uid() from the
  -- JWT claim still set above and do not care which postgres role is
  -- executing. The two checks that DO care (34's plain RLS update, 35's
  -- anon call) set their own role and put it back.
  -- ══════════════════════════════════════════════════════════════════════

  -- ------------------------------------------------ 23. a ready order completes and records its sale
  v_sale_collect := public.complete_storefront_order(v_collect_id, 'cash');
  if v_sale_collect is null then
    raise exception 'FAIL: completing an order returned no sale id';
  end if;
  if not exists (select 1 from public.sales where id = v_sale_collect and shop_id = v_shop_id) then
    raise exception 'FAIL: the returned sale id % is not a sale of this shop', v_sale_collect;
  end if;

  select status, sale_id into v_detail, v_result.sale_id
    from public.orders where id = v_collect_id;
  if v_detail <> 'completed' then
    raise exception 'FAIL: a completed order is still %', v_detail;
  end if;
  if v_result.sale_id is distinct from v_sale_collect then
    raise exception 'FAIL: the order records sale % but completion returned % -- the two can never be reconciled',
      v_result.sale_id, v_sale_collect;
  end if;

  -- ------------------------------------------------ 24. the sale's lines are the order's SNAPSHOT
  -- Compared as a set of quadruples in both directions, so a sale that
  -- invented an extra line fails as loudly as one that dropped a line or
  -- re-priced one.
  select count(*) into v_count
    from (
      select product_name, unit_price_cents, quantity, line_total_cents
        from public.order_items where order_id = v_collect_id
      except
      select product_name, unit_price_cents, quantity, line_total_cents
        from public.sale_items where sale_id = v_sale_collect
      union all
      select product_name, unit_price_cents, quantity, line_total_cents
        from public.sale_items where sale_id = v_sale_collect
      except
      select product_name, unit_price_cents, quantity, line_total_cents
        from public.order_items where order_id = v_collect_id
    ) diff;
  if v_count <> 0 then
    raise exception 'FAIL: the sale''s lines are not the order''s snapshot (% line(s) differ)', v_count;
  end if;

  -- ------------------------------------------------ 25. a collect order posts one balanced entry, and never touches 4300
  select journal_entry_id into v_entry_sale from public.sales where id = v_sale_collect;
  if v_entry_sale is null then
    raise exception 'FAIL: the sale posted no journal entry';
  end if;
  -- Kept apart from v_entry_sale, which check 26 onward reassigns to
  -- v_sale_deliver's own entry -- see the declaration's comment. Check 38
  -- needs v_collect_id's entry specifically, long after that reassignment.
  v_entry_collect := v_entry_sale;

  select coalesce(sum(amount_cents), 0) into v_amount
    from public.journal_lines where entry_id = v_entry_sale;
  if v_amount <> 0 then
    raise exception 'FAIL: the sale''s entry does not balance -- debits and credits differ by %', v_amount;
  end if;

  -- 2 x 2000 into 4000 Sales Revenue, and 4000 cents of cash in.
  select coalesce(sum(jl.amount_cents), 0) into v_amount
    from public.journal_lines jl join public.accounts a on a.id = jl.account_id
   where jl.entry_id = v_entry_sale and a.code = '4000';
  if v_amount <> -4000 then
    raise exception 'FAIL: expected 4000 credited 4000 cents of goods revenue, got %', v_amount;
  end if;
  select coalesce(sum(jl.amount_cents), 0) into v_amount
    from public.journal_lines jl join public.accounts a on a.id = jl.account_id
   where jl.entry_id = v_entry_sale and a.code = '1000';
  if v_amount <> 4000 then
    raise exception 'FAIL: expected 1000 Cash debited 4000, got %', v_amount;
  end if;

  -- The control for check 26: an order with NO delivery must leave 4300
  -- completely untouched, shop-wide. An implementation that credited it
  -- unconditionally (or credited a zero line) fails here and passes 26.
  select count(*) into v_count
    from public.journal_lines jl
    join public.accounts a on a.id = jl.account_id
   where a.shop_id = v_shop_id and a.code = '4300';
  if v_count <> 0 then
    raise exception 'FAIL: a collect order with no delivery posted % line(s) to 4300', v_count;
  end if;

  -- ------------------------------------------------ 26. the delivery fee credits 4300, never 4000
  v_sale_deliver := public.complete_storefront_order(v_deliver_id, 'zaad');
  select journal_entry_id into v_entry_sale from public.sales where id = v_sale_deliver;

  select id into v_entry_fee
    from public.journal_entries
   where shop_id = v_shop_id
     and id <> v_entry_sale
     and description like '%' || v_sale_deliver::text || '%';
  if v_entry_fee is null then
    raise exception 'FAIL: the delivery fee posted no entry naming its sale';
  end if;

  -- 4300 holds the fee, exactly, shop-wide.
  select coalesce(sum(jl.amount_cents), 0) into v_amount
    from public.journal_lines jl join public.accounts a on a.id = jl.account_id
   where a.shop_id = v_shop_id and a.code = '4300';
  if v_amount <> -1500 then
    raise exception 'FAIL: expected 4300 Delivery Income credited 1500, got %', v_amount;
  end if;

  -- And 4000 holds the GOODS ONLY -- 3000, not 4500. This is the assertion
  -- that would catch the fee being folded into sales revenue.
  select coalesce(sum(jl.amount_cents), 0) into v_amount
    from public.journal_lines jl join public.accounts a on a.id = jl.account_id
   where jl.entry_id = v_entry_sale and a.code = '4000';
  if v_amount <> -3000 then
    raise exception 'FAIL: expected 4000 credited 3000 of goods revenue, got % (the delivery fee has leaked into it)', v_amount;
  end if;

  -- Neither entry strays into the other's account.
  if exists (
    select 1 from public.journal_lines jl join public.accounts a on a.id = jl.account_id
     where jl.entry_id = v_entry_sale and a.code = '4300') then
    raise exception 'FAIL: the sale''s own entry carries a 4300 line';
  end if;
  if exists (
    select 1 from public.journal_lines jl join public.accounts a on a.id = jl.account_id
     where jl.entry_id = v_entry_fee and a.code = '4000') then
    raise exception 'FAIL: the delivery entry carries a 4000 Sales Revenue line';
  end if;

  -- ------------------------------------------------ 27. the fee's entry balances on its own, and ties to both records
  select coalesce(sum(amount_cents), 0) into v_amount
    from public.journal_lines where entry_id = v_entry_fee;
  if v_amount <> 0 then
    raise exception 'FAIL: the delivery entry does not balance -- debits and credits differ by %', v_amount;
  end if;

  select count(*) into v_count from public.journal_lines where entry_id = v_entry_fee;
  if v_count <> 2 then
    raise exception 'FAIL: expected the delivery entry to be two lines, got %', v_count;
  end if;

  select description into v_detail from public.journal_entries where id = v_entry_fee;
  if v_detail not like '%' || (select number from public.orders where id = v_deliver_id)::text || '%' then
    raise exception 'FAIL: the delivery entry (%) does not name its order number', v_detail;
  end if;
  if v_detail not like '%' || v_sale_deliver::text || '%' then
    raise exception 'FAIL: the delivery entry (%) does not name its sale', v_detail;
  end if;

  select source into v_detail from public.journal_entries where id = v_entry_fee;
  if v_detail <> 'sale' then
    raise exception 'FAIL: the delivery entry''s source is % -- ''manual'' would gate it on ledger.post, which a shopkeeper handing over an order must not need', v_detail;
  end if;

  -- ------------------------------------------------ 28. the fee follows the method actually taken, and the money adds up
  -- zaad, so 1020 -- not a hardcoded 1000 Cash.
  select coalesce(sum(jl.amount_cents), 0) into v_amount
    from public.journal_lines jl join public.accounts a on a.id = jl.account_id
   where jl.entry_id = v_entry_fee and a.code = '1020';
  if v_amount <> 1500 then
    raise exception 'FAIL: expected the fee debited to 1020 Mobile Money — Zaad, got % there', v_amount;
  end if;
  if exists (
    select 1 from public.journal_lines jl join public.accounts a on a.id = jl.account_id
     where jl.entry_id = v_entry_fee and a.code = '1000') then
    raise exception 'FAIL: the fee was debited to 1000 Cash on an order paid by zaad';
  end if;

  -- Both entries together bring in exactly what the customer was quoted.
  select coalesce(sum(jl.amount_cents), 0) into v_amount
    from public.journal_lines jl join public.accounts a on a.id = jl.account_id
   where jl.entry_id in (v_entry_sale, v_entry_fee) and a.code = '1020';
  if v_amount <> (select total_cents from public.orders where id = v_deliver_id) then
    raise exception 'FAIL: the two entries bring in % but the order total is %',
      v_amount, (select total_cents from public.orders where id = v_deliver_id);
  end if;

  -- One order's money must not straddle two months, or two branches.
  select entry_date, location_id into v_date_sale, v_loc_sale
    from public.journal_entries where id = v_entry_sale;
  select entry_date, location_id into v_date_fee, v_loc_fee
    from public.journal_entries where id = v_entry_fee;
  if v_date_sale <> v_date_fee then
    raise exception 'FAIL: the sale is dated % and its delivery fee % -- once a period closes that is unfixable',
      v_date_sale, v_date_fee;
  end if;
  if v_loc_sale is distinct from v_loc_fee then
    raise exception 'FAIL: the sale is stamped location % and its delivery fee % -- the same cash in two branches',
      v_loc_sale, v_loc_fee;
  end if;

  -- ------------------------------------------------ 29. a shortfall leaves the order untouched
  select stock into v_stock_before
    from public.product_location_stock where product_id = v_prod_rice and location_id = v_loc_id;
  select count(*) into v_sales_before from public.sales where shop_id = v_shop_id;

  v_raised := false;
  v_detail := null;
  begin
    perform public.complete_storefront_order(v_short_id, 'cash');
  exception
    when others then
      v_detail := sqlerrm;
      if v_detail = 'insufficient_stock' then v_raised := true; else raise; end if;
  end;
  if not v_raised then
    raise exception 'FAIL: an order for five of something the shop holds one of was completed';
  end if;

  select status, sale_id into v_detail, v_result.sale_id from public.orders where id = v_short_id;
  if v_detail <> 'ready' then
    raise exception 'FAIL: a refused completion left the order at % -- half-completed is worse than failed', v_detail;
  end if;
  if v_result.sale_id is not null then
    raise exception 'FAIL: a refused completion still attached sale % to the order', v_result.sale_id;
  end if;
  select stock into v_count
    from public.product_location_stock where product_id = v_prod_rice and location_id = v_loc_id;
  if v_count <> v_stock_before then
    raise exception 'FAIL: a refused completion moved stock from % to %', v_stock_before, v_count;
  end if;
  select count(*) into v_count from public.sales where shop_id = v_shop_id;
  if v_count <> v_sales_before then
    raise exception 'FAIL: a refused completion still wrote a sale (% -> %)', v_sales_before, v_count;
  end if;

  -- ------------------------------------------------ 30. completing twice is refused, and writes no second sale
  -- 'completed' -> 'completed' is a SAME-STATUS move, which the trigger's
  -- early return waves through -- so the function's own status guard is the
  -- only thing between a shop's retry and a duplicate posting.
  v_raised := false;
  v_detail := null;
  begin
    perform public.complete_storefront_order(v_collect_id, 'cash');
  exception
    when others then
      v_detail := sqlerrm;
      if v_detail = 'invalid_order_transition' then v_raised := true; else raise; end if;
  end;
  if not v_raised then
    raise exception 'FAIL: an already-completed order was completed a second time';
  end if;
  if (select sale_id from public.orders where id = v_collect_id) is distinct from v_sale_collect then
    raise exception 'FAIL: a second completion re-pointed the order at a different sale';
  end if;
  select count(*) into v_count from public.sales where shop_id = v_shop_id;
  if v_count <> v_sales_before then
    raise exception 'FAIL: a refused second completion still wrote a sale (% -> %)', v_sales_before, v_count;
  end if;

  -- ------------------------------------------------ 31. an order that is not ready cannot be completed
  v_raised := false;
  v_detail := null;
  begin
    perform public.complete_storefront_order(v_pending_id, 'cash');  -- still 'pending'
  exception
    when others then
      v_detail := sqlerrm;
      if v_detail = 'invalid_order_transition' then v_raised := true; else raise; end if;
  end;
  if not v_raised then
    raise exception 'FAIL: a pending order went straight to the ledger';
  end if;

  -- ------------------------------------------------ 32. a member of another shop cannot complete this order
  perform set_config('request.jwt.claims', json_build_object('sub', v_outsider_id)::text, true);
  v_raised := false;
  v_detail := null;
  begin
    perform public.complete_storefront_order(v_short_id, 'cash');
  exception when others then v_raised := true; v_detail := sqlerrm;
  end;
  perform set_config('request.jwt.claims', json_build_object('sub', v_owner_id)::text, true);
  if not v_raised then
    raise exception 'FAIL: an outsider completed another shop''s order into that shop''s books';
  end if;
  if v_detail not like 'not authorized for order%' then
    raise exception 'FAIL: refused, but not for the expected reason (%)', v_detail;
  end if;

  -- ------------------------------------------------ 33. a deleted product raises a code, not complete_sale's raw message
  delete from public.product_location_stock where product_id = v_prod_ghost;
  delete from public.products where id = v_prod_ghost;
  if (select product_id from public.order_items where order_id = v_ghost_id) is not null then
    raise exception 'FAIL: FIXTURE deleting the product did not null the order line''s product_id';
  end if;

  v_raised := false;
  v_detail := null;
  begin
    perform public.complete_storefront_order(v_ghost_id, 'cash');
  exception
    when others then
      v_detail := sqlerrm;
      if v_detail = 'order_product_deleted' then v_raised := true; else raise; end if;
  end;
  if not v_raised then
    raise exception 'FAIL: an order whose product no longer exists was completed (or refused with %)', v_detail;
  end if;

  -- ------------------------------------------------ 34. an order whose prices have moved completes AT THE PRICE THE CUSTOMER AGREED TO
  -- RE-FOUNDED BY 20260929000200, on the same fixture. This check used to
  -- prove the opposite -- that a re-priced order was REFUSED with
  -- `order_total_changed` -- because complete_sale priced every line from the
  -- CURRENT products.price_cents, so the 700 the customer agreed to met a 1300
  -- sale total and the shop's own price rise stranded its open orders.
  --
  -- Now the order's own snapshot is authoritative: each line goes to
  -- complete_sale as `agreed_unit_price_cents`, and this order posts at 700
  -- while the shelf goes on saying 1300. The refusal this check used to prove
  -- has not been deleted, it has been narrowed -- `order_total_changed` now
  -- fires only when an order row disagrees with its OWN lines, which is check
  -- 50 in the second block below. Check 46 there is this same property with
  -- the full ledger assertions on it; this one stays because this fixture is
  -- the historical one and a regression should fail here first.
  --
  -- ITS RAISES CARRY THEIR NUMBER, unlike the rest of this block. That is
  -- 20260929000250's tidy-up of a real confusion: Task 4's report tabulates
  -- mutation results by check number, and this was the one row whose failure
  -- text could not be traced back to the number beside it. The second block
  -- below has numbered every raise since check 46; this check is re-founded
  -- work and joins that convention rather than the surrounding block's.
  update public.products set price_cents = 1300 where id = v_prod_drift;
  v_drift_sale_id := public.complete_storefront_order(v_drift_id, 'cash');
  if (select total_cents from public.sales where id = v_drift_sale_id) <> 700 then
    raise exception 'FAIL 34: the sale posted at % -- the customer agreed to 700 and the shelf now says 1300',
      (select total_cents from public.sales where id = v_drift_sale_id);
  end if;
  if (select unit_price_cents from public.sale_items where sale_id = v_drift_sale_id) <> 700 then
    raise exception 'FAIL 34: the sale line was not filed at the agreed 700';
  end if;
  select status, sale_id into v_detail, v_result.sale_id from public.orders where id = v_drift_id;
  if v_detail <> 'completed' or v_result.sale_id is distinct from v_drift_sale_id then
    raise exception 'FAIL 34: a re-priced order completed but the order reads % against sale %', v_detail, v_result.sale_id;
  end if;

  -- ------------------------------------------------ 35. two independent layers hold the line, not just the function
  -- (a) A shop member's plain RLS update to 'completed' attaches no sale.
  --     Refused OUTRIGHT now: authenticated holds no UPDATE privilege on
  --     `orders` at all (20260928000300_orders_write_lockdown.sql). Belt and
  --     braces beneath that: even a writer that bypassed the grant would
  --     still be refused by the trigger -- the exact property
  --     20260928000100 exists for, re-proven now that the edge exists at
  --     all.
  perform set_config('role', 'authenticated', true);
  v_raised := false;
  begin
    update public.orders set status = 'completed' where id = v_short_id;  -- 'ready'
  exception when insufficient_privilege then v_raised := true;
  end;
  if not v_raised then
    raise exception 'FAIL: a direct UPDATE as authenticated bypassed the revoked grant';
  end if;

  perform set_config('role', 'postgres', true);
  v_raised := false;
  begin
    update public.orders set status = 'completed' where id = v_short_id;  -- 'ready'
  exception
    when others then
      if sqlerrm = 'invalid_order_transition' then v_raised := true; else raise; end if;
  end;
  if not v_raised then
    raise exception 'FAIL: a direct UPDATE marked an order completed with nothing in the books';
  end if;

  -- (b) A sale link already set cannot be re-pointed at a different sale --
  --     that is how one sale's money could be made to settle two orders.
  --     Same two layers.
  perform set_config('role', 'authenticated', true);
  v_raised := false;
  begin
    update public.orders set sale_id = v_sale_collect where id = v_deliver_id;
  exception when insufficient_privilege then v_raised := true;
  end;
  if not v_raised then
    raise exception 'FAIL: a direct UPDATE as authenticated bypassed the revoked grant';
  end if;

  perform set_config('role', 'postgres', true);
  v_raised := false;
  begin
    update public.orders set sale_id = v_sale_collect where id = v_deliver_id;
  exception
    when others then
      if sqlerrm = 'order_sale_is_immutable' then v_raised := true; else raise; end if;
  end;
  if not v_raised then
    raise exception 'FAIL: a completed order''s sale link was re-pointed at another sale';
  end if;

  -- (c) The CHECK is real on its own, not merely implied by the trigger --
  --     same disable-trigger technique as checks 15 and 17.
  alter table public.orders disable trigger orders_status_transition;
  v_raised := false;
  begin
    update public.orders set sale_id = v_sale_collect where id = v_short_id;  -- 'ready'
  exception when check_violation then v_raised := true;
  end;
  alter table public.orders enable trigger orders_status_transition;
  if not v_raised then
    raise exception 'FAIL: a sale was attached to an order that is not completed';
  end if;

  -- ------------------------------------------------ 36. the grant on complete_storefront_order
  if not has_function_privilege('authenticated', 'public.complete_storefront_order(uuid,text)', 'EXECUTE') then
    raise exception 'FAIL: authenticated cannot execute complete_storefront_order';
  end if;
  if has_function_privilege('anon', 'public.complete_storefront_order(uuid,text)', 'EXECUTE') then
    raise exception 'FAIL: anon can execute complete_storefront_order on paper -- Postgres grants EXECUTE to PUBLIC by default, so the revoke is missing';
  end if;
  set local role anon;
  v_raised := false;
  begin
    perform public.complete_storefront_order(v_short_id, 'cash');
  exception when insufficient_privilege then v_raised := true;
  end;
  reset role;
  if not v_raised then
    raise exception 'FAIL: anon could post a sale into a shop''s ledger';
  end if;

  -- ══════════════════════════════════════════════════════════════════════
  -- Task 5: cancelling writes nothing to the books.
  --
  -- transition_order's whole body is one UPDATE against orders -- see this
  -- file's header for why checks 37/38 exist despite that already being
  -- true by construction: they are a regression net, and 38 additionally
  -- proves the ledger-safety consequence on a REAL sale, not an abstract one.
  -- ══════════════════════════════════════════════════════════════════════

  -- ------------------------------------------------ 37. cancelling an order that carries items writes nothing, and keeps them
  insert into public.orders (shop_id, customer_name, customer_phone, fulfilment, subtotal_cents, delivery_fee_cents, total_cents)
    values (v_shop_id, 'Cancel With Items', '+252634100016', 'collect', 2000, 0, 2000)
    returning id into v_cancel_items_id;
  insert into public.order_items (order_id, product_id, product_name, unit_price_cents, quantity, line_total_cents)
    values (v_cancel_items_id, v_prod_tea, 'Storefront Tea', 2000, 1, 2000);

  perform public.transition_order(v_cancel_items_id, 'accepted', null);
  perform public.transition_order(v_cancel_items_id, 'ready', null);

  select count(*) into v_items_before from public.order_items where order_id = v_cancel_items_id;
  select count(*) into v_sales_before from public.sales where shop_id = v_shop_id;
  select count(*) into v_je_before from public.journal_entries where shop_id = v_shop_id;

  v_result := public.transition_order(v_cancel_items_id, 'cancelled', 'Customer no longer needs it');
  if v_result.status <> 'cancelled' then
    raise exception 'FAIL: ready -> cancelled (with items) did not land (got %)', v_result.status;
  end if;
  if (select cancellation_reason from public.orders where id = v_cancel_items_id) <> 'Customer no longer needs it' then
    raise exception 'FAIL: the cancellation reason was not stored for an order carrying items';
  end if;

  -- Property 2: the lines are exactly as they were. Nothing here deletes or
  -- touches order_items on cancellation -- this is what proves it, on a
  -- fixture that actually has a line to lose.
  select count(*) into v_count from public.order_items where order_id = v_cancel_items_id;
  if v_count <> v_items_before then
    raise exception 'FAIL: cancelling an order changed its line count from % to % -- the shop could not explain it weeks later',
      v_items_before, v_count;
  end if;

  -- Property 1, structurally: orders_sale_only_when_completed already makes
  -- this impossible (status <> 'completed' implies sale_id is null), so this
  -- line is confirmatory, not the proof -- the counts below are the proof.
  if (select sale_id from public.orders where id = v_cancel_items_id) is not null then
    raise exception 'FAIL: a cancelled order carries a sale id';
  end if;

  -- Property 1, by count, not by inference: a posting made for ANY reason
  -- during the cancel call -- not just one naming this order -- moves these
  -- counts and fails here.
  select count(*) into v_count from public.sales where shop_id = v_shop_id;
  if v_count <> v_sales_before then
    raise exception 'FAIL: cancelling an order wrote a sale (% -> %)', v_sales_before, v_count;
  end if;
  select count(*) into v_count from public.journal_entries where shop_id = v_shop_id;
  if v_count <> v_je_before then
    raise exception 'FAIL: cancelling an order posted a journal entry (% -> %)', v_je_before, v_count;
  end if;

  -- ------------------------------------------------ 38. a REAL completed order cannot be cancelled, and its posting survives the attempt
  -- v_collect_id has been 'completed' since check 23, with a real sale
  -- (v_sale_collect) and a posted, balanced journal entry (v_entry_collect,
  -- established at check 25 and kept apart from v_entry_sale, which check 26
  -- onward reassigns to v_sale_deliver's own entry). Check 15 already proves
  -- the state machine refuses completed -> cancelled in the abstract, on an
  -- order forced into 'completed' with no sale behind it at all; this proves
  -- the refusal holds for a real posting, through both doors, and that the
  -- posting is untouched by the attempt -- not merely that the attempt
  -- failed.
  --
  -- The line-sum-balances assertion below is real but cannot, on its own,
  -- fail: a BALANCED entry sums to zero before the refused cancellation and
  -- after it, whether or not anything touched the entry, because a second,
  -- MIRRORING reversal entry would also sum to zero and the check would
  -- never see it -- it only ever looks at v_entry_collect's own lines. The
  -- shop-wide journal_entries COUNT, snapshotted here and compared after, is
  -- what actually catches that: a regression where a refused cancellation
  -- appended a reversal entry instead of merely being refused would move
  -- this count and fail here even though every balance check above it still
  -- passed.
  select status into v_entry_status_before from public.journal_entries where id = v_entry_collect;
  select coalesce(sum(amount_cents), 0) into v_line_sum_before from public.journal_lines where entry_id = v_entry_collect;
  select count(*) into v_je_shop_before38 from public.journal_entries where shop_id = v_shop_id;

  v_raised := false;
  begin
    perform public.transition_order(v_collect_id, 'cancelled', 'Changed our mind after all');
  exception
    when others then
      if sqlerrm = 'invalid_order_transition' then v_raised := true; else raise; end if;
  end;
  if not v_raised then
    raise exception 'FAIL: a completed order with a real sale behind it was cancelled -- the way back is the refund path, not this';
  end if;

  select status, sale_id into v_detail, v_result.sale_id from public.orders where id = v_collect_id;
  if v_detail <> 'completed' or v_result.sale_id is distinct from v_sale_collect then
    raise exception 'FAIL: a refused cancellation still moved the completed order (status %, sale %)', v_detail, v_result.sale_id;
  end if;

  -- The plain RLS door too, not just transition_order -- same two-layer
  -- posture as checks 18 and 35(a): the revoked grant closes it outright for
  -- authenticated, and the trigger holds the line regardless of which writer
  -- reaches the row for anyone who bypasses that grant.
  perform set_config('role', 'authenticated', true);
  v_raised := false;
  begin
    update public.orders set status = 'cancelled', cancellation_reason = 'Direct update attempt' where id = v_collect_id;
  exception when insufficient_privilege then v_raised := true;
  end;
  if not v_raised then
    raise exception 'FAIL: a direct UPDATE as authenticated bypassed the revoked grant';
  end if;

  perform set_config('role', 'postgres', true);
  v_raised := false;
  begin
    update public.orders set status = 'cancelled', cancellation_reason = 'Direct update attempt' where id = v_collect_id;
  exception
    when others then
      if sqlerrm = 'invalid_order_transition' then v_raised := true; else raise; end if;
  end;
  if not v_raised then
    raise exception 'FAIL: a direct UPDATE cancelled a completed order';
  end if;

  -- Nothing about the posting moved: same status, same balance, and (the
  -- assertion that actually bites, see above) the same NUMBER of entries.
  -- This is what would catch a "cancellation" that quietly reversed or
  -- edited the sale's entry instead of merely being refused -- the exact
  -- concern this task's brief names: a cancellation that silently unposted
  -- a sale would leave the books wrong in a way nobody notices until a P&L
  -- looks odd.
  select status into v_entry_status_after from public.journal_entries where id = v_entry_collect;
  if v_entry_status_after <> v_entry_status_before then
    raise exception 'FAIL: the sale''s journal entry status moved from % to % after a refused cancellation',
      v_entry_status_before, v_entry_status_after;
  end if;
  select coalesce(sum(amount_cents), 0) into v_line_sum_after from public.journal_lines where entry_id = v_entry_collect;
  if v_line_sum_after <> v_line_sum_before then
    raise exception 'FAIL: the sale''s journal entry no longer balances the same way after a refused cancellation (% -> %)',
      v_line_sum_before, v_line_sum_after;
  end if;
  select count(*) into v_je_shop_after38 from public.journal_entries where shop_id = v_shop_id;
  if v_je_shop_after38 <> v_je_shop_before38 then
    raise exception 'FAIL: a refused cancellation changed the shop''s journal_entries count (% -> %) -- something posted (or reversed) despite being refused',
      v_je_shop_before38, v_je_shop_after38;
  end if;

  -- ══════════════════════════════════════════════════════════════════════
  -- The money-handling review's Critical finding: an order could reach
  -- 'completed' with nothing posted, by attaching a sale the trigger never
  -- checked anything about. Reproduced here exactly as the review found it
  -- -- AS POSTGRES, bypassing every grant, because the point of these two
  -- checks is that the TRIGGER itself is what closes the hole
  -- (20260928000300_orders_write_lockdown.sql), not merely the revoked
  -- grant checks 18/35/38 above already prove for `authenticated`. A grant
  -- is one future `grant ... to authenticated` away from being silently
  -- reintroduced; the trigger is not.
  -- ══════════════════════════════════════════════════════════════════════

  -- ------------------------------------------------ 39. THE EXACT REPRODUCTION: an unrelated sale, from another shop, marks nothing complete
  -- v_short_id is 'ready' with no sale attached (its shortfall on rice was
  -- never resolved -- see check 29). v_other_sale_id belongs to
  -- v_other_shop_id, a shop this order has nothing to do with, and has never
  -- been attached to any order -- so this check isolates the SAME-SHOP rule
  -- on its own, with no reuse of an already-settled sale to confound it.
  --
  -- This is word for word what the review reported: "attaching an arbitrary
  -- unrelated sale to a ready order marked it completed, with zero journal
  -- entries for that shop." The shop-wide journal_entries count is
  -- snapshotted before and compared after, the same by-count discipline
  -- check 37 uses, so a regression that let SOME posting slip through on the
  -- refused path would fail this check even if the order's own status/sale_id
  -- happened to look untouched.
  -- As postgres: v_other_shop_id belongs to v_outsider_id, not the owner the
  -- current JWT claims, so the fixture itself needs to bypass RLS the same
  -- way the file's very first fixtures did.
  perform set_config('role', 'postgres', true);
  insert into public.shop_locations (shop_id, name, is_primary) values (v_other_shop_id, 'Main', true)
    returning id into v_other_loc_id;
  insert into public.sales (shop_id, location_id, payment_method) values (v_other_shop_id, v_other_loc_id, 'cash')
    returning id into v_other_sale_id;

  select count(*) into v_je_before_39 from public.journal_entries where shop_id = v_shop_id;

  v_raised := false;
  v_detail := null;
  begin
    update public.orders set status = 'completed', sale_id = v_other_sale_id where id = v_short_id;
  exception
    when others then
      v_detail := sqlerrm;
      if sqlerrm = 'invalid_order_transition' then v_raised := true; else raise; end if;
  end;
  perform set_config('role', 'authenticated', true);
  if not v_raised then
    raise exception 'FAIL: a ready order was completed by attaching another shop''s sale (refused with %, expected invalid_order_transition)', v_detail;
  end if;

  select status, sale_id into v_detail, v_result.sale_id from public.orders where id = v_short_id;
  if v_detail <> 'ready' or v_result.sale_id is not null then
    raise exception 'FAIL: a refused cross-shop sale attach still left the order at % with sale %', v_detail, v_result.sale_id;
  end if;

  select count(*) into v_je_after_39 from public.journal_entries where shop_id = v_shop_id;
  if v_je_after_39 <> v_je_before_39 then
    raise exception 'FAIL: the refused attach still posted to the shop''s ledger (% -> % journal entries)',
      v_je_before_39, v_je_after_39;
  end if;

  -- ------------------------------------------------ 40. ONE SALE SETTLES AT MOST ONE ORDER, independently of the same-shop rule
  -- v_sale_collect already belongs to v_shop_id AND is already sitting on
  -- v_collect_id (check 23) -- so the same-shop rule above is satisfied and
  -- has nothing to say here. What refuses this is
  -- 20260928000300_orders_write_lockdown.sql's partial unique index on
  -- orders.sale_id: the same sale id cannot be written onto a SECOND order,
  -- which is how one sale's money could otherwise be made to look like it
  -- settled two orders' worth of goods.
  --
  -- 20260928000500_order_completion_provenance.sql's own guard would ALSO
  -- refuse this raw update (no storefront_order_completions row names this
  -- (order, sale) pair), and would refuse it earlier, at invalid_order_
  -- transition -- which would mean the unique index below is never actually
  -- reached, and this check would stop isolating what it claims to. A
  -- provenance row is manufactured by hand here (as postgres -- the only
  -- role that could ever write one) naming exactly this pair, so the
  -- provenance guard passes and the unique index is what the row is left to
  -- fail on, same as before that migration existed.
  perform set_config('role', 'postgres', true);
  insert into public.storefront_order_completions (order_id, sale_id)
    values (v_short_id, v_sale_collect);
  v_raised := false;
  begin
    update public.orders set status = 'completed', sale_id = v_sale_collect where id = v_short_id;
  exception
    when unique_violation then v_raised := true;
  end;
  delete from public.storefront_order_completions where order_id = v_short_id;
  perform set_config('role', 'authenticated', true);
  if not v_raised then
    raise exception 'FAIL: the same sale settled two different orders';
  end if;

  select status, sale_id into v_detail, v_result.sale_id from public.orders where id = v_short_id;
  if v_detail <> 'ready' or v_result.sale_id is not null then
    raise exception 'FAIL: a refused sale reuse still left the order at % with sale %', v_detail, v_result.sale_id;
  end if;

  -- ══════════════════════════════════════════════════════════════════════
  -- IMPORTANT finding 1: the delivery-fee entry was invisible to every
  -- reversal path. 20260928000400_delivery_fee_reversal_link.sql gave it a
  -- real link (orders.delivery_entry_id) and taught delete_sale about it.
  -- ══════════════════════════════════════════════════════════════════════

  -- ------------------------------------------------ 41. deleting a storefront sale reverses the delivery fee too, not just the goods
  -- A fresh order and fresh product, deliberately not reusing v_deliver_id --
  -- that one is still needed, untouched, by checks above and (via
  -- v_sale_deliver) is not safe to delete out from under them.
  --
  -- MUTATION THIS WOULD CATCH: delete_sale's UNION ALL missing the fourth
  -- (delivery-fee) branch -- exactly the state before
  -- 20260928000400_delivery_fee_reversal_link.sql, where deleting a
  -- completed storefront sale reversed the goods (4000/5000/1200/the tender)
  -- and left 4300's credit and its matching asset debit standing for a sale
  -- that no longer exists.
  -- As postgres: authenticated holds no INSERT on `orders` (or `products`'s
  -- own fixture setup here follows the same convention the rest of this
  -- file's fixtures use -- built as postgres, then handed to authenticated
  -- through the RPCs).
  perform set_config('role', 'postgres', true);
  insert into public.products (shop_id, name, price_cents, cost_cents)
    values (v_shop_id, 'Storefront Delivery Fee Test', 1000, 400) returning id into v_prod_delfee;
  insert into public.product_location_stock (product_id, location_id, stock)
    values (v_prod_delfee, v_loc_id, 50);

  insert into public.orders (shop_id, customer_name, customer_phone, fulfilment, delivery_area, delivery_landmark, subtotal_cents, delivery_fee_cents, total_cents)
    values (v_shop_id, 'Delete Fee Customer', '+252634100017', 'deliver', 'Xero Awr', 'Near the well', 1000, 600, 1600)
    returning id into v_delfee_id;
  insert into public.order_items (order_id, product_id, product_name, unit_price_cents, quantity, line_total_cents)
    values (v_delfee_id, v_prod_delfee, 'Storefront Delivery Fee Test', 1000, 1, 1000);
  perform set_config('role', 'authenticated', true);

  perform public.transition_order(v_delfee_id, 'accepted', null);
  perform public.transition_order(v_delfee_id, 'ready', null);
  v_sale_delfee := public.complete_storefront_order(v_delfee_id, 'cash');

  select journal_entry_id into v_entry_goods_del from public.sales where id = v_sale_delfee;
  select delivery_entry_id into v_entry_fee_del from public.orders where id = v_delfee_id;
  if v_entry_goods_del is null or v_entry_fee_del is null then
    raise exception 'FAIL: FIXTURE -- the sale (%) or its delivery-fee entry (%) did not post', v_entry_goods_del, v_entry_fee_del;
  end if;

  perform public.delete_sale(v_sale_delfee);

  if exists (select 1 from public.sales where id = v_sale_delfee) then
    raise exception 'FAIL: delete_sale did not delete the sale';
  end if;

  -- Both entries reversed, named individually so a half-fix (goods reversed,
  -- fee forgotten) says exactly which one it forgot.
  select string_agg(x.what || ' is ' || e.status, ', ' order by x.what) into v_bad
    from (values (v_entry_goods_del, 'the goods entry'),
                 (v_entry_fee_del,   'the delivery-fee entry')) as x(id, what)
    join public.journal_entries e on e.id = x.id
   where e.status <> 'reversed';
  if v_bad is not null then
    raise exception 'FAIL: deleting the sale left an entry posted over a source row that no longer exists -- %', v_bad;
  end if;

  -- The 4300 credit is actually gone, net -- not merely "some entry got
  -- reversed somewhere". Summed across the fee's original entry and its
  -- mirror: a real reversal cancels to zero; a mutation that reversed the
  -- WRONG entry (the goods entry twice, say) would leave 4300's net nonzero.
  select coalesce(sum(jl.amount_cents), 0) into v_amount
    from public.journal_lines jl
    join public.accounts a on a.id = jl.account_id
   where a.code = '4300'
     and jl.entry_id in (v_entry_fee_del, (select reverses_entry_id from public.journal_entries where id = v_entry_fee_del));
  if v_amount <> 0 then
    raise exception 'FAIL: 4300''s net effect from this order is % (should be 0 -- fully reversed)', v_amount;
  end if;

  -- ══════════════════════════════════════════════════════════════════════
  -- The money-handling review's Critical finding continues to checks 39/40
  -- above and 42/43 below -- placed here, before the plan-downgrade check,
  -- because both need a raw write to `orders` to reach the trigger at all,
  -- and 45 below moves the shop off the storefront plan, at which point
  -- orders_module (20260926000050_orders.sql) refuses EVERY write to
  -- `orders`, direct or through an RPC, before enforce_order_transition ever
  -- runs. That would refuse checks 42/43 too, but with module_not_included
  -- instead of invalid_order_transition -- the right verdict for the wrong
  -- reason, which is not what either check claims to prove.
  -- ══════════════════════════════════════════════════════════════════════

  -- ------------------------------------------------ 42. THE EXACT REPRODUCTION: a shop's OWN genuine, never-used sale marks nothing complete
  -- Checks 39/40 each isolate ONE of the two guards 20260928000300 added --
  -- another shop's sale (39), the same sale twice (40) -- and neither uses a
  -- sale that is simultaneously the order's own shop's AND unused. That
  -- combination is exactly what the review's own reproduction used, and it
  -- is what checks 39/40 could not catch: both of THEIR guards pass a sale
  -- that is this shop's own and has never settled anything.
  --
  -- v_short_id is still 'ready' with no sale attached -- checks 39/40 both
  -- left it refused there. v_counter_sale_id is a REAL counter sale, rung up
  -- the ordinary way through complete_sale (the same function
  -- complete_storefront_order itself calls), posting its own genuine journal
  -- entry, with nothing to do with any order.
  select count(*) into v_je_before_43 from public.journal_entries where shop_id = v_shop_id;
  v_counter_sale_id := public.complete_sale(
    p_shop_id      => v_shop_id,
    p_items        => jsonb_build_array(jsonb_build_object(
                        'product_id', v_prod_tea, 'quantity', 1, 'unit_price_cents', 2000)),
    p_payments     => jsonb_build_array(jsonb_build_object('method', 'cash', 'amount_cents', 2000)),
    p_location_id  => v_loc_id);
  select count(*) into v_je_after_counter43 from public.journal_entries where shop_id = v_shop_id;
  if v_je_after_counter43 <> v_je_before_43 + 1 then
    raise exception 'FAIL: FIXTURE -- the counter sale did not post its own entry';
  end if;

  -- The attack, word for word: attach that sale and mark the order
  -- 'completed' with nothing else in the statement. As postgres -- this
  -- file's own stand-in throughout (see check 15) for "authenticated with
  -- orders' revoked grant restored" -- because the point of this migration
  -- is that revoking the grant on `orders` was never the only thing holding
  -- this shut, and closing the residual hole must not depend on it either.
  perform set_config('role', 'postgres', true);
  v_raised := false;
  v_detail := null;
  begin
    update public.orders set status = 'completed', sale_id = v_counter_sale_id where id = v_short_id;
  exception
    when others then
      v_detail := sqlerrm;
      if sqlerrm = 'invalid_order_transition' then v_raised := true; else raise; end if;
  end;
  perform set_config('role', 'authenticated', true);
  if not v_raised then
    raise exception 'FAIL: a ready order was completed by attaching the shop''s OWN genuine, unused sale directly (refused with %, expected invalid_order_transition)', v_detail;
  end if;

  select status, sale_id into v_detail, v_result.sale_id from public.orders where id = v_short_id;
  if v_detail <> 'ready' or v_result.sale_id is not null then
    raise exception 'FAIL: a refused same-shop sale attach still left the order at % with sale %', v_detail, v_result.sale_id;
  end if;

  -- And nothing extra reached the ledger: the counter sale's own entry from
  -- above is the only one this attempt could have added to, and it did not.
  select count(*) into v_je_after_43 from public.journal_entries where shop_id = v_shop_id;
  if v_je_after_43 <> v_je_after_counter43 then
    raise exception 'FAIL: the refused attach still posted to the shop''s ledger (% -> % journal entries)',
      v_je_after_counter43, v_je_after_43;
  end if;

  -- ------------------------------------------------ 43. a completion mark from a DIFFERENT transaction does not authorise this one
  -- 20260928000500_order_completion_provenance.sql's guard does not just
  -- check that SOME row in storefront_order_completions names this order and
  -- this sale -- it requires that row's xact_id to be the CURRENT
  -- transaction's, which is what stops a mark left behind by an earlier,
  -- already-finished transaction from authorising an unrelated statement
  -- later. Manufactured directly here (as postgres -- the table grants
  -- nothing to `authenticated`, not even SELECT, regardless of what is
  -- granted on `orders` itself) with an xact_id nowhere near
  -- pg_current_xact_id()'s real value, standing in for "written by some
  -- other, already-committed transaction" without this self-contained,
  -- single-transaction file needing a second real connection to prove it.
  --
  -- v_short_id is still 'ready' with no sale attached; v_counter_sale_id is
  -- still unused (check 42's own attempt was refused before ever writing
  -- anything). Both are safe to reuse for a second, differently-shaped
  -- attack.
  perform set_config('role', 'postgres', true);
  insert into public.storefront_order_completions (order_id, sale_id, xact_id)
    values (v_short_id, v_counter_sale_id, '1'::xid8);

  v_raised := false;
  v_detail := null;
  begin
    update public.orders set status = 'completed', sale_id = v_counter_sale_id where id = v_short_id;
  exception
    when others then
      v_detail := sqlerrm;
      if sqlerrm = 'invalid_order_transition' then v_raised := true; else raise; end if;
  end;
  delete from public.storefront_order_completions where order_id = v_short_id;
  perform set_config('role', 'authenticated', true);
  if not v_raised then
    raise exception 'FAIL: a completion mark stamped by a different transaction still authorised this one (refused with %, expected invalid_order_transition)', v_detail;
  end if;

  select status, sale_id into v_detail, v_result.sale_id from public.orders where id = v_short_id;
  if v_detail <> 'ready' or v_result.sale_id is not null then
    raise exception 'FAIL: a refused stale-provenance attach still left the order at % with sale %', v_detail, v_result.sale_id;
  end if;

  -- ------------------------------------------------ 44. pos.access is required to COMPLETE an order -- not merely to move it
  -- 20260928000600_complete_storefront_order_pos_access.sql: /orders is
  -- gated client-side on `settings.access` alone (permissions.ts), so a
  -- member who can open this order and work every OTHER step of it must
  -- still be refused, by its own code, at the one move that reaches the
  -- books. v_manager_id holds `settings.access` and nothing else, on a role
  -- of its own -- not the owner, who bypasses every permission check by
  -- ownership alone (user_has_shop_permission, 0024_permission_gates.sql).
  perform set_config('request.jwt.claims', json_build_object('sub', v_manager_id)::text, true);

  -- First, the negative control: transition_order needs no pos.access at
  -- all, and this migration must not have widened it to require any. A
  -- settings-only manager can still accept an order same as anyone with
  -- storefront access -- v_pending_id (unused since check 31, still
  -- 'pending') proves the ordinary moves are untouched.
  v_result := public.transition_order(v_pending_id, 'accepted', null);
  if v_result.status <> 'accepted' then
    raise exception 'FAIL: a settings-only manager could not accept an order -- pos.access must not gate transition_order';
  end if;

  -- Then: completion is refused, by its own typed code, before complete_sale
  -- is ever called.
  v_raised := false;
  v_detail := null;
  begin
    perform public.complete_storefront_order(v_short_id, 'cash');
  exception
    when others then
      v_detail := sqlerrm;
      if sqlerrm = 'pos_access_required' then v_raised := true; else raise; end if;
  end;
  perform set_config('request.jwt.claims', json_build_object('sub', v_owner_id)::text, true);
  if not v_raised then
    raise exception 'FAIL: a settings-only manager with no pos.access completed an order (refused with %, expected pos_access_required)', v_detail;
  end if;

  -- No half-completion: v_short_id is exactly where checks 39/40/42/43 left
  -- it, and nothing extra reached the ledger.
  select status, sale_id into v_detail, v_result.sale_id from public.orders where id = v_short_id;
  if v_detail <> 'ready' or v_result.sale_id is not null then
    raise exception 'FAIL: a refused pos.access-less completion still left the order at % with sale %', v_detail, v_result.sale_id;
  end if;
  select count(*) into v_count from public.journal_entries where shop_id = v_shop_id;
  if v_count <> v_je_after_43 then
    raise exception 'FAIL: a refused pos.access-less completion still posted to the ledger (% -> % journal entries)', v_je_after_43, v_count;
  end if;

  -- ------------------------------------------------ 45. a de-entitled shop stops moving AND completing its own orders
  -- Last on purpose, same reason verify-orders.sql leaves its own version
  -- last: it moves the shop under test off the plan every check above
  -- depends on. As postgres: authenticated holds no grant on
  -- shop_subscriptions, the same posture as `orders` itself now.
  perform set_config('role', 'postgres', true);
  select id into v_free_id from public.plans where key = 'free';
  update public.shop_subscriptions
  set plan_id = v_free_id, current_period_end = now() + interval '30 days'
  where shop_id = v_shop_id;

  if public.shop_has_module(v_shop_id, 'storefront') then
    raise exception 'FAIL: a shop moved to the Free plan still has the storefront module';
  end if;

  v_raised := false;
  begin
    perform public.transition_order(v_order_id, 'cancelled', 'Too late to matter');
  exception
    when others then
      if sqlerrm = 'module_not_included' then v_raised := true; else raise; end if;
  end;
  if not v_raised then
    raise exception 'FAIL: a shop whose plan no longer includes storefront still moved an order';
  end if;

  -- And completion, which is the one that would have written into the books
  -- of a shop that is no longer paying for the door it came through.
  v_raised := false;
  begin
    perform public.complete_storefront_order(v_short_id, 'cash');
  exception
    when others then
      if sqlerrm = 'module_not_included' then v_raised := true; else raise; end if;
  end;
  if not v_raised then
    raise exception 'FAIL: a shop whose plan no longer includes storefront still posted a storefront sale';
  end if;

  raise notice 'PASS: order transitions';
  raise exception 'rollback_marker';
exception
  when others then
    if sqlerrm = 'rollback_marker' then
      -- DELIBERATELY NOT THE WORDS "all checks passed". run-all.sh decides a
      -- script's verdict by grepping its WHOLE output for that phrase, so a
      -- block that says it here would report this file as passing even when
      -- a block below fails -- the LAST block's own notice is the only place
      -- the phrase now appears.
      raise notice 'verify-order-transitions: checks 1-45 passed, rolled back (part 1 of 3)';
    else
      raise;
    end if;
end $$;

-- ════════════════════════════════════════════════════════════════════════
-- Task 4: FULFILMENT USES THE PRICE THE CUSTOMER AGREED TO
-- (20260929000200_complete_storefront_order_agreed.sql)
-- ════════════════════════════════════════════════════════════════════════
--
-- A SECOND BLOCK, not more checks bolted into the first one, for two reasons
-- that are both about not disturbing what is already proven: check 45 above
-- moves the shop under test off the storefront plan and must stay last in its
-- own block, and these checks need fixtures the first block has no use for --
-- a shop that charges tax, and a member holding `pos.access` with no
-- `discounts.manual`. Nothing above is renumbered and no check above is
-- edited.
--
--   46.   A REPRICED PRODUCT NO LONGER BLOCKS COMPLETION, and the sale is
--         filed at the AGREED price, not today's. This is the whole point of
--         the branch: before it, a shop that raised a price stranded every
--         open order quoted at the old one (that was check 34's subject, and
--         34 still stands -- see 50 for what its refusal now means).
--         Asserted on the money, not just on the status: sale.total_cents,
--         sale_items.unit_price_cents, the 4000 credit and the frozen cost,
--         plus products.price_cents left where the shop put it.
--   47.   A TAX-CHARGING SHOP CAN COMPLETE AN ORDER AT ALL, and the customer
--         pays the figure they were quoted. Before this the storefront quoted
--         4000 tax-exclusive, complete_sale added 5% on top and refused the
--         4000 payment against its own 4200 -- so at such a shop EVERY order
--         failed. The tax is now carved OUT of the quote: 190 of 4000 at 5%,
--         revenue 3810, and 2100 Sales Tax Payable holds the 190 -- the same
--         account, the same rounding and the same direction the till uses.
--   48.   ...and the DELIVERY FEE IS UNTOUCHED by any of it: 4300 still holds
--         the whole fee, no tax is carved out of it, the sale's own entry
--         carries no 4300 line, and the two entries together still bring in
--         exactly orders.total_cents.
--   49.   THE PER-LINE ESCAPE ROUTE IS CLOSED. Two lines moving in OPPOSITE
--         directions by equal amounts (1000 -> 1500 and 2000 -> 1500) leave
--         the order's TOTAL exactly where it was, so a total-only check waves
--         them through -- and the sale would post at 1500/1500, two prices
--         the customer never agreed to, with every figure tying. The sale's
--         lines are asserted against the order's snapshot line for line, and
--         the shelf price 1500 is asserted absent by name.
--   50.   WHAT order_total_changed STILL CATCHES, which is narrower than what
--         it caught. Neither a reprice (46) nor tax (47) can reach it now. It
--         fires when the ORDER ROW disagrees with the ORDER'S OWN LINES --
--         orders.subtotal_cents is not the sum of its items -- which is the
--         one remaining way the payment this function tenders can fail to
--         equal the total complete_sale computes. Proven in BOTH directions
--         (quoted high, quoted low), each leaving the order untouched, with a
--         control: the same order completes once its subtotal agrees with its
--         own lines, so the refusal is about the disagreement and not about
--         the fixture.
--   51.   A CASHIER WHO MAY NOT DISCOUNT CAN STILL FULFIL AN ORDER, and still
--         may not undercut at the till. A member holding `pos.access` and
--         nothing else completes an order whose product has since gone UP in
--         price -- filing a line below today's shelf price, which
--         20260929000050 gates on `discounts.manual` -- and the SAME member,
--         the SAME product and the SAME price through complete_sale directly
--         is still refused. That pair is the whole permission decision: the
--         exemption is for a quote the shop itself published, not for the
--         person completing it.
--   52.   THE FULFILMENT MARK IS NOT FORGEABLE, which is what makes 51
--         defensible rather than a hole. `authenticated` holds no privilege
--         on storefront_order_fulfilments (on paper and for real), and a mark
--         stamped by a DIFFERENT transaction does not authorise an undercut
--         in this one -- the same xact_id rule 20260928000500 established for
--         storefront_order_completions and check 43 proves for it.

do $$
declare
  v_owner_id   uuid := gen_random_uuid();
  -- pos.access and nothing else. NOT the owner, who bypasses every permission
  -- check by ownership alone (user_has_shop_permission, 0024_permission_gates).
  v_cashier_id uuid := gen_random_uuid();
  v_shop_id    uuid;
  v_loc_id     uuid;
  v_role_id    uuid;

  v_prod_drift  uuid;  -- 700  -> 1300 : check 46
  v_prod_drift2 uuid;  -- 700  -> 1300 : checks 51/52
  v_prod_up     uuid;  -- 1000 -> 1500 : check 49
  v_prod_down   uuid;  -- 2000 -> 1500 : check 49
  v_prod_tamper uuid;  -- 800         : check 50
  v_prod_tea    uuid;  -- 2000        : checks 47/48
  v_prod_huge   uuid;  -- 600,000,000 : check 53

  v_drift_id   uuid;
  v_cashier_order_id uuid;
  v_stale_id   uuid;
  v_swap_id    uuid;
  v_over_id    uuid;
  v_under_id   uuid;
  v_tax_id     uuid;
  v_huge_id    uuid;

  v_sale_id    uuid;
  v_entry_id   uuid;
  v_entry_fee  uuid;
  v_amount     bigint;
  v_count      integer;
  v_sales_before integer;
  v_status     text;
  v_sale_link  uuid;
  v_detail     text;
  v_raised     boolean;
  v_ok         boolean;
begin
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
    select u, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
           'verify-order-transitions-t4-' || u || '@example.test', '', now(), now(), now()
      from unnest(array[v_owner_id, v_cashier_id]) u;

  insert into public.shops (owner_id, name) values (v_owner_id, 'Agreed Price Shop')
    returning id into v_shop_id;
  insert into public.storefronts (shop_id) values (v_shop_id);
  insert into public.shop_locations (shop_id, name, is_primary)
    values (v_shop_id, 'Main', true) returning id into v_loc_id;

  -- The role this whole permission question is about: "cashier, may ring up
  -- sales, may not discount". 20260826000100:865 backfilled `discounts.manual`
  -- onto every role that already held `pos.access`, and all three roles
  -- default_shop_roles() seeds carry it -- so this role has to be built by
  -- hand, exactly as a shop that wanted one would have to.
  insert into public.roles (shop_id, name, permissions)
    values (v_shop_id, 'Cashier, no discounting', array['pos.access'])
    returning id into v_role_id;
  insert into public.shop_members (shop_id, user_id, role_id, full_name, active)
    values (v_shop_id, v_cashier_id, v_role_id, 'No-Discount Cashier', true);

  insert into public.products (shop_id, name, price_cents, cost_cents)
    values (v_shop_id, 'Drift', 700, 150) returning id into v_prod_drift;
  insert into public.products (shop_id, name, price_cents, cost_cents)
    values (v_shop_id, 'Drift Two', 700, 150) returning id into v_prod_drift2;
  insert into public.products (shop_id, name, price_cents, cost_cents)
    values (v_shop_id, 'Moved Up', 1000, 200) returning id into v_prod_up;
  insert into public.products (shop_id, name, price_cents, cost_cents)
    values (v_shop_id, 'Moved Down', 2000, 400) returning id into v_prod_down;
  insert into public.products (shop_id, name, price_cents, cost_cents)
    values (v_shop_id, 'Tamper', 800, 300) returning id into v_prod_tamper;
  insert into public.products (shop_id, name, price_cents, cost_cents)
    values (v_shop_id, 'Taxed Tea', 2000, 700) returning id into v_prod_tea;
  -- Check 53. 600,000,000 is an ordinary integer price and 2 of them is a
  -- storable order line (order_items.line_total_cents is `integer`), but the
  -- line is over the 1,000,000,000 ceiling complete_sale puts on an AGREED
  -- price -- which is what every line of a fulfilment now is.
  insert into public.products (shop_id, name, price_cents, cost_cents)
    values (v_shop_id, 'Huge', 600000000, 1000) returning id into v_prod_huge;

  insert into public.product_location_stock (product_id, location_id, stock)
    values (v_prod_drift, v_loc_id, 100), (v_prod_drift2, v_loc_id, 100),
           (v_prod_up, v_loc_id, 100),    (v_prod_down, v_loc_id, 100),
           (v_prod_tamper, v_loc_id, 100),(v_prod_tea, v_loc_id, 100),
           (v_prod_huge, v_loc_id, 100);

  -- Every order below is quoted the way place_storefront_order quotes one:
  -- unit_price_cents copied from products.price_cents AS IT WAS, and
  -- subtotal_cents the sum of the lines (20260927000000_place_order.sql:409,
  -- :420). The two tampered ones (over/under) are the exception, and that is
  -- the point of them.
  insert into public.orders (shop_id, customer_name, customer_phone, fulfilment, subtotal_cents, delivery_fee_cents, total_cents)
    values (v_shop_id, 'Drift Customer', '+252634200001', 'collect', 700, 0, 700)
    returning id into v_drift_id;
  insert into public.order_items (order_id, product_id, product_name, unit_price_cents, quantity, line_total_cents)
    values (v_drift_id, v_prod_drift, 'Drift', 700, 1, 700);

  insert into public.orders (shop_id, customer_name, customer_phone, fulfilment, subtotal_cents, delivery_fee_cents, total_cents)
    values (v_shop_id, 'Cashier Customer', '+252634200002', 'collect', 700, 0, 700)
    returning id into v_cashier_order_id;
  insert into public.order_items (order_id, product_id, product_name, unit_price_cents, quantity, line_total_cents)
    values (v_cashier_order_id, v_prod_drift2, 'Drift Two', 700, 1, 700);

  insert into public.orders (shop_id, customer_name, customer_phone, fulfilment, subtotal_cents, delivery_fee_cents, total_cents)
    values (v_shop_id, 'Stale Customer', '+252634200003', 'collect', 700, 0, 700)
    returning id into v_stale_id;
  insert into public.order_items (order_id, product_id, product_name, unit_price_cents, quantity, line_total_cents)
    values (v_stale_id, v_prod_drift2, 'Drift Two', 700, 1, 700);

  -- Check 49: 1000 + 2000 = 3000, and after the reprice 1500 + 1500 = 3000 too.
  insert into public.orders (shop_id, customer_name, customer_phone, fulfilment, subtotal_cents, delivery_fee_cents, total_cents)
    values (v_shop_id, 'Swap Customer', '+252634200004', 'collect', 3000, 0, 3000)
    returning id into v_swap_id;
  insert into public.order_items (order_id, product_id, product_name, unit_price_cents, quantity, line_total_cents)
    values (v_swap_id, v_prod_up,   'Moved Up',   1000, 1, 1000),
           (v_swap_id, v_prod_down, 'Moved Down', 2000, 1, 2000);

  -- Check 50: the order row and the order's own lines disagree. 900 and 700
  -- against a single 800 line -- one either side, because the two directions
  -- come back from complete_sale as two DIFFERENT messages ("is more than"
  -- and "does not match") and complete_storefront_order has to recognise both.
  insert into public.orders (shop_id, customer_name, customer_phone, fulfilment, subtotal_cents, delivery_fee_cents, total_cents)
    values (v_shop_id, 'Over Customer', '+252634200005', 'collect', 900, 0, 900)
    returning id into v_over_id;
  insert into public.order_items (order_id, product_id, product_name, unit_price_cents, quantity, line_total_cents)
    values (v_over_id, v_prod_tamper, 'Tamper', 800, 1, 800);

  insert into public.orders (shop_id, customer_name, customer_phone, fulfilment, subtotal_cents, delivery_fee_cents, total_cents)
    values (v_shop_id, 'Under Customer', '+252634200006', 'collect', 700, 0, 700)
    returning id into v_under_id;
  insert into public.order_items (order_id, product_id, product_name, unit_price_cents, quantity, line_total_cents)
    values (v_under_id, v_prod_tamper, 'Tamper', 800, 1, 800);

  -- Checks 47/48: 2 x 2000 = 4000 of goods, a 1500 delivery fee, 5500 in all.
  insert into public.orders (shop_id, customer_name, customer_phone, fulfilment, delivery_area, delivery_landmark, subtotal_cents, delivery_fee_cents, total_cents)
    values (v_shop_id, 'Taxed Customer', '+252634200007', 'deliver', 'Xero Awr', 'By the blue gate', 4000, 1500, 5500)
    returning id into v_tax_id;
  insert into public.order_items (order_id, product_id, product_name, unit_price_cents, quantity, line_total_cents)
    values (v_tax_id, v_prod_tea, 'Taxed Tea', 2000, 2, 4000);

  -- Check 53: quoted the ordinary way, at a price the shop really published.
  -- 2 x 600,000,000 = 1,200,000,000 -- inside `integer` on every column that
  -- holds it, outside the agreed price's own per-line ceiling.
  insert into public.orders (shop_id, customer_name, customer_phone, fulfilment, subtotal_cents, delivery_fee_cents, total_cents)
    values (v_shop_id, 'Huge Customer', '+252634200008', 'collect', 1200000000, 0, 1200000000)
    returning id into v_huge_id;
  insert into public.order_items (order_id, product_id, product_name, unit_price_cents, quantity, line_total_cents)
    values (v_huge_id, v_prod_huge, 'Huge', 600000000, 2, 1200000000);

  perform set_config('request.jwt.claims', json_build_object('sub', v_owner_id)::text, true);
  perform set_config('role', 'authenticated', true);

  perform public.transition_order(v_drift_id, 'accepted', null);
  perform public.transition_order(v_drift_id, 'ready', null);
  perform public.transition_order(v_cashier_order_id, 'accepted', null);
  perform public.transition_order(v_cashier_order_id, 'ready', null);
  perform public.transition_order(v_stale_id, 'accepted', null);
  perform public.transition_order(v_stale_id, 'ready', null);
  perform public.transition_order(v_swap_id, 'accepted', null);
  perform public.transition_order(v_swap_id, 'ready', null);
  perform public.transition_order(v_over_id, 'accepted', null);
  perform public.transition_order(v_over_id, 'ready', null);
  perform public.transition_order(v_under_id, 'accepted', null);
  perform public.transition_order(v_under_id, 'ready', null);
  perform public.transition_order(v_tax_id, 'accepted', null);
  perform public.transition_order(v_tax_id, 'ready', null);
  perform public.transition_order(v_huge_id, 'accepted', null);
  perform public.transition_order(v_huge_id, 'ready', null);

  -- Same posture as the first block from check 23 on: postgres for the ledger
  -- assertions (RLS must not hide a journal_lines row from a script asserting
  -- about it), with the JWT claim still set -- which is what every permission
  -- check under test actually reads.
  perform set_config('role', 'postgres', true);

  -- THE SHOP RE-PRICES. Everything below happens after the customer agreed.
  update public.products set price_cents = 1300 where id in (v_prod_drift, v_prod_drift2);
  update public.products set price_cents = 1500 where id in (v_prod_up, v_prod_down);

  -- ------------------------------------------------ 46. a repriced product no longer blocks completion
  v_sale_id := public.complete_storefront_order(v_drift_id, 'cash');
  if v_sale_id is null then
    raise exception 'FAIL 46: completing a repriced order returned no sale id';
  end if;

  select total_cents, tax_cents into v_count, v_amount from public.sales where id = v_sale_id;
  if v_count <> 700 then
    raise exception 'FAIL 46: the sale totals % -- the customer agreed to 700, the shelf now says 1300', v_count;
  end if;
  select count(*) into v_count from public.sale_items
   where sale_id = v_sale_id and unit_price_cents = 700 and quantity = 1 and line_total_cents = 700;
  if v_count <> 1 then
    raise exception 'FAIL 46: the sale line is not filed at the agreed 700';
  end if;
  -- The cost is the product's, not the agreed price's: 20260804000000 froze it
  -- and an agreement about the SELLING price says nothing about what the shop
  -- paid.
  if (select unit_cost_cents from public.sale_items where sale_id = v_sale_id) <> 150 then
    raise exception 'FAIL 46: the frozen cost moved with the agreed price';
  end if;
  -- The shelf is left exactly where the shop put it: completing an order is
  -- not a way to un-reprice a product.
  if (select price_cents from public.products where id = v_prod_drift) <> 1300 then
    raise exception 'FAIL 46: completing the order rewrote the product''s price';
  end if;

  select journal_entry_id into v_entry_id from public.sales where id = v_sale_id;
  select coalesce(sum(amount_cents), 0) into v_amount from public.journal_lines where entry_id = v_entry_id;
  if v_amount <> 0 then
    raise exception 'FAIL 46: the entry does not balance -- debits and credits differ by %', v_amount;
  end if;
  select coalesce(sum(jl.amount_cents), 0) into v_amount
    from public.journal_lines jl join public.accounts a on a.id = jl.account_id
   where jl.entry_id = v_entry_id and a.code = '4000';
  if v_amount <> -700 then
    raise exception 'FAIL 46: expected 4000 credited 700 (the agreed price), got %', v_amount;
  end if;
  select coalesce(sum(jl.amount_cents), 0) into v_amount
    from public.journal_lines jl join public.accounts a on a.id = jl.account_id
   where jl.entry_id = v_entry_id and a.code = '1000';
  if v_amount <> 700 then
    raise exception 'FAIL 46: expected 1000 Cash debited 700, got %', v_amount;
  end if;

  select status, sale_id into v_status, v_sale_link from public.orders where id = v_drift_id;
  if v_status <> 'completed' or v_sale_link is distinct from v_sale_id then
    raise exception 'FAIL 46: the order is % against sale %', v_status, v_sale_link;
  end if;

  -- ------------------------------------------------ 49. two lines moving in opposite directions cannot pass on the total alone
  v_sale_id := public.complete_storefront_order(v_swap_id, 'cash');
  select total_cents into v_count from public.sales where id = v_sale_id;
  if v_count <> 3000 then
    raise exception 'FAIL 49: the sale totals % against a quote of 3000', v_count;
  end if;

  -- Line for line against the order's own snapshot, in both directions -- the
  -- assertion a total-only check cannot make.
  select count(*) into v_count
    from (
      select product_name, unit_price_cents, quantity, line_total_cents
        from public.order_items where order_id = v_swap_id
      except
      select product_name, unit_price_cents, quantity, line_total_cents
        from public.sale_items where sale_id = v_sale_id
      union all
      select product_name, unit_price_cents, quantity, line_total_cents
        from public.sale_items where sale_id = v_sale_id
      except
      select product_name, unit_price_cents, quantity, line_total_cents
        from public.order_items where order_id = v_swap_id
    ) diff;
  if v_count <> 0 then
    raise exception 'FAIL 49: the sale''s lines are not the order''s snapshot (% line(s) differ) -- the total tied and the prices did not', v_count;
  end if;
  -- And the shelf price is absent BY NAME, so the failure says what happened
  -- rather than only that something differed.
  if exists (select 1 from public.sale_items where sale_id = v_sale_id and unit_price_cents = 1500) then
    raise exception 'FAIL 49: a line was filed at today''s shelf price of 1500, which the customer never agreed to';
  end if;
  select journal_entry_id into v_entry_id from public.sales where id = v_sale_id;
  select coalesce(sum(jl.amount_cents), 0) into v_amount
    from public.journal_lines jl join public.accounts a on a.id = jl.account_id
   where jl.entry_id = v_entry_id and a.code = '4000';
  if v_amount <> -3000 then
    raise exception 'FAIL 49: expected 4000 credited 3000, got %', v_amount;
  end if;

  -- ------------------------------------------------ 50. order_total_changed still catches an order that disagrees with its own lines
  -- (a) quoted HIGH: 900 tendered against 800 of lines.
  select count(*) into v_sales_before from public.sales where shop_id = v_shop_id;
  v_raised := false;
  v_detail := null;
  begin
    perform public.complete_storefront_order(v_over_id, 'cash');
  exception
    when others then
      v_detail := sqlerrm;
      if v_detail = 'order_total_changed' then v_raised := true; else raise; end if;
  end;
  if not v_raised then
    raise exception 'FAIL 50a: an order tendering 900 against 800 of its own lines was completed';
  end if;
  select status, sale_id into v_status, v_sale_link from public.orders where id = v_over_id;
  if v_status <> 'ready' or v_sale_link is not null then
    raise exception 'FAIL 50a: a refused completion left the order at % with sale %', v_status, v_sale_link;
  end if;
  select count(*) into v_count from public.sales where shop_id = v_shop_id;
  if v_count <> v_sales_before then
    raise exception 'FAIL 50a: a refused completion still wrote a sale (% -> %)', v_sales_before, v_count;
  end if;

  -- (b) quoted LOW: 700 tendered against the same 800 of lines. A different
  --     message out of complete_sale, the same code out of this one.
  v_raised := false;
  v_detail := null;
  begin
    perform public.complete_storefront_order(v_under_id, 'cash');
  exception
    when others then
      v_detail := sqlerrm;
      if v_detail = 'order_total_changed' then v_raised := true; else raise; end if;
  end;
  if not v_raised then
    raise exception 'FAIL 50b: an order tendering 700 against 800 of its own lines was completed';
  end if;
  select status into v_status from public.orders where id = v_under_id;
  if v_status <> 'ready' then
    raise exception 'FAIL 50b: a refused completion left the order at %', v_status;
  end if;

  -- (c) THE CONTROL. Put the order row back in agreement with its own lines
  --     and the same order completes -- so 50a/50b refuse the disagreement,
  --     not the fixture. (As postgres: `authenticated` holds no write
  --     privilege on `orders` at all, 20260928000300.)
  update public.orders set subtotal_cents = 800, total_cents = 800 where id = v_over_id;
  v_sale_id := public.complete_storefront_order(v_over_id, 'cash');
  select total_cents into v_count from public.sales where id = v_sale_id;
  if v_count <> 800 then
    raise exception 'FAIL 50c: the corrected order posted a sale of % rather than 800', v_count;
  end if;

  -- ------------------------------------------------ 51. a cashier who may not discount can still fulfil an order
  perform set_config('request.jwt.claims', json_build_object('sub', v_cashier_id)::text, true);

  -- The controls first: this member really does hold the till and really does
  -- not hold the discount permission. Without these the check could pass
  -- vacuously against a fixture that quietly had both.
  if not public.has_shop_permission(v_shop_id, 'pos.access') then
    raise exception 'FAIL 51: FIXTURE -- the cashier does not hold pos.access';
  end if;
  if public.has_shop_permission(v_shop_id, 'discounts.manual') then
    raise exception 'FAIL 51: FIXTURE -- the cashier holds discounts.manual, so this check proves nothing';
  end if;

  -- (a) The fulfilment. Drift Two was quoted at 700 and the shelf now says
  --     1300, so this line is BELOW the shelf price -- the exact shape
  --     20260929000050 gates on `discounts.manual`.
  v_sale_id := public.complete_storefront_order(v_cashier_order_id, 'cash');
  select total_cents into v_count from public.sales where id = v_sale_id;
  if v_count <> 700 then
    raise exception 'FAIL 51a: the cashier''s fulfilment posted % rather than the agreed 700', v_count;
  end if;
  if (select unit_price_cents from public.sale_items where sale_id = v_sale_id) <> 700 then
    raise exception 'FAIL 51a: the cashier''s fulfilment was not filed at the agreed price';
  end if;

  -- (b) THE OTHER HALF, and the one that makes (a) safe: the same member, the
  --     same product, the same price, through complete_sale directly. Still
  --     refused. The exemption belongs to a quote the shop published, not to
  --     the person holding the till.
  v_raised := false;
  v_detail := null;
  begin
    perform public.complete_sale(
      p_shop_id     => v_shop_id,
      p_items       => jsonb_build_array(jsonb_build_object(
                         'product_id', v_prod_drift2, 'quantity', 1,
                         'agreed_unit_price_cents', 700)),
      p_payments    => jsonb_build_array(jsonb_build_object('method', 'cash', 'amount_cents', 700)),
      p_location_id => v_loc_id);
  exception
    when others then
      v_detail := sqlerrm;
      if v_detail like 'not authorized to file a line below the shelf price%' then v_raised := true; else raise; end if;
  end;
  if not v_raised then
    raise exception 'FAIL 51b: a cashier with no discounts.manual undercut the shelf price at the till (refused with %)', v_detail;
  end if;

  -- (c) ...and the same member ringing the SAME product up at the shelf price
  --     is untouched, so (b) is a refusal of the undercut and not of the
  --     cashier.
  v_sale_id := public.complete_sale(
    p_shop_id     => v_shop_id,
    p_items       => jsonb_build_array(jsonb_build_object(
                       'product_id', v_prod_drift2, 'quantity', 1)),
    p_payments    => jsonb_build_array(jsonb_build_object('method', 'cash', 'amount_cents', 1300)),
    p_location_id => v_loc_id);
  if (select total_cents from public.sales where id = v_sale_id) <> 1300 then
    raise exception 'FAIL 51c: an ordinary till sale by the same cashier did not post at the shelf price';
  end if;

  -- ------------------------------------------------ 52. the fulfilment mark is not forgeable
  -- (a) On paper and for real. The mark lives in a table `authenticated` has
  --     no privilege on and which carries row level security with no policy at
  --     all -- the same two independent layers 20260928000500 gave
  --     storefront_order_completions.
  if has_table_privilege('authenticated', 'public.storefront_order_fulfilments', 'INSERT') then
    raise exception 'FAIL 52a: authenticated holds INSERT on storefront_order_fulfilments on paper';
  end if;
  select relrowsecurity into v_ok from pg_class where oid = 'public.storefront_order_fulfilments'::regclass;
  if not v_ok then
    raise exception 'FAIL 52a: storefront_order_fulfilments does not have row level security enabled';
  end if;
  select count(*) into v_count from pg_policies
   where schemaname = 'public' and tablename = 'storefront_order_fulfilments';
  if v_count <> 0 then
    raise exception 'FAIL 52a: storefront_order_fulfilments has % policy(ies) -- it must have none', v_count;
  end if;

  perform set_config('role', 'authenticated', true);
  v_raised := false;
  v_detail := null;
  begin
    insert into public.storefront_order_fulfilments (order_id) values (v_stale_id);
  exception
    when insufficient_privilege then v_raised := true; v_detail := sqlerrm;
  end;
  perform set_config('role', 'postgres', true);
  if not v_raised then
    raise exception 'FAIL 52a: authenticated wrote its own fulfilment mark';
  end if;

  -- (b) And a mark stamped by a DIFFERENT transaction authorises nothing here
  --     -- manufactured as postgres with an xact_id nowhere near
  --     pg_current_xact_id()'s real value, the same stand-in check 43 uses for
  --     "written by some other, already-committed transaction".
  insert into public.storefront_order_fulfilments (order_id, xact_id)
    values (v_stale_id, '1'::xid8);

  perform set_config('request.jwt.claims', json_build_object('sub', v_cashier_id)::text, true);
  v_raised := false;
  v_detail := null;
  begin
    perform public.complete_sale(
      p_shop_id     => v_shop_id,
      p_items       => jsonb_build_array(jsonb_build_object(
                         'product_id', v_prod_drift2, 'quantity', 1,
                         'agreed_unit_price_cents', 700)),
      p_payments    => jsonb_build_array(jsonb_build_object('method', 'cash', 'amount_cents', 700)),
      p_location_id => v_loc_id);
  exception
    when others then
      v_detail := sqlerrm;
      if v_detail like 'not authorized to file a line below the shelf price%' then v_raised := true; else raise; end if;
  end;
  delete from public.storefront_order_fulfilments where order_id = v_stale_id;
  if not v_raised then
    raise exception 'FAIL 52b: a fulfilment mark from another transaction authorised an undercut here (refused with %)', v_detail;
  end if;

  perform set_config('request.jwt.claims', json_build_object('sub', v_owner_id)::text, true);

  -- ------------------------------------------------ 53. an order line the till cannot carry is refused in the shop's own words
  -- THE REFUSAL 20260929000200 CREATED WITHOUT MEANING TO. Filing every line at
  -- the price the customer agreed to also puts every line behind that field's
  -- own ceiling of 1,000,000,000 cents (20260929000050) -- and an order line
  -- can exceed it, because order_items.line_total_cents is a plain `integer`.
  -- Before this branch such an order completed: it was priced from
  -- products.price_cents and met only the int32 bound.
  --
  -- Untranslated it came back as complete_sale's own English, naming a field
  -- ("agreed price") no storefront screen has ever shown, straight through
  -- orderErrorMessage's `default: return null` and onto the shop's screen.
  -- 20260929000250 maps it the way this function maps every other refusal it
  -- can meet.
  v_raised := false;
  v_status := null;
  v_detail := null;
  v_sales_before := (select count(*) from public.sales where shop_id = v_shop_id);
  begin
    perform public.complete_storefront_order(v_huge_id, 'cash');
  exception
    when others then
      v_raised := true;
      v_status := sqlerrm;
      get stacked diagnostics v_detail = pg_exception_detail;
  end;
  if not v_raised then
    raise exception 'FAIL 53: a line of 2 x 600,000,000 was completed -- it is past the ceiling on an agreed price';
  end if;
  -- NOT `else raise;` here, deliberately, unlike the handlers above: an
  -- unrecognised message reaching a caller IS the defect this check is about,
  -- so re-raising it would reproduce the bug instead of reporting it. Without
  -- 20260929000250 this line reads back `agreed price for Huge is out of
  -- range: 600000000 x 2 is more than the 1000000000 cents one line may
  -- carry` -- complete_sale's own English, on its way to a shopkeeper.
  if v_status <> 'order_line_out_of_range' then
    raise exception 'FAIL 53: refused with "%", which no client translates -- expected order_line_out_of_range', v_status;
  end if;
  -- The raw message travels in the detail, so a bug report can still name the
  -- product and the figures without this function re-deriving a bound that
  -- belongs to complete_sale.
  if v_detail is null or v_detail not like '%agreed price for Huge is out of range%' then
    raise exception 'FAIL 53: the detail does not carry complete_sale''s own message (got %)', coalesce(v_detail, '<null>');
  end if;
  -- And the refusal cost nothing: no sale, no stock movement, no status change,
  -- and no fulfilment mark left behind for check 52's escape route to use.
  if (select count(*) from public.sales where shop_id = v_shop_id) <> v_sales_before then
    raise exception 'FAIL 53: a refused completion still wrote a sale';
  end if;
  select status, sale_id into v_status, v_sale_link from public.orders where id = v_huge_id;
  if v_status <> 'ready' or v_sale_link is not null then
    raise exception 'FAIL 53: a refused completion left the order at % against sale %', v_status, v_sale_link;
  end if;
  if (select count(*) from public.storefront_order_fulfilments) <> 0 then
    raise exception 'FAIL 53: a refused completion left a fulfilment mark behind';
  end if;

  -- ------------------------------------------------ 47. a tax-charging shop can complete an order at all
  -- Turned on LAST, and on this shop rather than a second one, because every
  -- check above asserts figures with no tax in them. 5% of a 4000 quote:
  -- round(4000 * 5 / 105) = 190 out, 3810 of revenue left -- the tax comes OUT
  -- of what the customer was told, never on top of it.
  update public.shops set tax_enabled = true, tax_rate_percent = 5 where id = v_shop_id;

  v_sale_id := public.complete_storefront_order(v_tax_id, 'zaad');
  if v_sale_id is null then
    raise exception 'FAIL 47: a tax-charging shop could not complete an order';
  end if;

  select total_cents, tax_cents into v_count, v_amount from public.sales where id = v_sale_id;
  if v_count <> 4000 then
    raise exception 'FAIL 47: the sale totals % -- the customer was quoted 4000', v_count;
  end if;
  if v_amount <> 190 then
    raise exception 'FAIL 47: expected 190 of tax carved out of the 4000 quote, got %', v_amount;
  end if;

  select journal_entry_id into v_entry_id from public.sales where id = v_sale_id;
  select coalesce(sum(amount_cents), 0) into v_amount from public.journal_lines where entry_id = v_entry_id;
  if v_amount <> 0 then
    raise exception 'FAIL 47: the entry does not balance -- debits and credits differ by %', v_amount;
  end if;
  select coalesce(sum(jl.amount_cents), 0) into v_amount
    from public.journal_lines jl join public.accounts a on a.id = jl.account_id
   where jl.entry_id = v_entry_id and a.code = '4000';
  if v_amount <> -3810 then
    raise exception 'FAIL 47: expected 4000 credited 3810 (the quote less its own tax), got %', v_amount;
  end if;
  select coalesce(sum(jl.amount_cents), 0) into v_amount
    from public.journal_lines jl join public.accounts a on a.id = jl.account_id
   where jl.entry_id = v_entry_id and a.code = '2100';
  if v_amount <> -190 then
    raise exception 'FAIL 47: expected 2100 Sales Tax Payable credited 190, got % -- the till puts it there', v_amount;
  end if;
  select coalesce(sum(jl.amount_cents), 0) into v_amount
    from public.journal_lines jl join public.accounts a on a.id = jl.account_id
   where jl.entry_id = v_entry_id and a.code = '1020';
  if v_amount <> 4000 then
    raise exception 'FAIL 47: expected 1020 debited the 4000 the customer actually handed over, got %', v_amount;
  end if;

  -- ------------------------------------------------ 48. and the delivery fee is untouched by any of it
  select id into v_entry_fee
    from public.journal_entries
   where shop_id = v_shop_id and id <> v_entry_id
     and description like '%' || v_sale_id::text || '%';
  if v_entry_fee is null then
    raise exception 'FAIL 48: the delivery fee posted no entry naming its sale';
  end if;
  select coalesce(sum(jl.amount_cents), 0) into v_amount
    from public.journal_lines jl join public.accounts a on a.id = jl.account_id
   where a.shop_id = v_shop_id and a.code = '4300';
  if v_amount <> -1500 then
    raise exception 'FAIL 48: expected 4300 Delivery Income credited the whole 1500, got %', v_amount;
  end if;
  -- No tax is carved out of the fee: 2100 shop-wide holds the goods' 190 and
  -- nothing else, so route B's two-line entry is exactly what it was.
  select coalesce(sum(jl.amount_cents), 0) into v_amount
    from public.journal_lines jl join public.accounts a on a.id = jl.account_id
   where a.shop_id = v_shop_id and a.code = '2100';
  if v_amount <> -190 then
    raise exception 'FAIL 48: 2100 holds % shop-wide -- the delivery fee has been taxed as well', v_amount;
  end if;
  if exists (
    select 1 from public.journal_lines jl join public.accounts a on a.id = jl.account_id
     where jl.entry_id = v_entry_id and a.code = '4300') then
    raise exception 'FAIL 48: the sale''s own entry carries a 4300 line';
  end if;
  -- And the two entries together still bring in exactly what the customer was
  -- quoted for the whole order.
  select coalesce(sum(jl.amount_cents), 0) into v_amount
    from public.journal_lines jl join public.accounts a on a.id = jl.account_id
   where jl.entry_id in (v_entry_id, v_entry_fee) and a.code = '1020';
  if v_amount <> (select total_cents from public.orders where id = v_tax_id) then
    raise exception 'FAIL 48: the two entries bring in % but the order total is %',
      v_amount, (select total_cents from public.orders where id = v_tax_id);
  end if;

  raise notice 'PASS: fulfilment honours the agreed price';
  raise exception 'rollback_marker';
exception
  when others then
    if sqlerrm = 'rollback_marker' then
      -- Same reason the first block does not say it either: the phrase is the
      -- runner's whole verdict, and it now lives at the foot of block 3.
      raise notice 'verify-order-transitions: checks 46-53 passed, rolled back (part 2 of 3)';
    else
      raise;
    end if;
end $$;

-- ════════════════════════════════════════════════════════════════════════
-- Task 1 (orders, part 0): FULFILLING AN ORDER DOES NOT HAPPEN AT A TILL
-- (20261010000000_fulfilment_needs_no_register.sql)
-- ════════════════════════════════════════════════════════════════════════
--
-- A THIRD BLOCK rather than more checks bolted into the second, for the same
-- reason there is a second: every check above sells at a location with
-- require_open_register OFF and would refuse outright with it ON, and one of
-- these needs an open register session, which no fixture above has any use
-- for. Nothing above is renumbered and no check above is edited.
--
--   54.   A LOCATION THAT REQUIRES AN OPEN REGISTER CAN STILL COMPLETE A
--         STOREFRONT ORDER. Before this migration complete_storefront_order
--         passed p_register_session_id => null unconditionally, and `orders`
--         carries no location -- so every storefront sale resolved to the
--         shop's PRIMARY location and complete_sale's guard refused it, with
--         no parameter anywhere to pass a session through. A shop with the
--         setting on could not complete a single online order. The sale is
--         also asserted to carry NO session, which is the honest answer for
--         an order going out on a motorbike: there is no drawer.
--   55.   THE POS GUARD SURVIVED, and it is the assertion this task is most
--         at risk of breaking -- complete_sale is the function the whole till
--         runs through. The SAME location, the SAME member with no session
--         open, ringing up through complete_sale DIRECTLY, is still refused,
--         and refused by that exact sentence rather than merely by something.
--         The new parameter defaults TRUE, so every caller that existed
--         before the migration -- the POS included -- is unchanged.
--   56.   AN OPEN SESSION AT THE LOCATION IS ATTACHED TO THE SALE. A handover
--         at the counter, by someone who has a drawer open, IS a drawer
--         transaction and belongs in that drawer's count -- so
--         complete_storefront_order asks my_open_session_at
--         (20260822000000:219) for the completing member's session at the
--         resolved location and passes it when there is one. Asserted against
--         the session's own id, not merely "not null", and against the
--         session's own takings so the money really lands in that drawer.
--
-- WHY THESE RAISE RATHER THAN PRINT. run-all.sh decides a script's verdict by
-- grepping its whole output for `ALL CHECKS PASSED`; a `raise notice 'FAIL
-- ...'` is printed and then ignored, and the suite goes green with the
-- failure sitting in the log. Every check in this file raises, and so do
-- these. It is also why the verdict line moved off the end of block 2 and
-- onto the end of this one.

do $$
declare
  v_owner_id   uuid := gen_random_uuid();
  v_shop_id    uuid;
  v_loc_id     uuid;
  v_member_id  uuid;
  v_register   uuid;
  v_session    uuid;
  v_prod       uuid;

  v_bike_id    uuid;   -- check 54: goes out on a motorbike, no drawer
  v_counter_id uuid;   -- check 56: handed over at the counter

  v_sale_id    uuid;
  v_on_sale    uuid;
  v_detail     text;
  v_raised     boolean;
  v_amount     bigint;
begin
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
    values (v_owner_id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            'verify-order-transitions-t0-' || v_owner_id || '@example.test', '', now(), now(), now());

  insert into public.shops (owner_id, name) values (v_owner_id, 'Drawer Shop')
    returning id into v_shop_id;
  insert into public.storefronts (shop_id) values (v_shop_id);

  -- The setting under test, on from birth. Primary, because that is the
  -- location every storefront sale resolves to: `orders` carries none, so
  -- complete_sale falls through to its own is_primary/created_at default
  -- (20260908000300:182-191) and this is the row it lands on.
  insert into public.shop_locations (shop_id, name, is_primary, require_open_register)
    values (v_shop_id, 'Main', true, true) returning id into v_loc_id;

  -- shops_seed_defaults (20260823000000:134) gives the owner a real
  -- shop_members row; my_open_session_at joins through it, and
  -- register_sessions.shop_member_id is a foreign key into it.
  select id into v_member_id from public.shop_members
   where shop_id = v_shop_id and user_id = v_owner_id;
  if v_member_id is null then
    raise exception 'FAIL 54: fixture -- the owner has no shop_members row to open a register against';
  end if;

  insert into public.products (shop_id, name, price_cents, cost_cents)
    values (v_shop_id, 'Sambuusa', 700, 150) returning id into v_prod;
  insert into public.product_location_stock (product_id, location_id, stock)
    values (v_prod, v_loc_id, 100);

  insert into public.orders (shop_id, customer_name, customer_phone, fulfilment, delivery_area, delivery_landmark, subtotal_cents, delivery_fee_cents, total_cents)
    values (v_shop_id, 'Koodbuur Customer', '+252634300001', 'deliver', 'Koodbuur', 'By the water tank', 700, 0, 700)
    returning id into v_bike_id;
  insert into public.order_items (order_id, product_id, product_name, unit_price_cents, quantity, line_total_cents)
    values (v_bike_id, v_prod, 'Sambuusa', 700, 1, 700);

  insert into public.orders (shop_id, customer_name, customer_phone, fulfilment, subtotal_cents, delivery_fee_cents, total_cents)
    values (v_shop_id, 'Counter Customer', '+252634300002', 'collect', 700, 0, 700)
    returning id into v_counter_id;
  insert into public.order_items (order_id, product_id, product_name, unit_price_cents, quantity, line_total_cents)
    values (v_counter_id, v_prod, 'Sambuusa', 700, 1, 700);

  perform set_config('request.jwt.claims', json_build_object('sub', v_owner_id)::text, true);
  perform set_config('role', 'authenticated', true);

  perform public.transition_order(v_bike_id, 'accepted', null);
  perform public.transition_order(v_bike_id, 'ready', null);
  perform public.transition_order(v_counter_id, 'accepted', null);
  perform public.transition_order(v_counter_id, 'ready', null);

  -- Same posture as the two blocks above from check 23 on: postgres for the
  -- assertions, with the JWT claim still set, which is what every permission
  -- and membership gate under test actually reads.
  perform set_config('role', 'postgres', true);

  -- ------------------------------------------------ 54. require_open_register no longer refuses a fulfilment
  -- No register exists at this shop yet, so my_open_session_at has nothing to
  -- find and complete_storefront_order passes null -- which is exactly the
  -- call the old guard refused.
  if public.my_open_session_at(v_loc_id) is not null then
    raise exception 'FAIL 54: fixture -- the completing member already has a session open';
  end if;

  v_sale_id := public.complete_storefront_order(v_bike_id, 'cash');
  if v_sale_id is null then
    raise exception 'FAIL 54: completing an order at a require_open_register location returned no sale id';
  end if;
  if (select status from public.orders where id = v_bike_id) <> 'completed' then
    raise exception 'FAIL 54: the order is % rather than completed', (select status from public.orders where id = v_bike_id);
  end if;
  if (select total_cents from public.sales where id = v_sale_id) <> 700 then
    raise exception 'FAIL 54: the sale totals % against a quote of 700',
      (select total_cents from public.sales where id = v_sale_id);
  end if;
  -- And it is filed against NO drawer. A delivery has none to reconcile
  -- against, and inventing one would put the money in a count nobody took.
  if (select register_session_id from public.sales where id = v_sale_id) is not null then
    raise exception 'FAIL 54: a delivery was filed against register session %',
      (select register_session_id from public.sales where id = v_sale_id);
  end if;
  -- The setting is left exactly where the shop put it: completing an order is
  -- not a way to turn a branch's register requirement off.
  if not (select require_open_register from public.shop_locations where id = v_loc_id) then
    raise exception 'FAIL 54: completing the order cleared the location''s require_open_register';
  end if;

  -- ------------------------------------------------ 55. the POS guard is untouched
  -- The same shop, the same location, the same member with no session -- but
  -- through complete_sale directly, which is what the till does. The payment
  -- equals the total on purpose, so the ONLY thing left to refuse this sale is
  -- the guard: were it gone, this call would succeed rather than fail on some
  -- unrelated arithmetic and pass this check for the wrong reason.
  v_raised := false;
  begin
    perform public.complete_sale(
      p_shop_id  => v_shop_id,
      p_items    => jsonb_build_array(jsonb_build_object('product_id', v_prod, 'quantity', 1)),
      p_payments => jsonb_build_array(jsonb_build_object('method', 'cash', 'amount_cents', 700)));
  exception
    when others then
      v_raised := true;
      v_detail := sqlerrm;
  end;
  if not v_raised then
    raise exception 'FAIL 55: complete_sale rang up a till sale with no session at a require_open_register location';
  end if;
  if v_detail <> 'this store requires an open register before a sale can be rung up' then
    raise exception 'FAIL 55: refused, but for the wrong reason: %', v_detail;
  end if;

  -- ------------------------------------------------ 56. a counter handover reconciles into the open drawer
  insert into public.registers (shop_id, location_id, name, kind)
    values (v_shop_id, v_loc_id, 'Counter 1', 'counter') returning id into v_register;
  insert into public.register_sessions (shop_id, location_id, register_id, shop_member_id, opened_by)
    values (v_shop_id, v_loc_id, v_register, v_member_id, v_owner_id) returning id into v_session;

  if public.my_open_session_at(v_loc_id) is distinct from v_session then
    raise exception 'FAIL 56: fixture -- my_open_session_at returns % rather than the session just opened %',
      public.my_open_session_at(v_loc_id), v_session;
  end if;

  v_sale_id := public.complete_storefront_order(v_counter_id, 'cash');
  select register_session_id into v_on_sale from public.sales where id = v_sale_id;
  if v_on_sale is distinct from v_session then
    raise exception 'FAIL 56: expected session % on the sale, got %', v_session, v_on_sale;
  end if;
  -- Not just the pointer: the money is in that drawer's count. The session's
  -- takings are read the way the register screen reads them -- off the sale
  -- payments filed against it.
  select coalesce(sum(sp.amount_cents), 0) into v_amount
    from public.sale_payments sp
    join public.sales s on s.id = sp.sale_id
   where s.register_session_id = v_session;
  if v_amount <> 700 then
    raise exception 'FAIL 56: the drawer holds % of takings, not the 700 handed over', v_amount;
  end if;

  raise notice 'PASS: fulfilment needs no register, and uses one when there is one';
  raise exception 'rollback_marker';
exception
  when others then
    if sqlerrm = 'rollback_marker' then
      raise notice 'verify-order-transitions: ALL CHECKS PASSED (1-56), rolled back';
    else
      raise;
    end if;
end $$;
