# The storefront address should follow the shop's name — design note

**Date:** 2026-08-26
**Status:** Captured, not yet planned
**Touches:** plan 2's editor (merged), `src/components/storefront/editor/content-drawer.tsx`,
`src/lib/storefront-slug.ts`, `src/lib/storefront-admin.ts`

## The gap

Today the editor SUGGESTS `normalizeSlug(shopName)` as a tappable row
(`content-drawer.tsx:102-103,172-178`) but the shop may type anything. When the
slug is taken they are told "That address is already taken — try a different
one" and left with a blank slate to invent one.

Two shops called Xamdi Electronics therefore end up at unrelated addresses, and
a shop that loses the race has to think of a name rather than adjust the one it
already has.

## What it should do

1. **The address is derived from the shop's name by default.** They correspond,
   so a customer who knows the shop can guess the link.
2. **When the derived slug is taken, offer a SUFFIX field**, not an empty box.
   The base stays; the shop appends. `xamdi-electronics` + `koodbuur` becomes
   `xamdi-electronics-koodbuur`.
3. The suffix default should be the shop's neighbourhood or city, taken from its
   primary location — for Hargeisa shops that is the real disambiguator, and it
   reads like an address a customer can trust. `-2` reads like a mistake. Free
   text overrides it.
4. The assembled result runs through the existing `normalizeSlug` and
   `validateSlug`, so a suffix cannot produce an illegal address.

## The decision that is easy to get wrong

**A claimed slug must NOT follow a later rename of the shop.** Deriving is for
the unclaimed state only. Once claimed, the address is frozen: renaming the shop
must not silently move its web address, because that breaks every link already
shared or printed on a card. Changing it afterwards stays the deliberate act it
is today, with the warning the editor already shows.

## Not in scope

- Reserving a slug before it is claimed. It stays first-come, and
  `claim_shop_slug` already raises `slug_taken` on a lost race
  (`20260925000000_storefront_slug_claim.sql`).
- Renaming an existing shop's address in bulk, or redirecting an old one.
