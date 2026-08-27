# Flyers on the Storefront

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A shop can put posters and offers at the top of its public page, and a flyer that claims an offer says what the till will actually give.

**Architecture:** One table, one boolean, and the existing public read extended rather than a fourth one added. A flyer with a promotion attached derives its offer wording from that promotion at read time; a flyer without one is a plain announcement.

**Tech Stack:** Supabase Postgres, React Native Web, Expo Router, Jest.

## Why this exists

The page has one optional hero image that only the Window layout reads, and nothing that
can carry a promotion. A shop wants the seasonal poster, "everything 20% off this week",
a photo of new stock.

**Design note:** `docs/design/storefront-address-and-flyers-mockup.html`, part two.

## The decision this plan turns on

**A flyer that claims an offer must read it from the promotion, not from a text box.**

`src/lib/poster.ts` already does this for paper, and states why:

> the point of generating this rather than asking the owner to type it is that a poster
> cannot contradict the till: if the offer says 20% and runs through Saturday, so does
> the paper on the door.

`campaigns` (`supabase/migrations/20260828000000_campaigns.sql`) carries the same nullable
`promotion_id`, and its header names the null case exactly: *"a message with no discount
behind it — new stock, a change of hours, a thank you."*

The argument is **stronger** on the web than on paper. A shop can take a poster off the
door. A page advertising a discount the till refuses does it around the clock, to
strangers, at the address printed on the shop's card.

So: an optional `promotion_id`, and the offer's words derived. The flyer **reads** a
promotion; it never applies one. The discount engine — the thing that posts to the
ledger — is untouched.

## Global Constraints

- **One upload path.** `uploadImage(path, localUri)` (`src/lib/storage.ts:26`), the same
  one logos, product photos and the hero already use. Bucket is `product-images`
  (`storage.ts:59`), already public — which is what a customer-readable flyer needs. **Do
  not add a bucket and do not add a second upload path.**
- **Extend the existing public read.** `get_public_storefront(p_slug)`
  (`supabase/migrations/20260924000100_storefront_public_read.sql:21`) is one of three
  `security definer` reads granted to `anon`. Flyers must travel on that call. A separate
  RPC would let an unpublished shop, an unknown slug and a failed read be told apart by
  timing or by which call errors — the anti-enumeration property plan 1 built.
- **`security definer` functions must `revoke execute … from public` BEFORE granting.**
  Postgres grants EXECUTE to PUBLIC by default, so `grant` alone is a no-op. Convention:
  `20260924000100_storefront_public_read.sql:103-109`.
- **Migrations are `YYYYMMDDHHMMSS_name.sql`. This plan uses the `20261006*` series.**
  Before committing run `ls supabase/migrations | sed 's/_.*//' | sort | uniq -d` and
  confirm it is empty — a previous plan lost a task to a timestamp another branch took.
- **DB tests:** `npm run test:db` (`-- --no-reset` while iterating). The local stack is
  SHARED with other sessions and is reset often; reset from THIS worktree before trusting
  a result. If `supabase db reset` fails on accumulated Docker state, `docker rm -f` plus
  `docker volume rm` on the kaiibi containers clears it.
- **Unit tests:** `npm test`. **Typecheck:** `npx tsc --noEmit` — run the dev server once
  first so `.expo/types/router.d.ts` exists, or you will chase phantom errors.
- Bento tokens on admin screens, no hex literals. The public themes use the shop's own
  palette, not bento.

---

## Task 1: The table

**Files:** Create `supabase/migrations/20261006000000_storefront_flyers.sql`;
create `supabase/tests/verify-storefront-flyers.sql`

**Properties:**

1. `storefront_flyers`: `id`, `shop_id` (→ `storefronts.shop_id`, `on delete cascade`),
   `image_path text not null`, `headline text`, `subline text`, `link_kind text` checked
   against `('none','category','whatsapp')`, `link_value text`, `position integer not
   null`, `draft boolean not null default true`, `promotion_id uuid references
   public.promotions(id) on delete set null`, `created_at`.
