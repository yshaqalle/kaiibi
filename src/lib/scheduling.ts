import { fromDateColumn, toDateColumn } from '@/lib/period';
import { isConfigured, isRangeWithinHours, weekdayKeyFor, type OpeningHours } from '@/lib/store-hours';

// Shift validation and week arithmetic.
//
// Pure -- no Supabase import -- so it loads under Jest like store-hours.ts and
// pay-periods.ts. The week view and the shift editor are thin consumers, which
// is deliberate: there is no React Native testing library in this repo, so
// logic in a component is logic no test can reach.

export type ShiftDraft = { shopMemberId: string; date: string; start: string; end: string; locationId: string; note?: string | null };

// One block of a day. A split day is two of these -- 09:00-13:00 and
// 17:00-21:00 -- which the schema has always allowed (one row per block) and
// `overlaps` has always permitted, since touching at a boundary is not a clash.
export type ShiftBlock = { start: string; end: string };

// `locationId` is which store the shift is worked at (migration
// 20260815000000). Always set: it is what `validateShift` resolves opening
// hours from, so a shift at the Berbera store is judged against Berbera's
// hours rather than whichever store the device happens to be showing.
export type Shift = ShiftDraft & { id: string; shopId: string; locationId: string; note: string | null };

export type ShiftProblem = {
  kind: 'overlap' | 'outside_hours' | 'on_leave';
  // Only an overlap blocks. The other two are legitimate often enough to inform
  // rather than forbid: a stock-take before opening is a real shift, and leave
  // gets rearranged. Same split as the payroll draft warnings.
  blocking: boolean;
  message: string;
};

export type ValidationContext = {
  hours: OpeningHours;
  // Members on approved leave ON THE SHIFT'S DATE -- built by the caller with
  // onLeaveMemberIds() from shift-hours.ts, which already handles
  // non-contiguous ranges.
  onLeave: Set<string>;
  // Every shift already stored for the shift's date, any member.
  sameDayShifts: Shift[];
};

// Times are zero-padded fixed-width 'HH:MM', so string comparison is
// chronological and needs no conversion to minutes.
//
// Touching at the boundary is NOT an overlap: 09:00-13:00 and 13:00-17:00 are
// both valid, which is how back-to-back shifts work and mirrors the
// exclusive-close convention in store-hours.
function overlaps(a: { start: string; end: string }, b: { start: string; end: string }): boolean {
  return a.start < b.end && b.start < a.end;
}

function toMinutes(time: string): number {
  const [hours, minutes] = time.split(':').map(Number);
  return hours * 60 + minutes;
}

// Stepping by whole local days. Deliberately NOT `time + n * 86400000`: across
// a daylight-saving boundary that lands at 23:00 the previous day, and
// toDateColumn would then report the wrong date.
export function addDaysToDate(date: string, days: number): string {
  const parsed = fromDateColumn(date);
  return toDateColumn(new Date(parsed.getFullYear(), parsed.getMonth(), parsed.getDate() + days));
}

export function validateShift(draft: ShiftDraft, context: ValidationContext): ShiftProblem[] {
  const problems: ShiftProblem[] = [];

  const clash = context.sameDayShifts.find(
    (other) => other.shopMemberId === draft.shopMemberId && other.date === draft.date && overlaps(draft, other)
  );
  if (clash) {
    problems.push({
      kind: 'overlap',
      blocking: true,
      message: `Overlaps an existing ${clash.start}–${clash.end} shift for this person.`,
    });
  }

  // Skipped entirely when the shop has never set hours. opening_hours defaults
  // to {} with no backfill, so without this guard every shop that hasn't opened
  // Settings would warn on every shift it ever created.
  if (isConfigured(context.hours)) {
    const day = weekdayKeyFor(fromDateColumn(draft.date));
    if (!isRangeWithinHours(context.hours, day, { open: draft.start, close: draft.end })) {
      problems.push({
        kind: 'outside_hours',
        blocking: false,
        message: "Outside the shop's opening hours for that day.",
      });
    }
  }

  if (context.onLeave.has(draft.shopMemberId)) {
    problems.push({
      kind: 'on_leave',
      blocking: false,
      message: 'This person has approved time off that day.',
    });
  }

  return problems;
}

export function hasBlockingProblem(problems: ShiftProblem[]): boolean {
  return problems.some((problem) => problem.blocking);
}

// Does this draft collide with any of `against`? Same person, same day,
// overlapping hours. Extracted from shiftsToCopy so copy-last-week, the bulk
// editor and the CSV import all ask the same question -- three implementations
// of "is this a clash" would eventually disagree, and the one that got it wrong
// would double-book someone.
export function clashesWith(
  candidate: { shopMemberId: string; date: string; start: string; end: string },
  against: readonly { shopMemberId: string; date: string; start: string; end: string }[]
): boolean {
  return against.some(
    (other) => other.shopMemberId === candidate.shopMemberId && other.date === candidate.date && overlaps(other, candidate)
  );
}

