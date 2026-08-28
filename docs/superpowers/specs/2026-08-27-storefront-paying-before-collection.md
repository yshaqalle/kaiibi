# Paying for an order before collecting it — design note

**Date:** 2026-08-27
**Status:** Captured, not planned. **One decision needed before any code.**
**Touches:** `storefronts.payment_mode`, the checkout and order-placed screens, the order inbox

## What "online payment" turned out to mean here

I had this recorded as one large blocked item — *"needs a payment provider decision"*. Reading
the codebase first, it is two very different things, and only one of them needs a provider.

**The shop already has everything required to be paid before collection**, and it is already
in the database:

| What exists | Where | What it means |
|---|---|---|
| `shops.payment_zaad_enabled`, `payment_edahab_enabled` | `0027_payment_settings.sql` | Does this business accept ZAAD / e-Dahab at all — a commercial decision, made once |
| `shop_locations.zaad_merchant_id`, `edahab_merchant_id` | `20260821000000` | **Which till at this branch receives it** — a physical fact about a counter |
| Merchant number printed under a payment line | `src/lib/receipt.ts` `merchantIdFor()` | So a customer "can see which account took their money — and query it with the carrier if it didn't arrive" |

That last line is the migration's own words. The system already tells a customer where to send
money and how to chase it. The storefront simply never shows it — `payment_mode` permits
exactly one value, `'on_collection'`, and the cart says *"Nothing is charged now."*

## The two options

### A. Show the number. No provider, no integration.

The customer opens their own ZAAD or e-Dahab app, sends the total to the shop's merchant
number, quotes the order number, and the shop confirms when it lands.

This is how mobile money is already used in Hargeisa — you send to a merchant number and show
the confirmation SMS. It is also exactly what a walk-in does at the counter today, so the
shop's side does not change at all: the order still reaches **Complete → how did they pay? →
ZAAD**, and the sale posts through the same path with the same method.

- **No gateway, no API keys, no webhooks, no settlement account, no PCI surface.**
- **No accounting change.** The sale still posts at completion. The ledger is untouched.
- Roughly: one new `payment_mode` value, the merchant number on the order-placed screen, and
  copy. Days, not weeks.

**The honesty problem it must solve.** Money arriving is not the same as an order being
accepted, and the customer has already parted with cash. If the shop then cancels — out of
stock, closed, changed its mind — the customer is out of pocket with no automatic recourse.
So this option is only safe if the page says plainly that the shop confirms payment by hand,
and if the order inbox makes an unconfirmed-but-paid order impossible to ignore. **That is
the design work, not the plumbing.**

### B. A real gateway.

Card or wallet APIs, webhooks, settlement, reconciliation against the ledger, refunds,
disputes, and a failure mode where money moves and the app disagrees about whether it did.

This needs a provider decision, and it needs to be **right about money** in a way A does not,
because A never takes custody of anything — the customer pays the shop directly, exactly as
they do at the counter.

## The recommendation

**A, and treat B as a separate product decision that A does not block.**

A matches how the market already pays, needs no third party, and reuses fields the shop has
already filled in for its receipts. B is a real project whose main cost is not the integration
but the reconciliation — and nothing in A makes B harder later, because `payment_mode` is
exactly the column that would carry it.

## The decision needed

**Should a shop be able to ask for payment before collection at all?**

It is genuinely a product call, not a technical one, and it cuts both ways:

- **For:** a shop that has been burned by no-shows stops losing the stock it set aside; and a
  customer who has already paid is far more likely to come.
- **Against:** it moves the risk onto the customer. A shop that cancels after being paid has
  taken money for nothing, and the app would be the thing that suggested it.

If the answer is yes, the next step is a mockup of the checkout and order-placed screens
before any plan — the page's honesty about "the shop confirms this by hand" is the whole
design, and that is not something to settle in prose.

## Not in scope either way

| Left out | Why |
|---|---|
| Automatic payment confirmation | No carrier API is integrated; the shop confirming by hand is the mechanism, not a stopgap |
| Refunding an online payment | Follows the delivery-fee refund question, which is already deferred for the same reason |
| Card payments | Nothing in the market asks for it yet |
