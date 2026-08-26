# The Financial Statements (Phase 3a) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the ledger into the three statements an accountant actually asks for — income statement, balance sheet, cash flow — each reading the same posted entries and each reconciling to the others.

**Architecture:** One server-side function per statement, each returning ordered rows the screen renders without arithmetic. The P&L and the Income Statement are **one query with a detail flag**, not two reports. Nothing new is written to the ledger; this phase only reads it.

**Tech Stack:** Postgres 15 (Supabase), plpgsql, TypeScript, React Native (Expo SDK 57). No new dependencies.

---

## Why this is 3a and not "phase 3"

The design's phase 3 lists nine things: three statements, period close, retained earnings, `create_bill`, `transfer_funds`, fixed assets and depreciation. Those are **three independent subsystems**, and each produces working software on its own:

| | Ships | Depends on |
|---|---|---|
| **3a — the statements** *(this plan)* | Income statement, balance sheet, cash flow | Nothing beyond what is already deployed |
| **3b — period close** | `close_accounting_period`, retained earnings roll, auto-close, the Close a Period screen | 3a's `statement_lines()` for the profit figure it rolls |
| **3c — new transactions** | `transfer_funds`, `fixed_assets`, `run_depreciation` | Nothing; but depreciation only shows up on 3a's statements |

Building them as one plan would mean no statement ships until fixed assets do. Building 3a first means the thing the whole accounting project was for is usable immediately, and 3b and 3c improve it.

**`create_bill` is already delivered** and should be struck from phase 3's scope. The design specified it because, when it was written, entering a bill posted nothing. It now does: `invoices` → `sync_invoice_expense` → `post_expense_to_ledger` posts `Dr <category account> / Cr 2000`, and PR #78 made a goods bill name the delivery it pays for. A separate `create_bill` RPC would be a second door onto the same ledger effect. Confirm this before writing 3c and remove it from the roadmap.

---

## Global Constraints

Every task's requirements implicitly include this section.

### Baselines — **measure these yourself before starting; they move under you**

As at 2026-08-25, on `main`:

- `npx tsc --noEmit` → **clean**
- `npm test` → **159 suites, 2513 tests**
- `npm run lint` → **95 problems (53 errors, 42 warnings)**
- `npm run test:db` → **28 pass**

**These are not stable.** Another session ships to this repo concurrently — during the two hours it took to write this plan, jest went 2446 → 2513, lint went 85 → 95 and `test:db` went 27 → 28, none of it accounting work. Take your own reading on the commit you branch from and compare against *that*, never against a number in a document. A plan that pins a moving baseline teaches its reader to ignore a real regression.

That session also resets the local database periodically. If a `test:db` result looks impossible, re-run from a clean reset before concluding anything — an entire mutation pass was invalidated that way during phase 2b.

The counts below (**28 → 30**) are relative: this plan adds two scripts.

`npx supabase start` must be running. Migrations are applied **locally only**; `npx supabase db push` is the human's call.

### The ledger, as built

Everything below is deployed. Read the migration, not this summary, before relying on any of it.

**`accounts`** — `id, shop_id, code, name, type, is_contra, archived_at, created_at, updated_at`.

`type` is one of `asset, liability, equity, revenue, cost_of_sales, expense`. **`is_contra` is already modelled** and is true for exactly four accounts:

| Code | Name | Type | Why contra |
|---|---|---|---|
| `1590` | Accumulated Depreciation | asset | Reduces fixed assets |
| `3100` | Owner's Draw | equity | Reduces equity |
| `4100` | Sales Returns | revenue | Reduces revenue |
| `4200` | Discounts Given | revenue | Reduces revenue |

The seeded chart, by type:

```
asset          1000 1010 1020 1021 1100 1200 1500 1510 1590
liability      2000 2100 2200 2300
equity         3000 3100 3900
revenue        4000 4100 4200
cost_of_sales  5000 5100
expense        6000 6100 6200 6300 6400 6500 6600 6700 6800 6900
```

A shop may add its own accounts, so **never hardcode a list of codes where a `type` will do.** The statements group by `type` and `is_contra`; they name a specific code only where the design names one (`1590`, `3900`, `1200`, `1100`).

**`journal_lines`** — `amount_cents bigint not null check (amount_cents <> 0)`. **Debit positive, credit negative.** So an asset or expense with a debit balance sums **positive**, and a liability, equity or revenue account with a credit balance sums **negative**. Every statement in this plan has to flip that sign for presentation, and getting it wrong produces a statement that balances and reads upside down.

**`journal_entries`** — carries `status`, one of `draft`, `posted`, `reversed`. **The statements read `posted` and `reversed` and exclude `draft`**, matching `src/lib/ledger.ts:84`. A reversed entry's own lines still stand; its reversal's lines cancel them. Excluding `reversed` would leave a correction's reversal in and its original out.

**`accounting_periods`** — `id, shop_id, starts_on, ends_on, status, closed_at, closed_by, exceptions, created_at`. `status` is `open`, `closed` or `locked`. `exceptions` is an array. Nothing in this plan writes to it; 3b does.

### The statements must reconcile, and that is the deliverable

From the mockup, stated as a promise to the reader:

- Net profit on the income statement **is** the "profit this period" line on the balance sheet
- Net profit **is** the opening line of the cash flow's operating section
- Net profit **is** the `4000`–`6999` accounts netted on the trial balance
- Total assets **equals** total liabilities and equity, *"not checked after the fact — a consequence of every entry balancing"*
- The cash flow's closing cash **equals** the balance sheet's cash

**Task 5 exists to assert all five to the cent.** A statement that is individually plausible and inconsistent with its siblings is the failure this phase must not ship.

### Test conventions

