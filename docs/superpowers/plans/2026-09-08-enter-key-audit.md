# Enter Key Audit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the keyboard work started in #141/#142/#143 by giving every remaining multi-field form in the app a working return key, using one shared primitive instead of hand-wiring four props per field.

**Architecture:** PRs #142 and #143 wired nine forms by hand — four props and a ref on every field. That is where the one real bug crept in (a dep omitted on a conditionally-mounted row, caught only by re-reading the diff). This plan extracts that repetition into `useFieldChain`, a hook that takes an ordered list of field keys and returns the props for each, deriving "middle field hands focus on" and "last field submits" from list position rather than from a human marking each field correctly. Every remaining form then becomes one hook call plus one spread per field.

**Tech Stack:** React Native 0.86 / Expo SDK 57, TypeScript, Jest + react-test-renderer, `react-native-web` for the browser build.

## Global Constraints

- **Read the versioned Expo docs before writing code:** https://docs.expo.dev/versions/v57.0.0/ (per `AGENTS.md`).
- **`submitBehavior` is the current prop**, not `blurOnSubmit`. Its type is `'submit' | 'blurAndSubmit' | 'newline'` (`node_modules/react-native/Libraries/Components/TextInput/TextInput.d.ts:92`).
- **react-native-web reads `blurOnSubmit`, not `submitBehavior`.** On web the browser blurs the field on Enter regardless. This is harmless — focus has already moved by then — and is why the chain still works on web.
- **Never put `onSubmitEditing` on a `multiline` field.** Enter there must insert a newline. A multiline box may be the LAST entry in `keys` — so the field above can hand focus to it — but it takes only `ref` from the chain, never the other props, and a form that ends in one passes no `onSubmit`.
- **Any submit reachable by Enter must be wrapped in `useSingleFlight`** (`src/hooks/use-single-flight.ts`). A state flag cannot refuse a second press: a held return key repeats faster than React re-renders. This is not theoretical — a test caught it creating two accounts from one press on signup.
- **Lint and test baselines must not regress.** Current `main`: 245 suites / 4529 tests pass; `npm run lint` reports 179 problems (66 errors, 113 warnings), all pre-existing.
- **Do not restructure files beyond the change.** These are shipped screens; the diff should be readable as "this form learned the return key".

---

## Triage: the 51 files, and why the real number is smaller

`grep`-ing for `TextInput` without `onSubmitEditing` returns 51 files. They are not 51 units of work.

| Group | Count | Action |
|---|---|---|
| **A. Every field is `multiline`** | 7 | **Nothing.** Enter must insert a newline. |
| **B. Search box only** | 7 | `returnKeyType="search"` at most. Cosmetic — these filter as you type and RN already blurs on Enter. |
| **C. Real multi-field forms** | 30 | The work. Tasks 3–7. |
| **D. Single field above a button** | 7 | Enter presses the button, via a one-key chain. Folded into Tasks 6–7. |

**Group A — do not touch these files:**
`components/notes-field.tsx`, `components/taxonomy-edit-modal.tsx`, `components/accounting/ledger/close-period-view.tsx`, `components/pos/close-register-sheet.tsx`, `components/pos/open-register-sheet.tsx`, `components/support/support-thread-view.tsx`, `components/orders/order-detail.tsx`.

---

## File Structure

**Created:**
- `src/hooks/use-field-chain.ts` — the primitive. Owns the two rules and the multiline contract. No JSX, no screen knowledge.
- `src/hooks/__tests__/use-field-chain.test.tsx` — its unit tests.

**Modified:** one hook call plus one spread per field, per form. No structural change.

`useFieldChain` sits beside `use-single-flight.ts` and `use-wheel-pan.ts` — the three hooks that now carry the keyboard-and-mouse rules for the whole app.

---

### Task 1: The `useFieldChain` primitive

**Files:**
- Create: `src/hooks/use-field-chain.ts`
- Test: `src/hooks/__tests__/use-field-chain.test.tsx`

