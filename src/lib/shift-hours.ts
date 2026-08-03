import type { TimeEntry, TimeOffRequest } from '@/types/models';

// Shift-duration arithmetic, split out of time-entries.ts so payroll can use
// it without dragging in the Supabase client (which needs a native runtime and
// so can't load under Jest). time-entries.ts re-exports this, leaving its
// existing callers untouched.

// Open shifts (clockOut null) are excluded from the total -- an in-progress
// shift isn't "hours worked" yet; callers show those separately as "on shift
// now" if needed.
export function sumDurationHours(entries: TimeEntry[]): number {
  const totalMs = entries.reduce((sum, entry) => {
    if (!entry.clockOut) return sum;
    return sum + (new Date(entry.clockOut).getTime() - new Date(entry.clockIn).getTime());
  }, 0);
  return totalMs / (1000 * 60 * 60);
}

// Who is on approved leave covering a given day. Shared by the Team roster and
// the Dashboard so the two can't disagree about who's off — a denied or
// still-pending request is not leave, and a request either side of today
// doesn't count.
export function onLeaveMemberIds(requests: TimeOffRequest[], today: Date = new Date()): Set<string> {
  const day = toLocalDateString(today);
  const onLeave = new Set<string>();
  for (const request of requests) {
    if (request.status !== 'approved') continue;
    // dateRanges carries the real (possibly non-contiguous) selection;
    // startDate/endDate are just its outer bounds, so a request spanning two
    // separate weeks would otherwise mark the gap between them as leave.
    const ranges = request.dateRanges?.length
      ? request.dateRanges
      : [{ startDate: request.startDate, endDate: request.endDate }];
    if (ranges.some((r) => r.startDate <= day && r.endDate >= day)) onLeave.add(request.shopMemberId);
  }
  return onLeave;
}

// Shifts left open from an earlier day — someone forgot to clock out. Worth
// surfacing because sumDurationHours excludes open shifts, so the hours (and
// any pay computed from them) quietly under-report with no visible cause.
export function staleOpenShifts(entries: TimeEntry[], today: Date = new Date()): TimeEntry[] {
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  return entries.filter((entry) => !entry.clockOut && new Date(entry.clockIn).getTime() < startOfToday);
}

// Distinct members who clocked in today, open shifts included — being on shift
// right now is exactly what this is asking about.
export function membersActiveToday(entries: TimeEntry[], today: Date = new Date()): number {
  const day = toLocalDateString(today);
  const ids = new Set<string>();
  for (const entry of entries) {
    if (toLocalDateString(new Date(entry.clockIn)) === day) ids.add(entry.shopMemberId);
  }
  return ids.size;
}

// Local `YYYY-MM-DD`, matching how time_off_requests stores its dates.
// Deliberately not toISOString(), which converts to UTC first and would shift
// the day for anyone west of Greenwich.
function toLocalDateString(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}
