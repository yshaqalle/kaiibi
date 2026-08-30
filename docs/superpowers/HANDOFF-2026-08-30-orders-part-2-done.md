# Handoff — Orders Part 2 is built

**Written:** 2026-08-30, at the end of the session that built Part 2.
**Branch:** `worktree-orders-part2-amend`, 4 commits off `main` (`e448edb`). **Not pushed. No PR.**
**Plan:** [`plans/2026-08-30-orders-part-2-amend.md`](plans/2026-08-30-orders-part-2-amend.md)

---

## The plan's central premise was stale, and that changed the design

The plan said re-pricing every amend at today's shelf price was **mandatory**, because
`complete_sale` prices from `products.price_cents` and discards the snapshot, so an amend that
kept the agreed price would build an order that could never complete.

**That stopped being true four days before the plan was written.** It cites
`20260908000300:363` — the exact line `20260929000000_complete_sale_agreed_price.sql` was
written to change. On `main` today:

| | |
|---|---|
| `20261011000000:640` | `v_unit_price := coalesce(v_agreed_price, v_product.price_cents)` |
| `20261011000000:1362` | `complete_storefront_order` passes `'agreed_unit_price_cents', oi.unit_price_cents` |
| `20261011000000:1477` | `order_total_changed` now fires ONLY when the order row disagrees with its own lines |
| `verify-order-transitions:1958` | check 46 pins it: re-priced 700 → 1300, completes at the agreed 700 |

So both answers complete cleanly, and a hard requirement turned back into a product question.
**The shop chooses per amend** — `p_pricing` is `'agreed'` (default) or `'current'`, an unknown
value is refused rather than falling back, and the choice is written onto the amendment row as its
own column.

**Re-verify plan citations before building. This is the third plan in this series to ship stale
line numbers.**

---

## The three open questions, answered

### 1. May an amend ADD a product the customer never ordered? — **No.**

Refused with `order_line_not_in_order`. Three reasons, all in the migration header:

- "We sent you less than you ordered" and "we sent you something you never asked for" are
  different conversations, and an amend happens *without asking the customer* — there is no
  confirmation step in this part.
- It is incoherent with the pricing choice. A line the customer never ordered has no agreed price,
  so `'agreed'` would silently price it at today's shelf and one order would carry two pricing
  regimes.
- **It is the reversible direction.** Allowing adds later is additive; orders that already carry
  added lines cannot be un-added. Part 3's confirmation flow is where a substitution can be
  *agreed to*, and that is where it belongs if it lands at all.

### 2. Which permission? — **`sales.edit`**, as recommended.

Confirmed against `src/lib/permissions.ts:52-98`: there is no `orders.*` or `storefront.*`
permission, `sales.edit` is "Edit or delete a past sale", and `0020_default_roles.sql:12` already
seeds it onto Manager. Inventing `orders.amend` would need a roles migration and a settings screen,
and every existing role would start without it — every shop would find amending broken until
someone edited a role.

### 3. Should `transition_order`'s permission-free cancel be raised to match? — **Yes, but not here.**

It is genuinely the wrong way round: amending an order down to three bags now needs `sales.edit`,
while **binning it entirely still needs nothing beyond shop membership**. Cancelling is the more
destructive of the two and it is the one with no gate.

Not changed in this part because it edits a function this migration does not otherwise touch, needs
its own checks, and carries a real risk of locking a shop out of a flow it uses daily — a shop
whose staff have been cancelling orders all year would find it broken on deploy. It wants its own
migration, its own checks, and a decision about whether existing roles get the permission
backfilled the way `20260826000100:865` backfilled `discounts.manual`.

---

## What was found along the way

**Re-pricing is a one-way door.** `order_items.unit_price_cents` is the only place an order's prices
live, so `'current'` rewrites it and a *later* `'agreed'` amend keeps today's price rather than
restoring the original quote. Correct, but the sheet's copy promised otherwise; the wording is
fixed and check 20 pins the behaviour. Nothing is lost — `order_amendments.before` keeps every
earlier state.

**Three tests that could not fail**, every one found by mutation, none by reading:

| Test | Why it could not fail |
|---|---|
| `itemCount` from the amended lines | Fixture was 3/0/4 — a dropped line's quantity is 0, and 0 adds nothing to a sum, so the `.filter(q > 0)` it was "guarding" could be deleted with every test green. The filter was the decorative part; it is gone. |
| `order_not_amendable` names the status | Asserted `toMatch(/completed/i)`, but the no-detail fallback sentence itself contains "completed or cancelled". Now asserts the *remedy* each branch names. |
| The delta panel shows both totals | Asserted `toContain('$80.00')`, which is also the order's own "Amount to collect" further up the same sheet — deleting the "Was" row left it green. Now asserts on `StatementRow`'s label/amount props. |

**`amended_at` is transaction time.** `default now()` means two amends inside one transaction share
a timestamp, so `order by amended_at limit 1` is arbitrary between them. Fine in production (one
amend per transaction); it broke check 20's first draft.

---

## Verification

| | |
|---|---|
| `npm run test:db` | **45 checks pass**, zero `FAILED:` — 20 of them new in `verify-order-amendments.sql` |
| `npm test` | **3724 pass** (baseline 3672, +52) |
| `npx tsc --noEmit` | **18 errors — unchanged from baseline.** Pre-existing, in files this work never touched (`Pressable` `hovered` typing, a `global.css` side-effect import). The previous handoff's claim that Part 1 left `tsc` clean is not true of bare `npx tsc --noEmit`; there is no `typecheck` script with other flags. |
| `npm run lint` | 147 problems (64 errors, 83 warnings) — unchanged from baseline |
| Mutation passes | **13 on the RPC, 6 on the client, 9 on the sheet, 1 on check 20 — all red.** Three that stayed green were findings, listed above, and all three are fixed and re-proven. |

### The seam, verified against the real stack

`amend_order` driven over PostgREST with a real `authenticated` JWT on the local stack — the seam
every unit test mocks. Confirmed: PostgREST dispatches **by argument name**; `returns public.orders`
comes back as a single JSON object; the grant works from a real session; an amended order completes
into a sale at the amended total with **no `order_total_changed`**; and a refusal arrives as
`{code: P0001, message: 'order_not_amendable', details: {...}}` — the exact shape
`orderErrorMessage` switches on.

### NOT exercised: the UI walk

The plan asks for a device walk signed in as `yusef@gmail.com`. **It was not run**, for two reasons
that both have to be fixed first and neither of which is mine to fix unasked:

1. **Metro on `:8081` serves the main checkout, not this worktree.** Driving it would exercise code
   without any of these changes — the stale-bundle trap. A second Metro on another port would need
   a `.env`, which worktrees do not inherit.
2. **The main `.env` points at production** (`jskobdvamobyigmmslrp.supabase.co`), which does not
   have `20261012000000`. `amend_order` does not exist there, so the flow cannot run at all without
   pushing a migration to production — which this repo's own rule forbids ("production only ever
   receives what is merged to main").

**To run it:** merge to `main` and push the migration, or point a worktree Metro at the local stack
(`http://127.0.0.1:54321`) and seed a shop. What is still unproven by everything above is narrow —
the props threading through `orders.tsx` into the sheet, and the sheet's own rendering on a real
screen. Every layer either side of that is covered.

---

## Test residue

On the **local** stack only, and wiped by the next `npm run test:db`: a `QA Amend Shop` with one
product, one completed order and a user `qa-amend@example.test`. **Nothing was written to
production or to `yusefshop`.**

---

## Carried debt (unchanged from Part 1, plus one)

Part 1's list still stands — see [`HANDOFF-2026-08-30-orders-parts-2-to-4.md`](HANDOFF-2026-08-30-orders-parts-2-to-4.md). One item was
explicitly deferred again and is now more attractive:

**The batched fulfilment check.** Part 2 was named as its natural home; it was left out because the
plan is explicit that it is a separate RPC with its own test surface and its own commit. It is now
the largest remaining cost on this screen — `checkOrderFulfilment` still takes one order and
re-resolves the location every call, ~3 queries per open row, and `getCurrentPrices` adds one more
query per *opened* order (only for amendable ones, and only after the lines load).

**New:** `transition_order`'s permission-free cancel, per question 3 above.