2. **`on delete set null` on the promotion, not cascade** — deleting an offer must not
   delete the flyer that mentioned it. Same rule `campaigns` states for the same reason.
3. **At most five per shop**, enforced in the database, not only in the UI.
4. RLS on. Shop members read and write their own shop's rows; `anon` gets **no table
   grant at all** — the public read is a `security definer` function, as with every other
   storefront read.
5. A flyer belongs to a shop that has a storefront. A shop without one cannot hold flyers.

- [ ] **Step 1: Write the checks first** — the cascade from `storefronts`, the
      `set null` from `promotions`, the five-per-shop limit refusing a sixth, the
      `link_kind` check refusing an unknown value, and `anon` being refused a direct
      select. Follow `supabase/tests/verify-storefront.sql` for shape: build a fixture,
      assert, then RAISE so the block rolls back, and emit `ALL CHECKS PASSED` — the
      runner greps for that exact phrase and reports FAIL without it.
- [ ] **Step 2: Run them and watch them fail**
- [ ] **Step 3: Write the migration**
- [ ] **Step 4: `npm run test:db`**
- [ ] **Step 5: Confirm no timestamp collision**
- [ ] **Step 6: Commit**

## Task 2: The public read carries flyers, and derives the offer

**Files:** Create `supabase/migrations/20261006000100_public_storefront_flyers.sql`;
extend `supabase/tests/verify-storefront-flyers.sql`

**Properties:**

1. `get_public_storefront(p_slug)` returns the shop's **live** flyers — `draft = false` —
   in `position` order, as part of its existing result. No new RPC.
2. **A flyer with a `promotion_id` carries derived offer text**: the value and the window,
   computed from the promotion row, never from a stored copy. Match what
   `src/lib/poster.ts` produces for the same promotion so one offer cannot read two ways.
3. **A flyer whose promotion has expired, or been deleted, stops claiming an offer.** It
   either drops out or renders as a plain announcement — decide which, state why in the
   migration header, and pin it. This is the property the whole design rests on.
4. A draft flyer is invisible publicly. So is every flyer of an unpublished shop.
5. **The anti-enumeration property still holds**: an unpublished shop, an unknown slug and
   a shop with no flyers must remain indistinguishable to an anonymous caller.
6. `anon` may execute the function and still has no table grant.

- [ ] **Step 1: Write the failing checks**, including an expired promotion and a deleted
      one, and a draft flyer staying invisible
- [ ] **Step 2: Run and watch them fail**
- [ ] **Step 3: Write the migration**, reproducing the function in full per repo
      convention
- [ ] **Step 4: Prove the grant red-then-green** — revoke execute from `anon`, confirm
      RED, restore, confirm GREEN
- [ ] **Step 5: `npm run test:db`**
- [ ] **Step 6: Commit**

## Task 3: The themes render them

**Files:** Modify `src/components/storefront/theme-market.tsx`,
`theme-window.tsx`, `theme-shared.tsx`; create
`src/components/storefront/flyer-carousel.tsx`; test in
`src/components/__tests__/`

**Properties:**

1. **Zero flyers renders nothing at all** — no empty frame, no placeholder facing a
   customer. The photo-optional rule every theme already follows.
2. **One flyer renders static**: no dots, no arrows, no auto-advance. A carousel of one
   with controls nobody can use lies about what is there.
3. Two or more render a carousel with dots, arrows and swipe.
4. **Counter renders none.** It is a price list built to make a 200-line catalogue
   readable and a poster fights that. Market and Window show them.
5. The band sits **below the shop's name and blurb, above the goods** — a customer
   arriving on a forwarded link needs to know whose page this is before the loudest thing
   on it speaks, and the poster belongs next to what it points at.
6. A slide with `link_kind = 'category'` filters the page; `'whatsapp'` opens an enquiry
   about that offer; `'none'` is not interactive at all — and must not look it.
7. Each slide is a real link or button, reachable by keyboard and screen reader in order.

- [ ] **Step 1: Write the failing tests** — none renders nothing; one renders without
      controls; Counter renders none even when flyers exist; the band's position relative
      to the blurb and the grid
