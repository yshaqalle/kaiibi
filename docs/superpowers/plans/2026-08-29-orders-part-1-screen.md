# Orders Part 1 — the screen, brought up to standard

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A shop can tell at a glance which of its orders needs attention, and act on it without opening a sheet.

**Architecture:** All arithmetic moves into one pure module (`src/lib/orders-reporting.ts`) that the screen reads; `orders.tsx` gains a stat strip, search, sortable headers, a Waiting column and one inline action per row; `order-detail.tsx` gains a stage rail and, for a completed order, a reconciliation block. One narrow data change: `listOrders` starts selecting `sale_id`.

**Tech Stack:** React Native / Expo SDK 57, TypeScript, Jest, Supabase (PostgREST reads only).

**Spec:** [`docs/superpowers/specs/2026-08-29-orders-amend-and-share-design.md`](../specs/2026-08-29-orders-amend-and-share-design.md) — Part 1.
**Mockup:** [`docs/design/orders-redesign-mockup.html`](../../design/orders-redesign-mockup.html) — tabs *Redesigned · desktop*, *Phone*, *The order sheet*.

## Global Constraints

- **No migration.** Part 1 adds no RPC, no column and no grant. If a task seems to need one, stop and report — that is the signal it belongs in Part 2 or 3.
- **A default is not an enforcement** (spec constraint 11). It does not bite here because nothing new is exposed, and that is exactly why this part ships first.
- **Screens do no arithmetic.** A screen that sums its own rows is a second implementation of the report. Every sum, age, sort and filter lives in `orders-reporting.ts` and is unit-tested there. This rule is why Task 1 exists and comes first.
- **Expo docs are versioned** — read `https://docs.expo.dev/versions/v57.0.0/` before writing component code (`AGENTS.md`).
- **Bento only, no hex literals.** `orders.tsx` and `order-detail.tsx` are bento screens: `const theme = Colors.light`, tokens from [`src/constants/theme.ts`](../../../src/constants/theme.ts). Read `.claude/skills/building-bento-screens/SKILL.md`. Reuse `DataTable`, `BentoCard`, `StatTile variant="bento"`, `Badge variant="bento"`, `CategoryChip variant="bento"`, `Caveat`, `StatementRow`. **Do not copy `transactions-tab.tsx`'s markup** — it hand-rolls its table with `#F2F2F2` / `#ECECEC` / `borderRadius: 14`, four of that skill's red flags.
- **Colour is never the only signal** — a stale age, a shortfall or a money figure carries a glyph, a sign or the digits themselves as well as its colour.
- **`DataTable` already scrolls horizontally inside the card.** Never wrap it in another `ScrollView horizontal`.
- **A button that fails is worse than no button.** Every action offered is read from the permitted-moves table (`20260928000100`), the same guards `order-detail.tsx` already derives.
- **Tests:** `npm test`. **Types:** `npx tsc --noEmit`. **Lint:** `npm run lint` — it currently reports pre-existing failures; your job is not to move that number, only not to add to it. Measure it before you start.
- **Deliberately NOT in this part:** a date range over orders. `listOrders` fetches every order a shop has ever placed and the Done tab therefore grows without bound. That is real, and it needs `listOrders` to take a window — a data-layer change with its own test surface. Logged as a follow-up; do not add it here.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/lib/orders-reporting.ts` | **Create.** Every sum, age, staleness test, sort and search predicate. Pure — no imports from `lib/supabase`, no React. |
| `src/lib/__tests__/orders-reporting.test.ts` | **Create.** Unit tests for the above, with no component rendering. |
| `src/app/(admin)/orders.tsx` | **Modify.** Stat strip, search, sort, Waiting column, inline action, shortfall flags. |
| `src/components/orders/order-detail.tsx` | **Modify.** Stage rail; reconciliation block on a completed order. |
| `src/lib/storefront-admin.ts` | **Modify.** `ShopOrder.saleId`; `listOrders` selects `sale_id`. |
| `src/__tests__/orders-screen.test.tsx` | **Modify.** New behaviour; the existing 20-odd tests must keep passing untouched. |
| `src/components/orders/__tests__/order-detail.test.tsx` | **Modify.** Rail and reconciliation. |

**Task order:** 1 → 2 → 3 → 4 → 5 → 6. Task 1 is pure and blocks 2–5. Task 6 is independent of 2–5 and could be done in parallel by a human, but not by a second agent on the same branch.

---

### Task 1: `orders-reporting.ts` — every number the screen shows

**Files:**
- Create: `src/lib/orders-reporting.ts`
- Test: `src/lib/__tests__/orders-reporting.test.ts`

**Interfaces:**
- Consumes: `ShopOrder`, `OrderStatus` (type-only) from `@/lib/storefront-admin`; `ORDERS_NEEDING_ACTION` from `@/lib/order-status`.
- Produces — later tasks import exactly these:
  ```ts
  export type OrderSortField = 'number' | 'customer' | 'total' | 'waiting'
  export type OrderStats = { needsAttention: number; oldestWaitingMinutes: number | null;
                             openCount: number; openCents: number;
                             readyCount: number; readyCents: number; convertedCents: number }
  export function waitedMinutes(order: ShopOrder, now: Date): number
  export function isStale(order: ShopOrder, now: Date): boolean
  export function orderStats(orders: ShopOrder[], now: Date): OrderStats
  export function searchOrders(orders: ShopOrder[], query: string): ShopOrder[]
  export function sortOrders(orders: ShopOrder[], field: OrderSortField, dir: 'asc' | 'desc'): ShopOrder[]
  export const STALE_AFTER_MINUTES: 180
  ```

**`now` is a parameter, never `new Date()` inside.** A function that reads the clock cannot be tested without freezing time, and the screen needs one consistent `now` across a render anyway — otherwise two rows compare against two different clocks.

- [ ] **Step 1: Write the failing tests**

Create `src/lib/__tests__/orders-reporting.test.ts`:

```ts
import {
  isStale, orderStats, searchOrders, sortOrders, waitedMinutes, STALE_AFTER_MINUTES,
} from '@/lib/orders-reporting';
import type { ShopOrder } from '@/lib/storefront-admin';

