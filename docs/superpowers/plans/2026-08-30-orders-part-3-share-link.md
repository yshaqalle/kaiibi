# Orders Part 3 — the customer's link

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A customer who ordered can open one link and see where their order is, what it costs, and where to collect it — and, when the shop has amended it, agree to the change without phoning anyone.

**Architecture:** Two `security definer` RPCs on the anonymous surface, keyed on a capability token the shop hands out: `get_public_order` (read) and `confirm_public_order` (a write that can only ever *agree*). The token is minted by `place_storefront_order`, which already returns jsonb. The URL is derived from `storefront-host.ts`, never assembled, and the route file is named from the same constant.

**Tech Stack:** Postgres (Supabase migration), TypeScript, React Native / Expo SDK 57, Expo Router, Jest.

**Spec:** [`../specs/2026-08-29-orders-amend-and-share-design.md`](../specs/2026-08-29-orders-amend-and-share-design.md) — Part 3.

---

## ⚠️ Part 2 is a hard prerequisite

`get_public_order` returns the latest amendment's `before`/`after` diff, and that comes from
`public.order_amendments` — created by `20261012000000_an_order_can_be_amended.sql`, which is on
**PR #114 and not yet merged**. A worktree branched from `origin/main` does **not** have it.

**Before Task 1:** confirm the table exists, and branch from a base that has it.

```bash
grep -rl "create table public.order_amendments" supabase/migrations/ || echo "MISSING — merge PR #114 first"
```

If it is missing, stop. Every other task can be built without it; Task 4 cannot.

---

## Global Constraints

**Every fact below was verified against live code on 2026-08-30.** Three plans in this series have
now shipped citations that had already moved — including Part 2's, whose central premise was two
migrations out of date and inverted the design. **Re-verify anyway.**

### The one that would sink this feature

- **A LINK THAT LEAKS MUST NOT BE ABLE TO HARM AN ORDER.** An order link is sent over WhatsApp and
  lives in a customer's chat history forever; it will be forwarded, screenshotted and pasted into
  group chats. `confirm_public_order` therefore stamps `customer_confirmed_at` **and nothing else**
  — it cannot alter a line, a total, a status, or cancel anything. "Something's wrong" writes
  **nothing at all**; it opens WhatsApp. The destructive path stays in the human channel where it
  already lives.
- **A DEFAULT IS NOT AN ENFORCEMENT, and neither is a parameter.** `20261011000000`'s header records
  what a parameter that decides authorization costs: `p_require_register boolean default true` on
  `complete_sale` was defeated by one extra JSON field (`=> false`, and `=> null` too, because
  `if NULL and …` is NULL so the guard never fired). These two RPCs are granted to `anon`, so
  **every parameter they declare is a field any stranger on the internet can send.** The token is
  the *only* thing that may decide what a caller sees. No `p_shop_id`, no `p_order_id`, no
  `p_include_internal`.

### Verified schema and code facts

| Claim | Verified at |
|---|---|
| `place_storefront_order` **already `returns jsonb`** with a fixed key set | `20260927000000:210`, `:471-482` |
| …so adding `share_token` is **one more key**, not a signature change — no drop-and-recreate | same |
| The anon RPC surface is **exactly four functions** | `get_public_storefront`, `get_public_storefront_products`, `get_public_delivery_areas`, `place_storefront_order` |
| `pgcrypto` is installed, so `gen_random_bytes` is available | `select extname from pg_extension` |
| `storefront-host.ts` exports `APP_DOMAIN`, `STOREFRONT_SEGMENT`, `LEGACY_STOREFRONT_SEGMENT`, `storefrontPath`, `storefrontAddress`, `STOREFRONT_ADDRESS_PREFIX`, `slugFromHostname` | `src/lib/storefront-host.ts:18-76` |
| `vercel.json` rewrites `/(.*)` → `/index.html`, so **no hosting change is needed** | `vercel.json` |
| `src/app/s/[slug].tsx` exists as the legacy-redirect precedent | on disk |
| `orders` has **no** `share_token`, `share_expires_at` or `customer_confirmed_at` today | grep, zero hits |
| `authenticated` cannot write `orders`/`order_items` | `20260928000300:100` |

