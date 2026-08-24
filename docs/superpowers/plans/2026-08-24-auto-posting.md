# Auto-posting to the Ledger (Phase 2b) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every money-moving RPC writes a balanced journal entry as part of the same transaction, and every existing row is replayed into the ledger, so the trial balance reflects real trading rather than manual entries only.

**Architecture:** Seven existing RPCs each gain a posting side. No call site changes — the RPC boundary is already the seam. Two immutable mapping functions turn a payment method and an expense category into an account code, so the live path and the backfill cannot disagree. Idempotency is a `journal_entry_id` column on each source row: posted once, never twice. The backfill bypasses `post_journal_entry` deliberately and is the only thing that does.

**Tech Stack:** Postgres 15 (Supabase), plpgsql, TypeScript. No new dependencies.

## Global Constraints

Every task's requirements implicitly include this section.

### Baselines — green on `main` today

- `npx tsc --noEmit` → **clean**
- `npm test` → **139 suites, 2122 tests**
- `npm run lint` → **81 problems (49 errors, 32 warnings)**
- `npm run test:db` → **18 pass**

`npx supabase start` must be running for `npm run test:db`.

### The ledger interface, as built — not as the design describes it

Read from the shipped migrations, which are the truth where the phase-1 plan is the intent.

```sql
-- 20260904000500_journal_rpcs.sql:17
public.post_journal_entry(
  p_shop_id     uuid,
  p_entry_date  date,
  p_description text,
  p_lines       jsonb,
  p_location_id uuid default null,
  p_source      text default 'manual'
) returns uuid
```

**`p_lines` is an array of `{code, amount_cents, location_id?, memo?}`.** `code` is the account's four-digit `accounts.code`, not its id. `location_id` falls back to `p_location_id`.

Five rules the RPC enforces, each of which will reject a posting bug at write time:

| Rule | Message |
|---|---|
| At least two lines | `A journal entry needs at least two lines; this one has %.` |
| Lines sum to zero | `This entry does not balance: debits and credits differ by %.` |
| Every `code` exists and is not archived | `No such account: %. Check the chart of accounts.` |
| The period is open | `This period is % — posting into it is refused. Re-open it first.` |
| No line may be zero | `journal_lines.amount_cents` carries `check (amount_cents <> 0)` |

**Debit positive, credit negative.** From `journal_lines`:

> `-- Debit positive, credit negative. Never zero -- a zero line records nothing and two of them would sum to zero and pass the balance check.`

**`p_source = 'manual'` gates on `ledger.post`; any other value does not.** This is deliberate and is what makes this whole phase possible — the header says so:

> `-- A posting phase's RPC will call this with p_source <> 'manual' from inside its own security definer function, where the caller has already been gated on the permission that door needs -- a cashier completing a sale holds pos.access and must not need ledger.post.`

**Every posting call in this plan passes an explicit `p_source`.** Never `'manual'`. The values used here are `'sale'`, `'refund'`, `'settlement'`, `'receipt'`, `'bill_payment'`, `'payroll'`, `'count'`, `'backfill'`.

### The seeded chart of accounts

All 31 exist already, seeded per shop by `seed_shop_defaults` (`20260904000100`). The ones this phase posts to:

| Code | Name | Type |
|---|---|---|
| 1000 | Cash | asset |
| 1010 | Bank | asset |
| 1020 | Mobile Money — Zaad | asset |
| 1021 | Mobile Money — eDahab | asset |
| 1100 | Accounts Receivable | asset |
| 1200 | Inventory | asset |
| 2000 | Accounts Payable | liability |
| 2100 | Sales Tax Payable | liability |
| 2200 | Wages Payable | liability |
| 3100 | Owner's Draw | equity |
| 4000 | Sales Revenue | revenue |
| 4100 | Sales Returns | revenue |
| 4200 | Discounts Given | revenue |
| 5000 | Cost of Goods Sold | cost_of_sales |
| 5100 | Inventory Shrinkage | cost_of_sales |
| 6000–6900 | The nine expense accounts | expense |

### The copy-forward convention, and the test that guards it

This repo re-creates `complete_sale` and `edit_sale` **in full** in every migration that touches them. `supabase/tests/accumulated-rpc-edits.test.ts` asserts every edit ever made is still present in the newest definition, reading the migration text rather than the database.

**Task 3 must add an entry to `COMPLETE_SALE_EDITS`.** A migration that copies `complete_sale` forward and drops the posting side is exactly the failure that test exists to catch — it caught a lost loyalty guard that was unenforced for four migrations.

### Test conventions

- DB checks live in `supabase/tests/verify-*.sql`, **auto-discovered by glob**, and must print **`ALL CHECKS PASSED`**.
- Fixtures build in one `do $$ ... $$` block and roll back via an `exception` clause. Copy `verify-weighted-average.sql`.
- **These scripts run as `postgres`, so RLS never applies.** Assert policies against `pg_policies`, never by attempting the operation. Any RPC gating on `has_shop_permission` needs `set_config('request.jwt.claims', ...)` and `set_config('role', 'authenticated', ...)` first — and setting `role` turns RLS **on**, so raw inserts come before it.
- **A shop has no location until the fixture makes one.** `seed_shop_defaults` does not create one.
- **Every test step names the mutation that must turn it red.** Apply it, watch it fail, revert.
- **Choose numbers that cannot coincide.** Six tests on this project could not fail. Pick amounts where a wrong implementation gives a visibly different figure — never a round number that several wrong answers share.

### Migration rules this project has already paid for

- `pg_get_function_arguments`, **never** `pg_get_function_identity_arguments` — the identity form drops `DEFAULT` clauses and `CREATE OR REPLACE` refuses to remove defaults.
- Any migration granting a permission to a default role must **also update `default_shop_roles()`**, guarded so re-running is a no-op. *(No new permission is granted in this phase — posting happens under the permission the door already needs.)*

---

## What is NOT in this plan

Stated so a reviewer can see the edges rather than infer them.

| Not doing | Why |
|---|---|
| `create_bill`, `transfer_funds`, fixed assets, depreciation | New RPCs, phase 3. This phase adds a posting side to RPCs that **already exist**. |
| Balance sheet, cash flow, income statement, period close | Phase 3. They read what this phase writes. |
| **Cash becoming derived** | The stated *outcome* of 2b, but it is a read-side change to `cash_accounts` and the Overview screen. Doing it here would put a screen rewrite inside a posting plan. It needs the ledger populated first, which is what this plan delivers. |
| `refunds.reason`, `tax_filings` | Phase 5. |
| Removing the `sync_invoice_expense` trigger | The design calls for it, but it changes what `expenses` contains, which the backfill reads. Removing it in the same phase that replays history means the replay input changes underneath the verification. Do it in phase 3, once the ledger is the source of truth. |
| Loyalty liability (2300) | See **Open** below. |
| Editing or voiding a posted entry | `reverse_journal_entry` already exists from phase 1. Nothing here needs it. |

---

## Open — one decision, with a recommendation

**How a redeemed loyalty point posts.** `complete_sale` computes `v_redeem_cents` (points spent, reducing what the customer pays) and `v_points_earned` (points granted).

The design lists `2300 Loyalty Points Liability` and maps the loyalty ledger to it, but **the posting map in the mockup does not show loyalty on `complete_sale`**. So it is genuinely unspecified.

**Recommendation: post redemption to `4200 Discounts Given` in this phase, and leave `2300` untouched.**

The reason is that the two sides are not separable. Posting the redemption as a drawdown of `2300` without also posting the earn side as a liability accrual would drive the liability **negative** on the first redemption — a balance sheet line that is wrong in a direction nobody can explain. Posting both means deciding what the earn side costs (contra-revenue at redemption value, or an expense at cost), which is a real accounting decision and not one this plan should make silently on the hot path.

Treating a redeemed point as a discount is defensible, conventional for small retail, and **nets to the same profit**. It understates a liability that is currently not recorded at all, which is the status quo — not a regression.

**If the answer is instead "post both sides", say so before Task 3**, because it changes `complete_sale`'s entry and the backfill's replay of it, and retrofitting it after the backfill has run means re-running the backfill.

---

**An expense recorded after this phase will not post, and that has to be said out loud.**

Found while writing this plan, and it is a hole in the phase rather than a detail. The design's premise is *"every money move goes through an RPC, so the posting side is added inside the existing function and no call site changes."* That is true of all seven RPCs in scope — and **not true of expenses**, which are written by a plain `insert` from the client. There is no function to add a posting side to.

So Task 8 backfills every historical expense, and then the next expense a shop records goes unposted. The P&L would be complete up to the backfill date and progressively wrong after it — the worst of the three possible states, because it looks right.

Three ways out, in the order I would rank them:

1. **An `AFTER INSERT` trigger on `expenses`** that posts the entry. Small, closes the hole in this phase, and it is where the seam actually is. Against it: this codebase has deliberately put money logic in RPCs rather than triggers, and a trigger that can raise makes every expense insert able to fail on a ledger problem.
2. **Bring `create_bill` forward from phase 3** and route expense entry through it. Correct, and the design already wants it — but it is a new RPC plus a screen change, which is a phase-3-sized piece of work inside a phase-2b plan.
3. **Ship the hole and state it**: the Expenses screen carries a `Caveat tone="context"` saying expenses reach the books when the period closes, and a nightly job posts them. Honest, but it invents a job.

**Recommendation: (1), as a Task 7b.** It is roughly twenty lines, it uses the mapping Task 1 already builds, and it means the trial balance is complete on the day this phase ships rather than on the day phase 3 does.

**This needs a decision before Task 8**, because whichever way it goes the backfill's expense replay has to agree with it.

---

## File Structure

| File | Responsibility |
|---|---|
| `supabase/migrations/20260908000000_posting_account_map.sql` | The two mapping functions. Nothing else. |
| `supabase/migrations/20260908000100_posting_idempotency.sql` | `journal_entry_id` on eight source tables. |
| `supabase/migrations/20260908000200_post_complete_sale.sql` | `complete_sale`, copied forward with a posting side. |
| `supabase/migrations/20260908000300_post_refund_and_settlement.sql` | `refund_sale_items`, `settle_sale_balance`. |
| `supabase/migrations/20260908000400_post_receive_stock.sql` | `receive_stock`, copied forward from `20260907000000`. |
| `supabase/migrations/20260908000500_post_bills_and_payroll.sql` | `record_invoice_payment`, `post_payroll_run`. |
| `supabase/migrations/20260908000600_post_stock_count.sql` | `save_stock_count`. |
| `supabase/migrations/20260908000700_backfill_ledger.sql` | `backfill_shop_ledger(uuid)`. |
| `supabase/tests/verify-posting-map.sql` | Every enum value maps to a live account. |
| `supabase/tests/verify-posting-sales.sql` | Sale, credit sale, refund, settlement entries. |
| `supabase/tests/verify-posting-inventory.sql` | Receipt and stock-count entries. |
| `supabase/tests/verify-posting-bills.sql` | Invoice payment and pay run entries. |
| `supabase/tests/verify-backfill.sql` | The backfill ties to the cent, and is idempotent. |
| `supabase/tests/bench-complete-sale.sql` | Measured before/after on a 20-line basket. |

`test:db` goes from **18** to **23**. `bench-complete-sale.sql` carries `@no-verdict` so the runner skips it — it prints timings, it does not assert.

---

### Task 1: The account map

Two functions, because six RPCs and the backfill all need the same answer. Inline `case` expressions in seven places is how the live path and the replay come to disagree — and Task 8's verification would then compare two figures that are wrong in the same way and pass.

