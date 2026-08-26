# Accounting — what is left, and the prompt for each

Every remaining step, in order, with a prompt you can paste into a fresh session.

**Design:** [`specs/2026-08-22-accounting-standards-design.md`](specs/2026-08-22-accounting-standards-design.md) — read this before any of the below. It carries the decisions the plans only execute.

## Where it stands

_Last verified 2026-08-25 against `main` and the linked project._

| Phase | State |
|---|---|
| **1a** Ledger foundations | ✅ merged & deployed — 5 tables, balanced-entry constraint, chart of accounts, audit log |
| **1b** Ledger screens | ✅ merged & deployed — hub, Chart of Accounts, Journal Entry, Journals, Trial Balance, Audit Log |
| **2a** A permitted cost formula | ✅ merged & deployed — #73, a moving weighted average |
| **2b** Auto-posting | ✅ merged & deployed — #74, plus #76 and #78 |
| **3a** The statements | ✅ merged & deployed — #80, income statement / balance sheet / cash flow |
| **3b** Period close | 📋 **plan ready**, not built — read the warning below first |
| **3c** New transactions | 📋 **plan ready**, not built — independent of 3b |
| **Reports hub** | 📋 plan ready, not built — independent of everything else |
| **4** The remaining reports | ✏️ needs a plan — sixteen; several need 3b |
| **5** The small gaps | ✏️ needs a plan — `refunds.reason`, `tax_filings` |
| **FIFO cost layers** | ⏸️ parked — design and plan merged, superseded by 2a |

**`create_bill` is delivered and struck from scope.** The design specified it because, when written, entering a bill posted nothing. It now does: `invoices` → `sync_invoice_expense` → `post_expense_to_ledger` posts `Dr <category account> / Cr 2000`, and #78 made a goods bill name the delivery it pays for. A separate RPC would be a second door onto the same ledger effect.

**Phase 3 was split into 3a / 3b / 3c** because they are independent subsystems and, as one plan, no statement would have shipped until fixed assets did.

### Before writing 3b — the cash flow's proof will break

`cash_flow()` has a **proof** section asserting that its net change equals the observed movement in the cash accounts. `2300 Loyalty Points Liability` and `3900 Retained Earnings` are in **no** cash-flow section. Nothing posts to them today — but **3b's period close posts to `3900` by definition**, and any `cash_flow` window spanning a close will then fail its proof by exactly the amount closed.

Do not "fix" this by adding a residual *other movements* line. That makes the proof tie by construction and destroys the only check capable of catching a sign error. `verify-statements.sql` carries a negative test asserting the proof **does** fail when an unaccounted account moves — keep it, and give `3900` a real section instead.

### Migration numbering — `202610*` belongs to accounting

Two branches both picking "tomorrow" produce the **same version number for different files**, and `supabase db push` keys on version: whichever applies first wins and the other **never runs**, silently, on production.

This has happened three times on this repo — `db17dc8`, then twice on the phase-3a branch, which was renumbered out of `20260927*` into `20260928*` and straight into a second collision with a storefront worktree. Accounting work now uses `202610*`.

Before adding any migration, check every branch **and** every worktree:

```bash
for b in $(git branch -r --format='%(refname:short)' | grep -v HEAD); do git ls-tree --name-only "$b" supabase/migrations/; done
for w in .claude/worktrees/*/; do ls "$w/supabase/migrations/" 2>/dev/null; done
```

This is now enforced by `npm test`: `supabase/tests/migration-version-guard.test.ts` reads every version prefix in this tree, every sibling worktree, and every local and remote git branch, and fails loudly — naming both files — on any collision.

### Baselines move under you

Another workstream ships to this repo constantly. As at 2026-08-25 on `main`: `tsc` clean · 160 suites / 2538 tests · lint 95 (53 errors, 42 warnings) · `test:db` 30. **Take your own reading on the commit you branch from and compare against that** — never against a number in this document. A plan that pins a moving baseline teaches its reader to ignore a real regression.

That workstream also resets the local database to its own branch. Before trusting any `test:db` result, confirm `select max(version) from supabase_migrations.schema_migrations` matches your branch's newest migration, and check it again afterwards — a reset landing mid-run has already invalidated a full mutation pass.

**Every prompt below assumes `npx supabase start` is running.**

---

## Step 1 — A permitted cost formula (2a) — ✅ DONE

