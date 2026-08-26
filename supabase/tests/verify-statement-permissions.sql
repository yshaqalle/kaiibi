-- The three financial statements are gated on ledger.view, and each one gates
-- itself.
--
-- All three of statement_lines(), balance_sheet() and cash_flow() are SECURITY
-- DEFINER, so the row-level policies on journal_lines and accounts do not apply
-- inside them. The has_shop_permission(p_shop_id, 'ledger.view') check at the
-- top of each function is the ONLY thing standing between a cashier and the
-- shop's books -- the wage bill, the owner's drawings, the margin on every
-- product.
--
-- verify-statements.sql check 9, 18 and 25 already point a STRANGER at each
-- function. This file is the harder case and the realistic one: a member of the
-- shop, active, holding a role, logged in legitimately -- and holding only
-- pos.access. Nothing in the stranger checks distinguishes "not in this shop"
-- from "in this shop without this permission", and it is the second that every
-- shop actually has staff for.
--
-- ## What this file asserts that the stranger checks cannot
--
-- balance_sheet() and cash_flow() both CALL statement_lines(). All three gates
-- raise the SAME message. So a behavioural check that only reads sqlerrm cannot
-- tell which function refused: delete balance_sheet's own gate and the call it
-- makes to statement_lines refuses the caller anyway, with the same words, and
-- the check stays green.
--
-- verify-statements.sql handles that by also asserting the gate EXISTS, via
-- pg_get_functiondef. That is a real check but it has a real hole: it matches
-- the TEXT of the function body, so it would pass on a body where the gate had
-- been commented out, or moved below the work it is supposed to guard, or put
-- inside a branch that never runs.
--
-- This file closes that hole without reading source at all. When a plpgsql
-- RAISE propagates, PG_EXCEPTION_CONTEXT carries the call stack, innermost
-- frame first:
--
--     PL/pgSQL function statement_lines(uuid,date,date,boolean) line 6 at RAISE
--     SQL statement "SELECT s.amount_cents ..."
--     PL/pgSQL function balance_sheet(uuid,date) line 12 at SQL statement
--
-- The first line names the function that actually raised. Asserting that
-- balance_sheet's refusal came from a RAISE inside balance_sheet -- not from
-- the statement_lines call underneath it -- proves the gate ran, which is the
-- thing pg_get_functiondef can only assume. A commented-out gate fails it. A
-- gate moved after the query fails it. It is a strictly stronger check, and it
-- costs nothing.
--
-- ## Positive controls
--
-- A refusal only means something if the same call SUCCEEDS for someone who
-- holds the permission. So the fixture also builds a second member whose role
-- holds ledger.view and nothing else, and asserts all three functions answer
-- for them. Without that, every assertion below would go on passing against a
-- function that raised for absolutely everyone -- or against a fixture whose
-- shop had been built wrong.
--
-- Deliberately ordered: every raw insert happens BEFORE `set role
-- authenticated`, because these tests run as postgres and RLS only starts
-- applying once the role is switched.

\set ON_ERROR_STOP on

do $$
declare
  v_owner  uuid := gen_random_uuid();
  v_till   uuid := gen_random_uuid();   -- pos.access only. The one under test.
  v_book   uuid := gen_random_uuid();   -- ledger.view only. The control.
  v_shop   uuid;
  v_loc    uuid;
  v_role_till uuid;
  v_role_book uuid;
  v_ctx    text;
  v_frame  text;
  v_rows   integer;
