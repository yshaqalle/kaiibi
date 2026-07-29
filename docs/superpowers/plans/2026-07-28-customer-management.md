# Customer Management (CRM) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a persistent `customers` directory to the admin app — its own 5th tab with list/create/edit screens — and let POS checkout (and sale editing) attach a real customer record to a sale instead of only free-text name/phone/email.

**Architecture:** New `customers` table (shop-scoped, RLS via `is_shop_member` like every other shop table) plus a `sales.customer_id` FK. `src/lib/customers.ts` mirrors `products.ts`'s CRUD shape exactly. A new `customer-form.tsx` mirrors `product-form.tsx` (including its inlined tag-chip picker). A new shared `customer-picker.tsx` (search-or-quick-add) replaces the three bare `TextInput`s currently used for customer info in both `pos.tsx` (checkout) and `sales.tsx` (sale editing), since both need identical behavior. Full spec: `docs/superpowers/specs/2026-07-28-customer-management-design.md`.

**Tech Stack:** Expo Router v57, React Native, TypeScript, Supabase (Postgres + RLS), no component-level test suite in this repo.

## Global Constraints

- Read `AGENTS.md` at the repo root before touching any Expo API — this project pins to Expo SDK 57 and https://docs.expo.dev/versions/v57.0.0/ is the source of truth. This plan only reuses existing patterns (`TextInput`, `ScrollView`, `expo-router` push navigation) already used identically elsewhere, so no new Expo API surface is introduced.
- **RLS deviation from the design spec**: the spec's own SQL sketch uses `owns_shop(shop_id)` for the new `customers` table policy. That's stale — as of `0018_staff_shop_access.sql`, every shop-scoped table (`products`, `sales`, `tags`, `brands`, `cashiers`, `promotions`, …) uses `is_shop_member(shop_id)` instead, so cashiers (non-owner staff) can use it too. `customers` must follow the same `is_shop_member` policy, or the POS checkout picker will 403 for every cashier who isn't the shop owner. Same correction applies to the extended `rename_tag`/`delete_tag` bodies (current versions already check `is_shop_member`, not `owns_shop` — see `0018_staff_shop_access.sql:445,457`).
- This codebase has **no component-level test suite** (Jest is configured but only used for pure-logic files; there are currently zero `*.test.ts` files at all in this repo). Every prior feature plan in `docs/superpowers/plans/` follows the same verification convention this plan uses: `npx tsc --noEmit`, `npx eslint <file>`, and manual verification against the running dev server — not new Jest tests for UI components or thin Supabase CRUD wrappers.
- The Supabase CLI is linked and authenticated in this environment (confirmed this session: `supabase functions deploy`, `supabase db push`, and `supabase migration list` all work against project `jskobdvamobyigmmslrp`) — migrations in this plan should be applied with `supabase db push`, not left as a manual dashboard-paste step like some earlier plans had to do.
- Every mutating Supabase call pattern in this codebase ends by re-running a `reload()`/re-fetch in the calling screen — keep that pattern in every new screen.
- Next free migration number is **`0023`** (`0022_service_role_grants.sql` already exists on this branch after merging `main`) — the spec's own text says `0022_customers.sql`; use `0023_customers.sql` instead.
- `CREATE OR REPLACE FUNCTION` in Postgres can only add new parameters if they're appended at the end with a default value, and every existing parameter must stay byte-identical — this repo's own migration history (`0007`→`0009`→`0013`→`0015`→`0018`) already relies on this to keep growing `complete_sale`/`edit_sale`'s signature. Task 1 reproduces their full current (`0018`) bodies verbatim, only appending `p_customer_id uuid default null`.
- This project has `experiments.typedRoutes: true` (`app.json:48-49`) — route types (the `Href` union `router.push()`/`<Link href>` calls are checked against) are generated into `.expo/types/router.d.ts` by the Metro dev server at startup (or `npx expo customize`), not by `tsc` itself. Task 7/8 add brand-new route files (`customer/new.tsx`, `customer/[id].tsx`, `(tabs)/customers.tsx`). If `npx tsc --noEmit` reports a `Href`/`pathname` type error on a `router.push('/customer/...')` call right after creating these files, it's very likely a stale/missing generated-types file, not a real bug — run `npx expo start` once (it regenerates the file on boot, then it can be stopped) and re-run `tsc` before treating that specific error class as real.

---

### Task 1: Migration `0023_customers.sql`

**Files:**
- Create: `supabase/migrations/0023_customers.sql`

**Interfaces:**
- Produces: `public.customers` table (`id, shop_id, first_name, last_name, email, phone, street, city, neighborhood, tags, created_at, updated_at`), `sales.customer_id` column, `rename_tag`/`delete_tag` extended to cascade into `customers.tags`, `complete_sale`/`edit_sale` extended with `p_customer_id uuid default null`. Consumed by every later task.

- [ ] **Step 1: Create the migration file**

```sql
-- Customer management (CRM): a persistent customers directory, replacing
-- sales' free-text customer_name/phone/email-only history. See design spec
-- docs/superpowers/specs/2026-07-28-customer-management-design.md.
create table public.customers (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  first_name text not null,
  last_name text,
  email text,
  phone text,
  street text,
  city text,
  neighborhood text,
  tags text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index customers_shop_id_idx on public.customers(shop_id);

alter table public.customers enable row level security;

-- is_shop_member (not owns_shop) -- matches every other shop-scoped table's
-- current policy since 0018_staff_shop_access.sql: cashiers need to
-- search/create customers from the POS checkout picker, not just the owner.
create policy "shop members access their customers" on public.customers for all
  using (is_shop_member(shop_id)) with check (is_shop_member(shop_id));

grant select, insert, update, delete on public.customers to authenticated;

alter table public.sales add column if not exists customer_id uuid references public.customers(id) on delete set null;
create index if not exists sales_customer_id_idx on public.sales(customer_id);

-- Extend the existing tag rename/delete cascade (0004, is_shop_member check
-- added in 0018) so it also rewrites customers.tags -- the same
-- denormalized-by-name array products.tags already uses.
create or replace function public.rename_tag(p_shop_id uuid, p_old_name text, p_new_name text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_shop_member(p_shop_id) then
    raise exception 'not authorized for shop %', p_shop_id;
  end if;
  update public.tags set name = p_new_name where shop_id = p_shop_id and name = p_old_name;
  update public.products set tags = array_replace(tags, p_old_name, p_new_name), updated_at = now()
    where shop_id = p_shop_id and p_old_name = any(tags);
  update public.customers set tags = array_replace(tags, p_old_name, p_new_name), updated_at = now()
    where shop_id = p_shop_id and p_old_name = any(tags);
end;
$$;

create or replace function public.delete_tag(p_shop_id uuid, p_name text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_shop_member(p_shop_id) then
    raise exception 'not authorized for shop %', p_shop_id;
  end if;
  delete from public.tags where shop_id = p_shop_id and name = p_name;
  update public.products set tags = array_remove(tags, p_name), updated_at = now()
    where shop_id = p_shop_id and p_name = any(tags);
  update public.customers set tags = array_remove(tags, p_name), updated_at = now()
    where shop_id = p_shop_id and p_name = any(tags);
end;
$$;

-- complete_sale/edit_sale each gain p_customer_id, stored directly on the
-- sales row alongside the existing frozen customer_name/phone/email
-- snapshot (unchanged -- editing a customer's phone later must never
-- rewrite a past receipt). Reproduced here at their full current (0018)
-- signature/body, only appending the new default-valued parameter -- see
-- this plan's Global Constraints on CREATE OR REPLACE FUNCTION.
create or replace function public.complete_sale(
  p_shop_id uuid,
  p_items jsonb,
  p_payments jsonb,
  p_customer_name text default null,
  p_customer_phone text default null,
  p_customer_email text default null,
  p_cashier_name text default null,
  p_discount_cents integer default 0,
  p_customer_id uuid default null
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
  if not public.is_shop_member(p_shop_id) then
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

  insert into public.sales (shop_id, created_by, payment_method, customer_name, customer_phone, customer_email, cashier_name, discount_cents, customer_id)
    values (p_shop_id, auth.uid(), v_primary_method, nullif(p_customer_name, ''), nullif(p_customer_phone, ''), nullif(p_customer_email, ''), nullif(p_cashier_name, ''), v_discount_cents, p_customer_id)
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
  if not public.is_shop_member(v_shop_id) then
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
    customer_id = p_customer_id,
    discount_cents = v_discount_cents,
    tax_cents = v_tax_cents,
    tax_rate_percent = case when v_tax_enabled then v_tax_rate else null end
  where id = p_sale_id;
end;
$$;
```

