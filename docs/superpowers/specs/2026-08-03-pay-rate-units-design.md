# Pay rate units — design

**Date:** 2026-08-03
**Status:** Approved, ready for planning
**Scope:** Spec 1a of a four-spec sequence (see "Sequence" below)

## Problem

Salaried pay is ambiguous and wrong, in two compounding ways.

**The units are undefined.** `shop_members.pay_rate_cents` carries a number with
no recorded meaning. The UI tells the user it is annual — `people.tsx:716`
renders `/ year` — while the payroll math treats the same number as monthly:

```ts
// payroll-reporting.ts:79
const amountCents = Math.round((member.payRateCents * days) / NOMINAL_MONTH_DAYS);
```

with `NOMINAL_MONTH_DAYS = 30`. Anyone who typed an annual figure while reading
the label has been paid roughly 12× their intended salary, posted as a real
`salaries_wages` expense. Anyone who typed a monthly figure has been paid
correctly by accident.

**The divisor is wrong even under the monthly reading.** Dividing by a nominal
30 days means a 31-day month overpays by 3.3%. The existing test asserts this
as correct behaviour:

```ts
// payroll-reporting.test.ts:116
// 300000/mo over 2026-08-01..2026-08-31
expect(lines[0].amountCents).toBe(310000);
```

**`fixed` has no definition.** Nothing in the codebase documents how `fixed`
differs from `salary`. The math treats them identically, so today it is
`salary` under another name.

## Decisions

### Monthly is the canonical unit

For `pay_type = 'salary'`, `pay_rate_cents` means **cents per month**. Always.
No stored frequency enum, no ambiguity, nothing to fall out of sync.

Annual is derived (`× 12`) for display only.

**Why monthly rather than annual as the stored unit:** it puts rounding error
in the harmless direction. Storing annual and dividing by 12 makes no
individual payment exact — $35,000/yr ÷ 12 = $2,916.67, and twelve of those sum
to $35,000.04, so every real payment carries error. Storing monthly makes the
figure that actually leaves the bank exact, and only the derived annual display
drifts by cents.

### `salary` vs `fixed`

| Pay type | Meaning | Period behaviour |
|---|---|---|
| `hourly` | Cents per hour | Hours × rate, from clocked time. **Unchanged.** |
| `salary` | Cents per month | Exact for a whole calendar month; prorated by day otherwise |
| `fixed` | Flat amount per pay run | Never prorated, never annualized |

`fixed` gains the meaning its name implies — a stipend or allowance that is the
same every run regardless of period length. This **changes existing behaviour**:
`fixed` currently prorates by `days/30` like salary. Accepted deliberately (see
Migration below).

### No backfill

Existing rows keep their current meaning. Because the math already read
`pay_rate_cents` as monthly, declaring monthly canonical leaves every existing
pay-run amount unchanged apart from the 30-vs-actual-days correction.

Rows entered as annual figures remain 12× too high and will not be detected —
accepted on the owner's call ("we don't have that many users, just fix it from
now on"). Owners correct affected staff by re-entering the rate.

### Entry converter, not a stored frequency

The pay form offers **Week / Month / Year** as an *entry unit*. Picking "Year"
and typing 36,000 stores 3,000/month. The chosen unit is not persisted — it
only drives conversion at entry. Both figures display live beneath the input,
so the entered value is always confirmed in both units before saving.

## Architecture

### New module: `src/lib/pay-rate.ts`

Pure functions, no Supabase import, so it loads under Jest like `shift-hours.ts`
and `payroll-reporting.ts`.

```ts
type RateEntryUnit = 'weekly' | 'monthly' | 'yearly';

// Entry conversion — what the Week/Month/Year chips do.
toMonthlyCents(amountCents: number, unit: RateEntryUnit): number
fromMonthlyCents(monthlyCents: number, unit: RateEntryUnit): number

// Display.
annualCents(monthlyCents: number): number          // × 12
formatPayRate(payType, rateCents): string          // "$3,000.00 / month"
formatPayRateLong(payType, rateCents): string      // "$3,000.00 / month · $36,000.00 / year"

// Period math for salary proration.
daysInYear(year: number): number                   // 365 | 366
dailySalaryCents(monthlyCents: number, year: number): number  // fractional — see note

isWholeCalendarMonth(periodStart: string, periodEnd: string): boolean
```

Weekly conversion uses `× 52 / 12`, not `× 4` — four weeks is not a month, and
the 52-week year is what makes weekly and monthly agree annually.

### Changed: `src/lib/payroll-reporting.ts`

`NOMINAL_MONTH_DAYS` and the `/30` proration are deleted. The salary branch of
`computePayrollDraft` becomes:

- **Whole calendar month** (period is exactly the 1st to the last day of one
  month) → `amountCents = payRateCents` exactly, no warning.
- **Otherwise** → `amountCents = round(dailySalaryCents(rate, year) × days)`,
  warning `Prorated for N days — check this figure.`

`dailySalaryCents` is `monthly × 12 / daysInYear`, using the year of
`periodStart`. Uniform across months, correct across leap years, and does not
depend on which month a multi-month span started in.

