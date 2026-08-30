# Handoff — Orders, Parts 2 to 4

**Written:** 2026-08-30, at the end of the session that built Part 1.
**Branch:** `orders-design`, 16 commits off `origin/main` (`7eb9e88`). **Not pushed. No PR.**
**Spec:** [`specs/2026-08-29-orders-amend-and-share-design.md`](specs/2026-08-29-orders-amend-and-share-design.md)
**Mockup:** [`../design/orders-redesign-mockup.html`](../design/orders-redesign-mockup.html) — seven tabs; the roadmap at the top says what shipped.
**Ledger:** `.superpowers/sdd/progress.md` — the detail behind everything below. Read its Orders sections before dispatching anything.

---

## Do these three first

1. **Verify the security fix reached production.** Still unconfirmed.
   ```
   psql "$PROD_DB_URL" -f scripts/diagnose-production.sql
   ```
   Check 2 is the answer. `15 | OK` means closed; `16 | EXPOSED` means any member with
   `pos.access` can still defeat a shop's `require_open_register` setting with one extra JSON
   field. `supabase db push` reported "up to date", but that compares recorded version numbers
   to filenames — and this incident is the proof those can disagree. **Read the catalog, not
   the file list.**

2. **Decide about `orders-design`.** 201 suites / 3672 tests pass, `tsc` clean, every task
   reviewed plus a whole-branch pass. It is ready for a PR. State the shortfall cost in the
   PR body (below).