**Interfaces:**
- Consumes: nothing.
- Produces: `useFieldChain(keys: readonly string[], onSubmit?: () => void)` returning `{ props(key: string): FieldChainProps }` where
  `FieldChainProps = { ref: (node: TextInput | null) => void; returnKeyType: 'next' | 'go' | 'done'; submitBehavior: 'submit' | 'blurAndSubmit'; onSubmitEditing: () => void }`.

- [ ] **Step 1: Write the failing test**

Create `src/hooks/__tests__/use-field-chain.test.tsx`:

```tsx
// The two rules of the return key, in one place.
//
// A field in the MIDDLE of a form hands focus to the one under it and keeps the
// keyboard up (`submitBehavior: 'submit'`); the default drops it, and a keyboard
// that closes four times on the way down a form is worse than one that never
// opened. The LAST field presses the button beneath it and lets the keyboard
// fall, because what happens next is a screen change.
//
// Both rules are derived from POSITION IN THE LIST, not from a human marking
// each field — which is the whole point: PRs #142/#143 wired nine forms by hand
// and the one bug that survived review was a per-field detail nobody could see
// in a diff.

import { TextInput } from 'react-native';
import { act, create } from 'react-test-renderer';

import { useFieldChain } from '@/hooks/use-field-chain';

function harness(keys: readonly string[], onSubmit?: () => void) {
  const captured: { chain: ReturnType<typeof useFieldChain> | null } = { chain: null };
  function Harness() {
    captured.chain = useFieldChain(keys, onSubmit);
    return null;
  }
  act(() => {
    create(<Harness />);
  });
  return captured;
}

it('keeps the keyboard up on every field but the last', () => {
  const { chain } = harness(['name', 'phone', 'email']);
  expect(chain!.props('name').submitBehavior).toBe('submit');
  expect(chain!.props('phone').submitBehavior).toBe('submit');
  expect(chain!.props('email').submitBehavior).toBe('blurAndSubmit');
});

it('labels the return key by position', () => {
  const { chain } = harness(['name', 'phone', 'email'], () => {});
  expect(chain!.props('name').returnKeyType).toBe('next');
  expect(chain!.props('phone').returnKeyType).toBe('next');
  expect(chain!.props('email').returnKeyType).toBe('go');
});

it('says "done" on the last field when there is nothing to submit', () => {
  const { chain } = harness(['open', 'close']);
  expect(chain!.props('close').returnKeyType).toBe('done');
});

it('submits from the last field, and only the last', () => {
  const onSubmit = jest.fn();
  const { chain } = harness(['name', 'email'], onSubmit);

  act(() => chain!.props('name').onSubmitEditing());
  expect(onSubmit).not.toHaveBeenCalled();

  act(() => chain!.props('email').onSubmitEditing());
  expect(onSubmit).toHaveBeenCalledTimes(1);
});

it('moves focus to the next field', () => {
  const { chain } = harness(['name', 'email']);
  const focus = jest.fn();
  act(() => {
    chain!.props('email').ref({ focus } as unknown as TextInput);
  });

  act(() => chain!.props('name').onSubmitEditing());
  expect(focus).toHaveBeenCalledTimes(1);
});

it('does not throw when the next field has not mounted yet', () => {
  const { chain } = harness(['name', 'email']);
  // `email` never registered a ref — a step of a wizard not yet rendered.
  expect(() => act(() => chain!.props('name').onSubmitEditing())).not.toThrow();
});

it('treats an unknown key as the last field so a typo cannot silently break the chain', () => {
  const onSubmit = jest.fn();
  const { chain } = harness(['name'], onSubmit);
  expect(chain!.props('typo').returnKeyType).toBe('go');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest src/hooks/__tests__/use-field-chain.test.tsx`
Expected: FAIL — `Cannot find module '@/hooks/use-field-chain'`.

- [ ] **Step 3: Write the implementation**

Create `src/hooks/use-field-chain.ts`:

