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

// A LIST per day: a shop that opens in the morning, shuts for lunch or prayer
// and reopens in the afternoon is several ranges on one day, and a day may
// carry as many as its owner needs. An empty list means closed; an absent key
// means never configured, which is a different thing -- see isConfigured.
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

// ---------------------------------------------------------------------------
// Split days: the rules the editor needs but the readers above don't
// ---------------------------------------------------------------------------
//
// Everything above already handled several blocks a day -- isOpenAt tests them
// all, isRangeWithinHours requires one block to contain a shift, formatDayHours
// joins them. What was missing is the writing side: two blocks must not claim
// the same minute, and two that merely touch are one block wearing a disguise.
//
// These live here rather than in the editor for the reason in this file's
// header: there is no React Native testing library in this repo, so logic in a
// component is logic no test can reach.

// `index` is which block in the day is at fault, so the editor can put the
// message under that block rather than at the top of the day -- with three or
// four blocks, an unanchored message means counting rows to find the culprit.
export type DayProblem = { index: number; message: string };

const INVALID_TIME_MESSAGE = 'Use 24-hour times like 09:00, and close after you open.';

// The first thing wrong with one day's blocks, or null. The editor calls this
// per keystroke and Save calls it per day; both want the same answer.
//
// Blocks that TOUCH are not a problem -- 13:00-17:00 and 17:00-21:00 describe
// no closure, so normalizeDay merges them rather than this refusing them.
// Rejecting a shape we can silently and correctly fix would be pedantic.
export function findDayProblem(ranges: TimeRange[]): DayProblem | null {
  // Every block is checked for validity before any is compared against
  // another: an unparseable time cannot be meaningfully ordered, so reporting
  // it as an "overlap" would send the owner looking at the wrong thing.
  const invalid = ranges.findIndex((range) => !isValidRange(range));
  if (invalid !== -1) return { index: invalid, message: INVALID_TIME_MESSAGE };

  // Compared pairwise rather than by walking a sorted copy, because the index
  // reported must point into the array the EDITOR is showing -- which is in
  // the order the owner typed, not in time order. The block reported is
  // whichever comes later in the list, since that is the one just edited.
  for (let i = 0; i < ranges.length; i += 1) {
    for (let j = 0; j < i; j += 1) {
      const later = ranges[i];
      const earlier = ranges[j];
      if (minutesOf(later.open) < minutesOf(earlier.close) && minutesOf(earlier.open) < minutesOf(later.close)) {
        return {
          index: i,
          message: `This overlaps ${earlier.open} – ${earlier.close}. Start at ${earlier.close} or later.`,
        };
      }
    }
  }
  return null;
}

// Sorts a day's blocks and merges any that touch or overlap. Called on save,
// not on every keystroke -- reordering a block under the cursor while someone
// is still typing it would be hostile.
//
// An invalid block short-circuits the whole day back out untouched: sorting and
// merging garbage produces different garbage, and the owner's typing must stay
// on screen for them to fix. Callers gate Save on findDayProblem, so this is a
// guard against a bug rather than a path the UI takes.
export function normalizeDay(ranges: TimeRange[]): TimeRange[] {
  if (ranges.some((range) => !isValidRange(range))) return ranges;

  const sorted = [...ranges].sort((a, b) => minutesOf(a.open) - minutesOf(b.open));
  const merged: TimeRange[] = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    // `>=` rather than `>`: touching merges too, which is the whole point.
    if (last && minutesOf(range.open) <= minutesOf(last.close)) {
      // The later close wins. Overlaps only reach here past findDayProblem,
      // and extending to the later close never invents opening time nobody
      // typed -- it keeps both blocks' claims.
      if (minutesOf(range.close) > minutesOf(last.close)) merged[merged.length - 1] = { ...last, close: range.close };
      continue;
    }
    merged.push(range);
  }
  return merged;
}

// normalizeDay across a week. Only keys already present are touched: adding a
// day would turn "never configured" into "closed", which is exactly the
// distinction isConfigured exists to preserve.
export function normalizeHours(hours: OpeningHours): OpeningHours {
  const next: OpeningHours = {};
  for (const day of Object.keys(hours) as WeekdayKey[]) {
    next[day] = normalizeDay(hours[day] ?? []);
  }
  return next;
}

// What a day looks like the moment its owner first gives it hours.
export const DEFAULT_RANGE: TimeRange = { open: '09:00', close: '18:00' };

function timeAt(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

const END_OF_DAY = 23 * 60 + 59;

// The block "+ Add hours" should start with. An afternoon block after a morning
// one, rather than a second copy of the default that would sit on top of it.
//
// It deliberately leaves an hour's closure after the last block rather than
// starting where that one ends: a touching block is one normalizeDay would
// immediately merge away, so the owner would tap Add and watch nothing appear.
export function suggestNextRange(ranges: TimeRange[]): TimeRange {
  const valid = ranges.filter(isValidRange);
  if (valid.length === 0) return DEFAULT_RANGE;

  const latestClose = Math.max(...valid.map((range) => minutesOf(range.close)));
  const open = latestClose + 60;
  // No room left in the day. Falling back to the default puts a block on screen
  // that visibly overlaps, which findDayProblem then explains -- better than
  // Add doing nothing, or than inventing a backwards range.
  if (open >= END_OF_DAY) return DEFAULT_RANGE;
  return { open: timeAt(open), close: timeAt(Math.min(open + 240, END_OF_DAY)) };
}

// The closures BETWEEN a day's blocks -- what the editor shows as
// "Closed 13:00 – 17:00" under a split day. The gap is the point of splitting a
// day, so it is worth stating rather than leaving the owner to infer it from
// two rows of numbers.
//
// Empty for a single block, for touching blocks (no closure to describe), and
// for any day carrying an invalid block, since a gap computed from a time that
// does not parse would be nonsense.
export function gapsBetween(ranges: TimeRange[]): TimeRange[] {
  if (ranges.some((range) => !isValidRange(range))) return [];
  const sorted = [...ranges].sort((a, b) => minutesOf(a.open) - minutesOf(b.open));
  const gaps: TimeRange[] = [];
  for (let i = 1; i < sorted.length; i += 1) {
    if (minutesOf(sorted[i].open) > minutesOf(sorted[i - 1].close)) {
      gaps.push({ open: sorted[i - 1].close, close: sorted[i].open });
    }
  }
  return gaps;
}