// A whole day at once: every block validated against what's already stored, and
// against its own siblings. Problems are deduplicated by kind -- two blocks
// both outside opening hours is still one thing to tell the user, and `kind` is
// what the editor uses as a React key.
//
// The blocks-against-each-other check comes first so its message wins the
// dedupe: "these two overlap" is more useful than pointing at a stored shift
// when the thing being typed is self-contradictory.
export function validateShiftBlocks(
  blocks: readonly ShiftBlock[],
  base: { shopMemberId: string; date: string; locationId: string },
  context: ValidationContext
): ShiftProblem[] {
  const problems: ShiftProblem[] = [];

  for (let i = 0; i < blocks.length; i++) {
    for (let j = i + 1; j < blocks.length; j++) {
      if (overlaps(blocks[i], blocks[j])) {
        problems.push({
          kind: 'overlap',
          blocking: true,
          message: `The ${blocks[i].start}–${blocks[i].end} and ${blocks[j].start}–${blocks[j].end} blocks overlap each other.`,
        });
      }
    }
  }

  for (const block of blocks) {
    problems.push(...validateShift({ ...base, start: block.start, end: block.end }, context));
  }

  const seen = new Set<ShiftProblem['kind']>();
  return problems.filter((problem) => {
    if (seen.has(problem.kind)) return false;
    seen.add(problem.kind);
    return true;
  });
}

// Who may be scheduled at a store. An EMPTY locationIds means every store
// (migration 20260814000000), so those people appear on every store's board --
// they are not unassigned, they are unrestricted. `null` is the "All stores"
// view, which shows everyone.
export function membersForLocation<T extends { locationIds: string[] }>(
  members: readonly T[],
  locationId: string | null
): T[] {
  if (!locationId) return [...members];
  return members.filter((member) => member.locationIds.length === 0 || member.locationIds.includes(locationId));
}

// Several people × several days × one or two blocks, in one pass. Skips
// anything that would double-book someone rather than refusing the whole batch
// -- scheduling five people over a week where one already has Tuesday should
// still fill the other 34 slots, and the count says what didn't land.
export function buildBulkShifts(
  selection: {
    memberIds: readonly string[];
    dates: readonly string[];
    blocks: readonly ShiftBlock[];
    locationId: string;
    note?: string | null;
  },
  existing: readonly { shopMemberId: string; date: string; start: string; end: string }[]
): { create: ShiftDraft[]; skipped: number } {
  const create: ShiftDraft[] = [];
  let skipped = 0;

  for (const shopMemberId of selection.memberIds) {
    for (const date of selection.dates) {
      for (const block of selection.blocks) {
        const draft: ShiftDraft = {
          shopMemberId,
          date,
          locationId: selection.locationId,
          start: block.start,
          end: block.end,
          note: selection.note ?? null,
        };
        // Checked against the queue as well as the store, for the same reason
        // shiftsToCopy does: two blocks in one selection can collide with each
        // other, and the second can't see the first in `existing`.
        if (clashesWith(draft, existing) || clashesWith(draft, create)) {
          skipped += 1;
          continue;
        }
        create.push(draft);
      }
    }
  }

  return { create, skipped };
}

export function shiftMinutes(draft: ShiftDraft): number {
  return toMinutes(draft.end) - toMinutes(draft.start);
}

// The Monday of the week containing `date`. Date.getDay() returns 0 for Sunday,
// so Sunday belongs to the week that began six days earlier.
export function startOfWeek(date: string): string {
  const parsed = fromDateColumn(date);
  const dayOfWeek = parsed.getDay();
  const daysBack = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  return addDaysToDate(date, -daysBack);
}

export function weekDaysFrom(monday: string): string[] {
  return Array.from({ length: 7 }, (_, index) => addDaysToDate(monday, index));
}

// Every shift from the previous week, moved forward seven days -- except any
// that would clash with something already there. Reports the skipped count
// rather than silently doing partial work or refusing the whole operation
// because of one clash.
export function shiftsToCopy(previous: Shift[], existing: Shift[]): { copy: ShiftDraft[]; skipped: number } {
  const copy: ShiftDraft[] = [];
  let skipped = 0;

  for (const shift of previous) {
    const draft: ShiftDraft = {
      shopMemberId: shift.shopMemberId,
      locationId: shift.locationId,
      date: addDaysToDate(shift.date, 7),
      start: shift.start,
      end: shift.end,
      // Notes deliberately do NOT travel: "covering the delivery" describes
      // last week's Tuesday, not next week's. Import and the bulk editor set
      // notes because the user typed them for the shifts being created.
    };

    // Checked against what is already stored AND against what this run has
    // already queued -- two source shifts can land on the same slot, and the
    // second one cannot see the first in `existing`.
    if (clashesWith(draft, existing) || clashesWith(draft, copy)) {
      skipped += 1;
      continue;
    }
    copy.push(draft);
  }

  return { copy, skipped };
}
