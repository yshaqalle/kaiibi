# Hardware scanner detection, and typing on the till that has one — design

**Date:** 2026-08-08
**Status:** Awaiting review
**Mockup:** [docs/design/scanner-keypad-mockup.html](../../design/scanner-keypad-mockup.html)
**Scope:** Detecting whether a hardware keyboard is attached to *this device*,
gating the wedge listener on it, and giving the device that has one a way to
type. Inventory and POS.

## Problem

Two faults with one cause: the app decides "does this till scan?" from a
setting a human flipped, and never asks the device.

`useScannerSettings()` reads `activeLocation.hardwareScannerEnabled` — a column
on the **store**. A shop is not a device. It has a couple of phones, a tablet on
the counter, and maybe one till with a scanner wired to it. One boolean on the
store cannot describe that, so today it describes all of them: every device in
that store mounts `WedgeSink`, an invisible permanently-focused `TextInput`,
whether or not anything is attached to it.

That is the first fault, and it is mostly hygiene — an input nobody needs on
devices that will never scan.

The second is not hygiene. **A HID barcode scanner is a keyboard to the OS, and
iOS hides the on-screen keyboard whenever a keyboard is attached.** So the one
device that scans is the one device where tapping the search box gives a
blinking cursor and nothing to type with. Verified on device: the app's own
UIKit log reports

```
UIDevice.currentDevice._hardwareKeyboardAvailable = YES
```

and the field then shows a caret and no keyboard. There is no public API to
force the keyboard back. Any fix has to be ours.

## The rule this is built on

> Search and touch always work, on every device, whatever else is attached. If
> a scanner happens to be there it is added on top — never traded against.

Stated by the shop owner, and it decides every question below. Notably it kills
the "warn the user that no scanner is connected" feature I had planned: with
most devices legitimately having no scanner, that notice would fire on the
majority of tills and be noise. A device without a scanner is not
misconfigured. It is normal.

## What this builds

**Phase A — detection**

1. A local Expo module, `hardware-keyboard`, answering "is a physical keyboard
   attached right now" with live connect/disconnect events.
2. `useScannerSettings().hardware` gated on it.

**Phase B — typing on the scanner till**

3. `SearchKeypad`, a QWERTY on-screen keypad owned by the app.
4. Inventory and POS search rows switching to a display-only field plus the
   keypad when a keyboard is attached.

Phase B depends on A. A ships alone and is useful alone.

## Decisions

### Detection is per device, the setting stays per store

`hardwareScannerEnabled` keeps its column and its toggle, and changes meaning:
from *there is a scanner here* to *this store uses scanners* — permission,
with the per-device truth measured rather than declared. No migration, no data
change. The toggle's hint copy gets one sentence saying so.

### Three states, and only one of them trusts the setting

With the store setting **on**:

| Device reports | Wedge listener | Search field | Typing |
|---|---|---|---|
| **Attached** | Mounted, holds focus | Display only | `SearchKeypad` |
| **Absent** | Not mounted | Normal `TextInput` | System keyboard |
| **Unknown** | Mounted (setting wins) | Normal `TextInput` | System keyboard |

With the setting **off**, every row is the `Absent` row: nothing mounts and no
keypad appears, whatever is attached. The setting is still permission.

`Unknown` means the platform could not answer — API unavailable, or the module
missing from a build. It is the safety valve, and it is deliberately narrow: a
shop scanning happily today cannot be silently switched off by a gap in
detection. `Absent` is a real answer and gates.

### The keypad needs a *known* keyboard; the wedge does not

These two are resolved differently and the difference matters, so
`useScannerSettings` returns both rather than leaving each screen to derive it:

```ts
hardware:      setting && (attached ?? true)   // unknown → trust the setting
onScreenKeypad: setting && attached === true   // unknown → no keypad
```

The wedge can afford optimism: mounting it on a device with no scanner costs an
unused invisible input. The keypad cannot — replacing the system keyboard with
ours on a device we merely *suspect* has a keyboard would take typing away from
someone who had it. Only a confirmed `true` earns that.

Why the store setting gates the keypad at all, when detection already says a
keyboard is attached: detection cannot tell a scanner from a keyboard. A tablet
in a keyboard case reports exactly what a scanner till reports — but that user
has real keys in front of them and needs no keypad from us. The store setting is
the only signal available for *this attached keyboard probably has no keys on
it*, so it has to stay in the condition.

### The keypad owns the text; the field stops taking focus

This is the load-bearing decision. On a scanner device the search box is **not
a `TextInput`** — it is a `Pressable` drawing the current text and our own
caret. The keypad writes into the same `search` state the screen already has.

Three things follow, and they are the reason for the design:

- **Scanning stays live while someone types.** `WedgeSink` keeps focus
  permanently because nothing else ever asks for it. Scan and type work at the
  same time rather than taking turns, which no amount of refereeing a focus
  fight could achieve.
- **No focus fight to referee.** The blur/refocus dance in `WedgeSink` never
  runs on this path.
- **No `showSoftInputOnFocus` on the search field.** That prop installs an
  empty `inputView`; Fabric's `prepareForRecycle` does not clear it and
  `_setShowSoftInputOnFocus:` only runs on change, so a recycled view can carry
  it to the next field and leave *that* one with a caret and no keyboard. Not
  observed in the wild, and this design never gets near it.

### QWERTY, not A–Z

Chosen by the shop owner from the mockup. Every phone in the shop is already
QWERTY, so muscle memory transfers and nobody learns a second alphabet. Keys
land near 30px on a phone, under the 44px touch target — acceptable for search,
and it would not be for anything that moved money.

### What the keypad is not