- [ ] **Step 2: Apply the migration to the linked project**

Run: `supabase db push`
Expected: prompts to confirm, then reports `0023_customers.sql` applied. Verify with `supabase migration list` — the `0023` row's `remote` column should now be populated.

- [ ] **Step 3: Smoke-test the new table's grants (service-role and RLS both correctly wired)**

Run (replace `<SERVICE_ROLE_JWT>` with the value from `supabase projects api-keys`):
```bash
curl -s "https://jskobdvamobyigmmslrp.supabase.co/rest/v1/customers?select=id&limit=1" \
  -H "apikey: <SERVICE_ROLE_JWT>" -H "Authorization: Bearer <SERVICE_ROLE_JWT>"
```
Expected: `[]` (empty array — table exists, no permission-denied error). A `{"code":"42501",...}` response means Task 1's grants were skipped — do not proceed until this returns `[]`.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/0023_customers.sql
git commit -m "feat: add customers table and thread customer_id through complete_sale/edit_sale"
```

---

### Task 2: `Customer`/`NewCustomerInput` types, `Sale.customerId`

**Files:**
- Modify: `src/types/models.ts:50-74` (near `Product`/`NewProductInput`), `src/types/models.ts:178-210` (`Sale`)

**Interfaces:**
- Produces: `Customer`, `NewCustomerInput` types (consumed by Tasks 3, 6, 7, 8, 9); `Sale.customerId: string | null` (consumed by Tasks 4, 10, 11).

- [ ] **Step 1: Add `Customer`/`NewCustomerInput` right after `NewProductInput` (line 74)**

Insert after `export type NewProductInput = Omit<Product, 'id' | 'shopId' | 'createdAt' | 'updatedAt'>;`:
```ts

export type Customer = {
  id: string;
  shopId: string;
  firstName: string;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  street: string | null;
  city: string | null;
  neighborhood: string | null;
  tags: string[];
  createdAt: string;
  updatedAt: string;
};

export type NewCustomerInput = Omit<Customer, 'id' | 'shopId' | 'createdAt' | 'updatedAt'>;
```

- [ ] **Step 2: Add `customerId` to `Sale`, right after `customerEmail`**

In the `Sale` type (around line 190), change:
```ts
  customerName: string | null;
  customerPhone: string | null;
  customerEmail: string | null;
```
to:
```ts
  customerName: string | null;
  customerPhone: string | null;
  customerEmail: string | null;
  // The linked customer record, if this sale was attached to one at
  // checkout/edit time -- independent of the frozen name/phone/email
  // snapshot above, which never changes even if the customer record does.
  customerId: string | null;
```

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit`
Expected: a new error in `src/lib/sales.ts` — `mapSaleRow`'s return object is missing `customerId`, so it no longer satisfies `Sale`. This confirms the type change took effect (Task 4 fixes it).

- [ ] **Step 4: Commit**

```bash
git add src/types/models.ts
git commit -m "feat: add Customer/NewCustomerInput types and Sale.customerId"
```

---

### Task 3: `src/lib/customers.ts`

**Files:**
- Create: `src/lib/customers.ts`

**Interfaces:**
- Consumes: `Customer`, `NewCustomerInput` (Task 2), `supabase` client (`src/lib/supabase.ts`).
- Produces: `listCustomers`, `searchCustomers`, `getCustomer`, `createCustomer`, `updateCustomer`, `deleteCustomer`, `getCustomerStats` — consumed by Tasks 6, 7, 8, 9.

- [ ] **Step 1: Create the file**

```ts
import { supabase } from '@/lib/supabase';
import type { Customer, NewCustomerInput } from '@/types/models';

function mapCustomerRow(row: any): Customer {
  return {
    id: row.id,
    shopId: row.shop_id,
    firstName: row.first_name,
    lastName: row.last_name,
    email: row.email,
    phone: row.phone,
    street: row.street,
    city: row.city,
    neighborhood: row.neighborhood,
    tags: row.tags ?? [],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toRow(input: Partial<NewCustomerInput>) {
  return {
    ...(input.firstName !== undefined && { first_name: input.firstName }),
    ...(input.lastName !== undefined && { last_name: input.lastName }),
    ...(input.email !== undefined && { email: input.email }),
    ...(input.phone !== undefined && { phone: input.phone }),
    ...(input.street !== undefined && { street: input.street }),
    ...(input.city !== undefined && { city: input.city }),
    ...(input.neighborhood !== undefined && { neighborhood: input.neighborhood }),
    ...(input.tags !== undefined && { tags: input.tags }),
  };
}

export async function listCustomers(shopId: string): Promise<Customer[]> {
  const { data, error } = await supabase
    .from('customers')
    .select('*')
    .eq('shop_id', shopId)
    .order('first_name', { ascending: true })
    .order('last_name', { ascending: true });
  if (error) throw error;
  return (data ?? []).map(mapCustomerRow);
}

// Powers the POS checkout picker's type-ahead -- server-side so it works
// against the full customer list, not just whatever listCustomers already
// fetched into a screen's local state.
export async function searchCustomers(shopId: string, query: string): Promise<Customer[]> {
  const q = query.trim();
  if (!q) return [];
  const { data, error } = await supabase
    .from('customers')
    .select('*')
    .eq('shop_id', shopId)
    .or(`first_name.ilike.%${q}%,last_name.ilike.%${q}%,phone.ilike.%${q}%`)
    .order('first_name', { ascending: true })
    .limit(10);
  if (error) throw error;
  return (data ?? []).map(mapCustomerRow);
}

export async function getCustomer(id: string): Promise<Customer> {
  const { data, error } = await supabase.from('customers').select('*').eq('id', id).single();
  if (error) throw error;
  return mapCustomerRow(data);
}

export async function createCustomer(shopId: string, input: NewCustomerInput): Promise<Customer> {
  const { data, error } = await supabase
    .from('customers')
    .insert({ shop_id: shopId, ...toRow(input) })
    .select('*')
    .single();
  if (error) throw error;
  return mapCustomerRow(data);
}

export async function updateCustomer(id: string, patch: Partial<NewCustomerInput>): Promise<void> {
  const { error } = await supabase.from('customers').update(toRow(patch)).eq('id', id);
  if (error) throw error;
}

export async function deleteCustomer(id: string): Promise<void> {
  const { error } = await supabase.from('customers').delete().eq('id', id);
  if (error) throw error;
}

// Derived stats for the customer detail screen -- fetches this customer's
// sales and reduces client-side, same style as getMonthToDateRevenueCents
// in src/lib/sales.ts (no SQL aggregate/RPC for this in the codebase yet).
export async function getCustomerStats(customerId: string): Promise<{
  totalSpentCents: number;
  visitCount: number;
  lastPurchaseAt: string | null;
}> {
  const { data, error } = await supabase.from('sales').select('total_cents, created_at').eq('customer_id', customerId);
  if (error) throw error;
  const rows = data ?? [];
  return {
    totalSpentCents: rows.reduce((sum, row) => sum + row.total_cents, 0),
    visitCount: rows.length,
    lastPurchaseAt: rows.reduce<string | null>((latest, row) => (!latest || row.created_at > latest ? row.created_at : latest), null),
  };
}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: no new errors from this file.

- [ ] **Step 3: Commit**

```bash
git add src/lib/customers.ts
git commit -m "feat: add src/lib/customers.ts CRUD module"
```

---

### Task 4: `src/lib/sales.ts` — thread `customerId` through

**Files:**
- Modify: `src/lib/sales.ts:5` (`SaleCustomer` type), `src/lib/sales.ts:18-27` (`completeSale`'s `rpc` call), `src/lib/sales.ts:47-55` (`editSale`'s `rpc` call), `src/lib/sales.ts:88-90` (`mapSaleRow`)

**Interfaces:**
- Consumes: `Sale.customerId` (Task 2).
- Produces: `SaleCustomer.id`, `completeSale`/`editSale` now pass `p_customer_id`, `mapSaleRow` now returns `customerId` — consumed by Tasks 10, 11.

- [ ] **Step 1: Add `id` to `SaleCustomer`**

Replace line 5:
```ts
export type SaleCustomer = { name?: string | null; phone?: string | null; email?: string | null };
```
with:
```ts
export type SaleCustomer = { id?: string | null; name?: string | null; phone?: string | null; email?: string | null };
```

- [ ] **Step 2: Pass `p_customer_id` in `completeSale`'s `rpc` call**

In `completeSale` (lines 18-27), replace:
```ts
  const { data, error } = await supabase.rpc('complete_sale', {
    p_shop_id: shopId,
    p_items: buildSalePayload(lines, promotions),
    p_payments: buildPaymentPayload(payments),
    p_customer_name: customer?.name ?? null,
    p_customer_phone: customer?.phone ?? null,
    p_customer_email: customer?.email ?? null,
    p_cashier_name: cashierName ?? null,
    p_discount_cents: transactionDiscountCents,
  });
