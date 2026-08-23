-- Splitting inventory.edit, and letting shrinkage be an expense.
--
-- Five things are asserted, and none of them can be checked from TypeScript
-- because all five are facts about rows and constraints in this database:
--
--   1. every role that already held inventory.edit gained BOTH new
--      permissions. This is the one that decides whether a shop's staff lose
--      access on the morning this ships. The permission catalogue in
--      src/lib/permissions.ts is only what the client offers; roles.permissions
--      is what has_shop_permission actually reads.
--   2. a role that did NOT hold inventory.edit gained nothing. A backfill that
--      granted write-off to a Cashier would be worse than no backfill.
--   3. the SEEDED Manager holds both verbs on a shop created after this
--      migration, and the seeded Cashier holds neither. Stated out loud rather
--      than left to be discovered: Manager holds inventory.edit, so the
--      backfill hands it write-off on day one, and default_shop_roles() has to
--      hand the same thing to shops that do not exist yet or old and new shops
--      disagree about what "Manager" means.
--   4. has_shop_permission resolves the new strings for a member, and the shop
--      OWNER holds them implicitly regardless of what their own Owner role
--      says -- the owner_id short-circuit in user_has_shop_permission, not
--      membership. (Since 20260823000000 the owner does have a shop_members
--      row, so this is no longer "no row is written for them"; it is that the
--      row is not what grants the permission.)
--   5. stock_loss is accepted by every table that stores a category, and a
--      bogus category is still refused. The four are widened together because
--      EXPENSE_CATEGORIES is one list shared by the expense editor, the
--      recurring-bill modal, the invoice editor and the budget picker: adding
--      the category to the list while leaving a constraint behind would give a
--      raw Postgres error the first time someone picked it on a bill.
--
-- Everything runs inside one DO block whose EXCEPTION clause rolls it all back.

\set ON_ERROR_STOP on

do $$
declare
  v_owner_id    uuid := gen_random_uuid();
  v_staff_id    uuid := gen_random_uuid();
  v_shop_id     uuid;
  v_editor_role uuid;
  v_cashier_role uuid;
  v_perms       text[];
  v_raised      boolean;
