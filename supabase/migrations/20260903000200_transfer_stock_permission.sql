-- transfer_stock() checks inventory.transfer. Until this migration it did not.
--
-- ## The gap this closes
--
-- 20260903000000 split inventory.edit into two verbs and gave both a role
-- editor row: inventory.count (write-offs) and inventory.transfer (moves
-- between branches). save_stock_count (20260903000100) was built checking
-- 'inventory.count' from day one. transfer_stock (20260810000000) was not
-- touched -- it still checks only 'inventory.edit', the permission the split
-- was supposed to retire from that door. An owner who unchecks "move between
-- stores" in the role editor has hidden the button on the client and changed
-- nothing on the server: the RPC a determined staff member can still call by
-- hand does not know the new permission exists.
--
-- ## Why this is not privilege escalation, only a labelling defect until now
--
-- inventory.transfer grants no capability inventory.edit doesn't already
-- carry. Anyone holding inventory.edit can already move stock between any two
-- of a shop's locations, one write at a time, through the
-- "write product_location_stock" RLS policy (20260810000000:73-74) --
-- decrement the source, increment the destination, both permitted by the
-- same permission transfer_stock has been checking all along. transfer_stock
-- is a convenience that does both writes atomically and leaves a paper trail;
-- it is not a wider door. So closing this gap does not take anything away
-- from anyone that inventory.edit didn't already hand them by a slower route
-- -- it makes the permission the role editor already shows real.
--
-- ## Replaces the inventory.edit check, does not join it
--
-- The client gate (src/app/(admin)/(tabs)/inventory.tsx:90) is
-- `canEdit && can('inventory.transfer')`. It reads like an AND of two
-- independent checks, which invites joining both permissions here too. That
-- is the wrong reading of what the client actually evaluates.
--
-- `can()` is not a raw lookup against roles.permissions -- it is a lookup
-- against the EXPANDED set expandPermissions() builds (src/lib/staff.ts:16),
-- and IMPLIED_PERMISSIONS (src/lib/permissions.ts:114) states
-- 'inventory.transfer': ['inventory.edit', 'inventory.view']. Any stored array
-- containing 'inventory.transfer' expands to include 'inventory.edit', so
-- `canEdit` is true in every state the client can be in whenever
-- `can('inventory.transfer')` is true. The client's AND is therefore never
-- doing independent work: it always reduces to `can('inventory.transfer')`
-- alone.
--
-- has_shop_permission() does not do this expansion -- it is a raw
-- `p_permission = any(r.permissions)` against the stored array
-- (0024_permission_gates.sql:25). So the two ways of "matching the client" are
-- not equivalent here:
--
--   * REPLACE (check 'inventory.transfer' alone): agrees with the client in
--     every reachable state, including the edge case a stored array holds
--     'inventory.transfer' without an explicit 'inventory.edit' entry (not
--     reachable through the current role editor, which always saves through
--     expandPermissions and so folds the parent in -- but not something this
--     migration should assume is impossible for all time). In that state the
--     client's `canEdit` still reads true (from the fold) and allows the
--     action; REPLACE allows it too.
--   * JOIN (check both): would REFUSE in that same edge case, because the raw
--     stored array lacks an explicit 'inventory.edit' -- while the client
--     believes the action is permitted and shows it as live. That is
--     precisely the disagreement this migration exists to prevent, just
--     pointed the other direction.
--
-- REPLACE is also the same shape save_stock_count already committed to for
-- the identically-structured client gate `canEdit && can('inventory.count')`
-- (20260903000100: "'inventory.count', not 'inventory.edit'... the database
-- is meant to read the child string on its own", per the comment on
-- inventory.count's `parent` field in src/lib/permissions.ts:42-47). Nothing
-- about transfer's situation argues for treating it differently: if anything
-- the "no privilege escalation" fact above makes REPLACE safer here than it
-- is for Count, since Count really is a narrower, more dangerous door and
-- transfer only relabels one inventory.edit already held.
--
-- ## The ordering hazard this creates -- READ BEFORE DEPLOYING
--
-- Before this migration, an admin who opens and saves a role on an OLD client
-- bundle that predates inventory.transfer (one whose ALL_PERMISSIONS/
-- PERMISSIONS catalog does not list it) is harmless: expandPermissions on
-- that bundle drops the unrecognised string, roles.permissions loses
-- 'inventory.transfer', and nothing server-side reads that string, so nobody
-- notices.
--
-- AFTER this migration, the same save LOCKS THAT SHOP OUT OF MOVING STOCK
-- BETWEEN BRANCHES until 'inventory.transfer' is restored to the role, because
-- transfer_stock now refuses without it. This migration must not ship ahead
-- of every client bundle that can write to roles.permissions knowing about
-- 'inventory.transfer' -- otherwise the very first old-bundle role save after
-- deploy silently disables Move for that shop, with a refusal that gives no
-- hint the permission used to be there.
--
-- ## Why this is safe to enable today
--
-- 20260903000000's backfill already ran `update public.roles set permissions
-- = permissions || array['inventory.count', 'inventory.transfer'] where
-- permissions @> array['inventory.edit'] and not permissions &&
-- array['inventory.count', 'inventory.transfer']`, and re-created
-- default_shop_roles() so every shop opened since then seeds Manager and
-- Owner with 'inventory.transfer' too. Every role that could call
-- transfer_stock before this migration already holds 'inventory.transfer'
-- today. Turning the check on locks out nobody who isn't first hit by the
-- ordering hazard above.
--
-- Reproduced verbatim from public.transfer_stock() as defined in
-- 20260810000000_stock_by_location.sql, with exactly one change: the
-- permission check, now first, checks 'inventory.transfer' instead of
-- 'inventory.edit'. Its module gating (multi_location, via the
-- stock_transfers_module trigger), its row locking, its arithmetic and every
-- one of its error messages are untouched.

create or replace function public.transfer_stock(
  p_shop_id uuid,
  p_from_location_id uuid,
  p_to_location_id uuid,
  p_items jsonb,
  p_note text default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_transfer_id uuid;
  v_item jsonb;
  v_product public.products%rowtype;
  v_qty integer;
  v_available integer;
  v_moved integer := 0;
begin
  if not public.has_shop_permission(p_shop_id, 'inventory.transfer') then
    raise exception 'not authorized for shop %', p_shop_id;
  end if;
  if p_from_location_id = p_to_location_id then
    raise exception 'cannot transfer stock to the same location';
  end if;
  if not exists (select 1 from public.shop_locations where id = p_from_location_id and shop_id = p_shop_id)
     or not exists (select 1 from public.shop_locations where id = p_to_location_id and shop_id = p_shop_id) then
    raise exception 'both locations must belong to shop %', p_shop_id;
  end if;
  if p_items is null or jsonb_array_length(p_items) = 0 then
    raise exception 'a transfer must include at least one item';
  end if;

  insert into public.stock_transfers (shop_id, from_location_id, to_location_id, note, created_by)
    values (p_shop_id, p_from_location_id, p_to_location_id, nullif(p_note, ''), auth.uid())
    returning id into v_transfer_id;

  -- Ordered by product id so two concurrent transfers touching the same pair of
  -- products always take their row locks in the same order and cannot deadlock
  -- against each other -- the same reason refund_sale_items orders its loop.
  for v_item in select value from jsonb_array_elements(p_items) as t(value) order by (value->>'product_id') loop
    v_qty := (v_item->>'quantity')::integer;
    if v_qty is null or v_qty <= 0 then
      raise exception 'invalid transfer quantity';
    end if;

    select * into v_product from public.products
      where id = (v_item->>'product_id')::uuid and shop_id = p_shop_id;
    if v_product.id is null then
      raise exception 'product % not found in this shop', v_item->>'product_id';
    end if;

    select stock into v_available from public.product_location_stock
      where product_id = v_product.id and location_id = p_from_location_id
      for update;

    if coalesce(v_available, 0) < v_qty then
      raise exception 'insufficient stock for % at the source location: has %, need %',
        v_product.name, coalesce(v_available, 0), v_qty;
    end if;

    update public.product_location_stock set stock = stock - v_qty, updated_at = now()
      where product_id = v_product.id and location_id = p_from_location_id;

    insert into public.product_location_stock (product_id, location_id, stock)
      values (v_product.id, p_to_location_id, v_qty)
      on conflict (product_id, location_id)
      do update set stock = public.product_location_stock.stock + excluded.stock, updated_at = now();

    insert into public.stock_transfer_items (transfer_id, product_id, product_name, quantity)
      values (v_transfer_id, v_product.id, v_product.name, v_qty);

    v_moved := v_moved + v_qty;
  end loop;

  if v_moved = 0 then
    raise exception 'cannot record a transfer that moves nothing';
  end if;
  return v_transfer_id;
end;
$$;
