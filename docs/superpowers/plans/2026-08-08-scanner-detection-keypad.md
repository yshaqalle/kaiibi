# Hardware scanner detection and the till keypad — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect whether a physical keyboard is attached to *this device*, gate the barcode wedge on it, and give the one device that has a scanner a way to type.

**Architecture:** A local Expo module reports keyboard presence per device (iOS `GCKeyboard`, Android `InputDevice`) with live connect/disconnect events. A pure resolver turns that plus the store's setting into the flags screens act on. The screens' search row branches: with a confirmed keyboard it becomes a display-only `Pressable` driven by an in-app QWERTY keypad, which means the field never takes focus and the wedge keeps it — so scanning stays live while someone types.

**Tech Stack:** Expo SDK 57, React Native 0.86 (Fabric), TypeScript 6, Jest + jest-expo, react-test-renderer, Swift (GameController), Kotlin (InputManager).

**Spec:** [docs/superpowers/specs/2026-08-08-scanner-detection-keypad-design.md](../specs/2026-08-08-scanner-detection-keypad-design.md)
**Mockup:** [docs/design/scanner-keypad-mockup.html](../../design/scanner-keypad-mockup.html)

## Global Constraints

- **Never hardcode a hex.** Every colour is a token from `src/constants/theme.ts`, read via `const theme = Colors.light`. POS and Inventory are on the bento tokens (`bentoPage`, `bentoSurface`, `bentoSoft`, `bentoRule`, `bentoInk`, `bentoInk2`, `bentoMuted`, `bentoMuted2`, `bentoLine`, `bentoProfit`).
- **`null` means unknown, never false.** `boolean | null` from detection: `null` is "the platform could not answer" and must trust the store setting. Only `=== true` may switch a reader from the system keyboard to ours.
- **Detection is per device, the setting is per store.** `hardwareScannerEnabled` keeps its column and its meaning becomes "this store uses scanners" — permission. No schema change, no migration.
- **Name it honestly.** The module detects a *hardware keyboard*, not a scanner — a HID scanner and a Bluetooth keyboard are indistinguishable. Nothing in code or copy may claim otherwise.
- **iOS deployment target is 16.4** (`ios/Podfile`), so `GCKeyboard` (iOS 14+) needs no availability guard.
- **Copy is fixed by the spec's copy deck.** Use the strings verbatim; they are reproduced in the tasks that need them.
- **Tests run on iOS.** `jest-expo`'s default platform is ios, so `Platform.OS === 'ios'` in every test.
- **Commit after every task.** Message style: `feat:` / `fix:` / `docs:`, imperative, no scope prefix beyond that.

---

## File Structure

| File | Responsibility |
|---|---|
| `modules/hardware-keyboard/expo-module.config.json` | Autolink config naming the Swift and Kotlin classes |
| `modules/hardware-keyboard/index.ts` | Types + a lazy, throw-safe accessor for the native module |
| `modules/hardware-keyboard/ios/HardwareKeyboardModule.swift` | `GCKeyboard` presence + connect/disconnect notifications |
| `modules/hardware-keyboard/android/src/main/java/expo/modules/hardwarekeyboard/HardwareKeyboardModule.kt` | `InputDevice` scan + `InputManager.InputDeviceListener` |
| `src/hooks/use-hardware-keyboard.ts` | React binding: `boolean \| null`, live |
| `src/lib/scanner-settings.ts` | Pure resolver — setting × detection → flags. Where the rules are tested |
| `src/hooks/use-scanner-settings.ts` | Existing hook, rewired to the resolver |
| `src/lib/keypad.ts` | Pure text reducer for keypad presses |
| `src/components/search-keypad.tsx` | The QWERTY keypad. Controlled, holds no text |
| `src/components/search-row.tsx` | The field/keypad branch, used by both screens |
| `src/components/till-keyboard-notice.tsx` | The "keyboard attached, scanning off" prompt |
| `src/components/settings/settings-sidebar.tsx` | Gains an exported nav-id guard for deep linking |
| `src/app/(admin)/settings.tsx` | Seeds its panel from a `nav` search param |
| `src/app/(admin)/(tabs)/inventory.tsx` | Uses `SearchRow` and `TillKeyboardNotice` |
| `src/app/(admin)/(tabs)/pos.tsx` | Uses `SearchRow` and `TillKeyboardNotice` |

**Phase A** is Tasks 1–5 and ships alone: detection, gating, and the prompt. **Phase B** is Tasks 6–9: the keypad. Task 10 is device verification for both.

---

### Task 1: The pure resolver

The rules live here, in a function with no React and no native, so all six cases are testable without a device.

**Files:**
- Create: `src/lib/scanner-settings.ts`
- Test: `src/lib/__tests__/scanner-settings.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `type ScannerSettings = { camera: boolean; hardware: boolean; resolveCodes: boolean; onScreenKeypad: boolean }` and `resolveScannerSettings(input: { camera: boolean; hardwareSetting: boolean; keyboardAttached: boolean | null }): ScannerSettings`.

- [ ] **Step 1: Write the failing test**

Create `src/lib/__tests__/scanner-settings.test.ts`:

```ts
import { resolveScannerSettings } from '@/lib/scanner-settings';

const base = { camera: false, hardwareSetting: true, keyboardAttached: null as boolean | null };