const NOW = new Date('2026-08-29T12:00:00Z');

function order(over: Partial<ShopOrder> = {}): ShopOrder {
  return {
    id: 'o1', number: 1, customerName: 'Amina Warsame', customerPhone: '0634412290',
    fulfilment: 'collect', deliveryArea: null, deliveryLandmark: null, note: null,
    status: 'pending', cancellationReason: null, itemCount: 3,
    subtotalCents: 4450, deliveryFeeCents: 0, totalCents: 4450,
    createdAt: '2026-08-29T10:00:00Z', ...over,
  };
}

describe('waitedMinutes', () => {
  it('measures from createdAt to the now it is given', () => {
    expect(waitedMinutes(order({ createdAt: '2026-08-29T10:00:00Z' }), NOW)).toBe(120);
  });

  it('never returns a negative age for an order stamped in the future', () => {
    expect(waitedMinutes(order({ createdAt: '2026-08-29T13:00:00Z' }), NOW)).toBe(0);
  });
});

describe('isStale', () => {
  it('is false below the threshold', () => {
    expect(isStale(order({ createdAt: '2026-08-29T09:30:00Z' }), NOW)).toBe(false); // 150m
  });

  it('is true at and above the threshold', () => {
    expect(isStale(order({ createdAt: '2026-08-29T09:00:00Z' }), NOW)).toBe(true); // 180m
  });

  // A finished order is not "waiting" no matter how old it is -- otherwise every
  // completed order the shop has ever taken reads as overdue forever.
  it('is false for a completed or cancelled order however old', () => {
    expect(isStale(order({ status: 'completed', createdAt: '2026-01-01T00:00:00Z' }), NOW)).toBe(false);
    expect(isStale(order({ status: 'cancelled', createdAt: '2026-01-01T00:00:00Z' }), NOW)).toBe(false);
  });
});

describe('orderStats', () => {
  const orders = [
    order({ id: 'a', status: 'pending',   totalCents: 4750, createdAt: '2026-08-29T10:00:00Z' }), // 120m
    order({ id: 'b', status: 'pending',   totalCents: 1200, createdAt: '2026-08-29T08:00:00Z' }), // 240m
    order({ id: 'c', status: 'accepted',  totalCents: 12800 }),
    order({ id: 'd', status: 'ready',     totalCents: 19000 }),
    order({ id: 'e', status: 'completed', totalCents: 8600 }),
    order({ id: 'f', status: 'cancelled', totalCents: 2800 }),
  ];

  it('counts only pending orders as needing attention', () => {
    expect(orderStats(orders, NOW).needsAttention).toBe(2);
  });

  it('reports the oldest pending wait, not the oldest order', () => {
    expect(orderStats(orders, NOW).oldestWaitingMinutes).toBe(240);
  });

  // Property 5: open value is what customers have ASKED for. A completed order's
  // money has already reached the books and a cancelled one never will, so
  // including either would make the caveat under this tile untrue.
  it('sums open orders only -- pending, accepted and ready', () => {
    const s = orderStats(orders, NOW);
    expect(s.openCount).toBe(4);
    expect(s.openCents).toBe(4750 + 1200 + 12800 + 19000);
  });

  it('reports ready separately, since that is money sitting on a shelf', () => {
    const s = orderStats(orders, NOW);
    expect(s.readyCount).toBe(1);
    expect(s.readyCents).toBe(19000);
  });

  it('counts completed orders as converted, and never counts cancelled ones anywhere', () => {
    const s = orderStats(orders, NOW);
    expect(s.convertedCents).toBe(8600);
    expect(s.openCents).not.toContain?.(2800);
    expect(s.openCents + s.convertedCents).toBe(4750 + 1200 + 12800 + 19000 + 8600);
  });

  it('has no oldest wait when nothing is pending', () => {
    expect(orderStats([order({ status: 'completed' })], NOW).oldestWaitingMinutes).toBeNull();
  });
});

describe('searchOrders', () => {
  const orders = [
    order({ id: 'a', number: 1042, customerName: 'Amina Warsame', customerPhone: '0634412290' }),
    order({ id: 'b', number: 1041, customerName: 'Khadra Ismail', customerPhone: '0637781140',
            fulfilment: 'deliver', deliveryArea: 'Koodbuur', deliveryLandmark: 'behind the fuel station' }),
  ];

  it('returns everything for a blank or whitespace query', () => {
    expect(searchOrders(orders, '')).toHaveLength(2);
    expect(searchOrders(orders, '   ')).toHaveLength(2);
  });

  it('matches an order number with or without the hash', () => {
    expect(searchOrders(orders, '1042').map((o) => o.id)).toEqual(['a']);
    expect(searchOrders(orders, '#1042').map((o) => o.id)).toEqual(['a']);
  });

  it('matches a customer name case-insensitively', () => {
    expect(searchOrders(orders, 'khadra').map((o) => o.id)).toEqual(['b']);
  });

  it('matches a phone number', () => {
    expect(searchOrders(orders, '4412290').map((o) => o.id)).toEqual(['a']);
  });

  // The landmark is what a driver actually searches by -- "the one behind the
  // fuel station" is how a shop remembers an order, not its number.
  it('matches a delivery landmark and area', () => {
    expect(searchOrders(orders, 'fuel station').map((o) => o.id)).toEqual(['b']);
    expect(searchOrders(orders, 'koodbuur').map((o) => o.id)).toEqual(['b']);
  });

  it('returns nothing when nothing matches, rather than everything', () => {
    expect(searchOrders(orders, 'zzz')).toHaveLength(0);
  });
});

