# Orders Part 2 — `amend_order`

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A shop can change an order — reduce it to what is on the shelf, drop a line the customer no longer wants, fix a mistyped phone number — instead of its only move being to cancel the whole thing.

**Architecture:** One `security definer` RPC, `amend_order`, is the sole writer; `authenticated` has no write privilege on `orders`. It re-prices from current product prices (mandatory, see constraint 2), records a before/after row in a new `order_amendments` table, and requires an internal reason. The detail sheet gains an amend mode and turns today's shortfall dead end into three named choices.

**Tech Stack:** Postgres (Supabase migration), TypeScript, React Native / Expo SDK 57, Jest.

**Spec:** [`../specs/2026-08-29-orders-amend-and-share-design.md`](../specs/2026-08-29-orders-amend-and-share-design.md) — Part 2.
**Handoff:** [`../HANDOFF-2026-08-30-orders-parts-2-to-4.md`](../HANDOFF-2026-08-30-orders-parts-2-to-4.md) — **read it before Task 1.**
**Mockup:** [`../../design/orders-redesign-mockup.html`](../../design/orders-redesign-mockup.html) — tab *Amend & partial fill*.

---

## Global Constraints

**All facts below were verified against live code on 2026-08-30. Re-verify anyway** — both prior plans in this series cited line numbers that had already moved, and one sent an implementer six migrations backwards.

### The one that would sink this feature

- **A DEFAULT IS NOT AN ENFORCEMENT.** `amend_order` will be granted to `authenticated` and exposed over PostgREST, so **every parameter it declares is a field any caller can send**. Part 0 shipped a `p_require_register boolean default true` on `complete_sale` and it was defeated by one extra JSON field — `=> false` *and* `=> null`, the latter because `if NULL and …` is NULL so the guard never fired at all. See `20261011000000_the_register_guard_is_not_a_parameter.sql`'s header.
  **Therefore: no parameter of `amend_order` may decide who is allowed to do what.** Authorization is `is_shop_member` + `shop_has_module` + a permission check, read from the session, never from an argument.

### Verified schema facts

- **`authenticated` cannot write `orders` or `order_items`** — `20260928000300_orders_write_lockdown.sql:100` revokes `insert, update, delete` on both. Every change goes through a `security definer` RPC. There is currently **no** amend/edit RPC of any kind (verified by grep).
- **Four constraints an amend must satisfy**, all in `20260926000050_orders.sql` unless noted:
  - `orders_delivery_matches_fulfilment` — collect ⇒ `delivery_area is null` **and** `delivery_fee_cents = 0`; deliver ⇒ `delivery_area is not null`.
  - `orders_total_is_subtotal_plus_delivery` — `total_cents = subtotal_cents + delivery_fee_cents`, exactly.
  - `orders_cancellation_reason_required` (`20260928000100:81`).
  - `orders_sale_only_when_completed` (`20260928000200:148`).
  - Column checks: `subtotal_cents >= 0`, `delivery_fee_cents >= 0`, `total_cents >= 0`, and `order_items.quantity > 0`.
- **`complete_sale` prices from TODAY's `products.price_cents` and ignores the snapshot it is passed** (`20260908000300:363`). `complete_storefront_order` pays `v_order.subtotal_cents`; when the two disagree it raises `order_total_changed`. **So an amend that recomputes from the frozen checkout snapshot builds an order that can never complete.** Re-pricing at current prices is mandatory, not a preference.
- **A line whose product was deleted** has `order_items.product_id = null` (`on delete set null`). `complete_storefront_order` refuses such an order with `order_product_deleted`. An amend may therefore only **remove** such a line, never keep or re-quantity it.
- **`cancellation_reason` is enforced twice** — by the trigger and by a table CHECK. That belt-and-braces pattern is what the amendment reason copies.

### Permissions — a decision this plan must make, not defer

There is **no `orders.*` or `storefront.*` permission**. The full list is in `src/lib/permissions.ts:52-98`. `/orders` is gated on `settings.access`; completing an order additionally needs `pos.access`; and `transition_order` checks **only** `is_shop_member` + the module gate, so *cancelling an order currently needs no permission at all*.

**Recommendation, to be confirmed in Task 1:** gate `amend_order` on **`sales.edit`** — it is the nearest existing analogue ("Edit or delete a past sale"), an amend changes what the customer owes, and inventing an `orders.amend` permission would need a roles migration and a settings UI that this part does not include. **Do not invent a new permission key.** If `sales.edit` proves wrong, say why and use `settings.access` rather than adding one.

### House rules that bind every task

