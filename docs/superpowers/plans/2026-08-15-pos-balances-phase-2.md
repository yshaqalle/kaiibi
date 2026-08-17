# POS Balances Implementation Plan (Phase 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Phase 1 is [`2026-08-15-pos-current-sale-phase-1.md`](./2026-08-15-pos-current-sale-phase-1.md)** and shipped without any of this — PR #56, merged 16 Aug as `c2dad47`. Its surfaces are what this plan drops controls into, so read that plan's verification log before starting.

**Goal:** Let a sale be paid in part or not at all, carry what is left as a balance against a named customer, and let that customer pay it off at the till later — with the shop able to see who owes what.

**Architecture:** A balance is **not a new ledger**. A sale already knows what it came to, what came back, and what was taken — so the balance is the arithmetic between those three (`total_cents` less `refunds` less `sale_payments`), and settling is inserting another `sale_payments` row against an *older* sale. That choice is what keeps this from becoming an accounts-receivable subsystem: no parallel truth to reconcile, one place a payment lives, and Accounting reads the same rows the till wrote. Three server changes carry it — `complete_sale` stops demanding payments equal the total when a customer is attached, a new `settle_sale_balance` RPC records later payments, and a view exposes what is outstanding.

**Tech Stack:** Supabase Postgres (plpgsql, RLS), Expo SDK 57 / React Native, TypeScript, Jest.

## Global Constraints