3. **Tidy `yusefshop`'s storefront** if you want to: a **"QA Delivery Zone" ($3.50)** delivery
   area was created and published during Part 1's browser verification. Writing to that shop is
   explicitly sanctioned by `.claude/skills/testing-kaiibi/SKILL.md` ("exists to be written
   to"), so orders #2/#3, sale `#767e1b` and the `item2` stock decrement are all normal test
   residue. The published delivery area is the only part that is publicly visible.

---

## What shipped, and what did not

| | | State |
|---|---|---|
| **Part 0** | No till required; store pick-up visible | **Shipped** — #110, plus #112 fixing a security hole in it |
| **Part 1** | The Orders screen | **On `orders-design`, unpushed** |
| **Part 2** | `amend_order` | Not started |
| **Part 3** | The customer's link | Not started |
| **Part 4** | `split_order` | Not started, and optional |

Part 1 gave `orders.tsx` a stat strip, search, sortable headers, a Waiting column, one inline
action per row and shortfall flags; and `order-detail.tsx` a stage rail and a reconciliation
block. All arithmetic lives in `src/lib/orders-reporting.ts` — **the screen does none.**

---

## The rules that bind Parts 2–4

These were each paid for. Do not rediscover them.

### A default is not an enforcement
Part 0's first attempt gave `complete_sale` a `p_require_register boolean default true`
parameter, arguing the default left every existing caller unchanged. **That argument was the
hole.** A function granted to `authenticated` is exposed over PostgREST, so *every parameter it
declares is a field the client can send*. Reproduced on a live database with a real JWT:
`=> false` defeated the setting, and `=> null` defeated it too, because `if NULL and …` is NULL
and the guard never fires. Both were one extra JSON field.

**"Only function X may do this" is a provenance question, not a parameter.** The answer this
repo uses: a `security definer` write to a table with no grants and RLS enabled with **zero
policies**, stamped `pg_current_xact_id()`. See `storefront_order_completions`
(`20260928000500`) and `storefront_order_fulfilments` (`20261010000000`).

**This binds `amend_order`, `split_order`, `get_public_order` and `confirm_public_order`.**
It is constraint 11 in the spec.

### An amend must re-price, and say so
`complete_sale` prices every line from **today's** `products.price_cents` and ignores the
snapshot it is passed (`20260908000300:363`). So an amend that recomputes from the frozen
checkout snapshot builds an order that can never complete — it raises `order_total_changed` at
the till. Recomputing at current prices is mandatory; showing the shop the delta before saving
is what makes it honest, and the customer's link is where it gets agreed.

### Partial fulfilment is amending, not split shipments
One sale per order is enforced structurally: the trigger refuses `new.sale_id <> old.sale_id`
once set, and `storefront_order_completions` is keyed on the order with an `xact_id` guard. So
"ship 3 now, 2 Thursday" **cannot** be two sales against one order. `split_order` creates a new
linked order instead.

### The share link is derived, never written
#108 fixed exactly the defect Part 3 would otherwise recreate: two surfaces each hand-built
`<slug>.kaiibi.com`, for which **no wildcard DNS record exists**, so shops copied a link that
gave customers a DNS failure. `src/lib/storefront-host.ts` is now the single source
(`APP_DOMAIN`, `storefrontPath`, `storefrontAddress`). Part 3 adds `orderPath`/`orderAddress`
there and names the route file from the same constant.

Its test follows #108's pattern, and the reason matters: the old tests pinned each surface to
its own literal, so all of them could be wrong together. The new one asserts every surface
**collapses to one string** and that the string **resolves to a route file on disk**.

### Two reasons, and only one travels
`cancellation_reason` is written for the shop — real ones are blunt ("never showed, third
time"). An amendment reason is the same. **Neither may reach a forwarded URL.** The
customer-facing note is a separate, optional field.

### Anon writes may only ever agree
`confirm_public_order` stamps a timestamp and nothing else. "Something's wrong" writes
**nothing** — it opens WhatsApp. A link that has been forwarded, screenshotted or leaked must
never be able to cancel or alter an order.

---

## How to work in this codebase

### Seven tests that could not fail, in one 6-task plan
Every one was found by mutation, never by reading. The classes:
- `expect(x).not.toContain?.(2800)` — `toContain` on a **number**, and `?.` silently skips.
- "does not mutate" asserted against a fixture already in sorted order.
- "oldest **pending**" against a fixture whose oldest pending order was also the oldest order.
- "terminal rows get an em dash" that only asserted the *absence of a button*.
- "accepts without opening the sheet" — but the action closes the sheet on success, so the
  assertion held whether or not it ever opened.

**A fixture whose values do not DISCRIMINATE makes a test decorative.** For every assertion
ask: *what implementation change would this catch?* If "none", that is a finding to report, not
to patch over. **Run a mutation pass on every task.** A mutation that stays green is itself a
finding.

### This repo has no `@testing-library/react-native`
Zero hits in `package.json`. Component tests use `react-test-renderer` and assert on **props of
components found by type**; there is no `fireEvent` — you call the prop handler directly.

```tsx
tree.root.findByType(DataTable).props.rows.map((r: ShopOrder) => r.id)
tree.root.findAllByType(StatTile).find((n) => n.props.label === 'Needs you now')
tree.root.findByType(DataTable).props.onRowPress(ORDER)
```
Assert on props, not text: `props.rows` tells you *which orders survived a filter and in what
order*; text tells you only that a string appeared somewhere.

### Derive the newest function definition PER FUNCTION, never per file
A migration that re-creates one of two functions leaves the other's newest definition in an
earlier file. Copying from a merely-recent ancestor silently reverts a later fix, and **nothing
fails when you do it** — the only guard is `supabase/tests/accumulated-rpc-edits.test.ts`, which
is a **Jest** test, so a migration task must run `npx jest`.

Grep for **both** creation forms — a function whose return type changes must be dropped and
recreated, so `create or replace` alone misses it:
```bash
grep -n "function public.<name>" supabase/migrations/*.sql | grep -vE "grant|revoke|drop"
```

### `npm run test:db` decides pass/fail by grepping for `ALL CHECKS PASSED`
`run-all.sh:82` greps the **whole output**. A `raise notice 'FAIL …'` fails nothing, and a
verdict string in an earlier block reports success over a later red check. New checks must
`raise exception`. **Prove a new check can fail**: mutate it and confirm the *script name*
appears in the `FAILED:` list.

There is **no `seed.sql`** — the runner resets, so a check doing `select … from shops limit 1`
gets null and silently tests nothing. Every check builds its own fixture and restores what it
mutates. A `SKIP` branch that can pass having tested nothing is a defect.

### One owner per plan, claimed in the ledger before the first dispatch
Two sessions built Part 0 Task 1 in parallel from the same base commit, and one reached
production — which then made it un-fixable by `db push`, because the version was already
recorded. **Production only ever receives what is merged to main.**

### Other standing rules
- **Screens do no arithmetic.** Sums, sorts, filters and date maths live in a pure module.
- **Bento tokens only**, no hex literals, on admin screens. Storefront components are *not*
  bento — they take a `PaletteColors` prop. Read `.claude/skills/building-bento-screens/SKILL.md`.
- **Colour is never the only signal** — deuteranopia makes red/green ΔE 4.0.
- **`Caveat tone="wrong"` needs an action or a dismiss.** A fix-less one "trains people to
  ignore the whole family" — its own doc comment says so.
- **A button that fails is worse than no button.** Read the permitted-moves table.
- **PostgrestError is not `instanceof Error`** — use `src/lib/error-message.ts`.
- When a **shared component** changes, "the suite is green" is not evidence about callers with
  no prop-level tests. Probe the props. `DataTable` has 20 callers.

---

## Carried debt from Part 1

| Item | Where | Note |
|---|---|---|
| Shortfall flags cost ~3 queries per open row | `orders.tsx` effect | ~120 round trips for 40 open orders, on mount, tab switch and post-action reload. Degrades past ~20–30 open. **The batched RPC is Part 2's opportunity** — `checkOrderFulfilment` takes one order and re-resolves `primaryLocation` every call. |
| `DataTable`'s sort-header path has no test | `data-table.tsx:76-109` | Invert the arrow or hard-code the key and the suite stays green. |
| `failedRowAction` survives a tab switch | `orders.tsx:595` | "Try again" can fire at a row not on screen, and success is silent. |
| Sort state is global, not per tab | `orders.tsx:613` | On Done/Cancelled the header reads `WAITING ▼` over em dashes. |
| `disabled={busyId}` locks every row | `orders.tsx:189` | Over-broad; the real guard is inside `onPress`. |
| Row-action label re-encodes three predicates | `orders.tsx:190`, `:219` | `order-detail.tsx`'s `canAccept`/`canMarkReady`/`canComplete` are unexported. Exporting them collapses three copies. |
| `event.stopPropagation()` untestable | `orders.tsx:179` | `react-test-renderer` never simulates bubbling. Needs an on-device check. |
| No date range over orders | `listOrders` | Fetches a shop's entire history, unbounded, filtered client-side. |
| `railLabelActive` treats done and current alike | `order-detail.tsx:159` | The comment claims the label reinforces the dot; it does not. Not a defect — lightness-safe — but the comment overstates. |
| `accessibilityLabel` on a bare `View` | `order-detail.tsx:147` | Inert: no `accessible`/`accessibilityRole`, so RN skips it and web ignores it on a generic div. |

---

## Suggested PR body for Part 1

> The Orders screen was one chip row and a bare table; a shop could not tell which of seven
> orders was urgent without opening seven sheets. It now leads with what needs acting on.
>
> All arithmetic moved to `src/lib/orders-reporting.ts` — the screen computes nothing, which is
> also the only way these sums became testable.
>
> **Known limit:** shortfall flags cost ~3 queries per open row, fired as a burst on mount, tab
> switch and post-action reload. Fine for a shop with a handful of open orders; degrades past
> roughly 20–30 in one tab. The batched RPC belongs with `amend_order`.
>
> Seven tests that could not fail were found by mutation during this work and fixed, each
> re-proven by re-applying the mutation.

---

## Where to start Part 2

`docs/superpowers/specs/2026-08-29-orders-amend-and-share-design.md`, the **Part 2** section, is
the design. It has not been turned into a plan yet — write one with `superpowers:writing-plans`,
and **verify every line number and signature it cites against the live code**, because this
session's Part 0 and Part 1 plans each shipped several that had moved.

Amend is the primitive the rest leans on, and alone it turns today's dead end — a shop short on
stock can only cancel the whole order — into "reduce and complete".

Open questions the spec lists and Part 2 must answer: whether an amend may **add** a product the
customer never ordered; which permission gates an amend (note that *cancelling* currently needs
none beyond shop membership); and how a batched fulfilment check should look, since Part 1 left
that cost on the table.
