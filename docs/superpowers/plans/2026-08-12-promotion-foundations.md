# Promotion Foundations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give promotions a start/end window, a "never auto-apply" flag and an archive; record on every sale item which promotion produced its discount; and add the discount permission the app has never had.

**Architecture:** Phase 1 of [`docs/superpowers/specs/2026-08-12-marketing-and-offers-design.md`](../specs/2026-08-12-marketing-and-offers-design.md). Two migrations and a set of client changes. All discount logic already funnels through one function — `bestPromotionForProduct()` in `src/lib/discounts.ts` — so the window is added there and every surface inherits it. Attribution rides inside the existing `p_items` jsonb, so neither RPC changes signature. The only new screen is a Marketing tab under People that the promotions editor moves into; it is the shell later phases fill.

**Tech Stack:** Expo SDK 57 / React Native, TypeScript, Expo Router, Supabase (Postgres + RLS), Jest.

## Global Constraints

- **Expo docs:** Read the exact versioned docs at https://docs.expo.dev/versions/v57.0.0/ before writing any code that touches an Expo API (`AGENTS.md`).
- **Migration ordering:** The newest existing migration is `20260825000800_support_thread_preview.sql`. New migrations in this plan MUST sort after it: use `20260826000000` and `20260826000100`. A lower timestamp will run out of order against an already-migrated database.
- **`CREATE OR REPLACE FUNCTION` rule:** Postgres replaces the whole body. When changing `complete_sale` or `edit_sale`, reproduce the **entire current body verbatim** and add only the lines this plan specifies. Current sources: `complete_sale` is `supabase/migrations/20260822000000_registers_and_sessions.sql` lines 734–1010; `edit_sale` is `supabase/migrations/20260820000100_loyalty_balance_rules.sql` lines 405–660.
- **Do not change either RPC's signature.** Attribution travels as new keys inside the existing `p_items` jsonb. A new parameter would create an overload and require new grants.
- **Existing behaviour must not change for existing rows.** `auto_apply` defaults `true`, `starts_at`/`ends_at`/`archived_at` default null, and null means "as it is today".
- **Permissions are enforced twice**, DB and client, and both are required (`src/lib/permissions.ts` header comment).
- **No dark mode.** Screens pin `Colors.light`.
- **People is still cream.** It reads `background` / `surface` / `border`, not the bento tokens. The Marketing tab matches its siblings; do not half-apply bento tokens to it (`.claude/skills/building-bento-screens/SKILL.md`).
- **Tests:** `npm test` runs Jest. Unit tests live in `src/lib/__tests__/<name>.test.ts`. DB verification scripts live in `supabase/tests/verify-<name>.sql`.

## File Structure

| File | Responsibility |
|---|---|
| `supabase/migrations/20260826000000_promotion_window_and_archive.sql` | New columns on `promotions` + the ordering constraint |
| `supabase/migrations/20260826000100_sale_promotion_attribution.sql` | `sale_items` columns, both RPCs replaced, `discounts.manual` granted to existing roles |
| `supabase/tests/verify-promotions.sql` | Manual DB verification, matching the existing `verify-*.sql` convention |
| `src/types/models.ts` | `Promotion` gains four fields |
| `src/lib/promotions.ts` | Mapper, create/update inputs, `archivePromotion`, archived rows excluded from lists |
| `src/lib/discounts.ts` | `isPromotionLive()`; window + `auto_apply` folded into the existing single gate |
| `src/lib/cart.ts` | `buildSalePayload` carries `promotion_id` / `promotion_name` per line |
| `src/lib/permissions.ts` | `discounts.apply` and `discounts.manual` in the catalog |
| `src/components/discount-editor.tsx` | Gated on `discounts.manual` |
| `src/components/settings/panels/sales-panel.tsx` | Editor gains window + auto-apply; Settings panel becomes a read-only summary |
| `src/components/marketing/promotions-tab.tsx` | New — the promotions editor in its new home |
| `src/app/(admin)/(tabs)/people.tsx` | Fifth tab wired in |

---

### Task 1: The promotion window and auto-apply, in the one gate that decides

Pure logic, no database, no UI. This is where the real risk lives, so it goes first and is fully test-driven.

**Files:**
- Modify: `src/types/models.ts:331-347` (the `Promotion` type)
- Modify: `src/lib/discounts.ts`
- Test: `src/lib/__tests__/discounts.test.ts` (create — there is no test file for this module today)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `isPromotionLive(promo: Promotion, now?: number): boolean`
  - `bestPromotionForProduct(product: Product, promotions: Promotion[], lineGrossCents: number, now?: number): Promotion | null`
  - `Promotion` gains `startsAt: string | null`, `endsAt: string | null`, `autoApply: boolean`, `archivedAt: string | null`

`now` is a **defaulted** parameter (`now: number = Date.now()`) on every function that needs it. That keeps all ~12 existing call sites compiling untouched while making the window testable without mocking the clock.

- [ ] **Step 1: Add the four fields to the `Promotion` type**

In `src/types/models.ts`, replace the `Promotion` type (currently at lines 331–347) with:

```ts
export type Promotion = {
  id: string;
  shopId: string;
  // Which store this belongs to. NULL = business-wide — head-office costs,
  // group marketing, a licence covering every store. A real value, not a gap:
  // per-store reporting excludes it, business-wide reporting includes it
  // (migration 20260816000000).
  locationId: string | null;
  name: string;
  discountType: 'percentage' | 'fixed';
  discountValue: number;
  scope: 'store' | 'brand' | 'category';
  // The brand or category name for those two scopes; null for 'store'.
  scopeValue: string | null;
  active: boolean;
  // The window the offer runs in. Null start = already running; null end =
  // until someone switches it off. These are SCHEDULING, and `active` is the
  // hard "off now" override on top of them — a promotion applies only when it
  // is active AND inside its window. See src/lib/discounts.ts.
  startsAt: string | null;
  endsAt: string | null;
  // False means the offer never fires by itself and only reaches a sale when
  // a cashier picks it. Campaign codes, staff discount, a goodwill gesture.
  autoApply: boolean;
  // A third state, distinct from the other two: `active = false` is paused and
  // may come back, an `endsAt` in the past is "this run is over", and this is
  // "gone from every list, kept only so old sales still read". Set instead of
  // deleting once a promotion has been applied to a sale.
  archivedAt: string | null;
  createdAt: string;
};
```

