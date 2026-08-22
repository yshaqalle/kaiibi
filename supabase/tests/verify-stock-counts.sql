-- A stock-take: what the count BECOMES, what is left alone, and who is allowed.
--
-- Eight groups of checks, none of which the TypeScript suite can make, because
-- every one is enforced by the database itself:
--
--   1. the count is REPLACED, not added to. This is the whole distinction from
--      receive_stock and the reason the Count door exists at all -- if these two
--      RPCs ever converge, one of them is silently wrong and no screen will say
--      which.
--   2. a count that finds MORE works the same way, and the variance is signed.
--   3. zero is a valid count and negative is refused. "The shelf was empty" is
--      a real finding; "minus three units" is not a quantity.
--   4. PRODUCTS ABSENT FROM THE COUNT ARE UNTOUCHED. A stock-take of one shelf
--      leaves the other two hundred products alone. The alternative -- treating
--      a count as authoritative for the whole store and zeroing anything not in
--      it -- would erase a shop's inventory from one afternoon's work on aisle
--      three, which is why it is asserted rather than assumed.
--   5. the RPC checks inventory.count ITSELF. A member holding inventory.edit
--      (and so able to receive a delivery) but not inventory.count is refused.
--      The sheet must not be the only thing between a cashier and a write-off.
--   6. another shop's location, and another shop's product, are both refused.
--   7. a reason is optional, and an unrecognised one is refused.
--   8. counting is gated on the `inventory` module, NOT on `multi_location`.
--      stock_transfers IS gated on multi_location because a movement needs two
--      branches; a stock-take needs one, and a one-store shop on any plan has
--      to be able to do one. stock_receipts already gets this right.
--   9. two lines for the same product in one call are refused at the table --
--      not resolved to "last line wins" -- by stock_count_items' unique
--      (count_id, product_id).
--  10. a location that has never stocked a product takes the INSERT branch of
--      the upsert, previous_quantity 0, not the UPDATE branch every other
--      check above exercises.
--
-- Everything runs inside one DO block whose EXCEPTION clause rolls it all back.

\set ON_ERROR_STOP on

do $$
declare
  v_owner_id      uuid := gen_random_uuid();
  v_counter_id    uuid := gen_random_uuid();
  v_receiver_id   uuid := gen_random_uuid();
  v_other_owner   uuid := gen_random_uuid();
  v_shop_id       uuid;
  v_location_id   uuid;
  v_second_loc    uuid;
  v_other_shop    uuid;
  v_other_loc     uuid;
  v_other_product uuid;
  v_serum         uuid;
  v_centella      uuid;
  v_sun           uuid;
  v_count_role    uuid;
  v_edit_role     uuid;
  v_standard_id   uuid;
  v_count_id      uuid;
  v_stock         integer;
  v_previous      integer;
  v_variance      integer;
  v_cost          integer;
  v_reason        text;
  v_rows          integer;
  v_raised        boolean;
  v_message       text;