begin
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
    select u, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
           'verify-inventory-permissions-' || u || '@example.test', '', now(), now(), now()
      from unnest(array[v_owner_id, v_staff_id]) u;

  insert into public.shops (owner_id, name) values (v_owner_id, 'Permissions Shop') returning id into v_shop_id;

  -- 3. The seeded roles, read BEFORE the backfill statement is replayed below
  -- -- otherwise the replay would grant the verbs itself and this would pass
  -- against a default_shop_roles() that never learned about them.
  select permissions into v_perms from public.roles where shop_id = v_shop_id and name = 'Manager';
  if v_perms is null then
    raise exception 'FAIL: no seeded Manager role found for the fixture shop';
  end if;
  if not v_perms @> array['inventory.count', 'inventory.transfer'] then
    raise exception 'FAIL: a newly seeded Manager should hold both verbs, as the backfill gives every existing Manager, got %', v_perms;
  end if;
  select permissions into v_perms from public.roles where shop_id = v_shop_id and name = 'Cashier';
  if v_perms is null then
    raise exception 'FAIL: no seeded Cashier role found for the fixture shop';
  end if;
  if v_perms && array['inventory.count', 'inventory.transfer'] then
    raise exception 'FAIL: the seeded Cashier must hold neither verb, got %', v_perms;
  end if;

  -- The two roles below are written as they would have looked BEFORE this
  -- migration, and then the migration's own backfill statement is replayed
  -- against them -- which is what makes this a test of the statement rather
  -- than of the seed data.
  insert into public.roles (shop_id, name, permissions)
    values (v_shop_id, 'Stockroom', array['pos.access', 'inventory.view', 'inventory.edit'])
    returning id into v_editor_role;
  insert into public.roles (shop_id, name, permissions)
    values (v_shop_id, 'Till', array['pos.access', 'inventory.view'])
    returning id into v_cashier_role;

  update public.roles
    set permissions = permissions || array['inventory.count', 'inventory.transfer']
    where shop_id = v_shop_id
      and permissions @> array['inventory.edit']
      and not permissions && array['inventory.count', 'inventory.transfer'];

  -- 1. The role that could already change stock keeps being able to.
  select permissions into v_perms from public.roles where id = v_editor_role;
  if not v_perms @> array['inventory.count', 'inventory.transfer'] then
    raise exception 'FAIL: a role holding inventory.edit should have gained both verbs, got %', v_perms;
  end if;

  -- 2. And the one that could not, still cannot.
  select permissions into v_perms from public.roles where id = v_cashier_role;
  if v_perms && array['inventory.count', 'inventory.transfer'] then
    raise exception 'FAIL: a role without inventory.edit must gain nothing, got %', v_perms;
  end if;

  -- Idempotency is a binding constraint on this backfill, not a nicety -- a
  -- migration can be re-applied (a rolled-back deploy retried, a fresh
  -- environment rebuilt from the chain twice), and re-running it must not
  -- re-append or otherwise disturb permissions a shop already has. Replayed
  -- here a second time, against the same row check 1 already confirmed
  -- gained both verbs, and the array must come back byte-for-byte identical --
  -- proof that belongs in the repo, not only in a throwaway fixture in a
  -- report.
  select permissions into v_perms from public.roles where id = v_editor_role;
  update public.roles
    set permissions = permissions || array['inventory.count', 'inventory.transfer']
    where shop_id = v_shop_id
      and permissions @> array['inventory.edit']
      and not permissions && array['inventory.count', 'inventory.transfer'];
  if (select permissions from public.roles where id = v_editor_role) is distinct from v_perms then
    raise exception 'FAIL: replaying the backfill must be a no-op, got %', (select permissions from public.roles where id = v_editor_role);
  end if;

  -- 4. The resolver reads them, for a member and for the owner.
  insert into public.shop_members (shop_id, user_id, role_id, active)
    values (v_shop_id, v_staff_id, v_editor_role, true);

  if not public.user_has_shop_permission(v_staff_id, v_shop_id, 'inventory.count') then
    raise exception 'FAIL: the stockroom member should resolve inventory.count';
  end if;
  -- Since 20260823000000 the owner DOES have a shop_members row, pointing at
  -- the Owner role -- and this migration's own backfill grants that role both
  -- new verbs, so simply calling user_has_shop_permission for the owner would
  -- pass through the MEMBERSHIP branch too and prove nothing about the
  -- owner_id short-circuit (0024_permission_gates.sql:20-26) this check claims
  -- to test. Isolated by first pointing the owner's own membership at a role
  -- that holds neither verb -- protect_owner_membership allows changing the
  -- owner's role ("it is a label; nothing reads it to decide what they may
  -- do"), so a pass below can only come from the owner_id branch.
  update public.shop_members set role_id = v_cashier_role
    where shop_id = v_shop_id and user_id = v_owner_id;
  if not public.user_has_shop_permission(v_owner_id, v_shop_id, 'inventory.count') then
    raise exception 'FAIL: the owner should hold inventory.count implicitly, via shops.owner_id, regardless of their own membership role';
  end if;

  -- 5. stock_loss is storable everywhere a category is stored.
  insert into public.expenses (shop_id, occurred_on, amount_cents, category)
    values (v_shop_id, current_date, 1383, 'stock_loss');
  insert into public.budgets (shop_id, category, limit_cents)
    values (v_shop_id, 'stock_loss', 50000);
  insert into public.recurring_bills (shop_id, name, category, frequency, amount_cents, next_due_date)
    values (v_shop_id, 'Shrinkage allowance', 'stock_loss', 'monthly', 5000, current_date);
  insert into public.invoices (shop_id, invoice_number, category, due_on, amount_cents)
    values (v_shop_id, 'SL-1', 'stock_loss', current_date, 1000);

  -- And the constraint is still a constraint. Narrowed to check_violation --
  -- `when others` would count a NOT NULL violation or a typo'd column name as
  -- the category check firing, which is not what this line is meant to prove.
  v_raised := false;
  begin
    insert into public.expenses (shop_id, occurred_on, amount_cents, category)
      values (v_shop_id, current_date, 100, 'shrinkage');
  exception when check_violation then v_raised := true;
  end;
  if not v_raised then
    raise exception 'FAIL: widening the category list must not have removed the check';
  end if;

  raise notice 'ALL CHECKS PASSED';
  raise exception 'rollback fixture';
exception
  when others then
    if sqlerrm = 'rollback fixture' then
      return;
    end if;
    raise;
end $$;
