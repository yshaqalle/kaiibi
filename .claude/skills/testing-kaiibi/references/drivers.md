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

## iOS — Maestro (full interaction), plus simctl for screenshots

Booted sims are found with `xcrun simctl list devices booted`. Bundle id
`com.kaiibisteam.kaiibi`.

**Maestro is installed** (2026-08-09, `~/.maestro/bin`) and drives iOS
simulators and Android emulators from one YAML flow language:

```bash
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
export PATH="$JAVA_HOME/bin:$HOME/.maestro/bin:$PATH"
maestro --device <udid-or-serial> test flow.yaml
```

Flow steps that work against this app: `launchApp`, `tapOn: "Label"`,
`scrollUntilVisible`, `inputText`, `assertVisible` / `assertNotVisible`. On a
failure Maestro saves a screenshot per step under `~/.maestro/tests/` — read
the last one before theorising. Its `takeScreenshot` step is flaky; use
`simctl io <udid> screenshot` instead. Note `assertVisible` defaults to 100%
visibility, so an element half-hidden behind a dock or fold fails the assert
even though the flow genuinely worked — check the step screenshot.

`simctl` still covers the basics:

```bash
xcrun simctl io <udid> screenshot out.png     # then Read the png
xcrun simctl launch <udid> com.kaiibisteam.kaiibi
xcrun simctl terminate <udid> com.kaiibisteam.kaiibi
```

**A simulator build ignores `--port`, and this is why "deep links are
unreliable".** `expo-dev-client` is NOT a dependency of this project, so an
installed debug build has no launcher to re-point: it carries no
`main.jsbundle` and falls back to fetching JS from `localhost:8081` at runtime,
whatever URL you launched it with. `expo run:ios --port 8082` sets the launch
URL, builds, installs — and the app still loads from 8081. Verified 2026-08-27:
a fresh build on a spare simulator kept serving another worktree's branch and
that worktree's `.env` (production Supabase), so the screen showed a production
shop while the local one was seeded and expected. Zero bundling lines in the
8082 log is the tell.

So **to test native you must own port 8081.** If another session's Metro holds
it, either stop that Metro or wait — no flag routes around this. Check first:
`lsof -tiTCP:8081 -sTCP:LISTEN`, then confirm which tree it serves with
`lsof -p <pid> | awk '$4=="cwd"'`, and check that tree's branch AND `.env`
before trusting anything the app shows.

**Deep links are unreliable on iOS.** `simctl openurl` succeeded once on the
iPhone but on the iPad raised a SpringBoard *"Open in 'Ka Iibi'?"* alert that
blocks the screen; recover with `simctl launch`. With Maestro available,
prefer `tapOn` navigation over deep links on iOS.

**A stale .app hides native modules, same as Android.** Compare the installed
binary's date (`xcrun simctl get_app_container <udid> <bundle> ` → `ls` the
executable) against the module's commit; rebuild with `npx expo run:ios
--device <udid> --no-bundler`. Different sims carry different builds — on
2026-08-09 the iOS 18.3 devices had an Aug 7 binary while the iOS 26.5
iPhone 17 Pro Max had the current one. Check the one you are driving.

**GCKeyboard connects lazily in the simulator.** The Connect Hardware Keyboard
setting (GUI; also `defaults write com.apple.iphonesimulator
ConnectHardwareKeyboard -bool true` + Simulator restart) is not enough:
`GCKeyboard` stays nil until a *physical host keystroke* reaches the sim, and
Maestro/XCTest-synthesized input never crosses that bridge. So the
hardware-keyboard world cannot be entered on iOS by automation alone — either
the user presses one real key with the sim focused, or (for a layout /
interaction pass only) temporarily force the detection hook's return in JS on
the live dev server and revert immediately, saying so in the report.
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
