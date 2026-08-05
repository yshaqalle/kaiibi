# Uncosted Products Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a shop find every product with no purchase cost, and warn before creating another one.

**Architecture:** Two pure predicates go in a new `src/lib/product-costing.ts` and carry all the logic; the components only render. A promise-returning `confirmChoice` joins the existing `confirmDestructive` in `src/lib/confirm.ts`. Inventory gains a fourth filter chip driven by the existing `StockFilter` union, and the dashboard's existing uncosted caveat gets deep-linked to it.

**Tech Stack:** Expo SDK 57, React Native 0.86, React 19.2, TypeScript 6, Expo Router, Jest via `jest-expo` preset.

**Spec:** `docs/superpowers/specs/2026-08-05-uncosted-products-design.md`

## Global Constraints

- **Branch:** work on `customer-loyalty-points`. Do not create a new branch.
- **Uncosted means `costCents === null`, never `=== 0` and never falsy.** A cost of zero is a real recorded answer (free sample, gift with purchase). Only `null` means unrecorded.
- **No component tests.** This repo has no `@testing-library/*` and no `.tsx` under any `__tests__`. Do not add the tooling — it is explicitly out of scope. Test only `src/lib/` modules. Rendering is verified manually at the end.
- **Test command:** `npm test` (Jest). Lint: `npm run lint`.
- **Tests live in** `src/lib/__tests__/<module>.test.ts`, importing via the `@/` alias.
- **`react-native-web`'s `Alert.alert` is a no-op stub** — it never renders and never fires a button's `onPress`. Any confirm must branch to `window.confirm` on `Platform.OS === 'web'`.
- **Copy is fixed.** Use these strings verbatim:
  - Chip label: `No cost ${count}`
  - Form hint: `No purchase cost means this product won't count toward profit or cost of goods.`
  - Confirm title: `Save without a purchase cost?`
  - Confirm message: `Profit and cost of goods won't include this product.`
  - Confirm button: `Save anyway`
- **Commit after every task.** Do not batch.

---

### Task 1: The two costing predicates

The whole feature's logic, isolated and tested before anything renders it.

**Files:**
- Create: `src/lib/product-costing.ts`
- Create: `src/lib/__tests__/product-costing.test.ts`

**Interfaces:**
- Consumes: `Product` from `@/types/models` (only its `costCents: number | null` field).
- Produces:
  - `isUncosted(product: Pick<Product, 'costCents'>): boolean`
  - `needsCostConfirmation(costInput: string, initialCostCents: number | null | undefined): boolean`

  Task 3 calls `isUncosted`. Task 5 calls `needsCostConfirmation`.

- [ ] **Step 1: Write the failing test**

Create `src/lib/__tests__/product-costing.test.ts`:

```ts
import { isUncosted, needsCostConfirmation } from '@/lib/product-costing';

describe('isUncosted', () => {
  // The distinction the whole feature rests on: a cost of zero is a real
  // answer someone recorded (a free sample, a gift with purchase), not an
  // absent one. Only null means nobody said. `costOfGoodsSold()` in
  // sales-reporting.ts already draws this line the same way.
  it('treats a null cost as uncosted', () => {
    expect(isUncosted({ costCents: null })).toBe(true);
  });

  it('does NOT treat a zero cost as uncosted', () => {
    expect(isUncosted({ costCents: 0 })).toBe(false);
  });

  it('does not treat a positive cost as uncosted', () => {
    expect(isUncosted({ costCents: 1250 })).toBe(false);
  });
});

describe('needsCostConfirmation', () => {
  it('confirms when a NEW product has a blank cost', () => {
    expect(needsCostConfirmation('', undefined)).toBe(true);
  });

  it('confirms when an edit CLEARS a cost that was set', () => {
    expect(needsCostConfirmation('', 1250)).toBe(true);
  });

  // The row that stops this becoming noise. Opening an already-uncosted
  // product to fix a typo in its name is not a decision about cost, and a
  // dialog there teaches people to dismiss the warning unread.
  it('does NOT confirm when an already-uncosted product stays uncosted', () => {
    expect(needsCostConfirmation('', null)).toBe(false);
  });

  it('does not confirm when a cost is present', () => {
    expect(needsCostConfirmation('12.50', null)).toBe(false);
    expect(needsCostConfirmation('12.50', undefined)).toBe(false);
    expect(needsCostConfirmation('12.50', 1250)).toBe(false);
  });

  // The field is a raw text input; whitespace is not a cost.
  it('treats a whitespace-only cost as blank', () => {
    expect(needsCostConfirmation('   ', undefined)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- product-costing`
