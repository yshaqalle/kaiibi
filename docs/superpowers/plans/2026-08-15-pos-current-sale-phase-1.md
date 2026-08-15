# POS Current Sale Implementation Plan (Phase 1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Phase 2 is [`2026-08-15-pos-balances-phase-2.md`](./2026-08-15-pos-balances-phase-2.md)** — part payment, Pay later, settling an older balance and receivables. It needs a migration and an RPC change, and it starts after this ships. This plan is complete and useful without it.

**Goal:** Rebuild the till's current-sale surface so a counter tablet takes the money in one panel and a phone takes it in the sheet it already uses — both saying what they will do, both holding the total and the action still while the sale scrolls.

**Architecture:** The design is [`docs/design/pos-current-sale-mockup.html`](../../design/pos-current-sale-mockup.html) — read it before starting; the frames in it are the spec. Three ideas carry the work. **One panel, two surfaces:** above `TABLET_BREAKPOINT` the customer, discount and payment render inline in the sale panel; below it they stay in `CheckoutPanel`'s modal, restyled, because a handset cannot hold a basket and a payment at once. **A fixed frame:** every surface pins its head and its action and scrolls only the middle, which is what `receipt-modal.tsx` already does (and why its card takes a concrete `height`, not a `maxHeight`). **The button says what it will do:** its label comes from one pure function, so the panel and the sheet can never disagree about what the next tap does.

**Tech Stack:** Expo SDK 57 / React Native, TypeScript, Supabase, Jest (`jest-expo`, `react-test-renderer`). `@react-native-async-storage/async-storage` is already installed and is the store for held orders.

## Global Constraints

- **Expo docs:** read the exact versioned docs at https://docs.expo.dev/versions/v57.0.0/ before writing any code that touches an Expo API (`AGENTS.md`).
- **Scope: no schema, no RPC changes.** Everything here works against today's `complete_sale`, which refuses payments that do not equal the total. Part payment, Pay later, settling an older balance and receivables are **out of scope** — see "Explicitly out" below.
- **Never hardcode a hex in a screen.** POS reads `Colors.light` bento tokens from `src/constants/theme.ts` (`bentoPage`, `bentoSurface`, `bentoSoft`, `bentoInk`, `bentoInk2`, `bentoMuted`, `bentoMuted2`, `bentoLine`, `bentoRule`, `bentoUpWash`/`bentoUpInk`, `bentoAccentWash`/`bentoAccentInk`, `bentoLoss`). Radii are `BENTO_RADIUS` (26) and `BENTO_RADIUS_TILE` (18); pills are 999.
- **No dark mode.** The screen pins `const theme = Colors.light`.
- **Green and red never carry meaning alone** — a discount is `−$3.30`, never a colour on its own.
- **Yoga's `minWidth` default is `auto`:** any row that overflows (the category chips, a long product name) widens its parent instead of scrolling unless the child is given `minWidth: 0` / `flexShrink: 1`. This bit the mockup and it will bite the app.
- **A scroller needs a parent with a real height.** `flex: 1` inside a content-sized parent resolves to zero — the comment in `receipt-modal.tsx` (`height: '88%'`, not `maxHeight`) is the precedent to copy.
- **Tests:** `npm test` (Jest). Pure logic in `src/lib/__tests__/<name>.test.ts`; components in `src/components/__tests__/<name>.test.tsx` using `react-test-renderer` with the `textsIn` helper pattern from [`stat-tile.test.tsx`](../../../src/components/__tests__/stat-tile.test.tsx) — the repo has no query library installed.
- **Jest pins `TZ=America/New_York`.** Any date assertion must be timezone-independent.
- **Never `git add -A`** — a concurrent session may share this repository. Never push. Branch is `pos-checkout`.

## Explicitly out of scope (needs its own plan)

These are drawn in the mockup and deliberately not built here, because each needs the server before it can exist. The surfaces are composed so that none of them leaves a hole: with no balance data the **Pay later** choice and the **Owes** row simply do not render.

| Deferred | Why it cannot ship in this plan |
|---|---|
| Part payment (take some now) | `complete_sale` refuses payments that do not sum to the total |
| Pay later (nothing collected) | Needs a sale status, an amount owed and the customer it belongs to |
| Settling an older balance | Needs a payment that belongs to an *older* sale, plus a basket-less transaction |
| Receivables in Accounting | Follows from the above |
| The category row's fade | `expo-linear-gradient` is not a dependency; the row still scrolls, it just has no soft edge |

## File Structure

| File | Responsibility |
|---|---|
| `src/lib/checkout-intent.ts` | Pure. What has been collected, what is left, and the exact sentence on the primary button |
| `src/lib/__tests__/checkout-intent.test.ts` | Its tests |
| `src/lib/display-currency.ts` | Pure. Which currency the shop shows alongside USD, and the string for an amount in it |
| `src/lib/__tests__/display-currency.test.ts` | Its tests |
| `src/lib/held-orders.ts` | Parked sales, persisted per user and location, following `support-draft.ts` |
| `src/lib/__tests__/held-orders.test.ts` | Its tests |
| `src/components/pos/dual-amount.tsx` | One money figure and its local-currency echo |
| `src/components/pos/sale-panel.tsx` | The panel shell: pinned head, scrolling middle, pinned total and action |
| `src/components/pos/sale-line.tsx` | One cart line: photo, name, offer tag, discount chips, stepper, remove |
| `src/components/pos/held-orders-menu.tsx` | The stack button, its badge, the parked list and Resume |
| `src/components/__tests__/sale-panel.test.tsx` | Panel: wide vs compact foot, pinned regions |
| `src/components/__tests__/sale-line.test.tsx` | Line: offer tag, discount chips, remove |
| `src/components/checkout-panel.tsx` | Modify: phone-only sheet, fixed frame, pinned charge button carrying the shared intent |
| `src/components/payment-method-picker.tsx` | Modify: permanent "still to pay", bento styling, cash note buttons |
| `src/app/(admin)/(tabs)/pos.tsx` | Modify: compose the panel; inline blocks when wide, sheet when compact; compact foot; category row fix |

---

### Task 1: `checkout-intent.ts` — one sentence, two surfaces

The panel's button and the sheet's button must never disagree, so neither of them computes its own label. Pure functions, no React, no database — this is the task everything downstream reads.

**Files:**
- Create: `src/lib/checkout-intent.ts`
- Test: `src/lib/__tests__/checkout-intent.test.ts`

