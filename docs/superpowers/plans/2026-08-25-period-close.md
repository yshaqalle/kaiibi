# Period Close and Retained Earnings (Phase 3b) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close a month so it stops moving, roll its profit into retained earnings, and do it automatically enough that a shop which never remembers to close still has closed books.

**Architecture:** One RPC writes a closing entry that zeroes the P&L accounts into `3900`, and flips the period's status. **The three statements ignore closing entries entirely** — that one decision is what keeps them correct across a close, and it is the whole design.

**Tech Stack:** Postgres 15 (Supabase), plpgsql, TypeScript, React Native (Expo SDK 57). No new dependencies.

---

## Read this before anything else — the design decision that carries the phase

A closing entry is a **bookkeeping act, not an economic event**. Nothing happened in the shop when a month closed.

That has a consequence the naive implementation gets wrong. If `statement_lines()` counts closing entries, then an income statement for a window spanning a close reads **near zero** — because the closing entry debits every revenue account and credits every expense account by exactly their balances. The shop's real trading vanishes from its own income statement.

It gets worse downstream. `cash_flow()` takes its operating opening line from `statement_lines()` and asserts a **proof**: net change must equal the observed movement in the cash accounts. Cash did not move when the month closed, so the proof fails by exactly the amount closed. `verify-statements.sql` already carries a negative test proving that proof *can* fail — it is not decorative.

**So: all three statement functions must exclude `source = 'close'`.** `'close'` is already a permitted value in `journal_entries.source`'s CHECK; nothing uses it yet.

That is the recommendation, not a decree. **Task 1 asks you to verify it against the alternative** — giving `3900` its own cash-flow section — and to say which you chose and why. What is not negotiable is the property: **after a close, all five reconciliations must still hold**, including for a window that spans the close. If your approach cannot deliver that, it is the wrong approach.

Do **not** reach for a residual "other movements" line in the cash flow. It makes the proof tie by construction and destroys the only check capable of catching a sign error. The roadmap says so and there is a test that will catch you.

---

## Global Constraints

Every task's requirements implicitly include this section.

### Baselines — **measure these yourself; they move under you**

As at 2026-08-25 on `main` (`3bf670d`): `tsc` clean · **170 suites / 2693 tests** · lint **109 (54 errors, 55 warnings)** · `test:db` **30**.

Another workstream ships to this repo constantly — during phase 3a these moved three times, none of it accounting. **Take your own reading on the commit you branch from and compare against that**, never against a number in a document.

That workstream also **resets the local database to its own branch**. Before trusting any `test:db` result, confirm `select max(version) from supabase_migrations.schema_migrations` matches your branch's newest migration, and check it again afterwards — a reset landing mid-run invalidated a full mutation pass during phase 3a. If it races, reset and retry; it settles.

`npx supabase start` must be running. Migrations are applied **locally only**; `npx supabase db push` is the human's call.

### Migration numbering

**`202610*` belongs to accounting.** Two branches both picking "tomorrow" produce the same version for different files, and `db push` keys on version: whichever applies first wins and the other **never runs**, silently, on production. This has happened three times.

`supabase/tests/migration-version-guard.test.ts` now catches it across worktrees and branches on every `npm test`. It will tell you if you collide — but pick from `202610*` and start above `20261001000200`, the newest accounting migration.

### The ledger, as built and deployed

Read the migrations, not this summary.