```
with:
```ts
  const { data, error } = await supabase.rpc('complete_sale', {
    p_shop_id: shopId,
    p_items: buildSalePayload(lines, promotions),
    p_payments: buildPaymentPayload(payments),
    p_customer_name: customer?.name ?? null,
    p_customer_phone: customer?.phone ?? null,
    p_customer_email: customer?.email ?? null,
    p_cashier_name: cashierName ?? null,
    p_discount_cents: transactionDiscountCents,
    p_customer_id: customer?.id ?? null,
  });
```

- [ ] **Step 3: Pass `p_customer_id` in `editSale`'s `rpc` call**

In `editSale` (lines 47-55), replace:
```ts
  const { error } = await supabase.rpc('edit_sale', {
    p_sale_id: saleId,
    p_items: items.map((item) => ({ product_id: item.productId, quantity: item.quantity, discount_cents: item.discountCents ?? 0 })),
    p_payments: buildPaymentPayload(payments),
    p_customer_name: customer?.name ?? null,
    p_customer_phone: customer?.phone ?? null,
    p_customer_email: customer?.email ?? null,
    p_discount_cents: transactionDiscountCents,
  });
```
with:
```ts
  const { error } = await supabase.rpc('edit_sale', {
    p_sale_id: saleId,
    p_items: items.map((item) => ({ product_id: item.productId, quantity: item.quantity, discount_cents: item.discountCents ?? 0 })),
    p_payments: buildPaymentPayload(payments),
    p_customer_name: customer?.name ?? null,
    p_customer_phone: customer?.phone ?? null,
    p_customer_email: customer?.email ?? null,
    p_discount_cents: transactionDiscountCents,
    p_customer_id: customer?.id ?? null,
  });
```

- [ ] **Step 4: Add `customerId` to `mapSaleRow`**

Replace:
```ts
    customerName: row.customer_name,
    customerPhone: row.customer_phone,
    customerEmail: row.customer_email,
    cashierName: row.cashier_name,
```
with:
```ts
    customerName: row.customer_name,
    customerPhone: row.customer_phone,
    customerEmail: row.customer_email,
    customerId: row.customer_id,
    cashierName: row.cashier_name,
```

- [ ] **Step 5: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors (this was the fix for the error Task 2 introduced).

- [ ] **Step 6: Commit**

```bash
git add src/lib/sales.ts
git commit -m "feat: thread customer_id through completeSale/editSale/mapSaleRow"
```

---

### Task 5: `customers` tab icon assets

**Files:**
- Create: `assets/images/tabIcons/customers.png`, `assets/images/tabIcons/customers@2x.png`, `assets/images/tabIcons/customers@3x.png`

**Interfaces:**
- Produces: three PNG files, consumed by Task 8 (`admin-tabs.tsx`, `admin-sidebar.tsx`).

- [ ] **Step 1: Generate the icons**

Existing icons (`home.png`, `cart.png`, etc.) are flat black silhouettes on a transparent background, at 24×24 (`@1x`), 48×48 (`@2x`), 72×72 (`@3x`). Generate a simple person-bust glyph at the same three sizes using Python's PIL (already installed in this environment — confirmed via `python3 -c "import PIL"`):

```bash
python3 - <<'EOF'
from PIL import Image, ImageDraw

def draw_customer_icon(size):
    img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    # Head: circle centered in the top third.
    head_r = size * 0.16
    cx = size / 2
    head_cy = size * 0.30
    d.ellipse([cx - head_r, head_cy - head_r, cx + head_r, head_cy + head_r], fill=(17, 17, 17, 255))
    # Shoulders: bottom half of a wide rounded rectangle, clipped to the
    # lower two-thirds so it reads as a bust, not a full oval.
    body_w = size * 0.62
    body_top = size * 0.52
    body_bottom = size * 0.92
    d.rounded_rectangle(
        [cx - body_w / 2, body_top, cx + body_w / 2, body_bottom + body_w / 2],
        radius=body_w / 2,
        fill=(17, 17, 17, 255),
    )
    # Re-clear anything below the visible frame that the rounded-rect's
    # bottom arc pushed past size (rounded_rectangle draws a full pill).
    d.rectangle([0, body_bottom, size, size], fill=(0, 0, 0, 0))
    return img

for suffix, size in [('', 24), ('@2x', 48), ('@3x', 72)]:
    draw_customer_icon(size).save(f'assets/images/tabIcons/customers{suffix}.png')
    print(f'wrote customers{suffix}.png at {size}x{size}')
