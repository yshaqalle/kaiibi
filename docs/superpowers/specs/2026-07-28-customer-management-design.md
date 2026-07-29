# Customer management (CRM)

## Overview

Add a real customer directory to the admin app: a `customers` entity (name, email, phone,
address, interest tags) with its own tab, list, and create/edit screens — replacing today's
situation where a sale only ever carries free-text `customer_name`/`customer_phone`/
`customer_email` with no persistent record behind it. Sales can now optionally link to a
customer record, and POS checkout gets a search-or-quick-add picker instead of a bare
text-entry section.

## Goals

- Owner can create, list, search, edit, and delete customer records: first/last name,
  email, phone, address (street/city/neighborhood), and interest tags.
- Interest tags reuse the existing shop-wide `tags` table (same vocabulary, colors, and
  rename/delete cascade already used by products) rather than a separate tag system.
- Customers get a 5th tab in the admin shell (NativeTabs bottom bar + `AdminSidebar` on
  tablet/web), matching how Dashboard/POS/Inventory/Sales already work.
- POS checkout can attach an existing customer to a sale (search by name/phone) or quick-add
  a new one inline (first/last name, phone, email) without leaving the checkout flow.
  Ringing up with no customer attached at all remains possible, unchanged from today.
- A customer's detail screen shows derived stats computed from their linked sales: total
  spent, visit count, last purchase date.

## Non-goals

- Customer self-service accounts/login (the `profiles.role = 'customer'` auth role is a
  separate, unrelated concept — not touched by this work).
- State/country fields on the address — out of scope per user, easy to add later if the
  app ever expands beyond one local market (mirrors why `Shop` itself has no country field
  today).
- A separate tag vocabulary for customer interests — explicitly reusing `tags`.
- Backfilling `customer_id` on existing sales from their free-text `customer_name`/`phone`
  — no reliable match without user review; existing sales simply keep `customer_id = null`
  and their original snapshot fields.
- Merging/deduplicating customer records.
- Any customer-facing surface (this is an admin-only CRM, same access model as
  Inventory/Sales).

## Data model

New migration `0022_customers.sql`:

```sql
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

create policy "own customers" on public.customers for all
  using (owns_shop(shop_id)) with check (owns_shop(shop_id));

grant select, insert, update, delete on public.customers to authenticated;

alter table public.sales add column if not exists customer_id uuid references public.customers(id) on delete set null;
create index if not exists sales_customer_id_idx on public.sales(customer_id);
```

`customers.tags` is a plain `text[]`, the same denormalized-by-name approach `products.tags`
already uses (not an FK table) — so it needs the same rename/delete cascade. The same
migration extends the existing `rename_tag`/`delete_tag` RPCs (`create or replace`, from
`0004_categories_tags.sql`) to also touch `customers`:

```sql
create or replace function public.rename_tag(p_shop_id uuid, p_old_name text, p_new_name text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.owns_shop(p_shop_id) then
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
  if not public.owns_shop(p_shop_id) then
    raise exception 'not authorized for shop %', p_shop_id;
  end if;
  delete from public.tags where shop_id = p_shop_id and name = p_name;
  update public.products set tags = array_remove(tags, p_name), updated_at = now()
    where shop_id = p_shop_id and p_name = any(tags);
  update public.customers set tags = array_remove(tags, p_name), updated_at = now()
    where shop_id = p_shop_id and p_name = any(tags);
end;
$$;
```