- **`accounting_periods`** — `id, shop_id, starts_on, ends_on, status, closed_at, closed_by, exceptions, created_at`. `status` is `open | closed | locked`. `exceptions` is an array. **Nothing writes to it today except `open_period_for`**, which creates a month on first post and raises if it is not open.
- **`journal_entries.source`** permits exactly: `manual, sale, refund, settlement, bill, payment, payroll, stock, count, transfer, asset, depreciation, close, opening`. `'close'` is free.
- **`journal_lines`** — debit positive, credit negative, `check (amount_cents <> 0)`, and a **deferred** constraint that each entry sums to zero.
- **`accounts.type`** — `asset, liability, equity, revenue, cost_of_sales, expense`. `is_contra` is true for `1590`, `3100`, `4100`, `4200`.
- **`3900 Retained Earnings`** is seeded and is currently **zero for every shop** — phase 3a's balance sheet puts the whole profit in "Profit this period" because nothing has ever closed.
- **`post_journal_entry(p_shop_id, p_entry_date, p_description, p_lines, p_location_id, p_source)`** gates on `ledger.post` **only** when `p_source = 'manual'`. Pass `'close'` and it does not gate — which is correct here, because closing is gated on `ledger.close` at the RPC's own door.
- **`statement_lines()` / `balance_sheet()` / `cash_flow()`** (phase 3a, `20261001000*`) all gate on `ledger.view`, filter `status in ('posted','reversed')` and never `draft`, and are `security definer` — so their `shop_id` filters **are** the tenant boundary.

### Decisions already made — the plan must honour these

From `docs/superpowers/specs/2026-08-22-accounting-standards-design.md`:

- **Closed and locked are different states.** Closed blocks normal posting but still permits an owner to post an **adjusting entry** dated into the month; it is reversible and audited. Locked is manual, deliberate and final. *"Without the middle state, a genuinely late bill has nowhere to go."*
- **Months close automatically, 10 days after they end.** A shop owner will not remember, and a book that is never closed lets anyone edit any month forever. Closing on the 31st would be wrong: August's electricity bill arrives in September. The grace period is configurable (5/10/15) and the whole behaviour is switchable to "ask me" or "never".
- **Auto-close runs the adjustments it can compute and closes even when the human checklist is not clean.** A month closed with items outstanding is marked **closed with exceptions** and names them. *"Refusing to close would mean shops that never do stock counts never close a month."*
- **Corrections are reversing entries, never edits.** Posted journals are immutable.

### Test conventions

- DB checks live in `supabase/tests/verify-*.sql`, auto-discovered by glob, and must print **`ALL CHECKS PASSED`** via `raise notice`.
- Fixtures build in one `do $$ ... $$` block and roll back by raising `'rollback fixture'`. Copy `verify-statements.sql`.
- Scripts run as `postgres`, so **RLS never applies**. Assert policies against `pg_policies`. An RPC gating on `has_shop_permission` needs `set_config('request.jwt.claims', ...)` and `set_config('role','authenticated', ...)` first — and setting `role` turns RLS **on**, so raw inserts come first.
- **Every test step names the mutation that must turn it red.** Run it. Roughly **thirty-five mutations on this project have turned out to be no-ops** — `sum()` ignoring nulls, a guard firing before the assertion it was meant to prove, two algebraically identical branches, a `BEGIN..EXCEPTION` subtransaction rolling back the write being asserted, a fixture shop that was ten days old so two dates coincided, and a fixture with **zero** liabilities that made a sign mutation invisible because `-0 = 0`. **A mutation that does not redden its check is a finding.**
- **Multi-tenancy is not free.** Phase 3a's final review found that removing `where e.shop_id = p_shop_id` from all three statement functions passed the entire suite, because no fixture had two shops. **Any new function here needs a second shop in its fixture.**

### Screen conventions

Read `.claude/skills/building-bento-screens/SKILL.md` — it binds. `StatTile` needs `variant="bento"`. `Caveat` takes children; `tone="wrong"` must carry an action, `tone="context"` must not. `DataTable` already scrolls inside its card.

**Gate a hub card whose RPC raises.** Phase 3a shipped a Critical where a default Manager — who holds `sales.view` but not `ledger.view` — got a permanent "Loading…" because the cards were ungated and the RPCs raise. Four cards are now gated; the older six read under RLS and give an honest empty state. A close screen's RPC will raise on `ledger.close`, so its card is gated.

Read the exact versioned Expo docs at https://docs.expo.dev/versions/v57.0.0/ before Expo-specific code — `AGENTS.md` requires it.

---

## File Structure

