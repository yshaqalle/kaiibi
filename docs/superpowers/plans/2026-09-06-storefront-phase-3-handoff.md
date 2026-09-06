# Storefront redesign — handoff into Phase 3

> **Read this before the master plan.** `2026-09-05-storefront-master-plan.md` still holds the
> decision ledger and the Phase 3/4 task lists and remains authoritative for *what* to build.
> This file records what actually happened building Phases 1 and 2 — the environment traps and
> the failure patterns — so the next session does not rediscover them the expensive way.

## Where things stand (2026-09-06)

| | State |
|---|---|
| **Phase 1** — apple blue, the slip, branding | **Merged** into `main` as PR #135 (squashed, `5eb7fe8`) |
| **Phase 2** — "The One", the shop page | **PR #136** open, branch `storefront-the-one`, 13 commits, rebased onto the merged main |
| **Phase 3** — "The Store", the directory | **Not started.** Tasks 18–20 in the master plan |
| **Phase 4** — About & Visit | Not started. Tasks 21–22 |

`npx jest` → 238 suites / 4317 tests. `npx tsc --noEmit` → clean.

Workspace: worktree `.claude/worktrees/storefront-apple-blue`. Phase 3 should branch from
`storefront-the-one` (it will want the shared `mouse-pan.ts` and the motion-decision precedent),
or from `main` if #136 has already merged.

---

## Environment traps — every one of these cost real time

**The dev server you can see is probably not the one serving your work.**
The user's Metro on **8081** serves the *main checkout* (`/Users/yusefs/development/kaiibi`),
which sits on its own branch. A worktree needs its own server on another port. Check what a port
actually serves before trusting anything on screen:

```
lsof -p "$(lsof -tiTCP:8081 -sTCP:LISTEN | head -1)" | awk '$4=="cwd"'
```

A stale browser tab will keep requesting its bundle from whichever port it first loaded from —
symptom is `Refused to execute script … MIME type ('application/json')`, which means that port
returned a 500 for the bundle. Hard-reload, and prefer running only one Metro.

**The repo `.env` points at PRODUCTION Supabase** (`jskobdvamobyigmmslrp.supabase.co`).
None of this redesign's migrations have ever been applied there. Against production the new
columns are simply absent, everything fails open, and you will believe you have tested something
you have not. This worktree has its own gitignored `.env` pointing at `http://127.0.0.1:54321`.
**Keep it that way**, and never point a test run at production.

**`npx supabase migration up` does not work here.** The local applied-migration history stops
around `20261018000000` while the directory runs past `20261102000000`, and the CLI dies on an
unrelated earlier migration. Every migration on this work was applied with `psql -f` directly:

```
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -X -q -v ON_ERROR_STOP=1 -f <file>
```

**Never run `npx supabase db reset`** — it wipes local dev data.

**`psql -c "a; b; c;"` runs the batch as ONE transaction.** A later statement erroring silently
rolls back your earlier `UPDATE`. This produced a phantom "the RPC disagrees with itself" bug that
took several queries to unwind. Use separate `-c` invocations when you mean separate commits.

**Never use `git stash`.** The stash stack is shared with the user's other worktrees and holds
other sessions' work. Two subagents did it anyway despite explicit instruction; both times the
stack survived, but verify with `git stash list` if it happens. Use a scratch copy or a temporary
commit you reset.

**The local test shop** is `yusefshop` (`03714e72-b4f3-4f49-803c-9f6e56d78eb2`), and it is seeded:
~28 listed products, 21 with photographs, 4 categories, opening hours, a hero image. Everything
seeded is prefixed `QA `. The other local shop, `Yusef Shop`, is unpublished and has no slug.
There is **no flyer** — `storefront_flyers.image_path` points at Supabase storage, so a fake path
renders a broken image; the carousel needs a real upload through the editor.

---

## The failure patterns — this is the important part

**Four of Phase 2's six tasks shipped a defect that the entire test suite passed.** Not one was
caught by writing more tests of the same kind. The pattern repeats, so watch for it:

**1. Order is not adjacency.** A test asserting `searchIndex < flyerIndex < categoryIndex` stays
green with two unrelated cards wedged between them. Both the floating search and the flyer
carousel shipped attached to the wrong element this way. **If a requirement says "directly under"
or "overlapping", assert the actual sibling relationship**, and confirm the test fails on the
pre-fix code.

**2. "It was called" is not "it had an effect."** A test proved `preventDefault()` was invoked on
a plain object. In a real browser React attaches its delegated `wheel` listener **passively**, so
the call was a no-op and the page kept scrolling. A real `addEventListener(…, { passive: false })`
via ref is required. Note this one **cannot be covered by a test here** — under Jest the scroller
ref is an RN class instance, never a DOM node.

**3. Style values are not rendered results.** A test asserted `marginTop === -21`. The parent was
a flex column with `gap: 14`, and gap sums with margin — so the real overlap was 7px. Assert the
composed result, not the input.