- **Expo docs:** read the exact versioned docs at https://docs.expo.dev/versions/v57.0.0/ before writing any code that touches an Expo API (`AGENTS.md`).
- **Postgres work:** load the `supabase:supabase-postgres-best-practices` skill before writing any migration, RLS policy or index in this plan.
- **Migration numbering:** the newest existing migration is still `20260830000000_platform_shop_people.sql` as of `5fe4837` (PR #57, the refund reporting work, added none). This plan uses `20260831000000` and `20260831000100`. Re-check `ls supabase/migrations | tail -1` before creating either — another session may have landed one first.
- **This repo re-creates functions in full.** `complete_sale` is redefined wholesale by each migration that touches it; the newest definition lives in `supabase/migrations/20260826000100_sale_promotion_attribution.sql` (`complete_sale` and `edit_sale` both). Copy the current body forward verbatim and change only what each task names — never hand-write a fresh body.
- **The guard being changed is deliberate.** `raise exception 'payments total % does not match sale total %'` protects against a client under-charging by accident. It is not being removed; it is being made conditional on an explicit, named intent.
- **A balance always has a name against it.** No customer, no credit — an unpaid sale with nobody attached is a loss, not a debt, and the RPC must refuse it rather than the UI merely discouraging it.
- **Money is integer cents.** No numeric, no rounding in the client.
- **Never hardcode a hex in a screen**; POS and Accounting read `Colors.light` bento tokens.
- **Tests:** `npm test` (112 suites / 1599 tests after Phase 1, ~3s). Pure logic in `src/lib/__tests__/`; components with `react-test-renderer` wrapped in `act`, joining text nodes with `''` before asserting on anything interpolated.
- **Never `git add -A`** — a concurrent session may share this repository (one has been running refunds against `yusefshop` throughout Phase 1). Never push without being asked.
- **`pos.tsx` carries 10 pre-existing `react-compiler` errors.** Count them before and after; the gate is that this work adds none.

## What Phase 1 already left you

Read these before writing anything — every task below plugs into them rather than
inventing a parallel path.

| Ships in Phase 1 | What Phase 2 does with it |
|---|---|
| `src/lib/checkout-intent.ts` — one pure function both surfaces put on their button | Task 4 adds the credit branches. Nothing else composes a button label |
| `src/lib/checkout-errors.ts` — `extractErrorMessage`, `isClosedRegisterError`, `checkoutErrorMessage` | Add the new server refusals here, with a test. A raw RPC sentence must never reach a cashier |
| `CustomerBlock` / `PaymentBlock` (exported from `checkout-panel.tsx`) | The balance row goes inside `CustomerBlock`; the rest-choice goes inside `PaymentBlock`. Both surfaces then get it for free |
| `SalePanel`'s pinned foot (`grandHTML` equivalent: total + action) | The "owed after this sale" line belongs in that pinned block, not in the scroller |
| `checkout(retryOnSession?)` in `pos.tsx` | Already takes an argument and is wired through arrows. Keep that shape — a bare handler passes a press event |
| `src/lib/held-orders.ts` — parked sales, per user and till, in AsyncStorage | A hold still reserves nothing. If Phase 2 ever reserves stock, holds move to the server first |
| `DualAmount` + `display-currency.ts` | Every new figure (owed, settled, balance due) takes the same treatment: dollars, and the shop's own currency underneath |

## The data model, settled first

| Question | Answer this plan commits to |
|---|---|
| Where does a balance live? | Derived: `sales.total_cents - sum(sale_payments.amount_cents)`. Never stored twice |
| How is a part-paid sale recognised? | `sales.settled_at is null and paid < total`. A generated column `sales.amount_paid_cents` is **not** used — a payment row must not require a write to two tables |
| What records a later payment? | Another `sale_payments` row on the same sale, stamped by its own `created_at` and carrying `register_session_id` |
| Who may owe? | Only `sales.customer_id is not null`. The RPC enforces it |
| What does Accounting read? | `public.customer_balances`, a view over the same rows |
| What about refunds? | **Not out of scope any more** — see the section below. A refund reduces what is owed before it pays anything back |

## Refunds change the arithmetic — read this before Task 1

`refunds` (and `refund_items`) already exist: `supabase/migrations/20260802015200_refunds.sql`,
one row per refund with `sale_id` and `total_cents`, line-level through
`refund_items`, so a sale can be partly returned. PR #57 (merged 16 Aug) fixed how
refunds report through Dashboard, Accounting and People.

That breaks the naive balance. A sale of $84.74 with $50 taken owes $34.74 — but if
$30 of it comes back over the counter tomorrow, the shop must not keep chasing the
customer for the full $34.74. **What is owed is what the sale came to, less what was
returned, less what was taken:**

```
owed = sales.total_cents - refunds.total_cents - sale_payments.amount_cents
```

Two consequences this plan commits to:

1. **The `customer_balances` view must subtract refunds**, or a returned basket keeps
   showing as a debt. The definition in Task 1 does this, and Task 1 grew a step that
   proves it against a part-paid, part-refunded sale.
2. **A refund on an unpaid sale pays nothing out.** Money that was never taken cannot
   be handed back: the refund cancels the debt first, and only a genuine excess
   reaches the drawer. The refund RPC does not know about balances today, so Task 2
   states the rule and Task 8 checks it on a real sale.

Neither is a new feature. Both are the arithmetic being right about something the
shop can already do.

## File Structure

| File | Responsibility |
|---|---|
| `supabase/migrations/20260831000000_sale_balances.sql` | **Shipped `5c5182f`.** `sale_payments.register_session_id`, `sales.settled_at`, the `customer_balances` view, the `customers.view` read widening, indexes |
| `supabase/migrations/20260831000100_complete_sale_allows_credit.sql` | `complete_sale` gains `p_allow_balance boolean`; `edit_sale` carries the same rule; `settle_sale_balance` RPC |
| `src/lib/balances.ts` | Client: read a customer's balance, list outstanding sales, settle |
| `src/lib/__tests__/balances.test.ts` | Its tests, against mocked Supabase responses |
| `src/lib/checkout-intent.ts` | Modify: the credit branches of the button's sentence |
| `src/lib/__tests__/checkout-intent.test.ts` | Modify: their tests |
| `src/components/pos/rest-choice.tsx` | "Collect it now" / "Pay later", and the balance being settled |
| `src/components/pos/customer-balance-row.tsx` | "Owes $34.74 · Collect it" under the attached customer |
| `src/components/receipt-modal.tsx` | Modify: the BALANCE DUE line |
| `src/components/accounting/receivables-tab.tsx` | Who owes what, and since when |
| `src/app/(admin)/(tabs)/pos.tsx` | Modify: wire the choice, the balance row and the settle path |

---

### Task 1: The schema a balance needs

**Files:**
- Create: `supabase/migrations/20260831000000_sale_balances.sql`

**Interfaces:**
- Produces: `sale_payments.register_session_id uuid`, `sales.settled_at timestamptz`, and `public.customer_balances (shop_id, customer_id, customer_name, sale_id, sale_created_at, total_cents, paid_cents, refunded_cents, owed_cents)`.

> **DONE** — shipped as `5c5182f`, verified against a database rebuilt from the
> whole migration chain by `supabase/tests/verify-balances.sql` (7 checks).
> Three departures from the SQL drafted below, all found by running it:
>
> 1. **`taken_at` is not there.** `sale_payments.created_at` already records when
>    the money arrived, so a second timestamp is the "stored twice" this plan's
>    own architecture note refuses — and `not null default now()` would have
>    stamped every historical payment with the migration's own clock. **Task 2's
>    `settle_sale_balance` therefore writes no `taken_at`, and anything ordering a
>    sale's payments reads `created_at`.** The `(sale_id, taken_at)` index went
>    with it; `sale_payments_sale_id_idx` from 0005 already covers the lookup.
> 2. **`read sale_payments` and `read refunds` had to be widened to
>    `customers.view`**, which the draft below missed entirely. 20260802030100
>    widened `sales` and `sale_items` to that key and left these two behind, so
>    the view — being `security_invoker` — returned `owed = total` to a role that
>    could see a sale but not its payments. Measured before the fix: **4000 owed
>    on a sale owing 500**, no error raised. `verify-balances.sql` check 6 pins it.
> 3. **The backfill stamps what the payments actually cover** rather than
>    asserting every older sale is paid, so it is idempotent and checkable.
>
> The view also left-joins `customers` and coalesces the name, because `read
> customers` needs `customers.view`/`pos.access`/`sales.edit` — a receivables
> reader holding only `sales.view` would otherwise have every row vanish.

- [x] **Step 1: Read the current shape**

Run: `grep -rn "create table public.sale_payments" -A 20 supabase/migrations/0005_sale_payments.sql`
Confirm the column list before adding to it, and confirm `sales` has `customer_id` (added in `0007_sale_customer.sql`).

- [x] **Step 2: Write the migration**

Shipped as `supabase/migrations/20260831000000_sale_balances.sql` — **read that
file, not a draft of it.** It differs from what was sketched here in the three
ways listed at the top of this task, and `sale_payments.taken_at` in particular
does not exist, so anything below that referenced it would not compile.

- [x] **Step 3: Apply it and check all three directions**

Done as `supabase/tests/verify-balances.sql`, following the repo's `verify-*.sql`
convention rather than the hand-typed psql sketched here — 7 checks inside one
rolled-back `DO` block:

```bash
npx supabase db reset --local     # proves the whole chain still applies
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
  -f supabase/tests/verify-balances.sql
```

Beyond the three directions asked for, it pins the two failures that do not
raise: **two payments against one refund** (the cross product that counts the
refund twice) and **a `customers.view`-only role** reading the balance. Both were
confirmed to fail before the fix and pass after — reverting just the two policies
makes check 6 report `owed 4000` on a sale owing `500`.

One neighbouring script, `verify-loyalty.sql` check 11, fails — and fails
identically on `main` with this migration removed. Pre-existing, untouched, and
worth its own look.

- [x] **Step 4: Commit**

```bash
git add supabase/migrations/20260831000000_sale_balances.sql
git commit -m "feat(db): a sale knows when it was settled, and what is still owed on it"
```

---

### Task 2: `complete_sale` accepts a shortfall, on purpose

**Files:**
- Create: `supabase/migrations/20260831000100_complete_sale_allows_credit.sql`

> **DONE** — shipped as `962f11a`
> (`supabase/migrations/20260831000100_complete_sale_allows_credit.sql`), proved by
> checks 8–17 of `supabase/tests/verify-balances.sql` on a database rebuilt from
> the whole chain. Three things the plan did not cover:
>
> 1. **`edit_sale` had to stop deleting settlement payments.** It wipes a sale's
>    `sale_payments` and re-inserts whatever the client sent — lossless while
>    every payment arrived at the till in one go, destructive the moment money can
>    arrive days later. Measured by reverting the one `where` clause: **the
>    settlement row disappears**, and a customer who had paid 800 is back to owing
>    2000 with no record they ever paid. `sale_payments.is_settlement` (added by
>    this migration) marks them — flagged rather than inferred from timestamps,
>    because `complete_sale` takes `p_created_at` and a sale can be backdated.
> 2. **Both functions are `drop`ped first.** `create or replace` with an extra
>    defaulted parameter does not replace anything — it adds an overload, and
>    every existing 13-argument call then resolves to two candidates and fails as
>    ambiguous. 0005 set this precedent.
> 3. **`settle_sale_balance` gates on `pos.access`/`sales.edit`, not
>    `is_shop_member`**, and validates the register session the way `complete_sale`
>    does. Reading a balance is not permission to take money, and a settlement
>    filed into a closed drawer is the failure Phase 1 built a recovery path for,
>    arriving by a new road.
>
> **Loyalty now waits for payment** (`219da61`, checks 18–21). Goods on account
> earn nothing until the sale is settled — otherwise credit plus redemption is a
> way to take value out of the shop and never pay for it. The rate is still frozen
> at ring-up, so settling earns what was promised at the till rather than what the
> shop offers that day, and `sales.points_earned` keeps meaning points *credited*
> so the refund clawback proportions against the right base. A sale returned
> against before it was settled earns nothing at all.
>
> That work turned up **a guard that was lost rather than written**: only matured
> points may be redeemed. It shipped in `20260820000100`, was dropped when
> `20260822000000` copied `complete_sale` forward from an older ancestor, and has
> been missing since — the maturation window has not been enforced in production.
> `verify-loyalty` check 11 had been failing on `main` for exactly this reason,
> and that failure was hiding checks 12–14. Restored here; **the whole database
> suite now passes for the first time.**
>
> Worth noting for the rest of this plan: that is two separate bugs caused by the
> copy-forward convention, in one function, found within a day of each other.

**Interfaces:**
- Produces:
  - `complete_sale(..., p_allow_balance boolean default false)` — same signature as today plus one trailing argument, so existing callers are unaffected.
  - `settle_sale_balance(p_sale_id uuid, p_payments jsonb, p_register_session_id uuid default null) returns integer` — returns the cents still owed after the payments land.

- [x] **Step 1: Copy the current definitions forward**

Copy `complete_sale` and `edit_sale` verbatim from `supabase/migrations/20260826000100_sale_promotion_attribution.sql` into the new migration. Do not retype them.

- [x] **Step 2: Change exactly three things in `complete_sale`**

1. Add the trailing parameter `p_allow_balance boolean default false`.
2. Replace the guard:

```sql
  if v_payments_total <> v_total_cents then
    raise exception 'payments total % does not match sale total %', v_payments_total, v_total_cents;
  end if;
```

with:

```sql
  -- Over-payment is still always wrong: a till that takes more than the bill
  -- has a bug, not a credit.
  if v_payments_total > v_total_cents then
    raise exception 'payments total % is more than sale total %', v_payments_total, v_total_cents;
  end if;

  -- Under-payment is a decision, and it has to be an explicit one made against
  -- a named customer. Without both, this is the accident the old guard caught.
  if v_payments_total < v_total_cents then
    if not coalesce(p_allow_balance, false) then
      raise exception 'payments total % does not match sale total %', v_payments_total, v_total_cents;
    end if;
    if p_customer_id is null then
      raise exception 'a sale can only be left unpaid against a customer';
    end if;
  end if;
```

3. Stamp the settlement at the end of the `update public.sales set ...` statement:

```sql
    settled_at = case when v_payments_total >= v_total_cents then now() else null end
```

Apply the same three changes to `edit_sale`, whose guard is the same sentence — an edit that raises a sale's total above what was paid leaves a balance rather than failing.

- [x] **Step 3: State the refund rule in the settle path**

A refund on a sale that was never fully paid cannot hand back money that was never
taken. `settle_sale_balance` therefore reads what is owed through the same
arithmetic as the view (total less refunds less payments), and the guard below
already covers it: `v_owed <= 0` refuses, and `v_taking > v_owed` refuses. Compute
`v_owed` with refunds subtracted, or a refunded sale will happily accept a
settlement for money the shop no longer expects.

- [x] **Step 4: Add the settle RPC**

```sql
create or replace function public.settle_sale_balance(
  p_sale_id uuid,
  p_payments jsonb,
  p_register_session_id uuid default null
) returns integer
language plpgsql security definer set search_path = public as $$
declare
  v_sale public.sales%rowtype;
  v_paid integer;
  v_refunded integer;
  v_owed integer;
  v_payment jsonb;
  v_taking integer := 0;
begin
  select * into v_sale from public.sales where id = p_sale_id for update;
  if not found then
    raise exception 'sale not found';
  end if;

  -- Membership is what RLS checks everywhere else in this schema; a payment
  -- against another shop's sale is not a permissions edge case, it is a bug.
  if not public.is_shop_member(v_sale.shop_id) then
    raise exception 'not a member of this shop';
  end if;

  select coalesce(sum(amount_cents), 0) into v_paid
    from public.sale_payments where sale_id = p_sale_id;
  select coalesce(sum(total_cents), 0) into v_refunded
    from public.refunds where sale_id = p_sale_id;
  -- Same arithmetic as customer_balances. Goods that came back are not owed.
  v_owed := v_sale.total_cents - v_refunded - v_paid;

  if v_owed <= 0 then
    raise exception 'this sale is already paid in full';
  end if;

  for v_payment in select * from jsonb_array_elements(p_payments) loop
    v_taking := v_taking + (v_payment->>'amount_cents')::integer;
  end loop;

  if v_taking <= 0 then
    raise exception 'a settlement has to take something';
  end if;
  if v_taking > v_owed then
    raise exception 'taking % is more than the % still owed', v_taking, v_owed;
  end if;

  for v_payment in select * from jsonb_array_elements(p_payments) loop
    insert into public.sale_payments
      (sale_id, method, amount_cents, tendered_cents, customer_name, customer_phone,
       currency_code, exchange_rate, foreign_amount_cents, foreign_change_cents,
       register_session_id)
    values
      (p_sale_id, v_payment->>'method', (v_payment->>'amount_cents')::integer,
       (v_payment->>'tendered_cents')::integer, v_payment->>'customer_name',
       v_payment->>'customer_phone', nullif(v_payment->>'currency_code', ''),
       (v_payment->>'exchange_rate')::numeric, (v_payment->>'foreign_amount_cents')::integer,
       (v_payment->>'foreign_change_cents')::integer, p_register_session_id);
  end loop;

  if v_taking = v_owed then
    update public.sales set settled_at = now() where id = p_sale_id;
  end if;

  return v_owed - v_taking;
end;
$$;

grant execute on function public.settle_sale_balance(uuid, jsonb, uuid) to authenticated;
```

Confirm `public.is_shop_member` is the helper this schema uses (`grep -rn "function public.is_shop_member" supabase/migrations | head -1`); if it is named differently, use the existing name rather than adding one.

- [x] **Step 4: Prove all four rules by hand**

In `psql`, against a seeded sale:

```sql
-- 1. under-payment without the flag is still refused
select public.complete_sale(...);                      -- expect: payments total ... does not match
-- 2. under-payment with the flag but no customer is refused
select public.complete_sale(..., p_allow_balance => true);  -- expect: only be left unpaid against a customer
-- 3. under-payment with both leaves a balance
select owed_cents from public.customer_balances where sale_id = '...';  -- expect the shortfall
-- 4. settling it clears the row and stamps the sale
select public.settle_sale_balance('...', '[{"method":"cash","amount_cents":3474}]'::jsonb);  -- expect 0
select settled_at is not null from public.sales where id = '...';  -- expect t
```

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260831000100_complete_sale_allows_credit.sql
git commit -m "feat(db): a sale may be left owing, against a named customer only"
```

---

### Task 3: `balances.ts` — the client's view of what is owed

**Files:**
- Create: `src/lib/balances.ts`
- Test: `src/lib/__tests__/balances.test.ts`

**Interfaces:**
- Produces:
  - `type CustomerBalance = { customerId: string; customerName: string | null; saleId: string; saleCreatedAt: string; owedCents: number }`
  - `customerBalance(shopId: string, customerId: string): Promise<{ owedCents: number; oldest: CustomerBalance | null; sales: CustomerBalance[] }>`
  - `listOutstanding(shopId: string): Promise<CustomerBalance[]>`
  - `settleBalance(saleId: string, payments: PaymentLine[], registerSessionId: string | null): Promise<number>`
  - `allocate(payments: PaymentLine[], sales: CustomerBalance[]): { saleId: string; payments: PaymentLine[] }[]` — **pure**, oldest sale first

- [x] **Step 1: Write the failing tests for `allocate`**

The only real logic on the client is which sale a settlement pays down when a customer owes on three. Oldest first, and never more than a sale owes.

```ts
import { allocate } from '@/lib/balances';

const owed = (saleId: string, owedCents: number, saleCreatedAt: string) => ({
  customerId: 'c1', customerName: 'Farah Hassan', saleId, saleCreatedAt, owedCents,
});
const cash = (amountCents: number) => ({ method: 'cash' as const, amountCents, tenderedCents: null,
  customerName: null, customerPhone: null, currencyCode: null, exchangeRate: null,
  foreignAmountCents: null, foreignChangeCents: null });

describe('allocate', () => {
  it('pays the oldest debt first', () => {
    const result = allocate([cash(1000)], [
      owed('new', 5000, '2026-08-14T10:00:00.000Z'),
      owed('old', 3474, '2026-08-12T10:00:00.000Z'),
    ]);
    expect(result).toEqual([{ saleId: 'old', payments: [cash(1000)] }]);
  });

  it('spills onto the next sale once one is cleared', () => {
    const result = allocate([cash(4000)], [
      owed('old', 3474, '2026-08-12T10:00:00.000Z'),
      owed('new', 5000, '2026-08-14T10:00:00.000Z'),
    ]);
    expect(result).toEqual([
      { saleId: 'old', payments: [cash(3474)] },
      { saleId: 'new', payments: [cash(526)] },
    ]);
  });

  it('takes nothing when nothing is owed', () => {
    expect(allocate([cash(1000)], [])).toEqual([]);
  });

  it('never allocates more than was handed over', () => {
    const result = allocate([cash(1000)], [owed('old', 3474, '2026-08-12T10:00:00.000Z')]);
    expect(result[0].payments[0].amountCents).toBe(1000);
  });
});
```

- [x] **Step 2: Run them and watch them fail**

Run: `npx jest src/lib/__tests__/balances.test.ts`
Expected: FAIL — `Cannot find module '@/lib/balances'`.

- [x] **Step 3: Write the module**

`allocate` is pure and sorts by `saleCreatedAt` ascending, splitting a payment across sales by cents. The three Supabase functions follow the shape of the other files in `src/lib/` — `customerBalance` and `listOutstanding` select from `customer_balances`; `settleBalance` calls the RPC and returns the remaining cents.

- [x] **Step 4: Run them and watch them pass**

Run: `npx jest src/lib/__tests__/balances.test.ts`
Expected: PASS, 4 tests.

- [x] **Step 5: Commit**

```bash
git add src/lib/balances.ts src/lib/__tests__/balances.test.ts
git commit -m "feat(pos): read what a customer owes, and pay the oldest of it first"
```

---

### Task 4: The button learns three more sentences

**Files:**
- Modify: `src/lib/checkout-intent.ts`
- Modify: `src/lib/__tests__/checkout-intent.test.ts`

**Interfaces:**
- `CheckoutIntentInput` gains `restOwed: boolean` and `settlingCents: number`.
- `checkoutIntent` gains the branches Phase 1 deliberately left out.

- [x] **Step 1: Add the failing tests**

```ts
it('takes part now and names what is left owing', () => {
  const intent = checkoutIntent({ ...base, payments: [payment('cash', 5000)],
    customerName: 'Farah Hassan', restOwed: true });
  expect(intent.label).toBe('Take $50.00 now · $34.74 owed');
  expect(intent.enabled).toBe(true);
});

it('refuses to leave a balance against nobody', () => {
  const intent = checkoutIntent({ ...base, payments: [payment('cash', 5000)], restOwed: true });
  expect(intent.label).toBe('Attach a customer to carry the balance');
  expect(intent.enabled).toBe(false);
});

it('saves a sale nobody paid for', () => {
  const intent = checkoutIntent({ ...base, customerName: 'Farah Hassan', restOwed: true });
  expect(intent.label).toBe('Save as unpaid · $84.74 owed');
});

it('takes money off an older balance with no basket', () => {
  const intent = checkoutIntent({ ...base, cartEmpty: true, totalCents: 0, settlingCents: 3474,
    payments: [payment('cash', 3474)], customerName: 'Farah Hassan' });
  expect(intent.label).toBe('Take $34.74 off the balance');
});
```

- [x] **Step 2: Run, fail, implement, pass**

Run: `npx jest src/lib/__tests__/checkout-intent.test.ts`
Expected: FAIL, then PASS with all 14 tests once the branches are added. The ordering rule: `submitting` → empty (with nothing being settled) → no payments and nothing owed → `restOwed` branches → remaining > 0 → covered.

- [x] **Step 3: Commit**

```bash
git add src/lib/checkout-intent.ts src/lib/__tests__/checkout-intent.test.ts
git commit -m "feat(pos): the button says when money is being left owing"
```

---

### Task 5: The choice, and the customer who owes

**Files:**
- Create: `src/components/pos/rest-choice.tsx`
- Create: `src/components/pos/customer-balance-row.tsx`
- Modify: `src/app/(admin)/(tabs)/pos.tsx`
- Test: `src/components/__tests__/rest-choice.test.tsx`

- [x] **Step 1: Write the failing test for `RestChoice`**

It renders two options — **Collect it now** and **Pay later** — the second disabled with "Needs a customer" when none is attached, and it renders nothing at all when the payments already cover the bill.

- [x] **Step 2: Build both components**

`RestChoice` is two tiles on `bentoSoft`, the chosen one on `bentoAccentWash` with `bentoAccentInk` text. `CustomerBalanceRow` shows `Owes $34.74`, when it has been owed since, and **Collect it** — and renders nothing when the balance is zero, so a shop with no credit never sees the feature.

- [x] **Step 3: Wire them into the panel and the sheet**

Both surfaces from Phase 1 take them as children — the panel's scrolling middle on a tablet, the sheet's payment block on a phone. The settle path works with an empty cart: `checkout()` branches to `settleBalance` when there are no items and `settlingCents > 0`.

- [x] **Step 4: Run the suite and commit**

```bash
npm test
git add src/components/pos/rest-choice.tsx src/components/pos/customer-balance-row.tsx src/components/__tests__/rest-choice.test.tsx "src/app/(admin)/(tabs)/pos.tsx"
git commit -m "feat(pos): take part of it now, and let them clear an old balance at the till"
```

---

### Task 6: The receipt carries the balance

**Files:**
- Modify: `src/components/receipt-modal.tsx`
- Modify: `src/lib/receipt.ts`

- [x] **Step 1: Extend `ReceiptData`**

Add `balanceDueCents: number` and `olderBalancePaidCents: number`, both defaulting to 0 so every existing caller is unchanged.

- [x] **Step 2: Print them in the paper's own idiom**

A boxed `BALANCE DUE` line with the customer's name when one remains.

> **Note on what shipped:** the planned `Older balance paid` row is NOT there. It
> only makes sense on a transaction that both sells goods and settles an older
> sale, and Task 5 deliberately restricted settlement to an **empty basket** — two
> RPCs in one tap is not atomic, and splitting one tender between a sale and a
> debt is arithmetic nobody asked for. The field was built, found to be
> unreachable, and removed rather than left as dead code with a passing test.
>
> A settlement therefore prints nothing at the till. It is not unevidenced: the
> payment lands in `sale_payments`, so **reprinting the settled sale's own receipt
> from Accounting shows it**, with `BALANCE DUE` reduced or gone — that is
> `buildReceiptFromSale`'s tested behaviour. An immediate proof-of-payment slip is
> a Phase 3 item, not a hole in this one. Monospace, dashed rule, same type scale as every other line — the receipt design does not change, it gains a line. `buildReceiptText` and `buildReceiptHtml` get the same two lines, or a WhatsApped receipt will disagree with the printed one.

- [x] **Step 3: Run the suite and commit**

```bash
npm test
git add src/components/receipt-modal.tsx src/lib/receipt.ts
git commit -m "feat(pos): a part-paid receipt says what is still owed, and by whom"
```

---

### Task 7: Accounting sees who owes what

**Files:**
- Create: `src/components/accounting/receivables-tab.tsx`
- Modify: `src/app/(admin)/(tabs)/accounting.tsx`

- [x] **Step 1: Build the tab**

A `BentoCard` with a `DataTable`: customer, what they owe, the oldest unpaid sale's date, and how many sales it spans. Read from `listOutstanding`. Follow the bento rules in the `building-bento-screens` skill — a ledger is read down a column, so it takes the full width and stays out of `BentoGrid`.

- [x] **Step 2: Add the total to the period strip**

One `StatTile`: **Owed to you**, with a `Caveat tone="context"` explaining that it is money already recognised as revenue, not a forecast — a shop owner reading it as extra income is the specific misunderstanding to prevent.

- [x] **Step 3: Run the suite and commit**

```bash
npm test
git add src/components/accounting/receivables-tab.tsx "src/app/(admin)/(tabs)/accounting.tsx"
git commit -m "feat(accounting): who owes the shop, and since when"
```

---

### Task 8: Verify it on the three platforms

**Automated verification — done.**

| Gate | Result |
|---|---|
| `npm test` | 118 suites / 1732 tests pass |
| `npm run test:db` | 10 checks pass, 3 named as not exercised (all pre-existing) |
| `verify-balances.sql` | 24 checks, on a database rebuilt from the whole migration chain |
| `npx tsc --noEmit` | clean |
| `pos.tsx` react-compiler errors | **9 — unchanged from before this branch**, rule sets diffed and identical |
| Migrations on the remote project | `20260831000000` and `20260831000100` applied; nothing pending |

**Interactive verification — web: DONE.**

Driven with Playwright against `yusefshop` on the real (migrated) database, on
2026-08-17. The whole flow, both halves:

| Step | Result |
|---|---|
| Attach a customer, balance row appears | `Owes $20.50 · since Aug 17 · Collect it` |
| "Collect it" on an empty till | `PAYMENT METHOD` renders, all four methods, cash prefilled to `20.50` |
| The row while collecting | `Take the payment below` + **Cancel** |
| Settle | balance row gone, no error |
| Receivables tab | `$0 · Nobody owes the shop anything` |
| Zero-down credit sale | `Carry $2.05 on Ali Warfa's account` → `Save as unpaid · $2.05 owed` → completed |
| Receipt | boxed `BALANCE DUE $2.05` / `Owed by Ali Warfa`, under an unchanged `TOTAL $2.05` |
| Receivables tab, with data | `Ali Warfa · $2.05 · Aug 17 · today`, `from 1 customer` |
| Transactions ledger | reads `Unpaid`, no `undefined` anywhere |
| Ledger search for "unpaid" | filters to that sale — the line that would have crashed before `paymentLabel` |
| Second settlement | clean; register went `3 sales · $20.50` → `4 sales · $43.05`, i.e. both settlements counted |
| Console | no errors; only the repo's pre-existing `shadow*` deprecation warning |

Every one of the eleven review findings was exercised through the UI rather than
only through a test.

**Two defects the pass found, both fixed:**

1. **The pinned total read `$0.00` while collecting $20.50.** The most prominent
   figure on the panel, disagreeing with the only one that mattered. `SalePanel`
   now takes `dueCents`.
2. **The register header did not refresh after a settlement.** It caught up on the
   next focus, so a cashier reconciling a drawer read a figure short by whatever
   they had just collected. `settleOlderBalance` now calls `reloadRegister()`.

**Interactive verification — iPhone and Android: DONE.**

Driven 2026-08-17 against the same migrated database. iOS via Maestro on an
iPhone 16 Pro (iOS 18.3); Android via `scripts/droid.sh` on the Pixel 8, which
gives a real element tree.

| Step | iPhone | Android |
|---|---|---|
| "Or settle a customer's account" on an idle till | renders, taps | renders, `clickable=true` |
| Sheet opens and STAYS open | ✓ | ✓ |
| No dangling `PAYMENT METHOD` header | ✓ (`assertNotVisible`) | ✓ |
| Customer picker opens, searches, attaches | ✓ | ✓ |
| Balance row | `Owes $14.35 · since Aug 17 · Collect it` | `Owes $6.15` |
| "Collect it" reveals the methods, row offers **Cancel** | ✓ | ✓ (`Button 'Cancel'`) |
| `Take $X off the balance` | ✓ | ✓ |
| Settlement completes, balance clears, no error | ✓ | ✓ |
| Pay-later card with no customer opens the picker | — | ✓ |
| Zero-down credit sale | — | ✓ |
| Receipt's boxed `BALANCE DUE` / `Owed by` | — | ✓, identical to web |
| Accessibility role on the pay-later control | — | exposed as `Switch` |

**The register's takings reconcile across all three platforms:** $43.05 after the
web pass, + $14.35 settled on iPhone, + $6.15 settled on Android = **$63.55**,
which is what the till reads. That is migration 20260831000300 working on real
data on every surface.

**Two defects this pass found, both fixed:**

1. **Settling was completely unreachable on a phone.** The counter's fix did not
   carry: on compact there is no customer row on the panel, and the only route to
   the picker is the checkout sheet — whose button is disabled on an empty till.
   So a phone could take credit and never collect it. An idle phone till now
   offers "Or settle a customer's account", and `settleIntent` keeps the sheet
   from dismissing itself before a customer has even been chosen.
2. **A dangling `PAYMENT METHOD` header.** The picker draws its heading
   unconditionally and its buttons only while something is owed, so the sheet
   opened on a section header above blank space. `showPayment` gates the whole
   block on the same condition the counter uses.

Both were invisible to every test and to the web pass, because the web pass ran
at counter width.

**Still not exercised:**

| Platform | State |
|---|---|
| iPad | **not exercised.** A tablet renders the counter layout, which the web pass covers at the same width — but the sidebar shell and the sheet-vs-inline switch are its own thing |
| Android tablets (11", 14") | **not exercised.** Same reason, and `scripts/droid.sh -t 11` can drive them |

Correction to an earlier note in this plan: iOS taps ARE available here. Maestro
has been installed since 2026-08-09 and drove the whole flow above; the
"unavailable" line came from the skill's older summary rather than
`references/drivers.md`.

Phase 1's own outstanding native pass is inherited by this branch and is the same
piece of work.

**Test artefacts left on `yusefshop`:** one $2.05 sale against Ali Warfa
("another item"), taken on credit and then settled in cash, plus a $20.50
settlement of a balance that already existed. Both accounts are clear; nothing is
outstanding.
