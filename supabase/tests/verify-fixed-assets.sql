-- The fixed-asset register, depreciation, and disposal.
--
-- Three RPCs and two tables (20261006000100, 20261006000200) plus the change
-- they forced on cash_flow() (20261006000300). What this file is for, in the
-- order the failures would matter:
--
--   * the STATEMENTS move. balance_sheet()'s fixed-asset section and
--     cash_flow()'s investing section have read zero since phase 3a shipped
--     them. Every assertion here that names a section names a NON-ZERO figure,
--     because roughly thirty-five mutations on this project have been no-ops and
--     several of them were `0 - 0 = 0`.
--   * DEPRECIATION IS EXACT OVER A LIFE, not merely plausible for a month. An
--     asset that depreciates to -3 or stops 7 short sits on the balance sheet
--     forever, and a check on one month's charge passes for every rounding rule
--     there is. Two of the three assets here have lives their cost does not
--     divide by.
--   * RUNNING IT TWICE POSTS NOTHING THE SECOND TIME, and running it again after
--     a NEW asset is added for a month already charged posts that asset and only
--     that asset -- which is the difference between `unique (asset_id,
--     charge_month)` and a per-shop run table, and the reason the constraint is
--     shaped the way it is.
--   * A DISPOSAL TIES. This is the one that found a real defect: cash_flow()
--     read 1500-1599 EXCLUDING 1590, so a disposal's write-back of accumulated
--     depreciation was read by no section at all and the proof row failed by
--     exactly it. See 20261006000300's header for the reproduction.
--
-- ## The fixture
--
-- Fixed calendar months in 2026 rather than offsets from today: a fixture dated
-- relative to now() has made two dates coincide on this project before, and
-- everything here is about which MONTH a date falls in. Every month used has
-- ended, which run_depreciation requires.
--
--   Shop A, "Asset Shop"
--     2026-01-02  Cr 3000  200000  capital, in cash
--     2026-01-05  Van        24000  life 4   paid from 1000   -> 6000 a month
--     2026-01-20  Printer     5000  life 10  paid from 1000   ->  500 a month
--     2026-02-10  Shelving    1000  life 3   ON CREDIT, 1510  ->  333/333/334
--     depreciate through 30 Apr, then sell the van, then depreciate through
--     31 Jul, then sell the printer.
--
--   Shop B, "The Other Asset Shop" -- the tenant boundary, and the closed
--   period. Every figure it carries is unlike shop A's, so a leak in either
--   direction moves a number pinned to the cent here.
--
-- The van's life is FOUR months and the window runs to July, so it is asked for
-- depreciation three months after it has none left to give. The shelving's cost
-- does not divide by its life. The printer is the one sold part-way through, at
-- a LOSS; the van is sold fully depreciated, at a GAIN. A fixture that only ever
-- makes a loss cannot tell a sign error from a correct one.

\set ON_ERROR_STOP on

do $$
declare
  v_owner    uuid := gen_random_uuid();
  v_other    uuid := gen_random_uuid();
  v_third    uuid := gen_random_uuid();
  v_viewer   uuid := gen_random_uuid();   -- ledger.view, NOT ledger.post
  v_shop     uuid;
  v_loc      uuid;
  v_shop_b   uuid;
  v_loc_b    uuid;
  v_shop_c   uuid;
  v_loc_c    uuid;
  v_view_role uuid;

  v_van      uuid;
  v_printer  uuid;
  v_shelving uuid;
  v_fan      uuid;
  v_kettle   uuid;
  v_oven     uuid;
  v_table    uuid;
  v_relic    uuid;
  v_freezer  uuid;
  v_scale    uuid;
  v_widget   uuid;
  v_bin      uuid;
  v_toaster  uuid;

  v_entry    uuid;
  v_kettle_entry uuid;
  v_reversal uuid;
  v_mar_b    uuid;
  v_jun_c    uuid;

  v_today    date := public.shop_local_date();
  v_n        integer;
  v_amount   bigint;
  v_before   bigint;
  v_after    bigint;
  v_date     date;
  v_desc     text;
  v_window   record;
  v_raised   boolean;
  v_message  text;