- [ ] **Step 2: Write the failing tests**

Create `src/lib/__tests__/discounts.test.ts`:

```ts
import {
  bestPromotionForProduct,
  discountAmountCents,
  isPromotionLive,
  lineDiscountCents,
} from '@/lib/discounts';
import type { CartLine, Product, Promotion } from '@/types/models';

const AUG_14 = Date.parse('2026-08-14T10:00:00Z');

function makeProduct(overrides: Partial<Product> = {}): Product {
  return {
    id: 'p1', shopId: 's1', name: 'Canvas shoes', description: null, sku: null, barcode: null,
    brand: null, category: null, tags: [], supplierName: null, costCents: null, priceCents: 1800,
    stock: 10, reorderLevel: null, shelfNumber: null, expiryDate: null, batchNumber: null,
    imageUrl: null, isListedOnline: false, createdAt: '', updatedAt: '', ...overrides,
  };
}

function makePromotion(overrides: Partial<Promotion> = {}): Promotion {
  return {
    id: 'promo1', shopId: 's1', locationId: null, name: 'Eid weekend',
    discountType: 'percentage', discountValue: 20, scope: 'store', scopeValue: null,
    active: true, startsAt: null, endsAt: null, autoApply: true, archivedAt: null,
    createdAt: '', ...overrides,
  };
}

describe('isPromotionLive', () => {
  it('is live with no window at all', () => {
    expect(isPromotionLive(makePromotion(), AUG_14)).toBe(true);
  });

  it('is not live before its start', () => {
    const promo = makePromotion({ startsAt: '2026-08-18T08:00:00Z' });
    expect(isPromotionLive(promo, AUG_14)).toBe(false);
  });

  it('is live once the start has passed', () => {
    const promo = makePromotion({ startsAt: '2026-08-13T08:00:00Z' });
    expect(isPromotionLive(promo, AUG_14)).toBe(true);
  });

  it('is not live after its end', () => {
    const promo = makePromotion({ endsAt: '2026-08-10T21:00:00Z' });
    expect(isPromotionLive(promo, AUG_14)).toBe(false);
  });

  it('is live inside a closed window', () => {
    const promo = makePromotion({ startsAt: '2026-08-13T08:00:00Z', endsAt: '2026-08-16T21:00:00Z' });
    expect(isPromotionLive(promo, AUG_14)).toBe(true);
  });

  it('treats the end instant as over', () => {
    const promo = makePromotion({ endsAt: '2026-08-14T10:00:00Z' });
    expect(isPromotionLive(promo, AUG_14)).toBe(false);
  });

  it('is not live when inactive, however open the window', () => {
    const promo = makePromotion({ active: false });
    expect(isPromotionLive(promo, AUG_14)).toBe(false);
  });

  it('is not live when archived', () => {
    const promo = makePromotion({ archivedAt: '2026-09-01T00:00:00Z' });
    expect(isPromotionLive(promo, AUG_14)).toBe(false);
  });
});

describe('bestPromotionForProduct', () => {
  it('ignores a promotion outside its window', () => {
    const promo = makePromotion({ endsAt: '2026-08-10T21:00:00Z' });
    expect(bestPromotionForProduct(makeProduct(), [promo], 1800, AUG_14)).toBeNull();
  });

  it('ignores a promotion that never applies by itself', () => {
    const promo = makePromotion({ autoApply: false });
    expect(bestPromotionForProduct(makeProduct(), [promo], 1800, AUG_14)).toBeNull();
  });

  it('picks the live one over an expired better offer', () => {
    const expired = makePromotion({ id: 'expired', discountValue: 50, endsAt: '2026-08-10T21:00:00Z' });
    const live = makePromotion({ id: 'live', discountValue: 20 });
    expect(bestPromotionForProduct(makeProduct(), [expired, live], 1800, AUG_14)?.id).toBe('live');
  });

  it('still picks the largest discount among live offers', () => {
    const small = makePromotion({ id: 'small', discountValue: 10 });
    const big = makePromotion({ id: 'big', discountValue: 30 });
    expect(bestPromotionForProduct(makeProduct(), [small, big], 1800, AUG_14)?.id).toBe('big');
  });

  it('defaults to the current time when none is given', () => {
    const promo = makePromotion({ endsAt: '2020-01-01T00:00:00Z' });
    expect(bestPromotionForProduct(makeProduct(), [promo], 1800)).toBeNull();
  });
});

describe('lineDiscountCents', () => {
  it('takes nothing off when the only promotion has expired', () => {
    const line: CartLine = { product: makeProduct({ priceCents: 1800 }), quantity: 1 };
    const promo = makePromotion({ endsAt: '2026-08-10T21:00:00Z' });
    expect(lineDiscountCents(line, [promo], AUG_14)).toBe(0);
  });

  it('applies a live promotion to the line gross', () => {
    const line: CartLine = { product: makeProduct({ priceCents: 1800 }), quantity: 2 };
    expect(lineDiscountCents(line, [makePromotion()], AUG_14)).toBe(720);
  });

  it('lets a manual discount win over a live promotion', () => {
    const line: CartLine = {
      product: makeProduct({ priceCents: 1800 }), quantity: 1,
      manualDiscount: { type: 'fixed', value: 500 },
    };
    expect(lineDiscountCents(line, [makePromotion()], AUG_14)).toBe(500);
  });
});

describe('discountAmountCents', () => {
  it('never returns more than the base', () => {
    expect(discountAmountCents(1000, { type: 'fixed', value: 5000 })).toBe(1000);
  });
});
```

- [ ] **Step 3: Run the tests and watch them fail**

