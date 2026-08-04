# Pay cadence and pay periods — design

**Date:** 2026-08-03
**Status:** Approved, ready for planning
**Scope:** Spec 1b of the payroll sequence (see "Sequence" below)

## Problem

Three things, all rooted in the same gap: a pay run has no idea how often
anyone is actually paid.

**1. Cadence isn't modelled at all.** `shop_members` records what someone is
paid (`pay_type`, `pay_rate_cents` — monthly for salary since spec 1a) but not
how often they receive it. A shop needs the same person quoted monthly and paid
weekly, or biweekly.

**2. The exact-salary path is effectively unreachable.** `computePayrollDraft`
pays a salaried member their exact monthly figure only when the run covers a
whole calendar month (`isWholeCalendarMonth`). But `PayrollTab` seeds its period
from the Accounting date range (`payroll-tab.tsx:47-48`), which uses rolling
"last N days" presets (`accounting.tsx:72`, `initialDays={7}`). So pressing
"Build draft" *always* takes the prorated branch unless the owner hand-types
`2026-08-01` and `2026-08-31`.

For a $3,000/month member:

| Period | Before spec 1a | Now | Correct for one month |
|---|---|---|---|
| 30-day preset | $3,000.00 | $2,958.90 | ✗ |
| Aug 1–31, typed | $3,100.00 | $3,000.00 | ✓ |

The old `/30` divisor was *accidentally* exact for a 30-day preset, so for an
owner using that preset spec 1a reads as a new 1.37% underpayment. The
arithmetic is right; the reachable default is wrong.

**3. Accrual understates labour.** `accruedLaborCents` excludes salaried staff
(`payroll-reporting.ts:145-147`) on the grounds that prorating a salary across
an arbitrary stretch "would be a guess presented as a number". Spec 1a built
`dailySalaryCents` — an exact, unrounded per-day figure — so that is no longer
true. For a shop whose staff are mostly salaried, accrued wages currently reads
near zero between pay runs, understating the P&L (`reports-tab.tsx:129`) and the
cash budget (`cash-budgets-tab.tsx:115`).

## Decisions

### Cadence is per member, named, and defaults to monthly

```sql
pay_cadence text not null default 'monthly'
  check (pay_cadence in ('weekly','biweekly','semimonthly','monthly'))
```

`not null default 'monthly'` rather than nullable: every member has a cadence,
existing rows backfill, and there is no "null means monthly" convention to
remember.

A **named enum, not a count of payments per period.** A count divides the rate
period cleanly (monthly ÷ 2 = semi-monthly) but **cannot express biweekly** —
every 14 days is 26 payments a year, which is 2.17 per month. A count would
either drop biweekly or fake it as semi-monthly, which pays on different dates.

Cadence applies to hourly staff too. It is *when* someone is paid, independent
of *what* they are paid.

### The anchor is shop-level

```sql
-- on shops
pay_period_anchor date null
```

Weekly and biweekly periods need a start date — "every 14 days from *when*".
Monthly and semi-monthly key off calendar boundaries and never consult it.

Shop-level rather than per-member because a real shop pays everyone on the same
day. Per-member anchors would mean cutting a separate pay run per anchor, which
gets tedious immediately. Deriving it from hire date was rejected: staff hired on
different days drift into different cycles, producing the per-member problem
without anyone having chosen it.

Null anchor with a weekly or biweekly cadence is a defined state, not an error:
`payPeriodsFor` returns `{ periods: [], reason: 'anchor_required' }`, the picker
degrades to hand-typed dates, and the UI links to Store settings. Deliberately
not auto-defaulted to (say) the shop's creation date — a silently chosen anchor
picks everyone's pay days, which should be a deliberate act.

### Runs record their cadence

```sql
-- on payroll_runs
cadence text null check (cadence in ('weekly','biweekly','semimonthly','monthly'))
```

Set → the draft includes only members on that cadence. This is required: a
weekly run must not include a monthly member, or Bob's full month gets paid
inside Alice's week.