`complete_sale`/`edit_sale` (currently in `0007_sale_customer.sql`, `create or replace`d
again here) each gain one new parameter, `p_customer_id uuid default null`, stored directly
on the `sales` row alongside the existing frozen `customer_name`/`phone`/`email` snapshot
params (unchanged — still a point-in-time copy, same rationale as `cashier_name`: editing a
customer's phone later must never rewrite a past receipt). `owns_shop` is not re-checked
against the customer (a customer row carries no owner-checkable ACL of its own beyond
`shop_id`); the RPC's existing `owns_shop(p_shop_id)` check already covers who may attach
customers from that shop, and `customer_id` values from another shop are simply orphaned
references with no read access under RLS.

`types/models.ts`:

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

`Sale` gains `customerId: string | null`.

## `src/lib/customers.ts` (new)

Mirrors `products.ts`/`tags.ts`:

- `mapCustomerRow(row): Customer`
- `listCustomers(shopId): Promise<Customer[]>` — ordered by `first_name, last_name`.
- `searchCustomers(shopId, query): Promise<Customer[]>` — `ilike` across
  `first_name`/`last_name`/`phone`, limited to ~10 results; powers the POS picker's
  type-ahead.
- `getCustomer(id): Promise<Customer>`
- `createCustomer(shopId, input: NewCustomerInput): Promise<Customer>`
- `updateCustomer(id, patch: Partial<NewCustomerInput>): Promise<void>`
- `deleteCustomer(id): Promise<void>`
- `getCustomerStats(customerId): Promise<{ totalSpentCents: number; visitCount: number;
  lastPurchaseAt: string | null }>` — aggregates `sales` where `customer_id` matches
  (`select total_cents, created_at`, summed/counted client-side, same style as
  `getMonthToDateRevenueCents`).

## `src/lib/sales.ts` changes

- `SaleCustomer` type (already `{ name?, phone?, email? }`) gains `id?: string | null`.
- `completeSale`/`editSale` pass `p_customer_id: customer?.id ?? null` through to the RPCs.
- `mapSaleRow` includes `customerId: row.customer_id`.

## Navigation: 5th "Customers" tab

- `src/app/(admin)/(tabs)/customers.tsx` — new tab screen.
- `AdminTabs` (`src/components/admin-tabs.tsx`): add a `NativeTabs.Trigger name="customers"`
  between Inventory and Sales (Dashboard → POS → Inventory → **Customers** → Sales), with a
  new icon.
- `AdminSidebar` (`src/components/admin-sidebar.tsx`): add the matching nav entry to the
  `navItems` array, same `{ href, label, icon }` shape as the other four.
- **New icon asset**: none of the existing `assets/images/tabIcons/*` (home/cart/grid/
  chart/explore) fit "customers" semantically — `explore` is reserved for the public-facing
  Discover tab. A new simple monochrome glyph (`customers.png` + `@2x`/`@3x`), matching the
  existing icons' style (flat black silhouette, transparent background), is added during
  implementation.
- `(admin)/_layout.tsx`'s wrapping `Stack` gets two new sibling screens: `customer/new` and
  `customer/[id]`, same as the existing `product/new`/`product/[id]` pair, so they push over
  the tab bar instead of being swallowed by it.

## Components

### `src/components/customer-form.tsx` (new)

Mirrors `product-form.tsx`'s structure and conventions:

- Fields: First name (required), Last name, Email, Phone, Street, City, Neighborhood.
- Interest tags: same `TagsField` pattern already inlined in `product-form.tsx` (search
  existing tags, multi-select chips, "+ Add "…"" to create a new tag on the fly via
  `createTag`) — reimplemented locally in this file rather than importing from
  `product-form.tsx`, consistent with how that component isn't currently exported/shared.
- Save calls `createCustomer`/`updateCustomer`; any newly-typed tags not already in
  `tags` are persisted via `createTag` first, same as the product form does.
- Delete (edit mode only): inline confirm-then-delete, calls `deleteCustomer`.

### `(admin)/customer/new.tsx` / `(admin)/customer/[id].tsx` (new)

Thin screens wrapping `CustomerForm`, mirroring `product/new.tsx` / `product/[id].tsx`
exactly (a `ScreenHeader` with Back, the form body). The edit screen additionally renders a
small stats block above the form (Total spent / Visits / Last purchase), fetched via
`getCustomerStats`.

### `(admin)/(tabs)/customers.tsx` (new)

List screen: a search input (client-side filter over `listCustomers`'s result, same
debounce-free pattern as Inventory's product search), rows showing name, phone, and up to a
few tag chips, a "+ New" button pushing `/customer/new`. Tapping a row pushes
`/customer/[id]`.

## POS checkout integration (`src/app/(admin)/(tabs)/pos.tsx`)

The existing collapsible "Add customer info (optional)" section (currently three bare
`TextInput`s for name/phone/email, `pos.tsx:364-373`) is replaced with a customer picker:

- A search field that calls `searchCustomers` as the cashier types (same debounce-free,
  fire-on-change style already used elsewhere in this codebase) and shows matching results
  in a dropdown below it.
- Selecting a result sets `customerName`/`customerPhone`/`customerEmail` (still used to
  build the frozen snapshot passed to `completeSale`) from the record and stores its `id`
  as `selectedCustomerId`.
- A "+ New customer" row at the bottom of the dropdown (always visible, or when there are no
  matches) opens a small inline quick-add form — first/last name, phone, email only (no
  address/tags at checkout, to keep the flow fast; those are filled in later from the
  Customers tab) — that calls `createCustomer` then selects the new record the same way a
  search result would.
- A "Clear" affordance removes the selection and reverts to the current behavior: free-text
  name/phone/email with no `customerId`, or nothing at all. This preserves today's
  no-customer walk-in path unchanged.
- `completeSale(shopId, lines, payments, { id: selectedCustomerId, name: ..., phone: ...,
  email: ... }, ...)` — `id` is the only new field threaded through.

`editSale`'s customer section in the sale-edit flow gets the same picker treatment for
consistency (it already reuses much of the same customer-info UI as `pos.tsx` today).

## Error handling

Same `runOrShowError`/inline-error-message pattern already used throughout Inventory and
Settings — no new error paths beyond what create/update/delete already handle elsewhere
(duplicate submissions, network failures, RLS rejections surfacing as a generic message).

## Testing

- `tsc --noEmit` and lint clean.
- Manual verification in the running dev server:
  - Create, edit, and delete a customer from the new Customers tab; confirm interest tags
    persist and a newly-typed tag shows up in Settings' tag list afterward.
  - Rename and delete a tag from Settings; confirm it cascades into any customer currently
    tagged with it, not just products.
  - Complete a POS sale by searching for and selecting an existing customer; confirm the
    sale's `customer_id` is set and the customer's detail screen stats (total spent, visits,
    last purchase) update accordingly.
  - Complete a POS sale via "+ New customer" quick-add; confirm the customer now appears in
    the Customers tab.
  - Complete a POS sale with no customer attached at all; confirm this still works exactly
    as it does today.
  - Confirm the 5th tab renders correctly on both the phone-width `NativeTabs` bar and the
    tablet/web `AdminSidebar`.

## Out of scope

- Customer self-service accounts/login.
- State/country address fields.
- A separate customer-interest tag vocabulary.
- Backfilling `customer_id` on pre-existing sales.
- Merging/deduplicating customer records.