**Interfaces:**
- Consumes: `PaymentLine` from `@/types/models`, `formatCents` from `@/lib/currency`, `methodLabel` from `@/lib/payment-methods`.
- Produces:
  - `collectedCents(payments: PaymentLine[]): number`
  - `remainingCents(totalCents: number, payments: PaymentLine[]): number`
  - `type CheckoutIntent = { label: string; hint: string | null; enabled: boolean }`
  - `checkoutIntent(input: CheckoutIntentInput): CheckoutIntent` where
    `type CheckoutIntentInput = { cartEmpty: boolean; totalCents: number; payments: PaymentLine[]; customerName: string | null; submitting: boolean; secondaryTotal: string | null }`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/__tests__/checkout-intent.test.ts`:

```ts
import { checkoutIntent, collectedCents, remainingCents } from '@/lib/checkout-intent';
import type { PaymentLine } from '@/types/models';

const payment = (method: PaymentLine['method'], amountCents: number): PaymentLine => ({
  method,
  amountCents,
  tenderedCents: null,
  customerName: null,
  customerPhone: null,
  currencyCode: null,
  exchangeRate: null,
  foreignAmountCents: null,
  foreignChangeCents: null,
});

const base = {
  cartEmpty: false,
  totalCents: 8474,
  payments: [] as PaymentLine[],
  customerName: null,
  submitting: false,
  secondaryTotal: null,
};

describe('collectedCents', () => {
  it('is zero with no payments', () => {
    expect(collectedCents([])).toBe(0);
  });

  it('adds every payment, however it was tendered', () => {
    expect(collectedCents([payment('cash', 5000), payment('zaad', 3474)])).toBe(8474);
  });
});

describe('remainingCents', () => {
  it('is the whole total before anything is taken', () => {
    expect(remainingCents(8474, [])).toBe(8474);
  });

  it('never goes negative when a cash tender exceeds the bill', () => {
    expect(remainingCents(8474, [payment('cash', 9000)])).toBe(0);
  });
});

describe('checkoutIntent', () => {
  it('refuses an empty cart and says why', () => {
    expect(checkoutIntent({ ...base, cartEmpty: true, totalCents: 0 })).toEqual({
      label: 'Nothing to charge yet',
      hint: null,
      enabled: false,
    });
  });

  it('asks for a payment before one exists', () => {
    const intent = checkoutIntent(base);
    expect(intent.label).toBe('Take a payment');
    expect(intent.enabled).toBe(false);
  });

  it('names what is left when the payments do not cover the bill', () => {
    const intent = checkoutIntent({ ...base, payments: [payment('cash', 5000)] });
    expect(intent.label).toBe('Collect the remaining $34.74');
    expect(intent.enabled).toBe(false);
  });

  it('names the amount and the method once it is covered', () => {
    const intent = checkoutIntent({ ...base, payments: [payment('cash', 8474)] });
    expect(intent.label).toBe('Charge $84.74 · Cash');
    expect(intent.enabled).toBe(true);
  });

  it('counts the ways instead of naming one method on a split', () => {
    const intent = checkoutIntent({
      ...base,
      payments: [payment('cash', 5000), payment('zaad', 3474)],
    });
    expect(intent.label).toBe('Charge $84.74 · split 2 ways');
  });

  it('says where the receipt goes, in both currencies when there is a second one', () => {
    const intent = checkoutIntent({
      ...base,
      payments: [payment('cash', 8474)],
      customerName: 'Amina Yusuf',
      secondaryTotal: 'SLSH 720,290',
    });
    expect(intent.hint).toBe('Receipt saved to Amina Yusuf · SLSH 720,290');
  });

  it('warns that a walk-in receipt is not saved to anyone', () => {
    const intent = checkoutIntent({ ...base, payments: [payment('cash', 8474)] });
    expect(intent.hint).toBe('No customer — the receipt is printed, not saved');
  });

  it('reports its own progress while the sale is being completed', () => {
    const intent = checkoutIntent({ ...base, payments: [payment('cash', 8474)], submitting: true });
    expect(intent).toEqual({ label: 'Completing…', hint: null, enabled: false });
  });
});
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `npx jest src/lib/__tests__/checkout-intent.test.ts`
Expected: FAIL — `Cannot find module '@/lib/checkout-intent'`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/checkout-intent.ts`:

```ts
import { formatCents } from '@/lib/currency';
import { methodLabel } from '@/lib/payment-methods';
import type { PaymentLine } from '@/types/models';

export type CheckoutIntent = {
  label: string;
  hint: string | null;
  enabled: boolean;
};

export type CheckoutIntentInput = {
  cartEmpty: boolean;
  totalCents: number;
  payments: PaymentLine[];
  customerName: string | null;
  submitting: boolean;
  // The same total in the shop's local currency, already formatted, or null
  // where the shop keeps no second currency.
  secondaryTotal: string | null;
};

export function collectedCents(payments: PaymentLine[]): number {
  return payments.reduce((sum, payment) => sum + payment.amountCents, 0);
}

export function remainingCents(totalCents: number, payments: PaymentLine[]): number {
  return Math.max(0, totalCents - collectedCents(payments));
}

// The label is the whole point: "Checkout" is a door, and a disabled button
// with no reason on it is a dead end. Every branch that cannot fire says which
// decision is missing instead.
export function checkoutIntent(input: CheckoutIntentInput): CheckoutIntent {
  const { cartEmpty, totalCents, payments, customerName, submitting, secondaryTotal } = input;

  if (submitting) return { label: 'Completing…', hint: null, enabled: false };
  if (cartEmpty) return { label: 'Nothing to charge yet', hint: null, enabled: false };
  if (payments.length === 0) return { label: 'Take a payment', hint: null, enabled: false };

  const remaining = remainingCents(totalCents, payments);
  if (remaining > 0) {
    return { label: `Collect the remaining ${formatCents(remaining)}`, hint: null, enabled: false };
  }

  const how = payments.length === 1 ? methodLabel(payments[0].method) : `split ${payments.length} ways`;
  const receipt = customerName
    ? `Receipt saved to ${customerName}`
    : 'No customer — the receipt is printed, not saved';

  return {
    label: `Charge ${formatCents(totalCents)} · ${how}`,
    hint: secondaryTotal ? `${receipt} · ${secondaryTotal}` : receipt,
    enabled: true,
  };
}
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `npx jest src/lib/__tests__/checkout-intent.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/checkout-intent.ts src/lib/__tests__/checkout-intent.test.ts
git commit -m "feat(pos): one sentence for the button that takes the money"
```

---

### Task 2: `display-currency.ts` — the shilling under the dollar

Every money figure on the till gains a second line in the shop's own currency. The rate is the shop's (`currencies.rateToUsd`, already maintained for drawer counts) and never a constant in the client.

**Files:**
- Create: `src/lib/display-currency.ts`
- Test: `src/lib/__tests__/display-currency.test.ts`

