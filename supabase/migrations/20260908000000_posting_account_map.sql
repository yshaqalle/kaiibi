-- Which account a payment method and an expense category post to.
--
-- Functions rather than a CASE inlined at each call site, because six RPCs and
-- the historical backfill all need the same answer. Two copies of this mapping
-- is how the live path and the replay come to disagree -- and Task 8's
-- verification compares one against the other, so it would pass while both
-- were wrong.
--
-- IMMUTABLE, so they can sit in an index or a generated column later without
-- being re-planned. They read nothing.

-- Raises rather than returning null: a null code reaches post_journal_entry
-- as "No such account: " with nothing after it, which is a worse message at
-- a later moment than this one.
create or replace function public.account_code_for_payment_method(p_method text)
returns text
language plpgsql immutable as $$
declare v_code text;
begin
  v_code := case p_method
    when 'cash'   then '1000'
    when 'zaad'   then '1020'
    when 'edahab' then '1021'
    -- 'other' is a transfer, not till money. Putting it in 1000 Cash would make
    -- the drawer count disagree with the ledger for a reason nobody could find.
    when 'other'  then '1010'
  end;
  if v_code is null then
    raise exception 'no account is mapped to the payment method %', coalesce(p_method, '<null>')
      using errcode = 'P0001';
  end if;
  return v_code;
end;
$$;

create or replace function public.account_code_for_expense_category(p_category text)
returns text
language plpgsql immutable as $$
declare v_code text;
begin
  v_code := case p_category
    -- The three that were never operating expenses. This mapping is what makes
    -- a balance sheet possible: NON_OPERATING_CATEGORIES in
    -- expense-reporting.ts currently reaches the right net profit by EXCLUDING
    -- these two, which is the right answer by the wrong route. Here, where each
    -- one sits becomes the reason rather than a filter.
    when 'inventory_purchase'  then '1200'  -- an asset, not a cost
    when 'owner_draw'          then '3100'  -- contra-equity, not a cost
    -- Cost of sales, ABOVE gross profit -- not operating expenses, where the
    -- Count door's stock_loss category lands today. A shop losing 3% of stock
    -- does not have the margin its P&L currently claims. This is a visible
    -- presentation change: gross profit falls, opex falls by the same amount,
    -- net profit is unchanged.
    when 'stock_loss'          then '5100'
    when 'rent'                then '6000'
    when 'utilities'           then '6100'
    when 'salaries_wages'      then '6200'
    when 'marketing'           then '6300'
    when 'supplies'            then '6400'
    when 'transport_delivery'  then '6500'
    when 'maintenance_repairs' then '6600'
    when 'fees_charges'        then '6700'
    when 'other'               then '6900'
  end;
  if v_code is null then
    raise exception 'no account is mapped to the expense category %', coalesce(p_category, '<null>')
      using errcode = 'P0001';
  end if;
  return v_code;
end;
$$;

grant execute on function public.account_code_for_payment_method(text) to authenticated;
grant execute on function public.account_code_for_expense_category(text) to authenticated;
