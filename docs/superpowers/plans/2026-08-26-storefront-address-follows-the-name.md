# The Storefront Address Follows the Shop's Name

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A shop's web address is derived from its name, and a collision offers a suffix to append rather than a blank box to start over.

**Architecture:** No schema. Everything is editor logic plus one new read for the shop's neighbourhood. The claim itself still goes through `claim_shop_slug`, which stays the only thing that decides who gets a name.

**Tech Stack:** React Native Web, Expo Router, Supabase, Jest.

## Why this exists

The editor SUGGESTS `normalizeSlug(shopName)` as a tappable row today
(`src/components/storefront/editor/content-drawer.tsx:102-103`), but when the name is
taken the shop is told *"That address is already taken — try a different one"* and left
with a blank field.

So two shops called **Xamdi Electronics** end up at unrelated addresses, and the one
that loses the race has to invent a brand rather than adjust the name it already has.
A customer who knows the shop cannot guess the link, which is the entire job of a
custom address.

**Design note:** `docs/design/storefront-address-and-flyers-mockup.html`, screens 1–4.

## The address is a slug, and the FORM it is shown in is not this plan's call

> **CORRECTED 2026-08-29, after #108 (`9f23ae9`) landed on main.** This section previously
> read *"The address is a subdomain … never `kaiibi.com/<slug>`"* and instructed Task 4 to
> confirm the editor prints a subdomain. **That is now backwards, and following it would
> reintroduce the bug #108 fixed.** Corrected below; the slug rules themselves are
> unchanged, and Tasks 1–3 are unaffected.

The shop's identity is the **slug** — one DNS label, 3–63 characters. That much never
changed, and every rule in this plan about deriving, normalizing, validating and claiming
it still stands.

What changed is which *address form* the app shows. `<slug>.kaiibi.com` **has no wildcard
DNS record and never did** — `dig +short xamdi.kaiibi.com` returns nothing. Shops were
publishing, pressing copy link, and sending customers an address that failed to resolve,
while `kaiibi.com/store/<slug>` — which has a real route file at
`src/app/store/[slug].tsx` — was shown nowhere. #108 fixed that.

The original objection in this section was still correct about the thing it was aimed at:
a **bare** `kaiibi.com/<slug>`, with no segment and no route, which `slugFromHostname`
never accepted. The shipped form carries the `store` segment and is routed.

**So: never build an address from a literal — that part is unchanged and now enforced.**
Every surface that shows, copies or sends one calls `storefrontAddress(slug)` from
`src/lib/storefront-host.ts`, the single source #108 created after two surfaces
hand-assembled the string and drifted apart. Today it returns
`kaiibi.com/store/<slug>`.

Which form is *canonical* is deliberately still open — options A/B/C in
[`docs/backlog/2026-08-27-storefront-wildcard-dns.md`](../../backlog/2026-08-27-storefront-wildcard-dns.md).
`slugFromHostname` is untouched and still resolves `<slug>.kaiibi.com` to the right shop,
so nothing here forecloses buying the DNS record later. **This plan must not settle it** —
call `storefrontAddress()` and inherit whatever the answer becomes.

## Global Constraints

- **No migration.** If a task seems to need one, stop and report — the whole point is
  that this is editor behaviour over a schema that already exists.
- **`claim_shop_slug` remains the authority.** Availability shown while typing is a
  courtesy; the claim is the truth. It already raises `slug_taken` on a lost race
  (`supabase/migrations/20260925000000_storefront_slug_claim.sql`). Never pre-reserve.
- **The assembled address goes through the existing `normalizeSlug` then `validateSlug`**
  (`src/lib/storefront-slug.ts`) so a suffix cannot produce an illegal address. Do not
  write a second set of rules.
- **Reserved names stay in one place.** `RESERVED_SLUGS` is read by both the app and
  `reserved_slugs()` in the database so the two cannot drift. Do not add a local list.
- **Unit tests:** `npm test`. **Typecheck:** `npx tsc --noEmit`. A fresh worktree shows
  phantom tsc errors until `.expo/types/router.d.ts` exists — run the dev server once
  before believing a tsc failure.
- Bento tokens only on admin screens; no hex literals. See the
  `building-bento-screens` skill.

## The decision that is easy to get wrong

