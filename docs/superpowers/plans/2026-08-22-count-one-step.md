# Count — One List, One Step Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the Count modal's by-hand tab from a two-step catalogue-then-basket into one list where every product is a row you type into, blank means "not counted", and Save unfolds a confirmation instead of writing.

**Architecture:** The basket array (`lines: Line[]`) is replaced by a map keyed by product id (`entries: Record<string, CountEntry>`), so what has been typed is attached to the *product* rather than to the rendered row — which is what lets a count survive paging, search and the category filter. A new pure module `src/lib/count-walk.ts` holds every rule that turns `(catalogue, entries)` into rows, planned lines, a filtered set and a page slice, so those rules are testable without a render and cannot drift between the footer, the pager and the commit. The confirmation is a panel that replaces the footer *inside* the `AppModal` already on screen — never a second `Modal`.

**Tech Stack:** Expo SDK 57, React Native, TypeScript, Jest + `react-test-renderer`. No new dependencies.

## Global Constraints

Every task's requirements implicitly include this section.

### The three hazards this plan is designed against

**HAZARD 1 — Typed counts must outlive the page, the search and the category filter.**
State tied to what is *rendered* rather than to the *walk* is the exact shape of bug this feature keeps producing. A count typed on page 1 and dropped by paging to page 2 is invisible until a shelf comes out wrong. Therefore: `entries` is keyed by `product.id` and is never derived from, rebuilt from, or indexed by the filtered or paged list. `handLines` is built from the **whole `catalogue`**, never from `filtered` or from the page slice. Save sends everything typed across every page. Task 4 tests this at the `saveStockCount` boundary, not at the render.

