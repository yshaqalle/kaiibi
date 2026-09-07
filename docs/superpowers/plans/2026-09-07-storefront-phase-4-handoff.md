# Storefront redesign — handoff into Phase 4

> **Read this before the master plan.** `2026-09-05-storefront-master-plan.md` still holds
> the decision ledger and Phase 4's Tasks 21–22 and remains authoritative for *what* to
> build. This file records what actually happened building Phase 3, so the next session
> does not rediscover it the expensive way. The Phase 3 handoff
> (`2026-09-06-storefront-phase-3-handoff.md`) is still worth reading — its seven failure
> patterns all recurred.

## Where things stand (2026-09-07)

| | State |
|---|---|
| **Phase 1** — apple blue, the slip, branding | Merged, PR #135 (`5eb7fe8`) |
| **Phase 2** — "The One", the shop page | Merged, PR #136 (`815681a`) |
| **Phase 3** — "The Store", the directory | **Merged, PR #137 (`835fba2`)** |
| **Phase 4** — About & Visit | **Not started.** Tasks 21–22 in the master plan |

`npx jest storefront` → 242 suites / 4451 tests. `npx tsc --noEmit` → clean.
**All five migrations are applied to production** and verified through the anon endpoint;
Phase 3 added none. That open item from Phase 1 is closed.

Workspace: worktree `.claude/worktrees/storefront-apple-blue`. Branch Phase 4 off `main`.

---

## The one thing that made every difference

**Nothing was believed until it was measured on a screen.** Phase 3's plan tasks passed
their own reviews and still shipped defects; what caught them was a browser, a device, and
reviewers told to distrust the commit messages. Budget for all three.

Concretely, in this phase, the following were found ONLY by looking:

- the grid cards stopped filling their cells (an unstyled wrapper broke a flex chain)
- the lead shop rendered twice within 90px
- kaiibi blue meant "no filter applied"
- every closed shop lost its city after hours
- **every control on the checkout screen was under the 44px floor — Back was 17px**
- **a shop with two flyers blew its header to 16,777,216px**
- the goods box strobed between two heights while a window was dragged

None of those failed a test. Several were in code with a comment explaining why it was
correct.

## The pattern that recurred FOUR times — expect a fifth

**The commit that builds a detector leaves out of its fixture the one control the detector
would newly catch.**

1. the touch-target sweep could not see either sheet (RN's `Modal` returns `null` when
   `visible` is false)
2. it could not see the checkout screen (checkout *replaces* the browse screen)
3. it could not see the flyer carousel dots (`flyers: []` in the fixture)
4. it could not see About/Visit (`about: null`, `areas: []`, `images: []`, …)

Each time the test was green and named as though it covered everything. **When you add a
rule, the first question is not "does it pass" but "what is not in the tree when it runs".**
The sweep now covers every public surface; if you add one, add it to
`storefront-touch-targets.test.tsx` in the same commit.

## Environment traps (all still live)

**Port 8081 is the only port a simulator will use.** The user's Metro usually holds it,
serving the MAIN checkout on a different branch. Check what a port serves before trusting
anything:
`lsof -p "$(lsof -tiTCP:8081 -sTCP:LISTEN | head -1)" | awk '$4=="cwd"'`

**The installed simulator app can be older than the branch.** The iOS build in use at the
start of this phase predated `expo-linear-gradient`, so *no gradient on the branch could
render there* and screenshots would have shown a "bug" that did not exist. If anything
native looks wrong, check the binary before the code: `expo run:ios` / `expo run:android`.
Both were run in this phase and both work now (Android in 2m55s; `android/` and `ios/` are
gitignored CNG output).

**Android gives real interaction; iOS does not.** `adb` exposes a live view tree —
`uiautomator dump` plus `input tap/swipe` — and that is how the touch targets were measured
at 44.2dp on a device. The iOS simulator has no input injection here. Reverse the ports the
emulator needs: `adb reverse tcp:8081 tcp:8081`, and `54321`/`54322` for local Supabase.

**`uiautomator` cannot see `hitSlop`.** It reports view bounds, so a control that is
34dp + `hitSlop: 10` (54dp of real target) looks like a defect. Two "findings" in the
Android dump were false for exactly this reason.

