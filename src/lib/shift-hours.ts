import type { TimeEntry } from '@/types/models';

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