describe('sortOrders', () => {
  const orders = [
    order({ id: 'a', number: 2, customerName: 'Bashir', totalCents: 300, createdAt: '2026-08-29T11:00:00Z' }),
    order({ id: 'b', number: 1, customerName: 'Amina',  totalCents: 900, createdAt: '2026-08-29T09:00:00Z' }),
  ];

  it('does not mutate the array it is given', () => {
    const before = orders.map((o) => o.id);
    sortOrders(orders, 'total', 'asc');
    expect(orders.map((o) => o.id)).toEqual(before);
  });

  it('sorts by number, total and customer in both directions', () => {
    expect(sortOrders(orders, 'number', 'asc').map((o) => o.number)).toEqual([1, 2]);
    expect(sortOrders(orders, 'total', 'desc').map((o) => o.totalCents)).toEqual([900, 300]);
    expect(sortOrders(orders, 'customer', 'asc').map((o) => o.customerName)).toEqual(['Amina', 'Bashir']);
  });

  // Waiting is age, so the OLDEST order is the one that has waited LONGEST --
  // sorting waiting 'desc' must put the oldest first, which is the opposite of
  // sorting createdAt 'desc'. Getting this backwards hides the urgent order.
  it('sorts waiting descending oldest-first', () => {
    expect(sortOrders(orders, 'waiting', 'desc').map((o) => o.id)).toEqual(['b', 'a']);
  });
});
```

- [ ] **Step 2: Run and watch them fail**

```bash
npx jest src/lib/__tests__/orders-reporting.test.ts
```

Expected: FAIL — `Cannot find module '@/lib/orders-reporting'`.

- [ ] **Step 3: Implement**

Create `src/lib/orders-reporting.ts`:

```ts
import { ORDERS_NEEDING_ACTION } from '@/lib/order-status';
import type { ShopOrder } from '@/lib/storefront-admin';

// Every number the Orders screen shows, in one place.
//
// The screen does no arithmetic of its own, on purpose: a component that sums
// its own rows is a second implementation of the same report, and the two
// drift the first time either changes. It is also the only way these sums get
// tested at all -- a pure module needs no renderer, no Supabase mock and no
// fake clock.
//
// `now` is a PARAMETER everywhere it is needed, never `new Date()` inside a
// function. A function that reads the clock cannot be tested without freezing
// time, and the screen wants one consistent `now` for a whole render anyway --
// otherwise two rows in the same table are measured against two clocks.

/**
 * How long an unfinished order may sit before the screen calls it out.
 *
 * Three hours, and it is a judgement rather than a measurement -- nobody has
 * asked a shop yet. ONE threshold, not one per fulfilment type: a collect
 * order that nobody has accepted is exactly as ignored as a delivery that
 * nobody has accepted, and the difference between them starts only once
 * someone has picked it up. Revisit with a real shop.
 */
export const STALE_AFTER_MINUTES = 180 as const;

export type OrderSortField = 'number' | 'customer' | 'total' | 'waiting';

export type OrderStats = {
  /** Orders nobody has looked at yet. The one number worth acting on within the hour. */
  needsAttention: number;
  /** How long the oldest of those has waited, or null when none are pending. */
  oldestWaitingMinutes: number | null;
  openCount: number;
  openCents: number;
  readyCount: number;
  readyCents: number;
  convertedCents: number;
};

const isOpen = (order: ShopOrder): boolean => ORDERS_NEEDING_ACTION.includes(order.status);

export function waitedMinutes(order: ShopOrder, now: Date): number {
  const ms = now.getTime() - new Date(order.createdAt).getTime();
  // Clamped at zero: a row stamped slightly in the future (clock skew between
  // the shop's phone and the database) must read "just now", never a negative
  // age that sorts to the top as the most urgent thing on the screen.
  return Math.max(0, Math.floor(ms / 60000));
}

export function isStale(order: ShopOrder, now: Date): boolean {
  // A finished order is not waiting for anything. Without this every completed
  // order a shop has ever taken reads as overdue, forever, and the signal dies.
  if (!isOpen(order)) return false;
  return waitedMinutes(order, now) >= STALE_AFTER_MINUTES;
}

export function orderStats(orders: ShopOrder[], now: Date): OrderStats {
  const pending = orders.filter((o) => o.status === 'pending');
  const open = orders.filter(isOpen);
  const ready = orders.filter((o) => o.status === 'ready');

  return {
    needsAttention: pending.length,
    oldestWaitingMinutes: pending.length
      ? Math.max(...pending.map((o) => waitedMinutes(o, now)))
      : null,
    openCount: open.length,
    // Property 5: this is what customers have ASKED for, not money taken. A
    // completed order's total already reached the books through
    // complete_storefront_order, and a cancelled one never will -- including
    // either would make the caveat printed under this figure untrue.
    openCents: open.reduce((sum, o) => sum + o.totalCents, 0),
    readyCount: ready.length,
    readyCents: ready.reduce((sum, o) => sum + o.totalCents, 0),
    convertedCents: orders
      .filter((o) => o.status === 'completed')
      .reduce((sum, o) => sum + o.totalCents, 0),
  };
}