Null → an off-cycle run over hand-typed dates, including every active member,
exactly as today. The per-member guard catches any conflict at post time.

### Salaried staff now accrue; `fixed` still does not

Salaried members accrue at `dailySalaryCents × their uncovered days`. The
blocker was arithmetic that spec 1a built.

`fixed` stays excluded, and this is not an oversight: a flat per-run amount has
no daily rate to derive, and inventing one reintroduces exactly the "guess
presented as a number" the original design refused.

**This moves reported figures.** The P&L labour line and the cash-budget
wages-owed will both jump the first time this runs, with no underlying data
having changed. Accepted deliberately — understating labour is a real reporting
error for a mostly-salaried shop.

## Architecture

### Migrations

Two, in order:

1. **Columns** — `shop_members.pay_cadence`, `shops.pay_period_anchor`,
   `payroll_runs.cadence`, plus
   `create index payroll_run_lines_member_idx on payroll_run_lines(shop_member_id)`.
2. **`post_payroll_run`** — recreated in full with the per-member overlap guard.

Migration versions must sort after `20260804020100` (the current latest). Spec
1a shipped a migration timestamped before the table it referenced, which would
have broken a fresh `supabase db reset`; that is a live failure mode in this
project, not a hypothetical.

### `list_shop_staff` must learn about `pay_cadence`

`list_shop_staff` (migration `20260803010000`) declares an explicit return
column list and blanks pay columns for callers without `people.payroll.manage`.
A column added to the table but not to that RPC comes back **`undefined`, not
wrong-but-visible** — which would silently make every member look monthly.

`pay_cadence` is added to the RPC, gated alongside the existing pay columns.

### New module: `src/lib/pay-periods.ts`

Pure, no Supabase import, so it loads under Jest like `pay-rate.ts` and
`payroll-reporting.ts`.

```ts
type PayCadence = 'weekly' | 'biweekly' | 'semimonthly' | 'monthly';
type PayPeriod  = { start: string; end: string };
type PayPeriodResult = { periods: PayPeriod[]; reason: 'ok' | 'anchor_required' };

periodsPerYear(cadence: PayCadence): number
  // 52 | 26 | 24 | 12
perPaymentCents(monthlyCents: number, cadence: PayCadence): number
  // round(monthly x 12 / periodsPerYear)
payPeriodsFor(cadence: PayCadence, anchor: string | null, since: string, until: string): PayPeriodResult
isWholePayPeriod(cadence: PayCadence, anchor: string | null, start: string, end: string): boolean
```

Every date crossing this module's boundary is a `YYYY-MM-DD` string, matching
the Postgres `date` columns and `PayrollRun.periodStart` / `periodEnd` — not a
`Date`. Callers holding a `Date` (the Accounting range selector) convert with
`toDateColumn` at the boundary, so no timezone conversion happens inside.

Generation: monthly → calendar months intersecting the range; semi-monthly →
1st–15th and 16th–end; weekly and biweekly → 7- or 14-day blocks counted forward
from the anchor.

Two cadences collapse to exact arithmetic rather than division, which is the
payoff of spec 1a's monthly-canonical decision: **monthly** is
`monthly × 12 / 12`, the stored figure exactly; **semi-monthly** is exactly
half. Only weekly and biweekly divide.

All date handling goes through `period.ts`'s `toDateColumn` / `fromDateColumn`,
never `toISOString()`, which converts to UTC first and shifts the day for
anyone west of Greenwich.

### `computePayrollDraft`

Gains a `cadence: PayCadence | null` parameter. When set, members are filtered to
that cadence; when null, every active member is included as today.

The salary branch generalizes: `isWholePayPeriod` replaces `isWholeCalendarMonth`,
paying `perPaymentCents` exactly when the run matches a generated period, and
prorating via the existing `dailySalaryCents` when it does not.

For a monthly-cadence member over a calendar month this produces the identical
figure it produces today — **spec 1a's behaviour is a special case of this, not
a change to it.** `hourly` and `fixed` are untouched.