Expected: FAIL — `Cannot find module '@/lib/product-costing'`

- [ ] **Step 3: Write minimal implementation**

Create `src/lib/product-costing.ts`:

```ts
import type { Product } from '@/types/models';

// A product nobody recorded a purchase cost for.
//
// NULL, not zero and not falsy. Zero is a real answer — a free sample, a gift
// with purchase, a promotional unit — and counting it as missing would send
// people off to "fix" a figure that is already correct. Only null means the
// question went unanswered. `costOfGoodsSold()` in sales-reporting.ts draws
// the same line when it reports items as uncosted rather than as costing zero.
export function isUncosted(product: Pick<Product, 'costCents'>): boolean {
  return product.costCents === null;
}

// Whether saving should stop and ask.
//
// Fires when a cost is BEING left out for the first time: a new product saved
// blank, or an edit that clears a cost which was previously set. It stays
// quiet when an already-uncosted product is saved still-uncosted, because the
// person is there for some other field and has made no decision about cost —
// warning them anyway is how a dialog becomes something people dismiss without
// reading.
//
// `initialCostCents` is undefined for a new product and null for an existing
// one with no cost; the two cases differ and the distinction is load-bearing.
export function needsCostConfirmation(
  costInput: string,
  initialCostCents: number | null | undefined
): boolean {
  if (costInput.trim() !== '') return false;
  return initialCostCents !== null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- product-costing`
Expected: PASS, 7 tests

- [ ] **Step 5: Commit**

```bash
git add src/lib/product-costing.ts src/lib/__tests__/product-costing.test.ts
git commit -m "feat: predicates for uncosted products and cost-confirm trigger"
```

---

### Task 2: `confirmChoice`

A non-destructive confirm. `confirmDestructive` already exists but hardcodes `style: 'destructive'` (red) and is callback-based; saving a product without a cost is recoverable and frequently correct, so it must not be styled as deletion.

**Files:**
- Modify: `src/lib/confirm.ts`
- Create: `src/lib/__tests__/confirm.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `confirmChoice(title: string, message: string, confirmLabel: string): Promise<boolean>` — resolves `true` if confirmed, `false` if cancelled or dismissed. Task 5 awaits it.

- [ ] **Step 1: Write the failing test**

Create `src/lib/__tests__/confirm.test.ts`. Note the mocking approach: `Platform.OS` is a read-only property on the real module, so the module is mocked wholesale and the value swapped per case — the same pattern `device.test.ts` uses for `expo-device`'s `deviceType`.

```ts
import { Alert, Platform } from 'react-native';

import { confirmChoice } from '@/lib/confirm';

type AlertButton = { text?: string; style?: string; onPress?: () => void };

function setPlatform(os: 'web' | 'ios') {
  (Platform as { OS: string }).OS = os;
}

const realOS = Platform.OS;

afterEach(() => {
  setPlatform(realOS as 'web' | 'ios');
  jest.restoreAllMocks();
});

describe('confirmChoice on web', () => {
  // react-native-web's Alert.alert is a no-op stub: it renders nothing and
  // never fires a button's onPress, so a promise waiting on it would hang
  // forever. Web has to go through window.confirm instead.
  it('resolves true when window.confirm accepts', async () => {
    setPlatform('web');
    jest.spyOn(window, 'confirm').mockReturnValue(true);

    await expect(confirmChoice('Title', 'Message', 'Save anyway')).resolves.toBe(true);
  });

  it('resolves false when window.confirm cancels', async () => {
    setPlatform('web');
    jest.spyOn(window, 'confirm').mockReturnValue(false);

    await expect(confirmChoice('Title', 'Message', 'Save anyway')).resolves.toBe(false);
  });

  it('shows the title and message together', async () => {
    setPlatform('web');
    const confirmSpy = jest.spyOn(window, 'confirm').mockReturnValue(true);

    await confirmChoice('Title', 'Message', 'Save anyway');

    expect(confirmSpy).toHaveBeenCalledWith('Title\n\nMessage');
  });
});