- DB checks live in `supabase/tests/verify-*.sql`, **auto-discovered by glob**, and must print **`ALL CHECKS PASSED`** via `raise notice` — a script that does not print it counts as FAILED.
- Fixtures build in one `do $$ ... $$` block and roll back by raising `'rollback fixture'`, caught in an `exception` clause. Copy `verify-backfill.sql`.
- **These scripts run as `postgres`, so RLS never applies.** Assert policies against `pg_policies`, never by attempting the operation. An RPC gating on `has_shop_permission` needs `set_config('request.jwt.claims', ...)` and `set_config('role', 'authenticated', ...)` first — and setting `role` turns RLS **on**, so raw inserts come before it.
- **A shop has no location until the fixture makes one.** `seed_shop_defaults` does not create one.
- **Every test step names the mutation that must turn it red.** Apply it, watch it fail, revert.
- **Roughly thirty mutations in this project have turned out to be no-ops** — tests that could not fail. Causes found so far: `sum()` ignoring nulls; a balance guard firing before the assertion it was meant to prove; two branches algebraically identical; a plpgsql `BEGIN … EXCEPTION` subtransaction rolling back the very write being asserted; a fixture shop that happened to be ten days old, so two different dates coincided. **Run every mutation. One that does not redden its check is a finding, not a formality.**

### Screen conventions

Read `.claude/skills/building-bento-screens/SKILL.md` before any UI. It binds.

- These screens live under `src/components/accounting/ledger/`, alongside `trial-balance-view.tsx`, `journals-view.tsx` and `backfill-view.tsx`. **Copy `trial-balance-view.tsx`'s shape** — it is the closest existing screen and already solves the account-table layout.
- Every `StatTile` on a bento card needs `variant="bento"`. `Caveat` takes its text as **children**. `tone="wrong"` must carry an action; `tone="context"` must not.
- A `DataTable` already scrolls horizontally inside its card — never wrap it in another horizontal scroller.
- `DateRange` is `{ since, until? }`, not `start`/`end`. Never `new Date(dateColumn)` — a date-only string parses as UTC midnight and renders a day early west of Greenwich. Use `fromDateColumn` / `toDateColumn`.
- Read the exact versioned Expo docs at https://docs.expo.dev/versions/v57.0.0/ before writing Expo-specific code — `AGENTS.md` requires it.

### Migration rules this project has already paid for

- `pg_get_function_arguments`, **never** `pg_get_function_identity_arguments` — the identity form drops `DEFAULT` clauses and `CREATE OR REPLACE` refuses to remove defaults.
- `journal_entries.source` permits exactly: `manual, sale, refund, settlement, bill, payment, payroll, stock, count, transfer, asset, depreciation, close, opening`. Nothing in this plan writes an entry, but 3b and 3c will.
- Any function this repo re-creates is reproduced **in full**, and gains an entry in `supabase/tests/accumulated-rpc-edits.test.ts` with a token that appears only in executable code, never in a comment.

---

## Open — one decision, and the roadmap is stale on it

**Where shrinkage sits.** `docs/superpowers/ACCOUNTING-ROADMAP.md` says this is open and *"Recommended: leave it in operating expenses, where the Count door already puts it."*

**That recommendation is out of date.** The design's own Open section records it as **resolved on 2026-08-23** the other way — *"Shrinkage sits in cost of sales (`5100`), above gross profit"* — and that is what shipped: `5100` is seeded with `type = 'cost_of_sales'`, and `save_stock_count` posts to it.

So this is not a decision to make; it is a decision **already made and implemented**, and the roadmap should be corrected. Doing so is a step in Task 1.

The consequence is visible and should be stated on the statement rather than discovered: gross profit falls by shrinkage, operating expenses fall by the same amount, **net profit is unchanged**. `yusefshop` is a vivid case — $866 of shrinkage against $378 of revenue — and that is exactly the number a shop needs above gross profit rather than buried in opex.

**If the preference is genuinely to move it**, say so before Task 1: it is one line in the grouping (map `cost_of_sales` accounts other than `5000` into the opex group) plus its checks. Retrofitting it after the statements ship means restating every period a shop has looked at.

---

## File Structure

| File | Responsibility |
|---|---|
| `supabase/migrations/20261001000000_statement_lines.sql` | `statement_lines()` — the one query behind P&L and Income Statement |
| `supabase/migrations/20261001000100_balance_sheet.sql` | `balance_sheet()` |
| `supabase/migrations/20261001000200_cash_flow.sql` | `cash_flow()` — indirect method |
| `src/lib/statements.ts` | The three read functions and their row types. No arithmetic. |
| `src/components/accounting/ledger/income-statement-view.tsx` | Both the summary and the detailed rendering |
| `src/components/accounting/ledger/balance-sheet-view.tsx` | |
| `src/components/accounting/ledger/cash-flow-view.tsx` | |
| `supabase/tests/verify-statements.sql` | One fixture, all three statements, and the five reconciliations |
| `supabase/tests/verify-statement-permissions.sql` | `ledger.view` gating, asserted against `pg_policies` and the function gates |

`test:db` goes from **28** to **30** — two new scripts.

The three screens are separate files because they render differently and change for different reasons. The three SQL functions are separate migrations for the same reason — and because a reviewer can reject one without rejecting its neighbours.

---

### Task 1: `statement_lines()` — one query, two reports

**Files:**
- Create: `supabase/migrations/20261001000000_statement_lines.sql`
- Create: `supabase/tests/verify-statements.sql`
- Modify: `docs/superpowers/ACCOUNTING-ROADMAP.md` (the stale shrinkage recommendation)

**Interfaces:**
- Produces:
  ```sql
  public.statement_lines(
    p_shop_id  uuid,
    p_from     date,
    p_to       date,
    p_detail   boolean default false
  ) returns table (
    section    text,     -- 'revenue' | 'cost_of_sales' | 'gross_profit'
                         -- | 'operating_expenses' | 'net_profit'
    code       text,     -- the account's code, or null on a subtotal row
    label      text,
    amount_cents bigint, -- PRESENTATION sign: income positive, costs positive
    is_total   boolean,
    sort_order integer
  )
  ```

