# Pay Rate Units Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish "cents per month" as the recorded meaning of a salaried `pay_rate_cents`, fix the payroll math that currently overpays, and label every surface that displays a pay rate.

**Architecture:** A new pure module `src/lib/pay-rate.ts` owns all unit conversion, proration arithmetic, and rate formatting. `payroll-reporting.ts` consumes it in place of its `/30` proration. A new shared `PayFields` component replaces the pay form duplicated across two modals and adds a Week/Month/Year entry converter. No schema change — the entry unit is UI-only.

**Tech Stack:** Expo SDK 57, React Native 0.86, React 19.2, TypeScript 6.0, Jest 29 (`jest-expo` preset), Supabase.

**Spec:** `docs/superpowers/specs/2026-08-03-pay-rate-units-design.md`

## Global Constraints

- **Expo SDK 57.** Per `AGENTS.md`, consult https://docs.expo.dev/versions/v57.0.0/ before writing framework code. This plan touches no Expo APIs, so it should not be needed.
- **Money is always integer cents.** Round exactly once, at the final amount. Never round an intermediate rate.
- **`hourly` pay must not change.** Any diff altering an hourly amount is a bug, not a feature. Task 2 asserts this.
- **Pure modules import no Supabase.** `pay-rate.ts` and `payroll-reporting.ts` must load under Jest, which has no native runtime. Importing `@/lib/supabase` from either breaks the suite.
- **Test command is `npx jest --testPathIgnorePatterns "/node_modules/" "/.expo/" "/.claude/"`** until Task 1 fixes the config, then plain `npx jest`. A bare `npx jest` today sweeps up stale worktree copies under `.claude/worktrees/` and reports a pre-existing, unrelated failure in `shop-owner-pos/src/lib/__tests__/cart.test.ts`.
- **Baseline is 11 suites / 192 tests passing.** If you see 16 suites or a `cart.test.ts` failure, you ran the wrong command.
- **Typecheck with `npx tsc --noEmit`** — currently clean, must stay clean.

---

### Task 1: `pay-rate.ts` — unit conversion and formatting

The pure arithmetic every later task builds on. Nothing here touches payroll or UI yet.

**Files:**
- Create: `src/lib/pay-rate.ts`
- Create: `src/lib/__tests__/pay-rate.test.ts`
- Modify: `jest.config.js:3`

**Interfaces:**
- Consumes: `formatAccountingCents` and `toCents` from `@/lib/currency`; `fromDateColumn` from `@/lib/period`; `StaffMember` from `@/types/models`.
- Produces, relied on by Tasks 2–4:
  ```ts
  type RateEntryUnit = 'weekly' | 'monthly' | 'yearly'
  toMonthlyCents(amountCents: number, unit: RateEntryUnit): number
  annualCents(monthlyCents: number): number
  daysInYear(year: number): number
  dailySalaryCents(monthlyCents: number, year: number): number   // FRACTIONAL
  isWholeCalendarMonth(periodStart: string, periodEnd: string): boolean
  rateInputToCents(text: string, payType: StaffMember['payType'], unit: RateEntryUnit): number | null
  formatPayRate(payType: StaffMember['payType'], rateCents: number | null): string
  formatPayRateLong(payType: StaffMember['payType'], rateCents: number | null): string
  payRateUnitLabel(payType: StaffMember['payType']): string
  ```

- [ ] **Step 1: Stop Jest sweeping up stale worktrees**

`.claude/worktrees/` holds old copies of this repo whose tests no longer pass. They are not part of the project and must not gate this work.

In `jest.config.js`, replace line 3:

```js
  testPathIgnorePatterns: ['/node_modules/', '/.expo/', '/.claude/'],
```

- [ ] **Step 2: Verify the baseline is now clean**

Run: `npx jest`
Expected: `Test Suites: 11 passed, 11 total` / `Tests: 192 passed, 192 total`. No `cart.test.ts` failure.

- [ ] **Step 3: Write the failing tests**

Create `src/lib/__tests__/pay-rate.test.ts`:

```ts
import {
  annualCents,
  dailySalaryCents,
  daysInYear,
  formatPayRate,
  formatPayRateLong,
  isWholeCalendarMonth,
  payRateUnitLabel,
  rateInputToCents,
  toMonthlyCents,
} from '@/lib/pay-rate';

describe('toMonthlyCents', () => {
  it('leaves a monthly figure alone', () => {
    expect(toMonthlyCents(300000, 'monthly')).toBe(300000);
  });

  it('divides a yearly figure by twelve', () => {
    expect(toMonthlyCents(3600000, 'yearly')).toBe(300000);
  });

  // The tempting wrong answer is x4 -- four weeks is not a month, and it
  // under-pays by about 8% a year. 52/12 is what makes a weekly and a
  // monthly quote agree over a full year.
  it('converts weekly using 52/12, not 4', () => {
    expect(toMonthlyCents(70000, 'weekly')).toBe(303333);
    expect(toMonthlyCents(70000, 'weekly')).not.toBe(280000);
  });
});

describe('annualCents', () => {
  it('is twelve monthly payments', () => {
    expect(annualCents(300000)).toBe(3600000);
  });
});

describe('daysInYear', () => {
  it('is 365 in a common year', () => {
    expect(daysInYear(2026)).toBe(365);
  });

  it('is 366 in a leap year', () => {
    expect(daysInYear(2024)).toBe(366);
  });

  // The century rules, which a naive %4 check gets wrong.
  it('handles the century exceptions', () => {
    expect(daysInYear(2100)).toBe(365);
    expect(daysInYear(2000)).toBe(366);
  });
});

describe('dailySalaryCents', () => {
  // Deliberately fractional: rounding here and then multiplying by a day
  // count compounds the error. The caller rounds once, at the end.
  it('returns an unrounded daily rate', () => {
    expect(dailySalaryCents(300000, 2026)).toBeCloseTo(9863.0137, 3);
  });

  it('spreads over 366 days in a leap year', () => {
    expect(dailySalaryCents(300000, 2024)).toBeCloseTo(9836.0656, 3);
  });
});

describe('isWholeCalendarMonth', () => {
  it('accepts a full 31-day month', () => {
    expect(isWholeCalendarMonth('2026-08-01', '2026-08-31')).toBe(true);
  });

  it('accepts a full February', () => {
    expect(isWholeCalendarMonth('2026-02-01', '2026-02-28')).toBe(true);
  });

  it('accepts a full leap February', () => {
    expect(isWholeCalendarMonth('2024-02-01', '2024-02-29')).toBe(true);
  });

  it('rejects a month missing its last day', () => {
    expect(isWholeCalendarMonth('2026-08-01', '2026-08-30')).toBe(false);
  });

  it('rejects a period not starting on the 1st', () => {
    expect(isWholeCalendarMonth('2026-08-02', '2026-08-31')).toBe(false);
  });

  it('rejects a span crossing two months', () => {
    expect(isWholeCalendarMonth('2026-08-01', '2026-09-30')).toBe(false);
  });
});

describe('rateInputToCents', () => {
  it('is null for blank input', () => {
    expect(rateInputToCents('   ', 'salary', 'monthly')).toBeNull();
  });

  it('converts a yearly salary entry to monthly cents', () => {
    expect(rateInputToCents('36000', 'salary', 'yearly')).toBe(300000);
  });

  // Hourly is per hour by definition, so the entry unit must not touch it.
  it('ignores the entry unit for hourly pay', () => {
    expect(rateInputToCents('8.50', 'hourly', 'yearly')).toBe(850);
  });

  // Fixed is per pay run by definition -- also not converted.
  it('ignores the entry unit for fixed pay', () => {
    expect(rateInputToCents('500', 'fixed', 'yearly')).toBe(50000);
  });
});

describe('formatPayRate', () => {
  it('labels salary per month', () => {
    expect(formatPayRate('salary', 300000)).toBe('$3,000.00 / month');
  });

  it('labels hourly per hour', () => {
    expect(formatPayRate('hourly', 850)).toBe('$8.50 / hour');
  });

  it('labels fixed per run', () => {
    expect(formatPayRate('fixed', 50000)).toBe('$500.00 / run');
  });

  it('dashes when there is no rate', () => {
    expect(formatPayRate('salary', null)).toBe('—');
    expect(formatPayRate(null, 300000)).toBe('—');
  });
});

describe('formatPayRateLong', () => {
  // Both figures, always, so the number can never be misread as annual again.
  it('shows monthly and annual for a salary', () => {
    expect(formatPayRateLong('salary', 300000)).toBe('$3,000.00 / month · $36,000.00 / year');
  });

  it('is unchanged for hourly, which has no annual equivalent', () => {
    expect(formatPayRateLong('hourly', 850)).toBe('$8.50 / hour');
  });
});

describe('payRateUnitLabel', () => {
  it('names the unit for a CSV column', () => {
    expect(payRateUnitLabel('hourly')).toBe('per hour');
    expect(payRateUnitLabel('salary')).toBe('per month');
    expect(payRateUnitLabel('fixed')).toBe('per run');
    expect(payRateUnitLabel(null)).toBe('');
  });
});
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `npx jest src/lib/__tests__/pay-rate.test.ts`
Expected: FAIL — `Cannot find module '@/lib/pay-rate'`.

- [ ] **Step 5: Write the implementation**

Create `src/lib/pay-rate.ts`:

```ts
import { formatAccountingCents, toCents } from '@/lib/currency';
import { fromDateColumn } from '@/lib/period';
import type { StaffMember } from '@/types/models';

