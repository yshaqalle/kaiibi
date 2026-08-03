# Pay Cadence and Pay Periods Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let each staff member be paid on their own cadence, generate real pay periods from it, make the exact-salary path reachable by default, and rework the double-pay guard and labour accrual to be per-member rather than per-shop-period.

**Architecture:** A new pure module `src/lib/pay-periods.ts` owns cadence arithmetic and period generation. `shop_members.pay_cadence` and `shops.pay_period_anchor` carry the configuration; `payroll_runs.cadence` records which cadence a run was built for. `post_payroll_run`'s overlap guard becomes a member-intersection check, and `accruedLaborCents` computes coverage per member from run lines instead of per shop from run periods.

**Tech Stack:** Expo SDK 57, React Native 0.86, React 19.2, TypeScript 6.0, Jest 29 (`jest-expo`), Supabase/Postgres 17, Deno (edge functions).

**Spec:** `docs/superpowers/specs/2026-08-03-pay-cadence-and-periods-design.md`

## Global Constraints

- **Expo SDK 57.** Per `AGENTS.md`, consult https://docs.expo.dev/versions/v57.0.0/ before writing framework code. Only Task 6 touches UI, and only with primitives already imported in the files it edits.
- **Money is integer cents, rounded exactly once** at the final amount. Never round an intermediate rate — `dailySalaryCents` returns a fractional value by design.
- **Date arithmetic must be DST-safe.** Never add `n * 86400000` milliseconds to step across days: a spring-forward boundary makes that land at 23:00 the previous day, and `toDateColumn` then reports the wrong date. Use a `new Date(y, m, d + n)` helper. Never use `toISOString()` for a date column — it converts to UTC first and shifts the day west of Greenwich. Use `toDateColumn` / `fromDateColumn` from `@/lib/period`.
- **`hourly` and `fixed` pay must not change.** Tasks 3 and 4 carry explicit regression assertions.
- **A monthly-cadence member over a calendar month must draft the identical amount as before this work** — this work generalizes spec 1a's behaviour, it does not alter it.
- **Pure modules import no Supabase.** `pay-periods.ts` and `payroll-reporting.ts` must load under Jest, which has no native runtime.
- **JS test command is `npx jest`.** Baseline before this work: **12 suites / 235 tests passing**.
- **`npx tsc --noEmit`** clean; **`npx expo lint`** has **42 known pre-existing problems (38 errors, 4 warnings)** and must gain none.
- **Migrations must sort after `20260804020100`**, the current latest. Spec 1a shipped a migration timestamped before the table it referenced, which would have broken a fresh reset — a live failure mode in this project.
- **Database work is local only.** The stack is running; `DB_URL` is `postgresql://postgres:postgres@127.0.0.1:54322/postgres`. **Never run `supabase db push`** — that targets the remote production project.
- **Database verification command:**
  `supabase db reset && psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -f supabase/tests/verify-accounting-writes.sql`
  A pass ends with `################  ALL CHECKS PASSED  ################` and `Rolled back — no rows left behind.`

---

### Task 1: `pay-periods.ts` — cadence arithmetic and period generation

**Files:**
- Create: `src/lib/pay-periods.ts`
- Create: `src/lib/__tests__/pay-periods.test.ts`

**Interfaces:**
- Consumes: `annualCents` from `@/lib/pay-rate`; `fromDateColumn`, `toDateColumn` from `@/lib/period`.
- Produces, relied on by Tasks 2–6:
  ```ts
  type PayCadence = 'weekly' | 'biweekly' | 'semimonthly' | 'monthly'
  type PayPeriod = { start: string; end: string }
  type PayPeriodResult = { periods: PayPeriod[]; reason: 'ok' | 'anchor_required' }
  periodsPerYear(cadence: PayCadence): number
  perPaymentCents(monthlyCents: number, cadence: PayCadence): number
  payPeriodsFor(cadence: PayCadence, anchor: string | null, since: string, until: string): PayPeriodResult
  isWholePayPeriod(cadence: PayCadence, anchor: string | null, start: string, end: string): boolean
  ```
  Every date crossing this boundary is a `YYYY-MM-DD` string, never a `Date`.

- [ ] **Step 1: Write the failing tests**

Create `src/lib/__tests__/pay-periods.test.ts`:

```ts
import {
  isWholePayPeriod,
  payPeriodsFor,
  perPaymentCents,
  periodsPerYear,
} from '@/lib/pay-periods';

describe('periodsPerYear', () => {
  it('counts real payment dates, not month divisions', () => {
    expect(periodsPerYear('weekly')).toBe(52);
    expect(periodsPerYear('biweekly')).toBe(26);
    expect(periodsPerYear('semimonthly')).toBe(24);
    expect(periodsPerYear('monthly')).toBe(12);
  });
});

describe('perPaymentCents', () => {
  // The payoff of storing salary as monthly: the common case needs no
  // division at all, so it cannot drift.
  it('is the stored figure exactly for a monthly cadence', () => {
    expect(perPaymentCents(300000, 'monthly')).toBe(300000);
  });

  it('is exactly half for a semi-monthly cadence', () => {
    expect(perPaymentCents(300000, 'semimonthly')).toBe(150000);
  });

  it('divides the annual figure for weekly and biweekly', () => {
    expect(perPaymentCents(300000, 'weekly')).toBe(69231);
    expect(perPaymentCents(300000, 'biweekly')).toBe(138462);
  });

  // 26 biweekly payments must add up to the year, not to 24 months.
  it('keeps a year of payments close to the annual figure', () => {
    expect(perPaymentCents(300000, 'biweekly') * 26).toBe(3600012);
    expect(perPaymentCents(300000, 'monthly') * 12).toBe(3600000);
  });
});

describe('payPeriodsFor — monthly', () => {
  it('returns whole calendar months', () => {
    const { periods, reason } = payPeriodsFor('monthly', null, '2026-08-01', '2026-09-30');
    expect(reason).toBe('ok');
    expect(periods).toEqual([
      { start: '2026-08-01', end: '2026-08-31' },
      { start: '2026-09-01', end: '2026-09-30' },
    ]);
  });

  it('returns the containing month even for a partial range', () => {
    const { periods } = payPeriodsFor('monthly', null, '2026-08-10', '2026-08-12');
    expect(periods).toEqual([{ start: '2026-08-01', end: '2026-08-31' }]);
  });

  it('needs no anchor', () => {
    expect(payPeriodsFor('monthly', null, '2026-08-01', '2026-08-31').reason).toBe('ok');
  });
});

describe('payPeriodsFor — semimonthly', () => {
  // The second half varies in length; the first never does.
  it('splits a 31-day month at the 15th', () => {
    const { periods } = payPeriodsFor('semimonthly', null, '2026-08-01', '2026-08-31');
    expect(periods).toEqual([
      { start: '2026-08-01', end: '2026-08-15' },
      { start: '2026-08-16', end: '2026-08-31' },
    ]);
  });

  it('splits a 28-day February at the 15th', () => {
    const { periods } = payPeriodsFor('semimonthly', null, '2026-02-01', '2026-02-28');
    expect(periods).toEqual([
      { start: '2026-02-01', end: '2026-02-15' },
      { start: '2026-02-16', end: '2026-02-28' },
    ]);
  });

  it('handles a leap February', () => {
    const { periods } = payPeriodsFor('semimonthly', null, '2024-02-01', '2024-02-29');
    expect(periods[1]).toEqual({ start: '2024-02-16', end: '2024-02-29' });
  });
});

describe('payPeriodsFor — weekly and biweekly', () => {
  it('counts forward from the anchor', () => {
    const { periods } = payPeriodsFor('weekly', '2026-08-03', '2026-08-03', '2026-08-23');
    expect(periods).toEqual([
      { start: '2026-08-03', end: '2026-08-09' },
      { start: '2026-08-10', end: '2026-08-16' },
      { start: '2026-08-17', end: '2026-08-23' },
    ]);
  });

  it('uses 14-day blocks when biweekly', () => {
    const { periods } = payPeriodsFor('biweekly', '2026-08-03', '2026-08-03', '2026-08-30');
    expect(periods).toEqual([
      { start: '2026-08-03', end: '2026-08-16' },
      { start: '2026-08-17', end: '2026-08-30' },
    ]);
  });

  // The anchor may predate the range by years; periods must still land on the
  // anchor's rhythm rather than restarting at the range boundary.
  it('keeps the anchor rhythm when the range starts much later', () => {
    // 2026-01-05 + 14n lands on Jul 20, then Aug 3. The period containing
    // Aug 1 is therefore Jul 20 - Aug 2, NOT a period restarting on Aug 1.
    const { periods } = payPeriodsFor('biweekly', '2026-01-05', '2026-08-01', '2026-08-20');
    expect(periods[0]).toEqual({ start: '2026-07-20', end: '2026-08-02' });
    expect(periods[1]).toEqual({ start: '2026-08-03', end: '2026-08-16' });
    expect(periods[2]).toEqual({ start: '2026-08-17', end: '2026-08-30' });
  });

  it('works when the anchor is after the range', () => {
    const { periods } = payPeriodsFor('weekly', '2026-08-31', '2026-08-03', '2026-08-16');
    expect(periods).toEqual([
      { start: '2026-08-03', end: '2026-08-09' },
      { start: '2026-08-10', end: '2026-08-16' },
    ]);
  });

  // Crossing a year boundary must not restart the count.
  it('crosses a year boundary without drifting', () => {
    const { periods } = payPeriodsFor('biweekly', '2026-12-07', '2026-12-07', '2027-01-17');
    expect(periods).toEqual([
      { start: '2026-12-07', end: '2026-12-20' },
      { start: '2026-12-21', end: '2027-01-03' },
      { start: '2027-01-04', end: '2027-01-17' },
    ]);
  });

  it('reports that an anchor is required rather than guessing', () => {
    expect(payPeriodsFor('weekly', null, '2026-08-01', '2026-08-31')).toEqual({
      periods: [],
      reason: 'anchor_required',
    });
    expect(payPeriodsFor('biweekly', null, '2026-08-01', '2026-08-31').reason).toBe('anchor_required');
  });
});

describe('isWholePayPeriod', () => {
  it('accepts a calendar month for a monthly cadence', () => {
    expect(isWholePayPeriod('monthly', null, '2026-08-01', '2026-08-31')).toBe(true);
  });

  it('rejects a part month for a monthly cadence', () => {
    expect(isWholePayPeriod('monthly', null, '2026-08-01', '2026-08-07')).toBe(false);
  });

  it('accepts either half for a semi-monthly cadence', () => {
    expect(isWholePayPeriod('semimonthly', null, '2026-08-01', '2026-08-15')).toBe(true);
    expect(isWholePayPeriod('semimonthly', null, '2026-08-16', '2026-08-31')).toBe(true);
  });

  it('accepts an anchored biweekly block', () => {
    expect(isWholePayPeriod('biweekly', '2026-08-03', '2026-08-03', '2026-08-16')).toBe(true);
    expect(isWholePayPeriod('biweekly', '2026-08-03', '2026-08-03', '2026-08-15')).toBe(false);
  });

  it('is false when the anchor is missing', () => {
    expect(isWholePayPeriod('weekly', null, '2026-08-03', '2026-08-09')).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest src/lib/__tests__/pay-periods.test.ts`
