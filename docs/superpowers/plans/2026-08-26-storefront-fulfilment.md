# Storefront Fulfilment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A shop works the orders customers placed — accepts them, marks them ready, and records them as collected or delivered — and that last step is what turns an order into a `sale` that reaches the books.

**Architecture:** Four states a shop moves an order through, of which exactly one touches the ledger. Completion calls the existing `complete_sale` RPC rather than a second posting path, so an online order and a counter sale land in the books identically. The delivery fee gets its own revenue account, because it carries no cost of sales and folding it into goods revenue flatters gross margin.

**Tech Stack:** Expo SDK 57 / Expo Router, Supabase Postgres + RLS, Jest with `react-test-renderer`, psql verify scripts.

## Read this before writing anything

Plans 1–3 shipped fourteen defects between them. Every Critical came from a plan's own example code rather than implementer error, and five were found only by opening a browser. Three rules, binding:

1. **Code blocks marked *illustrative* are a starting point, not a specification.** Where a step states a PROPERTY, satisfy the property and write the guard yourself. Test code is the exception — use it exactly.
2. **Every repo fact below carries a `file:line`, verified 2026-08-26.** If a citation does not match what you find, stop and report rather than adapting silently.
3. **A grant is not verified until something has been denied by its absence.** Three grants on this feature shipped looking correct and doing nothing. Every privilege added here must be proven red-then-green.

## Global Constraints

- **Expo SDK 57.** Read `https://docs.expo.dev/versions/v57.0.0/` before writing framework code (`AGENTS.md`).
- **The orders screens are admin screens, so they are bento**: grey page, borderless 26px white cards, `const theme = Colors.light` pinned, tokens from `src/constants/theme.ts`, never a hex literal. Read `.claude/skills/building-bento-screens/SKILL.md`. **Grid for glancing, flow for scanning** — an order list is read down a column, so it is a full-width `DataTable` outside the grid.
- **`security definer` functions must `revoke execute … from public` BEFORE granting.** Postgres grants EXECUTE to PUBLIC by default. Convention: `supabase/migrations/20260924000100_storefront_public_read.sql:103-109`.
- Migrations are `YYYYMMDDHHMMSS_name.sql`. **This plan uses the `20260928*` series.** Check `ls supabase/migrations | sed 's/_.*//' | sort | uniq -d` is empty before committing — plan 3 lost a task to a timestamp already taken by an earlier plan's fix wave.
- **Unit tests:** `npm test`. **DB tests:** `npm run test:db`, and `-- --no-reset` while iterating: the local stack is shared with another session that resets it often. If `supabase db reset` fails with `error running container: exit 1`, that is accumulated Docker state — `docker rm -f` plus `docker volume rm` on the kaiibi containers clears it; a plain stop/start does not.
- Component tests use `react-test-renderer` with a `textsIn` helper. `@testing-library/react-native` is NOT a dependency. Pattern: `src/components/__tests__/list-card.test.tsx:1-11`.
- Money: `formatCents` (`src/lib/currency.ts:9`). Never `formatCompactCents` for a price — it drops the cents.

## The three facts that shape this plan

**1. `complete_sale` enforces stock, and plan 3 deliberately reserved none.**

`complete_sale` raises `insufficient stock for % at this location: has %, need %` (`supabase/migrations/20260908000300_sale_entry_date.sql:294-299`) and decrements `product_location_stock` (`:368`). Plan 3 chose not to reserve stock at order time, because reserving on add-to-cart lets anyone empty a shop's shelves from a browser — so **an order can legitimately exist for more than the shop now holds.**

That collision is this plan's central design problem, not an edge case. A shop that sold the last kettle at the counter this morning will hit it. Completion must fail in a way the shop can act on, and the shop must be able to fix the order rather than being stuck.

**2. `complete_sale` does not need a register.** `p_register_session_id` defaults to null (`:92`) and every register check is inside `if p_register_session_id is not null` (`:205-217`). A storefront order is fulfilled with no cashier at a till, and that is already permitted. Similarly `p_location_id` defaults to the shop's primary location (`:182-191`).

**3. There is no account for delivery income, and `complete_sale` has no notion of a delivery fee.**

The chart of accounts seeds `4000 Sales Revenue`, `4100 Sales Returns`, `4200 Discounts Given` and nothing else in the 4000s (`supabase/migrations/20260904000100_chart_of_accounts.sql:90-92`). `post_complete_sale` builds journal lines with literal codes — `'code', '4000'` (`supabase/migrations/20260908000200_post_complete_sale.sql:584`).

