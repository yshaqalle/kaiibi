# What happens to a storefront when the plan lapses — design note

**Date:** 2026-08-28
**Status:** Decision made by the owner. Not yet implemented.
**Deadline:** the first trial lapses **2 November 2026**; seven of eleven shops are on Trial.

## The decision

> One month of grace. After that, **keep the data**, unpublish the page, and grey it
> out in the app until the shop pays.

Nothing is deleted. Paying is the way back, and the shop can see the way back.

That is a better answer than the one originally on the table ("should Standard include
the storefront?"), because it does not need a pricing change to stop a shop losing work
it has already done.

## What already exists — most of this is built

| Piece | Where | State |
|---|---|---|
| `grace` as a first-class status | `src/lib/entitlements.ts:94` — `'trialing' \| 'active' \| 'grace' \| 'expired' \| 'suspended'` | **exists**, and grace is documented there as "still fully usable" |
| `grace_until` per shop | `shop_subscriptions.grace_until` | **exists** |
| Status derived from dates | `shop_effective_status()` | **exists** |
| The public page goes dark on lapse | `get_public_storefront` calls `shop_has_module(s.id,'storefront')` (`20260930000300:195`) | **exists** — a lapsed shop's page stops being served with no extra work |
| Writes blocked when expired | `entitlements.ts:201` — writes allowed for `trialing`/`active`/`grace` only | **exists** |

So the grace month is largely a matter of **setting `grace_until`**, and the page going
dark afterwards already happens.

## What is missing — three things

### 1. The nav HIDES the storefront instead of greying it out

`admin-sidebar.tsx` gates the Storefront and Orders rows on
`hasModule('storefront')`, and the comment there argues for hiding rather than the 🔒
the five paid tabs get:

> a shop that never had a storefront is not missing anything it can see.

**That reasoning does not hold for a shop that had one and lapsed.** It is missing
something it can see, and hiding the row removes the only signpost back to paying. This
decision reverses that choice for the lapsed case.

**Wanted:** show both rows greyed with the 🔒 treatment when the shop *has* a storefront
row but no longer has the module. Tapping lands on the upgrade wall, which is where the
offer belongs. Keep hiding them for a shop that never had one — that half of the original
reasoning is still right.

The distinction is `storefronts.shop_id exists` versus `hasModule('storefront')`, and the
editor already reads the first through `getMyStorefront`.

### 2. Nothing explicitly unpublishes

`published_at` stays set. The page is dark only because the module check fails, which
means the moment a shop pays, the page **reappears exactly as it was** with no action
from them.

That may be what you want — it is kind, and the shop did not choose to be unpublished.
But it is not what "unpublish" says, and the two differ in one visible way: whether the
shop must press **Publish** again after paying.

**Decide which:**
- *Implicit* (today): pay, page returns instantly. Nothing to build.
- *Explicit*: set `published_at = null` at the end of grace. The shop reviews its page and
  publishes deliberately — prices may be stale after a month away. Needs a job or a
  check-on-read, and needs the editor to say why it is in draft.

I lean **explicit**, for the stale-prices reason: a page that quietly comes back after a
month could be advertising last month's prices to a customer who orders at them.

### 3. The address must stay reserved, and does — confirm it stays that way

`shops.slug` is where the address lives, and "keep the data" leaves it set. So no other
shop can claim it while the first is lapsed, because `claim_shop_slug` refuses a taken
slug. **That is correct and needs no work — but it is load-bearing.** If anyone ever adds
a cleanup that nulls `slug` on lapse, a competitor could take the address a shop has
printed on its cards. Worth a test that pins it.

## What to build

1. **Grey out, don't hide** — nav rows for a lapsed shop that has a storefront row. The
   visible half of the decision, and the only part a shopkeeper experiences directly.
2. **Set the grace window to one month** wherever `grace_until` is populated, and confirm
   `shop_has_module` honours `grace` — if it does not, the page goes dark on day one and
   the grace month is not real.
3. **Decide implicit vs explicit unpublish** (above), then implement whichever.
4. **A test that the slug stays reserved** through a lapse.

## Not in scope

| Left out | Why |
|---|---|
| Deleting anything on lapse | The decision is explicitly to keep the data. |
| Changing which plans include the storefront | This makes that question less urgent, not more. |
| Dunning, reminder emails, payment capture | Different subsystem. |