```ts
import { useCallback, useRef } from 'react';
import type { TextInput } from 'react-native';

// THE TWO RULES OF THE RETURN KEY, DERIVED FROM POSITION RATHER THAN DECLARED.
//
// PRs #142 and #143 taught nine forms to answer Enter by hand: four props and a
// ref on every field. That works and it shipped, but it puts the rules in the
// hands of whoever is typing, once per field -- and the one defect that survived
// code review in that work was exactly this kind of per-field detail, invisible
// in a diff and dead on the screen.
//
// Here the rules come from the ORDER OF THE LIST:
//
//   A MIDDLE FIELD hands focus to the one under it and keeps the keyboard up.
//   `submitBehavior: 'submit'` is what does that; the default for a single-line
//   field is to drop the keyboard, and a keyboard that closes four times on the
//   way down a form is worse than one that never opened.
//
//   THE LAST FIELD presses the button beneath it and lets the keyboard fall,
//   because what happens next is a screen change.
//
// A MULTILINE FIELD MAY END A CHAIN BUT NEVER CARRIES ITS PROPS. Enter in a
// notes box has to mean a new line. Put it LAST in `keys` so the field above can
// hand focus to it -- skipping past a box someone is about to type in would be
// the surprise -- attach ONLY its `ref`, never the other props, and pass no
// `onSubmit`. The chain then walks to the notes box and stops, which is what a
// form ending in free text should do: you finish it with the button.
//
// The submit itself must be wrapped in `useSingleFlight` (use-single-flight.ts).
// A state flag cannot refuse a second Enter: a held return key repeats faster
// than React re-renders.
export type FieldChainProps = {
  ref: (node: TextInput | null) => void;
  returnKeyType: 'next' | 'go' | 'done';
  submitBehavior: 'submit' | 'blurAndSubmit';
  onSubmitEditing: () => void;
};

export function useFieldChain(
  keys: readonly string[],
  onSubmit?: () => void,
): { props: (key: string) => FieldChainProps } {
  // A map rather than one ref per field: the caller names its fields, and the
  // set of names is fixed by `keys`, so there is nothing to allocate per render.
  const nodes = useRef(new Map<string, TextInput | null>());
  // The latest `onSubmit` closure, read at call time. Callers pass an inline
  // function that closes over form state; capturing it once would submit stale
  // values.
  const submitRef = useRef(onSubmit);
  submitRef.current = onSubmit;

  const props = useCallback(
    (key: string): FieldChainProps => {
      const index = keys.indexOf(key);
      // An unknown key is treated as the last field. A typo then submits rather
      // than focusing nothing, which is the failure that shows itself.
      const isLast = index === -1 || index === keys.length - 1;
      const next = isLast ? undefined : keys[index + 1];

      return {
        ref: (node: TextInput | null) => {
          nodes.current.set(key, node);
        },
        returnKeyType: isLast ? (submitRef.current ? 'go' : 'done') : 'next',
        submitBehavior: isLast ? 'blurAndSubmit' : 'submit',
        onSubmitEditing: () => {
          if (isLast) {
            submitRef.current?.();
            return;
          }
          // `?.` because a step of a wizard below this one may not have mounted.
          nodes.current.get(next as string)?.focus();
        },
      };
    },
    [keys],
  );

  return { props };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest src/hooks/__tests__/use-field-chain.test.tsx`
Expected: PASS — 7 tests.

- [ ] **Step 5: Typecheck and lint the new file**

Run: `npx tsc --noEmit && npx eslint src/hooks/use-field-chain.ts src/hooks/__tests__/use-field-chain.test.tsx`
Expected: no output from either.

- [ ] **Step 6: Commit**

```bash
git add src/hooks/use-field-chain.ts src/hooks/__tests__/use-field-chain.test.tsx
git commit -m "The two rules of the return key, derived rather than declared"
```

---

### Task 2: Prove the primitive on a form that already works

**Files:**
- Modify: `src/app/(public)/(tabs)/signup.tsx`
- Test: `src/__tests__/signup-enter-key.test.tsx` (exists — must keep passing **unchanged**)

**Why this task exists:** signup is the most intricate form already wired by hand — three steps, four fields in the first. Converting it to `useFieldChain` with its existing test suite untouched is the strongest available evidence that the primitive reproduces the hand-wired behaviour exactly. If the test needs editing to pass, the primitive is wrong, not the test.