**Interfaces:**
- Consumes: `Currency` from `@/types/models`; `usdCentsToForeignCents`, `formatForeignCents` from `@/lib/currency`.
- Produces:
  - `displayCurrency(currencies: Currency[]): Currency | null`
  - `secondaryAmount(usdCents: number, currency: Currency | null): string | null`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/__tests__/display-currency.test.ts`:

```ts
import { displayCurrency, secondaryAmount } from '@/lib/display-currency';
import type { Currency } from '@/types/models';

const currency = (over: Partial<Currency> = {}): Currency => ({
  id: 'cur-1',
  shopId: 'shop-1',
  code: 'SLSH',
  name: 'Somaliland Shilling',
  symbol: 'SLSH',
  rateToUsd: 8500,
  active: true,
  createdAt: '2026-08-01T00:00:00.000Z',
  ...over,
});

describe('displayCurrency', () => {
  it('is nothing for a shop that keeps only dollars', () => {
    expect(displayCurrency([])).toBeNull();
  });

  it('is the first active currency', () => {
    const slsh = currency();
    expect(displayCurrency([slsh])).toBe(slsh);
  });

  it('skips an inactive one rather than pricing against a rate nobody maintains', () => {
    const retired = currency({ id: 'cur-0', code: 'ETB', active: false });
    const live = currency();
    expect(displayCurrency([retired, live])).toBe(live);
  });

  it('never picks USD, which is already the primary figure', () => {
    const usd = currency({ id: 'cur-usd', code: 'USD', symbol: '$', rateToUsd: 1 });
    expect(displayCurrency([usd])).toBeNull();
  });
});

