# Location directory (backlog)

**Status:** Backlog — not scheduled. Currently a UI-only mock ("Your locations" section, Settings → Locations).

**Where it lives today:** `src/components/settings/panels/phase2-panels.tsx`, `LocationsPanel` — the "Main location" row and "+ Add location" button are static, not backed by any table.

## What this covers

A simple directory of a shop's physical locations (name, address/city) — the "+ Add location" / per-location "Edit" part of the mock. On its own this is just an address book: it doesn't make inventory or sales location-aware by itself.

## What real implementation would need

- A new `shop_locations` table (`id`, `shop_id`, `name`, `city`, `neighborhood`/address, `created_at`) — no changes to `products`, `sales`, or any existing table.
- Standard CRUD (`lib/locations.ts`: `listLocations`/`createLocation`/`updateLocation`/`deleteLocation`) and a Settings panel following the same pattern as Cashiers/Currencies (pill list or row list + manage modal).
- RLS policies scoped by `shop_id`, matching every other shop-owned table.

## Note

This is the one piece of "Locations" that's genuinely small and self-contained — comparable in size to Cashiers. It's also the prerequisite for both of the other two backlog items ([[2026-08-01-separate-inventory-per-location]], [[2026-08-01-combined-sales-reports]]), since neither of those means anything without locations existing as real rows first.
