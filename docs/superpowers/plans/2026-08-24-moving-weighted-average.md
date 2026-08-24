# Moving Weighted Average Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Value stock on a cost formula IAS 2 actually permits. Kaiibi overwrites a product's cost with the newest delivery's price; this makes it a true moving weighted average.

**Architecture:** One arithmetic change inside `receive_stock`, which already holds the row lock it needs. No new table, no change to `complete_sale`, no concurrency work. Plus the IAS 2.36(a) disclosure on the two screens that show a stock value.

**Tech Stack:** Postgres 15 (Supabase), plpgsql, TypeScript. No new dependencies.

## Global Constraints

Every task's requirements implicitly include this section.

### Why this exists

`receive_stock` line 173:

```sql
update public.products set cost_cents = v_cost, updated_at = now() where id = v_product.id;
```

It **replaces** the cost with the newest line's price. The migration's own comment calls it *"latest wins"*. Buy 200 bags at 14.10 and 10 at 14.90, and all 210 are valued at 14.90 — every subsequent sale's COGS is the most recent price paid, whatever the units actually cost.

That is replacement cost. **IAS 2.25 permits exactly two formulas** for interchangeable goods — FIFO and weighted average — and this is neither. IFRS for SMEs §13.18 is the same. So this is not a refinement; it is the difference between a permitted basis and an impermissible one.

