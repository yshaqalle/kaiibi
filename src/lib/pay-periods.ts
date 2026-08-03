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
