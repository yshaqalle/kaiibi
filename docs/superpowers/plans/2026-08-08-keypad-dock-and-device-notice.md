# Keypad Dock & Device Notice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the scanner-till search keypad out of the scroll flow into a real bottom dock on Inventory and POS, and move the till-keyboard notice off the `Caveat` component (whose contract it violates) onto its own `DeviceNotice` with a deep-linked action.

**Architecture:** The keypad becomes a flex sibling rendered *after* the screen's scroll container inside the same `SafeAreaView`, so the list shrinks above it — system-keyboard behaviour, no overlay, no inset maths. Keypad open/closed state lifts out of `SearchRow` into a small exported hook so the screens can own the dock. The notice keeps its exact gating and copy but renders through a new `DeviceNotice` component and deep-links into the active store's editor via a new `location` URL param on Settings.

**Tech Stack:** Expo SDK 57 / React Native 0.86, expo-router, jest + react-test-renderer. Mockup: [docs/design/scanner-keypad-dock-fix.html](../../design/scanner-keypad-dock-fix.html). Original feature spec: [2026-08-08-scanner-detection-keypad-design.md](../specs/2026-08-08-scanner-detection-keypad-design.md).

## Global Constraints

- Never hardcode a hex in a screen or component — every colour is a token off `Colors.light` (pinned as `const theme = Colors.light`).
- `SearchRow` must never render a `TextInput` while `useKeypad` is true — a text field would take focus from the wedge sink and stop hardware scanning.
- The till notice's gates are frozen: confirmed keyboard (`attached === true`), store setting off, `can('settings.access')`, not dismissed. Its copy is frozen word for word.
- "Scanner ready" copy is approved and unchanged.
- The Caveat contract is honoured by *leaving* Caveat, not by amending its tones.
- Jest runs with `npm test -- <path>`; RN 0.86 + React 19 collapse `React.memo` fiber types, so tests find pressables by duck-typing `onPress` (see existing search-row.test.tsx).
- Test-file mock variables that a hoisted `jest.mock()` factory closes over MUST be named with a `mock` prefix or the suite fails to transform.

---

### Task 1: Lift keypad state out of `SearchRow`

`SearchRow` currently owns `keypadOpen` and renders `SearchKeypad` inline in the scroll flow — that is the bug. Make it controlled: the screen owns the state (via a small hook that keeps the close-on-unplug rule), `SearchRow` only reports taps and shows the caret, and stops rendering the keypad entirely.

**Files:**
- Modify: `src/components/search-row.tsx`
- Test: `src/components/__tests__/search-row.test.tsx`

**Interfaces:**
- Produces: `useSearchKeypadState(useKeypad: boolean): { keypadOpen: boolean; setKeypadOpen: (open: boolean) => void }` exported from `@/components/search-row`.
- Produces: `SearchRow` prop changes — `keypadOpen: boolean` and `onKeypadOpenChange: (open: boolean) => void` are new required props **when `useKeypad` is true**; `SearchRow` no longer renders `SearchKeypad`. All other props unchanged.
- Consumes: nothing new.

- [ ] **Step 1: Rewrite the failing tests**

Replace the keypad-related tests in `src/components/__tests__/search-row.test.tsx`. The component keeps its "no TextInput in keypad mode" promise but no longer mounts `SearchKeypad`; the open/close/unplug behaviour moves to the hook. Full new test file:

```tsx
import { StyleSheet, Text, TextInput } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { SearchRow, useSearchKeypadState } from '@/components/search-row';
import { SearchKeypad } from '@/components/search-keypad';

// RN 0.86's `Pressable` is `React.memo(...)`, and React 19's
// react-test-renderer collapses a memo's fiber `.type` to the inner function,
// so `findAllByType(Pressable)` silently matches zero nodes. Duck-type on the
// prop instead -- see dashboard-cards.test.tsx and search-keypad.test.tsx.
function findPressables(tree: ReactTestRenderer) {
  return tree.root.findAll((node) => typeof node.props?.onPress === 'function', { deep: true });
}

function row(useKeypad: boolean, value: string, onChange: jest.Mock, keypadOpen = false, onKeypadOpenChange: (open: boolean) => void = jest.fn()) {
  return (
    <SearchRow
      value={value}
      onChange={onChange}
      onSubmit={jest.fn()}
      placeholder="Search or scan a product"
      useKeypad={useKeypad}
      showScanButton={false}
      keypadOpen={keypadOpen}
      onKeypadOpenChange={onKeypadOpenChange}
    />
  );
}

function render(useKeypad: boolean, value = '', keypadOpen = false, onKeypadOpenChange: (open: boolean) => void = jest.fn()) {
  const onChange = jest.fn();
  let tree: ReactTestRenderer | undefined;
  act(() => { tree = create(row(useKeypad, value, onChange, keypadOpen, onKeypadOpenChange)); });
  const labels = () => tree!.root.findAllByType(Text).map((t) => t.props.children);
  return { tree: tree!, onChange, labels };
}

describe('SearchRow', () => {
  it('is an ordinary text field on a device with no keyboard attached', () => {
    const { tree } = render(false);
    expect(tree.root.findAllByType(TextInput)).toHaveLength(1);
  });

  // The load-bearing assertion of the whole feature. A TextInput here would
  // take focus from the wedge sink, and scanning would stop the moment someone
  // touched the search box.
  it('renders NO text input at all when the keypad is in use', () => {
    const { tree } = render(true);
    expect(tree.root.findAllByType(TextInput)).toHaveLength(0);
  });

  it('renders no text input even with the keypad open', () => {
    const { tree } = render(true, '', true);
    expect(tree.root.findAllByType(TextInput)).toHaveLength(0);
  });

  // The keypad now docks at the screen root (see the dock-fix mockup); the row
  // itself must never mount it into the scroll flow again.
  it('never renders the keypad itself — the screen owns the dock', () => {
    const { tree } = render(true, '', true);
    expect(tree.root.findAllByType(SearchKeypad)).toHaveLength(0);
  });

  it('asks the screen to open the keypad when the field is tapped', () => {
    const onOpen = jest.fn();
    const { tree } = render(true, '', false, onOpen);
    act(() => { findPressables(tree)[0].props.onPress(); });
    expect(onOpen).toHaveBeenCalledWith(true);
  });

  it('says how to use it while it is closed and empty', () => {
    expect(render(true).labels()).toContain('Tap to type, or scan');
  });

  it('shows the typed text instead of the prompt', () => {
    expect(render(true, 'shea').labels()).toContain('shea');
  });

  // The promise the whole design turns on, and it must be visible in the world
  // that needs it and absent from the one that does not.
  it('promises the scanner is still live in the keypad world', () => {
    expect(render(true).labels()).toContain('Scanner ready');
  });

  it('makes no such promise on a device with no scanner', () => {
    expect(render(false).labels()).not.toContain('Scanner ready');
  });

  // POS's field is deliberately bigger than Inventory's -- read at arm's
  // length in shop lighting rather than at a desk. This locks the relative
  // size in so a future edit to the shared row can't silently flatten it.
  it('makes the counter field taller than the desk field', () => {
    const fieldHeight = (tree: ReactTestRenderer) => {
      const field = tree.root.findAllByType(TextInput)[0];
      const flat = StyleSheet.flatten(field.props.style);
      return flat.height;
    };

    let deskTree: ReactTestRenderer | undefined;
    act(() => {
      deskTree = create(
        <SearchRow value="" onChange={jest.fn()} onSubmit={jest.fn()} placeholder="Search"
          useKeypad={false} showScanButton={false} keypadOpen={false} onKeypadOpenChange={jest.fn()} />,
      );
    });

    let counterTree: ReactTestRenderer | undefined;
    act(() => {
      counterTree = create(
        <SearchRow value="" onChange={jest.fn()} onSubmit={jest.fn()} placeholder="Search"
          useKeypad={false} showScanButton={false} keypadOpen={false} onKeypadOpenChange={jest.fn()} size="counter" />,
      );
    });

    expect(fieldHeight(counterTree!)).toBeGreaterThan(fieldHeight(deskTree!));
  });
});

describe('useSearchKeypadState', () => {
  function Probe({ useKeypad, onState }: { useKeypad: boolean; onState: (s: ReturnType<typeof useSearchKeypadState>) => void }) {
    onState(useSearchKeypadState(useKeypad));
    return <Text>probe</Text>;
  }

  function renderHook(useKeypad: boolean) {
    let latest: ReturnType<typeof useSearchKeypadState> | undefined;
    let tree: ReactTestRenderer | undefined;
    const el = (u: boolean) => <Probe useKeypad={u} onState={(s) => { latest = s; }} />;
    act(() => { tree = create(el(useKeypad)); });
    return {
      state: () => latest!,
      rerender: (u: boolean) => act(() => { tree!.update(el(u)); }),
    };
  }

  it('starts closed and opens on request', () => {
    const h = renderHook(true);
    expect(h.state().keypadOpen).toBe(false);
    act(() => { h.state().setKeypadOpen(true); });
    expect(h.state().keypadOpen).toBe(true);
  });

  // Someone unplugs the scanner mid-sale. Closing rather than merely hiding
  // means plugging it back in does not silently reopen a keypad nobody asked
  // for, on top of the product grid.
  it('closes when the keyboard is unplugged and stays closed when it returns', () => {
    const h = renderHook(true);
    act(() => { h.state().setKeypadOpen(true); });
    h.rerender(false);
    expect(h.state().keypadOpen).toBe(false);
    h.rerender(true);
    expect(h.state().keypadOpen).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- src/components/__tests__/search-row.test.tsx`
Expected: FAIL — `useSearchKeypadState` is not exported; `onKeypadOpenChange` prop unknown; keypad tests find `SearchKeypad` mounted.

- [ ] **Step 3: Rewrite `SearchRow`**

In `src/components/search-row.tsx`:

Remove the `SearchKeypad` import and add the hook export. Replace the component's state and keypad-branch with the controlled form. The full changed region (imports through end of component — styles are untouched):