**A claimed address must NOT follow a later rename of the shop.**

Deriving is for the unclaimed state only. Once claimed the address is frozen: renaming
the shop must not silently move its web address, because that breaks every link already
shared or printed. Changing it afterwards stays the deliberate act it is today, with the
warning the editor already shows.

Task 3 exists solely to pin this, and it is the task to be most careful with.

---

## Task 1: Derive the address from the name, while it is unclaimed

**Files:**
- Modify: `src/lib/storefront-slug.ts` (add the derivation helper)
- Test: `src/lib/__tests__/storefront-slug.test.ts`

**Interfaces produced:**
- `deriveSlugFromName(shopName: string): string` — `normalizeSlug` applied to the name,
  returning `''` when nothing usable survives.
- `applySuffix(base: string, suffix: string): string` — joins with a single hyphen,
  normalizes the result, and never produces a leading or trailing hyphen or a double one.

**Properties:**

1. `deriveSlugFromName('Xamdi Electronics')` is `'xamdi-electronics'`.
2. A name that normalizes to nothing (`'!!!'`, `''`) returns `''`, and the caller shows
   no suggestion rather than an empty address.
3. A name longer than 63 characters is truncated to a valid label **without a trailing
   hyphen** — truncation landing on a hyphen is the obvious bug here.
4. `applySuffix('xamdi-electronics', 'Koodbuur')` is `'xamdi-electronics-koodbuur'`.
5. `applySuffix` with an empty or whitespace suffix returns the base unchanged.
6. A suffix that would push the result past 63 characters is refused by `validateSlug`;
   the helper does not silently truncate a shop's chosen suffix.
7. Both helpers are pure and dependency-free, so they can be tested without a render.

- [ ] **Step 1: Write the failing tests** covering all six behaviours above, including
      the truncation-lands-on-a-hyphen case and the reserved-name case
      (`deriveSlugFromName('Admin')` produces `'admin'`, which `validateSlug` then
      refuses — the helper derives, it does not judge).
- [ ] **Step 2: Run them and watch them fail**
- [ ] **Step 3: Implement both helpers** in `storefront-slug.ts`, beside the existing
      rules rather than in a new file
- [ ] **Step 4: Run the tests — green**
- [ ] **Step 5: `npm test` and `npx tsc --noEmit`**
- [ ] **Step 6: Commit** — `git commit -m "feat(storefront): derive a web address from the shop's name"`

## Task 2: The suffix field, when the derived address is taken

