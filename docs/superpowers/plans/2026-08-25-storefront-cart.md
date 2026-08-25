# Storefront Cart and Checkout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A customer can fill a basket on a shop's public page, give a name, a phone number and where to deliver, and place an order the shop can see — paying on collection or delivery, never online.

**Architecture:** A cart held in the customer's browser (no account, no session), submitted through a single `security definer` RPC that recomputes every total server-side from current product rows. Orders snapshot the product name, unit price and delivery fee at the moment of ordering, the way `sale_items` already does, so an order still reads correctly after a shop reprices. WhatsApp remains the question channel — the cart is the buy channel.

**Tech Stack:** Expo SDK 57 / Expo Router, React Native Web (`web.output: "single"`), Supabase Postgres + RLS, Jest with `react-test-renderer`, psql verify scripts.

## Read this before writing anything

Plans 1 and 2 shipped ten defects between them. Every Critical and Important came from a plan's own example code rather than implementer error, and they clustered into three shapes. This plan is written to prevent all three, and an implementer should treat these as binding:

1. **Code blocks marked *illustrative* are a starting point, not a specification.** Where a step states a PROPERTY, satisfy the property and write the guard yourself. Copying a snippet reproduces its bugs. Test code is the exception — use it exactly.
2. **Every repo fact below carries a `file:line`, verified 2026-08-25.** If a citation does not match what you find, stop and report rather than adapting silently.
3. **A grant is not verified until something has been denied by its absence.** Three grants on this feature shipped looking correct and doing nothing: `grant execute` without a prior `revoke … from public`; two tables with RLS policies and no table grant; and a near miss on a new column. Every task here that adds a privilege must prove it red-then-green.

## Global Constraints

- **Expo SDK 57.** Read `https://docs.expo.dev/versions/v57.0.0/` before writing framework code (`AGENTS.md`).
- **The public storefront is NOT bento.** It renders the shop's own palette from `src/lib/storefront-catalog.ts`. Only admin screens are bento — read `.claude/skills/building-bento-screens/SKILL.md` before touching one.
- **`security definer` functions must `revoke execute … from public` BEFORE granting.** Postgres grants EXECUTE to PUBLIC by default. House convention: `supabase/migrations/20260924000100_storefront_public_read.sql:103-109`.
- **Any new table needs an explicit grant.** There is no `alter default privileges` making it automatic — `supabase/migrations/20260925000100_storefront_table_grants.sql` exists because plan 1 forgot.
- Migrations are `YYYYMMDDHHMMSS_name.sql`; this plan uses the `20260926*` series.
- **Unit tests:** `npm test`. **DB tests:** `npm run test:db` (`--no-reset` while iterating; the local stack is shared with other sessions and they reset it often).
- **Component tests use `react-test-renderer`** with a `textsIn` flattening helper. `@testing-library/react-native` is NOT a dependency. Pattern: `src/components/__tests__/list-card.test.tsx:1-11`.
- Money is `formatCents` (`src/lib/currency.ts:9`) and `toCents` (`:1`). Never a third path; `formatCompactCents` drops cents and is for stat tiles.

## Two facts that shape this plan

