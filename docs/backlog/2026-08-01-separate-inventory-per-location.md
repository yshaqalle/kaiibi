# Separate inventory per location (backlog)

**Status:** Backlog — not scheduled. Currently a UI-only toggle ("Multiple locations" section, marked "Pro" in the original design mock — Settings → Locations).

**Where it lives today:** `src/components/settings/panels/phase2-panels.tsx`, `LocationsPanel` — the toggle is local state only, not backed by anything.

**Depends on:** [[2026-08-01-location-directory]] — locations have to exist as real rows before stock can be split across them.

## What this covers

"Each store tracks its own stock" — a product's stock stops being one shop-wide number and becomes per-location.

## Why this is a large, invasive change (not a Settings wire-up)

Today, stock is a single `products.stock` column, and the checkout flow is a single atomic RPC (`complete_sale`, rewritten repeatedly across migrations 0001→0007) that locks and decrements it. This feature touches all of that:

- **Schema:** either a `location_id` on `products` (a product belongs to one location) or a separate per-location stock table (`product_location_stock`, if the same product is sold from multiple locations with independent counts) — a real design decision with different tradeoffs, not just a column add.
- **Checkout RPC:** `complete_sale`/`edit_sale` need rewriting again to decrement the correct location's stock instead of the product's single `stock` value.
- **POS:** the cashier needs to select (or be assigned) a location before/during checkout — a new required piece of checkout state that doesn't exist today.
- **Inventory screen:** needs a location switcher/filter — right now it lists all of a shop's products with one stock count each.
- **RLS:** location-scoped read/write policies, on top of the existing shop-scoped ones (migration 0024's permission system is already the largest migration in the codebase).
- **Staff:** a near-certain follow-up ask once this exists — a cashier who only works at one location — even though it's not in the original mock.

## Note

This is comparable in size to building a new feature area from scratch, not an incremental Settings addition.
