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