// What a pay rate *means*, and how to convert between the units a person
// might quote one in.
//
// `shop_members.pay_rate_cents` had no recorded unit: the UI labelled it
// annual while the payroll math divided it by a nominal 30 days, so a salary
// entered as an annual figure was paid at roughly 12x. Monthly is now the one
// canonical unit for salaried pay, and this module is the only place that
// knows it.
//
// Monthly rather than annual is deliberate. Storing annual and dividing by 12
// leaves no individual payment exact -- $35,000/yr / 12 = $2,916.67, and
// twelve of those sum to $35,000.04. Storing monthly makes the figure that
// actually leaves the bank exact, and only the derived annual display drifts.

// The unit a rate is *typed in*. Never stored -- it only drives conversion at
// entry, so there is no second field that can fall out of sync with the first.
export type RateEntryUnit = 'weekly' | 'monthly' | 'yearly';

const MONTHS_PER_YEAR = 12;
const WEEKS_PER_YEAR = 52;

// x52/12, not x4: four weeks is not a month. Using 4 would under-pay a
// weekly-quoted salary by about 8% a year.
export function toMonthlyCents(amountCents: number, unit: RateEntryUnit): number {
  switch (unit) {
    case 'weekly':
      return Math.round((amountCents * WEEKS_PER_YEAR) / MONTHS_PER_YEAR);
    case 'yearly':
      return Math.round(amountCents / MONTHS_PER_YEAR);
    case 'monthly':
      return Math.round(amountCents);
  }
}

export function annualCents(monthlyCents: number): number {
  return monthlyCents * MONTHS_PER_YEAR;
}

export function daysInYear(year: number): number {
  const isLeap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  return isLeap ? 366 : 365;
}

// FRACTIONAL BY DESIGN -- do not round this. Rounding the daily rate and then
// multiplying by a day count compounds the error (up to ~15c over a month),
// which is exactly the drift that makes a payroll figure fail to reconcile.
// The caller rounds once, on the final amount.
export function dailySalaryCents(monthlyCents: number, year: number): number {
  return annualCents(monthlyCents) / daysInYear(year);
}

// A pay period covering exactly one calendar month, which is what a monthly
// salary is quoted against -- it gets paid in full with no proration and no
// warning.
export function isWholeCalendarMonth(periodStart: string, periodEnd: string): boolean {
  const start = fromDateColumn(periodStart);
  const end = fromDateColumn(periodEnd);
  if (start.getDate() !== 1) return false;
  if (start.getFullYear() !== end.getFullYear()) return false;
  if (start.getMonth() !== end.getMonth()) return false;
  // Day 0 of the next month is the last day of this one.
  const lastDay = new Date(start.getFullYear(), start.getMonth() + 1, 0).getDate();
  return end.getDate() === lastDay;
}

// Pay-form text to the cents actually stored. The entry unit applies only to
// salary; hourly is per hour and fixed is per pay run, both by definition.
export function rateInputToCents(
  text: string,
  payType: StaffMember['payType'],
  unit: RateEntryUnit
): number | null {
  if (!text.trim()) return null;
  const cents = toCents(text);
  return payType === 'salary' ? toMonthlyCents(cents, unit) : cents;
}

function unitSuffix(payType: StaffMember['payType']): string {
  switch (payType) {
    case 'hourly':
      return '/ hour';
    case 'salary':
      return '/ month';
    case 'fixed':
      return '/ run';
    default:
      return '';
  }
}

// Every rate is rendered through one of these two, so no surface can show a
// bare number again.
export function formatPayRate(payType: StaffMember['payType'], rateCents: number | null): string {
  if (rateCents === null || payType === null) return '—';
  return `${formatAccountingCents(rateCents)} ${unitSuffix(payType)}`;
}

// Both figures for a salary, so an owner who thinks in annual terms can
// confirm what they entered without doing the arithmetic themselves.
export function formatPayRateLong(payType: StaffMember['payType'], rateCents: number | null): string {
  const base = formatPayRate(payType, rateCents);
  if (payType !== 'salary' || rateCents === null) return base;
  return `${base} · ${formatAccountingCents(annualCents(rateCents))} / year`;
}

