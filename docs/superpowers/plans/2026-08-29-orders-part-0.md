# Orders Part 0 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A shop can complete a storefront order without an open register, and a customer is told store pick-up exists and where to go.

**Architecture:** Two independent defects. (0a) `complete_sale` gains a `p_require_register` parameter defaulting `true`, so the POS guard is untouched and `complete_storefront_order` is the single caller opting out — while attaching the completing member's open session when one exists, so counter handovers still reconcile into a drawer. (0b) The public storefront starts returning the shop's pick-up address, the checkout always renders the fulfilment choice (omitting "Deliver" rather than disabling it), and the confirmation says where to collect.

**Tech Stack:** Postgres (Supabase migrations), TypeScript, React Native / Expo SDK 57, Jest.

**Spec:** [`docs/superpowers/specs/2026-08-29-orders-amend-and-share-design.md`](../specs/2026-08-29-orders-amend-and-share-design.md) — Part 0.

## Global Constraints

- **Expo docs are versioned.** Read `https://docs.expo.dev/versions/v57.0.0/` before writing component code. (`AGENTS.md`)
- **A migration reproduces its functions whole.** Every function it touches appears as the newest complete definition of itself, so the next reader never replays a chain of substitutions. (`20260908000150_journal_entry_sequence.sql` header)
- **Adding a parameter requires `drop function` naming the old signature exactly, then create, then re-grant.** A `create or replace` cannot change the argument list, and a bare add leaves two ambiguous overloads. A plain replace keeps the existing ACL; a drop does not. (`20260929000100:204`, `20260929000150:123`)
- **`revoke execute … from public` goes before `grant … to authenticated`.** Postgres grants EXECUTE to PUBLIC on every new function, so a grant alone is a no-op dressed as a decision. (`20260924000100:103`)
- **`complete_sale`'s current signature is 15 arguments**, ending `p_prices_include_tax boolean default false`. Newest definition: `supabase/migrations/20260929000200_complete_storefront_order_agreed.sql:233`.
- **`complete_storefront_order`'s newest definition** is in the same file, and its `complete_sale` call is at `:1489`.
- **Storefront components are NOT bento.** They take a `PaletteColors` prop and read colours from it. Never import `Colors` into `src/components/storefront/`.
- **Migration filenames are `YYYYMMDDHHMMSS_lowercase_sentence.sql`** and sort after `20261009000100_narrow_the_anon_rpc_surface.sql`.

---

## File Structure

| File | Responsibility |
|---|---|
| `supabase/migrations/20261010000000_fulfilment_needs_no_register.sql` | **Create.** `complete_sale` + `p_require_register`; `complete_storefront_order` opts out and attaches a session when one is open. Both reproduced whole. |
| `supabase/migrations/20261010000100_a_storefront_says_where_to_collect.sql` | **Create.** `get_public_storefront` returns `collect_address`. Reproduced whole. |
| `supabase/tests/verify-order-transitions.sql` | **Modify.** Three new checks for 0a. |
| `supabase/tests/verify-orders.sql` | **Modify.** One new check for 0b's RPC shape. |
| `src/types/models.ts:1289-1312` | **Modify.** `PublicStorefront.collectAddress`. |
| `src/lib/storefront.ts:110` | **Modify.** Map `collect_address` → `collectAddress`. |
| `src/components/storefront/checkout-form.tsx:60-64, 212-246` | **Modify.** Always render the fulfilment choice; omit Deliver when unavailable; show the pick-up address. |
| `src/components/storefront/order-placed.tsx:20-24` | **Modify.** Say where to collect. |
| `src/components/__tests__/storefront-checkout-form.test.tsx` | **Modify.** Collect-only and address cases. |

**Task order:** 1 → 2 → 3 → 4 → 5. Task 1 is independent of 2–5 and could ship on its own; 4 and 5 both depend on 3.

---

### Task 1: Storefront completion never requires an open register

**Files:**
- Create: `supabase/migrations/20261010000000_fulfilment_needs_no_register.sql`
- Modify: `supabase/tests/verify-order-transitions.sql` (append three checks)