- [ ] **Step 2: Run and watch them fail**
- [ ] **Step 3: Implement**
- [ ] **Step 4: `npm test` and `npx tsc --noEmit`**
- [ ] **Step 5: Commit**

## Task 4: Motion

**Files:** Modify `src/components/storefront/flyer-carousel.tsx`; add
`auto_advance` in `supabase/migrations/20261006000200_storefront_auto_advance.sql`;
tests

**Properties:**

1. `storefronts.auto_advance boolean not null default false`. **Off unless the shop asks.**
2. **`prefers-reduced-motion` wins over the shop's setting, in both directions.** The
   customer's device preference is not advisory.
3. It stops on hover, on touch and on keyboard focus, and **does not resume for that
   visit**. A carousel that moves while somebody is reading is worse than a static image.
4. Dots, arrows and swipe work whether or not it auto-advances.
5. A single flyer never advances regardless of the setting — there is nowhere to go.

- [ ] **Step 1: Write the failing tests**, including reduced-motion beating
      `auto_advance = true`, and that stopping is permanent for the visit
- [ ] **Step 2: Run and watch them fail**
- [ ] **Step 3: Implement**
- [ ] **Step 4: `npm test`, `npm run test:db`, `npx tsc --noEmit`**
- [ ] **Step 5: Commit**

## Task 5: The editor

**Files:** Modify `src/components/storefront/editor/content-drawer.tsx` or add a
sibling panel; `src/lib/storefront-admin.ts`; tests

**Properties:**

1. Add, reorder by dragging, edit and remove a flyer. At most five, and the UI says so.
2. Upload through the existing `uploadImage`.
3. Draft and live, using the `draft` column the editor already understands.
4. **Attaching an offer picks from the shop's running promotions** — it is not free text.
   The headline stays free text, because "Ciid wanaagsan" is not derivable from a discount
   row. Leave the offer empty for an announcement.
5. **When the shop's layout is Counter, the panel says flyers will not show** and why,
   rather than letting a shop build something invisible.
6. A shop without the promotions module can still add announcement flyers; only the offer
   picker is unavailable, and it says so rather than appearing broken.

- [ ] **Step 1: Write the failing tests**
- [ ] **Step 2: Run and watch them fail**
- [ ] **Step 3: Implement**
- [ ] **Step 4: `npm test` and `npx tsc --noEmit`**
- [ ] **Step 5: Commit**

## Task 6: Browser verification

**Not optional.** Six defects across the storefront series shipped through a fully green
suite and were caught only here — the most recent being a drawer rendering two
contradictory states at once, which every unit test missed because each asserted one
state alone.

Use `.superpowers/sdd/reseed.sh`. At **390px and 1280px**:

- [ ] Add two flyers, one with an offer attached and one without. Publish.
- [ ] The public page shows them under the shop's name and above the goods, in order.
- [ ] The offer flyer's words match what the till would actually give.
- [ ] **Expire that promotion in the database and reload.** The page stops claiming the
      discount. This is the property the design rests on.
- [ ] Delete all flyers — the page renders no empty frame.
- [ ] One flyer — no dots, no arrows.
- [ ] Switch the shop to Counter — no flyers render, and the editor says why.
- [ ] Tap a slide with a category link and land on the filtered goods.
- [ ] Screenshot the carousel, the single-flyer case and the Counter case; attach to the PR.

## Done when

- `npm test`, `npm run test:db` and `npx tsc --noEmit` pass.
- A shop can run a week's promotion on its page without typing a price.
- An expired offer stops being advertised on its own.
- A page with no flyers looks exactly as it does today.

## Not in this plan

| Left out | Why |
|---|---|
| Scheduling a flyer to appear on a date | Worth wanting, much bigger. Draft plus a tap runs a week's promotion today. |
| Applying a discount from a flyer | A flyer READS a promotion so its words cannot contradict the till. It never applies one — that is the engine's job, and the engine posts to the ledger. |
| Video flyers | Autoplaying video on a metered connection in Hargeisa is a cost the shop's customer pays. |
| Flyers on Counter | Deliberate. See Task 3. |