- **A migration reproduces its functions whole.** Derive the newest definition **per function, never per file**, with a grep matching **both** creation forms (a function whose return type changes is dropped and re-created, so `create or replace` alone misses it):
  ```bash
  grep -n "function public.<name>" supabase/migrations/*.sql | grep -vE "grant|revoke|drop"
  ```
- **`revoke execute … from public` before `grant … to authenticated`.** Postgres grants EXECUTE to PUBLIC on every new function, so a grant alone is a no-op dressed as a decision.
- **`supabase/tests/accumulated-rpc-edits.test.ts` is a JEST test** that pins RPC bodies against silent reverts. Any task touching a migration must run `npx jest supabase/tests/accumulated-rpc-edits.test.ts`.
- **`npm run test:db` decides pass/fail by grepping the whole output for `ALL CHECKS PASSED`** (`run-all.sh:82`). A `raise notice 'FAIL …'` fails nothing. New checks must `raise exception`, and the verdict string must sit after every check. **Prove a new check can fail**: mutate it and confirm the *script name* appears in the `FAILED:` list.
- **No `seed.sql`.** Every check builds its own fixture and restores what it mutates. A `SKIP` branch that can pass having tested nothing is a defect.
- **No `@testing-library/react-native`.** Component tests use `react-test-renderer` and assert on **props of components found by type**; there is no `fireEvent` — call the prop handler directly.
- **A fixture whose values do not DISCRIMINATE makes a test decorative.** Seven tests that could not fail were found in Part 1, every one by mutation. **Run a mutation pass on every task**; a mutation that stays green is itself a finding to report.
- **Bento tokens only, no hex literals**, in `order-detail.tsx`. `Caveat tone="wrong"` needs an action or a dismiss.
- **Screens do no arithmetic** — any new sum belongs in a pure module with unit tests.
- **Expo docs are versioned**: `https://docs.expo.dev/versions/v57.0.0/`.

### Out of scope, deliberately

- **`split_order`** — Part 4, optional. This part's "Split the order" button may be drawn **disabled with a note**, or omitted; do not build the RPC.
- **The share link** — Part 3. `amend_order` records a `customer_note` for it to display later, but nothing here sends anything.
- **Batching `checkOrderFulfilment`** — tempting (Part 1 left ~3 queries per open row on the table), but it is a separate RPC with its own test surface. If you do it, it is its own task and its own commit; do not fold it into `amend_order`.

---

## File Structure

| File | Responsibility |
|---|---|
| `supabase/migrations/2026<TBD>_an_order_can_be_amended.sql` | **Create.** `order_amendments` table; `amend_order` RPC; grants. Number it after the newest migration at the time you write it — check `ls supabase/migrations \| tail -1`. |
| `supabase/tests/verify-order-amendments.sql` | **Create.** Its own file, so `run-all.sh` reports it by name. Own fixture, own verdict string at the end. |
| `src/lib/storefront-admin.ts` | **Modify.** `amendOrder()`, `OrderAmendment` type, and the typed error mapping in `orderErrorMessage`. |
| `src/components/orders/order-detail.tsx` | **Modify.** Amend mode, the delta panel, the two reason fields, and the three-way shortfall choice. |
| `src/components/orders/__tests__/order-detail.test.tsx` | **Modify.** |
| `src/lib/__tests__/storefront-admin.test.ts` | **Modify.** |

**Task order: 1 → 2 → 3.** Task 1 is the whole feature; 2 and 3 expose it.

---

### Task 1: the migration — `order_amendments` and `amend_order`

**Files:**
- Create: the migration (name it after the newest existing one)
- Create: `supabase/tests/verify-order-amendments.sql`

**Interfaces produced** — Tasks 2 and 3 rely on exactly this:
```sql
amend_order(
  p_order_id      uuid,
  p_lines         jsonb,   -- [{product_id uuid, quantity int}] the order as it should now stand
  p_reason        text,    -- REQUIRED, internal, never shown to a customer
  p_customer_note text default null,   -- optional, the only prose a customer may see
  p_fulfilment    jsonb default null,  -- {fulfilment, delivery_area, delivery_landmark}
  p_contact       jsonb default null   -- {customer_name, customer_phone}
) returns public.orders
```

- [ ] **Step 1: Confirm the permission decision before writing anything**

Read `src/lib/permissions.ts:52-98` and `has_shop_permission`'s usage in an existing RPC (e.g. `complete_sale`). Confirm `sales.edit` exists and is the right gate, or make the documented fallback choice. **Write the reasoning into the migration header** — the next reader must not have to re-derive it.

- [ ] **Step 2: Write the failing checks**

Create `supabase/tests/verify-order-amendments.sql`. It builds its own shop, product, storefront and order (there is no `seed.sql`), and every failure `raise exception`s rather than `raise notice`s. Put the verdict string in the **last** block. Cover at least:

