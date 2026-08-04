# Monetization: plans, trials, limits, and the platform portal — design

**Date:** 2026-08-04
**Status:** Implemented
**Scope:** Charging for Kaiibi. Subscription plans, a default trial, per-module
and numeric entitlements enforced in the database, and a back office for
managing all of it.

## Problem

The product is free and unlimited. Every shop that signs up gets POS, inventory,
customers, accounting, payroll, scheduling and multi-store with no caps and no
paying relationship. There was no billing or entitlement code anywhere.

## The conceptual split

A **permission** answers *"may this **user** do X?"* — set by the shop's own
admin, already built (migration 0024).

An **entitlement** answers *"has this **shop** paid for X?"* — set by us.

They are orthogonal and both must pass. A cashier holding `inventory.edit` at a
shop whose trial lapsed still cannot add a product. This work adds the second
axis; it does not extend the first.

## Shape

- **`plans`** are rows, not code: `modules text[]` and a `limits jsonb`. Pricing
  and packaging change from the portal without a deploy, because the right cut
  of features is not knowable up front.
- **A missing or null limit means unlimited.** That direction matters: adding a
  newly-limited resource later cannot retroactively cap existing plans at zero
  and lock paying customers out of something that worked yesterday.
- **The subscription anchors on `shops.id`.** Multi-store
  (`20260808000000_shop_locations.sql`) explicitly kept `shops` as the sole
  tenant and split out `shop_locations` as the place it trades from, so one
  subscription covers all of a shop's branches — with the store count itself as
  the headline plan limit.
- **Status is computed, not stored.** Derived from `trial_ends_at` /
  `current_period_end` / `grace_until` against `now()` at read time. No cron job
  whose failure leaves a lapsed shop reading as active. The one exception is
  `manual_status`, the operator's suspend switch, which is stored precisely
  because a human sets it rather than time.

## Decisions

**Trials are set by a trigger on `shops`, not by `createShop()`.** That function
inserts name, city and phone straight from the signup form; a `trial_ends_at`
written the same way would be a text field the user could set to the year 3000.

**Limits are enforced by a `BEFORE INSERT` trigger, not an RLS `with check`.**
Two reasons. A trigger can raise a typed error carrying the resource, the cap and
the usage, so the UI can offer an upgrade instead of showing a bare 403
indistinguishable from "you lack permission". And a `select … for update` on a
counter row makes the cap **exact** under concurrency, where a `count(*)`
subquery is not — two transactions inserting the 50th product both see 49 and
both pass. Verified with two racing inserts at the boundary: one wins, one gets
`limit_reached`, and the counter matches the real row count.

**Module gates are triggers too, and this one is load-bearing.** RLS was the
obvious home and the wrong one: almost every interesting write here goes through
a `security definer` RPC — `complete_sale`, `transfer_stock`, `post_payroll_run`,
`record_invoice_payment`, `log_recurring_bill`, `pos_create_customer` — and those
bypass RLS by definition. Gating policies would have left every one of them open,
and closing them meant reproducing eleven function bodies whole. A trigger covers
them all and cannot be forgotten when a twelfth RPC is added.

**A counter table, not `count(*)` per insert.** The app had no server-side count
of anything — every count in the UI is `array.length` over a fully-fetched list —
so this was new machinery either way. It makes the check O(1) on a table that
only grows, and pays for itself again in the Billing panel and the portal's usage
columns.

## What lapsing does, and does not, do

Stated explicitly because this is where monetization usually hurts real users.

- **Reads are never gated.** A shop that stops paying keeps full sight of its own
  sales, stock, books and payroll history. Blocking reads is indistinguishable
  from destroying the records.
- **Deletes are never gated.** Removing a record is how a shop gets back under a
  cap — the limit message says "remove one, or upgrade", and gating deletes would
  make that advice a dead end. A cascade must never be blocked by billing state,
  and a business must always be able to remove its own data.
- **Refunds are never gated.** A customer returning goods is owed their money
  whatever the shop's billing status. Refusing would make our invoice the
  shopper's problem.
- **Over a cap after a downgrade:** existing rows stay readable and editable *in
  place*; only `INSERT` is blocked. A Pro shop dropping to Free keeps all four
  stores — it just cannot open a fifth.
- **Grace exists** because payment here is ZAAD/eDahab confirmed by hand. A shop
  that paid on Thursday must not be locked out on Friday because we had not
  recorded it yet.

## Payments

Manual. The region is Somaliland; Stripe is not available. A customer pays by
mobile money, an operator confirms receipt and records it, and that is what moves
`current_period_end`. `subscription_payments.provider` exists so a real
provider's webhook can insert alongside without a schema change.

The shop-side Billing panel therefore gives **payment instructions, not an
in-app purchase flow** — an in-app purchase button on iOS would pull the whole
app under Apple's IAP rules for a transaction that never touches the device.

## The platform portal

Operators act across every shop and are appointed by us, so the design assumes an
operator account is a high-value target.

1. **Its own table, never a `profiles.role` value.** `handle_new_user()` copies
   client-supplied `raw_user_meta_data` into `profiles.role` at signup, so any
   privilege derived from it is self-assignable.
2. **MFA required, not encouraged.** `is_platform_admin()` demands `aal2`, so a
   stolen password alone buys nothing. Checked in the database on every request,
   not in a login screen an attacker can skip by calling the API directly.
3. **It cannot read customers' business data.** Its policies cover billing state
   and usage counts and stop there — no products, sales, customers, expenses,
   shifts or payroll. Operators can run the business without reading anyone's
   books, so a compromised account leaks billing metadata rather than every
   shop's trade.
4. **Every mutation is audited and the log cannot be edited.** One edge function
   is the only write path; it re-checks authority and writes an append-only row
   with a mandatory reason. The log has no insert/update/delete policy for
   anyone.

## Deliberately not built

- **No "add operator" endpoint.** Appointing one is a manual SQL statement. A
  privilege-granting endpoint is what turns a single compromised operator into a
  permanent foothold.
- **No impersonation.** "Log in as this shop" is the feature most likely to
  become the breach. If it is ever needed it must be read-only, time-boxed,
  consented and audited — its own design.
- **No plan editing from the portal UI yet.** The edge function supports
  `upsert_plan`; the screen shows how many shops each plan affects but does not
  yet write. Editing a plan changes entitlements for every shop on it at once,
  which deserves a considered UI rather than a form bolted on.
- **No dunning or reminder emails.** There is no send infrastructure — see
  `docs/backlog/2026-08-01-notification-delivery.md`.

## Open questions

1. **On expiry, does POS stay live?** Currently all writes stop, including new
   sales, which is the leverage that makes people pay. The humane alternative is
   POS live and everything else read-only. One row in `plans.modules` to flip.
2. **Prices are placeholders** (`$18` Standard, `$45` Pro) and are expected to be
   retuned against real conversion before launch. The packaging is the part worth
   reviewing now.

## Side effect worth knowing

Enabling TOTP in `config.toml` for the portal gives
`docs/backlog/2026-08-01-two-factor-authentication.md` the infrastructure it was
waiting on. Shop-side 2FA is still a UI-only mock, but the enrol/challenge/verify
flow now exists and works, in `src/app/(platform)/_layout.tsx`.
