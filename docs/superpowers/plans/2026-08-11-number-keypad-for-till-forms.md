# Number Keypad for Till Forms (3a) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A till with a barcode scanner attached can type into the app's money and count fields — drawer counts, price, cost, stock, reorder level — on a device where the OS refuses to show a keyboard.

**Architecture:** A HID scanner is a keyboard to the OS, so both Android and iOS suppress the on-screen keyboard while one is attached. The app already answers this for the search box by drawing its own keypad and never letting the field take OS focus (`SearchRow` + `SearchKeypad`). This plan generalises that to numeric form fields: a pure key-application module, a context host that owns which field is being driven and renders the dock at the modal's bottom edge, and a `NumberField` that is a drop-in for the `TextInput`s already at those sites — rendering a real `TextInput` when no keypad is needed and a focus-free `Pressable` when one is.

**Tech Stack:** Expo SDK 57, React Native 0.86, expo-router, Jest via `jest-expo`, `react-test-renderer`.

## Global Constraints

- **Read the versioned Expo docs** at https://docs.expo.dev/versions/v57.0.0/ before writing code that touches an Expo API. Repo-wide rule from `AGENTS.md`.
- **Never hardcode a hex colour.** Every colour comes from `Colors.light` in `src/constants/theme.ts`.
- **Every file pins `const theme = Colors.light;`** — the app has no dark mode yet.
- **Never import `Modal` from `react-native`.** Use `AppModal` from `@/components/ui/app-modal`; `eslint.config.js` enforces it.
- **The keypad is never on by default.** Every branch in this plan is gated on `useScannerSettings().onScreenKeypad`, which is `hardwareSetting && keyboardAttached === true`. A wrong `true` takes typing away from someone who had it — see `resolveScannerSettings` in `src/lib/scanner-settings.ts`.
- **A keypad-driven field must never take OS focus.** Focus is what `WedgeSink` needs to catch scans; a field that takes it stops the scanner. This is the single rule the whole design exists to keep.
- **Pure logic lives in `src/lib/*.ts`** with tests in `src/lib/__tests__/*.test.ts`. Component tests live in `src/components/__tests__/*.test.tsx`.
- **Run `npx tsc --noEmit` and `npm test` before every commit.**
- **Commit after every task. Do not push** — `tablet-login-fix` is a shared branch with other sessions committing to it.

## File Structure

| Path | Responsibility |
|---|---|
| `src/lib/number-keypad.ts` | Pure: every edit a number keypad can make to a string, including the money rules (one decimal point, at most two decimals). No imports. |
| `src/components/ui/keypad-host.tsx` | The context. Owns which field is being driven, keeps a live registry of the fields, and renders the dock at the bottom of whatever it wraps. |
| `src/components/ui/number-keypad.tsx` | The dock itself: digits, point, backspace, Done. Presentational — holds no text. |
| `src/components/ui/number-field.tsx` | Drop-in for a numeric `TextInput`. Real `TextInput` when the keypad is off; focus-free `Pressable` when it is on. |
| `src/components/pos/drawer-count.tsx` | Modified: its four numeric `TextInput`s become `NumberField`s. |
| `src/components/product-form.tsx` | Modified: price, cost, stock and reorder level become `NumberField`s. |
| `src/components/pos/close-register-sheet.tsx`, `open-register-sheet.tsx`, `src/components/product-modal.tsx` | Modified: wrap their content in `KeypadHost` so the dock has somewhere to render. |

---

### Task 1: The pure key rules

**Files:**
- Create: `src/lib/number-keypad.ts`
- Test: `src/lib/__tests__/number-keypad.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `type NumberKeypadKey`, `type NumberFieldMode = 'integer' | 'decimal'`, `applyNumberKey(text: string, key: NumberKeypadKey, mode: NumberFieldMode): string`.

- [ ] **Step 1: Write the failing test**

Create `src/lib/__tests__/number-keypad.test.ts`:

```ts
import { applyNumberKey } from '@/lib/number-keypad';

