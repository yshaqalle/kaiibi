# Accounting — what is left, and the prompt for each

Every remaining step, in order, with a prompt you can paste into a fresh session.

**Design:** [`specs/2026-08-22-accounting-standards-design.md`](specs/2026-08-22-accounting-standards-design.md) — read this before any of the below. It carries the decisions the plans only execute.

## Where it stands

_Last verified 2026-08-27 against `main`. **Phase 3 is complete** — the three statements, period close, and fixed assets. Phase 4 is the remaining work._

| Phase | State |
|---|---|
| **1a** Ledger foundations | ✅ merged & deployed — 5 tables, balanced-entry constraint, chart of accounts, audit log |
| **1b** Ledger screens | ✅ merged & deployed — hub, Chart of Accounts, Journal Entry, Journals, Trial Balance, Audit Log |
| **2a** A permitted cost formula | ✅ merged & deployed — #73, a moving weighted average |
| **2b** Auto-posting | ✅ merged & deployed — #74, plus #76 and #78 |
| **3a** The statements | ✅ merged & deployed — #80, income statement / balance sheet / cash flow |
| **3b** Period close | ✅ merged — #83, close/re-open, exceptions, auto-close, the screen. **Read "what 3b changed for everyone" below.** |
| **3c** New transactions | ✅ merged — #88, transfers, fixed assets, depreciation. **Phase 3 is complete.** |
| **Reports hub** | 📋 plan ready, not built — independent of everything else |
| **4** The remaining reports | ✏️ needs a plan — sixteen; the several that needed 3b are now unblocked |
| **5** The small gaps | ✏️ needs a plan — `refunds.reason`, `tax_filings` |
| **FIFO cost layers** | ⏸️ parked — design and plan merged, superseded by 2a |

**`create_bill` is delivered and struck from scope.** The design specified it because, when written, entering a bill posted nothing. It now does: `invoices` → `sync_invoice_expense` → `post_expense_to_ledger` posts `Dr <category account> / Cr 2000`, and #78 made a goods bill name the delivery it pays for. A separate RPC would be a second door onto the same ledger effect.

**Phase 3 was split into 3a / 3b / 3c** because they are independent subsystems and, as one plan, no statement would have shipped until fixed assets did. The split paid for itself: 3a shipped statements months before 3c existed, and each phase found defects in the one before it that a single review pass would not have.

### What 3b changed for everyone — read before writing 3c or 4

**A month can now be final.** `close_accounting_period` rolls a month's P&L into `3900 Retained Earnings` with a journal entry of source `'close'`. Three rules follow, and anything new that reads or writes the ledger has to land on the right side of each.

**1. Two of the three statements exclude `source = 'close'`; one deliberately does not.** `statement_lines()` and `cash_flow()` exclude it. `balance_sheet()` reads `3900` as the ledger holds it and subtracts the P&L side of closing entries instead — excluding it there would make `3900` read zero forever. **Any new read of the ledger must pick a side on purpose.**

**2. The cash flow's proof did break, and not where this file predicted.** The prediction was that `3900`'s movement would break it. The real defect was subtler and the 3a reasoning that dismissed it was wrong: `cash_flow()`'s *Add back depreciation* line reads `6800`, an **expense** account, so a close credits it like any other P&L account. Net profit keeps the closed month's depreciation as a cost — `statement_lines()` excludes the closing entry — while the add-back that should cancel it no longer does. The same amount, subtracted twice.

It hid because **nothing posts to `6800` until 3c ships `run_depreciation`**, so every fixture that closed a month had an empty add-back and `0 - 0 = 0`. `verify-statements-across-a-close.sql` now posts depreciation by hand in both months for exactly this reason. **3c: when `run_depreciation` lands, that fixture is the one that proves it.**

**3. Still no residual *other movements* line, and never add one.** It makes the proof tie by construction and destroys the only check capable of catching a sign error. There is now a test asserting `cash_flow()` has not grown a section, and `verify-statements.sql` still carries the negative test that the proof **does** fail when an unaccounted account moves. `2300 Loyalty Points Liability` remains unaccounted, as does `3900` moved by anything that is not a close — an `'opening'` entry carrying pre-kaiibi retained earnings would fail the proof by exactly itself, and should.

### The account no cash-flow section reads — this has now happened three times

Each time, an account moved that no `cash_flow()` section reads. That is a hole in the proof identity: every entry sums to zero, so the negated non-cash lines add up to the cash lines, and an unread account falls straight through.

| | |
|---|---|
| **3a** | predicted `3900` would break the proof across a close |
| **3b** | the real defect was `6800` — the add-back reads an expense account a close credits, so the same amount was subtracted twice |
| **3c** | a **disposal** debits `1590`, which the investing section excludes |