export function searchOrders(orders: ShopOrder[], query: string): ShopOrder[] {
  const q = query.trim().toLowerCase().replace(/^#/, '');
  if (!q) return orders;
  return orders.filter((o) =>
    String(o.number).includes(q) ||
    o.customerName.toLowerCase().includes(q) ||
    o.customerPhone.toLowerCase().includes(q) ||
    (o.deliveryArea ?? '').toLowerCase().includes(q) ||
    // The landmark is how a shop actually remembers a delivery -- "the one
    // behind the fuel station", not its number.
    (o.deliveryLandmark ?? '').toLowerCase().includes(q)
  );
}

export function sortOrders(orders: ShopOrder[], field: OrderSortField, dir: 'asc' | 'desc'): ShopOrder[] {
  const sign = dir === 'asc' ? 1 : -1;
  // Copied before sorting: Array.prototype.sort mutates, and the caller's array
  // is state that React compares by identity.
  return [...orders].sort((a, b) => {
    switch (field) {
      case 'number': return (a.number - b.number) * sign;
      case 'customer': return a.customerName.localeCompare(b.customerName) * sign;
      case 'total': return (a.totalCents - b.totalCents) * sign;
      // Waiting is AGE, so longest-waiting is oldest -- the reverse of sorting
      // by createdAt. 'desc' on this column must surface the order that has
      // been ignored longest, which is the whole reason the column exists.
      case 'waiting': return (new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()) * sign;
    }
  });
}
```

- [ ] **Step 4: Run the tests and the type check**

```bash
npx jest src/lib/__tests__/orders-reporting.test.ts && npx tsc --noEmit
```

Expected: all PASS, `tsc` exits 0.

- [ ] **Step 5: Mutation pass**

This repo's bar (see `.superpowers/sdd/progress.md`): a mutation that does not redden is a finding. Apply each, run the tests, confirm RED, revert:

| # | Mutation | Must redden |
|---|---|---|
| M1 | `Math.max(0, …)` → `Math.floor(ms / 60000)` | future-stamped order test |
| M2 | `isStale` drops the `isOpen` guard | completed-order test |
| M3 | `>=` → `>` in `isStale` | at-threshold test |
| M4 | `openCents` includes completed | open-sum test |
| M5 | `sortOrders` returns `orders.sort(...)` (no copy) | no-mutate test |
| M6 | `waiting` sort compares `a` to `b` instead of `b` to `a` | oldest-first test |
| M7 | `searchOrders` returns `orders` when nothing matches | no-match test |

Report any that stay green with your analysis — do not quietly fix the test.

- [ ] **Step 6: Commit**

```bash
git add src/lib/orders-reporting.ts src/lib/__tests__/orders-reporting.test.ts
git commit -m "Every number the Orders screen shows, in one testable place

A screen that sums its own rows is a second implementation of the report,
and the two drift the first time either changes. These sums also could not
be tested at all while they lived in a component: a pure module needs no
renderer, no Supabase mock and no fake clock.

now is a parameter everywhere rather than new Date() inside, so the tests
need no frozen clock and every row in one render is measured against one
clock.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: The stat strip

**Files:**
- Modify: `src/app/(admin)/orders.tsx`
- Test: `src/__tests__/orders-screen.test.tsx`

**Interfaces:**
- Consumes: `orderStats`, `OrderStats` from Task 1.
- Produces: nothing later tasks depend on.

Four `StatTile variant="bento"` in a `BentoCard`, above the existing table, with the existing `Caveat` unchanged beneath. Mockup: *Redesigned · desktop*, top row.

- [ ] **Step 1: Write the failing tests**

Add to `src/__tests__/orders-screen.test.tsx`, following its existing `renderScreen` helper and mock setup (`jest.mock('@/lib/storefront-admin')` is already in place at the top of that file):

```tsx
describe('the stat strip', () => {
  it('leads with what nobody has looked at yet, and how long it has waited', async () => {
    const { getByText } = await renderScreen([
      makeOrder({ id: 'a', status: 'pending', createdAt: hoursAgo(4) }),
      makeOrder({ id: 'b', status: 'pending', createdAt: hoursAgo(1) }),
      makeOrder({ id: 'c', status: 'ready' }),
    ]);
    expect(getByText('Needs you now')).toBeTruthy();
    expect(getByText('2')).toBeTruthy();
    expect(getByText(/oldest waiting 4h/i)).toBeTruthy();
  });

  it('never calls open order value revenue', async () => {
    const { getByText, queryByText } = await renderScreen([
      makeOrder({ status: 'pending', totalCents: 4750 }),
    ]);
    expect(getByText('Promised')).toBeTruthy();
    expect(queryByText(/revenue/i)).toBeNull();
  });

  it('shows no waiting hint when nothing is pending', async () => {
    const { queryByText } = await renderScreen([makeOrder({ status: 'ready' })]);
    expect(queryByText(/oldest waiting/i)).toBeNull();
  });
});
```

Add the two helpers beside the file's existing fixtures if they are not already there:

```tsx
const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();
```

- [ ] **Step 2: Run and watch them fail**

```bash
npx jest src/__tests__/orders-screen.test.tsx -t "stat strip"
```

Expected: FAIL — `Unable to find an element with text: Needs you now`.

- [ ] **Step 3: Implement**

In `src/app/(admin)/orders.tsx`, add imports:

```tsx
import { StatTile } from '@/components/stat-tile';
import { orderStats } from '@/lib/orders-reporting';
import { formatCompactCents } from '@/lib/currency';
```

Compute once per render, above the existing `filteredOrders`:

```tsx
  // ONE clock for the whole render: two rows measured against two `new Date()`
  // calls can disagree, and the tiles would then disagree with the column.
  const now = new Date();
  const stats = orderStats(orders, now);
```

Add a helper at module scope, beside `whenLabel`:

```tsx
// "4h", "35m" -- an age, not a duration in words. Short because it sits inside
// a tile's hint line and beside it in a table cell.
function ageLabel(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h`;
}
```

Render above the existing `<BentoCard title="Orders" …>`:

```tsx
        <BentoCard title="Where these orders stand" scope={`${stats.openCount} open`}>
          <View style={styles.metricRow}>
            {/* First, and accented, because it is the only figure here a shop
                must act on within the hour. */}
            <StatTile
              variant="bento"
              tone="accent"
              value={String(stats.needsAttention)}
              label="Needs you now"
              hint={stats.oldestWaitingMinutes === null ? 'nothing new' : `oldest waiting ${ageLabel(stats.oldestWaitingMinutes)}`}
            />
            {/* Deliberately not "revenue" -- the caveat below says why in
                words, and this label must not contradict it. */}
            <StatTile
              variant="bento"
              value={formatCompactCents(stats.openCents)}
              label="Promised"
              hint={`across ${stats.openCount} open ${stats.openCount === 1 ? 'order' : 'orders'}`}
            />
            <StatTile
              variant="bento"
              value={formatCompactCents(stats.readyCents)}
              label="Ready to hand over"
              hint={`${stats.readyCount} prepped, uncollected`}
            />
            <StatTile
              variant="bento"
              value={formatCompactCents(stats.convertedCents)}
              label="Converted"
              hint="reached the books as sales"
            />
          </View>
        </BentoCard>
```

Add to `StyleSheet.create`:

```tsx
  metricRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
```

**Check `StatTile`'s `tone` accepts `'accent'`** before using it (`src/components/stat-tile.tsx`). If it does not, drop the prop rather than adding a tone — the tile is first in the row, which already carries the emphasis.

- [ ] **Step 4: Run the tests**

```bash
npx jest src/__tests__/orders-screen.test.tsx && npx tsc --noEmit
```

Expected: the new tests PASS **and every pre-existing test in that file still passes**. If an existing test now finds two elements with the same text, make the new tile's label more specific rather than loosening the old assertion.

- [ ] **Step 5: Commit**

```bash
git add src/app/\(admin\)/orders.tsx src/__tests__/orders-screen.test.tsx
git commit -m "Orders leads with what needs acting on