Run: `npx jest src/lib/__tests__/discounts.test.ts`
Expected: FAIL — `isPromotionLive is not a function`, and type errors on the unknown `Promotion` fields if the Step 1 edit was skipped.

- [ ] **Step 4: Implement the window in `src/lib/discounts.ts`**

Add `isPromotionLive` above `bestPromotionForProduct`, and thread a defaulted `now` through the four functions that need it. Replace the `bestPromotionForProduct` block and the three functions below it with:

```ts
// The one place "is this offer running right now" is decided. Everything that
// applies a discount goes through here, so the product tile badge, the cart
// line and the total can never disagree about whether an offer is live.
//
// Three separate ideas, deliberately not collapsed: `active` is the owner's
// hard off switch, the window is scheduling, and `archivedAt` is "kept only so
// old sales still read". A promotion has to clear all three.
export function isPromotionLive(promo: Promotion, now: number = Date.now()): boolean {
  if (!promo.active || promo.archivedAt) return false;
  if (promo.startsAt && Date.parse(promo.startsAt) > now) return false;
  // The end instant is the moment it stops, not the last moment it runs — an
  // offer "until 21:00" must not still apply at 21:00.
  if (promo.endsAt && Date.parse(promo.endsAt) <= now) return false;
  return true;
}

// Among all promotions matching a product's brand/category (or a store-wide
// one), picks whichever yields the single largest discount for this line — no
// stacking, and no scope-precedence rules to reason about, just "best deal
// wins". Returns null if nothing matches.
//
// `autoApply === false` is excluded here on purpose: those offers exist only
// to be chosen by a cashier, and firing by themselves is exactly what they are
// defined not to do.
export function bestPromotionForProduct(
  product: Product,
  promotions: Promotion[],
  lineGrossCents: number,
  now: number = Date.now()
): Promotion | null {
  const matching = promotions.filter((p) => {
    if (!isPromotionLive(p, now)) return false;
    if (!p.autoApply) return false;
    if (p.scope === 'store') return true;
    if (p.scope === 'brand') return Boolean(product.brand) && product.brand === p.scopeValue;
    if (p.scope === 'category') return Boolean(product.category) && product.category === p.scopeValue;
    return false;
  });
  if (matching.length === 0) return null;

  let best: Promotion | null = null;
  let bestCents = -1;
  for (const promo of matching) {
    const cents = discountAmountCents(lineGrossCents, { type: promo.discountType, value: promo.discountValue });
    if (cents > bestCents) {
      best = promo;
      bestCents = cents;
    }
  }
  return best;
}

export function lineGrossCents(line: CartLine): number {
  return line.product.priceCents * line.quantity;
}

// A manual discount entered directly on the cart line always wins over an
// auto-applied promotion for that same line — cashier discretion overrides
// a standing store-wide/brand/category sale.
export function lineDiscountCents(line: CartLine, promotions: Promotion[], now: number = Date.now()): number {
  const gross = lineGrossCents(line);
  if (line.manualDiscount) return discountAmountCents(gross, line.manualDiscount);
  const promo = bestPromotionForProduct(line.product, promotions, gross, now);
  return promo ? discountAmountCents(gross, { type: promo.discountType, value: promo.discountValue }) : 0;
}

export function appliedPromotionForLine(line: CartLine, promotions: Promotion[], now: number = Date.now()): Promotion | null {
  if (line.manualDiscount) return null;
  return bestPromotionForProduct(line.product, promotions, lineGrossCents(line), now);
}

export function lineNetCents(line: CartLine, promotions: Promotion[], now: number = Date.now()): number {
  return lineGrossCents(line) - lineDiscountCents(line, promotions, now);
}

// Sum of each line's net (post-line-discount) total — this is the subtotal
// a transaction-level discount then applies on top of.
export function cartSubtotalCents(lines: CartLine[], promotions: Promotion[], now: number = Date.now()): number {
  return lines.reduce((sum, line) => sum + lineNetCents(line, promotions, now), 0);
}

export function cartLineDiscountTotalCents(lines: CartLine[], promotions: Promotion[], now: number = Date.now()): number {
  return lines.reduce((sum, line) => sum + lineDiscountCents(line, promotions, now), 0);
}
```

- [ ] **Step 5: Run the tests and watch them pass**

Run: `npx jest src/lib/__tests__/discounts.test.ts`
Expected: PASS — 17 tests.

- [ ] **Step 6: Make the mapper produce the four new fields**

Widening the type without widening the mapper would leave the tree failing `tsc` until Task 2. Every commit in this plan must typecheck, so the mapper moves here.

In `src/lib/promotions.ts`, add these four lines to the object `mapPromotionRow` returns, between `active` and `createdAt`:

```ts
    startsAt: row.starts_at ?? null,
    endsAt: row.ends_at ?? null,
    autoApply: row.auto_apply ?? true,
    archivedAt: row.archived_at ?? null,
```

The columns do not exist in the database until Task 2, so `row.starts_at` is `undefined` and each fallback supplies today's behaviour: no window, auto-applying, not archived. That is correct both before and after the migration lands, which is why this is safe to do first.

- [ ] **Step 7: Confirm nothing else broke**

Run: `npx tsc --noEmit`
Expected: **no errors at all.** No POS component needed touching — the defaulted `now` is what guarantees that.

Run: `npm test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/types/models.ts src/lib/discounts.ts src/lib/promotions.ts src/lib/__tests__/discounts.test.ts
git commit -m "feat(promotions): an offer knows when it runs, and when it never runs alone"
```

---

### Task 2: The columns, and the client that reads them

**Files:**
- Create: `supabase/migrations/20260826000000_promotion_window_and_archive.sql`
- Modify: `src/lib/promotions.ts`

