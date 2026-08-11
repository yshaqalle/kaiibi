# Text Keypad for Till Forms (3b) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Prerequisite:** `docs/superpowers/plans/2026-08-11-number-keypad-for-till-forms.md` (3a) must be complete and merged. This plan modifies `KeypadHost`, which that plan creates.

**Goal:** A till with a barcode scanner attached can type the handful of *names* it needs mid-sale — a new product's name and brand, a new customer's name — on a device where the OS refuses to show a keyboard.

**Architecture:** 3a built the machinery: a host that owns which field is being driven, a dock rendered at the modal's bottom, and fields that never take OS focus. This plan adds the second dock — letters, with a Shift the search keypad deliberately does not have, because a product name has capitals and a search term does not. The host's slot becomes a two-kind union so one host can drive either dock, and `TextField` is the text counterpart of `NumberField`.

**Tech Stack:** Expo SDK 57, React Native 0.86, Jest via `jest-expo`, `react-test-renderer`.

## Global Constraints

- **Read the versioned Expo docs** at https://docs.expo.dev/versions/v57.0.0/ before writing code that touches an Expo API. Repo-wide rule from `AGENTS.md`.
- **Never hardcode a hex colour.** Every colour comes from `Colors.light` in `src/constants/theme.ts`.
- **Every file pins `const theme = Colors.light;`**.
- **Never import `Modal` from `react-native`.** Use `AppModal`; `eslint.config.js` enforces it.
- **Everything here is gated on `useScannerSettings().onScreenKeypad`.** A till with no scanner keeps the system keyboard, untouched.
- **A keypad-driven field must never take OS focus** — focus is what `WedgeSink` needs to catch scans.
- **Scope is fixed and small: five fields.** Product name, product brand, customer name, customer phone, and nothing else. Description, tags, shelf number, batch number and notes stay on the system keyboard: they are back-office edits made on a device with no scanner attached, and every field added here is another key layout to maintain forever.
- **Email is deliberately excluded.** It needs `@`, dots and case in a way that turns this into a general keyboard, and no till types an email mid-sale. Task 6 writes that down.
- **Run `npx tsc --noEmit` and `npm test` before every commit.**
- **Commit after every task. Do not push** — `tablet-login-fix` is shared.

## File Structure

| Path | Responsibility |
|---|---|
| `src/lib/text-keypad.ts` | Pure: the Shift state machine and how it changes a character. No imports. |
| `src/components/ui/keypad-host.tsx` | Modified: its slot becomes a `number \| text` union so one host drives either dock. |
| `src/components/ui/text-keypad.tsx` | The letters dock: letters, digits, Shift, space, backspace, Done. |
| `src/components/ui/text-field.tsx` | Drop-in for a text `TextInput`, the counterpart of `NumberField`. |
| `src/components/product-form.tsx` | Modified: name and brand become `TextField`s. |
| `src/components/customer-picker.tsx` | Modified: quick-add name becomes a `TextField`, phone becomes a `NumberField`. |

---

### Task 1: The Shift rules

**Files:**
- Create: `src/lib/text-keypad.ts`
- Test: `src/lib/__tests__/text-keypad.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `type ShiftState = 'off' | 'once' | 'locked'`, `nextShift(current: ShiftState): ShiftState`, `applyShift(char: string, shift: ShiftState): string`, `shiftAfterChar(shift: ShiftState): ShiftState`.

- [ ] **Step 1: Write the failing test**

Create `src/lib/__tests__/text-keypad.test.ts`:

```ts
import { applyShift, nextShift, shiftAfterChar } from '@/lib/text-keypad';

describe('nextShift', () => {
  // One tap for one capital, two for a run of them, a third to stop. The same
  // three-state cycle every phone keyboard uses, because a cashier already
  // knows it and a novel one would have to be learned at a counter.
  it('cycles off to once to locked and back', () => {
    expect(nextShift('off')).toBe('once');
    expect(nextShift('once')).toBe('locked');
    expect(nextShift('locked')).toBe('off');
  });
});

