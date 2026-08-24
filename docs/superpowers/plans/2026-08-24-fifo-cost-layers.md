# FIFO Cost Layers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remember what each delivery cost, so stock can be valued FIFO instead of by a single per-product average that the next delivery overwrites.

**Architecture:** Two tables — `inventory_cost_layers`, one row per delivery per location, and `inventory_cost_consumption`, which records which layers each sale line drew from. One function, `consume_layers()`, is the only thing that draws down a layer, and every caller reaches it in the same lock order. Five existing RPCs gain a layer side: `receive_stock` creates, `complete_sale` consumes, `save_stock_count` does both, `refund_sale_items` restores, `transfer_stock` moves. Weighted average stays the default; FIFO is a per-shop setting, because the layers produce both figures.

**Tech Stack:** Postgres 15 (Supabase), plpgsql, TypeScript. Tests: `npm run test:db`, plus one genuinely parallel concurrency test. No new dependencies.

## Global Constraints

Every task's requirements implicitly include this section.

### Scope

**Phase 2a** of [the accounting design](../specs/2026-08-22-accounting-standards-design.md), against [the 2a design](../specs/2026-08-23-fifo-cost-layers-design.md). Read the 2a design before starting — it carries the reasoning this plan only executes.

**This phase changes what a cost IS. It does not change where costs are recorded.** No journal entry is written by anything here. Posting COGS to the ledger is phase 2b and must come after.

Explicitly not in this plan: auto-posting to the ledger, FEFO consumption, rewriting `getExpiringProducts()`, any batch-entry UI, restating historical COGS, and any screen. The Inventory Valuation report is phase 4.

### Already shipped — do not re-do