Expected: FAIL — `Cannot find module '@/lib/pay-periods'`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/pay-periods.ts`:

```ts
import { annualCents } from '@/lib/pay-rate';
import { fromDateColumn, toDateColumn } from '@/lib/period';

// How often someone is paid, and what the pay periods actually are.
//
// Cadence is separate from the pay rate on purpose: `pay_rate_cents` says what
// a salaried member earns per month (see pay-rate.ts), and this says how often
// they receive it. The same person can be quoted monthly and paid weekly.

export type PayCadence = 'weekly' | 'biweekly' | 'semimonthly' | 'monthly';

export type PayPeriod = { start: string; end: string };

// `anchor_required` is a defined state, not an error: weekly and biweekly
// cycles need a start date, and guessing one would silently pick everybody's
// pay days. The caller degrades to hand-typed dates and asks for the anchor.
export type PayPeriodResult = { periods: PayPeriod[]; reason: 'ok' | 'anchor_required' };

// Real payment dates per year, not divisions of a month. This is why cadence
// is a named enum rather than a count: biweekly is 26 payments a year, which
// is 2.17 a month -- a count could not express it.
export function periodsPerYear(cadence: PayCadence): number {
  switch (cadence) {
    case 'weekly':
      return 52;
    case 'biweekly':
      return 26;
    case 'semimonthly':
      return 24;
    case 'monthly':
      return 12;
  }
}

// What one payment is worth. Monthly collapses to the stored figure with no
// division at all -- the payoff of storing salary as monthly rather than
// annual, since the common case then cannot drift.
export function perPaymentCents(monthlyCents: number, cadence: PayCadence): number {
  return Math.round(annualCents(monthlyCents) / periodsPerYear(cadence));
}