Four tiles, and the first one is the point: how many orders nobody has
looked at, and how long the oldest has waited. That was previously
knowable only by counting chips.

Open value is labelled Promised, never revenue -- the caveat beneath it
already says none of it has reached the books, and a label that said
otherwise would contradict the sentence directly below it.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: Search, sortable headers, and the Waiting column

**Files:**
- Modify: `src/app/(admin)/orders.tsx`
- Test: `src/__tests__/orders-screen.test.tsx`

**Interfaces:**
- Consumes: `searchOrders`, `sortOrders`, `isStale`, `waitedMinutes`, `OrderSortField` from Task 1.
- Produces: nothing later tasks depend on.

Replaces the `When` column with `Waiting`, adds a search box above the table, and makes Order / Customer / Total / Waiting headers sortable. Mockup: *Redesigned · desktop*.

- [ ] **Step 1: Write the failing tests**

```tsx
describe('finding an order', () => {
  it('filters by customer name as the shop types', async () => {
    const { getByPlaceholderText, queryByText } = await renderScreen([
      makeOrder({ id: 'a', number: 1042, customerName: 'Amina Warsame' }),
      makeOrder({ id: 'b', number: 1041, customerName: 'Khadra Ismail' }),
    ]);
    fireEvent.changeText(getByPlaceholderText(/search/i), 'khadra');
    expect(queryByText('#1041')).toBeTruthy();
    expect(queryByText('#1042')).toBeNull();
  });

  it('says nothing matched, rather than showing an empty table with no explanation', async () => {
    const { getByPlaceholderText, getByText } = await renderScreen([makeOrder({ number: 1042 })]);
    fireEvent.changeText(getByPlaceholderText(/search/i), 'zzz');
    expect(getByText(/no orders match/i)).toBeTruthy();
  });
});

describe('the waiting column', () => {
  it('shows how long an open order has waited', async () => {
    const { getByText } = await renderScreen([
      makeOrder({ status: 'pending', createdAt: hoursAgo(2) }),
    ]);
    expect(getByText('2h')).toBeTruthy();
  });

  // A finished order is not waiting for anything, and an age on it would read
  // as overdue forever.
  it('shows a dash, not an age, for a completed order', async () => {
    const { getByText, queryByText } = await renderScreen([
      makeOrder({ status: 'completed', createdAt: hoursAgo(200) }),
    ]);
    expect(queryByText('200h')).toBeNull();
    expect(getByText('—')).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run and watch them fail**

```bash
npx jest src/__tests__/orders-screen.test.tsx -t "waiting column"
```

Expected: FAIL.

- [ ] **Step 3: Implement**

State, beside the existing `statusFilter`:

```tsx
  const [search, setSearch] = useState('');
  const [sortField, setSortField] = useState<OrderSortField>('waiting');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('desc');
```

Replace the existing `filteredOrders` line with the search-and-sort chain:

```tsx
  const filteredOrders = sortOrders(
    searchOrders(orders.filter((order) => order.status === statusFilter), search),
    sortField,
    sortDirection
  );
```

Replace the `when` column in `COLUMNS`. `COLUMNS` is currently a module-scope constant; it now needs `now`, so turn it into a function called from the component — **do not define a component inside render**, and keep the array itself outside:

```tsx
function columnsFor(now: Date): Column<ShopOrder>[] {
  return [
    // ... every existing column unchanged, then, replacing `when`:
    {
      key: 'waiting',
      header: 'Waiting',
      numeric: true,
      width: 90,
      render: (row) => {
        // A finished order is not waiting for anything. An age here would read
        // as overdue forever, which is how a signal stops being trusted.
        if (row.status === 'completed' || row.status === 'cancelled') {
          return <ValueCell value="—" tone="muted" />;
        }
        const minutes = waitedMinutes(row, now);
        // The digits are always there; the tone is the second signal, never
        // the only one.
        return <ValueCell value={ageLabel(minutes)} tone={isStale(row, now) ? 'warn' : 'muted'} strong={isStale(row, now)} />;
      },
    },
  ];
}
```

**Check `ValueCell`'s `tone` union** in `src/components/ui/data-table.tsx` before using `'warn'`. If there is no warning tone, use `strong` alone plus the existing `bentoWarn` token through a small local `Text` — never a hex literal.

Search box, between the tab row and the table's `BentoCard`:

```tsx
        <TextInput
          value={search}
          onChangeText={setSearch}
          placeholder="Search order #, customer, phone or landmark"
          placeholderTextColor={theme.bentoMuted}
          style={styles.search}
          accessibilityLabel="Search orders"
        />
```

```tsx
  search: { backgroundColor: theme.bentoSoft, borderRadius: 12, height: 42, paddingHorizontal: 13, color: theme.bentoInk, fontSize: 13 },
```

Update `emptyLabel` so a search that matches nothing says so:

```tsx
  const emptyLabel = loading
    ? 'Loading…'
    : orders.length === 0
      ? 'No orders yet.'
      : search.trim()
        ? 'No orders match your search.'
        : `No ${activeTab.label.toLowerCase()} orders.`;
```

**Sortable headers:** `DataTable` renders its own header row from `column.header` and has no sort affordance. Adding one means either a `onHeaderPress`/`sortIndicator` prop on `DataTable` — which every other table would inherit — or a header row local to this screen. **Take the `DataTable` prop route**, optional and defaulted off, so Transactions can adopt it later. If that turns out to be more than a small change, STOP and report: it is a separate task, not a silent redesign of a shared component.

- [ ] **Step 4: Run the tests**

```bash
npx jest src/__tests__/orders-screen.test.tsx && npx tsc --noEmit
```

Expected: new tests PASS, all pre-existing PASS. One existing test asserts the `When` column's date format — update it to the new column deliberately, and say so in the commit.

- [ ] **Step 5: Commit**

```bash
git add src/app/\(admin\)/orders.tsx src/components/ui/data-table.tsx src/__tests__/orders-screen.test.tsx
git commit -m "Orders gains search, sorting, and a Waiting column