**Interfaces:**
- Consumes: `useFieldChain` from Task 1.
- Produces: nothing new.

- [ ] **Step 1: Run the existing test and record the baseline**

Run: `npx jest src/__tests__/signup-enter-key.test.tsx`
Expected: PASS — 7 tests. **Do not modify this file at any point in this task.**

- [ ] **Step 2: Replace the hand-wiring with the chain**

In `src/app/(public)/(tabs)/signup.tsx`, delete the four field refs (`contactRef`, `emailRef`, `passwordRef`, `areaRef`) and add, next to `createAccount`:

```tsx
  // One chain per step: each step is its own form, and Enter on its last field
  // presses the one button under it (`next`), which either continues or creates
  // the shop. Keys are the field names in the order they appear.
  const stepOne = useFieldChain(['name', 'contact', 'email', 'password'], next);
  const stepTwo = useFieldChain(['shopName'], next);
  const stepThree = useFieldChain(['city', 'area'], next);
```

Import it beside the others:

```tsx
import { useFieldChain } from '@/hooks/use-field-chain';
```

- [ ] **Step 3: Spread the chain onto each field**

Change `Field` so it forwards arbitrary chain props instead of its own `onSubmitEditing`/`last` pair. Replace the component's prop type and body with:

```tsx
const Field = forwardRef<TextInput, {
  label: string;
  value: string;
  onChangeText: (text: string) => void;
  placeholder: string;
  keyboardType?: 'phone-pad' | 'email-address';
  autoCapitalize?: 'none';
  secureTextEntry?: boolean;
  chain?: Omit<FieldChainProps, 'ref'>;
}>(function Field({
  label, value, onChangeText, placeholder, keyboardType, autoCapitalize, secureTextEntry, chain,
}, ref) {
  return (
    <>
      <Text style={styles.fieldLabel}>{label.toUpperCase()}</Text>
      <TextInput
        ref={ref}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor="#999999"
        keyboardType={keyboardType}
        autoCapitalize={autoCapitalize}
        secureTextEntry={secureTextEntry}
        style={styles.input}
        {...chain}
      />
    </>
  );
});
```

Add the type import:

```tsx
import { useFieldChain, type FieldChainProps } from '@/hooks/use-field-chain';
```

Then each call site takes its chain props. Step one's four fields become:

```tsx
              <Field label={t('signup.yourName')} value={name} onChangeText={setName}
                placeholder={t('signup.yourNamePlaceholder')}
                ref={stepOne.props('name').ref} chain={stepOne.props('name')} />
              <Field label={t('signup.phone')} value={contact} onChangeText={setContact}
                placeholder={t('signup.phonePlaceholder')} keyboardType="phone-pad"
                ref={stepOne.props('contact').ref} chain={stepOne.props('contact')} />
              <Field label={t('signup.email')} value={email} onChangeText={setEmail}
                placeholder={t('signup.emailPlaceholder')} keyboardType="email-address" autoCapitalize="none"
                ref={stepOne.props('email').ref} chain={stepOne.props('email')} />
              <Field label={t('signup.password')} value={password} onChangeText={setPassword}
                placeholder={t('signup.passwordPlaceholder')} secureTextEntry
                ref={stepOne.props('password').ref} chain={stepOne.props('password')} />
```

Step two:

```tsx
              <Field label={t('signup.shopName')} value={shopName} onChangeText={setShopName}
                placeholder={t('signup.shopNamePlaceholder')}
                ref={stepTwo.props('shopName').ref} chain={stepTwo.props('shopName')} />
```

Step three:

```tsx
              <Field label={t('signup.city')} value={location} onChangeText={setLocation}
                placeholder={t('signup.cityPlaceholder')}
                ref={stepThree.props('city').ref} chain={stepThree.props('city')} />
              <Field label={t('signup.neighborhood')} value={area} onChangeText={setArea}
                placeholder={t('signup.neighborhoodPlaceholder')}
                ref={stepThree.props('area').ref} chain={stepThree.props('area')} />
```

- [ ] **Step 4: Run the untouched signup test**