// For the staff CSV export, where the file leaves the app and loses every bit
// of surrounding context that would otherwise disambiguate the number.
export function payRateUnitLabel(payType: StaffMember['payType']): string {
  const suffix = unitSuffix(payType);
  return suffix ? suffix.replace('/ ', 'per ') : '';
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx jest src/lib/__tests__/pay-rate.test.ts`
Expected: PASS, 26 tests.

- [ ] **Step 7: Typecheck**

Run: `npx tsc --noEmit`
Expected: no output, exit 0.

- [ ] **Step 8: Commit**

```bash
git add jest.config.js src/lib/pay-rate.ts src/lib/__tests__/pay-rate.test.ts
git commit -m "feat: add pay-rate module defining monthly as the canonical salary unit

pay_rate_cents had no recorded unit. This module is now the only place
that knows salaried pay is per month, and owns every conversion and
label derived from that.

Also stops Jest sweeping up stale worktree copies under .claude/, which
made a bare 'npx jest' report an unrelated pre-existing failure."
```

---

### Task 2: Fix the payroll math

Deletes the `/30` proration that overpays, and gives `fixed` a definition distinct from `salary`.

**Files:**
- Modify: `src/lib/payroll-reporting.ts:1-3` (imports), `:29-32` (delete constant), `:74-84` (salary/fixed branch)
- Modify: `src/lib/__tests__/payroll-reporting.test.ts:116-138`
- Create: `supabase/migrations/20260803120000_pay_rate_units_comment.sql`

**Interfaces:**
- Consumes: `dailySalaryCents`, `isWholeCalendarMonth` from `@/lib/pay-rate` (Task 1).
- Produces: no signature changes. `computePayrollDraft` keeps its exact current shape; only the amounts it returns for `salary` and `fixed` change.

- [ ] **Step 1: Update the tests to assert correct behaviour**

Two existing tests encode the bug and must flip. In `src/lib/__tests__/payroll-reporting.test.ts`, replace lines 116-138 (the two tests from `'leaves salaried staff unflagged over a whole month'` through `'prorates a part-period salary and asks for it to be checked'`) with:

```ts
  // Was 310000: the old code divided by a nominal 30 days, so a 31-day month
  // paid 31/30 of the monthly salary -- a 3.3% overpayment every long month.
  it('pays a salaried member exactly their monthly rate for a whole month', () => {
    const lines = computePayrollDraft(
      [makeMember({ payType: 'salary', payRateCents: 300000 })],
      [],
      '2026-08-01',
      '2026-08-31'
    );
    expect(lines[0].amountCents).toBe(300000);
    expect(lines[0].warning).toBeNull();
  });

  it('pays the same monthly rate in a short month', () => {
    const lines = computePayrollDraft(
      [makeMember({ payType: 'salary', payRateCents: 300000 })],
      [],
      '2026-02-01',
      '2026-02-28'
    );
    expect(lines[0].amountCents).toBe(300000);
    expect(lines[0].warning).toBeNull();
  });

  it('pays the same monthly rate in a 30-day month', () => {
    const lines = computePayrollDraft(
      [makeMember({ payType: 'salary', payRateCents: 300000 })],
      [],
      '2026-04-01',
      '2026-04-30'
    );
    expect(lines[0].amountCents).toBe(300000);
    expect(lines[0].warning).toBeNull();
  });

  // Proration over an arbitrary stretch is an approximation, so it asks for a
  // human check instead of presenting a guess as fact.
  it('prorates a part-period salary against the real year and asks for a check', () => {
    const lines = computePayrollDraft(
      [makeMember({ payType: 'salary', payRateCents: 300000 })],
      [],
      '2026-08-01',
      '2026-08-07'
    );
    // 300000 x 12 / 365 x 7, rounded once at the end.
    expect(lines[0].amountCents).toBe(69041);
    expect(lines[0].warning).toMatch(/Prorated for 7 days/);
  });

  // 'fixed' now means what its name says: the same amount every pay run,
  // whatever the period length. Previously it prorated like salary, which
  // made it salary under another name.
  it('pays a fixed member the same amount regardless of period length', () => {
    const short = computePayrollDraft(
      [makeMember({ payType: 'fixed', payRateCents: 50000 })],
      [],
      '2026-08-01',
      '2026-08-07'
    );
    const long = computePayrollDraft(
      [makeMember({ payType: 'fixed', payRateCents: 50000 })],
      [],
      '2026-08-01',
      '2026-08-31'
    );
    expect(short[0].amountCents).toBe(50000);
    expect(long[0].amountCents).toBe(50000);
    expect(short[0].warning).toBeNull();
    expect(long[0].warning).toBeNull();
  });

  // The guard rail on this whole change: hourly pay must be untouched.
  it('leaves hourly pay exactly as it was', () => {
    const lines = computePayrollDraft(
      [makeMember({ payType: 'hourly', payRateCents: 500 })],
      [makeEntry('2026-08-03', 8)],
      '2026-08-01',
      '2026-08-07'
    );
    expect(lines[0].amountCents).toBe(4000);
    expect(lines[0].hoursWorked).toBe(8);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest src/lib/__tests__/payroll-reporting.test.ts`
Expected: FAIL — the whole-month test receives `310000`, expected `300000`; the 7-day test receives `70000`, expected `69041`; the fixed test receives `11667`, expected `50000`.

- [ ] **Step 3: Wire in the new arithmetic**

In `src/lib/payroll-reporting.ts`, add to the imports at the top (after the existing `fromDateColumn` import):

```ts
import { dailySalaryCents, isWholeCalendarMonth } from '@/lib/pay-rate';
```

Delete these lines (currently 29-32):

```ts
// Hourly pay is exact. Salary and fixed pay are prorated by day count against
// a nominal month, which is an approximation -- flagged on the line so whoever
// posts the run adjusts it rather than trusting it silently.
const NOMINAL_MONTH_DAYS = 30;
```

Replace the trailing `// salary | fixed` block (currently lines 78-84) with:

```ts
      // Flat per pay run, whatever the period length -- that is what makes
      // 'fixed' a different thing from 'salary' rather than a second name
      // for it. A stipend or allowance is the case this serves.
      if (member.payType === 'fixed') {
        return { ...base, amountCents: member.payRateCents, warning: null };
      }

      // A monthly salary over exactly one calendar month is exact: no
      // proration, no approximation, nothing for a human to check.
      if (isWholeCalendarMonth(periodStart, periodEnd)) {
        return { ...base, amountCents: member.payRateCents, warning: null };
      }

      // Anything else is a genuine part period. Spread across the real year
      // rather than a nominal 30-day month, so month length can't distort it,
      // and round once at the end.
      const year = fromDateColumn(periodStart).getFullYear();
      const amountCents = Math.round(dailySalaryCents(member.payRateCents, year) * days);
      return {
        ...base,
        amountCents,
        warning: `Prorated for ${days} day${days === 1 ? '' : 's'} — check this figure.`,
      };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx jest src/lib/__tests__/payroll-reporting.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the whole suite and typecheck**

Run: `npx jest && npx tsc --noEmit`
Expected: `Test Suites: 12 passed, 12 total`, all tests passing, no TypeScript output.

- [ ] **Step 6: Record the units in the database**

Create `supabase/migrations/20260803120000_pay_rate_units_comment.sql`:

```sql
-- Records what pay_rate_cents means. It previously had no stated unit: the UI
-- labelled it annual while computePayrollDraft divided it by a nominal 30
-- days, so a salary entered as an annual figure was paid at roughly 12x.
--
-- Monthly is now canonical for salaried pay. Documentation only -- no schema
-- change is needed, because the week/month/year selector on the pay form is
-- an entry converter rather than stored state, so there is no second column
-- that can disagree with this one.

comment on column public.shop_members.pay_rate_cents is
  'Cents. Per hour when pay_type = hourly; per month when salary; per pay run when fixed.';

comment on column public.payroll_run_lines.pay_rate_cents is
  'Frozen copy of shop_members.pay_rate_cents at draft time. Same units.';
```

- [ ] **Step 7: Commit**

```bash
git add src/lib/payroll-reporting.ts src/lib/__tests__/payroll-reporting.test.ts supabase/migrations/20260803120000_pay_rate_units_comment.sql
git commit -m "fix: pay salaried staff their actual monthly rate

computePayrollDraft prorated salary against a nominal 30-day month, so a
31-day month overpaid by 3.3% and the test suite asserted the wrong
figure (310000 for a 300000/mo salary). A whole calendar month now pays
exactly the monthly rate; a part period spreads across the real year.

Also gives 'fixed' the meaning its name implies -- flat per pay run,
never prorated. It previously prorated like salary, making it salary
under another name. This changes amounts for anyone currently on fixed.

Hourly pay is unchanged, asserted by a new regression test."
```

---

### Task 3: `PayFields` — shared pay form with the entry converter

**Files:**
- Create: `src/components/pay-fields.tsx`
- Modify: `src/components/edit-pay-modal.tsx:1-5, 16-30, 40-48, 72-84`
- Modify: `src/components/team-member-edit-modal.tsx:1-6, 32-33, 50-62, 103-112`

**Interfaces:**
- Consumes: `rateInputToCents`, `formatPayRateLong`, `toMonthlyCents`, `RateEntryUnit` from `@/lib/pay-rate` (Task 1); `CategoryChip` from `@/components/category-chip`; `toCents` from `@/lib/currency`.
- Produces:
  ```ts
  type PayFieldsValue = { payType: StaffMember['payType']; rate: string; entryUnit: RateEntryUnit }
  function PayFields(props: { value: PayFieldsValue; onChange: (next: PayFieldsValue) => void }): JSX.Element
  function payFieldsInitial(member: StaffMember): PayFieldsValue
  function payFieldsToCents(value: PayFieldsValue): number | null
  ```

Note on scope: this component owns its own styles. The two modals currently use slightly different style keys for the same rows (`fieldLabel`/`chipRow` in one, `label`/`chips` in the other), so extracting normalizes their appearance very slightly. That is the intended outcome of sharing the component.

There is no React Native testing library in `devDependencies`, so this task is verified by typecheck, lint, and the pure helpers — which is why `payFieldsToCents` delegates to the already-tested `rateInputToCents` rather than parsing anything itself.

- [ ] **Step 1: Create the component**

Create `src/components/pay-fields.tsx`:

```tsx
import { StyleSheet, Text, TextInput, View } from 'react-native';

import { CategoryChip } from '@/components/category-chip';
import { formatPayRateLong, rateInputToCents, type RateEntryUnit } from '@/lib/pay-rate';
import type { StaffMember } from '@/types/models';

// The pay form, shared by the two modals that can edit pay. It was duplicated
// verbatim in both; adding the entry-unit control would have tripled that.
//
// The live "$3,000.00 / month · $36,000.00 / year" line under the input is the
// point of this component, not decoration: a bare number with no unit is the
// bug this whole change exists to remove, and showing both figures as they
// type is what stops it coming back.

export type PayFieldsValue = {
  payType: StaffMember['payType'];
  rate: string;
  entryUnit: RateEntryUnit;
};

const PAY_TYPES = ['hourly', 'salary', 'fixed'] as const;
const ENTRY_UNITS: { unit: RateEntryUnit; label: string }[] = [
  { unit: 'weekly', label: 'Week' },
  { unit: 'monthly', label: 'Month' },
  { unit: 'yearly', label: 'Year' },
];

// Stored rates are already monthly, so an existing member always opens on
// Month -- what they see is exactly what is stored.
export function payFieldsInitial(member: StaffMember): PayFieldsValue {
  return {
    payType: member.payType,
    rate: member.payRateCents != null ? (member.payRateCents / 100).toString() : '',
    entryUnit: 'monthly',
  };
}

export function payFieldsToCents(value: PayFieldsValue): number | null {
  return rateInputToCents(value.rate, value.payType, value.entryUnit);
}

export function PayFields({
  value,
  onChange,
}: {
  value: PayFieldsValue;
  onChange: (next: PayFieldsValue) => void;
}) {
  const monthlyPreview = payFieldsToCents(value);
  const rateIsValid = !value.rate.trim() || !Number.isNaN(Number(value.rate.replace(/[^0-9.]/g, '')));

  return (
    <View>
      <Text style={styles.label}>PAY TYPE</Text>
      <View style={styles.chips}>
        {PAY_TYPES.map((type) => (
          <CategoryChip
            key={type}
            label={type[0].toUpperCase() + type.slice(1)}
            active={value.payType === type}
            onPress={() => onChange({ ...value, payType: type })}
          />
        ))}
      </View>

      <Text style={styles.label}>PAY RATE (DOLLARS)</Text>
      <TextInput
        value={value.rate}
        onChangeText={(rate) => onChange({ ...value, rate })}
        keyboardType="decimal-pad"
        placeholder={value.payType === 'hourly' ? 'e.g. 8.50' : 'e.g. 3000'}
        placeholderTextColor="#999999"
        style={styles.input}
      />

      {/* Salary is the only type with an ambiguous unit -- hourly is per hour
          and fixed is per pay run, both by definition. */}
      {value.payType === 'salary' && (
        <>
          <Text style={styles.label}>AMOUNT ENTERED IS PER</Text>
          <View style={styles.chips}>
            {ENTRY_UNITS.map(({ unit, label }) => (
              <CategoryChip
                key={unit}
                label={label}
                active={value.entryUnit === unit}
                onPress={() => onChange({ ...value, entryUnit: unit })}
              />
            ))}
          </View>
        </>
      )}

      {value.rate.trim() !== '' && rateIsValid && monthlyPreview !== null && (
        <Text style={styles.preview}>{formatPayRateLong(value.payType, monthlyPreview)}</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  label: { color: '#999999', fontSize: 10, fontWeight: '800', letterSpacing: 0.6, marginTop: 12, marginBottom: 6 },
  input: { backgroundColor: '#F2F2F2', height: 42, borderRadius: 10, paddingHorizontal: 12, color: '#111111' },
  chips: { flexDirection: 'row', gap: 8, paddingBottom: 2 },
  preview: { color: '#444444', fontSize: 12, fontWeight: '700', marginTop: 8 },
});
```

The spec's module sketch also listed a `fromMonthlyCents` helper for rendering a stored rate back in a non-monthly unit. It is deliberately not built: `payFieldsInitial` always opens on Month, because the stored figure *is* monthly, so nothing would ever call it. Add it in 1b if a real caller appears.

- [ ] **Step 2: Wire into `edit-pay-modal.tsx`**

Replace the `CategoryChip` import (line 4) with:

```tsx
import { PayFields, payFieldsInitial, payFieldsToCents, type PayFieldsValue } from '@/components/pay-fields';
```

Replace the two pay state hooks (lines 19-20) with:

```tsx
  const [pay, setPay] = useState<PayFieldsValue>(payFieldsInitial(member));
```

In the `useEffect` reset block, replace the `setPayType` / `setRate` lines with:

```tsx
      setPay(payFieldsInitial(member));
```

In `save`, replace the validation and the `onSave` payload with:

```tsx
    const rateCents = payFieldsToCents(pay);
    if (pay.rate.trim() && rateCents === null) {
      setError('Enter a valid pay rate, or leave it blank.');
      return;
    }
    setSaving(true);
    try {
      await onSave({
        hireDate: hireDate.trim() || null,
        payType: pay.payType ?? null,
        payRateCents: rateCents,
      });
```

Replace the PAY TYPE and PAY RATE markup (lines 72-84, from `<Text style={[styles.fieldLabel, { marginTop: 10 }]}>PAY TYPE</Text>` through the rate `<TextInput ... />`) with:

```tsx
          <PayFields value={pay} onChange={setPay} />
```

- [ ] **Step 3: Wire into `team-member-edit-modal.tsx`**

Replace the `CategoryChip` import (line 4) with:

```tsx
import { PayFields, payFieldsInitial, payFieldsToCents, type PayFieldsValue } from '@/components/pay-fields';
```

`CategoryChip` is no longer used in this file — confirm with `grep -n CategoryChip src/components/team-member-edit-modal.tsx` and remove the import entirely if there are no remaining uses.

Replace the two pay state hooks (lines 32-33) with:

```tsx
  const [pay, setPay] = useState<PayFieldsValue>(payFieldsInitial(member));
```

In `save`, replace the rate validation (lines 43-46) with:

```tsx
    const rateCents = payFieldsToCents(pay);
    if (pay.rate.trim() && rateCents === null) {
      setError('Enter a valid pay rate.');
      return;
    }
```

and the `payType` / `payRateCents` fields of the `onSave` payload with:

```tsx
        payType: pay.payType ?? null,
        payRateCents: rateCents,
```

Replace the PAY TYPE and PAY RATE markup inside the `canManagePayroll` fragment (lines 103-112) with:

```tsx
                <PayFields value={pay} onChange={setPay} />
```

- [ ] **Step 4: Typecheck and lint**

Run: `npx tsc --noEmit && npx expo lint`
Expected: no TypeScript output; no lint errors. An "unused import" error here means a `CategoryChip` or `toCents` import survived — delete it.

- [ ] **Step 5: Run the suite**

Run: `npx jest`
Expected: `Test Suites: 12 passed, 12 total`.

- [ ] **Step 6: Commit**

```bash
git add src/components/pay-fields.tsx src/components/edit-pay-modal.tsx src/components/team-member-edit-modal.tsx
git commit -m "feat: shared pay form with a week/month/year entry converter

The pay form was duplicated verbatim across both modals that can edit
pay; adding the entry-unit control would have tripled that. Extracted to
PayFields, which also shows the entered amount live as both a monthly
and an annual figure.

The entry unit is not stored -- it only converts on the way in, so there
is no second field that can fall out of sync with the rate."
```

---

### Task 4: Label every surface that displays a pay rate

The last place the ambiguity can survive is a rendered number with no unit.

**Files:**
- Modify: `src/app/(admin)/(tabs)/people.tsx:61-65` (CSV), `:713-717` (payroll value)
- Modify: `src/components/staff-self-service.tsx:88-89`
- Modify: `src/components/accounting/payroll-run-editor.tsx:153-158`

**Interfaces:**
- Consumes: `formatPayRate`, `formatPayRateLong`, `payRateUnitLabel` from `@/lib/pay-rate` (Task 1).
- Produces: nothing. This is the last task.

- [ ] **Step 1: Fix the `/ year` label and the CSV export**

In `src/app/(admin)/(tabs)/people.tsx`, add to the imports:

```tsx
import { formatPayRate, formatPayRateLong, payRateUnitLabel } from '@/lib/pay-rate';
```

Replace the pay columns (lines 63-64) with:

```tsx
  { header: 'Pay Type', value: (m) => m.payType ?? '' },
  { header: 'Pay Rate', value: (m) => (m.payRateCents != null ? formatCents(m.payRateCents) : '') },
  // The file leaves the app and loses every bit of context that would
  // otherwise say what the number means, so the unit travels with it.
  { header: 'Pay Rate Unit', value: (m) => payRateUnitLabel(m.payType) },
```

Replace the payroll value expression (lines 713-717) — this is the `/ year` label that caused the bug:

```tsx
        <Text style={tabStyles.payrollValue}>
          {!canManagePayroll ? 'Hidden' : formatPayRateLong(member.payType, member.payRateCents)}
        </Text>
```

`formatPayRateLong` returns `'—'` when either value is null, which replaces the old `'Not set'` string. If you would rather keep that wording, branch on `member.payRateCents == null` before calling it.

- [ ] **Step 2: Label the employee's own view**

In `src/components/staff-self-service.tsx`, add to the imports:

```tsx
import { formatPayRate } from '@/lib/pay-rate';
```

Replace the pay rate tile (line 89) with:

```tsx
        <StatTile value={formatPayRate(member.payType, member.payRateCents)} label="Pay rate" />
```

An employee reading their own rate needs the unit at least as much as an owner does.

- [ ] **Step 3: Label the pay run basis line**

In `src/components/accounting/payroll-run-editor.tsx`, add to the imports:

```tsx
import { formatPayRate } from '@/lib/pay-rate';
```

Replace the `basis` expression (lines 153-158) with:

```tsx
  const basis =
    line.payType === 'hourly'
      ? `${line.hoursWorked ?? 0}h at ${line.payRateCents !== null ? formatAccountingCents(line.payRateCents) : '—'}/h`
      : line.payType
        ? `${line.payType === 'salary' ? 'Salary' : 'Fixed'} · ${formatPayRate(line.payType, line.payRateCents)}`
        : 'No pay rate set';
```

A posted run should record what its figures meant, not just what they were.

- [ ] **Step 4: Verify nothing renders a bare rate any more**

Run: `grep -rn "payRateCents" src/components src/app`
Expected: every remaining hit either passes through a `pay-rate.ts` formatter, is a state assignment, or is a null check. Any surviving `formatCents(...payRateCents...)` outside the CSV column is a missed surface — the CSV keeps `formatCents` deliberately, because its unit is carried in a separate column.

- [ ] **Step 5: Full verification**

Run: `npx jest && npx tsc --noEmit && npx expo lint`
Expected: `Test Suites: 12 passed, 12 total`, no TypeScript output, no lint errors.

- [ ] **Step 6: Commit**

```bash
git add "src/app/(admin)/(tabs)/people.tsx" src/components/staff-self-service.tsx src/components/accounting/payroll-run-editor.tsx
git commit -m "fix: show the unit everywhere a pay rate is displayed

people.tsx rendered salary as '/ year' while the stored figure was
monthly -- the mislabel that made the underlying bug possible. Every
surface now formats through pay-rate.ts, and the staff CSV carries a
Pay Rate Unit column so the number survives leaving the app."
```

---

## Done when

- `npx jest` reports 12 suites passing, including the new `pay-rate.test.ts`.
- `npx tsc --noEmit` and `npx expo lint` are clean.
- A 300,000-cent monthly salary over a whole calendar month drafts as exactly 300,000, in a 28-, 30-, and 31-day month.
- An hourly member's drafted amount is unchanged from before this work.
- No surface displays a pay rate without its unit.

## Deliberately not done here

Per the spec, these belong to follow-up work and must not be added:

- **Pay cadence, pay-period generation, the `post_payroll_run` overlap-guard rework, and the accrual changes** — spec 1b. In particular `uncoveredDays` and `accruedLaborCents` are untouched by this plan.
- **Store hours** and **team scheduling** — specs 2 and 3.
- **Detecting or repairing existing rows entered as annual figures.** Explicitly declined by the owner ("we don't have that many users, just fix it from now on").
