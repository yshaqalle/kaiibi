# A Lapsed Storefront Keeps Its Work

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a shop's plan lapses, it gets a month, then keeps everything it built while the page comes down — and the app shows it the way back.

**Architecture:** Almost no new machinery. `grace` is already a first-class status, `grace_until` already exists, and the public read already goes dark when the module does. This is a grace window, a nav treatment, one deliberate unpublish, and the tests that hold them.

**Tech Stack:** Supabase Postgres, React Native Web, Expo Router, Jest.

## Why this exists

The owner's decision, verbatim:

> One month of grace. After that, keep the data, unpublish the page, and grey it out until
> the shop pays.

**Deadline: the first trial lapses 2 November 2026.** Seven of eleven shops are on Trial.
Design note: `docs/superpowers/specs/2026-08-28-storefront-when-a-plan-lapses.md`.

Nothing is deleted. Paying is the way back, and the shop can *see* the way back.

## What already works — do not rebuild these

| Piece | Where |
|---|---|
| `grace` status | `src/lib/entitlements.ts:94`, documented as "still fully usable" |
| `grace_until` | `shop_subscriptions.grace_until` |
| Status from dates | `shop_effective_status()` |
| The page goes dark on lapse | `get_public_storefront` calls `shop_has_module(s.id,'storefront')` (`20260930000300:195`) |
| Writes blocked when expired | `entitlements.ts:201` |
| **The address stays reserved** | `shops.slug` is untouched by lapse, so `claim_shop_slug` keeps refusing it |

## Global Constraints

- **Migrations: use the `202609*` range.** `202610*` belongs to accounting
  (`docs/superpowers/ACCOUNTING-ROADMAP.md:166`). `ls … | uniq -d` **cannot** prove a
  timestamp is free — it sees one worktree only. The real guard is
  `supabase/tests/migration-version-guard.test.ts` under `npm test`. Run it.
- **`security definer` functions must `revoke execute … from public` BEFORE granting** —
  `grant` alone is a no-op. Convention: `20260924000100_storefront_public_read.sql:103-109`.
- **Do not delete shop data on lapse.** That is the whole decision.
- **Do not change which plans include `storefront`.** This plan makes that question less
  urgent, not more.
- Bento tokens on admin screens, no hex literals. `Caveat tone="wrong"` must always carry
  an action that removes its cause.
- The local Supabase is shared and gets wiped mid-run by other sessions. Reset from YOUR
  worktree before trusting a result.
- Mutation-test every check: perturb the expected value, confirm the test fails naming
  itself, restore, report. Eight implementers on this project have found their own checks
  vacuous this way.

---

## Task 1: Find out whether grace is real

**This decides the size of everything else, so it comes first and changes no behaviour.**

**Files:** none — investigation, reported in the task report.

**Properties:**

1. Determine whether `shop_has_module()` (the SQL function the public read calls) resolves
   a module for a shop whose effective status is `grace`. Read the function; do not infer
   it from `entitlements.ts`, which is the *client's* view.
2. Determine the same for the client's `hasModule()`.
3. If either says no, **the grace month is not real** — the page goes dark on day one, and
   Task 2 grows a fix.

- [ ] **Step 1: Read `shop_has_module` and `shop_effective_status` in the migrations**
- [ ] **Step 2: Prove it with a fixture** — a shop whose trial has ended but whose
      `grace_until` is in the future. Assert `get_public_storefront` still returns its page.
- [ ] **Step 3: Report which of the two paths honour grace**, with the evidence

## Task 2: One month of grace, and it actually holds

**Files:** `supabase/migrations/20260930000400_storefront_grace_month.sql` (adjust the
number if taken — check the guard, not `uniq -d`); `supabase/tests/verify-lapse.sql`

**Properties:**

1. When a subscription's trial or period ends, `grace_until` is one month later.
2. Through that month the shop is unchanged: the page serves, the editor writes, orders
   arrive and can be fulfilled.
3. If Task 1 found grace is not honoured, fix that here — a shop in grace must resolve the
   `storefront` module.
4. Existing subscriptions are handled: decide and state whether the month is backfilled for
   the trial that has already expired, or only applies going forward.

- [ ] **Step 1: Write the failing checks** — a shop in grace still serves its page; a shop
      past grace does not
- [ ] **Step 2: Run and watch them fail**
- [ ] **Step 3: Write the migration**
- [ ] **Step 4: `npm run test:db`, and the version guard under `npm test`**
- [ ] **Step 5: Commit**

## Task 3: Grey it out — do not hide it

**Files:** `src/components/admin-sidebar.tsx`, `src/components/admin-tabs.tsx`,
`src/components/admin-tabs.web.tsx`; tests in `src/components/__tests__/admin-sidebar.test.tsx`

**This is the half a shopkeeper experiences, and it reverses an earlier decision.**