**The detail flag is the whole point.** `p_detail => false` returns one row per *section* plus subtotals — the owner's Profit & Loss. `p_detail => true` returns one row per *account* within each section, plus the same subtotals — the accountant's Income Statement. **Both come from the same aggregation**, so they cannot disagree. Built as two reports they eventually would, and nobody would know which was right — that is the design's stated reason and it is the reason the signature has a flag rather than there being two functions.

- [ ] **Step 1: Write the failing test**

Create `supabase/tests/verify-statements.sql`. The fixture is deliberately shaped so every section is non-zero and no two figures coincide:

```sql
-- The three statements, and the five ways they must agree with each other.
--
-- One fixture, posted through the real RPCs rather than by hand, because a
-- statement that agrees with journal lines someone wrote for it proves nothing.
--
-- Every figure below is chosen so that no two are equal and no subtotal can be
-- reached by a wrong pairing. That is not fussiness: three checks on this
-- project have passed against a wrong implementation because two numbers in the
-- fixture happened to match.

\set ON_ERROR_STOP on

do $$
declare
  v_user   uuid := gen_random_uuid();
  v_shop   uuid;
  v_loc    uuid;
  v_prod_a uuid;   -- cost 300, sells 1000
  v_prod_b uuid;   -- cost 700, sells 2500
  v_cust   uuid;
  v_sale   uuid;
  v_amount bigint;
begin
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
    values (v_user, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            'verify-statements-' || v_user || '@example.test', '', now(), now(), now());
  insert into public.shops (owner_id, name) values (v_user, 'Statement Shop') returning id into v_shop;
  insert into public.shop_locations (shop_id, name, is_primary) values (v_shop, 'Main', true)
    returning id into v_loc;
  insert into public.products (shop_id, name, price_cents, cost_cents, stock)
    values (v_shop, 'Widget A', 1000, 300, 100) returning id into v_prod_a;
  insert into public.products (shop_id, name, price_cents, cost_cents, stock)
    values (v_shop, 'Widget B', 2500, 700, 100) returning id into v_prod_b;
  insert into public.customers (shop_id, name) values (v_shop, 'Faduma') returning id into v_cust;

  perform set_config('request.jwt.claims', json_build_object('sub', v_user)::text, true);
  perform set_config('role', 'authenticated', true);

  -- Trading: 4 of A at list, 2 of B with a 500 order discount, paid cash.
  --   revenue at list   4*1000 + 2*2500 = 9000
  --   discount                              500
  --   COGS              4*300  + 2*700  = 2600
  perform public.complete_sale(
    v_shop,
    jsonb_build_array(
      jsonb_build_object('product_id', v_prod_a, 'quantity', 4, 'unit_price_cents', 1000),
      jsonb_build_object('product_id', v_prod_b, 'quantity', 2, 'unit_price_cents', 2500)),
    jsonb_build_array(jsonb_build_object('method', 'cash', 'amount_cents', 8500)),
    null, null, null, null, 500, null, null, v_loc);

  -- Shrinkage: 3 of A missing. 3 * 300 = 900, into 5100 (cost of sales).
  perform public.save_stock_count(v_shop, v_loc,
    jsonb_build_array(jsonb_build_object('product_id', v_prod_a, 'counted_quantity', 93, 'reason', 'damaged')));

  -- Operating expenses: rent 4000 (6000), utilities 1250 (6100).
  insert into public.expenses (shop_id, location_id, occurred_on, amount_cents, category, payment_method)
    values (v_shop, v_loc, public.shop_local_date(), 4000, 'rent', 'cash'),
           (v_shop, v_loc, public.shop_local_date(), 1250, 'utilities', 'cash');

  -- 1. Revenue is NET of returns and discounts, and excludes sales tax.
  --    9000 at list less the 500 discount = 8500.
  select amount_cents into v_amount from public.statement_lines(v_shop, '2000-01-01', '2100-01-01')
   where section = 'revenue' and is_total;
  if v_amount <> 8500 then
    raise exception 'FAIL: net revenue is %, expected 8500 (9000 = discount not deducted)', v_amount;
  end if;

  -- 2. Cost of sales carries COGS *and* shrinkage. 2600 + 900 = 3500.
  --    THE ONE THAT MATTERS for the shrinkage decision: 2600 here would mean
  --    5100 had been grouped into operating expenses instead.
  select amount_cents into v_amount from public.statement_lines(v_shop, '2000-01-01', '2100-01-01')
   where section = 'cost_of_sales' and is_total;
  if v_amount <> 3500 then
    raise exception 'FAIL: cost of sales is %, expected 3500 (2600 = shrinkage grouped into opex)', v_amount;
  end if;

  -- 3. Gross profit = 8500 - 3500 = 5000.
  select amount_cents into v_amount from public.statement_lines(v_shop, '2000-01-01', '2100-01-01')
   where section = 'gross_profit';
  if v_amount <> 5000 then
    raise exception 'FAIL: gross profit is %, expected 5000', v_amount;
  end if;

  -- 4. Operating expenses = 4000 + 1250 = 5250. Stock purchases and owner
  --    draws must NOT appear: they are an asset and equity respectively, and
  --    that is what makes a balance sheet possible.
  select amount_cents into v_amount from public.statement_lines(v_shop, '2000-01-01', '2100-01-01')
   where section = 'operating_expenses' and is_total;
  if v_amount <> 5250 then
    raise exception 'FAIL: operating expenses is %, expected 5250', v_amount;
  end if;

  -- 5. Net profit = 5000 - 5250 = -250. NEGATIVE, deliberately: a fixture that
  --    only ever produces a profit never exercises the sign.
  select amount_cents into v_amount from public.statement_lines(v_shop, '2000-01-01', '2100-01-01')
   where section = 'net_profit';
  if v_amount <> -250 then
    raise exception 'FAIL: net profit is %, expected -250 (a loss)', v_amount;
  end if;

  -- 6. THE DETAIL FLAG. Summary and detail must produce the SAME net profit
  --    and the SAME section subtotals. Two reports that disagree is exactly
  --    what one query with a flag exists to prevent.
  if (select amount_cents from public.statement_lines(v_shop, '2000-01-01', '2100-01-01', true)
       where section = 'net_profit')
     <> (select amount_cents from public.statement_lines(v_shop, '2000-01-01', '2100-01-01', false)
          where section = 'net_profit') then
    raise exception 'FAIL: detail and summary disagree about net profit';
  end if;

  -- ...and detail carries per-account rows where summary does not.
  if (select count(*) from public.statement_lines(v_shop, '2000-01-01', '2100-01-01', true)
       where section = 'operating_expenses' and not is_total) < 2 then
    raise exception 'FAIL: detail should list rent and utilities separately';
  end if;
  if (select count(*) from public.statement_lines(v_shop, '2000-01-01', '2100-01-01', false)
       where section = 'operating_expenses' and not is_total) <> 0 then
    raise exception 'FAIL: summary should carry no per-account rows';
  end if;

  -- 7. The date window bites. Nothing in 2019.
  if exists (select 1 from public.statement_lines(v_shop, '2019-01-01', '2019-12-31')
              where not is_total and amount_cents <> 0) then
    raise exception 'FAIL: a window with no trading returned figures';
  end if;

  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims', null, true);
  raise notice 'ALL CHECKS PASSED';
  raise exception 'rollback fixture';
exception
  when others then
    perform set_config('role', 'postgres', true);
    perform set_config('request.jwt.claims', null, true);
    if sqlerrm = 'rollback fixture' then return; end if;
    raise;
end $$;
```

