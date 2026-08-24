# FIFO cost layers — where this stands

**Read this first, then [the plan](2026-08-24-fifo-cost-layers.md).** The plan is written for zero context; this says how far it got.

## State

Branch **`fifo-layers`**, pushed, no PR yet. Two commits:

- `1563e55` — the plan itself (also open as PR #68)
- `42d36f6` — **Task 1 complete**: `inventory_cost_layers`, `inventory_cost_consumption`, RLS, the partial index, and `verify-cost-layers.sql` with 5 checks

`npm run test:db` → **18 pass** (was 17). Nothing writes to the new tables yet, so no behaviour has changed.

## Start at Task 2

`consume_layers()`, `create_layer()`, `restore_layers()` — plan section "Task 2". Everything after it depends on those three.

Tasks 3–8 wire the five existing RPCs. Task 9 is the concurrency test and is the reason the phase exists; Task 10 is whole-phase verification.

## Verified baselines on `main`

| | |
|---|---|
| `npx tsc --noEmit` | clean |
| `npm test` | 139 suites, 2122 tests |
| `npm run lint` | 81 problems (49 errors, 32 warnings) |
| `npm run test:db` | 17 on `main`, 18 on this branch |

**No TypeScript changes in this phase.** If Jest or lint move, something out of scope was touched.

## Open PRs

| PR | What |
|---|---|
| [#65](https://github.com/yshaqalle/kaiibi/pull/65) | The 2a design — the reasoning the plan executes |
| [#68](https://github.com/yshaqalle/kaiibi/pull/68) | The plan |
| [#69](https://github.com/yshaqalle/kaiibi/pull/69) | Unrelated: a lone hub card stretched to 1344px |

## Two decisions still open

Both are recommended-as-designed in the plan, and both are cheaper to settle before Task 2 than after:

**Provisional layers.** What happens when a sale outruns the stock record. The most intricate thing in the phase. The alternative — refuse the sale — is far simpler but unacceptable in a shop selling off a shelf the app has not caught up with.

**Mixed costed/uncosted layers on one line.** What `sale_items.unit_cost_cents` should be. Recommended: blend the costed part, record the null layers in the consumption rows so a report can say the figure is partial. Decide it in Task 4 and write it down.

## What this phase must not do

Write to the ledger. Phase 2a changes what a cost **is**; 2b changes where costs are **recorded**. If a task starts calling `post_journal_entry`, it has left its scope.

## The one thing worth carrying forward

**Four tests on this project could not fail.** Three were found by mutation, none by reading — and two passed because a *different* rule rejected the fixture before the rule under test ran.

So: every test step in the plan names the mutation that must turn it red, and fixtures are chosen so only the thing under test can fail them. Task 5's check 19 is deliberately written **wrong**, with a note saying so and how to fix it.

Also of note: a malformed mutation is not a passing test. While doing Task 1, a mutation that removed a constraint left a dangling comma — the migration failed to parse, the whole chain broke, and the grep returned nothing. That reads like silence, not like red. Re-do the mutation cleanly before believing it.

## Deferred, and asked for

**Layout and navigation polish for Accounting and Reports.** Raised near the end of the last session and deliberately not started — it is design work, and the convention here is an HTML mockup in `docs/design/` before implementation. One concrete defect was found and fixed separately (#69). Reports is still the old P&L/tax tab; the 22-report hub is phase 4, so "Reports looks unfinished" is a scope observation rather than a polish task.