**Files:**
- Create: `supabase/migrations/20260908000000_posting_account_map.sql`
- Create: `supabase/tests/verify-posting-map.sql`

**Interfaces:**
- Produces: `public.account_code_for_payment_method(text) returns text`, `public.account_code_for_expense_category(text) returns text`. Both `immutable`, both raise on an unmapped value rather than returning null.

- [ ] **Step 1: Write the failing test**

Create `supabase/tests/verify-posting-map.sql`:

```sql
-- Every payment method and every expense category maps to an account that is
-- actually seeded. The point is the LAST check: it reads the enum values out of
-- the check constraint, so adding a thirteenth expense category without giving
-- it an account turns this red -- which no hand-written list of values would do.

\set ON_ERROR_STOP on

do $$
declare
  v_user_id uuid := gen_random_uuid();
  v_shop_id uuid;
  v_code    text;
  v_value   text;
  v_missing text := '';
begin
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
    values (v_user_id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            'verify-posting-map-' || v_user_id || '@example.test', '', now(), now(), now());
  insert into public.shops (owner_id, name) values (v_user_id, 'Map Shop') returning id into v_shop_id;

  -- 1. Payment methods. 'other' maps to Bank rather than Cash: a payment that
  --    is not cash and not one of the two named wallets is a transfer, and
  --    putting it in the till would make the drawer count disagree.
  if public.account_code_for_payment_method('cash')   <> '1000' then raise exception 'FAIL: cash'; end if;
  if public.account_code_for_payment_method('zaad')   <> '1020' then raise exception 'FAIL: zaad'; end if;
  if public.account_code_for_payment_method('edahab') <> '1021' then raise exception 'FAIL: edahab'; end if;
  if public.account_code_for_payment_method('other')  <> '1010' then raise exception 'FAIL: other'; end if;

  -- 2. The three that were never operating expenses. These are the whole reason
  --    a balance sheet is possible -- NON_OPERATING_CATEGORIES in
  --    expense-reporting.ts reaches the right net profit by excluding them,
  --    which is the right answer by the wrong route.
  if public.account_code_for_expense_category('inventory_purchase') <> '1200' then
    raise exception 'FAIL: inventory_purchase must be an ASSET, got %',
      public.account_code_for_expense_category('inventory_purchase');
  end if;
  if public.account_code_for_expense_category('owner_draw') <> '3100' then
    raise exception 'FAIL: owner_draw must be contra-equity, got %',
      public.account_code_for_expense_category('owner_draw');
  end if;
  if public.account_code_for_expense_category('stock_loss') <> '5100' then
    raise exception 'FAIL: stock_loss belongs in cost of sales, got %',
      public.account_code_for_expense_category('stock_loss');
  end if;

  -- 3. The nine that are.
  if public.account_code_for_expense_category('rent')                <> '6000' then raise exception 'FAIL: rent'; end if;
  if public.account_code_for_expense_category('utilities')           <> '6100' then raise exception 'FAIL: utilities'; end if;
  if public.account_code_for_expense_category('salaries_wages')      <> '6200' then raise exception 'FAIL: salaries_wages'; end if;
  if public.account_code_for_expense_category('marketing')           <> '6300' then raise exception 'FAIL: marketing'; end if;
  if public.account_code_for_expense_category('supplies')            <> '6400' then raise exception 'FAIL: supplies'; end if;
  if public.account_code_for_expense_category('transport_delivery')  <> '6500' then raise exception 'FAIL: transport_delivery'; end if;
  if public.account_code_for_expense_category('maintenance_repairs') <> '6600' then raise exception 'FAIL: maintenance_repairs'; end if;
  if public.account_code_for_expense_category('fees_charges')        <> '6700' then raise exception 'FAIL: fees_charges'; end if;
  if public.account_code_for_expense_category('other')               <> '6900' then raise exception 'FAIL: other'; end if;

  -- 4. An unmapped value RAISES rather than returning null. A null code reaches
  --    post_journal_entry as "No such account: <null>", which is a worse
  --    message at a later moment.
  begin
    v_code := public.account_code_for_expense_category('not_a_category');
    raise exception 'FAIL: an unknown category should raise, got %', v_code;
  exception when others then
    if sqlerrm !~ 'no account is mapped' then raise; end if;
  end;

  -- 5. THE ONE THAT MATTERS. Read the twelve values out of the check constraint
  --    itself and assert each maps to an account that is seeded for this shop.
  --    A hand-written list here would go stale the moment someone adds a
  --    category; this cannot.
  for v_value in
    select unnest(regexp_matches(
      (select pg_get_constraintdef(oid) from pg_constraint
        where conrelid = 'public.expenses'::regclass and conname like '%category%' limit 1),
      '''([a-z_]+)''', 'g'))
  loop
    begin
      v_code := public.account_code_for_expense_category(v_value);
    exception when others then
      v_missing := v_missing || v_value || ' (unmapped) ';
      continue;
    end;
    if not exists (select 1 from public.accounts
                    where shop_id = v_shop_id and code = v_code and archived_at is null) then
      v_missing := v_missing || v_value || ' -> ' || v_code || ' (no such account) ';
    end if;
  end loop;
  if v_missing <> '' then
    raise exception 'FAIL: expense categories with no usable account: %', v_missing;
  end if;

  raise notice 'ALL CHECKS PASSED';
  raise exception 'rollback fixture';
exception
  when others then
    if sqlerrm = 'rollback fixture' then return; end if;
    raise;
end $$;
```

- [ ] **Step 2: Run it and verify it fails**

Run: `npm run test:db -- --no-reset`
Expected: `verify-posting-map  FAIL`, with `ERROR: function public.account_code_for_payment_method(unknown) does not exist`.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/20260908000000_posting_account_map.sql`:

```sql
-- Which account a payment method and an expense category post to.
--
-- Functions rather than a CASE inlined at each call site, because six RPCs and
-- the historical backfill all need the same answer. Two copies of this mapping
-- is how the live path and the replay come to disagree -- and Task 8's
-- verification compares one against the other, so it would pass while both
-- were wrong.
--
-- IMMUTABLE, so they can sit in an index or a generated column later without
-- being re-planned. They read nothing.

create or replace function public.account_code_for_payment_method(p_method text)
returns text
language sql immutable as $$
  select case p_method
    when 'cash'   then '1000'
    when 'zaad'   then '1020'
    when 'edahab' then '1021'
    -- 'other' is a transfer, not till money. Putting it in 1000 Cash would make
    -- the drawer count disagree with the ledger for a reason nobody could find.
    when 'other'  then '1010'
  end;
$$;

-- The raise lives in a wrapper because a plain SQL function cannot raise. A
-- null code would reach post_journal_entry as "No such account: " with nothing
-- after it, which is a worse message at a later moment than this one.
create or replace function public.account_code_for_payment_method_checked(p_method text)
returns text
language plpgsql immutable as $$
declare v_code text := public.account_code_for_payment_method(p_method);
begin
  if v_code is null then
    raise exception 'no account is mapped to the payment method %', coalesce(p_method, '<null>')
      using errcode = 'P0001';
  end if;
  return v_code;
end;
$$;

create or replace function public.account_code_for_expense_category(p_category text)
returns text
language plpgsql immutable as $$
declare v_code text;
begin
  v_code := case p_category
    -- The three that were never operating expenses. This mapping is what makes
    -- a balance sheet possible: NON_OPERATING_CATEGORIES in
    -- expense-reporting.ts currently reaches the right net profit by EXCLUDING
    -- these two, which is the right answer by the wrong route. Here, where each
    -- one sits becomes the reason rather than a filter.
    when 'inventory_purchase'  then '1200'  -- an asset, not a cost
    when 'owner_draw'          then '3100'  -- contra-equity, not a cost
    -- Cost of sales, ABOVE gross profit -- not operating expenses, where the
    -- Count door's stock_loss category lands today. A shop losing 3% of stock
    -- does not have the margin its P&L currently claims. This is a visible
    -- presentation change: gross profit falls, opex falls by the same amount,
    -- net profit is unchanged.
    when 'stock_loss'          then '5100'
    when 'rent'                then '6000'
    when 'utilities'           then '6100'
    when 'salaries_wages'      then '6200'
    when 'marketing'           then '6300'
    when 'supplies'            then '6400'
    when 'transport_delivery'  then '6500'
    when 'maintenance_repairs' then '6600'
    when 'fees_charges'        then '6700'
    when 'other'               then '6900'
  end;
  if v_code is null then
    raise exception 'no account is mapped to the expense category %', coalesce(p_category, '<null>')
      using errcode = 'P0001';
  end if;
  return v_code;
end;
$$;

grant execute on function public.account_code_for_payment_method(text) to authenticated;
grant execute on function public.account_code_for_payment_method_checked(text) to authenticated;
grant execute on function public.account_code_for_expense_category(text) to authenticated;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test:db`
Expected: `verify-posting-map  pass`, **19 database checks passed**.

- [ ] **Step 5: Prove the test can fail**

Mutation: change `'inventory_purchase'` to return `'6900'`. Expected: check 2 fails with `must be an ASSET, got 6900`. Revert.

Mutation: widen the `expenses.category` check constraint to add a thirteenth value the function does not map — simulating a future migration that adds a category without giving it an account. Find the constraint's name and exact definition first (`select conname, pg_get_constraintdef(oid) from pg_constraint where conrelid = 'public.expenses'::regclass and conname like '%category%'`), then drop and re-add it with `'bank_charges'` appended. Expected: **check 5** fails with `FAIL: expense categories with no usable account: bank_charges (unmapped)` — proving the constraint-reading loop works, which is the only check here that survives someone adding a category. Revert the constraint to its exact original definition.

Deleting the `when 'fees_charges'` line instead does NOT prove this: `account_code_for_expense_category` raises rather than returning null, so check 3's hand-written `if ... <> '6700'` line — which calls the function directly on `'fees_charges'` — raises first and aborts the script before check 5's loop ever runs.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/20260908000000_posting_account_map.sql supabase/tests/verify-posting-map.sql
git commit -m "feat(accounting): map payment methods and expense categories to accounts"
```

---

### Task 2: Idempotency

Posting twice is worse than not posting. Every source row gains a `journal_entry_id`, and every posting site returns early when it is already set. This is also what makes the backfill safe to re-run — which it will be, because the first run will find something the verification script disagrees with.

**Files:**
- Create: `supabase/migrations/20260908000100_posting_idempotency.sql`

**Interfaces:**
- Produces: `journal_entry_id uuid references public.journal_entries(id)` on `sales`, `refunds`, `sale_payments`, `stock_receipts`, `expenses`, `invoice_payments`, `payroll_runs`, `stock_counts`.

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/20260908000100_posting_idempotency.sql`:

```sql
-- What has already been posted, so nothing posts twice.
--
-- The alternative -- deriving "posted" from the existence of a journal entry
-- whose description mentions the sale -- is a string match standing in for a
-- foreign key, and it fails the first time two sales in one second get the same
-- description.
--
-- NO ON DELETE CASCADE, deliberately: deleting a journal entry must not be a
-- way to silently un-post a sale. The reference is what stops the entry being
-- deleted at all, which is the behaviour wanted.