**[#66](https://github.com/yshaqalle/kaiibi/pull/66) fixed the lock ordering in `complete_sale` and `edit_sale`.** Both now iterate `order by (value->>'product_id'), ord`. The 2a design's "first task" is done. If you find those loops unordered, you are on the wrong base — check `20260905000000_complete_sale_lock_order.sql` is present.

### Baselines — green on `main` today, must be green at every commit

- `npx tsc --noEmit` → **clean, exit 0**
- `npm test` → **139 suites, 2122 tests**
- `npm run lint` → **81 problems (49 errors, 32 warnings)**. Do not add to this, and do not fix pre-existing ones here.
- `npm run test:db` → **17 checks pass**, 3 skipped. Requires `npx supabase start`.

### The hazard this plan exists to manage

**Concurrency on the POS's hottest path.**

Before this phase, a sale line locks one `product_location_stock` row. After it, that line locks the same row *plus every open cost layer it consumes*, and holds them longer. Two tills selling the same product both reach for the oldest layer.

Two failure modes, and they need different defences:

1. **Over-consumption** — two sales each read `quantity_remaining = 5` and each take 5. Prevented by `for update` on the layer rows, which is not optional and not replaceable by an optimistic check.
2. **Deadlock** — two sales take the same two layers in opposite order. Prevented by **one ordering, everywhere**: `order by received_at, id`.

**`id` is the tiebreaker and is not decorative.** Two layers received in the same microsecond — one `receive_stock` call writing two lines for the same product — have equal `received_at`. Without a tiebreaker the sort is arbitrary and two sessions can order them differently. This is the same reasoning `receive_stock:131` gives for adding ordinality behind product id.

**Every task that touches layers uses that exact ordering.** If you write `order by received_at` without `, id` anywhere, the concurrency test in Task 10 is the thing that should catch you — and if it does not, the test is wrong.

### Migration conventions this repo enforces

- **Numbering.** Latest on main is `20260905000000`. This plan adds `20260906000000` onward. Never renumber an existing file.
- **`create or replace function` replaces the whole body.** When extending an existing function, reproduce it verbatim and state the single change in a comment — or rewrite by substitution with a guard, as `20260905000000` does. Prefer verbatim for short functions; substitution is justified only at `complete_sale`'s size, and then the guard must refuse to run if the count is unexpected.
- **`pg_get_function_arguments`, never `pg_get_function_identity_arguments`**, if you rewrite by substitution. The identity form drops `DEFAULT` clauses and `CREATE OR REPLACE` refuses to remove defaults from an existing function. This cost a failed apply in #66.
- **`security definer` + `set search_path = public`** on every RPC, and `grant execute ... to authenticated`.
- **Comment density.** Read `20260903000100_stock_counts.sql` before writing a migration. These files explain *why*, at length, in prose.

### Test conventions

- DB checks live in `supabase/tests/verify-*.sql`, **auto-discovered by glob**. A script must print **`ALL CHECKS PASSED`**.
- Each builds its own fixture in one `do $$ ... $$` block and rolls back via an `exception` clause. Copy `verify-stock-counts.sql`.
- **These scripts run as `postgres`, so RLS does not apply.** Never assert a policy by attempting the operation — assert against `pg_policies`. And any RPC gating on `has_shop_permission` refuses until the script does:
  ```sql
  perform set_config('request.jwt.claims', json_build_object('sub', v_user_id)::text, true);
  perform set_config('role', 'authenticated', true);
  ```
  Setting `role` also turns RLS **on**, so raw inserts into tables with no write policy must come first.
- **A shop has no location until you make one.** `seed_shop_defaults` does not create one, and `complete_sale` refuses without it. Cost a failed run in #66:
  ```sql
  insert into public.shop_locations (shop_id, name, is_primary) values (v_shop_id, 'Main', true) returning id into v_loc_id;
  ```
- **Every test step below names the mutation that must turn it red.** After a test passes, apply that mutation, watch it fail, revert. This project has shipped **four** tests that could not fail — three found by mutation, none by reading. Two of them passed because a *different* rule rejected the fixture first, so:
- **Choose fixtures where only the thing under test can fail them.** If a quantity, a line count or a balance check could reject your input for an unrelated reason, the test proves nothing.

## File Structure

| File | Responsibility |
|---|---|
| `supabase/migrations/20260906000000_inventory_cost_layers.sql` | Both tables, RLS, the partial index |
| `supabase/migrations/20260906000100_consume_layers.sql` | `consume_layers()`, `restore_layers()`, `create_layer()` |
| `supabase/migrations/20260906000200_receive_stock_layers.sql` | `receive_stock` creates a layer per line |
| `supabase/migrations/20260906000300_complete_sale_layers.sql` | `complete_sale` consumes; `unit_cost_cents` becomes the blend |
| `supabase/migrations/20260906000400_count_and_refund_layers.sql` | `save_stock_count` both ways, `refund_sale_items` restores |
| `supabase/migrations/20260906000500_transfer_stock_layers.sql` | `transfer_stock` moves quantity carrying cost |
| `supabase/migrations/20260906000600_opening_layers.sql` | One opening layer per product per location; the basis setting |
| `supabase/tests/verify-cost-layers.sql` | Everything above that Postgres alone can prove |
| `supabase/tests/verify-cost-layers-concurrency.sql` | The parallel test, using `dblink` |

One migration per writer, so a reviewer can judge each RPC's change on its own and a bisect lands on one function.

---

### Task 1: The two tables

**Files:**
- Create: `supabase/migrations/20260906000000_inventory_cost_layers.sql`
- Create: `supabase/tests/verify-cost-layers.sql` (checks 1–4)

**Interfaces:**
- Consumes: `products`, `shop_locations`, `sale_items`.
- Produces: `public.inventory_cost_layers` and `public.inventory_cost_consumption` as specified in the 2a design. Every later task writes to these.

- [ ] **Step 1: Write the failing test**

Create `supabase/tests/verify-cost-layers.sql`. Follow `verify-stock-counts.sql`'s shape. The fixture: a user, a shop, one location, two products — one costed at 1450, one uncosted (`cost_cents` null).

Checks:

```sql
  -- 1. A layer cannot remain more than it received. The invariant everything
  -- else rests on: consumption only ever decreases quantity_remaining, and a
  -- bug that increased it past the receipt would silently create stock.
  v_raised := false;
  begin
    insert into public.inventory_cost_layers
      (shop_id, product_id, location_id, unit_cost_cents, quantity_received, quantity_remaining, source)
      values (v_shop_id, v_costed, v_loc_id, 1450, 10, 11, 'receipt');
  exception when check_violation then v_raised := true;
  end;
  if not v_raised then raise exception 'FAIL: a layer with more remaining than received was accepted'; end if;

  -- 2. Negative remaining is refused. Over-consumption would show up here
  -- first, and a table that permitted it would let the bug persist as data.
  v_raised := false;
  begin
    insert into public.inventory_cost_layers
      (shop_id, product_id, location_id, unit_cost_cents, quantity_received, quantity_remaining, source)
      values (v_shop_id, v_costed, v_loc_id, 1450, 10, -1, 'receipt');
  exception when check_violation then v_raised := true;
  end;
  if not v_raised then raise exception 'FAIL: a layer with negative remaining was accepted'; end if;

  -- 3. A null unit cost is ALLOWED. An uncosted product is a real thing --
  -- isUncosted() in product-costing.ts is careful that null and zero differ --
  -- and a layer that refused it would force a zero, which is a real answer
  -- meaning "free".
  insert into public.inventory_cost_layers
    (shop_id, product_id, location_id, unit_cost_cents, quantity_received, quantity_remaining, source)
    values (v_shop_id, v_uncosted, v_loc_id, null, 5, 5, 'receipt');

  -- 4. A bogus source is refused. The set is closed because reports group by
  -- it; a seventh spelling would become a seventh category nothing names.
  v_raised := false;
  begin
    insert into public.inventory_cost_layers
      (shop_id, product_id, location_id, unit_cost_cents, quantity_received, quantity_remaining, source)
      values (v_shop_id, v_costed, v_loc_id, 1450, 1, 1, 'magic');
  exception when check_violation then v_raised := true;
  end;
  if not v_raised then raise exception 'FAIL: a bogus layer source was accepted'; end if;
```

- [ ] **Step 2: Run it and verify it fails**

Run: `npm run test:db -- --no-reset`
Expected: `verify-cost-layers  FAIL` with `relation "public.inventory_cost_layers" does not exist`.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/20260906000000_inventory_cost_layers.sql`. Write the header first, in this repo's register — what the tables are for, and why one cost per product was not enough. Then:

```sql
create table public.inventory_cost_layers (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete cascade,
  -- Per LOCATION, not per shop. Kaiibi reports profit per location, and a
  -- shop-wide pool would let a sale at one branch consume a delivery sitting
  -- at another. The cost of that correctness is that transfer_stock has to
  -- move layer quantity carrying its cost -- see 20260906000500.
  location_id uuid not null references public.shop_locations(id),
  -- Null where the product is uncosted. Never zero: zero is a real answer
  -- meaning the unit was free, and product-costing.ts is careful about the
  -- difference.
  unit_cost_cents integer check (unit_cost_cents is null or unit_cost_cents >= 0),
  quantity_received integer not null check (quantity_received > 0),
  quantity_remaining integer not null check (quantity_remaining >= 0),
  source text not null check (source in ('receipt','opening','count','return','transfer')),
  source_id uuid,
  -- Neither is read by any accounting. products.expiry_date has the same
  -- one-value-per-product defect cost_cents has -- two deliveries of milk with
  -- different dates cannot both be represented, so the second silently
  -- replaces the first and the alert fires on the wrong day. A layer IS a
  -- delivery, so it is the right home. Populated here so the fix later needs
  -- no second pass over complete_sale; getExpiringProducts() is unchanged and
  -- still reads the product column.
  expires_on date,
  batch_number text,
  received_at timestamptz not null default now(),
  constraint layer_not_over_consumed check (quantity_remaining <= quantity_received)
);

-- Every consumption is this lookup. The partial predicate keeps exhausted
-- layers out of an index on a table that only ever grows -- a shop three years
-- in has far more spent layers than open ones.
--
-- received_at AND id, because received_at alone is not a total order: one
-- receive_stock call writing two lines for the same product produces two
-- layers with equal timestamps. Two sessions sorting those differently is a
-- deadlock, which is the whole reason this index names both.
create index inventory_cost_layers_open_idx
  on public.inventory_cost_layers (shop_id, product_id, location_id, received_at, id)
  where quantity_remaining > 0;

create table public.inventory_cost_consumption (
  id uuid primary key default gen_random_uuid(),
  sale_item_id uuid not null references public.sale_items(id) on delete cascade,
  -- No ON DELETE: a layer that has been consumed must not be deletable, and
  -- the reference is what enforces it.
  layer_id uuid not null references public.inventory_cost_layers(id),
  quantity integer not null check (quantity > 0),
  unit_cost_cents integer check (unit_cost_cents is null or unit_cost_cents >= 0)
);
create index inventory_cost_consumption_sale_item_idx on public.inventory_cost_consumption(sale_item_id);
create index inventory_cost_consumption_layer_idx on public.inventory_cost_consumption(layer_id);
```

Then RLS on both, `select` gated on `inventory.view`, and **no insert/update/delete policy** — the RPCs are the only writer, the posture `stock_receipts`, `stock_counts` and the ledger tables all take. `grant select` to `authenticated`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test:db`
Expected: `verify-cost-layers  pass`, **18 database checks passed**.

- [ ] **Step 5: Prove the test can fail**

Mutation: remove `constraint layer_not_over_consumed`. Expected: `FAIL: a layer with more remaining than received was accepted`. Revert.

Mutation: change the `source` check to `source is not null`. Expected: `FAIL: a bogus layer source was accepted`. Revert.

Mutation: change `unit_cost_cents` to `not null`. Expected: check 3 fails with a not-null violation. Revert.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/20260906000000_inventory_cost_layers.sql supabase/tests/verify-cost-layers.sql
git commit -m "feat(inventory): remember what each delivery cost"
```

---

### Task 2: `consume_layers()` and its siblings

**Files:**
- Create: `supabase/migrations/20260906000100_consume_layers.sql`
- Modify: `supabase/tests/verify-cost-layers.sql` (checks 5–11)

**Interfaces:**
- Consumes: the tables from Task 1.
- Produces, and **every later task calls these rather than touching layers directly**:
  ```
  create_layer(p_shop_id uuid, p_product_id uuid, p_location_id uuid,
               p_quantity integer, p_unit_cost_cents integer, p_source text,
               p_source_id uuid default null, p_expires_on date default null,
               p_batch_number text default null) returns uuid

  consume_layers(p_shop_id uuid, p_product_id uuid, p_location_id uuid,
                 p_quantity integer)
    returns table (layer_id uuid, quantity integer, unit_cost_cents integer)

  restore_layers(p_sale_item_id uuid, p_quantity integer) returns void
  ```
  `consume_layers` returns one row per layer drawn from, newest call last. The caller blends them for `sale_items.unit_cost_cents` and writes the consumption rows.

- [ ] **Step 1: Write the failing test**

Add to `verify-cost-layers.sql`. Fixture: two layers on the costed product — 10 units at 1450 received earlier, 10 units at 1490 received later.

```sql
  -- 5. FIFO. Taking 4 draws all 4 from the OLDER layer and leaves it at 6.
  -- Deliberately fewer than the older layer holds, so this fails if the order
  -- is reversed rather than merely if the arithmetic is wrong.
  select array_agg(unit_cost_cents order by unit_cost_cents) into v_costs
    from public.consume_layers(v_shop_id, v_costed, v_loc_id, 4);
  if v_costs <> array[1450] then
    raise exception 'FAIL: expected 4 units from the 1450 layer, got %', v_costs;
  end if;

  -- 6. A draw that SPANS layers takes the rest of the old one and the balance
  -- from the new. 6 remain at 1450; asking for 9 must give 6 + 3.
  select array_agg(row(quantity, unit_cost_cents)::text order by unit_cost_cents)
    into v_rows from public.consume_layers(v_shop_id, v_costed, v_loc_id, 9);
  if v_rows <> array['(6,1450)', '(3,1490)'] then
    raise exception 'FAIL: expected 6@1450 then 3@1490, got %', v_rows;
  end if;

  -- 7. The old layer is now exhausted and the new one is drawn down.
  if (select quantity_remaining from public.inventory_cost_layers
        where product_id = v_costed and unit_cost_cents = 1450) <> 0 then
    raise exception 'FAIL: the older layer was not exhausted';
  end if;
  if (select quantity_remaining from public.inventory_cost_layers
        where product_id = v_costed and unit_cost_cents = 1490) <> 7 then
    raise exception 'FAIL: the newer layer is not at 7';
  end if;

  -- 8. Running past the end RAISES. complete_sale refuses a line it cannot
  -- cover (20260831000100:242) and product_location_stock carries
  -- check (stock >= 0), so a sale cannot outrun stock. Layers running short
  -- therefore means layers and stock have drifted -- a broken invariant, and
  -- the single condition most worth hearing about. Inventing a cost for the
  -- shortfall would hide it.
  --
  -- 7 remain; asking for 10 must refuse and leave those 7 untouched.
  v_raised := false;
  begin
    perform public.consume_layers(v_shop_id, v_costed, v_loc_id, 10);
  exception when others then v_raised := true;
  end;
  if not v_raised then
    raise exception 'FAIL: consuming past the end of the layers was accepted';
  end if;
  if (select coalesce(sum(quantity_remaining), 0) from public.inventory_cost_layers
        where product_id = v_costed and location_id = v_loc_id) <> 7 then
    raise exception 'FAIL: a refused consumption still drew stock down';
  end if;

  -- 9. An UNCOSTED product yields a null cost, not zero. Zero would report the
  -- units as free and overstate gross profit by their whole value.
  perform public.create_layer(v_shop_id, v_uncosted, v_loc_id, 5, null, 'receipt');
  select array_agg(unit_cost_cents) into v_costs
    from public.consume_layers(v_shop_id, v_uncosted, v_loc_id, 2);
  if v_costs <> array[null]::integer[] then
    raise exception 'FAIL: an uncosted layer produced % rather than null', v_costs;
  end if;

  -- 10. Consumption is refused for a quantity of zero or less. A call that
  -- draws nothing is a bug in the caller, not a no-op worth absorbing.
  v_raised := false;
  begin
    perform public.consume_layers(v_shop_id, v_costed, v_loc_id, 0);
  exception when others then v_raised := true;
  end;
  if not v_raised then raise exception 'FAIL: consuming zero units was accepted'; end if;

  -- 11. There is no write policy on either table. The RPCs are the only door,
  -- asserted against pg_policies because this script runs as superuser and an
  -- attempted insert would succeed however the policies read.
  if exists (
    select 1 from pg_policies
     where schemaname = 'public'
       and tablename in ('inventory_cost_layers', 'inventory_cost_consumption')
       and cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL')
  ) then
    raise exception 'FAIL: a layer table has a write policy';
  end if;
```

- [ ] **Step 2: Run it and verify it fails**

Run: `npm run test:db -- --no-reset`
Expected: FAIL with `function public.consume_layers(...) does not exist`.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/20260906000100_consume_layers.sql`. Header explains the lock ordering at length — it is the reason this function exists rather than each caller doing its own draw-down.

`consume_layers` must:

1. Refuse `p_quantity <= 0`.
2. Loop open layers `where quantity_remaining > 0` for that shop/product/location, **`order by received_at, id`**, `for update`.
3. Take `least(remaining, still_needed)` from each; `update ... set quantity_remaining = quantity_remaining - taken`.
4. `return next` a row per layer drawn.
5. If need remains after the loop, **raise**. Do not invent a layer. The whole transaction rolls back, so the partial draw-down in step 3 is undone — which is what makes check 8's second assertion hold.

`restore_layers(sale_item, qty)` reads `inventory_cost_consumption` for that sale item **most-recent-first** and adds quantity back to the layers it names, capped at each row's recorded quantity. It does **not** create a layer: the units physically are the ones that left, and a new layer at today's cost would let sell-then-refund reprice stock.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test:db`
Expected: `verify-cost-layers  pass`.

- [ ] **Step 5: Prove the test can fail**

Mutation: change `order by received_at, id` to `order by received_at desc, id`. Expected: check 5 fails, reporting 1490. Revert.

Mutation: let the loop end short and return normally instead of raising. Expected: check 8 fails. Revert.

Mutation: in `consume_layers`, return `coalesce(unit_cost_cents, 0)`. Expected: check 9 fails — it produces 0 rather than null. Revert.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/20260906000100_consume_layers.sql supabase/tests/verify-cost-layers.sql
git commit -m "feat(inventory): draw stock oldest-first, under one lock order"
```

---

### Task 3: `receive_stock` creates a layer

**Files:**
- Create: `supabase/migrations/20260906000200_receive_stock_layers.sql`
- Modify: `supabase/tests/verify-cost-layers.sql` (checks 12–13)

**Interfaces:**
- Consumes: `create_layer` (Task 2).
- Produces: every `receive_stock` line writes one layer, `source = 'receipt'`, `source_id` = the receipt id.

- [ ] **Step 1: Write the failing test**

```sql
  -- 12. Receiving creates a layer carrying that line's cost, not the product's.
  -- Two deliveries at different prices must leave two layers, which is the
  -- entire point -- a single cost_cents cannot represent it.
  v_receipt := public.receive_stock(v_shop_id, v_loc_id,
    jsonb_build_array(jsonb_build_object('product_id', v_costed, 'quantity', 12, 'unit_cost_cents', 1520)));
  if not exists (
    select 1 from public.inventory_cost_layers
     where source = 'receipt' and source_id = v_receipt
       and unit_cost_cents = 1520 and quantity_received = 12 and quantity_remaining = 12
  ) then
    raise exception 'FAIL: receiving did not create a layer at the line cost';
  end if;

  -- 13. A line with NO cost still creates a layer, with a null cost. Refusing
  -- would leave stock on the shelf with no layer behind it, and the next sale
  -- would have no cost to draw on for units that really did arrive.
  v_receipt := public.receive_stock(v_shop_id, v_loc_id,
    jsonb_build_array(jsonb_build_object('product_id', v_uncosted, 'quantity', 4)));
  if not exists (
    select 1 from public.inventory_cost_layers
     where source_id = v_receipt and unit_cost_cents is null and quantity_received = 4
  ) then
    raise exception 'FAIL: an uncosted receipt line created no layer';
  end if;
```

- [ ] **Step 2: Run it and verify it fails**, then write the migration.

Reproduce `receive_stock` verbatim from `20260902000000_stock_receipts.sql` with **one change**: a `create_layer(...)` call inside the loop, after the `stock_receipt_items` insert, passing that line's `v_cost` (which may be null). State the single change in the header, as this repo requires.

- [ ] **Step 3: Run the test, prove it can fail, commit**

Mutation: pass `v_product.cost_cents` instead of `v_cost`. Expected: check 12 fails — the layer carries the product's rolling cost rather than this delivery's. This is the exact bug layers exist to prevent, so it is the mutation that matters most.

```bash
git commit -m "feat(inventory): a delivery becomes a cost layer"
```

---

### Task 4: `complete_sale` consumes

**Files:**
- Create: `supabase/migrations/20260906000300_complete_sale_layers.sql`
- Modify: `supabase/tests/verify-cost-layers.sql` (checks 14–17)

**Interfaces:**
- Consumes: `consume_layers` (Task 2).
- Produces: `sale_items.unit_cost_cents` is the **blended** cost of the layers that line drew from, and one `inventory_cost_consumption` row per layer.

- [ ] **Step 1: Write the failing test**

Fixture: exactly two layers — 6 at 1000 and 6 at 2000 — then sell 9. Chosen so the blend is unambiguous: 6×1000 + 3×2000 = 12000 over 9 units = **1333.33**, which rounds to 1333 and could not arise from either layer alone or from a plain average of the two costs (1500).

```sql
  -- 14. The line's cost is the BLEND of the layers it drew from. 6@1000 plus
  -- 3@2000 over 9 units is 1333, which is neither layer's cost and not the
  -- average of the two -- so this fails if the blend is wrong in either
  -- direction.
  if (select unit_cost_cents from public.sale_items where sale_id = v_sale and product_id = v_costed) <> 1333 then
    raise exception 'FAIL: expected a blended 1333, got %',
      (select unit_cost_cents from public.sale_items where sale_id = v_sale and product_id = v_costed);
  end if;

  -- 15. The consumption rows name both layers and sum to the quantity sold.
  if (select coalesce(sum(quantity), 0) from public.inventory_cost_consumption c
        join public.sale_items si on si.id = c.sale_item_id
       where si.sale_id = v_sale) <> 9 then
    raise exception 'FAIL: consumption rows do not sum to the quantity sold';
  end if;
  if (select count(*) from public.inventory_cost_consumption c
        join public.sale_items si on si.id = c.sale_item_id
       where si.sale_id = v_sale) <> 2 then
    raise exception 'FAIL: expected two consumption rows, one per layer';
  end if;

  -- 16. The rows sum EXACTLY to the line's cost -- no rounding drift. 6*1000 +
  -- 3*2000 = 12000, and 9 * 1333 = 11997, so a naive per-unit multiply loses 3
  -- cents. The consumption rows are the truth and must not be the rounded
  -- figure.
  if (select coalesce(sum(quantity * unit_cost_cents), 0) from public.inventory_cost_consumption c
        join public.sale_items si on si.id = c.sale_item_id
       where si.sale_id = v_sale) <> 12000 then
    raise exception 'FAIL: consumption rows do not sum to the true cost of 12000';
  end if;

  -- 17. Stock and layers agree. Layers remaining must equal
  -- product_location_stock -- if they drift, one of the two is lying and every
  -- valuation after this is wrong.
  if (select coalesce(sum(quantity_remaining), 0) from public.inventory_cost_layers
        where product_id = v_costed and location_id = v_loc_id)
     <> (select stock from public.product_location_stock
          where product_id = v_costed and location_id = v_loc_id) then
    raise exception 'FAIL: layers and product_location_stock disagree';
  end if;
```

- [ ] **Step 2: Run it and verify it fails**, then write the migration.

`complete_sale` is ~430 lines. **Rewrite by substitution with a guard**, as `20260905000000` does — a verbatim paste at this size is a diff nobody can read. Read that migration first; copy its structure exactly, including `pg_get_function_arguments`.

The substitution replaces the `sale_items` insert so that, before it, the function calls `consume_layers`, blends the result, and after the insert writes the consumption rows against the new `sale_items.id`. Use `returning id` on the insert.

**Blending:** `round(sum(quantity * unit_cost_cents)::numeric / sum(quantity))`, and **null if every layer's cost is null**. A line mixing costed and uncosted layers blends only the costed part and is flagged — decide and document which, do not leave it implicit.

**Rounding:** the consumption rows keep each layer's true `unit_cost_cents`; only `sale_items.unit_cost_cents` is rounded. That is what makes check 16 pass.

- [ ] **Step 3: Run, prove it can fail, commit**

Mutation: set `unit_cost_cents` from the first consumption row rather than the blend. Expected: check 14 fails with 1000.

Mutation: write one consumption row for the whole line. Expected: check 15 fails on the row count.

```bash
git commit -m "feat(pos): a sale draws its cost from the layers it consumed"
```

---

### Task 5: `save_stock_count` both ways

**Files:**
- Create: `supabase/migrations/20260906000400_count_and_refund_layers.sql`
- Modify: `supabase/tests/verify-cost-layers.sql` (checks 18–20)

**Interfaces:**
- Consumes: `consume_layers`, `create_layer`.
- Produces: a downward variance consumes; an upward one creates at the count's frozen `unit_cost_cents`.

- [ ] **Step 1: Write the failing test**

```sql
  -- 18. Counting DOWN consumes oldest-first, exactly as a sale does. The units
  -- are gone either way and the cost has to leave with them.
  -- (fixture: 10 units in one layer at 1450, count 7)
  if (select coalesce(sum(quantity_remaining), 0) from public.inventory_cost_layers
        where product_id = v_costed and location_id = v_loc_id) <> 7 then
    raise exception 'FAIL: counting down did not consume layers';
  end if;

  -- 19. Counting UP creates a layer at the count's FROZEN cost, not today's.
  -- The count froze a cost for this reason; using the current one would value
  -- found stock at a price it was never bought at.
  update public.products set cost_cents = 9999 where id = v_costed;
  perform public.save_stock_count(v_shop_id, v_loc_id,
    jsonb_build_array(jsonb_build_object('product_id', v_costed, 'counted_quantity', 12)));
  if not exists (
    select 1 from public.inventory_cost_layers
     where product_id = v_costed and source = 'count' and quantity_received = 5
       and unit_cost_cents = 9999
  ) then
    raise exception 'FAIL: counting up did not create a layer at the frozen cost';
  end if;

  -- 20. Layers still agree with stock after both directions.
  if (select coalesce(sum(quantity_remaining), 0) from public.inventory_cost_layers
        where product_id = v_costed and location_id = v_loc_id)
     <> (select stock from public.product_location_stock
          where product_id = v_costed and location_id = v_loc_id) then
    raise exception 'FAIL: layers and stock disagree after a count';
  end if;
```

> **Note on check 19.** `save_stock_count` freezes `v_product.cost_cents` into `stock_count_items.unit_cost_cents` at the moment of the count. Since the test sets `cost_cents` to 9999 *before* calling, the frozen value and the current value are the same here — so **this check does not distinguish frozen from current**. Fix it by setting `cost_cents` to a different value *after* the count and asserting the layer still reads 9999. Write it that way; the version above is the trap.

- [ ] **Step 2–3: Migration, mutation, commit**

`save_stock_count` reproduced verbatim with one change in the loop: after computing `v_previous` and writing the row, call `consume_layers` when `v_counted < v_previous`, or `create_layer(..., 'count', v_count_id)` when `v_counted > v_previous`, at `v_product.cost_cents` — the same value frozen onto the item row.

Mutation: use `products.cost_cents` re-read after the update rather than the frozen value. Expected: check 19 fails, once written per the note above.

```bash
git commit -m "feat(inventory): a stock-take moves cost as well as count"
```

---

### Task 6: `refund_sale_items` restores

**Files:**
- Modify: `supabase/migrations/20260906000400_count_and_refund_layers.sql`
- Modify: `supabase/tests/verify-cost-layers.sql` (checks 21–22)

- [ ] **Step 1: Write the failing test**

```sql
  -- 21. A refund puts units back on the layers they came from, at the price
  -- they left at. A new layer at today's cost would let sell-then-refund
  -- silently reprice stock, which is a way to launder a cost change through
  -- the till.
  -- (fixture: the Task 4 sale of 9, refund 4)
  if (select quantity_remaining from public.inventory_cost_layers
        where product_id = v_costed and unit_cost_cents = 2000) <> 7 then
    raise exception 'FAIL: the refund did not restore to the newest layer first';
  end if;
  if exists (select 1 from public.inventory_cost_layers
              where product_id = v_costed and source = 'return') then
    raise exception 'FAIL: the refund created a new layer instead of restoring';
  end if;

  -- 22. Restoring never exceeds what was taken. Refunding the whole line must
  -- return each layer to exactly where it was before the sale.
  if (select coalesce(sum(quantity_remaining), 0) from public.inventory_cost_layers
        where product_id = v_costed and location_id = v_loc_id) <> v_before_sale then
    raise exception 'FAIL: a full refund did not restore the layers exactly';
  end if;
```

- [ ] **Step 2–3: Migration, mutation, commit**

`refund_sale_items` reproduced verbatim with one change: after restoring `product_location_stock`, call `restore_layers(v_sale_item.id, v_requested_qty)`.

Mutation: make `restore_layers` create a layer instead of restoring. Expected: check 21 fails on the `source = 'return'` clause.

```bash
git commit -m "feat(pos): a refund returns stock at the price it left at"
```

---

### Task 7: `transfer_stock` moves cost

**Files:**
- Create: `supabase/migrations/20260906000500_transfer_stock_layers.sql`
- Modify: `supabase/tests/verify-cost-layers.sql` (checks 23–24)

- [ ] **Step 1: Write the failing test**

Fixture: a second location, and stock at the first in two layers of different cost.

```sql
  -- 23. Transferring moves quantity AND cost. Layers are per location, so a
  -- transfer that only moved the count would leave the destination with stock
  -- and no layer -- and the next sale there would fail outright, on stock the
  -- shop has had all along.
  perform public.transfer_stock(v_shop_id, v_loc_id, v_loc2,
    jsonb_build_array(jsonb_build_object('product_id', v_costed, 'quantity', 4)));
  if (select coalesce(sum(quantity_remaining), 0) from public.inventory_cost_layers
        where product_id = v_costed and location_id = v_loc2) <> 4 then
    raise exception 'FAIL: the destination has no layers for transferred stock';
  end if;

  -- 24. The shop's total value is unchanged. A transfer is not a purchase and
  -- not a loss; if the two locations do not sum to what one held before, the
  -- transfer repriced something.
  if (select coalesce(sum(quantity_remaining * coalesce(unit_cost_cents, 0)), 0)
        from public.inventory_cost_layers where product_id = v_costed) <> v_value_before then
    raise exception 'FAIL: transferring changed the shop''s stock value';
  end if;
```

- [ ] **Step 2–3: Migration, mutation, commit**

`transfer_stock` reproduced verbatim with one change: consume from the source location oldest-first, and create a matching layer at the destination for each consumed slice, carrying that slice's `unit_cost_cents` and `source = 'transfer'`.

Mutation: create the destination layer at `products.cost_cents`. Expected: check 24 fails whenever the layers differ from the rolling cost.

```bash
git commit -m "feat(inventory): moving stock between branches carries its cost"
```

---

### Task 8: The opening migration and the basis setting

**Files:**
- Create: `supabase/migrations/20260906000600_opening_layers.sql`
- Modify: `supabase/tests/verify-cost-layers.sql` (checks 25–26)

**Interfaces:**
- Produces: `shops.inventory_basis` — `'weighted_average'` (default) or `'fifo'` — and one `source = 'opening'` layer per product per location that currently holds stock.

- [ ] **Step 1: Write the failing test**

```sql
  -- 25. Every product with stock has a layer covering it. A product with stock
  -- and no layer is the state that makes the first sale fail on a shortfall
  -- cost for units that were really there.
  if exists (
    select 1 from public.product_location_stock pls
     join public.products p on p.id = pls.product_id
     where p.shop_id = v_legacy_shop and pls.stock > 0
       and coalesce((select sum(quantity_remaining) from public.inventory_cost_layers l
                      where l.product_id = pls.product_id and l.location_id = pls.location_id), 0) < pls.stock
  ) then
    raise exception 'FAIL: a product with stock has no layer behind it';
  end if;

  -- 26. Existing shops default to weighted average, so nobody's margin moves
  -- on the morning this ships. FIFO is a decision, not something that happens
  -- to a shop overnight.
  if (select inventory_basis from public.shops where id = v_legacy_shop) <> 'weighted_average' then
    raise exception 'FAIL: an existing shop was switched off weighted average';
  end if;
```

The fixture must create the shop, products and stock **before** this migration's logic is replayed — build it the way `verify-inventory-permissions.sql` replays a backfill against a fixture shop.

- [ ] **Step 2–3: Migration, mutation, commit**

```sql
alter table public.shops add column if not exists inventory_basis text not null default 'weighted_average'
  check (inventory_basis in ('weighted_average','fifo'));
```

Then one opening layer per `product_location_stock` row with `stock > 0`, quantity = `stock`, cost = `products.cost_cents` (**null stays null**), `source = 'opening'`.

Write the header carefully. It must say that **FIFO applies from this moment forward and history is not restated** — there is no delivery history to build layers from — and that this is the normal treatment for a change in valuation method, disclosed rather than discovered.

Mutation: default `inventory_basis` to `'fifo'`. Expected: check 26 fails.

```bash
git commit -m "feat(inventory): every shop starts with one opening layer, and weighted average"
```

---

### Task 9: The concurrency test

**Files:**
- Create: `supabase/tests/verify-cost-layers-concurrency.sql`

**This is the task the whole phase exists to de-risk. It is not optional and it does not get skipped for time.**

- [ ] **Step 1: Check `dblink` is available**

Run: `psql "$SUPABASE_DB_URL" -c "create extension if not exists dblink"`

If it is unavailable, **stop and report** rather than substituting a sequential test that proves nothing. A named alternative is `pg_background`; if neither exists, the honest outcome is a test marked `@no-verdict` that documents what could not be checked.

- [ ] **Step 2: Write the test**

Two assertions, both requiring genuine parallelism:

**No over-consumption.** One layer of 10 units. Two connections each sell 6, concurrently. Exactly one must succeed and one must fail on insufficient stock; `quantity_remaining` must never go negative and the layer must end at 4 — never at −2, and never at 4 with both sales recorded.

**No deadlock.** Two products, two layers each. Connection A sells both in one cart; connection B sells both in the other cart order. Neither may fail with `deadlock_detected` (SQLSTATE `40P01`). Run the pair several times — a deadlock that appears one time in ten is still a deadlock, and a single pass proves less than it looks.

- [ ] **Step 3: Prove it can fail**

Mutation: change `consume_layers`' `order by received_at, id` to `order by id` in one caller only, so two callers disagree. Expected: the deadlock assertion trips.

Mutation: remove `for update` from the layer select. Expected: the over-consumption assertion trips — this is the one that would otherwise ship silently and let a shop sell stock it does not have.

If **neither** mutation reddens the test, **the test is wrong** and must be fixed before the phase is called done. A green concurrency test that cannot fail is worse than none, because it is what everyone will point at.

- [ ] **Step 4: Commit**

```bash
git commit -m "test(inventory): prove two tills cannot over-consume a layer or deadlock"
```

---

### Task 10: Whole-phase verification

- [ ] **Step 1: Full suite**

Run: `npx tsc --noEmit && npm test && npm run lint && npm run test:db`
Expected: exit 0; 139 suites / 2122 tests; **81** lint problems; **19** database checks (17 + the two new scripts).

No TypeScript changes anywhere in this phase, so the Jest and lint numbers must be **identical** to the baseline. If either moved, something outside the scope was touched.

- [ ] **Step 2: Measure the hot path**

Time a 20-line sale before and after, on a shop with several layers per product. Record both numbers in the PR. The 2a design flags write volume as a risk; a PR that does not say what it cost is asking a reviewer to take it on faith.

- [ ] **Step 3: Prove the invariant across the whole fixture**

One final check in `verify-cost-layers.sql`: for **every** product and location in the fixture shop, `sum(quantity_remaining)` equals `product_location_stock.stock`. Every task asserts this locally; this asserts nothing drifted across their interactions, which is where a bug between two RPCs would hide.

---

## What phase 2b picks up

Auto-posting. Every RPC here already knows its cost; 2b makes them write the journal entry that records it — `complete_sale` posting COGS against Inventory, `receive_stock` posting Inventory against Payable, and the historical backfill.

Nothing in this phase writes to the ledger. If a task here starts calling `post_journal_entry`, it has left its scope.

## Open, and worth confirming before starting

**Both settled on 2026-08-24**, and both toward less machinery:

**Provisional layers are gone.** `complete_sale` refuses a line it cannot cover and `product_location_stock.stock` carries `check (stock >= 0)`, so a sale cannot outrun stock — the shop owner has confirmed that is the wanted behaviour. Layers running short therefore means layers and stock have drifted, which is a bug. `consume_layers` raises.

**A line touching any uncosted layer costs `null`**, not a partial blend of the costed part. A partial blend looks complete and is not, and would silently understate COGS.

**One open, and larger than either.** Whether to build this phase at all. Weighted average is already implemented and is accepted under IAS 2; the only reason 2a had to precede 2b was to avoid posting weighted-average COGS and then switching, and if the switch never happens there is no discontinuity. See the design's Open section.