**Interfaces:**
- Consumes: `public.my_open_session_at(p_location_id uuid) returns uuid` (`20260822000000:219`) — returns the calling user's open session at a location, or null.
- Produces: `public.complete_sale(…)` at its **unchanged fifteen-argument signature**. A security review rejected the `p_require_register boolean default true` parameter this plan originally specified: `complete_sale` is granted to `authenticated` and exposed over PostgREST, so the parameter was a JSON field any member with `pos.access` could send, and `p_require_register => false` (or `=> null`, which made the `if` evaluate to NULL) defeated the `require_open_register` setting outright. A default is not an enforcement. The opt-out is instead read off the `storefront_order_fulfilments` mark `complete_storefront_order` already writes as a SECURITY DEFINER around the call — see `20261010000000`'s header. **Later work calling `complete_sale` keeps the fifteen-argument arity in any `grant`/`revoke`/`drop`.**

- [ ] **Step 1: Write the failing checks**

Append to `supabase/tests/verify-order-transitions.sql`, following the numbering already in the file (continue from its highest existing check number; the three below are written as 45–47 — renumber if the file has grown):

```sql
-- ── 45: a require_open_register location still completes a storefront order ──
do $$
declare
  v_shop uuid; v_loc uuid; v_order uuid; v_sale uuid;
begin
  select id into v_shop from public.shops limit 1;
  select id into v_loc from public.shop_locations
   where shop_id = v_shop order by is_primary desc, created_at asc limit 1;

  update public.shop_locations set require_open_register = true where id = v_loc;

  select id into v_order from public.orders
   where shop_id = v_shop and status = 'ready' limit 1;

  begin
    v_sale := public.complete_storefront_order(v_order, 'cash');
    raise notice 'PASS 45: completed with require_open_register on, sale %', v_sale;
  exception when others then
    raise notice 'FAIL 45: %', sqlerrm;
  end;

  update public.shop_locations set require_open_register = false where id = v_loc;
end $$;

-- ── 46: the POS guard survived — complete_sale still refuses with no session ──
do $$
declare
  v_shop uuid; v_loc uuid; v_product uuid;
begin
  select id into v_shop from public.shops limit 1;
  select id into v_loc from public.shop_locations
   where shop_id = v_shop order by is_primary desc, created_at asc limit 1;
  select id into v_product from public.products where shop_id = v_shop limit 1;

  update public.shop_locations set require_open_register = true where id = v_loc;

  begin
    perform public.complete_sale(
      p_shop_id  => v_shop,
      p_items    => jsonb_build_array(jsonb_build_object('product_id', v_product, 'quantity', 1)),
      p_payments => jsonb_build_array(jsonb_build_object('method', 'cash', 'amount_cents', 1)));
    raise notice 'FAIL 46: complete_sale accepted a sale with no session at a require_open_register location';
  exception
    when others then
      if sqlerrm like '%requires an open register%' then
        raise notice 'PASS 46: POS guard intact';
      else
        raise notice 'FAIL 46: wrong error: %', sqlerrm;
      end if;
  end;

  update public.shop_locations set require_open_register = false where id = v_loc;
end $$;

-- ── 47: an open session at the location is attached to the sale ──────────────
do $$
declare
  v_shop uuid; v_loc uuid; v_order uuid; v_sale uuid; v_session uuid; v_on_sale uuid;
begin
  select id into v_shop from public.shops limit 1;
  select id into v_loc from public.shop_locations
   where shop_id = v_shop order by is_primary desc, created_at asc limit 1;

  select id into v_session from public.register_sessions
   where location_id = v_loc and closed_at is null limit 1;

  if v_session is null then
    raise notice 'SKIP 47: no open session at the primary location in this fixture';
  else
    select id into v_order from public.orders
     where shop_id = v_shop and status = 'ready' limit 1;
    v_sale := public.complete_storefront_order(v_order, 'cash');
    select register_session_id into v_on_sale from public.sales where id = v_sale;
    if v_on_sale = v_session then
      raise notice 'PASS 47: counter handover reconciles into the open drawer';
    else
      raise notice 'FAIL 47: expected session % on the sale, got %', v_session, v_on_sale;
    end if;
  end if;
end $$;
```

- [ ] **Step 2: Run the checks and watch 45 fail**

Requires a local stack (`npx supabase start`).

```bash
npm run test:db 2>&1 | grep -E "4[567]:"
```

