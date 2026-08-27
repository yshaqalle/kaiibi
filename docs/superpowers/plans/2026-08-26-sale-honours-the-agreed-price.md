# A Sale Honours the Price the Customer Agreed To

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A storefront order completes at the price and tax the customer was quoted, instead of being re-priced at the till's current prices and refused.

**Architecture:** Two optional parameters on `complete_sale`. Omit them and it behaves exactly as it does today — the register's path must not shift by a cent. Supply them and the sale is filed at the agreed line prices with tax already inside the quoted total.

**Tech Stack:** Supabase Postgres, psql verify scripts, Jest.

## Why this exists

Plan 4 shipped fulfilment with a limitation stated plainly in its PR: **a shop with tax enabled, or one that reprices an open order, cannot complete a storefront order at all.**

The root cause is one sentence: **`complete_sale` was built for a till, where the right price is the price right now. An order is a promise made earlier.**

Concretely, in `supabase/migrations/20260908000300_sale_entry_date.sql`:

- `:363` — `v_line := v_product.price_cents * v_qty - v_line_discount`, and `:372` files `v_product.price_cents` as the line's `unit_price_cents`. Whatever the caller passed is discarded.
- `:450-453` — `v_tax_cents := round(v_total_cents * v_tax_rate / 100)` and then `v_total_cents := v_total_cents + v_tax_cents`. Tax is added **on top**, but the storefront quotes tax-exclusive totals, so the numbers disagree and completion is refused.

Both currently fail *safely* — nothing posts at a price the customer never agreed to — but a tax-charging shop simply cannot use the storefront, and any repricing strands open orders.

## This edits the function the register depends on

`complete_sale` is the POS's main write path. Every counter sale in every shop goes through it. That is a different risk class from anything in the storefront series, and it is why this is its own branch rather than part of plan 4.

**The governing rule: a call that passes neither new parameter must produce byte-identical results to today** — same totals, same `sale_items` rows, same journal entry, same stock movement, same errors. Everything below is subordinate to that.

## Global Constraints

- Migrations are `YYYYMMDDHHMMSS_name.sql`. **This plan uses the `20260929*` series.** Run `ls supabase/migrations | sed 's/_.*//' | sort | uniq -d` and confirm it is empty before committing — an earlier plan lost a task to a timestamp another branch's fix wave had taken.
- **This repo reproduces `complete_sale` whole rather than patching it.** It has been redefined in full several times (`20260831000100`, `20260908000200`, `20260908000300`). Follow that: copy the current body forward and change what you must, so the file is readable on its own.
- **`security definer` functions must `revoke execute … from public` BEFORE granting.** Postgres grants EXECUTE to PUBLIC by default. Convention: `supabase/migrations/20260924000100_storefront_public_read.sql:103-109`.
- **DB tests:** `npm run test:db`, `-- --no-reset` while iterating. The local stack is shared and reset often. If `supabase db reset` fails with `error running container: exit 1`, that is accumulated Docker state — `docker rm -f` plus `docker volume rm` on the kaiibi containers clears it; a plain stop/start does not.
- **Unit tests:** `npm test`. A fresh worktree shows phantom `tsc` errors until `.expo/types/router.d.ts` exists — run the dev server once to generate it before believing a tsc failure.

## Two interactions the plan must decide, not discover

**1. Promotions.** `:351-353` compute the expected discount from `v_product.price_cents`. If a caller passes an agreed price, a promotion computed against the *current* price would apply a discount the customer never saw — or fail its own tamper check.

**Decision: an agreed-price line takes no promotion.** The customer was quoted a figure and accepted it; retroactively applying a counter promotion changes what they agreed to, in either direction. If a promotion was running when they ordered, it was already in the price they saw. Task 2 must make passing both an agreed price and a promotion on the same line an explicit error rather than a silent precedence rule.

**2. Loyalty points.** `:447` earns points on `v_total_cents`. That figure changes when tax moves inside the total rather than sitting on top. Decide deliberately whether a pre-quoted sale earns points on the tax-inclusive or tax-exclusive figure, match whatever the till does for an equivalent sale, and write the reasoning down.

## Task 1: Pin today's behaviour before changing anything

You cannot prove you did not move the register unless you first record where it stands.

**Files:** Create `supabase/tests/verify-complete-sale-baseline.sql`

**Properties:**

1. Characterise the CURRENT behaviour of `complete_sale` for the paths this plan touches: a plain sale; a sale at a shop with tax enabled; a sale with a line discount; a sale with a promotion; a sale with loyalty redemption. Assert the exact resulting totals, `sale_items` rows and journal lines.
2. These checks must pass **before** any change in this plan and **unchanged after every task in it**. They are the regression net for the till.
3. Assert values, not shapes. `total_cents = 2400` catches a drift that `total_cents > 0` does not.

- [ ] **Step 1: Write the checks against today's function**
- [ ] **Step 2: Run them — they must PASS immediately**, since they describe what already happens. If one fails, you have mis-described the current behaviour; fix your expectation, not the function.
- [ ] **Step 3: Commit** — `git commit -m "test(pos): pin complete_sale's current behaviour before changing it"`

## Task 2: Honour an agreed line price

**Files:** Create `supabase/migrations/20260929000000_complete_sale_agreed_price.sql`; extend `supabase/tests/verify-complete-sale-baseline.sql`

**Properties:**