**Interfaces:**
- Consumes: the `Promotion` type from Task 1.
- Produces:
  - `listPromotions(shopId: string): Promise<Promotion[]>` — unchanged signature, now excludes archived rows
  - `NewPromotionInput` gains `startsAt: string | null`, `endsAt: string | null`, `autoApply: boolean`
  - `archivePromotion(id: string): Promise<void>`
  - `deletePromotion(id: string): Promise<void>` — unchanged signature, archives instead when the promotion has been used

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/20260826000000_promotion_window_and_archive.sql`:

```sql
-- A promotion that runs itself.
--
-- 0013 gave promotions an `active` boolean and nothing else, so every
-- short-term offer -- a weekend, the three days before Eid, a Thursday
-- evening -- was a thing a human switched on and then had to remember to
-- switch off. The forgotten ones ran into the next month.
--
-- Three additions, deliberately three separate ideas:
--   starts_at/ends_at  scheduling. Null start = already running, null end =
--                      until someone switches it off (the current behaviour,
--                      still right for a standing loyalty discount).
--   auto_apply         false means the offer never fires by itself and only
--                      reaches a sale when a cashier picks it.
--   archived_at        gone from every list, kept only so old sales still
--                      read. NOT the same as active = false (paused, may come
--                      back) and NOT the same as an ended window (this run is
--                      over).
--
-- Every default preserves what existing rows already do.
alter table public.promotions
  add column starts_at   timestamptz,
  add column ends_at     timestamptz,
  add column auto_apply  boolean not null default true,
  add column archived_at timestamptz;

-- A window that closes before it opens would apply to nothing while reading
-- as scheduled, which is worse than being refused.
alter table public.promotions
  add constraint promotions_window_ordered
    check (starts_at is null or ends_at is null or ends_at > starts_at);

-- The POS filters on this on every cart line.
create index promotions_shop_live_idx
  on public.promotions (shop_id, active, archived_at, ends_at);
```

- [ ] **Step 2: Apply it and verify**

Run: `npx supabase db push`
Expected: the migration applies with no error.

Create `supabase/tests/verify-promotions.sql` (matching the existing `verify-*.sql` convention — these are read and run by hand, not by CI):

```sql
-- Verification for 20260826000000 and 20260826000100. Run against a database
-- with at least one shop and one completed sale. Each block prints PASS/FAIL.

-- 1. The window constraint refuses a backwards window.
do $$
begin
  begin
    insert into public.promotions (shop_id, name, discount_type, discount_value, scope, starts_at, ends_at)
    values ((select id from public.shops limit 1), 'backwards', 'percentage', 10, 'store',
            '2026-09-01T00:00:00Z', '2026-08-01T00:00:00Z');
    raise notice 'FAIL: a backwards window was accepted';
  exception when check_violation then
    raise notice 'PASS: backwards window refused';
  end;
end $$;

-- 2. Existing rows are untouched: everything auto-applies, nothing is windowed.
select case when count(*) = 0 then 'PASS: no pre-existing row was windowed or archived'
            else 'FAIL: ' || count(*) || ' pre-existing rows changed' end
from public.promotions
where auto_apply is not true or starts_at is not null or ends_at is not null or archived_at is not null;

-- 3. A sale item keeps its promotion name after the promotion is deleted.
--    (Run after 20260826000100. Substitute a real sale_item id.)
select 'Check by hand: delete a used promotion, then confirm '
       'select promotion_id, promotion_name from sale_items where id = ... '
       'shows a null id and an intact name.' as note;
```

Run the file against the database and read the notices:
`npx supabase db execute --file supabase/tests/verify-promotions.sql` (or paste it into the SQL editor).
Expected: `PASS` on blocks 1 and 2.

- [ ] **Step 3: Teach the client the new columns**

`mapPromotionRow` already emits the four fields — Task 1 did that so the tree kept typechecking. This step adds the rest.

Replace `listPromotions` and the input type in `src/lib/promotions.ts`:

```ts
// Archived promotions are excluded here rather than filtered by each caller:
// an archived offer exists only so a past receipt still reads, and every
// screen that lists promotions wants it gone.
export async function listPromotions(shopId: string): Promise<Promotion[]> {
  const { data, error } = await supabase
    .from('promotions')
    .select('*')
    .eq('shop_id', shopId)
    .is('archived_at', null)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data ?? []).map(mapPromotionRow);
}

export type NewPromotionInput = {
  name: string;
  discountType: 'percentage' | 'fixed';
  discountValue: number;
  scope: 'store' | 'brand' | 'category';
  scopeValue: string | null;
  active: boolean;
  startsAt: string | null;
  endsAt: string | null;
  autoApply: boolean;
};
```

In `createPromotion`, add to the `.insert({...})` object:

```ts
      starts_at: input.startsAt,
      ends_at: input.endsAt,
      auto_apply: input.autoApply,
```

In `updatePromotion`, add to the `.update({...})` object:

```ts
      ...(input.startsAt !== undefined && { starts_at: input.startsAt }),
      ...(input.endsAt !== undefined && { ends_at: input.endsAt }),
      ...(input.autoApply !== undefined && { auto_apply: input.autoApply }),
```

- [ ] **Step 4: Replace delete with archive-if-used**

Replace `deletePromotion` in `src/lib/promotions.ts` with:

```ts
export async function archivePromotion(id: string): Promise<void> {
  const { error } = await supabase
    .from('promotions')
    .update({ archived_at: new Date().toISOString() })
    .eq('id', id);
  if (error) throw error;
}

// Removing a promotion means two different things depending on whether money
// has moved through it. Hard-deleting one that has been applied would blank
// the attribution on every sale that used it; refusing to remove it would tell
// an owner "you cannot delete this, it was used 400 times", which is not an
// answer either. So: delete if untouched, archive if used. The two look
// identical from the screen — the promotion is gone from the list either way.
export async function deletePromotion(id: string): Promise<void> {
  const { count, error: countError } = await supabase
    .from('sale_items')
    .select('id', { count: 'exact', head: true })
    .eq('promotion_id', id);
  if (countError) throw countError;

  if ((count ?? 0) > 0) {
    await archivePromotion(id);
    return;
  }

  const { error } = await supabase.from('promotions').delete().eq('id', id);
  if (error) throw error;
}
```

Note: this reads `sale_items.promotion_id`, which Task 3 creates. Land Task 3 before exercising delete against a real database.

- [ ] **Step 5: Keep the existing editor compiling**

The three new `NewPromotionInput` fields are required, so `PromotionsModal` in `src/components/settings/panels/sales-panel.tsx` stops compiling the moment the type widens. Task 5 replaces this component wholesale with the real controls; this step only keeps the tree green in between.

Find the object literal the modal's save handler builds and passes to `createPromotion` / `updatePromotion` (around line 144, `const input = {...}`) and add:

```ts
  startsAt: null,
  endsAt: null,
  autoApply: true,