// Stepping by whole local days. Deliberately NOT `time + n * 86400000`:
// across a daylight-saving boundary that lands at 23:00 the previous day, and
// toDateColumn would then report the wrong date.
function addDays(date: Date, days: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

function lastDayOfMonth(year: number, month: number): number {
  // Day 0 of the next month is the last day of this one.
  return new Date(year, month + 1, 0).getDate();
}

// Every pay period overlapping [since, until]. Periods are whole and aligned to
// the cadence, so a range landing mid-period still returns that whole period --
// callers want the period to pay, not the slice of it inside their window.
export function payPeriodsFor(
  cadence: PayCadence,
  anchor: string | null,
  since: string,
  until: string
): PayPeriodResult {
  const rangeStart = fromDateColumn(since);
  const rangeEnd = fromDateColumn(until);

  if (cadence === 'monthly' || cadence === 'semimonthly') {
    const periods: PayPeriod[] = [];
    let year = rangeStart.getFullYear();
    let month = rangeStart.getMonth();
    while (
      year < rangeEnd.getFullYear() ||
      (year === rangeEnd.getFullYear() && month <= rangeEnd.getMonth())
    ) {
      const last = lastDayOfMonth(year, month);
      if (cadence === 'monthly') {
        periods.push({
          start: toDateColumn(new Date(year, month, 1)),
          end: toDateColumn(new Date(year, month, last)),
        });
      } else {
        periods.push({
          start: toDateColumn(new Date(year, month, 1)),
          end: toDateColumn(new Date(year, month, 15)),
        });
        periods.push({
          start: toDateColumn(new Date(year, month, 16)),
          end: toDateColumn(new Date(year, month, last)),
        });
      }
      month += 1;
      if (month > 11) {
        month = 0;
        year += 1;
      }
    }
    return { periods, reason: 'ok' };
  }

  if (!anchor) return { periods: [], reason: 'anchor_required' };

  const step = cadence === 'weekly' ? 7 : 14;
  // Walk to the period containing rangeStart rather than computing an index
  // from a millisecond difference -- the difference is not a whole number of
  // days across a DST boundary, so the arithmetic would be off by one.
  let cursor = fromDateColumn(anchor);
  while (cursor.getTime() > rangeStart.getTime()) cursor = addDays(cursor, -step);
  while (addDays(cursor, step - 1).getTime() < rangeStart.getTime()) cursor = addDays(cursor, step);

  const periods: PayPeriod[] = [];
  while (cursor.getTime() <= rangeEnd.getTime()) {
    periods.push({ start: toDateColumn(cursor), end: toDateColumn(addDays(cursor, step - 1)) });
    cursor = addDays(cursor, step);
  }
  return { periods, reason: 'ok' };
}

// Whether a run's dates are exactly one pay period. A salaried member gets
// their full per-payment figure for a whole period and a prorated one
// otherwise, so this is what decides between exact and approximate.
export function isWholePayPeriod(
  cadence: PayCadence,
  anchor: string | null,
  start: string,
  end: string
): boolean {
  // Generating over the single start day yields the period(s) containing it --
  // for semi-monthly that is both halves of the month, and the match below
  // picks the right one.
  const { periods } = payPeriodsFor(cadence, anchor, start, start);
  return periods.some((period) => period.start === start && period.end === end);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx jest src/lib/__tests__/pay-periods.test.ts`
Expected: PASS, 22 tests.

- [ ] **Step 5: Full suite and typecheck**

Run: `npx jest && npx tsc --noEmit`
Expected: `Test Suites: 13 passed, 13 total`, `Tests: 257 passed` (235 + 22). No TypeScript output.

- [ ] **Step 6: Commit**

```bash
git add src/lib/pay-periods.ts src/lib/__tests__/pay-periods.test.ts
git commit -m "feat: add pay-periods module for cadence arithmetic

Cadence is a named enum rather than a count of payments per month
because biweekly is 26 payments a year -- 2.17 a month -- which a count
cannot express without becoming semi-monthly, which pays on different
dates.

Period stepping uses whole-day date arithmetic rather than millisecond
addition: across a daylight-saving boundary the latter lands at 23:00 the
previous day, and the date column would then be wrong."
```

---

### Task 2: Cadence in the database and the data layer

**Files:**
- Create: `supabase/migrations/20260804030000_pay_cadence.sql`
- Modify: `src/types/models.ts` (`Shop`, `StaffMember`, `PayrollRun`)
- Modify: `src/lib/staff.ts:63-77` (`mapStaffRow`), `:113-126` (`updateStaffPay`), `:137-142` (`updateStaffMember`)
- Modify: `src/lib/shops.ts:17` (row mapping), `:107` and `:125` (update input)
- Modify: `src/lib/payroll.ts:25-41` (`mapRunRow`), `:58-70` (`createPayrollRun`)
- Modify: `supabase/functions/update-staff/index.ts:11-12, 31, 55, 71`

**Interfaces:**
- Consumes: `PayCadence` from `@/lib/pay-periods` (Task 1).
- Produces, relied on by Tasks 3–6:
  ```ts
  StaffMember.payCadence: PayCadence          // never null; defaults to 'monthly'
  Shop.payPeriodAnchor: string | null         // YYYY-MM-DD
  PayrollRun.cadence: PayCadence | null       // null = off-cycle run
  updateStaffPay(memberId, { hireDate?, payType?, payRateCents?, payCadence? })
  createPayrollRun(shopId, periodStart, periodEnd, lines, cadence: PayCadence | null)
  ```

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/20260804030000_pay_cadence.sql`:

```sql
-- How often someone is paid, which the schema had no way to express: shop_members
-- recorded what a member earns (pay_type, pay_rate_cents -- monthly for salary)
-- but not the rhythm they receive it on. A shop needs the same person quoted
-- monthly and paid weekly or biweekly.
--
-- pay_cadence is `not null default 'monthly'` rather than nullable so every
-- member has a cadence, existing rows backfill, and there is no "null means
-- monthly" convention to remember. It applies to hourly staff too: cadence is
-- WHEN you are paid, independent of WHAT you are paid.

alter table public.shop_members
  add column pay_cadence text not null default 'monthly'
  check (pay_cadence in ('weekly','biweekly','semimonthly','monthly'));

comment on column public.shop_members.pay_cadence is
  'How often this member is paid. Independent of pay_type and pay_rate_cents, which say what they earn.';

-- Weekly and biweekly cycles need a start date -- "every 14 days from WHEN".
-- Shop-level because a real shop pays everyone on the same day; per-member
-- anchors would mean cutting a separate pay run per anchor. Null until the
-- owner sets one: a silently defaulted anchor would pick everybody's pay days.
-- Monthly and semi-monthly key off calendar boundaries and never read it.
alter table public.shops add column pay_period_anchor date null;

comment on column public.shops.pay_period_anchor is
  'Start date the weekly/biweekly pay cycles count from. Unused by monthly and semi-monthly cadences.';

-- Which cadence a run was built for. Set => the draft included only members on
-- that cadence. Null => an off-cycle run over hand-typed dates covering every
-- active member, which is how every run before this migration was built.
alter table public.payroll_runs
  add column cadence text null
  check (cadence in ('weekly','biweekly','semimonthly','monthly'));

-- post_payroll_run's overlap guard becomes a member-intersection check, which
-- scans payroll_run_lines by member. Only payroll_run_id is indexed today.
create index payroll_run_lines_member_idx on public.payroll_run_lines(shop_member_id);

-- list_shop_staff declares an explicit return column list and blanks pay
-- columns for callers without people.payroll.manage. A column added to the
-- table but not to this function comes back as undefined rather than
-- wrong-but-visible -- which would silently make every member look monthly.
-- Recreated in full, matching this file's convention of replacing rather than
-- patching. pay_cadence is gated with the other pay columns.
create or replace function public.list_shop_staff(p_shop_id uuid)
returns table (
  id uuid,
  shop_id uuid,
  user_id uuid,
  role_id uuid,
  role_name text,
  active boolean,
  full_name text,
  email text,
  created_at timestamptz,
  hire_date date,
  pay_type text,
  pay_rate_cents integer,
  pay_cadence text
)
language plpgsql security definer stable set search_path = public as $$
declare
  v_can_see_pay boolean;
begin
  if not public.has_any_shop_permission(
    p_shop_id,
    array['staff.manage', 'people.payroll.manage', 'people.timesheet.view', 'people.timeoff.approve']
  ) then
    raise exception 'not authorized for shop %', p_shop_id;
  end if;

  v_can_see_pay := public.has_shop_permission(p_shop_id, 'people.payroll.manage');

  return query
    select
      m.id,
      m.shop_id,
      m.user_id,
      m.role_id,
      coalesce(r.name, '') as role_name,
      m.active,
      m.full_name,
      m.email,
      m.created_at,
      m.hire_date,
      case when v_can_see_pay then m.pay_type else null end as pay_type,
      case when v_can_see_pay then m.pay_rate_cents else null end as pay_rate_cents,
      case when v_can_see_pay then m.pay_cadence else null end as pay_cadence
    from public.shop_members m
      left join public.roles r on r.id = m.role_id
    where m.shop_id = p_shop_id
    order by m.created_at;
end;
$$;

grant execute on function public.list_shop_staff(uuid) to authenticated;
```

- [ ] **Step 2: Apply locally and confirm the chain builds from scratch**

Run: `supabase db reset`
Expected: ends `Finished supabase db reset.` with no error.

- [ ] **Step 3: Add the types**

In `src/types/models.ts`, add the import at the top:

```ts
import type { PayCadence } from '@/lib/pay-periods';
```

Add to `Shop`, after `monthlyRevenueGoalCents`:

```ts
  // Start date the weekly/biweekly pay cycles count from. Null until set; the
  // period picker asks for it rather than guessing, because a defaulted anchor
  // would silently choose everyone's pay days.
  payPeriodAnchor: string | null;
```

Add to `StaffMember`, after `payRateCents`:

```ts
  // How often they're paid, independent of what they're paid. Applies to
  // hourly staff too.
  payCadence: PayCadence;
```

Add to `PayrollRun`, after `status`:

```ts
  // Which cadence this run was built for; null for an off-cycle run over
  // hand-typed dates, which includes every active member.
  cadence: PayCadence | null;
```

- [ ] **Step 4: Map and write the new columns**

In `src/lib/staff.ts`, add to `mapStaffRow`'s returned object after `payRateCents`:

```ts
    // The RPC blanks pay columns for callers without people.payroll.manage, so
    // this can arrive null; 'monthly' is the schema default and the safe read.
    payCadence: (row.pay_cadence ?? 'monthly') as StaffMember['payCadence'],
```

Change `updateStaffPay`'s signature and body:

```ts
export async function updateStaffPay(
  memberId: string,
  patch: {
    hireDate?: string | null;
    payType?: StaffMember['payType'];
    payRateCents?: number | null;
    payCadence?: StaffMember['payCadence'];
  }
): Promise<void> {
  const { error } = await supabase
    .from('shop_members')
    .update({
      ...(patch.hireDate !== undefined && { hire_date: patch.hireDate }),
      ...(patch.payType !== undefined && { pay_type: patch.payType }),
      ...(patch.payRateCents !== undefined && { pay_rate_cents: patch.payRateCents }),
      ...(patch.payCadence !== undefined && { pay_cadence: patch.payCadence }),
    })
    .eq('id', memberId);
  if (error) throw error;
}
```

Add `payCadence?: StaffMember['payCadence'];` to `updateStaffMember`'s `input` type, alongside the existing `payType` / `payRateCents` fields.

In `src/lib/shops.ts`, add to the row mapping after `monthlyRevenueGoalCents`:

```ts
    payPeriodAnchor: row.pay_period_anchor,
```

Add `payPeriodAnchor: string | null;` to the `updateShop` input type, and to its update object:

```ts
      ...(input.payPeriodAnchor !== undefined && { pay_period_anchor: input.payPeriodAnchor }),
```

In `src/lib/payroll.ts`, add to `mapRunRow` after `status`:

```ts
    cadence: row.cadence,
```

Change `createPayrollRun` to take and store the cadence:

```ts
export async function createPayrollRun(
  shopId: string,
  periodStart: string,
  periodEnd: string,
  lines: PayrollDraftLine[],
  cadence: PayrollRun['cadence']
): Promise<PayrollRun> {
  const { data: userData } = await supabase.auth.getUser();
  const { data, error } = await supabase
    .from('payroll_runs')
    .insert({
      shop_id: shopId,
      period_start: periodStart,
      period_end: periodEnd,
      cadence,
      created_by: userData.user?.id ?? null,
    })
    .select('*')
    .single();
  if (error) throw error;
```

(the rest of the function is unchanged)

- [ ] **Step 5: Teach the edge function about cadence**

In `supabase/functions/update-staff/index.ts`, add to the request body type alongside `payRateCents`:

```ts
  payCadence?: 'weekly' | 'biweekly' | 'semimonthly' | 'monthly';
```

Add `payCadence` to the destructuring on line 31, include it in the `editsPayroll` condition:

```ts
  const editsPayroll = hireDate !== undefined || payType !== undefined || payRateCents !== undefined || payCadence !== undefined;
```

and add it to the payroll fields written in the update:

```ts
    ...(editsPayroll ? { hire_date: hireDate ?? null, pay_type: payType ?? null, pay_rate_cents: payRateCents ?? null, pay_cadence: payCadence ?? 'monthly' } : {})
```

`?? 'monthly'` rather than `?? null` because the column is `not null` — a null would be rejected by the database.

- [ ] **Step 6: Fix the one call site that now needs an argument**

`createPayrollRun` gained a required parameter, so `src/components/accounting/payroll-tab.tsx:105` no longer typechecks. Pass `null` for now — Task 6 replaces this with the picked cadence:

```ts
      const created = await createPayrollRun(shop.id, periodStart, periodEnd, lines, null);
```

- [ ] **Step 7: Verify**

Run: `npx jest && npx tsc --noEmit && npx expo lint`
Expected: `Test Suites: 13 passed`, `Tests: 257 passed`; no TypeScript output; lint at 42 problems, no new ones.

- [ ] **Step 8: Commit**

```bash
git add supabase/migrations/20260804030000_pay_cadence.sql src/types/models.ts src/lib/staff.ts src/lib/shops.ts src/lib/payroll.ts supabase/functions/update-staff/index.ts "src/components/accounting/payroll-tab.tsx"
git commit -m "feat: model pay cadence and the pay-period anchor

pay_cadence is not-null-default-monthly so every member has one and there
is no null-means-monthly convention. The shop-level anchor stays null
until set: a defaulted anchor would silently pick everyone's pay days.

list_shop_staff is recreated to return pay_cadence, gated with the other
pay columns. Its return list is explicit, so a column added to the table
but not to the function comes back undefined rather than wrong-but-visible
-- which would have made every member look monthly."
```

---

### Task 3: Pay the cadence's period, and filter the draft by it

**Files:**
- Modify: `src/lib/payroll-reporting.ts:1-4` (imports), `:30-40` (signature), `:41-44` (member filter), `:78-103` (salary branch)
- Modify: `src/lib/__tests__/payroll-reporting.test.ts`

**Interfaces:**
- Consumes: `PayCadence`, `isWholePayPeriod`, `perPaymentCents` from `@/lib/pay-periods` (Task 1); `StaffMember.payCadence` from Task 2.
- Produces:
  ```ts
  computePayrollDraft(
    members: StaffMember[],
    entries: TimeEntry[],
    periodStart: string,
    periodEnd: string,
    cadence: PayCadence | null,
    anchor: string | null
  ): PayrollDraftLine[]
  ```

- [ ] **Step 1: Write the failing tests**

The existing test file calls `computePayrollDraft` with four arguments throughout. Add the two new arguments to **every existing call** as `, null, null` — that reproduces today's behaviour (no cadence filter, no anchor) and every existing assertion must still pass unchanged. Then append these tests to the `describe('computePayrollDraft', ...)` block:

```ts
  // The headline guarantee of this change: adding cadence must not move the
  // figure a monthly member already gets for a calendar month.
  it('pays a monthly-cadence member the same as before for a calendar month', () => {
    const lines = computePayrollDraft(
      [makeMember({ payType: 'salary', payRateCents: 300000, payCadence: 'monthly' })],
      [],
      '2026-08-01',
      '2026-08-31',
      'monthly',
      null
    );
    expect(lines[0].amountCents).toBe(300000);
    expect(lines[0].warning).toBeNull();
  });

  it('pays half a month for a whole semi-monthly period', () => {
    const lines = computePayrollDraft(
      [makeMember({ payType: 'salary', payRateCents: 300000, payCadence: 'semimonthly' })],
      [],
      '2026-08-01',
      '2026-08-15',
      'semimonthly',
      null
    );
    expect(lines[0].amountCents).toBe(150000);
    expect(lines[0].warning).toBeNull();
  });

  it('pays a whole biweekly period from the anchor', () => {
    const lines = computePayrollDraft(
      [makeMember({ payType: 'salary', payRateCents: 300000, payCadence: 'biweekly' })],
      [],
      '2026-08-03',
      '2026-08-16',
      'biweekly',
      '2026-08-03'
    );
    expect(lines[0].amountCents).toBe(138462);
    expect(lines[0].warning).toBeNull();
  });

  // A run that doesn't line up with the cadence is still an approximation and
  // still asks for a human check.
  it('prorates and warns when the run is not a whole period', () => {
    const lines = computePayrollDraft(
      [makeMember({ payType: 'salary', payRateCents: 300000, payCadence: 'monthly' })],
      [],
      '2026-08-01',
      '2026-08-07',
      'monthly',
      null
    );
    expect(lines[0].amountCents).toBe(69041);
    expect(lines[0].warning).toMatch(/Prorated for 7 days/);
  });

  it('includes only members on the run cadence', () => {
    const lines = computePayrollDraft(
      [
        makeMember({ id: 'weekly-1', payCadence: 'weekly' }),
        makeMember({ id: 'monthly-1', payCadence: 'monthly' }),
      ],
      [],
      '2026-08-01',
      '2026-08-31',
      'monthly',
      null
    );
    expect(lines).toHaveLength(1);
    expect(lines[0].shopMemberId).toBe('monthly-1');
  });

  it('includes every active member when the run has no cadence', () => {
    const lines = computePayrollDraft(
      [
        makeMember({ id: 'weekly-1', payCadence: 'weekly' }),
        makeMember({ id: 'monthly-1', payCadence: 'monthly' }),
      ],
      [],
      '2026-08-01',
      '2026-08-31',
      null,
      null
    );
    expect(lines).toHaveLength(2);
  });
```

Also add `payCadence: 'monthly',` to the `makeMember` helper's default object, after `payRateCents`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest src/lib/__tests__/payroll-reporting.test.ts`
Expected: FAIL — the new tests get the old behaviour (the semi-monthly case returns a prorated figure rather than 150000, and both filter tests return 2 lines). TypeScript will also flag the extra arguments.

- [ ] **Step 3: Wire in the cadence**

In `src/lib/payroll-reporting.ts`, add to the imports:

```ts
import { isWholePayPeriod, perPaymentCents, type PayCadence } from '@/lib/pay-periods';
```

Change the signature and add the filter:

```ts
export function computePayrollDraft(
  members: StaffMember[],
  entries: TimeEntry[],
  periodStart: string,
  periodEnd: string,
  cadence: PayCadence | null,
  anchor: string | null
): PayrollDraftLine[] {
  const days = periodDayCount(periodStart, periodEnd);
  const entriesByMember = groupEntriesByMember(entries, periodStart, periodEnd);

  return members
    // A cadence-less run is off-cycle over hand-typed dates and covers
    // everyone; a cadence run must not sweep in a member paid on a different
    // rhythm, or their whole month lands inside someone else's week.
    .filter((member) => member.active && (cadence === null || member.payCadence === cadence))
```

Replace the whole-month check in the salary branch (currently `if (isWholeCalendarMonth(periodStart, periodEnd))`) with:

```ts
      // A run matching the member's own cadence period pays the exact
      // per-payment figure -- no proration, nothing for a human to check.
      const memberCadence = cadence ?? member.payCadence;
      if (isWholePayPeriod(memberCadence, anchor, periodStart, periodEnd)) {
        return {
          ...base,
          amountCents: perPaymentCents(member.payRateCents, memberCadence),
          warning: null,
          warningBlocking: false,
        };
      }
```

Remove `isWholeCalendarMonth` from the `@/lib/pay-rate` import if it is now unused there — check with `grep -n isWholeCalendarMonth src/`. Leave the function in `pay-rate.ts`; it is still exported and tested there.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx jest src/lib/__tests__/payroll-reporting.test.ts`
Expected: PASS.

- [ ] **Step 5: Full verification**

Run: `npx jest && npx tsc --noEmit`
Expected: `Test Suites: 13 passed`, `Tests: 263 passed` (257 + 6). No TypeScript output.

`payroll-tab.tsx:104` calls `computePayrollDraft` with four arguments and will fail typecheck. Add `, null, null` there — Task 6 replaces it with the picked cadence and the shop anchor.

- [ ] **Step 6: Commit**

```bash
git add src/lib/payroll-reporting.ts src/lib/__tests__/payroll-reporting.test.ts "src/components/accounting/payroll-tab.tsx"
git commit -m "feat: pay the cadence's period, and filter the draft by cadence

A run matching the member's cadence period now pays the exact per-payment
figure; anything else still prorates and warns. A monthly member over a
calendar month gets the identical amount as before -- the previous
behaviour is a special case of this, not a change to it.

A cadence run includes only members on that cadence, so a monthly
member's whole month can't land inside someone else's week."
```

---

### Task 4: Accrual becomes per-member, and salaried staff accrue

**Files:**
- Modify: `src/lib/payroll-reporting.ts:110-160` (replace `uncoveredDays` and `accruedLaborCents`)
- Modify: `src/lib/__tests__/payroll-reporting.test.ts:164-245` (rebuild both describes)
- Modify: `src/components/accounting/reports-tab.tsx:35-41` (type), `:129` (call), `:307-308` (copy)
- Modify: `src/components/accounting/cash-budgets-tab.tsx:115` (call)

**Interfaces:**
- Consumes: `dailySalaryCents` from `@/lib/pay-rate`.
- Produces:
  ```ts
  accruedLaborCents(
    members: StaffMember[],
    entries: TimeEntry[],
    since: Date,
    until: Date,
    postedRuns: PayrollRun[]
  ): { accruedCents: number; hours: number; fixedExcludedCount: number }
  ```
  `uncoveredDays` is **removed**. Its only callers are the two components and its own tests.

- [ ] **Step 1: Rebuild the tests**

Replace the entire `describe('uncoveredDays', ...)` and `describe('accruedLaborCents', ...)` blocks with the following.

**Read this before writing it:** the old fixtures built runs with **no lines**. Under per-member coverage a run with no lines covers nobody, so porting those fixtures unchanged would leave the tests green while asserting nothing. Every run fixture below therefore has lines.

```ts
function makeRun(
  periodStart: string,
  periodEnd: string,
  memberIds: string[],
  status: PayrollRun['status'] = 'posted'
): PayrollRun {
  return {
    id: `${periodStart}-${periodEnd}`,
    shopId: 'shop1',
    periodStart,
    periodEnd,
    status,
    cadence: null,
    totalCents: 0,
    expenseId: null,
    postedAt: null,
    postedBy: null,
    createdBy: null,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    lines: memberIds.map((memberId, index) => ({
      id: `${periodStart}-${memberId}-${index}`,
      payrollRunId: `${periodStart}-${periodEnd}`,
      shopMemberId: memberId,
      memberName: memberId,
      payType: 'hourly' as const,
      payRateCents: 500,
      hoursWorked: null,
      amountCents: 1000,
      note: null,
      warning: null,
      warningBlocking: false,
      createdAt: '2026-08-01T00:00:00.000Z',
    })),
  };
}

describe('accruedLaborCents', () => {
  const hourly = makeMember({ id: 'm1', payType: 'hourly', payRateCents: 500 });
  const since = new Date(2026, 7, 1);
  const until = new Date(2026, 7, 3);

  it('values hours on days no posted run covers', () => {
    const result = accruedLaborCents(
      [hourly],
      [makeEntry('2026-08-01', 8), makeEntry('2026-08-02', 4)],
      since,
      until,
      []
    );
    expect(result.hours).toBe(12);
    expect(result.accruedCents).toBe(6000);
  });

  // The invariant the whole accrual design rests on: once a run is posted, its
  // days stop accruing, so the expense row and the accrual can't overlap.
  it('drops the days a posted run covers for that member', () => {
    const runs = [makeRun('2026-08-01', '2026-08-01', ['m1'])];
    const result = accruedLaborCents(
      [hourly],
      [makeEntry('2026-08-01', 8), makeEntry('2026-08-02', 4)],
      since,
      until,
      runs
    );
    expect(result.accruedCents).toBe(2000);
  });

  // The reason coverage had to become per-member: a run that paid Bob says
  // nothing about whether Alice has been paid.
  it('does not let one member’s run cover another member', () => {
    const alice = makeMember({ id: 'alice', payType: 'hourly', payRateCents: 500 });
    const runs = [makeRun('2026-08-01', '2026-08-01', ['bob'])];
    const result = accruedLaborCents(
      [alice],
      [makeEntry('2026-08-01', 8, { shopMemberId: 'alice' })],
      since,
      until,
      runs
    );
    expect(result.accruedCents).toBe(4000);
  });

  it('ignores a draft run', () => {
    const runs = [makeRun('2026-08-01', '2026-08-01', ['m1'], 'draft')];
    const result = accruedLaborCents([hourly], [makeEntry('2026-08-01', 8)], since, until, runs);
    expect(result.accruedCents).toBe(4000);
  });

  it('skips open shifts', () => {
    const result = accruedLaborCents(
      [hourly],
      [{ ...makeEntry('2026-08-01', 0), clockOut: null }],
      since,
      until,
      []
    );
    expect(result.accruedCents).toBe(0);
  });

  // Salaried staff accrue now that dailySalaryCents gives an exact per-day
  // figure. 300000/mo x 12 / 365 = 9863.0137/day, x 3 uncovered days.
  it('accrues salaried staff by day', () => {
    const salaried = makeMember({ id: 's1', payType: 'salary', payRateCents: 300000 });
    const result = accruedLaborCents([salaried], [], since, until, []);
    expect(result.accruedCents).toBe(29589);
    expect(result.hours).toBe(0);
  });

  it('stops accruing a salaried member once a run covers the days', () => {
    const salaried = makeMember({ id: 's1', payType: 'salary', payRateCents: 300000 });
    const runs = [makeRun('2026-08-01', '2026-08-03', ['s1'])];
    const result = accruedLaborCents([salaried], [], since, until, runs);
    expect(result.accruedCents).toBe(0);
  });

  // 'fixed' is a flat amount per run, so there is no daily rate to derive.
  // Inventing one would be a guess presented as a number.
  it('excludes fixed-pay staff but reports how many', () => {
    const fixed = makeMember({ id: 'f1', payType: 'fixed', payRateCents: 50000 });
    const result = accruedLaborCents([hourly, fixed], [makeEntry('2026-08-01', 8)], since, until, []);
    expect(result.accruedCents).toBe(4000);
    expect(result.fixedExcludedCount).toBe(1);
  });

  it('ignores inactive staff when counting exclusions', () => {
    const fixed = makeMember({ id: 'f1', payType: 'fixed', payRateCents: 50000, active: false });
    const result = accruedLaborCents([fixed], [], since, until, []);
    expect(result.fixedExcludedCount).toBe(0);
  });
});
```

Add `PayrollRun` to the type import at the top of the file if it is not already there, and remove `uncoveredDays` from the `@/lib/payroll-reporting` import.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest src/lib/__tests__/payroll-reporting.test.ts`
Expected: FAIL — `accruedLaborCents` has the wrong arity, and `fixedExcludedCount` is undefined.

- [ ] **Step 3: Replace both functions**

In `src/lib/payroll-reporting.ts`, add `dailySalaryCents` to the existing `@/lib/pay-rate` import. Delete `uncoveredDays` entirely and replace `accruedLaborCents` with:

```ts
// Days each member has already been paid for. Derived from each run's LINES,
// not its period: once runs are per-member, a run that paid Bob says nothing
// about whether Alice has been paid, and reading coverage off the period alone
// would silently under-report her accrual.
function coveredDaysByMember(postedRuns: PayrollRun[]): Map<string, Set<string>> {
  const covered = new Map<string, Set<string>>();
  for (const run of postedRuns) {
    if (run.status !== 'posted') continue;
    const days: string[] = [];
    let cursor = fromDateColumn(run.periodStart).getTime();
    const end = fromDateColumn(run.periodEnd).getTime();
    while (cursor <= end) {
      days.push(toDateColumn(new Date(cursor)));
      cursor += MS_PER_DAY;
    }
    for (const line of run.lines ?? []) {
      let memberDays = covered.get(line.shopMemberId);
      if (!memberDays) {
        memberDays = new Set<string>();
        covered.set(line.shopMemberId, memberDays);
      }
      for (const day of days) memberDays.add(day);
    }
  }
  return covered;
}

// Labour worked or earned on days no posted run covers -- the accrual figure.
// This is what makes accrued-but-unpaid labour safe to add to the P&L: the
// moment a run is posted, its days drop out for the members it paid and its
// expense row takes over, so the two can never both count the same day.
//
// Salaried staff accrue by day, using the same exact per-day figure the draft
// prorates with. 'fixed' staff don't: a flat amount per pay run has no daily
// rate to derive, and inventing one would be a guess presented as a number.
export function accruedLaborCents(
  members: StaffMember[],
  entries: TimeEntry[],
  since: Date,
  until: Date,
  postedRuns: PayrollRun[]
): { accruedCents: number; hours: number; fixedExcludedCount: number } {
  const covered = coveredDaysByMember(postedRuns);
  const memberById = new Map(members.map((member) => [member.id, member]));

  const rangeDays: string[] = [];
  let cursor = new Date(since.getFullYear(), since.getMonth(), since.getDate()).getTime();
  const last = new Date(until.getFullYear(), until.getMonth(), until.getDate()).getTime();
  while (cursor <= last) {
    rangeDays.push(toDateColumn(new Date(cursor)));
    cursor += MS_PER_DAY;
  }
  // A Set for the per-entry membership test below: a year-long range against a
  // busy shop's time entries makes a linear scan per entry needlessly quadratic.
  const rangeDaySet = new Set(rangeDays);

  let accruedCents = 0;
  let hours = 0;

  for (const entry of entries) {
    if (!entry.clockOut) continue;
    const member = memberById.get(entry.shopMemberId);
    if (!member || member.payType !== 'hourly' || member.payRateCents === null) continue;
    const day = toDateColumn(new Date(entry.clockIn));
    if (!rangeDaySet.has(day)) continue;
    if (covered.get(member.id)?.has(day)) continue;
    const entryHours = sumDurationHours([entry]);
    hours += entryHours;
    accruedCents += Math.round(member.payRateCents * entryHours);
  }

  for (const member of members) {
    if (!member.active || member.payType !== 'salary' || member.payRateCents === null) continue;
    const memberCovered = covered.get(member.id);
    const uncovered = rangeDays.filter((day) => !memberCovered?.has(day));
    if (uncovered.length === 0) continue;
    const year = fromDateColumn(uncovered[0]).getFullYear();
    accruedCents += Math.round(dailySalaryCents(member.payRateCents, year) * uncovered.length);
  }

  const fixedExcludedCount = members.filter(
    (member) => member.active && member.payRateCents !== null && member.payType === 'fixed'
  ).length;

  return { accruedCents, hours: Number(hours.toFixed(2)), fixedExcludedCount };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx jest src/lib/__tests__/payroll-reporting.test.ts`
Expected: PASS.

- [ ] **Step 5: Update both call sites**

In `src/components/accounting/reports-tab.tsx`, change the type field at line 37 from `salariedExcludedCount: number;` to `fixedExcludedCount: number;`, and the call at line 129:

```tsx
          ...accruedLaborCents(members, entries, since, rangeEnd, runs),
```

Replace the sentence at lines 307-308 — it currently says salaried staff are excluded, which is now false:

```tsx
            {labor && labor.fixedExcludedCount > 0
              ? ` ${labor.fixedExcludedCount} fixed-pay ${labor.fixedExcludedCount === 1 ? 'person is' : 'people are'} not included — a flat per-run amount has no daily rate to accrue.`
```

In `src/components/accounting/cash-budgets-tab.tsx`, change line 115:

```tsx
        setAccruedWagesCents(accruedLaborCents(members, entries, since, rangeEnd, runs).accruedCents);
```

Remove `uncoveredDays` from the `@/lib/payroll-reporting` import in both files.

- [ ] **Step 6: Full verification**

Run: `npx jest && npx tsc --noEmit && npx expo lint`
Expected: `Test Suites: 13 passed`, `Tests: 261 passed`. The arithmetic: 263 before this task, minus the 6 `uncoveredDays` tests and the 5 old `accruedLaborCents` tests you deleted, plus the 9 new ones = 261.

If the count differs, count the tests you actually removed and added and confirm the delta matches before proceeding — a silent shortfall means a describe block was dropped rather than replaced.

- [ ] **Step 7: Commit**

```bash
git add src/lib/payroll-reporting.ts src/lib/__tests__/payroll-reporting.test.ts src/components/accounting/reports-tab.tsx src/components/accounting/cash-budgets-tab.tsx
git commit -m "feat: accrue labour per member, and include salaried staff

Coverage came from each run's period, so once runs are per-member a run
that paid Bob silently marked Alice's days as paid too. It now comes from
the run's lines.

Salaried staff accrue at the exact per-day figure spec 1a introduced. The
old exclusion said prorating a salary 'would be a guess presented as a
number' -- true before dailySalaryCents existed, not after. 'fixed' stays
excluded: a flat per-run amount has no daily rate to derive.

This moves the P&L labour line and cash-budget wages-owed on first run."
```

---

### Task 5: The overlap guard becomes per-member

Safety-critical SQL, with a real database test.

**Files:**
- Create: `supabase/migrations/20260804030100_payroll_per_member_overlap.sql`
- Modify: `supabase/tests/verify-accounting-writes.sql` (extend the payroll section)
- Modify: `supabase/tests/README.md` (item 5)

**Interfaces:**
- Consumes: `payroll_run_lines.shop_member_id` and the index from Task 2.
- Produces: `post_payroll_run(uuid)` rejects only when a posted overlapping run contains a line for the **same member**. Signature unchanged.

- [ ] **Step 1: Add the database tests first**

In `supabase/tests/verify-accounting-writes.sql`, insert this immediately **before** the `--- unposting removes the generated expense ---` block:

```sql
  raise notice '--- a DIFFERENT member may be paid over an overlapping period ---';
  declare
    v_other_member uuid;
    v_parallel_id uuid;
  begin
    insert into public.shop_members (shop_id, user_id, role_id, active, full_name, pay_type, pay_rate_cents, pay_cadence)
      values (v_shop_id, gen_random_uuid(), v_role_id, true, 'Parallel Staff', 'hourly', 500, 'weekly')
      returning id into v_other_member;
    insert into public.payroll_runs (shop_id, period_start, period_end, cadence)
      values (v_shop_id, '2026-08-03', '2026-08-09', 'weekly') returning id into v_parallel_id;
    insert into public.payroll_run_lines (payroll_run_id, shop_member_id, member_name, amount_cents)
      values (v_parallel_id, v_other_member, 'Parallel Staff', 2500);

    -- This overlaps the already-posted Aug 1-7 run. Under the old shop-wide
    -- guard it was rejected; that is exactly what made per-member cadence
    -- impossible, so accepting it is the behaviour worth proving.
    perform public.post_payroll_run(v_parallel_id);
    select status into v_status from public.payroll_runs where id = v_parallel_id;
    if v_status <> 'posted' then raise exception 'FAIL: a different member was blocked by an overlapping period'; end if;
    raise notice 'OK: overlapping period accepted for a different member';

    raise notice '--- the SAME member is still refused over an overlapping period ---';
    declare v_dupe_id uuid;
    begin
      insert into public.payroll_runs (shop_id, period_start, period_end)
        values (v_shop_id, '2026-08-05', '2026-08-11') returning id into v_dupe_id;
      insert into public.payroll_run_lines (payroll_run_id, shop_member_id, member_name, amount_cents)
        values (v_dupe_id, v_other_member, 'Parallel Staff', 2500);
      v_raised := false;
      begin
        perform public.post_payroll_run(v_dupe_id);
      exception when others then
        v_raised := true;
        v_err := sqlerrm;
      end;
      if not v_raised then raise exception 'FAIL: the same member was paid twice for overlapping periods'; end if;
      if v_err not like '%Parallel Staff%' then
        raise exception 'FAIL: the error should name the member, got: %', v_err;
      end if;
      raise notice 'OK: same-member overlap refused, naming the member';
    end;
  end;
```

This reuses `v_err`, added to the outer declare block by the draft-warnings work. If it is not present, add `v_err text;` alongside the other outer declarations.

- [ ] **Step 2: Run the database tests to verify the new block fails**

Run:
```bash
supabase db reset && psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -f supabase/tests/verify-accounting-writes.sql
```
Expected: FAIL at `FAIL: a different member was blocked by an overlapping period` — the shop-wide guard is still in place, so the parallel run is rejected. Everything before it should still print `OK:`.

- [ ] **Step 3: Write the guard**

Create `supabase/migrations/20260804030100_payroll_per_member_overlap.sql`:

```sql
-- The overlap guard rejected any posted run whose period overlapped, shop-wide,
-- with no notion of who was in it. Per-member cadence requires exactly what
-- that forbids: Bob paid monthly for Aug 1-31 and Alice paid weekly for
-- Aug 1-7 are overlapping runs that must both succeed.
--
-- NOTE: the header below was corrected after review. See the committed migration
-- for the authoritative text. It is a deliberate NARROWING, not a strengthening:
-- the new predicate is the old one plus a member conjunct, so a conjunction can
-- only reject fewer runs. Required because different cadences legitimately
-- overlap; the cost is that two shop_members rows for the same human can both be
-- paid over overlapping periods, which the shop-wide check blocked.
--
-- (superseded wording) It is now a member-intersection check, which is STRICTLY STRONGER than the
-- period-only version rather than a loosening: it still catches every
-- same-member double-pay, and additionally catches someone whose cadence
-- changed mid-stream into a differently-shaped run -- a case the period check
-- sails past whenever the two periods happen not to overlap.
--
-- The error names the people rather than the period, because overlap is now
-- expected and only the member collision is the problem. The name list is
-- capped: forty rate-less staff should not produce a forty-name string in a
-- mobile error label.

create or replace function public.post_payroll_run(p_run_id uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_run public.payroll_runs%rowtype;
  v_total integer;
  v_expense_id uuid;
  v_conflict_names text;
  v_conflict_count integer;
  v_blocked_names text;
  v_blocked_count integer;
begin
  select * into v_run from public.payroll_runs where id = p_run_id for update;
  if v_run.id is null then
    raise exception 'pay run % not found', p_run_id;
  end if;
  if not (public.has_shop_permission(v_run.shop_id, 'people.payroll.manage')
          and public.has_shop_permission(v_run.shop_id, 'expenses.manage')) then
    raise exception 'not authorized to post pay runs for shop %', v_run.shop_id;
  end if;
  if v_run.status = 'posted' then
    raise exception 'this pay run has already been posted';
  end if;

  select
    string_agg(name, ', ' order by name),
    count(*)
  into v_conflict_names, v_conflict_count
  from (
    select distinct coalesce(l.member_name, 'A staff member') as name
    from public.payroll_runs r
      join public.payroll_run_lines l on l.payroll_run_id = r.id
    where r.shop_id = v_run.shop_id
      and r.id <> v_run.id
      and r.status = 'posted'
      and r.period_start <= v_run.period_end
      and r.period_end   >= v_run.period_start
      and l.shop_member_id in (
        select shop_member_id from public.payroll_run_lines where payroll_run_id = p_run_id
      )
    limit 6
  ) conflicts;
  if v_conflict_names is not null then
    raise exception '% already paid for part of % to %',
      case when v_conflict_count > 5 then v_conflict_names || ' and others' else v_conflict_names end,
      v_run.period_start, v_run.period_end;
  end if;

  select
    string_agg(name, ', ' order by name),
    count(*)
  into v_blocked_names, v_blocked_count
  from (
    select distinct coalesce(member_name, 'A staff member') as name
    from public.payroll_run_lines
    where payroll_run_id = p_run_id
      and warning_blocking
      and amount_cents = 0
    limit 6
  ) blocked;
  if v_blocked_names is not null then
    raise exception 'no amount set for % — enter an amount, or set a pay rate in People',
      case when v_blocked_count > 5 then v_blocked_names || ' and others' else v_blocked_names end;
  end if;

  select coalesce(sum(amount_cents), 0) into v_total
    from public.payroll_run_lines where payroll_run_id = p_run_id;
  if v_total <= 0 then
    raise exception 'this pay run has nothing to pay';
  end if;

  insert into public.expenses (shop_id, occurred_on, amount_cents, category, payment_method, note, created_by, payroll_run_id)
    values (
      v_run.shop_id,
      v_run.period_end,
      v_total,
      'salaries_wages',
      'cash',
      'Payroll ' || v_run.period_start || ' to ' || v_run.period_end,
      auth.uid(),
      v_run.id
    )
    returning id into v_expense_id;

  update public.payroll_runs set
    status = 'posted',
    total_cents = v_total,
    expense_id = v_expense_id,
    posted_at = now(),
    posted_by = auth.uid(),
    updated_at = now()
  where id = p_run_id;

  return v_expense_id;
end;
$$;

-- Kept on the live object rather than in whichever migration happens to be
-- oldest: the function is recreated often enough that its rationale gets
-- stranded otherwise.
comment on function public.post_payroll_run(uuid) is
  'Commits a draft pay run: writes one salaries_wages expense dated period_end and flips the status. The row is locked first so two concurrent posts cannot both see draft. Rejects: an already-posted run; an overlapping posted run that shares a member (per member, not per period, because different cadences legitimately overlap); a line warning of a missing pay rate that still has no amount; and a run totalling zero. The expense is dated period_end so August payroll posted in September lands in August.';

grant execute on function public.post_payroll_run(uuid) to authenticated;
```

- [ ] **Step 4: Run the database tests to verify they pass**

Run:
```bash
supabase db reset && psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -f supabase/tests/verify-accounting-writes.sql
```
Expected: ends `################  ALL CHECKS PASSED  ################` and `Rolled back — no rows left behind.`, including the two new `OK:` lines.

- [ ] **Step 5: Confirm the JS suite is untouched**

Run: `npx jest && npx tsc --noEmit`
Expected: `Test Suites: 13 passed`, `Tests: 261 passed`; no TypeScript output. This task changes no TypeScript.

- [ ] **Step 6: Document the new coverage**

In `supabase/tests/README.md`, replace item 5 of the coverage list with:

```markdown
5. Posting a pay run writes one `salaries_wages` expense dated **period end**;
   posting twice is rejected; a line that warns of a missing pay rate and has
   no amount is rejected but posts once an amount is entered — and keeps its
   warning; an overlapping period is **accepted** for a different member and
   **rejected** for the same one, naming them; unposting removes the expense
   and returns the run to draft.
```

- [ ] **Step 7: Commit**

```bash
git add supabase/migrations/20260804030100_payroll_per_member_overlap.sql supabase/tests/verify-accounting-writes.sql supabase/tests/README.md
git commit -m "feat: make the double-pay guard per member, not per period

The guard rejected any overlapping posted run shop-wide, which is exactly
what per-member cadence requires: Bob monthly for Aug 1-31 and Alice
weekly for Aug 1-7 must both post.

This is a deliberate narrowing, not a strengthening. The new predicate is
the old one plus a member conjunct, so the runs it rejects are a strict
subset of what the period check rejected. It gives up shop-wide catch-all
protection: two shop_members rows for the same human can now both be paid
over overlapping periods. Documented in the migration header and pinned
by a test.

Also caps the name lists and moves the function's rationale into a
comment on the function, so recreating it doesn't strand the reasoning."
```

---

### Task 6: The cadence UI

**Files:**
- Modify: `src/components/accounting/payroll-tab.tsx` (period picker, cadence state, both draft calls)
- Modify: `src/components/settings/panels/store-panel.tsx` (anchor field)
- Modify: `src/components/pay-fields.tsx` (cadence row)

**Interfaces:**
- Consumes: `PayCadence`, `payPeriodsFor` from `@/lib/pay-periods`; `Shop.payPeriodAnchor`, `StaffMember.payCadence` from Task 2.
- Produces: nothing. This is the last task.

There is no React Native testing library in `devDependencies`, so this task is verified by typecheck, lint, and the unchanged suite. The logic it drives is covered by Tasks 1 and 3.

- [ ] **Step 1: Add the cadence row to `PayFields`**

In `src/components/pay-fields.tsx`, add to the imports:

```tsx
import type { PayCadence } from '@/lib/pay-periods';
```

Add `payCadence: PayCadence;` to `PayFieldsValue`, and `payCadence: member.payCadence,` to `payFieldsInitial`'s returned object.

Add the constant beside the existing `ENTRY_UNITS`:

```tsx
const CADENCES: { cadence: PayCadence; label: string }[] = [
  { cadence: 'weekly', label: 'Weekly' },
  { cadence: 'biweekly', label: 'Every 2 weeks' },
  { cadence: 'semimonthly', label: 'Twice a month' },
  { cadence: 'monthly', label: 'Monthly' },
];
```

Render it after the entry-unit block and before the preview line:

```tsx
      {/* Applies to every pay type -- cadence is when someone is paid, not
          what they're paid. */}
      <Text style={styles.label}>PAID</Text>
      <View style={styles.chips}>
        {CADENCES.map(({ cadence, label }) => (
          <CategoryChip
            key={cadence}
            label={label}
            active={value.payCadence === cadence}
            onPress={() => onChange({ ...value, payCadence: cadence })}
          />
        ))}
      </View>
```

Both modals already spread `PayFieldsValue` through `payFieldsInitial`, so they need only pass `payCadence: pay.payCadence` in their save payloads — add it beside the existing `payType` / `payRateCents` fields in `src/components/edit-pay-modal.tsx` and `src/components/team-member-edit-modal.tsx`.

- [ ] **Step 2: Add the anchor field to Store settings**

In `src/components/settings/panels/store-panel.tsx`, add state beside the existing fields:

```tsx
  const [payPeriodAnchor, setPayPeriodAnchor] = useState(shop.payPeriodAnchor ?? '');
```

Add it to the `dirty` check:

```tsx
    payPeriodAnchor.trim() !== (shop.payPeriodAnchor ?? '') ||
```

Add it to the `updateShop` call:

```tsx
        payPeriodAnchor: payPeriodAnchor.trim() || null,
```

Add a section after "Store details":

```tsx
      <Section title="Payroll">
        <EditableTextRow
          label="Pay period start"
          value={payPeriodAnchor}
          onChangeText={setPayPeriodAnchor}
          placeholder="YYYY-MM-DD"
        />
      </Section>
```

- [ ] **Step 3: Add the period picker to pay-run creation**

In `src/components/accounting/payroll-tab.tsx`, add to the imports:

```tsx
import { payPeriodsFor, type PayCadence } from '@/lib/pay-periods';
```

Add state beside the existing `periodStart` / `periodEnd`:

```tsx
  const [cadence, setCadence] = useState<PayCadence | null>('monthly');
```

Change the two period defaults so the picker opens on the current calendar month. This is what makes the exact-salary path reachable — seeding from the Accounting rolling-days range meant "Build draft" always took the prorated branch:

```tsx
  const thisMonth = payPeriodsFor('monthly', null, toDateColumn(new Date()), toDateColumn(new Date())).periods[0];
  const [periodStart, setPeriodStart] = useState(thisMonth.start);
  const [periodEnd, setPeriodEnd] = useState(thisMonth.end);
```

Derive the selectable periods:

```tsx
  const anchor = shop?.payPeriodAnchor ?? null;
  const periodOptions = cadence
    ? payPeriodsFor(cadence, anchor, toDateColumn(dateRange.since), toDateColumn(dateRange.until ?? new Date()))
    : { periods: [], reason: 'ok' as const };
```

Render, above the existing `DateInput` pair:

```tsx
      <View style={styles.chips}>
        {(['weekly', 'biweekly', 'semimonthly', 'monthly'] as const).map((option) => (
          <CategoryChip
            key={option}
            label={option === 'biweekly' ? 'Every 2 weeks' : option === 'semimonthly' ? 'Twice a month' : option[0].toUpperCase() + option.slice(1)}
            active={cadence === option}
            onPress={() => setCadence(option)}
          />
        ))}
        <CategoryChip label="Custom dates" active={cadence === null} onPress={() => setCadence(null)} />
      </View>
      {periodOptions.reason === 'anchor_required' ? (
        <Text style={styles.subtitle}>
          Set a pay period start date in Settings → Store before using weekly or fortnightly periods.
        </Text>
      ) : (
        <View style={styles.chips}>
          {periodOptions.periods.map((period) => (
            <CategoryChip
              key={`${period.start}-${period.end}`}
              label={`${period.start} → ${period.end}`}
              active={periodStart === period.start && periodEnd === period.end}
              onPress={() => {
                setPeriodStart(period.start);
                setPeriodEnd(period.end);
              }}
            />
          ))}
        </View>
      )}
```

Add `CategoryChip` to the imports if it is not already there. Reuse the existing `styles.chips` if present; otherwise add `chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 10 },`.

- [ ] **Step 4: Pass the cadence through to both calls**

Replace the placeholder `null, null` arguments added in Tasks 2 and 3:

```tsx
      const lines = computePayrollDraft(members, entries, periodStart, periodEnd, cadence, anchor);
      const created = await createPayrollRun(shop.id, periodStart, periodEnd, lines, cadence);
```

- [ ] **Step 5: Verify**

Run: `npx jest && npx tsc --noEmit && npx expo lint`
Expected: `Test Suites: 13 passed`, `Tests: 261 passed`; no TypeScript output; lint at 42 problems, no new ones.

- [ ] **Step 6: Confirm no placeholder arguments survive**

Run: `grep -n "computePayrollDraft\|createPayrollRun" src/components/accounting/payroll-tab.tsx`
Expected: both calls pass real values — `cadence` and `anchor`, never a literal `null` left over from the earlier tasks. A surviving literal would silently disable the cadence filter and pay everyone in every run.

- [ ] **Step 7: Commit**

```bash
git add "src/components/accounting/payroll-tab.tsx" src/components/settings/panels/store-panel.tsx src/components/pay-fields.tsx src/components/edit-pay-modal.tsx src/components/team-member-edit-modal.tsx
git commit -m "feat: pick a cadence and a real pay period when building a run

The period defaulted to the Accounting rolling-days range, so 'Build
draft' always took the prorated branch and a salaried member could only
be paid exactly by hand-typing calendar-month dates. It now defaults to
the current calendar month, with generated periods per cadence.

Weekly and fortnightly need the shop's pay period anchor; without one the
picker says so and custom dates still work, rather than guessing a date
that would silently pick everyone's pay days."
```

---

## Done when

- `npx jest` reports 13 suites / 261 tests passing.
- `npx tsc --noEmit` and `npx expo lint` are clean (lint at its 42-problem baseline).
- `supabase db reset && psql "$DB_URL" -f supabase/tests/verify-accounting-writes.sql` ends with `ALL CHECKS PASSED`.
- A monthly salaried member drafts their exact monthly figure by default, with no hand-typed dates.
- A weekly and a monthly member can both be paid for overlapping August periods; the same member cannot be paid twice.
- Accrued wages on the P&L includes salaried staff and excludes `fixed` ones.

## Deliberately not done here

- **Staff CSV import round-trip.** `staff-import.ts:69-70` nulls the pay fields, so cadence will not re-import either. Its own spec.
- **Store hours and team scheduling.** Later specs.
- **Per-member pay-period anchors.** Rejected in the spec.
- **Rebuilding existing draft runs** when a cadence changes. Drafts keep their computed amounts; the per-member guard catches a conflicting post, and a stale draft can be discarded and rebuilt.
- **`supabase db push`.** Local verification only. Note that four migrations are now pending on the remote — the two from the draft-warnings work and the two here — and `createPayrollRun` names columns from all of them.