**It returns a fractional value and must not round.** Rounding happens once, on
the final `amountCents`. Rounding the daily rate first and then multiplying by
day count compounds the error — up to ~15 cents over a month, which is small
but is exactly the kind of drift that makes a payroll figure fail to reconcile.

The `fixed` branch becomes `amountCents = payRateCents`, no proration, no
warning.

`hourly` is untouched, deliberately and verifiably (see Testing).

`uncoveredDays` and `accruedLaborCents` are **not** changed by this spec.

### New component: `src/components/pay-fields.tsx`

The pay form is currently duplicated verbatim in two modals —
`edit-pay-modal.tsx:74-84` and `team-member-edit-modal.tsx:103-112` both render
the same PAY TYPE chips plus PAY RATE input. Adding the entry-unit control to
both would triple the duplication, so it is extracted first.

`PayFields` owns pay type, rate, and entry unit, and renders:

```
PAY TYPE      [Hourly] [Salary] [Fixed]
PAY RATE      [ 3000.00 ]   per  [Week] [Month*] [Year]     ← salary only
              $3,000.00 / month · $36,000.00 / year          ← live
```

- The **per** chips show only for `salary`. `hourly` is per hour by definition;
  `fixed` is per run by definition.
- Default entry unit is Month.
- The live line updates as the user types and is the primary defence against
  re-introducing the ambiguity this spec exists to remove.

This is the only refactor in scope — it is the code being edited, not adjacent
cleanup.

### Display surfaces

Every place a pay rate is shown gains its unit:

| File | Change |
|---|---|
| `people.tsx:716` | `/ year` → `/ month`, annual shown alongside |
| `people.tsx:63-64` | CSV gains `Pay Rate Unit` column (`per hour` / `per month` / `per run`) |
| `staff-self-service.tsx:88-89` | Rate tile gains its unit |
| `payroll-run-editor.tsx:154-157` | Basis line `Salary · $3,000` → `Salary · $3,000/mo` |

The CSV matters most — the file leaves the app and loses all surrounding
context, so a bare "Pay Rate" column is unrecoverable ambiguity.

## Migration

One migration, documentation-only:

```sql
comment on column public.shop_members.pay_rate_cents is
  'Cents. Per hour when pay_type = hourly; per month when salary; per pay run when fixed.';
comment on column public.payroll_run_lines.pay_rate_cents is
  'Frozen copy of shop_members.pay_rate_cents. Same units.';
```

**No schema change is required.** Monthly-canonical means no new column — the
entry unit is UI-only and the meaning is a decision, not data. This is what
makes 1a low-risk enough to ship ahead of 1b.

## Testing

New `src/lib/__tests__/pay-rate.test.ts`, matching the existing pure-module test
pattern:

- Entry conversion round-trips in all three units.
- Weekly conversion uses 52/12, not 4 — asserted explicitly, since `× 4` is the
  tempting wrong answer.
- `daysInYear` across a leap year and a century non-leap year (2100).
- Annual display derives as `× 12`.

Updated `src/lib/__tests__/payroll-reporting.test.ts`:

- **The 310,000 assertion at line 116 becomes 300,000.** This is the bug fix
  landing; the test currently encodes the wrong behaviour.
- Part-period salary prorates against the real year, not 30 days.
- A whole calendar month carries no warning, in a 28-, 30-, and 31-day month.
- `fixed` pays its flat amount over a 7-day and a 31-day period, unchanged and
  unwarned.
- **Hourly regression:** an hourly member's `amountCents` is identical before
  and after this change. This spec must not move hourly pay.

## Sequence

This is spec 1a of four. Each ships independently.

1. **1a — Pay rate units** (this spec). Fixes a live money bug. Additive and
   display-only.
2. **1b — Pay cadence & periods.** Per-member `pay_cadence`, shop-level
   `pay_period_anchor`, pay-period generation, and the per-member rework of
   `post_payroll_run`'s overlap guard plus the accrual functions.
3. **2 — Store hours.**
4. **3 — Team scheduling.** Builds on store hours.

**Why 1a and 1b are split:** 1b rewrites `post_payroll_run`, the guard that
prevents paying someone twice — the most safety-critical function in the payroll
system. Bundling it with a dropdown change means both get reviewed with the same
attention, and one deserves far more. Per-member cadence also buys nothing until
someone is actually on a non-monthly cadence; with everyone on the monthly
default, runs never overlap and the existing guard is correct.

**1a does not constrain 1b.** Monthly-canonical is exactly what 1b's
`perPaymentCents = annualCents / periodsPerYear(cadence)` consumes — 1b adds a
divisor to a number 1a has already made correct. No rework.

## Out of scope

- Pay cadence, pay-period generation, the overlap guard, accrual changes — 1b.
- Store hours and team scheduling — specs 2 and 3.
- Changing how `accruedLaborCents` treats salaried staff. It excludes them today
  (`payroll-reporting.ts:122`) and continues to. Exact per-period salary makes
  accruing them possible, but that moves P&L figures and deserves its own
  decision rather than riding along.
- Detecting or repairing existing 12×-wrong rows. Explicitly declined above.