**4. `Platform.OS === 'web'` is true in a phone browser.** This storefront's main audience arrives
from a WhatsApp link on a phone. Mobile browsers synthesise a ghost `mouseenter` after a tap, so
hover must be gated on `matchMedia('(hover: hover)')` — there is a `supportsHover()` helper in
`src/components/storefront/mouse-pan.ts` that already handles the native guard.

**5. The reanimated mock discards props.** `jest/reanimated-mock.js` renders `Animated.View` as a
plain `View` and throws away `entering`, so **no animation can be asserted by rendering** — a test
that tries will pass whether the feature exists or not. The established pattern is to extract each
motion decision into a **pure exported function** and test that, plus a dedicated suite that mocks
`useReducedMotion` and asserts the flag actually reaches each decision. Every such test on this
branch was proven to fail by breaking the wiring and restoring it. Keep doing that.

**6. Transform arrays collide.** RN style flattening replaces the whole `transform` array on key
collision, so a pressed scale silently wipes out a hover lift on the same node. If you add a
hover transform, compose it so both survive, and test by hovering and pressing **the same node** —
a test that hovers one node and presses another proves nothing.

**7. Read the plan's premises sceptically.** The plan has been wrong about facts several times:
the search threshold is **25**, not 12; there is no accent-filled `continueButton`; the
`get_public_storefront_products` definition is in `20260924000100`, not the file a naive
`grep -l | tail -1` finds (that one only *mentions* the name in a comment); `shop_effective_plan`
takes `s.id` in one RPC body and `o.shop_id` in another. **Verify before copying.**

---

## Process that worked

`superpowers:subagent-driven-development` — one implementer per task, then a task-scoped reviewer,
then a whole-branch review on the most capable model at the end. **The whole-branch review earned
its cost twice**: it caught the branding capability being built as a bespoke column instead of the
existing module mechanism (which would have handed the mark back to every paying shop the first
time Pro retired into a successor), and it caught the aurora's GPU cost.

A durable ledger lives at `.superpowers/sdd/progress.md` (gitignored). It records every task, every
review finding and every open decision from both phases. **Read it** — it is the detailed record
this summary compresses.

Per-task reviews reliably missed composition-level problems. The whole-branch review found the page
was stating "collection" three times and that a sliding indicator was invisible in the common case.
Budget for it.

---

## Open items carried into Phase 3

None of these block Phase 3, but they are unfinished:

- **Nothing in Phase 2 has run on iOS or Android.** This is the largest untested surface. It needs
  port 8081, which the user's Metro holds — a simulator build always fetches from 8081 regardless
  of the port you launch it with, so you must own that port or ask the user to free it.
- The flyer carousel has never been driven end to end (no real flyer exists locally).
- `ShopTabRail` carries a sliding pill the plan never asked for. Kept deliberately.
- A pre-existing hover/press transform collision remains in `CategoryTile`.
- `TILE_WIDTH`/`TILE_HEIGHT` and several type sizes are freehand; `scale.ts` has no sizing ramp.
- `StorefrontProduct.createdAt` is optional, so the admin editor preview never shows NEW badges.
- **The four Phase-1 migrations and Phase-2's `20261102000000` have never been applied to
  production.** Deploying this is a real, unscheduled step.

---

## Phase 3 — "The Store"

Tasks 18–20 in the master plan; the visual source of truth is the **"The Store"** section of
`docs/design/storefront-bold-motion-mockup.html`.

**Read these first** — none has been touched by this work:
`src/components/storefront/shop-directory-card.tsx`, and the directory screen itself
(`grep -rn "ShopDirectoryCard\|directoryColumnsForWidth" src/app src/components`).

- **Task 18** — a kaiibi masthead (mark and wordmark in kaiibi blue `#0071e3`; *this* is kaiibi's
  own page, so the blue is at home here and only here), one-line promise, prominent search that
  matches shop names **and their sell-tags**, city chips filtering on `city`, "All" by default.
- **Task 19** — render `featuredShop()` as a photo-scrim hero card with a serif name, an open pill
  and a blue **Visit shop** button. No photo → the existing ink-filled feature card, kept.
- **Task 20** — card v2: photo, name, **open dot + word** (never colour alone; closed shows
  "opens 8am" via the hours helpers), city, sell-tags as quiet chips. Web hover-lift, entering
  stagger once. **Shop cards stay palette-neutral** — a shop's colours bloom on its own page, not
  in the list.

Constraints inherited: admin untouched; no hex at call sites (`HERO_SCRIM`, `TILE_SCRIM`,
`ON_SCRIM_INK`, `ON_SCRIM_MUTED` and the palette live in `scale.ts` and `storefront-catalog.ts`);
`expo-linear-gradient` is the only dependency this work has added and the only one permitted;
transform/opacity only, entering animations once, everything no-ops under reduced motion.

**The directory is a different screen from the shop page.** Phase 2's composition work does not
apply to it — but `mouse-pan.ts`, `press-feedback.ts` and the pure-motion-decision pattern do.