```

Do **not** build date pickers or a toggle here — this component is being deleted in Task 5, and any UI added now is work thrown away. Three literals matching today's behaviour is the whole change.

- [ ] **Step 6: Verify the types line up**

Run: `npx tsc --noEmit`
Expected: no errors.

Run: `npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add supabase/migrations/20260826000000_promotion_window_and_archive.sql supabase/tests/verify-promotions.sql src/lib/promotions.ts src/components/settings/panels/sales-panel.tsx
git commit -m "feat(promotions): a window, a manual-only flag, and an archive that keeps old receipts honest"
```

---

### Task 3: The sale remembers which offer it was

**Files:**
- Create: `supabase/migrations/20260826000100_sale_promotion_attribution.sql`
- Modify: `src/lib/cart.ts`
- Test: `src/lib/__tests__/cart.test.ts`

**Interfaces:**
- Consumes: `appliedPromotionForLine()` from Task 1.
- Produces: `buildSalePayload(lines, promotions?, now?)` returns
  `{ product_id: string; quantity: number; discount_cents: number; promotion_id: string | null; promotion_name: string | null }[]`

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/20260826000100_sale_promotion_attribution.sql`. Where it says *reproduce the current body*, copy the stated line range **verbatim** and make only the listed edit — see the Global Constraints on `CREATE OR REPLACE FUNCTION`.

```sql
-- Which offer took the money off.
--
-- 0013 gave sale_items a discount_cents and stopped there, so the till could
-- say "20% came off" and never "which promotion did it". Every question about
-- whether a sale worked was unanswerable.
--
-- The name is stored beside the id for the same reason product_name sits
-- beside product_id in this table: expiring, renaming, archiving and deleting
-- are four different things an owner does to an old offer, and none of them
-- may touch a sale that already happened. `on delete set null` is the last
-- resort -- the link goes, the name and the money stay.
alter table public.sale_items
  add column promotion_id   uuid references public.promotions(id) on delete set null,
  add column promotion_name text;

create index sale_items_promotion_id_idx on public.sale_items (promotion_id)
  where promotion_id is not null;

-- ── complete_sale ────────────────────────────────────────────────────────
-- Reproduce supabase/migrations/20260822000000_registers_and_sessions.sql
-- lines 734-1010 VERBATIM, with exactly two edits:
--
--   1. In the `insert into public.sale_items (...)` statement, add
--      `promotion_id, promotion_name` to the column list and
--      `nullif(v_item->>'promotion_id','')::uuid,
--       nullif(v_item->>'promotion_name','')` to the values list.
--
--   2. Immediately after the existing
--      `v_line_discount := greatest(coalesce((v_item->>'discount_cents')::integer, 0), 0);`
--      insert the manual-discount guard below.
--
-- The signature does NOT change: attribution rides inside the existing
-- p_items jsonb, so there is no new overload and no new grant.
--
--   -- A line discount with no promotion behind it is a cashier typing a
--   -- number, which is the one discount path nothing has ever recorded or
--   -- restricted. Anyone may APPLY an offer; entering your own amount is a
--   -- separate permission.
--   if v_line_discount > 0
--      and nullif(v_item->>'promotion_id','') is null
--      and not public.has_shop_permission(p_shop_id, 'discounts.manual') then
--     raise exception 'not authorized to enter a manual discount';
--   end if;
--
-- And the same guard for the transaction-level discount, immediately after
-- `v_discount_cents := greatest(coalesce(p_discount_cents, 0), 0);`:
--
--   if v_discount_cents > 0
--      and not public.has_shop_permission(p_shop_id, 'discounts.manual') then
--     raise exception 'not authorized to enter a manual discount';
--   end if;

-- ── edit_sale ────────────────────────────────────────────────────────────
-- Reproduce supabase/migrations/20260820000100_loyalty_balance_rules.sql
-- lines 405-660 VERBATIM, with the same two edits, plus one more:
--
--   3. The v_snapshot jsonb_build_object for 'items' gains
--      'promotion_id', si.promotion_id, 'promotion_name', si.promotion_name
--      so editing a sale does not silently drop which offer applied.
--
-- edit_sale resolves the shop as v_shop_id rather than p_shop_id — use
-- v_shop_id in both permission checks there.

-- ── delete-or-archive has to be decided in here, not in the client ────────
-- Task 2 put this decision in deletePromotion(), which counts sale_items from
-- the browser. That count is subject to RLS: reading sale_items needs
-- sales.view or dashboard.view (0024), while reaching the promotions editor at
-- all needs only settings.access, and IMPLIED_PERMISSIONS joins neither to the
-- other. So the role most likely to be managing promotions sees a count of
-- zero for a promotion that HAS been used, and hard-deletes it -- silently
-- doing the exact thing the archive branch exists to prevent.
--
-- Security definer moves the count somewhere RLS cannot lie to it, and doing
-- both steps in one statement closes the window where a sale lands between the
-- count and the delete.
create or replace function public.delete_or_archive_promotion(p_id uuid)
returns text
language plpgsql security definer set search_path = public as $$
declare
  v_shop_id uuid;
  v_used boolean;
begin
  select shop_id into v_shop_id from public.promotions where id = p_id;
  if v_shop_id is null then
    raise exception 'promotion % not found', p_id;
  end if;
  -- The same gate the table's own write policy uses (0024). Security definer
  -- bypasses RLS, so this function must re-assert what RLS would have.
  if not public.has_shop_permission(v_shop_id, 'settings.access') then
    raise exception 'not authorized for shop %', v_shop_id;
  end if;

  select exists (select 1 from public.sale_items where promotion_id = p_id) into v_used;

  if v_used then
    update public.promotions set archived_at = now() where id = p_id;
    return 'archived';
  end if;

  delete from public.promotions where id = p_id;
  return 'deleted';
end;
$$;

grant execute on function public.delete_or_archive_promotion(uuid) to authenticated;

-- ── grant the new permission to every role that can already discount ──────
-- Nothing a shop currently does may stop working. Every role holding
-- pos.access is granted discounts.manual, which is exactly the set of people
-- who can reach the discount editor today. An owner narrows it deliberately
-- from Settings after this lands.
update public.roles
   set permissions = array_append(permissions, 'discounts.manual')
 where 'pos.access' = any(permissions)
   and not ('discounts.manual' = any(permissions));

update public.roles
   set permissions = array_append(permissions, 'discounts.apply')
 where 'pos.access' = any(permissions)
   and not ('discounts.apply' = any(permissions));
```