begin
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
    select u, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
           'verify-statement-permissions-' || u || '@example.test', '', now(), now(), now()
      from unnest(array[v_owner, v_till, v_book]) u;

  insert into public.shops (owner_id, name) values (v_owner, 'Gated Books Shop') returning id into v_shop;
  insert into public.shop_locations (shop_id, name, is_primary) values (v_shop, 'Main', true)
    returning id into v_loc;

  -- The staff member of every check below: a plain roles row plus a membership,
  -- which is the shape verify-posting-sales.sql builds its cashier with. There
  -- is no grant_role_permissions() helper in this database.
  --
  -- pos.access and NOTHING else. Not ledger.post either: a cashier who cannot
  -- read the books certainly should not be able to write them.
  insert into public.roles (shop_id, name, permissions)
    values (v_shop, 'Till Only', array['pos.access'])
    returning id into v_role_till;
  insert into public.shop_members (shop_id, user_id, role_id, active)
    values (v_shop, v_till, v_role_till, true);

  -- The control: the same shape of membership, differing in exactly one
  -- permission. Anything that refuses BOTH of these members is refusing them
  -- for a reason that is not ledger.view.
  insert into public.roles (shop_id, name, permissions)
    values (v_shop, 'Bookkeeper', array['ledger.view'])
    returning id into v_role_book;
  insert into public.shop_members (shop_id, user_id, role_id, active)
    values (v_shop, v_book, v_role_book, true);

  -- Something for the statements to report on, so that a successful call
  -- returns rows rather than an empty set that proves nothing. Posted by the
  -- OWNER, who holds every permission by virtue of shops.owner_id.
  perform set_config('request.jwt.claims', json_build_object('sub', v_owner)::text, true);
  perform set_config('role', 'authenticated', true);

  perform public.post_journal_entry(v_shop, public.shop_local_date(), 'Opening float',
    jsonb_build_array(
      jsonb_build_object('code', '1000', 'amount_cents',  5000),
      jsonb_build_object('code', '3000', 'amount_cents', -5000)),
    v_loc, 'opening');

  -- =====================================================================
  -- THE TILL USER. Three refusals, each asserted on the message AND on the
  -- frame that raised it.
  -- =====================================================================
  perform set_config('request.jwt.claims', json_build_object('sub', v_till)::text, true);

  --   Sanity: this really is a member of this shop, and really does lack
  --   ledger.view. Without this line every refusal below would also be
  --   explained by a membership that silently failed to insert -- which is the
  --   same green, for the wrong reason.
  if not public.has_shop_permission(v_shop, 'pos.access') then
    raise exception 'FAIL: the till user is not a member of the shop, so nothing below is testing ledger.view';
  end if;
  if public.has_shop_permission(v_shop, 'ledger.view') then
    raise exception 'FAIL: the till user holds ledger.view, so nothing below is testing anything';
  end if;

  -- 1. statement_lines() refuses.
  begin
    perform 1 from public.statement_lines(v_shop, '2000-01-01', '2100-01-01');
    raise exception 'FAIL: a member holding only pos.access read the income statement';
  exception
    when others then
      if sqlerrm like 'FAIL:%' then raise; end if;
      get stacked diagnostics v_ctx = pg_exception_context;
      if sqlerrm <> 'You do not have permission to see the books.' then
        raise exception 'FAIL: statement_lines refused the till user, but by something else: %', sqlerrm;
      end if;
      v_frame := split_part(coalesce(v_ctx, ''), E'\n', 1);
      if v_frame not like 'PL/pgSQL function statement_lines(%' then
        raise exception 'FAIL: statement_lines'' refusal was raised by "%", not by statement_lines itself', v_frame;
      end if;
  end;

  -- 2. balance_sheet() refuses, and refuses in its OWN body.
  --
  --    The frame assertion is the whole point here. balance_sheet calls
  --    statement_lines, statement_lines gates on the same permission with the
  --    same message, and security definer does not change auth.uid() -- so
  --    deleting balance_sheet's gate outright leaves the message identical and
  --    a message-only check green. The frame is what notices.
  begin
    perform 1 from public.balance_sheet(v_shop, public.shop_local_date());
    raise exception 'FAIL: a member holding only pos.access read the balance sheet';
  exception
    when others then
      if sqlerrm like 'FAIL:%' then raise; end if;
      get stacked diagnostics v_ctx = pg_exception_context;
      if sqlerrm <> 'You do not have permission to see the books.' then
        raise exception 'FAIL: balance_sheet refused the till user, but by something else: %', sqlerrm;
      end if;
      v_frame := split_part(coalesce(v_ctx, ''), E'\n', 1);
      if v_frame not like 'PL/pgSQL function balance_sheet(%' then
        raise exception 'FAIL: balance_sheet has no gate of its own -- the refusal came from "%". It only refused because the statement_lines call underneath it did.', v_frame;
      end if;
  end;

  -- 3. cash_flow() refuses, and refuses in its own body, for the same reason.
  begin
    perform 1 from public.cash_flow(v_shop, '2000-01-01', '2100-01-01');
    raise exception 'FAIL: a member holding only pos.access read the cash flow';
  exception
    when others then
      if sqlerrm like 'FAIL:%' then raise; end if;
      get stacked diagnostics v_ctx = pg_exception_context;
      if sqlerrm <> 'You do not have permission to see the books.' then
        raise exception 'FAIL: cash_flow refused the till user, but by something else: %', sqlerrm;
      end if;
      v_frame := split_part(coalesce(v_ctx, ''), E'\n', 1);
      if v_frame not like 'PL/pgSQL function cash_flow(%' then
        raise exception 'FAIL: cash_flow has no gate of its own -- the refusal came from "%". It only refused because the statement_lines call underneath it did.', v_frame;
      end if;
  end;

  -- =====================================================================
  -- THE POSITIVE CONTROLS. The same three calls, by a member whose only
  -- difference is the permission, must ANSWER -- and answer with rows.
  -- =====================================================================
  perform set_config('request.jwt.claims', json_build_object('sub', v_book)::text, true);

  select count(*) into v_rows from public.statement_lines(v_shop, '2000-01-01', '2100-01-01');
  if v_rows = 0 then
    raise exception 'FAIL: a member holding ledger.view got an empty income statement';
  end if;

  select count(*) into v_rows from public.balance_sheet(v_shop, public.shop_local_date());
  if v_rows = 0 then
    raise exception 'FAIL: a member holding ledger.view got an empty balance sheet';
  end if;

  select count(*) into v_rows from public.cash_flow(v_shop, '2000-01-01', '2100-01-01');
  if v_rows = 0 then
    raise exception 'FAIL: a member holding ledger.view got an empty cash flow';
  end if;

  --   ...and it is really reading THIS shop's ledger, not answering with a
  --   shape full of zeroes. The float posted above is the only cash there is.
  if (select amount_cents from public.balance_sheet(v_shop, public.shop_local_date())
       where code = '1000') is distinct from 5000 then
    raise exception 'FAIL: the bookkeeper''s balance sheet does not show the 5000 float, it shows %',
      (select amount_cents from public.balance_sheet(v_shop, public.shop_local_date()) where code = '1000');
  end if;

  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims', null, true);
  raise notice 'ALL CHECKS PASSED';
  raise exception 'rollback fixture';
exception
  when others then
    perform set_config('role', 'postgres', true);
    perform set_config('request.jwt.claims', null, true);
    if sqlerrm = 'rollback fixture' then return; end if;
    raise;
end $$;
