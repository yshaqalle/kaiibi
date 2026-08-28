# Storefront — known gaps, accepted trade-offs, and what to reconsider

**Date:** 2026-08-28

Everything here was found while building or verifying the storefront series and then
either deferred deliberately or left standing. Each entry says what it is, why it is
that way, and what would change the answer. Nothing here is a surprise waiting to be
discovered — but several are only safe while an assumption holds, and the assumptions
are named.

Ordered by what could actually hurt.

---

## A. Correctness risks worth a decision

### A1. A delivery fee is not taxed at a tax-charging shop

**What.** The delivery fee posts to `4300 Delivery Income` untouched by the tax
calculation. At a shop with tax enabled, the goods carry tax and the delivery does not.

**Why it is like this.** It was flagged during the fulfilment work and never resolved,
because whether delivery is a taxable supply is a question about Somaliland tax law, not
about the schema.

**What would change the answer.** An actual answer from someone who knows the rule. If
delivery is taxable, every completed delivery order since the feature shipped has under-
declared tax by the fee's share — a small number today (0 orders), which is exactly why
it should be settled *before* volume arrives.

**Reconsider: before the first delivery order at a tax-charging shop.**

### A2. A shop that revoked `discounts.manual` cannot fulfil a repriced order

**What.** Filing a line below the shelf price requires `discounts.manual`. If a shop
*raises* a price after a customer ordered, completing that order is an undercut, so
whoever completes it needs that permission.

**Why it is like this.** The gate is correct — it stops a cashier undercutting at the
till. Storefront fulfilment is exempted through a provenance row, but only for the
storefront path.

**Why it is probably fine.** `20260826000100` backfilled `discounts.manual` onto every
role holding `pos.access`, and all three seeded roles carry it. Only a shop that
deliberately built a "cashier, no discounting" role is affected.

**What would change the answer.** A shop reporting they cannot hand over an order. The
fix is to let `complete_storefront_order`'s own exemption cover the case rather than
widening the till's gate.

### A3. The provenance delete is load-bearing and easy to lose

**What.** `complete_storefront_order` writes a row to `storefront_order_fulfilments`,
which exempts a line from the undercut gate, and **deletes it the moment
`complete_sale` returns**. Without the delete, the same cashier can undercut at the till
in the same transaction.

**Status: guarded.** It is covered by the copy-forward guard, which fails before the SQL
is applied. It was *not* guarded when it shipped — removing the line left 216 assertions
green.

**Reconsider: never remove it.** This entry exists so the next person to reproduce that
function knows why one `delete` looks disproportionate.

---

## B. Accepted trade-offs that are only safe while an assumption holds

### B1. Offer dates use `Africa/Mogadishu` as a platform constant

Every market kaiibi serves is UTC+3, so one constant is correct for every shop today.
`20260908000320` states this and explicitly declines a `shops.timezone` column, with a
note not to "fix" it as an oversight.

**Reconsider: the first market that is not UTC+3.** That function is the single place to
change.

### B2. The flyer offer's wording is derived in TypeScript, not SQL

SQL decides *whether* an offer is live (`promotion_is_live`); the client decides *how it
reads*. That keeps one implementation shared with the printed poster.

**The assumption:** the client is the only consumer. If anything server-side ever needs
to render an offer — an email, a WhatsApp template, a PDF — it cannot reuse this, and the
duplication comes back.

### B3. An agreed price above the shelf price is unbounded

Only the undercut direction is gated. A caller can file a line *above* list, up to the
$10m ceiling. Deliberate: overcharging lands on the receipt and in revenue, unlike a
discount, and nothing else in the system gates charging more.

**Reconsider: if a client is ever written that a shop does not control.**

### B4. `auto_advance` is written live, not staged into the draft

`publish_storefront` copies a fixed list of draft keys and `auto_advance` is not one, so a
staged value would never publish. Same posture as delivery areas.

**Reconsider: if the draft/publish split is ever generalised.**

### B5. The Inventory Online/Not-online chips are not gated on the module

A shop without the storefront module sees two extra filter pills. Deliberate: the toggle
itself is ungated, and `hasModule` resolves async, which would intermittently drop the
deep-linked filter.

**Note:** the lapse work (Task 3) makes lapsed shops *see* storefront affordances by
design, which makes this less anomalous than it was.

---

## C. Product gaps, deliberately not built

| Gap | Why not | What would change it |
|---|---|---|
| **Bulk "list online"** | A shop publishing its whole catalogue by accident is a decision, not a convenience | 4 products across 11 shops suggests the per-product cost is already too high. **Most likely of these to be worth doing.** ~half a day |
| **Refunding a delivery fee** | "Does returning one item out of five refund the trip?" is a product question | Someone answering it |
| **Scheduling a flyer** | Draft plus a tap runs a week's promotion | A shop asking for it |
| **Flyers on the Counter layout** | Counter exists to make a 200-line price list readable | Nothing — this one is right |
| **Redirecting an old address** | Needs a resolver that fails **open** — the opposite of what makes the current one safe | A shop that renamed and lost traffic |
| **Video flyers** | Autoplaying video on a metered connection is a cost the customer pays | Cheaper data |
| **Online payment** | See the design note — needs no provider, but moves risk to the customer | The owner's decision |

---

## D. Verification gaps

### D1. Native has never been seen on a phone

The nav rows (#93), the share block (#95) and the ☰ badge (#100) are Jest-verified on
native and browser-verified on web. **Not passed, not failed — not exercised.**

Needs **port 8081**; no other port works, and
`docs/superpowers/HANDOFF-2026-08-27-storefront.md` explains why. Ten minutes on a free
machine.

### D2. One mutation cannot be killed, and that is correct

Removing the `slugTouchedRef` reset on cancel leaves the address frozen anyway — held by
the other guard. Behaviour is identical, so no test can distinguish it. Recorded rather
than papered over with a test that asserts an implementation detail.

### D3. A wholly-free sale is still refused

If every line is free, the pre-existing payments loop rejects it. Untouched by the
agreed-price work, and pre-dates it.

---

## E. Environment, not code — but it cost the most time

Three of one session's four blockers were shared-machine contention, and each produced
something that looked exactly like a defect:

- Metro on 8081 serving another worktree's branch **against production data**
- The port needed for native testing being held by another session
- The shared local Supabase being wiped mid-verification, twice

**Reconsider: a per-worktree database and Metro port.** If several sessions routinely run
at once, this would likely pay for itself faster than anything in section C.

---

## The honest summary

None of the above is why the storefront is unused. **11 shops, 1 published page, 0 orders
ever.** A1 and A2 are worth settling before volume arrives; C's bulk listing is the most
likely to change behaviour; E is what would make the next session faster. Everything else
is recorded so it is a choice rather than a surprise.
