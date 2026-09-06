# Storefront Redesign — Master Plan (entry point)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. This file is the entry point; Phase 1's task-level TDD specs live in `2026-09-05-storefront-apple-blue-and-branding.md` in this directory and are executed as written there. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Ship the settled storefront redesign — the apple-blue system, the checkout slip, kaiibi branding with Pro removal, then "The One" (hero + carousel shop page), "The Store" (the directory), and the About/Visit re-weightings — touching nothing in the admin app.

**Workspace:** `.claude/worktrees/storefront-apple-blue`, branch `worktree-storefront-apple-blue`, rebased onto `origin/main` @ 542e429 (#133) on 2026-09-05. Verified at that point: **4,137 storefront-matching tests green, `tsc --noEmit` clean.** Two commits already on the branch: the azure client catalog (`58e4f09`-equivalent) and the design docs. A fresh worktree needs four gitignored build artifacts copied from the main checkout before `tsc` passes: `expo-env.d.ts`, `src/global.css`, `src/components/animated-icon.module.css`, `.expo/types/router.d.ts` — already present here.

**Before starting:** `git fetch origin && git rebase origin/main`, re-run `npx jest storefront && npx tsc --noEmit`. If the rebase touches `src/components/storefront/` or `src/lib/storefront-catalog.ts`, re-read the conflicted files before continuing. Never push or touch the branch `storefront-editor-removes-and-errors`.

---

## The decision ledger (what is settled — do not relitigate)

| Decision | Detail |
|---|---|
| **Apple blue is the direction** | Azure palette (`#0071e3` accent) as a pickable seventh option; DB constraint fix is Phase 1 Task 1. |
| **`CHECKOUT_BLUE` is fixed on every palette** | `#0071e3` + white on the slip button, checkout continue, place-order. The WhatsApp-green pattern applied to the commit moment. Pinned byte-identical to azure's accent by test. |
| **Tinted action tier** | `accentWash`/`accentInk`, derived per palette (accent-as-text fails 4.15:1 on its own wash — derivation solves it). |
| **Palm retune** | accent `#14543a`, ink `#15191b` — stops green-on-green with the fixed WhatsApp button. |
| **Checkout = the slip** | Ground container, thumbnails + total + count/fulfilment, proportionate blue button; in the reading column; unconditional clearance. |
| **Desktop column 1320** | The admin shell's own ceiling; grid gains a 5th column ≥1280. |
| **Branding** | Footer colophon lockup, one outlined confirmation ask, mark on the order-status page; hidden on Pro via `plans.hide_storefront_branding` + `shop_effective_plan()` in the public RPCs; default is SHOW. |
| **The One** | Shop page composition: photo hero w/ scrim + serif rise (aurora fallback), floating search, flyer carousel in the promo slot, photo category tiles, tag-on-photo product cards + NEW badge, sticky slip, ink footer. |
| **The Store** | Directory: kaiibi-blue masthead, search that also matches what shops sell, city chips, featured-shop hero, cards with open-word + sell tags. Kaiibi blue is at full strength here and only here. |
| **Motion tiers 1–2 adopted** | Fly-to-cart, count-up, sliding category pill, wordmark rise (tier 1, Reanimated only); aurora, hero scrim, marquee-optional (tier 2, adds `expo-linear-gradient`). Guardrails: transform/opacity only, once-only except aurora/marquee, reduced-motion no-ops. |
| **Mouse affordances on web** | Horizontal carousels get wheel-pan, drag-to-grab, clickable dots, hover arrows — RN-web horizontal lists don't speak mouse by default. |
| **Rejected** | Slate palette, Lagoon (teal) palette, colour-blocked tiles, wishlists/ratings/swatches, WebGL backgrounds, cursor effects, React Bits imports (React DOM only — its *ideas* ported to Reanimated). |
| **Deferred** | Glass (tier 3, needs `expo-blur`), Somali-first strings (needs product sign-off + native review), slip "closed now", stock dots to ink, `DEFAULT_PALETTE` → azure, catalogue fetch pagination, desktop cart dock. |

**Visual sources of truth** (open before building UI; the mockups are in `docs/design/` in this worktree):
- Settled system + slip + branding: `kaiibi-blue-and-storefront-mockup.html` — published at `claude.ai/code/artifact/088a8612-7312-44b0-b1f5-7175ccf999a4`
- Patterns, About/Visit redesigns, wave-2: `storefront-design-patterns-mockup.html` — `claude.ai/code/artifact/e7aa8937-9ba8-4d44-be34-d00f19632942`
- **The One + The Store + motion (primary target)**: `storefront-bold-motion-mockup.html` — `claude.ai/code/artifact/113c23b7-9ba6-4f70-afbc-524c3ab094d8`

## Global constraints (inherited by every task)

- **Admin untouched:** nothing under `src/constants/theme.ts`, `src/components/accounting/`, POS, `(admin)` routes, or the storefront editor.
- **No hex at call sites:** colours come from `PaletteColors` or the catalogued fixed constants (`WHATSAPP_BUTTON_GREEN`, `CHECKOUT_BLUE`). New derivations go in `storefront-catalog.ts` with `it.each(PALETTES)` gates.
- **Sessionless:** the public page never calls an authed RPC. Public data changes ride `get_public_storefront` / `get_public_storefront_products` / `get_public_order` — copy the latest body forward, add columns only, re-grant to `anon, authenticated`.
- **Dependencies:** Phase 2 may add `expo-linear-gradient` only (via `npx expo install`). No `expo-blur`, no Skia, no DOM libraries.
- **Per task:** `npx jest storefront && npx tsc --noEmit` green before commit. Layout tasks end with a real render check; the whole plan ends with `/testing-kaiibi`.
- **Motion:** transform/opacity only; entering animations run once (never on tab switch); everything no-ops under reduced motion (`useReducedMotion` from Reanimated).

---

## Phase 1 · Foundations — EXECUTE FROM THE DETAILED PLAN

`docs/superpowers/plans/2026-09-05-storefront-apple-blue-and-branding.md`, Tasks 1–11, as written there (full TDD code included). Status: the azure client catalog (Task 1's client half) is already committed on this branch.

- [ ] Task 1 — DB accepts `azure` (constraint migration)
- [ ] Task 2 — tinted tier tokens `accentWash`/`accentInk` + gates
- [ ] Task 3 — quiet actions wear the tier
- [ ] Task 4 — Palm stops reading green-on-green (accent + ink)
- [ ] Task 5 — unconditional checkout clearance
- [ ] Task 6 — checkout bar joins the reading column
- [ ] Task 7 — the slip (incl. `CHECKOUT_BLUE`/`CHECKOUT_INK` constants + checkout-flow primaries)
- [ ] Task 8 — desktop column 1320 + 5th grid column
- [ ] Task 9 — `hide_storefront_branding` end to end (plans column + RPC + client mapping)
- [ ] Task 10 — footer colophon lockup
- [ ] Task 11 — confirmation ask; then the order-status mark (Task 12 there)

---

## Phase 2 · The One — the shop page composition

Build on Market first (the default theme); Window/Counter inherit the shared pieces automatically, and theme-specific slots are noted per task. Reference: the bold-motion mockup's "The One" section.

### Task 12: `expo-linear-gradient` + the hero scrim + wordmark rise

**Files:** `package.json` (via `npx expo install expo-linear-gradient`), `src/components/storefront/theme-shared.tsx` (`ShopAnchor`, ~line 129 — read its photo branch first).

- [ ] Read `ShopAnchor` fully. Its photo branch currently lays a flat 0.55 scrim over the image; replace with a bottom-weighted `LinearGradient` (`['transparent', 'rgba(16,22,35,0.82)']`, locations `[0.3, 0.92]`). This is also the fix-class for the live grey-shape defect: the gradient renders **only when `heroImageUrl` is present** — never over the no-photo fallback.
- [ ] Wordmark rise: wrap the anchor's name/place/status lines in Reanimated entering animations (`FadeInDown.duration(550).delay(i*80)`), gated: run once per mount of the shop tab, skipped entirely when `useReducedMotion()` is true. Status pills (from Phase-1 Task 8's open state… note: open-state pill on the anchor is **new here** — compute with `isConfigured`/`isOpenAt` exactly as `visit-panel.tsx` does, words + fill, never colour alone).
- [ ] Acceptance: photo shops show the gradient scrim with legible `ON_SCRIM_INK` type; photoless shops render the ink anchor unchanged (aurora is Task 17); no animation on tab switches; reduced-motion renders static.
- [ ] `npx jest storefront && npx tsc --noEmit` → commit `feat(storefront): the hero learns a real scrim and the wordmark rises once`

### Task 13: Floating search + the trust facts

**Files:** `src/components/storefront/theme-market.tsx` (search placement), `theme-shared.tsx` (`SearchField` styling).

- [ ] Restyle `SearchField` to the card treatment (radius 13, `ground` fill, shadow `0 8 24 rgba(ink,0.13)` via elevation/shadow props, search glyph) and pull it up to overlap the anchor's bottom edge by ~21px (negative margin on the wrapper, zIndex above the anchor). Placeholder becomes `Search {count} items…`.
- [ ] Under it (or in the anchor's status row where Task 12 put pills), ensure the three facts read without opening Visit: open state, collection word, pay-on-collection. No new data — compose from `storefront` fields already on the page.
- [ ] Acceptance vs the mockup's One section; search threshold behaviour unchanged (`shouldOfferSearch` still gates at 12 — when hidden, the anchor sits flush and nothing overlaps).
- [ ] Verify + commit `feat(storefront): the search floats and the facts read at a glance`

### Task 14: The flyer carousel takes the promo slot (with mouse handlers)

**Files:** read `src/components/storefront/flyer-carousel.tsx` (19KB — unread; do this first), `theme-market.tsx`.

- [ ] Read the carousel's current API and where it renders today. Deliverable: it renders in The One's slot — directly under the floating search, above categories — as swipeable snap cards with dots, only when the shop has flyers (no empty frame).
- [ ] Web mouse affordances (RN-web): wheel-pan (vertical delta → horizontal scroll, `preventDefault`), drag-to-grab on `pointerType === 'mouse'` (suspend snap while dragging, settle to nearest card on release), clickable dots, hover-only ‹ › arrows (`(hover:hover)` equivalent: show on `onHoverIn`, pointer devices only). Touch behaviour untouched.
- [ ] Acceptance: mockup's carousel behaviour reproduced on web with a mouse; native swipe unchanged; dots track position.
- [ ] Verify + commit `feat(storefront): the flyers take the promo slot, and a mouse can drive them`

### Task 15: Photo category tiles

**Files:** `theme-shared.tsx` (`CategoryFilterBar` / the category band — locate with `grep -n "CategoryBand\|CategoryFilterBar" src/components/storefront/theme-shared.tsx`).

- [ ] Each category tile derives its image from its first product with a photo (`products.find(p => p.category === c && p.imageUrl)`); scrim + label + count over it. A category with no photo degrades to the existing pill. Active state: the tile's scrim deepens + a `CHECKOUT_BLUE`-free accent ring? — **no**: active = accent-filled label chip on the tile, consistent with the pill rule ("accent = the active filter").
- [ ] Acceptance vs mockup; filter behaviour byte-identical (only presentation changes); still horizontal-scrollable with the Task 14 mouse handlers pattern where it overflows.
- [ ] Verify + commit `feat(storefront): categories become windows, not words`

### Task 16: Tile v2 — price tag on the photo, and the NEW badge

**Files:** `src/components/storefront/product-tile.tsx`, `src/lib/storefront.ts`, `src/types/models.ts`, one migration.

- [ ] Price moves onto the photo as a `ground` pill (tabular numerals), bottom-left; tile shadow per the mockup (`0 2 10 rgba(ink,.06)`), photo inset radius 13; the text block simplifies (name + stock word).
- [ ] **NEW badge needs data:** `StorefrontProduct` has no `createdAt`. Migration `2026…_storefront_products_created_at.sql` recreates `get_public_storefront_products` (latest-body copy-forward recipe from Phase 1 Task 9) adding `created_at timestamptz`; client maps `createdAt: (row.created_at as string) ?? null`. Badge renders when `createdAt` is within 14 days — accent chip, top-right of the photo; absent `createdAt` → no badge (shipped-ahead-of-DB safe).
- [ ] Verify + commit `feat(storefront): the price sits on the photo, and new stock says so`

### Task 17: Motion tier 1 + the aurora

**Files:** `theme-shared.tsx` (slip + `CheckoutBar` from Phase-1 Task 7, category bar, `ShopAnchor`), `press-feedback.ts` (audit usage).

- [ ] **Fly-to-cart:** on Add, an accent dot (absolute, Reanimated shared values) arcs from the pressed tile to the slip (~520ms, transform-only), slip spring-bumps 3.5%, total **counts up** over 300ms with `TABULAR`. Reduced motion: values jump, slip still bumps once via opacity.
- [ ] **Sliding active pill** on the category bar (measure target layout, spring left/width — or Reanimated layout transitions).
- [ ] **Aurora fallback anchor:** photoless shops get three blurred radial `LinearGradient` blobs of the palette's own accent family drifting on a 14s loop at ≤50% opacity behind the ink card; static single radial under reduced motion.
- [ ] **Press feedback audit:** every pressable on the page uses `press-feedback.ts`; web hover-lift on tiles (`onHoverIn` scale/shadow), never on native.
- [ ] Verify (this task especially: run on a real device via `/testing-kaiibi` — 60fps on low-end Android is the acceptance) + commit `feat(storefront): the page answers the hand — fly-to-cart, count-up, and a living anchor`

---

## Phase 3 · The Store — the directory

Reference: the bold-motion mockup's "The Store" section. Read `src/components/storefront/shop-directory-card.tsx` and the directory screen (locate: `grep -rn "ShopDirectoryCard\|directoryColumnsForWidth" src/app src/components`) fully before starting.

### Task 18: Masthead, search-that-knows-what-they-sell, city chips

- [ ] Kaiibi masthead (mark + wordmark in kaiibi blue `#0071e3` — **this is kaiibi's page; the blue is at home here and only here**), one-line promise, prominent search. Search matches shop names **and** their sell-tags (the directory rows already carry what shops sell — surface it). City chips filter (`city` field), "All" default.
- [ ] Verify + commit `feat(storefront): the directory gets a front door`

### Task 19: The featured shop as a hero

- [ ] `featuredShop()` already picks one; render it as the photo-scrim hero card with serif name, open pill, and a blue **Visit shop** button. No photo → ink-filled feature card (current `FeaturedShopCard` treatment, kept).
- [ ] Verify + commit `feat(storefront): being featured finally looks like something`

### Task 20: Directory cards with life

- [ ] Card v2: photo, name, **open dot + word** (never colour alone; closed shows "opens 8am" via the hours helpers), city, sell-tags as quiet chips. Web hover-lift; entering stagger (once). Shop cards stay palette-neutral — the shop's colours bloom on their page, not in the list.
- [ ] Verify + commit `feat(storefront): the shops in the list look open for business`

---

## Phase 4 · About and Visit — the re-weightings

Reference: the patterns mockup's About/Visit sections. No new features; order and emphasis only.

### Task 21: About — photos first

- [ ] Reorder `about-panel.tsx`: cover photo (first gallery image) with caption strip → thumbnails → proof chips (trading-since / items-in-today / answers-on-WhatsApp, from fields already mapped) → story+highlights merged card → FAQ last, unchanged.
- [ ] Verify + commit `feat(storefront): about leads with what a stranger can see`

### Task 22: Visit — the decision card

- [ ] `visit-panel.tsx`: lead with one ink decision card — open state pill, the collect line set serif at direction-card size (start from `collectLocation(...)` composition), **Get directions** (existing `mapsUrlFor`) + WhatsApp side by side. Hours collapse to "Today: X – Y · All hours ▾" (expand keeps the honest seven rows). Delivery areas → priced chips. Contact → icon row incl. **Share shop** (`waLink` composer with the shop's URL).
- [ ] Verify + commit `feat(storefront): visit answers its one question first`

---

## Final verification

- [ ] Full: `npx jest storefront && npx tsc --noEmit` green; migrations apply in order.
- [ ] `/testing-kaiibi` end-to-end on web (mouse AND touch emulation), Android, iOS: Azure save persists; slip + fly-to-cart at 60fps; carousel drives by wheel/drag/dots/arrows; 1320 column + 5 grid columns ≥1280; hero scrim only over real photos; branding present on free / absent on pro; directory search finds a shop by a thing it sells; About/Visit match the mockups; reduced-motion renders everything static.
- [ ] Then `superpowers:finishing-a-development-branch` — PR against `main` from `worktree-storefront-apple-blue`.

---

## Kickoff prompt for a fresh session

```
Continue the kaiibi storefront redesign from its parked worktree.

Enter the worktree first: EnterWorktree with path
.claude/worktrees/storefront-apple-blue (branch worktree-storefront-apple-blue).
Then: git fetch origin && git rebase origin/main, and re-verify the baseline
(npx jest storefront && npx tsc --noEmit — expect all green; if tsc fails on
hovered/global.css, copy the four gitignored build artifacts named in the
master plan from the main checkout).

Read docs/superpowers/plans/2026-09-05-storefront-master-plan.md — it is the
entry point: decision ledger, constraints, and Phases 1–4. Phase 1's full TDD
specs are in 2026-09-05-storefront-apple-blue-and-branding.md next to it.
The design decisions are settled — do not relitigate them; the three artifact
URLs in the master plan are the visual source of truth.

Execute task-by-task with superpowers:subagent-driven-development (or
superpowers:executing-plans), committing per task. Hard rules: admin app and
theme.ts untouched; no hex at call sites; only expo-linear-gradient may be
added; jest storefront + tsc green before every commit; never push or touch
the branch storefront-editor-removes-and-errors. Finish with /testing-kaiibi
and then finishing-a-development-branch.
```