1. A per-line optional agreed unit price. When absent, the line prices from `products.price_cents` exactly as today.
2. When present, the line is filed at that price: `sale_items.unit_price_cents` and `line_total_cents` reflect it.
3. **`unit_cost_cents` still comes from the product's CURRENT cost.** Cost is what the shop actually paid, not part of what was quoted — changing it would misstate COGS. Do not touch it.
4. **An agreed price plus a promotion on the same line is an error**, per the decision above. Name it so a client can explain it.
5. A negative or absurd agreed price is refused. It arrives from a caller, so it is input, not truth.
6. **A call passing no agreed price is byte-identical to today.** Task 1's checks prove it.

- [ ] **Step 1: Write the failing checks** — a line at an agreed price files at that price; the same call without one is unchanged; agreed-price-plus-promotion raises; a negative agreed price raises.
- [ ] **Step 2: Run and watch them fail**
- [ ] **Step 3: Write the migration**, reproducing `complete_sale` whole
- [ ] **Step 4: Run Task 1's baseline checks — every one must still pass unchanged**
- [ ] **Step 5: Prove the grant** red-then-green: revoke execute from `authenticated`, confirm RED, restore, confirm GREEN
- [ ] **Step 6: Run the FULL DB suite** — you have just edited the register's write path
- [ ] **Step 7: Commit**

## Task 3: Accept a tax-inclusive quoted total

**Files:** Create `supabase/migrations/20260929000100_complete_sale_quoted_tax.sql`; extend the checks

**Properties:**

1. An optional flag saying the prices supplied already include tax. Absent, tax is added on top exactly as today (`:450-453`).
2. When set at a tax-charging shop, the tax is **extracted from** the quoted total rather than added to it, so the customer pays the figure they were shown. The sale still records a tax amount — the shop owes it regardless of how it was quoted.
3. Rounding is defined and asserted. Extracting tax from a total is not the inverse of adding it, and a cent that appears or vanishes on every order is a real reconciliation problem.
4. At a shop with tax disabled, the flag changes nothing.
5. Loyalty points follow the decision recorded in this plan's preamble.
6. **A call without the flag is byte-identical to today.**

- [ ] **Step 1: Write the failing checks**, including the rounding boundary — pick a total where naive extraction and naive addition disagree by a cent, and assert which one is right.
- [ ] **Step 2: Run and watch them fail**
- [ ] **Step 3: Write the migration**
- [ ] **Step 4: Run Task 1's baseline checks — all must still pass unchanged**
- [ ] **Step 5: Run the FULL DB suite**
- [ ] **Step 6: Commit**

## Task 4: Let fulfilment use them

**Files:** Modify `supabase/migrations/` with a new `20260929000200_complete_storefront_order_agreed.sql`; extend `supabase/tests/verify-order-transitions.sql`

**Properties:**

1. `complete_storefront_order` passes each line's snapshotted `unit_price_cents` as the agreed price, and marks the total tax-inclusive. The order's own numbers become authoritative.
2. **A repriced product no longer blocks completion.** That was the whole point.
3. **A tax-charging shop can now complete a storefront order.** Also the point.
4. The `order_total_changed` guard stays, but its meaning narrows: it should no longer fire for tax or for repricing. Work out what it still legitimately catches, keep it for that, and re-found its test — plan 4's check 34 proved refusal on a moved total and will need rebuilding.
5. **The per-line escape route must close.** Plan 4's review noted that two lines moving in opposite directions by equal amounts pass a total-only check, so a sale could post at per-line prices the customer never agreed to while the total tied. With agreed prices honoured this stops being reachable — add a check that proves it, using exactly that fixture.
6. The delivery fee's `4300` entry is unchanged. If a delivery-fee parameter is ever added to `complete_sale`, the fourth UNION branch in `delete_sale` (`20260928000400`) must go with it or the fee reverses twice — do NOT add one here.

- [ ] **Step 1: Write the failing checks**, including the opposite-direction-reprice fixture
- [ ] **Step 2: Run and watch them fail**
- [ ] **Step 3: Write the migration**
- [ ] **Step 4: Run the FULL DB suite**
- [ ] **Step 5: Commit**

## Task 5: Browser verification

**Not optional.** Seven defects across the storefront series shipped through a green suite and were caught only here.

Use `.superpowers/sdd/reseed.sh`, and check:

- [ ] Place a storefront order, then **reprice the product** in Inventory, then complete the order. It completes, and the sale carries the price the customer agreed to — not the new one.
- [ ] Turn tax on for the shop. Place and complete a storefront order. It completes, the customer's total is what they were quoted, and the sale records tax.
- [ ] Confirm in the database that the journal entry balances and the tax lands where the till puts it.
- [ ] **Ring up an ordinary counter sale.** It must behave exactly as before — this is the check that matters most, because it is the path every shop uses every day.
- [ ] Screenshot both and attach to the PR.

## Done when

- `npm test`, `npm run test:db` and `npx tsc --noEmit` all pass.
- Task 1's baseline checks pass **unchanged** from before this branch to after it.
- A tax-charging shop can complete a storefront order.
- A repriced product does not strand an open order.
- The till is provably untouched.

## Not in this plan

| Left out | Why |
|---|---|
| A delivery-fee parameter on `complete_sale` | Plan 4's route B works and is reversed correctly. Adding one means removing `delete_sale`'s fourth UNION branch in the same migration or the fee reverses twice. Separate change, separate review. |
| Refunding the delivery fee | Deliberately deferred at `20260928000400:33-40`. "Does returning one item out of a five-item delivery refund the trip?" is a product question, not a schema one. |
| Online payment | `payment_mode` still permits one value. |