Waiting is this screen's own column and Transactions has no equivalent,
because a sale is instantaneous -- an order that has sat unaccepted for
four hours is the failure this screen exists to prevent. It shows an em
dash on a finished order rather than an age, since a completed order is
not waiting for anything and an age on it would read as overdue forever.

The When column it replaces said when the order arrived, which the shop
can already see from the order number's ordering.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: One inline action per row

**Files:**
- Modify: `src/app/(admin)/orders.tsx`
- Test: `src/__tests__/orders-screen.test.tsx`

**Interfaces:**
- Consumes: the existing `runAction` wrapper and `acceptOrder` / `markOrderReady` already imported in `orders.tsx`.
- Produces: nothing.

The one legal next move, on the row. Mockup: *Redesigned · desktop*, `Next` column.

**The rule that governs this task:** a button that fails is worse than no button. The move offered is read from the same guards `order-detail.tsx` derives from the permitted-moves table — `pending → Accept`, `accepted → Mark ready`, `ready → Complete` **and only with `pos.access`**. Terminal rows get an em dash, never a disabled button. **Cancel is never inline** — it requires a typed reason.

- [ ] **Step 1: Write the failing tests**

```tsx
describe('the inline next action', () => {
  it('offers Accept on a new order', async () => {
    const { getByLabelText } = await renderScreen([makeOrder({ number: 1042, status: 'pending' })]);
    expect(getByLabelText('Accept order 1042')).toBeTruthy();
  });

  it('offers Mark ready on an accepted order', async () => {
    const { getByLabelText } = await renderScreen([makeOrder({ number: 1040, status: 'accepted' })]);
    expect(getByLabelText('Mark order 1040 ready')).toBeTruthy();
  });

  // A member who cannot ring up a sale cannot complete an order either --
  // complete_storefront_order delegates to complete_sale, which requires
  // pos.access. A button that always failed would be worse than none.
  it('offers no Complete button to a member without pos access', async () => {
    const { queryByLabelText } = await renderScreen([makeOrder({ number: 1038, status: 'ready' })], { posAccess: false });
    expect(queryByLabelText(/complete/i)).toBeNull();
  });

  it('offers nothing on a completed or cancelled order', async () => {
    const { queryByLabelText } = await renderScreen([
      makeOrder({ number: 1037, status: 'completed' }),
      makeOrder({ number: 1036, status: 'cancelled' }),
    ]);
    expect(queryByLabelText(/accept|ready|complete/i)).toBeNull();
  });

  it('never offers Cancel inline, because cancelling needs a reason', async () => {
    const { queryByLabelText } = await renderScreen([makeOrder({ status: 'pending' })]);
    expect(queryByLabelText(/cancel/i)).toBeNull();
  });

  it('accepts the order without opening the sheet', async () => {
    const { getByLabelText, queryByText } = await renderScreen([makeOrder({ number: 1042, status: 'pending' })]);
    fireEvent.press(getByLabelText('Accept order 1042'));
    await waitFor(() => expect(acceptOrder).toHaveBeenCalled());
    expect(queryByText('What to collect')).toBeNull();
  });
});
```

`renderScreen` will need a `posAccess` option — extend the existing `use-auth` mock in that file so `can` returns false for `pos.access` when asked. Follow how the file already mocks `can`.

- [ ] **Step 2: Run and watch them fail**

```bash
npx jest src/__tests__/orders-screen.test.tsx -t "inline next action"
```

- [ ] **Step 3: Implement**

`columnsFor` gains the parameters it needs to render an action, so its signature becomes:

```tsx
function columnsFor(
  now: Date,
  hasPosAccess: boolean,
  onAction: (order: ShopOrder) => void,
  busyId: string | null
): Column<ShopOrder>[]
```

and the new last column:

```tsx
    {
      key: 'next',
      header: 'Next',
      numeric: true,
      width: 108,
      render: (row) => {
        // Read from the permitted-moves table (20260928000100), not guessed.
        // 'ready' also needs pos.access, because completing delegates to
        // complete_sale -- see order-detail.tsx's own gate.
        const label =
          row.status === 'pending' ? 'Accept'
          : row.status === 'accepted' ? 'Mark ready'
          : row.status === 'ready' && hasPosAccess ? 'Complete'
          : null;
        // An em dash, never a disabled button: a control that can never work
        // should not be drawn as one that might.
        if (!label) return <ValueCell value="—" tone="muted" />;
        return (
          <Pressable
            onPress={() => onAction(row)}
            disabled={busyId !== null}
            accessibilityLabel={
              row.status === 'pending' ? `Accept order ${row.number}`
              : row.status === 'accepted' ? `Mark order ${row.number} ready`
              : `Complete order ${row.number}`
            }
            style={[styles.rowAction, busyId !== null && styles.rowActionBusy]}
          >
            <Text style={styles.rowActionText}>{busyId === row.id ? '…' : label}</Text>
          </Pressable>
        );
      },
    },
```

**`Complete` opens the sheet rather than firing**, because completing needs a payment method — the sheet already owns that form. So `onAction` forks:

```tsx
  const [busyId, setBusyId] = useState<string | null>(null);

  const runRowAction = useCallback(
    (order: ShopOrder) => {
      // Completing needs a payment method, and that form lives in the sheet.
      // The row's job is to get you there in one tap, not to duplicate it.
      if (order.status === 'ready') { openDetail(order); return; }
      setBusyId(order.id);
      const move = order.status === 'pending'
        ? () => acceptOrder(order.id)
        : () => markOrderReady(order.id);
      runAction(move, order.status === 'pending' ? 'Could not accept this order.' : 'Could not mark this order ready.')
        .finally(() => setBusyId(null));
    },
    [openDetail, runAction]
  );
```

**`runAction` currently closes the detail sheet on success** (`closeDetail()`), which is harmless when no sheet is open. Confirm that, and that its `setActionError` surfacing still reaches the reader — **an inline action that fails must not fail silently.** If the error only renders inside the sheet, surface it as a `Caveat tone="wrong"` on the screen instead, and say so in your report.

