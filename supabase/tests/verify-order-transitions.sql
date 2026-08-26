-- transition_order: the moves a shop makes that touch nothing.
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
-- Nothing else. In particular NOT ready -> completed: Task 4 owns that move
-- because it is the one that posts to the ledger, and a function here that
-- allowed it would let a shop mark an order done with nothing in the books.
-- 'completed' is simply never a target this function (or the trigger behind
-- it) recognises as reachable -- omitted, not special-cased, so there is one
-- fewer place a future edit could quietly re-open it.
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
--   18.   the trigger, not just the function, is what actually enforces the
--         table: a shop member's own direct UPDATE (the plain RLS path,
--         nothing to do with this function) is refused an illegal edge too.
--   19.   an unknown order id is refused, distinctly from an existing one
--         belonging to someone else.
--   20.   a shop member of a DIFFERENT shop may not move this order.
--   21/22. the grant: authenticated holds EXECUTE, anon does not -- on
--         paper and for real (belt and braces, same technique as
--         verify-orders.sql check 14/16/17).
--   23.   a shop whose plan no longer includes storefront may not move an
--         order either, even one already sitting in its queue. Left last,
--         same reason verify-orders.sql leaves its own version last: it
--         moves the shop off the plan every check above depends on.

\set ON_ERROR_STOP on

do $$
declare
  v_owner_id    uuid := gen_random_uuid();
  v_staff_id    uuid := gen_random_uuid();
  v_outsider_id uuid := gen_random_uuid();
  v_shop_id     uuid;
  v_other_shop_id uuid;
  v_role_id     uuid;
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
begin
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
    select u, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
           'verify-order-transitions-' || u || '@example.test', '', now(), now(), now()
      from unnest(array[v_owner_id, v_staff_id, v_outsider_id]) u;

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

  perform set_config('request.jwt.claims', json_build_object('sub', v_owner_id)::text, true);
  perform set_config('role', 'authenticated', true);

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

  -- ------------------------------------------------ 18. the trigger enforces the table itself, not just this function
  -- A shop member's own plain UPDATE (RLS, nothing to do with transition_order)
  -- attempting an illegal edge is refused the same way.
  begin
    v_raised := false;
    begin
      update public.orders set status = 'ready' where id = v_cancel2_id; -- v_cancel2_id is 'cancelled'
    exception
      when others then
        if sqlerrm = 'invalid_order_transition' then v_raised := true; else raise; end if;
    end;
    if not v_raised then
      raise exception 'FAIL: a direct UPDATE bypassed the transition guard';
    end if;
  end;

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

  -- ------------------------------------------------ 23. a de-entitled shop stops moving its own orders
  -- Last on purpose, same reason verify-orders.sql leaves its own version
  -- last: it moves the shop under test off the plan every check above
  -- depends on.
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

  raise notice 'PASS: order transitions';
  raise exception 'rollback_marker';
exception
  when others then
    if sqlerrm = 'rollback_marker' then
      raise notice 'verify-order-transitions: all checks passed, rolled back';
    else
      raise;
    end if;
end $$;