1. Amending a `pending` order rewrites its lines and returns the new row.
2. Amending an `accepted` order succeeds.
3. Amending a `completed` order raises `order_not_amendable`.
4. Amending a `cancelled` order raises `order_not_amendable`.
5. **A blank or whitespace reason raises `amendment_reason_required`.**
6. **The amended order still satisfies `orders_total_is_subtotal_plus_delivery`** — read the row back and assert `total = subtotal + fee` arithmetically, not by trusting the constraint to have fired.
7. **Re-pricing happens:** change `products.price_cents` after the order is placed, amend, and assert the new `subtotal_cents` reflects **today's** price, not the snapshot.
8. **The amended order can still be completed.** Amend, then call `complete_storefront_order`, and assert it does **not** raise `order_total_changed`. *This is the check the whole design exists to satisfy — if it fails, the re-pricing is wrong.*
9. Reducing every line to zero raises `order_has_no_items`, not an empty order.
10. A line whose `product_id` is null may be removed, but keeping it raises `order_product_deleted`.
11. **`deliver → collect` zeroes both the fee and the area**, satisfying `orders_delivery_matches_fulfilment`.
12. A non-member calling it raises. A member without the chosen permission raises.
13. **An `order_amendments` row is written**, carrying the reason and a before/after that differ.
14. **`authenticated` still cannot write `orders` or `order_items` directly** — the lockdown is intact.

- [ ] **Step 3: Run them and watch them fail**
```bash
npm run test:db 2>&1 | grep -iE "amend|FAILED:"
```
Expected: `verify-order-amendments` named in the `FAILED:` list, because `amend_order` does not exist.

- [ ] **Step 4: Write the migration**

**Header must argue, not describe.** State: why an amend is an RPC and not a client write (the lockdown); why re-pricing is mandatory (constraint 2 above — cite `20260908000300:363` and `order_total_changed`); why the reason is required and enforced twice, naming `orders_cancellation_reason_required` as the precedent; why the permission chosen is the right one; and **why no parameter decides authorization**, citing `20261011000000`'s header.

```sql
create table public.order_amendments (
  id            uuid primary key default gen_random_uuid(),
  order_id      uuid not null references public.orders(id) on delete cascade,
  amended_at    timestamptz not null default now(),
  amended_by    uuid not null,
  -- INTERNAL. Written for the shop, read by the shop, weeks later. Real ones
  -- are blunt. This must never reach a customer -- Part 3 shows the link, and
  -- it shows customer_note, never this.
  reason        text not null,
  customer_note text,
  before        jsonb not null,
  after         jsonb not null,
  constraint order_amendments_reason_required check (btrim(reason) <> '')
);

alter table public.order_amendments enable row level security;
-- Readable by the shop that owns the order; written ONLY by amend_order as
-- the table's owner. Follow storefront_order_completions' posture
-- (20260928000500) for the write side.
revoke insert, update, delete on public.order_amendments from anon, authenticated;
```

`amend_order` itself, in order: lock the order `for update`; `is_shop_member`; `shop_has_module(..., 'storefront')`; the permission check; refuse `completed`/`cancelled` with `order_not_amendable`; require a trimmed reason; rebuild `order_items` from `p_lines` **priced from `products.price_cents` today**; recompute `subtotal_cents`, then `total_cents = subtotal + fee`; apply the optional fulfilment and contact changes, zeroing the fee and area on a switch to collect; refuse an empty result with `order_has_no_items`; write the `order_amendments` row; return the order.

**Typed errors, because a shopkeeper reads these.** Raise `amendment_reason_required`, `order_not_amendable`, `order_has_no_items`, `order_product_deleted` with `errcode = 'P0001'` — the shape `complete_storefront_order` already uses so `orderErrorMessage` can map them.

Grants at the foot: revoke from `public`, grant to `authenticated`, **never `anon`** — a customer does not amend their own order.

- [ ] **Step 5: Run the checks**
```bash
npm run test:db 2>&1 | tail -5
npx jest supabase/tests/accumulated-rpc-edits.test.ts
```
Expected: zero `FAILED:`, and the pin test green.

- [ ] **Step 6: Mutation pass**

| # | Mutation | Must redden |
|---|---|---|
| M1 | Price lines from the snapshot instead of `products.price_cents` | check 7 **and** check 8 |
| M2 | Drop the trimmed-reason check | check 5 |
| M3 | Allow amending a `completed` order | check 3 |
| M4 | Skip the permission check | check 12 |
| M5 | Set `total_cents = subtotal_cents` (forget the fee) | check 6 |
| M6 | Skip writing the `order_amendments` row | check 13 |

