-- Every payment method and every expense category maps to an account that is
-- actually seeded. The point is the LAST check: it reads the enum values out of
-- the check constraint, so adding a thirteenth expense category without giving
-- it an account turns this red -- which no hand-written list of values would do.

\set ON_ERROR_STOP on

do $$
declare
  v_user_id uuid := gen_random_uuid();
  v_shop_id uuid;
  v_code    text;
  v_value   text;
  v_missing text := '';
begin
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
    values (v_user_id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            'verify-posting-map-' || v_user_id || '@example.test', '', now(), now(), now());
  insert into public.shops (owner_id, name) values (v_user_id, 'Map Shop') returning id into v_shop_id;

  -- 1. Payment methods. 'other' maps to Bank rather than Cash: a payment that
  --    is not cash and not one of the two named wallets is a transfer, and
  --    putting it in the till would make the drawer count disagree.
  if public.account_code_for_payment_method('cash')   <> '1000' then raise exception 'FAIL: cash'; end if;
  if public.account_code_for_payment_method('zaad')   <> '1020' then raise exception 'FAIL: zaad'; end if;
  if public.account_code_for_payment_method('edahab') <> '1021' then raise exception 'FAIL: edahab'; end if;
  if public.account_code_for_payment_method('other')  <> '1010' then raise exception 'FAIL: other'; end if;

  -- 2. The three that were never operating expenses. These are the whole reason
  --    a balance sheet is possible -- NON_OPERATING_CATEGORIES in
  --    expense-reporting.ts reaches the right net profit by excluding them,
  --    which is the right answer by the wrong route.
  if public.account_code_for_expense_category('inventory_purchase') <> '1200' then
    raise exception 'FAIL: inventory_purchase must be an ASSET, got %',
      public.account_code_for_expense_category('inventory_purchase');
  end if;
  if public.account_code_for_expense_category('owner_draw') <> '3100' then
    raise exception 'FAIL: owner_draw must be contra-equity, got %',
      public.account_code_for_expense_category('owner_draw');
  end if;
  if public.account_code_for_expense_category('stock_loss') <> '5100' then
    raise exception 'FAIL: stock_loss belongs in cost of sales, got %',
      public.account_code_for_expense_category('stock_loss');
  end if;

  -- 3. The nine that are.
  if public.account_code_for_expense_category('rent')                <> '6000' then raise exception 'FAIL: rent'; end if;
  if public.account_code_for_expense_category('utilities')           <> '6100' then raise exception 'FAIL: utilities'; end if;
  if public.account_code_for_expense_category('salaries_wages')      <> '6200' then raise exception 'FAIL: salaries_wages'; end if;
  if public.account_code_for_expense_category('marketing')           <> '6300' then raise exception 'FAIL: marketing'; end if;
  if public.account_code_for_expense_category('supplies')            <> '6400' then raise exception 'FAIL: supplies'; end if;
  if public.account_code_for_expense_category('transport_delivery')  <> '6500' then raise exception 'FAIL: transport_delivery'; end if;
  if public.account_code_for_expense_category('maintenance_repairs') <> '6600' then raise exception 'FAIL: maintenance_repairs'; end if;
  if public.account_code_for_expense_category('fees_charges')        <> '6700' then raise exception 'FAIL: fees_charges'; end if;
  if public.account_code_for_expense_category('other')               <> '6900' then raise exception 'FAIL: other'; end if;

  -- 4. An unmapped value RAISES rather than returning null. A null code reaches
  --    post_journal_entry as "No such account: <null>", which is a worse
  --    message at a later moment.
  begin
    v_code := public.account_code_for_expense_category('not_a_category');
    raise exception 'FAIL: an unknown category should raise, got %', v_code;
  exception when others then
    if sqlerrm !~ 'no account is mapped' then raise; end if;
  end;

  -- 5. THE ONE THAT MATTERS. Read the twelve values out of the check constraint
  --    itself and assert each maps to an account that is seeded for this shop.
  --    A hand-written list here would go stale the moment someone adds a
  --    category; this cannot.
  for v_value in
    select unnest(regexp_matches(
      (select pg_get_constraintdef(oid) from pg_constraint
        where conrelid = 'public.expenses'::regclass and conname like '%category%' limit 1),
      '''([a-z_]+)''', 'g'))
  loop
    begin
      v_code := public.account_code_for_expense_category(v_value);
    exception when others then
      v_missing := v_missing || v_value || ' (unmapped) ';
      continue;
    end;
    if not exists (select 1 from public.accounts
                    where shop_id = v_shop_id and code = v_code and archived_at is null) then
      v_missing := v_missing || v_value || ' -> ' || v_code || ' (no such account) ';
    end if;
  end loop;
  if v_missing <> '' then
    raise exception 'FAIL: expense categories with no usable account: %', v_missing;
  end if;

  raise notice 'ALL CHECKS PASSED';
  raise exception 'rollback fixture';
exception
  when others then
    if sqlerrm = 'rollback fixture' then return; end if;
    raise;
end $$;