EOF
```

- [ ] **Step 2: Verify dimensions match the existing icon set**

Run: `sips -g pixelWidth -g pixelHeight assets/images/tabIcons/customers.png assets/images/tabIcons/customers@2x.png assets/images/tabIcons/customers@3x.png`
Expected: `24x24`, `48x48`, `72x72` respectively (matching `home.png`'s dimensions exactly, confirmed earlier this session).

- [ ] **Step 3: Commit**

```bash
git add assets/images/tabIcons/customers.png assets/images/tabIcons/customers@2x.png assets/images/tabIcons/customers@3x.png
git commit -m "feat: add customers tab icon asset"
```

---

### Task 6: `src/components/customer-form.tsx`

**Files:**
- Create: `src/components/customer-form.tsx`

**Interfaces:**
- Consumes: `Customer`, `NewCustomerInput` (Task 2), `createCustomer`/`updateCustomer`/`deleteCustomer` are NOT called directly here — `onSubmit`/`onDelete` are passed in by the screen (Task 7), matching how `product-form.tsx` takes `onSubmit` rather than importing `createProduct` itself. `createTag`/`listTags` (existing, from `src/lib/tags.ts`).
- Produces: `CustomerForm` component — consumed by Task 7's `customer/new.tsx`/`customer/[id].tsx`.

- [ ] **Step 1: Create the file**

```tsx
import { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { CategoryChip } from '@/components/category-chip';
import { createTag, listTags } from '@/lib/tags';
import type { Customer, NewCustomerInput } from '@/types/models';

export function CustomerForm({
  initial,
  onSubmit,
  onDelete,
  submitLabel,
  shopId,
}: {
  initial?: Customer;
  onSubmit: (input: NewCustomerInput) => Promise<void>;
  onDelete?: () => Promise<void>;
  submitLabel: string;
  shopId: string;
}) {
  const [firstName, setFirstName] = useState(initial?.firstName ?? '');
  const [lastName, setLastName] = useState(initial?.lastName ?? '');
  const [email, setEmail] = useState(initial?.email ?? '');
  const [phone, setPhone] = useState(initial?.phone ?? '');
  const [street, setStreet] = useState(initial?.street ?? '');
  const [city, setCity] = useState(initial?.city ?? '');
  const [neighborhood, setNeighborhood] = useState(initial?.neighborhood ?? '');
  const [tags, setTags] = useState(initial?.tags?.join(', ') ?? '');
  const [tagSuggestions, setTagSuggestions] = useState<string[]>([]);
  const [tagColors, setTagColors] = useState<Map<string, string | null>>(new Map());
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  useEffect(() => {
    listTags(shopId)
      .then((rows) => { setTagSuggestions(rows.map((r) => r.name)); setTagColors(new Map(rows.map((r) => [r.name, r.color]))); })
      .catch(() => {});
  }, [shopId]);

  const valid = Boolean(firstName.trim());

  const submit = async () => {
    if (!valid) return;
    setSubmitting(true);
    setError(null);
    try {
      const tagList = tags.split(',').map((tag) => tag.trim()).filter(Boolean);
      // A tag typed here for the first time (via "+ Add …") only exists as
      // free text on this customer until it's also in the tags table --
      // persist it now, same as product-form.tsx does for its own tags.
      await Promise.all(tagList.filter((tag) => !tagSuggestions.includes(tag)).map((tag) => createTag(shopId, tag)));

      await onSubmit({
        firstName: firstName.trim(),
        lastName: lastName.trim() || null,
        email: email.trim() || null,
        phone: phone.trim() || null,
        street: street.trim() || null,
        city: city.trim() || null,
        neighborhood: neighborhood.trim() || null,
        tags: tagList,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save this customer.');
    } finally {
      setSubmitting(false);
    }
  };

  const confirmDelete = async () => {
    if (!onDelete) return;
    setDeleting(true);
    setError(null);
    try {
      await onDelete();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete this customer.');
      setDeleting(false);
      setConfirmingDelete(false);
    }
  };

  return (
    <ScrollView contentContainerStyle={styles.content}>
      <Field label="FIRST NAME *"><TextInput value={firstName} onChangeText={setFirstName} placeholder="e.g. Amina" placeholderTextColor="#999999" style={styles.input} /></Field>
      <Field label="LAST NAME"><TextInput value={lastName} onChangeText={setLastName} placeholder="Optional" placeholderTextColor="#999999" style={styles.input} /></Field>
      <Row>
        <Field label="PHONE" style={styles.half}><TextInput value={phone} onChangeText={setPhone} placeholder="Optional" placeholderTextColor="#999999" keyboardType="phone-pad" style={styles.input} /></Field>
        <Field label="EMAIL" style={styles.half}><TextInput value={email} onChangeText={setEmail} placeholder="Optional" placeholderTextColor="#999999" keyboardType="email-address" autoCapitalize="none" style={styles.input} /></Field>
      </Row>
      <Field label="STREET"><TextInput value={street} onChangeText={setStreet} placeholder="Optional" placeholderTextColor="#999999" style={styles.input} /></Field>
      <Row>
        <Field label="CITY" style={styles.half}><TextInput value={city} onChangeText={setCity} placeholder="Optional" placeholderTextColor="#999999" style={styles.input} /></Field>
        <Field label="NEIGHBORHOOD" style={styles.half}><TextInput value={neighborhood} onChangeText={setNeighborhood} placeholder="Optional" placeholderTextColor="#999999" style={styles.input} /></Field>
      </Row>
      <Field label="INTEREST TAGS">
        <TagsField
          value={tags}
          onChange={setTags}
          suggestions={tagSuggestions}
          colors={tagColors}
          onNewTag={(tag) => setTagSuggestions((prev) => [...prev, tag].sort((a, b) => a.localeCompare(b)))}
        />
      </Field>
      {error && <Text style={styles.error}>{error}</Text>}
      <Pressable onPress={submit} style={[styles.save, (!valid || submitting) && styles.saveDisabled]} disabled={!valid || submitting}>
        <Text style={styles.saveText}>{submitting ? 'Saving…' : submitLabel}</Text>
      </Pressable>
      {onDelete && (
        confirmingDelete ? (
          <View style={styles.confirmRow}>
            <Text style={styles.confirmText}>Delete this customer?</Text>
            <Pressable onPress={confirmDelete} disabled={deleting}><Text style={styles.confirmDanger}>{deleting ? 'Deleting…' : 'Confirm'}</Text></Pressable>
            <Pressable onPress={() => setConfirmingDelete(false)}><Text style={styles.confirmCancel}>Cancel</Text></Pressable>
          </View>
        ) : (
          <Pressable onPress={() => setConfirmingDelete(true)} style={styles.deleteButton}>
            <Text style={styles.deleteText}>Delete customer</Text>
          </Pressable>
        )
      )}
    </ScrollView>
  );
}

function Row({ children }: { children: React.ReactNode }) { return <View style={styles.row}>{children}</View>; }
function Field({ label, children, style }: { label: string; children: React.ReactNode; style?: object }) {
  return <View style={style}><Text style={styles.fieldLabel}>{label}</Text>{children}</View>;
}

// Same multi-select tag chip pattern as product-form.tsx's own TagsField --
// reimplemented locally rather than imported/shared, matching that file's
// own note that it isn't currently exported.
function TagsField({
  value,
  onChange,
  suggestions,
  colors,
  onNewTag,
}: {
  value: string;
  onChange: (value: string) => void;
  suggestions: string[];
  colors?: Map<string, string | null>;
  onNewTag?: (tag: string) => void;
}) {
  const [query, setQuery] = useState('');
  const selected = value.split(',').map((t) => t.trim()).filter(Boolean);
  const q = query.trim().toLowerCase();
  const filtered = q ? suggestions.filter((tag) => tag.toLowerCase().includes(q)) : suggestions;
  const exactMatch = suggestions.some((tag) => tag.toLowerCase() === q);

  const addTag = (tag: string) => {
    if (!tag || selected.includes(tag)) return;
    onChange([...selected, tag].join(', '));
    if (!suggestions.includes(tag)) onNewTag?.(tag);
    setQuery('');
  };
  const removeTag = (tag: string) => onChange(selected.filter((t) => t !== tag).join(', '));
  const toggleTag = (tag: string) => (selected.includes(tag) ? removeTag(tag) : addTag(tag));

  return (
    <>
      <TextInput value={value} onChangeText={onChange} placeholder="e.g. loyal, wholesale" placeholderTextColor="#999999" style={styles.input} />
      <TextInput value={query} onChangeText={setQuery} placeholder="Search tags…" placeholderTextColor="#999999" style={styles.input} />
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
        {filtered.map((tag) => (
          <CategoryChip key={tag} label={tag} color={colors?.get(tag)} active={selected.includes(tag)} onPress={() => toggleTag(tag)} />
        ))}
        {q.length > 0 && !exactMatch && (
          <CategoryChip label={`+ Add "${query.trim()}"`} active={false} onPress={() => addTag(query.trim())} />
        )}
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  content: { padding: 16, paddingBottom: 60 },
  row: { flexDirection: 'row', gap: 8 },
  half: { flex: 1 },
  fieldLabel: { fontSize: 10, letterSpacing: 1, fontWeight: '800', color: '#999999', marginBottom: 7, marginTop: 3 },
  input: { backgroundColor: '#F2F2F2', borderRadius: 9, paddingHorizontal: 11, height: 43, color: '#111111', marginBottom: 8 },
  chips: { gap: 7, paddingBottom: 12 },
  error: { color: '#C0392B', fontSize: 12, fontWeight: '700', marginBottom: 10 },
  save: { backgroundColor: '#111111', height: 45, borderRadius: 9, alignItems: 'center', justifyContent: 'center' },
  saveDisabled: { backgroundColor: '#CCCCCC' },
  saveText: { color: '#fff', fontWeight: '800' },
  deleteButton: { alignItems: 'center', paddingVertical: 16 },
  deleteText: { color: '#C0392B', fontWeight: '800', fontSize: 13 },
  confirmRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 16, paddingVertical: 16 },
  confirmText: { color: '#555555', fontSize: 13, fontWeight: '600' },
  confirmDanger: { color: '#C0392B', fontWeight: '800', fontSize: 13 },
  confirmCancel: { color: '#999999', fontWeight: '700', fontSize: 13 },
});
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors from this file.

- [ ] **Step 3: Commit**

```bash
git add src/components/customer-form.tsx
git commit -m "feat: add CustomerForm component"
```

---

### Task 7: `customer/new.tsx`, `customer/[id].tsx`, `_layout.tsx` wiring

**Files:**
- Create: `src/app/(admin)/customer/new.tsx`
- Create: `src/app/(admin)/customer/[id].tsx`
- Modify: `src/app/(admin)/_layout.tsx:39-45`

**Interfaces:**
- Consumes: `CustomerForm` (Task 6), `createCustomer`/`getCustomer`/`updateCustomer`/`deleteCustomer`/`getCustomerStats` (Task 3), `useAuth()` (existing, `src/hooks/use-auth.tsx`), `StatTile` (existing, `src/components/stat-tile.tsx`).
- Produces: routes `/customer/new` and `/customer/[id]` — consumed by Task 8's `customers.tsx` list screen (push navigation targets).

- [ ] **Step 1: Create `customer/new.tsx`, mirroring `product/new.tsx` exactly**

```tsx
import { useRouter } from 'expo-router';
import { StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { CustomerForm } from '@/components/customer-form';
import { ScreenHeader } from '@/components/screen-header';
import { useAuth } from '@/hooks/use-auth';
import { createCustomer } from '@/lib/customers';

export default function NewCustomerScreen() {
  const router = useRouter();
  const { shop } = useAuth();

  if (!shop) return null;

  return (
    <SafeAreaView edges={['left', 'right', 'bottom']} style={styles.safeArea}>
      <ScreenHeader title="Add customer" />
      <CustomerForm
        shopId={shop.id}
        submitLabel="Save customer"
        onSubmit={async (input) => {
          await createCustomer(shop.id, input);
          router.back();
        }}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({ safeArea: { flex: 1, backgroundColor: '#FFFFFF' } });
```

- [ ] **Step 2: Create `customer/[id].tsx`, mirroring `product/[id].tsx` plus a stats block**

```tsx
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { CustomerForm } from '@/components/customer-form';
import { ScreenHeader } from '@/components/screen-header';
import { StatTile } from '@/components/stat-tile';
import { formatCents } from '@/lib/currency';
import { deleteCustomer, getCustomer, getCustomerStats, updateCustomer } from '@/lib/customers';
import type { Customer } from '@/types/models';

export default function EditCustomerScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [stats, setStats] = useState<{ totalSpentCents: number; visitCount: number; lastPurchaseAt: string | null } | null>(null);

  useEffect(() => {
    if (!id) return;
    getCustomer(id).then(setCustomer);
    getCustomerStats(id).then(setStats);
  }, [id]);

  if (!customer) return null;

  return (
    <SafeAreaView edges={['left', 'right', 'bottom']} style={styles.safeArea}>
      <ScreenHeader title="Edit customer" />
      {stats && (
        <View style={styles.statsRow}>
          <StatTile value={formatCents(stats.totalSpentCents)} label="Total spent" />
          <StatTile value={String(stats.visitCount)} label="Visits" />
          <StatTile value={stats.lastPurchaseAt ? new Date(stats.lastPurchaseAt).toLocaleDateString() : '—'} label="Last purchase" />
        </View>
      )}
      <CustomerForm
        initial={customer}
        shopId={customer.shopId}
        submitLabel="Save changes"
        onSubmit={async (input) => {
          await updateCustomer(customer.id, input);
          router.back();
        }}
        onDelete={async () => {
          await deleteCustomer(customer.id);
          router.back();
        }}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: '#FFFFFF' },
  statsRow: { flexDirection: 'row', gap: 10, paddingHorizontal: 16, paddingTop: 14 },
});
```

- [ ] **Step 3: Register both screens in `(admin)/_layout.tsx`'s `Stack`**

Replace:
```tsx
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="(tabs)" />
      <Stack.Screen name="product/new" />
      <Stack.Screen name="product/[id]" />
      <Stack.Screen name="settings" />
      <Stack.Screen name="account" />
    </Stack>
```
with:
```tsx
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="(tabs)" />
      <Stack.Screen name="product/new" />
      <Stack.Screen name="product/[id]" />
      <Stack.Screen name="customer/new" />
      <Stack.Screen name="customer/[id]" />
      <Stack.Screen name="settings" />
      <Stack.Screen name="account" />
    </Stack>
```

- [ ] **Step 4: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors from these three files.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(admin)/customer/new.tsx" "src/app/(admin)/customer/[id].tsx" "src/app/(admin)/_layout.tsx"
git commit -m "feat: add customer/new and customer/[id] screens"
```

---

### Task 8: `customers.tsx` list screen + 5th-tab nav wiring

**Files:**
- Create: `src/app/(admin)/(tabs)/customers.tsx`
- Modify: `src/components/admin-tabs.tsx:141-148` (native `NativeTabs`, insert between `inventory` and `sales`)
- Modify: `src/components/admin-tabs.web.tsx:15-20` (mobile-web bottom nav `navItems`)
- Modify: `src/components/admin-sidebar.tsx:16-21` (tablet/web sidebar `navItems`)
- Modify: `src/app/(admin)/(tabs)/_layout.tsx:3` (comment: "4 admin tabs" → "5 admin tabs")

**Interfaces:**
- Consumes: `listCustomers` (Task 3), `customers.png`/`@2x`/`@3x` (Task 5), routes from Task 7.
- Produces: the `/customers` route and its nav entries — no later task depends on this one.

- [ ] **Step 1: Create `customers.tsx`, mirroring `inventory.tsx`'s search/list shape but with push navigation (per design spec) instead of a modal**

```tsx
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'expo-router';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Card } from '@/components/card';
import { useAuth } from '@/hooks/use-auth';
import { listCustomers } from '@/lib/customers';
import type { Customer } from '@/types/models';

export default function CustomersScreen() {
  const { shop } = useAuth();
  const router = useRouter();
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    if (!shop) return;
    setLoading(true);
    setCustomers(await listCustomers(shop.id));
    setLoading(false);
  }, [shop]);

  useEffect(() => { reload(); }, [reload]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return customers;
    return customers.filter((c) =>
      c.firstName.toLowerCase().includes(q) ||
      (c.lastName ?? '').toLowerCase().includes(q) ||
      (c.phone ?? '').toLowerCase().includes(q) ||
      c.tags.some((tag) => tag.toLowerCase().includes(q))
    );
  }, [customers, search]);

  return (
    <SafeAreaView edges={['left', 'right', 'bottom']} style={styles.safeArea}>
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <View style={styles.header}>
          <View>
            <Text style={styles.title}>Customers</Text>
            <Text style={styles.subtitle}>{customers.length} customers</Text>
          </View>
          <Pressable onPress={() => router.push('/customer/new')} style={styles.addButton}>
            <Text style={styles.addButtonText}>+ New</Text>
          </Pressable>
        </View>
        <TextInput value={search} onChangeText={setSearch} placeholder="Search by name, phone, or tag" placeholderTextColor="#999999" style={styles.search} />
        {loading ? (
          <Text style={styles.empty}>Loading…</Text>
        ) : filtered.length === 0 ? (
          <Text style={styles.empty}>No customers yet. Add your first one above.</Text>
        ) : (
          <Card style={styles.list}>
            {filtered.map((customer) => (
              <Pressable key={customer.id} onPress={() => router.push(`/customer/${customer.id}`)} style={styles.row}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.rowName}>{customer.firstName} {customer.lastName ?? ''}</Text>
                  {customer.phone && <Text style={styles.rowMeta}>{customer.phone}</Text>}
                </View>
                {customer.tags.length > 0 && (
                  <Text style={styles.rowTags} numberOfLines={1}>{customer.tags.slice(0, 3).join(', ')}</Text>
                )}
              </Pressable>
            ))}
          </Card>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: '#FFFFFF' },
  content: { padding: 24, paddingBottom: 42 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' },
  title: { color: '#111111', fontSize: 24, fontWeight: '800', letterSpacing: -0.5 },
  subtitle: { color: '#999999', fontSize: 12, marginTop: 3 },
  addButton: { backgroundColor: '#111111', borderRadius: 10, paddingHorizontal: 16, paddingVertical: 11 },
  addButtonText: { color: '#FFFFFF', fontWeight: '800', fontSize: 12 },
  search: { backgroundColor: '#F2F2F2', borderRadius: 10, height: 40, paddingHorizontal: 13, marginTop: 18, marginBottom: 18, color: '#111111' },
  list: { overflow: 'hidden' },
  empty: { color: '#999999', fontSize: 13, marginTop: 20, textAlign: 'center' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: '#F2F2F2' },
  rowName: { color: '#111111', fontSize: 14, fontWeight: '700' },
  rowMeta: { color: '#999999', fontSize: 12, marginTop: 2 },
  rowTags: { color: '#999999', fontSize: 11, maxWidth: 140 },
});
```

- [ ] **Step 2: Add the `customers` trigger to `admin-tabs.tsx`'s `NativeTabs`, between `inventory` and `sales`**

Replace:
```tsx
          <NativeTabs.Trigger name="inventory">
            <NativeTabs.Trigger.Label>Inventory</NativeTabs.Trigger.Label>
            <NativeTabs.Trigger.Icon src={require('@/assets/images/tabIcons/grid.png')} />
          </NativeTabs.Trigger>
          <NativeTabs.Trigger name="sales">
            <NativeTabs.Trigger.Label>Sales</NativeTabs.Trigger.Label>
            <NativeTabs.Trigger.Icon src={require('@/assets/images/tabIcons/chart.png')} />
          </NativeTabs.Trigger>
