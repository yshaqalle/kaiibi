# Uncosted products — design

**Date:** 2026-08-05
**Status:** Approved, ready for planning
**Scope:** Finding products with no purchase cost, and warning before creating
one. Inventory list filter, product form hint, save-time confirm.

## Problem

`Product.costCents` is nullable and optional in the form. Nothing asks for it,
nothing flags its absence, and a product saved without it silently drops out of
every profit calculation downstream.

The consequence is already visible and already named. `costOfGoodsSold()`
returns `uncostedItemCount` and `uncostedRevenueCents`, and the dashboard
renders a caveat from them:

> N sold items have no cost recorded ($X of revenue), so gross profit looks
> higher than it is. → **Set costs in Inventory**

That button pushes to a bare `/inventory`. It names the problem accurately and
then drops you into the full product list — 86 rows, no indication which of
them it meant. The diagnosis exists; the way to act on it does not.

Two gaps, at opposite ends of the same loop:

1. **After the fact** — no way to see which products lack a cost.
2. **At the moment of creation** — nothing checks that an empty cost field was
   intended rather than skipped.

## What this builds

1. A `No cost N` filter chip on Inventory, alongside `All` / `Low stock N` /
   `Has expiry`.
2. The dashboard caveat's action deep-linked to that filter.
3. An inline hint under the cost field when it is empty.
4. A confirm step when saving a product whose cost is blank.

## Decisions

### The chip is a `StockFilter` member, not a separate toggle

`StockFilter` becomes `'all' | 'low' | 'expiring' | 'nocost'`. The existing
chips are mutually exclusive and the filter runs before the search box narrows
within it (`inventory.tsx`, the `filtered` memo) — "no cost" wants exactly that
behaviour, so it joins the union rather than becoming an independent flag that
would need composing with the other three.

Predicate: `p.costCents === null`.

This makes `?filter=nocost` work through the existing deep-link path once the
param guard accepts the new value, which is what item 2 depends on.

### The chip always renders, with its count, even at zero

Matching `Low stock 0`, which is visible in the current UI.

The existing comment above that row argues the case for always rendering: a
narrowed list that looks like the whole list is worse than no link at all, so
someone arriving via deep link must be able to see the filter and get back out
of it. A chip that hid itself at zero could not do that, and could not report
the genuinely useful fact that the count *is* zero.

### `costCents === null`, not `=== 0` or falsy

A cost of zero is a real, recordable answer — a free sample, a gift with
purchase, a promotional unit. It is not the same as "nobody said". Only `null`
means unrecorded, which is the same distinction `costOfGoodsSold()` already
draws when it reports items as uncosted rather than counting them as zero.

The form preserves this: `costCents: costInput.trim() ? toCents(costInput) : null`
sends `null` only for an empty field.

### The confirm lives in `ProductForm.submit()`, not in the callers

`ProductForm` has three consumers — `product-modal.tsx`, `product/new.tsx` and
`product/[id].tsx` — all of which drive saving through the imperative
`submit()` handle. Putting the check in the form means one implementation and
no way for a fourth caller to miss it.

It fires early in `submit()`, before the image upload and the brand/category/tag
writes, so declining costs nothing and leaves nothing behind.

### The confirm fires on creation, and on clearing — not on every save

| Case | Confirm? |
|---|---|
| New product, cost blank | Yes |
| Edit, cost was set, now blank | Yes |
| Edit, cost was blank, still blank | No |
| Cost present | No |

Condition: `costInput.trim() === '' && (!initial || initial.costCents !== null)`.

The third row is the point. Someone opening an uncosted product to fix a typo
in its name is not making a decision about cost, and a dialog there would be
noise — the fastest way to teach people to dismiss a warning unread is to show
it when it does not apply. Clearing a cost that was previously set *is* a
decision about cost, so it is caught.

### Two different registers: a hint that informs, a dialog that asks

The inline hint is a `Caveat` with `tone="context"` under the cost/price row,
shown whenever the field is empty:

> No purchase cost means this product won't count toward profit or cost of
> goods.

No `action` prop — the fix is the field directly above it.

