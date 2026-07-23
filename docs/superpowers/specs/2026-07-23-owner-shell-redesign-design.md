# Owner shell redesign: sidebar nav + simplified POS/Inventory/Dashboard/Sales (web)

## Overview

Ka Iibi's owner-facing web screens (Dashboard, Sell, Inventory, Sales) currently use a top nav bar and ad-hoc, inconsistent styling across screens. This redesign replaces the top bar with a persistent left sidebar and restyles the four owner screens onto a small set of shared primitives, adopting a monochrome black/white/gray visual language (matching a reference design the user shared) in place of the current mixed pastel/hex-per-screen styling.

This is a **visual and structural redesign only** — no changes to data fetching, business logic, or the database schema, except for one small addition: category and tag entry on the Add/Edit Product form becomes freeform and self-suggesting instead of a hardcoded, skincare-specific category list (see [Category & tag creation](#category--tag-creation)).

Scoped to **web only**. Native keeps its existing bottom `NativeTabs` bar, which is already an idiomatic mobile pattern — only the route/trigger name for the renamed POS screen needs to follow along (see [Route rename](#route-rename-sell--pos)).

## Goals

- Replace the top nav bar (`owner-tabs.web.tsx`) with a left sidebar showing the logged-in shop's own name/category, not "Ka Iibi" branding.
- Restyle Dashboard, POS (renamed from Sell), Inventory, and Sales onto a shared, monochrome visual language.
- Add real category filter chips to the POS product grid, derived from the shop's actual products.
- Fix category/tag entry on the product form to work for any shop type, not just skincare.
- Reprioritize payment method selection on POS to match real usage (mobile money first).

## Non-goals (deferred to future specs)

Raised mid-design and explicitly deferred, in priority order for follow-up:
1. **Dashboard trends & graphs** — richer analytics beyond the current 7-day chart.
2. **Custom report generation** — a report builder for sales/inventory (filters, date ranges, exports).
3. **Customer management** — a new `customers` entity, list/profile screens, likely a new table + RLS policy.
4. **Sale ↔ Customer association** — `sales.customer_id`, a customer-picker in the POS checkout flow.

None of these are touched by this spec. The sidebar is built to accept a 5th/6th nav item later without restructuring.

## Architecture

### Nav shell

`src/components/owner-tabs.web.tsx` is rebuilt around a left sidebar instead of the current top `Header`:

- Fixed-width (~210-220px) sidebar, white background, `1px solid #ECECEC` right border.
- **Header block**: small square avatar (shop-name initial, dark `#17261F` fill) + `shop.name` (bold, ~15px) + `shop.categories[0]` as a muted subtitle line, omitted entirely if `shop.categories` is empty (falls back to just the name, no blank second line). This replaces the current static "Ka Iibi · Owner" text — every shop sees its own identity here.
- **Nav items** (in order): Dashboard, POS, Inventory, Sales. Active item gets a light gray (`#F2F2F2`) pill background; inactive items are plain text, no background.
- **Footer block**: small "Powered by Ka Iibi" credit line + sign-out, pinned to the bottom via `marginTop: 'auto'`.
- Built with the same `expo-router/ui` `Tabs`/`TabList`/`TabTrigger` primitives already in use — only the `Header` component's internal layout changes from row to column, and the visual styling changes.

Native (`owner-tabs.tsx`) is untouched structurally — it keeps `NativeTabs` at the bottom.

### Shared primitives (new, in `src/components/`)

- **`Card`** — white surface, `1px solid #EDEDED` border, `12px` border radius. Replaces the repeated inline card styling on all 4 screens.
- **`StatTile`** — evolves `MetricTile`: value + label, white/neutral background (no colored `tone` prop), used on Dashboard and Sales.
- **`CategoryChip`** — pill button, active (`#111` fill, white text) / inactive (`white`, `1px #E2E2E2` border, gray text) states. Used on POS.
- **`ProductTile`** restyled into a table row for Inventory (thumbnail, name+brand, SKU, category, price, stock stepper, status pill, edit icon) rather than its current mobile-card layout. POS keeps a grid-tile rendering (name, brand, price, stock badge) — same underlying `Product`, two different presentations for two different contexts.
- **`PaymentMethodPicker`** — two prominent buttons (Cash, ZAAD) + a "More options ▾" toggle revealing e-Dahab and Other. See [Payment method priority](#payment-method-priority).

### Color palette

Fully monochrome, matching the reference exactly:
- Background/surface: `#FFFFFF`
- Borders: `#ECECEC` / `#EDEDED`
- Primary text: `#111111`
- Secondary/muted text: `#999999` / `#777777`
- Active/primary fill: `#111111` (black) — active nav pill background uses light gray `#F2F2F2` instead of black (matches reference; black fill is reserved for buttons/badges)
- Status colors kept as functional exceptions: low-stock warning stays warm amber (`#B5793A` text / `#E8C99B` border), out-of-stock uses solid black/dark-gray pill (not red) to stay within the monochrome system

Ka Iibi's terracotta (`#E45B37`) is **not used** anywhere in this redesign — confirmed explicitly. `constants/theme.ts` is not modified; these are new screen-local styles, not a token-system rewrite (that was considered and explicitly deferred — see approaches discussion).

## Screen-by-screen

### Dashboard (`dashboard.tsx`)

Keeps all current sections — stat row, 7-day chart, top-selling products, low-stock alerts, recent transactions — restyled onto `Card`/`StatTile` and the new sidebar shell. No new charts or data added in this pass.

### POS (renamed from Sell)

File: `sell.tsx` → `pos.tsx`. Route: `/sell` → `/pos`. Nav label: **POS**.

- Same split layout (browse pane + cart pane) as today.
- Search box, restyled.
- **New**: category chip row above the grid — "All" plus one chip per distinct `product.category` value already present in the shop's loaded product list (derived client-side from the existing `listProducts` result, no new query). Tapping a chip filters the grid client-side, same mechanism as the existing search filter.
- Grid tiles restyled onto `Card`: brand (small caps, muted), name, price (bold black, no longer terracotta), stock/low-stock/out-of-stock indicator.
- Cart pane ("Current sale"): line items, subtotal/total, then payment method picker (below), then a full-width black "Complete sale" button (renamed from "Checkout" — matches reference wording).

#### Payment method priority

`PaymentMethodPicker` shows **Cash** and **ZAAD** as equal-size, equally-prominent buttons (majority of transactions are mobile money) — neither is pre-selected by default; the cashier must actively tap one before "Complete sale" is enabled, so a forgotten tap can't silently submit as the wrong method. Below them, a "More options ▾" toggle expands to reveal **e-Dahab** and **Other** (existing dashed/muted chip styling). This uses the existing `PaymentMethod` type (`cash | zaad | edahab | other`) — no schema change, no new "Card" method.

### Inventory (`inventory.tsx`)

Table-style rows replace the current mobile-card list: thumbnail, name + brand, SKU, category, price, stock (with `−`/`+` steppers reusing the `QuantityStepper` interaction pattern) with low-stock/out-of-stock pills inline, and an edit icon per row. Header shows product count + "N need attention" (low-stock + out-of-stock count), search box, and the existing "+ Add product" button (restyled to solid black).

#### Category & tag creation

Today, `product-form.tsx` hardcodes `categories = ['Skincare', 'Makeup', 'Hair', 'Body', 'Supplements']` for every shop, and tags are a bare comma-separated text field with no suggestions. This doesn't work for a general marketplace — a shop selling hardware or groceries is stuck picking from a skincare-oriented list.

New behavior: `ProductForm` fetches the shop's existing products (already needed to derive POS's category chips — can share the same `listProducts` call pattern) and derives two suggestion sets client-side:
- Distinct `category` values already used by this shop → rendered as tappable chips, plus a "+ New" chip that reveals a text input for typing a category that doesn't exist yet.
- Distinct individual `tags` values already used by this shop → rendered as tappable suggestion chips below the tags input; tapping one appends it to the comma-separated field. Free typing still works for genuinely new tags.

No schema change — `category: string | null` and `tags: string[]` already support arbitrary values; this only changes how the picker UI populates its options. First product for a shop (no existing products to derive suggestions from) falls back to just the free-text input with no suggestion chips.

### Sales (`sales.tsx`)

Stays a separate 4th nav item (not folded into Dashboard). Stat tiles (today's sales, today's orders) restyled onto `StatTile`; transaction list rows restyled onto `Card`. No behavior change.

### Route rename: `/sell` → `/pos`

Renaming `sell.tsx` → `pos.tsx` requires updating every reference: `owner-tabs.web.tsx`'s `TabTrigger name="sell" href="/sell"`, and **`owner-tabs.tsx`'s native `NativeTabs.Trigger name="sell"`** (this file is shared across platforms via the same route group, so the native trigger name must be updated even though native's visual design isn't otherwise in scope). Its label also changes from "Sell" to "POS" so the terminology matches everywhere, even though native's icon/layout stay as-is. Any `router.push('/sell')` call elsewhere in the codebase (none found in the screens reviewed) would also need updating — verify with a repo-wide search during implementation.

## Error handling & edge cases

- Empty cart: "Complete sale" stays disabled (existing behavior, unchanged).
- No payment method selected: "Complete sale" stays disabled until Cash or ZAAD (or an expanded option) is tapped.
- Shop with zero products: POS shows no category chips (just "All"); Inventory shows the existing empty state; product form shows category/tag inputs with no suggestion chips.
- RPC/checkout errors: existing `extractErrorMessage` handling in `pos.tsx` (moved verbatim from `sell.tsx`) is unchanged.

## Testing

No new business logic is introduced apart from client-side category/tag derivation (a pure function over an already-fetched product list) — cover that with a unit test (given a list of products, returns distinct sorted categories/tags). Visual changes are verified by running the app in a browser and checking each of the 4 screens against the mockups reviewed during this design session (saved under `.superpowers/brainstorm/` for reference) — not automated, per the project's existing test coverage patterns.
