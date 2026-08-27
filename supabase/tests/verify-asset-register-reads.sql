-- The two functions the Fixed Assets screen reads, and the one lie it must not tell.
--
-- 20261007000000 added list_fixed_assets() and fixed_asset_summary(); this file
-- is what stops them becoming a second, quietly different account of what the
-- shop owns. In the order the failures would matter:
--
--   * THE TOTAL BOOK VALUE EQUALS THE BALANCE SHEET. Both are 1500-1599 less
--     1590 by different routes -- one over the register, one over the ledger --
--     and if they ever disagree, the screen and the statements are telling a
--     shop two different things about the same fridge. Every figure here is
--     NON-ZERO on both sides, because 0 = 0 is how the sibling defect in
--     cash_flow's investing section survived a whole phase.
--   * A DISPOSED ASSET HAS NO BOOK VALUE, not a book value of zero, and its
--     cost is still a fact. Getting that backwards puts a confident number on a
--     row describing something the shop sold, and drags every total off the
--     balance sheet with it.
--   * A VOIDED ACQUISITION IS VISIBLE. reverse_journal_entry is a generic door
--     that can void an asset's purchase entry while the register row survives
--     (measured against tasks 2-3, out of scope to fix). Check 6 makes the
--     divergence show up in `voided_count` and pins the size of it: the register
--     and the balance sheet then differ BY EXACTLY the voided cost, which is the
--     assertion that would catch the screen quietly hiding it.
--   * THE INVESTING LINE SAYS WHAT IT IS. Check 5 pins the label
--     20261007000100 changed, and asserts the figure it carries is NEITHER what
--     was paid for equipment NOR what was paid net of proceeds -- which is the
--     whole reason 'Bought equipment' had to go, and which a fixture has to be
--     built deliberately to show. Sell a FULLY depreciated asset and investing
--     comes out at exactly the cost of everything bought; sell one whose loss
--     happens to equal a credit purchase and it comes out at exactly the cash.
--     Both were live in earlier drafts of this fixture and both would have let
--     the old label pass.
--
-- ## The fixture
--
-- Fixed calendar months in 2026, never offsets from today: everything here is
-- about which MONTH a date falls in, and a fixture dated relative to now() has
-- made two dates coincide on this project before.
--
--   Shop A, "Register Shop"
--     2026-01-02  Cr 3000 100000  capital, in cash
--     2026-01-05  Freezer  24000  life 12  from 1000  -> 2000 a month
--     2026-01-20  Printer   5000  life 10  from 1000  ->  500 a month
--     2026-02-10  Shelving  1000  life 3   from 1000, in 1510 -> 333/333/334
--     depreciate through April; sell the PRINTER in May at a loss; then void
--     the shelving's purchase through the generic ledger door.
--
--   Shop B, "The Other Register Shop" -- the tenant boundary. Its one asset
--   costs a figure no total in shop A can be confused with.
--
-- The printer is sold PART-depreciated on purpose: it has a book value to
-- remove, which is what makes the investing line differ from both the money
-- paid and the money paid net of proceeds. The shelving's cost does not divide
-- by its life, so the remainder month is exercised. The freezer is the one thing
-- still standing at the end, so no total here is zero.

\set ON_ERROR_STOP on

do $$
declare
  v_owner    uuid := gen_random_uuid();
  v_other    uuid := gen_random_uuid();
  v_viewer   uuid := gen_random_uuid();   -- ledger.view
  v_blind    uuid := gen_random_uuid();   -- a member with NO ledger.view
  v_shop     uuid;
  v_loc      uuid;
  v_shop_b   uuid;
  v_loc_b    uuid;
  v_view_role uuid;
  v_blind_role uuid;

  v_freezer  uuid;
  v_printer  uuid;
  v_shelving uuid;

  v_row      record;
  v_sum      record;
  v_bs       bigint;
  v_n        integer;
  v_label    text;
  v_amount   bigint;
  v_raised   boolean;
  v_message  text;
