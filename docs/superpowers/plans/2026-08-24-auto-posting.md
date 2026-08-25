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

**Every posting call in this plan passes an explicit `p_source`.** Never `'manual'`.

`journal_entries.source` carries a CHECK constraint, and a value outside it fails the whole
transaction. The permitted values are exactly:

    manual, sale, refund, settlement, bill, payment, payroll, stock, count,
    transfer, asset, depreciation, close, opening

So this phase uses `'sale'`, `'refund'`, `'settlement'`, `'stock'` (receipts), `'count'`,
`'payment'` (supplier payments) and `'payroll'`. Earlier drafts of this plan named
`'receipt'`, `'bill_payment'` and `'backfill'` — **none of those exist** and each would have
failed at the first call. Check the constraint before inventing a source.

**Backfilled entries carry their TRUE source**, not a `'backfill'` marker: a P&L must not care
whether an entry was posted live or replayed, and a report filtering on source would silently
drop replayed history. The only exception is a genuine opening-balance entry, which is
`'opening'`.

**Every `p_entry_date` comes from `public.shop_local_date()` (`20260908000320_shop_local_date.sql`), never a bare `now()::date` or `current_date`.** A bare cast resolves in the database session's timezone — UTC on Supabase — and Somalia is UTC+3, so a transaction near midnight local posts into the wrong month, permanently, once that month closes. `complete_sale` (Task 3b) predates the function and keeps its inline `at time zone 'Africa/Mogadishu'` expression rather than being copied forward for a cosmetic change; every task below is new code and has no such excuse. The one exception is `record_invoice_payment`'s `p_paid_on` (Task 7), which arrives as a `date`, not a `timestamptz` — there is no timezone to resolve, so it passes through unchanged.

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

### A reversal carries the same source as the entry it reverses

*(Pinned by the final whole-branch review, as finding I5. It was not pinned while the phase was being built, and the two sites that write reversals drifted to opposite conventions: `edit_sale` filed its reversal as `'manual'`, inherited from `reverse_journal_entry`; `unpost_payroll_run` filed its as `'payroll'` and explained why.)*

**A reversal's `source` is the `source` of the entry it reverses.** `'sale'` reverses `'sale'`, `'refund'` reverses `'refund'`, `'settlement'` reverses `'settlement'`, `'payroll'` reverses `'payroll'`.

The failure is a reporting one, and it is silent: `where source = 'sale'` returns an edited sale's original entry **and** its replacement but **not** the reversal cancelling the original, so any phase-3 report grouping by source shows that sale's revenue twice. In the other direction the manual-journal view lists entries nobody typed. Both entries balance, the trial balance zeroes, and every totals check ties.

`public.reverse_journal_entry` is the **one deliberate exception** and is not to be changed. Its `'manual'` is the true source of the entry it writes: it gates on `ledger.post`, so its reversal really was typed by a human at the manual-entry screen. The posting RPCs are the opposite case — each is gated on its own door's permission, each passes `p_source <> 'manual'` for that reason, and each reverses **inline** so it never reaches that function. The reason is written at the function in `20260904000500_journal_rpcs.sql`.

Asserted by check 23 of `verify-posting-sales.sql` and check 10 of `verify-posting-bills.sql`, both of which sweep every reversal in the fixture shop and both of which assert the sweep is not vacuous.

### References come from `journal_entry_sequences`, not from `count(*)`

`20260908000150_journal_entry_sequence.sql` replaced `post_journal_entry`'s reference allocation. It used to be `'JE-'||year||'-'||lpad(count(*)+1)` over the shop's entries for that year, which under READ COMMITTED handed two concurrent posters the same reference — the second died on `unique (shop_id, reference)` with a raw constraint name, and there is no application-layer retry (`src/lib/sales.ts` does `if (error) throw error`). Tolerable while only the manual-entry screen posted; not once every sale does.

It is now a per-shop-per-year counter row taken with one `insert ... on conflict do update ... returning`, which serialises on a row lock and is O(1) instead of a sequential scan over every entry the shop ever posted.

**Task 8's backfill must allocate from the same source.** It bypasses `post_journal_entry` deliberately, so it has to bump `journal_entry_sequences` itself — reading `count(*)` there would hand replayed entries references that a live sale is about to reuse.

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

*An expense recorded after this phase would not post — an `AFTER INSERT` trigger on `expenses`. **Decided and shipped: see Task 7b.***

---

**`customer_balances` and the ledger's `1100` diverge after a partial return of a part-paid sale.** `customer_balances.owed_cents` (`20260831000200:334`) and `settle_sale_balance`'s `v_owed` both compute `total − goods_returned − paid`; neither adds back the cash actually handed over on the refund. The journal is correct (`(T−P)` less `(G−C)`); the app is not. Worked example: total 6300, paid 2000, one unit returned worth 3150 with 2000 cash out — the journal reads `1100 = 3150`, `customer_balances` says `1150`, and `settle_sale_balance` refuses more than 1150 and then sets `settled_at`, stranding 2000 in Accounts Receivable that nothing will ever collect. The two formulas coincide only on a full return, which is what the tests exercise. Root cause is upstream of this phase; Task 8's verification must not read the resulting difference as a backfill defect.

**This needs an owner.** It is an upstream defect that this phase turns into a balance-sheet number, so it stops being an app-only inconsistency the moment the ledger is trusted.

---

## File Structure

| File | Responsibility |
|---|---|
| `supabase/migrations/20260908000000_posting_account_map.sql` | The two mapping functions. Nothing else. |
| `supabase/migrations/20260908000100_posting_idempotency.sql` | `journal_entry_id` on eight source tables. |
| `supabase/migrations/20260908000200_post_complete_sale.sql` | `complete_sale`, copied forward with a posting side. |
| `supabase/migrations/20260908000300_sale_entry_date.sql` | Task 3b. The entry date is shop-local, and a closed month redates rather than refusing. |
| `supabase/migrations/20260908000320_shop_local_date.sql` | `public.shop_local_date()`. One definition of the shop's local date, for every task below to call instead of copying the `at time zone 'Africa/Mogadishu'` expression again. Not itself a task — created ahead of Task 5 so it exists before its first caller. |
| `supabase/migrations/20260908000350_post_refund_and_settlement.sql` | `refund_sale_items`, `settle_sale_balance`. |
| `supabase/migrations/20260908000360_settle_at_its_till_and_split_a_refund.sql` | Task 5's review fixes, copied forward from `20260908000350`: a settlement's entry carries the settling till's location, and a refund credits every tender it came in on. |
| `supabase/migrations/20260908000400_post_receive_stock.sql` | `receive_stock`, copied forward from `20260907000000`. |
| `supabase/migrations/20260908000500_post_bills_and_payroll.sql` | `record_invoice_payment`, `post_payroll_run`, `unpost_payroll_run`. |
| `supabase/migrations/20260908000600_post_stock_count.sql` | `save_stock_count`. |
| `supabase/migrations/20260908000650_post_sale_edit.sql` | Task 5b. `edit_sale`, copied forward: reverse, re-post, re-point. |
| `supabase/migrations/20260908000700_backfill_ledger.sql` | `backfill_shop_ledger(uuid)`. |
| `supabase/migrations/20260908000750_post_expenses.sql` | Task 7b. The `AFTER INSERT` trigger on `expenses`. Numbered after the backfill because it was added once the backfill's number was already claimed; neither depends on the other's objects, so the order they apply in does not matter. |
| `supabase/migrations/20260908000800_expense_source_links.sql` | The final review's C1/C2 fix. Adds `expenses.stock_receipt_id` and `expenses.stock_count_id` and replaces `post_expense_to_ledger()` with the six-way branch. See the correction under Task 7b. |
| `supabase/migrations/20260908000900_post_sale_delete.sql` | Task 5c, the final review's C3 fix. `delete_sale`, copied forward from `20260820000100`: reverse the sale's entry, its refunds' and its settlements', then delete. Numbered after the backfill for the same reason `20260908000750` is — the number was already claimed — and it depends on nothing either of them creates. |
| `supabase/tests/verify-shop-local-date.sql` | `shop_local_date()` crosses the UTC/local month boundary correctly and is `immutable`. |
| `supabase/tests/verify-posting-map.sql` | Every enum value maps to a live account. |
| `supabase/tests/verify-posting-sales.sql` | Sale, credit sale, refund, settlement entries. |
| `supabase/tests/verify-posting-inventory.sql` | Receipt and stock-count entries. |
| `supabase/tests/verify-posting-bills.sql` | Invoice payment and pay run entries. |
| `supabase/tests/verify-posting-expenses.sql` | An expense written by a plain `insert` posts; a payroll- or bill-derived expense row posts nothing. |
| `supabase/tests/verify-backfill.sql` | The backfill ties to the cent, and is idempotent. |
| `supabase/tests/bench-complete-sale.sql` | Measured before/after on a 20-line basket. |

`test:db` goes from **18** to **24** (23 before Task 7b added `verify-posting-expenses.sql`). `bench-complete-sale.sql` carries `@no-verdict` so the runner skips it — it prints timings, it does not assert.

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

-- Raises rather than returning null: a null code reaches post_journal_entry
-- as "No such account: " with nothing after it, which is a worse message at
-- a later moment than this one.
create or replace function public.account_code_for_payment_method(p_method text)
returns text
language plpgsql immutable as $$
declare v_code text;
begin
  v_code := case p_method
    when 'cash'   then '1000'
    when 'zaad'   then '1020'
    when 'edahab' then '1021'
    -- 'other' is a transfer, not till money. Putting it in 1000 Cash would make
    -- the drawer count disagree with the ledger for a reason nobody could find.
    when 'other'  then '1010'
  end;
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
-- Keyed on sale_id, not shop_id: refunds has no shop_id column of its own --
-- a shop is only reachable via refunds.sale_id -> sales.shop_id. sale_id is
-- also the join key the backfill will use to get there, so it's the right
-- column even though every sibling index here is keyed on shop_id directly.
create index if not exists refunds_unposted_idx          on public.refunds(sale_id)        where journal_entry_id is null;
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
- Create: `supabase/migrations/20260908000150_journal_entry_sequence.sql`
- Create: `supabase/migrations/20260908000200_post_complete_sale.sql`
- Create: `supabase/tests/verify-posting-sales.sql`
- Modify: `supabase/tests/accumulated-rpc-edits.test.ts`

**Interfaces:**
- Consumes: `account_code_for_payment_method(text)` (Task 1), `sales.journal_entry_id` (Task 2).
- Produces: a `journal_entries` row per sale with `source = 'sale'`.

#### The entry, and why it balances

Using `complete_sale`'s own variables:

| Line | Account | Amount |
|---|---|---|
| Dr | per payment, `account_code_for_payment_method(method)` | that payment's `amount_cents` |
| Dr | `1100` Accounts Receivable | `v_owed_cents` (= `v_total_cents - v_payments_total`), when the sale is left part-paid |
| Dr | `4200` Discounts Given | `v_discount_cents + v_redeem_cents + v_item_discount_cents` |
| Cr | `4000` Sales Revenue | `v_gross_cents + v_item_discount_cents` — revenue at **list** |
| Cr | `2100` Sales Tax Payable | `v_tax_cents` |

**`v_item_discount_cents` is not optional and is not derivable from the variables.** The three discounts are not symmetrical in this function. `v_discount_cents` (order-level) and `v_redeem_cents` (points) are subtracted *after* `v_gross_cents` is final, so `v_gross_cents` is gross with respect to them. Line and promotion discounts are not: the item loop computes `v_line := price_cents * qty - v_line_discount` and accumulates **that**, so `v_gross_cents` is already net of them. Credit `4000` with a bare `v_gross_cents` and a shop whose discounts are all promotions — the app's main discount mechanism — reads `4200 Discounts Given` as flat zero with Sales Revenue understated by the same amount, and no `4200` line is written at all. Read the figure back off the rows:

```sql
  select coalesce(sum(si.discount_cents), 0)
    into v_item_discount_cents
    from public.sale_items si
   where si.sale_id = v_sale_id;
```

Writing D for `v_discount_cents`, R for `v_redeem_cents`, I for `v_item_discount_cents`, G for `v_gross_cents` and T for `v_tax_cents`: the function computes `v_total_cents = G - D - R + T`, so the debits (money in `= v_total_cents`, plus the contra `D + R + I`) total `G + T + I`, and the credits (revenue `G + I`, plus tax `T`) are the same figure. It balances by construction, not by hope.

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
  perform set_config('request.jwt.claims', json_build_object('sub', v_staff_id)::text, true);
  -- Asserted, not assumed: a fixture that drifted into handing the cashier
  -- ledger.post would make check 5 pass while proving nothing at all.
  if public.has_shop_permission(v_shop_id, 'ledger.post') then
    raise exception 'FAIL: the fixture cashier holds ledger.post, so check 5 would prove nothing';
  end if;
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

> The fixture must create `v_staff_id`, `v_staff_role_id` and `v_prod_uncosted`, and give the staff member `pos.access` only. Copy the role-and-member setup from `verify-inventory-permissions.sql`, which already does exactly this — but note there is **no `grant_role_permissions()` helper** in this database. Permissions are a `text[]` column set inline, and the table is `public.roles`, not `shop_roles`:
>
> ```sql
> insert into public.roles (shop_id, name, permissions)
>   values (v_shop_id, 'Till Only', array['pos.access'])
>   returning id into v_staff_role_id;
> insert into public.shop_members (shop_id, user_id, role_id, active)
>   values (v_shop_id, v_staff_id, v_staff_role_id, true);
> ```
>
> Both inserts must happen **before** the JWT claim is switched, while raw inserts are still possible.

Three further checks, added after review:

- **Check 6 — a LINE-level discount.** 1 @ 2000 less **500**, tax 5% of 1500 = 75, total 1575. Assert `Cr 4000 = -2000` (list) and `Dr 4200 = 500`. It must be a *line* discount: an order-level one is subtracted after `v_gross_cents` is final and passes against the broken code, so only this shape catches the bug. Assert the 500 actually landed on `sale_items` first, or the check measures an undiscounted sale.
- **Check 7 — the reference allocator.** See Step 2a. Asserts the mechanism, not a collision.
- **Check 8 — the COGS freeze, with teeth.** The earlier version asserted `5000 = 2500` while `products.cost_cents` never moved, so an implementation reading `products.cost_cents` gave the identical 2500 and the check whose comment said "never `products.cost_cents`" could not fail. Now: `update products set cost_cents = 9999`, post a new sale of that product and assert its `5000` line is **9999** (proving the fixture really changed), then re-assert check 1's entry still reads **2500**. Keep check 1's entry id in its own variable — `v_entry` is overwritten by every later check.
- The entry's description must name its sale (`'Sale ' || v_sale_id`), asserted in check 1. A journals list of four hundred rows all reading `Sale` points back at nothing.

- [ ] **Step 2: Run it and verify it fails**

Run: `npm run test:db -- --no-reset`
Expected: `verify-posting-sales  FAIL` on check 1, `the sale did not post a journal entry`.

- [ ] **Step 2a: Serialise the reference allocator — before anything calls it per sale**

Create `supabase/migrations/20260908000150_journal_entry_sequence.sql`. The number sorts **after** `20260908000100` and **before** `20260908000200`.

`post_journal_entry` allocated its reference by counting the shop's entries for the year and adding one, then inserted against `unique (shop_id, reference)`. Under READ COMMITTED two overlapping transactions in the same shop count the same N, build the same `JE-YYYY-000(N+1)`, and the second raises `unique_violation` when the first commits. The function's own comment claimed the loser "retries at the application layer" — **there is no such retry**: `src/lib/sales.ts` does `if (error) throw error` and `src/lib/checkout-errors.ts` passes an unknown message through verbatim, so the cashier is shown `duplicate key value violates unique constraint "journal_entries_shop_id_reference_key"` and loses the basket. Survivable while only the manual-entry screen posted; not once **every sale** does.

```sql
create table if not exists public.journal_entry_sequences (
  shop_id uuid not null references public.shops(id) on delete cascade,
  year text not null,
  next_number integer not null default 1,
  primary key (shop_id, year)
);

-- Seed for shops that already have entries, or numbering restarts at 1 and the
-- next sale collides with an entry posted months ago.
insert into public.journal_entry_sequences (shop_id, year, next_number)
select shop_id, to_char(entry_date, 'YYYY'), count(*) + 1
  from public.journal_entries group by shop_id, to_char(entry_date, 'YYYY')
on conflict do nothing;

alter table public.journal_entry_sequences enable row level security;
revoke all on public.journal_entry_sequences from anon, authenticated;
```

Then `create or replace function public.post_journal_entry(...)` **in full**, copied verbatim from `20260904000500` with only the allocation changed:

```sql
  insert into public.journal_entry_sequences (shop_id, year, next_number)
    values (p_shop_id, v_year, 2)
    on conflict (shop_id, year) do update set next_number = public.journal_entry_sequences.next_number + 1
    returning next_number - 1 into v_seq;
  v_ref := 'JE-' || v_year || '-' || lpad(v_seq::text, 4, '0');
```

One statement, so the upsert's row lock serialises concurrent posters. A real `SEQUENCE` would also be race-free but is shared across shops — it would leak one tenant's trading volume into another's numbering and leave gaps on rollback; a table rolls its number back with the transaction and stays gapless. It also removes a per-call sequential scan that grew with every entry the shop had ever posted.

`verify-posting-sales.sql` gets check 7 for this. **A genuine two-session race cannot be exercised from a `do` block** — one block is one session — so the check asserts the *mechanism*: post twice in a row, assert the two references differ and that `journal_entry_sequences.next_number` advanced by exactly 2, then assert `pg_get_functiondef` for `post_journal_entry` no longer contains `count(*) + 1`.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/20260908000200_post_complete_sale.sql`. Reproduce `complete_sale` **in full** from `20260831000100_complete_sale_allows_credit.sql`, then add four declarations and one block.

> **The trap this task actually contains.** `20260831000100` is the newest `create or replace` definition, but it is **not** the newest state of the function. `20260905000000_complete_sale_lock_order.sql` patches `complete_sale` (and `edit_sale`) by **text substitution against the live `pg_proc` source**, so its fix appears in no migration's `create or replace` text — invisible to a grep for the newest definition, and invisible to `accumulated-rpc-edits.test.ts`, which reads migration text. Copying this function forward from `20260831000100` therefore **silently reverts a live deadlock fix on the hottest path in the app.** `verify-sale-lock-order` catches it; nothing else does. The item loop must read:
>
> ```sql
>   for v_item in
>     select value from jsonb_array_elements(p_items) with ordinality as t(value, ord)
>       order by (value->>'product_id'), ord
>   loop
> ```
>
> Before copying any RPC forward in this repo, check for text-substitution migrations too, not just `create or replace` blocks: `grep -rln "prosrc" supabase/migrations/`.

Add to `declare`:

```sql
  v_cogs_cents integer := 0;
  -- What is still owed. NOT v_balance -- that one holds the customer's loyalty
  -- POINTS balance and is only ever assigned inside the redemption branch, so
  -- reading it as money would post a receivable denominated in points on a
  -- redeeming sale, and none at all on a plain credit sale.
  v_owed_cents integer := 0;
  -- Line and promotion discounts. NOT derivable from v_gross_cents, which the
  -- item loop has already netted them out of.
  v_item_discount_cents integer := 0;
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
  -- nothing; an unpriced product is a question nobody answered. (sum() ignores
  -- nulls anyway; the filter states the intent for the next reader. What makes
  -- the uncosted case correct is the `if v_cogs_cents > 0` guard below.)
  select coalesce(sum(si.unit_cost_cents::bigint * si.quantity), 0)
    into v_cogs_cents
    from public.sale_items si
   where si.sale_id = v_sale_id and si.unit_cost_cents is not null;

  -- One debit line per payment, against the account that method maps to. A
  -- single lumped line would make the drawer and the wallet impossible to
  -- reconcile separately, which is most of what a cash position is for.
  select coalesce(jsonb_agg(jsonb_build_object(
           'code',         public.account_code_for_payment_method(sp.method),
           'amount_cents', sp.amount_cents,
           'memo',         'Payment by ' || sp.method)), '[]'::jsonb)
    into v_lines
    from public.sale_payments sp
   where sp.sale_id = v_sale_id and sp.amount_cents <> 0;

  -- What the customer still owes, which the guards above have already accepted
  -- as an under-payment made on purpose against a named customer. Both operands
  -- are final here: the payments loop has closed and the tax has been folded
  -- into v_total_cents.
  --
  -- NOT v_balance. That variable exists in this function and holds the
  -- customer's loyalty POINTS balance, assigned only inside the redemption
  -- branch -- so it is NULL on a plain credit sale (no receivable posted, entry
  -- unbalanced, every credit sale fails) and a points count on a redeeming one
  -- (a receivable denominated in points, entry unbalanced, every redeeming sale
  -- fails). Guarded on > 0 because journal_lines refuses a zero amount.
  v_owed_cents := v_total_cents - v_payments_total;
  if v_owed_cents > 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'code', '1100', 'amount_cents', v_owed_cents, 'memo', 'Left on account'));
  end if;

  -- Line and promotion discounts, read back off the rows this sale just wrote.
  -- v_gross_cents is already NET of them (the item loop folds each line's
  -- discount into v_line before accumulating it), so the figure is
  -- unrecoverable from the variables and 4200 was reading zero without this.
  select coalesce(sum(si.discount_cents), 0)
    into v_item_discount_cents
    from public.sale_items si
   where si.sale_id = v_sale_id;

  -- ALL THREE discounts are shown GROSS: revenue at LIST, every reduction as
  -- its own debit to 4200. Netting any of them into 4000 hides what the shop
  -- gave away, which is the one number a discount report exists to show.
  if (v_discount_cents + v_redeem_cents + v_item_discount_cents) > 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'code', '4200', 'amount_cents', v_discount_cents + v_redeem_cents + v_item_discount_cents,
      'memo', 'Discounts and points'));
  end if;

  if (v_gross_cents + v_item_discount_cents) > 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'code', '4000', 'amount_cents', -(v_gross_cents + v_item_discount_cents), 'memo', 'Sale at list'));
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

  -- The description carries the sale id, so the link reads in both directions.
  -- sales.journal_entry_id gets you from the sale to the entry; a bare 'Sale'
  -- got you nowhere back, and a journals list of four hundred rows all reading
  -- 'Sale' is not a journal anybody can audit. Task 8's reconciliation wants
  -- the same link.
  v_entry_id := public.post_journal_entry(
    p_shop_id,
    coalesce(p_created_at, now())::date,
    'Sale ' || v_sale_id::text,
    v_lines,
    v_location_id,
    'sale');

  update public.sales set journal_entry_id = v_entry_id where id = v_sale_id;
  -- ── end posting side ────────────────────────────────────────────────────