Run: `npx jest src/__tests__/signup-enter-key.test.tsx`
Expected: PASS — the same 7 tests, with no edits to the test file. If any fail, fix `use-field-chain.ts`, not the test.

- [ ] **Step 5: Full suite, typecheck, lint**

Run: `npx tsc --noEmit && npx jest && npm run lint 2>&1 | grep problems`
Expected: 246 suites pass (245 + the new hook suite); lint reports 66 errors, unchanged.

- [ ] **Step 6: Commit**

```bash
git add src/app/\(public\)/\(tabs\)/signup.tsx
git commit -m "Signup's chain comes from the list, and its test never moved"
```

---

### Task 3: The customer-facing forms

**Files:**
- Modify: `src/components/storefront/checkout-form.tsx` (4 fields)
- Modify: `src/components/storefront/editor/delivery-editor.tsx` (6 fields)
- Modify: `src/components/storefront/editor/flyer-editor.tsx` (3 fields)

**Why first:** the checkout form is the only form in this batch a *shopper* fills in, on their own phone, to place an order. A shopper who cannot tab through it is a lost sale in a way an internal form never is.

**Interfaces:**
- Consumes: `useFieldChain`.
- Produces: nothing new.

- [ ] **Step 1: Read each file and write down the field order**

Run: `grep -n "<TextInput" -A6 src/components/storefront/checkout-form.tsx`

Record, in render order, each field's state setter and whether it is `multiline`. **A multiline box goes last in `keys` and takes only `ref`; it never carries the other chain props.**

- [ ] **Step 2: Add the chain to `checkout-form.tsx`**

The real fields, in render order, are `name` (`:200`), `phone` (`:214`), `landmark` (`:307`) and `note` (`:327`, **multiline**).

**This form takes no `onSubmit`.** It has *two* buttons — `handleSubmit('direct')` at `:367` and `handleSubmit('whatsapp')` at `:386` — and Enter must not choose between placing an order and opening WhatsApp on the shopper's behalf. The chain walks to the notes box and stops; the shopper picks the button they meant.

Add the import and, beside the component's other hooks:

```tsx
import { useFieldChain } from '@/hooks/use-field-chain';
```

```tsx
// `note` is last and multiline: it ends the chain by receiving focus, and takes
// only `ref` below. No `onSubmit` — see above.
const CHECKOUT_FIELD_KEYS = ['name', 'phone', 'landmark', 'note'] as const;
```

```tsx
  const chain = useFieldChain(CHECKOUT_FIELD_KEYS);
```

Spread the full props onto the three single-line fields:

```tsx
<TextInput value={name} onChangeText={setName} {...chain.props('name')} … />
<TextInput value={phone} onChangeText={setPhone} {...chain.props('phone')} … />
<TextInput value={landmark} onChangeText={setLandmark} {...chain.props('landmark')} … />
```

and **only the ref** onto the notes box:

```tsx
<TextInput value={note} onChangeText={setNote} multiline ref={chain.props('note').ref} … />
```

- [ ] **Step 3: Single-flight both submit paths**

Run: `grep -n "useSingleFlight" src/components/storefront/checkout-form.tsx`

Enter does not reach these two buttons, but a shopper on a slow connection double-taps them, and a duplicated order is the worst duplicate in the app. If absent, wrap the handler:

```tsx
const handleSubmit = useSingleFlight(async (mode: 'direct' | 'whatsapp') => { /* existing body, unchanged */ });
```

with `import { useSingleFlight } from '@/hooks/use-single-flight';`

- [ ] **Step 4: Repeat Steps 1–3 for `delivery-editor.tsx` and `flyer-editor.tsx`**

Same transform, each file's own ordered key list.

- [ ] **Step 5: Verify**

Run: `npx tsc --noEmit && npx jest && npm run lint 2>&1 | grep problems`
Expected: all suites pass; lint errors still 66.

- [ ] **Step 6: Verify in the browser**

Start the dev server (`npx expo start --web --port 8090`), open the shop's checkout, and walk the form with the return key alone. Expected: focus steps field to field; Enter on the last field submits once.

- [ ] **Step 7: Commit**