**The spec is wrong about one thing:** it describes the "Awaiting customer" chip as reading
`amended_at`, and implies that lives on `orders`. It does not — it is a column on
`public.order_amendments` (Part 2). Task 7 reads the latest amendment for the order.

### House rules that bind every task

- **A migration reproduces its functions whole.** Derive the newest definition **per function,
  never per file**, matching both creation forms:
  ```bash
  grep -n "function public.<name>" supabase/migrations/*.sql | grep -vE "grant|revoke|drop"
  ```
  `place_storefront_order`'s newest definition is in `20260927000000_place_order.sql` — **verify
  that is still true** before copying it forward.
- **`revoke execute … from public` BEFORE `grant … to anon`.** Postgres grants EXECUTE to PUBLIC on
  every new function, and on a `security definer` function that means anon can already call it. A
  grant alone is "a no-op dressed as a decision" — `20260927000000:499`'s own words.
- **`supabase/tests/accumulated-rpc-edits.test.ts` is a JEST test.** Any task touching a migration
  runs `npx jest supabase/tests/accumulated-rpc-edits.test.ts`.
- **`npm run test:db` greps the whole output for `ALL CHECKS PASSED`** (`run-all.sh:82`). A
  `raise notice 'FAIL …'` fails nothing. New checks must `raise exception`, and the verdict string
  must sit after every check. **Prove a new check can fail** by mutating it.
- **No `seed.sql`.** Every check builds its own fixture.
- **No `@testing-library/react-native`.** `react-test-renderer`, asserting on **props of components
  found by type**; no `fireEvent` — call the prop handler directly.
- **A fixture whose values do not DISCRIMINATE makes a test decorative.** Part 1 found seven such
  tests, Part 2 found three more — one asserted `toContain('$80.00')` against a figure that also
  appeared elsewhere on the same screen. **Run a mutation pass on every task.** A mutation that
  stays green is itself a finding to report.
- **The customer's page is NOT bento.** Bento tokens are for admin screens. Storefront components
  take a `PaletteColors` prop — read `.claude/skills/building-bento-screens/SKILL.md` and follow
  `src/app/store/` for the customer-facing palette.
- **Screens do no arithmetic.**
- **Expo docs are versioned:** `https://docs.expo.dev/versions/v57.0.0/`.

### Out of scope, deliberately

- **`split_order`** — Part 4.
- **Settling path-vs-subdomain.** That is options A/B/C in
  `docs/backlog/2026-08-27-storefront-wildcard-dns.md`. Deriving from `APP_DOMAIN` is what makes
  settling it later a one-file change.
- **Push/SMS/email notification.** Nothing here sends anything; the shop copies a link.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/lib/storefront-host.ts` | **Modify.** `ORDER_SEGMENT`, `orderPath(token)`, `orderAddress(token)`. |
| `src/lib/__tests__/storefront-host.test.ts` | **Modify.** The collapse-to-one-string test. |
| `supabase/migrations/<next>_an_order_carries_its_own_link.sql` | **Create.** Columns, token minting, `place_storefront_order` copied forward whole. |
| `supabase/migrations/<next+1>_a_customer_can_read_their_order.sql` | **Create.** `get_public_order`, `confirm_public_order`, grants. |
| `supabase/tests/verify-public-order.sql` | **Create.** Own fixture, own verdict string. |
| `src/lib/public-order.ts` | **Create.** `getPublicOrder`, `confirmPublicOrder`, the row→type mapping. |
| `src/lib/__tests__/public-order.test.ts` | **Create.** |
| `src/app/o/[token].tsx` | **Create.** The customer's page. Directory name comes from `ORDER_SEGMENT`. |
| `src/components/orders/order-detail.tsx` | **Modify.** Copy-link affordance. |
| `src/app/(admin)/orders.tsx` | **Modify.** "Awaiting customer" chip. |

**Task order: 1 → 2 → 3 → 4 → 5 → 6 → 7.**

---

### Task 1: the URL is derived, never assembled

**Files:** `src/lib/storefront-host.ts`, `src/lib/__tests__/storefront-host.test.ts`

**Interfaces produced:**
```ts
export const ORDER_SEGMENT = 'o';
export function orderPath(token: string): string;     // '/o/<token>'
export function orderAddress(token: string): string;  // 'kaiibi.com/o/<token>'
```

#108 (`9f23ae9`) fixed exactly the defect this task would otherwise recreate: two surfaces each
hand-built `<slug>.kaiibi.com`, for which **no wildcard DNS record was ever created**, so shops
copied an address that gave customers a DNS failure. The fix made `storefront-host.ts` the single
source. This adds the sibling pair for orders.

Its post-mortem also names *why the old tests missed it*: they pinned each surface to its own
literal, so **all of them could be wrong together**. The test below asserts every surface
**collapses to one string**, and that the string **resolves to a route file on disk**.

- [ ] **Step 1: Write the failing test**

```ts
import fs from 'node:fs';
import path from 'node:path';
import { APP_DOMAIN, ORDER_SEGMENT, orderAddress, orderPath } from '@/lib/storefront-host';

