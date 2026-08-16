# POS Balances Implementation Plan (Phase 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Phase 1 is [`2026-08-15-pos-current-sale-phase-1.md`](./2026-08-15-pos-current-sale-phase-1.md)** and ships without any of this. It is built and open as PR #56; do not start Phase 2 until that merges, because this plan drops controls into the surfaces it composes.

**Goal:** Let a sale be paid in part or not at all, carry what is left as a balance against a named customer, and let that customer pay it off at the till later — with the shop able to see who owes what.

**Architecture:** A balance is **not a new ledger**. A sale already has `total_cents` and a `sale_payments` list; the balance is the arithmetic between them, and settling is inserting another `sale_payments` row against an *older* sale. That choice is what keeps this from becoming an accounts-receivable subsystem: no parallel truth to reconcile, one place a payment lives, and Accounting reads the same rows the till wrote. Three server changes carry it — `complete_sale` stops demanding payments equal the total when a customer is attached, a new `settle_sale_balance` RPC records later payments, and a view exposes what is outstanding.

**Tech Stack:** Supabase Postgres (plpgsql, RLS), Expo SDK 57 / React Native, TypeScript, Jest.

## Global Constraints

- **Expo docs:** read the exact versioned docs at https://docs.expo.dev/versions/v57.0.0/ before writing any code that touches an Expo API (`AGENTS.md`).
- **Postgres work:** load the `supabase:supabase-postgres-best-practices` skill before writing any migration, RLS policy or index in this plan.
- **Migration numbering:** the newest existing migration is `20260830000000_platform_shop_people.sql`. This plan uses `20260831000000` and `20260831000100`. Re-check `ls supabase/migrations | tail -1` before creating either — another session may have landed one first.
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
| What records a later payment? | Another `sale_payments` row on the same sale, with `taken_at` and `register_session_id` |
| Who may owe? | Only `sales.customer_id is not null`. The RPC enforces it |
| What does Accounting read? | `public.customer_balances`, a view over the same rows |
| What about refunds? | Out of scope. A negative balance is refused by the same check that refuses over-payment |

## File Structure

| File | Responsibility |
|---|---|
| `supabase/migrations/20260831000000_sale_balances.sql` | `sale_payments.taken_at` / `register_session_id`, `sales.settled_at`, the `customer_balances` view, RLS, indexes |
| `supabase/migrations/20260831000100_complete_sale_allows_credit.sql` | `complete_sale` gains `p_allow_balance boolean`; `edit_sale` carries the same rule; `settle_sale_balance` RPC |
| `src/lib/balances.ts` | Client: read a customer's balance, list outstanding sales, settle |
| `src/lib/__tests__/balances.test.ts` | Its tests, against mocked Supabase responses |
| `src/lib/checkout-intent.ts` | Modify: the credit branches of the button's sentence |
| `src/lib/__tests__/checkout-intent.test.ts` | Modify: their tests |
| `src/components/pos/rest-choice.tsx` | "Collect it now" / "Pay later", and the balance being settled |
| `src/components/pos/customer-balance-row.tsx` | "Owes $34.74 · Collect it" under the attached customer |
| `src/components/receipt-modal.tsx` | Modify: the BALANCE DUE line and "older balance paid" |
| `src/components/accounting/receivables-tab.tsx` | Who owes what, and since when |
| `src/app/(admin)/(tabs)/pos.tsx` | Modify: wire the choice, the balance row and the settle path |

---

### Task 1: The schema a balance needs

**Files:**
- Create: `supabase/migrations/20260831000000_sale_balances.sql`

**Interfaces:**
- Produces: `sale_payments.taken_at timestamptz not null default now()`, `sale_payments.register_session_id uuid`, `sales.settled_at timestamptz`, and `public.customer_balances (shop_id, customer_id, customer_name, sale_id, sale_created_at, total_cents, paid_cents, owed_cents)`.

- [ ] **Step 1: Read the current shape**

Run: `grep -rn "create table public.sale_payments" -A 20 supabase/migrations/0005_sale_payments.sql`
Confirm the column list before adding to it, and confirm `sales` has `customer_id` (added in `0007_sale_customer.sql`).

- [ ] **Step 2: Write the migration**

Create `supabase/migrations/20260831000000_sale_balances.sql`:

```sql
-- A balance is arithmetic, not a second ledger: what a sale came to, less what
-- has been taken against it. Storing it as a column would mean every payment
-- had to write two places and could disagree with itself.

alter table public.sale_payments
  add column if not exists taken_at timestamptz not null default now(),
  add column if not exists register_session_id uuid references public.register_sessions(id) on delete set null;

-- Stamped when the last of a sale's money arrives. Null on a sale that is
-- still owed, which is what makes "who owes me" a cheap index scan rather than
-- a sum over every payment row in the shop's history.
alter table public.sales
  add column if not exists settled_at timestamptz;

-- Everything already paid in full is settled as of its own creation, so the
-- new column never reads as "the whole history is outstanding".
update public.sales s set settled_at = s.created_at
where s.settled_at is null;

create index if not exists sales_unsettled_idx
  on public.sales (shop_id, customer_id)
  where settled_at is null;

create index if not exists sale_payments_sale_taken_idx
  on public.sale_payments (sale_id, taken_at);

create or replace view public.customer_balances as
select
  s.shop_id,
  s.customer_id,
  s.customer_name,
  s.id as sale_id,
  s.created_at as sale_created_at,
  s.total_cents,
  coalesce(sum(p.amount_cents), 0)::integer as paid_cents,
  (s.total_cents - coalesce(sum(p.amount_cents), 0))::integer as owed_cents
from public.sales s
left join public.sale_payments p on p.sale_id = s.id
where s.settled_at is null
  and s.customer_id is not null
group by s.shop_id, s.customer_id, s.customer_name, s.id, s.created_at, s.total_cents
having (s.total_cents - coalesce(sum(p.amount_cents), 0)) > 0;

-- The view inherits the underlying tables' RLS through security_invoker, so a
-- staff member sees exactly the sales they could already read.
alter view public.customer_balances set (security_invoker = on);

grant select on public.customer_balances to authenticated;
```

- [ ] **Step 3: Apply it and check both directions**

Run: `npx supabase db reset` (local) or `npx supabase migration up`.
Then, in `psql`:

```sql
-- A fully paid sale is not a balance.
select count(*) from public.customer_balances;  -- expect 0 on seed data
```

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260831000000_sale_balances.sql
git commit -m "feat(db): a sale knows when it was settled, and what is still owed on it"
```

---

### Task 2: `complete_sale` accepts a shortfall, on purpose

**Files:**
- Create: `supabase/migrations/20260831000100_complete_sale_allows_credit.sql`

**Interfaces:**
- Produces:
  - `complete_sale(..., p_allow_balance boolean default false)` — same signature as today plus one trailing argument, so existing callers are unaffected.
  - `settle_sale_balance(p_sale_id uuid, p_payments jsonb, p_register_session_id uuid default null) returns integer` — returns the cents still owed after the payments land.

- [ ] **Step 1: Copy the current definitions forward**

Copy `complete_sale` and `edit_sale` verbatim from `supabase/migrations/20260826000100_sale_promotion_attribution.sql` into the new migration. Do not retype them.

- [ ] **Step 2: Change exactly three things in `complete_sale`**

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

- [ ] **Step 3: Add the settle RPC**

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
  v_owed := v_sale.total_cents - v_paid;

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
       taken_at, register_session_id)
    values
      (p_sale_id, v_payment->>'method', (v_payment->>'amount_cents')::integer,
       (v_payment->>'tendered_cents')::integer, v_payment->>'customer_name',
       v_payment->>'customer_phone', nullif(v_payment->>'currency_code', ''),
       (v_payment->>'exchange_rate')::numeric, (v_payment->>'foreign_amount_cents')::integer,
       (v_payment->>'foreign_change_cents')::integer, now(), p_register_session_id);
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

- [ ] **Step 4: Prove all four rules by hand**

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

- [ ] **Step 1: Write the failing tests for `allocate`**

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

- [ ] **Step 2: Run them and watch them fail**

Run: `npx jest src/lib/__tests__/balances.test.ts`
Expected: FAIL — `Cannot find module '@/lib/balances'`.

- [ ] **Step 3: Write the module**

`allocate` is pure and sorts by `saleCreatedAt` ascending, splitting a payment across sales by cents. The three Supabase functions follow the shape of the other files in `src/lib/` — `customerBalance` and `listOutstanding` select from `customer_balances`; `settleBalance` calls the RPC and returns the remaining cents.

- [ ] **Step 4: Run them and watch them pass**

Run: `npx jest src/lib/__tests__/balances.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

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

- [ ] **Step 1: Add the failing tests**

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

- [ ] **Step 2: Run, fail, implement, pass**

Run: `npx jest src/lib/__tests__/checkout-intent.test.ts`
Expected: FAIL, then PASS with all 14 tests once the branches are added. The ordering rule: `submitting` → empty (with nothing being settled) → no payments and nothing owed → `restOwed` branches → remaining > 0 → covered.