- [ ] **Step 2: Run it and verify it fails**

Run: `npm run test:db -- --no-reset`
Expected: `verify-statements  FAIL` with `ERROR: function public.statement_lines(uuid, unknown, unknown) does not exist`.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/20261001000000_statement_lines.sql`:

```sql
-- The income statement, at two levels of detail, from one query.
--
-- Profit & Loss and Income Statement are the same report: the owner wants five
-- lines, the accountant wants every account. The design settled this
-- explicitly -- "built as two reports they would eventually disagree, and
-- nobody would know which was right" -- so it is one aggregation with a flag,
-- not two functions that happen to agree today.
--
-- ## Signs
--
-- journal_lines is debit-positive, credit-negative. A revenue account
-- therefore sums NEGATIVE and an expense account sums POSITIVE. Every figure
-- this function returns is flipped into PRESENTATION sign -- income positive,
-- costs positive -- because a statement that renders raw ledger signs reads
-- upside down while balancing perfectly.
--
-- ## Grouping
--
-- By accounts.type, never by a hardcoded list of codes: a shop can add its own
-- accounts and they must land in the right section without a migration.
--
--   revenue           -> revenue, netted (4100 Returns and 4200 Discounts are
--                        is_contra and reduce it)
--   cost_of_sales     -> cost_of_sales, which includes 5100 Inventory
--                        Shrinkage. That is deliberate and is the design's
--                        resolved position: a unit that is stolen or breaks is
--                        never sold, so its cost reaches COGS by no other path
--                        and gross profit reads high by exactly that amount,
--                        every month, invisibly.
--   operating_expenses-> expense
--
-- Note what is NOT here: 1200 Inventory and 3100 Owner's Draw. Stock purchases
-- and owner draws used to be expense categories and are now an asset and
-- contra-equity. That is what makes a balance sheet possible, and it is why
-- NON_OPERATING_CATEGORIES in expense-reporting.ts became a consequence of
-- where each account sits rather than a filter.

create or replace function public.statement_lines(
  p_shop_id uuid,
  p_from date,
  p_to date,
  p_detail boolean default false
) returns table (
  section text,
  code text,
  label text,
  amount_cents bigint,
  is_total boolean,
  sort_order integer
)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.has_shop_permission(p_shop_id, 'ledger.view') then
    raise exception 'You do not have permission to see the books.' using errcode = 'P0001';
  end if;

  return query
  with posted as (
    -- 'posted' AND 'reversed': a reversed entry's own lines still stand and
    -- its reversal cancels them. Excluding 'reversed' would leave the
    -- correction in and the original out. 'draft' is excluded, matching the
    -- trial balance (src/lib/ledger.ts).
    select a.type, a.code, a.name, l.amount_cents
      from public.journal_lines l
      join public.journal_entries e on e.id = l.entry_id
      join public.accounts a on a.id = l.account_id
     where e.shop_id = p_shop_id
       and e.status in ('posted', 'reversed')
       and e.entry_date between p_from and p_to
  ),
  by_account as (
    select case p.type
             when 'revenue' then 'revenue'
             when 'cost_of_sales' then 'cost_of_sales'
             when 'expense' then 'operating_expenses'
           end as section,
           p.code, p.name,
           -- The sign flip. Revenue credits are negative in the ledger and
           -- positive on the statement; costs are already positive.
           case when p.type = 'revenue' then -sum(p.amount_cents)
                else sum(p.amount_cents) end as amount_cents
      from posted p
     where p.type in ('revenue', 'cost_of_sales', 'expense')
     group by p.type, p.code, p.name
  ),
  by_section as (
    select section, sum(amount_cents) as amount_cents from by_account group by section
  )
  select * from (
    -- Per-account rows, only when detail was asked for.
    select b.section, b.code, b.name, b.amount_cents, false,
           case b.section when 'revenue' then 100
                          when 'cost_of_sales' then 300
                          else 600 end + 1
      from by_account b
     where p_detail

    union all
    select 'revenue', null, 'Net revenue',
           coalesce((select amount_cents from by_section where section = 'revenue'), 0), true, 200
    union all
    select 'cost_of_sales', null, 'Cost of sales',
           coalesce((select amount_cents from by_section where section = 'cost_of_sales'), 0), true, 400
    union all
    select 'gross_profit', null, 'Gross profit',
           coalesce((select amount_cents from by_section where section = 'revenue'), 0)
             - coalesce((select amount_cents from by_section where section = 'cost_of_sales'), 0),
           true, 500
    union all
    select 'operating_expenses', null, 'Total operating expenses',
           coalesce((select amount_cents from by_section where section = 'operating_expenses'), 0), true, 700
    union all
    select 'net_profit', null, 'Net profit',
           coalesce((select amount_cents from by_section where section = 'revenue'), 0)
             - coalesce((select amount_cents from by_section where section = 'cost_of_sales'), 0)
             - coalesce((select amount_cents from by_section where section = 'operating_expenses'), 0),
           true, 800
  ) rows (section, code, label, amount_cents, is_total, sort_order)
  order by sort_order, code nulls last;
