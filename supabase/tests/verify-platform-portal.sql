-- Security verification for the platform admin portal (migration
-- 20260818000500). Everything runs inside one DO block whose EXCEPTION clause
-- rolls the whole lot back, so it leaves no rows behind.
--
-- These are the assertions that matter if an operator account is ever stolen.
-- They are written as "the attacker got this far, and then could not" rather
-- than as feature tests, because that is the question being asked.

\set ON_ERROR_STOP on

do $$
declare
  v_operator uuid := gen_random_uuid();
  v_owner    uuid := gen_random_uuid();
  -- Somebody who has never written to support. The profiles policy added by
  -- 20260825000300 is only narrow if this person stays invisible.
  v_quiet    uuid := gen_random_uuid();
  v_shop_id  uuid;
  v_count    integer;
  v_raised   boolean;
begin
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at) values
    (v_operator, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'op-'   || v_operator || '@example.test', '', now(), now(), now()),
    (v_owner,    '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'shop-' || v_owner    || '@example.test', '', now(), now(), now()),
    (v_quiet,    '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'quiet-'|| v_quiet    || '@example.test', '', now(), now(), now());

  insert into public.shops (owner_id, name) values (v_owner, 'Portal Verify Shop') returning id into v_shop_id;
  insert into public.shop_locations (shop_id, name, is_primary) values (v_shop_id, 'Main', true);
  insert into public.products (shop_id, name, price_cents) values (v_shop_id, 'Portal Verify Product', 999);

  insert into public.platform_admins (user_id, role, note) values (v_operator, 'owner', 'verify');

  -- The owner writes in; the quiet user never does. That difference is the
  -- whole of the profiles policy below.
  insert into public.support_threads (shop_id, opened_by, author_user_id, category, subject)
    values (v_shop_id, 'shop', v_owner, 'billing', 'Portal Verify Thread');

  -- ------------------------------------------------- 1. MFA is not optional
  -- A stolen password gets an aal1 session. That must be worth nothing.
  perform set_config('request.jwt.claims', json_build_object('sub', v_operator, 'aal', 'aal1')::text, true);
  perform set_config('role', 'authenticated', true);

  if public.is_platform_admin() then
    raise exception 'FAIL: an operator without MFA passed is_platform_admin()';
  end if;

  -- ...but the portal still needs to tell "not an operator" apart from
  -- "operator who must complete MFA", or it can only offer a dead end.
  if not public.is_platform_admin_pending_mfa() then
    raise exception 'FAIL: is_platform_admin_pending_mfa() cannot see a real operator';
  end if;

  select count(*) into v_count from public.shop_subscriptions;
  if v_count <> 0 then
    raise exception 'FAIL: an aal1 operator read % subscription rows', v_count;
  end if;

  -- --------------------------------------------- 2. with MFA, billing state
  perform set_config('request.jwt.claims', json_build_object('sub', v_operator, 'aal', 'aal2')::text, true);
  if not public.is_platform_admin() then
    raise exception 'FAIL: an enrolled operator was refused at aal2';
  end if;

  select count(*) into v_count from public.shop_subscriptions;
  if v_count = 0 then
    raise exception 'FAIL: an aal2 operator cannot read subscriptions';
  end if;

  -- ------------------------------- 3. but never customers' business data
  -- The blast radius of a compromised operator account. If any of these ever
  -- returns rows, someone widened a policy that should have stayed narrow.
  select count(*) into v_count from public.products;
  if v_count <> 0 then raise exception 'FAIL: an operator can read % products', v_count; end if;
  select count(*) into v_count from public.sales;
  if v_count <> 0 then raise exception 'FAIL: an operator can read sales'; end if;
  select count(*) into v_count from public.customers;
  if v_count <> 0 then raise exception 'FAIL: an operator can read customers'; end if;
  select count(*) into v_count from public.expenses;
  if v_count <> 0 then raise exception 'FAIL: an operator can read expenses'; end if;
  select count(*) into v_count from public.shifts;
  if v_count <> 0 then raise exception 'FAIL: an operator can read shifts'; end if;
  select count(*) into v_count from public.shop_members;
  if v_count <> 0 then raise exception 'FAIL: an operator can read the staff roster'; end if;

  -- ...and exactly one profile beyond their own: the person who wrote to
  -- support (20260825000300). The console has to be able to say WHO is stuck,
  -- not only which shop, and answering a thread without a name or a number to
  -- call back is most of the job missing. Writing to support is what puts a
  -- profile in reach, so everyone who never has stays invisible -- if the
  -- second count below ever returns a row, that policy stopped being narrow.
  select count(*) into v_count from public.profiles where id = v_owner;
  if v_count <> 1 then
    raise exception 'FAIL: an operator cannot read the profile of a support author';
  end if;
  select count(*) into v_count from public.profiles where id = v_quiet;
  if v_count <> 0 then
    raise exception 'FAIL: an operator read the profile of someone who never wrote to support';
  end if;

  -- ------------------------------ 4. no self-service privilege escalation
  -- Every mutation must go through the platform-admin edge function, which
  -- re-checks authority and writes an audit row. A client that could update a
  -- subscription directly could grant its own shop the top tier.
  v_raised := false;
  begin
    update public.shop_subscriptions set manual_status = 'active' where shop_id = v_shop_id;
  exception when others then v_raised := true;
  end;
  if not v_raised then
    raise exception 'FAIL: an operator updated a subscription directly from a client session';
  end if;

  -- The audit log must be neither forgeable nor scrubbable.
  v_raised := false;
  begin
    insert into public.platform_audit_log (actor_user_id, action, reason) values (v_operator, 'forged', 'x');
  exception when others then v_raised := true;
  end;
  if not v_raised then raise exception 'FAIL: an operator forged an audit row'; end if;

  v_raised := false;
  begin
    delete from public.platform_audit_log;
  exception when others then v_raised := true;
  end;
  if not v_raised then raise exception 'FAIL: an operator deleted audit rows'; end if;

  -- Appointing operators is a manual SQL act on purpose: a privilege-granting
  -- endpoint is what turns one compromised operator into a permanent foothold.
  v_raised := false;
  begin
    insert into public.platform_admins (user_id, role) values (v_owner, 'owner');
  exception when others then v_raised := true;
  end;
  if not v_raised then raise exception 'FAIL: an operator appointed another operator'; end if;

  -- ------------------------------------- 5. shop owners see none of this
  perform set_config('request.jwt.claims', json_build_object('sub', v_owner, 'aal', 'aal2')::text, true);

  select count(*) into v_count from public.platform_admins;
  if v_count <> 0 then
    raise exception 'FAIL: a shop owner can enumerate our operators';
  end if;
  select count(*) into v_count from public.platform_audit_log;
  if v_count <> 0 then
    raise exception 'FAIL: a shop owner can read the platform audit log';
  end if;
  -- And still sees exactly their own shop, so the operator policies did not
  -- widen anything for ordinary users.
  select count(*) into v_count from public.shops;
  if v_count <> 1 then
    raise exception 'FAIL: a shop owner sees % shops, expected exactly their own', v_count;
  end if;

  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims', null, true);

  -- ------------------------------------ retirement invariants the guards rest on
  -- The FK is what lets the resolver skip an existence check on the successor.
  begin
    update public.plans
    set retire_at = now() + interval '30 days', successor_plan_key = 'no_such_plan'
    where key = 'free';
    raise exception 'FAIL: a successor that does not exist was accepted';
  exception when foreign_key_violation then
    null;
  end;

  -- One hop is only safe if nothing can point at itself.
  begin
    update public.plans set successor_plan_key = 'free' where key = 'free';
    raise exception 'FAIL: a plan was allowed to succeed itself';
  exception when check_violation then
    null;
  end;

  -- ------------------------------------ archive invariants the guards rest on
  -- archive_plan (active = false) exists because DELETE must stay impossible
  -- while any subscription row points at the plan. Prove the restrict actually
  -- bites: the verify shop's subscription points at `trial`, so deleting it
  -- must fail loudly rather than strip entitlements.
  begin
    delete from public.plans where key = 'trial';
    raise exception 'FAIL: deleting a plan with live subscriptions was allowed';
  exception when foreign_key_violation then
    null;
  end;

  raise notice 'ALL CHECKS PASSED';
  raise exception 'rollback_marker';
exception
  when others then
    if sqlerrm <> 'rollback_marker' then
      raise;
    end if;
end $$;

select case when count(*) = 0 then 'CLEAN: no rows left behind'
            else 'WARNING: ' || count(*) || ' verify shops remain' end as cleanup
from public.shops where name = 'Portal Verify Shop';