describe('secondaryAmount', () => {
  it('is nothing without a second currency', () => {
    expect(secondaryAmount(8474, null)).toBeNull();
  });

  it('converts at the shop rate and prints whole units', () => {
    expect(secondaryAmount(8474, currency())).toBe('720,290 SLSH');
  });

  it('converts zero rather than hiding it', () => {
    expect(secondaryAmount(0, currency())).toBe('0 SLSH');
  });

  it('refuses a rate that cannot convert anything', () => {
    expect(secondaryAmount(8474, currency({ rateToUsd: 0 }))).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `npx jest src/lib/__tests__/display-currency.test.ts`
Expected: FAIL — `Cannot find module '@/lib/display-currency'`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/display-currency.ts`:

```ts
import { formatForeignCents, usdCentsToForeignCents } from '@/lib/currency';
import type { Currency } from '@/types/models';

// The shop's second currency, if it keeps one. `currencies` is a list with no
// primary, so the first active non-USD row is the pick -- a shop that trades in
// two local currencies is not a case this till has ever had.
export function displayCurrency(currencies: Currency[]): Currency | null {
  return currencies.find((c) => c.active && c.code.toUpperCase() !== 'USD') ?? null;
}

// The echo under a dollar figure. Null when there is nothing to echo, so a
// caller renders one line instead of an empty second one.
export function secondaryAmount(usdCents: number, currency: Currency | null): string | null {
  if (!currency || currency.rateToUsd <= 0) return null;
  return formatForeignCents(usdCentsToForeignCents(usdCents, currency.rateToUsd), currency.symbol);
}
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `npx jest src/lib/__tests__/display-currency.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/display-currency.ts src/lib/__tests__/display-currency.test.ts
git commit -m "feat(pos): the shop's own currency, from the shop's own rate"
```

---

### Task 3: `DualAmount` — a figure and its echo

One component so the pairing is identical on a tile, a cart line and a total, and so nobody re-invents the spacing.

**Files:**
- Create: `src/components/pos/dual-amount.tsx`
- Modify: `src/app/(admin)/(tabs)/pos.tsx` — the product tile's price and the totals block
- Test: `src/components/__tests__/dual-amount.test.tsx`

**Interfaces:**
- Consumes: `secondaryAmount` from Task 2.
- Produces: `<DualAmount cents={number} currency={Currency | null} size="tile" | "line" | "total" align="left" | "right" />`

- [ ] **Step 1: Write the failing test**

Create `src/components/__tests__/dual-amount.test.tsx`:

```tsx
import { create, type ReactTestRendererJSON } from 'react-test-renderer';

import { DualAmount } from '@/components/pos/dual-amount';
import type { Currency } from '@/types/models';

function textsIn(node: ReactTestRendererJSON | ReactTestRendererJSON[] | string | null): string[] {
  if (node == null) return [];
  if (typeof node === 'string') return [node];
  if (Array.isArray(node)) return node.flatMap(textsIn);
  return textsIn(node.children as ReactTestRendererJSON[] | null);
}

const slsh: Currency = {
  id: 'cur-1', shopId: 'shop-1', code: 'SLSH', name: 'Somaliland Shilling',
  symbol: 'SLSH', rateToUsd: 8500, active: true, createdAt: '2026-08-01T00:00:00.000Z',
};

const render = (currency: Currency | null) =>
  textsIn(create(<DualAmount cents={8474} currency={currency} size="line" />).toJSON() as ReactTestRendererJSON);

describe('DualAmount', () => {
  it('prints the dollars and the shillings', () => {
    expect(render(slsh)).toEqual(['$84.74', '720,290 SLSH']);
  });

  it('prints one line for a shop with no second currency', () => {
    expect(render(null)).toEqual(['$84.74']);
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `npx jest src/components/__tests__/dual-amount.test.tsx`
Expected: FAIL — `Cannot find module '@/components/pos/dual-amount'`.

- [ ] **Step 3: Write the component**

Create `src/components/pos/dual-amount.tsx`:

```tsx
import { StyleSheet, Text, View } from 'react-native';

import { Colors } from '@/constants/theme';
import { formatCents } from '@/lib/currency';
import { secondaryAmount } from '@/lib/display-currency';
import type { Currency } from '@/types/models';

const theme = Colors.light;

export function DualAmount({
  cents,
  currency,
  size = 'line',
  align = 'right',
}: {
  cents: number;
  currency: Currency | null;
  size?: 'tile' | 'line' | 'total';
  align?: 'left' | 'right';
}) {
  const secondary = secondaryAmount(cents, currency);
  return (
    <View style={align === 'right' ? styles.right : styles.left}>
      <Text style={[styles.primary, size === 'tile' && styles.primaryTile, size === 'total' && styles.primaryTotal]}>
        {formatCents(cents)}
      </Text>
      {secondary && (
        <Text style={[styles.secondary, size === 'total' && styles.secondaryTotal]}>{secondary}</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  right: { alignItems: 'flex-end' },
  left: { alignItems: 'flex-start' },
  primary: { color: theme.bentoInk, fontSize: 13, fontWeight: '800', fontVariant: ['tabular-nums'] },
  primaryTile: { fontSize: 13.5 },
  primaryTotal: { fontSize: 30, letterSpacing: -1 },
  // Deliberately quiet: it is the same money, said again for the customer's
  // ear, not a second figure to reconcile.
  secondary: { color: theme.bentoMuted2, fontSize: 10, fontWeight: '600', fontVariant: ['tabular-nums'] },
  secondaryTotal: { fontSize: 11 },
});
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `npx jest src/components/__tests__/dual-amount.test.tsx`
Expected: PASS, 2 tests.

- [ ] **Step 5: Use it on the product tile and the total**

In `src/app/(admin)/(tabs)/pos.tsx`:

1. Import it and the currency picker:

```tsx
import { DualAmount } from '@/components/pos/dual-amount';
import { displayCurrency } from '@/lib/display-currency';
```

2. Derive the currency once, next to the other derived values (after `const [currencies, setCurrencies] = useState<Currency[]>([]);`):

```tsx
// The shop's second currency, chosen once per render and passed down -- so a
// tile, a line and the total can never echo different rates.
const secondCurrency = displayCurrency(currencies);
```

3. Replace the grid tile's price `<Text>` (the one styled `styles.gridPrice`) with:

```tsx
<DualAmount cents={product.priceCents} currency={secondCurrency} size="tile" align="left" />
```

4. Replace the total row's value `<Text style={styles.totalValue}>` with:

```tsx
<DualAmount cents={total} currency={secondCurrency} size="total" />
```

- [ ] **Step 6: Run the whole suite**

Run: `npm test`
Expected: PASS. No test asserts on the removed `totalValue` text node; if one does, update it to read the same string from `DualAmount`.

- [ ] **Step 7: Commit**

```bash
git add src/components/pos/dual-amount.tsx src/components/__tests__/dual-amount.test.tsx "src/app/(admin)/(tabs)/pos.tsx"
git commit -m "feat(pos): every price says what it is in shillings too"
```

---

### Task 4: The panel shell — pinned, scrolling, pinned

The structural change everything else sits inside. The title, item count and **Clear all** hold at the top; the total and the primary action hold at the bottom; everything that grows with the sale scrolls between them. On a phone the action is `Checkout · $84.74`, which opens the sheet; on a tablet it is the intent from Task 1.

**Files:**
- Create: `src/components/pos/sale-panel.tsx`
- Modify: `src/app/(admin)/(tabs)/pos.tsx` — `cartPaneEl` becomes a `<SalePanel>` with children
- Test: `src/components/__tests__/sale-panel.test.tsx`

**Interfaces:**
- Consumes: `CheckoutIntent` from Task 1, `DualAmount` from Task 3.
- Produces:

```tsx
<SalePanel
  compact={boolean}
  itemCount={number}
  onClearAll={(() => void) | null}   // null hides Clear all (empty cart)
  head={ReactNode}                    // held-orders menu, Task 8
  totalCents={number}
  currency={Currency | null}
  intent={CheckoutIntent}
  onPrimary={() => void}
  onHold={(() => void) | null}
  servedBy={string | null}
  onChangeServedBy={() => void}
>
  {/* the scrolling middle */}
</SalePanel>
```

- [ ] **Step 1: Write the failing test**

Create `src/components/__tests__/sale-panel.test.tsx`:

```tsx
import { create, type ReactTestRendererJSON } from 'react-test-renderer';
import { Text } from 'react-native';

import { SalePanel } from '@/components/pos/sale-panel';

function textsIn(node: ReactTestRendererJSON | ReactTestRendererJSON[] | string | null): string[] {
  if (node == null) return [];
  if (typeof node === 'string') return [node];
  if (Array.isArray(node)) return node.flatMap(textsIn);
  return textsIn(node.children as ReactTestRendererJSON[] | null);
}

const props = {
  itemCount: 3,
  onClearAll: () => {},
  head: null,
  totalCents: 8474,
  currency: null,
  intent: { label: 'Charge $84.74 · Cash', hint: 'No customer — the receipt is printed, not saved', enabled: true },
  onPrimary: () => {},
  onHold: () => {},
  servedBy: 'Amran Jama',
  onChangeServedBy: () => {},
};

const render = (over: Partial<typeof props> & { compact: boolean }) =>
  textsIn(create(
    <SalePanel {...props} {...over}><Text>the sale</Text></SalePanel>
  ).toJSON() as ReactTestRendererJSON);

describe('SalePanel', () => {
  it('carries the sale, the total and the action', () => {
    const texts = render({ compact: false });
    expect(texts).toContain('Current sale');
    expect(texts).toContain('3 items');
    expect(texts).toContain('the sale');
    expect(texts).toContain('$84.74');
    expect(texts).toContain('Charge $84.74 · Cash');
  });

  it('counts one item without pluralising it', () => {
    expect(render({ compact: false, itemCount: 1 })).toContain('1 item');
  });

  it('offers Clear all only when there is something to clear', () => {
    expect(render({ compact: false })).toContain('Clear all');
    expect(render({ compact: false, onClearAll: null })).not.toContain('Clear all');
  });

  it('opens the sheet on a phone instead of charging in place', () => {
    const texts = render({ compact: true });
    expect(texts).toContain('Checkout · $84.74');
    expect(texts).not.toContain('Charge $84.74 · Cash');
  });

  it('says who is serving, on either size', () => {
    expect(render({ compact: false })).toContain('Amran Jama');
    expect(render({ compact: true })).toContain('Amran Jama');
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `npx jest src/components/__tests__/sale-panel.test.tsx`
Expected: FAIL — `Cannot find module '@/components/pos/sale-panel'`.

- [ ] **Step 3: Write the component**

Create `src/components/pos/sale-panel.tsx`. The shape is the receipt's: a card with a real height, a `flex: 1` scroller in the middle, and regions above and below it that never move.

```tsx
import { type ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { Card } from '@/components/card';
import { DualAmount } from '@/components/pos/dual-amount';
import { BENTO_RADIUS_TILE, Colors } from '@/constants/theme';
import type { CheckoutIntent } from '@/lib/checkout-intent';
import { formatCents } from '@/lib/currency';
import type { Currency } from '@/types/models';

const theme = Colors.light;

export function SalePanel({
  compact,
  itemCount,
  onClearAll,
  head,
  totalCents,
  currency,
  intent,
  onPrimary,
  onHold,
  servedBy,
  onChangeServedBy,
  children,
}: {
  compact: boolean;
  itemCount: number;
  onClearAll: (() => void) | null;
  head: ReactNode;
  totalCents: number;
  currency: Currency | null;
  intent: CheckoutIntent;
  onPrimary: () => void;
  onHold: (() => void) | null;
  servedBy: string | null;
  onChangeServedBy: () => void;
  children: ReactNode;
}) {
  // On a phone the sale is not charged here -- it opens the sheet, and the
  // decision the sheet exists to take has not been made yet, so the button
  // names the amount and nothing else.
  const primaryLabel = compact
    ? (itemCount > 0 ? `Checkout · ${formatCents(totalCents)}` : 'Nothing to charge yet')
    : intent.label;
  const primaryEnabled = compact ? itemCount > 0 : intent.enabled;

  // The middle is a plain View on a phone: the page scrolls there (the cart
  // renders above the browse pane), and nesting a flex-sized ScrollView inside
  // that scroller is the sizing fight pos.tsx already documents.
  const Middle = compact ? View : ScrollView;

  return (
    <Card variant="bento" style={[styles.card, compact && styles.cardCompact]}>
      <View style={styles.head}>
        <View style={styles.titleRow}>
          <Text style={styles.title}>Current sale</Text>
          <View style={styles.titleActions}>
            <Text style={styles.count}>{itemCount} {itemCount === 1 ? 'item' : 'items'}</Text>
            {onClearAll && (
              <Pressable onPress={onClearAll} style={styles.clear}>
                <Text style={styles.clearText}>Clear all</Text>
              </Pressable>
            )}
            {head}
          </View>
        </View>
      </View>

      <Middle style={compact ? undefined : styles.middle} contentContainerStyle={compact ? undefined : styles.middleContent}>
        {children}
      </Middle>

      <View style={styles.grand}>
        <View style={styles.grandRow}>
          <Text style={styles.grandLabel}>Total</Text>
          <DualAmount cents={totalCents} currency={currency} size="total" />
        </View>
      </View>

      <View style={styles.foot}>
        <Pressable
          onPress={onPrimary}
          disabled={!primaryEnabled}
          style={[styles.primary, !primaryEnabled && styles.primaryDisabled]}
        >
          <Text style={styles.primaryText}>{primaryLabel}</Text>
        </Pressable>
        {!compact && intent.hint && <Text style={styles.hint}>{intent.hint}</Text>}
        <View style={compact ? styles.footRowCompact : undefined}>
          {onHold && (
            <Pressable onPress={onHold} style={compact ? styles.holdMini : styles.hold}>
              <Text style={compact ? styles.holdMiniText : styles.holdText}>Hold{compact ? '' : ' for later'}</Text>
            </Pressable>
          )}
          <Pressable onPress={onChangeServedBy} style={styles.served}>
            <Text style={styles.servedText}>Served by <Text style={styles.servedName}>{servedBy ?? 'nobody yet'}</Text></Text>
          </Pressable>
        </View>
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  // A concrete height on the wide layout, so `middle` has something to resolve
  // its flex against -- against a content-sized parent it collapses to nothing
  // and the panel grows with the basket instead. Same rule as receipt-modal.
  card: { flex: 1, padding: 0, overflow: 'hidden' },
  cardCompact: { flex: 0 },
  head: { paddingHorizontal: 18, paddingTop: 18, paddingBottom: 10 },
  titleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  title: { color: theme.bentoInk, fontSize: 17, fontWeight: '800', letterSpacing: -0.3 },
  titleActions: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  count: { color: theme.bentoMuted, fontSize: 12, fontWeight: '700', backgroundColor: theme.bentoSoft, borderRadius: 999, paddingVertical: 3, paddingHorizontal: 10 },
  clear: { backgroundColor: theme.bentoSoft, borderRadius: 999, paddingVertical: 5, paddingHorizontal: 11 },
  clearText: { color: theme.bentoMuted, fontSize: 11.5, fontWeight: '700' },
  middle: { flex: 1 },
  middleContent: { paddingBottom: 4 },
  grand: { backgroundColor: theme.bentoSoft, paddingHorizontal: 18, paddingVertical: 14 },
  grandRow: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between' },
  grandLabel: { color: theme.bentoInk, fontSize: 15, fontWeight: '800' },
  foot: { padding: 18, paddingTop: 14 },
  primary: { backgroundColor: theme.bentoInk, height: 56, borderRadius: 999, alignItems: 'center', justifyContent: 'center' },
  primaryDisabled: { opacity: 0.35 },
  primaryText: { color: theme.bentoSurface, fontSize: 15, fontWeight: '800' },
  hint: { color: theme.bentoMuted, fontSize: 11.5, textAlign: 'center', marginTop: 9 },
  footRowCompact: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginTop: 9 },
  hold: { marginTop: 10, paddingVertical: 13, borderRadius: 999, backgroundColor: theme.bentoSoft, alignItems: 'center' },
  holdText: { color: theme.bentoMuted, fontSize: 12.5, fontWeight: '700' },
  holdMini: { backgroundColor: theme.bentoSoft, borderRadius: 999, paddingVertical: 7, paddingHorizontal: 13 },
  holdMiniText: { color: theme.bentoMuted, fontSize: 11.5, fontWeight: '700' },
  served: { paddingVertical: 6 },
  servedText: { color: theme.bentoMuted, fontSize: 11.5 },
  servedName: { color: theme.bentoInk2, fontWeight: '700' },
});
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `npx jest src/components/__tests__/sale-panel.test.tsx`
Expected: PASS, 5 tests.

- [ ] **Step 5: Compose it in `pos.tsx`**

Replace the body of `cartPaneEl` so the `<Card variant="bento">` and its title row, totals block, `CheckoutPanel` trigger, and the clear/scan buttons become:

```tsx
const intent = checkoutIntent({
  cartEmpty: cart.length === 0,
  totalCents: total,
  payments,
  customerName: selectedCustomer?.name ?? null,
  submitting,
  secondaryTotal: secondaryAmount(total, secondCurrency),
});

const cartPaneEl = (
  <View style={[styles.cartPane, compact && styles.cartPaneCompact]}>
    {registerBlocks && <RegisterGate onOpen={() => setRegisterSheet('open')} />}
    {!registerBlocks && (
      <SalePanel
        compact={compact}
        itemCount={cart.reduce((sum, line) => sum + line.quantity, 0)}
        onClearAll={cart.length > 0 ? clearSale : null}
        head={null /* held orders arrive in Task 8 */}
        totalCents={total}
        currency={secondCurrency}
        intent={intent}
        onPrimary={compact ? () => setCheckoutOpen(true) : checkout}
        onHold={null /* Task 8 */}
        servedBy={cashierName}
        onChangeServedBy={() => setCheckoutOpen(true)}
      >
        {/* cart lines, discount, and — when wide — the payment blocks */}
      </SalePanel>
    )}
  </View>
);
```

Add the state the compact path needs, next to the other `useState` calls:

```tsx
// The phone's checkout modal. Owned here rather than inside CheckoutPanel so
// the panel's button, the "Served by" row and a completed sale can all open and
// close it.
const [checkoutOpen, setCheckoutOpen] = useState(false);
```

Keep the existing cart lines and discount section as the children for now; Task 5 restyles them and Task 6 moves the payment blocks in.

- [ ] **Step 6: Run the suite and the app**

Run: `npm test`
Expected: PASS.

Run the app and confirm on a wide window: the total and the button stay put while the cart list scrolls, and the button reads `Take a payment` until a payment exists.

- [ ] **Step 7: Commit**

```bash
git add src/components/pos/sale-panel.tsx src/components/__tests__/sale-panel.test.tsx "src/app/(admin)/(tabs)/pos.tsx"
git commit -m "feat(pos): the total and the action hold still while the sale scrolls"
```

---

### Task 5: The cart line, on two rows

At 392px a name, a stepper, a total and a remove button on one line leave the name three words wide. The name and its tags own the first row; the stepper and the money own the second. The offer tag stays unremovable — it is the shop's price, not the cashier's discount — and the manual discount becomes a chip row in front of the existing editor.

**Files:**
- Create: `src/components/pos/sale-line.tsx`
- Modify: `src/app/(admin)/(tabs)/pos.tsx` — the `cart.map(...)` block becomes `<SaleLine>`
- Test: `src/components/__tests__/sale-line.test.tsx`

**Interfaces:**
- Consumes: `DualAmount` (Task 3), `QuantityStepper`, `DiscountEditor`.
- Produces:

```tsx
<SaleLine
  line={CartLine}
  netCents={number}          // after offer and manual discount
  grossCents={number}
  offerName={string | null}
  currency={Currency | null}
  canDiscount={boolean}
  editing={boolean}
  onToggleEditing={() => void}
  onQuantity={(next: number) => void}
  onRemove={() => void}
  onDiscount={(discount: Discount | null) => void}
/>
```

- [ ] **Step 1: Write the failing test**

Create `src/components/__tests__/sale-line.test.tsx`:

```tsx
import { create, type ReactTestRendererJSON } from 'react-test-renderer';

import { SaleLine } from '@/components/pos/sale-line';
import type { CartLine, Product } from '@/types/models';

function textsIn(node: ReactTestRendererJSON | ReactTestRendererJSON[] | string | null): string[] {
  if (node == null) return [];
  if (typeof node === 'string') return [node];
  if (Array.isArray(node)) return node.flatMap(textsIn);
  return textsIn(node.children as ReactTestRendererJSON[] | null);
}

const product = {
  id: 'p1', shopId: 'shop-1', name: 'Balanceful Cica Serum', brand: 'Torriden',
  category: 'Serums', priceCents: 2200, costCents: 1200, stock: 3, sku: null, barcode: null,
  imageUrl: null, reorderLevel: 5, createdAt: '2026-08-01T00:00:00.000Z',
} as unknown as Product;

const line: CartLine = { product, quantity: 1 };

const props = {
  line,
  netCents: 1870,
  grossCents: 2200,
  offerName: null as string | null,
  currency: null,
  canDiscount: true,
  editing: false,
  onToggleEditing: () => {},
  onQuantity: () => {},
  onRemove: () => {},
  onDiscount: () => {},
};

const render = (over: Partial<typeof props> = {}) =>
  textsIn(create(<SaleLine {...props} {...over} />).toJSON() as ReactTestRendererJSON);

describe('SaleLine', () => {
  it('names the product and what it comes to', () => {
    const texts = render();
    expect(texts).toContain('Balanceful Cica Serum');
    expect(texts).toContain('$18.70');
  });

  it('strikes the old price only when something came off', () => {
    expect(render()).toContain('$22.00');
    expect(render({ netCents: 2200 })).not.toContain('$22.00');
  });

  it('names the offer that did it', () => {
    expect(render({ offerName: 'Eid weekend' })).toContain('Eid weekend');
  });

  it('offers a discount only to someone allowed to give one', () => {
    expect(render()).toContain('Discount');
    expect(render({ canDiscount: false })).not.toContain('Discount');
  });

  it('shows the preset chips while the discount is being set', () => {
    const texts = render({ editing: true });
    expect(texts).toContain('5%');
    expect(texts).toContain('20%');
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `npx jest src/components/__tests__/sale-line.test.tsx`
Expected: FAIL — `Cannot find module '@/components/pos/sale-line'`.

- [ ] **Step 3: Write the component**

Create `src/components/pos/sale-line.tsx` with two rows inside the body. Requirements the test pins, plus the ones it cannot see:

- Row one: 38×38 thumbnail (`product.imageUrl` via `expo-image`, else the initials tile the grid already uses), name (`numberOfLines={2}`, `flexShrink: 1`, `minWidth: 0`), and a 26px remove button at the right.
- Under the name: struck gross price when `netCents !== grossCents`, the net price, the offer tag (`bentoUpWash`/`bentoUpInk`, not pressable), and the discount control.
- The discount control is a chip that opens the preset row `5% / 10% / 15% / 20% / Custom / Remove`. **It does not cycle** — a tap that silently changes a price with no confirmation is the failure this avoids. `Custom` opens the existing `DiscountEditor`.
- Row two: `QuantityStepper` on the left, `<DualAmount cents={netCents} currency={currency} />` on the right.
- Every preset chip calls `onDiscount({ kind: 'percent', value })` using the `Discount` shape `DiscountEditor` already produces; `Remove` calls `onDiscount(null)`.

- [ ] **Step 4: Run the test and watch it pass**

Run: `npx jest src/components/__tests__/sale-line.test.tsx`
Expected: PASS, 5 tests.

- [ ] **Step 5: Use it in `pos.tsx`**

Replace the `cart.map((line) => { ... })` body with `<SaleLine>`, passing the values already computed there:

```tsx
{cart.map((line) => (
  <SaleLine
    key={line.product.id}
    line={line}
    grossCents={lineGrossCents(line)}
    netCents={lineGrossCents(line) - lineDiscountCents(line, promotions, pricingNow)}
    offerName={line.manualDiscount ? null : (appliedPromotionForLine(line, promotions, pricingNow)?.name ?? null)}
    currency={secondCurrency}
    canDiscount={can('discounts.manual')}
    editing={editingLineDiscount === line.product.id}
    onToggleEditing={() => setEditingLineDiscount(editingLineDiscount === line.product.id ? null : line.product.id)}
    onQuantity={(next) => setQuantity(line.product.id, next)}
    onRemove={() => setQuantity(line.product.id, 0)}
    onDiscount={(discount) => { setLineDiscount(line.product.id, discount); setEditingLineDiscount(null); }}
  />
))}
```

- [ ] **Step 6: Run the suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/components/pos/sale-line.tsx src/components/__tests__/sale-line.test.tsx "src/app/(admin)/(tabs)/pos.tsx"
git commit -m "feat(pos): a cart line that fits its name, and a discount that asks first"
```

---

### Task 6: Inline on a tablet — the sheet's blocks move into the panel

Above `TABLET_BREAKPOINT` the customer, the points and the payment render in the panel's scrolling middle. Below it, nothing changes: the same blocks stay in the sheet. `CheckoutPanel` stops owning its own trigger and becomes a controlled modal.

**Files:**
- Modify: `src/components/checkout-panel.tsx`
- Modify: `src/app/(admin)/(tabs)/pos.tsx`

**Interfaces:**
- `CheckoutPanel` gains `visible: boolean` and `onClose: () => void`, and loses the internal `open` state and the `Checkout` `Pressable` it rendered. Every other prop is unchanged.
- Its blocks are extracted so both surfaces render the same nodes:
  `export function CheckoutBlocks(props: CheckoutBlocksProps): JSX.Element` — cashier chips are **not** part of it (they became "Served by").

- [ ] **Step 1: Extract the blocks**

In `src/components/checkout-panel.tsx`, move everything between the header and the `Complete sale` button — `CustomerPicker`, `PointsSection`, `PaymentMethodPicker`, the error `Text` — into `CheckoutBlocks`, exported from the same file. The sheet renders `<CheckoutBlocks {...} />`; the panel will render the same component.

- [ ] **Step 2: Make the modal controlled**

Replace `const [open, setOpen] = useState(false);` and the trigger `Pressable` with the `visible` / `onClose` props. The effect that closed the sheet when the cart emptied stays, calling `onClose()` instead of `setOpen(false)`.

- [ ] **Step 3: Render inline when wide**

In `pos.tsx`, inside `<SalePanel>`'s children, after the cart lines and discount section:

```tsx
{!compact && shop && <CheckoutBlocks {...checkoutBlockProps} />}
```

and render the sheet only on a phone:

```tsx
{compact && shop && (
  <CheckoutPanel
    visible={checkoutOpen}
    onClose={() => setCheckoutOpen(false)}
    {...checkoutBlockProps}
    fullyPaid={fullyPaid}
    submitting={submitting}
    intent={intent}
    onCheckout={checkout}
    onDismiss={showStagedReceipt}
  />
)}
```

Build `checkoutBlockProps` once, from the props `CheckoutPanel` takes today (`shopId`, `selectedCustomer`, `onSelectCustomer`, `onClearCustomer`, `totalCents`, `payments`, `currencies`, `onChangePayments`, `enabledPaymentMethods`, `allowSplit`, the loyalty group, `error`) so the two surfaces cannot drift.

- [ ] **Step 4: Move the cashier chips out**

Delete the `cashierSection` from the sheet. `SalePanel`'s "Served by" row is now the only place a cashier is chosen: `onChangeServedBy` opens a small picker listing `cashiers`. On a phone that picker is the sheet (already the case via `setCheckoutOpen(true)`); on a tablet render an `OptionPicker` from `src/components/option-picker.tsx`.

- [ ] **Step 5: Run the suite and both layouts**

Run: `npm test`
Expected: PASS.

Run the app. Wide: customer, points and payment sit in the panel, the sheet never opens. Narrow: the panel shows items and `Checkout · $84.74`; that button opens the sheet with the same blocks.

- [ ] **Step 6: Commit**

```bash
git add src/components/checkout-panel.tsx "src/app/(admin)/(tabs)/pos.tsx"
git commit -m "feat(pos): the counter takes payment in place, the phone keeps its sheet"
```

---

### Task 7: The sheet, redrawn

Same modal, same trigger, same dismissal handoff to the receipt. What changes: it becomes a fixed frame with a pinned charge button, and that button carries the intent from Task 1 instead of the word "Complete sale".

**Files:**
- Modify: `src/components/checkout-panel.tsx`

- [ ] **Step 1: Give the sheet a real height and three regions**

`styles.sheet` gains `height: '93%'` (a concrete height, not `maxHeight` — the note in `receipt-modal.tsx` says why) and `flexDirection: 'column'`. Inside it:

- the grab handle and header — `flexShrink: 0`;
- a `ScrollView` with `style={{ flex: 1 }}` and `contentContainerStyle={{ gap: 10, paddingBottom: 14 }}` holding `<CheckoutBlocks />`;
- a footer — `flexShrink: 0` — with the total, then the primary button.

Each block inside the scroller keeps `backgroundColor: theme.bentoSurface` and `borderRadius: BENTO_RADIUS` on the sheet's `theme.bentoPage` ground, which is the arrangement the file already documents.

- [ ] **Step 2: Put the shared sentence on the button**

Replace the `Complete sale` label with `intent.label`, and disable on `!intent.enabled`. The hint line under it renders `intent.hint`.

- [ ] **Step 3: Verify the handoff still works**

The receipt is presented from `onDismiss` on iOS. Confirm the staged-receipt path is untouched: complete a sale on an iPhone and the receipt appears after the sheet finishes dismissing.

- [ ] **Step 4: Commit**

```bash
git add src/components/checkout-panel.tsx
git commit -m "feat(pos): the sheet pins its charge button and says what it will do"
```

---

### Task 8: Held orders

Park the whole sale — basket, customer, discounts, payments entered so far — and resume it exactly as it was. Persisted, because a hold that dies with the app is worse than no hold: a cashier trusts it.

**Files:**
- Create: `src/lib/held-orders.ts`
- Create: `src/components/pos/held-orders-menu.tsx`
- Modify: `src/app/(admin)/(tabs)/pos.tsx`
- Test: `src/lib/__tests__/held-orders.test.ts`

**Interfaces:**
- Produces:
  - `type HeldOrder = { id: string; heldAt: string; cart: CartLine[]; customer: SelectedCustomer | null; transactionDiscount: Discount | null; pointsRedeemed: number; totalCents: number; itemCount: number }`
  - `readHeldOrders(userId: string, locationId: string | null): Promise<HeldOrder[]>`
  - `holdOrder(userId: string, locationId: string | null, order: Omit<HeldOrder, 'id' | 'heldAt'>): Promise<HeldOrder>`
  - `resumeHeldOrder(userId: string, locationId: string | null, id: string): Promise<HeldOrder | null>` — removes it as it returns it

- [ ] **Step 1: Write the failing tests**

Create `src/lib/__tests__/held-orders.test.ts`, following the shape of `support-draft.test.ts` (same AsyncStorage mock, same `settle()` helper). Cover:

```ts
it('starts with nothing held', async () => { ... expect(await readHeldOrders(USER, LOC)).toEqual([]); });
it('holds a sale and reads it back with its total and item count', async () => { ... });
it('keeps one till separate from another', async () => { /* different locationId, different key */ });
it('keeps one user separate from another', async () => { /* different userId, different key */ });
it('resumes an order and removes it, so it cannot be sold twice', async () => { ... });
it('returns null resuming an id that is not there', async () => { ... });
it('survives a corrupt payload rather than throwing at the till', async () => {
  await AsyncStorage.setItem(keyFor(USER, LOC), 'not json');
  expect(await readHeldOrders(USER, LOC)).toEqual([]);
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx jest src/lib/__tests__/held-orders.test.ts`
Expected: FAIL — `Cannot find module '@/lib/held-orders'`.

- [ ] **Step 3: Write the store**

Create `src/lib/held-orders.ts` copying `support-draft.ts`'s structure exactly: `keyFor(userId, locationId)` → `kaiibi.pos.held.${userId}.${locationId ?? 'shop'}`, a synchronous `window.localStorage` read on web, `AsyncStorage` elsewhere, every parse guarded so a corrupt payload reads as an empty list rather than throwing mid-shift.

- [ ] **Step 4: Run them and watch them pass**

Run: `npx jest src/lib/__tests__/held-orders.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Build the menu**

Create `src/components/pos/held-orders-menu.tsx`: a 32px round button carrying a badge with the count, which opens a list of `<customer or "Walk-in customer"> · N items · held Xm ago · total` rows each with **Resume**. It renders nothing at all when the list is empty — an always-present control for a feature nobody is using is noise.

- [ ] **Step 6: Wire it into `pos.tsx`**

- Load on mount and after each hold/resume: `readHeldOrders(profile.id, activeLocation?.id ?? null)`.
- `head={<HeldOrdersMenu ... />}` on `SalePanel`.
- `onHold` collects the current sale, calls `holdOrder`, then clears the till exactly as a completed sale does (cart, customer, discount, points, payments) — **without** clearing `cashierName`, which is sticky.
- Resume writes the returned order back into the session fields and clears the payments (the total is being re-derived, so a stale payment must not survive).

- [ ] **Step 7: Run the suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/lib/held-orders.ts src/lib/__tests__/held-orders.test.ts src/components/pos/held-orders-menu.tsx "src/app/(admin)/(tabs)/pos.tsx"
git commit -m "feat(pos): park a sale, serve the queue, resume it exactly as it was"
```

---

### Task 9: The phone's browse pane

Three space fixes, all of them about giving the screen back to what is being sold.

**Files:**
- Modify: `src/app/(admin)/(tabs)/pos.tsx`

- [ ] **Step 1: Stop the category row widening its pane**

The row is already a horizontal `ScrollView`. Give its container `minWidth: 0` and the row `flexShrink: 1`, so an overflowing set of chips scrolls inside the pane instead of stretching it. Verify with a shop that has a dozen categories: the product grid must not move.

- [ ] **Step 2: Confirm the two-row grid cap still holds**

`compactGridHeight` is `compactTileHeight * 2 + 8`, measured from the first rendered tile. The tile grew a second price line in Task 3, so re-measure on a device: exactly two rows must be visible, with the third clipped and reachable by scrolling.

- [ ] **Step 3: Keep the compact foot short**

The compact foot is one full-width button plus a single row holding **Hold** and "Served by" (already built in Task 4). Confirm on a phone that it is close to 110px, not 200px, and that four cart lines are visible above it.

- [ ] **Step 4: Commit**

```bash
git add "src/app/(admin)/(tabs)/pos.tsx"
git commit -m "fix(pos): a long category list scrolls instead of pushing the products off the phone"
```

---

### Task 10: Verify it on the three platforms

Nothing here is proven by Jest alone — the layout claims are all about height, scrolling and touch.

- [ ] **Step 1: Run the suite and the linter**

Run: `npm test`
Expected: PASS — 108 suites / 1567 tests, about 3 seconds.

Run: `npx eslint "src/app/(admin)/(tabs)/pos.tsx"`
Expected: the **same nine** `react-compiler` errors this file already has at
`8f6fd9b` (`Cannot access refs during render` around `pricedAtRef`, and two
`setState` calls inside effects). They are pre-existing and out of scope here;
the gate is that this work adds none. Count them before starting and after
finishing rather than trusting a clean exit code, which this file has not had
for some time.

- [ ] **Step 2: Drive the app**

Use the `/testing-kaiibi` skill for web, iOS and Android. On each, with a basket of at least six lines:

1. the total and the primary button do not move as the cart list scrolls;
2. the button reads `Take a payment`, then `Collect the remaining $X`, then `Charge $X · Cash`;
3. on a phone, `Checkout · $X` opens the sheet, and the sheet's charge button stays pinned while its blocks scroll;
4. a scan still lands in the cart from every path (wedge, camera, keypad);
5. holding a sale, force-quitting the app, reopening it, and resuming that sale returns the same basket;
6. completing a sale hands over to the receipt — on iOS, after the sheet has dismissed;
7. a long category list scrolls sideways without moving the grid.

- [ ] **Step 3: Commit any fixes**

```bash
git add -u
git commit -m "fix(pos): <what the device found>"
```

---

## Self-review

**Spec coverage.** Every element in the mockup that does not need the server has a task: inline blocks (6), phone sheet (6, 7), speaking button (1, 4, 7), fixed frames (4, 7), two-row cart line and discount chips (5), dual currency (2, 3), held orders (8), clear all and served-by (4), phone space fixes (9). Deferred items are listed in "Explicitly out of scope" with the reason each one needs a server change first.

**Deliberate omissions.** The category row's fade edge (needs `expo-linear-gradient`, not a dependency) and the cash note buttons (`$5 / $10 / $20 / $50`) — the notes are a nicety on top of an amount field that already works, and belong with the payment work in the next plan rather than as a bolt-on here.

**Type consistency.** `CheckoutIntent` is defined in Task 1 and consumed unchanged in Tasks 4, 6 and 7. `secondaryAmount` (Task 2) is consumed by `DualAmount` (Task 3) and by `checkoutIntent`'s `secondaryTotal` argument in Task 4. `HeldOrder` (Task 8) is the only new persisted shape and is not referenced by earlier tasks.