**Twice the justifying comment was true of one movement and silently false of another.** `cash_flow()`'s own words were *"accumulated depreciation is not a cash movement and is already inside the add-back above"* — true of the depreciation **charge**, false of a **disposal**.

**#88 stopped waiting for the fourth.** It enumerated every account these paths can move, mapped each to a section, and **pinned the unaccounted set at exactly `{2300, 3900}`** — so a new account that falls through now reddens instead of hiding for a phase. If you add a posting path, that pin is what you will have to update, and updating it means naming the section that reads your account.

**Never add a residual "other movements" line.** It makes the proof tie by construction and destroys the only check capable of catching a sign error. There is a test asserting `cash_flow()` has not grown a section.

### Two things 3b left for 3c — both now done

- **Auto-close was built and unreachable.** `auto_close_periods` defaults to `'ask'` and nothing wrote the column, so no shop could turn it on. The default is deliberate: nothing before #83 ever wrote `status='closed'`, so phase 2b's 66 "redate to today" branches had never fired for a real shop, and defaulting to `'automatic'` would have activated all of them at deploy. **#88 added the Settings control** (Settings → closing the books, gated on `ledger.close` in a trigger, not only in the client).
- **The hand-posted depreciation in `verify-statements-across-a-close.sql` is now real** — `create_fixed_asset` plus one `run_depreciation` spanning both months, one of them closed.

### What 3c left behind — read before phase 4

- **`run_depreciation` × `reverse_journal_entry` is narrowed, not closed.** Voiding an asset's acquisition entry while the register row survives now aborts loudly with `40001` rather than committing a balanced lie — but **there is no client retry on that error**, so a user can meet a raw failure. Closing it properly means either deadlock-prone locking in a shipped generic RPC or a one-snapshot rebuild.
- **The accounting shell's routing test reads *source text***, so it cannot catch a genuine mis-wiring. All twelve views were confirmed to route by hand; the test is a weak guard and should be replaced with one that renders.
- **A second shop in a fixture is necessary but not sufficient.** Dropping both tenant filters from `run_depreciation` left the whole suite green because shop A's runs all preceded shop B's assets **in script order**. Fixtures must **interleave**.
- **`open_period_for` has an `EXECUTE` revoke but no membership predicate** — one would refuse the backfill. Named, not fixed.

### The `PUBLIC` grant audit — real work, not yet done

#83 found that **`anon` held `EXECUTE` on `post_journal_entry`** via the default `PUBLIC` grant, never revoked. Combined with a gate that only checked `'manual'` sources, a request with **no `Authorization` header** could post forged entries into any shop by id. Present since 2a.

Fixed there for `post_journal_entry` and `open_period_for`. **The default `PUBLIC` grant is still on nearly every function in the schema.** The rest are safe *by argument* — and on this exact line, three separate arguments were reviewed, approved, and wrong before it was settled by measuring a real HTTP request. A schema-wide grant audit is its own piece of work and it should happen.

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

**✅ Built and merged — #83.** Plan: [`plans/2026-08-25-period-close.md`](plans/2026-08-25-period-close.md). The prompt below is kept only for a fresh re-plan, and is now **out of date in one respect**: it says closed still permits an adjusting entry dated into the month, and `'locked'` is a state nothing writes yet.

**What shipped that the plan did not anticipate:** a period cannot be closed until it has **ended** (`ends_on >= shop_local_date()` refuses, and `p_force` cannot override). Closing the current month sent every phase-2b "redate to today" escape back into the month it had just closed — till, expenses, bills, deliveries and payroll all failed outright.

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

**✅ Built and merged — #88.** Plan: [`plans/2026-08-25-transfers-assets-depreciation.md`](plans/2026-08-25-transfers-assets-depreciation.md). The prompt below is kept only for a fresh re-plan, and **that plan shipped four defects of its own**: its migration numbers collided with files already on `main`, its `post_journal_entry` constraint was stale (membership is now required for **every** source), it asserted the cash-flow proof was the only thing that could catch a sign error on a transfer (false — both legs are cash, so the proof is identical; the two balances catch it), and it named a wrong "after" head. Distrust a plan's stated constraints and re-check them against the live schema.

**The defect worth remembering:** a month could be **depreciated twice**. Two overlapping `run_depreciation` calls each posted a monthly entry but only one wrote the charge rows, so the unique constraint on `(asset_id, charge_month)` never fired — it makes a double *charge row* impossible, not a double *run*. Seven entries for six months, `1590` out by 60000, **and the cash-flow proof still tied**. Wrong and balanced is invisible to every totals check in this system. Closed with `pg_advisory_xact_lock` before any read plus a write-back check, and proved with a real two-session test (`verify-depreciation-concurrency.sh`) — the serial idempotence test passed throughout and always would have.

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