```tsx
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { Colors } from '@/constants/theme';

const theme = Colors.light;

/**
 * Keypad open/closed, owned by the SCREEN rather than the row: the keypad
 * renders as a bottom dock at the screen root (a flex sibling of the
 * ScrollView), which the row cannot reach from inside the scroll flow.
 *
 * The unplug rule lives here so both screens inherit it: the scanner can be
 * unplugged with the keypad open, and closing rather than merely hiding means
 * plugging it back in does not silently reopen a keypad nobody asked for.
 */
export function useSearchKeypadState(useKeypad: boolean) {
  const [keypadOpen, setKeypadOpen] = useState(false);
  useEffect(() => {
    if (!useKeypad) setKeypadOpen(false);
  }, [useKeypad]);
  return { keypadOpen, setKeypadOpen };
}

/**
 * The search box, in its two worlds.
 *
 * With no hardware keyboard attached this is exactly what it has always been:
 * a `TextInput` and the system keyboard.
 *
 * With one attached it is NOT a `TextInput`, and that is the point rather than
 * a shortcut. A text field would take focus, and focus is what `WedgeSink`
 * needs to catch scans -- so touching the search box would stop the scanner
 * working. Rendering a `Pressable` and driving the text from our own keypad
 * means the field never asks for focus, the wedge keeps it, and a barcode
 * scanned mid-word still lands. Both work at once instead of taking turns.
 */
export function SearchRow({
  value,
  onChange,
  onSubmit,
  placeholder,
  useKeypad,
  showScanButton,
  onScanPress,
  showSearchIcon = false,
  size = 'desk',
  keypadOpen,
  onKeypadOpenChange,
}: {
  value: string;
  onChange: (next: string) => void;
  onSubmit: () => void;
  placeholder: string;
  /** True only when a keyboard is CONFIRMED attached. See `resolveScannerSettings`. */
  useKeypad: boolean;
  showScanButton: boolean;
  onScanPress?: () => void;
  /** POS draws a leading glyph; Inventory does not. Keeps both looking as they do. */
  showSearchIcon?: boolean;
  /**
   * `counter` is the POS register: a bigger field and a bigger scan target,
   * because it is read at arm's length in shop lighting and pressed at a
   * counter rather than at a desk. `desk` is Inventory's.
   */
  size?: 'desk' | 'counter';
  /** From `useSearchKeypadState`. The screen renders the dock; the row only shows the caret. */
  keypadOpen: boolean;
  onKeypadOpenChange: (open: boolean) => void;
}) {
  const counter = size === 'counter';
  const icon = showSearchIcon ? (
    <Text style={[styles.icon, counter && styles.iconCounter]}>⌕</Text>
  ) : null;
  const scanButton = showScanButton ? (
    <Pressable
      onPress={onScanPress}
      style={[styles.scanButton, counter && styles.scanButtonCounter]}
      accessibilityLabel="Scan a barcode"
    >
      <Text style={[styles.scanGlyph, counter && styles.scanGlyphCounter]}>⛶</Text>
    </Pressable>
  ) : null;

  if (!useKeypad) {
    return (
      <View style={styles.wrap}>
        {icon}
        <TextInput
          value={value}
          onChangeText={onChange}
          placeholder={placeholder}
          placeholderTextColor={theme.bentoMuted2}
          style={[styles.field, showSearchIcon && styles.fieldWithIcon, showScanButton && styles.fieldWithScan, counter && styles.fieldCounter]}
          onSubmitEditing={onSubmit}
          // A wedge scanner fires this on its trailing Enter; keeping focus
          // means the next scan lands here too instead of nowhere.
          blurOnSubmit={false}
          returnKeyType="search"
          autoCapitalize="none"
          autoCorrect={false}
        />
        {scanButton}
      </View>
    );
  }

  return (
    <>
      <View style={styles.wrap}>
        {icon}
        <Pressable
          onPress={() => onKeypadOpenChange(true)}
          style={[styles.field, styles.fieldTappable, showSearchIcon && styles.fieldWithIcon, showScanButton && styles.fieldWithScan, counter && styles.fieldCounter]}
          accessibilityRole="search"
        >
          {value ? (
            <Text style={styles.text} numberOfLines={1}>{value}</Text>
          ) : (
            // Says what it is: a thing you tap, with no cursor of its own.
            <Text style={styles.prompt} numberOfLines={1}>Tap to type, or scan</Text>
          )}
          {/* Our own caret: this is a Pressable, not a text input, so there is
              no system caret to show that it is receiving keys. */}
          {keypadOpen ? <View style={styles.caret} /> : null}
        </Pressable>
        {scanButton}
      </View>

      <View style={styles.live}>
        <View style={styles.liveDot} />
        {/* Green AND the word: colour alone is never the signal (see the bento
            tokens' note on deutan viewers). And it stays true while typing,
            which is the promise the whole design turns on. */}
        <Text style={styles.liveLabel}>Scanner ready</Text>
      </View>
    </>
  );
}
```