```bash
git add src/components/storefront/
git commit -m "The order form a shopper fills answers their return key"
```

---

### Task 4: The catalogue forms

**Files:**
- Modify: `src/components/product-form.tsx` (15 fields — the largest form in the app)
- Modify: `src/components/customer-form.tsx` (10 fields)

- [ ] **Step 1: Map `product-form.tsx`'s fields in render order**

Run: `grep -n "<TextInput" -A8 src/components/product-form.tsx`

Note which are `multiline` (the description) — those stay out of `keys`. Note that this file already imports `useWheelPan`; add `useFieldChain` beside it.

- [ ] **Step 2: Declare the key list and the chain**

```tsx
const PRODUCT_FIELD_KEYS = ['name', 'brand', 'sku', 'barcode', 'cost', 'price', 'stock', 'reorder', 'shelf'] as const;
```

```tsx
  const chain = useFieldChain(PRODUCT_FIELD_KEYS, save);
```

- [ ] **Step 3: Spread onto each non-multiline field**

```tsx
<TextInput value={name} onChangeText={setName} {...chain.props('name')} … />
```

- [ ] **Step 4: Confirm the save is single-flighted**

Run: `grep -n "useSingleFlight" src/components/product-form.tsx`
If absent, wrap the save handler as in Task 3 Step 3. A product saved twice is a duplicate row a shopkeeper has to find and delete.

- [ ] **Step 5: Repeat for `customer-form.tsx`**

- [ ] **Step 6: Verify**

Run: `npx tsc --noEmit && npx jest && npm run lint 2>&1 | grep problems`

- [ ] **Step 7: Commit**

```bash
git add src/components/product-form.tsx src/components/customer-form.tsx
git commit -m "The two longest forms in the app take the return key"
```

---

### Task 5: The accounting forms

**Files:**
- Modify: `src/components/accounting/invoice-editor-modal.tsx` (4)
- Modify: `src/components/accounting/ledger/fixed-assets-view.tsx` (4)
- Modify: `src/components/accounting/ledger/journal-entry-view.tsx` (3)
- Modify: `src/components/accounting/cash-budgets-tab.tsx` (5)
- Modify: `src/components/accounting/record-payment-modal.tsx` (2)
- Modify: `src/components/accounting/recurring-bill-modal.tsx` (2)
- Modify: `src/components/accounting/transfer-funds-modal.tsx` (2)
- Modify: `src/components/accounting/expense-editor-modal.tsx` (2, one multiline)

- [ ] **Step 1: For each file, map the field order and exclude multiline fields**

Run for each: `grep -n "<TextInput" -A8 <file>`

- [ ] **Step 2: Apply the transform from Task 3 Step 2 to each file**

One `useFieldChain` call per form, one spread per field.

- [ ] **Step 3: Single-flight every submit these chains now reach**

Run: `grep -Ln "useSingleFlight" src/components/accounting/invoice-editor-modal.tsx src/components/accounting/ledger/fixed-assets-view.tsx src/components/accounting/ledger/journal-entry-view.tsx src/components/accounting/cash-budgets-tab.tsx src/components/accounting/record-payment-modal.tsx src/components/accounting/recurring-bill-modal.tsx src/components/accounting/transfer-funds-modal.tsx src/components/accounting/expense-editor-modal.tsx`

Every file listed by that command needs its submit wrapped. **Accounting writes are the least forgiving place in the app for a double-submit** — a duplicated journal entry or payment is a reconciliation problem, not a UI annoyance.

- [ ] **Step 4: Verify**

Run: `npx tsc --noEmit && npx jest && npm run lint 2>&1 | grep problems`

- [ ] **Step 5: Commit**

```bash
git add src/components/accounting/
git commit -m "Accounting's forms answer Enter, and refuse it twice"
```

---

### Task 6: The people forms

**Files:**
- Modify: `src/components/team-add-modal.tsx` (4)
- Modify: `src/components/team-member-edit-modal.tsx` (3)
- Modify: `src/components/schedule/shift-editor-modal.tsx` (5)
- Modify: `src/components/schedule/bulk-shift-modal.tsx` (5)
- Modify: `src/components/edit-pay-modal.tsx` (1)
- Modify: `src/components/staff-self-service.tsx` (2)
- Modify: `src/components/pay-fields.tsx` (1)