describe('applyShift', () => {
  it('leaves a character alone when shift is off', () => {
    expect(applyShift('a', 'off')).toBe('a');
  });

  it('capitalises for once and for locked', () => {
    expect(applyShift('a', 'once')).toBe('A');
    expect(applyShift('a', 'locked')).toBe('A');
  });

  // Digits have no case, and a shift state must not eat them.
  it('passes a digit through unchanged in every state', () => {
    expect(applyShift('7', 'once')).toBe('7');
    expect(applyShift('7', 'locked')).toBe('7');
  });
});

describe('shiftAfterChar', () => {
  it('spends a one-shot shift on the character it capitalised', () => {
    expect(shiftAfterChar('once')).toBe('off');
  });

  it('keeps a locked shift for the next character', () => {
    expect(shiftAfterChar('locked')).toBe('locked');
  });

  it('leaves off alone', () => {
    expect(shiftAfterChar('off')).toBe('off');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx jest src/lib/__tests__/text-keypad.test.ts`
Expected: FAIL — `Cannot find module '@/lib/text-keypad'`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/text-keypad.ts`:

```ts
// Shift, as a pure state machine.
//
// `SearchKeypad` has no Shift and says so: product search is case-insensitive,
// so a capital would be weight with nothing on the other end. A product NAME is
// the opposite -- it is stored and shown exactly as typed, and a catalog of
// lower-case names is one a shopkeeper will not accept. So this keypad has the
// key that one refuses, and the difference is the reason they are two
// components rather than one with a flag.

export type ShiftState = 'off' | 'once' | 'locked';

/** What tapping the Shift key does. */
export function nextShift(current: ShiftState): ShiftState {
  switch (current) {
    case 'off':
      return 'once';
    case 'once':
      return 'locked';
    case 'locked':
      return 'off';
  }
}

/** The character a letter key produces in this state. */
export function applyShift(char: string, shift: ShiftState): string {
  return shift === 'off' ? char : char.toUpperCase();
}

/** The state left behind after a character is typed. */
export function shiftAfterChar(shift: ShiftState): ShiftState {
  return shift === 'once' ? 'off' : shift;
}
```

- [ ] **Step 4: Run the tests**

Run: `npx jest src/lib/__tests__/text-keypad.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/text-keypad.ts src/lib/__tests__/text-keypad.test.ts
git commit -m "feat(keypad): Shift, as pure rules"
```

---

### Task 2: One host, two kinds of dock

**Files:**
- Modify: `src/components/ui/keypad-host.tsx`
- Modify: `src/components/ui/number-field.tsx` (its `useKeypadSlot` call gains `kind: 'number'`)
- Modify: `src/components/__tests__/keypad-host.test.tsx` (its `Field` helper gains `kind: 'number'`)

**Interfaces:**
- Consumes: `applyNumberKey`, `NumberFieldMode` (3a Task 1); `applyKey` from `@/lib/keypad`; `applyShift`, `shiftAfterChar` (Task 1).
- Produces: `useKeypadSlot` now takes a discriminated union:
  - `{ kind: 'number'; id; value; mode: NumberFieldMode; onChange; label? }`
  - `{ kind: 'text'; id; value; onChange; label? }`

- [ ] **Step 1: Write the failing test**

Append to `src/components/__tests__/keypad-host.test.tsx`:

```tsx
function TextFieldStub({ id }: { id: string }) {
  const [value, setValue] = useState('');
  const slot = useKeypadSlot({ kind: 'text', id, value, onChange: setValue, label: id });
  return (
    <Pressable onPress={slot.open} accessibilityLabel={`field-${id}`}>
      <Text>{`${id}:${value}${slot.active ? ':active' : ''}`}</Text>
    </Pressable>
  );
}

describe('KeypadHost, text slots', () => {
  it('opens the letters dock for a text field', () => {
    const tree = render(<KeypadHost><TextFieldStub id="name" /></KeypadHost>);
    press(tree, 'field-name');
    expect(texts(tree)).toContain('Done');
    // The letters dock has a Shift key; the number dock does not.
    expect(texts(tree)).toContain('⇧');
  });

  it('types letters into the field', () => {
    const tree = render(<KeypadHost><TextFieldStub id="name" /></KeypadHost>);
    press(tree, 'field-name');
    press(tree, 'key-t');
    press(tree, 'key-e');
    press(tree, 'key-a');
    expect(texts(tree)).toContain('name:tea:active');
  });

  it('capitalises one character after Shift, then goes back to lower case', () => {
    const tree = render(<KeypadHost><TextFieldStub id="name" /></KeypadHost>);
    press(tree, 'field-name');
    press(tree, 'key-shift');
    press(tree, 'key-t');
    press(tree, 'key-e');
    expect(texts(tree)).toContain('name:Te:active');
  });

  it('holds the capitals when Shift is tapped twice', () => {
    const tree = render(<KeypadHost><TextFieldStub id="name" /></KeypadHost>);
    press(tree, 'field-name');
    press(tree, 'key-shift');
    press(tree, 'key-shift');
    press(tree, 'key-t');
    press(tree, 'key-e');
    expect(texts(tree)).toContain('name:TE:active');
  });

  it('swaps docks when the driven field changes kind', () => {
    const tree = render(<KeypadHost><Field id="price" /><TextFieldStub id="name" /></KeypadHost>);
    press(tree, 'field-price');
    expect(texts(tree)).not.toContain('⇧');
    press(tree, 'field-name');
    expect(texts(tree)).toContain('⇧');
  });
});
```

Also update the existing `Field` helper at the top of the file to pass the new discriminant:

```tsx
  const slot = useKeypadSlot({ kind: 'number', id, value, mode: 'decimal', onChange: setValue, label: id });
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx jest src/components/__tests__/keypad-host.test.tsx`
Expected: FAIL — the text cases find no `⇧`, and TypeScript rejects `kind` on the slot argument.

- [ ] **Step 3: Change the slot to a union**

In `src/components/ui/keypad-host.tsx`, replace the `Slot` type and the dock branch:

```tsx
type Slot =
  | { kind: 'number'; value: string; mode: NumberFieldMode; onChange: (next: string) => void; label?: string }
  | { kind: 'text'; value: string; onChange: (next: string) => void; label?: string };
```

Replace the rendered dock with a branch on the active slot's kind, and hold the Shift state here — it belongs to the dock's session, not to the field, so moving to another field starts clean:

```tsx
  const [shift, setShift] = useState<ShiftState>('off');

  // A fresh field starts in lower case. Carrying a locked Shift across fields
  // is how a customer's name arrives as SHOUTING nobody asked for.
  useEffect(() => { setShift('off'); }, [activeId]);
```

```tsx
      {active?.kind === 'number' ? (
        <NumberKeypad
          label={active.label}
          mode={active.mode}
          onKey={(key) => {
            const slot = activeId ? slots.current[activeId] : undefined;
            if (!slot || slot.kind !== 'number') return;
            slot.onChange(applyNumberKey(slot.value, key, slot.mode));
          }}
          onDone={() => setActiveId(null)}
        />
      ) : null}

      {active?.kind === 'text' ? (
        <TextKeypad
          label={active.label}
          shift={shift}
          onShift={() => setShift(nextShift)}
          onKey={(key) => {
            const slot = activeId ? slots.current[activeId] : undefined;
            if (!slot || slot.kind !== 'text') return;
            const typed = key.type === 'char' ? { ...key, value: applyShift(key.value, shift) } : key;
            slot.onChange(applyKey(slot.value, typed));
            if (key.type === 'char') setShift(shiftAfterChar);
          }}
          onDone={() => setActiveId(null)}
        />
      ) : null}
```

Add the imports:

```tsx
import { TextKeypad } from '@/components/ui/text-keypad';
import { applyKey } from '@/lib/keypad';
import { applyShift, nextShift, shiftAfterChar, type ShiftState } from '@/lib/text-keypad';
```

Widen `useKeypadSlot`'s parameter to the union:

```tsx
export function useKeypadSlot(
  slot: ({ kind: 'number'; mode: NumberFieldMode } | { kind: 'text' }) & {
    id: string;
    value: string;
    onChange: (next: string) => void;
    label?: string;
  }
): { active: boolean; open: () => void } {
  const host = useContext(KeypadContext);
  const { id } = slot;

  useEffect(() => {
    if (!host) return;
    host.register(id, slot as Slot);
  });

  useEffect(() => {
    if (!host) return;
    return () => host.unregister(id);
  }, [host, id]);

  const open = useCallback(() => host?.open(id), [host, id]);
  return { active: host?.activeId === id, open };
}
```

- [ ] **Step 4: Add `kind` at the one existing call site**

In `src/components/ui/number-field.tsx`:

```tsx
  const slot = useKeypadSlot({ kind: 'number', id, value, mode, onChange: onChangeText, label: accessibilityLabel });
```

- [ ] **Step 5: Run the tests**

Run: `npx jest src/components/__tests__/keypad-host.test.tsx`
Expected: FAIL — `Cannot find module '@/components/ui/text-keypad'`. That is Task 3; continue, then come back.

---

### Task 3: The letters dock

**Files:**
- Create: `src/components/ui/text-keypad.tsx`

**Interfaces:**
- Consumes: `KeypadKey` from `@/lib/keypad`, `ShiftState` from Task 1.
- Produces: `<TextKeypad label? shift onShift onKey onDone />`. Keys carry `accessibilityLabel`: `key-a`…`key-z`, `key-0`…`key-9`, `key-shift`, `key-space`, `key-delete`, `key-clear`, `key-done`.

- [ ] **Step 1: Write the implementation**

Create `src/components/ui/text-keypad.tsx`:

```tsx
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Colors } from '@/constants/theme';
import type { KeypadKey } from '@/lib/keypad';
import { applyShift, type ShiftState } from '@/lib/text-keypad';

const theme = Colors.light;

// Same layout as `SearchKeypad`, one key different -- and that key is the whole
// reason this is a second component. See lib/text-keypad.ts.
const ROWS = [
  ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'],
  ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p'],
  ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l'],
  ['z', 'x', 'c', 'v', 'b', 'n', 'm'],
];

export function TextKeypad({
  label,
  shift,
  onShift,
  onKey,
  onDone,
}: {
  /** The field being driven. A dock with no caret of its own must say what it is aimed at. */
  label?: string;
  shift: ShiftState;
  onShift: () => void;
  onKey: (key: KeypadKey) => void;
  onDone: () => void;
}) {
  return (
    <View style={styles.dock}>
      <View style={styles.head}>
        <Text style={styles.headLabel} numberOfLines={1}>{label ?? 'Text'}</Text>
        {shift === 'locked' ? <Text style={styles.headMode}>CAPS</Text> : null}
      </View>

      {ROWS.map((row, index) => (
        <View key={index} style={styles.row}>
          {row.map((char) => (
            <Pressable
              key={char}
              onPress={() => onKey({ type: 'char', value: char })}
              style={styles.key}
              accessibilityRole="button"
              accessibilityLabel={`key-${char}`}
            >
              <Text style={styles.keyLabel}>{applyShift(char, shift)}</Text>
            </Pressable>
          ))}
        </View>
      ))}

      <View style={styles.row}>
        <Pressable
          onPress={onShift}
          style={[styles.key, styles.util, shift !== 'off' && styles.shiftOn]}
          accessibilityRole="button"
          accessibilityLabel="key-shift"
          accessibilityState={{ selected: shift !== 'off' }}
        >
          <Text style={[styles.utilLabel, shift !== 'off' && styles.shiftOnLabel]}>⇧</Text>
        </Pressable>
        <Pressable onPress={() => onKey({ type: 'clear' })} style={[styles.key, styles.util]} accessibilityRole="button" accessibilityLabel="key-clear">
          <Text style={styles.utilLabel}>Clear</Text>
        </Pressable>
        <Pressable onPress={() => onKey({ type: 'space' })} style={[styles.key, styles.util, styles.space]} accessibilityRole="button" accessibilityLabel="key-space">
          <Text style={styles.utilLabel}>space</Text>
        </Pressable>
        <Pressable onPress={() => onKey({ type: 'delete' })} style={[styles.key, styles.util]} accessibilityRole="button" accessibilityLabel="key-delete">
          <Text style={styles.utilLabel}>⌫</Text>
        </Pressable>
        <Pressable onPress={onDone} style={[styles.key, styles.done]} accessibilityRole="button" accessibilityLabel="key-done">
          <Text style={styles.doneLabel}>Done</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  dock: { backgroundColor: theme.bentoPage, borderTopWidth: 1, borderTopColor: theme.bentoRule, paddingHorizontal: 8, paddingTop: 10, paddingBottom: 12 },
  head: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 4, paddingBottom: 8, gap: 12 },
  headLabel: { fontSize: 11, fontWeight: '800', letterSpacing: 0.6, textTransform: 'uppercase', color: theme.bentoMuted, flexShrink: 1 },
  headMode: { fontSize: 11, fontWeight: '700', letterSpacing: 0.6, color: theme.bentoSeries1 },
  row: { flexDirection: 'row', gap: 5, justifyContent: 'center', marginBottom: 5 },
  key: { flex: 1, maxWidth: 62, height: 42, borderRadius: 8, backgroundColor: theme.bentoSurface, borderWidth: 1, borderColor: theme.bentoLine, alignItems: 'center', justifyContent: 'center' },
  keyLabel: { fontSize: 15, fontWeight: '700', color: theme.bentoInk },
  util: { backgroundColor: theme.bentoSoft, maxWidth: 96 },
  utilLabel: { fontSize: 13, fontWeight: '700', color: theme.bentoInk },
  space: { maxWidth: 220, flex: 3 },
  // Selected state is not colour alone: the glyph inverts as well, for the same
  // reason the bento tokens pair every profit/loss colour with a sign.
  shiftOn: { backgroundColor: theme.bentoInk, borderColor: theme.bentoInk },
  shiftOnLabel: { color: theme.bentoSurface },
  done: { backgroundColor: theme.bentoInk, borderColor: theme.bentoInk, maxWidth: 96 },
  doneLabel: { fontSize: 13, fontWeight: '800', color: theme.bentoSurface },
});
```

- [ ] **Step 2: Run Task 2's tests, which this completes**

Run: `npx jest src/components/__tests__/keypad-host.test.tsx`
Expected: PASS — the 7 tests from 3a plus the 5 added in Task 2.

- [ ] **Step 3: Typecheck and run the suite**

Run: `npx tsc --noEmit && npm test`
Expected: no type errors; all suites pass.

- [ ] **Step 4: Commit**

```bash
git add src/components/ui/keypad-host.tsx src/components/ui/text-keypad.tsx src/components/ui/number-field.tsx src/components/__tests__/keypad-host.test.tsx
git commit -m "feat(keypad): one host, two docks, and the Shift the search keypad refuses"
```

---

### Task 4: The drop-in text field

**Files:**
- Create: `src/components/ui/text-field.tsx`
- Test: `src/components/__tests__/text-field.test.tsx`

**Interfaces:**
- Consumes: `useKeypadSlot` (Task 2).
- Produces: `<TextField id value onChangeText placeholder? style? textStyle? accessibilityLabel? autoCapitalize? />`.

- [ ] **Step 1: Write the failing test**

Create `src/components/__tests__/text-field.test.tsx`:

```tsx
import { Pressable, TextInput } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { TextField } from '@/components/ui/text-field';

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

describe('TextField', () => {
  beforeEach(() => { mockKeypadOn = false; });

  it('is an ordinary TextInput when no keypad is needed', () => {
    const tree = render(<TextField id="name" value="Tea" onChangeText={jest.fn()} />);
    expect(tree.root.findAllByType(TextInput)).toHaveLength(1);
    expect(tree.root.findAllByType(Pressable)).toHaveLength(0);
  });

  it('renders nothing focusable once the keypad is on', () => {
    mockKeypadOn = true;
    const tree = render(<TextField id="name" value="Tea" onChangeText={jest.fn()} />);
    expect(tree.root.findAllByType(TextInput)).toHaveLength(0);
    expect(tree.root.findAllByType(Pressable).length).toBeGreaterThan(0);
  });

  it('shows the value, and the placeholder when there is none', () => {
    mockKeypadOn = true;
    expect(JSON.stringify(render(<TextField id="n" value="Ceylon" onChangeText={jest.fn()} />).toJSON())).toContain('Ceylon');
    expect(JSON.stringify(render(<TextField id="n" value="" placeholder="e.g. ANUA Toner" onChangeText={jest.fn()} />).toJSON())).toContain('e.g. ANUA Toner');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx jest src/components/__tests__/text-field.test.tsx`
Expected: FAIL — `Cannot find module '@/components/ui/text-field'`.

- [ ] **Step 3: Write the implementation**

Create `src/components/ui/text-field.tsx`:

```tsx
import { Pressable, StyleSheet, Text, TextInput, View, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';

import { useKeypadSlot } from '@/components/ui/keypad-host';
import { Colors } from '@/constants/theme';
import { useScannerSettings } from '@/hooks/use-scanner-settings';

const theme = Colors.light;

/**
 * The text counterpart of `NumberField`, and the same two worlds: a real
 * `TextInput` where the system keyboard works, and a focus-free `Pressable`
 * driven by the app's own dock where a scanner has taken the keyboard away.
 */
export function TextField({
  id,
  value,
  onChangeText,
  placeholder,
  style,
  textStyle,
  accessibilityLabel,
  autoCapitalize = 'words',
}: {
  id: string;
  value: string;
  onChangeText: (next: string) => void;
  placeholder?: string;
  style?: StyleProp<ViewStyle | TextStyle>;
  textStyle?: StyleProp<TextStyle>;
  accessibilityLabel?: string;
  autoCapitalize?: 'none' | 'sentences' | 'words' | 'characters';
}) {
  const scanner = useScannerSettings();
  const slot = useKeypadSlot({ kind: 'text', id, value, onChange: onChangeText, label: accessibilityLabel });

  if (!scanner.onScreenKeypad) {
    return (
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={theme.bentoMuted2}
        autoCapitalize={autoCapitalize}
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

Run: `npx jest src/components/__tests__/text-field.test.tsx`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
npx tsc --noEmit && npm test
git add src/components/ui/text-field.tsx src/components/__tests__/text-field.test.tsx
git commit -m "feat(keypad): a text field that never takes focus when a scanner is attached"
```

---

### Task 5: The five fields

**Files:**
- Modify: `src/components/product-form.tsx` (product name, brand)
- Modify: `src/components/customer-picker.tsx` (quick-add name, quick-add phone)

**Interfaces:**
- Consumes: `TextField` (Task 4), `NumberField` (3a Task 4), `KeypadHost` (already wrapping `ProductModal` from 3a Task 6).
- Produces: nothing new.

- [ ] **Step 1: Product name and brand**

In `src/components/product-form.tsx`, add the import:

```tsx
import { TextField } from '@/components/ui/text-field';
```

Replace the product-name `TextInput` with:

```tsx
        <TextField
          id="product-name"
          value={name}
          onChangeText={setName}
          placeholder="e.g. ANUA Heartleaf Toner"
          style={styles.input}
          accessibilityLabel="Product name"
        />
```

Replace the brand input with:

```tsx
        <TextField
          id="product-brand"
          value={brand}
          onChangeText={setBrand}
          placeholder="Search or add a brand…"
          style={styles.input}
          accessibilityLabel="Brand"
        />
```

Leave description, SKU, tags, shelf number, batch number and expiry as `TextInput`s — see Global Constraints. If the brand field turns out to be a picker rather than a plain input, wire only its text entry and leave the suggestion chips as they are.

- [ ] **Step 2: Customer quick-add**

In `src/components/customer-picker.tsx`, add both imports:

```tsx
import { NumberField } from '@/components/ui/number-field';
import { TextField } from '@/components/ui/text-field';
```

Replace the quick-add name input with a `TextField` (`id="customer-name"`, `accessibilityLabel="Customer name"`), and the phone input at line 172 with:

```tsx
              <NumberField
                id="customer-phone"
                value={phone}
                onChangeText={setPhone}
                mode="integer"
                placeholder="Phone"
                style={styles.input}
                accessibilityLabel="Customer phone"
              />
```

Leave the email input and the customer *search* input alone: email is out of scope, and the search input is already handled by the wedge machinery in `SearchRow`'s sibling path.

- [ ] **Step 3: Give the customer picker a dock**

The picker renders inside the POS checkout panel rather than a modal of its own, so it needs its own host. In `src/components/customer-picker.tsx`, wrap the quick-add form's outermost `View` in `<KeypadHost>`:

```tsx
import { KeypadHost } from '@/components/ui/keypad-host';
```

- [ ] **Step 4: Typecheck and run the suite**

Run: `npx tsc --noEmit && npm test`
Expected: no type errors; all suites pass. Update any existing test that asserted on a `TextInput` at these sites — query the new component, do not weaken the assertion.

- [ ] **Step 5: Verify on the device**

1. Inventory → scan an unknown code → `+ Add a product with barcode …`.
2. Tap Product name. Expected: the letters dock, no system keyboard, header reads `PRODUCT NAME`.
3. Tap Shift, then `t`, `e`, `a`. Expected: `Tea` — one capital, then lower case.
4. Tap Price. Expected: the dock swaps to digits and the Shift key is gone.
5. Save. Expected: the product is created with the name and price as typed.

- [ ] **Step 6: Commit**

```bash
git add src/components/product-form.tsx src/components/customer-picker.tsx
git commit -m "feat(till): product and customer names can be typed on a till with a scanner attached"
```

---

### Task 6: Write down the edge that was left

**Files:**
- Modify: `src/components/ui/text-keypad.tsx` (the note at the top)

**Interfaces:**
- Consumes: nothing.
- Produces: nothing.

- [ ] **Step 1: Add the note**

Append to the comment block at the top of `src/components/ui/text-keypad.tsx`:

```tsx
// What this deliberately does NOT have, and why each would cost more than it
// returns on a till:
//
//   - Symbols and punctuation. Only email needs them, and email is the one
//     field here nobody fills in mid-sale. It stays on the system keyboard,
//     which means on a till with a scanner attached it cannot be typed at all
//     -- a known, accepted gap. Adding `@` and `.` invites the rest.
//   - Accented and non-Latin characters. A real requirement the day a shop
//     needs them, and a language-layout problem rather than a key: solve it by
//     picking layouts from the device locale, not by adding rows here.
//   - Autocorrect, prediction, emoji. A product name is not prose.
//
// The fields this drives are listed in the 3b plan and are deliberately five.
// Adding a sixth is a decision, not a chore.
```

- [ ] **Step 2: Typecheck and run the suite**

Run: `npx tsc --noEmit && npm test`
Expected: no type errors; all suites pass.

- [ ] **Step 3: Commit**

```bash
git add src/components/ui/text-keypad.tsx
git commit -m "docs(keypad): the edges the text keypad does not cover, and why"
```

---

## Done when

- On a till with a scanner attached, a product can be created end to end — name, brand, price, stock — with no system keyboard.
- A customer can be quick-added with a name and phone on the same till.
- A till with no scanner sees no change at all.
- No keypad-driven field takes OS focus, so a barcode scanned mid-typing still routes to the scan handler rather than into the name.
- Email on a scanner-attached till remains untypeable, and `text-keypad.tsx` says so.