describe('applyNumberKey, decimal (money)', () => {
  const decimal = 'decimal' as const;

  it('appends a digit', () => {
    expect(applyNumberKey('12', { type: 'digit', value: '4' }, decimal)).toBe('124');
  });

  // A drawer count is typed over a placeholder zero often enough that "0" then
  // "5" meaning five, not "05", is the only reading that does not surprise.
  it('replaces a lone zero rather than growing it', () => {
    expect(applyNumberKey('0', { type: 'digit', value: '5' }, decimal)).toBe('5');
  });

  it('keeps a zero that is already part of a longer number', () => {
    expect(applyNumberKey('10', { type: 'digit', value: '5' }, decimal)).toBe('105');
  });

  it('starts a decimal from nothing with its leading zero', () => {
    expect(applyNumberKey('', { type: 'point' }, decimal)).toBe('0.');
  });

  it('adds a point once and only once', () => {
    expect(applyNumberKey('12', { type: 'point' }, decimal)).toBe('12.');
    expect(applyNumberKey('12.5', { type: 'point' }, decimal)).toBe('12.5');
  });

  // Money has two decimals. A third digit is a mis-key, and accepting it turns
  // a drawer count into a figure that cannot be reconciled.
  it('refuses a third decimal place', () => {
    expect(applyNumberKey('12.34', { type: 'digit', value: '5' }, decimal)).toBe('12.34');
  });

  it('deletes the last character', () => {
    expect(applyNumberKey('12.3', { type: 'delete' }, decimal)).toBe('12.');
    expect(applyNumberKey('', { type: 'delete' }, decimal)).toBe('');
  });

  it('clears everything', () => {
    expect(applyNumberKey('12.34', { type: 'clear' }, decimal)).toBe('');
  });
});

