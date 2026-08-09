---
name: testing-kaiibi
description: Use when asked to test the kaiibi app — end-to-end, on a platform ("test iphone", "test web", "test android tablet", "test all"), on a module ("test pos", "test inventory and accounting"), or against what just changed. Also when verifying a change actually works in the running app rather than only in tests.
---

# Testing kaiibi

## Overview

Drive the real app against the real test shop and assert on what the screen
says. Not jest — this skill is for the running app on web, iPhone, iPad, and
Android phone and tablet.

**Sign in as `yusef@gmail.com` / `yusef1`.** That shop (`yusefshop`) exists to be
written to: create products, take sales, open and close registers freely.

**The core rule: a flow is not verified until you have read the result off a
screen.** Not "the click succeeded" — the number changed, the row appeared, the
stock went down.

## Invocation

`test <platform...> <scope...>` — either half may be omitted.

| Platform | Means |
|---|---|
| `web` | Chrome via Playwright MCP at `localhost:8081` |
| `iphone` | iPhone simulator |
| `ipad` | iPad simulator |
| `android` | Pixel 8 emulator + both tablets |
| `android phone` / `android tablet` | just that one |
| `mobile` / `native` | iphone + ipad + android |
| `all` | every platform above |
| *(omitted)* | web, plus any platform the diff implicates |

| Scope | Means |
|---|---|
| a module name | `pos` `inventory` `people` `accounting` `dashboard` `registers` `settings` `platform` `public` — every flow in that module |
| several names | `test web pos inventory` runs both |
| `all` | every module, plus the cross-module assertions |
| `changed` | *(default)* only what the diff touches |

So `test iphone all`, `test web pos`, `test android tablet accounting`,
`test all all`, or bare `test`.

Read `references/modules.md` for what each scope owns and which flows prove it.

## Choosing scope when none was given

```bash
git diff --name-only    # add main...HEAD if the work is committed
```

Map those paths to modules with the table in `references/modules.md`, then:

- **A change inside one module** → run that module's affected flow, plus any
  cross-module assertion it feeds (a POS edit still has to move accounting).
- **A change to something shared** — `src/lib/*` used by several modules,
  `src/constants/**`, a `components/` primitive, a layout or tab file, a
  migration → **cross-cutting**. Run the full module test for *every* module
  that renders it, on top of the flow you changed. Exercising one screen does
  not test a component sitting under five.
- **A breakpoint or responsive change** (`useWindowDimensions`, `compact`,
  `desktop`) → all four platforms. That code only ever breaks at one width.

State the scope you picked and why before you start driving.

## Running it

Read `references/drivers.md` before touching a platform — each has a driver and
a set of traps that will otherwise cost you a silent no-op.

Briefly: **web** is Playwright MCP against real routes and is the only place with
full interaction plus fast assertions, so lead with it. **Android** is
`scripts/droid.sh` (`find` / `tap` / `type` / `goto` / `shot`), a real element
tree, full interaction. **iOS taps are not available on this machine** —
iPhone and iPad verify layout, rendering and data through screenshots, and
`references/drivers.md` records the one-time unlock if the user wants more.

Per platform: reach the module, walk the flow, read the result back, screenshot
anything visual, and record pass or fail with the evidence.

## Test data

- Prefix anything you create with `QA ` — `QA smoke widget` — so it is
  identifiable later.
- Do not delete pre-existing shop data. Leave your own artefacts unless asked to
  clean up; list them in the report so the user can.
- Sales, stock moves and register sessions are not reversible from the UI. That
  is fine on this shop, but say what you created.

## Reporting

Per platform × module: pass, fail, or **not exercised** — and never round the
third up to the first. For a failure give the screen, the action, what you
expected, what the screen said, and a screenshot for anything visual.

Close with the artefacts you created and anything you could not reach.

## Common mistakes

| Mistake | Why it bites |
|---|---|
| Claiming an iOS flow passed | You cannot tap on iOS here. You verified rendering. Say so. |
| Trusting a click that returned no error | RN swallows clicks in scroll views silently. Read the screen after every action. |
| Reusing element refs or coordinates | Both go stale on the next render. Re-query immediately before acting. |
| Testing only the module you edited | Shared code fails in the screens you did not open. |
| Stopping at "the sale completed" | The sale is only correct if stock, the register tally and accounting all moved. |
| Starting a second dev server | Metro is usually already up on 8081, and the user's simulators are live on it. Check first. |