- [ ] **Step 3: Commit**

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

- [ ] **Step 1: Write the failing test for `RestChoice`**

It renders two options — **Collect it now** and **Pay later** — the second disabled with "Needs a customer" when none is attached, and it renders nothing at all when the payments already cover the bill.

- [ ] **Step 2: Build both components**

`RestChoice` is two tiles on `bentoSoft`, the chosen one on `bentoAccentWash` with `bentoAccentInk` text. `CustomerBalanceRow` shows `Owes $34.74`, when it has been owed since, and **Collect it** — and renders nothing when the balance is zero, so a shop with no credit never sees the feature.

- [ ] **Step 3: Wire them into the panel and the sheet**

Both surfaces from Phase 1 take them as children — the panel's scrolling middle on a tablet, the sheet's payment block on a phone. The settle path works with an empty cart: `checkout()` branches to `settleBalance` when there are no items and `settlingCents > 0`.

- [ ] **Step 4: Run the suite and commit**

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

- [ ] **Step 1: Extend `ReceiptData`**

Add `balanceDueCents: number` and `olderBalancePaidCents: number`, both defaulting to 0 so every existing caller is unchanged.

- [ ] **Step 2: Print them in the paper's own idiom**

Under the payment lines: an `Older balance paid` row when one was settled, and a boxed `BALANCE DUE` line with the customer's name when one remains. Monospace, dashed rule, same type scale as every other line — the receipt design does not change, it gains a line. `buildReceiptText` and `buildReceiptHtml` get the same two lines, or a WhatsApped receipt will disagree with the printed one.

- [ ] **Step 3: Run the suite and commit**

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

- [ ] **Step 1: Build the tab**

A `BentoCard` with a `DataTable`: customer, what they owe, the oldest unpaid sale's date, and how many sales it spans. Read from `listOutstanding`. Follow the bento rules in the `building-bento-screens` skill — a ledger is read down a column, so it takes the full width and stays out of `BentoGrid`.

- [ ] **Step 2: Add the total to the period strip**

One `StatTile`: **Owed to you**, with a `Caveat tone="context"` explaining that it is money already recognised as revenue, not a forecast — a shop owner reading it as extra income is the specific misunderstanding to prevent.

- [ ] **Step 3: Run the suite and commit**

```bash
npm test
git add src/components/accounting/receivables-tab.tsx "src/app/(admin)/(tabs)/accounting.tsx"
git commit -m "feat(accounting): who owes the shop, and since when"
```

---

### Task 8: Verify it on the three platforms

- [ ] **Step 1: Suite and linter**

Run: `npm test && npx eslint src --max-warnings=0`

- [ ] **Step 2: Drive the app** with `/testing-kaiibi` on web, iOS and Android:

1. a sale with no customer cannot be left unpaid — the button says so;
2. $50 of an $84.74 basket, marked Pay later, completes and prints `BALANCE DUE $34.74`;
3. that customer, attached to a new sale, shows `Owes $34.74`;
4. **Collect it** with an empty basket takes the money and prints a settlement receipt;
5. a second till cannot settle the same balance twice — the RPC refuses with "already paid in full";
6. Accounting's receivables total matches the sum of the outstanding rows.

- [ ] **Step 3: Commit any fixes**

---

## Self-review

**Spec coverage.** Every deferred item from Phase 1's "Explicitly out of scope" table has a task: part payment (2, 4, 5), Pay later (2, 4, 5), settling an older balance (2, 3, 5), receivables (7), and the receipt's balance line (6).

**Known gaps, deliberately left.** Refunds and negative balances are out of scope and refused by the same checks. Partial settlement across more than one sale is handled by `allocate` (Task 3) but only surfaced as one figure in the UI — a per-sale breakdown is a follow-up, not a blocker. There is no reminder or messaging flow; that belongs with the marketing/campaign work, not here.

**Verify like Phase 1 did.** Every layout claim in Phase 1 that was proven only by tests turned out to have a bug in it; thirteen were found by driving the running app, four of which passed the whole suite. Use `/testing-kaiibi`, and read the result off the screen — a balance that "saved" is only real if it shows on the customer, on the receipt, and in Accounting.

**Type consistency.** `CustomerBalance` (Task 3) is consumed by Tasks 5 and 7. `CheckoutIntentInput`'s new fields (Task 4) are set by Task 5's controls. `settle_sale_balance`'s return (cents still owed) is what `settleBalance` returns and what Task 5 shows in its toast.