begin
  -- shops.owner_id, shop_members.user_id and stock_counts.created_by all
  -- reference auth.users(id), so every fixture "person" needs a real row there
  -- before anything else.
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
    select u, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
           'verify-stock-counts-' || u || '@example.test', '', now(), now(), now()
      from unnest(array[v_owner_id, v_counter_id, v_receiver_id, v_other_owner]) u;

  insert into public.shops (owner_id, name) values (v_owner_id, 'Count Shop') returning id into v_shop_id;
  insert into public.shop_locations (shop_id, name, is_primary) values (v_shop_id, 'Jaalala Skincare', true)
    returning id into v_location_id;
  -- A second, non-primary branch, created before the products below so check
  -- 10 has somewhere to find a product the branch has never stocked. Opening
  -- stock (20260810000000) lands only at whichever location sorts first by
  -- `is_primary desc, created_at asc` -- v_location_id, not this one -- so
  -- v_second_loc never gets a product_location_stock row for any fixture
  -- product until a count creates one.
  insert into public.shop_locations (shop_id, name, is_primary) values (v_shop_id, 'Annex', false)
    returning id into v_second_loc;

  -- Opening stock lands at the primary location by trigger (20260810000000),
  -- so each of these has a product_location_stock row at v_location_id.
  insert into public.products (shop_id, name, price_cents, cost_cents, stock)
    values (v_shop_id, 'Torriden Balanceful Serum', 1200, 461, 11) returning id into v_serum;
  insert into public.products (shop_id, name, price_cents, cost_cents, stock)
    values (v_shop_id, 'SKIN1004 Madagascar Centella', 900, 461, 24) returning id into v_centella;
  insert into public.products (shop_id, name, price_cents, cost_cents, stock)
    values (v_shop_id, 'Beauty of Joseon Relief Sun', 1500, null, 12) returning id into v_sun;

  perform set_config('request.jwt.claims', json_build_object('sub', v_owner_id)::text, true);
  perform set_config('role', 'authenticated', true);

  -- 1. Eleven becomes eight. Not nineteen.
  v_count_id := public.save_stock_count(
    v_shop_id, v_location_id,
    jsonb_build_array(
      jsonb_build_object('product_id', v_serum, 'counted_quantity', 8, 'reason', 'damaged')
    ),
    'monday shelf walk'
  );

  select stock into v_stock from public.product_location_stock
    where product_id = v_serum and location_id = v_location_id;
  if not found then
    raise exception 'FIXTURE: expected a product_location_stock row for v_serum at v_location_id';
  end if;
  if v_stock <> 8 then
    raise exception 'FAIL: a count of 8 against 11 should leave 8, got % (19 means it ADDED)', v_stock;
  end if;
  select stock into v_stock from public.products where id = v_serum;
  if not found then
    raise exception 'FIXTURE: expected a products row for v_serum';
  end if;
  if v_stock <> 8 then
    raise exception 'FAIL: the products rollup should follow to 8, got %', v_stock;
  end if;

  select previous_quantity, variance, reason, unit_cost_cents
    into v_previous, v_variance, v_reason, v_cost
    from public.stock_count_items where count_id = v_count_id and product_id = v_serum;
  if not found then
    raise exception 'FIXTURE: expected a stock_count_items row for v_serum in count %', v_count_id;
  end if;
  if v_previous <> 11 then
    raise exception 'FAIL: the line should record what the app believed (11), got %', v_previous;
  end if;
  if v_variance <> -3 then
    raise exception 'FAIL: the variance should be -3, got %', v_variance;
  end if;
  if v_reason <> 'damaged' then
    raise exception 'FAIL: the reason should be recorded, got %', v_reason;
  end if;
  -- Frozen at count time from products.cost_cents. Without it a count from six
  -- months ago cannot be valued at all once a delivery has moved the cost, and
  -- "what did last quarter's shrinkage cost" is unanswerable.
  if v_cost <> 461 then
    raise exception 'FAIL: the unit cost should be frozen at 461, got %', v_cost;
  end if;

  -- 2. Twenty-four becomes twenty-six, and the variance is signed.
  v_count_id := public.save_stock_count(
    v_shop_id, v_location_id,
    jsonb_build_array(jsonb_build_object('product_id', v_centella, 'counted_quantity', 26, 'reason', null)),
    null
  );
  select stock into v_stock from public.product_location_stock
    where product_id = v_centella and location_id = v_location_id;
  if not found then
    raise exception 'FIXTURE: expected a product_location_stock row for v_centella at v_location_id';
  end if;
  if v_stock <> 26 then
    raise exception 'FAIL: a count of 26 against 24 should leave 26, got %', v_stock;
  end if;
  select variance, reason into v_variance, v_reason
    from public.stock_count_items where count_id = v_count_id and product_id = v_centella;
  if not found then
    raise exception 'FIXTURE: expected a stock_count_items row for v_centella in count %', v_count_id;
  end if;
  if v_variance <> 2 then
    raise exception 'FAIL: finding two extra should be +2, got %', v_variance;
  end if;
  -- 7a. A blank reason is stored as a blank reason. It is NOT defaulted to
  --     'miscount' -- a precise-looking answer to a question nobody asked, and
  --     the same instinct migration 20260804000000 refused when it would not
  --     backfill historical costs. The gap is the finding.
  if v_reason is not null then
    raise exception 'FAIL: a missing reason must stay missing, got %', v_reason;
  end if;

  -- 3. Zero is a real count; negative is not a quantity.
  v_count_id := public.save_stock_count(
    v_shop_id, v_location_id,
    jsonb_build_array(jsonb_build_object('product_id', v_centella, 'counted_quantity', 0, 'reason', 'theft_or_loss')),
    null
  );
  select stock into v_stock from public.product_location_stock
    where product_id = v_centella and location_id = v_location_id;
  if not found then
    raise exception 'FIXTURE: expected a product_location_stock row for v_centella at v_location_id';
  end if;
  if v_stock <> 0 then
    raise exception 'FAIL: an empty shelf counted as 0 should leave 0, got %', v_stock;
  end if;

  v_raised := false;
  v_message := null;
  begin
    perform public.save_stock_count(v_shop_id, v_location_id,
      jsonb_build_array(jsonb_build_object('product_id', v_serum, 'counted_quantity', -3, 'reason', null)),
      null);
  exception when others then
    v_raised := true;
    get stacked diagnostics v_message = message_text;
  end;
  if not v_raised then
    raise exception 'FAIL: a negative counted quantity should raise';
  end if;
  if v_message !~ 'counted quantity' then
    raise exception 'FAIL: expected the quantity guard to fire by name, got %', v_message;
  end if;

  -- 4. THE HEADLINE RULE: a count covers only the lines it contains.
  --
  --    v_sun has never appeared in any count above and must still hold 12. A
  --    regression that treated a count as authoritative for the whole store
  --    would leave it at 0 here, and nothing on any screen would say so until a
  --    shop tried to sell something it still had.
  select stock into v_stock from public.product_location_stock
    where product_id = v_sun and location_id = v_location_id;
  if not found then
    raise exception 'FIXTURE: expected a product_location_stock row for v_sun at v_location_id';
  end if;
  if v_stock <> 12 then
    raise exception 'FAIL: a product absent from every count must keep its 12, got %', v_stock;
  end if;
  select count(*) into v_rows from public.stock_count_items where product_id = v_sun;
  if v_rows <> 0 then
    raise exception 'FAIL: a product absent from every count must have no count lines, got %', v_rows;
  end if;

  -- 5. The permission is checked HERE, not on the sheet.
  perform set_config('role', 'postgres', true);
  insert into public.roles (shop_id, name, permissions)
    values (v_shop_id, 'Stock-taker', array['inventory.view', 'inventory.edit', 'inventory.count'])
    returning id into v_count_role;
  -- Exactly what a shop gets by turning the child OFF in the role editor:
  -- someone who can receive a delivery and cannot write anything off.
  insert into public.roles (shop_id, name, permissions)
    values (v_shop_id, 'Goods-in', array['inventory.view', 'inventory.edit'])
    returning id into v_edit_role;
  insert into public.shop_members (shop_id, user_id, role_id, active)
    values (v_shop_id, v_counter_id, v_count_role, true);
  insert into public.shop_members (shop_id, user_id, role_id, active)
    values (v_shop_id, v_receiver_id, v_edit_role, true);
  perform set_config('role', 'authenticated', true);

  perform set_config('request.jwt.claims', json_build_object('sub', v_receiver_id)::text, true);
  v_raised := false;
  v_message := null;
  begin
    perform public.save_stock_count(v_shop_id, v_location_id,
      jsonb_build_array(jsonb_build_object('product_id', v_sun, 'counted_quantity', 1, 'reason', null)),
      null);
  exception when others then
    v_raised := true;
    get stacked diagnostics v_message = message_text;
  end;
  if not v_raised then
    raise exception 'FAIL: inventory.edit alone must not be enough to write stock off';
  end if;
  if v_message !~ '^not authorized for shop' then
    raise exception 'FAIL: expected the permission guard to fire, got %', v_message;
  end if;
  -- And the refusal wrote nothing. A guard that raises after the count row is
  -- inserted would leave a stock-take on record that never happened.
  select stock into v_stock from public.product_location_stock
    where product_id = v_sun and location_id = v_location_id;
  if not found then
    raise exception 'FIXTURE: expected a product_location_stock row for v_sun at v_location_id';
  end if;
  if v_stock <> 12 then
    raise exception 'FAIL: a refused count must leave the shelf alone, got %', v_stock;
  end if;

  perform set_config('request.jwt.claims', json_build_object('sub', v_counter_id)::text, true);
  -- Captured, not discarded with `perform`: the uncosted-product check just
  -- below needs to name the count it is reading from, rather than guess at
  -- "the latest" one.
  v_count_id := public.save_stock_count(v_shop_id, v_location_id,
    jsonb_build_array(jsonb_build_object('product_id', v_sun, 'counted_quantity', 10, 'reason', 'expired')),
    null);
  select stock into v_stock from public.product_location_stock
    where product_id = v_sun and location_id = v_location_id;
  if not found then
    raise exception 'FIXTURE: expected a product_location_stock row for v_sun at v_location_id';
  end if;
  if v_stock <> 10 then
    raise exception 'FAIL: a member holding inventory.count should be able to count, got %', v_stock;
  end if;
  -- An uncosted product records a null unit cost rather than a zero. Zero is a
  -- real answer (a free sample), and writing it here would let the shortfall
  -- total read as complete when it is not -- the exact lie the checkbox in
  -- Task 9 hides itself rather than tell.
  --
  -- Filtered by the count just recorded, not "order by id desc limit 1": id
  -- is a gen_random_uuid() and the table carries no created_at, so ordering by
  -- id is ordering by nothing -- it looked deterministic only because exactly
  -- one stock_count_items row for v_sun existed at this point in the script.
  select unit_cost_cents into v_cost
    from public.stock_count_items where count_id = v_count_id and product_id = v_sun;
  if not found then
    raise exception 'FIXTURE: expected a stock_count_items row for v_sun in count %', v_count_id;
  end if;
  if v_cost is not null then
    raise exception 'FAIL: an uncosted product should freeze a NULL cost, got %', v_cost;
  end if;

  perform set_config('request.jwt.claims', json_build_object('sub', v_owner_id)::text, true);

  -- 6. Another shop's location, and another shop's product.
  perform set_config('role', 'postgres', true);
  insert into public.shops (owner_id, name) values (v_other_owner, 'Someone Else')
    returning id into v_other_shop;
  insert into public.shop_locations (shop_id, name, is_primary) values (v_other_shop, 'Theirs', true)
    returning id into v_other_loc;
  insert into public.products (shop_id, name, price_cents, cost_cents, stock)
    values (v_other_shop, 'Their Product', 500, null, 7) returning id into v_other_product;
  perform set_config('role', 'authenticated', true);

  v_raised := false;
  v_message := null;
  begin
    perform public.save_stock_count(v_shop_id, v_other_loc,
      jsonb_build_array(jsonb_build_object('product_id', v_serum, 'counted_quantity', 1, 'reason', null)),
      null);
  exception when others then
    v_raised := true;
    get stacked diagnostics v_message = message_text;
  end;
  if not v_raised then
    raise exception 'FAIL: counting into another shop''s location should raise';
  end if;
  if v_message !~ '^the counted location must belong to shop' then
    raise exception 'FAIL: expected the location guard to fire, got %', v_message;
  end if;

  v_raised := false;
  v_message := null;
  begin
    perform public.save_stock_count(v_shop_id, v_location_id,
      jsonb_build_array(jsonb_build_object('product_id', v_other_product, 'counted_quantity', 1, 'reason', null)),
      null);
  exception when others then
    v_raised := true;
    get stacked diagnostics v_message = message_text;
  end;
  if not v_raised then
    raise exception 'FAIL: counting another shop''s product should raise';
  end if;
  if v_message !~ '^product .* not found in this shop' then
    raise exception 'FAIL: expected the product guard to fire, got %', v_message;
  end if;
  -- Their shelf is untouched, which is what the guard is actually protecting.
  --
  -- Read as postgres, not authenticated: v_owner_id (the identity this whole
  -- do block is running as at this point) is not a member of v_other_shop, so
  -- RLS legitimately hides the row from an `authenticated` select -- and would
  -- have made this assertion structurally vacuous (v_stock always NULL,
  -- regardless of whether the guard being tested actually worked) rather than
  -- a real check of the other shop's data. This is a second, distinct way an
  -- assertion here could pass without checking anything, alongside the
  -- missing-row case the `if not found` guards elsewhere in this file exist
  -- for.
  perform set_config('role', 'postgres', true);
  select stock into v_stock from public.product_location_stock
    where product_id = v_other_product and location_id = v_other_loc;
  perform set_config('role', 'authenticated', true);
  if not found then
    raise exception 'FIXTURE: expected a product_location_stock row for v_other_product at v_other_loc';
  end if;
  if v_stock <> 7 then
    raise exception 'FAIL: another shop''s stock must not move, got %', v_stock;
  end if;

  -- 7b. An unrecognised reason is refused rather than stored as free text. The
  --     five are a closed set because the preview counts them ("9 with no
  --     reason") and a sixth spelling would quietly become a sixth category.
  v_raised := false;
  v_message := null;
  begin
    perform public.save_stock_count(v_shop_id, v_location_id,
      jsonb_build_array(jsonb_build_object('product_id', v_serum, 'counted_quantity', 5, 'reason', 'shrinkage')),
      null);
  exception when others then
    v_raised := true;
    get stacked diagnostics v_message = message_text;
  end;
  if not v_raised then
    raise exception 'FAIL: an unrecognised reason should raise';
  end if;
  -- Narrowed to the check constraint by name, the same discipline every other
  -- negative case in this file already applies: a bare `when others` would
  -- pass just as happily if 'shrinkage' failed for the wrong reason entirely
  -- (a typo'd column, a broken trigger), and the test would never know.
  if v_message !~ 'stock_count_items_reason_check' then
    raise exception 'FAIL: expected the reason check constraint to fire by name, got %', v_message;
  end if;

  -- 8. Counting is gated on `inventory`, never on `multi_location`.

  -- 8a. Structural sanity: the trigger on stock_counts does not name
  --     multi_location. Necessary but not sufficient on its own -- this alone
  --     would still pass if the gate moved inside save_stock_count(), or if the
  --     inventory gate were removed entirely. 8b and 8c are the behaviour.
  if exists (
    select 1 from pg_trigger t
      join pg_class c on c.oid = t.tgrelid
    where c.relname = 'stock_counts'
      and pg_get_triggerdef(t.oid) ilike '%multi_location%'
  ) then
    raise exception 'FAIL: stock_counts must not be gated on multi_location';
  end if;

  -- 8b. A shop on the Standard tier -- which carries `inventory` and not
  --     `multi_location` -- must still be able to do a stock-take. The fixture
  --     shop is on a fresh trial granting every module, so the scenario has to
  --     be forced rather than assumed.
  select id into v_standard_id from public.plans where key = 'standard';
  perform set_config('role', 'postgres', true);
  update public.shop_subscriptions set plan_id = v_standard_id where shop_id = v_shop_id;
  perform set_config('role', 'authenticated', true);

  if public.shop_has_module(v_shop_id, 'multi_location') then
    raise exception 'FIXTURE: the standard plan unexpectedly grants multi_location';
  end if;
  if not public.shop_has_module(v_shop_id, 'inventory') then
    raise exception 'FIXTURE: the standard plan unexpectedly lacks inventory';
  end if;

  perform public.save_stock_count(v_shop_id, v_location_id,
    jsonb_build_array(jsonb_build_object('product_id', v_serum, 'counted_quantity', 4, 'reason', null)),
    null);
  select stock into v_stock from public.product_location_stock
    where product_id = v_serum and location_id = v_location_id;
  if not found then
    raise exception 'FIXTURE: expected a product_location_stock row for v_serum at v_location_id';
  end if;
  if v_stock <> 4 then
    raise exception 'FAIL: a one-store shop without multi_location should still count, got %', v_stock;
  end if;

  -- 9. A duplicate product in one call is refused at the table, not silently
  --    resolved to "last line in the sheet wins". Arithmetically a duplicate
  --    is survivable -- the second line reads previous_quantity under the
  --    lock after the first line's write, so the two variances telescope to
  --    the same total a single line would have recorded -- but anything that
  --    COUNTS stock_count_items rows rather than summing them (the preview's
  --    "9 with no reason") is wrong by exactly one row per duplicate, and a
  --    duplicate also persists a previous_quantity nobody asked about twice.
  --    stock_count_items' `unique (count_id, product_id)` refuses it here, at
  --    the layer that cannot regress, rather than depending on a sheet that
  --    has not been written yet.
  select count(*) into v_rows from public.stock_count_items where product_id = v_centella;
  v_raised := false;
  v_message := null;
  begin
    perform public.save_stock_count(v_shop_id, v_location_id,
      jsonb_build_array(
        jsonb_build_object('product_id', v_centella, 'counted_quantity', 5, 'reason', null),
        jsonb_build_object('product_id', v_centella, 'counted_quantity', 9, 'reason', null)
      ),
      null);
  exception when others then
    v_raised := true;
    get stacked diagnostics v_message = message_text;
  end;
  if not v_raised then
    raise exception 'FAIL: two lines for the same product in one call should raise';
  end if;
  if v_message !~ 'stock_count_items_count_id_product_id_key' then
    raise exception 'FAIL: expected the (count_id, product_id) unique constraint to fire by name, got %', v_message;
  end if;
  -- And the refusal wrote nothing -- not the shelf, not either line. A
  -- partial write here (the first line's upsert landing while the second
  -- line's insert is refused) would be worse than a clean failure: it would
  -- produce exactly the "arithmetically fine, row count wrong" case the
  -- constraint exists to rule out, silently.
  select stock into v_stock from public.product_location_stock
    where product_id = v_centella and location_id = v_location_id;
  if not found then
    raise exception 'FIXTURE: expected a product_location_stock row for v_centella at v_location_id';
  end if;
  if v_stock <> 0 then
    raise exception 'FAIL: a refused duplicate count must leave the shelf alone, got %', v_stock;
  end if;
  select count(*) into v_rows from public.stock_count_items where product_id = v_centella;
  if v_rows <> 2 then
    raise exception 'FAIL: a refused duplicate count must add no new stock_count_items rows, got %', v_rows;
  end if;

  -- 10. A location that has never stocked a product takes the INSERT branch
  --     of the upsert -- coalesce(v_previous, 0), then `insert ... on
  --     conflict do update` with nothing to conflict on -- not the UPDATE
  --     branch every check above exercises. Every fixture product's opening
  --     stock lands only at the primary location (20260810000000), so
  --     v_second_loc has no product_location_stock row for v_serum until this
  --     call makes one: the documented "someone finds three on a shelf the
  --     branch has never carried" case at
  --     20260903000100_stock_counts.sql:200-211.
  select count(*) into v_rows from public.product_location_stock
    where product_id = v_serum and location_id = v_second_loc;
  if v_rows <> 0 then
    raise exception 'FIXTURE: v_second_loc should not yet stock v_serum, got % rows', v_rows;
  end if;

  v_count_id := public.save_stock_count(v_shop_id, v_second_loc,
    jsonb_build_array(jsonb_build_object('product_id', v_serum, 'counted_quantity', 3, 'reason', null)),
    null);

  select previous_quantity, variance into v_previous, v_variance
    from public.stock_count_items where count_id = v_count_id and product_id = v_serum;
  if not found then
    raise exception 'FIXTURE: expected a stock_count_items row for v_serum in count %', v_count_id;
  end if;
  if v_previous <> 0 then
    raise exception 'FAIL: a branch that never stocked this product should read a previous of 0, got %', v_previous;
  end if;
  if v_variance <> 3 then
    raise exception 'FAIL: three found where none were on record should be +3, got %', v_variance;
  end if;

  select stock into v_stock from public.product_location_stock
    where product_id = v_serum and location_id = v_second_loc;
  if not found then
    raise exception 'FAIL: the upsert''s insert branch should have created a product_location_stock row for v_serum at v_second_loc';
  end if;
  if v_stock <> 3 then
    raise exception 'FAIL: the new location''s stock should read 3, got %', v_stock;
  end if;

  -- 8c. And the inventory gate genuinely bites: a shop that has lost every
  --     module (the operator's suspend switch, same mechanism as
  --     verify-entitlements.sql's kill-switch check) is refused by name.
  perform set_config('role', 'postgres', true);
  update public.shop_subscriptions set manual_status = 'suspended' where shop_id = v_shop_id;
  perform set_config('role', 'authenticated', true);

  v_raised := false;
  v_message := null;
  begin
    perform public.save_stock_count(v_shop_id, v_location_id,
      jsonb_build_array(jsonb_build_object('product_id', v_serum, 'counted_quantity', 3, 'reason', null)),
      null);
  exception when others then
    v_raised := true;
    get stacked diagnostics v_message = message_text;
  end;
  if not v_raised then
    raise exception 'FAIL: a shop lacking the inventory module should be refused';
  end if;
  if v_message <> 'module_not_included' then
    raise exception 'FAIL: expected module_not_included, got %', v_message;
  end if;

  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims', null, true);
  raise notice 'ALL CHECKS PASSED';
  raise exception 'rollback fixture';
exception
  when others then
    perform set_config('role', 'postgres', true);
    perform set_config('request.jwt.claims', null, true);
    if sqlerrm = 'rollback fixture' then
      return;
    end if;
    raise;
end $$;