| File | Responsibility |
|---|---|
| `supabase/migrations/2026100200*_statements_ignore_closing_entries.sql` | Task 1 — whichever of the two approaches you choose |
| `supabase/migrations/2026100201*_close_accounting_period.sql` | `close_accounting_period()`, `reopen_accounting_period()` |
| `supabase/migrations/2026100202*_period_exceptions.sql` | What "closed with exceptions" checks, as a function the RPC and the screen share |
| `supabase/migrations/2026100203*_auto_close.sql` | The 10-day rule and its shop setting |
| `src/lib/periods.ts` | Read and close, no arithmetic |
| `src/components/accounting/ledger/close-period-view.tsx` | The Close a Period screen |
| `supabase/tests/verify-period-close.sql` | The close, the roll, reopen, locked, and two shops |
| `supabase/tests/verify-statements-across-a-close.sql` | **The five reconciliations, spanning a close** |

Pick the exact numbers when you get there; the guard will tell you if they collide.

---

### Task 1: The statements survive a close

**Do this first.** Everything else writes entries that would break phase 3a if this is wrong, and it is far cheaper to establish the property before there is anything to break.

**Files:**
- Create: a migration redefining whichever statement functions your approach touches
- Create: `supabase/tests/verify-statements-across-a-close.sql`

- [ ] **Step 1: Decide the approach, and write down why**

Two candidates:

**(a) The statements exclude `source = 'close'`.** A close becomes invisible to all three. Simple, and it matches what a closing entry *is* — an internal reclassification, not an event.

**(b) `3900` gets its own cash-flow section** and `statement_lines()` keeps counting closing entries. Preserves "the statements read everything", but an income statement spanning a close then reads near zero, which is wrong on its face.

I recommend (a). **Verify it rather than taking it**: work out, for each of the five reconciliations, what each approach produces for a window spanning a close. Write the answer in the migration header. If you pick (b), you must explain how the income statement avoids reading near zero.

- [ ] **Step 2: Write the failing test**

Create `verify-statements-across-a-close.sql`. Build a shop with trading in **two** months, close the first, then assert **all five reconciliations** over a window spanning both:

1. income statement net profit **=** balance sheet "Profit this period" *(note: after a close, this is the open period's profit only — assert what your approach makes true, and say so)*
2. **=** cash flow's operating opening line
3. **=** revenue + cost_of_sales + expense netted **independently from `journal_lines`**, excluding whatever your approach excludes
4. balance sheet total assets **=** total liabilities and equity
5. cash flow closing cash **=** balance sheet cash

Plus: **`3900` holds the closed month's profit**, and total equity is unchanged by the close — a close moves profit *within* equity, it does not create or destroy any.

Give the fixture a **second shop** with its own trading, and assert the first shop's figures are unmoved.

- [ ] **Step 3: Run it and watch it fail**

Run: `npm run test:db -- --no-reset`. It fails because `close_accounting_period()` does not exist yet — that is expected; Task 2 builds it. **Write Task 2 first if you prefer**, but do not let this file pass until it genuinely spans a close.

- [ ] **Step 4: Implement, run, and mutate**

Mutations, each of which must redden something:
- remove the `source = 'close'` exclusion (or your equivalent) → reconciliation 2 or 5 fails on the spanning window
- make the closing entry not balance → the deferred constraint fires at commit
- close, then assert equity moved → must fail; a close is equity-neutral

- [ ] **Step 5: Commit**

```bash
git commit -m "fix(accounting): a close is invisible to the statements"
```

---

### Task 2: `close_accounting_period()`

**Files:**
- Create: the close migration
- Create: `supabase/tests/verify-period-close.sql`

**Interfaces:**
- Produces:
  ```sql
  public.close_accounting_period(p_shop_id uuid, p_period_id uuid, p_force boolean default false)
    returns uuid   -- the closing entry, or null when there was nothing to close
  public.reopen_accounting_period(p_shop_id uuid, p_period_id uuid, p_reason text)
    returns void
  ```

**The closing entry** zeroes every P&L account into `3900`: debit each revenue account by its balance, credit each `cost_of_sales` and `expense` account by its balance, and the difference goes to `3900` — credit on a profit, debit on a loss. Source `'close'`, dated the period's `ends_on`.

Points to get right, each of which wants a check:

- **A period with no trading closes without an entry.** Every line would be zero and `journal_lines` refuses a zero amount; two zero lines would sum to zero and pass the balance check while meaning nothing. Return null and flip the status.
- **Gate on `ledger.close`.** Both RPCs. `security definer` bypasses RLS, so that gate is the boundary.
- **Closing an already-closed period is an error, not a no-op** — the second close would zero accounts that are already zero and write a meaningless entry. A **locked** period refuses even harder.
- **Closing must be idempotent under concurrency.** Take an advisory lock on the shop, as `backfill_shop_ledger` does; two taps must not write two closing entries.
- **`reopen_accounting_period` reverses the closing entry** rather than deleting it — corrections are reversing entries, never edits. It requires a reason, and both close and reopen write to `accounting_audit_log`.
- **Closing a period does not stop an adjusting entry.** `open_period_for` currently raises for any non-open period. Closed must still accept a **deliberate** adjusting entry from an owner; only locked refuses everything. Work out where that distinction lives — it may mean `post_journal_entry` needs to know the difference, which is a change to phase-1 code and needs its own care.

Name a mutation for every one of those and run it.

---

### Task 3: Exceptions — what a close is allowed to be unhappy about

**Files:**
- Create: the exceptions migration
- Modify: `verify-period-close.sql`

**Interfaces:**
- Produces: `public.period_exceptions(p_shop_id uuid, p_period_id uuid) returns table (kind text, detail text, count integer)`

One function, called by both the RPC and the screen, so the list a shop is shown and the list recorded on the period **cannot disagree**. Phase 2b learned this the expensive way: the Post History door and its RPC had to be pinned to each other by a check because they drifted.

The design names: draft bills, stock counts not done, bank not confirmed. Read it and decide what is computable **today** — several of those have no data behind them yet, and an exception that can never fire is worse than one that is absent, because it teaches the reader the list is complete.

Write down which you implemented and which you left, and why.

---

### Task 4: Auto-close, ten days after the month ends

**Files:**
- Create: the auto-close migration
- Modify: `verify-period-close.sql`

The grace period is **configurable — 5, 10 or 15 days — and the whole behaviour is switchable to "ask me" or "never"**. That needs a shop setting; check whether one exists before adding a column, and follow how `shops.expiry_warning_lead_days` was done.

**What runs it is the open question.** `pg_cron` is available on Supabase but this repo does not use it yet — check. The alternative is closing lazily: when anything reads a period, close any earlier period that is past its grace. Lazy is simpler and needs no scheduler; it also means a shop nobody opens never closes, which may be fine or may not. **Decide, and write down the trade-off.**

**A month closes even when exceptions exist**, marked *closed with exceptions* and naming them. That is the point: refusing would mean shops that never do stock counts never close.

---

### Task 5: The Close a Period screen

**Files:**
- Create: `src/lib/periods.ts`, `close-period-view.tsx`
- Modify: `ledger-hub.tsx`, `accounting.tsx`

The mockup's frame is in `docs/design/accounting-standards-mockup.html` — search `Closed periods`. It shows a table of Period / Status / Closed / By / Exceptions / Profit rolled, and a **Lock all of 2025** action.

The card is gated on `ledger.close`. The view still needs its own error handling — `?view=` is reachable and a role can change mid-session, which is exactly the Critical phase 3a shipped.

**The screen does no arithmetic**, as phase 3a's do not: every figure is a row the function returned.

---

### Task 6: Prove it end to end

`npx tsc --noEmit && npm test && npm run lint && npm run test:db`, against a database head you have verified matches your branch.

Then run `verify-statements.sql` **and** `verify-statements-across-a-close.sql` together — phase 3a's five reconciliations must still hold on a shop that has never closed, and hold again on one that has.

In the running app: close a month, then open the income statement, balance sheet and cash flow for a window spanning it, and read the figures. The cash flow's **proof** section is the one to look at; if it does not tie, the mapping is wrong, not the tolerance.

---

## What this unblocks

**3c** — transfers, fixed assets and depreciation, which is the other half of phase 3 and independent of this.

**Phase 4's statements-dependent reports.** And the balance sheet finally shows a *"Retained earnings — prior periods"* line that is not zero, which is the line an accountant looks for to know the books have ever been closed.