```

- [ ] **Step 4: Add the copy-forward guard**

Modify `supabase/tests/accumulated-rpc-edits.test.ts`, adding to `COMPLETE_SALE_EDITS`:

```ts
  // Introduced in 20260905000000, but only guardable now: that migration
  // rewrites complete_sale by text substitution against the live pg_proc
  // source, so until 20260908000200 the newest `create or replace` text --
  // all this test can read -- did not contain the fix. That is the blind
  // spot, and 20260908000200 duly reverted the fix on its first run.
  ['20260905000000', 'locks are taken in product order, not cart order', 'with ordinality'],
  // The call, not a string literal that happens to end in `'sale')` -- a stray
  // comment could satisfy that one, which is not a guard.
  ['20260908000200', 'the sale posts a journal entry', 'post_journal_entry('],
  // The PROPERTY, not the variable name: `v_cogs_cents` survives a rewrite that
  // sums products.cost_cents into it, which is the exact mistake the frozen
  // cost exists to prevent.
  ['20260908000200', 'COGS comes from the frozen line cost', 'si.unit_cost_cents'],
  ['20260908000200', 'every discount reaches 4200', 'v_item_discount_cents'],
  // Specific to the variable, not merely to account 1100 -- this plan
  // originally said `v_balance`, which is the loyalty POINTS balance.
  ['20260908000200', 'the receivable is money owed, not the points balance', 'v_owed_cents'],
```

Note that the migration's own header comment must avoid the literal string `create or replace function public.` — this test slices from the **first** occurrence of that signature to the first `$$;`, so a comment quoting it shifts the slice and trips the "is the only definition in its own migration" guard.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm run test:db && npx jest supabase/tests/accumulated-rpc-edits.test.ts`
Expected: `verify-posting-sales  pass`, **20 database checks passed**; the jest suite passes with two more assertions than before.

- [ ] **Step 6: Prove the test can fail**

**Eight mutations. Two of them exist because the first four proved less than they claimed** — an *unbalanced* mutation is caught by `post_journal_entry`'s balance guard before any assertion about a particular account is reached, so it reddens the run without ever exercising the check it was aimed at. A mutation aimed at one line must keep the entry balanced.

Mutation 1: post `-v_total_cents` to `4000` instead of the revenue line. Expected: check 1 fails — though **not** with `-7350 = tax booked as revenue` as first drafted. Booking the tax as revenue also unbalances the entry, so `post_journal_entry`'s own balance guard fires first and the actual message is `This entry does not balance: debits and credits differ by -350.` The check reddens, but the revenue-vs-tax split is **not** proven by this one — mutation 5 is what proves it. Revert.

Mutation 2: build one lumped cash line instead of one per payment. Expected: check 2 fails with `expected Dr 1000 Cash 1300 of the split, got 2100`. Revert.

Mutation 3: drop the `if v_cogs_cents > 0` guard, so the COGS pair is always appended. Expected: **check 4 fails** — the uncosted sale posts a zero COGS pair and `journal_lines`' `check (amount_cents <> 0)` refuses it, taking the whole sale down. This is why check 4 exists. Revert.

> Do **not** use "drop the `and si.unit_cost_cents is not null` filter" as this mutation. It was tried and it is a **no-op**: SQL `sum()` already ignores nulls, so `v_cogs_cents` is byte-identical with and without the filter and the suite stays fully green. A mutation that cannot redden its check proves nothing about the check.

Mutation 4: pass `'manual'` as `p_source`. Expected: the run reddens at **check 1's `source` assertion** (`expected source=sale, got manual`), which fires before check 5 is reached because the fixture owner *does* hold `ledger.post`. To see check 5 itself fire, neutralise that one assertion and re-run: the cashier is then refused with `You do not have permission to post journal entries.` — the exact failure this whole phase exists to prevent. Revert.

Mutation 5 — **balanced**, and the one that actually proves the revenue-vs-tax split: post `-v_total_cents` to `4000` **and** drop the `2100` line. Debits and credits still tie, so the balance guard stays quiet and the assertion on account `4000` is finally reached. Expected: `FAIL: expected Cr 4000 Revenue -7000, got -7350 (-7350 = tax booked as revenue)`. Revert.

Mutation 6 — **balanced**, for check 3's `1100` amount, which no earlier mutation exercised: post the receivable to `1000` Cash instead of `1100` Accounts Receivable. Same amount, same total, wrong account — which is the realistic bug (money still owed counted as money in the drawer). Expected: `FAIL: expected Dr 1100 Receivable 2700, got 0`. Revert.

Mutation 7, for the new check 6: credit `4000` with a bare `v_gross_cents` and drop `v_item_discount_cents` from the `4200` line — i.e. put the discount bug back. Expected: `FAIL: expected Cr 4000 Revenue -2000 at LIST, got -1500 (-1500 = the discount netted into revenue)`. Revert.

Mutation 8, for the new check 7: put `count(*) + 1` back into `post_journal_entry` in `20260908000150`. Expected: `FAIL: no journal_entry_sequences row for this shop and year -- references are not coming from the counter`. Revert.

- [ ] **Step 7: Commit**

```bash
git add supabase/migrations/20260908000150_journal_entry_sequence.sql supabase/migrations/20260908000200_post_complete_sale.sql supabase/tests/verify-posting-sales.sql supabase/tests/accumulated-rpc-edits.test.ts
git commit -m "feat(accounting): a completed sale posts to the ledger"
```

---

### Task 3b: the entry date is the shop's, and a closed month does not refuse a sale

Two defects in what Task 3 shipped, both about **which date the entry carries**, and both fixed in **one** migration. `complete_sale` has now been copied forward nineteen times and this repo has already lost an edit that way — the loyalty maturation guard, unenforced for four migrations. Two migrations here would be two more ~400-line reproductions and two more chances to drop something.

**Files:**
- Create: `supabase/migrations/20260908000300_sale_entry_date.sql`
- Modify: `supabase/tests/verify-posting-sales.sql`
- Modify: `supabase/tests/accumulated-rpc-edits.test.ts`

**Interfaces:**
- Consumes: `accounting_periods.status` (`20260904000200`), `open_period_for` (same).
- Produces: no signature change. `complete_sale`'s contract is identical; only `journal_entries.entry_date` and the entry description move.

> **Renumbering note.** Task 5 originally claimed `20260908000300` for `post_refund_and_settlement.sql`. This task takes `20260908000300`, so **Task 5's migration is now `20260908000350_post_refund_and_settlement.sql`** — renamed throughout, including its Files list and its `git add`.

#### Change 1 — the entry date is the shop's local date, not the server's

`entry_date` was `coalesce(p_created_at, now())::date`. A bare `::date` resolves in the **database session's** timezone, which is **UTC** on Supabase. Somalia is UTC+3, so a sale rung up at 01:30 local on the 1st is 22:30 UTC on the last day of the *previous* month, and posted into the wrong period. `src/lib/period.ts` buckets the sales report in **device-local** time, so the ledger and the sales report disagreed for every late-night sale at a month boundary — **permanently**, because once that earlier period closes a posted entry cannot be re-dated.

```sql
  v_entry_date := (coalesce(p_created_at, now()) at time zone 'Africa/Mogadishu')::date;
```

**`'Africa/Mogadishu'` is a platform constant on purpose.** Every market kaiibi serves is UTC+3 — Somalia, Somaliland, Ethiopia, Djibouti, Kenya — so one constant is correct today for every shop on the system. There is deliberately **no `shops.timezone` column**: adding one means a migration, a settings screen, a default for every existing shop, and a second source of truth for `src/lib/period.ts` to learn about. That is a bigger change than this problem justifies right now. It was **considered and declined, not missed** — say so in the migration, so the next reader does not "fix" it as an oversight. When kaiibi sells into a market that is not UTC+3, this expression is the only place in `complete_sale` that has to change.

#### Change 2 — a sale dated into a closed period posts to the current one

`open_period_for` raises `This period is % — posting into it is refused` for any non-open period. `src/lib/sales-import.ts:126` passes `p_created_at` for **every** CSV-imported historical sale, so once a shop had closed any month, importing sales into it failed the whole row group with a ledger error on an import screen.

**Redating is the correct accounting treatment, not a workaround.** A transaction that arrives after its month has closed posts to the open period; that is what closing *means*. The sale row keeps its true date in `sales.created_at`; only the recognition moves.

**Check the status, do not catch the exception.** An exception handler around `post_journal_entry` would also swallow an unbalanced entry, an unknown account code, or a missing chart of accounts, and retry them into the current period as if the only thing wrong were the date.

```sql
  select status into v_period_status
    from public.accounting_periods
   where shop_id = p_shop_id and v_entry_date between starts_on and ends_on;

  -- No row means open_period_for will create it open, so only an EXISTING
  -- non-open period redirects. Getting this backwards -- treating a missing row
  -- as shut -- redates every sale in a month nobody has traded in yet, which is
  -- most backdated CSV imports.
  if v_period_status is not null and v_period_status <> 'open' then
    v_posted_date := (now() at time zone 'Africa/Mogadishu')::date;
  else
    v_posted_date := v_entry_date;
  end if;
```

