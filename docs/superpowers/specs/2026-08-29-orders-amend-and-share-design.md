# Orders: amending, filling part of one, and a link the customer can open — design

**Date:** 2026-08-29 · against `main` at `5c9b736`
**Mockup:** [`docs/design/orders-redesign-mockup.html`](../../design/orders-redesign-mockup.html)

## The problem

The Orders screen works and the state machine behind it is airtight. Two things are wrong with it.

**It reads as unfinished.** It is a chip row and one bare table. The tab it is measured against —
Accounting → Transactions — has a stat strip, search, sortable headers, row actions and export. A
shop cannot tell which of seven orders is the urgent one without opening seven sheets.

**A shop that is short on stock has exactly one move: cancel the whole order.**
`checkOrderFulfilment` already tells the shop an order is unfillable, and then offers nothing but
cancellation. There is no way to reduce an order to what is actually on the shelf, no way to change
a quantity a customer has had second thoughts about, and no way to correct a mistyped phone number
or a landmark the driver cannot find. This is not a missing screen — it is a missing capability:
`authenticated` has **no write privilege at all** on `orders` or `order_items`.

And there is no channel back to the customer. `place_storefront_order` deliberately returns no order
id, and no anon RPC reads an order back, so once an order is placed the customer is blind to it.
Every "where is my order?" is a phone call.

Two more defects surfaced while specifying the above, and both block the journey before any of it
matters. **A shop with `require_open_register` set on its primary location cannot complete a single
storefront order** — the RPC always passes a null session and there is no way to supply one. And
**store pick-up is invisible to the customer exactly when it is the only option**: a shop that does
not offer delivery renders no fulfilment choice at all, so the order is placed as a collection the
customer was never told about, to an address they are never given. These are Part 0.

## What already exists, and is reused unchanged

| Thing | Where | Reused for |
|---|---|---|
| The five-word status vocabulary and its permitted-moves table | `enforce_order_transition`, `20260928000100_order_transitions.sql` | Untouched. The stage rail renders it; nothing here adds a sixth word |
| `transition_order` | same | Accept / mark ready / cancel, including from the new inline row buttons |
| `complete_storefront_order` | `20260928000200`, reproduced whole in `20260928000500` | Completion. Not modified |
| One-sale-one-order provenance | `storefront_order_completions`, `20260928000500` | Preserved. It is the reason split creates a *new order* rather than a second sale |
| `cancellation_reason` required, trimmed, enforced twice (trigger + CHECK) | `20260928000100` | The exact pattern the amendment reason copies |
| Line snapshot frozen at checkout | `order_items.product_name / unit_price_cents / quantity / line_total_cents` | What an amend rewrites, and what the customer's diff is computed against |
| `checkOrderFulfilment` / `findShortfalls` | `src/lib/order-fulfilment.ts` | Row-level shortfall flags; the trigger for the three-way choice |
| `ORDER_STATUS_BADGE` | `src/components/orders/order-detail.tsx` | One label and tone per status, shared by list and sheet. Stage rail reads it too |
| `ORDERS_NEEDING_ACTION` | `src/lib/order-status.ts` | The "open orders" set the stat strip sums over |
| `buildOrderMessage` / `placeOrderViaWhatsApp` | `src/lib/storefront-order.ts` | Sending the share link down the channel the order arrived on |
| `DataTable`, `BentoCard`, `StatTile`, `Caveat`, `StatementRow` | `src/components/ui/` | The whole redesign. No new primitives |
| `ExportMenu` | `src/components/export-menu.tsx` | Orders CSV, same component Transactions uses |
| SPA rewrite of every path | `vercel.json` | `/o/[token]` needs no hosting config |
| The anon storefront family and its argued grant headers | `20260924000100`, `20260927000000` | The template `get_public_order` must match |

## The constraints that shape everything below

These are facts read off the migrations, not assumptions. Each one closes off a design that would
otherwise look reasonable.

1. **`authenticated` cannot write `orders` or `order_items`.**
   `20260928000300_orders_write_lockdown.sql:100` revokes `insert, update, delete` on both. Every
   change goes through a `security definer` RPC. No part of amending is a client-only change.