The tone choice follows the documentation in `ui/caveat.tsx`, which is explicit
that picking the wrong one is worse than not using the component: `'wrong'`
means a figure is incorrect until something is fixed and must carry an action;
`'context'` means here is why this looks surprising, no action implied. An empty
cost field mid-edit is not yet an error — the person may be about to type into
it — so `'context'` is correct. Using `'wrong'` here would train people to
ignore the whole family of caveats, including the accurate one on the dashboard.

The dialog then asks:

> **Save without a purchase cost?**
> Profit and cost of goods won't include this product.
> `[ Cancel ]  [ Save anyway ]`

### `confirmChoice()` added beside `confirmDestructive()`

`lib/confirm.ts` exports `confirmDestructive`, which is callback-based and
hardcodes `style: 'destructive'` — the red, weighted treatment.

Saving a product without a cost is not destructive. It is recoverable, it is
frequently the right answer, and styling it as though it were deletion
overstates it.

Add a sibling:

```ts
export function confirmChoice(title: string, message: string, confirmLabel: string): Promise<boolean>
```

Default button style, promise-returning. `submit()` is already `async`, so the
call site reads:

```ts
if (!(await confirmChoice(...))) { setSubmitting(false); return; }
```

`confirmDestructive` is left untouched — its callers are fine and its styling is
right for them. Both share the same web/native split: react-native-web's
`Alert.alert` is a no-op stub that never shows anything and never fires a
button's `onPress`, so web goes through `window.confirm`. The new function must
reproduce that, not assume `Alert` works.

## Out of scope

**CSV import.** `runProductsImport` can create uncosted products in bulk and
will not warn. A per-row confirm on a 500-row import is unusable, and the new
chip is how you would find them afterward. Revisit as a post-import summary line
if it proves to matter.

**Requiring cost.** Cost stays optional. Shops that genuinely do not track it —
services, consignment — should not be blocked, and a required field would be
answered with a junk value, which is worse than `null` because it is
indistinguishable from a real one.

**Backfilling existing products.** No migration. The chip surfaces them; setting
a cost is manual per product.

### Both predicates live in `lib/`, not inline in the components

This repo has no component test infrastructure — no `@testing-library/*` in
`devDependencies`, and no `.tsx` file under any `__tests__` directory. Every
test in the suite is a pure-logic test against a `src/lib/` module.

Logic written inline in `inventory.tsx` or `product-form.tsx` is therefore
untestable. Both decisions move to a new `src/lib/product-costing.ts`:

```ts
export function isUncosted(product: Pick<Product, 'costCents'>): boolean
export function needsCostConfirmation(costInput: string, initialCostCents: number | null | undefined): boolean
```

The components call these and hold only rendering. This is the same split the
codebase already uses — `sales-reporting.ts` owns `costOfGoodsSold()` and the
`uncosted*` counts while `dashboard.tsx` only renders them — so the new module
is a sibling of the code that first surfaced this problem, not a new pattern.

## Testing

Unit, in `src/lib/__tests__/`:

- `isUncosted`: `null` matches; `0` does not; a positive cost does not.
- `needsCostConfirmation`: all four rows of the table above.
- `confirmChoice`: resolves `true` on accept and `false` on cancel, on both the
  web and native branches.

Manual, because the rendering cannot be tested here:

- Chip shows its count, including at zero, and selecting it narrows the list.
- `/inventory?filter=nocost` opens with the chip already selected.
- Dashboard caveat's action lands on that filtered list.
- The hint appears when the cost field is empty and goes once it has a value.
- Saving blank-cost prompts on create; editing an already-uncosted product does
  not prompt.

Adding component-test tooling is out of scope — it is a suite-wide decision that
should not be made as a side effect of this feature.

## Files

| File | Change |
|---|---|
| `src/lib/product-costing.ts` | Create: `isUncosted`, `needsCostConfirmation` |
| `src/lib/confirm.ts` | Add `confirmChoice` |
| `src/app/(admin)/(tabs)/inventory.tsx` | `StockFilter` union, filter branch, `uncostedCount`, chip label, param guard |
| `src/app/(admin)/(tabs)/dashboard.tsx` | Caveat action → `/inventory?filter=nocost` |
| `src/components/product-form.tsx` | Inline `Caveat`, confirm in `submit()` |