begin
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
    select u, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
           'verify-fixed-assets-' || u || '@example.test', '', now(), now(), now()
      from unnest(array[v_owner, v_other, v_viewer]) u;

  insert into public.shops (owner_id, name) values (v_owner, 'Asset Shop') returning id into v_shop;
  insert into public.shop_locations (shop_id, name, is_primary) values (v_shop, 'Main', true)
    returning id into v_loc;
  insert into public.shops (owner_id, name) values (v_other, 'The Other Asset Shop')
    returning id into v_shop_b;
  insert into public.shop_locations (shop_id, name, is_primary) values (v_shop_b, 'Main', true)
    returning id into v_loc_b;

  -- Shop B RENAMES ITS OWN TILL, and nothing in shop A's books may ever say
  -- this name. create_fixed_asset reads the asset and payment account NAMES to
  -- build its description, and that read is filtered to one shop; without the
  -- filter `max(a.name)` collects every shop's, and this name sorts after
  -- 'Cash on Hand' precisely so that it wins. Check 1 asserts what shop A's
  -- description says. The names are all this door can leak -- post_journal_entry
  -- resolves the code to an account id inside the shop itself -- but a purchase
  -- in one shop described in another shop's words is still a shop reading a
  -- string it was never shown.
  update public.accounts set name = 'Shop B''s own till, and only shop B''s'
   where shop_id = v_shop_b and code = '1000';

  -- A member of shop A who can READ the books and not write them. This is the
  -- default shape of every non-owner role in this database, so "the gate is
  -- ledger.post and not ledger.view" is the difference between the register
  -- being an owner's tool and being everybody's.
  insert into public.roles (shop_id, name, permissions)
    values (v_shop, 'Bookkeeper', array['ledger.view'])
    returning id into v_view_role;
  insert into public.shop_members (shop_id, user_id, role_id, active)
    values (v_shop, v_viewer, v_view_role, true);

  -- RLS starts applying here, so every raw insert above had to come first.
  perform set_config('request.jwt.claims', json_build_object('sub', v_owner)::text, true);
  perform set_config('role', 'authenticated', true);

  perform public.post_journal_entry(v_shop, '2026-01-02', 'Owner capital, in cash',
    jsonb_build_array(jsonb_build_object('code', '1000', 'amount_cents',  200000),
                      jsonb_build_object('code', '3000', 'amount_cents', -200000)),
    v_loc, 'opening');

  -- =====================================================================
  -- 1. BUYING FOR CASH: Dr the asset account, Cr the money, source 'asset'.
  -- =====================================================================
  v_van := public.create_fixed_asset(v_shop, 'Delivery van', 24000, '2026-01-05', 4, '1000');
  if v_van is null then
    raise exception 'FAIL 1: create_fixed_asset returned no asset id';
  end if;

  select fa.journal_entry_id into v_entry from public.fixed_assets fa where fa.id = v_van;
  if v_entry is null then
    raise exception 'FAIL 1: the register row does not link the entry that bought the asset -- the 2b pattern that makes a double post visible and a reversal possible';
  end if;

  select e.source, e.entry_date into v_desc, v_date
    from public.journal_entries e where e.id = v_entry;
  if v_desc is distinct from 'asset' then
    raise exception 'FAIL 1: the acquisition posted under source "%", expected "asset"', v_desc;
  end if;
  if v_date is distinct from '2026-01-05'::date then
    raise exception 'FAIL 1: the acquisition is dated %, expected 2026-01-05 (an open month is not redirected)', v_date;
  end if;

  --    ...and it is described in SHOP A'S OWN WORDS. Shop B renamed its till
  --    above to a name that sorts after this one, so an unfiltered `max(a.name)`
  --    over the chart picks shop B's and this reads "paid from Shop B's own
  --    till". The tenant filter on that lookup is the only thing between the two.
  select e.description into v_desc from public.journal_entries e where e.id = v_entry;
  if v_desc not like '%Cash on Hand%' then
    raise exception 'FAIL 1: the acquisition is described as "%" -- the account name came from another shop''s chart', v_desc;
  end if;

  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l join public.accounts a on a.id = l.account_id
   where l.entry_id = v_entry and a.code = '1500';
  if v_amount is distinct from 24000 then
    raise exception 'FAIL 1: 1500 was debited by %, expected 24000; a negative figure means the entry is the wrong way round and still balances', v_amount;
  end if;
  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l join public.accounts a on a.id = l.account_id
   where l.entry_id = v_entry and a.code = '1000';
  if v_amount is distinct from -24000 then
    raise exception 'FAIL 1: 1000 was credited by %, expected -24000', v_amount;
  end if;
  raise notice '1 OK: buying for cash is Dr 1500 / Cr 1000 at source asset';

  -- =====================================================================
  -- 2. BUYING ON CREDIT credits 2000 Accounts Payable and takes NO cash --
  --    which is what p_paid_from_code defaulting to null rather than to
  --    '1000' buys. A default of '1000' would take money out of a till that
  --    never opened, and the entry would balance either way.
  -- =====================================================================
  v_printer := public.create_fixed_asset(v_shop, 'Printer', 5000, '2026-01-20', 10, '1000');
  v_shelving := public.create_fixed_asset(v_shop, 'Shelving', 1000, '2026-02-10', 3, null, '1510');

  select fa.journal_entry_id into v_entry from public.fixed_assets fa where fa.id = v_shelving;
  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l join public.accounts a on a.id = l.account_id
   where l.entry_id = v_entry and a.code = '2000';
  if v_amount is distinct from -1000 then
    raise exception 'FAIL 2: an asset bought on credit credited 2000 by %, expected -1000', v_amount;
  end if;
  if exists (select 1 from public.journal_lines l join public.accounts a on a.id = l.account_id
              where l.entry_id = v_entry and a.code in ('1000', '1010', '1020', '1021')) then
    raise exception 'FAIL 2: an asset bought on credit took cash out of a till';
  end if;
  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l join public.accounts a on a.id = l.account_id
   where l.entry_id = v_entry and a.code = '1510';
  if v_amount is distinct from 1000 then
    raise exception 'FAIL 2: p_account_code was ignored -- 1510 was debited by %, expected 1000', v_amount;
  end if;
  raise notice '2 OK: on credit is Cr 2000, and p_account_code chooses the asset account';

  -- =====================================================================
  -- 3. WHAT IS REFUSED. Each of these balances perfectly if it is allowed
  --    through, which is why none of them can be left to the ledger to catch.
  -- =====================================================================
  v_raised := false;
  begin
    perform public.create_fixed_asset(v_shop, 'Wrong account', 1000, '2026-01-06', 12, '1000', '1590');
  exception when others then v_raised := true; v_message := sqlerrm;
  end;
  if not v_raised then
    raise exception 'FAIL 3a: an asset was booked INTO 1590 Accumulated Depreciation -- it would present as a negative fixed asset and then depreciate itself';
  end if;

  v_raised := false;
  begin
    perform public.create_fixed_asset(v_shop, 'Out of range', 1000, '2026-01-06', 12, '1000', '6400');
  exception when others then v_raised := true;
  end;
  if not v_raised then
    raise exception 'FAIL 3b: an asset was booked to 6400 Supplies, outside the 1500-1599 range the balance sheet calls fixed assets';
  end if;

  v_raised := false;
  begin
    perform public.create_fixed_asset(v_shop, 'Paid from revenue', 1000, '2026-01-06', 12, '4000');
  exception when others then v_raised := true;
  end;
  if not v_raised then
    raise exception 'FAIL 3c: equipment was paid for out of 4000 Sales Revenue -- a balanced entry that invents income';
  end if;

  v_raised := false;
  begin
    perform public.create_fixed_asset(v_shop, 'Free', 0, '2026-01-06', 12, '1000');
  exception when others then v_raised := true;
  end;
  if not v_raised then raise exception 'FAIL 3d: a zero-cost asset was accepted'; end if;

  v_raised := false;
  begin
    perform public.create_fixed_asset(v_shop, 'Backwards', -1000, '2026-01-06', 12, '1000');
  exception when others then v_raised := true;
  end;
  if not v_raised then
    raise exception 'FAIL 3e: a NEGATIVE cost was accepted -- journal_lines refuses a zero and would have posted this one, backwards and balanced';
  end if;

  v_raised := false;
  begin
    perform public.create_fixed_asset(v_shop, 'Immortal', 1000, '2026-01-06', 0, '1000');
  exception when others then v_raised := true;
  end;
  if not v_raised then
    raise exception 'FAIL 3f: a life of zero months was accepted, and run_depreciation divides by it';
  end if;

  v_raised := false;
  begin
    perform public.create_fixed_asset(v_shop, 'Tomorrow', 1000, v_today + 1, 12, '1000');
  exception when others then v_raised := true;
  end;
  if not v_raised then raise exception 'FAIL 3g: an asset was acquired in the future'; end if;

  v_raised := false;
  begin
    perform public.create_fixed_asset(v_shop, '   ', 1000, '2026-01-06', 12, '1000');
  exception when others then v_raised := true;
  end;
  if not v_raised then raise exception 'FAIL 3h: a nameless asset was accepted'; end if;
  raise notice '3 OK: 1590, an out-of-range account, a revenue account, zero and negative cost, a zero life, a future date and no name are all refused';

  -- =====================================================================
  -- 4. AND THE BALANCE SHEET AND CASH FLOW MOVE. Both sections have read
  --    zero since phase 3a shipped them; these are the first figures they
  --    have ever carried from a real door.
  -- =====================================================================
  select amount_cents into v_amount from public.balance_sheet(v_shop, '2026-02-28')
   where section = 'fixed_assets' and is_total;
  if v_amount is distinct from 30000 then
    raise exception 'FAIL 4: fixed assets read %, expected 30000 (24000 van + 5000 printer + 1000 shelving, nothing depreciated yet)', v_amount;
  end if;
  select amount_cents into v_amount from public.cash_flow(v_shop, '2026-01-01', '2026-02-28')
   where section = 'investing' and is_total;
  if v_amount is distinct from -30000 then
    raise exception 'FAIL 4: cash used in investing reads %, expected -30000', v_amount;
  end if;
  --    ...and it proves out, with the shelving''s 1000 of payables cancelling
  --    the third of that investing figure no cash left for.
  if (select amount_cents from public.cash_flow(v_shop, '2026-01-01', '2026-02-28') where section = 'net_change')
     is distinct from (select amount_cents from public.cash_flow(v_shop, '2026-01-01', '2026-02-28')
                        where section = 'proof' and label = 'Movement in cash accounts') then
    raise exception 'FAIL 4: the cash flow does not prove out after three purchases -- net change % against observed movement %',
      (select amount_cents from public.cash_flow(v_shop, '2026-01-01', '2026-02-28') where section = 'net_change'),
      (select amount_cents from public.cash_flow(v_shop, '2026-01-01', '2026-02-28')
        where section = 'proof' and label = 'Movement in cash accounts');
  end if;
  raise notice '4 OK: fixed assets read 30000 and investing -30000, and the proof ties';

  -- =====================================================================
  -- 5. DEPRECIATION: one entry a month, dated the month's end, source
  --    'depreciation', Dr 6800 / Cr 1590.
  --      Jan  van 6000 + printer 500                = 6500
  --      Feb  van 6000 + printer 500 + shelving 333 = 6833
  --      Mar  van 6000 + printer 500 + shelving 333 = 6833
  --      Apr  van 6000 + printer 500 + shelving 334 = 6834
  --    Four different figures, so a month read for another month cannot pass.
  -- =====================================================================
  v_n := public.run_depreciation(v_shop, '2026-04-30');
  if v_n is distinct from 4 then
    raise exception 'FAIL 5: run_depreciation wrote % entries, expected 4 (January through April)', v_n;
  end if;

  for v_date, v_amount in
    select d.m, d.expected from (values
      ('2026-01-31'::date, 6500::bigint), ('2026-02-28', 6833),
      ('2026-03-31', 6833), ('2026-04-30', 6834)) d(m, expected)
  loop
    if (select coalesce(sum(l.amount_cents), 0)
          from public.journal_lines l
          join public.journal_entries e on e.id = l.entry_id
          join public.accounts a on a.id = l.account_id
         where e.shop_id = v_shop and e.source = 'depreciation'
           and e.entry_date = v_date and a.code = '6800') is distinct from v_amount then
      raise exception 'FAIL 5: depreciation dated % charged % to 6800, expected %',
        v_date,
        (select coalesce(sum(l.amount_cents), 0) from public.journal_lines l
           join public.journal_entries e on e.id = l.entry_id
           join public.accounts a on a.id = l.account_id
          where e.shop_id = v_shop and e.source = 'depreciation'
            and e.entry_date = v_date and a.code = '6800'),
        v_amount;
    end if;
  end loop;

  --    1590 carries the credit side, and it equals the charge rows exactly.
  --    Two records of the same fact that could drift is the reason the register
  --    keeps charge rows at all, so this is asserted rather than assumed.
  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l
    join public.journal_entries e on e.id = l.entry_id
    join public.accounts a on a.id = l.account_id
   where e.shop_id = v_shop and a.code = '1590';
  if v_amount is distinct from -27000 then
    raise exception 'FAIL 5: 1590 reads %, expected -27000', v_amount;
  end if;
  perform set_config('role', 'postgres', true);
  if (select coalesce(sum(dc.amount_cents), 0) from public.depreciation_charges dc
       where dc.shop_id = v_shop) is distinct from 27000 then
    raise exception 'FAIL 5: the charge rows total % but 1590 carries 27000 -- the register and the ledger disagree',
      (select coalesce(sum(dc.amount_cents), 0) from public.depreciation_charges dc where dc.shop_id = v_shop);
  end if;
  perform set_config('role', 'authenticated', true);
  raise notice '5 OK: four monthly entries, four figures, and the charge rows equal 1590';

  -- =====================================================================
  -- 6. RUNNING IT AGAIN WRITES NOTHING. Not a zero entry, not a duplicate:
  --    nothing. Guaranteed by unique (asset_id, charge_month) rather than by
  --    a look-before-you-write check, which two concurrent runs beat.
  -- =====================================================================
  select count(*) into v_before from public.journal_entries
   where shop_id = v_shop and source = 'depreciation';
  v_n := public.run_depreciation(v_shop, '2026-04-30');
  if v_n is distinct from 0 then
    raise exception 'FAIL 6: a second run for the same months wrote % entries, expected 0', v_n;
  end if;
  select count(*) into v_after from public.journal_entries
   where shop_id = v_shop and source = 'depreciation';
  if v_after is distinct from v_before then
    raise exception 'FAIL 6: a second run left % depreciation entries, up from %', v_after, v_before;
  end if;
  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l
    join public.journal_entries e on e.id = l.entry_id
    join public.accounts a on a.id = l.account_id
   where e.shop_id = v_shop and a.code = '1590';
  if v_amount is distinct from -27000 then
    raise exception 'FAIL 6: a second run moved 1590 to %, from -27000', v_amount;
  end if;
  raise notice '6 OK: a second run for the same months writes nothing and moves nothing';

  -- =====================================================================
  -- 7. A DISPOSED ASSET STOPS, on the month of its disposal.
  --    The van is sold on 10 May, fully depreciated, for 2000 -- so the whole
  --    2000 is a GAIN, credited to 6900 and presenting as a negative expense.
  -- =====================================================================
  v_entry := public.dispose_fixed_asset(v_van, '2026-05-10', 2000, '1000');

  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l join public.accounts a on a.id = l.account_id
   where l.entry_id = v_entry and a.code = '1590';
  if v_amount is distinct from 24000 then
    raise exception 'FAIL 7: the disposal wrote back % of accumulated depreciation, expected 24000 -- leaving a sold asset''s depreciation on the balance sheet forever', v_amount;
  end if;
  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l join public.accounts a on a.id = l.account_id
   where l.entry_id = v_entry and a.code = '1500';
  if v_amount is distinct from -24000 then
    raise exception 'FAIL 7: the disposal credited 1500 by %, expected -24000 (the FULL cost, not the net book value)', v_amount;
  end if;
  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l join public.accounts a on a.id = l.account_id
   where l.entry_id = v_entry and a.code = '6900';
  if v_amount is distinct from -2000 then
    raise exception 'FAIL 7: the gain on the van reads % in 6900, expected -2000 (a CREDIT: the shop got 2000 for something the books valued at nothing); +2000 is the sign inverted and would report a loss', v_amount;
  end if;

  -- And now it stops. Three more months are asked for and the van takes none
  -- of them -- both because it was disposed of and because its four-month life
  -- ended in April.
  v_n := public.run_depreciation(v_shop, '2026-07-31');
  if v_n is distinct from 3 then
    raise exception 'FAIL 7: the run through July wrote % entries, expected 3 (May, June and July -- the printer alone)', v_n;
  end if;
  perform set_config('role', 'postgres', true);
  if exists (select 1 from public.depreciation_charges dc
              where dc.asset_id = v_van and dc.charge_month >= '2026-05-01') then
    raise exception 'FAIL 7: the van was depreciated after it was sold';
  end if;
  perform set_config('role', 'authenticated', true);
  raise notice '7 OK: a disposal writes back its own depreciation at cost, the gain is a credit, and the asset stops';

  -- =====================================================================
  -- 8. NEVER PAST COST, AND EXACTLY TO COST.
  --    The van's life is 4 months and it was asked for 7. The shelving's cost
  --    does not divide by its life: 1000 / 3 is 333.33, and 333 x 3 = 999 --
  --    one cent short, on the balance sheet, forever. The last month carries
  --    the remainder, so the total is the cost EXACTLY.
  -- =====================================================================
  perform set_config('role', 'postgres', true);
  if (select coalesce(sum(dc.amount_cents), 0) from public.depreciation_charges dc
       where dc.asset_id = v_van) is distinct from 24000 then
    raise exception 'FAIL 8: the van took % over its life, expected exactly 24000 -- its cost',
      (select coalesce(sum(dc.amount_cents), 0) from public.depreciation_charges dc where dc.asset_id = v_van);
  end if;
  if (select coalesce(sum(dc.amount_cents), 0) from public.depreciation_charges dc
       where dc.asset_id = v_shelving) is distinct from 1000 then
    raise exception 'FAIL 8: the shelving took % over its life, expected exactly 1000; 999 is floor(cost/life) every month and the cent never comes off',
      (select coalesce(sum(dc.amount_cents), 0) from public.depreciation_charges dc where dc.asset_id = v_shelving);
  end if;
  if (select count(*) from public.depreciation_charges dc where dc.asset_id = v_shelving) <> 3 then
    raise exception 'FAIL 8: the shelving was charged in % months, expected 3 -- its whole life and no more',
      (select count(*) from public.depreciation_charges dc where dc.asset_id = v_shelving);
  end if;
  if (select coalesce(max(dc.amount_cents), 0) from public.depreciation_charges dc
       where dc.asset_id = v_shelving) is distinct from 334 then
    raise exception 'FAIL 8: the shelving''s largest charge is %, expected 334 -- the last month carries the remainder',
      (select coalesce(max(dc.amount_cents), 0) from public.depreciation_charges dc where dc.asset_id = v_shelving);
  end if;
  -- Stated as the general rule as well as on the two assets: no asset in this
  -- shop has ever taken more depreciation than it cost.
  if exists (
    select 1 from public.fixed_assets fa
     where fa.shop_id = v_shop
       and (select coalesce(sum(dc.amount_cents), 0) from public.depreciation_charges dc
             where dc.asset_id = fa.id) > fa.cost_cents) then
    raise exception 'FAIL 8: an asset has taken more depreciation than it cost, so 1590 exceeds 1500 for it';
  end if;
  perform set_config('role', 'authenticated', true);
  raise notice '8 OK: depreciation stops at the life and totals the cost exactly, remainder in the last month';

  -- =====================================================================
  -- 9. A NEW ASSET FOR A MONTH ALREADY CHARGED. This is what
  --    unique (asset_id, charge_month) buys over a per-shop "did I run June?"
  --    row: the fan is bought on 1 June and recorded after the June and July
  --    entries have already been posted, and the next run catches it up
  --    WITHOUT re-charging anything else.
  -- =====================================================================
  v_fan := public.create_fixed_asset(v_shop, 'Ceiling fan', 900, '2026-06-01', 3, '1000');
  select coalesce(sum(l.amount_cents), 0) into v_before
    from public.journal_lines l
    join public.journal_entries e on e.id = l.entry_id
    join public.accounts a on a.id = l.account_id
   where e.shop_id = v_shop and a.code = '6800';
  v_n := public.run_depreciation(v_shop, '2026-07-31');
  if v_n is distinct from 2 then
    raise exception 'FAIL 9: catching up a late asset wrote % entries, expected 2 (June and July, the fan alone)', v_n;
  end if;
  select coalesce(sum(l.amount_cents), 0) into v_after
    from public.journal_lines l
    join public.journal_entries e on e.id = l.entry_id
    join public.accounts a on a.id = l.account_id
   where e.shop_id = v_shop and a.code = '6800';
  if v_after - v_before is distinct from 600 then
    raise exception 'FAIL 9: catching up the fan charged %, expected 600 (300 in June and 300 in July); more than that means an asset already charged for those months was charged again',
      v_after - v_before;
  end if;
  raise notice '9 OK: a late asset is caught up for months already charged, and nothing else is';

  -- =====================================================================
  -- 10. DISPOSAL AT A LOSS MOVES THE BALANCE SHEET BY THE NET BOOK VALUE,
  --     AND THE CASH FLOW'S INVESTING SECTION SHOWS IT.
  --     The printer cost 5000 and has taken 500 a month from January to July
  --     -- 3500 -- so its book value is 1500. It sells for 1000, into the
  --     BANK rather than the till, and the 500 difference is a loss.
  -- =====================================================================
  select amount_cents into v_before from public.balance_sheet(v_shop, '2026-07-19')
   where section = 'fixed_assets' and is_total;
  v_entry := public.dispose_fixed_asset(v_printer, '2026-07-20', 1000, '1010');
  select amount_cents into v_after from public.balance_sheet(v_shop, '2026-07-20')
   where section = 'fixed_assets' and is_total;

  --     Read on 19 July, before the month-end charges for July have posted:
  --     1500 5900 (printer + fan, the van gone) + 1510 1000 less 1590's 4300.
  --     Both readings are taken on that side of the month end, so the movement
  --     between them is the disposal and nothing else.
  if v_before is distinct from 2600 then
    raise exception 'FAIL 10: fixed assets before the disposal read %, expected 2600', v_before;
  end if;
  if v_before - v_after is distinct from 1500 then
    raise exception 'FAIL 10: the balance sheet''s fixed assets moved by % over the disposal, expected 1500 -- the printer''s NET BOOK VALUE, not its 5000 cost and not the 1000 it sold for',
      v_before - v_after;
  end if;

  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l join public.accounts a on a.id = l.account_id
   where l.entry_id = v_entry and a.code = '6900';
  if v_amount is distinct from 500 then
    raise exception 'FAIL 10: the loss on the printer reads % in 6900, expected 500 (a DEBIT: 1500 of book value sold for 1000)', v_amount;
  end if;
  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l join public.accounts a on a.id = l.account_id
   where l.entry_id = v_entry and a.code = '1010';
  if v_amount is distinct from 1000 then
    raise exception 'FAIL 10: the proceeds landed % in 1010 Bank, expected 1000 -- p_received_into_code was ignored and the money went to the till', v_amount;
  end if;

  --     THE INVESTING SECTION, over July alone, and it is NON-ZERO. This is
  --     the check the whole of 20261006000300 exists for: with 1590 excluded
  --     from the range the way it was until then, the write-back of the
  --     printer's 3500 was read by nothing and the proof below failed by
  --     exactly it.
  select amount_cents into v_amount from public.cash_flow(v_shop, '2026-07-01', '2026-07-31')
   where section = 'investing' and is_total;
  if v_amount is distinct from 1500 then
    raise exception 'FAIL 10: investing for July reads %, expected +1500 -- the carrying amount of the printer leaving the shop. 5000 means the cost was read instead of the book value; 0 means the section stopped reading the range',
      v_amount;
  end if;
  raise notice '10 OK: a disposal at a loss moves fixed assets by book value and shows in investing';

  -- =====================================================================
  -- 11. AND THE PROOF TIES, over every window that contains a disposal.
  --     The proof row is the observed movement in 1000/1010/1020/1021 and no
  --     part of the arithmetic above it touches it. Three windows, because
  --     the defect 20261006000300 fixes is invisible in a window with no
  --     disposal in it and the whole-history window nets the two disposals
  --     together.
  -- =====================================================================
  for v_window in
    select w.f, w.t from (values
      ('2026-01-01'::date, '2026-12-31'::date),   -- everything
      ('2026-05-01'::date, '2026-05-31'::date),   -- the van, sold at a gain
      ('2026-07-01'::date, '2026-07-31'::date)    -- the printer, sold at a loss
    ) w(f, t)
  loop
    if (select amount_cents from public.cash_flow(v_shop, v_window.f, v_window.t) where section = 'net_change')
       is distinct from (select amount_cents from public.cash_flow(v_shop, v_window.f, v_window.t)
                          where section = 'proof' and label = 'Movement in cash accounts') then
      raise exception 'FAIL 11: the cash flow does not prove out over % to % -- net change % against observed movement %, off by % (the accumulated depreciation written back on a disposal is read by no section)',
        v_window.f, v_window.t,
        (select amount_cents from public.cash_flow(v_shop, v_window.f, v_window.t) where section = 'net_change'),
        (select amount_cents from public.cash_flow(v_shop, v_window.f, v_window.t)
          where section = 'proof' and label = 'Movement in cash accounts'),
        (select amount_cents from public.cash_flow(v_shop, v_window.f, v_window.t) where section = 'net_change')
          - (select amount_cents from public.cash_flow(v_shop, v_window.f, v_window.t)
              where section = 'proof' and label = 'Movement in cash accounts');
    end if;
  end loop;

  --     Pinned, so the equality above cannot be satisfied by a window in which
  --     nothing happened. 200000 in, 24000 + 5000 + 900 out for equipment,
  --     2000 + 1000 back on the two sales.
  if (select amount_cents from public.cash_flow(v_shop, '2026-01-01', '2026-12-31') where section = 'net_change')
     is distinct from 173100 then
    raise exception 'FAIL 11: net change in cash over the year is %, expected 173100',
      (select amount_cents from public.cash_flow(v_shop, '2026-01-01', '2026-12-31') where section = 'net_change');
  end if;
  --     And the add-back is not zero, which is what phase 3a shipped this line
  --     for and what nothing has ever exercised from a real door.
  if (select amount_cents from public.cash_flow(v_shop, '2026-01-01', '2026-12-31')
       where section = 'operating' and label = 'Add back depreciation') is distinct from 29100 then
    raise exception 'FAIL 11: add back depreciation reads %, expected 29100 (24000 van + 3500 printer + 1000 shelving + 600 fan)',
      (select amount_cents from public.cash_flow(v_shop, '2026-01-01', '2026-12-31')
        where section = 'operating' and label = 'Add back depreciation');
  end if;
  --     ...and the balance sheet still balances, with a contra account in it.
  if (select amount_cents from public.balance_sheet(v_shop, '2026-12-31') where section = 'total_assets')
     is distinct from (select amount_cents from public.balance_sheet(v_shop, '2026-12-31')
                        where section = 'total_liabilities_equity') then
    raise exception 'FAIL 11: the balance sheet does not balance -- assets % against liabilities and equity %',
      (select amount_cents from public.balance_sheet(v_shop, '2026-12-31') where section = 'total_assets'),
      (select amount_cents from public.balance_sheet(v_shop, '2026-12-31') where section = 'total_liabilities_equity');
  end if;
  --     1590 presents NEGATIVE inside fixed assets. It is the seeded contra
  --     asset and a sign error here balances perfectly while overstating every
  --     asset total a shop ever reads.
  if (select amount_cents from public.balance_sheet(v_shop, '2026-12-31') where code = '1590')
     is distinct from -1600 then
    raise exception 'FAIL 11: 1590 presents as % on the balance sheet, expected -1600 (the shelving''s 1000 and the fan''s 600; both disposals wrote their own depreciation back); a positive figure means the contra account is being ADDED to fixed assets',
      (select amount_cents from public.balance_sheet(v_shop, '2026-12-31') where code = '1590');
  end if;
  raise notice '11 OK: the proof ties over three windows, the add-back is 29100 and the contra presents negative';

  -- =====================================================================
  -- 12. A SECOND DISPOSAL IS REFUSED, and so are the dates that cannot be.
  -- =====================================================================
  v_raised := false;
  begin
    perform public.dispose_fixed_asset(v_printer, '2026-07-25', 0);
  exception when others then v_raised := true;
  end;
  if not v_raised then
    raise exception 'FAIL 12: an asset was disposed of twice, writing back accumulated depreciation that is no longer there';
  end if;

  v_raised := false;
  begin
    perform public.dispose_fixed_asset(v_shelving, '2026-01-01', 0);
  exception when others then v_raised := true;
  end;
  if not v_raised then
    raise exception 'FAIL 12: the shelving was disposed of before it was acquired';
  end if;

  v_raised := false;
  begin
    perform public.dispose_fixed_asset(v_shelving, v_today + 1, 0);
  exception when others then v_raised := true;
  end;
  if not v_raised then raise exception 'FAIL 12: an asset was disposed of in the future'; end if;

  v_raised := false;
  begin
    perform public.dispose_fixed_asset(v_shelving, '2026-06-01', 500, '4000');
  exception when others then v_raised := true;
  end;
  if not v_raised then
    raise exception 'FAIL 12: proceeds were received into 4000 Sales Revenue';
  end if;
  raise notice '12 OK: a second disposal, a date before acquisition, a future date and a non-cash destination are refused';

  -- =====================================================================
  -- 13. DELETING ONE ENTERED IN ERROR REVERSES ITS ENTRY, in the same task
  --     as the delete. Four holes shipped in phase 2b by adding a delete path
  --     and leaving its journal entry standing.
  -- =====================================================================
  v_kettle := public.create_fixed_asset(v_shop, 'Kettle, typed twice', 700, '2026-07-02', 12, '1000');
  select fa.journal_entry_id into v_kettle_entry from public.fixed_assets fa where fa.id = v_kettle;
  select amount_cents into v_before from public.balance_sheet(v_shop, '2026-12-31')
   where section = 'fixed_assets' and is_total;

  v_reversal := public.delete_fixed_asset(v_kettle);
  if v_reversal is null then
    raise exception 'FAIL 13: deleting an asset returned no reversal -- its entry is still standing and 1500 still carries the cost';
  end if;
  if exists (select 1 from public.fixed_assets fa where fa.id = v_kettle) then
    raise exception 'FAIL 13: the register row survived the delete';
  end if;
  if (select status from public.journal_entries where id = v_kettle_entry) is distinct from 'reversed' then
    raise exception 'FAIL 13: the acquisition entry is %, expected reversed',
      (select status from public.journal_entries where id = v_kettle_entry);
  end if;
  --     THE SAME SOURCE, which verify-posting-sales.sql pins as the convention
  --     for every reversal in this database: a reversal filed under 'manual'
  --     appears in the manual journals list and drops out of any report that
  --     reads by source.
  if (select source from public.journal_entries where id = v_reversal) is distinct from 'asset' then
    raise exception 'FAIL 13: the reversal carries source "%", expected "asset" -- a reversal files under the source of the entry it reverses',
      (select source from public.journal_entries where id = v_reversal);
  end if;
  if (select coalesce(sum(l.amount_cents), 0) from public.journal_lines l
       where l.entry_id = v_reversal) is distinct from 0 then
    raise exception 'FAIL 13: the reversal does not balance';
  end if;
  select amount_cents into v_after from public.balance_sheet(v_shop, '2026-12-31')
   where section = 'fixed_assets' and is_total;
  if v_after is distinct from v_before - 700 then
    raise exception 'FAIL 13: fixed assets read % after the delete, expected % -- the 700 came off the register but not off the books',
      v_after, v_before - 700;
  end if;

  --     ...and an asset that has been depreciated is NOT deletable, because
  --     unwinding its charges is a different operation with a different name.
  v_raised := false;
  begin
    perform public.delete_fixed_asset(v_shelving);
  exception when others then v_raised := true; v_message := sqlerrm;
  end;
  if not v_raised then
    raise exception 'FAIL 13: a depreciated asset was deleted, leaving 1590 carrying depreciation for something the books say was never bought';
  end if;
  if v_message not like '%dispose%' then
    raise exception 'FAIL 13: the refusal does not say what to do instead: "%"', v_message;
  end if;
  raise notice '13 OK: delete reverses its acquisition under the same source, and a depreciated asset is refused';

  -- =====================================================================
  -- 14. THE GATE IS ledger.post. A member holding ledger.view -- the shape of
  --     every non-owner role that can see the books at all -- reads the
  --     register and writes nothing to it.
  -- =====================================================================
  perform set_config('request.jwt.claims', json_build_object('sub', v_viewer)::text, true);
  if (select count(*) from public.fixed_assets fa where fa.shop_id = v_shop) < 1 then
    raise exception 'FAIL 14: a ledger.view member cannot READ the register, which is the permission the RLS policy names';
  end if;

  v_raised := false;
  begin
    perform public.create_fixed_asset(v_shop, 'Not allowed', 500, '2026-06-02', 12, '1000');
  exception when others then v_raised := true;
  end;
  if not v_raised then raise exception 'FAIL 14: ledger.view alone bought equipment'; end if;

  v_raised := false;
  begin
    perform public.dispose_fixed_asset(v_shelving, '2026-06-02', 0);
  exception when others then v_raised := true;
  end;
  if not v_raised then raise exception 'FAIL 14: ledger.view alone disposed of an asset'; end if;

  v_raised := false;
  begin
    perform public.delete_fixed_asset(v_shelving);
  exception when others then v_raised := true;
  end;
  if not v_raised then raise exception 'FAIL 14: ledger.view alone deleted an asset'; end if;

  v_raised := false;
  begin
    perform public.run_depreciation(v_shop, '2026-07-31');
  exception when others then v_raised := true;
  end;
  if not v_raised then raise exception 'FAIL 14: ledger.view alone ran depreciation'; end if;
  raise notice '14 OK: ledger.view reads the register and writes nothing';

  -- =====================================================================
  -- 15. THE SECOND SHOP. Phase 3a's final review removed the shop filter from
  --     all three statement functions and the whole suite passed, because no
  --     fixture had two shops. Shop B trades in its own months, with its own
  --     figures, and CLOSES one of them.
  -- =====================================================================
  perform set_config('request.jwt.claims', json_build_object('sub', v_other)::text, true);
  perform public.post_journal_entry(v_shop_b, '2026-01-02', 'Capital, in cash',
    jsonb_build_array(jsonb_build_object('code', '1000', 'amount_cents',  50000),
                      jsonb_build_object('code', '3000', 'amount_cents', -50000)),
    v_loc_b, 'opening');
  v_oven := public.create_fixed_asset(v_shop_b, 'Pizza oven', 12000, '2026-03-01', 6, '1000');
  --     A P&L line in March, so the close below has something to close. A
  --     period whose accounts all net to zero is a different case and
  --     verify-statements-across-a-close.sql already owns it.
  perform public.post_journal_entry(v_shop_b, '2026-03-20', 'March rent',
    jsonb_build_array(jsonb_build_object('code', '6000', 'amount_cents',  3000),
                      jsonb_build_object('code', '1000', 'amount_cents', -3000)),
    v_loc_b);

  --     Shop A's four runs never touched it, and could not have: they were
  --     asked about shop A.
  perform set_config('role', 'postgres', true);
  if exists (select 1 from public.depreciation_charges dc where dc.asset_id = v_oven) then
    raise exception 'FAIL 15: shop A''s depreciation runs charged shop B''s oven';
  end if;
  if exists (select 1 from public.depreciation_charges dc
              join public.fixed_assets fa on fa.id = dc.asset_id
             where dc.shop_id <> fa.shop_id) then
    raise exception 'FAIL 15: a charge row belongs to a different shop from its asset';
  end if;
  perform set_config('role', 'authenticated', true);

  --     And shop A's owner cannot reach shop B's register.
  perform set_config('request.jwt.claims', json_build_object('sub', v_owner)::text, true);
  v_raised := false;
  begin
    perform public.create_fixed_asset(v_shop_b, 'Not mine', 500, '2026-04-02', 12, '1000');
  exception when others then v_raised := true;
  end;
  if not v_raised then raise exception 'FAIL 15: shop A''s owner bought equipment for shop B'; end if;
  v_raised := false;
  begin
    perform public.dispose_fixed_asset(v_oven, '2026-04-02', 0);
  exception when others then v_raised := true;
  end;
  if not v_raised then
    raise exception 'FAIL 15: shop A''s owner disposed of shop B''s oven by id -- the permission is read from the ASSET''s shop for exactly this reason';
  end if;
  v_raised := false;
  begin
    perform public.run_depreciation(v_shop_b, '2026-04-30');
  exception when others then v_raised := true;
  end;
  if not v_raised then raise exception 'FAIL 15: shop A''s owner ran depreciation on shop B'; end if;
  raise notice '15 OK: neither shop''s register, charges or runs reach the other';

  -- =====================================================================
  -- 16. A CLOSED MONTH. Depreciation for a month that has been closed is
  --     RECOGNISED IN THE CURRENT ONE, carrying the true month and the
  --     period's status -- the redirect every posting site with a
  --     user-chosen date uses. The CHARGE ROW still records March, which is
  --     why idempotency is driven off it and not off the entry's date: after
  --     the redirect the date no longer says which month the charge is for.
  -- =====================================================================
  perform set_config('request.jwt.claims', json_build_object('sub', v_other)::text, true);
  select id into v_mar_b from public.accounting_periods
   where shop_id = v_shop_b and starts_on = '2026-03-01';
  if v_mar_b is null then
    raise exception 'FIXTURE: shop B did not open a March period to close';
  end if;
  perform public.close_accounting_period(v_shop_b, v_mar_b);

  v_n := public.run_depreciation(v_shop_b, '2026-04-30');
  if v_n is distinct from 2 then
    raise exception 'FAIL 16: shop B''s run wrote % entries, expected 2 (March, redirected, and April)', v_n;
  end if;

  perform set_config('role', 'postgres', true);
  select e.entry_date, e.description into v_date, v_desc
    from public.depreciation_charges dc
    join public.journal_entries e on e.id = dc.journal_entry_id
   where dc.asset_id = v_oven and dc.charge_month = '2026-03-01';
  if v_date is null then
    raise exception 'FAIL 16: the closed month was not charged at all -- a shop that closes its books stops depreciating';
  end if;
  if v_date is distinct from v_today then
    raise exception 'FAIL 16: March''s depreciation is dated % rather than today %; open_period_for raises on a closed month, so this would have failed outright', v_date, v_today;
  end if;
  if v_desc not like '%March 2026%' or v_desc not like '%closed%' then
    raise exception 'FAIL 16: the redirected entry does not say which month it is for and that the period is closed: "%"', v_desc;
  end if;
  --     APRIL is open and is dated where it belongs.
  if (select e.entry_date from public.depreciation_charges dc
        join public.journal_entries e on e.id = dc.journal_entry_id
       where dc.asset_id = v_oven and dc.charge_month = '2026-04-01')
     is distinct from '2026-04-30'::date then
    raise exception 'FAIL 16: April''s depreciation is not dated 30 April';
  end if;
  perform set_config('role', 'authenticated', true);

  --     AND RUNNING IT AGAIN STILL WRITES NOTHING. This is the case a check
  --     against the ledger's entry dates would fail: it would look for a
  --     March-dated entry, find the redirected one dated in August, and
  --     charge March again on every run for the rest of the shop's life.
  v_n := public.run_depreciation(v_shop_b, '2026-04-30');
  if v_n is distinct from 0 then
    raise exception 'FAIL 16: re-running over a REDIRECTED month wrote % entries, expected 0 -- idempotency is reading the entry date rather than the charge month', v_n;
  end if;

  --     An ASSET acquired in the closed month redirects the same way and keeps
  --     its true acquired_on, so its depreciation still starts in March.
  v_table := public.create_fixed_asset(v_shop_b, 'Prep table', 600, '2026-03-15', 2, '1000');
  if (select acquired_on from public.fixed_assets where id = v_table)
     is distinct from '2026-03-15'::date then
    raise exception 'FAIL 16: the register did not keep the true acquisition date through the redirect';
  end if;
  if (select e.entry_date from public.fixed_assets fa
        join public.journal_entries e on e.id = fa.journal_entry_id where fa.id = v_table)
     is distinct from v_today then
    raise exception 'FAIL 16: an asset acquired in a closed month was not recognised in the open one';
  end if;
  v_n := public.run_depreciation(v_shop_b, '2026-04-30');
  if v_n is distinct from 2 then
    raise exception 'FAIL 16: the prep table was charged over % months, expected 2 (March and April, from its TRUE acquisition date)', v_n;
  end if;
  perform set_config('role', 'postgres', true);
  if (select coalesce(sum(dc.amount_cents), 0) from public.depreciation_charges dc
       where dc.asset_id = v_table) is distinct from 600 then
    raise exception 'FAIL 16: the prep table took % over its two-month life, expected 600',
      (select coalesce(sum(dc.amount_cents), 0) from public.depreciation_charges dc where dc.asset_id = v_table);
  end if;
  perform set_config('role', 'authenticated', true);
  raise notice '16 OK: a closed month is charged once, recognised in the open period, and never charged again';

  -- =====================================================================
  -- 17. SHOP A RUNS DEPRECIATION AGAIN, NOW THAT SHOP B HAS ASSETS.
  --
  --     Check 15 asserts that shop A's runs never charged shop B's oven, and
  --     until this block that assertion could not fail: every one of shop A's
  --     four runs happened EARLIER IN THIS SCRIPT than the oven existed, so it
  --     held whatever the tenant filter said. Dropping `where fa.shop_id =
  --     p_shop_id` from both the due CTE and the charge-row insert left the
  --     whole file green -- which is phase 3a's defect exactly, arrived at
  --     through fixture ORDER rather than through a missing second shop.
  --
  --     So: one more run, asked of shop A, through a month shop A is already
  --     charged to. It must write NOTHING. Shop B's oven is six months from
  --     March and shop B has only run to April, so May, June and July are due
  --     on it -- a leak has three charges waiting to be picked up, and they
  --     are the ones check 15 and check 17 below are pinned against.
  -- =====================================================================
  perform set_config('request.jwt.claims', json_build_object('sub', v_owner)::text, true);
  v_n := public.run_depreciation(v_shop, '2026-07-31');
  if v_n is distinct from 0 then
    raise exception 'FAIL 17: shop A''s run wrote % entries with nothing of its own due, expected 0 -- it reached into another shop''s register', v_n;
  end if;
  perform set_config('role', 'postgres', true);
  if (select count(*) from public.depreciation_charges dc where dc.asset_id = v_oven)
     is distinct from 2 then
    raise exception 'FAIL 17: shop B''s oven carries % charge rows after shop A ran depreciation, expected 2 (March and April, both shop B''s own)',
      (select count(*) from public.depreciation_charges dc where dc.asset_id = v_oven);
  end if;
  if exists (select 1 from public.depreciation_charges dc
              join public.fixed_assets fa on fa.id = dc.asset_id
             where dc.shop_id <> fa.shop_id) then
    raise exception 'FAIL 17: a charge row belongs to a different shop from its asset';
  end if;
  perform set_config('role', 'authenticated', true);
  --     Handed back to shop B's owner, which is who check 18 opens as. RLS is
  --     real in this script, so reading shop B's ledger as shop A returns 0
  --     rather than raising -- a `0` that would satisfy nothing here but would
  --     be a very quiet way to make a figure agree somewhere else.
  perform set_config('request.jwt.claims', json_build_object('sub', v_other)::text, true);
  raise notice '17 OK: a run asked of one shop leaves the other shop''s register alone';

  -- =====================================================================
  -- 18. SHOP B'S OWN FIGURES, pinned to the cent, and shop A's unchanged by
  --     everything shop B did.
  -- =====================================================================
  if (select coalesce(sum(l.amount_cents), 0)
        from public.journal_lines l
        join public.journal_entries e on e.id = l.entry_id
        join public.accounts a on a.id = l.account_id
       where e.shop_id = v_shop_b and a.code = '1590') is distinct from -4600 then
    raise exception 'FAIL 18: shop B''s 1590 reads %, expected -4600 (2000 + 2000 on the oven, 300 + 300 on the prep table)',
      (select coalesce(sum(l.amount_cents), 0) from public.journal_lines l
         join public.journal_entries e on e.id = l.entry_id
         join public.accounts a on a.id = l.account_id
        where e.shop_id = v_shop_b and a.code = '1590');
  end if;
  perform set_config('request.jwt.claims', json_build_object('sub', v_owner)::text, true);
  if (select coalesce(sum(l.amount_cents), 0)
        from public.journal_lines l
        join public.journal_entries e on e.id = l.entry_id
        join public.accounts a on a.id = l.account_id
       where e.shop_id = v_shop and a.code = '1590') is distinct from -1600 then
    raise exception 'FAIL 18: shop A''s 1590 reads %, expected -1600 after both disposals wrote their depreciation back',
      (select coalesce(sum(l.amount_cents), 0) from public.journal_lines l
         join public.journal_entries e on e.id = l.entry_id
         join public.accounts a on a.id = l.account_id
        where e.shop_id = v_shop and a.code = '1590');
  end if;
  --     And shop B's books balance too, with a closed month in them.
  perform set_config('request.jwt.claims', json_build_object('sub', v_other)::text, true);
  if (select amount_cents from public.balance_sheet(v_shop_b, '2026-12-31') where section = 'total_assets')
     is distinct from (select amount_cents from public.balance_sheet(v_shop_b, '2026-12-31')
                        where section = 'total_liabilities_equity') then
    raise exception 'FAIL 18: shop B''s balance sheet does not balance';
  end if;
  if (select amount_cents from public.cash_flow(v_shop_b, '2026-01-01', '2026-12-31') where section = 'net_change')
     is distinct from (select amount_cents from public.cash_flow(v_shop_b, '2026-01-01', '2026-12-31')
                        where section = 'proof' and label = 'Movement in cash accounts') then
    raise exception 'FAIL 18: shop B''s cash flow does not prove out across its close -- net change % against observed movement %',
      (select amount_cents from public.cash_flow(v_shop_b, '2026-01-01', '2026-12-31') where section = 'net_change'),
      (select amount_cents from public.cash_flow(v_shop_b, '2026-01-01', '2026-12-31')
        where section = 'proof' and label = 'Movement in cash accounts');
  end if;
  --     ...and no residual section has been added to make any of that true.
  if exists (select 1 from public.cash_flow(v_shop_b, '2026-01-01', '2026-12-31')
              where section not in ('operating', 'investing', 'financing', 'net_change', 'proof')) then
    raise exception 'FAIL 18: the cash flow has grown a section -- a residual line makes the proof tautological';
  end if;
  raise notice '18 OK: both shops'' figures stand alone and both statements tie';

  -- =====================================================================
  -- 19. SHOP C: THE EDGES WHERE A FIGURE IS ZERO.
  --
  --     Shops A and B between them never dispose of an asset with nothing
  --     accumulated against it, never dispose of one for nothing, never
  --     dispose of one at exactly its book value, and never ask for
  --     depreciation past the last complete month. Every one of those omits a
  --     line or takes a branch on a comparison with zero, and `-0 = 0` is how
  --     the sibling defect in this suite survived a whole phase. Shop C is
  --     the shop where each of those figures is zero.
  --
  --     It is a third shop rather than more assets in shop A because every
  --     figure above is pinned to the cent, and an edge case is worth nothing
  --     if adding it means re-deriving thirty numbers that were right.
  --
  --       2026-01-02  Cr 3000  100000  capital, in cash
  --       2026-05-01  Relic     400   life  1  -> the whole 400 in May
  --       2026-05-02  Freezer 12000   life 120 ->  100 a month, never sold
  --       2026-06-01  Scale    1200   life  12 ->  100 a month
  --       2026-06-01  Widget     20   life  24 ->  floor(20/24) = 0 a month
  -- =====================================================================
  perform set_config('role', 'postgres', true);
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
    values (v_third, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            'verify-fixed-assets-' || v_third || '@example.test', '', now(), now(), now());
  insert into public.shops (owner_id, name) values (v_third, 'The Third Asset Shop')
    returning id into v_shop_c;
  insert into public.shop_locations (shop_id, name, is_primary) values (v_shop_c, 'Main', true)
    returning id into v_loc_c;
  perform set_config('request.jwt.claims', json_build_object('sub', v_third)::text, true);
  perform set_config('role', 'authenticated', true);
  perform public.post_journal_entry(v_shop_c, '2026-01-02', 'Capital, in cash',
    jsonb_build_array(jsonb_build_object('code', '1000', 'amount_cents',  100000),
                      jsonb_build_object('code', '3000', 'amount_cents', -100000)),
    v_loc_c, 'opening');

  v_relic   := public.create_fixed_asset(v_shop_c, 'Relic', 400, '2026-05-01', 1, '1000');
  v_freezer := public.create_fixed_asset(v_shop_c, 'Freezer', 12000, '2026-05-02', 120, '1000');

  --     (a) AN ASSET WHOSE MONTHLY CHARGE ROUNDS TO ZERO, beside one whose
  --         charge does not. floor(20 / 24) is 0, the lines are filtered on
  --         `amount_cents > 0` and the charge-row insert was not, so the run
  --         wrote a zero charge row and died on depreciation_charges' own
  --         check constraint -- taking the whole month with it, for every
  --         asset, for a shop that had simply recorded something cheap.
  v_scale  := public.create_fixed_asset(v_shop_c, 'Scale', 1200, '2026-06-01', 12, '1000');
  v_widget := public.create_fixed_asset(v_shop_c, 'Widget', 20, '2026-06-01', 24, '1000');

  v_n := public.run_depreciation(v_shop_c, '2026-06-30');
  if v_n is distinct from 2 then
    raise exception 'FAIL 19: shop C''s run to June wrote % entries, expected 2 (May and June)', v_n;
  end if;
  perform set_config('role', 'postgres', true);
  if exists (select 1 from public.depreciation_charges dc where dc.asset_id = v_widget) then
    raise exception 'FAIL 19: the widget took a charge row, and floor(20 / 24) is 0 -- depreciation_charges refuses a zero amount';
  end if;
  perform set_config('role', 'authenticated', true);

  --     (b) A DISPOSAL WITH NOTHING ACCUMULATED AND NOTHING RECEIVED. The
  --         scale was bought on 1 June and June has been charged, so it has
  --         100 against it -- the RELIC is the one with a zero, and it is
  --         disposed of at exactly its book value below. Here the zero is the
  --         PROCEEDS: sold for nothing, so no cash line is built at all, and
  --         `if v_proceeds > 0` is the only thing keeping journal_lines from
  --         being handed a zero it refuses.
  v_entry := public.dispose_fixed_asset(v_scale, '2026-07-05', 0);
  if (select count(*) from public.journal_lines where entry_id = v_entry) is distinct from 3 then
    raise exception 'FAIL 19: the scale''s disposal wrote % lines, expected 3 (Cr 1500 1200, Dr 1590 100, Dr 6900 1100) -- a fourth is a zero cash line',
      (select count(*) from public.journal_lines where entry_id = v_entry);
  end if;
  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l join public.accounts a on a.id = l.account_id
   where l.entry_id = v_entry and a.code = '6900';
  if v_amount is distinct from 1100 then
    raise exception 'FAIL 19: the loss on a scale sold for nothing reads %, expected 1100 (1200 cost less the 100 charged)', v_amount;
  end if;

  --     (c) A DISPOSAL AT EXACTLY BOOK VALUE. The relic's one-month life ran
  --         out in May, so it carries 400 against a cost of 400 and sells for
  --         nothing: cost less accumulated less proceeds is ZERO and the 6900
  --         line is omitted entirely. `if v_gain_loss <> 0` is a three-way
  --         branch tested at two of its three points everywhere else.
  v_entry := public.dispose_fixed_asset(v_relic, '2026-07-06', 0);
  if exists (select 1 from public.journal_lines l join public.accounts a on a.id = l.account_id
              where l.entry_id = v_entry and a.code = '6900') then
    raise exception 'FAIL 19: an asset sold for exactly its book value posted a gain or a loss to 6900';
  end if;
  if (select count(*) from public.journal_lines where entry_id = v_entry) is distinct from 2 then
    raise exception 'FAIL 19: the relic''s disposal wrote % lines, expected 2 (Cr 1500 400, Dr 1590 400)',
      (select count(*) from public.journal_lines where entry_id = v_entry);
  end if;

  --     (d) AND NOW THE ONE THAT WAS A DEFECT. The scale was sold on 5 July
  --         and July has NOT been depreciated yet -- which is the ordinary
  --         order, because a shop sells things during the month and does its
  --         books at the end of it. Ask for July.
  --
  --         The rule as first written was "no charge in the month it leaves,
  --         or after", so a month BEFORE the disposal was still chargeable and
  --         a run reaching back over one would charge a sold asset. Here that
  --         is not reachable for the scale (June is already charged), so the
  --         reachable half is asserted directly below in (e). What this run
  --         asserts is the July half: the scale's month index in July is 2
  --         against a life of 12, so NOTHING BUT THE DISPOSAL can stop it --
  --         unlike the van in check 7, which was also out of life and let the
  --         disposal rule be removed entirely with the file still green.
  v_n := public.run_depreciation(v_shop_c, '2026-07-31');
  perform set_config('role', 'postgres', true);
  if (select coalesce(sum(dc.amount_cents), 0) from public.depreciation_charges dc
       where dc.asset_id = v_scale) is distinct from 100 then
    raise exception 'FAIL 19: the scale took % after it was sold, expected 100 (June alone) -- it is still depreciating in a month it was not owned in',
      (select coalesce(sum(dc.amount_cents), 0) from public.depreciation_charges dc where dc.asset_id = v_scale);
  end if;
  perform set_config('role', 'authenticated', true);

  --     (e) SELL FIRST, DEPRECIATE AFTER, and the balance sheet must not go
  --         NEGATIVE. Measured before the fix: a bin bought on 1 June for 1200
  --         and sold on 5 July for nothing, with June never run, wrote back the
  --         nothing it could see and the next run then charged June anyway.
  --         1500 came back to zero and 1590 kept -100 for an asset the books
  --         say the shop does not own, so `Total fixed assets` read -100 and
  --         nothing would ever have taken it off again.
  --         So the bin is recorded HERE, after the run above, against a June
  --         that is already closed off for every other asset but has no charge
  --         row for THIS one. It is sold in July, and then July is asked for.
  --         Under the old rule June was still chargeable -- June is before the
  --         disposal month -- and that is the charge that stranded.
  v_bin := public.create_fixed_asset(v_shop_c, 'Waste bin', 1200, '2026-06-01', 12, '1000');
  perform public.dispose_fixed_asset(v_bin, '2026-07-20', 0);
  perform public.run_depreciation(v_shop_c, '2026-07-31');
  perform set_config('role', 'postgres', true);
  if exists (select 1 from public.depreciation_charges dc where dc.asset_id = v_bin) then
    raise exception 'FAIL 19: an asset sold before its months were depreciated was charged afterwards, stranding accumulated depreciation for something that is off the books';
  end if;
  perform set_config('role', 'authenticated', true);
  select amount_cents into v_amount from public.balance_sheet(v_shop_c, v_today)
   where section = 'fixed_assets' and is_total;
  if v_amount < 0 then
    raise exception 'FAIL 19: shop C''s fixed assets read %, and a negative fixed-asset total is 1590 carrying depreciation for an asset that has been sold', v_amount;
  end if;

  --     (ee) A DISPOSAL DATED INTO A CLOSED MONTH is recognised in the open
  --         one, carrying the true date and the status -- the redirect check 16
  --         makes for a depreciation run and check 3 makes for an acquisition,
  --         and which dispose_fixed_asset had its own copy of and no test.
  --         Shop C closes June now that every June charge is posted.
  select id into v_jun_c from public.accounting_periods
   where shop_id = v_shop_c and starts_on = '2026-06-01';
  if v_jun_c is null then
    raise exception 'FIXTURE: shop C did not open a June period to close';
  end if;
  perform public.close_accounting_period(v_shop_c, v_jun_c);
  v_toaster := public.create_fixed_asset(v_shop_c, 'Toaster', 900, '2026-05-03', 120, '1000');
  v_entry := public.dispose_fixed_asset(v_toaster, '2026-06-15', 0);
  select e.entry_date, e.description into v_date, v_desc
    from public.journal_entries e where e.id = v_entry;
  if v_date is distinct from v_today then
    raise exception 'FAIL 19: a disposal dated into a CLOSED June is dated % rather than today % -- open_period_for raises on a closed month, so this would have failed outright', v_date, v_today;
  end if;
  if v_desc not like '%2026-06-15%' or v_desc not like '%closed%' then
    raise exception 'FAIL 19: the redirected disposal does not carry the true date and the period''s status: "%"', v_desc;
  end if;
  --         ...and the REGISTER keeps the true date, which is the separation
  --         the whole of depreciation_charges.charge_month exists for.
  if (select disposed_on from public.fixed_assets where id = v_toaster)
     is distinct from '2026-06-15'::date then
    raise exception 'FAIL 19: the register did not keep the true disposal date through the redirect';
  end if;

  --     (f) THE CLAMP. "Depreciate through" a date years out is a request
  --         about how far to go, not an assertion that it has happened, and a
  --         month that has not ENDED cannot be charged -- 20261005000000's rule
  --         for closing a month, for the same reason: the entry is dated the
  --         month's end and an entry dated in the future opens a period nobody
  --         has traded in. The freezer's life is 120 months, so it is due in
  --         every month there is and only the clamp stops it. Asserted as a
  --         BOUND rather than a count, so it stays true as the calendar moves.
  perform public.run_depreciation(v_shop_c, v_today + 400);
  perform set_config('role', 'postgres', true);
  select max(dc.charge_month) into v_date from public.depreciation_charges dc
   where dc.shop_id = v_shop_c;
  if v_date > (date_trunc('month', v_today) - interval '1 month')::date then
    raise exception 'FAIL 19: depreciation was charged for %, and the last month that has ENDED is % -- p_through is not clamped',
      to_char(v_date, 'FMMonth YYYY'),
      to_char((date_trunc('month', v_today) - interval '1 month')::date, 'FMMonth YYYY');
  end if;
  perform set_config('role', 'authenticated', true);

  --     (g) THE REGISTER AND THE LEDGER STILL SAY ONE NUMBER. Check 5 makes
  --         this comparison for shop A before anything has been disposed of;
  --         here it is made after four disposals, two of them at zero, and it
  --         is the assertion that catches a charge posted to 6800 and 1590 with
  --         no charge row behind it -- which is what dropping the disposal rule
  --         from the LINES alone does, leaving the register looking correct and
  --         1590 carrying depreciation nothing in the register accounts for.
  perform set_config('role', 'postgres', true);
  select coalesce(sum(dc.amount_cents), 0) into v_before
    from public.depreciation_charges dc where dc.shop_id = v_shop_c;
  perform set_config('role', 'authenticated', true);
  select coalesce(sum(l.amount_cents), 0) into v_after
    from public.journal_lines l
    join public.journal_entries e on e.id = l.entry_id
    join public.accounts a on a.id = l.account_id
   where e.shop_id = v_shop_c and a.code = '1590' and e.source = 'depreciation';
  if v_after is distinct from -v_before then
    raise exception 'FAIL 19: shop C''s charge rows total % but the depreciation entries credited 1590 by % -- the register and the ledger disagree',
      v_before, v_after;
  end if;

  --     ...and none of shop C's runs reached into another shop's register. The
  --     insert that writes the charge rows carries its own copy of the tenant
  --     filter, and it only ever runs on a month shop C itself had something
  --     due in -- which is this block and not check 17, where shop A had
  --     nothing due and the insert was never reached at all.
  perform set_config('role', 'postgres', true);
  if exists (select 1 from public.depreciation_charges dc
              join public.fixed_assets fa on fa.id = dc.asset_id
             where dc.shop_id <> fa.shop_id) then
    raise exception 'FAIL 19: a charge row belongs to a different shop from its asset';
  end if;
  if (select count(*) from public.depreciation_charges dc where dc.asset_id = v_oven)
     is distinct from 2 then
    raise exception 'FAIL 19: shop B''s oven carries % charge rows after shop C ran depreciation, expected 2 -- May, June and July are due on it and shop C picked them up',
      (select count(*) from public.depreciation_charges dc where dc.asset_id = v_oven);
  end if;
  perform set_config('role', 'authenticated', true);

  --     (h) AND SHOP C TIES TOO, with four disposals in it and two of them
  --         at figures that are zero.
  if (select amount_cents from public.balance_sheet(v_shop_c, v_today) where section = 'total_assets')
     is distinct from (select amount_cents from public.balance_sheet(v_shop_c, v_today)
                        where section = 'total_liabilities_equity') then
    raise exception 'FAIL 19: shop C''s balance sheet does not balance';
  end if;
  if (select amount_cents from public.cash_flow(v_shop_c, '2026-01-01', v_today) where section = 'net_change')
     is distinct from (select amount_cents from public.cash_flow(v_shop_c, '2026-01-01', v_today)
                        where section = 'proof' and label like 'Movement in cash%') then
    raise exception 'FAIL 19: shop C''s cash flow does not prove out -- net change % against observed movement %',
      (select amount_cents from public.cash_flow(v_shop_c, '2026-01-01', v_today) where section = 'net_change'),
      (select amount_cents from public.cash_flow(v_shop_c, '2026-01-01', v_today)
        where section = 'proof' and label like 'Movement in cash%');
  end if;
  raise notice '19 OK: a zero charge, a zero gain, zero proceeds, a sale before the books were done, and the clamp';

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