`complete_sale` takes items and payments. A delivery fee is neither. **Task 4 must decide how the fee reaches the ledger, and the plan does not pretend the answer is obvious** — see that task.

## What plans 1–3 already provide

| From | Objects |
|---|---|
| DB | `orders` (status `pending`/`accepted`/`ready`/`completed`/`cancelled`, default `pending` — `20260926000050_orders.sql:103-104`), `order_items` (snapshotted name and unit price), `order_number_counters` |
| DB | `place_storefront_order` — the anonymous insert (`20260927000000_place_order.sql`) |
| `src/lib/storefront-admin.ts` | `listOrders` and the shop-side data layer |
| `src/app/(admin)/orders.tsx` | The read-only list, bento, gated on `settings.access` and the `storefront` module |
| DB | `complete_sale(p_shop_id, p_items, p_payments, …)` returning the sale id (`20260908000300_sale_entry_date.sql:79-94`) |

---

### Task 1: `4300 Delivery Income`

**Files:** Create `supabase/migrations/20260928000000_delivery_income_account.sql`, `supabase/tests/verify-delivery-income.sql`

**Why it is its own account.** Delivery is revenue that carries **no cost of sales**. Posting it into `4000` inflates goods revenue with income that has no matching COGS and quietly flatters gross margin on every report the accounting work just built. A shop reading its own P&L would conclude its products earn more than they do.

**Properties:**

1. A `4300 Delivery Income` account of type `revenue`, seeded the same way `4000`/`4100`/`4200` are — read `20260904000100_chart_of_accounts.sql` and follow its seeding mechanism exactly, including how it handles a shop that already exists.
2. It is **not** a contra account. `4100` and `4200` are (`is_contra` true); delivery income is ordinary revenue.
3. Every existing shop gets it, not only new ones. A shop that has been trading for months must be able to take a delivery order the day this ships.
4. Re-running the migration must not duplicate it.

- [ ] **Step 1: Write the failing check** — assert the account exists for a pre-existing shop, has type `revenue`, is not contra, and that re-running the seed does not duplicate it.
- [ ] **Step 2: Run and watch it fail** — `npm run test:db -- --no-reset`
- [ ] **Step 3: Write the migration**
- [ ] **Step 4: Run and watch it pass**
- [ ] **Step 5: Commit**

---

### Task 2: The state machine, in the database

**Files:** Create `supabase/migrations/20260928000100_order_transitions.sql`, `supabase/tests/verify-order-transitions.sql`

**Properties:**

1. Permitted moves: `pending → accepted`, `accepted → ready`, `ready → completed`, and `pending|accepted|ready → cancelled`. Everything else is rejected, including a move backwards and a move out of `completed` or `cancelled`.
2. **Completion is not performed here.** This task owns the transitions that touch nothing; Task 4 owns `completed`, because that is the one that writes to the books. Make the constraint refuse a direct hop to `completed` so nobody can bypass Task 4's function.
3. A cancelled order records why, in the shop's own words, because the shop will be asked on the phone.
4. Only a member of the shop may move an order, and the shop must still have the `storefront` module. The function is `security definer`, so it checks both itself — RLS does not protect it. Use `public.is_shop_member` (`supabase/migrations/0018_staff_shop_access.sql:10`) and `public.shop_has_module` (`supabase/migrations/20260818000200_entitlement_resolution.sql:61`).
5. `revoke execute … from public` before granting to `authenticated`. Never `anon` — a customer does not move their own order.

- [ ] **Step 1: Write the failing checks**, including every rejected transition and both guards. Catch the SPECIFIC error class, not a bare `when others` — a handler that catches anything passes for the wrong reason.
- [ ] **Step 2: Run and watch them fail**
- [ ] **Step 3: Write the migration**
- [ ] **Step 4: Prove the grant** — revoke from `authenticated`, confirm RED, restore, confirm GREEN. Report both.
- [ ] **Step 5: Run and watch them pass**
- [ ] **Step 6: Commit**

---

### Task 3: What happens when the shop no longer has the stock

Read fact 1 above before starting. This task exists because plan 3 chose not to reserve stock, and that choice was right — the cost is paid here.

**Files:** Modify `src/lib/storefront-admin.ts`; create `src/lib/order-fulfilment.ts`; tests alongside

**Properties:**

