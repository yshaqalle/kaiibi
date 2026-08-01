# Combined sales reports across locations (backlog)

**Status:** Backlog — not scheduled. Currently a UI-only toggle ("Multiple locations" section, marked "Pro" in the original design mock — Settings → Locations).

**Where it lives today:** `src/components/settings/panels/phase2-panels.tsx`, `LocationsPanel` — the toggle is local state only, not backed by anything.

**Depends on:** [[2026-08-01-location-directory]] — locations have to exist as real rows first. Independent of [[2026-08-01-separate-inventory-per-location]] (a shop could track combined sales without split inventory, or vice versa), but both assume the same location directory underneath.

## What this covers

"View all locations in one dashboard" — the ability to see sales rolled up across every location, as well as (implicitly) broken out per location.

## What real implementation would need

- A `location_id` on `sales` (and by extension `sale_items` inherits it via the sale) — currently `sales` is scoped only by `shop_id`, with no location dimension at all.
- The checkout RPC needs to record which location a sale happened at (ties into whatever POS location-selection mechanism [[2026-08-01-separate-inventory-per-location]] introduces, if built alongside it).
- Dashboard and Sales screens (`src/app/(admin)/(tabs)/dashboard.tsx`, `sales.tsx`) need a location filter/switcher, plus a "combined" view that aggregates across all of a shop's locations — today every query in both screens is already only scoped by `shop_id`, so "combined" is the default and only view; this feature is really about adding the *per-location breakdown*, with combined being what already exists.

## Note

Smaller than [[2026-08-01-separate-inventory-per-location]] on its own (it's a reporting/filtering change, not a checkout-integrity change), but still requires the location directory to exist and sales to carry a location reference before it means anything.
