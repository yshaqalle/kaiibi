# Transfers, Fixed Assets and Depreciation (Phase 3c) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Three transaction types the ledger has accounts for and no door to: moving money between a till and a bank, owning equipment, and that equipment wearing out.

**Architecture:** Three RPCs and one register table, each posting through `post_journal_entry` exactly as phase 2b's seven do. Nothing here changes how a statement is computed — it fills sections phase 3a already wrote and which currently always read zero.

**Tech Stack:** Postgres 15 (Supabase), plpgsql, TypeScript, React Native (Expo SDK 57). No new dependencies.

**Independent of phase 3b.** Either can go first. If 3b has already shipped, read its plan for what a closing entry does to a window; nothing here should interact with it, and a check proving that is cheap.

---

## Why the statements are waiting for this

Phase 3a built the sections and they are correct — they are just always zero:

- `balance_sheet()` splits **fixed assets** from current by the code range `1500`–`1599`, and shows *Equipment & fittings, at cost* less *accumulated depreciation*. `1590` is seeded contra. Nothing has ever posted to any of them outside a test fixture.
- `cash_flow()` has an **investing** section reading the same range, and adds back **depreciation** in operating — `6800`'s movement, which its own comment says out loud is "normally zero until 3c ships".
- The income statement's *Depreciation* line, which the mockup shows and which the design calls out: *"Depreciation is new. Equipment wearing out is a real cost of trading, and leaving it out overstated profit every month."*

So this phase is what makes three already-shipped, already-tested sections mean something.

---

## Global Constraints

Every task's requirements implicitly include this section.

### Baselines — **measure these yourself; they move under you**

As at 2026-08-25 on `main` (`3bf670d`): `tsc` clean · **170 suites / 2693 tests** · lint **109 (54 errors, 55 warnings)** · `test:db` **30**.

Another workstream ships here constantly; these moved three times during phase 3a. **Take your own reading on the commit you branch from.** That workstream also **resets the local database to its own branch** — before trusting any `test:db` result, confirm `select max(version) from supabase_migrations.schema_migrations` matches your newest migration, and check again afterwards. If it races, reset and retry.

`npx supabase start` must be running. Migrations are **local only**; `npx supabase db push` is the human's call.

### Migration numbering

**`202610*` belongs to accounting**, above `20261001000200`. Two branches both picking "tomorrow" produce the same version for different files and `db push` silently runs only one — three times now. `supabase/tests/migration-version-guard.test.ts` catches it on every `npm test`.

### The ledger, as built and deployed

- **Accounts already seeded**: `1500 Equipment`, `1510 Furniture and Fittings`, `1590 Accumulated Depreciation` (`is_contra`), `6800 Depreciation`, `1000/1010/1020/1021` cash, `2000` payable. **You should not need a new account.** If you think you do, say why — the chart is per-shop and seeded by `default_chart_of_accounts()`.
- **`journal_entries.source`** permits `transfer`, `asset` and `depreciation` — all three are free and unused.
- **`post_journal_entry(p_shop_id, p_entry_date, p_description, p_lines, p_location_id, p_source)`** gates on `ledger.post` **only** when `p_source = 'manual'`. Your RPCs pass their own source and gate at their own door.
- **`journal_lines`** — debit positive, credit negative, `check (amount_cents <> 0)`, deferred sum-to-zero per entry.
- **`public.shop_local_date(p_at timestamptz default now()) returns date`** — **every `p_entry_date` comes from this** where the source is a timestamp. `now()::date` and `current_date` resolve in UTC while every market kaiibi serves is UTC+3, so a late-evening posting lands on the wrong day and, at a month boundary, in the wrong period — permanently, once that period closes.
- **Closed-period redirect**: phase 2b's pattern is to read the period's status *before* posting and, if it exists and is not open, post to the current period with the true date and the status in the description — using `coalesce(v_period_status, 'not open')`, because a null status otherwise nulls the whole description via `||` and the entry is refused for having no description. That was a real defect. Decide per RPC whether it applies; one that always dates today does not need it.