const TOKEN = 'a1b2c3d4e5f6g7h8j9k0mnpqrs';

it('builds the path from ORDER_SEGMENT, not from a literal', () => {
  expect(orderPath(TOKEN)).toBe(`/${ORDER_SEGMENT}/${TOKEN}`);
});

it('builds the address from APP_DOMAIN, so settling path-vs-subdomain is one file', () => {
  expect(orderAddress(TOKEN)).toBe(`${APP_DOMAIN}/${ORDER_SEGMENT}/${TOKEN}`);
  expect(orderAddress(TOKEN)).toContain(orderPath(TOKEN));
});

// The assertion #108 wishes it had had: the address a shop copies and the file
// that serves it cannot drift, because the second is looked up FROM the first.
it('resolves to a route file that actually exists on disk', () => {
  const routeDir = path.join(process.cwd(), 'src', 'app', ORDER_SEGMENT);
  expect(fs.existsSync(routeDir)).toBe(true);
  expect(fs.readdirSync(routeDir)).toContain('[token].tsx');
});

it('percent-encodes a token that somehow contains a URL-significant character', () => {
  expect(orderPath('a/b')).toBe(`/${ORDER_SEGMENT}/a%2Fb`);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx jest src/lib/__tests__/storefront-host.test.ts`
Expected: FAIL — `orderPath is not a function`. The route-file test also fails; it passes at Task 6.

- [ ] **Step 3: Implement**

```ts
// The customer's order link. A sibling of STOREFRONT_SEGMENT, and short on
// purpose: this gets read aloud over a phone and typed by hand.
//
// The route directory src/app/o/ is named FROM this constant, and
// storefront-host.test.ts asserts the file exists -- so the address a shop
// copies and the thing that serves it cannot drift. That is the assertion #108
// wishes it had had: its tests pinned each surface to its own literal, so all
// of them could be (and were) wrong together.
export const ORDER_SEGMENT = 'o';

export function orderPath(token: string): string {
  return `/${ORDER_SEGMENT}/${encodeURIComponent(token)}`;
}

export function orderAddress(token: string): string {
  return `${APP_DOMAIN}${orderPath(token)}`;
}
```

- [ ] **Step 4: Run again**

Run: `npx jest src/lib/__tests__/storefront-host.test.ts`
Expected: all pass except the route-file test, which is red until Task 6. **Leave it red and say so
in the commit** — a test that passes before the thing it tests exists is worse than one that fails.

- [ ] **Step 5: Mutation pass** — hard-code `'/o/' + token` in `orderPath` (must redden the
      ORDER_SEGMENT test); return `APP_DOMAIN + '/o/' + token` from `orderAddress` (must redden the
      `toContain(orderPath())` assertion).

- [ ] **Step 6: Commit.**

---

### Task 2: the token, and the column that holds it

**Files:** create `supabase/migrations/<next>_an_order_carries_its_own_link.sql`

Number it after the newest: `ls supabase/migrations | tail -1`.

**Interfaces produced:** `orders.share_token text unique`, `orders.share_expires_at timestamptz`,
`orders.customer_confirmed_at timestamptz`; `place_storefront_order` returns an extra
`share_token` key.

- [ ] **Step 1: Write the schema**

```sql
alter table public.orders
  add column share_token        text unique,
  add column share_expires_at   timestamptz,
  -- Part 3's flag, and deliberately NOT a sixth status. A new word in the
  -- vocabulary would mean touching the status CHECK, the permitted-moves
  -- table in the trigger, ORDERS_NEEDING_ACTION, the tabs and
  -- ORDER_STATUS_BADGE -- for something ORTHOGONAL to where the order is. An
  -- order can be awaiting confirmation at pending, accepted or ready.
  add column customer_confirmed_at timestamptz;

-- Nullable, because every order placed before this migration has no token and
-- must not be broken by one. Such an order simply has no link to share; the
-- shop can still work it exactly as before.
create index orders_share_token_idx on public.orders (share_token)
  where share_token is not null;
```

- [ ] **Step 2: Write the token generator**

```sql
-- 26 characters drawn from a 32-symbol alphabet = 130 bits. Read aloud over a
-- phone and typed by hand, so:
--
--   * Crockford's alphabet, which OMITS i, l, o and u -- the four that are
--     misheard or mistyped as 1, 1, 0 and v. This is the whole reason not to
--     use encode(..., 'hex') (32 characters, and reads as gibberish) or
--     base64 (mixed case, and '+' and '/' need escaping in a URL).
--   * lower case only, so nobody has to hear "capital B".
--
-- `% 32` IS UNBIASED HERE, and that is worth stating because modulo bias is
-- the classic way this goes wrong: get_byte returns 0..255, and 256 = 8 x 32
-- exactly, so every symbol is drawn with probability 8/256. It would NOT be
-- unbiased for an alphabet whose length does not divide 256.
create or replace function public.mint_order_share_token() returns text
language sql volatile set search_path = public as $$
  select string_agg(
           substr('0123456789abcdefghjkmnpqrstvwxyz',
                  1 + (get_byte(raw.bytes, i) % 32), 1), '')
    from (select gen_random_bytes(26) as bytes) raw,
         generate_series(0, 25) as i;
$$;

revoke execute on function public.mint_order_share_token() from public;
-- Nobody. place_storefront_order is SECURITY DEFINER and calls it as this
-- file's owner, so no role needs reach of its own -- the same posture
-- to_e164 has (20260927000000's grants comment).
```

- [ ] **Step 3: Copy `place_storefront_order` forward whole, minting the token**

Derive its newest definition first:
```bash
grep -n "function public.place_storefront_order" supabase/migrations/*.sql | grep -vE "grant|revoke|drop"
```
Expected today: `20260927000000_place_order.sql:205`. **If a newer file appears, copy from that
one** — copying from a merely-recent ancestor silently reverts a later fix and nothing fails when
you do it except `accumulated-rpc-edits.test.ts`.

Two changes inside the body, and no others:

```sql
-- Just before the INSERT into public.orders:
  --
  -- Retried against the unique index rather than trusted first time. At 130
  -- bits a collision is not a thing that happens, but "not a thing that
  -- happens" and "cannot happen" differ by one loop, and the failure mode
  -- without it is a customer's checkout dying on a unique violation.
  for v_attempt in 1 .. 5 loop
    v_token := public.mint_order_share_token();
    exit when not exists (select 1 from public.orders o where o.share_token = v_token);
    v_token := null;
  end loop;
  if v_token is null then
    raise exception 'order_failed' using errcode = 'P0001';
  end if;
```

Add `share_token` and `share_expires_at` to the INSERT's column list and values
(`now() + interval '90 days'`), and add one key to the returned jsonb:

```sql
    'share_token',        v_token,
```

**The header must argue**, not describe. State: why a token and not the order id or number (the id
carries no privilege and the number is guessable — constraint 5); why 90 days; why the returned
jsonb grows rather than the signature changing (`returns jsonb` already, so no drop-and-recreate,
so no grant churn); and why the function's own "the caller has no privilege that would let them do
anything with one" comment is **extended** rather than reversed — a token is the inverse of a bare
id, it *carries* its own privilege.

- [ ] **Step 4: Checks** — add to `supabase/tests/verify-orders.sql` (it already owns this table):
  1. A placed order comes back with a `share_token` of exactly 26 characters.
  2. The token matches `^[0-9a-hjkmnp-tv-z]+$` — **no i, l, o or u**, no upper case.
  3. Two orders placed in a row get **different** tokens.
  4. `share_expires_at` is in the future.
  5. `customer_confirmed_at` starts null.
  6. `anon` still cannot select `orders` directly (the lockdown is unchanged by the new columns).

- [ ] **Step 5:** `npm run test:db` — zero `FAILED:`. `npx jest supabase/tests/accumulated-rpc-edits.test.ts`.

- [ ] **Step 6: Mutation pass**

| Mutation | Must redden |
|---|---|
| Return the order number as the token | check 2 (it is digits, and 26 chars fails first) |
| Use a fixed literal token | check 3 |
| Include `i`/`l`/`o`/`u` in the alphabet | check 2 — **run it, this is the one most likely to be silently wrong** |
| Drop `share_expires_at` from the insert | check 4 |

- [ ] **Step 7: Commit.**

---

### Task 3: `get_public_order` — the fifth anon RPC

**Files:** create `supabase/migrations/<next+1>_a_customer_can_read_their_order.sql`,
`supabase/tests/verify-public-order.sql`

**Interfaces produced:** `get_public_order(p_token text) returns jsonb`

This is a **deliberate addition to a surface that was deliberately narrowed** by
`20261009000100_narrow_the_anon_rpc_surface.sql`. It brings the anon surface from four functions to
five. The header must carry the same argued case the other four do: it belongs to the same family
(the public storefront) and it is a *read* keyed on a capability the shop chose to hand out.

- [ ] **Step 1: Write the failing checks** in `supabase/tests/verify-public-order.sql`. Own shop,
      storefront, products and order; every failure a `raise exception`; verdict string last.

**What it returns.** Shop name, order number, status, placed-at, the lines (name, quantity, line
total), subtotal, delivery fee, total, fulfilment, `customer_note` from the latest amendment, that
amendment's `before`/`after` diff, and **the address the customer needs** — the delivery landmark
they gave for a deliver order, or the **shop's own address** for a collect one. A rail that says
"Ready" without saying where to go is the same failure the current confirmation screen has.

**What it must NEVER return.** Cost prices. Stock levels. Shortfall counts — *"only 3 left"* is
competitive information. The internal amendment `reason`. `cancellation_reason`. Any internal id.
The sale id.

**The exact payload, because Task 5 maps it key-for-key.** Return `null` (not an error, not an
empty object) for unknown *and* expired — check 7 compares the two:

```jsonc
{
  "shop_name":          "Xamdi Stores",
  "number":             7,
  "status":             "ready",              // the orders CHECK vocabulary, unchanged
  "placed_at":          "2026-08-30T09:00:00Z",
  "fulfilment":         "collect",
  // The landmark THEY gave on a deliver order; the SHOP's own address on a
  // collect one. Null only when neither exists. A rail that says "Ready"
  // without saying where to go is the failure the confirmation screen has.
  "where_to_go":        "Behind Maansoor Hotel, blue gate",
  "lines": [ { "product_name": "Rice 5kg", "quantity": 3, "line_total_cents": 7500 } ],
  "subtotal_cents":     7500,
  "delivery_fee_cents": 0,
  "total_cents":        7500,
  "confirmed_at":       null,
  // Null when the order has never been amended. `reason` is NOT in here and
  // must never be -- check 4 asserts on the serialised payload.
  "amendment": {
    "customer_note": "we'll have the rest Thursday",
    "was_cents":     12500,
    "now_cents":     7500,
    "before":        [ { "product_name": "Rice 5kg", "quantity": 5, "line_total_cents": 12500 } ],
    "after":         [ { "product_name": "Rice 5kg", "quantity": 3, "line_total_cents": 7500 } ]
  }
}
```

`before`/`after` are re-projected from `order_amendments.before->'lines'` down to these three keys
— **not passed through**. That jsonb carries `product_id` and `unit_price_cents`, and forwarding it
whole would leak a uuid onto the customer's page, which check 5 refuses.

Checks:
1. A valid token returns the order, with the number, status and total.
2. The lines come back with name, quantity and line total.
3. **A collect order carries the shop's own address**; a deliver order carries the customer's landmark.
4. `customer_note` from the latest amendment is present; the internal `reason` is **absent from the
   entire payload** — assert on the serialised jsonb, `not like '%<the reason text>%'`, with a
   reason string that appears nowhere else in the fixture.
5. **No `cost_cents`, no stock, no `sale_id`, no uuid** anywhere in the payload. Assert the
   serialised text does not match `'%-%-%-%-%'` (a uuid's shape) and does not contain the product's
   cost.
6. An **unknown** token raises/returns not-found.
7. An **expired** token returns the **identical** answer to an unknown one — compare the two
   results and assert they are equal. A different message tells a stranger which tokens are real.
8. A cancelled order is readable (the customer is owed that news) but carries no
   `cancellation_reason`.
9. `anon` can execute it.
10. `anon` still cannot select `orders`, `order_items` or `order_amendments` directly.

- [ ] **Step 2:** `npm run test:db 2>&1 | grep -iE "public-order|FAILED:"` — expect it named in `FAILED:`.

- [ ] **Step 3: Implement**, then grants at the foot:
```sql
revoke execute on function public.get_public_order(text) from public;
grant execute on function public.get_public_order(text) to anon, authenticated;
```

- [ ] **Step 4:** `npm run test:db` and `npx jest supabase/tests/accumulated-rpc-edits.test.ts`.

- [ ] **Step 5: Mutation pass**

| Mutation | Must redden |
|---|---|
| Include the amendment `reason` in the payload | check 4 |
| Include `product_id` in the lines | check 5 |
| Distinguish expired from unknown | check 7 |
| Return the shop address on a deliver order too | check 3 |
| Drop the expiry test entirely | check 7 |

- [ ] **Step 6: Commit.**

---

### Task 4: `confirm_public_order` — the sixth anon RPC, and the first anon *write*

**Files:** same migration as Task 3.

**Interfaces produced:** `confirm_public_order(p_token text) returns jsonb`

**This is the one to be paranoid about.** It is the first write ever granted to `anon` on an order.
The whole security argument is its asymmetry: it stamps `customer_confirmed_at` and **nothing
else**, and it is idempotent.

- [ ] **Step 1: Write the failing checks**, appended to `verify-public-order.sql`:
  11. Confirming with a valid token stamps `customer_confirmed_at`.
  12. **It is idempotent** — calling twice leaves the FIRST timestamp, unchanged. (Assert equality
      against the value read after the first call, not merely "not null".)
  13. **Nothing else moved.** Snapshot the whole order row before and after, and assert every other
      column is byte-identical — status, totals, lines, everything. This is the check the feature
      exists to satisfy.
  14. An unknown or expired token confirms nothing and raises the same not-found.
  15. A **cancelled** order cannot be confirmed.
  16. `anon` can execute it, and still cannot write `orders` directly.

- [ ] **Step 2:** run, watch fail.

- [ ] **Step 3: Implement.** The header must state, in the same terms `20260928000500` uses for
      provenance: *a link that has been forwarded, screenshotted or leaked must never be able to
      harm an order.* "Something's wrong" is deliberately not a code path here — it opens WhatsApp
      on the client and writes nothing.

- [ ] **Step 4:** `npm run test:db`, `npx jest supabase/tests/accumulated-rpc-edits.test.ts`.

- [ ] **Step 5: Mutation pass**

| Mutation | Must redden |
|---|---|
| Let it also set `status` | check 13 |
| Overwrite the timestamp on the second call | check 12 |
| Let it confirm a cancelled order | check 15 |
| Accept an expired token | check 14 |

- [ ] **Step 6: Commit.**

---

### Task 5: the client layer

**Files:** create `src/lib/public-order.ts`, `src/lib/__tests__/public-order.test.ts`

**Interfaces produced:**
```ts
export type PublicOrderLine = { productName: string; quantity: number; lineTotalCents: number };
export type PublicOrderAmendment = { customerNote: string | null; before: PublicOrderLine[]; after: PublicOrderLine[]; wasCents: number; nowCents: number };
export type PublicOrder = {
  shopName: string; number: number; status: OrderStatus; placedAt: string;
  lines: PublicOrderLine[];
  subtotalCents: number; deliveryFeeCents: number; totalCents: number;
  fulfilment: 'collect' | 'deliver';
  whereToGo: string | null;
  amendment: PublicOrderAmendment | null;
  confirmedAt: string | null;
};
export async function getPublicOrder(token: string): Promise<PublicOrder | null>;
export async function confirmPublicOrder(token: string): Promise<void>;
```

**Its own file, not `storefront-admin.ts`.** That module is the shop's side and every function in it
assumes a signed-in member; this one is called with no session at all. Mixing them invites a future
edit that reaches for a shop-scoped helper on the customer's page.

- [ ] **Step 1: Write the failing tests** — follow `src/lib/__tests__/storefront-admin.test.ts`'s
      hoisted `jest.mock('@/lib/supabase')` fake. Cover: the RPC is called by name with `p_token`;
      a null/absent payload maps to `null` rather than throwing; the row maps through; an unknown
      token yields `null`; `confirmPublicOrder` throws on error.

- [ ] **Step 2-4:** run, watch fail, implement, `npx jest src/lib && npx tsc --noEmit`.

- [ ] **Step 5: Mutation pass** — rename `p_token`; make an unknown token throw instead of
      returning null. Both must redden.

- [ ] **Step 6: Commit.**

---

### Task 6: the customer's page

**Files:** create `src/app/o/[token].tsx`
**This is the task that turns Task 1's route-file test green.**

No login. `vercel.json` already rewrites every path to the SPA, so **no hosting change**. `app.json`
has scheme `kaiibi` but no `associatedDomains`, so the link opens the **web** page rather than
deep-linking into an app the customer has never installed — which is what we want.

**Whatever this route is called on day one, it can be moved but never removed.** `src/app/s/[slug].tsx`
is the precedent: the old storefront address was kept as a redirect rather than deleted, because
"a link like that is out of our hands the moment it is sent." An order link lives in a customer's
WhatsApp history forever.

Two shapes:

- **Amended** — the stage rail, the customer note, a diff of what changed, the new total, and two
  buttons: **Yes, that's fine** (writes) and **Something's wrong — message the shop** (does not
  write; opens WhatsApp).
- **Ordinary** — the stage rail with the current step lit, the lines, the total, and a WhatsApp
  button. **This is the case that will be opened most**, and it is what kills the "where is my
  order?" call.

- [ ] **Step 1: Write the failing tests** (`react-test-renderer`, props not text). Cover: an
      ordinary order renders the rail and total and **no confirm button**; an amended one renders
      both buttons; "Yes, that's fine" calls `confirmPublicOrder`; **"Something's wrong" calls
      nothing that writes** — assert the confirm spy was not called; an already-confirmed order
      shows neither button; an unknown token renders a not-found state rather than a crash;
      **`whereToGo` is rendered** for both fulfilment kinds.
- [ ] **Step 2-4:** run, watch fail, implement, `npx jest src/app && npx tsc --noEmit`.
- [ ] **Step 5: Mutation pass** — make "Something's wrong" call `confirmPublicOrder` (must redden);
      render the confirm buttons on an unamended order; drop `whereToGo`.
- [ ] **Step 6: Commit.**

---

### Task 6b: the customer leaves checkout already holding the link

**Files:** the checkout confirmation surface (find it: `grep -rn "place_storefront_order" src/`),
plus its test.

Decision 2. `place_storefront_order` returns `share_token` in the **same jsonb the confirmation
screen already renders** (Task 2), so this is a render change and not a second query — no new RPC
call, no loading state.

- [ ] **Step 1: Write the failing tests** — the confirmation screen shows the address built by
      `orderAddress(token)`; a response with **no** `share_token` (an older client, or a failure
      path) renders no link rather than `kaiibi.com/o/undefined`; the string shown **equals**
      `orderAddress(token)` and is not hand-built.
- [ ] **Step 2-4:** run, watch fail, implement, `npx jest && npx tsc --noEmit`.
- [ ] **Step 5: Mutation pass** — hand-build the URL (must redden); render the link when the token
      is absent (must redden). **The second one matters most**: `undefined` in a URL is the exact
      shape of the #108 bug, a link that looks real and goes nowhere.
- [ ] **Step 6: Commit.**

---

### Task 7: the shop's side

**Files:** `src/app/(admin)/orders.tsx`, `src/components/orders/order-detail.tsx`, their tests.

- [ ] **Step 1:** an **"Awaiting customer"** chip beside the stage, shown when the order's latest
      `order_amendments.amended_at` has no later `customer_confirmed_at`.

      **It warns, it does not block.** "Mark ready" stays live on an unconfirmed order — it is just
      no longer the *filled* button. A shop that phoned and got a verbal yes must not be locked out
      because the customer never tapped anything; blocking only teaches people to route around the
      feature. Same posture the sheet already takes with `blockedOnPosAccess`: say why, don't
      silently fail.

- [ ] **Step 2:** a copy-link affordance in the detail sheet, built from `orderAddress(token)` —
      **never a hand-built string.** An order with no token (placed before Task 2) shows no link
      rather than a broken one.
- [ ] **Step 3: Tests** — the chip appears only when amended-and-unconfirmed; "Mark ready" is still
      enabled while the chip shows; the copied string **equals `orderAddress(token)`** (this is the
      #108 assertion again, at the surface that actually gets copied).
- [ ] **Step 4: Mutation pass** — disable "Mark ready" when unconfirmed (must redden); hand-build
      the link (must redden); show the chip on a confirmed order.
- [ ] **Step 5: Commit.**

---

## Verification of the whole part

- [ ] `npm run test:db` — zero `FAILED:`.
- [ ] `npm test && npx tsc --noEmit && npm run lint` — no worse than the baseline measured at the
      start. **Measure it first:** bare `npx tsc --noEmit` had **18 pre-existing errors** and lint
      **147 problems** as of `e448edb`; do not believe a handoff that says "tsc clean".
- [ ] **The seam, against a real stack.** The unit tests mock PostgREST. Call `get_public_order` and
      `confirm_public_order` over real HTTP **with the anon key and no session at all** — that is
      the posture a customer actually has, and it is the one thing a fake cannot show:
      ```bash
      curl -s -X POST "http://127.0.0.1:54321/rest/v1/rpc/get_public_order" \
        -H "apikey: $ANON" -H 'Content-Type: application/json' \
        -d '{"p_token":"<a real token>"}'
      ```
      Assert the payload contains no uuid and no cost, and that `confirm_public_order` moves nothing
      but the timestamp.
- [ ] **On a device**, per `/testing-kaiibi`. **Note the two traps Part 2 hit:** Metro on `:8081`
      serves the *main checkout*, not your worktree, and the main `.env` points at **production**,
      which will not have these migrations. Either merge first or run a second Metro against the
      local stack.

## Decisions taken before execution (2026-08-30)

1. **The link lives 90 days.** Long enough to cover the whole life of an order a customer might
   come back to, short enough that a token in a leaked chat export stops working within a season.
   Write this reasoning into the migration header rather than leaving `90` as a bare number.
2. **The link appears on the customer's checkout confirmation screen.** That is what makes it
   useful with no action from the shop at all — the customer leaves checkout already holding it.
   `place_storefront_order` returns `share_token` in the same jsonb the confirmation screen already
   renders, so this is a render change and not a second query. **This adds a task — see Task 6b.**
3. **`o` is the segment, and there is NO permanent-redirect commitment.** The spec argued from
   `src/app/s/[slug].tsx`'s precedent that an order route "can be moved but never removed". That
   guarantee is explicitly **not** being made here.

   **The consequence, stated so nobody rediscovers it as a bug:** if the segment ever changes,
   every link already sitting in a customer's WhatsApp history 404s rather than redirecting. That
   is accepted. It also means `LEGACY_ORDER_SEGMENT` is NOT to be added "just in case" — an unused
   redirect constant is how the next person concludes the guarantee exists.

## Open questions that remain

1. **What does the page show for an order placed before Task 2** (no token)? It cannot be reached
   by definition — but the shop's copy affordance must not render a broken link, which Task 7
   covers. Confirm there is no other surface that assumes a token exists.