Shipped in [#73](https://github.com/yshaqalle/kaiibi/pull/73) and deployed. `receive_stock` computes a true moving weighted average instead of overwriting with the latest price, and the IAS 2.36(a) disclosure names the formula on Inventory and in Restock.

Plan: [`plans/2026-08-24-moving-weighted-average.md`](plans/2026-08-24-moving-weighted-average.md).

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

## Step 3 — Auto-posting (2b) — ✅ DONE

Shipped in [#74](https://github.com/yshaqalle/kaiibi/pull/74), with [#76](https://github.com/yshaqalle/kaiibi/pull/76) and [#78](https://github.com/yshaqalle/kaiibi/pull/78) closing what running it against a real shop exposed. All deployed.

Every money-moving path posts a balanced entry inside its own transaction, and `backfill_shop_ledger()` replays a shop's history — including an opening-balance entry for stock that was on the shelf before deliveries were recorded, without which `1200 Inventory` sits in credit. Post History on the Accounting hub is its door.

Plan: [`plans/2026-08-24-auto-posting.md`](plans/2026-08-24-auto-posting.md). Measured cost on a 20-line sale: **+5.4% median, flat with history**.

## Step 4 — The statements (3a) — ✅ DONE

Shipped in [#80](https://github.com/yshaqalle/kaiibi/pull/80) and deployed. `statement_lines()` (income statement and P&L from one query with a detail flag), `balance_sheet()` and `cash_flow()`, with three screens on the Accounting hub.

`verify-statements.sql` asserts the **five reconciliations** — net profit identical on all three statements and on an independent derivation from `journal_lines`, assets equal to liabilities and equity, and cash flow closing cash equal to the balance sheet's.

Plan: [`plans/2026-08-25-financial-statements.md`](plans/2026-08-25-financial-statements.md).

---

## Step 4b — Period close (3b)

**Plan written:** [`plans/2026-08-25-period-close.md`](plans/2026-08-25-period-close.md). Read it and execute; the prompt below is kept only for a fresh re-plan.

**Read "Before writing 3b" above first — this breaks the cash flow's proof, and how you handle that is the interesting part of the task.**

```
Write the implementation plan for phase 3b of the kaiibi accounting work --
period close and retained earnings.

Read first:
  docs/superpowers/specs/2026-08-22-accounting-standards-design.md
  docs/superpowers/plans/2026-08-25-financial-statements.md
    (statement_lines() is what supplies the profit figure a close rolls)
  docs/design/accounting-standards-mockup.html   (the Close a Period frame)

Use the superpowers:writing-plans skill. Do not implement anything.

Scope: close_accounting_period, the retained-earnings roll into 3900,
auto-close 10 days after a month ends, "closed with exceptions", and the
Close a Period screen.

Three things already decided that the plan must honour:
  - Closed and LOCKED are different states. Closed blocks normal posting but
    still permits an owner to post an adjusting entry dated into the month;
    locked is manual, deliberate and final.
  - A month closes even when the human checklist is not clean, marked
    "closed with exceptions", naming them. Refusing to close would mean
    shops that never do stock counts never close a month.
  - Corrections are reversing entries, never edits.

And one it must SOLVE rather than inherit: posting to 3900 breaks
cash_flow()'s proof for any window spanning a close. Give 3900 a section;
do not add a residual line.
```

## Step 4c — New transactions (3c)

**Plan written:** [`plans/2026-08-25-transfers-assets-depreciation.md`](plans/2026-08-25-transfers-assets-depreciation.md). Read it and execute; the prompt below is kept only for a fresh re-plan.

```
Write the implementation plan for phase 3c of the kaiibi accounting work --
transfers, fixed assets and depreciation.

Read first:
  docs/superpowers/specs/2026-08-22-accounting-standards-design.md
  docs/design/accounting-standards-mockup.html
  docs/superpowers/plans/2026-08-25-financial-statements.md
    (the balance sheet's fixed-asset section and the cash flow's investing
     section are both already written and currently always zero)

Use the superpowers:writing-plans skill. Do not implement anything.

Scope: transfer_funds, the fixed_assets register, create_fixed_asset,
dispose_fixed_asset and run_depreciation.

Note that balance_sheet() splits fixed from current by the code range
1500-1599 and cash_flow()'s investing section reads the same range -- both
already exist and are waiting for something to put in them. 6800
Depreciation is currently always zero, which the cash flow's add-back
comment says out loud.
```

## Migration numbering — `202610*` belongs to accounting

Accounting work numbers its migrations from `20261001000000` upward. Storefront and fulfilment own `202609*`.

The failure mode this prevents, in one sentence: **two branches each picking "tomorrow" produce the same version number for different files, and `supabase db push` keys on version, so whichever merges second never runs — silently, on production.** It has happened three times on this repo (`db17dc8` first; phase 3a twice, once against `20260927000000_place_order.sql` and once against the fulfilment worktree's `20260928000000`/`20260928000100`).

Before choosing a number, check every branch **and** every worktree, not just `main`:

```
for b in $(git branch -r --format='%(refname:short)' | grep -v HEAD); do git ls-tree --name-only "$b" supabase/migrations/; done
for w in .claude/worktrees/*/; do ls "$w/supabase/migrations/" 2>/dev/null; done
```

`supabase/tests/migration-version-guard.test.ts` now runs this on every `npm test` and fails loudly on a collision, so this is a manual fallback rather than the only line of defense.

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