Expected: `FAIL 45: this store requires an open register before a sale can be rung up`. Check 46 passes already (it is the guard we are preserving). Check 47 likely reports `SKIP`.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/20261010000000_fulfilment_needs_no_register.sql`.

**Header** (write this verbatim — it is the argument the next reader needs):

```sql
-- Fulfilling an order does not happen at a till.
--
-- 20260928000200's own header called this out and accepted it: "A branch with
-- require_open_register set WILL still refuse (that guard is on
-- `p_register_session_id is null`), and that is correct." It is not correct,
-- and the consequence is worse than the header implies -- complete_storefront_
-- order passes p_register_session_id => null unconditionally, and `orders`
-- carries no location, so every storefront sale resolves to the shop's PRIMARY
-- location (20260929000200:1489, and complete_sale's own default at :182-191).
-- A shop with require_open_register set on that location cannot complete a
-- single online order. Not "must open a register first" -- there is no
-- parameter to pass one through. It is a dead end.
--
-- ── Why the guard is wrong here and right at a counter ──────────────────
-- A register session reconciles ONE PHYSICAL DRAWER: it exists so the cash in
-- that drawer can be counted against what was rung into it. An order collected
-- at the door, or handed to a driver going to Koodbuur, has no drawer to
-- reconcile against. Requiring one protects nothing and refuses the sale.
--
-- ── p_require_register defaults TRUE ────────────────────────────────────
-- Every caller that existed before this migration is unchanged, the POS
-- included -- the same posture p_prices_include_tax took at 20260929000100.
-- complete_storefront_order is the single caller passing false, and it says
-- why at the call site.
--
-- ── But a session IS attached when there genuinely is one ───────────────
-- Passing null unconditionally, which is what happens today, is also wrong in
-- the other direction: an order collected at the counter by someone with a
-- drawer open IS a drawer transaction, and belongs in that drawer's count.
-- complete_storefront_order now asks my_open_session_at (20260822000000:219)
-- for the completing member's open session at the resolved location and passes
-- it when there is one. So: counter handovers reconcile, motorbikes do not,
-- and neither is refused.
--
-- The location is resolved here with the SAME query complete_sale uses for its
-- own default (:182-191) rather than being passed through as p_location_id.
-- Passing it explicitly would additionally trip complete_sale's
-- can_access_location check, which is a behaviour change for a branch-
-- restricted member on an unrelated axis, and this migration is not the place
-- for it. The two derivations cannot diverge -- same query, same transaction --
-- and if they ever did, complete_sale's own "session is at a different
-- location than this sale" check (:213) refuses loudly rather than misfiling
-- the money quietly.
--
-- ── Why a drop, and not just a replace ──────────────────────────────────
-- complete_sale gains an argument, and create or replace cannot change an
-- argument list -- it would leave a fifteen-argument and a sixteen-argument
-- function side by side, and a call naming only the first three parameters
-- would then be ambiguous. The drop names the old signature exactly, the same
-- move 20260929000100:211 had to make for the same reason, and the ACL does
-- not survive a drop, so the revoke/grant pair at the foot restates it.
```

**Body:**

```sql
drop function if exists public.complete_sale(uuid, jsonb, jsonb, text, text, text, text, integer, uuid, timestamptz, uuid, integer, uuid, boolean, boolean);
```

Then reproduce `complete_sale` **whole**, copied verbatim from
`supabase/migrations/20260929000200_complete_storefront_order_agreed.sql:233` to the end of that
function, with exactly two changes:

1. Add a sixteenth parameter after `p_prices_include_tax boolean default false`:

```sql
  p_prices_include_tax boolean default false,
  -- Whether a location's require_open_register setting applies to this call.
  -- TRUE for every caller that existed before this migration, the POS
  -- included. Only complete_storefront_order passes false, and its call site
  -- says why: an order handed over at a door has no drawer to reconcile
  -- against.
  p_require_register boolean default true
```

2. Add `p_require_register and` to the guard (currently `20260929000200`'s copy of
   `20260908000300:225-228`):

```sql
  -- A branch that requires an open register means it: without this the setting
  -- is advisory, and the client is the party it is meant to constrain. Read off
  -- the resolved location, so turning it on at one branch never stops another
  -- selling. Skipped entirely when the caller is not ringing up at a till --
  -- see this migration's header.
  if p_require_register
     and p_register_session_id is null
     and (select require_open_register from public.shop_locations where id = v_location_id) then
    raise exception 'this store requires an open register before a sale can be rung up';
  end if;
```

Then reproduce `complete_storefront_order` **whole**, copied verbatim from the same file
(`:1400`-ish through the end of that function), with exactly two changes:

3. Declare two locals alongside the existing ones:

```sql
  v_register_location uuid;
  v_session_id        uuid;
```

4. Replace the `complete_sale` call at `:1489` with:

```sql
    -- The same primary-location default complete_sale resolves for itself when
    -- p_location_id is null (20260908000300:182-191), re-derived here only so
    -- the session lookup has a location to ask about. See the header.
    select l.id into v_register_location from public.shop_locations l
      where l.shop_id = v_order.shop_id
      order by l.is_primary desc, l.created_at asc
      limit 1;
    v_session_id := public.my_open_session_at(v_register_location);

    v_sale_id := public.complete_sale(
      p_shop_id             => v_order.shop_id,
      p_items               => v_items,
      p_payments            => jsonb_build_array(jsonb_build_object(
                                 'method',       p_payment_method,
                                 'amount_cents', v_order.subtotal_cents)),
      p_customer_name       => v_order.customer_name,
      p_customer_phone      => v_order.customer_phone,
      -- The completing member's own open drawer when they have one at this
      -- location -- a handover at the counter belongs in that drawer's count.
      -- Null when they do not, which is the honest answer for a delivery.
      p_register_session_id => v_session_id,
      p_prices_include_tax  => true,
      -- Never refused for want of a till. See this migration's header.
      p_require_register    => false);
```

**Grants** at the foot:

```sql
-- The revoke goes first: Postgres grants EXECUTE to PUBLIC on every new
-- function, so a grant alone would be a no-op dressed as a decision. The ACL
-- did not survive the drop above, so both statements are load-bearing here.
revoke execute on function public.complete_sale(uuid, jsonb, jsonb, text, text, text, text, integer, uuid, timestamptz, uuid, integer, uuid, boolean, boolean, boolean) from public;
grant  execute on function public.complete_sale(uuid, jsonb, jsonb, text, text, text, text, integer, uuid, timestamptz, uuid, integer, uuid, boolean, boolean, boolean) to authenticated;

-- complete_storefront_order was REPLACED, not dropped -- its signature is
-- unchanged -- so its ACL survives. Restated anyway, the same way
-- 20260929000200 restates it, so the grant is visible in the file that
-- defines the function.
revoke execute on function public.complete_storefront_order(uuid, text) from public;
grant  execute on function public.complete_storefront_order(uuid, text) to authenticated;
```

- [ ] **Step 4: Run the checks and verify all three pass**

```bash
npm run test:db 2>&1 | grep -E "4[567]:"
```

Expected: `PASS 45`, `PASS 46`, and `PASS 47` (or `SKIP 47` if the fixture has no open session — if it skips, open one in the fixture so the check is real).

- [ ] **Step 5: Verify nothing else regressed**

```bash
npm run test:db 2>&1 | grep -c FAIL
```

Expected: `0`.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/20261010000000_fulfilment_needs_no_register.sql supabase/tests/verify-order-transitions.sql
git commit -m "Fulfilling an order does not happen at a till

complete_storefront_order passes p_register_session_id => null
unconditionally and orders carries no location, so every storefront sale
resolves to the shop's primary location. A shop with require_open_register
set there could not complete a single online order -- there was no
parameter to pass a session through. 20260928000200's header called this
correct; it is not.

complete_sale gains p_require_register, defaulting true, so the POS guard
is untouched. complete_storefront_order is the only caller passing false,
and it now also attaches the completing member's open session when there
is one -- a counter handover reconciles into that drawer, a delivery does
not, and neither is refused.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: The storefront says where to collect

**Files:**
- Create: `supabase/migrations/20261010000100_a_storefront_says_where_to_collect.sql`
- Modify: `supabase/tests/verify-orders.sql` (append one check)

**Interfaces:**
- Consumes: `public.get_public_storefront(text)` — newest definition at `supabase/migrations/20260930000300_flyer_offer_facts.sql`.
- Produces: that RPC's returned object gains a `collect_address` key (text, nullable). Task 3 maps it.

- [ ] **Step 1: Write the failing check**

Append to `supabase/tests/verify-orders.sql`, continuing its numbering:

```sql
-- ── N: the public storefront tells a customer where to collect from ──────────
do $$
declare
  v_slug text; v_result jsonb;
begin
  select slug into v_slug from public.storefronts limit 1;
  v_result := public.get_public_storefront(v_slug);

  if v_result ? 'collect_address' then
    raise notice 'PASS N: get_public_storefront returns collect_address (%)',
      coalesce(v_result->>'collect_address', 'null');
  else
    raise notice 'FAIL N: get_public_storefront has no collect_address key';
  end if;
end $$;
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npm run test:db -- --no-reset 2>&1 | grep "collect_address"
```

Expected: `FAIL N: get_public_storefront has no collect_address key`.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/20261010000100_a_storefront_says_where_to_collect.sql`.

**Header:**

```sql
-- A shop that does not deliver never told anyone where it is.
--
-- checkout-form.tsx hides the whole fulfilment choice unless the shop offers
-- delivery AND has priced an area (`canDeliver`), so a collection-only shop
-- shows the customer nothing at all: `fulfilment` sits at its default
-- 'collect' and the order is placed as a pick-up nobody was told about. And
-- order-placed.tsx then says "will call you when your order is ready to
-- collect" -- to collect from WHERE is never on the page.
--
-- The address exists. It is on shop_locations, not shops, and deliberately so
-- ("a business doesn't have a street, its branches do" -- src/types/models.ts
-- :30, and 20260808000000's own header). get_public_storefront has simply
-- never returned it. This adds it: the address of the PRIMARY location, which
-- is the same branch complete_sale files a storefront sale against
-- (20260908000300:182-191) and the same one checkOrderFulfilment checks stock
-- at, so the page names the counter the goods will actually be waiting on.
--
-- Nullable, and null is a real answer: a shop that has not filled its address
-- in gets no address line rather than an empty one, exactly the null-over-
-- empty-string convention the storefront types already follow.
--
-- Anon reads this, which is the point -- a shop's street address is the one
-- fact it most wants a stranger to have. No new grant and no new function:
-- get_public_storefront is already one of the four anon RPCs
-- (20261009000100), and this is a replace, so its ACL survives untouched.
```

**Body:** reproduce `get_public_storefront` whole from
`supabase/migrations/20260930000300_flyer_offer_facts.sql`, adding one key to the returned
`jsonb_build_object` immediately after `'offers_delivery'`:

```sql
    'collect_address', (select l.address from public.shop_locations l
                         where l.shop_id = s.id
                         order by l.is_primary desc, l.created_at asc
                         limit 1),
```

Restate the grant at the foot, matching `20260930000300`:

```sql
revoke execute on function public.get_public_storefront(text) from public;
grant  execute on function public.get_public_storefront(text) to anon, authenticated;
```

- [ ] **Step 4: Run the check and verify it passes**

```bash
npm run test:db 2>&1 | grep "collect_address"
```

Expected: `PASS N: get_public_storefront returns collect_address (…)`.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20261010000100_a_storefront_says_where_to_collect.sql supabase/tests/verify-orders.sql
git commit -m "A shop that does not deliver never told anyone where it is

get_public_storefront returns the primary location's address, so a
collection-only storefront can finally say where the goods will be waiting.
The address was always on shop_locations; the public RPC just never
returned it.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: The public type and mapper carry the address

**Files:**
- Modify: `src/types/models.ts:1289-1312`
- Modify: `src/lib/storefront.ts:110`
- Test: `src/lib/__tests__/storefront.test.ts`

**Interfaces:**
- Consumes: `collect_address` from Task 2's RPC.
- Produces: `PublicStorefront.collectAddress: string | null`. Tasks 4 and 5 read it.

- [ ] **Step 1: Write the failing test**

Add to `src/lib/__tests__/storefront.test.ts`, following the file's existing mapping-test pattern:

```ts
it('maps collect_address to collectAddress', async () => {
  const row = { ...baseRow, collect_address: 'Shop 12, Bakaaro Market' };
  const result = mapPublicStorefront(row);
  expect(result.collectAddress).toBe('Shop 12, Bakaaro Market');
});

it('leaves collectAddress null when the shop has no address', async () => {
  const row = { ...baseRow, collect_address: null };
  const result = mapPublicStorefront(row);
  expect(result.collectAddress).toBeNull();
});
```

If `storefront.ts` does not export its mapper, exercise it through the exported
`getPublicStorefront` with the Supabase client mocked, matching whatever the neighbouring tests in
that file already do. Do not export a function purely to test it.

- [ ] **Step 2: Run it and watch it fail**

```bash
npx jest src/lib/__tests__/storefront.test.ts -t collectAddress
```

Expected: FAIL — `Property 'collectAddress' does not exist on type 'PublicStorefront'`.

- [ ] **Step 3: Add the field and the mapping**

In `src/types/models.ts`, inside `PublicStorefront`, immediately after `offersDelivery`:

```ts
  offersDelivery: boolean;
  // Where to come and get it. The PRIMARY location's street address -- the
  // same branch a storefront sale is filed against and stock is checked at --
  // so the page names the counter the goods will actually be waiting on.
  // Null when the shop has not filled one in, which is a real answer: the
  // pick-up line renders without an address rather than with an empty one.
  collectAddress: string | null;
```

In `src/lib/storefront.ts`, beside the existing `offersDelivery` mapping at line 110:

```ts
    offersDelivery: Boolean(row.offers_delivery),
    collectAddress: (row.collect_address as string | null) ?? null,
```

- [ ] **Step 4: Run the test and the type check**

```bash
npx jest src/lib/__tests__/storefront.test.ts -t collectAddress && npx tsc --noEmit
```

Expected: tests PASS, `tsc` exits 0. If `tsc` reports other files constructing a `PublicStorefront`
without `collectAddress` (test fixtures are the likely ones), add `collectAddress: null` to each.

- [ ] **Step 5: Commit**

```bash
git add src/types/models.ts src/lib/storefront.ts src/lib/__tests__/storefront.test.ts
git commit -m "Carry the pick-up address through to the public storefront type

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: Checkout always offers store pick-up

**Files:**
- Modify: `src/components/storefront/checkout-form.tsx:60-64` and `:212-246`
- Test: `src/components/__tests__/storefront-checkout-form.test.tsx`

**Interfaces:**
- Consumes: `PublicStorefront.collectAddress` (Task 3), threaded to `CheckoutForm` as a new prop.
- Produces: nothing later tasks depend on.

The bug: `canDeliver = offersDelivery && areas.length > 0`, and the **entire** fulfilment block —
the heading and *both* buttons — sits inside `{canDeliver ? … : null}`. A collection-only shop shows
no choice at all.

The fix keeps the existing Property 4 reasoning (a dead "Deliver" option would claim delivery
exists) by **omitting** Deliver, never disabling it — while always rendering Collect, so the
customer is told what is happening.

- [ ] **Step 1: Write the failing tests**

Add to `src/components/__tests__/storefront-checkout-form.test.tsx`, following its existing render
helper and `testID` conventions:

```tsx
it('shows store pick-up even when the shop does not deliver', () => {
  const { getByTestId, queryByTestId } = renderForm({
    offersDelivery: false,
    areas: [],
    collectAddress: 'Shop 12, Bakaaro Market',
  });

  expect(getByTestId('checkout-form-fulfilment-collect')).toBeTruthy();
  // Omitted, never disabled: a dead option would claim delivery exists.
  expect(queryByTestId('checkout-form-fulfilment-deliver')).toBeNull();
});

it('names the address the customer is collecting from', () => {
  const { getByText } = renderForm({
    offersDelivery: false,
    areas: [],
    collectAddress: 'Shop 12, Bakaaro Market',
  });

  expect(getByText(/Shop 12, Bakaaro Market/)).toBeTruthy();
});

it('still shows the pick-up option when there is no address on file', () => {
  const { getByTestId } = renderForm({
    offersDelivery: false,
    areas: [],
    collectAddress: null,
  });

  expect(getByTestId('checkout-form-fulfilment-collect')).toBeTruthy();
});

it('offers both choices when the shop delivers and has priced an area', () => {
  const { getByTestId } = renderForm({
    offersDelivery: true,
    areas: [{ name: 'Koodbuur', feeCents: 500 }],
    collectAddress: 'Shop 12, Bakaaro Market',
  });

  expect(getByTestId('checkout-form-fulfilment-collect')).toBeTruthy();
  expect(getByTestId('checkout-form-fulfilment-deliver')).toBeTruthy();
});
```

- [ ] **Step 2: Run them and watch the first three fail**

```bash
npx jest src/components/__tests__/storefront-checkout-form.test.tsx
```

Expected: the first three FAIL (`Unable to find an element with testID: checkout-form-fulfilment-collect`); the fourth passes already.

- [ ] **Step 3: Add the prop**

In `src/components/storefront/checkout-form.tsx`, add to the `Props` type beside `whatsappE164`:

```ts
  // The PRIMARY location's address, for the pick-up line. Null when the shop
  // has not filled one in -- the option still renders, without an address.
  collectAddress?: string | null;
```

Add it to the destructured parameter list:

```ts
export function CheckoutForm({ cart, colors, offersDelivery, areas, submitting, whatsappE164, collectAddress, onSubmit }: Props) {
```

- [ ] **Step 4: Always render the choice**

Replace the opening of the block at `:212-218`. The comment must change too — it currently
justifies hiding the whole thing, which is the bug:

```tsx
      {/* The choice ALWAYS renders. It used to sit behind `canDeliver`, so a
          collection-only shop showed nothing at all and the order was placed
          as a pick-up the customer was never told about. Property 4's actual
          rule survives, and is narrower than the old code applied it: a
          "Deliver" choice must not exist unless the shop both offers delivery
          AND has priced an area -- so Deliver is OMITTED, never disabled. */}
      <Text style={[styles.label, styles.spaced, { color: colors.ink }]}>How will you get your order?</Text>
      <View style={styles.segmented}>
        <Pressable
          testID="checkout-form-fulfilment-collect"
          accessibilityRole="button"
          onPress={() => selectFulfilment('collect')}
          style={[
            styles.segment,
            { borderColor: colors.soft },
            fulfilment === 'collect' && { backgroundColor: colors.accent, borderColor: colors.accent },
          ]}
        >
          <Text style={[styles.segmentText, { color: fulfilment === 'collect' ? colors.ground : colors.ink }]}>
            Store pick-up
          </Text>
        </Pressable>
        {canDeliver ? (
          <Pressable
            testID="checkout-form-fulfilment-deliver"
            accessibilityRole="button"
            onPress={() => selectFulfilment('deliver')}
            style={[
              styles.segment,
              { borderColor: colors.soft },
              fulfilment === 'deliver' && { backgroundColor: colors.accent, borderColor: colors.accent },
            ]}
          >
            <Text style={[styles.segmentText, { color: fulfilment === 'deliver' ? colors.ground : colors.ink }]}>
              Deliver
            </Text>
          </Pressable>
        ) : null}
      </View>

      {fulfilment === 'collect' && collectAddress ? (
        <Text style={[styles.collectAddress, { color: colors.muted }]}>Collect from {collectAddress}</Text>
      ) : null}
```

Then close the old `{canDeliver ? ( … ) : null}` wrapper so that **only** the delivery-area picker
and landmark field below (`{fulfilment === 'deliver' ? ( … ) : null}`, currently at `:249`) remain
conditional. The `<>…</>` fragment that wrapped the whole block is no longer needed — remove it and
its closing tag.

Add the style beside the existing entries in the same `StyleSheet.create` block:

```ts
  collectAddress: { fontSize: 13, marginTop: 8, lineHeight: 18 },
```

- [ ] **Step 5: Run the tests and the type check**

```bash
npx jest src/components/__tests__/storefront-checkout-form.test.tsx && npx tsc --noEmit
```

Expected: all four PASS, `tsc` exits 0.

- [ ] **Step 6: Pass the address in from the storefront screen**

In `src/app/store/[slug].tsx`, the `StorefrontView` at `:88` receives `storefront={state.shop}`.
Thread `collectAddress={state.shop.collectAddress}` down to wherever `StorefrontView` renders
`CheckoutForm`. Follow the prop path already used for `whatsappE164`.

- [ ] **Step 7: Run the whole suite**

```bash
npm test
```

Expected: no new failures. `storefront-checkout-whatsapp-choice.test.tsx` and
`storefront-editor-screen.test.tsx` both touch this area — if either constructs a storefront object
directly, add `collectAddress: null`.

- [ ] **Step 8: Commit**

```bash
git add src/components/storefront/checkout-form.tsx src/components/__tests__/storefront-checkout-form.test.tsx "src/app/store/[slug].tsx"
git commit -m "Store pick-up was invisible exactly when it was the only option

The whole fulfilment block sat behind canDeliver, so a shop that does not
deliver showed the customer no choice at all -- the order went through as a
collection nobody was told about. The choice now always renders, Deliver is
omitted rather than disabled when it is unavailable (Property 4's rule
survives, applied where it actually belongs), and a pick-up names the
address to come to.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: The confirmation says where to go

**Files:**
- Modify: `src/components/storefront/order-placed.tsx:7-24`
- Test: `src/components/__tests__/storefront-checkout-form.test.tsx` (or a sibling `order-placed` test file if one is added)

**Interfaces:**
- Consumes: `PublicStorefront.collectAddress` (Task 3), passed as a prop.
- Produces: nothing.

- [ ] **Step 1: Write the failing test**

```tsx
it('tells a collecting customer where to come', () => {
  const { getByText } = render(
    <OrderPlaced
      order={{ ...placedOrder, fulfilment: 'collect' }}
      shopName="Hodan Grocery"
      collectAddress="Shop 12, Bakaaro Market"
      colors={palette}
    />
  );

  expect(getByText(/Shop 12, Bakaaro Market/)).toBeTruthy();
});

it('falls back to the old sentence when there is no address on file', () => {
  const { getByText } = render(
    <OrderPlaced
      order={{ ...placedOrder, fulfilment: 'collect' }}
      shopName="Hodan Grocery"
      collectAddress={null}
      colors={palette}
    />
  );

  expect(getByText(/ready to collect/)).toBeTruthy();
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npx jest -t "where to come"
```

Expected: FAIL — the address is not rendered.

- [ ] **Step 3: Add the prop and the sentence**

In `src/components/storefront/order-placed.tsx`, add to `Props`:

```ts
  // Where to come and get it, for a collect order. Null when the shop has no
  // address on file, in which case the sentence falls back to what it said
  // before -- a promise of a phone call, which is at least true.
  collectAddress?: string | null;
```

Update the signature and the `nextStep` expression:

```ts
export function OrderPlaced({ order, shopName, collectAddress, colors }: Props) {
  const nextStep =
    order.fulfilment === 'deliver'
      ? `${shopName} will call you to arrange delivery${order.deliveryArea ? ` to ${order.deliveryArea}` : ''}.`
      : collectAddress
        ? `${shopName} will call you when your order is ready. Collect from ${collectAddress}.`
        : `${shopName} will call you when your order is ready to collect.`;
```

- [ ] **Step 4: Run the tests**

```bash
npx jest -t "where to come" && npx jest -t "no address on file" && npx tsc --noEmit
```

Expected: PASS, PASS, exit 0.

- [ ] **Step 5: Pass it in from the caller**

Find where `OrderPlaced` is rendered (it is downstream of `src/app/store/[slug].tsx`, alongside
`CheckoutForm`) and pass `collectAddress={state.shop.collectAddress}` on the same prop path Task 4
established.

- [ ] **Step 6: Run the whole suite**

```bash
npm test && npx tsc --noEmit
```

Expected: no new failures, exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/components/storefront/order-placed.tsx src/components/__tests__/
git commit -m "Say where to collect from, not just that we will call

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Verification of the whole part

- [ ] **Database**

```bash
npm run test:db 2>&1 | grep -c FAIL
```

Expected: `0`.

- [ ] **App**

```bash
npm test && npx tsc --noEmit && npm run lint
```

Expected: all pass.

- [ ] **On a device.** Per the project's testing skill, native behaviour is verified in the running
  app, not by reading code. Use `/testing-kaiibi` for web plus at least one native platform, and
  check by hand:
  1. A shop with delivery **off** — the checkout shows "Store pick-up" with the address, and the
     confirmation names it.
  2. A shop with delivery **on** and an area priced — both choices render, delivery still works.
  3. A location with **require_open_register on** — a `ready` order completes from the Orders
     screen, and the POS at that same location still refuses a sale with no open register.

## Spec coverage

| Spec requirement (Part 0) | Task |
|---|---|
| `complete_sale` gains `p_require_register`, default `true` | 1 |
| `complete_storefront_order` passes `false` | 1 |
| Attach the completer's open session when one exists | 1 |
| POS guard demonstrably unchanged | 1, check 46 |
| Raw register message never reaches the phone | Resolved by construction — the storefront path no longer raises it. No mapping needed |
| Fulfilment choice always rendered | 4 |
| Deliver omitted, never disabled | 4 |
| Renamed to "Store pick-up" | 4 |
| Address on `order-placed.tsx` | 5 |
| Address in `get_public_storefront` | 2, 3 |
| Address in `get_public_order` | **Not this plan** — that RPC does not exist until Part 3 |
| Multi-branch location bug | **Out of scope**, logged in the spec |

## Correction to the spec

The spec's order-of-work table lists Part 0b as "Migration: No". That is wrong — 0b needs
`get_public_storefront` to return the address (Task 2), which is a migration. Update that row when
this plan is accepted.