### The overlap guard becomes per-member

Today's check rejects any posted run whose period overlaps, shop-wide, with no
notion of who is in it (`20260804000400_payroll.sql:143-152`). Per-member cadence
requires exactly what that forbids: Bob paid monthly for Aug 1–31 and Alice
weekly for Aug 1–7 are overlapping runs that must both succeed.

```sql
select string_agg(distinct coalesce(l.member_name, 'A staff member'), ', ')
  into v_conflict_names
  from public.payroll_runs r
  join public.payroll_run_lines l on l.payroll_run_id = r.id
  where r.shop_id = v_run.shop_id
    and r.id <> v_run.id
    and r.status = 'posted'
    and r.period_start <= v_run.period_end
    and r.period_end   >= v_run.period_start
    and l.shop_member_id in (
      select shop_member_id from public.payroll_run_lines where payroll_run_id = p_run_id
    );
if v_conflict_names is not null then
  raise exception '% already paid for part of % to %', v_conflict_names, v_run.period_start, v_run.period_end;
end if;
```

**This is a loosening, and calling it anything else would be wrong.** An earlier
draft of this spec claimed it was "strictly stronger than the period-only
check". That is false. The new predicate is the old predicate plus an additional
`and l.shop_member_id in (...)` conjunct, and a conjunction can only narrow: the
set of runs rejected is a strict subset of what the period-only check rejected.
There is no input the new guard rejects that the old one accepted.

It is a deliberate, scoped narrowing, and it is required — different cadences
legitimately overlap, so a period-only check makes per-member cadence impossible.
But the cost is real and must be recorded rather than argued away.

**What it gives up.** The guard keys on `shop_member_id`. `shop_members` is
unique on `(shop_id, user_id)`, so one auth account cannot hold two rows — but
the same *human* under two accounts, or two staff records, can. Two such rows can
now both be paid over overlapping periods; the shop-wide check blocked that. This
is documented in the migration header and pinned by a test in
`verify-accounting-writes.sql`, so it is a known property rather than a
discovery waiting to happen.

The error names the people rather than the period, because overlap is now
*expected* and only the member collision is the problem.

Every existing guard — not-found, permissions, already-posted, the blocking
zero-amount check from the draft-warnings spec, and nothing-to-pay — survives
intact.

**Three deferred minor findings from the draft-warnings review are fixed here**,
because this spec rewrites the same function and touches the same lines. Fixing
them now costs nothing; deferring them again would mean spending a future
migration on a string:

- `string_agg(... order by member_name)` orders by the raw column, so a NULL
  name renders as "A staff member" but sorts last. Order by the coalesced value.
- The name list is unbounded — forty rate-less staff produce a forty-name string
  in a mobile error label. Cap it and count the remainder.
- Add `comment on function public.post_payroll_run(uuid)` recording why the row
  is locked, why overlap is checked per member, and why the expense is dated
  `period_end`. Recreating the function repeatedly leaves that rationale stranded
  in whichever migration happens to be oldest; a comment keeps it on the live
  object.

### Accrual

Coverage becomes per-member. `uncoveredDays` derives covered days from each
run's *period* (`payroll-reporting.ts:115-125`); once runs are per-member, a day
covered for Bob is not covered for Alice.

The two-call pattern collapses into one function:

```ts
accruedLaborCents(
  members: StaffMember[],
  entries: TimeEntry[],
  since: Date,
  until: Date,
  postedRuns: PayrollRun[]
) → { accruedCents: number; hours: number; fixedExcludedCount: number }
```

`since` / `until` stay `Date` here rather than becoming date strings like
`pay-periods.ts`. That is deliberate, not an inconsistency: both call sites hold
`Date` objects from the Accounting range selector and already pass them to
`uncoveredDays` today, so keeping `Date` avoids churning two call sites for no
gain. The conversion to date columns happens inside, via `toDateColumn`, exactly
as it does now.