```
with:
```tsx
          <NativeTabs.Trigger name="inventory">
            <NativeTabs.Trigger.Label>Inventory</NativeTabs.Trigger.Label>
            <NativeTabs.Trigger.Icon src={require('@/assets/images/tabIcons/grid.png')} />
          </NativeTabs.Trigger>
          <NativeTabs.Trigger name="customers">
            <NativeTabs.Trigger.Label>Customers</NativeTabs.Trigger.Label>
            <NativeTabs.Trigger.Icon src={require('@/assets/images/tabIcons/customers.png')} />
          </NativeTabs.Trigger>
          <NativeTabs.Trigger name="sales">
            <NativeTabs.Trigger.Label>Sales</NativeTabs.Trigger.Label>
            <NativeTabs.Trigger.Icon src={require('@/assets/images/tabIcons/chart.png')} />
          </NativeTabs.Trigger>
```

- [ ] **Step 3: Add the `customers` entry to `admin-tabs.web.tsx`'s mobile-web `navItems`, between `inventory` and `sales`**

Replace:
```ts
const navItems = [
  { href: '/dashboard', label: 'Dashboard', icon: '🏠' },
  { href: '/pos', label: 'POS', icon: '🛒' },
  { href: '/inventory', label: 'Inventory', icon: '▦' },
  { href: '/sales', label: 'Sales', icon: '📈' },
] as const;
```
with:
```ts
const navItems = [
  { href: '/dashboard', label: 'Dashboard', icon: '🏠' },
  { href: '/pos', label: 'POS', icon: '🛒' },
  { href: '/inventory', label: 'Inventory', icon: '▦' },
  { href: '/customers', label: 'Customers', icon: '👥' },
  { href: '/sales', label: 'Sales', icon: '📈' },
] as const;
```

- [ ] **Step 4: Add the `customers` entry to `admin-sidebar.tsx`'s `navItems`, between `inventory` and `sales`**

Replace:
```ts
const navItems = [
  { href: '/dashboard', label: 'Dashboard', icon: require('@/assets/images/tabIcons/home.png') },
  { href: '/pos', label: 'POS', icon: require('@/assets/images/tabIcons/cart.png') },
  { href: '/inventory', label: 'Inventory', icon: require('@/assets/images/tabIcons/grid.png') },
  { href: '/sales', label: 'Sales', icon: require('@/assets/images/tabIcons/chart.png') },
] as const;
```
with:
```ts
const navItems = [
  { href: '/dashboard', label: 'Dashboard', icon: require('@/assets/images/tabIcons/home.png') },
  { href: '/pos', label: 'POS', icon: require('@/assets/images/tabIcons/cart.png') },
  { href: '/inventory', label: 'Inventory', icon: require('@/assets/images/tabIcons/grid.png') },
  { href: '/customers', label: 'Customers', icon: require('@/assets/images/tabIcons/customers.png') },
  { href: '/sales', label: 'Sales', icon: require('@/assets/images/tabIcons/chart.png') },
] as const;
```

- [ ] **Step 5: Update the stale "4 admin tabs" comment in `(tabs)/_layout.tsx`**

Replace:
```tsx
// The 4 admin tabs (dashboard/pos/inventory/sales) live in this nested
```
with:
```tsx
// The 5 admin tabs (dashboard/pos/inventory/customers/sales) live in this nested
```

- [ ] **Step 6: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add "src/app/(admin)/(tabs)/customers.tsx" src/components/admin-tabs.tsx src/components/admin-tabs.web.tsx src/components/admin-sidebar.tsx "src/app/(admin)/(tabs)/_layout.tsx"
git commit -m "feat: add Customers tab (list screen + nav wiring)"
```