describe('applyNumberKey, integer (counts)', () => {
  const integer = 'integer' as const;

  // Three and a half notes is not a thing anyone counted.
  it('refuses a decimal point entirely', () => {
    expect(applyNumberKey('12', { type: 'point' }, integer)).toBe('12');
  });

  it('still appends digits and deletes', () => {
    expect(applyNumberKey('12', { type: 'digit', value: '0' }, integer)).toBe('120');
    expect(applyNumberKey('12', { type: 'delete' }, integer)).toBe('1');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx jest src/lib/__tests__/number-keypad.test.ts`
Expected: FAIL — `Cannot find module '@/lib/number-keypad'`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/number-keypad.ts`:

```ts
// Every edit the number keypad can make, as a pure function of the text.
//
// Separate from the component for the same reason `applyKey` in lib/keypad.ts
// is: the behaviour is tested without rendering anything, and the form's own
// state stays the one place the text lives. The keypad holds none of its own.

export type NumberKeypadKey =
  | { type: 'digit'; value: string }
  | { type: 'point' }
  | { type: 'delete' }
  | { type: 'clear' };

/**
 * `decimal` is money — a point and at most two places after it.
 * `integer` is a count of things: notes in a drawer, units in stock.
 */
export type NumberFieldMode = 'integer' | 'decimal';

// Money, to the cent. A third decimal place is always a mis-key: no shop
// counts a third of a cent, and letting one through produces a drawer figure
// that cannot be reconciled against the till.
const MAX_DECIMALS = 2;

export function applyNumberKey(text: string, key: NumberKeypadKey, mode: NumberFieldMode): string {
  switch (key.type) {
    case 'digit': {
      const [, fraction] = text.split('.');
      if (fraction != null && fraction.length >= MAX_DECIMALS) return text;
      // A field showing its own zero is a field nobody has typed into yet.
      if (text === '0') return key.value;
      return text + key.value;
    }
    case 'point':
      if (mode === 'integer') return text;
      if (text.includes('.')) return text;
      // Never a bare leading point: `Number('.5')` is 0.5, but `toCents('.5')`
      // and every human reading the field do better with the zero written.
      return text === '' ? '0.' : `${text}.`;
    case 'delete':
      return text.slice(0, -1);
    case 'clear':
      return '';
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `npx jest src/lib/__tests__/number-keypad.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/number-keypad.ts src/lib/__tests__/number-keypad.test.ts
git commit -m "feat(keypad): the number keypad's edits, as pure rules"
```

---

### Task 2: The host that owns which field is being driven

**Files:**
- Create: `src/components/ui/keypad-host.tsx`
- Test: `src/components/__tests__/keypad-host.test.tsx`

**Interfaces:**
- Consumes: `applyNumberKey`, `NumberFieldMode`, `NumberKeypadKey` from Task 1.
- Produces:
  - `<KeypadHost>{children}</KeypadHost>` — provider; renders `children` then the dock beneath them.
  - `useKeypadSlot(args: { id: string; value: string; mode: NumberFieldMode; onChange: (next: string) => void; label?: string }): { active: boolean; open: () => void }` — returns `active: false` and a no-op `open` when there is no host above it.

The registry is a ref refreshed on every render, so the dock always applies a key to the text the form is showing *now*. Storing a copy in host state instead would give two sources of truth for one number, which on a drawer count is a reconciliation bug waiting to happen.

- [ ] **Step 1: Write the failing test**

Create `src/components/__tests__/keypad-host.test.tsx`:

```tsx
import { useState } from 'react';
import { Pressable, Text } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { KeypadHost, useKeypadSlot } from '@/components/ui/keypad-host';

function Field({ id, initial = '' }: { id: string; initial?: string }) {
  const [value, setValue] = useState(initial);
  const slot = useKeypadSlot({ id, value, mode: 'decimal', onChange: setValue, label: id });
  return (
    <Pressable onPress={slot.open} accessibilityLabel={`field-${id}`}>
      <Text>{`${id}:${value}${slot.active ? ':active' : ''}`}</Text>
    </Pressable>
  );
}

function render(ui: React.ReactElement) {
  let tree: ReactTestRenderer | undefined;
  act(() => { tree = create(ui); });
  return tree!;
}

function press(tree: ReactTestRenderer, label: string) {
  const node = tree.root.find(
    (n) => n.props?.accessibilityLabel === label && typeof n.props?.onPress === 'function'
  );
  act(() => { node.props.onPress(); });
}

function texts(tree: ReactTestRenderer): string[] {
  return tree.root.findAllByType(Text).map((t) => String(t.props.children));
}

describe('KeypadHost', () => {
  it('shows no dock until a field asks for one', () => {
    const tree = render(<KeypadHost><Field id="a" /></KeypadHost>);
    expect(texts(tree)).not.toContain('Done');
  });

  it('opens the dock for the field that was pressed', () => {
    const tree = render(<KeypadHost><Field id="a" /><Field id="b" /></KeypadHost>);
    press(tree, 'field-a');
    expect(texts(tree)).toContain('Done');
    expect(texts(tree)).toContain('a::active');
  });

  it('drives the pressed field, and only that one', () => {
    const tree = render(<KeypadHost><Field id="a" /><Field id="b" /></KeypadHost>);
    press(tree, 'field-a');
    press(tree, 'key-7');
    expect(texts(tree)).toContain('a:7:active');
    expect(texts(tree)).toContain('b:');
  });

  it('applies each key to the text the field is showing now', () => {
    const tree = render(<KeypadHost><Field id="a" /></KeypadHost>);
    press(tree, 'field-a');
    press(tree, 'key-1');
    press(tree, 'key-2');
    press(tree, 'key-point');
    press(tree, 'key-5');
    expect(texts(tree)).toContain('a:12.5:active');
  });

  it('moves to the field pressed next, leaving the first one alone', () => {
    const tree = render(<KeypadHost><Field id="a" initial="9" /><Field id="b" /></KeypadHost>);
    press(tree, 'field-a');
    press(tree, 'field-b');
    press(tree, 'key-3');
    expect(texts(tree)).toContain('a:9');
    expect(texts(tree)).toContain('b:3:active');
  });

  it('closes on Done', () => {
    const tree = render(<KeypadHost><Field id="a" /></KeypadHost>);
    press(tree, 'field-a');
    press(tree, 'key-done');
    expect(texts(tree)).not.toContain('Done');
    expect(texts(tree)).toContain('a:');
  });

  // A field rendered outside any host must not crash the screen it is on --
  // the same component is used on forms that never open a keypad.
  it('is inert with no host above it', () => {
    const tree = render(<Field id="lonely" />);
    press(tree, 'field-lonely');
    expect(texts(tree)).toEqual(['lonely:']);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx jest src/components/__tests__/keypad-host.test.tsx`
Expected: FAIL — `Cannot find module '@/components/ui/keypad-host'`.

- [ ] **Step 3: Write the implementation**

Create `src/components/ui/keypad-host.tsx`:

```tsx
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { NumberKeypad } from '@/components/ui/number-keypad';
import { applyNumberKey, type NumberFieldMode, type NumberKeypadKey } from '@/lib/number-keypad';

// Which field the app's own keypad is currently typing into.
//
// It has to be app state rather than OS focus, and that is the whole point: a
// focused TextInput takes the keyboard away from `WedgeSink`, and the sink is
// what catches scans. So a keypad-driven field never focuses -- the app
// remembers which one is being driven instead, and the dock edits it from a
// distance.
type Slot = {
  value: string;
  mode: NumberFieldMode;
  onChange: (next: string) => void;
  label?: string;
};

type HostValue = {
  activeId: string | null;
  register: (id: string, slot: Slot) => void;
  unregister: (id: string) => void;
  open: (id: string) => void;
};

const KeypadContext = createContext<HostValue | null>(null);

export function KeypadHost({ children }: { children: React.ReactNode }) {
  const [activeId, setActiveId] = useState<string | null>(null);
  // A ref, not state: every field rewrites its entry on every render, and
  // putting that in state would re-render the whole form on each keystroke to
  // deliver a value the form already has.
  const slots = useRef<Record<string, Slot>>({});

  const register = useCallback((id: string, slot: Slot) => { slots.current[id] = slot; }, []);
  const unregister = useCallback((id: string) => {
    delete slots.current[id];
    // A field that unmounts while being driven takes the dock with it, rather
    // than leaving keys pointed at nothing.
    setActiveId((current) => (current === id ? null : current));
  }, []);
  const open = useCallback((id: string) => setActiveId(id), []);

  const value = useMemo(() => ({ activeId, register, unregister, open }), [activeId, register, unregister, open]);

  const active = activeId ? slots.current[activeId] : undefined;

  return (
    <KeypadContext.Provider value={value}>
      <View style={styles.fill}>{children}</View>
      {active ? (
        <NumberKeypad
          label={active.label}
          mode={active.mode}
          onKey={(key: NumberKeypadKey) => {
            // Read the value at press time, not at open time: the form owns the
            // text, and a copy taken when the dock opened would be stale the
            // moment anything else edited it.
            const slot = activeId ? slots.current[activeId] : undefined;
            if (!slot) return;
            slot.onChange(applyNumberKey(slot.value, key, slot.mode));
          }}
          onDone={() => setActiveId(null)}
        />
      ) : null}
    </KeypadContext.Provider>
  );
}

/**
 * Registers one field with the host above it, and reports whether the keypad
 * is currently pointed at this field.
 *
 * Returns `active: false` and a no-op `open` where there is no host -- the same
 * field component is used on forms that never open a keypad, and it must not
 * care which kind of form it landed on.
 */
export function useKeypadSlot({
  id,
  value,
  mode,
  onChange,
  label,
}: {
  id: string;
  value: string;
  mode: NumberFieldMode;
  onChange: (next: string) => void;
  label?: string;
}): { active: boolean; open: () => void } {
  const host = useContext(KeypadContext);

  // Deliberately no dependency array. The entry has to hold this render's
  // `value` and this render's `onChange` closure; a dependency list would let
  // the dock apply a key to a number one render out of date.
  useEffect(() => {
    if (!host) return;
    host.register(id, { value, mode, onChange, label });
  });

  useEffect(() => {
    if (!host) return;
    return () => host.unregister(id);
  }, [host, id]);

  const open = useCallback(() => host?.open(id), [host, id]);
  return { active: host?.activeId === id, open };
}

const styles = StyleSheet.create({
  // The dock is a flex sibling of the content rather than an overlay, so a
  // form shrinks to make room for it instead of typing underneath it.
  fill: { flex: 1 },
});
```

- [ ] **Step 4: Run the tests**

Run: `npx jest src/components/__tests__/keypad-host.test.tsx`
Expected: FAIL — `Cannot find module '@/components/ui/number-keypad'`. That module is Task 3; the two are one deliverable, so continue to Task 3 before committing.

- [ ] **Step 5: Commit (after Task 3 passes)**

Held until Task 3 — see Task 3, Step 5.

---

### Task 3: The dock

**Files:**
- Create: `src/components/ui/number-keypad.tsx`

**Interfaces:**
- Consumes: `NumberFieldMode`, `NumberKeypadKey` from Task 1.
- Produces: `<NumberKeypad label?: string mode: NumberFieldMode onKey: (key: NumberKeypadKey) => void onDone: () => void />`. Every key carries `accessibilityLabel`: `key-0`…`key-9`, `key-point`, `key-delete`, `key-clear`, `key-done`. Task 2's tests press those labels.

- [ ] **Step 1: Write the implementation**

Create `src/components/ui/number-keypad.tsx`:

```tsx
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Colors } from '@/constants/theme';
import type { NumberFieldMode, NumberKeypadKey } from '@/lib/number-keypad';

const theme = Colors.light;

const DIGITS = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];

// The money and count keypad, and only that.
//
// Sibling of `SearchKeypad`, not a variant of it: that one is a search box's
// keyboard with letters and no meaning attached to what is typed. This is a
// number's, where the field's own type decides whether a decimal point is even
// a key. Keeping them apart is what stops either growing into a general
// keyboard, which `SearchKeypad`'s own note rules out.
export function NumberKeypad({
  label,
  mode,
  onKey,
  onDone,
}: {
  /** The field being driven. A dock with no caret of its own must say what it is aimed at. */
  label?: string;
  mode: NumberFieldMode;
  onKey: (key: NumberKeypadKey) => void;
  onDone: () => void;
}) {
  return (
    <View style={styles.dock}>
      <View style={styles.head}>
        <Text style={styles.headLabel} numberOfLines={1}>{label ?? 'Number'}</Text>
        <Text style={styles.headMode}>{mode === 'decimal' ? 'AMOUNT' : 'COUNT'}</Text>
      </View>

      <View style={styles.grid}>
        {DIGITS.map((digit) => (
          <Pressable
            key={digit}
            onPress={() => onKey({ type: 'digit', value: digit })}
            style={styles.key}
            accessibilityRole="button"
            accessibilityLabel={`key-${digit}`}
          >
            <Text style={styles.keyLabel}>{digit}</Text>
          </Pressable>
        ))}

        {/* An integer field gets a dead slot rather than a re-flowed grid: the
            keys under a cashier's thumb stay in the same place whichever field
            they are in, which is worth more than the space. */}
        {mode === 'decimal' ? (
          <Pressable onPress={() => onKey({ type: 'point' })} style={styles.key} accessibilityRole="button" accessibilityLabel="key-point">
            <Text style={styles.keyLabel}>.</Text>
          </Pressable>
        ) : (
          <View style={[styles.key, styles.keyBlank]} />
        )}

        <Pressable onPress={() => onKey({ type: 'digit', value: '0' })} style={styles.key} accessibilityRole="button" accessibilityLabel="key-0">
          <Text style={styles.keyLabel}>0</Text>
        </Pressable>

        <Pressable onPress={() => onKey({ type: 'delete' })} style={[styles.key, styles.util]} accessibilityRole="button" accessibilityLabel="key-delete">
          <Text style={styles.utilLabel}>⌫</Text>
        </Pressable>
      </View>

      <View style={styles.footer}>
        <Pressable onPress={() => onKey({ type: 'clear' })} style={[styles.wide, styles.util]} accessibilityRole="button" accessibilityLabel="key-clear">
          <Text style={styles.utilLabel}>Clear</Text>
        </Pressable>
        <Pressable onPress={onDone} style={[styles.wide, styles.done]} accessibilityRole="button" accessibilityLabel="key-done">
          <Text style={styles.doneLabel}>Done</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  dock: { backgroundColor: theme.bentoPage, borderTopWidth: 1, borderTopColor: theme.bentoRule, paddingHorizontal: 10, paddingTop: 10, paddingBottom: 12 },
  head: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 4, paddingBottom: 8, gap: 12 },
  headLabel: { fontSize: 11, fontWeight: '800', letterSpacing: 0.6, textTransform: 'uppercase', color: theme.bentoMuted, flexShrink: 1 },
  headMode: { fontSize: 11, fontWeight: '700', letterSpacing: 0.6, color: theme.bentoMuted2 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, justifyContent: 'center' },
  // Three to a row at any dock width, which is what makes the layout stable
  // between a phone sheet and a tablet modal.
  key: { width: '31%', height: 46, borderRadius: 10, backgroundColor: theme.bentoSurface, borderWidth: 1, borderColor: theme.bentoLine, alignItems: 'center', justifyContent: 'center' },
  keyBlank: { backgroundColor: 'transparent', borderColor: 'transparent' },
  keyLabel: { fontSize: 18, fontWeight: '700', color: theme.bentoInk },
  util: { backgroundColor: theme.bentoSoft },
  utilLabel: { fontSize: 14, fontWeight: '700', color: theme.bentoInk },
  footer: { flexDirection: 'row', gap: 6, marginTop: 6 },
  wide: { flex: 1, height: 46, borderRadius: 10, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: theme.bentoLine },
  done: { backgroundColor: theme.bentoInk, borderColor: theme.bentoInk },
  doneLabel: { fontSize: 14, fontWeight: '800', color: theme.bentoSurface },
});
```

- [ ] **Step 2: Run Task 2's tests, which this completes**

Run: `npx jest src/components/__tests__/keypad-host.test.tsx`
Expected: PASS, 7 tests.

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: no output.

- [ ] **Step 4: Run the whole suite**

Run: `npm test`
Expected: PASS, all suites.

- [ ] **Step 5: Commit**

```bash
git add src/components/ui/keypad-host.tsx src/components/ui/number-keypad.tsx src/components/__tests__/keypad-host.test.tsx
git commit -m "feat(keypad): a host that drives one numeric field, and the dock it renders"
```

---

### Task 4: The drop-in field

**Files:**
- Create: `src/components/ui/number-field.tsx`
- Test: `src/components/__tests__/number-field.test.tsx`

**Interfaces:**
- Consumes: `useKeypadSlot` from Task 2.
- Produces: `<NumberField id value onChangeText mode? placeholder? style? textStyle? accessibilityLabel? autoFocus? />` where `mode` defaults to `'decimal'`. Props match the `TextInput`s it replaces so the call sites in Tasks 5 and 6 are a rename plus an `id`.

- [ ] **Step 1: Write the failing test**

Create `src/components/__tests__/number-field.test.tsx`:

```tsx
import { Pressable, TextInput } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { NumberField } from '@/components/ui/number-field';

let mockKeypadOn = false;
jest.mock('@/hooks/use-scanner-settings', () => ({
  useScannerSettings: () => ({
    camera: false,
    hardware: mockKeypadOn,
    resolveCodes: mockKeypadOn,
    onScreenKeypad: mockKeypadOn,
    hardwareSetting: mockKeypadOn,
  }),
}));

function render(ui: React.ReactElement) {
  let tree: ReactTestRenderer | undefined;
  act(() => { tree = create(ui); });
  return tree!;
}

describe('NumberField', () => {
  beforeEach(() => { mockKeypadOn = false; });

  // The overwhelmingly common till: no scanner, so the system keyboard works
  // and taking it away would be a regression for everyone.
  it('is an ordinary TextInput when no keypad is needed', () => {
    const tree = render(<NumberField id="price" value="12.00" onChangeText={jest.fn()} />);
    const input = tree.root.findByType(TextInput);
    expect(input.props.keyboardType).toBe('decimal-pad');
    expect(tree.root.findAllByType(Pressable)).toHaveLength(0);
  });

  it('asks for a number-pad in integer mode', () => {
    const tree = render(<NumberField id="stock" mode="integer" value="4" onChangeText={jest.fn()} />);
    expect(tree.root.findByType(TextInput).props.keyboardType).toBe('number-pad');
  });

  // The rule the whole design exists to keep: with a scanner attached the
  // field must not be a TextInput at all, because a TextInput takes focus and
  // focus is what the wedge needs.
  it('renders nothing focusable once the keypad is on', () => {
    mockKeypadOn = true;
    const tree = render(<NumberField id="price" value="12.00" onChangeText={jest.fn()} />);
    expect(tree.root.findAllByType(TextInput)).toHaveLength(0);
    expect(tree.root.findAllByType(Pressable).length).toBeGreaterThan(0);
  });

  it('shows the value it was given', () => {
    mockKeypadOn = true;
    const tree = render(<NumberField id="price" value="12.34" onChangeText={jest.fn()} />);
    expect(JSON.stringify(tree.toJSON())).toContain('12.34');
  });

  it('shows the placeholder when there is no value', () => {
    mockKeypadOn = true;
    const tree = render(<NumberField id="price" value="" placeholder="0.00" onChangeText={jest.fn()} />);
    expect(JSON.stringify(tree.toJSON())).toContain('0.00');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx jest src/components/__tests__/number-field.test.tsx`
Expected: FAIL — `Cannot find module '@/components/ui/number-field'`.

- [ ] **Step 3: Write the implementation**

Create `src/components/ui/number-field.tsx`:

```tsx
import { Pressable, StyleSheet, Text, TextInput, View, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';

import { useKeypadSlot } from '@/components/ui/keypad-host';
import { Colors } from '@/constants/theme';
import { useScannerSettings } from '@/hooks/use-scanner-settings';
import type { NumberFieldMode } from '@/lib/number-keypad';

const theme = Colors.light;

/**
 * A numeric field in its two worlds, the same shape `SearchRow` has.
 *
 * With no scanner attached it is exactly the `TextInput` it replaced. With one
 * attached it is NOT a text input, and that is the point rather than a
 * shortcut: a text field takes focus, focus is what `WedgeSink` needs to catch
 * scans, and the OS will not draw a keyboard for it anyway. So it becomes a
 * `Pressable` driven by the app's own dock, and a barcode scanned halfway
 * through counting a drawer still lands.
 */
export function NumberField({
  id,
  value,
  onChangeText,
  mode = 'decimal',
  placeholder,
  style,
  textStyle,
  accessibilityLabel,
  autoFocus,
}: {
  /** Unique within one KeypadHost. The dock uses it to know which field it is driving. */
  id: string;
  value: string;
  onChangeText: (next: string) => void;
  mode?: NumberFieldMode;
  placeholder?: string;
  style?: StyleProp<ViewStyle | TextStyle>;
  /** Applied to the text inside the pressable form. The TextInput takes `style`. */
  textStyle?: StyleProp<TextStyle>;
  accessibilityLabel?: string;
  autoFocus?: boolean;
}) {
  const scanner = useScannerSettings();
  const slot = useKeypadSlot({ id, value, mode, onChange: onChangeText, label: accessibilityLabel });

  if (!scanner.onScreenKeypad) {
    return (
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={theme.bentoMuted2}
        keyboardType={mode === 'decimal' ? 'decimal-pad' : 'number-pad'}
        autoFocus={autoFocus}
        style={style as StyleProp<TextStyle>}
        accessibilityLabel={accessibilityLabel}
      />
    );
  }

  return (
    <Pressable
      onPress={slot.open}
      style={[style as StyleProp<ViewStyle>, styles.tappable, slot.active && styles.active]}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
    >
      <View style={styles.row}>
        {value ? (
          <Text style={[styles.text, textStyle]} numberOfLines={1}>{value}</Text>
        ) : (
          <Text style={[styles.placeholder, textStyle]} numberOfLines={1}>{placeholder ?? ''}</Text>
        )}
        {/* Static, unlike the search row's blinking one: a form can show several
            of these at once and four carets blinking out of phase reads as a
            fault rather than as a cursor. */}
        {slot.active ? <View style={styles.caret} /> : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  tappable: { justifyContent: 'center', borderStyle: 'dashed' },
  active: { borderColor: theme.bentoSeries1, borderWidth: 1.5, borderStyle: 'solid' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  text: { fontSize: 13, fontWeight: '600', color: theme.bentoInk, flexShrink: 1 },
  placeholder: { fontSize: 13, color: theme.bentoMuted2, flexShrink: 1 },
  caret: { width: 2, height: 16, backgroundColor: theme.bentoSeries1 },
});
```

- [ ] **Step 4: Run the tests**

Run: `npx jest src/components/__tests__/number-field.test.tsx`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
npx tsc --noEmit && npm test
git add src/components/ui/number-field.tsx src/components/__tests__/number-field.test.tsx
git commit -m "feat(keypad): a numeric field that never takes focus when a scanner is attached"
```

---

### Task 5: The drawer counts

**Files:**
- Modify: `src/components/pos/drawer-count.tsx` (the four numeric `TextInput`s — the figure input near line 153, the note-count input near line 174, the "Other" input near line 197, and the new-note input near line 216)
- Modify: `src/components/pos/close-register-sheet.tsx`, `src/components/pos/open-register-sheet.tsx` (wrap content in `KeypadHost`)

**Interfaces:**
- Consumes: `NumberField` (Task 4), `KeypadHost` (Task 2).
- Produces: nothing new.

These are the fields where a mis-key costs money, and the sheets that open them are the ones POS now unmounts `WedgeSink` for (`registerSheet === null` in `pos.tsx`), so nothing is competing for the caret while they are up.

- [ ] **Step 1: Swap the figure input**

In `src/components/pos/drawer-count.tsx`, replace the `TextInput` inside `mode === 'figure'` with:

```tsx
          <NumberField
            id={`drawer-${code}-figure`}
            value={entry.amount}
            onChangeText={(amount) => onChange({ ...entry, amount })}
            mode={isBase ? 'decimal' : 'integer'}
            placeholder={isBase ? '0.00' : '0'}
            autoFocus={autoFocus}
            style={styles.figureInput}
            accessibilityLabel={`Cash counted in ${code}`}
          />
```

Add to the imports at the top of the file:

```tsx
import { NumberField } from '@/components/ui/number-field';
```

- [ ] **Step 2: Swap the three remaining numeric inputs**

Note count:

```tsx
              <NumberField
                id={`drawer-${code}-note-${note}`}
                value={entry.counts[note] ?? ''}
                onChangeText={(count) => onChange({ ...entry, counts: { ...entry.counts, [note]: count } })}
                mode="integer"
                placeholder="0"
                style={styles.countInput}
                accessibilityLabel={`How many ${format(note)} notes`}
              />
```

"Other":

```tsx
            <NumberField
              id={`drawer-${code}-other`}
              value={entry.counts[OTHER_DENOMINATION] ?? ''}
              onChangeText={(amount) =>
                onChange({
                  ...entry,
                  counts: { ...entry.counts, [OTHER_DENOMINATION]: String(toCents(amount) || '') },
                })
              }
              placeholder="0"
              style={styles.countInput}
              accessibilityLabel={`Coins and other cash in ${code}`}
            />
```

New note value — this one keeps its `onBlur`/`onSubmitEditing` behaviour only in the `TextInput` world, so leave it as a `TextInput` and commit the note when the dock closes instead:

```tsx
              <NumberField
                id={`drawer-${code}-new-note`}
                value={newNote}
                onChangeText={setNewNote}
                mode={isBase ? 'decimal' : 'integer'}
                placeholder={isBase ? 'Note value, e.g. 200' : 'Note value, e.g. 10000'}
                autoFocus
                style={styles.newNoteInput}
                accessibilityLabel={`New note value for ${code}`}
              />
```

The `Add` `Pressable` beside it already calls `commitNote`, so the keypad path has a committer without needing `onSubmitEditing`.

- [ ] **Step 3: Give the sheets a dock to render into**

In `src/components/pos/close-register-sheet.tsx` and `src/components/pos/open-register-sheet.tsx`, wrap the sheet's content — the outermost `View` inside the `AppModal`, so the dock sits below the scroll and above the sheet's bottom edge:

```tsx
import { KeypadHost } from '@/components/ui/keypad-host';

// ...

  <AppModal ...>
    <KeypadHost>
      {/* everything the sheet rendered before */}
    </KeypadHost>
  </AppModal>
```

- [ ] **Step 4: Typecheck and run the suite**

Run: `npx tsc --noEmit && npm test`
Expected: no type errors; all suites pass. If `drawer-count`'s existing tests assert on `TextInput`, update them to query `NumberField` — do not weaken an assertion to make it pass.

- [ ] **Step 5: Verify on a device with a scanner attached**

The emulator at `~/Library/Android/sdk/platform-tools/adb -s emulator-5556` has a hardware keyboard, so `onScreenKeypad` is already true there.

1. Open POS, open the register sheet that counts a drawer.
2. Tap a count field. Expected: the dock appears, the field shows a caret, **no system keyboard**.
3. Press `1`, `2`, `.`, `5`. Expected: the field reads `12.5`.
4. With the dock open, fire a scan: `adb -s emulator-5556 shell input text 5901234123457 && adb -s emulator-5556 shell input keyevent 66`. Expected: the drawer figure is untouched — the sheet is open, so `pos.tsx` has unmounted `WedgeSink` and the scan goes nowhere. This is the correct behaviour; a scan mid-count must not add to a sale.
5. Press Done. Expected: the dock closes and the figure survives.

- [ ] **Step 6: Commit**

```bash
git add src/components/pos/drawer-count.tsx src/components/pos/close-register-sheet.tsx src/components/pos/open-register-sheet.tsx
git commit -m "feat(pos): drawer counts can be typed on a till with a scanner attached"
```

---

### Task 6: Price, cost, stock and reorder level

**Files:**
- Modify: `src/components/product-form.tsx` (the two `decimal-pad` inputs and the two `number-pad` inputs)
- Modify: `src/components/product-modal.tsx` (wrap the card's body in `KeypadHost`)

**Interfaces:**
- Consumes: `NumberField` (Task 4), `KeypadHost` (Task 2).
- Produces: nothing new.

- [ ] **Step 1: Find the four fields**

Run: `rg -n 'keyboardType="(decimal|number)-pad"' src/components/product-form.tsx`
Expected: four hits — price, cost, stock, reorder level.

- [ ] **Step 2: Swap each one**

For each hit, replace the `TextInput` with a `NumberField`, keeping every other prop as it was. Money fields (price, cost) take `mode="decimal"`; counts (stock, reorder level) take `mode="integer"`. Example, for price:

```tsx
        <NumberField
          id="product-price"
          value={price}
          onChangeText={setPrice}
          mode="decimal"
          placeholder="0.00"
          style={styles.input}
          accessibilityLabel="Price"
        />
```

Add the import:

```tsx
import { NumberField } from '@/components/ui/number-field';
```

- [ ] **Step 3: Give the modal a dock**

In `src/components/product-modal.tsx`, wrap the contents of `styles.card` — inside the card so the dock is bounded by the modal rather than the screen:

```tsx
import { KeypadHost } from '@/components/ui/keypad-host';

// ...

        <View style={styles.card}>
          <KeypadHost>
            {/* header, formWrap and the delete button as they are today */}
          </KeypadHost>
        </View>
```

- [ ] **Step 4: Typecheck and run the suite**

Run: `npx tsc --noEmit && npm test`
Expected: no type errors; all suites pass.

- [ ] **Step 5: Verify on the device**

1. Inventory → `+ Add product`.
2. Tap Price. Expected: dock appears, no system keyboard, header reads `PRICE` and `AMOUNT`.
3. Type `4`, `.`, `5`, `0`. Expected: `4.50`.
4. Tap Stock. Expected: the dock stays open, moves to Stock, and the `.` key is a dead slot.
5. Confirm the barcode field still holds the scanned code and Save still enables.

- [ ] **Step 6: Commit**

```bash
git add src/components/product-form.tsx src/components/product-modal.tsx
git commit -m "feat(inventory): price, cost and stock can be typed on a till with a scanner attached"
```

---

### Task 7: Write down what this does not cover

**Files:**
- Modify: `src/components/search-keypad.tsx` (the note at the top)

**Interfaces:**
- Consumes: nothing.
- Produces: nothing.

The next person to read `SearchKeypad` will find a second keypad in the tree and needs to know why there are two and where the line is.

- [ ] **Step 1: Extend the note**

Append to the comment block at the top of `src/components/search-keypad.tsx`:

```tsx
// There is now a second keypad -- `ui/number-keypad.tsx` -- for money and count
// fields on forms. They are deliberately separate: this one is a search box's
// keyboard, where what is typed has no type and the only question is which
// products match. That one edits a NUMBER, where the field's own type decides
// whether a decimal point is a key at all. Merging them would produce exactly
// the general keyboard the paragraph above rules out.
//
// Neither covers a text field on a form -- a product name, a customer name.
// Those still ask the OS for a keyboard, which on a till with a scanner
// attached it will not draw. See the text-keypad plan (3b).
```

- [ ] **Step 2: Typecheck and run the suite**

Run: `npx tsc --noEmit && npm test`
Expected: no type errors; all suites pass.

- [ ] **Step 3: Commit**

```bash
git add src/components/search-keypad.tsx
git commit -m "docs(keypad): say why there are two keypads and where the line is"
```

---

## Done when

- A till with a scanner attached can count a drawer and set a price without a system keyboard.
- A till with no scanner sees no change whatsoever — every branch is behind `onScreenKeypad`.
- No keypad-driven field ever takes OS focus, so scanning keeps working everywhere it worked before.
- Text fields are untouched and still broken on such a till. That is 3b, and it is a separate decision.