Per-member coverage is computed internally from `run.lines`. No extra query —
`listPayrollRuns` already selects `*, payroll_run_lines(*)` (`payroll.ts:43`)
and `mapRunRow` populates them. `uncoveredDays` is removed rather than adapted;
its only callers are the two below and its own tests.

Both call sites currently nest the two calls and both get simpler:
`reports-tab.tsx:129` and `cash-budgets-tab.tsx:115`.

`salariedExcludedCount` becomes `fixedExcludedCount`. The sentence at
`reports-tab.tsx:307-308` — *"N salaried people are not included — their pay is
settled by a pay run"* — must change with it, or it states something false.

### UI

- **Pay-run creation** (`payroll-tab.tsx:47-48`) gains a cadence selector and a
  generated period list above the existing hand-typed dates, which stay for
  off-cycle runs. **The default period becomes the current calendar month**,
  which is what makes the exact-salary path reachable and closes problem 2.
- **Store settings** (`store-panel.tsx`) gains `pay_period_anchor`, shown only
  when at least one member is on weekly or biweekly.
- **`PayFields`** (`pay-fields.tsx`) gains a cadence row, defaulting to Monthly.

## Testing

New `src/lib/__tests__/pay-periods.test.ts`:

- `perPaymentCents` for all four cadences, including that monthly and
  semi-monthly are exact (no rounding) and that 12 monthly payments sum to the
  annual figure.
- Period generation across a year boundary and across a leap year.
- Semi-monthly in a 28-day and a 31-day month — the 16th–end period varies in
  length.
- Biweekly producing 26 periods a year without drifting off the anchor.
- A null anchor with weekly/biweekly returns `reason: 'anchor_required'` and no
  periods; with monthly/semi-monthly it returns periods normally.

Updated `src/lib/__tests__/payroll-reporting.test.ts`:

- A monthly-cadence member over a calendar month drafts the identical amount as
  before this spec — the regression guard on 1a's behaviour.
- The cadence filter excludes members on other cadences.
- Salaried staff now appear in accrued labour; `fixed` staff still do not.

**A test trap to handle deliberately:** the existing `uncoveredDays` tests
(`payroll-reporting.test.ts:164-197`) build run fixtures **with no lines**.
Under per-member coverage those runs cover nobody, so a naive port would leave
the tests green while asserting nothing. They must be rebuilt with lines, not
adapted.

Database tests in `supabase/tests/verify-accounting-writes.sql`:

- A same-member overlapping run is **rejected**, and the error names the member.
- A different-member overlapping run is **accepted** — the new behaviour, and
  the one most worth proving, since it is the whole reason the guard changed.
- The existing guards still fire.

## Sequence

1. **1a — Pay rate units.** Complete, pushed, migration applied to the remote.
2. **Draft warnings.** Complete, pushed. Migrations local only — see the release
   note below.
3. **This spec — Pay cadence and periods.**
4. **Staff CSV import round-trip.** `staff-import.ts:69-70` nulls
   `payType`/`payRateCents` on import, so the CSV that spec 1a taught to export
   pay no longer re-imports it. Cadence will have the same problem. Small and
   independent.
5. **Store hours**, then **team scheduling**.

**Release note carried forward:** the draft-warnings migrations
(`20260804020000`, `20260804020100`) are not yet on the remote. `createPayrollRun`
names those columns in its insert, so an app build reaching users before the
migrations reach the database fails every "Build draft" with a column-not-found
and leaves an orphan empty draft behind. This spec adds two more migrations with
the same property.

## Out of scope

- **Store hours and team scheduling** — specs 5 and 6.
- **The CSV import round-trip** — spec 4, deliberately separate.
- **Per-member pay-period anchors.** Rejected above; revisit only if a real shop
  needs staff on genuinely different pay days.
- **Retroactively rebuilding existing draft runs** when a cadence changes. Drafts
  keep the amounts they were computed with; the per-member guard catches a
  conflicting post, and a stale draft can be discarded and rebuilt.
- **Accruing `fixed` staff.** Rejected above — no daily rate exists to derive.