**`products.stock` is derived.** `product_stock_is_derived_trigger` recomputes it from
`product_location_stock` on every UPDATE, so `update products set stock = …` silently does
nothing. Write to `product_location_stock`. And do NOT use `ON CONFLICT DO UPDATE` there
without recording the previous values — that overwrote real stock in this session and it
could not be fully restored.

**The migration CLI works again.** The local history was stuck at `20261018000000` since
Phase 1; 14 migrations were verified present object-by-object and then stamped, so
`supabase migration list --local` now reports `local == remote` for all 233. **Never
`npx supabase db reset`.**

**Never `git stash`.** The stack is shared and holds three other branches' work. Two agents
did it anyway across Phases 2–3. It survived both times; verify with `git stash list` if it
happens again.

## Process that worked, and what it cost

`superpowers:subagent-driven-development` — implementer, task reviewer, then a whole-branch
review on the most capable model. **Run the final review even when the branch feels done.**
Three separate whole-branch reviews ran in this phase and each found something the tests
could not see; two of those findings were in code the *controller* had written directly in
a fast loop with the user.

The reviewer prompt that worked told the reviewer: the commit messages quote live
measurements, **treat them as claims, not evidence**. That instruction caught a comment
asserting a platform behaviour that was false on native.

**A durable ledger lives at `.superpowers/sdd/progress.md`** (gitignored). It records every
task, review finding, correction and open decision across all three phases. Read it.

## Mistakes worth not repeating

- **A wrong selector produced a wrong finding, twice.** "The shop name renders at 0×0" was
  the `<title>` element, which has no box. A grep that "found nothing" was a pattern missing
  a stray `&s`. **Verify the probe before believing the result** — especially a negative.
- **A comment that describes deleted code outlives it.** One commit deleted an effect and
  left four comments describing it, one commit after the commit whose entire purpose was
  making those comments honest.
- **Two paddings, each correct alone, made one misalignment.** A shared component carried
  its own gutter and was later placed inside a padded container. The gutter belongs to the
  container that knows its own margins.

## Phase 4 — About and Visit

Tasks 21–22 in the master plan; reference is the patterns mockup's About/Visit sections.
No new features — order and emphasis only.

- **Task 21 — About: photos first.** Cover photo (first gallery image) with a caption strip
  → thumbnails → proof chips (trading-since / items-in-today / answers-on-WhatsApp, all from
  fields already mapped) → story+highlights merged → FAQ last, unchanged.
- **Task 22 — Visit: the decision card.** Lead with one ink card: open pill, the collect
  line set serif at direction-card size, **Get directions** (`mapsUrlFor`) + WhatsApp side
  by side. Hours collapse to "Today: X – Y · All hours ▾" (expanded keeps the honest seven
  rows). Delivery areas → priced chips. Contact → an icon row including **Share shop**.

**The local shop is already seeded for this work** — `yusefshop` has a contact phone,
Instagram `qakaiibi`, an About paragraph, 2 highlights, 2 gallery images, 2 delivery areas
and `offers_delivery = true`, so both panels render fully instead of collapsing to empty
states. That data is QA data and can be changed or removed freely.

Both panels are bounded by `PROSE_MAX_WIDTH` (820) via `shop-chrome.tsx`, and their
controls are now swept for the 44px floor — keep both true.

## Open, and genuinely undecided

- **The iOS scroll trap.** The goods grid is a bounded scroller inside the page scroller.
  Android chains out of it (verified: six swipes reached the footer) because of
  `nestedScrollEnabled`; **iOS has no equivalent and no browser-style overscroll chaining**,
  and it could not be tested here. One swipe over the grid on a real iPhone answers it. The
  risk and the options are written at the structure in `theme-market.tsx`.
- **The nested-VirtualizedList `__DEV__` error fires on iOS** on a freshly built app. Dev-only
  noise, not a production fault, but real — the structure is deliberate and a reviewer
  verified it against RN's own source, so do not "fix" it by reverting the structure.
- **A 14-inch laptop still scrolls ~680px.** The page length no longer grows with the
  catalogue (the goods hold 2 rows, 3 where there is room), but header 358 + footer 196
  means a true fit needs a compact header. Deliberately not done.
- **`ShopTabRail` carries a sliding pill nobody asked for**, kept since Phase 2.
- The About gallery at 820px is narrower than it was before the branch.
