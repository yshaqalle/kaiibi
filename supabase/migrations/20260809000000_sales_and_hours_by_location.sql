-- Phase 1 of multi-location: a sale records WHERE it happened, and opening
-- hours become a property of the place rather than the business.
--
-- Store identity was split off into shop_locations in 20260808000000, but
-- nothing pointed at it yet. This is what makes it load-bearing.
--
-- Two things move together here because they are already coupled: hours print
-- on a receipt (src/lib/receipt.ts formatTodayHours) and gate shift validation
-- (src/lib/scheduling.ts validateShift). Both answer "when is this place open",
-- and with two branches a single shop-wide answer is simply wrong.
--
-- edit_sale deliberately does NOT gain a location parameter. Editing a past
-- sale corrects what was sold, not where -- moving a sale between branches
-- would silently restate two locations' takings at once. Its stock handling
-- stays shop-wide here and changes in Phase 2 along with everything else that
-- touches per-location stock.

-- ---------------------------------------------------------------------------
-- Opening hours move to the location
-- ---------------------------------------------------------------------------

alter table public.shop_locations
  add column opening_hours jsonb not null default '{}'::jsonb;

comment on column public.shop_locations.opening_hours is
  'Weekly opening hours keyed by weekday (mon..sun), each an array of {open,close} local wall-clock HH:MM strings. Empty array = closed that day. {} = not set. Validated in src/lib/store-hours.ts, not by a constraint. Moved here from shops in 20260809000000 -- hours belong to a place, not a business.';

-- Every location a shop has right now inherits the hours the shop held. For
-- the single-location shops that are the norm this is a lossless rename: the
-- one "Main" row ends up with exactly the hours its owner set.
update public.shop_locations l
  set opening_hours = s.opening_hours
  from public.shops s
  where s.id = l.shop_id and s.opening_hours <> '{}'::jsonb;

-- Dropped rather than left in place as a fallback. Two sources for the same
-- answer is how they drift: an owner edits hours on the location, a receipt
-- still reads the shop, and nobody notices until a customer turns up to a
-- closed door. The column has one writer (the hours editor) and its data is
-- carried above, so there is nothing to preserve.
alter table public.shops drop column opening_hours;

-- ---------------------------------------------------------------------------
-- Sales carry a location
-- ---------------------------------------------------------------------------

-- Nullable in the column definition, then backfilled and made not-null below:
-- adding a not-null column with an FK to an existing table needs the rows to
-- exist first.
alter table public.sales
  add column location_id uuid references public.shop_locations(id);

update public.sales s
  set location_id = (
    select l.id from public.shop_locations l
    where l.shop_id = s.shop_id
    order by l.is_primary desc, l.created_at asc
    limit 1
  )
  where s.location_id is null;

-- Enforced, not merely defaulted: an unattributed sale is a hole in every
-- per-location report, and the only way to get one now is a bug. The backfill
-- above guarantees no existing row violates this, because 20260808000000
-- guarantees every shop has at least one location.
alter table public.sales alter column location_id set not null;

-- The per-location sales list and every location-filtered report read
-- (shop, location, date range) together, which is the order this indexes.
create index sales_shop_location_created_idx
  on public.sales(shop_id, location_id, created_at desc);

-- ---------------------------------------------------------------------------
-- A stale edit_sale overload, resurrected by a generated migration
-- ---------------------------------------------------------------------------

-- 0024_permission_gates.sql dropped the pre-0023 arities of complete_sale and
-- edit_sale on purpose, noting that left in place they would be "a way
-- straight around everything above". 20260801221945_check_customer_rpc.sql --
-- a generated `supabase db diff` migration -- then recreated one of them
-- verbatim from a drifted database: edit_sale(uuid, jsonb, jsonb, text, text),
-- still carrying the pre-0013 body.
--
-- That function is live, security definer, and granted to authenticated. It
-- predates tax (0015), transaction discounts (0013), the customer link (0023),
-- the sales.edit permission gate (0024) and the cost snapshot
-- (20260804000000). Anything reaching it rewrites a sale with none of them:
-- tax and discount silently dropped, totals restated wrong, unit_cost_cents
-- lost so margin reporting quietly changes for that sale.
--
-- It is not a privilege escalation -- its owns_shop() check is stricter than
-- the sales.edit gate that replaced it, so no staff member can reach anything
-- through it they could not reach anyway. It is a correctness landmine, and
-- the current client never hits it only because src/lib/sales.ts happens to
-- send all eight arguments, which is what makes PostgREST pick the right
-- overload. Nothing enforces that.
drop function if exists public.edit_sale(uuid, jsonb, jsonb, text, text);