**Files:**
- Modify: `src/components/storefront/editor/content-drawer.tsx`
- Modify: `src/lib/storefront-admin.ts` (read the primary location's neighbourhood)
- Test: `src/components/__tests__/storefront-content-drawer.test.tsx`

**Interfaces consumed:** `deriveSlugFromName`, `applySuffix` from Task 1.

**Properties:**

1. While the address is **unclaimed**, the field is prefilled from the shop's name and
   re-derives as the name changes — unless the shop has typed its own value, which wins
   and is never overwritten.
2. When the derived address is **taken**, the base is shown frozen and a **suffix field**
   takes focus. The shop appends; it does not start again.
3. The suffix is **prefilled from the shop's primary location** — `neighborhood` first,
   then `city`. `src/lib/storefront-admin.ts:679-680` already resolves a primary
   location for stock; resolve the same one rather than inventing a second rule.
4. **A number is never offered.** No `-2`, no counter. If there is no neighbourhood and
   no city, the suffix field is empty with a placeholder asking for the part of town.
5. Offered suffix chips are suggestions; free text overrides them.
6. The assembled address is shown in full as the shop types, built from `APP_DOMAIN`.
7. If the suffixed address is also taken, the message says so **in the same field** — it
   does not clear the base or move the shop backwards.

- [x] **Step 1: Write the failing tests** — prefill from the name; the shop's own typing
      is never overwritten by a later name change; the suffix appears only on collision;
      the neighbourhood is prefilled; no numeric suffix is ever offered; the full address
      renders as `storefrontAddress(slug)` returns it.

      > **CORRECTED 2026-08-29.** The last clause read *"renders as `<slug>.kaiibi.com`
      > and not as a path"*. This step is already done, and #108 has since rewritten the
      > tests it produced (`storefront-content-drawer.test.tsx`,
      > `storefront-address-one-form.test.tsx`) to assert the derived address instead.
      > The text above is corrected to match the code that now ships — do not "restore"
      > it.
- [x] **Step 2: Run and watch them fail**
- [x] **Step 3: Implement**, reusing the drawer's existing slug-state machine rather than
      adding a parallel one
- [x] **Step 4: Run the tests — green**
- [x] **Step 5: `npm test` and `npx tsc --noEmit`**
- [x] **Step 6: Commit**

## Task 3: A claimed address does not follow a rename

**Files:**
- Modify: `src/components/storefront/editor/content-drawer.tsx`
- Test: `src/components/__tests__/storefront-content-drawer.test.tsx`

**This is the task to be most careful with.** Everything else here is convenience; this
one prevents breaking links a shop has already printed.

**Properties:**

1. Once the address is **claimed**, renaming the shop does **not** change it — not in the
   field, not on save, not after a reload.
2. The claimed address renders read-only, showing the full address as
   `storefrontAddress(slug)` returns it, with a way to copy it. **What is shown and what
   is copied must be the same string** — #108's post-mortem is that they drifted because
   each was pinned to its own literal, so both could be wrong together. Assert they
   collapse to one value, and that the value resolves to a route file on disk, the way
   `storefront-canonical-path.test.tsx` already does. *(Corrected 2026-08-29: this line
   read `<slug>.kaiibi.com`, which does not resolve.)*
3. Changing it afterwards stays available and stays deliberate, keeping the warning the
   editor already shows.
4. After a rename, the editor **says** the address did not move and that the old links
   still work — silence here reads as a bug to a shopkeeper who expected it to follow.
5. Deriving is dead code once claimed: no code path re-derives from the name.

- [ ] **Step 1: Write the failing tests** — claim an address, rename the shop, assert the
      address is byte-identical in the field and in what would be saved; assert the
      explanatory copy appears; assert no re-derivation happens on remount.
- [ ] **Step 2: Run and watch them fail**
- [ ] **Step 3: Implement**
- [ ] **Step 4: Run the tests — green**
- [ ] **Step 5: `npm test` and `npx tsc --noEmit`**
- [ ] **Step 6: Commit**

## Task 4: Browser verification

**Not optional.** Seven defects across the storefront series shipped through a fully
green suite and were caught only here — one of them being an address rendered as a path
on this very screen.

Use `.superpowers/sdd/reseed.sh`. At **390px and 1280px**:

- [ ] A new shop's address is prefilled from its name, and claiming it works.
- [ ] Seed a second shop with the same name. Its derived address is refused, the base
      stays put, and the suffix field appears already holding the neighbourhood.
- [ ] Claim the suffixed address. **Open exactly the address the editor printed** — copy
      it, do not retype it in another form — and confirm the page loads. The property is
      that display, copy and destination are one string; it is not that the string has
      any particular shape.
- [ ] **Confirm the editor prints whatever `storefrontAddress(slug)` returns** (today
      `kaiibi.com/store/<slug>`), and that nothing on the screen assembles an address
      from a literal.

      > **CORRECTED 2026-08-29.** These two steps previously said to open
      > `<slug>.kaiibi.com` and to *confirm the address is a subdomain*. Both are now
      > inverted: the subdomain has no DNS record and does not resolve, and #108 changed
      > the editor to print the path form on purpose. A verifier following the old text
      > would have failed a working app and pushed it back to the address that breaks.
- [ ] Rename the shop. Confirm the address does not move and the explanation appears.
- [ ] Screenshot the collision state and the post-rename state; attach to the PR.

## Done when

- `npm test` and `npx tsc --noEmit` pass.
- A shop's address is its name by default, and a collision costs a suffix rather than a
  rethink.
- A renamed shop keeps its address, and is told so.
- No migration was added.

## Not in this plan

| Left out | Why |
|---|---|
| Reserving a slug before it is claimed | Stays first-come. `claim_shop_slug` already raises `slug_taken` on a lost race. |
| Redirecting an old address to a new one | Needs a history table and a resolver that fails **open** — the opposite of how `slugFromHostname` is built, and the reason it is safe. |
| Renaming addresses in bulk | Nothing asks for it. |
| Flyers | Its own branch. Same design note, different subsystem. |
