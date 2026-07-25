# POS tax + multi-currency checkout

## Overview

Two additions to the POS checkout flow:

1. **Tax** — a single shop-wide tax rate, off by default, that the owner can enable in Settings. Defaults to 2.5% when first turned on, editable after that.
2. **Multi-currency payments** — the shop keeps recording sales in USD (the existing source of truth), but a cashier can settle a payment line in an alternate currency (starting with Somaliland Shilling and Ethiopian Birr) using a shop-configured exchange rate. Split payments already exist (part cash / part ZAAD); this extends that to let each split line carry its own currency, so a customer can pay $5 in USD cash and the remainder in Somaliland Shillings on a second line — a common real pattern since the smallest USD note in circulation locally is $1.

Both features build on existing patterns in the codebase: shop-level settings (`monthlyRevenueGoalCents`), the manage-list UI (Brands/Categories/Tags), and the split-payment (`PaymentLine[]`) checkout flow.

## Goals

- Owner can enable/disable tax and set its rate in Settings, defaulting to 2.5% the first time it's enabled.
- Tax is computed server-side (inside `complete_sale`/`edit_sale`), on the post-discount subtotal, and shown as its own line in the POS cart totals and on the receipt.
- Owner can manage a list of currencies (code, name, symbol, exchange rate, active/inactive) in Settings, seeded with Somaliland Shilling (active, 115/$1) and Ethiopian Birr (inactive, seeded at a placeholder 130/$1 — **verify this rate before activating it**, it's not a live figure).
- At checkout, any active currency can be picked per payment line; the amount is entered in that currency, converted to USD via the shop's rate, and applied toward the total exactly as cash/other payments are today (including tender/change for cash).
- A sale can mix currencies across its split payment lines.
- Receipts show, per foreign-currency payment line: the amount in that currency, the exchange rate used, and the USD equivalent.

## Non-goals

- Re-pricing products or the cart subtotal in a foreign currency — prices and totals stay in USD throughout; currency only applies to how a payment line is settled.
- Per-product tax exemptions or multiple tax rates/brackets — one shop-wide rate.
- Historical FX-rate tracking beyond what's snapshotted onto each payment at the time of sale.
- Live/external FX rate lookups — rates are manually set by the owner in Settings.

## Data model

### Tax

```sql
alter table public.shops
  add column tax_enabled boolean not null default false,
  add column tax_rate_percent numeric(5,2) not null default 2.5;

alter table public.sales
  add column tax_cents integer not null default 0,
  add column tax_rate_percent numeric(5,2); -- snapshot at time of sale, null if tax was disabled
```

### Currencies

```sql
create table public.shop_currencies (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  code text not null,           -- e.g. 'SLSH', 'ETB'
  name text not null,           -- e.g. 'Somaliland Shilling'
  symbol text not null,         -- e.g. 'Sl Sh', 'Br'
  rate_to_usd numeric not null check (rate_to_usd > 0), -- units of this currency per $1 USD
  active boolean not null default false,
  created_at timestamptz not null default now(),
  unique (shop_id, code)
);
create index shop_currencies_shop_id_idx on public.shop_currencies(shop_id);

alter table public.shop_currencies enable row level security;
create policy "own shop_currencies" on public.shop_currencies for all
  using (owns_shop(shop_id)) with check (owns_shop(shop_id));
grant select, insert, update, delete on public.shop_currencies to authenticated;
```

Seeded for the current shop(s) in the migration itself (backfill), and inserted in `createShop()` (app code) for any shop created afterward — same two rows, same defaults, so the migration and app code stay in sync without a database trigger (no other table in this schema seeds itself via trigger; `createShop()` already does related setup in application code, so this follows the existing pattern rather than introducing a new one).

### Payments

```sql
alter table public.sale_payments
  add column currency_code text,          -- null = USD (no conversion)
  add column exchange_rate numeric,        -- rate_to_usd snapshot at time of payment
  add column foreign_amount_cents integer, -- amount entered/tendered, in the foreign currency's minor unit
  add column foreign_change_cents integer; -- change due, in the foreign currency (cash only)
```

`amount_cents` (existing column) keeps meaning exactly what it means today: the USD-cents amount applied toward the sale. These four new columns are purely for display/audit — reconstructing what the cashier actually handled at the register.

## Server-side calculation (`complete_sale` / `edit_sale`)

Both RPCs already compute `v_gross_cents` (sum of line totals after per-line discounts) and `v_total_cents := v_gross_cents - v_discount_cents` (after the transaction-level discount). Tax is added on top of that, computed from the shop's own row — **not** a client-supplied parameter, so a cashier can't under-report it:

```sql
select tax_enabled, tax_rate_percent into v_tax_enabled, v_tax_rate from public.shops where id = p_shop_id;
v_tax_cents := case when v_tax_enabled then round(v_total_cents * v_tax_rate / 100) else 0 end;
v_total_cents := v_total_cents + v_tax_cents;
```

This happens after the existing discount logic and before the payments loop, so `v_payments_total <> v_total_cents` still validates against the tax-inclusive total. `sales.tax_cents` and `sales.tax_rate_percent` are set alongside `total_cents`.

The payments loop already accepts a jsonb array — no signature change needed. Each payment object may now carry `currency_code`, `exchange_rate`, `foreign_amount_cents`, `foreign_change_cents`; the RPC just passes them through into `sale_payments` unchanged (no validation of the conversion math server-side, same trust level as `tendered_cents` today — the client computes it, the server just needs `amount_cents` to add up).

## Client changes

### Settings screen

- **Tax**: new fields in `ShopSection` — an on/off toggle and a rate input, following the same `dirty`/`save` pattern as the revenue goal field. Rate input defaults to `2.5` the moment tax is switched on if no rate has been set yet.
- **Currencies**: new `CategorySection`-style manage list (mirrors Brands/Categories) titled "CURRENCIES", showing code + name + rate, with add/rename-rate/toggle-active/delete actions. New `src/lib/currencies.ts` (`listCurrencies`, `createCurrency`, `updateCurrencyRate`, `setCurrencyActive`, `deleteCurrency`), parallel to `src/lib/brands.ts`.

### POS cart totals

Totals section gains a Tax row (shown only when `shop.taxEnabled`) between Discount and Total: `Subtotal → Discount → Tax (2.5%) → Total`. Computed client-side from `shop.taxRatePercent` for display before checkout; the server recomputes and is authoritative, same trust boundary as the existing subtotal/discount display.

### Payment method picker

After picking a method (Cash/ZAAD/e-Dahab/Other), if the shop has any active currency, a currency chip row appears (USD + each active currency, USD selected by default). Picking a foreign currency:
- Relabels the amount field ("AMOUNT (SLSH)") and shows a live "≈ $X.XX" conversion below it.
- Reuses the existing cash tender/change logic, just converted through the rate first: entered foreign amount → USD-cents equivalent (rounded) → capped at remaining (same as today) → change, if any, shown back in the foreign currency.
- For non-cash methods, works like today's flat "amount applied" entry, just interpreted in the chosen currency.

`PaymentLine` type gains optional `currencyCode`, `exchangeRate`, `foreignAmountCents`, `foreignChangeCents` — all `null`/absent for a plain USD payment, so this is additive and existing split-payment logic (multiple lines summing to the total) is untouched.

### Receipt

For any payment line with a currency set, the receipt (text, HTML, and the in-app modal) shows the foreign amount, the rate, and the USD equivalent, e.g.:

```
Cash (Sl Sh): 5,000 Sl Sh @ 115/$ = $43.48
```

Tax, when present, gets its own line above the total: `Tax (2.5%): $1.25`.

## Testing

- `src/lib/__tests__/cart.test.ts` pattern extends to a new `currency.test.ts` / additions to `discounts.test.ts`-equivalent for: foreign-amount → USD-cents conversion and rounding, tax calculation on a discounted subtotal, and split-currency payment lines summing correctly.
- Manual verification in the running app (per project convention) for the Settings UI and full POS checkout flow, including a mixed USD + SLSH split payment and a tax-enabled receipt.
