# Accounting — what is left, and the prompt for each

Every remaining step, in order, with a prompt you can paste into a fresh session.

**Design:** [`specs/2026-08-22-accounting-standards-design.md`](specs/2026-08-22-accounting-standards-design.md) — read this before any of the below. It carries the decisions the plans only execute.

## Where it stands

| Phase | State |
|---|---|
| **1a** Ledger foundations | ✅ merged — 5 tables, balanced-entry constraint, chart of accounts, audit log |
| **1b** Ledger screens | ✅ merged — hub, Chart of Accounts, Journal Entry, Journals, Trial Balance, Audit Log |
| **2a** A permitted cost formula | 📋 **plan ready**, not built |
| **Reports hub** | 📋 **plan ready**, not built — independent of everything below |
| **2b** Auto-posting | ✏️ needs a plan |
| **3** Statements | ✏️ needs a plan |
| **5** The small gaps | ✏️ needs a plan |
| **FIFO cost layers** | ⏸️ parked — design and plan merged, superseded by 2a |

Baselines on `main`: `tsc` clean · 139 suites / 2122 tests · lint 81 · `test:db` 17.

**Every prompt below assumes `npx supabase start` is running.**

---

## Step 1 — A permitted cost formula (2a)

**Do this first.** `receive_stock` currently overwrites a product's cost with the newest delivery's price, which is replacement cost and not a formula IAS 2 permits. Small — one arithmetic change plus a disclosure. Everything downstream posts costs, so this has to be right before they do.

```
Implement the moving weighted average for kaiibi.

Read first:
  docs/superpowers/plans/2026-08-24-moving-weighted-average.md

Branch from main. Use the superpowers:executing-plans skill, task by task.
npx supabase start must be running.
```

---

## Step 2 — The Reports hub

**Independent of the ledger entirely** — it can be done before, after or alongside step 1 by someone else. Seven reports over tables that already exist. This is the visible work.

```
Build the Reports hub for kaiibi.

Read first:
  docs/design/reports-hub-mockup.html
  docs/superpowers/plans/2026-08-24-reports-hub.md

Branch from main. Use the superpowers:executing-plans skill, task by task.
npx supabase start must be running.
```

---

## Step 3 — Auto-posting (2b)

**The big one, and the one with real risk.** Every money-moving RPC gains a journal-entry side, and years of history get replayed into the ledger. Needs a plan written first.

Two sessions, because the plan deserves its own.

**3a — write the plan:**

```
Write the implementation plan for phase 2b of the kaiibi accounting work —
auto-posting to the ledger.

Read first:
  docs/superpowers/specs/2026-08-22-accounting-standards-design.md
    (the posting map, and the "What's changing, precisely" section)
  docs/superpowers/plans/2026-08-23-ledger-foundations.md
    (the conventions, and post_journal_entry's signature)

Use the superpowers:writing-plans skill. Do not implement anything.

Scope: complete_sale, refund_sale_items, settle_sale_balance,
receive_stock, record_invoice_payment, post_payroll_run and
save_stock_count each gain a posting side, plus the historical backfill.

Two things the plan must carry:
  - The backfill needs a verification script asserting the ledger agrees
    with existing report totals TO THE CENT before it is trusted.
  - complete_sale is the POS's hottest transaction. The plan must say what
    the posting costs it, measured, not assumed.
```

**3b — execute it**, once you have read the plan:

```
Implement phase 2b of the kaiibi accounting work — auto-posting.

Read first:
  docs/superpowers/plans/<the plan 3a produced>

Branch from main. Use the superpowers:executing-plans skill, task by task.
npx supabase start must be running.
```

---

## Step 4 — The statements (3)

Balance sheet, cash flow, income statement, period close, retained earnings — plus Create Bill, transfers, fixed assets and depreciation. **Only meaningful after 2b**, because until then the statements have nothing to read.