end;
$$;

grant execute on function public.statement_lines(uuid, date, date, boolean) to authenticated;
```

- [ ] **Step 4: Correct the stale roadmap recommendation**

In `docs/superpowers/ACCOUNTING-ROADMAP.md`, step 4's prompt currently says shrinkage is open, *"Recommended: leave it in operating expenses."* Replace it with a statement that it was **resolved on 2026-08-23 in favour of cost of sales (`5100`)**, that `5100` shipped seeded as `type = 'cost_of_sales'`, and that `statement_lines()` groups it there. Note the visible consequence — gross profit falls, opex falls by the same amount, net profit unchanged — so nobody re-opens it as a bug report.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm run test:db`
Expected: `verify-statements  pass`, **29 database checks passed**.

- [ ] **Step 6: Prove the test can fail**

Mutation: drop the sign flip — `else sum(p.amount_cents)` for revenue too. Expected: check 1 fails with a negative net revenue. Revert.

Mutation: group `cost_of_sales` into `operating_expenses`. Expected: **check 2 fails with 2600**, naming the shrinkage decision. Revert.

Mutation: change `e.status in ('posted','reversed')` to `= 'posted'`. Expected: no check reddens on this fixture, because nothing here is reversed — **that is a finding.** Add a fixture step that edits the sale (which reverses and re-posts, via `edit_sale`) and assert net profit still ties. Then re-run the mutation and confirm it reddens.

Mutation: return per-account rows regardless of `p_detail`. Expected: check 6's last assertion fails — summary carried per-account rows. Revert.

Mutation: `between p_from and p_to` → no date filter. Expected: check 7 fails. Revert.

- [ ] **Step 7: Commit**

```bash
git add supabase/migrations/20261001000000_statement_lines.sql supabase/tests/verify-statements.sql docs/superpowers/ACCOUNTING-ROADMAP.md
git commit -m "feat(accounting): the income statement, at two levels of detail, from one query"
```

---

### Task 2: `balance_sheet()`

**Files:**
- Create: `supabase/migrations/20261001000100_balance_sheet.sql`
- Modify: `supabase/tests/verify-statements.sql`

**Interfaces:**
- Consumes: `statement_lines()` (Task 1) — for the "profit this period" equity line.
- Produces:
  ```sql
  public.balance_sheet(p_shop_id uuid, p_as_of date)
  returns table (
    section text,        -- 'current_assets' | 'fixed_assets' | 'total_assets'
                         -- | 'liabilities' | 'equity' | 'total_liabilities_equity'
    code text, label text, amount_cents bigint, is_total boolean, sort_order integer
  )
  ```

**A balance sheet is as-at a date, not over a range** — a balance sheet over a date range is meaningless, which is why the hub cards state their default period. It takes `p_as_of` and sums **every posted line up to and including that date**, from the beginning of the shop's history.

The layout, from the mockup:

```
Current assets      Cash on hand, Bank, Mobile money, Accounts receivable, Inventory
Fixed assets        Equipment & fittings at cost, less accumulated depreciation
Total assets

Current liabilities Accounts payable, Sales tax payable, Wages payable, Loyalty points
Equity              Owner's capital, Owner's draw (negative), Retained earnings — prior
                    periods, Profit this period
Total liabilities & equity
```

**Fixed vs current is decided by code range, and this is the one place a range is right**: `1500`–`1599` are fixed, everything else in `asset` is current. Say so in a comment, because it contradicts the "group by type, never by code" rule everywhere else, and the reason is that `type` does not carry the distinction.

**"Profit this period" is `statement_lines()`'s net profit for the current open period** — not for all time. `3900 Retained Earnings` holds prior periods, and 3b's close is what moves profit into it. Until 3b ships, `3900` is zero for every shop and the whole profit sits in "this period", which is correct and is what the reconciliation asserts.

- [ ] **Step 1: Write the failing test**

Append to `verify-statements.sql`:

```sql
  -- 8. THE ONE THAT MATTERS. Total assets equals total liabilities and equity.
  --    Not asserted as a tolerance and not computed by the screen: it is a
  --    consequence of every entry balancing, and showing it is the first thing
  --    an accountant looks for.
  if (select amount_cents from public.balance_sheet(v_shop, public.shop_local_date())
       where section = 'total_assets')
     <> (select amount_cents from public.balance_sheet(v_shop, public.shop_local_date())
          where section = 'total_liabilities_equity') then
    raise exception 'FAIL: the balance sheet does not balance -- assets % vs liabilities+equity %',
      (select amount_cents from public.balance_sheet(v_shop, public.shop_local_date()) where section = 'total_assets'),
      (select amount_cents from public.balance_sheet(v_shop, public.shop_local_date()) where section = 'total_liabilities_equity');
  end if;

  -- 9. Assets carry a POSITIVE presentation sign even though 1200 Inventory is
  --    credited by every sale. Getting this wrong produces a balance sheet
  --    that balances and reads upside down.
  select amount_cents into v_amount from public.balance_sheet(v_shop, public.shop_local_date())
   where code = '1000';
  if v_amount <= 0 then
    raise exception 'FAIL: Cash on Hand reads % -- assets present positive', v_amount;
  end if;

  -- 10. Owner's draw is CONTRA-equity and must reduce equity, so it presents
  --     negative. 3100 is is_contra in the seeded chart.
  --     (No draw in this fixture, so assert the shape rather than a figure:
  --     the row exists and the section total is the sum of its members.)
  if (select coalesce(sum(amount_cents), 0) from public.balance_sheet(v_shop, public.shop_local_date())
       where section = 'equity' and not is_total)
     <> (select amount_cents from public.balance_sheet(v_shop, public.shop_local_date())
          where section = 'equity' and is_total) then
    raise exception 'FAIL: the equity rows do not sum to the equity total';
  end if;

  -- 11. Profit this period IS the income statement's net profit. This is the
  --     first of the five reconciliations and the one a reader checks by eye.
  if (select amount_cents from public.balance_sheet(v_shop, public.shop_local_date())
       where section = 'equity' and label = 'Profit this period')
     <> (select amount_cents from public.statement_lines(v_shop, '2000-01-01', '2100-01-01')
          where section = 'net_profit') then
    raise exception 'FAIL: the balance sheet and the income statement disagree about profit';
  end if;

  -- 12. As-at bites. A balance sheet dated before any trading is empty, not
  --     the same as today's.
  if (select amount_cents from public.balance_sheet(v_shop, '2019-01-01') where section = 'total_assets') <> 0 then
    raise exception 'FAIL: a balance sheet dated before the shop existed is not empty';
  end if;
```

- [ ] **Step 2: Run it and verify it fails**

Run: `npm run test:db -- --no-reset`
Expected: `verify-statements  FAIL` — `function public.balance_sheet(uuid, date) does not exist`.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/20261001000100_balance_sheet.sql`. The structure mirrors Task 1 — a `posted` CTE filtered `e.entry_date <= p_as_of` with **no lower bound**, a `by_account` CTE flipping sign, and a union of section rows and totals. Points the implementer must get right, each of which has a check above:

- **Sign.** Assets present positive (their ledger sum is already positive). Liabilities and equity present positive too, which means **negating** their ledger sum, because they carry credit balances. A contra account within a section keeps its ledger sign after that flip, so `3100 Owner's Draw` lands negative inside equity and reduces it.
- **Fixed vs current** by `code between '1500' and '1599'`, with the comment explaining why a code range is right here and nowhere else.
- **Equity has four rows**, only two of which come from account balances: `3000 Owner's Capital` and `3100 Owner's Draw` are accounts; `Retained earnings — prior periods` is `3900`'s balance; `Profit this period` is `statement_lines()`'s net profit for the current period. Call `statement_lines()` rather than re-deriving it — a second derivation is how the two come to disagree, which is the same argument that made P&L and Income Statement one query.
- Gate on `ledger.view`, same message as Task 1.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test:db`
Expected: `verify-statements  pass`, still **29 database checks passed** (Task 2 extends the same script).

- [ ] **Step 5: Prove the test can fail**

Mutation: present liabilities without negating. Expected: check 8 fails — the two sides differ by twice the liabilities. Revert.

Mutation: `code between '1500' and '1599'` → `'1500' and '1509'`, so `1510 Furniture` becomes current. Expected: **no check reddens** — total assets is unchanged, only its split. **That is a finding.** Add a check asserting `1510` appears under `fixed_assets`, then re-run.

Mutation: re-derive profit this period as `sum(revenue) - sum(expense)` inline instead of calling `statement_lines()`. Expected: check 11 still passes, because the two happen to agree on this fixture — **a finding.** Extend the fixture with a `cost_of_sales` figure the inline version would miss, then re-run.

Mutation: drop the `e.entry_date <= p_as_of` filter. Expected: check 12 fails. Revert.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/20261001000100_balance_sheet.sql supabase/tests/verify-statements.sql
git commit -m "feat(accounting): the balance sheet, which balances because every entry does"
```

---

### Task 3: `cash_flow()` — indirect method

**Files:**
- Create: `supabase/migrations/20261001000200_cash_flow.sql`
- Modify: `supabase/tests/verify-statements.sql`

**Interfaces:**
- Consumes: `statement_lines()` (Task 1) for net profit; `balance_sheet()` (Task 2) for opening and closing cash.
- Produces:
  ```sql
  public.cash_flow(p_shop_id uuid, p_from date, p_to date)
  returns table (
    section text,   -- 'operating' | 'investing' | 'financing' | 'net_change' | 'proof'
    label text, amount_cents bigint, is_total boolean, sort_order integer
  )
  ```

**Indirect method**, from the mockup: start at net profit, add back non-cash costs, adjust for movements in working capital, then investing and financing.

```
Operating   Net profit
            Add back depreciation           (a cost, but no cash left)
            Increase in receivables         (negative)
            Increase in inventory           (negative)
            Increase in payables            (positive)
            Increase in tax & wages payable (positive)
            Cash from operations
Investing   Bought equipment
Financing   Owner drawings
Net change in cash
Proof       Cash at <from>, cash at <to>, and that the two differ by the net change
```

**The proof section is not decoration.** A cash flow whose net change does not equal the movement in the cash accounts is wrong, and the indirect method's whole risk is that it is assembled from deltas rather than observed. Emit the proof rows and let Task 5 assert them.

**"Movement in X" means X's balance at `p_to` less its balance at `p_from - 1 day`** — a range statement built from two as-at readings. Compute both from the same helper the balance sheet uses rather than a second query.

- [ ] **Step 1: Write the failing test**

Append to `verify-statements.sql`:

```sql
  -- 13. Net profit is the opening line of the operating section. Second of the
  --     five reconciliations.
  if (select amount_cents from public.cash_flow(v_shop, '2000-01-01', '2100-01-01')
       where section = 'operating' and label = 'Net profit')
     <> (select amount_cents from public.statement_lines(v_shop, '2000-01-01', '2100-01-01')
          where section = 'net_profit') then
    raise exception 'FAIL: the cash flow and the income statement disagree about net profit';
  end if;

  -- 14. THE PROOF. Net change in cash equals the movement in the cash
  --     accounts, observed rather than assembled. The indirect method's whole
  --     risk is that it is built from deltas; this is what catches a wrong one.
  if (select amount_cents from public.cash_flow(v_shop, '2000-01-01', '2100-01-01') where section = 'net_change')
     <> (select amount_cents from public.cash_flow(v_shop, '2000-01-01', '2100-01-01')
          where section = 'proof' and label = 'Movement in cash accounts') then
    raise exception 'FAIL: the cash flow does not prove out -- net change % against observed movement %',
      (select amount_cents from public.cash_flow(v_shop, '2000-01-01', '2100-01-01') where section = 'net_change'),
      (select amount_cents from public.cash_flow(v_shop, '2000-01-01', '2100-01-01')
        where section = 'proof' and label = 'Movement in cash accounts');
  end if;

  -- 15. Closing cash on the cash flow IS the balance sheet's cash. Third
  --     reconciliation, and the one that ties the statement of flows to the
  --     statement of position.
  if (select amount_cents from public.cash_flow(v_shop, '2000-01-01', '2100-01-01')
       where section = 'proof' and label like 'Cash at%' order by sort_order desc limit 1)
     <> (select coalesce(sum(amount_cents), 0) from public.balance_sheet(v_shop, public.shop_local_date())
          where code in ('1000', '1010', '1020', '1021')) then
    raise exception 'FAIL: the cash flow and the balance sheet disagree about closing cash';
  end if;
```

- [ ] **Step 2: Run it and verify it fails**

Run: `npm run test:db -- --no-reset`
Expected: `verify-statements  FAIL` — `function public.cash_flow(uuid, date, date) does not exist`.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/20261001000200_cash_flow.sql`. The shape:

- Net profit from `statement_lines(p_shop_id, p_from, p_to)`.
- Depreciation added back as `6800`'s movement over the window. **Until 3c ships `run_depreciation` this is always zero**, which is correct rather than missing — say so in a comment so nobody treats a zero as a bug.
- Working-capital movements for `1100` receivables, `1200` inventory, `2000` payables, `2100` + `2200` tax and wages. **An increase in an asset consumes cash (negative); an increase in a liability provides it (positive).** That sign convention is where an indirect cash flow most often goes wrong; state it in the comment and let check 14 catch it.
- Investing: movement in `1500`–`1589` (at cost, excluding `1590` accumulated depreciation).
- Financing: movement in `3000` and `3100`.
- Proof rows: cash at `p_from - 1 day`, cash at `p_to`, and their difference labelled `Movement in cash accounts`.
- Gate on `ledger.view`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test:db`
Expected: **29 database checks passed**.

- [ ] **Step 5: Prove the test can fail**

Mutation: make an increase in receivables positive. Expected: check 14 fails — the proof no longer ties. Revert.

Mutation: drop the investing section entirely. Expected: on this fixture nothing reddens, because the fixture buys no equipment — **a finding.** Either add a fixed-asset purchase to the fixture (a manual journal entry `Dr 1500 / Cr 1000` via `post_journal_entry`) or record explicitly that investing is unexercised until 3c and say so at the check. Do not leave it silently uncovered.

Mutation: compute opening cash at `p_from` rather than `p_from - 1 day`. Expected: check 14 fails by the first day's takings. Revert.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/20261001000200_cash_flow.sql supabase/tests/verify-statements.sql
git commit -m "feat(accounting): the cash flow, and the proof that it ties"
```

---

### Task 4: The read layer and the three screens

**Files:**
- Create: `src/lib/statements.ts`
- Create: `src/components/accounting/ledger/income-statement-view.tsx`
- Create: `src/components/accounting/ledger/balance-sheet-view.tsx`
- Create: `src/components/accounting/ledger/cash-flow-view.tsx`
- Modify: `src/components/accounting/ledger/ledger-hub.tsx` (three new cards)
- Modify: `src/app/(admin)/(tabs)/accounting.tsx` (routing, following `view=` as `backfill` and `trial` already do)
- Create: `src/components/accounting/ledger/__tests__/statements.test.tsx`

**Interfaces:**
- Consumes: `statement_lines()`, `balance_sheet()`, `cash_flow()`.
- Produces: `listStatementLines`, `getBalanceSheet`, `getCashFlow` in `src/lib/statements.ts`, each returning the row type its function returns, in order, with **no arithmetic**.

**The screens do no arithmetic.** Every subtotal is a row the function returned. A screen that sums its own rows is a second implementation of the statement, and the two will disagree the first time a rounding or an account type changes. `trial-balance-view.tsx` already works this way — copy it.

- [ ] **Step 1: Write the failing test**

Create `src/components/accounting/ledger/__tests__/statements.test.tsx`, mocking `src/lib/statements.ts`, and assert:

1. The income statement renders section rows in `sort_order` and shows the detail toggle; toggling it calls `listStatementLines` with `detail: true`.
2. **A loss renders as a loss** — `net_profit` of `-250` shows with a minus and in `bentoLoss`, not as a bare number. Pair the colour with a sign: green/red alone is ΔE 4.0 for deutan viewers, which the bento skill states as a rule.
3. The balance sheet shows both totals and a `Caveat tone="context"` stating that the equality is a consequence of every entry balancing, not a check performed afterwards.
4. The cash flow renders its proof section.
5. All three show an empty state rather than zeros when the shop has no posted entries — a shop that has never traded should not be shown a balance sheet full of `$0.00`.

- [ ] **Step 2: Run it and verify it fails**

Run: `npx jest src/components/accounting/ledger/__tests__/statements.test.tsx`
Expected: FAIL — the modules do not exist.

- [ ] **Step 3: Write `src/lib/statements.ts` and the three views**

`statements.ts` is three thin `supabase.rpc` calls returning typed rows. Follow `src/lib/ledger.ts`'s shape exactly, including its `cents` coercion — bigint arrives as a **string** over PostgREST and `Number()` on it is load-bearing; `ledger.ts:28-30` says so and Task 4 must not quietly drop it.

The views follow `trial-balance-view.tsx`: a `BentoCard` per statement section, `StatementRow` with `variant="item" | "emphasis" | "total"` for the money lines, and the hub crumb from `ledger-crumb.tsx`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx tsc --noEmit && npx jest src/components/accounting/ledger/__tests__/statements.test.tsx && npm run lint`
Expected: clean; the new suite green; lint **not above its measured baseline**.