**Weighted average rather than FIFO** was chosen because under inflation FIFO draws COGS from the oldest and cheapest stock, raising reported profit and so raising tax. The two are equals under the standard. The FIFO design and plan are merged (#65, #68) and stay available if it is ever wanted.

### Scope

In: the averaging arithmetic, what happens to existing costs, and the disclosure string.

**Not** in: cost layers, any new table, any change to `complete_sale`, `save_stock_count`, `refund_sale_items` or `transfer_stock`, any basis setting or toggle, and any journal entry. Posting is phase 2b.

### Baselines — green on `main` today

- `npx tsc --noEmit` → **clean**
- `npm test` → **139 suites, 2122 tests**
- `npm run lint` → **81 problems (49 errors, 32 warnings)**
- `npm run test:db` → **17 pass**

### The four cases the arithmetic has to get right

The formula is ordinary:

```
new_cost = round((old_qty × old_cost + received_qty × received_cost) / (old_qty + received_qty))
```

What makes it non-trivial is the edges, and each has a right answer that differs from the obvious one:

| Case | Answer | Why |
|---|---|---|
| `old_qty = 0` | new cost = received cost | Averaging against nothing is division by zero. The delivery *is* the whole basis. |
| `old_cost` is null | new cost = received cost | Null means unknown, not zero. Averaging an unknown as zero would halve the cost of a product somebody simply never priced. |
| `received_cost` is null | **leave the cost alone** | The current behaviour, and correct: a delivery with no stated price is no evidence about cost. |
| Stock is negative or absent | treat `old_qty` as 0 | `product_location_stock` refuses negatives, so this is belt-and-braces. |

### The subtlety that will bite

**`receive_stock` upserts the stock BEFORE it writes the cost.**

```sql
insert into public.product_location_stock ... do update set stock = stock + excluded.stock;   -- line 164
...
update public.products set cost_cents = v_cost ...                                            -- line 173
```

So by the time the cost is computed, `product_location_stock.stock` **already includes this delivery**. Averaging against it double-counts the received quantity and produces a number between the old cost and the new one but wrong in a way nobody would notice.

**Read the prior quantity before the upsert**, or subtract `v_qty` from the post-upsert figure. The plan below reads it before, because a subtraction is a second place to get the sign wrong.

### `old_qty` is the SHOP-wide quantity, not the location's

`products.cost_cents` is one figure per product across the whole shop, but stock lives per location. So the average must be taken against **`sum(stock)` over every location**, not just the receiving one. Averaging against one branch's stock would let the same delivery produce a different cost depending on where it landed.

### Test conventions

- DB checks live in `supabase/tests/verify-*.sql`, **auto-discovered by glob**, and must print **`ALL CHECKS PASSED`**.
- Fixtures build in one `do $$ ... $$` block and roll back via an `exception` clause. Copy `verify-stock-receipts.sql`.
- **These scripts run as `postgres`, so RLS never applies.** Assert policies against `pg_policies`, never by attempting the operation. Any RPC gating on `has_shop_permission` needs `set_config('request.jwt.claims', ...)` and `set_config('role', 'authenticated', ...)` first — and setting `role` turns RLS **on**, so raw inserts come before it.
- **A shop has no location until the fixture makes one.** `seed_shop_defaults` does not create one.
- **Every test step names the mutation that must turn it red.** Apply it, watch it fail, revert.
- **Choose numbers that cannot coincide.** Four tests on this project could not fail, two because a different rule rejected the fixture first. The fixtures below use quantities and costs where a wrong implementation gives a visibly different figure.

---

### Task 1: The moving average

**Files:**
- Create: `supabase/migrations/20260907000000_moving_weighted_average.sql`
- Create: `supabase/tests/verify-weighted-average.sql`

- [ ] **Step 1: Write the failing test**

Fixture: a shop, two locations, one product with **no** cost and no stock.

```sql
  -- 1. The first delivery sets the cost outright. There is nothing to average
  -- against, and averaging against zero stock is a division by zero.
  perform public.receive_stock(v_shop_id, v_loc_id,
    jsonb_build_array(jsonb_build_object('product_id', v_prod, 'quantity', 300, 'unit_cost_cents', 1000)));
  if (select cost_cents from public.products where id = v_prod) <> 1000 then
    raise exception 'FAIL: the first delivery did not set the cost, got %',
      (select cost_cents from public.products where id = v_prod);
  end if;

  -- 2. THE ONE THAT MATTERS. A second delivery averages instead of replacing.
  --
  -- 300 @ 1000 plus 100 @ 2000 is 500,000 over 400 units = 1250.
  --
  -- The quantities are chosen so all four candidate answers differ, and this
  -- took two attempts. The first draft used 200 @ 1410 then 10 @ 1490: correct
  -- gives 1414 and averaging against POST-UPSERT stock also gives 1414, so the
  -- most likely implementation bug would have sailed straight through. With a
  -- large second delivery the four separate cleanly:
  --
  --   1250  correct
  --   1200  averaged against post-upsert stock (the delivery counted twice)
  --   2000  "latest wins", the bug being fixed
  --   1500  a plain mean of the two costs, ignoring quantity
  perform public.receive_stock(v_shop_id, v_loc_id,
    jsonb_build_array(jsonb_build_object('product_id', v_prod, 'quantity', 100, 'unit_cost_cents', 2000)));
  if (select cost_cents from public.products where id = v_prod) <> 1250 then
    raise exception 'FAIL: expected a weighted 1250, got % (2000 = latest wins, 1200 = averaged against post-upsert stock, 1500 = mean of costs)',
      (select cost_cents from public.products where id = v_prod);
  end if;

  -- 3. A delivery with NO stated cost leaves the cost alone. A delivery that
  -- did not say what it cost is not evidence that it was free.
  perform public.receive_stock(v_shop_id, v_loc_id,
    jsonb_build_array(jsonb_build_object('product_id', v_prod, 'quantity', 50)));
  if (select cost_cents from public.products where id = v_prod) <> 1250 then
    raise exception 'FAIL: an uncosted delivery changed the cost to %',
      (select cost_cents from public.products where id = v_prod);
  end if;

  -- 4. The average is taken against SHOP-wide stock, not the receiving
  -- location's. 450 units sit at loc 1 (300 + 100 + the 50 uncosted); receiving
  -- 400 @ 2000 at loc 2 must average across both.
  --
  -- Correct: (450*1250 + 400*2000)/850 = 1603. Averaging against loc 2's own
  -- stock -- zero before this -- gives 2000 instead, so the two separate.
  perform public.receive_stock(v_shop_id, v_loc2,
    jsonb_build_array(jsonb_build_object('product_id', v_prod, 'quantity', 400, 'unit_cost_cents', 2000)));
  if (select cost_cents from public.products where id = v_prod) <> 1603 then
    raise exception 'FAIL: expected 1603 averaging across both stores, got % (2000 = averaged against the receiving store only)',
      (select cost_cents from public.products where id = v_prod);
  end if;

  -- 5. A product whose cost was NULL takes the delivery's cost rather than
  -- averaging null as zero, which would halve the cost of anything nobody had
  -- got round to pricing.
  perform public.receive_stock(v_shop_id, v_loc_id,
    jsonb_build_array(jsonb_build_object('product_id', v_uncosted, 'quantity', 5, 'unit_cost_cents', 800)));
  -- v_uncosted already had 40 units on the shelf with no cost recorded.
  if (select cost_cents from public.products where id = v_uncosted) <> 800 then
    raise exception 'FAIL: a null prior cost was averaged rather than replaced, got %',
      (select cost_cents from public.products where id = v_uncosted);
  end if;
```

- [ ] **Step 2: Run it and verify it fails**

Run: `npm run test:db -- --no-reset`
Expected: `verify-weighted-average  FAIL` on **check 2**, reporting **2000** — "latest wins", which is the bug.

Check 1 will already pass, because setting the cost outright is what the current code does when there is nothing to average against. That is expected and is why check 2 is the one named here.

- [ ] **Step 3: Write the migration**

Reproduce `receive_stock` verbatim from `20260902000000_stock_receipts.sql` with **one change**, and say so in the header as this repo requires.

Before the `product_location_stock` upsert, capture the shop-wide prior quantity:

```sql
    -- BEFORE the upsert below, which adds this delivery to the count. Averaging
    -- against the post-upsert figure double-counts the received quantity and
    -- lands between the two costs -- wrong in a way nobody would spot.
    --
    -- Shop-wide, not this location's: products.cost_cents is one figure for the
    -- whole shop, so averaging against one branch's stock would make the same
    -- delivery produce a different cost depending on where it landed.
    select coalesce(sum(stock), 0) into v_prior_qty
      from public.product_location_stock where product_id = v_product.id;
```

Then replace the cost write:

```sql
    if v_cost is not null then
      if v_cost < 0 then
        raise exception 'a unit cost cannot be negative';
      end if;

      -- A true moving weighted average, which is one of the two formulas
      -- IAS 2.25 permits. The previous statement here set cost_cents to
      -- v_cost outright -- "latest wins" -- which is replacement cost and is
      -- not a permitted basis.
      --
      -- Null prior cost, or nothing on the shelf, means there is nothing to
      -- average against and the delivery is the whole basis. Null is NOT
      -- treated as zero: it means nobody priced this product, and averaging it
      -- as free would halve the cost of everything they had not got to.
      if v_prior_qty <= 0 or v_product.cost_cents is null then
        v_new_cost := v_cost;
      else
        v_new_cost := round(
          (v_prior_qty::numeric * v_product.cost_cents + v_qty::numeric * v_cost)
          / (v_prior_qty + v_qty)
        );
      end if;

      update public.products set cost_cents = v_new_cost, updated_at = now() where id = v_product.id;
    end if;
```

**`stock_receipt_items.unit_cost_cents` keeps the DELIVERY's price, not the new average.** It is the record of what that delivery cost, and rewriting it to the average would destroy the only evidence the average was computed from.

> **Two lines for the same product in one receipt must compound.** The loop already orders by `(value->>'product_id'), ord`, so they run in sheet order — and because `v_prior_qty` is read fresh each iteration, the second line averages against the first line's result. Do not hoist that read out of the loop.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test:db`
Expected: `verify-weighted-average  pass`, **18 database checks passed**.

- [ ] **Step 5: Prove the test can fail**

Mutation: restore `v_new_cost := v_cost;` unconditionally. Expected: check 2 fails with **2000**. Revert.

Mutation: read `v_prior_qty` **after** the upsert. Expected: check 2 fails with **1200**. Revert.

> This is the mutation the first draft of this plan could not catch — its fixture gave 1414 whether or not the delivery was double-counted. If it does not redden check 2, the quantities have been changed and the check is worthless.

Mutation: read only the receiving location's stock rather than summing across locations. Expected: check 4 fails with **2000**. Revert.

Mutation: treat a null prior cost as 0 — `coalesce(v_product.cost_cents, 0)`. Expected: check 5 fails. Revert.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/20260907000000_moving_weighted_average.sql supabase/tests/verify-weighted-average.sql
git commit -m "fix(inventory): value stock at a weighted average, not the latest price paid"
```

---

### Task 2: What happens to the costs that already exist

**Files:**
- Modify: `supabase/migrations/20260907000000_moving_weighted_average.sql` (header only)

**No backfill, and the header has to say why.**

Every existing `products.cost_cents` is the price of whatever arrived most recently. There is **no way to restate it** as a weighted average: doing so needs the quantity and price of every delivery that built the current stock, and `stock_receipt_items` only goes back as far as receipts have been recorded — which for most shops is not far, and for stock that predates the feature is nowhere.

So the existing figure becomes the **opening average**, and the formula applies from the next delivery forward.

- [ ] **Step 1: Write the header section**

Add to the migration's header:

```
-- ## The costs that already exist are not restated
--
-- Every products.cost_cents today is the price of whatever arrived last. It
-- cannot be restated as a weighted average: that would need the quantity and
-- price of every delivery behind the current stock, and stock_receipt_items
-- only reaches back as far as receipts have been recorded -- which for stock
-- predating the feature is nowhere at all.
--
-- So the existing figure is taken as the opening average and the formula runs
-- from the next delivery forward. This is the ordinary treatment for a change
-- in accounting estimate: applied prospectively, and disclosed rather than
-- discovered. Task 3 puts the disclosure on the screens that show a value.
--
-- In practice it converges quickly. Each delivery pulls the average toward the
-- true figure in proportion to its share of stock on hand, so a shop turning
-- its stock every few weeks is on a real average within a month or two.
```

- [ ] **Step 2: Verify and commit**

Run: `npm run test:db`
Expected: unchanged, **18 pass** — a comment changes nothing.

```bash
git commit -m "docs(inventory): why existing costs are not restated"
```

---

### Task 3: The disclosure

**Files:**
- Modify: `src/components/accounting/ledger/chart-of-accounts-view.tsx` — no
- Modify: whichever screens show a stock value. At time of writing that is **Inventory** (`src/app/(admin)/(tabs)/inventory.tsx`) and any report showing stock at cost.

**IAS 2.36(a) requires disclosing the cost formula used.** With one formula that is a constant string, not a column or a toggle.

- [ ] **Step 1: Find every screen that shows a stock value**

```bash
grep -rn "costCents\|cost_cents" src/components src/app --include=*.tsx | grep -iE "stock|value|inventor"
```

Add to each, as a `Caveat tone="context"` where the screen has one, or as a footnote line where it does not:

> Stock is valued at weighted average cost.

- [ ] **Step 2: Verify and commit**

Run: `npx tsc --noEmit && npm test && npm run lint`
Expected: clean; 139 suites / 2122 tests; **81** lint — no new data-loading view, so no new mount effect.

```bash
git commit -m "feat(inventory): say which cost formula the stock value uses"
```

---

### Task 4: Prove it end to end

- [ ] **Step 1: Full suite**

Run: `npx tsc --noEmit && npm test && npm run lint && npm run test:db`
Expected: clean; 139 suites / 2122 tests; 81 lint; **18** database checks.

- [ ] **Step 2: In the running app**

Receive the same product twice at different prices through the Restock flow, and check the product's cost lands **between** the two rather than on the second.

> **`browser_click` gives false negatives on this app.** Playwright's click does not deliver the pointer sequence React Native Web's `Pressable` needs — it silently does nothing, including on pre-existing controls. Dispatch the full `pointerdown` / `mousedown` / `pointerup` / `mouseup` / `click` sequence.

- [ ] **Step 3: Check the margin reports still read sensibly**

Item Performance and any gross-margin figure read `sale_items.unit_cost_cents`, which is frozen at sale time and is **not** touched by this change. Historical margins are unaffected; only sales made after this lands use the averaged cost. Confirm nothing moved that should not have.

---

## What this unblocks

**Phase 2b — posting to the ledger** — becomes the next work, and it can now post a COGS figure computed on a formula IAS 2 permits. That was the real blocker; it was never FIFO specifically.

## If FIFO is wanted later

The design and plan are merged — [#65](https://github.com/yshaqalle/kaiibi/pull/65) and [#68](https://github.com/yshaqalle/kaiibi/pull/68) — and the branch `fifo-layers` carries a completed Task 1. Cost layers would then be an upgrade rather than a prerequisite, and this plan's arithmetic is what they would replace.

The triggers worth watching, from the parent design: an external reader specifying FIFO; slow-moving high-value stock in a volatile currency; per-batch expiry becoming a real requirement; or a group parent imposing a uniform policy.
