// When a shop is open, and every rule about that shape.
//
// Pure: no Supabase import, so it loads under Jest like pay-rate.ts and
// pay-periods.ts. The Settings editor and the receipt line are thin consumers,
// which is deliberate -- there is no React Native testing library in this repo,
// so logic in a component is logic no test can reach.

// Local wall-clock 'HH:MM', 24-hour, zero-padded. NOT a timestamp: a shop that
// opens at 9am opens at 9am regardless of daylight saving or the viewer's
// device timezone, and storing an instant would make that drift.
export type TimeRange = { open: string; close: string };

export type WeekdayKey = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';

// A LIST per day, though the editor offers one range. Adding a lunch or prayer
// closure later is then a UI change alone -- no migration, no data rework. An
// empty list means closed; an absent key means the same.
export type OpeningHours = Partial<Record<WeekdayKey, TimeRange[]>>;

// Indexed by Date.getDay(), which returns 0 for SUNDAY. Keeping that mapping
// in one place is why this array exists rather than arithmetic at each site.
const KEYS_BY_GET_DAY: readonly WeekdayKey[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

// Display order, which starts on Monday rather than Sunday.
export const WEEK_ORDER: readonly WeekdayKey[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

export const DAY_LABELS: Record<WeekdayKey, string> = {
  mon: 'Monday',
  tue: 'Tuesday',
  wed: 'Wednesday',
  thu: 'Thursday',
  fri: 'Friday',
  sat: 'Saturday',
  sun: 'Sunday',
};

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function weekdayKeyFor(date: Date): WeekdayKey {
  return KEYS_BY_GET_DAY[date.getDay()];
}

export function isValidTime(text: string): boolean {
  return TIME_PATTERN.test(text);
}

function minutesOf(time: string): number {
  const [hours, minutes] = time.split(':').map(Number);
  return hours * 60 + minutes;
}

// Overnight opening (22:00-02:00) is out of scope, so a close at or before the
// open is a typo rather than a shape to interpret.
export function isValidRange(range: TimeRange): boolean {
  if (!isValidTime(range.open) || !isValidTime(range.close)) return false;
  return minutesOf(range.close) > minutesOf(range.open);
}

export function rangesFor(hours: OpeningHours, day: WeekdayKey): TimeRange[] {
  return hours[day] ?? [];
}

// Answers about an INSTANT, not an interval. This is NOT what validates a
// shift -- checking isOpenAt at both of a shift's endpoints is wrong in both
// directions (a shift ending exactly at closing time fails the end check;
// a shift spanning a midday closure passes both endpoint checks even though
// it crosses time the shop is shut). Use isRangeWithinHours for a shift.
//
// EXCLUSIVE of `close`, unlike isRangeWithinHours below which is inclusive at
// both ends -- two functions answering related questions with different
// boundary conventions, so it is spelled out on both.
//
// Invalid ranges are skipped rather than trusted -- a malformed row must not
// accidentally report the shop open.
export function isOpenAt(hours: OpeningHours, at: Date): boolean {
  const minutes = at.getHours() * 60 + at.getMinutes();
  return rangesFor(hours, weekdayKeyFor(at)).some(
    (range) => isValidRange(range) && minutes >= minutesOf(range.open) && minutes < minutesOf(range.close)
  );
}

// The function team scheduling calls to check a shift (an INTERVAL) falls
// inside opening hours. True only when a SINGLE stored range fully contains
// the shift -- a shift spanning two ranges with a closure between them is
// false, even though isOpenAt would report both of its endpoints as open.
//
// INCLUSIVE at both ends, unlike isOpenAt above which is exclusive at
// `close`: a shift ending exactly at closing time must validate, which is
// the whole reason this boundary was pinned down separately.
export function isRangeWithinHours(hours: OpeningHours, day: WeekdayKey, shift: TimeRange): boolean {
  if (!isValidRange(shift)) return false;
  const shiftOpen = minutesOf(shift.open);
  const shiftClose = minutesOf(shift.close);
  return rangesFor(hours, day).some(
    (range) => isValidRange(range) && minutesOf(range.open) <= shiftOpen && shiftClose <= minutesOf(range.close)
  );
}

// True once the owner has touched Settings at all -- i.e. at least one
// weekday key is present, even if set to an explicit closure ([]). `{}` (the
// column default, never backfilled) is the only "not configured" shape;
// distinguishing it from "closed all week" matters because a scheduler
// validating against hours must not reject every shift for a shop that has
// simply never opened Settings.
export function isConfigured(hours: OpeningHours): boolean {
  return Object.keys(hours).length > 0;
}

// 24-hour, matching storage. Deliberately not toLocaleTimeString: a
// locale-dependent format would make these tests depend on the machine's
// locale, and it keeps what is shown identical to what is stored.
export function formatDayHours(ranges: TimeRange[]): string {
  const valid = ranges.filter(isValidRange);
  if (valid.length === 0) return 'Closed';
  return valid.map((range) => `${range.open} – ${range.close}`).join(', ');
}
