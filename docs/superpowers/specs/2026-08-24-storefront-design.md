# Online storefront — design

**Date:** 2026-08-24
**Status:** Awaiting review
**Mockup:** `docs/design/storefront-mockup.html` (14 screens)
**Scope:** A public page per shop at `<slug>.kaiibi.com`, an editor for it, a
cart and checkout, and the inbox the shop works orders from.

## Problem

`products.is_listed_online` has existed since `0001_init.sql` and the product
form has offered "Expose to customers" for months. It feeds
`marketplace-coming-soon.tsx` — a screen with a full stop on it. Shops have been
ticking a box that does nothing.

Meanwhile every sale in the app is `sales`, created at a register by a signed-in
cashier. A shop that wants to sell to someone who is not standing in front of it
has no path at all: no public surface, no order concept, no way to take a request
that isn't a POS transaction.

## What this builds

A shop turns on the `storefront` module, picks a design and a colour, writes two
sentences, adds a WhatsApp number, and publishes. `xamdi.kaiibi.com` then shows
their `is_listed_online` products with live prices and stock. A customer builds a
basket, gives a name, a phone number and — for delivery — an area and a landmark,
and places an order. The shop sees it in **Orders**, confirms it, and marks it
delivered, which is the moment it becomes a `sale` and posts to the ledger.

Nobody pays online. The customer pays the rider or pays at the counter.

## Decisions

### Money does not move online, but the shape allows for it

`storefronts.payment_mode` is CHECK-constrained text, and only `'on_collection'`
is permitted. Adding `'online'` later is a constraint change plus a new code
path, not a migration across live shops.

**`orders.payment_mode` is copied from the storefront at creation, not read
live.** Orders outlive settings. If a shop enables online payment in March, every
order taken in February must still read as pay-on-collection in the inbox and in
the books — otherwise enabling a feature silently rewrites history that the
ledger has already posted against.

Nothing in this spec branches on the value. It is a recorded fact waiting for a
second one.

### The cart buys; WhatsApp asks

Two channels, two jobs, both on every product tile: **Add** (primary) and **Ask**
(secondary, a `wa.me` deep link prefilled with the shop and product name).

An enquiry-only page leaves the shop exactly where it started — a phone full of
"do you have this?" to answer by hand with no record. A cart-only page loses the
sale that depends on whether the cord reaches the socket or whether it comes in
black, which no product grid answers.

Out-of-stock products are shown, marked unavailable, and keep **Ask** while
losing **Add**. Hiding them makes a customer who saw the kettle yesterday think
the shop lost it; the enquiry may well be a sale, because the shop may be
restocking.

### Both checkout buttons write the same order row

**Place order** creates the order. **Send this order on WhatsApp** creates the
same order and *then* opens `wa.me` prefilled with the order number and every
line.

A WhatsApp checkout that only opens a chat produces sales the app cannot see,
count, or fulfil — the exact fragmentation this feature exists to end. Writing
first also means an abandoned message still leaves the shop an order.

### Adding to a cart reserves no stock

Stock is checked when the shop **confirms**, and a shortfall surfaces in the
inbox as a `wrong` caveat naming the fix. Reserving on add-to-cart would let
anyone empty a shop's shelves from a browser with no account and no cost.

The consequence is honest and belongs to the shop, not the schema: a confirmed
order is a promise, an unconfirmed one is a request.

### Line prices and the delivery fee are captured at order time

`order_items` stores product id **plus name, unit price and quantity as they were
shown**. `orders.delivery_fee_cents` likewise.

Same reason sale lines do not join live to products: an order must still read
correctly after the product is renamed, repriced or deleted, and raising the
delivery charge next month must not rewrite what a customer already agreed to
pay.

### Delivery is per-area, priced by the shop

`storefront_delivery_areas` is a child table — name, `fee_cents`, sort order —
not JSON, so a fee is a typed column that can be summed and checked `>= 0`.

Per-area rather than one flat charge because the area list already has to exist
for the address, "outside town costs more" is how this trade prices, and a flat
fee is just the degenerate case where every row carries the same number. One
structure covers both. `$0` is a valid fee.

A master **Offer delivery** switch gates the whole thing; off means checkout is
collection-only and no area fields render.

### The address is an area plus a landmark, never free text

Hargeisa addresses are landmarks, not street numbers. A free-text address field
produces something no rider can use. A shop-owned area list plus
`delivery_landmark` is what a delivery actually runs on, and the list doubles as
the shop's statement of where it will not go.

### Everything keys on `shop_id`, so a branch gets its own storefront

