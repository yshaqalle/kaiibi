-- Help & support visibility (migration 20260825000000).
--
-- The headline question is #4: a cashier's message to us must not be readable
-- by their manager. Everything before it establishes that threads and messages
-- exist and that the ordinary cases work, so a failure there is distinguishable
-- from a failure of the privacy rule itself.
--
-- The cashier is a real shop_members row on the seeded Cashier role, not a
-- stranger. A non-member would pass #6 and #8 for the wrong reason -- they'd be
-- refused for not belonging to the shop at all, which is not what either check
-- is asking.
--
-- Everything runs inside one DO block whose EXCEPTION clause rolls it all back.

\set ON_ERROR_STOP on

do $$
declare
  v_owner_id    uuid := gen_random_uuid();
  v_cashier_id  uuid := gen_random_uuid();
  v_outsider_id uuid := gen_random_uuid();
  v_shop_id uuid;
  v_cashier_role uuid;
  v_cashier_thread uuid;
  v_store_thread uuid;
  v_own_thread uuid;
  v_msg_id uuid;
  v_count integer;
  v_ref_a text;
  v_ref_b text;
begin
  ------------------------------------------------------------------
  -- Fixture
  ------------------------------------------------------------------
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
    select u, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
           'verify-support-' || u || '@example.test', '', now(), now(), now()
      from unnest(array[v_owner_id, v_cashier_id, v_outsider_id]) u;

  insert into public.shops (owner_id, name) values (v_owner_id, 'Support Test Shop')
    returning id into v_shop_id;

  select id into v_cashier_role from public.roles where shop_id = v_shop_id and name = 'Cashier';
  insert into public.shop_members (shop_id, user_id, role_id, full_name, active)
    values (v_shop_id, v_cashier_id, v_cashier_role, 'Sagal Ahmed', true);

  ------------------------------------------------------------------
  raise notice '=== 1. References are unique and increasing ===';
  ------------------------------------------------------------------
  select public.next_support_reference() into v_ref_a;
  select public.next_support_reference() into v_ref_b;
  if v_ref_a = v_ref_b then raise exception 'FAIL: reference repeated: %', v_ref_a; end if;
  if v_ref_a !~ '^KB-[0-9]+$' then raise exception 'FAIL: bad reference shape: %', v_ref_a; end if;
  raise notice 'OK: % then %', v_ref_a, v_ref_b;

  ------------------------------------------------------------------
  raise notice '=== 2. A thread gets a reference and an open status by default ===';
  ------------------------------------------------------------------
  insert into public.support_threads (shop_id, opened_by, author_user_id, category, subject)
    values (v_shop_id, 'shop', v_cashier_id, 'broken', 'Scanner stops after a refund')
    returning id into v_cashier_thread;

  perform 1 from public.support_threads
    where id = v_cashier_thread and status = 'open' and reference like 'KB-%';
  if not found then raise exception 'FAIL: thread defaults are wrong'; end if;
  raise notice 'OK: thread opened with a reference and status open';

  ------------------------------------------------------------------
  raise notice '=== 3. A message advances last_message_at and marks its own end read ===';
  ------------------------------------------------------------------
  update public.support_threads
     set last_message_at = now() - interval '1 day', shop_read_at = null, platform_read_at = null
   where id = v_cashier_thread;

  insert into public.support_messages (thread_id, author_kind, author_user_id, body)
    values (v_cashier_thread, 'shop', v_cashier_id, 'It beeps but nothing lands in the cart.')
    returning id into v_msg_id;

  -- Writing marks it read for the writer and leaves the other end unread --
  -- that asymmetry is the whole unread count.
  perform 1 from public.support_threads
    where id = v_cashier_thread
      and last_message_at > now() - interval '1 minute'
      and shop_read_at is not null
      and platform_read_at is null;
  if not found then raise exception 'FAIL: trigger did not touch the thread correctly'; end if;
  raise notice 'OK: last_message_at advanced, shop read, platform unread';

  ------------------------------------------------------------------
  raise notice '=== 4. A cashier''s thread is invisible to the shop owner ===';
  ------------------------------------------------------------------
  -- The question the privacy rule exists to answer.
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_owner_id, 'role', 'authenticated', 'aal', 'aal1')::text, true);
  perform set_config('role', 'authenticated', true);

  select count(*) into v_count from public.support_threads where id = v_cashier_thread;
  if v_count <> 0 then raise exception 'FAIL: the owner can read a cashier''s support thread'; end if;

  select count(*) into v_count from public.support_messages where thread_id = v_cashier_thread;
  if v_count <> 0 then raise exception 'FAIL: the owner can read a cashier''s support messages'; end if;
  raise notice 'OK: the owner sees neither the thread nor its messages';

  ------------------------------------------------------------------
  raise notice '=== 5. The cashier still sees their own ===';
  ------------------------------------------------------------------
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_cashier_id, 'role', 'authenticated', 'aal', 'aal1')::text, true);

  select count(*) into v_count from public.support_threads where id = v_cashier_thread;
  if v_count <> 1 then raise exception 'FAIL: the author cannot read their own thread'; end if;

  select count(*) into v_count from public.support_messages where thread_id = v_cashier_thread;
  if v_count <> 1 then raise exception 'FAIL: the author cannot read their own messages'; end if;
  raise notice 'OK: the author reads their own thread and its messages';

  ------------------------------------------------------------------
  raise notice '=== 6. A store-addressed thread from us IS the owner''s ===';
  ------------------------------------------------------------------
  perform set_config('role', 'postgres', true);
  insert into public.support_threads
    (shop_id, opened_by, author_user_id, addressed_user_id, category, subject)
    values (v_shop_id, 'platform', null, null, 'billing', 'Your ZAAD payment cleared')
    returning id into v_store_thread;

  perform set_config('request.jwt.claims',
    json_build_object('sub', v_owner_id, 'role', 'authenticated', 'aal', 'aal1')::text, true);
  perform set_config('role', 'authenticated', true);
  select count(*) into v_count from public.support_threads where id = v_store_thread;
  if v_count <> 1 then raise exception 'FAIL: the owner cannot read a thread addressed to the store'; end if;

  -- ...and NOT the cashier's: billing belongs to whoever runs the shop.
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_cashier_id, 'role', 'authenticated', 'aal', 'aal1')::text, true);
  select count(*) into v_count from public.support_threads where id = v_store_thread;
  if v_count <> 0 then raise exception 'FAIL: a cashier can read a store-addressed billing thread'; end if;
  raise notice 'OK: store-addressed reaches settings.access holders only';

  ------------------------------------------------------------------
  raise notice '=== 7. Someone from another shop sees nothing ===';
  ------------------------------------------------------------------
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_outsider_id, 'role', 'authenticated', 'aal', 'aal1')::text, true);
  select count(*) into v_count from public.support_threads where shop_id = v_shop_id;
  if v_count <> 0 then raise exception 'FAIL: an outsider can read this shop''s threads'; end if;
  raise notice 'OK: an outsider reads nothing';

  ------------------------------------------------------------------
  raise notice '=== 8. A member cannot forge a thread that looks like ours ===';
  ------------------------------------------------------------------
  -- An operator-opened thread has the wider read policy, so letting a member
  -- write opened_by = 'platform' would let them expose their own message to
  -- the whole shop -- or read one addressed to someone else.
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_cashier_id, 'role', 'authenticated', 'aal', 'aal1')::text, true);
  begin
    insert into public.support_threads (shop_id, opened_by, author_user_id, category, subject)
      values (v_shop_id, 'platform', v_cashier_id, 'billing', 'Forged');
    raise exception 'FAIL: a member inserted a platform-opened thread';
  exception when insufficient_privilege or check_violation then
    raise notice 'OK: refused';
  end;

  -- The control: the same person opening an ordinary thread is accepted, so #8
  -- is testing the forgery and not a table nobody can write to. It also proves
  -- the reference default works from a client session, which it only does
  -- because next_support_reference() is security definer.
  --
  -- Both writes use RETURNING deliberately. The client always asks for the row
  -- back, and RETURNING makes the SELECT policy run against a row no snapshot
  -- can see yet -- which is why the thread rule is written over the row's
  -- columns rather than as a lookup by id.
  insert into public.support_threads (shop_id, opened_by, author_user_id, category, subject)
    values (v_shop_id, 'shop', v_cashier_id, 'help', 'How do I void a sale?')
    returning id, reference into v_own_thread, v_ref_a;
  if v_ref_a !~ '^KB-[0-9]+$' then raise exception 'FAIL: no reference on a client-opened thread'; end if;

  insert into public.support_messages (thread_id, author_kind, author_user_id, body)
    values (v_own_thread, 'shop', v_cashier_id, 'Never mind, found it.')
    returning id into v_msg_id;
  raise notice 'OK: an ordinary thread and a reply from the same person are accepted, reference %', v_ref_a;

  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims', null, true);

  raise notice 'ALL CHECKS PASSED';
  raise exception 'rollback: verification complete';
exception
  when others then
    if sqlerrm = 'rollback: verification complete' then
      raise notice 'Rolled back cleanly.';
    else
      raise;
    end if;
end $$;