- [ ] **Step 1: Map each file's field order**

- [ ] **Step 2: Apply the transform**

For the single-field files (`edit-pay-modal`, `pay-fields`), the chain has one key, so that field is the last: `returnKeyType: 'go'` and Enter presses the button.

- [ ] **Step 3: Single-flight every submit**

Run: `grep -Ln "useSingleFlight" src/components/team-add-modal.tsx src/components/team-member-edit-modal.tsx src/components/schedule/shift-editor-modal.tsx src/components/schedule/bulk-shift-modal.tsx src/components/edit-pay-modal.tsx src/components/staff-self-service.tsx src/components/pay-fields.tsx`

- [ ] **Step 4: Verify and commit**

```bash
npx tsc --noEmit && npx jest && npm run lint 2>&1 | grep problems
git add src/components/team-add-modal.tsx src/components/team-member-edit-modal.tsx src/components/schedule/ src/components/edit-pay-modal.tsx src/components/staff-self-service.tsx src/components/pay-fields.tsx
git commit -m "Adding a person, and paying them, take the return key"
```

---

### Task 7: The remaining pickers, modals and single-field forms

**Files:**
- Modify: `src/components/customer-picker.tsx` (5 — the search box stays out of the chain)
- Modify: `src/components/vendor-picker.tsx` (5 — same)
- Modify: `src/components/payment-method-picker.tsx` (3)
- Modify: `src/components/stock-count-modal.tsx` (3)
- Modify: `src/components/stock-restock-modal.tsx` (3)
- Modify: `src/components/stock-transfer-modal.tsx` (1)
- Modify: `src/components/marketing/campaign-composer.tsx` (3, two multiline)
- Modify: `src/components/marketing/promotions-tab.tsx` (2)
- Modify: `src/components/marketing/poster-sheet.tsx` (1)
- Modify: `src/components/support/support-compose.tsx` (3, one multiline)
- Modify: `src/components/platform/support-tab.tsx` (4, two multiline)
- Modify: `src/components/platform/kit.tsx` (1)
- Modify: `src/components/checkout-panel.tsx` (1)
- Modify: `src/components/color-picker.tsx` (1)
- Modify: `src/components/accounting/payroll-run-editor.tsx` (1)
- Modify: `src/components/taxonomy-manage-modal.tsx` (1)

- [ ] **Step 1: For the two pickers, keep the search field out of the chain**

A picker's search box filters as you type. It is not a step on the way to a submit, so it takes `returnKeyType="search"` and nothing else:

```tsx
<TextInput value={query} onChangeText={setQuery} returnKeyType="search" … />
```

The picker's *other* fields (the inline "add new" form) are the chain.

- [ ] **Step 2: Apply the transform to the rest**

- [ ] **Step 3: Single-flight every submit reached by a chain**

- [ ] **Step 4: Verify and commit**

```bash
npx tsc --noEmit && npx jest && npm run lint 2>&1 | grep problems
git add src/components/
git commit -m "The last of the forms, and the pickers that only ever wanted a search key"
```

---

### Task 8: Label the search keys

**Files:**
- Modify: `src/app/store/index.tsx` — already has `returnKeyType="search"`; **verify only, change nothing**
- Modify: `src/components/dashboard/global-search.tsx`
- Modify: `src/components/accounting/transactions-tab.tsx`
- Modify: `src/components/storefront/theme-shared.tsx` — already has it; verify only

**These are not bugs.** They filter as you type, and React Native already blurs on Enter, so the keyboard closes and there is nothing else for the key to do. `returnKeyType="search"` only changes the key's label on a phone keyboard.

- [ ] **Step 1: Add the prop where it is missing**

```tsx
<TextInput value={query} onChangeText={setQuery} returnKeyType="search" … />
```

- [ ] **Step 2: Verify and commit**

