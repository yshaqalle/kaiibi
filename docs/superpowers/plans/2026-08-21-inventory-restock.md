# Inventory Restock Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Inventory a way to receive a delivery of products the shop already sells — by hand or by spreadsheet — and collapse the four stock jobs behind one header button called **Stock**.

**Architecture:** Mirrors the existing Move-stock feature at every layer. A new `receive_stock()` `security definer` RPC adds units and writes a `stock_receipts` record in one transaction (exactly as `transfer_stock()` does for movements). A new pure module `src/lib/restock-import.ts` turns a parsed CSV plus current holdings into a plan, writing nothing — so every rule is testable without a database, the same split that made `stock-move-import.ts` correct. A new `StockRestockModal` has the same two tabs (`By hand` / `From a sheet`) as `StockTransferModal`, and both tabs end at the same commit. A new `StockActionsSheet` is the router that replaces the `Move stock` and `Import` header pills with one `Stock` pill.

**Tech Stack:** Expo SDK 57 (read the versioned docs at https://docs.expo.dev/versions/v57.0.0/ before writing any Expo-facing code), React Native, TypeScript, Supabase (Postgres + RLS + `security definer` RPCs), Jest + `react-test-renderer`, `psql` verify scripts under `supabase/tests/`.

## Global Constraints

- **Never hardcode a hex in a screen.** Every colour is a token from `src/constants/theme.ts`. New modal chrome copies the style objects already in `src/components/stock-transfer-modal.tsx`.
- **`products.stock` is an OUTPUT.** A direct write to it is silently replaced by the rollup (migration `20260810000000`). The only supported way to change a count is `product_location_stock`.
- **Restock must NOT be gated behind `multi_location`.** `stock_transfers` is gated on that module because moving stock requires two branches. A one-store shop on any plan must be able to receive a delivery. `stock_receipts` is gated on `'inventory'`.
- **Nothing writes before the commit button.** Both tabs build a plan first; `planRestock()` performs no I/O.
- **Restock only adds.** A negative or zero quantity is a rejection that names **Count** (`0` included: a row that changes nothing is a mistake, not a no-op).
- **Restock never creates a product.** An unmatched product is a rejection that names **Import products**.
- **Copy rule:** every rejection that is really a different job must name that job by its button label — `Import products`, `Move`, `Count` — verbatim.
- Run `npm test` (Jest) and `npm run lint` before every commit. Run `npm run test:db` for any task touching `supabase/`.

## Decisions locked in

Taken from the mockup's recommendations ([docs/design/inventory-restock-mockup.html](../../design/inventory-restock-mockup.html)). Each is isolated to one task so it can be reversed cheaply.

| Decision | Chosen | Where it lives |
|---|---|---|
| Unit cost | **Latest wins** — a filled cost overwrites `products.cost_cents`; blank leaves it alone; the preview names every change before commit | Task 1 (RPC), Task 3 (`costUpdates`) |
| Count | **Not in this plan.** The Stock door shows it disabled with "coming next" | Task 6 |
| Import products | **Inside the Stock door**, not beside `+ Add product` | Task 6 |
| Inventory purchase expense | **Unticked checkbox**, last task so it can be dropped without touching anything else | Task 8 |

## File Structure

**Create**
- `supabase/migrations/20260902000000_stock_receipts.sql` — `stock_receipts`, `stock_receipt_items`, `receive_stock()`, RLS, module gate.
- `supabase/tests/verify-stock-receipts.sql` — self-contained fixture proving the RPC's arithmetic, its cost rule, its refusals, and that it is *not* gated on `multi_location`.
- `src/lib/restock-import.ts` — pure. Sheet columns, `restockSheetRows()`, `planRestock()`, `receivedUnits()`, `costUpdates()`.
- `src/lib/__tests__/restock-import.test.ts` — every rule in `restock-import.ts`, through the real CSV helpers.
- `src/components/stock-restock-modal.tsx` — `StockRestockModal`, both tabs.
- `src/components/__tests__/stock-actions-sheet.test.tsx` — the router's rows and gating.
- `src/components/stock-actions-sheet.tsx` — `StockActionsSheet`, the Stock door.

**Modify**
- `src/types/models.ts` — add `StockReceipt`, `StockReceiptItem`.
- `src/lib/products.ts` — add `receiveStock()`.
- `src/lib/products-import.ts` — the "already exists" rejection names **Restock**.
- `src/lib/stock-move-import.ts` — the two rejections that are really other jobs name them.
- `src/lib/__tests__/stock-move-import.test.ts` — assert the new wording.
- `src/app/(admin)/(tabs)/inventory.tsx` — header pills, the More sheet, the staged-sheet chain, and wiring for the two new components.

---

### Task 1: The receipts tables and the `receive_stock()` RPC

**Files:**
- Create: `supabase/migrations/20260902000000_stock_receipts.sql`
- Create: `supabase/tests/verify-stock-receipts.sql`

**Interfaces:**
- Consumes: `public.has_shop_permission`, `public.enforce_shop_module`, `public.product_location_stock`, `public.shop_locations`, `public.products` — all existing.
- Produces: `public.receive_stock(p_shop_id uuid, p_location_id uuid, p_items jsonb, p_supplier_name text, p_reference text, p_note text) returns uuid`. Each element of `p_items` is `{"product_id": uuid, "quantity": int, "unit_cost_cents": int|null}`. Tables `public.stock_receipts(id, shop_id, location_id, supplier_name, reference, note, created_by, created_at)` and `public.stock_receipt_items(id, receipt_id, product_id, product_name, quantity, unit_cost_cents)`.

- [ ] **Step 1: Write the failing verify script**

Create `supabase/tests/verify-stock-receipts.sql`:

```sql
-- Receiving a delivery: what the count becomes, what the cost becomes, and
-- what the RPC refuses.
--
-- The three things asserted here cannot be checked in the TypeScript suite,
-- because all three are enforced by the database itself:
--
--   * the count is INCREMENTED, not replaced. A restock that overwrote would be
--     a Count, and the two are the whole reason the Stock door exists.
--   * a filled unit cost overwrites products.cost_cents and a blank one leaves
--     it alone -- the "latest wins" rule. Getting this backwards silently
--     rewrites the shop's stock-at-cost and gross profit.
--   * receiving is gated on the `inventory` module, NOT on `multi_location`.
--     stock_transfers IS gated on multi_location, and copying that trigger
--     across would lock every single-store shop out of receiving deliveries --
--     which is the most common shop on the platform.
--
-- Everything runs inside one DO block whose EXCEPTION clause rolls it all back.

\set ON_ERROR_STOP on

do $$
declare
  v_user_id     uuid := gen_random_uuid();
  v_shop_id     uuid;
  v_location_id uuid;
  v_other_shop  uuid;
  v_other_loc   uuid;
  v_serum       uuid;
  v_balm        uuid;
  v_receipt_id  uuid;
  v_stock       integer;
  v_cost        integer;
  v_rows        integer;
  v_raised      boolean;
begin
  insert into public.shops (owner_id, name) values (v_user_id, 'Restock Shop') returning id into v_shop_id;
  insert into public.shop_locations (shop_id, name, is_primary) values (v_shop_id, 'Main', true)
    returning id into v_location_id;

  insert into public.products (shop_id, name, price_cents, cost_cents, stock)
    values (v_shop_id, 'Torriden Balanceful Serum', 1200, 450, 11) returning id into v_serum;
  insert into public.products (shop_id, name, price_cents, cost_cents, stock)
    values (v_shop_id, 'Beauty of Joseon Relief Sun', 900, null, 0) returning id into v_balm;

  perform set_config('request.jwt.claims', json_build_object('sub', v_user_id)::text, true);
  perform set_config('role', 'authenticated', true);

  -- 1. The count is added to, and the receipt is recorded.
  v_receipt_id := public.receive_stock(
    v_shop_id, v_location_id,
    jsonb_build_array(
      jsonb_build_object('product_id', v_serum, 'quantity', 6, 'unit_cost_cents', 480),
      jsonb_build_object('product_id', v_balm,  'quantity', 12, 'unit_cost_cents', 210)
    ),
    'Torriden Wholesale', 'INV-8841', 'first delivery'
  );

  select stock into v_stock from public.product_location_stock
    where product_id = v_serum and location_id = v_location_id;
  if v_stock <> 17 then
    raise exception 'FAIL: expected 11 + 6 = 17 at the store, got %', v_stock;
  end if;

  select stock into v_stock from public.products where id = v_serum;
  if v_stock <> 17 then
    raise exception 'FAIL: the products rollup should be 17, got %', v_stock;
  end if;

  select count(*) into v_rows from public.stock_receipt_items where receipt_id = v_receipt_id;
  if v_rows <> 2 then
    raise exception 'FAIL: expected 2 receipt items, got %', v_rows;
  end if;

  -- 2. Latest cost wins, and only where a cost was given.
  select cost_cents into v_cost from public.products where id = v_serum;
  if v_cost <> 480 then
    raise exception 'FAIL: a filled unit cost should overwrite 450 with 480, got %', v_cost;
  end if;
  select cost_cents into v_cost from public.products where id = v_balm;
  if v_cost <> 210 then
    raise exception 'FAIL: an uncosted product should take the received cost, got %', v_cost;
  end if;

  perform public.receive_stock(
    v_shop_id, v_location_id,
    jsonb_build_array(jsonb_build_object('product_id', v_serum, 'quantity', 3, 'unit_cost_cents', null)),
    null, null, null
  );
  select cost_cents into v_cost from public.products where id = v_serum;
  if v_cost <> 480 then
    raise exception 'FAIL: a blank unit cost must leave the cost alone, got %', v_cost;
  end if;
  select stock into v_stock from public.product_location_stock
    where product_id = v_serum and location_id = v_location_id;
  if v_stock <> 20 then
    raise exception 'FAIL: a second receipt should take 17 to 20, got %', v_stock;
  end if;

  -- 3. Zero and negative quantities are refused, not silently skipped.
  v_raised := false;
  begin
    perform public.receive_stock(v_shop_id, v_location_id,
      jsonb_build_array(jsonb_build_object('product_id', v_serum, 'quantity', 0, 'unit_cost_cents', null)),
      null, null, null);
  exception when others then v_raised := true;
  end;
  if not v_raised then
    raise exception 'FAIL: receiving zero units should raise';
  end if;

  -- 4. A product from another shop cannot be received into this one.
  insert into public.shops (owner_id, name) values (gen_random_uuid(), 'Someone Else')
    returning id into v_other_shop;
  insert into public.shop_locations (shop_id, name, is_primary) values (v_other_shop, 'Theirs', true)
    returning id into v_other_loc;
  v_raised := false;
  begin
    perform public.receive_stock(v_shop_id, v_other_loc,
      jsonb_build_array(jsonb_build_object('product_id', v_serum, 'quantity', 1, 'unit_cost_cents', null)),
      null, null, null);
  exception when others then v_raised := true;
  end;
  if not v_raised then
    raise exception 'FAIL: receiving into another shop''s location should raise';
  end if;

  -- 5. Receiving is gated on `inventory`, never on `multi_location`. A
  --    single-store shop without the multi-location module must still receive.
  if exists (
    select 1 from pg_trigger t
      join pg_class c on c.oid = t.tgrelid
    where c.relname = 'stock_receipts'
      and pg_get_triggerdef(t.oid) ilike '%multi_location%'
  ) then
    raise exception 'FAIL: stock_receipts must not be gated on multi_location';
  end if;

  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims', null, true);
  raise notice 'ALL CHECKS PASSED';
  raise exception 'rollback fixture';
exception
  when others then
    perform set_config('role', 'postgres', true);
    perform set_config('request.jwt.claims', null, true);
    if sqlerrm = 'rollback fixture' then
      return;
    end if;
    raise;
end $$;
```

- [ ] **Step 2: Run it and verify it fails**

Run: `npx supabase start && npm run test:db -- --no-reset`
Expected: `verify-stock-receipts  FAIL` with `ERROR: function public.receive_stock(...) does not exist`.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/20260902000000_stock_receipts.sql`:

```sql
-- Receiving a delivery.
--
-- Inventory could create products, move them between stores, and correct one
-- count at a time. It could not do the most ordinary thing a shop does all
-- week: take in more of something it already sells. The three ways out were all
-- wrong -- retype every count by hand; re-import the catalogue and have every
-- row rejected as a duplicate; or re-import under tweaked names and end up
-- owning two of every product. That last one is the same double-counting
-- 20260810000000's transfer_stock() was built to stop, arriving by another door.
--
-- Modelled on transfer_stock() deliberately, down to the lock ordering, because
-- the two are the same shape: change counts and write a record, in one
-- transaction, through a security definer function with no write policy behind
-- it. The differences are stated where they occur.

create table public.stock_receipts (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  -- Restricted, not cascade, for the same reason stock_transfers restricts:
  -- deleting a location must not erase the history of stock that came through
  -- it. A branch is deactivated, never deleted, once it has traded.
  location_id uuid not null references public.shop_locations(id),
  -- Free text, not a vendors FK. A delivery is often logged by whoever opened
  -- the box, and requiring them to create a vendor record first is how a
  -- feature stops being used. Accounting's vendor list stays the place where
  -- a supplier becomes a first-class record.
  supplier_name text,
  -- The shop's own handle on the delivery: an invoice number, a waybill, a
  -- purchase order. Free text because every supplier numbers things differently.
  reference text,
  note text,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);
create index stock_receipts_shop_idx on public.stock_receipts(shop_id, created_at desc);
create index stock_receipts_location_idx on public.stock_receipts(location_id, created_at desc);

create table public.stock_receipt_items (
  id uuid primary key default gen_random_uuid(),
  receipt_id uuid not null references public.stock_receipts(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete cascade,
  -- Frozen at receipt time, exactly as stock_transfer_items and sale_items
  -- freeze it: a later rename must not restate what a past delivery contained.
  product_name text not null,
  quantity integer not null check (quantity > 0),
  -- What this delivery cost per unit, frozen. Distinct from products.cost_cents,
  -- which the RPC overwrites with this value: that column is "what it costs me
  -- now" and is rewritten by every priced delivery, while this one is "what
  -- this delivery cost" and is never rewritten. Without both, a shop that
  -- restocks at a new price loses any record of the old one.
  unit_cost_cents integer check (unit_cost_cents is null or unit_cost_cents >= 0)
);
create index stock_receipt_items_receipt_idx on public.stock_receipt_items(receipt_id);

alter table public.stock_receipts enable row level security;
alter table public.stock_receipt_items enable row level security;

create policy "read stock_receipts" on public.stock_receipts for select using (is_shop_member(shop_id));
create policy "read stock_receipt_items" on public.stock_receipt_items for select
  using (exists (select 1 from public.stock_receipts r where r.id = receipt_id and is_shop_member(r.shop_id)));

-- No insert/update/delete policy, on purpose and for the same reason as
-- stock_transfers: a receipt is only ever created through receive_stock()
-- below, which adds the units and writes the record in one transaction. A
-- direct insert would record a delivery whose stock never arrived.
grant select on public.stock_receipts, public.stock_receipt_items to authenticated;

-- Gated on `inventory`, NOT on `multi_location`.
--
-- This is the one place this feature deliberately diverges from the transfer it
-- is modelled on. stock_transfers is gated on multi_location because a movement
-- needs two branches to exist at all. Receiving needs one. Copying that trigger
-- across would lock every single-store shop out of the feature they need most,
-- which is most shops on the platform.
--
-- product_location_stock already carries the same inventory gate
-- (20260818000400), so the units cannot land without it either; this trigger
-- covers the receipt row itself and states the intent where someone adding a
-- new gate will read it.
create trigger stock_receipts_module before insert or update on public.stock_receipts
  for each row execute function public.enforce_shop_module('inventory');

-- Adds units to one store, records what arrived, and updates each product's
-- cost to what this delivery charged.
--
-- ## Why cost is written here rather than left to the caller
--
-- products.cost_cents is nullable, and isUncosted() in product-costing.ts is
-- careful that null is not zero -- a free sample really does cost nothing.
-- Passing unit_cost_cents null means "I did not say", and the column is left
-- exactly as it was. Passing a number means "this is what it costs me now", and
-- it wins. A delivery is the one moment the true cost is on the desk, and the
-- alternative -- a second round trip from the client -- could half-fail and
-- leave the units received at the old cost.
create or replace function public.receive_stock(
  p_shop_id uuid,
  p_location_id uuid,
  p_items jsonb,
  p_supplier_name text default null,
  p_reference text default null,
  p_note text default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_receipt_id uuid;
  v_item jsonb;
  v_product public.products%rowtype;
  v_qty integer;
  v_cost integer;
  v_received integer := 0;
begin
  if not public.has_shop_permission(p_shop_id, 'inventory.edit') then
    raise exception 'not authorized for shop %', p_shop_id;
  end if;
  if not exists (select 1 from public.shop_locations where id = p_location_id and shop_id = p_shop_id) then
    raise exception 'the receiving location must belong to shop %', p_shop_id;
  end if;
  if p_items is null or jsonb_array_length(p_items) = 0 then
    raise exception 'a receipt must include at least one item';
  end if;

  insert into public.stock_receipts (shop_id, location_id, supplier_name, reference, note, created_by)
    values (p_shop_id, p_location_id, nullif(p_supplier_name, ''), nullif(p_reference, ''), nullif(p_note, ''), auth.uid())
    returning id into v_receipt_id;

  -- Ordered by product id so two concurrent receipts touching the same products
  -- take their row locks in the same order and cannot deadlock -- the same
  -- reason transfer_stock and refund_sale_items order their loops.
  for v_item in select value from jsonb_array_elements(p_items) as t(value) order by (value->>'product_id') loop
    v_qty := (v_item->>'quantity')::integer;
    -- Zero is refused as well as negative. A line that changes nothing is a
    -- mistake in the sheet, not a no-op, and skipping it silently would report
    -- a delivery larger than the one that actually landed.
    if v_qty is null or v_qty <= 0 then
      raise exception 'invalid received quantity';
    end if;

    select * into v_product from public.products
      where id = (v_item->>'product_id')::uuid and shop_id = p_shop_id;
    if v_product.id is null then
      raise exception 'product % not found in this shop', v_item->>'product_id';
    end if;

    -- No availability check and no `for update` on the source: unlike a
    -- transfer, there is nothing to run out of. The upsert below takes the row
    -- lock it needs on the destination and nothing else.
    insert into public.product_location_stock (product_id, location_id, stock)
      values (v_product.id, p_location_id, v_qty)
      on conflict (product_id, location_id)
      do update set stock = public.product_location_stock.stock + excluded.stock, updated_at = now();

    v_cost := nullif(v_item->>'unit_cost_cents', '')::integer;
    if v_cost is not null then
      if v_cost < 0 then
        raise exception 'a unit cost cannot be negative';
      end if;
      -- Safe despite product_stock_is_derived_trigger, which rewrites `stock`
      -- on every products UPDATE: the rollup it computes is the one the upsert
      -- above just produced, so this statement leaves the count where it is.
      update public.products set cost_cents = v_cost, updated_at = now() where id = v_product.id;
    end if;

    insert into public.stock_receipt_items (receipt_id, product_id, product_name, quantity, unit_cost_cents)
      values (v_receipt_id, v_product.id, v_product.name, v_qty, v_cost);

    v_received := v_received + v_qty;
  end loop;

  if v_received = 0 then
    raise exception 'cannot record a receipt that receives nothing';
  end if;
  return v_receipt_id;
end;
$$;

grant execute on function public.receive_stock(uuid, uuid, jsonb, text, text, text) to authenticated;
```

- [ ] **Step 4: Run the database suite and verify it passes**

Run: `npm run test:db`
Expected: `verify-stock-receipts  pass`, and the run ends `N database checks passed.` with no FAIL. The full reset also proves the migration chain still applies from empty.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260902000000_stock_receipts.sql supabase/tests/verify-stock-receipts.sql
git commit -m "feat(inventory): receiving a delivery has a table and an RPC"
```

---

### Task 2: `receiveStock()` on the client

**Files:**
- Modify: `src/types/models.ts` (append after the `ProductLocationStock` type, around line 219)
- Modify: `src/lib/products.ts` (add after `transferStock`, around line 176)

**Interfaces:**
- Consumes: `public.receive_stock` from Task 1.
- Produces: `receiveStock(shopId: string, locationId: string, items: { productId: string; quantity: number; unitCostCents: number | null }[], options?: { supplierName?: string | null; reference?: string | null; note?: string | null }): Promise<string>` — returns the receipt id. Types `StockReceipt`, `StockReceiptItem`.

- [ ] **Step 1: Add the types**

In `src/types/models.ts`, directly after the `ProductLocationStock` type:

```ts
// A delivery that arrived at one store. Written only by the receive_stock RPC
// (migration 20260902000000) -- there is no write policy on the table, so a
// receipt always means units that actually landed.
export type StockReceipt = {
  id: string;
  shopId: string;
  locationId: string;
  // Free text, not a vendor FK: a delivery is usually logged by whoever opened
  // the box. Accounting's vendor list stays where a supplier becomes a record.
  supplierName: string | null;
  // The shop's handle on the delivery -- invoice number, waybill, PO.
  reference: string | null;
  note: string | null;
  createdBy: string | null;
  createdAt: string;
};

export type StockReceiptItem = {
  id: string;
  receiptId: string;
  productId: string;
  // Frozen at receipt time, like SaleItem's productName.
  productName: string;
  quantity: number;
  // What THIS delivery charged per unit. Distinct from Product.costCents, which
  // the RPC overwrites with this value: that one is "what it costs me now",
  // this one is the record of a particular delivery and is never rewritten.
  unitCostCents: number | null;
};
```

- [ ] **Step 2: Add the client function**

In `src/lib/products.ts`, directly after `transferStock`:

```ts
// Takes in a delivery: adds units to one store and records what arrived, in one
// transaction. The counterpart to transferStock -- that one relocates units and
// keeps the shop's total the same, this one increases it.
//
// `unitCostCents` null means "I didn't say", and leaves the product's cost
// exactly as it was. A number means "this is what it costs me now" and
// overwrites it, because a delivery is the one moment the true cost is at hand.
export async function receiveStock(
  shopId: string,
  locationId: string,
  items: { productId: string; quantity: number; unitCostCents: number | null }[],
  options?: { supplierName?: string | null; reference?: string | null; note?: string | null }
): Promise<string> {
  const { data, error } = await supabase.rpc('receive_stock', {
    p_shop_id: shopId,
    p_location_id: locationId,
    p_items: items.map((item) => ({
      product_id: item.productId,
      quantity: item.quantity,
      unit_cost_cents: item.unitCostCents,
    })),
    p_supplier_name: options?.supplierName ?? null,
    p_reference: options?.reference ?? null,
    p_note: options?.note ?? null,
  });
  if (error) throw error;
  return data as string;
}
```

- [ ] **Step 3: Verify it typechecks and the suite is still green**

Run: `npx tsc --noEmit && npm test`
Expected: no TypeScript errors; the existing Jest suite passes unchanged.

- [ ] **Step 4: Commit**

```bash
git add src/types/models.ts src/lib/products.ts
git commit -m "feat(inventory): receiveStock() calls the receipt RPC"
```

---

### Task 3: `restock-import.ts` — the pure plan

**Files:**
- Create: `src/lib/restock-import.ts`
- Test: `src/lib/__tests__/restock-import.test.ts`

**Interfaces:**
- Consumes: `normalizeBarcode` from `@/lib/barcode`; `CsvColumn`, `ParsedCsv` from `@/lib/csv`; `RejectedRow`, `TemplateColumn` from `@/lib/import-shared`; `Product`, `ShopLocation` from `@/types/models`.
- Produces:
  - `RESTOCK_TEMPLATE_COLUMNS: TemplateColumn[]`
  - `RESTOCK_SHEET_COLUMNS: CsvColumn<RestockSheetRow>[]`
  - `type RestockSheetRow = { product: Product; location: ShopLocation; stock: number }`
  - `restockSheetRows(products: Product[], locations: ShopLocation[], stockAt: (productId: string, locationId: string) => number): RestockSheetRow[]`
  - `type PlannedReceiptItem = { productId: string; productName: string; quantity: number; unitCostCents: number | null; previousCostCents: number | null }`
  - `type PlannedReceipt = { locationId: string; locationName: string; items: PlannedReceiptItem[]; supplierName: string | null; reference: string | null; note: string | null }`
  - `type OversizedReceipt = { productName: string; locationName: string; quantity: number; held: number }`
  - `type RestockPlan = { receipts: PlannedReceipt[]; rejected: RejectedRow[]; skipped: number; oversized: OversizedReceipt[] }`
  - `planRestock(parsed: ParsedCsv, context: { products: Product[]; locations: ShopLocation[]; stockAt: (productId: string, locationId: string) => number }): RestockPlan`
  - `receivedUnits(receipt: PlannedReceipt): number`
  - `costUpdates(plan: RestockPlan): PlannedReceiptItem[]`

- [ ] **Step 1: Write the failing test**

Create `src/lib/__tests__/restock-import.test.ts`:

```ts
// The restock sheet's rules, at the boundary a person actually meets them: a
// CSV generated the way the download button generates it, read back the way the
// picker reads it. Nothing here touches Supabase -- planRestock is pure, which
// is what makes every rule below cheap enough to state as its own case.

import { parseCsvText, rowsToCsv, type ParsedCsv } from '@/lib/csv';
import { missingRequiredColumns } from '@/lib/import-shared';
import {
  costUpdates,
  planRestock,
  receivedUnits,
  RESTOCK_SHEET_COLUMNS,
  RESTOCK_TEMPLATE_COLUMNS,
  restockSheetRows,
} from '@/lib/restock-import';
import type { Product, ShopLocation } from '@/types/models';

const MAIN = { id: 'loc-main', name: 'Jaalala Skincare', code: 'JL1', active: true } as ShopLocation;
const SECOND = { id: 'loc-2', name: 'Jaalala 2', code: 'JL2', active: true } as ShopLocation;
const CLOSED = { id: 'loc-closed', name: 'Jaalala Kiosk', code: 'JLK', active: false } as ShopLocation;
const LOCATIONS = [MAIN, SECOND, CLOSED];

const serum = {
  id: 'p-serum', name: 'Torriden Balanceful Serum', sku: 'TOR-BAL-50',
  barcode: '8809611860018', costCents: 450,
} as Product;
const centella = {
  id: 'p-centella', name: 'SKIN1004 Madagascar Centella', sku: 'SK1-MAD-100',
  barcode: null, costCents: null,
} as Product;
const PRODUCTS = [serum, centella];

const STOCK: Record<string, number> = {
  'p-serum|loc-main': 8,
  'p-centella|loc-main': 24,
  'p-serum|loc-2': 1,
};
const stockAt = (productId: string, locationId: string) => STOCK[`${productId}|${locationId}`] ?? 0;

const CONTEXT = { products: PRODUCTS, locations: LOCATIONS, stockAt };

function sheet(rows: Partial<Record<string, string>>[]): ParsedCsv {
  const full = rows.map((row) => ({
    Product: '',
    SKU: '',
    Barcode: '',
    Store: 'Jaalala Skincare',
    'Quantity now': '',
    'Quantity received': '',
    'Unit cost': '',
    Note: '',
    ...row,
  }));
  return parseCsvText(
    rowsToCsv(
      full,
      RESTOCK_TEMPLATE_COLUMNS.map((c) => ({ header: c.header, value: (r: Record<string, string>) => r[c.header] ?? '' }))
    )
  );
}

describe('the sheet the shop downloads', () => {
  it('clears the picker its own template has to pass', () => {
    const csv = parseCsvText(rowsToCsv([], RESTOCK_SHEET_COLUMNS));
    expect(missingRequiredColumns(RESTOCK_TEMPLATE_COLUMNS, csv.headers)).toEqual([]);
  });

  // The inverse of the move sheet, and deliberately so: you cannot move what
  // isn't there, but a product at zero is the MOST likely thing in the van.
  it('includes rows a store holds none of', () => {
    const rows = restockSheetRows(PRODUCTS, LOCATIONS, stockAt);
    expect(rows.map((r) => [r.product.name, r.location.name, r.stock])).toEqual([
      ['Torriden Balanceful Serum', 'Jaalala Skincare', 8],
      ['Torriden Balanceful Serum', 'Jaalala 2', 1],
      ['SKIN1004 Madagascar Centella', 'Jaalala Skincare', 24],
      ['SKIN1004 Madagascar Centella', 'Jaalala 2', 0],
    ]);
  });

  it('leaves out closed stores', () => {
    const rows = restockSheetRows(PRODUCTS, LOCATIONS, stockAt);
    expect(rows.some((r) => r.location.id === CLOSED.id)).toBe(false);
  });

  it('leaves the cells the shop fills in empty, and identifies the store by code', () => {
    const rows = restockSheetRows([serum], [MAIN], stockAt);
    const parsed = parseCsvText(rowsToCsv(rows, RESTOCK_SHEET_COLUMNS));
    expect(parsed.rows[0]).toMatchObject({
      Product: 'Torriden Balanceful Serum',
      Store: 'JL1',
      'Quantity now': '8',
      'Quantity received': '',
      'Unit cost': '',
    });
  });
});

describe('planning what arrived', () => {
  it('adds to what the store already holds, and groups by store', () => {
    const plan = planRestock(
      sheet([
        { Product: 'Torriden Balanceful Serum', 'Quantity received': '6' },
        { Product: 'SKIN1004 Madagascar Centella', 'Quantity received': '24' },
        { Product: 'Torriden Balanceful Serum', Store: 'JL2', 'Quantity received': '4' },
      ]),
      CONTEXT
    );
    expect(plan.rejected).toEqual([]);
    expect(plan.receipts).toHaveLength(2);
    expect(receivedUnits(plan.receipts[0])).toBe(30);
    expect(plan.receipts[0].locationName).toBe('Jaalala Skincare');
    expect(receivedUnits(plan.receipts[1])).toBe(4);
  });

  it('counts untouched rows as skipped rather than rejected', () => {
    const plan = planRestock(
      sheet([{ Product: 'Torriden Balanceful Serum', 'Quantity received': '6' }, {}, {}, {}]),
      CONTEXT
    );
    expect(plan.skipped).toBe(3);
    expect(plan.rejected).toEqual([]);
  });

  // A cost with no quantity is a half-finished row, not an untouched one.
  it('rejects a unit cost with nothing received', () => {
    const plan = planRestock(
      sheet([{ Product: 'Torriden Balanceful Serum', 'Unit cost': '4.80' }]),
      CONTEXT
    );
    expect(plan.rejected[0].reason).toMatch(/Unit cost is filled in but Quantity received is empty/);
  });

  it('names Import products when the row is a product the shop does not carry', () => {
    const plan = planRestock(sheet([{ Product: 'Anua Heartleaf Toner', 'Quantity received': '6' }]), CONTEXT);
    expect(plan.rejected[0].reason).toContain('Import products');
    expect(plan.rejected[0].row).toBe(2);
  });

  it('names Count when the sheet asks to take stock away', () => {
    const plan = planRestock(sheet([{ Product: 'Torriden Balanceful Serum', 'Quantity received': '-3' }]), CONTEXT);
    expect(plan.rejected[0].reason).toContain('Count');
  });

  it('rejects zero, which changes nothing and is always a mistake', () => {
    const plan = planRestock(sheet([{ Product: 'Torriden Balanceful Serum', 'Quantity received': '0' }]), CONTEXT);
    expect(plan.rejected).toHaveLength(1);
    expect(plan.skipped).toBe(0);
  });

  it('matches by SKU before name, so a tidied name still finds its product', () => {
    const plan = planRestock(
      sheet([{ Product: 'torriden balanceful serum (50ml)', SKU: 'TOR-BAL-50', 'Quantity received': '6' }]),
      CONTEXT
    );
    expect(plan.rejected).toEqual([]);
    expect(plan.receipts[0].items[0].productId).toBe('p-serum');
  });

  it('rejects two rows receiving the same product into the same store rather than summing them', () => {
    const plan = planRestock(
      sheet([
        { Product: 'Torriden Balanceful Serum', 'Quantity received': '6' },
        { Product: 'Torriden Balanceful Serum', 'Quantity received': '4' },
      ]),
      CONTEXT
    );
    expect(plan.receipts[0].items).toHaveLength(1);
    expect(plan.rejected[0].reason).toMatch(/Row 2 already receives/);
  });

  it('refuses a store it does not recognise, and names the ones it has', () => {
    const plan = planRestock(
      sheet([{ Product: 'Torriden Balanceful Serum', Store: 'Hargeisa', 'Quantity received': '6' }]),
      CONTEXT
    );
    expect(plan.rejected[0].reason).toContain('Jaalala Skincare, Jaalala 2');
  });
});

describe('cost', () => {
  it('reads dollars and reports only the products whose cost actually changes', () => {
    const plan = planRestock(
      sheet([
        { Product: 'Torriden Balanceful Serum', 'Quantity received': '6', 'Unit cost': '4.80' },
        { Product: 'SKIN1004 Madagascar Centella', 'Quantity received': '2', 'Unit cost': '3.00' },
      ]),
      CONTEXT
    );
    expect(plan.receipts[0].items[0].unitCostCents).toBe(480);
    expect(plan.receipts[0].items[0].previousCostCents).toBe(450);
    expect(costUpdates(plan).map((i) => i.productName)).toEqual([
      'Torriden Balanceful Serum',
      'SKIN1004 Madagascar Centella',
    ]);
  });

  it('leaves cost alone when the cell is blank', () => {
    const plan = planRestock(sheet([{ Product: 'Torriden Balanceful Serum', 'Quantity received': '6' }]), CONTEXT);
    expect(plan.receipts[0].items[0].unitCostCents).toBeNull();
    expect(costUpdates(plan)).toEqual([]);
  });

  // Restating the cost the app already holds is not a change, and listing it
  // would bury the ones that are.
  it('does not report a cost that matches what is already recorded', () => {
    const plan = planRestock(
      sheet([{ Product: 'Torriden Balanceful Serum', 'Quantity received': '6', 'Unit cost': '4.50' }]),
      CONTEXT
    );
    expect(costUpdates(plan)).toEqual([]);
  });
});

describe('a quantity that looks like a slip', () => {
  // Warned about, not rejected: sometimes the pallet really did arrive. The
  // move sheet's equivalent is a hard error because stock can run out; nothing
  // runs out when receiving, so the only honest signal is a warning.
  it('flags a receipt ten times what the store has ever held', () => {
    const plan = planRestock(sheet([{ Product: 'Torriden Balanceful Serum', 'Quantity received': '800' }]), CONTEXT);
    expect(plan.rejected).toEqual([]);
    expect(plan.oversized).toEqual([
      { productName: 'Torriden Balanceful Serum', locationName: 'Jaalala Skincare', quantity: 800, held: 8 },
    ]);
  });

  it('says nothing about the first delivery of something the store holds none of', () => {
    const plan = planRestock(
      sheet([{ Product: 'SKIN1004 Madagascar Centella', Store: 'JL2', 'Quantity received': '500' }]),
      CONTEXT
    );
    expect(plan.oversized).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `npx jest src/lib/__tests__/restock-import.test.ts`
Expected: FAIL — `Cannot find module '@/lib/restock-import'`.

- [ ] **Step 3: Write the module**

Create `src/lib/restock-import.ts`:

```ts
import { normalizeBarcode } from '@/lib/barcode';
import type { CsvColumn, ParsedCsv } from '@/lib/csv';
import type { RejectedRow, TemplateColumn } from '@/lib/import-shared';
import type { Product, ShopLocation } from '@/types/models';

// Taking in a delivery by spreadsheet.
//
// The fourth stock job, and the one that had no tool: Import creates products,
// Move relocates them, the inline stepper corrects one count. Nothing ADDED
// units to something the shop already sells, so shops improvised -- and the
// improvisations (re-importing a catalogue, or re-importing it under tweaked
// names) are exactly the double-counting stock-move-import.ts was written to
// stop, arriving through a different door.
//
// Pure, like its sibling: this turns a parsed sheet plus what the shop
// currently holds into a plan, and the caller commits that plan through
// receive_stock. Nothing here writes. That split is the point -- every rule
// below is testable without a database, and the commit stays a thin loop.

export const RESTOCK_TEMPLATE_COLUMNS: TemplateColumn[] = [
  { header: 'Product', required: true },
  { header: 'SKU', required: false },
  { header: 'Barcode', required: false },
  { header: 'Store', required: true },
  { header: 'Quantity now', required: false },
  { header: 'Quantity received', required: true },
  { header: 'Unit cost', required: false },
  { header: 'Note', required: false },
];

// One line per product per store, including stores holding NONE of it.
//
// The exact inverse of stockMoveSheetRows, and the difference is the whole
// distinction between the two jobs: you cannot move what isn't there, so the
// move sheet drops zero rows to stop them burying the movable ones. A product
// at zero is the most likely thing in the van, so dropping it here would hide
// precisely what the shop came to type.
export type RestockSheetRow = {
  product: Product;
  location: ShopLocation;
  stock: number;
};

export const RESTOCK_SHEET_COLUMNS: CsvColumn<RestockSheetRow>[] = [
  { header: 'Product', value: (r) => r.product.name },
  { header: 'SKU', value: (r) => r.product.sku ?? '' },
  { header: 'Barcode', value: (r) => r.product.barcode ?? '' },
  // The code when there is one, so a store rename cannot orphan a sheet
  // someone downloaded last week -- which is what `code` is for.
  { header: 'Store', value: (r) => r.location.code || r.location.name },
  { header: 'Quantity now', value: (r) => String(r.stock) },
  { header: 'Quantity received', value: () => '' },
  { header: 'Unit cost', value: () => '' },
  { header: 'Note', value: () => '' },
];

export function restockSheetRows(
  products: Product[],
  locations: ShopLocation[],
  stockAt: (productId: string, locationId: string) => number
): RestockSheetRow[] {
  const stores = locations.filter((location) => location.active);
  const rows: RestockSheetRow[] = [];
  for (const product of products) {
    for (const location of stores) {
      rows.push({ product, location, stock: stockAt(product.id, location.id) });
    }
  }
  return rows;
}

// --- Planning -------------------------------------------------------------

export type PlannedReceiptItem = {
  productId: string;
  productName: string;
  quantity: number;
  // null means the sheet did not say, and the product's cost stays as it is.
  unitCostCents: number | null;
  // What the app holds today, carried so the preview can say "4.50 → 4.80"
  // before anything is written. Overwriting a cost silently is how stock at
  // cost and gross profit change under a shop without it noticing.
  previousCostCents: number | null;
};

// One receive_stock call. Rows are grouped by store because that RPC receives
// into exactly one store per transaction -- and a shop reading its history
// should see one delivery per store, not two blurred into one.
export type PlannedReceipt = {
  locationId: string;
  locationName: string;
  items: PlannedReceiptItem[];
  supplierName: string | null;
  reference: string | null;
  note: string | null;
};

// A receipt far larger than the store has ever held. Reported, never rejected:
// this is the shape of a misplaced decimal or a case-vs-unit mix-up, and it is
// also the shape of a pallet that really did arrive.
export type OversizedReceipt = {
  productName: string;
  locationName: string;
  quantity: number;
  held: number;
};

export type RestockPlan = {
  receipts: PlannedReceipt[];
  rejected: RejectedRow[];
  // Rows with nothing filled in. Counted rather than rejected: the sheet is a
  // download of the whole catalogue, so most of it is MEANT to come back
  // untouched. Reporting 210 rejections for a file that did exactly what was
  // asked would bury the one row that is genuinely wrong.
  skipped: number;
  oversized: OversizedReceipt[];
};

// How much bigger than the store's current holding a receipt has to be before
// it is worth mentioning. Ten is high enough that ordinary restocking never
// trips it and low enough to catch a decimal slip.
const OVERSIZED_MULTIPLE = 10;

function parseWholeNumber(value: string | undefined): number | null {
  const text = value?.trim();
  if (!text) return null;
  const n = Number(text);
  return Number.isFinite(n) && Number.isInteger(n) ? n : null;
}

// Dollars in the sheet, cents in the database -- the same conversion products
// import does, so a shop never has to think in cents.
function parseDollarsToCents(value: string | undefined): number | null {
  const text = value?.trim();
  if (!text) return null;
  const n = Number(text.replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

function findLocation(locations: ShopLocation[], text: string): ShopLocation | undefined {
  const key = text.trim().toLowerCase();
  return locations.find((l) => l.name.trim().toLowerCase() === key || (l.code ?? '').trim().toLowerCase() === key);
}

// SKU first, then barcode, then name -- identical to the move sheet, and for
// the same reasons: the identifiers survive someone tidying a name in a
// spreadsheet, and a name is the only one of the three two products can share.
function findProduct(products: Product[], row: Record<string, string>): Product | 'none' | 'ambiguous' {
  const sku = row['SKU']?.trim().toLowerCase();
  if (sku) {
    const bySku = products.filter((p) => (p.sku ?? '').trim().toLowerCase() === sku);
    if (bySku.length === 1) return bySku[0];
    if (bySku.length > 1) return 'ambiguous';
  }

  const barcode = normalizeBarcode(row['Barcode'] ?? '').toLowerCase();
  if (barcode) {
    const byBarcode = products.filter((p) => normalizeBarcode(p.barcode ?? '').toLowerCase() === barcode);
    if (byBarcode.length === 1) return byBarcode[0];
    if (byBarcode.length > 1) return 'ambiguous';
  }

  const name = row['Product']?.trim().toLowerCase();
  if (!name) return 'none';
  const byName = products.filter((p) => p.name.trim().toLowerCase() === name);
  if (byName.length === 1) return byName[0];
  if (byName.length > 1) return 'ambiguous';
  return 'none';
}

export function planRestock(
  parsed: ParsedCsv,
  context: {
    products: Product[];
    locations: ShopLocation[];
    stockAt: (productId: string, locationId: string) => number;
  }
): RestockPlan {
  const stores = context.locations.filter((location) => location.active);
  const storeNames = stores.map((l) => l.name).join(', ');

  const rejected: RejectedRow[] = [];
  const byStore = new Map<string, PlannedReceipt>();
  // (product, store) -> the row that already claimed it. Two rows receiving the
  // same product into the same store are almost always a copy-paste slip, and
  // silently summing them would receive twice what the shop read on screen.
  const claimed = new Map<string, number>();
  const oversized: OversizedReceipt[] = [];
  let skipped = 0;

  parsed.rows.forEach((raw, i) => {
    const row = i + 2; // the header occupies row 1 of the uploaded file
    const reject = (reason: string) => rejected.push({ row, reason, data: raw });

    const quantityText = raw['Quantity received']?.trim() ?? '';
    const costText = raw['Unit cost']?.trim() ?? '';
    const noteText = raw['Note']?.trim() ?? '';
    if (!quantityText && !costText && !noteText) {
      skipped += 1;
      return;
    }
    if (!quantityText) {
      return reject(
        costText
          ? 'Unit cost is filled in but Quantity received is empty — say how many arrived.'
          : 'Note is filled in but Quantity received is empty — say how many arrived.'
      );
    }

    const product = findProduct(context.products, raw);
    if (product === 'none') {
      return reject(
        `No product matches "${raw['Product']?.trim() || raw['SKU']?.trim() || raw['Barcode']?.trim() || ''}" — check the spelling, or fill in the SKU column. If you don't sell it yet, use Import products, which creates it with its price and opening stock.`
      );
    }
    if (product === 'ambiguous') {
      return reject(`More than one product matches "${raw['Product']?.trim()}" — fill in the SKU column to say which.`);
    }

    const store = findLocation(stores, raw['Store'] ?? '');
    if (!store) {
      return reject(
        raw['Store']?.trim()
          ? `No active store called "${raw['Store'].trim()}". Your stores are ${storeNames}.`
          : 'Store is empty — say which store the delivery arrived at.'
      );
    }

    const quantity = parseWholeNumber(quantityText);
    if (quantity === null) {
      return reject('Quantity received must be a whole number — just the digits, with no units.');
    }
    if (quantity <= 0) {
      return reject(
        quantity < 0
          ? 'Restock only adds. To reduce a count, use Count.'
          : 'Quantity received is 0, which would change nothing. Leave the cell empty to skip the row, or use Count to set a total.'
      );
    }

    const claim = `${product.id}|${store.id}`;
    const earlier = claimed.get(claim);
    if (earlier !== undefined) {
      return reject(`Row ${earlier} already receives ${product.name} into ${store.name} — combine them into one row.`);
    }

    let unitCostCents: number | null = null;
    if (costText) {
      unitCostCents = parseDollarsToCents(costText);
      if (unitCostCents === null || unitCostCents < 0) {
        return reject('Unit cost must be an amount of money, like 4.80 — or leave it empty to keep the cost you have.');
      }
    }

    const held = context.stockAt(product.id, store.id);
    // Only where the store has held some before: the first delivery of
    // something a store carries none of has no baseline to be out of scale
    // with, and warning about it would fire on every genuinely new line.
    if (held > 0 && quantity >= held * OVERSIZED_MULTIPLE) {
      oversized.push({ productName: product.name, locationName: store.name, quantity, held });
    }

    claimed.set(claim, row);

    const receipt = byStore.get(store.id) ?? {
      locationId: store.id,
      locationName: store.name,
      items: [],
      supplierName: null,
      reference: null,
      note: null,
    };
    receipt.items.push({
      productId: product.id,
      productName: product.name,
      quantity,
      unitCostCents,
      previousCostCents: product.costCents,
    });
    // The first note given for a store stands for the whole receipt: one
    // stock_receipts row is written per store, so there is one note to write.
    // Later rows' notes are not lost silently -- they were never separable.
    if (!receipt.note && noteText) receipt.note = noteText;
    byStore.set(store.id, receipt);
  });

  return { receipts: [...byStore.values()], rejected, skipped, oversized };
}

export function receivedUnits(receipt: PlannedReceipt): number {
  return receipt.items.reduce((total, item) => total + item.quantity, 0);
}

// Every line whose cost the commit would actually change. Restating the cost
// the app already holds is not a change, and listing it would bury the ones
// that are -- which is what makes this list safe to show as a plain count.
export function costUpdates(plan: RestockPlan): PlannedReceiptItem[] {
  return plan.receipts.flatMap((receipt) =>
    receipt.items.filter((item) => item.unitCostCents !== null && item.unitCostCents !== item.previousCostCents)
  );
}
```

- [ ] **Step 4: Run the test and verify it passes**

Run: `npx jest src/lib/__tests__/restock-import.test.ts`
Expected: PASS — all suites green.

- [ ] **Step 5: Run the whole suite and the linter**

Run: `npm test && npm run lint`
Expected: no failures, no new lint warnings.

- [ ] **Step 6: Commit**

```bash
git add src/lib/restock-import.ts src/lib/__tests__/restock-import.test.ts
git commit -m "feat(inventory): plan a restock from a sheet, without writing anything"
```

---

### Task 4: `StockRestockModal` — the by-hand tab

**Files:**
- Create: `src/components/stock-restock-modal.tsx`

**Interfaces:**
- Consumes: `receiveStock` (Task 2); `listProducts` from `@/lib/products`; `AppModal`, `StoreDropdown`, `CategoryChip` components; `useAuth`; `extractErrorMessage` from `@/lib/checkout-errors`.
- Produces: `StockRestockModal({ visible, shopId, onClose, onDone }: { visible: boolean; shopId: string; onClose: () => void; onDone: () => Promise<void> })`.

- [ ] **Step 1: Read the component this one mirrors**

Read `src/components/stock-transfer-modal.tsx` end to end. Copy its `StyleSheet` block wholesale into the new file — the overlay, card, header, segment, label, body, row and footer styles are the house chrome for this kind of sheet, and a second hand-rolled set is how two sheets start looking different. Note which import path it uses for `extractErrorMessage` and use the same one.

- [ ] **Step 2: Write the component's by-hand half**

Create `src/components/stock-restock-modal.tsx`. Structure, in order — this mirrors `StockTransferModal` exactly except where commented:

```tsx
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { CategoryChip } from '@/components/category-chip';
import { StoreDropdown } from '@/components/store-dropdown';
import { AppModal } from '@/components/ui/app-modal';
import { useAuth } from '@/hooks/use-auth';
import { listCategories } from '@/lib/categories';
import { listProducts, receiveStock } from '@/lib/products';
import type { Product } from '@/types/models';

// Taking in a delivery, by hand or by spreadsheet.
//
// The sibling of StockTransferModal, and deliberately the same shape: a store
// picker, a search row, rows you type a quantity into, a running basket, one
// commit button, and the same two tabs. A shop that has moved stock once can
// receive a delivery without reading anything.
//
// Two differences, and both are load-bearing:
//
//  1. The picker offers the WHOLE catalogue, not just what this store holds.
//     Move can only offer what the source has, and rightly. Restock is the
//     opposite case -- the product being received is very often the one that
//     hit zero, and hiding zero-stock rows would hide exactly what arrived.
//  2. There is a unit cost column. products.cost_cents is nullable and
//     Inventory already carries a `wrong` caveat about the products missing
//     one, because they make stock-at-cost understate and gross profit
//     overstate. A delivery is the one moment the true cost is on the desk.

type Tab = 'hand' | 'sheet';
type Line = { product: Product; quantity: number; cost: string };
```

The by-hand state and behaviour:

```tsx
export function StockRestockModal({ visible, shopId, onClose, onDone }: {
  visible: boolean;
  shopId: string;
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const { locations, activeLocation } = useAuth();
  const selectable = useMemo(() => locations.filter((location) => location.active), [locations]);

  const [tab, setTab] = useState<Tab>('hand');
  const [locationId, setLocationId] = useState<string | null>(activeLocation?.id ?? selectable[0]?.id ?? null);
  const [supplier, setSupplier] = useState('');
  const [reference, setReference] = useState('');
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState<string | null>(null);
  const [categories, setCategories] = useState<string[]>([]);
  const [lines, setLines] = useState<Line[]>([]);
  const [catalogue, setCatalogue] = useState<Product[]>([]);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Scoped to the receiving store so each row can say what is already there --
  // "Has 3 here" is the number that decides whether 24 is right. Unlike Move,
  // rows at zero are KEPT: `listProducts` returns null for a product the store
  // does not carry, so the shop-wide list is fetched too and the two are merged.
  const load = useCallback(async () => {
    const [all, here] = await Promise.all([
      listProducts(shopId),
      locationId ? listProducts(shopId, locationId) : Promise.resolve([] as Product[]),
    ]);
    const hereById = new Map(here.map((p) => [p.id, p.stock]));
    return all.map((product) => ({ ...product, stock: hereById.get(product.id) ?? 0 }));
  }, [shopId, locationId]);

  useEffect(() => {
    if (!visible) return;
    let active = true;
    load()
      .then((rows) => { if (active) setCatalogue(rows); })
      .catch(() => {});
    return () => { active = false; };
  }, [visible, load]);
```

Categories load exactly as `StockTransferModal` does. `matches` filters `catalogue` (not a source-store list) by search over name/SKU/barcode plus the category chip, excludes products already in `lines`, and `.slice(0, 12)`.

`addLine`, `setQuantity`, `setCost`, `removeLine` operate on `lines`. `cost` is held as the typed **string** so a half-typed `4.` is not destroyed on re-render; it is converted only at submit.

The commit:

```tsx
  const totalUnits = lines.reduce((sum, line) => sum + line.quantity, 0);
  // Only when there is at least one line AND every one of them is priced.
  //
  // A part-priced delivery has no honest total, and showing the sum of the
  // priced half would be a smaller number presented as the whole thing. The
  // `lines.length > 0` guard is not redundant: `every` on an empty array is
  // true, so without it an empty basket reports a delivery worth 0.00 rather
  // than no delivery -- which is what Task 8's checkbox would then offer to
  // log as an expense.
  const deliveryCents = lines.length > 0 && lines.every((line) => line.cost.trim() !== '')
    ? lines.reduce((sum, line) => sum + Math.round(Number(line.cost) * 100) * line.quantity, 0)
    : null;
  const canSubmit = Boolean(locationId) && lines.length > 0 && lines.every((l) => l.quantity > 0) && !busy;

  const submit = async () => {
    if (!canSubmit || !locationId) return;
    setBusy(true);
    setError(null);
    try {
      await receiveStock(
        shopId,
        locationId,
        lines.map((line) => ({
          productId: line.product.id,
          quantity: line.quantity,
          unitCostCents: line.cost.trim() === '' ? null : Math.round(Number(line.cost) * 100),
        })),
        { supplierName: supplier.trim() || null, reference: reference.trim() || null, note: note.trim() || null }
      );
      await onDone();
      closeAndReset();
    } catch (err) {
      setError(extractErrorMessage(err));
      setBusy(false);
    }
  };
```

Render: `AppModal` → overlay → card → header (`Restock` + Close) → the `hand`/`sheet` segment → `ScrollView` body containing `RECEIVING INTO` (`StoreDropdown` with `allowAll={false} variant="field"`), `SUPPLIER & REFERENCE — optional` (two `TextInput`s), `ADD PRODUCTS` (search `TextInput` + category chips), the matches list, the basket rows with a `RECEIVED` `TextInput` (`keyboardType="number-pad"`) and a `UNIT COST` `TextInput` (`keyboardType="decimal-pad"`), and a footer showing `{totalUnits} units in` with the delivery value beneath and the `Receive {totalUnits} units` button.

Copy rules for this screen:
- A row whose product has `costCents === null` shows the hint `No cost recorded — add one here and stock at cost stops understating`.
- A row at or under its reorder level shows `below reorder level {n}`.
- The button reads `Receive {n} units` — never "Save" or "Submit".

- [ ] **Step 3: Typecheck and lint**

Run: `npx tsc --noEmit && npm run lint`
Expected: no errors.

- [ ] **Step 4: Verify in the running app**

Start the app and open Inventory. The modal is not yet reachable from the header (that is Task 6), so verify it by temporarily rendering `<StockRestockModal visible shopId={shop.id} onClose={() => {}} onDone={reload} />` at the foot of `inventory.tsx`, then removing that line before committing.

Check on **web and iOS**: a product the store holds none of appears in the results with "Has 0 here"; typing 6 and pressing `Receive 6 units` makes the row's count go up by 6 rather than being replaced; the modal closes and the list reloads.

- [ ] **Step 5: Commit**

```bash
git add src/components/stock-restock-modal.tsx
git commit -m "feat(inventory): receive a delivery by hand"
```

---

### Task 5: `StockRestockModal` — the sheet tab

**Files:**
- Modify: `src/components/stock-restock-modal.tsx`

**Interfaces:**
- Consumes: `planRestock`, `receivedUnits`, `costUpdates`, `RESTOCK_SHEET_COLUMNS`, `RESTOCK_TEMPLATE_COLUMNS`, `restockSheetRows`, and the types from Task 3; `rowsToCsv` from `@/lib/csv`; `shareCsv` from `@/lib/export-file`; `pickCsvFile` from `@/lib/pick-csv-file`; `downloadRejectedRowsCsv` from `@/lib/import-shared`.
- Produces: no new exports.

- [ ] **Step 1: Add the sheet-tab state and the three handlers**

Add to the component, mirroring `StockTransferModal`'s sheet tab:

```tsx
  const [sheetFile, setSheetFile] = useState<string | null>(null);
  const [sheetHeaders, setSheetHeaders] = useState<string[]>([]);
  const [plan, setPlan] = useState<RestockPlan | null>(null);
  const [sheetNotice, setSheetNotice] = useState<string | null>(null);

  // What every store holds, keyed `productId|locationId`. Both halves of the
  // sheet need it: the download states each count, and the preview compares
  // each received quantity against what the store already has.
  const loadStockByLocation = useCallback(async (): Promise<Map<string, number>> => {
    const stock = new Map<string, number>();
    await Promise.all(
      selectable.map(async (location) => {
        for (const product of await listProducts(shopId, location.id)) {
          stock.set(`${product.id}|${location.id}`, product.stock);
        }
      })
    );
    return stock;
  }, [shopId, selectable]);

  // Every product at every store, not just the one selected above -- the sheet
  // names its own Store on every row, so restricting it would quietly make it a
  // worse tool than the tab it sits in.
  //
  // Rows already in the basket come back pre-filled, so a shop that starts by
  // hand and realises it is a bigger job than it thought does not retype them.
  const downloadSheet = async () => {
    setBusy(true);
    setError(null);
    try {
      const stockByLocation = await loadStockByLocation();
      const rows = restockSheetRows(await listProducts(shopId), selectable, (productId, locId) =>
        stockByLocation.get(`${productId}|${locId}`) ?? 0
      );
      const columns = RESTOCK_SHEET_COLUMNS.map((column) =>
        column.header === 'Quantity received' || column.header === 'Unit cost'
          ? {
              header: column.header,
              value: (row: RestockSheetRow) => {
                // Only the row for the store the basket is receiving INTO --
                // the same product's row at another store was not what was
                // chosen, and pre-filling it would receive the delivery twice.
                const chosen = row.location.id === locationId
                  ? lines.find((l) => l.product.id === row.product.id)
                  : undefined;
                if (!chosen) return '';
                return column.header === 'Quantity received' ? String(chosen.quantity) : chosen.cost;
              },
            }
          : column
      );
      await shareCsv(rowsToCsv(rows, columns), 'restock-sheet.csv', 'Restock sheet');
    } catch (err) {
      setError(extractErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const uploadSheet = async () => {
    setError(null);
    setSheetNotice(null);
    const picked = await pickCsvFile(RESTOCK_TEMPLATE_COLUMNS);
    if (picked.status === 'cancelled') return;
    if (picked.status === 'error') {
      setError(picked.message);
      return;
    }
    const products = await listProducts(shopId);
    const stockByLocation = await loadStockByLocation();

    const next = planRestock(picked.parsed, {
      products,
      locations: selectable,
      stockAt: (productId, locId) => stockByLocation.get(`${productId}|${locId}`) ?? 0,
    });
    setSheetFile(picked.fileName);
    setSheetHeaders(picked.parsed.headers);
    setPlan(next);

    // A sheet that turns out to be one store is the same thing the by-hand tab
    // holds, so it lands there -- where a number can still be changed before
    // anything is received. More than one store has no single destination to
    // show, so it stays here as a summary.
    if (next.receipts.length === 1 && next.rejected.length === 0) {
      const receipt = next.receipts[0];
      const byId = new Map(products.map((p) => [p.id, p]));
      setLocationId(receipt.locationId);
      setLines(
        receipt.items.flatMap((item) =>
          byId.has(item.productId)
            ? [{
                product: byId.get(item.productId)!,
                quantity: item.quantity,
                cost: item.unitCostCents === null ? '' : (item.unitCostCents / 100).toFixed(2),
              }]
            : []
        )
      );
      if (receipt.note) setNote(receipt.note);
      setSheetNotice(`${picked.fileName} — ${receipt.items.length} product${receipt.items.length === 1 ? '' : 's'} ready. Change anything before receiving.`);
      setTab('hand');
    }
  };

  // One receive_stock call per store. A store that fails fails whole and is
  // named; the others still go through, because rolling back good work for a
  // problem the shop can fix by re-uploading one section helps nobody.
  const commitPlan = async () => {
    if (!plan || plan.receipts.length === 0) return;
    setBusy(true);
    setError(null);
    const failures: string[] = [];
    for (const receipt of plan.receipts) {
      try {
        await receiveStock(
          shopId,
          receipt.locationId,
          receipt.items.map((item) => ({
            productId: item.productId,
            quantity: item.quantity,
            unitCostCents: item.unitCostCents,
          })),
          { supplierName: supplier.trim() || null, reference: reference.trim() || null, note: receipt.note }
        );
      } catch (err) {
        failures.push(`${receipt.locationName}: ${extractErrorMessage(err)}`);
      }
    }
    await onDone();
    setBusy(false);
    if (failures.length > 0) {
      // The plan stays on screen: the stores that DID go through have already
      // received, so re-pressing must not repeat them. The shop reads which
      // store failed and fixes that section of the sheet.
      setError(`Some of the delivery did not go through.\n${failures.join('\n')}`);
      setPlan({ ...plan, receipts: [] });
      return;
    }
    closeAndReset();
  };

  const downloadRejected = async () => {
    if (!plan || plan.rejected.length === 0) return;
    await downloadRejectedRowsCsv(plan.rejected, sheetHeaders, 'restock-rejected.csv');
  };
```

- [ ] **Step 2: Render the sheet tab**

Under `tab === 'sheet'`, render in order:

1. A `Download the sheet` button and one line of explanation: `Every product at every store, with what each holds now. Fill in Quantity received — and Unit cost, if you have it.`
2. An `Upload a filled sheet` button.
3. When `plan` is set, the four summary pills, each rendered only when non-zero: `{n} receipt(s) · {units} units` (ok), `{skipped} rows left blank — skipped` (warn), `{rejected.length} rejected` (bad), `{costUpdates(plan).length} costs updated` (accent).
4. One block per receipt: the store name, `{items.length} products · {receivedUnits(receipt)} units`, and the item names with `+{quantity}`.
5. Each `plan.oversized` entry as a warning line: `{productName} at {locationName}: {quantity} arriving against {held} held. Check it isn't a decimal slip.`
6. The rejection table — row number, reason — plus a `Download the {n} rejected rows` button.
7. A footer: `{units} units in / across {n} store(s) · nothing has changed yet` and the `Receive {units} units` button calling `commitPlan`.

Reuse the pill and table styles already in `stock-transfer-modal.tsx`'s StyleSheet.

- [ ] **Step 3: Typecheck, lint, and run the suite**

Run: `npx tsc --noEmit && npm run lint && npm test`
Expected: no errors; suite green.

- [ ] **Step 4: Verify the round trip in the running app**

With the temporary render from Task 4 still in place: download the sheet, open it, fill `Quantity received` on two rows at one store and one row at another, add a `Unit cost` to one, upload it. Confirm the preview shows two receipts, the cost-update pill names one product, and after committing both stores' counts have gone **up** by the amounts filled. Remove the temporary render line.

- [ ] **Step 5: Commit**

```bash
git add src/components/stock-restock-modal.tsx
git commit -m "feat(inventory): receive a delivery from a spreadsheet"
```

---

### Task 6: The Stock door, and the header

**Files:**
- Create: `src/components/stock-actions-sheet.tsx`
- Test: `src/components/__tests__/stock-actions-sheet.test.tsx`
- Modify: `src/app/(admin)/(tabs)/inventory.tsx:472-520` (header actions), `:760-800` (the More sheet), and the state block at `:100-121`

**Interfaces:**
- Consumes: `AppModal`.
- Produces: `type StockAction = 'restock' | 'move' | 'import'` and

```tsx
export function StockActionsSheet({ visible, onClose, onPick, showMove, onDismissed }: {
  visible: boolean;
  onClose: () => void;
  onPick: (action: StockAction) => void;
  showMove: boolean;
  // Fires once this sheet is actually off the screen (iOS only). Forwarded
  // straight to AppModal's `onDismiss`, exactly as CsvImportModal does at
  // csv-import-modal.tsx:116 — this is the hook the staged handover to the
  // Restock modal hangs on, and without it the phone path opens nothing.
  onDismissed?: () => void;
})
```

- [ ] **Step 1: Write the failing test**

Create `src/components/__tests__/stock-actions-sheet.test.tsx`:

```tsx
import { create, type ReactTestRendererJSON } from 'react-test-renderer';

import { StockActionsSheet } from '@/components/stock-actions-sheet';

function textsIn(node: ReactTestRendererJSON | ReactTestRendererJSON[] | string | null): string[] {
  if (node == null) return [];
  if (typeof node === 'string') return [node];
  if (Array.isArray(node)) return node.flatMap(textsIn);
  return textsIn(node.children as ReactTestRendererJSON[] | null);
}

const render = (over: Partial<React.ComponentProps<typeof StockActionsSheet>> = {}) =>
  textsIn(
    create(
      <StockActionsSheet visible onClose={() => {}} onPick={() => {}} showMove {...over} />
    ).toJSON() as ReactTestRendererJSON
  );

describe('the Stock door', () => {
  // The hints are the entire reason this sheet exists: shops were reaching for
  // product import to add stock, which counts the same units twice. Naming the
  // arithmetic on the way in is cheaper than a rejection read afterwards.
  it('says what each door does to the number', () => {
    const texts = render().join(' ');
    expect(texts).toContain('11 becomes 17');
    expect(texts).toContain('11 becomes 8');
    expect(texts).toContain("Your total doesn't change");
    expect(texts).toContain('count the same units twice');
  });

  it('offers restock, count, move and import', () => {
    const texts = render();
    expect(texts).toEqual(expect.arrayContaining(['Restock', 'Count', 'Move', 'Import products']));
  });

  // A one-store shop has nowhere to move stock TO, so the row would be a dead
  // end -- the same reason the header's Move pill hides itself today.
  it('hides Move for a shop with one store', () => {
    expect(render({ showMove: false })).not.toContain('Move');
  });

  it('renders nothing when it is not visible', () => {
    expect(render({ visible: false })).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it and verify it fails**

Run: `npx jest src/components/__tests__/stock-actions-sheet.test.tsx`
Expected: FAIL — `Cannot find module '@/components/stock-actions-sheet'`.

- [ ] **Step 3: Write the component**

Create `src/components/stock-actions-sheet.tsx`. It is a `AppModal` sheet in the same style as Inventory's own More sheet (copy `sheetOverlay`, `sheet`, `sheetHead`, `sheetTitle`, `sheetRow`, `sheetRowLabel`, `sheetRowHint` from `inventory.tsx`'s StyleSheet).

```tsx
export type StockAction = 'restock' | 'move' | 'import';
```

Header: title `Stock`, a `Close` pill, and one line under it: `Change the numbers. To add something you don't sell yet, use + Add product.`

Four rows, in this order and with this copy verbatim:

| Label | Hint |
|---|---|
| `Restock` | `A delivery arrived. Adds units to what a store already holds — 11 becomes 17.` |
| `Count` | `A stock-take. Replaces the count with what you actually found — 11 becomes 8, and the app records the −3.` |
| `Move` | `Send units from one of your stores to another. Your total doesn't change.` |
| `Import products` | `Only for products you don't sell yet. Importing something you already carry would count the same units twice.` |

`Count` renders disabled with a trailing `Coming next` badge and no `onPress` — it is not in this plan, and a door that names the distinction is worth having before the room behind it is built. `Move` renders only when `showMove` is true.

The component includes this comment above the row list:

```tsx
      {/* The hints are the feature, not decoration. Shops were reaching for
          product import to add stock to a store they already stocked, which
          re-counts the same units -- the reason stock-move-import.ts exists.
          Naming the arithmetic at the door is cheaper than a rejection read
          afterwards, and it is the one place all four jobs sit side by side
          where the difference between them is visible at all. */}
```

- [ ] **Step 4: Run the test and verify it passes**

Run: `npx jest src/components/__tests__/stock-actions-sheet.test.tsx`
Expected: PASS.

- [ ] **Step 5: Wire the header**

In `src/app/(admin)/(tabs)/inventory.tsx`:

Add imports for `StockActionsSheet`, `type StockAction`, and `StockRestockModal`.

Add state next to the existing `showTransfer`:

```tsx
  const [showStockActions, setShowStockActions] = useState(false);
  const [showRestock, setShowRestock] = useState(false);
  // Two staged handovers, not one. On a phone the chain is More → Stock →
  // Restock, which is three sheets deep, and iOS silently drops the third --
  // the exact bug use-staged-sheet was written for. Each hop stages its own.
  const stockFromMore = useStagedSheet<true>();
  const actionFromStock = useStagedSheet<StockAction>();
```

Replace the two desktop pills `Move stock` and `Import` (`inventory.tsx:499-508`) with one:

```tsx
                {canEdit && (
                  <Pressable onPress={() => setShowStockActions(true)} style={[styles.pillButton, styles.pillButtonSolid]}>
                    <Text style={[styles.pillButtonText, styles.pillButtonTextSolid]}>Stock</Text>
                  </Pressable>
                )}
```

Update the comment above it — the old one explains why five pills are all solid; it should now say why four jobs became one pill:

```tsx
                {/* One pill, four jobs. Move stock and Import used to sit here
                    as peers of + Add product, which put three different verbs
                    in one uniform -- and is how a shop with a delivery to
                    receive ended up in Import, counting its units twice. The
                    sheet behind this button is what tells them apart. */}
```

In the More sheet (`inventory.tsx:778-791`), replace the `Move stock` and `Import products` rows with one:

```tsx
            {canEdit && (
              <Pressable onPress={() => { setShowMore(false); stockFromMore.open(true, compact); }} style={styles.sheetRow}>
                <Text style={styles.sheetRowLabel}>Stock</Text>
                <Text style={styles.sheetRowHint}>Restock, count, move, or import</Text>
              </Pressable>
            )}
```

Render the door and the restock modal near `StockTransferModal`:

```tsx
      <StockActionsSheet
        visible={(showStockActions || stockFromMore.value !== null) && !actionFromStock.presenterSuppressed}
        showMove={showLocationFilter}
        onClose={() => { setShowStockActions(false); stockFromMore.close(); }}
        onDismissed={actionFromStock.onPresenterDismissed}
        onPick={(action) => {
          setShowStockActions(false);
          stockFromMore.close();
          actionFromStock.open(action, compact);
        }}
      />
```

and an effect promoting a picked action to the right modal:

```tsx
  // Non-compact opens the modal directly; compact waits for the door to be
  // off the screen first, which is what useStagedSheet's `value` becoming
  // non-null means.
  useEffect(() => {
    const action = actionFromStock.value;
    if (action === null) return;
    if (action === 'restock') setShowRestock(true);
    if (action === 'move') setShowTransfer(true);
    if (action === 'import') setShowImportModal(true);
    actionFromStock.close();
  }, [actionFromStock]);
```

Add `StockRestockModal`:

```tsx
      {shop && (
        <StockRestockModal
          visible={showRestock}
          shopId={shop.id}
          onClose={() => setShowRestock(false)}
          onDone={reload}
        />
      )}
```

Finally, add `!showRestock && !showStockActions` to the wedge-scanner suppression conditions at `inventory.tsx:286-288` and `:889`, alongside the existing `!showTransfer` — a scanner firing into a background screen while a sheet is up is the bug those conditions exist for.

- [ ] **Step 6: Verify in the running app on web, iOS and Android**

Run the app. On a wide window: the header reads `All stores ▾ | Export ▾ | Stock | + Add product`; `Stock` opens the door; each of Restock / Move / Import opens its modal; `Count` is visibly disabled. On a phone-width window: `More` → `Stock` → `Restock` — **this is the path that breaks on iOS if the staging is wrong**, so check it on an actual iOS simulator, not only on web. The Restock modal must actually appear.

- [ ] **Step 7: Run everything and commit**

Run: `npm test && npm run lint && npx tsc --noEmit`

```bash
git add src/components/stock-actions-sheet.tsx src/components/__tests__/stock-actions-sheet.test.tsx "src/app/(admin)/(tabs)/inventory.tsx"
git commit -m "feat(inventory): four stock jobs behind one door called Stock"
```

---

### Task 7: Every rejection names the right door

**Files:**
- Modify: `src/lib/products-import.ts` (the duplicate-name/SKU/barcode rejections)
- Modify: `src/lib/stock-move-import.ts:192-196` and `:226-232`
- Modify: `src/app/(admin)/(tabs)/inventory.tsx:357-384` (the `importConfig`)
- Test: `src/lib/__tests__/stock-move-import.test.ts`

**Interfaces:** No new exports. Copy changes only, plus one new `elsewhere` target.

- [ ] **Step 1: Write the failing assertions**

In `src/lib/__tests__/stock-move-import.test.ts`, add to the planning describe block:

```ts
  // Four doors means four chances to walk through the wrong one, so a
  // rejection's job is not to say no -- it is to name the door that says yes.
  it('points a product it cannot find at Import products', () => {
    const plan = planStockMoves(sheet([{ Product: 'Anua Heartleaf Toner', 'To store': 'JL2', 'Quantity to move': '2' }]), CONTEXT);
    expect(plan.rejected[0].reason).toContain('Import products');
  });

  it('points an over-quantity row at Restock, which is what it usually is', () => {
    const plan = planStockMoves(
      sheet([{ Product: 'Torriden Balanceful Serum', 'To store': 'JL2', 'Quantity to move': '20' }]),
      CONTEXT
    );
    expect(plan.rejected[0].reason).toContain('Restock');
  });
```

- [ ] **Step 2: Run and verify they fail**

Run: `npx jest src/lib/__tests__/stock-move-import.test.ts`
Expected: two FAILs — the reasons do not yet mention the other doors.

- [ ] **Step 3: Update the three rejection sites**

In `src/lib/stock-move-import.ts`, the not-found rejection becomes:

```ts
      return reject(
        `No product matches "${raw['Product']?.trim() || raw['SKU']?.trim() || raw['Barcode']?.trim() || ''}" — check the spelling, or fill in the SKU column. If you don't sell it yet, use Import products.`
      );
```

and the over-quantity rejection becomes:

```ts
      return reject(
        available <= 0
          ? `${product.name} has none left at ${from.name} to move. If more has just arrived, that's a Restock, not a move.`
          : `Only ${available} at ${from.name} — the sheet asks for ${quantity}. If ${quantity} really did arrive, that's a Restock; if the shelf disagrees with the app, correct the count first.`
      );
```

In `src/lib/products-import.ts`, the existing-product rejections gain the handover — find each `already exists`-style reason and make it read:

```ts
`You already carry ${name}. Adding more units is a Restock — importing it again would count the same units twice.`
```

- [ ] **Step 4: Update the import modal's escape hatch**

In `src/app/(admin)/(tabs)/inventory.tsx`, the `importConfig`'s `purpose` and `elsewhere` currently point at Move stock. Point them at Restock, which is what a shop reaching for Import with an existing catalogue actually wants:

```tsx
        purpose: showLocationFilter
          ? `For adding products you don't sell yet. Stock on a new product starts at ${primaryLocationName}. Already sell it and more has arrived? That's a Restock — importing it again would count the same units twice. Want it at another store? That's a Move.`
          : `For adding products you don't sell yet. Already sell it and more has arrived? That's a Restock — importing it again would count the same units twice.`,
        elsewhere: { label: 'Restock instead', onPress: () => restockFromImport.open(true, true) },
```

Add `const restockFromImport = useStagedSheet<true>();` beside the existing `moveFromImport`, and mirror every place `moveFromImport` is used — the `visible` suppression on `CsvImportModal`, its `onDismissed`, and the `StockRestockModal`'s `visible` and close handler — so the handover works on iOS. The existing `moveFromImport` stays: Move is still the right answer for the multi-store case, and the `purpose` text above names both.

- [ ] **Step 5: Run the tests and verify they pass**

Run: `npm test && npm run lint && npx tsc --noEmit`
Expected: all green, including the two new assertions.

- [ ] **Step 6: Commit**

```bash
git add src/lib/stock-move-import.ts src/lib/products-import.ts src/lib/__tests__/stock-move-import.test.ts "src/app/(admin)/(tabs)/inventory.tsx"
git commit -m "fix(inventory): a rejection names the door that would have worked"
```

---

### Task 8: The optional inventory-purchase expense

**Files:**
- Modify: `src/components/stock-restock-modal.tsx`

**Interfaces:**
- Consumes: `createExpense` from `@/lib/expenses`; `NewExpenseInput` from `@/types/models`.
- Produces: no new exports.

This task is deliberately last and self-contained. Drop it and everything before it still ships.

- [ ] **Step 1: Add the checkbox**

In the by-hand footer and the sheet-tab footer, render — **only when `deliveryCents !== null`** — an unticked checkbox:

```tsx
      {/* Unticked, and only when every line is priced.
          Unticked because a shop that enters supplier invoices in Accounting
          separately would otherwise double-count its spending silently and
          forever. Opt-in is recoverable; opt-out is not.
          Only when fully priced because a part-priced delivery has no honest
          total, and logging the priced half as though it were the whole
          delivery is a wrong number presented as a right one. */}
      {deliveryCents !== null && (
        <Pressable onPress={() => setLogExpense((on) => !on)} style={styles.checkRow}>
          <View style={[styles.checkBox, logExpense && styles.checkBoxOn]} />
          <Text style={styles.checkLabel}>
            {`Also log ${formatCents(deliveryCents)} as an inventory purchase`}
          </Text>
        </Pressable>
      )}
```

with `const [logExpense, setLogExpense] = useState(false);`.

- [ ] **Step 2: Write one shared helper, and call it from both paths**

The two paths have different totals and different stores, so a single
`deliveryCents` cannot serve both: the by-hand basket is one store, and a
committed sheet plan can be several. Add one helper that takes what it needs:

```tsx
  // After the units, never before: an expense for a delivery that failed to
  // land is a number in the P&L with no stock behind it. A failure here is
  // reported but does NOT undo the receipt -- the units really did arrive, and
  // the shop can add the expense by hand. The reverse (rolling back received
  // stock because an expense failed) would lose the more important of the two.
  const logInventoryPurchase = async (locId: string, amountCents: number) => {
    try {
      await createExpense(shopId, {
        locationId: locId,
        occurredOn: new Date().toISOString().slice(0, 10),
        amountCents,
        category: 'inventory_purchase',
        vendorId: null,
        paymentMethod: 'cash',
        note: [supplier.trim(), reference.trim()].filter(Boolean).join(' · ') || null,
      } satisfies NewExpenseInput);
    } catch (err) {
      setError(`The stock was received, but the expense was not logged: ${extractErrorMessage(err)}`);
    }
  };
```

In `submit` (by hand), after the receipt succeeds and before `onDone()`:

```tsx
      if (logExpense && deliveryCents !== null && locationId) {
        await logInventoryPurchase(locationId, deliveryCents);
      }
```

In `commitPlan` (sheet), inside the per-receipt loop, immediately after that
receipt's `receiveStock` resolves — **not** after the loop:

```tsx
        // Per store, not one lump. Each store's delivery is its own expense
        // because each is its own receipt, and per-store reporting (migration
        // 20260816000000) would otherwise attribute the whole delivery to
        // whichever store happened to be first.
        if (logExpense) {
          const cents = receipt.items.reduce(
            (sum, item) => sum + (item.unitCostCents ?? 0) * item.quantity, 0
          );
          if (cents > 0) await logInventoryPurchase(receipt.locationId, cents);
        }
```

- [ ] **Step 3: Gate the checkbox on each tab's own total**

The by-hand footer shows the checkbox when `deliveryCents !== null`. The sheet
footer shows it when the plan is fully priced, which is its own question:

```tsx
  // Every line of every receipt priced. A plan where half the rows left Unit
  // cost blank has no honest total either, and the same rule has to hold on
  // both tabs or the checkbox means two different things.
  const planFullyPriced =
    plan !== null &&
    plan.receipts.length > 0 &&
    plan.receipts.every((r) => r.items.every((item) => item.unitCostCents !== null));
  const planCents = plan
    ? plan.receipts.reduce(
        (sum, r) => sum + r.items.reduce((s, item) => s + (item.unitCostCents ?? 0) * item.quantity, 0), 0
      )
    : 0;
```

Render the sheet-tab checkbox only when `planFullyPriced`, labelled
`Also log ${formatCents(planCents)} as an inventory purchase`.

- [ ] **Step 4: Verify in the running app**

Receive a delivery with a cost on every line and the box ticked. Open Accounting → Expenses and confirm one `Inventory restock` row for the delivery total, and that it appears under **Stock & owner draws — excluded from profit** rather than in operating expenses. Receive a second delivery with the box unticked and confirm no expense is written. Then upload a two-store sheet fully priced and confirm **two** expense rows, one per store, each for that store's own total.

- [ ] **Step 5: Run everything and commit**

Run: `npm test && npm run lint && npx tsc --noEmit`

```bash
git add src/components/stock-restock-modal.tsx
git commit -m "feat(inventory): a priced delivery can log itself as an inventory purchase"
```

---

### Task 9: Scanning inside the sheet — web only

**Files:**
- Modify: `src/components/stock-restock-modal.tsx`
- Modify: `src/components/stock-transfer-modal.tsx`
- Modify: `src/app/(admin)/(tabs)/inventory.tsx` (the `useBarcodeWedge` `enabled` condition at `:276-290`)
- Test: `src/lib/__tests__/restock-import.test.ts` is unaffected; add cases to a new `src/components/__tests__/scan-sink.test.ts`

**Interfaces:**
- Consumes: `useBarcodeWedge` from `@/hooks/use-barcode-wedge`; `stepFieldBurst`, `fieldBurstScan`, `initialFieldBurstState` from `@/lib/barcode-wedge`; `resolveBarcode`, `barcodeCandidates` from `@/lib/barcode`; `Platform` from `react-native`.
- Produces: no new exports from the modals.

**Why this task exists and why it is web-only.** Commit `f31d9aa` removed scanning from the Move sheet, and the reason it gives is specific: `HardwareKeyboardModule.startCapture` wraps `currentActivity.window`, and a React Native `Modal` on Android is a Dialog with a window of its own — so keys typed while a sheet is up never reach the wrapper, which neither reports them nor swallows them. Both observed failures follow from that one fact: no scan registered, and the trailing Enter pressed whatever had focus and closed the sheet.

React Native Web renders `Modal` as an ordinary DOM node **in the same document**. The web path already listens on `document` in the **capture** phase and calls `preventDefault()` + `stopPropagation()` on a terminator that completed a scan (`use-barcode-wedge.ts:129-175`). Neither failure is reachable there. **Do not lift this gate to native without changing the native module first** — that is the change the revert asks someone to make deliberately.

- [ ] **Step 1: Write the failing test for the field guard**

The hazard this test pins down: a barcode is all digits, so a scan fired while the cursor is in a quantity box would otherwise set the quantity to `8809611860018` — a wrong number that looks like a typed one.

Create `src/components/__tests__/scan-sink.test.ts`:

```ts
// A scan that lands in a quantity box must not become the quantity.
//
// The global document listener deliberately stands aside when focus is inside a
// field (use-barcode-wedge.ts:142) so the field can handle its own scan. Inside
// the Restock sheet that is not a nicety: every character of a barcode is a
// digit, so the failure is silent -- a quantity of 8809611860018 looks exactly
// like a number somebody typed.

import { DEFAULT_WEDGE_CONFIG, fieldBurstScan, initialFieldBurstState, stepFieldBurst } from '@/lib/barcode-wedge';

// A scanner's speed: every character inside maxInterKeyMs of the last.
function scanned(text: string, startAt = 1_000) {
  let state = initialFieldBurstState();
  let before = '';
  text.split('').forEach((char, i) => {
    const next = before + char;
    state = stepFieldBurst(state, before, next, startAt + i * 5);
    before = next;
  });
  return { state, at: startAt + text.length * 5, text: before };
}

// A person's speed: well outside maxInterKeyMs.
function typed(text: string, startAt = 1_000) {
  let state = initialFieldBurstState();
  let before = '';
  text.split('').forEach((char, i) => {
    const next = before + char;
    state = stepFieldBurst(state, before, next, startAt + i * 200);
    before = next;
  });
  return { state, at: startAt + text.length * 200, text: before };
}

describe('a quantity field as a scan sink', () => {
  it('recognises a barcode arriving at scanner speed', () => {
    const { state, at } = scanned('8809611860018');
    expect(fieldBurstScan(state, at, DEFAULT_WEDGE_CONFIG)).toBe('8809611860018');
  });

  // The whole point of the guard: a real quantity must survive it untouched.
  it('leaves a hand-typed quantity alone', () => {
    const { state, at } = typed('24');
    expect(fieldBurstScan(state, at, DEFAULT_WEDGE_CONFIG)).toBeNull();
  });

  it('leaves a hand-typed number alone even when it is barcode-length', () => {
    const { state, at } = typed('8809611860018');
    expect(fieldBurstScan(state, at, DEFAULT_WEDGE_CONFIG)).toBeNull();
  });
});
```

- [ ] **Step 2: Run it and verify it passes against the existing library**

Run: `npx jest src/components/__tests__/scan-sink.test.ts`
Expected: PASS. This one is green from the start — `stepFieldBurst`/`fieldBurstScan` already exist and already work. The test is here to pin the behaviour the next two steps depend on, so that a later change to the wedge constants fails here rather than in a shop's stock count.

- [ ] **Step 3: Add the three scan paths to the Restock modal**

All three are gated on `Platform.OS === 'web'`. Add near the top of the component:

```tsx
  // Web only, and this is a deliberate platform gate rather than an oversight.
  //
  // Scanning inside a sheet was built and reverted (f31d9aa): on Android a
  // React Native Modal is a Dialog with its own window, so HardwareKeyboard's
  // capture -- which wraps currentActivity.window -- never sees the keys, and
  // the scanner's trailing Enter pressed whatever had focus and closed the
  // sheet. On web a Modal is a plain DOM node in the same document, the wedge
  // listener is already attached there in the CAPTURE phase, and it already
  // swallows a terminator that completed a scan. Neither failure is reachable.
  //
  // Lifting this gate to native requires teaching the native module about the
  // Dialog's window first. Do not do it here.
  const canScanInSheet = Platform.OS === 'web';
```

**(a) Focus nowhere — the document listener.** Enable the global wedge for the sheet's own lifetime:

```tsx
  useBarcodeWedge({
    enabled: canScanInSheet && visible && scanner.hardware,
    onScan: (code) => void addByCode(code),
  });
```

**(b) Focus in the search field.** Run the field-burst machine on the search box, exactly as Inventory's search row does — `stepFieldBurst` in `onChangeText`, `fieldBurstScan` in `onSubmitEditing`. A detected burst adds the product and clears the box; a null means a person is typing and the field keeps its text.

**(c) Focus in a Received or Unit cost box.** The same machine, with the opposite handling — a detected burst is **discarded from the field** and routed to `addByCode`, so the box keeps whatever number a person had typed:

```tsx
  // Not "handle the scan too" -- REPLACE what the field would have done with it.
  // Every character of a barcode is a digit, so without this the box silently
  // takes the code as its value and a delivery of 6 units is recorded as a
  // delivery of 8,809,611,860,018.
  const onQuantityChange = (line: Line, next: string) => {
    burstRef.current = stepFieldBurst(burstRef.current, line.quantityText, next, Date.now());
    setQuantityText(line, next);
  };
  const onQuantitySubmit = (line: Line) => {
    const code = fieldBurstScan(burstRef.current, Date.now());
    burstRef.current = initialFieldBurstState();
    if (!code) return;
    setQuantityText(line, line.quantityBeforeBurst);
    void addByCode(code);
  };
```

`addByCode` resolves through `resolveBarcode`/`barcodeCandidates` the same way `handleScannedCode` does in `inventory.tsx`, then adds a line at quantity 1 (or increments an existing one) — scan, scan, scan through a box of the same item is the motion this is for.

**(d) The camera button.** Render the `Scan` pill and its `BarcodeScannerModal` only when `canScanInSheet && scanner.camera`. `BarcodeScannerModal` already works on web — only torch and haptics are native-gated (`barcode-scanner-modal.tsx:51,125-126`) — and a modal over a modal is fine in a browser.

- [ ] **Step 4: Stand Inventory's own wedge down while the sheet is open**

In `src/app/(admin)/(tabs)/inventory.tsx`, add the restock sheet to the `useBarcodeWedge` `enabled` condition alongside the transfer sheet, and extend the comment:

```tsx
    // The transfer and restock sheets are both excluded for the same reason:
    // each runs its own wedge to build its basket, and one scan must never be
    // read BOTH as a line in that basket and as an adjustment to the product
    // behind it. Written as the same conditions those sheets' `visible` uses --
    // they also open from a hand-over, when the plain flag alone is still false.
    enabled:
      scanner.hardware &&
      !showAddModal &&
      editingProduct === null &&
      !showImportModal &&
      !scannerOpen &&
      !showStockActions &&
      !(showTransfer || moveFromImport.value !== null) &&
      !(showRestock || restockFromImport.value !== null),
```

- [ ] **Step 5: Do the same for the Move sheet**

Apply steps 3(a)–(d) to `src/components/stock-transfer-modal.tsx`. This restores what `f31d9aa` removed, on the one platform where it works. Restore the search box's placeholder to `Search or scan a product` **only when `canScanInSheet`** — on native it must keep saying `Search a product`, because promising nothing it cannot do is the sentence that revert ended on.

- [ ] **Step 6: Verify on web, and verify it is absent on native**

On **web**, with a USB scanner (or `/testing-kaiibi`'s wedge simulation — type the code fast and press Enter):
- Scan with focus nowhere → the row is added, and the sheet does **not** close.
- Scan with the cursor in the search box → the row is added and the box clears.
- Scan with the cursor in a `Received` box → the row is added and the box still shows the number that was typed, **not** the barcode.
- Type `24` into a `Received` box by hand and press Enter → it stays `24`.

On **Android and iOS**: the `Scan` pill is absent, the placeholder reads `Search a product`, and a scanner's Enter with the sheet open leaves the sheet alone. Verify on a real Android device if one is to hand — that is where `f31d9aa` was found.

- [ ] **Step 7: Run everything and commit**

Run: `npm test && npm run lint && npx tsc --noEmit`

```bash
git add src/components/stock-restock-modal.tsx src/components/stock-transfer-modal.tsx src/components/__tests__/scan-sink.test.ts "src/app/(admin)/(tabs)/inventory.tsx"
git commit -m "feat(inventory): scan into the restock and move sheets, on web"
```

---

## Final verification

- [ ] `npm test` — full Jest suite green
- [ ] `npm run test:db` — full migration chain applies from empty, every verify script passes
- [ ] `npm run lint` and `npx tsc --noEmit` — clean
- [ ] Manual pass on **web, iOS simulator and Android emulator** (`/testing-kaiibi` drives all three):
  - Header reads `Stock` and opens the door
  - Phone path `More → Stock → Restock` opens the modal on iOS
  - A restock **adds** to the count rather than replacing it
  - A priced restock updates the product's cost and the preview said it would
  - A restock sheet naming an unknown product is rejected with `Import products` in the reason
  - A single-store shop with no `multi_location` module can still restock
  - **Web:** a scan into the Restock and Move sheets adds a row, does not close the sheet, and never lands in a quantity box
  - **Android and iOS:** no `Scan` pill in either sheet, and a scanner's Enter with a sheet open leaves it alone
- [x] Update the mockup's status: done in the STATUS block at the head of `docs/design/inventory-restock-mockup.html` (shipped / not built / superseded)