Then **prove the file can fail at all**: mutate one check and confirm `verify-order-amendments` appears in the `FAILED:` list. A mutation that stays green is a finding to report.

- [ ] **Step 7: Commit** with a message that leads with why re-pricing is mandatory.

---

### Task 2: the client layer

**Files:** `src/lib/storefront-admin.ts`, `src/lib/__tests__/storefront-admin.test.ts`

**Interfaces produced:**
```ts
export type OrderAmendmentLine = { productId: string; quantity: number };
export async function amendOrder(
  orderId: string,
  lines: OrderAmendmentLine[],
  reason: string,
  customerNote?: string | null,
  fulfilment?: { fulfilment: 'collect' | 'deliver'; deliveryArea: string | null; deliveryLandmark: string | null } | null,
  contact?: { customerName: string; customerPhone: string } | null,
): Promise<ShopOrder>;
```

- [ ] **Step 1: Write the failing tests** — the RPC is called with the right argument names; the returned row maps through the existing `mapOrderRow`; and **each typed error maps to a sentence a shopkeeper can act on**. Extend `orderErrorMessage` for `amendment_reason_required`, `order_not_amendable`, `order_has_no_items`, `order_product_deleted`. Follow how the existing order errors are mapped and tested.
- [ ] **Step 2: Run, watch fail. Step 3: Implement. Step 4: `npx jest src/lib && npx tsc --noEmit`.**
- [ ] **Step 5: Mutation pass** — swap two RPC argument names; drop one error mapping. Both must redden.
- [ ] **Step 6: Commit.**

---

### Task 3: the amend sheet and the three-way shortfall choice

**Files:** `src/components/orders/order-detail.tsx`, its test file.
**Mockup:** *Amend & partial fill* tab — frames 1 and 2.

Today a shortfall dead-ends: *"Source more stock, or cancel it below."* It becomes three buttons that each say what they do:

| Button | Effect |
|---|---|
| **Reduce to what I have** | Amend down. The short line is dropped; the remainder is gone. |
| **Split the order** | **Part 4. Draw it disabled with a one-line note, or omit it. Do not build it.** |
| **Cancel order** | Unchanged — the existing flow, which already requires a reason. |

The amend form needs: per-line quantity control, a remove affordance, the two reason fields **visibly separated** (one labelled as internal and never shown to the customer, one as the customer's message), and **the delta panel**.

**The delta panel is not decoration — it is the whole honesty of the feature.** Re-pricing is mandatory, so an amend can change what the customer owes without anyone asking them. Showing "was $128.00, now $110.00 — Basmati rice re-priced at today's $25.50" before saving is what turns a silent re-price into a sentence the shop can say on the phone.

- [ ] **Step 1: Write the failing tests.** No `@testing-library`; use `react-test-renderer`, assert on props. Cover: the three buttons appear on a shortfall; **Save is disabled while the reason is blank**; the delta panel shows both old and new totals; the internal reason is not rendered anywhere a customer-facing string is built; and amend mode does not render for a `completed` or `cancelled` order.
- [ ] **Step 2-4:** run, watch fail, implement, `npx jest src/components/orders && npx tsc --noEmit`.
- [ ] **Step 5: Mutation pass** — allow saving with a blank reason; show the internal reason in the customer note field; render amend mode for a completed order; show the new total but not the old. Each must redden.
- [ ] **Step 6: Commit.**

---

## Verification of the whole part

- [ ] `npm run test:db` — zero `FAILED:`.
- [ ] `npm test && npx tsc --noEmit && npm run lint` — lint no worse than the baseline you measured at the start.
- [ ] **On a device**, per `/testing-kaiibi`. **Sign in as `yusef@gmail.com` / `yusef1`** — that shop exists to be written to. Walk it:
  1. Place a storefront order, oversell a product so a shortfall appears.
  2. Amend it down. Read the delta panel before saving; confirm the new total is what the row and the sheet then show.
  3. **Complete the amended order** and confirm it does not fail with `order_total_changed`. This is the one that matters.
  4. Confirm the internal reason appears nowhere a customer would see.

## Open questions this part must answer

1. **May an amend ADD a product the customer never ordered?** The spec draws it as allowed. "We substituted something" is a materially different conversation from "we sent you less", and it may deserve refusing outright. **Decide in Task 1 and write the reasoning into the migration header.**
2. **Which permission** — `sales.edit` is the recommendation; confirm or document the fallback.
3. **Should `transition_order`'s permission-free cancel be raised to match?** An amend that needs `sales.edit` while a *cancel* needs nothing is an odd pair. Out of scope to change here, but say what you think.