alter table public.sales            add column if not exists journal_entry_id uuid references public.journal_entries(id);
alter table public.refunds          add column if not exists journal_entry_id uuid references public.journal_entries(id);
-- On sale_payments rather than sale_balances: a settlement is a payment row
-- (is_settlement = true), and a sale can be settled in several instalments,
-- each of which is its own entry on its own date.
alter table public.sale_payments    add column if not exists journal_entry_id uuid references public.journal_entries(id);
alter table public.stock_receipts   add column if not exists journal_entry_id uuid references public.journal_entries(id);
alter table public.expenses         add column if not exists journal_entry_id uuid references public.journal_entries(id);
alter table public.invoice_payments add column if not exists journal_entry_id uuid references public.journal_entries(id);
alter table public.payroll_runs     add column if not exists journal_entry_id uuid references public.journal_entries(id);
alter table public.stock_counts     add column if not exists journal_entry_id uuid references public.journal_entries(id);

-- Partial, because the only question ever asked is "what is NOT yet posted".
-- Once the backfill has run these indexes are nearly empty, which is the point.
create index if not exists sales_unposted_idx            on public.sales(shop_id)          where journal_entry_id is null;
create index if not exists refunds_unposted_idx          on public.refunds(shop_id)        where journal_entry_id is null;
create index if not exists stock_receipts_unposted_idx   on public.stock_receipts(shop_id) where journal_entry_id is null;
create index if not exists expenses_unposted_idx         on public.expenses(shop_id)       where journal_entry_id is null;
create index if not exists payroll_runs_unposted_idx     on public.payroll_runs(shop_id)   where journal_entry_id is null;
create index if not exists stock_counts_unposted_idx     on public.stock_counts(shop_id)   where journal_entry_id is null;
```

- [ ] **Step 2: Verify it applies and changes nothing else**

Run: `npm run test:db`
Expected: **19 database checks passed** — unchanged. Adding a nullable column with no default rewrites no rows and breaks no existing assertion.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260908000100_posting_idempotency.sql
git commit -m "feat(accounting): record which journal entry each source row posted"
```

---

### Task 3: `complete_sale` posts

The hot path, and the one with real risk. Reproduce `complete_sale` verbatim from `20260831000100_complete_sale_allows_credit.sql` with **one addition** — a posting block after the sale, its items and its payments are written.

**Files:**
- Create: `supabase/migrations/20260908000200_post_complete_sale.sql`
- Create: `supabase/tests/verify-posting-sales.sql`
- Modify: `supabase/tests/accumulated-rpc-edits.test.ts`

**Interfaces:**
- Consumes: `account_code_for_payment_method_checked(text)` (Task 1), `sales.journal_entry_id` (Task 2).
- Produces: a `journal_entries` row per sale with `source = 'sale'`.

#### The entry, and why it balances

Using `complete_sale`'s own variables:

| Line | Account | Amount |
|---|---|---|
| Dr | per payment, `account_code_for_payment_method_checked(method)` | that payment's `amount_cents` |
| Dr | `1100` Accounts Receivable | `v_balance`, when the sale is left part-paid |
| Dr | `4200` Discounts Given | `v_discount_cents + v_redeem_cents` |
| Cr | `4000` Sales Revenue | `v_gross_cents` |
| Cr | `2100` Sales Tax Payable | `v_tax_cents` |

Debits total `v_total_cents + discount`, and since `v_total_cents = v_gross_cents - discount + v_tax_cents`, that is `v_gross_cents + v_tax_cents` — which is the credit total. It balances by construction, not by hope.

Then, separately:

| Line | Account | Amount |
|---|---|---|
| Dr | `5000` Cost of Goods Sold | `v_cogs_cents` |
| Cr | `1200` Inventory | `v_cogs_cents` |

**`v_cogs_cents` sums only the costed lines.** `sale_items.unit_cost_cents` is nullable and `isUncosted()` is careful that null is not zero — a free sample really does cost nothing, an unpriced product is a different thing. When every line is uncosted, `v_cogs_cents` is 0 and **both lines are omitted**, because `journal_lines` refuses a zero amount.

- [ ] **Step 1: Write the failing test**

Create `supabase/tests/verify-posting-sales.sql`. Fixture: a shop, one location, two products at costs **700** and **1100**, tax **5%**.

```sql
  -- 1. A cash sale posts one balanced entry.
  --
  -- 2 @ 2000 (cost 700) plus 1 @ 3000 (cost 1100) = 7000 gross.
  -- Tax 5% of 7000 = 350. Total 7350. COGS = 2*700 + 1100 = 2500.
  --
  -- The numbers are chosen so no two lines share a value: 7000, 350, 7350 and
  -- 2500 are all distinct, so a check that reads the wrong line fails rather
  -- than coincidentally passing.
  v_sale_id := public.complete_sale(
    v_shop_id,
    jsonb_build_array(
      jsonb_build_object('product_id', v_prod_a, 'quantity', 2, 'unit_price_cents', 2000),
      jsonb_build_object('product_id', v_prod_b, 'quantity', 1, 'unit_price_cents', 3000)),
    jsonb_build_array(jsonb_build_object('method', 'cash', 'amount_cents', 7350)),
    null, null, null, null, 0, null, null, v_loc_id);

  select journal_entry_id into v_entry from public.sales where id = v_sale_id;
  if v_entry is null then
    raise exception 'FAIL: the sale did not post a journal entry';
  end if;

  select source into v_text from public.journal_entries where id = v_entry;
  if v_text <> 'sale' then
    raise exception 'FAIL: expected source=sale, got % (manual would mean it gated on ledger.post)', v_text;
  end if;

  -- Balanced. Guaranteed by the deferred trigger, asserted anyway: if this ever
  -- fails the trigger has been dropped, which is worth knowing here.
  select coalesce(sum(amount_cents), 0) into v_amount from public.journal_lines where entry_id = v_entry;
  if v_amount <> 0 then
    raise exception 'FAIL: the sale entry does not balance, off by %', v_amount;
  end if;

  -- Dr 1000 Cash 7350
  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l join public.accounts a on a.id = l.account_id
   where l.entry_id = v_entry and a.code = '1000';
  if v_amount <> 7350 then
    raise exception 'FAIL: expected Dr 1000 Cash 7350, got %', v_amount;
  end if;

  -- Cr 4000 Sales Revenue 7000 -- the GROSS, not the total. Posting 7350 here
  -- would book the tax as revenue, which is the mistake this check exists for.
  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l join public.accounts a on a.id = l.account_id
   where l.entry_id = v_entry and a.code = '4000';
  if v_amount <> -7000 then
    raise exception 'FAIL: expected Cr 4000 Revenue -7000, got % (-7350 = tax booked as revenue)', v_amount;
  end if;

  -- Cr 2100 Sales Tax Payable 350 -- owed, not earned.
  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l join public.accounts a on a.id = l.account_id
   where l.entry_id = v_entry and a.code = '2100';
  if v_amount <> -350 then
    raise exception 'FAIL: expected Cr 2100 Tax -350, got %', v_amount;
  end if;

  -- Dr 5000 COGS 2500 and Cr 1200 Inventory 2500, from the cost frozen on each
  -- line at sale time -- never products.cost_cents, which would let a later
  -- restock rewrite this sale's cost.
  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l join public.accounts a on a.id = l.account_id
   where l.entry_id = v_entry and a.code = '5000';
  if v_amount <> 2500 then
    raise exception 'FAIL: expected Dr 5000 COGS 2500, got %', v_amount;
  end if;
  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l join public.accounts a on a.id = l.account_id
   where l.entry_id = v_entry and a.code = '1200';
  if v_amount <> -2500 then
    raise exception 'FAIL: expected Cr 1200 Inventory -2500, got %', v_amount;
  end if;

  -- 2. A SPLIT payment produces one debit line per method, not one lumped line.
  --    Two lines against different accounts is the whole reason the drawer and
  --    the wallet can be reconciled separately.
  v_sale_id := public.complete_sale(
    v_shop_id,
    jsonb_build_array(jsonb_build_object('product_id', v_prod_a, 'quantity', 1, 'unit_price_cents', 2000)),
    jsonb_build_array(
      jsonb_build_object('method', 'cash', 'amount_cents', 1300),
      jsonb_build_object('method', 'zaad', 'amount_cents', 800)),
    null, null, null, null, 0, null, null, v_loc_id);
  select journal_entry_id into v_entry from public.sales where id = v_sale_id;

  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l join public.accounts a on a.id = l.account_id
   where l.entry_id = v_entry and a.code = '1000';
  if v_amount <> 1300 then
    raise exception 'FAIL: expected Dr 1000 Cash 1300 of the split, got %', v_amount;
  end if;
  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l join public.accounts a on a.id = l.account_id
   where l.entry_id = v_entry and a.code = '1020';
  if v_amount <> 800 then
    raise exception 'FAIL: expected Dr 1020 Zaad 800 of the split, got % (2100 = both lumped into one account)', v_amount;
  end if;

  -- 3. A CREDIT sale debits 1100 Receivable for the unpaid part.
  --    2 @ 2000 = 4000 gross, tax 200, total 4200. Paid 1500, balance 2700.
  v_sale_id := public.complete_sale(
    v_shop_id,
    jsonb_build_array(jsonb_build_object('product_id', v_prod_a, 'quantity', 2, 'unit_price_cents', 2000)),
    jsonb_build_array(jsonb_build_object('method', 'cash', 'amount_cents', 1500)),
    null, null, null, null, 0, v_customer_id, null, v_loc_id, 0, null, true);
  select journal_entry_id into v_entry from public.sales where id = v_sale_id;

  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l join public.accounts a on a.id = l.account_id
   where l.entry_id = v_entry and a.code = '1100';
  if v_amount <> 2700 then
    raise exception 'FAIL: expected Dr 1100 Receivable 2700, got %', v_amount;
  end if;

  -- 4. An UNCOSTED product posts no COGS pair at all rather than posting zero.
  --    journal_lines refuses a zero amount, so getting this wrong is not a
  --    quiet inaccuracy -- the sale fails outright. Which is why it is checked.
  v_sale_id := public.complete_sale(
    v_shop_id,
    jsonb_build_array(jsonb_build_object('product_id', v_prod_uncosted, 'quantity', 1, 'unit_price_cents', 900)),
    jsonb_build_array(jsonb_build_object('method', 'cash', 'amount_cents', 945)),
    null, null, null, null, 0, null, null, v_loc_id);
  select journal_entry_id into v_entry from public.sales where id = v_sale_id;
  if exists (select 1 from public.journal_lines l join public.accounts a on a.id = l.account_id
              where l.entry_id = v_entry and a.code in ('5000', '1200')) then
    raise exception 'FAIL: an uncosted sale should post no COGS pair, not a zero one';
  end if;

  -- 5. A cashier does NOT need ledger.post. The whole phase turns on this: the
  --    posting call passes p_source <> 'manual', which skips that gate. If this
  --    raises, every sale in the shop stops until someone grants the permission.
  --    (The fixture user is the owner, so this asserts the shape rather than
  --    the grant: a staff role with pos.access but no ledger.post.)
  perform public.grant_role_permissions(v_staff_role_id, array['pos.access']);
  perform set_config('request.jwt.claims', json_build_object('sub', v_staff_id)::text, true);
  v_sale_id := public.complete_sale(
    v_shop_id,
    jsonb_build_array(jsonb_build_object('product_id', v_prod_a, 'quantity', 1, 'unit_price_cents', 2000)),
    jsonb_build_array(jsonb_build_object('method', 'cash', 'amount_cents', 2100)),
    null, null, null, null, 0, null, null, v_loc_id);
  if (select journal_entry_id from public.sales where id = v_sale_id) is null then
    raise exception 'FAIL: a cashier without ledger.post could not post a sale';
  end if;
  perform set_config('request.jwt.claims', json_build_object('sub', v_user_id)::text, true);
```