### The traps this project keeps paying for

- **Roughly thirty-five mutations here have been no-ops.** Causes found: `sum()` ignoring nulls; a guard firing before the assertion it was meant to prove; two algebraically identical branches; a `BEGIN..EXCEPTION` subtransaction rolling back the write being asserted; a fixture shop ten days old so two dates coincided; and a fixture with **zero** liabilities, where a sign mutation was invisible because `-0 = 0`. **Run every mutation. One that does not redden is a finding.**
- **Multi-tenancy is not free.** Phase 3a's final review removed `where shop_id = p_shop_id` from all three statement functions and the whole suite passed, because no fixture had two shops. **Every fixture here gets a second shop.**
- **Reverse on delete.** Four separate holes shipped in phase 2b where a row was deleted or edited and its journal entry stood: `edit_sale`, `delete_sale`, `delete_invoice_payment`, and expenses. Each was found after the fact. **If you build a delete or an edit path, build its reversal in the same task** — inline, not via `reverse_journal_entry`, which gates on `ledger.post`. A reversal carries the **same `source`** as the entry it reverses; `verify-posting-sales.sql` asserts that convention.
- **Copy-forward.** Any function you re-create is reproduced **in full** and gains an entry in `supabase/tests/accumulated-rpc-edits.test.ts`, with a token that appears only in executable code, never in a comment.

### Screens

Read `.claude/skills/building-bento-screens/SKILL.md` — it binds. `StatTile` needs `variant="bento"`; `Caveat` takes children, `tone="wrong"` must carry an action.

**Gate a hub card whose RPC raises.** Phase 3a shipped a Critical where a default Manager — `sales.view` but not `ledger.view` — got a permanent "Loading…" from ungated cards over raising RPCs. Views still need their own error handling: `?view=` is reachable and a role can change mid-session.

Read https://docs.expo.dev/versions/v57.0.0/ before Expo-specific code — `AGENTS.md` requires it.

---

## File Structure

| File | Responsibility |
|---|---|
| `supabase/migrations/2026100300*_transfer_funds.sql` | `transfer_funds()` |
| `supabase/migrations/2026100301*_fixed_assets.sql` | `fixed_assets` table, `create_fixed_asset()`, `dispose_fixed_asset()` |
| `supabase/migrations/2026100302*_run_depreciation.sql` | `run_depreciation()` |
| `src/lib/fixed-assets.ts` | Read and write, no arithmetic |
| `src/components/accounting/ledger/fixed-assets-view.tsx` | The register |
| `src/components/accounting/transfer-modal.tsx` | Cash and Bank Transfers — check whether Cash & Budgets is a better home |
| `supabase/tests/verify-transfers.sql` | |
| `supabase/tests/verify-fixed-assets.sql` | Assets, disposal, and depreciation |

---

### Task 1: `transfer_funds()`

The simplest of the three, and the right one to establish the shape.

**Interfaces:**
```sql
public.transfer_funds(p_shop_id uuid, p_from_code text, p_to_code text,
                      p_amount_cents integer, p_on date default null,
                      p_note text default null) returns uuid
```

`Dr` the destination, `Cr` the source. Source `'transfer'`.

Things a check should pin:

- **Both accounts must be the shop's own and must be cash-like.** A "transfer" from `4000 Sales Revenue` to `1000 Cash` is a balanced entry that invents income. Decide how you constrain it — a code range, a type, or an explicit list — and say why.
- **From and to must differ.** A transfer to itself is two lines that sum to zero and mean nothing.
- **A zero or negative amount is refused.** `journal_lines` refuses zero anyway; refuse it earlier with a sentence.
- **Gate it.** `ledger.post` is the obvious grant, but a shop moving its own till money to the bank is not a ledger operation in the owner's head. Check what Cash & Budgets uses today and prefer consistency; say what you chose.
- Date from `shop_local_date()`.

Mutations: swap the debit and credit; allow same-account; allow a revenue account; remove the gate. Each must redden.

---

### Task 2: The fixed-asset register

