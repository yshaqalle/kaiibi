# A carousel for flyers and sales — design note

**Date:** 2026-08-26
**Status:** Captured, not yet planned
**Touches:** plan 2's editor (merged) and the three themes

## The ask

A shop wants to put flyers and sale announcements on its page — the seasonal
poster, "everything 20% off this week", a new-stock photo. Today the page has
one optional hero image that only the Window theme reads, and nothing that
carries a promotion.

## What it needs to answer

1. **Where the images live.** There is exactly one upload path in the app —
   `uploadImage(path, localUri)` (`src/lib/storage.ts:26`), used by shop logos,
   product photos and the storefront hero. A carousel must use it too, not a
   fourth. Storage is the `product-images` bucket, which is public — so a flyer
   is customer-readable by design, which is what we want here.
2. **How many, and what happens with one or none.** A carousel of one is a hero.
   A carousel of none must render nothing at all, not an empty frame — the
   photo-optional rule every theme already follows.
3. **Which themes show it.** Market and Window have room; Counter is a dense
   price list whose whole purpose is making a 200-line catalogue readable, and a
   carousel would fight that. Decide per theme rather than bolting it on to all
   three.
4. **Whether a slide can link anywhere.** A flyer that cannot be acted on is
   decoration. Linking to a category filter, or to a WhatsApp enquiry about the
   offer, is what turns it into a sale.
5. **Motion.** Auto-advance must respect `prefers-reduced-motion`, and must not
   move while a customer is reading. A carousel that steals focus mid-read is
   worse than a static image.

## Where it belongs

The editor already has the content drawer and the `draft` column, so slides are
draftable for free — a shop can prepare next week's flyer without publishing it.
That is a real argument for doing this after plan 4 rather than inventing a
parallel content path.

## Not in scope

- Scheduling a flyer to appear on a date. Worth wanting, much bigger.
- Tying a flyer to the promotions module. The `promotions` module already exists
  and applies automatic discounts; a flyer is marketing, not pricing, and
  conflating them would make the discount engine's behaviour unclear.
