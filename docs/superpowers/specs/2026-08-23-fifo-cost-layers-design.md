# FIFO cost layers — design

**Date:** 2026-08-23
**Parent:** [`2026-08-22-accounting-standards-design.md`](2026-08-22-accounting-standards-design.md) — this is **phase 2a**
**Depends on:** phase 1a ([#63](https://github.com/yshaqalle/kaiibi/pull/63), merged) and 1b ([#64](https://github.com/yshaqalle/kaiibi/pull/64))

## The problem

Kaiibi keeps **one `cost_cents` per product**, overwritten every time stock arrives. That is a weighted average, and it is a legitimate basis — but it cannot answer "what did *these* units cost", so FIFO is impossible and the balance sheet values stock at a number that drifts from what was actually paid.

The parent design settled that we build cost layers. This spec is how.

**Why it comes before auto-posting.** Phase 2b makes `complete_sale` post COGS to the ledger. If it posts weighted-average COGS for a few weeks and FIFO after, the ledger carries a discontinuity nothing can explain. Layers first, then posting.

## What already exists, and is reused

| Thing | Where | Reused for |
|---|---|---|
| Per-line cost frozen at sale time | `sale_items.unit_cost_cents` | The number layers will now produce |
| Stock receipts, with per-line cost | `stock_receipts`, `stock_receipt_items`, `receive_stock()` | The layer writer |
| Stock-take with frozen cost | `stock_counts`, `save_stock_count()` | Layer consumption on a downward variance |
| Transfers between locations | `transfer_stock()` | Moving layer quantity between locations |
| Refunds return goods | `refund_sale_items()` | Layer restoration |
| Uncosted is null, never zero | `isUncosted()`, `product-costing.ts` | Provisional layers |
| Per-location stock | `product_location_stock` | Layers are per location |
| Deadlock-safe loop ordering | `receive_stock:131`, `transfer_stock:145`, `save_stock_count:189`, `refund_sale_items:148` | The pattern `complete_sale` must adopt — see below |

## The finding that reshapes this phase

**`complete_sale` does not order its item loop, and every sibling RPC does.**

```sql
-- complete_sale, lines 225 and 644 — no ORDER BY
for v_item in select * from jsonb_array_elements(p_items) loop
```

It then takes `select ... for update` on `product_location_stock` in **cart order**. Two tills selling the same two products in opposite cart order can already deadlock today.

Every other stock RPC orders its loop and says why. `receive_stock:131` is explicit: *"Ordered by product id so two concurrent receipts touching the same products take their row locks in the same order and cannot deadlock — the same reason transfer_stock and refund_sale_items order their loops."*

This is a **pre-existing latent bug**, not one layers introduce. But layers make it far likelier to fire: each line goes from locking one `product_location_stock` row to locking that plus every open layer it consumes, and holds them longer.

**Therefore: fixing `complete_sale`'s lock ordering is the first task of this phase, shipped and verified on its own, before any layer table exists.** It is independently correct, independently testable, and reviewable without the rest.

## Decisions

Settled in the parent design, restated because this spec is what gets implemented against:

**Layers are per location.** Kaiibi reports profit per location, and a shop-wide pool would let a Bakaara sale consume a delivery sitting in Hodan. The cost: a transfer must move layer quantity carrying its cost, or moving stock silently reprices it.

**Weighted average stays the default.** Layers produce both figures — weighted average is the layers averaged — so the method is a per-shop setting, not an architecture commitment. Existing shops keep the numbers they have; nobody's margin moves on migration day.

**Consumption order is FIFO, not FEFO.** First-expiring-first would change COGS semantics and is its own decision. The table supports it later by changing one `ORDER BY`.

**Layers carry `expires_on` and `batch_number`, which the accounting never reads.** `products.expiry_date` has the same one-value-per-product defect that `cost_cents` has, and a layer *is* a delivery. Not speculative: `getExpiringProducts()` is the waiting consumer. Populating them here means the expiry fix later needs no second pass over `complete_sale`.

New to this spec:

**A sale line records which layers it drew from.** `inventory_cost_consumption`, one row per (sale_item, layer) pair. Needed for three things: refunds restoring units at the price they left at, `sale_items.unit_cost_cents` being explainable after the fact, and phase 2b posting COGS it can defend.

**`sale_items.unit_cost_cents` becomes the weighted average of the layers that line consumed.** It stays a single integer, because every existing report reads it and the column's meaning — "what this line cost" — is unchanged. A line spanning two layers at 14.50 and 14.90 records the blend. The per-layer detail lives in the consumption table for anyone who needs it.

**Rounding lands on the last layer of a line.** Splitting 3 units across layers can leave a cent unallocated. It goes to the final layer consumed rather than being spread, so the consumption rows always sum exactly to the line's cost and nothing has to reconcile a rounding drift later.

**A count that finds MORE stock creates a layer at the frozen `unit_cost_cents`.** Not at current cost: the count froze a cost for exactly this reason, and using today's would value found stock at a price it was never bought for.

## The two tables

```
inventory_cost_layers
  id, shop_id, product_id, location_id
  unit_cost_cents      integer, null when the product is uncosted
  quantity_received    integer > 0
  quantity_remaining   integer >= 0, <= quantity_received
  source               'receipt' | 'opening' | 'count' | 'return' | 'transfer' | 'provisional'
  source_id            uuid, nullable
  expires_on           date, nullable — accounting never reads it
  batch_number         text, nullable — accounting never reads it
  is_provisional       boolean
  received_at          timestamptz
```

```
inventory_cost_consumption
  id, sale_item_id, layer_id
  quantity             integer > 0
  unit_cost_cents      integer, null where the layer was uncosted
```

Both behind `security definer` RPCs with **no write policy**, the posture `receive_stock`, `save_stock_count` and the ledger tables all take.

**Index:** `(shop_id, product_id, location_id, received_at, id) where quantity_remaining > 0`. Every consumption is that lookup, and the partial predicate keeps exhausted layers out of a table that only ever grows.

## Consumption

```
consume_layers(shop, product, location, qty) returns (unit_cost_cents, [(layer, qty, cost)])
```

1. Select open layers for that product and location, `order by received_at, id`, **`for update`**.
2. Draw from each in turn until the quantity is met.
3. If layers run dry before the quantity is met, create a **provisional layer** for the shortfall.
4. Return the blended unit cost and the per-layer breakdown.

**The lock order is `received_at, id` and must be identical in every caller.** `id` is the tiebreaker for two layers received in the same microsecond — `received_at` alone is not a total order, and without a tiebreaker two concurrent sales can order the same two layers differently and deadlock. This is the same reasoning `receive_stock:131` gives for adding ordinality behind product id.

### Selling stock with no layer

Kaiibi lets a sale through when stock is zero or unknown, so consumption can find nothing to draw from. Silently using zero cost would overstate profit on exactly the sales nobody is watching.

Instead: consume what exists, then create a **provisional layer** for the shortfall at the product's last known `cost_cents`, flagged `is_provisional`. When stock next arrives, the provisional is trued up and the difference posts to `5100`. Inventory Valuation shows how much of the value is provisional, because a figure that is partly a guess should say so.

Where the product's cost is **null** — genuinely uncosted — the layer is created with a null cost and the sale line records no cost, matching `isUncosted()`'s position that null and zero are different answers.

## The four writers

| RPC | Change |
|---|---|
| `receive_stock` | **Creates** a layer per line. Already ordered; already has the per-line cost. |
| `complete_sale` | **Consumes.** Ordering fixed first (task 1). `unit_cost_cents` becomes the blend rather than `v_product.cost_cents`. |
| `save_stock_count` | **Both.** A count *sets* stock: downward variance consumes oldest-first like a sale, upward creates a layer at the frozen cost. |
| `refund_sale_items` | **Restores.** Reads `inventory_cost_consumption` and puts each unit back on the layer it came from. |
| `transfer_stock` | **Moves.** Layer quantity crosses locations carrying its cost, or moving stock reprices it. |

Five, not four — `transfer_stock` was missed in the parent design's count.

### Refund restoration

A refund returns units to the layers the sale drew them from, in reverse. Not a new layer at current cost: that would let a sell-then-refund cycle silently reprice stock, and the units physically are the ones that left.

Where the original layer has since been exhausted and removed from the working set, the quantity is restored to it anyway — `quantity_remaining` simply rises from zero. The layer row is never deleted, which is what makes this possible.

## The migration

**One opening layer per product per location**, quantity = current `product_location_stock.stock`, cost = current `products.cost_cents`, `source = 'opening'`, `received_at` = the migration timestamp.

**FIFO applies from that moment forward. History is not restated** — there is no delivery history to build layers from. That is the correct treatment for a change in valuation method, and the Inventory Valuation screen states the basis and the date so it is a disclosed fact rather than something discovered.

Products with null cost get a null-cost opening layer, not a zero one.

## Verification

`supabase/tests/verify-cost-layers.sql`, following `verify-ledger.sql`'s shape. The checks that matter:

- A sale spanning two layers draws from the older first and blends the cost correctly
- The consumption rows for a line sum to exactly the line's cost — no rounding drift
- A refund restores to the original layer, and stock value returns to what it was before the sale
- A count down consumes; a count up creates at the frozen cost
- A transfer moves quantity and cost, and the two locations' values sum to what one location held before
- Selling into a shortfall creates a provisional layer, and truing it up posts the difference
- **A concurrency test that runs genuinely parallel sales** and asserts neither deadlocks nor over-consumes. This cannot be a unit test and cannot be skipped — it is the risk this whole phase carries.

## Risks

**Concurrency, and it is the reason this phase is separate.** Two tills selling the same product both reach for the oldest layer. Without consistent `FOR UPDATE` ordering one over-consumes; with careless ordering they deadlock and the POS stops taking money. Mitigated by fixing `complete_sale`'s ordering first, using one ordering everywhere, and testing with real parallel transactions.

**Write volume on the hottest path.** A 20-line sale may touch 40+ layer rows inside the transaction that already writes the sale, its items and its payments — and in 2b, a journal entry too. Needs the partial index above and a measured before/after on a realistic basket.

**The opening migration runs over every product in every shop.** One insert per product per location. Needs to be batched and to be re-runnable.

## Out of scope

| Not doing | Why |
|---|---|
| Auto-posting COGS to the ledger | Phase 2b. This phase changes what the cost *is*, not where it is recorded. |
| FEFO consumption | Changes COGS semantics; own decision. One `ORDER BY` when wanted. |
| Rewriting `getExpiringProducts()` | Keeps reading `products.expiry_date` and keeps working. Per-batch expiry is a follow-on that layers make cheap. |
| Batch entry UI | Capturing a batch on receipt is an inventory change, not an accounting one. |
| Restating historical COGS | No delivery history exists to build it from. |

## Open

**Nothing blocking.** Two things to confirm before the plan is written:

- **Provisional layers are worth their complexity.** The alternative is refusing a sale with no stock, which is not acceptable in a shop that sells from a shelf the app has not caught up with. Recommended as designed, but it is the piece a reviewer is most likely to want simplified.
- **Whether `sale_items.unit_cost_cents` staying a single blended integer is right.** It keeps every existing report working. The alternative — making the consumption table the only truth — means touching every report that reads that column. Recommended as designed.