**Interfaces:**
```sql
public.create_fixed_asset(p_shop_id uuid, p_name text, p_cost_cents integer,
                          p_acquired_on date, p_life_months integer,
                          p_paid_from_code text default null,
                          p_account_code text default '1500') returns uuid
public.dispose_fixed_asset(p_asset_id uuid, p_on date, p_proceeds_cents integer default 0) returns uuid
```

A `fixed_assets` table: shop, name, cost, acquired, life in months, the asset account it sits in, `disposed_on`, and — following phase 2b's hard-won pattern — a `journal_entry_id` so nothing posts twice and a delete can be reversed.

**Buying** is `Dr 1500` (or `1510`) `/ Cr` cash when paid, or `/ Cr 2000` when on credit. `p_paid_from_code` null means on credit — decide and document.

**Disposal** is the one with real accounting in it. On disposal you remove the asset at cost, remove its accumulated depreciation, take any proceeds in cash, and the difference is a **gain or loss**. Work out which account that lands in — there is no `Gain on disposal` in the seeded chart, and that is a genuine gap. Options: `6900 Other`, a new account, or refuse to handle proceeds in this phase and post only a full write-off. **Pick one and justify it**; do not quietly post a plug.

Every asset needs a second shop in the fixture, and a disposal test that asserts the balance sheet's fixed-asset section moves by the right amount **and** the cash flow's investing section shows it.

---

### Task 3: `run_depreciation()`

**Interfaces:**
```sql
public.run_depreciation(p_shop_id uuid, p_through date) returns integer  -- entries written
```

Straight-line, monthly: `cost / life_months` per asset per month, `Dr 6800 / Cr 1590`, source `'depreciation'`, dated the month's end.

The things that will bite:

- **Idempotency.** Running twice for the same month must write nothing the second time. Drive it off what has already been posted — phase 2b's whole backfill is built on `journal_entry_id is null` and is worth reading first. A `depreciation_runs` table is the alternative; say which and why.
- **Rounding.** `cost / life_months` rarely divides evenly. Over the asset's life the total must equal cost **exactly** — an asset that depreciates to −3 or stops at 7 short is wrong and will sit on the balance sheet forever. Decide where the remainder goes (the last month is conventional) and **assert the full-life total in a test**, not just one month's charge.
- **Never past cost.** An asset fully depreciated stops. A check should run an asset past its life and assert `1590` never exceeds `1500` for it.
- **A disposed asset stops depreciating** on its disposal date.
- **A closed period.** If 3b has shipped, a depreciation run over a closed month must not post into it — follow the redirect pattern, and if 3b has not shipped, note that this is where it will need attention.

Then the payoff, which is a check in its own right: after a depreciation run, **the cash flow's add-back is no longer zero and its proof still ties.** That single assertion is what this whole phase is for, and it exercises code phase 3a shipped untested-in-anger.

---

### Task 4: The screens

The fixed-asset register from the mockup (`docs/design/accounting-standards-mockup.html`, search `Fixed Asset List`) — cost, accumulated depreciation, net book value. The transfer is a modal; check whether Cash & Budgets is a better home than the Accounting hub, since that is where a shop already thinks about moving money.

Screens do no arithmetic. Net book value comes from the function.

---

### Task 5: Prove it end to end

`npx tsc --noEmit && npm test && npm run lint && npm run test:db`, against a verified database head.

Then the reconciliations: run `verify-statements.sql` on a shop that has bought an asset, depreciated it, and transferred money — **all five must still hold**, and the cash flow's proof in particular, because investing and the depreciation add-back are now non-zero for the first time.

In the running app: buy an asset, run depreciation, and read the balance sheet's fixed-asset section and the cash flow's investing section. If the proof does not tie, the mapping is wrong, not the tolerance.

---

## What this unblocks

The balance sheet's fixed-asset section and the cash flow's investing section stop being always-zero, and the income statement gains the depreciation line the design says was overstating profit by its absence every month.

Together with 3b, phase 3 is complete and **phase 4's sixteen reports** become the remaining work.