1. Before a shop is offered "accept", it can see which lines it cannot currently satisfy, and by how much. Discovering it at completion, after telling the customer yes, is the failure this prevents.
2. The comparison is against real stock at the location the sale will be filed against — `product_location_stock`, which is what `complete_sale` actually checks (`20260908000300_sale_entry_date.sql:294-299`). Do NOT compare against `products.stock`: it is a **derived column** recomputed by a trigger (`20260810000000_stock_by_location.sql:168`), and plan 3 lost a test to exactly that mistake.
3. A shortfall is surfaced, never auto-resolved. The shop decides whether to source more, part-fill, or cancel — the app must not silently reduce a quantity a customer agreed to.
4. An order whose product has since been deleted must still be readable and still be cancellable. `order_items.product_id` is `on delete set null` with the name and price retained, so this is possible — make sure the code does not assume a product row exists.

- [ ] **Step 1: Write the failing test** covering a satisfiable order, one short by two units, one with a deleted product, and one at exactly the available quantity.
- [ ] **Step 2: Run and watch it fail**
- [ ] **Step 3: Implement**
- [ ] **Step 4: Run and watch it pass**
- [ ] **Step 5: Commit**

---

### Task 4: Completion, which is the only step that reaches the books

**Files:** Create `supabase/migrations/20260928000200_complete_storefront_order.sql`; modify `supabase/tests/verify-order-transitions.sql`

**Interfaces:** Produces `public.complete_storefront_order(p_order_id uuid, p_payment_method text) returns uuid` — the created sale id.

**The decision this task must make, stated openly.** `complete_sale` takes items and payments; a delivery fee is neither, and there is no parameter for it. Three routes:

- **A.** Pass the fee as a synthetic line item. **Rejected** — it would run through inventory and cost-of-sales logic as though it were a product, which is exactly the distortion `4300` exists to avoid.
- **B.** Post a separate, small journal entry for the fee alongside the sale. Contained, touches no shared function, but means an order's money reaches the books through two entries.
- **C.** Extend `complete_sale` with a delivery-fee parameter. Cleanest conceptually, but edits a function the register depends on, with a large blast radius.

**Start from B**, and say in a comment why A was rejected. If while implementing you find B cannot balance the entry or cannot tie the two records together, stop and report — that is a real finding and C may be right after all. Do not silently switch.

**Properties:**

1. Completion calls the existing `complete_sale` (`20260908000300_sale_entry_date.sql:79`) — **there must not be a second sale-posting path.** An online order and a counter sale must land in the ledger identically, or the two will drift.
2. It passes **no register session**. That is already permitted (fact 2) and correct: nobody was at a till.
3. The line items come from `order_items` — the **snapshotted** names and prices, not a fresh lookup. The customer agreed to those.
4. The payment method is what the shop actually took at the door. Record it; `complete_sale` reads the method from the payments payload (`:234`).
5. **The delivery fee is credited to `4300`, never `4000`.**
6. The order's status becomes `completed` and it records which sale it became, so the two can be reconciled later.
7. **A stock shortfall must surface as something the shop can act on**, not a raw Postgres exception. `complete_sale` will raise `insufficient stock for …`; catch it and re-raise a typed error the client can turn into a sentence.
8. Everything is atomic. A completion that posts a sale but leaves the order `ready`, or vice versa, is worse than one that fails cleanly.
9. `security definer` with membership and module checks of its own, `revoke … from public` before granting to `authenticated`, never `anon`.

- [ ] **Step 1: Write the failing checks.** Cover: a completed order becomes a sale; the sale's lines match the snapshot; the delivery fee lands in `4300` and NOT `4000`; the journal entry balances; a shortfall raises the typed error and leaves the order untouched; a non-member cannot complete; a de-entitled shop cannot complete.
- [ ] **Step 2: Run and watch them fail**
- [ ] **Step 3: Write the migration**
- [ ] **Step 4: Prove the grant** red-then-green
- [ ] **Step 5: Run and watch them pass** — and run the FULL DB suite, because you are calling a function the register also uses
- [ ] **Step 6: Commit**

---

### Task 5: Cancelling writes nothing to the books

**Files:** Modify `supabase/tests/verify-order-transitions.sql`

**Properties:**

1. Cancelling an order before completion **writes nothing to the ledger**: no money moved, no stock left the shelf, so there is nothing to reverse. Assert no journal entry appears.
2. A cancelled order keeps its lines and its reason — the shop may need to explain it weeks later.
3. **A completed order cannot be cancelled.** Once it is a sale, the way back is the existing refund path (`supabase/migrations/20260908000350_post_refund_and_settlement.sql`), not a status change — a cancellation that silently unposted a sale would leave the books wrong.

