import { dailySalaryCents, isWholeCalendarMonth } from '@/lib/pay-rate';
import { fromDateColumn, toDateColumn } from '@/lib/period';
import { sumDurationHours } from '@/lib/shift-hours';
import type { PayrollRun, StaffMember, TimeEntry } from '@/types/models';

// Pure payroll arithmetic: hours and pay rates in, draft money out. Separate
// from payroll.ts so it can be unit-tested without the Supabase client.

export type PayrollDraftLine = {
  shopMemberId: string;
  memberName: string | null;
  payType: StaffMember['payType'];
  payRateCents: number | null;
  hoursWorked: number | null;
  amountCents: number;
  // Set when the figure needs a human decision rather than being wrong --
  // surfaced in the editor so it's corrected before posting, not after.
  warning: string | null;
};

const MS_PER_DAY = 86_400_000;

// Inclusive, in whole local days: a run covering the 1st to the 7th is 7 days.
export function periodDayCount(periodStart: string, periodEnd: string): number {
  const start = fromDateColumn(periodStart).getTime();
  const end = fromDateColumn(periodEnd).getTime();
  return Math.max(1, Math.round((end - start) / MS_PER_DAY) + 1);
}

export function computePayrollDraft(
  members: StaffMember[],
  entries: TimeEntry[],
  periodStart: string,
  periodEnd: string
): PayrollDraftLine[] {
  const days = periodDayCount(periodStart, periodEnd);
  const entriesByMember = groupEntriesByMember(entries, periodStart, periodEnd);

  return members
    .filter((member) => member.active)
    .map((member) => {
      const memberEntries = entriesByMember.get(member.id) ?? [];
      // Open shifts are excluded by sumDurationHours -- an in-progress shift
      // isn't hours worked yet, and paying for it would be guessing.
      const hoursWorked = Number(sumDurationHours(memberEntries).toFixed(2));
      const openShiftCount = memberEntries.filter((e) => !e.clockOut).length;

      const base: Omit<PayrollDraftLine, 'amountCents' | 'warning'> = {
        shopMemberId: member.id,
        memberName: member.fullName,
        payType: member.payType,
        payRateCents: member.payRateCents,
        hoursWorked: member.payType === 'hourly' ? hoursWorked : null,
      };

      if (member.payRateCents === null || member.payType === null) {
        return { ...base, amountCents: 0, warning: 'No pay rate set — add one in People, or enter the amount here.' };
      }

      if (member.payType === 'hourly') {
        const amountCents = Math.round(member.payRateCents * hoursWorked);
        let warning: string | null = null;
        if (openShiftCount > 0) {
          warning = `${openShiftCount} shift${openShiftCount === 1 ? '' : 's'} still clocked in — those hours aren't included.`;
        } else if (hoursWorked === 0) {
          warning = 'No hours clocked in this period.';
        }
        return { ...base, amountCents, warning };
      }

      // Flat per pay run, whatever the period length -- that is what makes
      // 'fixed' a different thing from 'salary' rather than a second name
      // for it. A stipend or allowance is the case this serves.
      if (member.payType === 'fixed') {
        return { ...base, amountCents: member.payRateCents, warning: null };
      }

      // A monthly salary over exactly one calendar month is exact: no
      // proration, no approximation, nothing for a human to check.
      if (isWholeCalendarMonth(periodStart, periodEnd)) {
        return { ...base, amountCents: member.payRateCents, warning: null };
      }

      // Anything else is a genuine part period. Spread across the real year
      // rather than a nominal 30-day month, so month length can't distort it,
      // and round once at the end.
      const year = fromDateColumn(periodStart).getFullYear();
      const amountCents = Math.round(dailySalaryCents(member.payRateCents, year) * days);
      return {
        ...base,
        amountCents,
        warning: `Prorated for ${days} day${days === 1 ? '' : 's'} — check this figure.`,
      };
    });
}

export function draftTotalCents(lines: { amountCents: number }[]): number {
  return lines.reduce((sum, line) => sum + line.amountCents, 0);
}

// Days in the range not already covered by a posted run. This is what makes
// accrued-but-unpaid labour safe to add to the P&L: the moment a run is
// posted, its days drop out here and its expense row takes over, so the two
// can never both count the same day.
export function uncoveredDays(since: Date, until: Date, postedRuns: PayrollRun[]): string[] {
  const covered = new Set<string>();
  for (const run of postedRuns) {
    if (run.status !== 'posted') continue;
    let cursor = fromDateColumn(run.periodStart).getTime();
    const end = fromDateColumn(run.periodEnd).getTime();
    while (cursor <= end) {
      covered.add(toDateColumn(new Date(cursor)));
      cursor += MS_PER_DAY;
    }
  }

  const days: string[] = [];
  let cursor = new Date(since.getFullYear(), since.getMonth(), since.getDate()).getTime();
  const last = new Date(until.getFullYear(), until.getMonth(), until.getDate()).getTime();
  while (cursor <= last) {
    const key = toDateColumn(new Date(cursor));
    if (!covered.has(key)) days.push(key);
    cursor += MS_PER_DAY;
  }
  return days;
}

// Labour worked on days no posted run covers -- the accrual figure. Hourly
// only: prorating a salary across an arbitrary uncovered stretch would be a
// guess presented as a number, so salaried staff are reported as a count
// instead and left for the pay run to settle.
export function accruedLaborCents(
  members: StaffMember[],
  entries: TimeEntry[],
  uncovered: string[]
): { accruedCents: number; hours: number; salariedExcludedCount: number } {
  if (uncovered.length === 0) {
    return { accruedCents: 0, hours: 0, salariedExcludedCount: 0 };
  }
  const uncoveredSet = new Set(uncovered);
  const rateByMember = new Map(members.map((m) => [m.id, m]));

  let accruedCents = 0;
  let hours = 0;
  for (const entry of entries) {
    if (!entry.clockOut) continue;
    if (!uncoveredSet.has(toDateColumn(new Date(entry.clockIn)))) continue;
    const member = rateByMember.get(entry.shopMemberId);
    if (!member || member.payType !== 'hourly' || member.payRateCents === null) continue;
    const entryHours = sumDurationHours([entry]);
    hours += entryHours;
    accruedCents += Math.round(member.payRateCents * entryHours);
  }

  const salariedExcludedCount = members.filter(
    (m) => m.active && m.payRateCents !== null && (m.payType === 'salary' || m.payType === 'fixed')
  ).length;

  return { accruedCents, hours: Number(hours.toFixed(2)), salariedExcludedCount };
}

function groupEntriesByMember(entries: TimeEntry[], periodStart: string, periodEnd: string): Map<string, TimeEntry[]> {
  const start = fromDateColumn(periodStart).getTime();
  const end = fromDateColumn(periodEnd).getTime() + MS_PER_DAY - 1;
  const grouped = new Map<string, TimeEntry[]>();
  for (const entry of entries) {
    const clockIn = new Date(entry.clockIn).getTime();
    if (clockIn < start || clockIn > end) continue;
    const existing = grouped.get(entry.shopMemberId);
    if (existing) existing.push(entry);
    else grouped.set(entry.shopMemberId, [entry]);
  }
  return grouped;
}
