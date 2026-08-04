import { fromDateColumn, toDateColumn } from '@/lib/period';
import { isConfigured, isRangeWithinHours, weekdayKeyFor, type OpeningHours } from '@/lib/store-hours';

// Shift validation and week arithmetic.
//
// Pure -- no Supabase import -- so it loads under Jest like store-hours.ts and
// pay-periods.ts. The week view and the shift editor are thin consumers, which
// is deliberate: there is no React Native testing library in this repo, so
// logic in a component is logic no test can reach.

export type ShiftDraft = { shopMemberId: string; date: string; start: string; end: string };

export type Shift = ShiftDraft & { id: string; shopId: string; note: string | null };

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
      date: addDaysToDate(shift.date, 7),
      start: shift.start,
      end: shift.end,
    };

    // Checked against what is already stored AND against what this run has
    // already queued -- two source shifts can land on the same slot, and the
    // second one cannot see the first in `existing`.
    const clashes = (candidate: { shopMemberId: string; date: string; start: string; end: string }) =>
      candidate.shopMemberId === draft.shopMemberId && candidate.date === draft.date && overlaps(candidate, draft);

    if (existing.some(clashes) || copy.some(clashes)) {
      skipped += 1;
      continue;
    }
    copy.push(draft);
  }

  return { copy, skipped };
}