**A cart module already exists, and it is not this one.** `src/lib/cart.ts` is the POS cart — `cartTotalCents(lines)` and `buildSalePayload(...)`. The storefront cart is a different thing with a different lifetime (a stranger's browser, no session, no register). **Name yours `src/lib/storefront-cart.ts`** and do not extend or import the POS one. Two carts that look alike and behave differently is exactly the confusion that produces a wrong total.

**This plan adds the first unauthenticated WRITE in the entire application.** Today `anon` holds exactly three grants, all reads (`20260924000100_storefront_public_read.sql:107-109`), and there is no rate limiting anywhere in the repo. Everything in Task 2 follows from that.

## What plans 1 and 2 already provide

| From | Exports / objects |
|---|---|
| `src/lib/storefront.ts` | `getPublicStorefront`, `getPublicStorefrontProducts`, `waLink(e164, message)` |
| `src/lib/storefront-catalog.ts` | `paletteColors`, `WHATSAPP_BUTTON_GREEN`, `WHATSAPP_INK`, `PaletteColors` |
| `src/lib/phone-e164.ts` | `toE164` (strict), `formatE164ForDisplay` |
| `src/components/storefront/product-tile.tsx` | `ProductTile({ product, colors })` — `product-tile.tsx:19` |
| `src/components/storefront/theme-shared.tsx` | `ThemeProps`, `WhatsAppButton`, `EmptyState` |
| DB | `storefronts` (incl. `draft`, `offers_delivery`, `payment_mode`, `published_at`), `storefront_delivery_areas` (`20260924000000_storefront.sql:62-72`), `get_public_delivery_areas` |

**The snapshot pattern to mirror**, from `sale_items` (`supabase/migrations/0001_init.sql:60-68`):

```sql
product_id       uuid references public.products(id) on delete set null,
product_name     text not null,
unit_price_cents integer not null,
quantity         integer not null check (quantity > 0),
line_total_cents integer not null
```

A sale line keeps the name and price it was sold at, and survives the product being deleted. `order_items` must do the same, for the same reason.

## File structure

**Created**

| File | Responsibility |
|---|---|
| `src/lib/storefront-cart.ts` | Cart maths and browser persistence. Pure where possible. |
| `src/lib/storefront-order.ts` | Placing an order, and the WhatsApp order message. |
| `src/components/storefront/cart-sheet.tsx` | The basket. |
| `src/components/storefront/checkout-form.tsx` | Name, phone, collect/deliver, area, landmark, note. |
| `src/components/storefront/order-placed.tsx` | Confirmation with the order number. |
| `src/app/(admin)/orders.tsx` | A read-only list so orders are not invisible. |
| `supabase/migrations/20260926000000_orders.sql` | `orders`, `order_items`, grants. |
| `supabase/migrations/20260926000100_place_order.sql` | The anonymous insert RPC. |
| `supabase/tests/verify-orders.sql` | DB checks. |

**Modified**

| File | Change |
|---|---|
| `src/components/storefront/product-tile.tsx:19` | Gains **Add** and **Ask**. |
| `src/components/storefront/theme-market.tsx:27`, `theme-window.tsx:32` | Cart entry point; responsive columns (see Task 5). |
| `src/lib/storefront.ts` | Reads delivery areas — its first caller. |

---

### Task 1: `orders` and `order_items`

**Files:** Create `supabase/migrations/20260926000000_orders.sql`, `supabase/tests/verify-orders.sql`

**Properties:**

1. `orders` carries: `shop_id`, a per-shop sequential `number`, `customer_name`, `customer_phone` (E.164), `fulfilment` (`collect` | `deliver`), `delivery_area`, `delivery_landmark`, `note`, `payment_mode`, `status`, `subtotal_cents`, `delivery_fee_cents`, `total_cents`, `created_at`. No customer account, no `auth.users` reference — the phone number is the identity.
2. **Every money column and the delivery area name are SNAPSHOTS.** `delivery_fee_cents` is copied at order time, never joined to `storefront_delivery_areas`. An area re-priced next week must not rewrite what this customer agreed to pay. Same reasoning the schema already applies to `payment_mode`.
3. `order_items` mirrors `sale_items` exactly: product reference `on delete set null`, plus `product_name`, `unit_price_cents`, `quantity > 0`, `line_total_cents`.
4. `number` is per-shop and short enough to say on the phone. It is not a UUID; a customer reads it aloud.
5. `status` is CHECK-constrained. Plan 4 owns the transitions; this plan only creates orders, so the initial value and the permitted set must both be explicit.
6. `payment_mode` is copied from the shop's storefront at creation and CHECK-constrained to the same single permitted value as `storefronts.payment_mode`.
7. RLS on both tables: shop members read and write their own. **Plus an explicit table grant to `authenticated`** — RLS does not grant reach, and this repo has no `alter default privileges`.
8. `anon` gets NO table grant. The only anonymous path is Task 2's function.

- [ ] **Step 1: Write the failing checks** in `supabase/tests/verify-orders.sql`, following the DO-block-with-rollback house style of `supabase/tests/verify-storefront.sql`. Assert: the per-shop number increments and does not collide across shops; a negative quantity is rejected; `anon` has no table privilege on either table; `authenticated` has select/insert on both.
- [ ] **Step 2: Run and watch them fail** — `npm run test:db -- --no-reset`
- [ ] **Step 3: Write the migration**, satisfying every property.
- [ ] **Step 4: Prove the grants** — revoke the `authenticated` grant on `orders`, confirm RED, restore, confirm GREEN. Report both.
- [ ] **Step 5: Run and watch them pass**
- [ ] **Step 6: Commit** — `git commit -m "feat(storefront): orders that keep the price the customer agreed to"`

---

### Task 2: The anonymous insert, which is the security surface of this plan

This is the first unauthenticated write in the application. Everything else in this plan is ordinary product work; this task is not.

**Files:** Create `supabase/migrations/20260926000100_place_order.sql`; modify `supabase/tests/verify-orders.sql`

**Interfaces:** Produces `public.place_storefront_order(p_slug text, p_customer jsonb, p_items jsonb) returns jsonb` — returning at minimum the order `number` and the computed total.

**Properties. Each is a defence, and the reasoning matters more than the shape:**

1. **Every total is recomputed server-side from current `products` rows.** The client sends product ids and quantities and NOTHING ELSE about price. A client-supplied price is a discount anyone can grant themselves. The returned total is authoritative; the client displays what the server says.
2. The delivery fee is looked up from `storefront_delivery_areas` by name **at order time**, then written as a snapshot. An unknown area name is rejected, not defaulted to zero.
3. An order is only accepted for a shop whose storefront is **published** and which **has the `storefront` module** — the same triple the public reads enforce (`20260924000100_storefront_public_read.sql`). A de-entitled shop must not take orders.
4. Only products with `is_listed_online` for THAT shop may be ordered. A product id from another shop, or an unlisted one, is rejected — not silently skipped, because a silently shortened order is a customer charged for something they did not receive.
5. **Stock is not reserved and not decremented.** Plan 4 does that on fulfilment. Ordering more than the shop holds is allowed and surfaces to the shop; the alternative lets anyone empty a shop's shelves from a browser.
6. `customer_phone` is normalised to E.164 server-side and rejected if it will not normalise. It is the only way the shop reaches this customer.
7. **Rate limited.** There is no rate limiting anywhere in this repo today, so decide the mechanism deliberately and write down why. Bound it per shop per window; the cheapest honest version is a count over `orders.created_at` for that shop inside the function.
8. `security definer` with `set search_path = public`, an explicit column list on every read, and **`revoke execute … from public` before `grant execute … to anon, authenticated`.**
9. Errors must not leak. A rejected order says what the customer can fix — never a constraint name, a shop id, or whether a slug exists.

- [ ] **Step 1: Write the failing checks.** Cover, at minimum: a client-supplied price is ignored; a product from another shop is rejected; an unlisted product is rejected; an unknown delivery area is rejected; an unpublished shop is rejected; a de-entitled shop is rejected; the rate limit trips; `anon` can call it and `anon` still cannot touch the tables directly.
- [ ] **Step 2: Run and watch them fail**
- [ ] **Step 3: Write the migration**, satisfying every property
- [ ] **Step 4: Prove the grant** — revoke from `anon`, confirm RED, restore, confirm GREEN
- [ ] **Step 5: Run and watch them pass**
- [ ] **Step 6: Commit** — `git commit -m "feat(storefront): take an order from a stranger, safely"`

---

### Task 3: Cart maths and persistence

**Files:** Create `src/lib/storefront-cart.ts`; test `src/lib/__tests__/storefront-cart.test.ts`

**Interfaces:**

```ts
export type CartLine = { productId: string; name: string; unitPriceCents: number; quantity: number };
export type StorefrontCart = { slug: string; lines: CartLine[] };

export function addLine(cart: StorefrontCart, line: Omit<CartLine, 'quantity'>, qty?: number): StorefrontCart;
export function setQuantity(cart: StorefrontCart, productId: string, qty: number): StorefrontCart;
export function cartSubtotalCents(cart: StorefrontCart): number;
export function cartItemCount(cart: StorefrontCart): number;
export function loadCart(slug: string): StorefrontCart;
export function saveCart(cart: StorefrontCart): void;
```

**Properties:**

1. **The cart is keyed by shop slug.** A customer browsing two shops must not merge their baskets.
2. Adding a product already in the cart increases its quantity rather than adding a second line.
3. Setting a quantity to zero removes the line. Quantity is never negative.
4. **Prices in the cart are for display only.** The comment must say so: the server recomputes at checkout, and a stale cart price is a display bug, never a pricing one.
5. Persistence degrades safely. A browser with storage disabled, or a corrupt stored value, yields an empty cart rather than a crash — a customer with a private-mode browser must still be able to shop.

- [ ] **Step 1: Write the failing test** covering all five properties, including a corrupt stored value and a second shop's cart.
- [ ] **Step 2: Run and watch it fail** — `npm test -- storefront-cart`
- [ ] **Step 3: Implement**
- [ ] **Step 4: Run and watch it pass**
- [ ] **Step 5: Commit**

---

### Task 4: The product tile learns to sell

**Files:** Modify `src/components/storefront/product-tile.tsx:19`; test `src/components/__tests__/storefront-product-tile.test.tsx`

**Properties:**

1. Gains **Add** (primary) and **Ask** (secondary). Ask is a `wa.me` link prefilled with the shop and product name — the question channel, unchanged from plan 1.
2. **An out-of-stock product keeps Ask and loses Add.** It is still shown and still marked. The shop may be restocking, and that enquiry is a sale.
3. Existing behaviour must not regress: the no-photo tile still carries the product name as its only label, and a tile with a photo still shows the name once. Those tests exist and must pass unmodified.
4. Colour comes from the palette prop. The only permitted literals remain the in-stock green `#1f7a4d` and out-of-stock amber `#8a5a05`, plus the imported WhatsApp constants.

- [ ] **Step 1: Write the failing test** — Add present in stock, absent out of stock, Ask always present; the two plan-1 tests still pass unmodified.
- [ ] **Step 2: Run and watch it fail**
- [ ] **Step 3: Implement**
- [ ] **Step 4: Run the FULL suite** — a regression here breaks a merged, browser-verified page.
- [ ] **Step 5: Commit**

---

### Task 5: The cart sheet, and responsive columns

**Files:** Create `src/components/storefront/cart-sheet.tsx`; modify `theme-market.tsx:27`, `theme-window.tsx:32`; test `src/components/__tests__/storefront-cart-sheet.test.tsx`

**Properties:**

1. Line items with a quantity stepper, a subtotal, and a plain sentence that nothing is charged now.
2. **Delivery is not shown in the cart.** It cannot be known until an area is chosen. Saying so is better than showing a total that changes at checkout.
3. Every theme gets a cart entry point showing the item count.
4. **Fold in a deferred item:** `numColumns={2}` is hardcoded in both grid themes. Correct on the 390px phone plan 1 verified at; on a laptop the tiles are oversized with large empty areas. Make the column count responsive to width. This is folded in here because this task already edits both files.

- [ ] **Step 1: Write the failing test**
- [ ] **Step 2: Run and watch it fail**
- [ ] **Step 3: Implement**
- [ ] **Step 4: Run and watch it pass**
- [ ] **Step 5: Commit**

---

### Task 6: Checkout

**Files:** Create `src/components/storefront/checkout-form.tsx`; modify `src/lib/storefront.ts`; test `src/components/__tests__/storefront-checkout-form.test.tsx`

**Properties:**

1. Name and phone are required. Phone stores `toE164` and displays `formatE164ForDisplay`; a number that will not normalise is rejected with an explanation, never stored raw.
2. **Collect or deliver.** With delivery chosen, the customer picks an area from the shop's own list and gives a landmark. Hargeisa addresses are landmarks, not street numbers — a free-text address gives a rider nothing usable.
3. **The area's fee appears the moment the area is chosen**, and the total breaks out as goods, delivery, total. A customer must never meet a number at the door they did not agree to.
4. If the shop does not offer delivery, or lists no areas, checkout is **collection-only** and no area fields render at all.
5. **This is the first caller of `get_public_delivery_areas`.** It has had none since plan 1. Add the reader to `src/lib/storefront.ts` beside its siblings.
6. A plain sentence states payment is on collection or delivery.

- [ ] **Step 1: Write the failing test** covering all six
- [ ] **Step 2: Run and watch it fail**
- [ ] **Step 3: Implement**
- [ ] **Step 4: Run and watch it pass**
- [ ] **Step 5: Commit**

---

### Task 7: Placing the order, and the WhatsApp path

**Files:** Create `src/lib/storefront-order.ts`, `src/components/storefront/order-placed.tsx`; test `src/lib/__tests__/storefront-order.test.ts`

**Properties:**

1. `placeOrder` calls Task 2's RPC and returns the server's order number and total. **The client never computes the total it displays** — it shows what the server returned.
2. **Both buttons write the same order.** "Place order" creates it. "Send this order on WhatsApp" creates it *and then* opens `wa.me` prefilled with the order number and every line. A WhatsApp checkout that only opens a chat produces sales the app cannot see — the exact fragmentation the storefront exists to end. If the customer never sends the message, the order still exists.
3. The order message is built by a pure, testable function: shop name, order number, each line with quantity and price, delivery line if any, total, and how the customer will pay. Test it against a known order.
4. On success the cart for that slug is cleared, and only then.
5. A failed placement keeps the cart and says what to do. Losing a basket to a flaky connection loses the sale.
6. The confirmation shows the short order number, what happens next, and the amount to pay. No account, no tracking page.

- [ ] **Step 1: Write the failing test** for the message builder and the cart-clearing rule
- [ ] **Step 2: Run and watch it fail**
- [ ] **Step 3: Implement**
- [ ] **Step 4: Run and watch it pass**
- [ ] **Step 5: Commit**

---

### Task 8: Wire it into the public page

**Files:** Modify `src/app/s/[slug].tsx`, the three themes; test `src/__tests__/storefront-route.test.tsx`

**Properties:**

1. Browse → cart → checkout → confirmation, without leaving the page. No route change means no lost cart on a flaky connection.
2. **The `missing` state is untouched.** A draft shop, an unknown slug and a failed read stay byte-identical, and no document head is rendered for them. This is the anti-enumeration property the whole route is built around — plan 1 verified it in a browser; do not regress it.
3. The cart survives a reload of the same shop's page.
4. A shop with no WhatsApp number still takes orders; only Ask disappears.

- [ ] **Step 1: Write the failing test**, including one asserting the `missing` state is unchanged
- [ ] **Step 2: Run and watch it fail**
- [ ] **Step 3: Implement**
- [ ] **Step 4: Run the FULL suite**
- [ ] **Step 5: Commit**

---

### Task 9: Orders must not be invisible

Plan 4 owns the inbox and fulfilment. But an order that lands in a table no one can see is a lost sale, and this plan must leave working software.

**Files:** Create `src/app/(admin)/orders.tsx`; modify `src/lib/storefront-admin.ts`, `src/components/settings/settings-sidebar.tsx`

**Properties:**

1. A read-only list: number, customer, items, collect-or-deliver with area, total, when. **This is bento** — grey page, borderless cards, tokens only. A ledger is read down a column, so it is a full-width `DataTable` outside the grid, not a `BentoCell`.
2. **Unconfirmed order value is never presented as revenue.** An order is a customer's intention; a sale is a thing that happened. Nothing here touches the ledger.
3. Gated on the `storefront` module, like the editor entry (`settings-sidebar.tsx`, `NavItem.module`).
4. No state transitions, no buttons that change anything. Plan 4 adds those.

- [ ] **Step 1: Write the failing test**
- [ ] **Step 2: Run and watch it fail**
- [ ] **Step 3: Implement**
- [ ] **Step 4: Run and watch it pass**
- [ ] **Step 5: Commit**

---

### Task 10: Browser verification

**Not optional.** Three defects have now shipped through a fully green suite and been caught only by opening a browser: a product name printed twice, a missing page title that made a shared link preview as the kaiibi app, and a Web address field showing a path where only a subdomain resolves. Tests do not see any of that.

Use `.superpowers/sdd/reseed.sh`, run `npx expo start --web`, and check at **390px and 1280px**:

- [ ] Add two products, change a quantity, remove one. The count and subtotal follow.
- [ ] The cart survives a page reload, and a second shop's cart stays separate.
- [ ] Checkout with **collect**: no area fields appear at all.
- [ ] Checkout with **delivery**: the fee appears when the area is picked and the total breaks out as goods, delivery, total.
- [ ] Place an order. Confirm in the database that the totals were computed **server-side** and that `delivery_fee_cents` and every `order_items` price are snapshots.
- [ ] **Try to cheat.** Call the RPC directly with a tampered price and confirm the stored total ignores it.
- [ ] Send an order by WhatsApp; confirm the order exists in the database *and* the chat opens with the number and lines.
- [ ] The order appears in the admin Orders list.
- [ ] An out-of-stock product offers Ask and not Add.
- [ ] The unpublished/unknown page is still byte-identical.
- [ ] At 1280px the product grid no longer shows two oversized columns.
- [ ] Screenshot each and attach to the PR.

---

## Done when

- `npm test`, `npm run test:db` and `npx tsc --noEmit` all pass.
- A customer can order from a published shop without an account.
- A tampered price changes nothing about what is stored.
- The shop can see the order.

## Not in this plan

| Left out | Why |
|---|---|
| Order inbox, state transitions, fulfilment | Plan 4. Task 9 gives visibility only. |
| `4300 Delivery Income` and the ledger posting | Plan 4, when a fulfilled order becomes a `sale`. The chart of accounts has 4000/4100/4200 and nothing for delivery (`20260904000100_chart_of_accounts.sql:90-92`). |
| Online payment | `payment_mode` still has one permitted value. |
| Customer accounts, order tracking | A number and a phone call. |
| Stock reservation | Deliberate — see Task 2, property 5. |
| Drafting delivery-area edits | They get their first reader here (Task 6). Whether edits should be drafted is worth deciding once a fee can charge someone — but it is a change to plan 2's editor, so it belongs with plan 4's schema work, not mid-cart. |
