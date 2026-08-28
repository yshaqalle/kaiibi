# Reports Hub Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn Reports from one tab of three charts into a hub of eleven cards, and build the seven reports that read tables kaiibi already has.

**Architecture:** Exactly the shape the Accounting tab already uses — a `view` URL param owned by the shell, a hub of launcher cards, and one component per report under `src/components/accounting/reports/`. All arithmetic goes in `src/lib/report-math.ts` as pure functions so it can be tested without a render. **No migration, no RPC, no schema change.**

**Tech Stack:** Expo SDK 57, React Native, TypeScript, Jest. No new dependencies.

**Mockup:** [`docs/design/reports-hub-mockup.html`](../../design/reports-hub-mockup.html) — read it first. Every string quoted in this plan comes from there and ships verbatim, **except where this plan now says otherwise**: the mockup predates phases 2b, 3a and 3c, and its copy for four cards asserted that shipped screens did not exist. See Task 1.

---

## ⚠️ Status — partly built. Read before starting.

**Branch `reports-hub`, at `e417849`** (**unpushed since `3666d5b`; no PR**). Cut from `main` at `708cd6e`.

| | |
|---|---|
| **Task 1** hub and routing | ✅ `fa8db0c` |
| **Task 2** `report-math.ts` | ✅ `142bf9b` |
| Hub copy fix (not in the original plan) | ✅ `3666d5b` |
| **Tasks 3–5** sales, item, employee | ✅ `cad4e7e` |
| **Tasks 6–8** category, inventory, low stock | ✅ `aeaa2e0` |
| **Task 9** stock movement + exhaustive routing | ✅ `e417849` |
| **Task 10** prove it in the browser | ✅ `00d1dea` — **found a wrong number** |

**All ten tasks are done and the work is verified on web against the real test shop.** Not verified on iPhone, iPad or Android — the reports are new screens using existing primitives, so a native pass is worth doing before release but nothing in the diff is platform-specific.

**Task 10 earned its place.** It found a store share rendering at **124.7%**, through 3381 passing tests: the numerator was revenue before refunds, the denominator `netRevenueCents` after them, and the test fixtures had no refunds so the two were equal. Fixed in `00d1dea` by moving the rule to `sharesOfOwnTotal()` in `report-math.ts`. **This is the third time this phase that a fixture-proved figure was wrong against real rows — treat "the tests pass" as the weakest evidence available.**

Two design rules earned their keep on real data rather than in a fixture, and both are the difference between a usable report and a badly wrong one:

- **Uncategorised is 94% of this shop's revenue.** Filtering it out — the naive version — would have taken every share of $14.70 instead of $244.95.
- **Sales with no cashier are 18% of it.** Dropping them would leave the column $44 short of the shop's takings with nothing explaining the gap.

And `getLowStockProducts` would have invented a reorder list: **not one of the 12 stock rows has a reorder level**, so the screen correctly rendered its `none-configured` branch.

**This plan's stated baselines are fiction.** It pins "expected lint after" at 83–89 per task; phase 3 shipped since and the real figure was **122** before this work. **Measure your own and hold those** — a plan that pins a moving baseline teaches its reader to ignore a real regression.

| | `3666d5b` (before) | `e417849` (now) |
|---|---|---|
| `tsc` | clean | clean |
| `npm test` | 186 suites / 3360 tests | 186 suites / **3384** tests |
| `npm run lint` | 122 (56 err, 66 warn) | **129** (63 err, 66 warn) |
| `npm run test:db` | 42 | 42 |
| DB head | `20261008000200` | unchanged |

**The +7 lint is exactly one per new data-loading view**, all of it the mount-effect rule `use-refresh-on-focus.ts:28-31` depends on. Anything above 129 is a real regression. The +24 tests are all `report-math.ts`.

**Batching worked and is worth repeating.** Tasks 3–9 went in three commits, not seven: they share the roll-ups in `report-math.ts` and one read each in `reports.ts`, so a commit per task would have put code in the first that only the last used.

**What Tasks 3–9 decided, that Task 10 and anything after inherit:**