> The fixture must create `v_staff_id`, `v_staff_role_id` and `v_prod_uncosted`, and grant the staff member `pos.access` only. Copy the role-and-member setup from `verify-inventory-permissions.sql`, which already does exactly this.

- [ ] **Step 2: Run it and verify it fails**

Run: `npm run test:db -- --no-reset`
Expected: `verify-posting-sales  FAIL` on check 1, `the sale did not post a journal entry`.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/20260908000200_post_complete_sale.sql`. Reproduce `complete_sale` **in full** from `20260831000100_complete_sale_allows_credit.sql`, then add two declarations and one block.

Add to `declare`:

```sql
  v_cogs_cents integer := 0;
  v_entry_id uuid;
  v_lines jsonb;
```

Insert **after** the `sale_payments` insert loop and **before** `return v_sale_id`:

```sql
  -- ── The posting side ────────────────────────────────────────────────────
  --
  -- Inside the same transaction, deliberately: a sale that is recorded but not
  -- posted is a books-that-do-not-tie bug that only shows up at month end, and
  -- the shop has no way to find which sale it was. Failing the sale is louder
  -- and rarer.
  --
  -- p_source => 'sale', never 'manual'. post_journal_entry gates the manual
  -- source on ledger.post; a cashier holds pos.access and must not need more.

  -- COGS from the cost FROZEN on each line at sale time, never
  -- products.cost_cents -- otherwise a restock tomorrow rewrites this sale's
  -- cost, and with it every closed month's gross profit. That freeze is what
  -- 20260804000000 exists for.
  --
  -- Uncosted lines contribute nothing rather than zero. isUncosted() is careful
  -- that null and zero are different answers: a free sample really does cost
  -- nothing; an unpriced product is a question nobody answered.
  select coalesce(sum(si.unit_cost_cents::bigint * si.quantity), 0)
    into v_cogs_cents
    from public.sale_items si
   where si.sale_id = v_sale_id and si.unit_cost_cents is not null;

  -- One debit line per payment, against the account that method maps to. A
  -- single lumped line would make the drawer and the wallet impossible to
  -- reconcile separately, which is most of what a cash position is for.
  select coalesce(jsonb_agg(jsonb_build_object(
           'code',         public.account_code_for_payment_method_checked(sp.method),
           'amount_cents', sp.amount_cents,
           'memo',         'Payment by ' || sp.method)), '[]'::jsonb)
    into v_lines
    from public.sale_payments sp
   where sp.sale_id = v_sale_id and sp.amount_cents <> 0;

  if v_balance > 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'code', '1100', 'amount_cents', v_balance, 'memo', 'Left on account'));
  end if;

  -- Discounts and redeemed points are shown GROSS: revenue at list, the
  -- reduction as its own debit. Netting them into 4000 would hide what the
  -- shop gave away, which is the one number a discount report exists to show.
  if (v_discount_cents + v_redeem_cents) > 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'code', '4200', 'amount_cents', v_discount_cents + v_redeem_cents, 'memo', 'Discount and points'));
  end if;

  if v_gross_cents > 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'code', '4000', 'amount_cents', -v_gross_cents, 'memo', 'Sale'));
  end if;

  if v_tax_cents > 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'code', '2100', 'amount_cents', -v_tax_cents, 'memo', 'Sales tax'));
  end if;

  -- Omitted entirely when zero, not posted as a zero pair: journal_lines
  -- carries check (amount_cents <> 0), so a zero line fails the whole sale.
  if v_cogs_cents > 0 then
    v_lines := v_lines || jsonb_build_array(
      jsonb_build_object('code', '5000', 'amount_cents',  v_cogs_cents, 'memo', 'Cost of goods sold'),
      jsonb_build_object('code', '1200', 'amount_cents', -v_cogs_cents, 'memo', 'Stock sold'));
  end if;

  v_entry_id := public.post_journal_entry(
    p_shop_id,
    coalesce(p_created_at, now())::date,
    'Sale',
    v_lines,
    v_location_id,
    'sale');

  update public.sales set journal_entry_id = v_entry_id where id = v_sale_id;
  -- ── end posting side ────────────────────────────────────────────────────
```

- [ ] **Step 4: Add the copy-forward guard**

Modify `supabase/tests/accumulated-rpc-edits.test.ts`, adding to `COMPLETE_SALE_EDITS`:

```ts
  ['20260908000200', 'the sale posts a journal entry', "'sale')"],
  ['20260908000200', 'COGS comes from the frozen line cost', 'v_cogs_cents'],
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm run test:db && npx jest supabase/tests/accumulated-rpc-edits.test.ts`
Expected: `verify-posting-sales  pass`, **20 database checks passed**; the jest suite passes with two more assertions than before.

- [ ] **Step 6: Prove the test can fail**

Mutation: post `-v_total_cents` to `4000` instead of `-v_gross_cents`. Expected: check 1 fails with `-7350 = tax booked as revenue`. Revert.

Mutation: build one lumped cash line instead of one per payment. Expected: check 2 fails with `2100 = both lumped into one account`. Revert.

Mutation: drop the `and si.unit_cost_cents is not null` filter. Expected: check 1 still passes (null sums to the same total) but **check 4 fails** — the uncosted sale posts a zero COGS pair and the whole sale raises. This is why check 4 exists. Revert.

Mutation: pass `'manual'` as `p_source`. Expected: check 5 fails — the cashier is refused. Revert.

- [ ] **Step 7: Commit**

```bash
git add supabase/migrations/20260908000200_post_complete_sale.sql supabase/tests/verify-posting-sales.sql supabase/tests/accumulated-rpc-edits.test.ts
git commit -m "feat(accounting): a completed sale posts to the ledger"
```

---

### Task 4: Measure what posting costs the sale

The plan is required to say what this costs on the POS's hottest transaction — **measured, not assumed**. A 20-line sale already writes the sale, its items and its payments; it now also writes an entry and up to 25 lines.

**Files:**
- Create: `supabase/tests/bench-complete-sale.sql`

- [ ] **Step 1: Write the benchmark**

Create `supabase/tests/bench-complete-sale.sql`:

```sql
-- @no-verdict -- prints timings, asserts nothing. The runner skips it.
--
-- What the posting side costs complete_sale on a realistic basket. Run this
-- BEFORE 20260908000200 and AFTER it, and put both figures in the commit
-- message. "It is probably fine" is not a measurement.
--
-- 20 lines is the realistic worst case for a kaiibi shop -- a wholesale run,
-- not a corner-shop basket. 40 iterations, median reported, because the first
-- call in a session pays for plan caching and would skew a mean.

\set ON_ERROR_STOP on

do $$
declare
  v_user_id uuid := gen_random_uuid();
  v_shop_id uuid; v_loc_id uuid;
  v_items jsonb := '[]'::jsonb;
  v_prod uuid;
  v_start timestamptz; v_ms numeric;
  v_times numeric[] := '{}';
  i integer;
begin
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
    values (v_user_id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            'bench-' || v_user_id || '@example.test', '', now(), now(), now());
  insert into public.shops (owner_id, name) values (v_user_id, 'Bench Shop') returning id into v_shop_id;
  insert into public.shop_locations (shop_id, name, is_primary) values (v_shop_id, 'Main', true) returning id into v_loc_id;

  for i in 1..20 loop
    insert into public.products (shop_id, name, price_cents, cost_cents, stock)
      values (v_shop_id, 'Bench ' || i, 1000 + i, 400 + i, 100000) returning id into v_prod;
    v_items := v_items || jsonb_build_array(jsonb_build_object(
      'product_id', v_prod, 'quantity', 2, 'unit_price_cents', 1000 + i));
  end loop;

  perform set_config('request.jwt.claims', json_build_object('sub', v_user_id)::text, true);
  perform set_config('role', 'authenticated', true);

  for i in 1..40 loop
    v_start := clock_timestamp();
    perform public.complete_sale(
      v_shop_id, v_items,
      jsonb_build_array(jsonb_build_object('method', 'cash', 'amount_cents', 42420)),
      null, null, null, null, 0, null, null, v_loc_id);
    v_ms := extract(epoch from (clock_timestamp() - v_start)) * 1000;
    if i > 5 then v_times := v_times || v_ms; end if;  -- discard the warm-up
  end loop;

  select percentile_cont(0.5) within group (order by t) into v_ms from unnest(v_times) t;
  raise notice 'complete_sale, 20 lines, median of 35: % ms', round(v_ms, 2);
  select percentile_cont(0.95) within group (order by t) into v_ms from unnest(v_times) t;
  raise notice 'complete_sale, 20 lines, p95 of 35:    % ms', round(v_ms, 2);

  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims', null, true);
  raise exception 'rollback fixture';
exception
  when others then
    perform set_config('role', 'postgres', true);
    perform set_config('request.jwt.claims', null, true);
    if sqlerrm = 'rollback fixture' then return; end if;
    raise;
end $$;
```

- [ ] **Step 2: Measure before**

```bash
git stash                    # remove the posting migration
npm run test:db > /dev/null  # rebuild without it
psql "$SUPABASE_DB_URL" -f supabase/tests/bench-complete-sale.sql
git stash pop
```

Record the median and p95.

- [ ] **Step 3: Measure after**

```bash
npm run test:db > /dev/null
psql "$SUPABASE_DB_URL" -f supabase/tests/bench-complete-sale.sql
```

- [ ] **Step 4: Decide, on the number**

Write both figures into the commit message. The threshold, agreed in advance so it is not rationalised afterwards:

- **Under +15%** — ship it, note the figure.
- **+15% to +40%** — ship it, and open an issue to batch the line insert.
- **Over +40%** — stop. The likely cause is `post_journal_entry`'s reference generation, which runs `count(*)` over the shop's entries for the year on **every** call. At 5,000 entries that count is the cost, not the insert. The fix is a `journal_entry_sequences` table taking a per-shop-per-year counter under a row lock — the same problem Task 8 solves for the backfill with a window function, but solved for the interactive path. That is a real change and it needs its own task rather than being smuggled in here.

- [ ] **Step 5: Commit**

```bash
git add supabase/tests/bench-complete-sale.sql
git commit -m "test(accounting): measure what posting costs a 20-line sale