---

### Task 9: `src/components/customer-picker.tsx` (shared search-or-quick-add)

**Files:**
- Create: `src/components/customer-picker.tsx`

**Interfaces:**
- Consumes: `searchCustomers`, `createCustomer` (Task 3).
- Produces: `CustomerPicker` component and `SelectedCustomer` type — consumed by Tasks 10 (`pos.tsx`) and 11 (`sales.tsx`).

- [ ] **Step 1: Create the file**

```tsx
import { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { createCustomer, searchCustomers } from '@/lib/customers';
import type { Customer } from '@/types/models';

export type SelectedCustomer = { id: string; name: string; phone: string | null; email: string | null };

function fullName(c: Customer): string {
  return [c.firstName, c.lastName].filter(Boolean).join(' ');
}

// Shared between pos.tsx (checkout) and sales.tsx (sale editing) -- both
// need identical search-existing-or-quick-add-new behavior, per the design
// spec's note that edit_sale's customer section "gets the same picker
// treatment ... already reuses much of the same customer-info UI as
// pos.tsx today".
export function CustomerPicker({
  shopId,
  selected,
  onSelect,
  onClear,
}: {
  shopId: string;
  selected: SelectedCustomer | null;
  onSelect: (customer: SelectedCustomer) => void;
  onClear: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Customer[]>([]);
  const [quickAdd, setQuickAdd] = useState(false);
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const runSearch = async (text: string) => {
    setQuery(text);
    if (!text.trim()) { setResults([]); return; }
    try {
      setResults(await searchCustomers(shopId, text));
    } catch {
      setResults([]);
    }
  };

  const pick = (customer: Customer) => {
    onSelect({ id: customer.id, name: fullName(customer), phone: customer.phone, email: customer.email });
    setOpen(false);
    setQuery('');
    setResults([]);
    setQuickAdd(false);
  };

  const submitQuickAdd = async () => {
    if (!firstName.trim()) return;
    setCreating(true);
    setError(null);
    try {
      const customer = await createCustomer(shopId, {
        firstName: firstName.trim(),
        lastName: lastName.trim() || null,
        phone: phone.trim() || null,
        email: email.trim() || null,
        street: null,
        city: null,
        neighborhood: null,
        tags: [],
      });
      pick(customer);
      setFirstName('');
      setLastName('');
      setPhone('');
      setEmail('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not add this customer.');
    } finally {
      setCreating(false);
    }
  };

  if (selected) {
    return (
      <View style={styles.selectedRow}>
        <Text style={styles.selectedText}>Customer: {selected.name}</Text>
        <Pressable onPress={onClear}><Text style={styles.clear}>Clear</Text></Pressable>
      </View>
    );
  }

  return (
    <View>
      <Pressable onPress={() => setOpen((v) => !v)} style={styles.toggle}>
        <Text style={styles.toggleText}>{open ? '▴' : '▾'} Add customer (optional)</Text>
      </Pressable>
      {open && (
        <View style={styles.panel}>
          <TextInput value={query} onChangeText={runSearch} placeholder="Search by name or phone…" placeholderTextColor="#9B9B9B" style={styles.input} />
          {results.map((customer) => (
            <Pressable key={customer.id} onPress={() => pick(customer)} style={styles.resultRow}>
              <Text style={styles.resultName}>{fullName(customer)}</Text>
              {customer.phone && <Text style={styles.resultMeta}>{customer.phone}</Text>}
            </Pressable>
          ))}
          {!quickAdd ? (
            <Pressable onPress={() => setQuickAdd(true)} style={styles.quickAddToggle}>
              <Text style={styles.quickAddToggleText}>+ New customer</Text>
            </Pressable>
          ) : (
            <View style={styles.quickAddForm}>
              <TextInput value={firstName} onChangeText={setFirstName} placeholder="First name" placeholderTextColor="#9B9B9B" style={styles.input} />
              <TextInput value={lastName} onChangeText={setLastName} placeholder="Last name" placeholderTextColor="#9B9B9B" style={styles.input} />
              <TextInput value={phone} onChangeText={setPhone} placeholder="Phone" placeholderTextColor="#9B9B9B" keyboardType="phone-pad" style={styles.input} />
              <TextInput value={email} onChangeText={setEmail} placeholder="Email" placeholderTextColor="#9B9B9B" keyboardType="email-address" autoCapitalize="none" style={styles.input} />
              {error && <Text style={styles.error}>{error}</Text>}
              <Pressable onPress={submitQuickAdd} disabled={!firstName.trim() || creating} style={[styles.quickAddSubmit, (!firstName.trim() || creating) && styles.quickAddSubmitDisabled]}>
                <Text style={styles.quickAddSubmitText}>{creating ? 'Adding…' : 'Add customer'}</Text>
              </Pressable>
            </View>
          )}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  toggle: { paddingVertical: 4, marginTop: 14 },
  toggleText: { fontSize: 12, fontWeight: '700', color: '#999999' },
  panel: { gap: 8, marginTop: 10 },
  input: { backgroundColor: '#F2F2F2', borderRadius: 10, height: 42, paddingHorizontal: 12, color: '#111111' },
  resultRow: { paddingVertical: 8, paddingHorizontal: 4, borderBottomWidth: 1, borderBottomColor: '#F2F2F2' },
  resultName: { color: '#111111', fontSize: 13, fontWeight: '700' },
  resultMeta: { color: '#999999', fontSize: 11, marginTop: 1 },
  quickAddToggle: { paddingVertical: 8 },
  quickAddToggleText: { color: '#111111', fontSize: 12, fontWeight: '700' },
  quickAddForm: { gap: 8, marginTop: 4 },
  quickAddSubmit: { backgroundColor: '#111111', height: 40, borderRadius: 9, alignItems: 'center', justifyContent: 'center' },
  quickAddSubmitDisabled: { backgroundColor: '#CCCCCC' },
  quickAddSubmitText: { color: '#FFFFFF', fontWeight: '800', fontSize: 12 },
  selectedRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 14 },
  selectedText: { fontSize: 12, fontWeight: '700', color: '#111111' },
  clear: { fontSize: 12, fontWeight: '700', color: '#999999' },
  error: { color: '#C0392B', fontSize: 11, fontWeight: '700' },
});
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors from this file.

- [ ] **Step 3: Commit**

```bash
git add src/components/customer-picker.tsx
git commit -m "feat: add shared CustomerPicker component"
```

---

### Task 10: Wire `CustomerPicker` into POS checkout (`pos.tsx`)

**Files:**
- Modify: `src/app/(admin)/(tabs)/pos.tsx:24` (import), `:51-54` (state), `:129-185` (`checkout`), `:364-375` (JSX section)

**Interfaces:**
- Consumes: `CustomerPicker`, `SelectedCustomer` (Task 9), `completeSale` now accepting `customer.id` (Task 4).

- [ ] **Step 1: Replace the three customer text-field states with one `selectedCustomer` state**

Replace (line 24):
```ts
import type { CartLine, Currency, Discount, PaymentLine, Product, Promotion } from '@/types/models';
```
with:
```ts
import { CustomerPicker, type SelectedCustomer } from '@/components/customer-picker';
import type { CartLine, Currency, Discount, PaymentLine, Product, Promotion } from '@/types/models';
```
(Note: alphabetical-import-order convention in this file already breaks at `cartTotalCents`/`listCategories` — just add this new import in a sensible spot near the other `@/components/*` imports at the top, lines 6-10.)

Replace (lines 51-54):
```ts
  const [customerOpen, setCustomerOpen] = useState(false);
  const [customerName, setCustomerName] = useState('');
  const [customerPhone, setCustomerPhone] = useState('');
  const [customerEmail, setCustomerEmail] = useState('');
```
with:
```ts
  const [selectedCustomer, setSelectedCustomer] = useState<SelectedCustomer | null>(null);
```

- [ ] **Step 2: Update `checkout()` to pass `selectedCustomer` and reset it after a sale**

Replace:
```ts
      await completeSale(
        shop.id,
        cart,
        payments,
        {
          name: customerName.trim() || null,
          phone: customerPhone.trim() || null,
          email: customerEmail.trim() || null,
        },
        cashierName,
        promotions,
        transactionDiscountCents
      );
```
with:
```ts
      await completeSale(
        shop.id,
        cart,
        payments,
        {
          id: selectedCustomer?.id ?? null,
          name: selectedCustomer?.name ?? null,
          phone: selectedCustomer?.phone ?? null,
          email: selectedCustomer?.email ?? null,
        },
        cashierName,
        promotions,
        transactionDiscountCents
      );
```

Replace (the receipt's `customer` field, a few lines below):
```ts
        customer: { name: customerName.trim() || null, phone: customerPhone.trim() || null, email: customerEmail.trim() || null },
```
with:
```ts
        customer: { name: selectedCustomer?.name ?? null, phone: selectedCustomer?.phone ?? null, email: selectedCustomer?.email ?? null },
```

Replace the post-sale reset:
```ts
      setCart([]);
      setPayments([]);
      setCustomerName('');
      setCustomerPhone('');
      setCustomerEmail('');
      setCustomerOpen(false);
```
with:
```ts
      setCart([]);
      setPayments([]);
      setSelectedCustomer(null);
```

- [ ] **Step 3: Replace the JSX customer section with `CustomerPicker`**

Replace:
```tsx
          <Pressable onPress={() => setCustomerOpen((v) => !v)} style={styles.customerToggle}>
            <Text style={styles.customerToggleText}>
              {customerOpen ? '▴' : '▾'} {customerName.trim() ? `Customer: ${customerName.trim()}` : 'Add customer info (optional)'}
            </Text>
          </Pressable>
          {customerOpen && (
            <View style={styles.customerFields}>
              <TextInput value={customerName} onChangeText={setCustomerName} placeholder="Name" placeholderTextColor="#9B9B9B" style={styles.customerInput} />
              <TextInput value={customerPhone} onChangeText={setCustomerPhone} placeholder="Phone" placeholderTextColor="#9B9B9B" keyboardType="phone-pad" style={styles.customerInput} />
              <TextInput value={customerEmail} onChangeText={setCustomerEmail} placeholder="Email" placeholderTextColor="#9B9B9B" keyboardType="email-address" autoCapitalize="none" style={styles.customerInput} />
            </View>
          )}
```
with:
```tsx
          {shop && (
            <CustomerPicker
              shopId={shop.id}
              selected={selectedCustomer}
              onSelect={setSelectedCustomer}
              onClear={() => setSelectedCustomer(null)}
            />
          )}
```

- [ ] **Step 4: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors. (`styles.customerToggle`/`customerToggleText`/`customerFields`/`customerInput` become unused but harmless — leaving unused `StyleSheet` entries doesn't error; removing them is optional cleanup, not required for correctness.)

- [ ] **Step 5: Manual verification**

Run the dev server (`npx expo start --web`), open POS, add an item to cart, expand "Add customer (optional)", search for a name with no matches, use "+ New customer" to quick-add one, complete the sale, and confirm the customer now appears in the Customers tab with `visitCount: 1` on its detail screen (stats come from Task 7's `getCustomerStats`, only correct once this wiring is in place).

- [ ] **Step 6: Commit**

```bash
git add "src/app/(admin)/(tabs)/pos.tsx"
git commit -m "feat: replace POS checkout's free-text customer fields with CustomerPicker"
```

---

### Task 11: Wire `CustomerPicker` into sale editing (`sales.tsx`)

**Files:**
- Modify: `src/app/(admin)/(tabs)/sales.tsx` imports, `:439-441` (state), `:471-487` (`save`), `:495-500` (JSX)

**Interfaces:**
- Consumes: `CustomerPicker`, `SelectedCustomer` (Task 9), `editSale` now accepting `customer.id` (Task 4), `sale.customerId`/`customerName`/`customerPhone`/`customerEmail` (Task 2/4).

- [ ] **Step 1: Import `CustomerPicker`**

Add near the top import block (alongside the other `@/components/*` imports):
```ts
import { CustomerPicker, type SelectedCustomer } from '@/components/customer-picker';
```

- [ ] **Step 2: Replace `SaleEditor`'s three customer text states with one `selectedCustomer` state, seeded from the sale**

Replace:
```ts
  const [customerName, setCustomerName] = useState(sale.customerName ?? '');
  const [customerPhone, setCustomerPhone] = useState(sale.customerPhone ?? '');
  const [customerEmail, setCustomerEmail] = useState(sale.customerEmail ?? '');
```
with:
```ts
  const [selectedCustomer, setSelectedCustomer] = useState<SelectedCustomer | null>(
    sale.customerId ? { id: sale.customerId, name: sale.customerName ?? '', phone: sale.customerPhone, email: sale.customerEmail } : null
  );
```

- [ ] **Step 3: Update `save()` to pass `selectedCustomer`**

Replace:
```ts
      await editSale(sale.id, items.map((i) => ({ productId: i.productId, quantity: i.quantity })), payments, {
        name: customerName.trim() || null,
        phone: customerPhone.trim() || null,
        email: customerEmail.trim() || null,
      });
```
with:
```ts
      await editSale(sale.id, items.map((i) => ({ productId: i.productId, quantity: i.quantity })), payments, {
        id: selectedCustomer?.id ?? null,
        name: selectedCustomer?.name ?? null,
        phone: selectedCustomer?.phone ?? null,
        email: selectedCustomer?.email ?? null,
      });
```

- [ ] **Step 4: Replace the JSX customer text fields with `CustomerPicker`**

`SaleEditor` needs `shopId` to pass through to `CustomerPicker` — it currently only receives `sale`/`products`/`shop`/`onCancel`/`onSaved` as props (line 420), and `shop: Shop | null` is already one of them, so use `shop.id` directly (guard for `shop` being non-null, matching the pattern the rest of this component already tolerates via `shop?.taxEnabled`).

Replace:
```tsx
      <Text style={styles.detailLabel}>CUSTOMER (OPTIONAL)</Text>
      <View style={styles.editCustomerRow}>
        <TextInput value={customerName} onChangeText={setCustomerName} placeholder="Name" placeholderTextColor="#999999" style={styles.editCustomerInput} />
        <TextInput value={customerPhone} onChangeText={setCustomerPhone} placeholder="Phone" placeholderTextColor="#999999" keyboardType="phone-pad" style={styles.editCustomerInput} />
      </View>
      <TextInput value={customerEmail} onChangeText={setCustomerEmail} placeholder="Email" placeholderTextColor="#999999" keyboardType="email-address" autoCapitalize="none" style={[styles.editCustomerInput, { flexGrow: 0, flexShrink: 0, marginBottom: 8 }]} />
```
with:
```tsx
      <Text style={styles.detailLabel}>CUSTOMER (OPTIONAL)</Text>
      {shop && (
        <CustomerPicker
          shopId={shop.id}
          selected={selectedCustomer}
          onSelect={setSelectedCustomer}
          onClear={() => setSelectedCustomer(null)}
        />
      )}
```

- [ ] **Step 5: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors. (`styles.editCustomerRow`/`editCustomerInput` become unused but harmless, same as Task 10's note.)

- [ ] **Step 6: Manual verification**

Run the dev server, go to Sales, expand a past sale, tap Edit, confirm the CUSTOMER section now shows the search/quick-add picker (pre-selected if that sale already had a `customerId`), attach a different customer, save, and confirm the sale's row now shows the new customer's name.

- [ ] **Step 7: Commit**

```bash
git add "src/app/(admin)/(tabs)/sales.tsx"
git commit -m "feat: replace sale-edit's free-text customer fields with CustomerPicker"
```

---

### Task 12: Full verification pass

**Files:** none (verification only).

- [ ] **Step 1: Full type-check**

Run: `npx tsc --noEmit`
Expected: no errors anywhere in the project.

- [ ] **Step 2: Lint**

Run: `npx expo lint`
Expected: no new errors (pre-existing warnings elsewhere in the repo, if any, are out of scope).

- [ ] **Step 3: Manual QA checklist (dev server, `npx expo start --web`)**

- [ ] Create, edit, and delete a customer from the Customers tab; confirm interest tags persist and a newly-typed tag shows up in Settings' tag list afterward.
- [ ] Rename and delete a tag from Settings; confirm it cascades into any customer currently tagged with it, not just products.
- [ ] Complete a POS sale by searching for and selecting an existing customer; confirm the sale's customer is set and the customer's detail screen stats (total spent, visits, last purchase) update accordingly.
- [ ] Complete a POS sale via "+ New customer" quick-add; confirm the customer now appears in the Customers tab.
- [ ] Complete a POS sale with no customer attached at all; confirm this still works exactly as it does today (this is the regression case — the old flow must still work with `customerId: null`).
- [ ] Confirm the 5th tab renders correctly on phone width (`NativeTabs`), tablet/web (`AdminSidebar`), and mobile-web (`admin-tabs.web.tsx`'s bottom nav) — three separate nav implementations were touched in Task 8.
- [ ] Log in as a non-owner staff member (cashier) and confirm they can also search/create customers from POS checkout — this is the scenario Task 1's `is_shop_member` correction (vs. the spec's stale `owns_shop`) exists for.

- [ ] **Step 4: Final commit if the QA pass caught anything to fix**

If any manual QA step above required a fix, commit it separately with a message describing what broke and why, following the same "one fix, one commit" discipline as every task above.
