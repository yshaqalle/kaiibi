# Platform drivers

Everything here was run against this app. Where a platform cannot do something,
that is stated rather than worked around with a plausible-looking command.

## Web — Playwright MCP (full interaction)

Dev server: `http://localhost:8081` (`npm run web`, or an already-running Metro —
check `lsof -iTCP:8081 -sTCP:LISTEN` before starting a second one).

Routes are real URLs, so `browser_navigate` to `/pos`, `/inventory`, `/people`,
`/accounting`, `/dashboard`, `/settings` is the fastest way to reach a module.

### react-native-web changes how you click

RN renders `Pressable` as a `<div>`, not a `<button>`. Consequences:

| Situation | What to do |
|---|---|
| Any pressable | `div.r-cursor-1loqt21:has-text("Label") >> nth=-1`. That class **is** the enabled-pressable marker. |
| Disabled pressable | Carries `r-pointerEvents-*` instead of `r-cursor-1loqt21`. Use its absence as the "button is disabled" assertion. |
| A tile inside a scrolling grid (POS product grid) | A real Playwright click is **swallowed** — the ScrollView's touch responder eats it and nothing happens, with no error. Use `browser_evaluate` to call `.click()` on the node directly (recipe below). |
| Reading state | `browser_evaluate` returning `document.body.innerText` beats a snapshot. RN emits a wall of unlabelled `generic` nodes, and the visible text is what you are asserting on anyway. |
| `ref=` handles from a snapshot | Go stale on the next render. Re-snapshot immediately before use, or skip refs and use text selectors. |

Clicking a tile the ScrollView would otherwise swallow:

```js
// browser_evaluate — finds the pressable wrapper by its exact rendered text
() => {
  const el = [...document.querySelectorAll('div.r-cursor-1loqt21')]
    .find(d => d.innerText.startsWith('ANU'));
  el.click();
  return new Promise(r => setTimeout(() => {
    const t = document.body.innerText;
    r(t.slice(t.indexOf('Current sale'), t.indexOf('Current sale') + 200));
  }, 600));
}
```

Text inputs are real `<input>` elements — `browser_type` against
`input[placeholder="…"]` works normally. Where a placeholder repeats (`0.00` is
both purchase cost and retail price) index it: `input[placeholder="0.00"] >> nth=1`.

`src/lib/confirm.ts` uses `window.confirm` on web, so destructive and warning
paths raise a real dialog ("Save without a purchase cost?"). It surfaces as
`Modal state` on the tool result — handle it with `browser_handle_dialog` before
doing anything else, or the next action resolves it for you and you lose the
assertion.

If the browser refuses to start with *"Browser is already in use"*, an orphaned
MCP Chrome is holding the profile. Confirm it is the automation one by checking
its `--user-data-dir` points at `ms-playwright-mcp` — that is a separate profile
from the user's own browser — before ending that process.

## Android — `scripts/droid.sh` (full interaction)

Emulators: `phone` (Pixel 8), `11` and `14` (tablets). Boot and install with the
repo's own `./scripts/android-emu.sh start|install|launch`.

```bash
D=.claude/skills/testing-kaiibi/scripts/droid.sh
$D find "Inventory"        # x,y  clickable  Class  'label'
$D tap "Inventory"
$D type "QA smoke"
$D -t 11 goto pos          # deep link on the 11" tablet
$D -t 14 shot /tmp/t14.png
```

`uiautomator` gives a genuine element tree with labels, bounds and a `clickable`
flag, so Android is the strongest *functional* check of the three natives.

- **Re-dump before every tap.** `tap` does this internally. Coordinates captured
  before a scroll or an animation are worthless — a stale one here opened the
  system photo picker instead of a search field.
- **The RN LogBox warning banner overlays the bottom tab bar.** The first tap
  hits the banner and appears to do nothing; the second works. If a tab tap is a
  no-op, dump again and check for `Open debugger to view warnings`.
- Deep links work while the app is running: `am start -a …VIEW -d kaiibi://pos`.
- Tablets render the **sidebar** layout (nav at the top of the tree, y≈150–200),
  phones render **bottom tabs** (y≈2230). That difference is the tablet assertion.

## iOS — screenshots, and a permission wall

Booted sims are found with `xcrun simctl list devices booted`. Bundle id
`com.kaiibisteam.kaiibi`.

Works today:

```bash
xcrun simctl io <udid> screenshot out.png     # then Read the png
xcrun simctl launch <udid> com.kaiibisteam.kaiibi
xcrun simctl terminate <udid> com.kaiibisteam.kaiibi
```

**Tapping is not available.** There is no `simctl` tap, `idb`/`appium`/`maestro`
are not installed, and the AppleScript route fails with *"osascript is not
allowed assistive access"*. Do not write iOS steps that assume a tap.

**Deep links are unreliable on iOS.** `simctl openurl` succeeded once on the
iPhone but on the iPad raised a SpringBoard *"Open in 'Ka Iibi'?"* alert — which
needs a tap, which we do not have, and which then blocks the screen. Terminating
first does not avoid it. Use `openurl`, screenshot, and if you see that alert,
recover with `simctl launch` and drive the run from wherever the app opens.

So an iOS run verifies **layout, rendering and data** at iPhone and iPad
geometry — the thing the simulator is actually needed for — while interaction
coverage comes from web and Android. Say that in the report rather than implying
the flows were exercised.

### Unlocking full iOS interaction

Both are the user's call, and either is enough. Ask; do not install anything
unprompted.

1. **Grant Accessibility** to the terminal or VS Code under System Settings →
   Privacy & Security → Accessibility. AppleScript can then click and type into
   the Simulator window, and this file should gain that driver.
2. **Install Maestro** (see `maestro.mobile.dev` for the current installer) — one
   YAML flow language covering iOS simulators and Android emulators both. It
   needs a JDK, and this machine has no standalone one, so `JAVA_HOME` has to
   point at Android Studio's JBR the way `scripts/android-emu.sh` already does.
### Android traps found while testing the scanner till (2026-08-09)

- **A stale APK hides native modules silently.** JS from Metro is always
  current, but a local Expo module only exists once the APK is rebuilt — and
  kaiibi's null-fallbacks make the gap look like correct behaviour rather than
  an error. Compare `dumpsys package com.kaiibisteam.kaiibi | grep
  lastUpdateTime` against the module's commit date before trusting a "feature
  not present" result. Rebuild needs BOTH exports:
  `JAVA_HOME=<Android Studio JBR>` and `ANDROID_HOME=~/Library/Android/sdk`,
  then `cd android && ./gradlew assembleDebug` and
  `./scripts/android-emu.sh install <target>`.
- **The emulators count as scanner tills.** Their `qwerty2` input device is
  non-virtual and alphabetic, so `useHardwareKeyboard` answers `true` — the
  hardware-keyboard/keypad world is fully drivable on Android. On iOS the
  equivalent (I/O ▸ Keyboard ▸ Connect Hardware Keyboard) is GUI-only; there
  is no `simctl` for it, so that world stays unreachable on iOS here.
- **RN `Switch` is invisible to uiautomator.** It exposes no labelled node;
  find the row's label text, then `tapxy` at the switch's geometry (x ≈ 910 on
  the phone, right-hand edge of the modal on tablets), and screenshot to
  confirm the flip — the tap reports success either way.
- **Modal editors scroll separately.** `ui` only dumps rendered nodes, so a
  control below a modal's fold does not exist yet: `input swipe` inside the
  modal, then re-`find`.
