// Converts between the plain 'YYYY-MM-DD' a DateInput picker works in and the
// ISO instant a `promotions.starts_at`/`ends_at` timestamptz column stores.
//
// THE BUG THIS FILE FIXES: `new Date('2026-08-15')` parses as UTC midnight,
// not local midnight. Somaliland is UTC+3, so that instant lands at 03:00
// local on the 15th -- the promotion's first three hours silently don't
// apply, and an end date built the same way expires three hours early. Every
// function here builds instants with the LOCAL-TIME `Date` constructor
// (`new Date(year, monthIndex, day)`) instead, which is what actually means
// "local midnight on this day" on whatever timezone the device is set to.
//
// THE INCLUSIVE/EXCLUSIVE ASYMMETRY (deliberate, not a bug):
//   - A start date means "from the beginning of this day" -- stored as local
//     00:00 of that day. Storage and the picker agree; no shift needed.
//   - An end date means "through the end of this day" to the owner picking
//     it, but discounts.ts's `isPromotionLive` (and complete_sale/edit_sale
//     in the database) treat `ends_at` as the INSTANT the offer stops,
//     checking `ends_at <= now`. So "ends Saturday" is stored as local 00:00
//     of SUNDAY -- the moment Saturday actually ends -- and shown back to the
//     owner as Saturday by subtracting a day. Stored exclusive, displayed
//     inclusive.
//
// This is also why a same-day offer ("Friday only") is legal: starts_at is
// Friday 00:00 and ends_at is Saturday 00:00, so ends_at > starts_at always
// holds, satisfying the `promotions_window_ordered` constraint.

function parseDateInput(dateInput: string): { year: number; month: number; day: number } {
  const [year, month, day] = dateInput.split('-').map(Number);
  return { year, month: month - 1, day };
}

function formatDateInput(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// 'YYYY-MM-DD' -> ISO instant at local midnight of that day.
export function startDateInputToInstant(dateInput: string): string {
  const { year, month, day } = parseDateInput(dateInput);
  return new Date(year, month, day).toISOString();
}

// ISO instant -> 'YYYY-MM-DD' of the local day it falls on. Inverse of
// startDateInputToInstant; no shift, since a start is stored exactly as picked.
export function instantToStartDateInput(iso: string): string {
  return formatDateInput(new Date(iso));
}

// 'YYYY-MM-DD' -> ISO instant at local midnight of the day AFTER the one
// picked -- the moment the chosen day ends, which is what an inclusive
// "ends Saturday" actually means when `ends_at <= now` decides expiry.
export function endDateInputToInstant(dateInput: string): string {
  const { year, month, day } = parseDateInput(dateInput);
  return new Date(year, month, day + 1).toISOString();
}

// ISO instant -> 'YYYY-MM-DD' of the local day BEFORE the one the instant
// falls on. Inverse of endDateInputToInstant: reverses the +1 day shift so
// the picker shows back the last inclusive day the offer actually runs.
export function instantToEndDateInput(iso: string): string {
  const stored = new Date(iso);
  return formatDateInput(new Date(stored.getFullYear(), stored.getMonth(), stored.getDate() - 1));
}