begin
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
    select u, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
           'verify-asset-register-reads-' || u || '@example.test', '', now(), now(), now()
      from unnest(array[v_owner, v_other, v_viewer, v_blind]) u;

  insert into public.shops (owner_id, name) values (v_owner, 'Register Shop') returning id into v_shop;
  insert into public.shop_locations (shop_id, name, is_primary) values (v_shop, 'Main', true)
    returning id into v_loc;
  insert into public.shops (owner_id, name) values (v_other, 'The Other Register Shop')
    returning id into v_shop_b;
  insert into public.shop_locations (shop_id, name, is_primary) values (v_shop_b, 'Main', true)
    returning id into v_loc_b;

  -- Shop B renames the account shop A holds its shelving in. list_fixed_assets
  -- reports account_name, and security definer bypasses RLS on `accounts`, so
  -- an unfiltered join collects every shop's row at that code -- and this name
  -- sorts after 'Furniture and Fittings' precisely so it would win. Check 4
  -- asserts shop A's register says shop A's word for it.
  update public.accounts set name = 'Shop B''s shelving, and only shop B''s'
   where shop_id = v_shop_b and code = '1510';

  insert into public.roles (shop_id, name, permissions)
    values (v_shop, 'Bookkeeper', array['ledger.view'])
    returning id into v_view_role;
  insert into public.shop_members (shop_id, user_id, role_id, active)
    values (v_shop, v_viewer, v_view_role, true);

  -- A member of the same shop who may see SALES and not the books -- the
  -- default Manager's shape (20260904000000), and the reader phase 3a shipped a
  -- Critical for by leaving on a permanent "Loading…".
  insert into public.roles (shop_id, name, permissions)
    values (v_shop, 'Floor', array['sales.view'])
    returning id into v_blind_role;
  insert into public.shop_members (shop_id, user_id, role_id, active)
    values (v_shop, v_blind, v_blind_role, true);

  perform set_config('request.jwt.claims', json_build_object('sub', v_owner)::text, true);
  perform set_config('role', 'authenticated', true);

  perform public.post_journal_entry(v_shop, '2026-01-02', 'Owner capital, in cash',
    jsonb_build_array(jsonb_build_object('code', '1000', 'amount_cents',  100000),
                      jsonb_build_object('code', '3000', 'amount_cents', -100000)),
    v_loc, 'opening');

  v_freezer  := public.create_fixed_asset(v_shop, 'Chest freezer', 24000, '2026-01-05', 12, '1000');
  v_printer  := public.create_fixed_asset(v_shop, 'Printer',        5000, '2026-01-20', 10, '1000');
  v_shelving := public.create_fixed_asset(v_shop, 'Shelving',       1000, '2026-02-10', 3, '1000', '1510');

  perform set_config('request.jwt.claims', json_build_object('sub', v_other)::text, true);
  perform public.create_fixed_asset(v_shop_b, 'Shop B display case', 7777, '2026-03-01', 5, null, '1510');
  --    ...AND SHOP B DEPRECIATES IT FURTHER INTO THE YEAR THAN SHOP A EVER
  --    GOES. Shop A stops at April; this puts shop B's newest charge in July.
  --    fixed_asset_summary reads depreciation_charges directly for
  --    last_charge_month -- the one query in that function that does not go
  --    through list_fixed_assets and so does not inherit its shop filter -- and
  --    without charges on the far side of the boundary, dropping `where
  --    c.shop_id = p_shop_id` changed no figure this file asserts. Measured:
  --    that mutation survived the whole suite. Now shop A's "last charge
  --    posted" would read July of another shop's money.
  perform public.run_depreciation(v_shop_b, '2026-08-31');
  perform set_config('request.jwt.claims', json_build_object('sub', v_owner)::text, true);

  -- =====================================================================
  -- 1. BEFORE ANY DEPRECIATION: cost is the cost, accumulated is zero, and
  --    book value is the cost. Three rows, newest purchase first.
  -- =====================================================================
  select count(*) into v_n from public.list_fixed_assets(v_shop);
  if v_n is distinct from 3 then
    raise exception 'FAIL 1: the register returned % rows, expected 3', v_n;
  end if;

  select * into v_row from public.list_fixed_assets(v_shop) r where r.id = v_printer;
  if v_row.cost_cents is distinct from 5000 then
    raise exception 'FAIL 1: the printer cost reads %, expected 5000', v_row.cost_cents;
  end if;
  if v_row.accumulated_cents is distinct from 0 then
    raise exception 'FAIL 1: an undepreciated asset reads % accumulated, expected 0', v_row.accumulated_cents;
  end if;
  if v_row.net_book_cents is distinct from 5000 then
    raise exception 'FAIL 1: an undepreciated asset''s book value reads %, expected its cost 5000', v_row.net_book_cents;
  end if;
  if v_row.acquisition_status is distinct from 'posted' then
    raise exception 'FAIL 1: a freshly bought asset''s acquisition reads "%", expected posted', v_row.acquisition_status;
  end if;

  --    ORDER: live assets, newest purchase first. The shelving (10 Feb) is the
  --    newest of the three, and a screen that renders the rows in the order they
  --    arrive is relying on it.
  select r.name into v_label
    from public.list_fixed_assets(v_shop) with ordinality r where r.ordinality = 1;
  if v_label is distinct from 'Shelving' then
    raise exception 'FAIL 1: the register opens with "%", expected the newest purchase', v_label;
  end if;
  raise notice '1 OK: cost, nothing accumulated, book value at cost, newest purchase first';

  -- =====================================================================
  -- 2. AFTER FOUR MONTHS: accumulated depreciation is summed from THIS
  --    asset's charge rows, and the book value is what is left. Every
  --    figure pinned to the cent, including the one whose cost does not
  --    divide by its life.
  -- =====================================================================
  perform public.run_depreciation(v_shop, '2026-04-30');

  select * into v_row from public.list_fixed_assets(v_shop) r where r.id = v_freezer;
  if v_row.accumulated_cents is distinct from 8000 or v_row.net_book_cents is distinct from 16000 then
    raise exception 'FAIL 2: the freezer reads % accumulated and % book value, expected 8000 and 16000 after four of twelve months',
      v_row.accumulated_cents, v_row.net_book_cents;
  end if;
  if v_row.months_charged is distinct from 4 then
    raise exception 'FAIL 2: the freezer has been charged % months, expected 4', v_row.months_charged;
  end if;

  select * into v_row from public.list_fixed_assets(v_shop) r where r.id = v_printer;
  if v_row.accumulated_cents is distinct from 2000 or v_row.net_book_cents is distinct from 3000 then
    raise exception 'FAIL 2: the printer reads % accumulated and % book value, expected 2000 and 3000',
      v_row.accumulated_cents, v_row.net_book_cents;
  end if;

  --    333 + 333 + 334. The last month of a life carries the remainder, so an
  --    asset whose cost does not divide by its life still reaches exactly zero.
  select * into v_row from public.list_fixed_assets(v_shop) r where r.id = v_shelving;
  if v_row.accumulated_cents is distinct from 1000 or v_row.net_book_cents is distinct from 0 then
    raise exception 'FAIL 2: the shelving reads % accumulated and % book value, expected 1000 and 0 -- the remainder month is missing',
      v_row.accumulated_cents, v_row.net_book_cents;
  end if;

  --    THE SUMMARY, AND IT TIES TO THE BALANCE SHEET. Both sides non-zero.
  select * into v_sum from public.fixed_asset_summary(v_shop);
  if v_sum.live_count is distinct from 3 or v_sum.disposed_count is distinct from 0 then
    raise exception 'FAIL 2: the summary counts % live and % disposed, expected 3 and 0',
      v_sum.live_count, v_sum.disposed_count;
  end if;
  if v_sum.cost_cents is distinct from 30000 then
    raise exception 'FAIL 2: assets at cost read %, expected 30000', v_sum.cost_cents;
  end if;
  if v_sum.accumulated_cents is distinct from 11000 then
    raise exception 'FAIL 2: depreciated so far reads %, expected 11000', v_sum.accumulated_cents;
  end if;
  if v_sum.net_book_cents is distinct from 19000 then
    raise exception 'FAIL 2: total book value reads %, expected 19000', v_sum.net_book_cents;
  end if;
  --    The last charge POSTED, not a prediction of the next one: April is
  --    2000 + 500 + 334, the shelving's remainder month.
  if v_sum.last_charge_month is distinct from '2026-04-01'::date or v_sum.last_charge_cents is distinct from 2834 then
    raise exception 'FAIL 2: the last charge reads % of %, expected 2026-04-01 of 2834',
      v_sum.last_charge_month, v_sum.last_charge_cents;
  end if;

  select s.amount_cents into v_bs
    from public.balance_sheet(v_shop, '2026-12-31') s
   where s.section = 'fixed_assets' and s.is_total;
  if v_bs is null then
    raise exception 'FAIL 2: the balance sheet has no fixed-asset total -- this check has stopped checking anything';
  end if;
  if v_bs is distinct from v_sum.net_book_cents then
    raise exception 'FAIL 2: the register says the shop''s equipment is worth % and the balance sheet says % -- two answers to one question',
      v_sum.net_book_cents, v_bs;
  end if;
  raise notice '2 OK: accumulated is summed per asset, the remainder month lands, and the register total equals the balance sheet';

  -- =====================================================================
  -- 3. A DISPOSED ASSET HAS NO BOOK VALUE -- null, not zero -- and its cost
  --    and depreciation are still reported as facts. The totals drop it, so
  --    they still tie to a balance sheet the asset has left.
  -- =====================================================================
  perform public.dispose_fixed_asset(v_printer, '2026-05-10', 2000, '1000');

  select * into v_row from public.list_fixed_assets(v_shop) r where r.id = v_printer;
  if v_row.id is null then
    raise exception 'FAIL 3: the disposed asset vanished from the register -- it is history, not a mistake';
  end if;
  if v_row.net_book_cents is not null then
    raise exception 'FAIL 3: a disposed asset reads a book value of % -- it is off the balance sheet, so it has none',
      v_row.net_book_cents;
  end if;
  if v_row.cost_cents is distinct from 5000 or v_row.accumulated_cents is distinct from 2000 then
    raise exception 'FAIL 3: the disposed asset reads % at cost and % depreciated, expected 5000 and 2000 -- both are still facts',
      v_row.cost_cents, v_row.accumulated_cents;
  end if;
  if v_row.disposed_on is distinct from '2026-05-10'::date or v_row.disposal_proceeds_cents is distinct from 2000 then
    raise exception 'FAIL 3: the disposal reads % for %, expected 2026-05-10 for 2000',
      v_row.disposed_on, v_row.disposal_proceeds_cents;
  end if;

  --    ...and it is LAST, after every live asset.
  select r.name into v_label
    from public.list_fixed_assets(v_shop) with ordinality r
   order by r.ordinality desc limit 1;
  if v_label is distinct from 'Printer' then
    raise exception 'FAIL 3: the last row of the register is "%", expected the disposed asset', v_label;
  end if;

  select * into v_sum from public.fixed_asset_summary(v_shop);
  if v_sum.live_count is distinct from 2 or v_sum.disposed_count is distinct from 1 then
    raise exception 'FAIL 3: the summary counts % live and % disposed, expected 2 and 1',
      v_sum.live_count, v_sum.disposed_count;
  end if;
  if v_sum.cost_cents is distinct from 25000 or v_sum.accumulated_cents is distinct from 9000 then
    raise exception 'FAIL 3: the totals read % at cost and % depreciated, expected 25000 and 9000 -- a sold asset is in neither',
      v_sum.cost_cents, v_sum.accumulated_cents;
  end if;
  if v_sum.net_book_cents is distinct from 16000 then
    raise exception 'FAIL 3: total book value reads %, expected 16000', v_sum.net_book_cents;
  end if;

  select s.amount_cents into v_bs
    from public.balance_sheet(v_shop, '2026-12-31') s
   where s.section = 'fixed_assets' and s.is_total;
  if v_bs is distinct from v_sum.net_book_cents then
    raise exception 'FAIL 3: after a disposal the register says % and the balance sheet says %',
      v_sum.net_book_cents, v_bs;
  end if;
  raise notice '3 OK: a disposed asset keeps its cost, loses its book value, leaves the totals, and the totals still tie';

  -- =====================================================================
  -- 4. NEITHER SHOP'S REGISTER REACHES THE OTHER, and the account name comes
  --    from the reader's own chart. Both functions are security definer, so
  --    the shop filter inside them is the whole of the boundary.
  -- =====================================================================
  if exists (select 1 from public.list_fixed_assets(v_shop) r where r.name = 'Shop B display case') then
    raise exception 'FAIL 4: shop B''s asset is in shop A''s register';
  end if;
  select * into v_row from public.list_fixed_assets(v_shop) r where r.id = v_shelving;
  if v_row.account_name is distinct from 'Furniture and Fittings' then
    raise exception 'FAIL 4: shop A''s shelving sits in an account it calls "%" -- the name came from another shop''s chart',
      v_row.account_name;
  end if;

  v_raised := false;
  begin
    perform 1 from public.list_fixed_assets(v_shop_b);
  exception when others then
    v_raised := true; v_message := sqlerrm;
  end;
  if not v_raised then
    raise exception 'FAIL 4: shop A''s owner read shop B''s register';
  end if;
  if v_message is distinct from 'You do not have permission to see the books.' then
    raise exception 'FAIL 4: the refusal reads "%", expected the statements'' own sentence', v_message;
  end if;

  --    AND THE READ RAISES for a member of the shop who holds no ledger.view.
  --    A zero is a claim, and phase 3a shipped a Critical where an ungated card
  --    over a raising RPC left this exact reader on "Loading…" forever.
  perform set_config('request.jwt.claims', json_build_object('sub', v_blind)::text, true);
  v_raised := false;
  begin
    perform 1 from public.fixed_asset_summary(v_shop);
  exception when others then
    v_raised := true; v_message := sqlerrm;
  end;
  if not v_raised then
    raise exception 'FAIL 4: a member with sales.view and no ledger.view read the asset summary';
  end if;
  if v_message is distinct from 'You do not have permission to see the books.' then
    raise exception 'FAIL 4: the summary refused with "%", expected the statements'' own sentence', v_message;
  end if;

  --    ...and ledger.view alone is enough to read it, which is what makes the
  --    screen a bookkeeper's and not only an owner's.
  perform set_config('request.jwt.claims', json_build_object('sub', v_viewer)::text, true);
  select count(*) into v_n from public.list_fixed_assets(v_shop);
  if v_n is distinct from 3 then
    raise exception 'FAIL 4: a ledger.view holder read % rows of the register, expected 3', v_n;
  end if;
  perform set_config('request.jwt.claims', json_build_object('sub', v_owner)::text, true);
  raise notice '4 OK: one shop''s register, in that shop''s words, on ledger.view, raising without it';

  -- =====================================================================
  -- 5. THE INVESTING LINE SAYS WHAT IT IS.
  --
  --    Over the whole of 2026 shop A paid 30000 for equipment and received
  --    2000 for a piece of it, and the row reads NEITHER -30000 nor -28000.
  --    It is the carrying amount in less the carrying amount out:
  --    -(30000 - 3000) = -27000. That is why it can no longer be called
  --    "Bought equipment", and the two exclusions are what make this check
  --    a check -- see this file's header for the two fixtures where the old
  --    label would have come out right by accident.
  -- =====================================================================
  select c.label, c.amount_cents into v_label, v_amount
    from public.cash_flow(v_shop, '2026-01-01', '2026-12-31') c
   where c.section = 'investing' and c.sort_order = 310;

  if v_label is distinct from 'Equipment bought, less equipment sold' then
    raise exception 'FAIL 5: the investing line is labelled "%"', v_label;
  end if;
  if v_amount is distinct from -27000 then
    raise exception 'FAIL 5: the investing line reads %, expected -27000 -- the carrying amount bought less the carrying amount sold',
      v_amount;
  end if;
  if v_amount = -30000 then
    raise exception 'FAIL 5: the investing line equals what was PAID for equipment, so "Bought equipment" would have been honest and this fixture proves nothing';
  end if;
  if v_amount = -28000 then
    raise exception 'FAIL 5: the investing line equals the CASH spent on equipment net of proceeds, and this fixture proves nothing';
  end if;

  --    The proof still ties, which is the only thing that makes any of the
  --    above a statement rather than a plausible list.
  if (select amount_cents from public.cash_flow(v_shop, '2026-01-01', '2026-12-31') where section = 'net_change')
     is distinct from (select amount_cents from public.cash_flow(v_shop, '2026-01-01', '2026-12-31')
                        where section = 'proof' and label like 'Movement in cash%') then
    raise exception 'FAIL 5: the cash flow does not prove out -- net change % against observed movement %',
      (select amount_cents from public.cash_flow(v_shop, '2026-01-01', '2026-12-31') where section = 'net_change'),
      (select amount_cents from public.cash_flow(v_shop, '2026-01-01', '2026-12-31')
        where section = 'proof' and label like 'Movement in cash%');
  end if;
  raise notice '5 OK: the investing line names both halves, reads neither the money paid nor the money net, and still proves out';

  -- =====================================================================
  -- 6. A VOIDED ACQUISITION IS VISIBLE, AND THE SIZE OF THE DIVERGENCE IS
  --    EXACTLY THE VOIDED COST.
  --
  --    reverse_journal_entry takes any entry id and knows nothing about the
  --    register, so voiding a purchase leaves the asset in the register and
  --    takes its cost out of 1500-1599 -- while its accumulated depreciation
  --    stays in 1590. The register and the balance sheet then differ by the
  --    cost of every asset in that state, and the screen has a `wrong` caveat
  --    to gate on rather than a total nobody can explain.
  -- =====================================================================
  perform public.reverse_journal_entry(
    (select fa.journal_entry_id from public.fixed_assets fa where fa.id = v_shelving),
    'Bought on the wrong account');

  select * into v_row from public.list_fixed_assets(v_shop) r where r.id = v_shelving;
  if v_row.id is null then
    raise exception 'FAIL 6: voiding the purchase removed the register row -- reverse_journal_entry does not touch this table';
  end if;
  if v_row.acquisition_status is distinct from 'reversed' then
    raise exception 'FAIL 6: the shelving''s acquisition reads "%" after being voided, expected reversed',
      v_row.acquisition_status;
  end if;

  select * into v_sum from public.fixed_asset_summary(v_shop);
  if v_sum.voided_count is distinct from 1 or v_sum.voided_cost_cents is distinct from 1000 then
    raise exception 'FAIL 6: the summary reports % voided assets at % -- expected 1 at 1000',
      v_sum.voided_count, v_sum.voided_cost_cents;
  end if;

  select s.amount_cents into v_bs
    from public.balance_sheet(v_shop, '2026-12-31') s
   where s.section = 'fixed_assets' and s.is_total;
  if v_bs = v_sum.net_book_cents then
    raise exception 'FAIL 6: the register and the balance sheet still agree at % after a purchase was voided -- one of them has stopped reading the ledger',
      v_bs;
  end if;
  if v_sum.net_book_cents - v_bs is distinct from v_sum.voided_cost_cents then
    raise exception 'FAIL 6: the register is % above the balance sheet, expected exactly the voided cost of %',
      v_sum.net_book_cents - v_bs, v_sum.voided_cost_cents;
  end if;

  --    AND THE FIX THE SCREEN OFFERS IS THE ONE THAT EXISTS. delete_fixed_asset
  --    REFUSES a depreciated asset, which the shelving is -- so the caveat says
  --    what happened and does not offer a button that raises. Pinned so that a
  --    later change to either function cannot quietly make the screen's advice
  --    wrong.
  v_raised := false;
  begin
    perform public.delete_fixed_asset(v_shelving);
  exception when others then
    v_raised := true; v_message := sqlerrm;
  end;
  if not v_raised then
    raise exception 'FAIL 6: a depreciated asset was deleted -- 1590 now carries depreciation for something the books say was never bought';
  end if;
  if v_message not like '%dispose of it instead%' then
    raise exception 'FAIL 6: deleting a depreciated asset refused with "%"', v_message;
  end if;
  raise notice '6 OK: a voided purchase shows in the register, is counted, and moves the two totals apart by exactly its cost';

  -- =====================================================================
  -- 7. THE WARNING COVERS LIVE ASSETS AND SAYS SO, so voiding a SOLD asset's
  --    purchase does not inflate the count the screen's caveat is sized from.
  --
  --    Both `voided_count` and `voided_cost_cents` filter on `disposed_on is
  --    null`, and until this check nothing exercised that filter: every voided
  --    asset in the fixture was live, so dropping the clause from either
  --    changed no figure. Measured -- both mutations survived the whole suite.
  --
  --    It is not a cosmetic filter. The caveat on the screen says the register
  --    is exactly `voided_cost_cents` ABOVE the balance sheet, and a disposed
  --    asset is in neither of those totals to begin with: its cost was credited
  --    out of 1500 by the disposal and its row is excluded from the register's
  --    own sum. Counting it would put a figure in the sentence that the two
  --    statements do not differ by, and offer "remove the row" for a row that
  --    is already history.
  --
  --    What voiding a SOLD asset's acquisition actually does is take the cost
  --    out of 1500 a SECOND time, and 20261007000000's header names that as the
  --    older, different mess no total here claims to cover. This check pins
  --    that it stays uncovered rather than being half-counted.
  -- =====================================================================
  perform public.reverse_journal_entry(
    (select fa.journal_entry_id from public.fixed_assets fa where fa.id = v_printer),
    'The printer was never bought on this account either');

  select * into v_row from public.list_fixed_assets(v_shop) r where r.id = v_printer;
  if v_row.acquisition_status is distinct from 'reversed' then
    raise exception 'FAIL 7: a sold asset''s voided purchase reads "%", expected reversed -- the row still reports the truth about its entry',
      v_row.acquisition_status;
  end if;
  if v_row.net_book_cents is not null then
    raise exception 'FAIL 7: voiding a sold asset''s purchase gave it a book value of % -- it is still disposed of',
      v_row.net_book_cents;
  end if;

  select * into v_sum from public.fixed_asset_summary(v_shop);
  if v_sum.voided_count is distinct from 1 or v_sum.voided_cost_cents is distinct from 1000 then
    raise exception 'FAIL 7: the summary reports % voided assets at % after a SOLD asset''s purchase was voided -- expected still 1 at 1000, the live shelving alone',
      v_sum.voided_count, v_sum.voided_cost_cents;
  end if;
  --    ...and the totals the caveat is measured against have not moved either,
  --    because a disposed asset was never in them.
  if v_sum.cost_cents is distinct from 25000 or v_sum.net_book_cents is distinct from 16000 then
    raise exception 'FAIL 7: the register totals moved to % at cost and % book value when a SOLD asset''s purchase was voided',
      v_sum.cost_cents, v_sum.net_book_cents;
  end if;
  raise notice '7 OK: the voided-purchase warning counts live assets only, and a sold asset''s voided purchase leaves it alone';

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
