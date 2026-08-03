// One implementation of "what day does this belong to" for reporting.
//
// Accounting mixes two storage shapes: sales are timestamps (`sales.created_at`,
// timestamptz) while expenses/invoices are plain dates (`occurred_on`,
// `issued_on`). Without a shared boundary rule an 11pm sale and an expense
// dated the same evening can land in different periods, and totals shift
// depending on the viewer's timezone.
//
// The rule here is the *device's local day*, matching what a shop owner means
// by "today" and what `RangeSelector` already produces (it zeroes hours on
// `since` and sets 23:59:59.999 on `until`). This formalises that rather than
// changing it. A true shop-timezone setting would be better for a shop whose
// staff travel, but there's no such field on `Shop` today -- when there is,
// this is the only file that needs to learn about it.

// Stable key for bucketing a timestamp into a day. Matches the
// `Date.toDateString()` keying `getDailyTotalsCents` already uses, so existing
// buckets keep working.
export function dayKeyFor(value: Date | string): string {
  return toDate(value).toDateString();
}

// Local midnight at the start of the given day.
export function startOfDay(value: Date | string): Date {
  const date = toDate(value);
  date.setHours(0, 0, 0, 0);
  return date;
}

// Last representable instant of the given day, for inclusive `lte` range
// filters. Using 23:59:59.999 (rather than the next day's midnight with a
// `lt`) keeps this symmetric with RangeSelector's existing `applyCustom`.
export function endOfDay(value: Date | string): Date {
  const date = toDate(value);
  date.setHours(23, 59, 59, 999);
  return date;
}

// Normalises any range to whole local days: start-of-first-day through
// end-of-last-day. `until` is optional throughout the reporting libs (an
// open-ended range means "up to now"), and stays undefined here so callers can
// keep omitting the upper bound from their queries.
export function normalizeRange(since: Date, until?: Date): { since: Date; until?: Date } {
  return { since: startOfDay(since), until: until ? endOfDay(until) : undefined };
}

// `YYYY-MM-DD` in local time, for comparing against and writing to Postgres
// `date` columns (expenses.occurred_on, invoices.issued_on, ...).
//
// Deliberately not `toISOString().slice(0, 10)`: that converts to UTC first,
// so an evening expense west of Greenwich would be stored as the next day.
export function toDateColumn(value: Date | string): string {
  const date = toDate(value);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

// Parses a `date` column back to local midnight. `new Date('2026-08-02')`
// parses as UTC midnight, which reads as the previous day in western
// timezones -- so the parts are split out and fed to the local-time
// constructor instead.
export function fromDateColumn(value: string): Date {
  const [year, month, day] = value.split('-').map(Number);
  return new Date(year, month - 1, day);
}

// The current calendar month, for figures that are always month-scoped
// regardless of a screen's selected range (the dashboard's revenue goal,
// budget-vs-actual). Mirrors the inline arithmetic in
// `getMonthToDateRevenueCents`.
export function currentMonthRange(now: Date = new Date()): { since: Date; until: Date } {
  return {
    since: new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0),
    until: endOfDay(now),
  };
}

// Whether a `date`-column value falls inside a range, compared as whole local
// days so a same-day expense is never excluded by a time component.
export function isDateColumnInRange(value: string, since: Date, until?: Date): boolean {
  const day = fromDateColumn(value).getTime();
  if (day < startOfDay(since).getTime()) return false;
  return until === undefined || day <= endOfDay(until).getTime();
}

// Copies rather than mutating: every helper above sets hours on the result,
// and callers pass shared Date objects (RangeSelector hands the same instance
// to several tabs) that must not be altered underneath them.
function toDate(value: Date | string): Date {
  return value instanceof Date ? new Date(value.getTime()) : new Date(value);
}