`v_posted_date` is what goes to `post_journal_entry`, and **when the two differ the description must say so** — carrying the sale's true date and the period's status, so a reader of the journal can see why an August sale is sitting in October without going back to the source row:

```sql
    'Sale ' || v_sale_id::text
      || case when v_posted_date <> v_entry_date
              then ' (sold ' || to_char(v_entry_date, 'YYYY-MM-DD')
                   || '; that period is ' || coalesce(v_period_status, 'not open')
                   || ', so it is recognised here)'
              else '' end,
```

> The `coalesce` is not decoration. `||` with a NULL operand yields NULL for the **whole** expression, so if the branch above is ever edited into producing `v_posted_date <> v_entry_date` with a NULL status, the description becomes NULL and `post_journal_entry` refuses the sale with `A journal entry needs a description.` — an error about descriptions, for a bug about dates, on the hot path. This was found by mutation, not by reading.

**If the CURRENT period is itself closed or locked, `post_journal_entry` still raises and the sale still fails. Do not add a fallback.** A shop with no open period at all is a genuinely broken state and should say so loudly; every alternative is a lie about where the money went.

Three new declarations, and nothing else in the function changes:

```sql
  v_entry_date date;
  v_period_status text;
  v_posted_date date;
```

- [ ] **Step 1: Write the failing checks**

Append checks 9, 10 and 11 to `supabase/tests/verify-posting-sales.sql`. All three months are computed **relative to `now()`** rather than written as literals, so the script keeps meaning the same thing next year and cannot accidentally pick the month it is being run in:

```sql
  v_today_local  := (now() at time zone 'Africa/Mogadishu')::date;
  v_month_closed := (date_trunc('month', (now() at time zone 'Africa/Mogadishu')) - interval '2 months')::date;
  v_month_open   := (date_trunc('month', (now() at time zone 'Africa/Mogadishu')) - interval '1 month')::date;
  v_month_tz     := (date_trunc('month', (now() at time zone 'Africa/Mogadishu')) - interval '4 months')::date;
```

Check **9** sells into `v_month_closed` while it is still open — which both creates the period row and establishes that a backdated sale posts to its own month — then closes it with `update public.accounting_periods set status = 'closed' where shop_id = ... and starts_on = v_month_closed` (assert `found`, or the first sale never opened a row), then sells into it again and asserts three things: the sale **succeeds**, `entry_date = v_today_local` and **not** the closed month, and the description contains `to_char(v_date, 'YYYY-MM-DD')`. Plus: `sales.created_at` still holds the true date — only the recognition moves.

Check **10** sells into `v_month_open`, which is untouched, and asserts `entry_date` is that backdated date. **Checks 9 and 10 are a pair and neither is worth anything alone**: an implementation that redated *everything* to today would pass 9 while destroying the one thing `p_created_at` exists for.

Check **11** completes a sale with `p_created_at := (v_date + time '22:30') at time zone 'UTC'` where `v_date` is the **last day** of `v_month_tz`, and asserts `entry_date = (v_month_tz + interval '1 month')::date` — the 1st of the next month, which is what UTC+3 makes 22:30 UTC locally. 22:30 on a month's last day is the deliberate choice: it is the only shape where the UTC answer and the local answer fall in **different months**, so a wrong implementation cannot coincidentally pass. Guard it with a self-check that the two dates really are in different months, or the assertion is satisfiable by both answers.

`v_month_tz` is four months back so that its *next* month (three back) is neither the closed month (two back) nor the open control (one back).

- [ ] **Step 2: Run them and verify they fail**

Run: `psql "$SUPABASE_DB_URL" -f supabase/tests/verify-posting-sales.sql` against a database reset **without** the new migration.
Expected: `ERROR: This period is closed — posting into it is refused. Re-open it first.` — check 9, raised by `open_period_for` from inside `complete_sale`. Check 11 is not reached; it is proven by mutation in Step 5.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/20260908000300_sale_entry_date.sql`, copying `complete_sale` **verbatim** from `20260908000200_post_complete_sale.sql` and changing only the two things above.

`20260908000200` is both the newest `create or replace` definition **and** the newest live state — it baked the `ORDER BY (value->>'product_id'), ord` from `20260905000000` in, so for the first time copying from the newest written definition is safe. Keep that `ORDER BY`; it is still guarded by its `COMPLETE_SALE_EDITS` entry, and `verify-sale-lock-order.sql` is still the only thing that catches its loss.

Prove the copy: `diff 20260908000200_post_complete_sale.sql 20260908000300_sale_entry_date.sql | grep '^<'` must show **only** the header comment and the two lines of the `post_journal_entry` call.

- [ ] **Step 4: Add the copy-forward guards**

Modify `supabase/tests/accumulated-rpc-edits.test.ts`, adding to `COMPLETE_SALE_EDITS`:

```ts
  ['20260908000300', 'the entry date is the shop-local date, not the server timezone', "at time zone 'Africa/Mogadishu'"],
  ['20260908000300', 'a sale whose period has closed is redated, not refused', 'v_period_status'],
```

The first token is the **timezone**, not a variable called `v_entry_date` — a rewrite that keeps the variable and drops the cast is exactly the regression.

- [ ] **Step 5: Prove the checks can fail**

Three new mutations, plus a re-run of Task 3's eight.

Mutation A, for check 9: change `if v_period_status is not null and v_period_status <> 'open'` to `if false` — never redate. Expected: `ERROR: This period is closed — posting into it is refused. Re-open it first.` Revert.

Mutation B, for check 10: change the same condition to `if true` — redate everything. Expected: `FAIL: a backdated sale into an OPEN month posted on <today>, expected its own date <date>`. It fires at check 9's own open-month baseline, which is the same assertion made a few lines earlier; neutralise that one to watch check 10 fail on its own. **This is the mutation that found the NULL-description trap** described above.

Mutation C, for check 11: put `v_entry_date := coalesce(p_created_at, now())::date;` back. Expected: `FAIL: a sale at 22:30 UTC on <last day> posted on <last day>, expected <1st of next month> (... = the entry date resolved in UTC, not shop-local)`. Revert.

**Then re-run all eight of Task 3's Step 6 mutations against the new copy.** A copy-forward that quietly broke one of them is exactly the failure this repo keeps having, and a mutation that stops reddening is a finding, not a formality.

- [ ] **Step 6: Verify**

```
npm run test:db                                            # 20 scripts
npx tsc --noEmit                                           # clean
npm test                                                   # green
npm run lint                                               # 81 problems
psql "$SUPABASE_DB_URL" -f supabase/tests/verify-sale-lock-order.sql   # ALL CHECKS PASSED
```

`test:db` counts **scripts**, not assertions — this task adds three checks inside an existing `verify-*.sql` and no new file, so the count stays at 20.

- [ ] **Step 7: Commit**

```bash
git add supabase/migrations/20260908000300_sale_entry_date.sql supabase/tests/verify-posting-sales.sql supabase/tests/accumulated-rpc-edits.test.ts
git commit -m "fix(accounting): date entries in shop-local time, and redate a sale whose period has closed"
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
- Create: `supabase/migrations/20260908000350_post_refund_and_settlement.sql`
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

Create `supabase/migrations/20260908000350_post_refund_and_settlement.sql`, reproducing both functions from `20260831000200_refund_goods_not_cash.sql` in full.

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
      'code', public.account_code_for_payment_method(v_sale_method),
      'amount_cents', -v_refund_amount, 'memo', 'Refunded'));
  end if;

  if v_cogs_back > 0 then
    v_lines := v_lines || jsonb_build_array(
      jsonb_build_object('code', '1200', 'amount_cents',  v_cogs_back, 'memo', 'Stock returned'),
      jsonb_build_object('code', '5000', 'amount_cents', -v_cogs_back, 'memo', 'Cost reversed'));
  end if;

  v_entry_id := public.post_journal_entry(
    v_shop_id, public.shop_local_date(), 'Refund', v_lines, v_location_id, 'refund');
  update public.refunds set journal_entry_id = v_entry_id where id = v_refund_id;