- [ ] **Step 1: Write the failing checks**
- [ ] **Step 2: Run and watch them fail**
- [ ] **Step 3: Make them pass** (Task 2's constraint may already cover part of this — if so, say which checks were already satisfied rather than adding code that does nothing)
- [ ] **Step 4: Commit**

---

### Task 6: The inbox

**Files:** Modify `src/app/(admin)/orders.tsx`; create `src/components/orders/order-detail.tsx`; tests alongside

**Properties:**

1. Tabs or filters for the states a shop works: new, accepted, ready, done, cancelled — with a count on the ones that need action.
2. **Add the status column plan 3 deliberately left out.** It was omitted because nothing could change status; now everything can, and without it a fresh order and a finished one look alike.
3. One order opens to a detail view showing everything a shop needs to act: the lines with snapshotted prices, the customer's name and phone, collect-or-deliver with the area **and the landmark**, the note, what to collect, and any stock shortfall from Task 3.
4. Actions match the state machine exactly — an order that cannot move to a state does not offer a button for it. A button that fails is worse than no button.
5. **Unconfirmed order value is never presented as revenue.** Plan 3's existing caveat wording is right; keep it true as states are added.
6. Completion asks how the customer paid before it posts, because that is what the payment method records.
7. This is bento. The list is a full-width `DataTable` outside the grid. `StatTile`, `Badge` and `CategoryChip` hardcode the cream palette and need a `bento` variant — do not drop them on a bento card and call it done.

- [ ] **Step 1: Write the failing test**
- [ ] **Step 2: Run and watch it fail**
- [ ] **Step 3: Implement**
- [ ] **Step 4: Run the FULL suite**
- [ ] **Step 5: Commit**

---

### Task 7: The shop finds out an order arrived

Plan 3's review flagged this: publishing is now, retroactively, consent to take orders. A shop that published under plans 1–2 starts receiving them the moment plan 3 merges, with no badge and no notification — it must think to open Settings → Orders. Real orders will be missed.

**Files:** Modify `src/components/settings/settings-sidebar.tsx` and whatever surfaces the shop sees first; tests alongside

**Properties:**

1. A shop with orders awaiting action can see that without opening the Orders screen.
2. The count is of orders **needing action**, not all orders — a badge that never clears is a badge people stop seeing.
3. Read the existing attention/notification machinery before adding a mechanism — `src/lib/attention.ts` exists. Use it if it fits rather than inventing a parallel one.
4. Gated on the `storefront` module like the rest, so a shop without it sees nothing.

- [ ] **Step 1: Write the failing test**
- [ ] **Step 2: Run and watch it fail**
- [ ] **Step 3: Implement**
- [ ] **Step 4: Run the FULL suite**
- [ ] **Step 5: Commit**

---

### Task 8: Browser verification

**Not optional.** Five defects across plans 1–3 shipped through a fully green suite and were caught only here: a product name printed twice, a missing page title, a Web address field showing a path where only a subdomain resolves, a basket button off-screen at phone width, and a checkout that hijacked every order into WhatsApp.

Use `.superpowers/sdd/reseed.sh`, place an order through the storefront, then at **390px and 1280px**:

- [ ] The new order appears with a status a shopkeeper can read.
- [ ] Accept it, mark it ready, complete it. Each button appears only when the state allows it.
- [ ] Completing asks how the customer paid.
- [ ] **Confirm in the database** that a `sale` was created, its lines match the order's snapshot, and the journal entry balances.
- [ ] **Confirm the delivery fee landed in `4300` and not `4000`.** This is the whole reason the account exists.
- [ ] Sell the last unit of a product at the POS, then try to complete an order needing it. The shop is told what is short — not shown a Postgres error, and not silently allowed through.
- [ ] Cancel an order and confirm **no journal entry** was written.
- [ ] Confirm a completed order offers no cancel button.
- [ ] The awaiting-action indicator appears and clears.
- [ ] Screenshot each and attach to the PR.

---

## Done when

- `npm test`, `npm run test:db` and `npx tsc --noEmit` all pass.
- A shop can take an order from placed to collected without SQL.
- Exactly one state writes to the books, through the same path the register uses.
- Delivery income is separable from goods revenue on the P&L.

## Not in this plan

| Left out | Why |
|---|---|
| Online payment | `payment_mode` still permits one value. |
| Partial fulfilment | An order is filled or it is not. Splitting one is a bigger idea than this plan. |
| Customer-facing order status | A number and a phone call. Adding accounts would put a signup wall in front of checkout. |
| Refunding a storefront order | Once completed it is an ordinary sale, and the existing refund path already covers it. |
| Pagination on the orders list | Carried from plan 3. Worth doing before a shop has a thousand orders, not before it has ten. |