2. **`complete_sale` prices from *today's* `products.price_cents` and ignores the snapshot it is
   passed.** `20260908000300_sale_entry_date.sql:363` computes `v_line := v_product.price_cents *
   v_qty - v_line_discount`. `complete_storefront_order` passes `order_items.unit_price_cents`
   anyway, and pays `v_order.subtotal_cents`; when those disagree it raises `order_total_changed`.
   **Consequence: an amend that recomputes the total from the frozen snapshot builds an order that
   can never be completed.** Recomputing at current prices is mandatory, not a preference.

3. **Completion is all-or-nothing.** `complete_storefront_order` aggregates *every* `order_items`
   row into one `complete_sale` call. Short stock raises `insufficient_stock` and the whole
   transaction fails.

4. **One sale per order, enforced structurally.** The trigger refuses `new.sale_id <> old.sale_id`
   once set, and `storefront_order_completions` is keyed on the order with an `xact_id` guard.
   **Consequence: "ship some now, the rest Thursday" cannot be two sales against one order.**

5. **Order numbers are sequential per shop.** `assign_order_number`. `#1042` proves `#1041` exists,
   so no public URL may be keyed on the number.

6. **The anon RPC surface is exactly four functions, deliberately.** `71d0dcd` narrowed it from 74.
   The survivors are `get_public_storefront`, `get_public_storefront_products`,
   `get_public_delivery_areas`, `place_storefront_order`.

7. **The delivery fee never reaches the sale.** It is posted separately to `4300 Delivery Income`.
   A $47.50 delivered order appears in Transactions as a $44.50 row, and nothing on screen says why.

8. **The shop↔customer channel is WhatsApp**, outside the app entirely.

9. **`require_open_register` blocks storefront completion outright.**
   `complete_sale` raises `this store requires an open register before a sale can be rung up` when
   the session is null and `shop_locations.require_open_register` is set for the resolved location
   (`20260908000300:225`). `complete_storefront_order` always passes null, and `orders` carries no
   location, so every storefront sale resolves to the shop's **primary** location. A shop with that
   setting on cannot complete any online order at all. The limitation was known and documented
   (`20260928000200:28`) and is being reversed here — see Part 0.

10. **The customer is never told where to collect from.** `order-placed.tsx` says the shop "will
    call you when your order is ready to collect" and gives no address. The shop's address never
    reaches the customer on a collect order.

11. **A default is not an enforcement.** *Learned the hard way in Part 0, and it binds every RPC
    below.* Part 0's first draft gave `complete_sale` a `p_require_register boolean default true`
    parameter, on the argument that the default left every existing caller unchanged. That was the
    mistake. A function granted to `authenticated` is exposed over PostgREST, so **every parameter
    it declares is a field the client can put in a JSON body** — `p_require_register => false`
    defeated the setting, and `=> null` also defeated it, because `if NULL and …` is NULL and the
    `if` never fires. Both were one extra JSON field, reproduced against the live database with a
    real JWT.

    A default decides what happens when the client says *nothing*. It decides nothing about what
    happens when the client *speaks*. Where the property wanted is "only function X may do this,"
    that is a **provenance** question, not a parameter — answered by a `security definer` write to
    a table with no grants, stamped `pg_current_xact_id()`, as `storefront_order_completions`
    (`20260928000500`) and now `storefront_order_fulfilments` (`20261010000000`) both do.

    **This binds `amend_order`, `split_order`, `get_public_order` and `confirm_public_order`
    below.** Any flag on any of them that decides who may do what is settable by whoever calls it.

---

## The through-line

> A shop cannot fill an order in full, so it amends it down, sends the customer a link showing
> exactly what changed, settles the rest on WhatsApp, and carries on.

Everything below serves that sentence. It is also why the three asks — edit an order, fill part of
one, share a link — are one feature: **partial fulfilment is amending, and the link is what makes
amending safe.**

---

## Part 0 — fulfilment must not require a register, and pick-up must be visible

Two independent defects, both found while specifying the above, both blocking the same journey.
Neither depends on any other part; both should ship first.