-- ---------------------------------------------------------------------------
-- complete_sale stamps the location
-- ---------------------------------------------------------------------------

-- A new trailing parameter overloads rather than replaces, so the prior
-- signature is dropped first -- the same pitfall documented in 0024 and in
-- 20260801232553.
drop function if exists public.complete_sale(uuid, jsonb, jsonb, text, text, text, text, integer, uuid, timestamptz);

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
  p_location_id uuid default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_sale_id uuid;
  v_location_id uuid;
  v_item jsonb;
  v_payment jsonb;
  v_product public.products%rowtype;
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
begin
  if not public.has_shop_permission(p_shop_id, 'pos.access') then
    raise exception 'not authorized for shop %', p_shop_id;
  end if;
  if p_payments is null or jsonb_array_length(p_payments) = 0 then
    raise exception 'at least one payment is required';
  end if;

  -- Omitting the location falls back to the shop's primary. That is what keeps
  -- CSV sales import (src/lib/sales-import.ts) and any client that has not
  -- shipped the location picker yet working unchanged -- and for a
  -- single-location shop the fallback is the only correct answer anyway.
  --
  -- Resolved by the same ordering as the backfill above so an old caller and a
  -- pre-existing row can never disagree about which location "the shop" meant.
  if p_location_id is null then
    select l.id into v_location_id from public.shop_locations l
      where l.shop_id = p_shop_id
      order by l.is_primary desc, l.created_at asc
      limit 1;
    if v_location_id is null then
      raise exception 'shop % has no location to record this sale against', p_shop_id;
    end if;
  else
    -- Belongs-to-shop is checked here rather than left to the FK: the FK only
    -- proves the location exists somewhere, so without this a caller could file
    -- a sale against another shop's branch.
    --
    -- Inactive locations are deliberately still accepted. A closed branch stops
    -- appearing in the POS picker (the client filters on `active`), but a
    -- backdated import of sales that genuinely happened there before it closed
    -- must still land somewhere truthful.
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

  select tax_enabled, tax_rate_percent into v_tax_enabled, v_tax_rate
    from public.shops where id = p_shop_id;

  insert into public.sales (shop_id, location_id, created_by, payment_method, customer_name, customer_phone, customer_email, cashier_name, discount_cents, customer_id, created_at)
    values (p_shop_id, v_location_id, auth.uid(), v_primary_method, nullif(p_customer_name, ''), nullif(p_customer_phone, ''), nullif(p_customer_email, ''), nullif(p_cashier_name, ''), v_discount_cents, p_customer_id, coalesce(p_created_at, now()))
    returning id into v_sale_id;

  for v_item in select * from jsonb_array_elements(p_items) loop
    v_qty := (v_item->>'quantity')::integer;
    if v_qty is null or v_qty <= 0 then
      raise exception 'invalid quantity in cart item';
    end if;

    select * into v_product from public.products
      where id = (v_item->>'product_id')::uuid and shop_id = p_shop_id
      for update;

    if v_product.id is null then
      raise exception 'product % not found in this shop', v_item->>'product_id';
    end if;
    if v_product.stock < v_qty then
      raise exception 'insufficient stock for %: has %, need %', v_product.name, v_product.stock, v_qty;
    end if;

    v_line_discount := greatest(coalesce((v_item->>'discount_cents')::integer, 0), 0);
    v_line := v_product.price_cents * v_qty - v_line_discount;
    if v_line < 0 then
      raise exception 'discount exceeds line total for %', v_product.name;
    end if;

    update public.products set stock = stock - v_qty, updated_at = now() where id = v_product.id;

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
    tax_rate_percent = case when v_tax_enabled then v_tax_rate else null end
  where id = v_sale_id;
  return v_sale_id;
end;
$$;

grant execute on function public.complete_sale(uuid, jsonb, jsonb, text, text, text, text, integer, uuid, timestamptz, uuid) to authenticated;
