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
  v_manager_id  uuid := gen_random_uuid();
  v_outsider_id uuid := gen_random_uuid();
  v_shop_id uuid;
  v_cashier_role uuid;
  v_manager_role uuid;
  v_cashier_thread uuid;
  v_store_thread uuid;
  v_own_thread uuid;
  v_msg_id uuid;
  v_count integer;
  v_deleted integer;
  v_ref_a text;
  v_ref_b text;
  v_secret_path text;
  v_store_path text;
  v_read_at timestamptz;
  v_last_at timestamptz;
  v_thread public.support_threads;
  -- The clock of a tablet that is badly wrong, which is the case check 13 is
  -- about. Far enough out that no server stamp can be mistaken for it.
  v_future timestamptz := now() + interval '10 years';
begin
  ------------------------------------------------------------------
  -- Fixture
  ------------------------------------------------------------------
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
    select u, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
           'verify-support-' || u || '@example.test', '', now(), now(), now()
      from unnest(array[v_owner_id, v_cashier_id, v_manager_id, v_outsider_id]) u;

  insert into public.shops (owner_id, name) values (v_owner_id, 'Support Test Shop')
    returning id into v_shop_id;

  select id into v_cashier_role from public.roles where shop_id = v_shop_id and name = 'Cashier';
  insert into public.shop_members (shop_id, user_id, role_id, full_name, active)
    values (v_shop_id, v_cashier_id, v_cashier_role, 'Sagal Ahmed', true);

  -- A second, non-owner member. The seeded Manager is "everything except
  -- settings and staff management" (20260823000000), so they start WITHOUT
  -- settings.access and #6 can grant it to them mid-check. The owner cannot
  -- stand in for this: user_has_shop_permission() answers true for an owner
  -- before it reads a role, so a check made only through the owner passes
  -- whether the settings.access branch works or not.
  select id into v_manager_role from public.roles where shop_id = v_shop_id and name = 'Manager';
  insert into public.shop_members (shop_id, user_id, role_id, full_name, active)
    values (v_shop_id, v_manager_id, v_manager_role, 'Hodan Warsame', true);

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
  -- Only last_message_at is pushed back. The read stamps are already null on a
  -- thread nobody has written to, and shop_read_at can no longer be set to a
  -- chosen value by anyone (check 13) -- writing null here would come back as
  -- now() and quietly turn the assertion below into a tautology.
  update public.support_threads
     set last_message_at = now() - interval '1 day'
   where id = v_cashier_thread;

  perform 1 from public.support_threads
    where id = v_cashier_thread and shop_read_at is null and platform_read_at is null;
  if not found then raise exception 'FAIL: a fresh thread is not unread at both ends'; end if;

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

  -- The branch itself, through someone who is not the owner. The Manager is
  -- refused, then granted settings.access and admitted, with nothing else about
  -- them changing -- so it is the permission deciding and not the membership.
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_manager_id, 'role', 'authenticated', 'aal', 'aal1')::text, true);
  select count(*) into v_count from public.support_threads where id = v_store_thread;
  if v_count <> 0 then raise exception 'FAIL: a manager without settings.access can read a store-addressed thread'; end if;

  perform set_config('role', 'postgres', true);
  update public.roles set permissions = permissions || array['settings.access']
   where id = v_manager_role;
  perform set_config('role', 'authenticated', true);

  select count(*) into v_count from public.support_threads where id = v_store_thread;
  if v_count <> 1 then raise exception 'FAIL: settings.access does not open a store-addressed thread to a non-owner'; end if;

  perform set_config('role', 'postgres', true);
  update public.roles set permissions = array_remove(permissions, 'settings.access')
   where id = v_manager_role;
  perform set_config('role', 'authenticated', true);
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

  ------------------------------------------------------------------
  raise notice '=== 9. A member cannot write the columns only we set ===';
  ------------------------------------------------------------------
  -- The with-check policy constrains the columns it names; everything else is
  -- whatever the client sent. Without a column-level insert grant this row is
  -- accepted: a request that is closed and already read before an operator has
  -- seen it, under a reference of the member's choosing.
  begin
    insert into public.support_threads
      (shop_id, opened_by, author_user_id, category, subject, reference, status, platform_read_at)
      values (v_shop_id, 'shop', v_cashier_id, 'broken', 'Forged metadata',
              'KB-FORGED-1', 'closed', now() + interval '10 years');
    raise exception 'FAIL: a member wrote reference, status and platform_read_at';
  exception when insufficient_privilege then
    raise notice 'OK: reference, status and platform_read_at refused';
  end;

  begin
    insert into public.support_messages (thread_id, author_kind, author_user_id, body, created_at)
      values (v_own_thread, 'shop', v_cashier_id, 'Backdated', now() - interval '3 years');
    raise exception 'FAIL: a member set created_at on a message';
  exception when insufficient_privilege then
    raise notice 'OK: created_at refused';
  end;

  -- And the trigger does not take the writer's word for it either, which is the
  -- half that survives someone widening the grant again. Inserted as postgres
  -- because no client can supply created_at at all any more.
  perform set_config('role', 'postgres', true);
  insert into public.support_messages (thread_id, author_kind, author_user_id, body, created_at)
    values (v_own_thread, 'shop', v_cashier_id, 'Written now, dated 2023.', now() - interval '3 years');

  perform 1 from public.support_threads
    where id = v_own_thread
      and last_message_at > now() - interval '1 minute'
      and shop_read_at > now() - interval '1 minute';
  if not found then raise exception 'FAIL: a backdated message dragged last_message_at backwards'; end if;
  raise notice 'OK: a backdated message still sorts as arriving now';

  ------------------------------------------------------------------
  raise notice '=== 10. An uploaded file is as private as the thread it is on ===';
  ------------------------------------------------------------------
  -- The critical one. The row-level checks above are worth nothing if the
  -- screenshot attached to them is readable shop-wide, and a support screenshot
  -- is usually the whole complaint.
  --
  -- storage.protect_delete() blocks direct deletes from storage.objects unless
  -- this is set; the policy is what is under test, not that guard.
  perform set_config('storage.allow_delete_query', 'true', true);
  v_secret_path := v_shop_id || '/' || v_cashier_thread || '/private-screenshot.png';
  v_store_path  := v_shop_id || '/' || v_store_thread   || '/statement.png';

  -- A neighbour in another bucket whose second path segment is not a uuid --
  -- staff photos are <shop_id>/staff/<file> (src/lib/staff.ts). The support
  -- select policy casts segment 2, and storage.objects is one table for every
  -- bucket, so if that cast were ever reached for this row it would raise and
  -- take every image in the app down with it.
  insert into storage.objects (bucket_id, name, owner)
    values ('product-images', v_shop_id || '/staff/photo-1.jpg', v_owner_id);

  -- And the same hazard from INSIDE the bucket, where bucket_id no longer
  -- excuses the cast. Written as postgres on purpose: the insert policy only
  -- binds authenticated, and the operator half of this feature writes through
  -- service_role, so "the insert policy pins the shape" is not a guarantee that
  -- reaches this row. One object like it must not cost every member their
  -- listing.
  insert into storage.objects (bucket_id, name, owner)
    values ('support-attachments', 'aaa/notes/leftover.png', v_owner_id);

  perform set_config('request.jwt.claims',
    json_build_object('sub', v_cashier_id, 'role', 'authenticated', 'aal', 'aal1')::text, true);
  perform set_config('role', 'authenticated', true);
  insert into storage.objects (bucket_id, name, owner)
    values ('support-attachments', v_secret_path, v_cashier_id);

  -- A file dropped at the shop root belongs to no thread, so no thread rule can
  -- protect it. Refused at the door rather than left ambiguous.
  begin
    insert into storage.objects (bucket_id, name, owner)
      values ('support-attachments', v_shop_id || '/loose.png', v_cashier_id);
    raise exception 'FAIL: an attachment was accepted outside a thread folder';
  exception when insufficient_privilege then
    raise notice 'OK: an attachment outside a thread folder is refused';
  end;

  -- Writing into a colleague's thread folder. The cashier cannot read this
  -- thread (#6) and could not read the file back, so nothing leaks TO them --
  -- the harm runs the other way: the owner opens their billing thread and finds
  -- an attachment from someone with no access to it. Shop-wide write under
  -- thread-scoped read is what allows that.
  begin
    insert into storage.objects (bucket_id, name, owner)
      values ('support-attachments', v_shop_id || '/' || v_store_thread || '/planted.png', v_cashier_id);
    raise exception 'FAIL: a member planted a file in a thread they cannot see';
  exception when insufficient_privilege then
    raise notice 'OK: a member cannot plant a file in someone else''s thread folder';
  end;

  -- The malformed object seeded above is inside this bucket, so this listing is
  -- the one that raises if the cast is not total.
  select count(*) into v_count from storage.objects where bucket_id = 'support-attachments';
  if v_count <> 1 then
    raise exception 'FAIL: a member listing the bucket saw % object(s), expected only their own', v_count;
  end if;
  raise notice 'OK: a malformed object does not break listing for a member';

  perform set_config('request.jwt.claims',
    json_build_object('sub', v_owner_id, 'role', 'authenticated', 'aal', 'aal1')::text, true);
  select count(*) into v_count from storage.objects where name = v_secret_path;
  if v_count <> 0 then raise exception 'FAIL: the owner can read a cashier''s support attachment'; end if;

  delete from storage.objects where name = v_secret_path;
  get diagnostics v_deleted = row_count;
  if v_deleted <> 0 then raise exception 'FAIL: the owner can delete a cashier''s support attachment'; end if;

  -- The control: the owner is not simply locked out of the bucket. A thread we
  -- addressed to the store is theirs, and so is its file -- and that same file
  -- is not the cashier's.
  insert into storage.objects (bucket_id, name, owner)
    values ('support-attachments', v_store_path, v_owner_id);
  select count(*) into v_count from storage.objects where name = v_store_path;
  if v_count <> 1 then raise exception 'FAIL: the owner cannot read a file on a thread addressed to the store'; end if;

  perform set_config('request.jwt.claims',
    json_build_object('sub', v_cashier_id, 'role', 'authenticated', 'aal', 'aal1')::text, true);
  select count(*) into v_count from storage.objects where name = v_store_path;
  if v_count <> 0 then raise exception 'FAIL: a cashier can read a file on a store-addressed billing thread'; end if;

  select count(*) into v_count from storage.objects where name = v_secret_path;
  if v_count <> 1 then raise exception 'FAIL: the author cannot read their own attachment'; end if;

  delete from storage.objects where name = v_secret_path;
  get diagnostics v_deleted = row_count;
  if v_deleted <> 1 then raise exception 'FAIL: the author cannot delete their own attachment'; end if;

  -- Named, not counted. `count(*) from storage.objects` is satisfied by any row
  -- the public product-images policy lets through, so it passes whatever this
  -- migration does; asking for the staff photo by path is what makes it an
  -- assertion about the non-uuid segment 2 rather than about the table being
  -- non-empty.
  select count(*) into v_count from storage.objects
   where bucket_id = 'product-images' and name = v_shop_id || '/staff/photo-1.jpg';
  if v_count <> 1 then raise exception 'FAIL: the staff photo is not readable'; end if;
  raise notice 'OK: the owner can neither read nor delete it; the author can do both';

  ------------------------------------------------------------------
  raise notice '=== 11. An attachment row cannot name someone else''s file ===';
  ------------------------------------------------------------------
  -- Storage RLS stops the member downloading it, but an operator renders the
  -- thread through service_role, which bypasses storage RLS -- so an unchecked
  -- storage_path is a member choosing what we fetch on their behalf.
  begin
    insert into public.support_attachments (message_id, storage_path, file_name, byte_size)
      values (v_msg_id, gen_random_uuid() || '/' || v_own_thread || '/secret.png', 'secret.png', 10);
    raise exception 'FAIL: an attachment named another shop''s path';
  exception when check_violation then
    raise notice 'OK: another shop''s path refused';
  end;

  begin
    insert into public.support_attachments (message_id, storage_path, file_name, byte_size)
      values (v_msg_id, v_shop_id || '/' || v_cashier_thread || '/borrowed.png', 'borrowed.png', 10);
    raise exception 'FAIL: an attachment named another thread''s path';
  exception when check_violation then
    raise notice 'OK: another thread''s path refused';
  end;

  insert into public.support_attachments (message_id, storage_path, file_name, byte_size)
    values (v_msg_id, v_shop_id || '/' || v_own_thread || '/receipt.png', 'receipt.png', 10);
  raise notice 'OK: the message''s own thread folder is accepted';

  -- A check that only fires on insert is a check that stops being true the day
  -- somebody grants update. No client holds update on this table today, so this
  -- runs as postgres -- the trigger is the thing under test, not the grant.
  perform set_config('role', 'postgres', true);
  begin
    update public.support_attachments
       set storage_path = gen_random_uuid() || '/' || v_own_thread || '/moved.png'
     where message_id = v_msg_id;
    raise exception 'FAIL: storage_path was moved to another shop by an update';
  exception when check_violation then
    raise notice 'OK: the path check survives an update';
  end;

  ------------------------------------------------------------------
  raise notice '=== 12. A member can mark a thread read and change nothing else ===';
  ------------------------------------------------------------------
  -- markThreadRead() (src/lib/support.ts) is the only write a store makes to a
  -- thread after opening it, and the update policy that allows it would allow
  -- every other column too if the grant were table-wide -- the policy names no
  -- columns. So each half is asserted separately: the one column that must
  -- move, and the three that must not.
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_cashier_id, 'role', 'authenticated', 'aal', 'aal1')::text, true);
  perform set_config('role', 'authenticated', true);

  update public.support_threads set shop_read_at = now() where id = v_cashier_thread;
  get diagnostics v_count = row_count;
  if v_count <> 1 then raise exception 'FAIL: the author cannot mark their own thread read'; end if;

  -- Rewriting the subject of a thread an operator has already answered.
  begin
    update public.support_threads set subject = 'Rewritten' where id = v_cashier_thread;
    raise exception 'FAIL: a member rewrote the subject';
  exception when insufficient_privilege then null;
  end;

  -- Reopening what we closed -- or closing their own so it leaves the queue.
  begin
    update public.support_threads set status = 'closed' where id = v_cashier_thread;
    raise exception 'FAIL: a member changed the status';
  exception when insufficient_privilege then null;
  end;

  -- The other end's read stamp. Writable, this reads as "an operator has seen
  -- it" on a request nobody has looked at.
  begin
    update public.support_threads set platform_read_at = now() where id = v_cashier_thread;
    raise exception 'FAIL: a member wrote platform_read_at';
  exception when insufficient_privilege then null;
  end;

  -- The client's own shape: shop_read_at is the one column they hold, so a
  -- thread they cannot see must be unreachable through it. Silently zero rows
  -- rather than an error -- which is why this is counted.
  update public.support_threads set shop_read_at = now() where id = v_store_thread;
  get diagnostics v_count = row_count;
  if v_count <> 0 then raise exception 'FAIL: a member marked a thread they cannot see as read'; end if;

  -- And the same question asked of the POLICY rather than of the grant. The
  -- statement above cannot tell a narrow update policy from `using (true)`: its
  -- WHERE reads the row, so the SELECT policy picks the targets and answers it
  -- either way. A bare update reads nothing, so the update policy's own using
  -- clause is the only thing standing between it and every thread in the table
  -- -- including other shops'.
  --
  -- Read by row_count and by the store thread's still-null stamp, rather than by
  -- planting a recognisable timestamp: since check 13 the server writes this
  -- column itself, and its now() is the same value for every row this one
  -- transaction touches, so "was this row reached" cannot be asked of the value.
  -- The store thread is the only row here nobody has marked read, which is what
  -- makes it the witness.
  update public.support_threads set shop_read_at = now();
  get diagnostics v_count = row_count;
  -- The cashier's own two: the scanner thread and the "how do I void a sale"
  -- one. Exact, so an update that reaches too few fails as loudly as one that
  -- reaches too many.
  if v_count <> 2 then
    raise exception 'FAIL: an unfiltered update reached % thread(s), expected the cashier''s 2', v_count;
  end if;

  perform set_config('role', 'postgres', true);
  perform 1 from public.support_threads where id = v_store_thread and shop_read_at is not null;
  if found then raise exception 'FAIL: an unfiltered update reached a thread the member cannot see'; end if;
  perform set_config('role', 'authenticated', true);
  raise notice 'OK: shop_read_at only, and only on a thread they can see';

  ------------------------------------------------------------------
  raise notice '=== 13. The server, not the tablet, stamps shop_read_at ===';
  ------------------------------------------------------------------
  -- markThreadRead() runs on shared shop tablets whose clocks are often wrong,
  -- and the unread badge is last_message_at > shop_read_at with last_message_at
  -- always server now(). A device an hour fast marks every reply an operator
  -- writes in the next hour as read before it is written: the badge never rises
  -- and a genuine answer is lost silently. (A slow clock only leaves the badge
  -- stuck on, which the next reply clears.) So a stamp from the future must not
  -- survive the write, and the sent value is the client's own shape.
  update public.support_threads set shop_read_at = v_future where id = v_cashier_thread;
  get diagnostics v_count = row_count;
  if v_count <> 1 then raise exception 'FAIL: the mark-read update matched no row'; end if;

  perform set_config('role', 'postgres', true);
  select shop_read_at into v_read_at from public.support_threads where id = v_cashier_thread;
  if v_read_at is distinct from now() then
    raise exception 'FAIL: shop_read_at is % and not the server clock', v_read_at;
  end if;

  -- The other half of the rule, and the reason the trigger is conditional: an
  -- operator's reply rewrites this row and deliberately leaves shop_read_at
  -- where it was. That gap IS the unread signal, so a trigger that stamped
  -- every update would close it on arrival -- the same answer lost, reached
  -- through the trigger rather than through the clock. The store thread is
  -- unread by anyone, so a stamp shows up as a value where there was none.
  insert into public.support_messages (thread_id, author_kind, author_user_id, body)
    values (v_store_thread, 'platform', null, 'Nothing further needed from you.');

  select shop_read_at, last_message_at into v_read_at, v_last_at
    from public.support_threads where id = v_store_thread;
  if v_read_at is not null then
    raise exception 'FAIL: an operator reply marked itself read for the store';
  end if;
  if v_last_at < now() - interval '1 minute' then
    raise exception 'FAIL: an operator reply did not move last_message_at';
  end if;
  raise notice 'OK: the server clock wins, and an operator reply stays unread';

  ------------------------------------------------------------------
  raise notice '=== 14. A message body has a length the column enforces ===';
  ------------------------------------------------------------------
  -- validateDraft() refuses more than 4000 characters, but that is a courtesy
  -- to the person typing: a member holds an insert grant on `body` and can send
  -- a request this app never composed. Asserted through a client session and as
  -- postgres both, because the operator's side writes through service_role and
  -- a reply nobody can read to the end is no better than an unbounded request.
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_cashier_id, 'role', 'authenticated', 'aal', 'aal1')::text, true);
  perform set_config('role', 'authenticated', true);
  begin
    insert into public.support_messages (thread_id, author_kind, author_user_id, body)
      values (v_own_thread, 'shop', v_cashier_id, repeat('x', 4001));
    raise exception 'FAIL: a member stored a 4001-character body';
  exception when check_violation then null;
  end;

  -- The control: one character less is an ordinary message, so #14 is testing
  -- the limit and not a table that refuses long text on some other ground.
  insert into public.support_messages (thread_id, author_kind, author_user_id, body)
    values (v_own_thread, 'shop', v_cashier_id, repeat('x', 4000));

  perform set_config('role', 'postgres', true);
  begin
    insert into public.support_messages (thread_id, author_kind, author_user_id, body)
      values (v_own_thread, 'platform', null, repeat('x', 4001));
    raise exception 'FAIL: the operator side stored a 4001-character body';
  exception when check_violation then null;
  end;
  raise notice 'OK: 4000 accepted, 4001 refused at both ends';

  ------------------------------------------------------------------
  raise notice '=== 15. Opening a thread writes its first message, or neither ===';
  ------------------------------------------------------------------
  -- Two client round trips can land the thread and lose the message, and the
  -- store is then worse off than with no thread at all: the screen says it
  -- failed, they retry, and the subject-only orphan sits at the top of their
  -- list with a fresh last_message_at, undeletable (no client holds delete) and
  -- unanswerable (an operator opens a request with no body).
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_cashier_id, 'role', 'authenticated', 'aal', 'aal1')::text, true);
  perform set_config('role', 'authenticated', true);

  select * into v_thread from public.open_support_thread(
    v_shop_id, 'help', '  Voiding a sale  ', '  It asks for a manager PIN.  ',
    'pos', null, 'whatsapp', '{"platform": "android"}'::jsonb);

  -- The author is auth.uid() read inside a definer function, never an argument:
  -- the insert policy that pins it is not consulted for these rows at all, so
  -- an author parameter would be one member writing in another's name.
  if v_thread.author_user_id <> v_cashier_id then
    raise exception 'FAIL: the thread was opened in somebody else''s name';
  end if;
  if v_thread.opened_by <> 'shop' or v_thread.status <> 'open'
     or v_thread.reference !~ '^KB-[0-9]+$' then
    raise exception 'FAIL: the rpc did not open an ordinary, open shop thread';
  end if;
  if v_thread.subject <> 'Voiding a sale' then
    raise exception 'FAIL: subject stored untrimmed: %', v_thread.subject;
  end if;
  -- The row comes back after the touch trigger rather than as inserted, or
  -- unreadCount() shows a badge of 1 on a request its own author just sent.
  if v_thread.shop_read_at is null or v_thread.shop_read_at < v_thread.last_message_at then
    raise exception 'FAIL: a brand new thread comes back unread to its author';
  end if;

  select count(*) into v_count from public.support_messages
   where thread_id = v_thread.id and body = 'It asks for a manager PIN.';
  if v_count <> 1 then raise exception 'FAIL: the first message is missing (% rows)', v_count; end if;

  -- A definer function is the one path with no policy behind it, so it makes
  -- the membership test itself.
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_outsider_id, 'role', 'authenticated', 'aal', 'aal1')::text, true);
  begin
    perform public.open_support_thread(v_shop_id, 'help', 'Not my shop', 'Let me in.');
    raise exception 'FAIL: an outsider opened a thread in this shop';
  exception when insufficient_privilege then null;
  end;

  -- The failure the two-request version could not survive, forced: the thread
  -- row is already written when the message is refused (#14).
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_cashier_id, 'role', 'authenticated', 'aal', 'aal1')::text, true);
  begin
    perform public.open_support_thread(v_shop_id, 'help', 'Half a request', repeat('x', 4001));
    raise exception 'FAIL: a 4001-character first message was accepted';
  exception when check_violation then null;
  end;

  perform set_config('role', 'postgres', true);
  select count(*) into v_count from public.support_threads
   where shop_id = v_shop_id and subject in ('Half a request', 'Not my shop');
  if v_count <> 0 then raise exception 'FAIL: a refused open left % orphan thread(s)', v_count; end if;
  raise notice 'OK: both rows or neither, and only for a member of that shop';

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