The rows are gated on `hasModule('storefront')` and *hidden* when it is false. The comment
defends that with: *"a shop that never had a storefront is not missing anything it can
see."* True — and it does not hold for a shop that had one and lapsed. Hiding the row from
that shop removes the only signpost back to paying.

**Properties:**

1. A shop that **has a storefront row** but **not the module** sees Storefront and Orders
   **greyed with the 🔒 treatment**, the same as the five paid tabs get. Tapping lands on
   the upgrade wall in `(admin)/_layout.tsx`, which is where the offer belongs.
2. A shop that **never had a storefront** still sees nothing. That half of the original
   reasoning stands.
3. The distinction is "a `storefronts` row exists for this shop", which
   `getMyStorefront` already answers.
4. Applies to the wide rail, the phone ☰ menu, and native. **#102's rule holds: each row
   appears once per screen, never twice** — the rail and the menu must not both show it at
   wide width.
5. The waiting-order badge (#100) must not vanish for a lapsed shop with open orders —
   those orders still exist and still need fulfilling.

- [ ] **Step 1: Write the failing tests** — lapsed-with-storefront shows locked rows;
      never-had-one shows none; still once per screen at wide width
- [ ] **Step 2: Run and watch them fail**
- [ ] **Step 3: Implement**
- [ ] **Step 4: `npm test`, `npx tsc --noEmit`**
- [ ] **Step 5: Commit**

## Task 4: Unpublish deliberately at the end of grace

**Files:** a migration in the same series; `supabase/tests/verify-lapse.sql`

**Properties:**

1. At the end of grace, `storefronts.published_at` is set to null. **Everything else stays**
   — the row, the flyers, the delivery areas, the theme, and `shops.slug`.
2. **Why explicit rather than relying on the module check:** today the page is dark only
   because `shop_has_module` fails, so paying makes it reappear *exactly as it was*. After
   a month away that page may be advertising last month's prices to a customer who orders
   at them. Publishing again should be a deliberate act.
3. After paying, the editor shows the page as a **draft**, and says why it is in draft
   rather than leaving the shop to guess.
4. Idempotent: running it twice does not damage a shop that has since republished.

- [ ] **Step 1: Write the failing checks**, including the republish-then-run-again case
- [ ] **Step 2: Run and watch them fail**
- [ ] **Step 3: Write the migration**
- [ ] **Step 4: `npm run test:db`**
- [ ] **Step 5: Commit**

## Task 5: Pin the address against a future cleanup

**Files:** `supabase/tests/verify-lapse.sql`

**Properties:**

1. A lapsed shop's `shops.slug` is unchanged, through grace and past it.
2. Another shop **cannot** claim that slug while the first is lapsed —
   `claim_shop_slug` still raises `slug_taken`.
3. This works today for free. The test exists so that anyone later adding a cleanup which
   nulls `slug` on lapse fails loudly, instead of handing a competitor the address a shop
   printed on its cards.

- [ ] **Step 1: Write the checks** — they should pass immediately against current code
- [ ] **Step 2: Prove they can fail** — null the slug in a scratch copy, watch them go red
- [ ] **Step 3: Commit**

## Task 6: Browser verification

**Not optional.** Six defects across this series shipped through a fully green suite and
were caught only here.

Use `.superpowers/sdd/reseed.sh`. At **390px and 1280px**:

- [ ] A shop in grace: page serves, editor works, an order can be placed and fulfilled.
- [ ] A shop past grace: the public page is gone, and the shop sees **greyed** Storefront
      and Orders rows — not missing ones.
- [ ] Tapping a greyed row lands on the upgrade wall.
- [ ] The shop's flyers, delivery areas and address are all still there in the editor.
- [ ] Restore the module: the page is a **draft**, the editor says why, and publishing
      brings it back at the same address.
- [ ] Screenshot the greyed nav and the draft state; attach to the PR.

## Done when

- `npm test`, `npm run test:db`, `npx tsc --noEmit` all pass.
- A shop that stops paying loses its page, not its work.
- The app shows that shop the way back.
- Nobody can take its address while it is away.

## Not in this plan

| Left out | Why |
|---|---|
| Changing which plans include `storefront` | This makes that question less urgent. |
| Dunning, reminders, payment capture | A different subsystem. |
| Deleting anything on lapse | The decision is explicitly to keep it. |

---

## Also outstanding, unrelated to lapse

- **Bulk product listing** (~half a day): multi-select on the Inventory "Not online"
  filter with an explicit confirm naming the count. 4 products are listed online across 11
  shops; the per-product toggle may be why.
- **Native verification**: #93/#95/#100 are Jest-verified on native, never seen on a phone.
  Needs **port 8081** — see `docs/superpowers/HANDOFF-2026-08-27-storefront.md` for why no
  other port works.