- [ ] **Step 5: Prove the tests can fail**

Mutation: render `net_profit` without its sign. Expected: assertion 2 fails. Revert.

Mutation: have the income statement sum its own rows rather than using the returned totals. Expected: **nothing reddens** — the sums agree on the mocked data. **A finding.** Change the mock so a returned total deliberately differs from the sum of its rows, assert the screen shows the returned total, then re-run.

Mutation: drop the empty state. Expected: assertion 5 fails. Revert.

- [ ] **Step 6: Commit**

```bash
git add src/lib/statements.ts src/components/accounting/ledger/ src/app/\(admin\)/\(tabs\)/accounting.tsx
git commit -m "feat(accounting): the three statements, on the hub"
```

---

### Task 5: The five reconciliations, asserted together

**Files:**
- Modify: `supabase/tests/verify-statements.sql`
- Create: `supabase/tests/verify-statement-permissions.sql`

This task exists because Tasks 1–3 each assert their own statement. **Nothing yet asserts all five reconciliations against one fixture at once**, and a statement that is individually plausible and inconsistent with its siblings is the failure this phase must not ship.

- [ ] **Step 1: Write the failing test**

Append a final block to `verify-statements.sql` asserting, in one place, on the same fixture:

1. Income statement net profit **=** balance sheet "profit this period"
2. Income statement net profit **=** cash flow operating opening line
3. Income statement net profit **=** the trial balance's `revenue + cost_of_sales + expense` accounts netted — computed here from `journal_lines` directly, **not** by calling `statement_lines()`, so it is an independent derivation
4. Balance sheet total assets **=** total liabilities and equity
5. Cash flow closing cash **=** balance sheet cash

Each with a failure message naming both figures and their difference.

Then create `verify-statement-permissions.sql` asserting all three functions raise for a member **without** `ledger.view`, using `set_config('request.jwt.claims', ...)` and a role holding only `pos.access`. Copy the fixture shape from `verify-posting-sales.sql`, which already builds a staff member that way. Assert on the message, not a bare `others` catch, so it proves the permission gate fired and not something else.

- [ ] **Step 2: Run it and verify it fails**

Run: `npm run test:db -- --no-reset`
Expected: `verify-statement-permissions  FAIL` on the first assertion; `verify-statements` still passes (reconciliation 3 is the only new risk and should already hold).

- [ ] **Step 3: Fix whatever it finds**

If reconciliation 3 fails, the independent derivation and `statement_lines()` disagree — that is a real defect in Task 1, not a test bug. Fix Task 1's migration.

- [ ] **Step 4: Run to verify it passes**

Run: `npm run test:db`
Expected: **30 database checks passed**.

- [ ] **Step 5: Prove the tests can fail**

Mutation: in `statement_lines()`, exclude `cost_of_sales` from net profit. Expected: reconciliation 3 fails, and 1 and 2 fail with it. Revert.

Mutation: remove the `ledger.view` gate from `balance_sheet()`. Expected: `verify-statement-permissions` fails. Revert. Repeat for each of the three.

- [ ] **Step 6: Commit**

```bash
git add supabase/tests/verify-statements.sql supabase/tests/verify-statement-permissions.sql
git commit -m "test(accounting): the statements reconcile to each other, to the cent"
```

---

### Task 6: Prove it end to end

- [ ] **Step 1: Full suite**

Run: `npx tsc --noEmit && npm test && npm run lint && npm run test:db`
Expected: clean; the suite green; lint at its measured baseline; **30** database checks.

- [ ] **Step 2: In the running app**

**`.env` points the app at the remote Supabase project.** Verifying against it needs these migrations deployed, which is the human's call. Until then, run against the local stack on a separate port so the human's Metro on 8081 and their simulators are untouched:

```bash
EXPO_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321 \
EXPO_PUBLIC_SUPABASE_ANON_KEY=<the local anon key from `npx supabase status`> \
npx expo start --web --port 8082
```

Seed a shop with a sale, a stock count and two expenses; open each statement; read the figures off the screen and check they match what `verify-statements.sql` asserts.

> **`browser_click` gives false negatives on this app.** React Native Web's `Pressable` needs the full `pointerdown` / `mousedown` / `pointerup` / `mouseup` / `click` sequence. Some rows render as `<button>`, not `<div>` — select on both.

- [ ] **Step 3: Check the statements against a real shop's figures**

Once deployed, open the income statement for `yusefshop` and check gross profit against what the Reports tab says for the same range. They read different tables — the ledger versus `sale_items` — and **if they disagree, the ledger is the one to trust and the difference is the finding**. Record it rather than reconciling by eye.

---

## What this unblocks

**3b — period close.** `close_accounting_period` rolls `statement_lines()`'s net profit into `3900 Retained Earnings`, which is the line this plan leaves at zero for every shop. Auto-close and *closed with exceptions* go with it.

**3c — new transactions.** `transfer_funds`, `fixed_assets` and `run_depreciation`. Depreciation is the one that visibly changes these statements: `6800` is currently always zero, and the cash flow's add-back and the balance sheet's accumulated-depreciation line are both waiting for it.

**Phase 4 — the remaining reports**, which the design lists as sixteen. Several read the ledger and could not be built before this.
