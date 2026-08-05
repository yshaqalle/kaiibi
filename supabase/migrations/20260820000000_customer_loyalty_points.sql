-- Customer loyalty points: earning on what a customer spends, and spending
-- those points back at the till for money off.
--
-- Two configurable rates, because one number cannot describe a programme. The
-- EARN rate (loyalty_points_per_usd) says how many points a dollar buys; the
-- REDEEM rate (loyalty_cents_per_point) says what a point is worth back. The
-- product of the two is what the programme actually costs the shop -- 1 point
-- per dollar at 1c per point is a 1% programme -- and a shop that wants a 10%
-- programme changes the second number, not the first. Splitting them also means
-- the earn rate can be presented to customers as the simple thing it is ("a
-- point for every dollar") without that sentence secretly fixing the payout.
--
-- ## A LEDGER *AND* A COUNTER, not one or the other
--
-- customer_points_ledger is the append-only truth; customers.points_balance is
-- a counter maintained from it by trigger. That looks redundant and isn't, for
-- the reason 20260818000300_usage_counters.sql gives at length for
-- shop_usage_counters: a balance that can be SPENT has to be lockable. Two
-- registers redeeming the same customer's points at the same moment must
-- serialise, and `select ... for update` needs a row to take. A sum over an
-- append-only table offers nothing to lock and costs a growing scan on every
-- checkout.
--
-- The counter pays for itself a second time on the read side. pos_search_customers
-- returns `setof public.customers` and listCustomers does `select('*')`, so a
-- column on that table puts a balance in the checkout picker and next to every
-- name in the customer list for zero new queries and zero new RPCs.
--
-- This is not the "derive it, don't store it" rule from customer-segments.ts
-- being missed. That rule is about a value recomputable from a list the client
-- already holds. This one is a sum over an unbounded table that must be locked
-- to be spent safely -- a different problem with a different answer.
--
-- The counter is moved by an AFTER INSERT trigger on the ledger rather than by
-- a line in each RPC, on the same reasoning 20260818000400 uses for the module
-- gates: a trigger cannot be forgotten when a fifth writer is added, and the
-- two can therefore never drift.
--
-- ## REDEMPTION IS A DISCOUNT, NOT A TENDER
--
-- The tempting model is "points are a payment method". It breaks this schema in
-- two places. complete_sale refuses any sale whose payments do not sum EXACTLY
-- to the total, so a points tender means either a fifth payment_method -- past
-- the check constraint on sale_payments.method, past PaymentMethod in
-- models.ts, past the picker and past every cash-drawer and takings report --
-- or a special case carved into that equality check. And a points row in
-- sale_payments would put money that never arrived into the till's takings,
-- which is exactly the number that has to reconcile against the cash in the
-- drawer at close.
--
-- As a price reduction none of that happens: the total simply comes out lower
-- and every existing invariant holds untouched. It is also the right answer for
-- tax -- a seller-funded discount is taxed on the reduced price -- which fixes
-- where it lands in the arithmetic:
--
--   line net -> subtotal -> minus transaction discount -> minus points -> tax
--
-- points_redeemed_cents is kept in its own column rather than folded into
-- sales.discount_cents, so that column keeps meaning precisely what it means
-- today (the discount a cashier chose to give) and the receipt can print the
-- two as the different things they are.
--
-- ## EARNING IS PRE-TAX, POST-EVERYTHING-ELSE, AND ROUNDED TO THE NEAREST POINT
--
-- Pre-tax because tax is collected on the state's behalf and remitted, not
-- revenue the shop is rewarding a share of -- and because otherwise the same
-- basket would earn differently the day a tax rate moves. Post-redemption
-- because points that earned points would partially regenerate themselves.
--
-- round() rather than floor(), so a $19.99 basket earns 20 points and not 19.
-- Flooring is defensible arithmetic and reads as pettiness at the counter,
-- where being a penny short of twenty dollars visibly costs a point; the shop
-- gives away at most half a point per sale to avoid that conversation.
--
-- The redemption cap is the deliberate opposite: it still FLOORS (see
-- maxRedeemablePoints in src/lib/loyalty.ts), because rounding a redemption up
-- would let points exceed the bill and turn into cash back. Generous on the way
-- in, exact on the way out.
--
-- ## THE MODULE GATE IS INSIDE THE RPCs, AND HAS TO BE
--
-- public.customers carries enforce_shop_module('customers') as a BEFORE INSERT
-- OR UPDATE trigger (20260818000400:87). `security definer` bypasses RLS. It
-- does NOT bypass a trigger. So on a shop whose plan has lapsed, the one-line
-- balance update inside complete_sale would raise module_not_included and take
-- the entire sale down with it -- a shop that stopped paying for the customers
-- module would find it could no longer sell anything.
--
-- Every loyalty block in all four RPCs is therefore gated on an explicit
-- shop_has_module(shop_id, 'customers') and skipped silently when it is false.
-- A lapsed shop can still sell, refund, edit and delete; it simply stops
-- earning. The trigger on the ledger table is then only belt-and-braces against
-- a direct write.
--
-- Loyalty rides on the existing `customers` module rather than adding a
-- `loyalty` one: it is unusable without customer records, so a plan that
-- includes one and not the other describes nothing a shop would buy.
--
-- No new permission key either. Reads are covered by customers.view / pos.access
-- / sales.view; every write happens inside an RPC already gated by pos.access
-- or sales.refund. A manual points-adjustment screen would need its own key --
-- deliberately not built here.
--
-- ## DELIBERATELY NOT DONE
--
-- No point expiry, no tiers, no minimum-redemption threshold, no manual
-- adjustment UI, and no points on the receipt for a walk-in. All of them are
-- additions to this shape rather than changes to it.

-- ---------------------------------------------------------------------------
-- Settings, on shops, next to tax -- the same toggle-plus-rate shape as 0015.
-- ---------------------------------------------------------------------------

alter table public.shops
  add column if not exists loyalty_enabled boolean not null default false,
  add column if not exists loyalty_points_per_usd numeric(8,2) not null default 1
    check (loyalty_points_per_usd >= 0),
  add column if not exists loyalty_cents_per_point integer not null default 1
    check (loyalty_cents_per_point > 0);

comment on column public.shops.loyalty_points_per_usd is
  'Points earned per USD of pre-tax, post-discount spend. Default 1.';
comment on column public.shops.loyalty_cents_per_point is
  'What one point is worth when spent, in cents. Integer so a redemption is
   always exact and never rounds. Default 1, i.e. 100 points = $1.00.';

-- ---------------------------------------------------------------------------
-- Per-sale record. Frozen at the till, like tax_rate_percent and
-- sale_items.unit_cost_cents: changing the programme must never restate a
-- receipt that has already been printed and handed over.
-- ---------------------------------------------------------------------------

alter table public.sales
  add column if not exists points_earned integer not null default 0
    check (points_earned >= 0),
  add column if not exists points_redeemed integer not null default 0
    check (points_redeemed >= 0),
  add column if not exists points_redeemed_cents integer not null default 0
    check (points_redeemed_cents >= 0),
  add column if not exists loyalty_points_per_usd numeric(8,2);

comment on column public.sales.loyalty_points_per_usd is
  'The earn rate that produced points_earned, snapshotted. Null when the sale
   earned nothing (no customer, loyalty off, or the plan lacked the module).';

-- ---------------------------------------------------------------------------
-- Balance and ledger.
-- ---------------------------------------------------------------------------

alter table public.customers
  add column if not exists points_balance integer not null default 0;

comment on column public.customers.points_balance is
  'Trigger-maintained sum of customer_points_ledger.delta_points. Stored rather
   than summed so a redemption has a row to lock -- see the header of
   20260820000000_customer_loyalty_points.sql.';

create table if not exists public.customer_points_ledger (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  customer_id uuid not null references public.customers(id) on delete cascade,
  -- Null once the sale it came from is deleted; delete_sale posts reversing
  -- rows before that happens, so the balance stays right either way.
  sale_id uuid references public.sales(id) on delete set null,
  refund_id uuid references public.refunds(id) on delete set null,
  delta_points integer not null check (delta_points <> 0),
  reason text not null check (reason in
    ('earn', 'redeem', 'refund_clawback', 'redeem_reversed', 'adjustment')),
  -- Whichever rate actually produced this row, so a balance can be re-derived
  -- years later without reference to the shop's current settings.
  points_per_usd numeric(8,2),
  cents_per_point integer,
  note text,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create index if not exists customer_points_ledger_shop_id_idx
  on public.customer_points_ledger(shop_id);
create index if not exists customer_points_ledger_customer_id_idx
  on public.customer_points_ledger(customer_id, created_at desc);
create index if not exists customer_points_ledger_sale_id_idx
  on public.customer_points_ledger(sale_id);

alter table public.customer_points_ledger enable row level security;

-- Readable from anywhere a customer or a sale is: the customer screen, the POS
-- picker, and the sales history all have a reason to show why a balance is what
-- it is.
--
-- Dropped first so the whole migration is re-runnable: every other statement
-- here is already `if not exists` or `create or replace`, and a bare `create
-- policy` on a second pass would be the one thing that aborts it.
drop policy if exists "read points ledger" on public.customer_points_ledger;
create policy "read points ledger" on public.customer_points_ledger for select
  using (has_any_shop_permission(shop_id, array['customers.view', 'pos.access', 'sales.view']));

-- No insert, update or delete policy at all, on purpose. Every row is written
-- by the security-definer RPCs below, which is what guarantees the ledger and
-- the balance can never disagree -- a hand-written insert would move one and
-- not the other, and there would be no way to tell afterwards which was right.
grant select on public.customer_points_ledger to authenticated;

drop trigger if exists customer_points_ledger_module on public.customer_points_ledger;
create trigger customer_points_ledger_module before insert or update
  on public.customer_points_ledger
  for each row execute function public.enforce_shop_module('customers');

create or replace function public.apply_points_ledger_delta()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update public.customers
    set points_balance = points_balance + new.delta_points
    where id = new.customer_id;
  return null;
end;
$$;

comment on function public.apply_points_ledger_delta() is
  'Keeps customers.points_balance in step with the ledger. A trigger rather than
   a line in each RPC so it cannot be forgotten by a future writer.';

drop trigger if exists customer_points_ledger_apply on public.customer_points_ledger;
create trigger customer_points_ledger_apply after insert
  on public.customer_points_ledger
  for each row execute function public.apply_points_ledger_delta();

-- ---------------------------------------------------------------------------
-- complete_sale, gaining p_points_redeemed.
--
-- Reproduced whole from 20260810000100_sale_rpcs_location_stock.sql per the
-- house convention. Everything about stock, locations, line discounts, tax and
-- payments is carried across unmodified; the only new arithmetic is the
-- redemption subtracted before tax and the earn computed from the result.
-- ---------------------------------------------------------------------------

drop function if exists public.complete_sale(uuid, jsonb, jsonb, text, text, text, text, integer, uuid, timestamptz, uuid);

create or replace function public.complete_sale(
  p_shop_id uuid,
  p_items jsonb,
  p_payments jsonb,
  p_customer_name text default null,
  p_customer_phone text default null,
  p_customer_email text default null,
  p_cashier_name text default null,
  p_discount_cents integer default 0,
  p_customer_id uuid default null,
  p_created_at timestamptz default null,
  p_location_id uuid default null,
  p_points_redeemed integer default 0
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_sale_id uuid;
  v_location_id uuid;
  v_item jsonb;
  v_payment jsonb;
  v_product public.products%rowtype;
  v_available integer;
  v_qty integer;
  v_line integer;
  v_line_discount integer;
  v_gross_cents integer := 0;
  v_total_cents integer := 0;
  v_item_count integer := 0;
  v_payments_total integer := 0;
  v_primary_method text;
  v_discount_cents integer := greatest(coalesce(p_discount_cents, 0), 0);
  v_tax_enabled boolean;
  v_tax_rate numeric;
  v_tax_cents integer := 0;
  v_loyalty_enabled boolean;
  v_points_per_usd numeric;
  v_cents_per_point integer;
  v_loyalty_active boolean := false;
  v_points_redeemed integer := greatest(coalesce(p_points_redeemed, 0), 0);
  v_redeem_cents integer := 0;
  v_balance integer;
  v_points_earned integer := 0;
begin
  if not public.has_shop_permission(p_shop_id, 'pos.access') then
    raise exception 'not authorized for shop %', p_shop_id;
  end if;
  if p_payments is null or jsonb_array_length(p_payments) = 0 then
    raise exception 'at least one payment is required';
  end if;

  if p_location_id is null then
    select l.id into v_location_id from public.shop_locations l
      where l.shop_id = p_shop_id
      order by l.is_primary desc, l.created_at asc
      limit 1;
    if v_location_id is null then
      raise exception 'shop % has no location to record this sale against', p_shop_id;
    end if;
  else
    select l.id into v_location_id from public.shop_locations l
      where l.id = p_location_id and l.shop_id = p_shop_id;
    if v_location_id is null then
      raise exception 'location % does not belong to shop %', p_location_id, p_shop_id;
    end if;
    if not public.can_access_location(v_location_id) then
      raise exception 'not authorized for location %', p_location_id;
    end if;
  end if;

  v_primary_method := p_payments->0->>'method';
  if v_primary_method not in ('cash','zaad','edahab','other') then
    raise exception 'invalid payment method %', v_primary_method;
  end if;

  select tax_enabled, tax_rate_percent,
         loyalty_enabled, loyalty_points_per_usd, loyalty_cents_per_point
    into v_tax_enabled, v_tax_rate,
         v_loyalty_enabled, v_points_per_usd, v_cents_per_point
    from public.shops where id = p_shop_id;

  -- The module check is not belt and braces. public.customers and
  -- customer_points_ledger both carry enforce_shop_module('customers') as a
  -- BEFORE trigger, and security definer does not bypass a trigger -- so
  -- touching either on a lapsed shop would raise module_not_included and refuse
  -- the whole sale. A shop that stops paying must still be able to sell.
  v_loyalty_active := coalesce(v_loyalty_enabled, false)
    and p_customer_id is not null
    and public.shop_has_module(p_shop_id, 'customers');

  if v_points_redeemed > 0 and not v_loyalty_active then
    raise exception 'loyalty points cannot be redeemed on this sale';
  end if;

  insert into public.sales (shop_id, location_id, created_by, payment_method, customer_name, customer_phone, customer_email, cashier_name, discount_cents, customer_id, created_at)
    values (p_shop_id, v_location_id, auth.uid(), v_primary_method, nullif(p_customer_name, ''), nullif(p_customer_phone, ''), nullif(p_customer_email, ''), nullif(p_cashier_name, ''), v_discount_cents, p_customer_id, coalesce(p_created_at, now()))
    returning id into v_sale_id;

  for v_item in select * from jsonb_array_elements(p_items) loop
    v_qty := (v_item->>'quantity')::integer;
    if v_qty is null or v_qty <= 0 then
      raise exception 'invalid quantity in cart item';
    end if;

    select * into v_product from public.products
      where id = (v_item->>'product_id')::uuid and shop_id = p_shop_id;

    if v_product.id is null then
      raise exception 'product % not found in this shop', v_item->>'product_id';
    end if;

    select stock into v_available from public.product_location_stock
      where product_id = v_product.id and location_id = v_location_id
      for update;

    if coalesce(v_available, 0) < v_qty then
      raise exception 'insufficient stock for % at this location: has %, need %',
        v_product.name, coalesce(v_available, 0), v_qty;
    end if;

    v_line_discount := greatest(coalesce((v_item->>'discount_cents')::integer, 0), 0);
    v_line := v_product.price_cents * v_qty - v_line_discount;
    if v_line < 0 then
      raise exception 'discount exceeds line total for %', v_product.name;
    end if;

    update public.product_location_stock set stock = stock - v_qty, updated_at = now()
      where product_id = v_product.id and location_id = v_location_id;

    insert into public.sale_items (sale_id, product_id, product_name, unit_price_cents, quantity, line_total_cents, discount_cents, unit_cost_cents)
      values (v_sale_id, v_product.id, v_product.name, v_product.price_cents, v_qty, v_line, v_line_discount, v_product.cost_cents);

    v_gross_cents := v_gross_cents + v_line;
    v_item_count := v_item_count + v_qty;
  end loop;

  if v_item_count = 0 then
    raise exception 'cannot complete a sale with no items';
  end if;

  v_total_cents := v_gross_cents - v_discount_cents;
  if v_total_cents < 0 then
    raise exception 'discount exceeds sale total';
  end if;

  if v_points_redeemed > 0 then
    -- The lock that makes the balance check atomic across two registers. Taken
    -- on the counter rather than by summing the ledger, for the reason
    -- shop_usage_counters gives: a sum is neither O(1) nor safe under
    -- concurrency -- both tills read the same balance and both pass.
    select points_balance into v_balance from public.customers
      where id = p_customer_id and shop_id = p_shop_id
      for update;
    if v_balance is null then
      raise exception 'customer % not found in this shop', p_customer_id;
    end if;
    if v_points_redeemed > v_balance then
      raise exception 'customer has % points, cannot redeem %', v_balance, v_points_redeemed;
    end if;

    v_redeem_cents := v_points_redeemed * v_cents_per_point;

    -- Raise rather than clamp. The client has already collected payment against
    -- a total computed with this redemption, so quietly spending fewer points
    -- would leave the payments short and fail the equality check below with a
    -- message that names neither the cause nor the fix.
    if v_redeem_cents > v_total_cents then
      raise exception 'redeeming % points is worth % cents, more than the % cents owed',
        v_points_redeemed, v_redeem_cents, v_total_cents;
    end if;

    v_total_cents := v_total_cents - v_redeem_cents;
  end if;

  -- Earned on merchandise actually paid for in money: after every discount
  -- including the redemption, and before tax. Rounded to the nearest whole
  -- point, so $19.99 earns 20.
  if v_loyalty_active then
    v_points_earned := round(v_total_cents * v_points_per_usd / 100)::integer;
  end if;

  if v_tax_enabled then
    v_tax_cents := round(v_total_cents * v_tax_rate / 100)::integer;
  end if;
  v_total_cents := v_total_cents + v_tax_cents;

  for v_payment in select * from jsonb_array_elements(p_payments) loop
    if (v_payment->>'method') not in ('cash','zaad','edahab','other') then
      raise exception 'invalid payment method %', v_payment->>'method';
    end if;
    if (v_payment->>'amount_cents')::integer <= 0 then
      raise exception 'payment amount must be greater than zero';
    end if;
    v_payments_total := v_payments_total + (v_payment->>'amount_cents')::integer;

    insert into public.sale_payments (sale_id, method, amount_cents, tendered_cents, customer_name, customer_phone, currency_code, exchange_rate, foreign_amount_cents, foreign_change_cents)
      values (
        v_sale_id,
        v_payment->>'method',
        (v_payment->>'amount_cents')::integer,
        (v_payment->>'tendered_cents')::integer,
        v_payment->>'customer_name',
        v_payment->>'customer_phone',
        nullif(v_payment->>'currency_code', ''),
        (v_payment->>'exchange_rate')::numeric,
        (v_payment->>'foreign_amount_cents')::integer,
        (v_payment->>'foreign_change_cents')::integer
      );
  end loop;

  if v_payments_total <> v_total_cents then
    raise exception 'payments total % does not match sale total %', v_payments_total, v_total_cents;
  end if;

  update public.sales set
    total_cents = v_total_cents,
    item_count = v_item_count,
    tax_cents = v_tax_cents,
    tax_rate_percent = case when v_tax_enabled then v_tax_rate else null end,
    points_redeemed = v_points_redeemed,
    points_redeemed_cents = v_redeem_cents,
    points_earned = v_points_earned,
    loyalty_points_per_usd = case when v_loyalty_active then v_points_per_usd else null end
  where id = v_sale_id;

  -- Two rows, never one net row. "Spent 200, earned 3" is what a customer
  -- querying their balance needs to see; a net -197 hides both facts and
  -- answers no question anyone actually asks.
  --
  -- Written after the payments check, so a sale that gets refused moves no
  -- points.
  if v_points_redeemed > 0 then
    insert into public.customer_points_ledger
      (shop_id, customer_id, sale_id, delta_points, reason, cents_per_point, created_by)
      values (p_shop_id, p_customer_id, v_sale_id, -v_points_redeemed, 'redeem',
              v_cents_per_point, auth.uid());
  end if;
  if v_points_earned > 0 then
    insert into public.customer_points_ledger
      (shop_id, customer_id, sale_id, delta_points, reason, points_per_usd, created_by)
      values (p_shop_id, p_customer_id, v_sale_id, v_points_earned, 'earn',
              v_points_per_usd, auth.uid());
  end if;

  return v_sale_id;
end;
$$;

grant execute on function public.complete_sale(uuid, jsonb, jsonb, text, text, text, text, integer, uuid, timestamptz, uuid, integer) to authenticated;

-- ---------------------------------------------------------------------------
-- edit_sale. Signature unchanged -- the editor corrects WHAT was sold, and has
-- no control for points.
--
-- Two things must happen here or editing a sale that used points silently
-- breaks it. First, the carried-through redemption has to come off the
-- recomputed total, or the total jumps by the redeemed amount and the payments
-- equality check rejects an edit that changed nothing. Second, the earn has to
-- be recomputed and the difference posted.
--
-- The earn is recomputed at the sale's OWN frozen rate, not the shop's current
-- one. This deliberately differs from how tax is handled two lines away (re-read
-- from the shop): a tax rate is a legal fact of the date and the state's answer
-- is the state's answer, but an earn rate is a promise made to a customer at
-- the till. Re-earning a corrected sale at today's rate would quietly restate
-- what that customer was told they had.
--
-- The redeem ledger row is left alone even when the edit reassigns the sale to
-- a different customer. Those points really were spent, by that person, to fund
-- the discount this sale still carries; moving the row would make the ledger
-- describe something that did not happen.
-- ---------------------------------------------------------------------------

create or replace function public.edit_sale(
  p_sale_id uuid,
  p_items jsonb,
  p_payments jsonb,
  p_customer_name text default null,
  p_customer_phone text default null,
  p_customer_email text default null,
  p_discount_cents integer default 0,
  p_customer_id uuid default null
) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_shop_id uuid;
  v_location_id uuid;
  v_snapshot jsonb;
  v_old_item record;
  v_item jsonb;
  v_payment jsonb;
  v_product public.products%rowtype;
  v_available integer;
  v_qty integer;
  v_line integer;
  v_line_discount integer;
  v_gross_cents integer := 0;
  v_total_cents integer := 0;
  v_item_count integer := 0;
  v_payments_total integer := 0;
  v_discount_cents integer := greatest(coalesce(p_discount_cents, 0), 0);
  v_tax_enabled boolean;
  v_tax_rate numeric;
  v_tax_cents integer := 0;
  v_shop_points_per_usd numeric;
  v_sale_points_per_usd numeric;
  v_rate_used numeric;
  v_loyalty_enabled boolean;
  v_loyalty_active boolean := false;
  v_old_customer_id uuid;
  v_points_earned_old integer;
  v_points_redeemed_cents integer;
  v_points_earned_new integer := 0;
  v_points_delta integer;
begin
  select shop_id, location_id, customer_id, points_earned, points_redeemed_cents,
         loyalty_points_per_usd
    into v_shop_id, v_location_id, v_old_customer_id, v_points_earned_old,
         v_points_redeemed_cents, v_sale_points_per_usd
    from public.sales where id = p_sale_id;
  if v_shop_id is null then
    raise exception 'sale % not found', p_sale_id;
  end if;
  if not public.has_shop_permission(v_shop_id, 'sales.edit') then
    raise exception 'not authorized for sale %', p_sale_id;
  end if;
  if p_items is null or jsonb_array_length(p_items) = 0 then
    raise exception 'a sale must have at least one item';
  end if;
  if p_payments is null or jsonb_array_length(p_payments) = 0 then
    raise exception 'at least one payment is required';
  end if;

  v_points_earned_old := coalesce(v_points_earned_old, 0);
  v_points_redeemed_cents := coalesce(v_points_redeemed_cents, 0);

  select tax_enabled, tax_rate_percent, loyalty_enabled, loyalty_points_per_usd
    into v_tax_enabled, v_tax_rate, v_loyalty_enabled, v_shop_points_per_usd
    from public.shops where id = v_shop_id;

  v_loyalty_active := coalesce(v_loyalty_enabled, false)
    and public.shop_has_module(v_shop_id, 'customers');
  v_rate_used := coalesce(v_sale_points_per_usd, v_shop_points_per_usd);

  select jsonb_build_object(
    'total_cents', s.total_cents,
    'item_count', s.item_count,
    'payment_method', s.payment_method,
    'customer_name', s.customer_name,
    'customer_phone', s.customer_phone,
    'customer_email', s.customer_email,
    'discount_cents', s.discount_cents,
    'customer_id', s.customer_id,
    'points_earned', s.points_earned,
    'points_redeemed', s.points_redeemed,
    'points_redeemed_cents', s.points_redeemed_cents,
    'items', (select coalesce(jsonb_agg(jsonb_build_object(
        'product_id', si.product_id, 'product_name', si.product_name,
        'unit_price_cents', si.unit_price_cents, 'quantity', si.quantity,
        'line_total_cents', si.line_total_cents, 'discount_cents', si.discount_cents,
        'unit_cost_cents', si.unit_cost_cents
      )), '[]'::jsonb) from public.sale_items si where si.sale_id = p_sale_id),
    'payments', (select coalesce(jsonb_agg(jsonb_build_object(
        'method', sp.method, 'amount_cents', sp.amount_cents, 'tendered_cents', sp.tendered_cents,
        'customer_name', sp.customer_name, 'customer_phone', sp.customer_phone
      )), '[]'::jsonb) from public.sale_payments sp where sp.sale_id = p_sale_id)
  ) into v_snapshot
  from public.sales s where s.id = p_sale_id;

  insert into public.sale_edits (sale_id, edited_by, previous_snapshot)
    values (p_sale_id, auth.uid(), v_snapshot);

  for v_old_item in select product_id, quantity from public.sale_items where sale_id = p_sale_id loop
    if v_old_item.product_id is not null then
      insert into public.product_location_stock (product_id, location_id, stock)
        values (v_old_item.product_id, v_location_id, v_old_item.quantity)
        on conflict (product_id, location_id)
        do update set stock = public.product_location_stock.stock + excluded.stock, updated_at = now();
    end if;
  end loop;

  delete from public.sale_items where sale_id = p_sale_id;
  delete from public.sale_payments where sale_id = p_sale_id;

  for v_item in select * from jsonb_array_elements(p_items) loop
    v_qty := (v_item->>'quantity')::integer;
    if v_qty is null or v_qty <= 0 then
      raise exception 'invalid quantity in sale item';
    end if;

    select * into v_product from public.products
      where id = (v_item->>'product_id')::uuid and shop_id = v_shop_id;

    if v_product.id is null then
      raise exception 'product % not found in this shop', v_item->>'product_id';
    end if;

    select stock into v_available from public.product_location_stock
      where product_id = v_product.id and location_id = v_location_id
      for update;

    if coalesce(v_available, 0) < v_qty then
      raise exception 'insufficient stock for % at this location: has %, need %',
        v_product.name, coalesce(v_available, 0), v_qty;
    end if;

    v_line_discount := greatest(coalesce((v_item->>'discount_cents')::integer, 0), 0);
    v_line := v_product.price_cents * v_qty - v_line_discount;
    if v_line < 0 then
      raise exception 'discount exceeds line total for %', v_product.name;
    end if;

    update public.product_location_stock set stock = stock - v_qty, updated_at = now()
      where product_id = v_product.id and location_id = v_location_id;

    insert into public.sale_items (sale_id, product_id, product_name, unit_price_cents, quantity, line_total_cents, discount_cents, unit_cost_cents)
      values (p_sale_id, v_product.id, v_product.name, v_product.price_cents, v_qty, v_line, v_line_discount, v_product.cost_cents);

    v_gross_cents := v_gross_cents + v_line;
    v_item_count := v_item_count + v_qty;
  end loop;

  if v_item_count = 0 then
    raise exception 'cannot save a sale with no items';
  end if;

  -- The redemption carries through untouched: the customer spent those points
  -- and got that money off, and an edit that corrects a quantity is not a
  -- reason to take the discount back.
  v_total_cents := v_gross_cents - v_discount_cents - v_points_redeemed_cents;
  if v_total_cents < 0 then
    raise exception 'discount exceeds sale total';
  end if;

  if v_loyalty_active and p_customer_id is not null then
    v_points_earned_new := round(v_total_cents * v_rate_used / 100)::integer;
  end if;

  if v_tax_enabled then
    v_tax_cents := round(v_total_cents * v_tax_rate / 100)::integer;
  end if;
  v_total_cents := v_total_cents + v_tax_cents;

  for v_payment in select * from jsonb_array_elements(p_payments) loop
    if (v_payment->>'method') not in ('cash','zaad','edahab','other') then
      raise exception 'invalid payment method %', v_payment->>'method';
    end if;
    if (v_payment->>'amount_cents')::integer <= 0 then
      raise exception 'payment amount must be greater than zero';
    end if;
    v_payments_total := v_payments_total + (v_payment->>'amount_cents')::integer;

    insert into public.sale_payments (sale_id, method, amount_cents, tendered_cents, customer_name, customer_phone, currency_code, exchange_rate, foreign_amount_cents, foreign_change_cents)
      values (
        p_sale_id,
        v_payment->>'method',
        (v_payment->>'amount_cents')::integer,
        (v_payment->>'tendered_cents')::integer,
        v_payment->>'customer_name',
        v_payment->>'customer_phone',
        nullif(v_payment->>'currency_code', ''),
        (v_payment->>'exchange_rate')::numeric,
        (v_payment->>'foreign_amount_cents')::integer,
        (v_payment->>'foreign_change_cents')::integer
      );
  end loop;

  if v_payments_total <> v_total_cents then
    raise exception 'payments total % does not match sale total %', v_payments_total, v_total_cents;
  end if;

  update public.sales set
    total_cents = v_total_cents,
    item_count = v_item_count,
    payment_method = p_payments->0->>'method',
    customer_name = nullif(p_customer_name, ''),
    customer_phone = nullif(p_customer_phone, ''),
    customer_email = nullif(p_customer_email, ''),
    customer_id = p_customer_id,
    discount_cents = v_discount_cents,
    tax_cents = v_tax_cents,
    tax_rate_percent = case when v_tax_enabled then v_tax_rate else null end,
    points_earned = v_points_earned_new,
    loyalty_points_per_usd = case when v_points_earned_new > 0 then v_rate_used else null end
  where id = p_sale_id;

  -- When the sale still belongs to the same person the two movements collapse
  -- into one delta row; when the edit reassigned it, the original earner gives
  -- the points back and the new one earns from scratch.
  if v_old_customer_id is not distinct from p_customer_id then
    v_points_delta := v_points_earned_new - v_points_earned_old;
    if v_points_delta <> 0 and p_customer_id is not null then
      insert into public.customer_points_ledger
        (shop_id, customer_id, sale_id, delta_points, reason, points_per_usd, note, created_by)
        values (v_shop_id, p_customer_id, p_sale_id, v_points_delta, 'adjustment',
                v_rate_used, 'sale edited', auth.uid());
    end if;
  else
    if v_old_customer_id is not null and v_points_earned_old > 0 then
      insert into public.customer_points_ledger
        (shop_id, customer_id, sale_id, delta_points, reason, note, created_by)
        values (v_shop_id, v_old_customer_id, p_sale_id, -v_points_earned_old,
                'adjustment', 'sale reassigned to another customer', auth.uid());
    end if;
    if p_customer_id is not null and v_points_earned_new > 0 then
      insert into public.customer_points_ledger
        (shop_id, customer_id, sale_id, delta_points, reason, points_per_usd, note, created_by)
        values (v_shop_id, p_customer_id, p_sale_id, v_points_earned_new, 'adjustment',
                v_rate_used, 'sale reassigned to this customer', auth.uid());
    end if;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- delete_sale. Without the reversal here, deleting a sale would leave its
-- points in the balance forever: the ledger's sale_id is `on delete set null`,
-- so the rows survive their sale and keep counting.
--
-- Reversing rows rather than deleting the originals, because the ledger is
-- append-only and "these points were earned and then the sale was voided" is a
-- different and more useful history than "these points never existed".
-- ---------------------------------------------------------------------------

create or replace function public.delete_sale(p_sale_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_shop_id uuid;
  v_location_id uuid;
  v_item record;
  v_customer_id uuid;
  v_points_earned integer;
  v_points_redeemed integer;
begin
  select shop_id, location_id, customer_id, points_earned, points_redeemed
    into v_shop_id, v_location_id, v_customer_id, v_points_earned, v_points_redeemed
    from public.sales where id = p_sale_id;
  if v_shop_id is null then
    raise exception 'sale % not found', p_sale_id;
  end if;
  if not public.has_shop_permission(v_shop_id, 'sales.edit') then
    raise exception 'not authorized for sale %', p_sale_id;
  end if;

  for v_item in select product_id, quantity from public.sale_items where sale_id = p_sale_id loop
    if v_item.product_id is not null then
      insert into public.product_location_stock (product_id, location_id, stock)
        values (v_item.product_id, v_location_id, v_item.quantity)
        on conflict (product_id, location_id)
        do update set stock = public.product_location_stock.stock + excluded.stock, updated_at = now();
    end if;
  end loop;

  -- sale_id is deliberately left null on these rows: the sale they would point
  -- at is about to stop existing.
  if v_customer_id is not null and public.shop_has_module(v_shop_id, 'customers') then
    if coalesce(v_points_earned, 0) > 0 then
      insert into public.customer_points_ledger
        (shop_id, customer_id, delta_points, reason, note, created_by)
        values (v_shop_id, v_customer_id, -v_points_earned, 'adjustment',
                'sale deleted', auth.uid());
    end if;
    if coalesce(v_points_redeemed, 0) > 0 then
      insert into public.customer_points_ledger
        (shop_id, customer_id, delta_points, reason, note, created_by)
        values (v_shop_id, v_customer_id, v_points_redeemed, 'adjustment',
                'sale deleted', auth.uid());
    end if;
  end if;

  delete from public.sales where id = p_sale_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- refund_sale_items. Points move with the money.
-- ---------------------------------------------------------------------------

create or replace function public.refund_sale_items(p_sale_id uuid, p_items jsonb)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_shop_id uuid;
  v_location_id uuid;
  v_refund_id uuid;
  v_item jsonb;
  v_sale_item public.sale_items%rowtype;
  v_requested_qty integer;
  v_already_refunded_qty integer;
  v_new_cum_qty integer;
  v_cum_amount integer;
  v_prior_amount integer;
  v_refund_amount integer;
  v_total_cents integer := 0;
  v_customer_id uuid;
  v_points_earned integer;
  v_points_redeemed integer;
  v_sale_gross_cents integer;
  v_prior_refunded_cents integer;
  v_cum_refunded_cents integer;
  v_prior_clawback integer;
  v_cum_clawback integer;
  v_remaining_qty integer;
  v_loyalty_active boolean := false;
begin
  select shop_id, location_id, customer_id, points_earned, points_redeemed
    into v_shop_id, v_location_id, v_customer_id, v_points_earned, v_points_redeemed
    from public.sales where id = p_sale_id;
  if v_shop_id is null then
    raise exception 'sale % not found', p_sale_id;
  end if;
  if not public.has_shop_permission(v_shop_id, 'sales.refund') then
    raise exception 'not authorized for sale %', p_sale_id;
  end if;
  if p_items is null or jsonb_array_length(p_items) = 0 then
    raise exception 'a refund must include at least one item';
  end if;

  v_points_earned := coalesce(v_points_earned, 0);
  v_points_redeemed := coalesce(v_points_redeemed, 0);
  v_loyalty_active := v_customer_id is not null
    and public.shop_has_module(v_shop_id, 'customers');

  -- Read before the new refund row exists, so this is strictly what earlier
  -- refunds took.
  select coalesce(sum(ri.amount_cents), 0) into v_prior_refunded_cents
    from public.refund_items ri
    join public.refunds r on r.id = ri.refund_id
   where r.sale_id = p_sale_id;
  select coalesce(sum(line_total_cents), 0) into v_sale_gross_cents
    from public.sale_items where sale_id = p_sale_id;

  insert into public.refunds (sale_id, refunded_by) values (p_sale_id, auth.uid())
    returning id into v_refund_id;

  for v_item in select value from jsonb_array_elements(p_items) as t(value) order by (value->>'sale_item_id') loop
    v_requested_qty := (v_item->>'quantity')::integer;
    if v_requested_qty is null or v_requested_qty <= 0 then
      raise exception 'invalid refund quantity';
    end if;

    select * into v_sale_item from public.sale_items
      where id = (v_item->>'sale_item_id')::uuid and sale_id = p_sale_id
      for update;
    if v_sale_item.id is null then
      raise exception 'sale item % not found on sale %', v_item->>'sale_item_id', p_sale_id;
    end if;

    select coalesce(sum(quantity), 0) into v_already_refunded_qty
      from public.refund_items where sale_item_id = v_sale_item.id;

    v_new_cum_qty := v_already_refunded_qty + v_requested_qty;
    if v_new_cum_qty > v_sale_item.quantity then
      raise exception 'refund exceeds remaining quantity for %', v_sale_item.product_name;
    end if;

    v_cum_amount := round(v_sale_item.line_total_cents::numeric * v_new_cum_qty / v_sale_item.quantity);
    v_prior_amount := round(v_sale_item.line_total_cents::numeric * v_already_refunded_qty / v_sale_item.quantity);
    v_refund_amount := v_cum_amount - v_prior_amount;

    if v_sale_item.product_id is not null then
      insert into public.product_location_stock (product_id, location_id, stock)
        values (v_sale_item.product_id, v_location_id, v_requested_qty)
        on conflict (product_id, location_id)
        do update set stock = public.product_location_stock.stock + excluded.stock, updated_at = now();
    end if;

    insert into public.refund_items (refund_id, sale_item_id, product_id, quantity, amount_cents)
      values (v_refund_id, v_sale_item.id, v_sale_item.product_id, v_requested_qty, v_refund_amount);

    v_total_cents := v_total_cents + v_refund_amount;
  end loop;

  -- Earned points claw back in proportion to the money going back. Computed
  -- cumulatively against everything ever refunded on this sale and then
  -- differenced -- the same technique the per-line amounts above use, so
  -- refunding three items one at a time claws back exactly what refunding all
  -- three at once would, with no rounding drift and no way to end up owing the
  -- customer points they never had.
  if v_loyalty_active and v_points_earned > 0 and v_sale_gross_cents > 0 then
    v_cum_refunded_cents := v_prior_refunded_cents + v_total_cents;
    v_prior_clawback := least(v_points_earned,
      floor(v_points_earned::numeric * v_prior_refunded_cents / v_sale_gross_cents)::integer);
    v_cum_clawback := least(v_points_earned,
      floor(v_points_earned::numeric * v_cum_refunded_cents / v_sale_gross_cents)::integer);
    if v_cum_clawback - v_prior_clawback > 0 then
      insert into public.customer_points_ledger
        (shop_id, customer_id, sale_id, refund_id, delta_points, reason, created_by)
        values (v_shop_id, v_customer_id, p_sale_id, v_refund_id,
                -(v_cum_clawback - v_prior_clawback), 'refund_clawback', auth.uid());
    end if;
  end if;

  -- Redeemed points come back only when the WHOLE sale has gone back --
  -- all or nothing, exactly once. The redemption was an order-level price
  -- reduction attributable to no single line, so pro-rating it across a partial
  -- return would be an invented number; and a customer keeping half the basket
  -- keeps the discount they got on it.
  --
  -- The balance is allowed to go negative as a result. Refusing a refund
  -- because the customer already spent the points they earned would be absurd,
  -- and a negative balance is the honest record of what happened.
  if v_loyalty_active and v_points_redeemed > 0 then
    select coalesce(sum(si.quantity), 0)
         - coalesce((select sum(ri.quantity)
                       from public.refund_items ri
                       join public.sale_items si2 on si2.id = ri.sale_item_id
                      where si2.sale_id = p_sale_id), 0)
      into v_remaining_qty
      from public.sale_items si where si.sale_id = p_sale_id;

    if v_remaining_qty <= 0 and not exists (
      select 1 from public.customer_points_ledger
       where sale_id = p_sale_id and reason = 'redeem_reversed'
    ) then
      insert into public.customer_points_ledger
        (shop_id, customer_id, sale_id, refund_id, delta_points, reason, created_by)
        values (v_shop_id, v_customer_id, p_sale_id, v_refund_id, v_points_redeemed,
                'redeem_reversed', auth.uid());
    end if;
  end if;

  update public.refunds set total_cents = v_total_cents where id = v_refund_id;
  return v_refund_id;
end;
$$;