There is no `stores` table. A branch is another `shops` row with the same
`owner_id` (`shops.ts:59`, and `multi_location` is described as "open more than
one branch"). So a two-branch business gets two storefronts and two subdomains.

That is right for delivery (branches cover different areas at different prices)
and right for stock (the online list is that branch's actual shelves). It is
arguably wrong for brand — but a business-above-shop concept exists nowhere in
this codebase, and inventing one for the storefront would be the tail wagging the
dog.

### Three themes, all photo-optional

**Market** (even grid, price-forward — the default), **Counter** (a price list,
grouped by `products.category`), **Window** (larger tiles, hero band).

`products.image_url` is nullable and mostly empty. Themes that lead with
professional photography — the obvious ones to draw — make a shop with seven
photos across eighteen products publish a page of empty frames. Every theme here
is designed to look deliberate with zero images: the no-photo tile is a
typographic label carrying the product name, not a broken-image box.

### Colour is six presets, not a picker

`Ink · Palm · Clay · Sea · Saffron · Plum`. A palette is four custom properties —
ground, soft, ink, accent — and themes render through them, so three themes and
six palettes is nine things to build, not eighteen.

Presets because a free hex field lets an owner publish yellow on white. Each
palette is contrast-checked before it ships, the discipline `theme.ts` already
applies to every app token:

| Palette | Accent on white | Ink on ground |
|---|---|---|
| Ink | 18.37:1 | 18.37:1 |
| Plum | 8.02:1 | 17.04:1 |
| Sea | 7.50:1 | 16.34:1 |
| Clay | 6.52:1 | 16.38:1 |
| Palm | 6.47:1 | 16.22:1 |
| Saffron | 5.92:1 | 16.14:1 |

`theme` and `palette` are both CHECK-constrained to the shipped catalogue; an
unknown value falls back to the default rather than rendering an unstyled page.

**WhatsApp green (`#1f7a4d`) is not themeable.** It is a recognised affordance;
recolouring it to match a shop's accent costs the thing that makes it get tapped.

### Editing is a form drawer, not inline editing

The editor is the reference layout: picker strip on top, actions in the bar,
preview taking the room. **Edit text & images** opens a form drawer rather than
making the preview editable.

Same button, same position, a fraction of the work, and it can become true
click-anything editing later without moving anything an owner has learned. The
content model is identical either way, so none of this is throwaway.

Content lives on the shop, not in the theme, which is what makes "your words
carry over when you switch designs" true rather than a claim.

### The preview is the real storefront

It renders the real theme components against real products at real breakpoints.
There is no second storefront implementation living inside the editor.

### Publish is never disabled

Pressing **Publish** without a WhatsApp number opens the drawer and focuses a
`wrong` caveat naming the fix. A greyed-out button with no explanation is the
failure this screen exists to prevent, and the bento rule holds: a `wrong` tone
always names its fix.

### A draft shop and a nonexistent shop render the same page

Identical copy, identical status. If "not published yet" were distinguishable
from "no such shop", the subdomain becomes an oracle for walking names and
learning which shops are on kaiibi before they open. Enforced in RLS, so the
public read path never sees an unpublished row.

### Only one order state writes to the ledger

`placed → confirmed → ready → completed`, plus `cancelled`.

Placed, confirmed and ready are shop workflow and touch nothing. **Completed**
(delivered or collected) creates the sale, moves stock and posts the journal
entry through the existing `post_complete_sale` path — so an online order and a
counter sale land in the ledger identically.

Cancelling before completion writes nothing: no money moved, no stock left. Only
a completed order can be refunded, through the existing refund path.

Unconfirmed order value is never counted as revenue anywhere. An order is a
customer's intention; a sale is a thing that happened.

### The delivery fee needs an account that does not exist

`20260904000100` seeds `4000 Sales Revenue`, `4100 Sales Returns`, `4200
Discounts Given`. There is nothing for delivery.

Posting the fee into `4000` adds income carrying no cost of sales, inflating
goods revenue and flattering gross margin on every report. It needs **`4300
Delivery Income`**, seeded the way the others are.

The posting belongs to the fulfilment phase, but `delivery_fee_cents` must be its
own column from the first migration or the split is unrecoverable.

## Schema

| Change | Notes |
|---|---|
| `shops.slug` | Globally unique, nullable until set. Reserved list blocks `www`, `app`, `api`, `admin`, `platform`. |
| `shops.whatsapp_e164` | `contact_phone` is free text and cannot be dialled. Required to publish, not to exist. |
| `storefronts` | One per shop: `theme`, `palette`, headline, about, hero image, `offers_delivery`, `payment_mode`, `published_at`. |
| `storefront_delivery_areas` | Name, `fee_cents >= 0`, sort order. |
| `orders` | Per-shop sequential `number`, customer name, E.164 phone, `fulfilment`, area, landmark, note, `payment_mode`, `status`, `subtotal_cents`, `delivery_fee_cents`, `total_cents`. No customer account. |
| `order_items` | Product ref plus name, unit price and quantity captured at order time. |
| Module `storefront` | 14th entry in `entitlements.ts`, gated in DB write policies and the client route guard. |
| Account `4300` | Delivery Income. Fulfilment phase. |

### The security surface

Every other table in this app is read by an authenticated member of one shop.
This adds **an unauthenticated read and an unauthenticated write**, which nothing
here has today.

- The public read goes through an explicit column list — never `select *` —
  because `products.cost_cents` sits one column from `price_cents`. A test
  asserts cost is absent from the public payload.
- Order creation recomputes every line total server-side from current product
  rows. A client-supplied price is a discount anyone can grant themselves.
- Order creation is rate-limited per IP.
- The public read sees only published storefronts and only `is_listed_online`
  products belonging to them.

## Routing

Web ships as an SPA (`web.output: "single"`) behind a catch-all rewrite in
`vercel.json`, so a wildcard `*.kaiibi.com` domain plus a hostname read at boot
resolves the shop. No change to the hosting shape.

The app itself stays on the apex domain; a reserved-subdomain list keeps the two
from colliding.

## Not in this spec

| Left out | Why |
|---|---|
| Click-anything inline editing | Its own spec over this same content model. The button and its position are already right. |
| Online payment | `payment_mode` holds the seat. |
| Customer accounts, order tracking page | A number and a phone call. A signup wall in front of checkout costs more orders than tracking wins. |
| Custom domains | Subdomain only. |
| Search, follow, best sellers, product detail page | Eighteen products fit on one screen. |
| Business-above-shop branding | Would require a concept this codebase does not have. |

## Scope warning

This is four subsystems: a public storefront, an editor, an ordering system and a
fulfilment workflow. It is large.

It is also the smallest genuinely useful cut. A page nobody can order from, or
orders nobody can work, is not a shippable half. The implementation plan phases
it so each phase leaves the tree working, and the phase boundaries are where work
can stop if it proves too much at once.
