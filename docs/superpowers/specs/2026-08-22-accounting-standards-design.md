# Accounting and reporting on a general ledger — design

**Date:** 2026-08-22 · **revised 2026-08-23** against `main` after PR #62 (the Count door)
**Mockup:** [`docs/design/accounting-standards-mockup.html`](../../design/accounting-standards-mockup.html)

## The problem

Kaiibi's Accounting tab reports on money by summing seven unrelated tables. That works for
"what did we take last week" and fails for every question an accountant asks. The request was
for 10 accounting screens and 23 reports; **16 of those read a general ledger that does not
exist.**

Four structural gaps, all confirmed against the schema:

1. **No ledger, so nothing has to balance.** `sales`, `expenses`, `invoices`, `payroll_runs`,
   `cash_accounts`, `stock_receipts` and `refunds` are summed at report time. Nothing forces the
   sums to agree and nothing can detect it when they don't.
2. **Cash is typed, not derived.** `cash_accounts.balance_cents` is a manual snapshot — the
   migration says so outright. The shop's cash position and its transaction history are two
   independent claims that are never reconciled.
3. **Two non-expenses are filed as expenses.** `expenses.category` includes `inventory_purchase`
   and `owner_draw`. One buys an asset, the other reduces equity. `NON_OPERATING_CATEGORIES` in
   `src/lib/expense-reporting.ts` reaches the right net profit by excluding them — the right answer
   by the wrong route, and the reason a balance sheet is currently impossible.
4. **Posted records are editable.** `expenses` and `invoices` carry `updated_at`/`updated_by` and
   change in place. There is no shop-level audit trail; `platform_audit_log` is operator-side only.

## What already exists, and is reused unchanged

| Thing | Where | Reused for |
|---|---|---|
| Per-line cost frozen at sale time | `sale_items.unit_cost_cents`, `20260804000000_sale_item_cost_snapshot` | COGS — the matching principle, already correct |
| Stock-take with frozen cost and per-line reason | `stock_counts`, `stock_count_items`, `save_stock_count()`, `20260903000100` | Account 5100, Stock Movement Log, shrinkage posting |
| Pure expense roll-ups, testable without a client | `src/lib/expense-reporting.ts` | The P&L's expense side |
| Uncosted is null, never zero | `isUncosted()` in `src/lib/product-costing.ts` | Provisional cost layers |
| Sales tax treated as owed, not earned | `reports-tab.tsx` tax section | Account 2100 |
| Credit sales and settlement | `sale_balances`, `settle_sale_balance` | Account 1100, receivables reports |
| Refunds return goods, not cash by default | `20260831000200_refund_goods_not_cash` | Refund posting, layer restoration |
| Every money move goes through an RPC | `complete_sale`, `receive_stock`, `record_invoice_payment`, `post_payroll_run` | The seam the posting layer bolts onto — no call sites change |
| Stock receipts | `20260902000000_stock_receipts` | Cost layers, inventory posting |
| `reorder_level` per location | `20260810000000_stock_by_location` | Low Stock & Reorder — needs no new column |
| Loyalty ledger | `customer_points_ledger` | Account 2300, Loyalty Points Summary |
| Budgets | `budgets` | Budget vs Actual |
| Permission pattern | `has_shop_permission` | `ledger.view` / `ledger.post` / `ledger.close` |

## Decisions

Settled during brainstorming. Each is reversible; each is stated so a reviewer can disagree with
one line rather than the whole document.

**Build a real double-entry ledger, not a presentation layer.** `journal_lines` carries a deferred
constraint that each entry sums to zero, so an unbalanced entry cannot be written — including by a
bug. The alternative considered and rejected was approximating a balance sheet from the cash
snapshot plus inventory value; it produces authoritative-looking numbers that are wrong, which is
worse for a shop owner than not having them.

**Stock is valued at a true moving weighted average.** *Revised 2026-08-24 — this replaces a decision to build FIFO cost layers.*

Kaiibi does not currently use a permitted cost formula. `receive_stock` writes
`update public.products set cost_cents = v_cost`, replacing the cost with the newest delivery's
price — the migration's own comment calls it *"latest wins"*. Buy 200 bags at 14.10 and 10 at 14.90
and all 210 are valued at 14.90. That is replacement cost, and **IAS 2 does not permit it** for
assigning inventory cost.

