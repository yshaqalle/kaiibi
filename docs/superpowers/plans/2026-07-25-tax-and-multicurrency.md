# POS Tax + Multi-Currency Checkout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a shop-wide configurable tax rate (default 2.5%, off until enabled) and per-payment-line currency conversion (Somaliland Shilling active by default, Ethiopian Birr seeded inactive) to the POS checkout, while keeping every sale recorded in USD.

**Architecture:** USD stays the source of truth end to end. Tax is computed server-side inside the existing `complete_sale`/`edit_sale` Postgres RPCs (reading the shop's own `tax_enabled`/`tax_rate_percent` row, not a client-supplied value) and added on top of the existing gross-minus-discount total. Currency is purely a per-payment-line settlement detail: a cashier picks an active currency, types an amount in it, the client converts to USD-cents via the shop's configured rate using the same tender/change flow cash already has, and only the converted USD-cents value is what the RPC's existing "payments must sum to the total" invariant checks. The four new payment fields (currency code, rate, foreign amount, foreign change) are display/audit-only.

**Tech Stack:** Expo Router (React Native + web), Supabase (Postgres + `supabase-js`), Jest (`jest-expo` preset, Babel-transformed — no type-checking gate in `npm test`).

## Global Constraints

- Tax rate storage: `shops.tax_rate_percent numeric(5,2) not null default 2.5`, `shops.tax_enabled boolean not null default false`.
- Tax applies to the post-discount subtotal (after per-line and transaction discounts), computed server-side, never client-supplied.
- Currency exchange rate convention: `rate_to_usd` = units of that currency per $1 USD (e.g. Somaliland Shilling = `115`).
- Default seeded currencies (both existing and newly created shops): Somaliland Shilling (`SLSH`, `Sl Sh`, rate `115`, **active**) and Ethiopian Birr (`ETB`, `Br`, rate `130`, **inactive** — a placeholder; the owner must verify/adjust before activating it).
- `amount_cents` on a payment line always means USD-cents applied to the sale — this must never change meaning; new currency fields are additive only.
- Follow existing codebase conventions throughout: nullable-but-required fields (explicit `null`, not `optional`) matching `tenderedCents`/`customerName` on `PaymentLine`; camelCase in TS mapped from snake_case DB columns via each lib's `mapXRow` function; no new npm dependencies.
- No local Supabase CLI is available in this environment — the migration file is written but **cannot be applied or tested against a live database from here**. Task 1 is verified by SQL review only; the user must apply it (Supabase dashboard SQL editor, `supabase db push`, or the Supabase MCP once authorized) before the app-level tasks can be manually verified end-to-end.

---

## Task 1: Database migration — tax columns, currencies table, RPC updates

**Files:**
- Create: `supabase/migrations/0015_tax_and_currencies.sql`

**Interfaces:**
- Produces: `shops.tax_enabled`, `shops.tax_rate_percent`; `sales.tax_cents`, `sales.tax_rate_percent`; `public.shop_currencies` table (`id, shop_id, code, name, symbol, rate_to_usd, active, created_at`); `sale_payments.currency_code/exchange_rate/foreign_amount_cents/foreign_change_cents`; updated `complete_sale`/`edit_sale` RPCs (same signatures as in migration `0013_promotions_and_discounts.sql`, bodies replaced).

- [ ] **Step 1: Write the migration file**

```sql
-- Shop-wide tax: off by default, 2.5% pre-filled the moment it's enabled
-- (editable after that). Computed server-side in complete_sale/edit_sale
-- from this row directly, never from a client-supplied value, so a
-- cashier can't under-report it.
alter table public.shops
  add column if not exists tax_enabled boolean not null default false,
  add column if not exists tax_rate_percent numeric(5,2) not null default 2.5;

-- tax_rate_percent here is a snapshot of the rate that applied to this
-- specific sale, independent of shops.tax_rate_percent changing later --
-- same treatment as sales.discount_cents vs a promotion's live value.
alter table public.sales
  add column if not exists tax_cents integer not null default 0,
  add column if not exists tax_rate_percent numeric(5,2);

-- Currencies a shop accepts as an alternate way to settle a payment line.
-- USD itself is not a row here -- it's the implicit default when a
-- payment's currency_code is null. rate_to_usd is "units of this
-- currency per $1 USD" (e.g. 115 for Somaliland Shilling).
create table public.shop_currencies (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  code text not null,
  name text not null,
  symbol text not null,
  rate_to_usd numeric not null check (rate_to_usd > 0),
  active boolean not null default false,
  created_at timestamptz not null default now(),
  unique (shop_id, code)
);
create index shop_currencies_shop_id_idx on public.shop_currencies(shop_id);

alter table public.shop_currencies enable row level security;

create policy "own shop_currencies" on public.shop_currencies for all
  using (owns_shop(shop_id)) with check (owns_shop(shop_id));

grant select, insert, update, delete on public.shop_currencies to authenticated;

-- Seed every existing shop with the same two starting currencies new shops
-- get from createShop() in application code -- Somaliland Shilling active,
-- Ethiopian Birr seeded inactive with a placeholder rate the owner should
-- verify before turning it on.
insert into public.shop_currencies (shop_id, code, name, symbol, rate_to_usd, active)
  select id, 'SLSH', 'Somaliland Shilling', 'Sl Sh', 115, true from public.shops
  on conflict (shop_id, code) do nothing;
insert into public.shop_currencies (shop_id, code, name, symbol, rate_to_usd, active)
  select id, 'ETB', 'Ethiopian Birr', 'Br', 130, false from public.shops
  on conflict (shop_id, code) do nothing;

-- currency_code/exchange_rate/foreign_amount_cents/foreign_change_cents are
-- display/audit only -- amount_cents keeps meaning exactly what it means
-- today (USD-cents applied to the sale). All null for a plain USD payment.
alter table public.sale_payments
  add column if not exists currency_code text,
  add column if not exists exchange_rate numeric,
  add column if not exists foreign_amount_cents integer,
  add column if not exists foreign_change_cents integer;

-- Same signature as 0013 -- only the body changes, so no drop/regrant is
-- needed. Adds tax on top of the existing gross-minus-discount total
-- (read from the shop's own row, not a parameter) and passes the four new
-- optional currency fields from each payment's jsonb through to
-- sale_payments.
create or replace function public.complete_sale(
  p_shop_id uuid,
  p_items jsonb,
  p_payments jsonb,
  p_customer_name text default null,
  p_customer_phone text default null,
  p_customer_email text default null,
  p_cashier_name text default null,
  p_discount_cents integer default 0
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_sale_id uuid;
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
  if not public.owns_shop(p_shop_id) then
    raise exception 'not authorized for shop %', p_shop_id;
  end if;
  if p_payments is null or jsonb_array_length(p_payments) = 0 then
    raise exception 'at least one payment is required';
  end if;

  v_primary_method := p_payments->0->>'method';
  if v_primary_method not in ('cash','zaad','edahab','other') then
    raise exception 'invalid payment method %', v_primary_method;
  end if;

  select tax_enabled, tax_rate_percent into v_tax_enabled, v_tax_rate
    from public.shops where id = p_shop_id;

  insert into public.sales (shop_id, created_by, payment_method, customer_name, customer_phone, customer_email, cashier_name, discount_cents)
    values (p_shop_id, auth.uid(), v_primary_method, nullif(p_customer_name, ''), nullif(p_customer_phone, ''), nullif(p_customer_email, ''), nullif(p_cashier_name, ''), v_discount_cents)
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

    insert into public.sale_items (sale_id, product_id, product_name, unit_price_cents, quantity, line_total_cents, discount_cents)
      values (v_sale_id, v_product.id, v_product.name, v_product.price_cents, v_qty, v_line, v_line_discount);

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

-- Same treatment for edit_sale -- recomputes tax from the shop's *current*
-- settings (consistent with how it already recomputes totals from the
-- current cart rather than freezing the original), same signature as 0013.
create or replace function public.edit_sale(
  p_sale_id uuid,
  p_items jsonb,
  p_payments jsonb,
  p_customer_name text default null,
  p_customer_phone text default null,
  p_customer_email text default null,
  p_discount_cents integer default 0
) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_shop_id uuid;
  v_snapshot jsonb;
  v_old_item record;
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
  v_discount_cents integer := greatest(coalesce(p_discount_cents, 0), 0);
  v_tax_enabled boolean;
  v_tax_rate numeric;
  v_tax_cents integer := 0;
begin
  select shop_id into v_shop_id from public.sales where id = p_sale_id;
  if v_shop_id is null then
    raise exception 'sale % not found', p_sale_id;
  end if;
  if not public.owns_shop(v_shop_id) then
    raise exception 'not authorized for sale %', p_sale_id;
  end if;
  if p_items is null or jsonb_array_length(p_items) = 0 then
    raise exception 'a sale must have at least one item';
  end if;
  if p_payments is null or jsonb_array_length(p_payments) = 0 then
    raise exception 'at least one payment is required';
  end if;

  select tax_enabled, tax_rate_percent into v_tax_enabled, v_tax_rate
    from public.shops where id = v_shop_id;

  select jsonb_build_object(
    'total_cents', s.total_cents,
    'item_count', s.item_count,
    'payment_method', s.payment_method,
    'customer_name', s.customer_name,
    'customer_phone', s.customer_phone,
    'customer_email', s.customer_email,
    'discount_cents', s.discount_cents,
    'items', (select coalesce(jsonb_agg(jsonb_build_object(
        'product_id', si.product_id, 'product_name', si.product_name,
        'unit_price_cents', si.unit_price_cents, 'quantity', si.quantity,
        'line_total_cents', si.line_total_cents, 'discount_cents', si.discount_cents
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
      update public.products set stock = stock + v_old_item.quantity, updated_at = now() where id = v_old_item.product_id;
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
      where id = (v_item->>'product_id')::uuid and shop_id = v_shop_id
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

    insert into public.sale_items (sale_id, product_id, product_name, unit_price_cents, quantity, line_total_cents, discount_cents)
      values (p_sale_id, v_product.id, v_product.name, v_product.price_cents, v_qty, v_line, v_line_discount);

    v_gross_cents := v_gross_cents + v_line;
    v_item_count := v_item_count + v_qty;
  end loop;

  if v_item_count = 0 then
    raise exception 'cannot save a sale with no items';
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
    discount_cents = v_discount_cents,
    tax_cents = v_tax_cents,
    tax_rate_percent = case when v_tax_enabled then v_tax_rate else null end
  where id = p_sale_id;
end;
$$;
```

- [ ] **Step 2: Review the SQL by hand** (no local Supabase to run it against)

Check: every `alter table ... add column if not exists` is idempotent; `complete_sale`/`edit_sale` signatures exactly match `0013_promotions_and_discounts.sql` (`create or replace` reuses existing grants — confirm no `drop function`/`grant execute` statements were added, since the signature is unchanged); the two seed `insert`s use `on conflict (shop_id, code) do nothing` so re-running the migration is safe.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/0015_tax_and_currencies.sql
git commit -m "feat: add tax and multi-currency schema, update complete_sale/edit_sale"
```

---

## Task 2: Extend TypeScript models

**Files:**
- Modify: `src/types/models.ts`

**Interfaces:**
- Produces: `Currency` type; `Shop.taxEnabled: boolean`, `Shop.taxRatePercent: number`; `PaymentLine.currencyCode/exchangeRate/foreignAmountCents/foreignChangeCents: ... | null`; `Sale.taxCents: number`, `Sale.taxRatePercent: number | null`.
- Consumes: nothing new (pure type additions).

- [ ] **Step 1: Add tax fields to `Shop`**

In `src/types/models.ts`, in the `Shop` type (around line 26, right after `monthlyRevenueGoalCents`):

```typescript
  // Set in Settings; drives the dashboard's monthly revenue goal meter. Null
  // until the owner sets one — the meter is hidden until then.
  monthlyRevenueGoalCents: number | null;
  // Shop-wide tax, off by default. When enabled, `taxRatePercent` (default
  // 2.5, editable) is applied server-side to every sale's post-discount
  // subtotal — see complete_sale/edit_sale in migration 0015.
  taxEnabled: boolean;
  taxRatePercent: number;
  createdAt: string;
```

- [ ] **Step 2: Add the `Currency` type**

Directly below the `Shop` type in the same file:

```typescript
// An alternate currency a shop accepts as a way to settle a payment line
// (see PaymentLine below) — USD itself is not a row here, it's the
// implicit default when a payment's currencyCode is null. `rateToUsd` is
// units of this currency per $1 USD (e.g. 115 for Somaliland Shilling).
export type Currency = {
  id: string;
  shopId: string;
  code: string;
  name: string;
  symbol: string;
  rateToUsd: number;
  active: boolean;
  createdAt: string;
};
```

- [ ] **Step 3: Add currency fields to `PaymentLine`**

Replace the `PaymentLine` type:

```typescript
// One line of a (possibly split) checkout payment. `tenderedCents` is only
// meaningful for cash (what the customer physically handed over, so change
// due = tenderedCents - amountCents); `customerName`/`customerPhone` are
// only meaningful for mobile-money methods like ZAAD/e-Dahab.
// `amountCents` is always the USD-cents amount applied to the sale, even
// when this line was settled in a foreign currency — `currencyCode`
// through `foreignChangeCents` are display/audit-only for that case, all
// null for a plain USD payment.
export type PaymentLine = {
  method: PaymentMethod;
  amountCents: number;
  tenderedCents: number | null;
  customerName: string | null;
  customerPhone: string | null;
  currencyCode: string | null;
  exchangeRate: number | null;
  foreignAmountCents: number | null;
  foreignChangeCents: number | null;
};
```

- [ ] **Step 4: Add tax fields to `Sale`**

In the `Sale` type, right after `discountCents`:

```typescript
  // Whole-transaction discount entered at checkout, on top of any per-line
  // discounts (already reflected in each item's `lineTotalCents`) — see
  // src/lib/discounts.ts.
  discountCents: number;
  // Tax applied on top of the post-discount subtotal, and the rate that
  // produced it — both a frozen snapshot at sale time (see migration
  // 0015), independent of the shop's tax settings changing later.
  taxCents: number;
  taxRatePercent: number | null;
  totalCents: number;
```

- [ ] **Step 5: Commit**

```bash
git add src/types/models.ts
git commit -m "feat: add tax and currency fields to Shop/PaymentLine/Sale types"
```

---

## Task 3: Currency conversion + formatting helpers

**Files:**
- Modify: `src/lib/currency.ts`
- Create: `src/lib/__tests__/currency.test.ts` (extend existing file)

**Interfaces:**
- Consumes: nothing (pure functions).
- Produces: `foreignCentsToUsdCents(foreignCents: number, rateToUsd: number): number`, `usdCentsToForeignCents(usdCents: number, rateToUsd: number): number`, `formatForeignCents(cents: number, symbol: string): string`.

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/__tests__/currency.test.ts`:

```typescript
import { foreignCentsToUsdCents, formatForeignCents, usdCentsToForeignCents } from '@/lib/currency';

describe('foreignCentsToUsdCents', () => {
  it('converts foreign cents to USD cents using the rate (units of foreign currency per $1)', () => {
    // 500,000 Sl Sh cents (i.e. 5,000 Sl Sh) at 115 Sl Sh/$1 = $43.4783 -> 4348 cents
    expect(foreignCentsToUsdCents(500000, 115)).toBe(4348);
  });

  it('rounds to the nearest USD cent', () => {
    expect(foreignCentsToUsdCents(100, 3)).toBe(33); // 33.33 rounds down
    expect(foreignCentsToUsdCents(200, 3)).toBe(67); // 66.67 rounds up
  });

  it('returns 0 for 0 foreign cents', () => {
    expect(foreignCentsToUsdCents(0, 115)).toBe(0);
  });
});

describe('usdCentsToForeignCents', () => {
  it('converts USD cents to foreign cents using the rate', () => {
    expect(usdCentsToForeignCents(4348, 115)).toBe(500020); // inverse of above, off by rounding
  });

  it('round-trips within a cent for whole-dollar amounts', () => {
    const usd = 1000; // $10.00
    const foreign = usdCentsToForeignCents(usd, 115);
    expect(foreignCentsToUsdCents(foreign, 115)).toBeCloseTo(usd, -1);
  });
});

describe('formatForeignCents', () => {
  it('formats a whole-unit amount without decimals', () => {
    expect(formatForeignCents(500000, 'Sl Sh')).toBe('5,000 Sl Sh');
  });

  it('formats a fractional amount with 2 decimals', () => {
    expect(formatForeignCents(4348, '$')).toBe('43.48 $');
  });

  it('formats zero', () => {
    expect(formatForeignCents(0, 'Br')).toBe('0 Br');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest src/lib/__tests__/currency.test.ts`
Expected: FAIL — `foreignCentsToUsdCents`, `usdCentsToForeignCents`, `formatForeignCents` are not exported from `@/lib/currency`.

- [ ] **Step 3: Implement the helpers**

Append to `src/lib/currency.ts`:

```typescript
// `rateToUsd` is units of the foreign currency per $1 USD (e.g. 115 for
// Somaliland Shilling) — both amounts are in that currency's minor unit
// (i.e. already multiplied by 100), same convention as USD cents.
export function foreignCentsToUsdCents(foreignCents: number, rateToUsd: number): number {
  return Math.round(foreignCents / rateToUsd);
}

export function usdCentsToForeignCents(usdCents: number, rateToUsd: number): number {
  return Math.round(usdCents * rateToUsd);
}

// Drops the decimals for a whole-unit amount (the common case for
// currencies like Sl Sh with no real fractional denomination in
// circulation) but keeps 2 decimals when the amount isn't whole.
export function formatForeignCents(cents: number, symbol: string): string {
  const amount = Math.round(cents) / 100;
  const formatted = amount.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  return `${formatted} ${symbol}`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest src/lib/__tests__/currency.test.ts`
Expected: PASS (all suites in the file, including the pre-existing `toCents`/`formatCents` ones)

- [ ] **Step 5: Commit**

```bash
git add src/lib/currency.ts src/lib/__tests__/currency.test.ts
git commit -m "feat: add foreign-currency conversion and formatting helpers"
```

---

## Task 4: Tax calculation helper

**Files:**
- Create: `src/lib/tax.ts`
- Create: `src/lib/__tests__/tax.test.ts`

**Interfaces:**
- Consumes: nothing (pure function).
- Produces: `taxCentsFor(baseCents: number, taxRatePercent: number): number` — used by the POS cart display (Task 12) to mirror the server's tax calculation before checkout.

- [ ] **Step 1: Write the failing test**

```typescript
import { taxCentsFor } from '@/lib/tax';

describe('taxCentsFor', () => {
  it('computes tax at the given percent, rounded to the nearest cent', () => {
    expect(taxCentsFor(10000, 2.5)).toBe(250); // $100.00 at 2.5% = $2.50
  });

  it('rounds to the nearest cent on a non-round result', () => {
    expect(taxCentsFor(999, 2.5)).toBe(25); // 24.975 rounds to 25
  });

  it('returns 0 for a zero base', () => {
    expect(taxCentsFor(0, 2.5)).toBe(0);
  });

  it('returns 0 for a zero rate', () => {
    expect(taxCentsFor(10000, 0)).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/lib/__tests__/tax.test.ts`
Expected: FAIL — cannot find module `@/lib/tax`

- [ ] **Step 3: Write the implementation**

```typescript
// Mirrors the tax calculation in complete_sale/edit_sale (migration
// 0015) exactly — client-side, this is display-only (so the POS cart can
// show the tax line before checkout); the server always recomputes and is
// authoritative.
export function taxCentsFor(baseCents: number, taxRatePercent: number): number {
  return Math.round((baseCents * taxRatePercent) / 100);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/lib/__tests__/tax.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/tax.ts src/lib/__tests__/tax.test.ts
git commit -m "feat: add client-side tax calculation helper"
```

---

## Task 5: Shop tax fields in `src/lib/shops.ts`

**Files:**
- Modify: `src/lib/shops.ts`

**Interfaces:**
- Consumes: `Shop.taxEnabled`/`taxRatePercent` (Task 2).
- Produces: `getMyShop()`/`createShop()` return shops with `taxEnabled`/`taxRatePercent` populated; `updateShop()` accepts `taxEnabled`/`taxRatePercent` in its partial input.

- [ ] **Step 1: Map the new columns in `mapShopRow`**

In `src/lib/shops.ts`, update `mapShopRow`:

```typescript
function mapShopRow(row: any): Shop {
  return {
    id: row.id,
    ownerId: row.owner_id,
    name: row.name,
    description: row.description,
    city: row.city,
    neighborhood: row.neighborhood,
    contactPhone: row.contact_phone,
    returnPolicy: row.return_policy,
    logoUrl: row.logo_url,
    categories: row.categories ?? [],
    monthlyRevenueGoalCents: row.monthly_revenue_goal_cents,
    taxEnabled: row.tax_enabled,
    taxRatePercent: Number(row.tax_rate_percent),
    createdAt: row.created_at,
  };
}
```

- [ ] **Step 2: Accept the new fields in `updateShop`**

Update the `updateShop` function's input type and update payload:

```typescript
export async function updateShop(id: string, input: Partial<{
  name: string; description: string; city: string; neighborhood: string; contactPhone: string; returnPolicy: string; logoUrl: string | null; categories: string[]; monthlyRevenueGoalCents: number | null; taxEnabled: boolean; taxRatePercent: number;
}>): Promise<Shop> {
  const { data, error } = await supabase
    .from('shops')
    .update({
      ...(input.name !== undefined && { name: input.name }),
      ...(input.description !== undefined && { description: input.description }),
      ...(input.city !== undefined && { city: input.city }),
      ...(input.neighborhood !== undefined && { neighborhood: input.neighborhood }),
      ...(input.contactPhone !== undefined && { contact_phone: input.contactPhone }),
      ...(input.returnPolicy !== undefined && { return_policy: input.returnPolicy }),
      ...(input.logoUrl !== undefined && { logo_url: input.logoUrl }),
      ...(input.categories !== undefined && { categories: input.categories }),
      ...(input.monthlyRevenueGoalCents !== undefined && { monthly_revenue_goal_cents: input.monthlyRevenueGoalCents }),
      ...(input.taxEnabled !== undefined && { tax_enabled: input.taxEnabled }),
      ...(input.taxRatePercent !== undefined && { tax_rate_percent: input.taxRatePercent }),
    })
    .eq('id', id)
    .select('*')
    .single();
  if (error) throw error;
  return mapShopRow(data);
}
```

- [ ] **Step 3: Verify with a manual check** (no existing test file for `shops.ts` — it's a thin Supabase wrapper, consistent with the rest of the codebase not unit-testing these)

Run: `npx tsc --noEmit`
Expected: no new errors originating from `src/lib/shops.ts` (errors from files not yet updated in later tasks, e.g. `settings.tsx`, are expected at this point and will clear by Task 13).

- [ ] **Step 4: Commit**

```bash
git add src/lib/shops.ts
git commit -m "feat: map and persist shop tax settings"
```

---

## Task 6: Currencies data-access module + shop-creation seeding

**Files:**
- Create: `src/lib/currencies.ts`
- Modify: `src/lib/shops.ts` (seed default currencies in `createShop`)

**Interfaces:**
- Consumes: `Currency` type (Task 2).
- Produces: `listCurrencies(shopId): Promise<Currency[]>`, `createCurrency(shopId, input: {code, name, symbol, rateToUsd}): Promise<void>`, `updateCurrency(id, input: Partial<{name, symbol, rateToUsd}>): Promise<void>`, `setCurrencyActive(id, active): Promise<void>`, `deleteCurrency(id): Promise<void>`.

- [ ] **Step 1: Write `src/lib/currencies.ts`**

```typescript
import { supabase } from '@/lib/supabase';
import type { Currency } from '@/types/models';

function mapCurrencyRow(row: any): Currency {
  return {
    id: row.id,
    shopId: row.shop_id,
    code: row.code,
    name: row.name,
    symbol: row.symbol,
    rateToUsd: Number(row.rate_to_usd),
    active: row.active,
    createdAt: row.created_at,
  };
}

export async function listCurrencies(shopId: string): Promise<Currency[]> {
  const { data, error } = await supabase
    .from('shop_currencies')
    .select('*')
    .eq('shop_id', shopId)
    .order('code', { ascending: true });
  if (error) throw error;
  return (data ?? []).map(mapCurrencyRow);
}

export async function createCurrency(
  shopId: string,
  input: { code: string; name: string; symbol: string; rateToUsd: number }
): Promise<void> {
  const { error } = await supabase.from('shop_currencies').insert({
    shop_id: shopId,
    code: input.code.toUpperCase(),
    name: input.name,
    symbol: input.symbol,
    rate_to_usd: input.rateToUsd,
  });
  if (error) throw error;
}

// Code is intentionally not editable here — it's the row's stable
// identity (unique per shop, referenced as a plain snapshot string on past
// payments), so changing it would be a rename with no cascading update to
// historical sale_payments rows, unlike renameBrand/renameCategory.
export async function updateCurrency(id: string, input: Partial<{ name: string; symbol: string; rateToUsd: number }>): Promise<void> {
  const { error } = await supabase
    .from('shop_currencies')
    .update({
      ...(input.name !== undefined && { name: input.name }),
      ...(input.symbol !== undefined && { symbol: input.symbol }),
      ...(input.rateToUsd !== undefined && { rate_to_usd: input.rateToUsd }),
    })
    .eq('id', id);
  if (error) throw error;
}

export async function setCurrencyActive(id: string, active: boolean): Promise<void> {
  const { error } = await supabase.from('shop_currencies').update({ active }).eq('id', id);
  if (error) throw error;
}

export async function deleteCurrency(id: string): Promise<void> {
  const { error } = await supabase.from('shop_currencies').delete().eq('id', id);
  if (error) throw error;
}
```

- [ ] **Step 2: Seed the two default currencies in `createShop`**

In `src/lib/shops.ts`, update `createShop` to seed the same two defaults the migration backfills for existing shops:

```typescript
export async function createShop(input: {
  name: string;
  description?: string;
  city?: string;
  neighborhood?: string;
  contactPhone?: string;
  categories?: string[];
}): Promise<Shop> {
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) throw new Error('Must be signed in to create a shop');
  const { data, error } = await supabase
    .from('shops')
    .insert({
      owner_id: userData.user.id,
      name: input.name,
      description: input.description ?? null,
      city: input.city ?? 'Hargeisa',
      neighborhood: input.neighborhood ?? null,
      contact_phone: input.contactPhone ?? null,
      categories: input.categories ?? [],
    })
    .select('*')
    .single();
  if (error) throw error;
  const shop = mapShopRow(data);
  // Same starting currencies the migration backfills for shops that
  // existed before this feature shipped — see migration 0015.
  const { error: currencyError } = await supabase.from('shop_currencies').insert([
    { shop_id: shop.id, code: 'SLSH', name: 'Somaliland Shilling', symbol: 'Sl Sh', rate_to_usd: 115, active: true },
    { shop_id: shop.id, code: 'ETB', name: 'Ethiopian Birr', symbol: 'Br', rate_to_usd: 130, active: false },
  ]);
  if (currencyError) throw currencyError;
  return shop;
}
```

- [ ] **Step 3: Verify with `tsc`**

Run: `npx tsc --noEmit`
Expected: no new errors from `src/lib/currencies.ts` or `src/lib/shops.ts`.

- [ ] **Step 4: Commit**

```bash
git add src/lib/currencies.ts src/lib/shops.ts
git commit -m "feat: add currencies data-access module and seed defaults on shop creation"
```

---

## Task 7: `src/lib/sales.ts` — payment payload and sale-row mapping

**Files:**
- Modify: `src/lib/sales.ts`

**Interfaces:**
- Consumes: `PaymentLine` (Task 2, now with 4 new fields), `Sale.taxCents`/`taxRatePercent` (Task 2).
- Produces: `buildPaymentPayload` includes the 4 new keys in every payment object it sends to `complete_sale`/`edit_sale`; `mapSaleRow` populates `taxCents`/`taxRatePercent` on `Sale` and the 4 new fields on each `SalePayment`.

- [ ] **Step 1: Update `buildPaymentPayload`**

```typescript
function buildPaymentPayload(payments: PaymentLine[]) {
  return payments.map((p) => ({
    method: p.method,
    amount_cents: p.amountCents,
    tendered_cents: p.tenderedCents,
    customer_name: p.customerName,
    customer_phone: p.customerPhone,
    currency_code: p.currencyCode,
    exchange_rate: p.exchangeRate,
    foreign_amount_cents: p.foreignAmountCents,
    foreign_change_cents: p.foreignChangeCents,
  }));
}
```

- [ ] **Step 2: Update `mapSaleRow`**

Add `taxCents`/`taxRatePercent` to the returned `Sale` (right after `discountCents`), and the 4 new fields to the `SalePayment` mapping:

```typescript
function mapSaleRow(row: any): Sale {
  return {
    id: row.id,
    shopId: row.shop_id,
    createdBy: row.created_by,
    paymentMethod: row.payment_method,
    paymentNote: row.payment_note,
    customerName: row.customer_name,
    customerPhone: row.customer_phone,
    customerEmail: row.customer_email,
    cashierName: row.cashier_name,
    discountCents: row.discount_cents ?? 0,
    taxCents: row.tax_cents ?? 0,
    taxRatePercent: row.tax_rate_percent !== null && row.tax_rate_percent !== undefined ? Number(row.tax_rate_percent) : null,
    totalCents: row.total_cents,
    itemCount: row.item_count,
    createdAt: row.created_at,
    items: (row.sale_items ?? []).map(
      (item: any): SaleItem => ({
        id: item.id,
        saleId: item.sale_id,
        productId: item.product_id,
        productName: item.product_name,
        unitPriceCents: item.unit_price_cents,
        quantity: item.quantity,
        lineTotalCents: item.line_total_cents,
        discountCents: item.discount_cents ?? 0,
      })
    ),
    payments: (row.sale_payments ?? []).map(
      (payment: any): SalePayment => ({
        id: payment.id,
        saleId: payment.sale_id,
        method: payment.method,
        amountCents: payment.amount_cents,
        tenderedCents: payment.tendered_cents,
        customerName: payment.customer_name,
        customerPhone: payment.customer_phone,
        currencyCode: payment.currency_code,
        exchangeRate: payment.exchange_rate !== null && payment.exchange_rate !== undefined ? Number(payment.exchange_rate) : null,
        foreignAmountCents: payment.foreign_amount_cents,
        foreignChangeCents: payment.foreign_change_cents,
        createdAt: payment.created_at,
      })
    ),
    edits: (row.sale_edits ?? [])
      .map((edit: any): SaleEdit => ({
        id: edit.id,
        saleId: edit.sale_id,
        editedBy: edit.edited_by,
        createdAt: edit.created_at,
        previousSnapshot: {
          totalCents: edit.previous_snapshot.total_cents,
          itemCount: edit.previous_snapshot.item_count,
          paymentMethod: edit.previous_snapshot.payment_method,
          customerName: edit.previous_snapshot.customer_name ?? null,
          customerPhone: edit.previous_snapshot.customer_phone ?? null,
          customerEmail: edit.previous_snapshot.customer_email ?? null,
          discountCents: edit.previous_snapshot.discount_cents ?? 0,
          items: (edit.previous_snapshot.items ?? []).map((item: any): SaleItemSnapshot => ({
            productId: item.product_id,
            productName: item.product_name,
            unitPriceCents: item.unit_price_cents,
            quantity: item.quantity,
            lineTotalCents: item.line_total_cents,
            discountCents: item.discount_cents ?? 0,
          })),
          payments: (edit.previous_snapshot.payments ?? []).map((payment: any): PaymentLine => ({
            method: payment.method,
            amountCents: payment.amount_cents,
            tenderedCents: payment.tendered_cents,
            customerName: payment.customer_name,
            customerPhone: payment.customer_phone,
            currencyCode: payment.currency_code ?? null,
            exchangeRate: payment.exchange_rate !== null && payment.exchange_rate !== undefined ? Number(payment.exchange_rate) : null,
            foreignAmountCents: payment.foreign_amount_cents ?? null,
            foreignChangeCents: payment.foreign_change_cents ?? null,
          })),
        },
      }))
      .sort((a: SaleEdit, b: SaleEdit) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()),
  };
}
```

Note: `edit.previous_snapshot.payments` entries predate this feature for any sale edited before it shipped, so their `currency_code`/etc. keys won't exist in older snapshots — the `?? null` fallbacks handle that.

- [ ] **Step 3: Verify with `tsc`**

Run: `npx tsc --noEmit`
Expected: no new errors from `src/lib/sales.ts`.

- [ ] **Step 4: Commit**

```bash
git add src/lib/sales.ts
git commit -m "feat: carry tax and currency fields through sale payload and row mapping"
```

---

## Task 8: Receipt data + rendering (text/HTML builders)

**Files:**
- Modify: `src/lib/receipt.ts`

**Interfaces:**
- Consumes: `ReceiptData` (existing), `Sale.taxCents`/`taxRatePercent` (Task 2), `PaymentLine` currency fields (Task 2), `formatForeignCents` (Task 3).
- Produces: `ReceiptData.taxCents?`, `ReceiptData.taxRatePercent?`; `buildReceiptFromSale` populates them; `buildReceiptText`/`buildReceiptHtml` render a tax line and per-payment currency detail.

- [ ] **Step 1: Add tax fields to `ReceiptData` and populate them in `buildReceiptFromSale`**

```typescript
export type ReceiptData = {
  shopName: string;
  shopLogoUrl: string | null;
  shopCity: string | null;
  shopNeighborhood: string | null;
  shopContactPhone: string | null;
  cashierName: string | null;
  returnPolicy: string | null;
  items: ReceiptItem[];
  payments: PaymentLine[];
  customer: { name: string | null; phone: string | null; email: string | null };
  subtotalCents?: number;
  discountCents?: number;
  // Tax applied on top of the discounted subtotal, and the rate that
  // produced it — omitted (or 0) when tax wasn't enabled for this sale.
  taxCents?: number;
  taxRatePercent?: number | null;
  totalCents: number;
  createdAt: string;
};
```

Update `buildReceiptFromSale`:

```typescript
export function buildReceiptFromSale(
  sale: Sale,
  shop: { name: string; logoUrl: string | null; city: string | null; neighborhood: string | null; contactPhone: string | null; returnPolicy: string | null }
): ReceiptData {
  const subtotalCents = (sale.items ?? []).reduce((sum, item) => sum + item.unitPriceCents * item.quantity, 0);
  return {
    shopName: shop.name,
    shopLogoUrl: shop.logoUrl,
    shopCity: shop.city,
    shopNeighborhood: shop.neighborhood,
    shopContactPhone: shop.contactPhone,
    cashierName: sale.cashierName,
    returnPolicy: shop.returnPolicy,
    items: (sale.items ?? []).map((item) => ({ name: item.productName, quantity: item.quantity, unitPriceCents: item.unitPriceCents, discountCents: item.discountCents })),
    payments: (sale.payments ?? []).map((p) => ({
      method: p.method,
      amountCents: p.amountCents,
      tenderedCents: p.tenderedCents,
      customerName: p.customerName,
      customerPhone: p.customerPhone,
      currencyCode: p.currencyCode,
      exchangeRate: p.exchangeRate,
      foreignAmountCents: p.foreignAmountCents,
      foreignChangeCents: p.foreignChangeCents,
    })),
    customer: { name: sale.customerName, phone: sale.customerPhone, email: sale.customerEmail },
    subtotalCents,
    discountCents: subtotalCents - (sale.totalCents - sale.taxCents),
    taxCents: sale.taxCents,
    taxRatePercent: sale.taxRatePercent,
    totalCents: sale.totalCents,
    createdAt: sale.createdAt,
  };
}
```

(`discountCents` here is unchanged in spirit — subtotal minus the pre-tax total — just adjusted so a tax-inclusive `sale.totalCents` doesn't get misread as discount.)

- [ ] **Step 2: Render a payment line's currency detail and the tax line in `buildReceiptText`**

Add a helper above `buildReceiptText` and use it in both builders:

```typescript
function formatPaymentLine(payment: PaymentLine): string {
  const base = `${methodLabel(payment.method)}: ${formatCents(payment.amountCents)}`;
  if (!payment.currencyCode || payment.foreignAmountCents === null || payment.exchangeRate === null) return base;
  return `${methodLabel(payment.method)} (${payment.currencyCode}): ${formatForeignCents(payment.foreignAmountCents, payment.currencyCode)} @ ${payment.exchangeRate}/$ = ${formatCents(payment.amountCents)}`;
}
```

Add the `formatForeignCents` import at the top:

```typescript
import { formatCents, formatForeignCents } from '@/lib/currency';
```

Update `buildReceiptText` (replace the discount/total block and the payments loop):

```typescript
  lines.push('');
  if (receipt.discountCents && receipt.discountCents > 0) {
    lines.push(`SUBTOTAL: ${formatCents(receipt.subtotalCents ?? receipt.totalCents + receipt.discountCents)}`);
    lines.push(`DISCOUNT: -${formatCents(receipt.discountCents)}`);
  }
  if (receipt.taxCents && receipt.taxCents > 0) {
    lines.push(`TAX (${receipt.taxRatePercent}%): ${formatCents(receipt.taxCents)}`);
  }
  lines.push(`TOTAL: ${formatCents(receipt.totalCents)}`);
  for (const payment of receipt.payments) {
    lines.push(formatPaymentLine(payment));
  }
```

- [ ] **Step 3: Update `buildReceiptHtml`** the same way

Replace the `summaryRows`/`paymentRows` construction:

```typescript
  const hasDiscount = Boolean(receipt.discountCents && receipt.discountCents > 0);
  const hasTax = Boolean(receipt.taxCents && receipt.taxCents > 0);
  const summaryRows = `${hasDiscount ? `<div class="row muted"><span>Subtotal</span><span>${formatCents(receipt.subtotalCents ?? receipt.totalCents + (receipt.discountCents ?? 0))}</span></div>
       <div class="row muted"><span>Discount</span><span>-${formatCents(receipt.discountCents ?? 0)}</span></div>` : ''}${hasTax ? `<div class="row muted"><span>Tax (${receipt.taxRatePercent}%)</span><span>${formatCents(receipt.taxCents ?? 0)}</span></div>` : ''}`;

  const paymentRows = receipt.payments
    .map((p) => {
      const hasCurrency = p.currencyCode && p.foreignAmountCents !== null && p.exchangeRate !== null;
      const line = hasCurrency
        ? `${methodLabel(p.method)} (${p.currencyCode}): ${esc(formatForeignCents(p.foreignAmountCents as number, p.currencyCode as string))} @ ${p.exchangeRate}/$`
        : methodLabel(p.method);
      return `<div class="row muted"><span>${line}</span><span>${formatCents(p.amountCents)}</span></div>`;
    })
    .join('');
```

- [ ] **Step 4: Manual verification** (receipt builders have no existing unit tests — consistent with the rest of the codebase, which tests pure calculation logic like `cart.ts`/`currency.ts` but not string/HTML builders)

Since there's no automated test here, this task is verified together with Task 12 (POS checkout) once the full flow is wired up and run in the browser.

- [ ] **Step 5: Commit**

```bash
git add src/lib/receipt.ts
git commit -m "feat: render tax and foreign-currency payment detail on receipts"
```

---

## Task 9: `PaymentMethodPicker` — currency selection UI

**Files:**
- Modify: `src/components/payment-method-picker.tsx`

**Interfaces:**
- Consumes: `Currency` (Task 2), `foreignCentsToUsdCents`/`usdCentsToForeignCents` (Task 3), `PaymentLine` currency fields (Task 2).
- Produces: `PaymentMethodPicker` accepts a new **optional** `currencies?: Currency[]` prop, defaulting to `[]` (pass only **active** currencies — filtering happens in the caller, Task 12). When `currencies` is empty, behavior is pixel-identical to today (no currency row rendered). It's optional, not required, because this component has a second call site — `src/app/(owner)/(tabs)/sales.tsx`'s `SaleEditor` (line 513) — that this plan does not touch (editing a past sale's payments with currency conversion is out of scope, per the spec's non-goals); defaulting to `[]` keeps that call site compiling and behaving exactly as it does today.

- [ ] **Step 1: Add the `currencies` prop and currency draft state**

```typescript
import { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { CategoryChip } from '@/components/category-chip';
import { foreignCentsToUsdCents, formatCents, toCents, usdCentsToForeignCents } from '@/lib/currency';
import { methodLabel, paymentMethods as methods } from '@/lib/payment-methods';
import type { Currency, PaymentLine, PaymentMethod } from '@/types/models';

export function PaymentMethodPicker({
  totalCents,
  payments,
  currencies = [],
  onChange,
}: {
  totalCents: number;
  payments: PaymentLine[];
  currencies?: Currency[];
  onChange: (payments: PaymentLine[]) => void;
}) {
  const [draftMethod, setDraftMethod] = useState<PaymentMethod | null>(null);
  const [amountInput, setAmountInput] = useState('');
  const [customerName, setCustomerName] = useState('');
  const [customerPhone, setCustomerPhone] = useState('');
  const [draftCurrency, setDraftCurrency] = useState<Currency | null>(null);

  const paidCents = payments.reduce((sum, p) => sum + p.amountCents, 0);
  const remainingCents = totalCents - paidCents;
  const isCash = draftMethod === 'cash';

  const startDraft = (method: PaymentMethod) => {
    setDraftMethod(method);
    setDraftCurrency(null);
    setAmountInput(remainingCents > 0 ? (remainingCents / 100).toFixed(2) : '');
    setCustomerName('');
    setCustomerPhone('');
  };

  const cancelDraft = () => setDraftMethod(null);

  const pickCurrency = (currency: Currency | null) => {
    setDraftCurrency(currency);
    if (remainingCents <= 0) { setAmountInput(''); return; }
    const remainingInCurrency = currency ? usdCentsToForeignCents(remainingCents, currency.rateToUsd) : remainingCents;
    setAmountInput((remainingInCurrency / 100).toFixed(2));
  };
```

- [ ] **Step 2: Convert the entered amount through the rate before applying the existing cash/change logic**

Replace the block computing `enteredCents`/`draftAppliedCents`/`draftChangeCents`/`draftValid`:

```typescript
  // Whatever's typed is always in `draftCurrency`'s minor unit (or USD
  // cents when draftCurrency is null) — converted to USD cents here once,
  // so every downstream calculation (applied amount, cap at remaining,
  // change) is identical to the existing USD-only logic, just fed a
  // converted number.
  const enteredForeignCents = toCents(amountInput || '0');
  const enteredCentsUsd = draftCurrency ? foreignCentsToUsdCents(enteredForeignCents, draftCurrency.rateToUsd) : enteredForeignCents;
  const draftAppliedCents = isCash ? Math.min(enteredCentsUsd, remainingCents) : enteredCentsUsd;
  const draftChangeCentsUsd = isCash && enteredCentsUsd > remainingCents ? enteredCentsUsd - remainingCents : 0;
  const draftValid = enteredCentsUsd > 0 && draftAppliedCents > 0 && draftAppliedCents <= remainingCents;
```

- [ ] **Step 3: Include the new fields when adding a payment line**

```typescript
  const addDraft = () => {
    if (!draftMethod || !draftValid) return;
    onChange([
      ...payments,
      {
        method: draftMethod,
        amountCents: draftAppliedCents,
        tenderedCents: draftChangeCentsUsd > 0 ? enteredCentsUsd : null,
        customerName: (draftMethod === 'zaad' || draftMethod === 'edahab') && customerName.trim() ? customerName.trim() : null,
        customerPhone: (draftMethod === 'zaad' || draftMethod === 'edahab') && customerPhone.trim() ? customerPhone.trim() : null,
        currencyCode: draftCurrency ? draftCurrency.code : null,
        exchangeRate: draftCurrency ? draftCurrency.rateToUsd : null,
        foreignAmountCents: draftCurrency ? enteredForeignCents : null,
        foreignChangeCents: draftCurrency && draftChangeCentsUsd > 0 ? usdCentsToForeignCents(draftChangeCentsUsd, draftCurrency.rateToUsd) : null,
      },
    ]);
    setDraftMethod(null);
    setDraftCurrency(null);
  };
```

- [ ] **Step 4: Render the currency chip row and adjust labels/helper text**

In the JSX, inside the `draftCard` (after the `draftHeader`, before the `AMOUNT`/`CASH RECEIVED` label), add:

```tsx
              {currencies.length > 0 && (
                <>
                  <Text style={styles.fieldLabel}>CURRENCY</Text>
                  <View style={styles.currencyRow}>
                    <CategoryChip label="USD" active={draftCurrency === null} onPress={() => pickCurrency(null)} />
                    {currencies.map((c) => (
                      <CategoryChip key={c.id} label={c.code} active={draftCurrency?.id === c.id} onPress={() => pickCurrency(c)} />
                    ))}
                  </View>
                </>
              )}

              <Text style={styles.fieldLabel}>{isCash ? (draftCurrency ? `${draftCurrency.code} RECEIVED` : 'CASH RECEIVED') : `AMOUNT${draftCurrency ? ` (${draftCurrency.code})` : ''}`}</Text>
              <TextInput value={amountInput} onChangeText={setAmountInput} placeholder="0.00" placeholderTextColor="#9B9B9B" keyboardType="decimal-pad" style={styles.input} />
              {draftCurrency && enteredForeignCents > 0 && <Text style={styles.conversionText}>≈ {formatCents(enteredCentsUsd)}</Text>}
              {isCash && draftChangeCentsUsd > 0 && (
                <Text style={styles.changeText}>
                  Change due: {draftCurrency ? `${formatCents(draftChangeCentsUsd)} (${usdCentsToForeignCents(draftChangeCentsUsd, draftCurrency.rateToUsd) / 100} ${draftCurrency.code})` : formatCents(draftChangeCentsUsd)}
                </Text>
              )}
              {isCash && enteredCentsUsd > 0 && enteredCentsUsd < remainingCents && (
                <Text style={styles.partialText}>Applies {formatCents(enteredCentsUsd)} to this sale — {formatCents(remainingCents - enteredCentsUsd)} will still be owed.</Text>
              )}
```

This replaces the existing `AMOUNT`/`CASH RECEIVED` label line, the `TextInput`, the `changeText` block, and the `partialText` block — the `(draftMethod === 'zaad' || draftMethod === 'edahab')` customer name/phone block right after stays unchanged.

- [ ] **Step 5: Add the `currencyRow`/`conversionText` styles**

In the `StyleSheet.create` block, add:

```typescript
  currencyRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 4 },
  conversionText: { fontSize: 12, fontWeight: '600', color: '#777777', marginTop: 6 },
```

- [ ] **Step 6: Manual verification** (this component has no existing unit tests — it's UI, consistent with the codebase's pattern of testing pure `lib/` logic, not components)

Deferred to Task 12's manual verification of the full POS checkout flow.

- [ ] **Step 7: Commit**

```bash
git add src/components/payment-method-picker.tsx
git commit -m "feat: add currency selection to the payment method picker"
```

---

## Task 10: `ReceiptModal` — render tax and currency detail

**Files:**
- Modify: `src/components/receipt-modal.tsx`

**Interfaces:**
- Consumes: `ReceiptData.taxCents`/`taxRatePercent` (Task 8), `PaymentLine` currency fields (Task 2), `formatForeignCents` (Task 3).

- [ ] **Step 1: Import `formatForeignCents`**

```typescript
import { formatCents, formatForeignCents } from '@/lib/currency';
```

- [ ] **Step 2: Render the tax row**

Right after the existing discount block and before `totalRow`:

```tsx
              {Boolean(receipt.taxCents && receipt.taxCents > 0) && (
                <View style={styles.row}>
                  <Text style={styles.muted}>Tax ({receipt.taxRatePercent}%)</Text>
                  <Text style={styles.muted}>{formatCents(receipt.taxCents ?? 0)}</Text>
                </View>
              )}
```

- [ ] **Step 3: Render currency detail on each payment row**

Replace the `receipt.payments.map(...)` block:

```tsx
              {receipt.payments.map((payment, i) => {
                const hasCurrency = payment.currencyCode && payment.foreignAmountCents !== null && payment.exchangeRate !== null;
                return (
                  <View key={i} style={styles.row}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.muted}>{methodLabel(payment.method)}</Text>
                      {hasCurrency && (
                        <Text style={styles.muted}>
                          {formatForeignCents(payment.foreignAmountCents as number, payment.currencyCode as string)} @ {payment.exchangeRate}/$
                        </Text>
                      )}
                    </View>
                    <Text style={styles.muted}>{formatCents(payment.amountCents)}</Text>
                  </View>
                );
              })}
```

- [ ] **Step 4: Manual verification** — deferred to Task 12 (full checkout flow in the browser).

- [ ] **Step 5: Commit**

```bash
git add src/components/receipt-modal.tsx
git commit -m "feat: show tax and foreign-currency detail in the receipt modal"
```

---

## Task 11: Settings screen — tax toggle and currencies management

**Files:**
- Modify: `src/app/(owner)/settings.tsx`

**Interfaces:**
- Consumes: `Shop.taxEnabled`/`taxRatePercent` (Task 2), `Currency` (Task 2), `listCurrencies`/`createCurrency`/`updateCurrency`/`setCurrencyActive`/`deleteCurrency` (Task 6), `updateShop` (Task 5).
- Produces: Settings UI for both features, following the file's existing `ShopSection`/`PromotionsSection`+`PromotionsModal` patterns exactly (no new styles needed beyond one row — see Step 5).

- [ ] **Step 1: Add tax fields to `ShopSection`**

In `ShopSection`, add state right after `goalInput`:

```typescript
  const [taxEnabled, setTaxEnabled] = useState(shop.taxEnabled);
  const [taxRateInput, setTaxRateInput] = useState(String(shop.taxRatePercent));
```

Add to the `dirty` check:

```typescript
  const dirty =
    name.trim() !== (shop.name ?? '') ||
    contactPhone.trim() !== (shop.contactPhone ?? '') ||
    city.trim() !== (shop.city ?? '') ||
    neighborhood.trim() !== (shop.neighborhood ?? '') ||
    description.trim() !== (shop.description ?? '') ||
    returnPolicy.trim() !== (shop.returnPolicy ?? '') ||
    goalInput.trim() !== shopGoalInput ||
    logoUri !== shop.logoUrl ||
    taxEnabled !== shop.taxEnabled ||
    taxRateInput.trim() !== String(shop.taxRatePercent);
```

Add to the `save` call's `updateShop` payload:

```typescript
      await updateShop(shop.id, {
        name: name.trim(),
        contactPhone: contactPhone.trim(),
        city: city.trim(),
        neighborhood: neighborhood.trim(),
        description: description.trim(),
        returnPolicy: returnPolicy.trim(),
        monthlyRevenueGoalCents: goalInput.trim() ? toCents(goalInput) : null,
        logoUrl,
        taxEnabled,
        taxRatePercent: Number(taxRateInput) || 0,
      });
```

Add the fields to the JSX, right after the monthly revenue goal block (after its `<Text style={styles.hint}>` line):

```tsx
      <Text style={styles.fieldLabel}>TAX</Text>
      <View style={styles.taxRow}>
        <Pressable onPress={() => setTaxEnabled((v) => !v)} style={[styles.taxToggle, taxEnabled && styles.taxToggleOn]}>
          <Text style={[styles.taxToggleText, taxEnabled && styles.taxToggleTextOn]}>{taxEnabled ? 'Enabled' : 'Disabled'}</Text>
        </Pressable>
        {taxEnabled && (
          <View style={styles.taxRateInputWrap}>
            <TextInput value={taxRateInput} onChangeText={setTaxRateInput} placeholder="2.5" placeholderTextColor="#999999" keyboardType="decimal-pad" style={styles.taxRateInput} />
            <Text style={styles.taxRatePercentSign}>%</Text>
          </View>
        )}
      </View>
      <Text style={styles.hint}>When enabled, this rate is added to every sale's total, on top of any discounts.</Text>
```

- [ ] **Step 2: Write `src/lib/currencies.ts`-backed state and reload in the main `SettingsScreen`**

In `SettingsScreen`, add currency state and load it alongside the rest:

```typescript
  const [currencies, setCurrencies] = useState<Currency[]>([]);
```

In `reload`'s `Promise.all`, add `listCurrencies(shop.id)` and destructure it:

```typescript
      const [brandRows, cats, tagRows, cashierRows, productRows, promotionRows, currencyRows] = await Promise.all([
        listBrands(shop.id),
        listCategories(shop.id),
        listTags(shop.id),
        listCashiers(shop.id),
        listProducts(shop.id),
        listPromotions(shop.id),
        listCurrencies(shop.id),
      ]);
```

and after `setPromotions(promotionRows);`:

```typescript
      setCurrencies(currencyRows);
```

Add the new import at the top:

```typescript
import { createCurrency, deleteCurrency, listCurrencies, setCurrencyActive, updateCurrency } from '@/lib/currencies';
```

and add `Currency` to the `@/types/models` import list.

Render a `CurrenciesSection` right after `<PromotionsSection ... />` in the JSX:

```tsx
            <CurrenciesSection shopId={shop.id} currencies={currencies} onChange={reload} />
```

- [ ] **Step 3: Write the `CurrenciesSection` component**

Add this function to `settings.tsx`, right after `PromotionsSection`/`PromotionsModal` (following the exact same preview+modal structure):

```tsx
function CurrenciesSection({
  shopId,
  currencies,
  onChange,
}: {
  shopId: string;
  currencies: Currency[];
  onChange: () => Promise<void>;
}) {
  const [modalOpen, setModalOpen] = useState(false);
  const preview = currencies.slice(0, previewCount);

  return (
    <View style={styles.section}>
      <View style={styles.sectionHeaderRow}>
        <View style={{ flex: 1 }}>
          <Text style={styles.sectionTitle}>CURRENCIES</Text>
          <Text style={styles.hint}>Alternate currencies a cashier can accept at checkout, converted to USD by the rate below. Sales are always recorded in USD.</Text>
        </View>
        <Pressable onPress={() => setModalOpen(true)} style={styles.manageButton}>
          <Text style={styles.manageButtonText}>Manage ({currencies.length})</Text>
        </Pressable>
      </View>

      {currencies.length === 0 ? (
        <Text style={styles.empty}>None yet.</Text>
      ) : (
        <View style={styles.previewRow}>
          {preview.map((c) => (
            <View key={c.id} style={[styles.previewChip, !c.active && styles.previewChipInactive]}>
              <Text style={styles.previewChipText}>{c.code}</Text>
              <Text style={styles.previewChipCount}>{c.rateToUsd}/$1</Text>
            </View>
          ))}
        </View>
      )}

      <CurrenciesModal visible={modalOpen} onClose={() => setModalOpen(false)} shopId={shopId} currencies={currencies} onChange={onChange} />
    </View>
  );
}

function CurrenciesModal({
  visible,
  onClose,
  shopId,
  currencies,
  onChange,
}: {
  visible: boolean;
  onClose: () => void;
  shopId: string;
  currencies: Currency[];
  onChange: () => Promise<void>;
}) {
  const [error, setError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);

  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [symbol, setSymbol] = useState('');
  const [rateInput, setRateInput] = useState('');

  const resetForm = () => {
    setEditingId(null);
    setCode('');
    setName('');
    setSymbol('');
    setRateInput('');
  };

  const startEdit = (currency: Currency) => {
    setEditingId(currency.id);
    setCode(currency.code);
    setName(currency.name);
    setSymbol(currency.symbol);
    setRateInput(String(currency.rateToUsd));
    setConfirmingDelete(null);
  };

  const run = async (action: () => Promise<void>) => {
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
    }
  };

  const submit = () => {
    const trimmedCode = code.trim().toUpperCase();
    const trimmedName = name.trim();
    const trimmedSymbol = symbol.trim();
    const rate = Number(rateInput);
    if (!trimmedName || !trimmedSymbol || !rate || rate <= 0) return;
    run(async () => {
      if (editingId) {
        await updateCurrency(editingId, { name: trimmedName, symbol: trimmedSymbol, rateToUsd: rate });
      } else {
        if (!trimmedCode) return;
        await createCurrency(shopId, { code: trimmedCode, name: trimmedName, symbol: trimmedSymbol, rateToUsd: rate });
      }
      await onChange();
      resetForm();
    });
  };

  const toggleActive = (currency: Currency) => run(async () => { await setCurrencyActive(currency.id, !currency.active); await onChange(); });

  return (
    <Modal visible={visible} animationType="fade" transparent onRequestClose={onClose}>
      <View style={styles.modalOverlay}>
        <View style={styles.modalCard}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>Currencies</Text>
            <Pressable onPress={onClose}><Text style={styles.modalClose}>Done</Text></Pressable>
          </View>

          {error && <Text style={styles.error}>{error}</Text>}

          <ScrollView style={styles.modalList}>
            {currencies.length === 0 && <Text style={styles.empty}>None yet — add one below.</Text>}
            {currencies.map((currency) => (
              <View key={currency.id} style={styles.row}>
                {confirmingDelete === currency.id ? (
                  <>
                    <Text style={[styles.rowLabel, { flex: 1 }]}>Delete &quot;{currency.code}&quot;?</Text>
                    <Pressable onPress={() => run(async () => { await deleteCurrency(currency.id); await onChange(); setConfirmingDelete(null); })} style={styles.rowAction}><Text style={styles.rowActionTextDanger}>Confirm</Text></Pressable>
                    <Pressable onPress={() => setConfirmingDelete(null)} style={styles.rowAction}><Text style={styles.rowActionTextMuted}>Cancel</Text></Pressable>
                  </>
                ) : (
                  <>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.rowLabel}>{currency.code} · {currency.name}</Text>
                      <Text style={styles.rowSubLabel}>{currency.symbol} · {currency.rateToUsd} per $1</Text>
                    </View>
                    <Pressable onPress={() => toggleActive(currency)} style={styles.rowAction}>
                      <Text style={currency.active ? styles.rowActionText : styles.rowActionTextMuted}>{currency.active ? 'Active' : 'Inactive'}</Text>
                    </Pressable>
                    <Pressable onPress={() => startEdit(currency)} style={styles.rowAction}><Text style={styles.rowActionText}>Edit</Text></Pressable>
                    <Pressable onPress={() => setConfirmingDelete(currency.id)} style={styles.rowAction}><Text style={styles.rowActionTextDanger}>Delete</Text></Pressable>
                  </>
                )}
              </View>
            ))}
          </ScrollView>

          <View style={styles.promoForm}>
            <Text style={styles.fieldLabel}>{editingId ? 'EDIT CURRENCY' : 'NEW CURRENCY'}</Text>
            <View style={styles.formRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.fieldLabel}>CODE</Text>
                {editingId ? (
                  <View style={styles.readOnlyField}><Text style={styles.readOnlyFieldText}>{code}</Text></View>
                ) : (
                  <TextInput value={code} onChangeText={setCode} placeholder="SLSH" placeholderTextColor="#999999" autoCapitalize="characters" style={styles.input} />
                )}
              </View>
              <View style={{ flex: 2 }}>
                <Text style={styles.fieldLabel}>NAME</Text>
                <TextInput value={name} onChangeText={setName} placeholder="Somaliland Shilling" placeholderTextColor="#999999" style={styles.input} />
              </View>
            </View>
            <View style={styles.formRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.fieldLabel}>SYMBOL</Text>
                <TextInput value={symbol} onChangeText={setSymbol} placeholder="Sl Sh" placeholderTextColor="#999999" style={styles.input} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.fieldLabel}>RATE (PER $1)</Text>
                <TextInput value={rateInput} onChangeText={setRateInput} placeholder="115" placeholderTextColor="#999999" keyboardType="decimal-pad" style={styles.input} />
              </View>
            </View>
            <View style={styles.promoFormActions}>
              {editingId && (
                <Pressable onPress={resetForm} style={styles.rowAction}><Text style={styles.rowActionTextMuted}>Cancel edit</Text></Pressable>
              )}
              <Pressable onPress={submit} style={styles.addButton}>
                <Text style={styles.addButtonText}>{editingId ? 'Save changes' : 'Add currency'}</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </View>
    </Modal>
  );
}
```

- [ ] **Step 4: Add the `Currency` type and `useState` import already present** — no new import needed beyond what Step 2 added (`useState`/`useMemo`/etc. are already imported at the top of the file).

- [ ] **Step 5: Add the tax toggle styles**

In the `StyleSheet.create` block, add:

```typescript
  taxRow: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 2 },
  taxToggle: { backgroundColor: '#F2F2F2', borderRadius: 10, paddingVertical: 9, paddingHorizontal: 16 },
  taxToggleOn: { backgroundColor: '#111111' },
  taxToggleText: { fontSize: 12, fontWeight: '700', color: '#999999' },
  taxToggleTextOn: { color: '#FFFFFF' },
  taxRateInputWrap: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#F2F2F2', borderRadius: 10, height: 42, paddingHorizontal: 12, gap: 4 },
  taxRateInput: { width: 50, color: '#111111', fontSize: 14 },
  taxRatePercentSign: { color: '#999999', fontSize: 14, fontWeight: '700' },
```

- [ ] **Step 6: Run tsc and manually verify in the browser**

Run: `npx tsc --noEmit`
Expected: no new errors from `settings.tsx`.

Then start the dev server and manually verify: `npx expo start --web`. In Settings, confirm: the tax toggle switches between Disabled/Enabled and the rate field appears/disappears; the rate field defaults to `2.5`; Currencies section shows Somaliland Shilling (active) and Ethiopian Birr (inactive) after Task 1's migration has been applied to the database; adding, editing, toggling, and deleting a currency all work and persist after a reload.

- [ ] **Step 7: Commit**

```bash
git add src/app/\(owner\)/settings.tsx
git commit -m "feat: add tax toggle and currency management to Settings"
```

---

## Task 12: POS cart totals, checkout, and receipt wiring

**Files:**
- Modify: `src/app/(owner)/(tabs)/pos.tsx`

**Interfaces:**
- Consumes: `listCurrencies` (Task 6), `taxCentsFor` (Task 4), `PaymentMethodPicker`'s new `currencies` prop (Task 9), `ReceiptData.taxCents`/`taxRatePercent` (Task 8).

- [ ] **Step 1: Fetch active currencies alongside the existing categories/cashiers/promotions fetches**

Add state and a loader effect, following the exact pattern already used for `promotions`:

```typescript
  const [currencies, setCurrencies] = useState<Currency[]>([]);
```

```typescript
  useEffect(() => {
    if (!shop) return;
    listCurrencies(shop.id).then((rows) => setCurrencies(rows.filter((c) => c.active))).catch(() => {});
  }, [shop]);
```

Add imports:

```typescript
import { listCurrencies } from '@/lib/currencies';
import { taxCentsFor } from '@/lib/tax';
```

and add `Currency` to the `@/types/models` import list.

- [ ] **Step 2: Compute tax and rename the taxable base**

Replace the totals block:

```typescript
  const grossCents = cartTotalCents(cart);
  const subtotalCents = cartSubtotalCents(cart, promotions);
  const transactionDiscountCents = discountAmountCents(subtotalCents, transactionDiscount);
  const preTaxTotalCents = subtotalCents - transactionDiscountCents;
  const taxCents = shop?.taxEnabled ? taxCentsFor(preTaxTotalCents, shop.taxRatePercent) : 0;
  const total = preTaxTotalCents + taxCents;
  const hasAnyDiscount = grossCents !== preTaxTotalCents;
  const paidCents = payments.reduce((sum, p) => sum + p.amountCents, 0);
  const fullyPaid = payments.length > 0 && paidCents === total;
```

(`total` keeps its name — every existing downstream use, `useEffect(() => { setPayments([]); }, [total])`, `<PaymentMethodPicker totalCents={total} ...>`, the `checkout` disabled check, and the `<Text style={styles.totalValue}>{formatCents(total)}</Text>` row — now correctly means the tax-inclusive total with zero further changes needed at those call sites.)

- [ ] **Step 3: Add the tax row to the totals JSX**

Right after the existing `discountSection`'s discount `summaryRow` block (the one showing `-{formatCents(grossCents - total)}` — note this line itself needs updating since `total` now includes tax, see next step) and before the order-discount toggle:

Replace the whole `discountSection` block:

```tsx
          <View style={styles.discountSection}>
            {hasAnyDiscount && (
              <>
                <View style={styles.summaryRow}>
                  <Text style={styles.summaryLabel}>Subtotal</Text>
                  <Text style={styles.summaryValue}>{formatCents(grossCents)}</Text>
                </View>
                <View style={styles.summaryRow}>
                  <Text style={styles.summaryLabel}>Discount</Text>
                  <Text style={styles.summaryValueDiscount}>-{formatCents(grossCents - preTaxTotalCents)}</Text>
                </View>
              </>
            )}
            {taxCents > 0 && (
              <View style={styles.summaryRow}>
                <Text style={styles.summaryLabel}>Tax ({shop?.taxRatePercent}%)</Text>
                <Text style={styles.summaryValue}>{formatCents(taxCents)}</Text>
              </View>
            )}
            <Pressable onPress={() => setEditingTransactionDiscount((v) => !v)}>
              <Text style={styles.cartLineDiscountToggle}>
                {transactionDiscount ? 'Edit order discount' : '+ Add order discount'}
              </Text>
            </Pressable>
            {editingTransactionDiscount && (
              <DiscountEditor
                initial={transactionDiscount}
                onApply={(discount) => { setTransactionDiscount(discount); setEditingTransactionDiscount(false); }}
                onRemove={transactionDiscount ? () => { setTransactionDiscount(null); setEditingTransactionDiscount(false); } : undefined}
              />
            )}
          </View>
```

- [ ] **Step 4: Pass `currencies` to `PaymentMethodPicker`**

```tsx
          <PaymentMethodPicker totalCents={total} payments={payments} currencies={currencies} onChange={setPayments} />
```

- [ ] **Step 5: Include tax in the post-checkout receipt**

In `checkout`, update the `setReceipt(...)` call:

```typescript
      setReceipt({
        shopName: shop.name,
        shopLogoUrl: shop.logoUrl,
        shopCity: shop.city,
        shopNeighborhood: shop.neighborhood,
        shopContactPhone: shop.contactPhone,
        cashierName,
        returnPolicy: shop.returnPolicy,
        items: cart.map((line) => ({
          name: line.product.name,
          quantity: line.quantity,
          unitPriceCents: line.product.priceCents,
          discountCents: lineDiscountCents(line, promotions),
        })),
        payments,
        customer: { name: customerName.trim() || null, phone: customerPhone.trim() || null, email: customerEmail.trim() || null },
        subtotalCents: grossCents,
        discountCents: grossCents - preTaxTotalCents,
        taxCents,
        taxRatePercent: shop.taxEnabled ? shop.taxRatePercent : null,
        totalCents: total,
        createdAt: new Date().toISOString(),
      });
```

- [ ] **Step 6: Manual verification in the browser**

Run: `npx expo start --web`

Verify, with tax enabled at 2.5% and Somaliland Shilling active (from Task 11's Settings work):
1. Add items to the cart — confirm a Tax row appears in the totals showing the correct 2.5%-of-post-discount-subtotal amount, and the Total includes it.
2. Open the payment picker, pick Cash, pick the SLSH currency chip — confirm the amount field relabels, shows a live "≈ $X.XX" conversion, and that a split payment (part USD, part SLSH) sums correctly to a fully-paid state.
3. Complete the sale — confirm the receipt modal shows the Tax line and the SLSH payment's amount/rate/USD-equivalent.
4. Go to the Sales screen, open the same sale's receipt again — confirm it still shows correctly (exercising `buildReceiptFromSale`, not the checkout-time receipt object).

- [ ] **Step 7: Commit**

```bash
git add src/app/\(owner\)/\(tabs\)/pos.tsx
git commit -m "feat: wire tax and multi-currency payments into the POS checkout flow"
```

---

## Task 13: Full verification pass

**Files:** none (verification only)

- [ ] **Step 1: Run the full test suite**

Run: `npx jest`
Expected: all suites pass, including the new/extended `currency.test.ts` and `tax.test.ts`.

- [ ] **Step 2: Run a full type check**

Run: `npx tsc --noEmit`
Expected: no errors anywhere in `src/`.

- [ ] **Step 3: Lint**

Run: `npm run lint`
Expected: no new errors.

- [ ] **Step 4: Confirm the migration is applied before final manual sign-off**

Since this environment has no local Supabase, confirm with the user that `supabase/migrations/0015_tax_and_currencies.sql` has been applied to the target database (dashboard SQL editor, `supabase db push`, or the Supabase MCP once authorized) before treating Task 11/12's manual verification steps as complete.

- [ ] **Step 5: Commit** (only if any fixes were needed in this task)

```bash
git add -A
git commit -m "fix: address type/lint issues from full verification pass"
```