```bash
npx tsc --noEmit && npx jest
git add src/components/dashboard/global-search.tsx src/components/accounting/transactions-tab.tsx
git commit -m "Name the return key on the search boxes that already behaved"
```

---

### Task 9: Verify sign-in on a device

**Files:** none — this is the verification the earlier work could not reach.

**Why it is still open:** login and signup both need a *signed-out* session, and the Expo dev-launcher's floating gear button sits over the app's own menu control, so every attempt to reach Sign out opened the dev menu instead.

- [ ] **Step 1: Take port 8081**

A simulator build has no embedded bundle and fetches JS from port 8081 at runtime — no flag changes this.

```bash
lsof -tiTCP:8081 -sTCP:LISTEN | xargs -r ps -o pid,command -p
```

Confirm which checkout is being served before stopping anything, then serve this branch from 8081:

```bash
npx expo start --port 8081
```

- [ ] **Step 2: Sign out without touching the dev-launcher gear**

The gear overlays the top-right ☰. Reach Settings by deep link instead, which bypasses it:

```bash
xcrun simctl openurl <udid> "kaiibi://settings?nav=profile"
```

- [ ] **Step 3: Drive the login form with Maestro**

```yaml
appId: com.kaiibisteam.kaiibi
---
- assertVisible: "you@example.com"
- tapOn: "you@example.com"
- inputText: "yusef@gmail.com"
- pressKey: Enter
- inputText: "yusef1"
- pressKey: Enter
- assertVisible: "Dashboard"
```

Run: `maestro --device <udid> test login.yaml`
Expected: PASS. **If it fails, read the step screenshot under `~/.maestro/tests/` before concluding anything** — `assertVisible` demands 100% visibility and fails on an element merely clipped by a dock.

- [ ] **Step 4: Confirm the keyboard survived the first Enter**

Screenshot after the first `pressKey`:

```bash
xcrun simctl io <udid> screenshot /tmp/login-after-enter.png
```

Expected: the caret is in the password field **and the keyboard is still on screen**. That is `submitBehavior="submit"`, and it is the one behaviour no browser run can confirm.

- [ ] **Step 5: Record the result in the PR or an issue**

Pass or fail, with the screenshot. Do not round "not exercised" up to "pass".

---

## Not in this plan

**The iPad POS category row clips after about two chips.** The browse pane gets much less width than the cart. This is a *layout* problem, not a keyboard one, and this project's convention is that UI work starts with an HTML mockup in `docs/design/` rather than an implementation plan — so it needs a mockup of the reshaped POS pane before any task list is worth writing. It is also **pre-existing**, not introduced by #141–#143.

**The dev server on :8081.** Housekeeping, not a project: stop it, or point it at whichever branch you want, in one command.

---

## Self-Review

**Spec coverage:**
- 51 unaudited files → Tasks 3–8, with the 7 all-multiline files explicitly excluded and the reason given.
- iPad clipping → deliberately deferred to a mockup, with the reason.
- Device sign-in → Task 9.
- Dev server → named as housekeeping, not a task.

**Placeholder scan:** No "TBD"/"handle edge cases"/"write tests for the above". Tasks 3–8 instruct reading each file's own field order because that order *is* the per-file specification and is visible in the file; the transform itself is shown in full at Task 3 Step 2 and the key-list shape at Task 4 Step 2.

**Type consistency:** `FieldChainProps` is defined once in Task 1 and imported by name in Task 2. `useFieldChain(keys, onSubmit)` has the same signature at every call site. `useSingleFlight` matches the shipped signature in `src/hooks/use-single-flight.ts`.

**Corrected during review:** Task 3's key list was written from memory as
`['name','phone','address','note']` with a single `submit`. Reading the file
showed the third field is `landmark`, not `address`, and that the form has TWO
submit buttons — so it takes no `onSubmit` at all. Every other task instructs
reading the field order from the file for exactly this reason.

**Known risk:** Task 1's `props()` is called during render and returns a fresh object each time, so a field gets a new `ref` callback identity on every render. React will call the old callback with `null` and the new one with the node — the map ends up correct because the set happens after the clear, but if a future change makes `props()` memoised per key, re-verify Task 1's focus test still passes.