```
Write the implementation plan for phase 3 of the kaiibi accounting work —
the financial statements and period close.

Read first:
  docs/superpowers/specs/2026-08-22-accounting-standards-design.md
  docs/design/accounting-standards-mockup.html
    (the Balance Sheet, Cash Flow, Income Statement and Close a Period frames)

Use the superpowers:writing-plans skill. Do not implement anything.

Scope: balance sheet, cash flow, income statement, close_accounting_period,
retained earnings, create_bill, transfer_funds, fixed_assets and the
depreciation run.

Two decisions already made that the plan must honour:
  - Profit & Loss and Income Statement are ONE query with a detail flag,
    not two reports. Built separately they will eventually disagree.
  - Months close automatically 10 days after they end, and close even when
    the human checklist is not clean, marked "closed with exceptions".

One still open, and it belongs in the plan's Open section: whether
shrinkage sits in cost of sales or operating expenses. Recommended: leave
it in operating expenses, where the Count door already puts it.
```

Then execute with the same shape as 3b.

---

## Step 5 — The small gaps

Two schema additions that unblock two reports. Small, and can be done any time after 2b.

```
Write and implement the plan for kaiibi's two accounting schema gaps.

Read first:
  docs/superpowers/specs/2026-08-22-accounting-standards-design.md
    (the gap table)

Scope, and nothing else:
  - refunds.reason — a closed enum, required at refund time, existing rows
    backfilled as not_recorded. Follow stock_count_items.reason's shape,
    but REQUIRED where that one is optional: a stock-take has sixteen
    variances and a refund has one reason.
  - tax_filings — period, declared, paid, date, reference. Paying one posts
    Dr 2100 / Cr Cash, which is also what makes the liability go down.

These unblock the Discounts & Refunds and Sales Tax Liability reports.

Use superpowers:writing-plans then superpowers:executing-plans.
npx supabase start must be running.
```

---

## Deliberately not scheduled

**FIFO cost layers.** Design ([#65](https://github.com/yshaqalle/kaiibi/pull/65)) and plan ([#68](https://github.com/yshaqalle/kaiibi/pull/68)) are merged, and branch `fifo-layers` carries a completed Task 1. Superseded by step 1 — weighted average is a permitted formula and taxes less under inflation. Revisit only on a trigger named in the parent design: an external reader specifying FIFO, slow-moving high-value stock in a volatile currency, per-batch expiry becoming a real requirement, or a group parent imposing a uniform policy.

**Purchase orders.** A procurement workflow, not a report. Its own project.

**Layout and navigation polish** for Accounting and Reports. Raised and deferred — it is design work and wants an HTML mockup in `docs/design/` first.

---

## What every session should know

These cost real time to discover. They are in each plan, and repeated here because they apply to work these plans do not cover.

**Migrations.** `pg_get_function_arguments`, never `pg_get_function_identity_arguments` — the identity form drops `DEFAULT` clauses and `CREATE OR REPLACE` refuses to remove defaults. Any migration granting a permission to a default role must also update `default_shop_roles()`, guarded so re-running is a no-op.

**DB tests.** They run as `postgres`, so **RLS never applies** — assert policies against `pg_policies`, never by attempting the operation. An RPC gating on `has_shop_permission` needs `set_config('request.jwt.claims', ...)` first, and setting `role` turns RLS on, so raw inserts come before it. A shop has **no location** until the fixture makes one.

**Dates.** `DateRange` is `{ since, until? }`, not `start`/`end`. Never `new Date(dateColumn)` — a date-only string parses as UTC midnight and renders a day early west of Greenwich. Never `toISOString().slice(0,10)` to write one. Use `fromDateColumn` / `toDateColumn`.

**Screens.** Every `StatTile` on a bento card needs `variant="bento"`. A lone `BentoCell` in a row must not stretch — copy `ledger-hub.tsx`. `Caveat` takes its text as **children**.

**Browser testing.** Playwright's `browser_click` **silently does nothing** on React Native Web `Pressable`s, including pre-existing ones. Dispatch the full `pointerdown` / `mousedown` / `pointerup` / `mouseup` / `click` sequence. This looks exactly like an app bug and is not.

**Tests that cannot fail.** Five on this project so far. Three were found by mutation, none by reading, and two passed because a *different* rule rejected the fixture before the rule under test ran. So: every test step names the mutation that must redden it, and fixtures are chosen so **only the thing under test can fail them**. A malformed mutation is not a passing test — if the suite returns nothing rather than red, the mutation broke something structurally.