Styles:

```tsx
  rowAction: { backgroundColor: theme.bentoInk, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 6, alignItems: 'center' },
  rowActionBusy: { opacity: 0.5 },
  rowActionText: { color: '#FFFFFF', fontWeight: '800', fontSize: 11.5 },
```

- [ ] **Step 4: Run the tests**

```bash
npx jest src/__tests__/orders-screen.test.tsx && npx tsc --noEmit
```

- [ ] **Step 5: Commit**

```bash
git add src/app/\(admin\)/orders.tsx src/__tests__/orders-screen.test.tsx
git commit -m "Accept and ready an order from the row

A shop working the counter accepts four orders without opening four
sheets. The move offered is read from the permitted-moves table, so a row
never shows a button that would fail -- and a terminal row gets an em dash
rather than a disabled control, which reads as a thing that might work.

Complete still opens the sheet: it needs a payment method, and that form
already lives there. Cancel is never inline, because it needs a reason.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: Shortfall flags on the rows

**Files:**
- Modify: `src/app/(admin)/orders.tsx`
- Test: `src/__tests__/orders-screen.test.tsx`

**Interfaces:**
- Consumes: `checkOrderFulfilment(shopId, orderId)` from `@/lib/storefront-admin` (already imported).
- Produces: nothing.

A shop should see what it cannot fill while scanning, not one order at a time. Mockup: *Redesigned · desktop*, `short 2` under Items.

- [ ] **Step 1: Write the failing test**

```tsx
describe('shortfall flags', () => {
  it('marks a row the shop cannot fill', async () => {
    (checkOrderFulfilment as jest.Mock).mockResolvedValue([
      { productId: 'p1', productName: 'Sugar 2kg', quantity: 3, available: 1, shortBy: 2 },
    ]);
    const { findByText } = await renderScreen([makeOrder({ status: 'pending' })]);
    expect(await findByText(/short 2/i)).toBeTruthy();
  });

  // A completed order already had its stock decremented by its own completion,
  // and a cancelled one was never going to be filled -- a shortfall on either
  // is a fact about the past, not something to act on.
  it('never flags a completed or cancelled order', async () => {
    (checkOrderFulfilment as jest.Mock).mockResolvedValue([
      { productId: 'p1', productName: 'Sugar 2kg', quantity: 3, available: 1, shortBy: 2 },
    ]);
    const { queryByText } = await renderScreen([makeOrder({ status: 'completed' })]);
    await waitFor(() => expect(queryByText(/short/i)).toBeNull());
  });
});
```

- [ ] **Step 2: Run and watch it fail**

- [ ] **Step 3: Implement**

Fetch shortfalls for the **visible open rows only**, after the list loads:

```tsx
  // Keyed by order id. Only open orders are asked about: a completed order
  // already had its stock decremented by its own completion, and a cancelled
  // one was never going to be filled -- N1's reasoning in openDetail, applied
  // to the list.
  const [shortBy, setShortBy] = useState<Record<string, number>>({});

  useEffect(() => {
    if (!shop) return;
    const open = filteredOrders.filter((o) => UNCONFIRMED.includes(o.status));
    if (open.length === 0) { setShortBy({}); return; }
    let cancelled = false;
    Promise.all(
      open.map((o) =>
        checkOrderFulfilment(shop.id, o.id)
          .then((rows) => [o.id, rows.reduce((n, r) => n + r.shortBy, 0)] as const)
          // One row's failed check must not blank the whole column.
          .catch(() => [o.id, 0] as const)
      )
    ).then((pairs) => {
      if (!cancelled) setShortBy(Object.fromEntries(pairs.filter(([, n]) => n > 0)));
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shop, statusFilter, orders]);
```

**This is N queries for N visible rows.** Say so in your report with the row count it implies. If `checkOrderFulfilment` can take an array of order ids, use that instead — check its signature first. If it cannot, note it as a follow-up rather than widening the RPC here (that would be a migration, which this part forbids).

Render in the existing `items` column:

```tsx
  { key: 'items', header: 'Items', numeric: true, width: 76, render: (row) => (
      <View>
        <ValueCell value={String(row.itemCount)} tone="muted" />
        {shortBy[row.id] ? <Text style={styles.shortFlag}>short {shortBy[row.id]}</Text> : null}
      </View>
    ) },
```

```tsx
  shortFlag: { fontSize: 10.5, fontWeight: '750', color: theme.bentoLoss, textAlign: 'right', marginTop: 2 },
```

- [ ] **Step 4: Run the tests, then Step 5: Commit**

```bash
npx jest src/__tests__/orders-screen.test.tsx && npx tsc --noEmit
git add src/app/\(admin\)/orders.tsx src/__tests__/orders-screen.test.tsx
git commit -m "Say which orders cannot be filled, while scanning

checkOrderFulfilment already ran when a shop opened one order. Running it
for the visible open rows puts the shortfall in the list, so a shop sees
what it cannot fill without opening each order to find out.

Only open orders are asked about: a completed order already had its stock
decremented by its own completion, and a cancelled one was never going to
be filled.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: The stage rail and the reconciliation block

**Files:**
- Modify: `src/lib/storefront-admin.ts` (`ShopOrder.saleId`, `listOrders` select)
- Modify: `src/components/orders/order-detail.tsx`
- Test: `src/components/orders/__tests__/order-detail.test.tsx`, `src/lib/__tests__/storefront-admin.test.ts`

**Interfaces:**
- Consumes: `ORDER_STATUS_BADGE` (already in `order-detail.tsx`).
- Produces: `ShopOrder.saleId: string | null`.

Mockup: *The order sheet*, both frames.

**`ShopOrder` has no `saleId` today and `listOrders` does not select `sale_id`** — verified against `src/lib/storefront-admin.ts:671` and `:763`. The reconciliation block cannot be built without adding both. That is a widening of an existing `select`, not a migration.

- [ ] **Step 1: Write the failing tests**

```tsx
describe('the stage rail', () => {
  it('shows where the order has been and where it is', () => {
    const { getByText, getByLabelText } = renderDetail({ status: 'accepted' });
    ['Placed', 'Accepted', 'Ready', 'Done'].forEach((s) => expect(getByText(s)).toBeTruthy());
    expect(getByLabelText('Current stage: Accepted')).toBeTruthy();
  });

  // Cancelled is an off-ramp, not a stop on the road -- showing it as a fifth
  // step after Done would claim a cancelled order was nearly finished.
  it('renders cancelled as a terminal step, not a fifth stop', () => {
    const { getByText, queryByText } = renderDetail({ status: 'cancelled', cancellationReason: 'Out of stock' });
    expect(getByText('Cancelled')).toBeTruthy();
    expect(queryByText('Ready')).toBeNull();
  });
});

describe('the reconciliation block', () => {
  it('names the sale a completed order became', () => {
    const { getByText } = renderDetail({ status: 'completed', saleId: 'f3a2c1de-0000-0000-0000-000000000000', subtotalCents: 8600, deliveryFeeCents: 0, totalCents: 8600 });
    expect(getByText(/in Transactions/i)).toBeTruthy();
  });

  // The delivery fee never reaches the sale: complete_storefront_order pays
  // subtotal_cents only and posts the fee separately to 4300. Without this
  // line the two figures look like a discrepancy.
  it('says where the delivery fee went, so the gap is not read as a bug', () => {
    const { getByText } = renderDetail({ status: 'completed', saleId: 'f3a2c1de-0000-0000-0000-000000000000', subtotalCents: 18600, deliveryFeeCents: 400, totalCents: 19000 });
    expect(getByText(/4300 Delivery Income/)).toBeTruthy();
  });

  it('shows nothing to reconcile before the order is completed', () => {
    const { queryByText } = renderDetail({ status: 'ready', saleId: null });
    expect(queryByText(/in Transactions/i)).toBeNull();
  });
});
```

- [ ] **Step 2: Run and watch them fail**

- [ ] **Step 3: Widen the query**

In `src/lib/storefront-admin.ts`, add to `ShopOrder` after `totalCents`:

```ts
  /**
   * The sale this order became, or null until it is completed. Set by
   * complete_storefront_order in the same statement as the status
   * (20260928000200), so the two can never disagree.
   *
   * The link runs ONE WAY only -- there is no sales.order_id -- which is why
   * a completed order is indistinguishable from a walk-in once it reaches the
   * Transactions tab. The sheet's reconciliation block is this link read back.
   */
  saleId: string | null;
```

Add `sale_id` to `listOrders`'s select string and map it in `mapOrderRow` as `saleId: row.sale_id ?? null`, extending that function's row type.

- [ ] **Step 4: Implement the rail and the block**

Both live in `order-detail.tsx`. The rail derives from `order.status` alone — **no new data.** Per-step timestamps are deliberately absent: `orders` stores no per-transition history, so honest times would need new columns and a trigger. Render the sequence without a clock, and do not invent times from `createdAt`.

The reconciliation block renders only when `order.status === 'completed'`, showing: goods → the sale (short id), and the delivery fee → `4300 Delivery Income` **only when `deliveryFeeCents > 0`** — a `$0.00` delivery line on a collect order would promise something that order never had, the same rule the existing `StatementRow` breakdown already follows.

Use `StatementRow` and bento tokens. No hex literals.

- [ ] **Step 5: Run everything**

```bash
npm test && npx tsc --noEmit && npm run lint
```

Expected: all pass; lint no worse than the baseline you measured.

- [ ] **Step 6: Commit**

```bash
git add src/lib/storefront-admin.ts src/components/orders/order-detail.tsx src/components/orders/__tests__/order-detail.test.tsx src/lib/__tests__/storefront-admin.test.ts
git commit -m "An order says where it has been, and what it became

A badge says where an order is; the rail says where it has been and what
is left. Cancelled renders as a terminal step replacing whatever was next,
because it is an off-ramp rather than a stop on the road.

No timestamps on the steps: orders stores no per-transition history, so
honest times need new columns and a trigger. Sequence without a clock is
the true version of this.

The reconciliation block closes a real confusion. complete_storefront_order
pays complete_sale the goods subtotal only and posts the delivery fee
separately to 4300, so a delivered order reaches Transactions for less than
the customer paid and nothing on screen said why. listOrders now selects
sale_id to make that link readable.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Verification of the whole part

- [ ] `npm test && npx tsc --noEmit && npm run lint` — all green, lint no worse than baseline.
- [ ] **On a device.** Per `/testing-kaiibi`, native layout is verified in the running app, not by reading code. Web plus at least one native platform:
  1. The stat strip wraps to 2×2 on a phone with the accented tile first.
  2. The table scrolls sideways **inside** the card — the page itself never moves.
  3. Accept and Mark ready work from the row; a failure surfaces where the reader can see it.
  4. A stale order reads amber **and** shows its digits.
  5. The rail renders for each of the five statuses, cancelled included.

## Spec coverage

| Spec requirement (Part 1) | Task |
|---|---|
| Stat strip, four tiles | 2 |
| Caveat unchanged beneath it | 2 (assert it still renders) |
| Search over number, customer, phone, landmark | 1, 3 |
| Sortable headers | 1, 3 |
| Waiting column with staleness | 1, 3 |
| Inline next action, legal moves only | 4 |
| Row shortfall flags | 5 |
| Delivery split on the row | 3 |
| Stage rail | 6 |
| Reconciliation block | 6 |
| `ExportMenu` | **Not planned.** `ExportMenu` needs a header slot; this screen uses `ScreenHeader`, not the Accounting shell's `useHeaderActions`. Small, but it is a shell question — do it as a follow-up rather than reshaping the header mid-part. |
| Date range scoping Done/Cancelled | **Out of scope**, see Global Constraints |

## Open questions carried from the spec

1. **`STALE_AFTER_MINUTES = 180`** is a judgement, not a measurement, and one threshold rather than one per fulfilment type. Revisit with a real shop.
2. **Rail timestamps** need per-transition history that does not exist. Shipping sequence-without-clock.
3. **N shortfall queries for N visible rows** (Task 5). Batching needs an RPC change, which is Part 2 territory.