No shift, symbols, emoji, autocorrect, predictive bar or language switching.
Product search is case-insensitive and matches name, SKU, brand, category, tag
and barcode, so each of those is weight with nothing on the other end. Keys are
A–Z, 0–9, space, delete, clear and done.

### Opens on tap

Tapping the search box opens the keypad; **Done** closes it. Always-visible
would cost roughly a third of the screen permanently, on the device where the
product grid matters most.

### Both screens

Inventory and POS share the search row, the wedge and the scan handler, so both
get the same treatment. POS is where the speed argument bites hardest.

## Architecture

### `modules/hardware-keyboard` (local Expo module)

Local rather than a package: it is ~60 lines of platform code with no reuse
outside this repo, and `npx create-expo-module --local` autolinks it without
publishing anything.

**Native surface**

| Platform | Source of truth | Events |
|---|---|---|
| iOS | `GCKeyboard.coalescedKeyboard != nil` (GameController, iOS 14+) | `GCKeyboardDidConnect` / `GCKeyboardDidDisconnect` |
| Android | `InputDevice` where `sources and SOURCE_KEYBOARD != 0`, `keyboardType == KEYBOARD_TYPE_ALPHABETIC`, and `!isVirtual` | `InputManager.InputDeviceListener` add/remove/change |
| Web | not implemented — resolves `null` | none |

Android must exclude virtual devices: the on-screen keyboard reports as an
input device, and counting it would mean every Android phone claims a keyboard.

**JS surface**

```ts
// null when the platform cannot answer.
export function isKeyboardAttached(): boolean | null;
export function addKeyboardListener(fn: (attached: boolean) => void): Subscription;
```

**Hook** — `src/hooks/use-hardware-keyboard.ts`

```ts
export function useHardwareKeyboard(): boolean | null;
```

Subscribes on mount, unsubscribes on unmount, seeds from
`isKeyboardAttached()`. Returns `null` for unknown, which callers must treat as
"trust the setting" rather than as `false`.

### `SearchKeypad` — `src/components/search-keypad.tsx`

```tsx
<SearchKeypad
  value={search}
  onChange={setSearch}
  onSubmit={handleSearchSubmit}
  onClose={() => setKeypadOpen(false)}
/>
```

Presentational and controlled. It holds no text of its own — the screen's
existing `search` state stays the single source, so filtering, the scan
handler and `handleSearchSubmit` are untouched.

Text edits go through a pure reducer so they are testable without rendering:

```ts
// src/lib/keypad.ts
export type KeypadKey = { type: 'char'; value: string } | { type: 'space' }
                      | { type: 'delete' } | { type: 'clear' };
export function applyKey(text: string, key: KeypadKey): string;
```

### Screen changes

`inventory.tsx` and `pos.tsx` each gain one branch in the search row and one
mount at the bottom. Both already hold `search` state, both already have
`handleSearchSubmit`. The extracted piece is the row itself — `SearchRow` —
so the branch is written once rather than twice, and both screens keep their
own state.

## Error handling

| Case | Behaviour |
|---|---|
| Module missing from the build (JS updated, native not rebuilt) | `isKeyboardAttached()` returns `null` → unknown → setting wins → today's behaviour exactly |
| iOS below 14, or GameController unavailable | `null` → unknown |
| Keyboard unplugged while the keypad is open | Listener fires `false`; keypad closes, field reverts to a normal `TextInput` |
| Keyboard attached while the system keyboard is up | Listener fires `true`; the field blurs and the row switches. The OS dismisses its keyboard on its own here |
| Store setting off | Nothing mounts and no keypad, whatever is attached |
| Keypad open, then the user navigates away | Keypad state is the screen's; it unmounts with the screen and reopens closed |

## Testing

**Unit (Jest, no device)**

- `applyKey` — every key type, including delete on empty and clear.
- `useScannerSettings` resolution across all three detection states × setting
  on/off — six cases for `hardware` and six for `onScreenKeypad`, with the
  tables above as the oracle. The case worth naming: `Unknown` + setting on
  must give `hardware: true` and `onScreenKeypad: false`, which is the one
  place the two answers diverge.
- `SearchKeypad` renders a QWERTY row order and calls `onChange` with the
  reduced text.
- `WedgeSink` — existing tests stay green; the focus-yield behaviour is
  unchanged by this work.

**Manual, on device — the parts Jest cannot reach**

1. Simulator with **I/O ▸ Keyboard ▸ Connect Hardware Keyboard** on: Inventory
   shows the keypad, typing filters, scanning still resolves a product.
2. Same simulator with it off: normal field, system keyboard, no `WedgeSink`.
3. Toggle it while the screen is open, both directions — the row switches and
   nothing is left focused.
4. A real Bluetooth HID scanner, if one is available, for the case the
   simulator only approximates.

## Risks

- **Needs a native rebuild.** A local module is native code; JS-only reloads
  will not pick it up, and the `Unknown` fallback is what keeps a stale build
  behaving exactly as today rather than breaking.
- **Detection cannot tell a scanner from a keyboard.** Both are HID keyboards.
  A paired Bluetooth keyboard will be treated as a scanner — which is correct,
  since the wedge works with it, but the naming should stay honest: this is
  *hardware keyboard* detection, not *scanner* detection.
- **A scanner that does not present as a keyboard** (SPP / BLE-serial) is
  reported absent, correctly — it was never supported and sends nothing to the
  wedge.

## Out of scope

- Changing `hardwareScannerEnabled` from a store column to a device setting.
  Detection removes the need.
- A status row in Settings reporting what is attached. Killed by the rule: with
  most devices legitimately scanner-less, it is noise on the majority of tills.
- A general on-screen keyboard component for use anywhere else in the app.