Before: <median> ms median, <p95> ms p95
After:  <median> ms median, <p95> ms p95"
```

---

### Task 5: `refund_sale_items` and `settle_sale_balance` post

**Files:**
- Create: `supabase/migrations/20260908000300_post_refund_and_settlement.sql`
- Modify: `supabase/tests/verify-posting-sales.sql`

**Interfaces:**
- Consumes: `refunds.journal_entry_id`, `sale_payments.journal_entry_id` (Task 2).

A refund reverses the sale in substance but is **not** posted as a mirror image, because kaiibi's refunds return goods rather than cash by default (`20260831000200`).

| Line | Account | Amount |
|---|---|---|
| Dr | `4100` Sales Returns | the refund's net-of-tax amount |
| Dr | `2100` Sales Tax Payable | the tax share coming back |
| Cr | `1000`/`1010`/`1020`/`1021` Cash, or `1100` Receivable | what is actually returned |
| Dr | `1200` Inventory | the cost of the goods coming back |
| Cr | `5000` Cost of Goods Sold | the same |

A settlement is the simplest entry in the phase: **Dr the cash account, Cr `1100`.**

- [ ] **Step 1: Write the failing test**

Append to `supabase/tests/verify-posting-sales.sql`:

```sql
  -- 6. A refund posts returns, not negative revenue. 4000 must not move: a
  --    refund that reduced Sales Revenue would make a month's revenue depend
  --    on when the return happened, and the Discounts & Refunds report would
  --    have nothing to read.
  v_refund_id := public.refund_sale_items(
    v_sale_id_cash,
    jsonb_build_array(jsonb_build_object('sale_item_id', v_item_a, 'quantity', 1)));
  select journal_entry_id into v_entry from public.refunds where id = v_refund_id;
  if v_entry is null then
    raise exception 'FAIL: the refund did not post';
  end if;

  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l join public.accounts a on a.id = l.account_id
   where l.entry_id = v_entry and a.code = '4000';
  if v_amount <> 0 then
    raise exception 'FAIL: a refund must not touch 4000 Sales Revenue, it moved by %', v_amount;
  end if;

  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l join public.accounts a on a.id = l.account_id
   where l.entry_id = v_entry and a.code = '4100';
  if v_amount <= 0 then
    raise exception 'FAIL: expected a DEBIT to 4100 Sales Returns, got %', v_amount;
  end if;

  -- The goods came back, so their cost comes out of COGS and back into stock.
  -- One returned unit of product A: cost 700.
  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l join public.accounts a on a.id = l.account_id
   where l.entry_id = v_entry and a.code = '1200';
  if v_amount <> 700 then
    raise exception 'FAIL: expected Dr 1200 Inventory 700 for the returned unit, got %', v_amount;
  end if;

  select coalesce(sum(amount_cents), 0) into v_amount from public.journal_lines where entry_id = v_entry;
  if v_amount <> 0 then
    raise exception 'FAIL: the refund entry does not balance, off by %', v_amount;
  end if;

  -- 7. Settling a balance moves receivable to cash and touches nothing else.
  --    Posting revenue again here is the classic double-count, so 4000 is
  --    asserted absent rather than merely unchanged.
  perform public.settle_sale_balance(
    v_sale_id_credit,
    jsonb_build_array(jsonb_build_object('method', 'cash', 'amount_cents', 2700)));

  select journal_entry_id into v_entry from public.sale_payments
   where sale_id = v_sale_id_credit and is_settlement order by created_at desc limit 1;
  if v_entry is null then
    raise exception 'FAIL: the settlement did not post';
  end if;

  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l join public.accounts a on a.id = l.account_id
   where l.entry_id = v_entry and a.code = '1100';
  if v_amount <> -2700 then
    raise exception 'FAIL: expected Cr 1100 Receivable -2700, got %', v_amount;
  end if;
  if exists (select 1 from public.journal_lines l join public.accounts a on a.id = l.account_id
              where l.entry_id = v_entry and a.code = '4000') then
    raise exception 'FAIL: a settlement must not post revenue again';
  end if;
```

- [ ] **Step 2: Run it and verify it fails**

Run: `npm run test:db -- --no-reset`
Expected: `verify-posting-sales  FAIL` on check 6, `the refund did not post`.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/20260908000300_post_refund_and_settlement.sql`, reproducing both functions from `20260831000200_refund_goods_not_cash.sql` in full.

In `refund_sale_items`, after the refund row and its items are written:

```sql
  -- The cost of what physically came back, at the price frozen on the original
  -- sale line. Not today's cost: the goods returning are the goods that left.
  select coalesce(sum(si.unit_cost_cents::bigint * (ri.quantity)), 0)
    into v_cogs_back
    from public.refund_items ri
    join public.sale_items si on si.id = ri.sale_item_id
   where ri.refund_id = v_refund_id and si.unit_cost_cents is not null;

  -- Tax comes back in the same proportion the money does. Computed from the
  -- refund's own share rather than re-deriving the rate, because the rate may
  -- have changed since the sale and the customer is owed what they paid.
  v_tax_back := round(v_refund_amount::numeric * v_sale_tax_cents / nullif(v_sale_total_cents, 0));

  v_lines := jsonb_build_array(
    jsonb_build_object('code', '4100', 'amount_cents',  v_refund_amount - v_tax_back, 'memo', 'Goods returned'));

  if v_tax_back > 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'code', '2100', 'amount_cents', v_tax_back, 'memo', 'Tax on the return'));
  end if;

  -- Against the receivable when the sale is still owed, against cash when it
  -- was paid. Refunding cash on a sale nobody has paid for hands out money the
  -- shop never took.
  if v_outstanding_balance > 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'code', '1100', 'amount_cents', -v_refund_amount, 'memo', 'Reduced what is owed'));
  else
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'code', public.account_code_for_payment_method_checked(v_sale_method),
      'amount_cents', -v_refund_amount, 'memo', 'Refunded'));
  end if;

  if v_cogs_back > 0 then
    v_lines := v_lines || jsonb_build_array(
      jsonb_build_object('code', '1200', 'amount_cents',  v_cogs_back, 'memo', 'Stock returned'),
      jsonb_build_object('code', '5000', 'amount_cents', -v_cogs_back, 'memo', 'Cost reversed'));
  end if;

  v_entry_id := public.post_journal_entry(
    v_shop_id, now()::date, 'Refund', v_lines, v_location_id, 'refund');
  update public.refunds set journal_entry_id = v_entry_id where id = v_refund_id;
```

In `settle_sale_balance`, after each settlement payment row is inserted:

```sql
  -- One entry per instalment, dated when the money arrived. Lumping several
  -- settlements into one entry would date the whole thing on the last payment.
  v_entry_id := public.post_journal_entry(
    v_shop_id, now()::date, 'Balance settled',
    jsonb_build_array(
      jsonb_build_object('code', public.account_code_for_payment_method_checked(v_method),
                         'amount_cents',  v_amount, 'memo', 'Settlement received'),
      jsonb_build_object('code', '1100', 'amount_cents', -v_amount, 'memo', 'Cleared from receivables')),
    v_location_id, 'settlement');
  update public.sale_payments set journal_entry_id = v_entry_id where id = v_payment_id;
```

> `v_refund_amount`, `v_outstanding_balance`, `v_sale_method`, `v_sale_tax_cents` and `v_sale_total_cents` must be read from the parent sale in the same function; `v_cogs_back`, `v_tax_back`, `v_lines` and `v_entry_id` are new declarations.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test:db`
Expected: `verify-posting-sales  pass`, **20 database checks passed**.

- [ ] **Step 5: Prove the test can fail**

Mutation: post the refund to `4000` with a negative amount instead of `4100`. Expected: check 6 fails with `a refund must not touch 4000`. Revert.

Mutation: in `settle_sale_balance`, add a `4000` credit line and a matching debit. Expected: check 7 fails with `a settlement must not post revenue again`. Revert.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/20260908000300_post_refund_and_settlement.sql supabase/tests/verify-posting-sales.sql
git commit -m "feat(accounting): refunds and settlements post to the ledger"
```

---

### Task 6: `receive_stock` and `save_stock_count` post

**Files:**
- Create: `supabase/migrations/20260908000400_post_receive_stock.sql`
- Create: `supabase/migrations/20260908000600_post_stock_count.sql`
- Create: `supabase/tests/verify-posting-inventory.sql`

**Interfaces:**
- Consumes: `stock_receipts.journal_entry_id`, `stock_counts.journal_entry_id` (Task 2).

> **`receive_stock` must be copied forward from `20260907000000_moving_weighted_average.sql`, not from `20260902000000`.** The weighted-average arithmetic shipped in the former and copying from the latter silently restores "latest wins" — an impermissible cost basis — while every test here still passes, because none of these tests look at `products.cost_cents`. `verify-weighted-average.sql` is what catches it, and it must stay green.

A receipt is **Dr 1200 Inventory, Cr 2000 Accounts Payable** for the total delivery value. Uncosted lines contribute nothing; a receipt with no costed line at all posts no entry.

A stock count posts its variance, valued at the cost frozen on each count line:

| Variance | Entry |
|---|---|
| Short | Dr `5100` Inventory Shrinkage, Cr `1200` Inventory |
| Over | Dr `1200` Inventory, Cr `5100` Inventory Shrinkage |

- [ ] **Step 1: Write the failing test**

Create `supabase/tests/verify-posting-inventory.sql`:

```sql
  -- 1. A costed delivery posts Dr 1200 / Cr 2000.
  --    40 @ 250 plus 10 @ 900 = 10000 + 9000 = 19000.
  --    The two lines are chosen so the total cannot be reached by reading only
  --    one of them, and 19000 is not a multiple of either line.
  v_receipt_id := public.receive_stock(v_shop_id, v_loc_id, jsonb_build_array(
    jsonb_build_object('product_id', v_prod_a, 'quantity', 40, 'unit_cost_cents', 250),
    jsonb_build_object('product_id', v_prod_b, 'quantity', 10, 'unit_cost_cents', 900)));

  select journal_entry_id into v_entry from public.stock_receipts where id = v_receipt_id;
  if v_entry is null then raise exception 'FAIL: the receipt did not post'; end if;

  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l join public.accounts a on a.id = l.account_id
   where l.entry_id = v_entry and a.code = '1200';
  if v_amount <> 19000 then
    raise exception 'FAIL: expected Dr 1200 Inventory 19000, got % (10000 or 9000 = only one line read)', v_amount;
  end if;
  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l join public.accounts a on a.id = l.account_id
   where l.entry_id = v_entry and a.code = '2000';
  if v_amount <> -19000 then
    raise exception 'FAIL: expected Cr 2000 Payable -19000, got %', v_amount;
  end if;

  -- 2. A delivery with NO stated cost posts NOTHING. It is not a zero-value
  --    receipt; it is a receipt whose value is unknown, and inventing 0 for it
  --    would understate stock on hand by exactly the amount nobody recorded.
  v_receipt_id := public.receive_stock(v_shop_id, v_loc_id, jsonb_build_array(
    jsonb_build_object('product_id', v_prod_a, 'quantity', 5)));
  if (select journal_entry_id from public.stock_receipts where id = v_receipt_id) is not null then
    raise exception 'FAIL: an uncosted delivery should post no entry at all';
  end if;

  -- 3. THE ONE THAT MATTERS FOR TASK 6. The weighted average still works.
  --    Copying receive_stock forward from 20260902000000 instead of
  --    20260907000000 restores "latest wins" -- an impermissible basis -- and
  --    every other check in this file still passes, because none of them read
  --    products.cost_cents.
  --
  --    Product A: 40 @ 250 then 5 uncosted then 60 @ 500.
  --    Weighted: (45*250 + 60*500)/105 = (11250 + 30000)/105 = 392.
  --    "Latest wins" gives 500. The two separate cleanly.
  perform public.receive_stock(v_shop_id, v_loc_id, jsonb_build_array(
    jsonb_build_object('product_id', v_prod_a, 'quantity', 60, 'unit_cost_cents', 500)));
  select cost_cents into v_amount from public.products where id = v_prod_a;
  if v_amount <> 392 then
    raise exception 'FAIL: expected a weighted 392, got % (500 = receive_stock was copied forward from the wrong ancestor)', v_amount;
  end if;

  -- 4. A SHORT count posts shrinkage into cost of sales, not operating
  --    expenses. 5100 sits above gross profit: a shop losing stock does not
  --    have the margin its P&L would otherwise claim.
  --    Product B holds 10 at cost 900; counting 7 is a variance of -3 = 2700.
  v_count_id := public.save_stock_count(v_shop_id, v_loc_id, jsonb_build_array(
    jsonb_build_object('product_id', v_prod_b, 'counted_quantity', 7, 'reason', 'damaged')));
  select journal_entry_id into v_entry from public.stock_counts where id = v_count_id;
  if v_entry is null then raise exception 'FAIL: the stock count did not post'; end if;

  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l join public.accounts a on a.id = l.account_id
   where l.entry_id = v_entry and a.code = '5100';
  if v_amount <> 2700 then
    raise exception 'FAIL: expected Dr 5100 Shrinkage 2700, got %', v_amount;
  end if;
  if exists (select 1 from public.journal_lines l join public.accounts a on a.id = l.account_id
              where l.entry_id = v_entry and a.code like '6%') then
    raise exception 'FAIL: shrinkage must not post to an operating expense account';
  end if;

  -- 5. An OVER count reverses the direction rather than posting a negative
  --    shrinkage. Two lines that sum to zero would pass the balance check while
  --    meaning nothing.
  v_count_id := public.save_stock_count(v_shop_id, v_loc_id, jsonb_build_array(
    jsonb_build_object('product_id', v_prod_b, 'counted_quantity', 9, 'reason', 'miscount')));
  select journal_entry_id into v_entry from public.stock_counts where id = v_count_id;
  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l join public.accounts a on a.id = l.account_id
   where l.entry_id = v_entry and a.code = '1200';
  if v_amount <> 1800 then
    raise exception 'FAIL: found stock should DEBIT 1200 by 1800, got %', v_amount;
  end if;

  -- 6. An UNCOSTED product's variance posts nothing. There is no value to
  --    move, and inventing one is what isUncosted() exists to prevent.
  v_count_id := public.save_stock_count(v_shop_id, v_loc_id, jsonb_build_array(
    jsonb_build_object('product_id', v_prod_uncosted, 'counted_quantity', 3, 'reason', 'miscount')));
  if (select journal_entry_id from public.stock_counts where id = v_count_id) is not null then
    raise exception 'FAIL: an uncosted variance should post no entry';
  end if;
```

