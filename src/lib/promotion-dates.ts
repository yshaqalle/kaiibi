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

// ---------------------------------------------------------------------------
// THE SHOP'S CALENDAR DAY -- for anything a CUSTOMER reads.
//
// EVERYTHING ABOVE THIS LINE RESOLVES IN THE DEVICE'S TIMEZONE, AND MUST KEEP
// DOING SO. That pair is the promotions DATE PICKER's inverse: an owner picks
// "the 17th" on their own phone, it is stored as local midnight of the 18th,
// and the picker reads it back as the 17th. Breaking that symmetry would move
// every existing promotion's dates in the editor. The helpers below are an
// ADDITION, not a replacement.
//
// WHAT THEY ARE FOR. The shop's public storefront prints an offer's window to
// customers (src/lib/poster.ts's windowLine, reached from the flyer band).
// Resolved in the reader's timezone, a customer in London or Minneapolis --
// and Somaliland shops have a real diaspora audience -- is shown a different
// day from the one the offer actually runs, because a window stored as
// Mogadishu midnight is still the previous afternoon anywhere west of UTC+3.
// The shop's day is the only day that is true for every reader.
//
// 'Africa/Mogadishu' IS A PLATFORM CONSTANT, exactly as it is in
// supabase/migrations/20260908000320_shop_local_date.sql -- read that file's
// header before touching this. Every market kaiibi serves is UTC+3, there is
// deliberately NO shops.timezone column, and that was considered and declined
// rather than missed. When kaiibi sells into a market that is not UTC+3, that
// function and this constant are the two places that change together.
//
// WHY A FIXED OFFSET AND NOT Intl.DateTimeFormat({ timeZone }). East Africa
// Time has been +03:00 with no daylight saving since 1931, so for every
// instant this app can hold, the offset IS the zone -- exactly, not
// approximately. A fixed offset also cannot depend on the JS runtime shipping
// a full timezone database, which Hermes on an older Android build does not
// guarantee. The equivalence is not left as an assertion in a comment:
// promotion-dates.test.ts checks these helpers against Intl's own
// 'Africa/Mogadishu' across a year of instants, so if it ever stops holding
// the suite says so rather than the page quietly shifting a day.
export const SHOP_TIME_ZONE = 'Africa/Mogadishu';

const SHOP_UTC_OFFSET_MS = 3 * 60 * 60 * 1000;
// One shop day is always exactly this, which is true here and only here:
// arithmetic in elapsed milliseconds is exact in a zone with no DST.
const SHOP_DAY_MS = 24 * 60 * 60 * 1000;

// The 'YYYY-MM-DD' of the shop's local day an instant falls on.
//
// Read with the getUTC* accessors AFTER shifting, never the local ones: a
// shifted instant's UTC fields ARE the shop's wall clock by construction, and
// give the same answer on every device. Using getFullYear/getMonth/getDate
// here would put the reader's zone straight back in.
function shopDateInput(instantMs: number): string {
  const shifted = new Date(instantMs + SHOP_UTC_OFFSET_MS);
  const year = shifted.getUTCFullYear();
  const month = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const day = String(shifted.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// ISO instant -> 'YYYY-MM-DD' of the SHOP's day it falls on. The customer-
// facing counterpart of instantToStartDateInput: same meaning, resolved in
// the shop's zone instead of the reader's.
export function instantToShopStartDate(iso: string): string {
  return shopDateInput(Date.parse(iso));
}

// ISO instant -> 'YYYY-MM-DD' of the shop's day BEFORE the one the instant
// falls on. The customer-facing counterpart of instantToEndDateInput, and it
// keeps that function's stored-exclusive/shown-inclusive reversal intact: an
// offer stored as ending at midnight on the 17th ran through the whole of the
// 16th, and the 16th is what a customer needs to read. The subtraction
// happens in elapsed time before the shop's day is read off, so the shift and
// the reversal cannot interact to move the answer by a day.
export function instantToShopEndDate(iso: string): string {
  return shopDateInput(Date.parse(iso) - SHOP_DAY_MS);
}