IAS 2.25 permits exactly two formulas for interchangeable goods: FIFO and weighted average cost.
IFRS for SMEs §13.18 says the same. LIFO is permitted under US GAAP and banned under IFRS.

**Weighted average is chosen over FIFO**, for a market reason rather than a convenience one. Under
inflation FIFO draws COGS from the oldest and cheapest stock, which **raises reported profit and so
raises tax**; a blended average does not. In a high-inflation, volatile-currency market that is a
real cost, and the two formulas are equals under the standard so there is nothing to defend. It is
also the conventional choice for fungible goods — for rice and cooking oil, "which physical bag
left" is a fiction either way.

**Cost layers are not built.** The earlier design specified them, with the method as a per-shop
toggle. That was flexibility nobody had asked for: two tables, a rewrite of `complete_sale` and a
concurrency test, to offer a choice with one taker. The design and plan are written and merged
(#65, #68) and stay available — if FIFO is ever needed, layers become an upgrade rather than a
prerequisite.

**No basis setting is added either.** The only obligation is IAS 2.36(a), which requires disclosing
the formula used. With one formula that is a constant string on the report, not a column, a toggle
and a branch.

**When FIFO would become needed**, so the decision can be revisited on evidence rather than feel:
an external reader specifying it; slow-moving high-value stock in a volatile currency, where the
gap between the formulas widens as turnover falls; per-batch expiry becoming a real requirement,
which builds most of a layer table anyway; or a group parent imposing a uniform policy.

**Months close automatically, 10 days after they end.** A shop owner will not remember to close, and
a book that is never closed lets anyone edit any month forever — which is what closing exists to
prevent. Closing on the 31st would be wrong: August's electricity bill arrives in September. The
grace period is configurable (5/10/15) and the whole behaviour is switchable to "ask me" or "never".

**Auto-close runs the four adjustments the app can compute and closes even when the human checklist
is not clean.** Depreciation, accrued wages, loyalty liability revaluation and the roll to retained
earnings are automatic. Draft bills, stock counts and bank confirmation are flagged. A month closed
with items outstanding is marked **closed with exceptions** and names them. Refusing to close would
mean shops that never do stock counts never close a month.

**Closed and locked are different states.** Closed blocks normal posting but still permits an owner
to post an adjusting entry dated into the month; it is reversible and audited. Locked is manual,
deliberate and final. Without the middle state, a genuinely late bill has nowhere to go.

**Corrections are reversing entries, never edits.** Posted journals are immutable. Voiding writes a
mirror entry linked to the original with a stated reason. Both stay on the record.

**Shrinkage moves from operating expenses to cost of sales.** *Added 2026-08-23.* The Count door
shipped a twelfth expense category, `stock_loss`, and `save_stock_count()` writes an expense row for
the variance — the correct single-entry answer to a real problem the migration states well: a unit
that is stolen or breaks is never sold, so its cost never enters COGS by any path and gross profit
reads high by exactly that amount, every month, invisibly.

Under the ledger that category maps to `5100 Inventory Shrinkage`, which sits in **cost of sales,
above gross profit** — not in operating expenses where `stock_loss` lands today. Shrinkage is the
cost of goods that left the building without selling; gross margin should carry it, because a shop
losing 3% of stock does not have the margin its P&L currently claims.

**This is a visible presentation change:** gross profit falls, operating expenses fall by the same
amount, net profit is unchanged. It is a presentation choice under IAS 2, not a rule — if the
preference is to keep shrinkage in operating expenses, map 5100 into the opex group instead. One
line either way, but it should be a decision rather than a surprise.

**`save_stock_count()` becomes the fourth layer-mutating RPC.** *Added 2026-08-23.* A count **sets**
stock (`stock = excluded.stock`) where `receive_stock` adds. Under cost layers that means a downward
variance consumes layers oldest-first exactly as a sale does, and an upward variance creates a layer
at the frozen `unit_cost_cents`. It needs the same `FOR UPDATE` ordering as `complete_sale`, and it
was not in the original scope because the door did not exist when this was written.

**Refund reasons follow the Count door's shape, but are required.** *Revised 2026-08-23.*
`stock_count_items.reason` set the pattern: a closed enum, checked at the table. Refunds copy the
enum style but make it **required**, where counts deliberately made it optional. The count
migration's reasoning — "requiring a reason on every one of sixteen variances is how a 300-line
stock-take stops getting done" — turns on there being sixteen of them. A refund has one.

**`expenses` and `invoices` survive as source documents.** They hold the receipt, vendor, note and
paperwork; the ledger holds the accounting. Each gains `journal_entry_id`. The
`sync_invoice_expense` trigger — which mirrored invoices into expenses — is removed, because the
ledger now does that properly.

**Accounting becomes a hub, Reports becomes a hub.** 17 new destinations cannot become 17 more
pills. The pill row stays at 8: Overview, Transactions, Bills, Expenses, Payroll, Cash & Budgets,
**Accounting**, Reports. The last two are grids of launcher cards, each stating its default period
("7 days", "As of today", "This month", "Updated live") because a balance sheet over a date range is
meaningless and a sales report at one instant is useless.

**"Owed to you" is folded away.** It answered one question with a table that Aging Receivables
answers better, while occupying a pill. Its content becomes Customer Balance Summary and Aging
Receivables under Reports.

**Profit and Loss and Income Statement stay as two cards but are one query.** The descriptions
distinguish them usefully — a summary for the owner, full account detail for the accountant — so
both cards remain, driven by one query with a `detail` flag. Built as two reports they would
eventually disagree, and nobody would know which was right.

**Purchase Orders comes out of this project.** A PO commits nothing to the ledger — no asset, no
liability — until goods arrive, so it contributes nothing to accounting correctness. It is a
procurement workflow (draft, approve, send, receive partially, handle variance, close) wearing a
report's clothes, it is the only item on the list with zero existing data, and it would rework the
`stock_receipts` flow that shipped days ago. Bundled in, the balance sheet ships when procurement
ships. The card is removed rather than left showing a permanent empty state.

## Expiry — resolved 2026-08-23

The earlier version of this section recorded "no batch or expiry tracking in scope" as an
assumption. That was written without checking the schema, and it was wrong. **Expiry tracking
already exists** and has since `0001_init`:

- `products.expiry_date` and `products.batch_number` — one of each, per product
- `shops.expiry_tracking_enabled` (default **false**) and `expiry_warning_lead_days` (default 30),
  from `0030_inventory_alert_settings`
- `getExpiringProducts()` in `src/lib/products.ts`
- `'expired'` as a variance reason on `stock_count_items`

So the question was never whether to build it. It is that **the shipped version has exactly the
defect cost layers exist to fix**, and the parallel is precise:

| | One value per product | Overwritten by | Fixed by |
|---|---|---|---|
| `products.cost_cents` | the current cost | the next delivery | `inventory_cost_layers` |
| `products.expiry_date` | the current expiry | the next delivery | the same table |

Two deliveries of milk with different expiry dates cannot both be represented today. The second
overwrites the first, silently, and the alert then fires on the wrong date. A cost layer **is** a
delivery, which makes it the right home for a per-batch expiry.

**Decision: `inventory_cost_layers` carries a nullable `expires_on` and `batch_number`, populated by
`receive_stock`. Nothing in the accounting reads either.**

Not a speculative column — it has a waiting consumer in `getExpiringProducts()`. Explicitly **out of
scope**:

- **Consumption order stays FIFO, not FEFO.** Consuming first-expiring-first would change COGS
  semantics and is a separate decision. The layer table supports it later by changing one
  `ORDER BY`.
- **The expiry alerting is not rewritten.** `getExpiringProducts()` keeps reading
  `products.expiry_date` and keeps working. Upgrading it to per-batch is a follow-on inventory
  project that layers make cheap, not a rewrite this project performs.
- **No batch entry UI.** Capturing a batch on receipt is an inventory change, not an accounting one.

`expiry_tracking_enabled` defaulting to false matters: perishables are not universal across kaiibi
shops, so nothing here is forced on a shop that does not need it.

## Scope

### In

| Area | Ships |
|---|---|
| Ledger | `accounts`, `journal_entries`, `journal_lines`, `accounting_periods`, `accounting_audit_log`; balanced-entry constraint; seeded chart of accounts |
| Valuation | `inventory_cost_layers`, `inventory_cost_consumption`; per-shop basis setting; opening-balance migration |
| Posting | `complete_sale`, `refund_sale_items`, `settle_sale_balance`, `receive_stock`, `record_invoice_payment`, `post_payroll_run`, **`save_stock_count`** each gain a posting side; historical backfill |
| New RPCs | `post_journal_entry`, `reverse_journal_entry`, `create_bill`, `transfer_funds`, `create_fixed_asset`, `dispose_fixed_asset`, `run_depreciation`, `close_accounting_period`, plus report functions |
| Assets | `fixed_assets` register, straight-line depreciation posting monthly |
| Screens | Accounting hub (10 destinations), Reports hub (22 of 23 cards — Purchase Orders removed) |
| Small gaps | `refunds.reason` enum; `tax_filings` table |

### Out, with reasons

| Not doing | Why |
|---|---|
| Purchase Orders | Procurement workflow, not accounting. Own spec, after this. |
| Batch / expiry tracking | Revisit if perishables matter. With cost layers dropped there is no longer a cheap place to hang it, so it becomes its own piece of work. |
| LIFO | Not permitted under IAS 2. |
| Restating history onto FIFO | No delivery history exists to build layers from. A change of basis is disclosed, not backdated. |
| Multi-currency ledger | `shop_currencies` exists but one shop trades in one currency. Not raised, not assumed. |
| Dark mode for these screens | The app is light-only (`theme.ts`). Consistent with every other converted screen. |

## Architecture

### Chart of accounts

Seeded per shop by extending `seed_shop_defaults`. Full listing in the mockup. The structural point:
the **twelve**-value `expenses.category` enum becomes **nine expense accounts plus three accounts
that were never operating expenses** — `inventory_purchase` posts to `1200 Inventory`, `owner_draw`
to `3100 Owner's Draw` (contra-equity), and `stock_loss` to `5100 Inventory Shrinkage` (cost of
sales). That is what makes a balance sheet possible, and it turns `NON_OPERATING_CATEGORIES` from a
filter into a consequence of where each account sits.

### Posting map

Full table in the mockup. Every event that moves money already goes through an RPC, so the posting
side is added inside the existing function and no call site changes.

### Permissions

Three, following `has_shop_permission`:

- `ledger.view` — see the books and statements
- `ledger.post` — manual journal entries and bills; **owner by default**, because a free-form
  debit/credit form is the one screen that can put the books into a state nobody can explain later
- `ledger.close` — lock a period, change the valuation basis

Staff who can already record a sale need no new grant. The ledger posts underneath them.

**Two constraints the Count door's permission split makes explicit** (`20260903000000`), and which
this migration must follow:

1. Any migration granting a permission to a default role must **also update
   `default_shop_roles()`**, not only run an `update public.roles`. The update reaches shops that
   exist; the function reaches shops created tomorrow. Miss it and "Manager" means two different
   things either side of the migration date.
2. The backfill must be guarded (`not permissions && array[...]`) so re-running is a no-op and a
   customised role is not overwritten.

Unlike `inventory.count` / `inventory.transfer`, these do **not** default on for existing
permission-holders — nobody holds a ledger permission today, and `ledger.post` is exactly the grant
that should be made deliberately rather than inherited.

## Build order

Five phases. Each ships something usable and leaves the app working.

| Phase | Ships | Outcome |
|---|---|---|
| **1 · Foundations** | Ledger tables, RLS, balanced-entry constraint, seeded chart of accounts, `post_journal_entry`, audit log | Chart of Accounts, General Journal Entry, Journals List, Audit Log, Trial Balance — manual entries only |
| **2a · A permitted cost formula** | `receive_stock` computes a true moving weighted average instead of overwriting with the latest price, plus the IAS 2.36(a) disclosure | Stock is valued on a formula IAS 2 allows. COGS becomes the number the ledger will post |
| **2b · Auto-posting** | Posting side on seven RPCs, historical backfill | Trial balance reflects real trading. Cash becomes derived |
| **3 · Statements** | Balance sheet, cash flow, income statement, period close, retained earnings, Create Bill, transfers, fixed assets, depreciation | Accounting hub complete; the three statements tie to each other |
| **4 · Reports** | The remaining 16 reports. Sales and inventory groups first — they need no ledger and unblock the most people | Every requested report except Purchase Orders |
| **5 · Small gaps** | `refunds.reason`, `tax_filings` | Discounts & Refunds and Sales Tax Liability become complete |

**Phase 2b needs its own spec and its own verification script.** It is the only phase that touches
the POS's hottest transaction. 2a is now a single arithmetic change inside `receive_stock`, which
already holds the row lock it needs — it neither adds a table nor touches `complete_sale`.

## Risks

**Concurrency in `complete_sale` is the single biggest risk.** Two registers selling the same product
both reach for the oldest layer. Without row-level locking one over-consumes it; with careless
locking they deadlock and the POS stops taking money. Layers must be selected `FOR UPDATE` in a
fixed order (`received_at`, then `id`). This needs a test that runs genuinely parallel sales, not a
unit test.

**Selling stock with no layer.** Kaiibi lets sales through at zero or unknown stock. Under layers
there is then no cost to record, and silently using zero overstates profit on exactly the sales
nobody watches. Fix: consume what exists, create a flagged provisional layer at last known cost for
the shortfall, true it up when stock arrives, difference posts to 5100. Inventory Valuation shows
how much of the value is provisional.

**A count sets, it does not add.** *Added 2026-08-23.* `save_stock_count` writes
`stock = excluded.stock`, so under layers a downward variance has to consume oldest-first like a
sale and an upward one has to create a layer at the frozen `unit_cost_cents`. Where that cost is
**null** — an uncosted product — there is no value to move, and the count must record the variance
without inventing one, matching `isUncosted()`'s posture that null and zero are different answers.
The Count sheet already surfaces "9 with no reason"; uncosted lines need the same treatment.

**The backfill has to tie.** Phase 2b replays every existing sale, refund, bill, payment, pay run and
stock receipt into journal entries, then posts one opening-balance entry per shop. It needs a
verification script that asserts the ledger agrees with the existing report totals **to the cent**
before it is trusted.

**Layers are per location.** Kaiibi reports profit per location and a shop-wide pool would let a sale
in one store consume a delivery sitting in another. The cost of that correctness: a stock transfer
must move layer quantity carrying its cost, or moving stock silently reprices it.

**Write volume on the hot path.** A 20-line sale may touch 40+ layer rows inside the transaction that
already writes the sale, its items, its payments and now its journal entry. Needs an index on
`(shop_id, product_id, location_id, received_at) where quantity_remaining > 0` and a measured
before/after on a realistic basket.

## The framework — resolved 2026-08-23

**Target IFRS for SMEs as the design reference. Do not claim compliance anywhere in the UI.**

IFRS for SMEs is the simplified standard written for businesses this size and is the prevailing
reference across East Africa. It is also what this design already conforms to in substance, so
naming it costs nothing now and would be expensive to retrofit later — statement layouts and
disclosure notes are the parts that ossify.

Checked against it, four things already hold:

| Requirement | Status |
|---|---|
| Inventory at the lower of cost and net realisable value, FIFO or weighted average only | Both offered, LIFO not |
| The cost formula must be disclosed | The basis is printed on the Inventory Valuation report and on statements |
| Balance sheet split current / non-current | Already the layout |
| P&L by nature or by function, consistently | By function — cost of sales, then operating expenses |

The distinction that matters: the app should produce statements **an accountant can work with**, not
statements carrying a compliance claim nobody audited. No badge, no "IFRS compliant" label.

**The sharper question, if this needs revisiting:** not "which framework" but **who reads these
statements** — a tax authority, a lender, an investor, or only the owner. That changes the required
disclosures far more than the framework name does. If it is only the owner today, this is settled;
if a lender is coming, revisit before phase 3 fixes the statement layouts.

## Open

None. The two remaining recommendations were accepted on 2026-08-23:

- **New shops default to weighted average**, same as existing ones. One basis across the platform
  until a shop deliberately changes it.
- **Shrinkage sits in cost of sales** (`5100`), above gross profit. The P&L carries it as a single
  line; the Stock Movement Log breaks it out by reason. `miscount` posts identically to a real loss
  — the two cannot be told apart at posting time, so the reason does its work in the report rather
  than in the accounts.

Two things would reopen this document rather than the plan built from it: a **lender or tax
authority** becoming a reader of the statements (changes disclosures, revisit before phase 3), or
**FIFO** being wanted after all — see "When FIFO would become needed" above. The design and plan are merged and waiting.