- **`reports.ts` does not re-implement the sales read.** `sales.ts`'s pages past PostgREST's 1000-row cap and its mapping has been corrected repeatedly; a second copy would be a second opinion on what a sale is. The four sales reports shape its result and issue it once per screen.
- **Revenue on a per-cashier or per-store row means takings less tax, never net of refunds.** A refund is handled by whoever is on the till when the customer returns, so charging it to either cashier is a guess. The screens say so.
- **Task 8 does not use `getLowStockProducts`.** That function defaults a null reorder level to 5, which turns "nobody has set a level" into "the level is 5" — the exact conflation the screen exists to avoid.
- **Stock Movement has no "Who" column.** `profiles` carries only the "own profile" policy, and the one readable name mapping, `list_shop_staff`, **raises** without one of four people-permissions — which would both throw the screen for a stock clerk and force the card to be gated.
- **Routing is a `Record`, not a chain of `&&`.** `REPORT_SCREENS` in `report-screens.tsx` is exhaustive over `ReportView`, so a deleted screen or an uncatalogued report **fails `tsc`**. This replaces the defect the ledger's nav test still guards by grepping `accounting.tsx` for `view === 'assets'`. If you touch report routing, do not reintroduce the grep.

**What Task 1 decided, that the rest inherit:**

- **Nothing is gated.** All seven reports read tables under RLS with no RPC, so they give honest empty states; gating would hide a working report from someone entitled to see it. The rule this project follows is *gate a card whose RPC **raises*** — which is why the three statement cards **are** gated on `ledger.view`.
- **`REPORT_VIEWS` holds exactly the seven built here, all `available`**, pinned by a test. A card that is not a hub report lives outside that list — `STATEMENTS_CARD` and the three Accounting hand-off cards are the precedent.
- **Routing is tested by rendering and pressing every card**, never by grepping source text. The Accounting shell's routing test greps, and deleting a view branch there left the suite green with a live card leading to an empty screen. Do not copy that.

**A fuller ledger — every decision, correction and mutation — is at `.superpowers/sdd/progress.md`, which is gitignored and therefore local-only.** If it is gone, this section is the record.

---

## Global Constraints

Every task's requirements implicitly include this section.

### Scope — the seven, and nothing else

Buildable now, because the tables exist:

| Report | Reads |
|---|---|
| Sales Reports | `sales`, `sale_items` |
| Item Performance | `sale_items`, `products` |
| Sales by Employee | `sales.cashier_name` / `created_by` |
| Sales by Category | `sale_items` → `products.category` |
| Inventory Balance | `product_location_stock`, `products.cost_cents` |
| Low Stock & Reorder | `product_location_stock.reorder_level` |
| Stock Movement | `stock_receipts`, `stock_transfers`, `stock_counts` |

~~**Everything else on the hub renders as a dimmed card saying what it waits for.** P&L, Balance Sheet, Cash Flow and the receivables reports need phase 2b's posting; Inventory Valuation needs 2a's cost layers.~~

**Superseded — this paragraph was written before 2a, 2b and 3a shipped, and Task 1 shipped its copy verbatim, so the hub told readers that working screens did not exist.** Corrected in the commit that followed Task 2:

- **P&L, Balance Sheet and Cash Flow are not waiting on anything.** Posting shipped in [#74](https://github.com/yshaqalle/kaiibi/pull/74) (2b) and all three statements in [#80](https://github.com/yshaqalle/kaiibi/pull/80) (3a). They are now `LEDGER_STATEMENT_CARDS` in `reports-hub.tsx` — live cards that open the Accounting tab's screens, gated on `ledger.view` because those RPCs raise.
- **Inventory Valuation is not waiting on cost layers.** FIFO layers are parked and superseded by the moving weighted average in [#73](https://github.com/yshaqalle/kaiibi/pull/73) (2a), so the thing it claimed to wait for is never landing. It is the one card still dimmed, and it names the valuation basis and points at Inventory Balance (Task 7) instead.

A card that opens nothing is still worse than a card that explains itself — but a card saying "not yet" about a screen one tab away is worse than either. **Before writing any copy in Tasks 3–9, check what has shipped since this plan was written.**

Explicitly not in this plan: any migration, any RPC, `refunds.reason`, `tax_filings`, purchase orders, and the existing Reports tab's P&L / sales-tax / category cards, which **stay exactly where they are** until 2b gives them ledger data.

### The existing Reports tab does not get deleted

`reports-tab.tsx` keeps working and keeps its route. This plan adds a hub *in front of* it: `view=hub` shows the new cards, and the old tab becomes one of them (`view=statements`) until 2b replaces it. Deleting it would take away a working P&L to replace it with a card that says "not yet".

### Baselines — green on `main` today

- `npx tsc --noEmit` → **clean**
- `npm test` → **139 suites, 2122 tests**
- `npm run lint` → **81 problems (49 errors, 32 warnings)**, **+1 per new data-loading view** for the unavoidable mount-effect rule — see below. Seven reports plus the hub's own fetch means **89** at the end.
- `npm run test:db` → **17 pass**. Nothing here touches the database; run it once at the end to prove that.

**The lint drift is expected and bounded.** Every fetching screen needs `useEffect(() => { reload(); }, [reload])`, which `react-hooks` flags — but `use-refresh-on-focus.ts:28-31` states it deliberately does *not* fetch on the mounting focus **because the screen's own effect has just fetched**. Remove it and the view sits empty until data goes stale. Each task states its expected number; anything above 89 is a real regression.

### Copy the Accounting tab's navigation exactly

`accounting.tsx` already owns a `view` param for the ledger hub. **Reuse that mechanism; do not invent a second one.**

The hazard it exists for is documented at `accounting.tsx:81-88`: the web shell renders different trees either side of `TABLET_BREAKPOINT`, so resizing a window **tears the screen down and rebuilds it**. State does not survive; the URL does. And the param is owned by the **shell**, not a tab — a tab remounts on every switch, so a `view` held inside one would drop the reader back to the hub every time they returned.

`view` is currently a single param shared with the ledger. **Keep it single.** `tab` already says which hub you are in, so `?tab=reports&view=sales` is unambiguous.

### Bento rules — read [`.claude/skills/building-bento-screens/SKILL.md`](../../../.claude/skills/building-bento-screens/SKILL.md)

- **Never type a hex.** Every colour is a token on `Colors.light`.
- **Grid for glancing, flow for scanning.** KPI strips in `BentoGrid`/`BentoCell`; a report table is read down a column, so it gets a full-width `BentoCard` **outside** the grid with `bodyStyle={{ paddingHorizontal: 10 }}`.
- **`DataTable` already scrolls horizontally inside its card.** Never wrap it in a `ScrollView horizontal`.
- **`StatTile` needs `variant="bento"`.** Ten tiles shipped without it in #64 and rendered cream boxes on white cards. The skill's red-flag list names this exact mistake. Every `StatTile` in this plan passes it.
- **A lone card in a `BentoCell` row must not stretch.** Fixed in #69 by using `BentoCell span={3}` rather than a flex-wrap row — copy `ledger-hub.tsx`, do not re-derive it.
- `bentoProfit`/`bentoLoss` always paired with a sign or glyph.
- `Caveat` takes its text as **children**, not a `text` prop. `action` is `{ label, onPress }` and must go somewhere real.

### Dates — the trap this project already hit

**`DateRange` is `{ since: Date; until?: Date }`** — not `start`/`end`. `until` is optional and means "through today".

**Never `new Date(dateColumn)` and never `toISOString().slice(0,10)`.** A date-only string parses as **UTC midnight**, so it renders as the previous day west of Greenwich; and `toISOString` converts to UTC first, so an evening write is dated tomorrow. Use `fromDateColumn` / `toDateColumn` from `@/lib/period`. This shipped as a real bug in #64 and was found only by posting a real row.

### Test hygiene

**Four tests on this project could not fail** — three found by mutation, none by reading, and two passed because a *different* rule rejected the fixture before the rule under test ran.

1. **Every test step names the mutation that must turn it red.** Apply it, watch it fail, revert.
2. **Choose fixtures where only the thing under test can fail them.** If a count, a total or a sort could reject your input for an unrelated reason, the test proves nothing.
3. **Assert at the boundary that matters** — on the function's return value, not on rendered text.
4. A malformed mutation is not a passing test. If the suite returns *nothing* rather than red, the mutation broke something structurally — re-do it cleanly.

## File Structure

| File | Responsibility |
|---|---|
| `src/lib/report-math.ts` | Every roll-up as a pure function — no Supabase import |
| `src/lib/__tests__/report-math.test.ts` | Jest tests for the above |
| `src/lib/reports.ts` | The Supabase reads the seven reports need |
| `src/components/accounting/reports/reports-hub.tsx` | The eleven cards, four of them dimmed |
| `src/components/accounting/reports/sales-report-view.tsx` | |
| `src/components/accounting/reports/item-performance-view.tsx` | |
| `src/components/accounting/reports/employee-sales-view.tsx` | |
| `src/components/accounting/reports/category-sales-view.tsx` | |
| `src/components/accounting/reports/inventory-balance-view.tsx` | |
| `src/components/accounting/reports/low-stock-view.tsx` | |
| `src/components/accounting/reports/stock-movement-view.tsx` | |
| `src/app/(admin)/(tabs)/accounting.tsx` | **Modify** — route `tab=reports` through the hub |

Pure logic apart from the client for the reason `expense-reporting.ts` sits apart from `expenses.ts`: anything importing the Supabase client cannot load under Jest.

---

### Task 1: The hub and its routing

**Files:**
- Create: `src/components/accounting/reports/reports-hub.tsx`
- Modify: `src/app/(admin)/(tabs)/accounting.tsx`
- Test: `src/components/__tests__/reports-hub-nav.test.tsx`

**Interfaces:**
- Produces: `REPORT_VIEWS` — the catalogue — and `ReportView`. Every later task adds its component behind a key already in this list.

- [ ] **Step 1: Write the failing test**

```tsx
import { REPORT_VIEWS, type ReportView } from '@/components/accounting/reports/reports-hub';

describe('the reports catalogue', () => {
  it('marks exactly the reports that are buildable today as available', () => {
    // The seven that read tables which already exist. If an eighth appears
    // here without its data, the hub links to an empty screen.
    expect(REPORT_VIEWS.filter((v) => v.available).map((v) => v.key)).toEqual([
      'sales', 'item', 'employee', 'category', 'inventory', 'lowstock', 'movement',
    ]);
  });

  it('gives every unavailable report a reason, because the card renders it', () => {
    for (const v of REPORT_VIEWS) {
      if (v.available) continue;
      expect(v.waitingOn.length).toBeGreaterThan(0);
    }
  });

  it('gives every report a group, a scope and a blurb', () => {
    for (const v of REPORT_VIEWS) {
      if (v.key === 'hub') continue;
      expect(v.group.length).toBeGreaterThan(0);
      expect(v.scope.length).toBeGreaterThan(0);
      expect(v.blurb.length).toBeGreaterThan(0);
    }
  });

  it('resolves an unknown view to the hub rather than rendering nothing', () => {
    const resolve = (raw?: string): ReportView =>
      REPORT_VIEWS.some((v) => v.key === raw) ? (raw as ReportView) : 'hub';
    expect(resolve('lowstock')).toBe('lowstock');
    expect(resolve('nonsense')).toBe('hub');
    expect(resolve(undefined)).toBe('hub');
  });
});
```

- [ ] **Step 2: Run it, verify it fails**, then build the hub.

Copy `ledger-hub.tsx` exactly — `BentoGrid` + `BentoCell span={3}`, icon tile, blurb, footer row with scope and action. The one addition: `available: false` renders the card at reduced opacity, with `waitingOn` in place of the action button and **no `onPress`**.

- [ ] **Step 3: Route it**

In `accounting.tsx`, extend the existing `view` handling so `tab === 'reports'` shows `ReportsHub` at `view === 'hub'` and the existing `ReportsTab` at `view === 'statements'`. The title row already reads its label from a catalogue — extend that, don't fork it.

- [ ] **Step 4: Prove the tests can fail**

Mutation: set `available: true` on Balance Sheet. Expected: the first test fails.
Mutation: blank one `waitingOn`. Expected: the second fails.

- [ ] **Step 5: Verify and commit**

Expected: tsc clean; **140 suites, ~2126 tests**; **82** lint (+1 for the hub's own fetch, if it has one — 81 if not).

```bash
git commit -m "feat(reports): a hub, and cards that say what they are waiting for"
```

---

### Task 2: `report-math.ts`

**Files:**
- Create: `src/lib/report-math.ts`, `src/lib/__tests__/report-math.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export function grossProfitCents(lines: { lineTotalCents: number; unitCostCents: number | null; quantity: number }[]): { revenueCents: number; costCents: number; uncostedLines: number };
  export function marginPercent(revenueCents: number, costCents: number): number | null;
  export function groupBy<T, K extends string>(rows: T[], key: (row: T) => K): Record<K, T[]>;
  export function stockValueCents(rows: { stock: number; costCents: number | null }[]): { valueCents: number; unvalued: number };
  export function reorderShortfall(row: { stock: number; reorderLevel: number | null }): number | null;
  ```

- [ ] **Step 1: Write the failing test**

The cases that matter, with fixtures chosen so only the rule under test can fail them:

```ts
it('excludes uncosted lines from cost but not from revenue, and says how many', () => {
  // 3 lines, one uncosted. Revenue counts all three; cost counts two. Numbers
  // picked so a wrong implementation cannot coincide: 1000+2000+4000 = 7000
  // revenue against 1200 cost, and no pairing of these gives 7000 or 1200 by
  // accident.
  const r = grossProfitCents([
    { lineTotalCents: 1000, unitCostCents: 400, quantity: 1 },
    { lineTotalCents: 2000, unitCostCents: 800, quantity: 1 },
    { lineTotalCents: 4000, unitCostCents: null, quantity: 1 },
  ]);
  expect(r).toEqual({ revenueCents: 7000, costCents: 1200, uncostedLines: 1 });
});

it('multiplies unit cost by quantity, not by line count', () => {
  // The bug this catches: cost read as unitCostCents alone. 3 x 500 = 1500,
  // which is visibly not 500.
  expect(grossProfitCents([{ lineTotalCents: 3000, unitCostCents: 500, quantity: 3 }]).costCents).toBe(1500);
});

it('has no margin when there is no revenue, rather than reporting zero', () => {
  // 0% reads as "sold at cost". Null reads as "nothing sold", which is true.
  expect(marginPercent(0, 0)).toBeNull();
  expect(marginPercent(1000, 600)).toBeCloseTo(40);
});

it('reports a negative margin rather than clamping it', () => {
  // Selling below cost is real and worth seeing.
  expect(marginPercent(1000, 1500)).toBeCloseTo(-50);
});

it('counts unvalued stock separately from zero-valued stock', () => {
  // null cost is unknown; 0 is free. A shop with both must not see them merged.
  const r = stockValueCents([
    { stock: 10, costCents: 100 },
    { stock: 5, costCents: null },
    { stock: 4, costCents: 0 },
  ]);
  expect(r).toEqual({ valueCents: 1000, unvalued: 1 });
});

it('has no shortfall when no reorder level is set', () => {
  // reorder_level is nullable and most shops leave it blank. Treating null as
  // zero would report every product as adequately stocked, which is a silent
  // empty report rather than an honest one.
  expect(reorderShortfall({ stock: 3, reorderLevel: null })).toBeNull();
  expect(reorderShortfall({ stock: 3, reorderLevel: 20 })).toBe(17);
  expect(reorderShortfall({ stock: 30, reorderLevel: 20 })).toBe(0);
});
```

- [ ] **Steps 2–4: Implement, mutate, commit**

Mutations, each of which must redden a named test: return `costCents` without `* quantity`; return `0` from `marginPercent` instead of null; treat `costCents: null` as `0` in `stockValueCents`; treat `reorderLevel: null` as `0`.

Expected after: **141 suites, ~2132 tests**; lint **unchanged** — this file fetches nothing.

```bash
git commit -m "feat(reports): the reports' arithmetic, without a render"
```

---

### Tasks 3–9: The seven reports

Each follows the same shape, and each is one commit. **Do them in this order** — the first two prove the pattern and the data access the rest reuse.

| Task | Report | Shape | Expected lint after |
|---|---|---|---|
| 3 | Sales Reports | KPI strip, two half-width breakdowns, full-width by-day table | 83 |
| 4 | Item Performance | KPI strip, one full-width table, a `wrong` caveat for uncosted products | 84 |
| 5 | Sales by Employee | One full-width table, a `context` caveat on not being a leaderboard | 85 |
| 6 | Sales by Category | One full-width table with a share bar, Uncategorised as a visible row | 86 |
| 7 | Inventory Balance | KPI strip, by-store table, a `context` caveat about the valuation basis | 87 |
| 8 | Low Stock & Reorder | One table sorted by shortfall, an empty state that distinguishes "none low" from "none configured" | 88 |
| 9 | Stock Movement | KPI strip, one table merging three sources | 89 |

**For each:**

- [ ] **Step 1: Add the report's reads to `src/lib/reports.ts`.** Follow `expenses.ts`: `supabase` import, row→model mapping in a local `map*`, `if (error) throw error`, camelCase models.
- [ ] **Step 2: Build the view.** Copy `trial-balance-view.tsx` for the shape — `useCallback` reload, `useEffect(() => { reload(); }, [reload])`, `useRefreshOnFocus`, `useTabRefresh`. Every `StatTile` gets `variant="bento"`.
- [ ] **Step 3: Route it** in `accounting.tsx`, one line beside the others.
- [ ] **Step 4: Verify** — `npx tsc --noEmit && npm test && npm run lint`, against the number in the table above.
- [ ] **Step 5: Commit.**

**No new Jest test per view**, and that is deliberate: every decision lives in `report-math.ts` and is tested there. What remains is rendering, and a test of it would assert that a `Text` contains what was passed to it. If a view ends up making a decision of its own, that decision belongs in `report-math.ts` instead.

**Three specific things not to get wrong:**

- **Task 6 — Uncategorised is a row, not a filter.** 175 products have no category; hiding them makes the percentages add to less than the shop took.
- **Task 8 — the empty state distinguishes two cases.** "Nothing is low" and "no reorder levels are set" are different facts, and `reorder_level` is nullable and usually blank. An empty report that means the second while reading like the first is a lie.
- **Task 9 — three tables, one sequence.** `stock_receipts`, `stock_transfers` and `stock_counts` have different shapes and must be normalised into one row type in `reports.ts`, not merged in the component.

---

### Task 10: Prove it in the browser

- [ ] **Step 1: Run it** — `npx expo start --web`, open `/accounting?tab=reports`.

Check each of the seven renders with real data, and that the four dimmed cards do **not** navigate.

- [ ] **Step 2: The remount test.** With a report open, resize across ~900px and back. It must still be on that report. If it drops to the hub, `view` is not reaching the URL.

- [ ] **Step 3: Phone width.** At 390px the hub stacks to one column, tables scroll **inside** their cards, and the page never scrolls sideways.

> **`browser_click` gives false negatives on this app.** Playwright's click does not deliver the pointer sequence React Native Web's `Pressable` needs — it silently does nothing, including on pre-existing tabs. Dispatch the full `pointerdown` / `mousedown` / `pointerup` / `mouseup` / `click` sequence instead. This cost an hour in #64 and looked exactly like an app bug.

- [ ] **Step 4: Full suite.** `npx tsc --noEmit && npm test && npm run lint && npm run test:db`

~~Expected: clean; 141 suites / ~2132 tests; **89** lint; **17** database checks.~~ **Superseded — those are the fictional baselines.** Measured on `e417849`, which is where Task 10 starts: `tsc` clean · **186 suites / 3381 tests** · lint **129 (63 errors, 66 warnings)** · `test:db` **42**. Task 10 changes no arithmetic, so any movement in the first three numbers is a regression it introduced.

**Two things to actually look for, because tests and types cannot see them:**

- **The four dimmed/handed-off cards.** Inventory Valuation must not navigate at all; P&L, Balance Sheet and Cash Flow must land on the *Accounting* tab with the range picked on Reports still applied.
- **The caveats that turn on data.** Item Performance's uncosted caveat is `wrong` with a door to `/inventory?filter=nocost`; Low Stock renders three different states (`none-configured` as `wrong`, partial as `partial`, populated as `context`). A shop with every reorder level set will show none of them, which is not the same as them being broken.

---

## What this unblocks

Nothing depends on this. It is deliberately a leaf: seven reports over existing tables, no schema change, no effect on the ledger work.

When phase 2b lands, four dimmed cards become live and the existing `ReportsTab` is replaced by a P&L that reads the ledger. When 2a lands, Inventory Valuation joins them. Neither needs this plan revisited — the hub already has their cards and their reasons.
