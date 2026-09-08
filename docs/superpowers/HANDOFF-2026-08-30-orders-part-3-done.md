# Handoff — Orders Part 3 is built, and the series is closed

**Written:** 2026-08-30, at the end of the session that built Parts 2 and 3.
**State:** everything below is **merged to `main` and pushed to production**.
**Plan:** [`plans/2026-08-30-orders-part-3-share-link.md`](plans/2026-08-30-orders-part-3-share-link.md)
**Part 2's own handoff:** [`HANDOFF-2026-08-30-orders-part-2-done.md`](HANDOFF-2026-08-30-orders-part-2-done.md)

| PR | What |
|---|---|
| #114 | Part 2 — `amend_order`; the shortfall stops being a dead end |
| #115 | The register guard re-asserted under a version `db push` could reach |
| #116 | Part 3 — the customer's link; two anon RPCs, the first anon **write** |
| #117 | The diagnostic that could not answer its own most important question |

Production is on `20261017000000`. The anon RPC surface there is **exactly six**,
confirmed against `pg_proc`: the original four plus `get_public_order` and
`confirm_public_order`.

---

## The decisions worth not re-litigating

**Pricing on an amend is the shop's choice, not a rule.** The Part 2 plan said
re-pricing was mandatory because `complete_sale` discards the snapshot. That stopped
being true at `20260929000000`; the plan cited the migration that change replaced.
`p_pricing` is `'agreed'` (default) or `'current'`, an unknown value is refused, and the
choice is recorded on the amendment row. **Re-pricing is a ONE-WAY DOOR** —
`order_items.unit_price_cents` is the only place an order's prices live, so a later
`'agreed'` amend keeps the re-priced figures. The sheet's copy says so.

**An amend may not ADD a product** (`order_line_not_in_order`). It is the reversible
direction, and a line with no agreed price would put two pricing regimes in one order.
Part 3's confirmation flow is where a substitution could be *agreed to* if it ever lands.

**`get_public_order` deliberately has NO module gate**, unlike all four sibling anon
RPCs. Those are the shop's marketing surface; this is a receipt for a trade that already
happened, and a customer owed goods should not lose their link because the shop's plan
lapsed. Pinned by check 17, which asserts both halves side by side — and the *write* is
still refused for a lapsed shop, because `enforce_shop_module` guards every update to
`orders`.

**The link makes no permanent-redirect promise.** There is deliberately no
`LEGACY_ORDER_SEGMENT`, and its absence is under test: an unused legacy constant is how
the next reader concludes the guarantee exists. If the segment changes, links already in
customers' WhatsApp histories 404.

**90 days on the token**, so a leaked one stops working within a season.

---

## What the mutation passes actually caught

Six tests that could not fail, none found by reading:

| Test | Why it could not fail |
|---|---|
| `itemCount` after an amend | Fixture 3/0/4 — a dropped line is 0 and adds nothing to a sum, so the `.filter(q > 0)` it "guarded" was deletable. |
| `order_not_amendable` names the status | The no-detail fallback sentence itself contains "completed or cancelled". |
| The delta panel's two totals | `$80.00` is also the order's own "Amount to collect" further up the same sheet. |
| The sheet's copy link | A hand-built `kaiibi.com/o/${token}` is the IDENTICAL string today. Needed its own file stubbing `orderAddress` to a sentinel. |
| Idempotence of `confirm_public_order` | Both calls share a transaction and `now()` is TRANSACTION time, so re-stamping writes the same value. Backdate first. |
| The stage rail's a11y label | Asserted the prop existed; `react-test-renderer` reports it on a bare `View` that neither RN nor the web ever announces. |

**And the mutation harness itself lied.** It grepped output for `FAIL n` and reported
anything else as a pass, so two mutations that died on a Postgres `ERROR` were recorded
as *stayed green*. That is exactly the trap `run-all.sh`'s header warns about: absence of
a failure marker is not evidence of success. **Check the verdict string, never the
absence of a failure.**

**A check that could not fail, from a documented trap.** `if v_payload->>'x' <> 'y'`
passes when the key is ABSENT, because `null <> 'y'` is NULL rather than true. Same
null-logic bug `20261011000000`'s header records. Every `->>` comparison in
`verify-public-order.sql` now uses `is distinct from`.

---

## Two corrections to earlier handoffs

**`tsc`'s "18 baseline errors" were an artifact.** Running the dev server generates
`.expo/types` and `expo-env.d.ts`, which supply the declarations for `global.css`, CSS
modules and RN-Web's `hovered`. In a worktree where `expo start` has never run, 18 errors
appear from nowhere. The real baseline is **0**. Do not try to "fix" those files.

**`supabase db push` reporting "up to date" is not evidence a fix is deployed.** It keys
on the version number and never re-runs a recorded one. `scripts/diagnose-production.sql`
reads `pg_proc`, and it is the only honest answer. Its check 2 was silently swallowed by
psql's pager on three production runs before #117 fixed it.

---

## Carried debt, still open

| Item | Where | Note |
|---|---|---|
| Sort state is global, not per tab | `orders.tsx` | On Done/Cancelled the header reads `WAITING ▼` over em dashes. Small. |
| `DataTable` sort-header has no test | no test file | 20 callers; invert the arrow and the suite stays green. |
| `listOrders` is unbounded | `storefront-admin.ts` | Fetches a shop's whole history, filtered client-side. **Needs a product decision** on the default range. |
| `canAccept`/`canMarkReady` unexported | `order-detail.tsx` | Three copies of the same predicates. |
| `event.stopPropagation()` untestable | `orders.tsx` | `react-test-renderer` never simulates bubbling. Device-only. |

**`transition_order` still lets any shop member CANCEL with no permission**, while
amending needs `sales.edit`. Cancelling is the more destructive move and it is the
ungated one. It wants its own PR: it moves a security boundary, and it needs a decision
about backfilling existing roles the way `20260826000100:865` backfilled
`discounts.manual`.

**Part 4 (`split_order`) is deliberately NOT built.** The spec says "genuinely optional
… hold it until a shop asks", and Part 3 ships the disabled button that tells shops it is
coming. Do not build it speculatively.

---

## Fixed along the way

The shortfall check was **~3N round trips** — about 120 for 40 open orders, on mount, on
tab switch and after every action. `checkOrdersFulfilment` answers the whole list in
**three queries whatever N is**. One trade, recorded rather than hidden: a single failure
used to cost one row's flag and now costs all of them. Failure mode is identical in kind
— flags missing, never wrong.

---

## Verified in a running app

Place → shortfall → amend → customer opens the link → agrees → shop completes, driven in
a browser against a local stack with these migrations applied. The order row was
fingerprinted (`md5` of the whole row minus the timestamp) before and after the customer
agreed: **byte-identical**. Stock, the sale and the journal all moved together and the
books balance to zero.

`gen_random_bytes` is **not** usable in this repo: pgcrypto lives in the `extensions`
schema on Supabase, so a function with `set search_path = public` cannot see it. The token
uses `gen_random_uuid` + `uuid_send`, which are core.