- [ ] **Step 2: Run it and verify it fails**

Run: `npm run test:db -- --no-reset`
Expected: `verify-posting-inventory  FAIL` on check 1, `the receipt did not post`.

- [ ] **Step 3: Write both migrations**

`20260908000400_post_receive_stock.sql` — reproduce `receive_stock` **from `20260907000000`**, keeping the weighted-average block exactly, and add after the item loop:

```sql
  -- Total delivery value, costed lines only. An uncosted line is not a
  -- zero-value line: the delivery's value is unknown, and posting 0 would
  -- understate stock on hand by exactly what nobody wrote down.
  select coalesce(sum(ri.unit_cost_cents::bigint * ri.quantity), 0)
    into v_value_cents
    from public.stock_receipt_items ri
   where ri.receipt_id = v_receipt_id and ri.unit_cost_cents is not null;

  -- Credit 2000 Payable, not cash: receive_stock records goods ARRIVING, and
  -- says nothing about whether they were paid for. Paying the supplier is
  -- record_invoice_payment, which debits 2000 back down.
  if v_value_cents > 0 then
    v_entry_id := public.post_journal_entry(
      p_shop_id, now()::date, 'Stock received',
      jsonb_build_array(
        jsonb_build_object('code', '1200', 'amount_cents',  v_value_cents, 'memo', 'Delivery received'),
        jsonb_build_object('code', '2000', 'amount_cents', -v_value_cents, 'memo', 'Owed to supplier')),
      p_location_id, 'receipt');
    update public.stock_receipts set journal_entry_id = v_entry_id where id = v_receipt_id;
  end if;
```

`20260908000600_post_stock_count.sql` — reproduce `save_stock_count` from `20260903000100`, adding after the item loop:

```sql
  -- The net variance in money, at the cost frozen on each count line. Signed:
  -- negative means stock is missing, positive means more was found.
  select coalesce(sum(ci.unit_cost_cents::bigint * (ci.counted_quantity - ci.previous_quantity)), 0)
    into v_variance_cents
    from public.stock_count_items ci
   where ci.count_id = v_count_id and ci.unit_cost_cents is not null;

  if v_variance_cents < 0 then
    -- Short. 5100 sits in COST OF SALES, above gross profit -- not in
    -- operating expenses, where the Count door's stock_loss expense lands
    -- today. A unit that is stolen or breaks is never sold, so its cost never
    -- enters COGS by any other path and gross profit reads high by exactly
    -- that amount, every month, invisibly.
    v_entry_id := public.post_journal_entry(
      p_shop_id, now()::date, 'Stock count variance',
      jsonb_build_array(
        jsonb_build_object('code', '5100', 'amount_cents', -v_variance_cents, 'memo', 'Stock short'),
        jsonb_build_object('code', '1200', 'amount_cents',  v_variance_cents, 'memo', 'Written off')),
      p_location_id, 'count');
    update public.stock_counts set journal_entry_id = v_entry_id where id = v_count_id;
  elsif v_variance_cents > 0 then
    -- Found. Reversed rather than posted as a negative shrinkage: a negative
    -- debit and a negative credit sum to zero and pass every check while
    -- meaning nothing a reader could act on.
    v_entry_id := public.post_journal_entry(
      p_shop_id, now()::date, 'Stock count variance',
      jsonb_build_array(
        jsonb_build_object('code', '1200', 'amount_cents',  v_variance_cents, 'memo', 'Stock found'),
        jsonb_build_object('code', '5100', 'amount_cents', -v_variance_cents, 'memo', 'Shrinkage reversed')),
      p_location_id, 'count');
    update public.stock_counts set journal_entry_id = v_entry_id where id = v_count_id;
  end if;
  -- Exactly zero posts nothing. A count that found what it expected is not an
  -- accounting event.
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test:db`
Expected: `verify-posting-inventory  pass` and **`verify-weighted-average  pass`**, **21 database checks passed**.

- [ ] **Step 5: Prove the test can fail**

Mutation: copy `receive_stock` forward from `20260902000000` instead of `20260907000000`. Expected: **check 3 fails with 500**, and `verify-weighted-average` goes red too. Revert. This is the mutation this task exists to guard.

Mutation: post shrinkage to `6900` instead of `5100`. Expected: check 4 fails with `must not post to an operating expense account`. Revert.

Mutation: drop the `elsif v_variance_cents > 0` branch, posting a negative shrinkage instead. Expected: check 5 fails — the `1200` line is negative, not `1800`. Revert.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/20260908000400_post_receive_stock.sql supabase/migrations/20260908000600_post_stock_count.sql supabase/tests/verify-posting-inventory.sql
git commit -m "feat(accounting): stock receipts and count variances post to the ledger"
```

---

### Task 7: `record_invoice_payment` and `post_payroll_run` post

**Files:**
- Create: `supabase/migrations/20260908000500_post_bills_and_payroll.sql`
- Create: `supabase/tests/verify-posting-bills.sql`

**Interfaces:**
- Consumes: `invoice_payments.journal_entry_id`, `payroll_runs.journal_entry_id` (Task 2), `account_code_for_payment_method_checked` (Task 1).

Paying a supplier is **Dr 2000 Accounts Payable, Cr the cash account**. A pay run is **Dr 6200 Salaries and Wages, Cr the cash account** — paid immediately, because `post_payroll_run` records a run that has been paid, not one that is owed. `2200 Wages Payable` stays unused until phase 3's accrual work.

- [ ] **Step 1: Write the failing test**

Create `supabase/tests/verify-posting-bills.sql`:

```sql
  -- 1. Paying a supplier reduces what is owed. It does NOT post an expense --
  --    the expense was recognised when the goods or service arrived. Posting
  --    it again here is the single most common double-count in a first ledger.
  v_payment_id := public.record_invoice_payment(v_invoice_id, 4300, current_date, 'zaad');
  select journal_entry_id into v_entry from public.invoice_payments where id = v_payment_id;
  if v_entry is null then raise exception 'FAIL: the invoice payment did not post'; end if;

  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l join public.accounts a on a.id = l.account_id
   where l.entry_id = v_entry and a.code = '2000';
  if v_amount <> 4300 then
    raise exception 'FAIL: expected Dr 2000 Payable 4300, got %', v_amount;
  end if;

  -- Against the wallet it was actually paid from, not the till.
  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l join public.accounts a on a.id = l.account_id
   where l.entry_id = v_entry and a.code = '1021';
  if v_amount <> -4300 then
    raise exception 'FAIL: expected Cr 1021 eDahab -4300, got % (paid by zaad should not touch 1000 Cash)', v_amount;
  end if;

  if exists (select 1 from public.journal_lines l join public.accounts a on a.id = l.account_id
              where l.entry_id = v_entry and a.type = 'expense') then
    raise exception 'FAIL: paying a bill must not post an expense a second time';
  end if;

  -- 2. A pay run posts wages against cash.
  --    Three members at 15000, 22000 and 9000 = 46000. No two sum to it.
  v_run_id := public.post_payroll_run(v_run_id);
  select journal_entry_id into v_entry from public.payroll_runs where id = v_run_id;
  if v_entry is null then raise exception 'FAIL: the pay run did not post'; end if;

  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l join public.accounts a on a.id = l.account_id
   where l.entry_id = v_entry and a.code = '6200';
  if v_amount <> 46000 then
    raise exception 'FAIL: expected Dr 6200 Salaries 46000, got % (37000/31000/24000 = a member dropped)', v_amount;
  end if;

  -- 3. Posting the SAME run twice posts one entry, not two. post_payroll_run
  --    already refuses a posted run, so this asserts the guard still holds with
  --    a ledger behind it -- the failure mode being a second entry written
  --    before the status check raises.
  select count(*) into v_rows from public.journal_entries
   where shop_id = v_shop_id and source = 'payroll';
  begin
    perform public.post_payroll_run(v_run_id);
  exception when others then null;
  end;
  select count(*) - v_rows into v_rows from public.journal_entries
   where shop_id = v_shop_id and source = 'payroll';
  if v_rows <> 0 then
    raise exception 'FAIL: re-posting a pay run wrote % extra entries', v_rows;
  end if;
```

- [ ] **Step 2: Run it and verify it fails**

Run: `npm run test:db -- --no-reset`
Expected: `verify-posting-bills  FAIL` on check 1, `the invoice payment did not post`.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/20260908000500_post_bills_and_payroll.sql`, reproducing both functions in full.

In `record_invoice_payment`, after the payment row is inserted:

```sql
  -- No expense line. The expense was recognised when the bill arrived; this
  -- moves money against the liability that recognition created. Posting 6xxx
  -- again here would double every cost the shop has.
  v_entry_id := public.post_journal_entry(
    v_shop_id, p_paid_on, 'Supplier paid',
    jsonb_build_array(
      jsonb_build_object('code', '2000', 'amount_cents',  p_amount_cents, 'memo', 'Bill paid'),
      jsonb_build_object('code', public.account_code_for_payment_method_checked(p_method),
                         'amount_cents', -p_amount_cents, 'memo', 'Paid by ' || p_method)),
    null, 'bill_payment');
  update public.invoice_payments set journal_entry_id = v_entry_id where id = v_payment_id;
```

In `post_payroll_run`, after the run's status becomes `'posted'`:

```sql
  -- Cash, not 2200 Wages Payable: post_payroll_run records a run that HAS been
  -- paid. Accruing wages that are owed but unpaid is phase 3's work, and 2200
  -- stays unused until then rather than being written to speculatively.
  v_entry_id := public.post_journal_entry(
    v_run.shop_id, coalesce(v_run.paid_on, current_date), 'Payroll',
    jsonb_build_array(
      jsonb_build_object('code', '6200', 'amount_cents',  v_total, 'memo', 'Wages'),
      jsonb_build_object('code', '1000', 'amount_cents', -v_total, 'memo', 'Paid out')),
    v_run.location_id, 'payroll');
  update public.payroll_runs set journal_entry_id = v_entry_id where id = p_run_id;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test:db`