```

In `settle_sale_balance`, after each settlement payment row is inserted:

```sql
  -- One entry per instalment, dated when the money arrived. Lumping several
  -- settlements into one entry would date the whole thing on the last payment.
  v_entry_id := public.post_journal_entry(
    v_shop_id, public.shop_local_date(), 'Balance settled',
    jsonb_build_array(
      jsonb_build_object('code', public.account_code_for_payment_method(v_method),
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
git add supabase/migrations/20260908000350_post_refund_and_settlement.sql supabase/tests/verify-posting-sales.sql
git commit -m "feat(accounting): refunds and settlements post to the ledger"
```

---

### Task 5b: an edited sale re-posts

**`edit_sale` changes items, totals, tax and payments and never touches the posted entry.** The entry is immutable — `refuse_posted_entry_edit()` sees to that — so from the moment Task 3 ships, **every sale edit silently desynchronises the ledger from `sales`.** A cashier who fixes a mis-scanned quantity leaves revenue, COGS, tax and the receivable all reading the pre-edit figures, and nothing anywhere says so. This is a defect Task 3 *creates*; it is not optional cleanup.

The design already mandates the treatment: *"Corrections are reversing entries, never edits."* And the tool already exists from phase 1 — `reverse_journal_entry(p_entry_id uuid, p_reason text) returns uuid`, `20260904000500_journal_rpcs.sql:123`. So `edit_sale` must:

1. reverse the entry at `sales.journal_entry_id`,
2. post a fresh entry from the **edited** figures, using the same line-building logic as `complete_sale`, and
3. update `sales.journal_entry_id` to the new one.

Three entries end up on the record — the original, its reversal, and the correction — which is the point. A book is added to, not amended.

**Files:**
- Create: `supabase/migrations/20260908000650_post_sale_edit.sql`
- Modify: `supabase/tests/verify-posting-sales.sql`
- Modify: `supabase/tests/accumulated-rpc-edits.test.ts`

**Interfaces:**
- Consumes: `reverse_journal_entry(uuid, text)`, `post_journal_entry(uuid, date, text, jsonb, uuid, text)`, `account_code_for_payment_method(text)`, `sales.journal_entry_id`.
- Produces: no signature change to `edit_sale`. `journal_entries` gains a reversal (`source = 'manual'`, `reverses_entry_id` set) and a replacement with `source = 'sale'`.

#### ⚠ The copy-forward trap, which is the same one Task 3 hit

`edit_sale`'s newest `create or replace` ancestor is **`20260831000200_refund_goods_not_cash.sql`**. Copying it forward from there **silently reverts the lock-order fix from `20260905000000_complete_sale_lock_order.sql`**, which applies itself by string-substituting `pg_proc.prosrc` and therefore **exists in no migration text at all**:

```sql
execute format(
  'create or replace function public.%I(%s) returns %s language plpgsql ... as %L',
  v_fn.proname, v_fn.args, v_fn.result, replace(v_src, v_needle, v_fixed));
```

`accumulated-rpc-edits.test.ts` reads migration *text* and so is blind to it by construction. `20260908000200` reverted `complete_sale`'s half of exactly this fix on its first run, and only `verify-sale-lock-order.sql` caught it.

**So Task 5b must bake the ordered loop into its copy.** In `edit_sale`, line 164 of the `20260831000200` body reads `for v_item in select * from jsonb_array_elements(p_items) loop`. It must become:

```sql
  -- CARRIED FORWARD FROM 20260905000000_complete_sale_lock_order.sql, which
  -- patches this function by TEXT SUBSTITUTION against the live pg_proc source
  -- rather than re-creating it -- so it appears in no CREATE OR REPLACE block
  -- anywhere in this directory, and copying edit_sale forward from
  -- 20260831000200 without it silently reverts a live deadlock fix. An edit
  -- and a sale lock the same product_location_stock rows; unordered, they
  -- deadlock against each other.
  for v_item in
    select value from jsonb_array_elements(p_items) with ordinality as t(value, ord)
      order by (value->>'product_id'), ord
  loop
```

and `EDIT_SALE_EDITS` gains the entry that guards it — possible for the first time, because until this migration the ORDER BY did not live in any definition this test can read:

```ts
  ['20260905000000', 'locks are taken in product order, not cart order', 'with ordinality'],
```

Before starting, run `grep -rln "prosrc" supabase/migrations/` and read every hit. That is now part of the copy-forward ritual for this repo.

#### Two things `reverse_journal_entry` will refuse, and what to do about each

Neither is hypothetical; both fire on ordinary edits.

**1. It requires `ledger.post`. `edit_sale` gates on `sales.edit`.** A cashier who may edit a sale does not hold `ledger.post` and never should — that is the whole finding behind Task 3's check 5. `reverse_journal_entry` raises `You do not have permission to reverse journal entries.` and the edit fails. **Do not grant cashiers `ledger.post`.** Do the reversal inline in `edit_sale`'s own security-definer body, mirroring `reverse_journal_entry`'s three writes (the negated lines, the `R`-suffixed reference, the `status = 'reversed'` update) — the same reasoning that has `complete_sale` pass `p_source => 'sale'` rather than gate the till on a ledger permission. If instead `reverse_journal_entry` is given a source parameter, that is a change to a phase-1 function and needs its own note in Global Constraints.

**2. It dates the reversal to the ORIGINAL entry's date**, deliberately — a correction to August belongs in August. But if August is closed, `open_period_for` refuses it and the edit fails. That is Task 3b's problem again, in a place Task 3b did not reach. Resolve it the same way: check the period's status first and, when the original's month is shut, date **both** the reversal and the replacement into the current period, with the true date and the status in both descriptions. Do not catch `open_period_for`'s exception.

**3. `edit_sale` reads `sales.journal_entry_id` twice — once to fetch the sale, once lower down to find the entry to reverse — with nothing serialising the two reads.** The initial `select ... from public.sales where id = p_sale_id` must carry `for update`, held for the whole transaction, the same shape `settle_sale_balance` already uses (`20260908000360`) as its very first statement. Without it, two concurrent edits on the same sale — an ordinary POS double-tap, or a client retry after a dropped response — can both read the same old entry, both post a valid reversal and replacement, and race on the final `journal_entry_id` update: the loser's replacement is orphaned and the trial balance is reversed-and-replaced twice for a sale that names only one replacement.

- [ ] **Step 1: Write the failing checks**

Append to `supabase/tests/verify-posting-sales.sql`. Reuse check 1's sale, whose entry is already held in `v_entry_1`: 7000 gross, 350 tax, 7350 total, 2500 COGS.

```sql
  -- 12. An edited sale reverses its entry and posts a new one. Three entries
  --     survive: the original, its reversal, and the correction. `edit_sale`
  --     changes items, totals, tax and payments, and the posted entry is
  --     immutable -- so without this every edit leaves the ledger reading the
  --     pre-edit figures with nothing anywhere saying so.
  --
  --     The edit drops the coffee: 2 @ 2000 = 4000 gross, tax 200, total 4200,
  --     COGS 2*700 = 1400. Every figure differs from the original's, so an
  --     implementation that re-posted the OLD figures fails rather than
  --     coincidentally passing.
  perform public.edit_sale(
    v_sale_id_cash,
    jsonb_build_array(jsonb_build_object('product_id', v_prod_a, 'quantity', 2, 'unit_price_cents', 2000)),
    jsonb_build_array(jsonb_build_object('method', 'cash', 'amount_cents', 4200)));

  -- The sale points at a DIFFERENT entry now.
  select journal_entry_id into v_entry from public.sales where id = v_sale_id_cash;
  if v_entry is null then
    raise exception 'FAIL: the edited sale has no journal entry';
  end if;
  if v_entry = v_entry_1 then
    raise exception 'FAIL: the edit left sales.journal_entry_id on the original entry -- the ledger now disagrees with the sale';
  end if;

  -- The original is reversed, not deleted, and the reversal is linked.
  select status into v_text from public.journal_entries where id = v_entry_1;
  if v_text <> 'reversed' then
    raise exception 'FAIL: the original entry is %, expected reversed', v_text;
  end if;
  if not exists (select 1 from public.journal_entries where reverses_entry_id = v_entry_1) then
    raise exception 'FAIL: no reversing entry points back at the original';
  end if;

  -- The three entries NET to the corrected figures. Asserted as a sum across
  -- all three rather than on the new entry alone: that is the property the
  -- trial balance actually reads, and it is the one a reversal that negates the
  -- wrong lines would break.
  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l
    join public.journal_entries e on e.id = l.entry_id
    join public.accounts a on a.id = l.account_id
   where a.code = '4000'
     and e.id in (v_entry_1, v_entry,
                  (select id from public.journal_entries where reverses_entry_id = v_entry_1));
  if v_amount <> -4000 then
    raise exception 'FAIL: 4000 Revenue nets to % across the three entries, expected -4000 (-7000 = the edit never re-posted)', v_amount;
  end if;

  -- And the new entry balances on its own.
  select coalesce(sum(amount_cents), 0) into v_amount
    from public.journal_lines where entry_id = v_entry;
  if v_amount <> 0 then
    raise exception 'FAIL: the re-posted entry does not balance, off by %', v_amount;
  end if;

  -- 13. A cashier holding sales.edit and NOT ledger.post can still edit a sale.
  --     reverse_journal_entry requires ledger.post; edit_sale requires
  --     sales.edit. If the reversal is done through that door, every edit in
  --     every shop stops until someone grants cashiers a ledger permission
  --     they must not have -- the same failure check 5 exists to prevent.
  perform set_config('request.jwt.claims', json_build_object('sub', v_staff_id)::text, true);
  if public.has_shop_permission(v_shop_id, 'ledger.post') then
    raise exception 'FAIL: the fixture cashier holds ledger.post, so check 13 would prove nothing';
  end if;
  perform public.edit_sale(
    v_sale_id_cash,
    jsonb_build_array(jsonb_build_object('product_id', v_prod_a, 'quantity', 1, 'unit_price_cents', 2000)),
    jsonb_build_array(jsonb_build_object('method', 'cash', 'amount_cents', 2100)));
  perform set_config('request.jwt.claims', json_build_object('sub', v_user_id)::text, true);
```

> Check 13's fixture cashier needs `sales.edit` as well as `pos.access`. Widen the `Till Only` role's `permissions` array where it is created, and keep the `ledger.post` self-assertion — without it the check passes while proving nothing.

- [ ] **Step 2: Run them and verify they fail**

Run: `npm run test:db -- --no-reset`
Expected: `verify-posting-sales  FAIL` on check 12, `the edit left sales.journal_entry_id on the original entry`.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/20260908000650_post_sale_edit.sql`, reproducing `edit_sale` **in full** from `20260831000200_refund_goods_not_cash.sql` with the ordered loop above and one posting block, after `update public.sales set ...` (line 352 of that body) and before the function returns:

```sql
  -- ── The posting side ────────────────────────────────────────────────────
  --
  -- A correction is a reversal plus a fresh entry, never an edit of the
  -- original: journal_entries carries refuse_posted_entry_edit(), and a book is
  -- added to rather than amended. Three rows survive an edit -- what was
  -- posted, its undoing, and what is true now.
  select journal_entry_id into v_old_entry_id from public.sales where id = p_sale_id;

  -- A sale posted before Task 3 shipped has no entry. Reversing nothing is not
  -- an error; it just means this edit posts the first entry the sale has ever
  -- had. Task 8's backfill fills the rest in.
  if v_old_entry_id is not null then
    ... reverse inline, per "Two things reverse_journal_entry will refuse" ...
  end if;

  ... rebuild v_lines exactly as complete_sale does, from the EDITED figures ...

  v_entry_id := public.post_journal_entry(
    v_shop_id, v_posted_date, 'Sale ' || p_sale_id::text || ' (edited)',
    v_lines, v_location_id, 'sale');

  update public.sales set journal_entry_id = v_entry_id where id = p_sale_id;
```

> New declarations: `v_old_entry_id`, `v_entry_id`, `v_lines`, `v_cogs_cents`, `v_owed_cents`, `v_item_discount_cents`, plus Task 3b's `v_entry_date`, `v_period_status`, `v_posted_date` — same names, same redirect-when-closed logic, but computed by calling `public.shop_local_date()`, not by pasting Task 3b's inline `at time zone 'Africa/Mogadishu'` expression again. `edit_sale` is new posting code as of this migration; it has none of `complete_sale`'s copy-forward history excusing the duplication.
>
> **The line-building logic is duplicated from `complete_sale`, and that is a real cost.** Two copies of the discount arithmetic — the `v_gross_cents + v_item_discount_cents` asymmetry that Task 3's review caught once already — is two places to get it wrong. Consider extracting `sale_journal_lines(p_sale_id uuid) returns jsonb`, which reads `sale_items` and `sale_payments` back off the rows both functions have just written, and calling it from both. Both functions already read those tables for COGS and for the payment lines, so the extraction is smaller than it looks and it makes Task 8's backfill a third caller rather than a third copy.

- [ ] **Step 4: Add the copy-forward guards**

Modify `supabase/tests/accumulated-rpc-edits.test.ts`, adding to `EDIT_SALE_EDITS`:

```ts
  // Guardable for the first time: 20260905000000 patched edit_sale by text
  // substitution against the live pg_proc source, so until this migration the
  // ORDER BY lived in no `create or replace` text and this entry would have
  // failed against a database that HAD the fix.
  ['20260905000000', 'locks are taken in product order, not cart order', 'with ordinality'],
  ['20260908000650', 'an edit reverses the old entry rather than editing it', 'reverses_entry_id'],
  ['20260908000650', 'an edit re-posts from the edited figures', 'post_journal_entry('],
```

Keep the migration's header comment free of the lowercase literal `create or replace function public.` — the test slices from the first occurrence of that string and a comment quoting it trips the "is the only definition in its own migration" guard.

- [ ] **Step 5: Prove the checks can fail**

Mutation A: skip the reversal — post the new entry and leave the old one `posted`. Expected: check 12 fails with `the original entry is posted, expected reversed`, and the `4000` net reads `-11000`. Revert.

Mutation B: post the new entry but do not update `sales.journal_entry_id`. Expected: `the edit left sales.journal_entry_id on the original entry`. Revert.

Mutation C: re-post from the sale's **pre-edit** totals (read `sales` before the update rather than after). Expected: `4000 Revenue nets to -7000 ... (-7000 = the edit never re-posted)`. Revert.

Mutation D: call `public.reverse_journal_entry(...)` instead of reversing inline. Expected: check 13 fails with `You do not have permission to reverse journal entries.` — the permission trap, proven rather than asserted.

Mutation E: drop the `ORDER BY (value->>'product_id'), ord` from the item loop. Expected: `verify-sale-lock-order` reddens. **`npm run test:db` must be the command here, not the single script** — this is the mutation that catches the copy-forward trap, and it is invisible to jest. Revert.

- [ ] **Step 6: Verify**

```
npm run test:db                                                        # 20 scripts
npx jest supabase/tests/accumulated-rpc-edits.test.ts                  # green
psql "$SUPABASE_DB_URL" -f supabase/tests/verify-sale-lock-order.sql   # ALL CHECKS PASSED
npx tsc --noEmit && npm test && npm run lint                           # clean / green / 81
```

- [ ] **Step 7: Commit**

```bash
git add supabase/migrations/20260908000650_post_sale_edit.sql supabase/tests/verify-posting-sales.sql supabase/tests/accumulated-rpc-edits.test.ts
git commit -m "fix(accounting): an edited sale reverses its entry and re-posts"
```

---

### Task 5c: a deleted sale reverses everything it is responsible for

*(Added by the final whole-branch review, as finding C3 — the Critical a per-task review structurally could not see, because `delete_sale` appears in no task's diff.)*

**Files:** `supabase/migrations/20260908000900_post_sale_delete.sql` (new), `supabase/tests/verify-posting-sales.sql`, `supabase/tests/accumulated-rpc-edits.test.ts`.

**Interfaces:** `public.delete_sale(p_sale_id uuid) returns void` — unchanged signature, copied forward **in full** from `20260820000100_loyalty_balance_rules.sql`, its newest definition.

#### The hole

`delete_sale` restores the stock, reverses the loyalty points and deletes the sale. `sales.journal_entry_id` carries **no `ON DELETE`**, so from the moment Task 3 shipped the entry outlived the sale — still `status = 'posted'`, described by a uuid resolving to nothing. `sale_payments` and `refunds` both **cascade** (`0005_sale_payments.sql:3`, `20260802015200_refunds.sql:7`), so a credit sale that was refunded and later settled left **three** such entries.

It is reachable from the UI: `src/components/accounting/transactions-tab.tsx:224` → `src/lib/sales.ts:123`.

A manager deleting a mis-rung 6,300 sale leaves `4000` holding 6,000 of revenue, `5000` holding 2,200 of COGS, `1200` credited for stock that is back on the shelf and `2100` holding the tax. Every entry still balances, so the trial balance still zeroes and nothing goes red. **Task 8's backfill can never repair it**: the replay is driven by source rows and there is no source row left to replay.

#### The treatment

Task 5b's, minus the replacement. Reverse, inside the same transaction, **before** the delete — `refunds` and `sale_payments` cascade, so after the delete there is nothing left to read the entry ids from and the entries are unreachable for ever.

**Inline, not `reverse_journal_entry`.** That function requires `ledger.post`. This door gates on **`sales.edit`** — the real permission name; `src/lib/permissions.ts:80` labels it *"Edit/delete sales"* and there is no `sales.delete`. A manager removing a mis-rung sale must not need a ledger permission, which is the same finding that has every posting call pass `p_source <> 'manual'`.

**THE CASCADED ENTRIES ARE REVERSED TOO. This is the decision, and it is stated in a comment at the loop.** Reversing only the sale's own entry **moves** the orphan problem rather than fixing it, and leaves the books worse than doing nothing: the sale's revenue and receivable come back out while the refund's `4100` and the settlement's `Dr Cash / Cr 1100` stay standing, so the ledger shows a shop that returned goods it never sold and collected cash against a receivable that no longer exists — and `1100` ends up permanently **negative** by the settled amount. So all three kinds are reversed, in one loop, each mirror the mirror of its own original.

**Each reversal carries the source of the entry it reverses**, read off the original row rather than written as a literal — the three kinds are three different sources (`'sale'`, `'refund'`, `'settlement'`) and one literal would be wrong for two of them. See *A reversal carries the same source as the entry it reverses* in Global Constraints.

**The closed-period redirect**, with `coalesce(v_old_period_status, 'not open')`, exactly as `edit_sale` has it: read rather than caught, so a broken chart of accounts is not swallowed and retried into the current month.

**The sale row is read `for update`.** New here, and stated rather than smuggled: the function reads `sales.journal_entry_id` and then writes entries derived from it with nothing serialising the two, so two concurrent deletes could both write a reversal. Same shape as `edit_sale`'s and `settle_sale_balance`'s locks.

`delete_sale` is **not** one of the two functions `20260905000000_complete_sale_lock_order.sql` patches by string-replacing `pg_proc.prosrc` — that migration touches `complete_sale` and `edit_sale` only — so there is no invisible edit to carry forward. Confirm with:

```bash
grep -rln "create or replace function public.delete_sale(" supabase/migrations/ | sort | tail -1
```

#### Checks and mutations

`verify-posting-sales.sql` check 24 builds one sale carrying all three kinds of entry — part paid at the till, settled later, then partly refunded — deletes it, and asserts: the sale row is gone; all three originals are `reversed`, named individually so the message says which was forgotten; three mirrors exist, each under its own original's source; and **every account touched by any of the six entries nets to exactly zero**. That last one is the whole property in one statement and is independent of the figures.

Mutations: **(a)** skip the reversal loop entirely; **(b)** reverse only the sale's own entry, dropping the refund and settlement branches of the union; **(c)** write `'manual'` as the reversal's source instead of the original's.

Add a `DELETE_SALE_EDITS` list to `accumulated-rpc-edits.test.ts` — this function now carries posting code and is re-created in full by every migration touching it.

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
      p_shop_id, public.shop_local_date(), 'Stock received',
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
      p_shop_id, public.shop_local_date(), 'Stock count variance',
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
      p_shop_id, public.shop_local_date(), 'Stock count variance',
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
- Consumes: `invoice_payments.journal_entry_id`, `payroll_runs.journal_entry_id` (Task 2), `account_code_for_payment_method` (Task 1).

**`unpost_payroll_run` is in scope too, and was not in the first draft.** It is a button in the app (`src/lib/payroll.ts:141`) that returns a posted run to draft. The moment `post_payroll_run` writes a journal entry, unposting has to reverse it and clear `payroll_runs.journal_entry_id` — otherwise the next post overwrites the pointer, orphans the first entry, and `6200` reads double the wages actually paid **with the trial balance still zero**, because both entries individually balance.

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
   where l.entry_id = v_entry and a.code = '1020';
  if v_amount <> -4300 then
    raise exception 'FAIL: expected Cr 1020 Zaad -4300, got % (paid by zaad should not touch 1000 Cash)', v_amount;
  end if;

  if exists (select 1 from public.journal_lines l join public.accounts a on a.id = l.account_id
              where l.entry_id = v_entry and a.type = 'expense') then
    raise exception 'FAIL: paying a bill must not post an expense a second time';
  end if;

  -- 2. A pay run posts wages against cash.
  --    Three members at 15000, 22000 and 9000 = 46000. No two sum to it.
  --    PERFORM, not assignment: post_payroll_run returns the EXPENSE id.
  perform public.post_payroll_run(v_run_id);
  select journal_entry_id into v_entry from public.payroll_runs where id = v_run_id;
  if v_entry is null then raise exception 'FAIL: the pay run did not post'; end if;

  select coalesce(sum(l.amount_cents), 0) into v_amount
    from public.journal_lines l join public.accounts a on a.id = l.account_id
   where l.entry_id = v_entry and a.code = '6200';
  if v_amount <> 46000 then
    raise exception 'FAIL: expected Dr 6200 Salaries 46000, got % (37000/31000/24000 = a member dropped)', v_amount;
  end if;

  -- 3. Posting the SAME run twice posts one entry, not two. This exercises the
  --    PRE-EXISTING status guard only. It CANNOT see the failure mode named
  --    here (a second entry written before the status check raises): a plpgsql
  --    BEGIN ... EXCEPTION block is a subtransaction, so the raise rolls that
  --    entry back too. Proved dead by mutation M8 in task-7-report.md. The
  --    check that bites is unpost-then-repost -- see check 7 of the shipped
  --    verify-posting-bills.sql.
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

**`p_paid_on` is exempt from the `public.shop_local_date()` rule below.** It arrives as a `date`, not a `timestamptz` — there is no server timezone to resolve against, so wrapping it (`public.shop_local_date(p_paid_on)`) would be a no-op cast through a function that expects a moment in time, not a clarification. Do not "fix" this one.

```sql
  -- No expense line. The expense was recognised when the bill arrived; this
  -- moves money against the liability that recognition created. Posting 6xxx
  -- again here would double every cost the shop has.
  v_entry_id := public.post_journal_entry(
    -- v_shop_id does not exist in record_invoice_payment; the row is v_invoice.
    v_invoice.shop_id, p_paid_on, 'Supplier paid',
    jsonb_build_array(
      jsonb_build_object('code', '2000', 'amount_cents',  p_amount_cents, 'memo', 'Bill paid'),
      jsonb_build_object('code', public.account_code_for_payment_method(p_method),
                         'amount_cents', -p_amount_cents, 'memo', 'Paid by ' || p_method)),
    -- The bill's store, not null: a payment against one store's bill must not
    -- post with no store at all.
    v_invoice.location_id, 'payment');
  update public.invoice_payments set journal_entry_id = v_entry_id where id = v_payment_id;
```

In `post_payroll_run`, after the run's status becomes `'posted'`:

```sql
  -- Cash, not 2200 Wages Payable: post_payroll_run records a run that HAS been
  -- paid. Accruing wages that are owed but unpaid is phase 3's work, and 2200
  -- stays unused until then rather than being written to speculatively.
  v_entry_id := public.post_journal_entry(
    -- payroll_runs has NO paid_on column; the coalesce collapses to its
    -- fallback, and current_date resolves in UTC.
    v_run.shop_id, public.shop_local_date(), 'Payroll',
    jsonb_build_array(
      jsonb_build_object('code', '6200', 'amount_cents',  v_total, 'memo', 'Wages'),
      jsonb_build_object('code', '1000', 'amount_cents', -v_total, 'memo', 'Paid out')),
    v_run.location_id, 'payroll');
  update public.payroll_runs set journal_entry_id = v_entry_id where id = p_run_id;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test:db`
Expected: `verify-posting-bills  pass`, **23 database checks passed**.

- [ ] **Step 5: Prove the test can fail**

Mutation: add a `6900` debit line to `record_invoice_payment`. Expected: check 1 fails with `must not post an expense a second time`. Revert.

Mutation: hardcode `'1000'` as the credit account in `record_invoice_payment`. Expected: check 1 fails with `paid by zaad should not touch 1000 Cash`. Revert.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/20260908000500_post_bills_and_payroll.sql supabase/tests/verify-posting-bills.sql
git commit -m "feat(accounting): supplier payments and pay runs post to the ledger"
```

---

### Task 7b: an expense written by a plain `insert` posts

**This was not in the original plan.** It exists because writing the plan exposed a hole in its own premise. The design's premise is *"every money move goes through an RPC, so the posting side is added inside the existing function and no call site changes."* That is true of all seven RPCs in Tasks 3–7. It is **not** true of expenses: `src/lib/expenses.ts:96` is a plain `.from('expenses').insert()`. There is no function to add a posting side to.

Without this task, Task 8 backfills every historical expense and the very next expense a shop records goes unposted. The P&L would be complete up to the backfill date and progressively wrong after it — **the worst of the three possible states, because it looks right.**

Three ways out were considered. **(1) an `AFTER INSERT` trigger on `expenses`** — small, and the seam is where the row is written. **(2) bring `create_bill` forward from phase 3** — correct, and what the design ultimately wants, but a new RPC plus a screen change is phase-3-sized work inside a phase-2b plan. **(3) ship the hole behind a `Caveat` on the Expenses screen** — honest, but it invents a nightly job that does not exist.

**Decided: (1).** It reuses the mapping Task 1 already built, and it means the trial balance is complete on the day this phase ships rather than on the day phase 3 does. The cost of the choice, stated rather than hidden: this codebase has deliberately kept money logic in RPCs rather than triggers, and a trigger that can raise makes every expense insert able to fail on a ledger problem — which is why the closed-period redirect below is not optional.

**Files:**
- Create: `supabase/migrations/20260908000750_post_expenses.sql`
- Create: `supabase/tests/verify-posting-expenses.sql`

**Interfaces:**
- Consumes: `expenses.journal_entry_id` (Task 2), `account_code_for_expense_category` and `account_code_for_payment_method` (Task 1), `shop_local_date()`.
- Produces: `public.post_expense_to_ledger()` and the `expenses_post_to_ledger` `AFTER INSERT` row trigger. No signature change anywhere; no call site changes.

**The mapping is what makes a balance sheet possible.** `inventory_purchase` maps to `1200 Inventory` (an **asset**, not a cost) and `owner_draw` to `3100 Owner's Draw` (**contra-equity**, not a cost). `NON_OPERATING_CATEGORIES` in `src/lib/expense-reporting.ts` reaches the right net profit today by *excluding* those two — the right answer by the wrong route, because a filter in a reporting helper cannot also produce a balance sheet. Once these entries exist the exclusion is a **consequence of where each account sits** rather than a list somebody has to remember to keep in step.

#### The exclusion, which is what breaks this if it is missed

**`post_payroll_run` writes BOTH a journal entry AND an `expenses` row** carrying `payroll_run_id` and category `salaries_wages` — which the map sends to `6200`. `sync_invoice_expense` mirrors every bill into `expenses` carrying `invoice_id`; that cost is recognised by the bill and its liability side by `receive_stock` (`Cr 2000`) and `record_invoice_payment` (`Dr 2000`).

So a naive trigger double-posts. `6200 Salaries and Wages` and `1000 Cash` would each be counted **twice** for one pay run, and every stocked cost would be recognised twice — **with the trial balance still zero**, because both entries individually balance. Nothing else in the system catches that.

**The trigger skips any row where `payroll_run_id is not null`, `invoice_id is not null`, or `journal_entry_id is not null`.** The third is the same guard Task 2's column exists for, and it is what stops a backfill running against a live trigger from posting twice. `log_recurring_bill` sets **neither** of the first two and is deliberately **not** excluded — nothing else posts for it, and it is a real cost the shop just incurred.

#### CORRECTED after the final whole-branch review: three exclusions is not enough, and one branch is not enough

The review found two Criticals no per-task review could see, because each looked only at its own diff. **`stock-restock-modal.tsx` calls `createExpense('inventory_purchase')` after `receiveStock`**, and **`stock-count-modal.tsx` calls `createExpense('stock_loss')` after `saveStockCount`** — in both cases on top of an RPC that has already posted the event. `receive_stock` posts `Dr 1200 / Cr 2000`; the trigger then posted `Dr 1200 / Cr 1000` for the same goods, doubling inventory and inventing a payable against a supplier paid in cash. `save_stock_count` posts `Dr 5100 / Cr 1200`; the trigger then posted `Dr 5100 / Cr 1000`, doubling shrinkage and crediting a till that never opened. Every entry balances, so the trial balance stays at zero and nothing goes red.

**The checkboxes and the rows stay.** The Expenses screen and the expense reports read `expenses`, not the ledger; removing either is a visible product change. What was wrong is *what they post*. And the two cases are not the same defect: a restock expense **is not a duplicate** (the receipt records goods arriving, the expense records that cash was paid, so it must settle the payable), while a count expense **is** (nothing is left to record, and no money moved).

**Root cause: `expenses` had no link to a receipt or a count**, so the trigger could not tell a linked row from a standalone one. `20260908000800_expense_source_links.sql` adds `stock_receipt_id` and `stock_count_id` (with a `CHECK` that at most one of the four link columns is set), both modals set them, and the trigger branches six ways:

| Row | Posts |
|---|---|
| `payroll_run_id` set | nothing — `post_payroll_run` wrote its own entry |
| `invoice_id` set | nothing — the bill recognised the cost |
| `journal_entry_id` set | nothing — already posted; the backfill sets this |
| `stock_count_id` set | nothing — `save_stock_count` posted both sides |
| `stock_receipt_id` set | `Dr 2000 Accounts Payable / Cr <the payment method's wallet>` |
| standalone `inventory_purchase` | `Dr 1200 / Cr <wallet>` — bought and paid for in one step |
| standalone `stock_loss` | `Dr 5100 / Cr 1200` — **not** a wallet |
| any other category | `Dr <the category's account> / Cr <wallet>` |

**Standalone `stock_loss` crediting `1200` is a second fix, not a restatement of the first.** It was wrong before the double-post existed and would still be wrong with the double-post gone: losing stock costs the shop the stock, not the till, and crediting cash balances perfectly while leaving `1200` carrying units that are not on the shelf.

`verify-posting-expenses.sql` gains checks 9–12 for the pairs and the two standalone cases; `verify-backfill.sql` gains both historical pairs plus a standalone `stock_loss`, and asserts the replay reaches the same figures.

#### Two decisions the brief left to the implementation

**`p_source` is `'bill'`, not `'payment'`.** `'payment'` is already taken by `record_invoice_payment`, whose entry is `Dr 2000 / Cr a wallet` and touches no expense account at all. Reusing it would make `where source = 'payment'` return two structurally different entries, and any phase-3 report grouping by source would mix a liability settlement with a cost recognition. `'bill'` is the recognition of a cost the shop has incurred — `20260904000300`'s own comment on `entry_date` uses *"a bill entered on 3 September for August utilities"* as the example — and no other door uses it.

**The credit is `account_code_for_payment_method(new.payment_method)`, not a hardcoded `1000 Cash`.** `expenses.payment_method` carries the same four values `invoice_payments.method` does, and Task 1's map already answers this. Hardcoding `1000` would make the till count disagree with the ledger for every zaad or eDahab expense and leave `1020`/`1021` permanently understated on the balance sheet this phase exists to make possible — the exact defect `verify-posting-bills.sql` check 2 catches on the supplier-payment side. For the common case (`payment_method` defaults to `'cash'`) this **is** `'1000'`.

#### `p_entry_date` is `occurred_on`, and a closed month redirects

`expenses.occurred_on` is already a `date` column, so it is **exempt from the `shop_local_date()` rule** — there is no moment in time to resolve against a server timezone, and wrapping it would be a no-op cast through a function that expects a `timestamptz`. It is the right date on its own terms: `20260804000200` makes the point that a receipt is often logged days after the purchase and it is the *purchase* date that decides the period.

**But the expense editor has a free date field (`expense-editor-modal.tsx:101`), so back-dating is the ordinary way last week's receipt is entered — not an import edge case.** `open_period_for` raises for any non-open period, so without a redirect a plain expense insert (something that works today) would start failing outright the moment a shop closed a month. This applies Task 3b's Change 2 treatment: **read** the period's status and redate to `shop_local_date()`, never **catch** `open_period_for`'s exception — a handler around the post would also swallow an unbalanced entry, an unknown account code or a missing chart of accounts and retry them into the current month as though the only thing wrong were the date. The entry's description carries the true `occurred_on` and the status that pushed it, so the journal says why an old cost is sitting in this month.

- [ ] **Step 1: Write the failing test**

Create `supabase/tests/verify-posting-expenses.sql`. Eight checks: an ordinary expense posts `Dr` its category's account / `Cr 1000` and sets `journal_entry_id`; a zaad expense credits `1020`; `inventory_purchase` debits `1200` and posts **no** expense-type line; `owner_draw` debits `3100` and the debit's account **type** is `equity`; a pay run posts exactly one entry and `6200` reads the run total shop-wide, not double it; a bill's mirrored expense row posts nothing; a row already carrying `journal_entry_id` is left alone; a back-dated expense in a closed month redirects.

**Read `journal_entry_id` back with a `select`, never from `RETURNING`.** The trigger is `AFTER INSERT` and writes the column with its own `UPDATE`, so the `RETURNING` value is the pre-trigger `NULL` — an assertion on it fails a *correct* implementation. That is the shape of no-op this plan has hit seven times.

**Measure `6200` shop-wide, not per entry.** A duplicate payroll entry is invisible to every per-entry assertion in `verify-posting-bills.sql`; the run points at one of the two and both balance.

- [ ] **Step 2: Run it and verify it fails**

Run: `npm run test:db -- --no-reset`
Expected: `verify-posting-expenses  FAIL` — `an ordinary expense did not post -- expenses.journal_entry_id is null`.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/20260908000750_post_expenses.sql`. **`AFTER`, not `BEFORE`**, so the ledger only ever learns about an expense the table has already accepted (`amount_cents > 0`, the category `CHECK`, `enforce_shop_module`) — which means `new` is not writable and the pointer goes on with an `update ... where id = new.id` rather than an assignment. `security definer`, matching `sync_invoice_expense`'s posture, so the pointer write never meets the expense update policy.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test:db`
Expected: `verify-posting-expenses  pass`, **24 database checks passed**.

- [ ] **Step 5: Prove the test can fail**

Twelve mutations, every one red. Notably: remove the `payroll_run_id` exclusion → `posting a pay run wrote 1 extra 'bill' entries`. Remove the `invoice_id` exclusion → `recording a bill wrote 1 journal entries via its mirrored expense row`. Hardcode the credit to `'1000'` → `expected Cr 1020 Zaad -4188, got 0`. Map `inventory_purchase` to `6900` → `expected Dr 1200 Inventory 52193, got 0`. Drop the closed-period redirect → the insert dies with `This period is closed — posting into it is refused`.

The two `if exists (… a.type = 'expense')` guards need their **own** mutation to bite — an off-by-one in the map trips the amount assertion above them first. The mutation that reaches them adds a balanced `6900`/`1020` pair to the entry, leaving every amount check green.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/20260908000750_post_expenses.sql supabase/tests/verify-posting-expenses.sql
git commit -m "feat(accounting): an expense recorded from the client posts to the ledger"
```

---

### Task 8: The historical backfill

Every existing row replayed into the ledger. This is the task with real risk, and the one that must **not** call `post_journal_entry`.

**Two transient states this task's verification must not read as defects.** First: a refund or a settlement taken against a sale rung **before** Task 3 shipped posts **one-sided** — `refund_sale_items` credits `1100 Accounts Receivable` and `settle_sale_balance` clears it, but the debit that put the receivable there was never posted, because the sale predates posting. Until the backfill runs, those shops' `1100` reads negative and the trial balance still nets to zero only because each individual entry balances. That is expected, it resolves the moment `backfill_shop_ledger` replays the originating sale, and it is not something to "fix" in the RPCs. Second: the `customer_balances` divergence recorded in the **Open** section above — the app's `owed_cents` and the ledger's `1100` legitimately differ after a partial return of a part-paid sale, and the difference is the app's, not the backfill's.

**Files:**
- Create: `supabase/migrations/20260908000700_backfill_ledger.sql`

**Interfaces:**
- Produces: `public.backfill_shop_ledger(p_shop_id uuid) returns integer` — the number of entries written. Idempotent: rows already carrying a `journal_entry_id` are skipped, so re-running writes nothing and returns 0.

#### Why the backfill bypasses `post_journal_entry`

Two reasons, both structural:

1. **The reference generator is O(n) per call.** `post_journal_entry` computes `'JE-' || year || '-' || lpad(count(*) + 1)` by counting the shop's entries for that year. Called once per historical row, that is O(n²) — a shop with 8,000 sales does 32 million row counts. This is fine for the interactive path it was written for and unusable for a replay.
2. **It opens periods one at a time.** `open_period_for` inserts a period on first use. Fine interactively; wasteful across three years of history, and it raises the moment it meets a month someone has already closed — which would abort a replay halfway through.

The backfill therefore creates the periods it needs up front, generates references with a window function, and inserts `journal_entries` and `journal_lines` directly. **The deferred balance trigger still runs**, so the guarantee is unchanged — only the convenience wrapper is skipped.

#### The expense replay must apply Task 7b's exclusion, for the same reason

**The backfill's expense replay must skip every `expenses` row where `payroll_run_id is not null` or `invoice_id is not null`, exactly as `post_expense_to_ledger()` does** — and, being a replay, every row already carrying a `journal_entry_id`.

The reason is Task 7b's reason, unchanged: `post_payroll_run` writes **both** a journal entry and an `expenses` row carrying `payroll_run_id` and category `salaries_wages`, which the map sends to `6200`. `sync_invoice_expense` mirrors every bill into `expenses` carrying `invoice_id`, and that cost's liability side is posted by `receive_stock` and settled by `record_invoice_payment`. Replaying either row would count `6200 Salaries and Wages` and every stocked cost **twice** — **with the trial balance still zero**, because both entries individually balance. Task 8's own tie-out compares the replay against the live path, so a replay that copies the trigger's exclusion wrongly and a trigger that has it right disagree by exactly the wages; a replay that copies it wrongly in the *same* way the trigger would have been wrong agrees perfectly and is wrong twice.

Because a shop may be backfilled while the trigger is live, the `journal_entry_id is null` filter is not an optimisation — it is what stops the two paths posting the same expense.

**CORRECTED with Task 7b: the replay branches exactly as the trigger branches.** The exclusion is now **four** — `stock_count_id is not null` joins the other three, because `save_stock_count` posted both sides of that write-off itself. It is the only exclusion that leaves a row with `journal_entry_id` null **for ever by design**, so `verify-backfill.sql` check 5 excludes it there too or it would be red on a correct replay. And for the rows the replay *does* handle, it takes the same three-way branch the trigger takes: `stock_receipt_id` set → `Dr 2000 / Cr <wallet>`; standalone `stock_loss` → `Dr 5100 / Cr 1200`; anything else → `Dr <the category's account> / Cr <wallet>`.

**Historical rows predate both columns and have them null, so they take the standalone path — and that is correct, not a gap being papered over.** Those rows were written before the ledger existed: there is no receipt entry for a null `stock_receipt_id` to settle, because `receive_stock` posted nothing at the time, and the replay writes that receipt's own `Dr 1200 / Cr 2000` from `stock_receipts` in the same run. A historical `inventory_purchase` therefore has to debit `1200` on its own account. Only rows written after `20260908000800` shipped carry a link, and for those the receipt entry exists and the settlement has something to settle.

The two columns are added by `20260908000800`, which applies **after** this migration. That forward reference is safe: a `plpgsql` body is only syntax-checked at `CREATE` time — column names resolve on first execution — and `backfill_shop_ledger` is never called during a migration run.

#### The backfill must be SERIALISED PER SHOP, and every back-link must re-check

*(Added by the final whole-branch review, as finding I6. The first implementation had neither.)*

"Idempotent, because it is driven by `journal_entry_id is null`" is a statement about two runs **separated in time**. It says nothing about two runs **overlapping**, and under `READ COMMITTED` two overlapping runs both succeed:

* A snapshots every unposted row into `_bf_map` and starts writing entries.
* B, a moment later, snapshots **the same rows** — A has committed nothing — and builds a second complete set with its own ids.
* B blocks on A's row locks at the back-links, and when A commits, B **re-evaluates its `WHERE` against the row version A committed**. A `WHERE` that does not mention `journal_entry_id` matches anyway and **overwrites** A's pointer.

Two complete sets of entries; every source row points at B's; A's are posted and orphaned; every account reads double — **with the trial balance still at zero**, because both sets individually balance, and with both runs returning a positive count.

Two things are required, and both are wanted:

1. **`perform pg_advisory_xact_lock(74921, hashtext(p_shop_id::text));` as the first thing after the permission gate.** Transaction-scoped, keyed on the shop. This is what stops the orphaned entries from ever being written. `post_payroll_run` takes exactly this lock (classid `74920`) for a far smaller race, and rewriting a shop's entire history is the heaviest thing anyone can do to these books. **Register the classid** in `post_payroll_run`'s `ADVISORY LOCK CLASSID REGISTRY` comment — Postgres has one global advisory keyspace and a collision makes two unrelated features block each other.
2. **`and <table>.journal_entry_id is null` on ALL EIGHT back-links** in step 5. This is what makes the losing update a no-op rather than a clobber. Missing one re-opens the hole for that table alone.

The race cannot be reproduced from a `verify-*.sql` script: every fixture row lives in an uncommitted transaction, and a second session — via `dblink` or otherwise — cannot see any of it. So the sequential half is behavioural (check 6: a second run writes nothing) and the guard itself is asserted **structurally**, from `pg_get_functiondef`, in check 14 — comment-stripped and whitespace-normalised, with one assertion per back-link so the message names the table that lost its re-check.

#### `sales` needs a "carries money" predicate like every other kind

*(Added by the final whole-branch review, as finding I7.)*

Every other source kind in step 1 filters on the row carrying money — a receipt with no costed line, a count with zero net variance, a payment of zero. `sales` did not. A **zero-value sale** is legal and reachable (`p_allow_balance`, `20260831000100`): free samples priced at 0, left on account against a named customer. It produces **no journal line at all** — every amount is zero and `amount_cents <> 0` throws them away — so it was given an entry with nothing under it and **step 7 aborted the entire shop's replay** with *"could not build a complete entry"*, over one giveaway from two years ago.

The predicate is the exact disjunction of the six line groups step 6 builds, not a proxy for them: a false negative would silently skip a sale that **does** carry money. At least one non-zero line implies at least two, because the six groups balance by construction — so the predicate is also exactly the condition step 7's two-line guard tests for.

**The same bug is live**, and is fixed in the same commit: `complete_sale` (and `edit_sale`) now skip `post_journal_entry` entirely when the line array is empty, where before such a sale **failed at the till** with *"A journal entry needs at least two lines; this one has 0."* — a new failure mode for an operation that worked before this branch. `sales.journal_entry_id` stays null on such a sale, permanently and by design, which is why `verify-backfill.sql` check 5 exempts the fixture's zero-valued sale by id and check 13 asserts it was skipped for the right reason.

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
           'Sale (backfilled)', 'sale', 'posted', m.location_id
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
               public.account_code_for_payment_method(sp.method) as code,
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
         'Stock received (backfilled)', 'stock', 'posted', m.location_id
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
         'Expense (backfilled)', 'payment', 'posted', m.location_id
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
Expected: `verify-backfill  pass`, **25 database checks passed** (24 after Task 7b, plus `verify-backfill`).

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
Expected: clean; 139 suites / 2122 tests (plus the two new `accumulated-rpc-edits` assertions); 81 lint; **25** database checks (24 after Task 7b, plus `verify-backfill`).

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