**HAZARD 2 — The confirmation must not be a nested modal.**
On iOS a modal presented from a modal is silently dropped and the button reads as dead. This has bitten twice on this branch (see `reasonOpenFor`'s comment, `src/components/stock-count-modal.tsx:109-111`). The confirmation is a `<View>` that replaces the footer's contents inside the `AppModal` already on screen — the same technique the reason chips use. **Do not import `Modal`, `AppModal`, `useStagedSheet`, or any sheet component for the confirmation.** `eslint.config.js` bans the raw `Modal` import outside `src/components/ui/app-modal.tsx`; do not work around it.

**HAZARD 3 — `await onDone()` must stay outside the `try` that has already committed, and the confirmation must not create a second route to a double commit.**
On Restock this was a Critical: a failed reload left a full basket under a live button and pressing again committed twice. In `submit`, **only** `await saveStockCount(...)` may be inside the `try`, and the `try` ends the moment it resolves. Everything typed is cleared *before* anything that can fail. The confirmation adds a second live button, so it must be dismissed (`setConfirming(false)`) on both the success and the failure path, and its own `onConfirm` is the only thing that writes.

### Baselines — these are green today and must be green at every commit

- `npm run lint` → **76 problems (44 errors, 32 warnings)**. Do not add to this number. Do not "fix" pre-existing ones in this plan's commits.
- `npm test` → **133 suites, 1997 tests, all passing**.
- `npx tsc --noEmit` → **clean, exit 0**.

### Everything else

- **Expo SDK 57.** Read the exact versioned docs at <https://docs.expo.dev/versions/v57.0.0/> before writing any Expo-facing code rather than relying on memory. Nothing in this plan is Expo-API-facing — every component used (`View`, `Text`, `TextInput`, `Pressable`, `ScrollView`, `StyleSheet`) is plain React Native — so this is a guard, not a step.
- **Never normalise input inside `onChangeText` on a controlled `TextInput`.** Three separate silent 100× cost bugs came from this on the Restock branch. The field holds the raw string; it is classified once, from the whole string, by `readCountedQuantity`.
- **Blank and zero must never look alike.** An untouched field renders `—` (as a placeholder, so `value` stays `''`); a typed `0` renders `0` and commits as an empty shelf.
- **An unreadable entry (`abc`) still blocks Save.** Only *blank* is newly permissive. `abc` is a mistake, not a decision.
- **`closeAndReset` resets all state**, because the screen renders this modal with `visible={false}` rather than unmounting it. Every new piece of state added by this plan (`entries`, `page`, `confirming`) must be reset there.
- **The store-transition guard stays.** `lastLocationRef` tells a real store change from an ordinary effect re-run; the sheet tab's handover pins that ref. Both directions are tested today (`src/components/__tests__/stock-count-modal.test.tsx:301` and `:482`) — do not break either.
- **The stock-loss expense gating is unchanged:** `counted > 0` and a real, non-null shortfall. `summariseCount([])` returns `0`, not `null`, so the empty case rests on the count.
- **The sheet tab is unchanged.** `SheetTab`, `planCount`, `commitPlan`, `downloadSheet`'s columns and the migrations/RPC are out of scope. Two *call sites* inside `downloadSheet` and `uploadSheet` read the by-hand state and must be re-pointed at `entries`; that is the whole of the sheet-facing work.
- **Never hardcode a new hex family into this screen.** Every colour used by this plan already appears in `src/components/stock-count-modal.tsx`'s own `StyleSheet` — reuse those exact values.
- **Copy rule:** every string quoted in this plan from `docs/design/count-one-step-mockup.html` is a product decision and ships verbatim. Copy this plan *invents* (because the mockup does not draw that state) is flagged in "Where the mockup is extended" below.
- Run `npm test`, `npm run lint` and `npx tsc --noEmit` before every commit.

### Test hygiene — read before writing any test step

This branch shipped **eight** separate tests that could not fail, each declared green by a full review pass. Every one was found by mutation, none by reading. Therefore:

1. **Every test step in this plan names the mutation that must turn it red.** After writing a test and seeing it pass, apply that mutation, watch the test fail, then revert. This is not optional and it is not "run the suite".
2. **Drive a `TextInput` the way a controlled input is actually driven** — one character at a time through the component's own `onChangeText`, reading the value back between keystrokes. The existing helpers `type()` and `backspace()` in `src/components/__tests__/stock-count-modal.test.tsx:123-137` already do exactly this; use them and never hand a whole string to a setter. Three silent 100× errors shipped on the sibling Restock screen precisely because whole-string tests stayed green through all of them.
3. **`textFrom` recurses.** React Native's `Text` wraps its content in a host-level `Text`, so a node's immediate `.children` is that nested instance, never the raw string. A reader one level too shallow returns `''` for every element and makes every assertion vacuously pass. The existing `textFrom` at `:110-113` is correct — reuse it, do not rewrite it.
4. **Assert at the boundary that matters.** A test about what gets committed asserts on `saveStockCount.mock.calls`, not on rendered text.

### Where the mockup governs, and where the code does

| Conflict | Governs | Why |
|---|---|---|
| The counted field is **PRE-FILLED with `product.stock`** (`stock-count-modal.tsx:216-226`, and the file's own header comment at `:44-56` item 1) vs. the mockup's **blank default** | **The mockup** | Pre-filling was correct when a row only existed because you pressed `Count` — the act of adding it was the statement "I looked". With every product already a row, a pre-filled field would mean the app had counted 240 shelves nobody walked. The header comment at `:44-56` states the old reasoning as fact and **must be rewritten in Task 2**, or it lies. |
| `LineRow`'s **`Remove`** button vs the mockup's **`×`** | **The mockup** | `Remove` took the line out of the basket. There is no basket. `×` returns the row to blank. |
| The variance glyph for an uncounted row: `varianceText(null)` returns **`—`** vs the mockup's **`·`** | **The mockup**, for the blank case only | The mockup uses three distinct glyphs on purpose: `—` for the untouched field, `·` for "no variance to state", `—` for the absent reason. An *unreadable* row (typed `abc`) is not drawn in the mockup and keeps `varianceText(null)`'s `—`, because something was typed and there is genuinely no reading. |
| Search placeholder: mockup draws **`Search products`**, code has **`Search by name, SKU or barcode…`** | **The code** | The mockup's search box is a grey sketch, not microcopy. The existing placeholder names the three fields `filterProducts` actually searches, which is information the mockup's version drops. Behaviour is the mockup's; this string is not a behaviour. |
| The `ADD PRODUCTS` label above the search box | **The mockup**, which has no label | Nothing is added any more. The label is deleted, not renamed. |

### Where the mockup is extended, and why

These are states the mockup does not draw. Each is called out so a reviewer knows the copy is not quoted.

1. **The confirmation's change list scrolls.** The mockup's own closing section names truncation as the failure mode ("the next lever is making the confirmation scroll rather than truncate for large counts — so '40 products will change' is a list you can actually read, not a number you have to trust"). It is a `maxHeight` and a `ScrollView`; building it now costs nothing and building it later means shipping the truncation first. **Task 5.**
2. **The "nothing will change" confirmation.** The mockup states the rule in prose but draws no frame: headline `Nothing will change`, button `Yes, record the count`. **Task 5.**
3. **The matched-rows sentence at N > 1.** The mockup draws only the single-matched case, naming the product (`daily facial was counted at 5 and is already 5 — it will be recorded, but no number moves.`). That form is kept verbatim for exactly one matched row; two or more get `${n} products were counted at the figure they already held — they will be recorded, but no numbers move.` **Task 5.**
4. **The empty-catalogue and no-matches states.** Not drawn. `Nothing here matches that.` (existing copy, kept) when a search or category is on; `This store carries nothing to count yet.` when neither is. **Task 2.**
5. **The unreadable-entry hint.** The mockup's table says an unreadable entry blocks Save but does not give the sentence. `One line is not a whole number — just the digits` / `${n} lines are not whole numbers — just the digits`. **Task 2.**
6. **The pager's counted clause is omitted at zero.** The mockup draws `Showing 1–100 of 240 · 4 counted so far, on any page`. With nothing counted the clause would read `0 counted so far, on any page`, which is noise; it reads `Showing 1–100 of 240` instead. **Task 4.**
7. **`Clear all` renders only on the by-hand tab.** The mockup draws only the by-hand tab. It clears by-hand state; sitting over the sheet tab it would read as an offer to discard an uploaded plan, which it does not do. **Task 3.**

## File Structure

**Create**

- `src/lib/count-walk.ts` — pure. The entry model, `walkRow`/`walkRows`, `plannedLines`, `filterProducts`, `pageSlice`, `COUNT_PAGE_SIZE`. No I/O, no React. This is where HAZARD 1's rule ("keyed by product, never by row") is enforced and where it is cheapest to test.
- `src/lib/__tests__/count-walk.test.ts` — every rule in `count-walk.ts`, with the mutation for each named in a comment.

**Modify**

- `src/components/stock-count-modal.tsx` — the by-hand tab. State model, the row, `×`, `Clear all`, paging, the confirmation, the footer, and the two sheet-tab call sites that read by-hand state.
- `src/components/__tests__/stock-count-modal.test.tsx` — migrated to the one-list flow, plus new cases for blank/unreadable, `×`, `Clear all`, paging and the confirmation.

**Not touched:** `src/lib/count-import.ts`, `src/lib/restock-typed-input.ts`, `src/lib/products.ts`, `supabase/**`, `src/app/(admin)/(tabs)/inventory.tsx`, and everything under the sheet tab except the two call sites named above.

---

### Task 1: The walk, as a pure module

The rules that decide what a typed field *means* — blank, counted, unreadable — and the rules that decide which products are on screen. Extracted first, and tested without a render, so the component task that follows is wiring rather than invention. `plannedLines` building from a caller-supplied row list (which the component builds from the whole catalogue) is the seam that makes HAZARD 1 checkable.

**Files:**
- Create: `src/lib/count-walk.ts`
- Test: `src/lib/__tests__/count-walk.test.ts`

**Interfaces:**
- Consumes: `PlannedCountLine` from `@/lib/count-import`; `readCountedQuantity` from `@/lib/restock-typed-input`; `isUncosted` from `@/lib/product-costing`; `Product`, `StockCountReason` from `@/types/models`.
- Produces, for Tasks 2–5:
  ```ts
  export type CountEntry = { counted: string; reason: StockCountReason | null };
  export type CountEntries = Record<string, CountEntry>;
  export type CountRowState = 'blank' | 'counted' | 'unreadable';
  export type CountRow = {
    product: Product;
    typed: string;
    reason: StockCountReason | null;
    state: CountRowState;
    counted: number | null;
    variance: number | null;
  };
  export const COUNT_PAGE_SIZE: 100;
  export function walkRow(product: Product, entries: CountEntries): CountRow;
  export function walkRows(catalogue: Product[], entries: CountEntries): CountRow[];
  export function typedRows(rows: CountRow[]): CountRow[];
  export function plannedLines(rows: CountRow[]): PlannedCountLine[];
  export function filterProducts(catalogue: Product[], search: string, category: string | null): Product[];
  export function pageSlice<T>(items: T[], page: number, size: number):
    { page: number; pageCount: number; items: T[]; from: number; to: number };
  ```

- [ ] **Step 1: Write the failing test**

Create `src/lib/__tests__/count-walk.test.ts`:

```ts
import {
  COUNT_PAGE_SIZE,
  filterProducts,
  pageSlice,
  plannedLines,
  typedRows,
  walkRow,
  walkRows,
  type CountEntries,
} from '@/lib/count-walk';
import type { Product } from '@/types/models';

const product = (over: Partial<Product> & { id: string }): Product =>
  ({
    shopId: 'shop-1',
    name: 'QA widget',
    description: null,
    sku: null,
    barcode: null,
    brand: null,
    category: null,
    tags: [],
    supplierName: null,
    costCents: 461,
    priceCents: 500,
    stock: 11,
    reorderLevel: null,
    shelfNumber: null,
    expiryDate: null,
    batchNumber: null,
    imageUrl: null,
    isListedOnline: false,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...over,
  }) as Product;

describe('what a field means', () => {
  // MUTATION: make an absent entry produce `{ state: 'counted', counted: 0 }`.
  // Blank and zero are different claims -- "I did not count this" against "the
  // shelf was bare" -- and only one of them may overwrite a shelf.
  it('reads a product with no entry as blank, never as zero', () => {
    const row = walkRow(product({ id: 'p-1' }), {});
    expect(row.state).toBe('blank');
    expect(row.counted).toBeNull();
    expect(row.variance).toBeNull();
    expect(row.typed).toBe('');
  });

  // MUTATION: drop the `.trim()` from the blank test, so a field holding a
  // single space classifies as 'unreadable' and blocks a Save nobody can fix.
  it('reads an entry holding only whitespace as blank', () => {
    const entries: CountEntries = { 'p-1': { counted: '  ', reason: null } };
    expect(walkRow(product({ id: 'p-1' }), entries).state).toBe('blank');
  });

  // MUTATION: classify zero as blank. The Count door would then be able to
  // record every loss except a total one.
  it('reads a typed zero as counted, with the whole shelf as the variance', () => {
    const entries: CountEntries = { 'p-1': { counted: '0', reason: null } };
    const row = walkRow(product({ id: 'p-1', stock: 11 }), entries);
    expect(row.state).toBe('counted');
    expect(row.counted).toBe(0);
    expect(row.variance).toBe(-11);
  });

  // MUTATION: classify an unreadable entry as blank. `abc` would then be
  // silently skipped instead of blocking the commit.
  it('reads a non-number as unreadable, not as blank', () => {
    const entries: CountEntries = { 'p-1': { counted: 'abc', reason: null } };
    const row = walkRow(product({ id: 'p-1' }), entries);
    expect(row.state).toBe('unreadable');
    expect(row.counted).toBeNull();
    expect(row.typed).toBe('abc');
  });

  // MUTATION: compute variance as `product.stock - counted`. Every sign on the
  // screen inverts, and a shortfall reads as a surplus.
  it('signs the variance as counted minus what the app believes', () => {
    const entries: CountEntries = { 'p-1': { counted: '14', reason: null } };
    expect(walkRow(product({ id: 'p-1', stock: 11 }), entries).variance).toBe(3);
  });

  // MUTATION: have walkRows iterate `Object.keys(entries)` instead of the
  // catalogue. HAZARD 1's opposite failure -- an entry left behind for a
  // product this store no longer carries would reach the RPC.
  it('walks the catalogue, so an entry for a product the store does not carry is dropped', () => {
    const rows = walkRows([product({ id: 'p-1' })], {
      'p-1': { counted: '8', reason: null },
      'p-gone': { counted: '99', reason: null },
    });
    expect(rows.map((row) => row.product.id)).toEqual(['p-1']);
  });
});

describe('what gets sent', () => {
  // MUTATION: drop the `state === 'counted'` filter so blank rows are planned
  // too. A 240-product catalogue with two counts would zero 238 shelves.
  it('plans only the rows that were counted', () => {
    const catalogue = [product({ id: 'p-1' }), product({ id: 'p-2' }), product({ id: 'p-3' })];
    const rows = walkRows(catalogue, { 'p-2': { counted: '8', reason: 'damaged' } });
    expect(plannedLines(rows).map((line) => line.productId)).toEqual(['p-2']);
  });

  // MUTATION: send `variance` as `countedQuantity`. This is the ADD-instead-of-
  // SET bug the whole Count door exists to prevent.
  it('plans the counted TOTAL, never the change', () => {
    const rows = walkRows([product({ id: 'p-1', stock: 11, name: 'QA widget' })], {
      'p-1': { counted: '8', reason: 'damaged' },
    });
    expect(plannedLines(rows)).toEqual([
      {
        productId: 'p-1',
        productName: 'QA widget',
        previousQuantity: 11,
        countedQuantity: 8,
        variance: -3,
        reason: 'damaged',
        unitCostCents: 461,
      },
    ]);
  });

  // MUTATION: delete the `some(state === 'unreadable')` guard. The footer would
  // then show a total computed over half a walk, presented as the whole thing,
  // and Save would go live on it.
  it('plans nothing at all while any row is unreadable', () => {
    const catalogue = [product({ id: 'p-1' }), product({ id: 'p-2' }), product({ id: 'p-3' })];
    const rows = walkRows(catalogue, {
      'p-1': { counted: '8', reason: null },
      'p-2': { counted: '9', reason: null },
      'p-3': { counted: 'abc', reason: null },
    });
    expect(plannedLines(rows)).toEqual([]);
  });

  // MUTATION: report `unitCostCents: row.product.costCents ?? 0`, so an
  // uncosted product contributes 0 and the shortfall figure understates the
  // loss instead of withholding it.
  it('withholds a unit cost rather than quoting zero for an uncosted product', () => {
    const rows = walkRows([product({ id: 'p-1', costCents: null })], {
      'p-1': { counted: '8', reason: null },
    });
    expect(plannedLines(rows)[0].unitCostCents).toBeNull();
  });

  // MUTATION: have typedRows return every row. The pager's "N counted so far"
  // would read as the whole catalogue.
  it('counts a row as typed when it is counted or unreadable, never when blank', () => {
    const catalogue = [product({ id: 'p-1' }), product({ id: 'p-2' }), product({ id: 'p-3' })];
    const rows = walkRows(catalogue, {
      'p-1': { counted: '8', reason: null },
      'p-3': { counted: 'abc', reason: null },
    });
    expect(typedRows(rows).map((row) => row.product.id)).toEqual(['p-1', 'p-3']);
  });
});

describe('narrowing the list', () => {
  const catalogue = [
    product({ id: 'p-1', name: 'Dr Althea', sku: 'SK-1', category: 'Skincare' }),
    product({ id: 'p-2', name: 'clay mask sachet', sku: 'SK-2', barcode: '5012345', category: 'Skincare' }),
    product({ id: 'p-3', name: 'dish soap', sku: 'HH-1', category: 'Household' }),
  ];

  // MUTATION: drop the category clause. The chips would render and do nothing.
  it('narrows by category', () => {
    expect(filterProducts(catalogue, '', 'Household').map((p) => p.id)).toEqual(['p-3']);
  });

  // MUTATION: match on name only. A shop that searches by SKU or scans a
  // barcode into the box would be told it sells nothing.
  it('matches name, SKU and barcode, case-insensitively', () => {
    expect(filterProducts(catalogue, 'ALTHEA', null).map((p) => p.id)).toEqual(['p-1']);
    expect(filterProducts(catalogue, 'hh-1', null).map((p) => p.id)).toEqual(['p-3']);
    expect(filterProducts(catalogue, '5012345', null).map((p) => p.id)).toEqual(['p-2']);
  });

  // MUTATION: reinstate the old `.slice(0, 12)` the two-step picker carried.
  // With every product a row, a cap is a silent refusal to show the shelf.
  it('caps nothing', () => {
    const many = Array.from({ length: 40 }, (_, i) => product({ id: `p-${i}`, name: `QA ${i}` }));
    expect(filterProducts(many, '', null)).toHaveLength(40);
  });

  // MUTATION: return `[]` for an empty query instead of everything. An
  // untouched search box is the ordinary state of this screen.
  it('returns the whole catalogue for an empty query', () => {
    expect(filterProducts(catalogue, '   ', null)).toHaveLength(3);
  });
});

describe('paging', () => {
  const items = Array.from({ length: 240 }, (_, i) => i);

  // MUTATION: change COUNT_PAGE_SIZE to 12. The threshold below which the
  // pager is absent moves with it, and most shops on the platform grow a
  // control the design says they should never see.
  it('pages a hundred at a time', () => {
    expect(COUNT_PAGE_SIZE).toBe(100);
  });

  // MUTATION: off-by-one either `from` or `to`. "Showing 1-100 of 240" is the
  // only thing on screen that says how much of the shop is not visible.
  it('reports the window it is showing, one-based and inclusive', () => {
    expect(pageSlice(items, 1, 100)).toMatchObject({ page: 1, pageCount: 3, from: 1, to: 100 });
    expect(pageSlice(items, 2, 100)).toMatchObject({ page: 2, pageCount: 3, from: 101, to: 200 });
    expect(pageSlice(items, 3, 100)).toMatchObject({ page: 3, pageCount: 3, from: 201, to: 240 });
    expect(pageSlice(items, 3, 100).items).toEqual(items.slice(200));
  });

  // MUTATION: delete the clamp. A catalogue that shrinks under a filter while
  // the page number stays put renders an empty list with no explanation.
  it('clamps a page past the end onto the last page rather than showing nothing', () => {
    expect(pageSlice(items, 9, 100)).toMatchObject({ page: 3, from: 201, to: 240 });
    expect(pageSlice(items, 0, 100)).toMatchObject({ page: 1, from: 1, to: 100 });
  });

  // MUTATION: drop the `Math.max(1, ...)` from pageCount, so an empty list
  // reports 0 pages and `Next` goes live over nothing.
  it('reports one page for an empty list, showing nothing', () => {
    expect(pageSlice([], 1, 100)).toEqual({ page: 1, pageCount: 1, items: [], from: 0, to: 0 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/lib/__tests__/count-walk.test.ts`
Expected: FAIL — `Cannot find module '@/lib/count-walk'`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/count-walk.ts`:

```ts
import type { PlannedCountLine } from '@/lib/count-import';
import { isUncosted } from '@/lib/product-costing';
import { readCountedQuantity } from '@/lib/restock-typed-input';
import type { Product, StockCountReason } from '@/types/models';

// What a by-hand stock-take amounts to, with nothing rendered.
//
// The one rule this file exists to hold: WHAT HAS BEEN TYPED BELONGS TO THE
// PRODUCT, NOT TO THE ROW. `CountEntries` is keyed by product id, and every
// function here takes the catalogue it should walk as an argument. Nothing in
// this file knows what is on screen, which is the point -- a count typed on
// page 1 and dropped by paging to page 2 is invisible until a shelf comes out
// wrong, and state tied to what is rendered is exactly how that happens.
//
// The three states a field can be in are the whole design of the by-hand tab:
//
//   blank      -- nobody counted this product. It is skipped and the product is
//                 left exactly as it was. This is the DEFAULT, and it is why an
//                 untouched field renders a dash rather than a number.
//   counted    -- a whole number, INCLUDING ZERO. Zero is a claim (the shelf is
//                 bare) and it commits.
//   unreadable -- something is in the field and it is not a count. `abc` is a
//                 mistake, not a decision, so it blocks the commit rather than
//                 being quietly skipped the way a blank is.

export type CountEntry = {
  // The RAW string the person typed, never a parsed number and never rewritten
  // on the way in. See restock-typed-input.ts for why that is the whole design
  // of this screen's input handling.
  counted: string;
  reason: StockCountReason | null;
};

export type CountEntries = Record<string, CountEntry>;

export type CountRowState = 'blank' | 'counted' | 'unreadable';

export type CountRow = {
  product: Product;
  typed: string;
  reason: StockCountReason | null;
  state: CountRowState;
  // The reading, or null when there is none -- blank and unreadable alike.
  counted: number | null;
  variance: number | null;
};

// A hundred rows, each carrying a TextInput, is what a phone renders without
// complaint. It is also the threshold below which the pager is absent entirely:
// most shops on the platform carry fewer than a hundred products, so for most
// of them there is no pager and nothing new to learn.
export const COUNT_PAGE_SIZE = 100;

export function walkRow(product: Product, entries: CountEntries): CountRow {
  const entry = entries[product.id];
  const typed = entry?.counted ?? '';
  const reason = entry?.reason ?? null;
  if (typed.trim() === '') {
    return { product, typed, reason, state: 'blank', counted: null, variance: null };
  }
  const counted = readCountedQuantity(typed);
  if (counted === null) {
    return { product, typed, reason, state: 'unreadable', counted: null, variance: null };
  }
  return { product, typed, reason, state: 'counted', counted, variance: counted - product.stock };
}

export function walkRows(catalogue: Product[], entries: CountEntries): CountRow[] {
  return catalogue.map((product) => walkRow(product, entries));
}

// Rows the person has touched, whether or not what they typed reads. Used for
// the "N counted so far, on any page" figure and for the Save caption -- both
// of which are about the walk, not about what will commit.
export function typedRows(rows: CountRow[]): CountRow[] {
  return rows.filter((row) => row.state !== 'blank');
}

// The plan this walk amounts to, in exactly the shape the sheet tab builds --
// so one summariseCount serves both tabs and the two can never disagree about
// what "2 differ" or "$13.83 of shortfall" means.
//
// EMPTY while any row is unreadable, deliberately. A summary computed over the
// readable half of a walk is a smaller number presented as the whole thing,
// sitting directly under a live per-row variance -- a contradiction, not an
// honest partial total. The caller gates Save on this being non-empty, so the
// same rule blocks the commit and empties the footer.
export function plannedLines(rows: CountRow[]): PlannedCountLine[] {
  if (rows.some((row) => row.state === 'unreadable')) return [];
  return rows
    .filter((row) => row.state === 'counted')
    .map((row) => ({
      productId: row.product.id,
      productName: row.product.name,
      previousQuantity: row.product.stock,
      countedQuantity: row.counted!,
      variance: row.variance!,
      reason: row.reason,
      // Null, never zero: zero is a real answer (a free sample), which is the
      // distinction isUncosted exists to keep.
      unitCostCents: isUncosted(row.product) ? null : row.product.costCents,
    }));
}

// Name, SKU or barcode, and the category chips. Deliberately UNCAPPED: the
// two-step picker sliced to 12 because it was a search-results list you added
// from, and one list of everything is the opposite -- a cap here is a silent
// refusal to show a shelf someone is standing in front of.
export function filterProducts(catalogue: Product[], search: string, category: string | null): Product[] {
  const query = search.trim().toLowerCase();
  return catalogue.filter(
    (product) =>
      (category === null || product.category === category) &&
      (!query ||
        product.name.toLowerCase().includes(query) ||
        (product.sku ?? '').toLowerCase().includes(query) ||
        (product.barcode ?? '').toLowerCase().includes(query))
  );
}

// One page of an already-filtered list, plus everything the pager row has to
// say about it.
//
// The page number is CLAMPED rather than trusted. The caller resets to page 1
// whenever the filter changes, but a catalogue can also shrink underneath a
// page number for reasons the caller does not drive -- a reload after a product
// is deleted, a store with fewer products. An unclamped slice renders an empty
// list with a pager insisting there are 240 products, and there is nothing on
// screen to say which is lying.
export function pageSlice<T>(
  items: T[],
  page: number,
  size: number
): { page: number; pageCount: number; items: T[]; from: number; to: number } {
  const pageCount = Math.max(1, Math.ceil(items.length / size));
  const clamped = Math.min(Math.max(1, Math.trunc(page)), pageCount);
  const start = (clamped - 1) * size;
  const slice = items.slice(start, start + size);
  return {
    page: clamped,
    pageCount,
    items: slice,
    from: slice.length === 0 ? 0 : start + 1,
    to: start + slice.length,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/lib/__tests__/count-walk.test.ts`
Expected: PASS, 19 tests.

- [ ] **Step 5: Run each named mutation**

For every `MUTATION:` comment in the test file, apply the change to `src/lib/count-walk.ts`, run `npx jest src/lib/__tests__/count-walk.test.ts`, confirm the named test goes RED, then `git checkout src/lib/count-walk.ts` and re-apply the correct implementation. A mutation that leaves the suite green is a test that cannot fail — fix the test, not the mutation.

- [ ] **Step 6: Verify the baselines**

Run: `npx tsc --noEmit && npm run lint 2>&1 | tail -3 && npm test 2>&1 | tail -5`
Expected: tsc clean; lint still `76 problems`; tests `134 passed, 134 total` suites and `2016 passed` tests (1997 + 19).

- [ ] **Step 7: Commit**

```bash
git add src/lib/count-walk.ts src/lib/__tests__/count-walk.test.ts
git commit -m "feat(inventory): what a counted field means, without a render"
```

---

### Task 2: One list — every product is a row, and blank means nobody counted it

The two-step flow goes. `lines: Line[]`, `addLine`, `removeLine`, `MatchRow` and the pre-fill are deleted; `entries: CountEntries` and one row per catalogue product take their place. This task is one commit because the file cannot compile half-migrated — but every step in it is small.

`×`, `Clear all` and paging are **not** in this task (Tasks 3 and 4). The reason chip stays exactly as it is today for now.

**Files:**
- Modify: `src/components/stock-count-modal.tsx` — header comment `:38-62`; types `:64-69`; state `:90-102`; the load effect `:136-186`; `closeAndReset` `:198-214`; `addLine`/`setCounted`/`setReason`/`removeLine` `:216-250`; `matches` `:252-264`; `readings`/`everyCountReads`/`handLines` `:266-304`; `submit` `:336-399`; `downloadSheet`'s pre-fill `:443-463`; `uploadSheet`'s handover `:510-543`; the by-hand render `:690-780`; the by-hand footer `:806-844`; `countHint` `:901-907`; `MatchRow` `:909-926`; `LineRow` `:928-1004`; styles `:1254-1323`.
- Test: `src/components/__tests__/stock-count-modal.test.tsx`

**Interfaces:**
- Consumes from Task 1: `walkRow`, `walkRows`, `typedRows`, `plannedLines`, `filterProducts`, `type CountEntries`, `type CountRow` — signatures exactly as in Task 1's Produces block.
- Produces, for Tasks 3–5 (all inside `StockCountModal`'s body unless noted):
  ```ts
  const [entries, setEntries] = useState<CountEntries>({});
  const updateEntries: (next: (current: CountEntries) => CountEntries) => void;
  const rows: CountRow[];                 // walkRows(catalogue, entries) -- WHOLE catalogue
  const typed: CountRow[];                // typedRows(rows)
  const unreadable: number;
  const handLines: PlannedCountLine[];    // plannedLines(rows)
  const handSummary: CountSummary;        // summariseCount(handLines)
  const handExpenseCents: number | null;  // the one stock-loss gate, read by the panel AND by submit
  const filtered: Product[];              // filterProducts(catalogue, search, category)
  const setCounted: (productId: string, text: string) => void;
  const setReason: (productId: string, reason: StockCountReason) => void;
  const canSubmit: boolean;
  ```
  and, at module scope:
  ```ts
  function CountRowView(props: {
    row: CountRow;
    reasonOpen: boolean;
    onToggleReason: () => void;
    onCounted: (text: string) => void;
    onReason: (reason: StockCountReason) => void;
  }): JSX.Element;
  function countHint(typedCount: number, unreadable: number, summary: CountSummary): string;
  ```
  Accessibility labels other tasks and tests rely on: the counted field keeps `aria-label={`Counted units of ${name}`}`; the search box gains `aria-label="Search products"`; the reason chip keeps `accessibilityLabel={`Reason for ${name}`}`; the Save button keeps `accessibilityLabel="Save counts"`.

- [ ] **Step 1: Replace the imports and the type block**

In `src/components/stock-count-modal.tsx`, remove `readCountedQuantity` from the `@/lib/restock-typed-input` import (delete the whole import line — the component no longer reads text itself) and add:

```ts
import {
  filterProducts,
  plannedLines,
  typedRows,
  walkRow,
  walkRows,
  type CountEntries,
  type CountRow,
} from '@/lib/count-walk';
```

Delete the `Line` and `LineReading` types at `:64-69`, keeping `type Tab = 'hand' | 'sheet';`.

- [ ] **Step 2: Rewrite the file's header comment**

Replace lines 38-62 (the block comment above `type Tab`) with:

```ts
// A stock-take, by hand or by spreadsheet.
//
// The by-hand tab is ONE LIST. Every product the store carries is already a
// row with a field in it, and typing a number IS counting it -- there is no
// "add to a basket" step, because the catalogue and the basket were the same
// products listed twice.
//
// That makes BLANK the default state of almost every row, and blank has to
// mean something exact: NOBODY COUNTED THIS PRODUCT, and the product is left
// exactly as it was. It is not zero. Zero is a claim -- the shelf is bare --
// and it commits, which is why an untouched field renders a dash and a typed
// zero renders 0. See src/lib/count-walk.ts, which holds that rule.
//
// (An earlier version of this screen PRE-FILLED each field with what the app
// believed, and argued that a row left untouched meant "I looked, it matched".
// That was true when a row only existed because you pressed `Count` on it --
// the act of adding it was the statement. With every product already a row it
// would mean the app had counted every shelf in the shop on its own.)
//
// What has been typed belongs to the PRODUCT, not to the row: `entries` is
// keyed by product id, and Save sends everything typed across every page,
// never what happens to be rendered. A count typed on page 1 and dropped by
// paging to page 2 is invisible until a shelf comes out wrong.
//
// The VARIANCE is a column, not a footnote. The person doing the count does
// not need to be told the 8 they just counted. What they need to see, and what
// they will be asked about, is how far off the app was.
//
// Not built here, deliberately: scanning. The mockup does not propose it, and
// the equivalent work on the restock sheet cost a CRITICAL to get right -- a
// scan landing in a number field while the same product's row was focused read
// the barcode as the quantity. Inventory's own wedge still stands down for the
// whole time this sheet is open (inventory.tsx's `enabled`), so a scan fired
// here does nothing rather than something wrong.
```

- [ ] **Step 3: Swap the state model**

Replace lines 90-102 (`const [lines, setLines] …` through the end of `updateLines`) with:

```ts
  // Keyed by PRODUCT ID, never by row index and never derived from what is on
  // screen. This is the whole of the paging guarantee: filtering, searching and
  // paging all change which rows render and none of them can touch this.
  const [entries, setEntries] = useState<CountEntries>({});
  // Every write goes through one helper that runs its updater immediately and
  // stores the result in both the ref and the state, so a handler reading what
  // has been typed never reads a render behind.
  const entriesRef = useRef(entries);
  useEffect(() => {
    entriesRef.current = entries;
  }, [entries]);
  const updateEntries = useCallback((next: (current: CountEntries) => CountEntries) => {
    const value = next(entriesRef.current);
    entriesRef.current = value;
    setEntries(value);
  }, []);
```

- [ ] **Step 4: Simplify the load effect and the store-transition guard**

Replace the comment block and effect at lines 136-186 with:

```ts
  // A typed count is a claim about a specific shelf -- "App says 11, I found 8"
  // -- and that claim does not carry to a different store just because the two
  // happen to stock a product with the same id. Change the store from one
  // holding 11 to one holding 3 and a surviving "11" would be "found 11 at a
  // shelf nobody walked", ready to overwrite the new store's real count on
  // Save. Losing what was typed is the correct outcome of a store change.
  //
  // `lastLocationRef` is what tells an actual transition apart from this
  // effect's ordinary re-runs (first mount, a product added mid-session
  // triggering a reload) -- both of which must NOT clear a walk someone is
  // mid-typing. It starts equal to the initial `locationId`, so mount never
  // reads as a change, and it is only ever compared against the `locationId`
  // this render closed over, which is exactly the value `load` was rebuilt for.
  // The sheet tab's handover pins it deliberately; see `uploadSheet`.
  //
  // Nothing re-points a product snapshot any more: `entries` holds text and a
  // reason, and every "App says" is read off `catalogue` at render. Replacing
  // `catalogue` IS the re-point.
  const lastLocationRef = useRef(locationId);
  useEffect(() => {
    if (!visible) return;
    let active = true;
    const storeChanged = lastLocationRef.current !== locationId;
    lastLocationRef.current = locationId;
    if (storeChanged) {
      updateEntries(() => ({}));
      setReasonOpenFor(null);
    }
    load()
      .then((rows) => {
        if (active) setCatalogue(rows);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [visible, load, updateEntries, locationId]);
```

- [ ] **Step 5: Rewrite the setters**

Replace lines 216-250 (`addLine` through `removeLine`) with:

```ts
  // Stores the keystrokes and nothing else. Rewriting text inside onChangeText
  // on a controlled input cannot work: the rewritten string is what the NEXT
  // keystroke is appended to, so a number is reinterpreted before it has
  // finished being typed.
  //
  // An emptied field leaves the ENTRY in place holding a blank string rather
  // than deleting it, so a reason chosen beside it survives a backspace and is
  // there again when the number is retyped. A blank entry is still blank -- see
  // walkRow -- so nothing is sent for it.
  const setCounted = (productId: string, text: string) => {
    updateEntries((current) => ({
      ...current,
      [productId]: { counted: text, reason: current[productId]?.reason ?? null },
    }));
  };

  // Picking the reason a row already carries clears it, so a mis-tap is
  // undoable without a sixth "None" chip pretending to be a reason. A reason
  // cannot be given to a row nobody has counted: the sheet planner rejects
  // exactly that shape ("Reason is filled in but Counted is empty"), and the
  // two tabs must not disagree about it.
  const setReason = (productId: string, reason: StockCountReason) => {
    updateEntries((current) => {
      const entry = current[productId];
      if (!entry) return current;
      return { ...current, [productId]: { ...entry, reason: entry.reason === reason ? null : reason } };
    });
    setReasonOpenFor(null);
  };
```

- [ ] **Step 6: Replace `matches` and the readings block**

Replace lines 252-304 (`matches` through `canSubmit`) with:

```ts
  // The WHOLE store, walked once. Not `filtered`, and not the page slice: the
  // footer, the Save caption and the commit are about the stock-take, not about
  // what is scrolled into view.
  const rows = useMemo(() => walkRows(catalogue, entries), [catalogue, entries]);
  const typed = useMemo(() => typedRows(rows), [rows]);
  const unreadable = useMemo(() => typed.filter((row) => row.state === 'unreadable').length, [typed]);
  const handLines = useMemo(() => plannedLines(rows), [rows]);
  const handSummary = useMemo(() => summariseCount(handLines), [handLines]);

  // Which products are on screen. Separate from `rows` on purpose -- this is
  // the only thing search and the category chips are allowed to change.
  const filtered = useMemo(() => filterProducts(catalogue, search, category), [catalogue, search, category]);

  // `plannedLines` is empty both when nothing has been counted and when
  // anything is unreadable, so one non-empty check carries both rules: at least
  // one row reads, and none of them is gibberish.
  const canSubmit = Boolean(locationId) && handLines.length > 0 && !busy;

  // The one stock-loss gate, read by the footer's disclosure and by `submit`
  // alike. Written once so the two cannot drift: a panel promising a P&L row
  // that never lands, or hiding one that does, is worse than either behaviour
  // on its own. `shortfallCents` goes null the moment a short line is uncosted,
  // which is why the tick alone is never trusted.
  const handExpenseCents =
    logExpense && handSummary.shortfallCents !== null && handSummary.shortfallCents > 0
      ? handSummary.shortfallCents
      : null;
```

- [ ] **Step 7: Rewrite `submit`'s post-commit block**

In `submit` (lines 336-399), leave the `try`/`catch` around `saveStockCount` exactly as it is — **only** the write is inside it and the `try` ends the moment it resolves (HAZARD 3). Change three things:

Replace `updateLines(() => []);` at line 374 with `updateEntries(() => ({}));`, and replace the expense block at lines 378-385 with:

```ts
    // Only after the numbers are in, and only if the offer was actually on
    // screen. `handExpenseCents` is the same expression the footer disclosed,
    // re-read here rather than trusting `logExpense` alone: the tick survives
    // an edit that turns a shortfall into a match, and a checkbox merely
    // disappearing must not leave a stale yes behind it.
    const expenseProblem = handExpenseCents !== null ? await logStockLoss(locationId, handExpenseCents) : null;
```

Add `setError(null);` is already there; also update the comment at line 372-373 to read `// The numbers are IN. What was typed is spent from here on, and it is` / `// cleared before anything that can fail.`

- [ ] **Step 8: Re-point the two sheet-tab call sites**

In `downloadSheet`, replace lines 452-459 with:

```ts
                const chosen =
                  row.location.id === locationId ? entries[row.product.id] : undefined;
                // A blank entry writes BOTH columns empty. A Reason on a row
                // with no Counted is the one shape planCount rejects outright
                // ("Reason is filled in but Counted is empty"), and a sheet
                // this screen produced must not come back rejected.
                if (!chosen || chosen.counted.trim() === '') return '';
                // `counted` is already the raw string the person typed -- see
                // CountEntry. It needs no converting on the way out.
                return column.header === 'Counted' ? chosen.counted : chosen.reason ? reasonLabel(chosen.reason) : '';
```

In `uploadSheet`'s handover, replace `updateLines(...)` at lines 526-538 with:

```ts
      updateEntries(() =>
        Object.fromEntries(
          count.lines
            // A line for a product this store does not carry has no shelf to
            // walk to, and `walkRows` would drop it anyway.
            .filter((line) => byId.has(line.productId))
            // The field holds the RAW string a person typed, so a planned
            // number is turned back into text on the way in.
            .map((line) => [line.productId, { counted: String(line.countedQuantity), reason: line.reason }])
        )
      );
      // The handover fills rows scattered through the whole catalogue. A search
      // or a category left over from before would hide every one of them and
      // the notice below would name lines nobody can see.
      setSearch('');
      setCategory(null);
```

- [ ] **Step 9: Reset the new state on close**

In `closeAndReset` (lines 198-214), replace `updateLines(() => []);` with `updateEntries(() => ({}));`.

- [ ] **Step 10: Rewrite the by-hand render**

Replace lines 697-770 (from `<Text style={[styles.label, styles.labelSpaced]}>ADD PRODUCTS</Text>` through the closing `)}` of the basket block) with:

```tsx
                {/* Deliberately not ScanSafeField -- no scan path is offered here,
                    and wrapping a field in a scan guard that can never fire is a
                    component pretending to do something. */}
                <TextInput
                  value={search}
                  onChangeText={setSearch}
                  placeholder="Search by name, SKU or barcode…"
                  placeholderTextColor="#999999"
                  aria-label="Search products"
                  style={[styles.input, styles.inputSpaced]}
                />
                {categories.length > 0 && (
                  <ScrollView
                    horizontal
                    showsHorizontalScrollIndicator={false}
                    style={styles.chipScroll}
                    contentContainerStyle={styles.chips}
                  >
                    <CategoryChip label="All" active={category === null} onPress={() => setCategory(null)} />
                    {categories.map((item) => (
                      <CategoryChip
                        key={item}
                        label={item}
                        active={category === item}
                        onPress={() => setCategory(item)}
                      />
                    ))}
                  </ScrollView>
                )}

                {filtered.length === 0 ? (
                  <Text style={styles.empty}>
                    {search.trim() || category !== null
                      ? 'Nothing here matches that.'
                      : 'This store carries nothing to count yet.'}
                  </Text>
                ) : (
                  <View style={styles.listWrap}>
                    {/* One COUNTED / OFF BY / WHY header for the whole list, not
                        one per row. Widths (62 / 58 / 108 / 28) and the 8px gap
                        mirror qtyPair's own field / varianceBox / reasonChip /
                        clear so the labels sit directly over their columns. */}
                    <View style={styles.columnHeaderRow}>
                      <View style={styles.columnHeaderSpacer} />
                      <View style={styles.columnHeaderCaps}>
                        <Text style={[styles.cap, styles.capField]}>COUNTED</Text>
                        <Text style={[styles.cap, styles.capVariance]}>OFF BY</Text>
                        <Text style={[styles.cap, styles.capChip]}>WHY</Text>
                        <View style={styles.capClear} />
                      </View>
                    </View>
                    <View style={styles.listRows}>
                      {filtered.map((item) => (
                        <CountRowView
                          key={item.id}
                          row={walkRow(item, entries)}
                          reasonOpen={reasonOpenFor === item.id}
                          onToggleReason={() =>
                            setReasonOpenFor((current) => (current === item.id ? null : item.id))
                          }
                          onCounted={(text) => setCounted(item.id, text)}
                          onReason={(reason) => setReason(item.id, reason)}
                        />
                      ))}
                    </View>
                  </View>
                )}
```

- [ ] **Step 11: Rewrite the by-hand footer**

Replace lines 806-844 (the `tab === 'hand' ? (...)` branch of the footer) with:

```tsx
              <>
                {/* Hidden while anything is unreadable: `handLines` is `[]` then
                    (see plannedLines) and every figure here would read as zero
                    sitting directly under a live per-row variance -- a
                    contradiction, not an honest partial total. Nothing typed at
                    all is still allowed through as zeroes, which is the honest
                    reading of a walk not started. */}
                {handLines.length > 0 && (
                  <View style={styles.basket}>
                    <View style={styles.basketCap}>
                      <Text style={styles.basketCapLabel}>VARIANCE</Text>
                      <Text style={styles.basketCapTotal}>
                        {`${varianceText(handSummary.varianceUnits)} · ${varianceMoneyText(handSummary.varianceCents)}`}
                      </Text>
                    </View>
                    <Text style={styles.lineMeta}>
                      {`${handSummary.counted} counted · ${handSummary.matched} matched · ${handSummary.differ} differ · ${catalogue.length - handSummary.counted} left alone. Nothing changes until you press Save.`}
                    </Text>
                  </View>
                )}
                <View style={styles.footerRow}>
                  <View style={styles.footerTotal}>
                    <Text style={styles.footerTotalText}>
                      {`Save ${typed.length} count${typed.length === 1 ? '' : 's'}`}
                    </Text>
                    <Text style={styles.footerTotalHint}>{countHint(typed.length, unreadable, handSummary)}</Text>
                  </View>
                  <Pressable
                    onPress={submit}
                    disabled={!canSubmit}
                    style={[styles.primary, !canSubmit && styles.disabled]}
                    accessibilityLabel="Save counts"
                  >
                    <Text style={styles.primaryText}>{busy ? 'Saving…' : 'Save counts'}</Text>
                  </Pressable>
                </View>
              </>
```

- [ ] **Step 12: Rewrite `countHint`, delete `MatchRow`, replace `LineRow`**

Replace `countHint` (lines 901-907) with:

```ts
// The line under the count, which is also the only place a blocked commit is
// explained. Ordered by what the person has to do next. A BLANK row is never
// mentioned, because a blank row is not a problem -- it is a product nobody
// counted, and on a 240-product catalogue that is almost all of them.
function countHint(typedCount: number, unreadable: number, summary: CountSummary): string {
  if (typedCount === 0) return 'Nothing counted yet';
  if (unreadable > 0) {
    return unreadable === 1
      ? 'One line is not a whole number — just the digits'
      : `${unreadable} lines are not whole numbers — just the digits`;
  }
  return `${summary.differ} will change a number`;
}
```

Delete `MatchRow` entirely (lines 909-926). Replace `LineRow` (lines 928-1004) with:

```tsx
function CountRowView({
  row,
  reasonOpen,
  onToggleReason,
  onCounted,
  onReason,
}: {
  row: CountRow;
  reasonOpen: boolean;
  onToggleReason: () => void;
  onCounted: (text: string) => void;
  onReason: (reason: StockCountReason) => void;
}) {
  const touched = row.state !== 'blank';
  // One of three tints, never colour alone: the sign inside `varianceText`
  // (−2 / +3 / 0) survives for a deutan viewer even where red and green do
  // not, so the box's background and the box's own text colour always agree on
  // the same direction rather than one of them carrying it alone.
  const direction = row.variance === null || row.variance === 0 ? 'flat' : row.variance > 0 ? 'up' : 'down';
  const varianceBoxStyle = !touched
    ? styles.varianceBoxNone
    : direction === 'up'
      ? styles.varianceBoxUp
      : direction === 'down'
        ? styles.varianceBoxDown
        : styles.varianceBoxFlat;
  const varianceColorStyle = !touched
    ? styles.varianceNone
    : direction === 'up'
      ? styles.varianceUp
      : direction === 'down'
        ? styles.varianceDown
        : styles.varianceFlat;
  return (
    <View style={[styles.countRow, touched && styles.countRowCounted]}>
      <View style={styles.lineRow}>
        <View style={styles.lineText}>
          <Text style={styles.lineName}>{row.product.name}</Text>
          <Text style={styles.lineMeta}>{`App says ${row.product.stock}`}</Text>
        </View>
        <View style={styles.qtyPair}>
          {/* `placeholder`, never a value: the field's `value` stays '' for an
              uncounted row, so blank and a typed 0 can never be confused by
              anything reading this component -- including the commit. */}
          <TextInput
            value={row.typed}
            onChangeText={onCounted}
            keyboardType="number-pad"
            inputMode="numeric"
            selectTextOnFocus
            placeholder="—"
            placeholderTextColor="#B6B6BC"
            aria-label={`Counted units of ${row.product.name}`}
            style={[styles.qtyInput, !touched && styles.qtyInputBlank]}
          />
          <View style={[styles.varianceBox, varianceBoxStyle]}>
            <Text style={[styles.varianceText, varianceColorStyle]}>
              {touched ? varianceText(row.variance) : '·'}
            </Text>
          </View>
          <Pressable
            onPress={onToggleReason}
            style={styles.reasonChip}
            accessibilityRole="button"
            accessibilityLabel={`Reason for ${row.product.name}`}
          >
            <Text style={styles.reasonChipText}>{row.reason ? reasonLabel(row.reason) : 'Reason'}</Text>
          </Pressable>
        </View>
      </View>
      {reasonOpen && (
        <View style={styles.reasonRow}>
          {COUNT_REASONS.map(({ key, label }) => (
            <Pressable
              key={key}
              onPress={() => onReason(key)}
              style={styles.reasonOption}
              accessibilityRole="button"
              accessibilityLabel={`Reason: ${label}`}
            >
              <Text style={styles.reasonOptionText}>{label}</Text>
            </Pressable>
          ))}
        </View>
      )}
    </View>
  );
}
```

- [ ] **Step 13: Update the styles**

In the `StyleSheet` at the bottom, delete `lineWrap`, `add`, `remove` and `removeText` (all four were `MatchRow`/`LineRow`-only). Rename `basketWrap` → `listWrap`, `basketList` → `listRows`, `basketCard` → `countRow`. Keep `basket`, `basketCap`, `basketCapLabel` and `basketCapTotal` — those are the footer's VARIANCE block and are still used. Add:

```ts
  inputSpaced: { marginTop: 16 },
  capClear: { width: 28 },
  countRowCounted: { backgroundColor: '#F7F7F7' },
  qtyInputBlank: { backgroundColor: '#F2F2F2' },
  varianceBoxNone: { backgroundColor: 'transparent' },
  varianceNone: { color: '#B6B6BC' },
```

and change `countRow` (the renamed `basketCard`) to drop its background, which now comes from `countRowCounted`:

```ts
  // Untinted until something is typed into it. The tint IS the signal that a
  // row has been counted, on a list where almost every row has not been.
  countRow: { borderRadius: 14, paddingHorizontal: 14 },
```

- [ ] **Step 14: Migrate the component test file**

In `src/components/__tests__/stock-count-modal.test.tsx`:

Replace the `open` helper (lines 139-150) with:

```tsx
async function open(products = [product({})]): Promise<ReactTestRenderer> {
  listProducts.mockResolvedValue(products);
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = create(
      <StockCountModal visible shopId="shop-1" onClose={() => {}} onDone={async () => {}} />
    );
  });
  return tree;
}
```

Then delete every `await act(async () => pressableLabelled(tree, 'Count …').props.onPress());` line in the file (there are seven: `:148`, `:309`, `:323`, `:286`, `:402`, `:775`, `:821`, `:857`) and every `await backspace(tree, COUNTED, 2)` that was clearing a pre-filled `11` (the field now starts empty) — but **keep** the `backspace` calls that exist to test emptying, and keep the `backspace(tree, COUNTED, 1)` calls that shorten an already-typed value.

Replace the first two tests of `describe('a line added to a count')` with:

```tsx
  // The pre-fill is gone, and this is the rule the whole redesign turns on. A
  // field seeded with what the app believes would mean the app had counted
  // every shelf in the shop on its own.
  //
  // MUTATION: seed the field with `String(product.stock)`. This test goes red
  // on the value; the 'skips a product nobody counted' test below goes red on
  // what reaches the RPC.
  it('starts blank, so a row nobody has touched is a product nobody counted', async () => {
    const tree = await open();
    const field = fieldNamed(tree, COUNTED);
    expect(field.props.value).toBe('');
    // Blank and zero must never look alike: the DASH is a placeholder, so the
    // value stays '' and nothing downstream can read it as a count.
    expect(field.props.placeholder).toBe('—');
    expect(allText(tree)).toContain('App says 11');
    expect(allText(tree)).toContain('Nothing counted yet');
  });

  // MUTATION: have `plannedLines` include blank rows. On a real catalogue that
  // is 238 shelves zeroed by a walk that touched two of them.
  it('skips a product nobody counted and sends only the row that was typed', async () => {
    const tree = await open([
      product({}),
      product({ id: 'p-2', name: 'QA other', sku: 'QA-2', stock: 5 }),
    ]);
    await type(tree, 'Counted units of QA other', '4');
    await act(async () => pressableLabelled(tree, 'Save counts').props.onPress());
    expect(saveStockCount).toHaveBeenCalledWith(
      'shop-1',
      'loc-1',
      [{ productId: 'p-2', countedQuantity: 4, reason: null }],
      { note: null }
    );
  });

  // MUTATION: make `canSubmit` true when `handLines` is empty. Saving nothing
  // writes a stock-take record against a shelf nobody walked.
  it('refuses to save a catalogue nobody has typed into', async () => {
    const tree = await open();
    expect(pressableLabelled(tree, 'Save counts').props.disabled).toBe(true);
    expect(allText(tree)).toContain('Save 0 counts');
    await act(async () => pressableLabelled(tree, 'Save counts').props.onPress());
    expect(saveStockCount).not.toHaveBeenCalled();
  });

  // MUTATION: classify an unreadable entry as blank in `walkRow`. `abc` would
  // be silently skipped and the shop would believe it counted that shelf.
  it('blocks the save on an unreadable entry, and says which', async () => {
    const tree = await open([
      product({}),
      product({ id: 'p-2', name: 'QA other', sku: 'QA-2', stock: 5 }),
    ]);
    await type(tree, COUNTED, '8');
    await type(tree, 'Counted units of QA other', 'abc');
    expect(allText(tree)).toContain('One line is not a whole number');
    expect(pressableLabelled(tree, 'Save counts').props.disabled).toBe(true);
    await act(async () => pressableLabelled(tree, 'Save counts').props.onPress());
    expect(saveStockCount).not.toHaveBeenCalled();
  });
```

Replace `keeps the row and its reason when the field is emptied` with:

```tsx
  // An emptied field returns the row to "not counted" -- but the reason chosen
  // beside it survives, so a backspace to retype a number does not silently
  // take the shop's own word for what happened with it.
  //
  // MUTATION: delete the entry outright in `setCounted` when the text is empty.
  // The reason is lost on the first backspace and comes back as 'Reason'.
  it('returns an emptied row to not-counted, and gives the reason back when it is retyped', async () => {
    const tree = await open();
    await type(tree, COUNTED, '8');
    await act(async () => pressableLabelled(tree, 'Reason for QA widget').props.onPress());
    await act(async () => pressableLabelled(tree, 'Reason: Damaged').props.onPress());
    await backspace(tree, COUNTED, 1);
    expect(fieldNamed(tree, COUNTED).props.value).toBe('');
    expect(allText(tree)).toContain('Nothing counted yet');
    await type(tree, COUNTED, '9');
    expect(allText(tree)).toContain('Damaged');
  });
```

Update the remaining tests mechanically: `never rewrites the text between keystrokes` starts from an empty field (drop the leading `backspace(…, 2)` and its assertion); `accepts a counted zero`, `shows the variance live and signed`, the tint test and the sign test all drop their leading `backspace(…, 2)`; `renders the COUNTED header once…` drops the `Count QA other` press.

In `describe('closing the sheet')`, replace the assertion body with:

```tsx
    // Every field is blank again. The ROW still renders -- every product is a
    // row now -- so the field's value is what proves the walk was reset, not
    // the row's absence.
    // MUTATION: drop `updateEntries(() => ({}))` from `closeAndReset`. The next
    // stock-take opens holding the last one's numbers under a live Save button.
    expect(fieldNamed(tree, COUNTED).props.value).toBe('');
    expect(allText(tree)).toContain('Save 0 counts');
```

In `describe('changing the store')`, the first test's mid-assertions become:

```tsx
    await type(tree, COUNTED, '11');
    await act(async () => pressableWithText(tree, 'Main').props.onPress());
    await act(async () => pressableWithText(tree, 'Branch').props.onPress());

    // The row is still on screen -- it is Branch's row now -- and it is blank.
    // MUTATION: remove the `storeChanged` branch's `updateEntries(() => ({}))`.
    // The stale 11 sits in a field captioned "App says 3", ready to overwrite a
    // shelf nobody walked, and the commit below sends 11 instead of 3.
    expect(fieldNamed(tree, COUNTED).props.value).toBe('');
    expect(allText(tree)).toContain('App says 3');

    await type(tree, COUNTED, '3');
    await act(async () => pressableLabelled(tree, 'Save counts').props.onPress());
    expect(saveStockCount).toHaveBeenCalledWith(
      'shop-1',
      'loc-2',
      [{ productId: 'p-1', countedQuantity: 3, reason: null }],
      { note: null }
    );
```

and `does not clear the basket when the effect re-runs at the same store` keeps its shape, renamed to `does not clear what has been typed when the effect re-runs at the same store`, with the leading `backspace(…, 2)` dropped.

In `describe('saving a count')` and `describe('logging the shortfall')`, drop every leading `backspace(tree, COUNTED, 2)` and every `Count QA widget` press; `does not write when an edit removes the honest total after ticking` becomes `type '8'` → tick → `backspace 1` → `type '11'`.

In `offers the shortfall without netting off the units that were found`, drop both `Count …` presses and both leading `backspace(…, 2)` calls: `type(tree, COUNTED, '8')` and `type(tree, 'Counted units of QA other', '26')`.

The sheet-tab tests need no change beyond the ones above — the handover already sets a value into a field that now always exists.

- [ ] **Step 15: Run the component tests**

Run: `npx jest src/components/__tests__/stock-count-modal.test.tsx`
Expected: PASS. If a test fails on `pressableLabelled(tree, 'Count …')` throwing, a press was left behind — remove it.

- [ ] **Step 16: Run each named mutation**

Apply each `MUTATION:` from Step 14 to `src/components/stock-count-modal.tsx` or `src/lib/count-walk.ts`, confirm the named test goes RED, revert. Additionally, verify the two store-guard directions still bite: comment out the `storeChanged` branch (first test must fail) and then force `storeChanged` to `true` unconditionally (the "effect re-runs at the same store" test must fail).

- [ ] **Step 17: Verify the baselines**

Run: `npx tsc --noEmit && npm run lint 2>&1 | tail -3 && npm test 2>&1 | tail -5`
Expected: tsc clean; lint `76 problems` (if the number rose, an unused style or import was left behind); all suites pass.

- [ ] **Step 18: Verify on a device**

Native layout bugs are not visible from code. Run the app, open Inventory → Stock → Count, and check on **both** a phone-width simulator and web: the four columns (62 + 58 + 108 + 28 with 8px gaps = 280pt) plus the name column must fit inside the 560pt-max card without the name truncating to nothing. If it does not fit, reduce `reasonChip`'s width and `capChip`'s to match — the two must always be equal or the header stops sitting over its column.

- [ ] **Step 19: Commit**

```bash
git add src/components/stock-count-modal.tsx src/components/__tests__/stock-count-modal.test.tsx
git commit -m "feat(inventory): counting a shelf is one list, and a blank row is a shelf nobody walked"
```

---

### Task 3: The × and the reason belong to a counted row; Clear all sits beside Close

Two affordances that appear only where they mean something, and one that starts the walk over.

**Files:**
- Modify: `src/components/stock-count-modal.tsx` — the header `:657-662`; a new `clearRow`/`clearAll` beside `setReason`; `CountRowView`'s reason and clear slots; styles.
- Test: `src/components/__tests__/stock-count-modal.test.tsx`

**Interfaces:**
- Consumes from Task 2: `updateEntries`, `setReasonOpenFor`, `typed`, `note`, `setNote`, `setLogExpense`, `busy`, `CountRowView`'s prop shape.
- Produces:
  ```ts
  const clearRow: (productId: string) => void;
  const clearAll: () => void;
  const canClearAll: boolean;
  // CountRowView gains one prop:
  //   onClear: () => void;
  ```
  Accessibility labels Tasks 4–5 and the tests rely on: `Clear ${product.name}` on the per-row `×`; `Clear all` on the header button.

- [ ] **Step 1: Write the failing tests**

Add to `src/components/__tests__/stock-count-modal.test.tsx`, after `describe('a line added to a count')`:

```tsx
describe('clearing', () => {
  // The × replaces `Remove`, and the difference matters: there is no basket to
  // take a line out of. It returns the row to blank -- the product was never
  // added in the first place.
  //
  // MUTATION: have `clearRow` set `{ counted: '', reason: <kept> }` instead of
  // deleting the entry. The count clears but a reason nobody can see any more
  // rides along into the next thing typed there.
  it('clears one row back to blank, reason and all', async () => {
    const tree = await open([
      product({}),
      product({ id: 'p-2', name: 'QA other', sku: 'QA-2', stock: 5 }),
    ]);
    await type(tree, COUNTED, '8');
    await act(async () => pressableLabelled(tree, 'Reason for QA widget').props.onPress());
    await act(async () => pressableLabelled(tree, 'Reason: Damaged').props.onPress());
    await type(tree, 'Counted units of QA other', '4');
    expect(allText(tree)).toContain('Save 2 counts');

    await act(async () => pressableLabelled(tree, 'Clear QA widget').props.onPress());
    expect(fieldNamed(tree, COUNTED).props.value).toBe('');
    expect(allText(tree)).toContain('Save 1 count');
    // The row's own reason is gone, not merely hidden: retyping must not bring
    // 'Damaged' back the way an ordinary backspace does.
    await type(tree, COUNTED, '8');
    expect(pressableLabelled(tree, 'Reason for QA widget')).toBeDefined();
    expect(allText(tree)).not.toContain('Damaged');
    // The other row is untouched.
    expect(fieldNamed(tree, 'Counted units of QA other').props.value).toBe('4');
  });

  // MUTATION: render the × on every row. On a 240-product catalogue that is 240
  // clear buttons for rows there is nothing to clear on -- and the × is one of
  // the three things standing between a mistyped row and an overwritten shelf,
  // so it has to mean "this row is counted".
  it('offers the × only on a counted row', async () => {
    const tree = await open();
    expect(tree.root.findAll((n) => n.props.accessibilityLabel === 'Clear QA widget')).toHaveLength(0);
    await type(tree, COUNTED, '8');
    expect(tree.root.findAll((n) => n.props.accessibilityLabel === 'Clear QA widget')).toHaveLength(1);
  });

  // A reason without a count is the one shape the sheet planner rejects
  // outright ("Reason is filled in but Counted is empty"). The two tabs must
  // not disagree about it.
  //
  // MUTATION: keep the reason chip pressable on a blank row. A shop can then
  // record why a product it never counted went missing.
  it('offers the reason only on a counted row', async () => {
    const tree = await open();
    expect(tree.root.findAll((n) => n.props.accessibilityLabel === 'Reason for QA widget')).toHaveLength(0);
    await type(tree, COUNTED, '8');
    expect(tree.root.findAll((n) => n.props.accessibilityLabel === 'Reason for QA widget')).toHaveLength(1);
  });

  // Beside Close, where a destructive action belongs. It empties every field on
  // every page, the reasons and the note -- and leaves the store and the tab
  // where they are.
  //
  // MUTATION: have `clearAll` reset `locationId` too. A shop that clears a
  // mistake is silently moved to a different branch, and the next walk counts
  // the wrong room.
  it('clears every field and the note, and leaves the store alone', async () => {
    const tree = await open([
      product({}),
      product({ id: 'p-2', name: 'QA other', sku: 'QA-2', stock: 5 }),
    ]);
    await act(async () => pressableWithText(tree, 'Main').props.onPress());
    await act(async () => pressableWithText(tree, 'Branch').props.onPress());
    await type(tree, COUNTED, '8');
    await type(tree, 'Counted units of QA other', '4');
    await type(tree, 'Note about this stock-take', 'aisle three');
    expect(allText(tree)).toContain('Save 2 counts');

    await act(async () => pressableLabelled(tree, 'Clear all').props.onPress());

    expect(fieldNamed(tree, COUNTED).props.value).toBe('');
    expect(fieldNamed(tree, 'Counted units of QA other').props.value).toBe('');
    expect(fieldNamed(tree, 'Note about this stock-take').props.value).toBe('');
    expect(allText(tree)).toContain('Save 0 counts');
    // Still at Branch -- the store is not part of what was cleared.
    expect(allText(tree)).toContain('Branch');
  });

  // MUTATION: drop the `canClearAll` gate. A live destructive button over a
  // walk with nothing in it is a control that can only do harm.
  it('offers Clear all only when there is something to clear', async () => {
    const tree = await open();
    expect(pressableLabelled(tree, 'Clear all').props.disabled).toBe(true);
    await type(tree, COUNTED, '8');
    expect(pressableLabelled(tree, 'Clear all').props.disabled).toBe(false);
  });

  // It clears by-hand state. Over the sheet tab it would read as an offer to
  // discard an uploaded plan, which it does not do.
  //
  // MUTATION: render Clear all unconditionally.
  it('does not offer Clear all over the sheet tab', async () => {
    const tree = await open();
    await act(async () => pressableWithText(tree, 'By sheet').props.onPress());
    expect(tree.root.findAll((n) => n.props.accessibilityLabel === 'Clear all')).toHaveLength(0);
  });
});
```

The note field needs a label for the test to drive it. That is part of Step 3.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest src/components/__tests__/stock-count-modal.test.tsx -t clearing`
Expected: FAIL — no element with `accessibilityLabel` `Clear QA widget`, `Clear all`, or aria-label `Note about this stock-take`.

- [ ] **Step 3: Implement**

Add `aria-label="Note about this stock-take"` to the note `TextInput` in the by-hand render (the one with `value={note}`).

Add, immediately after `setReason` in the component body:

```ts
  // Returns ONE row to blank -- the count and the reason together. It does not
  // remove the product, because the product was never added in the first place.
  // The whole entry goes, unlike an emptied field (see `setCounted`), because
  // this is a deliberate "forget this row" rather than a backspace on the way
  // to retyping it.
  const clearRow = (productId: string) => {
    updateEntries((current) => {
      if (!(productId in current)) return current;
      const next = { ...current };
      delete next[productId];
      return next;
    });
    setReasonOpenFor((open) => (open === productId ? null : open));
  };

  // Starts the walk over. Every field on every page, every reason and the note
  // -- and NOT the store or the tab, which are where the person is standing
  // rather than what they have written down. The stock-loss tick goes too: the
  // shortfall it referred to no longer exists, and a tick with no offer behind
  // it is exactly the stale yes `handExpenseCents` exists to refuse.
  const clearAll = () => {
    updateEntries(() => ({}));
    setNote('');
    setReasonOpenFor(null);
    setLogExpense(false);
  };
  const canClearAll = !busy && (typed.length > 0 || note.trim() !== '');
```

Replace the header block (lines 657-662) with:

```tsx
          <View style={styles.header}>
            <Text style={styles.title}>Count</Text>
            <View style={styles.headerButtons}>
              {tab === 'hand' && (
                <Pressable
                  onPress={clearAll}
                  disabled={!canClearAll}
                  style={[styles.clearAll, !canClearAll && styles.clearAllOff]}
                  accessibilityRole="button"
                  accessibilityLabel="Clear all"
                >
                  <Text style={[styles.clearAllText, !canClearAll && styles.clearAllTextOff]}>Clear all</Text>
                </Pressable>
              )}
              <Pressable onPress={closeAndReset} style={styles.close}>
                <Text style={styles.closeText}>Close</Text>
              </Pressable>
            </View>
          </View>
```

In `CountRowView`, add `onClear: () => void;` to the props type and destructure it. Replace the reason `Pressable` and add the clear slot:

```tsx
          {touched ? (
            <Pressable
              onPress={onToggleReason}
              style={styles.reasonChip}
              accessibilityRole="button"
              accessibilityLabel={`Reason for ${row.product.name}`}
            >
              <Text style={styles.reasonChipText}>{row.reason ? reasonLabel(row.reason) : 'Reason'}</Text>
            </Pressable>
          ) : (
            <View style={styles.reasonChipBlank}>
              <Text style={styles.reasonChipBlankText}>—</Text>
            </View>
          )}
          {touched ? (
            <Pressable
              onPress={onClear}
              style={styles.clear}
              accessibilityRole="button"
              accessibilityLabel={`Clear ${row.product.name}`}
            >
              <Text style={styles.clearText}>×</Text>
            </Pressable>
          ) : (
            <View style={styles.clearSlot} />
          )}
```

and guard the chips row on `touched` as well: `{reasonOpen && touched && (` … `)}`.

Pass the new prop at the call site: `onClear={() => clearRow(item.id)}`.

Add to the `StyleSheet`:

```ts
  headerButtons: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  clearAll: { borderWidth: 1, borderColor: '#DCDCE4', borderRadius: 10, paddingHorizontal: 14, paddingVertical: 11 },
  clearAllOff: { borderColor: '#F2F2F2' },
  clearAllText: { fontSize: 12.5, fontWeight: '700', color: '#5E5D65' },
  clearAllTextOff: { color: '#B6B6BC' },
  reasonChipBlank: { width: 108, height: 38, alignItems: 'center', justifyContent: 'center' },
  reasonChipBlankText: { fontSize: 12, fontWeight: '600', color: '#B6B6BC' },
  clear: { width: 28, height: 28, borderRadius: 999, backgroundColor: '#FFFFFF', alignItems: 'center', justifyContent: 'center' },
  clearSlot: { width: 28, height: 28 },
  clearText: { fontSize: 14, fontWeight: '700', color: '#6B6B73' },
```

- [ ] **Step 4: Run the tests**

Run: `npx jest src/components/__tests__/stock-count-modal.test.tsx`
Expected: PASS, the whole file.

- [ ] **Step 5: Run each named mutation**

Apply each `MUTATION:` from Step 1, confirm the named test goes RED, revert.

- [ ] **Step 6: Verify the baselines**

Run: `npx tsc --noEmit && npm run lint 2>&1 | tail -3 && npm test 2>&1 | tail -5`
Expected: tsc clean; lint `76 problems`; all suites pass.

- [ ] **Step 7: Commit**

```bash
git add src/components/stock-count-modal.tsx src/components/__tests__/stock-count-modal.test.tsx
git commit -m "feat(inventory): a counted row can be cleared, and so can the whole walk"
```

---

### Task 4: A hundred at a time — and the counts outlive the page

HAZARD 1's task. The pager row is absent entirely below 100, and the test that matters asserts at the `saveStockCount` boundary, not at the render.

**Files:**
- Modify: `src/components/stock-count-modal.tsx` — `page` state; `paged`; the search and category handlers; the list render; `closeAndReset`; the store-transition branch; styles.
- Test: `src/components/__tests__/stock-count-modal.test.tsx`

**Interfaces:**
- Consumes from Task 1: `pageSlice`, `COUNT_PAGE_SIZE`. From Task 2: `filtered`, `typed`, `entries`, `walkRow`.
- Produces:
  ```ts
  const [page, setPage] = useState(1);
  const paged: { page: number; pageCount: number; items: Product[]; from: number; to: number };
  ```
  Accessibility labels: `Previous page`, `Next page`.

- [ ] **Step 1: Write the failing tests**

Add to `src/components/__tests__/stock-count-modal.test.tsx`:

```tsx
// A catalogue long enough to page. Names are zero-padded so the aria-label of
// any row is predictable, and stock is uniform so a variance is only ever the
// result of something this test typed.
const catalogueOf = (count: number, prefix = 'QA') =>
  Array.from({ length: count }, (_, i) =>
    product({ id: `p-${i}`, name: `${prefix} ${String(i).padStart(3, '0')}`, sku: `${prefix}-${i}`, stock: 10 })
  );

describe('paging a long catalogue', () => {
  // THE regression this feature keeps producing, pinned at the only boundary
  // that can see it: what `saveStockCount` is actually handed. A count typed on
  // page 1 and dropped by paging to page 2 is invisible until a shelf comes out
  // wrong.
  //
  // MUTATION: build `handLines` from `paged.items` (or from `filtered`) instead
  // of from the whole `catalogue`. The render stays perfect and the commit
  // silently loses every count not currently scrolled into view.
  it('keeps a count typed on page 1 while the walk is on page 2, and sends both', async () => {
    const tree = await open(catalogueOf(150));
    await type(tree, 'Counted units of QA 000', '4');
    await act(async () => pressableLabelled(tree, 'Next page').props.onPress());

    // Page 2 genuinely does not render page 1's row.
    expect(tree.root.findAll((n) => n.props['aria-label'] === 'Counted units of QA 000')).toHaveLength(0);
    await type(tree, 'Counted units of QA 100', '7');
    await act(async () => pressableLabelled(tree, 'Previous page').props.onPress());
    expect(fieldNamed(tree, 'Counted units of QA 000').props.value).toBe('4');

    await act(async () => pressableLabelled(tree, 'Save counts').props.onPress());
    expect(saveStockCount.mock.calls[0][2]).toEqual([
      { productId: 'p-0', countedQuantity: 4, reason: null },
      { productId: 'p-100', countedQuantity: 7, reason: null },
    ]);
  });

  // The same rule for the other two things that change what is rendered.
  //
  // MUTATION: rebuild `entries` from `filtered` on every search change.
  it('keeps a count typed under one search term after the search changes, and sends both', async () => {
    const tree = await open([
      product({ id: 'p-1', name: 'Dr Althea', sku: 'SK-1', stock: 7 }),
      product({ id: 'p-2', name: 'clay mask sachet', sku: 'SK-2', stock: 12 }),
    ]);
    await type(tree, 'Search products', 'Althea');
    await type(tree, 'Counted units of Dr Althea', '5');
    await backspace(tree, 'Search products', 6);
    await type(tree, 'Search products', 'clay');
    await type(tree, 'Counted units of clay mask sachet', '15');
    await backspace(tree, 'Search products', 4);

    expect(fieldNamed(tree, 'Counted units of Dr Althea').props.value).toBe('5');
    await act(async () => pressableLabelled(tree, 'Save counts').props.onPress());
    expect(saveStockCount.mock.calls[0][2]).toEqual([
      { productId: 'p-1', countedQuantity: 5, reason: null },
      { productId: 'p-2', countedQuantity: 15, reason: null },
    ]);
  });

  // A control that can never do anything should not be on screen -- and most
  // shops on the platform carry fewer than a hundred products.
  //
  // MUTATION: render the pager whenever `pageCount > 0`. Every shop in the
  // country grows a Previous/Next row that does nothing.
  it('renders no pager at all at a hundred products', async () => {
    const tree = await open(catalogueOf(100));
    expect(tree.root.findAll((n) => n.props.accessibilityLabel === 'Next page')).toHaveLength(0);
    expect(allText(tree)).not.toContain('Showing');
  });

  // MUTATION: off-by-one in `from`/`to`, or reading `filtered.length` as the
  // page length. This line is the only thing on screen that says how much of
  // the shop is not visible.
  it('says which window it is showing and how much of the walk is off-screen', async () => {
    const tree = await open(catalogueOf(240));
    expect(allText(tree)).toContain('Showing 1–100 of 240');
    await type(tree, 'Counted units of QA 000', '4');
    expect(allText(tree)).toContain('Showing 1–100 of 240 · 1 counted so far, on any page');
    await act(async () => pressableLabelled(tree, 'Next page').props.onPress());
    expect(allText(tree)).toContain('Showing 101–200 of 240 · 1 counted so far, on any page');
    await act(async () => pressableLabelled(tree, 'Next page').props.onPress());
    expect(allText(tree)).toContain('Showing 201–240 of 240');
  });

  // MUTATION: leave both buttons always enabled. `Next` on the last page walks
  // off the end into a blank list.
  it('disables the ends of the walk', async () => {
    const tree = await open(catalogueOf(240));
    expect(pressableLabelled(tree, 'Previous page').props.disabled).toBe(true);
    expect(pressableLabelled(tree, 'Next page').props.disabled).toBe(false);
    await act(async () => pressableLabelled(tree, 'Next page').props.onPress());
    await act(async () => pressableLabelled(tree, 'Next page').props.onPress());
    expect(pressableLabelled(tree, 'Next page').props.disabled).toBe(true);
    expect(pressableLabelled(tree, 'Previous page').props.disabled).toBe(false);
  });

  // Staying on page 3 of a set that now has 12 rows shows nothing. The clamp in
  // `pageSlice` would rescue the empty-list case on its own, so this is built
  // to be a case the clamp CANNOT rescue: 250 down to 150 leaves page 3
  // clamping to page 2, which renders rows 101-150 of the new set rather than
  // its first row.
  //
  // MUTATION: delete `setPage(1)` from the search handler.
  it('goes back to the first page when the search narrows the set', async () => {
    const tree = await open([...catalogueOf(150, 'SKIN'), ...catalogueOf(100, 'HOME')]);
    await act(async () => pressableLabelled(tree, 'Next page').props.onPress());
    await act(async () => pressableLabelled(tree, 'Next page').props.onPress());
    expect(allText(tree)).toContain('Showing 201–250 of 250');
    await type(tree, 'Search products', 'SKIN');
    expect(allText(tree)).toContain('Showing 1–100 of 150');
    expect(fieldNamed(tree, 'Counted units of SKIN 000').props.value).toBe('');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest src/components/__tests__/stock-count-modal.test.tsx -t 'paging a long catalogue'`
Expected: FAIL — no element with `accessibilityLabel` `Next page`.

- [ ] **Step 3: Implement**

Add to the imports from `@/lib/count-walk`: `COUNT_PAGE_SIZE`, `pageSlice`.

Add beside the other state (just after `const [category, setCategory] = useState<string | null>(null);`):

```ts
  // One-based, and never trusted blind -- `pageSlice` clamps it. Reset by the
  // handlers that change what is being paged (search, category, the store) so
  // page 3 of a set that now has 12 rows is never on screen.
  const [page, setPage] = useState(1);
```

Add after `filtered`:

```ts
  const paged = useMemo(() => pageSlice(filtered, page, COUNT_PAGE_SIZE), [filtered, page]);
```

Reset the page in the three handlers:
- the search input: `onChangeText={(text) => { setSearch(text); setPage(1); }}`
- the "All" chip: `onPress={() => { setCategory(null); setPage(1); }}`
- each category chip: `onPress={() => { setCategory(item); setPage(1); }}`
- the store-transition branch inside the load effect gains `setPage(1);`
- `closeAndReset` gains `setPage(1);`
- `uploadSheet`'s handover gains `setPage(1);` beside its `setSearch('')` / `setCategory(null)`

Change the list render's map from `filtered.map(...)` to `paged.items.map(...)` (nothing else in the `map` body changes), and add the pager immediately after the closing `</View>` of `styles.listRows`, still inside `styles.listWrap`:

```tsx
                    {/* ABSENT below the threshold, not greyed: a control that
                        can never do anything should not be on screen, and most
                        shops on the platform carry fewer than a hundred
                        products. */}
                    {filtered.length > COUNT_PAGE_SIZE && (
                      <View style={styles.pager}>
                        <Text style={styles.pagerInfo}>
                          {`Showing ${paged.from}–${paged.to} of ${filtered.length}${
                            typed.length > 0 ? ` · ${typed.length} counted so far, on any page` : ''
                          }`}
                        </Text>
                        <View style={styles.pagerButtons}>
                          <Pressable
                            onPress={() => setPage(paged.page - 1)}
                            disabled={paged.page <= 1}
                            style={[styles.pageButton, paged.page <= 1 && styles.pageButtonOff]}
                            accessibilityRole="button"
                            accessibilityLabel="Previous page"
                          >
                            <Text style={[styles.pageButtonText, paged.page <= 1 && styles.pageButtonTextOff]}>
                              Previous
                            </Text>
                          </Pressable>
                          <Pressable
                            onPress={() => setPage(paged.page + 1)}
                            disabled={paged.page >= paged.pageCount}
                            style={[styles.pageButton, paged.page >= paged.pageCount && styles.pageButtonOff]}
                            accessibilityRole="button"
                            accessibilityLabel="Next page"
                          >
                            <Text
                              style={[
                                styles.pageButtonText,
                                paged.page >= paged.pageCount && styles.pageButtonTextOff,
                              ]}
                            >
                              Next
                            </Text>
                          </Pressable>
                        </View>
                      </View>
                    )}
```

Add to the `StyleSheet`:

```ts
  pager: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginTop: 12, paddingTop: 12, borderTopWidth: 1, borderTopColor: '#F2F2F2' },
  pagerInfo: { fontSize: 12, color: '#9CA3AF', flexShrink: 1 },
  pagerButtons: { flexDirection: 'row', gap: 6 },
  pageButton: { borderWidth: 1, borderColor: '#DCDCE4', borderRadius: 999, paddingHorizontal: 13, paddingVertical: 6 },
  pageButtonOff: { borderColor: '#F2F2F2' },
  pageButtonText: { fontSize: 12, fontWeight: '700', color: '#5E5D65' },
  pageButtonTextOff: { color: '#B6B6BC' },
```

- [ ] **Step 4: Run the tests**

Run: `npx jest src/components/__tests__/stock-count-modal.test.tsx`
Expected: PASS, the whole file.

- [ ] **Step 5: Run each named mutation**

Apply each `MUTATION:` from Step 1, confirm the named test goes RED, revert. The first two are the ones that matter most — if either stays green, the test is asserting on the render rather than on `saveStockCount.mock.calls`.

- [ ] **Step 6: Verify the baselines**

Run: `npx tsc --noEmit && npm run lint 2>&1 | tail -3 && npm test 2>&1 | tail -5`
Expected: tsc clean; lint `76 problems`; all suites pass.

- [ ] **Step 7: Verify on a device**

Open Count against a shop with more than a hundred products and scroll to the bottom of the list. The pager must sit inside the scrolling body (above `NOTE`), not pinned over the footer, and scrolling 100 rows of `TextInput` must stay smooth. If it does not, that is a real finding — report it rather than silently lowering `COUNT_PAGE_SIZE`, because the threshold is also the "no pager for most shops" promise.

- [ ] **Step 8: Commit**

```bash
git add src/components/stock-count-modal.tsx src/components/__tests__/stock-count-modal.test.tsx
git commit -m "feat(inventory): a hundred products at a time, and the counts outlive the page"
```

---

### Task 5: Save asks first — the confirmation that unfolds where the footer was

HAZARD 2 and HAZARD 3's task. Count **sets** a number; there is no undo, and a mistyped row overwrites a real shelf.

**Files:**
- Modify: `src/components/stock-count-modal.tsx` — `confirming` state; `askToSave`; `submit`'s two exits; the footer branch; a new `CountConfirm` at module scope; `closeAndReset`; the store-transition branch; `clearAll`; the `Clear all` gate; styles.
- Test: `src/components/__tests__/stock-count-modal.test.tsx`

**Interfaces:**
- Consumes from Tasks 2–4: `handLines`, `handSummary`, `handExpenseCents`, `catalogue`, `canSubmit`, `busy`, `submit`, `canClearAll`, `selectable`, `locationId`.
- Produces:
  ```ts
  const [confirming, setConfirming] = useState(false);
  const askToSave: () => void;          // the list footer's Save button; writes NOTHING
  const storeName: string;
  function CountConfirm(props: {
    storeName: string;
    lines: PlannedCountLine[];
    summary: CountSummary;
    untouched: number;
    expenseCents: number | null;
    busy: boolean;
    onBack: () => void;
    onConfirm: () => void;
  }): JSX.Element;
  ```
  Accessibility labels: `Go back`, `Confirm and save the count`. The list footer's button keeps `Save counts`.

- [ ] **Step 1: Write the failing tests**

First add a helper beside `type`/`backspace` in the test file:

```tsx
// The by-hand tab writes in two presses now: Save counts opens the
// confirmation, and only the confirmation's own button commits. The sheet tab
// still writes on one press and does NOT use this.
async function saveByHand(tree: ReactTestRenderer) {
  await act(async () => pressableLabelled(tree, 'Save counts').props.onPress());
  await act(async () => pressableLabelled(tree, 'Confirm and save the count').props.onPress());
}
```

Then, in every by-hand test that presses `Save counts` and expects a write, replace the press with `await saveByHand(tree);`. That is: `skips a product nobody counted…`, the two store-change commits, `sends the counted total, not the change`, `sends a null reason rather than defaulting one`, `keeps the basket when the count itself was refused`, both shortfall-writing tests, `writes the expense only after the numbers have changed`, `writes nothing when the count itself was refused`, `does not write when an edit removes the honest total after ticking`, and `reports a failed expense instead of closing over it`. Leave every **sheet-tab** `Save counts` press exactly as it is.

Rewrite `does not leave a live basket behind a failed reload`'s two presses as:

```tsx
    await saveByHand(tree);
    // The walk is spent: the confirmation is gone and Save is dead, so the one
    // failure that already committed cannot be committed again.
    expect(tree.root.findAll((n) => n.props.accessibilityLabel === 'Confirm and save the count')).toHaveLength(0);
    expect(pressableLabelled(tree, 'Save counts').props.disabled).toBe(true);
    await act(async () => pressableLabelled(tree, 'Save counts').props.onPress());
    expect(tree.root.findAll((n) => n.props.accessibilityLabel === 'Confirm and save the count')).toHaveLength(0);
    expect(saveStockCount).toHaveBeenCalledTimes(1);
```

Then add a new describe:

```tsx
describe('the confirmation', () => {
  // Count SETS a number. There is no undo, and a mistyped row overwrites a real
  // shelf -- so pressing Save must not write.
  //
  // MUTATION: wire the list footer's button straight to `submit`. The write
  // happens on the first press and the panel never appears.
  it('writes nothing on the first press, and names the store, the changes and the reasons', async () => {
    const tree = await open([
      product({ id: 'p-1', name: 'Dr Althea', sku: 'SK-1', stock: 7 }),
      product({ id: 'p-2', name: 'daily facial', sku: 'SK-2', stock: 5 }),
      product({ id: 'p-3', name: 'clay mask sachet', sku: 'SK-3', stock: 12 }),
      product({ id: 'p-4', name: 'untouched thing', sku: 'SK-4', stock: 3 }),
    ]);
    await type(tree, 'Counted units of Dr Althea', '5');
    await act(async () => pressableLabelled(tree, 'Reason for Dr Althea').props.onPress());
    await act(async () => pressableLabelled(tree, 'Reason: Theft or loss').props.onPress());
    await type(tree, 'Counted units of daily facial', '5');
    await type(tree, 'Counted units of clay mask sachet', '15');

    await act(async () => pressableLabelled(tree, 'Save counts').props.onPress());
    expect(saveStockCount).not.toHaveBeenCalled();

    const shown = allText(tree);
    // The headline is the number that CHANGES, not the number counted.
    // MUTATION: headline `summary.counted` instead. It reads "3 counted" as
    // "3 will change" on any walk where a row matched -- overstating what is
    // about to happen, on the one screen that exists to state it exactly.
    expect(shown).toContain('2 products will change');
    expect(shown).not.toContain('3 products will change');
    // MUTATION: drop the store name. Stock-takes go wrong by being saved
    // against the wrong branch, and this is the last screen that can catch it.
    expect(shown).toContain('At Main');
    expect(shown).toContain('3 counted, 1 already matched');
    // Both numbers for every change, and the reason each carries.
    expect(shown).toContain('Dr Althea');
    expect(shown).toContain('7 → 5');
    expect(shown).toContain('Theft or loss');
    expect(shown).toContain('clay mask sachet');
    expect(shown).toContain('12 → 15');
    // MUTATION: hide the reasonless line's caption. Unexplained shrinkage IS
    // the finding, and a blank there reads as "no shrinkage".
    expect(shown).toContain('no reason given');
    // A matched row is recorded, and says so rather than appearing as a change.
    expect(shown).toContain('daily facial was counted at 5 and is already 5');
    expect(shown).toContain('1 product was not counted and is untouched.');
  });

  // MUTATION: replace the panel with a `Modal` (or `AppModal`). On iOS a modal
  // presented from a modal is silently dropped and the button reads as dead --
  // this has bitten twice on this branch. The panel must be a plain View inside
  // the AppModal already on screen.
  it('unfolds inside the sheet already on screen, opening no second modal', async () => {
    const tree = await open();
    const modalsBefore = tree.root.findAll((n) => n.props.transparent !== undefined).length;
    await type(tree, COUNTED, '8');
    await act(async () => pressableLabelled(tree, 'Save counts').props.onPress());
    expect(allText(tree)).toContain('1 product will change');
    expect(tree.root.findAll((n) => n.props.transparent !== undefined)).toHaveLength(modalsBefore);
  });

  // "Cancel" reads like it might throw the walk away, and on a shelf you just
  // spent twenty minutes counting that ambiguity is cruel.
  //
  // MUTATION: have `Go back` call `clearAll` as well. Twenty minutes gone.
  it('goes back to the list with everything intact', async () => {
    const tree = await open();
    await type(tree, COUNTED, '8');
    await act(async () => pressableLabelled(tree, 'Save counts').props.onPress());
    await act(async () => pressableLabelled(tree, 'Go back').props.onPress());
    expect(tree.root.findAll((n) => n.props.accessibilityLabel === 'Go back')).toHaveLength(0);
    expect(fieldNamed(tree, COUNTED).props.value).toBe('8');
    expect(saveStockCount).not.toHaveBeenCalled();
  });

  // If the stock-loss box is ticked, this write also touches the P&L. That
  // belongs in the confirmation, not only in a checkbox scrolled past.
  //
  // MUTATION: render the money line whenever `logExpense` is true, ignoring
  // `handExpenseCents`. The panel then promises a P&L row on a walk with no
  // shortfall, which `submit` correctly refuses to write -- a confirmation that
  // lies about what it is about to do.
  it('discloses the stock-loss expense, and only when one will actually be written', async () => {
    const tree = await open();
    await type(tree, COUNTED, '8');
    await act(async () => pressableLabelled(tree, 'Log the shortfall as stock loss').props.onPress());
    await act(async () => pressableLabelled(tree, 'Save counts').props.onPress());
    expect(allText(tree)).toContain('Also logs $13.83 as a stock-loss expense');

    await act(async () => pressableLabelled(tree, 'Go back').props.onPress());
    await backspace(tree, COUNTED, 1);
    await type(tree, COUNTED, '11');
    await act(async () => pressableLabelled(tree, 'Save counts').props.onPress());
    expect(allText(tree)).not.toContain('stock-loss expense');
  });

  // Recording that a shelf was checked and found correct is a real and useful
  // result, so this still offers to save.
  //
  // MUTATION: disable the confirm button when nothing changes, or refuse to
  // open the panel at all. A shop that walks a shelf and finds it right can no
  // longer record that it did.
  it('says plainly that nothing will change, and still offers to save', async () => {
    const tree = await open();
    await type(tree, COUNTED, '11');
    await act(async () => pressableLabelled(tree, 'Save counts').props.onPress());
    expect(allText(tree)).toContain('Nothing will change');
    expect(allText(tree)).toContain('Yes, record the count');
    await act(async () => pressableLabelled(tree, 'Confirm and save the count').props.onPress());
    expect(saveStockCount).toHaveBeenCalledWith(
      'shop-1',
      'loc-1',
      [{ productId: 'p-1', countedQuantity: 11, reason: null }],
      { note: null }
    );
  });

  // HAZARD 3, from the other direction: a refused write leaves the walk intact,
  // and the confirmation must not be left standing over it with a live button.
  //
  // MUTATION: drop `setConfirming(false)` from the catch. The error renders
  // behind a panel still offering "Yes, save 1 change" against numbers that
  // just failed, which is a second live route into the same write.
  it('returns to the list on a refused write, with everything typed still there', async () => {
    saveStockCount.mockRejectedValueOnce(new Error('not authorized for shop shop-1'));
    const tree = await open();
    await type(tree, COUNTED, '8');
    await saveByHand(tree);
    expect(tree.root.findAll((n) => n.props.accessibilityLabel === 'Confirm and save the count')).toHaveLength(0);
    expect(fieldNamed(tree, COUNTED).props.value).toBe('8');
    expect(allText(tree)).toContain('not authorized');
  });

  // MUTATION: leave `Clear all` live during the confirmation. Pressing it from
  // behind the panel empties the walk the panel is describing, and the panel
  // goes on offering to save it.
  it('stands Clear all down while the confirmation is open', async () => {
    const tree = await open();
    await type(tree, COUNTED, '8');
    await act(async () => pressableLabelled(tree, 'Save counts').props.onPress());
    expect(pressableLabelled(tree, 'Clear all').props.disabled).toBe(true);
  });

  // MUTATION: drop `setConfirming(false)` from `closeAndReset`. The next
  // stock-take opens straight into a confirmation of the last one's numbers.
  it('is gone when the sheet is closed and re-opened', async () => {
    const tree = await open();
    await type(tree, COUNTED, '8');
    await act(async () => pressableLabelled(tree, 'Save counts').props.onPress());
    await act(async () => pressableWithText(tree, 'Close').props.onPress());
    expect(tree.root.findAll((n) => n.props.accessibilityLabel === 'Confirm and save the count')).toHaveLength(0);
    expect(fieldNamed(tree, COUNTED).props.value).toBe('');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest src/components/__tests__/stock-count-modal.test.tsx`
Expected: FAIL — `pressableLabelled` returns `undefined` for `Confirm and save the count`.

- [ ] **Step 3: Implement the state and the two exits**

Add beside the other by-hand state:

```ts
  // The confirmation, which is a PANEL and never a modal. A modal presented
  // from a modal is silently dropped on iOS and the button reads as dead --
  // this has bitten twice on this branch. It replaces the footer's contents
  // inside the AppModal already on screen, the same way the reason chips
  // unfold under a row.
  const [confirming, setConfirming] = useState(false);
```

Add beside `canSubmit`:

```ts
  // Stock-takes go wrong by being saved against the wrong branch, and the one
  // screen that can catch it is the one right before the write.
  const storeName = useMemo(
    () => selectable.find((location) => location.id === locationId)?.name ?? '',
    [selectable, locationId]
  );
```

Add beside `submit`:

```ts
  // The list footer's Save button. It WRITES NOTHING -- it unfolds the
  // confirmation, which carries the only button that commits.
  const askToSave = () => {
    if (!canSubmit) return;
    setError(null);
    setConfirming(true);
  };
```

In `submit`'s `catch`, add `setConfirming(false);` immediately before `setBusy(false);`, with:

```ts
      // Back to the list, with everything typed still there -- this is the one
      // failure a shop fixes by pressing again. The panel does NOT stay up: a
      // live "Yes, save" sitting over numbers that just failed is a second
      // route into the same write, which is exactly how the restock branch
      // committed a delivery twice.
```

In `submit`'s post-commit block, add `setConfirming(false);` immediately after `setLogExpense(false);`.

Change `closeAndReset` to add `setConfirming(false);`, the store-transition branch to add `setConfirming(false);`, and `clearAll` to add `setConfirming(false);`. Change `canClearAll` to:

```ts
  const canClearAll = !busy && !confirming && (typed.length > 0 || note.trim() !== '');
```

- [ ] **Step 4: Implement the footer branch**

Replace the `tab === 'hand' ? (…)` branch of `styles.footerWrap` so the confirmation takes the whole footer, including the stock-loss checkbox above it. The `footerWrap` block becomes:

```tsx
          <View style={styles.footerWrap}>
            {tab === 'hand' && confirming ? (
              <CountConfirm
                storeName={storeName}
                lines={handLines}
                summary={handSummary}
                untouched={catalogue.length - handSummary.counted}
                expenseCents={handExpenseCents}
                busy={busy}
                onBack={() => setConfirming(false)}
                onConfirm={submit}
              />
            ) : (
              <>
                {/* Above the buttons rather than beside them: it is a question
                    about the stock-take, and a shop should read it on the way to
                    the button whose meaning it changes. */}
                <StockLossCheck
                  cents={(tab === 'hand' ? handSummary : planSummary).shortfallCents}
                  uncostedShortfallLines={(tab === 'hand' ? handSummary : planSummary).uncostedShortfallLines}
                  on={logExpense}
                  onToggle={() => setLogExpense((ticked) => !ticked)}
                />
                {tab === 'hand' ? (
                  /* …the by-hand footer from Task 2, UNCHANGED except that the
                     Save button's onPress becomes `askToSave`… */
                ) : (
                  /* …the sheet footer, entirely unchanged… */
                )}
              </>
            )}
          </View>
```

and the by-hand Save button's `onPress={submit}` becomes `onPress={askToSave}`.

- [ ] **Step 5: Implement `CountConfirm`**

Add at module scope, immediately after `StockLossCheck`:

```tsx
// Save asks first, and shows its working.
//
// A PANEL, deliberately, not a sheet: a modal presented from a modal is
// silently dropped on iOS and the button just reads as dead. This replaces the
// footer inside the AppModal already on screen, the same way the reason chips
// unfold under a row.
//
// The headline is the number that CHANGES, not the number counted. A row
// counted at the figure it already held changes nothing, and saying otherwise
// overstates what is about to happen on the one screen that exists to state it
// exactly.
function CountConfirm({
  storeName,
  lines,
  summary,
  untouched,
  expenseCents,
  busy,
  onBack,
  onConfirm,
}: {
  storeName: string;
  lines: PlannedCountLine[];
  summary: CountSummary;
  untouched: number;
  expenseCents: number | null;
  busy: boolean;
  onBack: () => void;
  onConfirm: () => void;
}) {
  const changing = lines.filter((line) => line.variance !== 0);
  const matched = lines.filter((line) => line.variance === 0);
  return (
    <View style={styles.confirm}>
      <Text style={styles.confirmTitle}>
        {changing.length === 0
          ? 'Nothing will change'
          : `${changing.length} product${changing.length === 1 ? '' : 's'} will change`}
      </Text>
      <Text style={styles.confirmWhere}>
        {`At ${storeName} · ${summary.counted} counted${
          matched.length > 0 ? `, ${matched.length} already matched` : ''
        }`}
      </Text>

      {/* Scrolls rather than truncates. The whole point of a confirmation is
          auditing it, and "40 products will change" has to be a list a person
          can actually read rather than a number they have to trust. */}
      {changing.length > 0 && (
        <ScrollView style={styles.confirmList} contentContainerStyle={styles.confirmListInner}>
          {changing.map((line) => (
            <View key={line.productId} style={styles.confirmRow}>
              <View style={styles.confirmRowText}>
                <Text style={styles.confirmName}>{line.productName}</Text>
                {/* Including "no reason given", because unexplained shrinkage
                    is the finding, and a blank here would read as none. */}
                <Text style={styles.confirmReason}>
                  {line.reason ? reasonLabel(line.reason) : 'no reason given'}
                </Text>
              </View>
              <Text style={styles.confirmArrow}>
                <Text style={styles.confirmFrom}>{line.previousQuantity}</Text>
                <Text style={styles.confirmFrom}> → </Text>
                <Text style={line.variance > 0 ? styles.varianceUp : styles.varianceDown}>
                  {line.countedQuantity}
                </Text>
              </Text>
            </View>
          ))}
        </ScrollView>
      )}

      {matched.length > 0 && (
        <Text style={styles.confirmQuiet}>
          {matched.length === 1
            ? `${matched[0].productName} was counted at ${matched[0].countedQuantity} and is already ${matched[0].countedQuantity} — it will be recorded, but no number moves.`
            : `${matched.length} products were counted at the figure they already held — they will be recorded, but no numbers move.`}
        </Text>
      )}
      {untouched > 0 && (
        <Text style={styles.confirmQuiet}>
          {untouched === 1
            ? '1 product was not counted and is untouched.'
            : `${untouched} products were not counted and are untouched.`}
        </Text>
      )}
      {expenseCents !== null && (
        <Text style={styles.confirmMoney}>
          {`Also logs ${formatCents(expenseCents)} as a stock-loss expense`}
        </Text>
      )}

      <View style={styles.confirmButtons}>
        {/* "Go back", not "Cancel": Cancel reads like it might throw the walk
            away, and on a shelf somebody just spent twenty minutes counting
            that ambiguity is cruel. */}
        <Pressable
          onPress={onBack}
          disabled={busy}
          style={styles.confirmBack}
          accessibilityRole="button"
          accessibilityLabel="Go back"
        >
          <Text style={styles.ghostText}>Go back</Text>
        </Pressable>
        <Pressable
          onPress={onConfirm}
          disabled={busy}
          style={[styles.primary, busy && styles.disabled]}
          accessibilityRole="button"
          accessibilityLabel="Confirm and save the count"
        >
          <Text style={styles.primaryText}>
            {busy
              ? 'Saving…'
              : changing.length === 0
                ? 'Yes, record the count'
                : `Yes, save ${changing.length} change${changing.length === 1 ? '' : 's'}`}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}
```

Add to the `StyleSheet`:

```ts
  confirm: { backgroundColor: '#F6F6F7', borderRadius: 16, padding: 14 },
  confirmTitle: { fontSize: 15, fontWeight: '800', color: '#111111' },
  confirmWhere: { fontSize: 12.5, color: '#9CA3AF', marginTop: 2, marginBottom: 10 },
  confirmList: { maxHeight: 180 },
  confirmListInner: { backgroundColor: '#FFFFFF', borderRadius: 12, paddingHorizontal: 12 },
  confirmRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, paddingVertical: 9, borderBottomWidth: 1, borderBottomColor: '#F2F2F2' },
  confirmRowText: { flexShrink: 1 },
  confirmName: { fontSize: 13, fontWeight: '700', color: '#111111' },
  confirmReason: { fontSize: 12, fontWeight: '600', color: '#9CA3AF', marginTop: 1 },
  confirmArrow: { fontSize: 13, fontWeight: '800', fontVariant: ['tabular-nums'] },
  confirmFrom: { color: '#9CA3AF', fontWeight: '600' },
  confirmQuiet: { fontSize: 12.5, color: '#9CA3AF', marginTop: 10, lineHeight: 18 },
  confirmMoney: { fontSize: 12.5, fontWeight: '700', color: '#8A5806', backgroundColor: '#FDF1DA', borderRadius: 10, padding: 10, marginTop: 10 },
  confirmButtons: { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 8, marginTop: 14 },
  confirmBack: { borderWidth: 1, borderColor: '#DCDCE4', borderRadius: 10, paddingHorizontal: 14, paddingVertical: 12 },
```

- [ ] **Step 6: Run the tests**

Run: `npx jest src/components/__tests__/stock-count-modal.test.tsx`
Expected: PASS, the whole file.

- [ ] **Step 7: Run each named mutation**

Apply each `MUTATION:` from Step 1, confirm the named test goes RED, revert. Pay particular attention to two:
- The `unfolds inside the sheet` mutation: swapping the panel for an `AppModal` must turn it red. If it does not, the modal-counting assertion is not counting modals — change it to `tree.root.findAllByType(AppModal)` with an explicit import and re-check.
- The `does not leave a live basket behind a failed reload` mutation: move `await onDone()` back inside the `try` around `saveStockCount`. It must go red with `saveStockCount` called twice. This is HAZARD 3's canary and it must bite.

- [ ] **Step 8: Verify the baselines**

Run: `npx tsc --noEmit && npm run lint 2>&1 | tail -3 && npm test 2>&1 | tail -5`
Expected: tsc clean; lint `76 problems`; all suites pass.

- [ ] **Step 9: Verify on a device**

The confirmation is the one part of this feature that a component test cannot prove works, because HAZARD 2 is a native behaviour. **Run it on an iOS simulator**, not only on web: open Count, type into two rows, press `Save counts`, and confirm the panel appears. A dead button here is the exact symptom of a nested modal being dropped, and it looks identical to a working test suite. Then confirm the change list scrolls when more than about five products change.

- [ ] **Step 10: Commit**

```bash
git add src/components/stock-count-modal.tsx src/components/__tests__/stock-count-modal.test.tsx
git commit -m "feat(inventory): saving a stock-take asks first, and shows its working"
```

---

## Self-Review

**1. Spec coverage.** Every row of the mockup's "What this changes beyond layout" table and every explanatory card maps to a task:

| Spec item | Task |
|---|---|
| One list; the `Count` button and the basket are gone | 2 |
| Blank means "not counted"; the row is skipped, the product untouched | 1 (rule), 2 (wired + tested at the RPC boundary) |
| Zero still means an empty shelf and still commits | 1 (rule), 2 (existing test retained) |
| Blank and zero must never look alike; untouched renders `—` | 2 (`placeholder`, so `value` stays `''`) |
| An unreadable entry still blocks Save | 1 (`plannedLines`' guard), 2 (`countHint` + a disabled-button test) |
| Save allowed when at least one row reads | 1, 2 (`canSubmit`) |
| What is sent: only rows with a number, across every page | 1, 4 (asserted on `saveStockCount.mock.calls`) |
| Per-row `×`, on counted rows only, replacing `Remove` | 3 |
| `Clear all` beside Close; clears fields, reasons and the note; leaves store and tab | 3 |
| Store change clears every typed field | 2 (guard preserved and both directions re-proven) |
| Paging at 100; pager absent below the threshold | 4 |
| Search and category filter first, then paginate, resetting to page 1 | 4 |
| Typed counts outlive page, search, category | 1 (keyed by product id), 4 (tested) |
| Footer gains "N left alone" | 2 |
| Confirmation unfolds where the footer was, not a nested modal | 5 |
| Confirmation: every change from → to, with its reason including "no reason given" | 5 |
| Confirmation names the store | 5 |
| Confirmation discloses the stock-loss expense | 5 |
| Headline is the number that will *change* | 5 |
| "Go back", not "Cancel" | 5 |
| Nothing-will-change edge still offers to save | 5 |
| Confirmation scrolls rather than truncates | 5 (extension, flagged) |
| `closeAndReset` resets everything | 2, 4, 5 (each new piece of state reset in the task that adds it) |
| Stock-loss gating unchanged (`counted > 0` and a real shortfall) | 2 (`handExpenseCents`, one expression for both the disclosure and the write) |
| Sheet tab unchanged | 2 (only the two call sites that read by-hand state) |

No gaps found.

**2. Placeholder scan.** No `TBD`, no "implement later", no "similar to Task N", no "add appropriate error handling", no "write tests for the above" without the test code. Two deliberate elisions exist and both are marked with `/* …UNCHANGED… */` inside a code block that is quoting code the reader can see in the file at a named line range — they are not instructions to invent anything. Every other code step shows the complete text to write.

**3. Type consistency.** Checked across tasks: `CountEntry` / `CountEntries` / `CountRow` / `CountRowState` are used with the same spelling in Tasks 1–5. `walkRow(product, entries)` takes a single `Product` (used in the render map); `walkRows(catalogue, entries)` takes an array (used for the plan) — both are defined in Task 1 and both are used in Task 2 as declared. `plannedLines(rows: CountRow[])` returns `PlannedCountLine[]`, which is what `summariseCount` already accepts and what `CountConfirm`'s `lines` prop is typed as in Task 5. `pageSlice` returns `{ page, pageCount, items, from, to }` and Task 4 reads exactly those five names. `updateEntries` has the same signature in Tasks 2–5 (`(next: (current: CountEntries) => CountEntries) => void`). `countHint(typedCount, unreadable, summary)` is declared and called with three arguments in Task 2 and not touched afterwards. `CountRowView` gains exactly one prop between Task 2 and Task 3 (`onClear`), stated in both. `handExpenseCents` is declared in Task 2 and consumed by Task 5 under the same name. The component is `CountRowView` and the type is `CountRow`; they do not collide.