Expected: `verify-posting-bills  pass`, **22 database checks passed**.

- [ ] **Step 5: Prove the test can fail**

Mutation: add a `6900` debit line to `record_invoice_payment`. Expected: check 1 fails with `must not post an expense a second time`. Revert.

Mutation: hardcode `'1000'` as the credit account in `record_invoice_payment`. Expected: check 1 fails with `paid by zaad should not touch 1000 Cash`. Revert.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/20260908000500_post_bills_and_payroll.sql supabase/tests/verify-posting-bills.sql
git commit -m "feat(accounting): supplier payments and pay runs post to the ledger"
```

---

### Task 8: The historical backfill

Every existing row replayed into the ledger. This is the task with real risk, and the one that must **not** call `post_journal_entry`.

**Files:**
- Create: `supabase/migrations/20260908000700_backfill_ledger.sql`

**Interfaces:**
- Produces: `public.backfill_shop_ledger(p_shop_id uuid) returns integer` — the number of entries written. Idempotent: rows already carrying a `journal_entry_id` are skipped, so re-running writes nothing and returns 0.

#### Why the backfill bypasses `post_journal_entry`

Two reasons, both structural:

1. **The reference generator is O(n) per call.** `post_journal_entry` computes `'JE-' || year || '-' || lpad(count(*) + 1)` by counting the shop's entries for that year. Called once per historical row, that is O(n²) — a shop with 8,000 sales does 32 million row counts. This is fine for the interactive path it was written for and unusable for a replay.
2. **It opens periods one at a time.** `open_period_for` inserts a period on first use. Fine interactively; wasteful across three years of history, and it raises the moment it meets a month someone has already closed — which would abort a replay halfway through.

The backfill therefore creates the periods it needs up front, generates references with a window function, and inserts `journal_entries` and `journal_lines` directly. **The deferred balance trigger still runs**, so the guarantee is unchanged — only the convenience wrapper is skipped.

- [ ] **Step 1: Write the failing test**

Create `supabase/tests/verify-backfill.sql`. The fixture writes rows **directly**, bypassing the RPCs, to simulate history that predates posting:

```sql
  -- The fixture inserts a sale, its items and its payment DIRECTLY -- not
  -- through complete_sale -- because that is what pre-2b history looks like: a
  -- row with no journal_entry_id and no entry behind it.

  -- 1. Before the backfill, nothing is posted.
  select count(*) into v_rows from public.journal_entries where shop_id = v_shop_id;
  if v_rows <> 0 then
    raise exception 'FIXTURE: expected an empty ledger, found % entries', v_rows;
  end if;

  -- 2. The backfill posts every unposted row and says how many.
  v_posted := public.backfill_shop_ledger(v_shop_id);
  if v_posted <> 4 then
    raise exception 'FAIL: expected 4 entries (2 sales, 1 receipt, 1 expense), got %', v_posted;
  end if;

  -- 3. THE ONE THAT MATTERS. The ledger ties to the existing report totals TO
  --    THE CENT. This is the check that decides whether the backfill is
  --    trusted, and it compares against the figures the app reports TODAY --
  --    not against a re-derivation, which would just be the same arithmetic
  --    twice.
  --
  --    Revenue: two sales at 6000 and 15500 gross = 21500.
  select coalesce(sum(-l.amount_cents), 0) into v_ledger
    from public.journal_lines l
    join public.accounts a on a.id = l.account_id
    join public.journal_entries e on e.id = l.entry_id
   where e.shop_id = v_shop_id and a.code = '4000';
  select coalesce(sum(si.line_total_cents), 0) into v_report
    from public.sale_items si join public.sales s on s.id = si.sale_id
   where s.shop_id = v_shop_id;
  if v_ledger <> v_report then
    raise exception 'FAIL: 4000 Revenue is % but the sales tables say % -- off by %',
      v_ledger, v_report, v_ledger - v_report;
  end if;

  --    COGS against the frozen line costs, the same source costOfGoodsSold()
  --    reads.
  select coalesce(sum(l.amount_cents), 0) into v_ledger
    from public.journal_lines l
    join public.accounts a on a.id = l.account_id
    join public.journal_entries e on e.id = l.entry_id
   where e.shop_id = v_shop_id and a.code = '5000';
  select coalesce(sum(si.unit_cost_cents::bigint * si.quantity), 0) into v_report
    from public.sale_items si join public.sales s on s.id = si.sale_id
   where s.shop_id = v_shop_id and si.unit_cost_cents is not null;
  if v_ledger <> v_report then
    raise exception 'FAIL: 5000 COGS is % but the frozen line costs say % -- off by %',
      v_ledger, v_report, v_ledger - v_report;
  end if;

  -- 4. The trial balance is zero. If every entry balances the total must, but
  --    asserting it here is what catches an entry written with the trigger
  --    disabled -- which a backfill inserting directly could do.
  select coalesce(sum(l.amount_cents), 0) into v_ledger
    from public.journal_lines l join public.journal_entries e on e.id = l.entry_id
   where e.shop_id = v_shop_id;
  if v_ledger <> 0 then
    raise exception 'FAIL: the trial balance does not zero, off by %', v_ledger;
  end if;

  -- 5. Nothing is left unposted. A backfill that quietly skipped rows would
  --    pass every total above, because the totals would both be short.
  select count(*) into v_rows from public.sales where shop_id = v_shop_id and journal_entry_id is null;
  if v_rows <> 0 then
    raise exception 'FAIL: % sales are still unposted after the backfill', v_rows;
  end if;

  -- 6. IDEMPOTENT. It will be re-run -- the first run always finds something
  --    check 3 disagrees with. Running it twice must not double the books.
  v_posted := public.backfill_shop_ledger(v_shop_id);
  if v_posted <> 0 then
    raise exception 'FAIL: a second backfill wrote % more entries', v_posted;
  end if;
  select coalesce(sum(-l.amount_cents), 0) into v_ledger
    from public.journal_lines l
    join public.accounts a on a.id = l.account_id
    join public.journal_entries e on e.id = l.entry_id
   where e.shop_id = v_shop_id and a.code = '4000';
  if v_ledger <> 21500 then
    raise exception 'FAIL: revenue doubled to % after a second run', v_ledger;
  end if;

  -- 7. Entries are dated when the event happened, not when the backfill ran.
  --    A replay that stamped everything today would put three years of trading
  --    into this month and make every past period empty.
  if exists (
    select 1 from public.journal_entries e join public.sales s on s.journal_entry_id = e.id
     where e.shop_id = v_shop_id and e.entry_date <> s.created_at::date
  ) then
    raise exception 'FAIL: a backfilled entry is not dated on its sale';
  end if;

  -- 8. A CLOSED period does not abort the replay. The backfill inserts
  --    directly and does not consult open_period_for, which raises on a closed
  --    month -- so a shop that closed a month during phase 1 can still be
  --    backfilled. Without this, the replay dies halfway and leaves the books
  --    in a state worse than not having started.
  update public.accounting_periods set status = 'closed'
   where shop_id = v_shop_id and starts_on = date_trunc('month', v_old_sale_date)::date;
  update public.sales set journal_entry_id = null where shop_id = v_shop_id;
  delete from public.journal_lines where entry_id in (select id from public.journal_entries where shop_id = v_shop_id);
  delete from public.journal_entries where shop_id = v_shop_id;
  v_posted := public.backfill_shop_ledger(v_shop_id);
  if v_posted < 2 then
    raise exception 'FAIL: a closed period stopped the backfill, only % entries written', v_posted;
  end if;
```

- [ ] **Step 2: Run it and verify it fails**

Run: `npm run test:db -- --no-reset`
Expected: `verify-backfill  FAIL` with `function public.backfill_shop_ledger(uuid) does not exist`.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/20260908000700_backfill_ledger.sql`:

```sql
-- Replay every existing row into the ledger.
--
-- ## Why this does not call post_journal_entry
--
-- Two structural reasons, not a preference:
--
--   1. Its reference generator counts the shop's entries for the year on EVERY
--      call -- O(n) per entry, so O(n^2) over a replay. A shop with 8,000
--      sales would perform 32 million row counts. That is fine for the
--      interactive path it was written for and unusable here.
--   2. open_period_for RAISES on a closed or locked month. A shop that closed
--      a period during phase 1 would abort the replay part-way, leaving the
--      books in a state strictly worse than not having started.
--
-- The deferred balance trigger on journal_lines still runs, so the guarantee
-- that every entry sums to zero is unchanged. Only the wrapper is skipped, and
-- this is the ONLY thing in the codebase that skips it.
--
-- ## Idempotency
--
-- Driven by journal_entry_id being null. Re-running writes nothing and returns
-- 0. This matters more than it sounds: the first run of a real backfill always
-- finds something the verification script disagrees with, and the fix is to
-- correct the mapping and run it again.

create or replace function public.backfill_shop_ledger(p_shop_id uuid)
returns integer
language plpgsql security definer set search_path = public as $$
declare
  v_written integer := 0;
  v_year text;
begin
  if not public.has_shop_permission(p_shop_id, 'ledger.close') then
    raise exception 'Backfilling the ledger needs ledger.close.' using errcode = 'P0001';
  end if;

  -- Every month any unposted row falls in, created up front and left OPEN.
  -- Doing this per row is what makes open_period_for the wrong tool here.
  insert into public.accounting_periods (shop_id, starts_on, ends_on)
  select p_shop_id, m::date, (m + interval '1 month - 1 day')::date
    from (
      select distinct date_trunc('month', d) m from (
        select created_at d from public.sales          where shop_id = p_shop_id and journal_entry_id is null
        union all
        select created_at   from public.stock_receipts where shop_id = p_shop_id and journal_entry_id is null
        union all
        select occurred_on::timestamptz from public.expenses where shop_id = p_shop_id and journal_entry_id is null
      ) t
    ) months
  on conflict (shop_id, starts_on) do nothing;

  -- The entry id is generated HERE rather than taken from a RETURNING clause,
  -- because the lines need to be joined back to their source row and an
  -- INSERT ... RETURNING cannot return a column it did not insert. A temp
  -- table holding (source row -> entry) is the readable way to carry that
  -- mapping across the three statements that need it.
  create temporary table if not exists _bf_map (
    source_kind text, source_id uuid, entry_id uuid, on_date date, location_id uuid
  ) on commit drop;
  delete from _bf_map;

  -- One reference series per shop per year, numbered by a window function in a
  -- single pass rather than a count per row. The offset is read ONCE per year
  -- rather than per entry -- that difference is the whole reason this function
  -- exists instead of a loop over post_journal_entry.
  for v_year in
    select distinct to_char(created_at, 'YYYY') from public.sales
     where shop_id = p_shop_id and journal_entry_id is null
  loop
    select coalesce(count(*), 0) into v_offset
      from public.journal_entries
     where shop_id = p_shop_id and to_char(entry_date, 'YYYY') = v_year;

    insert into _bf_map (source_kind, source_id, entry_id, on_date, location_id)
    select 'sale', s.id, gen_random_uuid(), s.created_at::date, s.location_id
      from public.sales s
     where s.shop_id = p_shop_id
       and s.journal_entry_id is null
       and to_char(s.created_at, 'YYYY') = v_year;

    insert into public.journal_entries
        (id, shop_id, period_id, entry_date, reference, description, source, status, location_id)
    select m.entry_id, p_shop_id,
           (select ap.id from public.accounting_periods ap
             where ap.shop_id = p_shop_id and m.on_date between ap.starts_on and ap.ends_on),
           m.on_date,
           'JE-' || v_year || '-' ||
             lpad((v_offset + row_number() over (order by m.on_date, m.source_id))::text, 4, '0'),
           'Sale (backfilled)', 'backfill', 'posted', m.location_id
      from _bf_map m
     where m.source_kind = 'sale';

    update public.sales s set journal_entry_id = m.entry_id
      from _bf_map m where m.source_kind = 'sale' and m.source_id = s.id;

    -- The lines, in exactly Task 3's shape. Built as a UNION ALL of the six
    -- line kinds and filtered to non-zero at the end, which is what lets the
    -- COGS pair and the discount line disappear rather than post a zero --
    -- journal_lines carries check (amount_cents <> 0).
    insert into public.journal_lines (entry_id, account_id, amount_cents, location_id, memo)
    select x.entry_id, a.id, x.amount_cents, x.location_id, x.memo
      from (
        -- Cash in, one line per method actually used. Settlements are excluded:
        -- they are their own entry, on the date the money arrived.
        select m.entry_id, m.location_id,
               public.account_code_for_payment_method_checked(sp.method) as code,
               sum(sp.amount_cents)::bigint as amount_cents,
               'Payment by ' || sp.method as memo
          from _bf_map m
          join public.sale_payments sp on sp.sale_id = m.source_id
         where m.source_kind = 'sale' and not coalesce(sp.is_settlement, false)
         group by m.entry_id, m.location_id, sp.method

        union all
        -- What was left on account. DERIVED -- there is no sale_balances
        -- table; a balance is the sale's total less what the till took, and
        -- settlement payments are excluded because they arrive later and post
        -- their own entry.
        select m.entry_id, m.location_id, '1100',
               (s.total_cents - coalesce((
                 select sum(sp2.amount_cents) from public.sale_payments sp2
                  where sp2.sale_id = m.source_id and not coalesce(sp2.is_settlement, false)
               ), 0))::bigint, 'Left on account'
          from _bf_map m join public.sales s on s.id = m.source_id
         where m.source_kind = 'sale'

        union all
        -- Discounts, shown gross against revenue at list.
        select m.entry_id, m.location_id, '4200',
               coalesce(s.discount_cents, 0)::bigint, 'Discount'
          from _bf_map m join public.sales s on s.id = m.source_id
         where m.source_kind = 'sale'

        union all
        -- Revenue at list price, before discount and excluding tax.
        select m.entry_id, m.location_id, '4000',
               -coalesce(sum(si.line_total_cents), 0)::bigint, 'Sale'
          from _bf_map m join public.sale_items si on si.sale_id = m.source_id
         where m.source_kind = 'sale'
         group by m.entry_id, m.location_id

        union all
        select m.entry_id, m.location_id, '2100',
               -coalesce(s.tax_cents, 0)::bigint, 'Sales tax'
          from _bf_map m join public.sales s on s.id = m.source_id
         where m.source_kind = 'sale'

        union all
        -- COGS from the frozen line costs, costed lines only.
        select m.entry_id, m.location_id, '5000',
               coalesce(sum(si.unit_cost_cents::bigint * si.quantity), 0), 'Cost of goods sold'
          from _bf_map m join public.sale_items si on si.sale_id = m.source_id
         where m.source_kind = 'sale' and si.unit_cost_cents is not null
         group by m.entry_id, m.location_id

        union all
        select m.entry_id, m.location_id, '1200',
               -coalesce(sum(si.unit_cost_cents::bigint * si.quantity), 0), 'Stock sold'
          from _bf_map m join public.sale_items si on si.sale_id = m.source_id
         where m.source_kind = 'sale' and si.unit_cost_cents is not null
         group by m.entry_id, m.location_id
      ) x
      join public.accounts a on a.shop_id = p_shop_id and a.code = x.code and a.archived_at is null
     where x.amount_cents <> 0;

    select v_written + count(*) into v_written from _bf_map where source_kind = 'sale';
    delete from _bf_map;
  end loop;

  -- Stock receipts. Two lines, so no union needed -- Dr 1200, Cr 2000, at the
  -- delivery's costed value.
  insert into _bf_map (source_kind, source_id, entry_id, on_date, location_id)
  select 'receipt', r.id, gen_random_uuid(), r.created_at::date, r.location_id
    from public.stock_receipts r
   where r.shop_id = p_shop_id and r.journal_entry_id is null
     and exists (select 1 from public.stock_receipt_items ri
                  where ri.receipt_id = r.id and ri.unit_cost_cents is not null);

  insert into public.journal_entries
      (id, shop_id, period_id, entry_date, reference, description, source, status, location_id)
  select m.entry_id, p_shop_id,
         (select ap.id from public.accounting_periods ap
           where ap.shop_id = p_shop_id and m.on_date between ap.starts_on and ap.ends_on),
         m.on_date,
         'JE-' || to_char(m.on_date, 'YYYY') || '-R' ||
           lpad(row_number() over (order by m.on_date, m.source_id)::text, 4, '0'),
         'Stock received (backfilled)', 'backfill', 'posted', m.location_id
    from _bf_map m where m.source_kind = 'receipt';

  update public.stock_receipts r set journal_entry_id = m.entry_id
    from _bf_map m where m.source_kind = 'receipt' and m.source_id = r.id;

  insert into public.journal_lines (entry_id, account_id, amount_cents, location_id, memo)
  select x.entry_id, a.id, x.amount_cents, x.location_id, x.memo
    from (
      select m.entry_id, m.location_id, '1200' as code,
             sum(ri.unit_cost_cents::bigint * ri.quantity) as amount_cents, 'Delivery received' as memo
        from _bf_map m join public.stock_receipt_items ri on ri.receipt_id = m.source_id
       where m.source_kind = 'receipt' and ri.unit_cost_cents is not null
       group by m.entry_id, m.location_id
      union all
      select m.entry_id, m.location_id, '2000',
             -sum(ri.unit_cost_cents::bigint * ri.quantity), 'Owed to supplier'
        from _bf_map m join public.stock_receipt_items ri on ri.receipt_id = m.source_id
       where m.source_kind = 'receipt' and ri.unit_cost_cents is not null
       group by m.entry_id, m.location_id
    ) x
    join public.accounts a on a.shop_id = p_shop_id and a.code = x.code and a.archived_at is null
   where x.amount_cents <> 0;

  select v_written + count(*) into v_written from _bf_map where source_kind = 'receipt';
  delete from _bf_map;

  -- Expenses. Dr whatever the category maps to, Cr cash -- which is why
  -- inventory_purchase and owner_draw stop being expenses here: the mapping
  -- sends them to 1200 and 3100, and the P&L stops needing a filter to be
  -- right.
  insert into _bf_map (source_kind, source_id, entry_id, on_date, location_id)
  select 'expense', e.id, gen_random_uuid(), e.occurred_on, e.location_id
    from public.expenses e
   where e.shop_id = p_shop_id and e.journal_entry_id is null and e.amount_cents <> 0;

  insert into public.journal_entries
      (id, shop_id, period_id, entry_date, reference, description, source, status, location_id)
  select m.entry_id, p_shop_id,
         (select ap.id from public.accounting_periods ap
           where ap.shop_id = p_shop_id and m.on_date between ap.starts_on and ap.ends_on),
         m.on_date,
         'JE-' || to_char(m.on_date, 'YYYY') || '-E' ||
           lpad(row_number() over (order by m.on_date, m.source_id)::text, 4, '0'),
         'Expense (backfilled)', 'backfill', 'posted', m.location_id
    from _bf_map m where m.source_kind = 'expense';

  update public.expenses e set journal_entry_id = m.entry_id
    from _bf_map m where m.source_kind = 'expense' and m.source_id = e.id;

  insert into public.journal_lines (entry_id, account_id, amount_cents, location_id, memo)
  select x.entry_id, a.id, x.amount_cents, x.location_id, x.memo
    from (
      select m.entry_id, m.location_id,
             public.account_code_for_expense_category(e.category) as code,
             e.amount_cents::bigint, e.category as memo
        from _bf_map m join public.expenses e on e.id = m.source_id
       where m.source_kind = 'expense'
      union all
      select m.entry_id, m.location_id, '1000',
             -e.amount_cents::bigint, 'Paid'
        from _bf_map m join public.expenses e on e.id = m.source_id
       where m.source_kind = 'expense'
    ) x
    join public.accounts a on a.shop_id = p_shop_id and a.code = x.code and a.archived_at is null
   where x.amount_cents <> 0;

  select v_written + count(*) into v_written from _bf_map where source_kind = 'expense';

  return v_written;
end;
$$;

grant execute on function public.backfill_shop_ledger(uuid) to authenticated;
```

Add to `declare`: `v_offset integer;`.

> **Refunds, settlements, invoice payments, pay runs and stock counts follow the same three-statement shape** — map, entries, lines — and every one of them is a **two-line** entry taken directly from its task above (Task 5, Task 6, Task 7). Write them the same way. They are omitted here only because repeating the identical scaffold five more times would make this migration unreadable, not because their shape is undecided: each one's debit, credit and amount is fully specified in its own task.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test:db`
Expected: `verify-backfill  pass`, **23 database checks passed**.

- [ ] **Step 5: Prove the test can fail**

Mutation: remove the `and journal_entry_id is null` filter. Expected: check 6 fails — the second run doubles revenue to 43000. Revert.

Mutation: date entries `now()::date` instead of the sale's date. Expected: check 7 fails. Revert.

Mutation: call `open_period_for` instead of the up-front period insert. Expected: check 8 fails — the closed month aborts the replay. Revert.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/20260908000700_backfill_ledger.sql supabase/tests/verify-backfill.sql
git commit -m "feat(accounting): replay existing history into the ledger"
```

---

### Task 9: Prove it end to end

- [ ] **Step 1: Full suite**

Run: `npx tsc --noEmit && npm test && npm run lint && npm run test:db`
Expected: clean; 139 suites / 2122 tests (plus the two new `accumulated-rpc-edits` assertions); 81 lint; **23** database checks.

- [ ] **Step 2: Confirm the weighted average survived**

Run: `psql "$SUPABASE_DB_URL" -f supabase/tests/verify-weighted-average.sql`
Expected: `ALL CHECKS PASSED`.

This is checked separately and deliberately. Task 6 copies `receive_stock` forward, and copying it from the wrong ancestor restores an impermissible cost basis while every posting test still passes.

- [ ] **Step 3: In the running app**

Take a sale through POS, then open Accounting → Trial Balance and confirm debits equal credits and the sale's figures appear.

> **The app reads a remote Supabase project, not the local stack.** Verifying posting in the running app needs this phase's migrations deployed, or the app pointed at the local stack on a separate port. Do not report this step as passed against a database that does not carry the migrations.

> **`browser_click` gives false negatives on this app.** Playwright's click does not deliver the pointer sequence React Native Web's `Pressable` needs. Dispatch the full `pointerdown` / `mousedown` / `pointerup` / `mouseup` / `click` sequence. Note also that some rows render as `<button>`, not `<div>` — select on both.

- [ ] **Step 4: Run the backfill against a copy of production, and check it ties**

Not against production itself. Restore a dump locally, run `backfill_shop_ledger` for the largest shop, and run `verify-backfill`'s check 3 against the real figures. Record the entry count and the wall time.

If it does not tie to the cent, **the mapping is wrong, not the tolerance**. Do not add one.

---

## What this unblocks

**Phase 3 — the statements** becomes possible: balance sheet, cash flow and income statement all read what this phase writes. **Cash becoming derived** — the stated outcome of 2b — becomes a read-side change with real data behind it.