- [ ] **Step 2: Apply and verify the guard**

Run: `npx supabase db push`
Expected: applies clean.

Verify by hand against the database:

```sql
-- Every role that can ring up a sale can still discount one.
select case when count(*) = 0 then 'PASS: no discounting role lost the ability'
            else 'FAIL: ' || count(*) || ' roles have pos.access without discounts.manual' end
from public.roles
where 'pos.access' = any(permissions) and not ('discounts.manual' = any(permissions));
```

Expected: `PASS`.

- [ ] **Step 2b: Move `deletePromotion` onto the new RPC**

Task 2's client-side count is the bug the RPC above exists to fix. Replace `deletePromotion` in `src/lib/promotions.ts` with:

```ts
// Removing a promotion means two different things depending on whether money
// has moved through it: destroy the untouched ones, archive the used ones so
// past sales keep their link. Both the count and the branch live in the
// database, because reading sale_items from here is subject to RLS — a role
// holding settings.access but not sales.view sees no rows, and would hard
// -delete a promotion that had been used on four hundred sales.
export async function deletePromotion(id: string): Promise<'deleted' | 'archived'> {
  const { data, error } = await supabase.rpc('delete_or_archive_promotion', { p_id: id });
  if (error) throw error;
  return data as 'deleted' | 'archived';
}
```

`archivePromotion` stays as Task 2 wrote it — archiving on purpose is a different action from removing, and the editor offers both.

The return type widens from `Promise<void>` to `Promise<'deleted' | 'archived'>`. Check every caller with `grep -rn "deletePromotion" src/` and confirm each still compiles; a caller that ignores the return value needs no change.

- [ ] **Step 3: Write the failing cart tests**

Add to `src/lib/__tests__/cart.test.ts`, and add `Promotion` to its type import:

```ts
function makePromotion(overrides: Partial<Promotion> = {}): Promotion {
  return {
    id: 'promo1', shopId: 's1', locationId: null, name: 'Eid weekend',
    discountType: 'percentage', discountValue: 20, scope: 'store', scopeValue: null,
    active: true, startsAt: null, endsAt: null, autoApply: true, archivedAt: null,
    createdAt: '', ...overrides,
  };
}

describe('buildSalePayload attribution', () => {
  it('names the promotion that produced the discount', () => {
    const lines: CartLine[] = [{ product: makeProduct({ id: 'p1', priceCents: 1800 }), quantity: 1 }];
    expect(buildSalePayload(lines, [makePromotion()])).toEqual([
      { product_id: 'p1', quantity: 1, discount_cents: 360, promotion_id: 'promo1', promotion_name: 'Eid weekend' },
    ]);
  });

  it('sends nulls when no promotion applied', () => {
    const lines: CartLine[] = [{ product: makeProduct({ id: 'p1' }), quantity: 1 }];
    expect(buildSalePayload(lines)).toEqual([
      { product_id: 'p1', quantity: 1, discount_cents: 0, promotion_id: null, promotion_name: null },
    ]);
  });

  it('sends nulls for a manual discount, which has no promotion behind it', () => {
    const lines: CartLine[] = [{
      product: makeProduct({ id: 'p1', priceCents: 1000 }), quantity: 2,
      manualDiscount: { type: 'fixed', value: 300 },
    }];
    expect(buildSalePayload(lines, [makePromotion()])).toEqual([
      { product_id: 'p1', quantity: 2, discount_cents: 300, promotion_id: null, promotion_name: null },
    ]);
  });

  it('sends nulls when the only promotion has expired', () => {
    const lines: CartLine[] = [{ product: makeProduct({ id: 'p1', priceCents: 1800 }), quantity: 1 }];
    const expired = makePromotion({ endsAt: '2020-01-01T00:00:00Z' });
    expect(buildSalePayload(lines, [expired])).toEqual([
      { product_id: 'p1', quantity: 1, discount_cents: 0, promotion_id: null, promotion_name: null },
    ]);
  });
});
```

- [ ] **Step 4: Run and watch them fail**

Run: `npx jest src/lib/__tests__/cart.test.ts`
Expected: FAIL — the returned objects have no `promotion_id` / `promotion_name` keys.

- [ ] **Step 5: Carry the attribution in the payload**

Replace `buildSalePayload` in `src/lib/cart.ts`:

```ts
import { appliedPromotionForLine, lineDiscountCents } from '@/lib/discounts';
import type { CartLine, Promotion } from '@/types/models';

// `promotions` defaults to none so existing callers (and the test suite)
// that don't care about discounts keep getting a plain product_id/quantity
// payload with discount_cents simply 0 on every line.
//
// The name travels beside the id because the sale has to keep reading
// correctly after the promotion is renamed, archived or deleted — the same
// reason sale_items already stores product_name beside product_id.
export function buildSalePayload(
  lines: CartLine[],
  promotions: Promotion[] = [],
  now: number = Date.now()
): {
  product_id: string;
  quantity: number;
  discount_cents: number;
  promotion_id: string | null;
  promotion_name: string | null;
}[] {
  return lines.map((line) => {
    const promo = appliedPromotionForLine(line, promotions, now);
    return {
      product_id: line.product.id,
      quantity: line.quantity,
      discount_cents: lineDiscountCents(line, promotions, now),
      promotion_id: promo?.id ?? null,
      promotion_name: promo?.name ?? null,
    };
  });
}
```