describe('resolveScannerSettings', () => {
  it('mounts the wedge when a keyboard is confirmed', () => {
    const s = resolveScannerSettings({ ...base, keyboardAttached: true });
    expect(s.hardware).toBe(true);
    expect(s.onScreenKeypad).toBe(true);
  });

  // The gate doing its work: a store that uses scanners, on a tablet that has none.
  it('does not mount the wedge on a device with no keyboard', () => {
    const s = resolveScannerSettings({ ...base, keyboardAttached: false });
    expect(s.hardware).toBe(false);
    expect(s.onScreenKeypad).toBe(false);
  });

  // The one case where the two answers diverge, and the reason both exist.
  // An unused invisible input costs nothing; replacing someone's keyboard with
  // ours on a guess costs them their typing.
  it('trusts the setting for the wedge but never for the keypad when detection cannot answer', () => {
    const s = resolveScannerSettings({ ...base, keyboardAttached: null });
    expect(s.hardware).toBe(true);
    expect(s.onScreenKeypad).toBe(false);
  });

  it('gives nothing at all when the store has not enabled scanning', () => {
    for (const keyboardAttached of [true, false, null]) {
      const s = resolveScannerSettings({ ...base, hardwareSetting: false, keyboardAttached });
      expect(s.hardware).toBe(false);
      expect(s.onScreenKeypad).toBe(false);
    }
  });

  // Deliberately NOT gated on detection. Someone typing a barcode by hand and
  // pressing Enter expects it to find the product, and that is true on a
  // tablet with no scanner attached to it. Gating this would be a regression
  // dressed up as a fix.
  it('still resolves typed codes on a device with no scanner', () => {
    const s = resolveScannerSettings({ ...base, keyboardAttached: false });
    expect(s.resolveCodes).toBe(true);
  });

  it('resolves typed codes for a camera-only store', () => {
    const s = resolveScannerSettings({ camera: true, hardwareSetting: false, keyboardAttached: false });
    expect(s.resolveCodes).toBe(true);
    expect(s.hardware).toBe(false);
  });

  it('resolves nothing when neither method is on', () => {
    const s = resolveScannerSettings({ camera: false, hardwareSetting: false, keyboardAttached: true });
    expect(s.resolveCodes).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npx jest src/lib/__tests__/scanner-settings.test.ts
```

Expected: FAIL — `Cannot find module '@/lib/scanner-settings'`.

- [ ] **Step 3: Write the resolver**

Create `src/lib/scanner-settings.ts`:

```ts
export type ScannerSettings = {
  /** Show the Scan buttons and allow the camera scanner to open. */
  camera: boolean;
  /** Watch the keyboard for a wedge scanner typing into the screen. */
  hardware: boolean;
  /** Whether a typed or scanned code in a search box resolves as a scan. */
  resolveCodes: boolean;
  /** Replace the system keyboard with our own on this device. */
  onScreenKeypad: boolean;
};

/**
 * Two questions, answered from the same two inputs and deliberately not the
 * same way.
 *
 * `hardware` can afford optimism. When detection cannot answer, mounting the
 * wedge on a device with no scanner costs one unused invisible input, and NOT
 * mounting it would silently stop a shop that scans happily today.
 *
 * `onScreenKeypad` cannot. It replaces the system keyboard, so a wrong `true`
 * takes typing away from someone who had it. Only a confirmed answer earns
 * that, which is why `null` and `false` land the same way here and do not
 * above.
 *
 * `resolveCodes` is answered from the SETTING alone, with detection nowhere
 * near it: someone typing a barcode by hand and pressing Enter expects it to
 * find the product, and that is just as true on a tablet with no scanner.
 */
export function resolveScannerSettings({
  camera,
  hardwareSetting,
  keyboardAttached,
}: {
  camera: boolean;
  hardwareSetting: boolean;
  keyboardAttached: boolean | null;
}): ScannerSettings {
  return {
    camera,
    hardware: hardwareSetting && (keyboardAttached ?? true),
    resolveCodes: camera || hardwareSetting,
    onScreenKeypad: hardwareSetting && keyboardAttached === true,
  };
}
```

- [ ] **Step 4: Run it and watch it pass**

```bash
npx jest src/lib/__tests__/scanner-settings.test.ts
```

Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/scanner-settings.ts src/lib/__tests__/scanner-settings.test.ts
git commit -m "feat: resolve scanner settings from the store setting and the device"
```

---

### Task 2: The local Expo module

Native code, so nothing here is unit-testable — it is verified on a device in Task 10. Keep it minimal for that reason.

**Files:**
- Create (via generator, then replaced): `modules/hardware-keyboard/`
- Create: `modules/hardware-keyboard/expo-module.config.json`
- Create: `modules/hardware-keyboard/index.ts`
- Create: `modules/hardware-keyboard/ios/HardwareKeyboardModule.swift`
- Create: `modules/hardware-keyboard/android/src/main/java/expo/modules/hardwarekeyboard/HardwareKeyboardModule.kt`

**Interfaces:**
- Consumes: nothing.
- Produces: `getHardwareKeyboardModule(): HardwareKeyboardModule | null` from `modules/hardware-keyboard`, where `HardwareKeyboardModule` has `isAttached(): boolean` and `addListener('onChange', (event: { attached: boolean }) => void)`. Returns `null` when the native side is absent.

- [ ] **Step 1: Generate the scaffold, non-interactively**

Every prompt this tool would otherwise ask is passed as a flag, so it runs unattended. `--features Function Event` is doing real work: it generates exactly the two things this module needs and, by omitting `View`, produces no native view files to delete afterwards.

```bash
cd /Users/yusefs/development/kaiibi && npx create-expo-module@latest --local hardware-keyboard \
  --name HardwareKeyboard \
  --description "Reports whether a physical keyboard is attached to this device" \
  --package expo.modules.hardwarekeyboard \
  --platform apple android \
  --features Function Event
```

- [ ] **Step 2: Confirm what it generated**

```bash
ls -R modules/hardware-keyboard
```

Expected: a `modules/hardware-keyboard/` directory holding `expo-module.config.json`, an `index.ts` or `src/`, `ios/` and `android/`.

If the directory came out under a different name, rename it to `hardware-keyboard` before continuing — later steps and `src/hooks/use-hardware-keyboard.ts` import that exact path.

Delete any web or types stub the generator left behind, since this module has no web half:

```bash
rm -f modules/hardware-keyboard/src/*.web.ts modules/hardware-keyboard/src/*.types.ts
```

Steps 3–6 below then REPLACE the generated `expo-module.config.json`, Swift, Kotlin and TypeScript with the contents given. If the generator put the TS in `src/index.ts` rather than `index.ts`, keep its location and write the Step 6 contents there — but make sure `modules/hardware-keyboard/index.ts` is what resolves, adding a one-line re-export if needed.

- [ ] **Step 3: Write the module config**

Replace `modules/hardware-keyboard/expo-module.config.json` with exactly:

```json
{
  "platforms": ["apple", "android"],
  "apple": {
    "modules": ["HardwareKeyboardModule"]
  },
  "android": {
    "modules": ["expo.modules.hardwarekeyboard.HardwareKeyboardModule"]
  }
}
```

Web is absent on purpose: the web build has a real global key listener (`src/hooks/use-barcode-wedge.ts`) and never needs this. `getHardwareKeyboardModule()` returns `null` there, which resolves to unknown, which is correct.

- [ ] **Step 4: Write the iOS module**

Replace `modules/hardware-keyboard/ios/HardwareKeyboardModule.swift` with:

```swift
import ExpoModulesCore
import GameController

// Is a physical keyboard attached to THIS device?
//
// A HID barcode scanner is a keyboard as far as the OS is concerned, which is
// the whole reason this exists -- and also why it must never claim to have
// found a *scanner*. It has found a keyboard. Something else decides what that
// means.
//
// GCKeyboard is iOS 14+; the app's deployment target is 16.4 (ios/Podfile), so
// no availability guard is needed.
public class HardwareKeyboardModule: Module {
  public func definition() -> ModuleDefinition {
    Name("HardwareKeyboard")

    Events("onChange")

    // `coalesced` is the Swift-projected name for Objective-C's
    // `coalescedKeyboard` class property, because Swift automatically strips the
    // redundant type-name suffix when importing. `GCKeyboard.coalescedKeyboard`
    // is not valid Swift and will not compile.
    Function("isAttached") { () -> Bool in
      return GCKeyboard.coalesced != nil
    }

    OnStartObserving {
      NotificationCenter.default.addObserver(
        self,
        selector: #selector(self.keyboardDidConnect),
        name: .GCKeyboardDidConnect,
        object: nil
      )
      NotificationCenter.default.addObserver(
        self,
        selector: #selector(self.keyboardDidDisconnect),
        name: .GCKeyboardDidDisconnect,
        object: nil
      )
    }

    OnStopObserving {
      NotificationCenter.default.removeObserver(self)
    }
  }

  @objc
  private func keyboardDidConnect() {
    sendEvent("onChange", ["attached": true])
  }

  @objc
  private func keyboardDidDisconnect() {
    // Read through rather than assuming false: a device can have two keyboards
    // attached, and one going away does not mean none are left.
    sendEvent("onChange", ["attached": GCKeyboard.coalesced != nil])
  }
}
```

- [ ] **Step 5: Write the Android module**

Replace `modules/hardware-keyboard/android/src/main/java/expo/modules/hardwarekeyboard/HardwareKeyboardModule.kt` with:

```kotlin
package expo.modules.hardwarekeyboard

import android.content.Context
import android.hardware.input.InputManager
import android.view.InputDevice
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

// Is a physical keyboard attached to THIS device? See the iOS twin for why
// this reports a keyboard and never a scanner.
class HardwareKeyboardModule : Module() {
  private val inputManager: InputManager?
    get() = appContext.reactContext?.getSystemService(Context.INPUT_SERVICE) as? InputManager

  private val listener = object : InputManager.InputDeviceListener {
    override fun onInputDeviceAdded(deviceId: Int) = emitState()
    override fun onInputDeviceRemoved(deviceId: Int) = emitState()
    override fun onInputDeviceChanged(deviceId: Int) = emitState()
  }

  // `isVirtual` is not optional here: Android's own on-screen keyboard reports
  // as an input device with SOURCE_KEYBOARD, so counting it would make every
  // phone in the world claim a hardware keyboard.
  private fun isAttached(): Boolean = InputDevice.getDeviceIds().any { id ->
    val device = InputDevice.getDevice(id) ?: return@any false
    !device.isVirtual &&
      (device.sources and InputDevice.SOURCE_KEYBOARD) == InputDevice.SOURCE_KEYBOARD &&
      device.keyboardType == InputDevice.KEYBOARD_TYPE_ALPHABETIC
  }

  private fun emitState() {
    sendEvent("onChange", mapOf("attached" to isAttached()))
  }

  override fun definition() = ModuleDefinition {
    Name("HardwareKeyboard")

    Events("onChange")

    Function("isAttached") { isAttached() }

    OnStartObserving { inputManager?.registerInputDeviceListener(listener, null) }

    OnStopObserving { inputManager?.unregisterInputDeviceListener(listener) }
  }
}
```

- [ ] **Step 6: Write the JS binding**

Replace `modules/hardware-keyboard/index.ts` with:

```ts
import { NativeModule, requireNativeModule } from 'expo';

export type HardwareKeyboardEvents = {
  onChange(event: { attached: boolean }): void;
};

export declare class HardwareKeyboardModule extends NativeModule<HardwareKeyboardEvents> {
  isAttached(): boolean;
}

// Required lazily and cached, because `requireNativeModule` THROWS when the
// native half is missing -- which is the ordinary case for a JS bundle loaded
// into a binary built before this module existed. That must degrade to "we
// cannot answer", not take the app down on import.
let cached: HardwareKeyboardModule | null | undefined;

export function getHardwareKeyboardModule(): HardwareKeyboardModule | null {
  if (cached === undefined) {
    try {
      cached = requireNativeModule<HardwareKeyboardModule>('HardwareKeyboard');
    } catch {
      cached = null;
    }
  }
  return cached;
}
```

- [ ] **Step 7: Verify it compiles into a build**

```bash
npx expo run:ios --device "iPhone 17 Pro Max"
```

Expected: `Build Succeeded`, app launches. The module does nothing yet — this step only proves the Swift compiles and autolinks.

- [ ] **Step 8: Commit**

```bash
git add modules/hardware-keyboard ios android
git commit -m "feat: add a local module reporting hardware keyboard presence"
```

---

### Task 3: The hook, and rewiring `useScannerSettings`

**Files:**
- Create: `src/hooks/use-hardware-keyboard.ts`
- Modify: `src/hooks/use-scanner-settings.ts`
- Test: `src/hooks/__tests__/use-hardware-keyboard.test.tsx`

**Interfaces:**
- Consumes: `getHardwareKeyboardModule()` (Task 2), `resolveScannerSettings()` and `ScannerSettings` (Task 1).
- Produces: `useHardwareKeyboard(): boolean | null`. `useScannerSettings(): ScannerSettings` — same name and call sites as today, now with a fourth field.

- [ ] **Step 1: Write the failing test**

Create `src/hooks/__tests__/use-hardware-keyboard.test.tsx`:

```tsx
import { Text } from 'react-native';
import { act, create } from 'react-test-renderer';

import { useHardwareKeyboard } from '@/hooks/use-hardware-keyboard';

const listeners: ((event: { attached: boolean }) => void)[] = [];
// `mock`-prefixed on purpose, and not cosmetic: `jest.mock()` is hoisted above
// these declarations, and `babel-plugin-jest-hoist` REFUSES to compile a
// factory that closes over an out-of-scope `let` unless its name begins with
// `mock`. Rename these and the suite fails to transform at all.
let mockAttached = false;
let mockModulePresent = true;

jest.mock('../../../modules/hardware-keyboard', () => ({
  getHardwareKeyboardModule: () =>
    mockModulePresent
      ? {
          isAttached: () => mockAttached,
          addListener: (_name: string, fn: (event: { attached: boolean }) => void) => {
            listeners.push(fn);
            return { remove: () => { listeners.length = 0; } };
          },
        }
      : null,
}));

function Probe({ onValue }: { onValue: (v: boolean | null) => void }) {
  onValue(useHardwareKeyboard());
  return <Text>probe</Text>;
}

function render() {
  const seen: (boolean | null)[] = [];
  act(() => { create(<Probe onValue={(v) => seen.push(v)} />); });
  return seen;
}

describe('useHardwareKeyboard', () => {
  beforeEach(() => { listeners.length = 0; mockAttached = false; mockModulePresent = true; });

  it('reports what the device says on mount', () => {
    mockAttached = true;
    expect(render().at(-1)).toBe(true);
  });

  it('follows a keyboard being connected while a screen is open', () => {
    const seen = render();
    expect(seen.at(-1)).toBe(false);
    act(() => { listeners.forEach((fn) => fn({ attached: true })); });
    expect(seen.at(-1)).toBe(true);
  });

  // A JS bundle running on a binary built before the module existed. This is
  // the case the whole `null` contract exists for, and it must not throw.
  it('answers null when the native module is missing', () => {
    mockModulePresent = false;
    expect(render().at(-1)).toBeNull();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npx jest src/hooks/__tests__/use-hardware-keyboard.test.tsx
```

Expected: FAIL — `Cannot find module '@/hooks/use-hardware-keyboard'`.

- [ ] **Step 3: Write the hook**

Create `src/hooks/use-hardware-keyboard.ts`:

```ts
import { useEffect, useState } from 'react';
import { Platform } from 'react-native';

import { getHardwareKeyboardModule } from '../../modules/hardware-keyboard';

// Is a physical keyboard attached right now?
//
//   true  -- one is, confirmed by the OS
//   false -- none is, confirmed by the OS
//   null  -- the platform could not answer: web, or a binary built before the
//            native module existed
//
// `null` is NOT `false`, and callers that collapse the two are wrong in a way
// that is invisible until someone's till stops scanning. See
// `resolveScannerSettings`, which is where the difference is spent.
export function useHardwareKeyboard(): boolean | null {
  const [attached, setAttached] = useState<boolean | null>(read);

  useEffect(() => {
    const module = getHardwareKeyboardModule();
    if (Platform.OS === 'web' || !module) return;

    // Re-read on mount as well as subscribing: the answer can have changed
    // between module load and this screen appearing.
    setAttached(read());
    const subscription = module.addListener('onChange', (event) => setAttached(event.attached));
    return () => subscription.remove();
  }, []);

  return attached;
}

function read(): boolean | null {
  if (Platform.OS === 'web') return null;
  const module = getHardwareKeyboardModule();
  if (!module) return null;
  try {
    return module.isAttached();
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run it and watch it pass**

```bash
npx jest src/hooks/__tests__/use-hardware-keyboard.test.tsx
```

Expected: PASS, 3 tests.

- [ ] **Step 5: Rewire `useScannerSettings`**

Replace the body of `src/hooks/use-scanner-settings.ts` with:

```ts
import { useAuth } from '@/hooks/use-auth';
import { useHardwareKeyboard } from '@/hooks/use-hardware-keyboard';
import { resolveScannerSettings, type ScannerSettings } from '@/lib/scanner-settings';

export type { ScannerSettings };

// The single place that answers "does this till scan?".
//
// Every scan feature routes through here rather than reading the location
// itself, so the answer can't drift between screens -- and so that if the
// setting ever moves (to the business, or to the device) exactly one file
// changes.
//
// Two inputs, and they answer different halves. The STORE setting is
// permission: this shop uses scanners. The DEVICE says whether this particular
// till has one attached -- which the store column cannot express, since a shop
// runs on several devices and usually only one of them scans. The rules for
// combining them are in `resolveScannerSettings`, kept pure so all six cases
// are tested without a device.
export function useScannerSettings(): ScannerSettings {
  const { activeLocation } = useAuth();
  const keyboardAttached = useHardwareKeyboard();

  return resolveScannerSettings({
    camera: activeLocation?.barcodeScanningEnabled ?? false,
    hardwareSetting: activeLocation?.hardwareScannerEnabled ?? false,
    keyboardAttached,
  });
}
```

- [ ] **Step 6: Verify nothing else broke**

```bash
npx tsc --noEmit && npx jest
```

Expected: tsc clean; all suites pass.

- [ ] **Step 7: Commit**

```bash
git add src/hooks/use-hardware-keyboard.ts src/hooks/use-scanner-settings.ts src/hooks/__tests__/use-hardware-keyboard.test.tsx
git commit -m "feat: gate the barcode wedge on a keyboard actually being attached"
```

---

### Task 4: Deep-link a settings panel

Task 5's prompt needs to land the reader on the Locations panel, and `settings.tsx` currently always opens on Profile.

**Files:**
- Modify: `src/components/settings/settings-sidebar.tsx`
- Modify: `src/app/(admin)/settings.tsx`
- Test: `src/components/settings/__tests__/settings-nav.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `isSettingsNavId(value: unknown): value is SettingsNavId`, exported from `@/components/settings/settings-sidebar`.

- [ ] **Step 1: Write the failing test**

Create `src/components/settings/__tests__/settings-nav.test.ts`:

```ts
import { isSettingsNavId } from '@/components/settings/settings-sidebar';

describe('isSettingsNavId', () => {
  it('accepts a real panel id', () => {
    expect(isSettingsNavId('locations')).toBe(true);
  });

  // The guard exists because this value arrives from a URL, where anything
  // can be typed. A bad one must fall back, never render an empty screen.
  it('rejects anything that is not one', () => {
    expect(isSettingsNavId('nonsense')).toBe(false);
    expect(isSettingsNavId(undefined)).toBe(false);
    expect(isSettingsNavId(42)).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npx jest src/components/settings/__tests__/settings-nav.test.ts
```

Expected: FAIL — `isSettingsNavId is not a function`.

- [ ] **Step 3: Add the guard**

In `src/components/settings/settings-sidebar.tsx`, immediately after the `SettingsNavId` type declaration (which ends with `| 'registers';`), add:

```ts
// Listed rather than derived from SETTINGS_NAV: this guard validates a value
// arriving from a URL, and it should keep working if the sidebar is ever
// filtered by permission or reordered.
const SETTINGS_NAV_IDS: SettingsNavId[] = [
  'profile', 'security', 'billing', 'notifications', 'business', 'locations',
  'roles', 'vendors', 'receipt', 'catalog', 'inventory', 'promotions',
  'payments', 'tax', 'loyalty', 'cashiers', 'registers',
];

export function isSettingsNavId(value: unknown): value is SettingsNavId {
  return typeof value === 'string' && (SETTINGS_NAV_IDS as string[]).includes(value);
}
```

- [ ] **Step 4: Seed the panel from the URL**

In `src/app/(admin)/settings.tsx`:

1. Add `useLocalSearchParams` to the existing `expo-router` import.
2. Add `isSettingsNavId` to the existing import from `@/components/settings/settings-sidebar`.
3. Replace line 48 (`const [activeNav, setActiveNav] = useState<SettingsNavId>('profile');`) with:

```tsx
  // Seeded from the URL so something elsewhere can send the reader to the
  // panel it is talking about -- see TillKeyboardNotice. Read once, as the
  // initial value: after that the reader owns which panel is open, and a
  // re-render must not yank them back.
  const params = useLocalSearchParams<{ nav?: string }>();
  const [activeNav, setActiveNav] = useState<SettingsNavId>(
    isSettingsNavId(params.nav) ? params.nav : 'profile',
  );
```

- [ ] **Step 5: Run the tests**

```bash
npx jest src/components/settings/__tests__/settings-nav.test.ts && npx tsc --noEmit
```

Expected: PASS, 2 tests; tsc clean.

- [ ] **Step 6: Commit**

```bash
git add src/components/settings/settings-sidebar.tsx src/app/\(admin\)/settings.tsx src/components/settings/__tests__/settings-nav.test.ts
git commit -m "feat: open settings on a panel named in the url"
```

---

### Task 5: The "keyboard attached, scanning off" prompt

**Files:**
- Create: `src/components/till-keyboard-notice.tsx`
- Test: `src/components/__tests__/till-keyboard-notice.test.tsx`
- Modify: `src/components/settings/panels/locations-panel.tsx:349-352`

**Interfaces:**
- Consumes: `useHardwareKeyboard()` (Task 3), `Caveat` from `@/components/ui/caveat`, `useCaveatDismissal` from `@/hooks/use-caveat-dismissal`, `can()` and `activeLocation` from `useAuth()`.
- Produces: `<TillKeyboardNotice />` — renders itself or nothing; takes no props.

- [ ] **Step 1: Write the failing test**

Create `src/components/__tests__/till-keyboard-notice.test.tsx`:

```tsx
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { TillKeyboardNotice } from '@/components/till-keyboard-notice';

// `mock`-prefixed on purpose, and not cosmetic: `jest.mock()` is hoisted above
// these declarations, and `babel-plugin-jest-hoist` REFUSES to compile a
// factory that closes over an out-of-scope `let` unless its name begins with
// `mock`. Rename these and the suite fails to transform at all.
let mockAttached: boolean | null = true;
let mockSettingOn = false;
let mockPermitted = true;
let mockDismissed = false;

jest.mock('@/hooks/use-hardware-keyboard', () => ({ useHardwareKeyboard: () => mockAttached }));
jest.mock('@/hooks/use-auth', () => ({
  useAuth: () => ({
    activeLocation: { hardwareScannerEnabled: mockSettingOn },
    can: () => mockPermitted,
  }),
}));
jest.mock('@/hooks/use-caveat-dismissal', () => ({
  useCaveatDismissal: () => ({ dismissed: mockDismissed, dismiss: jest.fn() }),
}));
jest.mock('expo-router', () => ({ useRouter: () => ({ push: jest.fn() }) }));

function shown(): boolean {
  let tree: ReactTestRenderer | undefined;
  act(() => { tree = create(<TillKeyboardNotice />); });
  return tree!.toJSON() !== null;
}

describe('TillKeyboardNotice', () => {
  beforeEach(() => { mockAttached = true; mockSettingOn = false; mockPermitted = true; mockDismissed = false; });

  it('offers the toggle when a keyboard is plugged into a store that has not enabled scanning', () => {
    expect(shown()).toBe(true);
  });

  // Each of the four below has to silence it on its own.
  it('says nothing once scanning is already on', () => {
    mockSettingOn = true;
    expect(shown()).toBe(false);
  });

  it('says nothing when no keyboard is attached', () => {
    mockAttached = false;
    expect(shown()).toBe(false);
  });

  // An unknown answer must never produce advice.
  it('says nothing when detection could not answer', () => {
    mockAttached = null;
    expect(shown()).toBe(false);
  });

  // A cashier cannot change a store setting. Telling them to is worse than
  // silence, because they cannot act and cannot make it stop.
  it('says nothing to someone who cannot change the setting', () => {
    mockPermitted = false;
    expect(shown()).toBe(false);
  });

  it('stays gone once dismissed', () => {
    mockDismissed = true;
    expect(shown()).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npx jest src/components/__tests__/till-keyboard-notice.test.tsx
```

Expected: FAIL — `Cannot find module '@/components/till-keyboard-notice'`.

- [ ] **Step 3: Write the component**

Create `src/components/till-keyboard-notice.tsx`:

```tsx
import { useRouter } from 'expo-router';

import { Caveat } from '@/components/ui/caveat';
import { useAuth } from '@/hooks/use-auth';
import { useCaveatDismissal } from '@/hooks/use-caveat-dismissal';
import { useHardwareKeyboard } from '@/hooks/use-hardware-keyboard';

// A keyboard is plugged into this till and the store has not switched scanning
// on. Usually that is a shop that bought a scanner, connected it, and never
// found the setting.
//
// The mirror of this -- setting on, nothing attached -- is deliberately NOT a
// notice. Most devices in a shop are tablets and phones with no scanner, so it
// would fire on the majority of tills, describe no fault, and offer no action.
// This one fires only when someone physically connects something, is probably
// describing a fault, and has a one-toggle fix.
//
// It hedges on purpose. Detection cannot tell a scanner from a keyboard case,
// so the copy names what is actually known -- a keyboard -- and leaves the
// reader, who can see the cable, to decide. Asserting "scanner detected" to
// someone holding a keyboard tablet is a bug they can see.
export function TillKeyboardNotice() {
  const router = useRouter();
  const { activeLocation, can } = useAuth();
  const attached = useHardwareKeyboard();
  const note = useCaveatDismissal('till.keyboard-detected', 'v1');

  // `=== true` and not truthiness: `null` means detection could not answer, and
  // an unknown answer must never produce advice.
  if (attached !== true) return null;
  if (activeLocation?.hardwareScannerEnabled) return null;
  // Nobody who cannot act on it should be told about it.
  if (!can('settings.access')) return null;
  if (note.dismissed) return null;

  return (
    <Caveat
      tone="context"
      onDismiss={note.dismiss}
      action={{
        label: 'Open scanning settings',
        onPress: () => router.push({ pathname: '/settings', params: { nav: 'locations' } }),
      }}
    >
      A keyboard or barcode scanner is connected to this device. If it&apos;s a scanner, turn on
      scanning for this store to use it.
    </Caveat>
  );
}
```

- [ ] **Step 4: Run it and watch it pass**

```bash
npx jest src/components/__tests__/till-keyboard-notice.test.tsx
```

Expected: PASS, 6 tests.

- [ ] **Step 5: Update the store setting's hint**

In `src/components/settings/panels/locations-panel.tsx`, replace the hint text at lines 349–352 with:

```tsx
                <Text style={modalStyles.toggleHint}>
                  For the USB or Bluetooth kind that plugs into the till. Turn this on only if one is connected here —
                  it makes the register watch the keyboard for scans. Each device checks for itself, so tills without a
                  scanner are unaffected.
                </Text>
```

- [ ] **Step 6: Mount it on both screens**

In `src/app/(admin)/(tabs)/inventory.tsx`, add the import alongside the other component imports:

```tsx
import { TillKeyboardNotice } from '@/components/till-keyboard-notice';
```

and render it immediately above `<View style={styles.searchWrap}>`:

```tsx
        <TillKeyboardNotice />
```

Do the same in `src/app/(admin)/(tabs)/pos.tsx`, rendering it immediately above that screen's search field wrapper.

- [ ] **Step 7: Verify**

```bash
npx tsc --noEmit && npx eslint src/components/till-keyboard-notice.tsx && npx jest
```

Expected: tsc clean, lint clean, all suites pass.

- [ ] **Step 8: Commit**

```bash
git add src/components/till-keyboard-notice.tsx src/components/__tests__/till-keyboard-notice.test.tsx src/components/settings/panels/locations-panel.tsx "src/app/(admin)/(tabs)/inventory.tsx" "src/app/(admin)/(tabs)/pos.tsx"
git commit -m "feat: offer the scanner toggle when a keyboard is plugged into a till"
```

**Phase A is complete and shippable here.**

---

### Task 6: The keypad text reducer

**Files:**
- Create: `src/lib/keypad.ts`
- Test: `src/lib/__tests__/keypad.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `type KeypadKey = { type: 'char'; value: string } | { type: 'space' } | { type: 'delete' } | { type: 'clear' }` and `applyKey(text: string, key: KeypadKey): string`.

- [ ] **Step 1: Write the failing test**

Create `src/lib/__tests__/keypad.test.ts`:

```ts
import { applyKey } from '@/lib/keypad';

describe('applyKey', () => {
  it('appends a character', () => {
    expect(applyKey('she', { type: 'char', value: 'a' })).toBe('shea');
  });

  it('appends a space', () => {
    expect(applyKey('shea', { type: 'space' })).toBe('shea ');
  });

  it('deletes the last character', () => {
    expect(applyKey('shea', { type: 'delete' })).toBe('she');
  });

  // Backspace on nothing is a real thing a finger does, and it must not throw
  // or produce "undefined".
  it('deletes nothing from an empty field', () => {
    expect(applyKey('', { type: 'delete' })).toBe('');
  });

  it('clears everything', () => {
    expect(applyKey('shea butter', { type: 'clear' })).toBe('');
  });

  // Search is case-insensitive across name, SKU, brand, category, tag and
  // barcode, which is why the keypad has no shift key to have a state for.
  it('keeps characters exactly as the key gives them', () => {
    expect(applyKey('', { type: 'char', value: '7' })).toBe('7');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npx jest src/lib/__tests__/keypad.test.ts
```

Expected: FAIL — `Cannot find module '@/lib/keypad'`.

- [ ] **Step 3: Write the reducer**

Create `src/lib/keypad.ts`:

```ts
export type KeypadKey =
  | { type: 'char'; value: string }
  | { type: 'space' }
  | { type: 'delete' }
  | { type: 'clear' };

/**
 * Every edit the on-screen keypad can make, as a pure function of the text.
 *
 * Separate from the component so the behaviour is tested without rendering
 * anything -- and so the screen's existing `search` state stays the one place
 * the text lives. The keypad holds none of its own.
 */
export function applyKey(text: string, key: KeypadKey): string {
  switch (key.type) {
    case 'char':
      return text + key.value;
    case 'space':
      return text + ' ';
    case 'delete':
      return text.slice(0, -1);
    case 'clear':
      return '';
  }
}
```

- [ ] **Step 4: Run it and watch it pass**

```bash
npx jest src/lib/__tests__/keypad.test.ts
```

Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/keypad.ts src/lib/__tests__/keypad.test.ts
git commit -m "feat: add the keypad text reducer"
```

---

### Task 7: The keypad component

**Files:**
- Create: `src/components/search-keypad.tsx`
- Test: `src/components/__tests__/search-keypad.test.tsx`

**Interfaces:**
- Consumes: `applyKey`, `KeypadKey` (Task 6).
- Produces: `<SearchKeypad value={string} onChange={(next: string) => void} onSubmit={() => void} onClose={() => void} />`.

- [ ] **Step 1: Write the failing test**

Create `src/components/__tests__/search-keypad.test.tsx`:

```tsx
import { Pressable, Text } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { SearchKeypad } from '@/components/search-keypad';

function render(props: Partial<React.ComponentProps<typeof SearchKeypad>> = {}) {
  const onChange = jest.fn();
  const onSubmit = jest.fn();
  const onClose = jest.fn();
  let tree: ReactTestRenderer | undefined;
  act(() => {
    tree = create(
      <SearchKeypad value="she" onChange={onChange} onSubmit={onSubmit} onClose={onClose} {...props} />,
    );
  });
  const press = (label: string) => {
    const target = tree!.root
      .findAllByType(Pressable)
      .find((node) => node.findAllByType(Text).some((t) => t.props.children === label));
    if (!target) throw new Error(`no key labelled ${label}`);
    act(() => { target.props.onPress(); });
  };
  return { onChange, onSubmit, onClose, press, tree: tree! };
}

describe('SearchKeypad', () => {
  it('is QWERTY, with the digits on top', () => {
    const { tree } = render();
    const labels = tree.root.findAllByType(Text).map((t) => t.props.children);
    expect(labels.slice(0, 10)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9', '0']);
    expect(labels.slice(10, 20)).toEqual(['Q', 'W', 'E', 'R', 'T', 'Y', 'U', 'I', 'O', 'P']);
  });

  // Lowercase out, whatever the cap on the key: search is case-insensitive and
  // the value goes straight into the same filter a typed query uses.
  it('appends the letter in lower case', () => {
    const { onChange, press } = render();
    press('A');
    expect(onChange).toHaveBeenCalledWith('shea');
  });

  it('deletes and clears', () => {
    const { onChange, press } = render();
    press('⌫');
    expect(onChange).toHaveBeenCalledWith('sh');
    press('Clear');
    expect(onChange).toHaveBeenCalledWith('');
  });

  it('submits and closes on Done', () => {
    const { onSubmit, onClose, press } = render();
    press('Done');
    expect(onSubmit).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npx jest src/components/__tests__/search-keypad.test.tsx
```

Expected: FAIL — `Cannot find module '@/components/search-keypad'`.

- [ ] **Step 3: Write the component**

Create `src/components/search-keypad.tsx`:

```tsx
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Colors } from '@/constants/theme';
import { applyKey, type KeypadKey } from '@/lib/keypad';

const theme = Colors.light;

// An on-screen keypad for the search box, and only for that.
//
// It exists because iOS hides the system keyboard whenever a hardware keyboard
// is attached -- and a HID barcode scanner IS a hardware keyboard. So the one
// till that scans is the one till that cannot type, and there is no public API
// to ask for the keyboard back. This is that keyboard.
//
// It is NOT a general keyboard and must not grow into one: no shift, symbols,
// emoji, autocorrect, predictive bar or language switching. Product search is
// case-insensitive and matches name, SKU, brand, category, tag and barcode, so
// every one of those is weight with nothing on the other end.
//
// Digits sit on the top row rather than behind a mode switch, because barcodes
// get typed here as often as names.
const ROWS = [
  ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'],
  ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p'],
  ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l'],
  ['z', 'x', 'c', 'v', 'b', 'n', 'm'],
];

export function SearchKeypad({
  value,
  onChange,
  onSubmit,
  onClose,
}: {
  value: string;
  onChange: (next: string) => void;
  /** Runs the same code path Enter does on a keyboard: resolve it as a scan. */
  onSubmit: () => void;
  onClose: () => void;
}) {
  const apply = (key: KeypadKey) => onChange(applyKey(value, key));

  return (
    <View style={styles.dock}>
      {ROWS.map((row, index) => {
        // Half the missing width on each side, so a key is the same width on
        // every row and the hand can trust where it is. A FIXED spacer only
        // balances a row that is exactly one key short: the bottom row is three
        // short, and a fixed 0.5 left its keys about a quarter wider than the
        // letters above them.
        const spacerFlex = (ROWS[0].length - row.length) / 2;
        return (
          <View key={index} style={styles.row}>
            {spacerFlex > 0 ? <View style={{ flex: spacerFlex }} /> : null}
          {row.map((char) => (
            <Pressable
              key={char}
              onPress={() => apply({ type: 'char', value: char })}
              style={styles.key}
              accessibilityRole="button"
              accessibilityLabel={char}
            >
              <Text style={styles.keyLabel}>{char.toUpperCase()}</Text>
            </Pressable>
          ))}
            {spacerFlex > 0 ? <View style={{ flex: spacerFlex }} /> : null}
          </View>
        );
      })}

      <View style={styles.row}>
        <Pressable onPress={() => apply({ type: 'clear' })} style={[styles.key, styles.utilKey]} accessibilityRole="button">
          <Text style={styles.utilLabel}>Clear</Text>
        </Pressable>
        <Pressable onPress={() => apply({ type: 'space' })} style={[styles.key, styles.utilKey, styles.spaceKey]} accessibilityRole="button" accessibilityLabel="space">
          <Text style={styles.utilLabel}>space</Text>
        </Pressable>
        <Pressable onPress={() => apply({ type: 'delete' })} style={[styles.key, styles.utilKey]} accessibilityRole="button" accessibilityLabel="delete">
          <Text style={styles.utilLabel}>⌫</Text>
        </Pressable>
        <Pressable
          onPress={() => { onSubmit(); onClose(); }}
          style={[styles.key, styles.doneKey]}
          accessibilityRole="button"
        >
          <Text style={styles.doneLabel}>Done</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  dock: { backgroundColor: theme.bentoSoft, borderTopWidth: 1, borderTopColor: theme.bentoLine, padding: 10, gap: 6 },
  row: { flexDirection: 'row', gap: 5 },
  key: {
    flex: 1,
    minWidth: 0,
    height: 40,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: theme.bentoRule,
    backgroundColor: theme.bentoSurface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  keyLabel: { fontSize: 15, fontWeight: '700', color: theme.bentoInk },
  utilKey: { backgroundColor: theme.bentoSoft },
  utilLabel: { fontSize: 12, fontWeight: '700', color: theme.bentoInk2 },
  spaceKey: { flex: 2.4 },
  doneKey: { flex: 1.5, backgroundColor: theme.bentoInk, borderColor: theme.bentoInk },
  doneLabel: { fontSize: 12.5, fontWeight: '800', color: theme.bentoSurface },
});
```

- [ ] **Step 4: Run it and watch it pass**

```bash
npx jest src/components/__tests__/search-keypad.test.tsx
```

Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/components/search-keypad.tsx src/components/__tests__/search-keypad.test.tsx
git commit -m "feat: add the on-screen keypad for the till search box"
```

---

### Task 8: The search row

The branch, written once so Inventory and POS cannot drift apart.

**Files:**
- Create: `src/components/search-row.tsx`
- Test: `src/components/__tests__/search-row.test.tsx`

**Interfaces:**
- Consumes: `SearchKeypad` (Task 7).
- Produces:

```tsx
<SearchRow
  value={string}
  onChange={(next: string) => void}
  onSubmit={() => void}
  placeholder={string}
  useKeypad={boolean}        // true only when a keyboard is CONFIRMED attached
  showScanButton={boolean}
  onScanPress={() => void}   // optional
  showSearchIcon={boolean}   // optional, default false — POS draws one, Inventory does not
/>
```

- [ ] **Step 1: Write the failing test**

Create `src/components/__tests__/search-row.test.tsx`:

```tsx
import { Pressable, Text, TextInput } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { SearchRow } from '@/components/search-row';
import { SearchKeypad } from '@/components/search-keypad';

function row(useKeypad: boolean, value: string, onChange: jest.Mock) {
  return (
    <SearchRow
      value={value}
      onChange={onChange}
      onSubmit={jest.fn()}
      placeholder="Search or scan a product"
      useKeypad={useKeypad}
      showScanButton={false}
    />
  );
}

function render(useKeypad: boolean, value = '') {
  const onChange = jest.fn();
  let tree: ReactTestRenderer | undefined;
  act(() => { tree = create(row(useKeypad, value, onChange)); });
  const rerender = (nextUseKeypad: boolean) => {
    act(() => { tree!.update(row(nextUseKeypad, value, onChange)); });
  };
  const labels = () => tree!.root.findAllByType(Text).map((t) => t.props.children);
  return { tree: tree!, onChange, rerender, labels };
}

describe('SearchRow', () => {
  it('is an ordinary text field on a device with no keyboard attached', () => {
    const { tree } = render(false);
    expect(tree.root.findAllByType(TextInput)).toHaveLength(1);
    expect(tree.root.findAllByType(SearchKeypad)).toHaveLength(0);
  });

  // The load-bearing assertion of the whole feature. A TextInput here would
  // take focus from the wedge sink, and scanning would stop the moment someone
  // touched the search box.
  it('renders NO text input at all when the keypad is in use', () => {
    const { tree } = render(true);
    expect(tree.root.findAllByType(TextInput)).toHaveLength(0);
  });

  it('opens the keypad only once the field is tapped', () => {
    const { tree } = render(true);
    expect(tree.root.findAllByType(SearchKeypad)).toHaveLength(0);
    act(() => { tree.root.findAllByType(Pressable)[0].props.onPress(); });
    expect(tree.root.findAllByType(SearchKeypad)).toHaveLength(1);
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

  // Someone unplugs the scanner mid-sale. Closing rather than merely hiding
  // means plugging it back in does not silently reopen a keypad nobody asked
  // for, on top of the product grid.
  it('closes the keypad when the keyboard is unplugged', () => {
    const { tree, rerender } = render(true);
    act(() => { tree.root.findAllByType(Pressable)[0].props.onPress(); });
    expect(tree.root.findAllByType(SearchKeypad)).toHaveLength(1);

    rerender(false);
    expect(tree.root.findAllByType(SearchKeypad)).toHaveLength(0);

    rerender(true);
    expect(tree.root.findAllByType(SearchKeypad)).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npx jest src/components/__tests__/search-row.test.tsx
```

Expected: FAIL — `Cannot find module '@/components/search-row'`.

- [ ] **Step 3: Write the component**

Create `src/components/search-row.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { SearchKeypad } from '@/components/search-keypad';
import { Colors } from '@/constants/theme';

const theme = Colors.light;

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
}) {
  const [keypadOpen, setKeypadOpen] = useState(false);

  // The scanner can be unplugged with the keypad open. Closing rather than
  // merely hiding means plugging it back in does not silently reopen a keypad
  // nobody asked for, over the product grid.
  useEffect(() => {
    if (!useKeypad) setKeypadOpen(false);
  }, [useKeypad]);

  const icon = showSearchIcon ? <Text style={styles.icon}>⌕</Text> : null;
  const scanButton = showScanButton ? (
    <Pressable onPress={onScanPress} style={styles.scanButton} accessibilityLabel="Scan a barcode">
      <Text style={styles.scanGlyph}>⛶</Text>
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
          style={[styles.field, showSearchIcon && styles.fieldWithIcon, showScanButton && styles.fieldWithScan]}
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
          onPress={() => setKeypadOpen(true)}
          style={[styles.field, styles.fieldTappable, showSearchIcon && styles.fieldWithIcon, showScanButton && styles.fieldWithScan]}
          accessibilityRole="search"
        >
          {value ? (
            <Text style={styles.text} numberOfLines={1}>{value}</Text>
          ) : (
            // Says what it is: a thing you tap, with no cursor of its own.
            <Text style={styles.prompt} numberOfLines={1}>Tap to type, or scan</Text>
          )}
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

      {keypadOpen ? (
        <SearchKeypad
          value={value}
          onChange={onChange}
          onSubmit={onSubmit}
          onClose={() => setKeypadOpen(false)}
        />
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  wrap: { position: 'relative', justifyContent: 'center', marginBottom: 14 },
  field: {
    backgroundColor: theme.bentoSurface,
    borderWidth: 1,
    borderColor: theme.bentoRule,
    borderRadius: 14,
    height: 44,
    paddingHorizontal: 14,
    fontSize: 13,
    color: theme.bentoInk,
    justifyContent: 'center',
  },
  fieldTappable: { borderStyle: 'dashed' },
  fieldWithScan: { paddingRight: 46 },
  fieldWithIcon: { paddingLeft: 34 },
  icon: { position: 'absolute', left: 13, fontSize: 15, color: theme.bentoMuted2, zIndex: 1 },
  live: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: -8, marginBottom: 12, paddingLeft: 2 },
  liveDot: { width: 7, height: 7, borderRadius: 3.5, backgroundColor: theme.bentoProfit },
  liveLabel: { fontSize: 10.5, fontWeight: '700', letterSpacing: 0.6, textTransform: 'uppercase', color: theme.bentoProfit },
  text: { fontSize: 13, fontWeight: '600', color: theme.bentoInk },
  prompt: { fontSize: 13, color: theme.bentoMuted2 },
  scanButton: {
    position: 'absolute',
    right: 6,
    height: 32,
    width: 32,
    borderRadius: 16,
    backgroundColor: theme.bentoInk,
    alignItems: 'center',
    justifyContent: 'center',
  },
  scanGlyph: { fontSize: 15, lineHeight: 15, color: theme.bentoSurface },
});
```

- [ ] **Step 4: Run it and watch it pass**

```bash
npx jest src/components/__tests__/search-row.test.tsx
```

Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/components/search-row.tsx src/components/__tests__/search-row.test.tsx
git commit -m "feat: add the search row that swaps the keyboard for the keypad"
```

---

### Task 9: Wire the row into Inventory and POS

**Files:**
- Modify: `src/app/(admin)/(tabs)/inventory.tsx:544-568`
- Modify: `src/app/(admin)/(tabs)/pos.tsx` (its search field block)

**Interfaces:**
- Consumes: `SearchRow` (Task 8), `scanner.onScreenKeypad` (Task 1/3).
- Produces: nothing new.

- [ ] **Step 1: Replace Inventory's search block**

In `src/app/(admin)/(tabs)/inventory.tsx`, add the import:

```tsx
import { SearchRow } from '@/components/search-row';
```

Replace the whole `<View style={styles.searchWrap}>…</View>` block (lines 544–568, the `TextInput` and the scan `Pressable`) with:

```tsx
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
        />
```

Then delete the now-unused `searchWrap`, `search`, `searchWithScan`, `scanInSearch` and `scanInSearchText` entries from that file's `StyleSheet.create`.

- [ ] **Step 2: Replace POS's search block**

In `src/app/(admin)/(tabs)/pos.tsx`, add the import:

```tsx
import { SearchRow } from '@/components/search-row';
```

Inside `browsePaneEl`, replace the whole `<View style={styles.searchWrap}>…</View>` block — the one holding `styles.searchIcon`, the `TextInput` and the scan `Pressable` — with:

```tsx
      <SearchRow
        value={search}
        onChange={setSearch}
        onSubmit={handleSearchSubmit}
        placeholder="Search or scan a product"
        useKeypad={scanner.onScreenKeypad}
        showScanButton={scanner.camera}
        onScanPress={() => setScannerOpen(true)}
        showSearchIcon
      />
```

Then delete the now-unused `searchWrap`, `searchIcon`, `search`, `scanInSearch` and `scanInSearchText` entries from that file's `StyleSheet.create`.

Leave everything else in `browsePaneEl` — `ScanFeedbackBanner`, the `unknownCode` button, the category list — exactly where it is.

- [ ] **Step 3: Verify the whole suite**

```bash
npx tsc --noEmit && npx eslint src/components/search-row.tsx src/components/search-keypad.tsx "src/app/(admin)/(tabs)/inventory.tsx" "src/app/(admin)/(tabs)/pos.tsx" && npx jest
```

Expected: tsc clean, lint clean, every suite passing.

- [ ] **Step 4: Commit**

```bash
git add "src/app/(admin)/(tabs)/inventory.tsx" "src/app/(admin)/(tabs)/pos.tsx"
git commit -m "feat: give the scanner till a way to type on Inventory and POS"
```

---

### Task 10: Verify on a device

Nothing in Tasks 2, 9 or the interaction between them is reachable from Jest. This task is the evidence.

**Files:** none.

- [ ] **Step 1: Build and install**

```bash
npx expo run:ios --device "iPhone 17 Pro Max"
```

Expected: `Build Succeeded`, app launches to the shop.

- [ ] **Step 2: Confirm the no-keyboard world is untouched**

In the Simulator, **I/O ▸ Keyboard ▸ Connect Hardware Keyboard** must be **off** (⇧⌘K toggles it). Open Inventory with the store's scanner setting **on**.

Expected: an ordinary field, the system keyboard on tap, no keypad, no "Scanner ready".

- [ ] **Step 3: Confirm the scanner world**

Turn **Connect Hardware Keyboard on** (⇧⌘K). Return to Inventory.

Expected: the field is dashed and reads "Tap to type, or scan"; "Scanner ready" is shown; tapping the field opens the QWERTY keypad; typing filters the product list; "Scanner ready" stays visible throughout.

- [ ] **Step 4: Confirm scanning survives typing**

With the keypad open and a few letters typed, type a full barcode followed by Return on the Mac keyboard — this is what a wedge scanner sends.

Expected: the code resolves to a product exactly as a scan does. This is the assertion the whole design exists for; if it fails, the field is taking focus from `WedgeSink` and Task 8's "no TextInput" rule has been broken somewhere.

- [ ] **Step 5: Confirm the toggle prompt**

Turn the store's scanner setting **off** in Settings ▸ Locations, with the hardware keyboard still connected, and open Inventory as an owner.

Expected: the caveat appears; **Open scanning settings** lands on the Locations panel, not Profile; dismissing it makes it stay gone across an app restart.

- [ ] **Step 6: Confirm live switching**

With Inventory open, toggle **Connect Hardware Keyboard** both ways.

Expected: the row switches each time without a reload, and nothing is left focused or half-drawn.

- [ ] **Step 7: Record the result**

Append a short "Verified on device" note to the spec with the date and anything that behaved differently from this plan, then commit.

```bash
git add docs/superpowers/specs/2026-08-08-scanner-detection-keypad-design.md
git commit -m "docs: record device verification for scanner detection and the keypad"
```

---

## Notes for whoever executes this

- **Task 2 needs a native rebuild and so does anything after it.** A Metro reload will not pick up the module; `getHardwareKeyboardModule()` returning `null` on a stale binary is the designed fallback, and it makes the app behave exactly as it does today rather than crash. If detection seems dead, rebuild before debugging.
- **`WedgeSink` is not modified by this plan.** Its focus-yield behaviour and its tests are already correct and stay untouched; Task 8's no-`TextInput` rule is what keeps it holding focus.
- **Do not add a notice for "setting on, nothing attached".** It was considered and rejected: most devices in a shop legitimately have no scanner, so it would fire on the majority of tills, describe no fault and offer no action. The spec's Out of Scope section records the reasoning.
