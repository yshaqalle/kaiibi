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

// The function team scheduling calls to check a shift falls inside opening
// hours. Inclusive of `open`, EXCLUSIVE of `close`: a shift ending at closing
// time is valid, which is the whole reason the boundary is pinned down.
//
// Invalid ranges are skipped rather than trusted -- a malformed row must not
// accidentally report the shop open.
export function isOpenAt(hours: OpeningHours, at: Date): boolean {
  const minutes = at.getHours() * 60 + at.getMinutes();
  return rangesFor(hours, weekdayKeyFor(at)).some(
    (range) => isValidRange(range) && minutes >= minutesOf(range.open) && minutes < minutesOf(range.close)
  );
}

// 24-hour, matching storage. Deliberately not toLocaleTimeString: a
// locale-dependent format would make these tests depend on the machine's
// locale, and it keeps what is shown identical to what is stored.
export function formatDayHours(ranges: TimeRange[]): string {
  const valid = ranges.filter(isValidRange);
  if (valid.length === 0) return 'Closed';
  return valid.map((range) => `${range.open} – ${range.close}`).join(', ');
}