- [ ] **Step 6: Run the tests and watch them pass**

Run: `npx jest src/lib/__tests__/cart.test.ts`
Expected: PASS.

Run: `npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add supabase/migrations/20260826000100_sale_promotion_attribution.sql src/lib/cart.ts src/lib/__tests__/cart.test.ts
git commit -m "feat(sales): a discount remembers the offer that made it"
```

---

### Task 4: The discount permission the app never had

**Files:**
- Modify: `src/lib/permissions.ts`
- Modify: `src/lib/permission-groups.ts`
- Modify: `src/components/discount-editor.tsx`
- Test: `src/lib/__tests__/permissions.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `'discounts.apply'` and `'discounts.manual'` as `Permission` values.

`discounts.apply` gates the offer picker built in Phase 4 and has nothing to gate yet. It is defined now so the catalog changes once rather than twice.

- [ ] **Step 1: Write the failing test**

Add to `src/lib/__tests__/permissions.test.ts`:

```ts
describe('discount permissions', () => {
  it('offers both discount capabilities in the catalog', () => {
    expect(ALL_PERMISSIONS).toContain('discounts.apply');
    expect(ALL_PERMISSIONS).toContain('discounts.manual');
  });

  it('describes them as separate capabilities', () => {
    const keys = PERMISSIONS.map((p) => p.key);
    expect(keys.filter((k) => k.startsWith('discounts.'))).toHaveLength(2);
  });

  it('does not imply one from the other — choosing an offer is not inventing a number', () => {
    expect(expandPermissions(['discounts.apply'])).toEqual(['discounts.apply']);
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `npx jest src/lib/__tests__/permissions.test.ts`
Expected: FAIL — `ALL_PERMISSIONS` does not contain `discounts.apply`.

- [ ] **Step 3: Add both to the catalog**

In `src/lib/permissions.ts`, add to the `Permission` union after `'sales.refund'`:

```ts
  | 'discounts.apply'
  | 'discounts.manual'
```

And to the `PERMISSIONS` array, immediately after the `sales.refund` entry:

```ts
  { key: 'discounts.apply', label: 'Apply an offer', description: "Put one of the shop's own offers on a sale. The amount is the offer's, not the cashier's." },
  { key: 'discounts.manual', label: 'Enter a discount', description: 'Type any amount off a line or a whole sale. Independent of applying an offer — this is the one with no ceiling.' },
```

- [ ] **Step 4: Run and watch it pass**

Run: `npx jest src/lib/__tests__/permissions.test.ts`
Expected: PASS.

- [ ] **Step 5: Put them in a permission group**

`PERMISSION_GROUPS` in `src/lib/permission-groups.ts` is what the role editor renders. Both keys belong to the **POS** group at line 11 — this is a thing that happens at the till, not an accounting capability — so replace that line with:

```ts
  { label: 'POS', permissions: ['pos.access', 'registers.manage', 'discounts.apply', 'discounts.manual'] },
```

Run: `npx tsc --noEmit`
Expected: no errors.

Run: `npm test`
Expected: PASS. If a test asserts every `Permission` appears in exactly one group, this is the step that satisfies it.

- [ ] **Step 6: Gate the free-form editor**

In `src/components/discount-editor.tsx`, take `can` from the auth hook (see `src/hooks/use-shop-logo.ts:21` for the established call shape) and return null when the permission is absent:

```tsx
import { useAuth } from '@/hooks/use-auth';

// The one discount path with no ceiling and no record of why. A cashier
// without this may still apply the shop's own offers — they just cannot
// invent an amount. Rendering nothing rather than a disabled control: an
// affordance that refuses is worse than no affordance.
const { can } = useAuth();
if (!can('discounts.manual')) return null;
```

Place it as the first statement in the component body, before any other hook call is skipped — if the component already calls hooks, put the guard after every `use*` call so the hook order stays stable across renders.

- [ ] **Step 7: Verify on device**

The permission gate crosses into the running app and cannot be verified by reading code.

Run the app, open the POS, and confirm with a role holding `discounts.manual` that the discount control is present; remove the permission from that role in Settings, reload, and confirm it is gone and that the till still rings up a sale with an auto-applied promotion.

Use the project's `/testing-kaiibi` skill for the platform sweep.

- [ ] **Step 8: Commit**

```bash
git add src/lib/permissions.ts src/lib/permission-groups.ts src/lib/__tests__/permissions.test.ts src/components/discount-editor.tsx
git commit -m "feat(permissions): applying an offer and inventing a number stop being the same thing"
```

---

### Task 5: A Marketing tab, holding the promotions editor

**Files:**
- Create: `src/components/marketing/promotions-tab.tsx`
- Modify: `src/app/(admin)/(tabs)/people.tsx:77-196`
- Modify: `src/components/settings/panels/sales-panel.tsx`
- Modify: `src/app/(admin)/settings.tsx:272-277`

**Interfaces:**
- Consumes: `listPromotions`, `createPromotion`, `updatePromotion`, `deletePromotion`, `archivePromotion` from Task 2; `NewPromotionInput`'s three new fields.
- Produces: `<PromotionsTab compact setHeaderActions setDetailSelected />`, matching the prop shape the existing People tabs use.

- [ ] **Step 1: Move the editor into its own component**

Create `src/components/marketing/promotions-tab.tsx` with this signature — it matches `CustomersTab` at `src/app/(admin)/(tabs)/people.tsx:203`, which you should read first and follow for the list layout, the stat strip and the `setHeaderActions` publish:

```tsx
export function PromotionsTab({
  compact,
  setHeaderActions,
  setDetailSelected,
}: {
  compact: boolean;
  setHeaderActions: (node: React.ReactNode) => void;
  setDetailSelected: (selected: boolean) => void;
}) {
```

Move the form and list bodies out of `PromotionsModal` in `src/components/settings/panels/sales-panel.tsx` (the modal starts at line 75). A promotion list is read down a column, so it stays out of any grid. People is still cream: use `background` / `surface` / `border`, not the bento tokens.

The form gains three controls beyond what it has today. Hold them in the same `useState` shape the existing form uses, and pass them straight through to `createPromotion` / `updatePromotion`:

```tsx
const [startsAt, setStartsAt] = useState<string | null>(null);
const [endsAt, setEndsAt] = useState<string | null>(null);
const [autoApply, setAutoApply] = useState(true);
```

Rendered as:

```tsx
{/* Both ends optional, and each empty state says what it means rather than
    leaving a blank field to guess at. */}
<DateInput label="Starts" value={startsAt} onChange={setStartsAt} placeholder="Running now" />
<DateInput label="Ends" value={endsAt} onChange={setEndsAt} placeholder="Until I switch it off" />

<Pressable
  accessibilityRole="switch"
  accessibilityState={{ checked: autoApply }}
  onPress={() => setAutoApply((on) => !on)}
  style={styles.toggleRow}
>
  <View style={styles.toggleLabel}>
    <Text style={styles.toggleTitle}>Apply automatically</Text>
    <Text style={styles.toggleHint}>
      {autoApply ? 'Comes off every matching sale on its own.' : 'Only when a cashier picks it.'}
    </Text>
  </View>
  <Switch value={autoApply} onValueChange={setAutoApply} />
</Pressable>
```

`startEdit(promo)` must seed all three from the row (`promo.startsAt`, `promo.endsAt`, `promo.autoApply`), and the save handler must include them in the `NewPromotionInput` it builds — the three fields Task 2 added are required, so TypeScript will fail the build if any is forgotten.

Check `src/components/date-input.tsx` for `DateInput`'s actual prop names before wiring it and use whatever it exports; the names above are illustrative of intent, not a guarantee about that component's API.

- [ ] **Step 2: Add the tab to People**

In `src/app/(admin)/(tabs)/people.tsx`:

```ts
type PeopleTab = 'customers' | 'team' | 'schedule' | 'marketing' | 'me';
```

Add to `TAB_BLURBS`:

```ts
  marketing: {
    label: 'Marketing',
    blurb: 'Set up the offers that come off at the till, and say when they run.',
  },
```

Gate it beside the existing `canSee*` flags at lines 120–123. Both checks are required — an owner whose plan lacks the module, or a staff member without settings access, must not see a half-working tab:

```ts
  const canSeeMarketing = can('settings.access') && hasModule('promotions');
```

`hasModule` comes from the same auth hook as `can` — see the header comment at `src/hooks/use-auth.tsx:68`, which documents that the two gates are separate and both apply.

Add to `permittedTab` (after line 131), so a `?tab=marketing` deep link resolves only for someone allowed to see it:

```ts
    if (candidate === 'marketing' && canSeeMarketing) return 'marketing';
```

Add to the `options` array (after line 167), before the `me` entry — Marketing sits fourth, matching the mockup:

```ts
    ...(canSeeMarketing ? [{ key: 'marketing' as const, label: TAB_BLURBS.marketing.label }] : []),
```

Render it beside its siblings (after line 194):

```tsx
{tab === 'marketing' && canSeeMarketing ? (
  <PromotionsTab compact={compact} setHeaderActions={setHeaderActions} setDetailSelected={setDetailSelected} />
) : null}
```

Leave the fallback chain at line 138 alone. Marketing must not become anyone's default landing tab — someone who opens People is looking for a person.

- [ ] **Step 3: Leave Settings a signpost**

In `src/components/settings/panels/sales-panel.tsx`, reduce `PromotionsPanel` to a read-only summary: the count, the first few names, and one button that routes to `/(admin)/(tabs)/people?tab=marketing`. Delete the modal that moved. Keep the panel registered in `src/app/(admin)/settings.tsx:272` and in the sidebar — an owner who has looked for promotions in Settings for months must land somewhere that tells them where they went.

- [ ] **Step 4: Verify the move**

Run: `npx tsc --noEmit`
Expected: no errors.

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Verify on device**

Run the app and confirm, with screenshots:

1. People shows a Marketing tab for an owner, and does not for a cashier.
2. Creating a promotion with an end date in the past takes nothing off in the POS cart.
3. Creating one with a start date tomorrow takes nothing off today.
4. Creating one with **Apply automatically** off takes nothing off — it is not pickable until Phase 4, so "nothing happens" is the correct result.
5. A plain promotion with no window still comes off exactly as it did before this plan.
6. Settings → Promotions shows the summary and its button lands on the Marketing tab.

Use the project's `/testing-kaiibi` skill.

- [ ] **Step 6: Commit**

```bash
git add src/components/marketing/ "src/app/(admin)/(tabs)/people.tsx" src/components/settings/panels/sales-panel.tsx "src/app/(admin)/settings.tsx"
git commit -m "feat(marketing): promotions move next to the customers they are for"
```

---

## Definition of done

Phase 1's acceptance criteria from the spec, each verifiable:

- [ ] A promotion with `ends_at` in the past applies to nothing — cart, tile and total (Task 1 tests + Task 5 device check 2).
- [ ] A promotion with `starts_at` in the future reads as Scheduled and applies to nothing (Task 1 tests + Task 5 device check 3).
- [ ] `active = false` beats any window (Task 1 test: *is not live when inactive, however open the window*).
- [ ] A completed sale's `sale_items` rows carry the id and frozen name of whichever promotion applied (Task 3).
- [ ] Deleting a used promotion archives it and the past sale still reads correctly (Task 2 Step 4 + `verify-promotions.sql` block 3).
- [ ] A cashier without `discounts.manual` cannot open the free-form editor, and the DB refuses the write if they somehow do (Task 4 + Task 3's RPC guard).
- [ ] Every role that could discount before this plan still can (Task 3 Step 2).