describe('confirmChoice on native', () => {
  it('resolves true when the confirm button is pressed', async () => {
    setPlatform('ios');
    jest.spyOn(Alert, 'alert').mockImplementation((_t, _m, buttons) => {
      (buttons as AlertButton[]).find((b) => b.text === 'Save anyway')?.onPress?.();
    });

    await expect(confirmChoice('Title', 'Message', 'Save anyway')).resolves.toBe(true);
  });

  it('resolves false when cancelled', async () => {
    setPlatform('ios');
    jest.spyOn(Alert, 'alert').mockImplementation((_t, _m, buttons) => {
      (buttons as AlertButton[]).find((b) => b.style === 'cancel')?.onPress?.();
    });

    await expect(confirmChoice('Title', 'Message', 'Save anyway')).resolves.toBe(false);
  });

  // Not styled 'destructive': this save is recoverable and often the right
  // answer. Red would overstate it and blunt the styling where it is earned.
  it('does not style the confirm button as destructive', async () => {
    setPlatform('ios');
    let captured: AlertButton[] = [];
    jest.spyOn(Alert, 'alert').mockImplementation((_t, _m, buttons) => {
      captured = buttons as AlertButton[];
      captured.find((b) => b.style === 'cancel')?.onPress?.();
    });

    await confirmChoice('Title', 'Message', 'Save anyway');

    expect(captured.find((b) => b.text === 'Save anyway')?.style).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- confirm`
Expected: FAIL — `confirmChoice is not a function` (the module exists, the export does not)

- [ ] **Step 3: Write minimal implementation**

Append to `src/lib/confirm.ts`, leaving `confirmDestructive` exactly as it is — its callers are fine and red is right for them:

```ts
// A confirm that is NOT a warning about damage.
//
// `confirmDestructive` above styles its button red, which is correct for
// deleting a product and wrong for everything that is merely worth a second
// look. Saving a product with no purchase cost is recoverable and often
// deliberate; dressing it as deletion would overstate it and, repeated, blunt
// the red where it is earned.
//
// Promise-returning rather than callback-taking, so it reads as a step inside
// an async submit() rather than splitting the save across a callback.
export function confirmChoice(title: string, message: string, confirmLabel: string): Promise<boolean> {
  // Same web/native split as confirmDestructive, and for the same reason:
  // react-native-web's Alert.alert is a no-op stub, so a promise waiting on
  // its buttons would never settle.
  if (Platform.OS === 'web') {
    return Promise.resolve(window.confirm(`${title}\n\n${message}`));
  }
  return new Promise((resolve) => {
    Alert.alert(title, message, [
      { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
      { text: confirmLabel, onPress: () => resolve(true) },
    ], {
      // Tapping outside the dialog on Android must settle the promise too,
      // or the save is left hanging with its spinner spinning.
      onDismiss: () => resolve(false),
    });
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- confirm`
Expected: PASS, 6 tests

- [ ] **Step 5: Commit**

```bash
git add src/lib/confirm.ts src/lib/__tests__/confirm.test.ts
git commit -m "feat: confirmChoice, a non-destructive promise-returning confirm"
```

---

### Task 3: The `No cost` chip on Inventory

**Files:**
- Modify: `src/app/(admin)/(tabs)/inventory.tsx`

**Interfaces:**
- Consumes: `isUncosted` from Task 1.
- Produces: the `?filter=nocost` deep-link target that Task 4 links to.

- [ ] **Step 1: Extend the filter union**

At `src/app/(admin)/(tabs)/inventory.tsx:50`, change:

```ts
type StockFilter = 'all' | 'low' | 'expiring';
```

to:

```ts
type StockFilter = 'all' | 'low' | 'expiring' | 'nocost';
```

- [ ] **Step 2: Import the predicate**

Add to the existing import block, keeping the file's alphabetical `@/lib/…` grouping:

```ts
import { isUncosted } from '@/lib/product-costing';
```

- [ ] **Step 3: Accept the new deep-link value**

At `src/app/(admin)/(tabs)/inventory.tsx:89-92`, the param guard currently reads:

```ts
const { filter: filterParam } = useLocalSearchParams<{ filter?: string }>();
const [stockFilter, setStockFilter] = useState<StockFilter>(
  filterParam === 'low' || filterParam === 'expiring' ? filterParam : 'all'
);
```

Change the condition to include the new value:

```ts
const { filter: filterParam } = useLocalSearchParams<{ filter?: string }>();
const [stockFilter, setStockFilter] = useState<StockFilter>(
  filterParam === 'low' || filterParam === 'expiring' || filterParam === 'nocost' ? filterParam : 'all'
);
```

- [ ] **Step 4: Add the filter branch**

In the `filtered` memo at `src/app/(admin)/(tabs)/inventory.tsx:235-240`, the `scoped` chain currently reads:

```ts
const scoped =
  stockFilter === 'low'
    ? products.filter((p) => p.stock <= (p.reorderLevel ?? shop?.defaultLowStockLevel ?? 5))
    : stockFilter === 'expiring'
      ? products.filter((p) => p.expiryDate !== null)
      : products;
```

Add the new branch:

```ts
const scoped =
  stockFilter === 'low'
    ? products.filter((p) => p.stock <= (p.reorderLevel ?? shop?.defaultLowStockLevel ?? 5))
    : stockFilter === 'expiring'
      ? products.filter((p) => p.expiryDate !== null)
      : stockFilter === 'nocost'
        ? products.filter(isUncosted)
        : products;
```

Leave the memo's dependency array unchanged — `stockFilter` is already in it and `isUncosted` is a module-level import, not a value that can change between renders.

- [ ] **Step 5: Count the uncosted products**

At `src/app/(admin)/(tabs)/inventory.tsx:320`, beside the existing `needsAttention`:

```ts
const needsAttention = products.filter((p) => p.stock <= (p.reorderLevel ?? defaultLowStockLevel)).length;
const uncostedCount = products.filter(isUncosted).length;
```

- [ ] **Step 6: Render the chip**

The chip row at `src/app/(admin)/(tabs)/inventory.tsx:378-392` currently reads:

```tsx
<View style={styles.stockFilterRow}>
  {(['all', 'low', 'expiring'] as StockFilter[])
    .filter((key) => key !== 'expiring' || shop?.expiryTrackingEnabled)
    .map((key) => (
      <Pressable
        key={key}
        onPress={() => setStockFilter(key)}
        style={[styles.stockChip, stockFilter === key && styles.stockChipActive]}
      >
        <Text style={[styles.stockChipText, stockFilter === key && styles.stockChipTextActive]}>
          {key === 'all' ? 'All' : key === 'low' ? `Low stock ${needsAttention}` : 'Has expiry'}
        </Text>
      </Pressable>
    ))}
</View>
```

Replace it with the version below. Two changes: `'nocost'` joins the array, and the label expression becomes a lookup because a fourth nested ternary would be unreadable.

```tsx
<View style={styles.stockFilterRow}>
  {(['all', 'low', 'expiring', 'nocost'] as StockFilter[])
    .filter((key) => key !== 'expiring' || shop?.expiryTrackingEnabled)
    .map((key) => (
      <Pressable
        key={key}
        onPress={() => setStockFilter(key)}
        style={[styles.stockChip, stockFilter === key && styles.stockChipActive]}
      >
        <Text style={[styles.stockChipText, stockFilter === key && styles.stockChipTextActive]}>
          {/* Shown with its count even at zero, like Low stock. The comment
              above this row argues a narrowed list that looks unnarrowed is
              worse than no link at all -- a chip that hid itself when the
              count was zero could neither be got out of on a deep link, nor
              report the genuinely useful news that the count IS zero. */}
          {key === 'all'
            ? 'All'
            : key === 'low'
              ? `Low stock ${needsAttention}`
              : key === 'expiring'
                ? 'Has expiry'
                : `No cost ${uncostedCount}`}
        </Text>
      </Pressable>
    ))}
</View>
```

Note the `'nocost'` chip is deliberately NOT behind the `.filter(…)` gate — that gate exists only to hide expiry from shops with expiry tracking off. Every shop has costs.

- [ ] **Step 7: Verify types and lint**

Run: `npx tsc --noEmit`
Expected: no errors. In particular, the `StockFilter` union change must not have produced a non-exhaustive-switch error anywhere else in the file.

Run: `npm run lint`
Expected: no new warnings for `inventory.tsx`.

- [ ] **Step 8: Commit**

```bash
git add src/app/\(admin\)/\(tabs\)/inventory.tsx
git commit -m "feat: No cost filter chip on inventory"
```

---

### Task 4: Point the dashboard caveat at the filter

The reason the chip is worth building. The dashboard already tells a shop its gross profit is overstated and offers "Set costs in Inventory" — which currently lands on the unfiltered list of every product, naming a problem and then hiding it.

**Files:**
- Modify: `src/app/(admin)/(tabs)/dashboard.tsx:379-385`

**Interfaces:**
- Consumes: the `?filter=nocost` route from Task 3. Task 3 must be done first or this link lands on an unfiltered list.
- Produces: nothing.

- [ ] **Step 1: Change the route**

At `src/app/(admin)/(tabs)/dashboard.tsx:382`, the caveat's action currently reads:

```tsx
action={{ label: 'Set costs in Inventory', onPress: () => router.push('/inventory') }}
```

Change it to:

```tsx
action={{ label: 'Set costs in Inventory', onPress: () => router.push('/inventory?filter=nocost') }}
```

Change nothing else in the block — the caveat's tone, text and `uncostedItemCount > 0` guard are all already correct.

- [ ] **Step 2: Verify types**

Run: `npx tsc --noEmit`
Expected: no errors. Expo Router types the `href`, so a typo in the query string surfaces here.

- [ ] **Step 3: Commit**

```bash
git add src/app/\(admin\)/\(tabs\)/dashboard.tsx
git commit -m "feat: dashboard uncosted caveat links to the No cost filter"
```

---

### Task 5: The form hint and the save confirm

**Files:**
- Modify: `src/components/product-form.tsx`

**Interfaces:**
- Consumes: `needsCostConfirmation` (Task 1), `confirmChoice` (Task 2).
- Produces: nothing. This is the last code task.

- [ ] **Step 1: Add the imports**

Add to `src/components/product-form.tsx`, following the file's existing `@/…` import grouping:

```ts
import { Caveat } from '@/components/ui/caveat';
import { confirmChoice } from '@/lib/confirm';
import { needsCostConfirmation } from '@/lib/product-costing';
```

- [ ] **Step 2: Derive whether a confirm is owed**

Below the existing `valid` computation at `src/components/product-form.tsx:156-157`, add:

```ts
// `initial` is undefined for a new product, so `initial?.costCents` is
// undefined there and null for an existing product saved without a cost --
// the two cases differ and needsCostConfirmation depends on the difference.
const costBlank = costInput.trim() === '';
const willConfirmCost = needsCostConfirmation(costInput, initial?.costCents);
```

Do NOT add `costBlank` or `willConfirmCost` to `valid`. An empty cost never blocks a save; it only prompts.

- [ ] **Step 3: Ask before saving**

In `submit()`, immediately after the `if (!valid) return;` guard at `src/components/product-form.tsx:166-169` and BEFORE `setSubmitting(true)`:

```ts
const submit = async () => {
  if (!valid) return;
  // Asked before anything is spent: the photo upload and the brand/category
  // /tag writes below are side effects that would have to be undone if the
  // answer were no. Declining here costs nothing and leaves nothing behind.
  if (willConfirmCost) {
    const proceed = await confirmChoice(
      'Save without a purchase cost?',
      "Profit and cost of goods won't include this product.",
      'Save anyway'
    );
    if (!proceed) return;
  }
  setSubmitting(true);
  setError(null);
  try {
    // … the rest of the function is unchanged
```

Because the confirm sits before `setSubmitting(true)`, declining needs no `setSubmitting(false)` to unwind — the spinner never started.

- [ ] **Step 4: Add the inline hint**

At `src/components/product-form.tsx:310-313`, the cost/price row currently reads:

```tsx
<Row>
  <Field label="PURCHASE COST" style={styles.half}><TextInput value={costInput} onChangeText={setCostInput} placeholder="0.00" placeholderTextColor="#999999" keyboardType="decimal-pad" style={styles.input} /></Field>
  <Field label="RETAIL PRICE *" style={styles.half}><TextInput value={priceInput} onChangeText={setPriceInput} placeholder="0.00" placeholderTextColor="#999999" keyboardType="decimal-pad" style={styles.input} /></Field>
</Row>
```

Add the hint directly beneath that `<Row>`:

```tsx
<Row>
  <Field label="PURCHASE COST" style={styles.half}><TextInput value={costInput} onChangeText={setCostInput} placeholder="0.00" placeholderTextColor="#999999" keyboardType="decimal-pad" style={styles.input} /></Field>
  <Field label="RETAIL PRICE *" style={styles.half}><TextInput value={priceInput} onChangeText={setPriceInput} placeholder="0.00" placeholderTextColor="#999999" keyboardType="decimal-pad" style={styles.input} /></Field>
</Row>
{/* 'context', not 'wrong'. caveat.tsx is explicit that the wrong tone is
    worse than not using it at all: 'wrong' means a figure is incorrect until
    something is fixed and must carry an action. A cost field that is empty
    mid-edit is not yet an error -- the person may be about to type in it --
    and dressing it as one would train people to skip the whole family,
    including the accurate caveat this same component draws on the dashboard.
    No action prop: the fix is the field immediately above. */}
{costBlank && (
  <Caveat tone="context">
    No purchase cost means this product won&apos;t count toward profit or cost of goods.
  </Caveat>
)}
```

Note `Caveat` takes `children: string`, so the apostrophe must be escaped as `&apos;` to satisfy the `react/no-unescaped-entities` lint rule the codebase already follows.

- [ ] **Step 5: Verify types and lint**

Run: `npx tsc --noEmit`
Expected: no errors.

Run: `npm run lint`
Expected: no new warnings for `product-form.tsx`.

- [ ] **Step 6: Run the whole suite**

Run: `npm test`
Expected: all tests pass, including the 13 added in Tasks 1 and 2. Nothing in this task should have changed an existing test's behaviour.

- [ ] **Step 7: Commit**

```bash
git add src/components/product-form.tsx
git commit -m "feat: warn before saving a product with no purchase cost"
```

---

### Task 6: Manual verification

Rendering cannot be tested in this repo, so it is checked by hand. Do not skip this and do not report the feature working without having run it — Tasks 3, 4 and 5 have no automated coverage of their UI at all.

**Files:** none.

**Interfaces:** consumes everything above.

- [ ] **Step 1: Start the app**

Run: `npm run web`
(Or `npm run ios` if a simulator is available — the confirm takes a different code path per platform, so checking both is worthwhile. Web uses `window.confirm`, native uses `Alert.alert`.)

- [ ] **Step 2: Check the chip**

Open Inventory. Confirm:
- A fourth chip reads `No cost N`, where N is a plausible count.
- Selecting it narrows the list, and the subtitle switches to `N of 86 products`.
- Typing in the search box narrows *within* the filter rather than escaping it.
- Selecting `All` restores the full list.

- [ ] **Step 3: Check the deep link**

Navigate to `/inventory?filter=nocost` directly. Expected: the list opens already narrowed with the `No cost` chip active.

- [ ] **Step 4: Check the dashboard link**

Open the dashboard. If the uncosted caveat is showing, press **Set costs in Inventory**. Expected: lands on Inventory with the `No cost` chip active.

(If the caveat is not showing, the shop has no uncosted *sold* items — that is a valid state, not a bug. Verify Step 3 instead and note it.)

- [ ] **Step 5: Check the hint**

Open **+ Add product**. Expected: the hint sits under the cost/price row while PURCHASE COST is empty, and disappears as soon as a value is typed.

- [ ] **Step 6: Check the confirm, all four cases**

| Do this | Expect |
|---|---|
| New product, name + price, cost blank → Save | Dialog appears. **Cancel** returns to the form with nothing saved and no spinner stuck on. |
| Same again → **Save anyway** | Saves, product appears under the `No cost` chip. |
| Open that uncosted product, change its name only → Save | **No dialog.** Saves directly. |
| Open a costed product, clear its cost → Save | Dialog appears. |

- [ ] **Step 7: Report**

State plainly which steps passed and which did not. If a step failed, say so with what happened rather than describing the feature as done.

---

## Self-Review

Checked against `docs/superpowers/specs/2026-08-05-uncosted-products-design.md`:

| Spec requirement | Task |
|---|---|
| `No cost` chip in the `StockFilter` union | 3, steps 1 & 6 |
| Chip always renders with count, incl. zero | 3, step 6 |
| `costCents === null`, not `0` or falsy | 1 |
| `?filter=nocost` deep link | 3, step 3 |
| Dashboard caveat deep-linked | 4 |
| Confirm inside `ProductForm.submit()`, not the callers | 5, step 3 |
| Confirm fires on create + on clearing, not every save | 1, 5 |
| Inline hint, `tone="context"`, no action prop | 5, step 4 |
| `confirmChoice` beside `confirmDestructive`, non-destructive style | 2 |
| Both predicates in `lib/`, not inline | 1 |
| CSV import untouched | — (out of scope, no task, correct) |
| Cost stays optional | 5, step 2 (`valid` deliberately unchanged) |
| No backfill migration | — (out of scope, no task, correct) |

No placeholders. Signatures are consistent across tasks: `isUncosted` and `needsCostConfirmation` are defined in Task 1 and called with matching arity in Tasks 3 and 5; `confirmChoice(title, message, confirmLabel)` is defined in Task 2 and called with three arguments in Task 5.

One deviation from the spec, deliberate and noted here: the spec's `isUncosted` signature takes `Pick<Product, 'costCents'>` rather than a full `Product`, so the tests can pass object literals without constructing an entire product. `products.filter(isUncosted)` in Task 3 still type-checks, because `Product` satisfies the narrower parameter.
