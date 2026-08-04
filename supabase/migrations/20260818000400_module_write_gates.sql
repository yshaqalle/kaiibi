-- Gating WRITES on what the shop's plan includes.
--
-- Implemented as TRIGGERS rather than as `and shop_has_module(...)` bolted onto
-- every write policy, which was the obvious approach and is the wrong one here.
-- Three reasons, in order of weight:
--
-- 1. RLS DOESN'T APPLY TO THE PATHS THAT MATTER MOST. Almost every interesting
--    write in this app goes through a `security definer` RPC -- complete_sale,
--    transfer_stock, post_payroll_run, record_invoice_payment,
--    log_recurring_bill, pos_create_customer -- and those bypass RLS by
--    definition. Gating policies would have left every one of them open, and
--    closing them would have meant reproducing eleven function bodies whole
--    (the house convention, 0024_permission_gates.sql:240-259) purely to insert
--    one line each. A trigger fires for all of them, for free, and cannot be
--    forgotten when a twelfth RPC is added.
-- 2. A trigger raises a typed error the client turns into an upgrade prompt.
--    A policy returns a bare 403 indistinguishable from "you lack permission".
-- 3. It leaves the permission policies exactly as they are, so the two systems
--    stay legible separately instead of being interleaved in one predicate.
--
-- INSERT AND UPDATE ONLY -- DELETE IS DELIBERATELY NEVER GATED.
--
-- Deleting must keep working at every subscription status, for three reasons
-- that all point the same way: removing a record is how a shop gets back UNDER
-- a cap (the limit message literally says "remove one, or upgrade" -- gating
-- deletes would make that advice a dead end); a cascade must never be blocked
-- by billing state, or deleting a shop or a sale could fail halfway; and a
-- business must always be able to remove its own data, whatever it has paid.
-- Blocking deletes would protect no revenue and cost real trust.

-- Raises the same shape as enforce_shop_limit(), so the client has one error
-- vocabulary for "your plan doesn't cover this".
create or replace function public.enforce_shop_module()
returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_module text := TG_ARGV[0];
begin
  if not public.shop_has_module(new.shop_id, v_module) then
    raise exception 'module_not_included'
      using errcode = 'P0001',
            detail = json_build_object('module', v_module)::text,
            hint = 'Upgrade the plan to make changes here.';
  end if;
  return new;
end;
$$;

-- Same, for a child table that reaches its shop through the product it belongs
-- to. product_location_stock is per-branch stock and carries no shop_id.
create or replace function public.enforce_shop_module_via_product()
returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_module  text := TG_ARGV[0];
  v_shop_id uuid;
begin
  select p.shop_id into v_shop_id from public.products p where p.id = new.product_id;
  if v_shop_id is not null and not public.shop_has_module(v_shop_id, v_module) then
    raise exception 'module_not_included'
      using errcode = 'P0001',
            detail = json_build_object('module', v_module)::text,
            hint = 'Upgrade the plan to make changes here.';
  end if;
  return new;
end;
$$;

create trigger products_module before insert or update on public.products
  for each row execute function public.enforce_shop_module('inventory');
create trigger product_location_stock_module before insert or update on public.product_location_stock
  for each row execute function public.enforce_shop_module_via_product('inventory');

-- Gating `sales` alone covers the whole checkout: sale_items, sale_payments and
-- the stock decrement only ever accompany a sale row, so there is nothing to
-- reach if the sale itself is refused. Their own triggers would add cost to
-- every line of every basket for no additional protection.
create trigger sales_module before insert or update on public.sales
  for each row execute function public.enforce_shop_module('pos');

-- `refunds` is deliberately NOT gated. A customer returning goods is owed their
-- money whatever the shop's billing status, and a refund is in substance a
-- reversal of a sale that was already permitted -- refusing it would make our
-- invoice the shopper's problem.

create trigger customers_module before insert or update on public.customers
  for each row execute function public.enforce_shop_module('customers');

create trigger expenses_module before insert or update on public.expenses
  for each row execute function public.enforce_shop_module('accounting');
create trigger invoices_module before insert or update on public.invoices
  for each row execute function public.enforce_shop_module('accounting');
create trigger vendors_module before insert or update on public.vendors
  for each row execute function public.enforce_shop_module('accounting');
create trigger cash_accounts_module before insert or update on public.cash_accounts
  for each row execute function public.enforce_shop_module('accounting');
create trigger recurring_bills_module before insert or update on public.recurring_bills
  for each row execute function public.enforce_shop_module('accounting');

create trigger payroll_runs_module before insert or update on public.payroll_runs
  for each row execute function public.enforce_shop_module('payroll');

create trigger budgets_module before insert or update on public.budgets
  for each row execute function public.enforce_shop_module('budgets');

create trigger promotions_module before insert or update on public.promotions
  for each row execute function public.enforce_shop_module('promotions');

create trigger shifts_module before insert or update on public.shifts
  for each row execute function public.enforce_shop_module('scheduling');

-- The Pro lever. stock_transfers has no write policy at all -- moving stock
-- between branches goes exclusively through the transfer_stock() RPC, which is
-- security definer and so bypasses RLS entirely. This trigger is the only thing
-- that gates it, which is precisely the case reason 1 in the header is about.
create trigger stock_transfers_module before insert or update on public.stock_transfers
  for each row execute function public.enforce_shop_module('multi_location');

create trigger shop_currencies_module before insert or update on public.shop_currencies
  for each row execute function public.enforce_shop_module('multi_currency');

-- Note on payroll and accounting together: post_payroll_run() writes a
-- salaries_wages expense as well as flipping the run to 'posted'. A plan with
-- payroll but not accounting would fail at the expense insert, which is correct
-- -- posting payroll IS an accounting act. Every seeded plan granting payroll
-- grants accounting too, so this only bites a hand-built plan, and it fails
-- loudly rather than writing a half-posted run.