(Keep the existing `styles` object exactly as it is.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- src/components/__tests__/search-row.test.tsx`
Expected: PASS. Note: the two screens now fail to typecheck (missing new props) — that is Tasks 2–3, so do **not** run `npx tsc --noEmit` yet.

- [ ] **Step 5: Commit**

```bash
git add src/components/search-row.tsx src/components/__tests__/search-row.test.tsx
git commit -m "refactor: lift keypad state out of SearchRow so screens can dock it"
```

---

### Task 2: Cap the keypad's key width for wide tills

On a tablet the dock's surface should span the screen but the keys must not stretch into a piano — they cap at 560 and centre (mockup frame C).

**Files:**
- Modify: `src/components/search-keypad.tsx`
- Test: `src/components/__tests__/search-keypad.test.tsx` (exists — extend it)

**Interfaces:**
- Consumes: nothing new. `SearchKeypad` props are unchanged.
- Produces: dock DOM shape gains one inner `View` (`styles.inner`) that wraps all rows.

- [ ] **Step 1: Write the failing test**

Append to the existing `describe` in `src/components/__tests__/search-keypad.test.tsx`:

```tsx
  // On a tablet the dock surface spans the screen but the KEYS cap at a
  // phone-ish width and centre -- stretched to tablet width they become a
  // piano and the hand loses the row shape it learned on the phone.
  it('caps the key block width so tablet keys do not stretch', () => {
    const tree = render();
    const capped = tree.root.findAll((node) => {
      const flat = StyleSheet.flatten(node.props?.style);
      return flat?.maxWidth === 560 && flat?.alignSelf === 'center';
    });
    expect(capped.length).toBeGreaterThan(0);
  });
```

Add `StyleSheet` to the test's `react-native` import if it isn't there, and reuse the file's existing `render()` helper (if its helper takes props, pass the same ones the neighbouring tests pass).

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/components/__tests__/search-keypad.test.tsx`
Expected: FAIL — no node carries `maxWidth: 560`.

- [ ] **Step 3: Add the inner wrapper**

In `src/components/search-keypad.tsx`, wrap everything inside the dock in one `View`:

```tsx
  return (
    <View style={styles.dock}>
      <View style={styles.inner}>
        {ROWS.map((row, index) => {
          /* ...existing row rendering, unchanged... */
        })}

        <View style={styles.row}>
          {/* ...existing util row, unchanged... */}
        </View>
      </View>
    </View>
  );
```

And in styles, move `gap` from `dock` to `inner`:

```tsx
  dock: { backgroundColor: theme.bentoSoft, borderTopWidth: 1, borderTopColor: theme.bentoLine, padding: 10 },
  // The dock SURFACE spans the screen; the KEYS cap and centre so a tablet
  // till doesn't stretch them into a piano.
  inner: { width: '100%', maxWidth: 560, alignSelf: 'center', gap: 6 },
```

- [ ] **Step 4: Run the whole keypad suite to verify it passes**

Run: `npm test -- src/components/__tests__/search-keypad.test.tsx`
Expected: PASS, including the pre-existing key-width tests.

- [ ] **Step 5: Commit**

```bash
git add src/components/search-keypad.tsx src/components/__tests__/search-keypad.test.tsx
git commit -m "feat: cap keypad key width so wide tills keep the phone row shape"
```

---

### Task 3: Dock the keypad on Inventory

**Files:**
- Modify: `src/app/(admin)/(tabs)/inventory.tsx` (SearchRow usage ~line 548; screen return ~lines 390–392 and the `</ScrollView>` ~line 636)

**Interfaces:**
- Consumes: `useSearchKeypadState`, new `SearchRow` props, `SearchKeypad` (all from Tasks 1–2).
- Produces: nothing later tasks use.

- [ ] **Step 1: Wire the state and refs**

In the component body (near the other `useState` calls; `scanner` already exists via `useScannerSettings()`):

```tsx
  const { keypadOpen, setKeypadOpen } = useSearchKeypadState(scanner.onScreenKeypad);
  const scrollRef = useRef<ScrollView>(null);
  // Content-relative y of the search row, captured on layout so opening the
  // keypad can bring the row into view — the dock shrinks the viewport, and a
  // row tapped near the bottom would otherwise end up under the dock.
  const searchRowY = useRef(0);
```

Add `useRef` to the react import if missing.

- [ ] **Step 2: Update the SearchRow usage**

Replace the `<SearchRow …/>` at ~line 548 (the wrapper `View` is a direct child of the ScrollView content, so its layout `y` is content-relative):

```tsx
        <View onLayout={(e) => { searchRowY.current = e.nativeEvent.layout.y; }}>
          <SearchRow
            value={search}
            onChange={setSearch}
            onSubmit={handleSearchSubmit}
            // The full list of searchable fields doesn't fit a phone -- it
            // truncated mid-word at "barcod...", which reads as a bug rather
            // than as a hint.
            placeholder={compact ? 'Search or scan a product' : 'Search or scan — name, brand, SKU, barcode, category, or tag'}
            useKeypad={scanner.onScreenKeypad}
            showScanButton={scanner.camera}
            onScanPress={() => setScannerOpen(true)}
            keypadOpen={keypadOpen}
            onKeypadOpenChange={(open) => {
              setKeypadOpen(open);
              // Bring the row to the top of the shrunken viewport so what you
              // type is visible while you type it.
              if (open) scrollRef.current?.scrollTo({ y: Math.max(0, searchRowY.current - 12), animated: true });
            }}
          />
        </View>
```

- [ ] **Step 3: Dock the keypad at the screen root**

Give the ScrollView the ref (~line 392):

```tsx
      <ScrollView ref={scrollRef} contentContainerStyle={styles.content} showsVerticalScrollIndicator={false} refreshControl={pullToRefresh}>
```

Immediately after the matching `</ScrollView>` (~line 636), still inside the `SafeAreaView`:

```tsx
      {/* A flex sibling, not an overlay: the ScrollView shrinks above it, so
          the grid stays scrollable to its last row with the keypad open —
          exactly what the system keyboard does. See the dock-fix mockup. */}
      {keypadOpen && scanner.onScreenKeypad ? (
        <SearchKeypad
          value={search}
          onChange={setSearch}
          onSubmit={handleSearchSubmit}
          onClose={() => setKeypadOpen(false)}
        />
      ) : null}
```

Add `useSearchKeypadState` to the `@/components/search-row` import and keep the existing `SearchKeypad` import path `@/components/search-keypad` (add it — Inventory did not import it before).

- [ ] **Step 4: Typecheck and run the suites**

Run: `npx tsc --noEmit`
Expected: errors only in `pos.tsx` (fixed next task) — none in `inventory.tsx`.
Run: `npm test -- src/components`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(admin)/(tabs)/inventory.tsx"
git commit -m "feat: dock the search keypad at Inventory's screen root"
```

---

### Task 4: Dock the keypad on POS

Same treatment, one wrinkle: on a phone the cart renders ABOVE the browse pane inside the `Split` ScrollView, so the search row's content-relative y is `browsePane.y + rowWrapper.y` (two `onLayout`s, both direct children of what they measure against). On wide layouts `Split` is a plain `View` and no scrolling is needed.

**Files:**
- Modify: `src/app/(admin)/(tabs)/pos.tsx` (browsePaneEl ~lines 562–577; root return ~lines 836–851)

**Interfaces:**
- Consumes: `useSearchKeypadState`, new `SearchRow` props, `SearchKeypad`.
- Produces: nothing later tasks use.

- [ ] **Step 1: Wire state and refs**

In the component body:

```tsx
  const { keypadOpen, setKeypadOpen } = useSearchKeypadState(scanner.onScreenKeypad);
  const splitRef = useRef<ScrollView>(null);
  // Compact POS puts the cart ABOVE the browse pane, so the search row's
  // content-relative y is the pane's y plus the row's y within the pane.
  const browsePaneY = useRef(0);
  const searchRowY = useRef(0);
```

- [ ] **Step 2: Update browsePaneEl**

```tsx
  const browsePaneEl = (
    <View
      style={[styles.browsePane, compact && styles.browsePaneCompact]}
      onLayout={(e) => { browsePaneY.current = e.nativeEvent.layout.y; }}
    >
      <TillKeyboardNotice />

      <View onLayout={(e) => { searchRowY.current = e.nativeEvent.layout.y; }}>
        <SearchRow
          value={search}
          onChange={setSearch}
          onSubmit={handleSearchSubmit}
          placeholder="Search or scan a product"
          useKeypad={scanner.onScreenKeypad}
          showScanButton={scanner.camera}
          onScanPress={() => setScannerOpen(true)}
          showSearchIcon
          size="counter"
          keypadOpen={keypadOpen}
          onKeypadOpenChange={(open) => {
            setKeypadOpen(open);
            // `scrollTo` exists only when Split is the compact ScrollView; on
            // wide layouts nothing scrolls and the row is always visible.
            if (open && compact) splitRef.current?.scrollTo({ y: Math.max(0, browsePaneY.current + searchRowY.current - 12), animated: true });
          }}
        />
      </View>
      {/* ScanFeedbackBanner and the rest unchanged */}
```

- [ ] **Step 3: Dock at the root**

Give `Split` the ref and render the dock after it (~lines 839–851). `Split` is `ScrollView | View`; a `ScrollView` ref is only used behind the `compact` guard above, so type the ref prop with a cast:

```tsx
      <Split ref={splitRef as never} style={[styles.split, compact && styles.splitCompact]} {...splitProps}>
        {compact ? (
          <>
            {cartPaneEl}
            {browsePaneEl}
          </>
        ) : (
          <>
            {browsePaneEl}
            {cartPaneEl}
          </>
        )}
      </Split>
      {/* A flex sibling of the Split, under BOTH panes: the dock belongs to
          the screen, not the search column — the cart stays visible and
          tappable so a cashier can scan or take payment mid-typing. */}
      {keypadOpen && scanner.onScreenKeypad ? (
        <SearchKeypad
          value={search}
          onChange={setSearch}
          onSubmit={handleSearchSubmit}
          onClose={() => setKeypadOpen(false)}
        />
      ) : null}
```

Add imports: `useSearchKeypadState` from `@/components/search-row`, `SearchKeypad` from `@/components/search-keypad`, `useRef` if missing.

- [ ] **Step 4: Typecheck and full test run**

Run: `npx tsc --noEmit`
Expected: clean.
Run: `npm test`
Expected: PASS across the repo.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(admin)/(tabs)/pos.tsx"
git commit -m "feat: dock the search keypad at POS's screen root"
```

---

### Task 5: `DeviceNotice` replaces the Caveat in the till notice

`Caveat` is the sentence that travels with a *number*, and its contract forbids an action on `tone="context"`. The till notice is about a cable and its action is the whole point — it gets its own component. Gates and copy are frozen (Global Constraints).

**Files:**
- Create: `src/components/ui/device-notice.tsx`
- Modify: `src/components/till-keyboard-notice.tsx`
- Test: `src/components/__tests__/till-keyboard-notice.test.tsx`

**Interfaces:**
- Produces: `DeviceNotice` — `{ glyph: string; children: string; action?: { label: string; onPress: () => void }; onDismiss?: () => void }`.
- Produces: the notice's action now pushes `{ pathname: '/settings', params: { nav: 'locations', location: <activeLocation.id> } }` — Task 6 consumes the `location` param.
- Consumes: `useAuth().activeLocation` (already exists: `{ id: string; name: string; … } | null`).

- [ ] **Step 1: Extend the failing tests**

In `src/components/__tests__/till-keyboard-notice.test.tsx`, capture the router mock and add two tests. Change the router mock at the top to:

```tsx
const mockPush = jest.fn();
jest.mock('expo-router', () => ({ useRouter: () => ({ push: mockPush }) }));
```

The `useAuth` mock gains `activeLocation` (the component reads `can` and `activeLocation`):

```tsx
jest.mock('@/hooks/use-auth', () => ({
  useAuth: () => ({
    can: () => mockPermitted,
    activeLocation: { id: 'loc-1', name: 'Hargeisa Main' },
  }),
}));
```

Add to the suite (and `mockPush.mockClear()` in the existing `beforeEach`):

```tsx
  // The Caveat contract forbids an action on tone="context", and this notice
  // is about a cable rather than a number — so it must not render a Caveat.
  it('does not wear the Caveat family uniform', () => {
    let tree: ReactTestRenderer | undefined;
    act(() => { tree = create(<TillKeyboardNotice />); });
    const { Caveat } = jest.requireActual('@/components/ui/caveat');
    expect(tree!.root.findAllByType(Caveat)).toHaveLength(0);
  });

  // The button used to drop the reader on the Locations PANEL and leave them
  // to find the right store; the fix lives in one store's editor, so the
  // action deep-links there.
  it('deep-links the action to the active store, not just the panel', () => {
    let tree: ReactTestRenderer | undefined;
    act(() => { tree = create(<TillKeyboardNotice />); });
    const pressables = tree!.root.findAll((node) => typeof node.props?.onPress === 'function', { deep: true });
    const action = pressables.find((p) => p.findAllByType(Text).some((t) => String(t.props.children).includes('Set up scanning')));
    expect(action).toBeDefined();
    act(() => { action!.props.onPress(); });
    expect(mockPush).toHaveBeenCalledWith({ pathname: '/settings', params: { nav: 'locations', location: 'loc-1' } });
  });
```

Add `Text` to the test's `react-native` imports.

- [ ] **Step 2: Run to verify the new tests fail**

Run: `npm test -- src/components/__tests__/till-keyboard-notice.test.tsx`
Expected: the two new tests FAIL (Caveat found; no "Set up scanning" pressable); the six existing gate tests still PASS.

- [ ] **Step 3: Create `DeviceNotice`**

`src/components/ui/device-notice.tsx`:

```tsx
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Colors } from '@/constants/theme';

// Pinned to the light palette for now — no dark-mode switching yet.
const theme = Colors.light;

// The device is telling you something.
//
// A cousin of `Caveat`, deliberately not a sibling: a caveat is the sentence
// that travels with a NUMBER, its tone is the meaning, and `context` must
// never carry an action. This is for hardware and setup facts — a cable, a
// keyboard, a printer — where the action IS the point. No 4px tone rule and
// no tint: that pair is the caveat family's uniform and it stays theirs. A
// plain white card with a soft glyph well reads one step quieter than a data
// warning.
export function DeviceNotice({
  glyph,
  children,
  action,
  onDismiss,
}: {
  /** One character, e.g. "⌨". Drawn in a soft square well, never colour-coded. */
  glyph: string;
  children: string;
  /** The thing that resolves the notice. Omit when there is nothing to do. */
  action?: { label: string; onPress: () => void };
  /** Lets the reader close it. The CALLER owns what dismissal means. */
  onDismiss?: () => void;
}) {
  return (
    <View style={styles.card}>
      <View style={styles.glyphWell}>
        <Text style={styles.glyph}>{glyph}</Text>
      </View>
      <View style={styles.body}>
        <Text style={styles.text}>{children}</Text>
        {action ? (
          <Pressable onPress={action.onPress} style={styles.action} accessibilityRole="button">
            <Text style={styles.actionLabel}>{action.label}</Text>
          </Pressable>
        ) : null}
      </View>
      {onDismiss ? (
        <Pressable onPress={onDismiss} style={styles.dismiss} accessibilityLabel="Dismiss" accessibilityRole="button">
          <Text style={styles.dismissGlyph}>✕</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: theme.bentoSurface,
    borderRadius: 16,
    padding: 13,
    flexDirection: 'row',
    gap: 10,
    alignItems: 'flex-start',
    marginBottom: 12,
  },
  glyphWell: {
    width: 26,
    height: 26,
    borderRadius: 8,
    backgroundColor: theme.bentoSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  glyph: { fontSize: 13, color: theme.bentoInk2 },
  body: { flex: 1 },
  text: { fontSize: 12, lineHeight: 18, color: theme.bentoInk2 },
  action: {
    alignSelf: 'flex-start',
    marginTop: 7,
    backgroundColor: theme.bentoInk,
    borderRadius: 999,
    paddingHorizontal: 11,
    paddingVertical: 5,
  },
  actionLabel: { fontSize: 11, fontWeight: '800', color: theme.bentoSurface },
  dismiss: { padding: 2 },
  dismissGlyph: { fontSize: 13, color: theme.bentoMuted2 },
});
```

- [ ] **Step 4: Swap it into the till notice**

`src/components/till-keyboard-notice.tsx` — replace the `Caveat` import and the returned JSX (the file-head comment and all four gates stay exactly as they are). New imports and return:

```tsx
import { useRouter } from 'expo-router';

import { DeviceNotice } from '@/components/ui/device-notice';
import { useAuth } from '@/hooks/use-auth';
import { useCaveatDismissal } from '@/hooks/use-caveat-dismissal';
import { useHardwareKeyboard } from '@/hooks/use-hardware-keyboard';
import { useScannerSettings } from '@/hooks/use-scanner-settings';
```

Inside the component, read `activeLocation` alongside `can`:

```tsx
  const { can, activeLocation } = useAuth();
```

And the return:

```tsx
  return (
    <DeviceNotice
      glyph="⌨"
      onDismiss={note.dismiss}
      action={{
        // Names the store so the reader knows where they'll land — the button
        // used to open the Locations panel and leave them to find the row.
        label: activeLocation ? `Set up scanning for ${activeLocation.name}` : 'Set up scanning',
        onPress: () =>
          router.push({
            pathname: '/settings',
            params: activeLocation ? { nav: 'locations', location: activeLocation.id } : { nav: 'locations' },
          }),
      }}
    >
      A keyboard or barcode scanner is connected to this device. If it&apos;s a scanner, turn on
      scanning for this store to use it.
    </DeviceNotice>
  );
```

(`useCaveatDismissal` keeps its name and storage key `'till.keyboard-detected', 'v1'` — renaming the hook would orphan existing dismissals.)

- [ ] **Step 5: Run the suite**

Run: `npm test -- src/components/__tests__/till-keyboard-notice.test.tsx`
Expected: PASS, all eight tests.

- [ ] **Step 6: Commit**

```bash
git add src/components/ui/device-notice.tsx src/components/till-keyboard-notice.tsx src/components/__tests__/till-keyboard-notice.test.tsx
git commit -m "feat: give the till notice its own DeviceNotice instead of a mis-toned Caveat"
```

---

### Task 6: Settings deep-link — land in the store's editor

**Files:**
- Modify: `src/app/(admin)/settings.tsx` (params ~line 54, LocationsPanel case ~line 190)
- Modify: `src/components/settings/panels/locations-panel.tsx` (props ~line 26, state ~line 35)
- Test: `src/components/settings/panels/__tests__/locations-panel.test.tsx` (create)

**Interfaces:**
- Consumes: the `location` URL param produced by Task 5.
- Produces: `LocationsPanel` gains optional prop `initialLocationId?: string`.

- [ ] **Step 1: Write the failing test**

Create `src/components/settings/panels/__tests__/locations-panel.test.tsx`:

```tsx
import { Text } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { LocationsPanel } from '@/components/settings/panels/locations-panel';
import type { ShopLocation } from '@/types/models';

jest.mock('@/hooks/use-auth', () => ({
  useAuth: () => ({ limitFor: () => null, usageOf: () => 0 }),
}));

const store = (id: string, name: string): ShopLocation =>
  ({
    id,
    name,
    code: null,
    address: null,
    neighborhood: null,
    city: null,
    contactPhone: null,
    zaadMerchantId: null,
    edahabMerchantId: null,
    openingHours: {},
    monthlyRevenueGoalCents: null,
    barcodeScanningEnabled: true,
    hardwareScannerEnabled: false,
    requireOpenRegister: false,
    active: true,
    isPrimary: true,
  }) as ShopLocation;

function render(initialLocationId?: string, locations: ShopLocation[] = [store('loc-1', 'Hargeisa Main')]) {
  let tree: ReactTestRenderer | undefined;
  const el = (locs: ShopLocation[]) => (
    <LocationsPanel shopId="shop-1" locations={locs} onChange={jest.fn()} initialLocationId={initialLocationId} />
  );
  act(() => { tree = create(el(locations)); });
  return {
    tree: tree!,
    update: (locs: ShopLocation[]) => act(() => { tree!.update(el(locs)); }),
    texts: () => tree!.root.findAllByType(Text).map((t) => t.props.children),
  };
}

describe('LocationsPanel deep-link', () => {
  // The till notice sends the reader here to flip ONE switch in ONE store;
  // landing on the list and hunting for the row loses half of them.
  it('opens the editor for the store the URL names', () => {
    expect(render('loc-1').texts()).toContain('Edit store');
  });

  it('stays on the list when no store is named', () => {
    expect(render(undefined).texts()).not.toContain('Edit store');
  });

  it('stays on the list when the named store does not exist', () => {
    expect(render('loc-gone').texts()).not.toContain('Edit store');
  });

  // Settings loads locations async: the panel can mount with an empty list
  // and receive the rows a beat later. The editor must still open — once.
  it('opens once the named store arrives, and only once', () => {
    const r = render('loc-1', []);
    expect(r.texts()).not.toContain('Edit store');
    r.update([store('loc-1', 'Hargeisa Main')]);
    expect(r.texts()).toContain('Edit store');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- src/components/settings/panels/__tests__/locations-panel.test.tsx`
Expected: FAIL — `initialLocationId` is not a prop; no editor opens.

- [ ] **Step 3: Implement the panel side**

In `src/components/settings/panels/locations-panel.tsx`, extend the signature and seed/react to the id. `useEffect` joins the react import:

```tsx
export function LocationsPanel({
  shopId,
  locations,
  onChange,
  initialLocationId,
}: {
  shopId: string;
  locations: ShopLocation[];
  onChange: () => Promise<void>;
  /** Deep-link: open this store's editor on arrival. See TillKeyboardNotice. */
  initialLocationId?: string;
}) {
  const [editing, setEditing] = useState<ShopLocation | 'new' | null>(null);
  // Consumed at most once: Settings loads locations async, so the named store
  // can arrive a beat after mount — but closing the editor must not reopen it.
  const [consumedInitial, setConsumedInitial] = useState(false);
  useEffect(() => {
    if (consumedInitial || !initialLocationId) return;
    const match = locations.find((location) => location.id === initialLocationId);
    if (match) {
      setEditing(match);
      setConsumedInitial(true);
    }
  }, [consumedInitial, initialLocationId, locations]);
```

(The rest of the component is unchanged.)

- [ ] **Step 4: Implement the settings side**

In `src/app/(admin)/settings.tsx` (~line 54), widen the params type:

```tsx
  const params = useLocalSearchParams<{ nav?: string; location?: string }>();
```

And the `'locations'` case (~line 190):

```tsx
      case 'locations':
        return (
          <LocationsPanel
            shopId={shop.id}
            locations={allLocations}
            onChange={async () => { await reload(); await refreshShop(); }}
            initialLocationId={typeof params.location === 'string' ? params.location : undefined}
          />
        );
```

- [ ] **Step 5: Run tests and typecheck**

Run: `npm test -- src/components/settings/panels/__tests__/locations-panel.test.tsx`
Expected: PASS.
Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/components/settings/panels/locations-panel.tsx "src/app/(admin)/settings.tsx" src/components/settings/panels/__tests__/locations-panel.test.tsx
git commit -m "feat: deep-link the till notice into the named store's editor"
```

---

### Task 7: Hardware-keyboard hook — cover the web and unmount branches

**Files:**
- Test: `src/hooks/__tests__/use-hardware-keyboard.test.tsx` (extend)

**Interfaces:** none — tests only; the hook is unchanged.

- [ ] **Step 1: Write the two failing-or-passing tests**

Append inside the existing `describe` (the file's mock already tracks `listeners`; add a call counter to the `isAttached` mock by changing that line to `isAttached: () => { mockReads += 1; return mockAttached; }`, declaring `let mockReads = 0;` beside the other `mock` variables, and resetting `mockReads = 0;` in the `beforeEach`):

```tsx
  // Web has no native module and no hardware-keyboard concept the app trusts;
  // the answer is null — unknown — and the module must never be touched.
  it('answers null on web without touching the module', () => {
    const original = Platform.OS;
    Object.defineProperty(Platform, 'OS', { value: 'web', configurable: true });
    try {
      expect(render().at(-1)).toBeNull();
      expect(mockReads).toBe(0);
      expect(listeners).toHaveLength(0);
    } finally {
      Object.defineProperty(Platform, 'OS', { value: original, configurable: true });
    }
  });

  it('stops listening when the screen unmounts', () => {
    let tree: ReactTestRenderer | undefined;
    act(() => { tree = create(<Probe onValue={() => {}} />); });
    expect(listeners).toHaveLength(1);
    act(() => { tree!.unmount(); });
    expect(listeners).toHaveLength(0);
  });
```

Add `Platform` to the `react-native` import and `type ReactTestRenderer` to the `react-test-renderer` import.

- [ ] **Step 2: Run — these should pass against the current hook**

Run: `npm test -- src/hooks/__tests__/use-hardware-keyboard.test.tsx`
Expected: PASS (the hook already handles both branches; the tests close the coverage gap the review named). If either FAILS, the hook has a real bug — stop and investigate rather than bending the test.

- [ ] **Step 3: Commit**

```bash
git add src/hooks/__tests__/use-hardware-keyboard.test.tsx
git commit -m "test: cover the hardware-keyboard hook's web and unmount branches"
```

---

### Task 8: Module cosmetics — podspec

**Files:**
- Modify: `modules/hardware-keyboard/ios/HardwareKeyboard.podspec`

**Interfaces:** none.

- [ ] **Step 1: Replace the template strings and pin the version**

The podspec still carries the Expo module template's placeholders, and its `1.0.0` disagrees with `android/build.gradle`'s `0.1.0`. Change the top of the spec to:

```ruby
Pod::Spec.new do |s|
  s.name           = 'HardwareKeyboard'
  s.version        = '0.1.0'
  s.summary        = 'Reports whether a hardware keyboard is attached'
  s.description    = 'Watches GCKeyboard so the app knows when a physical keyboard — or a HID barcode scanner, which iOS treats as one — connects or disconnects.'
  s.author         = ''
  s.homepage       = 'https://docs.expo.dev/modules/'
```

(Everything from `s.platforms` down is unchanged.)

- [ ] **Step 2: Verify nothing else references the old version**

Run: `grep -rn "1.0.0" modules/hardware-keyboard/`
Expected: no matches.

- [ ] **Step 3: Commit**

```bash
git add modules/hardware-keyboard/ios/HardwareKeyboard.podspec
git commit -m "chore: give the hardware-keyboard podspec its real summary and version"
```

---

### Task 9: Verify on the simulator — the gate for the whole branch

Native layout bugs are settled by screenshots, not code reading (and a stale bundle can fake a failure — reload before judging). The iOS simulator can fake the scanner: **I/O → Keyboard → Connect Hardware Keyboard** raises `GCKeyboardDidConnect` exactly like a real HID scanner.

**Files:** none.

- [ ] **Step 1: Launch on an iPhone-size simulator**

Run: `npm run ios` (or attach to the running Metro — the dev server picks edits up instantly).

- [ ] **Step 2: Walk the checklist, screenshotting each state**

1. Settings → Store locations → the store → "This store has a barcode scanner" ON.
2. Toggle simulator hardware keyboard ON → Inventory shows the dashed field + "Scanner ready".
3. Tap the field → **the keypad rises from the bottom edge as a dock; the search row scrolls into view; every key row and Done are visible.**
4. Scroll the grid with the keypad open → the last product row is reachable above the dock.
5. POS (phone width): tap the field → dock appears under both panes; typing filters; the cart is still tappable.
6. Rotate / iPad-size simulator: keys cap at 560 and centre; dock surface spans.
7. Toggle the store setting OFF, keyboard still attached → the DeviceNotice card shows (white card, ⌨ well, "Set up scanning for <store>" pill) → tapping it lands **inside that store's editor** with the scanner toggle on screen.
8. Toggle simulator hardware keyboard OFF with the keypad open → keypad closes, field reverts to a normal TextInput.

- [ ] **Step 3: Commit nothing — this task produces evidence, not code**

If any step fails, fix under the task that owns that surface before merging.

---

## Deferred — needs hardware, not code

**GCKeyboard wrong-false.** `resolveScannerSettings` gates the wedge with `hardwareSetting && (keyboardAttached ?? true)`, so a real HID scanner that iOS does *not* surface as a `GCKeyboard` would silently lose scanning it has today — and the same till would get no keypad and possibly no system keyboard either (UIKit's decision to hide the keyboard is a different channel from GameController's detection). Whether such scanners exist is empirical. **Protocol:** with a real USB and a real Bluetooth HID scanner on a physical iPad/iPhone: (1) attach; (2) check the dashed field + "Scanner ready" appear (that proves `GCKeyboard` saw it); (3) scan into the wedge. If any real scanner scans but never trips detection, change the gate policy so confirmed-`false` is treated as `null` (trust `true`, distrust `false`) in `resolveScannerSettings` — one line each for `hardware` and `onScreenKeypad`, plus the six-case table in `src/lib/__tests__/scanner-settings.test.ts`.

## Deliberately untouched

- **"Scanner ready"** — approved copy (mockup line 411 of the original), shown only where the store itself asserted scanning.
- **Keyboards for other fields** (drawer counts, discounts, points) — the spec scoped the keypad to search; a general keypad is its own feature and backlog entry, not a rider on this fix pass.