### 0a · A storefront order never requires an open register

An order is collected at a counter, handed over at a door, or delivered across town. A register
session is a **drawer reconciliation** device — it exists so the cash in one physical till can be
counted against what was rung into it. A driver collecting cash in Koodbuur has no drawer, so
requiring one protects nothing and simply refuses the sale.

`complete_sale` gains `p_require_register boolean default true`. The default leaves **every existing
caller unchanged** — the POS keeps its guard exactly as it is. `complete_storefront_order` is the
single caller passing `false`, with a header saying why.

**Attach a session when there genuinely is one.** Before completing, resolve the completing member's
open session at the resolved location; pass it if found, null otherwise. An order handed over at the
counter by someone with a drawer open then reconciles into that drawer correctly, and an order that
went out on a motorbike does not. This is strictly better than always passing null, which is what
happens today.

The raw message must also stop reaching the phone: it is a bare `raise exception` with no error
code, so `orderErrorMessage` does not recognise it and `extractErrorMessage` shows it verbatim —
a shopkeeper reading about a "till" for an order going out on a bike.

**Logged, not fixed here:** `orders` has no location, so every storefront sale — and its stock
movement and its per-location P&L — lands on the shop's primary branch. A multi-branch shop
collecting from branch B records it against branch A. `checkOrderFulfilment` resolves the same
default, so the two at least agree with each other. Fixing it means a location on `orders`, chosen
at checkout, and it is its own piece of work.

### 0b · Pick-up is invisible exactly when it is the only option

In `checkout-form.tsx`, `canDeliver = offersDelivery && areas.length > 0`, and the **whole**
fulfilment block — the "How will you get your order?" heading and *both* buttons — is inside
`{canDeliver ? … : null}`. A shop with delivery off, or on with nothing priced, shows the customer
no choice at all: `fulfilment` stays at its default `'collect'` and the order is placed as a pick-up
the customer was never told about.

Always render the choice. Omit "Deliver" (never disable it — the existing Property 4 reasoning that
a dead option claims delivery exists is right) so a collect-only shop still reads **"Collect from the
store"** and shows the address. Rename the option to **Store pick-up**: "Collect" alone does not read
as a place you go.

And carry the address through — `order-placed.tsx` and `get_public_order` both return the shop's
address for a collect order. Constraint 10 is otherwise unfixed by everything else in this spec: the
customer's link would show a beautiful stage rail saying "Ready" and still not say where to go.

---

## Part 1 — the screen redesign

No migration. Ships alone and is worth shipping alone.

`src/app/(admin)/orders.tsx` gains, in bento tokens throughout:

- **A stat strip** (`BentoCard` + four `StatTile variant="bento"`): *Needs you now* (count of
  `pending`, with the oldest one's age), *Promised* (sum over `ORDERS_NEEDING_ACTION`), *Ready to
  hand over*, *Converted · <range>*. The existing `context` Caveat sits beneath it unchanged — it is
  the sharpest sentence on the screen and its claim ("not money the shop has taken") is exactly what
  keeps the *Promised* tile honest.
- **Search** over order number, customer name, phone and delivery landmark.
- **Sortable headers** — order, customer, total, waiting.
- **A `Waiting` column.** Orders' own column, with no equivalent in Transactions because a sale is
  instantaneous. Derived from `createdAt`, amber past a threshold, digits always present so colour
  is never the only signal.
- **An inline next-action button** — the one legal move, read from the same `canAccept` /
  `canMarkReady` / `canComplete` guards `order-detail.tsx` already derives from the permitted-moves
  table. Terminal rows get an em dash, never a disabled button. **Cancel is never inline** — it
  requires a typed reason.
- **Row-level shortfall flags** — `checkOrderFulfilment` for the visible open rows, batched.
- **The delivery split on the row** — `incl. $3.00 delivery`, and on a completed order the sale
  figure it became. This is constraint 7 answered where the confusion happens.
- **`ExportMenu`**, and a date range that scopes **`Done` and `Cancelled` only** — open orders always
  show in full, because an open order outside the window is still open.

`src/components/orders/order-detail.tsx` gains:

- **A stage rail** — Placed → Accepted → Ready → Done, current step marked. `cancelled` renders as a
  red terminal step replacing whatever was next: an off-ramp, not a stop on the road.
- **A reconciliation block on completed orders** — names the sale the order became and the account
  the delivery fee went to. Closes constraints 7 and the missing `sales.order_id` together.

### Not copied from Transactions

`transactions-tab.tsx` hand-rolls its table: `#F2F2F2` search, `#ECECEC` row borders,
`borderRadius: 14`, `#111111` buttons. Those are four of the red flags in
`.claude/skills/building-bento-screens/SKILL.md`. Orders already uses `DataTable` and `BentoCard`
correctly. It takes Transactions' **density**, not its markup. Transactions is the screen that
should eventually move the other way; that is out of scope here.

---

## Part 2 — `amend_order`

The primitive. Everything else is built on it.

### Schema

```
alter table public.orders
  add column amended_at              timestamptz,
  add column customer_note           text,      -- written to be read by the customer
  add column customer_confirmed_at   timestamptz;

create table public.order_amendments (
  id           uuid primary key default gen_random_uuid(),
  order_id     uuid not null references public.orders(id) on delete cascade,
  amended_at   timestamptz not null default now(),
  amended_by   uuid not null,          -- auth.uid()
  reason       text not null,          -- INTERNAL. Never leaves the shop.
  customer_note text,                  -- optional, and the only prose the link shows
  before       jsonb not null,         -- lines + totals as they stood
  after        jsonb not null
);
```

`order_amendments` doubles as the shop's audit trail and the customer's diff, so it is not overhead —
the diff on the public page is rendered from `before`/`after`, not recomputed.

`customer_note` appears on both tables on purpose, and they are not the same value.
`orders.customer_note` is the *current* message the link displays; `order_amendments.customer_note`
is what was said at each amendment, kept because a shop that amends twice needs to know which
sentence the customer actually saw. `orders.customer_note` is always a copy of the most recent
amendment's, written by the same RPC call.

`reason` is `not null` and trimmed, enforced by the RPC **and** a table CHECK, mirroring
`orders_cancellation_reason_required`. Same justification, in the migration's own words: the shop
will be asked what happened on the phone weeks later.

### The function

```
amend_order(
  p_order_id      uuid,
  p_lines         jsonb,   -- [{product_id, quantity}] — the order as it should now stand
  p_reason        text,    -- required, internal
  p_customer_note text,    -- optional, customer-facing
  p_fulfilment    jsonb,   -- optional {fulfilment, delivery_area, delivery_landmark}
  p_contact       jsonb    -- optional {customer_name, customer_phone}
) returns public.orders
```

`security definer`, `set search_path = public`. Checks `is_shop_member` and
`shop_has_module(..., 'storefront')` explicitly — RLS does not protect a security-definer function,
the same posture `transition_order` already takes.

**Allowed at `pending` and `accepted`.** At `ready` the RPC succeeds but the sheet asks first
("this order is already packed — re-pick it?"). At `completed` and `cancelled` it raises
`order_not_amendable`: a completed order is a sale, and sales have their own edit path
(`edit_sale`) with its own audit trail.

**Re-pricing is mandatory** (constraint 2). Each line is re-read from `products.price_cents`,
`line_total_cents` recomputed, `subtotal_cents` re-summed, `total_cents = subtotal + delivery_fee`.
The RPC returns the before/after so the sheet can show the delta *before* the shop commits — that is
what converts a silent re-price into a sentence the shop can say on the phone.

**Deleted products.** A line whose `product_id` is null (product deleted since checkout) cannot be
re-priced. `amend_order` may only *remove* such a line, never keep or re-quantity it — the same
treatment `complete_storefront_order` already gives it via `order_product_deleted`.

**Delivery fee.** Changing `fulfilment` from `deliver` to `collect` must zero
`delivery_fee_cents`, or `orders_delivery_matches_fulfilment` rejects the row. Changing area
re-reads the fee from the shop's delivery areas.

**Empty is refused.** `p_lines` reducing to zero raises `order_has_no_items` rather than creating an
order that `complete_storefront_order` would reject later. Cancelling is the move for that, and it
requires a reason.

**No stock consequence.** Orders never reserved stock — it decrements at `complete_sale` — so
amending lines has no inventory effect at all. This is what makes the whole feature cheap.

### The screen

`order-detail.tsx` gains an amend mode: per-line quantity steppers, a remove affordance, an
add-a-product row, the two reason fields clearly separated, and the delta panel. The shortfall
summary — today a dead end reading *"source more stock, or cancel it below"* — becomes three named
buttons: **Reduce to what I have**, **Split the order**, **Cancel order**. A single "partial
fulfilment" action with a keep-the-rest toggle is a thing people get wrong at speed; two buttons
that each state their outcome cannot be.

---

## Part 3 — the share link

### Schema

```
alter table public.orders
  add column share_token   text unique,
  add column share_expires_at timestamptz;
```

Minted by `place_storefront_order`, which starts returning it. That function's own header explains
it returns no order id because "the caller has no privilege that would let them do anything with
one" — a token is the inverse of a bare id: it *carries* its own privilege. This extends that
reasoning rather than reversing it.

### The URL is derived, never assembled

**Added 2026-08-29 after #108 (`9f23ae9`) landed on main.** That PR fixed exactly the defect this
part would otherwise have recreated: two surfaces each hand-built `<slug>.kaiibi.com`, no wildcard
DNS record was ever created for it, and shops were copying an address that returned a DNS failure
while `kaiibi.com/store/<slug>` — which works — was shown nowhere. The fix made
`src/lib/storefront-host.ts` the single source: `APP_DOMAIN`, `storefrontPath(slug)`,
`storefrontAddress(slug)`, `STOREFRONT_ADDRESS_PREFIX`.

So the order link is **not** written as `kaiibi.com/o/<token>` anywhere. `storefront-host.ts` gains
a sibling pair — `orderPath(token)` and `orderAddress(token)` — built from the same `APP_DOMAIN`
and an `ORDER_SEGMENT` constant, and every surface that shows, copies or sends the link calls
them. The route file is named from `ORDER_SEGMENT` too, so the address and the thing that serves
it cannot drift.

The test follows #108's pattern rather than inventing one, because that PR's own post-mortem names
why the bug shipped: the old tests pinned each surface to a literal constant, so all of them could
be wrong together. The new test collects what each surface shows, copies and sends, asserts they
**collapse to one string**, and asserts that string **resolves to a route file on disk**.

Which form is canonical — path or subdomain — is not settled here. That is options A/B/C in
[`docs/backlog/2026-08-27-storefront-wildcard-dns.md`](../../backlog/2026-08-27-storefront-wildcard-dns.md),
deferred on purpose. Deriving from `APP_DOMAIN` is what makes settling it later a one-file change
instead of a hunt.

The token is 128 bits of `gen_random_bytes`, base32-encoded to 26 URL-safe characters with no
mixed case — it gets read aloud over a phone and typed by hand. Generated in a retry loop against
the unique index. **Never the order number, and never the order id** (constraint 5).

### `get_public_order(p_token text)` — the fifth anon RPC

This is a deliberate addition to a surface that was deliberately narrowed, and the migration must
carry the same argued header the other four do. It belongs to the same family — the public
storefront — and it is a *read* keyed on a capability the shop chose to hand out.

Returns only: shop name, order number, status, placed-at, the lines (name, quantity, line total),
subtotal, delivery fee, total, fulfilment, `customer_note`, the latest amendment's `before`/`after`
diff, and **the address the customer needs** — the delivery landmark they gave for a deliver order,
or the shop's own address for a collect one (constraint 10). A rail that says "Ready" without saying
where to go is the same failure the current confirmation screen already has.

Returns **never**: cost prices, stock levels, shortfall counts (*"only 3 left"* is competitive
information), the internal amendment `reason`, `cancellation_reason`, any internal id, the sale id.

An expired or unknown token returns the **same** "not found" — the RPC must not distinguish them.

### `confirm_public_order(p_token text)` — an anon *write*

Stamps `customer_confirmed_at` and nothing else. Idempotent. It cannot alter a line, a total, a
status, or cancel anything.

This asymmetry is the security argument for the whole feature: **a link that has been forwarded,
screenshotted or leaked must never be able to harm an order.** The only anon write is one that
agrees with what the shop itself proposed. "Something's wrong" writes nothing at all — it opens
WhatsApp to the shop. The destructive path stays in the human channel, which is where it already
lives.

### The page — the route named by `ORDER_SEGMENT`

No login. `vercel.json` already rewrites every path to the SPA, so no hosting change.
`app.json` has scheme `kaiibi` but no `associatedDomains`, so the link opens the **web** page rather
than deep-linking into an app the customer has never installed — which is what we want.

Note the precedent from `src/app/s/[slug].tsx`: the *old* storefront address was kept as a redirect
rather than deleted, because "a link like that is out of our hands the moment it is sent." An order
link is sent to a customer over WhatsApp and lives in their chat history forever. Whatever the
route is called on day one, it can be moved but never removed.

Two shapes:

- **Amended** — the stage rail, the customer note, a diff of what changed, the new total, and two
  buttons: *Yes, that's fine* (writes) and *Something's wrong — message the shop* (doesn't).
- **Ordinary** — the stage rail with the current step lit, the lines, the total, and a WhatsApp
  button. This is the case that will be opened most, and it is what kills the "where is my order?"
  call.

### On the shop's side

`amended_at` without a later `customer_confirmed_at` renders as an **"Awaiting customer"** chip
beside the stage.

**A flag, not a sixth status.** A new word in the vocabulary would mean touching the `status` CHECK,
the permitted-moves table in the trigger, `ORDERS_NEEDING_ACTION`, the tabs and `ORDER_STATUS_BADGE`
— for something orthogonal to where the order actually is. An order can be awaiting confirmation
*at* pending, accepted or ready.

**It warns, it does not block.** "Mark ready" stays live on an unconfirmed order — it is just no
longer the filled button. A shop that phoned and got a verbal yes must not be locked out because the
customer never tapped anything; blocking only teaches people to route around the feature. This is
the same posture the sheet already takes with `blockedOnPosAccess`: say why, don't silently fail.

---

## Part 4 — `split_order` (optional)

`split_order(p_order_id uuid, p_lines jsonb, p_reason text)`: the quantity being deferred moves into
a **new** order in `pending`, carrying `split_from_order_id`. Both complete independently, each as
its own sale.

This is how "send 3 now, 2 Thursday" is expressed without breaking constraint 4. The alternative —
one order, many sales via an `order_fulfilments` table — is more general in the abstract and
dismantles an invariant `20260928000500` was written specifically to establish. Not worth it.

Genuinely optional. "Tell the customer to reorder" is a workable answer in a small shop, and
splitting adds order-number sprawl. Hold it until a shop asks.

---

## Decisions, and why

| Decision | Alternative rejected | Why |
|---|---|---|
| Partial fulfilment = amend down, not split shipments | `order_fulfilments`, many sales per order | Dismantles the one-sale-one-order invariant that `20260928000500` exists to enforce |
| Amend re-prices at current prices | Keep the checkout snapshot | Constraint 2 — a snapshot-priced amend builds an order that can never complete |
| The delta is shown before saving | Re-price silently | The customer agreed to a number; changing it silently is a betrayal the link then publishes |
| "Awaiting customer" is a flag | A sixth status | Orthogonal to stage; a sixth word touches the CHECK, the trigger, the badge map, the tabs and the needing-action set |
| Unconfirmed warns, never blocks | Gate `transition_order` on confirmation | A verbal yes is a real yes; blocking trains workarounds |
| Two reason fields | One shared reason | Real internal reasons are blunt ("never showed, third time") and a share link would publish them |
| Confirm writes, reject doesn't | Let the customer cancel from the link | A forwarded link must not be able to harm an order |
| Three named buttons on a shortfall | One action + keep/drop toggle | A toggle is what people get wrong at speed |
| Redesign ships first, alone | One big change | Part 1 needs no migration and is independently valuable |
| Storefront completion never requires a register | Keep the guard; tell shops to open one | A register session reconciles one physical drawer; an order handed over at a door or delivered has no drawer to reconcile against |
| `p_require_register` defaults `true` | Drop the guard for everyone | The POS guard is correct at a counter. Only the storefront caller opts out, and it says why |
| Attach the completer's session when one is open | Always pass null | A counter handover *is* a drawer transaction and should reconcile into it |
| "Deliver" is omitted when unavailable, never disabled | Disable it | The existing Property 4 reasoning: a dead option claims delivery exists when it does not |

## What this deliberately does not do

- **Does not broker the agreement.** The app records what the shop proposed, shows the customer
  exactly that, and notes whether they said yes. The negotiation stays on WhatsApp.
- **Does not touch the state machine.** No new status, no new transition, no change to
  `enforce_order_transition` or `complete_storefront_order`.
- **Does not add `sales.order_id`.** The reconciliation block reads `orders.sale_id`, the existing
  one-way link. A reverse link would be a second thing to keep true.
- **Does not restyle Transactions**, even though it is the screen off-system.
- **Does not make a completed order editable.** That is `edit_sale`'s job and it already exists.

## Open questions

1. **The staleness threshold.** What counts as waiting "too long", and should collect differ from
   deliver? Drawn as 3h; it is a guess.
2. **Rail timestamps.** `orders` stores no per-transition history, so honest per-step times need new
   columns and a trigger. The cheap version is sequence with no clock. Which ships first?
3. **May an amend add a product the customer never ordered?** Drawn as allowed. "We substituted
   something" is a materially different conversation from "we sent you less", and it may deserve to
   be refused outright rather than left to a shop's judgement.
4. **Share link lifetime** after an order reaches a terminal state.
5. **Which permission gates an amend?** Today `transition_order` checks only `is_shop_member` plus
   the module gate — so *cancelling* an order needs no permission at all. Amending changes what the
   customer owes, which is closer to `sales.edit`. Recommendation: reuse an existing permission
   rather than invent one, and decide whether cancellation should be raised to match.

## Order of work

| | Part | Migration | Independently shippable |
|---|---|---|---|
| 0a | Storefront completion never requires a register | Yes | Yes — unblocks shops that cannot complete an order at all today |
| 0b | Pick-up always visible, with the address | Yes — `get_public_storefront` must return it | Yes |
| 1 | Screen redesign | No | Yes |
| 2 | `amend_order` + amend sheet | Yes | Yes — alone it breaks the shortfall dead end |
| 3 | Share token, public page, confirm | Yes | Yes |
| 4 | `split_order` | Yes | Optional; hold until asked |

**Each part gets its own implementation plan.** This spec is deliberately wider than one plan — it
exists so the four parts are designed against each other rather than discovered in sequence. Part 1
touches no database and should be planned and merged before Part 2 is written, so the redesign is
not held hostage to a migration.

## Testing

- **The register regression, first.** A location with `require_open_register = true`, a `ready`
  order, `complete_storefront_order` → succeeds. The same assertion for `complete_sale` called
  directly with no session at that location → still raises, proving the POS guard survived. And a
  completion by a member with an open session at that location → the sale carries
  `register_session_id`, so counter handovers still reconcile.
- **`verify-order-transitions.sql` grows** with the amend cases: amend at each of the five statuses
  (two must raise), the deleted-product line, `deliver → collect` zeroing the fee, empty-lines
  refusal, and — the important one — **amend then complete**, proving a re-priced order still
  completes rather than raising `order_total_changed`.
- **A separate check that `get_public_order` leaks nothing**: assert the returned key set exactly,
  so a future column added to `orders` is not silently published.
- **`confirm_public_order` cannot mutate anything but the timestamp**, asserted against the whole
  row before and after.
- **Token unguessability** is a property of the generator, tested for length and alphabet, and the
  unique index is asserted.
- Component tests follow the existing `orders-screen.test.tsx` / `order-detail.test.tsx` pattern:
  the inline action renders only the legal move; a terminal row renders none; the delta panel
  matches the RPC's before/after; the "Awaiting customer" chip does not disable "Mark ready".
